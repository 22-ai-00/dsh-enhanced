import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import type { CommandRunner } from './run.ts'
import { defaultRunner } from './run.ts'

/**
 * Purge 前的进程守卫。
 *
 * 旧逻辑在停服之前做进程静止检查：只要有 `--profile <p>` 进程在跑就直接 fail，
 * 连「本应受管、本可自动停掉」的 host 也不放过，导致用户卡在 purge 入口。
 * 这里把进程分成三类：
 *   - self    ：dsh-rsi / purge.sh 自身命令行，永远跳过。
 *   - proven  ：非 self，但命令行指向目标 profile，且归属证据（DSH_HOME 环境变量 /
 *               cwd / 命令行）能证明它属于本次要清除的 DSH home。可安全终止。
 *   - foreign ：命令行带 `--profile <p>` 但证据指向别的 home / 无法证明归属；fail-closed，
 *               绝不自动杀。
 *
 * 终止顺序：先 SIGTERM，轮询最多 5 秒；仍在则 SIGKILL。每次复检都重新读取命令行，
 * 确认 PID 仍是目标进程（防 PID reuse）。
 */

export interface GuardedProcess {
  pid: number
  commandLine: string
  /** 归属证据（人读），用于交互确认列出。 */
  evidence: string[]
  /** proven = 可安全终止；foreign = 无法证明归属，fail-closed。 */
  owner: 'proven' | 'foreign'
}

export interface ProcessScan {
  processes: GuardedProcess[]
  /** 非零即环境探测失败（pgrep 不可用等），调用方应 fail-closed。 */
  error?: string
}

/** 这些命令行属于 purge/rsi 自身，即使带 --profile 也绝不视为待终止目标。 */
function isSelfCommand(commandLine: string): boolean {
  return commandLine.includes('dsh-rsi')
    || commandLine.includes('rsi-cli')
    || commandLine.includes('purge.sh')
}

function escapeRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** 读取 PID 的命令行（ps）；失败返回占位。 */
function readCommandLine(pid: number, runner: CommandRunner): string {
  const shown = runner('ps', ['-p', String(pid), '-o', 'command='])
  return shown.stdout.trim() || `PID ${pid}`
}

/** Linux：从 /proc/<pid>/environ 读 DSH_HOME；失败返回 undefined。 */
async function procDshHome(pid: number): Promise<string | undefined> {
  try {
    const raw = await readFile(`/proc/${pid}/environ`, { encoding: 'utf8' })
    for (const entry of raw.split('\0')) {
      if (entry.startsWith('DSH_HOME=')) return entry.slice('DSH_HOME='.length) || undefined
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 扫描目标 profile 的运行中进程，分类为 proven / foreign。
 * 已停掉的受管服务不会再出现（调用方先 stopManagedService）；这里只处理残留进程。
 */
export async function scanRunningProfiles(
  dshHome: string,
  profiles: readonly string[],
  runner: CommandRunner = defaultRunner,
): Promise<ProcessScan> {
  const processes: GuardedProcess[] = []
  for (const profile of profiles) {
    const pattern = `[-]-profile ${escapeRegex(profile)}`
    const result = runner('pgrep', ['-f', pattern])
    if (result.status !== 0 && result.status !== 1) {
      return { processes, error: result.stderr.trim() || `pgrep 退出码 ${result.status}` }
    }
    for (const line of result.stdout.split('\n')) {
      const pid = Number(line.trim())
      if (!Number.isInteger(pid) || pid <= 0) continue
      const commandLine = readCommandLine(pid, runner)
      if (isSelfCommand(commandLine)) continue

      const evidence: string[] = [`命令行：${commandLine}`]
      const envHome = await procDshHome(pid)
      let owner: 'proven' | 'foreign'

      if (envHome !== undefined) {
        // 有 DSH_HOME 环境变量：直接比较，最强证据。
        evidence.push(`DSH_HOME=${envHome}`)
        owner = envHome === dshHome ? 'proven' : 'foreign'
      } else {
        // 无 /proc（macOS）或无 DSH_HOME 变量：命令行启发式。
        // 命令行带目标 --profile 且属于 dsh/dsh-rsi/dsh plugin 操作 → proven；
        // 否则无法证明归属 → foreign（fail-closed）。
        const looksLikeDsh = /(^|[\s/])(dsh|dsh-rsi)([\s.]|$)/u.test(commandLine)
          || commandLine.includes('dsh plugin')
        owner = looksLikeDsh ? 'proven' : 'foreign'
        if (!looksLikeDsh) evidence.push('命令行不含 dsh 操作，无法证明归属')
      }
      processes.push({ pid, commandLine, evidence, owner })
    }
  }
  return { processes }
}

export interface TerminationReport {
  terminated: number
  /** 仍在运行或身份已变的 PID（复检失败）。 */
  failed: number[]
}

/**
 * 终止一组已证明归属的 PID。
 * SIGTERM → 每 200ms 复检一次，最多 5s → 仍在则 SIGKILL。
 * 复检时重新读命令行：若 PID 已被复用成别的进程，立即放弃该 PID（不杀）。
 */
export async function terminatePids(
  pids: readonly number[],
  runner: CommandRunner = defaultRunner,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<TerminationReport> {
  const timeoutMs = options.timeoutMs ?? 5_000
  const intervalMs = options.intervalMs ?? 200
  const report: TerminationReport = { terminated: 0, failed: [] }
  if (pids.length === 0) return report

  runner('kill', ['-TERM', ...pids.map(String)])
  const deadline = Date.now() + timeoutMs
  const stillAlive: number[] = []
  for (const pid of pids) {
    const cmd = readCommandLine(pid, runner)
    if (cmd.startsWith('PID ')) {
      // 已经退出
      report.terminated += 1
      continue
    }
    stillAlive.push(pid)
  }
  if (stillAlive.length === 0) return report

  while (Date.now() < deadline && stillAlive.length > 0) {
    await new Promise(resolve => setTimeout(resolve, intervalMs))
    const gone: number[] = []
    for (const pid of stillAlive) {
      const cmd = readCommandLine(pid, runner)
      if (cmd.startsWith('PID ') || !cmd.includes('dsh')) {
        // 退出了；或 PID 已被复用成非 dsh 进程（身份变化）→ 不杀，记 failed。
        if (!cmd.startsWith('PID ')) report.failed.push(pid)
        else report.terminated += 1
        gone.push(pid)
      }
    }
    for (const pid of gone) {
      const idx = stillAlive.indexOf(pid)
      if (idx >= 0) stillAlive.splice(idx, 1)
    }
  }
  if (stillAlive.length > 0) {
    runner('kill', ['-KILL', ...stillAlive.map(String)])
    // 给 KILL 一点时间回收
    await new Promise(resolve => setTimeout(resolve, 200))
    for (const pid of stillAlive) {
      const cmd = readCommandLine(pid, runner)
      if (cmd.startsWith('PID ') || !cmd.includes('dsh')) {
        if (cmd.startsWith('PID ')) report.terminated += 1
        else report.failed.push(pid)
      } else {
        report.failed.push(pid)
      }
    }
  }
  return report
}

/** 供外部判断一个相对路径是否落在 dshHome 内（预留 cwd 证据扩展）。 */
export function pathInside(path: string, base: string): boolean {
  const rel = relative(base, path)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))
}
