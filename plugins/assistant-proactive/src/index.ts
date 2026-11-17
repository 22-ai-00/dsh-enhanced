import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import type { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import Schema from '@deepseek-ai/schemastery'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { OpportunityEngine, validateProfile } from './engine.js'
import type {
  OpportunityDecision, OpportunityInput, OpportunityProfile, OpportunityScope,
  ProactiveAttentionQuestionFilter, ProactiveAttentionQuestionInspection, ProactiveAttentionQuestionResolveResult,
  ProactiveDraftFilter, ProactiveDraftInspection, ProactiveOpportunityFilter, ProactiveOpportunityInspection,
} from './types.js'
import { reminderText, reminderExpiresAt } from './reminder.js'
import { attentionOverlay, proactiveAttentionCohort, tuneProfile, type AttentionOverlay } from './attention-tuning.js'
import {
  DISABLED_INTAKE_EVALUATION_HEALTH, IntakeEvaluationProducer, normalizeIntakeEvaluation,
  type IntakeEvaluationConfig, type IntakeWorkItemsRegistration, type ProactiveIntakeEvaluationHealth,
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

export const name = 'dsh-enhanced-assistant-proactive'
export { version, OpportunityEngine, validateProfile, attentionOverlay, tuneProfile, proactiveAttentionCohort }
export {
  DISABLED_INTAKE_EVALUATION_HEALTH, INTAKE_EVALUATION_LEVELS, IntakeEvaluationError, IntakeEvaluationProducer,
  intakeEvaluationPolicy, MAX_INTAKE_EVALUATION_QUOTES, MAX_INTAKE_EVALUATION_RULES, MAX_INTAKE_EVALUATION_QUOTE_CHARS,
  MAX_INTAKE_SOURCE_TEXT, normalizeIntakeEvaluation,
} from './intake-evaluation.js'
export type {
  IntakeEvaluationConfig, IntakeEvaluationErrorCode, IntakeEvaluationLevel, IntakeEvaluationPolicy,
  IntakeEvaluationRule, IntakeEvaluationRuleConfig, IntakeEvaluationVerdict, IntakeModelRequest,
  IntakeWorkItemsRegistration, NormalizedIntakeEvaluation, ProactiveIntakeEvaluationHealth,
  ProactiveIntakeEvaluationReadiness,
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
  // WP20 stage 3 producer: off by default. Enabling it names the frozen
  // provider/model and the Host rules; assistant-work-items must also enable
  // its own intakeLedger.evaluation for the registration to be accepted.
  intakeEvaluation: Schema.object({
    enabled: Schema.boolean().default(false),
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
  })).default([]),
})
declare module '@deepseek-ai/cordis' { interface Context { assistantProactive: AssistantProactiveService } }

/** This optional decision gate cannot resume a goal or grant tool/route authority. */
export class AssistantProactiveService extends Service {
  static Config = Config
  readonly #preparations: PreparationRuntime
  readonly #engine: OpportunityEngine
  readonly #profiles = new Map<string, OpportunityProfile>()
  /** Present only when intakeEvaluation is explicitly enabled; otherwise the plugin is byte-identical to before. */
  readonly #intakeEvaluation: IntakeEvaluationProducer | undefined
  readonly #goalUnsubscribeHooks = new Set<ProactiveGoalUnsubscribeHook>()
  readonly #emittedGoalUnsubscribes = new Set<string>()
  readonly #pendingGoalChanges = new Map<string, TerminalGoalChangeSignal>()
  #goalChangeMicrotaskQueued = false
  #active = true
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'assistantProactive')
    const intakeEvaluation = normalizeIntakeEvaluation(config.intakeEvaluation)
    const producer = intakeEvaluation === undefined ? undefined : new IntakeEvaluationProducer({ config: intakeEvaluation })
    this.#intakeEvaluation = producer
    for (const input of config.profiles ?? []) {
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
  }
  /** Host-only read-only readiness/health for operators and doctor; grants nothing. */
  intakeEvaluationHealth = (): ProactiveIntakeEvaluationHealth => this.#intakeEvaluation?.health() ?? DISABLED_INTAKE_EVALUATION_HEALTH
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
  evaluate = (input: OpportunityInput) => {
    this.assertProfile(input.profileId)
    const overlay = this.#configuredProfileMode(input.profileId) === 'remind' ? this.#attentionOverlay(input.scope) : undefined
    const evaluation = this.#engine.evaluate(input, overlay)
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
    return this.#engine.list(this.#scope(agent, false), goalId).map(this.#formatOpportunity)
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
      if (mappedDecision === 'rejected') this.#preparations.store.cancel(existing.id)
      return existing
    }
    const resolved = this.#engine.feedback(existing.id, existing.scope, mappedDecision)
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
    return Object.freeze(evaluation.applyAttentionOwnerQuestionReply({
      scope: { workspace: scope.workspace, preset: scope.preset },
      cohort: { ...proactiveAttentionCohort },
      questionId: input.questionId,
      choice: input.choice,
    }))
  }
  reconcilePreparations = (): Promise<void> => this.#preparations.tick()
  feedback = (agent: Agent | undefined, id: string, feedback: 'accepted' | 'rejected') => { const decision = this.#engine.feedback(id, this.#scope(agent, true), feedback); if (feedback === 'rejected') this.#preparations.store.cancel(id); return decision }
}
export function apply(ctx: Context, config: Config = {}): void { new AssistantProactiveService(ctx, config) }
export default { name, Config, apply }
