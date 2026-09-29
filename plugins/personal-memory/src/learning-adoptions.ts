import {
  growthObjectDigest, memoryLearningRequestDigest, validateMemoryLearningOwner,
  validateMemoryLearningReviewRequest, type MemoryLearningOwner, type MemoryLearningReviewRequest,
} from '@dsh-enhanced/assistant-growth-contract'
import type { MemoryRecord } from './types.js'

export interface MemoryLearningAdoptionGrant {
  authorityId: string
  owner: MemoryLearningOwner
  reviewAuthorityId: string
  reviewAuthorityDigest: string
  expiresAt: number
  maxMutations: number
  maxTotalContentBytes: number
  maxRecordTtlMs: number
  kinds: readonly ('fact' | 'experience')[]
  operations: readonly ('add' | 'replace' | 'remove')[]
}

export interface MemoryLearningReviewReceipt {
  protocol: 'memory-learning-review-receipt/v1'
  operationId: string
  requestDigest: string
  authorityId: string
  authorityDigest: string
  sessionId: string
  model: { provider: string; model: string; reasoningEffort?: string }
  status: 'approved' | 'rejected' | 'unknown'
  reason: string
  outputDigest?: string
  receiptDigest: string
}

export interface MemoryLearningAdoptionResult {
  protocol: 'memory-learning-adoption/v1'
  authorityId: string
  operationId: string
  requestDigest: string
  reviewReceiptDigest: string
  record: MemoryRecord
  recordDigest: string
  adoptedAt: number
  receiptDigest: string
}

export interface MemoryLearningManagedSource {
  authorityId: string
  request: MemoryLearningReviewRequest
  id: string
  version: number
  recordDigest: string
  sourceDigest: string
}

export interface MemoryLearningValidatedRef {
  id: string
  version: number
  recordDigest: string
}

export interface MemoryLearningAdoptionCommit {
  grant: MemoryLearningAdoptionGrant
  request: MemoryLearningReviewRequest
  reviewReceipt: MemoryLearningReviewReceipt
  sourceObservedAt: number
}

export interface MemoryLearningTargetInput {
  owner: MemoryLearningOwner
  id: string
  expectedVersion: number
}

export type MemoryLearningTarget = Readonly<{
  id: string
  version: number
  managed: true
  kind: 'fact' | 'experience'
  content: string
  knowledge?: MemoryRecord['knowledge']
}>

export type MemoryLearningTargetSummary = Readonly<Omit<MemoryLearningTarget, 'managed'>>

/** Current, read-only view of a frozen Host grant and its remaining budget. */
export type MemoryLearningAdoptionAvailability = Readonly<{
  authorityId: string
  grantDigest: string
  expiresAt: number
  remainingMutations: number
  remainingContentBytes: number
  available: boolean
}>

export interface MemoryLearningSourceInvalidation {
  owner: MemoryLearningOwner
  id: string
  version: number
  recordDigest: string
  sourceDigest: string
  reason: 'withdrawn' | 'source-changed'
}

const sha = /^[0-9a-f]{64}$/u
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u
function fail(message: string): never { throw new Error(`memory learning adoption: ${message}`) }
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid object')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))
    || required.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(field => !field.enumerable || !('value' in field))) fail('invalid fields')
  return value as Record<string, unknown>
}
function id(value: unknown): void { if (typeof value !== 'string' || !identifier.test(value)) fail('invalid id') }
function digest(value: unknown): void { if (typeof value !== 'string' || !sha.test(value)) fail('invalid digest') }
function integer(value: unknown, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail('invalid bound')
}
function choices<T extends string>(value: unknown, allowed: readonly T[]): void {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < 1 || value.length > allowed.length
    || Reflect.ownKeys(value).length !== value.length + 1) fail('invalid choices')
  const seen = new Set<T>()
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
      || !allowed.includes(descriptor.value as T) || seen.has(descriptor.value as T)) fail('invalid choices')
    seen.add(descriptor.value as T)
  }
}
export function validateLearningGrant(value: unknown): Readonly<MemoryLearningAdoptionGrant> {
  const grant = exact(value, ['authorityId', 'owner', 'reviewAuthorityId', 'reviewAuthorityDigest',
    'expiresAt', 'maxMutations', 'maxTotalContentBytes', 'maxRecordTtlMs', 'kinds', 'operations'])
  id(grant.authorityId); id(grant.reviewAuthorityId); digest(grant.reviewAuthorityDigest)
  validateMemoryLearningOwner(grant.owner)
  integer(grant.expiresAt, 1, Number.MAX_SAFE_INTEGER)
  integer(grant.maxMutations, 1, 1_000)
  integer(grant.maxTotalContentBytes, 1, 16_384_000)
  integer(grant.maxRecordTtlMs, 1, 365 * 24 * 60 * 60 * 1_000)
  choices(grant.kinds, ['fact', 'experience']); choices(grant.operations, ['add', 'replace', 'remove'])
  return Object.freeze(structuredClone(value) as MemoryLearningAdoptionGrant)
}
export const validateMemoryLearningAdoptionGrant = validateLearningGrant

export function validateLearningReviewReceipt(value: unknown,
  request: MemoryLearningReviewRequest, grant: MemoryLearningAdoptionGrant): Readonly<MemoryLearningReviewReceipt> {
  const receipt = exact(value, ['protocol', 'operationId', 'requestDigest', 'authorityId', 'authorityDigest',
    'sessionId', 'model', 'status', 'reason', 'outputDigest', 'receiptDigest'])
  if (receipt.protocol !== 'memory-learning-review-receipt/v1' || receipt.status !== 'approved'
    || receipt.operationId !== request.operationId || receipt.requestDigest !== memoryLearningRequestDigest(request)
    || receipt.authorityId !== grant.reviewAuthorityId || receipt.authorityDigest !== grant.reviewAuthorityDigest) fail('review binding mismatch')
  id(receipt.sessionId); digest(receipt.outputDigest); digest(receipt.receiptDigest)
  if (typeof receipt.reason !== 'string' || !receipt.reason.trim() || Buffer.byteLength(receipt.reason) > 4096) fail('review reason')
  const model = exact(receipt.model, ['provider', 'model'], ['reasoningEffort'])
  for (const value of [model.provider, model.model, model.reasoningEffort].filter(value => value !== undefined)) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !value.isWellFormed()
      || Buffer.byteLength(value) > 256) fail('review model')
  }
  const { receiptDigest, ...body } = receipt
  if (growthObjectDigest(body) !== receiptDigest) fail('review receipt digest')
  return Object.freeze(structuredClone(value) as MemoryLearningReviewReceipt)
}

export function validateLearningRequest(value: unknown): MemoryLearningReviewRequest {
  return validateMemoryLearningReviewRequest(value)
}

export function learningGrantDigest(grant: MemoryLearningAdoptionGrant): string { return growthObjectDigest(grant) }
export function learningRecordDigest(record: MemoryRecord): string { return growthObjectDigest(record) }
export function learningResultDigest(result: Omit<MemoryLearningAdoptionResult, 'receiptDigest'>): string {
  return growthObjectDigest(result)
}
