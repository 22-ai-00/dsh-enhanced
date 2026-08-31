import { createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Schema from '@deepseek-ai/schemastery'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import {
  DELIVERY_PREFERENCE_PROJECTION_PROTOCOL,
  isTrustedDeliveryPreferenceProducer,
  type DeliveryAdmissionCursor,
  type DeliveryLearningControlReceipt,
  type DeliveryLearningControlRequest,
  type DeliveryLearningExplanation,
  type DeliveryLearningScopeStatus,
  type DeliveryOwnerLineage,
  type DeliveryPreferenceCompletion,
  type DeliveryPreferenceEvent,
  type DeliveryPreferenceFeedbackReceipt,
  type DeliveryPreferenceObservation,
  type DeliveryPreferenceProducer,
  type DeliveryPreferenceRegistration,
} from '@dsh-enhanced/assistant-delivery'
import type { AssistantPolicyService, PolicyDecision } from '@dsh-enhanced/assistant-policy'
import { PreferenceStore, PreferenceStoreError, canonicalPreferenceScope } from './store.js'
import type {
  PreferenceForgetResult,
  PreferenceAdmissionCursor,
  PreferenceHostActivationResult,
  PreferenceHostMaintenanceResult,
  PreferencePrincipalLineage,
  PreferenceScopeLearningStatus,
  PreferenceScopePrincipalFence,
} from './store.js'
import { registerPreferenceTools } from './tools.js'
import type {
  PreferenceHealth,
  PreferenceHypothesis,
  PreferenceLimits,
  PreferenceMaintenanceResult,
  PreferenceObservationInput,
  PreferenceReview,
  PreferenceRollbackReason,
  PreferenceScope,
  StoredPreferenceSignal,
} from './types.js'

export interface Config {
  enabled?: boolean
  databasePath: string
  signalTtlMs?: number
  hypothesisTtlMs?: number
  minSignalsForActivation?: number
  minBehavioralSignalsForActivation?: number
  autonomousT1Enabled?: boolean
  minConfidenceBps?: number
  maxContradictionBps?: number
  maxActiveOverlays?: number
  maxReviewHypotheses?: number
  maxOverlayBytes?: number
  maintenanceIntervalMs?: number
  maintenanceBatchSize?: number
}

const configSchema = Schema.object({
  enabled: Schema.boolean().default(true),
  databasePath: Schema.string().required(),
  signalTtlMs: Schema.number().step(1).min(86_400_000).max(31_536_000_000).default(7_776_000_000),
  hypothesisTtlMs: Schema.number().step(1).min(3_600_000).max(2_592_000_000).default(2_592_000_000),
  minSignalsForActivation: Schema.number().step(1).min(2).max(20).default(2),
  minBehavioralSignalsForActivation: Schema.number().step(1).min(4).max(20).default(6),
  autonomousT1Enabled: Schema.boolean().default(true),
  minConfidenceBps: Schema.number().step(1).min(6_000).max(9_500).default(7_500),
  maxContradictionBps: Schema.number().step(1).min(0).max(4_000).default(2_500),
  maxActiveOverlays: Schema.number().step(1).min(1).max(8).default(6),
  maxReviewHypotheses: Schema.number().step(1).min(1).max(50).default(20),
  maxOverlayBytes: Schema.number().step(1).min(256).max(2_048).default(2_048),
  maintenanceIntervalMs: Schema.number().step(1).min(60_000).max(86_400_000).default(3_600_000),
  maintenanceBatchSize: Schema.number().step(1).min(1).max(5_000).default(500),
}) as Schema<Config>

export type PreferenceLearningErrorCode =
  | 'disabled'
  | 'disposed'
  | 'invalid-input'
  | 'invalid-scope'
  | 'missing-agent'
  | 'missing-principal'
  | 'policy-denied'
  | 'unattested-signal'

export class PreferenceLearningError extends Error {
  constructor(readonly code: PreferenceLearningErrorCode, message: string) {
    super(message)
    this.name = 'PreferenceLearningError'
  }
}

function decisionError(decision: PolicyDecision): PreferenceLearningError {
  return new PreferenceLearningError('policy-denied', `preference access denied: ${decision.reasonCode}`)
}

/** Fixed Policy subject used by the non-model supervised-growth runbook. */
export const HOST_RECOVERY_BACKGROUND_ID = 'dsh-enhanced-assistant-recovery'

const preferenceHostScopeBrand: unique symbol = Symbol('preference-learning.host-scope')

/**
 * An immutable Host-owned scope. It can only be obtained through the canonical
 * constructor below; spreading/serializing it deliberately removes the brand.
 */
export interface PreferenceHostScope extends Readonly<PreferenceScope> {
  readonly [preferenceHostScopeBrand]: true
}

export function canonicalPreferenceHostScope(input: PreferenceScope): PreferenceHostScope {
  try {
    const { scope } = canonicalPreferenceScope(input)
    const branded = { workspace: scope.workspace, preset: scope.preset } as PreferenceHostScope
    Object.defineProperty(branded, preferenceHostScopeBrand, {
      value: true, enumerable: false, configurable: false, writable: false,
    })
    return Object.freeze(branded)
  } catch {
    throw new PreferenceLearningError('invalid-scope', 'Host preference scope is invalid')
  }
}

function hostText(
  value: unknown,
  label: string,
  maxBytes: number,
  code: Extract<PreferenceLearningErrorCode, 'invalid-input' | 'missing-principal'> = 'invalid-input',
): string {
  if (typeof value !== 'string') {
    throw new PreferenceLearningError(code, `${label} must be a string`)
  }
  const normalized = value.normalize('NFC').trim()
  if (normalized === '' || Buffer.byteLength(normalized, 'utf8') > maxBytes || hasControl(normalized)) {
    throw new PreferenceLearningError(code, `${label} is invalid`)
  }
  return normalized
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    if (codePoint <= 0x1f || codePoint === 0x7f) return true
  }
  return false
}

function exactHostScope(input: PreferenceHostScope): PreferenceHostScope {
  if (typeof input !== 'object' || input === null || !Object.isFrozen(input)
    || input[preferenceHostScopeBrand] !== true) {
    throw new PreferenceLearningError(
      'invalid-scope',
      'Host preference operations require a canonical immutable scope',
    )
  }
  const canonical = canonicalPreferenceHostScope(input)
  if (canonical.workspace !== input.workspace || canonical.preset !== input.preset) {
    throw new PreferenceLearningError('invalid-scope', 'Host preference scope is not canonical')
  }
  return input
}

function isDeliveryPreferenceProducer(value: unknown): value is DeliveryPreferenceProducer {
  return isTrustedDeliveryPreferenceProducer(value)
    && typeof (value as Partial<DeliveryPreferenceProducer>)
      .trustedPreferenceProducerGeneration === 'function'
    && typeof (value as Partial<DeliveryPreferenceProducer>).registerTrustedPreferenceSink === 'function'
    && typeof (value as Partial<DeliveryPreferenceProducer>).currentPreferenceTurn === 'function'
    && typeof (value as Partial<DeliveryPreferenceProducer>).preferencePrincipalForAgent === 'function'
}

export interface PreferenceHostOperation {
  scope: PreferenceHostScope
  /** Authenticated owner identity supplied by the Host route, never a model. */
  principal: string
  /** Exact durable Delivery owner-row lineage. */
  principalLineage: Readonly<DeliveryOwnerLineage>
  /**
   * Exact Preference owner generation. Planning operations may omit it and
   * receive the current generation; mutating an activation always requires it.
   */
  ownerGeneration?: number
  /** Exact fixed-run receipt/run identifier used for Policy budget idempotency. */
  operationId: string
}

export interface PreferenceHostActivationCandidate {
  hypothesisId: string
  expectedVersion: number
  ownerGeneration: number
  principalLineage: Readonly<DeliveryOwnerLineage>
}

/** Current exact Preference owner fence for one Policy-authorized Host scope. */
export interface PreferenceHostOwnerFence {
  ownerGeneration: number
  principalLineage: Readonly<DeliveryOwnerLineage>
}

declare module '@deepseek-ai/cordis' {
  interface Context { assistantPreferenceLearning: PreferenceLearningService }
}

export class PreferenceLearningService extends Service {
  static Config = configSchema
  static inject = ['assistantPolicy', 'systemPrompt']
  private readonly store: PreferenceStore
  private readonly policy: AssistantPolicyService
  private readonly config: Required<Config>
  private readonly activeDeliveryRegistrations = new WeakSet<object>()
  private deliveryBinding: Readonly<{
    generation: string
    producer: DeliveryPreferenceProducer
    registration: Readonly<DeliveryPreferenceRegistration>
    dispose: () => void
  }> | undefined
  private active = true

  constructor(ctx: Context, input: Config, options: { now?: () => number } = {}) {
    super(ctx, 'assistantPreferenceLearning')
    try {
      this.config = configSchema(input) as Required<Config>
    } catch (error) {
      throw new Error(`preference-learning: invalid configuration: ${String(error)}`, { cause: error })
    }
    if (this.config.hypothesisTtlMs > this.config.signalTtlMs) {
      throw new Error('preference-learning: hypothesisTtlMs must not exceed signalTtlMs')
    }
    const policy = ctx.get('assistantPolicy') as AssistantPolicyService | undefined
    if (policy === undefined) throw new Error('preference-learning: assistantPolicy service is required')
    this.policy = policy
    this.store = new PreferenceStore({
      path: this.config.databasePath,
      ...(options.now === undefined ? {} : { now: options.now }),
      signalTtlMs: this.config.signalTtlMs,
      hypothesisTtlMs: this.config.hypothesisTtlMs,
      minSignalsForActivation: this.config.minSignalsForActivation,
      minBehavioralSignalsForActivation: this.config.minBehavioralSignalsForActivation,
      minConfidenceBps: this.config.minConfidenceBps,
      maxContradictionBps: this.config.maxContradictionBps,
      maxActiveOverlays: this.config.maxActiveOverlays,
      maxReviewHypotheses: this.config.maxReviewHypotheses,
      maxOverlayBytes: this.config.maxOverlayBytes,
    })

    // Runtime context is re-evaluated before every model step. The AgentLoop
    // projection replaces or clears its prior snapshot, so rollback, expiry,
    // forget, disable/unload, and resumed sessions cannot retain stale policy.
    ctx.systemPrompt.context({
      name: 'preference-learning:active-overlay',
      order: 250,
      text: ({ agent }) => this.dynamicOverlay(agent),
    })

    const currentDelivery = ctx.get('assistantDelivery') as unknown
    if (isDeliveryPreferenceProducer(currentDelivery)) {
      this.bindDeliveryProducer(currentDelivery)
    }
    ctx.inject(['assistantDelivery'], deliveryCtx => {
      const delivery = deliveryCtx.get('assistantDelivery') as unknown
      if (!isDeliveryPreferenceProducer(delivery)) return
      return this.bindDeliveryProducer(delivery)
    })

    const registeredTools = ctx.get('tools') as ToolRuntime | undefined
    const disposeCurrentTools = registeredTools === undefined
      ? undefined
      : registerPreferenceTools(registeredTools, this)
    ctx.inject(['tools'], toolsCtx => {
      const tools = toolsCtx.tools
      if (tools === registeredTools) return
      return registerPreferenceTools(tools, this)
    })
    this.store.maintain(this.config.maintenanceBatchSize)
    if (this.config.enabled && this.config.autonomousT1Enabled) {
      this.store.activateReadyScopes(this.config.maintenanceBatchSize)
    }
    const maintenanceTimer = setInterval(() => {
      if (!this.active) return
      try {
        this.store.maintain(this.config.maintenanceBatchSize)
        if (this.config.enabled && this.config.autonomousT1Enabled) {
          this.store.activateReadyScopes(this.config.maintenanceBatchSize)
        }
      } catch {
        ctx.logger.warn('preference-learning: bounded retention maintenance failed')
      }
    }, this.config.maintenanceIntervalMs)
    maintenanceTimer.unref()
    ctx.effect(() => () => {
      this.active = false
      clearInterval(maintenanceTimer)
      this.deliveryBinding?.dispose()
      this.deliveryBinding = undefined
      disposeCurrentTools?.()
      this.store.close()
    }, 'preference-learning.database')
  }

  /**
   * Unprivileged observation seam. Actor/source authority is assigned here;
   * callers cannot use it to claim owner feedback or unlock an effect.
   */
  appendObservation(input: PreferenceObservationInput): StoredPreferenceSignal {
    this.assertActive()
    this.assertEnabled()
    if (input.interpretationTrust !== 'behavioral-inference'
      && input.interpretationTrust !== 'model-inference') {
      throw new PreferenceLearningError(
        'unattested-signal',
        'unattested observations cannot claim explicit or typed owner feedback',
      )
    }
    if (!['delivery-observation', 'evaluation-outcome', 'system-observation'].includes(input.source)) {
      throw new PreferenceLearningError(
        'unattested-signal',
        'unattested observations cannot claim an authenticated feedback source',
      )
    }
    return this.store.appendSignal({
      ...input,
      actorTrust: 'system-attested',
      idempotencyKey: `unattested-observation:${input.idempotencyKey}`,
    })
  }

  review(agent: Agent | undefined, limit?: number): PreferenceReview {
    this.assertActive()
    const { scope, principalId, principalLineage } = this.authorizedPrincipalScope(
      agent,
      'review',
      'hypotheses',
    )
    const hypotheses = this.store.list(scope, limit, principalId, principalLineage)
    return Object.freeze({
      hypotheses: Object.freeze(hypotheses),
      activeOverlay: this.config.enabled
        ? this.store.overlaySnapshot(scope, principalId, principalLineage).text
        : undefined,
    })
  }

  /** Host-only, Agent-free review for the deterministic recovery runbook. */
  hostReview(input: PreferenceHostOperation & { limit?: number }): PreferenceReview {
    this.assertActive()
    const scope = this.authorizedHostScope(input, 'inspect', 'hypotheses')
    const principalId = hostText(input.principal, 'principal', 500, 'missing-principal')
    const fence = this.hostPrincipalFence(input)
    const hypotheses = this.store.list(scope, input.limit, principalId, {
      principalRecordId: fence.principalLineageId,
      principalVersion: fence.principalLineageVersion,
    })
    return Object.freeze({
      hypotheses: Object.freeze(hypotheses),
      activeOverlay: this.config.enabled
        ? this.store.overlaySnapshot(scope, principalId, {
            principalRecordId: fence.principalLineageId,
            principalVersion: fence.principalLineageVersion,
          }).text
        : undefined,
    })
  }

  /** Side-effect-free Preference-state fence capture for a fixed Host plan. */
  hostOwnerFence(input: PreferenceHostOperation): PreferenceHostOwnerFence {
    this.assertActive()
    this.authorizedHostScope(input, 'inspect', 'owner-fence')
    const fence = this.hostPrincipalFence(input)
    return Object.freeze({
      ownerGeneration: fence.generation,
      principalLineage: Object.freeze({
        principalRecordId: fence.principalLineageId,
        principalVersion: fence.principalLineageVersion,
      }),
    })
  }

  /**
   * Return one deterministic, content-minimal activation target. The Store
   * evaluates the exact same readiness predicates used by activate().
   */
  hostActivationCandidate(
    input: PreferenceHostOperation,
  ): PreferenceHostActivationCandidate | undefined {
    this.assertActive()
    this.assertEnabled()
    const scope = this.authorizedHostScope(input, 'inspect', 'activation-candidate')
    const fence = this.hostPrincipalFence(input)
    const candidate = this.store.activationCandidate(scope, fence)
    if (candidate === undefined) return undefined
    return Object.freeze({
      hypothesisId: candidate.id,
      expectedVersion: candidate.version,
      ownerGeneration: fence.generation,
      principalLineage: Object.freeze({
        principalRecordId: fence.principalLineageId,
        principalVersion: fence.principalLineageVersion,
      }),
    })
  }

  activate(agent: Agent | undefined, hypothesisId: string, expectedVersion: number): PreferenceHypothesis {
    this.assertActive()
    this.assertEnabled()
    const principal = this.authorizedPrincipalScope(agent, 'activate', hypothesisId)
    return this.store.activate(
      principal.scope,
      hypothesisId,
      expectedVersion,
      this.requirePrincipalFence(principal),
    )
  }

  /** Activate exactly one evidence-ready, owner-attested T1 hypothesis by CAS. */
  hostActivateOne(input: PreferenceHostOperation & {
    ownerGeneration: number
    hypothesisId: string
    expectedVersion: number
  }): PreferenceHostActivationResult {
    this.assertActive()
    const hypothesisId = hostText(input.hypothesisId, 'hypothesisId', 200)
    const scope = this.authorizedHostScope(input, 'activate', `hypothesis:${hypothesisId}`)
    const fence = this.hostPrincipalFence(input)
    return this.store.activateHostOnce(
      scope,
      hypothesisId,
      input.expectedVersion,
      input.operationId,
      fence,
      this.config.enabled,
    )
  }

  rollback(
    agent: Agent | undefined,
    hypothesisId: string,
    expectedVersion: number,
    reason: PreferenceRollbackReason,
  ): PreferenceHypothesis {
    this.assertActive()
    const principal = this.authorizedPrincipalScope(agent, 'rollback', hypothesisId)
    return this.store.rollback(
      principal.scope,
      hypothesisId,
      expectedVersion,
      reason,
      this.requirePrincipalFence(principal),
    )
  }

  /** Roll back exactly one currently-active T1 overlay by CAS. */
  hostRollbackOne(input: PreferenceHostOperation & {
    hypothesisId: string
    expectedVersion: number
  }): PreferenceHypothesis {
    this.assertActive()
    const hypothesisId = hostText(input.hypothesisId, 'hypothesisId', 200)
    const scope = this.authorizedHostScope(input, 'rollback', `hypothesis:${hypothesisId}`)
    const principalId = hostText(input.principal, 'principal', 500, 'missing-principal')
    const fence = this.hostPrincipalFence(input)
    const current = this.store.get(scope, hypothesisId, principalId, input.principalLineage)
    if (current?.riskTier !== 'T1' || current.effectState !== 'active') {
      throw new PreferenceLearningError(
        'unattested-signal',
        'Host recovery can only roll back one exact active T1 preference',
      )
    }
    return this.store.rollback(scope, hypothesisId, input.expectedVersion, 'regression', fence)
  }

  /** Host-only privacy seam. It removes exact-scope rows and retains only a scope digest tombstone. */
  forgetScope(
    scope: PreferenceScope,
    idempotencyKey: string,
  ): PreferenceForgetResult {
    this.assertActive()
    return this.store.forgetScope(scope, idempotencyKey)
  }

  health(): PreferenceHealth {
    this.assertActive()
    return Object.freeze({ ...this.store.health(), enabled: this.config.enabled })
  }

  limits(): PreferenceLimits {
    this.assertActive()
    return Object.freeze({
      signalTtlMs: this.config.signalTtlMs,
      hypothesisTtlMs: this.config.hypothesisTtlMs,
      minSignalsForActivation: this.config.minSignalsForActivation,
      minBehavioralSignalsForActivation: this.config.minBehavioralSignalsForActivation,
      minConfidenceBps: this.config.minConfidenceBps,
      maxContradictionBps: this.config.maxContradictionBps,
      maxActiveOverlays: this.config.maxActiveOverlays,
      maxReviewHypotheses: this.config.maxReviewHypotheses,
      maxOverlayBytes: this.config.maxOverlayBytes,
      maintenanceIntervalMs: this.config.maintenanceIntervalMs,
      maintenanceBatchSize: this.config.maintenanceBatchSize,
    })
  }

  /** Safe bounded maintenance seam used by health jobs and deterministic tests. */
  maintain(): PreferenceMaintenanceResult {
    this.assertActive()
    return this.store.maintain(this.config.maintenanceBatchSize)
  }

  /** Policy-authorized, exact-scope retention step; deletes at most one row. */
  hostMaintainOne(input: PreferenceHostOperation): PreferenceHostMaintenanceResult {
    this.assertActive()
    const scope = this.authorizedHostScope(input, 'maintain', 'retention')
    return this.store.maintainScopeOnce(scope, input.operationId, this.hostPrincipalFence(input))
  }

  /** Host integration seam for foreground prompt composition. */
  overlayForAgent(agent: Agent | undefined): string | undefined {
    this.assertActive()
    if (!this.config.enabled) return undefined
    const { scope, principalId, principalLineage } = this.authorizedPrincipalScope(agent, 'snapshot', 'active')
    return this.store.overlaySnapshot(scope, principalId, principalLineage).text
  }

  /** Exact process-local ownership proof; copied or disposed registrations never pass. */
  ownsDeliveryPreferenceRegistration(
    registration: Readonly<DeliveryPreferenceRegistration>,
  ): boolean {
    return this.active && typeof registration === 'object' && registration !== null
      && this.activeDeliveryRegistrations.has(registration)
  }

  private bindDeliveryProducer(producer: DeliveryPreferenceProducer): (() => void) | undefined {
    let generation: string
    try {
      generation = hostText(
        producer.trustedPreferenceProducerGeneration(),
        'Delivery preference producer generation',
        200,
      )
    } catch {
      throw new PreferenceLearningError('unattested-signal', 'Delivery preference producer is invalid')
    }
    if (this.deliveryBinding?.generation === generation) return this.deliveryBinding.dispose

    let live = true
    let registration!: Readonly<DeliveryPreferenceRegistration>
    registration = Object.freeze({
      protocol: DELIVERY_PREFERENCE_PROJECTION_PROTOCOL,
      producer: 'preference-learning' as const,
      generation,
      owner: this,
      append: (events: readonly Readonly<DeliveryPreferenceEvent>[]) => {
        if (!live || !this.active || !this.activeDeliveryRegistrations.has(registration)
          || producer.trustedPreferenceProducerGeneration() !== generation) {
          throw new PreferenceLearningError('unattested-signal', 'stale Delivery preference registration')
        }
        return this.appendDeliveryPreferenceBatch(events)
      },
      appendSynchronously: (events: readonly Readonly<DeliveryPreferenceEvent>[]) => {
        if (!live || !this.active || !this.activeDeliveryRegistrations.has(registration)
          || producer.trustedPreferenceProducerGeneration() !== generation) {
          throw new PreferenceLearningError('unattested-signal', 'stale Delivery preference registration')
        }
        return this.appendDeliveryPreferenceBatch(events)
      },
      control: (request: Readonly<DeliveryLearningControlRequest>) => {
        if (!live || !this.active || !this.activeDeliveryRegistrations.has(registration)
          || producer.trustedPreferenceProducerGeneration() !== generation) {
          throw new PreferenceLearningError('unattested-signal', 'stale Delivery preference registration')
        }
        return this.controlDeliveryLearning(request)
      },
    })
    this.activeDeliveryRegistrations.add(registration)
    let unregister: (() => void) | undefined
    try {
      unregister = producer.registerTrustedPreferenceSink(registration)
      if (typeof unregister !== 'function') {
        throw new PreferenceLearningError(
          'unattested-signal',
          'Delivery preference producer returned no registration disposer',
        )
      }
    } catch (error) {
      live = false
      this.activeDeliveryRegistrations.delete(registration)
      throw error
    }

    let binding!: NonNullable<PreferenceLearningService['deliveryBinding']>
    const dispose = () => {
      if (!live) return
      live = false
      this.activeDeliveryRegistrations.delete(registration)
      if (this.deliveryBinding === binding) this.deliveryBinding = undefined
      unregister?.()
    }
    binding = Object.freeze({ generation, producer, registration, dispose })
    const previous = this.deliveryBinding
    this.deliveryBinding = binding
    previous?.dispose()
    return dispose
  }

  private dynamicOverlay(agent: Agent | undefined): string {
    if (!this.config.enabled || agent === undefined) return ''
    try {
      const scope = this.authorizedScope(agent, 'snapshot', 'active')
      const turn = this.deliveryBinding?.producer.currentPreferenceTurn(agent)
      if (turn === undefined
        || turn.scope.workspace !== scope.workspace
        || turn.scope.preset !== scope.preset
        || turn.sessionId !== String(agent.session.id)) return ''
      const snapshot = this.store.overlaySnapshot(scope, turn.principalId, turn.principalLineage)
      if (snapshot.ownerFence !== undefined) {
        for (const hypothesis of snapshot.hypotheses) {
          this.store.recordExposure({
            scope,
            ownerFence: snapshot.ownerFence,
            hypothesisId: hypothesis.id,
            hypothesisVersion: hypothesis.version,
            sessionId: turn.sessionId,
            sourceEventId: turn.sourceEventId,
          })
        }
      }
      return snapshot.text ?? ''
    } catch {
      this.ctx.logger.warn('preference-learning: current scoped overlay is unavailable')
      return ''
    }
  }

  private controlDeliveryLearning(
    request: Readonly<DeliveryLearningControlRequest>,
  ): Readonly<DeliveryLearningControlReceipt> {
    this.assertActive()
    const principalId = hostText(request.principalId, 'Delivery learning principalId', 500)
    const idempotencyKey = hostText(request.idempotencyKey, 'Delivery learning idempotencyKey', 500)
    if (!Number.isSafeInteger(request.occurredAt) || request.occurredAt < 0
      || !['explain', 'forget', 'pause', 'resume', 'rollback', 'status'].includes(request.action)
      || (request.action === 'rollback' ? typeof request.preferenceKey !== 'string'
        : request.preferenceKey !== undefined)) {
      throw new PreferenceLearningError('unattested-signal', 'Delivery learning control is invalid')
    }
    const admissionCursor = this.deliveryAdmissionCursor(
      (request as Partial<DeliveryLearningControlRequest>).admissionCursor,
    )
    if (admissionCursor === undefined) {
      return Object.freeze({ outcome: 'stale', action: request.action, idempotencyKey })
    }
    const lineage = this.deliveryLineage(request.principalLineage)
    const principal = this.store.ensureScopePrincipal(
      request.scope,
      principalId,
      request.occurredAt,
      lineage,
      admissionCursor,
    )
    if (!principal.accepted) {
      return Object.freeze({
        outcome: 'stale',
        action: request.action,
        idempotencyKey,
      })
    }
    try {
      let replayed = false
      let deletedSignals: number | undefined
      let deletedHypotheses: number | undefined
      let explanation: readonly Readonly<DeliveryLearningExplanation>[] | undefined
      let rolledBack: boolean | undefined
      let rolledBackVersion: number | undefined
      let state: PreferenceScopeLearningStatus
      if (request.action === 'status') {
        const result = this.store.recordScopeLearningStatus(
          request.scope,
          principal,
          admissionCursor,
          request.occurredAt,
          idempotencyKey,
        )
        if (!result.applied) {
          return Object.freeze({ outcome: 'stale', action: request.action, idempotencyKey })
        }
        replayed = result.replayed
        state = result.state
      } else if (request.action === 'explain') {
        const result = this.store.explainScopeLearning(
          request.scope,
          principal,
          admissionCursor,
          request.occurredAt,
          idempotencyKey,
        )
        replayed = result.replayed
        state = result.state
        explanation = result.explanation
      } else if (request.action === 'pause' || request.action === 'resume') {
        const result = this.store.setScopeLearningPaused(
          request.scope,
          principal,
          request.action === 'pause',
          admissionCursor,
          request.occurredAt,
          idempotencyKey,
        )
        if (!result.applied) {
          return Object.freeze({ outcome: 'stale', action: request.action, idempotencyKey })
        }
        replayed = result.replayed
        state = result.state
      } else if (request.action === 'rollback') {
        const result = this.store.rollbackScopeLearningKey(
          request.scope,
          principal,
          request.preferenceKey,
          admissionCursor,
          request.occurredAt,
          idempotencyKey,
        )
        if (!result.applied) {
          return Object.freeze({ outcome: 'stale', action: request.action, idempotencyKey })
        }
        replayed = result.replayed
        state = result.state
        rolledBack = result.rolledBack
        rolledBackVersion = result.rolledBackVersion
      } else {
        const forgotten = this.store.forgetScope(
          request.scope,
          idempotencyKey,
          { ownerFence: principal, admissionCursor, occurredAt: request.occurredAt },
        )
        if (!forgotten.applied) {
          return Object.freeze({ outcome: 'stale', action: request.action, idempotencyKey })
        }
        replayed = forgotten.replayed
        deletedSignals = forgotten.deletedSignals
        deletedHypotheses = forgotten.deletedHypotheses
        if (forgotten.state === undefined) {
          throw new PreferenceLearningError(
            'unattested-signal',
            'Delivery forget receipt is missing its exact historical state',
          )
        }
        state = forgotten.state
      }
      return Object.freeze({
        outcome: 'applied',
        action: request.action,
        idempotencyKey,
        replayed,
        state: this.deliveryLearningStatus(state),
        ...(deletedSignals === undefined ? {} : { deletedSignals }),
        ...(deletedHypotheses === undefined ? {} : { deletedHypotheses }),
        ...(explanation === undefined ? {} : { explanation }),
        ...(rolledBack === undefined ? {} : { rolledBack }),
        ...(rolledBackVersion === undefined ? {} : { rolledBackVersion }),
      })
    } catch (error) {
      if (error instanceof PreferenceStoreError && error.code === 'conflict') {
        return Object.freeze({
          outcome: 'stale',
          action: request.action,
          idempotencyKey,
        })
      }
      throw error
    }
  }

  private deliveryLearningStatus(
    state: Readonly<PreferenceScopeLearningStatus>,
  ): Readonly<DeliveryLearningScopeStatus> {
    const administrativelyEnabled = this.config.enabled
    const effectiveActiveOverlays = administrativelyEnabled && state.mode === 'active'
      ? state.storedActiveOverlays
      : 0
    return Object.freeze({
      mode: administrativelyEnabled ? state.mode : 'disabled',
      administrativelyEnabled,
      collectionMode: state.mode,
      signals: state.signals,
      hypotheses: state.hypotheses,
      storedActiveOverlays: state.storedActiveOverlays,
      effectiveActiveOverlays,
      activeOverlays: effectiveActiveOverlays,
      shadowHypotheses: state.shadowHypotheses,
    })
  }

  private deliveryLineage(
    input: Readonly<DeliveryOwnerLineage> | undefined,
  ): Readonly<PreferencePrincipalLineage> {
    if (typeof input !== 'object' || input === null
      || typeof input.principalRecordId !== 'string'
      || input.principalRecordId.normalize('NFC').trim() !== input.principalRecordId
      || input.principalRecordId.length < 1
      || Buffer.byteLength(input.principalRecordId) > 500
      || !Number.isSafeInteger(input.principalVersion) || input.principalVersion < 1) {
      throw new PreferenceLearningError('unattested-signal', 'Delivery owner lineage is invalid')
    }
    return Object.freeze({
      principalRecordId: input.principalRecordId,
      principalVersion: input.principalVersion,
    })
  }

  private deliveryAdmissionCursor(
    input: Readonly<DeliveryAdmissionCursor> | undefined,
  ): Readonly<PreferenceAdmissionCursor> | undefined {
    if (input === undefined) return undefined
    if (typeof input !== 'object' || input === null
      || typeof input.epoch !== 'string'
      || !/^[0-9a-f]{32}$/u.test(input.epoch)
      || !Number.isSafeInteger(input.sequence) || input.sequence < 1) {
      throw new PreferenceLearningError('unattested-signal', 'Delivery admission cursor is invalid')
    }
    return Object.freeze({ epoch: input.epoch, sequence: input.sequence })
  }

  /**
   * The closure is registered directly with Assistant Delivery. No public
   * service method accepts owner-authenticated provenance.
   */
  private appendDeliveryPreferenceBatch(
    events: readonly Readonly<DeliveryPreferenceEvent>[],
  ): readonly Readonly<DeliveryPreferenceFeedbackReceipt>[] {
    this.assertActive()
    if (!Array.isArray(events) || events.length < 1 || events.length > 16) {
      throw new PreferenceLearningError('unattested-signal', 'delivery feedback batch is invalid')
    }
    if (!this.config.enabled) {
      return Object.freeze(events.map(event => Object.freeze({
        idempotencyKey: hostText(event.idempotencyKey, 'Delivery preference idempotencyKey', 500),
        status: 'recorded' as const,
      })))
    }
    const first = events[0]!
    const principalId = hostText(first.principalId, 'Delivery preference principalId', 500)
    // Projection rows written by a pre-lineage/cursor Delivery build are
    // terminally ignored. Replaying them into a new owner generation or across
    // a pause/forget boundary would be unsafe.
    if (first.principalLineage === undefined
      || first.admissionCursor === undefined
      || events.some(event => event.principalLineage === undefined
        || event.admissionCursor === undefined)) {
      return Object.freeze(events.map(event => Object.freeze({
        idempotencyKey: event.idempotencyKey,
        status: 'recorded' as const,
      })))
    }
    const lineage = this.deliveryLineage(first.principalLineage)
    const admissionCursor = this.deliveryAdmissionCursor(first.admissionCursor)!
    if (principalId !== first.principalId
      || events.some(event => event.principalId !== principalId
        || event.scope.workspace !== first.scope.workspace
        || event.scope.preset !== first.scope.preset
        || event.principalLineage?.principalRecordId !== lineage.principalRecordId
        || event.principalLineage?.principalVersion !== lineage.principalVersion
        || event.admissionCursor?.epoch !== admissionCursor.epoch
        || event.admissionCursor?.sequence !== admissionCursor.sequence
        || !Number.isSafeInteger(event.occurredAt) || event.occurredAt < 0)) {
      throw new PreferenceLearningError('unattested-signal', 'delivery preference owner fence is invalid')
    }
    const principal = this.store.ensureScopePrincipal(
      first.scope,
      principalId,
      first.occurredAt,
      lineage,
      admissionCursor,
    )
    if (!principal.accepted) {
      return Object.freeze(events.map(event => Object.freeze({
        idempotencyKey: event.idempotencyKey,
        status: 'recorded' as const,
      })))
    }
    const admittedEvents = events.filter(event =>
      this.store.scopeAcceptsEvent(event.scope, principal, admissionCursor))
    if (admittedEvents.length === 0) {
      return Object.freeze(events.map(event => Object.freeze({
        idempotencyKey: event.idempotencyKey,
        status: 'recorded' as const,
      })))
    }
    try {
    for (const event of admittedEvents) {
      if (event.source === 'direct-owner-feedback') continue
      const completion = this.deliveryCompletion(event)
      this.store.bindExposure({
        admissionCursor,
        scope: event.scope,
        ownerFence: principal,
        sessionId: completion.sessionId,
        sourceEventId: completion.sourceEventId,
        sourceInboxId: completion.sourceInboxId,
        replyOutboxId: completion.replyOutboxId,
      })
    }
    const signalEvents = admittedEvents.filter((event): event is Exclude<DeliveryPreferenceEvent, DeliveryPreferenceCompletion> =>
      event.source !== 'delivery-completion')
    const signals = signalEvents.map(event => this.deliverySignal(event))
    if (signals.length > 0) {
      this.store.appendSignals(signals, {
        admissionCursor,
        ownerFence: principal,
        exactCorrections: signalEvents.flatMap((event, signalIndex) =>
          event.source === 'direct-owner-feedback' && event.exposureTarget !== undefined
            ? [Object.freeze({
                signalIndex,
                sourceInboxId: event.exposureTarget.sourceInboxId,
                replyOutboxId: event.exposureTarget.sourceOutboxId,
              })]
            : []),
      })
    }
    if (this.config.autonomousT1Enabled) {
      const scopes = new Map(admittedEvents.map(event => [
        JSON.stringify([event.scope.workspace, event.scope.preset]),
        { workspace: event.scope.workspace, preset: event.scope.preset },
      ]))
      for (const scope of scopes.values()) {
        this.store.activateReady(scope, this.config.maxActiveOverlays, principal)
      }
    }
    } catch (error) {
      if (!(error instanceof PreferenceStoreError && error.code === 'learning-paused')) throw error
    }
    return Object.freeze(events.map(event => Object.freeze({
      idempotencyKey: event.idempotencyKey,
      status: 'recorded' as const,
    })))
  }

  private deliveryCompletion(
    event: Readonly<DeliveryPreferenceCompletion | DeliveryPreferenceObservation>,
  ) {
    const completion = event.completion
    if (event.actorTrust !== 'owner-authenticated'
      || typeof completion !== 'object' || completion === null
      || !Number.isSafeInteger(completion.bindingVersion) || completion.bindingVersion < 1
      || [completion.bindingId, completion.sessionId, completion.sourceEventId,
        completion.sourceInboxId, completion.replyOutboxId]
        .some(value => typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value) > 500)) {
      throw new PreferenceLearningError('unattested-signal', 'delivery completion attestation is invalid')
    }
    return completion
  }

  private deliverySignal(
    event: Readonly<Exclude<DeliveryPreferenceEvent, DeliveryPreferenceCompletion>>,
  ) {
    if (event.stance !== 'support' || event.actorTrust !== 'owner-authenticated') {
      throw new PreferenceLearningError('unattested-signal', 'delivery preference attestation is invalid')
    }
    if (event.source === 'direct-owner-feedback') {
      if (event.interpretationTrust !== 'explicit-selection'
        && event.interpretationTrust !== 'typed-feedback') {
        throw new PreferenceLearningError('unattested-signal', 'delivery feedback attestation is invalid')
      }
      return {
        scope: { workspace: event.scope.workspace, preset: event.scope.preset },
        preferenceKey: event.preferenceKey,
        candidateValue: event.candidateValue,
        stance: 'support' as const,
        actorTrust: 'owner-authenticated' as const,
        interpretationTrust: event.interpretationTrust,
        source: 'direct-owner-feedback' as const,
        occurredAt: event.occurredAt,
        idempotencyKey: `assistant-delivery:${event.idempotencyKey}`,
      }
    }
    const observation = event as Readonly<DeliveryPreferenceObservation>
    this.deliveryCompletion(observation)
    if (observation.source !== 'delivery-observation'
      || observation.interpretationTrust !== 'behavioral-inference'
      || observation.preferenceKey !== 'response.language'
      || (observation.candidateValue !== 'zh-CN' && observation.candidateValue !== 'en')
      ) {
      throw new PreferenceLearningError('unattested-signal', 'delivery observation attestation is invalid')
    }
    return {
      scope: { workspace: observation.scope.workspace, preset: observation.scope.preset },
      preferenceKey: 'response.language' as const,
      candidateValue: observation.candidateValue,
      stance: 'support' as const,
      actorTrust: 'owner-authenticated' as const,
      interpretationTrust: 'behavioral-inference' as const,
      source: 'delivery-observation' as const,
      occurredAt: observation.occurredAt,
      idempotencyKey: `assistant-delivery:${observation.idempotencyKey}`,
    }
  }

  private authorizedScope(agent: Agent | undefined, action: string, resourceId: string): PreferenceScope {
    const header = agent?.session?.header
    if (agent === undefined || header === undefined
      || typeof header.cwd !== 'string' || typeof header.agentPreset !== 'string') {
      throw new PreferenceLearningError('missing-agent', `missing-agent: preference ${action} requires a trusted Agent`)
    }
    let scope: PreferenceScope
    try {
      scope = canonicalPreferenceScope({ workspace: header.cwd, preset: header.agentPreset }).scope
    } catch {
      throw new PreferenceLearningError('missing-agent', `missing-agent: preference ${action} requires a valid scope`)
    }
    const decision = this.policy.authorizeAgent(
      agent,
      action,
      { kind: 'preference', id: resourceId } as unknown as Parameters<AssistantPolicyService['authorizeAgent']>[2],
      { idempotencyKey: `preference:${action}:${agent.id}:${resourceId}` },
    )
    if (decision.effect !== 'allow') throw decisionError(decision)
    return scope
  }

  private authorizedPrincipalScope(
    agent: Agent | undefined,
    action: string,
    resourceId: string,
  ): Readonly<{
    scope: PreferenceScope
    principalId: string
    principalLineage: Readonly<PreferencePrincipalLineage>
  }> {
    const scope = this.authorizedScope(agent, action, resourceId)
    const principal = agent === undefined
      ? undefined
      : this.deliveryBinding?.producer.preferencePrincipalForAgent(agent)
    if (principal === undefined
      || principal.scope.workspace !== scope.workspace
      || principal.scope.preset !== scope.preset
      || principal.sessionId !== String(agent!.session.id)) {
      throw new PreferenceLearningError(
        'missing-agent',
        `missing-agent: preference ${action} requires an exact owner Delivery binding`,
      )
    }
    return Object.freeze({
      scope,
      principalId: hostText(principal.principalId, 'Delivery preference principalId', 500),
      principalLineage: this.deliveryLineage(principal.principalLineage),
    })
  }

  private requirePrincipalFence(input: Readonly<{
    scope: PreferenceScope
    principalId: string
    principalLineage: Readonly<PreferencePrincipalLineage>
  }>): Readonly<PreferenceScopePrincipalFence> {
    const fence = this.store.scopePrincipalFence(
      input.scope,
      input.principalId,
      input.principalLineage,
    )
    if (fence === undefined) {
      throw new PreferenceLearningError(
        'missing-principal',
        'Delivery owner lineage is not current for this preference scope',
      )
    }
    return fence
  }

  private authorizedHostScope(
    input: PreferenceHostOperation,
    action: 'activate' | 'inspect' | 'maintain' | 'rollback',
    resourceId: string,
  ): PreferenceHostScope {
    const scope = exactHostScope(input.scope)
    const principal = hostText(input.principal, 'principal', 500, 'missing-principal')
    const principalLineage = this.deliveryLineage(input.principalLineage)
    if (input.ownerGeneration !== undefined
      && (!Number.isSafeInteger(input.ownerGeneration) || input.ownerGeneration < 1)) {
      throw new PreferenceLearningError('invalid-input', 'ownerGeneration is invalid')
    }
    const operationId = hostText(input.operationId, 'operationId', 500)
    const idempotencyDigest = createHash('sha256').update(JSON.stringify([
      HOST_RECOVERY_BACKGROUND_ID,
      scope.workspace,
      scope.preset,
      principal,
      principalLineage.principalRecordId,
      principalLineage.principalVersion,
      input.ownerGeneration ?? 'current',
      action,
      resourceId,
      operationId,
    ])).digest('hex')
    const decision = this.policy.authorize({
      subject: {
        kind: 'background',
        id: HOST_RECOVERY_BACKGROUND_ID,
        workspace: scope.workspace,
        principal,
      },
      action,
      resource: { kind: 'preference', id: resourceId },
      context: { initiator: 'background' },
    }, { idempotencyKey: `preference-host:${idempotencyDigest}` })
    if (decision.effect !== 'allow') throw decisionError(decision)
    return scope
  }

  private hostPrincipalFence(
    input: PreferenceHostOperation,
  ): Readonly<PreferenceScopePrincipalFence> {
    const scope = exactHostScope(input.scope)
    const principal = hostText(input.principal, 'principal', 500, 'missing-principal')
    const lineage = this.deliveryLineage(input.principalLineage)
    const fence = this.store.scopePrincipalFence(
      scope,
      principal,
      lineage,
      input.ownerGeneration,
    )
    if (fence === undefined) {
      throw new PreferenceLearningError(
        'missing-principal',
        'Host preference owner lineage is stale or unavailable',
      )
    }
    return fence
  }

  private assertEnabled(): void {
    if (!this.config.enabled) throw new PreferenceLearningError('disabled', 'preference learning is disabled')
  }

  private assertActive(): void {
    if (!this.active) throw new PreferenceLearningError('disposed', 'preference-learning service is disposed')
  }
}

export const Config = configSchema
