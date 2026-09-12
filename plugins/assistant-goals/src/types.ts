export interface GoalScope {
  principalId: string
  principalRecordId: string
  principalVersion: number
  workspace: string
  preset: string
}

export interface NativeGoalState {
  sessionId: string
  goalId: string
  revision: number
  objective: string
  phase: 'active' | 'paused' | 'blocked' | 'complete' | 'cleared'
  roundsStarted: number
  maxGoalRounds: number
  updatedAt: number
}

export interface GoalCheckpoint {
  nextStep: string
  blockers: readonly string[]
  assumptions: readonly { statement: string; expiresAt: number }[]
  evidenceRefs: readonly string[]
  dependencies: readonly string[]
  /** Host-frozen identities. Missing with non-empty dependencies means a legacy unresolved checkpoint. */
  dependencyBindings?: readonly GoalDependencyBinding[]
}

export interface GoalDependencyBinding {
  goalId: string
  definitionVersion: number
  definitionDigest: string
}

export type GoalDependencyStatus = 'achieved' | 'pending' | 'failed' | 'unknown' | 'cleared' | 'stale'

export interface GoalDependencyView {
  goalId: string
  definitionVersion?: number
  definitionDigest?: string
  status: GoalDependencyStatus
  reason?: 'definition-changed' | 'legacy-unbound'
  nativePhase?: NativeGoalState['phase']
}

/** Immutable semantic definition; native lifecycle revisions do not advance it. */
export interface GoalDefinition {
  version: number
  digest: string
  objective: string
}

export interface GoalRecord {
  id: string
  scope: GoalScope
  originalObjective: string
  definition: GoalDefinition
  native: NativeGoalState
  checkpoint: GoalCheckpoint
  version: number
  createdAt: number
  updatedAt: number
}

/** Read-only host context for task-scoped consumers; checkpoint text is planning, never trusted fact. */
export interface GoalTaskContext {
  protocol: 'goal-task-context/v1'
  scope: GoalScope
  active: boolean
  goal: { id: string; definition: { version: number; digest: string }; native: NativeGoalState; objective: string }
  checkpoint: { nextStep: string; dependencies?: readonly GoalDependencyView[] }
}

export interface GoalStepTask {
  kind: 'goal-step'
  ref: string
  goal: { id: string; definitionVersion: number; definitionDigest: string; stepId: string; runId: string; sessionId: string; nativeGoalId: string; nativeRevision: number }
}

export interface GoalExecutionIntent {
  runId: string
  scope: GoalScope
  objective: string
  /** Optional only for persisted pre-v3 runs; new runs always bind this list. */
  dependencies?: readonly GoalDependencyBinding[]
  admission: { issuedAt: number; expiresAt: number; maxGoalRounds: number; round: number; authorizationDigest: string }
  task: GoalStepTask
}

export interface GoalExecutionRun {
  intent: GoalExecutionIntent
  acceptance?: { contractId: string; contractDigest: string }
  dispatchedAt?: number
  execution?: { status: 'succeeded' | 'unknown'; quiescent: boolean; completedAt: number }
}

/** Exact Host route input for a post-quiescence evidence read; never model-visible. */
export interface OwnerGoalExecutionSnapshotInput {
  ownerRouteId: string
  principalId: string
  workspace: string
  preset: string
  sessionId: string
  goalId: string
}

/** Exact Host route and durable run selected for a raw native trace read. */
export interface OwnerGoalRunProofInput extends OwnerGoalExecutionSnapshotInput {
  runId: string
}

/** Integrity-bound native call trace. Trust comes from the current Host-only service capability, not this public digest. */
export interface OwnerGoalRunProof {
  protocol: 'assistant-goals/owner-run-trace/v1'
  runId: string
  turn: number
  nativeRevision: number
  definitionDigest: string
  outcomeProfile: { id: string; version: number; digest: string }
  steps: readonly { id: string; name: string; arguments: unknown; outcome: 'succeeded' | 'failed' }[]
  traceDigest: string
}

export type { OwnerGoalOutcomeFeedbackLocator, OwnerGoalOutcomeFeedbackProof } from '@dsh-enhanced/assistant-delivery'

export interface OwnerFailureCaptureSummaryInput {
  ownerRouteId: string
  principalId: string
  workspace: string
  preset: string
  taskFamilyId: string
  repair: { sessionId: string; goalId: string }
  failures: readonly { sessionId: string; goalId: string }[]
  minimumOccurrences: number
}

export interface FailureCaptureGoalIdentity {
  id: string
  definition: { version: number; digest: string; objective: string }
  sessionId: string
  nativeGoalId: string
}

export interface HostFailureEvidenceObservation {
  goal: FailureCaptureGoalIdentity
  runId: string
  execution: { status: 'succeeded'; quiescent: true }
  outcome: 'not-achieved'
  acceptance: { contractId: string; contractDigest: string; receiptDigest: string; verifiedAt: number; validUntil: number }
  traceDigest: string
}

/** Public digest is only an integrity link; provenance requires the current Host-only Goals capability. */
export interface HostFailureEvidenceSummary {
  protocol: 'assistant-skills/host-failure-evidence/v1'
  scope: GoalScope
  taskFamily: { id: string; definitionDigest: string; objective: string }
  failureCategory: 'objective-not-achieved' | 'repeated-not-achieved'
  triggerCondition: { kind: 'not-achieved-count'; minimumOccurrences: number; windowStartedAt: number; windowEndedAt: number }
  failures: readonly HostFailureEvidenceObservation[]
  repairGoal: FailureCaptureGoalIdentity
  attestedAt: number
  evidence: { producer: 'assistant-goals'; generation: string; digest: string }
}

/** Owner-authorized lifecycle change for the currently bound native goal. */
export interface GoalControlInput {
  goalId: string
  expectedRevision: number
  operation: 'edit' | 'pause' | 'resume' | 'clear'
  objective?: string
  maxGoalRounds?: number
}

export type GoalStoreErrorCode =
  | 'conflict'
  | 'invalid-input'
  | 'not-found'
  | 'schema'
  | 'unsafe-file'

/** An intentionally non-descriptive error for owner-scoped ledger operations. */
export class GoalStoreError extends Error {
  constructor(readonly code: GoalStoreErrorCode) {
    super('goal store operation rejected')
    this.name = 'GoalStoreError'
  }
}
