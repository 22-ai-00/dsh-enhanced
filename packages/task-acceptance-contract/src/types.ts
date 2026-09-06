export interface AcceptanceJsonObject { readonly [key: string]: AcceptanceJsonValue }
export type AcceptanceJsonValue = null | boolean | number | string
  | readonly AcceptanceJsonValue[] | AcceptanceJsonObject

export interface AuthorityRef { readonly id: string; readonly digest: string }
export interface ProcessBehaviorCriterion {
  readonly id: string; readonly kind: 'process-behavior'; readonly authority: AuthorityRef
  readonly artifactPath: string; readonly stdin: string; readonly expectedStdout: string
  readonly expectedExitCode: number
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
export type AcceptanceCriterion = ProcessBehaviorCriterion | DocumentCitationsCriterion | TargetReadbackCriterion
export interface TaskAcceptanceContractInput {
  readonly protocol: 'task-acceptance/v1'; readonly id: string
  readonly scope: Readonly<{ workspace: string; preset: string }>
  readonly owner: Readonly<{ principalRecordId: string; principalVersion: number }>
  readonly task: Readonly<{ kind: 'automation-run' | 'foreground-turn'; ref: string }>
  readonly objective: string
  readonly profile: Readonly<{ id: string; version: number; digest: string }>
  readonly issuedAt: number; readonly expiresAt: number; readonly criteria: readonly AcceptanceCriterion[]
  readonly bounds: Readonly<{ maxDurationMs: number; maxEvidenceBytes: number }>
}
export interface TaskAcceptanceContract extends TaskAcceptanceContractInput { readonly digest: string }
export interface CriterionResult {
  readonly criterionId: string; readonly status: 'passed' | 'failed' | 'unknown'; readonly reason: string
  readonly evidence: readonly Readonly<{ kind: string; ref: string; digest: string }>[]; readonly artifactDigest?: string
}
export interface TaskVerificationReceiptInput {
  readonly protocol: 'task-verification/v1'; readonly id: string; readonly contractId: string; readonly contractDigest: string
  readonly scope: Readonly<{ workspace: string; preset: string }>
  readonly owner: Readonly<{ principalRecordId: string; principalVersion: number }>
  readonly task: Readonly<{ kind: 'automation-run' | 'foreground-turn'; ref: string }>
  readonly results: readonly CriterionResult[]; readonly startedAt: number; readonly completedAt: number; readonly validUntil: number
}
export interface TaskVerificationReceipt extends TaskVerificationReceiptInput {
  readonly objectiveStatus: 'achieved' | 'not-achieved' | 'unknown'; readonly digest: string
}
