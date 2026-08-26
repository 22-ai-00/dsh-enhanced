import { createHmac, timingSafeEqual } from 'node:crypto'

export type LarkPermissionLevel = 'ask' | 'auto' | 'full'

export interface LarkPermissionPickerActionPayload {
  version: 2
  channel: string
  account: string
  tenant: string
  operationId: string
  bindingId: string
  bindingVersion: number
  sessionId: string
  chatId: string
  ownerUser: string
  issuedAt: number
  expiresAt: number
  expectedStateHash: string
  emergencyStopVersion: number
  level: LarkPermissionLevel
}

export interface LarkPermissionPickerCallbackValue {
  permissionPicker: string
}

export class LarkPermissionPickerError extends Error {
  constructor(readonly code: 'expired' | 'invalid', message: string) {
    super(message)
    this.name = 'LarkPermissionPickerError'
  }
}

const TOKEN_MIN_CHARS = 40
const TOKEN_MAX_CHARS = 4_096
const SIGNATURE_DOMAIN = 'dsh-lark-permission-picker:v2\0'
const payloadFields = [
  'version', 'channel', 'account', 'tenant', 'operationId', 'bindingId', 'bindingVersion',
  'sessionId', 'chatId', 'ownerUser', 'issuedAt', 'expiresAt', 'expectedStateHash',
  'emergencyStopVersion', 'level',
] as const
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,255}$/u
const routeComponentPattern = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,255}$/u
const stateHashPattern = /^[a-f0-9]{64}$/u
const base64urlPattern = /^[A-Za-z0-9_-]+$/u

function invalid(message: string): LarkPermissionPickerError {
  return new LarkPermissionPickerError('invalid', message)
}

function validateSecret(secret: string): void {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 16) {
    throw invalid('permission picker signing key is invalid')
  }
}

function routeComponent(value: unknown): value is string {
  return typeof value === 'string' && routeComponentPattern.test(value)
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && identifierPattern.test(value)
}

function canonical(input: LarkPermissionPickerActionPayload): LarkPermissionPickerActionPayload {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('permission picker action payload is invalid')
  }
  const keys = Reflect.ownKeys(input)
  if (keys.length !== payloadFields.length
    || keys.some(field => typeof field !== 'string' || !payloadFields.includes(
      field as (typeof payloadFields)[number],
    ))
    || input.version !== 2
    || !routeComponent(input.channel)
    || !routeComponent(input.account)
    || !routeComponent(input.tenant)
    || !identifier(input.operationId)
    || !identifier(input.bindingId)
    || !Number.isSafeInteger(input.bindingVersion) || input.bindingVersion < 1
    || !identifier(input.sessionId)
    || !identifier(input.chatId)
    || !identifier(input.ownerUser)
    || !Number.isSafeInteger(input.issuedAt) || input.issuedAt < 1
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= input.issuedAt
    || typeof input.expectedStateHash !== 'string' || !stateHashPattern.test(input.expectedStateHash)
    || !Number.isSafeInteger(input.emergencyStopVersion) || input.emergencyStopVersion < 0
    || (input.level !== 'ask' && input.level !== 'auto' && input.level !== 'full')) {
    throw invalid('permission picker action payload is invalid')
  }
  return {
    version: 2,
    channel: input.channel,
    account: input.account,
    tenant: input.tenant,
    operationId: input.operationId,
    bindingId: input.bindingId,
    bindingVersion: input.bindingVersion,
    sessionId: input.sessionId,
    chatId: input.chatId,
    ownerUser: input.ownerUser,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    expectedStateHash: input.expectedStateHash,
    emergencyStopVersion: input.emergencyStopVersion,
    level: input.level,
  }
}

function tokenParts(value: unknown): readonly [string, string] | undefined {
  if (typeof value !== 'string' || value.length < TOKEN_MIN_CHARS || value.length > TOKEN_MAX_CHARS) {
    return undefined
  }
  const parts = value.split('.')
  if (parts.length !== 2 || !base64urlPattern.test(parts[0]!) || !base64urlPattern.test(parts[1]!)) {
    return undefined
  }
  return [parts[0]!, parts[1]!]
}

export function parseLarkPermissionPickerCallback(value: unknown): LarkPermissionPickerCallbackValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('permission picker callback value is invalid')
  }
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 1 || keys[0] !== 'permissionPicker') {
    throw invalid('permission picker callback value is invalid')
  }
  const callback = value as { permissionPicker?: unknown }
  if (tokenParts(callback.permissionPicker) === undefined) {
    throw invalid('permission picker callback value is invalid')
  }
  return { permissionPicker: callback.permissionPicker as string }
}

function signature(secret: string, encoded: string): Buffer {
  return createHmac('sha256', secret).update(SIGNATURE_DOMAIN).update(encoded).digest()
}

export function signLarkPermissionPickerAction(
  secret: string,
  input: LarkPermissionPickerActionPayload,
): string {
  validateSecret(secret)
  const encoded = Buffer.from(JSON.stringify(canonical(input)), 'utf8').toString('base64url')
  const token = `${encoded}.${signature(secret, encoded).toString('base64url')}`
  if (token.length > TOKEN_MAX_CHARS) throw invalid('permission picker action token is invalid')
  return token
}

export function verifyLarkPermissionPickerAction(
  secret: string,
  token: string,
  now: number,
): LarkPermissionPickerActionPayload {
  validateSecret(secret)
  if (!Number.isSafeInteger(now)) throw invalid('permission picker action token is invalid')
  const parts = tokenParts(token)
  if (parts === undefined) throw invalid('permission picker action token is invalid')

  const supplied = Buffer.from(parts[1], 'base64url')
  const decoded = Buffer.from(parts[0], 'base64url')
  const expected = signature(secret, parts[0])
  if (supplied.toString('base64url') !== parts[1]
    || decoded.toString('base64url') !== parts[0]
    || supplied.length !== expected.length
    || !timingSafeEqual(supplied, expected)) {
    throw invalid('permission picker action signature is invalid')
  }

  let payload: LarkPermissionPickerActionPayload
  try {
    payload = canonical(JSON.parse(decoded.toString('utf8')) as LarkPermissionPickerActionPayload)
  } catch (error) {
    if (error instanceof LarkPermissionPickerError) throw error
    throw invalid('permission picker action payload is invalid')
  }
  const canonicalEncoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  if (parts[0] !== canonicalEncoded) throw invalid('permission picker action payload is not canonical')
  if (now >= payload.expiresAt) throw new LarkPermissionPickerError('expired', 'permission picker action expired')
  return payload
}
