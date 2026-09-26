import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { AssistantAutomationsService, HostAutomationDefinition, HostAutomationExecutorInput, HostAutomationExecutorResult } from '@dsh-enhanced/assistant-automations'
import type { AssistantDeliveryService, OwnerForegroundLearningTask } from '@dsh-enhanced/assistant-delivery'
import type { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import { controlPlaneDigest, type ControlPlaneStore } from './store.js'
import { validateSourceApprovalClientConfig, type SourceApprovalClientConfig } from './source-approval-client.js'
import { requestLiveQualification } from './live-qualification-client.js'
import { assertLiveQualificationBatch, liveQualificationDigest, liveQualificationId,
  type LiveQualificationBatch, type LiveQualificationReceipt } from './live-qualification.js'
import { trustedForegroundSource, trustedForegroundVote, withTrustedForegroundVoteFence, taskObservationOwner } from './task-observation-evidence.js'
import { resolveTrustKey, type PluginControlTrustConfig } from './trust.js'
import type { ForegroundDeploymentRecord } from './foreground-deployment.js'
import type { TaskObservationOwner, TaskObservationVote } from './task-observation-types.js'
import type { PluginActivationPlan } from './types.js'

const OWNER = 'plugin-control-plane-live-qualification'
const EXECUTOR = 'plugin-control-plane-live-qualification-v1'
const CATALOG = controlPlaneDigest({ executor: EXECUTOR, version: 1 })
const same = (a: unknown, b: unknown): boolean => controlPlaneDigest(a) === controlPlaneDigest(b)
type Evaluation = Pick<AssistantEvaluationService, 'canonicalHostScope' | 'getTrustedForegroundLearningProjection' | 'withTrustedCanonicalTaskWriterFence' | 'onTrustedTaskChange'>
type Delivery = Pick<AssistantDeliveryService, 'validateOwnerRoute' | 'inspectOwnerForegroundLearningTask'>
type Automations = Pick<AssistantAutomationsService, 'registerHostExecutor' | 'reconcileSystem' | 'inspectSystemOwnedActivation'>

export interface LiveQualificationConfig {
  scope: { ownerRouteId: string; principalId: string; workspace: string; preset: string }
  profilePath: string
  timeoutMs: number
  budgetId: string
  budgetAmount: number
  authority: SourceApprovalClientConfig
}

export function validateLiveQualificationConfig(config: LiveQualificationConfig): void {
  const exact = (value: object, keys: string): boolean => !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === keys
  const integer = (value: number, min: number, max: number): boolean => Number.isSafeInteger(value) && value >= min && value <= max
  const text = (value: string): boolean => typeof value === 'string' && value.length > 0 && value.length <= 4096
    && value.normalize('NFC').trim() === value && !/[\p{Cc}]/u.test(value)
  if (!exact(config, 'authority,budgetAmount,budgetId,profilePath,scope,timeoutMs')
    || !exact(config.scope, 'ownerRouteId,preset,principalId,workspace')
    || !integer(config.timeoutMs, 1000, 300_000) || !integer(config.budgetAmount, 1, 10_000_000)
    || !text(config.budgetId) || config.budgetId.length > 128 || !Object.values(config.scope).every(text)
    || !text(config.profilePath) || ![config.profilePath, config.scope.workspace].every(path => isAbsolute(path) && resolve(path) === path)) {
    throw new Error('invalid liveQualification configuration')
  }
  validateSourceApprovalClientConfig(config.authority)
}

/** A finite native-automation witness for real foreground tasks, without a second Agent loop. */
export class LiveQualificationRuntime {
  private readonly lane: string
  private readonly configDigest: string
  private readonly trustDigest: string
  private readonly scanId: string
  private readonly generation = randomUUID()
  private readonly activationNonce: string
  private readonly abort = new AbortController()
  private readonly flights = new Set<Promise<unknown>>()
  private unregister?: () => void
  private unsubscribe?: () => void
  private closing?: Promise<void>
  private active = false
  private runtimeWasAvailable = false
  private scanning = false
  private lastError: string | null = null

  constructor(private readonly options: {
    config: LiveQualificationConfig; store: ControlPlaneStore; trust: PluginControlTrustConfig
    evaluation: Evaluation; delivery: Delivery; automations: Automations
    assertCurrent(): void
    assertRuntime(planId: string): void
    runtimeAvailable(): boolean
    qualificationSource(planId: string): OwnerForegroundLearningTask
    request?: (batch: LiveQualificationBatch, signal: AbortSignal) => Promise<LiveQualificationReceipt>
  }) {
    validateLiveQualificationConfig(options.config)
    this.lane = controlPlaneDigest({ scope: options.config.scope, profilePath: options.config.profilePath })
    this.configDigest = controlPlaneDigest(options.config)
    this.trustDigest = controlPlaneDigest(options.trust)
    this.scanId = `live-qualification-scan-${this.lane}`
    this.activationNonce = controlPlaneDigest({ config: this.configDigest, generation: this.generation })
  }

  start(): void {
    this.unregister = this.options.automations.registerHostExecutor({
      descriptor: { executorId: EXECUTOR, contractVersion: 1, catalogDigest: CATALOG },
      accepts: spec => spec.executorId === EXECUTOR && spec.executorContractVersion === 1 && spec.catalogDigest === CATALOG
        && spec.runbookId === 'qualify' && spec.runbookVersion === 1,
      execute: input => {
        const flight = this.execute(input)
        this.flights.add(flight)
        void flight.finally(() => this.flights.delete(flight)).catch(() => {})
        return flight
      },
    })
    this.active = true
    this.unsubscribe = this.options.evaluation.onTrustedTaskChange(() => this.scan())
    this.options.automations.reconcileSystem({ owner: OWNER, automationId: this.scanId,
      idempotencyKey: `${this.scanId}:${this.generation}`, desiredStatus: 'active', definition: this.definition() })
    this.scan()
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.active = false
      try {
        const current = this.options.automations.inspectSystemOwnedActivation({ owner: OWNER, automationId: this.scanId })
        if (current?.activationNonce === this.activationNonce) this.options.automations.reconcileSystem({ owner: OWNER,
          automationId: this.scanId, idempotencyKey: `${this.scanId}:${this.generation}:pause`, desiredStatus: 'paused', definition: this.definition() })
      } finally {
        this.abort.abort()
        try { this.unsubscribe?.() } finally {
          try { this.unregister?.() } finally {
            await Promise.allSettled(this.flights)
            this.options.store.close()
          }
        }
      }
    })()
  }

  health = () => ({ connected: this.active, lastError: this.lastError })

  private current(): void {
    this.abort.signal.throwIfAborted()
    if (!this.active) throw new Error('live qualification runtime unavailable')
    this.options.assertCurrent()
  }
  private owner(): TaskObservationOwner {
    this.current()
    const scope = this.options.config.scope
    return taskObservationOwner(this.options.delivery.validateOwnerRoute({ authorityId: scope.ownerRouteId,
      principalId: scope.principalId, workspace: scope.workspace, agentPreset: scope.preset }))
  }
  private source(inboxId: string): OwnerForegroundLearningTask | undefined {
    return trustedForegroundSource({ owner: this.owner(), inboxId,
      evaluation: this.options.evaluation, delivery: this.options.delivery })
  }
  private vote(deployment: ForegroundDeploymentRecord, source: OwnerForegroundLearningTask | undefined,
    startedAt: number, deadlineAt: number, historical: boolean): TaskObservationVote | undefined {
    if (deployment.execution?.modelSelectionState !== 'frozen' || !deployment.execution.modelSelection
      || deployment.execution.completedAt < startedAt || deployment.execution.completedAt >= deadlineAt
      || deployment.task.dispatchedAt < startedAt || deployment.task.dispatchedAt >= deadlineAt) return undefined
    return trustedForegroundVote({ deployment, source, now: Date.now(),
      lookbackMs: historical ? Number.MAX_SAFE_INTEGER : deadlineAt - startedAt })
  }
  private sameDeployment(batch: LiveQualificationBatch, deployment: ForegroundDeploymentRecord): boolean {
    const readiness = deployment.readiness
    return readiness.planId === batch.planId && readiness.planDigest === batch.planDigest
      && readiness.installationId === batch.installationId && readiness.profilePath === batch.profilePath
      && readiness.activationId === batch.activationId && readiness.fence === batch.fence
      && readiness.hostGeneration === batch.hostGeneration && readiness.receiptDigest === batch.readinessDigest
  }
  private cohort(plan: PluginActivationPlan, window: ReturnType<ControlPlaneStore['getLiveQualificationWindow']>,
    owner: TaskObservationOwner, historical: boolean): { votes: TaskObservationVote[]; blocked: boolean; overflow: boolean } {
    const deployments = this.options.store.listLiveQualificationDeployments(plan.id, 1001)
    const votes: TaskObservationVote[] = []
    let blocked = false
    for (const deployment of deployments) {
      if (deployment.task.dispatchedAt < window.startedAt || deployment.task.dispatchedAt >= window.deadlineAt) continue
      const readiness = deployment.readiness
      if (readiness.planId !== plan.id || readiness.planDigest !== plan.digest || readiness.installationId !== plan.installationId
        || readiness.profilePath !== plan.target.profilePath || readiness.activationId !== plan.activation?.id
        || readiness.fence !== plan.activation?.fence || readiness.hostGeneration !== window.hostGeneration
        || readiness.receiptDigest !== window.readinessDigest
        || deployment.task.owner.principalRecordId !== owner.principalRecordId
        || deployment.task.owner.principalVersion !== owner.principalVersion
        || deployment.task.scope.workspace !== owner.workspace || deployment.task.scope.preset !== owner.agentPreset
        || deployment.state !== 'observed' || deployment.execution?.modelSelectionState !== 'frozen'
        || !deployment.execution.modelSelection) { blocked = true; continue }
      const vote = this.vote(deployment, this.source(deployment.task.inboxId), window.startedAt, window.deadlineAt, historical)
      if (vote) votes.push(vote)
    }
    return { votes, blocked, overflow: deployments.length === 1001 }
  }
  private read(batch: LiveQualificationBatch, historical = false): OwnerForegroundLearningTask[] {
    this.current()
    assertLiveQualificationBatch(batch)
    const plan = this.options.store.getPlan(batch.planId)
    const window = this.options.store.getLiveQualificationWindow(batch.planId)
    if (batch.lane !== this.lane || batch.configDigest !== this.configDigest || batch.trustDigest !== this.trustDigest
      || batch.profilePath !== this.options.config.profilePath || !same(batch.owner, this.owner())
      || !same(batch.terms, plan.dossier.liveQualification) || batch.planDigest !== plan.digest
      || batch.installationId !== plan.installationId || batch.activationId !== plan.activation?.id
      || batch.fence !== plan.activation?.fence || batch.startedAt !== window.startedAt
      || batch.deadlineAt !== window.deadlineAt || batch.readinessDigest !== window.readinessDigest
      || batch.hostGeneration !== window.hostGeneration || (!historical && (Date.now() >= batch.deadlineAt || Date.now() >= batch.expiresAt))) {
      throw new Error('live qualification authority, exposure, or deadline changed')
    }
    const sources = batch.votes.map(expected => {
      const deployment = this.options.store.getForegroundDeployment(expected.inboxId), source = this.source(expected.inboxId)
      if (!deployment || !source || !this.sameDeployment(batch, deployment)
        || !same(this.vote(deployment, source, batch.startedAt, batch.deadlineAt, historical), expected)) {
        throw new Error('live qualification source changed')
      }
      return source
    })
    // Re-evaluate every started task in the bounded window, not just signed
    // votes. Pending/unknown work and later negative feedback veto qualification.
    if (batch.votes.every(vote => vote.status === 'achieved')) {
      const cohort = this.cohort(plan, window, batch.owner, historical)
      if (cohort.overflow || cohort.blocked || cohort.votes.some(vote => vote.status === 'not-achieved')) {
        throw new Error('live qualification cohort is blocked or has a negative task')
      }
    }
    const original = this.options.qualificationSource(batch.planId)
    if (original.canonical.objective?.status !== 'not-achieved'
      || original.ownerRevision?.action === 'withdraw'
      || !same(taskObservationOwner(original.owner), batch.owner)) {
      throw new Error('live qualification original owner failure changed')
    }
    this.options.assertRuntime(batch.planId)
    return sources
  }
  private fence<T>(batch: LiveQualificationBatch, callback: () => T, historical = false): T {
    this.read(batch, historical)
    if (this.options.store.getLiveQualification(batch.id)) this.options.store.assertCurrentLiveQualification(batch.id)
    return withTrustedForegroundVoteFence({ evaluation: this.options.evaluation, owner: batch.owner, votes: batch.votes,
      read: () => this.read(batch, historical), additionalSource: () => this.options.qualificationSource(batch.planId), callback })
  }

  /** Synchronous source audit and batch creation; only native cron may request authority. */
  scan = (): void => {
    if (!this.active || this.scanning) return
    this.scanning = true
    try {
      this.current()
      this.lastError = null
      if (!this.options.runtimeAvailable() && !this.runtimeWasAvailable) return
      if (this.options.runtimeAvailable()) this.runtimeWasAvailable = true
      const store = this.options.store, now = Date.now(), config = this.options.config
      for (const plan of store.listLiveQualificationPlans(config.profilePath, 100)) {
        if (!plan.dossier.liveQualification || plan.target.profilePath !== config.profilePath) continue
        const records = store.listLiveQualifications(plan.id, 100)
        // A frozen batch is never replaced with newly selected votes after a correction.
        if (records.length) {
          for (const record of records) {
            if (record.state === 'stale') continue
            const historical = plan.status === 'activated'
            try { this.fence(record.batch, () => {}, historical) }
            catch {
              if (record.state === 'applied' && record.receipt?.disposition === 'qualified') {
                store.invalidateLiveQualification({ planId: plan.id, batchId: record.batch.id,
                  reason: 'live-qualification-unconfirmable' })
              } else if (record.state === 'pending' || record.state === 'signed') {
                store.staleLiveQualification(record.batch.id)
                if (plan.status === 'awaiting-live-tasks') store.requestActivationRollback({ planId: plan.id,
                  expectedRevision: plan.revision, fence: record.batch.fence, failureCode: 'live-qualification-unconfirmable' })
              }
            }
          }
          continue
        }
        if (plan.status !== 'awaiting-live-tasks' || now >= plan.expiresAt) continue
        const window = store.getLiveQualificationWindow(plan.id)
        if (now >= window.deadlineAt || window.startedAt > now) continue
        const owner = this.owner()
        const cohort = this.cohort(plan, window, owner, false)
        const failures = cohort.votes.filter(vote => vote.status === 'not-achieved')
        if (cohort.overflow && failures.length === 0) continue
        if (failures.length === 0 && cohort.blocked) continue
        const votes = (failures.length > 0 ? failures : cohort.votes.filter(vote => vote.status === 'achieved'))
          .slice(0, 32).sort((a, b) => a.inboxId.localeCompare(b.inboxId))
        if (votes.length === 0 || (failures.length === 0 && votes.length < plan.dossier.liveQualification.minimumTasks)) continue
        const core = { lane: this.lane, configDigest: this.configDigest, trustDigest: this.trustDigest,
          planId: plan.id, planDigest: plan.digest, installationId: plan.installationId, profilePath: config.profilePath,
          owner, terms: plan.dossier.liveQualification, activationId: plan.activation!.id, fence: plan.activation!.fence,
          startedAt: window.startedAt, deadlineAt: window.deadlineAt, readinessDigest: window.readinessDigest,
          hostGeneration: window.hostGeneration, votes }
        const id = liveQualificationId(core)
        const unsigned = { schemaVersion: 1 as const, kind: 'dsh-live-qualification' as const, id, ...core,
          createdAt: now, expiresAt: window.deadlineAt + 300_000 }
        const batch: LiveQualificationBatch = { ...unsigned, digest: liveQualificationDigest(unsigned) }
        try { this.fence(batch, () => store.putLiveQualification(batch)) }
        catch { /* A racing feedback revision or Host sample cannot create a batch. */ }
      }
    } catch (error) { this.lastError = error instanceof Error ? error.message.slice(0, 200) : 'live qualification scan failed' }
    finally { this.scanning = false }
  }

  /** Synchronous final-commit guard; the Store calls this inside its CAS. */
  withQualificationFence<T>(planId: string, callback: () => T): T {
    this.current()
    const records = this.options.store.listLiveQualifications(planId, 100).filter(record =>
      record.state === 'applied' && record.receipt?.disposition === 'qualified')
    if (records.length !== 1) throw new Error('live qualification has no unique qualified receipt')
    const batch = records[0]!.batch
    if (batch.planId !== planId) throw new Error('live qualification plan changed')
    return this.fence(batch, callback)
  }

  private definition(): HostAutomationDefinition {
    const { scope, timeoutMs, budgetId, budgetAmount } = this.options.config
    return { name: 'Qualify live deployed plugin tasks', schedule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
      workspace: scope.workspace, agentPreset: scope.preset, timeoutMs, misfire: { kind: 'latest' }, overlap: 'skip',
      retrySafety: 'never', maxRetries: 0, principal: scope.principalId, budgetId, budgetAmount,
      execution: { kind: 'host', executorId: EXECUTOR, executorContractVersion: 1, runbookId: 'qualify', runbookVersion: 1,
        catalogDigest: CATALOG, targetScope: { workspace: scope.workspace, preset: scope.preset },
        scopeDigest: controlPlaneDigest([scope.workspace, scope.preset]), ownerRouteId: scope.ownerRouteId,
        activationNonce: this.activationNonce } }
  }

  private async execute(input: HostAutomationExecutorInput): Promise<HostAutomationExecutorResult> {
    let began = false
    try {
      const scope = this.options.config.scope
      const registration = this.options.automations.inspectSystemOwnedActivation({ owner: OWNER, automationId: this.scanId })
      if (input.executionMode !== 'production' || input.automationId !== this.scanId || input.activationNonce !== this.activationNonce
        || input.definitionHash !== registration?.definitionHash || input.catalogDigest !== CATALOG
        || registration.activationNonce !== this.activationNonce || input.ownerRouteId !== scope.ownerRouteId
        || input.principal !== scope.principalId || input.targetScope.workspace !== scope.workspace
        || input.targetScope.preset !== scope.preset) throw new Error('live qualification dispatch changed')
      const signal = AbortSignal.any([this.abort.signal, input.signal, AbortSignal.timeout(this.options.config.timeoutMs)])
      signal.throwIfAborted(); began = true
      // Registration is a sufficient native lifecycle barrier. A missing
      // observer at the first actual cron tick is no longer a startup race.
      if (!this.options.runtimeAvailable()) this.runtimeWasAvailable = true
      this.scan()
      const owner = this.owner()
      if (owner.authorityId !== scope.ownerRouteId || owner.principalId !== scope.principalId
        || owner.workspace !== scope.workspace || owner.agentPreset !== scope.preset) throw new Error('live qualification owner route changed')
      if (!this.options.runtimeAvailable()) throw new Error('live qualification Host observer unavailable')
      for (const plan of this.options.store.listLiveQualificationPlans(this.options.config.profilePath, 100)) {
        signal.throwIfAborted(); this.current()
        if (plan.status !== 'awaiting-live-tasks') continue
        const records = this.options.store.listLiveQualifications(plan.id, 100)
        for (const record of records) {
          if (record.state !== 'pending' && record.state !== 'signed') continue
          try { this.fence(record.batch, () => {}) }
          catch {
            this.options.store.staleLiveQualification(record.batch.id)
            this.options.store.requestActivationRollback({ planId: plan.id, expectedRevision: plan.revision,
              fence: record.batch.fence, failureCode: 'live-qualification-unconfirmable' })
            continue
          }
          const receipt = record.receipt ?? await (this.options.request?.(record.batch, signal)
            ?? requestLiveQualification(this.options.config.authority, { protocol: 'dsh-live-qualification/v1',
              batchId: record.batch.id, batchDigest: record.batch.digest }, signal))
          signal.throwIfAborted(); this.current()
          const key = resolveTrustKey(this.options.trust, 'host-attestation', receipt.authority, receipt.keyId)
          await this.options.store.applyLiveQualification({ receipt, publicKeyPem: key.publicKeyPem,
            withSourceFence: callback => { signal.throwIfAborted(); return this.fence(record.batch, callback) } })
        }
      }
      if (this.lastError) throw new Error(this.lastError)
      return { outcome: 'succeeded', failureClass: 'none', failurePhase: 'none', failureCode: 'none', sideEffectState: 'possible', retryability: 'unsafe' }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message.slice(0, 200) : 'live qualification failed'
      return { outcome: began ? 'unknown' : 'failed', failureClass: began ? 'unknown' : 'configuration', failurePhase: 'host-execution',
        failureCode: 'live-qualification-rejected', sideEffectState: began ? 'unknown' : 'none', retryability: began ? 'unsafe' : 'after-intervention' }
    }
  }
}
