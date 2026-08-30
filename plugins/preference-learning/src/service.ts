import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Schema from '@deepseek-ai/schemastery'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type {
  AssistantDeliveryService,
  DeliveryPreferenceFeedback,
  DeliveryPreferenceFeedbackReceipt,
} from '@dsh-enhanced/assistant-delivery'
import type { AssistantPolicyService, PolicyDecision } from '@dsh-enhanced/assistant-policy'
import { PreferenceStore, canonicalPreferenceScope } from './store.js'
import type { PreferenceForgetResult } from './store.js'
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
  | 'missing-agent'
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

declare module '@deepseek-ai/cordis' {
  interface Context { assistantPreferenceLearning: PreferenceLearningService }
}

export class PreferenceLearningService extends Service {
  static Config = configSchema
  static inject = ['assistantPolicy', 'systemPrompt']
  private readonly store: PreferenceStore
  private readonly policy: AssistantPolicyService
  private readonly config: Required<Config>
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

    ctx.inject(['assistantDelivery'], deliveryCtx => {
      if (!this.config.enabled) return
      const delivery = deliveryCtx.get('assistantDelivery') as AssistantDeliveryService | undefined
      if (delivery === undefined || typeof delivery.subscribePreferenceFeedback !== 'function') return
      return delivery.subscribePreferenceFeedback(events => this.appendDeliveryFeedbackBatch(events))
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
    const maintenanceTimer = setInterval(() => {
      if (!this.active) return
      try {
        this.store.maintain(this.config.maintenanceBatchSize)
      } catch {
        ctx.logger.warn('preference-learning: bounded retention maintenance failed')
      }
    }, this.config.maintenanceIntervalMs)
    maintenanceTimer.unref()
    ctx.effect(() => () => {
      this.active = false
      clearInterval(maintenanceTimer)
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
    const scope = this.authorizedScope(agent, 'review', 'hypotheses')
    const hypotheses = this.store.list(scope, limit)
    return Object.freeze({
      hypotheses: Object.freeze(hypotheses),
      activeOverlay: this.config.enabled ? this.store.overlay(scope) : undefined,
    })
  }

  activate(agent: Agent | undefined, hypothesisId: string, expectedVersion: number): PreferenceHypothesis {
    this.assertActive()
    this.assertEnabled()
    const scope = this.authorizedScope(agent, 'activate', hypothesisId)
    return this.store.activate(scope, hypothesisId, expectedVersion)
  }

  rollback(
    agent: Agent | undefined,
    hypothesisId: string,
    expectedVersion: number,
    reason: PreferenceRollbackReason,
  ): PreferenceHypothesis {
    this.assertActive()
    const scope = this.authorizedScope(agent, 'rollback', hypothesisId)
    return this.store.rollback(scope, hypothesisId, expectedVersion, reason)
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

  /** Host integration seam for foreground prompt composition. */
  overlayForAgent(agent: Agent | undefined): string | undefined {
    this.assertActive()
    if (!this.config.enabled) return undefined
    const scope = this.authorizedScope(agent, 'snapshot', 'active')
    return this.store.overlay(scope)
  }

  private dynamicOverlay(agent: Agent | undefined): string {
    if (!this.config.enabled || agent === undefined) return ''
    try {
      return this.overlayForAgent(agent) ?? ''
    } catch {
      this.ctx.logger.warn('preference-learning: current scoped overlay is unavailable')
      return ''
    }
  }

  /**
   * The closure is registered directly with Assistant Delivery. No public
   * service method accepts owner-authenticated provenance.
   */
  private appendDeliveryFeedbackBatch(
    events: readonly Readonly<DeliveryPreferenceFeedback>[],
  ): readonly Readonly<DeliveryPreferenceFeedbackReceipt>[] {
    this.assertActive()
    this.assertEnabled()
    if (!Array.isArray(events) || events.length < 1 || events.length > 16) {
      throw new PreferenceLearningError('unattested-signal', 'delivery feedback batch is invalid')
    }
    const signals = events.map(event => {
      if (event.stance !== 'support'
        || event.actorTrust !== 'owner-authenticated'
        || event.interpretationTrust !== 'typed-feedback'
        || event.source !== 'direct-owner-feedback') {
        throw new PreferenceLearningError('unattested-signal', 'delivery feedback attestation is invalid')
      }
      return {
        scope: { workspace: event.scope.workspace, preset: event.scope.preset },
        preferenceKey: event.preferenceKey,
        candidateValue: event.candidateValue,
        stance: 'support' as const,
        actorTrust: 'owner-authenticated' as const,
        interpretationTrust: 'typed-feedback' as const,
        source: 'direct-owner-feedback' as const,
        occurredAt: event.occurredAt,
        idempotencyKey: `assistant-delivery:${event.idempotencyKey}`,
      }
    })
    this.store.appendSignals(signals)
    return Object.freeze(events.map(event => Object.freeze({
      idempotencyKey: event.idempotencyKey,
      status: 'recorded' as const,
    })))
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

  private assertEnabled(): void {
    if (!this.config.enabled) throw new PreferenceLearningError('disabled', 'preference learning is disabled')
  }

  private assertActive(): void {
    if (!this.active) throw new PreferenceLearningError('disposed', 'preference-learning service is disposed')
  }
}

export const Config = configSchema
