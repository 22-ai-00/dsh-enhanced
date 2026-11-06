import type { WorkItemAuthority } from './authority.ts'
import type { NormalizedConfig } from './config.ts'
import { isActive } from './config.ts'
import type { WorkItemLedger } from './ledger.ts'
import type { PeerAutomationsService, PeerDeliveryService } from './peers.ts'
import type { WorkItemStore } from './store.ts'
import type { WorkItemNotification, WorkItemRecord, WorkItemReportRecord } from './types.ts'
import { OPEN_STATES, WorkItemError } from './types.ts'

function fail(code: ConstructorParameters<typeof WorkItemError>[0], message: string, detail?: string): never {
  throw new WorkItemError(code, message, detail)
}

function peerCode(error: unknown): string {
  if (error === null || typeof error !== 'object' || !('code' in error)) return 'unknown'
  return String((error as { code: unknown }).code)
}

export interface DispatchDependencies {
  readonly config: NormalizedConfig
  readonly store: WorkItemStore
  readonly ledger: WorkItemLedger
  readonly automations: PeerAutomationsService | undefined | (() => PeerAutomationsService | undefined)
  readonly delivery: PeerDeliveryService | undefined | (() => PeerDeliveryService | undefined)
  readonly validateWake?: (item: WorkItemRecord) => boolean
  /** Pure, consumer-owned lifecycle fence; implementations must call no peer. */
  readonly validateWakeLocal?: (item: WorkItemRecord) => boolean
  readonly replyReportEligible?: (item: WorkItemRecord, report: WorkItemReportRecord, notification: WorkItemNotification) => boolean
  /** Admission-mandate revalidation gate; unset means single-authority mode. */
  readonly authority?: WorkItemAuthority
  readonly now?: () => number
}

/**
 * The two external effects of the ledger, both reused rather than reimplemented.
 *
 * `wake` hands one admitted item to the existing `assistant-automations`
 * external-event intake, which owns the occurrence, the native agent run and
 * the attempt budget. `notify` hands one terminal report to the existing
 * `assistant-delivery` background outbox. Neither path owns a timer, an outbox
 * or a session of its own.
 */
export class WorkItemDispatch {
  readonly #deps: DispatchDependencies
  readonly #now: () => number

  constructor(dependencies: DispatchDependencies) {
    this.#deps = dependencies
    this.#now = dependencies.now ?? (() => Date.now())
  }

  /**
   * Wake the worker automation for one dispatch generation.
   *
   * The event identity is read from the dispatch row, never reconstructed from
   * the item: generation 0 uses the admission identity, and every re-arm has a
   * distinct `(eventId, occurredAt)` pair so the automation intake starts a new
   * occurrence instead of replaying the completed one. Within one generation
   * the identity is stable, which is what makes a retry after a crash safe.
   *
   * Revalidation happens here, before the external effect: a revoked or
   * unavailable mandate parks the item and returns `false` without creating an
   * occurrence, so no worker run is ever started under a decision policy no
   * longer supports. A later allow resumes the same row unchanged.
   *
   * Returns `true` only when this call actually handed the row to the worker.
   */
  wake(item: WorkItemRecord): boolean {
    const config = this.#deps.config
    if (!isActive(config) || item.workerAutomationId !== config.workerAutomationId) return false
    if (this.#deps.validateWake && !this.#deps.validateWake(item)) return false
    const automations = typeof this.#deps.automations === 'function' ? this.#deps.automations() : this.#deps.automations
    if (automations === undefined) fail('missing-dependency', 'assistantAutomations is required to wake the worker')
    const dispatch = this.#deps.store.getDispatch(item.id)
    if (dispatch === undefined) fail('storage', 'work item has no dispatch row')
    // Only a pending row may wake: a dispatched row already owns an occurrence,
    // and a failed one was withdrawn or refused, so waking it would hand
    // cancelled work to a live automation before the guarded mark throws.
    if (dispatch.state !== 'pending') return false
    if (!this.#revalidate(item)) return false
    // Policy callbacks can synchronously cancel a reply or dispose its
    // producer. Re-read the durable row and source fence after that callback,
    // immediately before crossing the external occurrence boundary.
    if (this.#deps.validateWake) {
      const currentItem = this.#deps.store.findItemById(item.id), currentDispatch = this.#deps.store.getDispatch(item.id)
      if (!currentItem || !currentDispatch || currentDispatch.state !== 'pending'
        || currentDispatch.generation !== dispatch.generation || currentDispatch.eventId !== dispatch.eventId
        || currentDispatch.occurredAt !== dispatch.occurredAt || !this.#deps.validateWake(currentItem)
        || this.#deps.validateWakeLocal && !this.#deps.validateWakeLocal(currentItem)
        || !this.#deps.store.isWakeSnapshotCurrent(currentItem, currentDispatch)) return false
    }
    try {
      const occurrence = automations.ingestExternal({
        sourceId: config.intakeSourceId,
        automationId: dispatch.automationId === '' ? (config.workerAutomationId ?? '') : dispatch.automationId,
        eventId: dispatch.eventId,
        occurredAt: dispatch.occurredAt,
      })
      this.#deps.store.markDispatchDispatched(item.id, occurrence.id)
      return true
    } catch (error) {
      const code = peerCode(error)
      // The persisted identity already belongs to a different event. Generation
      // scoping makes this deterministic corruption rather than a replay, so it
      // is recorded under its own reason and surfaced as a typed error instead
      // of being laundered into a generic permanent failure.
      if (code === 'idempotency-conflict') {
        this.#deps.store.markDispatchFailed(item.id, 'idempotency-conflict')
        throw new WorkItemError('dispatch-failed', 'worker automation wake hit a conflicting event identity', code)
      }
      // A fail-closed policy refusal is a definitive answer: the occurrence was
      // never created, and re-waking cannot change the policy decision.
      if (code === 'policy-denied' || code === 'policy') {
        this.#deps.store.markDispatchFailed(item.id, 'policy-denied')
        return false
      }
      // Anything else is ambiguous: the peer may have committed the occurrence
      // before the failure. Record that honestly and spend the generation's one
      // bounded retry on the identical identity, so the retry either resolves
      // the committed occurrence or creates it.
      try {
        this.#deps.store.markDispatchUnknown(item.id)
      } catch {
        // If even the bookkeeping write fails, surface the original peer error;
        // the row stays in whatever durable state the failed write left it.
      }
      throw new WorkItemError('dispatch-failed', 'worker automation wake outcome is unknown', code)
    }
  }

  /**
   * Apply the admission-mandate gate to one pending wake.
   *
   * A denied, missing, failing or malformed decision parks the item in
   * `waiting` and returns `false`; an allow records the successful revalidation
   * (lifting only a wait this gate created) and returns `true`. Items admitted
   * before schema v7 have no basis and keep the legacy behaviour.
   */
  #revalidate(item: WorkItemRecord): boolean {
    const authority = this.#deps.authority
    if (authority === undefined) return true
    const check = authority.check(item)
    if (check.kind === 'legacy') return true
    if (check.kind === 'revoked') {
      this.#deps.ledger.parkAuthority(item, 'authority-revoked', { reason: check.reasonCode })
      return false
    }
    if (check.kind === 'unavailable') {
      this.#deps.ledger.parkAuthority(item, 'authority-unavailable', { reason: check.detail })
      return false
    }
    this.#deps.ledger.restoreAuthority(item)
    return true
  }

  /**
   * Bounded lazy sweep over dispatch rows this host still owes a run.
   *
   * Unknown-outcome rows get their one same-generation retry first, then due
   * pending rows are woken normally. Nothing here runs on a timer: the sweep is
   * driven by the existing claim/admit/report touches and by startup.
   */
  wakePending(limit = 10): readonly WorkItemRecord[] {
    const woken: WorkItemRecord[] = []
    const seen = new Set<string>()
    // One row's peer failure must not abort recovery for the rest: the durable
    // row already records its own state/reason. Only the expected ambiguous-wake
    // outcome is swallowed; a missing dependency, storage fault or invalid state
    // is a host/programming error and must surface instead of sweeping silently.
    const attempt = (itemId: string, retryUnknown: boolean): void => {
      const item = this.#deps.store.findItemById(itemId)
      if (item === undefined || item.observed || !OPEN_STATES.includes(item.state)
        || item.workerAutomationId !== this.#deps.config.workerAutomationId
        || this.#deps.store.getContinuation(item.id) !== undefined) return
      try {
        if (retryUnknown) this.#deps.store.retryUnknownDispatch(item.id)
        if (this.wake(item)) woken.push(item)
      } catch (error) {
        if (!(error instanceof WorkItemError) || error.code !== 'dispatch-failed') throw error
      }
      seen.add(item.id)
    }
    for (const dispatch of this.#deps.store.listRetryableUnknownDispatches(limit)) attempt(dispatch.itemId, true)
    for (const dispatch of this.#deps.store.listOpenDispatches(limit)) {
      if (seen.has(dispatch.itemId)) continue
      attempt(dispatch.itemId, false)
    }
    return Object.freeze(woken)
  }

  /** Build the owner-facing notification for one terminal report. */
  notification(item: WorkItemRecord, report: WorkItemReportRecord): WorkItemNotification {
    const lines = [
      `**Work item ${report.status}: ${item.title}**`,
      '',
      report.summary,
      '',
      `- item: \`${item.id}\``,
      `- kind: \`${item.kind}\``,
      `- external id: \`${item.externalId}\``,
      `- attempt: ${String(item.attempt)} of ${String(item.maxAttempts)}`,
    ]
    if (report.artifactPaths.length > 0) {
      lines.push('', 'Artifacts:')
      for (const path of report.artifactPaths) lines.push(`- \`${path}\``)
    }
    if (report.truncated) lines.push('', '_The report was truncated at the configured byte limit._')
    return Object.freeze({
      item,
      report,
      text: lines.join('\n'),
      idempotencyKey: report.deliveryKey,
      format: 'markdown',
    })
  }

  /** True when this report status escalates to the owner. */
  shouldNotify(report: WorkItemReportRecord): boolean {
    return this.#deps.config.notifyOn.includes(report.status)
  }

  /**
   * Send one terminal notification through the delivery outbox.
   *
   * Delivery owns retry and the fail-closed policy check; the ledger only
   * records the outcome, including `unknown` when the enqueue result is lost.
   */
  async notify(item: WorkItemRecord, report: WorkItemReportRecord): Promise<boolean> {
    const config = this.#deps.config
    if (!isActive(config)) return false
    if (!this.shouldNotify(report)) return false
    const delivery = typeof this.#deps.delivery === 'function' ? this.#deps.delivery() : this.#deps.delivery
    if (delivery === undefined) fail('missing-dependency', 'assistantDelivery is required to notify the owner')
    // Feedback evidence binds the complete immutable bytes. Node 24's ordinary
    // TEXT projection may hide a NUL suffix; use the bounded byte reader when
    // this explicit metadata capability is enabled, without changing legacy sends.
    const completeReport = config.ownerReportFeedback ? this.#deps.store.feedbackReportByRevision(item.id, report.revision) ?? report : report
    const notification = this.notification(item, completeReport)
    this.#deps.ledger.recordDelivery(item.id, report.revision, 'pending', null)
    try {
      const input = {
        sourceId: config.intakeSourceId,
        workspace: item.scope.workspace,
        bindingId: item.originBindingId,
        idempotencyKey: notification.idempotencyKey,
        text: notification.text,
        format: 'markdown' as const,
      }
      // Opt-in cross-channel route: the Host keeps the origin while it is
      // available and otherwise queues one inspect-only report on an owner-
      // listed linked channel. Absent config never calls this seam.
      const linkedFallback = config.ownerReportRouting?.linkedFallback
      if (linkedFallback !== undefined && typeof delivery.routeWorkItemReport === 'function') {
        const routed = delivery.routeWorkItemReport({ sourceId: input.sourceId, workspace: input.workspace, originBindingId: input.bindingId,
          idempotencyKey: input.idempotencyKey, text: input.text, format: input.format, itemId: item.id, reportRevision: report.revision, linkedFallback,
          ...(config.ownerReportRouting?.prefer === 'recent' ? { prefer: 'recent' as const } : {}) })
        if (routed.route === 'linked') {
          this.#deps.ledger.recordDelivery(item.id, report.revision, 'sent', routed.outbox.id)
          return true
        }
      }
      const typed = (config.ownerReplyContinuation || config.ownerReportFeedback) && delivery.workItemReplyProtocolVersion?.() === 1
        && typeof delivery.enqueueWorkItemReport === 'function'
        && this.#deps.replyReportEligible?.(item, completeReport, notification) === true
      // Eligibility is decided locally before the enqueue. Never fall back
      // after an ambiguous typed enqueue, which could duplicate a real send.
      const outbox = await (typed
        ? delivery.enqueueWorkItemReport!({ ...input, itemId: item.id, reportRevision: report.revision })
        : delivery.enqueueBackground({ ...input, attention: { purpose: 'result', workItemId: item.id } }))
      this.#deps.ledger.recordDelivery(item.id, report.revision, 'sent', outbox.id)
      return true
    } catch (error) {
      const code = peerCode(error)
      // A queue insert that may have committed before an ambiguous failure must
      // never be retried blindly: mark it unknown so the owner sees the gap.
      const state = code === 'missing-binding' || code === 'policy-denied' || code === 'runtime-conflict'
        ? 'failed'
        : 'unknown'
      this.#deps.ledger.recordDelivery(item.id, report.revision, state, null)
      throw new WorkItemError('dispatch-failed', 'owner notification failed', code)
    }
  }

  now(): number {
    return this.#now()
  }
}
