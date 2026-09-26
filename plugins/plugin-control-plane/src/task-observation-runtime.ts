import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { AssistantAutomationsService, HostAutomationDefinition, HostAutomationExecutorInput, HostAutomationExecutorResult } from '@dsh-enhanced/assistant-automations'
import type { AssistantDeliveryService, OwnerForegroundLearningTask } from '@dsh-enhanced/assistant-delivery'
import type { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import { controlPlaneDigest, type ControlPlaneStore } from './store.js'
import { taskObservationDigest, taskObservationId } from './task-observation-store.js'
import { validateSourceApprovalClientConfig } from './source-approval-client.js'
import { requestTaskObservation } from './task-observation-client.js'
import { Ed25519PostActivationObservationAuthority } from './post-activation.js'
import { resolveTrustKey, type PluginControlTrustConfig } from './trust.js'
import { trustedForegroundSource, trustedForegroundVote, withTrustedForegroundVoteFence, taskObservationOwner } from './task-observation-evidence.js'
import type { ForegroundDeploymentRecord } from './foreground-deployment.js'
import type { TaskObservationBatch, TaskObservationConfig, TaskObservationOwner, TaskObservationVote } from './task-observation-types.js'
import type { PostActivationObservationReceipt } from './types.js'

const OWNER = 'plugin-control-plane-task-observations'
const EXECUTOR = 'plugin-control-plane-task-observations-v1'
const CATALOG = controlPlaneDigest({ executor: EXECUTOR, version: 1 })
const same = (a: unknown, b: unknown): boolean => controlPlaneDigest(a) === controlPlaneDigest(b)
type Evaluation = Pick<AssistantEvaluationService, 'canonicalHostScope' | 'getTrustedForegroundLearningProjection' | 'withTrustedCanonicalTaskWriterFence' | 'onTrustedTaskChange'>
type Delivery = Pick<AssistantDeliveryService, 'validateOwnerRoute' | 'inspectOwnerForegroundLearningTask'>
type Automations = Pick<AssistantAutomationsService, 'registerHostExecutor' | 'reconcileSystem' | 'inspectSystemOwnedActivation'>

export { taskObservationOwner } from './task-observation-evidence.js'

export function validateTaskObservationConfig(config: TaskObservationConfig): void {
  const exact = (value: object, keys: string): boolean => !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === keys
  const integer = (value: number, min: number, max: number): boolean => Number.isSafeInteger(value) && value >= min && value <= max
  const text = (value: string): boolean => typeof value === 'string' && value.length > 0 && value.length <= 4096
    && value.normalize('NFC').trim() === value && !/[\p{Cc}]/u.test(value)
  if (!exact(config, 'authority,budgetAmount,budgetId,policy,profilePath,scope,timeoutMs')
    || !exact(config.policy, 'expiresAt,id,lookbackMs,maximumChecks,maximumObservations,minimumChecks')
    || !exact(config.scope, 'ownerRouteId,preset,principalId,workspace')
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(config.policy.id)
    || !integer(config.policy.expiresAt, 1, 8_640_000_000_000_000)
    || !integer(config.policy.maximumObservations, 1, 1000)
    || !integer(config.policy.minimumChecks, 1, 32) || !integer(config.policy.maximumChecks, config.policy.minimumChecks, 32)
    || !integer(config.policy.lookbackMs, 1000, 30 * 86_400_000) || !integer(config.timeoutMs, 1000, 300_000)
    || !text(config.budgetId) || config.budgetId.length > 128 || !integer(config.budgetAmount, 1, 10_000_000)
    || !Object.values(config.scope).every(text) || !text(config.profilePath)
    || ![config.profilePath, config.scope.workspace].every(path => isAbsolute(path) && resolve(path) === path)) throw new Error('invalid taskObservations configuration')
  validateSourceApprovalClientConfig(config.authority)
}

/** Trusted real-task cohorts; no model calls and no private scheduler. */
export class TaskObservationRuntime {
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
  private scanning = false
  private lastError: string | null = null
  constructor(private readonly options: {
    config: TaskObservationConfig; store: ControlPlaneStore; trust: PluginControlTrustConfig
    evaluation: Evaluation; delivery: Delivery; automations: Automations
    assertCurrent(): void
    rollback(planId: string, signal: AbortSignal): Promise<unknown>
    request?: (batch: TaskObservationBatch, signal: AbortSignal) => Promise<PostActivationObservationReceipt>
  }) {
    validateTaskObservationConfig(options.config)
    this.lane = controlPlaneDigest({ scope: options.config.scope, profilePath: options.config.profilePath })
    this.configDigest = controlPlaneDigest(options.config)
    this.trustDigest = controlPlaneDigest(options.trust)
    this.scanId = `task-observation-scan-${this.lane}`
    this.activationNonce = controlPlaneDigest({ config: this.configDigest, generation: this.generation })
  }

  start(): void {
    this.unregister = this.options.automations.registerHostExecutor({
      descriptor: { executorId: EXECUTOR, contractVersion: 1, catalogDigest: CATALOG },
      accepts: spec => spec.executorId === EXECUTOR && spec.executorContractVersion === 1 && spec.catalogDigest === CATALOG
        && spec.runbookId === 'observe' && spec.runbookVersion === 1,
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
    if (!this.active) throw new Error('task observation runtime unavailable')
    this.options.assertCurrent()
  }
  private owner(): TaskObservationOwner {
    this.current()
    const scope = this.options.config.scope
    return taskObservationOwner(this.options.delivery.validateOwnerRoute({ authorityId: scope.ownerRouteId,
      principalId: scope.principalId, workspace: scope.workspace, agentPreset: scope.preset }))
  }
  private source(inboxId: string): OwnerForegroundLearningTask | undefined {
    const owner = this.owner()
    return trustedForegroundSource({ owner, inboxId, evaluation: this.options.evaluation, delivery: this.options.delivery })
  }
  private vote(deployment: ForegroundDeploymentRecord, source: OwnerForegroundLearningTask | undefined): TaskObservationVote | undefined {
    return trustedForegroundVote({ deployment, source, now: Date.now(), lookbackMs: this.options.config.policy.lookbackMs })
  }
  private read(batch: TaskObservationBatch): OwnerForegroundLearningTask[] {
    this.current()
    if (batch.configDigest !== this.configDigest || batch.trustDigest !== this.trustDigest || batch.expiresAt <= Date.now()
      || !same(batch.owner, this.owner())) throw new Error('task observation authority changed or expired')
    return batch.votes.map(expected => {
      const deployment = this.options.store.getForegroundDeployment(expected.inboxId), source = this.source(expected.inboxId)
      if (!deployment || !source || !same(this.vote(deployment, source), expected)) throw new Error('task observation source changed')
      return source
    })
  }
  private fence<T>(batch: TaskObservationBatch, callback: () => T): T {
    this.read(batch)
    if (this.options.store.getTaskObservation(batch.id)) this.options.store.assertCurrentTaskObservation(batch.id)
    return withTrustedForegroundVoteFence({ evaluation: this.options.evaluation, owner: batch.owner, votes: batch.votes,
      read: () => this.read(batch), callback })
  }

  /** Bounded synchronous nudge; the persisted native cron owns asynchronous work. */
  scan = (): void => {
    if (!this.active || this.scanning) return
    this.scanning = true
    try {
      this.current()
      this.lastError = null
      const store = this.options.store, now = Date.now(), config = this.options.config
      const prior = store.listTaskObservations(this.lane, 1000)
      for (const record of prior.filter(record => record.state === 'pending' || record.state === 'signed')) {
        try { this.fence(record.batch, () => {}); return }
        catch { store.staleTaskObservation(record.batch.id) }
      }
      if (now >= config.policy.expiresAt) return
      const owner = this.owner()
      const groups = new Map<string, { deployment: ForegroundDeploymentRecord; votes: TaskObservationVote[] }>()
      for (const deployment of store.listObservedForegroundDeployments(config.profilePath, 1000)) {
        const vote = this.vote(deployment, this.source(deployment.task.inboxId))
        if (!vote || store.hasAppliedTaskObservationVote(this.lane, vote.inboxId, vote.projection.digest)) continue
        let group = groups.get(deployment.readiness.planId)
        if (!group) groups.set(deployment.readiness.planId, group = { deployment, votes: [] })
        if (group.votes.length < config.policy.maximumChecks) group.votes.push(vote)
      }
      for (const { deployment, votes } of groups.values()) {
        if (votes.length < config.policy.minimumChecks) continue
        votes.sort((a, b) => a.inboxId.localeCompare(b.inboxId))
        const readiness = deployment.readiness
        const core = { lane: this.lane, configDigest: this.configDigest, trustDigest: this.trustDigest,
          planId: readiness.planId, planDigest: readiness.planDigest, installationId: readiness.installationId,
          profilePath: config.profilePath, owner, policy: config.policy, hostGeneration: readiness.hostGeneration, votes }
        const id = taskObservationId(core)
        if (store.getTaskObservation(id)) continue
        const unsigned = { schemaVersion: 1 as const, kind: 'dsh-task-observation' as const, id, ...core, createdAt: now,
          expiresAt: Math.min(config.policy.expiresAt, ...votes.map(vote => vote.completedAt + config.policy.lookbackMs)) }
        const batch = { ...unsigned, digest: taskObservationDigest(unsigned) }
        try { this.fence(batch, () => store.putTaskObservation(batch)); break }
        catch { /* Historical deployments and racing current feedback are ineligible. */ }
      }
      this.lastError = null
    } catch (error) { this.lastError = error instanceof Error ? error.message.slice(0, 200) : 'task observation scan failed' }
    finally { this.scanning = false }
  }

  private definition(): HostAutomationDefinition {
    const { scope, timeoutMs, budgetId, budgetAmount } = this.options.config
    return { name: 'Observe deployed plugin task feedback', schedule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
      workspace: scope.workspace, agentPreset: scope.preset, timeoutMs, misfire: { kind: 'latest' }, overlap: 'skip',
      retrySafety: 'never', maxRetries: 0, principal: scope.principalId, budgetId, budgetAmount,
      execution: { kind: 'host', executorId: EXECUTOR, executorContractVersion: 1, runbookId: 'observe', runbookVersion: 1,
        catalogDigest: CATALOG, targetScope: { workspace: scope.workspace, preset: scope.preset },
        scopeDigest: controlPlaneDigest([scope.workspace, scope.preset]), ownerRouteId: scope.ownerRouteId, activationNonce: this.activationNonce } }
  }

  private async execute(input: HostAutomationExecutorInput): Promise<HostAutomationExecutorResult> {
    let began = false
    try {
      const owner = this.owner()
      const registration = this.options.automations.inspectSystemOwnedActivation({ owner: OWNER, automationId: this.scanId })
      if (input.executionMode !== 'production' || input.automationId !== this.scanId || input.activationNonce !== this.activationNonce
        || input.definitionHash !== registration?.definitionHash || input.catalogDigest !== CATALOG
        || registration.activationNonce !== this.activationNonce || input.ownerRouteId !== owner.authorityId
        || input.principal !== owner.principalId || input.targetScope.workspace !== owner.workspace
        || input.targetScope.preset !== owner.agentPreset) throw new Error('task observation dispatch changed')
      const signal = AbortSignal.any([this.abort.signal, input.signal, AbortSignal.timeout(this.options.config.timeoutMs)])
      signal.throwIfAborted(); began = true
      this.scan()
      for (const record of this.options.store.listTaskObservations(this.lane, 1000)) {
        signal.throwIfAborted(); this.current()
        if (record.state === 'applied' && record.receipt?.disposition === 'regressed') {
          // A committed rollback obligation survives feedback changes and grant expiry.
          if (record.batch.profilePath !== this.options.config.profilePath || record.batch.trustDigest !== this.trustDigest) continue
          if (this.options.store.getPlan(record.batch.planId).status !== 'rolled-back') await this.options.rollback(record.batch.planId, signal)
          continue
        }
        if (record.state !== 'pending' && record.state !== 'signed') continue
        try { this.fence(record.batch, () => {}) } catch { this.options.store.staleTaskObservation(record.batch.id); continue }
        const receipt = record.receipt ?? await (this.options.request?.(record.batch, signal)
          ?? requestTaskObservation(this.options.config.authority, { protocol: 'dsh-task-observation/v1',
            observationId: record.batch.id, observationDigest: record.batch.digest }, signal))
        signal.throwIfAborted(); this.current()
        if (receipt.expiresAt <= Date.now()) { this.options.store.staleTaskObservation(record.batch.id); continue }
        try { this.fence(record.batch, () => {}) } catch { this.options.store.staleTaskObservation(record.batch.id); continue }
        const key = resolveTrustKey(this.options.trust, 'host-attestation', receipt.authority, receipt.keyId)
        const authority = new Ed25519PostActivationObservationAuthority(key.publicKeyPem, key.authority, key.keyId, { receiptTtlMs: 300_000 })
        try {
          await authority.verify(receipt, this.options.store.getPlan(record.batch.planId), this.options.store.getActivationWatch(record.batch.planId).exact)
          signal.throwIfAborted()
          this.fence(record.batch, () => this.options.store.signTaskObservation(record.batch.id, receipt))
        } catch (error) {
          this.options.store.staleTaskObservation(record.batch.id)
          throw error
        }
        await this.options.store.recordPostActivationObservation({ receipt, taskObservationId: record.batch.id,
          idempotencyKey: `post-activation-observation:${receipt.observationId}`,
          withSourceFence: callback => { signal.throwIfAborted(); return this.fence(record.batch, callback) },
          resolveAuthority: value => {
            this.current()
            const key = resolveTrustKey(this.options.trust, 'host-attestation', value.authority, value.keyId)
            return new Ed25519PostActivationObservationAuthority(key.publicKeyPem, key.authority, key.keyId, { receiptTtlMs: 300_000 })
          } })
        if (receipt.disposition === 'regressed') await this.options.rollback(record.batch.planId, signal)
      }
      if (this.lastError) throw new Error(this.lastError)
      return { outcome: 'succeeded', failureClass: 'none', failurePhase: 'none', failureCode: 'none', sideEffectState: 'possible', retryability: 'unsafe' }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message.slice(0, 200) : 'task observation failed'
      return { outcome: began ? 'unknown' : 'failed', failureClass: began ? 'unknown' : 'configuration', failurePhase: 'host-execution',
        failureCode: 'task-observation-rejected', sideEffectState: began ? 'unknown' : 'none', retryability: began ? 'unsafe' : 'after-intervention' }
    }
  }
}
