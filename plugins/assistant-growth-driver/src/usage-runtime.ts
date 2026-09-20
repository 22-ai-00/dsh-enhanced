import type { AssistantAutomationsService, HostAutomationDefinition, HostAutomationExecutorInput, HostAutomationExecutorResult } from '@dsh-enhanced/assistant-automations'
import type { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import type { AssistantDeliveryService, OwnerForegroundLearningTask } from '@dsh-enhanced/assistant-delivery'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { NormalizedGrowthDriverConfig } from './config.js'
import { UsageStore, type UsageIntent, type UsageJob, type UsageModel } from './usage-store.js'

const OWNER = 'assistant-growth-usage'
const EXECUTOR = 'assistant-growth-usage-v1'
const CATALOG = acceptanceDigest({ executor: EXECUTOR, version: 1 })
type Evaluation = Pick<AssistantEvaluationService, 'canonicalHostScope' | 'listTrustedTaskLearningProjections' | 'withTrustedCanonicalTaskWriterFence' | 'onTrustedTaskChange'>
type Delivery = Pick<AssistantDeliveryService, 'validateOwnerRoute' | 'inspectOwnerForegroundLearningTask'>
type Automations = Pick<AssistantAutomationsService, 'registerHostExecutor' | 'reconcileSystem' | 'inspectSystemOwnedActivation' | 'inspectSystemOwned'>
export interface UsageReviewInput {
  id: string
  model: UsageModel
  source: OwnerForegroundLearningTask
  signal: AbortSignal
  assertCurrent(): void
}
export type UsageReviewResult = 'reviewed' | 'failed' | 'unknown'
const same = (a: unknown, b: unknown): boolean => acceptanceDigest(a) === acceptanceDigest(b)

/** Durable task-driven reviews; only native Automations owns timers/claims. */
export class UsageLearningRuntime {
  private readonly store: UsageStore
  private readonly lane: string
  private readonly configDigest: string
  private readonly scanId: string
  private readonly abort = new AbortController()
  private readonly flights = new Set<Promise<unknown>>()
  private unregister: (() => void) | undefined
  private unsubscribe: (() => void) | undefined
  private active = false
  private scanning = false
  private lastError: string | null = null
  private lastScanAt: number | null = null
  private closing: Promise<void> | undefined
  constructor(private readonly config: NormalizedGrowthDriverConfig, private readonly ports: {
    evaluation: Evaluation; delivery: Delivery; automations: Automations
    review(input: UsageReviewInput): Promise<UsageReviewResult>
  }) {
    if (!config.usageLearning.enabled || !config.scope || !config.usageLearning.databasePath || !config.budgetId) throw new Error('usage learning configuration missing')
    if (typeof ports.evaluation.listTrustedTaskLearningProjections !== 'function'
      || typeof ports.evaluation.withTrustedCanonicalTaskWriterFence !== 'function'
      || typeof ports.evaluation.onTrustedTaskChange !== 'function'
      || typeof ports.delivery.inspectOwnerForegroundLearningTask !== 'function'
      || typeof ports.automations.registerHostExecutor !== 'function'
      || typeof ports.automations.inspectSystemOwnedActivation !== 'function') {
      throw new Error('usage learning requires compatible Evaluation, Delivery and Automations Host APIs')
    }
    this.store = new UsageStore(config.usageLearning.databasePath)
    this.lane = acceptanceDigest(config.scope)
    this.configDigest = acceptanceDigest(config)
    this.scanId = `usage-scan-${this.lane}`
  }
  health = () => ({ enabled: true, connected: this.active, lastScanAt: this.lastScanAt,
    lastError: this.lastError, counts: this.store.counts(this.lane) })

  start(): void {
    this.store.interrupt(this.lane)
    this.unregister = this.ports.automations.registerHostExecutor({
      descriptor: { executorId: EXECUTOR, contractVersion: 1, catalogDigest: CATALOG },
      accepts: spec => spec.executorId === EXECUTOR && spec.executorContractVersion === 1
        && spec.catalogDigest === CATALOG && spec.runbookVersion === 1 && ['scan', 'review'].includes(spec.runbookId),
      execute: input => {
        const flight = this.execute(input)
        this.flights.add(flight)
        void flight.finally(() => this.flights.delete(flight)).catch(() => {})
        return flight
      },
    })
    this.active = true
    this.unsubscribe = this.ports.evaluation.onTrustedTaskChange(() => this.scan())
    // This persisted scan also discovers writes made by another Host process.
    this.ports.automations.reconcileSystem({ owner: OWNER, automationId: this.scanId,
      idempotencyKey: `${this.scanId}:${this.configDigest}`, desiredStatus: 'active', definition: this.definition() })
    this.scan()
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.active = false
      this.unsubscribe?.(); this.unregister?.()
      this.abort.abort(new Error('usage learning provider disposed'))
      await Promise.allSettled(this.flights)
      this.store.close()
    })()
  }

  private owner() {
    if (!this.active) throw new Error('usage learning unavailable')
    const scope = this.config.scope!
    return this.ports.delivery.validateOwnerRoute({ authorityId: scope.ownerRouteId, principalId: scope.principalId,
      workspace: scope.workspace, agentPreset: scope.preset })
  }
  private source(job: UsageJob): OwnerForegroundLearningTask {
    this.abort.signal.throwIfAborted()
    if (job.intent.configDigest !== this.configDigest || job.intent.expiresAt <= Date.now()
      || !same(this.owner(), job.intent.source.owner)) throw new Error('usage authority changed or expired')
    const owner = job.intent.source.owner
    const source = this.ports.delivery.inspectOwnerForegroundLearningTask({ authorityId: owner.authorityId,
      principalId: owner.principalId, workspace: owner.workspace, agentPreset: owner.agentPreset,
      outcomeId: job.intent.source.canonical.triggerOutcomeId })
    if (!source || !same(source.canonical.projection, job.intent.source.canonical.projection)
      || !same(source.source, job.intent.source.source) || !same(source.owner, owner)) throw new Error('usage source changed')
    return source
  }

  /** Synchronous nudge, bounded to 1000 heads. Native scan resumes the cursor. */
  scan = (): void => {
    if (!this.active || this.scanning) return
    this.scanning = true
    try {
      const owner = this.owner()
      for (const job of this.store.pending(this.lane)) if (job.state === 'queued') {
        try { this.source(job); this.schedule(job) }
        catch { this.store.settle(job.id, 'failed', 'queued-source-or-schedule-unavailable') }
      }
      const scope = this.ports.evaluation.canonicalHostScope({ workspace: owner.workspace, preset: owner.agentPreset })
      let stop = false
      for (let pageNumber = 0; pageNumber < 10 && !stop; pageNumber += 1) {
        const page = this.ports.evaluation.listTrustedTaskLearningProjections({ scope,
          ...(this.store.cursor(this.lane) === undefined ? {} : { after: this.store.cursor(this.lane)! }), limit: 100 })
        for (const item of page.items) {
          const canonical = item.receipt
          const source = canonical.projection.subjectKind === 'foreground-turn'
            ? this.ports.delivery.inspectOwnerForegroundLearningTask({ authorityId: owner.authorityId,
              principalId: owner.principalId, workspace: owner.workspace, agentPreset: owner.agentPreset,
              outcomeId: canonical.triggerOutcomeId }) : undefined
          const model = this.config.provider !== null && this.config.model !== null
            ? { provider: this.config.provider, model: this.config.model,
              ...(this.config.reasoningEffort === null ? {} : { reasoningEffort: this.config.reasoningEffort }) }
            : source?.source.modelSelection
          const now = Date.now()
          const occurredAt = canonical.objective?.occurredAt ?? 0
          const eligible = source !== undefined && source.source.quiescent && !source.source.truncated
            && canonical.projection.disposition === 'upsert' && source.judgement !== 'unresolved'
            && occurredAt <= now && now - occurredAt <= this.config.usageLearning.lookbackMs && model !== undefined
          const intent: UsageIntent | undefined = eligible ? { configDigest: this.configDigest, source: source!, model: model!,
            createdAt: now, expiresAt: now + this.config.usageLearning.lookbackMs } : undefined
          const result = this.ports.evaluation.withTrustedCanonicalTaskWriterFence({ scope, scopeWatermark: page.scopeWatermark,
            evidence: [canonical.projection] }, () => {
            if (!same(owner, this.owner())) throw new Error('usage owner changed during scan')
            return this.store.consume({ lane: this.lane, scopeKey: page.nextCursor.scopeKey, watermark: item.watermark,
              subject: `${canonical.projection.subjectKind}:${canonical.projection.subjectRef}`,
              ...(intent === undefined ? {} : { intent }), maxPending: this.config.usageLearning.maxPending })
          })
          if (!result.matched || !result.value) { stop = true; break }
        }
        if (!page.hasMore) break
      }
      for (const job of this.store.pending(this.lane)) if (job.state === 'queued') {
        try { this.schedule(job) } catch { this.store.settle(job.id, 'failed', 'schedule-rejected') }
      }
      this.lastError = null; this.lastScanAt = Date.now()
    } catch (error) { this.lastError = error instanceof Error ? error.message.slice(0, 200) : 'usage-scan-failed' }
    finally { this.scanning = false }
  }

  private definition(job?: UsageJob): HostAutomationDefinition {
    const scope = this.config.scope!
    return { name: job ? 'Review real task feedback' : 'Discover real task feedback',
      schedule: job ? { kind: 'at', at: new Date(job.intent.createdAt + 1000).toISOString() }
        : { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
      workspace: scope.workspace, agentPreset: scope.preset, timeoutMs: job ? this.config.maxDurationMs + 5000 : 30_000,
      misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0, principal: scope.principalId,
      ...(job ? { budgetId: this.config.budgetId!, budgetAmount: this.config.budgetAmount! }
        : { budgetId: this.config.usageLearning.scanBudgetId!, budgetAmount: this.config.usageLearning.scanBudgetAmount! }),
      execution: { kind: 'host', executorId: EXECUTOR, executorContractVersion: 1, runbookId: job ? 'review' : 'scan',
        runbookVersion: 1, catalogDigest: CATALOG, targetScope: { workspace: scope.workspace, preset: scope.preset },
        scopeDigest: acceptanceDigest([scope.workspace, scope.preset]), ownerRouteId: scope.ownerRouteId,
        activationNonce: job?.digest ?? this.configDigest } }
  }
  private schedule(input: UsageJob): void {
    let job = input
    this.source(job)
    const definition = this.definition(job)
    if (job.definitionHash === null) {
      this.ports.automations.reconcileSystem({ owner: OWNER, automationId: job.id,
        idempotencyKey: `${job.id}:prepare`, desiredStatus: 'paused', definition })
      const receipt = this.ports.automations.inspectSystemOwnedActivation({ owner: OWNER, automationId: job.id })
      if (!receipt || receipt.activationNonce !== job.digest || receipt.ownerRouteId !== this.config.scope!.ownerRouteId) throw new Error('usage registration mismatch')
      job = this.store.bind(job.id, receipt.definitionHash)
    }
    const current = this.ports.automations.inspectSystemOwnedActivation({ owner: OWNER, automationId: job.id })
    if (!current || current.definitionHash !== job.definitionHash || current.activationNonce !== job.digest) throw new Error('usage definition changed')
    const terminal = this.ports.automations.inspectSystemOwned({ owner: OWNER, automationId: job.id }).latestTerminalRuns.production
    if (terminal && terminal.immutableContext.state === 'verified' && terminal.immutableContext.definitionHash === job.definitionHash) {
      this.store.settle(job.id, 'failed', 'native-run-ended-before-claim'); return
    }
    this.ports.automations.reconcileSystem({ owner: OWNER, automationId: job.id,
      idempotencyKey: `${job.id}:activate`, desiredStatus: 'active', definition })
  }
  private async execute(input: HostAutomationExecutorInput): Promise<HostAutomationExecutorResult> {
    const result = (outcome: 'succeeded' | 'failed' | 'unknown'): HostAutomationExecutorResult => ({ outcome,
      failureClass: outcome === 'succeeded' ? 'none' : outcome === 'unknown' ? 'unknown' : 'configuration',
      failurePhase: outcome === 'succeeded' ? 'none' : 'host-execution', failureCode: outcome === 'succeeded' ? 'none' : 'usage-review-rejected',
      sideEffectState: outcome === 'unknown' ? 'unknown' : outcome === 'succeeded' ? 'possible' : 'none',
      retryability: outcome === 'succeeded' || outcome === 'unknown' ? 'unsafe' : 'after-intervention' })
    let claimed: UsageJob | undefined
    try {
      const owner = this.owner()
      if (input.executionMode !== 'production' || input.catalogDigest !== CATALOG || input.ownerRouteId !== owner.authorityId
        || input.principal !== owner.principalId || input.targetScope.workspace !== owner.workspace || input.targetScope.preset !== owner.agentPreset) throw new Error('usage dispatch scope mismatch')
      input.signal.throwIfAborted()
      if (input.automationId === this.scanId) {
        const current = this.ports.automations.inspectSystemOwnedActivation({ owner: OWNER, automationId: this.scanId })
        if (input.activationNonce !== this.configDigest || current?.definitionHash !== input.definitionHash) throw new Error('usage scanner changed')
        this.scan(); return result(this.lastError === null ? 'succeeded' : 'failed')
      }
      const queued = this.store.get(input.automationId)
      if (!queued || queued.state !== 'queued' || queued.digest !== input.activationNonce || queued.definitionHash !== input.definitionHash) throw new Error('usage review is not queued')
      this.source(queued)
      claimed = this.store.claim(queued.id, input.definitionHash, input.occurrenceId)
      const job = claimed
      const signal = AbortSignal.any([input.signal, this.abort.signal,
        AbortSignal.timeout(Math.max(1, Math.min(this.config.maxDurationMs, job.intent.expiresAt - Date.now())))])
      const assertCurrent = (): void => {
        signal.throwIfAborted(); this.source(job)
        const stored = this.store.get(job.id)
        if (stored?.state !== 'running' || stored.occurrenceId !== input.occurrenceId) throw new Error('usage dispatch no longer owned')
      }
      assertCurrent()
      const outcome = await this.ports.review({ id: job.id, model: job.intent.model, source: job.intent.source, signal, assertCurrent })
      assertCurrent()
      this.store.settle(job.id, outcome, outcome === 'reviewed' ? 'review-complete-not-adopted' : 'review-incomplete', input.occurrenceId)
      return result(outcome === 'reviewed' ? 'succeeded' : outcome)
    } catch {
      if (claimed) this.store.settle(claimed.id, 'unknown', 'interrupted-after-dispatch', input.occurrenceId)
      return result(claimed ? 'unknown' : 'failed')
    } finally { if (this.active) this.scan() }
  }
}
