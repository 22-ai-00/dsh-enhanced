import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
  LarkToolApprovalError,
  signLarkToolApprovalAction,
  verifyLarkToolApprovalAction,
  type LarkToolApprovalActionPayload,
} from '../src/tool-approval.ts'

const secret = 'test-secret-at-least-32-characters-long'
const payload: LarkToolApprovalActionPayload = {
  version: 1,
  channel: 'lark',
  account: 'primary-bot',
  tenant: 'tenant-a',
  operationId: 'tool-approval-1',
  bindingId: 'binding-1',
  chatId: 'oc_owner',
  ownerUser: 'ou_owner',
  actionHash: 'a'.repeat(64),
  toolName: 'exec_command',
  callId: 'call-1',
  expiresAt: 2_000,
  decision: 'allowed-once',
}

describe('signed one-shot Lark tool approval actions', () => {
  test('round-trips a canonical capability bound to the action, route, owner, and decision', () => {
    const token = signLarkToolApprovalAction(secret, payload)
    expect(token).toBe(signLarkToolApprovalAction(secret, payload))
    expect(signLarkToolApprovalAction(secret, { ...payload, decision: 'rejected' })).not.toBe(token)
    expect(verifyLarkToolApprovalAction(secret, token, payload.expiresAt - 1)).toEqual(payload)
    expect(() => verifyLarkToolApprovalAction(secret, token, payload.expiresAt))
      .toThrowError(expect.objectContaining<Partial<LarkToolApprovalError>>({ code: 'expired' }))
  })

  test('accepts the same slash-bearing account and tenant routes as the channel config', () => {
    const routed = { ...payload, account: 'team/bot', tenant: 'tenant/eu' }
    expect(verifyLarkToolApprovalAction(
      secret,
      signLarkToolApprovalAction(secret, routed),
      1_999,
    )).toEqual(routed)
  })

  test('does not sign a valid-claim payload whose JSON escaping exceeds the verifier token budget', () => {
    const oversized = {
      ...payload,
      account: 'a'.repeat(256),
      tenant: 't'.repeat(256),
      operationId: 'o'.repeat(256),
      bindingId: 'b'.repeat(256),
      chatId: 'c'.repeat(256),
      ownerUser: 'u'.repeat(256),
      toolName: '"'.repeat(512),
      callId: '\\'.repeat(512),
    }
    expect(() => signLarkToolApprovalAction(secret, oversized))
      .toThrowError(expect.objectContaining<Partial<LarkToolApprovalError>>({ code: 'invalid' }))
  })

  test('rejects tampering, non-canonical encoding, unsafe claims, and weak secrets with fixed errors', () => {
    const token = signLarkToolApprovalAction(secret, payload)
    expect(() => verifyLarkToolApprovalAction('another-secret-at-least-32-characters', token, 1_000))
      .toThrowError(expect.objectContaining<Partial<LarkToolApprovalError>>({ code: 'invalid' }))
    expect(() => verifyLarkToolApprovalAction(secret, `${token[0] === 'A' ? 'B' : 'A'}${token.slice(1)}`, 1_000))
      .toThrowError(expect.objectContaining<Partial<LarkToolApprovalError>>({ code: 'invalid' }))

    const reordered = {
      decision: payload.decision,
      expiresAt: payload.expiresAt,
      callId: payload.callId,
      toolName: payload.toolName,
      actionHash: payload.actionHash,
      ownerUser: payload.ownerUser,
      chatId: payload.chatId,
      bindingId: payload.bindingId,
      operationId: payload.operationId,
      tenant: payload.tenant,
      account: payload.account,
      channel: payload.channel,
      version: payload.version,
    }
    const encoded = Buffer.from(JSON.stringify(reordered), 'utf8').toString('base64url')
    const signature = createHmac('sha256', secret)
      .update('dsh-lark-tool-approval:v1\0')
      .update(encoded)
      .digest('base64url')
    expect(() => verifyLarkToolApprovalAction(secret, `${encoded}.${signature}`, 1_000))
      .toThrowError(expect.objectContaining<Partial<LarkToolApprovalError>>({ code: 'invalid' }))

    for (const invalid of [
      { ...payload, actionHash: 'not-a-hash' },
      { ...payload, chatId: '../escape' },
      { ...payload, toolName: 'provider\nsecret' },
      { ...payload, toolName: 'exec_\u202Ecommand' },
      { ...payload, callId: null },
      { ...payload, callId: 'x'.repeat(513) },
      { ...payload, expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      let thrown: unknown
      try {
        signLarkToolApprovalAction(secret, invalid as LarkToolApprovalActionPayload)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toMatchObject({ code: 'invalid', message: 'tool approval action payload is invalid' })
      expect(JSON.stringify(thrown)).not.toContain('provider')
    }
    expect(() => signLarkToolApprovalAction('short', payload))
      .toThrowError(expect.objectContaining<Partial<LarkToolApprovalError>>({ code: 'invalid' }))
  })
})
