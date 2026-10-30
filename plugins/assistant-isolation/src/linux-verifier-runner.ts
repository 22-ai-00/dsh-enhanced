import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { defaultLimits } from './config.js'
import { IsolationLedger, IsolationLedgerError, type IsolationControllerAuthority } from './ledger.js'
import type { LinuxCgroupRoots } from './linux-cgroups.js'
import { linuxExecutionContractDigest, validateLinuxExecutionContract, type LinuxExecutionContract } from './linux-execution-contract.js'
import { linuxExecutionReceiptBinding, prepareLinuxExecutionIntent, readLinuxExecutionReceipt, readLinuxExecutionPartialCleanupProof,
  reconcileLinuxExecution, runLinuxExecution } from './linux-execution.js'
import { linuxRuntimeDigest, validateLinuxRuntime, verifyLinuxRuntime, type LinuxRuntime } from './linux-runtime.js'
import { defaultStoragePolicy, plannedStorageBytes } from './storage-policy.js'
import { observeStorage } from './storage.js'
import { normalizeRequest } from './workspace.js'
import type { IsolationIdentity, IsolationJob, IsolationLimits, IsolationRequest, IsolationResult } from './types.js'
import { inspectLinuxRunnerState, validateLinuxRunnerStateSeal, type LinuxRunnerStateSeal } from './linux-runner-state.js'

export interface LinuxVerifierRunnerConfig {
  backend: 'linux-native'
  stateRoot: string
  stateSeal?: LinuxRunnerStateSeal
  authorityDigest: string
  command: string
  expiresAt: number
  maxRuns: number
  maxTotalDurationMs: number
  maxDurationMs: number
  maxOutputBytes: number
  runtime: LinuxRuntime
  cgroupRoots: LinuxCgroupRoots
  limits?: Partial<IsolationLimits>
}

const TTL = 30_000
const STARTUP_TIMEOUT = 31_000
const MAX_MEMORY = 2048
const MAX_INODES = 32_768
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const unknown = (job: IsolationJob, quiescent = false, reason = 'verification-in-progress-no-replay'): IsolationResult =>
  job.result ?? { jobId: job.id, status: 'unknown', quiescent, stdout: '', stderr: '', artifacts: [], reason }

/** Private operator API. Uses the same ledger, grants and history as the Docker verifier. */
export class LinuxVerifierRunner {
  readonly #input: Readonly<LinuxVerifierRunnerConfig>
  readonly #contract: LinuxExecutionContract
  readonly #identity: IsolationIdentity
  readonly #ledger: IsolationLedger
  readonly #abort = new AbortController()
  readonly #pending = new Map<string, Promise<IsolationResult>>()
  readonly #calls = new Set<Promise<IsolationResult>>()
  readonly #ready: Promise<void>
  readonly #executionRoot: string
  #controller: IsolationControllerAuthority | undefined
  #timer: ReturnType<typeof setInterval> | undefined
  #sweep: Promise<void> | undefined
  #recoveryCursor = ''
  #active = true
  #closePromise: Promise<void> | undefined

  constructor(input: LinuxVerifierRunnerConfig) {
    if (process.platform !== 'linux' || !process.getuid?.() || input.backend !== 'linux-native'
      || !/^[0-9a-f]{64}$/u.test(input.authorityDigest) || typeof input.command !== 'string'
      || input.command.length < 1 || input.command.length > 16_384 || input.command.includes('\0')
      || !Number.isSafeInteger(input.maxRuns) || input.maxRuns < 1 || input.maxRuns > 10_000
      || !Number.isSafeInteger(input.maxTotalDurationMs) || input.maxTotalDurationMs < 1 || input.maxTotalDurationMs > 86_400_000
      || !Number.isSafeInteger(input.maxDurationMs) || input.maxDurationMs < 1 || input.maxDurationMs > 300_000
      || input.maxDurationMs > input.maxTotalDurationMs
      || !Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1 || input.maxOutputBytes > 262_144
      || !Number.isSafeInteger(input.expiresAt) || input.expiresAt < 1
      || !isAbsolute(input.stateRoot) || resolve(input.stateRoot) !== input.stateRoot || input.stateRoot === '/'
      || /[\p{Cc}\\]/u.test(input.stateRoot)) throw new Error('invalid Linux verifier authority')
    const stateSeal = input.stateSeal === undefined ? undefined : Object.freeze(validateLinuxRunnerStateSeal(input.stateSeal))
    if (stateSeal) inspectLinuxRunnerState({ stateRoot: input.stateRoot, stateSeal, kind: 'verification' })
    const runtime = validateLinuxRuntime(input.runtime)
    if (runtime.root.path === input.stateRoot || runtime.root.path.startsWith(input.stateRoot + sep)
      || input.stateRoot.startsWith(runtime.root.path + sep)) throw new Error('Linux verifier state overlaps runtime')
    this.#contract = validateLinuxExecutionContract({ schemaVersion: 1, backend: 'linux-native',
      runtimeDigest: linuxRuntimeDigest(runtime), profile: 'ordinary',
      limits: { ...defaultLimits, ...input.limits, maxDurationMs: input.maxDurationMs, maxOutputBytes: input.maxOutputBytes },
      keeperLimits: { memoryMiB: 128, pidsLimit: 64, cpus: 0.5 }, cgroupRoots: input.cgroupRoots })
    const limits = this.#contract.limits
    if (limits.workspaceMiB > 4096 || this.#reservedMemory() > MAX_MEMORY || this.#reservedInodes() > MAX_INODES) {
      throw new Error('Linux verifier limits exceed resource pool')
    }
    this.#input = Object.freeze({ ...input, runtime, limits: this.#contract.limits, cgroupRoots: this.#contract.cgroupRoots,
      ...(stateSeal ? { stateSeal } : {}) })
    const root = input.stateRoot
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const info = lstatSync(root)
    if (realpathSync(root) !== root || !info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) {
      throw new Error('Linux verifier requires a private owned state root')
    }
    chmodSync(root, 0o700)
    this.#executionRoot = join(root, 'linux-executions')
    mkdirSync(this.#executionRoot, { mode: 0o700, recursive: true })
    const native = lstatSync(this.#executionRoot)
    if (realpathSync(this.#executionRoot) !== this.#executionRoot || !native.isDirectory() || native.isSymbolicLink()
      || native.uid !== process.getuid?.() || native.mode & 0o077) throw new Error('Linux verifier execution state is not private')
    // Do not bind, replace or even contact a historical Docker socket marker.
    this.#ledger = new IsolationLedger(join(root, 'ledger.sqlite'))
    this.#identity = Object.freeze({ principalDigest: input.authorityDigest,
      principalRecordId: `verification:${input.authorityDigest}`, principalVersion: 1,
      workspace: root, agentPreset: 'verification' })
    this.#ready = this.#start()
    void this.#ready.catch(() => { this.#active = false; this.#abort.abort() })
  }

  #reservedMemory(): number {
    const limits = this.#contract.limits
    return limits.memoryMiB + limits.workspaceMiB + Math.ceil(Math.max(1, Math.min(64, limits.memoryMiB / 4)))
      + 1 + this.#contract.keeperLimits.memoryMiB
  }
  #reservedInodes(): number { return 2 * this.#contract.limits.workspaceInodes + 4096 + 32 }
  #authority(): IsolationControllerAuthority {
    if (this.#input.stateSeal) inspectLinuxRunnerState({ stateRoot: this.#input.stateRoot,
      stateSeal: this.#input.stateSeal, kind: 'verification' })
    if (!this.#controller || !this.#ledger.hasController(this.#controller)) throw new Error('Linux verifier controller unavailable')
    return this.#controller
  }
  #available(signal: AbortSignal): void {
    if (!this.#active || signal.aborted) throw new Error('Linux verifier unavailable')
    this.#authority()
  }
  async #start(): Promise<void> {
    const ownerId = randomUUID(), deadline = Date.now() + STARTUP_TIMEOUT
    for (;;) {
      this.#abort.signal.throwIfAborted()
      if (this.#input.stateSeal) inspectLinuxRunnerState({ stateRoot: this.#input.stateRoot,
        stateSeal: this.#input.stateSeal, kind: 'verification' })
      try { this.#controller = this.#ledger.claimController(ownerId, TTL); break } catch (error) {
        if (!(error instanceof IsolationLedgerError) || error.code !== 'unauthorized' || Date.now() >= deadline) throw error
        await pause(Math.min(250, deadline - Date.now()), undefined, { signal: this.#abort.signal })
      }
    }
    this.#abort.signal.throwIfAborted()
    this.#ledger.syncGrants([{ ...this.#identity, id: 'verification', revision: 1, expiresAt: this.#input.expiresAt,
      maxRuns: this.#input.maxRuns, maxTotalDurationMs: this.#input.maxTotalDurationMs }], this.#controller)
    this.#timer = setInterval(() => {
      try {
        if (this.#input.stateSeal) inspectLinuxRunnerState({ stateRoot: this.#input.stateRoot,
          stateSeal: this.#input.stateSeal, kind: 'verification' })
        if (this.#controller && this.#ledger.renewController(this.#controller, TTL)) {
          this.#scheduleRecovery()
          return
        }
      } catch { /* Fence loss revokes work. */ }
      this.#active = false; this.#abort.abort()
    }, 5_000)
    this.#timer.unref()
    await this.#recover()
  }

  #scheduleRecovery(): void {
    if (!this.#active || this.#sweep) return
    const sweep = this.#ready.then(() => this.#recover())
    this.#sweep = sweep
    void sweep.catch(() => { /* Retry uncertain storage/kernel evidence on the next renewal. */ }).finally(() => {
      if (this.#sweep === sweep) this.#sweep = undefined
    })
  }

  async #recover(): Promise<void> {
    // Each sweep visits at most one small batch. Retained unknown rows rotate
    // through the cursor instead of blocking later jobs or an awaited close.
    let visited = 0
    while (visited < 16) {
      if (!this.#active) return
      this.#authority()
      const jobs = this.#ledger.recoverable(this.#recoveryCursor).slice(0, 16 - visited)
      if (jobs.length === 0) { this.#recoveryCursor = ''; return }
      for (let job of jobs) {
        if (!this.#active) return
        visited++
        this.#recoveryCursor = job.id
        if (this.#pending.has(job.id)) continue
        const authority = this.#authority()
        if (job.backend !== 'linux-native' || !job.dispatchAttempted || !job.linuxIntent || !job.linuxContract) {
          if (job.status === 'prepared' || job.status === 'running') {
            this.#ledger.settle(job.id, job.version, { ...unknown(job), status: 'unknown',
              quiescent: job.backend === 'linux-native' && !job.dispatchAttempted,
              reason: 'verification-recovery-no-replay' }, authority)
          }
          continue
        }
        try {
          const ctx = { stateRoot: this.#executionRoot, contract: job.linuxContract, intent: job.linuxIntent }
          const receipt = await readLinuxExecutionReceipt(ctx)
          const recovered = receipt ? { receipt, resources: receipt.resources } : await reconcileLinuxExecution(ctx)
          if (!this.#active) return
          if (!job.linuxResources && recovered.resources && job.status === 'prepared') {
            job = this.#ledger.recordLinuxResources(job.id, job.version, recovered.resources, this.#authority())
          } else if (!job.linuxResources && recovered.resources && job.status === 'unknown') {
            job = this.#ledger.recordLinuxRecoveredResources(job.id, job.version, recovered.resources, this.#authority())
          }
          if ('partialProof' in recovered && recovered.partialProof && !job.linuxResources) {
            this.#ledger.settleLinuxPrestartCleanup(job.id, job.version, recovered.partialProof, this.#authority())
            continue
          }
          if (recovered.receipt && job.linuxResources) {
            const binding = linuxExecutionReceiptBinding(recovered.receipt)
            if (job.status === 'unknown') this.#ledger.settleLinuxReconciledUnknown(job.id, job.version, binding, this.#authority())
            else this.#ledger.settleLinuxReceipt(job.id, job.version, binding, recovered.receipt.result, this.#authority())
            continue
          }
        } catch { /* Retain uncertainty when private evidence or kernel proof is unavailable. */ }
        if (job.status === 'prepared' || job.status === 'running') {
          this.#ledger.settle(job.id, job.version, { ...unknown(job), status: 'unknown', quiescent: false,
            reason: 'verification-recovery-no-replay' }, this.#authority())
        }
      }
    }
  }

  run = (key: string, artifact: string, stdin: string, signal: AbortSignal): Promise<IsolationResult> => {
    const call = this.#run(key, artifact, stdin, signal)
    this.#calls.add(call)
    void call.then(() => this.#calls.delete(call), () => this.#calls.delete(call))
    return call
  }
  async #run(key: string, artifact: string, stdin: string, signal: AbortSignal): Promise<IsolationResult> {
    await this.#ready
    this.#available(signal)
    const request = normalizeRequest({ grantId: 'verification', idempotencyKey: key, command: this.#input.command,
      files: [{ path: 'artifact', content: artifact }, { path: 'input', content: stdin }], artifacts: [],
      timeoutMs: this.#input.maxDurationMs }, this.#contract.limits)
    const requestDigest = hash({ request, authority: this.#input.authorityDigest, contract: linuxExecutionContractDigest(this.#contract) })
    const existing = this.#ledger.findJobByKey(this.#identity, `authority:${this.#input.authorityDigest}`, 'verification', key)
    if (existing) return await this.#existing(existing, request, requestDigest)
    // Full tree and executable verification is repeated for each newly admitted request.
    await verifyLinuxRuntime(this.#input.runtime, AbortSignal.any([signal, this.#abort.signal]))
    this.#available(signal)
    const observation = await observeStorage(this.#input.stateRoot)
    this.#available(signal)
    const { job, created } = this.#ledger.prepare({ identity: this.#identity, sessionId: `authority:${this.#input.authorityDigest}`,
      grantId: 'verification', idempotencyKey: key, requestDigest, durationMs: this.#input.maxDurationMs,
      maxActiveJobs: 2, authority: this.#authority(), backend: 'linux-native', linuxContract: this.#contract,
      resourceReservation: { memoryMiB: this.#reservedMemory(), workspaceInodes: this.#reservedInodes(),
        maxMemoryMiB: MAX_MEMORY, maxWorkspaceInodes: MAX_INODES },
      storageBudget: { maxStateBytes: defaultStoragePolicy.maxStateBytes, maxJobRecords: defaultStoragePolicy.maxJobRecords,
        reservedBytes: 3 * plannedStorageBytes(this.#contract.limits),
        ...(observation ? { observation } : {}) } })
    if (!created) return await this.#existing(job, request, requestDigest)
    const pending = this.#execute(job, request, AbortSignal.any([signal, this.#abort.signal]))
    this.#pending.set(job.id, pending)
    try { return await pending } finally { this.#pending.delete(job.id) }
  }
  async #existing(job: IsolationJob, request: IsolationRequest, digest: string): Promise<IsolationResult> {
    const expected = job.backend === 'docker' ? hash({ request, authority: this.#input.authorityDigest }) : digest
    if (job.requestDigest !== expected || job.backend === 'linux-native'
      && (!job.linuxContract || linuxExecutionContractDigest(job.linuxContract) !== linuxExecutionContractDigest(this.#contract))) {
      throw new Error('verification idempotency key has a different request or contract')
    }
    return await this.#pending.get(job.id) ?? unknown(job)
  }

  async #execute(initial: IsolationJob, request: IsolationRequest, signal: AbortSignal): Promise<IsolationResult> {
    let job = initial
    let result: IsolationResult = { jobId: job.id, status: 'failed', quiescent: true,
      stdout: '', stderr: '', artifacts: [], reason: 'verification-preparation-failed' }
    const abort = new AbortController()
    const current = (): boolean => this.#active && !signal.aborted && this.#ledger.hasController(this.#authority()) && this.#ledger.usable(job.id)
    const timer = setInterval(() => { try { if (current()) return } catch { /* Lost authority cancels. */ }; abort.abort() }, 250)
    timer.unref()
    try {
      if (!current()) throw new Error('verification authorization changed')
      const intent = await prepareLinuxExecutionIntent({ stateRoot: this.#executionRoot, contract: this.#contract,
        job: { id: job.id, requestDigest: job.requestDigest, nativeResourceId: job.nativeResourceId!, nativeNonce: job.nativeNonce!, deadline: job.deadline } })
      if (!current()) throw new Error('verification authorization changed')
      job = this.#ledger.markLinuxCreateIntent(job.id, job.version, intent, this.#authority())
      job = this.#ledger.markDispatched(job.id, job.version, this.#authority())
      await runLinuxExecution({ stateRoot: this.#executionRoot, contract: this.#contract, intent,
        argv: ['/bin/sh', '-c', 'PATH=/runtime/0/bin:/runtime/0/pnpm-native:/usr/bin:/bin; export PATH; exec /bin/sh -c "$1"',
          'dsh-linux-verifier', request.command], files: request.files ?? [], artifacts: [],
        readOnlyRoots: [this.#input.runtime.root.path], signal: AbortSignal.any([signal, abort.signal]),
        recordResources: async resources => {
          if (!current()) throw new Error('verification authorization changed')
          job = this.#ledger.recordLinuxResources(job.id, job.version, resources, this.#authority())
        }, authorizeStart: () => {
          if (!current()) return false
          job = this.#ledger.start(job.id, job.version, this.#authority())
          return true
        } })
      // Re-read the private receipt and actual resource absence; a returned tool
      // result or ordinary ledger settle is never sufficient for native success.
      const receipt = await readLinuxExecutionReceipt({ stateRoot: this.#executionRoot, contract: this.#contract, intent })
      if (!receipt) {
        const proof = await readLinuxExecutionPartialCleanupProof({ stateRoot: this.#executionRoot, contract: this.#contract, intent })
        if (proof) return this.#ledger.settleLinuxPrestartCleanup(job.id, job.version, proof, this.#authority()).result!
        throw new Error('verification receipt unavailable')
      }
      if (!job.linuxResources) job = this.#ledger.recordLinuxResources(job.id, job.version, receipt.resources, this.#authority())
      const settled = this.#ledger.settleLinuxReceipt(job.id, job.version,
        linuxExecutionReceiptBinding(receipt), receipt.result, this.#authority())
      return settled.result!
    } catch {
      if (job.dispatchAttempted) result = { ...result, status: 'unknown', quiescent: false, reason: 'verification-dispatch-unconfirmed' }
      try { return this.#ledger.settle(job.id, job.version, result, this.#authority()).result! }
      catch { return { ...result, status: 'unknown', quiescent: false, reason: 'verification-settlement-unconfirmed' } }
    } finally { clearInterval(timer) }
  }

  close = async (): Promise<void> => {
    if (this.#closePromise) return await this.#closePromise
    this.#active = false
    this.#abort.abort()
    clearInterval(this.#timer)
    this.#closePromise = (async () => {
      await Promise.allSettled([this.#ready, this.#sweep, ...this.#calls])
      try { if (this.#controller) this.#ledger.releaseController(this.#controller) } finally { this.#ledger.close() }
    })()
    return await this.#closePromise
  }
}
