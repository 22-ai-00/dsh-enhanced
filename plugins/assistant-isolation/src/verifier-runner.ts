import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultLimits, validateConfig } from './config.js'
import { IsolationLedger, type IsolationControllerAuthority } from './ledger.js'
import { runIsolatedProcess, removeIsolatedContainer } from './runner.js'
import { normalizeRequest, stageWorkspace } from './workspace.js'
import { observeStorage } from './storage.js'
import { plannedStorageBytes } from './storage-policy.js'
import type { IsolationJob, IsolationRequest, IsolationResult } from './types.js'
import type { CreationWitness } from './runtime-witness.js'

export interface IsolatedVerifierRunnerConfig {
  stateRoot: string
  image: string
  dockerPath: string
  authorityDigest: string
  command: string
  expiresAt: number
  maxRuns: number
  maxTotalDurationMs: number
  maxDurationMs: number
  maxOutputBytes: number
}

/** Operator-owned verification jobs. No Agent or model tool receives this runner. */
export class IsolatedVerifierRunner {
  readonly #input: Readonly<IsolatedVerifierRunnerConfig>
  readonly #config: ReturnType<typeof validateConfig>
  readonly #ledger: IsolationLedger
  readonly #controller: IsolationControllerAuthority
  readonly #abort = new AbortController()
  readonly #pending = new Map<string, Promise<IsolationResult>>()
  readonly #ready: Promise<void>
  readonly #timer: ReturnType<typeof setInterval>
  #active = true
  #closePromise: Promise<void> | undefined
  constructor(input: IsolatedVerifierRunnerConfig) {
    if (!/^[0-9a-f]{64}$/.test(input.authorityDigest) || typeof input.command !== 'string' || input.command.length === 0 || input.command.length > 16_384
      || !Number.isSafeInteger(input.maxRuns) || input.maxRuns < 1 || input.maxRuns > 10_000
      || !Number.isSafeInteger(input.maxTotalDurationMs) || input.maxTotalDurationMs < 1 || input.maxTotalDurationMs > 86_400_000
      || !Number.isSafeInteger(input.maxDurationMs) || input.maxDurationMs < 1 || input.maxDurationMs > 300_000
      || !Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1 || input.maxOutputBytes > 262_144
      || input.maxDurationMs > input.maxTotalDurationMs
      || !Number.isSafeInteger(input.expiresAt) || input.expiresAt < 1) throw new Error('invalid isolated verifier authority')
    this.#input = Object.freeze({ ...input })
    this.#config = validateConfig({ stateRoot: this.#input.stateRoot, image: this.#input.image, dockerPath: this.#input.dockerPath,
      limits: { ...defaultLimits, maxDurationMs: this.#input.maxDurationMs, maxOutputBytes: this.#input.maxOutputBytes },
      grants: [{ id: 'verification', revision: 1, principalDigest: this.#input.authorityDigest,
        principalRecordId: `verification:${this.#input.authorityDigest}`, principalVersion: 1,
        workspace: this.#input.stateRoot, agentPreset: 'verification', expiresAt: this.#input.expiresAt,
        maxRuns: this.#input.maxRuns, maxTotalDurationMs: this.#input.maxTotalDurationMs }] })
    const root = this.#config.stateRoot
    mkdirSync(root, { recursive: true, mode: 0o700 })
    if (realpathSync(root) !== root || !lstatSync(root).isDirectory() || lstatSync(root).uid !== process.getuid?.()) throw new Error('isolated verifier requires a private owned state root')
    chmodSync(root, 0o700)
    this.#ledger = new IsolationLedger(join(root, 'ledger.sqlite'))
    try { this.#controller = this.#ledger.claimController(randomUUID(), 30_000); this.#ledger.syncGrants(this.#config.grants, this.#controller) }
    catch (error) { this.#ledger.close(); throw error }
    this.#timer = setInterval(() => {
      try { if (this.#ledger.renewController(this.#controller, 30_000)) return } catch { /* Fail closed on lost controller. */ }
      this.#active = false; this.#abort.abort()
    }, 5_000)
    this.#timer.unref()
    this.#ready = this.#recover()
    void this.#ready.catch(() => { this.#active = false; this.#abort.abort() })
  }
  async #recover(): Promise<void> {
    let cursor = ''
    for (;;) {
      const jobs = this.#ledger.recoverable(cursor)
      if (jobs.length === 0) return
      cursor = jobs.at(-1)!.id
      for (const job of jobs) {
        if (!this.#active) return
        const removed = await removeIsolatedContainer(this.#config.dockerPath, job.containerName, { signal: this.#abort.signal })
        const quiescent = removed && !job.dispatchAttempted
        // Preserve any durable process evidence. Recovery only changes the
        // lifecycle conclusion; it must never erase a previous receipt body.
        const result: IsolationResult = job.result === undefined
          ? { jobId: job.id, status: 'unknown', quiescent, stdout: '', stderr: '', artifacts: [], reason: 'verification-recovery-no-replay' }
          : { ...job.result, jobId: job.id, status: 'unknown', quiescent }
        try { this.#ledger.settle(job.id, job.version, result, this.#controller) }
        catch {
          // A dispatched request cannot be declared quiescent from this local
          // removal attempt; retain its existing durable unknown evidence.
          if (job.result === undefined) throw new Error('verification recovery settlement failed')
        }
        if (quiescent) await rm(join(this.#config.stateRoot, 'workspaces', job.id), { recursive: true, force: true })
      }
    }
  }
  run = async (key: string, artifact: string, stdin: string, signal: AbortSignal): Promise<IsolationResult> => {
    await this.#ready
    if (!this.#active || signal.aborted) throw new Error('isolated verifier unavailable')
    const request = normalizeRequest({ grantId: 'verification', idempotencyKey: key,
      command: this.#input.command,
      files: [{ path: 'artifact', content: artifact }, { path: 'input', content: stdin }], artifacts: [], timeoutMs: this.#input.maxDurationMs }, this.#config.limits)
    const observation = await observeStorage(this.#config.stateRoot)
    if (!this.#active || signal.aborted) throw new Error('isolated verifier unavailable')
    const { job, created } = this.#ledger.prepare({ identity: {
      principalDigest: this.#input.authorityDigest, principalRecordId: `verification:${this.#input.authorityDigest}`,
      principalVersion: 1, workspace: this.#config.stateRoot, agentPreset: 'verification',
    }, sessionId: `authority:${this.#input.authorityDigest}`, grantId: 'verification', idempotencyKey: key,
    requestDigest: createHash('sha256').update(JSON.stringify({ request, authority: this.#input.authorityDigest })).digest('hex'),
    durationMs: this.#input.maxDurationMs, maxActiveJobs: 2, authority: this.#controller,
    resourceReservation: { memoryMiB: this.#config.limits.memoryMiB + this.#config.limits.workspaceMiB + 32,
      workspaceInodes: this.#config.limits.workspaceInodes, maxMemoryMiB: this.#config.maxReservedMemoryMiB, maxWorkspaceInodes: this.#config.maxReservedWorkspaceInodes },
    storageBudget: { maxStateBytes: this.#config.storage.maxStateBytes, maxJobRecords: this.#config.storage.maxJobRecords,
      reservedBytes: plannedStorageBytes(this.#config.limits), ...(observation ? { observation } : {}) } })
    if (!created) return await this.#pending.get(job.id) ?? job.result ?? { jobId: job.id, status: 'unknown', quiescent: false, stdout: '', stderr: '', artifacts: [], reason: 'verification-in-progress-no-replay' }
    const pending = this.#execute(job, request, AbortSignal.any([signal, this.#abort.signal]))
    this.#pending.set(job.id, pending)
    try { return await pending } finally { this.#pending.delete(job.id) }
  }
  async #execute(initial: IsolationJob, request: IsolationRequest, signal: AbortSignal): Promise<IsolationResult> {
    let job = initial; let dispatched = false; let witness: CreationWitness | undefined
    let result: IsolationResult = { jobId: job.id, status: 'failed', quiescent: true, stdout: '', stderr: '', artifacts: [], reason: 'verification-preparation-failed' }
    const abort = new AbortController()
    const current = () => this.#active && !signal.aborted && this.#ledger.hasController(this.#controller) && this.#ledger.usable(job.id)
    const timer = setInterval(() => { try { if (current()) return } catch {}; abort.abort() }, 250); timer.unref()
    try {
      const workspacePath = await stageWorkspace(this.#config.stateRoot, job.id, request)
      if (!current()) throw new Error('verification authorization changed')
      job = this.#ledger.markDispatched(job.id, job.version, this.#controller); dispatched = true
      const observed = await runIsolatedProcess({ jobId: job.id, containerName: job.containerName, image: this.#config.image,
        dockerPath: this.#config.dockerPath, workspacePath, command: request.command, artifacts: [], deadline: job.deadline,
        limits: this.#config.limits, signal: AbortSignal.any([signal, abort.signal]),
        authorizeStart: () => { if (!current()) return false; job = this.#ledger.start(job.id, job.version, this.#controller); return true } })
      const { creationWitness, ...value } = observed; witness = creationWitness
      result = { ...value, jobId: job.id, artifacts: [], quiescent: value.status === 'unknown' ? false : value.quiescent }
    } catch {
      if (dispatched) { await removeIsolatedContainer(this.#config.dockerPath, job.containerName); result = { ...result, status: 'unknown', quiescent: false, reason: 'verification-dispatch-unconfirmed' } }
    } finally { clearInterval(timer) }
    try { this.#ledger.settle(job.id, job.version, result, this.#controller, witness) }
    finally { if (result.quiescent) await rm(join(this.#config.stateRoot, 'workspaces', job.id), { recursive: true, force: true }) }
    return result
  }
  close = async (): Promise<void> => {
    if (this.#closePromise !== undefined) return await this.#closePromise
    this.#closePromise = (async () => {
      this.#active = false; this.#abort.abort()
      clearInterval(this.#timer)
      await Promise.allSettled([this.#ready, ...this.#pending.values()])
      try { this.#ledger.releaseController(this.#controller) } finally { this.#ledger.close() }
    })()
    return await this.#closePromise
  }
}
