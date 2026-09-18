import type { Context } from '@deepseek-ai/cordis'
import { AssistantEvolutionService } from './service.js'
import type { Config } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-assistant-evolution'
export const inject = ['assistantPolicy', 'assistantEvaluation']
export { AssistantEvolutionService, version }
export type { Config }
export {
  HOST_RECOVERY_BACKGROUND_ID,
  SUPERVISED_GROWTH_ANALYST_AUTOMATION_ID,
  AssistantEvolutionError,
  canonicalEvolutionHostScope,
} from './service.js'
export type {
  AssistantEvolutionHealth,
  EvaluationOutcomeInput,
  EvaluationProjectionInput,
  EvolutionHostOperation,
  EvolutionHostScope,
  EvolutionOwnerUndoInput,
  EvolutionProposalResult,
  EvolutionRollbackResult,
} from './service.js'
export * from './types.js'
export {
  isGoalDefinitionSituation,
  joinStrategyLearningObservations,
  toStrategyAdviceSignal,
} from './strategy-learning.js'
export type {
  GoalDefinitionEpisodeSummary,
  StrategyAdviceSignal,
  StrategyLearningJoinInput,
  StrategyLearningObservation,
} from './strategy-learning.js'

export function apply(ctx: Context, config: Config): void {
  new AssistantEvolutionService(ctx, config)
}

export default AssistantEvolutionService
