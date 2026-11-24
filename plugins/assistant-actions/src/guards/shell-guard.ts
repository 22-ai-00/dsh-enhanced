import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, sep } from 'node:path'
import type {
  ShellCommandRule,
  ShellExecPayload,
  ShellGrantDestination,
  ShellRequestDestination,
} from '../broker-protocol-v2.js'
import { responseContainsSecret } from './http-guard.js'

export interface ShellFsDeps {
  readonly realpath?: (path: string) => Promise<string>
  readonly lstat?: (path: string) => Promise<{ isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>
  readonly readFile?: (path: string) => Promise<Buffer>
}

export interface ShellGuardDeps extends ShellFsDeps {
  readonly spawnImpl?: typeof spawn
  readonly secrets?: readonly string[]
}

export class ShellGuardError extends Error {
  constructor(
    readonly code: 'request-invalid' | 'grant-invalid' | 'aborted' | 'deadline-exceeded' | 'transport-failed' | 'response-secret-leak',
    readonly dispatched: boolean,
    message: string,
  ) {
    super(`assistant-actions shell guard: ${message}`)
    this.name = 'ShellGuardError'
  }
}

const BLOCKED_ENV_PREFIXES = ['LD_', 'DYLD_']
const BLOCKED_ENV_EXACT = new Set([
  'NODE_OPTIONS',
  'BASH_ENV',
  'ENV',
  'IFS',
  'CDPATH',
  'PYTHONPATH',
  'RUBYOPT',
  'PERL5OPT',
])

const CONTROL_CHAR_RE = /[\p{Cc}]/u

function isSubPathOrEqual(candidate: string, allowedRoot: string): boolean {
  if (candidate === allowedRoot) return true
  if (allowedRoot === sep) return candidate.startsWith(sep)
  return candidate.startsWith(allowedRoot.endsWith(sep) ? allowedRoot : `${allowedRoot}${sep}`)
}

function validateEnv(grantDest: ShellGrantDestination, rawEnv: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const cleanEnv: Record<string, string> = {}
  if (!rawEnv) return cleanEnv
  const allowed = new Set(grantDest.allowedEnvKeys)
  for (const [key, value] of Object.entries(rawEnv)) {
    if (CONTROL_CHAR_RE.test(key) || CONTROL_CHAR_RE.test(value)) {
      throw new ShellGuardError('request-invalid', false, 'shell env contains control characters')
    }
    const normalizedKey = key.toUpperCase()
    if (BLOCKED_ENV_PREFIXES.some(prefix => normalizedKey.startsWith(prefix)) || BLOCKED_ENV_EXACT.has(normalizedKey)) {
      throw new ShellGuardError('grant-invalid', false, `forbidden environment variable: ${key}`)
    }
    if (normalizedKey === 'PATH' && (!allowed.has('PATH') || key !== 'PATH')) {
      throw new ShellGuardError('grant-invalid', false, 'PATH override is forbidden unless explicitly allowed')
    }
    if (!allowed.has(key)) {
      throw new ShellGuardError('grant-invalid', false, `environment variable not in allowedEnvKeys: ${key}`)
    }
    cleanEnv[key] = value
  }
  return cleanEnv
}

function validateArgs(rule: ShellCommandRule, args: readonly string[]): void {
  if (args.length > rule.maxArgs) {
    throw new ShellGuardError('grant-invalid', false, 'argument count exceeds maxArgs')
  }
  for (const arg of args) {
    if (typeof arg !== 'string' || CONTROL_CHAR_RE.test(arg)) {
      throw new ShellGuardError('request-invalid', false, 'shell argument contains control characters')
    }
  }
  if (rule.allowedArgPrefixes && rule.allowedArgPrefixes.length > 0) {
    const matched = rule.allowedArgPrefixes.some(prefix =>
      prefix.length <= args.length && prefix.every((token, index) => args[index] === token),
    )
    if (!matched) {
      throw new ShellGuardError('grant-invalid', false, 'shell arguments do not match allowedArgPrefixes')
    }
  }
  if (rule.allowArgsPattern !== undefined) {
    const regex = new RegExp(rule.allowArgsPattern, 'u')
    if (args.some(arg => !regex.test(arg))) {
      throw new ShellGuardError('grant-invalid', false, 'shell argument violates allowArgsPattern')
    }
  }
}

export async function validateShellAgainstGrant(
  grantDest: ShellGrantDestination,
  reqDest: ShellRequestDestination,
  payload: ShellExecPayload,
  deps: ShellFsDeps = {},
): Promise<{ canonicalCwd: string; executable: string; cleanEnv: Record<string, string>; rule: ShellCommandRule }> {
  if (reqDest.executable !== payload.executable || reqDest.cwd !== payload.cwd) {
    throw new ShellGuardError('request-invalid', false, 'shell destination does not match payload')
  }
  if (!isAbsolute(payload.executable) || !isAbsolute(payload.cwd) || CONTROL_CHAR_RE.test(payload.executable) || CONTROL_CHAR_RE.test(payload.cwd)) {
    throw new ShellGuardError('request-invalid', false, 'shell executable and cwd must be canonical absolute paths')
  }
  if (payload.timeoutMs < 1 || payload.timeoutMs > grantDest.maxTimeoutMs) {
    throw new ShellGuardError('grant-invalid', false, 'shell timeoutMs exceeds maxTimeoutMs')
  }

  const realpathFn = deps.realpath ?? (p => realpath(p))
  const lstatFn = deps.lstat ?? (p => lstat(p))
  const readFileFn = deps.readFile ?? (p => readFile(p))

  let canonicalCwd: string
  let cwdStat: { isDirectory(): boolean; isSymbolicLink(): boolean }
  try {
    [canonicalCwd, cwdStat] = await Promise.all([realpathFn(payload.cwd), lstatFn(payload.cwd)])
  } catch {
    throw new ShellGuardError('grant-invalid', false, 'shell cwd does not exist or cannot be inspected')
  }
  if (cwdStat.isSymbolicLink() || !cwdStat.isDirectory() || canonicalCwd !== payload.cwd) {
    throw new ShellGuardError('grant-invalid', false, 'shell cwd must be a canonical non-symlink directory')
  }

  const canonicalAllowedCwds: string[] = []
  for (const allowedCwd of grantDest.allowedCwds) {
    try {
      canonicalAllowedCwds.push(await realpathFn(allowedCwd))
    } catch {
      // Ignore missing optional allowed root; fail closed if none match
    }
  }
  if (!canonicalAllowedCwds.some(allowedRoot => isSubPathOrEqual(canonicalCwd, allowedRoot))) {
    throw new ShellGuardError('grant-invalid', false, 'shell cwd is outside allowedCwds')
  }

  const rule = grantDest.allowedCommands.find(entry => entry.executable === payload.executable)
  if (!rule) {
    throw new ShellGuardError('grant-invalid', false, 'shell executable is not in allowedCommands')
  }

  let canonicalExecutable: string
  let execStat: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }
  try {
    [canonicalExecutable, execStat] = await Promise.all([realpathFn(payload.executable), lstatFn(payload.executable)])
  } catch {
    throw new ShellGuardError('grant-invalid', false, 'shell executable does not exist or cannot be inspected')
  }
  if (execStat.isSymbolicLink() || !execStat.isFile() || canonicalExecutable !== payload.executable) {
    throw new ShellGuardError('grant-invalid', false, 'shell executable must be a canonical non-symlink file')
  }

  if (rule.executableSha256 !== undefined) {
    let bytes: Buffer
    try {
      bytes = await readFileFn(canonicalExecutable)
    } catch {
      throw new ShellGuardError('grant-invalid', false, 'cannot read shell executable for SHA-256 verification')
    }
    const actualSha256 = createHash('sha256').update(bytes).digest('hex')
    if (actualSha256 !== rule.executableSha256) {
      throw new ShellGuardError('grant-invalid', false, 'shell executable SHA-256 mismatch')
    }
  }

  validateArgs(rule, payload.args)
  const cleanEnv = validateEnv(grantDest, payload.env)
  return { canonicalCwd, executable: canonicalExecutable, cleanEnv, rule }
}

export function validateShellPolicyAgainstGrant(
  grantDest: ShellGrantDestination,
  reqDest: ShellRequestDestination,
  payload: ShellExecPayload,
): { cleanEnv: Record<string, string>; rule: ShellCommandRule } {
  if (reqDest.executable !== payload.executable || reqDest.cwd !== payload.cwd) {
    throw new ShellGuardError('request-invalid', false, 'shell destination does not match payload')
  }
  if (!isAbsolute(payload.executable) || !isAbsolute(payload.cwd) || CONTROL_CHAR_RE.test(payload.executable) || CONTROL_CHAR_RE.test(payload.cwd)) {
    throw new ShellGuardError('request-invalid', false, 'shell executable and cwd must be canonical absolute paths')
  }
  if (payload.cwd.split(/[/\\]/u).some(seg => seg === '.' || seg === '..')
    || payload.executable.split(/[/\\]/u).some(seg => seg === '.' || seg === '..')) {
    throw new ShellGuardError('request-invalid', false, 'shell executable and cwd must not contain dot path segments')
  }
  if (payload.timeoutMs < 1 || payload.timeoutMs > grantDest.maxTimeoutMs) {
    throw new ShellGuardError('grant-invalid', false, 'shell timeoutMs exceeds maxTimeoutMs')
  }
  if (!grantDest.allowedCwds.some(allowedRoot => isSubPathOrEqual(payload.cwd, allowedRoot))) {
    throw new ShellGuardError('grant-invalid', false, 'shell cwd is outside allowedCwds')
  }
  const rule = grantDest.allowedCommands.find(entry => entry.executable === payload.executable)
  if (!rule) {
    throw new ShellGuardError('grant-invalid', false, 'shell executable is not in allowedCommands')
  }
  validateArgs(rule, payload.args)
  const cleanEnv = validateEnv(grantDest, payload.env)
  return { cleanEnv, rule }
}

function killProcessGroup(child: ChildProcess): void {
  const pid = child.pid
  if (pid && process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL')
      return
    } catch {
      // Fall back to direct child kill
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // Already exited
  }
}

export async function executeShellGuardedAction(input: {
  readonly grantDestination: ShellGrantDestination
  readonly requestDestination: ShellRequestDestination
  readonly payload: ShellExecPayload
  readonly remainingLeaseMs: number
  readonly signal: AbortSignal
  readonly deps?: ShellGuardDeps
}): Promise<{
  readonly domain: 'shell'
  readonly operation: 'shell.exec'
  readonly exitCode: number
  readonly signal?: string
  readonly stdout: string
  readonly stderr: string
  readonly stdoutSha256: string
  readonly stderrSha256: string
  readonly truncated: boolean
  readonly untrusted: true
}> {
  const { canonicalCwd, executable, cleanEnv } = await validateShellAgainstGrant(
    input.grantDestination,
    input.requestDestination,
    input.payload,
    input.deps,
  )

  const secrets = input.deps?.secrets ?? []
  if (responseContainsSecret(JSON.stringify(input.payload), secrets)) {
    throw new ShellGuardError('request-invalid', false, 'shell payload contains a protected secret or credential shape')
  }

  if (input.signal.aborted) {
    throw new ShellGuardError('aborted', false, 'shell execution aborted')
  }

  const effectiveTimeoutMs = Math.max(1, Math.min(input.payload.timeoutMs, input.grantDestination.maxTimeoutMs, input.remainingLeaseMs))
  const spawnFn = input.deps?.spawnImpl ?? spawn

  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    let truncated = false
    let stdoutBytes = 0
    let stderrBytes = 0
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let timeoutHandle: NodeJS.Timeout | undefined

    const child = spawnFn(executable, [...input.payload.args], {
      cwd: canonicalCwd,
      env: cleanEnv,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })

    const cleanup = (): void => {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle)
        timeoutHandle = undefined
      }
      input.signal.removeEventListener('abort', onAbort)
    }

    const fail = (err: ShellGuardError): void => {
      if (settled) return
      settled = true
      cleanup()
      killProcessGroup(child)
      rejectPromise(err)
    }

    const onAbort = (): void => {
      fail(new ShellGuardError('aborted', true, 'shell execution aborted'))
    }

    if (input.signal.aborted) {
      onAbort()
      return
    }
    input.signal.addEventListener('abort', onAbort, { once: true })

    timeoutHandle = setTimeout(() => {
      fail(new ShellGuardError('deadline-exceeded', true, 'shell execution timed out'))
    }, effectiveTimeoutMs)
    timeoutHandle.unref()

    child.stdout?.on('data', (chunk: Buffer) => {
      const remaining = input.grantDestination.maxStdoutBytes - stdoutBytes
      if (chunk.length > remaining) {
        if (remaining > 0) stdoutChunks.push(chunk.subarray(0, remaining))
        stdoutBytes = input.grantDestination.maxStdoutBytes
        truncated = true
        killProcessGroup(child)
        return
      }
      stdoutChunks.push(chunk)
      stdoutBytes += chunk.length
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      const remaining = input.grantDestination.maxStderrBytes - stderrBytes
      if (chunk.length > remaining) {
        if (remaining > 0) stderrChunks.push(chunk.subarray(0, remaining))
        stderrBytes = input.grantDestination.maxStderrBytes
        truncated = true
        killProcessGroup(child)
        return
      }
      stderrChunks.push(chunk)
      stderrBytes += chunk.length
    })

    child.once('error', error => {
      fail(new ShellGuardError('transport-failed', true, error.message))
    })

    child.once('close', (code, exitSignal) => {
      if (settled) return
      settled = true
      cleanup()
      const stdoutBuf = Buffer.concat(stdoutChunks)
      const stderrBuf = Buffer.concat(stderrChunks)
      const stdout = stdoutBuf.toString('utf8')
      const stderr = stderrBuf.toString('utf8')
      if (responseContainsSecret(stdout, secrets) || responseContainsSecret(stderr, secrets)) {
        rejectPromise(new ShellGuardError('response-secret-leak', true, 'shell output contained protected secret'))
        return
      }
      resolvePromise(Object.freeze({
        domain: 'shell',
        operation: 'shell.exec',
        exitCode: code ?? (exitSignal ? 128 : 0),
        ...(exitSignal ? { signal: exitSignal } : {}),
        stdout,
        stderr,
        stdoutSha256: createHash('sha256').update(stdoutBuf).digest('hex'),
        stderrSha256: createHash('sha256').update(stderrBuf).digest('hex'),
        truncated,
        untrusted: true,
      }))
    })

    if (input.payload.stdin !== undefined) {
      child.stdin?.write(input.payload.stdin, 'utf8')
    }
    child.stdin?.end()
  })
}
