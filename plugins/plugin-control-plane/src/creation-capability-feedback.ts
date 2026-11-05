import type { AssistantDeliveryService, OwnerForegroundLearningTask } from '@dsh-enhanced/assistant-delivery'
import type { AssistantEvaluationService, EvaluationCanonicalLearningEvidenceTuple } from '@dsh-enhanced/assistant-evaluation'
import { controlPlaneDigest } from './store.js'
import type { CreationCapabilityCallEvidence, CreationCapabilityOrdinaryUseLatency, CreationCapabilityOrdinaryUseMeasures,
  CreationCapabilityOrdinaryUseModel, CreationCapabilityOrdinaryUseReport, CreationCapabilityOrdinaryUseStratum,
  CreationCapabilityOwner, CreationCapabilityRecord, CreationCapabilityTaskAssociation } from './creation-capability-types.js'

type Evaluation = Pick<AssistantEvaluationService, 'canonicalHostScope' | 'getTrustedForegroundLearningProjection'
  | 'withTrustedCanonicalTaskWriterFence'>
type Delivery = Pick<AssistantDeliveryService, 'inspectOwnerForegroundLearningTask' | 'inspectOwnerForegroundTaskSource'>

export interface CreationCapabilityFeedbackInput {
  record: CreationCapabilityRecord
  calls: readonly CreationCapabilityCallEvidence[]
  triggerInboxId: string
  owner: CreationCapabilityOwner
  evaluation: Evaluation
  delivery: Delivery
  /** Read and check the exact historical source and current original task without taking another Evaluation fence. */
  readSourceCurrent(): { scopeWatermark: number; projection: EvaluationCanonicalLearningEvidenceTuple }
  now?: number
}

/** Below this many samples a measure is reported as insufficient rather than a number. */
export const DEFAULT_MINIMUM_SAMPLES = 5

interface AssociationRow {
  association: CreationCapabilityTaskAssociation
  model: CreationCapabilityOrdinaryUseModel
  callLatencyMs: number[]
  taskLatencyMs?: number
}

const same = (a: unknown, b: unknown): boolean => controlPlaneDigest(a) === controlPlaneDigest(b)

/** Read the current canonical head and the corresponding authenticated Delivery source. */
function readTask(input: CreationCapabilityFeedbackInput, inboxId: string): OwnerForegroundLearningTask | undefined {
  const { owner, evaluation, delivery } = input
  const scope = evaluation.canonicalHostScope({ workspace: owner.workspace, preset: owner.agentPreset })
  const canonical = evaluation.getTrustedForegroundLearningProjection({ scope, inboxId })
  if (!canonical || canonical.projection.subjectKind !== 'foreground-turn'
    || canonical.projection.subjectRef !== inboxId || canonical.projection.disposition !== 'upsert') return undefined
  const source = delivery.inspectOwnerForegroundLearningTask({ authorityId: owner.authorityId,
    principalId: owner.principalId, workspace: owner.workspace, agentPreset: owner.agentPreset,
    outcomeId: canonical.triggerOutcomeId })
  if (!source || source.protocol !== 'assistant-delivery/owner-foreground-learning/v1'
    || !same(source.canonical, canonical)
    || source.source.inboxId !== inboxId || source.source.truncated || !source.source.quiescent
    || source.owner.authorityId !== owner.authorityId || source.owner.authorityHash !== owner.authorityHash
    || source.owner.principalId !== owner.principalId || source.owner.principalRecordId !== owner.principalRecordId
    || source.owner.principalVersion !== owner.principalVersion || source.owner.workspace !== owner.workspace
    || source.owner.agentPreset !== owner.agentPreset || source.ownerRevision?.action === 'withdraw'
    || !['owner-feedback', 'independent-verifier'].includes(source.judgement)
    || !['achieved', 'not-achieved'].includes(source.canonical.objective?.status ?? '')) return undefined
  return source
}

function taskModel(source: OwnerForegroundLearningTask['source']): CreationCapabilityOrdinaryUseModel {
  const selection = source.modelSelection
  if (source.modelSelectionState === 'missing') return { state: 'missing' }
  if (source.modelSelectionState !== 'frozen' || !selection || typeof selection.provider !== 'string'
    || typeof selection.model !== 'string' || (selection.reasoningEffort !== undefined
      && typeof selection.reasoningEffort !== 'string')) return { state: 'inconsistent' }
  return { state: 'frozen', provider: selection.provider, model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) }
}

/**
 * One fenced read of grouped candidate Inboxes into current association rows. Undefined means no receipt, a mixed
 * session Inbox, a stale or changed fence, or a throw; `fenceEmpty` still checks the original task with no candidates.
 */
function readAssociationRows(input: CreationCapabilityFeedbackInput, fenceEmpty: boolean):
{ rows: readonly AssociationRow[]; candidates: number; receiptDigest: string; now: number } | undefined {
  const { record, calls, owner, delivery, evaluation } = input
  const receipt = record.receipt
  if (!receipt || receipt.planId !== record.planId || input.triggerInboxId.length === 0) return undefined
  const now = input.now ?? Date.now()
  const receiptDigest = controlPlaneDigest(receipt)
  const grouped = new Map<string, { sessionId: string; calls: CreationCapabilityCallEvidence[] }>()
  for (const call of calls) {
    const proof = call.foreground
    if (call.planId !== record.planId || call.status !== 'completed' || call.attribution !== 'foreground'
      || proof?.protocol !== 'assistant-delivery/foreground-tool-call/v1'
      || proof.task.protocol !== 'assistant-delivery/foreground-task/v1'
      || proof.task.inboxId === input.triggerInboxId || !call.claimedAt || !call.settledAt
      || proof.task.dispatchedAt <= receipt.adoptedAt
      || proof.task.dispatchedAt > call.claimedAt || call.claimedAt < receipt.adoptedAt
      || call.claimedAt >= receipt.expiresAt || call.claimedAt > now
      || call.settledAt < call.claimedAt || call.settledAt >= receipt.expiresAt || call.settledAt > now
      || call.receiptDigest !== receiptDigest || call.artifactSha256 !== receipt.artifactSha256
      || call.schemaDigest !== receipt.schemaDigest || call.toolAlias !== proof.call.toolName
      || !record.tools?.some(tool => tool.name === call.toolAlias && tool.originalName === call.originalName)
      || proof.task.scope.workspace !== owner.workspace || proof.task.scope.preset !== owner.agentPreset
      || proof.task.owner.principalRecordId !== owner.principalRecordId
      || proof.task.owner.principalVersion !== owner.principalVersion) continue
    const prior = grouped.get(proof.task.inboxId)
    if (prior && prior.sessionId !== proof.task.sessionId) return undefined
    if (prior) prior.calls.push(call)
    else grouped.set(proof.task.inboxId, { sessionId: proof.task.sessionId, calls: [call] })
  }
  if (grouped.size === 0 && !fenceEmpty) return { rows: [], candidates: 0, receiptDigest, now }
  const scope = evaluation.canonicalHostScope({ workspace: owner.workspace, preset: owner.agentPreset })
  const read = (): { original: ReturnType<CreationCapabilityFeedbackInput['readSourceCurrent']>;
    rows: AssociationRow[]; evidence: EvaluationCanonicalLearningEvidenceTuple[]; watermark: number } => {
    const original = input.readSourceCurrent()
    if (original.projection.subjectKind !== 'foreground-turn'
      || original.projection.subjectRef !== input.triggerInboxId || original.projection.disposition !== 'upsert') {
      throw new Error('created capability original task is no longer current')
    }
    const evidence: EvaluationCanonicalLearningEvidenceTuple[] = [original.projection]
    const rows: AssociationRow[] = []
    let watermark = original.scopeWatermark
    for (const [inboxId, group] of grouped) {
      const source = readTask(input, inboxId)
      if (!source) continue
      const originalSource = delivery.inspectOwnerForegroundTaskSource({ authorityId: owner.authorityId,
        principalId: owner.principalId, workspace: owner.workspace, agentPreset: owner.agentPreset,
        expectedOwner: { authorityHash: owner.authorityHash, principalRecordId: owner.principalRecordId,
          principalVersion: owner.principalVersion }, inboxId })
      if (!originalSource || originalSource.binding.sessionId !== group.sessionId
        || source.source.sessionId !== group.sessionId
        || source.owner.bindingVersion !== originalSource.binding.version
        || source.owner.generation !== originalSource.binding.generation
        || originalSource.authorityId !== owner.authorityId || originalSource.authorityHash !== owner.authorityHash
        || originalSource.principalId !== owner.principalId
        || originalSource.owner.principalRecordId !== owner.principalRecordId
        || originalSource.owner.principalVersion !== owner.principalVersion) continue
      const valid = group.calls.filter(call => {
        const task = call.foreground!.task
        return task.binding.id === originalSource.binding.id && task.binding.version === originalSource.binding.version
          && task.binding.generation === originalSource.binding.generation
      })
      if (valid.length === 0) continue
      evidence.push(source.canonical.projection)
      watermark = Math.max(watermark, source.canonical.scopeWatermark)
      const projection = source.canonical.projection
      const execution = originalSource.execution as typeof originalSource.execution | undefined
      const taskLatencyMs = execution?.quiescent && Number.isSafeInteger(execution.completedAt)
        && Number.isSafeInteger(execution.dispatchedAt) && execution.completedAt >= execution.dispatchedAt
        ? execution.completedAt - execution.dispatchedAt : undefined
      rows.push({ association: { protocol: 'dsh-created-capability-task-association/v1', planId: record.planId,
        inboxId, sessionId: group.sessionId, callKeys: valid.map(call => call.key).sort(),
        receiptDigest, artifactSha256: receipt.artifactSha256, schemaDigest: receipt.schemaDigest,
        adoptionStatus: record.status,
        withinSignedUseWindow: now >= receipt.adoptedAt && now < receipt.expiresAt,
        task: { projection: { subjectKind: 'foreground-turn', subjectRef: inboxId, version: projection.version,
          digest: projection.digest, disposition: 'upsert' }, scopeWatermark: source.canonical.scopeWatermark,
          outcomeId: source.canonical.triggerOutcomeId,
          judgement: source.judgement as 'owner-feedback' | 'independent-verifier',
          status: source.canonical.objective!.status as 'achieved' | 'not-achieved',
          sourceDigest: controlPlaneDigest({ protocol: source.protocol, source: source.source,
            judgement: source.judgement, ownerRevision: source.ownerRevision }) } },
      model: taskModel(source.source), callLatencyMs: valid.map(call => call.settledAt! - call.claimedAt!),
      ...(taskLatencyMs === undefined ? {} : { taskLatencyMs }) })
    }
    return { original, rows, evidence, watermark }
  }
  try {
    const before = read()
    const result = evaluation.withTrustedCanonicalTaskWriterFence({ scope,
      scopeWatermark: before.watermark, evidence: before.evidence }, () => {
      const during = read()
      if (!same(during, before)) throw new Error('created capability task association source changed')
      return during.rows
    })
    return result.matched ? { rows: result.value, candidates: grouped.size, receiptDigest, now } : undefined
  } catch { return undefined }
}

/** No cache: every result is checked against the current canonical writer and owner route. */
export function inspectCreationCapabilityTaskAssociations(input: CreationCapabilityFeedbackInput): readonly CreationCapabilityTaskAssociation[] {
  const rows = readAssociationRows(input, false)?.rows ?? []
  return rows.length === 0 ? [] : Object.freeze(rows.map(({ association: item }) => Object.freeze({ ...item,
    callKeys: Object.freeze([...item.callKeys]),
    task: Object.freeze({ ...item.task, projection: Object.freeze({ ...item.task.projection }) }),
  })))
}

const modelKey = (model: CreationCapabilityOrdinaryUseModel): string => model.state === 'frozen'
  ? JSON.stringify([model.state, model.provider, model.model, model.reasoningEffort ?? null]) : JSON.stringify([model.state])

function latency(values: readonly number[], minimumSamples: number): CreationCapabilityOrdinaryUseLatency {
  if (values.length === 0) return { status: 'unmeasured', samples: 0 }
  if (values.length < minimumSamples) return { status: 'insufficient', samples: values.length }
  const sorted = [...values].sort((a, b) => a - b)
  return { status: 'measured', samples: sorted.length, p50Ms: sorted[Math.ceil(sorted.length / 2) - 1]!,
    maxMs: sorted[sorted.length - 1]! }
}

function measures(rows: readonly AssociationRow[], minimumSamples: number): CreationCapabilityOrdinaryUseMeasures {
  const achieved = rows.filter(row => row.association.task.status === 'achieved').length
  return { quality: { status: rows.length < minimumSamples ? 'insufficient' : 'measured', samples: rows.length,
    achieved, notAchieved: rows.length - achieved },
  callLatency: latency(rows.flatMap(row => row.callLatencyMs), minimumSamples),
  taskLatency: latency(rows.flatMap(row => row.taskLatencyMs === undefined ? [] : [row.taskLatencyMs]), minimumSamples) }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

/**
 * Descriptive, non-causal counts over the same fenced current associations: one latest-revision quality sample per
 * Inbox, strata by frozen task model only. Undefined only for a missing receipt, a failed fence or a throw.
 */
export function inspectCreationCapabilityOrdinaryUseReport(input: CreationCapabilityFeedbackInput & { minimumSamples?: number }):
CreationCapabilityOrdinaryUseReport | undefined {
  const minimumSamples = input.minimumSamples ?? DEFAULT_MINIMUM_SAMPLES
  if (!Number.isSafeInteger(minimumSamples) || minimumSamples < 1) {
    throw new TypeError('created capability ordinary-use minimumSamples must be a positive safe integer')
  }
  const read = readAssociationRows(input, true)
  const receipt = input.record.receipt
  if (!read || !receipt) return undefined
  const rows = [...read.rows].sort((a, b) => a.association.inboxId < b.association.inboxId ? -1
    : a.association.inboxId > b.association.inboxId ? 1 : 0)
  const buckets = new Map<string, { model: CreationCapabilityOrdinaryUseModel; rows: AssociationRow[] }>()
  for (const row of rows) {
    const key = modelKey(row.model)
    const bucket = buckets.get(key)
    if (bucket) bucket.rows.push(row)
    else buckets.set(key, { model: row.model, rows: [row] })
  }
  const strata: CreationCapabilityOrdinaryUseStratum[] = [...buckets].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([, bucket]) => ({ model: bucket.model, ...measures(bucket.rows, minimumSamples) }))
  return deepFreeze({ protocol: 'dsh-created-capability-ordinary-use-report/v1', causal: false,
    planId: input.record.planId, receiptDigest: read.receiptDigest, artifactSha256: receipt.artifactSha256,
    schemaDigest: receipt.schemaDigest, adoptionStatus: input.record.status,
    withinSignedUseWindow: read.now >= receipt.adoptedAt && read.now < receipt.expiresAt, minimumSamples,
    associationsDigest: controlPlaneDigest(rows.map(row => row.association)),
    unknown: { inboxes: read.candidates - rows.length }, overall: measures(rows, minimumSamples), strata,
    regressions: { status: 'unmeasured' }, cost: { status: 'unmeasured' } })
}
