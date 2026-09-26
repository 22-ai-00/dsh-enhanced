import { spawnSync, type SpawnSyncReturns } from 'node:child_process'

export interface CommandResult {
  status: number | null
  stdout: string
  stderr: string
}

export type CommandRunner = (command: string, args: readonly string[]) => CommandResult

/** 默认命令执行器：直接 spawn，不经 shell（参数数组天然无注入面）。 */
export const defaultRunner: CommandRunner = (command, args) => {
  const result: SpawnSyncReturns<Buffer> = spawnSync(command, [...args], { maxBuffer: 16 * 1024 * 1024 })
  return {
    status: result.status,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
  }
}

export interface RunningProcess {
  pid: number
  commandLine: string
}

function escapeRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * 进程静止检查：查找仍在运行的受管 profile host。
 *
 * 先用 `pgrep -f <pattern>`（只取 PID），pattern 为 `--profile <profile>`；
 * 命令行再用 `ps -p <pid> -o command=` 读取（procps/BSD 均支持），
 * 因为部分环境 pgrep -l 会打印线程 comm（如 MainThread）而非完整命令行。
 * dsh-rsi purge 自身命令行也可能带该参数，因此把命令行中含 dsh-rsi / dsh-rsi-cli
 * （旧包名 @dsh-enhanced/rsi-cli 的全局路径同样包含 rsi-cli）的匹配剔除。
 * pgrep 无匹配时退出码 1（属正常）；其它非零按执行失败上抛，由调用方 fail-closed。
 */
export function findRunningProfiles(
  profiles: readonly string[],
  runner: CommandRunner = defaultRunner,
): { active: RunningProcess[]; error?: string } {
  const active: RunningProcess[] = []
  for (const profile of profiles) {
    // `[-]-profile` 等价匹配字面量 `--profile`，但模式本身不以 - 开头，
    // Linux procps 与 macOS BSD pgrep 都不会把它当成选项（无需依赖 -- 分隔符）。
    const pattern = `[-]-profile ${escapeRegex(profile)}`
    const result = runner('pgrep', ['-f', pattern])
    if (result.status !== 0 && result.status !== 1) {
      return { active: [], error: result.stderr.trim() || `pgrep 退出码 ${result.status}` }
    }
    for (const line of result.stdout.split('\n')) {
      const pid = Number(line.trim())
      if (!Number.isInteger(pid) || pid <= 0) continue
      const commandLine = readCommandLine(pid, runner)
      if (commandLine.includes('dsh-rsi') || commandLine.includes('rsi-cli') || commandLine.includes('purge.sh')) continue
      active.push({ pid, commandLine })
    }
  }
  return { active }
}

/** 跨平台读取单个 PID 的完整命令行；读取失败时回退占位文本。 */
function readCommandLine(pid: number, runner: CommandRunner): string {
  const shown = runner('ps', ['-p', String(pid), '-o', 'command='])
  if (shown.status !== 0) return `PID ${pid}（命令行不可读）`
  return shown.stdout.trim() || `PID ${pid}`
}
