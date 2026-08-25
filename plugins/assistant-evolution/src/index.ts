import type { Context } from '@deepseek-ai/cordis'
import { AssistantEvolutionService } from './service.js'
import type { Config } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-assistant-evolution'
export const inject = ['assistantPolicy']
export { AssistantEvolutionService, version }
export type { Config }
export { AssistantEvolutionError } from './service.js'
export type { EvolutionProposalResult } from './service.js'
export * from './types.js'

export function apply(ctx: Context, config: Config): void {
  new AssistantEvolutionService(ctx, config)
}

export default AssistantEvolutionService
