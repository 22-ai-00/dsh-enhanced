import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import { assertExactGrowthKeys, isGrowthRecord } from './canonical.js'
import { validateCreationAcceptanceAuthorityRef, type CreationAcceptanceAuthorityRef } from './creation-verification.js'
import { validateRevisionAcceptanceAuthorityRef, type RevisionAcceptanceAuthorityRef } from './revision-verification.js'
import { validateRevisionRegressionAcceptanceAuthorityRef, type RevisionRegressionAcceptanceAuthorityRef } from './revision-regression.js'

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
  /** Independent owner policy for revising an adopted version; absent on historical runs. */
  revisionAcceptance?: RevisionAcceptanceAuthorityRef
  /** Independent parent-behavior policy; absent on historical runs and never inferred from revisionAcceptance. */
  revisionRegressionAcceptance?: RevisionRegressionAcceptanceAuthorityRef
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
  if (Object.getOwnPropertySymbols(value).length
    || !Object.values(Object.getOwnPropertyDescriptors(value)).every(item => item.enumerable && 'value' in item)) invalid(label)
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
    ...(isGrowthRecord(value) && Object.hasOwn(value, 'creationAcceptance') ? ['creationAcceptance'] : []),
    ...(isGrowthRecord(value) && Object.hasOwn(value, 'revisionAcceptance') ? ['revisionAcceptance'] : []),
    ...(isGrowthRecord(value) && Object.hasOwn(value, 'revisionRegressionAcceptance') ? ['revisionRegressionAcceptance'] : [])], 'binding')
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
  if (Object.hasOwn(binding, 'revisionAcceptance')) {
    validateRevisionAcceptanceAuthorityRef(binding['revisionAcceptance'])
    if ((binding['revisionAcceptance'] as RevisionAcceptanceAuthorityRef).expiresAt < Number(binding['createdAt'])) invalid('revision acceptance expiry')
  }
  if (Object.hasOwn(binding, 'revisionRegressionAcceptance')) {
    validateRevisionRegressionAcceptanceAuthorityRef(binding['revisionRegressionAcceptance'])
    if ((binding['revisionRegressionAcceptance'] as RevisionRegressionAcceptanceAuthorityRef).expiresAt < Number(binding['createdAt'])) invalid('revision regression acceptance expiry')
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


/** Explicit, separately configured engineering authorities. Values are pins, not grants issued by this library. */
export interface WorkItemGrowthAuthorityPins {
  protocol: 'assistant-growth/work-item-authorities/v1'
  sourceJobs: { authorityId: string; authorityDigest: string; expiresAt: number }
  creationGrant: { id: string; digest: string; expiresAt: number }
  creationAcceptance: CreationAcceptanceAuthorityRef
  adoption: { authorityId: string; authorityDigest: string; expiresAt: number }
}

/** Work item engineering provenance never masquerades as a foreground Inbox. */
export interface WorkItemSourceGrowthRunBinding extends Omit<SourceGrowthRunBinding,
  'protocol' | 'source' | 'creationAcceptance' | 'revisionAcceptance' | 'revisionRegressionAcceptance'> {
  protocol: 'assistant-growth/source-run/v2'
  mode: 'create'
  creationAcceptance: CreationAcceptanceAuthorityRef
  authorities: WorkItemGrowthAuthorityPins
  source: {
    protocol: 'assistant-growth/work-item-source/v1'
    itemId: string
    outcomeId: string
    projection: { subjectKind: 'work-item'; subjectRef: string; version: number; digest: string; disposition: 'upsert'; evidenceOutcomeId?: string }
    objectiveStatus: 'not-achieved'
    sourceDigest: string
    presentationDigest: string
    context: { protocol: 'assistant-delivery/work-item-engineering-context/v1'; manifestDigest: string; objectiveDigest: string; objectiveBytes: number }
  }
}
export type AnySourceGrowthRunBinding = SourceGrowthRunBinding | WorkItemSourceGrowthRunBinding | WorkItemRevisionSourceGrowthRunBinding

/**
 * Revision corridor authorities. Mirrors the v2 work-item pins but binds the
 * revision grant (with explicit workItemFailures), the independent revision
 * acceptance authority and, when present, the parent-behavior regression and
 * version-switch adoption pins. These are pins, never candidate input.
 */
export interface WorkItemRevisionAuthorityPins {
  protocol: 'assistant-growth/work-item-revision-authorities/v1'
  sourceJobs: { authorityId: string; authorityDigest: string; expiresAt: number }
  revisionGrant: { id: string; digest: string; expiresAt: number; workItemFailures: true }
  revisionAcceptance: RevisionAcceptanceAuthorityRef
  revisionRegressionAcceptance?: RevisionRegressionAcceptanceAuthorityRef
  revisionAdoption?: { authorityId: string; authorityDigest: string; expiresAt: number }
}

/**
 * v3 reuses the v2 work-item source provenance but switches the corridor from
 * create-only to revising an already-adopted, owner-created capability. It is
 * never a foreground source and never carries creation acceptance.
 */
export interface WorkItemRevisionSourceGrowthRunBinding extends Omit<SourceGrowthRunBinding,
  'protocol' | 'source' | 'creationAcceptance' | 'revisionAcceptance' | 'revisionRegressionAcceptance'> {
  protocol: 'assistant-growth/source-run/v3'
  mode: 'revise-created'
  revisionAcceptance: RevisionAcceptanceAuthorityRef
  /** Present exactly when the revision must also prove retained parent behavior. */
  revisionRegressionAcceptance?: RevisionRegressionAcceptanceAuthorityRef
  authorities: WorkItemRevisionAuthorityPins
  source: WorkItemSourceGrowthRunBinding['source']
}
export interface SourceGrowthRunProducerV2 {
  protocol: 'assistant-growth-source-run-producer/v2'
  inspect(input: SourceGrowthRunRequest): AnySourceGrowthRunBinding | undefined
  /**
   * Only v2: hold the producer's Delivery → Evaluation → WorkItems → UsageStore
   * frame through this synchronous callback with a deep-frozen current binding.
   * Reject thenable results; downstream callbacks perform only local writes and
   * must not inspect/re-enter an upstream producer while this frame is held.
   */
  withWorkItemRunFence<T>(input: SourceGrowthRunRequest & { expectedGrowthRunDigest: string },
    callback: (binding: Readonly<WorkItemSourceGrowthRunBinding | WorkItemRevisionSourceGrowthRunBinding>) => T): T
}
export type AnySourceGrowthRunProducer = SourceGrowthRunProducer | SourceGrowthRunProducerV2

/** New protocol accepts only bounded ordinary own data, before reading any value. */
function workItemData(value: unknown): void {
  const seen = new Set<object>()
  let nodes = 0
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 32_768 || depth > 64) invalid('work item data size')
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)
      && (!Number.isInteger(item) || Number.isSafeInteger(item))) return
    if (typeof item === 'string') {
      if (!item.isWellFormed() || Buffer.byteLength(item) > 1_048_576) invalid('work item text')
      return
    }
    if (typeof item !== 'object' || utilTypes.isProxy(item) || seen.has(item) || !isGrowthRecord(item)) invalid('work item data')
    seen.add(item)
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item)
      if (Reflect.ownKeys(item).some(key => typeof key !== 'string')
        || Object.values(descriptors).some(field => !field.enumerable || !('value' in field))) invalid('work item own data')
      for (const field of Object.values(descriptors)) visit(field.value, depth + 1)
    } finally { seen.delete(item) }
  }
  visit(value, 0)
}

function workItemExpiry(value: unknown): void {
  integer(value, 'authority expiry')
  if (value > 8_640_000_000_000_000) invalid('authority expiry')
}

export function validateWorkItemGrowthAuthorityPins(value: unknown): asserts value is WorkItemGrowthAuthorityPins {
  workItemData(value)
  const pins = record(value, ['protocol', 'sourceJobs', 'creationGrant', 'creationAcceptance', 'adoption'], 'work item authorities')
  if (pins.protocol !== 'assistant-growth/work-item-authorities/v1') invalid('work item authorities protocol')
  for (const name of ['sourceJobs', 'adoption']) {
    const pin = record(pins[name], ['authorityId', 'authorityDigest', 'expiresAt'], name)
    text(pin.authorityId, name + ' authorityId'); hash(pin.authorityDigest, name + ' authorityDigest'); workItemExpiry(pin.expiresAt)
  }
  const creation = record(pins.creationGrant, ['id', 'digest', 'expiresAt'], 'creation grant')
  text(creation.id, 'creation grant id'); hash(creation.digest, 'creation grant digest'); workItemExpiry(creation.expiresAt)
  validateCreationAcceptanceAuthorityRef(pins.creationAcceptance)
}

export function workItemGrowthAuthorityPinsDigest(value: WorkItemGrowthAuthorityPins): string {
  validateWorkItemGrowthAuthorityPins(value)
  return sourceGrowthEvidenceDigest(value)
}

export function validateWorkItemSourceGrowthRunBinding(value: unknown): asserts value is WorkItemSourceGrowthRunBinding {
  workItemData(value)
  const binding = record(value, ['protocol', 'mode', 'runId', 'intentDigest', 'configDigest', 'ownerDigest', 'source', 'model',
    'modelOrigin', 'creationAcceptance', 'authorities', 'budget', 'native', 'sessionId', 'toolContractDigest',
    'executionContractDigest', 'createdAt', 'generationDeadlineAt', 'expiresAt'], 'work item binding')
  if (binding.protocol !== 'assistant-growth/source-run/v2' || binding.mode !== 'create') invalid('work item protocol or mode')
  for (const key of ['runId', 'sessionId']) text(binding[key], key)
  for (const key of ['intentDigest', 'configDigest', 'ownerDigest', 'toolContractDigest', 'executionContractDigest']) hash(binding[key], key)
  const source = record(binding.source, ['protocol', 'itemId', 'outcomeId', 'projection', 'objectiveStatus', 'sourceDigest', 'presentationDigest', 'context'], 'work item source')
  if (source.protocol !== 'assistant-growth/work-item-source/v1' || source.objectiveStatus !== 'not-achieved') invalid('work item source protocol or objective')
  text(source.itemId, 'work item id'); text(source.outcomeId, 'outcomeId')
  hash(source.sourceDigest, 'sourceDigest'); hash(source.presentationDigest, 'presentationDigest')
  if (!isGrowthRecord(source.projection)) invalid('work item projection')
  const projection = record(source.projection, ['subjectKind', 'subjectRef', 'version', 'digest', 'disposition',
    ...(Object.hasOwn(source.projection, 'evidenceOutcomeId') ? ['evidenceOutcomeId'] : [])], 'work item projection')
  if (projection.subjectKind !== 'work-item' || projection.subjectRef !== source.itemId || projection.disposition !== 'upsert') invalid('work item projection identity')
  integer(projection.version, 'projection version'); hash(projection.digest, 'projection digest')
  if (Object.hasOwn(projection, 'evidenceOutcomeId')) text(projection.evidenceOutcomeId, 'evidenceOutcomeId')
  const context = record(source.context, ['protocol', 'manifestDigest', 'objectiveDigest', 'objectiveBytes'], 'work item context')
  if (context.protocol !== 'assistant-delivery/work-item-engineering-context/v1') invalid('work item context protocol')
  hash(context.manifestDigest, 'context manifestDigest'); hash(context.objectiveDigest, 'context objectiveDigest')
  integer(context.objectiveBytes, 'context objectiveBytes')
  if (context.objectiveBytes > 16_384) invalid('context objectiveBytes')
  if (!isGrowthRecord(binding.model)) invalid('model')
  const model = record(binding.model, ['provider', 'model', ...(Object.hasOwn(binding.model, 'reasoningEffort') ? ['reasoningEffort'] : [])], 'model')
  text(model.provider, 'provider'); text(model.model, 'model')
  if (Object.hasOwn(model, 'reasoningEffort')) text(model.reasoningEffort, 'reasoningEffort')
  if (binding.modelOrigin !== 'explicit-growth-override' && binding.modelOrigin !== 'inherited-owner-task') invalid('model origin')
  const budget = record(binding.budget, ['budgetId', 'amount', 'maxModelCalls', 'maxToolCalls', 'maxOutputTokens', 'maxDurationMs', 'maxPlansPerWake'], 'budget')
  text(budget.budgetId, 'budgetId')
  for (const key of ['amount', 'maxModelCalls', 'maxToolCalls', 'maxOutputTokens', 'maxDurationMs', 'maxPlansPerWake']) integer(budget[key], key)
  const native = record(binding.native, ['owner', 'automationId', 'definitionHash', 'occurrenceId'], 'native')
  if (native.owner !== 'assistant-growth-usage' || native.automationId !== binding.runId) invalid('native owner or identity')
  text(native.occurrenceId, 'occurrenceId'); hash(native.definitionHash, 'definitionHash')
  for (const key of ['createdAt', 'generationDeadlineAt', 'expiresAt']) {
    integer(binding[key], key, 0)
    if (Number(binding[key]) > 8_640_000_000_000_000) invalid(key)
  }
  if (Number(binding.createdAt) >= Number(binding.generationDeadlineAt) || Number(binding.generationDeadlineAt) > Number(binding.expiresAt)
    || Number(binding.generationDeadlineAt) - Number(binding.createdAt) > Number(budget.maxDurationMs)) invalid('deadline')
  validateCreationAcceptanceAuthorityRef(binding.creationAcceptance)
  validateWorkItemGrowthAuthorityPins(binding.authorities)
  if (sourceGrowthEvidenceDigest(binding.creationAcceptance) !== sourceGrowthEvidenceDigest(binding.authorities.creationAcceptance)) invalid('creation acceptance authority mismatch')
  for (const authority of [binding.authorities.sourceJobs, binding.authorities.creationGrant, binding.authorities.creationAcceptance, binding.authorities.adoption]) {
    if (authority.expiresAt <= Number(binding.createdAt) || Number(binding.generationDeadlineAt) > authority.expiresAt) invalid('work item authority expiry')
  }
}

/** Explicit protocol dispatch; existing foreground-only consumers remain foreground-only. */
export function validateAnySourceGrowthRunBinding(value: unknown): asserts value is AnySourceGrowthRunBinding {
  workItemData(value)
  if (value !== null && typeof value === 'object' && !utilTypes.isProxy(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'protocol')
    if (descriptor && descriptor.enumerable && 'value' in descriptor) {
      if (descriptor.value === 'assistant-growth/source-run/v1') return validateSourceGrowthRunBinding(value)
      if (descriptor.value === 'assistant-growth/source-run/v2') return validateWorkItemSourceGrowthRunBinding(value)
      if (descriptor.value === 'assistant-growth/source-run/v3') return validateWorkItemRevisionSourceGrowthRunBinding(value)
    }
  }
  invalid('binding protocol')
}

export function validateWorkItemRevisionAuthorityPins(value: unknown): asserts value is WorkItemRevisionAuthorityPins {
  workItemData(value)
  const pins = record(value, ['protocol', 'sourceJobs', 'revisionGrant', 'revisionAcceptance',
    ...(isGrowthRecord(value) && Object.hasOwn(value, 'revisionRegressionAcceptance') ? ['revisionRegressionAcceptance'] : []),
    ...(isGrowthRecord(value) && Object.hasOwn(value, 'revisionAdoption') ? ['revisionAdoption'] : [])], 'work item revision authorities')
  if (pins.protocol !== 'assistant-growth/work-item-revision-authorities/v1') invalid('work item revision authorities protocol')
  const sourceJobs = record(pins.sourceJobs, ['authorityId', 'authorityDigest', 'expiresAt'], 'sourceJobs')
  text(sourceJobs.authorityId, 'sourceJobs authorityId'); hash(sourceJobs.authorityDigest, 'sourceJobs authorityDigest')
  workItemExpiry(sourceJobs.expiresAt)
  const revision = record(pins.revisionGrant, ['id', 'digest', 'expiresAt', 'workItemFailures'], 'revision grant')
  text(revision.id, 'revision grant id'); hash(revision.digest, 'revision grant digest'); workItemExpiry(revision.expiresAt)
  if (revision.workItemFailures !== true) invalid('revision grant work item failures')
  validateRevisionAcceptanceAuthorityRef(pins.revisionAcceptance)
  if (Object.hasOwn(pins, 'revisionRegressionAcceptance')) validateRevisionRegressionAcceptanceAuthorityRef(pins.revisionRegressionAcceptance)
  if (Object.hasOwn(pins, 'revisionAdoption')) {
    const adoption = record(pins.revisionAdoption, ['authorityId', 'authorityDigest', 'expiresAt'], 'revisionAdoption')
    text(adoption.authorityId, 'revisionAdoption authorityId'); hash(adoption.authorityDigest, 'revisionAdoption authorityDigest')
    workItemExpiry(adoption.expiresAt)
  }
}

export function workItemRevisionAuthorityPinsDigest(value: WorkItemRevisionAuthorityPins): string {
  validateWorkItemRevisionAuthorityPins(value)
  return sourceGrowthEvidenceDigest(value)
}

export function validateWorkItemRevisionSourceGrowthRunBinding(value: unknown): asserts value is WorkItemRevisionSourceGrowthRunBinding {
  workItemData(value)
  const binding = record(value, ['protocol', 'mode', 'runId', 'intentDigest', 'configDigest', 'ownerDigest', 'source', 'model',
    'modelOrigin', 'revisionAcceptance', 'authorities', 'budget', 'native', 'sessionId', 'toolContractDigest',
    'executionContractDigest', 'createdAt', 'generationDeadlineAt', 'expiresAt',
    ...(isGrowthRecord(value) && Object.hasOwn(value, 'revisionRegressionAcceptance') ? ['revisionRegressionAcceptance'] : [])], 'work item revision binding')
  if (binding.protocol !== 'assistant-growth/source-run/v3' || binding.mode !== 'revise-created') invalid('work item revision protocol or mode')
  for (const key of ['runId', 'sessionId']) text(binding[key], key)
  for (const key of ['intentDigest', 'configDigest', 'ownerDigest', 'toolContractDigest', 'executionContractDigest']) hash(binding[key], key)
  const source = record(binding.source, ['protocol', 'itemId', 'outcomeId', 'projection', 'objectiveStatus', 'sourceDigest', 'presentationDigest', 'context'], 'work item source')
  if (source.protocol !== 'assistant-growth/work-item-source/v1' || source.objectiveStatus !== 'not-achieved') invalid('work item source protocol or objective')
  text(source.itemId, 'work item id'); text(source.outcomeId, 'outcomeId')
  hash(source.sourceDigest, 'sourceDigest'); hash(source.presentationDigest, 'presentationDigest')
  if (!isGrowthRecord(source.projection)) invalid('work item projection')
  const projection = record(source.projection, ['subjectKind', 'subjectRef', 'version', 'digest', 'disposition',
    ...(Object.hasOwn(source.projection, 'evidenceOutcomeId') ? ['evidenceOutcomeId'] : [])], 'work item projection')
  if (projection.subjectKind !== 'work-item' || projection.subjectRef !== source.itemId || projection.disposition !== 'upsert') invalid('work item projection identity')
  integer(projection.version, 'projection version'); hash(projection.digest, 'projection digest')
  if (Object.hasOwn(projection, 'evidenceOutcomeId')) text(projection.evidenceOutcomeId, 'evidenceOutcomeId')
  const context = record(source.context, ['protocol', 'manifestDigest', 'objectiveDigest', 'objectiveBytes'], 'work item context')
  if (context.protocol !== 'assistant-delivery/work-item-engineering-context/v1') invalid('work item context protocol')
  hash(context.manifestDigest, 'context manifestDigest'); hash(context.objectiveDigest, 'context objectiveDigest')
  integer(context.objectiveBytes, 'context objectiveBytes')
  if (context.objectiveBytes > 16_384) invalid('context objectiveBytes')
  if (!isGrowthRecord(binding.model)) invalid('model')
  const model = record(binding.model, ['provider', 'model', ...(Object.hasOwn(binding.model, 'reasoningEffort') ? ['reasoningEffort'] : [])], 'model')
  text(model.provider, 'provider'); text(model.model, 'model')
  if (Object.hasOwn(model, 'reasoningEffort')) text(model.reasoningEffort, 'reasoningEffort')
  if (binding.modelOrigin !== 'explicit-growth-override' && binding.modelOrigin !== 'inherited-owner-task') invalid('model origin')
  const budget = record(binding.budget, ['budgetId', 'amount', 'maxModelCalls', 'maxToolCalls', 'maxOutputTokens', 'maxDurationMs', 'maxPlansPerWake'], 'budget')
  text(budget.budgetId, 'budgetId')
  for (const key of ['amount', 'maxModelCalls', 'maxToolCalls', 'maxOutputTokens', 'maxDurationMs', 'maxPlansPerWake']) integer(budget[key], key)
  const native = record(binding.native, ['owner', 'automationId', 'definitionHash', 'occurrenceId'], 'native')
  if (native.owner !== 'assistant-growth-usage' || native.automationId !== binding.runId) invalid('native owner or identity')
  text(native.occurrenceId, 'occurrenceId'); hash(native.definitionHash, 'definitionHash')
  for (const key of ['createdAt', 'generationDeadlineAt', 'expiresAt']) {
    integer(binding[key], key, 0)
    if (Number(binding[key]) > 8_640_000_000_000_000) invalid(key)
  }
  if (Number(binding.createdAt) >= Number(binding.generationDeadlineAt) || Number(binding.generationDeadlineAt) > Number(binding.expiresAt)
    || Number(binding.generationDeadlineAt) - Number(binding.createdAt) > Number(budget.maxDurationMs)) invalid('deadline')
  validateWorkItemRevisionAuthorityPins(binding.authorities)
  validateRevisionAcceptanceAuthorityRef(binding.revisionAcceptance)
  if (sourceGrowthEvidenceDigest(binding.revisionAcceptance) !== sourceGrowthEvidenceDigest(binding.authorities.revisionAcceptance)) invalid('revision acceptance authority mismatch')
  if (Object.hasOwn(binding, 'revisionRegressionAcceptance')) {
    if (!Object.hasOwn(binding.authorities, 'revisionRegressionAcceptance')) invalid('revision regression authority missing')
    validateRevisionRegressionAcceptanceAuthorityRef(binding.revisionRegressionAcceptance)
    if (sourceGrowthEvidenceDigest(binding.revisionRegressionAcceptance) !== sourceGrowthEvidenceDigest(binding.authorities.revisionRegressionAcceptance)) invalid('revision regression authority mismatch')
  }
  const revisionAuthorities: Array<{ expiresAt: number }> = [binding.authorities.sourceJobs, binding.authorities.revisionGrant, binding.authorities.revisionAcceptance]
  if (Object.hasOwn(binding.authorities, 'revisionRegressionAcceptance')) revisionAuthorities.push(binding.authorities.revisionRegressionAcceptance!)
  if (Object.hasOwn(binding.authorities, 'revisionAdoption')) revisionAuthorities.push(binding.authorities.revisionAdoption!)
  for (const authority of revisionAuthorities) {
    if (authority.expiresAt <= Number(binding.createdAt) || Number(binding.generationDeadlineAt) > authority.expiresAt) invalid('work item revision authority expiry')
  }
}

export function anySourceGrowthRunDigest(binding: AnySourceGrowthRunBinding): string {
  validateAnySourceGrowthRunBinding(binding)
  return sourceGrowthEvidenceDigest(binding)
}
