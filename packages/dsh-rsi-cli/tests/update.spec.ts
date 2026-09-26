import { describe, expect, test, vi } from 'vitest'
import { PurgeError } from '../src/purge.ts'
import type { CommandResult, CommandRunner } from '../src/run.ts'
import {
  formatSelfUpdateReport,
  prefixFromPackageRoot,
  runtimePackageKind,
  RSI_CLI_PACKAGE,
  LEGACY_RSI_CLI_PACKAGE,
  runSelfUpdate,
} from '../src/update.ts'
import { main, type MainDeps } from '../src/index.ts'
import { version as VERSION } from '../src/version.ts'

const NEW_GLOBAL = '/Users/test/.npm-global/lib/node_modules/@dsh-enhanced/dsh-rsi-cli'
const LEGACY_GLOBAL = '/Users/test/.npm-global/lib/node_modules/@dsh-enhanced/rsi-cli'

/** 记录调用的假 runner；按需为 npm 子命令定制返回，uninstall 可单独控制。 */
function npmRunner(options: {
  prefix?: string
  viewVersion?: string | null
  installStatus?: number
  installStderr?: string
  uninstallStatus?: number
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
    if (args[0] === 'uninstall') {
      return { status: options.uninstallStatus ?? 0, stdout: '', stderr: '' }
    }
    return empty
  }
  return { runner, calls }
}

describe('runSelfUpdate / 包改名迁移', () => {
  test('prefixFromPackageRoot 同时识别新旧两种全局路径后缀', () => {
    // 新包路径
    expect(prefixFromPackageRoot(NEW_GLOBAL)).toBe('/Users/test/.npm-global')
    // 旧包路径（迁移期仍能反推 prefix）
    expect(prefixFromPackageRoot(LEGACY_GLOBAL)).toBe('/Users/test/.npm-global')
    // 源码 checkout 不是全局安装 → undefined
    expect(prefixFromPackageRoot('/checkout/packages/dsh-rsi-cli')).toBeUndefined()
    expect(prefixFromPackageRoot('/checkout/packages/rsi-cli')).toBeUndefined()
  })

  test('runtimePackageKind 区分 new / legacy / unknown', () => {
    expect(runtimePackageKind(NEW_GLOBAL)).toBe('new')
    expect(runtimePackageKind(LEGACY_GLOBAL)).toBe('legacy')
    expect(runtimePackageKind('/checkout/packages/dsh-rsi-cli')).toBe('unknown')
  })

  test('新包 fresh install：只装新包，不卸载任何东西，bin 仍为 dsh-rsi', async () => {
    const { runner, calls } = npmRunner({ prefix: '/opt/npm', viewVersion: '9.9.9' })
    const report = await runSelfUpdate({ runner, packageRoot: NEW_GLOBAL })
    // packageRoot 是已知全局包路径 → 从路径反推 prefix，而非调用 npm prefix -g
    expect(report.globalPrefix).toBe('/Users/test/.npm-global')
    expect(report.migratedFrom).toBe(false)
    expect(calls).toContain(`npm install --global --prefix /Users/test/.npm-global ${RSI_CLI_PACKAGE}@latest --location=global`)
    expect(calls.some(c => c.includes('uninstall'))).toBe(false)
  })

  test('旧包 update：先装新包、确认成功后才卸载旧包（bin 不冲突）', async () => {
    const { runner, calls } = npmRunner({ prefix: '/opt/npm', viewVersion: '9.9.9' })
    const report = await runSelfUpdate({ runner, packageRoot: LEGACY_GLOBAL })
    expect(report.migratedFrom).toBe(true)
    const installIdx = calls.findIndex(c => c.startsWith(`npm install --global --prefix /Users/test/.npm-global ${RSI_CLI_PACKAGE}@`))
    const uninstallIdx = calls.findIndex(c => c.startsWith(`npm uninstall --global --prefix /Users/test/.npm-global ${LEGACY_RSI_CLI_PACKAGE}`))
    expect(installIdx).toBeGreaterThanOrEqual(0)
    expect(uninstallIdx).toBeGreaterThan(installIdx)
    const rendered = formatSelfUpdateReport(report, false)
    expect(rendered).toMatch(new RegExp(`包名迁移：${LEGACY_RSI_CLI_PACKAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  })

  test('重复 update 幂等：已是新包且版本一致时不重复迁移/安装', async () => {
    const { runner, calls } = npmRunner({ viewVersion: VERSION })
    const report = await runSelfUpdate({ runner, packageRoot: NEW_GLOBAL })
    expect(report.alreadyCurrent).toBe(true)
    expect(report.migratedFrom).toBe(false)
    expect(calls.some(c => c.includes('install'))).toBe(false)
    expect(calls.some(c => c.includes('uninstall'))).toBe(false)
  })

  test('旧包即使版本号相同也必须迁移一次（不视为 alreadyCurrent）', async () => {
    const { runner, calls } = npmRunner({ viewVersion: VERSION })
    const report = await runSelfUpdate({ runner, packageRoot: LEGACY_GLOBAL })
    expect(report.alreadyCurrent).toBe(false)
    expect(report.migratedFrom).toBe(true)
    expect(calls.some(c => c.includes('install'))).toBe(true)
    expect(calls.some(c => c.includes('uninstall'))).toBe(true)
  })

  test('新包安装失败时保留旧包，绝不卸载旧包', async () => {
    const { runner, calls } = npmRunner({ viewVersion: '9.9.9', installStatus: 1, installStderr: 'EACCES' })
    await expect(runSelfUpdate({ runner, packageRoot: LEGACY_GLOBAL })).rejects.toThrow(/EACCES/)
    // 安装失败 → 抛错，uninstall 不应被调用
    expect(calls.some(c => c.startsWith('npm uninstall'))).toBe(false)
  })

  test('dry-run 只列动作：旧包迁移会列出 install 新包 + uninstall 旧包', async () => {
    const { runner, calls } = npmRunner({ viewVersion: '9.9.9' })
    const report = await runSelfUpdate({ runner, packageRoot: LEGACY_GLOBAL, dryRun: true })
    expect(report.migratedFrom).toBe(true)
    expect(calls.some(c => c.includes('install'))).toBe(false)
    expect(report.actions).toContainEqual(expect.stringContaining(RSI_CLI_PACKAGE))
    expect(report.actions).toContainEqual(expect.stringContaining(LEGACY_RSI_CLI_PACKAGE))
  })

  test('registry 无法解析版本时仍按 selector 安装新包', async () => {
    const { runner, calls } = npmRunner({ viewVersion: null })
    const report = await runSelfUpdate({ runner, packageRoot: NEW_GLOBAL })
    expect(report.resolvedVersion).toBeUndefined()
    expect(report.alreadyCurrent).toBe(false)
    expect(calls).toContain(`npm install --global --prefix /Users/test/.npm-global ${RSI_CLI_PACKAGE}@latest --location=global`)
  })

  test('接受精确版本与 dist-tag，拒绝非法 selector', async () => {
    const { runner } = npmRunner({ viewVersion: '0.1.38' })
    await expect(runSelfUpdate({ runner, selector: '0.1.38', dryRun: true, packageRoot: NEW_GLOBAL }))
      .resolves.toMatchObject({ selector: '0.1.38' })
    for (const bad of ['>=0.1.0', '0.1', 'a b', '../evil', '1.2.3 && rm -rf /']) {
      await expect(runSelfUpdate({ runner, selector: bad })).rejects.toThrow(PurgeError)
    }
  })

  test('npm install 失败时抛出含手工补救命令的错误', async () => {
    const { runner } = npmRunner({ viewVersion: '9.9.9', installStatus: 1, installStderr: 'EACCES' })
    await expect(runSelfUpdate({ runner, packageRoot: NEW_GLOBAL })).rejects.toThrow(/EACCES/)
    await expect(runSelfUpdate({ runner, packageRoot: NEW_GLOBAL })).rejects.toThrow(/npm install --global/)
  })
})

describe('main：update 命令派发', () => {
  type InstallFn = NonNullable<MainDeps['install']>
  type SelfUpdateFn = NonNullable<MainDeps['selfUpdate']>

  function makeSelfUpdate() {
    return vi.fn<SelfUpdateFn>(async () => ({
      fromVersion: VERSION,
      selector: 'latest',
      resolvedVersion: VERSION,
      installedVersion: VERSION,
      alreadyCurrent: false,
      migratedFrom: false,
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
      expect(selfUpdate).toHaveBeenCalledTimes(1)
      expect(install).toHaveBeenCalledTimes(1)
      const passed = install.mock.calls[0]![0] as { passthrough: readonly string[] }
      expect(passed.passthrough).toContain('--operation')
      expect(passed.passthrough).toContain('upgrade')
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
