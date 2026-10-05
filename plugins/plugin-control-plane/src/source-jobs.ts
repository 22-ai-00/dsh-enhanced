import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import { SourceGrowthRunUnavailableError, isSourceOwnerContinuation, validateSourceGrowthRunBinding, type SourceGrowthRunBinding } from '@dsh-enhanced/assistant-growth-contract'
import { automationDefinitionDigest, type AssistantAutomationsService, type HostAutomationDefinition, type HostAutomationExecutor, type HostAutomationExecutorInput, type HostAutomationExecutorResult } from '@dsh-enhanced/assistant-automations'
import { controlPlaneDigest, expectedSourceRelease, type ControlPlaneStore } from './store.js'
import { awaitSourceSignal, inspectSourceContext } from './source-context.js'
import { assertPluginModificationAllowed, removeSourceJobWorktree, validateScopedPluginFiles, type ScopedPluginFile } from './source-workspace.js'
import { assertManagedVersionPaths } from './source-versioning.js'
import { resolveSourceBaseline, validateSourceBaselineConfig } from './source-baseline.js'
import { removeSourceJobContainer, type SourceBuildConfig } from './source-build.js'
import { inspectSourceRevisionContext, validateSourceRevisionGrant } from './source-revision.js'
import type { CreationCapabilitySourceSnapshot } from './creation-capability-source.js'
import type { PluginCreationVerificationCertificate, PluginRevisionParentBinding } from '@dsh-enhanced/assistant-growth-contract'
import { inspectSourceCreationContext, validateSourceCreationFiles, validateSourceCreationGrant } from './source-creation.js'
import { inheritedEnvironment, type loadTrustConfig } from './trust.js'
import type { PluginSourcePlan } from './types.js'
import type { SourceJobIntent, SourceJobOwnerReceipt, SourceJobProjection, SourceJobRecord, SourceJobsConfig } from './source-job-types.js'

export const SOURCE_JOB_OWNER = 'plugin-control-plane-source'
const EXECUTOR = 'plugin-control-plane-source-check'
const CATALOG = controlPlaneDigest({ executor: EXECUTOR, version: 1, operation: 'isolated-check-pending-plan' })
const CONTINUATION_EXECUTOR = 'plugin-control-plane-source-continuations-v1'
const CONTINUATION_CATALOG = controlPlaneDigest({ executor: CONTINUATION_EXECUTOR, version: 1, operation: 'continue-prepared-source-plan' })
const CONTINUATION_AUTOMATION = 'source-job-prepared-continuations'

export interface SourceJobCaller {
  ownerRouteId: string; principalId: string; principalRecordId: string; principalVersion: number; workspace: string; preset: string
}
export interface EnqueueSourceJobInput {
  gapId: string; name: string; repository: string; files: readonly ScopedPluginFile[]; idempotencyKey: string
  mode?: 'create' | 'revise-created'
  parentPlanId?: string
  /** Host expectation only; authoritative bytes are reread through the registered producer. */
  growthRun?: SourceGrowthRunBinding
  expectedBaseCommit: string; ttlMs: number; owner: SourceJobCaller; signal: AbortSignal; assertCurrent: () => void | Promise<void>
}
export interface SourceJobPorts {
  automations: Pick<AssistantAutomationsService, 'registerHostExecutor' | 'reconcileSystem' | 'reconcileSystemExact'
    | 'pauseSystemOwned' | 'inspectSystemOwnedActivation' | 'inspectSystemOwned'>
  delivery: { validateOwnerRoute(input: { authorityId: string; principalId: string; workspace: string; agentPreset: string }): SourceJobOwnerReceipt }
}
type Trust = Awaited<ReturnType<typeof loadTrustConfig>>
export { SourceGrowthRunUnavailableError } from '@dsh-enhanced/assistant-growth-contract'
class SourceGrowthNativeMismatchError extends Error {}

export function validateSourceJobsConfig(value: SourceJobsConfig, build?: SourceBuildConfig): void {
  const allowed = new Set(['authorityId', 'expiresAt', 'maxSubmissions', 'repository', 'baseline', 'creation', 'revision', 'ownerRouteId', 'principalId', 'workspace', 'preset', 'budgetId', 'budgetAmount'])
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
  if (value.baseline !== undefined) validateSourceBaselineConfig(value.baseline)
  if (value.creation !== undefined) validateSourceCreationGrant(value.creation)
  if (value.revision !== undefined) validateSourceRevisionGrant(value.revision)
}

function projection(job: SourceJobRecord): SourceJobProjection {
  return { id: job.id, name: job.intent.name, gapId: job.intent.gapId, baseCommit: job.intent.baseCommit,
    ...(job.intent.mode === undefined ? {} : { mode: job.intent.mode }),
    status: job.status, createdAt: job.createdAt, expiresAt: job.expiresAt,
    ...(job.planId === undefined ? {} : { planId: job.planId }), ...(job.failureCode === undefined ? {} : { failureCode: job.failureCode }) }
}

/** Persisted intent + native Automations execution. This class owns no scheduler. */
export class SourceJobRuntime {
  private readonly abort = new AbortController()
  private readonly flights = new Set<Promise<unknown>>()
  private readonly growthFlights = new Set<Promise<unknown>>()
  private readonly growthControllers = new Set<AbortController>()
  private readonly authorityDigest: string
  private unregister?: () => void
  private unregisterContinuation?: () => void
  private closing?: Promise<void>
  private active = false
  private readonly generation = randomUUID()
  private readonly continuationNonce: string
  private readonly continuing = new Set<string>()
  private continuationCursor = 0
  private continuationStatus: 'active' | 'paused' | undefined
  private continuationTransition = 0
  constructor(private readonly options: {
    config: SourceJobsConfig; build: SourceBuildConfig; statePath: string; store: ControlPlaneStore; ports: SourceJobPorts
    withGapSourceFence?: <T>(gapId: string, owner: SourceJobOwnerReceipt, callback: () => T) => T
    assertGrowthRun?: (growthRun: SourceGrowthRunBinding, gapId: string, owner: SourceJobOwnerReceipt, generation: boolean) => void
    trust: () => Promise<Trust>
    approvePrepared?: (job: SourceJobRecord, signal: AbortSignal) => Promise<void>
    inspectRevisionParent?: (planId: string) => { name: string; parent: PluginRevisionParentBinding; source: CreationCapabilitySourceSnapshot; certificate: PluginCreationVerificationCertificate }
    verifyPreparedRevision?: (job: SourceJobRecord, signal: AbortSignal) => Promise<void>
    verifyPreparedCreation?: (job: SourceJobRecord, signal: AbortSignal) => Promise<void>
    creationAdoptionEligible?: (planId: string) => boolean
    adoptVerifiedCreation?: (job: SourceJobRecord, signal: AbortSignal) => Promise<void>
    releasePrepared?: (job: SourceJobRecord, signal: AbortSignal) => Promise<void>
    advanceReleased?: (job: SourceJobRecord, signal: AbortSignal) => Promise<void>
    releaseTimeoutMs?: number
    adoptReleased?: (job: SourceJobRecord, signal: AbortSignal, assertCurrent: () => Promise<void>) => Promise<void>
    adoptionTimeoutMs?: number
    prepare: (job: SourceJobRecord, signal: AbortSignal, assertCurrent: () => Promise<void>) => Promise<PluginSourcePlan>
  }) {
    validateSourceJobsConfig(options.config, options.build)
    this.authorityDigest = controlPlaneDigest({ config: options.config, build: options.build })
    this.continuationNonce = controlPlaneDigest({ authority: this.authorityDigest, generation: this.generation })
  }

  start(): void {
    this.options.store.interruptSourceJobs()
    const executor: HostAutomationExecutor = {
      descriptor: { executorId: EXECUTOR, contractVersion: 1, catalogDigest: CATALOG },
      accepts: spec => spec.executorId === EXECUTOR && spec.executorContractVersion === 1 && spec.catalogDigest === CATALOG && spec.runbookId === EXECUTOR && spec.runbookVersion === 1,
      execute: input => {
        const job = this.options.store.getSourceJobByAutomation(input.automationId)
        const flight = this.track(this.execute(input))
        if (job?.intent.creation?.growthRun !== undefined) {
          this.growthFlights.add(flight)
          void flight.then(() => this.growthFlights.delete(flight), () => this.growthFlights.delete(flight))
        }
        return flight
      },
    }
    try {
      this.unregister = this.options.ports.automations.registerHostExecutor(executor)
      if (this.hasContinuations()) this.unregisterContinuation = this.options.ports.automations.registerHostExecutor({
        descriptor: { executorId: CONTINUATION_EXECUTOR, contractVersion: 1, catalogDigest: CONTINUATION_CATALOG },
        accepts: spec => spec.executorId === CONTINUATION_EXECUTOR && spec.executorContractVersion === 1 && spec.catalogDigest === CONTINUATION_CATALOG
          && spec.runbookId === CONTINUATION_EXECUTOR && spec.runbookVersion === 1,
        execute: input => this.track(this.executeContinuations(input)),
      })
      this.active = true
      // Recovery is admitted exclusively through a production cron occurrence.
      // Reading this local durable query intentionally performs no authority call.
      this.reconcileContinuations()
    } catch (error) {
      this.active = false
      // Registration is transactional from this runtime's point of view: an
      // unregistration fault cannot leave the other executor registered or
      // obscure the original registration failure.
      try { this.unregisterContinuation?.() } catch { /* original error wins */ }
      try { this.unregister?.() } catch { /* original error wins */ }
      throw error
    }
    this.reconcileQueued()
  }

  /** Nudge the existing native one-shot registrations after a Host provider appears. */
  reconcileQueued(): void {
    if (!this.active) return
    // Reconcile only queued intents. A previous claim is unknown and never replayed.
    for (let job of this.options.store.listSourceJobs(100)) {
      if (job.status !== 'queued') continue
      try { job = this.refreshQueued(job); if (job.status === 'queued') this.schedule(job) } catch (error) {
        if (error instanceof SourceGrowthRunUnavailableError) continue
        const current = this.options.store.getSourceJob(job.id)
        // A persisted rearm is an in-progress cross-ledger handoff. Retain it
        // for exact native receipt replay after a crash or transient fault.
        if (current?.previousDefinitionHash !== undefined && !(error instanceof SourceGrowthNativeMismatchError)) continue
        if (current?.status === 'queued') this.options.store.settleSourceJob({ id: current.id, revision: current.revision, status: 'failed', failureCode: 'source-job-reconcile-rejected' })
      }
    }
    this.reconcileContinuations()
  }

  /** Provider removal revokes in-flight authority without replaying a claimed job. */
  growthProviderDisposed(): Promise<void> {
    for (const controller of this.growthControllers) controller.abort(new Error('source growth run producer disposed'))
    this.options.store.interruptGrowthSourceJobs()
    if (!this.active) return Promise.allSettled(this.growthFlights).then(() => undefined)
    for (const job of this.options.store.listSourceJobs(100)) {
      if (job.status !== 'queued' || (job.intent.creation?.growthRun ?? job.intent.revision?.growthRun) === undefined || job.definitionHash === undefined) continue
      try {
        const health = this.options.ports.automations.inspectSystemOwned({ owner: SOURCE_JOB_OWNER, automationId: job.automationId })
        if (health.definitionHash !== job.definitionHash) continue
        if (health.automationStatus === 'active') this.options.ports.automations.pauseSystemOwned({ owner: SOURCE_JOB_OWNER,
          operationId: `${job.id}:growth-provider-pause:v${health.definitionVersion}`, automationId: job.automationId,
          definitionHash: job.definitionHash, expectedVersion: health.definitionVersion })
      } catch { /* claim guard remains authoritative */ }
    }
    return Promise.allSettled(this.growthFlights).then(() => undefined)
  }

  private async continuePrepared(job: SourceJobRecord, signal: AbortSignal): Promise<void> {
    if (!job.planId || !this.options.store.getOwnerTaskFailureReference(job.intent.gapId)) return
    if (this.continuing.has(job.id)) return
    this.continuing.add(job.id)
    try { await this.continuePreparedLocked(job, signal) } finally { this.continuing.delete(job.id) }
  }

  private async continuePreparedLocked(job: SourceJobRecord, signal: AbortSignal): Promise<void> {
    if (!job.planId || !this.options.store.getOwnerTaskFailureReference(job.intent.gapId)) return
    const planId = job.planId
    const current = this.options.store.getSourceJob(job.id)
    if (current?.status !== 'prepared' || current.planId !== planId) throw new Error('source job continuation changed')
    job = current
    const initial = this.options.store.getSourcePlan(planId)
    if (initial.mode !== 'modify' && initial.mode !== 'prepared-create' && initial.mode !== 'prepared-revise') return
    // An ordinary grant or plan must not be advanced after expiry. Adoption has
    // its own durable post-release path and is deliberately retained below.
    if (initial.expiresAt <= Date.now() && initial.status !== 'release-complete') throw new Error('source job continuation expired')
    const assertCurrent = async (): Promise<void> => {
      signal.throwIfAborted(); this.assertOwner(job)
      if (controlPlaneDigest(await this.options.trust()) !== job.intent.trustDigest) throw new Error('source job continuation trust changed')
      signal.throwIfAborted(); this.assertOwner(job)
    }
    if (initial.mode === 'prepared-revise') {
      if (job.intent.mode !== 'revise-created' || !job.intent.revision?.growthRun.revisionAcceptance || !initial.sourceRevision?.growthRun.revisionAcceptance) return
      await assertCurrent()
      if (this.options.store.getRevisionVerificationStatus(planId) === undefined && this.options.verifyPreparedRevision) await this.options.verifyPreparedRevision(job, signal)
      return
    }
    if (initial.mode === 'prepared-create') {
      if (job.intent.mode !== 'create'
        || !(job.intent.creation?.growthRun ?? job.intent.revision?.growthRun)?.creationAcceptance || !initial.creation?.growthRun?.creationAcceptance) return
      await assertCurrent()
      if (this.options.store.getCreationVerificationStatus(planId) === undefined && this.options.verifyPreparedCreation) {
        await this.options.verifyPreparedCreation(job, signal)
      }
      if (this.options.store.getCreationVerificationStatus(planId) === 'verified'
        && this.options.creationAdoptionEligible?.(planId) && this.options.adoptVerifiedCreation) {
        await assertCurrent()
        await this.options.adoptVerifiedCreation(job, signal)
      }
      return
    }
    if (this.options.adoptReleased && this.options.store.getSourcePlan(planId).status === 'release-complete') {
      await this.options.adoptReleased(job, signal, assertCurrent)
      return
    }
    await assertCurrent()
    if (this.options.store.getSourcePlan(planId).status === 'pending-approval' && this.options.approvePrepared) {
      await this.options.approvePrepared(job, signal)
    }
    const status = this.options.store.getSourcePlan(planId).status
    if (this.options.releasePrepared && (status === 'approved' || status === 'ready-for-human-review')) {
      await assertCurrent()
      await this.options.releasePrepared(job, signal)
    }
    if (this.options.advanceReleased && expectedSourceRelease(this.options.store.getSourcePlan(planId).status)) {
      await assertCurrent()
      await this.options.advanceReleased(job, signal)
    }
    if (this.options.adoptReleased && this.options.store.getSourcePlan(planId).status === 'release-complete') {
      await assertCurrent()
      await this.options.adoptReleased(job, signal, assertCurrent)
    }
  }

  available(): boolean { return this.active && !this.abort.signal.aborted && Date.now() < this.options.config.expiresAt }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.active = false
      try {
        const current = this.options.ports.automations.inspectSystemOwnedActivation({ owner: SOURCE_JOB_OWNER, automationId: CONTINUATION_AUTOMATION })
        if (current?.activationNonce === this.continuationNonce) this.options.ports.automations.reconcileSystem({ owner: SOURCE_JOB_OWNER,
          automationId: CONTINUATION_AUTOMATION, idempotencyKey: `${CONTINUATION_AUTOMATION}:${this.generation}:pause`, desiredStatus: 'paused', definition: this.continuationDefinition() })
      } finally {
        this.abort.abort(new Error('source job provider disposed'))
        try { this.unregisterContinuation?.() } finally {
          try { this.unregister?.() } finally { await Promise.allSettled(this.flights) }
        }
      }
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
    const current = this.receipt()
    const taskBacked = this.options.store.getOwnerTaskFailureReference(job.intent.gapId) !== undefined
    if (!this.available() || job.expiresAt <= Date.now() || (job.intent.mode === 'create' && (!this.options.config.creation || !job.intent.creation
      || job.intent.creation.grant.expiresAt <= Date.now() || controlPlaneDigest(job.intent.creation.grant) !== controlPlaneDigest(this.options.config.creation)))
      || (job.intent.mode === 'revise-created' && (!this.options.config.revision || !job.intent.revision
        || job.intent.revision.grant.expiresAt <= Date.now() || controlPlaneDigest(job.intent.revision.grant) !== controlPlaneDigest(this.options.config.revision)))
      || job.intent.authority.digest !== this.authorityDigest
      || job.intent.authority.id !== this.options.config.authorityId
      || controlPlaneDigest(job.intent.owner) !== job.intent.ownerDigest
      || (taskBacked ? !isSourceOwnerContinuation(current, job.intent.owner)
        : controlPlaneDigest(current) !== job.intent.ownerDigest)) throw new Error('source job authority changed or expired')
    if (job.intent.revision) {
      const parent = this.options.inspectRevisionParent?.(job.intent.revision.parent.planId)
      if (!parent || parent.name !== job.intent.name || controlPlaneDigest(parent.parent) !== controlPlaneDigest(job.intent.revision.parent)) throw new Error('source revision parent changed')
    }
    this.withGapSource(job.intent.gapId, job.intent.owner, () => this.assertGrowthRun((job.intent.creation?.growthRun ?? job.intent.revision?.growthRun),
      job.intent.mode, job.intent.gapId, job.intent.owner, false))
  }

  private assertGrowthRun(growthRun: SourceGrowthRunBinding | undefined, mode: 'create' | 'revise-created' | undefined,
    gapId: string, owner: SourceJobOwnerReceipt, generation: boolean): void {
    const taskBacked = this.options.store.getOwnerTaskFailureReference(gapId) !== undefined
    if ((mode !== 'create' && mode !== 'revise-created') || !taskBacked) {
      if (growthRun !== undefined) throw new Error('source growth run is outside a task-backed creation')
      return
    }
    if (growthRun === undefined) throw new Error('task-backed creation requires a frozen source growth run')
    validateSourceGrowthRunBinding(growthRun)
    if (!this.options.assertGrowthRun) throw new SourceGrowthRunUnavailableError('source growth run producer unavailable')
    this.options.assertGrowthRun(growthRun, gapId, owner, generation)
  }

  enqueue(input: EnqueueSourceJobInput): Promise<SourceJobProjection> {
    if (input.mode !== 'create' && input.mode !== 'revise-created' && input.growthRun !== undefined) throw new Error('modify source job cannot carry a growth run')
    if (input.mode === 'create' || input.mode === 'revise-created') validateSourceCreationFiles(input.files)
    else {
      if (input.mode !== undefined) throw new Error('invalid source job mode')
      validateScopedPluginFiles(input.files)
      if (this.options.build.versioning === 'patch') assertManagedVersionPaths(input.files)
    }
    if ((input.mode === 'revise-created') !== (typeof input.parentPlanId === 'string' && input.parentPlanId.length > 0)) throw new Error('source revision parent is missing or outside revision mode')
    return this.track(this.enqueueOwned({ ...input, files: structuredClone(input.files), owner: structuredClone(input.owner) }))
  }

  private async enqueueOwned(input: EnqueueSourceJobInput): Promise<SourceJobProjection> {
    const signal = AbortSignal.any([input.signal, this.abort.signal, AbortSignal.timeout(15_000)])
    const assertCurrent = async (): Promise<void> => { signal.throwIfAborted(); await awaitSourceSignal(signal, input.assertCurrent); this.withGapSource(input.gapId, this.assertCaller(input.owner), () => {}); if (!this.available()) throw new Error('source job authority unavailable'); signal.throwIfAborted() }
    await assertCurrent()
    if (input.mode === 'create' || input.mode === 'revise-created') validateSourceCreationFiles(input.files)
    else {
      validateScopedPluginFiles(input.files)
      if (this.options.build.versioning === 'patch') assertManagedVersionPaths(input.files)
      assertPluginModificationAllowed(input.name)
    }
    if (typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(input.idempotencyKey)
      || !Number.isSafeInteger(input.ttlMs) || input.ttlMs < 900_000 || input.ttlMs > 86_400_000) throw new Error('invalid source job request')
    const config = this.options.config
    if (input.mode === 'create' && (config.creation === undefined || config.creation.expiresAt <= Date.now())) throw new Error('source creation grant unavailable or expired')
    if (input.mode === 'revise-created' && (config.revision === undefined || config.revision.expiresAt <= Date.now())) throw new Error('source revision grant unavailable or expired')
    if (input.repository !== config.repository || await realpath(input.repository) !== config.repository) throw new Error('source job repository mismatch')
    const currentOwner = this.assertCaller(input.owner)
    const reference = this.options.store.getOwnerTaskFailureReference(input.gapId)
    if (input.mode === 'revise-created' && !reference) throw new Error('revision requires an authenticated owner task failure')
    const owner = reference?.owner ?? currentOwner
    if (reference && !isSourceOwnerContinuation(currentOwner, owner)) throw new Error('source job task owner changed')
    this.withGapSource(input.gapId, currentOwner, () => this.assertGrowthRun(input.growthRun, input.mode, input.gapId, owner, true))
    const parent = input.mode === 'revise-created' ? this.options.inspectRevisionParent?.(input.parentPlanId!) : undefined
    if (input.mode === 'revise-created' && (!parent || parent.name !== input.name)) throw new Error('adopted revision parent unavailable or mismatched')
    const trust = await awaitSourceSignal(signal, this.options.trust)
    for (const outstanding of this.options.store.listSourceJobs(1)) this.refreshQueued(outstanding)
    const token = createHash('sha256').update(config.authorityId).update('\0').update(input.idempotencyKey).digest('hex')
    const id = `source-job-${token}`
    const prior = this.options.store.getSourceJob(id)
    if (prior !== undefined) {
      const frozen = prior.intent
      if (frozen.authority.digest !== this.authorityDigest || frozen.ownerDigest !== controlPlaneDigest(owner) || frozen.trustDigest !== controlPlaneDigest(trust)
        || frozen.mode !== input.mode || (input.mode === 'create' && (controlPlaneDigest(frozen.creation?.grant) !== controlPlaneDigest(config.creation)
          || (frozen.creation?.growthRun === undefined) !== (input.growthRun === undefined)
          || (input.growthRun !== undefined && controlPlaneDigest(frozen.creation?.growthRun) !== controlPlaneDigest(input.growthRun))))
        || (input.mode === 'revise-created' && (controlPlaneDigest(frozen.revision?.grant) !== controlPlaneDigest(config.revision)
          || controlPlaneDigest(frozen.revision?.parent) !== controlPlaneDigest(parent!.parent)
          || controlPlaneDigest(frozen.revision?.growthRun) !== controlPlaneDigest(input.growthRun)))
        || frozen.repository !== input.repository || frozen.name !== input.name || frozen.gapId !== input.gapId || frozen.baseCommit !== input.expectedBaseCommit
        || frozen.ttlMs !== input.ttlMs || controlPlaneDigest(frozen.files) !== controlPlaneDigest(input.files)) throw new Error('source job idempotency conflict')
      await assertCurrent()
      if (prior.status === 'queued') this.scheduleOrFail(prior)
      return projection(this.options.store.getSourceJob(id)!)
    }
    const gap = this.options.store.getGap(input.gapId)
    if (gap.status !== 'open' || gap.candidateId !== undefined) throw new Error('source job gap is not open')
    const environment = inheritedEnvironment(trust)
    const baselineCommit = config.baseline === undefined ? undefined : await resolveSourceBaseline({ repository: config.repository,
      config: config.baseline, environment, signal, assertCurrent, trust,
      readHistory: () => this.options.store.getSourceBaselineHistory(config.repository),
      readMaintenance: () => this.options.store.getSourceMaintenanceRecords(config.repository) })
    const context = { repository: config.repository, name: input.name, paths: [], baseCommit: input.expectedBaseCommit,
      ...(baselineCommit === undefined ? {} : { baselineCommit }), environment, signal, assertCurrent }
    const source = input.mode === 'create'
      ? await inspectSourceCreationContext({ ...context, grant: config.creation! })
      : input.mode === 'revise-created'
      ? await inspectSourceRevisionContext({ ...context, grant: config.revision!, parent: parent!.parent, parentSource: parent!.source, parentCertificate: parent!.certificate })
      : await inspectSourceContext(context)
    const intent: SourceJobIntent = {
      authority: { id: config.authorityId, digest: this.authorityDigest, expiresAt: config.expiresAt, maxSubmissions: config.maxSubmissions },
      owner, ownerDigest: controlPlaneDigest(owner), trustDigest: controlPlaneDigest(trust), repository: config.repository, name: input.name,
      ...(config.baseline === undefined ? {} : { baseline: structuredClone(config.baseline) }),
      ...(input.mode === 'create' ? { mode: 'create' as const, creation: { grant: structuredClone(config.creation!), generatorDigest: (source as Awaited<ReturnType<typeof inspectSourceCreationContext>>).generatorDigest,
        ...(input.growthRun === undefined ? {} : { growthRun: structuredClone(input.growthRun) }) } } : {}),
      ...(input.mode === 'revise-created' ? { mode: 'revise-created' as const, revision: { grant: structuredClone(config.revision!),
        generatorDigest: (source as Awaited<ReturnType<typeof inspectSourceRevisionContext>>).generatorDigest, parent: structuredClone(parent!.parent), growthRun: structuredClone(input.growthRun!) } } : {}),
      gapId: gap.id, gapRevision: gap.revision, gapDigest: controlPlaneDigest(gap), baseCommit: source.baseCommit,
      files: structuredClone(input.files), ttlMs: input.ttlMs, build: structuredClone(this.options.build),
      worktree: join(this.options.statePath, 'source-worktrees', `worktree-job-${token}`), containerName: `dsh-source-job-${token}`,
    }
    await assertCurrent()
    // Synchronous acceptance and registration: no Agent signal is persisted.
    const job = this.withGapSource(gap.id, owner, () => {
      this.assertGrowthRun(input.growthRun, input.mode, gap.id, owner, true)
      return this.options.store.enqueueSourceJob({ id, automationId: id, idempotencyKey: input.idempotencyKey, intent })
    })
    if (job.status === 'queued') this.scheduleOrFail(job)
    return projection(this.options.store.getSourceJob(id)!)
  }

  inspect(input: { id: string; owner: SourceJobCaller }): SourceJobProjection {
    const owner = this.assertCaller(input.owner)
    const job = this.options.store.getSourceJob(input.id)
    // Inspection and cleanup may cross a session binding. A task-backed job
    // retains its frozen owner digest and may continue under the same owner.
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
    let providerUnavailable = false
    if (job.intent.mode === 'create' && this.options.store.getOwnerTaskFailureReference(job.intent.gapId) !== undefined
      && (job.intent.creation?.growthRun ?? job.intent.revision?.growthRun) === undefined) code = 'source-job-growth-run-missing'
    else {
      try { this.withGapSource(job.intent.gapId, job.intent.owner, () => { providerUnavailable = this.growthProducerUnavailable(job) }) }
      catch { code = 'source-job-task-source-changed' }
    }
    if (job.expiresAt <= Date.now()) code = 'source-job-expired'
    else if (code === undefined && job.definitionHash !== undefined && !providerUnavailable && (job.intent.creation?.growthRun ?? job.intent.revision?.growthRun) === undefined) {
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

  private growthProducerUnavailable(job: SourceJobRecord): boolean {
    try { this.assertGrowthRun((job.intent.creation?.growthRun ?? job.intent.revision?.growthRun), job.intent.mode, job.intent.gapId, job.intent.owner, false); return false }
    catch (error) { if (error instanceof SourceGrowthRunUnavailableError) return true; throw error }
  }

  private definition(job: SourceJobRecord): HostAutomationDefinition {
    const config = this.options.config
    return { name: `Source check: ${job.intent.name}`, schedule: { kind: 'at', at: new Date(job.dispatchAt ?? job.createdAt + 1000).toISOString() },
      workspace: config.workspace, agentPreset: config.preset, timeoutMs: job.intent.build.timeoutMs + 120_000 + (this.options.advanceReleased ? this.options.releaseTimeoutMs ?? 40_000 : 0) + (this.options.adoptReleased ? this.options.adoptionTimeoutMs ?? 60_000 : 0),
      misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0, principal: config.principalId,
      ...(config.budgetId === undefined ? {} : { budgetId: config.budgetId, budgetAmount: config.budgetAmount! }),
      execution: { kind: 'host', executorId: EXECUTOR, executorContractVersion: 1, runbookId: EXECUTOR, runbookVersion: 1, catalogDigest: CATALOG,
        targetScope: { workspace: config.workspace, preset: config.preset }, scopeDigest: controlPlaneDigest([config.workspace, config.preset]),
        ownerRouteId: config.ownerRouteId, activationNonce: job.intentDigest } }
  }

  private schedule(job: SourceJobRecord): void {
    this.assertOwner(job)
    const automations = this.options.ports.automations
    if (job.definitionHash !== undefined && (job.intent.creation?.growthRun ?? job.intent.revision?.growthRun) !== undefined && job.occurrenceId === undefined) {
      const health = automations.inspectSystemOwned({ owner: SOURCE_JOB_OWNER, automationId: job.automationId })
      if (health.definitionHash !== job.definitionHash) throw new Error('source job native definition changed before rearm')
      const dueAt = job.dispatchAt ?? job.createdAt + 1000
      const terminal = health.latestTerminalRuns.production
      if ((health.automationStatus === 'paused' && dueAt <= Date.now())
        || (terminal !== undefined && terminal.immutableContext.state === 'verified'
          && terminal.immutableContext.definitionHash === job.definitionHash && terminal.createdAt >= job.createdAt)) {
        job = this.withGapSource(job.intent.gapId, job.intent.owner, () => {
          this.assertGrowthRun(job.intent.creation!.growthRun, job.intent.mode, job.intent.gapId, job.intent.owner, false)
          return this.options.store.rearmQueuedGrowthSourceJob({ id: job.id, revision: job.revision,
            priorDefinitionHash: job.definitionHash!, priorDefinitionVersion: health.definitionVersion, dispatchAt: Date.now() + 1000 })
        })
      }
    }
    const definition = this.definition(job)
    const expectedHash = automationDefinitionDigest(definition)
    if (job.previousDefinitionHash !== undefined) {
      if (typeof automations.reconcileSystemExact !== 'function') throw new SourceGrowthRunUnavailableError('exact native source rearm unavailable')
      const health = automations.inspectSystemOwned({ owner: SOURCE_JOB_OWNER, automationId: job.automationId })
      const activation = automations.inspectSystemOwnedActivation({ owner: SOURCE_JOB_OWNER, automationId: job.automationId })
      if (activation?.activationNonce !== job.intentDigest || activation.ownerRouteId !== this.options.config.ownerRouteId
        || !((health.definitionHash === job.previousDefinitionHash && health.definitionVersion === job.previousDefinitionVersion)
          || (health.definitionHash === expectedHash && health.definitionVersion === job.previousDefinitionVersion! + 1))) {
        throw new SourceGrowthNativeMismatchError('source job native rearm lineage changed')
      }
      automations.reconcileSystemExact({ owner: SOURCE_JOB_OWNER, automationId: job.automationId,
        idempotencyKey: `${job.id}:rearm:${job.dispatchAt}`, desiredStatus: 'active', definition,
        expectedDefinitionHash: job.previousDefinitionHash, expectedVersion: job.previousDefinitionVersion! })
      const activated = automations.inspectSystemOwned({ owner: SOURCE_JOB_OWNER, automationId: job.automationId })
      if (activated.definitionHash !== expectedHash || activated.definitionVersion !== job.previousDefinitionVersion! + 1
        || activated.automationStatus !== 'active') throw new SourceGrowthNativeMismatchError('source job exact native rearm was not active')
      this.assertOwner(job)
      this.options.store.bindSourceJobDefinition({ id: job.id, revision: job.revision, definitionHash: expectedHash })
      return
    }
    if (job.definitionHash === undefined) {
      const prior = job.previousDefinitionHash
      const existing = (() => {
        try { return automations.inspectSystemOwnedActivation({ owner: SOURCE_JOB_OWNER, automationId: job.automationId }) }
        catch { return undefined }
      })()
      if (existing !== undefined && (existing.activationNonce !== job.intentDigest || existing.ownerRouteId !== this.options.config.ownerRouteId
        || (existing.definitionHash !== expectedHash && existing.definitionHash !== prior))) {
        throw new Error('source job native definition differs from persisted rearm')
      }
      automations.reconcileSystem({ owner: SOURCE_JOB_OWNER, automationId: job.automationId,
        idempotencyKey: `${job.id}:prepare:${job.dispatchAt ?? job.createdAt + 1000}`, desiredStatus: 'paused', definition })
      const registered = automations.inspectSystemOwnedActivation({ owner: SOURCE_JOB_OWNER, automationId: job.automationId })
      if (registered === undefined || registered.activationNonce !== job.intentDigest || registered.ownerRouteId !== this.options.config.ownerRouteId
        || registered.definitionHash !== expectedHash) throw new Error('source job registration binding mismatch')
      job = this.options.store.bindSourceJobDefinition({ id: job.id, revision: job.revision, definitionHash: registered.definitionHash })
    }
    const current = automations.inspectSystemOwnedActivation({ owner: SOURCE_JOB_OWNER, automationId: job.automationId })
    if (current === undefined || current.definitionHash !== job.definitionHash || current.activationNonce !== job.intentDigest || current.ownerRouteId !== this.options.config.ownerRouteId) throw new Error('source job automation changed')
    const health = automations.inspectSystemOwned({ owner: SOURCE_JOB_OWNER, automationId: job.automationId })
    if (health.definitionHash !== job.definitionHash) throw new Error('source job native definition changed')
    automations.reconcileSystem({ owner: SOURCE_JOB_OWNER, automationId: job.automationId,
      idempotencyKey: `${job.id}:activate:v${health.definitionVersion}`, desiredStatus: 'active', definition })
    const activated = automations.inspectSystemOwned({ owner: SOURCE_JOB_OWNER, automationId: job.automationId })
    if (activated.definitionHash !== job.definitionHash || activated.automationStatus !== 'active') throw new Error('source job native activation did not become active')
  }

  private hasContinuations(): boolean {
    return !!(this.options.approvePrepared || this.options.verifyPreparedRevision || this.options.verifyPreparedCreation || this.options.adoptVerifiedCreation || this.options.releasePrepared || this.options.advanceReleased || this.options.adoptReleased)
  }

  private continuationJobs(): readonly SourceJobRecord[] {
    if (!this.hasContinuations()) return []
    return this.options.store.listPreparedSourceApprovalJobs(this.options.releasePrepared !== undefined, this.options.advanceReleased !== undefined,
      this.options.adoptReleased !== undefined, this.options.verifyPreparedCreation !== undefined, this.options.adoptVerifiedCreation !== undefined, this.options.verifyPreparedRevision !== undefined)
      .filter(job => this.eligibleContinuation(job))
  }

  /** Admission reads durable state and validates the current owner; it never invokes continuation approval or release hooks. */
  private eligibleContinuation(job: SourceJobRecord): boolean {
    if (!job.planId || job.status !== 'prepared') return false
    let plan: PluginSourcePlan
    try { plan = this.options.store.getSourcePlan(job.planId) } catch { return false }
    if (plan.mode === 'prepared-revise') {
      if (job.intent.mode !== 'revise-created' || plan.status !== 'pending-approval' || !plan.sourceRevision?.growthRun.revisionAcceptance
        || this.options.store.getRevisionVerificationStatus(plan.id) !== undefined || !this.options.verifyPreparedRevision) return false
      try { this.assertOwner(job) } catch { return false }
      return plan.expiresAt > Date.now()
    }
    if (plan.mode === 'prepared-create') {
      if (job.intent.mode !== 'create' || plan.status !== 'pending-approval'
        || !job.intent.creation?.growthRun?.creationAcceptance || !plan.creation?.growthRun?.creationAcceptance) return false
      const verification = this.options.store.getCreationVerificationStatus(plan.id)
      const verify = verification === undefined && this.options.verifyPreparedCreation !== undefined
      const adopt = verification === 'verified' && this.options.adoptVerifiedCreation !== undefined
        && this.options.creationAdoptionEligible?.(plan.id) === true
      if (!verify && !adopt) return false
      if (job.intent.authority.digest !== this.authorityDigest || job.intent.authority.id !== this.options.config.authorityId) return false
      try { this.assertOwner(job); this.withGapSource(job.intent.gapId, job.intent.owner, () => {
        this.assertGrowthRun(job.intent.creation?.growthRun, job.intent.mode, job.intent.gapId, job.intent.owner, false)
      }) } catch { return false }
      return plan.expiresAt > Date.now()
    }
    if (plan.mode !== 'modify' || job.intent.mode === 'create') return false
    const adoption = plan.status === 'release-complete' ? this.options.store.findSourceAdoption(plan.id) : undefined
    const recovery = adoption !== undefined && ((adoption.status === 'approved' && adoption.dossier.handoff !== undefined) || ['staging', 'awaiting-reload', 'awaiting-readiness', 'awaiting-live-tasks', 'awaiting-effect-blocked-replay', 'awaiting-shadow', 'awaiting-canary', 'awaiting-soak', 'awaiting-health', 'commit-pending', 'rollback-pending'].includes(adoption.status))
    if (recovery) return this.options.adoptReleased !== undefined
    if (job.intent.authority.digest !== this.authorityDigest || job.intent.authority.id !== this.options.config.authorityId) return false
    try { this.assertOwner(job) } catch { return false }
    if (plan.expiresAt <= Date.now()) return false
    if (plan.status === 'pending-approval') return this.options.approvePrepared !== undefined
    if (plan.status === 'approved' || plan.status === 'ready-for-human-review') return this.options.releasePrepared !== undefined
    if (expectedSourceRelease(plan.status)) return this.options.advanceReleased !== undefined
    return plan.status === 'release-complete' && this.options.adoptReleased !== undefined
  }

  private continuationTimeoutMs(): number {
    const release = this.options.releaseTimeoutMs ?? 40_000, adoption = this.options.adoptionTimeoutMs ?? 60_000
    const needed = (this.options.adoptReleased ? adoption : 0) + (this.options.advanceReleased ? release + 40_000 : this.options.releasePrepared ? 40_000 : 10_000)
    return Math.max(this.options.verifyPreparedCreation ? 1_800_000 : 10_000, needed)
  }

  private continuationSignalTimeoutMs(job: SourceJobRecord): number {
    if (job.planId) {
      const plan = this.options.store.getSourcePlan(job.planId), adoption = plan.status === 'release-complete' ? this.options.store.findSourceAdoption(plan.id) : undefined
      if (adoption && ((adoption.status === 'approved' && adoption.dossier.handoff !== undefined) || ['staging', 'awaiting-reload', 'awaiting-readiness', 'awaiting-live-tasks', 'awaiting-effect-blocked-replay', 'awaiting-shadow', 'awaiting-canary', 'awaiting-soak', 'awaiting-health', 'commit-pending', 'rollback-pending'].includes(adoption.status))) return this.continuationTimeoutMs()
    }
    return Math.max(1, Math.min(this.continuationTimeoutMs(), this.options.config.expiresAt - Date.now()))
  }

  private continuationDefinition(): HostAutomationDefinition {
    const config = this.options.config
    return { name: 'Continue prepared source plans', schedule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
      workspace: config.workspace, agentPreset: config.preset, timeoutMs: this.continuationTimeoutMs(), misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0,
      principal: config.principalId, ...(config.budgetId === undefined ? {} : { budgetId: config.budgetId, budgetAmount: config.budgetAmount! }),
      execution: { kind: 'host', executorId: CONTINUATION_EXECUTOR, executorContractVersion: 1, runbookId: CONTINUATION_EXECUTOR, runbookVersion: 1,
        catalogDigest: CONTINUATION_CATALOG, targetScope: { workspace: config.workspace, preset: config.preset }, scopeDigest: controlPlaneDigest([config.workspace, config.preset]),
        ownerRouteId: config.ownerRouteId, activationNonce: this.continuationNonce } }
  }

  /** Reconciliation only changes native activation; it never calls an authority. */
  private reconcileContinuations(force = false): void {
    if (!this.active || !this.hasContinuations()) return
    const definition = this.continuationDefinition(), desiredStatus = this.continuationJobs().length ? 'active' as const : 'paused' as const
    if (!force && desiredStatus === this.continuationStatus) return
    this.options.ports.automations.reconcileSystem({ owner: SOURCE_JOB_OWNER, automationId: CONTINUATION_AUTOMATION,
      idempotencyKey: `${CONTINUATION_AUTOMATION}:${this.generation}:${++this.continuationTransition}:${desiredStatus}`, desiredStatus, definition })
    this.continuationStatus = desiredStatus
  }

  private async executeContinuations(input: HostAutomationExecutorInput): Promise<HostAutomationExecutorResult> {
    const failure = (unknown: boolean): HostAutomationExecutorResult => ({ outcome: unknown ? 'unknown' : 'failed', failureClass: unknown ? 'unknown' : 'configuration', failurePhase: 'host-execution', failureCode: 'source-continuation-rejected', sideEffectState: unknown ? 'unknown' : 'none', retryability: unknown ? 'unsafe' : 'after-intervention' })
    try {
      const registration = this.options.ports.automations.inspectSystemOwnedActivation({ owner: SOURCE_JOB_OWNER, automationId: CONTINUATION_AUTOMATION })
      if (!this.hasContinuations() || !this.active || input.executionMode !== 'production' || input.automationId !== CONTINUATION_AUTOMATION
        || input.activationNonce !== this.continuationNonce || input.catalogDigest !== CONTINUATION_CATALOG || input.definitionHash !== registration?.definitionHash
        || registration.activationNonce !== this.continuationNonce || input.ownerRouteId !== this.options.config.ownerRouteId || input.principal !== this.options.config.principalId
        || input.targetScope.workspace !== this.options.config.workspace || input.targetScope.preset !== this.options.config.preset) throw new Error('source continuation dispatch changed')
      const jobs = this.continuationJobs()
      let unsettled = false
      if (jobs.length) {
        // One budget-admitted occurrence advances one durable row. The cursor
        // is intentionally in-memory; a restart returning to the first row is
        // safe because every release transition remains independently claimed.
        const job = jobs[this.continuationCursor++ % jobs.length]!
        const signal = AbortSignal.any([this.abort.signal, input.signal, AbortSignal.timeout(this.continuationSignalTimeoutMs(job))])
        signal.throwIfAborted()
        try { await this.continuePrepared(job, signal); signal.throwIfAborted() } catch {
          // The durable release claim decides whether an external action was
          // dispatched.  Do not report this uncertain continuation as success.
          unsettled = true
        }
      }
      this.reconcileContinuations()
      if (unsettled) return { outcome: 'unknown', failureClass: 'infrastructure', failurePhase: 'host-execution', failureCode: 'source-continuation-unsettled', sideEffectState: 'unknown', retryability: 'unsafe' }
      return { outcome: 'succeeded', failureClass: 'none', failurePhase: 'none', failureCode: 'none', sideEffectState: 'possible', retryability: 'unsafe' }
    } catch { return failure(this.abort.signal.aborted || input.signal.aborted) }
  }

  private scheduleOrFail(job: SourceJobRecord): void {
    try { this.schedule(job) } catch (error) {
      if (error instanceof SourceGrowthRunUnavailableError) return
      const current = this.options.store.getSourceJob(job.id)
      if (current?.previousDefinitionHash !== undefined && !(error instanceof SourceGrowthNativeMismatchError)) return
      if (current?.status === 'queued') this.options.store.settleSourceJob({ id: current.id, revision: current.revision, status: 'failed', failureCode: 'source-job-registration-rejected' })
    }
  }

  private async execute(input: HostAutomationExecutorInput): Promise<HostAutomationExecutorResult> {
    let job = this.options.store.getSourceJobByAutomation(input.automationId)
    const failure = (unknown: boolean): HostAutomationExecutorResult => ({ outcome: unknown ? 'unknown' : 'failed', failureClass: unknown ? 'unknown' : 'configuration', failurePhase: 'host-execution', failureCode: 'source-job-rejected', sideEffectState: unknown ? 'unknown' : 'none', retryability: unknown ? 'unsafe' : 'after-intervention' })
    if (job === undefined || job.status !== 'queued') return failure(job?.status === 'unknown' || job?.status === 'running')
    // A stale occurrence from before a persisted rearm can never claim this
    // job. It has acquired no source resource, so leave the queued CAS intact.
    if ((job.intent.creation?.growthRun ?? job.intent.revision?.growthRun) !== undefined && input.definitionHash !== job.definitionHash) {
      const expectedPending = job.previousDefinitionHash === undefined ? undefined : automationDefinitionDigest(this.definition(job))
      if (expectedPending === input.definitionHash && input.executionMode === 'production'
        && input.activationNonce === job.intentDigest && input.catalogDigest === CATALOG
        && input.ownerRouteId === job.intent.owner.authorityId && input.principal === job.intent.owner.principalId
        && input.targetScope.workspace === job.intent.owner.workspace && input.targetScope.preset === job.intent.owner.agentPreset) {
        try {
          // The new native occurrence reached us before its cross-ledger DB
          // acknowledgement. It has not claimed source resources. Bind the
          // exact native receipt, then persist another one-shot before this
          // occurrence can be considered consumed.
          this.schedule(job)
          const rebound = this.options.store.getSourceJob(job.id)
          if (rebound?.status === 'queued' && rebound.definitionHash === input.definitionHash && rebound.occurrenceId === undefined) {
            const health = this.options.ports.automations.inspectSystemOwned({ owner: SOURCE_JOB_OWNER, automationId: job.automationId })
            if (health.definitionHash !== rebound.definitionHash) throw new Error('source job premature occurrence native binding changed')
            const pending = this.withGapSource(rebound.intent.gapId, rebound.intent.owner, () => {
              this.assertGrowthRun(rebound.intent.creation?.growthRun, rebound.intent.mode, rebound.intent.gapId, rebound.intent.owner, false)
              return this.options.store.rearmQueuedGrowthSourceJob({ id: rebound.id, revision: rebound.revision,
                priorDefinitionHash: rebound.definitionHash!, priorDefinitionVersion: health.definitionVersion, dispatchAt: Date.now() + 1000 })
            })
            this.schedule(pending)
          }
        } catch { /* persisted queued state remains fail-closed for exact recovery */ }
      }
      return failure(false)
    }
    let claimed = false
    const growthController = (job.intent.creation?.growthRun ?? job.intent.revision?.growthRun) === undefined ? undefined : new AbortController()
    if (growthController) this.growthControllers.add(growthController)
    const signal = AbortSignal.any([input.signal, this.abort.signal,
      ...(growthController ? [growthController.signal] : []),
      AbortSignal.timeout(Math.max(1, Math.min(job.intent.build.timeoutMs + 120_000 + (this.options.verifyPreparedCreation ? 1_800_000 : 0)
        + (this.options.advanceReleased ? this.options.releaseTimeoutMs ?? 40_000 : 0) + (this.options.adoptReleased ? this.options.adoptionTimeoutMs ?? 60_000 : 0), job.expiresAt - Date.now())))])
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
      if ((owned.intent.mode === 'create' ? this.options.verifyPreparedCreation !== undefined
        : owned.intent.mode === 'revise-created' ? this.options.verifyPreparedRevision !== undefined : !!(this.options.approvePrepared || this.options.releasePrepared || this.options.advanceReleased || this.options.adoptReleased))
        && this.options.store.getOwnerTaskFailureReference(owned.intent.gapId)) {
        this.reconcileContinuations()
        this.assertOwner(owned)
        await this.continuePrepared(this.options.store.getSourceJob(owned.id)!, signal)
        this.reconcileContinuations()
      }
      return { outcome: 'succeeded', failureClass: 'none', failurePhase: 'none', failureCode: 'none', sideEffectState: 'possible', retryability: 'unsafe' }
    } catch (error) {
      const current = this.options.store.getSourceJob(job.id)
      if (!claimed && error instanceof SourceGrowthRunUnavailableError) return failure(false)
      if (!claimed && current?.status === 'queued'
        && (current.revision !== job.revision || current.definitionHash !== input.definitionHash)) return failure(false)
      if (current?.status === 'queued' || (current?.status === 'running' && current.occurrenceId === input.occurrenceId)) {
        this.options.store.settleSourceJob({ id: current.id, revision: current.revision, status: claimed ? 'unknown' : 'failed', failureCode: claimed ? 'source-job-interrupted' : 'source-job-preflight-rejected' })
      }
      return failure(claimed)
    } finally {
      if (growthController) this.growthControllers.delete(growthController)
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
