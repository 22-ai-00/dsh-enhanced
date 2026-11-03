import type { Context } from '@deepseek-ai/cordis'
import type { AssistantDeliveryService, OwnerForegroundTaskSourceContent, OwnerLearningSourceExpectation, OwnerLearningSourceSnapshot } from '@dsh-enhanced/assistant-delivery'
import type { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import type { AssistantVerifierService } from '@dsh-enhanced/assistant-verifier'
import type { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import {
  growthObjectDigest, memoryLearningRequestDigest, validateMemoryLearningReviewRequest, hasWorkItemLearningFeedbackText,
  validateMemoryLearningOwner,
  type MemoryLearningOwner, type MemoryLearningReviewRequest, type ForegroundMemoryLearningReviewRequest,
} from '@dsh-enhanced/assistant-growth-contract'
import { memoryPrincipalDigest, type MemoryStore } from './store.js'
import type {
  MemoryAgentContext, MemoryLearningAdoptionGrant, MemoryLearningAdoptionResult,
  MemoryLearningManagedSource, MemoryLearningTargetSummary, MemoryLearningAdoptionAvailability,
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

  #policy(request?: MemoryLearningReviewRequest, consume = false): void {
    const policy = this.ctx.get('assistantPolicy') as AssistantPolicyService | undefined
    if (!policy) throw new Error('memory learning policy unavailable')
    const owner = request?.owner ?? this.#grant.owner
    const input = { subject: { kind: 'background' as const, id: 'assistant-memory-learning',
      workspace: owner.workspace, principal: owner.principalId }, action: 'adopt',
    resource: { kind: 'memory' as const, id: `learning:${this.#grant.authorityId}` }, context: { initiator: 'background' as const } }
    const decision = consume && request ? policy.authorize(input, { idempotencyKey: `memory-adopt:${this.#grant.authorityId}:${memoryLearningRequestDigest(request)}` })
      : policy.evaluate(input)
    if (decision.effect !== 'allow') throw new Error('memory learning adoption policy denied')
  }

  #request(input: MemoryLearningReviewRequest): MemoryLearningReviewRequest {
    const request = validateMemoryLearningReviewRequest(input)
    if (growthObjectDigest(request.owner) !== growthObjectDigest(this.#grant.owner)) throw new Error('memory learning owner changed')
    if (request.protocol === 'memory-learning-review/v2' && this.#grant.workItemExperiences !== true) throw new Error('work item experience adoption is not authorized')
    return request
  }

  #owner(input: MemoryLearningOwner): MemoryLearningOwner {
    const owner = validateMemoryLearningOwner(input)
    if (growthObjectDigest(owner) !== growthObjectDigest(this.#grant.owner)) throw new Error('memory learning owner changed')
    return owner
  }

  #evaluationFence<T>(evaluation: AssistantEvaluationService, callback: () => T): T {
    const owner = this.#grant.owner
    const scope = evaluation.canonicalHostScope({ workspace: owner.workspace, preset: owner.agentPreset })
    const { scopeWatermark } = evaluation.listTrustedTaskLearningProjections({ scope, limit: 1 })
    const result = evaluation.withTrustedCanonicalScopeWriterFence({ scope, scopeWatermark }, callback)
    if (!result.matched) throw new Error('memory learning canonical scope changed')
    return result.value
  }

  #sourceState(request: ForegroundMemoryLearningReviewRequest, content: Readonly<OwnerForegroundTaskSourceContent> | undefined,
    services: SourceServices | undefined, snapshot?: Extract<OwnerLearningSourceSnapshot, { kind: 'foreground' }>): 'current' | 'withdrawn' | 'source-changed' {
    if (!content || content.sourceDigest !== request.source.sourceDigest || content.contentDigest !== request.source.contentDigest
      || content.input.truncated || content.reply.truncated || !content.source.execution.modelSelection) return 'source-changed'
    const { owner } = request
    const scope = services?.evaluation.canonicalHostScope({ workspace: owner.workspace, preset: owner.agentPreset })
    const current = snapshot ? snapshot.currentCanonical : services!.evaluation.getTrustedForegroundLearningProjection({ scope: scope!, inboxId: request.source.inboxId })
    const revision = snapshot ? snapshot.ownerRevision : current === undefined ? undefined : services!.evaluation.inspectTrustedTaskOwnerRevision({
      scope: scope!, outcomeId: current.triggerOutcomeId, principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion,
    })
    if (revision?.action === 'withdraw') return 'withdrawn'
    if (request.source.canonical) {
      const expected = request.source.canonical
      const task = snapshot ? snapshot.task : services!.delivery.inspectOwnerForegroundLearningTask({ authorityId: owner.authorityId, principalId: owner.principalId,
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

  #sourceKey(request: MemoryLearningReviewRequest): string {
    return request.protocol === 'memory-learning-review/v1' ? `foreground:${request.source.inboxId}` : `work-item:${request.source.itemId}`
  }

  #expectation(request: MemoryLearningReviewRequest): OwnerLearningSourceExpectation {
    return request.protocol === 'memory-learning-review/v1'
      ? { kind: 'foreground', inboxId: request.source.inboxId, expectedSourceDigest: request.source.sourceDigest }
      : { kind: 'work-item', itemId: request.source.itemId, outcomeId: request.source.canonical.outcomeId,
          expectedSourceDigest: request.source.sourceDigest, expectedContentDigest: request.source.contentDigest,
          canonical: { version: request.source.canonical.version, digest: request.source.canonical.digest,
            objectiveStatus: request.source.canonical.objectiveStatus } }
  }

  /** One typed batch; the mixed callback must never re-enter a producer. */
  #withSources<T>(requests: readonly MemoryLearningReviewRequest[], callback: (snapshots: ReadonlyMap<string, OwnerLearningSourceSnapshot>, legacy?: SourceServices) => T): T {
    const selected = new Map<string, MemoryLearningReviewRequest>()
    for (const request of requests) {
      const key = this.#sourceKey(request), previous = selected.get(key)
      if (!previous || request.protocol === 'memory-learning-review/v2' && previous.protocol === 'memory-learning-review/v2'
        && request.source.canonical.version > previous.source.canonical.version) selected.set(key, request)
    }
    const entries = [...selected.entries()], sources = entries.map(([, request]) => this.#expectation(request))
    if (requests.some(request => request.protocol === 'memory-learning-review/v2')) {
      const delivery = this.ctx.get('assistantDelivery') as AssistantDeliveryService | undefined
      if (typeof delivery?.withOwnerLearningSourcesFence !== 'function') throw new Error('mixed memory learning source fence unavailable')
      return delivery.withOwnerLearningSourcesFence({ ...this.#scope(), sources }, snapshots => {
        if (snapshots.length !== sources.length) throw new Error('memory learning source batch misaligned')
        const byKey = new Map<string, OwnerLearningSourceSnapshot>()
        for (const [index, snapshot] of snapshots.entries()) {
          const expected = sources[index]!
          if (snapshot.kind !== expected.kind || (snapshot.kind === 'foreground' ? snapshot.inboxId : snapshot.itemId)
            !== (expected.kind === 'foreground' ? expected.inboxId : expected.itemId)) throw new Error('memory learning source identity changed')
          byKey.set(entries[index]![0], snapshot)
        }
        return callback(byKey)
      })
    }
    const services = this.#services()
    return services.delivery.withOwnerForegroundTaskSourcesFence({ ...this.#scope(), sources: sources.map(source => {
      if (source.kind !== 'foreground') throw new Error('legacy memory source changed')
      return { inboxId: source.inboxId, expectedSourceDigest: source.expectedSourceDigest }
    }) }, contents => this.#evaluationFence(services.evaluation, () => callback(new Map(entries.map(([key, request], index) => {
      if (request.protocol !== 'memory-learning-review/v1') throw new Error('legacy memory source changed')
      return [key, { kind: 'foreground' as const, inboxId: request.source.inboxId, content: contents[index] }]
    })), services)))
  }

  #state(request: MemoryLearningReviewRequest, snapshot: OwnerLearningSourceSnapshot | undefined, legacy?: SourceServices): 'current' | 'withdrawn' | 'source-changed' {
    if (request.protocol === 'memory-learning-review/v1') {
      if (snapshot?.kind !== 'foreground' || snapshot.inboxId !== request.source.inboxId) return 'source-changed'
      return this.#sourceState(request, snapshot.content, legacy, legacy ? undefined : snapshot)
    }
    if (this.#grant.workItemExperiences !== true || snapshot?.kind !== 'work-item' || snapshot.itemId !== request.source.itemId) return 'source-changed'
    const task = snapshot.task, expected = request.source.canonical
    // Only an authenticated explicit withdrawal, never a missing source or a
    // generic canonical retract, can permanently invalidate managed memory.
    if (snapshot.ownerRevision?.action === 'withdraw'
      && snapshot.currentCanonical?.projection.subjectKind === 'work-item'
      && snapshot.currentCanonical.projection.subjectRef === request.source.itemId
      && snapshot.currentCanonical.objective?.outcomeId === snapshot.ownerRevision.outcomeId
      && snapshot.currentCanonical.objective.status === 'unknown') return 'withdrawn'
    if (!task || task.sourceDigest !== request.source.sourceDigest || task.presentationDigest !== request.source.contentDigest
      || task.proofIdentity.itemId !== request.source.itemId || task.judgement !== 'owner-feedback'
      || task.presentation.feedback.truncated || task.presentation.brief.truncated || task.presentation.report.truncated
      || task.canonical.projection.subjectKind !== 'work-item' || task.canonical.projection.subjectRef !== request.source.itemId
      || task.canonical.projection.disposition !== 'upsert' || task.canonical.projection.version !== expected.version
      || task.canonical.projection.digest !== expected.digest || task.canonical.objective?.outcomeId !== expected.outcomeId
      || task.canonical.objective.status !== expected.objectiveStatus
      || !snapshot.currentCanonical || growthObjectDigest(snapshot.currentCanonical) !== growthObjectDigest(task.canonical)
      || ['authorityId', 'authorityHash', 'principalId', 'principalRecordId', 'principalVersion', 'workspace', 'agentPreset']
        .some(key => task.owner[key as keyof typeof task.owner] !== request.owner[key as keyof MemoryLearningOwner])
      || task.proofIdentity.production.quiescent !== true || task.proofIdentity.production.budgetSettlementState !== 'finalized'
      || !Number.isSafeInteger(task.proofIdentity.production.completedAt) || task.proofIdentity.production.completedAt < 0) return 'source-changed'
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
    return this.#withSources([request], (snapshots, legacy) => {
      const snapshot = snapshots.get(this.#sourceKey(request))
      if (this.#state(request, snapshot, legacy) !== 'current') throw new Error('memory learning source changed or withdrawn')
      let sourceObservedAt: number
      if (request.protocol === 'memory-learning-review/v2') {
        if (snapshot?.kind !== 'work-item' || !snapshot.task) throw new Error('work item source unavailable')
        if (!snapshot.task.presentation.feedback.text.includes(request.evidenceQuote)
          || !hasWorkItemLearningFeedbackText(request.evidenceQuote)) {
          throw new Error('work item quotation is not substantive visible owner feedback')
        }
        if (request.mutation.op !== 'add') {
          const target = this.store.inspectLearningTarget({ owner: request.owner, id: request.mutation.id, expectedVersion: request.mutation.expectedVersion })
          if (target?.kind !== 'experience') throw new Error('work item learning target must be an exact managed experience')
        }
        sourceObservedAt = snapshot.task.proofIdentity.production.completedAt
      } else {
        if (snapshot?.kind !== 'foreground' || !snapshot.content) throw new Error('foreground source unavailable')
        sourceObservedAt = snapshot.content.source.execution.completedAt!
      }
      this.#policy(request, true)
      return this.store.applyLearningAdoption({ grant: this.#grant, request, reviewReceipt, sourceObservedAt })
    })
  }

  inspectTarget(input: { owner: MemoryLearningOwner; id: string; expectedVersion: number }) {
    if (growthObjectDigest(input.owner) !== growthObjectDigest(this.#grant.owner)) return undefined
    return this.store.inspectLearningTarget(input)
  }

  /** Host-only bounded candidates, after current owner, Policy and source checks. */
  listTargets(input: { owner: MemoryLearningOwner; limit?: number }): readonly MemoryLearningTargetSummary[] {
    const owner = this.#owner(input.owner)
    const limit = input.limit ?? 20
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('memory learning target limit is invalid')
    this.#policy()
    const context: MemoryAgentContext = { workspace: owner.workspace, agentPreset: owner.agentPreset,
      namespace: { mode: 'delivery', principalDigest: memoryPrincipalDigest(owner.principalId),
        principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion } }
    const managed = this.store.listManagedLearningSources(context)
      .filter(item => growthObjectDigest(item.request.owner) === growthObjectDigest(owner))
    if (managed.length > 1000) return Object.freeze([])
    try {
      return this.#withSources(managed.map(item => item.request), (snapshots, legacy) => {
        this.#policy()
        if (!this.store.inspectLearningAdoptionAvailability(this.#grant).available) return Object.freeze([])
        const targets = managed.flatMap(item => {
          if (this.#state(item.request, snapshots.get(this.#sourceKey(item.request)), legacy) !== 'current') return []
          const target = this.store.inspectLearningTarget({ owner, id: item.id, expectedVersion: item.version })
          return target === undefined ? [] : [{ id: target.id, version: target.version, kind: target.kind, content: target.content,
            ...(target.knowledge === undefined ? {} : { knowledge: target.knowledge }) }]
        })
        targets.sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version)
        return Object.freeze(targets.slice(0, limit))
      })
    } catch { return Object.freeze([]) }
  }

  /** Host-only budget view; no grant registration or Policy quota consumption. */
  inspectAvailability(input: { owner: MemoryLearningOwner }): MemoryLearningAdoptionAvailability {
    this.#owner(input.owner)
    const delivery = this.ctx.get('assistantDelivery') as AssistantDeliveryService | undefined
    if (!delivery || typeof delivery.withOwnerForegroundTaskSourcesFence !== 'function') throw new Error('memory learning owner service unavailable')
    return delivery.withOwnerForegroundTaskSourcesFence({ ...this.#scope(), sources: [] }, () => {
      this.#policy()
      const availability = this.store.inspectLearningAdoptionAvailability(this.#grant)
      if (availability.workItemExperiences === true && typeof delivery.withOwnerLearningSourcesFence !== 'function') {
        const { workItemExperiences: _unsupported, ...legacy } = availability
        return Object.freeze(legacy)
      }
      return availability
    })
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
      return this.#withSources(managed.map(item => item.request), (snapshots, legacy) => {
        const visible: MemoryLearningManagedSource[] = []
        for (const item of managed) {
          const state = this.#state(item.request, snapshots.get(this.#sourceKey(item.request)), legacy)
          if (state === 'current') visible.push(item)
          else if (state === 'withdrawn') this.store.invalidateManagedLearningSource({ owner: item.request.owner, id: item.id, version: item.version,
            recordDigest: item.recordDigest, sourceDigest: item.sourceDigest, reason: state })
        }
        callbackStarted = true
        return this.store.withLearningVisibility(visible, callback)
      })
    } catch (error) {
      if (callbackStarted) throw error
      // Temporary provider absence/errors hide automatic records, without
      // manufacturing a durable withdrawal or suppressing manual memory.
      return callback()
    }
  }
}
