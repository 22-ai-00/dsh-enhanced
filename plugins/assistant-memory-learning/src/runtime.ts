import type { AssistantAutomationsService, HostAutomationDefinition, HostAutomationExecutorInput, HostAutomationExecutorResult } from '@dsh-enhanced/assistant-automations'
import type { AssistantDeliveryService, OwnerForegroundTaskSource, OwnerForegroundTaskSourceContent, OwnerForegroundTaskSourceCursor, OwnerForegroundTaskSourceScope } from '@dsh-enhanced/assistant-delivery'
import type { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import type { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import type { MemoryReviewReceipt } from '@dsh-enhanced/assistant-verifier'
import { growthObjectDigest, memoryLearningRequestDigest, validateMemoryLearningReviewRequest, type MemoryLearningProposal, type MemoryLearningReviewRequest } from '@dsh-enhanced/assistant-growth-contract'
import { validateLearningConfig, validateLearningModel } from './config.js'
import { LearningStore } from './store.js'
import type { LearningConfig, LearningJob, LearningSnapshot } from './types.js'

const OWNER = 'assistant-memory-learning'
const EXECUTOR = 'assistant-memory-learning-v1'
const CATALOG = growthObjectDigest({ executor: EXECUTOR, contract: 1 })
type Delivery = Pick<AssistantDeliveryService, 'validateOwnerRoute' | 'listOwnerForegroundTaskSources' | 'withOwnerForegroundTaskSourcesFence' | 'inspectOwnerForegroundLearningTask'> & {
  inspectOwnerForegroundTaskSource(input: OwnerForegroundTaskSourceScope & { inboxId: string }): Readonly<OwnerForegroundTaskSource> | undefined
}
type Evaluation = Pick<AssistantEvaluationService, 'canonicalHostScope' | 'listTrustedTaskLearningProjections' | 'withTrustedCanonicalScopeWriterFence' | 'getTrustedForegroundLearningProjection' | 'inspectTrustedTaskOwnerRevision'>
type Automations = Pick<AssistantAutomationsService, 'registerHostExecutor' | 'reconcileSystem' | 'inspectSystemOwnedActivation' | 'inspectSystemOwned'>
type Target = LearningSnapshot['targets'][number]
interface Memory {
  listLearningTargets(input: { owner: LearningConfig['owner']; limit?: number }): readonly Target[]
  inspectLearningAdoptionAvailability(input: { owner: LearningConfig['owner'] }): Readonly<{ authorityId: string; grantDigest: string; expiresAt: number; remainingMutations: number; remainingContentBytes: number; available: boolean }>
  lookupLearningAdoption(input: { request: MemoryLearningReviewRequest }): Readonly<{ receiptDigest: string }> | undefined
  adoptReviewedLearning(input: { request: MemoryLearningReviewRequest }): Readonly<{ receiptDigest: string }>
}
interface Verifier {
  inspectMemoryLearningReviewAvailability(input: { owner: LearningConfig['owner'] }): Readonly<{ authorityId: string; authorityDigest: string; expiresAt: number; remainingReviews: number; available: boolean }> | undefined
  reviewMemoryLearning(request: MemoryLearningReviewRequest, signal?: AbortSignal): Promise<MemoryReviewReceipt>
  lookupMemoryLearningReview(request: MemoryLearningReviewRequest): Readonly<MemoryReviewReceipt> | undefined
}
export interface LearningPorts {
  delivery: Delivery
  evaluation: Evaluation
  automations: Automations
  memory: Memory
  verifier: Verifier
  policy: Pick<AssistantPolicyService, 'evaluate' | 'authorize'>
  extract(input: { config: LearningConfig; job: LearningJob; signal: AbortSignal; assertCurrent(): void }): Promise<{
    proposal: MemoryLearningProposal | null; reason: string; sessionId: string; outputDigest: string
  }>
}
class SourcePending extends Error {}
class SourceObsolete extends Error {}
const same = (a: unknown, b: unknown): boolean => growthObjectDigest(a) === growthObjectDigest(b)
const reasonText = (value: unknown): string => Array.from(String(value).normalize('NFC').replaceAll('\0', '').trim())
  .slice(0, 120).join('') || 'learning-incomplete'

/** Two durable source cursors. Native Automations owns every timer and dispatch. */
export class MemoryLearningRuntime {
  private readonly config: LearningConfig
  private readonly store: LearningStore
  private readonly configDigest: string
  private readonly lane: string
  private readonly scanId: string
  private readonly abort = new AbortController()
  private readonly flights = new Set<Promise<unknown>>()
  private unregister: (() => void) | undefined
  private active = false
  private scanning = false
  private lastError: string | null = null
  private lastScanAt: number | null = null
  private closing: Promise<void> | undefined

  constructor(config: LearningConfig, private readonly ports: LearningPorts) {
    this.config = validateLearningConfig(config)
    this.configDigest = growthObjectDigest(this.config)
    this.lane = growthObjectDigest([this.config.authorityId, this.config.owner])
    this.scanId = `memory-scan-${this.lane}`
    for (const [port, methods] of [
      [ports.delivery, ['validateOwnerRoute', 'listOwnerForegroundTaskSources', 'inspectOwnerForegroundTaskSource', 'withOwnerForegroundTaskSourcesFence', 'inspectOwnerForegroundLearningTask']],
      [ports.evaluation, ['canonicalHostScope', 'listTrustedTaskLearningProjections', 'withTrustedCanonicalScopeWriterFence', 'getTrustedForegroundLearningProjection', 'inspectTrustedTaskOwnerRevision']],
      [ports.automations, ['registerHostExecutor', 'reconcileSystem', 'inspectSystemOwnedActivation', 'inspectSystemOwned']],
      [ports.memory, ['listLearningTargets', 'inspectLearningAdoptionAvailability', 'lookupLearningAdoption', 'adoptReviewedLearning']],
      [ports.verifier, ['inspectMemoryLearningReviewAvailability', 'reviewMemoryLearning', 'lookupMemoryLearningReview']],
      [ports.policy, ['evaluate', 'authorize']],
    ] as const) for (const method of methods) if (typeof (port as unknown as Record<string, unknown>)[method] !== 'function') throw new Error(`memory learning requires compatible Host API: ${method}`)
    this.store = new LearningStore(this.config.databasePath, { authorityId: this.config.authorityId,
      configDigest: this.configDigest, maxExtractions: this.config.maxExtractions })
  }
  health = () => ({ enabled: true, connected: this.active, lastScanAt: this.lastScanAt,
    lastError: this.lastError, counts: this.store.counts(this.lane), ...this.store.availability() })

  start(): void {
    if (this.active || this.closing) throw new Error('memory learning runtime cannot be started twice')
    try {
      this.store.interrupt(this.lane)
      this.unregister = this.ports.automations.registerHostExecutor({
        descriptor: { executorId: EXECUTOR, contractVersion: 1, catalogDigest: CATALOG },
        accepts: spec => spec.executorId === EXECUTOR && spec.executorContractVersion === 1 && spec.catalogDigest === CATALOG
          && spec.runbookVersion === 1 && ['scan', 'learn'].includes(spec.runbookId),
        execute: input => {
          const flight = this.execute(input)
          this.flights.add(flight)
          void flight.finally(() => this.flights.delete(flight)).catch(() => {})
          return flight
        },
      })
      this.active = true
      this.owner()
      this.ports.automations.reconcileSystem({ owner: OWNER, automationId: this.scanId,
        idempotencyKey: `${this.scanId}:${this.configDigest}`, desiredStatus: 'active', definition: this.definition() })
      // One bounded activation reconciliation; subsequent scans are native jobs.
      this.scan()
    } catch (error) {
      this.active = false; this.unregister?.(); this.abort.abort(error); this.store.close(); throw error
    }
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.active = false; this.unregister?.()
      this.abort.abort(new Error('memory learning provider disposed'))
      this.store.interrupt(this.lane)
      const deadline = AbortSignal.timeout(5000)
      let release!: () => void
      const expired = new Promise<boolean>(resolve => {
        const timeout = () => resolve(false)
        deadline.addEventListener('abort', timeout, { once: true })
        release = () => deadline.removeEventListener('abort', timeout)
      })
      try {
        const drained = await Promise.race([Promise.allSettled(this.flights).then(() => true), expired])
        if (!drained) throw new Error('memory learning shutdown timed out; pending dispatches remain unknown')
      } finally { release(); this.store.close() }
    })()
  }
  private scope(): OwnerForegroundTaskSourceScope {
    const owner = this.config.owner
    return { authorityId: owner.authorityId, principalId: owner.principalId, workspace: owner.workspace,
      agentPreset: owner.agentPreset, expectedOwner: { authorityHash: owner.authorityHash,
        principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion } }
  }
  private owner(): void {
    if (!this.active) throw new Error('memory learning unavailable')
    const current = this.ports.delivery.validateOwnerRoute(this.scope())
    for (const key of Object.keys(this.config.owner) as (keyof LearningConfig['owner'])[]) {
      if (current[key] !== this.config.owner[key]) throw new Error('memory learning owner authority changed')
    }
  }
  private policy(consume = false, idempotencyKey?: string): void {
    const owner = this.config.owner
    const input = { subject: { kind: 'background' as const, id: OWNER, workspace: owner.workspace, principal: owner.principalId },
      action: 'extract', resource: { kind: 'memory' as const, id: `learning:${this.config.authorityId}` }, context: { initiator: 'background' as const } }
    const decision = consume ? this.ports.policy.authorize(input, idempotencyKey === undefined ? {} : { idempotencyKey }) : this.ports.policy.evaluate(input)
    if (decision.effect !== 'allow') throw new Error('memory learning extraction policy denied')
  }
  private available(): boolean {
    this.owner(); this.policy()
    const review = this.ports.verifier.inspectMemoryLearningReviewAvailability({ owner: this.config.owner })
    const memory = this.ports.memory.inspectLearningAdoptionAvailability({ owner: this.config.owner })
    return Date.now() < this.config.expiresAt && this.store.availability().available && review?.available === true
      && review.authorityId === this.config.reviewAuthorityId && review.authorityDigest === this.config.reviewAuthorityDigest
      && memory.available && memory.authorityId === this.config.adoptionAuthorityId && memory.grantDigest === this.config.adoptionGrantDigest
  }
  private evaluationFence<T>(callback: () => T): T {
    const owner = this.config.owner
    const scope = this.ports.evaluation.canonicalHostScope({ workspace: owner.workspace, preset: owner.agentPreset })
    const { scopeWatermark } = this.ports.evaluation.listTrustedTaskLearningProjections({ scope, limit: 1 })
    const result = this.ports.evaluation.withTrustedCanonicalScopeWriterFence({ scope, scopeWatermark }, callback)
    if (!result.matched) throw new SourcePending('canonical scope changed during read')
    return result.value
  }
  private withSource<T>(job: LearningJob, callback: (content: Readonly<OwnerForegroundTaskSourceContent>, feedback?: string) => T): T {
    this.abort.signal.throwIfAborted(); this.owner(); this.policy()
    if (job.intent.configDigest !== this.configDigest || !same(job.intent.owner, this.config.owner)
      || Date.now() >= Math.min(job.intent.expiresAt, this.config.expiresAt)) throw new SourceObsolete('learning authority or source window expired')
    const metadata = this.ports.delivery.inspectOwnerForegroundTaskSource({ ...this.scope(), inboxId: job.intent.inboxId })
    if (!metadata) throw new SourcePending('completed source unavailable')
    if (job.intent.expectedSourceDigest && metadata.sourceDigest !== job.intent.expectedSourceDigest
      || job.snapshot && metadata.sourceDigest !== job.snapshot.source.sourceDigest
      || metadata.execution.status !== 'succeeded' || !metadata.execution.quiescent
      || metadata.execution.modelSelectionState !== 'frozen' || !metadata.execution.modelSelection) throw new SourceObsolete('source completion or model changed')
    return this.ports.delivery.withOwnerForegroundTaskSourcesFence({ ...this.scope(),
      sources: [{ inboxId: metadata.inboxId, expectedSourceDigest: metadata.sourceDigest }] }, contents =>
      this.evaluationFence(() => {
        const owner = this.config.owner
        const scope = this.ports.evaluation.canonicalHostScope({ workspace: owner.workspace, preset: owner.agentPreset })
        const canonical = this.ports.evaluation.getTrustedForegroundLearningProjection({ scope, inboxId: job.intent.inboxId })
        const revision = canonical && this.ports.evaluation.inspectTrustedTaskOwnerRevision({ scope, outcomeId: canonical.triggerOutcomeId,
          principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion })
        if (revision?.action === 'withdraw') throw new SourceObsolete('owner withdrew learning source')
        const content = contents[0]
        if (!content) throw new SourcePending('original reply not yet readable')
        if (content.input.truncated || content.reply.truncated) throw new SourceObsolete('learning source exceeds text boundary')
        let feedback: string | undefined
        if (job.intent.canonical) {
          const expected = job.intent.canonical
          if (!canonical || canonical.projection.disposition !== 'upsert' || canonical.projection.version !== expected.version
            || canonical.projection.digest !== expected.digest || canonical.objective?.status !== expected.objectiveStatus) throw new SourceObsolete('canonical result changed')
          const task = this.ports.delivery.inspectOwnerForegroundLearningTask({ authorityId: owner.authorityId, principalId: owner.principalId,
            workspace: owner.workspace, agentPreset: owner.agentPreset, outcomeId: expected.outcomeId })
          if (!task || task.judgement === 'unresolved' || !task.source.quiescent || task.source.truncated || task.feedback?.truncated) throw new SourcePending('canonical owner source not yet readable')
          if (task.source.inboxId !== job.intent.inboxId || task.ownerRevision?.action === 'withdraw'
            || task.canonical.projection.version !== expected.version || task.canonical.projection.digest !== expected.digest
            || task.canonical.objective?.status !== expected.objectiveStatus
            || task.owner.authorityHash !== owner.authorityHash || task.owner.principalRecordId !== owner.principalRecordId
            || task.owner.principalVersion !== owner.principalVersion) throw new SourceObsolete('canonical source owner changed')
          feedback = task.feedback?.text
        }
        if (job.snapshot && (content.contentDigest !== job.snapshot.source.contentDigest
          || content.input.text !== job.snapshot.ownerStatement || content.reply.text !== job.snapshot.assistantReply
          || feedback !== job.snapshot.ownerFeedback
          || !same(this.config.model ?? content.source.execution.modelSelection, job.snapshot.model))) throw new SourceObsolete('frozen learning inputs changed')
        return callback(content, feedback)
      }))
  }

  scan = (): void => {
    if (!this.active || this.scanning) return
    this.scanning = true
    try {
      this.lastError = null
      this.owner()
      // Lost acknowledgements reconcile before admitting more paid work.
      for (const job of this.store.pending(this.lane)) if (job.state === 'unknown') {
        if (job.request) this.reconcile(job)
        // A durable request is always saved before any review/adoption call.
        // No request proves that no memory mutation was dispatched. The paid
        // extraction attempt remains consumed and is never retried.
        else this.store.settle(job.id, 'failed', 'interrupted-extraction-no-mutation-dispatched')
      }
      if (!this.available()) { this.lastError = 'learning-authority-or-budget-unavailable'; return }
      const owner = this.config.owner
      let stopped = false
      for (let pageNumber = 0; pageNumber < 10 && !stopped; pageNumber++) {
        const after = this.store.cursor(this.lane, 'delivery') as OwnerForegroundTaskSourceCursor | undefined
        const page = this.ports.delivery.listOwnerForegroundTaskSources({ ...this.scope(), ...(after ? { after } : {}), limit: 100 })
        for (const source of page.items) {
          const now = Date.now(), at = source.execution.completedAt ?? 0
          const eligible = source.execution.status === 'succeeded' && source.execution.quiescent && at <= now
            && now - at <= this.config.lookbackMs && source.execution.modelSelectionState === 'frozen'
          const intent = eligible ? { configDigest: this.configDigest, owner, kind: 'fact' as const, subject: source.inboxId,
            inboxId: source.inboxId, expectedSourceDigest: source.sourceDigest, createdAt: now,
            expiresAt: Math.min(this.config.expiresAt, now + this.config.lookbackMs) } : undefined
          if (!this.store.stage({ lane: this.lane, feed: 'delivery', cursor: { ...page.nextCursor, sequence: source.completionSequence },
            sequence: source.completionSequence, subject: source.inboxId, ...(intent ? { intent } : {}), maxPending: this.config.maxPending })) { stopped = true; break }
        }
        if (!stopped) this.store.stage({ lane: this.lane, feed: 'delivery', cursor: page.nextCursor, sequence: page.nextCursor.sequence,
          subject: 'cursor:delivery', maxPending: this.config.maxPending })
        if (!page.hasMore) break
      }
      const scope = this.ports.evaluation.canonicalHostScope({ workspace: owner.workspace, preset: owner.agentPreset })
      stopped = false
      for (let pageNumber = 0; pageNumber < 10 && !stopped; pageNumber++) {
        const after = this.store.cursor(this.lane, 'evaluation') as Readonly<{ scopeKey: string; watermark: number }> | undefined
        const page = this.ports.evaluation.listTrustedTaskLearningProjections({ scope, ...(after ? { after } : {}), limit: 100 })
        for (const item of page.items) {
          const canonical = item.receipt, now = Date.now(), at = canonical.objective?.occurredAt ?? 0
          const foreground = canonical.projection.subjectKind === 'foreground-turn'
          const status = canonical.objective?.status
          const eligible = foreground && canonical.projection.disposition === 'upsert' && (status === 'achieved' || status === 'not-achieved')
            && at <= now && now - at <= this.config.lookbackMs
          const intent = eligible ? { configDigest: this.configDigest, owner, kind: 'experience' as const,
            subject: canonical.projection.subjectRef, inboxId: canonical.projection.subjectRef,
            canonical: { outcomeId: canonical.triggerOutcomeId, version: canonical.projection.version,
              digest: canonical.projection.digest, objectiveStatus: status }, createdAt: now,
            expiresAt: Math.min(this.config.expiresAt, now + this.config.lookbackMs) } : undefined
          // No Delivery or Memory calls under this Evaluation lock.
          const result = this.ports.evaluation.withTrustedCanonicalScopeWriterFence({ scope, scopeWatermark: page.scopeWatermark }, () =>
            this.store.stage({ lane: this.lane, feed: 'evaluation', cursor: { scopeKey: page.nextCursor.scopeKey, watermark: item.watermark },
              sequence: item.watermark, subject: canonical.projection.subjectRef, ...(intent ? { intent } : {}),
              maxPending: this.config.maxPending, supersede: foreground }))
          if (!result.matched || !result.value) { stopped = true; break }
        }
        if (!page.hasMore) break
      }
      for (const pending of this.store.pending(this.lane)) {
        if (pending.state !== 'pending' && pending.state !== 'queued') continue
        try {
          let job = pending
          if (job.state === 'pending') {
            // Each API owns its own producer locks; do not nest target discovery.
            const targets = this.ports.memory.listLearningTargets({ owner, limit: 20 })
            job = this.withSource(job, (content, feedback) => this.store.freeze(job.id, {
              model: validateLearningModel(this.config.model ?? content.source.execution.modelSelection),
              source: { inboxId: content.source.inboxId, sourceDigest: content.sourceDigest, contentDigest: content.contentDigest,
                ...(job.intent.canonical ? { canonical: job.intent.canonical } : {}) },
              ownerStatement: content.input.text, assistantReply: content.reply.text,
              ...(feedback === undefined ? {} : { ownerFeedback: feedback }), targets,
            }))
          }
          this.withSource(job, () => this.schedule(job))
        } catch (error) {
          if (error instanceof SourceObsolete) this.store.settle(pending.id, 'superseded', reasonText(error.message))
          // Missing source/provider/scheduling readiness keeps the same durable intent.
          else if (!(error instanceof SourcePending)) this.lastError = String(error).slice(0, 200)
        }
      }
      this.lastScanAt = Date.now()
      if (this.lastError === 'learning-authority-or-budget-unavailable') this.lastError = null
    } catch (error) { this.lastError = String(error).slice(0, 200) }
    finally { this.scanning = false }
  }

  private definition(job?: LearningJob): HostAutomationDefinition {
    const owner = this.config.owner
    return { name: job ? 'Learn from an ordinary owner task' : 'Discover ordinary owner learning',
      schedule: job ? { kind: 'at', at: new Date(job.intent.createdAt + 1000).toISOString() }
        : { kind: 'cron', expression: '* * * * *', timezone: 'UTC' }, workspace: owner.workspace, agentPreset: owner.agentPreset,
      timeoutMs: job ? this.config.timeoutMs + 310_000 : 30_000, misfire: { kind: 'latest' }, overlap: 'skip',
      retrySafety: 'never', maxRetries: 0, principal: owner.principalId,
      budgetId: job ? this.config.budgetId : this.config.scanBudgetId,
      budgetAmount: job ? this.config.budgetAmount : this.config.scanBudgetAmount,
      execution: { kind: 'host', executorId: EXECUTOR, executorContractVersion: 1, runbookId: job ? 'learn' : 'scan',
        runbookVersion: 1, catalogDigest: CATALOG, targetScope: { workspace: owner.workspace, preset: owner.agentPreset },
        scopeDigest: growthObjectDigest([owner.workspace, owner.agentPreset]), ownerRouteId: owner.authorityId,
        activationNonce: job?.digest ?? this.configDigest } }
  }
  private schedule(input: LearningJob): void {
    let job = input
    const definition = this.definition(job)
    if (job.definitionHash === null) {
      this.ports.automations.reconcileSystem({ owner: OWNER, automationId: job.id,
        idempotencyKey: `${job.id}:prepare`, desiredStatus: 'paused', definition })
      const receipt = this.ports.automations.inspectSystemOwnedActivation({ owner: OWNER, automationId: job.id })
      if (!receipt || receipt.activationNonce !== job.digest || receipt.ownerRouteId !== this.config.owner.authorityId) throw new Error('learning registration mismatch')
      job = this.store.bind(job.id, receipt.definitionHash)
    }
    const receipt = this.ports.automations.inspectSystemOwnedActivation({ owner: OWNER, automationId: job.id })
    if (!receipt || receipt.definitionHash !== job.definitionHash || receipt.activationNonce !== job.digest) throw new Error('learning definition changed')
    const terminal = this.ports.automations.inspectSystemOwned({ owner: OWNER, automationId: job.id }).latestTerminalRuns.production
    if (terminal && terminal.immutableContext.state === 'verified' && terminal.immutableContext.definitionHash === job.definitionHash) {
      this.store.settle(job.id, 'failed', 'native-run-ended-before-claim'); return
    }
    this.ports.automations.reconcileSystem({ owner: OWNER, automationId: job.id,
      idempotencyKey: `${job.id}:activate`, desiredStatus: 'active', definition })
  }
  private reviewMatches(job: LearningJob, receipt: Readonly<MemoryReviewReceipt>): boolean {
    return receipt.operationId === job.request!.operationId && receipt.requestDigest === memoryLearningRequestDigest(job.request!)
      && receipt.authorityId === this.config.reviewAuthorityId && receipt.authorityDigest === this.config.reviewAuthorityDigest
      && receipt.sessionId !== job.request!.extractionSessionId
  }
  private reconcile(job: LearningJob): void {
    try {
      const prior = this.ports.memory.lookupLearningAdoption({ request: job.request! })
      if (prior) { this.store.settle(job.id, 'adopted', 'reconciled-original-adoption', prior.receiptDigest); return }
      this.withSource(job, () => undefined)
      const review = this.ports.verifier.lookupMemoryLearningReview(job.request!)
      if (!review || !this.reviewMatches(job, review) || review.status === 'unknown') return
      if (review.status === 'rejected') this.store.settle(job.id, 'rejected', reasonText(review.reason), review.receiptDigest)
      else {
        // Lookup completed outside producer locks. Memory owns its adoption locks.
        this.withSource(job, () => undefined)
        const adopted = this.ports.memory.adoptReviewedLearning({ request: job.request! })
        this.store.settle(job.id, 'adopted', 'reconciled-approved-adoption', adopted.receiptDigest)
      }
    } catch (error) {
      if (error instanceof SourceObsolete) this.store.settle(job.id, 'superseded', reasonText(error.message))
      // Temporary absence retains the same request; paid calls are not replayed.
    }
  }
  private async execute(input: HostAutomationExecutorInput): Promise<HostAutomationExecutorResult> {
    const result = (outcome: 'succeeded' | 'failed' | 'unknown'): HostAutomationExecutorResult => ({ outcome,
      failureClass: outcome === 'succeeded' ? 'none' : outcome === 'unknown' ? 'unknown' : 'configuration',
      failurePhase: outcome === 'succeeded' ? 'none' : 'host-execution', failureCode: outcome === 'succeeded' ? 'none' : 'memory-learning-incomplete',
      sideEffectState: outcome === 'succeeded' ? 'possible' : outcome === 'unknown' ? 'unknown' : 'none',
      retryability: outcome === 'failed' ? 'after-intervention' : 'unsafe' })
    let claimed: LearningJob | undefined
    try {
      this.owner(); this.abort.signal.throwIfAborted(); input.signal.throwIfAborted()
      const owner = this.config.owner
      if (input.executionMode !== 'production' || input.catalogDigest !== CATALOG || input.ownerRouteId !== owner.authorityId
        || input.principal !== owner.principalId || input.targetScope.workspace !== owner.workspace
        || input.targetScope.preset !== owner.agentPreset) throw new Error('learning dispatch scope mismatch')
      const activation = this.ports.automations.inspectSystemOwnedActivation({ owner: OWNER, automationId: input.automationId })
      if (!activation || activation.definitionHash !== input.definitionHash || activation.activationNonce !== input.activationNonce) throw new Error('learning activation changed')
      if (input.automationId === this.scanId) {
        if (input.activationNonce !== this.configDigest) throw new Error('learning scanner configuration changed')
        this.scan(); return result(this.lastError === null ? 'succeeded' : 'failed')
      }
      const queued = this.store.get(input.automationId)
      if (!queued || queued.state !== 'queued' || !queued.snapshot || queued.digest !== input.activationNonce
        || queued.definitionHash !== input.definitionHash || !this.available()) throw new Error('learning job is not admissible')
      this.withSource(queued, () => { claimed = this.store.claim(queued.id, input.definitionHash, input.occurrenceId) })
      const job = claimed!
      const signal = AbortSignal.any([input.signal, this.abort.signal, AbortSignal.timeout(Math.max(1,
        Math.min(this.config.timeoutMs + 310_000, job.intent.expiresAt - Date.now(), this.config.expiresAt - Date.now())))])
      const assertCurrent = (): void => {
        signal.throwIfAborted()
        const current = this.store.get(job.id)
        if (!current || current.state !== 'running' || current.occurrenceId !== input.occurrenceId) throw new Error('learning claim superseded')
        this.withSource(job, () => undefined)
      }
      assertCurrent(); this.policy(true, `memory-extract:${this.config.authorityId}:${job.id}`)
      const extractionSignal = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)])
      const extraction = await this.ports.extract({ config: this.config, job, signal: extractionSignal, assertCurrent })
      assertCurrent()
      if (!extraction.proposal) {
        this.store.settle(job.id, 'noop', reasonText(extraction.reason), extraction.outputDigest, input.occurrenceId)
        return result('succeeded')
      }
      const proposal = extraction.proposal
      const quoteSources = [job.snapshot!.ownerStatement, job.snapshot!.ownerFeedback ?? '']
      if (!quoteSources.some(text => text.includes(proposal.evidenceQuote))) throw new Error('learning quotation is not an owner source')
      if (proposal.mutation.op !== 'remove' && proposal.mutation.entry.kind !== job.intent.kind) throw new Error('learning kind changed')
      const mutation = proposal.mutation
      if (mutation.op !== 'add' && !job.snapshot!.targets.some(target => target.id === mutation.id && target.version === mutation.expectedVersion)) throw new Error('learning target not in frozen managed set')
      const request = validateMemoryLearningReviewRequest({ protocol: 'memory-learning-review/v1',
        operationId: job.id, extractionSessionId: extraction.sessionId,
        owner, source: job.snapshot!.source, ...proposal })
      const saved = this.store.saveRequest(job.id, input.occurrenceId, request)
      const review = await this.ports.verifier.reviewMemoryLearning(request, signal)
      assertCurrent()
      if (!this.reviewMatches(saved, review) || review.status === 'unknown') {
        this.store.settle(job.id, 'unknown', 'independent-review-unresolved', undefined, input.occurrenceId); return result('unknown')
      }
      if (review.status === 'rejected') {
        this.store.settle(job.id, 'rejected', reasonText(review.reason), review.receiptDigest, input.occurrenceId); return result('succeeded')
      }
      assertCurrent()
      const adopted = this.ports.memory.adoptReviewedLearning({ request })
      this.store.settle(job.id, 'adopted', 'independently-reviewed-and-adopted', adopted.receiptDigest, input.occurrenceId)
      return result('succeeded')
    } catch (error) {
      if (!this.active || this.abort.signal.aborted) return result(claimed ? 'unknown' : 'failed')
      if (claimed) {
        const current = this.store.get(claimed.id)
        if (current?.state === 'running' && current.occurrenceId === input.occurrenceId) {
          this.store.settle(claimed.id, current.request ? 'unknown' : 'failed', reasonText(error), undefined, input.occurrenceId)
        }
      }
      return result(claimed ? 'unknown' : 'failed')
    } finally { if (this.active) this.scan() }
  }
}
