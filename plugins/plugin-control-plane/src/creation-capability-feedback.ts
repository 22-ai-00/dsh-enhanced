import type { AssistantDeliveryService, OwnerForegroundLearningTask } from '@dsh-enhanced/assistant-delivery'
import type { AssistantEvaluationService, EvaluationCanonicalLearningEvidenceTuple } from '@dsh-enhanced/assistant-evaluation'
import { controlPlaneDigest } from './store.js'
import type { CreationCapabilityCallEvidence, CreationCapabilityOwner, CreationCapabilityRecord,
  CreationCapabilityTaskAssociation } from './creation-capability-types.js'

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

/** No cache: every result is checked against the current canonical writer and owner route. */
export function inspectCreationCapabilityTaskAssociations(input: CreationCapabilityFeedbackInput): readonly CreationCapabilityTaskAssociation[] {
  const { record, calls, owner, delivery, evaluation } = input
  const receipt = record.receipt
  if (!receipt || receipt.planId !== record.planId || input.triggerInboxId.length === 0) return []
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
    if (prior && prior.sessionId !== proof.task.sessionId) return []
    if (prior) prior.calls.push(call)
    else grouped.set(proof.task.inboxId, { sessionId: proof.task.sessionId, calls: [call] })
  }
  if (grouped.size === 0) return []
  const scope = evaluation.canonicalHostScope({ workspace: owner.workspace, preset: owner.agentPreset })
  const read = (): { original: ReturnType<CreationCapabilityFeedbackInput['readSourceCurrent']>;
    items: CreationCapabilityTaskAssociation[]; evidence: EvaluationCanonicalLearningEvidenceTuple[]; watermark: number } => {
    const original = input.readSourceCurrent()
    if (original.projection.subjectKind !== 'foreground-turn'
      || original.projection.subjectRef !== input.triggerInboxId || original.projection.disposition !== 'upsert') {
      throw new Error('created capability original task is no longer current')
    }
    const evidence: EvaluationCanonicalLearningEvidenceTuple[] = [original.projection]
    const items: CreationCapabilityTaskAssociation[] = []
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
      items.push({ protocol: 'dsh-created-capability-task-association/v1', planId: record.planId,
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
            judgement: source.judgement, ownerRevision: source.ownerRevision }) } })
    }
    return { original, items, evidence, watermark }
  }
  try {
    const before = read()
    const result = evaluation.withTrustedCanonicalTaskWriterFence({ scope,
      scopeWatermark: before.watermark, evidence: before.evidence }, () => {
      const during = read()
      if (!same(during, before)) throw new Error('created capability task association source changed')
      return during.items
    })
    return result.matched ? Object.freeze(result.value.map(item => Object.freeze({ ...item,
      callKeys: Object.freeze([...item.callKeys]),
      task: Object.freeze({ ...item.task, projection: Object.freeze({ ...item.task.projection }) }),
    }))) : []
  } catch { return [] }
}
