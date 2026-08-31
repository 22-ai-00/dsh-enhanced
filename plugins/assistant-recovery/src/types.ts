export const RECOVERY_RUNBOOK_ID = 'supervised-growth/v2' as const
export const RECOVERY_RUNBOOK_VERSION = 3 as const

export type RecoveryExecutionMode = 'preview' | 'production'

export interface RecoveryTargetScope {
  workspace: string
  preset: string
}

export type RecoveryStepId =
  | 'authority-admission'
  | 'ledger-reconcile'
  | 'retention-maintenance'
  | 't1-effects'
  | 'regression-rollback'
  | 'incident-review'
  | 'verification'

export type RecoveryRunStatus = 'failed' | 'running' | 'succeeded' | 'unknown'
export type RecoveryStepStatus = 'failed' | 'noop' | 'started' | 'succeeded' | 'unknown'

export interface RecoveryRunInput {
  occurrenceId: string
  automationId: string
  definitionHash: string
  executionMode: RecoveryExecutionMode
  targetScope: RecoveryTargetScope
  principal: string
  ownerRouteId: string
  activationNonce: string
  /** SHA-256 over every authority and scheduling input approved by preview. */
  activationPlanDigest: string
  catalogDigest: string
}

export interface StoredRecoveryRun extends RecoveryRunInput {
  id: string
  status: RecoveryRunStatus
  startedAt: number
  /** Immutable wall-clock deadline calculated when the run was first inserted. */
  deadlineAt: number
  finishedAt?: number
  resultCode?: string
  version: number
}

export interface BeginRecoveryStepInput {
  runId: string
  stepId: RecoveryStepId
  action: RecoveryStepAction
  beforeDigest: string
}

/** Exact durable Delivery principal row used to fence external-id ABA reuse. */
export interface RecoveryOwnerLineage {
  principalRecordId: string
  principalVersion: number
}

/** Exact owner fence captured before one Preference retention intent is stored. */
export interface RecoveryPreferenceMaintenanceAction {
  kind: 'maintain-preferences'
  limit: 1
  /** Exact Preference scope-owner generation selected during planning. */
  ownerGeneration: number
  /** Exact Delivery owner row selected during planning. */
  principalLineage: Readonly<RecoveryOwnerLineage>
}

/**
 * Audit-only representation of a maintenance intent written before the owner
 * fence became part of the durable action contract. New intents reject this
 * shape and execution always fails closed before calling Preference.
 */
export interface LegacyRecoveryPreferenceMaintenanceAction {
  kind: 'maintain-preferences'
  limit: 1
  ownerGeneration?: never
  principalLineage?: never
}

export type RecoveryStepAction =
  | { kind: 'verify-authority' }
  | { kind: 'project-evaluation'; evaluationId: string }
  | RecoveryPreferenceMaintenanceAction
  | LegacyRecoveryPreferenceMaintenanceAction
  | {
      kind: 'activate-preference'
      hypothesisId: string
      expectedVersion: number
      /** Exact Preference scope-owner generation selected during planning. */
      ownerGeneration: number
      /** Exact Delivery owner row selected during planning. */
      principalLineage: Readonly<RecoveryOwnerLineage>
    }
  | { kind: 'rollback-evolution'; ruleId: string; expectedVersion: number }
  | {
      kind: 'probe-automation-circuit'
      automationId: string
      definitionHash: string
      expectedVersion: number
    }
  | { kind: 'verify-health' }
  | { kind: 'noop'; reasonCode: string }

export interface StoredRecoveryStep {
  runId: string
  stepId: RecoveryStepId
  idempotencyKey: string
  action: RecoveryStepAction
  actionDigest: string
  status: RecoveryStepStatus
  beforeDigest: string
  afterDigest?: string
  resultCode?: string
  startedAt: number
  /** Immutable execute/receipt deadline calculated when intent was inserted. */
  deadlineAt: number
  finishedAt?: number
  version: number
}

export interface CompleteRecoveryStepInput {
  runId: string
  stepId: RecoveryStepId
  expectedVersion: number
  status: Exclude<RecoveryStepStatus, 'started'>
  beforeDigest: string
  afterDigest: string
  resultCode: string
}

export interface RecoveryHealth {
  runningRuns: number
  failedRuns: number
  unknownRuns: number
  incompleteSteps: number
  staleRuns: number
  staleSteps: number
  lastSucceededAt: number
  lastFailedAt: number
  latestProductionStatus: 'failed' | 'none' | 'running' | 'succeeded' | 'unknown'
  consecutiveProductionFailures: number
  lastProductionRunAt: number
  bootstrapStatus: 'failed' | 'idle' | 'running' | 'succeeded'
  bootstrapFailureCode?: string
  bootstrapGeneration: number
  bootstrapAttestationValid: boolean
  bootstrapAttestationSetDigest: string
  bootstrapAttestations: readonly RecoveryBootstrapAttestation[]
  bootstrapUpdatedAt: number
}

/**
 * Content-free activation identity for one configured Recovery job. The
 * authority tuple itself is represented only by activationPlanDigest.
 */
export interface RecoveryBootstrapAttestation {
  automationId: string
  activationState: 'active' | 'paused' | 'preview'
  activationNonce: string
  activationPlanDigest: string
}

export interface RecoveryBootstrapState {
  status: RecoveryHealth['bootstrapStatus']
  failureCode?: string
  generation: number
  attestationValid: boolean
  attestationSetDigest: string
  attestations: readonly RecoveryBootstrapAttestation[]
  updatedAt: number
}
