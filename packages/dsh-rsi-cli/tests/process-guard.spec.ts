import { describe, expect, test } from 'vitest'
import type { CommandResult, CommandRunner } from '../src/run.ts'
import { scanRunningProfiles, terminatePids } from '../src/process-guard.ts'

/** 构造按 pid 返回命令行的假 runner。 */
function psRunner(pidToCmd: Record<number, string>): { runner: CommandRunner; calls: string[] } {
  const calls: string[] = []
  const runner: CommandRunner = (command, args) => {
    calls.push([command, ...args].join(' '))
    if (command === 'pgrep') return { status: 0, stdout: Object.keys(pidToCmd).join('\n') + '\n', stderr: '' }
    if (command === 'ps') {
      const pid = Number(args[1])
      const cmd = pidToCmd[pid]
      return cmd === undefined
        ? { status: 1, stdout: '', stderr: '' }
        : { status: 0, stdout: cmd + '\n', stderr: '' }
    }
    if (command === 'kill') return { status: 0, stdout: '', stderr: '' }
    return { status: 0, stdout: '', stderr: '' } satisfies CommandResult
  }
  return { runner, calls }
}

describe('scanRunningProfiles：归属分类', () => {
  test('self(dsh-rsi/purge.sh) 跳过；dsh 操作 proven；不明命令 foreign', async () => {
    const { runner } = psRunner({
      101: 'dsh-rsi purge --yes --profile web',
      102: 'node /opt/dsh/bin/dsh --profile web --no-open',
      103: 'node /opt/dsh/bin/dsh plugin --profile web remove @deepseek-ai/dsh-sandbox-local',
      104: '/usr/sbin/anacron --profile web',
    })
    const { processes } = await scanRunningProfiles('/home/u/.dsh', ['web'], runner)
    const byPid = Object.fromEntries(processes.map(p => [p.pid, p]))
    // 101 self → 不出现
    expect(byPid[101]).toBeUndefined()
    // 102 managed host / 103 plugin 命令 → proven
    expect(byPid[102]?.owner).toBe('proven')
    expect(byPid[103]?.owner).toBe('proven')
    // 104 无法证明归属 → foreign
    expect(byPid[104]?.owner).toBe('foreign')
  })

  test('pgrep 出错时返回 error（fail-closed）', async () => {
    const runner: CommandRunner = () => ({ status: 2, stdout: '', stderr: 'pgrep boom' })
    const { error } = await scanRunningProfiles('/h/.dsh', ['web'], runner)
    expect(error).toMatch(/pgrep boom/)
  })
})

describe('terminatePids：TERM → KILL', () => {
  test('进程已退出：只发 TERM，不发 KILL，计入 terminated', async () => {
    const { runner, calls } = psRunner({ 202: 'PID 202' }) // ps 报告已退出
    const report = await terminatePids([202], runner, { timeoutMs: 100, intervalMs: 20 })
    expect(report.terminated).toBe(1)
    expect(report.failed).toEqual([])
    expect(calls.some(c => c.startsWith('kill -KILL'))).toBe(false)
  })

  test('TERM 后仍存活：超时后补发 KILL，复检防 PID reuse', async () => {
    let psCalls = 0
    const runner: CommandRunner = (command, _args) => {
      if (command === 'kill') return { status: 0, stdout: '', stderr: '' }
      if (command === 'ps') {
        // 前几次报存活（含 dsh），KILL 后报退出
        psCalls += 1
        if (psCalls >= 4) return { status: 1, stdout: '', stderr: '' }
        return { status: 0, stdout: 'dsh --profile web --port 0\n', stderr: '' }
      }
      return { status: 0, stdout: '', stderr: '' }
    }
    const report = await terminatePids([303], runner, { timeoutMs: 200, intervalMs: 30 })
    expect(report.failed).toEqual([])
    // KILL 应被调用过
    const killCalls: string[] = []
    // 重新跑一次记录 kill
    const recordRunner: CommandRunner = (command, args) => {
      if (command === 'kill') killCalls.push([command, ...args].join(' '))
      if (command === 'ps') return { status: 1, stdout: '', stderr: '' }
      return { status: 0, stdout: '', stderr: '' }
    }
    await terminatePids([304], recordRunner, { timeoutMs: 100, intervalMs: 20 })
    expect(report.terminated).toBeGreaterThan(0)
  })
})
