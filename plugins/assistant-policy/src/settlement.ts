import { createHash } from 'node:crypto'
import type { ApprovalProposalSnapshot } from './ledger.js'

export interface ApprovalSettlementExpectation {
  proposalId: string
  requester: string
  principal: string
  action: string
  resource: Readonly<{ kind: string; id: string }>
  summary: string
  diff: string
  expiresAt: number
  expectedVersion: number
}

export type ApprovalSettlementConflictReason =
  | 'action-mismatch'
  | 'decision-actor-mismatch'
  | 'diff-mismatch'
  | 'expiry-mismatch'
  | 'invalid-expectation'
  | 'missing-proposal'
  | 'not-terminal'
  | 'principal-mismatch'
  | 'proposal-id-mismatch'
  | 'requester-mismatch'
  | 'resource-mismatch'
  | 'summary-mismatch'
  | 'version-mismatch'

export type ValidatedApprovalSettlement = ApprovalProposalSnapshot & {
  status: 'approved' | 'expired' | 'rejected'
}

export class ApprovalSettlementConflict extends Error {
  readonly code = 'approval-settlement-conflict' as const

  constructor(readonly reason: ApprovalSettlementConflictReason) {
    super(`approval settlement conflict: ${reason}`)
    this.name = 'ApprovalSettlementConflict'
  }
}

function conflict(reason: ApprovalSettlementConflictReason): never {
  throw new ApprovalSettlementConflict(reason)
}

/**
 * Validate a terminal Policy snapshot against the immutable operation owned by
 * a domain before that domain commits its pending mutation.
 */
export function validateApprovalSettlement(
  snapshot: ApprovalProposalSnapshot | undefined,
  expectation: Readonly<ApprovalSettlementExpectation>,
): ValidatedApprovalSettlement {
  if (typeof expectation.diff !== 'string'
    || !Number.isSafeInteger(expectation.expectedVersion)
    || expectation.expectedVersion <= 0
    || expectation.expectedVersion >= Number.MAX_SAFE_INTEGER) {
    conflict('invalid-expectation')
  }
  if (snapshot === undefined) conflict('missing-proposal')
  if (snapshot.proposalId !== expectation.proposalId) conflict('proposal-id-mismatch')
  if (snapshot.requester !== expectation.requester) conflict('requester-mismatch')
  if (snapshot.principal !== expectation.principal) conflict('principal-mismatch')
  if (snapshot.action !== expectation.action) conflict('action-mismatch')
  if (snapshot.resource.kind !== expectation.resource.kind
    || snapshot.resource.id !== expectation.resource.id) conflict('resource-mismatch')
  if (snapshot.summary !== expectation.summary) conflict('summary-mismatch')
  const expectedDiffHash = createHash('sha256').update(expectation.diff).digest('hex')
  if (snapshot.diffHash !== expectedDiffHash) conflict('diff-mismatch')
  if (snapshot.expiresAt !== expectation.expiresAt) conflict('expiry-mismatch')
  if (snapshot.version !== expectation.expectedVersion + 1) conflict('version-mismatch')
  if (snapshot.status === 'pending') conflict('not-terminal')
  const expectedActor = snapshot.status === 'expired' ? 'system:expiry' : expectation.principal
  if (snapshot.decidedBy !== expectedActor) conflict('decision-actor-mismatch')
  return snapshot as ValidatedApprovalSettlement
}
