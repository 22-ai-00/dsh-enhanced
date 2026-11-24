import type { GoalBudgetSnapshot } from './budget-store.js'
import type { GoalFeedback } from './feedback.js'
import type { GoalOutcomeView } from './outcome.js'
import type {
  StrategyAdviceDefinitionSummary,
  StrategyFailureType,
  StrategyOutcomeTelemetry,
  StrategyRecord,
  StrategyRouteMode,
  StrategyTaskDifficulty,
} from './strategy-store.js'
import type { GoalRecord } from './types.js'

export const FORBIDDEN_STRATEGY_TOOLS: ReadonlySet<string> = new Set([
  'run_code',
  'goal_strategy',
  'goal_create',
  'goal_control',
  'goal_schedule',
  'goal_wait_event',
  'goal_checkpoint',
  'goal_acceptance_catalog',
  'goal_context',
  'create_goal',
  'update_goal',
  'get_goal',
  'edit_goal',
  'pause_goal',
  'resume_goal',
  'clear_goal',
  'complete_goal',
  'block_goal',
])

export const WRITE_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  'write',
  'write_file',
  'edit',
  'edit_file',
  'apply_patch',
  'patch',
  'delete_file',
  'create_file',
  'remove_file',
  'bash',
  'shell',
  'exec',
  'rm',
  'delete',
  'mkdir',
  'mv',
  'cp',
  'action_shell_exec',
  'action_github_commit',
  'action_github_branch',
  'action_github_pr',
  'action_github_create_pr',
  'action_github_compensate',
  'action_github_deliver',
  'action_http_request',
  'action_lark_action',
  'action_calendar_action',
])

const READ_ONLY_ACTION_TOOLS: ReadonlySet<string> = new Set([
  'action_github_inspect',
  'action_github_grants',
  'action_broker_grants',
  'action_github_compensation_status',
  'action_github_delivery_status',
])

export function isForbiddenStrategyTool(name: string): boolean {
  return FORBIDDEN_STRATEGY_TOOLS.has(name) || name.startsWith('goal_')
}

export function isWriteMutationTool(name: string): boolean {
  return WRITE_MUTATION_TOOLS.has(name) || (name.startsWith('action_') && !READ_ONLY_ACTION_TOOLS.has(name))
}

export interface ExtractSessionToolOutcomesOptions {
  readonly limit?: number | undefined
  readonly nativeGoalId?: string | undefined
  readonly sinceTime?: number | undefined
  readonly afterGoalRound?: number | undefined
}

export interface RecentToolOutcome {
  readonly name: string
  readonly isError: boolean
}

export interface StrategyModeCapabilityConfig {
  readonly enabled: boolean
  readonly allowedTools: readonly string[]
  readonly maxToolCalls: number
  readonly maxModelCalls: number
  readonly workspaceWriteAllowed: boolean
}

export interface StrategyCostBenefitPolicy {
  readonly minNetBenefit: number
  readonly minRemainingParentCalls: number
  readonly maxAdviceRepetitions: number
}

export interface StrategyCandidateEvaluation {
  readonly mode: StrategyRouteMode
  readonly feasible: boolean
  readonly infeasibleReason?: string
  readonly estimatedModelCalls: number
  readonly estimatedToolCalls: number
  readonly estimatedCostCalls: number
  readonly expectedBenefit: number
  readonly netBenefit: number
}

export interface StrategyRoutingDecision {
  readonly difficulty: StrategyTaskDifficulty
  readonly difficultyScore: number
  readonly difficultySignals: readonly string[]
  readonly failureType: StrategyFailureType
  readonly failureSignals: readonly string[]
  readonly selectedStrategy: StrategyRouteMode
  readonly estimatedModelCalls: number
  readonly estimatedToolCalls: number
  readonly estimatedCostCalls: number
  readonly expectedBenefit: number
  readonly expectedNetBenefit: number
  readonly rationale: string
  readonly candidates: readonly StrategyCandidateEvaluation[]
}

export interface ClassifyFailureInput {
  readonly feedback?: GoalFeedback | undefined
  readonly goalAcceptance?: GoalOutcomeView | undefined
  readonly recentStrategies?: readonly StrategyRecord[] | undefined
  readonly recentToolOutcomes?: readonly RecentToolOutcome[] | undefined
  readonly failureHint?: 'tool-failure' | 'reasoning-failure' | undefined
}

export interface AssessDifficultyInput {
  readonly record: Pick<GoalRecord, 'definition' | 'native' | 'checkpoint'>
  readonly feedback?: GoalFeedback | undefined
  readonly goalAcceptance?: GoalOutcomeView | undefined
  readonly question?: string | undefined
  readonly context?: string | undefined
  readonly now: number
  readonly difficultyHint?: StrategyTaskDifficulty | undefined
}

export interface OptimizeStrategyInput {
  readonly difficulty: StrategyTaskDifficulty
  readonly difficultyScore: number
  readonly difficultySignals: readonly string[]
  readonly failureType: StrategyFailureType
  readonly failureSignals: readonly string[]
  readonly budget?: GoalBudgetSnapshot | undefined
  readonly adviceSummary?: StrategyAdviceDefinitionSummary | undefined
  readonly telemetry?: StrategyOutcomeTelemetry | undefined
  readonly requestDigest?: string | undefined
  readonly experiment: StrategyModeCapabilityConfig
  readonly subagent: StrategyModeCapabilityConfig
  readonly availableTools?: readonly string[] | undefined
  readonly costBenefit: StrategyCostBenefitPolicy
  readonly maxStrategyDurationMs: number
  readonly now: number
}

export interface RecommendGoalStrategyInput extends ClassifyFailureInput, AssessDifficultyInput {
  readonly budget?: GoalBudgetSnapshot | undefined
  readonly adviceSummary?: StrategyAdviceDefinitionSummary | undefined
  readonly telemetry?: StrategyOutcomeTelemetry | undefined
  readonly requestDigest?: string | undefined
  readonly experiment?: StrategyModeCapabilityConfig | undefined
  readonly subagent?: StrategyModeCapabilityConfig | undefined
  readonly availableTools?: readonly string[] | undefined
  readonly costBenefit?: StrategyCostBenefitPolicy | undefined
  readonly maxStrategyDurationMs?: number | undefined
}

const DEFAULT_EXPERIMENT_CAPABILITY: StrategyModeCapabilityConfig = Object.freeze({
  enabled: true,
  allowedTools: Object.freeze(['read', 'glob', 'grep', 'isolation_run']),
  maxToolCalls: 4,
  maxModelCalls: 3,
  workspaceWriteAllowed: false,
})

const DEFAULT_SUBAGENT_CAPABILITY: StrategyModeCapabilityConfig = Object.freeze({
  enabled: true,
  allowedTools: Object.freeze(['read', 'glob', 'grep', 'isolation_run']),
  maxToolCalls: 8,
  maxModelCalls: 5,
  workspaceWriteAllowed: false,
})

const DEFAULT_COST_BENEFIT_POLICY: StrategyCostBenefitPolicy = Object.freeze({
  minNetBenefit: 0.25,
  minRemainingParentCalls: 1,
  maxAdviceRepetitions: 2,
})

const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
    Object.freeze(value)
  }
  return value
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000

const goalChangeId = (data: Record<string, unknown>): string | undefined => {
  const goal = data.goal as { id?: unknown } | undefined
  if (goal && typeof goal === 'object' && goal.id !== undefined) return String(goal.id)
  const cleared = data.cleared as { id?: unknown } | undefined
  if (cleared && typeof cleared === 'object' && cleared.id !== undefined) return String(cleared.id)
  return undefined
}

const isIntraTurnContextMessage = (source: { kind?: unknown } | undefined): boolean =>
  source?.kind === 'runtime-context' || source?.kind === 'skill-catalog'

const isGoalLifecycleBoundaryAfter = (
  ev: { type?: unknown; data?: Record<string, unknown> },
  nativeGoalId: string,
  hasGoalMsg: boolean,
): boolean => {
  if (ev.type === 'turn/end') return true
  if (ev.type === 'turn/start' && hasGoalMsg) return true
  if (ev.type === 'user/message' && ev.data && typeof ev.data === 'object') {
    const source = (ev.data as { source?: { kind?: unknown; goalId?: unknown } }).source
    if (isIntraTurnContextMessage(source)) return false
    if (source?.kind === 'goal' && String(source.goalId) === nativeGoalId) return hasGoalMsg
    return true
  }
  if (ev.type === 'goal/change' && ev.data && typeof ev.data === 'object') {
    const op = ev.data.operation
    const id = goalChangeId(ev.data)
    if (id === nativeGoalId && (op === 'clear' || op === 'pause' || op === 'complete' || op === 'block')) return true
    if (id !== undefined && id !== nativeGoalId && (op === 'create' || op === 'edit' || op === 'resume')) return true
  }
  return false
}

/**
 * Pure read-only extraction of recent operational tool outcomes from a session log.
 * Scopes strictly to the target goal's active/latest round when `nativeGoalId` is given,
 * tracks per-tool latest outcome (so recovered errors clear), excludes
 * `goal_strategy` itself, and never copies tool arguments or output bodies.
 */
export function extractRecentSessionToolOutcomes(
  events: readonly unknown[],
  limitOrOptions: number | ExtractSessionToolOutcomesOptions = 16,
): readonly RecentToolOutcome[] {
  const limit = typeof limitOrOptions === 'number' ? limitOrOptions : (limitOrOptions.limit ?? 16)
  const nativeGoalId = typeof limitOrOptions === 'number' ? undefined : limitOrOptions.nativeGoalId
  const sinceTime = typeof limitOrOptions === 'number' ? undefined : limitOrOptions.sinceTime
  const afterGoalRound = typeof limitOrOptions === 'number' ? undefined : limitOrOptions.afterGoalRound
  if (!Array.isArray(events) || events.length === 0 || limit <= 0) return freeze([])

  let startIdx = 0
  let endIdx = events.length
  let goalMsgRound = -1
  if (nativeGoalId !== undefined) {
    let goalBoundaryIdx = -1
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const raw = events[i]
      if (!raw || typeof raw !== 'object') continue
      const ev = raw as { type?: unknown; data?: Record<string, unknown> }
      if (ev.type === 'goal/change' && ev.data && typeof ev.data === 'object') {
        const op = ev.data.operation
        const id = goalChangeId(ev.data)
        if ((op === 'create' || op === 'edit' || op === 'resume') && id === nativeGoalId) {
          goalBoundaryIdx = i
          break
        }
      }
    }
    const scanFrom = Math.max(0, goalBoundaryIdx)
    let goalMsgIdx = -1
    for (let i = events.length - 1; i >= scanFrom; i -= 1) {
      const raw = events[i]
      if (!raw || typeof raw !== 'object') continue
      const ev = raw as { type?: unknown; data?: { source?: { kind?: unknown; goalId?: unknown; round?: unknown } } }
      if (ev.type === 'user/message' && ev.data?.source?.kind === 'goal' && String(ev.data.source.goalId) === nativeGoalId) {
        goalMsgIdx = i
        goalMsgRound = typeof ev.data.source.round === 'number' ? ev.data.source.round : -1
        break
      }
    }
    if (goalMsgIdx !== -1) {
      if (afterGoalRound !== undefined && goalMsgRound > 0 && goalMsgRound <= afterGoalRound) {
        return freeze([])
      }
      let turnStartIdx = -1
      for (let i = goalMsgIdx - 1; i >= scanFrom; i -= 1) {
        const raw = events[i]
        if (!raw || typeof raw !== 'object') continue
        const ev = raw as { type?: unknown; data?: Record<string, unknown> }
        if (ev.type === 'turn/start') {
          turnStartIdx = i
          break
        }
        if (ev.type === 'turn/end' || ev.type === 'goal/change') break
        if (ev.type === 'user/message') {
          const source = (ev.data as { source?: { kind?: unknown } } | undefined)?.source
          if (!isIntraTurnContextMessage(source)) break
        }
      }
      startIdx = turnStartIdx !== -1 ? turnStartIdx : goalMsgIdx
      for (let i = goalMsgIdx + 1; i < events.length; i += 1) {
        const raw = events[i]
        if (!raw || typeof raw !== 'object') continue
        if (isGoalLifecycleBoundaryAfter(raw as { type?: unknown; data?: Record<string, unknown> }, nativeGoalId, true)) {
          endIdx = i
          break
        }
      }
    } else if (goalBoundaryIdx !== -1) {
      startIdx = goalBoundaryIdx
      for (let i = goalBoundaryIdx + 1; i < events.length; i += 1) {
        const raw = events[i]
        if (!raw || typeof raw !== 'object') continue
        if (isGoalLifecycleBoundaryAfter(raw as { type?: unknown; data?: Record<string, unknown> }, nativeGoalId, false)) {
          endIdx = i
          break
        }
      }
    } else {
      return freeze([])
    }
  }

  const applySinceTime = sinceTime !== undefined && !(afterGoalRound !== undefined && goalMsgRound > afterGoalRound)
  const window = events.slice(startIdx, endIdx).slice(-256)
  const calls = new Map<string, string>()
  const latestByTool = new Map<string, boolean>()
  for (const raw of window) {
    if (!raw || typeof raw !== 'object') continue
    const event = raw as { type?: unknown; time?: unknown; data?: Record<string, unknown> }
    if (applySinceTime && typeof event.time === 'number' && event.time <= sinceTime) continue
    if (event.type === 'tool/call' && event.data && typeof event.data.callId === 'string' && typeof event.data.name === 'string') {
      calls.set(event.data.callId, event.data.name)
    } else if (event.type === 'tool/result' && event.data?.message && typeof event.data.message === 'object') {
      const msg = event.data.message as {
        role?: unknown
        isError?: unknown
        toolCallId?: unknown
        source?: { callId?: unknown }
        content?: unknown
      }
      const callId = typeof msg.source?.callId === 'string'
        ? msg.source.callId
        : typeof msg.toolCallId === 'string'
          ? msg.toolCallId
          : Array.isArray(msg.content) && msg.content.length === 1 && msg.content[0] && typeof (msg.content[0] as { toolCallId?: unknown }).toolCallId === 'string'
            ? (msg.content[0] as { toolCallId: string }).toolCallId
            : undefined
      if (!callId) continue
      const name = calls.get(callId)
      if (!name || name === 'goal_strategy') continue
      const nestedError = Array.isArray(msg.content) && msg.content.some(item => item && typeof item === 'object' && (item as { isError?: unknown }).isError === true)
      const isError = msg.isError === true || nestedError
      latestByTool.delete(name)
      latestByTool.set(name, isError)
    }
  }
  const outcomes = [...latestByTool.entries()].map(([name, isError]) => freeze({ name, isError }))
  return freeze(outcomes.slice(-limit))
}

export function filterPermittedStrategyTools(
  capability: StrategyModeCapabilityConfig,
  availableTools?: readonly string[],
  requestedTools?: readonly string[],
): readonly string[] {
  if (!capability.enabled || capability.maxToolCalls <= 0) return freeze([])
  const available = availableTools === undefined ? undefined : new Set(availableTools)
  const requested = requestedTools === undefined ? undefined : new Set(requestedTools)
  const filtered: string[] = []
  for (const tool of capability.allowedTools) {
    if (isForbiddenStrategyTool(tool)) continue
    if (!capability.workspaceWriteAllowed && isWriteMutationTool(tool)) continue
    if (requested !== undefined && !requested.has(tool)) continue
    if (available !== undefined && !available.has(tool)) continue
    if (!filtered.includes(tool)) filtered.push(tool)
  }
  return freeze(filtered)
}

/**
 * Deterministic failure-type classifier separating operational/tool failures
 * from reasoning/plan failures and unreconciled unknown execution.
 */
export function classifyGoalFailureType(input: ClassifyFailureInput): { readonly failureType: StrategyFailureType; readonly signals: readonly string[] } {
  const signals: string[] = []
  const recent = (input.recentStrategies ?? []).slice(0, 5)
  const currentStep = input.feedback?.verification.current ?? null

  if (
    input.feedback?.nextAction === 'reconcile-execution'
    || currentStep?.execution?.quiescent === false
    || currentStep?.status === 'unknown'
    || input.goalAcceptance?.status === 'unknown'
    || recent.some(item => item.state === 'unknown' || item.children.some(child => !child.quiescent))
  ) {
    if (input.feedback?.nextAction === 'reconcile-execution') signals.push('feedback:reconcile-execution')
    if (currentStep?.execution?.quiescent === false) signals.push('step:non-quiescent')
    if (currentStep?.status === 'unknown') signals.push('step:unknown')
    if (input.goalAcceptance?.status === 'unknown') signals.push('whole-goal:unknown')
    if (recent.some(item => item.state === 'unknown' || item.children.some(child => !child.quiescent))) signals.push('strategy:unknown')
    return freeze({ failureType: 'unknown-execution', signals })
  }

  let toolFailure = false
  for (const item of recent) {
    const isToolBranch = item.intent.kind === 'experiment' || item.intent.kind === 'subagent'
    if (item.outcome === 'execution-failed' && isToolBranch) {
      toolFailure = true
      signals.push(`strategy:execution-failed:${item.intent.kind}`)
    }
    for (const child of item.children) {
      if (child.diagnostics?.failure !== undefined) {
        toolFailure = true
        signals.push(`strategy-child:${child.diagnostics.failure.stage}`)
      }
      if ((child.diagnostics?.toolRejections ?? 0) > 0) {
        toolFailure = true
        signals.push('strategy-child:tool-rejected')
      }
    }
  }
  const latestToolErrors = new Map<string, boolean>()
  for (const item of input.recentToolOutcomes ?? []) {
    latestToolErrors.set(item.name, item.isError)
  }
  const erroredTools = [...latestToolErrors.entries()].filter(([, isError]) => isError).map(([name]) => name)
  if (erroredTools.length > 0) {
    toolFailure = true
    for (const name of erroredTools.slice(0, 4)) signals.push(`tool-error:${name}`)
  }
  if (currentStep?.status === 'invalid' || currentStep?.status === 'unavailable') {
    toolFailure = true
    signals.push(`step:${currentStep.status}`)
  }
  if (toolFailure) return freeze({ failureType: 'tool-failure', signals })

  let reasoningFailure = false
  if (currentStep?.status === 'not-achieved') {
    reasoningFailure = true
    signals.push('step:not-achieved')
  }
  if (input.feedback?.nextAction === 'revise-plan') {
    reasoningFailure = true
    signals.push('feedback:revise-plan')
  }
  if (input.goalAcceptance?.status === 'not-achieved') {
    reasoningFailure = true
    signals.push('whole-goal:not-achieved')
  }
  if (currentStep?.criteria.some(criterion => criterion.status === 'failed')) {
    reasoningFailure = true
    signals.push('step:failed-criteria')
  }
  if (reasoningFailure) return freeze({ failureType: 'reasoning-failure', signals })

  if (input.failureHint !== undefined) {
    signals.push(`hint:${input.failureHint}`)
    return freeze({ failureType: input.failureHint, signals })
  }

  return freeze({ failureType: 'none', signals })
}

/**
 * Deterministic task-difficulty estimator using structural goal state,
 * dependencies, blockers, stale assumptions, prior failed rounds, and payload size.
 */
export function assessTaskDifficulty(input: AssessDifficultyInput): { readonly difficulty: StrategyTaskDifficulty; readonly score: number; readonly signals: readonly string[] } {
  let score = 0
  const signals: string[] = []
  const deps = input.record.checkpoint.dependencies.length
  const blockers = input.record.checkpoint.blockers.length
  const staleAssumptions = input.record.checkpoint.assumptions.filter(item => item.expiresAt <= input.now).length
  const failedHistory = (input.feedback?.verification.history ?? []).filter(item => item.status === 'not-achieved' || item.status === 'unknown').length
  const failedStepCriteria = (input.feedback?.verification.current?.criteria ?? []).filter(item => item.status === 'failed').length
  const failedGoalCriteria = (input.goalAcceptance?.criteria ?? []).filter(item => item.status === 'failed').length
  const totalFailedCriteria = failedStepCriteria + failedGoalCriteria
  const roundRatio = input.record.native.maxGoalRounds > 0
    ? input.record.native.roundsStarted / input.record.native.maxGoalRounds
    : 0
  const contextBytes = Buffer.byteLength(input.question ?? '', 'utf8')
    + Buffer.byteLength(input.context ?? '', 'utf8')
    + Buffer.byteLength(input.record.definition.objective, 'utf8')

  if (deps >= 2) { score += 2; signals.push(`dependencies:${deps}`) }
  else if (deps === 1) { score += 1; signals.push('dependencies:1') }

  if (blockers >= 2) { score += 2; signals.push(`blockers:${blockers}`) }
  else if (blockers === 1) { score += 1; signals.push('blockers:1') }

  if (staleAssumptions >= 1) { score += 1; signals.push(`stale-assumptions:${staleAssumptions}`) }

  if (failedHistory >= 2) { score += 2; signals.push(`failed-history:${failedHistory}`) }
  else if (failedHistory === 1) { score += 1; signals.push('failed-history:1') }

  if (totalFailedCriteria >= 2) { score += 2; signals.push(`failed-criteria:${totalFailedCriteria}`) }
  else if (totalFailedCriteria === 1) { score += 1; signals.push('failed-criteria:1') }

  if (roundRatio >= 0.5 && input.record.native.roundsStarted > 0) { score += 1; signals.push('round-pressure') }

  if (contextBytes > 4096) { score += 2; signals.push('large-context') }
  else if (contextBytes > 1024) { score += 1; signals.push('medium-context') }

  const hasClearNextStep = input.record.checkpoint.nextStep.trim().length > 0
    && blockers === 0 && failedHistory === 0 && totalFailedCriteria === 0
  if (hasClearNextStep && score > 0) {
    score = Math.max(0, score - 1)
    signals.push('clear-next-step')
  }

  let difficulty: StrategyTaskDifficulty = score >= 4 ? 'complex' : score >= 2 ? 'moderate' : 'trivial'
  if (input.difficultyHint !== undefined && signals.length === 0) {
    difficulty = input.difficultyHint
    signals.push(`hint:${input.difficultyHint}`)
  }

  return freeze({ difficulty, score, signals })
}

function baseBenefitFor(
  difficulty: StrategyTaskDifficulty,
  failureType: StrategyFailureType,
  mode: StrategyRouteMode,
): number {
  if (failureType === 'unknown-execution') return mode === 'direct' ? 1.5 : 0
  if (mode === 'direct') {
    if (failureType === 'none' && difficulty === 'trivial') return 2.0
    if (failureType === 'none' && difficulty === 'moderate') return 1.4
    if (failureType === 'none' && difficulty === 'complex') return 1.0
    if (difficulty === 'trivial') return 0.9
    return 0.7
  }
  if (failureType === 'tool-failure') {
    switch (mode) {
      case 'experiment': return difficulty === 'complex' ? 4.8 : difficulty === 'moderate' ? 4.2 : 3.6
      case 'investigate': return difficulty === 'complex' ? 2.1 : difficulty === 'moderate' ? 1.8 : 0.9
      case 'subagent': return difficulty === 'complex' ? 4.3 : difficulty === 'moderate' ? 2.8 : 1.0
      case 'review': return difficulty === 'complex' ? 1.4 : 1.1
      case 'compare': return difficulty === 'complex' ? 1.8 : 1.2
    }
  }
  if (failureType === 'reasoning-failure') {
    switch (mode) {
      case 'compare': return difficulty === 'complex' ? 4.8 : difficulty === 'moderate' ? 2.9 : 1.4
      case 'review': return difficulty === 'complex' ? 3.2 : difficulty === 'moderate' ? 3.0 : 2.4
      case 'investigate': return difficulty === 'complex' ? 3.1 : difficulty === 'moderate' ? 2.7 : 1.5
      case 'experiment': return difficulty === 'complex' ? 4.0 : difficulty === 'moderate' ? 3.2 : 1.8
      case 'subagent': return difficulty === 'complex' ? 4.8 : difficulty === 'moderate' ? 3.0 : 1.2
    }
  }
  // failureType === 'none'
  switch (mode) {
    case 'subagent': return difficulty === 'complex' ? 5.2 : difficulty === 'moderate' ? 2.4 : 0.4
    case 'investigate': return difficulty === 'complex' ? 2.4 : difficulty === 'moderate' ? 2.0 : 0.6
    case 'experiment': return difficulty === 'complex' ? 3.6 : difficulty === 'moderate' ? 2.2 : 0.5
    case 'compare': return difficulty === 'complex' ? 3.6 : difficulty === 'moderate' ? 1.9 : 0.3
    case 'review': return difficulty === 'complex' ? 2.2 : difficulty === 'moderate' ? 1.8 : 0.5
  }
}

/**
 * Coordination cost/benefit optimizer. Evaluates remaining parent budget headroom,
 * empirical strategy telemetry, and advice-repetition saturation to choose the
 * highest net-utility strategy or downgrade/skip to `direct`.
 */
export function optimizeStrategyDecision(input: OptimizeStrategyInput): StrategyRoutingDecision {
  const modes: readonly StrategyRouteMode[] = ['direct', 'investigate', 'experiment', 'review', 'compare', 'subagent']
  const experimentTools = filterPermittedStrategyTools(input.experiment, input.availableTools)
  const subagentTools = filterPermittedStrategyTools(input.subagent, input.availableTools)

  const remainingModelCalls = input.budget === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, input.budget.limits.modelCalls - input.budget.modelCalls)
  const remainingToolCalls = input.budget === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, input.budget.limits.toolCalls - input.budget.toolCalls)
  const remainingMs = input.budget === undefined
    ? input.maxStrategyDurationMs
    : Math.max(0, Math.min(input.budget.limits.expiresAt - input.now, input.maxStrategyDurationMs))
  const tokenExhausted = input.budget?.limits.mode === 'tokens' && (
    (input.budget.outputTokens ?? 0) >= (input.budget.limits.outputTokens ?? Number.POSITIVE_INFINITY)
    || (input.budget.inputTokens ?? 0) >= (input.budget.limits.inputTokens ?? Number.POSITIVE_INFINITY)
    || (input.budget.limits.costUsdMicros !== null && (input.budget.costUsdMicros ?? 0) >= input.budget.limits.costUsdMicros)
  )

  const exactRequestRep = input.requestDigest === undefined
    ? undefined
    : input.adviceSummary?.requests.find(item => item.requestDigest === input.requestDigest)
  const stagnantExactAdvice = exactRequestRep !== undefined
    && exactRequestRep.occurrences >= input.costBenefit.maxAdviceRepetitions
    && exactRequestRep.distinctOutputDigests <= 1
  const totalAdviceRepeats = input.adviceSummary === undefined
    ? 0
    : Math.max(0, input.adviceSummary.adviceRuns - input.adviceSummary.distinctRequests)
  const adviceSaturated = stagnantExactAdvice || totalAdviceRepeats >= input.costBenefit.maxAdviceRepetitions + 1

  const candidates: StrategyCandidateEvaluation[] = modes.map(mode => {
    if (mode === 'direct') {
      const benefit = round3(baseBenefitFor(input.difficulty, input.failureType, 'direct'))
      return freeze({
        mode: 'direct',
        feasible: true,
        estimatedModelCalls: 0,
        estimatedToolCalls: 0,
        estimatedCostCalls: 0,
        expectedBenefit: benefit,
        netBenefit: benefit,
      })
    }

    const modeTelemetry = input.telemetry?.byKind[mode]
    let priorModelCalls = mode === 'compare' ? 2
      : mode === 'experiment' ? Math.min(input.experiment.maxModelCalls, 2)
        : mode === 'subagent' ? Math.min(input.subagent.maxModelCalls, 3)
          : 1
    let priorToolCalls = mode === 'experiment'
      ? Math.min(input.experiment.maxToolCalls, experimentTools.length > 0 ? 2 : 0)
      : mode === 'subagent'
        ? Math.min(input.subagent.maxToolCalls, subagentTools.length > 0 ? 3 : 0)
        : 0

    if (modeTelemetry !== undefined && modeTelemetry.total >= 1) {
      priorModelCalls = Math.max(1, round3((priorModelCalls + modeTelemetry.avgModelCalls) / 2))
      if (mode === 'experiment' || mode === 'subagent') {
        priorToolCalls = round3((priorToolCalls + modeTelemetry.avgToolCalls) / 2)
      }
    }

    let infeasibleReason: string | undefined
    if (input.failureType === 'unknown-execution') {
      infeasibleReason = 'reconcile-unknown-execution-first'
    } else if (remainingMs < 1_000) {
      infeasibleReason = 'insufficient-time-headroom'
    } else if (tokenExhausted) {
      infeasibleReason = 'token-or-cost-budget-exhausted'
    } else if (remainingModelCalls - Math.ceil(priorModelCalls) < input.costBenefit.minRemainingParentCalls) {
      infeasibleReason = 'insufficient-model-call-headroom'
    } else if (mode === 'experiment') {
      if (!input.experiment.enabled) infeasibleReason = 'experiment-disabled'
      else if (experimentTools.length === 0) infeasibleReason = 'no-permitted-experiment-tools'
      else if (remainingToolCalls < 1 || input.experiment.maxToolCalls < 1) infeasibleReason = 'insufficient-tool-budget'
    } else if (mode === 'subagent') {
      if (!input.subagent.enabled) infeasibleReason = 'subagent-disabled'
      else if (subagentTools.length === 0 && input.subagent.maxToolCalls > 0 && input.availableTools !== undefined) infeasibleReason = 'no-permitted-subagent-tools'
      else if (subagentTools.length > 0 && remainingToolCalls < 1) infeasibleReason = 'insufficient-tool-budget'
    }

    const baseCost = priorModelCalls + 0.15 * priorToolCalls + (mode === 'compare' ? 0.2 : mode === 'subagent' ? 0.15 : 0)
    const scarcityMultiplier = Number.isFinite(remainingModelCalls) && remainingModelCalls <= 4 ? 1.25 : 1.0
    const estimatedCostCalls = round3(baseCost * scarcityMultiplier)

    let expectedBenefit = baseBenefitFor(input.difficulty, input.failureType, mode)
    if ((mode === 'investigate' || mode === 'review' || mode === 'compare') && adviceSaturated) {
      expectedBenefit -= 2.0
    }
    if (modeTelemetry !== undefined && modeTelemetry.total >= 2) {
      const failureRate = modeTelemetry.failedOrUnknown / modeTelemetry.total
      const successRate = modeTelemetry.succeeded / modeTelemetry.total
      expectedBenefit += 0.4 * successRate - 2.2 * failureRate
    }
    expectedBenefit = round3(expectedBenefit)
    const netBenefit = round3(expectedBenefit - estimatedCostCalls)

    return freeze({
      mode,
      feasible: infeasibleReason === undefined,
      ...(infeasibleReason === undefined ? {} : { infeasibleReason }),
      estimatedModelCalls: round3(priorModelCalls),
      estimatedToolCalls: round3(priorToolCalls),
      estimatedCostCalls,
      expectedBenefit,
      netBenefit,
    })
  })

  const direct = candidates[0]!
  const feasibleBranches = candidates
    .filter(item => item.mode !== 'direct' && item.feasible)
    .sort((left, right) => right.netBenefit - left.netBenefit || left.estimatedCostCalls - right.estimatedCostCalls)

  const bestBranch = feasibleBranches[0]
  const chosen = bestBranch !== undefined
    && bestBranch.netBenefit >= input.costBenefit.minNetBenefit
    && bestBranch.netBenefit > direct.netBenefit
    ? bestBranch
    : direct

  const reasons: string[] = [`difficulty=${input.difficulty}`, `failure=${input.failureType}`]
  if (adviceSaturated) reasons.push('advice-repetition-penalty')
  if (bestBranch === undefined) reasons.push('no-feasible-branch')
  else if (chosen.mode === 'direct') reasons.push(`skipped-branch(${bestBranch.mode}:net=${bestBranch.netBenefit})`)
  else reasons.push(`selected=${chosen.mode}(net=${chosen.netBenefit},cost=${chosen.estimatedCostCalls})`)

  return freeze({
    difficulty: input.difficulty,
    difficultyScore: input.difficultyScore,
    difficultySignals: input.difficultySignals,
    failureType: input.failureType,
    failureSignals: input.failureSignals,
    selectedStrategy: chosen.mode,
    estimatedModelCalls: chosen.estimatedModelCalls,
    estimatedToolCalls: chosen.estimatedToolCalls,
    estimatedCostCalls: chosen.estimatedCostCalls,
    expectedBenefit: chosen.expectedBenefit,
    expectedNetBenefit: chosen.netBenefit,
    rationale: reasons.join('; '),
    candidates: freeze(candidates),
  })
}

export function recommendGoalStrategy(input: RecommendGoalStrategyInput): StrategyRoutingDecision {
  const failure = classifyGoalFailureType(input)
  const difficulty = assessTaskDifficulty(input)
  return optimizeStrategyDecision({
    difficulty: difficulty.difficulty,
    difficultyScore: difficulty.score,
    difficultySignals: difficulty.signals,
    failureType: failure.failureType,
    failureSignals: failure.signals,
    budget: input.budget,
    adviceSummary: input.adviceSummary,
    telemetry: input.telemetry,
    requestDigest: input.requestDigest,
    experiment: input.experiment ?? DEFAULT_EXPERIMENT_CAPABILITY,
    subagent: input.subagent ?? DEFAULT_SUBAGENT_CAPABILITY,
    availableTools: input.availableTools,
    costBenefit: input.costBenefit ?? DEFAULT_COST_BENEFIT_POLICY,
    maxStrategyDurationMs: input.maxStrategyDurationMs ?? 30_000,
    now: input.now,
  })
}
