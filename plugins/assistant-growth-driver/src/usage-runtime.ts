import { ScannerOwnerGuard, ScannerOwnerUnavailable, drainScannerFlights } from './scanner-owner-runtime.js'
import type { AssistantAutomationsService, HostAutomationDefinition, HostAutomationExecutorInput, HostAutomationExecutorResult } from '@dsh-enhanced/assistant-automations'
import type { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import type { AssistantDeliveryService, OwnerForegroundLearningTask, OwnerWorkItemEngineeringContextExpectation, OwnerWorkItemEngineeringContextSource } from '@dsh-enhanced/assistant-delivery'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { SourceGrowthRunUnavailableError, isSourceOwnerContinuation, sourceGrowthEvidenceDigest, sourceGrowthRunDigest, validateSourceGrowthRunBinding,
  type CreationAcceptanceAuthorityRef, type RevisionAcceptanceAuthorityRef, type RevisionRegressionAcceptanceAuthorityRef,
  type AnySourceGrowthRunBinding, type WorkItemSourceGrowthRunBinding, validateAnySourceGrowthRunBinding, anySourceGrowthRunDigest, type SourceGrowthRunBinding, type SourceGrowthRunRequest } from '@dsh-enhanced/assistant-growth-contract'
import type { NormalizedGrowthDriverConfig } from './config.js'
import { UsageStore, isWorkItemUsageIntent, type WorkItemUsageIntent, type ForegroundUsageIntent, type UsageJob, type UsageModel } from './usage-store.js'

import { freezeWorkItemData, ownData, isWorkItemCreationReady, workItemAuthorityDeadline, workItemTextDigest, workItemRunSource, workItemStableOwner, type WorkItemCreationReadiness, type WorkItemUsageLocator, type WorkItemUsageSource } from './work-item-source.js'

class WorkItemSourcePending extends Error {}
class WorkItemSourceObsolete extends Error {}
const OWNER = 'assistant-growth-usage'
const EXECUTOR = 'assistant-growth-usage-v1'
const CATALOG = acceptanceDigest({ executor: EXECUTOR, version: 1 })
type Evaluation = Pick<AssistantEvaluationService, 'canonicalHostScope' | 'listTrustedTaskLearningProjections' | 'withTrustedCanonicalTaskWriterFence' | 'onTrustedTaskChange'> & Partial<Pick<AssistantEvaluationService, 'getTrustedWorkItemLearningProjection'>>
type Delivery = Pick<AssistantDeliveryService, 'validateOwnerRoute' | 'inspectOwnerRouteState' | 'inspectOwnerForegroundLearningTask'> & Partial<Pick<AssistantDeliveryService, 'inspectOwnerWorkItemEngineeringContext' | 'readOwnerWorkItemEngineeringContext' | 'withOwnerWorkItemEngineeringContextFence'>>
type Automations = Pick<AssistantAutomationsService, 'inspectSystemOwnedRetirement' | 'retireSystemOwned' | 'onSchedulerWake' | 'registerHostExecutor' | 'reconcileSystem' | 'inspectSystemOwnedActivation' | 'inspectSystemOwned'>
export interface UsageReviewInput {
  id: string
  intentDigest: string
  definitionHash: string
  occurrenceId: string
  expiresAt: number
  model: UsageModel
  source: OwnerForegroundLearningTask
  signal: AbortSignal
  assertCurrent(): void
  bindSourceRun(input: Pick<SourceGrowthRunBinding, 'model' | 'sessionId' | 'toolContractDigest' | 'executionContractDigest' | 'createdAt' | 'generationDeadlineAt' | 'creationAcceptance' | 'revisionAcceptance' | 'revisionRegressionAcceptance'>): SourceGrowthRunBinding
}
export interface WorkItemUsageReviewInput extends Omit<UsageReviewInput, 'source' | 'bindSourceRun'> {
  sourceKind: 'work-item'
  assertFirstModelAdmission(): void
  source: WorkItemUsageSource
  bindSourceRun(input: Parameters<UsageReviewInput['bindSourceRun']>[0]): WorkItemSourceGrowthRunBinding
}
export type AnyUsageReviewInput = UsageReviewInput | WorkItemUsageReviewInput
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
  private readonly ownerGuard: ScannerOwnerGuard
  private unsubscribeWake: (() => void) | undefined
  private initialized = false
  private active = false
  private scanning = false
  private lastError: string | null = null
  private lastScanAt: number | null = null
  private closing: Promise<void> | undefined
  constructor(private readonly config: NormalizedGrowthDriverConfig, private readonly ports: {
    evaluation: Evaluation; delivery: Delivery; automations: Automations
    inspectWorkItemToolPreauthorization?(): boolean
    reviewWorkItem?(input: WorkItemUsageReviewInput): Promise<UsageReviewResult>
    inspectWorkItemCreationReadiness?(input: { owner: WorkItemUsageSource['task']['owner'] }): WorkItemCreationReadiness | undefined
    review(input: UsageReviewInput): Promise<UsageReviewResult>
    inspectCreationAcceptanceAuthority?(): CreationAcceptanceAuthorityRef | undefined
    inspectRevisionAcceptanceAuthority?(): RevisionAcceptanceAuthorityRef | undefined
    inspectRevisionRegressionAcceptanceAuthority?(): RevisionRegressionAcceptanceAuthorityRef | undefined
  }) {
    if (!config.usageLearning.enabled || !config.scope || !config.usageLearning.databasePath || !config.budgetId) throw new Error('usage learning configuration missing')
    if (typeof ports.evaluation.listTrustedTaskLearningProjections !== 'function'
      || typeof ports.evaluation.withTrustedCanonicalTaskWriterFence !== 'function'
      || typeof ports.evaluation.onTrustedTaskChange !== 'function'
      || typeof ports.delivery.inspectOwnerRouteState !== 'function'
      || typeof ports.automations.inspectSystemOwnedRetirement !== 'function'
      || typeof ports.automations.retireSystemOwned !== 'function'
      || typeof ports.automations.onSchedulerWake !== 'function'
      || typeof ports.delivery.inspectOwnerForegroundLearningTask !== 'function'
      || typeof ports.automations.registerHostExecutor !== 'function'
      || typeof ports.automations.inspectSystemOwnedActivation !== 'function') {
      throw new Error('usage learning requires compatible Evaluation, Delivery and Automations Host APIs')
    }
    this.store = new UsageStore(config.usageLearning.databasePath)
    this.lane = acceptanceDigest(config.scope)
    // Historical defaults were revision=false and modification=true. Preserve
    // both omissions for old runs; an explicitly restricted lane stays distinct.
    const { allowRevision, allowModification, ...legacySourceConfig } = config.pluginSourceProposals
    this.configDigest = acceptanceDigest({ ...config, pluginSourceProposals: { ...legacySourceConfig,
      ...(allowRevision ? { allowRevision: true } : {}),
      ...(allowModification === false ? { allowModification: false } : {}) } })
    this.scanId = `usage-scan-${this.lane}`
    this.ownerGuard = new ScannerOwnerGuard(OWNER, this.scanId, { authorityId: config.scope.ownerRouteId,
      principalId: config.scope.principalId, workspace: config.scope.workspace, agentPreset: config.scope.preset }, ports.delivery, ports.automations)
  }
  health = () => ({ enabled: true, connected: this.active && !this.ownerGuard.retired, lastScanAt: this.lastScanAt,
    lastError: this.lastError, counts: this.store.counts(this.lane) })

  start(): void {
    let recoverNativeScanner = false
    try { this.ownerGuard.check() } catch (error) {
      this.lastError = String(error).slice(0, 200)
      if (this.ownerGuard.retired) return
      recoverNativeScanner = this.ownerGuard.canReconcileScanner
    }
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
    this.unsubscribeWake = this.ports.automations.onSchedulerWake(() => {
      if (!this.active || this.initialized || this.ownerGuard.retired) return
      try { this.initializeScanner() }
      catch (error) { this.lastError = String(error).slice(0, 200) }
    })
    this.unsubscribe = this.ports.evaluation.onTrustedTaskChange(() => this.scan())
    // This persisted scan also discovers writes made by another Host process.
    if (recoverNativeScanner) {
      try {
        this.ports.automations.reconcileSystem({ owner: OWNER, automationId: this.scanId,
          idempotencyKey: `${this.scanId}:${this.configDigest}`, desiredStatus: 'active', definition: this.definition() })
      } catch (error) { this.lastError = String(error).slice(0, 200) }
    }
    this.scan()
  }

  private initializeScanner() {
    const owner = this.owner()
    if (!this.initialized) {
      this.store.interrupt(this.lane)
      this.ports.automations.reconcileSystem({ owner: OWNER, automationId: this.scanId,
        idempotencyKey: `${this.scanId}:${this.configDigest}`, desiredStatus: 'active', definition: this.definition() })
      this.initialized = true
    }
    return owner
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.active = false
      this.unsubscribeWake?.(); this.unsubscribe?.(); this.unregister?.()
      this.abort.abort(new Error('usage learning provider disposed'))
      try { await drainScannerFlights(this.flights) } finally { this.store.close() }
    })()
  }

  private owner() {
    if (!this.active) throw new Error('usage learning unavailable')
    this.ownerGuard.check()
    const scope = this.config.scope!
    return this.ports.delivery.validateOwnerRoute({ authorityId: scope.ownerRouteId, principalId: scope.principalId,
      workspace: scope.workspace, agentPreset: scope.preset })
  }
  private source(job: UsageJob): OwnerForegroundLearningTask {
    this.abort.signal.throwIfAborted()
    if (isWorkItemUsageIntent(job.intent)) throw new Error('foreground usage source required')
    if (job.intent.configDigest !== this.configDigest || job.intent.expiresAt <= Date.now()
      || !isSourceOwnerContinuation(this.owner(), job.intent.source.owner)) throw new Error('usage authority changed or expired')
    const owner = job.intent.source.owner
    const source = this.ports.delivery.inspectOwnerForegroundLearningTask({ authorityId: owner.authorityId,
      principalId: owner.principalId, workspace: owner.workspace, agentPreset: owner.agentPreset,
      outcomeId: job.intent.source.canonical.triggerOutcomeId })
    if (!source || !same(source.canonical.projection, job.intent.source.canonical.projection)
      || !same(source.source, job.intent.source.source) || !same(source.owner, owner)
      || !(source.ownerRevision === undefined && job.intent.source.ownerRevision === undefined
        || source.ownerRevision !== undefined && job.intent.source.ownerRevision !== undefined
          && same(source.ownerRevision, job.intent.source.ownerRevision))
      || source.judgement !== job.intent.source.judgement) throw new Error('usage source changed')
    return source
  }
  inspectSourceGrowthRun = (request: SourceGrowthRunRequest): SourceGrowthRunBinding | undefined => {
    if (!this.active) throw new SourceGrowthRunUnavailableError('usage runtime is temporarily unavailable')
    try {
      const job = this.store.get(request.runId)
      if (!job || isWorkItemUsageIntent(job.intent) || job.digest !== request.intentDigest || !['running', 'reviewed'].includes(job.state)
        || !job.intent.modelOrigin || !job.intent.budget || !job.sourceRun
        || job.definitionHash === null || job.occurrenceId === null) return undefined
      const source = this.source(job)
      const binding = job.sourceRun
      if (binding.protocol !== 'assistant-growth/source-run/v1') return undefined
      validateSourceGrowthRunBinding(binding)
      if (binding.creationAcceptance !== undefined) {
        const current = this.ports.inspectCreationAcceptanceAuthority?.()
        if (current === undefined || current.expiresAt <= Date.now() || !same(binding.creationAcceptance, current)) return undefined
      }
      if (binding.revisionAcceptance !== undefined) {
        const current = this.ports.inspectRevisionAcceptanceAuthority?.()
        if (current === undefined || current.expiresAt <= Date.now() || !same(binding.revisionAcceptance, current)) return undefined
      }
      if (binding.revisionRegressionAcceptance !== undefined) {
        const current = this.ports.inspectRevisionRegressionAcceptanceAuthority?.()
        if (current === undefined || current.expiresAt <= Date.now() || !same(binding.revisionRegressionAcceptance, current)) return undefined
      }
      if (binding.runId !== job.id || binding.intentDigest !== job.digest || binding.configDigest !== this.configDigest
        || binding.native.definitionHash !== job.definitionHash || binding.native.occurrenceId !== job.occurrenceId
        || binding.source.outcomeId !== source.canonical.triggerOutcomeId
        || !same(binding.source.projection, source.canonical.projection)
        || binding.ownerDigest !== sourceGrowthEvidenceDigest(source.owner)
        || binding.source.sourceDigest !== sourceGrowthEvidenceDigest({ protocol: source.protocol, source: source.source,
          judgement: source.judgement, ownerRevision: source.ownerRevision })
        || !same(binding.model, job.intent.model) || binding.modelOrigin !== job.intent.modelOrigin
        || !same(binding.budget, job.intent.budget)) return undefined
      return structuredClone(binding)
    } catch (error) {
      if (error instanceof ScannerOwnerUnavailable && !this.ownerGuard.retired) throw new SourceGrowthRunUnavailableError(error.message)
      const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined
      if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED'
        || code === 'ERR_SQLITE_ERROR' && error instanceof Error && /database (?:is )?(?:busy|locked)/iu.test(error.message)) {
        throw new SourceGrowthRunUnavailableError('usage store is temporarily busy')
      }
      return undefined
    }
  }

  private workItemScope(owner: WorkItemUsageLocator['owner']) {
    return { authorityId: owner.authorityId, principalId: owner.principalId, workspace: owner.workspace, agentPreset: owner.agentPreset,
      expectedOwner: { authorityHash: owner.authorityHash, principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion } }
  }
  private assertWorkItemReadiness(owner: WorkItemUsageSource['task']['owner'], admission = true): void {
    const pins = this.config.usageLearning.workItemAuthorities
    const currentOwner = this.owner()
    if (!isSourceOwnerContinuation(currentOwner, owner)) throw new WorkItemSourceObsolete('work item source owner changed')
    if (!this.config.usageLearning.workItemFailures || !pins || !this.ports.reviewWorkItem
      || this.ports.inspectWorkItemToolPreauthorization?.() !== true
      || !isWorkItemCreationReady(this.ports.inspectWorkItemCreationReadiness?.({ owner: currentOwner }), pins, Date.now(), admission)) {
      throw new WorkItemSourcePending('work item engineering peers or authorizations unavailable')
    }
  }
  private currentWorkItem(locator: WorkItemUsageLocator): void {
    if (locator.configDigest !== this.configDigest || locator.expiresAt <= Date.now()
      || !same(workItemStableOwner(this.owner()), locator.owner)) throw new WorkItemSourceObsolete('work item usage authority changed or expired')
    const get = this.ports.evaluation.getTrustedWorkItemLearningProjection
    if (typeof get !== 'function') throw new WorkItemSourcePending('work item canonical reader unavailable')
    const scope = this.ports.evaluation.canonicalHostScope({ workspace: locator.owner.workspace, preset: locator.owner.agentPreset })
    const current = get.call(this.ports.evaluation, { scope, itemId: locator.itemId })
    if (!current || current.projection.disposition !== 'upsert' || current.objective?.status !== 'not-achieved'
      || current.objective.outcomeId !== locator.canonical.outcomeId || current.projection.version !== locator.canonical.version
      || current.projection.digest !== locator.canonical.digest) throw new WorkItemSourceObsolete('work item canonical source changed')
  }
  private expectation(source: WorkItemUsageSource): OwnerWorkItemEngineeringContextExpectation {
    const task = source.task, outcome = task.canonical.objective!
    return { ...this.workItemScope(task.owner), itemId: task.proofIdentity.itemId, outcomeId: outcome.outcomeId,
      expectedSourceDigest: task.sourceDigest, expectedContentDigest: task.presentationDigest,
      canonical: { version: task.canonical.projection.version, digest: task.canonical.projection.digest, objectiveStatus: 'not-achieved' },
      expectedManifestDigest: source.manifest.manifestDigest, expectedObjectiveDigest: source.manifest.objective.fullTextDigest }
  }
  private locatorFor(intent: WorkItemUsageIntent): WorkItemUsageLocator {
    const source = workItemRunSource(intent.source), owner = intent.source.task.owner
    return { protocol: 'assistant-growth/work-item-usage-locator/v1', configDigest: intent.configDigest,
      owner: { authorityId: owner.authorityId, authorityHash: owner.authorityHash, principalId: owner.principalId,
        principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion, workspace: owner.workspace, agentPreset: owner.agentPreset },
      itemId: source.itemId, canonical: { outcomeId: source.outcomeId, version: source.projection.version,
        digest: source.projection.digest, objectiveStatus: 'not-achieved' }, createdAt: intent.createdAt, expiresAt: intent.expiresAt }
  }
  private withWorkItemSource<T>(intent: WorkItemUsageIntent, callback: (source: Readonly<OwnerWorkItemEngineeringContextSource>) => T): T {
    this.abort.signal.throwIfAborted(); this.currentWorkItem(this.locatorFor(intent))
    if (!same(intent.authorities, this.config.usageLearning.workItemAuthorities)) throw new WorkItemSourceObsolete('work item authority pins changed')
    const fence = this.ports.delivery.withOwnerWorkItemEngineeringContextFence
    if (!fence) throw new WorkItemSourcePending('work item engineering fence unavailable')
    return fence.call(this.ports.delivery, this.expectation(intent.source), source => {
      this.abort.signal.throwIfAborted()
      if (!this.active || intent.configDigest !== this.configDigest || Date.now() >= Math.min(intent.expiresAt, workItemAuthorityDeadline(intent.authorities))) throw new WorkItemSourceObsolete('work item usage lifecycle or authority expired')
      if (!same(workItemRunSource({ ...intent.source, ...source }), workItemRunSource(intent.source))
        || !isSourceOwnerContinuation(source.task.owner, intent.source.task.owner)
        || !same({ ...source.task, owner: intent.source.task.owner, canonical: intent.source.task.canonical }, intent.source.task)
        || !same(source.manifest, intent.source.manifest) || source.objective !== intent.source.objective) throw new WorkItemSourceObsolete('frozen work item engineering source changed')
      return callback(source)
    }) as T
  }
  private readWorkItem(locator: WorkItemUsageLocator): WorkItemUsageSource {
    this.currentWorkItem(locator)
    const inspect = this.ports.delivery.inspectOwnerWorkItemEngineeringContext, read = this.ports.delivery.readOwnerWorkItemEngineeringContext
    if (!inspect || !read) throw new WorkItemSourcePending('work item engineering context reader unavailable')
    const context = inspect.call(this.ports.delivery, { ...this.workItemScope(locator.owner), itemId: locator.itemId, outcomeId: locator.canonical.outcomeId })
    if (!context) throw new WorkItemSourcePending('complete work item context temporarily unreadable')
    let shell: WorkItemUsageSource = { protocol: 'assistant-delivery/work-item-engineering-context/v1', ...context, objective: '', parentReports: [] }
    const expectation = this.expectation(shell)
    const readAll = (selector: { kind: 'objective' } | { kind: 'parent-report'; itemId: string; revision: number }, fullTextDigest: string, fullBytes: number): string => {
      if (!Number.isSafeInteger(fullBytes) || fullBytes < 1 || fullBytes > (selector.kind === 'objective' ? 16_384 : 65_536)) throw new WorkItemSourceObsolete('work item context exceeds complete input bound')
      let offset = 0, text = ''
      for (let pageNumber = 0; pageNumber < 32; pageNumber++) {
        const page = read.call(this.ports.delivery, { ...expectation, selector, offset, maxBytes: 8192 })
        if (!page || page.manifestDigest !== context.manifest.manifestDigest || page.fullTextDigest !== fullTextDigest
          || page.fullBytes !== fullBytes || page.offset !== offset || !page.text.isWellFormed()
          || page.returnedBytes !== Buffer.byteLength(page.text) || page.returnedBytes < 1) throw new WorkItemSourcePending('work item context pagination changed')
        text += page.text; offset += page.returnedBytes
        if (offset > fullBytes || page.nextOffset !== undefined && page.nextOffset !== offset) throw new WorkItemSourceObsolete('invalid work item context pagination')
        if (page.nextOffset === undefined) {
          if (offset !== fullBytes || workItemTextDigest(text) !== fullTextDigest) throw new WorkItemSourceObsolete('work item context was not fully read')
          return text
        }
      }
      throw new WorkItemSourceObsolete('work item context pagination exceeds bound')
    }
    shell = { ...shell, objective: readAll({ kind: 'objective' }, context.manifest.objective.fullTextDigest, context.manifest.objective.fullBytes) }
    let reportBytes = 0
    shell.parentReports = context.manifest.reports.map(report => {
      reportBytes += report.fullBytes
      if (report.truncated || reportBytes > 262_144) throw new WorkItemSourceObsolete('sealed background reports exceed bound')
      return { itemId: report.itemId, revision: report.revision, fullTextDigest: report.fullTextDigest, fullBytes: report.fullBytes,
        text: readAll({ kind: 'parent-report', itemId: report.itemId, revision: report.revision }, report.fullTextDigest, report.fullBytes) }
    })
    workItemRunSource(shell); return freezeWorkItemData(shell)
  }
  private scanWorkItems(owner: ReturnType<UsageLearningRuntime['owner']>, scope: ReturnType<Evaluation['canonicalHostScope']>): void {
    for (let pageNumber = 0, stopped = false; pageNumber < 10 && !stopped; pageNumber++) {
      const after = this.store.workItemCursor(this.lane)
      const page = this.ports.evaluation.listTrustedTaskLearningProjections({ scope, ...(after ? { after } : {}), limit: 100 })
      for (const item of page.items) {
        const canonical = item.receipt, now = Date.now(), at = canonical.objective?.occurredAt ?? 0
        const workItem = canonical.projection.subjectKind === 'work-item'
        const eligible = workItem && canonical.projection.disposition === 'upsert' && canonical.objective?.status === 'not-achieved'
          && at <= now && now - at < this.config.usageLearning.lookbackMs
        const locator: WorkItemUsageLocator | undefined = eligible ? { protocol: 'assistant-growth/work-item-usage-locator/v1',
          configDigest: this.configDigest, owner: { authorityId: owner.authorityId, authorityHash: owner.authorityHash,
            principalId: owner.principalId, principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion,
            workspace: owner.workspace, agentPreset: owner.agentPreset }, itemId: canonical.projection.subjectRef,
          canonical: { outcomeId: canonical.objective!.outcomeId, version: canonical.projection.version,
            digest: canonical.projection.digest, objectiveStatus: 'not-achieved' }, createdAt: now, expiresAt: at + this.config.usageLearning.lookbackMs } : undefined
        const staged = this.ports.evaluation.withTrustedCanonicalTaskWriterFence({ scope, scopeWatermark: page.scopeWatermark,
          evidence: [canonical.projection] }, () => this.store.consumeWorkItem({ lane: this.lane, scopeKey: page.nextCursor.scopeKey,
            watermark: item.watermark, ...(workItem ? { itemId: canonical.projection.subjectRef } : {}),
            ...(locator ? { locator } : {}), maxPending: this.config.usageLearning.maxPending }))
        if (!staged.matched || !staged.value) { stopped = true; break }
      }
      if (!page.hasMore) break
    }
    for (const pending of this.store.pendingWorkItems(this.lane)) {
      try {
        this.currentWorkItem(pending.locator)
        const source = this.readWorkItem(pending.locator)
        this.assertWorkItemReadiness(source.task.owner)
        const fixed = this.config.provider !== null && this.config.model !== null
        const intent: WorkItemUsageIntent = { sourceKind: 'work-item', configDigest: this.configDigest, source,
          model: fixed ? { provider: this.config.provider!, model: this.config.model!, ...(this.config.reasoningEffort === null ? {} : { reasoningEffort: this.config.reasoningEffort }) }
            : structuredClone(source.task.proofIdentity.supplier), modelOrigin: fixed ? 'explicit-growth-override' : 'inherited-owner-task',
          budget: { budgetId: this.config.budgetId!, amount: this.config.budgetAmount!, maxModelCalls: this.config.maxModelCalls,
            maxToolCalls: this.config.maxToolCalls, maxOutputTokens: this.config.maxOutputTokens, maxDurationMs: this.config.maxDurationMs,
            maxPlansPerWake: this.config.pluginSourceProposals.maxPlansPerWake }, authorities: this.config.usageLearning.workItemAuthorities!,
          createdAt: pending.locator.createdAt, expiresAt: pending.locator.expiresAt }
        this.withWorkItemSource(intent, () => this.store.freezeWorkItem(pending.id, intent))
      } catch (error) {
        if (error instanceof ScannerOwnerUnavailable) throw error
        if (error instanceof WorkItemSourceObsolete) this.store.abandonWorkItem(pending.id)
        else if (!(error instanceof WorkItemSourcePending)) this.lastError = String(error).slice(0, 200)
      }
    }
  }
  inspectAnySourceGrowthRun = (request: SourceGrowthRunRequest): AnySourceGrowthRunBinding | undefined => {
    if (!this.active) throw new SourceGrowthRunUnavailableError('usage runtime temporarily unavailable')
    const job = this.store.get(request.runId)
    if (!job || !isWorkItemUsageIntent(job.intent)) return this.inspectSourceGrowthRun(request)
    try {
      if (job.digest !== request.intentDigest || !['running', 'reviewed'].includes(job.state) || !job.sourceRun
        || job.sourceRun.protocol !== 'assistant-growth/source-run/v2') return undefined
      this.assertWorkItemReadiness(job.intent.source.task.owner, false)
      return this.withWorkItemSource(job.intent, () => this.store.withWorkItemRunWriter(request, current => {
        if (!current.sourceRun || current.sourceRun.protocol !== 'assistant-growth/source-run/v2') throw new Error('work item run absent')
        this.assertWorkItemBinding(current, current.sourceRun); return freezeWorkItemData(current.sourceRun)
      }))
    } catch (error) {
      if (error instanceof WorkItemSourcePending || error instanceof ScannerOwnerUnavailable) throw new SourceGrowthRunUnavailableError(error.message)
      return undefined
    }
  }
  withWorkItemRunFence = <T>(input: SourceGrowthRunRequest & { expectedGrowthRunDigest: string }, callback: (binding: Readonly<WorkItemSourceGrowthRunBinding>) => T): T => {
    if (!this.active) throw new SourceGrowthRunUnavailableError('usage runtime temporarily unavailable')
    input = ownData(input)
    if (Object.keys(input).sort().join(',') !== 'expectedGrowthRunDigest,intentDigest,runId' || typeof callback !== 'function'
      || typeof input.runId !== 'string' || !input.runId || input.runId.length > 500
      || typeof input.intentDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(input.intentDigest)
      || typeof input.expectedGrowthRunDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(input.expectedGrowthRunDigest)) throw new Error('invalid work item run fence input')
    const job = this.store.get(input.runId)
    if (!job || job.digest !== input.intentDigest || !isWorkItemUsageIntent(job.intent)) throw new Error('work item run not found')
    const intent = job.intent
    this.assertWorkItemReadiness(intent.source.task.owner, false)
    return this.withWorkItemSource(intent, () => this.store.withWorkItemRunWriter(input, current => {
      const binding = current.sourceRun
      if (!binding || binding.protocol !== 'assistant-growth/source-run/v2' || anySourceGrowthRunDigest(binding) !== input.expectedGrowthRunDigest
        || binding.configDigest !== this.configDigest || !same(binding.authorities, this.config.usageLearning.workItemAuthorities)
        || !same(binding.source, workItemRunSource(intent.source))) throw new Error('work item run binding changed')
      this.assertWorkItemBinding(current, binding)
      return callback(freezeWorkItemData(binding))
    }))
  }
  private assertWorkItemBinding(job: UsageJob, binding: WorkItemSourceGrowthRunBinding): void {
    validateAnySourceGrowthRunBinding(binding)
    if (!isWorkItemUsageIntent(job.intent) || binding.runId !== job.id || binding.intentDigest !== job.digest
      || binding.configDigest !== this.configDigest || binding.ownerDigest !== sourceGrowthEvidenceDigest(job.intent.source.task.owner)
      || binding.native.automationId !== job.id || binding.native.definitionHash !== job.definitionHash || binding.native.occurrenceId !== job.occurrenceId
      || !same(binding.source, workItemRunSource(job.intent.source)) || !same(binding.model, job.intent.model)
      || binding.modelOrigin !== job.intent.modelOrigin || !same(binding.budget, job.intent.budget)
      || !same(binding.authorities, job.intent.authorities) || binding.expiresAt !== job.intent.expiresAt) throw new Error('work item persisted run differs from frozen job')
  }
  private async executeWorkItem(input: HostAutomationExecutorInput, queued: UsageJob, result: (outcome: 'succeeded' | 'failed' | 'unknown') => HostAutomationExecutorResult): Promise<HostAutomationExecutorResult> {
    if (!isWorkItemUsageIntent(queued.intent)) throw new Error('work item usage expected')
    const intent = queued.intent
    let claimed = false
    try {
      this.assertWorkItemReadiness(intent.source.task.owner)
      this.withWorkItemSource(intent, () => { this.store.claim(queued.id, input.definitionHash, input.occurrenceId); claimed = true })
      const signal = AbortSignal.any([input.signal, this.abort.signal, AbortSignal.timeout(Math.max(1,
        Math.min(this.config.maxDurationMs, intent.expiresAt - Date.now(), workItemAuthorityDeadline(intent.authorities) - Date.now())))])
      const assertCurrent = () => {
        signal.throwIfAborted()
        // Peer/owner probes can synchronously change source state. Run them
        // before the final complete source frame; its callback is local only.
        this.assertWorkItemReadiness(intent.source.task.owner, false)
        this.withWorkItemSource(intent, () => {
          signal.throwIfAborted()
          const current = this.store.get(queued.id)
          if (current?.state !== 'running' || current.occurrenceId !== input.occurrenceId
            || current.digest !== queued.digest) throw new Error('work item usage no longer owns dispatch')
        })
      }
      const bindSourceRun: WorkItemUsageReviewInput['bindSourceRun'] = actual => {
        assertCurrent(); this.assertWorkItemReadiness(intent.source.task.owner)
        if (!same(actual.model, intent.model) || !same(actual.creationAcceptance, intent.authorities.creationAcceptance)
          || actual.revisionAcceptance !== undefined || actual.revisionRegressionAcceptance !== undefined
          || actual.generationDeadlineAt > workItemAuthorityDeadline(intent.authorities)) throw new Error('work item run setup authority changed')
        const binding: WorkItemSourceGrowthRunBinding = { protocol: 'assistant-growth/source-run/v2', mode: 'create',
          runId: queued.id, intentDigest: queued.digest, configDigest: intent.configDigest, ownerDigest: sourceGrowthEvidenceDigest(intent.source.task.owner),
          source: workItemRunSource(intent.source), model: actual.model, modelOrigin: intent.modelOrigin, budget: intent.budget,
          creationAcceptance: structuredClone(intent.authorities.creationAcceptance), authorities: structuredClone(intent.authorities),
          native: { owner: OWNER, automationId: queued.id, definitionHash: input.definitionHash, occurrenceId: input.occurrenceId },
          sessionId: actual.sessionId, toolContractDigest: actual.toolContractDigest, executionContractDigest: actual.executionContractDigest,
          createdAt: actual.createdAt, generationDeadlineAt: actual.generationDeadlineAt, expiresAt: intent.expiresAt }
        return this.withWorkItemSource(intent, () => this.store.bindWorkItemSourceRun(queued.id, queued.digest, input.definitionHash, input.occurrenceId, binding))
      }
      this.assertWorkItemReadiness(intent.source.task.owner); assertCurrent()
      const outcome = await this.ports.reviewWorkItem!({ sourceKind: 'work-item', id: queued.id, intentDigest: queued.digest,
        definitionHash: input.definitionHash, occurrenceId: input.occurrenceId, expiresAt: Math.min(intent.expiresAt, workItemAuthorityDeadline(intent.authorities)),
        model: intent.model, source: intent.source, signal, assertCurrent, assertFirstModelAdmission: () => { this.assertWorkItemReadiness(intent.source.task.owner); assertCurrent() }, bindSourceRun })
      assertCurrent(); this.store.settle(queued.id, outcome, outcome === 'reviewed' ? 'review-complete-not-adopted' : 'review-incomplete', input.occurrenceId)
      return result(outcome === 'reviewed' ? 'succeeded' : outcome)
    } catch {
      if (claimed) this.store.settle(queued.id, 'unknown', 'interrupted-after-dispatch', input.occurrenceId)
      return result(claimed ? 'unknown' : 'failed')
    }
  }

  /** Synchronous nudge, bounded to 1000 heads. Native scan resumes the cursor. */
  scan = (): void => {
    if (!this.active || this.scanning) return
    this.scanning = true
    try {
      const owner = this.initializeScanner()
      for (const job of this.store.pending(this.lane)) if (job.state === 'queued') {
        try { if (isWorkItemUsageIntent(job.intent)) { this.withWorkItemSource(job.intent, () => undefined); this.schedule(job) } else { this.source(job); this.schedule(job) } }
        catch (error) { if (isWorkItemUsageIntent(job.intent)) { if (error instanceof WorkItemSourceObsolete) this.store.settle(job.id, 'superseded', error.message); continue };
          if (error instanceof ScannerOwnerUnavailable) throw error; this.store.settle(job.id, 'failed', 'queued-source-or-schedule-unavailable') }
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
          const fixedModel = this.config.provider !== null && this.config.model !== null
          const model = fixedModel
            ? { provider: this.config.provider, model: this.config.model,
              ...(this.config.reasoningEffort === null ? {} : { reasoningEffort: this.config.reasoningEffort }) }
            : source?.source.modelSelection
          const now = Date.now()
          const occurredAt = canonical.objective?.occurredAt ?? 0
          const eligible = source !== undefined && source.source.quiescent && !source.source.truncated
            && canonical.projection.disposition === 'upsert' && source.judgement !== 'unresolved'
            && occurredAt <= now && now - occurredAt <= this.config.usageLearning.lookbackMs && model !== undefined
          const intent: ForegroundUsageIntent | undefined = eligible ? { configDigest: this.configDigest, source: source!, model: model!,
            modelOrigin: fixedModel ? 'explicit-growth-override' : 'inherited-owner-task',
            budget: { budgetId: this.config.budgetId!, amount: this.config.budgetAmount!,
              maxModelCalls: this.config.maxModelCalls, maxToolCalls: this.config.maxToolCalls,
              maxOutputTokens: this.config.maxOutputTokens, maxDurationMs: this.config.maxDurationMs,
              maxPlansPerWake: this.config.pluginSourceProposals.maxPlansPerWake },
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
      if (this.config.usageLearning.workItemFailures) this.scanWorkItems(owner, scope)
      for (const job of this.store.pending(this.lane)) if (job.state === 'queued') {
        if (isWorkItemUsageIntent(job.intent)) { try { this.schedule(job) } catch (error) { if (error instanceof WorkItemSourceObsolete) this.store.settle(job.id, 'superseded', error.message) }; continue }
        try { this.schedule(job) } catch (error) { if (error instanceof ScannerOwnerUnavailable) throw error; this.store.settle(job.id, 'failed', 'schedule-rejected') }
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
    if (isWorkItemUsageIntent(job.intent)) {
      this.assertWorkItemReadiness(job.intent.source.task.owner)
      this.withWorkItemSource(job.intent, () => undefined)
    } else this.source(job)
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
    if (isWorkItemUsageIntent(job.intent)) { this.assertWorkItemReadiness(job.intent.source.task.owner); this.withWorkItemSource(job.intent, () => undefined) }
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
      if (isWorkItemUsageIntent(queued.intent)) return await this.executeWorkItem(input, queued, result)
      this.source(queued)
      claimed = this.store.claim(queued.id, input.definitionHash, input.occurrenceId)
      const job = claimed
      if (isWorkItemUsageIntent(job.intent)) throw new Error('foreground usage claim required')
      const signal = AbortSignal.any([input.signal, this.abort.signal,
        AbortSignal.timeout(Math.max(1, Math.min(this.config.maxDurationMs, job.intent.expiresAt - Date.now())))])
      const assertCurrent = (): void => {
        signal.throwIfAborted(); this.source(job)
        const stored = this.store.get(job.id)
        if (stored?.state !== 'running' || stored.occurrenceId !== input.occurrenceId) throw new Error('usage dispatch no longer owned')
      }
      assertCurrent()
      const bindSourceRun: UsageReviewInput['bindSourceRun'] = actual => {
        assertCurrent()
        if (actual.creationAcceptance !== undefined) {
          const current = this.ports.inspectCreationAcceptanceAuthority?.()
          if (current === undefined || current.expiresAt <= Date.now() || !same(actual.creationAcceptance, current)) {
            throw new Error('usage creation acceptance authority changed during Agent setup')
          }
        }
        if (actual.revisionAcceptance !== undefined) {
          const current = this.ports.inspectRevisionAcceptanceAuthority?.()
          if (current === undefined || current.expiresAt <= Date.now() || !same(actual.revisionAcceptance, current)) {
            throw new Error('usage revision acceptance authority changed during Agent setup')
          }
        }
        if (actual.revisionRegressionAcceptance !== undefined) {
          const current = this.ports.inspectRevisionRegressionAcceptanceAuthority?.()
          if (current === undefined || current.expiresAt <= Date.now() || !same(actual.revisionRegressionAcceptance, current)) {
            throw new Error('usage revision regression acceptance authority changed during Agent setup')
          }
        }
        if (!job.intent.modelOrigin || !job.intent.budget || !same(actual.model, job.intent.model)) {
          throw new Error('usage source run lacks a frozen model or budget')
        }
        const source = this.source(job)
        const projection = source.canonical.projection
        if (projection.subjectKind !== 'foreground-turn' || projection.disposition !== 'upsert') throw new Error('usage source projection is not current')
        const binding: SourceGrowthRunBinding = {
          protocol: 'assistant-growth/source-run/v1', runId: job.id, intentDigest: job.digest,
          configDigest: job.intent.configDigest, ownerDigest: sourceGrowthEvidenceDigest(source.owner),
          source: { outcomeId: source.canonical.triggerOutcomeId,
            projection: { subjectKind: 'foreground-turn', subjectRef: projection.subjectRef, version: projection.version,
              digest: projection.digest, disposition: 'upsert',
              ...(projection.evidenceOutcomeId === undefined ? {} : { evidenceOutcomeId: projection.evidenceOutcomeId }) },
            sourceDigest: sourceGrowthEvidenceDigest({ protocol: source.protocol, source: source.source,
              judgement: source.judgement, ownerRevision: source.ownerRevision }) },
          model: actual.model, modelOrigin: job.intent.modelOrigin, budget: job.intent.budget,
          ...(actual.creationAcceptance === undefined ? {} : { creationAcceptance: structuredClone(actual.creationAcceptance) }),
          ...(actual.revisionAcceptance === undefined ? {} : { revisionAcceptance: structuredClone(actual.revisionAcceptance) }),
          ...(actual.revisionRegressionAcceptance === undefined ? {} : { revisionRegressionAcceptance: structuredClone(actual.revisionRegressionAcceptance) }),
          native: { owner: 'assistant-growth-usage', automationId: job.id,
            definitionHash: input.definitionHash, occurrenceId: input.occurrenceId },
          sessionId: actual.sessionId, toolContractDigest: actual.toolContractDigest,
          executionContractDigest: actual.executionContractDigest, createdAt: actual.createdAt,
          generationDeadlineAt: actual.generationDeadlineAt, expiresAt: job.intent.expiresAt,
        }
        sourceGrowthRunDigest(binding)
        return this.store.bindSourceRun(job.id, job.digest, input.definitionHash, input.occurrenceId, binding)
      }
      const outcome = await this.ports.review({ id: job.id, intentDigest: job.digest,
        definitionHash: input.definitionHash, occurrenceId: input.occurrenceId, expiresAt: job.intent.expiresAt,
        model: job.intent.model, source: job.intent.source, signal, assertCurrent, bindSourceRun })
      assertCurrent()
      this.store.settle(job.id, outcome, outcome === 'reviewed' ? 'review-complete-not-adopted' : 'review-incomplete', input.occurrenceId)
      return result(outcome === 'reviewed' ? 'succeeded' : outcome)
    } catch {
      if (claimed) this.store.settle(claimed.id, 'unknown', 'interrupted-after-dispatch', input.occurrenceId)
      return result(claimed ? 'unknown' : 'failed')
    } finally { if (this.active) this.scan() }
  }
}
