import type { Context } from '@deepseek-ai/cordis'
import type { AssistantDeliveryService, OwnerForegroundTaskSourceContent, OwnerWorkItemLearningTask, OwnerWorkItemLearningTaskFenceInput } from '@dsh-enhanced/assistant-delivery'
import type { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import type { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import {
  memoryLearningRequestDigest, validateMemoryLearningOwner, validateMemoryLearningReviewRequest, hasWorkItemLearningFeedbackText,
  type MemoryLearningOwner, type MemoryLearningReviewRequest, type ForegroundMemoryLearningReviewRequest, type WorkItemMemoryLearningReviewRequest,
} from '@dsh-enhanced/assistant-growth-contract'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { SourceReviewStore } from './source-review-store.js'
import type { SourceReviewModelSelection } from './source-review.js'
import type { MemoryReviewSourceText, ForegroundMemoryReviewSourceText, MemoryReviewTarget } from './memory-review-native.js'

export interface MemoryReviewConfig {
  authorityId: string
  owner: MemoryLearningOwner
  expiresAt: number
  maxReviews: number
  policy: string
  maxInputBytes: number
  maxOutputTokens: number
  timeoutMs: number
  model?: SourceReviewModelSelection
  workItemExperiences?: boolean
}

export interface MemoryReviewReceipt {
  protocol: 'memory-learning-review-receipt/v1'
  operationId: string
  requestDigest: string
  authorityId: string
  authorityDigest: string
  sessionId: string
  model: SourceReviewModelSelection
  status: 'approved' | 'rejected' | 'unknown'
  reason: string
  outputDigest?: string
  receiptDigest: string
}

export interface MemoryReviewAvailability {
  readonly authorityId: string
  readonly authorityDigest: string
  readonly expiresAt: number
  readonly remainingReviews: number
  readonly available: boolean
  readonly workItemExperiences?: true
}

/** Structural Host-only reader prevents a reverse package dependency on Memory. */
interface TargetReader {
  inspectLearningTarget(input: { owner: MemoryLearningOwner; id: string; expectedVersion: number }): MemoryReviewTarget | undefined
}

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))
    || required.some(key => !Object.hasOwn(value, key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(field => !field.enumerable || !('value' in field))) {
    throw new Error('memory review invalid configuration fields')
  }
  return value as Record<string, unknown>
}
function id(value: unknown): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value)) throw new Error('memory review invalid identity')
}
function bound(value: unknown, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error('memory review invalid bound')
}

export function validateMemoryReviewConfig(input: MemoryReviewConfig): MemoryReviewConfig {
  exact(input, ['authorityId', 'owner', 'expiresAt', 'maxReviews', 'policy', 'maxInputBytes', 'maxOutputTokens', 'timeoutMs'], ['model', 'workItemExperiences'])
  if (Object.hasOwn(input, 'workItemExperiences') && typeof input.workItemExperiences !== 'boolean') throw new Error('memory review invalid workItemExperiences')
  id(input.authorityId); validateMemoryLearningOwner(input.owner)
  bound(input.expiresAt, 1, Number.MAX_SAFE_INTEGER); bound(input.maxReviews, 1, 10_000)
  bound(input.maxInputBytes, 4096, 131_072); bound(input.maxOutputTokens, 1, 8192); bound(input.timeoutMs, 1000, 300_000)
  if (typeof input.policy !== 'string' || !input.policy.trim() || input.policy.includes('\0')
    || !input.policy.isWellFormed() || Buffer.byteLength(input.policy) > 8192) throw new Error('memory review invalid policy')
  if (Object.hasOwn(input, 'model')) {
    const model = exact(input.model, ['provider', 'model'], ['reasoningEffort'])
    id(model.provider)
    if (typeof model.model !== 'string' || !model.model.trim() || model.model.includes('\0')
      || !model.model.isWellFormed() || Buffer.byteLength(model.model) > 256) throw new Error('memory review invalid model')
    if (Object.hasOwn(model, 'reasoningEffort')) id(model.reasoningEffort)
  }
  const normalized = structuredClone(input)
  if (normalized.workItemExperiences !== true) delete normalized.workItemExperiences
  return normalized
}

/** Review authority is separately configured; callers cannot provide decisions or source text. */
export class MemoryReviewRuntime {
  readonly #config: MemoryReviewConfig
  readonly #store: SourceReviewStore
  readonly #controller = new AbortController()
  readonly #flights = new Set<Promise<MemoryReviewReceipt>>()
  #closing: Promise<void> | undefined

  constructor(private readonly ctx: Context, config: MemoryReviewConfig, databasePath: string) {
    this.#config = validateMemoryReviewConfig(config)
    this.#store = new SourceReviewStore(databasePath + '.memory-reviews')
  }

  inspectAvailability(input: { owner: MemoryLearningOwner }): MemoryReviewAvailability {
    const authorityDigest = acceptanceDigest(this.#config)
    let workItemExperiences = false
    const unavailable = (): MemoryReviewAvailability => Object.freeze({ authorityId: this.#config.authorityId,
      authorityDigest, expiresAt: this.#config.expiresAt, remainingReviews: 0, available: false,
      ...(workItemExperiences ? { workItemExperiences: true as const } : {}) })
    this.#controller.signal.throwIfAborted()
    const owner = validateMemoryLearningOwner(input.owner)
    if (acceptanceDigest(owner) !== acceptanceDigest(this.#config.owner) || Date.now() >= this.#config.expiresAt) return unavailable()
    try {
      const delivery = this.ctx.get('assistantDelivery') as AssistantDeliveryService | undefined
      const evaluation = this.ctx.get('assistantEvaluation') as AssistantEvaluationService | undefined
      const policy = this.ctx.get('assistantPolicy') as AssistantPolicyService | undefined
      if (typeof delivery?.validateOwnerRoute !== 'function' || typeof evaluation?.canonicalHostScope !== 'function'
        || typeof policy?.evaluate !== 'function') return unavailable()
      workItemExperiences = this.#config.workItemExperiences === true
        && typeof delivery.inspectOwnerWorkItemLearningTask === 'function'
        && typeof delivery.withOwnerWorkItemLearningTaskFence === 'function'
      const current = delivery.validateOwnerRoute({ authorityId: owner.authorityId, principalId: owner.principalId,
        workspace: owner.workspace, agentPreset: owner.agentPreset })
      if (['authorityId', 'authorityHash', 'principalId', 'principalRecordId', 'principalVersion', 'workspace', 'agentPreset']
        .some(key => current[key as keyof typeof current] !== owner[key as keyof MemoryLearningOwner])) return unavailable()
      evaluation.canonicalHostScope({ workspace: owner.workspace, preset: owner.agentPreset })
      const decision = policy.evaluate({ subject: { kind: 'background', id: 'assistant-memory-learning',
        workspace: owner.workspace, principal: owner.principalId }, action: 'review',
      resource: { kind: 'memory', id: `learning:${this.#config.authorityId}` }, context: { initiator: 'background' } })
      if (decision.effect !== 'allow') return unavailable()
      const remainingReviews = this.#store.remaining({ authorityId: this.#config.authorityId,
        authorityDigest, maxReviews: this.#config.maxReviews })
      return Object.freeze({ authorityId: this.#config.authorityId, authorityDigest,
        expiresAt: this.#config.expiresAt, remainingReviews, available: remainingReviews > 0,
        ...(workItemExperiences ? { workItemExperiences: true as const } : {}) })
    } catch { return unavailable() }
  }

  #policy(request: MemoryLearningReviewRequest, consume: boolean): void {
    const service = this.ctx.get('assistantPolicy') as AssistantPolicyService | undefined
    if (!service) throw new Error('memory review policy unavailable')
    const input = { subject: { kind: 'background' as const, id: 'assistant-memory-learning',
      workspace: request.owner.workspace, principal: request.owner.principalId }, action: 'review',
    resource: { kind: 'memory' as const, id: `learning:${this.#config.authorityId}` }, context: { initiator: 'background' as const } }
    const decision = consume ? service.authorize(input, { idempotencyKey: `memory-review:${memoryLearningRequestDigest(request)}` })
      : service.evaluate(input)
    if (decision.effect !== 'allow') throw new Error('memory review policy denied')
  }

  #sourceInput(request: ForegroundMemoryLearningReviewRequest) {
    const { owner } = request
    return { authorityId: owner.authorityId, principalId: owner.principalId, workspace: owner.workspace,
      agentPreset: owner.agentPreset, expectedOwner: { authorityHash: owner.authorityHash,
        principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion },
      inboxId: request.source.inboxId, expectedSourceDigest: request.source.sourceDigest }
  }

  #sourceServices() {
    const delivery = this.ctx.get('assistantDelivery') as AssistantDeliveryService | undefined
    const evaluation = this.ctx.get('assistantEvaluation') as AssistantEvaluationService | undefined
    if (!delivery || !evaluation || typeof delivery.readOwnerForegroundTaskSource !== 'function'
      || typeof delivery.withOwnerForegroundTaskSourceFence !== 'function' || typeof delivery.inspectOwnerForegroundLearningTask !== 'function'
      || typeof evaluation.canonicalHostScope !== 'function' || typeof evaluation.getTrustedForegroundLearningProjection !== 'function'
      || typeof evaluation.inspectTrustedTaskOwnerRevision !== 'function' || typeof evaluation.listTrustedTaskLearningProjections !== 'function'
      || typeof evaluation.withTrustedCanonicalScopeWriterFence !== 'function') throw new Error('memory review source services unavailable')
    return { delivery, evaluation }
  }

  #currentForeground(request: ForegroundMemoryLearningReviewRequest, includeTarget: boolean, fencedContent?: Readonly<OwnerForegroundTaskSourceContent>): {
    source: MemoryReviewSourceText; model: SourceReviewModelSelection; target?: MemoryReviewTarget
  } {
    this.#controller.signal.throwIfAborted()
    if (Date.now() >= this.#config.expiresAt || acceptanceDigest(request.owner) !== acceptanceDigest(this.#config.owner)) {
      throw new Error('memory review grant expired or owner changed')
    }
    this.#policy(request, false)
    const { delivery, evaluation } = this.#sourceServices()
    const { owner } = request
    const content = fencedContent ?? delivery.readOwnerForegroundTaskSource(this.#sourceInput(request))
    if (!content || content.contentDigest !== request.source.contentDigest
      || content.input.truncated || content.reply.truncated || !content.source.execution.modelSelection) {
      throw new Error('memory review original source unavailable or incomplete')
    }
    const source: ForegroundMemoryReviewSourceText = { ownerStatement: content.input.text, assistantReply: content.reply.text }
    const scope = evaluation.canonicalHostScope({ workspace: owner.workspace, preset: owner.agentPreset })
    const current = evaluation.getTrustedForegroundLearningProjection({ scope, inboxId: request.source.inboxId })
    // A missing objective is normal for owner statements. Only an explicit
    // authenticated withdrawal invalidates a fact; retract alone is not one.
    const ownerRevision = current === undefined ? undefined : evaluation.inspectTrustedTaskOwnerRevision({
      scope, outcomeId: current.triggerOutcomeId, principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion,
    })
    if (ownerRevision?.action === 'withdraw') throw new Error('memory review source withdrawn')
    if (request.source.canonical) {
      const expected = request.source.canonical
      const task = delivery.inspectOwnerForegroundLearningTask({ authorityId: owner.authorityId, principalId: owner.principalId,
        workspace: owner.workspace, agentPreset: owner.agentPreset, outcomeId: expected.outcomeId })
      if (!task || task.judgement === 'unresolved' || task.source.inboxId !== request.source.inboxId || !task.source.quiescent
        || task.ownerRevision?.action === 'withdraw' || task.canonical.projection.disposition !== 'upsert'
        || task.canonical.projection.version !== expected.version || task.canonical.projection.digest !== expected.digest
        || task.canonical.objective?.status !== expected.objectiveStatus
        || task.owner.principalRecordId !== owner.principalRecordId || task.owner.principalVersion !== owner.principalVersion
        || task.owner.authorityHash !== owner.authorityHash || task.feedback?.truncated) throw new Error('memory review task outcome changed')
      source.objectiveStatus = expected.objectiveStatus
      if (task.feedback) source.ownerFeedback = task.feedback.text
    }
    const quoteSources = request.mutation.op !== 'remove' && request.mutation.entry.kind === 'experience'
      ? [source.ownerStatement, source.assistantReply, source.ownerFeedback ?? ''] : [source.ownerStatement]
    if (!quoteSources.some(text => text.includes(request.evidenceQuote))) throw new Error('memory review quotation absent from source')
    let target: MemoryReviewTarget | undefined
    if (includeTarget && request.mutation.op !== 'add') {
      const memory = this.ctx.get('personalMemory' as never, false) as unknown as TargetReader | undefined
      target = memory?.inspectLearningTarget({ owner, id: request.mutation.id, expectedVersion: request.mutation.expectedVersion })
      if (!target || target.managed !== true || target.id !== request.mutation.id || target.version !== request.mutation.expectedVersion) {
        throw new Error('memory review target is not the exact managed version')
      }
    }
    return { source, model: structuredClone(this.#config.model ?? content.source.execution.modelSelection),
      ...(target === undefined ? {} : { target }) }
  }

  #assertGrant(request: MemoryLearningReviewRequest): void {
    this.#controller.signal.throwIfAborted()
    if (Date.now() >= this.#config.expiresAt || acceptanceDigest(request.owner) !== acceptanceDigest(this.#config.owner)) {
      throw new Error('memory review grant expired or owner changed')
    }
    if (request.protocol === 'memory-learning-review/v2' && this.#config.workItemExperiences !== true) {
      throw new Error('memory review work-item experiences are not authorized')
    }
  }

  #workItemSource(request: WorkItemMemoryLearningReviewRequest, task: Readonly<OwnerWorkItemLearningTask> | undefined): {
    source: MemoryReviewSourceText; model: SourceReviewModelSelection
  } {
    this.#assertGrant(request)
    const expected = request.source.canonical, owner = request.owner
    if (!task || task.protocol !== 'assistant-delivery/owner-work-item-learning/v1'
      || task.judgement !== 'owner-feedback' || task.sourceDigest !== request.source.sourceDigest
      || task.presentationDigest !== request.source.contentDigest
      || task.proofIdentity.itemId !== request.source.itemId
      || task.proofIdentity.production.quiescent !== true || task.proofIdentity.production.budgetSettlementState !== 'finalized'
      || !['succeeded', 'failed', 'timed-out', 'cancelled'].includes(task.proofIdentity.production.executionStatus)
      || ['authorityId', 'authorityHash', 'principalId', 'principalRecordId', 'principalVersion', 'workspace', 'agentPreset']
        .some(key => task.owner[key as keyof typeof task.owner] !== owner[key as keyof MemoryLearningOwner])
      || task.canonical.projection.subjectKind !== 'work-item' || task.canonical.projection.subjectRef !== request.source.itemId
      || task.canonical.projection.disposition !== 'upsert' || task.canonical.projection.version !== expected.version
      || task.canonical.projection.digest !== expected.digest || task.canonical.objective?.outcomeId !== expected.outcomeId
      || task.canonical.objective.status !== expected.objectiveStatus
      || Object.values(task.presentation).some(text => text.truncated)) {
      throw new Error('memory review work-item source or outcome changed')
    }
    if (request.mutation.op !== 'remove' && request.mutation.entry.kind !== 'experience') {
      throw new Error('memory review work-item experience only')
    }
    if (!hasWorkItemLearningFeedbackText(task.presentation.feedback.text)) throw new Error('memory review owner feedback has no visible evidence')
    if (!task.presentation.feedback.text.includes(request.evidenceQuote)) throw new Error('memory review quotation absent from owner feedback')
    if (!hasWorkItemLearningFeedbackText(request.evidenceQuote)) {
      throw new Error('memory review quotation has no visible owner evidence')
    }
    const supplier = this.#config.model ?? task.proofIdentity.supplier
    if (!supplier?.provider || !supplier.model) throw new Error('memory review work-item supplier unavailable')
    return { source: { protocol: 'memory-learning-source/work-item/v1', taskBrief: task.presentation.brief.text,
      workerReport: task.presentation.report.text, ownerFeedback: task.presentation.feedback.text, objectiveStatus: expected.objectiveStatus,
      presentationFlags: { taskBrief: { truncated: task.presentation.brief.truncated, redacted: task.presentation.brief.redacted },
        workerReport: { truncated: task.presentation.report.truncated, redacted: task.presentation.report.redacted },
        ownerFeedback: { truncated: task.presentation.feedback.truncated, redacted: task.presentation.feedback.redacted } } },
    model: structuredClone(supplier) }
  }

  #current(request: MemoryLearningReviewRequest, includeTarget: boolean, fencedTask?: Readonly<OwnerWorkItemLearningTask>): {
    source: MemoryReviewSourceText; model: SourceReviewModelSelection; target?: MemoryReviewTarget
  } {
    if (request.protocol === 'memory-learning-review/v1') return this.#currentForeground(request, includeTarget)
    this.#assertGrant(request)
    this.#policy(request, false)
    const delivery = this.ctx.get('assistantDelivery') as AssistantDeliveryService | undefined
    if (typeof delivery?.inspectOwnerWorkItemLearningTask !== 'function') throw new Error('memory review work-item source services unavailable')
    const owner = request.owner
    const current = this.#workItemSource(request, fencedTask ?? delivery.inspectOwnerWorkItemLearningTask({ authorityId: owner.authorityId,
      principalId: owner.principalId, workspace: owner.workspace, agentPreset: owner.agentPreset, outcomeId: request.source.canonical.outcomeId }))
    let target: MemoryReviewTarget | undefined
    if (request.mutation.op !== 'add') {
      const memory = this.ctx.get('personalMemory' as never, false) as unknown as TargetReader | undefined
      target = memory?.inspectLearningTarget({ owner, id: request.mutation.id, expectedVersion: request.mutation.expectedVersion })
      if (!target || target.managed !== true || target.kind !== 'experience'
        || target.id !== request.mutation.id || target.version !== request.mutation.expectedVersion) {
        throw new Error('memory review target is not the exact managed experience version')
      }
    }
    this.#assertGrant(request)
    return { ...current, ...(target === undefined ? {} : { target: structuredClone(target) }) }
  }

  /** No await or nested Delivery reader: locks are held in producer-to-consumer order. */
  #withCurrentFence<T>(request: MemoryLearningReviewRequest, fingerprint: string, includeTarget: boolean, callback: () => T): T {
    if (request.protocol === 'memory-learning-review/v2') {
      const delivery = this.ctx.get('assistantDelivery') as AssistantDeliveryService | undefined
      if (typeof delivery?.withOwnerWorkItemLearningTaskFence !== 'function') throw new Error('memory review work-item fence unavailable')
      const { owner } = request, canonical = request.source.canonical
      const input: OwnerWorkItemLearningTaskFenceInput = { authorityId: owner.authorityId, principalId: owner.principalId,
        workspace: owner.workspace, agentPreset: owner.agentPreset, expectedOwner: { authorityHash: owner.authorityHash,
          principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion },
        itemId: request.source.itemId, outcomeId: canonical.outcomeId, expectedSourceDigest: request.source.sourceDigest,
        expectedContentDigest: request.source.contentDigest,
        canonical: { version: canonical.version, digest: canonical.digest, objectiveStatus: canonical.objectiveStatus } }
      // Delivery already owns both source locks. Core Policy and exact Memory target reads
      // are synchronous/local; never reopen Delivery/Evaluation or call a producer here.
      return delivery.withOwnerWorkItemLearningTaskFence(input, task => {
        if (acceptanceDigest(this.#current(request, includeTarget, task)) !== fingerprint) throw new Error('memory review source or target changed')
        this.#assertGrant(request)
        return callback()
      })
    }
    const { delivery, evaluation } = this.#sourceServices()
    return delivery.withOwnerForegroundTaskSourceFence(this.#sourceInput(request), content => {
      const scope = evaluation.canonicalHostScope({ workspace: request.owner.workspace, preset: request.owner.agentPreset })
      const { scopeWatermark } = evaluation.listTrustedTaskLearningProjections({ scope, limit: 1 })
      const result = evaluation.withTrustedCanonicalScopeWriterFence({ scope, scopeWatermark }, () => {
        if (acceptanceDigest(this.#currentForeground(request, includeTarget, content)) !== fingerprint) throw new Error('memory review source or target changed')
        return callback()
      })
      if (!result.matched) throw new Error('memory review canonical scope changed')
      return result.value
    })
  }

  #binding(request: MemoryLearningReviewRequest, model: SourceReviewModelSelection) {
    return { operationId: request.operationId, requestDigest: memoryLearningRequestDigest(request),
      authorityId: this.#config.authorityId, authorityDigest: acceptanceDigest(this.#config), maxReviews: this.#config.maxReviews, model }
  }

  #receipt(request: MemoryLearningReviewRequest, model: SourceReviewModelSelection,
    status: MemoryReviewReceipt['status'], result?: { reason: string; outputDigest: string }): MemoryReviewReceipt {
    const binding = this.#binding(request, model)
    const body = { protocol: 'memory-learning-review-receipt/v1' as const, operationId: request.operationId,
      requestDigest: binding.requestDigest, authorityId: binding.authorityId, authorityDigest: binding.authorityDigest,
      sessionId: `memory-review-${acceptanceDigest(request).slice(0, 40)}`, model, status,
      reason: result?.reason ?? 'The admitted review has no durable terminal result; inspect its session before reconciliation.',
      ...(result === undefined ? {} : { outputDigest: result.outputDigest }) }
    return { ...body, receiptDigest: acceptanceDigest(body) }
  }

  lookup(input: MemoryLearningReviewRequest): MemoryReviewReceipt | undefined {
    const request = validateMemoryLearningReviewRequest(input)
    const initial = this.#current(request, false), { model } = initial
    const receipt = this.#withCurrentFence(request, acceptanceDigest(initial), false,
      () => this.#store.inspect(this.#binding(request, model)))
    return receipt === undefined ? undefined : this.#receipt(request, model,
      receipt.state === 'claimed' ? 'unknown' : receipt.state, receipt.result)
  }

  run(input: MemoryLearningReviewRequest, externalSignal?: AbortSignal): Promise<MemoryReviewReceipt> {
    this.#controller.signal.throwIfAborted()
    const flight = this.#run(validateMemoryLearningReviewRequest(input), externalSignal)
    this.#flights.add(flight)
    void flight.finally(() => this.#flights.delete(flight)).catch(() => {})
    return flight
  }

  async #run(request: MemoryLearningReviewRequest, externalSignal?: AbortSignal): Promise<MemoryReviewReceipt> {
    const signal = AbortSignal.any([this.#controller.signal, AbortSignal.timeout(this.#config.timeoutMs), ...(externalSignal ? [externalSignal] : [])])
    signal.throwIfAborted()
    const initial = this.#current(request, true)
    const fingerprint = acceptanceDigest(initial)
    const assertCurrent = () => {
      signal.throwIfAborted()
      if (acceptanceDigest(this.#current(request, true)) !== fingerprint) throw new Error('memory review source or target changed')
    }
    const binding = this.#binding(request, initial.model)
    const claim = this.#withCurrentFence(request, fingerprint, true, () => {
      signal.throwIfAborted()
      const old = this.#store.inspect(binding)
      if (old) return old
      this.#policy(request, true)
      signal.throwIfAborted(); this.#assertGrant(request)
      return this.#store.claim(binding)
    })
    if (claim.state !== 'claimed') return this.#receipt(request, initial.model, claim.state, claim.result)
    try {
      const { runNativeMemoryReview } = await import('./memory-review-native.js')
      const result = await runNativeMemoryReview(this.ctx, { config: this.#config, request, ...initial, signal, assertCurrent })
      this.#withCurrentFence(request, fingerprint, true, () => {
        signal.throwIfAborted()
        this.#store.finish(request.operationId, binding.requestDigest, result)
      })
      return this.#receipt(request, initial.model, result.status, result)
    } catch {
      return this.#receipt(request, initial.model, 'unknown')
    }
  }

  close(): Promise<void> {
    return this.#closing ??= (async () => {
      this.#controller.abort(new Error('memory reviewer disposed'))
      await Promise.allSettled(this.#flights)
      this.#store.close()
    })()
  }
}
