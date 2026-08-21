import { describe, expect, test } from 'vitest'
import {
  LarkModelPickerError,
  signLarkModelPickerAction,
  verifyLarkModelPickerAction,
  type LarkModelPickerActionPayload,
} from '../src/model-picker.ts'

const secret = 'test-secret-at-least-32-characters-long'
const payload: LarkModelPickerActionPayload = {
  version: 1,
  operationId: 'model-picker-1',
  bindingId: 'binding-1',
  expiresAt: 2_000,
  chatId: 'oc_owner',
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
    expect(() => verifyLarkModelPickerAction(secret, 'not-a-token', 1_000))
      .toThrowError(expect.objectContaining<Partial<LarkModelPickerError>>({ code: 'invalid' }))
  })
})
