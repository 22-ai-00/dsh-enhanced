import { createHmac, timingSafeEqual } from 'node:crypto'

export type LarkUserQuestionAction = 'select' | 'toggle' | 'submit' | 'cancel'

export interface LarkUserQuestionActionPayload {
  version: 1
  channel: string
  account: string
  tenant: string
  rpcId: string
  sessionId: string
  bindingId: string
  bindingVersion: number
  bindingGeneration: number
  chatId: string
  ownerUser: string
  requestHash: string
  questionIndex: number
  optionIndex: number | null
  action: LarkUserQuestionAction
  revision: number
  expiresAt: number
}

export interface LarkUserQuestionCallbackValue {
  userQuestion: string
}

export class LarkUserQuestionError extends Error {
  constructor(readonly code: 'expired' | 'invalid', message: string) {
    super(message)
    this.name = 'LarkUserQuestionError'
  }
}

const TOKEN_MIN_CHARS = 40
const TOKEN_MAX_CHARS = 4_096
const SIGNATURE_DOMAIN = 'dsh-lark-user-question:v1\0'
const payloadFields = [
  'version', 'channel', 'account', 'tenant', 'rpcId', 'sessionId', 'bindingId', 'bindingVersion',
  'bindingGeneration', 'chatId', 'ownerUser', 'requestHash', 'questionIndex', 'optionIndex',
  'action', 'revision', 'expiresAt',
] as const
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,255}$/u
const routeComponentPattern = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,255}$/u
const hashPattern = /^[a-f0-9]{64}$/u
const base64urlPattern = /^[A-Za-z0-9_-]+$/u

function invalid(message: string): LarkUserQuestionError {
  return new LarkUserQuestionError('invalid', message)
}

function validateSecret(secret: string): void {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 16) {
    throw invalid('user question signing key is invalid')
  }
}

function routeComponent(value: unknown): value is string {
  return typeof value === 'string' && routeComponentPattern.test(value)
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && identifierPattern.test(value)
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function actionHasOption(action: LarkUserQuestionAction): boolean {
  return action === 'select' || action === 'toggle'
}

function canonical(input: LarkUserQuestionActionPayload): LarkUserQuestionActionPayload {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('user question action payload is invalid')
  }
  const keys = Reflect.ownKeys(input)
  if (keys.length !== payloadFields.length
    || keys.some(field => typeof field !== 'string' || !payloadFields.includes(
      field as (typeof payloadFields)[number],
    ))
    || input.version !== 1
    || !routeComponent(input.channel)
    || !routeComponent(input.account)
    || !routeComponent(input.tenant)
    || !identifier(input.rpcId)
    || !identifier(input.sessionId)
    || !identifier(input.bindingId)
    || !positiveSafeInteger(input.bindingVersion)
    || !positiveSafeInteger(input.bindingGeneration)
    || !identifier(input.chatId)
    || !identifier(input.ownerUser)
    || typeof input.requestHash !== 'string' || !hashPattern.test(input.requestHash)
    || !nonnegativeSafeInteger(input.questionIndex)
    || (input.action !== 'select' && input.action !== 'toggle'
      && input.action !== 'submit' && input.action !== 'cancel')
    || (actionHasOption(input.action)
      ? !nonnegativeSafeInteger(input.optionIndex)
      : input.optionIndex !== null)
    || !nonnegativeSafeInteger(input.revision)
    || !positiveSafeInteger(input.expiresAt)) {
    throw invalid('user question action payload is invalid')
  }
  return {
    version: 1,
    channel: input.channel,
    account: input.account,
    tenant: input.tenant,
    rpcId: input.rpcId,
    sessionId: input.sessionId,
    bindingId: input.bindingId,
    bindingVersion: input.bindingVersion,
    bindingGeneration: input.bindingGeneration,
    chatId: input.chatId,
    ownerUser: input.ownerUser,
    requestHash: input.requestHash,
    questionIndex: input.questionIndex,
    optionIndex: input.optionIndex,
    action: input.action,
    revision: input.revision,
    expiresAt: input.expiresAt,
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

export function parseLarkUserQuestionCallback(value: unknown): LarkUserQuestionCallbackValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('user question callback value is invalid')
  }
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 1 || keys[0] !== 'userQuestion') {
    throw invalid('user question callback value is invalid')
  }
  const callback = value as { userQuestion?: unknown }
  if (tokenParts(callback.userQuestion) === undefined) {
    throw invalid('user question callback value is invalid')
  }
  return { userQuestion: callback.userQuestion as string }
}

function signature(secret: string, encoded: string): Buffer {
  return createHmac('sha256', secret).update(SIGNATURE_DOMAIN).update(encoded).digest()
}

export function signLarkUserQuestionAction(secret: string, input: LarkUserQuestionActionPayload): string {
  validateSecret(secret)
  const encoded = Buffer.from(JSON.stringify(canonical(input)), 'utf8').toString('base64url')
  const token = `${encoded}.${signature(secret, encoded).toString('base64url')}`
  if (token.length > TOKEN_MAX_CHARS) throw invalid('user question action token is invalid')
  return token
}

export function verifyLarkUserQuestionAction(
  secret: string,
  token: string,
  now: number,
): LarkUserQuestionActionPayload {
  validateSecret(secret)
  if (!Number.isSafeInteger(now)) throw invalid('user question action token is invalid')
  const parts = tokenParts(token)
  if (parts === undefined) throw invalid('user question action token is invalid')

  const supplied = Buffer.from(parts[1], 'base64url')
  const decoded = Buffer.from(parts[0], 'base64url')
  const expected = signature(secret, parts[0])
  if (supplied.toString('base64url') !== parts[1]
    || decoded.toString('base64url') !== parts[0]
    || supplied.length !== expected.length
    || !timingSafeEqual(supplied, expected)) {
    throw invalid('user question action signature is invalid')
  }

  let payload: LarkUserQuestionActionPayload
  try {
    payload = canonical(JSON.parse(decoded.toString('utf8')) as LarkUserQuestionActionPayload)
  } catch (error) {
    if (error instanceof LarkUserQuestionError) throw error
    throw invalid('user question action payload is invalid')
  }
  const canonicalEncoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  if (parts[0] !== canonicalEncoded) throw invalid('user question action payload is not canonical')
  if (now >= payload.expiresAt) throw new LarkUserQuestionError('expired', 'user question action expired')
  return payload
}
