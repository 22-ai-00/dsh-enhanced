import type { Context } from '@deepseek-ai/cordis'
import { AssistantGoalsService, Config } from './service.js'
import { version } from './version.js'
export const name = 'dsh-enhanced-assistant-goals'
export { AssistantGoalsService, Config, version }
export type * from './types.js'
export type { GoalBudgetConfig, GoalBudgetMeter } from './budget.js'
export type { GoalBudgetLimits, GoalBudgetSnapshot } from './budget-store.js'
export function apply(ctx: Context, config: Config = {}): void { new AssistantGoalsService(ctx, config) }
export default AssistantGoalsService
