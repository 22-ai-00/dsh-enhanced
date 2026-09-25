import { describe, expect, test, vi } from 'vitest'
import { PurgeError } from '../src/purge.ts'
import type { CommandResult, CommandRunner } from '../src/run.ts'
import { formatSelfUpdateReport, prefixFromPackageRoot, RSI_CLI_PACKAGE, runSelfUpdate } from '../src/update.ts'
import { main, type MainDeps } from '../src/index.ts'
import { version as VERSION } from '../src/version.ts'

/** 记录调用的假 runner；按需为 npm 子命令定制返回。 */
function npmRunner(options: {
  prefix?: string
  viewVersion?: string | null
  installStatus?: number
  installStderr?: string
} = {}): { runner: CommandRunner; calls: string[] } {
  const calls: string[] = []
  const runner: CommandRunner = (command, args) => {
    calls.push([command, ...args].join(' '))
    const empty: CommandResult = { status: 0, stdout: '', stderr: '' }
    if (command !== 'npm') return empty
    if (args[0] === 'prefix') {
      return { status: 0, stdout: `${options.prefix ?? '/usr/local'}\n`, stderr: '' }
    }
    if (args[0] === 'view') {
      if (options.viewVersion === null) return { status: 1, stdout: '', stderr: 'E404' }
      return { status: 0, stdout: `${options.viewVersion ?? '9.9.9'}\n`, stderr: '' }
    }
    if (args[0] === 'install') {
      const status = options.installStatus ?? 0
      return { status, stdout: '', stderr: options.installStderr ?? '' }
    }
    return empty
  }
  return { runner, calls }
}

describe('runSelfUpdate', () => {
  test('从当前全局包路径反推真实 npm prefix', () => {
    expect(prefixFromPackageRoot('/Users/test/.npm-global/lib/node_modules/@dsh-enhanced/rsi-cli'))
      .toBe('/Users/test/.npm-global')
    expect(prefixFromPackageRoot('/checkout/packages/rsi-cli')).toBeUndefined()
  })

  test('固定写回当前包所属 prefix，不受当前 npm 配置漂移影响', async () => {
    const { runner, calls } = npmRunner({ prefix: '/wrong-prefix', viewVersion: '9.9.9' })
    const report = await runSelfUpdate({
      runner,
      packageRoot: '/Users/test/.npm-global/lib/node_modules/@dsh-enhanced/rsi-cli',
    })
    expect(report.globalPrefix).toBe('/Users/test/.npm-global')
    expect(calls).not.toContain('npm prefix -g')
    expect(calls).toContain(
      `npm install --global --prefix /Users/test/.npm-global ${RSI_CLI_PACKAGE}@latest --location=global`,
    )
    expect(report.installedVersion).toBe('9.9.9')
  })
  test('默认 selector 为 latest，执行全局安装并报告前缀与目标版本', async () => {
    const { runner, calls } = npmRunner({ prefix: '/opt/npm', viewVersion: '9.9.9' })
    const report = await runSelfUpdate({ runner })
    expect(report.fromVersion).toBe(VERSION)
    expect(report.selector).toBe('latest')
    expect(report.globalPrefix).toBe('/opt/npm')
    expect(report.resolvedVersion).toBe('9.9.9')
    expect(calls).toContain(
      `npm install --global --prefix /opt/npm ${RSI_CLI_PACKAGE}@latest --location=global`,
    )
  })

  test('已是目标版本时跳过安装，不执行 npm install', async () => {
    const { runner, calls } = npmRunner({ viewVersion: VERSION })
    const report = await runSelfUpdate({ runner })
    expect(report.alreadyCurrent).toBe(true)
    expect(calls.some(call => call.includes('install'))).toBe(false)
    expect(formatSelfUpdateReport(report, false)).toMatch(/无需升级/)
  })

  test('dry-run 只列动作，不执行安装，且措辞为「将升级」', async () => {
    const { runner, calls } = npmRunner({ viewVersion: '9.9.9' })
    const report = await runSelfUpdate({ runner, dryRun: true })
    expect(calls.some(call => call.includes('install'))).toBe(false)
    expect(report.actions).toEqual([
      `npm install --global --prefix /usr/local ${RSI_CLI_PACKAGE}@latest`,
    ])
    const rendered = formatSelfUpdateReport(report, true)
    expect(rendered).toMatch(/dry-run/)
    expect(rendered).toMatch(/将升级/)
    expect(rendered).not.toMatch(/已升级/)
  })

  test('registry 无法解析版本时仍按 selector 安装，不误判为已最新', async () => {
    const { runner, calls } = npmRunner({ viewVersion: null })
    const report = await runSelfUpdate({ runner })
    expect(report.resolvedVersion).toBeUndefined()
    expect(report.alreadyCurrent).toBe(false)
    expect(calls).toContain(
      `npm install --global --prefix /usr/local ${RSI_CLI_PACKAGE}@latest --location=global`,
    )
  })

  test('接受精确版本与 dist-tag，拒绝非法 selector', async () => {
    const { runner } = npmRunner({ viewVersion: '0.1.38' })
    await expect(runSelfUpdate({ runner, selector: '0.1.38', dryRun: true })).resolves.toMatchObject({
      selector: '0.1.38',
    })
    await expect(runSelfUpdate({ runner, selector: 'next', dryRun: true })).resolves.toMatchObject({
      selector: 'next',
    })
    for (const bad of ['>=0.1.0', '0.1', 'a b', '../evil', '1.2.3 && rm -rf /']) {
      await expect(runSelfUpdate({ runner, selector: bad })).rejects.toThrow(PurgeError)
    }
  })

  test('npm install 失败时抛出含手工补救命令的错误', async () => {
    const { runner } = npmRunner({ viewVersion: '9.9.9', installStatus: 1, installStderr: 'EACCES' })
    await expect(runSelfUpdate({ runner })).rejects.toThrow(/EACCES/)
    await expect(runSelfUpdate({ runner })).rejects.toThrow(/npm install --global/)
  })

  test('真正执行时明确提示新版本下次生效（当前进程仍是旧代码）', async () => {
    const { runner } = npmRunner({ viewVersion: '9.9.9' })
    const report = await runSelfUpdate({ runner })
    expect(formatSelfUpdateReport(report, false)).toMatch(/下一次执行 dsh-rsi 时生效/)
  })
})

describe('main：update 命令派发', () => {
  type InstallFn = NonNullable<MainDeps['install']>
  type SelfUpdateFn = NonNullable<MainDeps['selfUpdate']>

  /** 注入假 selfUpdate，使派发测试完全不接触 npm registry。 */
  function makeSelfUpdate() {
    return vi.fn<SelfUpdateFn>(async () => ({
      fromVersion: VERSION,
      selector: 'latest',
      resolvedVersion: VERSION,
      installedVersion: VERSION,
      alreadyCurrent: false,
      actions: [],
    }))
  }

  function makeInstall(code = 0) {
    return vi.fn<InstallFn>(async () => code)
  }

  const noRunning = () => ({ active: [] })

  test('不带 --all 时只升级自身，绝不调用安装器', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const install = makeInstall()
    const selfUpdate = makeSelfUpdate()
    try {
      const code = await main(['update'], { HOME: '/h' }, { install, selfUpdate, findRunning: noRunning })
      expect(code).toBe(0)
      expect(selfUpdate).toHaveBeenCalledTimes(1)
      expect(install).not.toHaveBeenCalled()
    } finally { write.mockRestore() }
  })

  test('--all 在自身升级后把 --operation upgrade 交给安装器', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const install = makeInstall()
    const selfUpdate = makeSelfUpdate()
    try {
      const code = await main(['update', '--all'], { HOME: '/h' }, { install, selfUpdate, findRunning: noRunning })
      expect(code).toBe(0)
      // 顺序是刻意的：先升级自身，再交给安装器升级 cohort。
      expect(selfUpdate).toHaveBeenCalledTimes(1)
      expect(install).toHaveBeenCalledTimes(1)
      const passed = install.mock.calls[0]![0] as { passthrough: readonly string[] }
      expect(passed.passthrough).toContain('--operation')
      expect(passed.passthrough).toContain('upgrade')
    } finally { write.mockRestore() }
  })

  test('--all 在自身升级后自动确认静止、使用目标版本安装器且不要求场景参数', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const install = makeInstall()
    const selfUpdate = vi.fn<SelfUpdateFn>(async () => ({
      fromVersion: VERSION,
      selector: 'latest',
      resolvedVersion: '9.9.9',
      installedVersion: '9.9.9',
      alreadyCurrent: false,
      actions: [],
    }))
    const findRunning = vi.fn(() => ({ active: [] }))
    try {
      const code = await main(['update', '--all'], { HOME: '/h' }, { install, selfUpdate, findRunning })
      expect(code).toBe(0)
      expect(findRunning).toHaveBeenCalledTimes(1)
      expect(install).toHaveBeenCalledTimes(1)
      const passed = install.mock.calls[0]![0] as {
        releaseRef: string
        passthrough: readonly string[]
      }
      expect(passed.releaseRef).toBe('v9.9.9')
      expect(passed.passthrough).toContain('--operation')
      expect(passed.passthrough).toContain('upgrade')
      expect(passed.passthrough).toContain('--confirm-dsh-home-stopped')
      expect(passed.passthrough).not.toContain('--scenario')
    } finally { write.mockRestore() }
  })

  test('--all 允许精确受管 MainPID 并交给 service-aware installer 接管', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const install = makeInstall()
    const selfUpdate = makeSelfUpdate()
    const findRunning = vi.fn(() => ({
      active: [{ pid: 123, commandLine: 'dsh --profile web' }],
    }))
    const managedServicePids = vi.fn(async () => ({ pids: [123], errors: [] }))
    try {
      expect(await main(['update', '--all', '--profile', 'web'], { HOME: '/h' }, {
        install, selfUpdate, findRunning, managedServicePids,
      })).toBe(0)
      expect(install).toHaveBeenCalledOnce()
      expect(write).toHaveBeenCalledWith(expect.stringMatching(/生命周期事务将安全停服/))
    } finally { write.mockRestore() }
  })

  test('--all 即使存在受管 MainPID，也拒绝额外的手工 Host', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const install = makeInstall()
    const selfUpdate = makeSelfUpdate()
    const findRunning = vi.fn(() => ({
      active: [
        { pid: 123, commandLine: 'dsh --profile web' },
        { pid: 456, commandLine: 'dsh --profile web --port 0' },
      ],
    }))
    const managedServicePids = vi.fn(async () => ({ pids: [123], errors: [] }))
    try {
      expect(await main(['update', '--all', '--profile', 'web'], { HOME: '/h' }, {
        install, selfUpdate, findRunning, managedServicePids,
      })).toBe(1)
      expect(install).not.toHaveBeenCalled()
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/PID 456/))
      expect(error).not.toHaveBeenCalledWith(expect.stringMatching(/PID 123/))
    } finally { write.mockRestore(); error.mockRestore() }
  })

  test('--all 检测到运行中 Host 时停止，不调用安装器', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const install = makeInstall()
    const selfUpdate = makeSelfUpdate()
    const findRunning = vi.fn(() => ({
      active: [{ pid: 123, commandLine: 'dsh --profile web' }],
    }))
    try {
      expect(await main(['update', '--all'], { HOME: '/h' }, {
        install, selfUpdate, findRunning,
      })).toBe(1)
      expect(install).not.toHaveBeenCalled()
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/PID 123/))
    } finally { write.mockRestore(); error.mockRestore() }
  })
  test('--version 透传给自身升级，且不泄漏给安装器', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const install = makeInstall()
    const selfUpdate = makeSelfUpdate()
    try {
      await main(['update', '--all', '--version', '0.1.38'], { HOME: '/h' }, { install, selfUpdate, findRunning: noRunning })
      expect(selfUpdate.mock.calls[0]![0]).toMatchObject({ selector: '0.1.38' })
      const passed = install.mock.calls[0]![0] as { passthrough: readonly string[] }
      expect(passed.passthrough).not.toContain('--version')
      expect(passed.passthrough).not.toContain('0.1.38')
    } finally { write.mockRestore() }
  })

  test('自身升级失败时不继续升级插件集合', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const install = makeInstall()
    const selfUpdate = vi.fn<SelfUpdateFn>(async () => { throw new PurgeError('npm 失败') })
    try {
      expect(await main(['update', '--all'], { HOME: '/h' }, { install, selfUpdate, findRunning: noRunning })).toBe(1)
      expect(install).not.toHaveBeenCalled()
    } finally { write.mockRestore(); error.mockRestore() }
  })

  test('--all 时安装器退出码原样透传', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const install = makeInstall(7)
    const selfUpdate = makeSelfUpdate()
    try {
      expect(await main(['update', '--all'], { HOME: '/h' }, { install, selfUpdate, findRunning: noRunning })).toBe(7)
    } finally { write.mockRestore() }
  })
})
