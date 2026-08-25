import { createHmac, timingSafeEqual } from 'node:crypto'

export interface LarkToolApprovalActionPayload {
  version: 1
  channel: string
  account: string
  tenant: string
  operationId: string
  bindingId: string
  chatId: string
  ownerUser: string
  actionHash: string
  toolName: string
  callId: string
  expiresAt: number
  decision: 'allowed-once' | 'rejected'
}

export class LarkToolApprovalError extends Error {
  constructor(readonly code: 'expired' | 'invalid', message: string) {
    super(message)
    this.name = 'LarkToolApprovalError'
  }
}

const TOKEN_MAX_CHARS = 4_096
const CLAIM_MAX_BYTES = 512
const SIGNATURE_DOMAIN = 'dsh-lark-tool-approval:v1\0'
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,255}$/u
const routeComponentPattern = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,255}$/u

function validateSecret(secret: string): void {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 16) {
    throw new LarkToolApprovalError('invalid', 'tool approval signing key is invalid')
  }
}

function boundedReviewClaim(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= CLAIM_MAX_BYTES
    && !/(?:\p{Cc}|\p{Bidi_Control})/u.test(value)
}

function canonical(input: LarkToolApprovalActionPayload): LarkToolApprovalActionPayload {
  const fields = [
    'version', 'channel', 'account', 'tenant', 'operationId', 'bindingId', 'chatId',
    'ownerUser', 'actionHash', 'toolName', 'callId', 'expiresAt', 'decision',
  ]
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== fields.length
    || Object.keys(input).some(field => !fields.includes(field))
    || input.version !== 1
    || !routeComponentPattern.test(input.channel)
    || !routeComponentPattern.test(input.account)
    || !routeComponentPattern.test(input.tenant)
    || !identifierPattern.test(input.operationId)
    || !identifierPattern.test(input.bindingId)
    || !identifierPattern.test(input.chatId)
    || !identifierPattern.test(input.ownerUser)
    || !/^[a-f0-9]{64}$/u.test(input.actionHash)
    || !boundedReviewClaim(input.toolName)
    || !boundedReviewClaim(input.callId)
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt < 1
    || (input.decision !== 'allowed-once' && input.decision !== 'rejected')) {
    throw new LarkToolApprovalError('invalid', 'tool approval action payload is invalid')
  }
  return {
    version: 1,
    channel: input.channel,
    account: input.account,
    tenant: input.tenant,
    operationId: input.operationId,
    bindingId: input.bindingId,
    chatId: input.chatId,
    ownerUser: input.ownerUser,
    actionHash: input.actionHash,
    toolName: input.toolName,
    callId: input.callId,
    expiresAt: input.expiresAt,
    decision: input.decision,
  }
}

function signature(secret: string, encoded: string): Buffer {
  return createHmac('sha256', secret).update(SIGNATURE_DOMAIN).update(encoded).digest()
}

export function signLarkToolApprovalAction(secret: string, input: LarkToolApprovalActionPayload): string {
  validateSecret(secret)
  const encoded = Buffer.from(JSON.stringify(canonical(input)), 'utf8').toString('base64url')
  const token = `${encoded}.${signature(secret, encoded).toString('base64url')}`
  if (token.length > TOKEN_MAX_CHARS) {
    throw new LarkToolApprovalError('invalid', 'tool approval action token is invalid')
  }
  return token
}

export function verifyLarkToolApprovalAction(
  secret: string,
  token: string,
  now: number,
): LarkToolApprovalActionPayload {
  validateSecret(secret)
  if (typeof token !== 'string' || token.length < 40 || token.length > TOKEN_MAX_CHARS
    || !Number.isSafeInteger(now)) {
    throw new LarkToolApprovalError('invalid', 'tool approval action token is invalid')
  }
  const parts = token.split('.')
  if (parts.length !== 2) throw new LarkToolApprovalError('invalid', 'tool approval action token is invalid')
  const supplied = Buffer.from(parts[1]!, 'utf8')
  const expected = Buffer.from(signature(secret, parts[0]!).toString('base64url'), 'utf8')
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new LarkToolApprovalError('invalid', 'tool approval action signature is invalid')
  }
  let payload: LarkToolApprovalActionPayload
  try {
    payload = canonical(JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as LarkToolApprovalActionPayload)
  } catch (error) {
    if (error instanceof LarkToolApprovalError) throw error
    throw new LarkToolApprovalError('invalid', 'tool approval action payload is invalid')
  }
  if (parts[0] !== Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')) {
    throw new LarkToolApprovalError('invalid', 'tool approval action payload is not canonical')
  }
  if (now >= payload.expiresAt) throw new LarkToolApprovalError('expired', 'tool approval action expired')
  return payload
}
