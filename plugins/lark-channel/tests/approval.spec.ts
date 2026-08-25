import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
  LarkApprovalError,
  signLarkApprovalAction,
  verifyLarkApprovalAction,
  verifyLarkApprovalActionForRecovery,
  type LarkApprovalActionPayload,
} from '../src/approval.ts'

const secret = 'test-secret-at-least-32-characters-long'
const payload: LarkApprovalActionPayload = {
  version: 2,
  channel: 'lark',
  account: 'primary-bot',
  tenant: 'tenant-a',
  operationId: 'operation-1',
  bindingId: 'binding-1',
  proposalId: 'proposal-1',
  expectedVersion: 1,
  expiresAt: 2_000,
  chatId: 'oc_owner',
  diffHash: 'a'.repeat(64),
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

  test('authenticates an expired canonical v2 capability only through the recovery verifier', () => {
    const token = signLarkApprovalAction(secret, payload)

    expect(() => verifyLarkApprovalAction(secret, token, payload.expiresAt))
      .toThrowError(expect.objectContaining<Partial<LarkApprovalError>>({ code: 'expired' }))
    expect(verifyLarkApprovalActionForRecovery(secret, token)).toEqual(payload)

    const reordered = {
      decision: payload.decision,
      diffHash: payload.diffHash,
      chatId: payload.chatId,
      expiresAt: payload.expiresAt,
      expectedVersion: payload.expectedVersion,
      proposalId: payload.proposalId,
      bindingId: payload.bindingId,
      operationId: payload.operationId,
      tenant: payload.tenant,
      account: payload.account,
      channel: payload.channel,
      version: payload.version,
    }
    const encoded = Buffer.from(JSON.stringify(reordered), 'utf8').toString('base64url')
    const signedNonCanonical = `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`
    expect(() => verifyLarkApprovalActionForRecovery(secret, signedNonCanonical))
      .toThrowError(expect.objectContaining<Partial<LarkApprovalError>>({ code: 'invalid' }))
  })

  test('rejects tampering, a different secret, malformed payloads, and unsafe fields', () => {
    const token = signLarkApprovalAction(secret, payload)
    expect(() => verifyLarkApprovalAction(secret, `${token}=`, 1_000))
      .toThrowError(expect.objectContaining<Partial<LarkApprovalError>>({ code: 'invalid' }))
    expect(() => verifyLarkApprovalActionForRecovery(secret, `${token}=`))
      .toThrowError(expect.objectContaining<Partial<LarkApprovalError>>({ code: 'invalid' }))
    expect(() => verifyLarkApprovalAction(secret, `${token[0] === 'A' ? 'B' : 'A'}${token.slice(1)}`, 1_000))
      .toThrowError(expect.objectContaining<Partial<LarkApprovalError>>({ code: 'invalid' }))
    expect(() => verifyLarkApprovalAction('another-secret-at-least-32-characters', token, 1_000))
      .toThrowError(expect.objectContaining<Partial<LarkApprovalError>>({ code: 'invalid' }))
    expect(() => signLarkApprovalAction(secret, { ...payload, chatId: '../escape' }))
      .toThrowError(expect.objectContaining<Partial<LarkApprovalError>>({ code: 'invalid' }))
    expect(() => verifyLarkApprovalAction(secret, 'not-a-token', 1_000))
      .toThrowError(expect.objectContaining<Partial<LarkApprovalError>>({ code: 'invalid' }))
    const [encoded, signature] = token.split('.') as [string, string]
    const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as LarkApprovalActionPayload
    for (const changed of [{ ...decoded, account: 'attacker-bot' }, { ...decoded, diffHash: 'b'.repeat(64) }]) {
      const tampered = `${Buffer.from(JSON.stringify(changed), 'utf8').toString('base64url')}.${signature}`
      expect(() => verifyLarkApprovalAction(secret, tampered, 1_000))
        .toThrowError(expect.objectContaining<Partial<LarkApprovalError>>({ code: 'invalid' }))
      expect(() => verifyLarkApprovalActionForRecovery(secret, tampered))
        .toThrowError(expect.objectContaining<Partial<LarkApprovalError>>({ code: 'invalid' }))
    }
    expect(() => signLarkApprovalAction(secret, { ...payload, version: 1 } as unknown as LarkApprovalActionPayload))
      .toThrowError(expect.objectContaining<Partial<LarkApprovalError>>({ code: 'invalid' }))
    const { operationId: _operationId, ...missingOperation } = payload
    expect(() => signLarkApprovalAction(secret, missingOperation as LarkApprovalActionPayload))
      .toThrowError(expect.objectContaining<Partial<LarkApprovalError>>({ code: 'invalid' }))
    const { diffHash: _diffHash, ...missingDiffHash } = payload
    expect(() => signLarkApprovalAction(secret, missingDiffHash as LarkApprovalActionPayload))
      .toThrowError(expect.objectContaining<Partial<LarkApprovalError>>({ code: 'invalid' }))
  })
})
