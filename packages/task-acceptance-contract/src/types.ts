export interface AcceptanceJsonObject { readonly [key: string]: AcceptanceJsonValue }
export type AcceptanceJsonValue = null | boolean | number | string
  | readonly AcceptanceJsonValue[] | AcceptanceJsonObject

export interface AuthorityRef { readonly id: string; readonly digest: string }
export interface ProcessBehaviorCriterion {
  readonly id: string; readonly kind: 'process-behavior'; readonly authority: AuthorityRef
  readonly artifactPath: string; readonly stdin: string; readonly expectedStdout: string
  readonly expectedExitCode: number
}
export interface IsolatedProcessBehaviorCriterion {
  readonly id: string; readonly kind: 'isolated-process-behavior'; readonly authority: AuthorityRef
  readonly artifactPath: string; readonly testSetId: string
}
export interface DocumentCitationsCriterion {
  readonly id: string; readonly kind: 'document-citations'; readonly authority: AuthorityRef
  readonly artifactPath: string; readonly requiredText: readonly string[]
  readonly quotes: readonly Readonly<{ quote: string; sourceId: string; sourceSha256: string }>[]
}
export interface TargetReadbackCriterion {
  readonly id: string; readonly kind: 'target-readback'; readonly authority: AuthorityRef
  readonly objectId: string; readonly expected: readonly Readonly<{ pointer: string; value: AcceptanceJsonValue }>[]
  readonly expectedRevision?: string
}
export type AcceptanceCriterion = ProcessBehaviorCriterion | IsolatedProcessBehaviorCriterion | DocumentCitationsCriterion | TargetReadbackCriterion
export interface GoalStepBinding {
  readonly id: string; readonly definitionVersion: number; readonly definitionDigest: string
  readonly stepId: string; readonly runId: string; readonly sessionId: string
  readonly nativeGoalId: string; readonly nativeRevision: number
}
export interface GoalOutcomeBinding {
  readonly id: string; readonly definitionVersion: number; readonly definitionDigest: string
  readonly assessmentId: string; readonly sessionId: string; readonly nativeGoalId: string
}
export type AcceptanceTaskIdentity =
  | Readonly<{ kind: 'automation-run' | 'foreground-turn'; ref: string }>
  | Readonly<{ kind: 'goal-step'; ref: string; goal: GoalStepBinding }>
  | Readonly<{ kind: 'goal-outcome'; ref: string; goal: GoalOutcomeBinding }>

interface TaskAcceptanceContractBase {
  readonly id: string
  readonly scope: Readonly<{ workspace: string; preset: string }>
  readonly owner: Readonly<{ principalRecordId: string; principalVersion: number }>
  readonly objective: string
  readonly profile: Readonly<{ id: string; version: number; digest: string }>
  readonly issuedAt: number; readonly expiresAt: number; readonly criteria: readonly AcceptanceCriterion[]
  readonly bounds: Readonly<{ maxDurationMs: number; maxEvidenceBytes: number }>
}
export interface TaskAcceptanceContractV1Input extends TaskAcceptanceContractBase {
  readonly protocol: 'task-acceptance/v1'; readonly id: string
  readonly task: Readonly<{ kind: 'automation-run' | 'foreground-turn'; ref: string }>
}
export interface TaskAcceptanceContractV2Input extends TaskAcceptanceContractBase {
  readonly protocol: 'task-acceptance/v2'
  readonly task: Readonly<{ kind: 'goal-step'; ref: string; goal: GoalStepBinding }>
}
export interface TaskAcceptanceContractV3Input extends TaskAcceptanceContractBase {
  readonly protocol: 'task-acceptance/v3'
  readonly task: Readonly<{ kind: 'goal-outcome'; ref: string; goal: GoalOutcomeBinding }>
}
export interface TaskAcceptanceContractV4Input extends TaskAcceptanceContractBase {
  readonly protocol: 'task-acceptance/v4'
  readonly task: Readonly<{ kind: 'goal-step'; ref: string; goal: GoalStepBinding }> | Readonly<{ kind: 'goal-outcome'; ref: string; goal: GoalOutcomeBinding }>
  readonly criteria: readonly IsolatedProcessBehaviorCriterion[]
}
export type TaskAcceptanceContractInput = TaskAcceptanceContractV1Input | TaskAcceptanceContractV2Input | TaskAcceptanceContractV3Input | TaskAcceptanceContractV4Input
export type TaskAcceptanceContract = TaskAcceptanceContractInput & Readonly<{ digest: string }>
export interface CriterionResult {
  readonly criterionId: string; readonly status: 'passed' | 'failed' | 'unknown'; readonly reason: string
  readonly evidence: readonly Readonly<{ kind: string; ref: string; digest: string }>[]; readonly artifactDigest?: string
}
interface TaskVerificationReceiptBase {
  readonly id: string; readonly contractId: string; readonly contractDigest: string
  readonly scope: Readonly<{ workspace: string; preset: string }>
  readonly owner: Readonly<{ principalRecordId: string; principalVersion: number }>
  readonly results: readonly CriterionResult[]; readonly startedAt: number; readonly completedAt: number; readonly validUntil: number
}
export interface TaskVerificationReceiptV1Input extends TaskVerificationReceiptBase {
  readonly protocol: 'task-verification/v1'; readonly id: string; readonly contractId: string; readonly contractDigest: string
  readonly task: Readonly<{ kind: 'automation-run' | 'foreground-turn'; ref: string }>
}
export interface TaskVerificationReceiptV2Input extends TaskVerificationReceiptBase {
  readonly protocol: 'task-verification/v2'
  readonly task: Readonly<{ kind: 'goal-step'; ref: string; goal: GoalStepBinding }>
}
export interface TaskVerificationReceiptV3Input extends TaskVerificationReceiptBase {
  readonly protocol: 'task-verification/v3'
  readonly task: Readonly<{ kind: 'goal-outcome'; ref: string; goal: GoalOutcomeBinding }>
}
export interface TaskVerificationReceiptV4Input extends TaskVerificationReceiptBase {
  readonly protocol: 'task-verification/v4'
  readonly task: Readonly<{ kind: 'goal-step'; ref: string; goal: GoalStepBinding }> | Readonly<{ kind: 'goal-outcome'; ref: string; goal: GoalOutcomeBinding }>
}
export type TaskVerificationReceiptInput = TaskVerificationReceiptV1Input | TaskVerificationReceiptV2Input | TaskVerificationReceiptV3Input | TaskVerificationReceiptV4Input
export type TaskVerificationReceipt = TaskVerificationReceiptInput & Readonly<{ objectiveStatus: 'achieved' | 'not-achieved' | 'unknown'; digest: string }>
export interface GoalArtifactAdmission {
  readonly protocol: 'goal-artifact-admission/v1'
  readonly contractId: string
  readonly contractDigest: string
  readonly runId: string
  readonly turn: number
}
