import type { AssistantDeliveryService, OwnerForegroundLearningTask } from '@dsh-enhanced/assistant-delivery'
import type { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import { controlPlaneDigest, type ControlPlaneStore } from './store.js'
import type { OwnerTaskFailureReference } from './owner-task-gap-types.js'
import type { SourceJobCaller } from './source-jobs.js'
import type { SourceJobOwnerReceipt } from './source-job-types.js'

type Ports = {
  delivery: Pick<AssistantDeliveryService, 'inspectOwnerForegroundLearningTask'>
  evaluation: Pick<AssistantEvaluationService, 'canonicalHostScope' | 'withTrustedCanonicalTaskWriterFence'>
}

/** Host-only bridge. A caller's source is an expectation, never evidence. */
export class OwnerTaskFailureGaps {
  constructor(private readonly store: ControlPlaneStore, private readonly ports: () => Ports) {}

  private reference(source: OwnerForegroundLearningTask): OwnerTaskFailureReference {
    const projection = source.canonical.projection
    if (source.protocol !== 'assistant-delivery/owner-foreground-learning/v1'
      || !['independent-verifier', 'owner-feedback'].includes(source.judgement)
      || source.canonical.objective?.status !== 'not-achieved'
      || projection.subjectKind !== 'foreground-turn' || projection.disposition !== 'upsert'
      || source.source.inboxId !== projection.subjectRef || source.source.truncated || !source.source.quiescent
      || source.ownerRevision?.action === 'withdraw') throw new Error('task repair requires a current trusted foreground failure')
    return { schemaVersion: 1, owner: source.owner, outcomeId: source.canonical.triggerOutcomeId,
      projection: { ...projection, subjectKind: 'foreground-turn', disposition: 'upsert' },
      sourceDigest: controlPlaneDigest({ protocol: source.protocol, source: source.source,
        judgement: source.judgement, ownerRevision: source.ownerRevision }) }
  }

  private read(reference: OwnerTaskFailureReference, ports: Ports): OwnerForegroundLearningTask {
    const owner = reference.owner
    const current = ports.delivery.inspectOwnerForegroundLearningTask({ authorityId: owner.authorityId,
      principalId: owner.principalId, workspace: owner.workspace, agentPreset: owner.agentPreset, outcomeId: reference.outcomeId })
    if (!current || controlPlaneDigest(this.reference(current)) !== controlPlaneDigest(reference)) {
      throw new Error('task repair source or owner changed')
    }
    return current
  }

  private fence<T>(reference: OwnerTaskFailureReference, callback: () => T): T {
    const ports = this.ports()
    const current = this.read(reference, ports)
    const scope = ports.evaluation.canonicalHostScope({ workspace: current.owner.workspace, preset: current.owner.agentPreset })
    const fenced = ports.evaluation.withTrustedCanonicalTaskWriterFence({ scope,
      scopeWatermark: current.canonical.scopeWatermark, evidence: [current.canonical.projection] }, () => {
      // Keep the owner and source reread inside Evaluation's synchronous writer
      // fence, including after a long build or a durable-job restart.
      this.read(reference, ports)
      return callback()
    })
    if (!fenced.matched) throw new Error('task repair canonical writer fence changed')
    return fenced.value
  }

  record(source: OwnerForegroundLearningTask) {
    const reference = this.reference(source)
    return this.fence(reference, () => this.store.recordOwnerTaskFailureGap(reference))
  }

  /** Private Host snapshot; objective and actual model never enter the public gap. */
  snapshot(gapId: string, owner: SourceJobOwnerReceipt): OwnerForegroundLearningTask {
    const reference = this.store.getOwnerTaskFailureReference(gapId)
    if (!reference) throw new Error('task repair source unavailable')
    return this.withCurrent(gapId, owner, () => structuredClone(this.read(reference, this.ports())))
  }

  withCurrent<T>(gapId: string, owner: SourceJobCaller | SourceJobOwnerReceipt | undefined, callback: () => T): T {
    const reference = this.store.getOwnerTaskFailureReference(gapId)
    if (!reference) return callback()
    const expected = reference.owner
    if (!owner || ('receiptVersion' in owner
      ? controlPlaneDigest(owner) !== controlPlaneDigest(expected)
      : owner.ownerRouteId !== expected.authorityId || owner.principalId !== expected.principalId
        || owner.principalRecordId !== expected.principalRecordId || owner.principalVersion !== expected.principalVersion
        || owner.workspace !== expected.workspace || owner.preset !== expected.agentPreset)) {
      throw new Error('task repair gap does not belong to the caller')
    }
    return this.fence(reference, () => this.store.withOwnerTaskFailureGapAdmission(gapId, callback))
  }
}
