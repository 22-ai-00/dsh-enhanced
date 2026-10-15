import { fork, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs'
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IsolationLedger, type IsolationControllerAuthority } from './ledger.js'
import { validateNativeMacRuntime, verifyNativeMacRuntime, nativeMacRuntimeDigest, type NativeMacRuntime } from './native-runtime.js'
import { observeStorage } from './storage.js'
import type { IsolationFile, IsolationJob, IsolationResult } from './types.js'

export interface NativeMacVerifierRunnerConfig {
  backend: 'macos-seatbelt'
  stateRoot: string
  authorityDigest: string
  runtime: NativeMacRuntime
  source: string
  expiresAt: number
  maxRuns: number
  maxTotalDurationMs: number
  maxDurationMs: number
  maxOutputBytes: number
}

const SHA = /^[0-9a-f]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const MAX_INPUT = 1_048_576
const MAX_FILES = 128
const MAX_STATE_BYTES = 256 * 1024 * 1024
const MAX_RECORDS = 10_000
const MARKER = 'native-backend'
const supervisor = fileURLToPath(new URL('../runtime/native-macos-supervisor.mjs', import.meta.url))
const unknown = (jobId: string, reason: string): IsolationResult => ({ jobId, status: 'unknown', quiescent: false, stdout: '', stderr: '', artifacts: [], reason })

function validateConfig(input: NativeMacVerifierRunnerConfig): NativeMacVerifierRunnerConfig {
  if (!input || Object.keys(input).sort().join() !== 'authorityDigest,backend,expiresAt,maxDurationMs,maxOutputBytes,maxRuns,maxTotalDurationMs,runtime,source,stateRoot'
    || input.backend !== 'macos-seatbelt' || typeof input.stateRoot !== 'string' || !isAbsolute(input.stateRoot)
    || resolve(input.stateRoot) !== input.stateRoot || input.stateRoot.includes('\0') || input.stateRoot.includes('\n')
    || !SHA.test(input.authorityDigest) || typeof input.source !== 'string' || input.source.length === 0
    || input.source.includes('\0') || Buffer.byteLength(input.source) > 65_536
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt < 1
    || !Number.isSafeInteger(input.maxRuns) || input.maxRuns < 1 || input.maxRuns > 10_000
    || !Number.isSafeInteger(input.maxTotalDurationMs) || input.maxTotalDurationMs < 1 || input.maxTotalDurationMs > 86_400_000
    || !Number.isSafeInteger(input.maxDurationMs) || input.maxDurationMs < 1 || input.maxDurationMs > 300_000
    || input.maxDurationMs > input.maxTotalDurationMs || !Number.isSafeInteger(input.maxOutputBytes)
    || input.maxOutputBytes < 1 || input.maxOutputBytes > 1_048_576) throw new Error('invalid native verifier authority')
  return Object.freeze({ ...input, runtime: validateNativeMacRuntime(input.runtime) })
}

function bindStateRoot(root: string): void {
  const existed = existsSync(root)
  if (!existed) mkdirSync(root, { recursive: true, mode: 0o700 })
  const info = lstatSync(root)
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(root) !== root || info.uid !== process.getuid?.()
    || (info.mode & 0o077) !== 0) throw new Error('native verifier requires canonical private state root')
  if (existsSync(join(root, 'docker-socket-path'))) throw new Error('native state root contains Docker binding')
  const marker = join(root, MARKER)
  const ledger = join(root, 'ledger.sqlite')
  if (existsSync(marker)) {
    const entry = lstatSync(marker)
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.uid !== process.getuid?.()
      || (entry.mode & 0o077) !== 0 || entry.size > 64 || readFileSync(marker, 'utf8') !== 'macos-seatbelt-v1\n' || !existsSync(ledger)) throw new Error('invalid native state binding')
    const database = lstatSync(ledger)
    if (!database.isFile() || database.isSymbolicLink() || database.nlink !== 1 || database.uid !== process.getuid?.()
      || (database.mode & 0o077) !== 0) throw new Error('invalid native ledger')
  } else {
    if (existsSync(ledger)) throw new Error('unbound existing ledger')
    const fd = openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeSync(fd, Buffer.from('macos-seatbelt-v1\n')); fsyncSync(fd) } finally { closeSync(fd) }
    const dir = openSync(root, constants.O_RDONLY)
    try { fsyncSync(dir) } finally { closeSync(dir) }
  }
  chmodSync(root, 0o700)
}

function normalizeFiles(files: IsolationFile[]): IsolationFile[] {
  if (!Array.isArray(files) || files.length > MAX_FILES) throw new Error('invalid native files')
  const output = files.map(file => {
    if (!file || Object.keys(file).sort().join() !== 'content,path' || typeof file.content !== 'string'
      || typeof file.path !== 'string' || file.path.length < 1 || file.path.length > 4096
      || file.path.startsWith('/') || file.path.includes('\\') || /[\p{Cc}]/u.test(file.path)
      || file.path.split('/').some(part => part === '' || part === '.' || part === '..')) throw new Error('invalid native file')
    return { path: file.path, content: file.content }
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'))
  if (output.some((file, i) => i > 0 && (file.path === output[i - 1]!.path || file.path.startsWith(output[i - 1]!.path + '/')))) throw new Error('native file collision')
  return output
}

async function stage(root: string, jobId: string, files: IsolationFile[]): Promise<string> {
  if (!UUID.test(jobId)) throw new Error('invalid native job id')
  const parent = join(root, 'workspaces')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const workspace = join(parent, jobId)
  await mkdir(workspace, { mode: 0o700 })
  for (const file of files) {
    const target = join(workspace, file.path)
    let current = dirname(target)
    const stack: string[] = []
    while (current !== workspace) { stack.unshift(current); current = dirname(current) }
    for (const dir of stack) {
      await mkdir(dir, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
      const info = await lstat(dir)
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error('unsafe native workspace directory')
    }
    await writeFile(target, file.content, { flag: 'wx', mode: 0o600 })
  }
  return workspace
}

interface NativeReceipt {
  schemaVersion: 1
  backend: 'macos-seatbelt'
  jobId: string
  requestDigest: string
  nonce: string
  nativeResourceId: string
  closed: true
  closedAt: number
  result: { status: string; quiescent: true; stdout: string; stderr: string; exitCode?: number; reason?: string; pid?: number }
}

/** Trusted Host-side finite verifier; no model or candidate receives its ledger. */
export class NativeMacVerifierRunner {
  readonly #input: NativeMacVerifierRunnerConfig
  readonly #ledger: IsolationLedger
  readonly #controller: IsolationControllerAuthority
  readonly #ready: Promise<void>
  readonly #abort = new AbortController()
  readonly #pending = new Map<string, Promise<IsolationResult>>()
  readonly #timer: NodeJS.Timeout
  #active = true
  #closePromise: Promise<void> | undefined
  constructor(input: NativeMacVerifierRunnerConfig) {
    this.#input = validateConfig(input)
    if (process.platform !== 'darwin' || process.getuid?.() === 0) throw new Error('native verifier requires non-root macOS')
    if (this.#input.runtime.roots.some(root => this.#input.stateRoot === root.path || this.#input.stateRoot.startsWith(root.path + sep)
      || root.path.startsWith(this.#input.stateRoot + sep))) throw new Error('native state overlaps runtime')
    bindStateRoot(this.#input.stateRoot)
    this.#ledger = new IsolationLedger(join(this.#input.stateRoot, 'ledger.sqlite'))
    try {
      this.#controller = this.#ledger.claimController(randomUUID(), 30_000)
      this.#ledger.syncGrants([{ id: 'verification', revision: 1, principalDigest: this.#input.authorityDigest,
        principalRecordId: `verification:${this.#input.authorityDigest}`, principalVersion: 1,
        workspace: this.#input.stateRoot, agentPreset: 'verification', expiresAt: this.#input.expiresAt,
        maxRuns: this.#input.maxRuns, maxTotalDurationMs: this.#input.maxTotalDurationMs }], this.#controller)
    } catch (error) { this.#ledger.close(); throw error }
    this.#timer = setInterval(() => {
      try { if (this.#ledger.renewController(this.#controller, 30_000)) return } catch {}
      this.#active = false; this.#abort.abort()
    }, 5_000)
    this.#timer.unref()
    this.#ready = this.#recover()
    void this.#ready.catch(() => { this.#active = false; this.#abort.abort() })
  }
  async #receipt(job: IsolationJob): Promise<IsolationResult | undefined> {
    if (job.backend !== 'macos-seatbelt' || !job.dispatchAttempted || !job.nativeNonce || !job.nativeResourceId) return undefined
    const path = join(this.#input.stateRoot, 'receipts', `${job.id}.json`)
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.()
        || (info.mode & 0o077) !== 0 || info.size > 2_000_000) return undefined
      const receipt = JSON.parse(await readFile(path, 'utf8')) as NativeReceipt
      if (receipt.schemaVersion !== 1 || receipt.backend !== 'macos-seatbelt' || receipt.jobId !== job.id
        || receipt.requestDigest !== job.requestDigest || receipt.nonce !== job.nativeNonce
        || receipt.nativeResourceId !== job.nativeResourceId || receipt.closed !== true
        || !Number.isSafeInteger(receipt.closedAt) || receipt.closedAt < job.createdAt
        || !receipt.result || receipt.result.quiescent !== true
        || !['succeeded', 'failed', 'cancelled', 'timed-out', 'output-limit'].includes(receipt.result.status)
        || typeof receipt.result.stdout !== 'string' || typeof receipt.result.stderr !== 'string'
        || Buffer.byteLength(receipt.result.stdout) + Buffer.byteLength(receipt.result.stderr) > this.#input.maxOutputBytes) return undefined
      return { jobId: job.id, status: receipt.result.status === 'output-limit' ? 'failed' : receipt.result.status as IsolationResult['status'],
        quiescent: true, stdout: receipt.result.stdout, stderr: receipt.result.stderr, artifacts: [],
        ...(receipt.result.exitCode === undefined ? {} : { exitCode: receipt.result.exitCode }),
        ...(receipt.result.status === 'output-limit' ? { reason: 'output-limit' }
          : receipt.result.reason === undefined ? {} : { reason: receipt.result.reason }) }
    } catch { return undefined }
  }
  async #settleReceipt(job: IsolationJob): Promise<IsolationResult | undefined> {
    const result = await this.#receipt(job)
    if (!result) return undefined
    if (job.result?.quiescent) return job.result
    const settled = this.#ledger.settleNativeReceipt(job.id, job.version, { requestDigest: job.requestDigest,
      nonce: job.nativeNonce!, nativeResourceId: job.nativeResourceId! }, result, this.#controller)
    return settled.result
  }
  async #recover(): Promise<void> {
    let cursor = ''
    for (;;) {
      const jobs = this.#ledger.recoverable(cursor)
      if (jobs.length === 0) return
      cursor = jobs.at(-1)!.id
      for (const job of jobs) {
        if (job.backend !== 'macos-seatbelt') throw new Error('mixed native state root')
        if (await this.#settleReceipt(job)) continue
        if (job.status === 'prepared' || job.status === 'running') {
          const result: IsolationResult = job.dispatchAttempted ? unknown(job.id, 'native-recovery-no-receipt')
            : { jobId: job.id, status: 'failed', quiescent: true, stdout: '', stderr: '', artifacts: [], reason: 'native-recovery-before-dispatch' }
          this.#ledger.settle(job.id, job.version, result, this.#controller)
        }
      }
    }
  }
  run = async (key: string, files: IsolationFile[], stdin: string, signal: AbortSignal): Promise<IsolationResult> => {
    await this.#ready
    if (!this.#active || signal?.aborted || typeof signal?.addEventListener !== 'function') throw new Error('native verifier unavailable')
    if (typeof key !== 'string' || key.length < 1 || key.length > 256 || /[\p{Cc}]/u.test(key)
      || typeof stdin !== 'string') throw new Error('invalid native verifier input')
    const staged = normalizeFiles(files)
    const bytes = Buffer.byteLength(stdin) + Buffer.byteLength(this.#input.source)
      + staged.reduce((sum, file) => sum + Buffer.byteLength(file.path) + Buffer.byteLength(file.content), 0)
    if (bytes > MAX_INPUT) throw new Error('native verifier input limit')
    const digest = createHash('sha256').update(JSON.stringify({ backend: 'macos-seatbelt', source: this.#input.source,
      runtime: nativeMacRuntimeDigest(this.#input.runtime), authority: this.#input.authorityDigest, files: staged, stdin })).digest('hex')
    const observation = await observeStorage(this.#input.stateRoot)
    if (!observation || !this.#active || signal.aborted) throw new Error('native verifier storage or authority unavailable')
    const { job, created } = this.#ledger.prepare({ backend: 'macos-seatbelt', identity: { principalDigest: this.#input.authorityDigest,
      principalRecordId: `verification:${this.#input.authorityDigest}`, principalVersion: 1, workspace: this.#input.stateRoot,
      agentPreset: 'verification' }, sessionId: `authority:${this.#input.authorityDigest}`, grantId: 'verification',
      idempotencyKey: key, requestDigest: digest, durationMs: this.#input.maxDurationMs,
      maxActiveJobs: 2, authority: this.#controller, storageBudget: { maxStateBytes: MAX_STATE_BYTES,
        maxJobRecords: MAX_RECORDS, reservedBytes: 2 * 1024 * 1024 + 6 * this.#input.maxOutputBytes + MAX_INPUT, observation } })
    if (!created) {
      const pending = this.#pending.get(job.id)
      if (pending) return await pending
      const received = await this.#settleReceipt(job).catch(() => undefined)
      return received ?? job.result ?? unknown(job.id, 'native-in-progress-no-replay')
    }
    const pending = this.#execute(job, staged, stdin, AbortSignal.any([signal, this.#abort.signal]))
    this.#pending.set(job.id, pending)
    try { return await pending } finally { this.#pending.delete(job.id) }
  }
  async #execute(initial: IsolationJob, files: IsolationFile[], stdin: string, signal: AbortSignal): Promise<IsolationResult> {
    let job = initial
    let dispatched = false
    const current = () => this.#active && !signal.aborted && this.#ledger.hasController(this.#controller) && this.#ledger.usable(job.id)
    try {
      const workspacePath = await stage(this.#input.stateRoot, job.id, files)
      await verifyNativeMacRuntime(this.#input.runtime)
      if (!current()) throw new Error('native authority changed')
      job = this.#ledger.markDispatched(job.id, job.version, this.#controller)
      dispatched = true
      const receipts = join(this.#input.stateRoot, 'receipts')
      await mkdir(receipts, { recursive: true, mode: 0o700 })
      const receiptInfo = await lstat(receipts)
      if (!receiptInfo.isDirectory() || receiptInfo.isSymbolicLink() || receiptInfo.uid !== process.getuid?.()
        || (receiptInfo.mode & 0o077) !== 0) throw new Error('invalid native receipt directory')
      if (!current()) throw new Error('native authority changed before start')
      const child = fork(supervisor, [], { execPath: this.#input.runtime.nodePath, execArgv: [], detached: true,
        cwd: this.#input.stateRoot, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: this.#input.stateRoot, TMPDIR: this.#input.stateRoot },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
      try { job = this.#ledger.start(job.id, job.version, this.#controller) }
      catch (error) { child.disconnect(); child.unref(); throw error }
      const outcome = await this.#waitSupervisor(child, job, workspacePath, receipts, stdin, signal)
      const receipt = await this.#settleReceipt(job)
      if (receipt) { await rm(workspacePath, { recursive: true, force: true }).catch(() => {}); return receipt }
      if (outcome === 'unconfirmed') throw new Error('native close unconfirmed')
      throw new Error('native receipt unavailable')
    } catch {
      const result: IsolationResult = dispatched ? unknown(job.id, 'native-dispatch-unconfirmed')
        : { jobId: job.id, status: 'failed', quiescent: true, stdout: '', stderr: '', artifacts: [], reason: 'native-preparation-failed' }
      try { this.#ledger.settle(job.id, job.version, result, this.#controller) } catch { /* A recovered receipt may have won the CAS. */ }
      if (!dispatched) await rm(join(this.#input.stateRoot, 'workspaces', job.id), { recursive: true, force: true }).catch(() => {})
      return result
    }
  }
  async #waitSupervisor(child: ChildProcess, job: IsolationJob, workspacePath: string, receipts: string, stdin: string, signal: AbortSignal): Promise<'receipt' | 'unconfirmed'> {
    return await new Promise(resolveOutcome => {
      let done = false
      const finish = (value: 'receipt' | 'unconfirmed') => {
        if (done) return
        done = true
        clearTimeout(grace)
        signal.removeEventListener('abort', cancel)
        child.removeAllListeners('message'); child.removeAllListeners('exit'); child.removeAllListeners('error')
        if (child.connected) child.disconnect()
        child.unref()
        resolveOutcome(value)
      }
      const cancel = () => { if (child.connected) child.send({ kind: 'cancel' }) }
      // The candidate's own deadline timer determines timed-out versus cancelled.
      // A Host cancel at that same instant races its timer and misclassifies the receipt.
      const grace = setTimeout(() => finish('unconfirmed'), Math.max(1, job.deadline - Date.now()) + 8_000)
      signal.addEventListener('abort', cancel, { once: true })
      child.on('message', message => {
        if (message && typeof message === 'object' && 'kind' in message && message.kind === 'receipt') finish('receipt')
        else if (message && typeof message === 'object' && 'kind' in message && message.kind === 'unconfirmed') finish('unconfirmed')
      })
      child.on('exit', () => finish('unconfirmed'))
      child.on('error', () => finish('unconfirmed'))
      if (signal.aborted) cancel()
      child.send({ kind: 'start', jobId: job.id, requestDigest: job.requestDigest, nonce: job.nativeNonce,
        nativeResourceId: job.nativeResourceId, receiptRoot: receipts, input: { workspacePath, nodePath: this.#input.runtime.nodePath,
          nodeSha256: this.#input.runtime.nodeSha256, runtimeReadRoots: this.#input.runtime.roots.map(root => ({ path: root.path, dev: root.dev, ino: root.ino })),
          sourceType: 'module', source: this.#input.source, stdin, deadline: job.deadline, maxOutputBytes: this.#input.maxOutputBytes } }, error => {
        if (error) finish('unconfirmed')
      })
    })
  }
  inspectQuiescence = async (key: string): Promise<'quiescent' | 'unknown'> => {
    await this.#ready
    const job = this.#ledger.findNativeVerifierJob(this.#input.authorityDigest, this.#input.stateRoot, key)
    if (!job) return 'unknown'
    return await this.#receipt(job) ? 'quiescent' : 'unknown'
  }
  close = async (): Promise<void> => {
    if (this.#closePromise) return await this.#closePromise
    this.#closePromise = (async () => {
      this.#active = false; this.#abort.abort(); clearInterval(this.#timer)
      await Promise.allSettled([this.#ready, ...this.#pending.values()])
      try { this.#ledger.releaseController(this.#controller) } finally { this.#ledger.close() }
    })()
    return await this.#closePromise
  }
}
