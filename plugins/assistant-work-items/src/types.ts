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

/**
 * Provenance of an automatically derived signal.
 *
 * The digest is the source's own canonical revision identity; it is never a
 * hash of the owner-facing text, so a reworded but unchanged signal keeps its
 * identity while a genuinely new revision changes it.
 */
export interface WorkItemProvenance {
  readonly source: string
  readonly sourceVersion: string
  readonly signalDigest: string
  readonly observedAt: number
  readonly evidence?: Readonly<Record<string, string | number | boolean>>
}

/** Input accepted by `assistantWorkItems.admit()`. */
export interface WorkItemAdmitInput {
  readonly kind: string
  readonly externalId: string
  readonly title: string
  readonly brief: string
  readonly originBindingId: string
  readonly acceptanceRef?: string
  readonly provenance?: WorkItemProvenance
}

/** Why an admission did not create a new item. */
export type WorkItemAdmitReason = 'duplicate' | 'fenced'

/** What a withdrawal did to the item the canonical signal already produced. */
export type WorkItemWithdrawOutcome =
  /** An open item was moved to `dropped` and its pending dispatch failed. */
  | 'withdrawn'
  /** The item was already terminal; nothing changed (idempotent no-op). */
  | 'settled'
  /** No item was ever admitted for this canonical signal. */
  | 'absent'

/** Result of one withdrawal attempt. */
export interface WorkItemWithdrawResult {
  readonly outcome: WorkItemWithdrawOutcome
  /**
   * Items actually retired for `withdrawn` (there can be more than one when an
   * older, still-open row lived in a previous dedup window), the newest item for
   * `settled`, and empty for `absent`.
   */
  readonly items: readonly WorkItemRecord[]
}

/** Result of one admission attempt. */
export interface WorkItemAdmitResult {
  readonly item: WorkItemRecord
  readonly created: boolean
  /** Present only when `created` is `false`. */
  readonly reason?: WorkItemAdmitReason
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
  readonly settlement: WorkItemSettlementHealth
}

/**
 * How the guarded execution ended, as independently recorded by
 * `assistant-delivery`.
 *
 * `unknown` is the honest default: the absence of evidence is not evidence of
 * success, and a worker claiming success is not an execution outcome.
 */
export type WorkItemExecutionStatus = 'succeeded' | 'failed' | 'timed-out' | 'cancelled' | 'unknown'

/**
 * Objective outcome of the admitted work.
 *
 * Only an independent verifier may ever assert `achieved` or `partial`; this
 * plugin derives nothing into those values from a worker self-report, and no
 * automatic path sets them at all.
 */
export type WorkItemObjectiveStatus = 'achieved' | 'partial' | 'not-achieved' | 'unknown'

/** Who produced the execution/objective claim recorded on one outcome. */
export type WorkItemOutcomeTrust = 'agent-self-report' | 'external-receipt' | 'deterministic-check'

/** Independent evidence state of one outcome revision. */
export type WorkItemOutcomeEvidenceState = 'pending' | 'observed' | 'unverified' | 'not-applicable'

/** Why an outcome revision carries no usable independent evidence. */
export type WorkItemOutcomeEvidenceReason =
  /** The item's signal has no independent execution channel to observe. */
  | 'no-independent-source'
  /** The observed receipt exceeded the evidence byte budget; it is dropped, never truncated. */
  | 'evidence-too-large'
  /** The bounded settlement window closed with no matching execution. */
  | 'window-expired'
  /** The window closed while the evidence channel was unavailable. */
  | 'channel-unavailable'

/** Which durable transition appended this outcome revision. */
export type WorkItemOutcomeSettledBy =
  | 'report-ready'
  | 'report-blocked'
  | 'report-failed'
  | 'withdrawn'
  | 'retry-exhausted'
  | 'observed-evidence'
  | 'window-expired'

/**
 * Allowlisted evidence captured from the delivery channel.
 *
 * These keys are all authenticated, delivery-owned identities; owner-facing
 * text is deliberately excluded so an outcome never carries owner content.
 */
export interface WorkItemOutcomeEvidence {
  readonly inboxId?: string
  readonly completionSequence?: number
  readonly completedAt?: number
  readonly executionStatus?: string
  readonly sourceDigest?: string
  readonly bindingVersion?: number
  readonly bindingGeneration?: number
  readonly scope?: string
}

/**
 * One append-only outcome revision.
 *
 * A terminal lifecycle state (`ready`, `blocked`, …) is a *report*, not proof:
 * it says the worker stopped owning the item. This record is the separate,
 * independently sourced evidence trail, and it only ever moves forward by
 * appending a new revision for the same item.
 */
export interface WorkItemOutcomeRecord {
  readonly itemId: string
  readonly revision: number
  readonly settledBy: WorkItemOutcomeSettledBy
  readonly executionStatus: WorkItemExecutionStatus
  readonly objectiveStatus: WorkItemObjectiveStatus
  readonly trust: WorkItemOutcomeTrust
  readonly evidenceState: WorkItemOutcomeEvidenceState
  readonly evidenceReason: WorkItemOutcomeEvidenceReason | null
  readonly evidence: WorkItemOutcomeEvidence | null
  /** The admitted execution's completion sequence this outcome is fenced above. */
  readonly baselineSequence: number | null
  readonly inboxId: string | null
  /** Authority hash admitted with this execution; the fence a receipt must match. */
  readonly authorityHash: string | null
  /** Deadline of the bounded settlement window; only pending outcomes have one. */
  readonly deadlineAt: number | null
  readonly settledAt: number
  readonly recordedAt: number
}

/** One outcome revision joined with the report/delivery coordinates it refers to. */
export interface WorkItemOutcomeView {
  readonly outcome: WorkItemOutcomeRecord
  readonly deliveryState: WorkItemDeliveryState | null
  readonly reportRevision: number | null
}

/** Result of one bounded settlement pass. Host-only; never admits or wakes. */
export interface WorkItemSettlementReport {
  readonly skipped: 'disabled' | 'not-due' | 'no-pending' | null
  readonly degraded: 'missing-dependency' | 'owner-route-unavailable' | null
  /** True only when the evidence channel was reached but failed. */
  readonly failed: boolean
  readonly scanned: number
  readonly settled: number
  readonly expired: number
  /** Item ids whose pending window resolved to an observed receipt this pass. */
  readonly observedItemIds: readonly string[]
}

/** Bounded settlement health projection. */
export interface WorkItemSettlementHealth {
  readonly enabled: boolean
  readonly pending: number
  readonly observed: number
  readonly unverified: number
  readonly degraded: string | null
}
