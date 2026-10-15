import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { collectStatus } from '../src/diagnose.ts'
import { resolveManagedWebUrl } from '../src/weburl.ts'
import type { CommandResult, CommandRunner } from '../src/run.ts'
import {
  collectLogs,
  controlManagedService,
  formatLogs,
  formatServiceOutcomes,
  inspectManagedService,
  resolveTargetProfiles,
  stopManagedService,
  tailLogFile,
} from '../src/services.ts'

// Mac behavior tests use mock commands and temporary fixtures; lock interoperability
// is exercised separately with real kernel locks across CLI and lark-channel.
vi.mock('../src/launchd-lock.ts', () => ({ withLaunchdProfileLock: async (_profile: string,
  operation: () => Promise<unknown>) => operation() }))

/** 记录调用的假 runner；默认成功，可按命令前缀定制返回。 */
function recordingRunner(
  overrides: { match: (command: string, args: readonly string[]) => boolean; result: CommandResult }[] = [],
): { runner: CommandRunner; calls: string[] } {
  const calls: string[] = []
  const runner: CommandRunner = (command, args) => {
    calls.push([command, ...args].join(' '))
    for (const override of overrides) {
      if (override.match(command, args)) return override.result
    }
    return { status: 0, stdout: '', stderr: '' }
  }
  return { runner, calls }
}

const MANAGED_UNIT = `[Unit]
Description=DeepSeek Harness profile web
[Service]
ExecStart=/usr/bin/node /opt/dsh/bin/dsh.js --profile web --no-open
`

function managedPlist(home: string, dshHome = join(home, '.dsh')): string {
  return JSON.stringify({ Label: 'ai.deepseek.dsh.profile.web',
    ProgramArguments: ['/usr/bin/node', '/opt/dsh/bin/dsh.js', '--profile', 'web', '--no-open'],
    WorkingDirectory: join(dshHome, 'profiles', 'web'), EnvironmentVariables: { DSH_HOME: dshHome, PATH: '/usr/bin' },
    StandardOutPath: join(dshHome, 'logs', 'web-host.log'),
    StandardErrorPath: join(dshHome, 'logs', 'web-host.error.log'),
    LimitLoadToSessionType: 'Aqua', ProcessType: 'Background', RunAtLoad: true,
    KeepAlive: true, ThrottleInterval: 10, ExitTimeOut: 30, Umask: 63 })
}

function loadedJob(home: string, dshHome = join(home, '.dsh'), pid = 0, state = pid > 1 ? 'running' : 'waiting'): string {
  return `path = ${join(home, 'Library', 'LaunchAgents', 'ai.deepseek.dsh.profile.web.plist')}\n`
    + `state = ${state}\nworking directory = ${join(dshHome, 'profiles', 'web')}\nDSH_HOME => ${dshHome}\n`
    + `program = /usr/bin/node\narguments = {\n  /usr/bin/node\n  /opt/dsh/bin/dsh.js\n  --profile\n  web\n  --no-open\n}\npid = ${pid}\n`
}

function macRunner(_home: string, options: { print?: CommandResult[]; bootout?: CommandResult; ps?: CommandResult } = {}) {
  const print = [...(options.print ?? [{ status: 113, stdout: '', stderr: 'Could not find service' }])]
  let lastPrint: CommandResult = print.at(-1)!
  const calls: string[] = []
  const runner: CommandRunner = (command, args) => {
    calls.push([command, ...args].join(' '))
    if (command === '/usr/bin/plutil') return { status: 0, stdout: readFileSync(String(args.at(-1)), 'utf8'), stderr: '' }
    if (command === 'launchctl' && args[0] === 'print') {
      lastPrint = print.shift() ?? lastPrint
      return lastPrint
    }
    if (command === 'launchctl' && args[0] === 'bootout') return options.bootout ?? { status: 0, stdout: '', stderr: '' }
    if (command === 'ps') return options.ps ?? { status: 1, stdout: '', stderr: '' }
    return { status: 0, stdout: '', stderr: '' }
  }
  return { runner, calls }
}

describe('受管服务归属判定', () => {
  let home: string

  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'rsi-cli-ops-')) })
  afterEach(async () => { await rm(home, { recursive: true, force: true }) })

  test('Linux：受管 unit 被识别，未注册与被改写分别可区分', async () => {
    const unitDirectory = join(home, '.config', 'systemd', 'user')
    await mkdir(unitDirectory, { recursive: true })

    // 未注册：文件不存在。
    const missing = await inspectManagedService('linux', home, 'web')
    expect(missing).toMatchObject({ managed: false, foreign: false })

    // 同名但内容不属受管：必须判为 foreign，绝不当成自己的服务操作。
    await writeFile(join(unitDirectory, 'dsh-profile-web.service'), '[Service]\nExecStart=/bin/true\n')
    const foreign = await inspectManagedService('linux', home, 'web')
    expect(foreign).toMatchObject({ managed: false, foreign: true })

    // 受管 unit。
    await writeFile(join(unitDirectory, 'dsh-profile-web.service'), MANAGED_UNIT)
    const managed = await inspectManagedService('linux', home, 'web')
    expect(managed.managed).toBe(true)
    expect(managed.foreign).toBe(false)
  })

  test('macOS：按 Label 与 --profile/--no-open 参数项判定受管 plist', async () => {
    const agents = join(home, 'Library', 'LaunchAgents')
    await mkdir(agents, { recursive: true })
    const plistPath = join(agents, 'ai.deepseek.dsh.profile.web.plist')

    await writeFile(plistPath, '<plist><dict><key>Label</key><string>com.other.thing</string></dict></plist>')
    expect(await inspectManagedService('darwin', home, 'web', undefined, macRunner(home).runner)).toMatchObject({ managed: false, foreign: true })

    await writeFile(plistPath, managedPlist(home))
    expect((await inspectManagedService('darwin', home, 'web', undefined, macRunner(home).runner)).managed).toBe(true)
  })
})

describe('controlManagedService', () => {
  let home: string

  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'rsi-cli-ops-')) })
  afterEach(async () => { await rm(home, { recursive: true, force: true }) })

  async function withManagedUnit(): Promise<void> {
    const unitDirectory = join(home, '.config', 'systemd', 'user')
    await mkdir(unitDirectory, { recursive: true })
    await writeFile(join(unitDirectory, 'dsh-profile-web.service'), MANAGED_UNIT)
  }

  test('服务未注册时报错并给出指引，且不执行任何命令', async () => {
    const { runner, calls } = recordingRunner()
    const outcome = await controlManagedService('linux', home, 'web', 'restart', runner, false)
    expect(outcome.errors).toHaveLength(1)
    expect(outcome.errors[0]).toMatch(/尚未安装常驻服务/)
    expect(outcome.errors[0]).toContain('dsh-rsi install --profile web --scenario lark')
    expect(outcome.errors[0]).toContain('dsh-rsi install --profile web --scenario supervised')
    expect(outcome.errors[0]).toMatch(/core\/web 场景.*正常状态/)
    expect(outcome.errors[0]).not.toContain('dsh-rsi-setup')
    // 关键：绝不隐式注册服务，也不该调用 systemctl。
    expect(calls).toEqual([])
  })

  test('同名非受管定义被拒绝操作，且不执行任何命令', async () => {
    const unitDirectory = join(home, '.config', 'systemd', 'user')
    await mkdir(unitDirectory, { recursive: true })
    await writeFile(join(unitDirectory, 'dsh-profile-web.service'), '[Service]\nExecStart=/bin/true\n')
    const { runner, calls } = recordingRunner()
    const outcome = await controlManagedService('linux', home, 'web', 'stop', runner, false)
    expect(outcome.errors[0]).toMatch(/不是 dsh-enhanced 受管服务/)
    expect(calls).toEqual([])
  })

  test('Linux：start/stop/restart 各自派发对应的 systemctl --user 子命令', async () => {
    await withManagedUnit()
    for (const action of ['start', 'stop', 'restart'] as const) {
      const { runner, calls } = recordingRunner()
      const outcome = await controlManagedService('linux', home, 'web', action, runner, false)
      expect(outcome.errors).toEqual([])
      expect(calls).toEqual([`systemctl --user ${action} dsh-profile-web.service`])
    }
  })

  test('dry-run 只列动作，不执行任何命令', async () => {
    await withManagedUnit()
    const { runner, calls } = recordingRunner()
    const outcome = await controlManagedService('linux', home, 'web', 'restart', runner, true)
    expect(calls).toEqual([])
    expect(outcome.actions).toEqual(['systemctl --user restart dsh-profile-web.service'])
    expect(formatServiceOutcomes([outcome], 'restart', true)).toMatch(/dry-run/)
    // dry-run 只是计划：措辞必须是「将重启」，不得把未执行的动作报告成「已重启」。
    expect(outcome.messages).toEqual(['web：将重启'])
    expect(outcome.messages.join()).not.toMatch(/已重启/)
  })

  test('真正执行时措辞为「已…」，与 dry-run 的「将…」严格区分', async () => {
    await withManagedUnit()
    const { runner } = recordingRunner()
    const done = await controlManagedService('linux', home, 'web', 'start', runner, false)
    expect(done.messages).toEqual(['web：已启动'])
  })

  test('Linux：systemctl 失败时上报错误并保持非零语义', async () => {
    await withManagedUnit()
    const { runner } = recordingRunner([{
      match: command => command === 'systemctl',
      result: { status: 5, stdout: '', stderr: 'Unit not loaded.' },
    }])
    const outcome = await controlManagedService('linux', home, 'web', 'start', runner, false)
    expect(outcome.errors[0]).toMatch(/启动失败：Unit not loaded\./)
    expect(outcome.messages).toEqual([])
  })

  test('macOS：stop 用 bootout 且保留 plist；未加载时视作已停止', async () => {
    const agents = join(home, 'Library', 'LaunchAgents')
    await mkdir(agents, { recursive: true })
    await writeFile(join(agents, 'ai.deepseek.dsh.profile.web.plist'), managedPlist(home))
    const { runner, calls } = macRunner(home)
    const outcome = await controlManagedService('darwin', home, 'web', 'stop', runner, false)
    expect(outcome.errors).toEqual([])
    expect(outcome.messages[0]).toMatch(/已停止/)
    expect(outcome.messages[0]).toMatch(/plist 保留/)
    expect(calls.some(call => call.startsWith('launchctl bootout'))).toBe(false)
  })

  test('macOS：restart 先确保载入再 kickstart -k', async () => {
    const agents = join(home, 'Library', 'LaunchAgents')
    await mkdir(agents, { recursive: true })
    await writeFile(join(agents, 'ai.deepseek.dsh.profile.web.plist'), managedPlist(home))
    const { runner, calls } = macRunner(home, { print: [
      { status: 113, stdout: '', stderr: 'Could not find service' },
      { status: 0, stdout: loadedJob(home, undefined, 123), stderr: '' },
    ] })
    const outcome = await controlManagedService('darwin', home, 'web', 'restart', runner, false)
    expect(outcome.errors).toEqual([])
    expect(calls.some(call => call.startsWith('launchctl bootstrap'))).toBe(true)
    expect(calls.some(call => call.includes('kickstart -k'))).toBe(true)
  })

  test('macOS：start 与已加载服务 stop 完成后复查运行状态，保留定义', async () => {
    const path = join(home, 'Library', 'LaunchAgents', 'ai.deepseek.dsh.profile.web.plist')
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true })
    await writeFile(path, managedPlist(home))
    const absent = { status: 113, stdout: '', stderr: 'Could not find service' }
    const present = { status: 0, stdout: loadedJob(home, undefined, 321), stderr: '' }
    const started = macRunner(home, { print: [absent, present] })
    expect((await controlManagedService('darwin', home, 'web', 'start', started.runner)).errors).toEqual([])
    expect(started.calls.some(call => call.startsWith('launchctl bootstrap'))).toBe(true)
    const stopped = macRunner(home, { print: [present, absent] })
    expect((await controlManagedService('darwin', home, 'web', 'stop', stopped.runner)).errors).toEqual([])
    expect(stopped.calls.some(call => call.startsWith('launchctl bootout'))).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(managedPlist(home))
  })

  test('macOS：foreign Home plist、伪造 XML 字符串与危险执行键均拒绝且零突变', async () => {
    const path = join(home, 'Library', 'LaunchAgents', 'ai.deepseek.dsh.profile.web.plist')
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true })
    for (const body of [
      managedPlist(home, join(home, 'foreign')),
      '<plist><dict><key>Note</key><string>ai.deepseek.dsh.profile.web --profile web --no-open</string></dict></plist>',
      JSON.stringify({ ...JSON.parse(managedPlist(home)), Program: '/bin/evil' }),
    ]) {
      await writeFile(path, body)
      const { runner, calls } = macRunner(home)
      const stopped = await stopManagedService('darwin', home, 'web', runner, false)
      expect(stopped.errors).toHaveLength(1)
      expect(calls.some(call => call.startsWith('launchctl bootout'))).toBe(false)
      expect(readFileSync(path, 'utf8')).toBe(body)
    }
  })

  test('macOS：缺失 plist 仅在明确 absent 时幂等，查询失败或同名 job 存在时阻止 purge', async () => {
    for (const query of [
      { status: 5, stdout: '', stderr: 'I/O error' },
      { status: 0, stdout: loadedJob(home, undefined, 123), stderr: '' },
    ]) {
      const { runner, calls } = macRunner(home, { print: [query] })
      const result = await stopManagedService('darwin', home, 'web', runner, false)
      expect(result.errors).toHaveLength(1)
      expect(calls.some(call => call.startsWith('launchctl bootout'))).toBe(false)
    }
    const { runner } = macRunner(home)
    expect((await stopManagedService('darwin', home, 'web', runner, false)).errors).toEqual([])
  })

  test('macOS：loaded job foreign 或查询失败阻止 start/stop 和 purge', async () => {
    const path = join(home, 'Library', 'LaunchAgents', 'ai.deepseek.dsh.profile.web.plist')
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true })
    await writeFile(path, managedPlist(home))
    for (const query of [
      { status: 5, stdout: '', stderr: 'I/O error' },
      { status: 0, stdout: loadedJob(home, join(home, 'foreign'), 123), stderr: '' },
    ]) {
      const { runner, calls } = macRunner(home, { print: [query, query] })
      expect((await controlManagedService('darwin', home, 'web', 'restart', runner)).errors).toHaveLength(1)
      expect((await stopManagedService('darwin', home, 'web', runner, false)).errors).toHaveLength(1)
      expect(calls.some(call => /launchctl (bootout|bootstrap|kickstart)/u.test(call))).toBe(false)
      expect(readFileSync(path, 'utf8')).toBe(managedPlist(home))
    }
  })

  test('macOS：bootout 失败、仍加载或旧 PID 未退出时保留 plist；确认退出才删除', async () => {
    const path = join(home, 'Library', 'LaunchAgents', 'ai.deepseek.dsh.profile.web.plist')
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true })
    await writeFile(path, managedPlist(home))
    const present = { status: 0, stdout: loadedJob(home, undefined, 123), stderr: '' }
    const absent = { status: 113, stdout: '', stderr: 'Could not find service' }
    for (const options of [
      { print: [present], bootout: { status: 5, stdout: '', stderr: 'failure' } },
      { print: [present, present] },
      { print: [present, absent], ps: { status: 0, stdout: '123', stderr: '' } },
      { print: [present, absent], ps: { status: 1, stdout: '', stderr: 'permission denied' } },
    ]) {
      const { runner } = macRunner(home, options)
      expect((await stopManagedService('darwin', home, 'web', runner, false, undefined, { attempts: 2, intervalMs: 0 })).errors).toHaveLength(1)
      expect(readFileSync(path, 'utf8')).toBe(managedPlist(home))
    }
    const { runner } = macRunner(home, { print: [present, absent] })
    expect((await stopManagedService('darwin', home, 'web', runner, false)).errors).toEqual([])
    await expect((await import('node:fs/promises')).stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('macOS：停止期间 plist 归属变化时拒绝删除新文件', async () => {
    const path = join(home, 'Library', 'LaunchAgents', 'ai.deepseek.dsh.profile.web.plist')
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true })
    await writeFile(path, managedPlist(home))
    const present = { status: 0, stdout: loadedJob(home, undefined, 123), stderr: '' }
    const absent = { status: 113, stdout: '', stderr: 'Could not find service' }
    const base = macRunner(home, { print: [present, absent] })
    const foreign = managedPlist(home, join(home, 'foreign'))
    const runner: CommandRunner = (command, args) => {
      if (command === 'launchctl' && args[0] === 'bootout') writeFileSync(path, foreign)
      return base.runner(command, args)
    }
    const result = await stopManagedService('darwin', home, 'web', runner, false)
    expect(result.errors[0]).toMatch(/plist 在停止期间改变/)
    expect(readFileSync(path, 'utf8')).toBe(foreign)
  })

  test('macOS：restart 旧 PID 持续运行不报成功，延迟出现新 PID 后才成功', async () => {
    const path = join(home, 'Library', 'LaunchAgents', 'ai.deepseek.dsh.profile.web.plist')
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true })
    await writeFile(path, managedPlist(home))
    const old = { status: 0, stdout: loadedJob(home, undefined, 123), stderr: '' }
    const newer = { status: 0, stdout: loadedJob(home, undefined, 321), stderr: '' }
    const stuck = macRunner(home, { print: [old, old, old] })
    const failed = await controlManagedService('darwin', home, 'web', 'restart', stuck.runner, false,
      undefined, { attempts: 2, intervalMs: 0 })
    expect(failed.errors).toHaveLength(1)
    expect(failed.messages).toEqual([])
    const delayed = macRunner(home, { print: [old, old, newer] })
    const passed = await controlManagedService('darwin', home, 'web', 'restart', delayed.runner, false,
      undefined, { attempts: 3, intervalMs: 0 })
    expect(passed.errors).toEqual([])
    expect(passed.messages).toEqual(['web：已重启'])
  })

  test('macOS：stop 等待延迟注销，期间归属变化立即失败', async () => {
    const path = join(home, 'Library', 'LaunchAgents', 'ai.deepseek.dsh.profile.web.plist')
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true })
    await writeFile(path, managedPlist(home))
    const old = { status: 0, stdout: loadedJob(home, undefined, 123), stderr: '' }
    const absent = { status: 113, stdout: '', stderr: 'Could not find service' }
    const delayed = macRunner(home, { print: [old, old, absent] })
    expect((await controlManagedService('darwin', home, 'web', 'stop', delayed.runner, false,
      undefined, { attempts: 3, intervalMs: 0 })).errors).toEqual([])
    const foreign = { status: 0, stdout: loadedJob(home, join(home, 'foreign'), 321), stderr: '' }
    const changed = macRunner(home, { print: [old, foreign, absent] })
    const failed = await controlManagedService('darwin', home, 'web', 'stop', changed.runner, false,
      undefined, { attempts: 3, intervalMs: 0 })
    expect(failed.errors[0]).toMatch(/不一致/)
    expect(changed.calls.filter(call => call.startsWith('launchctl print'))).toHaveLength(2)
  })

  test('macOS：已注册但 pid=0 时 status 未运行，web-url 不返回旧 token', async () => {
    const path = join(home, 'Library', 'LaunchAgents', 'ai.deepseek.dsh.profile.web.plist')
    const dshHome = join(home, '.dsh')
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true })
    await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })
    await mkdir(join(dshHome, 'logs'), { recursive: true })
    await writeFile(join(dshHome, 'profiles', 'web', 'package.json'), '{}')
    await writeFile(join(dshHome, 'logs', 'web-host.log'), 'dsh web: http://127.0.0.1/?token=OLD\n')
    await writeFile(path, managedPlist(home))
    const query = { status: 0, stdout: loadedJob(home), stderr: '' }
    const { runner } = macRunner(home, { print: [query, query] })
    const status = await collectStatus(dshHome, home, 'darwin', runner)
    expect(status.profiles[0]).toMatchObject({ serviceInstalled: true, serviceActive: false })
    const url = await resolveManagedWebUrl('darwin', home, dshHome, 'web', runner)
    expect(url.url).toBeUndefined()
    expect(url.notice).toMatch(/未运行/)
  })

  test('macOS：waiting 即使仍有 PID，status/web-url 也不报告运行或旧 token', async () => {
    const path = join(home, 'Library', 'LaunchAgents', 'ai.deepseek.dsh.profile.web.plist')
    const dshHome = join(home, '.dsh')
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true })
    await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })
    await mkdir(join(dshHome, 'logs'), { recursive: true })
    await writeFile(join(dshHome, 'profiles', 'web', 'package.json'), '{}')
    await writeFile(join(dshHome, 'logs', 'web-host.log'), 'dsh web: http://127.0.0.1/?token=OLD\n')
    await writeFile(path, managedPlist(home))
    const waiting = { status: 0, stdout: loadedJob(home, dshHome, 321, 'waiting'), stderr: '' }
    const { runner } = macRunner(home, { print: [waiting, waiting] })
    const status = await collectStatus(dshHome, home, 'darwin', runner)
    expect(status.profiles[0]).toMatchObject({ serviceInstalled: true, serviceActive: false })
    const url = await resolveManagedWebUrl('darwin', home, dshHome, 'web', runner)
    expect(url.url).toBeUndefined()
    expect(url.notice).toMatch(/未运行/)
  })

  test('不支持的平台明确报错而不是静默成功', async () => {
    const { runner, calls } = recordingRunner()
    const outcome = await controlManagedService('win32', home, 'web', 'start', runner, false)
    expect(outcome.errors[0]).toMatch(/没有受管常驻服务/)
    expect(calls).toEqual([])
  })
})

describe('日志读取', () => {
  let root: string
  let dshHome: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rsi-cli-logs-'))
    dshHome = join(root, '.dsh')
    await mkdir(join(dshHome, 'logs'), { recursive: true })
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  test('只返回末尾 N 行，并报告文件总字节数', async () => {
    const path = join(dshHome, 'logs', 'web-host.log')
    await writeFile(path, Array.from({ length: 50 }, (_, index) => `line-${index + 1}`).join('\n') + '\n')
    const tail = await tailLogFile(path, 5)
    expect(tail.empty).toBe(false)
    expect(tail.lines).toEqual(['line-46', 'line-47', 'line-48', 'line-49', 'line-50'])
    expect(tail.bytes).toBeGreaterThan(0)
  })

  test('字节上限触发时丢弃开头的残行，不呈现半行内容', async () => {
    const path = join(dshHome, 'logs', 'web-host.log')
    await writeFile(path, 'AAAAAAAAAA\nBBBBBBBBBB\nCCCCCCCCCC\n')
    // 只读末 16 字节，必然从某行中间开始。
    const tail = await tailLogFile(path, 10, 16)
    expect(tail.lines.every(line => !line.startsWith('A'))).toBe(true)
    expect(tail.lines).toContain('CCCCCCCCCC')
  })

  test('文件不存在或为空时标记 empty 而非抛错', async () => {
    const missing = await tailLogFile(join(dshHome, 'logs', 'nope.log'), 10)
    expect(missing).toMatchObject({ empty: true, lines: [], bytes: 0 })
    const emptyPath = join(dshHome, 'logs', 'web-host.log')
    await writeFile(emptyPath, '')
    expect((await tailLogFile(emptyPath, 10)).empty).toBe(true)
  })

  test('errorsOnly 只收 *-host.error.log', async () => {
    await writeFile(join(dshHome, 'logs', 'web-host.log'), 'out\n')
    await writeFile(join(dshHome, 'logs', 'web-host.error.log'), 'err\n')
    const both = await collectLogs(dshHome, ['web'], 10, false)
    expect(both[0]!.tails).toHaveLength(2)
    const errorsOnly = await collectLogs(dshHome, ['web'], 10, true)
    expect(errorsOnly[0]!.tails).toHaveLength(1)
    expect(errorsOnly[0]!.tails[0]!.path).toMatch(/error\.log$/)
    const rendered = formatLogs(errorsOnly, 10)
    expect(rendered).toContain('err')
    expect(rendered).not.toContain('out')
  })

  test('无 profile 时给出可读提示', () => {
    expect(formatLogs([], 10)).toMatch(/未找到任何 profile/)
  })
})

describe('resolveTargetProfiles', () => {
  test('显式 profile 优先；否则枚举 DSH home 下全部 profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rsi-cli-targets-'))
    try {
      const dshHome = join(root, '.dsh')
      await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })
      await mkdir(join(dshHome, 'profiles', 'personal-web'), { recursive: true })
      await writeFile(join(dshHome, 'profiles', 'web', 'package.json'), JSON.stringify({
        name: 'dsh-profile-web', private: true,
      }))
      await writeFile(join(dshHome, 'profiles', 'personal-web', 'package.json'), JSON.stringify({
        name: 'dsh-profile-personal-web', private: true,
      }))
      expect(await resolveTargetProfiles(dshHome, 'web')).toEqual(['web'])
      expect(await resolveTargetProfiles(dshHome)).toEqual(['personal-web', 'web'])
      // profiles/ 不存在时返回空数组，由 CLI 决定提示与退出码。
      expect(await resolveTargetProfiles(join(root, 'absent'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
