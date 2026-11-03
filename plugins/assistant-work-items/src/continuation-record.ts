import { createHash } from 'node:crypto'
import { acceptanceCanonicalJson } from '@dsh-enhanced/task-acceptance-contract'
import { WorkItemError } from './types.js'

export const MAX_CONTINUATION_INPUT_BYTES = 262144
export const MAX_CONTINUATION_PLAN_BYTES = 262144
export interface WorkItemContinuationInput {
  readonly itemId: string
  readonly parentItemId: string
  readonly rootItemId: string
  readonly sourceKey: string
  readonly sourceDigest: string
  readonly inputText: string
  readonly inputSha256: string
  /** null is a frozen empty history, never an unrestricted read. */
  readonly parentReportRevision: number | null
  readonly parentOutcomeRevision: number | null
  readonly planJson: string
  readonly planDigest: string
  readonly createdAt: number
}
export interface WorkItemContinuationRecord extends WorkItemContinuationInput { readonly inputBytes: number }
export interface WorkItemContinuationAdmission {
  readonly parentItemId: string
  readonly sourceDigest: string
  readonly sourceKey: string
  readonly create: (item: import('./types.js').WorkItemRecord) => WorkItemContinuationInput
}
const HEX = /^[a-f0-9]{64}$/u
function fail(message: string): never { throw new WorkItemError('storage', `continuation ${message}`) }
export const continuationDigest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
export function continuationSourceKey(parentItemId: string, sourceDigest: string): string {
  if (typeof parentItemId !== 'string' || !parentItemId || /[\p{Cc}]/u.test(parentItemId) || !HEX.test(sourceDigest)) fail('source identity is invalid')
  return `work-item-continuation/v1:${continuationDigest(acceptanceCanonicalJson({parentItemId,sourceDigest}))}`
}
/** A byte-preserving UTF-8 reader; never let SQLite TEXT projection hide NUL. */
export function continuationUtf8(bytes: unknown): string {
  if (!(bytes instanceof Uint8Array)) fail('stored bytes are unavailable')
  try { return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes) } catch { fail('stored bytes are not UTF-8') }
}
export function validateContinuationInput(value: WorkItemContinuationInput): Readonly<WorkItemContinuationRecord> {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join() !== ['itemId','parentItemId','rootItemId','sourceKey','sourceDigest','inputText','inputSha256','parentReportRevision','parentOutcomeRevision','planJson','planDigest','createdAt'].sort().join()) fail('record fields are invalid')
  for (const key of ['itemId','parentItemId','rootItemId'] as const) if (typeof value[key] !== 'string' || !value[key] || /[\p{Cc}]/u.test(value[key])) fail('item identity is invalid')
  if (value.itemId === value.parentItemId || value.sourceKey !== continuationSourceKey(value.parentItemId,value.sourceDigest)) fail('source key differs')
  for (const key of ['inputText','planJson'] as const) if (typeof value[key] !== 'string' || Buffer.from(value[key],'utf8').toString('utf8') !== value[key]) fail('text is not lossless UTF-8')
  const inputBytes = Buffer.byteLength(value.inputText,'utf8')
  if (inputBytes > MAX_CONTINUATION_INPUT_BYTES || Buffer.byteLength(value.planJson,'utf8') > MAX_CONTINUATION_PLAN_BYTES
    || !HEX.test(value.inputSha256) || continuationDigest(value.inputText) !== value.inputSha256
    || !HEX.test(value.planDigest) || continuationDigest(value.planJson) !== value.planDigest) fail('text bytes or digest differ')
  let parsed: unknown
  try { parsed = JSON.parse(value.planJson) } catch { fail('plan JSON is invalid') }
  if (acceptanceCanonicalJson(parsed) !== value.planJson) fail('plan JSON is not canonical')
  for (const revision of [value.parentReportRevision,value.parentOutcomeRevision]) if (revision !== null && (!Number.isSafeInteger(revision) || revision < 1)) fail('history cutoff is invalid')
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt < 1) fail('timestamp is invalid')
  return Object.freeze({...value,inputBytes})
}
