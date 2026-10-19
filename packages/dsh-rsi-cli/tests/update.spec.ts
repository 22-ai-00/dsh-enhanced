import { describe, expect, test, vi } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
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
    expect(calls).toContain(`npm install --global --prefix /Users/test/.npm-global ${RSI_CLI_PACKAGE}@9.9.9 --location=global`)
    expect(calls.some(c => c.includes('uninstall'))).toBe(false)
  })

  test('旧包 update：先装新包、确认成功后才卸载旧包（bin 不冲突）', async () => {
    const { runner, calls } = npmRunner({ prefix: '/opt/npm', viewVersion: '9.9.9' })
    const report = await runSelfUpdate({ runner, packageRoot: LEGACY_GLOBAL })
    expect(report.migratedFrom).toBe(true)
    const installIdx = calls.findIndex(c => c.startsWith(`npm install --global --prefix /Users/test/.npm-global ${RSI_CLI_PACKAGE}@9.9.9`))
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

  test('official global CLI newer than npm latest is retained without npm mutation', async () => {
    const { runner, calls } = npmRunner({ viewVersion: '0.1.54' })
    const report = await runSelfUpdate({ runner, packageRoot: NEW_GLOBAL })
    expect(report).toMatchObject({ alreadyCurrent: true, retainedNewer: true,
      resolvedVersion: '0.1.54', installedVersion: VERSION })
    expect(calls.some(call => call.startsWith('npm install') || call.startsWith('npm uninstall'))).toBe(false)
    expect(formatSelfUpdateReport(report, false)).toContain('保留本机版本，未安装旧版')
  })

  test('latest older than nonofficial runtime fails closed before install', async () => {
    for (const packageRoot of [LEGACY_GLOBAL, '/checkout/packages/dsh-rsi-cli']) {
      const { runner, calls } = npmRunner({ viewVersion: '0.1.54' })
      await expect(runSelfUpdate({ runner, packageRoot })).rejects.toThrow(/早于当前 CLI/)
      expect(calls.some(call => call.startsWith('npm install') || call.startsWith('npm uninstall'))).toBe(false)
    }
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

  test('registry 无法解析 latest 时不安装未知版本', async () => {
    const { runner, calls } = npmRunner({ viewVersion: null })
    await expect(runSelfUpdate({ runner, packageRoot: NEW_GLOBAL })).rejects.toThrow(/无法确认 npm latest/)
    expect(calls.some(call => call.startsWith('npm install'))).toBe(false)
  })

  test('explicit older CLI version remains available outside frozen --all', async () => {
    const { runner, calls } = npmRunner({ viewVersion: '0.1.54' })
    const report = await runSelfUpdate({ runner, packageRoot: NEW_GLOBAL, selector: '0.1.54' })
    expect(report.installedVersion).toBe('0.1.54')
    expect(calls).toContain(`npm install --global --prefix /Users/test/.npm-global ${RSI_CLI_PACKAGE}@0.1.54 --location=global`)
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
  const noFrozenOwner = async () => undefined

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
      const code = await main(['update', '--all'], { HOME: '/h' }, {
        platform: 'linux', install, selfUpdate, findRunning: noRunning, detectFrozenOwner: noFrozenOwner,
      })
      expect(code).toBe(0)
      expect(selfUpdate).toHaveBeenCalledTimes(1)
      expect(install).toHaveBeenCalledTimes(1)
      const passed = install.mock.calls[0]![0] as { passthrough: readonly string[] }
      expect(passed.passthrough).toContain('--operation')
      expect(passed.passthrough).toContain('upgrade')
    } finally { write.mockRestore() }
  })

  test('Mac --all requires an explicit stopped Home confirmation before self-update', async () => {
    const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const install = makeInstall(), selfUpdate = makeSelfUpdate()
    try {
      expect(await main(['update', '--all'], { HOME: '/h' }, {
        platform: 'darwin', install, selfUpdate, findRunning: noRunning,
      })).toBe(1)
      expect(selfUpdate).not.toHaveBeenCalled()
      expect(install).not.toHaveBeenCalled()
    } finally { error.mockRestore() }
  })

  test('Mac --all refuses frozen owner resources and any running managed Host before self-update', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rsi-mac-upgrade-'))
    const dshHome = join(root, '.dsh')
    const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const install = makeInstall(), selfUpdate = makeSelfUpdate()
    try {
      await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })
      await mkdir(join(dshHome, 'rsi-authorities', 'web'), { recursive: true })
      const argv = ['update', '--all', '--confirm-dsh-home-stopped']
      const deps = { platform: 'darwin' as const, install, selfUpdate,
        findRunning: () => ({ active: [{ pid: 4321, commandLine: 'dsh --profile web' }] }),
        macHostProcessesStopped: async () => {} }
      expect(await main(argv, { HOME: root, DSH_HOME: dshHome }, deps)).toBe(1)
      await rm(join(dshHome, 'rsi-authorities'), { recursive: true })
      expect(await main(argv, { HOME: root, DSH_HOME: dshHome }, deps)).toBe(1)
      expect(selfUpdate).not.toHaveBeenCalled()
      expect(install).not.toHaveBeenCalled()
    } finally { error.mockRestore(); await rm(root, { recursive: true, force: true }) }
  })

  test('Mac --all rejects a partial native runtime marker and a symlink profile before self-update', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rsi-mac-upgrade-'))
    const dshHome = join(root, '.dsh')
    const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const install = makeInstall(), selfUpdate = makeSelfUpdate()
    const argv = ['update', '--all', '--confirm-dsh-home-stopped']
    const deps = { platform: 'darwin' as const, install, selfUpdate, findRunning: noRunning,
      macHostProcessesStopped: async () => {} }
    try {
      await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })
      await mkdir(join(dshHome, 'rsi-native-runtimes'), { recursive: true })
      expect(await main(argv, { HOME: root, DSH_HOME: dshHome }, deps)).toBe(1)
      await rm(join(dshHome, 'rsi-native-runtimes'), { recursive: true })
      await symlink(join(dshHome, 'profiles', 'web'), join(dshHome, 'profiles', 'other'))
      expect(await main(argv, { HOME: root, DSH_HOME: dshHome }, deps)).toBe(1)
      expect(selfUpdate).not.toHaveBeenCalled()
      expect(install).not.toHaveBeenCalled()
    } finally { error.mockRestore(); await rm(root, { recursive: true, force: true }) }
  })

  test('Mac --all rejects managed PID and unknown service state that pgrep missed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rsi-mac-upgrade-'))
    const dshHome = join(root, '.dsh')
    const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const install = makeInstall(), selfUpdate = makeSelfUpdate()
    try {
      await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })
      const common = { platform: 'darwin' as const, install, selfUpdate, findRunning: noRunning,
        macHostProcessesStopped: async () => {} }
      const argv = ['update', '--all', '--confirm-dsh-home-stopped']
      expect(await main(argv, { HOME: root, DSH_HOME: dshHome }, {
        ...common, managedServicePids: async () => ({ pids: [4321], errors: [] }),
      })).toBe(1)
      expect(await main(argv, { HOME: root, DSH_HOME: dshHome }, {
        ...common, managedServicePids: async () => ({ pids: [], errors: ['launchd unknown'] }),
      })).toBe(1)
      expect(selfUpdate).not.toHaveBeenCalled()
      expect(install).not.toHaveBeenCalled()
    } finally { error.mockRestore(); await rm(root, { recursive: true, force: true }) }
  })

  test('Mac --all refuses an unlisted real DSH bin.js Host before self-update', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rsi-mac-upgrade-'))
    const dshHome = join(root, '.dsh')
    const script = join(root, 'foreign', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const install = makeInstall(), selfUpdate = makeSelfUpdate()
    await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })
    await mkdir(dirname(script), { recursive: true })
    await writeFile(script, "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)\n")
    const host = spawn(process.execPath, [script, '--profile=orphan', '--no-open'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        const timer = setTimeout(() => rejectReady(new Error('host readiness timeout')), 3000)
        host.stdout.once('data', () => { clearTimeout(timer); resolveReady() })
        host.once('error', failure => { clearTimeout(timer); rejectReady(failure) })
        host.once('close', () => { clearTimeout(timer); rejectReady(new Error('host exited before ready')) })
      })
      expect(await main(['update', '--all', '--confirm-dsh-home-stopped'], { HOME: root, DSH_HOME: dshHome }, {
        platform: 'darwin', install, selfUpdate, findRunning: noRunning,
        managedServicePids: async () => ({ pids: [], errors: [] }),
      })).toBe(1)
      expect(selfUpdate).not.toHaveBeenCalled()
      expect(install).not.toHaveBeenCalled()
    } finally {
      if (host.exitCode === null && host.signalCode === null) {
        await new Promise<void>((resolveClose, rejectClose) => {
          const force = setTimeout(() => host.kill('SIGKILL'), 1000)
          const timeout = setTimeout(() => rejectClose(new Error('host did not close after SIGKILL')), 3000)
          host.once('close', () => { clearTimeout(force); clearTimeout(timeout); resolveClose() })
          host.kill('SIGTERM')
        })
      }
      error.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('Mac --all forwards explicit stopped confirmation for an ordinary Home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rsi-mac-upgrade-'))
    const dshHome = join(root, '.dsh')
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const install = makeInstall(), selfUpdate = makeSelfUpdate()
    try {
      await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })
      expect(await main(['update', '--all', '--confirm-dsh-home-stopped'], { HOME: root, DSH_HOME: dshHome }, {
        platform: 'darwin', install, selfUpdate, findRunning: noRunning,
        macHostProcessesStopped: async () => {},
      })).toBe(0)
      expect(selfUpdate).toHaveBeenCalledTimes(1)
      expect(install).toHaveBeenCalledTimes(1)
      expect(install.mock.calls[0]![0].passthrough).toContain('--confirm-dsh-home-stopped')
    } finally { write.mockRestore(); await rm(root, { recursive: true, force: true }) }
  })

  test('自身升级失败时不继续升级插件集合', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const install = makeInstall()
    const selfUpdate = vi.fn<SelfUpdateFn>(async () => { throw new PurgeError('npm 失败') })
    try {
      expect(await main(['update', '--all'], { HOME: '/h' }, {
        platform: 'linux', install, selfUpdate, findRunning: noRunning, detectFrozenOwner: noFrozenOwner,
      })).toBe(1)
      expect(selfUpdate).toHaveBeenCalledTimes(1)
      expect(install).not.toHaveBeenCalled()
    } finally { write.mockRestore(); error.mockRestore() }
  })

  test('--all 时安装器退出码原样透传', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const install = makeInstall(7)
    const selfUpdate = makeSelfUpdate()
    try {
      expect(await main(['update', '--all'], { HOME: '/h' }, {
        platform: 'linux', install, selfUpdate, findRunning: noRunning, detectFrozenOwner: noFrozenOwner,
      })).toBe(7)
    } finally { write.mockRestore() }
  })
})
