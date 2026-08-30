import type { AutomationSchedule } from './schedule.js'
import type { ApprovalDispatchRoute } from '@dsh-enhanced/assistant-policy'

export type MisfirePolicy =
  | { kind: 'skip' }
  | { kind: 'latest' }
  | { kind: 'bounded-replay'; limit: number }

export type OverlapPolicy = 'cancel-previous' | 'queue-one' | 'skip'
export type RetrySafety = 'idempotent' | 'never'
export type AutomationStatus = 'active' | 'deleted' | 'paused'

export interface AutomationDefinition {
  name: string
  prompt: string
  schedule: AutomationSchedule
  workspace: string
  agentPreset: string
  provider: string
  model: string
  allowedTools: readonly string[]
  timeoutMs: number
  maxOutputTokens: number
  maxToolCalls: number
  misfire: MisfirePolicy
  overlap: OverlapPolicy
  retrySafety: RetrySafety
  maxRetries: number
  principal: string
  budgetId?: string
  budgetAmount?: number
  deliveryBindingId?: string
  deliverySuppressExact?: readonly string[]
}

export interface AutomationRecord {
  id: string
  owner?: string
  definition: AutomationDefinition
  status: AutomationStatus
  nextRunAt: number | undefined
  createdAt: number
  updatedAt: number
  version: number
}

export type OccurrenceTriggerKind = 'external' | 'manual' | 'scheduled'
export type OccurrenceStatus =
  | 'cancelled'
  | 'failed'
  | 'pending'
  | 'skipped'
  | 'succeeded'
  | 'timed_out'
  | 'unknown'

export interface AutomationOccurrence {
  id: string
  automationId: string
  triggerKind: OccurrenceTriggerKind
  triggerKey: string
  scheduledAt: number
  status: OccurrenceStatus
  reason?: string
  dryRun: boolean
  createdAt: number
  updatedAt: number
}

export type AutomationTaskStatus =
  | 'cancelled'
  | 'claimed'
  | 'failed'
  | 'lost'
  | 'running'
  | 'scheduled'
  | 'succeeded'
  | 'timed_out'
  | 'unknown'

export interface AutomationTask {
  id: string
  occurrenceId: string
  automationId: string
  status: AutomationTaskStatus
  cancelRequested: boolean
  claimedBy?: string
  fencingToken?: number
  leaseUntil?: number
  attemptCount: number
  createdAt: number
  updatedAt: number
}

export interface DutyLease {
  acquired: boolean
  ownerId: string
  fencingToken: number
  leaseUntil: number
}

export type AutomationRunStatus = 'cancelled' | 'failed' | 'succeeded' | 'timed_out' | 'unknown'
export type AutomationDeliveryStatus = 'enqueued' | 'pending' | 'suppressed'
export type AutomationEvidenceStatus = 'pending' | 'recorded' | 'suppressed'
export type AutomationEvaluationStatus = 'pending' | 'recorded' | 'dead-letter'

/**
 * Frozen terminal observation written to the Evaluation outbox in the same
 * transaction as its Automation run.  This intentionally mirrors the public
 * assistant-evaluation append seam without importing that optional plugin.
 */
export interface AutomationEvaluationOutcome {
  scope: { workspace: string; preset: string }
  situation: string
  executionStatus: 'succeeded' | 'failed' | 'timed-out' | 'cancelled' | 'unknown'
  objectiveStatus: 'unknown'
  deliveryStatus: 'not-required' | 'unknown'
  source: { kind: 'automation'; id: 'assistant-automations' }
  trust: 'trusted'
  evidence: ReadonlyArray<{ kind: string; ref: string; digest?: string }>
  metrics: Readonly<Record<string, number>>
  occurredAt: number
  idempotencyKey: string
  evaluator: { id: 'assistant-automations'; version: 'terminal-v1' }
}

export interface AutomationEvaluationOutboxEntry {
  id: string
  runId: string
  kind: 'terminal'
  status: AutomationEvaluationStatus
  payload: AutomationEvaluationOutcome
  attemptCount: number
  nextAttemptAt: number
  lastFailureAt?: number
  /** Bounded machine-readable category only; never an exception message. */
  lastErrorCode?: string
  createdAt: number
  updatedAt: number
}

/**
 * Immutable evidence captured in the same transaction as a terminal run.
 *
 * The automation id is the stable learning situation. The human-editable name
 * appears only in `detail`, so renaming a schedule cannot split its history.
 */
export interface AutomationOutcomeEvidence {
  situation: string
  outcome: 'succeeded' | 'failed'
  detail: string
  idempotencyKey: string
  occurredAt: number
  workspace: string
  agentPreset: string
  automationId: string
  runId: string
  /** Present only when the runner confirmed the Agent session it created. */
  sessionId?: string
  /** Trusted infrastructure attribution read from a durable post-injection receipt. */
  ruleId?: string
  guidanceVersion?: number
}

export interface AutomationEvidenceAttribution {
  sessionId?: string
  ruleId?: string
  guidanceVersion?: number
}

export interface AutomationRun {
  id: string
  occurrenceId: string
  automationId: string
  taskId: string
  attemptId: string
  status: AutomationRunStatus
  sessionId?: string
  artifactRef?: string
  outputPreview: string
  usage: Readonly<Record<string, unknown>>
  deliveryStatus?: AutomationDeliveryStatus
  deliveryRef?: string
  evidenceStatus: AutomationEvidenceStatus
  evidence?: AutomationOutcomeEvidence
  createdAt: number
  updatedAt: number
}

export type AutomationMutation =
  | { op: 'create'; automationId: string; definition: AutomationDefinition }
  | { op: 'delete' | 'pause' | 'resume'; automationId: string; expectedVersion: number }

export type AutomationProposalStatus = 'approved' | 'conflicted' | 'expired' | 'pending' | 'rejected'

export interface StoredAutomationProposal {
  proposalId: string
  policyProposalId?: string
  idempotencyKey: string
  requester: string
  principal: string
  dispatch?: Readonly<ApprovalDispatchRoute>
  requestHash: string
  changeHash: string
  mutation: AutomationMutation
  status: AutomationProposalStatus
  expiresAt: number
  ttlMs: number
  createdAt: number
  version: number
  resultAutomationId?: string
}

export interface AutomationProposalInput {
  idempotencyKey: string
  requester: string
  principal: string
  dispatch?: Readonly<ApprovalDispatchRoute>
  ttlMs: number
  mutation: AutomationMutation
}

export interface AutomationProposalDecisionInput {
  proposalId: string
  principal: string
  expectedVersion: number
  decision: 'approved' | 'rejected'
  reason: string
}

export interface AutomationProposalResult {
  proposalId: string
  policyProposalId?: string
  status: AutomationProposalStatus
  version: number
  expiresAt: number
  mutation: AutomationMutation
  diff: string
  summary: string
  replayed: boolean
  automation?: AutomationRecord
}
