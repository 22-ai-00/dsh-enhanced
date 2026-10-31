/**
 * Shared value shapes for the assistant work-item ledger.
 *
 * The ledger is the only durable authority for external work: every admitted
 * signal becomes one row, and every state transition is either a
 * compare-and-swap claim or an append-only report. No timer, outbox or session
 * store is introduced here; wake-up, execution and delivery stay owned by
 * `assistant-automations`, the native DSH agent run and `assistant-delivery`.
 */

/** Terminal or in-flight lifecycle states of one durable work item. */
export type WorkItemState =
  | 'queued'
  | 'claimed'
  | 'working'
  | 'waiting'
  | 'ready'
  | 'blocked'
  | 'failed'
  | 'dropped'

/** Lifecycle states that count against `maxOpenItems`. */
export const OPEN_STATES: readonly WorkItemState[] = ['queued', 'claimed', 'working', 'waiting']

/** States in which the model may claim the item. */
export const CLAIMABLE_STATES: readonly WorkItemState[] = ['queued', 'waiting']

/** States after which no further claim is possible without a new admission. */
export const TERMINAL_STATES: readonly WorkItemState[] = ['ready', 'blocked', 'failed', 'dropped']

/** Status a worker may report. `progress` keeps the item open and renews the lease. */
export type WorkItemReportStatus = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed'

/** Report statuses that end the worker's ownership of the item. */
export const TERMINAL_REPORT_STATUSES: readonly WorkItemReportStatus[] = ['ready', 'blocked', 'failed']

/** Delivery escalation state recorded next to a notified report. */
export type WorkItemDeliveryState = 'pending' | 'sent' | 'failed' | 'unknown'

/** Progress of the single automation wake-up that owes the item a run. */
export type WorkItemDispatchState = 'pending' | 'dispatched' | 'failed'

/** Lifecycle of one compare-and-swap claim row. */
export type WorkItemClaimState = 'active' | 'completed' | 'released' | 'expired'

/** Stable, closed error vocabulary. Callers branch on `code`, never on text. */
export type WorkItemErrorCode =
  | 'disabled'
  | 'observe-mode'
  | 'invalid-input'
  | 'source-rejected'
  | 'kind-rejected'
  | 'cooldown'
  | 'rate-limited'
  | 'capacity'
  | 'owner-route-invalid'
  | 'owner-route-expired'
  | 'owner-route-unavailable'
  | 'missing-dependency'
  | 'not-found'
  | 'invalid-state'
  | 'claim-conflict'
  | 'claim-expired'
  | 'retry-exhausted'
  | 'report-limit'
  | 'report-too-large'
  | 'dispatch-failed'
  | 'identity-mismatch'
  | 'storage'

/** Typed failure raised by admission, the ledger and the tools. */
export class WorkItemError extends Error {
  readonly code: WorkItemErrorCode
  readonly detail: string | undefined

  constructor(code: WorkItemErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'WorkItemError'
    this.code = code
    this.detail = detail
  }
}

/** Owner route re-anchored from `assistant-delivery` before every admission. */
export interface WorkItemScope {
  readonly workspace: string
  readonly preset: string
  readonly principalId: string
  readonly ownerRouteId: string
  readonly expiresAt: number
}

/** Receipt-shaped owner evidence captured for one item at admission time. */
export interface WorkItemOwnerEvidence {
  readonly principalRecordId: string
  readonly principalVersion: number
  readonly workspace: string
  readonly agentPreset: string
  readonly bindingVersion: number
  readonly generation: number
}

/** One durable work item. */
export interface WorkItemRecord {
  readonly id: string
  readonly dedupKey: string
  readonly dedupBucket: number
  readonly sourceId: string
  readonly kind: string
  readonly externalId: string
  readonly title: string
  readonly brief: string
  readonly briefTruncated: boolean
  readonly originBindingId: string
  readonly acceptanceRef: string | null
  readonly scope: WorkItemScope
  readonly owner: WorkItemOwnerEvidence
  readonly workerAutomationId: string
  readonly state: WorkItemState
  readonly stateReason: string | null
  readonly attempt: number
  readonly maxAttempts: number
  readonly leaseUntil: number | null
  readonly leaseRunId: string | null
  readonly occurrenceId: string | null
  readonly workDir: string
  readonly lastReportStatus: WorkItemReportStatus | null
  readonly observed: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

/** Append-only lifecycle event; never rewritten. */
export interface WorkItemEventRecord {
  readonly itemId: string
  readonly sequence: number
  readonly kind: string
  readonly actor: string
  readonly detail: string | null
  readonly recordedAt: number
}

/** One compare-and-swap claim; a run may own several across lease renewals. */
export interface WorkItemClaimRecord {
  readonly claimId: number
  readonly itemId: string
  readonly runId: string
  readonly occurrenceId: string
  readonly state: WorkItemClaimState
  readonly leasedUntil: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** One append-only worker report revision. */
export interface WorkItemReportRecord {
  readonly itemId: string
  readonly revision: number
  readonly status: WorkItemReportStatus
  readonly summary: string
  readonly truncated: boolean
  readonly artifactPaths: readonly string[]
  readonly idempotencyKey: string
  readonly deliveryKey: string
  readonly deliveryState: WorkItemDeliveryState | null
  readonly deliveryId: string | null
  readonly recordedAt: number
}

/** The single wake-up owed for one admitted item. */
export interface WorkItemDispatchRecord {
  readonly itemId: string
  readonly automationId: string
  readonly eventId: string
  readonly occurredAt: number
  readonly state: WorkItemDispatchState
  readonly occurrenceId: string | null
  readonly reason: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

/** Input accepted by `assistantWorkItems.admit()`. */
export interface WorkItemAdmitInput {
  readonly kind: string
  readonly externalId: string
  readonly title: string
  readonly brief: string
  readonly originBindingId: string
  readonly acceptanceRef?: string
}

/** Result of one admission attempt. */
export interface WorkItemAdmitResult {
  readonly item: WorkItemRecord
  readonly created: boolean
  readonly dispatch: WorkItemDispatchRecord
}

/** Notification intent derived from a terminal report. */
export interface WorkItemNotification {
  readonly item: WorkItemRecord
  readonly report: WorkItemReportRecord
  readonly text: string
  readonly idempotencyKey: string
  readonly format: 'markdown'
}

/** Bounded runtime health projection; never exposes paths or briefs. */
export interface WorkItemHealth {
  readonly enabled: boolean
  readonly mode: 'observe' | 'active'
  readonly openItems: number
  readonly lastAdmitAt: number | null
  readonly lastDispatchAt: number | null
  readonly dispatchUnknown: number
  readonly workerConnected: boolean
  readonly ownerRouteValid: boolean
}
