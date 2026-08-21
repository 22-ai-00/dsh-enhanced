import { describe, expect, test } from 'vitest'
import {
  LarkApprovalError,
  signLarkApprovalAction,
  verifyLarkApprovalAction,
  type LarkApprovalActionPayload,
} from '../src/approval.ts'

const secret = 'test-secret-at-least-32-characters-long'
const payload: LarkApprovalActionPayload = {
  version: 1,
  operationId: 'operation-1',
  bindingId: 'binding-1',
  proposalId: 'proposal-1',
  expectedVersion: 1,
  expiresAt: 2_000,
  chatId: 'oc_owner',
  decision: 'approved',
}

describe('signed Lark approval actions', () => {
  test('round-trips a deterministic, expiring, decision-bound capability', () => {
    const token = signLarkApprovalAction(secret, payload)
    expect(token).toBe(signLarkApprovalAction(secret, payload))
    expect(token).not.toContain('operation-1')
    expect(verifyLarkApprovalAction(secret, token, 1_999)).toEqual(payload)
    expect(() => verifyLarkApprovalAction(secret, token, 2_000))
      .toThrowError(expect.objectContaining<Partial<LarkApprovalError>>({ code: 'expired' }))
  })

  test('rejects tampering, a different secret, malformed payloads, and unsafe fields', () => {
    const token = signLarkApprovalAction(secret, payload)
    expect(() => verifyLarkApprovalAction(secret, `${token.slice(0, -1)}x`, 1_000))
      .toThrowError(expect.objectContaining<Partial<LarkApprovalError>>({ code: 'invalid' }))
    expect(() => verifyLarkApprovalAction('another-secret-at-least-32-characters', token, 1_000))
      .toThrowError(expect.objectContaining<Partial<LarkApprovalError>>({ code: 'invalid' }))
    expect(() => signLarkApprovalAction(secret, { ...payload, chatId: '../escape' }))
      .toThrowError(expect.objectContaining<Partial<LarkApprovalError>>({ code: 'invalid' }))
    expect(() => verifyLarkApprovalAction(secret, 'not-a-token', 1_000))
      .toThrowError(expect.objectContaining<Partial<LarkApprovalError>>({ code: 'invalid' }))
  })
})
