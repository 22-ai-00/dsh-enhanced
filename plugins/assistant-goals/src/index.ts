import type { Context } from '@deepseek-ai/cordis'
import { AssistantGoalsService, Config } from './service.js'
import { version } from './version.js'
export const name = 'dsh-enhanced-assistant-goals'
export { AssistantGoalsService, Config, version }
export type * from './types.js'
export type { GoalBudgetConfig, GoalBudgetMeter, GoalBudgetFailure } from './budget.js'
export type { GoalBudgetLimits, GoalBudgetSnapshot } from './budget-store.js'
export type { GoalWakeConfig } from './wake.js'
export type { GoalStrategyConfig, GoalStrategyInput, GoalStrategyResult } from './strategy.js'
export { validateGoalStrategyConfig } from './strategy.js'
export type { GoalBudgetRunUsage } from './budget-store.js'
export type { GoalStrategyAssessment, GoalStrategyHistory } from './strategy-feedback.js'
export type { StrategyChildDiagnostics, StrategyTerminationReason } from './strategy-store.js'
export function apply(ctx: Context, config: Config = {}): void { new AssistantGoalsService(ctx, config) }
export default { name, Config, apply }
