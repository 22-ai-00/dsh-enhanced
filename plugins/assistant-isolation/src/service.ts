import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@dsh-enhanced/assistant-delivery'
import type {} from '@dsh-enhanced/assistant-policy'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { CreationWitness } from './runtime-witness.js'
import { Config, validateConfig } from './config.js'
import { IsolationLedger, type IsolationControllerAuthority } from './ledger.js'
import { removeIsolatedContainer, runIsolatedProcess } from './runner.js'
import { reconcileUnknownJob } from './reconcile.js'
import { normalizeRequest, stageWorkspace } from './workspace.js'
import { registerIsolationTools } from './tools.js'
import { plannedStorageBytes } from './storage-policy.js'
import { maintainIsolationStorage, observeStorage } from './storage.js'
import type { IsolationIdentity, IsolationJob, IsolationRequest, IsolationResult } from './types.js'

export { Config }
export const isolationPrincipalDigest = (principal: string): string => createHash('sha256').update(principal).digest('hex')
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const controllerTtlMs = 30_000
declare module '@deepseek-ai/cordis' { interface Context { assistantIsolation: AssistantIsolationService } }

/** Trusted Host broker. Only bounded input copies cross into the job-specific Docker volume. */
export class AssistantIsolationService extends Service {
  static Config = Config
  readonly #config: ReturnType<typeof validateConfig>
  readonly #ledger: IsolationLedger
  readonly #authority: IsolationControllerAuthority
  readonly #ready: Promise<void>
  readonly #jobs = new Map<string, { abort: AbortController; done: Promise<IsolationResult> }>()
  readonly #recoveryAbort = new AbortController()
  #sweep: Promise<void> | undefined
  #cursor = ''
  #storageCursor = ''
  #lastMaintenance = 0
  #active = true
  #timer: NodeJS.Timeout

  constructor(ctx: Context, input: Config = {}) {
    super(ctx, 'assistantIsolation')
    this.#config = validateConfig(input)
    const root = this.#config.stateRoot
    mkdirSync(root, { recursive: true, mode: 0o700 })
    if (realpathSync(root) !== root || !lstatSync(root).isDirectory() || lstatSync(root).uid !== process.getuid?.()) throw new Error('assistant-isolation: private owned state root required')
    chmodSync(root, 0o700)
    this.#ledger = new IsolationLedger(join(root, 'ledger.sqlite'))
    try {
      this.#authority = this.#ledger.claimController(randomUUID(), controllerTtlMs)
      this.#ledger.syncGrants(this.#config.grants, this.#authority)
    } catch (error) { this.#ledger.close(); throw error }
    this.#timer = setInterval(() => {
      try { if (this.#ledger.renewController(this.#authority, controllerTtlMs)) { this.#scheduleSweep(); return } } catch { /* Losing the fence stops execution. */ }
      this.#active = false
      this.#recoveryAbort.abort()
      for (const job of this.#jobs.values()) job.abort.abort()
    }, 5000)
    this.#timer.unref()
    this.#ready = this.#recover()
    // Store the failure for run() without an unhandled background rejection.
    void this.#ready.catch(() => { this.#active = false })
    ctx.effect(() => async () => {
      this.#active = false
      this.#recoveryAbort.abort()
      for (const job of this.#jobs.values()) job.abort.abort()
      await Promise.allSettled([this.#ready, this.#sweep, ...Array.from(this.#jobs.values(), job => job.done)])
      clearInterval(this.#timer)
      try { this.#ledger.releaseController(this.#authority) } finally { this.#ledger.close() }
    }, 'assistant-isolation.controller')
    // These scopes remain managed even when a grant expires or is revoked.
    // Trusted Host plugins are outside the worker boundary; model tool calls
    // cannot switch to an arbitrary Host shell or a nested code dispatcher.
    ctx.inject(['tools'], runtime => runtime.on('tools/execute', async (execution, next) => {
      const header = execution.agent?.session.header
      if (header !== undefined && this.#config.grants.some(grant => grant.workspace === header.cwd && grant.agentPreset === header.agentPreset)
        && !['isolation_run', 'goal_context', 'goal_checkpoint'].includes(execution.name)
        && !(execution.name === 'action_github_commit' && this.ctx.get('assistantPolicy')?.isPreauthorizedTool?.(execution))) throw new Error('assistant-isolation: this scope requires isolated execution')
      return await next()
    }))
    ctx.inject(['agents', 'assistantDelivery', 'assistantPolicy', 'tools'], runtime => registerIsolationTools(runtime, this))
  }

  #scheduleSweep(): void {
    if (!this.#active || this.#sweep) return
    this.#sweep = this.#ready.then(async () => {
      const page = this.#ledger.recoverable(this.#cursor).slice(0, 16)
      this.#cursor = page.at(-1)?.id ?? ''
      for (const job of page) {
        if (!this.#active) break
        if (this.#jobs.has(job.id)) continue
        const signal = AbortSignal.any([this.#recoveryAbort.signal, AbortSignal.timeout(30_000)])
        if (await reconcileUnknownJob(this.#ledger, this.#authority, job, this.#config.dockerPath, signal)) {
          await rm(join(this.#config.stateRoot, 'workspaces', job.id), { recursive: true, force: true })
        }
      }
      if (this.#active && Date.now() - this.#lastMaintenance >= 60_000) {
        this.#lastMaintenance = Date.now()
        const report = await maintainIsolationStorage(this.#ledger, this.#authority, this.#config.stateRoot, this.#config.storage, this.#storageCursor)
        this.#storageCursor = report.cursor
      }
    }).catch(() => { /* Keep reservations and retry only with a live controller. */ }).finally(() => { this.#sweep = undefined })
  }

  #identity(agent: Agent | undefined, grantId: string): IsolationIdentity {
    if (!this.#active || !this.#ledger.hasController(this.#authority)) throw new Error('assistant-isolation: controller unavailable')
    if (agent === undefined || this.ctx.get('agents')?.get(agent.id) !== agent) throw new Error('assistant-isolation: exact live agent required')
    const owner = this.ctx.get('assistantDelivery')?.preferencePrincipalForAgent(agent)
    if (owner === undefined || owner.scope.workspace !== agent.session.header.cwd || owner.scope.preset !== agent.session.header.agentPreset) throw new Error('assistant-isolation: authenticated owner required')
    if (this.ctx.get('assistantPolicy')?.authorizeAgent(agent, 'execute', { kind: 'tool', id: `isolation:${grantId}` }).effect !== 'allow') throw new Error('assistant-isolation: policy denied')
    return { principalDigest: isolationPrincipalDigest(owner.principalId), ...owner.principalLineage,
      workspace: owner.scope.workspace, agentPreset: owner.scope.preset }
  }

  async #recover(): Promise<void> {
    let cursor = ''
    for (;;) {
      const page = this.#ledger.recoverable(cursor)
      if (page.length === 0) break
      cursor = page.at(-1)!.id
      for (const job of page) {
        if (!this.#active) return
        const removed = await removeIsolatedContainer(this.#config.dockerPath, job.containerName, { signal: this.#recoveryAbort.signal })
        if (!this.#active) return
        // An absent object does not prove a timed-out daemon create request
        // completed. Restart must not erase that uncertainty or free its pool.
        const quiescent = removed && !job.dispatchAttempted && job.result?.reason !== 'docker-creation-unconfirmed'
        const result: IsolationResult = job.result ? { ...job.result, quiescent } : {
          jobId: job.id, status: 'unknown', quiescent, stdout: '', stderr: '', artifacts: [], reason: job.dispatchAttempted ? 'controller-recovery-dispatch-unconfirmed' : 'controller-recovery-no-replay',
        }
        this.#ledger.settle(job.id, job.version, result, this.#authority)
        if (quiescent) await rm(join(this.#config.stateRoot, 'workspaces', job.id), { recursive: true, force: true })
      }
    }
  }

  run = async (agent: Agent | undefined, input: IsolationRequest, signal: AbortSignal): Promise<IsolationResult> => {
    await this.#ready
    signal.throwIfAborted()
    const request = normalizeRequest(input, this.#config.limits)
    const observation = await observeStorage(this.#config.stateRoot)
    signal.throwIfAborted()
    const identity = this.#identity(agent, request.grantId)
    const prepared = this.#ledger.prepare({ identity, sessionId: String(agent!.session.id), grantId: request.grantId,
      idempotencyKey: request.idempotencyKey, requestDigest: digest({ request, image: this.#config.image, limits: this.#config.limits }),
      resourceReservation: { memoryMiB: this.#config.limits.memoryMiB + this.#config.limits.workspaceMiB + 32,
        workspaceInodes: this.#config.limits.workspaceInodes, maxMemoryMiB: this.#config.maxReservedMemoryMiB,
        maxWorkspaceInodes: this.#config.maxReservedWorkspaceInodes },
      storageBudget: { maxStateBytes: this.#config.storage.maxStateBytes, maxJobRecords: this.#config.storage.maxJobRecords,
        reservedBytes: plannedStorageBytes(this.#config.limits), ...(observation ? { observation } : {}) },
      durationMs: request.timeoutMs!, maxActiveJobs: this.#config.maxConcurrentJobs, authority: this.#authority })
    if (!prepared.created) {
      const current = this.#jobs.get(prepared.job.id)
      const result = current ? await current.done : prepared.job.result ?? {
        jobId: prepared.job.id, status: 'unknown' as const, quiescent: false, stdout: '', stderr: '', artifacts: [], reason: 'job-in-progress-no-replay',
      }
      if (digest(this.#identity(agent, request.grantId)) !== digest(identity)) throw new Error('assistant-isolation: owner changed')
      return structuredClone(result)
    }
    const abort = new AbortController()
    const combined = AbortSignal.any([signal, abort.signal])
    const done = this.#execute(agent!, identity, prepared.job, request, combined)
    this.#jobs.set(prepared.job.id, { abort, done })
    try {
      const result = await done
      if (digest(this.#identity(agent, request.grantId)) !== digest(identity)) throw new Error('assistant-isolation: owner changed')
      return structuredClone(result)
    } finally { this.#jobs.delete(prepared.job.id) }
  }

  async #execute(agent: Agent, identity: IsolationIdentity, initial: IsolationJob, request: IsolationRequest, signal: AbortSignal): Promise<IsolationResult> {
    let job = initial
    const abort = new AbortController()
    const authorized = (): boolean => {
      try { return !signal.aborted && this.#ledger.usable(job.id)
        && digest(this.#identity(agent, job.grantId)) === digest(identity) } catch { return false }
    }
    const timer = setInterval(() => { if (!authorized()) abort.abort() }, 250)
    timer.unref()
    let mayHaveCreated = false
    let creationWitness: CreationWitness | undefined
    let result: IsolationResult = { jobId: job.id, status: 'failed', quiescent: true, stdout: '', stderr: '', artifacts: [], reason: 'preparation-failed' }
    try {
      const workspacePath = await stageWorkspace(this.#config.stateRoot, job.id, request)
      if (!authorized()) throw new Error('authorization-denied-before-create')
      job = this.#ledger.markDispatched(job.id, job.version, this.#authority)
      mayHaveCreated = true
      const processResult = await runIsolatedProcess({ jobId: job.id, containerName: job.containerName, image: this.#config.image,
        dockerPath: this.#config.dockerPath, workspacePath, artifacts: request.artifacts ?? [], command: request.command, deadline: job.deadline,
        limits: this.#config.limits, signal: AbortSignal.any([signal, abort.signal]),
        authorizeStart: () => {
          if (!authorized()) return false
          job = this.#ledger.start(job.id, job.version, this.#authority)
          return true
        },
      })
      const { creationWitness: witness, ...publicResult } = processResult
      creationWitness = witness
      result = { ...publicResult, jobId: job.id, artifacts: processResult.artifacts ?? [],
        quiescent: publicResult.status === 'unknown' ? false : publicResult.quiescent }
    } catch {
      if (mayHaveCreated) {
        await removeIsolatedContainer(this.#config.dockerPath, job.containerName)
        result = { ...result, status: 'unknown', quiescent: false, reason: 'runner-exception-no-replay' }
      }
    }
    finally { clearInterval(timer) }
    // A lost controller cannot write success into a successor's ledger.
    try { this.#ledger.settle(job.id, job.version, result, this.#authority, creationWitness) }
    finally { if (result.quiescent) await rm(join(this.#config.stateRoot, 'workspaces', job.id), { recursive: true, force: true }) }
    return result
  }
}
