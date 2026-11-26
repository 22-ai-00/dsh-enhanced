import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { AssistantDeliveryService } from '@dsh-ray/assistant-delivery'
import type { AssistantPolicyService } from '@dsh-ray/assistant-policy'
import Schema from '@deepseek-ai/schemastery'
import { acceptanceDigest } from '@dsh-ray/task-acceptance-contract'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ACTIVE_IDLE_THRESHOLD_MS, computeDynamicUtility, IDLE_DISCOUNT_FULL_MS, IDLE_DISCOUNT_START_MS,
  MAX_ACCEPTANCE_BONUS, MAX_ACCEPTANCE_PENALTY, MAX_ACTIVITY_PENALTY, MAX_FREQUENCY_PENALTY,
  MAX_IDLE_DISCOUNT, MAX_URGENCY_BONUS, OpportunityEngine, PENALTY_PER_RECENT_NOTIFICATION,
  RECENT_NOTIFICATION_WINDOW_MS, URGENCY_WINDOW_MS, validateProfile, validateRuntimeContext,
} from './engine.js'
import type {
  OpportunityDecision, OpportunityInput, OpportunityProfile, OpportunityScope,
  ProactiveAttentionQuestionFilter, ProactiveAttentionQuestionInspection, ProactiveAttentionQuestionResolveResult,
  ProactiveDraftFilter, ProactiveDraftInspection, ProactiveOpportunityFilter, ProactiveOpportunityInspection,
  ProactiveRuntimeContext,
} from './types.js'
import { reminderText, reminderExpiresAt } from './reminder.js'
import { attentionOverlay, proactiveAttentionCohort, tuneProfile, type AttentionOverlay } from './attention-tuning.js'
import {
  IntakeEvaluationProducer, resolveServiceIntakeEvaluation,
  type IntakeEvaluationConfig, type IntakeWorkItemsRegistration, type ProactiveIntakeEvaluationHealth,
  type ProactiveIntakeRuleOverride, type ProactiveIntakeRuleUpdate,
} from './intake-evaluation.js'
import {
  parseTerminalGoalChanged,
  type EventTriggersUnsubscribePort,
  type GoalLifecycleInspectPort,
  type ProactiveGoalLifecycleReason,
  type ProactiveGoalRetireInput,
  type ProactiveGoalSourceLink,
  type ProactiveGoalUnsubscribeEvent,
  type ProactiveGoalUnsubscribeHook,
  type ProactiveGoalUnsubscribeResult,
  type TerminalGoalChangeSignal,
} from './goal-lifecycle.js'
import {
  planProactiveIntakeRoute,
  type ProactiveIntakeObservationInput,
  type ProactiveIntakeRoutePlan,
} from './intake-routing.js'
import { PreparationRuntime } from './preparation.js'
import { PreparationStore } from './preparation-store.js'
import { version } from './version.js'

const MAX_GOAL_UNSUBSCRIBE_HOOKS = 64
const MAX_REMEMBERED_GOAL_UNSUBSCRIBES = 4_096
const MAX_PENDING_GOAL_CHANGE_SIGNALS = 256
const MAX_TRACKED_ACTIVITY_SCOPES = 1_024
const ACCEPTANCE_SUMMARY_WINDOW_MS = 30 * 24 * 3_600_000

/**
 * Bounded R3 default opportunity profile. Uses `mode: 'execute'` without
 * `preparation` so `assertProfile` and doctor checks succeed cleanly even
 * before `assistantDelivery` or preparation credentials are configured;
 * actual wake execution remains gated by Goals' owner/policy/budget/verifier checks.
 */
export const DEFAULT_PROACTIVE_PROFILES: readonly OpportunityProfile[] = Object.freeze([
  validateProfile({
    id: 'default',
    mode: 'execute',
    expectedBenefit: 80,
    successPpm: 850_000,
    executionCost: 10,
    interruptionCost: 10,
    possibleLoss: 5,
    minimumUtility: 10,
    mergeWindowMs: 5_000,
    cooldownMs: 60_000,
    rejectionCooldownMs: 3_600_000,
    maxDecisionsPerGoal: 20,
    maxExecutionsPerGoal: 3,
    maxRemindersPerGoal: 0,
  }),
])

export const name = 'dsh-ray-assistant-proactive'
export {
  version, OpportunityEngine, validateProfile, validateRuntimeContext, computeDynamicUtility,
  attentionOverlay, tuneProfile, proactiveAttentionCohort,
  RECENT_NOTIFICATION_WINDOW_MS, URGENCY_WINDOW_MS, ACTIVE_IDLE_THRESHOLD_MS,
  IDLE_DISCOUNT_START_MS, IDLE_DISCOUNT_FULL_MS, MAX_ACTIVITY_PENALTY, MAX_IDLE_DISCOUNT,
  PENALTY_PER_RECENT_NOTIFICATION, MAX_FREQUENCY_PENALTY, MAX_URGENCY_BONUS,
  MAX_ACCEPTANCE_BONUS, MAX_ACCEPTANCE_PENALTY,
}
export {
  DISABLED_INTAKE_EVALUATION_HEALTH, INTAKE_EVALUATION_LEVELS, INTAKE_EVALUATION_PRESETS,
  IntakeEvaluationError, IntakeEvaluationProducer, intakeEvaluationPolicy, MAX_INTAKE_EVALUATION_QUOTES,
  MAX_INTAKE_EVALUATION_RULES, MAX_INTAKE_EVALUATION_QUOTE_CHARS, MAX_INTAKE_SOURCE_TEXT,
  normalizeIntakeEvaluation, resolveIntakeEvaluationPresetRules, resolveServiceIntakeEvaluation,
  UNCONFIGURED_INTAKE_EVALUATION_HEALTH, UNCONFIGURED_INTAKE_EVALUATION_LAST_ERROR,
  unconfiguredIntakeEvaluationHealth,
} from './intake-evaluation.js'
export type {
  IntakeEvaluationConfig, IntakeEvaluationErrorCode, IntakeEvaluationLevel, IntakeEvaluationPolicy,
  IntakeEvaluationPreset, IntakeEvaluationRule, IntakeEvaluationRuleConfig, IntakeEvaluationVerdict,
  IntakeModelRequest, IntakeWorkItemsRegistration, NormalizedIntakeEvaluation,
  ProactiveIntakeEvaluationHealth, ProactiveIntakeEvaluationReadiness,
  ProactiveIntakeRuleOverride, ProactiveIntakeRuleUpdate,
} from './intake-evaluation.js'
export type { AttentionOverlay }
export * from './goal-lifecycle.js'
export * from './intake-routing.js'
export type * from './types.js'
/** `attention` is ignored by Delivery releases before the WP19 audit; it never changes how the notice is sent. */
interface NotificationPort { enqueueOwnerNotification(input: { sourceId: string; ownerRouteId: string; scope: OpportunityScope; sessionId: string; idempotencyKey: string; text: string; expiresAt: number; attention: { purpose: 'result' } }): unknown }
interface EvaluationAttentionPort {
  attentionLooseningStatus?: (input: { scope: { workspace: string; preset: string }; cohort: { lane: string; sourceId: string } }) => {
    enabled: boolean
    grant: { grant: { grantId: string }; used: number; remaining: number } | null
    proposals: readonly { proposalId: string; decision: { decision: string; reason: string; decidedAt: number } | null }[]
    questions: readonly {
      questionId: string
      question: {
        proposalId: string
        change: { parameter: string; parentValue: number | boolean; candidateValue: number | boolean; delta: number | boolean }
        exceeded: readonly string[]
        grantId: string | null
        choices: readonly ['authorize-once', 'decline']
        createdAt: number
      }
    }[]
  }
  attentionOwnerQuestionStatus?: (input: { scope: { workspace: string; preset: string }; cohort: { lane: string; sourceId: string } }) => {
    enabled: boolean
    deliveries: readonly { questionId: string; status: 'queued' | 'closed' | 'expired'; outboxId: string | null; recordedAt: number }[]
    replies: readonly { questionId: string; choice: 'authorize-once' | 'decline'; repliedAt: number }[]
  }
  applyAttentionOwnerQuestionReply?: (input: { scope: { workspace: string; preset: string }; cohort: { lane: string; sourceId: string }; questionId: string; choice: 'authorize-once' | 'decline' }) => ProactiveAttentionQuestionResolveResult
}
export interface Config {
  databasePath?: string
  profiles?: OpportunityProfile[]
  /** WP20 stage 3 producer: absent or disabled keeps the plugin behavior identical. */
  intakeEvaluation?: IntakeEvaluationConfig
}
const integer = (max = 1_000_000_000) => Schema.number().step(1).min(0).max(max).required()
export const Config: Schema<Config> = Schema.object({
  databasePath: Schema.string().default(join(homedir(), '.dsh', 'assistant-proactive.sqlite')),
  // WP20 stage 3 / R3 producer: enabled by default. Without a configured
  // provider/model it remains cleanly unavailable without failing startup;
  // assistant-work-items must also enable its own intakeLedger.evaluation.
  intakeEvaluation: Schema.object({
    enabled: Schema.boolean().default(true),
    preset: Schema.union(['conservative', 'balanced']),
    rules: Schema.array(Schema.object({
      ruleId: Schema.string().required(),
      ceiling: Schema.union(['ignore', 'digest', 'notify', 'accept']).required(),
    })).default([]),
    provider: Schema.string(),
    model: Schema.string(),
    maxCallsPerHour: Schema.number().step(1).min(1).max(1_000),
    timeoutMs: Schema.number().step(1).min(1_000).max(600_000),
    maxConsecutiveFailures: Schema.number().step(1).min(1).max(10),
  }),
  profiles: Schema.array(Schema.object({
    preparation: Schema.union([Schema.object({ provider: Schema.string().required(), model: Schema.string().required(), budgetId: Schema.string().required(), maxOutputTokens: Schema.number().step(1).min(1).max(32_768).required(), timeoutMs: Schema.number().step(1).min(1_000).max(300_000).required() })]),
    id: Schema.string().required(), mode: Schema.union(['prepare', 'remind', 'execute']).required(),
    expectedBenefit: integer(), successPpm: integer(1_000_000), executionCost: integer(), interruptionCost: integer(), possibleLoss: integer(),
    minimumUtility: integer(),
    mergeWindowMs: integer(), cooldownMs: integer(), rejectionCooldownMs: integer(),
    quietHours: Schema.union([Schema.object({ timezone: Schema.string().required(), startMinute: integer(1439), endMinute: integer(1439) })]),
    maxDecisionsPerGoal: integer(), maxExecutionsPerGoal: integer(), maxRemindersPerGoal: integer(),
  })).default(DEFAULT_PROACTIVE_PROFILES.map(profile => ({ ...profile }))),
})
declare module '@deepseek-ai/cordis' { interface Context { assistantProactive: AssistantProactiveService } }

/** This optional decision gate cannot resume a goal or grant tool/route authority. */
export class AssistantProactiveService extends Service {
  static Config = Config
  readonly #preparations: PreparationRuntime
  readonly #engine: OpportunityEngine
  readonly #profiles = new Map<string, OpportunityProfile>()
  readonly #intakeEvaluation: IntakeEvaluationProducer | undefined
  readonly #intakeEvaluationHealth: ProactiveIntakeEvaluationHealth
  readonly #lastOwnerActivityByScope = new Map<string, number>()
  readonly #goalUnsubscribeHooks = new Set<ProactiveGoalUnsubscribeHook>()
  readonly #emittedGoalUnsubscribes = new Set<string>()
  readonly #pendingGoalChanges = new Map<string, TerminalGoalChangeSignal>()
  #goalChangeMicrotaskQueued = false
  #active = true
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'assistantProactive')
    const resolvedIntake = resolveServiceIntakeEvaluation(config.intakeEvaluation)
    const producer = resolvedIntake.config === undefined ? undefined : new IntakeEvaluationProducer({ config: resolvedIntake.config })
    this.#intakeEvaluation = producer
    this.#intakeEvaluationHealth = resolvedIntake.health
    for (const input of config.profiles ?? DEFAULT_PROACTIVE_PROFILES) {
      const profile = validateProfile(input)
      if (this.#profiles.has(profile.id)) throw new Error('assistant-proactive: duplicate profile')
      this.#profiles.set(profile.id, profile)
    }
    this.#engine = new OpportunityEngine(config.databasePath ?? join(homedir(), '.dsh', 'assistant-proactive.sqlite'), [...this.#profiles.values()])
    const unsubGoalChanged = (ctx as unknown as {
      on?: (event: string, listener: (payload?: unknown) => void) => (() => void) | undefined
    }).on?.('goal/changed', payload => { this.#onGoalChanged(payload) })
    ctx.effect(() => () => {
      this.#active = false
      if (typeof unsubGoalChanged === 'function') {
        try { unsubGoalChanged() } catch {}
      }
      this.#pendingGoalChanges.clear()
      this.#goalUnsubscribeHooks.clear()
      this.#emittedGoalUnsubscribes.clear()
      this.#engine.close()
    }, 'assistant-proactive.store')
    const preparationPath = config.databasePath === ':memory:' ? ':memory:' : `${config.databasePath ?? join(homedir(), '.dsh', 'assistant-proactive.sqlite')}.preparations`
    const hasPrepareProfiles = [...this.#profiles.values()].some(profile => profile.mode === 'prepare' && profile.preparation !== undefined)
    this.#preparations = new PreparationRuntime(ctx, new PreparationStore(preparationPath), { active: hasPrepareProfiles })
    ctx.inject(['tools', 'agents', 'assistantDelivery', 'assistantPolicy'], runtime => {
      const output = {
        schema: { type: 'object' as const, additionalProperties: false, properties: { context: { type: 'string' as const, required: true } } },
        render: (_args: unknown, value: { context: string }) => [{ type: 'text' as const, text: value.context }],
      } as const
      const statusTool = defineTool({
        name: 'proactive_status',
        description: 'Inspect owner-scoped event opportunity decisions and operator utility estimates. Preparation may include a persisted model draft when explicitly configured. Drafts are unverified and do not mean the original goal was executed.',
        parameters: { goal_id: { type: 'string' } }, output,
        execute: async (args, execution) => { return { context: JSON.stringify(this.inspect(execution.agent, args.goal_id)) } },
      })
      runtime.tools.register(statusTool)
      if (runtime.assistantPolicy.contextToolPreauthorizationVersion?.() === 1) {
        runtime.assistantPolicy.registerPreauthorizedTool?.(runtime, statusTool, execution => this.preauthorizeStatus(execution))
      }
      runtime.tools.register(defineTool({
        name: 'proactive_feedback',
        description: 'Record current authenticated owner feedback on an opportunity. Rejection starts a durable cooldown for subsequent decisions. Feedback grants no execution permission and does not undo an already dispatched goal.',
        parameters: { decision_id: { type: 'string', required: true }, feedback: { type: 'string', enum: ['accepted', 'rejected'], required: true } }, output,
        execute: async (args, execution) => { return { context: JSON.stringify(this.feedback(execution.agent, args.decision_id, args.feedback as 'accepted' | 'rejected')) } },
      }))
    })
    if (producer !== undefined) this.#registerIntakeEvaluation(ctx, producer)
  }
  /**
   * WP20 stage 3 production wiring: register the intake evaluator only while
   * the LLM and WorkItems services are both active. Both are optional peers, so
   * a deployment without them (or with WorkItems' evaluation disabled) keeps
   * the plugin loaded and behavior unchanged; the health snapshot reports why.
   */
  #registerIntakeEvaluation(ctx: Context, producer: IntakeEvaluationProducer): void {
    ctx.inject(['llm', 'assistantWorkItems'] as never, runtime => {
      const llm = runtime.get('llm' as never) as LlmRuntime | undefined
      const workItems = runtime.get('assistantWorkItems' as never) as
        { registerIntakeEvaluator?: (registration: IntakeWorkItemsRegistration) => () => void } | undefined
      if (llm === undefined || typeof workItems?.registerIntakeEvaluator !== 'function') return
      producer.attach(llm)
      runtime.effect(() => () => producer.detach(llm), 'assistant-proactive.intake-evaluation-llm')
      let unregister: () => void
      try {
        unregister = workItems.registerIntakeEvaluator(producer.registration())
      } catch (error) {
        // WorkItems refuses when its own intakeLedger.evaluation is disabled or
        // another supplier is registered. Nothing was registered, so nothing changes.
        producer.markUnavailable(error)
        runtime.logger.warn(`assistant-proactive: intake evaluator not registered: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      producer.markRegistered(true)
      runtime.effect(() => () => { producer.markRegistered(false); unregister() }, 'assistant-proactive.intake-evaluation')
    })
    ctx.inject(['assistantEvaluation'] as never, evalCtx => {
      if (!this.#active) return
      const evaluation = evalCtx.get('assistantEvaluation' as never) as unknown as {
        onAttentionTuningChanged?: (cb: (event: Record<string, unknown>) => void) => () => void
        onAttentionLooseningAdopted?: (cb: (event: Record<string, unknown>) => void) => () => void
      } | undefined
      const applyEvent = (event: unknown): void => {
        if (!this.#active || event === null || typeof event !== 'object') return
        const payload = event as Record<string, unknown>
        const action = payload['action']
        const rawParams = payload['parameters']
        const params = rawParams !== null && typeof rawParams === 'object' && !Array.isArray(rawParams)
          ? rawParams as Record<string, unknown>
          : undefined
        const rawCohort = payload['cohort']
        const cohortLane = rawCohort !== null && typeof rawCohort === 'object' && !Array.isArray(rawCohort)
          ? (rawCohort as Record<string, unknown>)['lane']
          : undefined
        if (rawCohort !== undefined && cohortLane !== 'intake') return
        if ((action === 'loosening-adopted' || action === 'rolled-back' || action === 'tightened')
          && cohortLane === 'intake'
          && params !== undefined && payload['scope'] !== undefined && rawCohort !== undefined
          && typeof payload['version'] === 'number') {
          const targetRules = Array.isArray(params['intakeRuleUpdates'])
            ? params['intakeRuleUpdates'] as readonly unknown[]
            : []
          try {
            producer.reconcileIntakeRuleUpdates(targetRules)
          } catch (error) {
            evalCtx.logger.warn(`assistant-proactive: failed to reconcile intakeRuleUpdates from evaluation: ${error instanceof Error ? error.message : String(error)}`)
          }
          return
        }
        const updates = payload['intakeRuleUpdates']
        if (!Array.isArray(updates) || updates.length === 0) return
        try {
          producer.applyIntakeRuleUpdates(updates)
        } catch (error) {
          evalCtx.logger.warn(`assistant-proactive: failed to apply intakeRuleUpdates from evaluation: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      let unsubscribe: (() => void) | undefined
      if (typeof evaluation?.onAttentionTuningChanged === 'function') {
        unsubscribe = evaluation.onAttentionTuningChanged(applyEvent)
      } else if (typeof evaluation?.onAttentionLooseningAdopted === 'function') {
        unsubscribe = evaluation.onAttentionLooseningAdopted(applyEvent)
      }
      if (unsubscribe !== undefined) {
        evalCtx.effect(() => unsubscribe, 'assistant-proactive.evaluation-tuning')
      }
    })
  }
  /** Host-only read-only readiness/health for operators and doctor; grants nothing. */
  intakeEvaluationHealth = (): ProactiveIntakeEvaluationHealth => this.#intakeEvaluation?.health() ?? this.#intakeEvaluationHealth
  /** Host-only live rule overrides (`enabled`, `mode`, thresholds) without bumping `policy().version`. */
  applyIntakeRuleUpdates = (updates: readonly ProactiveIntakeRuleUpdate[]): readonly ProactiveIntakeRuleOverride[] => {
    if (!this.#active) throw new Error('assistant-proactive: disposed')
    return this.#intakeEvaluation?.applyIntakeRuleUpdates(updates) ?? Object.freeze([])
  }
  /** Host-only authoritative rule override reconciliation without bumping `policy().version`. */
  reconcileIntakeRuleUpdates = (updates: readonly ProactiveIntakeRuleUpdate[]): readonly ProactiveIntakeRuleOverride[] => {
    if (!this.#active) throw new Error('assistant-proactive: disposed')
    return this.#intakeEvaluation?.reconcileIntakeRuleUpdates(updates) ?? Object.freeze([])
  }
  intakeRuleOverrides = (): readonly ProactiveIntakeRuleOverride[] => {
    if (!this.#active) throw new Error('assistant-proactive: disposed')
    return this.#intakeEvaluation?.intakeRuleOverrides() ?? Object.freeze([])
  }
  assertProfile = (profileId: string): void => {
    if (!this.#active || !this.#profiles.has(profileId)) throw new Error('assistant-proactive: configured active opportunity profile required')
    if (this.#profiles.get(profileId)!.preparation && !this.#preparations.available()) throw new Error('assistant-proactive: preparation services unavailable')
    if (this.#profiles.get(profileId)!.mode === 'remind' && !this.#notificationPort()) throw new Error('assistant-proactive: reminder delivery service unavailable')
  }
  availableProfiles = (agent: Agent | undefined) => {
    this.#scope(agent, false, false)
    return Object.freeze([...this.#profiles.values()].filter(profile => {
      try { this.assertProfile(profile.id); return true } catch { return false }
    }).slice(0, 16).map(profile => Object.freeze({ id: profile.id, mode: profile.mode,
      maxDecisionsPerGoal: profile.maxDecisionsPerGoal, maxExecutionsPerGoal: profile.maxExecutionsPerGoal,
      maxRemindersPerGoal: profile.maxRemindersPerGoal })))
  }
  preauthorizeStatus = (execution: ToolExecution): boolean => {
    try {
      if (execution.signal.aborted || !execution.arguments || typeof execution.arguments !== 'object'
        || Array.isArray(execution.arguments) || Object.getPrototypeOf(execution.arguments) !== Object.prototype
        || Object.getOwnPropertySymbols(execution.arguments).length !== 0) return false
      const args = execution.arguments as Record<string, unknown>
      if (Object.getOwnPropertyNames(args).some(key => key !== 'goal_id')
        || Object.values(Object.getOwnPropertyDescriptors(args)).some(value => !value.enumerable || !('value' in value))
        || args.goal_id !== undefined && (typeof args.goal_id !== 'string' || args.goal_id.length === 0 || args.goal_id.length > 4096)) return false
      this.#scope(execution.agent, false, false)
      return true
    } catch { return false }
  }
  evaluate = (input: OpportunityInput, runtimeContext?: ProactiveRuntimeContext) => {
    this.assertProfile(input.profileId)
    const resolvedContext = this.#resolveRuntimeContext(input, runtimeContext)
    const overlay = this.#configuredProfileMode(input.profileId) === 'remind' ? this.#attentionOverlay(input.scope) : undefined
    const evaluation = this.#engine.evaluate(input, overlay, resolvedContext)
    const decision = evaluation.decision
    if (evaluation.disposition === 'consume' && decision.mode === 'remind' && decision.state === 'decided') {
      const delivery = this.#notificationPort()
      if (!delivery) throw new Error('assistant-proactive: reminder delivery service unavailable')
      const profile = tuneProfile(this.#engine.profileSnapshot(decision.scope, decision.goalId, decision.profileId), overlay)
      const expiresAt = reminderExpiresAt(decision, profile)
      // An informational notice: no WorkItem or structured question exists, so `attention` would not apply.
      if (Date.now() < expiresAt) {
        delivery.enqueueOwnerNotification({ sourceId: 'assistant-proactive/v1', ownerRouteId: decision.ownerRouteId, scope: decision.scope, sessionId: decision.sessionId, idempotencyKey: `proactive-reminder:${decision.id}`, text: reminderText(decision), expiresAt, attention: { purpose: 'result' } })
        this.#engine.confirmReminder(decision)
      } else this.#engine.releaseReminder(decision) // never queued: a later unchanged event may still remind

    }
    if (evaluation.disposition === 'consume' && decision.mode === 'prepare' && decision.state === 'decided') {
      const profile = this.#engine.profileSnapshot(decision.scope, decision.goalId, decision.profileId)
      if (profile.preparation) {
        this.#preparations.store.enqueue(decision, profile.preparation, reminderExpiresAt(decision, profile))
        void this.#preparations.tick().catch(() => {})
      }
    }
    return evaluation
  }
  #recordOwnerActivity(workspace: string, preset: string, at = Date.now()): void {
    if (!Number.isSafeInteger(at) || at < 0) return
    const key = `${workspace}\0${preset}`
    if (!this.#lastOwnerActivityByScope.has(key) && this.#lastOwnerActivityByScope.size >= MAX_TRACKED_ACTIVITY_SCOPES) {
      const oldest = this.#lastOwnerActivityByScope.keys().next().value
      if (oldest !== undefined) this.#lastOwnerActivityByScope.delete(oldest)
    }
    const previous = this.#lastOwnerActivityByScope.get(key)
    if (previous === undefined || at > previous) this.#lastOwnerActivityByScope.set(key, at)
  }
  #resolveRuntimeContext(input: OpportunityInput, explicit?: ProactiveRuntimeContext): ProactiveRuntimeContext | undefined {
    const checked = validateRuntimeContext(explicit)
    const now = Date.now()
    const scopeKeyParts = { workspace: input.scope.workspace, preset: input.scope.preset }

    let userActive = checked?.userActive
    let latestActivityAt: number | undefined
    const noteActivity = (candidate: unknown) => {
      if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 && candidate <= now) {
        if (latestActivityAt === undefined || candidate > latestActivityAt) latestActivityAt = candidate
      }
    }

    if (userActive === undefined || checked?.idleDurationMs === undefined) {
      noteActivity(this.#lastOwnerActivityByScope.get(`${scopeKeyParts.workspace}\0${scopeKeyParts.preset}`))
      try {
        const agents = this.ctx.get('agents') as unknown as {
          currentInitiator?: () => unknown
          get?: (id: string) => unknown
          list?: () => unknown[]
          turnBoundaryOf?: (session: unknown) => { openTurnStartSeq?: unknown }
        } | undefined
        if (agents) {
          const candidates: unknown[] = []
          try { const initiator = agents.currentInitiator?.(); if (initiator) candidates.push(initiator) } catch {}
          try { const bySession = agents.get?.(input.sessionId); if (bySession) candidates.push(bySession) } catch {}
          try { const listed = agents.list?.(); if (Array.isArray(listed)) candidates.push(...listed) } catch {}
          for (const candidate of candidates) {
            if (!candidate || typeof candidate !== 'object') continue
            const agentObj = candidate as {
              id?: unknown
              status?: unknown
              lastActivityAt?: unknown
              session?: { header?: { cwd?: unknown; agentPreset?: unknown } }
            }
            const cwd = agentObj.session?.header?.cwd
            const preset = agentObj.session?.header?.agentPreset
            const matchesScope = (cwd === undefined || cwd === scopeKeyParts.workspace)
              && (preset === undefined || preset === scopeKeyParts.preset)
              && (cwd !== undefined || preset !== undefined || agentObj.id === input.sessionId)
            if (!matchesScope) continue
            noteActivity(agentObj.lastActivityAt)
            if (userActive === undefined) {
              if (typeof agentObj.status === 'string' && agentObj.status.length > 0
                && !['idle', 'stopped', 'disposed', 'closed'].includes(agentObj.status)) {
                userActive = true
              } else if (agentObj.session && typeof agents.turnBoundaryOf === 'function') {
                try {
                  const boundary = agents.turnBoundaryOf(agentObj.session)
                  if (typeof boundary?.openTurnStartSeq === 'number' && Number.isSafeInteger(boundary.openTurnStartSeq) && boundary.openTurnStartSeq >= 0) {
                    userActive = true
                  }
                } catch {}
              }
            }
          }
        }
      } catch {
        // Optional agents telemetry failure must never block evaluation.
      }
    }

    let recentNotificationCount = checked?.recentNotificationCount
    let acceptanceRatePpm = checked?.acceptanceRatePpm
    let acceptanceSamples = checked?.acceptanceSamples
    try {
      const evaluation = this.ctx.get('assistantEvaluation' as never) as unknown as {
        listTrustedTaskLearningProjections?: (query: unknown) => { items?: readonly { receipt?: { objective?: { occurredAt?: unknown } } }[] }
        notificationOutcomeSummary?: (query: unknown) => { total?: unknown; outcomes?: Record<string, unknown> }
      } | undefined
      if (evaluation) {
        if (checked?.idleDurationMs === undefined && userActive !== true && typeof evaluation.listTrustedTaskLearningProjections === 'function') {
          try {
            const feed = evaluation.listTrustedTaskLearningProjections({ scope: scopeKeyParts, limit: 1 })
            noteActivity(feed?.items?.[0]?.receipt?.objective?.occurredAt)
          } catch {}
        }
        if (recentNotificationCount === undefined && typeof evaluation.notificationOutcomeSummary === 'function') {
          try {
            const recent = evaluation.notificationOutcomeSummary({
              scope: scopeKeyParts,
              fromNotifiedAt: Math.max(0, now - RECENT_NOTIFICATION_WINDOW_MS),
              toNotifiedAt: now + 1,
            })
            if (typeof recent?.total === 'number' && Number.isSafeInteger(recent.total) && recent.total >= 0) {
              recentNotificationCount = recent.total
            }
          } catch {}
        }
        if (acceptanceRatePpm === undefined && typeof evaluation.notificationOutcomeSummary === 'function') {
          try {
            const history = evaluation.notificationOutcomeSummary({
              scope: scopeKeyParts,
              fromNotifiedAt: Math.max(0, now - ACCEPTANCE_SUMMARY_WINDOW_MS),
              toNotifiedAt: now + 1,
            })
            const accepted = history?.outcomes?.['accepted']
            const rejected = history?.outcomes?.['rejected']
            if (typeof accepted === 'number' && Number.isSafeInteger(accepted) && accepted >= 0
              && typeof rejected === 'number' && Number.isSafeInteger(rejected) && rejected >= 0) {
              const total = accepted + rejected
              if (total > 0) {
                acceptanceSamples = Math.min(1_000_000, total)
                acceptanceRatePpm = Math.floor((accepted * 1_000_000) / total)
              }
            }
          } catch {}
        }
      }
    } catch {
      // Optional Evaluation telemetry failure must never block evaluation.
    }

    const idleDurationMs = checked?.idleDurationMs !== undefined
      ? checked.idleDurationMs
      : userActive !== true && latestActivityAt !== undefined
        ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, now - latestActivityAt))
        : undefined
    const urgencyPpm = checked?.urgencyPpm

    if (userActive === undefined
      && idleDurationMs === undefined
      && recentNotificationCount === undefined
      && urgencyPpm === undefined
      && acceptanceRatePpm === undefined
      && acceptanceSamples === undefined) {
      return undefined
    }
    return {
      ...(userActive === undefined ? {} : { userActive }),
      ...(idleDurationMs === undefined ? {} : { idleDurationMs }),
      ...(recentNotificationCount === undefined ? {} : { recentNotificationCount }),
      ...(urgencyPpm === undefined ? {} : { urgencyPpm }),
      ...(acceptanceRatePpm === undefined ? {} : { acceptanceRatePpm }),
      ...(acceptanceSamples === undefined ? {} : { acceptanceSamples }),
    }
  }
  #configuredProfileMode(profileId: string): OpportunityProfile['mode'] | undefined { return this.#profiles.get(profileId)?.mode }
  /**
   * WP22: the current verified attention version for proactive reminders, read
   * structurally from Evaluation. Absent service, switch off, errors, version 0
   * or malformed values all mean no overlay (identical untuned behavior).
   */
  #attentionOverlay(scope: OpportunityScope): AttentionOverlay | undefined {
    const evaluation = this.ctx.get('assistantEvaluation' as never) as unknown as { currentAttentionTuning?: (input: unknown) => unknown } | undefined
    if (typeof evaluation?.currentAttentionTuning !== 'function') return undefined
    try {
      return attentionOverlay(evaluation.currentAttentionTuning({ scope: { workspace: scope.workspace, preset: scope.preset }, cohort: { ...proactiveAttentionCohort } }))
    } catch { return undefined }
  }
  #notificationPort(): NotificationPort | undefined {
    const delivery = this.ctx.get('assistantDelivery') as unknown as Partial<NotificationPort> | undefined
    return typeof delivery?.enqueueOwnerNotification === 'function' ? delivery as NotificationPort : undefined
  }
  closeWait = (waitId: string, scope: OpportunityScope, reason: 'expired' | 'cancelled'): void => {
    if (!this.#active) throw new Error('assistant-proactive: disposed')
    const links = this.#engine.sourcesForWait(waitId, scope)
    this.#engine.closeWait(waitId, scope, reason)
    this.#preparations.store.cancelWait(waitId, scope)
    this.#cleanupClosedWaitLinks(links, scope, reason)
  }
  /** Host-only hook notified when a linked proactive goal finishes, cancels, expires, or retires. */
  registerGoalUnsubscribeHook = (hook: ProactiveGoalUnsubscribeHook): (() => void) => {
    if (!this.#active) throw new Error('assistant-proactive: disposed')
    if (typeof hook !== 'function') throw new Error('assistant-proactive: invalid goal unsubscribe hook')
    if (!this.#goalUnsubscribeHooks.has(hook) && this.#goalUnsubscribeHooks.size >= MAX_GOAL_UNSUBSCRIBE_HOOKS) {
      throw new Error('assistant-proactive: goal unsubscribe hook limit reached')
    }
    this.#goalUnsubscribeHooks.add(hook)
    return () => { this.#goalUnsubscribeHooks.delete(hook) }
  }
  /** Host-only bounded cleanup that retires proactive goal opportunities and unsubscribes linked EventTriggers sources. */
  retireGoalSources = (input: ProactiveGoalRetireInput): readonly Readonly<ProactiveGoalUnsubscribeResult>[] => {
    if (!this.#active) throw new Error('assistant-proactive: disposed')
    if (!input || typeof input !== 'object'
      || (input.waitId !== undefined && (typeof input.waitId !== 'string' || input.waitId.trim().length === 0))
      || (input.sourceId !== undefined && (typeof input.sourceId !== 'string' || input.sourceId.trim().length === 0))) {
      throw new Error('assistant-proactive: invalid goal retire input')
    }
    const rawLinks = input.waitId !== undefined
      ? this.#engine.sourcesForWait(input.waitId, input.scope)
      : this.#engine.sourcesForGoal(input.scope, input.goalId)
    const links = input.sourceId === undefined
      ? rawLinks
      : rawLinks.filter(link => link.sourceId === input.sourceId)
    if (input.sourceId === undefined && input.waitId === undefined) {
      this.#engine.closeGoal(input.scope, input.goalId, input.reason)
      this.#preparations.store.cancelGoal(input.goalId, input.scope, `goal-${input.reason}`)
    } else if (input.waitId !== undefined) {
      this.#engine.closeWait(input.waitId, input.scope, input.reason === 'expired' ? 'expired' : 'cancelled')
      this.#preparations.store.cancelWait(input.waitId, input.scope)
    }
    const decidedAt = Date.now()
    if (links.length === 0) {
      const detached = this.#callEventTriggersUnsubscribe({
        scope: input.scope,
        goalId: input.goalId,
        reason: input.reason,
        ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
      })
      if (input.sourceId === undefined && detached.length === 0) return Object.freeze([])
      const resolvedSourceId = input.sourceId ?? detached[0]!
      const hooksNotified = this.#notifyUnsubscribeHooks({
        scope: input.scope,
        goalId: input.goalId,
        ...(input.waitId === undefined ? {} : { waitId: input.waitId }),
        sourceId: resolvedSourceId,
        reason: input.reason,
        decidedAt,
      })
      return Object.freeze([Object.freeze({
        scope: input.scope,
        goalId: input.goalId,
        sourceId: resolvedSourceId,
        reason: input.reason,
        detachedTriggers: detached,
        hooksNotified,
      })])
    }
    return Object.freeze(links.map(link => this.#retireLink(link, input.reason, decidedAt)))
  }
  /** Host-only deterministic WP20/WP12 intake routing helper (no model calls, no ledger writes). */
  routeIntakeObservation = (
    input: ProactiveIntakeObservationInput,
    options: Readonly<{ sourcePolicy?: { readonly unaddressedGroupMessages?: boolean; readonly unsubscribedEvents?: boolean } }> = {},
  ): Readonly<ProactiveIntakeRoutePlan> => {
    if (!this.#active) throw new Error('assistant-proactive: disposed')
    return planProactiveIntakeRoute(input, {
      evaluationHealth: this.intakeEvaluationHealth(),
      ...(options.sourcePolicy === undefined ? {} : { sourcePolicy: options.sourcePolicy }),
    })
  }
  #onGoalChanged(payload: unknown): void {
    if (!this.#active) return
    const signal = parseTerminalGoalChanged(payload)
    if (!signal || !signal.nativeGoalId) return
    const key = `${signal.sessionId ?? ''}\0${signal.nativeGoalId}\0${signal.reason}`
    if (this.#pendingGoalChanges.size < MAX_PENDING_GOAL_CHANGE_SIGNALS) {
      this.#pendingGoalChanges.set(key, signal)
    }
    if (this.#goalChangeMicrotaskQueued) return
    this.#goalChangeMicrotaskQueued = true
    queueMicrotask(() => {
      this.#goalChangeMicrotaskQueued = false
      if (!this.#active) {
        this.#pendingGoalChanges.clear()
        return
      }
      const batch = Array.from(this.#pendingGoalChanges.values())
      this.#pendingGoalChanges.clear()
      for (const item of batch) this.#reconcileTerminalGoalSignal(item)
    })
  }
  #reconcileTerminalGoalSignal(signal: TerminalGoalChangeSignal): void {
    if (!this.#active || !signal.nativeGoalId) return
    let decisions: readonly OpportunityDecision[]
    try {
      decisions = this.#engine.listByNativeGoal(signal.nativeGoalId, signal.sessionId)
    } catch {
      return
    }
    if (decisions.length === 0) return
    const assistantGoals = this.ctx.get('assistantGoals' as never) as unknown as GoalLifecycleInspectPort | undefined
    const seenGoals = new Map<string, { scope: OpportunityScope; goalId: string; nativeGoalId: string; sessionId: string }>()
    for (const decision of decisions) {
      if (signal.workspace !== undefined && decision.scope.workspace !== signal.workspace) continue
      if (signal.preset !== undefined && decision.scope.preset !== signal.preset) continue
      const goalKey = `${acceptanceDigest(decision.scope)}\0${decision.goalId}`
      if (!seenGoals.has(goalKey)) {
        seenGoals.set(goalKey, {
          scope: decision.scope,
          goalId: decision.goalId,
          nativeGoalId: decision.nativeGoalId,
          sessionId: decision.sessionId,
        })
      }
    }
    for (const entry of seenGoals.values()) {
      let effectiveReason: ProactiveGoalLifecycleReason = signal.reason
      if (typeof assistantGoals?.inspectGoalLifecycle === 'function') {
        try {
          const current = assistantGoals.inspectGoalLifecycle({ scope: entry.scope, goalId: entry.goalId })
          if (current && current.native.goalId === entry.nativeGoalId && current.native.sessionId === entry.sessionId) {
            if (current.native.phase === 'complete') effectiveReason = 'completed'
            else if (current.native.phase === 'cleared' || current.native.phase === 'blocked') effectiveReason = 'cancelled'
            else continue
          }
        } catch {
          // Proceed with the event-borne terminal signal when inspect is unavailable.
        }
      }
      try {
        this.retireGoalSources({ scope: entry.scope, goalId: entry.goalId, reason: effectiveReason })
      } catch {
        // Bounded best-effort reconciliation must not crash the microtask turn.
      }
    }
  }
  #cleanupClosedWaitLinks(
    links: readonly ProactiveGoalSourceLink[],
    scope: OpportunityScope,
    waitReason: 'expired' | 'cancelled',
  ): void {
    if (links.length === 0) return
    const assistantGoals = this.ctx.get('assistantGoals' as never) as unknown as GoalLifecycleInspectPort | undefined
    const reasonByGoal = new Map<string, ProactiveGoalLifecycleReason | undefined>()
    const decidedAt = Date.now()
    for (const link of links) {
      let effectiveReason = reasonByGoal.get(link.goalId)
      if (!reasonByGoal.has(link.goalId)) {
        effectiveReason = waitReason
        if (typeof assistantGoals?.inspectGoalLifecycle === 'function') {
          try {
            const goal = assistantGoals.inspectGoalLifecycle({ scope, goalId: link.goalId })
            if (goal?.native.phase === 'complete') {
              effectiveReason = 'completed'
            } else if (goal?.native.phase === 'cleared' || goal?.native.phase === 'blocked') {
              effectiveReason = 'cancelled'
            } else if (goal?.native.phase === 'paused' || goal?.native.phase === 'active') {
              effectiveReason = waitReason === 'expired' ? 'expired' : undefined
            }
          } catch {
            effectiveReason = waitReason
          }
        }
        reasonByGoal.set(link.goalId, effectiveReason)
      }
      if (effectiveReason === undefined) continue
      if (effectiveReason !== waitReason || waitReason === 'expired') {
        try {
          this.#preparations.store.cancelGoal(link.goalId, scope, `goal-${effectiveReason}`)
        } catch {
          // Non-fatal if wait cancellation already updated matching preparations.
        }
      }
      this.#retireLink(link, effectiveReason, decidedAt)
    }
  }
  #retireLink(
    link: Readonly<ProactiveGoalSourceLink>,
    reason: ProactiveGoalLifecycleReason,
    decidedAt: number,
  ): ProactiveGoalUnsubscribeResult {
    const detachedTriggers = this.#callEventTriggersUnsubscribe({
      scope: link.scope,
      goalId: link.goalId,
      reason,
      sourceId: link.sourceId,
      ...(link.sourceDigest === undefined ? {} : { sourceDigest: link.sourceDigest }),
      ...(link.definitionDigest === undefined ? {} : { definitionDigest: link.definitionDigest }),
    })
    const hooksNotified = this.#notifyUnsubscribeHooks({ ...link, reason, decidedAt })
    return Object.freeze({
      scope: link.scope,
      goalId: link.goalId,
      sourceId: link.sourceId,
      reason,
      detachedTriggers,
      hooksNotified,
    })
  }
  #callEventTriggersUnsubscribe(input: {
    scope: OpportunityScope
    goalId: string
    reason: ProactiveGoalLifecycleReason
    sourceId?: string
    sourceDigest?: string
    definitionDigest?: string
  }): readonly string[] {
    const eventTriggers = this.ctx.get('eventTriggers' as never) as unknown as EventTriggersUnsubscribePort | undefined
    if (typeof eventTriggers?.unsubscribeGoalSources !== 'function') return Object.freeze([])
    try {
      const detached = eventTriggers.unsubscribeGoalSources(input)
      const unique: string[] = []
      const seen = new Set<string>()
      for (const triggerId of detached) {
        if (typeof triggerId === 'string' && triggerId.length > 0 && !seen.has(triggerId) && unique.length < 64) {
          seen.add(triggerId)
          unique.push(triggerId)
        }
      }
      return Object.freeze(unique)
    } catch {
      return Object.freeze([])
    }
  }
  #notifyUnsubscribeHooks(event: Readonly<ProactiveGoalUnsubscribeEvent>): number {
    const dedupeKey = [
      acceptanceDigest(event.scope),
      event.goalId,
      event.waitId ?? '',
      event.sourceId,
      event.sourceDigest ?? '',
      event.definitionDigest ?? '',
      event.reason,
    ].join('\0')
    if (this.#emittedGoalUnsubscribes.has(dedupeKey)) return 0
    this.#rememberGoalUnsubscribe(dedupeKey)
    const frozen = Object.freeze({ ...event })
    let notified = 0
    for (const hook of Array.from(this.#goalUnsubscribeHooks)) {
      try {
        hook(frozen)
        notified += 1
      } catch {
        // Hook errors must never prevent subsequent cleanup listeners.
      }
    }
    return notified
  }
  #rememberGoalUnsubscribe(key: string): void {
    if (this.#emittedGoalUnsubscribes.has(key)) return
    if (this.#emittedGoalUnsubscribes.size >= MAX_REMEMBERED_GOAL_UNSUBSCRIBES) {
      const oldest = this.#emittedGoalUnsubscribes.values().next().value
      if (oldest !== undefined) this.#emittedGoalUnsubscribes.delete(oldest)
    }
    this.#emittedGoalUnsubscribes.add(key)
  }
  #scope(agent: Agent | undefined, feedback: boolean, consume = true): OpportunityScope {
    if (!this.#active) throw new Error('assistant-proactive: disposed')
    if (!agent || this.ctx.get('agents')?.get(agent.id) !== agent) throw new Error('assistant-proactive: exact live agent required')
    const delivery = this.ctx.get('assistantDelivery') as AssistantDeliveryService | undefined
    const owner = delivery?.preferencePrincipalForAgent(agent)
    if (!owner || owner.scope.workspace !== agent.session.header.cwd || owner.scope.preset !== agent.session.header.agentPreset) throw new Error('assistant-proactive: authenticated owner required')
    const scope = { principalId: owner.principalId, ...owner.principalLineage, workspace: owner.scope.workspace, preset: owner.scope.preset }
    if (feedback) {
      const turn = delivery?.currentPreferenceTurn(agent)
      if (!turn || acceptanceDigest({ principalId: turn.principalId, ...turn.principalLineage, workspace: turn.scope.workspace, preset: turn.scope.preset }) !== acceptanceDigest(scope)) throw new Error('assistant-proactive: current authenticated owner turn required')
    }
    const policy = this.ctx.get('assistantPolicy') as AssistantPolicyService | undefined
    const decision = consume ? policy?.authorizeAgent(agent, feedback ? 'feedback' : 'inspect', { kind: 'goal', id: 'proactive-opportunities' })
      : policy?.evaluateAgent(agent, feedback ? 'feedback' : 'inspect', { kind: 'goal', id: 'proactive-opportunities' })
    if (decision?.effect !== 'allow') throw new Error('assistant-proactive: policy denied')
    return scope
  }
  #formatOpportunity = (decision: Readonly<OpportunityDecision>): ProactiveOpportunityInspection => {
    const preparation = this.#preparations.store.get(decision.id)
    if (!preparation) return decision
    return Object.freeze({
      ...decision,
      preparation: Object.freeze({
        state: preparation.state,
        reason: preparation.reason,
        updatedAt: preparation.updatedAt,
        ...(preparation.result ? {
          output: preparation.result.output,
          sessionId: preparation.result.sessionId,
          usage: preparation.result.usage,
          diagnostic: preparation.result.diagnostic,
          verified: false as const,
        } : {}),
      }),
    })
  }
  #attentionScopes(requested?: { workspace: string; preset: string }): readonly { workspace: string; preset: string }[] {
    if (requested !== undefined) {
      if (!requested || typeof requested.workspace !== 'string' || !requested.workspace.startsWith('/') || typeof requested.preset !== 'string' || requested.preset.length === 0) {
        throw new Error('assistant-proactive: invalid attention question scope')
      }
      return [{ workspace: requested.workspace, preset: requested.preset }]
    }
    const unique = new Map<string, { workspace: string; preset: string }>()
    const addScope = (workspace: unknown, preset: unknown) => {
      if (typeof workspace !== 'string' || !workspace.startsWith('/') || typeof preset !== 'string' || preset.length === 0) return
      const key = `${workspace}\0${preset}`
      if (!unique.has(key)) unique.set(key, { workspace, preset })
    }
    for (const scope of this.#engine.listScopes()) addScope(scope.workspace, scope.preset)
    try {
      const delivery = this.ctx.get('assistantDelivery' as never) as { listOwnerRoutes?: () => readonly { workspace?: unknown; agentPreset?: unknown }[] } | undefined
      if (typeof delivery?.listOwnerRoutes === 'function') {
        for (const route of delivery.listOwnerRoutes()) addScope(route.workspace, route.agentPreset)
      }
    } catch { /* Optional Delivery discovery failed; continue with recorded proactive scopes. */ }
    return [...unique.values()]
  }
  inspect = (agent: Agent | undefined, goalId?: string) => {
    const scope = this.#scope(agent, false)
    this.#recordOwnerActivity(scope.workspace, scope.preset)
    return this.#engine.list(scope, goalId).map(this.#formatOpportunity)
  }
  /** Host-only read-only draft inspection for owner operator surfaces (zero execution authority). */
  inspectDrafts = (filter: ProactiveDraftFilter = {}): readonly ProactiveDraftInspection[] => {
    if (!this.#active) throw new Error('assistant-proactive: disposed')
    if (filter.onlyDrafts && filter.state !== undefined && filter.state !== 'draft') {
      return Object.freeze([])
    }
    const effectiveState = filter.onlyDrafts ? 'draft' as const : filter.state
    const hasScopeParts = filter.workspace !== undefined || filter.preset !== undefined
    const records = this.#preparations.store.list({
      ...(filter.scope !== undefined ? { scope: filter.scope } : {}),
      ...(filter.goalId !== undefined ? { goalId: filter.goalId } : {}),
      ...(effectiveState !== undefined ? { state: effectiveState } : {}),
      ...(hasScopeParts ? { limit: 500 } : filter.limit === undefined ? {} : { limit: filter.limit }),
    }).filter(record =>
      (filter.workspace === undefined || record.decision.scope.workspace === filter.workspace)
      && (filter.preset === undefined || record.decision.scope.preset === filter.preset),
    )
    const limit = typeof filter.limit === 'number' && Number.isSafeInteger(filter.limit) && filter.limit > 0
      ? Math.min(filter.limit, 500) : 100
    return Object.freeze(records.slice(0, limit).map(record => {
      const decision = this.#engine.get(record.id)
      return Object.freeze({
        id: record.id,
        goalId: record.decision.goalId,
        profileId: record.decision.profileId,
        scope: record.decision.scope,
        objective: record.decision.objective,
        state: record.state,
        ...(record.reason === undefined ? {} : { reason: record.reason }),
        ...(decision?.feedback === undefined ? {} : { feedback: decision.feedback }),
        decisionState: decision?.state ?? record.decision.state,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        deadlineAt: record.deadlineAt,
        ...(record.result === undefined ? {} : {
          output: record.result.output,
          ...(record.result.sessionId === undefined ? {} : { sessionId: record.result.sessionId }),
          usage: record.result.usage,
          ...(record.result.diagnostic === undefined ? {} : { diagnostic: record.result.diagnostic }),
        }),
        verified: false as const,
      })
    }))
  }
  /** Host-only opportunity decision inspection across owner scopes. */
  inspectOpportunities = (filter: ProactiveOpportunityFilter = {}): readonly ProactiveOpportunityInspection[] => {
    if (!this.#active) throw new Error('assistant-proactive: disposed')
    return Object.freeze(this.#engine.listAll(filter).map(this.#formatOpportunity))
  }
  /** Host-only action to accept or reject/dismiss an existing opportunity draft. */
  resolveDraft = (input: {
    id: string
    decision?: 'accepted' | 'rejected'
    action?: 'accept' | 'reject' | 'cancel'
    workspace?: string
    preset?: string
  }): Readonly<OpportunityDecision> | undefined => {
    if (!this.#active) throw new Error('assistant-proactive: disposed')
    if (!input || typeof input.id !== 'string' || input.id.length === 0) {
      throw new Error('assistant-proactive: invalid draft resolution input')
    }
    let mappedDecision: 'accepted' | 'rejected' | undefined = input.decision
    if (input.action !== undefined) {
      if (input.action !== 'accept' && input.action !== 'reject' && input.action !== 'cancel') {
        throw new Error('assistant-proactive: invalid draft resolution input')
      }
      const fromAction = input.action === 'accept' ? 'accepted' as const : 'rejected' as const
      if (mappedDecision !== undefined && mappedDecision !== fromAction) {
        throw new Error('assistant-proactive: invalid draft resolution input')
      }
      mappedDecision = fromAction
    }
    if (mappedDecision !== 'accepted' && mappedDecision !== 'rejected') {
      throw new Error('assistant-proactive: invalid draft resolution input')
    }
    const existing = this.#engine.get(input.id)
    if (!existing) return undefined
    if ((input.workspace !== undefined && existing.scope.workspace !== input.workspace)
      || (input.preset !== undefined && existing.scope.preset !== input.preset)) {
      throw new Error('assistant-proactive: draft scope mismatch')
    }
    if (input.action === 'accept') {
      const preparation = this.#preparations.store.get(existing.id)
      if (!preparation || preparation.state !== 'draft') {
        throw new Error('assistant-proactive: draft is not ready to accept')
      }
    }
    if (existing.state === 'closed' && existing.feedback === mappedDecision) {
      this.#recordOwnerActivity(existing.scope.workspace, existing.scope.preset)
      if (mappedDecision === 'rejected') this.#preparations.store.cancel(existing.id)
      return existing
    }
    const resolved = this.#engine.feedback(existing.id, existing.scope, mappedDecision)
    this.#recordOwnerActivity(existing.scope.workspace, existing.scope.preset)
    if (mappedDecision === 'rejected') this.#preparations.store.cancel(existing.id)
    return resolved
  }
  /** Host-only read-only view of WP22 proactive attention-loosening owner questions. */
  inspectAttentionQuestions = (filter: ProactiveAttentionQuestionFilter = {}): readonly ProactiveAttentionQuestionInspection[] => {
    if (!this.#active) throw new Error('assistant-proactive: disposed')
    const evaluation = this.ctx.get('assistantEvaluation' as never) as unknown as EvaluationAttentionPort | undefined
    if (!evaluation || typeof evaluation.attentionLooseningStatus !== 'function') return Object.freeze([])
    const requestedScope = filter.scope ?? (filter.workspace !== undefined && filter.preset !== undefined
      ? { workspace: filter.workspace, preset: filter.preset }
      : undefined)
    const scopes = this.#attentionScopes(requestedScope)
    const items: ProactiveAttentionQuestionInspection[] = []
    for (const scope of scopes) {
      let status: ReturnType<NonNullable<EvaluationAttentionPort['attentionLooseningStatus']>>
      try {
        status = evaluation.attentionLooseningStatus({ scope, cohort: { ...proactiveAttentionCohort } })
      } catch {
        continue
      }
      let questionStatus: ReturnType<NonNullable<EvaluationAttentionPort['attentionOwnerQuestionStatus']>> | undefined
      if (typeof evaluation.attentionOwnerQuestionStatus === 'function') {
        try {
          questionStatus = evaluation.attentionOwnerQuestionStatus({ scope, cohort: { ...proactiveAttentionCohort } })
        } catch {
          questionStatus = undefined
        }
      }
      const proposalDecisions = new Map(status.proposals.map(entry => [entry.proposalId, entry.decision]))
      const deliveries = new Map((questionStatus?.deliveries ?? []).map(entry => [entry.questionId, entry]))
      const replies = new Map((questionStatus?.replies ?? []).map(entry => [entry.questionId, entry]))
      const activeGrantId = status.grant?.grant.grantId
      for (const entry of status.questions) {
        const question = entry.question
        const proposalDecision = proposalDecisions.get(question.proposalId) ?? null
        const delivery = deliveries.get(entry.questionId) ?? null
        const reply = replies.get(entry.questionId) ?? null
        const open = reply === null
          && delivery?.status !== 'closed'
          && delivery?.status !== 'expired'
          && proposalDecision === null
          && (activeGrantId === undefined || activeGrantId === question.grantId)
        if (filter.includeResolved === false && !open) continue
        items.push(Object.freeze({
          questionId: entry.questionId,
          scope: Object.freeze({ workspace: scope.workspace, preset: scope.preset }),
          proposalId: question.proposalId,
          parameter: question.change.parameter,
          parentValue: question.change.parentValue,
          candidateValue: question.change.candidateValue,
          delta: question.change.delta,
          exceeded: Object.freeze([...question.exceeded]),
          choices: question.choices,
          delivery: delivery === null ? null : Object.freeze({
            status: delivery.status,
            outboxId: delivery.outboxId,
            recordedAt: delivery.recordedAt,
          }),
          reply: reply === null ? null : Object.freeze({
            choice: reply.choice,
            repliedAt: reply.repliedAt,
          }),
          decision: proposalDecision === null ? null : Object.freeze({
            decision: proposalDecision.decision,
            reason: proposalDecision.reason,
            decidedAt: proposalDecision.decidedAt,
          }),
          open,
          createdAt: question.createdAt,
        }))
      }
    }
    items.sort((left, right) => right.createdAt - left.createdAt || left.questionId.localeCompare(right.questionId))
    const limit = typeof filter.limit === 'number' && Number.isSafeInteger(filter.limit) && filter.limit > 0
      ? Math.min(filter.limit, 500) : 50
    return Object.freeze(items.slice(0, limit))
  }
  /** Host-only action delegating an owner attention reply to Evaluation's verified apply path. */
  resolveAttentionQuestion = (input: {
    scope?: { workspace: string; preset: string }
    workspace?: string
    preset?: string
    questionId: string
    choice: 'authorize-once' | 'decline'
  }): Readonly<ProactiveAttentionQuestionResolveResult> => {
    if (!this.#active) throw new Error('assistant-proactive: disposed')
    const scope = input?.scope ?? (input?.workspace !== undefined && input?.preset !== undefined
      ? { workspace: input.workspace, preset: input.preset }
      : undefined)
    if (!input || !scope || typeof scope.workspace !== 'string' || !scope.workspace.startsWith('/')
      || typeof scope.preset !== 'string' || scope.preset.length === 0
      || typeof input.questionId !== 'string' || input.questionId.length === 0
      || (input.choice !== 'authorize-once' && input.choice !== 'decline')) {
      throw new Error('assistant-proactive: invalid attention question reply input')
    }
    const evaluation = this.ctx.get('assistantEvaluation' as never) as unknown as EvaluationAttentionPort | undefined
    if (!evaluation || typeof evaluation.applyAttentionOwnerQuestionReply !== 'function') {
      return Object.freeze({ status: 'rejected', reason: 'evaluation-unavailable' })
    }
    this.#recordOwnerActivity(scope.workspace, scope.preset)
    return Object.freeze(evaluation.applyAttentionOwnerQuestionReply({
      scope: { workspace: scope.workspace, preset: scope.preset },
      cohort: { ...proactiveAttentionCohort },
      questionId: input.questionId,
      choice: input.choice,
    }))
  }
  reconcilePreparations = (): Promise<void> => this.#preparations.tick()
  feedback = (agent: Agent | undefined, id: string, feedback: 'accepted' | 'rejected') => {
    const scope = this.#scope(agent, true)
    const decision = this.#engine.feedback(id, scope, feedback)
    this.#recordOwnerActivity(scope.workspace, scope.preset)
    if (feedback === 'rejected') this.#preparations.store.cancel(id)
    return decision
  }
}
export function apply(ctx: Context, config: Config = {}): void { new AssistantProactiveService(ctx, config) }
export default { name, Config, apply }
