import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import { AssistantWorkItemsService } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-assistant-work-items'
export { AssistantWorkItemsService, version }
export * from './authority.js'
export * from './config.js'
export * from './evaluation.js'
export type { OwnerWorkItemFeedbackProof, OwnerWorkItemFeedbackSelector } from './feedback-targets.js'
export * from './outcome.js'
export * from './service.js'
export * from './settlement.js'
export * from './signals.js'
export * from './types.js'

export function apply(ctx: Context, config: Config): void {
  new AssistantWorkItemsService(ctx, config)
}

export default AssistantWorkItemsService
