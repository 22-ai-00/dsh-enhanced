import type { ApprovalDispatchRoute } from '@dsh-enhanced/assistant-policy'
import type {
  PreferenceMemoryPromotionCancellationReceipt,
  PreferenceMemoryPromotionCancellationRequest,
} from '@dsh-enhanced/assistant-growth-contract'

export type MemoryOwner = 'agent' | 'user'
export type MemoryScope = 'user-global' | 'workspace'
export type MemoryKind = 'experience' | 'fact' | 'instruction' | 'preference'
export type MemorySensitivity = 'private' | 'sensitive'
export type MemoryTrust = 'agent-observed' | 'external' | 'user-confirmed'
export type MemoryStatus = 'active' | 'removed'

/**
 * Host-attested durable owner identity. This value is deliberately separate
 * from MemoryIdentity: models may choose a semantic memory domain, but never
 * the principal lineage that owns it.
 */
export type MemoryOwnerNamespace =
  | Readonly<{
    mode: 'delivery'
    /** SHA-256 of Delivery's canonical external principal id. */
    principalDigest: string
    /** Immutable Delivery principal-row identity. */
    principalRecordId: string
    /** Exact Delivery principal-row version. */
    principalVersion: number
  }>
  | Readonly<{
    mode: 'headless'
    /** SHA-256 of the trusted Host principal, never supplied by a model. */
    principalDigest: string
    /** Host-controlled durable lineage, disjoint from Delivery identities. */
    lineageId: string
    lineageVersion: number
  }>

export interface MemoryIdentity {
  owner: MemoryOwner
  scope: MemoryScope
  workspace?: string
  agentPreset?: string
}

export interface MemoryProvenance {
  source: string
  observedAt: number
  uri?: string
}

export interface MemoryEntryInput {
  kind: MemoryKind
  content: string
  sensitivity: MemorySensitivity
  trust: MemoryTrust
  confidence: number
  provenance: MemoryProvenance
  expiresAt?: number
  supersedes?: string
}

export interface MemoryRecord extends MemoryEntryInput, MemoryIdentity {
  namespace: MemoryOwnerNamespace
  id: string
  contentHash: string
  status: MemoryStatus
  createdAt: number
  updatedAt: number
  version: number
}

export interface MemoryAgentContext {
  workspace: string
  agentPreset: string
  namespace: MemoryOwnerNamespace
}

export interface MemorySearchRequest {
  context: MemoryAgentContext
  query: string
  limit?: number
  /** Optional Host-side filters. Model-facing callers cannot choose these. */
  kinds?: readonly MemoryKind[]
  trusts?: readonly MemoryTrust[]
  sensitivities?: readonly MemorySensitivity[]
}

export interface MemorySearchHit {
  record: MemoryRecord
  score: number
  matchedTokens: readonly string[]
}

export interface MemorySnapshotRequest {
  context: MemoryAgentContext
  limit: number
  maxBytes: number
  maxTokens: number
}

export interface MemorySnapshot {
  records: readonly MemoryRecord[]
  text: string
  bytes: number
  tokens: number
}

export type MemoryMutation =
  | {
    op: 'add'
    identity: MemoryIdentity
    entry: MemoryEntryInput
  }
  | {
    op: 'replace'
    identity: MemoryIdentity
    id: string
    expectedVersion: number
    entry: MemoryEntryInput
  }
  | {
    op: 'remove'
    identity: MemoryIdentity
    id: string
    expectedVersion: number
  }

export type ApprovedMemoryMutation = MemoryMutation & {
  idempotencyKey: string
  namespace: MemoryOwnerNamespace
}

export type MemoryProposalStatus = 'approved' | 'conflicted' | 'expired' | 'pending' | 'rejected'

export interface MemoryPromotionReference {
  promotionId: string
  promotionGeneration: number
  requestDigest: string
  scope: Readonly<{ workspace: string; preset: string }>
  /** Approval-time fence; deliberately not part of the durable Memory namespace. */
  ownerGeneration: number
  /** Durable marker for a request rejected before a Policy row could be created. */
  prePolicyStatus?: 'expired' | 'stale-owner'
}

export interface MemoryProposalInput {
  idempotencyKey: string
  requester: string
  principal: string
  namespace: MemoryOwnerNamespace
  dispatch?: Readonly<ApprovalDispatchRoute>
  ttlMs: number
  /** Absolute deadline fixed before durable proposal identity is derived. */
  notAfter?: number
  /** Trusted Host correlation; never accepted from a model-facing mutation. */
  promotion?: Readonly<MemoryPromotionReference>
  mutation: MemoryMutation
}

export interface MemoryProposalDecisionInput {
  proposalId: string
  principal: string
  expectedVersion: number
  decision: 'approved' | 'rejected'
  reason: string
}

export interface MemoryProposalResult {
  proposalId: string
  policyProposalId: string
  status: MemoryProposalStatus
  version: number
  expiresAt: number
  mutation: MemoryMutation
  diff: string
  summary: string
  replayed: boolean
  record?: MemoryRecord
}

export interface StoredMemoryProposal {
  proposalId: string
  policyProposalId: string
  idempotencyKey: string
  requester: string
  principal: string
  namespace: MemoryOwnerNamespace
  mutationHash: string
  mutation: MemoryMutation
  status: MemoryProposalStatus
  notAfter: number
  expiresAt: number
  version: number
  resultMemoryId?: string
  promotion?: Readonly<MemoryPromotionReference>
}

export interface StoredMemoryProposalIntent extends Omit<MemoryProposalInput, 'notAfter'> {
  proposalId: string
  mutationHash: string
  notAfter: number
  createdAt: number
  updatedAt: number
}

export type MemoryPromotionResultStatus =
  | 'confirmed'
  | 'conflicted'
  | 'expired'
  | 'rejected'
  | 'stale-owner'

export interface MemoryPromotionSettlement extends MemoryPromotionReference {
  /** Used only when an owner-lineage fence terminally conflicts the proposal. */
  statusOverride?: 'expired' | 'stale-owner'
}

/** Durable terminal projection consumed by the Preference promotion bridge. */
export interface StoredMemoryPromotionResult extends MemoryPromotionSettlement {
  contractVersion: 1
  namespace: MemoryOwnerNamespace
  resultVersion: number
  status: MemoryPromotionResultStatus
  memoryProposalId: string
  memoryProposalVersion: number
  occurredAt: number
  receiptDigest: string
  memoryRecordId?: string
  memoryRecordVersion?: number
  memoryRecordDigest?: string
  state: 'completed' | 'pending'
  attemptCount: number
  updatedAt: number
}

export interface MemoryPromotionCancellationResult {
  outcome: PreferenceMemoryPromotionCancellationReceipt['outcome']
  receipt: Readonly<PreferenceMemoryPromotionCancellationReceipt>
}

export type MemoryPromotionCancellationInput =
  Readonly<PreferenceMemoryPromotionCancellationRequest>

export interface MemoryExportRecord {
  identity: MemoryIdentity
  entry: MemoryEntryInput
}

export interface MemoryExportDocument {
  format: 'dsh-personal-memory'
  version: 1
  records: readonly MemoryExportRecord[]
}

export interface MemoryImportBatchResult {
  proposals: readonly MemoryProposalResult[]
}
