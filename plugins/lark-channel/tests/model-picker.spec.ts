import { describe, expect, test } from 'vitest'
import {
  LarkModelPickerError,
  parseLarkModelPickerCallback,
  signLarkModelPickerAction,
  verifyLarkModelPickerAction,
  type LarkModelPickerActionPayload,
} from '../src/model-picker.ts'

const secret = 'test-secret-at-least-32-characters-long'
const payload: LarkModelPickerActionPayload = {
  version: 3,
  operationId: 'model-picker-1',
  bindingId: 'binding-1',
  expiresAt: 2_000,
  chatId: 'oc_owner',
  provider: 'codex-subscription',
  model: 'gpt-5.6-sol',
  effort: 'high',
  action: 'confirm',
  revision: 0,
}

describe('signed Lark model-picker actions', () => {
  test('round-trips a deterministic, expiring, chat-bound capability', () => {
    const token = signLarkModelPickerAction(secret, payload)
    expect(token).toBe(signLarkModelPickerAction(secret, payload))
    expect(token).not.toContain('model-picker-1')
    expect(verifyLarkModelPickerAction(secret, token, 1_999)).toEqual(payload)
    expect(() => verifyLarkModelPickerAction(secret, token, 2_000))
      .toThrowError(expect.objectContaining<Partial<LarkModelPickerError>>({ code: 'expired' }))
  })

  test('rejects tampering, a different secret, malformed tokens, and unsafe fields', () => {
    const token = signLarkModelPickerAction(secret, payload)
    expect(() => verifyLarkModelPickerAction(secret, `${token.slice(0, -1)}x`, 1_000))
      .toThrowError(expect.objectContaining<Partial<LarkModelPickerError>>({ code: 'invalid' }))
    expect(() => verifyLarkModelPickerAction('another-secret-at-least-32-characters', token, 1_000))
      .toThrowError(expect.objectContaining<Partial<LarkModelPickerError>>({ code: 'invalid' }))
    expect(() => signLarkModelPickerAction(secret, { ...payload, chatId: '../escape' }))
      .toThrowError(expect.objectContaining<Partial<LarkModelPickerError>>({ code: 'invalid' }))
    expect(() => signLarkModelPickerAction(secret, { ...payload, model: 'bad model' }))
      .toThrowError(expect.objectContaining<Partial<LarkModelPickerError>>({ code: 'invalid' }))
    expect(() => signLarkModelPickerAction(secret, { ...payload, version: 2 } as unknown as LarkModelPickerActionPayload))
      .toThrowError(expect.objectContaining<Partial<LarkModelPickerError>>({ code: 'invalid' }))
    expect(() => signLarkModelPickerAction(secret, { ...payload, revision: -1 }))
      .toThrowError(expect.objectContaining<Partial<LarkModelPickerError>>({ code: 'invalid' }))
    expect(() => verifyLarkModelPickerAction(secret, 'not-a-token', 1_000))
      .toThrowError(expect.objectContaining<Partial<LarkModelPickerError>>({ code: 'invalid' }))
    expect(() => verifyLarkModelPickerAction(secret, `${token}=`, 1_000))
      .toThrowError(expect.objectContaining<Partial<LarkModelPickerError>>({ code: 'invalid' }))
    expect(parseLarkModelPickerCallback({ modelPicker: token })).toEqual({ modelPicker: token })
    expect(() => parseLarkModelPickerCallback({ modelPicker: token, action: 'provider' }))
      .toThrowError(expect.objectContaining<Partial<LarkModelPickerError>>({ code: 'invalid' }))
  })

  test('verifies every payload accepted by the signer at the declared field bounds', () => {
    const bounded: LarkModelPickerActionPayload = {
      version: 3,
      operationId: `o${'a'.repeat(255)}`,
      bindingId: `b${'a'.repeat(255)}`,
      expiresAt: Number.MAX_SAFE_INTEGER,
      chatId: `c${'a'.repeat(255)}`,
      provider: `p${'a'.repeat(255)}`,
      model: `m${'a'.repeat(511)}`,
      effort: `e${'a'.repeat(127)}`,
      action: 'effort',
      revision: Number.MAX_SAFE_INTEGER,
    }
    const token = signLarkModelPickerAction(secret, bounded)
    expect(verifyLarkModelPickerAction(secret, token, 1_000)).toEqual(bounded)

    const unicodeBounded: LarkModelPickerActionPayload = {
      ...bounded,
      model: '\ud800'.repeat(512),
      effort: '\ud800'.repeat(128),
    }
    const unicodeToken = signLarkModelPickerAction(secret, unicodeBounded)
    expect(verifyLarkModelPickerAction(secret, unicodeToken, 1_000)).toEqual(unicodeBounded)
  })
})
