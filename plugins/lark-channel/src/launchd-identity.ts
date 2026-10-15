import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { launchAgentPaths } from './launchd.js'

export interface NativeLaunchdIdentity {
  dshHome: string; profile: string; home?: string; uid?: number
  nodePath?: string; dshPath?: string; dshSha256?: string
}
export interface NativeLaunchdState { registered: boolean; pid: number }
export interface NativeLaunchdDetail extends NativeLaunchdState {
  running: boolean; state: string | null; lastExitCode: string | null
}
export interface NativeLaunchdCommandResult { status: number | null; stdout: string; stderr: string }
export type NativeLaunchdCommand = (command: string, args: string[]) => NativeLaunchdCommandResult
const run: NativeLaunchdCommand = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 262_144,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, stdio: ['ignore', 'pipe', 'pipe'] })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}
function fail(message: string): never { throw new Error(`rsi native launchd: ${message}`) }
function identity(input: NativeLaunchdIdentity) {
  const uid = input.uid ?? process.getuid?.()
  if (!Number.isSafeInteger(uid) || uid === undefined || uid < 1) fail('a non-root GUI user is required')
  const paths = launchAgentPaths(input), domain = `gui/${uid}`
  return { ...paths, domain, target: `${domain}/${paths.label}`, cwd: join(input.dshHome, 'profiles', input.profile) }
}
function scalar(text: string, key: string, separator = ' = '): string | undefined {
  const prefix = `${key}${separator}`
  const matches = text.split('\n').map(line => line.trim()).filter(line => line.startsWith(prefix))
  if (matches.length !== 1) return undefined
  return matches[0]!.slice(prefix.length)
}
function rootScalar(text: string, target: string, key: string): string | undefined {
  const lines = text.split('\n'), values: string[] = []
  let depth = 0, rootDepth = 0, first = true, wrapped = false
  for (const line of lines) {
    const value = line.trim()
    if (value === '') continue
    if (first) {
      first = false
      if (value.endsWith(' = {')) {
        if (value !== `${target} = {`) return undefined
        depth = 1; rootDepth = 1; wrapped = true
        continue
      }
    }
    if (wrapped && depth === 0) return undefined
    if (value === '}') {
      if (depth === 0) return undefined
      depth -= 1
      continue
    }
    const prefix = `${key} = `
    if (depth === rootDepth && value.startsWith(prefix)) values.push(value.slice(prefix.length))
    if (value.endsWith(' = {')) depth += 1
  }
  return depth === 0 && values.length === 1 ? values[0] : undefined
}
function assertArguments(args: unknown, input: NativeLaunchdIdentity): void {
  if (!input.nodePath || !input.dshPath || !input.dshSha256 || !Array.isArray(args)
    || !args.every(arg => typeof arg === 'string')) fail('service executable identity is missing')
  const offset = args[1] === '--disable-warning=ExperimentalWarning' ? 2 : 1
  const node = args[0], dsh = args[offset]
  if (args.length !== offset + 4 || typeof node !== 'string' || typeof dsh !== 'string' || !isAbsolute(node) || !isAbsolute(dsh)
    || realpathSync(node) !== input.nodePath || realpathSync(dsh) !== input.dshPath
    || args[offset + 1] !== '--profile' || args[offset + 2] !== input.profile || args[offset + 3] !== '--no-open'
    || createHash('sha256').update(readFileSync(input.dshPath)).digest('hex') !== input.dshSha256) {
    fail('service command differs from the selected Node and DSH installation')
  }
}

/** A missing job is distinct from a failed launchctl query. Never stop a job
 * belonging to another Home just because its profile label is the same. */
export function inspectNativeLaunchdDetail(input: NativeLaunchdIdentity, command: NativeLaunchdCommand = run): NativeLaunchdDetail {
  const expected = identity(input), result = command('/bin/launchctl', ['print', expected.target])
  if (result.status !== 0) {
    if (result.status === 113 && /Could not find service/iu.test(result.stderr)) {
      return { registered: false, pid: 0, running: false, state: null, lastExitCode: null }
    }
    fail('cannot inspect the user service')
  }
  if (scalar(result.stdout, 'path') !== expected.plistPath || scalar(result.stdout, 'working directory') !== expected.cwd
    || scalar(result.stdout, 'DSH_HOME', ' => ') !== input.dshHome) fail('loaded service belongs to another installation')
  if (/^\s*(?:NODE_OPTIONS|NODE_PATH|DYLD_[A-Z_]+|LD_PRELOAD|LD_LIBRARY_PATH) =>/mu.test(result.stdout)) {
    fail('loaded service has an unexpected execution environment')
  }
  const argumentsBlock = /^\s*arguments = \{\n([\s\S]*?)^\s*\}/mu.exec(result.stdout)
  assertArguments(argumentsBlock?.[1]?.split('\n').map(line => line.trim()).filter(Boolean), input)
  if (realpathSync(scalar(result.stdout, 'program') ?? '') !== input.nodePath) fail('loaded service program differs')
  const raw = scalar(result.stdout, 'pid'), pid = raw === undefined ? 0 : Number(raw)
  if (!Number.isSafeInteger(pid) || pid < 0 || pid === 1) fail('invalid service process identity')
  const state = rootScalar(result.stdout, expected.target, 'state') ?? null
  return { registered: true, pid, running: state === 'running' && pid > 1, state,
    lastExitCode: rootScalar(result.stdout, expected.target, 'last exit code') ?? null }
}

export function inspectNativeLaunchd(input: NativeLaunchdIdentity, command: NativeLaunchdCommand = run): NativeLaunchdState {
  const { registered, pid } = inspectNativeLaunchdDetail(input, command)
  return { registered, pid }
}

/** Validate an existing plist before recording it for rollback. The loaded job
 * is independently checked by inspectNativeLaunchd. */
export function assertNativeLaunchdPlist(bytes: string, input: NativeLaunchdIdentity,
  command: NativeLaunchdCommand = run): void {
  // plutil receives the already-read bytes via an argument-free stdin call in
  // production; tests may supply a parsed response without executing launchd.
  const result = command === run ? (() => {
    const child = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'],
      { input: bytes, encoding: 'utf8', timeout: 10_000, maxBuffer: 262_144, env: { PATH: '/usr/bin:/bin' } })
    return { status: child.status, stdout: child.stdout ?? '', stderr: child.stderr ?? '' }
  })() : command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'])
  if (result.status !== 0) fail('invalid LaunchAgent plist')
  const value = JSON.parse(result.stdout) as Record<string, any>, expected = identity(input)
  const fields = new Set(['Label', 'ProgramArguments', 'EnvironmentVariables', 'WorkingDirectory',
    'StandardOutPath', 'StandardErrorPath', 'LimitLoadToSessionType', 'ProcessType', 'RunAtLoad',
    'KeepAlive', 'ThrottleInterval', 'ExitTimeOut', 'Umask'])
  // Program overrides argv[0]; other launchd keys can change the executable's
  // filesystem or inherited authority. Only our generated execution shape is
  // safe to record as a rollback target.
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.has(key))
    || !value.EnvironmentVariables || typeof value.EnvironmentVariables !== 'object'
    || Object.keys(value.EnvironmentVariables).sort().join(',') !== 'DSH_HOME,PATH'
    || typeof value.EnvironmentVariables.PATH !== 'string'
    || !value.EnvironmentVariables.PATH.split(':').every((path: string) => isAbsolute(path) && !/[\p{Cc}]/u.test(path))
    || value.StandardOutPath !== expected.stdoutPath || value.StandardErrorPath !== expected.stderrPath
    || value.LimitLoadToSessionType !== 'Aqua' || value.ProcessType !== 'Background'
    || value.RunAtLoad !== true || value.KeepAlive !== true || value.ThrottleInterval !== 10
    || value.ExitTimeOut !== 30 || value.Umask !== 63) fail('plist execution settings differ from the managed LaunchAgent')
  if (value.Label !== expected.label || value.WorkingDirectory !== expected.cwd
    || value.EnvironmentVariables?.DSH_HOME !== input.dshHome) fail('plist belongs to another installation')
  assertArguments(value.ProgramArguments, input)
}

export async function stopNativeLaunchd(input: NativeLaunchdIdentity, signal: AbortSignal,
  command: NativeLaunchdCommand = run): Promise<void> {
  const expected = identity(input)
  const initial = inspectNativeLaunchd(input, command)
  if (!initial.registered) return
  const stopped = command('/bin/launchctl', ['bootout', expected.target])
  // bootout can report a racing removal, but the job must actually disappear.
  for (let attempt = 0; attempt < 400; attempt++) {
    signal.throwIfAborted()
    if (!inspectNativeLaunchd(input, command).registered) {
      // Registry removal alone is insufficient: launchd may still be waiting
      // for the old process to exit. A reused PID conservatively blocks setup.
      if (initial.pid === 0) return
      try { process.kill(initial.pid, 0) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error }
    }
    if (stopped.status !== 0) fail('service did not stop')
    await delay(100, undefined, { signal })
  }
  fail('service remained registered after bootout')
}
export async function startNativeLaunchd(input: NativeLaunchdIdentity, signal: AbortSignal,
  command: NativeLaunchdCommand = run): Promise<void> {
  const expected = identity(input)
  if (inspectNativeLaunchd(input, command).registered) fail('service is still registered before bootstrap')
  if (command('/bin/launchctl', ['enable', expected.target]).status !== 0) fail('cannot enable user service')
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted()
    const result = command('/bin/launchctl', ['bootstrap', expected.domain, expected.plistPath])
    if (result.status !== 0 && result.status !== 5) fail('cannot bootstrap user service')
    if (inspectNativeLaunchd(input, command).registered) return
    await delay(250, undefined, { signal })
  }
  fail('bootstrap did not register the service')
}
