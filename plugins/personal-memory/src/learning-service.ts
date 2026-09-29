import type { Context } from '@deepseek-ai/cordis'
import type { AssistantDeliveryService, OwnerForegroundTaskSourceContent } from '@dsh-enhanced/assistant-delivery'
import type { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import type { AssistantVerifierService } from '@dsh-enhanced/assistant-verifier'
import type { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import {
  growthObjectDigest, memoryLearningRequestDigest, validateMemoryLearningReviewRequest,
  type MemoryLearningOwner, type MemoryLearningReviewRequest,
} from '@dsh-enhanced/assistant-growth-contract'
import { memoryPrincipalDigest, type MemoryStore } from './store.js'
import type {
  MemoryAgentContext, MemoryLearningAdoptionGrant, MemoryLearningAdoptionResult,
  MemoryLearningManagedSource,
} from './types.js'
import { validateMemoryLearningAdoptionGrant } from './learning-adoptions.js'

interface SourceServices { delivery: AssistantDeliveryService; evaluation: AssistantEvaluationService }

/** Host-only adoption and read-time source checks. No model-visible mutation tool. */
export class MemoryLearningService {
  readonly #grant: MemoryLearningAdoptionGrant

  constructor(private readonly ctx: Context, private readonly store: MemoryStore, grant: MemoryLearningAdoptionGrant) {
    this.#grant = validateMemoryLearningAdoptionGrant(grant)
    store.registerLearningGrant(this.#grant)
  }

  #scope() {
    const owner = this.#grant.owner
    return { authorityId: owner.authorityId, principalId: owner.principalId, workspace: owner.workspace,
      agentPreset: owner.agentPreset, expectedOwner: { authorityHash: owner.authorityHash,
        principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion } }
  }

  #services(): SourceServices {
    const delivery = this.ctx.get('assistantDelivery') as AssistantDeliveryService | undefined
    const evaluation = this.ctx.get('assistantEvaluation') as AssistantEvaluationService | undefined
    if (!delivery || !evaluation || typeof delivery.withOwnerForegroundTaskSourcesFence !== 'function'
      || typeof delivery.inspectOwnerForegroundLearningTask !== 'function'
      || typeof evaluation.canonicalHostScope !== 'function' || typeof evaluation.getTrustedForegroundLearningProjection !== 'function'
      || typeof evaluation.inspectTrustedTaskOwnerRevision !== 'function' || typeof evaluation.listTrustedTaskLearningProjections !== 'function'
      || typeof evaluation.withTrustedCanonicalScopeWriterFence !== 'function') throw new Error('memory learning source services unavailable')
    return { delivery, evaluation }
  }

  #policy(request: MemoryLearningReviewRequest, consume = false): void {
    const policy = this.ctx.get('assistantPolicy') as AssistantPolicyService | undefined
    if (!policy) throw new Error('memory learning policy unavailable')
    const input = { subject: { kind: 'background' as const, id: 'assistant-memory-learning',
      workspace: request.owner.workspace, principal: request.owner.principalId }, action: 'adopt',
    resource: { kind: 'memory' as const, id: `learning:${this.#grant.authorityId}` }, context: { initiator: 'background' as const } }
    const decision = consume ? policy.authorize(input, { idempotencyKey: `memory-adopt:${this.#grant.authorityId}:${memoryLearningRequestDigest(request)}` })
      : policy.evaluate(input)
    if (decision.effect !== 'allow') throw new Error('memory learning adoption policy denied')
  }

  #request(input: MemoryLearningReviewRequest): MemoryLearningReviewRequest {
    const request = validateMemoryLearningReviewRequest(input)
    if (growthObjectDigest(request.owner) !== growthObjectDigest(this.#grant.owner)) throw new Error('memory learning owner changed')
    return request
  }

  #evaluationFence<T>(evaluation: AssistantEvaluationService, callback: () => T): T {
    const owner = this.#grant.owner
    const scope = evaluation.canonicalHostScope({ workspace: owner.workspace, preset: owner.agentPreset })
    const { scopeWatermark } = evaluation.listTrustedTaskLearningProjections({ scope, limit: 1 })
    const result = evaluation.withTrustedCanonicalScopeWriterFence({ scope, scopeWatermark }, callback)
    if (!result.matched) throw new Error('memory learning canonical scope changed')
    return result.value
  }

  #sourceState(request: MemoryLearningReviewRequest, content: Readonly<OwnerForegroundTaskSourceContent> | undefined,
    services: SourceServices): 'current' | 'withdrawn' | 'source-changed' {
    if (!content || content.sourceDigest !== request.source.sourceDigest || content.contentDigest !== request.source.contentDigest
      || content.input.truncated || content.reply.truncated || !content.source.execution.modelSelection) return 'source-changed'
    const { owner } = request
    const scope = services.evaluation.canonicalHostScope({ workspace: owner.workspace, preset: owner.agentPreset })
    const current = services.evaluation.getTrustedForegroundLearningProjection({ scope, inboxId: request.source.inboxId })
    const revision = current === undefined ? undefined : services.evaluation.inspectTrustedTaskOwnerRevision({
      scope, outcomeId: current.triggerOutcomeId, principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion,
    })
    if (revision?.action === 'withdraw') return 'withdrawn'
    if (request.source.canonical) {
      const expected = request.source.canonical
      const task = services.delivery.inspectOwnerForegroundLearningTask({ authorityId: owner.authorityId, principalId: owner.principalId,
        workspace: owner.workspace, agentPreset: owner.agentPreset, outcomeId: expected.outcomeId })
      if (!task || task.judgement === 'unresolved' || task.source.inboxId !== request.source.inboxId || !task.source.quiescent
        || task.ownerRevision?.action === 'withdraw' || task.canonical.projection.disposition !== 'upsert'
        || task.canonical.projection.version !== expected.version || task.canonical.projection.digest !== expected.digest
        || task.canonical.objective?.status !== expected.objectiveStatus
        || task.owner.principalRecordId !== owner.principalRecordId || task.owner.principalVersion !== owner.principalVersion
        || task.owner.authorityHash !== owner.authorityHash || task.feedback?.truncated) return 'source-changed'
    }
    return 'current'
  }

  /** Historical exact receipt for lost ACKs; not a claim that its record is still visible. */
  lookup(input: MemoryLearningReviewRequest): Readonly<MemoryLearningAdoptionResult> | undefined {
    const request = this.#request(input)
    const delivery = this.ctx.get('assistantDelivery') as AssistantDeliveryService | undefined
    if (!delivery || typeof delivery.withOwnerForegroundTaskSourcesFence !== 'function') throw new Error('memory learning owner service unavailable')
    return delivery.withOwnerForegroundTaskSourcesFence({ ...this.#scope(), sources: [] }, () => {
      this.#policy(request)
      return this.store.lookupLearningAdoption({ authorityId: this.#grant.authorityId,
        operationId: request.operationId, requestDigest: memoryLearningRequestDigest(request) })
    })
  }

  adopt(input: MemoryLearningReviewRequest): Readonly<MemoryLearningAdoptionResult> {
    const request = this.#request(input)
    const prior = this.lookup(request)
    if (prior) return prior
    if (Date.now() >= this.#grant.expiresAt) throw new Error('memory learning adoption grant expired')
    const verifier = this.ctx.get('assistantVerifier') as AssistantVerifierService | undefined
    if (!verifier || typeof verifier.lookupMemoryLearningReview !== 'function') throw new Error('memory learning independent reviewer unavailable')
    // Verifier lookup takes its own producer locks. Complete it before taking
    // Delivery → Evaluation → Memory below; no asynchronous gap is introduced.
    const reviewReceipt = verifier.lookupMemoryLearningReview(request)
    if (!reviewReceipt || reviewReceipt.status !== 'approved' || reviewReceipt.requestDigest !== memoryLearningRequestDigest(request)
      || reviewReceipt.operationId !== request.operationId || reviewReceipt.authorityId !== this.#grant.reviewAuthorityId
      || reviewReceipt.authorityDigest !== this.#grant.reviewAuthorityDigest) throw new Error('memory learning independent approval unavailable or changed')
    const services = this.#services()
    return services.delivery.withOwnerForegroundTaskSourcesFence({ ...this.#scope(),
      sources: [{ inboxId: request.source.inboxId, expectedSourceDigest: request.source.sourceDigest }] }, contents =>
      this.#evaluationFence(services.evaluation, () => {
        const content = contents[0]
        if (this.#sourceState(request, content, services) !== 'current') throw new Error('memory learning source changed or withdrawn')
        this.#policy(request, true)
        return this.store.applyLearningAdoption({ grant: this.#grant, request, reviewReceipt,
          sourceObservedAt: content!.source.execution.completedAt! })
      }))
  }

  inspectTarget(input: { owner: MemoryLearningOwner; id: string; expectedVersion: number }) {
    if (growthObjectDigest(input.owner) !== growthObjectDigest(this.#grant.owner)) return undefined
    return this.store.inspectLearningTarget(input)
  }

  #matchesContext(context: MemoryAgentContext): boolean {
    const owner = this.#grant.owner, namespace = context.namespace
    return context.workspace === owner.workspace && context.agentPreset === owner.agentPreset
      && namespace.mode === 'delivery' && namespace.principalRecordId === owner.principalRecordId
      && namespace.principalVersion === owner.principalVersion && namespace.principalDigest === memoryPrincipalDigest(owner.principalId)
  }

  /** Sources stay locked through Memory's read snapshot, ranking and framing. */
  withVisible<T>(context: MemoryAgentContext, callback: () => T): T {
    if (!this.#matchesContext(context)) return callback()
    // This query has no held Memory transaction. Newly appearing/changed
    // managed versions are excluded by the final exact-reference filter.
    const managed = this.store.listManagedLearningSources(context)
      .filter(source => growthObjectDigest(source.request.owner) === growthObjectDigest(this.#grant.owner))
    if (managed.length === 0 || managed.length > 1000) return callback()
    let callbackStarted = false
    try {
      const services = this.#services()
      const sources = [...new Map(managed.map(item => [item.request.source.inboxId,
        { inboxId: item.request.source.inboxId, expectedSourceDigest: item.request.source.sourceDigest }])).values()]
      return services.delivery.withOwnerForegroundTaskSourcesFence({ ...this.#scope(), sources }, contents =>
        this.#evaluationFence(services.evaluation, () => {
          const byInbox = new Map(sources.map((source, index) => [source.inboxId, contents[index]]))
          const checked = managed.map(item => ({ item, state: this.#sourceState(item.request, byInbox.get(item.request.source.inboxId), services) }))
          const visible: MemoryLearningManagedSource[] = []
          for (const { item, state } of checked) {
            if (state === 'current') visible.push(item)
            // A missing/changed source or canonical projection can be temporarily
            // unreadable. Only an explicit owner withdrawal warrants deletion.
            else if (state === 'withdrawn') this.store.invalidateManagedLearningSource({ owner: item.request.owner, id: item.id, version: item.version,
              recordDigest: item.recordDigest, sourceDigest: item.sourceDigest, reason: state })
          }
          callbackStarted = true
          return this.store.withLearningVisibility(visible, callback)
        }))
    } catch (error) {
      if (callbackStarted) throw error
      // Temporary provider absence/errors hide automatic records, without
      // manufacturing a durable withdrawal or suppressing manual memory.
      return callback()
    }
  }
}
