import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
  LarkUserQuestionError,
  parseLarkUserQuestionCallback,
  signLarkUserQuestionAction,
  verifyLarkUserQuestionAction,
  type LarkUserQuestionActionPayload,
} from '../src/user-question.ts'

const secret = 'test-secret-at-least-32-characters-long'
const signatureDomain = 'dsh-lark-user-question:v1\0'
const payload: LarkUserQuestionActionPayload = {
  version: 1,
  channel: 'lark',
  account: 'primary-bot',
  tenant: 'tenant-a',
  rpcId: 'rpc-1',
  sessionId: 'session-1',
  bindingId: 'binding-1',
  bindingVersion: 7,
  bindingGeneration: 3,
  chatId: 'oc_owner',
  ownerUser: 'ou_owner',
  requestHash: 'a'.repeat(64),
  questionIndex: 0,
  optionIndex: 2,
  action: 'select',
  revision: 0,
  expiresAt: 2_000,
}

function manuallySign(value: unknown, domain = signatureDomain): string {
  const encoded = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  const signature = createHmac('sha256', secret).update(domain).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

describe('signed Lark user-question capabilities', () => {
  test('round-trips a deterministic capability bound to its route, question state, and action', () => {
    const token = signLarkUserQuestionAction(secret, payload)

    expect(token).toBe(signLarkUserQuestionAction(secret, payload))
    expect(token).not.toContain(payload.rpcId)
    expect(verifyLarkUserQuestionAction(secret, token, payload.expiresAt - 1)).toEqual(payload)
    for (const action of ['select', 'toggle'] as const) {
      expect(signLarkUserQuestionAction(secret, { ...payload, action })).not.toBe(
        signLarkUserQuestionAction(secret, { ...payload, action: action === 'select' ? 'toggle' : 'select' }),
      )
    }
    for (const action of ['submit', 'cancel'] as const) {
      const terminal = { ...payload, action, optionIndex: null } as const
      expect(verifyLarkUserQuestionAction(
        secret, signLarkUserQuestionAction(secret, terminal), payload.expiresAt - 1,
      )).toEqual(terminal)
    }
    expect(() => verifyLarkUserQuestionAction(secret, token, payload.expiresAt))
      .toThrowError(expect.objectContaining<Partial<LarkUserQuestionError>>({ code: 'expired' }))
  })

  test('parses only the exact userQuestion callback key with a bounded token string', () => {
    const token = signLarkUserQuestionAction(secret, payload)

    expect(parseLarkUserQuestionCallback({ userQuestion: token })).toEqual({ userQuestion: token })
    for (const invalid of [
      null,
      [],
      {},
      { userQuestion: token, action: 'select' },
      { permissionPicker: token },
      { userQuestion: 42 },
      { userQuestion: 'short' },
      { userQuestion: 'x'.repeat(4_097) },
    ]) {
      expect(() => parseLarkUserQuestionCallback(invalid))
        .toThrowError(expect.objectContaining<Partial<LarkUserQuestionError>>({ code: 'invalid' }))
    }
  })

  test('accepts all claims at their declared bounds', () => {
    const bounded: LarkUserQuestionActionPayload = {
      version: 1,
      channel: `c${'a'.repeat(255)}`,
      account: `a/${'b'.repeat(254)}`,
      tenant: `t/${'c'.repeat(254)}`,
      rpcId: `r${'d'.repeat(255)}`,
      sessionId: `s${'e'.repeat(255)}`,
      bindingId: `b${'f'.repeat(255)}`,
      bindingVersion: Number.MAX_SAFE_INTEGER,
      bindingGeneration: Number.MAX_SAFE_INTEGER,
      chatId: `c${'g'.repeat(255)}`,
      ownerUser: `u${'h'.repeat(255)}`,
      requestHash: 'f'.repeat(64),
      questionIndex: Number.MAX_SAFE_INTEGER,
      optionIndex: Number.MAX_SAFE_INTEGER,
      action: 'toggle',
      revision: Number.MAX_SAFE_INTEGER,
      expiresAt: Number.MAX_SAFE_INTEGER,
    }

    const token = signLarkUserQuestionAction(secret, bounded)
    expect(token.length).toBeLessThanOrEqual(4_096)
    expect(verifyLarkUserQuestionAction(secret, token, 1)).toEqual(bounded)
  })

  test('rejects unknown, unsafe, unbounded, and internally inconsistent claims', () => {
    const invalidPayloads: unknown[] = [
      { ...payload, unknown: true },
      { ...payload, version: 2 },
      { ...payload, channel: 'lark\nadmin' },
      { ...payload, account: `a${'x'.repeat(256)}` },
      { ...payload, tenant: 'tenant\u202Eprod' },
      { ...payload, rpcId: '../escape' },
      { ...payload, sessionId: '' },
      { ...payload, bindingId: 'binding user' },
      { ...payload, bindingVersion: 0 },
      { ...payload, bindingVersion: Number.MAX_SAFE_INTEGER + 1 },
      { ...payload, bindingGeneration: 0 },
      { ...payload, bindingGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { ...payload, chatId: 'owner user' },
      { ...payload, ownerUser: 'owner\0admin' },
      { ...payload, requestHash: 'A'.repeat(64) },
      { ...payload, requestHash: 'a'.repeat(63) },
      { ...payload, questionIndex: -1 },
      { ...payload, questionIndex: Number.MAX_SAFE_INTEGER + 1 },
      { ...payload, optionIndex: -1 },
      { ...payload, optionIndex: Number.MAX_SAFE_INTEGER + 1 },
      { ...payload, action: 'select', optionIndex: null },
      { ...payload, action: 'toggle', optionIndex: null },
      { ...payload, action: 'submit', optionIndex: 0 },
      { ...payload, action: 'cancel', optionIndex: 0 },
      { ...payload, action: 'other' },
      { ...payload, revision: -1 },
      { ...payload, revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...payload, expiresAt: 0 },
      { ...payload, expiresAt: Number.MAX_SAFE_INTEGER + 1 },
      null,
      [],
    ]

    for (const invalidPayload of invalidPayloads) {
      let thrown: unknown
      try {
        signLarkUserQuestionAction(secret, invalidPayload as LarkUserQuestionActionPayload)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toMatchObject({
        code: 'invalid',
        message: 'user question action payload is invalid',
      })
      expect(JSON.stringify(thrown)).not.toContain('admin')
    }
    expect(() => signLarkUserQuestionAction('short', payload))
      .toThrowError(expect.objectContaining<Partial<LarkUserQuestionError>>({ code: 'invalid' }))
  })

  test('rejects tampering, other HMAC namespaces, and non-canonical JSON or base64url', () => {
    const token = signLarkUserQuestionAction(secret, payload)
    expect(() => verifyLarkUserQuestionAction(
      'another-secret-at-least-32-characters', token, 1_500,
    )).toThrowError(expect.objectContaining<Partial<LarkUserQuestionError>>({ code: 'invalid' }))
    expect(() => verifyLarkUserQuestionAction(
      secret, `${token[0] === 'A' ? 'B' : 'A'}${token.slice(1)}`, 1_500,
    )).toThrowError(expect.objectContaining<Partial<LarkUserQuestionError>>({ code: 'invalid' }))
    expect(() => verifyLarkUserQuestionAction(secret, manuallySign(payload, ''), 1_500))
      .toThrowError(expect.objectContaining<Partial<LarkUserQuestionError>>({ code: 'invalid' }))

    const reordered = {
      expiresAt: payload.expiresAt,
      revision: payload.revision,
      action: payload.action,
      optionIndex: payload.optionIndex,
      questionIndex: payload.questionIndex,
      requestHash: payload.requestHash,
      ownerUser: payload.ownerUser,
      chatId: payload.chatId,
      bindingGeneration: payload.bindingGeneration,
      bindingVersion: payload.bindingVersion,
      bindingId: payload.bindingId,
      sessionId: payload.sessionId,
      rpcId: payload.rpcId,
      tenant: payload.tenant,
      account: payload.account,
      channel: payload.channel,
      version: payload.version,
    }
    expect(() => verifyLarkUserQuestionAction(secret, manuallySign(reordered), 1_500))
      .toThrowError(expect.objectContaining<Partial<LarkUserQuestionError>>({ code: 'invalid' }))

    const [encoded, signature] = token.split('.') as [string, string]
    expect(() => verifyLarkUserQuestionAction(secret, `${encoded}=.${signature}`, 1_500))
      .toThrowError(expect.objectContaining<Partial<LarkUserQuestionError>>({ code: 'invalid' }))
    expect(() => verifyLarkUserQuestionAction(secret, `${encoded}.${signature}=`, 1_500))
      .toThrowError(expect.objectContaining<Partial<LarkUserQuestionError>>({ code: 'invalid' }))
    expect(() => verifyLarkUserQuestionAction(secret, 'not-a-token', 1_500))
      .toThrowError(expect.objectContaining<Partial<LarkUserQuestionError>>({ code: 'invalid' }))
    expect(() => verifyLarkUserQuestionAction(secret, token, Number.NaN))
      .toThrowError(expect.objectContaining<Partial<LarkUserQuestionError>>({ code: 'invalid' }))
  })
})
