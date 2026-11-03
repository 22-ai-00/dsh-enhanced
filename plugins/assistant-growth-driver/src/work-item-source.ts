import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import { isAbsolute, resolve } from 'node:path'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { validateWorkItemGrowthAuthorityPins, type WorkItemGrowthAuthorityPins, type WorkItemSourceGrowthRunBinding } from '@dsh-enhanced/assistant-growth-contract'
import type { OwnerForegroundLearningTask, OwnerWorkItemEngineeringContextSource } from '@dsh-enhanced/assistant-delivery'

export type UsageStableOwner = Pick<OwnerForegroundLearningTask['owner'], 'authorityId' | 'authorityHash' | 'principalId' | 'principalRecordId' | 'principalVersion' | 'workspace' | 'agentPreset'>
export const workItemStableOwner = (owner: UsageStableOwner): UsageStableOwner => ({ authorityId: owner.authorityId, authorityHash: owner.authorityHash, principalId: owner.principalId, principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion, workspace: owner.workspace, agentPreset: owner.agentPreset })
export interface WorkItemUsageLocator {
  protocol: 'assistant-growth/work-item-usage-locator/v1'
  configDigest: string
  owner: UsageStableOwner
  itemId: string
  canonical: { outcomeId: string; version: number; digest: string; objectiveStatus: 'not-achieved' }
  createdAt: number
  expiresAt: number
}
export function validateWorkItemUsageLocator(value: unknown): asserts value is WorkItemUsageLocator {
  const locator = ownData(value) as WorkItemUsageLocator
  if (Object.keys(locator).sort().join(',') !== 'canonical,configDigest,createdAt,expiresAt,itemId,owner,protocol'
    || locator.protocol !== 'assistant-growth/work-item-usage-locator/v1' || !/^[a-f0-9]{64}$/u.test(locator.configDigest)
    || typeof locator.itemId !== 'string' || !locator.itemId || locator.itemId.length > 500
    || Object.keys(locator.canonical).sort().join(',') !== 'digest,objectiveStatus,outcomeId,version'
    || locator.canonical.objectiveStatus !== 'not-achieved' || typeof locator.canonical.outcomeId !== 'string'
    || !locator.canonical.outcomeId || locator.canonical.outcomeId.length > 500 || !/^[a-f0-9]{64}$/u.test(locator.canonical.digest)
    || !Number.isSafeInteger(locator.canonical.version) || locator.canonical.version < 1
    || !Number.isSafeInteger(locator.createdAt) || locator.createdAt < 0 || !Number.isSafeInteger(locator.expiresAt)
    || locator.expiresAt <= locator.createdAt || locator.expiresAt > 8_640_000_000_000_000) throw new Error('invalid work item usage locator')
  const owner = locator.owner
  if (Object.keys(owner).sort().join(',') !== 'agentPreset,authorityHash,authorityId,principalId,principalRecordId,principalVersion,workspace'
    || !/^[a-f0-9]{64}$/u.test(owner.authorityHash) || !Number.isSafeInteger(owner.principalVersion) || owner.principalVersion < 1
    || [owner.authorityId, owner.principalId, owner.principalRecordId, owner.agentPreset].some(value => typeof value !== 'string' || !value || value.length > 500 || /\p{Cc}/u.test(value))
    || typeof owner.workspace !== 'string' || !isAbsolute(owner.workspace) || resolve(owner.workspace) !== owner.workspace || owner.workspace === '/') throw new Error('invalid work item usage owner')
}
export interface WorkItemUsageSource extends OwnerWorkItemEngineeringContextSource {
  protocol: 'assistant-delivery/work-item-engineering-context/v1'
  parentReports: readonly Readonly<{ itemId: string; revision: number; text: string; fullTextDigest: string; fullBytes: number }>[]
}
export interface WorkItemCreationReadiness {
  protocol: 'assistant-growth/work-item-creation-readiness/v1'
  sourceProtocol: 'assistant-delivery/work-item-engineering-context/v1'
  runProtocol: 'assistant-growth/source-run/v2'
  workItemFailures: true
  pins: WorkItemGrowthAuthorityPins
  remaining: { sourceSubmissions: number; creates: number; verifications: number; adoptions: number }
  available: boolean
}
export const workItemTextDigest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
export function workItemAuthorityDeadline(pins: WorkItemGrowthAuthorityPins): number {
  return Math.min(pins.sourceJobs.expiresAt, pins.creationGrant.expiresAt, pins.creationAcceptance.expiresAt, pins.adoption.expiresAt)
}
export function isWorkItemCreationReady(value: unknown, pins: WorkItemGrowthAuthorityPins, now = Date.now(), admission = true): value is WorkItemCreationReadiness {
  try {
    const result = ownData(value) as WorkItemCreationReadiness
    if (Object.keys(result).sort().join(',') !== 'available,pins,protocol,remaining,runProtocol,sourceProtocol,workItemFailures'
      || result.protocol !== 'assistant-growth/work-item-creation-readiness/v1'
      || result.sourceProtocol !== 'assistant-delivery/work-item-engineering-context/v1'
      || result.runProtocol !== 'assistant-growth/source-run/v2' || result.workItemFailures !== true || typeof result.available !== 'boolean' || admission && result.available !== true) return false
    validateWorkItemGrowthAuthorityPins(result.pins)
    return acceptanceDigest(result.pins) === acceptanceDigest(pins) && workItemAuthorityDeadline(pins) > now
      && Object.keys(result.remaining).sort().join(',') === 'adoptions,creates,sourceSubmissions,verifications'
      && Object.values(result.remaining).every(count => Number.isSafeInteger(count) && count >= (admission ? 1 : 0))
  } catch { return false }
}
/** New source data may contain exact NUL/non-NFC text, but never accessors, proxies or executable values. */
export function ownData<T>(input: T): T {
  const seen = new Set<object>(); let nodes = 0
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 65_536 || depth > 64) throw new Error('work item growth data exceeds bounds')
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isSafeInteger(value)) return
    if (typeof value === 'string' && value.isWellFormed() && Buffer.byteLength(value) <= 524_288) return
    if (typeof value !== 'object' || utilTypes.isProxy(value) || seen.has(value)
      || ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(value))) throw new Error('invalid work item growth data')
    seen.add(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Array.isArray(value)) delete descriptors.length
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')
      || Object.values(descriptors).some(field => !field.enumerable || !('value' in field))) throw new Error('invalid work item growth own data')
    for (const field of Object.values(descriptors)) visit(field.value, depth + 1)
    seen.delete(value)
  }
  visit(input, 0)
  const json = JSON.stringify(input)
  if (Buffer.byteLength(json) > 1_048_576) throw new Error('work item growth snapshot too large')
  return JSON.parse(json) as T
}
export function freezeWorkItemData<T>(input: T): T {
  const value = ownData(input)
  const freeze = (item: unknown): void => {
    if (item && typeof item === 'object') { for (const field of Object.values(item)) freeze(field); Object.freeze(item) }
  }
  freeze(value); return value
}
export function workItemRunSource(source: WorkItemUsageSource): WorkItemSourceGrowthRunBinding['source'] {
  const task = source.task, projection = task.canonical.projection
  if (projection.subjectKind !== 'work-item' || projection.disposition !== 'upsert'
    || task.canonical.objective?.status !== 'not-achieved' || source.manifest.itemId !== task.proofIdentity.itemId
    || Buffer.byteLength(source.objective) !== source.manifest.objective.fullBytes || Buffer.byteLength(source.objective) > 16_384
    || workItemTextDigest(source.objective) !== source.manifest.objective.fullTextDigest) throw new Error('work item engineering source changed')
  return { protocol: 'assistant-growth/work-item-source/v1', itemId: task.proofIdentity.itemId,
    outcomeId: task.canonical.objective.outcomeId, projection: { subjectKind: 'work-item', subjectRef: projection.subjectRef,
      version: projection.version, digest: projection.digest, disposition: 'upsert',
      ...(projection.evidenceOutcomeId === undefined ? {} : { evidenceOutcomeId: projection.evidenceOutcomeId }) },
    objectiveStatus: 'not-achieved', sourceDigest: task.sourceDigest, presentationDigest: task.presentationDigest,
    context: { protocol: source.manifest.protocol, manifestDigest: source.manifest.manifestDigest,
      objectiveDigest: source.manifest.objective.fullTextDigest, objectiveBytes: source.manifest.objective.fullBytes } }
}
