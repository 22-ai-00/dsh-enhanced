import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
  ApprovalSettlementConflict,
  validateApprovalSettlement,
  type ApprovalProposalSnapshot,
  type ApprovalSettlementExpectation,
} from '../src/index.ts'

const diff = '+ canonical fact'
const expectation: ApprovalSettlementExpectation = {
  proposalId: 'proposal-1',
  requester: 'agent:primary',
  principal: 'owner:lark:123',
  action: 'memory.add',
  resource: { kind: 'memory', id: 'fact:alpha' },
  summary: 'Remember alpha',
  diff,
  expiresAt: 160_000,
  expectedVersion: 7,
}

function snapshot(
  status: ApprovalProposalSnapshot['status'],
  decidedBy: string | undefined,
): ApprovalProposalSnapshot {
  return {
    proposalId: expectation.proposalId,
    requester: expectation.requester,
    principal: expectation.principal,
    action: expectation.action,
    resource: expectation.resource,
    summary: expectation.summary,
    status,
    diffHash: createHash('sha256').update(diff).digest('hex'),
    expiresAt: expectation.expiresAt,
    version: expectation.expectedVersion + 1,
    decidedBy,
    decisionReason: 'settled',
  }
}

describe('approval settlement validator', () => {
  test('returns the exact validated terminal snapshot for every legitimate outcome', () => {
    const cases = [
      snapshot('approved', expectation.principal),
      snapshot('rejected', expectation.principal),
      snapshot('expired', 'system:expiry'),
    ] as const

    for (const settled of cases) {
      expect(validateApprovalSettlement(settled, expectation)).toBe(settled)
    }
  })

  test('checks every immutable expectation field exactly, including the raw diff hash', () => {
    const settled = snapshot('approved', expectation.principal)
    const mismatches: Array<[ApprovalSettlementExpectation, string]> = [
      [{ ...expectation, proposalId: 'proposal-2' }, 'proposal-id-mismatch'],
      [{ ...expectation, requester: 'agent:other' }, 'requester-mismatch'],
      [{ ...expectation, principal: 'owner:lark:other' }, 'principal-mismatch'],
      [{ ...expectation, action: 'memory.replace' }, 'action-mismatch'],
      [{ ...expectation, resource: { ...expectation.resource, kind: 'wiki' } }, 'resource-mismatch'],
      [{ ...expectation, resource: { ...expectation.resource, id: 'fact:beta' } }, 'resource-mismatch'],
      [{ ...expectation, summary: 'Remember beta' }, 'summary-mismatch'],
      [{ ...expectation, diff: '+ forged fact' }, 'diff-mismatch'],
      [{ ...expectation, expiresAt: 170_000 }, 'expiry-mismatch'],
      [{ ...expectation, expectedVersion: 8 }, 'version-mismatch'],
    ]

    for (const [changed, reason] of mismatches) {
      expect(() => validateApprovalSettlement(settled, changed)).toThrowError(
        expect.objectContaining({ code: 'approval-settlement-conflict', reason }),
      )
    }
  })

  test('requires a terminal state and the authenticated decision actor', () => {
    const conflicts: Array<[ApprovalProposalSnapshot, string]> = [
      [snapshot('pending', undefined), 'not-terminal'],
      [snapshot('approved', 'owner:lark:attacker'), 'decision-actor-mismatch'],
      [snapshot('rejected', 'owner:lark:attacker'), 'decision-actor-mismatch'],
      [snapshot('expired', expectation.principal), 'decision-actor-mismatch'],
    ]

    for (const [candidate, reason] of conflicts) {
      expect(() => validateApprovalSettlement(candidate, expectation)).toThrowError(
        expect.objectContaining({ code: 'approval-settlement-conflict', reason }),
      )
    }
  })

  test('throws the stable exported typed conflict', () => {
    try {
      validateApprovalSettlement(snapshot('pending', undefined), expectation)
      throw new Error('expected validation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(ApprovalSettlementConflict)
      expect(error).toMatchObject({
        name: 'ApprovalSettlementConflict',
        code: 'approval-settlement-conflict',
        reason: 'not-terminal',
      })
    }
  })

  test('treats a missing durable proposal as the same typed fail-closed conflict', () => {
    expect(() => validateApprovalSettlement(undefined, expectation)).toThrowError(
      expect.objectContaining({
        code: 'approval-settlement-conflict',
        reason: 'missing-proposal',
      }),
    )
  })
})
