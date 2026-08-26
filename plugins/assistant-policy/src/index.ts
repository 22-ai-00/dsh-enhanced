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
export { isAutoReviewEscalation } from './auto-review.js'
export type { AutoReviewAssessment, AutoReviewConfig } from './auto-review.js'
export { AUTO_REVIEW_APPROVAL_REASON, HUMAN_APPROVAL_REASON } from './tool-risk.js'
export type { NativeFullReviewerReconciliation, PolicyBudgetConfig } from './service.js'
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
  ApprovalDispatchSnapshot,
  ApprovalDispatchState,
  ApprovalProposalInput,
  ApprovalProposalLookupInput,
  ApprovalProposalRecoveryInput,
  ApprovalProposalRecoveryResult,
  ApprovalProposalResult,
  ApprovalProposalStatus,
  AuditEvent,
  BudgetReservationResult,
  ApprovalProposalSnapshot,
  EmergencyStopState,
} from './ledger.js'
export * from './types.js'

export function apply(ctx: Context, config: import('./service.js').Config): void {
  new AssistantPolicyService(ctx, config)
}

export default AssistantPolicyService
