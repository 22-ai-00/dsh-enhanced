import type { NormalizedConfig } from './config.ts'
import { isActive } from './config.ts'
import type { WorkItemLedger } from './ledger.ts'
import type { PeerAutomationsService, PeerDeliveryService } from './peers.ts'
import type { WorkItemStore } from './store.ts'
import type { WorkItemNotification, WorkItemRecord, WorkItemReportRecord } from './types.ts'
import { WorkItemError } from './types.ts'

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
  readonly automations: PeerAutomationsService | undefined
  readonly delivery: PeerDeliveryService | undefined
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
   * Wake the worker automation for one admitted item.
   *
   * The event id is the item id, so a repeated wake is the same external event
   * and the automations store deduplicates it. `occurredAt` therefore must stay
   * the admission timestamp; changing it would look like a new occurrence.
   */
  wake(item: WorkItemRecord): void {
    const config = this.#deps.config
    if (!isActive(config)) return
    const automations = this.#deps.automations
    if (automations === undefined) fail('missing-dependency', 'assistantAutomations is required to wake the worker')
    const dispatch = this.#deps.store.getDispatch(item.id)
    if (dispatch === undefined) fail('storage', 'work item has no dispatch row')
    if (dispatch.state === 'dispatched') return
    try {
      const occurrence = automations.ingestExternal({
        sourceId: config.intakeSourceId,
        automationId: config.workerAutomationId ?? '',
        eventId: item.id,
        occurredAt: dispatch.occurredAt,
      })
      this.#deps.store.markDispatchDispatched(item.id, occurrence.id)
    } catch (error) {
      const code = peerCode(error)
      // The event already exists: a previous wake succeeded but the local
      // bookkeeping did not commit. Recover the occurrence instead of failing.
      if (code === 'idempotency-conflict') {
        this.#deps.store.markDispatchFailed(item.id, 'idempotency-conflict')
        return
      }
      if (code === 'policy-denied' || code === 'policy') {
        this.#deps.store.markDispatchFailed(item.id, 'policy-denied')
        return
      }
      this.#deps.store.markDispatchFailed(item.id, 'dispatch-failed')
      throw new WorkItemError('dispatch-failed', 'worker automation wake failed', code)
    }
  }

  /** Wake every dispatch row still pending, bounded by `limit`. */
  wakePending(limit = 10): readonly WorkItemRecord[] {
    const woken: WorkItemRecord[] = []
    for (const dispatch of this.#deps.store.listOpenDispatches(limit)) {
      const item = this.#deps.store.findItemById(dispatch.itemId)
      if (item === undefined || item.observed) continue
      this.wake(item)
      woken.push(item)
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
    const delivery = this.#deps.delivery
    if (delivery === undefined) fail('missing-dependency', 'assistantDelivery is required to notify the owner')
    const notification = this.notification(item, report)
    this.#deps.ledger.recordDelivery(item.id, report.revision, 'pending', null)
    try {
      const outbox = await delivery.enqueueBackground({
        sourceId: config.intakeSourceId,
        workspace: item.scope.workspace,
        bindingId: item.originBindingId,
        idempotencyKey: notification.idempotencyKey,
        text: notification.text,
        format: 'markdown',
      })
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
