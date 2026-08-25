import { createHash } from 'node:crypto'
import {
  ApprovalSettlementConflict,
  validateApprovalSettlement,
  type ApprovalDecisionInput,
  type ApprovalProposalLookupInput,
  type ApprovalProposalInput,
  type ApprovalProposalRecoveryInput,
  type ApprovalProposalRecoveryResult,
  type ApprovalProposalResult,
  type ApprovalProposalSnapshot,
} from '@dsh-enhanced/assistant-policy'
import {
  hashMemoryMutation,
  isMissingPolicyProposalId,
  MemoryStore,
  MemoryStoreError,
  missingPolicyProposalId,
} from './store.js'
import type {
  MemoryMutation,
  MemoryProposalDecisionInput,
  MemoryProposalInput,
  MemoryProposalResult,
  MemoryRecord,
  StoredMemoryProposal,
  StoredMemoryProposalIntent,
} from './types.js'

export interface MemoryApprovalPolicy {
  propose(input: ApprovalProposalInput): ApprovalProposalResult
  recoverOrCreateProposal(input: ApprovalProposalRecoveryInput): ApprovalProposalRecoveryResult
  decideProposal(input: ApprovalDecisionInput): ApprovalProposalResult
  getProposal(proposalId: string): ApprovalProposalSnapshot | undefined
  getProposalByIdempotencyKey?(input: ApprovalProposalLookupInput): ApprovalProposalSnapshot | undefined
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

function hashMemoryProposalIntent(input: Pick<MemoryProposalInput, 'dispatch' | 'mutation' | 'ttlMs'>): string {
  const dispatch = input.dispatch === undefined
    ? null
    : {
      sourceId: input.dispatch.sourceId,
      bindingId: input.dispatch.bindingId,
      workspace: input.dispatch.workspace,
      principal: input.dispatch.principal,
    }
  return createHash('sha256').update(JSON.stringify({
    mutation: input.mutation,
    ttlMs: input.ttlMs,
    dispatch,
  })).digest('hex')
}

function proposalCreationVersion(proposal: ApprovalProposalResult): number {
  const expectedCurrentVersion = proposal.status === 'pending' ? 1 : 2
  if (proposal.version !== expectedCurrentVersion) {
    throw new MemoryStoreError('invalid-entry', 'assistant-policy returned an invalid proposal lifecycle version')
  }
  return 1
}

function permanentPolicyRecoveryFailure(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error)) return false
  return ['idempotency-conflict', 'invalid-input', 'invalid-path', 'unauthorized']
    .includes(String(error.code))
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
    const mutation = this.store.normalizeMutation(input.mutation, { preflight: false })
    const normalized: MemoryProposalInput = {
      ...input,
      mutation,
    }
    const mutationHash = hashMemoryProposalIntent(normalized)
    const prepared = this.store.prepareProposalIntent({
      ...normalized,
      proposalId,
      mutationHash,
    })
    if (prepared.kind === 'conflict') {
      throw new MemoryStoreError('idempotency-conflict', 'proposal key was used for another mutation')
    }
    if (prepared.kind === 'proposal') {
      return this.#replayStoredProposal(prepared.proposal, normalized)
    }
    return this.#submitProposal(prepared.intent, prepared.replayed)
  }

  #replayStoredProposal(
    existing: StoredMemoryProposal,
    authority: Pick<MemoryProposalInput, 'dispatch' | 'ttlMs'>,
  ): MemoryProposalResult {
    if (isMissingPolicyProposalId(existing.policyProposalId)) {
      if (existing.policyProposalId !== missingPolicyProposalId(
        existing.proposalId,
        authority.ttlMs,
        authority.dispatch,
      )) {
        throw new MemoryStoreError('idempotency-conflict', 'expired proposal intent replay changed its authority')
      }
      return result(existing, true)
    }
    if (existing.status !== 'pending') return result(existing, true)
    return this.#recoverAttachedProposal(existing)
  }

  #submitProposal(
    input: StoredMemoryProposalIntent,
    intentReplayed: boolean,
  ): MemoryProposalResult {
    const proposalId = deterministicProposalId(input.idempotencyKey)
    const diff = proposalDiff(input.mutation)
    const mutationHash = hashMemoryProposalIntent(input)
    const legacyMutationHash = hashMemoryMutation(input.mutation)
    if (input.proposalId !== proposalId
      || (input.mutationHash !== mutationHash && input.mutationHash !== legacyMutationHash)) {
      throw new MemoryStoreError('idempotency-conflict', 'durable proposal intent does not match its canonical payload')
    }
    const policyContent = {
      idempotencyKey: `personal-memory:${input.idempotencyKey}`,
      requester: input.requester,
      principal: input.principal,
      action: `memory.${input.mutation.op}`,
      resource: { kind: 'memory', id: proposalId },
      diff,
      summary: proposalSummary(input.mutation),
      ...(input.dispatch === undefined ? {} : { dispatch: input.dispatch }),
    }
    let policyProposal: ApprovalProposalResult
    try {
      const notAfter = input.createdAt + input.ttlMs
      if (!Number.isSafeInteger(notAfter)) {
        throw new MemoryStoreError('invalid-entry', 'proposal intent deadline exceeds the safe timestamp range')
      }
      const legacyReplay = input.mutationHash === legacyMutationHash
        && input.mutationHash !== mutationHash
      const legacyExisting = legacyReplay
        ? this.policy.getProposalByIdempotencyKey?.({
          idempotencyKey: policyContent.idempotencyKey,
          requester: policyContent.requester,
          principal: policyContent.principal,
          action: policyContent.action,
          resource: policyContent.resource,
        })
        : undefined
      if (legacyExisting !== undefined) {
        // The read is deliberately scoped and non-creating. Policy proposal rows
        // are immutable/non-deletable, so ordinary propose now performs an exact
        // legacy TTL/dispatch replay without opening a missing-row create path.
        policyProposal = this.policy.propose({ ...policyContent, ttlMs: input.ttlMs })
      } else {
        const recovered = this.policy.recoverOrCreateProposal({ ...policyContent, notAfter })
        if (recovered.kind === 'abandoned') {
          const conflicted = this.store.conflictProposalIntent(proposalId)
          return result(conflicted.proposal, intentReplayed || recovered.replayed || conflicted.replayed)
        }
        policyProposal = recovered.proposal
      }
    } catch (error) {
      if (!permanentPolicyRecoveryFailure(error)
        && !(error instanceof MemoryStoreError && error.code === 'invalid-entry')) throw error
      const conflicted = this.store.conflictProposalIntent(proposalId)
      return result(conflicted.proposal, intentReplayed || conflicted.replayed)
    }
    let expectedVersion: number
    try {
      expectedVersion = proposalCreationVersion(policyProposal)
    } catch {
      const conflicted = this.store.conflictProposalIntent(proposalId)
      return result(conflicted.proposal, intentReplayed || conflicted.replayed)
    }
    const attached = this.store.getProposal(proposalId)
    if (attached !== undefined && attached.policyProposalId !== policyProposal.proposalId) {
      return this.#settleSecurityConflict(attached)
    }
    const saved = this.store.saveProposal({
      proposalId,
      policyProposalId: policyProposal.proposalId,
      idempotencyKey: input.idempotencyKey,
      requester: input.requester,
      principal: input.principal,
      mutation: input.mutation,
      mutationHash,
      expiresAt: policyProposal.expiresAt,
      version: expectedVersion,
    })
    const replayed = intentReplayed || policyProposal.replayed || saved.replayed
    if (saved.proposal.status !== 'pending' || policyProposal.status === 'pending') {
      return result(saved.proposal, replayed)
    }
    const snapshot = this.policy.getProposal(saved.proposal.policyProposalId)
    return this.#settleValidated(saved.proposal, snapshot, saved.proposal.version, replayed)
  }

  #recoverAttachedProposal(proposal: StoredMemoryProposal): MemoryProposalResult {
    const snapshot = this.policy.getProposal(proposal.policyProposalId)
    if (snapshot === undefined) return this.#settleSecurityConflict(proposal)
    if (snapshot.status !== 'pending') {
      return this.#settleValidated(proposal, snapshot, proposal.version, true)
    }
    const exactPending = snapshot.proposalId === proposal.policyProposalId
      && snapshot.requester === proposal.requester
      && snapshot.principal === proposal.principal
      && snapshot.action === `memory.${proposal.mutation.op}`
      && snapshot.resource.kind === 'memory'
      && snapshot.resource.id === proposal.proposalId
      && snapshot.summary === proposalSummary(proposal.mutation)
      && snapshot.diffHash === createHash('sha256').update(proposalDiff(proposal.mutation)).digest('hex')
      && snapshot.expiresAt === proposal.expiresAt
      && snapshot.version === proposal.version
      && snapshot.decidedBy === undefined
      && snapshot.decisionReason === undefined
    return exactPending ? result(proposal, true) : this.#settleSecurityConflict(proposal)
  }

  decide(input: MemoryProposalDecisionInput): MemoryProposalResult {
    const proposal = this.store.getProposal(input.proposalId)
    if (proposal === undefined) throw new MemoryStoreError('not-found', 'memory proposal was not found')
    if (isMissingPolicyProposalId(proposal.policyProposalId)) {
      if (input.principal !== proposal.principal) {
        throw new MemoryStoreError('invalid-entry', 'memory proposal is bound to another principal')
      }
      return result(proposal, true)
    }
    const decision = this.policy.decideProposal({
      proposalId: proposal.policyProposalId,
      principal: input.principal,
      expectedVersion: input.expectedVersion,
      decision: input.decision,
      reason: input.reason,
    })
    if (decision.status === 'pending') {
      return this.#settleSecurityConflict(proposal)
    }
    if (proposal.status !== 'pending') {
      const replay = this.store.settleProposal({
        proposalId: proposal.proposalId,
        policyStatus: decision.status,
        policyVersion: decision.version,
      })
      return result(replay.proposal, decision.replayed || replay.replayed, replay.record)
    }
    const snapshot = this.policy.getProposal(proposal.policyProposalId)
    return this.#settleValidated(proposal, snapshot, proposal.version, decision.replayed)
  }

  getProposal(proposalId: string): MemoryProposalResult | undefined {
    const proposal = this.store.getProposal(proposalId)
    return proposal === undefined ? undefined : result(proposal, true)
  }

  /**
   * Commit locally pending proposals whose policy decision already settled
   * elsewhere, for example on an approval card minutes after the turn ended.
   *
   * Approval is never inferred: the decision is read back from the policy ledger,
   * and only a terminal policy status is settled here. Each settle reuses the
   * existing idempotent commit path, so repeated reconciles are safe.
   */
  reconcile(limit: number): MemoryProposalResult[] {
    const settled: MemoryProposalResult[] = []
    const intentLimit = limit === 1 ? 1 : Math.floor(limit / 2)
    const intents = this.store.listProposalIntents(intentLimit)
    for (const intent of intents) {
      try {
        // Re-resolve proposal-vs-intent under the local write lock before any
        // Policy call. This also removes poison residue left by older versions
        // that could represent both states in separate tables.
        const prepared = this.store.prepareProposalIntent({
          ...intent,
          proposalId: intent.proposalId,
          mutationHash: intent.mutationHash,
        })
        if (prepared.kind === 'conflict') {
          this.store.deferProposalIntent(intent.proposalId)
          continue
        }
        const recovered = prepared.kind === 'proposal'
          ? this.#replayStoredProposal(prepared.proposal, intent)
          : this.#submitProposal(prepared.intent, true)
        if (recovered.status !== 'pending') settled.push(recovered)
      } catch {
        this.store.deferProposalIntent(intent.proposalId)
      }
    }
    const pendingLimit = Math.max(1, limit - intents.length)
    for (const pending of this.store.listPendingProposals(pendingLimit)) {
      try {
        const decision = this.policy.getProposal(pending.policyProposalId)
        if (decision?.status !== 'pending') {
          settled.push(this.#settleValidated(pending, decision, pending.version, false))
          continue
        }
        this.store.deferPendingProposal(pending.proposalId)
      } catch {
        this.store.deferPendingProposal(pending.proposalId)
      }
    }
    return settled
  }

  #settleValidated(
    proposal: StoredMemoryProposal,
    snapshot: ApprovalProposalSnapshot | undefined,
    expectedVersion: number,
    policyReplayed: boolean,
  ): MemoryProposalResult {
    try {
      const terminal = validateApprovalSettlement(snapshot, {
        proposalId: proposal.policyProposalId,
        requester: proposal.requester,
        principal: proposal.principal,
        action: `memory.${proposal.mutation.op}`,
        resource: { kind: 'memory', id: proposal.proposalId },
        summary: proposalSummary(proposal.mutation),
        diff: proposalDiff(proposal.mutation),
        expiresAt: proposal.expiresAt,
        expectedVersion,
      })
      const applied = this.store.settleProposal({
        proposalId: proposal.proposalId,
        policyStatus: terminal.status,
        policyVersion: terminal.version,
      })
      return result(applied.proposal, policyReplayed || applied.replayed, applied.record)
    } catch (error) {
      if (!(error instanceof ApprovalSettlementConflict)) throw error
      return this.#settleSecurityConflict(proposal)
    }
  }

  #settleSecurityConflict(proposal: StoredMemoryProposal): MemoryProposalResult {
    const conflicted = this.store.settleProposal({
      proposalId: proposal.proposalId,
      policyStatus: 'conflicted',
    })
    return result(conflicted.proposal, conflicted.replayed)
  }
}
