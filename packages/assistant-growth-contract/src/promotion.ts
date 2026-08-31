import { isAbsolute, resolve } from 'node:path'
import {
  AssistantGrowthContractError,
  assertExactGrowthKeys,
  exactGrowthDigest,
  growthObjectDigest,
  isGrowthRecord,
} from './canonical.js'

/** Private Host protocol between Preference Learning and Personal Memory. */
export const PREFERENCE_MEMORY_PROMOTION_PROTOCOL =
  'assistant-growth/preference-memory-promotion/v1' as const
export const PREFERENCE_MEMORY_PROMOTION_REQUEST_PROTOCOL =
  'assistant-growth/preference-memory-promotion-request/v1' as const
export const PREFERENCE_MEMORY_PROMOTION_SUBMISSION_PROTOCOL =
  'assistant-growth/preference-memory-promotion-submission/v1' as const
export const PREFERENCE_MEMORY_PROMOTION_RESULT_PROTOCOL =
  'assistant-growth/preference-memory-promotion-result/v1' as const
export const PREFERENCE_MEMORY_PROMOTION_CANCELLATION_PROTOCOL =
  'assistant-growth/preference-memory-promotion-cancellation/v1' as const

/** The first release deliberately supports exactly one low-sensitivity T2 pair. */
export const PREFERENCE_MEMORY_PROMOTION_KEY = 'memory.retention' as const
export const PREFERENCE_MEMORY_PROMOTION_VALUE = 'long-term' as const
export const PREFERENCE_MEMORY_PROMOTION_RENDERER_ID =
  'memory.retention.long-term/v1' as const
export const PREFERENCE_MEMORY_PROMOTION_CONTENT =
  'Retain information the owner explicitly confirms for long-term memory.' as const

export interface PreferenceMemoryPromotionScope {
  workspace: string
  preset: string
}

export interface PreferenceMemoryPromotionPrincipalLineage {
  principalRecordId: string
  principalVersion: number
}

/** Content-free evidence summary; signal bodies and free-form text never cross this port. */
export interface PreferenceMemoryPromotionHypothesis {
  id: string
  key: typeof PREFERENCE_MEMORY_PROMOTION_KEY
  value: typeof PREFERENCE_MEMORY_PROMOTION_VALUE
  version: number
  confidenceBps: number
  contradictionBps: number
  supportingSignals: number
  distinctSignalSources: number
  evidenceMass: number
}

export interface PreferenceMemoryPromotionRequest {
  contractVersion: 1
  promotionId: string
  /** Durable generation of this exact logical promotion, independent of owner generation. */
  promotionGeneration: number
  requestDigest: string
  idempotencyKey: string
  scope: Readonly<PreferenceMemoryPromotionScope>
  principalId: string
  principalLineage: Readonly<PreferenceMemoryPromotionPrincipalLineage>
  ownerGeneration: number
  hypothesis: Readonly<PreferenceMemoryPromotionHypothesis>
  rendererId: typeof PREFERENCE_MEMORY_PROMOTION_RENDERER_ID
  observedAt: number
  deadlineAt: number
}

/** ACK that Personal Memory durably accepted the immutable request. */
export interface PreferenceMemoryPromotionSubmissionReceipt {
  contractVersion: 1
  promotionId: string
  promotionGeneration: number
  requestDigest: string
  outcome: 'accepted' | 'replayed'
  memoryProposalId: string
  receiptDigest: string
}

export type PreferenceMemoryPromotionTerminalStatus =
  | 'confirmed'
  | 'rejected'
  | 'expired'
  | 'conflicted'
  | 'stale-owner'

interface PreferenceMemoryPromotionResultIdentity {
  contractVersion: 1
  promotionId: string
  promotionGeneration: number
  requestDigest: string
  resultVersion: number
  occurredAt: number
  receiptDigest: string
}

/**
 * Authoritative terminal projection produced by Personal Memory. `confirmed`
 * is legal only after its Memory record committed. `rejected` is reserved for
 * an explicit owner rejection; all other failures remain distinct.
 */
export type PreferenceMemoryPromotionResult = PreferenceMemoryPromotionResultIdentity & (
  | {
      status: 'confirmed'
      memoryProposalId: string
      memoryProposalVersion: number
      memoryRecordId: string
      memoryRecordVersion: number
      memoryRecordDigest: string
    }
  | {
      status: 'rejected'
      rejectionKind: 'owner-explicit'
      memoryProposalId: string
      memoryProposalVersion: number
    }
  | {
      status: 'expired' | 'conflicted'
      memoryProposalId: string
      memoryProposalVersion: number
    }
  | { status: 'stale-owner' }
)

/** Preference commits the projection before returning this Memory outbox ACK. */
export interface PreferenceMemoryPromotionResultAck {
  contractVersion: 1
  promotionId: string
  promotionGeneration: number
  resultVersion: number
  receiptDigest: string
  outcome: 'applied' | 'replayed' | 'cancelled'
}

export type PreferenceMemoryPromotionCancellationReason =
  | 'forget'
  | 'owner-rotated'
  | 'superseded'

export interface PreferenceMemoryPromotionCancellationRequest {
  contractVersion: 1
  promotionId: string
  promotionGeneration: number
  requestDigest: string
  principalLineage: Readonly<PreferenceMemoryPromotionPrincipalLineage>
  ownerGeneration: number
  reason: PreferenceMemoryPromotionCancellationReason
  occurredAt: number
  cancellationDigest: string
}

export interface PreferenceMemoryPromotionCancellationReceipt {
  contractVersion: 1
  promotionId: string
  promotionGeneration: number
  requestDigest: string
  cancellationDigest: string
  /** `already-confirmed` is safe only for non-destructive supersession. */
  outcome: 'cancelled' | 'replayed' | 'already-confirmed'
  receiptDigest: string
}

/** Process-local ownership proof for the Memory-minted registration. */
export interface PreferencePromotionSourceRegistrationOwner {
  ownsPreferencePromotionSourceRegistration(
    registration: Readonly<PreferenceMemoryPromotionRegistration>,
  ): boolean
}

/**
 * Single bidirectional, revocable capability minted by Personal Memory for one
 * exact live Preference producer generation. Neither side receives the other
 * service's general API.
 */
export interface PreferenceMemoryPromotionRegistration {
  readonly protocol: typeof PREFERENCE_MEMORY_PROMOTION_PROTOCOL
  readonly producer: 'personal-memory'
  readonly sourceGeneration: string
  readonly sinkGeneration: string
  readonly owner: PreferencePromotionSourceRegistrationOwner
  propose(
    request: Readonly<PreferenceMemoryPromotionRequest>,
  ): Readonly<PreferenceMemoryPromotionSubmissionReceipt>
  cancelPromotion(
    request: Readonly<PreferenceMemoryPromotionCancellationRequest>,
  ): Readonly<PreferenceMemoryPromotionCancellationReceipt>
  listTerminalResults(limit: number): readonly Readonly<PreferenceMemoryPromotionResult>[]
  acknowledgeTerminalResult(ack: Readonly<PreferenceMemoryPromotionResultAck>): void
}

/** Structural Host service contract; authenticity is checked by this shared contract's brand. */
export interface PreferenceMemoryPromotionProducer {
  trustedMemoryPromotionProducerGeneration(): string
  registerTrustedMemoryPromotionResultSink(
    registration: Readonly<PreferenceMemoryPromotionRegistration>,
  ): () => void
}

const trustedPreferenceMemoryPromotionProducers = new WeakSet<object>()
const preferenceMemoryPromotionProducerProbe = Symbol(
  'assistant-growth-contract.preference-memory-promotion-producer-probe',
)

/**
 * Marks the exact live Preference producer owned by the producer package. The
 * private probe lets Cordis wrappers resolve back to that exact object without
 * making a structural lookalike authentic. This is a process-local composition
 * guard, not a sandbox boundary against already-trusted Host code.
 */
export function brandPreferenceMemoryPromotionProducer(
  producer: PreferenceMemoryPromotionProducer,
): void {
  if (typeof producer !== 'object' || producer === null) {
    throw new TypeError('preference Memory promotion producer must be an object')
  }
  const exact = producer as object
  const current = Object.getOwnPropertyDescriptor(exact, preferenceMemoryPromotionProducerProbe)
  if (current === undefined) {
    Object.defineProperty(exact, preferenceMemoryPromotionProducerProbe, {
      value: () => exact,
      enumerable: false,
      configurable: false,
      writable: false,
    })
  } else if (typeof current.value !== 'function' || current.value() !== exact) {
    throw new TypeError('preference Memory promotion producer brand is invalid')
  }
  trustedPreferenceMemoryPromotionProducers.add(exact)
}

/** Revokes the exact producer brand when its owning service is disposed. */
export function unbrandPreferenceMemoryPromotionProducer(
  producer: PreferenceMemoryPromotionProducer,
): void {
  if (typeof producer === 'object' && producer !== null) {
    trustedPreferenceMemoryPromotionProducers.delete(producer)
  }
}

/**
 * Resolves a Cordis forwarding wrapper to the exact producer object that owns
 * the process-local brand. Consumers must bind and invoke this object, never
 * the caller-controlled wrapper used to discover it.
 */
export function resolveTrustedPreferenceMemoryPromotionProducer(
  value: unknown,
): PreferenceMemoryPromotionProducer | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  try {
    const probe = (value as Record<PropertyKey, unknown>)[preferenceMemoryPromotionProducerProbe]
    if (typeof probe !== 'function') return undefined
    const exact = (probe as () => unknown)()
    if (typeof exact !== 'object' || exact === null
      || !trustedPreferenceMemoryPromotionProducers.has(exact)) return undefined
    return exact as PreferenceMemoryPromotionProducer
  } catch {
    return undefined
  }
}

/** Process-local authenticity predicate shared by the producer and consumer. */
export function isTrustedPreferenceMemoryPromotionProducer(
  value: unknown,
): value is PreferenceMemoryPromotionProducer {
  return resolveTrustedPreferenceMemoryPromotionProducer(value) !== undefined
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,999}$/u
const presetPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u

function invalid(message: string): never {
  throw new AssistantGrowthContractError('invalid-input', message)
}

function identifier(value: unknown, label: string, maxBytes = 1_000): string {
  if (typeof value !== 'string' || value.normalize('NFC').trim() !== value || value === ''
    || Buffer.byteLength(value, 'utf8') > maxBytes || !identifierPattern.test(value)) {
    invalid(`${label} is invalid`)
  }
  return value
}

function canonicalPrincipal(value: unknown): string {
  if (typeof value !== 'string' || value.normalize('NFC').trim() !== value || value === ''
    || Buffer.byteLength(value, 'utf8') > 4_096
    || [...value].some(character => {
      const codePoint = character.codePointAt(0)!
      return codePoint <= 0x1f || codePoint === 0x7f
    })) {
    invalid('promotion principalId is invalid')
  }
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(`${label} is invalid`)
  return value as number
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(`${label} is invalid`)
  return value as number
}

function basisPoints(value: unknown, label: string): number {
  const normalized = nonNegativeInteger(value, label)
  if (normalized > 10_000) invalid(`${label} is invalid`)
  return normalized
}

function validateScope(value: unknown): Readonly<PreferenceMemoryPromotionScope> {
  if (!isGrowthRecord(value)) invalid('promotion scope must be an object')
  assertExactGrowthKeys(value, ['workspace', 'preset'], 'promotion scope')
  if (typeof value['workspace'] !== 'string' || !isAbsolute(value['workspace'])
    || resolve(value['workspace']) !== value['workspace']) {
    invalid('promotion workspace is invalid')
  }
  const preset = identifier(value['preset'], 'promotion preset', 200)
  if (!presetPattern.test(preset)) invalid('promotion preset is invalid')
  return Object.freeze({ workspace: value['workspace'], preset })
}

function validateLineage(value: unknown): Readonly<PreferenceMemoryPromotionPrincipalLineage> {
  if (!isGrowthRecord(value)) invalid('promotion principal lineage must be an object')
  assertExactGrowthKeys(value, ['principalRecordId', 'principalVersion'], 'promotion principal lineage')
  return Object.freeze({
    principalRecordId: identifier(value['principalRecordId'], 'principalRecordId'),
    principalVersion: positiveInteger(value['principalVersion'], 'principalVersion'),
  })
}

function validateHypothesis(value: unknown): Readonly<PreferenceMemoryPromotionHypothesis> {
  if (!isGrowthRecord(value)) invalid('promotion hypothesis must be an object')
  assertExactGrowthKeys(value, [
    'id', 'key', 'value', 'version', 'confidenceBps', 'contradictionBps',
    'supportingSignals', 'distinctSignalSources', 'evidenceMass',
  ], 'promotion hypothesis')
  if (value['key'] !== PREFERENCE_MEMORY_PROMOTION_KEY
    || value['value'] !== PREFERENCE_MEMORY_PROMOTION_VALUE) {
    invalid('promotion hypothesis is outside the fixed allowlist')
  }
  return Object.freeze({
    id: identifier(value['id'], 'hypothesis id'),
    key: PREFERENCE_MEMORY_PROMOTION_KEY,
    value: PREFERENCE_MEMORY_PROMOTION_VALUE,
    version: positiveInteger(value['version'], 'hypothesis version'),
    confidenceBps: basisPoints(value['confidenceBps'], 'hypothesis confidenceBps'),
    contradictionBps: basisPoints(value['contradictionBps'], 'hypothesis contradictionBps'),
    supportingSignals: positiveInteger(value['supportingSignals'], 'hypothesis supportingSignals'),
    distinctSignalSources: positiveInteger(
      value['distinctSignalSources'],
      'hypothesis distinctSignalSources',
    ),
    evidenceMass: positiveInteger(value['evidenceMass'], 'hypothesis evidenceMass'),
  })
}

function requestPayload(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'requestDigest'))
}

export function preferenceMemoryPromotionRequestDigest(value: unknown): string {
  if (!isGrowthRecord(value)) invalid('promotion request digest input must be an object')
  return growthObjectDigest({
    contract: PREFERENCE_MEMORY_PROMOTION_REQUEST_PROTOCOL,
    request: requestPayload(value),
  })
}

export function withPreferenceMemoryPromotionRequestDigest<
  T extends Readonly<Record<string, unknown>>,
>(value: T): Readonly<T & { requestDigest: string }> {
  if (Object.hasOwn(value, 'requestDigest')) invalid('promotion request already contains requestDigest')
  return Object.freeze({ ...value, requestDigest: preferenceMemoryPromotionRequestDigest(value) })
}

export function validatePreferenceMemoryPromotionRequest(
  value: unknown,
): Readonly<PreferenceMemoryPromotionRequest> {
  if (!isGrowthRecord(value)) invalid('preference Memory promotion request must be an object')
  assertExactGrowthKeys(value, [
    'contractVersion', 'promotionId', 'promotionGeneration', 'requestDigest',
    'idempotencyKey', 'scope', 'principalId', 'principalLineage', 'ownerGeneration',
    'hypothesis', 'rendererId', 'observedAt', 'deadlineAt',
  ], 'preference Memory promotion request')
  if (value['contractVersion'] !== 1
    || value['rendererId'] !== PREFERENCE_MEMORY_PROMOTION_RENDERER_ID) {
    invalid('preference Memory promotion contract or renderer is invalid')
  }
  const request = Object.freeze({
    contractVersion: 1 as const,
    promotionId: identifier(value['promotionId'], 'promotionId'),
    promotionGeneration: positiveInteger(value['promotionGeneration'], 'promotionGeneration'),
    requestDigest: exactGrowthDigest(value['requestDigest'], 'requestDigest'),
    idempotencyKey: identifier(value['idempotencyKey'], 'idempotencyKey'),
    scope: validateScope(value['scope']),
    principalId: canonicalPrincipal(value['principalId']),
    principalLineage: validateLineage(value['principalLineage']),
    ownerGeneration: positiveInteger(value['ownerGeneration'], 'ownerGeneration'),
    hypothesis: validateHypothesis(value['hypothesis']),
    rendererId: PREFERENCE_MEMORY_PROMOTION_RENDERER_ID,
    observedAt: nonNegativeInteger(value['observedAt'], 'observedAt'),
    deadlineAt: nonNegativeInteger(value['deadlineAt'], 'deadlineAt'),
  })
  if (request.deadlineAt <= request.observedAt) invalid('promotion deadline must follow observedAt')
  if (preferenceMemoryPromotionRequestDigest(request) !== request.requestDigest) {
    throw new AssistantGrowthContractError('receipt-mismatch', 'promotion request digest is stale')
  }
  return request
}

function receiptPayload(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'receiptDigest'))
}

function receiptDigest(protocol: string, value: Readonly<Record<string, unknown>>): string {
  return growthObjectDigest({ contract: protocol, receipt: receiptPayload(value) })
}

export function preferenceMemoryPromotionSubmissionDigest(value: unknown): string {
  if (!isGrowthRecord(value)) invalid('promotion submission receipt must be an object')
  return receiptDigest(PREFERENCE_MEMORY_PROMOTION_SUBMISSION_PROTOCOL, value)
}

export function withPreferenceMemoryPromotionSubmissionDigest<
  T extends Readonly<Record<string, unknown>>,
>(value: T): Readonly<T & { receiptDigest: string }> {
  if (Object.hasOwn(value, 'receiptDigest')) invalid('promotion submission already contains receiptDigest')
  return Object.freeze({ ...value, receiptDigest: preferenceMemoryPromotionSubmissionDigest(value) })
}

function assertResultIdentity(
  value: Readonly<Record<string, unknown>>,
  expected: Pick<PreferenceMemoryPromotionRequest,
    'promotionId' | 'promotionGeneration' | 'requestDigest'> | undefined,
): { promotionId: string; promotionGeneration: number; requestDigest: string } {
  const identity = {
    promotionId: identifier(value['promotionId'], 'promotionId'),
    promotionGeneration: positiveInteger(value['promotionGeneration'], 'promotionGeneration'),
    requestDigest: exactGrowthDigest(value['requestDigest'], 'requestDigest'),
  }
  if (expected !== undefined && (identity.promotionId !== expected.promotionId
    || identity.promotionGeneration !== expected.promotionGeneration
    || identity.requestDigest !== expected.requestDigest)) {
    throw new AssistantGrowthContractError('receipt-mismatch', 'promotion receipt changed request identity')
  }
  return identity
}

export function validatePreferenceMemoryPromotionSubmissionReceipt(
  value: unknown,
  expected?: Pick<PreferenceMemoryPromotionRequest,
    'promotionId' | 'promotionGeneration' | 'requestDigest'>,
): Readonly<PreferenceMemoryPromotionSubmissionReceipt> {
  if (!isGrowthRecord(value)) invalid('promotion submission receipt must be an object')
  assertExactGrowthKeys(value, [
    'contractVersion', 'promotionId', 'promotionGeneration', 'requestDigest',
    'outcome', 'memoryProposalId', 'receiptDigest',
  ], 'promotion submission receipt')
  if (value['contractVersion'] !== 1
    || (value['outcome'] !== 'accepted' && value['outcome'] !== 'replayed')) {
    invalid('promotion submission receipt is invalid')
  }
  const result = Object.freeze({
    contractVersion: 1 as const,
    ...assertResultIdentity(value, expected),
    outcome: value['outcome'],
    memoryProposalId: identifier(value['memoryProposalId'], 'memoryProposalId'),
    receiptDigest: exactGrowthDigest(value['receiptDigest'], 'receiptDigest'),
  })
  if (preferenceMemoryPromotionSubmissionDigest(result) !== result.receiptDigest) {
    throw new AssistantGrowthContractError('receipt-mismatch', 'promotion submission receipt digest is stale')
  }
  return result
}

export function preferenceMemoryPromotionResultDigest(value: unknown): string {
  if (!isGrowthRecord(value)) invalid('promotion result must be an object')
  return receiptDigest(PREFERENCE_MEMORY_PROMOTION_RESULT_PROTOCOL, value)
}

export function withPreferenceMemoryPromotionResultDigest<
  T extends Readonly<Record<string, unknown>>,
>(value: T): Readonly<T & { receiptDigest: string }> {
  if (Object.hasOwn(value, 'receiptDigest')) invalid('promotion result already contains receiptDigest')
  return Object.freeze({ ...value, receiptDigest: preferenceMemoryPromotionResultDigest(value) })
}

export function validatePreferenceMemoryPromotionResult(
  value: unknown,
  expected?: Pick<PreferenceMemoryPromotionRequest,
    'promotionId' | 'promotionGeneration' | 'requestDigest'>,
): Readonly<PreferenceMemoryPromotionResult> {
  if (!isGrowthRecord(value)) invalid('preference Memory promotion result must be an object')
  const baseKeys = [
    'contractVersion', 'promotionId', 'promotionGeneration', 'requestDigest',
    'resultVersion', 'status', 'occurredAt', 'receiptDigest',
  ]
  const status = value['status']
  if (status === 'confirmed') {
    assertExactGrowthKeys(value, [...baseKeys, 'memoryProposalId', 'memoryProposalVersion',
      'memoryRecordId', 'memoryRecordVersion', 'memoryRecordDigest'], 'promotion result')
  } else if (status === 'rejected') {
    assertExactGrowthKeys(value, [...baseKeys, 'rejectionKind', 'memoryProposalId',
      'memoryProposalVersion'], 'promotion result')
    if (value['rejectionKind'] !== 'owner-explicit') {
      invalid('rejected promotion result lacks explicit owner rejection')
    }
  } else if (status === 'expired' || status === 'conflicted') {
    assertExactGrowthKeys(value, [...baseKeys, 'memoryProposalId', 'memoryProposalVersion'],
      'promotion result')
  } else if (status === 'stale-owner') {
    assertExactGrowthKeys(value, baseKeys, 'promotion result')
  } else {
    invalid('promotion terminal status is invalid')
  }
  if (value['contractVersion'] !== 1) invalid('promotion result contract version is invalid')
  const common = {
    contractVersion: 1 as const,
    ...assertResultIdentity(value, expected),
    resultVersion: positiveInteger(value['resultVersion'], 'resultVersion'),
    occurredAt: nonNegativeInteger(value['occurredAt'], 'occurredAt'),
    receiptDigest: exactGrowthDigest(value['receiptDigest'], 'receiptDigest'),
  }
  let result: Readonly<PreferenceMemoryPromotionResult>
  if (status === 'confirmed') {
    result = Object.freeze({
      ...common, status,
      memoryProposalId: identifier(value['memoryProposalId'], 'memoryProposalId'),
      memoryProposalVersion: positiveInteger(value['memoryProposalVersion'], 'memoryProposalVersion'),
      memoryRecordId: identifier(value['memoryRecordId'], 'memoryRecordId'),
      memoryRecordVersion: positiveInteger(value['memoryRecordVersion'], 'memoryRecordVersion'),
      memoryRecordDigest: exactGrowthDigest(value['memoryRecordDigest'], 'memoryRecordDigest'),
    })
  } else if (status === 'rejected') {
    result = Object.freeze({
      ...common, status, rejectionKind: 'owner-explicit' as const,
      memoryProposalId: identifier(value['memoryProposalId'], 'memoryProposalId'),
      memoryProposalVersion: positiveInteger(value['memoryProposalVersion'], 'memoryProposalVersion'),
    })
  } else if (status === 'expired' || status === 'conflicted') {
    result = Object.freeze({
      ...common, status,
      memoryProposalId: identifier(value['memoryProposalId'], 'memoryProposalId'),
      memoryProposalVersion: positiveInteger(value['memoryProposalVersion'], 'memoryProposalVersion'),
    })
  } else {
    result = Object.freeze({ ...common, status: 'stale-owner' as const })
  }
  if (preferenceMemoryPromotionResultDigest(result) !== result.receiptDigest) {
    throw new AssistantGrowthContractError('receipt-mismatch', 'promotion result digest is stale')
  }
  return result
}

export function validatePreferenceMemoryPromotionResultAck(
  value: unknown,
): Readonly<PreferenceMemoryPromotionResultAck> {
  if (!isGrowthRecord(value)) invalid('promotion result acknowledgement must be an object')
  assertExactGrowthKeys(value, [
    'contractVersion', 'promotionId', 'promotionGeneration', 'resultVersion',
    'receiptDigest', 'outcome',
  ], 'promotion result acknowledgement')
  if (value['contractVersion'] !== 1
    || !['applied', 'replayed', 'cancelled'].includes(String(value['outcome']))) {
    invalid('promotion result acknowledgement is invalid')
  }
  return Object.freeze({
    contractVersion: 1,
    promotionId: identifier(value['promotionId'], 'promotionId'),
    promotionGeneration: positiveInteger(value['promotionGeneration'], 'promotionGeneration'),
    resultVersion: positiveInteger(value['resultVersion'], 'resultVersion'),
    receiptDigest: exactGrowthDigest(value['receiptDigest'], 'receiptDigest'),
    outcome: value['outcome'] as PreferenceMemoryPromotionResultAck['outcome'],
  })
}

export function preferenceMemoryPromotionCancellationDigest(value: unknown): string {
  if (!isGrowthRecord(value)) invalid('promotion cancellation request must be an object')
  const payload = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'cancellationDigest'),
  )
  return growthObjectDigest({ contract: PREFERENCE_MEMORY_PROMOTION_CANCELLATION_PROTOCOL, request: payload })
}

export function withPreferenceMemoryPromotionCancellationDigest<
  T extends Readonly<Record<string, unknown>>,
>(value: T): Readonly<T & { cancellationDigest: string }> {
  if (Object.hasOwn(value, 'cancellationDigest')) invalid('cancellation already contains its digest')
  return Object.freeze({ ...value, cancellationDigest: preferenceMemoryPromotionCancellationDigest(value) })
}

export function validatePreferenceMemoryPromotionCancellationRequest(
  value: unknown,
): Readonly<PreferenceMemoryPromotionCancellationRequest> {
  if (!isGrowthRecord(value)) invalid('promotion cancellation request must be an object')
  assertExactGrowthKeys(value, [
    'contractVersion', 'promotionId', 'promotionGeneration', 'requestDigest',
    'principalLineage', 'ownerGeneration', 'reason', 'occurredAt', 'cancellationDigest',
  ], 'promotion cancellation request')
  if (value['contractVersion'] !== 1
    || !['forget', 'owner-rotated', 'superseded']
      .includes(String(value['reason']))) {
    invalid('promotion cancellation request is invalid')
  }
  const result = Object.freeze({
    contractVersion: 1 as const,
    promotionId: identifier(value['promotionId'], 'promotionId'),
    promotionGeneration: positiveInteger(value['promotionGeneration'], 'promotionGeneration'),
    requestDigest: exactGrowthDigest(value['requestDigest'], 'requestDigest'),
    principalLineage: validateLineage(value['principalLineage']),
    ownerGeneration: positiveInteger(value['ownerGeneration'], 'ownerGeneration'),
    reason: value['reason'] as PreferenceMemoryPromotionCancellationReason,
    occurredAt: nonNegativeInteger(value['occurredAt'], 'occurredAt'),
    cancellationDigest: exactGrowthDigest(value['cancellationDigest'], 'cancellationDigest'),
  })
  if (preferenceMemoryPromotionCancellationDigest(result) !== result.cancellationDigest) {
    throw new AssistantGrowthContractError('receipt-mismatch', 'promotion cancellation digest is stale')
  }
  return result
}

export function preferenceMemoryPromotionCancellationReceiptDigest(value: unknown): string {
  if (!isGrowthRecord(value)) invalid('promotion cancellation receipt must be an object')
  return receiptDigest(PREFERENCE_MEMORY_PROMOTION_CANCELLATION_PROTOCOL, value)
}

export function withPreferenceMemoryPromotionCancellationReceiptDigest<
  T extends Readonly<Record<string, unknown>>,
>(value: T): Readonly<T & { receiptDigest: string }> {
  if (Object.hasOwn(value, 'receiptDigest')) invalid('cancellation receipt already contains receiptDigest')
  return Object.freeze({ ...value, receiptDigest: preferenceMemoryPromotionCancellationReceiptDigest(value) })
}

export function validatePreferenceMemoryPromotionCancellationReceipt(
  value: unknown,
  expected: Readonly<PreferenceMemoryPromotionCancellationRequest>,
): Readonly<PreferenceMemoryPromotionCancellationReceipt> {
  if (!isGrowthRecord(value)) invalid('promotion cancellation receipt must be an object')
  assertExactGrowthKeys(value, [
    'contractVersion', 'promotionId', 'promotionGeneration', 'requestDigest',
    'cancellationDigest', 'outcome', 'receiptDigest',
  ], 'promotion cancellation receipt')
  if (value['contractVersion'] !== 1
    || !['cancelled', 'replayed', 'already-confirmed'].includes(String(value['outcome']))) {
    invalid('promotion cancellation receipt is invalid')
  }
  const result = Object.freeze({
    contractVersion: 1 as const,
    promotionId: identifier(value['promotionId'], 'promotionId'),
    promotionGeneration: positiveInteger(value['promotionGeneration'], 'promotionGeneration'),
    requestDigest: exactGrowthDigest(value['requestDigest'], 'requestDigest'),
    cancellationDigest: exactGrowthDigest(value['cancellationDigest'], 'cancellationDigest'),
    outcome: value['outcome'] as PreferenceMemoryPromotionCancellationReceipt['outcome'],
    receiptDigest: exactGrowthDigest(value['receiptDigest'], 'receiptDigest'),
  })
  if (result.promotionId !== expected.promotionId
    || result.promotionGeneration !== expected.promotionGeneration
    || result.requestDigest !== expected.requestDigest
    || result.cancellationDigest !== expected.cancellationDigest) {
    throw new AssistantGrowthContractError('receipt-mismatch', 'cancellation receipt changed request identity')
  }
  if (result.outcome === 'already-confirmed' && expected.reason !== 'superseded') {
    throw new AssistantGrowthContractError(
      'receipt-mismatch',
      'privacy cancellation requires durable Memory compensation',
    )
  }
  if (preferenceMemoryPromotionCancellationReceiptDigest(result) !== result.receiptDigest) {
    throw new AssistantGrowthContractError('receipt-mismatch', 'promotion cancellation receipt digest is stale')
  }
  return result
}
