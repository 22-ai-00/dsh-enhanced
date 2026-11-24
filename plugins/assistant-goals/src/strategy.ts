import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { delegationDepthOf, foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import type { ResolvedSubagentStartRequest, SubagentActivation, SubagentProvider, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { GoalBudgetRuntime } from './budget.js'
import type { GoalFeedback } from './feedback.js'
import type { GoalOutcomeView } from './outcome.js'
import { STRATEGY_PROVIDER } from './strategy-identity.js'
import { startStrategyOneShot } from './strategy-one-shot.js'
import {
  extractRecentSessionToolOutcomes,
  filterPermittedStrategyTools,
  isForbiddenStrategyTool,
  isWriteMutationTool,
  recommendGoalStrategy,
  type RecentToolOutcome,
  type StrategyRoutingDecision,
} from './strategy-router.js'
import { GoalStrategyStore } from './strategy-store.js'
import type {
  StrategyAdviceDefinitionSummary,
  StrategyChildDiagnostics,
  StrategyOutcome,
  StrategyOutcomeTelemetry,
  StrategyRecord,
  StrategyRequestedKind,
  StrategyRouteMode,
  StrategyRoutingSummary,
  StrategyTaskDifficulty,
  StrategyTerminationReason,
} from './strategy-store.js'
import type { GoalExecutionRun, GoalRecord, GoalScope } from './types.js'

export interface GoalStrategyExperimentConfig {
  enabled: boolean
  allowedTools: readonly string[]
  maxToolCalls: number
  maxModelCalls: number
  workspaceWriteAllowed: boolean
}

export interface GoalStrategyCostBenefitConfig {
  minNetBenefit: number
  minRemainingParentCalls: number
  maxAdviceRepetitions: number
}

export interface GoalStrategyConfig {
  maxDurationMs: number
  maxPromptBytes: number
  maxOutputBytes: number
  maxRunsPerGoal: number
  autoRoute: boolean
  experiment: Readonly<GoalStrategyExperimentConfig>
  subagent: Readonly<GoalStrategyExperimentConfig>
  costBenefit: Readonly<GoalStrategyCostBenefitConfig>
}

export interface GoalStrategyExperimentConfigInput {
  enabled?: boolean | undefined
  allowedTools?: readonly string[] | undefined
  maxToolCalls?: number | undefined
  maxModelCalls?: number | undefined
  workspaceWriteAllowed?: boolean | undefined
}

export interface GoalStrategyCostBenefitConfigInput {
  minNetBenefit?: number | undefined
  minRemainingParentCalls?: number | undefined
  maxAdviceRepetitions?: number | undefined
}

export interface GoalStrategyConfigInput {
  maxDurationMs?: number | undefined
  maxPromptBytes?: number | undefined
  maxOutputBytes?: number | undefined
  maxRunsPerGoal?: number | undefined
  autoRoute?: boolean | undefined
  experiment?: Readonly<GoalStrategyExperimentConfigInput> | undefined
  subagent?: Readonly<GoalStrategyExperimentConfigInput> | undefined
  costBenefit?: Readonly<GoalStrategyCostBenefitConfigInput> | undefined
}

export interface GoalStrategyInput {
  kind: StrategyRequestedKind
  question: string
  context?: string | undefined
  tools?: readonly string[] | undefined
  failure_hint?: 'tool-failure' | 'reasoning-failure' | undefined
  difficulty_hint?: StrategyTaskDifficulty | undefined
}

export interface GoalStrategyResult {
  strategyId: string
  requestedKind?: StrategyRequestedKind
  resolvedKind?: StrategyRouteMode
  outcome: StrategyOutcome
  advice: string[]
  terminationReason: StrategyTerminationReason
  children: Array<{ sessionId: string; stopReason: string; quiescent: boolean; diagnostics?: StrategyChildDiagnostics }>
  routing?: StrategyRoutingSummary
  unverified: true
}

const DEFAULT_ALLOWED_TOOLS: readonly string[] = Object.freeze(['read', 'glob', 'grep', 'isolation_run'])
const DEFAULT_ADVICE_MAX_MODEL_CALLS = 3
const DEFAULT_EXPERIMENT: Readonly<GoalStrategyExperimentConfig> = Object.freeze({
  enabled: true,
  allowedTools: Object.freeze([...DEFAULT_ALLOWED_TOOLS]),
  maxToolCalls: 4,
  maxModelCalls: 3,
  workspaceWriteAllowed: false,
})
const DEFAULT_SUBAGENT: Readonly<GoalStrategyExperimentConfig> = Object.freeze({
  enabled: true,
  allowedTools: Object.freeze([...DEFAULT_ALLOWED_TOOLS]),
  maxToolCalls: 8,
  maxModelCalls: 5,
  workspaceWriteAllowed: false,
})
const DEFAULT_COST_BENEFIT: Readonly<GoalStrategyCostBenefitConfig> = Object.freeze({
  minNetBenefit: 0.25,
  minRemainingParentCalls: 1,
  maxAdviceRepetitions: 2,
})
const defaults: GoalStrategyConfig = Object.freeze({
  maxDurationMs: 30_000,
  maxPromptBytes: 32_768,
  maxOutputBytes: 16_384,
  maxRunsPerGoal: 16,
  autoRoute: true,
  experiment: DEFAULT_EXPERIMENT,
  subagent: DEFAULT_SUBAGENT,
  costBenefit: DEFAULT_COST_BENEFIT,
})

const limit = (value: unknown, minimum: number, maximum: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
const finiteRange = (value: unknown, minimum: number, maximum: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
const plain = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maximum
const same = (left: unknown, right: unknown): boolean => acceptanceDigest(left) === acceptanceDigest(right)
function readPlainObject(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
    return undefined
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>
  const out = Object.create(null) as Record<string, unknown>
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowedKeys.includes(key) || !descriptor.enumerable || !('value' in descriptor)) {
      return undefined
    }
    out[key] = descriptor.value
  }
  return out
}

function readPlainStringArray(value: unknown, maxLength: number, maxBytes: number): string[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
    return undefined
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>
  const lengthDesc = descriptors.length
  if (!lengthDesc || !('value' in lengthDesc) || typeof lengthDesc.value !== 'number'
    || !Number.isSafeInteger(lengthDesc.value) || lengthDesc.value < 0 || lengthDesc.value > maxLength) {
    return undefined
  }
  const len = lengthDesc.value
  if (Object.getOwnPropertyNames(descriptors).length !== len + 1) {
    return undefined
  }
  const items: string[] = []
  for (let index = 0; index < len; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || !plain(descriptor.value, maxBytes)) {
      return undefined
    }
    items.push(descriptor.value)
  }
  return items
}

function validateModeConfig(
  rawInput: unknown,
  fallback: Readonly<GoalStrategyExperimentConfig>,
  maxToolCap: number,
  maxModelCap: number,
): Readonly<GoalStrategyExperimentConfig> {
  if (rawInput === undefined) {
    return Object.freeze({
      ...fallback,
      allowedTools: Object.freeze([...fallback.allowedTools]),
    })
  }
  const raw = readPlainObject(rawInput, ['enabled', 'allowedTools', 'maxToolCalls', 'maxModelCalls', 'workspaceWriteAllowed'])
  if (!raw) {
    throw new Error('assistant-goals: invalid strategy configuration')
  }
  const enabled = raw.enabled === undefined ? fallback.enabled : raw.enabled
  const workspaceWriteAllowed = raw.workspaceWriteAllowed === undefined ? fallback.workspaceWriteAllowed : raw.workspaceWriteAllowed
  const maxToolCalls = raw.maxToolCalls === undefined ? fallback.maxToolCalls : raw.maxToolCalls
  const maxModelCalls = raw.maxModelCalls === undefined ? fallback.maxModelCalls : raw.maxModelCalls
  const rawAllowedTools = raw.allowedTools
  const allowedTools = rawAllowedTools === undefined
    ? [...fallback.allowedTools]
    : readPlainStringArray(rawAllowedTools, 32, 128)
  if (typeof enabled !== 'boolean' || typeof workspaceWriteAllowed !== 'boolean'
    || !limit(maxToolCalls, 0, maxToolCap) || !limit(maxModelCalls, 1, maxModelCap)
    || allowedTools === undefined) {
    throw new Error('assistant-goals: invalid strategy configuration')
  }
  const deduped = Object.freeze([...new Set(allowedTools)])
  if (deduped.some(name => isForbiddenStrategyTool(name))
    || (!workspaceWriteAllowed && deduped.some(name => isWriteMutationTool(name)))) {
    throw new Error('assistant-goals: invalid strategy configuration')
  }
  return Object.freeze({
    enabled,
    allowedTools: deduped,
    maxToolCalls,
    maxModelCalls,
    workspaceWriteAllowed,
  })
}

function validateCostBenefitConfig(rawInput: unknown): Readonly<GoalStrategyCostBenefitConfig> {
  if (rawInput === undefined) return Object.freeze({ ...DEFAULT_COST_BENEFIT })
  const raw = readPlainObject(rawInput, ['minNetBenefit', 'minRemainingParentCalls', 'maxAdviceRepetitions'])
  if (!raw) {
    throw new Error('assistant-goals: invalid strategy configuration')
  }
  const minNetBenefit = raw.minNetBenefit === undefined ? DEFAULT_COST_BENEFIT.minNetBenefit : raw.minNetBenefit
  const minRemainingParentCalls = raw.minRemainingParentCalls === undefined ? DEFAULT_COST_BENEFIT.minRemainingParentCalls : raw.minRemainingParentCalls
  const maxAdviceRepetitions = raw.maxAdviceRepetitions === undefined ? DEFAULT_COST_BENEFIT.maxAdviceRepetitions : raw.maxAdviceRepetitions
  if (!finiteRange(minNetBenefit, -100, 100) || !limit(minRemainingParentCalls, 0, 32) || !limit(maxAdviceRepetitions, 1, 32)) {
    throw new Error('assistant-goals: invalid strategy configuration')
  }
  return Object.freeze({
    minNetBenefit,
    minRemainingParentCalls,
    maxAdviceRepetitions,
  })
}

/** Strict, side-effect-free configuration boundary used by service preauthorization. */
export function validateGoalStrategyConfig(input: GoalStrategyConfigInput = {}): Readonly<GoalStrategyConfig> {
  const raw = readPlainObject(input, ['maxDurationMs', 'maxPromptBytes', 'maxOutputBytes', 'maxRunsPerGoal', 'autoRoute', 'experiment', 'subagent', 'costBenefit'])
  if (!raw) {
    throw new Error('assistant-goals: invalid strategy configuration')
  }
  const rawMaxDurationMs = raw.maxDurationMs
  const rawMaxPromptBytes = raw.maxPromptBytes
  const rawMaxOutputBytes = raw.maxOutputBytes
  const rawMaxRunsPerGoal = raw.maxRunsPerGoal
  const rawAutoRoute = raw.autoRoute
  const rawExperiment = raw.experiment
  const rawSubagent = raw.subagent
  const rawCostBenefit = raw.costBenefit

  const maxDurationMs = rawMaxDurationMs === undefined ? defaults.maxDurationMs : rawMaxDurationMs
  const maxPromptBytes = rawMaxPromptBytes === undefined ? defaults.maxPromptBytes : rawMaxPromptBytes
  const maxOutputBytes = rawMaxOutputBytes === undefined ? defaults.maxOutputBytes : rawMaxOutputBytes
  const maxRunsPerGoal = rawMaxRunsPerGoal === undefined ? defaults.maxRunsPerGoal : rawMaxRunsPerGoal
  const autoRoute = rawAutoRoute === undefined ? defaults.autoRoute : rawAutoRoute
  if (!limit(maxDurationMs, 1_000, 300_000) || !limit(maxPromptBytes, 1_024, 65_536)
    || !limit(maxOutputBytes, 256, 65_536) || !limit(maxRunsPerGoal, 1, 32) || typeof autoRoute !== 'boolean') {
    throw new Error('assistant-goals: invalid strategy configuration')
  }
  const experiment = validateModeConfig(rawExperiment, DEFAULT_EXPERIMENT, 32, 16)
  const subagent = validateModeConfig(rawSubagent, DEFAULT_SUBAGENT, 64, 32)
  const costBenefit = validateCostBenefitConfig(rawCostBenefit)
  return Object.freeze({
    maxDurationMs,
    maxPromptBytes,
    maxOutputBytes,
    maxRunsPerGoal,
    autoRoute,
    experiment,
    subagent,
    costBenefit,
  })
}

const VALID_INPUT_KINDS = new Set<StrategyRequestedKind>(['auto', 'investigate', 'review', 'compare', 'experiment', 'subagent'])

/** Detach only finite plain strings; no caller-owned objects reach a strategy child. */
export function validateGoalStrategyInput(input: unknown): Readonly<GoalStrategyInput> {
  const raw = readPlainObject(input, ['kind', 'question', 'context', 'tools', 'failure_hint', 'difficulty_hint'])
  if (!raw) throw new Error('assistant-goals: invalid strategy input')

  const kind = raw.kind
  const question = raw.question
  const context = raw.context
  const rawTools = raw.tools
  const failureHint = raw.failure_hint
  const difficultyHint = raw.difficulty_hint

  if (!VALID_INPUT_KINDS.has(kind as StrategyRequestedKind)
    || !plain(question, 65_536) || (context !== undefined && !plain(context, 65_536))) {
    throw new Error('assistant-goals: invalid strategy input')
  }
  let tools: readonly string[] | undefined
  if (rawTools !== undefined) {
    const parsedTools = readPlainStringArray(rawTools, 16, 128)
    if (!parsedTools || parsedTools.some(item => isForbiddenStrategyTool(item))) {
      throw new Error('assistant-goals: invalid strategy input')
    }
    tools = Object.freeze([...new Set(parsedTools)])
  }
  if (failureHint !== undefined && failureHint !== 'tool-failure' && failureHint !== 'reasoning-failure') {
    throw new Error('assistant-goals: invalid strategy input')
  }
  if (difficultyHint !== undefined && difficultyHint !== 'trivial' && difficultyHint !== 'moderate' && difficultyHint !== 'complex') {
    throw new Error('assistant-goals: invalid strategy input')
  }
  return Object.freeze({
    kind: kind as StrategyRequestedKind,
    question,
    ...(context === undefined ? {} : { context }),
    ...(tools === undefined ? {} : { tools }),
    ...(failureHint === undefined ? {} : { failure_hint: failureHint }),
    ...(difficultyHint === undefined ? {} : { difficulty_hint: difficultyHint }),
  })
}

type Current = { record: GoalRecord; run: GoalExecutionRun; signal: AbortSignal }
type Permit = {
  id: string; label: string; parent: Agent; parentRunId: string; record: GoalRecord
  expiresAt: number; signal: AbortSignal; provider: string; model: string; maxTokens: number | undefined
  prompt: readonly ContentBlock[]; maxDepth: number; rejected: boolean; starting: boolean
  toolRejections: number; child?: Agent
  resolvedKind: Exclude<StrategyRouteMode, 'direct'>
  allowedTools?: ReadonlySet<string> | undefined
  maxToolCalls: number
  maxModelCalls: number
  workspaceWriteAllowed: boolean
  toolCalls: number
  modelCalls: number
  executedTools: string[]
}
type ChildState = { sessionId: string; stopReason: string; quiescent: boolean; output: 'not-observed' | 'accepted' | 'empty-or-oversized'; run?: SubagentActivation; permit: Permit }

export interface StrategyRecommendationContext {
  readonly feedback?: GoalFeedback | undefined
  readonly goalAcceptance?: GoalOutcomeView | undefined
  readonly recentToolOutcomes?: readonly RecentToolOutcome[] | undefined
  readonly availableTools?: readonly string[] | undefined
}

function bounded<T>(operation: Promise<T>, signal: AbortSignal, deadline: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
    const finish = (callback: () => void) => { if (done) return; done = true; cleanup(); callback() }
    const abort = () => finish(() => reject(new Error('assistant-goals: strategy operation expired or cancelled')))
    const timer = setTimeout(abort, Math.max(0, deadline - Date.now()))
    timer.unref?.()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    operation.then(value => finish(() => resolve(value)), error => finish(() => reject(error)))
  })
}

function outputText(output: readonly ContentBlock[], maximum: number): string | undefined {
  let text = ''
  for (const block of output) if (block.type === 'text') text += block.text
  return text.length > 0 && Buffer.byteLength(text, 'utf8') <= maximum ? text : undefined
}

function promptBlock(text: string): readonly ContentBlock[] { return Object.freeze([Object.freeze({ type: 'text' as const, text })]) }

/**
 * Host-only strategy runner. Each native child gets one admitted activation.
 * Strategy output is deliberately unverified advice/experiment telemetry: it
 * never feeds a verifier or changes a goal's native lifecycle.
 */
export class GoalStrategyRuntime {
  readonly #store: GoalStrategyStore
  readonly #permits = new Map<string, Permit>()
  readonly #operations = new Set<Promise<void>>()
  readonly #controllers = new Set<AbortController>()
  readonly #runs = new Set<SubagentActivation>()
  readonly #disposals = new WeakMap<SubagentActivation, Promise<void>>()
  readonly #guarded = new WeakSet<Agent>()
  readonly #observedToolGuards = new WeakSet<object>()
  #active = true
  #toolsCtx: Context | undefined
  #closed = false
  #removeResolver: (() => void) | undefined

  constructor(
    private readonly ctx: Context,
    path: string,
    readonly config: Readonly<GoalStrategyConfig>,
    private readonly callbacks: {
      current(parent: Agent): Current
      budget: GoalBudgetRuntime
      recommendationContext?(parent: Agent | undefined, record: GoalRecord): StrategyRecommendationContext
    },
  ) {
    this.#store = new GoalStrategyStore(path)
    this.#store.recoverIncomplete(Date.now())
    const provider: SubagentProvider = {
      name: STRATEGY_PROVIDER,
      capabilities: Object.freeze({ agentOptions: true, agentPreset: false, outputSchema: false, depthLimit: true }),
      inheritsParentContext: false,
      start: request => this.#start(request),
    }
    ctx.inject(['subagents', 'tools', 'systemPrompt'], runtime => {
      this.#toolsCtx = runtime
      const removeProvider = runtime.subagents.registerProvider(provider)
      this.#removeResolver = this.callbacks.budget.registerDelegateResolver(agent => this.#delegate(agent))
      // The native AgentLoop assembles the first prompt before pre-step appends
      // the descriptor. The private persona marker only strips presentation.
      runtime.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
        const assembly = await next()
        const marker = assembly.sections.find(section => section.name === 'deployment:persona-prefix')?.text
        if (typeof marker !== 'string' || !marker.startsWith(`${STRATEGY_PROVIDER}:`)) return assembly
        const permit = this.#permits.get(marker.slice(STRATEGY_PROVIDER.length + 1))
        if (!agent || !permit || agent.session.header.origin !== 'subagent'
          || String(agent.session.header.parentSession) !== String(permit.parent.session.id)) throw new Error('assistant-goals: strategy prompt is not admitted')
        this.#assertPermit(permit)
        // Zero-tool advice modes strip all tools sections and keep exact persona text.
        if (permit.allowedTools === undefined) {
          return { ...assembly, sections: assembly.sections.filter(section => !section.name.startsWith('tools:')).map(section =>
            section.name === 'deployment:persona-prefix' ? { ...section, text: 'Analyze the supplied material only. Return unverified advice; do not invoke tools or take actions.' } : section) }
        }
        const directive = permit.resolvedKind === 'subagent'
          ? 'Execute a bounded subproblem delegation using only the permitted tools within the assigned call and time budget. Do not claim verification or widen scope.'
          : 'Run a bounded diagnostic experiment using only the permitted tools within the assigned call and time budget. Do not claim verification or widen scope.'
        return { ...assembly, sections: assembly.sections
          .filter(section => permit.allowedTools!.size > 0 || !section.name.startsWith('tools:'))
          .map(section => section.name === 'deployment:persona-prefix' ? { ...section, text: directive } : section) }
      })
      // The descriptor exists before the first request. This also keeps scoped
      // tools out of the assembled prompt, while the guard denies any late call.
      runtime.on('agent/request', async ({ agent }, next) => {
        if (!this.#recognized(agent)) return await next()
        if (!this.#strategyDescriptor(agent)) throw new Error('assistant-goals: unsupported strategy descriptor')
        this.#delegate(agent)
        this.#installChildGuards(agent)
        const permit = this.#permitFor(agent)
        if (permit.modelCalls >= permit.maxModelCalls) {
          permit.rejected = true
          throw new Error('assistant-goals: strategy child model call limit exceeded')
        }
        permit.modelCalls += 1
        const request = await next()
        return request
      })
      runtime.tools.guard(execution => this.#toolGuard(execution))
      ctx.effect(() => () => removeProvider(), 'assistant-goals.strategy-provider')
    })
    ctx.effect(() => async () => {
      this.#active = false
      this.#removeResolver?.(); this.#removeResolver = undefined
      for (const controller of this.#controllers) controller.abort()
      for (const run of this.#runs) void this.#dispose(run)
      for (const permit of this.#permits.values()) permit.rejected = true
      try { await bounded(Promise.allSettled(this.#operations), new AbortController().signal, Date.now() + 1_000) } catch {}
      this.#store.recoverIncomplete(Date.now())
      this.#closed = true
      this.#permits.clear()
      this.#store.close()
    }, 'assistant-goals.strategy')
  }

  list = (scope: GoalScope, goalId: string): readonly StrategyRecord[] => { this.#open(); return this.#store.list(scope, goalId) }

  /** Read-only cross-instance advice repetition view for the learning host. */
  summarizeAdviceByDefinition = (scope: GoalScope): readonly StrategyAdviceDefinitionSummary[] => {
    this.#open()
    return this.#store.summarizeAdviceByDefinition(scope)
  }

  /** Read-only strategy telemetry summary for cost/benefit optimization. */
  summarizeOutcomeTelemetry = (scope: GoalScope, definitionDigest?: string): StrategyOutcomeTelemetry => {
    this.#open()
    return this.#store.summarizeStrategyOutcomes(scope, definitionDigest === undefined ? {} : { definitionDigest })
  }

  /** Compute deterministic difficulty, failure-type, and cost/benefit routing recommendation. */
  recommend(
    parent: Agent | undefined,
    record: GoalRecord,
    overrides: {
      question?: string | undefined
      context?: string | undefined
      failureHint?: 'tool-failure' | 'reasoning-failure' | undefined
      difficultyHint?: StrategyTaskDifficulty | undefined
      requestDigest?: string | undefined
    } = {},
  ): StrategyRoutingDecision {
    this.#open()
    const now = Date.now()
    const recentStrategies = this.#store.list(record.scope, record.id, 32)
    const adviceSummary = this.#store.summarizeAdviceByDefinition(record.scope)
      .find(item => item.definitionDigest === record.definition.digest)
    const telemetry = this.#store.summarizeStrategyOutcomes(record.scope, { definitionDigest: record.definition.digest })
    const budget = this.callbacks.budget.inspect(record)
    const ctxData = this.callbacks.recommendationContext?.(parent, record)
    const recentToolOutcomes = ctxData?.recentToolOutcomes
      ?? (parent === undefined ? undefined : extractRecentSessionToolOutcomes(parent.session.snapshotEvents(), { nativeGoalId: record.native.goalId }))
    const availableTools = ctxData?.availableTools
      ?? (parent === undefined ? undefined : parent.ctx.get('tools')?.definitions(parent).map(item => item.name))

    return recommendGoalStrategy({
      record,
      feedback: ctxData?.feedback,
      goalAcceptance: ctxData?.goalAcceptance,
      recentStrategies,
      recentToolOutcomes,
      failureHint: overrides.failureHint,
      difficultyHint: overrides.difficultyHint,
      question: overrides.question,
      context: overrides.context,
      budget,
      adviceSummary,
      telemetry,
      requestDigest: overrides.requestDigest,
      experiment: this.config.experiment,
      subagent: this.config.subagent,
      availableTools,
      costBenefit: this.config.costBenefit,
      maxStrategyDurationMs: this.config.maxDurationMs,
      now,
    })
  }

  async run(parent: Agent, raw: GoalStrategyInput, signal: AbortSignal): Promise<GoalStrategyResult> {
    const input = validateGoalStrategyInput(raw)
    this.#open()
    if (!this.#active || this.ctx.get('agents')?.get(parent.id) !== parent) throw new Error('assistant-goals: strategy parent is unavailable')
    const current = this.callbacks.current(parent)
    signal.throwIfAborted()
    if (input.kind === 'auto' && !this.config.autoRoute) {
      throw new Error('assistant-goals: automatic strategy routing is disabled')
    }
    const route = parent.options
    if (!plain(route.provider, 256) || !plain(route.model, 256)) throw new Error('assistant-goals: strategy route is unavailable')
    // Capture narrowed route fields before the concurrent child closures; TS
    // does not carry property narrowing into nested async functions.
    const provider = route.provider
    const model = route.model
    const maxTokens = route.maxTokens
    const requestDigest = acceptanceDigest(input)
    const budget = this.callbacks.budget.inspect(current.record)
    const now = Date.now()
    const expiresAt = Math.min(current.run.intent.admission.expiresAt, budget.limits.expiresAt, now + this.config.maxDurationMs)
    if (expiresAt <= now || this.#store.list(current.record.scope, current.record.id, 32).length >= this.config.maxRunsPerGoal) throw new Error('assistant-goals: strategy admission unavailable')

    const decision = this.recommend(parent, current.record, {
      question: input.question,
      context: input.context,
      failureHint: input.failure_hint,
      difficultyHint: input.difficulty_hint,
      requestDigest,
    })
    const resolvedKind: StrategyRouteMode = input.kind === 'auto' ? decision.selectedStrategy : input.kind
    const routingSummary: StrategyRoutingSummary = {
      difficulty: decision.difficulty,
      failureType: decision.failureType,
      selectedStrategy: resolvedKind,
      expectedNetBenefit: decision.expectedNetBenefit,
      estimatedCostCalls: decision.estimatedCostCalls,
      rationale: decision.rationale.slice(0, 512),
    }

    if (resolvedKind === 'direct') {
      const id = `strategy-${randomUUID()}`
      const prepared = this.#store.prepare({
        id,
        goalId: current.record.id,
        parentRunId: current.run.intent.runId,
        parentSessionId: String(parent.session.id),
        definitionVersion: current.record.definition.version,
        definitionDigest: current.record.definition.digest,
        scope: current.record.scope,
        kind: 'direct',
        requestedKind: input.kind,
        routing: routingSummary,
        requestDigest,
        provider,
        model,
        maxChildren: 0,
        maxDurationMs: expiresAt - now,
        createdAt: now,
        expiresAt,
      })
      const dispatched = this.#store.dispatch(id, prepared.record.version, now)
      const settled = this.#store.settle(id, dispatched.version, {
        children: [],
        outcome: 'direct-recommended',
        quiescent: true,
        terminationReason: 'skipped-direct',
      }, now)
      return Object.freeze({
        strategyId: id,
        requestedKind: input.kind,
        resolvedKind: 'direct',
        outcome: settled.outcome ?? 'direct-recommended',
        terminationReason: settled.terminationReason ?? 'skipped-direct',
        advice: [],
        children: [],
        routing: routingSummary,
        unverified: true as const,
      })
    }

    const isToolMode = resolvedKind === 'experiment' || resolvedKind === 'subagent'
    const modeConfig = resolvedKind === 'subagent' ? this.config.subagent : this.config.experiment
    if (isToolMode && !modeConfig.enabled) {
      throw new Error(`assistant-goals: strategy mode ${resolvedKind} is disabled`)
    }
    let effectiveAllowedTools: readonly string[] | undefined
    if (isToolMode) {
      if (modeConfig.maxToolCalls <= 0) {
        if (input.tools !== undefined && input.tools.length > 0) {
          throw new Error('assistant-goals: strategy input tools are not permitted by configuration')
        }
        effectiveAllowedTools = Object.freeze([])
      } else {
        const configuredAllowed = filterPermittedStrategyTools(modeConfig, undefined, input.tools)
        if (input.tools !== undefined && configuredAllowed.length === 0) {
          throw new Error('assistant-goals: strategy input tools are not permitted by configuration')
        }
        const parentVisible = parent.ctx.get('tools')?.definitions(parent).map(item => item.name)
        effectiveAllowedTools = filterPermittedStrategyTools(modeConfig, parentVisible, input.tools)
      }
    }

    const prompt = this.#prompt(input, resolvedKind, effectiveAllowedTools)
    const personas = resolvedKind === 'compare'
      ? ['Give an independent skeptical analysis.', 'Give an independent alternative analysis.']
      : resolvedKind === 'experiment'
        ? ['Run a bounded diagnostic experiment.']
        : resolvedKind === 'subagent'
          ? ['Execute the bounded subproblem delegation.']
          : ['Give a concise evidence-aware analysis.']
    const prompts = personas.map(persona => `${persona}\n\n${prompt}`)
    if (prompts.some(value => Buffer.byteLength(value, 'utf8') > this.config.maxPromptBytes)) throw new Error('assistant-goals: strategy prompt exceeds limit')

    const id = `strategy-${randomUUID()}`
    const prepared = this.#store.prepare({
      id,
      goalId: current.record.id,
      parentRunId: current.run.intent.runId,
      parentSessionId: String(parent.session.id),
      definitionVersion: current.record.definition.version,
      definitionDigest: current.record.definition.digest,
      scope: current.record.scope,
      kind: resolvedKind,
      ...(input.kind === resolvedKind ? {} : { requestedKind: input.kind }),
      ...(input.kind === 'auto' ? { routing: routingSummary } : {}),
      ...(isToolMode ? {
        experiment: {
          allowedTools: effectiveAllowedTools ?? [],
          maxToolCalls: effectiveAllowedTools && effectiveAllowedTools.length > 0 ? modeConfig.maxToolCalls : 0,
          maxModelCalls: modeConfig.maxModelCalls,
          workspaceWriteAllowed: modeConfig.workspaceWriteAllowed,
        },
      } : {}),
      requestDigest,
      provider,
      model,
      maxChildren: resolvedKind === 'compare' ? 2 : 1,
      maxDurationMs: expiresAt - now,
      createdAt: now,
      expiresAt,
    })
    this.#store.dispatch(id, prepared.record.version, now)
    const controller = new AbortController()
    this.#controllers.add(controller)
    let release: (() => void) | undefined
    const lifetime = new Promise<void>(resolve => { release = resolve })
    this.#operations.add(lifetime)
    const combined = AbortSignal.any([signal, current.signal, controller.signal])
    const timer = setTimeout(() => controller.abort(), Math.max(0, expiresAt - Date.now()))
    timer.unref?.()
    // A provider may be waiting for its first stream chunk, so budget stream
    // assertions alone cannot observe a revoked owner or policy decision.
    const watchdog = setInterval(() => { try { this.#assertCurrent(parent, current) } catch { parentAuthorityChanged = true; controller.abort() } }, 50)
    watchdog.unref?.()
    const advice: string[] = []
    const childPrompts = prompts
    // Persona order is deterministic (skeptical first, alternative second for
    // compare); the slot array preserves it independently of completion order.
    const childSlots: Array<ChildState | undefined> = childPrompts.map(() => undefined)
    let unknown = false
    let parentAuthorityChanged = false
    try {
      if (combined.aborted || Date.now() >= expiresAt) unknown = true
      else {
        // Independent personas share the same goal budget, deadline, owner
        // watchdog and abort signal; running them concurrently only removes the
        // artificial serialization. Each permit/label/run stays isolated and
        // results are reassembled in persona order below.
        const tasks = childPrompts.map(async (childPrompt, index): Promise<string | undefined> => {
          const permit: Permit = {
            id,
            label: `strategy-${randomUUID()}`,
            parent,
            parentRunId: current.run.intent.runId,
            record: current.record,
            expiresAt,
            signal: combined,
            provider,
            model,
            maxTokens,
            prompt: promptBlock(childPrompt),
            maxDepth: delegationDepthOf(parent) + 1,
            starting: false,
            rejected: false,
            toolRejections: 0,
            resolvedKind,
            allowedTools: isToolMode ? new Set(effectiveAllowedTools ?? []) : undefined,
            maxToolCalls: isToolMode && effectiveAllowedTools && effectiveAllowedTools.length > 0 ? modeConfig.maxToolCalls : 0,
            maxModelCalls: isToolMode ? modeConfig.maxModelCalls : DEFAULT_ADVICE_MAX_MODEL_CALLS,
            workspaceWriteAllowed: isToolMode ? modeConfig.workspaceWriteAllowed : false,
            toolCalls: 0,
            modelCalls: 0,
            executedTools: [],
          }
          this.#permits.set(permit.label, permit)
          const child: ChildState = { sessionId: 'pending', stopReason: 'pending', quiescent: false, output: 'not-observed', permit }
          childSlots[index] = child
          let text: string | undefined
          try {
            // 0.2.2: SubagentActivationSpec carries the request fields directly
            // instead of a nested `request` object.
            const started = this.ctx.subagents.startActivation({
              provider: STRATEGY_PROVIDER, label: permit.label, signal: combined, delivery: 'caller',
              prompt: [...permit.prompt], parent,
              agentOptions: { provider, model, ...(maxTokens === undefined ? {} : { maxTokens }) }, maxDepth: permit.maxDepth,
            })
            const run = await this.#boundedStart(started, permit, combined, expiresAt)
            child.run = run; child.sessionId = String(run.childId)
            const result = await bounded(run.result, combined, expiresAt)
            this.#assertPermit(permit)
            child.stopReason = result.stopReason
            if (result.stopReason === 'completed') {
              text = outputText(result.output, this.config.maxOutputBytes)
              child.output = text !== undefined ? 'accepted' : 'empty-or-oversized'
            }
          } catch {
            if (combined.aborted || Date.now() >= expiresAt) unknown = true
            else child.stopReason = 'error'
          } finally {
            const run = child.run
            if (run !== undefined) {
              child.quiescent = await this.#dispose(run)
              if (!child.quiescent) unknown = true
            }
            permit.rejected = true
            this.#permits.delete(permit.label)
          }
          return text
        })
        // Promise.all preserves slot order, so advice never depends on which
        // persona finished first; the durable output digest stays deterministic.
        const texts = await Promise.all(tasks)
        for (const text of texts) if (text !== undefined) advice.push(text)
      }
    } finally {
      clearTimeout(timer)
      clearInterval(watchdog)
      controller.abort()
      this.#controllers.delete(controller)
      for (const child of childSlots) {
        if (child === undefined) continue
        child.permit.rejected = true
        this.#permits.delete(child.permit.label)
        if (child.run !== undefined && !child.quiescent) {
          child.quiescent = await this.#dispose(child.run)
          if (!child.quiescent) unknown = true
        }
      }
    }
    const children = childSlots.filter((child): child is ChildState => child !== undefined)
    try {
      // Disposal is the authorization boundary: a changed owner after a result
      // makes the durable outcome unknown rather than reusable advice.
      const cancelled = signal.aborted || current.signal.aborted
      try { this.#assertCurrent(parent, current) } catch { unknown = true; if (!cancelled && this.#active) parentAuthorityChanged = true }
      if (Date.now() >= expiresAt) unknown = true
      if (this.#closed) return Object.freeze({ strategyId: id, outcome: 'unknown' as const, terminationReason: 'unknown' as const, advice: [], children: [], unverified: true as const })
      const snapshot = this.#store.inspect(current.record.scope, id)!
      const finalChildren = children.filter(child => child.permit.child !== undefined).map(child => {
        const failure = this.callbacks.budget.lastFailure(child.permit.child!)
        return {
          sessionId: String(child.permit.child!.id),
          stopReason: child.stopReason,
          quiescent: child.quiescent,
          diagnostics: {
            toolRejections: child.permit.toolRejections,
            output: child.output,
            ...(failure === undefined ? {} : { failure }),
            ...(isToolMode ? {
              toolCalls: child.permit.toolCalls,
              modelCalls: child.permit.modelCalls,
              ...(child.permit.executedTools.length > 0 ? { executedTools: [...child.permit.executedTools] } : {}),
            } : {}),
          },
        }
      })
      const successOutcome: StrategyOutcome = isToolMode ? 'experiment' : 'advice'
      const outcome: GoalStrategyResult['outcome'] = unknown ? 'unknown' : cancelled ? 'cancelled'
        : advice.length === childPrompts.length && finalChildren.length === childPrompts.length ? successOutcome : 'execution-failed'
      const terminationReason: StrategyTerminationReason = Date.now() >= expiresAt ? 'deadline'
        : parentAuthorityChanged ? 'parent-authority-changed' : cancelled ? 'cancelled'
          : finalChildren.some(child => !child.quiescent) ? 'unconfirmed-stop'
            : unknown ? 'unknown' : outcome === successOutcome ? 'completed' : 'execution-failed'
      const settled = this.#store.settle(id, snapshot.version, { children: finalChildren, outcome, quiescent: finalChildren.every(child => child.quiescent), terminationReason, ...(advice.length ? { outputDigest: acceptanceDigest(advice) } : {}) }, Date.now())
      return Object.freeze({
        strategyId: id,
        ...(input.kind === resolvedKind ? {} : { requestedKind: input.kind }),
        resolvedKind,
        outcome: settled.outcome ?? 'unknown',
        terminationReason: settled.terminationReason ?? 'unknown',
        advice: outcome === successOutcome ? [...advice] : [],
        children: settled.children.map(child => ({ ...child })),
        ...(input.kind === 'auto' ? { routing: routingSummary } : {}),
        unverified: true as const,
      })
    } finally {
      release?.(); this.#operations.delete(lifetime)
    }
  }

  #prompt(input: GoalStrategyInput, resolvedKind: Exclude<StrategyRouteMode, 'direct'>, allowedTools?: readonly string[]): string {
    const closing = resolvedKind === 'experiment' || resolvedKind === 'subagent'
      ? `Permitted tools: ${allowedTools && allowedTools.length > 0 ? allowedTools.join(', ') : '(none)'}. Report bounded, unverified findings only.`
      : 'Return analysis only. Do not claim verification or take actions.'
    return [`Task kind: ${resolvedKind}`, `Question: ${input.question}`, ...(input.context === undefined ? [] : [`Context (untrusted): ${input.context}`]), closing].join('\n\n')
  }

  #strategyDescriptor(agent: Agent | undefined) {
    if (agent === undefined) return undefined
    try {
      const descriptor = foldSubagentDescriptor(agent.session.snapshotEvents())
      return descriptor?.version === 3 && descriptor.mode === 'one-shot' && descriptor.provider === STRATEGY_PROVIDER ? descriptor : undefined
    } catch { throw new Error('assistant-goals: invalid strategy descriptor') }
  }

  #recognized(agent: Agent | undefined): boolean {
    if (agent === undefined) return false
    const first = agent.session.snapshotEvents().find(event => String(event.type) === 'subagent/descriptor')
    return !!first && !!first.data && typeof first.data === 'object' && (first.data as { provider?: unknown }).provider === STRATEGY_PROVIDER
  }

  #guardTool(permit: Permit, execution: { name?: string }): string | undefined {
    const reject = (reason: string) => {
      if (!this.#observedToolGuards.has(execution)) {
        this.#observedToolGuards.add(execution)
        permit.toolRejections = Math.min(1_000_000, permit.toolRejections + 1)
      }
      return reason
    }
    if (permit.allowedTools === undefined || permit.allowedTools.size === 0) {
      return reject('assistant-goals: strategy children cannot use tools')
    }
    const name = execution.name ?? ''
    if (!permit.allowedTools.has(name) || isForbiddenStrategyTool(name)) {
      return reject('assistant-goals: strategy child tool is not permitted')
    }
    if (!permit.workspaceWriteAllowed && isWriteMutationTool(name)) {
      return reject('assistant-goals: strategy child cannot modify workspace')
    }
    if (permit.toolCalls >= permit.maxToolCalls) {
      return reject('assistant-goals: strategy child tool call limit exceeded')
    }
    return undefined
  }

  #toolGuard(execution: { agent?: Agent; name?: string }): string | undefined {
    const agent = execution.agent
    if (!this.#recognized(agent)) return undefined
    try {
      const permit = this.#permitFor(agent!)
      return this.#guardTool(permit, execution)
    } catch {
      return 'assistant-goals: strategy children cannot use tools'
    }
  }

  #track(operation: Promise<unknown>): void {
    const done = operation.then(() => undefined, () => undefined)
    this.#operations.add(done)
    void done.finally(() => this.#operations.delete(done))
  }

  #open(): void { if (this.#closed) throw new Error('assistant-goals: strategy runtime is closed') }

  async #dispose(run: SubagentActivation): Promise<boolean> {
    let disposal = this.#disposals.get(run)
    if (disposal === undefined) {
      disposal = run.dispose()
      this.#disposals.set(run, disposal)
      this.#track(disposal.finally(() => this.#runs.delete(run)))
    }
    try { await bounded(disposal, new AbortController().signal, Date.now() + 1_000); return true } catch { return false }
  }

  async #boundedStart(started: Promise<SubagentActivation>, permit: Permit, signal: AbortSignal, deadline: number): Promise<SubagentActivation> {
    let timely = true
    started.then(run => {
      this.#runs.add(run)
      if (!timely || permit.rejected || !this.#active) void this.#dispose(run)
    }, () => {})
    this.#track(started)
    try { return await bounded(started, signal, deadline) } finally { timely = false }
  }

  #assertCurrent(parent: Agent, expected: Current): Current {
    if (!this.#active || this.ctx.get('agents')?.get(parent.id) !== parent) throw new Error('assistant-goals: strategy parent authorization changed')
    const current = this.callbacks.current(parent)
    if (current.signal.aborted || current.run.intent.runId !== expected.run.intent.runId || current.record.id !== expected.record.id
      || current.record.definition.version !== expected.record.definition.version || current.record.definition.digest !== expected.record.definition.digest
      || !same(current.record.scope, expected.record.scope)) throw new Error('assistant-goals: strategy parent authorization changed')
    return current
  }

  #installChildGuards(agent: Agent): void {
    if (this.#guarded.has(agent)) return
    this.#guarded.add(agent)
    // These registrations belong to the child's scope, so unloading Goals
    // cannot make an already-published strategy child tool-capable again.
    const permit = this.#permitFor(agent)
    agent.ctx.tools.guard(execution => this.#guardTool(permit, execution))
    agent.ctx.on('tools/execute', async (execution, next) => {
      this.#assertChildPermit(agent, permit)
      if (permit.allowedTools === undefined || !permit.allowedTools.has(execution.name)
        || isForbiddenStrategyTool(execution.name)
        || (!permit.workspaceWriteAllowed && isWriteMutationTool(execution.name))
        || permit.toolCalls >= permit.maxToolCalls) {
        throw new Error('assistant-goals: strategy child tool execution rejected')
      }
      permit.toolCalls += 1
      if (permit.executedTools.length < 64) permit.executedTools.push(execution.name)
      return await next()
    })
    agent.ctx.on('agent/request', async (_payload, next) => {
      this.#assertChildPermit(agent, permit)
      if (permit.modelCalls > permit.maxModelCalls) throw new Error('assistant-goals: strategy child model call limit exceeded')
      const request = await next()
      this.#assertChildPermit(agent, permit)
      return request
    })
  }

  #start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const permit = request.label === undefined ? undefined : this.#permits.get(request.label)
    if (!this.#active || this.#closed || permit === undefined || permit.rejected || permit.starting || request.parent !== permit.parent
      || request.signal.aborted || permit.signal.aborted || request.agentPreset !== undefined || request.outputSchema !== undefined
      || request.maxDepth !== permit.maxDepth || !same(request.prompt, permit.prompt)
      || !same(request.agentOptions, { provider: permit.provider, model: permit.model,
        ...(permit.maxTokens === undefined ? {} : { maxTokens: permit.maxTokens }) })) {
      return Promise.reject(new Error('assistant-goals: strategy provider request is not admitted'))
    }
    try { this.#assertPermit(permit) } catch { return Promise.reject(new Error('assistant-goals: strategy provider authorization changed')) }
    permit.starting = true
    const toolPolicy = permit.allowedTools === undefined ? undefined : { allow: [...permit.allowedTools], maxToolCalls: permit.maxToolCalls }
    // Rebuild model-affecting fields from the private permit, not caller input.
    const started = startStrategyOneShot({ ...request, parent: permit.parent, signal: AbortSignal.any([request.signal, permit.signal]), label: permit.label,
      prompt: [...permit.prompt], agentOptions: { provider: permit.provider, model: permit.model,
        ...(permit.maxTokens === undefined ? {} : { maxTokens: permit.maxTokens }) }, maxDepth: permit.maxDepth }, child => {
      if (permit.child !== undefined) throw new Error('assistant-goals: strategy child already created')
      permit.child = child
    }, this.#toolsCtx, toolPolicy)
    started.catch(() => { permit.rejected = true })
    return started
  }

  #assertPermit(permit: Permit): Current {
    if (!this.#active || this.#closed || permit.rejected || permit.signal.aborted || Date.now() >= permit.expiresAt
      || this.ctx.get('agents')?.get(permit.parent.id) !== permit.parent
      || !this.callbacks.budget.hasMeter({ provider: permit.provider, model: permit.model })) throw new Error('assistant-goals: strategy parent authorization changed')
    const current = this.callbacks.current(permit.parent)
    if (current.signal.aborted || current.run.intent.runId !== permit.parentRunId || current.record.id !== permit.record.id
      || current.record.definition.version !== permit.record.definition.version || current.record.definition.digest !== permit.record.definition.digest
      || !same(current.record.scope, permit.record.scope)) throw new Error('assistant-goals: strategy parent authorization changed')
    return current
  }

  #permitFor(agent: Agent): Permit {
    const descriptor = this.#strategyDescriptor(agent)
    const permit = descriptor?.label === undefined ? undefined : this.#permits.get(descriptor.label)
    if (!descriptor || !permit || permit.child !== agent) throw new Error('assistant-goals: strategy child is not admitted')
    return permit
  }

  #assertChildPermit(agent: Agent, permit: Permit): void {
    if (permit.child !== agent || this.ctx.get('agents')?.get(agent.id) !== agent) throw new Error('assistant-goals: strategy child authorization changed')
    this.#assertPermit(permit)
  }

  /** Synchronous budget resolver: reject recognized-but-invalid children loudly. */
  #delegate(agent: Agent): ({ parent: Agent; runId: string; signal: AbortSignal; provider: string; model: string; accountingRunId: string; allowedTools?: ReadonlySet<string>; maxToolCalls?: number } | undefined) {
    const descriptor = this.#strategyDescriptor(agent)
    if (descriptor === undefined) {
      if (this.#recognized(agent)) throw new Error('assistant-goals: unsupported strategy descriptor')
      return undefined
    }
    const permit = descriptor.label === undefined ? undefined : this.#permits.get(descriptor.label)
    if (!this.#active || this.#closed || permit === undefined || permit.rejected || (permit.child !== undefined && permit.child !== agent) || Date.now() >= permit.expiresAt
      || permit.signal.aborted || this.ctx.get('agents')?.get(agent.id) !== agent
      || permit.child !== agent || descriptor.label !== permit.label || agent.options.provider !== permit.provider || agent.options.model !== permit.model
      || agent.session.header.origin !== 'subagent'
      || String(agent.session.header.parentSession) !== String(permit.parent.session.id)
      || this.ctx.get('agents')?.get(permit.parent.id) !== permit.parent) throw new Error('assistant-goals: strategy child is not admitted')
    let current: Current
    try { current = this.#assertPermit(permit) } catch { throw new Error('assistant-goals: strategy parent authorization changed') }
    const record = this.#store.inspect(permit.record.scope, permit.id)
    if (record === undefined || record.state !== 'starting' || record.intent.expiresAt !== permit.expiresAt || record.intent.parentRunId !== permit.parentRunId
      || record.intent.parentSessionId !== String(permit.parent.session.id) || record.intent.provider !== permit.provider || record.intent.model !== permit.model
      || record.intent.definitionVersion !== permit.record.definition.version || record.intent.definitionDigest !== permit.record.definition.digest) throw new Error('assistant-goals: strategy record is unavailable')
    if (!record.children.some(child => child.sessionId === String(agent.id))) {
      try { this.#store.bindChild(permit.id, record.version, String(agent.id), Date.now()) } catch { throw new Error('assistant-goals: strategy child binding failed') }
      this.#installChildGuards(agent)
    }
    return {
      parent: permit.parent,
      runId: permit.parentRunId,
      signal: AbortSignal.any([permit.signal, current.signal]),
      provider: permit.provider,
      model: permit.model,
      accountingRunId: `strategy-${String(agent.id)}`,
      ...(permit.allowedTools === undefined ? {} : { allowedTools: permit.allowedTools, maxToolCalls: permit.maxToolCalls }),
    }
  }
}
