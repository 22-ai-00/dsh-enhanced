import { createHmac, timingSafeEqual } from 'node:crypto'

export interface LarkModelPickerActionPayload {
  version: 1
  operationId: string
  bindingId: string
  expiresAt: number
  chatId: string
}

export class LarkModelPickerError extends Error {
  constructor(readonly code: 'expired' | 'invalid', message: string) {
    super(message)
    this.name = 'LarkModelPickerError'
  }
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,255}$/u

function validateSecret(secret: string): void {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 16) {
    throw new LarkModelPickerError('invalid', 'model picker signing key is invalid')
  }
}

function canonical(input: LarkModelPickerActionPayload): LarkModelPickerActionPayload {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(field => !['version', 'operationId', 'bindingId', 'expiresAt', 'chatId'].includes(field))
    || Object.keys(input).length !== 5
    || input.version !== 1
    || !identifierPattern.test(input.operationId)
    || !identifierPattern.test(input.bindingId)
    || !identifierPattern.test(input.chatId)
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt < 1) {
    throw new LarkModelPickerError('invalid', 'model picker action payload is invalid')
  }
  return { version: 1, operationId: input.operationId, bindingId: input.bindingId,
    expiresAt: input.expiresAt, chatId: input.chatId }
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
  if (typeof token !== 'string' || token.length < 40 || token.length > 2_048 || !Number.isSafeInteger(now)) {
    throw new LarkModelPickerError('invalid', 'model picker action token is invalid')
  }
  const parts = token.split('.')
  if (parts.length !== 2) throw new LarkModelPickerError('invalid', 'model picker action token is invalid')
  const supplied = Buffer.from(parts[1]!, 'base64url')
  const expected = signature(secret, parts[0]!)
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new LarkModelPickerError('invalid', 'model picker action signature is invalid')
  }
  let payload: LarkModelPickerActionPayload
  try {
    payload = canonical(JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as LarkModelPickerActionPayload)
  } catch (error) {
    if (error instanceof LarkModelPickerError) throw error
    throw new LarkModelPickerError('invalid', 'model picker action payload is invalid')
  }
  if (now >= payload.expiresAt) throw new LarkModelPickerError('expired', 'model picker action expired')
  return payload
}
