import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
  LarkPermissionPickerError,
  parseLarkPermissionPickerCallback,
  signLarkPermissionPickerAction,
  verifyLarkPermissionPickerAction,
  type LarkPermissionPickerActionPayload,
} from '../src/permission-picker.ts'

const secret = 'test-secret-at-least-32-characters-long'
const signatureDomain = 'dsh-lark-permission-picker:v2\0'
const payload: LarkPermissionPickerActionPayload = {
  version: 2,
  channel: 'lark',
  account: 'primary-bot',
  tenant: 'tenant-a',
  operationId: 'permission-picker-1',
  bindingId: 'binding-1',
  bindingVersion: 7,
  sessionId: 'session-1',
  chatId: 'oc_owner',
  ownerUser: 'ou_owner',
  issuedAt: 1_000,
  expiresAt: 2_000,
  expectedStateHash: 'a'.repeat(64),
  emergencyStopVersion: 0,
  level: 'auto',
}

function manuallySign(value: unknown, domain = signatureDomain): string {
  const encoded = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  const signature = createHmac('sha256', secret).update(domain).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

describe('signed Lark permission-picker capabilities', () => {
  test('round-trips a deterministic capability bound to its route, owner, binding state, time, and level', () => {
    const token = signLarkPermissionPickerAction(secret, payload)

    expect(token).toBe(signLarkPermissionPickerAction(secret, payload))
    expect(token).not.toContain(payload.operationId)
    expect(verifyLarkPermissionPickerAction(secret, token, payload.expiresAt - 1)).toEqual(payload)
    for (const level of ['ask', 'auto', 'full'] as const) {
      expect(signLarkPermissionPickerAction(secret, { ...payload, level })).not.toBe(
        signLarkPermissionPickerAction(secret, { ...payload, level: level === 'ask' ? 'auto' : 'ask' }),
      )
    }
    expect(() => verifyLarkPermissionPickerAction(secret, token, payload.expiresAt))
      .toThrowError(expect.objectContaining<Partial<LarkPermissionPickerError>>({ code: 'expired' }))
  })

  test('parses only the exact permissionPicker callback key with a bounded token string', () => {
    const token = signLarkPermissionPickerAction(secret, payload)

    expect(parseLarkPermissionPickerCallback({ permissionPicker: token })).toEqual({ permissionPicker: token })
    for (const invalid of [
      null,
      [],
      {},
      { permissionPicker: token, action: 'full' },
      { modelPicker: token },
      { permissionPicker: 42 },
      { permissionPicker: 'short' },
      { permissionPicker: 'x'.repeat(4_097) },
    ]) {
      expect(() => parseLarkPermissionPickerCallback(invalid))
        .toThrowError(expect.objectContaining<Partial<LarkPermissionPickerError>>({ code: 'invalid' }))
    }
  })

  test('accepts all claims at their declared bounds, including slash-bearing route components', () => {
    const bounded: LarkPermissionPickerActionPayload = {
      version: 2,
      channel: `c${'a'.repeat(255)}`,
      account: `a/${'b'.repeat(254)}`,
      tenant: `t/${'c'.repeat(254)}`,
      operationId: `o${'d'.repeat(255)}`,
      bindingId: `b${'e'.repeat(255)}`,
      bindingVersion: Number.MAX_SAFE_INTEGER,
      sessionId: `s${'f'.repeat(255)}`,
      chatId: `c${'g'.repeat(255)}`,
      ownerUser: `u${'h'.repeat(255)}`,
      issuedAt: Number.MAX_SAFE_INTEGER - 1,
      expiresAt: Number.MAX_SAFE_INTEGER,
      expectedStateHash: 'f'.repeat(64),
      emergencyStopVersion: Number.MAX_SAFE_INTEGER,
      level: 'full',
    }

    const token = signLarkPermissionPickerAction(secret, bounded)
    expect(token.length).toBeLessThanOrEqual(4_096)
    expect(verifyLarkPermissionPickerAction(secret, token, 1)).toEqual(bounded)
  })

  test('rejects unknown, unsafe, unbounded, or internally inconsistent payload claims', () => {
    const invalidPayloads: unknown[] = [
      { ...payload, unknown: true },
      { ...payload, version: 1 },
      { ...payload, channel: 'lark\nadmin' },
      { ...payload, account: `a${'x'.repeat(256)}` },
      { ...payload, tenant: 'tenant\u202Eprod' },
      { ...payload, operationId: '../escape' },
      { ...payload, bindingId: '' },
      { ...payload, bindingVersion: 0 },
      { ...payload, bindingVersion: Number.MAX_SAFE_INTEGER + 1 },
      { ...payload, sessionId: `s${'x'.repeat(256)}` },
      { ...payload, chatId: 'owner user' },
      { ...payload, ownerUser: 'owner\0admin' },
      { ...payload, issuedAt: 0 },
      { ...payload, issuedAt: payload.expiresAt },
      { ...payload, expiresAt: Number.MAX_SAFE_INTEGER + 1 },
      { ...payload, expectedStateHash: 'A'.repeat(64) },
      { ...payload, expectedStateHash: 'a'.repeat(63) },
      { ...payload, emergencyStopVersion: -1 },
      { ...payload, emergencyStopVersion: Number.MAX_SAFE_INTEGER + 1 },
      { ...payload, level: 'unrestricted' },
      null,
      [],
    ]

    for (const invalid of invalidPayloads) {
      let thrown: unknown
      try {
        signLarkPermissionPickerAction(secret, invalid as LarkPermissionPickerActionPayload)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toMatchObject({
        code: 'invalid',
        message: 'permission picker action payload is invalid',
      })
      expect(JSON.stringify(thrown)).not.toContain('admin')
    }
    expect(() => signLarkPermissionPickerAction('short', payload))
      .toThrowError(expect.objectContaining<Partial<LarkPermissionPickerError>>({ code: 'invalid' }))
  })

  test('rejects tampering, other HMAC namespaces, and non-canonical JSON or base64url', () => {
    const token = signLarkPermissionPickerAction(secret, payload)
    expect(() => verifyLarkPermissionPickerAction(
      'another-secret-at-least-32-characters', token, 1_500,
    )).toThrowError(expect.objectContaining<Partial<LarkPermissionPickerError>>({ code: 'invalid' }))
    expect(() => verifyLarkPermissionPickerAction(
      secret, `${token[0] === 'A' ? 'B' : 'A'}${token.slice(1)}`, 1_500,
    )).toThrowError(expect.objectContaining<Partial<LarkPermissionPickerError>>({ code: 'invalid' }))
    expect(() => verifyLarkPermissionPickerAction(secret, manuallySign(payload, ''), 1_500))
      .toThrowError(expect.objectContaining<Partial<LarkPermissionPickerError>>({ code: 'invalid' }))

    const reordered = {
      level: payload.level,
      emergencyStopVersion: payload.emergencyStopVersion,
      expectedStateHash: payload.expectedStateHash,
      expiresAt: payload.expiresAt,
      issuedAt: payload.issuedAt,
      ownerUser: payload.ownerUser,
      chatId: payload.chatId,
      sessionId: payload.sessionId,
      bindingVersion: payload.bindingVersion,
      bindingId: payload.bindingId,
      operationId: payload.operationId,
      tenant: payload.tenant,
      account: payload.account,
      channel: payload.channel,
      version: payload.version,
    }
    expect(() => verifyLarkPermissionPickerAction(secret, manuallySign(reordered), 1_500))
      .toThrowError(expect.objectContaining<Partial<LarkPermissionPickerError>>({ code: 'invalid' }))

    const [encoded, signature] = token.split('.') as [string, string]
    expect(() => verifyLarkPermissionPickerAction(secret, `${encoded}=.${signature}`, 1_500))
      .toThrowError(expect.objectContaining<Partial<LarkPermissionPickerError>>({ code: 'invalid' }))
    expect(() => verifyLarkPermissionPickerAction(secret, `${encoded}.${signature}=`, 1_500))
      .toThrowError(expect.objectContaining<Partial<LarkPermissionPickerError>>({ code: 'invalid' }))
    expect(() => verifyLarkPermissionPickerAction(secret, 'not-a-token', 1_500))
      .toThrowError(expect.objectContaining<Partial<LarkPermissionPickerError>>({ code: 'invalid' }))
    expect(() => verifyLarkPermissionPickerAction(secret, token, Number.NaN))
      .toThrowError(expect.objectContaining<Partial<LarkPermissionPickerError>>({ code: 'invalid' }))
  })
})
