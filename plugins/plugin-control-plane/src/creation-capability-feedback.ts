import type { AssistantDeliveryService, OwnerForegroundLearningTask } from '@dsh-enhanced/assistant-delivery'
import type { AssistantEvaluationService, EvaluationCanonicalLearningEvidenceTuple,
  TrustedTaskLearningProjectionReceipt } from '@dsh-enhanced/assistant-evaluation'
import { controlPlaneDigest } from './store.js'
import type { CreationCapabilityAttributionArm, CreationCapabilityAttributionDelta, CreationCapabilityAttributionStratum,
  CreationCapabilityAvailabilityAttribution, CreationCapabilityCallEvidence, CreationCapabilityOrdinaryUseLatency, CreationCapabilityOrdinaryUseMeasures,
  CreationCapabilityOrdinaryUseModel, CreationCapabilityOrdinaryUseReport, CreationCapabilityOrdinaryUseStratum,
  CreationCapabilityOrdinaryUseQuality, CreationCapabilityOrdinaryUseTrend, CreationCapabilityOwner, CreationCapabilityRecord,
  CreationCapabilityTaskAssociation, CreationCapabilityTrendCell, CreationCapabilityTrendDifferenceInDifferences,
  CreationCapabilityTrendFlag, CreationCapabilityTrendParallelCheck, CreationCapabilityTrendStratum,
  CreationCapabilityTrendWindow } from './creation-capability-types.js'

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

/** Below this many samples a measure is marked insufficient; latency percentiles are withheld, quality counts stay exact. */
export const DEFAULT_MINIMUM_SAMPLES = 5

interface AssociationRow {
  association: CreationCapabilityTaskAssociation
  model: CreationCapabilityOrdinaryUseModel
  callLatencyMs: number[]
  taskLatencyMs?: number
  /** Owner revision action on the CURRENT canonical row ('initial' when absent). */
  ownerRevisionAction: 'initial' | 'correct' | 'withdraw'
}

const same = (a: unknown, b: unknown): boolean => controlPlaneDigest(a) === controlPlaneDigest(b)

/** Read the current canonical head and the corresponding authenticated Delivery source. */
function readTask(input: CreationCapabilityFeedbackInput, inboxId: string): OwnerForegroundLearningTask | undefined {
  const { owner, evaluation } = input
  const scope = evaluation.canonicalHostScope({ workspace: owner.workspace, preset: owner.agentPreset })
  return certifiedTask(input, evaluation.getTrustedForegroundLearningProjection({ scope, inboxId }), inboxId)
}

/** The authenticated Delivery source of one current certified foreground head, or undefined. */
function certifiedTask(input: Pick<CreationCapabilityFeedbackInput, 'owner' | 'delivery'>,
  canonical: TrustedTaskLearningProjectionReceipt | undefined, inboxId: string): OwnerForegroundLearningTask | undefined {
  const { owner, delivery } = input
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

type CallGroups = Map<string, { sessionId: string; calls: CreationCapabilityCallEvidence[] }>

/** Completed foreground calls of this exact adoption grouped by Inbox; undefined for a mixed-session Inbox. */
function eligibleCalls(input: CreationCapabilityFeedbackInput, receipt: NonNullable<CreationCapabilityRecord['receipt']>,
  receiptDigest: string, now: number): CallGroups | undefined {
  const { record, calls, owner } = input
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
  return grouped
}

/** Owner-fenced original task source whose binding matches the current learning head. */
function originalTaskSource(input: CreationCapabilityFeedbackInput, source: OwnerForegroundLearningTask, inboxId: string) {
  const { owner, delivery } = input
  const originalSource = delivery.inspectOwnerForegroundTaskSource({ authorityId: owner.authorityId,
    principalId: owner.principalId, workspace: owner.workspace, agentPreset: owner.agentPreset,
    expectedOwner: { authorityHash: owner.authorityHash, principalRecordId: owner.principalRecordId,
      principalVersion: owner.principalVersion }, inboxId })
  if (!originalSource || source.source.sessionId !== originalSource.binding.sessionId
    || source.owner.bindingVersion !== originalSource.binding.version
    || source.owner.generation !== originalSource.binding.generation
    || originalSource.authorityId !== owner.authorityId || originalSource.authorityHash !== owner.authorityHash
    || originalSource.principalId !== owner.principalId
    || originalSource.owner.principalRecordId !== owner.principalRecordId
    || originalSource.owner.principalVersion !== owner.principalVersion) return undefined
  return originalSource
}

const sameBinding = (call: CreationCapabilityCallEvidence, binding: { id: string; version: number; generation: number }) => {
  const task = call.foreground!.task
  return task.binding.id === binding.id && task.binding.version === binding.version && task.binding.generation === binding.generation
}

const taskLatencyMs = (execution: { quiescent: boolean; dispatchedAt: number; completedAt: number } | undefined) =>
  execution?.quiescent && Number.isSafeInteger(execution.completedAt)
    && Number.isSafeInteger(execution.dispatchedAt) && execution.completedAt >= execution.dispatchedAt
    ? execution.completedAt - execution.dispatchedAt : undefined

/**
 * One fenced read of grouped candidate Inboxes into current association rows. Undefined means no receipt, a mixed
 * session Inbox, a stale or changed fence, or a throw; `fenceEmpty` still checks the original task with no candidates.
 */
function readAssociationRows(input: CreationCapabilityFeedbackInput, fenceEmpty: boolean):
{ rows: readonly AssociationRow[]; candidates: number; receiptDigest: string; now: number } | undefined {
  const { record, owner, evaluation } = input
  const receipt = record.receipt
  if (!receipt || receipt.planId !== record.planId || input.triggerInboxId.length === 0) return undefined
  const now = input.now ?? Date.now()
  const receiptDigest = controlPlaneDigest(receipt)
  const grouped = eligibleCalls(input, receipt, receiptDigest, now)
  if (!grouped) return undefined
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
      const originalSource = originalTaskSource(input, source, inboxId)
      if (!originalSource || originalSource.binding.sessionId !== group.sessionId) continue
      const valid = group.calls.filter(call => sameBinding(call, originalSource.binding))
      if (valid.length === 0) continue
      evidence.push(source.canonical.projection)
      watermark = Math.max(watermark, source.canonical.scopeWatermark)
      const projection = source.canonical.projection
      const latencyMs = taskLatencyMs(originalSource.execution as typeof originalSource.execution | undefined)
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
      ownerRevisionAction: source.ownerRevision?.action ?? 'initial',
      ...(latencyMs === undefined ? {} : { taskLatencyMs: latencyMs }) })
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

type AttributionEvaluation = Evaluation & Pick<AssistantEvaluationService, 'listTrustedTaskLearningProjections'
  | 'withTrustedCanonicalScopeWriterFence'>

export interface CreationCapabilityAttributionInput extends CreationCapabilityFeedbackInput {
  evaluation: AttributionEvaluation
  /** Adoption times of every other journal record with a receipt; only counted as a concurrent-change flag. */
  otherAdoptedAt?: readonly number[]
  minimumSamples?: number
  /** Equal arm length; defaults to and is clamped by the elapsed signed use window. */
  windowMs?: number
  /** Fail closed above this many current canonical heads in the owner scope. */
  maxScannedHeads?: number
}

export const DEFAULT_MAX_SCANNED_HEADS = 5_000

interface AttributionRow {
  arm: 'before' | 'after'
  inboxId: string
  model: CreationCapabilityOrdinaryUseModel
  status: 'achieved' | 'not-achieved'
  projection: { version: number; digest: string }
  outcomeId: string
  sourceDigest: string
  exposed: boolean
  taskLatencyMs?: number
}

type Excluded = CreationCapabilityAvailabilityAttribution['population']['excluded']

/** Every current canonical head of the scope under one unchanged scope watermark; throws when it moves or overflows. */
function scanScope(evaluation: AttributionEvaluation, scope: ReturnType<Evaluation['canonicalHostScope']>,
  maxScannedHeads: number): { heads: TrustedTaskLearningProjectionReceipt[]; scopeWatermark: number } {
  const heads: TrustedTaskLearningProjectionReceipt[] = []
  let after: { scopeKey: string; watermark: number } | undefined
  let scopeWatermark: number | undefined
  for (;;) {
    const page = evaluation.listTrustedTaskLearningProjections({ scope, ...(after ? { after } : {}), limit: 100 })
    if (scopeWatermark !== undefined && page.scopeWatermark !== scopeWatermark) {
      throw new Error('created capability attribution scope changed during scan')
    }
    scopeWatermark = page.scopeWatermark
    heads.push(...page.items.map(item => item.receipt))
    if (heads.length > maxScannedHeads) throw new Error('created capability attribution scope is too large')
    if (!page.hasMore) return { heads, scopeWatermark: page.scopeWatermark }
    after = page.nextCursor
  }
}

function arm(rows: readonly AttributionRow[], minimumSamples: number): CreationCapabilityAttributionArm {
  const achieved = rows.filter(row => row.status === 'achieved').length
  return { quality: { status: rows.length < minimumSamples ? 'insufficient' : 'measured', samples: rows.length,
    achieved, notAchieved: rows.length - achieved },
  taskLatency: latency(rows.flatMap(row => row.taskLatencyMs === undefined ? [] : [row.taskLatencyMs]), minimumSamples) }
}

/** a1/n1 - a0/n0 = (a1*n0 - a0*n1) / (n0*n1), exact and unreduced. */
function delta(before: CreationCapabilityAttributionArm, after: CreationCapabilityAttributionArm):
CreationCapabilityAttributionDelta {
  if (before.quality.status !== 'measured' || after.quality.status !== 'measured') return { status: 'insufficient' }
  const numerator = after.quality.achieved * before.quality.samples - before.quality.achieved * after.quality.samples
  return { status: 'paired', numerator, denominator: before.quality.samples * after.quality.samples,
    sign: numerator > 0 ? 1 : numerator < 0 ? -1 : 0 }
}

/**
 * Intention-to-treat before/after attribution of one adoption: every certified current owner foreground task (one
 * latest-revision head per Inbox; corrections replace, withdrawals retract) in equal windows around adoption, by
 * frozen task model. Read once, then reread under an unchanged Evaluation scope watermark. Undefined for a missing
 * receipt, an oversized scope, a changed source, scope or fence, or a throw. Observational, never causal.
 */
export function inspectCreationCapabilityAvailabilityAttribution(input: CreationCapabilityAttributionInput):
CreationCapabilityAvailabilityAttribution | undefined {
  const minimumSamples = input.minimumSamples ?? DEFAULT_MINIMUM_SAMPLES
  const maxScannedHeads = input.maxScannedHeads ?? DEFAULT_MAX_SCANNED_HEADS
  for (const [name, value] of [['minimumSamples', minimumSamples], ['maxScannedHeads', maxScannedHeads]] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`created capability attribution ${name} must be a positive safe integer`)
    }
  }
  if (input.windowMs !== undefined && (!Number.isSafeInteger(input.windowMs) || input.windowMs < 1)) {
    throw new TypeError('created capability attribution windowMs must be a positive safe integer')
  }
  const { record, owner, evaluation } = input
  const receipt = record.receipt
  if (!receipt || receipt.planId !== record.planId || input.triggerInboxId.length === 0) return undefined
  const now = input.now ?? Date.now()
  const receiptDigest = controlPlaneDigest(receipt)
  const elapsed = Math.max(0, Math.min(now, receipt.expiresAt) - receipt.adoptedAt)
  const windowMs = Math.min(input.windowMs ?? elapsed, elapsed)
  const grouped = eligibleCalls(input, receipt, receiptDigest, now)
  if (!grouped) return undefined
  const scope = evaluation.canonicalHostScope({ workspace: owner.workspace, preset: owner.agentPreset })
  const scan = () => scanScope(evaluation, scope, maxScannedHeads)
  const read = (heads: readonly TrustedTaskLearningProjectionReceipt[]) => {
    const original = input.readSourceCurrent()
    if (original.projection.subjectKind !== 'foreground-turn'
      || original.projection.subjectRef !== input.triggerInboxId || original.projection.disposition !== 'upsert') {
      throw new Error('created capability original task is no longer current')
    }
    const excluded: Excluded = { nonForeground: 0, trigger: 0, retracted: 0, unverified: 0, outsideWindow: 0 }
    const rows: AttributionRow[] = []
    for (const head of heads) {
      const inboxId = head.projection.subjectRef
      if (head.projection.subjectKind !== 'foreground-turn') { excluded.nonForeground++; continue }
      if (inboxId === input.triggerInboxId) { excluded.trigger++; continue }
      if (head.projection.disposition !== 'upsert') { excluded.retracted++; continue }
      const source = certifiedTask(input, head, inboxId)
      const originalSource = source && originalTaskSource(input, source, inboxId)
      const dispatchedAt = (originalSource?.execution as { dispatchedAt?: number } | undefined)?.dispatchedAt
      if (!source || !originalSource || !Number.isSafeInteger(dispatchedAt)) { excluded.unverified++; continue }
      const at = dispatchedAt!
      const side = windowMs > 0 && at >= receipt.adoptedAt - windowMs && at <= receipt.adoptedAt ? 'before'
        : windowMs > 0 && at > receipt.adoptedAt && at <= receipt.adoptedAt + windowMs ? 'after' : undefined
      if (!side) { excluded.outsideWindow++; continue }
      const group = grouped.get(inboxId)
      const latencyMs = taskLatencyMs(originalSource.execution as typeof originalSource.execution | undefined)
      rows.push({ arm: side, inboxId, model: taskModel(source.source),
        status: source.canonical.objective!.status as 'achieved' | 'not-achieved',
        projection: { version: head.projection.version, digest: head.projection.digest },
        outcomeId: head.triggerOutcomeId,
        sourceDigest: controlPlaneDigest({ protocol: source.protocol, source: source.source,
          judgement: source.judgement, ownerRevision: source.ownerRevision }),
        exposed: side === 'after' && group !== undefined && group.sessionId === originalSource.binding.sessionId
          && group.calls.some(call => sameBinding(call, originalSource.binding)),
        ...(latencyMs === undefined ? {} : { taskLatencyMs: latencyMs }) })
    }
    rows.sort((a, b) => a.inboxId < b.inboxId ? -1 : a.inboxId > b.inboxId ? 1 : 0)
    return { original, rows, excluded }
  }
  let result: { heads: TrustedTaskLearningProjectionReceipt[]; scopeWatermark: number; read: ReturnType<typeof read> }
  try {
    const scanned = scan()
    const before = read(scanned.heads)
    // An unchanged scope watermark means an unchanged feed; Delivery and the original source are reread inside.
    const fenced = evaluation.withTrustedCanonicalScopeWriterFence({ scope, scopeWatermark: scanned.scopeWatermark }, () => {
      const during = read(scanned.heads)
      if (!same(during, before)) throw new Error('created capability attribution source changed')
      return during
    })
    if (!fenced.matched) return undefined
    result = { ...scanned, read: fenced.value }
  } catch { return undefined }
  const { rows, excluded } = result.read
  const buckets = new Map<string, { model: CreationCapabilityOrdinaryUseModel; rows: AttributionRow[] }>()
  for (const row of rows) {
    const key = modelKey(row.model)
    const bucket = buckets.get(key)
    if (bucket) bucket.rows.push(row)
    else buckets.set(key, { model: row.model, rows: [row] })
  }
  const strata: CreationCapabilityAttributionStratum[] = [...buckets].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([, bucket]) => {
      const beforeArm = arm(bucket.rows.filter(row => row.arm === 'before'), minimumSamples)
      const afterArm = arm(bucket.rows.filter(row => row.arm === 'after'), minimumSamples)
      return { model: bucket.model, before: beforeArm, after: afterArm, achievedRateDelta: delta(beforeArm, afterArm) }
    })
  const signs = new Set(strata.flatMap(stratum => stratum.achievedRateDelta.status === 'paired'
    ? [stratum.achievedRateDelta.sign] : []))
  const direction = signs.size === 0 ? 'insufficient' : signs.size > 1 ? 'mixed'
    : signs.has(1) ? 'improved' : signs.has(-1) ? 'regressed' : 'unchanged'
  const concurrent = windowMs === 0 ? 0 : (input.otherAdoptedAt ?? []).filter(at => Number.isFinite(at)
    && at >= receipt.adoptedAt - windowMs && at <= receipt.adoptedAt + windowMs).length
  const afterRows = rows.filter(row => row.arm === 'after')
  return deepFreeze({ protocol: 'dsh-created-capability-availability-attribution/v1', causal: false,
    design: 'adoption-before-after-itt-model-stratified', planId: record.planId, receiptDigest,
    artifactSha256: receipt.artifactSha256, schemaDigest: receipt.schemaDigest, adoptionStatus: record.status,
    withinSignedUseWindow: now >= receipt.adoptedAt && now < receipt.expiresAt, minimumSamples, windowMs,
    scopeWatermark: result.scopeWatermark, rowsDigest: controlPlaneDigest(rows),
    population: { scanned: result.heads.length, counted: rows.length, excluded },
    exposure: { afterTasks: afterRows.length, exposedTasks: afterRows.filter(row => row.exposed).length },
    concurrentAdoptions: { status: concurrent === 0 ? 'none' : 'flagged', count: concurrent },
    strata, direction, regressions: { status: 'unmeasured' }, cost: { status: 'unmeasured' } })
}

export const TREND_DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
export const TREND_WINDOW_MS_BOUNDS = { min: 60 * 60 * 1000, max: 90 * 24 * 60 * 60 * 1000 } as const
export const TREND_DEFAULT_PRE_WINDOWS = 4
export const TREND_DEFAULT_MAX_POST_WINDOWS = 12
export const TREND_WINDOW_COUNT_MAX = 52
export const TREND_DEFAULT_PARALLEL_TREND_THRESHOLD = 0.2

/** Fixed, machine-readable statement of what the estimate assumes; it is never a causal claim. */
export const TREND_ASSUMPTIONS: readonly string[] = Object.freeze([
  'parallel-trends: without this adoption the treated and control session cohorts would change achieved rate equally',
  'session-cohort: a session is treated when a counted after-window task in it has an exact call of this adoption; membership is chosen after adoption, so selection on post-adoption use is not removed',
  'no-spillover: control sessions are assumed unaffected although the capability is available to them',
  'independent-tasks: the 95% interval is a four-cell Price-Bonett adjusted Wald interval (each cell (y+0.5)/(n+1)), centered on the adjusted estimate, over independent task outcomes',
  'session-rotation: after an owner DM /new rotation the earlier session is a time-split control of the same owner, not a parallel one',
  'availability: after windows end at min(now, expiresAt) only; a non-active adoption record (closed, rejected, unknown) is still treated as available and flagged adoption-not-active',
])

export interface CreationCapabilityTrendInput extends CreationCapabilityAttributionInput {
  /** Window length, default 7 days, bounded to [1 hour, 90 days]. */
  windowMs?: number
  /** Windows before adoption, default 4, bounded to [2, 52]. */
  preWindows?: number
  /** Cap on windows after adoption, default 12, bounded to [1, 52]; later tasks are outside every window. */
  maxPostWindows?: number
  /** Absolute pre-adoption gap drift above which the parallel-trend assumption is flagged, in (0, 1]. */
  parallelTrendThreshold?: number
}

interface TrendRow {
  index: number
  inboxId: string
  sessionId: string
  model: CreationCapabilityOrdinaryUseModel
  status: 'achieved' | 'not-achieved'
  projection: { version: number; digest: string }
  outcomeId: string
  sourceDigest: string
  calls: number
}

const quality = (rows: readonly TrendRow[], minimumSamples: number): CreationCapabilityOrdinaryUseQuality => {
  const achieved = rows.filter(row => row.status === 'achieved').length
  return { status: rows.length < minimumSamples ? 'insufficient' : 'measured', samples: rows.length,
    achieved, notAchieved: rows.length - achieved }
}

const rate = (cell: CreationCapabilityOrdinaryUseQuality) => cell.achieved / cell.samples

function differenceInDifferences(cells: readonly CreationCapabilityOrdinaryUseQuality[]):
CreationCapabilityTrendDifferenceInDifferences {
  if (cells.some(cell => cell.status !== 'measured')) return { status: 'insufficient' }
  const [t0, t1, c0, c1] = cells as [CreationCapabilityOrdinaryUseQuality, CreationCapabilityOrdinaryUseQuality,
    CreationCapabilityOrdinaryUseQuality, CreationCapabilityOrdinaryUseQuality]
  const estimate = (rate(t1) - rate(t0)) - (rate(c1) - rate(c0))
  // Price-Bonett: half a success and half a failure per cell, interval centered on the adjusted contrast.
  const adjusted = (cell: CreationCapabilityOrdinaryUseQuality) => (cell.achieved + 0.5) / (cell.samples + 1)
  const adjustedEstimate = (adjusted(t1) - adjusted(t0)) - (adjusted(c1) - adjusted(c0))
  const standardError = Math.sqrt(cells.reduce((sum, cell) => {
    const p = adjusted(cell)
    return sum + p * (1 - p) / (cell.samples + 1)
  }, 0))
  return { status: 'estimated', estimate, adjustedEstimate, standardError, interval95: {
    low: Math.max(-2, adjustedEstimate - 1.96 * standardError), high: Math.min(2, adjustedEstimate + 1.96 * standardError) } }
}

function parallelTrend(cells: readonly CreationCapabilityTrendCell[], threshold: number): CreationCapabilityTrendParallelCheck {
  const tested = cells.filter(cell => cell.index < 0 && cell.treated.status === 'measured' && cell.control.status === 'measured')
  if (tested.length < 2) return { status: 'untestable', testedWindows: tested.length }
  const gap = (cell: CreationCapabilityTrendCell) => rate(cell.treated) - rate(cell.control)
  const gapChange = gap(tested[tested.length - 1]!) - gap(tested[0]!)
  return { status: Math.abs(gapChange) > threshold ? 'parallel-trend-suspect' : 'not-flagged',
    testedWindows: tested.length, gapChange }
}

function boundedInteger(name: string, value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`created capability ordinary-use trend ${name} must be an integer in [${min}, ${max}]`)
  }
  return value
}

/**
 * Longitudinal ordinary-use series of one adoption in fixed windows around adoption, by frozen task model, with a
 * same-scope session-cohort control and a pooled difference-in-differences estimate. Every certified current owner
 * foreground task counts once by its latest revision (corrections replace, withdrawals retract). Read once, then
 * reread under an unchanged Evaluation scope watermark. Undefined for a missing receipt, an oversized scope, a changed
 * source, scope or fence, or a throw. Pure read; observational, never causal.
 */
export function inspectCreationCapabilityOrdinaryUseTrend(input: CreationCapabilityTrendInput):
CreationCapabilityOrdinaryUseTrend | undefined {
  const minimumSamples = boundedInteger('minimumSamples', input.minimumSamples ?? DEFAULT_MINIMUM_SAMPLES, 1, Number.MAX_SAFE_INTEGER)
  const maxScannedHeads = boundedInteger('maxScannedHeads', input.maxScannedHeads ?? DEFAULT_MAX_SCANNED_HEADS, 1, Number.MAX_SAFE_INTEGER)
  const windowMs = boundedInteger('windowMs', input.windowMs ?? TREND_DEFAULT_WINDOW_MS,
    TREND_WINDOW_MS_BOUNDS.min, TREND_WINDOW_MS_BOUNDS.max)
  const preWindows = boundedInteger('preWindows', input.preWindows ?? TREND_DEFAULT_PRE_WINDOWS, 2, TREND_WINDOW_COUNT_MAX)
  const maxPostWindows = boundedInteger('maxPostWindows', input.maxPostWindows ?? TREND_DEFAULT_MAX_POST_WINDOWS,
    1, TREND_WINDOW_COUNT_MAX)
  const threshold = input.parallelTrendThreshold ?? TREND_DEFAULT_PARALLEL_TREND_THRESHOLD
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new TypeError('created capability ordinary-use trend parallelTrendThreshold must be in (0, 1]')
  }
  const { record, owner, evaluation } = input
  const receipt = record.receipt
  if (!receipt || receipt.planId !== record.planId || input.triggerInboxId.length === 0) return undefined
  const now = input.now ?? Date.now()
  const receiptDigest = controlPlaneDigest(receipt)
  const observedUntil = Math.max(receipt.adoptedAt, Math.min(now, receipt.expiresAt))
  const postWindows = Math.min(maxPostWindows, Math.ceil((observedUntil - receipt.adoptedAt) / windowMs))
  const windows: CreationCapabilityTrendWindow[] = []
  for (let index = -preWindows; index < postWindows; index++) {
    const fullEnd = receipt.adoptedAt + (index + 1) * windowMs
    // After windows never extend past min(now, expiresAt); the latest one is clipped there and marked incomplete.
    windows.push({ index, startExclusive: fullEnd - windowMs,
      endInclusive: index < 0 ? fullEnd : Math.min(fullEnd, observedUntil), complete: index < 0 || fullEnd <= observedUntil })
  }
  const first = windows[0]!.startExclusive
  const last = Math.min(windows[windows.length - 1]!.endInclusive, observedUntil)
  // A dispatch exactly at adoption precedes it, matching the strict call admission rule. Dispatches after
  // min(now, expiresAt) are outside every window, so an expired adoption stops accruing after tasks.
  const windowOf = (at: number): number | undefined => at <= first || at > last ? undefined
    : Math.ceil((at - receipt.adoptedAt) / windowMs) - 1
  const grouped = eligibleCalls(input, receipt, receiptDigest, now)
  if (!grouped) return undefined
  const scope = evaluation.canonicalHostScope({ workspace: owner.workspace, preset: owner.agentPreset })
  const read = (heads: readonly TrustedTaskLearningProjectionReceipt[]) => {
    const original = input.readSourceCurrent()
    if (original.projection.subjectKind !== 'foreground-turn'
      || original.projection.subjectRef !== input.triggerInboxId || original.projection.disposition !== 'upsert') {
      throw new Error('created capability original task is no longer current')
    }
    const excluded: Excluded = { nonForeground: 0, trigger: 0, retracted: 0, unverified: 0, outsideWindow: 0 }
    const rows: TrendRow[] = []
    for (const head of heads) {
      const inboxId = head.projection.subjectRef
      if (head.projection.subjectKind !== 'foreground-turn') { excluded.nonForeground++; continue }
      if (inboxId === input.triggerInboxId) { excluded.trigger++; continue }
      if (head.projection.disposition !== 'upsert') { excluded.retracted++; continue }
      const source = certifiedTask(input, head, inboxId)
      const originalSource = source && originalTaskSource(input, source, inboxId)
      const dispatchedAt = (originalSource?.execution as { dispatchedAt?: number } | undefined)?.dispatchedAt
      if (!source || !originalSource || !Number.isSafeInteger(dispatchedAt)) { excluded.unverified++; continue }
      const index = windowOf(dispatchedAt!)
      if (index === undefined) { excluded.outsideWindow++; continue }
      const group = grouped.get(inboxId)
      const calls = index >= 0 && group && group.sessionId === originalSource.binding.sessionId
        ? group.calls.filter(call => sameBinding(call, originalSource.binding)).length : 0
      rows.push({ index, inboxId, sessionId: originalSource.binding.sessionId, model: taskModel(source.source),
        status: source.canonical.objective!.status as 'achieved' | 'not-achieved',
        projection: { version: head.projection.version, digest: head.projection.digest },
        outcomeId: head.triggerOutcomeId,
        sourceDigest: controlPlaneDigest({ protocol: source.protocol, source: source.source,
          judgement: source.judgement, ownerRevision: source.ownerRevision }), calls })
    }
    rows.sort((a, b) => a.inboxId < b.inboxId ? -1 : a.inboxId > b.inboxId ? 1 : 0)
    return { original, rows, excluded }
  }
  let result: { heads: TrustedTaskLearningProjectionReceipt[]; scopeWatermark: number; read: ReturnType<typeof read> }
  try {
    const scanned = scanScope(evaluation, scope, maxScannedHeads)
    const before = read(scanned.heads)
    const fenced = evaluation.withTrustedCanonicalScopeWriterFence({ scope, scopeWatermark: scanned.scopeWatermark }, () => {
      const during = read(scanned.heads)
      if (!same(during, before)) throw new Error('created capability ordinary-use trend source changed')
      return during
    })
    if (!fenced.matched) return undefined
    result = { ...scanned, read: fenced.value }
  } catch { return undefined }
  const { rows, excluded } = result.read
  const treatedSessions = new Set(rows.filter(row => row.calls > 0).map(row => row.sessionId))
  const controlSessions = new Set(rows.filter(row => !treatedSessions.has(row.sessionId)).map(row => row.sessionId))
  const buckets = new Map<string, { model: CreationCapabilityOrdinaryUseModel; rows: TrendRow[] }>()
  for (const row of rows) {
    const key = modelKey(row.model)
    const bucket = buckets.get(key)
    if (bucket) bucket.rows.push(row)
    else buckets.set(key, { model: row.model, rows: [row] })
  }
  const strata: CreationCapabilityTrendStratum[] = [...buckets].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([, bucket]) => {
      const treated = bucket.rows.filter(row => treatedSessions.has(row.sessionId))
      const control = bucket.rows.filter(row => !treatedSessions.has(row.sessionId))
      const cells = windows.map(({ index }): CreationCapabilityTrendCell => {
        const inWindow = bucket.rows.filter(row => row.index === index)
        return { index, treated: quality(treated.filter(row => row.index === index), minimumSamples),
          control: quality(control.filter(row => row.index === index), minimumSamples),
          calls: inWindow.reduce((sum, row) => sum + row.calls, 0),
          exposedTasks: inWindow.filter(row => row.calls > 0).length }
      })
      const pooled = (rows: readonly TrendRow[], after: boolean) =>
        quality(rows.filter(row => (row.index >= 0) === after), minimumSamples)
      return { model: bucket.model, cells,
        differenceInDifferences: differenceInDifferences([pooled(treated, false), pooled(treated, true),
          pooled(control, false), pooled(control, true)]),
        parallelTrend: parallelTrend(cells, threshold) }
    })
  const concurrent = (input.otherAdoptedAt ?? []).filter(at => Number.isFinite(at) && at > first && at <= last).length
  const flags: CreationCapabilityTrendFlag[] = []
  if (strata.some(stratum => stratum.parallelTrend.status === 'parallel-trend-suspect')) flags.push('parallel-trend-suspect')
  if (controlSessions.size === 0) flags.push('no-control-cohort')
  if (concurrent > 0) flags.push('concurrent-adoptions')
  if (windows.some(window => !window.complete)) flags.push('partial-window')
  if (record.status !== 'active') flags.push('adoption-not-active')
  return deepFreeze({ protocol: 'dsh-created-capability-ordinary-use-trend/v1', causal: false,
    design: 'session-cohort-difference-in-differences-model-stratified', planId: record.planId, receiptDigest,
    artifactSha256: receipt.artifactSha256, schemaDigest: receipt.schemaDigest, adoptionStatus: record.status,
    withinSignedUseWindow: now >= receipt.adoptedAt && now < receipt.expiresAt, minimumSamples, windowMs,
    parallelTrendThreshold: threshold, scopeWatermark: result.scopeWatermark,
    rowsDigest: controlPlaneDigest(rows.map(({ sessionId: _sessionId, ...row }) => row)), windows,
    population: { scanned: result.heads.length, counted: rows.length, excluded },
    cohorts: { treatedSessions: treatedSessions.size, controlSessions: controlSessions.size },
    concurrentAdoptions: { status: concurrent === 0 ? 'none' : 'flagged', count: concurrent },
    strata, flags, assumptions: [...TREND_ASSUMPTIONS], regressions: { status: 'unmeasured' }, cost: { status: 'unmeasured' } })
}

/**
 * P1-4 window statistics for one adopted artifact over its CURRENT certified
 * associations. Revisions the owner corrected are excluded and reported;
 * withdrawn revisions are absent from the current set by construction, so the
 * denominator is the visible current head set. Cost and latency stay zero
 * (unmeasured) when no trusted metrics exist — the benefit evaluator treats
 * that as insufficient rather than passing.
 */
export function inspectCreationCapabilityBenefitWindow(
  input: CreationCapabilityFeedbackInput & { minimumWindowRevisions?: number },
): import('@dsh-enhanced/assistant-growth-contract').RevisionBenefitWindowStats | undefined {
  const read = readAssociationRows(input, true)
  const receipt = input.record.receipt
  if (!read || !receipt) return undefined
  const rows = [...read.rows].sort((a, b) => a.association.inboxId < b.association.inboxId ? -1
    : a.association.inboxId > b.association.inboxId ? 1 : 0)
  const now = read.now
  const windowEnd = now
  const windowStart = now - Math.max(1, Math.min(86_400_000, Math.max(1, receipt.expiresAt - receipt.adoptedAt)))
  let correctedOrWithdrawn = 0, failed = 0, reworked = 0
  let latencyMsTotal = 0, tokensTotal = 0, inputTokensTotal = 0, outputTokensTotal = 0
  for (const row of rows) {
    if (row.ownerRevisionAction !== 'initial') { correctedOrWithdrawn += 1; continue }
    if (row.association.task.status === 'not-achieved') failed += 1
    if (row.association.callKeys.length > 1) reworked += 1
    latencyMsTotal += row.taskLatencyMs ?? 0
  }
  const stats: import('@dsh-enhanced/assistant-growth-contract').RevisionBenefitWindowStats = {
    protocol: 'assistant-growth/revision-benefit-window/v1', artifactSha256: receipt.artifactSha256,
    windowStart, windowEnd, taskRevisions: rows.length, correctedOrWithdrawn, failed, reworked,
    latencyMsTotal, tokensTotal, inputTokensTotal, outputTokensTotal,
  }
  try { validateWindowStatsShallow(stats) } catch { return undefined }
  return stats
}

function validateWindowStatsShallow(value: import('@dsh-enhanced/assistant-growth-contract').RevisionBenefitWindowStats): void {
  // Local guard so the feedback module does not import the evaluator: shape
  // and cross-field bounds only.
  const included = Math.max(0, value.taskRevisions - value.correctedOrWithdrawn)
  if (value.failed + value.reworked > included) throw new Error('benefit window counters exceed the included set')
  for (const field of ['windowStart', 'windowEnd', 'taskRevisions', 'correctedOrWithdrawn', 'failed', 'reworked',
    'latencyMsTotal', 'tokensTotal', 'inputTokensTotal', 'outputTokensTotal'] as const) {
    const item = value[field]
    if (!Number.isSafeInteger(item) || item < 0) throw new Error('benefit window counter invalid')
  }
  if (value.windowEnd <= value.windowStart) throw new Error('benefit window must be nonempty')
}
