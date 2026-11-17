import type { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService, Config } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-assistant-policy'
export { AssistantPolicyService, Config, version }
export {
  APPROVAL_REVIEWERS,
  approvalReviewerOf,
  foldApprovalReviewer,
  getApprovalReviewer,
  setApprovalReviewer,
} from './approval-reviewer.js'
export type { ApprovalReviewer } from './approval-reviewer.js'
export { waitForApprovalReviewerSessionEventReady } from './session-event-registration.js'
export type { HumanApprovalAnswerer } from './approval-routing.js'
export { isAutoReviewEscalation } from './auto-review.js'
export type { AutoReviewAssessment, AutoReviewConfig } from './auto-review.js'
export { AUTO_REVIEW_APPROVAL_REASON, HUMAN_APPROVAL_REASON } from './tool-risk.js'
export type { NativeFullReviewerReconciliation, OwnerRequestedChangeContext, OwnerRequestedChangeInput, PolicyBudgetConfig, PolicyHostConfiguration, PrincipalAuthorizationOptions } from './service.js'
export { principalPartitionScope } from './service.js'
export { APPROVAL_DISPLAY_BUDGET } from './ledger.js'
export { ApprovalSettlementConflict, validateApprovalSettlement } from './settlement.js'
export type {
  ApprovalSettlementConflictReason,
  ApprovalSettlementExpectation,
  ValidatedApprovalSettlement,
} from './settlement.js'
export type {
  ApprovalDecisionInput,
  ApprovalDispatchResult,
  ApprovalDispatchCursor,
  ApprovalDispatchRoute,
  ApprovalDispatchRouteV1,
  ApprovalDispatchRouteV2,
  ApprovalDispatchSnapshot,
  ApprovalDispatchState,
  ApprovalProposalInput,
  ApprovalProposalLookupInput,
  ApprovalProposalRecoveryInput,
  ApprovalProposalRecoveryResult,
  ApprovalProposalResult,
  ApprovalProposalRouteState,
  ApprovalProposalRouteStates,
  ApprovalProposalStatus,
  AuditEvent,
  BudgetReservationResult,
  ApprovalProposalSnapshot,
  EmergencyStopState,
} from './ledger.js'
export {
  AUTONOMY_BUDGET_TIERS,
  AUTONOMY_DAILY_PERIOD_MS,
  MAX_AUTONOMY_DAILY_BUDGET,
  WEB_OWNER_POLICY_ID_PREFIX,
  buildWebOwnerDreamingPolicyGrants,
  buildWebOwnerGrowthPolicyGrants,
  buildWebOwnerMemoryPolicyGrants,
  mergeAssistantPolicyGrants,
  webOwnerBudgetIds,
  webOwnerDreamingRuleIds,
  webOwnerGrowthRuleIds,
  webOwnerGrowthUsageRuleIds,
  webOwnerMemoryRuleIds,
  webOwnerPolicyPrefix,
  type AutonomyBudgetTier,
  type AutonomyBudgetTierDefaults,
  type MergeAssistantPolicyGrantsInput,
  type MergedAssistantPolicyGrants,
  type PolicyGrantBundle,
  type WebOwnerDreamingPolicyGrantInput,
  type WebOwnerGrowthPolicyGrantInput,
  type WebOwnerMemoryPolicyGrantInput,
  type WebOwnerPolicyScope,
} from './autonomy-grants.js'
export * from './types.js'

export function apply(ctx: Context, config: import('./service.js').Config): void {
  new AssistantPolicyService(ctx, config)
}

export default AssistantPolicyService
