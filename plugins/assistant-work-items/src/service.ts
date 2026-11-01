import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { WorkItemAdmission } from './admission.js'
import { WorkItemAuthority } from './authority.js'
import { ConfigSchema, isActive, normalizeConfig, text, type Config, type NormalizedConfig } from './config.js'
import { WorkItemDispatch } from './dispatch.js'
import { WorkItemEvaluationExporter, type WorkItemEvaluationRegistration } from './evaluation.js'
import { WorkItemLedger } from './ledger.js'
import type {
  PeerAutomationsService,
  PeerDeliveryService,
  PeerOwnerRouteReceipt,
  PeerPolicyService,
} from './peers.js'
import { settleOutcomes as runSettlement, type SettlementResult, type ThreadResolution } from './settlement.js'
import { WorkItemStore } from './store.js'
import {
  WorkItemSignalIntake,
  type WorkItemSignalRegistration,
  type WorkItemSignalSweepReport,
} from './signals.js'
import { registerWorkItemTools, workItemReportKey } from './tools.js'
import type {
  WorkItemAdmitInput,
  WorkItemAdmitResult,
  WorkItemAuthorityHealth,
  WorkItemClaimRecord,
  WorkItemEvaluationHealth,
  WorkItemFollowDegradedReason,
  WorkItemFollowRecord,
  WorkItemHealth,
  WorkItemOutcomeEvidenceState,
  WorkItemOutcomeView,
  WorkItemRecord,
  WorkItemReportRecord,
  WorkItemReportStatus,
  WorkItemResumeContext,
  WorkItemSettlementReport,
  WorkItemThreadClosure,
  WorkItemThreadSourceRegistration,
} from './types.js'
import { WorkItemError } from './types.js'
import { WorkItemWorkspace } from './workspace.js'

function fail(code: ConstructorParameters<typeof WorkItemError>[0], message: string, detail?: string): never {
  throw new WorkItemError(code, message, detail)
}

/** Snapshot this shallow tool grammar without evaluating untrusted accessors. */
function workItemToolArguments(candidate: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(candidate))) fail('invalid-input', 'work-item tool arguments must be a plain object')
  const names = Reflect.ownKeys(candidate)
  if (names.length > allowed.length || names.some(key => typeof key !== 'string' || !allowed.includes(key))) fail('invalid-input', 'work-item tool arguments contain an unknown field')
  const args: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of names as string[]) {
    const field = Object.getOwnPropertyDescriptor(candidate, key)
    if (field === undefined || !field.enumerable || !('value' in field) || field.value === undefined) fail('invalid-input', 'work-item tool arguments must contain only enumerable data fields')
    if (key !== 'artifacts') {
      args[key] = field.value as unknown
      continue
    }
    const paths = field.value as unknown
    if (!Array.isArray(paths) || Object.getPrototypeOf(paths) !== Array.prototype) fail('invalid-input', 'artifacts must be a plain array')
    const length = Object.getOwnPropertyDescriptor(paths, 'length')?.value as unknown
    if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > 20) fail('invalid-input', 'at most 20 artifact paths are accepted')
    const indices = Reflect.ownKeys(paths)
    if (indices.length !== (length as number) + 1 || indices.some(index => typeof index !== 'string'
      || (index !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(index)))) fail('invalid-input', 'artifacts must not contain symbols, holes or extra fields')
    const copied: string[] = []
    for (let index = 0; index < (length as number); index += 1) {
      const entry = Object.getOwnPropertyDescriptor(paths, String(index))
      if (entry === undefined || !entry.enumerable || !('value' in entry) || typeof entry.value !== 'string') fail('invalid-input', 'artifacts must contain only enumerable string data entries')
      copied.push(entry.value)
    }
    args[key] = copied
  }
  return args
}

/** Bounded, model-facing view of one successful claim. */
export interface WorkItemClaimView {
  readonly itemId: string
  readonly runId: string
  readonly state: string
  readonly kind: string
  readonly externalId: string
  readonly title: string
  readonly brief: string
  readonly briefTruncated: boolean
  readonly acceptanceRef: string | null
  readonly workDir: string
  readonly attempt: number
  readonly maxAttempts: number
  readonly leaseUntil: number | null
  readonly replayed: boolean
  readonly resume: WorkItemResumeContext
}

/** Bounded, model-facing view of one appended report. */
export interface WorkItemReportView {
  readonly itemId: string
  readonly revision: number
  readonly status: WorkItemReportStatus
  readonly state: string
  readonly truncated: boolean
  readonly artifactPaths: readonly string[]
  readonly delivery: string
  readonly replayed: boolean
  readonly notified: boolean
}

/** Bounded, read-only view of the current run's item. */
export interface WorkItemStatusView {
  readonly item: WorkItemRecord
  readonly claim: WorkItemClaimRecord | undefined
  readonly reports: readonly WorkItemReportRecord[]
  readonly openItems: number
  /** Latest independent-outcome revision; `undefined` before any terminal move. */
  readonly outcome: WorkItemOutcomeView | undefined
}

/** One byte-bounded page of an immutable, persisted report. */
export interface WorkItemReportPage {
  readonly itemId: string
  readonly revision: number
  readonly status: WorkItemReportStatus
  readonly summary: string
  /** UTF-8 byte offsets into the stored summary, never into arbitrary files. */
  readonly offset: number
  readonly nextOffset: number | null
  readonly summaryBytes: number
  /** Whether the original report was truncated before it entered the ledger. */
  readonly storedTruncated: boolean
  readonly artifactPaths: readonly string[]
  readonly recordedAt: number
  readonly previousRevision: number | null
  readonly nextRevision: number | null
}

/** One lazy persistence stack; absent while the intake is disabled. */
interface Components {
  readonly workspace: WorkItemWorkspace
  readonly store: WorkItemStore
  readonly ledger: WorkItemLedger
  readonly admission: WorkItemAdmission
  readonly authority: WorkItemAuthority
  readonly dispatch: WorkItemDispatch
  readonly signals: WorkItemSignalIntake
}

export interface WorkItemReportInput {
  readonly status: WorkItemReportStatus
  readonly summary: string
  readonly artifactPaths?: readonly string[]
  readonly idempotencyKey: string
}

export interface WorkItemSchedulerWakeHealth {
  /** A listener is installed; this does not attest schedulerEnabled or duty. */
  readonly subscribed: boolean
  readonly lastWakeAt: number | null
  readonly lastError: string | null
}

type WorkItemToolExecution = Pick<ToolExecution, 'name' | 'agent' | 'arguments'> & { readonly signal?: AbortSignal }

declare module '@deepseek-ai/cordis' {
  interface Context {
    assistantWorkItems: AssistantWorkItemsService
  }
}

/**
 * Work-item intake kernel.
 *
 * This service owns configuration, the private ledger and identity resolution;
 * it deliberately owns no agent loop, timer, outbox, budget or session. Every
 * side effect is a call into an existing peer plugin (`assistant-automations`
 * for the worker run, `assistant-delivery` for the owner notification), and the
 * disabled default opens no file at all.
 */
export class AssistantWorkItemsService extends Service {
  static Config = ConfigSchema

  // Cordis traces this Service through caller-context proxies. JavaScript #
  // private brands reject those receivers; TS-private members preserve the
  // proxy's ctx without binding methods back to the provider instance.
  private readonly workItemsConfig: NormalizedConfig
  private readonly workItemsEvaluation: WorkItemEvaluationExporter
  /** Host-registered followed-thread sources; empty means no follow can close. */
  private readonly workItemsThreadSources = new Map<string, WorkItemThreadSourceRegistration>()
  private workItemsFollowDegraded: WorkItemFollowDegradedReason | null = null
  private workItemsComponents: Components | undefined
  private workItemsClosed = false
  private readonly workItemsSchedulerUnsubscribers = new Set<() => void>()
  private workItemsSchedulerWaking = false
  private workItemsSchedulerLastWakeAt: number | null = null
  private workItemsSchedulerLastError: string | null = null

  constructor(ctx: Context, input: Config) {
    super(ctx, 'assistantWorkItems')
    this.workItemsConfig = Object.freeze(normalizeConfig(input, Date.now()))
    // The Evaluation outbox is service state, not ledger state: it exists even
    // for a disabled intake so `assistant-evaluation` can bind a generation,
    // and it never opens SQLite until an export pass actually runs.
    this.workItemsEvaluation = new WorkItemEvaluationExporter({
      store: () => this.workItemsComponents?.store,
      scope: () => {
        const scope = this.workItemsConfig.scope
        return scope === null ? null : Object.freeze({ workspace: scope.workspace, preset: scope.preset })
      },
      enabled: () => !this.workItemsClosed && isActive(this.workItemsConfig) && this.workItemsConfig.settlement.enabled,
      now: () => Date.now(),
      warn: message => this.ctx.logger.warn(message),
    })
    ctx.effect(() => () => this.close(), 'assistant-work-items.store')
    ctx.inject(['tools'], toolsCtx => registerWorkItemTools(toolsCtx, this))
    // The disabled default must not create a directory, lock a file or open a
    // database, so persistence starts only for an explicitly enabled intake.
    if (this.workItemsConfig.enabled) this.workItemsOpen()
    if (isActive(this.workItemsConfig)) {
      ctx.inject(['assistantAutomations'], wakeCtx => {
        if (this.workItemsClosed) return
        const peer = wakeCtx.get('assistantAutomations' as never) as PeerAutomationsService | undefined
        if (typeof peer?.onSchedulerWake !== 'function') {
          wakeCtx.logger.warn('assistant-work-items: native scheduler wake is unavailable; waiting resumes retain startup/claim recovery')
          return
        }
        // Resolve on the consumer Context so Automations owns this effect on
        // the injecting Fiber, not on its own provider or a cached root proxy.
        let active = true
        const unregister = peer.onSchedulerWake(() => {
          if (active) this.workItemsOnSchedulerWake()
        })
        const remove = () => {
          if (!active) return
          active = false
          this.workItemsSchedulerUnsubscribers.delete(remove)
          unregister()
        }
        if (this.workItemsClosed) { remove(); return }
        this.workItemsSchedulerUnsubscribers.add(remove)
        wakeCtx.effect(() => remove, 'assistant-work-items.scheduler-wake')
      })
    }
  }

  /** One native wake may admit at most ten already-due waiting occurrences. */
  private workItemsOnSchedulerWake(): void {
    if (this.workItemsClosed || !isActive(this.workItemsConfig) || this.workItemsSchedulerWaking) return
    const components = this.workItemsComponents
    if (components === undefined) return
    this.workItemsSchedulerWaking = true
    this.workItemsSchedulerLastWakeAt = Date.now()
    this.workItemsSchedulerLastError = null
    try {
      for (const selected of components.store.listDueWaitingResumes(10)) {
        if (this.workItemsClosed) break
        // Advance before examining authority, including on denied items. The
        // next tick can reach later rows; pending rows remain available on wrap.
        components.store.advanceWaitingResumeCursor(selected)
        try {
          const dispatch = components.store.getDispatch(selected.itemId)
          const item = components.store.findItemById(selected.itemId)
          const scope = this.workItemsConfig.scope
          if (dispatch === undefined || dispatch.state !== 'pending' || dispatch.reason !== 'waiting-resume'
            || dispatch.eventId !== selected.eventId || dispatch.generation !== selected.generation
            || dispatch.occurredAt > Date.now() || item === undefined || item.state !== 'waiting'
            || item.lastReportStatus !== 'waiting' || item.observed || item.leaseUntil !== null
            || components.store.activeClaim(item.id) !== undefined || item.attempt >= item.maxAttempts
            || item.authority === null || scope === null || scope.expiresAt <= Date.now()
            || item.scope.workspace !== scope.workspace || item.scope.preset !== scope.preset
            || item.scope.principalId !== scope.principalId || item.scope.ownerRouteId !== scope.ownerRouteId) continue
          const owner = this.workItemsAssertOwnerRoute(item)
          if (owner.principalVersion !== item.owner.principalVersion
            || owner.bindingVersion !== item.owner.bindingVersion || owner.generation !== item.owner.generation) continue
          // Reuse the existing mandate check, stable event identity, ingestion
          // Policy and unknown-outcome handling. This does not run an Agent.
          components.dispatch.wake(item)
        } catch (error) {
          this.workItemsSchedulerLastError = error instanceof WorkItemError ? error.code : 'scheduler-wake-failed'
          this.ctx.logger.warn(`assistant-work-items: waiting resume wake failed: ${describe(error)}`)
        }
      }
    } catch (error) {
      this.workItemsSchedulerLastError = error instanceof WorkItemError ? error.code : 'scheduler-wake-failed'
      this.ctx.logger.warn(`assistant-work-items: waiting resume scan failed: ${describe(error)}`)
    } finally {
      this.workItemsSchedulerWaking = false
    }
  }

  get enabled(): boolean {
    return this.workItemsConfig.enabled
  }

  get mode(): 'observe' | 'active' {
    return this.workItemsConfig.mode
  }

  /** Bounded admission check; no work-item recovery, writes, dispatch or model. */
  preauthorizeTool(execution: ToolExecution): boolean {
    try {
      if (execution.signal.aborted) return false
      this.workItemsCheckToolExecution(execution, true)
      return true
    } catch {
      return false
    }
  }

  /** Approval cannot extend the live occurrence/owner mandate at execution. */
  assertToolExecution(execution: WorkItemToolExecution): void {
    this.workItemsCheckToolExecution(execution, false)
  }

  private workItemsCheckToolExecution(execution: WorkItemToolExecution, requireModernMandate: boolean): void {
    const config = this.workItemsConfig
    if (execution.signal?.aborted) fail('invalid-state', 'the work-item tool execution was cancelled')
    if (this.workItemsClosed || !isActive(config)) fail('disabled', 'active work-item intake is required')
    const components = this.workItemsComponents
    if (components === undefined) fail('storage', 'the work-item ledger is unavailable')
    const occurrenceId = this.workItemsOccurrenceId(execution.agent)
    const item = components.store.findItemByOccurrence(occurrenceId)
    if (item === undefined) fail('not-found', 'no work item is bound to this automation occurrence')
    const scope = config.scope
    const header = execution.agent?.session?.header
    if (scope === null || header?.cwd !== scope.workspace || header.agentPreset !== scope.preset
      || item.scope.workspace !== scope.workspace || item.scope.preset !== scope.preset
      || item.scope.principalId !== scope.principalId || item.scope.ownerRouteId !== scope.ownerRouteId
      || item.owner.workspace !== scope.workspace || item.owner.agentPreset !== scope.preset) {
      fail('identity-mismatch', 'work-item tool scope does not match the current worker and admitted owner')
    }
    if (scope.expiresAt <= Date.now()) fail('owner-route-expired', 'the configured work-item owner scope expired')
    const owner = this.workItemsAssertOwnerRoute(item)
    if (owner.principalVersion !== item.owner.principalVersion
      || owner.bindingVersion !== item.owner.bindingVersion || owner.generation !== item.owner.generation) {
      fail('owner-route-invalid', 'owner route generation changed since admission')
    }
    if (this.workItemsPolicy() === undefined) fail('missing-dependency', 'assistantPolicy is required for work-item tools')
    const authority = components.authority.check(item)
    if (authority.kind === 'revoked') fail('authority-revoked', 'admission mandate no longer permits this work-item tool')
    if (authority.kind === 'unavailable') fail('authority-unavailable', 'admission mandate could not be revalidated', authority.detail)
    if (requireModernMandate && authority.kind !== 'allow') fail('authority-unavailable', 'legacy work items require the ordinary approval path')

    const active = components.store.activeClaim(item.id)
    if (active !== undefined && active.runId !== occurrenceId && active.leasedUntil > Date.now()) fail('claim-conflict', 'another occurrence owns this work item')
    const allowed = execution.name === 'work_item_report' ? ['status', 'summary', 'artifacts']
      : execution.name === 'work_item_read_report' ? ['revision', 'offset', 'max_bytes']
        : execution.name === 'work_item_claim' || execution.name === 'work_item_status' ? [] : undefined
    if (allowed === undefined) fail('invalid-input', 'unknown work-item tool')
    const args = workItemToolArguments(execution.arguments, allowed)

    if (execution.name === 'work_item_status') return
    if (execution.name === 'work_item_read_report') {
      this.workItemsReadReportPage(components, item, {
        revision: args.revision as number,
        ...(args.offset === undefined ? {} : { offset: args.offset as number }),
        ...(args.max_bytes === undefined ? {} : { maxBytes: args.max_bytes as number }),
      })
      return
    }
    const now = Date.now()
    const claim = components.store.findClaimByRun(occurrenceId)
    if (execution.name === 'work_item_claim') {
      if (item.observed) fail('invalid-state', 'observed work items cannot be claimed')
      if (claim?.itemId === item.id && claim.state === 'active' && claim.leasedUntil > now
        && item.leaseRunId === occurrenceId && item.leaseUntil !== null && item.leaseUntil > now) return
      if (item.attempt >= item.maxAttempts) fail('retry-exhausted', 'work item exhausted its attempt budget')
      const recoverable = ['claimed', 'working'].includes(item.state) && item.leaseUntil !== null
        && item.leaseUntil <= now && (active === undefined || active.leasedUntil <= now)
      if (!['queued', 'waiting'].includes(item.state) && !recoverable) fail('claim-conflict', 'work item is not claimable')
      return
    }
    if (typeof args.status !== 'string' || !['progress', 'waiting', 'ready', 'blocked', 'failed'].includes(args.status)
      || typeof args.summary !== 'string' || args.summary.trim().length === 0) fail('invalid-input', 'work-item report requires a valid status and non-empty summary')
    const artifacts = args.artifacts ?? []
    if (!Array.isArray(artifacts) || artifacts.some(path => typeof path !== 'string')) fail('invalid-input', 'work-item report artifacts must be string paths')
    components.workspace.validateArtifacts(item, artifacts)
    if (claim === undefined || claim.itemId !== item.id) fail('claim-conflict', 'claim this item before reporting')
    const reportCount = components.store.reportCount(item.id)
    if (reportCount > 100) fail('storage', 'work item exceeds the bounded report history')
    const key = `work-item-report:${workItemReportKey(args.status as WorkItemReportStatus, args.summary, artifacts)}\0${item.id}\0${String(claim.claimId)}`
    if (components.store.reports(item.id).some(report => report.idempotencyKey === key)) return
    if (claim.state !== 'active' || claim.leasedUntil <= now || item.leaseRunId !== occurrenceId
      || item.leaseUntil === null || item.leaseUntil <= now) fail('claim-expired', 'report requires the current active claim')
    if (!['claimed', 'working'].includes(item.state)) fail('invalid-state', 'work item is not reportable')
    if (reportCount >= config.limits.maxReportsPerItem) fail('report-limit', 'work item reached maxReportsPerItem')
  }

  /**
   * Admit one external work signal.
   *
   * Host-side entry point for a future external source plugin. It performs no
   * dispatch work beyond the same bounded wake the ledger does on recovery, so
   * observe mode stays free of external effects.
   */
  admit(input: WorkItemAdmitInput): WorkItemAdmitResult {
    const components = this.workItemsAvailable()
    const result = components.admission.admit(input)
    if (result.created && isActive(this.workItemsConfig)) {
      try {
        components.dispatch.wake(result.item)
      } catch (error) {
        // The item is durable evidence; a failed wake is recorded on the
        // dispatch row and retried by the next bounded recovery pass.
        this.ctx.logger.warn(`assistant-work-items: worker wake failed: ${describe(error)}`)
      }
      const dispatch = components.store.getDispatch(result.item.id)
      if (dispatch !== undefined) return Object.freeze({ ...result, dispatch })
    }
    return result
  }

  /**
   * Claim the item bound to the calling automation occurrence.
   *
   * Identity comes exclusively from the frozen, production automation
   * execution context installed by `assistant-automations`; a foreground
   * session, a preview run and another automation all fail closed.
   *
   * An armed signal source is swept here (bounded by the persisted
   * `sweepIntervalMs`) so ordinary use keeps producing work without a timer or
   * developer orchestration. A sweep failure never fails the claim.
   */
  claim(agent: Agent | undefined): WorkItemClaimView {
    const components = this.workItemsRequired()
    this.workItemsSweepQuietly(components)
    this.workItemsSettleQuietly(components)
    const occurrenceId = this.workItemsOccurrenceId(agent)
    components.ledger.recover()
    // Lease-expiry and waiting resume are generic recovery work, so ordinary
    // worker traffic is the lazy sweep that re-dispatches them. This is
    // best-effort: a recovery failure never blocks the caller's own claim.
    this.workItemsWakeQuietly(components)
    const item = components.store.findItemByOccurrence(occurrenceId)
    if (item === undefined) fail('not-found', 'no work item is bound to this automation occurrence')
    this.workItemsAssertOwnerRoute(item)
    this.workItemsRevalidateAuthority(components, item)
    const runId = occurrenceId
    const result = components.ledger.claim({ itemId: item.id, runId, occurrenceId })
    // A claim can settle a prior window and unblock recovery, so it is a
    // transaction boundary that may have produced a new exportable revision.
    this.workItemsDrainEvaluation()
    // The resume brief is derived only after the claim committed, from the same
    // durable ledger; a missing row here means storage broke, so fail loudly
    // instead of handing the model an invented empty context.
    const resume = components.store.workItemResumeContext(result.item.id)
    if (resume === undefined) fail('storage', 'work item disappeared before its resume brief was derived')
    return Object.freeze({
      itemId: result.item.id,
      runId: result.claim.runId,
      state: result.item.state,
      kind: result.item.kind,
      externalId: result.item.externalId,
      title: result.item.title,
      brief: result.item.brief,
      briefTruncated: result.item.briefTruncated,
      acceptanceRef: result.item.acceptanceRef,
      workDir: result.item.workDir,
      attempt: result.item.attempt,
      maxAttempts: result.item.maxAttempts,
      leaseUntil: result.item.leaseUntil,
      replayed: result.replayed,
      resume,
    })
  }

  /**
   * Append one report revision under the caller's active claim.
   *
   * Reporting is the only worker write path. A terminal status additionally
   * enqueues one owner notification through `assistant-delivery`; a delivery
   * failure is recorded against the report instead of erasing report evidence.
   */
  async report(agent: Agent | undefined, input: WorkItemReportInput): Promise<WorkItemReportView> {
    const components = this.workItemsRequired()
    const occurrenceId = this.workItemsOccurrenceId(agent)
    components.ledger.recover()
    const item = components.store.findItemByOccurrence(occurrenceId)
    if (item === undefined) fail('not-found', 'no work item is bound to this automation occurrence')
    const result = components.ledger.report({
      itemId: item.id,
      runId: occurrenceId,
      status: input.status,
      summary: input.summary,
      artifactPaths: input.artifactPaths ?? [],
      idempotencyKey: input.idempotencyKey,
    })
    let notified = false
    if (!result.replayed) {
      try {
        notified = await components.dispatch.notify(result.item, result.report)
      } catch (error) {
        // `notify` already persisted the failed/unknown delivery state. Report
        // evidence must survive a notification failure, so surface it in the
        // log and keep the appended revision.
        this.ctx.logger.warn(`assistant-work-items: owner notification failed: ${describe(error)}`)
      }
    }
    const stored = components.store.reports(item.id).find(report => report.revision === result.report.revision)
    // A terminal report appends the settlement outcome synchronously, so this
    // is the main ordinary-use boundary that feeds the trusted lane.
    this.workItemsDrainEvaluation()
    return Object.freeze({
      itemId: result.item.id,
      revision: result.report.revision,
      status: result.report.status,
      state: result.item.state,
      truncated: result.report.truncated,
      artifactPaths: result.report.artifactPaths,
      delivery: (stored ?? result.report).deliveryState ?? 'pending',
      replayed: result.replayed,
      notified,
    })
  }

  /**
   * Register one additional automatic source and return an idempotent disposer.
   *
   * This is the public extension point for an external signal producer (a
   * repository watcher, a chat bridge, a scheduler): the producer supplies a
   * read-only `WorkItemSignalSource`, gets the same bounded sweep, provenance,
   * dedupe, cooldown and settled-item fence as the built-in adapter, and can be
   * withdrawn by disposing the registration. Registration fails closed when the
   * intake is disabled or already disposed, and never admits retroactively.
   */
  registerSignalSource(registration: WorkItemSignalRegistration): () => void {
    const components = this.workItemsAvailable()
    const dispose = components.signals.register(registration)
    return () => {
      dispose()
    }
  }

  /**
   * Register the only resolver for one followed-thread source.
   *
   * Host-only extension point. Registration is one-per-source, validated
   * synchronously and revoked by the returned disposer. A follow recorded while
   * a source is registered stores that source's generation, so replacing the
   * source later degrades the follow to `unresolved` instead of trusting a
   * stale closure. This adds resolution capability only: it is not authority to
   * end an item, and a closure never claims an objective was achieved.
   */
  registerThreadSource(registration: WorkItemThreadSourceRegistration): () => void {
    if (!this.workItemsConfig.enabled || this.workItemsClosed) fail('disabled', 'the work-item intake is disabled')
    if (registration === null || typeof registration !== 'object' || Array.isArray(registration)) {
      fail('invalid-input', 'thread source registration must be an object')
    }
    const allowed = ['source', 'generation', 'resolve'] as const
    for (const key of Object.keys(registration)) {
      if (!(allowed as readonly string[]).includes(key)) fail('invalid-input', `thread source registration contains unknown field ${key}`)
    }
    const source = text(registration.source, 'thread source', 64)
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(source)) fail('invalid-input', 'thread source has an invalid shape')
    text(registration.generation, 'thread source generation', 200)
    if (typeof registration.resolve !== 'function') fail('invalid-input', 'thread source must expose a resolve function')
    if (this.workItemsThreadSources.has(source)) fail('invalid-input', `thread source ${source} is already registered`)
    const installed = registration
    this.workItemsThreadSources.set(source, installed)
    return () => {
      // Only the disposer of the live registration may revoke it, so a stale
      // disposer from a replaced source cannot delete the current one.
      if (this.workItemsThreadSources.get(source) === installed) this.workItemsThreadSources.delete(source)
    }
  }

  /**
   * Trusted Evaluation producer generation (fourth trusted producer).
   *
   * `assistant-evaluation` reads this before registering a sink; returning a
   * fresh value on a new service instance is what makes a stale capability
   * fail closed instead of appending to the wrong host.
   */
  trustedWorkItemProducerGeneration(): string {
    return this.workItemsEvaluation.generation
  }

  /**
   * Install the Evaluation-owned sink this plugin exports settled outcomes to.
   *
   * The registration is opaque: Evaluation passes its own capability and this
   * plugin only validates the protocol, generation and ownership before using
   * it. Exactly one sink is accepted; the returned disposer withdraws it.
   */
  registerTrustedWorkItemEvaluationSink(registration: Readonly<WorkItemEvaluationRegistration>): () => void {
    if (this.workItemsClosed) fail('storage', 'the work-item intake is disposed')
    // The exporter itself runs one bounded catch-up pass the moment the sink is
    // installed, so the service boundary must not queue a redundant one.
    const dispose = this.workItemsEvaluation.registerTrustedWorkItemEvaluationSink(registration)
    return () => {
      dispose()
    }
  }

  /**
   * Sweep every armed automatic source once and report what it did.
   *
   * Explicit host entry point; `force` ignores the persisted interval. The
   * disabled default and a missing optional peer both return an empty report,
   * so a caller never has to special-case activation.
   */
  sweepSignals(force = true): WorkItemSignalSweepReport {
    if (!this.workItemsConfig.enabled || this.workItemsClosed) return Object.freeze({ sources: [] })
    try {
      return this.workItemsOpen().signals.sweep(force)
    } catch (error) {
      this.ctx.logger.warn(`assistant-work-items: signal sweep unavailable: ${describe(error)}`)
      return Object.freeze({ sources: [] })
    }
  }

  /**
   * Run one bounded settlement pass over the pending outcome windows.
   *
   * Host-only by design: there is deliberately no model tool for this, so a
   * worker can never settle or launder its own outcome. Returns a report instead
   * of throwing, and a disabled intake returns `skipped: 'disabled'`.
   */
  settleOutcomes(force = true): WorkItemSettlementReport {
    if (!this.workItemsConfig.enabled || this.workItemsClosed || !this.workItemsConfig.settlement.enabled) {
      return Object.freeze({
        skipped: 'disabled',
        degraded: null,
        failed: false,
        scanned: 0,
        settled: 0,
        expired: 0,
        deferred: 0,
        closedByThread: 0,
        followDegraded: null,
        observedItemIds: Object.freeze([]),
      })
    }
    try {
      const result = this.workItemsSettlement(this.workItemsOpen(), force)
      this.workItemsDrainEvaluation()
      return result.report
    } catch (error) {
      this.ctx.logger.warn(`assistant-work-items: settlement unavailable: ${describe(error)}`)
      // Only a genuinely absent dependency is reported as such; any other
      // failure is an undifferentiated degraded pass, never a silent success.
      const degraded = error instanceof WorkItemError && error.code === 'missing-dependency'
        ? 'missing-dependency' as const
        : null
      return Object.freeze({
        skipped: null,
        degraded,
        failed: true,
        scanned: 0,
        settled: 0,
        expired: 0,
        deferred: 0,
        closedByThread: 0,
        followDegraded: null,
        observedItemIds: Object.freeze([]),
      })
    }
  }

  /**
   * Read the latest outcome revision per item, newest first.
   *
   * Host-only projection for status/health consumers; the disabled default
   * returns an empty list rather than opening the ledger.
   */
  outcomes(options: { limit?: number; evidenceState?: WorkItemOutcomeEvidenceState } = {}): readonly WorkItemOutcomeView[] {
    const limit = options.limit ?? 20
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('invalid-input', 'limit must be an integer between 1 and 100')
    if (!this.workItemsConfig.enabled || this.workItemsClosed) return Object.freeze([])
    const components = this.workItemsOpen()
    return components.store.listOutcomes({
      limit,
      ...(options.evidenceState === undefined ? {} : { evidenceState: options.evidenceState }),
    })
  }

  /** Read-only status of the item bound to the calling occurrence. */
  status(agent: Agent | undefined): WorkItemStatusView {
    const components = this.workItemsRequired()
    const occurrenceId = this.workItemsOccurrenceId(agent)
    components.ledger.recover()
    const item = components.store.findItemByOccurrence(occurrenceId)
    if (item === undefined) fail('not-found', 'no work item is bound to this automation occurrence')
    return Object.freeze({
      item,
      claim: components.store.activeClaim(item.id),
      reports: components.store.reports(item.id),
      openItems: components.store.countOpenItems(),
      outcome: components.store.outcomeView(item.id),
    })
  }

  /**
   * Recall one report belonging to the caller's exact production occurrence.
   * This path performs no recovery, parking, settlement or ledger mutation.
   */
  readReport(agent: Agent | undefined, input: { revision: number; offset?: number; maxBytes?: number }): WorkItemReportPage {
    const components = this.workItemsRequired()
    const occurrenceId = this.workItemsOccurrenceId(agent)
    const item = components.store.findItemByOccurrence(occurrenceId)
    if (item === undefined) fail('not-found', 'no work item is bound to this automation occurrence')
    const receipt = this.workItemsAssertOwnerRoute(item)
    if (receipt.principalVersion !== item.owner.principalVersion
      || receipt.bindingVersion !== item.owner.bindingVersion
      || receipt.generation !== item.owner.generation) {
      fail('owner-route-invalid', 'owner route generation changed since admission')
    }
    const authority = components.authority.check(item)
    if (authority.kind === 'revoked') fail('authority-revoked', 'admission mandate no longer permits report recall')
    if (authority.kind === 'unavailable') fail('authority-unavailable', 'admission mandate could not be revalidated', authority.detail)

    return this.workItemsReadReportPage(components, item, input)
  }

  /** Pure SELECT/UTF-8 projection shared by preflight and the read tool. */
  private workItemsReadReportPage(components: Components, item: WorkItemRecord, input: { revision: number; offset?: number; maxBytes?: number }): WorkItemReportPage {
    const offset = input.offset ?? 0
    const maxBytes = input.maxBytes ?? 4_096
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) fail('invalid-input', 'revision must be a positive safe integer')
    if (!Number.isSafeInteger(offset) || offset < 0) fail('invalid-input', 'offset must be a non-negative UTF-8 byte offset')
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > 8_192) fail('invalid-input', 'maxBytes must be an integer between 4 and 8192')
    const found = components.store.reportByRevision(item.id, input.revision)
    if (found === undefined) fail('not-found', 'no report with this revision belongs to the current work item')
    const bytes = Buffer.from(found.report.summary, 'utf8')
    if (offset > bytes.length || (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80)) {
      fail('invalid-input', 'offset must be within the stored summary at a UTF-8 character boundary')
    }
    let end = Math.min(offset + maxBytes, bytes.length)
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1
    return Object.freeze({
      itemId: item.id,
      revision: found.report.revision,
      status: found.report.status,
      summary: bytes.subarray(offset, end).toString('utf8'),
      offset,
      nextOffset: end < bytes.length ? end : null,
      summaryBytes: bytes.length,
      storedTruncated: found.report.truncated,
      artifactPaths: found.report.artifactPaths,
      recordedAt: found.report.recordedAt,
      previousRevision: found.previousRevision,
      nextRevision: found.nextRevision,
    })
  }

  /** Bounded health projection; never creates the ledger when disabled. */
  health(): WorkItemHealth & { readonly schedulerWake: WorkItemSchedulerWakeHealth } {
    const config = this.workItemsConfig
    const empty: WorkItemHealth = Object.freeze({
      enabled: config.enabled,
      mode: config.mode,
      openItems: 0,
      lastAdmitAt: null,
      lastDispatchAt: null,
      dispatchUnknown: 0,
      workerConnected: config.enabled && this.workItemsAutomations() !== undefined,
      ownerRouteValid: false,
      follows: Object.freeze({ open: 0, closed: 0, unresolved: 0, degraded: null }),
      authority: Object.freeze({ legacy: 0, parked: 0, lastDeniedAt: null, lastDeniedReason: null }),
      settlement: Object.freeze({
        enabled: config.enabled && config.settlement.enabled,
        pending: 0,
        observed: 0,
        unverified: 0,
        degraded: null,
      }),
      evaluation: Object.freeze({
        enabled: this.workItemsEvaluationEnabled(),
        connected: this.workItemsEvaluation.connected,
        pending: 0,
        exported: 0,
        skipped: 0,
        degraded: this.workItemsEvaluation.degraded,
      }),
    })
    const schedulerWake = Object.freeze({ subscribed: this.workItemsSchedulerUnsubscribers.size > 0,
      lastWakeAt: this.workItemsSchedulerLastWakeAt, lastError: this.workItemsSchedulerLastError })
    if (!config.enabled || this.workItemsClosed) return Object.freeze({ ...empty, schedulerWake })
    let components: Components
    try {
      components = this.workItemsOpen()
    } catch (error) {
      this.ctx.logger.warn(`assistant-work-items: ledger unavailable: ${describe(error)}`)
      return Object.freeze({ ...empty, schedulerWake })
    }
    return Object.freeze({
      schedulerWake,
      enabled: true,
      mode: config.mode,
      openItems: components.store.countOpenItems(),
      lastAdmitAt: components.store.lastAdmitAt(),
      lastDispatchAt: components.store.lastDispatchedAt(),
      dispatchUnknown: components.store.countDispatchUnknown(),
      workerConnected: workerIsConnected(this.workItemsAutomations()),
      ownerRouteValid: this.workItemsOwnerRouteValid(),
      follows: this.workItemsFollowHealth(components.store),
      authority: this.workItemsAuthorityHealth(components.store),
      settlement: Object.freeze({
        enabled: config.settlement.enabled,
        pending: components.store.countLatestOutcomes('pending'),
        observed: components.store.countLatestOutcomes('observed'),
        unverified: components.store.countLatestOutcomes('unverified'),
        degraded: this.workItemsSettlementDegraded(),
      }),
      evaluation: Object.freeze(this.workItemsEvaluationHealth(components)),
    })
  }

  /** Close the ledger exactly once; safe on an intake that never opened. */
  close(): void {
    if (this.workItemsClosed) return
    this.workItemsClosed = true
    for (const unregister of this.workItemsSchedulerUnsubscribers) {
      try { unregister() } catch (error) { this.ctx.logger.warn(`assistant-work-items: scheduler wake removal failed: ${describe(error)}`) }
    }
    this.workItemsEvaluation.dispose()
    const components = this.workItemsComponents
    this.workItemsComponents = undefined
    if (components === undefined) return
    try {
      components.store.close()
    } catch (error) {
      this.ctx.logger.warn(`assistant-work-items: ledger close failed: ${describe(error)}`)
    }
  }

  /** Export is possible only from an active intake with settlement armed. */
  private workItemsEvaluationEnabled(): boolean {
    return !this.workItemsClosed && isActive(this.workItemsConfig) && this.workItemsConfig.settlement.enabled
  }

  /** One bounded counts read for the export projection. */
  private workItemsEvaluationHealth(components: Components): WorkItemEvaluationHealth {
    const counts = components.store.countEvaluations()
    const enabled = this.workItemsEvaluationEnabled()
    return {
      enabled,
      connected: this.workItemsEvaluation.connected,
      pending: counts.pending,
      exported: counts.exported,
      skipped: counts.skipped,
      degraded: this.workItemsEvaluationDegraded(counts.pending),
    }
  }

  /**
   * Health degradation: a settled revision can never reach the trusted lane.
   *
   * A missing optional sink is only a *gap* once something actually awaits
   * export; a deployment that never installs Evaluation must not look degraded
   * while it has nothing to export.
   */
  private workItemsEvaluationDegraded(pending: number): string | null {
    if (!this.workItemsConfig.settlement.enabled) return null
    if (this.workItemsConfig.scope === null) return 'owner-route-unavailable'
    if (!this.workItemsEvaluation.connected) return pending > 0 ? 'sink-unavailable' : null
    return this.workItemsEvaluation.degraded
  }

  /** Fire-and-forget bounded drain; export failures must never fail a caller. */
  private workItemsDrainEvaluation(): void {
    void this.workItemsEvaluation.drain().catch(error => {
      this.ctx.logger.warn(`assistant-work-items: Evaluation export failed: ${describe(error)}`)
    })
  }

  private workItemsAvailable(): Components {
    if (!this.workItemsConfig.enabled) fail('disabled', 'the work-item intake is disabled')
    return this.workItemsOpen()
  }

  /** Best-effort bounded sweep; log and continue on any failure. */
  private workItemsSweepQuietly(components: Components): void {
    if (!components.signals.armed()) return
    try {
      components.signals.sweep()
    } catch (error) {
      this.ctx.logger.warn(`assistant-work-items: signal sweep failed: ${describe(error)}`)
    }
  }

  /** Best-effort bounded re-dispatch sweep behind ordinary claim activity. */
  private workItemsWakeQuietly(components: Components): void {
    try {
      components.dispatch.wakePending()
    } catch (error) {
      this.ctx.logger.warn(`assistant-work-items: dispatch recovery failed: ${describe(error)}`)
    }
  }

  /** Best-effort settlement pass behind ordinary claim activity. */
  private workItemsSettleQuietly(components: Components): void {
    if (!this.workItemsConfig.settlement.enabled) return
    try {
      this.workItemsSettlement(components, false)
    } catch (error) {
      this.ctx.logger.warn(`assistant-work-items: settlement failed: ${describe(error)}`)
    }
  }

  /** Build the bounded settlement pass from config; never admits or wakes. */
  private workItemsSettlement(components: Components, force: boolean): SettlementResult {
    const config = this.workItemsConfig
    const scope = config.scope
    const result = runSettlement({
      store: components.store,
      delivery: this.workItemsDelivery(),
      scope: scope === null
        ? null
        : {
          ownerRouteId: scope.ownerRouteId,
          principalId: scope.principalId,
          workspace: scope.workspace,
          preset: scope.preset,
        },
      sweepIntervalMs: config.settlement.sweepIntervalMs,
      maxSourcesPerSweep: config.settlement.maxSourcesPerSweep,
      maxPendingPerSweep: config.settlement.maxPendingPerSweep,
      maxSettlementsPerSweep: config.settlement.maxSettlementsPerSweep,
      threads: follow => this.workItemsResolveThread(follow),
      warn: message => this.ctx.logger.warn(message),
    }, force)
    this.workItemsFollowDegraded = result.report.followDegraded
    return result
  }

  /**
   * Resolve one open follow against its registered source.
   *
   * Synchronous and read-only: no timer, no promise, no write. Every refusal
   * returns `unresolved` so the item stays parked and health can name the
   * degradation, rather than a missing source or a stale generation being read
   * as a closure.
   */
  private workItemsResolveThread(follow: WorkItemFollowRecord): ThreadResolution {
    const registration = this.workItemsThreadSources.get(follow.source)
    if (registration === undefined) return { kind: 'unresolved', reason: 'source-missing' }
    // A source that regenerated cannot vouch for a follow recorded under its
    // old generation; the closure may still be true, but it is not observed.
    if (registration.generation !== follow.sourceGeneration) return { kind: 'unresolved', reason: 'generation-mismatch' }
    let closure: WorkItemThreadClosure | undefined
    try {
      closure = registration.resolve(follow.ref)
    } catch (error) {
      this.ctx.logger.warn(`assistant-work-items: thread resolution failed for ${follow.source}: ${describe(error)}`)
      return { kind: 'unresolved', reason: 'resolver-failed' }
    }
    if (closure === undefined) return { kind: 'unresolved', reason: 'resolver-failed' }
    if (closure === null || typeof closure !== 'object' || Array.isArray(closure)) {
      return { kind: 'unresolved', reason: 'resolver-failed' }
    }
    if (closure.state === 'open') return { kind: 'open' }
    if (closure.state !== 'closed') return { kind: 'unresolved', reason: 'resolver-failed' }
    if (!['succeeded', 'failed', 'cancelled', 'unknown'].includes(closure.outcome)
      || typeof closure.digest !== 'string' || closure.digest.trim().length === 0
      || (closure.observedAt !== undefined && (!Number.isSafeInteger(closure.observedAt) || closure.observedAt <= 0))) {
      // A malformed closure is never a closure: fail closed toward `waiting`.
      return { kind: 'unresolved', reason: 'resolver-failed' }
    }
    return { kind: 'closed', outcome: closure.outcome, digest: closure.digest }
  }

  /** Live follow counts and degradation; never resolves or writes anything. */
  private workItemsFollowHealth(store: WorkItemStore): WorkItemHealth['follows'] {
    const counts = store.countFollows()
    let unresolved = 0
    let missingSource = false
    let mismatched = false
    for (const identity of store.openFollowIdentities()) {
      const registration = this.workItemsThreadSources.get(identity.source)
      if (registration === undefined) {
        unresolved += 1
        missingSource = true
      } else if (registration.generation !== identity.sourceGeneration) {
        unresolved += 1
        mismatched = true
      }
    }
    const degraded: WorkItemFollowDegradedReason | null = missingSource
      ? 'source-missing'
      : mismatched ? 'generation-mismatch' : this.workItemsFollowDegraded
    return Object.freeze({ open: counts.open, closed: counts.closed, unresolved, degraded })
  }

  /** Degradation visible in health without running a pass or touching SQLite. */
  private workItemsSettlementDegraded(): string | null {
    if (!this.workItemsConfig.settlement.enabled) return null
    if (this.workItemsConfig.scope === null) return 'owner-route-unavailable'
    return this.workItemsDelivery() === undefined ? 'missing-dependency' : null
  }

  private workItemsRequired(): Components {
    const config = this.workItemsConfig
    if (!config.enabled) fail('disabled', 'the work-item intake is disabled')
    if (!isActive(config)) fail('observe-mode', 'the work-item intake is in observe mode; claim and report require mode: active')
    return this.workItemsOpen()
  }

  private workItemsOpen(): Components {
    const existing = this.workItemsComponents
    if (existing !== undefined) return existing
    if (this.workItemsClosed) fail('storage', 'the work-item intake is disposed')
    const config = this.workItemsConfig
    const workspace = new WorkItemWorkspace(config.workRoot)
    workspace.prepare()
    const store = new WorkItemStore(config.databasePath)
    const ledger = new WorkItemLedger({ store, workspace, limits: config.limits })
    // Admission and dispatch both take the same ledger and the same resolved
    // peers, so one construction order keeps a single writer per durable file.
    const admission = new WorkItemAdmission({
      config,
      store,
      ledger,
      workspace,
      policy: this.workItemsPolicy(),
      delivery: this.workItemsDelivery(),
      threadSource: kind => {
        const registration = this.workItemsThreadSources.get(kind)
        return registration === undefined
          ? undefined
          : Object.freeze({ source: registration.source, generation: registration.generation })
      },
    })
    // One lazy policy resolver serves admission and revalidation: a peer that
    // registers after this plugin becomes visible to both without a restart.
    const authority = new WorkItemAuthority({ policy: () => this.workItemsPolicy() })
    const dispatch = new WorkItemDispatch({
      config,
      store,
      ledger,
      automations: () => this.workItemsAutomations(),
      delivery: this.workItemsDelivery(),
      authority,
    })
    // Signal sources are optional peers resolved lazily on every sweep, so a
    // deployment without `assistant-delivery` (or with the source disabled)
    // stays a no-op instead of failing activation or a claim.
    const signals = new WorkItemSignalIntake({
      config,
      store,
      admission,
      delivery: () => this.workItemsDelivery(),
      dispatch,
      warn: message => this.ctx.logger.warn(message),
    })
    const installed: Components = { workspace, store, ledger, admission, authority, dispatch, signals }
    this.workItemsComponents = installed
    try {
      // Bounded startup reconcile: lease reclaim is lazy forever, so a host that
      // was down catches up on the first touch instead of on a timer.
      installed.ledger.recover()
      if (isActive(config)) {
        try {
          installed.dispatch.wakePending()
        } catch (error) {
          this.ctx.logger.warn(`assistant-work-items: pending wake failed: ${describe(error)}`)
        }
      }
    } catch (error) {
      this.workItemsComponents = undefined
      store.close()
      throw error
    }
    return installed
  }

  /** Resolve the exact production automation occurrence for this agent. */
  private workItemsOccurrenceId(agent: Agent | undefined): string {
    if (agent === undefined) fail('identity-mismatch', 'work-item tools require the worker automation run')
    const execution = (agent.ctx as unknown as { get(name: string): unknown }).get('assistantAutomationExecution')
    if (typeof execution !== 'object' || execution === null || Array.isArray(execution)
      || !Object.isFrozen(execution)
      || Object.keys(execution).sort().join(',') !== 'automationId,mode,occurrenceId') {
      fail('identity-mismatch', 'work-item tools require the immutable automation execution context')
    }
    const installed = execution as { mode?: unknown; automationId?: unknown; occurrenceId?: unknown }
    if (installed.mode !== 'production'
      || typeof installed.automationId !== 'string'
      || typeof installed.occurrenceId !== 'string') {
      fail('identity-mismatch', 'work-item tools are restricted to a production automation run')
    }
    const automationId = text(installed.automationId, 'automationId', 500)
    const occurrenceId = text(installed.occurrenceId, 'occurrenceId', 500)
    if (automationId !== this.workItemsConfig.workerAutomationId) {
      fail('identity-mismatch', 'this automation is not the configured work-item worker')
    }
    return occurrenceId
  }

  /** Re-anchor a claim against the live owner route above the stored receipt. */
  private workItemsAssertOwnerRoute(item: WorkItemRecord): Readonly<PeerOwnerRouteReceipt> {
    const config = this.workItemsConfig
    const delivery = this.workItemsDelivery()
    if (delivery === undefined) fail('owner-route-unavailable', 'assistantDelivery is required to validate the owner route')
    const scope = item.scope
    if (scope.expiresAt <= Date.now()) fail('owner-route-expired', 'the work-item owner scope expired')
    let receipt: Readonly<PeerOwnerRouteReceipt>
    try {
      receipt = delivery.validateOwnerRoute({
        authorityId: scope.ownerRouteId,
        principalId: scope.principalId,
        workspace: scope.workspace,
        agentPreset: scope.preset,
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const missing = error !== null && typeof error === 'object' && 'code' in error && error.code === 'missing-binding'
      fail(missing ? 'owner-route-invalid' : 'owner-route-unavailable', 'owner route validation failed', detail)
    }
    if (receipt.receiptVersion !== 2
      || receipt.workspace !== scope.workspace
      || receipt.agentPreset !== scope.preset
      || receipt.principalId !== scope.principalId
      || receipt.authorityId !== scope.ownerRouteId) {
      fail('owner-route-invalid', 'owner route receipt does not match the admitted scope')
    }
    if (receipt.principalRecordId !== item.owner.principalRecordId) {
      fail('owner-route-invalid', 'owner principal changed since admission')
    }
    if (config.workerAutomationId !== item.workerAutomationId) {
      fail('identity-mismatch', 'item was dispatched to a different worker automation')
    }
    return receipt
  }

  /**
   * Re-validate the stored admission mandate before this claim is allowed.
   *
   * Policy remains the only authority: the exact admission request is replayed
   * against the live policy under the same idempotency key. A denied, failing
   * or malformed decision parks the item in `waiting` with a typed reason and
   * fails the claim closed; the item is never claimed and never marked failed.
   * A later allow resumes it through the same wake path.
   */
  private workItemsRevalidateAuthority(components: Components, item: WorkItemRecord): void {
    const check = components.authority.check(item)
    if (check.kind === 'legacy') return
    if (check.kind === 'allow') {
      components.ledger.restoreAuthority(item)
      return
    }
    if (check.kind === 'revoked') {
      components.ledger.parkAuthority(item, 'authority-revoked', { reason: check.reasonCode, phase: 'claim' })
      components.ledger.rearmAuthority(item)
      fail('authority-revoked', `admission mandate no longer holds (${check.reasonCode})`)
    }
    components.ledger.parkAuthority(item, 'authority-unavailable', { reason: check.detail, phase: 'claim' })
    components.ledger.rearmAuthority(item)
    fail('authority-unavailable', 'admission mandate could not be revalidated', check.detail)
  }

  private workItemsAuthorityHealth(store: WorkItemStore): WorkItemAuthorityHealth {
    const denied = store.lastAuthorityDenial()
    return Object.freeze({
      legacy: store.countAuthorityLegacy(),
      parked: store.countAuthorityParked(),
      lastDeniedAt: denied === null ? null : denied.at,
      lastDeniedReason: denied === null ? null : denied.reason,
    })
  }

  private workItemsOwnerRouteValid(): boolean {
    const config = this.workItemsConfig
    const scope = config.scope
    if (scope === null) return false
    const delivery = this.workItemsDelivery()
    if (delivery === undefined) return false
    if (scope.expiresAt <= Date.now()) return false
    try {
      const receipt = delivery.validateOwnerRoute({
        authorityId: scope.ownerRouteId,
        principalId: scope.principalId,
        workspace: scope.workspace,
        agentPreset: scope.preset,
      })
      return receipt.receiptVersion === 2 && receipt.workspace === scope.workspace
    } catch {
      return false
    }
  }

  private workItemsPolicy(): PeerPolicyService | undefined {
    return this.ctx.get('assistantPolicy') as PeerPolicyService | undefined
  }

  private workItemsDelivery(): PeerDeliveryService | undefined {
    return this.ctx.get('assistantDelivery') as PeerDeliveryService | undefined
  }

  private workItemsAutomations(): PeerAutomationsService | undefined {
    return this.ctx.get('assistantAutomations') as PeerAutomationsService | undefined
  }
}

function workerIsConnected(automations: PeerAutomationsService | undefined): boolean {
  return automations !== undefined
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
