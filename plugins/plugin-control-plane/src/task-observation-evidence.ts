import type { AssistantDeliveryService, OwnerForegroundLearningTask } from '@dsh-enhanced/assistant-delivery'
import type { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import { controlPlaneDigest } from './store.js'
import type { ForegroundDeploymentRecord } from './foreground-deployment.js'
import type { TaskObservationOwner, TaskObservationVote } from './task-observation-types.js'

type Evaluation = Pick<AssistantEvaluationService, 'canonicalHostScope' | 'getTrustedForegroundLearningProjection'
  | 'withTrustedCanonicalTaskWriterFence'>
type Delivery = Pick<AssistantDeliveryService, 'inspectOwnerForegroundLearningTask'>

const same = (a: unknown, b: unknown): boolean => controlPlaneDigest(a) === controlPlaneDigest(b)

export function taskObservationOwner(owner: TaskObservationOwner): TaskObservationOwner {
  const { authorityId, authorityHash, principalId, principalRecordId, principalVersion, workspace, agentPreset } = owner
  return { authorityId, authorityHash, principalId, principalRecordId, principalVersion, workspace, agentPreset }
}

/** A current canonical result and exact Delivery owner source are both required. */
export function trustedForegroundSource(input: {
  owner: TaskObservationOwner; inboxId: string; evaluation: Evaluation; delivery: Delivery
}): OwnerForegroundLearningTask | undefined {
  const { owner, inboxId, evaluation, delivery } = input
  const scope = evaluation.canonicalHostScope({ workspace: owner.workspace, preset: owner.agentPreset })
  const canonical = evaluation.getTrustedForegroundLearningProjection({ scope, inboxId })
  if (!canonical) return undefined
  const source = delivery.inspectOwnerForegroundLearningTask({ authorityId: owner.authorityId,
    principalId: owner.principalId, workspace: owner.workspace, agentPreset: owner.agentPreset,
    outcomeId: canonical.triggerOutcomeId })
  if (!source || !same(taskObservationOwner(source.owner), owner)
    || !same(source.canonical.projection, canonical.projection) || source.source.inboxId !== inboxId) return undefined
  return source
}

/** Shared vote predicates; a runtime may impose a tighter window after this check. */
export function trustedForegroundVote(input: {
  deployment: ForegroundDeploymentRecord; source: OwnerForegroundLearningTask | undefined
  now: number; lookbackMs: number
}): TaskObservationVote | undefined {
  const { deployment, source, now, lookbackMs } = input
  const status = source?.canonical.objective?.status
  if (!source || !['owner-feedback', 'independent-verifier'].includes(source.judgement)
    || (status !== 'achieved' && status !== 'not-achieved') || source.ownerRevision?.action === 'withdraw'
    || source.canonical.projection.subjectKind !== 'foreground-turn' || source.canonical.projection.disposition !== 'upsert'
    || source.canonical.projection.subjectRef !== deployment.task.inboxId || !source.source.quiescent || source.source.truncated
    || source.source.sessionId !== deployment.task.sessionId || deployment.state !== 'observed' || !deployment.execution
    || source.owner.principalRecordId !== deployment.task.owner.principalRecordId
    || source.owner.principalVersion !== deployment.task.owner.principalVersion
    || source.owner.workspace !== deployment.task.scope.workspace || source.owner.agentPreset !== deployment.task.scope.preset
    || deployment.execution.completedAt > now || now - deployment.execution.completedAt > lookbackMs
    || (source.canonical.objective?.occurredAt ?? now + 1) > now) return undefined
  return { inboxId: deployment.task.inboxId, outcomeId: source.canonical.triggerOutcomeId,
    projection: { ...source.canonical.projection },
    sourceDigest: controlPlaneDigest({ protocol: source.protocol, source: source.source,
      judgement: source.judgement, ownerRevision: source.ownerRevision }),
    deploymentDigest: controlPlaneDigest(deployment), status, completedAt: deployment.execution.completedAt }
}

/** Re-read source evidence under Evaluation's canonical writer fence. */
export function withTrustedForegroundVoteFence<T>(input: {
  evaluation: Evaluation; owner: TaskObservationOwner; votes: readonly TaskObservationVote[]
  read(): readonly OwnerForegroundLearningTask[]; callback(): T
  additionalSource?(): OwnerForegroundLearningTask
}): T {
  const sources = input.read()
  if (sources.length === 0 || sources.length !== input.votes.length) throw new Error('task observation source set changed')
  const extra = input.additionalSource?.()
  const scope = input.evaluation.canonicalHostScope({ workspace: input.owner.workspace, preset: input.owner.agentPreset })
  const result = input.evaluation.withTrustedCanonicalTaskWriterFence({ scope,
    scopeWatermark: Math.max(...sources.map(source => source.canonical.scopeWatermark), extra?.canonical.scopeWatermark ?? 0),
    evidence: [...input.votes.map(vote => vote.projection), ...(extra ? [extra.canonical.projection] : [])] }, () => {
    input.read()
    if (extra && !same(input.additionalSource?.(), extra)) throw new Error('task observation additional source changed')
    return input.callback()
  })
  if (!result.matched) throw new Error('task observation canonical writer fence changed')
  return result.value
}
