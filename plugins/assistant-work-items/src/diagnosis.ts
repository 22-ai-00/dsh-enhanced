import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { HostAutomationExecutorInput, HostAutomationExecutorResult } from '@dsh-enhanced/assistant-automations'
import type { NormalizedConfig } from './config.js'
import type { PeerAutomationsService, PeerDeliveryService, PeerForegroundSourceScope, PeerOwnerRouteReceipt } from './peers.js'
import type { WorkItemAdmission } from './admission.js'
import type { WorkItemDispatch } from './dispatch.js'
import type { WorkItemStore } from './store.js'
import type { WorkItemAdmitInput, WorkItemAdmitResult, WorkItemRecord, WorkItemReportStatus } from './types.js'
import { OPEN_STATES } from './types.js'
import type { WorkItemSignalSourceReport, WorkItemSignalSweepReport } from './signals.js'
import {
  assertDiagnosisSource, canonicalDiagnosis, createDiagnosisPlan, diagnosisConfigurationDigest, diagnosisDefinition,
  diagnosisDefinitionHash, diagnosisExternalId, diagnosisFail, diagnosisToolDigest, parseDiagnosisActivation,
  DIAGNOSIS_EXECUTOR, DIAGNOSIS_OWNER, DIAGNOSIS_PROMPT_VERSION, DIAGNOSIS_SOURCE, DIAGNOSIS_TOOLS,
  type DiagnosisActivation, type WorkItemDiagnosisPlan,
} from './diagnosis-contract.js'

const ACTIVATION_KEY = 'diagnosis.activation/v1'
const CURSOR_KEY = `signal.cursor:${DIAGNOSIS_SOURCE}`
const SWEPT_KEY = `signal.sweptAt:${DIAGNOSIS_SOURCE}`
interface Run {
  readonly input: HostAutomationExecutorInput
  readonly itemId: string
  readonly plan: WorkItemDiagnosisPlan
  readonly generation: number
  readonly controller: AbortController
  phase: 'before-claim' | 'claimed' | 'reported'
  reportRevision?: number
  reportStatus?: WorkItemReportStatus
}
export interface DiagnosisHooks {
  /** This closure alone holds the private admission mint, never a public service method. */
  readonly admit: (input: WorkItemAdmitInput, plan: (item: WorkItemRecord) => Readonly<WorkItemDiagnosisPlan>) => WorkItemAdmitResult
  readonly assertOwner: (item: WorkItemRecord) => Readonly<PeerOwnerRouteReceipt>
  readonly assertMandate: (item: WorkItemRecord) => void
}
export function persistedDiagnosisIntervention(store: WorkItemStore, unprovenReports = false): boolean {
  try {
    if (store.diagnosisInterventionItems(1).length > 0) return true
    // An unavailable runtime cannot prove an outer success receipt. A report is
    // not completion: a crash may precede the durable unknown event.
    if (unprovenReports) {
      const report = store.latestWorkerDiagnosisReport()
      if (report && !store.diagnosisExplicitlyDisposed(report.itemId)) return true
    }
    return store.listItems({ states: OPEN_STATES, limit: 100 }).some(item => {
      try {
        const dispatch = store.getDispatch(item.id)
        return !store.readDiagnosisPlan(item.id) || dispatch?.state === 'failed' && dispatch.reason === 'unknown_after_send'
          || unprovenReports && dispatch?.state === 'dispatched'
          || item.attempt > 0 && item.lastReportStatus !== 'waiting' && (item.leaseUntil === null || item.leaseUntil <= Date.now())
      } catch { return true }
    })
  } catch { return true }
}

export interface DiagnosisSourcePage {
  readonly itemId: string
  readonly text: string
  readonly offset: number
  readonly nextOffset: number | null
  readonly fullBytes: number
  readonly returnedBytes: number
  readonly fullTextDigest: string
  readonly sourceDigest: string
}
/** Consumer-owned Host adapter. Every Agent is still created and driven by Automations. */
export class WorkItemDiagnosis {
  readonly #controller = new AbortController()
  readonly #runs = new Map<string, Run>()
  #activation: Readonly<DiagnosisActivation> | undefined
  #remove: (() => void) | undefined
  #closed = false
  #sweeping = false
  #lastError: string | null = null
  constructor(readonly context: Context, readonly config: NormalizedConfig, readonly store: WorkItemStore,
    readonly admission: WorkItemAdmission, readonly dispatch: WorkItemDispatch, readonly hooks: DiagnosisHooks) {}
  private automations(): PeerAutomationsService {
    if (this.#closed || this.#controller.signal.aborted) diagnosisFail('diagnosis consumer is disposed')
    const peer = this.context.get('assistantAutomations' as never) as PeerAutomationsService | undefined
    if (!peer || peer.hostAgentAuthorizationVersion?.() !== 1 || typeof peer.runAgentForHostExecution !== 'function'
      || typeof peer.registerHostExecutor !== 'function' || typeof peer.reconcileSystem !== 'function'
      || typeof peer.inspectSystemOwned !== 'function' || typeof peer.inspectSystemOwnedActivation !== 'function') diagnosisFail('diagnosis requires the fenced Host Agent execution peer')
    return peer
  }
  private delivery(): PeerDeliveryService {
    const peer = this.context.get('assistantDelivery' as never) as PeerDeliveryService | undefined
    if (!peer || typeof peer.listOwnerForegroundTaskSources !== 'function' || typeof peer.inspectOwnerForegroundTaskSource !== 'function'
      || typeof peer.readOwnerForegroundTaskInput !== 'function') diagnosisFail('diagnosis source peer is unavailable')
    return peer
  }
  private schemas(): readonly { name: string }[] {
    const schemas = this.context.tools.schemas().filter(schema => DIAGNOSIS_TOOLS.includes(schema.name))
    diagnosisToolDigest(schemas)
    return JSON.parse(acceptanceCanonicalJson(schemas)) as readonly { name: string }[]
  }
  private owner(): Readonly<PeerOwnerRouteReceipt> {
    const scope = this.config.scope
    if (!scope || !this.config.diagnosis || Date.now() >= Math.min(scope.expiresAt, this.config.diagnosis.expiresAt)) diagnosisFail('diagnosis authorization expired')
    const receipt = this.delivery().validateOwnerRoute({ authorityId: scope.ownerRouteId, principalId: scope.principalId,
      workspace: scope.workspace, agentPreset: scope.preset })
    if (receipt.receiptVersion !== 2 || receipt.authorityId !== scope.ownerRouteId || receipt.principalId !== scope.principalId
      || receipt.workspace !== scope.workspace || receipt.agentPreset !== scope.preset) diagnosisFail('diagnosis owner receipt differs')
    return receipt
  }
  private sourceScope(receipt: PeerOwnerRouteReceipt): PeerForegroundSourceScope {
    const scope = this.config.scope!
    return { authorityId: scope.ownerRouteId, principalId: scope.principalId, workspace: scope.workspace, agentPreset: scope.preset,
      expectedOwner: { authorityHash: receipt.authorityHash, principalRecordId: receipt.principalRecordId, principalVersion: receipt.principalVersion } }
  }
  start(): void {
    const config = this.config, scope = config.scope, diagnosis = config.diagnosis
    if (!diagnosis || !scope || config.mode !== 'active' || !config.enabled) diagnosisFail('diagnosis requires explicit active configuration')
    const peer = this.automations(), receipt = this.owner(), schemas = this.schemas()
    const policy = this.context.get('assistantPolicy' as never) as { authorize: (request: unknown, options: unknown) => { effect: string } } | undefined
    if (policy?.authorize({ subject: { kind: 'background', id: config.intakeSourceId, workspace: scope.workspace, principal: scope.principalId },
      action: 'admit', resource: { kind: 'automation', id: config.workerAutomationId! }, context: { initiator: 'background' } },
    { idempotencyKey: `diagnosis-activation-admit:${config.intakeSourceId}:${config.workerAutomationId}` }).effect !== 'allow') diagnosisFail('diagnosis activation admission is denied')
    const configurationDigest = diagnosisConfigurationDigest(config, schemas)
    const catalogDigest = acceptanceDigest({ protocol: DIAGNOSIS_PROMPT_VERSION, toolSchemaDigest: diagnosisToolDigest(schemas) })
    const prior = this.store.readCanonicalMeta(ACTIVATION_KEY)
    let activation: Readonly<DiagnosisActivation>
    if (prior === undefined) {
      const nonce = randomBytes(32).toString('hex'), definition = diagnosisDefinition(config, nonce, catalogDigest)
      activation = Object.freeze({ protocol: 'assistant-work-items/diagnosis-activation/v1', stage: 'pending', configurationDigest,
        activationNonce: nonce, reconciliationKey: `diagnosis-${acceptanceDigest({ configurationDigest, nonce })}`,
        definitionHash: diagnosisDefinitionHash(definition), definitionVersion: 1, catalogDigest, ownerReceipt: receipt })
      this.store.setMeta(ACTIVATION_KEY, canonicalDiagnosis(activation))
    } else activation = parseDiagnosisActivation(prior)
    if (activation.configurationDigest !== configurationDigest || activation.catalogDigest !== catalogDigest
      || acceptanceCanonicalJson(activation.ownerReceipt) !== acceptanceCanonicalJson(receipt)
      || activation.definitionHash !== diagnosisDefinitionHash(diagnosisDefinition(config, activation.activationNonce, catalogDigest))) diagnosisFail('diagnosis activation configuration or owner changed')
    this.#activation = activation
    this.#remove = peer.registerHostExecutor!({ descriptor: { executorId: DIAGNOSIS_EXECUTOR, contractVersion: 1, catalogDigest },
      accepts: spec => !this.#closed && spec.kind === 'host' && spec.executorId === DIAGNOSIS_EXECUTOR
        && spec.executorContractVersion === 1 && spec.runbookId === 'foreground-diagnosis' && spec.runbookVersion === 1
        && spec.catalogDigest === catalogDigest && spec.activationNonce === activation.activationNonce
        && spec.ownerRouteId === scope.ownerRouteId && spec.targetScope.workspace === scope.workspace && spec.targetScope.preset === scope.preset,
      execute: input => this.execute(input),
    })
    if (activation.stage === 'pending') {
      let present = false
      try { peer.inspectSystemOwned!({ owner: DIAGNOSIS_OWNER, automationId: config.workerAutomationId! }); present = true }
      catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'not-found')) throw error }
      if (!present) peer.reconcileSystem!({ owner: DIAGNOSIS_OWNER, automationId: config.workerAutomationId!,
        idempotencyKey: activation.reconciliationKey, definition: diagnosisDefinition(config, activation.activationNonce, catalogDigest), desiredStatus: 'active' })
      this.assertActivation(activation)
      activation = Object.freeze({ ...activation, stage: 'established' })
      this.store.setMeta(ACTIVATION_KEY, canonicalDiagnosis(activation))
      this.#activation = activation
    } else this.assertActivation(activation)
    this.wakePending()
  }
  private assertActivation(expected = this.#activation): Readonly<DiagnosisActivation> {
    if (!expected) diagnosisFail('diagnosis activation is unavailable')
    const peer = this.automations(), receipt = this.owner()
    const current = parseDiagnosisActivation(this.store.readCanonicalMeta(ACTIVATION_KEY))
    if (acceptanceCanonicalJson(current) !== acceptanceCanonicalJson(expected)
      || current.configurationDigest !== diagnosisConfigurationDigest(this.config, this.schemas())
      || acceptanceCanonicalJson(current.ownerReceipt) !== acceptanceCanonicalJson(receipt)) diagnosisFail('diagnosis activation receipt changed')
    const input = { owner: DIAGNOSIS_OWNER, automationId: this.config.workerAutomationId! }
    const state = peer.inspectSystemOwned!(input), binding = peer.inspectSystemOwnedActivation!(input)
    if (state.owner !== DIAGNOSIS_OWNER || state.automationId !== input.automationId || state.automationStatus !== 'active'
      || state.definitionHash !== current.definitionHash || state.definitionVersion !== current.definitionVersion
      || !binding || binding.definitionHash !== current.definitionHash || binding.activationNonce !== current.activationNonce
      || binding.ownerRouteId !== this.config.scope!.ownerRouteId) diagnosisFail('diagnosis worker is paused, missing or changed')
    return current
  }
  private currentPlan(item: WorkItemRecord): Readonly<WorkItemDiagnosisPlan> {
    const plan = this.store.readDiagnosisPlan(item.id)
    if (!plan) diagnosisFail('diagnosis item has no original frozen plan')
    const activation = this.assertActivation(), receipt = this.hooks.assertOwner(item)
    this.hooks.assertMandate(item)
    const source = this.delivery().inspectOwnerForegroundTaskSource!({ ...this.sourceScope(receipt), inboxId: plan.source.inboxId })
    if (!source || source.sourceDigest !== plan.source.sourceDigest) diagnosisFail('diagnosis source was withdrawn or changed')
    assertDiagnosisSource(source, this.config, receipt)
    const expected = createDiagnosisPlan(item, source, this.config, activation, this.schemas())
    if (acceptanceCanonicalJson(plan) !== acceptanceCanonicalJson(expected)) diagnosisFail('diagnosis frozen execution contract differs')
    return plan
  }
  private outerSucceeded(binding: { itemId: string; revision: number; status: string; occurrenceId: string }): boolean {
    const activation = this.#activation
    if (!activation) return false
    const state = this.automations().inspectSystemOwned!({ owner: DIAGNOSIS_OWNER, automationId: this.config.workerAutomationId! })
    const run = state.latestTerminalRuns?.production, scope = this.config.scope!
    return !!run && run.occurrenceId === binding.occurrenceId && run.executionMode === 'production' && run.status === 'succeeded'
      && run.diagnostic.budgetSettlementState === 'finalized' && run.immutableContext.state === 'verified'
      && run.immutableContext.definitionHash === activation.definitionHash && run.immutableContext.definitionVersion === activation.definitionVersion
      && run.immutableContext.scope.workspace === scope.workspace && run.immutableContext.scope.agentPreset === scope.preset
  }
  private previousReportSettled(): boolean {
    const binding = this.store.latestWorkerDiagnosisReport(this.config.workerAutomationId!)
    return !binding || this.store.diagnosisExplicitlyDisposed(binding.itemId) || this.outerSucceeded(binding)
  }
  validateWake(item: WorkItemRecord): boolean {
    try {
      if (this.#runs.size > 0 || this.store.diagnosisInterventionPending(item.id)) return false
      this.currentPlan(item)
      const dispatch = this.store.getDispatch(item.id)
      return !!dispatch && dispatch.state === 'pending' && !item.observed
        && (item.attempt === 0 && dispatch.generation === 0 && item.state === 'queued'
          || item.state === 'waiting' && item.lastReportStatus === 'waiting' && dispatch.reason === 'waiting-resume' && item.attempt < item.maxAttempts
            && this.outerSucceeded(this.store.diagnosisReportOccurrence(item.id, this.store.reports(item.id).at(-1)!.revision)))
    } catch { return false }
  }
  wakePending(): void {
    for (const dispatch of this.store.listOpenDispatches(10)) {
      const item = this.store.findItemById(dispatch.itemId)
      if (item && this.validateWake(item)) this.dispatch.wake(item)
    }
  }
  private assertRun(run: Run): WorkItemRecord {
    if (this.#closed || this.#controller.signal.aborted || run.input.signal.aborted || run.controller.signal.aborted || this.#runs.get(run.input.occurrenceId) !== run) diagnosisFail('diagnosis invocation was revoked')
    const item = this.store.findItemById(run.itemId)
    if (!item || item.observed || ['dropped', 'observed'].includes(item.state)) diagnosisFail('diagnosis item was retired')
    const plan = this.currentPlan(item), dispatch = this.store.getDispatch(item.id)
    if (plan.digest !== run.plan.digest || !dispatch || dispatch.occurrenceId !== run.input.occurrenceId
      && !(run.phase === 'reported' && dispatch.state === 'pending' && dispatch.reason === 'waiting-resume' && dispatch.generation === run.generation + 1)) diagnosisFail('diagnosis occurrence or dispatch changed')
    const claim = this.store.activeClaim(item.id), now = Date.now()
    if (run.phase === 'before-claim') {
      if (claim && claim.runId === run.input.occurrenceId && claim.leasedUntil > now) run.phase = 'claimed'
      else if (!['queued', 'waiting'].includes(item.state) || claim && claim.leasedUntil > now) diagnosisFail('diagnosis is not eligible before claim')
    }
    if (run.phase === 'claimed' && (!claim || claim.runId !== run.input.occurrenceId || claim.leasedUntil <= now
      || item.leaseRunId !== run.input.occurrenceId || item.leaseUntil === null || item.leaseUntil <= now)) diagnosisFail('diagnosis claim expired or changed')
    if (run.phase === 'reported') {
      const latest = this.store.reports(item.id).at(-1)
      if (!latest || latest.revision !== run.reportRevision || latest.status !== run.reportStatus
        || item.lastReportStatus !== run.reportStatus || !['waiting', 'ready', 'blocked', 'failed'].includes(item.state)
        || claim && claim.leasedUntil > now) diagnosisFail('diagnosis final summary no longer owns its report')
    }
    return item
  }
  assertTool(occurrenceId: string, name: string): void {
    const run = this.#runs.get(occurrenceId)
    if (!run) diagnosisFail('diagnosis tools require the live Host invocation')
    this.assertRun(run)
    if (run.phase === 'reported' && !['work_item_status', 'work_item_read_report'].includes(name)) diagnosisFail('diagnosis report ended this attempt')
    if (name === 'work_item_read_source' && run.phase !== 'claimed') diagnosisFail('diagnosis source reading requires an active claim')
  }
  retire(itemIds: readonly string[]): void {
    for (const run of this.#runs.values()) if (itemIds.includes(run.itemId)) run.controller.abort('diagnosis-withdrawn')
  }
  reported(occurrenceId: string, status: WorkItemReportStatus, revision: number): void {
    const run = this.#runs.get(occurrenceId)
    if (!run || status === 'progress') return
    run.phase = 'reported'; run.reportRevision = revision; run.reportStatus = status
  }
  readSource(occurrenceId: string, input: { offset?: number; maxBytes?: number }): DiagnosisSourcePage {
    this.assertTool(occurrenceId, 'work_item_read_source')
    const run = this.#runs.get(occurrenceId)!, item = this.assertRun(run), receipt = this.hooks.assertOwner(item)
    const page = this.delivery().readOwnerForegroundTaskInput!({ ...this.sourceScope(receipt), inboxId: run.plan.source.inboxId,
      expectedSourceDigest: run.plan.source.sourceDigest, ...input })
    if (!page || page.sourceDigest !== run.plan.source.sourceDigest) diagnosisFail('diagnosis original input is unavailable')
    return Object.freeze({ itemId: item.id, ...page.input, sourceDigest: page.sourceDigest, nextOffset: page.input.nextOffset ?? null })
  }
  private async execute(input: HostAutomationExecutorInput): Promise<HostAutomationExecutorResult> {
    let started = false, run: Run | undefined, itemId: string | undefined
    try {
      const activation = this.assertActivation(), scope = this.config.scope!
      const item = this.store.findItemByOccurrence(input.occurrenceId), dispatch = item && this.store.getDispatch(item.id)
      itemId = item?.id
      if (this.store.diagnosisInterventionItems(1).length > 0) diagnosisFail('diagnosis awaits explicit intervention')
      if (!item || !dispatch || !['queued', 'waiting'].includes(item.state) || item.observed
        || input.executionMode !== 'production' || input.automationId !== this.config.workerAutomationId
        || input.definitionHash !== activation.definitionHash || input.activationNonce !== activation.activationNonce
        || input.catalogDigest !== activation.catalogDigest || input.ownerRouteId !== scope.ownerRouteId || input.principal !== scope.principalId
        || input.targetScope.workspace !== scope.workspace || input.targetScope.preset !== scope.preset
        || this.#runs.has(input.occurrenceId)) diagnosisFail('diagnosis Host execution identity differs')
      if (item.state === 'waiting' && (item.lastReportStatus !== 'waiting'
        || !this.outerSucceeded(this.store.diagnosisReportOccurrence(item.id, this.store.reports(item.id).at(-1)!.revision)))) diagnosisFail('previous diagnosis occurrence has no exact finalized success')
      const plan = this.currentPlan(item)
      run = { input, itemId: item.id, plan, generation: dispatch.generation, phase: 'before-claim', controller: new AbortController() }
      this.#runs.set(input.occurrenceId, run)
      this.assertRun(run)
      started = true
      const result = await this.automations().runAgentForHostExecution!(input, plan.contract,
        { signal: AbortSignal.any([this.#controller.signal, run.controller.signal]), assertCurrent: () => { this.assertRun(run!) } })
      if (result.outcome === 'succeeded' && result.quiescent === true && run.phase === 'reported') return {
        outcome: 'succeeded', failureClass: 'none', failurePhase: 'none', failureCode: 'none', sideEffectState: 'none', retryability: 'safe',
      }
      this.store.appendEvent(item.id, 'diagnosis-unknown', 'diagnosis-runtime', { occurrenceId: input.occurrenceId,
        reason: result.quiescent !== true ? 'teardown-unconfirmed' : run.phase !== 'reported' ? 'report-missing' : 'agent-unsuccessful' })
      this.#lastError = 'diagnosis-awaits-intervention'
      return { outcome: result.quiescent === true && result.outcome !== 'unknown' ? 'failed' : 'unknown', failureClass: 'execution',
        failurePhase: 'host-execution', failureCode: 'diagnosis-agent-incomplete', sideEffectState: 'unknown', retryability: 'unsafe' }
    } catch {
      this.#lastError = started ? 'diagnosis-awaits-intervention' : 'diagnosis-execution-refused'
      if (itemId && !started) this.store.appendEvent(itemId, 'diagnosis-refused', 'diagnosis-runtime', { occurrenceId: input.occurrenceId })
      if (run && started) this.store.appendEvent(run.itemId, 'diagnosis-unknown', 'diagnosis-runtime', { occurrenceId: input.occurrenceId, reason: 'execution-interrupted' })
      return started ? { outcome: 'unknown', failureClass: 'unknown', failurePhase: 'host-execution', failureCode: 'diagnosis-execution-unknown', sideEffectState: 'unknown', retryability: 'unsafe' }
        : { outcome: 'failed', failureClass: 'policy', failurePhase: 'preflight', failureCode: 'diagnosis-execution-refused', sideEffectState: 'none', retryability: 'after-intervention' }
    } finally { if (run && this.#runs.get(input.occurrenceId) === run) this.#runs.delete(input.occurrenceId) }
  }
  sweep(force = false): WorkItemSignalSweepReport {
    const report: { -readonly [K in keyof WorkItemSignalSourceReport]: WorkItemSignalSourceReport[K] } = {
      source: DIAGNOSIS_SOURCE, skipped: null, degraded: null, scanned: 0, admitted: 0, duplicates: 0, fenced: 0, withdrawn: 0, retired: 0, rejected: 0, failed: false,
    }
    if (this.#sweeping || this.#closed) return { sources: [{ ...report, skipped: 'disabled' }] }
    const now = Date.now(), config = this.config.sources.foregroundFailures
    // A single Host definition uses queue-one. Never enqueue a second item that its coalescer could silently skip.
    if (this.#runs.size > 0 || this.store.countOpenItems() > 0 || this.store.diagnosisInterventionItems(1).length > 0) return { sources: [{ ...report, skipped: 'not-due' }] }
    const last = Number(this.store.meta(SWEPT_KEY))
    if (!force && Number.isFinite(last) && last > 0 && now - last < config.sweepIntervalMs) return { sources: [{ ...report, skipped: 'not-due' }] }
    this.#sweeping = true
    this.store.setMeta(SWEPT_KEY, String(now))
    try {
      const activation = this.assertActivation()
      if (!this.previousReportSettled()) { report.skipped = 'not-due'; return { sources: [Object.freeze(report)] } }
      const receipt = this.owner(), raw = this.store.meta(CURSOR_KEY)
      const cursor: unknown = raw ? JSON.parse(raw) : undefined
      const page = this.delivery().listOwnerForegroundTaskSources!({ ...this.sourceScope(receipt), ...(cursor === undefined ? {} : { after: cursor }), limit: config.maxCandidatesPerSweep })
      let consumedCursor: unknown = cursor
      let complete = true
      for (const source of page.items) {
        report.scanned += 1
        let eligible = true
        try { assertDiagnosisSource(source, this.config, receipt, true) } catch { eligible = false }
        if (eligible) {
          const input: WorkItemAdmitInput = { kind: config.kind, externalId: diagnosisExternalId(source), title: 'Diagnose an interrupted owner request',
            brief: 'Read-only diagnosis of the original owner task. Its external effects remain unknown. Read the bounded source with work_item_read_source; do not replay the original operation.',
            originBindingId: source.binding.id, provenance: { source: DIAGNOSIS_SOURCE, sourceVersion: 'assistant-delivery/foreground-termination/v1',
              signalDigest: `sha256:${source.sourceDigest}`, observedAt: now, evidence: { inboxId: source.inboxId, completionSequence: source.completionSequence,
                authorityHash: source.authorityHash, bindingVersion: source.binding.version, completedAt: source.execution.completedAt } } }
          if (source.termination!.kind === 'owner-cancelled') {
            const result = this.admission.withdraw(input); report.withdrawn += 1; report.retired += result.outcome === 'withdrawn' ? result.items.length : 0
          } else {
            try {
              const result = this.hooks.admit(input, item => {
                const current = this.delivery().inspectOwnerForegroundTaskSource!({ ...this.sourceScope(receipt), inboxId: source.inboxId })
                if (!current || current.sourceDigest !== source.sourceDigest) diagnosisFail('diagnosis source changed before admission')
                assertDiagnosisSource(current, this.config, receipt)
                return createDiagnosisPlan(item, current, this.config, this.assertActivation(activation), this.schemas())
              })
              if (result.created) report.admitted += 1
              else if (result.reason === 'fenced') report.fenced += 1
              else report.duplicates += 1
              if (this.validateWake(result.item)) this.dispatch.wake(result.item)
            } catch { report.rejected += 1; complete = false; break }
          }
        }
        // Keep the actual Delivery cursor namespace and stop at the consumed row, not the end of its page.
        if (page.nextCursor && typeof page.nextCursor === 'object') consumedCursor = { ...page.nextCursor, sequence: source.completionSequence }
        if (this.store.countOpenItems() > 0 || report.admitted >= config.maxAdmitsPerSweep) { complete = false; break }
      }
      const next = complete ? page.nextCursor : consumedCursor
      this.store.setMeta(CURSOR_KEY, next === undefined ? '' : JSON.stringify(next))
    } catch {
      this.#lastError = 'diagnosis-source-unavailable'; report.failed = true
      this.store.setMeta(CURSOR_KEY, '')
    } finally { this.#sweeping = false }
    return { sources: [Object.freeze(report)] }
  }
  health(): Readonly<{ enabled: true; ready: boolean; running: number; lastError: string | null; interventionRequired: boolean }> {
    let ready = !this.#closed && this.#activation?.stage === 'established'
    if (ready) { try { this.assertActivation() } catch { ready = false } }
    const persisted = persistedDiagnosisIntervention(this.store)
    let unproven = false
    if (this.#runs.size === 0) {
      try {
        unproven = !this.previousReportSettled() || this.store.listItems({ states: OPEN_STATES, limit: 100 }).some(item => {
          const dispatch = this.store.getDispatch(item.id)
          // A sent occurrence without a report may have died before this
          // consumer entered execute. Neither attempt=0 nor silence proves it
          // never ran; retain the slot and expose the unconfirmed disposition.
          return dispatch?.state === 'dispatched' && item.lastReportStatus === null && !this.store.diagnosisExplicitlyDisposed(item.id)
        })
      } catch { unproven = true }
    }
    const interventionRequired = persisted || unproven
    return Object.freeze({ enabled: true, ready: ready && !interventionRequired, running: this.#runs.size,
      lastError: interventionRequired ? 'diagnosis-awaits-intervention' : !ready ? 'diagnosis-activation-unavailable' : this.#lastError, interventionRequired })
  }
  close(): void {
    if (this.#closed) return
    this.#closed = true; this.#controller.abort('diagnosis-consumer-disposed'); this.#remove?.(); this.#remove = undefined
  }
}
