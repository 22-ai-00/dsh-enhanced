import type { EvaluationCanonicalLearningEvidenceTuple } from '@dsh-enhanced/assistant-evaluation'
import type { SourceJobOwnerReceipt } from './source-job-types.js'
import type { SourceApprovalClientConfig } from './source-approval-client.js'
import type { PostActivationObservationReceipt } from './types.js'

export type TaskObservationOwner = Pick<SourceJobOwnerReceipt, 'authorityId' | 'authorityHash' | 'principalId'
  | 'principalRecordId' | 'principalVersion' | 'workspace' | 'agentPreset'>

export interface TaskObservationPolicy {
  id: string
  expiresAt: number
  maximumObservations: number
  minimumChecks: number
  maximumChecks: number
  lookbackMs: number
}

export interface TaskObservationConfig {
  policy: TaskObservationPolicy
  scope: { ownerRouteId: string; principalId: string; workspace: string; preset: string }
  profilePath: string
  timeoutMs: number
  authority: SourceApprovalClientConfig
}

/** Facts reread from trusted Delivery/Evaluation, never an Agent's rating. */
export interface TaskObservationVote {
  inboxId: string
  outcomeId: string
  projection: EvaluationCanonicalLearningEvidenceTuple
  sourceDigest: string
  deploymentDigest: string
  status: 'achieved' | 'not-achieved'
  completedAt: number
}

export interface TaskObservationBatch {
  schemaVersion: 1
  kind: 'dsh-task-observation'
  id: string
  digest: string
  lane: string
  configDigest: string
  trustDigest: string
  planId: string
  planDigest: string
  installationId: string
  profilePath: string
  owner: TaskObservationOwner
  policy: TaskObservationPolicy
  hostGeneration: number
  votes: readonly TaskObservationVote[]
  createdAt: number
  expiresAt: number
}

export interface TaskObservationRecord {
  batch: TaskObservationBatch
  state: 'pending' | 'signed' | 'applied' | 'stale'
  receipt?: PostActivationObservationReceipt
}

export interface TaskObservationRequest {
  protocol: 'dsh-task-observation/v1'
  observationId: string
  observationDigest: string
}
