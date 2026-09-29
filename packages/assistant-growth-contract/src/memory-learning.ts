import { isAbsolute, resolve } from 'node:path'
import { growthObjectDigest, validateExternalPrincipalId } from './canonical.js'

/** Host-owned scope, never selected by a candidate model. */
export interface MemoryLearningOwner {
  authorityId: string
  authorityHash: string
  principalId: string
  principalRecordId: string
  principalVersion: number
  workspace: string
  agentPreset: string
}

/** Locators to reread, not an assertion that their contents are trustworthy. */
export interface MemoryLearningSource {
  inboxId: string
  sourceDigest: string
  contentDigest: string
  canonical?: {
    outcomeId: string
    version: number
    digest: string
    objectiveStatus: 'achieved' | 'not-achieved'
  }
}

export interface MemoryLearningEntry {
  kind: 'fact' | 'experience'
  content: string
  knowledge?: {
    claim?: { key: string; value: string }
    applicability?: readonly string[]
    counterexamples?: readonly string[]
  }
}

/** No namespace, trust, confidence, TTL, provenance or authority is model writable. */
export type MemoryLearningMutation =
  | { op: 'add'; entry: MemoryLearningEntry }
  | { op: 'replace'; id: string; expectedVersion: number; entry: MemoryLearningEntry }
  | { op: 'remove'; id: string; expectedVersion: number }

export interface MemoryLearningProposal {
  mutation: MemoryLearningMutation
  /** Exact source quotation. Its meaning and source must be checked independently. */
  evidenceQuote: string
}

export interface MemoryLearningReviewRequest extends MemoryLearningProposal {
  protocol: 'memory-learning-review/v1'
  operationId: string
  extractionSessionId: string
  owner: MemoryLearningOwner
  source: MemoryLearningSource
}

export class MemoryLearningContractError extends Error {
  constructor(message: string) { super(message); this.name = 'MemoryLearningContractError' }
}

function fail(label: string): never { throw new MemoryLearningContractError(`Invalid memory learning ${label}`) }

/** Reject accessors before reading values, including optional and non-enumerable fields. */
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('object')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))
    || required.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(field => !field.enumerable || !('value' in field))) fail('object fields')
  return value as Record<string, unknown>
}

function text(value: unknown, max: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')
    || !value.isWellFormed() || Buffer.byteLength(value) > max) fail('text')
}

function identifier(value: unknown): void {
  text(value, 256)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value)) fail('identifier')
}

function digest(value: unknown): void {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail('digest')
}

function positive(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail('version')
}

function phrases(value: unknown): void {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < 1 || value.length > 4) fail('knowledge list')
  for (let i = 0; i < value.length; i++) {
    const field = Object.getOwnPropertyDescriptor(value, String(i))
    if (!field || !field.enumerable || !('value' in field)) fail('knowledge list item')
    text(field.value, 256)
    if (field.value !== field.value.normalize('NFC').trim()) fail('knowledge normalization')
  }
  if (Reflect.ownKeys(value).length !== value.length + 1 || new Set(value).size !== value.length) fail('knowledge list fields')
}

function entry(value: unknown): void {
  const item = object(value, ['kind', 'content'], ['knowledge'])
  if (item.kind !== 'fact' && item.kind !== 'experience') fail('kind')
  text(item.content, 4096)
  if (item.content !== item.content.normalize('NFC').trim()) fail('content normalization')
  if (Object.hasOwn(item, 'knowledge')) {
    const knowledge = object(item.knowledge, [], ['claim', 'applicability', 'counterexamples'])
    if (Object.keys(knowledge).length === 0) fail('empty knowledge')
    if (Object.hasOwn(knowledge, 'claim')) {
      const claim = object(knowledge.claim, ['key', 'value'])
      text(claim.key, 128); text(claim.value, 256)
      if (!/^[a-z0-9][a-z0-9._:-]*$/u.test(claim.key)
        || claim.value !== claim.value.normalize('NFC').trim()) fail('claim normalization')
    }
    if (Object.hasOwn(knowledge, 'applicability')) phrases(knowledge.applicability)
    if (Object.hasOwn(knowledge, 'counterexamples')) phrases(knowledge.counterexamples)
    if (Buffer.byteLength(item.content) + Buffer.byteLength(JSON.stringify(knowledge)) > 4096) fail('entry bytes')
  }
}

function proposal(value: unknown, extra: readonly string[] = []): void {
  const input = object(value, ['mutation', 'evidenceQuote', ...extra])
  text(input.evidenceQuote, 4096)
  // Inspect the discriminant only after rejecting arbitrary accessors.
  const mutation = object(input.mutation, ['op'], ['id', 'expectedVersion', 'entry'])
  if (mutation.op === 'add') {
    object(mutation, ['op', 'entry']); entry(mutation.entry)
  } else if (mutation.op === 'replace' || mutation.op === 'remove') {
    object(mutation, ['op', 'id', 'expectedVersion', ...(mutation.op === 'replace' ? ['entry'] : [])])
    identifier(mutation.id); positive(mutation.expectedVersion)
    if (mutation.op === 'replace') entry(mutation.entry)
  } else fail('operation')
}

export function validateMemoryLearningOwner(value: unknown): MemoryLearningOwner {
  const owner = object(value, ['authorityId', 'authorityHash', 'principalId', 'principalRecordId',
    'principalVersion', 'workspace', 'agentPreset'])
  identifier(owner.authorityId); digest(owner.authorityHash)
  validateExternalPrincipalId(owner.principalId)
  identifier(owner.principalRecordId); positive(owner.principalVersion); identifier(owner.agentPreset)
  text(owner.workspace, 4096)
  if (!isAbsolute(owner.workspace) || resolve(owner.workspace) !== owner.workspace || owner.workspace === '/') fail('workspace')
  return structuredClone(value) as MemoryLearningOwner
}

/** Strictly validate model data; this does not approve or apply a memory. */
export function validateMemoryLearningProposal(value: unknown): MemoryLearningProposal {
  proposal(value)
  return structuredClone(value) as MemoryLearningProposal
}

/** Validate a Host-assembled request. Consumers must still reread every source. */
export function validateMemoryLearningReviewRequest(value: unknown): MemoryLearningReviewRequest {
  proposal(value, ['protocol', 'operationId', 'extractionSessionId', 'owner', 'source'])
  const request = value as MemoryLearningReviewRequest
  if (request.protocol !== 'memory-learning-review/v1') fail('protocol')
  identifier(request.operationId); identifier(request.extractionSessionId)
  validateMemoryLearningOwner(request.owner)
  const source = object(request.source, ['inboxId', 'sourceDigest', 'contentDigest'], ['canonical'])
  identifier(source.inboxId); digest(source.sourceDigest); digest(source.contentDigest)
  if (Object.hasOwn(source, 'canonical')) {
    const canonical = object(source.canonical, ['outcomeId', 'version', 'digest', 'objectiveStatus'])
    identifier(canonical.outcomeId); positive(canonical.version); digest(canonical.digest)
    if (canonical.objectiveStatus !== 'achieved' && canonical.objectiveStatus !== 'not-achieved') fail('objective status')
  }
  if (request.mutation.op !== 'remove'
    && request.mutation.entry.kind === 'experience' && source.canonical === undefined) fail('experience without outcome')
  return structuredClone(request)
}

export function memoryLearningRequestDigest(value: MemoryLearningReviewRequest): string {
  return growthObjectDigest(validateMemoryLearningReviewRequest(value))
}
