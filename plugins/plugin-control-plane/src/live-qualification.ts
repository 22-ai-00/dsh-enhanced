import { createPublicKey, verify } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { TaskObservationOwner, TaskObservationVote } from './task-observation-types.js'
import { controlPlaneDigest, ControlPlaneStoreError } from './store.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const DIGEST = /^[a-f0-9]{64}$/u
const SIGNATURE = /^[A-Za-z0-9+/]+={0,2}$/u
const FIELDS = ['schemaVersion', 'kind', 'id', 'digest', 'lane', 'configDigest', 'trustDigest', 'planId', 'planDigest',
  'installationId', 'profilePath', 'owner', 'terms', 'activationId', 'fence', 'startedAt', 'deadlineAt',
  'readinessDigest', 'hostGeneration', 'votes', 'createdAt', 'expiresAt'] as const
const RECEIPT_FIELDS = ['schemaVersion', 'kind', 'receiptId', 'authority', 'keyId', 'batchId', 'batchDigest',
  'planId', 'planDigest', 'activationId', 'fence', 'hostGeneration', 'disposition', 'observedAt', 'expiresAt', 'signature'] as const

export interface LiveQualificationTerms {
  protocol: 'dsh-bounded-live/v1'
  maximumWindowMs: number
  minimumTasks: number
  authority: string
  keyId: string
}

/** A finite, profile-wide pre-adoption observation; no exposure cap is implied. */
export interface LiveQualificationBatch {
  schemaVersion: 1
  kind: 'dsh-live-qualification'
  id: string
  digest: string
  lane: string
  configDigest: string
  trustDigest: string
  planId: string
  planDigest: string
  installationId: string
  profilePath: string
  owner: TaskObservationOwner
  terms: LiveQualificationTerms
  activationId: string
  fence: number
  startedAt: number
  deadlineAt: number
  readinessDigest: string
  hostGeneration: number
  votes: readonly TaskObservationVote[]
  createdAt: number
  expiresAt: number
}

export interface LiveQualificationReceipt {
  schemaVersion: 1
  kind: 'dsh-live-qualification-receipt'
  receiptId: string
  authority: string
  keyId: string
  batchId: string
  batchDigest: string
  planId: string
  planDigest: string
  activationId: string
  fence: number
  hostGeneration: number
  disposition: 'qualified' | 'failed'
  observedAt: number
  expiresAt: number
  signature: string
}

export interface LiveQualificationRequest {
  protocol: 'dsh-live-qualification/v1'
  batchId: string
  batchDigest: string
}

export interface LiveQualificationRecord {
  batch: LiveQualificationBatch
  state: 'pending' | 'signed' | 'applied' | 'stale'
  receipt?: LiveQualificationReceipt
}

function fail(message: string): never { throw new ControlPlaneStoreError('invalid-input', message) }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('live qualification object is invalid')
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(value).sort().join('\0') !== [...fields].sort().join('\0')) fail('live qualification fields differ')
}
function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 4096
    && value.normalize('NFC').trim() === value && !/[\p{Cc}]/u.test(value)
}
function path(value: unknown): value is string { return text(value) && isAbsolute(value) && resolve(value) === value }
function owner(value: unknown): value is TaskObservationOwner {
  const item = object(value)
  exact(item, ['authorityId', 'authorityHash', 'principalId', 'principalRecordId', 'principalVersion', 'workspace', 'agentPreset'])
  return [item.authorityId, item.principalId, item.principalRecordId, item.agentPreset].every(text)
    && typeof item.authorityHash === 'string' && DIGEST.test(item.authorityHash)
    && path(item.workspace) && integer(item.principalVersion, 1)
}

export function validateLiveQualificationTerms(value: unknown): asserts value is LiveQualificationTerms {
  const item = object(value)
  exact(item, ['protocol', 'maximumWindowMs', 'minimumTasks', 'authority', 'keyId'])
  if (item.protocol !== 'dsh-bounded-live/v1' || !integer(item.maximumWindowMs, 60_000, 86_400_000)
    || !integer(item.minimumTasks, 1, 32) || typeof item.authority !== 'string' || !ID.test(item.authority)
    || typeof item.keyId !== 'string' || !ID.test(item.keyId)) fail('live qualification terms are invalid')
}

/** Content identity excludes the creation clock, as with task observation. */
export function liveQualificationId(batch: Omit<LiveQualificationBatch, 'schemaVersion' | 'kind' | 'id' | 'digest' | 'createdAt' | 'expiresAt'>): string {
  return `live-qualification-${controlPlaneDigest({ lane: batch.lane, configDigest: batch.configDigest,
    trustDigest: batch.trustDigest, planId: batch.planId, planDigest: batch.planDigest,
    installationId: batch.installationId, profilePath: batch.profilePath, owner: batch.owner, terms: batch.terms,
    activationId: batch.activationId, fence: batch.fence, startedAt: batch.startedAt,
    deadlineAt: batch.deadlineAt, readinessDigest: batch.readinessDigest,
    hostGeneration: batch.hostGeneration, votes: batch.votes })}`
}
export function liveQualificationDigest(batch: Omit<LiveQualificationBatch, 'digest'>): string {
  const { digest: _digest, ...unsigned } = batch as LiveQualificationBatch
  return controlPlaneDigest(unsigned)
}

export function assertLiveQualificationBatch(value: unknown): asserts value is LiveQualificationBatch {
  const item = object(value)
  exact(item, FIELDS)
  validateLiveQualificationTerms(item.terms)
  const batch = item as unknown as LiveQualificationBatch
  if (batch.schemaVersion !== 1 || batch.kind !== 'dsh-live-qualification'
    || !/^live-qualification-[a-f0-9]{64}$/u.test(batch.id) || !DIGEST.test(batch.digest)
    || !DIGEST.test(batch.lane) || !DIGEST.test(batch.configDigest) || !DIGEST.test(batch.trustDigest)
    || !ID.test(batch.planId) || !DIGEST.test(batch.planDigest) || !text(batch.installationId)
    || !path(batch.profilePath) || !owner(batch.owner) || !ID.test(batch.activationId)
    || !integer(batch.fence, 1) || !integer(batch.startedAt, 1) || !integer(batch.deadlineAt, batch.startedAt + 1)
    || batch.deadlineAt - batch.startedAt > batch.terms.maximumWindowMs || !DIGEST.test(batch.readinessDigest)
    || !integer(batch.hostGeneration, 1) || !Array.isArray(batch.votes)
    || !integer(batch.createdAt, batch.startedAt, batch.deadlineAt - 1)
    || !integer(batch.expiresAt, batch.createdAt + 1)
    || Buffer.byteLength(JSON.stringify(batch)) > 262_144) fail('live qualification batch is invalid')
  const seen = new Set<string>()
  for (const vote of batch.votes) {
    if (!vote || !text(vote.inboxId) || !text(vote.outcomeId) || !DIGEST.test(vote.sourceDigest)
      || !DIGEST.test(vote.deploymentDigest) || !['achieved', 'not-achieved'].includes(vote.status)
      || !integer(vote.completedAt, batch.startedAt, Math.min(batch.createdAt, batch.deadlineAt - 1))
      || !vote.projection || vote.projection.subjectKind !== 'foreground-turn'
      || vote.projection.subjectRef !== vote.inboxId || vote.projection.disposition !== 'upsert'
      || !integer(vote.projection.version, 1) || !DIGEST.test(vote.projection.digest)
      || seen.has(vote.inboxId)) fail('live qualification vote is invalid')
    seen.add(vote.inboxId)
  }
  const failed = batch.votes.some(vote => vote.status === 'not-achieved')
  if (failed ? batch.votes.length < 1 : batch.votes.length < batch.terms.minimumTasks) {
    fail('live qualification lacks the required task or failure evidence')
  }
  if (batch.id !== liveQualificationId(batch) || batch.digest !== liveQualificationDigest(batch)) fail('live qualification digest differs')
}

function receiptIdentity(receipt: Omit<LiveQualificationReceipt, 'receiptId' | 'signature'>): string {
  return `live-qualification-receipt-${controlPlaneDigest(receipt)}`
}

export function parseLiveQualificationReceipt(value: unknown): LiveQualificationReceipt {
  const item = object(value)
  exact(item, RECEIPT_FIELDS)
  const receipt = item as unknown as LiveQualificationReceipt
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'dsh-live-qualification-receipt'
    || !/^live-qualification-receipt-[a-f0-9]{64}$/u.test(receipt.receiptId)
    || !ID.test(receipt.authority) || !ID.test(receipt.keyId)
    || !/^live-qualification-[a-f0-9]{64}$/u.test(receipt.batchId) || !DIGEST.test(receipt.batchDigest)
    || !ID.test(receipt.planId) || !DIGEST.test(receipt.planDigest) || !ID.test(receipt.activationId)
    || !integer(receipt.fence, 1) || !integer(receipt.hostGeneration, 1)
    || !['qualified', 'failed'].includes(receipt.disposition)
    || !integer(receipt.observedAt, 1) || !integer(receipt.expiresAt, receipt.observedAt + 1)
    || typeof receipt.signature !== 'string' || receipt.signature.length > 512
    || !SIGNATURE.test(receipt.signature)
    || Buffer.byteLength(JSON.stringify(receipt)) > 16_384) fail('live qualification receipt is invalid')
  const { receiptId: _receiptId, signature: _signature, ...identity } = receipt
  if (receipt.receiptId !== receiptIdentity(identity)) fail('live qualification receipt identity differs')
  return receipt
}

/** Domain-separated canonical signing payload; never valid as a Host phase receipt. */
export function liveQualificationSigningPayload(receipt: Omit<LiveQualificationReceipt, 'signature'>): string {
  const { receiptId: _receiptId, ...identity } = receipt
  if (receipt.receiptId !== receiptIdentity(identity)) fail('live qualification receipt identity differs')
  return `dsh-bounded-live/v1\n${controlPlaneCanonical(receipt)}`
}

function controlPlaneCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(controlPlaneCanonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, part]) => `${JSON.stringify(key)}:${controlPlaneCanonical(part)}`).join(',')}}`
  return JSON.stringify(value)
}

export function verifyLiveQualificationReceipt(receiptInput: unknown, batchInput: unknown, publicKeyPem: string | Buffer, now = Date.now()): LiveQualificationReceipt {
  assertLiveQualificationBatch(batchInput)
  const batch = batchInput
  const receipt = parseLiveQualificationReceipt(receiptInput)
  const failed = batch.votes.some(vote => vote.status === 'not-achieved')
  if (receipt.authority !== batch.terms.authority || receipt.keyId !== batch.terms.keyId
    || receipt.batchId !== batch.id || receipt.batchDigest !== batch.digest || receipt.planId !== batch.planId
    || receipt.planDigest !== batch.planDigest || receipt.activationId !== batch.activationId
    || receipt.fence !== batch.fence || receipt.hostGeneration !== batch.hostGeneration
    || receipt.disposition !== (failed ? 'failed' : 'qualified')
    || receipt.observedAt < batch.createdAt || receipt.observedAt >= batch.deadlineAt
    || receipt.observedAt > now || now >= receipt.expiresAt
    || receipt.expiresAt > batch.expiresAt || !integer(now, 1)) fail('live qualification receipt context differs')
  const { signature, ...unsigned } = receipt
  let key: ReturnType<typeof createPublicKey>
  try { key = createPublicKey(publicKeyPem) } catch { return fail('live qualification public key is invalid') }
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(liveQualificationSigningPayload(unsigned)), key, Buffer.from(signature, 'base64'))) {
    fail('live qualification signature is invalid')
  }
  return receipt
}

/** Shared exact identity constructor for the independent authority. */
export function liveQualificationReceiptId(receipt: Omit<LiveQualificationReceipt, 'receiptId' | 'signature'>): string {
  return receiptIdentity(receipt)
}
