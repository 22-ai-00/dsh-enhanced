import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { CommandResult, CommandRunner } from '../src/run.ts'
import {
  collectLogs,
  controlManagedService,
  formatLogs,
  formatServiceOutcomes,
  inspectManagedService,
  resolveTargetProfiles,
  tailLogFile,
} from '../src/services.ts'

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

const MANAGED_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.deepseek.dsh.profile.web</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/node</string>
    <string>/opt/dsh/bin/dsh.js</string>
    <string>--profile</string>
    <string>web</string>
    <string>--no-open</string>
  </array>
</dict>
</plist>
`

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
    expect(await inspectManagedService('darwin', home, 'web')).toMatchObject({ managed: false, foreign: true })

    await writeFile(plistPath, MANAGED_PLIST)
    expect((await inspectManagedService('darwin', home, 'web')).managed).toBe(true)
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
    await writeFile(join(agents, 'ai.deepseek.dsh.profile.web.plist'), MANAGED_PLIST)
    const { runner, calls } = recordingRunner([{
      match: (command, args) => command === 'launchctl' && args[0] === 'bootout',
      result: { status: 3, stdout: '', stderr: 'No such process' },
    }])
    const outcome = await controlManagedService('darwin', home, 'web', 'stop', runner, false)
    expect(outcome.errors).toEqual([])
    expect(outcome.messages[0]).toMatch(/已停止/)
    expect(outcome.messages[0]).toMatch(/plist 保留/)
    expect(calls.some(call => call.startsWith('launchctl bootout'))).toBe(true)
  })

  test('macOS：restart 先确保载入再 kickstart -k', async () => {
    const agents = join(home, 'Library', 'LaunchAgents')
    await mkdir(agents, { recursive: true })
    await writeFile(join(agents, 'ai.deepseek.dsh.profile.web.plist'), MANAGED_PLIST)
    const { runner, calls } = recordingRunner()
    const outcome = await controlManagedService('darwin', home, 'web', 'restart', runner, false)
    expect(outcome.errors).toEqual([])
    expect(calls.some(call => call.startsWith('launchctl bootstrap'))).toBe(true)
    expect(calls.some(call => call.includes('kickstart -k'))).toBe(true)
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
