import { createHash } from 'node:crypto'
import type {
  ApprovalDecisionInput,
  ApprovalProposalInput,
  ApprovalProposalResult,
} from '@dsh-enhanced/assistant-policy'
import { hashMemoryMutation, MemoryStore, MemoryStoreError } from './store.js'
import type {
  MemoryMutation,
  MemoryProposalDecisionInput,
  MemoryProposalInput,
  MemoryProposalResult,
  MemoryRecord,
  StoredMemoryProposal,
} from './types.js'

export interface MemoryApprovalPolicy {
  propose(input: ApprovalProposalInput): ApprovalProposalResult
  decideProposal(input: ApprovalDecisionInput): ApprovalProposalResult
}

function deterministicProposalId(idempotencyKey: string): string {
  return `memory-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`
}

function proposalDiff(mutation: MemoryMutation): string {
  return JSON.stringify(mutation, null, 2)
}

function proposalSummary(mutation: MemoryMutation): string {
  const target = mutation.op === 'add' ? mutation.entry.kind : mutation.id
  return `${mutation.op} ${mutation.identity.owner} ${mutation.identity.scope} memory ${target}`
}

function result(
  proposal: StoredMemoryProposal,
  replayed: boolean,
  record?: MemoryRecord,
): MemoryProposalResult {
  const diff = proposalDiff(proposal.mutation)
  return Object.freeze({
    proposalId: proposal.proposalId,
    policyProposalId: proposal.policyProposalId,
    status: proposal.status,
    version: proposal.version,
    expiresAt: proposal.expiresAt,
    mutation: proposal.mutation,
    diff,
    summary: proposalSummary(proposal.mutation),
    replayed,
    ...(record === undefined ? {} : { record }),
  })
}

export class MemoryProposalManager {
  constructor(
    private readonly store: MemoryStore,
    private readonly policy: MemoryApprovalPolicy,
  ) {}

  propose(input: MemoryProposalInput): MemoryProposalResult {
    if (input.idempotencyKey.trim() === '') {
      throw new MemoryStoreError('invalid-entry', 'proposal idempotencyKey must not be empty')
    }
    const proposalId = deterministicProposalId(input.idempotencyKey)
    const existing = this.store.getProposal(proposalId)
    const mutation = this.store.normalizeMutation(input.mutation, { preflight: existing === undefined })
    const diff = proposalDiff(mutation)
    const mutationHash = hashMemoryMutation(mutation)
    const policyProposal = this.policy.propose({
      idempotencyKey: `personal-memory:${input.idempotencyKey}`,
      requester: input.requester,
      principal: input.principal,
      action: `memory.${mutation.op}`,
      resource: { kind: 'memory', id: proposalId },
      diff,
      summary: proposalSummary(mutation),
      ttlMs: input.ttlMs,
    })
    const saved = this.store.saveProposal({
      proposalId,
      policyProposalId: policyProposal.proposalId,
      idempotencyKey: input.idempotencyKey,
      requester: input.requester,
      principal: input.principal,
      mutation,
      mutationHash,
      expiresAt: policyProposal.expiresAt,
      version: policyProposal.version,
    })
    return result(saved.proposal, policyProposal.replayed || saved.replayed)
  }

  decide(input: MemoryProposalDecisionInput): MemoryProposalResult {
    const proposal = this.store.getProposal(input.proposalId)
    if (proposal === undefined) throw new MemoryStoreError('not-found', 'memory proposal was not found')
    const decision = this.policy.decideProposal({
      proposalId: proposal.policyProposalId,
      principal: input.principal,
      expectedVersion: input.expectedVersion,
      decision: input.decision,
      reason: input.reason,
    })
    if (decision.status === 'pending') {
      throw new Error('assistant-policy returned pending for a completed proposal decision')
    }
    const settled = this.store.settleProposal({
      proposalId: input.proposalId,
      policyStatus: decision.status,
      policyVersion: decision.version,
    })
    return result(settled.proposal, decision.replayed || settled.replayed, settled.record)
  }

  getProposal(proposalId: string): MemoryProposalResult | undefined {
    const proposal = this.store.getProposal(proposalId)
    return proposal === undefined ? undefined : result(proposal, true)
  }
}
