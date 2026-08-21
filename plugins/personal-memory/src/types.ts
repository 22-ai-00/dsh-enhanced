export type MemoryOwner = 'agent' | 'user'
export type MemoryScope = 'user-global' | 'workspace'
export type MemoryKind = 'experience' | 'fact' | 'instruction' | 'preference'
export type MemorySensitivity = 'private' | 'sensitive'
export type MemoryTrust = 'agent-observed' | 'external' | 'user-confirmed'
export type MemoryStatus = 'active' | 'removed'

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
}

export interface MemorySearchRequest {
  context: MemoryAgentContext
  query: string
  limit?: number
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

export type ApprovedMemoryMutation = MemoryMutation & { idempotencyKey: string }

export type MemoryProposalStatus = 'approved' | 'conflicted' | 'expired' | 'pending' | 'rejected'

export interface MemoryProposalInput {
  idempotencyKey: string
  requester: string
  principal: string
  ttlMs: number
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
  mutationHash: string
  mutation: MemoryMutation
  status: MemoryProposalStatus
  expiresAt: number
  version: number
  resultMemoryId?: string
}

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
