import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'

const WORKER = fileURLToPath(new URL('../runtime/linux-namespace-worker.mjs', import.meta.url))
const CONTROL = /[\p{Cc}]/u
const NAMESPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[0-9a-f]{32}$/iu
const MAX_INPUT_BYTES = 1_048_576
// JSON can expand each valid control character to six ASCII bytes. Both the
// output and total artifacts may independently contain 1 MiB of such text.
const MAX_PROTOCOL_BYTES = 13 * 1024 * 1024
const CLEANUP_TIMEOUT_MS = 5_000

export interface LinuxCandidateIdentity { pid: number; startTicks: number }
export interface LinuxCandidateExit extends LinuxCandidateIdentity {
  code: number | null
  signal: string | null
  exceeded: boolean
}
export interface LinuxNamespaceInput {
  stateRoot: string
  /** Durable caller identity, used only for the fresh namespace directory. */
  namespaceId?: string
  argv: readonly string[]
  files: readonly { path: string; content: string }[]
  artifacts?: readonly string[]
  readOnlyRoots?: readonly string[]
  workspaceBytes: number
  workspaceInodes: number
  tmpBytes: number
  tmpInodes: number
  timeoutMs: number
  maxOutputBytes: number
  maxArtifactBytes?: number
  /** Repository checks must retain nested bwrap; other tasks forbid it. */
  profile: 'ordinary' | 'repository'
  signal: AbortSignal
  /** Admit the fixed keeper gate PID before unshare, mounts, or staging. */
  beforeKeeperStart: (identity: LinuxCandidateIdentity) => Promise<void> | void
  /** Admit this gate PID to an externally bounded cgroup before START. */
  beforeStart: (identity: LinuxCandidateIdentity) => Promise<void> | void
  /** Prove the entire cgroup is quiet before the trusted keeper exports files. */
  afterExit: (exit: LinuxCandidateExit) => Promise<void> | void
  /** Revoke and reconcile the group after timeout, abort, or protocol failure. */
  onStop: (identity?: LinuxCandidateIdentity) => Promise<void> | void
}
export interface LinuxNamespaceResult {
  status: 'succeeded' | 'failed' | 'timed-out' | 'cancelled' | 'unknown'
  namespaceExited: boolean
  exitCode?: number
  stdout: string
  stderr: string
  artifacts: { path: string; content: string }[]
  reason?: string
}

function fail(message: string): never { throw new Error(`linux namespace: ${message}`) }
function canonical(path: string): boolean { return isAbsolute(path) && resolve(path) === path
  && !path.includes('\0') && !path.includes('\r') && !path.includes('\n') }
function integer(value: number, min: number, max: number): boolean { return Number.isSafeInteger(value) && value >= min && value <= max }
function safePath(path: string): boolean {
  return typeof path === 'string' && path.length > 0 && path.length <= 4096
    && !isAbsolute(path) && !path.includes('\\') && !CONTROL.test(path)
    && path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')
}
async function privateDirectory(path: string): Promise<void> {
  if (!canonical(path) || await realpath(path) !== path) fail('state root is not canonical')
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    fail('state root must be owner-private')
  }
}
async function validate(input: LinuxNamespaceInput): Promise<void> {
  if (process.platform !== 'linux' || process.getuid?.() === 0) fail('requires non-root Linux')
  await privateDirectory(input.stateRoot)
  for (const source of ['/usr', '/lib', '/lib64']) {
    const system = await realpath(source).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (system && (input.stateRoot === system || input.stateRoot.startsWith(system + sep)
      || system.startsWith(input.stateRoot + sep))) fail('state root overlaps exposed system files')
  }
  if (input.namespaceId !== undefined && (typeof input.namespaceId !== 'string' || !NAMESPACE_ID.test(input.namespaceId))) fail('invalid namespace id')
  if (input.profile !== 'ordinary' && input.profile !== 'repository') fail('invalid profile')
  if (!Array.isArray(input.argv) || input.argv.length < 1 || input.argv.length > 64
    || !input.argv.every((arg, i) => typeof arg === 'string' && arg.length <= 65_536
      && !arg.includes('\0') && (i !== 0 || canonical(arg)))) fail('invalid command')
  if (!integer(input.workspaceBytes, 4096, 4 * 1024 ** 3) || input.workspaceBytes % 4096 !== 0
    || !integer(input.tmpBytes, 4096, 2 * 1024 ** 3) || input.tmpBytes % 4096 !== 0
    || !integer(input.workspaceInodes, 16, 1_000_000) || !integer(input.tmpInodes, 16, 1_000_000)
    || !integer(input.maxArtifactBytes ?? MAX_INPUT_BYTES, 1, MAX_INPUT_BYTES)
    || !integer(input.timeoutMs, 1, 1_800_000) || !integer(input.maxOutputBytes, 1, 1_048_576)) fail('invalid limits')
  if (!Array.isArray(input.files) || input.files.length > 128 || !Array.isArray(input.artifacts ?? [])
    || (input.artifacts?.length ?? 0) > 128) fail('invalid files or artifacts')
  const names = new Set<string>()
  let bytes = 0
  for (const file of input.files) {
    if (!file || !safePath(file.path) || names.has(file.path) || typeof file.content !== 'string'
      || !file.content.isWellFormed()) fail('invalid input file')
    names.add(file.path)
    bytes += Buffer.byteLength(file.content)
  }
  if (bytes > MAX_INPUT_BYTES || [...names].some(name => [...names].some(other => other !== name && other.startsWith(`${name}/`)))) {
    fail('input files exceed bounds or collide')
  }
  if ((input.artifacts ?? []).some(path => !safePath(path))
    || new Set(input.artifacts ?? []).size !== (input.artifacts ?? []).length) fail('invalid artifact path')
  if (!Array.isArray(input.readOnlyRoots ?? []) || (input.readOnlyRoots?.length ?? 0) > 16) fail('invalid runtime roots')
  for (const root of input.readOnlyRoots ?? []) {
    if (!canonical(root) || root === '/' || await realpath(root) !== root) fail('unsafe runtime root')
    const info = await lstat(root)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()
      || (info.mode & 0o022) !== 0 || root === input.stateRoot || root.startsWith(input.stateRoot + sep)
      || input.stateRoot.startsWith(root + sep)) fail('unsafe runtime root')
  }
  if (input.signal.aborted || typeof input.beforeKeeperStart !== 'function' || typeof input.beforeStart !== 'function'
    || typeof input.afterExit !== 'function' || typeof input.onStop !== 'function') fail('missing admission or cleanup')
}

interface Message { type: string; [key: string]: unknown }
function identity(value: Message): LinuxCandidateIdentity {
  if (!integer(value.pid as number, 1, Number.MAX_SAFE_INTEGER)
    || !integer(value.startTicks as number, 1, Number.MAX_SAFE_INTEGER)) fail('invalid candidate identity')
  return { pid: value.pid as number, startTicks: value.startTicks as number }
}

/** A process primitive. The caller's afterExit/onStop implement cgroup proof. */
export async function runLinuxNamespace(input: LinuxNamespaceInput): Promise<LinuxNamespaceResult> {
  await validate(input)
  const jobPath = join(input.stateRoot, `namespace-${input.namespaceId ?? randomUUID()}`)
  await mkdir(jobPath, { mode: 0o700 })
  const config = { schemaVersion: 1, jobPath, argv: input.argv, files: input.files,
    artifacts: input.artifacts ?? [], readOnlyRoots: input.readOnlyRoots ?? [],
    workspaceBytes: input.workspaceBytes, workspaceInodes: input.workspaceInodes,
    tmpBytes: input.tmpBytes, tmpInodes: input.tmpInodes,
    maxOutputBytes: input.maxOutputBytes, maxArtifactBytes: input.maxArtifactBytes ?? MAX_INPUT_BYTES, profile: input.profile, deadline: Date.now() + input.timeoutMs }
  const encoded = JSON.stringify(config)
  if (Buffer.byteLength(encoded) > MAX_INPUT_BYTES + 300_000) {
    await rm(jobPath, { recursive: true, force: true })
    fail('request exceeds bound')
  }
  // The fixed shell owns this PID until exec. No namespace or worker exists
  // until the caller durably admits its exact host identity through fd 3.
  const child = spawn('/bin/sh', ['-c',
    'IFS= read -r gate <&3 || exit 125; [ "$gate" = START ] || exit 125; exec 3<&-; exec "$@"',
    'dsh-keeper-gate', '/usr/bin/unshare', '--user', '--map-root-user', '--mount', '--fork',
    '--kill-child=SIGKILL', '--net', '--ipc', '--uts', process.execPath, WORKER], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'], shell: false, detached: true,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  })
  const messages: Message[] = []
  const waiters: Array<(message: Message) => void> = []
  let raw = ''; let totalBytes = 0; let diagnostic = ''; let stopped = false; let completed = false
  let reason: 'timed-out' | 'cancelled' | 'unknown' = 'unknown'
  let candidate: LinuxCandidateIdentity | undefined
  let cleanup: Promise<void> | undefined
  let cleanupError: Error | undefined
  let signalStop: () => void = () => {}
  const stopNotice = new Promise<void>(resolveStop => { signalStop = resolveStop })
  const stop = (why: typeof reason): void => {
    if (stopped) return
    reason = why; stopped = true
    signalStop()
    cleanup = new Promise<void>(resolveCleanup => {
      let settled = false
      const finish = (cause?: unknown): void => {
        if (settled) return
        settled = true
        clearTimeout(cleanupTimer)
        if (cause !== undefined) cleanupError = cause instanceof Error ? cause : new Error('cleanup failed')
        resolveCleanup()
      }
      const cleanupTimer = setTimeout(() => finish(new Error('cgroup cleanup exceeded deadline')), CLEANUP_TIMEOUT_MS)
      void Promise.resolve().then(() => input.onStop(candidate)).then(() => finish(), finish)
    })
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
    child.kill('SIGKILL')
  }
  const timer = setTimeout(() => stop('timed-out'), input.timeoutMs)
  // A worker can disappear between protocol observation and write(). Writable
  // errors are independent of ChildProcess 'error' and must revoke the job.
  child.stdin?.on('error', () => stop('unknown'))
  const keeperGate = child.stdio[3] as import('node:stream').Writable | null
  keeperGate?.on('error', () => stop('unknown'))
  const abort = (): void => stop('cancelled')
  input.signal.addEventListener('abort', abort, { once: true })
  if (input.signal.aborted) abort()
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>(resolveDone => {
    child.once('error', error => resolveDone({ code: null, signal: null, error }))
    child.once('close', (code, signal) => { completed = true; resolveDone({ code, signal }) })
  })
  let boundedClosure: Promise<void> | undefined
  const waitForClosure = (): Promise<void> => boundedClosure ??= new Promise(resolveClosure => {
    const deadline = setTimeout(resolveClosure, CLEANUP_TIMEOUT_MS)
    void closed.then(() => { clearTimeout(deadline); resolveClosure() })
  })
  const interrupted = (): Promise<never> => stopNotice.then(() => fail('execution stopped'))
  const decoder = new StringDecoder('utf8')
  child.stdout?.on('data', (chunk: Buffer) => {
    totalBytes += chunk.length
    if (totalBytes > MAX_PROTOCOL_BYTES) { stop('unknown'); return }
    raw += decoder.write(chunk)
    for (;;) {
      const end = raw.indexOf('\n')
      if (end < 0) break
      const line = raw.slice(0, end)
      raw = raw.slice(end + 1)
      let message: Message
      try { message = JSON.parse(line) as Message } catch { stop('unknown'); return }
      if (!message || typeof message.type !== 'string') { stop('unknown'); return }
      const waiter = waiters.shift()
      if (waiter) waiter(message)
      else messages.push(message)
    }
  })
  child.stderr?.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-4096) })
  const next = async (): Promise<Message> => {
    if (messages.length) return messages.shift()!
    return await Promise.race([new Promise<Message>(resolveNext => waiters.push(resolveNext)),
      closed.then(() => fail('worker exited before protocol completed')), interrupted()])
  }
  const send = (message: string): void => {
    if (!stopped) child.stdin?.write(message + '\n')
  }
  try {
    send(encoded)
    if (!child.pid) fail('keeper gate did not start')
    const stat = await readFile(`/proc/${child.pid}/stat`, 'utf8')
    const keeper = identity({ type: 'KEEPER', pid: child.pid,
      startTicks: Number(stat.slice(stat.lastIndexOf(')') + 2).trim().split(' ')[19]) })
    if (stopped) fail('keeper stopped before admission')
    await Promise.race([Promise.resolve().then(() => input.beforeKeeperStart(keeper)),
      closed.then(() => fail('keeper exited during admission')), interrupted()])
    if (stopped) fail('keeper stopped during admission')
    keeperGate?.end('START\n')
    const ready = await next()
    if (ready.type !== 'READY') fail('worker failed before candidate gate')
    candidate = identity(ready)
    await Promise.race([Promise.resolve().then(() => input.beforeStart(candidate!)),
      closed.then(() => fail('worker exited during admission')), interrupted()])
    if (stopped) fail('worker stopped during admission')
    send('START')
    const exited = await next()
    if (exited.type !== 'EXIT' || exited.pid !== candidate.pid || exited.startTicks !== candidate.startTicks
      || !(exited.code === null || integer(exited.code as number, 0, 255))
      || !(exited.signal === null || typeof exited.signal === 'string')
      || typeof exited.exceeded !== 'boolean') fail('invalid candidate exit')
    await Promise.race([Promise.resolve().then(() => input.afterExit(exited as unknown as LinuxCandidateExit)),
      closed.then(() => fail('worker exited before cgroup proof')), interrupted()])
    if (stopped) fail('worker stopped before artifact export')
    send('EXPORT')
    const result = await next()
    if (result.type !== 'RESULT' || !['succeeded', 'failed'].includes(result.status as string)
      || !Array.isArray(result.artifacts) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string'
      || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > input.maxOutputBytes
      || result.artifacts.length !== (input.artifacts?.length ?? 0)
      || new Set(result.artifacts.map(file => file?.path)).size !== result.artifacts.length
      || result.artifacts.some(file => !file || !safePath(file.path) || !(input.artifacts ?? []).includes(file.path)
        || typeof file.content !== 'string' || !file.content.isWellFormed())
      || result.artifacts.reduce((bytes, file) => bytes + Buffer.byteLength(file.content), 0) > (input.maxArtifactBytes ?? MAX_INPUT_BYTES)) {
      fail('worker result violates bounds')
    }
    child.stdin?.end()
    const done = await Promise.race([closed, interrupted()])
    if (done.code !== 0 || stopped || raw !== '') fail('worker did not exit cleanly')
    return { status: result.status as LinuxNamespaceResult['status'], namespaceExited: true,
      ...(typeof result.exitCode === 'number' ? { exitCode: result.exitCode } : {}),
      stdout: result.stdout, stderr: result.stderr,
      artifacts: result.artifacts as LinuxNamespaceResult['artifacts'],
      ...(typeof result.reason === 'string' ? { reason: result.reason } : {}) }
  } catch (error) {
    if (!stopped) stop('unknown')
    await waitForClosure()
    if (cleanup) await cleanup.catch(cause => {
      cleanupError = cause instanceof Error ? cause : new Error('cleanup failed')
    })
    return { status: cleanupError || !completed ? 'unknown' : reason, namespaceExited: completed,
      stdout: '', stderr: '', artifacts: [],
      reason: `${error instanceof Error ? error.message : diagnostic || 'namespace execution failed'}`
        + (cleanupError ? `; cleanup unproven: ${cleanupError.message}` : '')
        + (!completed ? '; worker termination unproven' : '') }
  } finally {
    clearTimeout(timer)
    input.signal.removeEventListener('abort', abort)
    if (!completed) stop('unknown')
    await waitForClosure()
    if (cleanup) await cleanup.catch(cause => {
      cleanupError = cause instanceof Error ? cause : new Error('cleanup failed')
    })
    if (!cleanupError && completed) await rm(jobPath, { recursive: true, force: true })
  }
}
