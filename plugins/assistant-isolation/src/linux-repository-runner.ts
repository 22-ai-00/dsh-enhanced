import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as pause } from 'node:timers/promises'
import { IsolationLedger, IsolationLedgerError, type IsolationControllerAuthority } from './ledger.js'
import type { LinuxCgroupRoots } from './linux-cgroups.js'
import { linuxExecutionContractDigest, linuxJobResourceReservation, validateLinuxExecutionContract,
  type LinuxReceiptBinding, type LinuxRepositoryExecutionContract } from './linux-execution-contract.js'
import { linuxExecutionReceiptBinding, prepareLinuxRepositoryIntent, readLinuxExecutionPartialCleanupProof,
  readLinuxRepositoryReceipt, runLinuxRepositoryExecution, type LinuxRepositoryArtifact } from './linux-execution.js'
import { reconcileLinuxJob } from './linux-job-recovery.js'
import { consumeLinuxLedgerAdmissionRefusal, linuxRepositoryAdmissionRefusal, withLinuxLedgerAdmissionAttempt } from './linux-repository-admission.js'
import { linuxRuntimeDigest, validateLinuxRuntime, verifyLinuxRuntime, type LinuxRuntime } from './linux-runtime.js'
import { observeStorage } from './storage.js'
import { inspectLinuxRunnerState, validateLinuxRunnerStateSeal, type LinuxRunnerStateSeal } from './linux-runner-state.js'
import type { IsolationIdentity, IsolationJob, IsolationResult } from './types.js'
import { verifyLinuxSystemSnapshotRuntimeDependencies, type LinuxSystemSnapshot } from './linux-system-snapshot.js'
import { linuxRepositoryImplementationDigest, verifyLinuxUserNamespaceMapping, type LinuxUserNamespaceMapping } from './linux-user-namespace.js'

export interface LinuxRepositoryRunnerConfig {
  readonly backend: 'linux-native'
  readonly stateRoot: string
  readonly stateSeal?: LinuxRunnerStateSeal
  readonly authorityDigest: string
  readonly expiresAt: number
  readonly maxRuns: number
  readonly maxTotalDurationMs: number
  readonly runtime: LinuxRuntime
  readonly cgroupRoots: LinuxCgroupRoots
  readonly limits: Readonly<LinuxRepositoryExecutionContract['limits']>
  readonly userNamespace?: LinuxUserNamespaceMapping
  readonly systemSnapshot?: LinuxSystemSnapshot
}
export interface LinuxRepositoryRunnerRequest {
  argv: readonly string[]
  archive: { bytes: number; sha256: string }
  artifacts: readonly string[]
}
export interface LinuxRepositoryRunnerResult {
  result: IsolationResult
  artifacts: LinuxRepositoryArtifact[]
  receiptBinding?: LinuxReceiptBinding
  contractDigest: string
  runtimeDigest: string
}
const TTL = 30_000
const MAX_MEMORY = 32 * 1024
const MAX_INODES = 3_000_000
const MAX_STATE = 1024 ** 3
const GRANT = 'repository'
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
    : JSON.stringify(value)
const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')
const positive = (value: number): boolean => Number.isSafeInteger(value) && value > 0
const validKey = (key: string): boolean => typeof key === 'string' && key.length > 0 && key.length <= 256 && !/[\p{Cc}\\]/u.test(key)
const safePath = (path: string): boolean => typeof path === 'string' && path.length > 0 && path.length <= 4096
  && !isAbsolute(path) && !/[\p{Cc}\\]/u.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..')
const uncertain = (job: IsolationJob, reason = 'repository-in-progress-no-replay'): IsolationResult => job.result
  ?? { jobId: job.id, status: 'unknown', quiescent: false, stdout: '', stderr: '', artifacts: [], reason }

/** Refuse mixed or historical ledgers before IsolationLedger can migrate,
 * change WAL mode, claim a controller, or synchronize any grant. */
function preflightLedger(root: string, identity: IsolationIdentity, schemaVersion: 2 | 3): void {
  let directory
  try { directory = lstatSync(root) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.()
    || directory.mode & 0o077 || realpathSync(root) !== root) throw new Error('Linux repository state is not private')
  const path = join(root, 'ledger.sqlite')
  let file
  try { file = lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      for (const suffix of ['-wal', '-shm']) {
        try { lstatSync(path + suffix) } catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ENOENT') continue; throw failure }
        throw new Error('Linux repository ledger sidecar has no database')
      }
      return
    }
    throw error
  }
  if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.() || file.mode & 0o077 || file.nlink !== 1
    || realpathSync(path) !== path) throw new Error('Linux repository ledger is not private')
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = path + suffix
    let info
    try { info = lstatSync(sidecar) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    // SQLite can inherit 0644 before its initial DB chmod; the checked 0700
    // parent keeps these owner-held, non-writable sidecars private as a unit.
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o022 || info.nlink !== 1
      || realpathSync(sidecar) !== sidecar) throw new Error('Linux repository ledger sidecar is unsafe')
  }
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    database.exec('BEGIN')
    if (database.prepare('PRAGMA user_version').get()?.user_version !== 8
      || database.prepare("SELECT value FROM schema_meta WHERE key='schema-version'").get()?.value !== '8') throw new Error('Linux repository ledger requires schema 8')
    const values = [GRANT, identity.principalDigest, identity.principalRecordId, identity.principalVersion, identity.workspace, identity.agentPreset]
    const foreignGrant = database.prepare(`SELECT 1 FROM isolation_grants WHERE id<>? OR principal_digest<>? OR principal_record_id<>?
      OR principal_version<>? OR workspace<>? OR agent_preset<>? LIMIT 1`).get(...values)
    const foreignJob = database.prepare(`SELECT 1 FROM isolation_jobs WHERE grant_id<>? OR principal_digest<>? OR principal_record_id<>?
      OR principal_version<>? OR workspace<>? OR agent_preset<>? OR backend_kind<>'linux-native' OR session_id<>?
      OR COALESCE(json_extract(linux_contract_json,'$.schemaVersion'),0)<>? LIMIT 1`).get(...values, `authority:${identity.principalDigest}`, schemaVersion)
    if (foreignGrant || foreignJob) throw new Error('Linux repository state contains foreign authority or backend')
  } finally { database.close() }
}

/** Private finite repository authority. No archive factory or command is replayed
 * for an existing key, including an interrupted or failed preparation. */
export class LinuxRepositoryRunner {
  readonly #input: Readonly<LinuxRepositoryRunnerConfig>
  readonly #contract: LinuxRepositoryExecutionContract
  readonly #identity: IsolationIdentity
  readonly #ledger: IsolationLedger
  readonly #executionRoot: string
  readonly #abort = new AbortController()
  readonly #admitting = new Map<string, number>()
  #runGeneration = 0
  readonly #pending = new Map<string, Promise<LinuxRepositoryRunnerResult>>()
  readonly #calls = new Set<Promise<LinuxRepositoryRunnerResult>>()
  readonly #inspections = new Set<Promise<LinuxRepositoryRunnerResult | undefined>>()
  readonly #ready: Promise<void>
  #controller: IsolationControllerAuthority | undefined
  #timer: ReturnType<typeof setInterval> | undefined
  #sweep: Promise<void> | undefined
  readonly #stateIdentity: { dev: number; ino: number }
  readonly #ledgerIdentity: { dev: number; ino: number }
  #cursor = ''
  #active = true
  #closePromise: Promise<void> | undefined

  constructor(input: LinuxRepositoryRunnerConfig) {
    if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch) || !process.getuid?.()
      || !input || Object.keys(input).sort().join() !== ['authorityDigest', 'backend', 'cgroupRoots', 'expiresAt', 'limits', 'maxRuns', 'maxTotalDurationMs', 'runtime', 'stateRoot', ...(input.stateSeal !== undefined ? ['stateSeal'] : []), ...(input.userNamespace !== undefined ? ['systemSnapshot', 'userNamespace'] : [])].sort().join()
      || (input.userNamespace === undefined) !== (input.systemSnapshot === undefined) || input.backend !== 'linux-native' || !/^[a-f0-9]{64}$/u.test(input.authorityDigest)
      || !positive(input.expiresAt) || !positive(input.maxRuns) || input.maxRuns > 1000
      || !positive(input.maxTotalDurationMs) || input.maxTotalDurationMs > 86_400_000
      || !isAbsolute(input.stateRoot) || resolve(input.stateRoot) !== input.stateRoot || input.stateRoot === '/'
      || /[\p{Cc}\\]/u.test(input.stateRoot)) throw new Error('invalid Linux repository authority')
    const stateSeal = input.stateSeal === undefined ? undefined : Object.freeze(validateLinuxRunnerStateSeal(input.stateSeal))
    if (stateSeal) inspectLinuxRunnerState({ stateRoot: input.stateRoot, stateSeal, kind: 'repository' })
    const runtime = validateLinuxRuntime(input.runtime)
    if (runtime.root.path === input.stateRoot || runtime.root.path.startsWith(input.stateRoot + sep)
      || input.stateRoot.startsWith(runtime.root.path + sep)) throw new Error('Linux repository state overlaps runtime')
    const checked = validateLinuxExecutionContract({ schemaVersion: input.userNamespace !== undefined ? 3 : 2, backend: 'linux-native', profile: 'repository',
      runtimeDigest: linuxRuntimeDigest(runtime), limits: input.limits, cgroupRoots: input.cgroupRoots,
      keeperLimits: { memoryMiB: 256, pidsLimit: 64, cpus: 0.5 },
      ...(input.userNamespace !== undefined ? { userNamespace: input.userNamespace, systemSnapshot: input.systemSnapshot,
        implementationDigest: linuxRepositoryImplementationDigest() } : {}) })
    if (checked.schemaVersion === 1 || checked.limits.maxDurationMs > input.maxTotalDurationMs) throw new Error('invalid Linux repository duration budget')
    if (checked.schemaVersion === 3 && (checked.systemSnapshot.root.path === input.stateRoot
      || checked.systemSnapshot.root.path.startsWith(input.stateRoot + sep) || input.stateRoot.startsWith(checked.systemSnapshot.root.path + sep))) throw new Error('Linux repository state overlaps system snapshot')
    this.#contract = checked
    const reservation = this.#reservation()
    if (reservation.memoryMiB > MAX_MEMORY || reservation.workspaceInodes > MAX_INODES) throw new Error('Linux repository limits exceed resource pool')
    this.#input = Object.freeze({ ...input, runtime, limits: checked.limits, cgroupRoots: checked.cgroupRoots,
      ...(stateSeal ? { stateSeal } : {}),
      ...(checked.schemaVersion === 3 ? { userNamespace: checked.userNamespace, systemSnapshot: checked.systemSnapshot } : {}) })
    this.#identity = Object.freeze({ principalDigest: input.authorityDigest, principalRecordId: `repository:${input.authorityDigest}`,
      principalVersion: 1, workspace: input.stateRoot, agentPreset: 'repository' })
    preflightLedger(input.stateRoot, this.#identity, checked.schemaVersion)
    mkdirSync(input.stateRoot, { mode: 0o700, recursive: true })
    const info = lstatSync(input.stateRoot)
    if (realpathSync(input.stateRoot) !== input.stateRoot || !info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) {
      throw new Error('Linux repository requires a private owned state root')
    }
    chmodSync(input.stateRoot, 0o700)
    this.#executionRoot = join(input.stateRoot, 'linux-executions')
    mkdirSync(this.#executionRoot, { mode: 0o700, recursive: true })
    const native = lstatSync(this.#executionRoot)
    if (realpathSync(this.#executionRoot) !== this.#executionRoot || !native.isDirectory() || native.isSymbolicLink()
      || native.uid !== process.getuid?.() || native.mode & 0o077) throw new Error('Linux repository execution state is not private')
    this.#ledger = new IsolationLedger(join(input.stateRoot, 'ledger.sqlite'))
    this.#stateIdentity = { dev: info.dev, ino: info.ino }
    const ledgerInfo = lstatSync(join(input.stateRoot, 'ledger.sqlite'))
    this.#ledgerIdentity = { dev: ledgerInfo.dev, ino: ledgerInfo.ino }
    this.#ready = this.#start()
    void this.#ready.catch(() => { this.#active = false; this.#abort.abort() })
  }
  get contractDigest(): string { return linuxExecutionContractDigest(this.#contract) }
  get runtimeDigest(): string { return this.#contract.runtimeDigest }
  #reservation(): { memoryMiB: number; workspaceInodes: number; storageBytes: number } {
    const minimum = linuxJobResourceReservation(this.#contract)
    return { ...minimum, memoryMiB: minimum.memoryMiB + 256, storageBytes: minimum.storageBytes + 96 * 1024 ** 2 }
  }
  #authority(): IsolationControllerAuthority {
    if (this.#input.stateSeal) inspectLinuxRunnerState({ stateRoot: this.#input.stateRoot,
      stateSeal: this.#input.stateSeal, kind: 'repository' })
    if (!this.#controller || !this.#ledger.hasController(this.#controller)) throw new Error('Linux repository controller unavailable')
    return this.#controller
  }
  #available(signal?: AbortSignal): void {
    if (!this.#active || signal?.aborted) throw new Error('Linux repository unavailable')
    this.#authority()
  }
  #owns(job: IsolationJob): boolean {
    return job.backend === 'linux-native' && job.grantId === GRANT && canonical(job.identity) === canonical(this.#identity)
      && job.linuxContract?.schemaVersion === this.#contract.schemaVersion
  }
  #proofIdentity(): boolean {
    try {
      if (this.#input.stateSeal) inspectLinuxRunnerState({ stateRoot: this.#input.stateRoot,
        stateSeal: this.#input.stateSeal, kind: 'repository' })
      const path = join(this.#input.stateRoot, 'ledger.sqlite'), root = lstatSync(this.#input.stateRoot), file = lstatSync(path)
      return realpathSync(this.#input.stateRoot) === this.#input.stateRoot && root.isDirectory() && !root.isSymbolicLink()
        && root.uid === process.getuid?.() && !(root.mode & 0o077) && root.dev === this.#stateIdentity.dev && root.ino === this.#stateIdentity.ino
        && realpathSync(path) === path && file.isFile() && !file.isSymbolicLink() && file.uid === process.getuid?.() && !(file.mode & 0o077)
        && file.nlink === 1 && file.dev === this.#ledgerIdentity.dev && file.ino === this.#ledgerIdentity.ino
    } catch { return false }
  }
  #find(key: string): IsolationJob | undefined {
    return this.#ledger.findJobByKey(this.#identity, `authority:${this.#input.authorityDigest}`, GRANT, key)
  }
  async #start(): Promise<void> {
    const owner = randomUUID(), deadline = Date.now() + 31_000
    for (;;) {
      this.#abort.signal.throwIfAborted()
      if (this.#input.stateSeal) inspectLinuxRunnerState({ stateRoot: this.#input.stateRoot,
        stateSeal: this.#input.stateSeal, kind: 'repository' })
      try { this.#controller = this.#ledger.claimController(owner, TTL); break } catch (error) {
        if (!(error instanceof IsolationLedgerError) || error.code !== 'unauthorized' || Date.now() >= deadline) throw error
        await pause(Math.min(250, deadline - Date.now()), undefined, { signal: this.#abort.signal })
      }
    }
    this.#abort.signal.throwIfAborted()
    this.#ledger.syncGrants([{ ...this.#identity, id: GRANT, revision: 1, expiresAt: this.#input.expiresAt,
      maxRuns: this.#input.maxRuns, maxTotalDurationMs: this.#input.maxTotalDurationMs }], this.#controller)
    this.#timer = setInterval(() => {
      try {
        if (this.#input.stateSeal) inspectLinuxRunnerState({ stateRoot: this.#input.stateRoot,
          stateSeal: this.#input.stateSeal, kind: 'repository' })
        if (this.#controller && this.#ledger.renewController(this.#controller, TTL)) {
          if (!this.#sweep) {
            const sweep = this.#ready.then(() => this.#recover())
            this.#sweep = sweep
            void sweep.catch(() => {}).finally(() => { if (this.#sweep === sweep) this.#sweep = undefined })
          }
          return
        }
      } catch { /* A lost controller fence revokes every current admission. */ }
      this.#active = false; this.#abort.abort()
    }, 5000)
    this.#timer.unref()
    await this.#recover()
  }
  async #recover(): Promise<void> {
    let visited = 0
    while (visited < 16 && this.#active) {
      this.#authority()
      const jobs = this.#ledger.recoverable(this.#cursor).slice(0, 16 - visited)
      if (!jobs.length) { this.#cursor = ''; return }
      for (const job of jobs) {
        if (!this.#active) return
        this.#cursor = job.id; visited++
        if (!this.#owns(job) || this.#pending.has(job.id)) continue
        await reconcileLinuxJob(this.#ledger, this.#authority(), job, this.#executionRoot, this.#abort.signal)
      }
    }
  }
  #request(input: LinuxRepositoryRunnerRequest): LinuxRepositoryRunnerRequest {
    if (!input || Object.keys(input).sort().join() !== 'archive,argv,artifacts' || !input.archive
      || Object.keys(input.archive).sort().join() !== 'bytes,sha256' || !positive(input.archive.bytes)
      || input.archive.bytes > this.#contract.limits.maxInputBytes || !/^[a-f0-9]{64}$/u.test(input.archive.sha256)
      || !Array.isArray(input.argv) || input.argv.length < 1 || input.argv.length > 64
      || input.argv.some((arg, index) => typeof arg !== 'string' || arg.length > 65_536 || arg.includes('\0')
        || index === 0 && (!isAbsolute(arg) || resolve(arg) !== arg || /[\r\n]/u.test(arg)))
      || !Array.isArray(input.artifacts) || input.artifacts.length > this.#contract.limits.maxFiles
      || input.artifacts.some(path => !safePath(path)) || new Set(input.artifacts).size !== input.artifacts.length) throw new Error('invalid Linux repository request')
    return Object.freeze({ argv: Object.freeze([...input.argv]), archive: Object.freeze({ ...input.archive }), artifacts: Object.freeze([...input.artifacts]) })
  }
  #output(result: IsolationResult, artifacts: LinuxRepositoryArtifact[] = [], receiptBinding?: LinuxReceiptBinding): LinuxRepositoryRunnerResult {
    return { result, artifacts, ...(receiptBinding ? { receiptBinding } : {}), contractDigest: this.contractDigest, runtimeDigest: this.runtimeDigest }
  }
  async #evidence(job: IsolationJob, finalizing = false): Promise<LinuxRepositoryRunnerResult> {
    const available = (): void => { if (finalizing) this.#authority(); else this.#available() }
    if (!job.dispatchAttempted) return this.#output(uncertain(job))
    if (!job.linuxContract || job.linuxContract.schemaVersion === 1 || !job.linuxIntent || job.linuxIntent.schemaVersion === 1) return this.#output(uncertain(job))
    const ctx = { stateRoot: this.#executionRoot, contract: job.linuxContract, intent: job.linuxIntent }
    try {
      const verified = await readLinuxRepositoryReceipt(ctx)
      available()
      if (verified && job.result?.quiescent) {
        const binding = linuxExecutionReceiptBinding(verified.receipt)
        if (job.status === 'unknown') return this.#output(job.result)
        if (canonical(job.result) !== canonical(verified.receipt.result)) throw new Error('repository result differs from receipt')
        return this.#output(job.result, job.status === 'succeeded' ? verified.artifacts : [], binding)
      }
      if (await readLinuxExecutionPartialCleanupProof(ctx)) { available(); return this.#output(uncertain(job)) }
    } catch { available() }
    if (job.status === 'unknown') return this.#output({ ...uncertain(job), quiescent: false })
    return this.#output({ ...uncertain(job), status: 'unknown', quiescent: false, artifacts: [], reason: 'repository receipt unavailable' })
  }
  /** Factories own their Host subprocess cleanup through the combined signal;
   * late completion can never open native execution admission. */
  run = (key: string, request: LinuxRepositoryRunnerRequest, loadArchive: (signal: AbortSignal) => Promise<Uint8Array>, signal: AbortSignal): Promise<LinuxRepositoryRunnerResult> => {
    if (!validKey(key)) return Promise.reject(new Error('invalid Linux repository key or archive factory'))
    this.#admitting.set(key, (this.#admitting.get(key) ?? 0) + 1)
    const call = this.#run(key, request, loadArchive, signal, ++this.#runGeneration)
    this.#calls.add(call)
    const finished = (): void => {
      this.#calls.delete(call)
      const count = this.#admitting.get(key)! - 1
      if (count) this.#admitting.set(key, count); else this.#admitting.delete(key)
    }
    void call.then(finished, finished)
    return call
  }
  async #run(key: string, raw: LinuxRepositoryRunnerRequest, loadArchive: (signal: AbortSignal) => Promise<Uint8Array>, signal: AbortSignal, generation: number): Promise<LinuxRepositoryRunnerResult> {
    if (typeof loadArchive !== 'function') throw new Error('invalid Linux repository key or archive factory')
    const request = this.#request(raw), contractDigest = this.contractDigest
    const requestDigest = hash({ request, authority: this.#input.authorityDigest, contract: contractDigest })
    await this.#ready
    const authority = { ...this.#authority() }
    let prepareAttempted = false
    const ledgerAttempt = {}
    const current = (): boolean => this.#proofIdentity() && this.#active && this.#runGeneration === generation && this.contractDigest === contractDigest
      && this.#controller?.ownerId === authority.ownerId && this.#controller.fence === authority.fence
      && this.#ledger.hasController(authority) && !this.#find(key) && this.#proofIdentity()
    try {
      this.#available(signal)
      const existing = this.#find(key)
      if (existing) return await this.#existing(existing, requestDigest)
      if (this.#contract.schemaVersion === 3) {
        await verifyLinuxUserNamespaceMapping(this.#contract.userNamespace)
        await verifyLinuxSystemSnapshotRuntimeDependencies(this.#contract.systemSnapshot, this.#input.runtime)
      } else await verifyLinuxRuntime(this.#input.runtime)
      this.#available(signal)
      const observation = await observeStorage(this.#input.stateRoot)
      this.#available(signal)
      const reservation = this.#reservation()
      prepareAttempted = true
      const { job, created } = withLinuxLedgerAdmissionAttempt(this.#ledger, ledgerAttempt, () => this.#ledger.prepare({ identity: this.#identity, sessionId: `authority:${this.#input.authorityDigest}`,
        grantId: GRANT, idempotencyKey: key, requestDigest, durationMs: this.#contract.limits.maxDurationMs,
        maxActiveJobs: 1, authority: this.#authority(), backend: 'linux-native', linuxContract: this.#contract,
        resourceReservation: { memoryMiB: reservation.memoryMiB, workspaceInodes: reservation.workspaceInodes,
          maxMemoryMiB: MAX_MEMORY, maxWorkspaceInodes: MAX_INODES },
        storageBudget: { maxStateBytes: MAX_STATE, maxJobRecords: 10_000, reservedBytes: reservation.storageBytes,
          ...(observation ? { observation } : {}) } }))
      if (!created) return await this.#existing(job, requestDigest)
      const pending = this.#execute(job, request, loadArchive, AbortSignal.any([signal, this.#abort.signal]))
      this.#pending.set(job.id, pending)
      try { return await pending } finally { this.#pending.delete(job.id) }
    } catch (error) {
      let eligible = false
      try { eligible = this.#admitting.get(key) === 1 && current() } catch { /* Unavailable identity/fence is unknown. */ }
      if (eligible && (!prepareAttempted || consumeLinuxLedgerAdmissionRefusal(error, { ledger: this.#ledger, key, requestDigest, authority, attempt: ledgerAttempt }))) {
        throw linuxRepositoryAdmissionRefusal(error, { runner: this, key, request,
          current: () => !this.#admitting.has(key) && current() })
      }
      throw error
    }
  }
  async #existing(job: IsolationJob, requestDigest: string): Promise<LinuxRepositoryRunnerResult> {
    if (!this.#owns(job) || job.requestDigest !== requestDigest || linuxExecutionContractDigest(job.linuxContract!) !== this.contractDigest) {
      throw new Error('repository idempotency key has a different request or contract')
    }
    const pending = this.#pending.get(job.id)
    if (pending) return await pending
    if (!job.result?.quiescent) {
      await reconcileLinuxJob(this.#ledger, this.#authority(), job, this.#executionRoot, this.#abort.signal)
      this.#available()
    }
    return await this.#evidence(this.#ledger.get(job.id)!)
  }
  async #load(loadArchive: (signal: AbortSignal) => Promise<Uint8Array>, signal: AbortSignal, deadline: number, revoke: () => void): Promise<Uint8Array> {
    signal.throwIfAborted()
    let stop: () => void = () => {}
    const ended = new Promise<never>((_resolve, reject) => { stop = () => reject(new Error('repository archive admission ended')) })
    // Revoke the factory's capability before waking the settlement path. A
    // rejected race alone leaves Host subprocesses running after capacity frees.
    const timer = setTimeout(() => { revoke(); stop() }, Math.max(1, deadline - Date.now()))
    signal.addEventListener('abort', stop, { once: true })
    try { return await Promise.race([Promise.resolve().then(() => {
      signal.throwIfAborted()
      if (Date.now() >= deadline) { revoke(); throw new Error('repository archive admission ended') }
      this.#authority()
      return loadArchive(signal)
    }), ended]) }
    finally { clearTimeout(timer); signal.removeEventListener('abort', stop) }
  }
  async #execute(initial: IsolationJob, request: LinuxRepositoryRunnerRequest, loadArchive: (signal: AbortSignal) => Promise<Uint8Array>, signal: AbortSignal): Promise<LinuxRepositoryRunnerResult> {
    let job = initial
    const abort = new AbortController()
    const current = (): boolean => this.#active && !signal.aborted && this.#ledger.hasController(this.#authority()) && this.#ledger.usable(job.id)
    const timer = setInterval(() => { try { if (current()) return } catch { /* A fence loss closes archive and process admission. */ }; abort.abort() }, 100)
    timer.unref()
    const combined = AbortSignal.any([signal, abort.signal])
    try {
      if (!current()) throw new Error('repository authorization changed')
      const loaded = await this.#load(loadArchive, combined, job.deadline, () => abort.abort())
      if (!current()) throw new Error('repository authorization changed')
      if (!(loaded instanceof Uint8Array) || loaded.byteLength !== request.archive.bytes) throw new Error('repository archive length differs')
      const bytes = Buffer.from(loaded)
      if (createHash('sha256').update(bytes).digest('hex') !== request.archive.sha256) throw new Error('repository archive digest differs')
      const execution = { stateRoot: this.#executionRoot, contract: this.#contract, ...request,
        archive: { bytes, sha256: request.archive.sha256 }, readOnlyRoots: [this.#input.runtime.root.path] }
      const intent = await prepareLinuxRepositoryIntent({ ...execution, job: { id: job.id, requestDigest: job.requestDigest,
        nativeResourceId: job.nativeResourceId!, nativeNonce: job.nativeNonce!, deadline: job.deadline } })
      if (!current()) throw new Error('repository authorization changed')
      job = this.#ledger.markLinuxCreateIntent(job.id, job.version, intent, this.#authority())
      job = this.#ledger.markDispatched(job.id, job.version, this.#authority())
      const outcome = await runLinuxRepositoryExecution({ ...execution, intent, signal: combined, recordResources: async resources => {
        if (!current()) throw new Error('repository authorization changed')
        job = this.#ledger.recordLinuxResources(job.id, job.version, resources, this.#authority())
      }, authorizeStart: () => {
        if (!current()) return false
        job = this.#ledger.start(job.id, job.version, this.#authority()); return true
      } })
      if (!outcome.result.quiescent) job = this.#ledger.settle(job.id, job.version, outcome.result, this.#authority())
      // Closing revokes admission, while the still-owned controller must finish
      // evidence and settlement before close() releases the ledger.
      await reconcileLinuxJob(this.#ledger, this.#authority(), job, this.#executionRoot)
      job = this.#ledger.get(job.id)!
      return await this.#evidence(job, true)
    } catch (error) {
      const cancelled = combined.aborted
      abort.abort()
      const result: IsolationResult = { jobId: job.id, status: job.dispatchAttempted ? 'unknown' : cancelled ? 'cancelled' : 'failed',
        quiescent: !job.dispatchAttempted, stdout: '', stderr: '', artifacts: [],
        reason: job.dispatchAttempted ? 'repository-dispatch-unconfirmed' : (error instanceof Error ? error.message : 'repository preparation failed').slice(0, 8192) }
      try {
        const fresh = this.#ledger.get(job.id)!
        if (fresh.result) return this.#output(fresh.result)
        const settled = this.#ledger.settle(job.id, job.version, result, this.#authority())
        return this.#output(settled.result!)
      } catch { return this.#output({ ...result, status: 'unknown', quiescent: false, reason: 'repository-settlement-unconfirmed' }) }
    } finally { clearInterval(timer) }
  }
  /** Read the original successful execution only. This cannot admit, recover or
   * replay a job, and close() drains every outstanding receipt read. */
  inspectSuccessfulExecution = (key: string, signal?: AbortSignal): Promise<LinuxRepositoryRunnerResult | undefined> => {
    if (!validKey(key)) return Promise.reject(new Error('invalid Linux repository key'))
    const call = this.#inspectSuccessfulExecution(key, signal)
    this.#inspections.add(call)
    const finished = (): void => { this.#inspections.delete(call) }
    void call.then(finished, finished)
    return call
  }
  async #inspectSuccessfulExecution(key: string, signal?: AbortSignal): Promise<LinuxRepositoryRunnerResult | undefined> {
    const live = (): void => {
      if (!this.#active || signal?.aborted || Date.now() >= this.#input.expiresAt) throw new Error('Linux repository unavailable')
    }
    const available = (): void => {
      live(); this.#available(signal)
      if (!this.#proofIdentity() || !this.#ledger.permitsGrant(this.#identity, GRANT)) throw new Error('Linux repository authority unavailable')
    }
    live()
    await this.#ready
    available()
    try {
      const job = this.#find(key)
      if (!job || !this.#owns(job) || job.grantRevision !== 1 || !job.linuxContract || job.linuxContract.schemaVersion === 1 || linuxExecutionContractDigest(job.linuxContract) !== this.contractDigest
        || !job.dispatchAttempted || job.status !== 'succeeded' || job.result?.status !== 'succeeded' || !job.result.quiescent
        || !job.linuxIntent || job.linuxIntent.schemaVersion === 1 || !job.linuxResources || this.#pending.has(job.id)) return undefined
      const verified = await readLinuxRepositoryReceipt({ stateRoot: this.#executionRoot, contract: job.linuxContract, intent: job.linuxIntent })
      available()
      // The reader proves fresh kernel absence and actual spool integrity. Bind
      // all of its identities to the original ledger, including after the await.
      if (!verified || canonical(job) !== canonical(this.#find(key))
        || canonical(verified.receipt.intent) !== canonical(job.linuxIntent)
        || canonical(verified.receipt.resources) !== canonical(job.linuxResources)
        || canonical(verified.receipt.result) !== canonical(job.result)) return undefined
      return this.#output(job.result, verified.artifacts, linuxExecutionReceiptBinding(verified.receipt))
    } catch { available(); return undefined }
  }
  async inspectQuiescence(key: string): Promise<'quiescent' | 'unknown'> {
    if (!validKey(key)) throw new Error('invalid Linux repository key')
    await this.#ready
    this.#available()
    let job = this.#find(key)
    if (!job || !this.#owns(job) || this.#pending.has(job.id)) return 'unknown'
    if (!job.result?.quiescent) {
      await reconcileLinuxJob(this.#ledger, this.#authority(), job, this.#executionRoot, this.#abort.signal)
      this.#available(); job = this.#ledger.get(job.id)!
    }
    if (!job.dispatchAttempted) return job.result?.quiescent ? 'quiescent' : 'unknown'
    if (!job.linuxContract || job.linuxContract.schemaVersion === 1 || !job.linuxIntent || job.linuxIntent.schemaVersion === 1) return 'unknown'
    try {
      const ctx = { stateRoot: this.#executionRoot, contract: job.linuxContract, intent: job.linuxIntent }
      const proof = await readLinuxRepositoryReceipt(ctx) ?? await readLinuxExecutionPartialCleanupProof(ctx)
      this.#available()
      return proof && job.result?.quiescent ? 'quiescent' : 'unknown'
    } catch { this.#available(); return 'unknown' }
  }
  close = async (): Promise<void> => {
    if (this.#closePromise) return await this.#closePromise
    this.#active = false; this.#abort.abort(); clearInterval(this.#timer)
    this.#closePromise = (async () => {
      await Promise.allSettled([this.#ready, this.#sweep, ...this.#calls, ...this.#inspections])
      try { if (this.#controller) this.#ledger.releaseController(this.#controller) } finally { this.#ledger.close() }
    })()
    return await this.#closePromise
  }
}
