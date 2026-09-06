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

export interface GoalStepTask {
  kind: 'goal-step'
  ref: string
  goal: { id: string; definitionVersion: number; definitionDigest: string; stepId: string; runId: string; sessionId: string; nativeGoalId: string; nativeRevision: number }
}

export interface GoalExecutionIntent {
  runId: string
  scope: GoalScope
  objective: string
  admission: { issuedAt: number; expiresAt: number; maxGoalRounds: number; round: number; authorizationDigest: string }
  task: GoalStepTask
}

export interface GoalExecutionRun {
  intent: GoalExecutionIntent
  acceptance?: { contractId: string; contractDigest: string }
  dispatchedAt?: number
  execution?: { status: 'succeeded' | 'unknown'; quiescent: boolean; completedAt: number }
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
