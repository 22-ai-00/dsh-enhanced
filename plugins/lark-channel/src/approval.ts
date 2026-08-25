import { createHmac, timingSafeEqual } from 'node:crypto'

export interface LarkApprovalActionPayload {
  version: 2
  channel: string
  account: string
  tenant: string
  operationId: string
  bindingId: string
  proposalId: string
  expectedVersion: number
  expiresAt: number
  chatId: string
  diffHash: string
  decision: 'approved' | 'rejected'
}

export class LarkApprovalError extends Error {
  constructor(readonly code: 'expired' | 'invalid', message: string) {
    super(message)
    this.name = 'LarkApprovalError'
  }
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,255}$/u
const routeComponentPattern = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,255}$/u

function validateSecret(secret: string): void {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 16) {
    throw new LarkApprovalError('invalid', 'approval signing key is invalid')
  }
}

function canonical(input: LarkApprovalActionPayload): LarkApprovalActionPayload {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(field => ![
      'version', 'channel', 'account', 'tenant', 'operationId', 'bindingId', 'proposalId',
      'expectedVersion', 'expiresAt', 'chatId', 'diffHash', 'decision',
    ].includes(field))
    || Object.keys(input).length !== 12
    || input.version !== 2
    || !routeComponentPattern.test(input.channel)
    || !routeComponentPattern.test(input.account)
    || !routeComponentPattern.test(input.tenant)
    || !identifierPattern.test(input.operationId)
    || !identifierPattern.test(input.bindingId)
    || !identifierPattern.test(input.proposalId)
    || !identifierPattern.test(input.chatId)
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt < 1
    || typeof input.diffHash !== 'string' || !/^[a-f0-9]{64}$/u.test(input.diffHash)
    || (input.decision !== 'approved' && input.decision !== 'rejected')) {
    throw new LarkApprovalError('invalid', 'approval action payload is invalid')
  }
  return {
    version: 2,
    channel: input.channel,
    account: input.account,
    tenant: input.tenant,
    operationId: input.operationId,
    bindingId: input.bindingId,
    proposalId: input.proposalId,
    expectedVersion: input.expectedVersion,
    expiresAt: input.expiresAt,
    chatId: input.chatId,
    diffHash: input.diffHash,
    decision: input.decision,
  }
}

function signature(secret: string, encoded: string): Buffer {
  return createHmac('sha256', secret).update(encoded).digest()
}

export function signLarkApprovalAction(secret: string, input: LarkApprovalActionPayload): string {
  validateSecret(secret)
  const encoded = Buffer.from(JSON.stringify(canonical(input)), 'utf8').toString('base64url')
  return `${encoded}.${signature(secret, encoded).toString('base64url')}`
}

function verifySignedLarkApprovalAction(secret: string, token: string): LarkApprovalActionPayload {
  validateSecret(secret)
  if (typeof token !== 'string' || token.length < 40 || token.length > 2_048) {
    throw new LarkApprovalError('invalid', 'approval action token is invalid')
  }
  const parts = token.split('.')
  if (parts.length !== 2) throw new LarkApprovalError('invalid', 'approval action token is invalid')
  const supplied = Buffer.from(parts[1]!, 'utf8')
  const expected = Buffer.from(signature(secret, parts[0]!).toString('base64url'), 'utf8')
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new LarkApprovalError('invalid', 'approval action signature is invalid')
  }
  let payload: LarkApprovalActionPayload
  try {
    payload = canonical(JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as LarkApprovalActionPayload)
  } catch (error) {
    if (error instanceof LarkApprovalError) throw error
    throw new LarkApprovalError('invalid', 'approval action payload is invalid')
  }
  const canonicalEncoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  if (parts[0] !== canonicalEncoded) {
    throw new LarkApprovalError('invalid', 'approval action payload is not canonical')
  }
  return payload
}

export function verifyLarkApprovalAction(secret: string, token: string, now: number): LarkApprovalActionPayload {
  if (!Number.isSafeInteger(now)) throw new LarkApprovalError('invalid', 'approval action token is invalid')
  const payload = verifySignedLarkApprovalAction(secret, token)
  if (now >= payload.expiresAt) throw new LarkApprovalError('expired', 'approval action expired')
  return payload
}

/**
 * Authenticates an expired callback without making it a fresh approval capability.
 * Callers may use the result only to recover an already-terminal durable settlement.
 */
export function verifyLarkApprovalActionForRecovery(secret: string, token: string): LarkApprovalActionPayload {
  return verifySignedLarkApprovalAction(secret, token)
}
