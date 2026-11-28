import type { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService, Config } from './service.js'
import { version } from './version.js'

export const name = 'dsh-ray-assistant-policy'
export { AssistantPolicyService, Config, version }
export type {
  RayIdeal,
  RayInterest,
  RayStageGoal,
  RayTeachingExportResult,
  RayTeachingImportResult,
} from '@dsh-ray/assistant-growth-contract'
export {
  RayEnergyRuntime,
  type RayEnergyBudgetCheck,
  type RayEnergyDailySnapshot,
  type RayEnergyLane,
  type RayEnergyRuntimeOptions,
  type RayGrowthEventCategory,
  type RayGrowthEventInput,
  type RayKernelGrowthReport,
} from './ray-energy-runtime.js'
export {
  RayHomeRuntime,
  defaultUserRayHome,
  resolveConfiguredRayHome,
  type RayCloneExportResult,
  type RayCloneImportResult,
  type RayMissingCredentialItem,
  type RayPluginVerifier,
  type RaySelfEvolutionInput,
  type RaySelfSnapshot,
  type RayVetoHandler,
  type RayVetoInput,
  type RayVetoResult,
} from './ray-home-runtime.js'
export { compilePolicy, evaluatePolicy } from './evaluator.js'
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
export type { AuthorizationOptions, NativeFullReviewerReconciliation, OwnerRequestedChangeContext, OwnerRequestedChangeInput, PolicyBudgetConfig, PolicyHostConfiguration, PolicyPreDispatchRollbackInput, PrincipalAuthorizationOptions } from './service.js'
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
  LeaseState,
  PreDispatchRollbackInput,
} from './ledger.js'
export {
  AUTONOMY_BUDGET_TIERS,
  AUTONOMY_DAILY_PERIOD_MS,
  AUTONOMY_INTAKE_RULE_PRESETS,
  MAX_AUTONOMY_DAILY_BUDGET,
  WEB_OWNER_POLICY_ID_PREFIX,
  buildWebOwnerDreamingPolicyGrants,
  buildWebOwnerGrowthPolicyGrants,
  buildWebOwnerIntakeEvaluationConfig,
  buildWebOwnerMemoryPolicyGrants,
  mergeAssistantPolicyGrants,
  webOwnerBudgetIds,
  webOwnerDreamingRuleIds,
  webOwnerGrowthRuleIds,
  webOwnerGrowthUsageRuleIds,
  webOwnerIntakeRuleIds,
  webOwnerMemoryRuleIds,
  webOwnerPolicyPrefix,
  type AutonomyBudgetTier,
  type AutonomyBudgetTierDefaults,
  type MergeAssistantPolicyGrantsInput,
  type MergedAssistantPolicyGrants,
  type PolicyGrantBundle,
  type WebOwnerDreamingPolicyGrantInput,
  type WebOwnerGrowthPolicyGrantInput,
  type WebOwnerIntakeEvaluationConfig,
  type WebOwnerIntakeEvaluationPresetInput,
  type WebOwnerMemoryPolicyGrantInput,
  type WebOwnerPolicyScope,
} from './autonomy-grants.js'
export {
  INTAKE_EVALUATION_LEVELS,
  INTAKE_PRESET_RULE_IDS,
  INTAKE_RULE_PRESET_CATALOG,
  INTAKE_RULE_PRESET_TIERS,
  INTAKE_RULE_PRESETS,
  MAX_INTAKE_EVALUATION_RULES,
  buildIntakeRulePreset,
  isIntakeEvaluationLevel,
  isIntakeRulePresetTier,
  isValidIntakeRuleId,
  mergeIntakeRuleUpdates,
  normalizeIntakeRuleUpdates,
  resolveIntakeEvaluationPresetRules,
  type IntakeEvaluationLevel,
  type IntakeEvaluationPresetResolutionInput,
  type IntakeEvaluationRuleSpec,
  type IntakePresetRuleId,
  type IntakePresetSourceKind,
  type IntakeRuleOverrideUpdate,
  type IntakeRulePresetEntry,
  type IntakeRulePresetTier,
} from './intake-presets.js'
export * from './types.js'

export function apply(ctx: Context, config: import('./service.js').Config): void {
  new AssistantPolicyService(ctx, config)
}

export default AssistantPolicyService
