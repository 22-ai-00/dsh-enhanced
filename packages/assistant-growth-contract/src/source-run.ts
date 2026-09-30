import { createHash } from 'node:crypto'
import { assertExactGrowthKeys, isGrowthRecord } from './canonical.js'
import { validateCreationAcceptanceAuthorityRef, type CreationAcceptanceAuthorityRef } from './creation-verification.js'

/** Private Host provenance, never candidate input or a semantic acceptance oracle. */
export interface SourceGrowthRunBinding {
  protocol: 'assistant-growth/source-run/v1'
  runId: string
  intentDigest: string
  configDigest: string
  ownerDigest: string
  source: {
    outcomeId: string
    projection: {
      subjectKind: 'foreground-turn'
      subjectRef: string
      version: number
      digest: string
      disposition: 'upsert'
      evidenceOutcomeId?: string
    }
    sourceDigest: string
  }
  model: { provider: string; model: string; reasoningEffort?: string }
  modelOrigin: 'explicit-growth-override' | 'inherited-owner-task'
  /** Owner policy frozen before the first author model call; absent on historical runs. */
  creationAcceptance?: CreationAcceptanceAuthorityRef
  budget: {
    budgetId: string
    amount: number
    maxModelCalls: number
    maxToolCalls: number
    maxOutputTokens: number
    maxDurationMs: number
    maxPlansPerWake: number
  }
  native: {
    owner: 'assistant-growth-usage'
    automationId: string
    definitionHash: string
    occurrenceId: string
  }
  sessionId: string
  toolContractDigest: string
  executionContractDigest: string
  createdAt: number
  /** Generation and enqueue deadline, not a renewed build/adoption allowance. */
  generationDeadlineAt: number
  /** Original durable source window; later stages also need their own grants. */
  expiresAt: number
}

export interface SourceGrowthRunRequest { runId: string; intentDigest: string }
/** Transient Host provider absence, distinct from an invalidated durable run. */
export class SourceGrowthRunUnavailableError extends Error {}
export interface SourceGrowthRunProducer {
  protocol: 'assistant-growth-source-run-producer/v1'
  /** Reread the durable run and current owner/source/config; no fallback. */
  inspect(input: SourceGrowthRunRequest): SourceGrowthRunBinding | undefined
}

const digest = /^[a-f0-9]{64}$/u
function invalid(label: string): never { throw new Error(`invalid source growth run ${label}`) }
function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isGrowthRecord(value)) invalid(label)
  assertExactGrowthKeys(value, keys, `source growth run ${label}`)
  return value
}
function text(value: unknown, label: string, limit = 500): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > limit || value.normalize('NFC').trim() !== value
    || /[\p{Cc}]/u.test(value)) invalid(label)
}
function hash(value: unknown, label: string): void {
  if (typeof value !== 'string' || !digest.test(value)) invalid(label)
}
function integer(value: unknown, label: string, minimum = 1): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) invalid(label)
}

/** Strict shape checking is necessary but does not authenticate the producer. */
export function validateSourceGrowthRunBinding(value: unknown): asserts value is SourceGrowthRunBinding {
  const binding = record(value, ['protocol', 'runId', 'intentDigest', 'configDigest', 'ownerDigest', 'source',
    'model', 'modelOrigin', 'budget', 'native', 'sessionId', 'toolContractDigest', 'executionContractDigest',
    'createdAt', 'generationDeadlineAt', 'expiresAt',
    ...(isGrowthRecord(value) && Object.hasOwn(value, 'creationAcceptance') ? ['creationAcceptance'] : [])], 'binding')
  if (binding['protocol'] !== 'assistant-growth/source-run/v1') invalid('protocol')
  for (const key of ['runId', 'sessionId']) text(binding[key], key)
  for (const key of ['intentDigest', 'configDigest', 'ownerDigest', 'toolContractDigest', 'executionContractDigest']) hash(binding[key], key)
  const source = record(binding['source'], ['outcomeId', 'projection', 'sourceDigest'], 'source')
  text(source['outcomeId'], 'outcomeId')
  hash(source['sourceDigest'], 'sourceDigest')
  if (!isGrowthRecord(source['projection'])) invalid('projection')
  const projection = record(source['projection'], ['subjectKind', 'subjectRef', 'version', 'digest', 'disposition',
    ...(Object.hasOwn(source['projection'], 'evidenceOutcomeId') ? ['evidenceOutcomeId'] : [])], 'projection')
  if (projection['subjectKind'] !== 'foreground-turn' || projection['disposition'] !== 'upsert') invalid('projection kind')
  text(projection['subjectRef'], 'subjectRef')
  integer(projection['version'], 'projection version')
  hash(projection['digest'], 'projection digest')
  if (Object.hasOwn(projection, 'evidenceOutcomeId')) text(projection['evidenceOutcomeId'], 'evidenceOutcomeId')
  if (!isGrowthRecord(binding['model'])) invalid('model')
  const model = record(binding['model'], ['provider', 'model',
    ...(Object.hasOwn(binding['model'], 'reasoningEffort') ? ['reasoningEffort'] : [])], 'model')
  text(model['provider'], 'provider')
  text(model['model'], 'model')
  if (Object.hasOwn(model, 'reasoningEffort')) text(model['reasoningEffort'], 'reasoningEffort')
  if (!['explicit-growth-override', 'inherited-owner-task'].includes(String(binding['modelOrigin']))) invalid('model origin')
  const budget = record(binding['budget'], ['budgetId', 'amount', 'maxModelCalls', 'maxToolCalls',
    'maxOutputTokens', 'maxDurationMs', 'maxPlansPerWake'], 'budget')
  text(budget['budgetId'], 'budgetId')
  for (const key of ['amount', 'maxModelCalls', 'maxToolCalls', 'maxOutputTokens', 'maxDurationMs', 'maxPlansPerWake']) integer(budget[key], key)
  const native = record(binding['native'], ['owner', 'automationId', 'definitionHash', 'occurrenceId'], 'native')
  if (native['owner'] !== 'assistant-growth-usage' || native['automationId'] !== binding['runId']) invalid('native owner or identity')
  text(native['occurrenceId'], 'occurrenceId')
  hash(native['definitionHash'], 'definitionHash')
  for (const key of ['createdAt', 'generationDeadlineAt', 'expiresAt']) {
    integer(binding[key], key, 0)
    if (Number(binding[key]) > 8_640_000_000_000_000) invalid(key)
  }
  if (Number(binding['createdAt']) >= Number(binding['generationDeadlineAt'])
    || Number(binding['generationDeadlineAt']) > Number(binding['expiresAt'])
    || Number(binding['generationDeadlineAt']) - Number(binding['createdAt']) > Number(budget['maxDurationMs'])) invalid('deadline')
  if (Object.hasOwn(binding, 'creationAcceptance')) {
    validateCreationAcceptanceAuthorityRef(binding['creationAcceptance'])
    if ((binding['creationAcceptance'] as CreationAcceptanceAuthorityRef).expiresAt < Number(binding['createdAt'])) invalid('creation acceptance expiry')
  }
}

/** Matches the existing Control Plane evidence canonicalization, including absent optional feedback. */
export function sourceGrowthEvidenceDigest(value: unknown): string {
  const active = new Set<object>()
  let nodes = 0
  function visit(item: unknown, depth: number): string {
    if (++nodes > 32_768 || depth > 64) invalid('evidence size')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number' && Number.isFinite(item)
      && (!Number.isInteger(item) || Number.isSafeInteger(item))) return JSON.stringify(item)
    if (typeof item !== 'object' || active.has(item)) invalid('evidence value')
    active.add(item)
    try {
      if (Array.isArray(item)) return `[${item.map(entry => visit(entry, depth + 1)).join(',')}]`
      if (!isGrowthRecord(item)) invalid('evidence object')
      const entries = Object.entries(item).filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
      if (entries.some(([key]) => ['__proto__', 'constructor', 'prototype'].includes(key))) invalid('evidence key')
      return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${visit(entry, depth + 1)}`).join(',')}}`
    } finally { active.delete(item) }
  }
  const canonical = visit(value, 0)
  if (Buffer.byteLength(canonical) > 1_048_576) invalid('evidence bytes')
  return createHash('sha256').update(canonical).digest('hex')
}

export function sourceGrowthRunDigest(binding: SourceGrowthRunBinding): string {
  validateSourceGrowthRunBinding(binding)
  return sourceGrowthEvidenceDigest(binding)
}
