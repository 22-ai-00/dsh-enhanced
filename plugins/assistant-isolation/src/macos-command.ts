import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, sep } from 'node:path'
import {
  canonicalAbsolutePath,
  collectSafeArtifacts,
  isPathWithinOrEqual,
  isPrivateDirectoryStats,
  safeWorkspaceTree,
} from './fs-ownership.js'
import type { IsolationFile } from './types.js'

export interface MacosSeatbeltCommandProfileInput {
  workspacePath: string
  tmpPath: string
  readOnlyRoots?: readonly string[]
  writablePaths?: readonly string[]
  executablePaths?: readonly string[]
  workspaceWritable?: boolean
  allowNetwork?: boolean
}

export interface MacosSeatbeltCommandInput {
  workspacePath: string
  tmpPath: string
  command?: string
  argv?: readonly string[]
  readOnlyRoots?: readonly string[]
  writablePaths?: readonly string[]
  executablePaths?: readonly string[]
  workspaceWritable?: boolean
  allowNetwork?: boolean
  env?: Readonly<Record<string, string>>
  stdin?: string
  maxStdinBytes?: number
  deadline: number
  maxOutputBytes: number
  maxArtifactBytes?: number
  artifacts?: readonly string[]
  sandboxExecPath?: string
  signal: AbortSignal
}

export interface MacosSeatbeltCommandResult {
  status: 'succeeded' | 'failed' | 'cancelled' | 'timed-out' | 'output-limit' | 'unknown'
  quiescent: boolean
  stdout: string
  stderr: string
  artifacts: IsolationFile[]
  exitCode?: number
  reason?: string
  pid?: number
}

export interface MacosSeatbeltAdapter {
  readonly platform?: NodeJS.Platform
  readonly uid?: number
  readonly sandboxExecPath?: string
  readonly spawn?: typeof spawn
  readonly verifySandboxExec?: (path: string) => Promise<boolean>
  readonly killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void
  readonly runCommand?: (input: MacosSeatbeltCommandInput, policy: string) => Promise<MacosSeatbeltCommandResult>
}

export const DEFAULT_MACOS_SANDBOX_EXEC = '/usr/bin/sandbox-exec'
const MAX_STDIN = 1_048_576
const MAX_OUTPUT = 4 * 1024 * 1024
const MAX_DURATION = 300_000
const CLOSE_GRACE_MS = 3_000
const FORBIDDEN_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
])
const PROXY_ENV_KEYS = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'FTP_PROXY'])

function hasAsciiControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function quote(value: string): string {
  return JSON.stringify(value)
}

function decodeOutput(bytes: Buffer): string | undefined {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return undefined }
}

function failure(reason: string): MacosSeatbeltCommandResult {
  return { status: 'failed', quiescent: true, stdout: '', stderr: '', artifacts: [], reason }
}

function isSafeExecPath(value: string): boolean {
  return canonicalAbsolutePath(value, 'darwin') && !hasAsciiControlChar(value)
}

function assertDarwinCanonicalPath(value: unknown, label: string): string {
  if (!canonicalAbsolutePath(value, 'darwin') || hasAsciiControlChar(value)) {
    throw new Error(`assistant-isolation: invalid macOS ${label} path`)
  }
  return value
}

function isOverbroadMacosWritablePath(target: string, home: string): boolean {
  return (
    target === '/'
    || target === '/Users'
    || target === '/private'
    || target === '/tmp'
    || target === '/var'
    || target === '/etc'
    || isPathWithinOrEqual(target, '/System', 'darwin')
    || isPathWithinOrEqual('/System', target, 'darwin')
    || isPathWithinOrEqual(target, '/usr', 'darwin')
    || isPathWithinOrEqual('/usr', target, 'darwin')
    || isPathWithinOrEqual(target, '/bin', 'darwin')
    || isPathWithinOrEqual('/bin', target, 'darwin')
    || isPathWithinOrEqual(target, '/sbin', 'darwin')
    || isPathWithinOrEqual('/sbin', target, 'darwin')
    || (home.length > 0 && (target === home || isPathWithinOrEqual(home, target, 'darwin')))
  )
}

export function buildMacosSeatbeltCommandProfile(input: MacosSeatbeltCommandProfileInput): string {
  const workspacePath = assertDarwinCanonicalPath(input.workspacePath, 'workspace')
  const tmpPath = assertDarwinCanonicalPath(input.tmpPath, 'tmp')
  const readOnlyRoots = [...new Set((input.readOnlyRoots ?? []).map(root => assertDarwinCanonicalPath(root, 'readOnlyRoot')))].sort()
  const rawHome = process.env.HOME || homedir()
  const home = canonicalAbsolutePath(rawHome, 'darwin') ? rawHome : ''
  const writablePaths = [...new Set((input.writablePaths ?? []).map(target => {
    const validated = assertDarwinCanonicalPath(target, 'writable')
    if (isOverbroadMacosWritablePath(validated, home)) {
      throw new Error(`assistant-isolation: overbroad macOS writable path: ${validated}`)
    }
    return validated
  }))].sort()
  const executablePaths = [...new Set((input.executablePaths ?? []).map(file => assertDarwinCanonicalPath(file, 'executable')))].sort()
  const ancestors = new Set<string>()
  for (const path of [
    workspacePath,
    tmpPath,
    ...readOnlyRoots,
    ...writablePaths,
    ...executablePaths,
    '/bin',
    '/usr/bin',
    '/usr/lib',
    '/System/Library',
    '/private/var/db/dyld',
  ]) {
    for (let parent = posix.dirname(path); ; parent = posix.dirname(parent)) {
      ancestors.add(parent)
      if (parent === '/') break
    }
  }
  const metadata = [...ancestors].sort().map(path => `(literal ${quote(path)})`).join(' ')
  const execTargets = [
    '(subpath "/bin")',
    '(subpath "/usr/bin")',
    ...readOnlyRoots.map(root => `(subpath ${quote(root)})`),
    ...executablePaths.map(file => `(literal ${quote(file)})`),
  ]
  const extraReadWritable = writablePaths.filter(w => w !== workspacePath && w !== tmpPath)
  const readTargets = [
    '(subpath "/bin")',
    '(subpath "/usr/bin")',
    '(subpath "/usr/lib")',
    '(subpath "/System/Library")',
    '(subpath "/private/var/db/dyld")',
    '(literal "/dev/null")',
    '(literal "/dev/urandom")',
    '(literal "/dev/zero")',
    `(subpath ${quote(workspacePath)})`,
    `(subpath ${quote(tmpPath)})`,
    ...readOnlyRoots.map(root => `(subpath ${quote(root)})`),
    ...extraReadWritable.map(w => `(subpath ${quote(w)})`),
    ...executablePaths.map(file => `(literal ${quote(file)})`),
  ]
  const extraWritePaths = writablePaths.filter(w => w !== tmpPath && (!input.workspaceWritable || w !== workspacePath))
  const writeTargets = [
    '(literal "/dev/null")',
    `(subpath ${quote(tmpPath)})`,
    ...(input.workspaceWritable ? [`(subpath ${quote(workspacePath)})`] : []),
    ...extraWritePaths.map(w => `(subpath ${quote(w)})`),
  ]
  const networkRules = input.allowNetwork
    ? ' (allow system-socket) (allow network-outbound) (allow mach-lookup (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.dnssd.service") (global-name "com.apple.trustd") (global-name "com.apple.trustd.agent")) (allow file-read* (literal "/private/etc/resolv.conf") (subpath "/private/var/run") (subpath "/System/Library/Security") (subpath "/Library/Keychains"))'
    : ''
  return `(version 1) (deny default) (allow process-fork) (allow signal (target same-sandbox)) (allow process-info* (target same-sandbox)) (allow process-exec ${execTargets.join(' ')}) (allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name-prefix "kern.") (sysctl-name-prefix "machdep.")) (allow file-read-metadata ${metadata}) (allow file-read-data (literal "/")) (allow file-read* ${readTargets.join(' ')}) (allow file-write* ${writeTargets.join(' ')})${networkRules}`
}

export async function verifyMacosSandboxExec(
  sandboxExecPath = DEFAULT_MACOS_SANDBOX_EXEC,
  adapter?: MacosSeatbeltAdapter,
): Promise<boolean> {
  if (!isSafeExecPath(sandboxExecPath)) return false
  if (adapter?.verifySandboxExec) return await adapter.verifySandboxExec(sandboxExecPath)
  try {
    if (await realpath(sandboxExecPath) !== sandboxExecPath) return false
    const info = await lstat(sandboxExecPath)
    if (!info.isFile() || info.isSymbolicLink()) return false
    await access(sandboxExecPath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function buildScrubbedMacosEnv(input: {
  workspacePath: string
  tmpPath: string
  allowNetwork?: boolean
  env?: Readonly<Record<string, string>>
  readOnlyRoots?: readonly string[]
}): Record<string, string> {
  const defaultPathParts = ['/usr/bin', '/bin']
  for (const root of input.readOnlyRoots ?? []) {
    if (root.endsWith('/bin') && !defaultPathParts.includes(root)) defaultPathParts.unshift(root)
  }
  const result: Record<string, string> = {
    PATH: defaultPathParts.join(':'),
    LANG: 'C',
    LC_ALL: 'C',
    HOME: input.workspacePath,
    TMPDIR: input.tmpPath,
  }
  if (input.env) {
    for (const [key, value] of Object.entries(input.env)) {
      if (key.length === 0 || key.includes('=') || key.includes('\0')) continue
      if (typeof value !== 'string' || value.includes('\0')) continue
      const upper = key.toUpperCase()
      if (FORBIDDEN_ENV_KEYS.has(upper) || upper.startsWith('DYLD_') || upper.startsWith('LD_')) continue
      if (!input.allowNetwork && PROXY_ENV_KEYS.has(upper)) continue
      result[key] = value
    }
  }
  return result
}

async function privateDirOk(path: string, platform: NodeJS.Platform, uid: number): Promise<boolean> {
  if (!canonicalAbsolutePath(path, 'darwin')) return false
  try {
    if (await realpath(path) !== path) return false
    const info = await lstat(path)
    return isPrivateDirectoryStats(info, platform === 'darwin' ? 'darwin' : 'linux', uid, 0o700)
  } catch {
    return false
  }
}

export async function runMacosSeatbeltCommand(
  input: MacosSeatbeltCommandInput,
  adapter?: MacosSeatbeltAdapter,
): Promise<MacosSeatbeltCommandResult> {
  const platform = adapter?.platform ?? process.platform
  const uid = adapter?.uid ?? process.getuid?.()
  if (platform !== 'darwin' || typeof uid !== 'number' || uid <= 0) {
    return failure('non-root-macos-required')
  }
  if (!input || typeof input.signal?.aborted !== 'boolean' || typeof input.signal.addEventListener !== 'function') {
    return failure('invalid-input-or-signal')
  }
  const hasCommand = typeof input.command === 'string' && input.command.length > 0 && !input.command.includes('\0')
  const hasArgv = Array.isArray(input.argv) && input.argv.length > 0 && input.argv.every(arg => typeof arg === 'string' && !arg.includes('\0'))
  if (!hasCommand && !hasArgv) return failure('invalid-command')
  if (input.workspaceWritable !== undefined && typeof input.workspaceWritable !== 'boolean') return failure('invalid-workspace-writable')
  if (input.allowNetwork !== undefined && typeof input.allowNetwork !== 'boolean') return failure('invalid-network-flag')

  const sandboxExec = adapter?.sandboxExecPath ?? input.sandboxExecPath ?? DEFAULT_MACOS_SANDBOX_EXEC
  if (!await verifyMacosSandboxExec(sandboxExec, adapter)) return failure('sandbox-exec-unavailable')

  const fsUid = adapter && process.platform !== 'darwin' ? (process.getuid?.() ?? uid) : uid
  if (!await privateDirOk(input.workspacePath, platform, fsUid) || !await safeWorkspaceTree(input.workspacePath)) {
    return failure('invalid-private-workspace')
  }
  if (!await privateDirOk(input.tmpPath, platform, fsUid) || !await safeWorkspaceTree(input.tmpPath)) {
    return failure('invalid-private-tmp')
  }

  const home = await realpath(homedir()).catch(() => '')
  const readOnlyRoots = input.readOnlyRoots ?? []
  if (!Array.isArray(readOnlyRoots) || readOnlyRoots.length > 32) return failure('invalid-read-only-roots')
  for (const root of readOnlyRoots) {
    if (!canonicalAbsolutePath(root, 'darwin')) return failure('invalid-read-only-roots')
    if (root === '/' || root === '/Users' || root === '/private' || root === '/System' || root === '/usr'
      || (home && (root === home || home.startsWith(root + sep)))
      || isPathWithinOrEqual(input.workspacePath, root, 'darwin') || isPathWithinOrEqual(root, input.workspacePath, 'darwin')
      || isPathWithinOrEqual(input.tmpPath, root, 'darwin') || isPathWithinOrEqual(root, input.tmpPath, 'darwin')) {
      return failure('overbroad-read-only-root')
    }
  }
  const writablePaths = input.writablePaths ?? []
  if (!Array.isArray(writablePaths) || writablePaths.length > 32) return failure('invalid-writable-paths')
  for (const target of writablePaths) {
    if (!canonicalAbsolutePath(target, 'darwin') || hasAsciiControlChar(target)) return failure('invalid-writable-paths')
    if (isOverbroadMacosWritablePath(target, home)) {
      return failure('overbroad-writable-path')
    }
  }
  const executablePaths = input.executablePaths ?? []
  if (!Array.isArray(executablePaths) || executablePaths.length > 16 || executablePaths.some(p => !isSafeExecPath(p))) {
    return failure('invalid-executable-paths')
  }

  const maxStdin = input.maxStdinBytes ?? MAX_STDIN
  if (input.stdin !== undefined && (typeof input.stdin !== 'string' || Buffer.byteLength(input.stdin) > maxStdin)) {
    return failure('invalid-stdin')
  }
  if (!Number.isSafeInteger(input.deadline) || input.deadline <= Date.now() || input.deadline - Date.now() > MAX_DURATION) {
    return failure('invalid-deadline')
  }
  if (!Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1 || input.maxOutputBytes > MAX_OUTPUT) {
    return failure('invalid-output-limit')
  }
  if (input.signal.aborted) return { status: 'cancelled', quiescent: true, stdout: '', stderr: '', artifacts: [], reason: 'aborted-before-spawn' }
  if (Date.now() >= input.deadline) return failure('deadline-expired-before-spawn')

  const policy = buildMacosSeatbeltCommandProfile({
    workspacePath: input.workspacePath,
    tmpPath: input.tmpPath,
    readOnlyRoots,
    writablePaths,
    executablePaths,
    workspaceWritable: input.workspaceWritable ?? false,
    allowNetwork: input.allowNetwork === true,
  })
  const env = buildScrubbedMacosEnv({
    workspacePath: input.workspacePath,
    tmpPath: input.tmpPath,
    allowNetwork: input.allowNetwork === true,
    ...(input.env !== undefined ? { env: input.env } : {}),
    readOnlyRoots,
  })
  const argv = hasArgv ? [...input.argv!] : ['/bin/sh', '-c', input.command!]

  if (adapter?.runCommand) {
    const delegated = await adapter.runCommand({ ...input, argv, env, readOnlyRoots, writablePaths, executablePaths }, policy)
    if (delegated.status === 'succeeded' && delegated.quiescent && input.artifacts && input.artifacts.length > 0 && delegated.artifacts.length === 0) {
      try {
        const artifacts = await collectSafeArtifacts(input.workspacePath, input.artifacts, input.maxArtifactBytes ?? 1_048_576, 'darwin')
        return { ...delegated, artifacts }
      } catch (error) {
        return {
          status: 'failed',
          quiescent: true,
          stdout: delegated.stdout,
          stderr: delegated.stderr,
          artifacts: [],
          ...(delegated.exitCode !== undefined ? { exitCode: delegated.exitCode } : {}),
          reason: error instanceof Error ? error.message : 'artifact-export-failed',
        }
      }
    }
    return delegated
  }

  const spawnImpl = adapter?.spawn ?? spawn
  const killGroup = adapter?.killProcessGroup ?? ((pid: number, sig: NodeJS.Signals) => {
    try { process.kill(-pid, sig) } catch { try { process.kill(pid, sig) } catch {} }
  })

  const rawResult = await new Promise<MacosSeatbeltCommandResult>(resolveResult => {
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let reason: MacosSeatbeltCommandResult['status'] | undefined
    let spawnError: string | undefined
    let settled = false
    let grace: NodeJS.Timeout | undefined

    const captured = () => {
      const out = decodeOutput(stdout)
      const err = decodeOutput(stderr)
      return { stdout: out ?? '', stderr: err ?? '', invalid: out === undefined || err === undefined }
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawnImpl(sandboxExec, ['-p', policy, ...argv], {
        cwd: input.workspacePath,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        windowsHide: true,
      })
    } catch {
      resolveResult(failure('sandbox-spawn-failed'))
      return
    }

    const settle = (result: MacosSeatbeltCommandResult): void => {
      if (settled) return
      settled = true
      clearTimeout(deadlineTimer)
      if (grace) clearTimeout(grace)
      input.signal.removeEventListener('abort', abort)
      resolveResult(result)
    }

    const stop = (why: MacosSeatbeltCommandResult['status']): void => {
      if (reason || settled) return
      reason = why
      if (child.pid !== undefined) killGroup(child.pid, 'SIGKILL')
      else child.kill('SIGKILL')
      grace = setTimeout(() => {
        child.stdin?.destroy()
        child.stdout?.destroy()
        child.stderr?.destroy()
        child.unref?.()
        const output = captured()
        settle({
          status: 'unknown',
          quiescent: false,
          stdout: output.stdout,
          stderr: output.stderr,
          artifacts: [],
          ...(child.pid !== undefined ? { pid: child.pid } : {}),
          reason: `${why}-close-unconfirmed`,
        })
      }, CLOSE_GRACE_MS)
    }

    const deadlineTimer = setTimeout(() => stop('timed-out'), Math.max(1, input.deadline - Date.now()))
    const abort = (): void => stop('cancelled')
    input.signal.addEventListener('abort', abort, { once: true })
    if (input.signal.aborted) stop('cancelled')

    const collect = (which: 'stdout' | 'stderr', chunk: Buffer): void => {
      const current = stdout.length + stderr.length
      const remaining = Math.max(0, input.maxOutputBytes - current)
      if (which === 'stdout') stdout = Buffer.concat([stdout, chunk.subarray(0, remaining)])
      else stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)])
      if (chunk.length > remaining) stop('output-limit')
    }

    child.stdout?.on('data', (chunk: Buffer) => collect('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer) => collect('stderr', chunk))
    child.on('error', error => { spawnError = error.message })
    child.on('close', (code, sig) => {
      const output = captured()
      const status = reason ?? (output.invalid || spawnError || code !== 0 ? 'failed' : 'succeeded')
      settle({
        status,
        quiescent: true,
        stdout: output.stdout,
        stderr: output.stderr,
        artifacts: [],
        ...(code !== null ? { exitCode: code } : {}),
        ...(child.pid !== undefined ? { pid: child.pid } : {}),
        ...((output.invalid || spawnError || sig) ? { reason: output.invalid ? 'invalid-utf8-output' : spawnError ?? `signal:${sig}` } : {}),
      })
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(input.stdin ?? '')
  })

  if (rawResult.status === 'succeeded' && rawResult.quiescent && input.artifacts && input.artifacts.length > 0) {
    try {
      const artifacts = await collectSafeArtifacts(input.workspacePath, input.artifacts, input.maxArtifactBytes ?? 1_048_576, 'darwin')
      return { ...rawResult, artifacts }
    } catch (error) {
      return {
        status: 'failed',
        quiescent: true,
        stdout: rawResult.stdout,
        stderr: rawResult.stderr,
        artifacts: [],
        ...(rawResult.exitCode !== undefined ? { exitCode: rawResult.exitCode } : {}),
        reason: error instanceof Error ? error.message : 'artifact-export-failed',
      }
    }
  }
  return rawResult
}
