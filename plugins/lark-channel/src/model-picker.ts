import { createHmac, timingSafeEqual } from 'node:crypto'

export interface LarkModelPickerActionPayload {
  version: 3
  operationId: string
  bindingId: string
  expiresAt: number
  chatId: string
  provider: string
  model: string
  effort: string | null
  action: LarkModelPickerCallbackAction
  revision: number
}

export type LarkModelPickerCallbackAction = 'confirm' | 'effort' | 'model' | 'provider'
const callbackActions: readonly LarkModelPickerCallbackAction[] = ['confirm', 'effort', 'model', 'provider']

export interface LarkModelPickerCallbackValue {
  modelPicker: string
}

export class LarkModelPickerError extends Error {
  constructor(readonly code: 'expired' | 'invalid', message: string) {
    super(message)
    this.name = 'LarkModelPickerError'
  }
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,255}$/u
const providerPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u
const base64urlPattern = /^[A-Za-z0-9_-]+$/u

function routePart(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maxLength
    && !/[\s\p{Cc}]/u.test(value)
}

function validateSecret(secret: string): void {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 16) {
    throw new LarkModelPickerError('invalid', 'model picker signing key is invalid')
  }
}

function canonical(input: LarkModelPickerActionPayload): LarkModelPickerActionPayload {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(field => ![
      'version', 'operationId', 'bindingId', 'expiresAt', 'chatId', 'provider', 'model', 'effort', 'action', 'revision',
    ].includes(field))
    || Object.keys(input).length !== 10
    || input.version !== 3
    || typeof input.operationId !== 'string' || !identifierPattern.test(input.operationId)
    || typeof input.bindingId !== 'string' || !identifierPattern.test(input.bindingId)
    || typeof input.chatId !== 'string' || !identifierPattern.test(input.chatId)
    || typeof input.provider !== 'string' || !providerPattern.test(input.provider)
    || !routePart(input.model, 512)
    || (input.effort !== null && !routePart(input.effort, 128))
    || !callbackActions.includes(input.action)
    || !Number.isSafeInteger(input.revision) || input.revision < 0
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt < 1) {
    throw new LarkModelPickerError('invalid', 'model picker action payload is invalid')
  }
  return { version: 3, operationId: input.operationId, bindingId: input.bindingId,
    expiresAt: input.expiresAt, chatId: input.chatId,
    provider: input.provider, model: input.model, effort: input.effort, action: input.action,
    revision: input.revision }
}

export function parseLarkModelPickerCallback(value: unknown): LarkModelPickerCallbackValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 1
    || Object.keys(value)[0] !== 'modelPicker') {
    throw new LarkModelPickerError('invalid', 'model picker callback value is invalid')
  }
  const callback = value as { modelPicker?: unknown }
  if (typeof callback.modelPicker !== 'string') {
    throw new LarkModelPickerError('invalid', 'model picker callback value is invalid')
  }
  return { modelPicker: callback.modelPicker }
}

function signature(secret: string, encoded: string): Buffer {
  return createHmac('sha256', secret).update(encoded).digest()
}

export function signLarkModelPickerAction(secret: string, input: LarkModelPickerActionPayload): string {
  validateSecret(secret)
  const encoded = Buffer.from(JSON.stringify(canonical(input)), 'utf8').toString('base64url')
  return `${encoded}.${signature(secret, encoded).toString('base64url')}`
}

export function verifyLarkModelPickerAction(
  secret: string,
  token: string,
  now: number,
): LarkModelPickerActionPayload {
  validateSecret(secret)
  if (typeof token !== 'string' || token.length < 40 || token.length > 8_192 || !Number.isSafeInteger(now)) {
    throw new LarkModelPickerError('invalid', 'model picker action token is invalid')
  }
  const parts = token.split('.')
  if (parts.length !== 2 || !base64urlPattern.test(parts[0]!) || !base64urlPattern.test(parts[1]!)) {
    throw new LarkModelPickerError('invalid', 'model picker action token is invalid')
  }
  const supplied = Buffer.from(parts[1]!, 'base64url')
  const decoded = Buffer.from(parts[0]!, 'base64url')
  const expected = signature(secret, parts[0]!)
  if (supplied.toString('base64url') !== parts[1] || decoded.toString('base64url') !== parts[0]
    || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new LarkModelPickerError('invalid', 'model picker action signature is invalid')
  }
  let payload: LarkModelPickerActionPayload
  try {
    payload = canonical(JSON.parse(decoded.toString('utf8')) as LarkModelPickerActionPayload)
  } catch (error) {
    if (error instanceof LarkModelPickerError) throw error
    throw new LarkModelPickerError('invalid', 'model picker action payload is invalid')
  }
  if (now >= payload.expiresAt) throw new LarkModelPickerError('expired', 'model picker action expired')
  return payload
}
