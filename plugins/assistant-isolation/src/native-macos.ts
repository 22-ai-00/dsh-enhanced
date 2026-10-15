import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** A deliberately single-process, offline macOS candidate runner. The caller owns admission and staging. */
export interface NativeMacProcessInput {
  /** Canonical, owner-private 0700 directory created for this invocation. */
  workspacePath: string
  /** Canonical Node executable and its previously approved SHA-256 receipt. */
  nodePath: string
  nodeSha256: string
  /** Explicit, canonical, read-only runtime roots (for example Homebrew's Node Cellar dependencies). */
  runtimeReadRoots: NativeMacReadRoot[]
  /** Disabled by default; enable only for a candidate that must write scratch files. */
  workspaceWritable?: boolean
  source: string
  stdin?: string
  deadline: number
  maxOutputBytes: number
  signal: AbortSignal
}

export interface NativeMacReadRoot {
  path: string
  /** Device and inode observed when the trusted Host approved this read root. */
  dev: number
  ino: number
}

export interface NativeMacProcessResult {
  status: 'succeeded' | 'failed' | 'cancelled' | 'timed-out' | 'output-limit' | 'unknown'
  quiescent: boolean
  stdout: string
  stderr: string
  exitCode?: number
  reason?: string
  pid?: number
}

const SANDBOX = '/usr/bin/sandbox-exec'
const MAX_SOURCE = 65_536
const MAX_STDIN = 1_048_576
const MAX_OUTPUT = 1_048_576
const MAX_DURATION = 300_000
const CLOSE_GRACE_MS = 3_000

function decodeOutput(bytes: Buffer): string | undefined {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return undefined }
}

function failure(reason: string): NativeMacProcessResult {
  return { status: 'failed', quiescent: true, stdout: '', stderr: '', reason }
}

function quote(value: string): string { return JSON.stringify(value) }

async function canonical(path: string, directory: boolean): Promise<boolean> {
  if (typeof path !== 'string' || !isAbsolute(path) || path !== resolve(path) || path.includes('\0') || path.includes('\n')) return false
  try {
    if (await realpath(path) !== path) return false
    const info = await lstat(path)
    return directory ? info.isDirectory() : info.isFile()
  } catch { return false }
}

async function privateWorkspace(path: string): Promise<boolean> {
  if (!await canonical(path, true)) return false
  try {
    const info = await lstat(path)
    return typeof process.getuid === 'function' && info.uid === process.getuid() && (info.mode & 0o777) === 0o700
  } catch { return false }
}

async function safeWorkspaceTree(path: string): Promise<boolean> {
  let seen = 0
  const visit = async (directory: string): Promise<boolean> => {
    for (const name of await readdir(directory)) {
      if (++seen > 4096) return false
      const entry = join(directory, name)
      const info = await lstat(entry)
      if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1) || (!info.isDirectory() && !info.isFile())) return false
      if (info.isDirectory() && !await visit(entry)) return false
    }
    return true
  }
  try { return await visit(path) } catch { return false }
}

function profile(workspace: string, node: string, readRoots: string[], writable: boolean): string {
  // Node ESM realpath needs metadata for each strict path ancestor. macOS Node
  // startup also requires root directory data; this exposes only top-level names.
  const ancestors = new Set<string>()
  for (const path of [workspace, node, ...readRoots, '/usr/lib', '/System/Library']) {
    for (let parent = dirname(path); ; parent = dirname(parent)) {
      ancestors.add(parent)
      if (parent === '/') break
    }
  }
  const metadata = [...ancestors].sort().map(path => `(literal ${quote(path)})`).join(' ')
  const roots = ['(subpath "/usr/lib")', '(subpath "/System/Library")',
    '(literal "/dev/null")', '(literal "/dev/urandom")', ...readRoots.map(root => `(subpath ${quote(root)})`)]
  return `(version 1) (deny default) (allow process-exec (literal ${quote(node)})) (allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name "kern.version" "kern.ostype" "kern.osrelease" "kern.hostname")) (allow file-read-metadata ${metadata}) (allow file-read-data (literal "/")) (allow file-read* ${roots.join(' ')} (subpath ${quote(workspace)}))${writable ? ` (allow file-write* (subpath ${quote(workspace)}))` : ''}`
}

/** No shell, inherited environment, network, child process, or unconstrained fallback. */
export async function runNativeMacProcess(input: NativeMacProcessInput): Promise<NativeMacProcessResult> {
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function' || process.getuid() === 0) return failure('non-root-macos-required')
  if (!input || typeof input.signal?.aborted !== 'boolean' || typeof input.signal.addEventListener !== 'function') return failure('invalid-input-or-signal')
  if (input.workspaceWritable !== undefined && typeof input.workspaceWritable !== 'boolean') return failure('invalid-workspace-writable')
  if (!await canonical(SANDBOX, false) || !await access(SANDBOX, constants.X_OK).then(() => true, () => false)) return failure('sandbox-exec-unavailable')
  if (!await privateWorkspace(input.workspacePath)) return failure('invalid-private-workspace')
  if (!await safeWorkspaceTree(input.workspacePath)) return failure('unsafe-workspace-tree')
  if (!await canonical(input.nodePath, false) || !await access(input.nodePath, constants.X_OK).then(() => true, () => false)) return failure('invalid-node-executable')
  if (!Array.isArray(input.runtimeReadRoots) || input.runtimeReadRoots.length > 32 || !await Promise.all(input.runtimeReadRoots.map(async root => {
    try {
      if (!root || typeof root.path !== 'string' || !Number.isSafeInteger(root.dev) || !Number.isSafeInteger(root.ino) || !await canonical(root.path, true)) return false
      const info = await lstat(root.path)
      return info.dev === root.dev && info.ino === root.ino && (info.mode & 0o022) === 0
    } catch { return false }
  })).then(values => values.every(Boolean))) return failure('invalid-runtime-read-roots')
  const home = await realpath(homedir()).catch(() => '')
  if (!home) return failure('home-unavailable')
  if (input.runtimeReadRoots.some(({ path: root }) => root === '/' || root === '/Users' || root === '/private' || root === '/System' || root === '/usr'
    || root === home || home.startsWith(root + sep)
    || root === input.workspacePath || root.startsWith(input.workspacePath + sep) || input.workspacePath.startsWith(root + sep))) return failure('overbroad-runtime-read-root')
  if (typeof input.nodeSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.nodeSha256)) return failure('invalid-node-receipt')
  const bytes = await readFile(input.nodePath).catch(() => undefined)
  if (!bytes) return failure('node-receipt-unreadable')
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== input.nodeSha256) return failure('node-receipt-mismatch')
  if (typeof input.source !== 'string' || input.source.length === 0 || input.source.includes('\0') || Buffer.byteLength(input.source) > MAX_SOURCE) return failure('invalid-source')
  if (typeof input.stdin !== 'undefined' && (typeof input.stdin !== 'string' || Buffer.byteLength(input.stdin) > MAX_STDIN)) return failure('invalid-stdin')
  if (!Number.isSafeInteger(input.deadline) || input.deadline <= Date.now() || input.deadline - Date.now() > MAX_DURATION) return failure('invalid-deadline')
  if (!Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1 || input.maxOutputBytes > MAX_OUTPUT) return failure('invalid-output-limit')
  if (input.signal.aborted) return { status: 'cancelled', quiescent: true, stdout: '', stderr: '', reason: 'aborted-before-spawn' }
  if (Date.now() >= input.deadline) return failure('deadline-expired-before-spawn')

  // Node must be loaded from a permitted read root. Ancestor metadata alone cannot load it.
  if (!input.runtimeReadRoots.some(root => input.nodePath.startsWith(root.path + sep))) return failure('node-outside-runtime-read-roots')
  const policy = profile(input.workspacePath, input.nodePath, input.runtimeReadRoots.map(root => root.path), input.workspaceWritable === true)
  return await new Promise<NativeMacProcessResult>(resolveResult => {
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let reason: NativeMacProcessResult['status'] | undefined
    let spawnError: string | undefined
    let settled = false
    let grace: NodeJS.Timeout | undefined
    const captured = (): { stdout: string; stderr: string; invalid: boolean } => {
      const out = decodeOutput(stdout)
      const err = decodeOutput(stderr)
      return { stdout: out ?? '', stderr: err ?? '', invalid: out === undefined || err === undefined }
    }
    let child
    try {
      child = spawn(SANDBOX, ['-p', policy, input.nodePath, '--no-warnings', '-e', input.source], {
        cwd: input.workspacePath,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: input.workspacePath, TMPDIR: input.workspacePath },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
        windowsHide: true,
      })
    } catch { resolveResult(failure('sandbox-spawn-failed')); return }
    const settle = (result: NativeMacProcessResult): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (grace) clearTimeout(grace)
      input.signal.removeEventListener('abort', abort)
      resolveResult(result)
    }
    const stop = (why: NativeMacProcessResult['status']): void => {
      if (reason || settled) return
      reason = why
      child.kill('SIGKILL')
      grace = setTimeout(() => {
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref()
        const output = captured()
        settle({ status: 'unknown', quiescent: false, stdout: output.stdout, stderr: output.stderr,
          ...(child.pid !== undefined ? { pid: child.pid } : {}), reason: `${why}-close-unconfirmed` })
      }, CLOSE_GRACE_MS)
    }
    const deadline = setTimeout(() => stop('timed-out'), Math.max(1, input.deadline - Date.now()))
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
    child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk))
    child.on('error', error => { spawnError = error.message })
    child.on('close', (code, signal) => {
      const output = captured()
      const status = reason ?? (output.invalid || spawnError || code !== 0 ? 'failed' : 'succeeded')
      settle({ status, quiescent: true, stdout: output.stdout, stderr: output.stderr,
        ...(code !== null ? { exitCode: code } : {}),
        ...(child.pid !== undefined ? { pid: child.pid } : {}),
        ...((output.invalid || spawnError || signal) ? { reason: output.invalid ? 'invalid-utf8-output' : spawnError ?? `signal:${signal}` } : {}) })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input.stdin ?? '')
  })
}
