import { createHash } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import type { AssistantAutomationsService, HostAutomationDefinition, HostAutomationExecutor, HostAutomationExecutorInput, HostAutomationExecutorResult } from '@dsh-enhanced/assistant-automations'
import { controlPlaneDigest, expectedSourceRelease, type ControlPlaneStore } from './store.js'
import { awaitSourceSignal, inspectSourceContext } from './source-context.js'
import { assertPluginModificationAllowed, removeSourceJobWorktree, validateScopedPluginFiles, type ScopedPluginFile } from './source-workspace.js'
import { assertManagedVersionPaths } from './source-versioning.js'
import { removeSourceJobContainer, type SourceBuildConfig } from './source-build.js'
import { inheritedEnvironment, type loadTrustConfig } from './trust.js'
import type { PluginSourcePlan } from './types.js'
import type { SourceJobIntent, SourceJobOwnerReceipt, SourceJobProjection, SourceJobRecord, SourceJobsConfig } from './source-job-types.js'

export const SOURCE_JOB_OWNER = 'plugin-control-plane-source'
const EXECUTOR = 'plugin-control-plane-source-check'
const CATALOG = controlPlaneDigest({ executor: EXECUTOR, version: 1, operation: 'isolated-check-pending-plan' })

export interface SourceJobCaller {
  ownerRouteId: string; principalId: string; principalRecordId: string; principalVersion: number; workspace: string; preset: string
}
export interface EnqueueSourceJobInput {
  gapId: string; name: string; repository: string; files: readonly ScopedPluginFile[]; idempotencyKey: string
  expectedBaseCommit: string; ttlMs: number; owner: SourceJobCaller; signal: AbortSignal; assertCurrent: () => void | Promise<void>
}
export interface SourceJobPorts {
  automations: Pick<AssistantAutomationsService, 'registerHostExecutor' | 'reconcileSystem' | 'inspectSystemOwnedActivation' | 'inspectSystemOwned'>
  delivery: { validateOwnerRoute(input: { authorityId: string; principalId: string; workspace: string; agentPreset: string }): SourceJobOwnerReceipt }
}
type Trust = Awaited<ReturnType<typeof loadTrustConfig>>

export function validateSourceJobsConfig(value: SourceJobsConfig, build?: SourceBuildConfig): void {
  const allowed = new Set(['authorityId', 'expiresAt', 'maxSubmissions', 'repository', 'ownerRouteId', 'principalId', 'workspace', 'preset', 'budgetId', 'budgetAmount'])
  if (value === null || typeof value !== 'object' || Array.isArray(value) || build === undefined
    || Object.keys(value).some(key => !allowed.has(key))
    || ![value.authorityId, value.ownerRouteId, value.principalId, value.repository, value.workspace, value.preset].every(text => typeof text === 'string' && text !== '' && text.normalize('NFC').trim() === text && text.length <= 4096 && !/[\p{Cc}]/u.test(text))
    || !isAbsolute(value.repository) || resolve(value.repository) !== value.repository || !isAbsolute(value.workspace) || resolve(value.workspace) !== value.workspace
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 1 || value.expiresAt > 8_640_000_000_000_000
    || !Number.isSafeInteger(value.maxSubmissions) || value.maxSubmissions < 1 || value.maxSubmissions > 1000
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value.authorityId)
    || typeof value.budgetId !== 'string' || value.budgetId.trim() !== value.budgetId || value.budgetId === '' || value.budgetId.length > 500
    || !Number.isSafeInteger(value.budgetAmount) || value.budgetAmount < 1) {
    throw new Error('plugin-control-plane: invalid sourceJobs authority configuration')
  }
}

function projection(job: SourceJobRecord): SourceJobProjection {
  return { id: job.id, name: job.intent.name, gapId: job.intent.gapId, baseCommit: job.intent.baseCommit,
    status: job.status, createdAt: job.createdAt, expiresAt: job.expiresAt,
    ...(job.planId === undefined ? {} : { planId: job.planId }), ...(job.failureCode === undefined ? {} : { failureCode: job.failureCode }) }
}

/** Persisted intent + native Automations execution. This class owns no scheduler. */
export class SourceJobRuntime {
  private readonly abort = new AbortController()
  private readonly flights = new Set<Promise<unknown>>()
  private readonly authorityDigest: string
  private unregister?: () => void
  private closing?: Promise<void>
  private active = false
  constructor(private readonly options: {
    config: SourceJobsConfig; build: SourceBuildConfig; statePath: string; store: ControlPlaneStore; ports: SourceJobPorts
    withGapSourceFence?: <T>(gapId: string, owner: SourceJobOwnerReceipt, callback: () => T) => T
    trust: () => Promise<Trust>
    approvePrepared?: (job: SourceJobRecord, signal: AbortSignal) => Promise<void>
    releasePrepared?: (job: SourceJobRecord, signal: AbortSignal) => Promise<void>
    advanceReleased?: (job: SourceJobRecord, signal: AbortSignal) => Promise<void>
    releaseTimeoutMs?: number
    prepare: (job: SourceJobRecord, signal: AbortSignal, assertCurrent: () => Promise<void>) => Promise<PluginSourcePlan>
  }) {
    validateSourceJobsConfig(options.config, options.build)
    this.authorityDigest = controlPlaneDigest({ config: options.config, build: options.build })
  }

  start(): void {
    this.options.store.interruptSourceJobs()
    const executor: HostAutomationExecutor = {
      descriptor: { executorId: EXECUTOR, contractVersion: 1, catalogDigest: CATALOG },
      accepts: spec => spec.executorId === EXECUTOR && spec.executorContractVersion === 1 && spec.catalogDigest === CATALOG && spec.runbookId === EXECUTOR && spec.runbookVersion === 1,
      execute: input => this.track(this.execute(input)),
    }
    this.unregister = this.options.ports.automations.registerHostExecutor(executor)
    this.active = true
    if (this.options.approvePrepared || this.options.releasePrepared || this.options.advanceReleased) {
      // Resume owner authorizations and durable release phases, never a completed source build.
      // Release dispatch claims prevent replay of unresolved external actions.
      this.track((async () => {
        for (const job of this.options.store.listPreparedSourceApprovalJobs(this.options.releasePrepared !== undefined, this.options.advanceReleased !== undefined)) {
          if (this.abort.signal.aborted) break
          try {
            this.assertOwner(job)
            const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(Math.max(1, Math.min(this.options.advanceReleased ? (this.options.releaseTimeoutMs ?? 40_000) + 40_000 : this.options.releasePrepared ? 40_000 : 10_000, job.expiresAt - Date.now())))])
            await this.continuePrepared(job, signal)
          } catch { /* pending plan retained */ }
        }
      })())
    }
    // Reconcile only queued intents. A previous claim is unknown and never replayed.
    for (let job of this.options.store.listSourceJobs(100)) {
      if (job.status !== 'queued') continue
      try { job = this.refreshQueued(job); if (job.status === 'queued') { this.assertOwner(job); this.schedule(job) } } catch {
        const current = this.options.store.getSourceJob(job.id)
        if (current?.status === 'queued') this.options.store.settleSourceJob({ id: current.id, revision: current.revision, status: 'failed', failureCode: 'source-job-reconcile-rejected' })
      }
    }
  }

  private async continuePrepared(job: SourceJobRecord, signal: AbortSignal): Promise<void> {
    this.assertOwner(job)
    if (!job.planId || !this.options.store.getOwnerTaskFailureReference(job.intent.gapId)) return
    const assertCurrent = async (): Promise<void> => {
      signal.throwIfAborted(); this.assertOwner(job)
      if (controlPlaneDigest(await this.options.trust()) !== job.intent.trustDigest) throw new Error('source job continuation trust changed')
      signal.throwIfAborted(); this.assertOwner(job)
    }
    await assertCurrent()
    if (this.options.store.getSourcePlan(job.planId).status === 'pending-approval' && this.options.approvePrepared) {
      await this.options.approvePrepared(job, signal)
    }
    const status = this.options.store.getSourcePlan(job.planId).status
    if (this.options.releasePrepared && (status === 'approved' || status === 'ready-for-human-review')) {
      await assertCurrent()
      await this.options.releasePrepared(job, signal)
    }
    if (this.options.advanceReleased && expectedSourceRelease(this.options.store.getSourcePlan(job.planId).status)) {
      await assertCurrent()
      await this.options.advanceReleased(job, signal)
    }
  }

  available(): boolean { return this.active && !this.abort.signal.aborted && Date.now() < this.options.config.expiresAt }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.active = false
      this.unregister?.()
      this.abort.abort(new Error('source job provider disposed'))
      await Promise.allSettled(this.flights)
    })()
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.flights.add(promise)
    void promise.then(() => this.flights.delete(promise), () => this.flights.delete(promise))
    return promise
  }

  private receipt(): SourceJobOwnerReceipt {
    this.abort.signal.throwIfAborted()
    const config = this.options.config
    const receipt = this.options.ports.delivery.validateOwnerRoute({ authorityId: config.ownerRouteId, principalId: config.principalId, workspace: config.workspace, agentPreset: config.preset })
    if (receipt.receiptVersion !== 2 || receipt.authorityId !== config.ownerRouteId || receipt.principalId !== config.principalId || receipt.workspace !== config.workspace || receipt.agentPreset !== config.preset
      || !/^[a-f0-9]{64}$/u.test(receipt.authorityHash) || typeof receipt.principalRecordId !== 'string' || receipt.principalRecordId === ''
      || ![receipt.principalVersion, receipt.bindingVersion, receipt.generation].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('source job owner receipt invalid')
    return structuredClone(receipt)
  }

  private assertCaller(caller: SourceJobCaller): SourceJobOwnerReceipt {
    const owner = this.receipt()
    if (caller.ownerRouteId !== owner.authorityId || caller.principalId !== owner.principalId || caller.principalRecordId !== owner.principalRecordId || caller.principalVersion !== owner.principalVersion
      || caller.workspace !== owner.workspace || caller.preset !== owner.agentPreset) throw new Error('source job caller scope mismatch')
    return owner
  }

  private withGapSource<T>(gapId: string, owner: SourceJobOwnerReceipt, callback: () => T): T {
    if (this.options.store.getOwnerTaskFailureReference(gapId) === undefined) return callback()
    if (!this.options.withGapSourceFence) throw new Error('source job task provenance service unavailable')
    return this.options.withGapSourceFence(gapId, owner, callback)
  }

  private assertOwner(job: SourceJobRecord): void {
    if (!this.available() || job.expiresAt <= Date.now() || job.intent.authority.digest !== this.authorityDigest
      || job.intent.authority.id !== this.options.config.authorityId || controlPlaneDigest(this.receipt()) !== job.intent.ownerDigest) throw new Error('source job authority changed or expired')
    this.withGapSource(job.intent.gapId, job.intent.owner, () => {})
  }

  enqueue(input: EnqueueSourceJobInput): Promise<SourceJobProjection> {
    validateScopedPluginFiles(input.files)
    if (this.options.build.versioning === 'patch') assertManagedVersionPaths(input.files)
    return this.track(this.enqueueOwned({ ...input, files: structuredClone(input.files), owner: structuredClone(input.owner) }))
  }

  private async enqueueOwned(input: EnqueueSourceJobInput): Promise<SourceJobProjection> {
    const signal = AbortSignal.any([input.signal, this.abort.signal, AbortSignal.timeout(15_000)])
    const assertCurrent = async (): Promise<void> => { signal.throwIfAborted(); await awaitSourceSignal(signal, input.assertCurrent); this.withGapSource(input.gapId, this.assertCaller(input.owner), () => {}); if (!this.available()) throw new Error('source job authority unavailable'); signal.throwIfAborted() }
    await assertCurrent()
    validateScopedPluginFiles(input.files)
    if (this.options.build.versioning === 'patch') assertManagedVersionPaths(input.files)
    assertPluginModificationAllowed(input.name)
    if (typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(input.idempotencyKey)
      || !Number.isSafeInteger(input.ttlMs) || input.ttlMs < 900_000 || input.ttlMs > 86_400_000) throw new Error('invalid source job request')
    const config = this.options.config
    if (input.repository !== config.repository || await realpath(input.repository) !== config.repository) throw new Error('source job repository mismatch')
    const owner = this.assertCaller(input.owner)
    const trust = await awaitSourceSignal(signal, this.options.trust)
    for (const outstanding of this.options.store.listSourceJobs(1)) this.refreshQueued(outstanding)
    const token = createHash('sha256').update(config.authorityId).update('\0').update(input.idempotencyKey).digest('hex')
    const id = `source-job-${token}`
    const prior = this.options.store.getSourceJob(id)
    if (prior !== undefined) {
      const frozen = prior.intent
      if (frozen.authority.digest !== this.authorityDigest || frozen.ownerDigest !== controlPlaneDigest(owner) || frozen.trustDigest !== controlPlaneDigest(trust)
        || frozen.repository !== input.repository || frozen.name !== input.name || frozen.gapId !== input.gapId || frozen.baseCommit !== input.expectedBaseCommit
        || frozen.ttlMs !== input.ttlMs || controlPlaneDigest(frozen.files) !== controlPlaneDigest(input.files)) throw new Error('source job idempotency conflict')
      await assertCurrent()
      if (prior.status === 'queued') this.scheduleOrFail(prior)
      return projection(this.options.store.getSourceJob(id)!)
    }
    const gap = this.options.store.getGap(input.gapId)
    if (gap.status !== 'open' || gap.candidateId !== undefined) throw new Error('source job gap is not open')
    const source = await inspectSourceContext({ repository: config.repository, name: input.name, paths: [], baseCommit: input.expectedBaseCommit, environment: inheritedEnvironment(trust), signal, assertCurrent })
    const intent: SourceJobIntent = {
      authority: { id: config.authorityId, digest: this.authorityDigest, expiresAt: config.expiresAt, maxSubmissions: config.maxSubmissions },
      owner, ownerDigest: controlPlaneDigest(owner), trustDigest: controlPlaneDigest(trust), repository: config.repository, name: input.name,
      gapId: gap.id, gapRevision: gap.revision, gapDigest: controlPlaneDigest(gap), baseCommit: source.baseCommit,
      files: structuredClone(input.files), ttlMs: input.ttlMs, build: structuredClone(this.options.build),
      worktree: join(this.options.statePath, 'source-worktrees', `worktree-job-${token}`), containerName: `dsh-source-job-${token}`,
    }
    await assertCurrent()
    // Synchronous acceptance and registration: no Agent signal is persisted.
    const job = this.withGapSource(gap.id, owner, () => this.options.store.enqueueSourceJob({ id, automationId: id, idempotencyKey: input.idempotencyKey, intent }))
    if (job.status === 'queued') this.scheduleOrFail(job)
    return projection(this.options.store.getSourceJob(id)!)
  }

  inspect(input: { id: string; owner: SourceJobCaller }): SourceJobProjection {
    const owner = this.assertCaller(input.owner)
    const job = this.options.store.getSourceJob(input.id)
    // A new session binding may inspect/clean this owner's old job. Execution
    // still requires the complete frozen receipt in assertOwner; never replay.
    if (job === undefined || job.intent.owner.authorityId !== owner.authorityId
      || job.intent.owner.principalId !== owner.principalId || job.intent.owner.principalRecordId !== owner.principalRecordId
      || job.intent.owner.principalVersion !== owner.principalVersion || job.intent.owner.workspace !== owner.workspace
      || job.intent.owner.agentPreset !== owner.agentPreset) throw new Error('source job not found for current owner')
    return projection(this.refreshQueued(job))
  }

  /** Native runner admission can fail before our executor is invoked. */
  private refreshQueued(job: SourceJobRecord): SourceJobRecord {
    if (job.status !== 'queued') return job
    let code: string | undefined
    try { this.withGapSource(job.intent.gapId, job.intent.owner, () => {}) } catch { code = 'source-job-task-source-changed' }
    if (job.expiresAt <= Date.now()) code = 'source-job-expired'
    else if (job.definitionHash !== undefined) {
      const health = this.options.ports.automations.inspectSystemOwned({ owner: SOURCE_JOB_OWNER, automationId: job.automationId })
      const run = health.latestTerminalRuns.production
      if (run !== undefined && run.createdAt >= job.createdAt && run.immutableContext.state === 'verified'
        && run.immutableContext.definitionHash === job.definitionHash && run.immutableContext.scope.workspace === job.intent.owner.workspace
        && run.immutableContext.scope.agentPreset === job.intent.owner.agentPreset) code = 'source-job-host-terminated-before-claim'
    }
    // A queued row proves no source resource was acquired; any late executor
    // loses its claim. No resubmission or second native occurrence is created.
    return code === undefined ? job : this.options.store.settleSourceJob({ id: job.id, revision: job.revision, status: 'failed', failureCode: code })
  }

  private definition(job: SourceJobRecord): HostAutomationDefinition {
    const config = this.options.config
    return { name: `Source check: ${job.intent.name}`, schedule: { kind: 'at', at: new Date(job.createdAt + 1000).toISOString() },
      workspace: config.workspace, agentPreset: config.preset, timeoutMs: job.intent.build.timeoutMs + 120_000 + (this.options.advanceReleased ? this.options.releaseTimeoutMs ?? 40_000 : 0),
      misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0, principal: config.principalId,
      ...(config.budgetId === undefined ? {} : { budgetId: config.budgetId, budgetAmount: config.budgetAmount! }),
      execution: { kind: 'host', executorId: EXECUTOR, executorContractVersion: 1, runbookId: EXECUTOR, runbookVersion: 1, catalogDigest: CATALOG,
        targetScope: { workspace: config.workspace, preset: config.preset }, scopeDigest: controlPlaneDigest([config.workspace, config.preset]),
        ownerRouteId: config.ownerRouteId, activationNonce: job.intentDigest } }
  }

  private schedule(job: SourceJobRecord): void {
    this.assertOwner(job)
    const automations = this.options.ports.automations
    const definition = this.definition(job)
    if (job.definitionHash === undefined) {
      automations.reconcileSystem({ owner: SOURCE_JOB_OWNER, automationId: job.automationId, idempotencyKey: `${job.id}:prepare`, desiredStatus: 'paused', definition })
      const registered = automations.inspectSystemOwnedActivation({ owner: SOURCE_JOB_OWNER, automationId: job.automationId })
      if (registered === undefined || registered.activationNonce !== job.intentDigest || registered.ownerRouteId !== this.options.config.ownerRouteId) throw new Error('source job registration binding mismatch')
      job = this.options.store.bindSourceJobDefinition({ id: job.id, revision: job.revision, definitionHash: registered.definitionHash })
    }
    const current = automations.inspectSystemOwnedActivation({ owner: SOURCE_JOB_OWNER, automationId: job.automationId })
    if (current === undefined || current.definitionHash !== job.definitionHash || current.activationNonce !== job.intentDigest || current.ownerRouteId !== this.options.config.ownerRouteId) throw new Error('source job automation changed')
    automations.reconcileSystem({ owner: SOURCE_JOB_OWNER, automationId: job.automationId, idempotencyKey: `${job.id}:activate`, desiredStatus: 'active', definition })
  }

  private scheduleOrFail(job: SourceJobRecord): void {
    try { this.schedule(job) } catch {
      const current = this.options.store.getSourceJob(job.id)
      if (current?.status === 'queued') this.options.store.settleSourceJob({ id: current.id, revision: current.revision, status: 'failed', failureCode: 'source-job-registration-rejected' })
    }
  }

  private async execute(input: HostAutomationExecutorInput): Promise<HostAutomationExecutorResult> {
    let job = this.options.store.getSourceJobByAutomation(input.automationId)
    const failure = (unknown: boolean): HostAutomationExecutorResult => ({ outcome: unknown ? 'unknown' : 'failed', failureClass: unknown ? 'unknown' : 'configuration', failurePhase: 'host-execution', failureCode: 'source-job-rejected', sideEffectState: unknown ? 'unknown' : 'none', retryability: unknown ? 'unsafe' : 'after-intervention' })
    if (job === undefined || job.status !== 'queued') return failure(job?.status === 'unknown' || job?.status === 'running')
    let claimed = false
    const signal = AbortSignal.any([input.signal, this.abort.signal, AbortSignal.timeout(Math.max(1, Math.min(job.intent.build.timeoutMs + 120_000 + (this.options.advanceReleased ? this.options.releaseTimeoutMs ?? 40_000 : 0), job.expiresAt - Date.now())))])
    try {
      this.assertOwner(job)
      signal.throwIfAborted()
      if (input.executionMode !== 'production' || input.definitionHash !== job.definitionHash || input.activationNonce !== job.intentDigest || input.catalogDigest !== CATALOG
        || input.ownerRouteId !== job.intent.owner.authorityId || input.principal !== job.intent.owner.principalId
        || input.targetScope.workspace !== job.intent.owner.workspace || input.targetScope.preset !== job.intent.owner.agentPreset) throw new Error('source job executor binding mismatch')
      job = this.options.store.claimSourceJob({ id: job.id, revision: job.revision, definitionHash: input.definitionHash, occurrenceId: input.occurrenceId })
      claimed = true
      const owned = job
      const assertCurrent = async (): Promise<void> => {
        signal.throwIfAborted(); this.assertOwner(owned)
        const current = this.options.store.getSourceJob(owned.id)
        const gap = this.options.store.getGap(owned.intent.gapId)
        if (current?.status !== 'running' || current.revision !== owned.revision || current.occurrenceId !== input.occurrenceId
          || gap.revision !== owned.intent.gapRevision || controlPlaneDigest(gap) !== owned.intent.gapDigest
          || controlPlaneDigest(await awaitSourceSignal(signal, this.options.trust)) !== owned.intent.trustDigest) throw new Error('source job intent or trust changed')
        signal.throwIfAborted()
      }
      await assertCurrent()
      await this.options.prepare(owned, signal, assertCurrent)
      if (this.options.store.getSourceJob(owned.id)?.status !== 'prepared') throw new Error('source job completion was not committed')
      if ((this.options.approvePrepared || this.options.releasePrepared || this.options.advanceReleased) && this.options.store.getOwnerTaskFailureReference(owned.intent.gapId)) {
        this.assertOwner(owned)
        await this.continuePrepared(this.options.store.getSourceJob(owned.id)!, signal)
      }
      return { outcome: 'succeeded', failureClass: 'none', failurePhase: 'none', failureCode: 'none', sideEffectState: 'possible', retryability: 'unsafe' }
    } catch {
      const current = this.options.store.getSourceJob(job.id)
      if (current?.status === 'queued' || (current?.status === 'running' && current.occurrenceId === input.occurrenceId)) {
        this.options.store.settleSourceJob({ id: current.id, revision: current.revision, status: claimed ? 'unknown' : 'failed', failureCode: claimed ? 'source-job-interrupted' : 'source-job-preflight-rejected' })
      }
      return failure(claimed)
    }
  }

  /** Explicit Host action. Unknown keeps its capacity until exact cleanup succeeds. */
  reconcileUnknown(input: { id: string; owner: SourceJobCaller }): Promise<SourceJobProjection> {
    return this.track((async () => {
      this.inspect(input)
      const job = this.options.store.getSourceJob(input.id)!
      if (job.status !== 'unknown') throw new Error('only unknown source jobs need resource reconciliation')
      const trust = await this.options.trust()
      if (controlPlaneDigest(trust) !== job.intent.trustDigest) throw new Error('source job trust changed')
      await removeSourceJobContainer(job.intent.build, { id: job.id, containerName: job.intent.containerName })
      await removeSourceJobWorktree({ stateRoot: join(this.options.statePath, 'source-worktrees'), repository: job.intent.repository, worktree: job.intent.worktree, baseCommit: job.intent.baseCommit, environment: inheritedEnvironment(trust) })
      this.inspect(input)
      return projection(this.options.store.settleSourceJob({ id: job.id, revision: job.revision, status: 'failed', failureCode: 'source-job-resources-reconciled' }))
    })())
  }
}
