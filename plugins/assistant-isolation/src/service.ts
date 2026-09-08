import { validateGoalArtifactAdmission, validateTaskAcceptanceContract, type GoalArtifactAdmission, type TaskAcceptanceContract } from '@dsh-enhanced/task-acceptance-contract'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
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
import { inspectIsolationGrant } from './diagnostics.js'

export { Config }
export const isolationPrincipalDigest = (principal: string): string => createHash('sha256').update(principal).digest('hex')
export interface IsolationGrantDiscovery {
  readonly id: string; readonly expiresAt: number; readonly remainingRuns: number; readonly remainingDurationMs: number
  readonly limits: Readonly<{ maxDurationMs: number; maxInputBytes: number; maxOutputBytes: number; maxArtifactBytes: number; maxFiles: number }>
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
// Keep prompt visibility and the Host execution guard on the exact same named surface.
const isolatedScopeTools = new Set(['isolation_run', 'isolation_grants', 'goal_context', 'goal_checkpoint'])
const preauthorizedScopedTools = new Set(['action_github_commit', 'action_github_branch', 'action_github_pr', 'action_github_inspect', 'goal_create', 'goal_schedule', 'goal_strategy', 'goal_wait_event'])
const isolatedPromptTools = new Set([...isolatedScopeTools, ...preauthorizedScopedTools])
const restrictedScopeSection = 'Environment capability constraint: this authenticated workspace uses isolated execution. Host filesystem and shell tools are unavailable. The user request and explicitly supplied inline files are the only starting material; do not look for a Host project, pre-existing task file, or Host path. isolation_run starts a fresh scratch workspace with no Host project mount and no network. isolation_grants can show an existing finite grant; it cannot create or extend one.'
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
        && !isolatedScopeTools.has(execution.name)
        && !(preauthorizedScopedTools.has(execution.name) && this.ctx.get('assistantPolicy')?.isPreauthorizedTool?.(execution))) throw new Error('assistant-isolation: this scope requires isolated execution')
      return await next()
    }))
    ctx.inject(['systemPrompt'], runtime => runtime.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
      const assembly = await next()
      if (!this.#configuredOwnerScope(agent)) return assembly
      return { ...assembly,
        tools: assembly.tools.filter(tool => isolatedPromptTools.has(tool.name)),
        // Append a capability fact without replacing deployment persona or safety sections.
        sections: [...assembly.sections.filter(section => !section.name.startsWith('tools:') || isolatedPromptTools.has(section.name.slice('tools:'.length))),
          { name: 'assistant-isolation:restricted-scope', text: restrictedScopeSection }],
      }
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

  #ownerIdentity(agent: Agent | undefined): IsolationIdentity {
    if (!this.#active || !this.#ledger.hasController(this.#authority)) throw new Error('assistant-isolation: controller unavailable')
    if (agent === undefined || this.ctx.get('agents')?.get(agent.id) !== agent) throw new Error('assistant-isolation: exact live agent required')
    const owner = this.ctx.get('assistantDelivery')?.preferencePrincipalForAgent(agent)
    if (owner === undefined || owner.scope.workspace !== agent.session.header.cwd || owner.scope.preset !== agent.session.header.agentPreset) throw new Error('assistant-isolation: authenticated owner required')
    return { principalDigest: isolationPrincipalDigest(owner.principalId), ...owner.principalLineage,
      workspace: owner.scope.workspace, agentPreset: owner.scope.preset }
  }
  /** Presentation is scoped only after live owner authentication, but remains restricted after grant revoke/expiry. */
  #configuredOwnerScope(agent: Agent | undefined): boolean {
    try {
      const identity = this.#ownerIdentity(agent)
      return this.#config.grants.some(grant => grant.workspace === identity.workspace && grant.agentPreset === identity.agentPreset)
    } catch { return false }
  }

  #identity(agent: Agent | undefined, grantId: string): IsolationIdentity {
    const identity = this.#ownerIdentity(agent)
    if (this.ctx.get('assistantPolicy')?.evaluateAgent(agent, 'execute', { kind: 'tool', id: `isolation:${grantId}` }).effect !== 'allow') throw new Error('assistant-isolation: policy denied')
    return identity
  }

  /** Model-visible read-only discovery for grants already authorized to this exact live owner scope. */
  discover = async (agent: Agent | undefined): Promise<readonly IsolationGrantDiscovery[]> => {
    await this.#ready
    const identity = this.#ownerIdentity(agent)
    if (this.ctx.get('assistantPolicy')?.evaluateAgent(agent!, 'execute', { kind: 'tool', id: 'isolation_grants' }).effect !== 'allow') throw new Error('assistant-isolation: policy denied')
    const now = Date.now()
    const grants: IsolationGrantDiscovery[] = []
    for (const grant of this.#config.grants) {
      if (!this.#ledger.permitsGrant(identity, grant.id)
        || this.ctx.get('assistantPolicy')?.evaluateAgent(agent!, 'execute', { kind: 'tool', id: `isolation:${grant.id}` }).effect !== 'allow') continue
      const diagnostic = inspectIsolationGrant({ stateRoot: this.#config.stateRoot, grant, now })
      if (diagnostic.status !== 'available' || diagnostic.remainingRuns === null || diagnostic.remainingDurationMs === null) continue
      grants.push(Object.freeze({ id: grant.id, expiresAt: grant.expiresAt, remainingRuns: diagnostic.remainingRuns,
        remainingDurationMs: diagnostic.remainingDurationMs, limits: Object.freeze({ maxDurationMs: this.#config.limits.maxDurationMs,
          maxInputBytes: this.#config.limits.maxInputBytes, maxOutputBytes: this.#config.limits.maxOutputBytes,
          maxArtifactBytes: this.#config.limits.maxArtifactBytes, maxFiles: this.#config.limits.maxFiles }) }))
    }
    return Object.freeze(grants)
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

  /** Private Host readback; never exposed as a model tool or filesystem path. */
  readAcceptedArtifact = (input: TaskAcceptanceContract, path: string) => {
    if (!this.#active || !this.#ledger.hasController(this.#authority)) throw new Error('assistant-isolation: artifact source unavailable')
    const contract = validateTaskAcceptanceContract(input)
    if (contract.protocol !== 'task-acceptance/v4' || contract.task.kind !== 'goal-step') throw new Error('assistant-isolation: artifact source must be a goal step')
    const job = this.#ledger.acceptedArtifactJob(contract.id, contract.digest, path)
    if (!job || job.artifactBinding?.admission.runId !== contract.task.ref || job.sessionId !== contract.task.goal.sessionId
      || job.identity.principalRecordId !== contract.owner.principalRecordId || job.identity.principalVersion !== contract.owner.principalVersion
      || job.identity.workspace !== contract.scope.workspace || job.identity.agentPreset !== contract.scope.preset
      || !job.dispatchAttempted || job.createdAt < contract.issuedAt || job.updatedAt >= contract.expiresAt || job.status !== 'succeeded'
      || job.result?.quiescent !== true || job.result.retention !== undefined) throw new Error('assistant-isolation: accepted artifact unavailable')
    const artifacts = job.result.artifacts.filter(artifact => artifact.path === path)
    if (artifacts.length !== 1) throw new Error('assistant-isolation: accepted artifact unavailable')
    const artifact = artifacts[0]!
    return Object.freeze({ jobId: job.id, requestDigest: job.requestDigest, admission: job.artifactBinding.admission,
      path, content: artifact.content, sha256: createHash('sha256').update(artifact.content).digest('hex') })
  }

  /** Only the trusted registered isolation tool may skip a redundant risk prompt. */
  preauthorize = (execution: ToolExecution): boolean => {
    try {
      if (execution.signal.aborted || !execution.arguments || typeof execution.arguments !== 'object' || Array.isArray(execution.arguments)) return false
      const args = execution.arguments as Record<string, unknown>
      if (Object.keys(args).some(key => !['grant_id', 'idempotency_key', 'command', 'files', 'artifacts', 'timeout_ms'].includes(key))) return false
      const request = normalizeRequest({ grantId: args.grant_id, idempotencyKey: args.idempotency_key, command: args.command,
        ...(args.files === undefined ? {} : { files: args.files }), ...(args.artifacts === undefined ? {} : { artifacts: args.artifacts }),
        ...(args.timeout_ms === undefined ? {} : { timeoutMs: args.timeout_ms }),
      } as IsolationRequest, this.#config.limits)
      return this.#ledger.permitsGrant(this.#identity(execution.agent, request.grantId), request.grantId)
    } catch { return false }
  }

  run = async (agent: Agent | undefined, input: IsolationRequest, signal: AbortSignal): Promise<IsolationResult> => {
    await this.#ready
    signal.throwIfAborted()
    const request = normalizeRequest(input, this.#config.limits)
    const observation = await observeStorage(this.#config.stateRoot)
    signal.throwIfAborted()
    const identity = this.#identity(agent, request.grantId)
    const producer = this.ctx.get('assistantGoals' as never, false) as { currentArtifactAdmission?(agent: Agent): GoalArtifactAdmission | undefined } | undefined
    const admission = producer?.currentArtifactAdmission?.(agent!)
    const prepared = this.#ledger.prepare({ ...(admission ? { artifactBinding: { admission: validateGoalArtifactAdmission(admission), paths: request.artifacts ?? [] } } : {}), identity, sessionId: String(agent!.session.id), grantId: request.grantId,
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
    const authorization = this.ctx.get('assistantPolicy')?.authorizeAgent(agent, 'execute', { kind: 'tool', id: `isolation:${request.grantId}` }, {
      idempotencyKey: `isolation:${prepared.job.id}`,
    })
    if (authorization?.effect !== 'allow') {
      const result: IsolationResult = { jobId: prepared.job.id, status: 'failed', quiescent: true, stdout: '', stderr: '', artifacts: [], reason: 'policy-denied-before-dispatch' }
      this.#ledger.settle(prepared.job.id, prepared.job.version, result, this.#authority)
      throw new Error('assistant-isolation: policy denied')
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
      try {
        if (job.artifactBinding) {
          const producer = this.ctx.get('assistantGoals' as never, false) as { currentArtifactAdmission?(agent: Agent): GoalArtifactAdmission | undefined } | undefined
          const admission = producer?.currentArtifactAdmission?.(agent)
          if (!admission || digest(admission) !== digest(job.artifactBinding.admission)) return false
        }
        return !signal.aborted && this.#ledger.usable(job.id)
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
