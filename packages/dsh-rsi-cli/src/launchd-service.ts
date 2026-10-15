import { lstat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { CommandRunner } from './run.ts'
import { defaultRunner } from './run.ts'
import { launchAgentTargets } from './paths.ts'

export interface LaunchdState { registered: boolean; pid: number; running: boolean; error?: string }

interface LoadedPrint { top: Map<string, string>; environment: Map<string, string>; args: string[] }

/** launchctl print contains nested coalitions with their own state/pid keys. */
function parseLoadedPrint(source: string, target: string): LoadedPrint | undefined {
  const lines = source.split('\n').map(line => line.trim()).filter(Boolean)
  const wrapped = lines[0] === `${target} = {`
  const stack = wrapped ? ['@root'] : [] as string[]
  const rootOffset = wrapped ? 1 : 0
  const top = new Map<string, string>()
  const environment = new Map<string, string>()
  const args: string[] = []
  let argumentsBlocks = 0
  let environmentBlocks = 0
  for (const line of wrapped ? lines.slice(1) : lines) {
    if (line === '}') {
      if (stack.length === 0) return undefined
      stack.pop()
      continue
    }
    if (wrapped && stack.length === 0) return undefined
    const scope = stack.slice(rootOffset)
    const block = /^(.+?) (?:=|=>) \{$/u.exec(line)
    if (block) {
      if (scope.length === 0 && block[1] === 'arguments') argumentsBlocks++
      if (scope.length === 0 && block[1] === 'environment') environmentBlocks++
      stack.push(block[1]!)
      continue
    }
    if (scope.length === 1 && scope[0] === 'arguments') {
      args.push(line)
      continue
    }
    // Coalition/resource blocks may contain lists and display-only values.
    // Their fields cannot establish execution identity, so only balance their
    // delimiters and ignore their contents.
    if (scope.length > 0 && !(scope.length === 1 && scope[0] === 'environment')) continue
    const field = /^(.+?) (?:=|=>) (.*)$/u.exec(line)
    if (!field) return undefined
    if (scope.length === 0) {
      if (top.has(field[1]!)) return undefined
      top.set(field[1]!, field[2]!)
    } else if (scope.length === 1 && scope[0] === 'environment') {
      if (environment.has(field[1]!)) return undefined
      environment.set(field[1]!, field[2]!)
    }
  }
  if (stack.length !== 0 || argumentsBlocks !== 1 || environmentBlocks !== 1) return undefined
  return { top, environment, args }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

export interface LaunchdDefinition { path: string; label: string; cwd: string; args: string[]; program: string }

/** plutil parses the actual plist structure; a matching string elsewhere in XML is insufficient. */
export async function inspectLaunchdDefinition(osHome: string, dshHome: string, profile: string,
  runner: CommandRunner = defaultRunner): Promise<{ definition?: LaunchdDefinition; exists: boolean; error?: string }> {
  const { label, plistPath } = launchAgentTargets(osHome, profile)
  try {
    const metadata = await lstat(plistPath)
    if (!metadata.isFile() || metadata.isSymbolicLink()) return { exists: true, error: 'plist 不是普通文件' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false }
    return { exists: true, error: `无法检查 plist：${String(error)}` }
  }
  const parsed = runner('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', plistPath])
  if (parsed.status !== 0) return { exists: true, error: `无法解析 plist：${parsed.stderr.trim() || parsed.status}` }
  let value: Record<string, unknown> | undefined
  try { value = record(JSON.parse(parsed.stdout)) } catch { /* malformed output is foreign */ }
  const environment = record(value?.EnvironmentVariables)
  const args = value?.ProgramArguments
  const cwd = join(dshHome, 'profiles', profile)
  const allowed = new Set(['Label', 'ProgramArguments', 'EnvironmentVariables', 'WorkingDirectory',
    'StandardOutPath', 'StandardErrorPath', 'LimitLoadToSessionType', 'ProcessType', 'RunAtLoad',
    'KeepAlive', 'ThrottleInterval', 'ExitTimeOut', 'Umask'])
  const valid = !!value && Object.keys(value).every(key => allowed.has(key))
    && value.Label === label && value.WorkingDirectory === cwd
    && environment?.DSH_HOME === dshHome
    && Object.keys(environment).sort().join(',') === 'DSH_HOME,PATH'
    && typeof environment.PATH === 'string'
    && environment.PATH.split(':').every(path => isAbsolute(path))
    && Array.isArray(args) && args.every(arg => typeof arg === 'string')
    && (args.length === 5 || args.length === 6)
    && typeof args[0] === 'string' && isAbsolute(args[0] as string)
    && (args.length === 5 || args[1] === '--disable-warning=ExperimentalWarning')
    && typeof args[args.length - 4] === 'string' && isAbsolute(args[args.length - 4] as string)
    && args[args.length - 3] === '--profile' && args[args.length - 2] === profile
    && args[args.length - 1] === '--no-open'
    && value.StandardOutPath === join(dshHome, 'logs', `${profile}-host.log`)
    && value.StandardErrorPath === join(dshHome, 'logs', `${profile}-host.error.log`)
    && value.LimitLoadToSessionType === 'Aqua' && value.ProcessType === 'Background'
    && value.RunAtLoad === true && value.KeepAlive === true
    && value.ThrottleInterval === 10 && value.ExitTimeOut === 30 && value.Umask === 63
  if (!valid) return { exists: true, error: 'plist 不属于指定 DSH home/profile 或执行参数不符' }
  return { exists: true, definition: { path: plistPath, label, cwd, args: args as string[], program: args[0] as string } }
}

/** A failed query is absent only for launchctl's explicit service-not-found response. */
export function inspectLoadedLaunchd(definition: LaunchdDefinition, dshHome: string,
  runner: CommandRunner = defaultRunner): LaunchdState {
  const target = `gui/${process.getuid?.() ?? process.env.UID}/${definition.label}`
  const result = runner('launchctl', ['print', target])
  if (result.status !== 0) {
    return result.status === 113 && /Could not find service/iu.test(result.stderr)
      ? { registered: false, pid: 0, running: false }
      : { registered: false, pid: 0, running: false,
        error: `无法查询已加载服务：${result.stderr.trim() || `launchctl 退出码 ${result.status}`}` }
  }
  const parsed = parseLoadedPrint(result.stdout, target)
  const rawPid = parsed?.top.get('pid')
  const pid = rawPid === undefined ? 0 : Number(rawPid)
  if (!parsed || parsed.top.get('path') !== definition.path
    || parsed.top.get('working directory') !== definition.cwd
    || parsed.environment.get('DSH_HOME') !== dshHome
    || parsed.top.get('program') !== definition.program
    || JSON.stringify(parsed.args) !== JSON.stringify(definition.args)
    || parsed.top.get('state') === undefined
    || !Number.isSafeInteger(pid) || pid < 0 || pid === 1
    || /^\s*(?:NODE_OPTIONS|NODE_PATH|DYLD_[A-Z_]+|LD_PRELOAD|LD_LIBRARY_PATH) =>/mu.test(result.stdout)) {
    return { registered: true, pid: 0, running: false, error: '已加载服务与指定 DSH home/profile 的 plist 不一致' }
  }
  return { registered: true, pid, running: parsed.top.get('state') === 'running' && pid > 1 }
}

export function oldPidExited(pid: number, runner: CommandRunner): boolean {
  if (pid < 2) return true
  const result = runner('ps', ['-p', String(pid), '-o', 'pid='])
  return result.status === 1 && result.stdout.trim() === '' && result.stderr.trim() === ''
}
