import type { Context } from '@deepseek-ai/cordis'
import {
  AssistantGrowthExperimentsService,
  Config,
  type AssistantGrowthExperimentsConfig,
} from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-assistant-growth-experiments'
export const inject = ['assistantAutomations', 'assistantDelivery']
export { AssistantGrowthExperimentsService, Config, version }
export type { AssistantGrowthExperimentsConfig }
export * from './store.js'
export * from './types.js'

export function apply(ctx: Context, config: AssistantGrowthExperimentsConfig): void {
  new AssistantGrowthExperimentsService(ctx, config)
}

export default AssistantGrowthExperimentsService
