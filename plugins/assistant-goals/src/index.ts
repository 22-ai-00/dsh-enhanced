import type { Context } from '@deepseek-ai/cordis'
import { AssistantGoalsService, Config } from './service.js'
import { version } from './version.js'
export const name = 'dsh-enhanced-assistant-goals'
export { AssistantGoalsService, Config, version }
export { OwnerVerifiedWorkflowSourceError } from './verified-workflow.js'
export type { VerifiedWorkflowSource, VerifiedWorkflowSegment } from './verified-workflow.js'
export type { OwnerVerifiedArtifactsInput } from './verified-artifact.js'
export type * from './types.js'
export type { GoalBudgetConfig, GoalTokenBudgetConfig, GoalCallsBudgetConfig, GoalBudgetMeter, GoalBudgetFailure } from './budget.js'
export type { GoalBudgetLimits, GoalBudgetSnapshot } from './budget-store.js'
export type { GoalWakeConfig } from './wake.js'
export type { GoalEventWait, GoalEventWaitIntent, GoalEventSourceSnapshot } from './event-wait-store.js'
export type {
  GoalStrategyConfig,
  GoalStrategyConfigInput,
  GoalStrategyExperimentConfig,
  GoalStrategyExperimentConfigInput,
  GoalStrategyCostBenefitConfig,
  GoalStrategyCostBenefitConfigInput,
  GoalStrategyInput,
  GoalStrategyResult,
  StrategyRecommendationContext,
} from './strategy.js'
export { validateGoalStrategyConfig, validateGoalStrategyInput } from './strategy.js'
export {
  FORBIDDEN_STRATEGY_TOOLS,
  WRITE_MUTATION_TOOLS,
  assessTaskDifficulty,
  classifyGoalFailureType,
  extractRecentSessionToolOutcomes,
  filterPermittedStrategyTools,
  isForbiddenStrategyTool,
  isWriteMutationTool,
  optimizeStrategyDecision,
  recommendGoalStrategy,
} from './strategy-router.js'
export type {
  AssessDifficultyInput,
  ClassifyFailureInput,
  ExtractSessionToolOutcomesOptions,
  OptimizeStrategyInput,
  RecentToolOutcome,
  RecommendGoalStrategyInput,
  StrategyCandidateEvaluation,
  StrategyCostBenefitPolicy,
  StrategyModeCapabilityConfig,
  StrategyRoutingDecision,
} from './strategy-router.js'
export type { GoalBudgetRunUsage } from './budget-store.js'
export type { GoalStrategyAssessment, GoalStrategyHistory } from './strategy-feedback.js'
export type { GoalOutcomeAssessment, GoalOutcomeDefinition } from './outcome-store.js'
export type {
  StrategyKind,
  StrategyRouteMode,
  StrategyRequestedKind,
  StrategyTaskDifficulty,
  StrategyFailureType,
  StrategyOutcome,
  StrategyRoutingSummary,
  StrategyExperimentIntent,
  StrategyModeTelemetry,
  StrategyOutcomeTelemetry,
  StrategyChildDiagnostics,
  StrategyTerminationReason,
  StrategyAdviceDefinitionSummary,
  StrategyAdviceRequestRepetition,
} from './strategy-store.js'
export function apply(ctx: Context, config: Config = {}): void { new AssistantGoalsService(ctx, config) }
export default { name, Config, apply }
