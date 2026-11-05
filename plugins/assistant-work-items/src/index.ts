import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import { AssistantWorkItemsService } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-assistant-work-items'
export { AssistantWorkItemsService, version }
export * from './authority.js'
export { decisionExternalId } from './mandate.js'
export * from './config.js'
export * from './evaluation.js'
export * from './intake.js'
export * from './intake-evaluation.js'
export type { OwnerWorkItemFeedbackProof, OwnerWorkItemFeedbackSelector } from './feedback-targets.js'
export * from './outcome.js'
export { normalizeFollowUp, normalizePolicyChange, MAX_POLICY_NOTICE_ITEMS } from './policy-notice.js'
export { POLICY_NOTICE_EVENT, FOLLOW_UP_OWNED_EVENT, FOLLOW_UP_PROCESSED_EVENT, FOLLOW_UP_RELEASED_EVENT, type WorkItemFollowUpCursor } from './store.js'
export * from './service.js'
export * from './settlement.js'
export * from './signals.js'
export * from './types.js'

export function apply(ctx: Context, config: Config): void {
  new AssistantWorkItemsService(ctx, config)
}

export default AssistantWorkItemsService

export type { EngineeringReportRef, EngineeringNode, WorkItemEngineeringMaterial } from './engineering-context.js'
