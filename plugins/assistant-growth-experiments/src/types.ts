import type {
  WorkflowAutomationTemplate,
  WorkflowScope,
  WorkflowStepFingerprint,
} from '@dsh-enhanced/assistant-growth-contract'

// The wire protocol has one owner. Re-exporting the shared contract keeps this
// package convenient to consume without maintaining a second, drifting copy.
export * from '@dsh-enhanced/assistant-growth-contract'

export type WorkflowCandidateState =
  | 'conflicted'
  | 'observing'
  | 'promoted'
  | 'ready'
  | 'rejected'
  | 'retracted'
  | 'rolled-back'
  | 'running'

export interface WorkflowCandidate {
  id: string
  scope: Readonly<WorkflowScope>
  ownerBindingId: string
  signature: string
  revision: number
  evidenceDigest: string
  evidenceCount: number
  ownerExplicitCount: number
  verifiedSuccessCount: number
  template: Readonly<WorkflowAutomationTemplate>
  steps: readonly Readonly<WorkflowStepFingerprint>[]
  state: WorkflowCandidateState
  createdAt: number
  updatedAt: number
}

export type WorkflowCandidateSnapshot = Readonly<Pick<WorkflowCandidate,
  'id' | 'scope' | 'ownerBindingId' | 'signature' | 'revision' | 'evidenceDigest' | 'evidenceCount'
  | 'ownerExplicitCount' | 'verifiedSuccessCount' | 'template' | 'steps'>>

export type GrowthExperimentState =
  | 'approval-pending'
  | 'approval-requesting'
  | 'canary-pending'
  | 'conflicted'
  | 'expired'
  | 'promoted'
  | 'promotion-pending'
  | 'rejected'
  | 'replay-pending'
  | 'rollback-pending'
  | 'rolled-back'
  | 'shadow-pending'

export type GrowthOperationKind =
  | 'approval-proposal'
  | 'approval-settlement'
  | 'canary'
  | 'canary-inspection'
  | 'promotion'
  | 'replay'
  | 'rollback'
  | 'shadow'

export interface GrowthExperiment {
  id: string
  candidateId: string
  candidateRevision: number
  candidateDigest: string
  candidateSnapshot: WorkflowCandidateSnapshot
  state: GrowthExperimentState
  version: number
  operationId: string
  operationKind?: GrowthOperationKind
  deadlineAt: number
  canaryExposureCount: number
  attemptCount: number
  nextAttemptAt: number
  proposalId?: string
  artifactId?: string
  artifactVersion?: number
  artifactDigest?: string
  terminalCode?: string
  createdAt: number
  updatedAt: number
}

export interface GrowthExperimentConfig {
  databasePath: string
  tickIntervalMs?: number
  minRepeatedSuccesses?: number
  maxBatchSize?: number
  maxExperimentDurationMs?: number
  maxOperationAttempts?: number
  retryBaseMs?: number
  retryMaxMs?: number
}

export interface GrowthExperimentHealth {
  candidates: number
  readyCandidates: number
  activeExperiments: number
  rollbackPending: number
  promoted: number
  traceRevisions: number
  currentTraces: number
  exhaustedRollbacks: number
  lastErrorCode?: string
}
