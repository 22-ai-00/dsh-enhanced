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
  | 'authority-revoked'
  | 'authority-unavailable'
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

/**
 * The admission decision an item was admitted under, persisted as audit-only.
 *
 * The fields are frozen at admission and never recomputed from the current
 * configuration; revalidation replays the *identical* request and idempotency
 * key against `assistant-policy`, which stays the only authority. This record
 * grants nothing by itself.
 */
export interface WorkItemAuthorityBasis {
  /** Literal protocol marker; a different value is treated as malformed. */
  readonly protocol: 'work-items/authority/v1'
  readonly action: 'admit'
  readonly subjectKind: 'background'
  /** Intake source id at admission; the dedup identity can shift later. */
  readonly sourceId: string
  readonly automationId: string
  readonly workspace: string
  readonly principal: string
  readonly resourceKind: 'automation'
  readonly effect: 'allow'
  readonly reasonCode: string
  readonly ruleId?: string
  readonly idempotencyKey: string
  readonly checkedAt: number
  /**
   * Present only on items admitted through `admitDecision(...)`. Frozen with
   * the basis in the same JSON column; grants nothing on its own.
   */
  readonly mandate?: WorkItemMandateBasis
}

/** Where an execute decision came from. */
export type WorkItemDecisionOrigin = 'explicit' | 'inferred'

/** Mode the deciding intake ran in when it produced the decision. */
export type WorkItemDecisionMode = 'observe' | 'auto'

/**
 * Narrow, producer-agnostic execute decision handed to `admitDecision(...)`.
 *
 * Deliberately independent of any intake ledger shape: the producer maps its
 * own decision into this record. `decisionId` is the replay identity; the same
 * id always resolves to the same work item.
 */
export interface WorkItemExecuteDecision {
  readonly protocol: 'work-items/execute-decision/v1'
  readonly decisionId: string
  readonly verdict: 'execute'
  readonly origin: WorkItemDecisionOrigin
  readonly mode: WorkItemDecisionMode
  /** Policy rule the decision claims to rely on; required for `inferred`. */
  readonly policyRuleId?: string
  /** Remaining budget units the producer reported at decision time. */
  readonly budgetRemaining: number
  /** The admitted scope of work. Frozen into the item; nothing outside it is admitted. */
  readonly mandate: Readonly<{
    kind: string
    title: string
    brief: string
    originBindingId: string
    /** TaskAcceptanceContract reference the work is accepted against. */
    acceptanceRef: string
  }>
  /**
   * Optional handle of an already-prepared TaskAcceptanceContract (WP21 slice 4).
   *
   * Only the handle crosses: admission re-reads the contract from the
   * independent verifier itself and never trusts a caller-supplied body or
   * verdict. When present, the item's completion is judged by that verifier.
   */
  readonly acceptance?: WorkItemAcceptanceHandle
}

/** Handle naming one verifier-held TaskAcceptanceContract. */
export interface WorkItemAcceptanceHandle {
  readonly contractId: string
  readonly contractDigest: string
}

/** Host producer that froze a TaskAcceptanceContract, derived from its task kind. */
export type WorkItemAcceptanceAuthor = 'assistant-automations' | 'assistant-delivery' | 'assistant-goals'

/**
 * Frozen summary of the TaskAcceptanceContract an item is accepted against.
 *
 * Read from the verifier at admission and stored inside the mandate, so the
 * item's acceptance terms cannot drift after admission. The author (the Host
 * producer that froze the contract), the verifier and the executor
 * (`assistant-work-items`' worker) are three distinct identities.
 */
export interface WorkItemAcceptanceBinding {
  readonly protocol: 'work-items/acceptance-binding/v1'
  readonly verifier: 'assistant-verifier'
  readonly author: WorkItemAcceptanceAuthor
  readonly contractId: string
  readonly contractDigest: string
  readonly taskKind: string
  /** acceptanceDigest of the contract's task identity. */
  readonly taskDigest: string
  /** acceptanceDigest of the contract's objective text. */
  readonly objectiveDigest: string
  readonly profileDigest: string
  readonly criteria: number
  readonly expiresAt: number
}

/** Frozen record of the decision an item was admitted for. */
export interface WorkItemMandateBasis {
  readonly protocol: 'work-items/mandate/v1'
  readonly decisionId: string
  readonly origin: WorkItemDecisionOrigin
  readonly mode: WorkItemDecisionMode
  readonly ruleId?: string
  readonly budgetRemaining: number
  /** sha256 over the decision identity (id, origin, rule, mandate fields); excludes mode and budget. */
  readonly digest: string
  /** Independent acceptance binding; absent for decisions admitted without one. */
  readonly acceptance?: WorkItemAcceptanceBinding
}

/** Deterministic reasons an execute decision is refused before any durable write. */
export type WorkItemDecisionRefusal =
  | 'inferred-requires-auto'
  | 'inferred-requires-rule'
  | 'budget-exhausted'
  | 'policy-rule-mismatch'
  /** No verifier peer, or it holds no contract under the handle. */
  | 'acceptance-unavailable'
  /** The verifier's contract is invalid or differs from the handle or the item's owner scope. */
  | 'acceptance-mismatch'
  | 'acceptance-expired'
  /** The contract was already verified (or needs attention) before this work began. */
  | 'acceptance-already-settled'
  /** Author, verifier and executor are not three distinct identities. */
  | 'acceptance-not-independent'
  | 'acceptance-not-awaiting'
  | 'acceptance-contract-bound'

/**
 * Verdict read back from the independent verifier for one bound item.
 *
 * `objectiveStatus` is derived by `validateTaskVerificationReceipt` from the
 * receipt's criterion results; no caller or worker input reaches it.
 */
export interface WorkItemAcceptanceVerdict {
  readonly itemId: string
  readonly verifier: 'assistant-verifier'
  readonly contractId: string
  readonly contractDigest: string
  readonly receiptId: string
  readonly receiptDigest: string
  readonly objectiveStatus: 'achieved' | 'not-achieved' | 'unknown'
  readonly completedAt: number
  readonly recordedAt: number
}

/**
 * WP21 slice 6: a worker run's own acceptance contract bound after wake as an
 * append-only event, outside the mandate digest. The latest row is current;
 * it only settles while `occurrenceId` is still the item's occurrence.
 */
export interface WorkItemLateAcceptanceBinding {
  readonly itemId: string
  readonly occurrenceId: string
  readonly binding: WorkItemAcceptanceBinding
  readonly recordedAt: number
}

/** `blocked` reasons `acceptance.verdictGate` writes; the state itself is the existing `blocked`. */
export type WorkItemAcceptanceBlockReason = 'acceptance-not-achieved' | 'acceptance-unknown' | 'acceptance-needs-attention'

/** The executed generation a verdict gate may move: compare-and-swap inputs. */
export type WorkItemAcceptanceGateExpectation = Readonly<{ attempt: number; occurrenceId: string | null }>

export type WorkItemAcceptanceSettleResult =
  /** The verifier peer is missing or could not answer; nothing was written. */
  | Readonly<{ outcome: 'unavailable'; detail: string }>
  /** The verifier no longer holds the frozen contract, or its receipt does not validate; nothing was written. */
  | Readonly<{ outcome: 'drift'; detail: string }>
  | Readonly<{ outcome: 'pending'; state: 'awaiting-execution' | 'pending' | 'verifying' }>
  /** `blockedReason` is present only when `acceptance.verdictGate` moved the item to `blocked` on this call. */
  | Readonly<{ outcome: 'needs-attention'; reason: string | null; blockedReason?: WorkItemAcceptanceBlockReason }>
  | Readonly<{ outcome: 'verified' | 'already-verified'; verdict: WorkItemAcceptanceVerdict; blockedReason?: WorkItemAcceptanceBlockReason }>
  /** A different receipt already settled this item (first receipt wins); nothing was written. */
  | Readonly<{ outcome: 'identity-mismatch'; verdict: WorkItemAcceptanceVerdict; receiptDigest: string }>

export type WorkItemDecisionAdmitResult =
  | Readonly<{ outcome: 'admitted'; item: WorkItemRecord; dispatch: WorkItemDispatchRecord; mandate: WorkItemMandateBasis }>
  /** The decision id already owns an item (any state); no second item is opened. */
  | Readonly<{ outcome: 'replayed'; item: WorkItemRecord; dispatch: WorkItemDispatchRecord; mandate: WorkItemMandateBasis }>
  | Readonly<{ outcome: 'refused'; reasonCode: WorkItemDecisionRefusal }>

/**
 * Host-supplied notice that the Policy peer now runs under a new version.
 *
 * `policyVersion` is opaque to this plugin (a config digest, a revision
 * counter); it only names the change so each affected item is notified once.
 */
export interface WorkItemPolicyChange {
  readonly protocol: 'work-items/policy-change/v1'
  readonly policyVersion: string
  /** Continue a pass that returned `next`; omitted to start from the oldest live item. */
  readonly after?: WorkItemPolicyNoticeCursor
}

/** Position of the last live item one notice pass assessed (admission order). */
export interface WorkItemPolicyNoticeCursor {
  readonly createdAt: number
  readonly id: string
}

/** Durable per-item notice that a Policy change affects its frozen basis. Never cancels. */
export interface WorkItemPolicyNotice {
  readonly itemId: string
  readonly policyVersion: string
  /** `mandate-rule-changed`, `malformed-basis`, or the Policy deny reason. */
  readonly reasonCode: string
  /** Rule the item's mandate (or basis) was admitted under; `null` when none was named. */
  readonly frozenRuleId: string | null
  /** Rule the current Policy decided by; `null` on deny or an unnamed allow. */
  readonly currentRuleId: string | null
  readonly decisionId: string | null
  readonly recordedAt: number
}

export type WorkItemPolicyChangeResult =
  | Readonly<{
    outcome: 'noticed'
    policyVersion: string
    /** Notices written by this call. */
    notified: readonly WorkItemPolicyNotice[]
    /** Items already notified for this version (restart / replay). */
    alreadyNotified: readonly string[]
    /** Live items whose basis still holds under the new Policy. */
    unaffected: number
    /** Live pre-v7 items without a basis; nothing to compare against. */
    legacy: number
    /** Items Policy could not answer for now; a later call with the same version retries them. */
    unavailable: readonly string[]
    /** Live items after this page; pass `next` as `after` to assess them. `null` when the pass is complete. */
    next: WorkItemPolicyNoticeCursor | null
    remaining: number
  }>
  /** The Policy peer is missing or cannot evaluate side-effect free; nothing was written. */
  | Readonly<{ outcome: 'unavailable'; detail: string }>

/**
 * One human follow-up message on an item's work thread, handed over by the
 * host that observed it. The message text stays with its producer; the item
 * owns only its identity.
 */
export interface WorkItemFollowUpInput {
  readonly protocol: 'work-items/follow-up/v1'
  readonly itemId: string
  /** Work thread binding; must equal the item's `originBindingId`. */
  readonly bindingId: string
  readonly messageId: string
  /** Producer digest of the message; part of the follow-up identity. */
  readonly sourceDigest: string
}

/** `owned` while the item is live; `processed` by the item; `released` back to judgment after the item ended. */
export type WorkItemFollowUpState = 'owned' | 'processed' | 'released'

export interface WorkItemFollowUpRecord {
  readonly itemId: string
  readonly messageId: string
  readonly bindingId: string
  readonly sourceDigest: string
  readonly state: WorkItemFollowUpState
  readonly ownedAt: number
  /** When it was processed or released; `null` while owned. */
  readonly settledAt: number | null
  /** Terminal item state a released follow-up was released from. */
  readonly releasedFrom: WorkItemState | null
}

export type WorkItemFollowUpOwnResult =
  | Readonly<{ outcome: 'owned' | 'already-owned'; followUp: WorkItemFollowUpRecord }>
  /** The item already ended: nothing is written and the message stays with judgment. */
  | Readonly<{ outcome: 'item-ended'; itemId: string; state: WorkItemState }>

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
  /** Audit-only revalidation basis; `null` means a pre-v7 (legacy) item. */
  readonly authority: WorkItemAuthorityBasis | null
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

/** One attempt end as reconstructed from the append-only event ledger. */
export interface WorkItemResumeAttempt {
  readonly attempt: number
  readonly runId: string | null
  readonly startedAt: number
  readonly ended: 'expired' | 'reclaimed' | 'attempt-exhausted' | 'reported' | 'settled' | null
  readonly terminalStatus: WorkItemReportStatus | null
}

/** One prior worker report summary, bounded for the resume brief. */
export interface WorkItemResumeReport {
  readonly revision: number
  readonly status: WorkItemReportStatus
  readonly summary: string
  readonly summaryTruncated: boolean
  readonly recordedAt: number
}

/** Compact latest settled outcome; evidence, baseline, inbox and authority stay out. */
export interface WorkItemResumeOutcome {
  readonly revision: number
  readonly settledBy: WorkItemOutcomeSettledBy
  readonly executionStatus: WorkItemExecutionStatus
  readonly objectiveStatus: WorkItemObjectiveStatus
  readonly evidenceState: WorkItemOutcomeEvidenceState
  readonly evidenceReason: WorkItemOutcomeEvidenceReason | null
  readonly settledAt: number
}

/**
 * Bounded, read-only brief for a fresh occurrence continuing an item.
 *
 * Everything here is derived from the local append-only ledger at claim time;
 * it never carries model memory or peer calls, and `truncated` advertises that
 * older attempts or report revisions were cut by the fixed caps.
 */
export interface WorkItemResumeContext {
  readonly resumed: boolean
  readonly priorAttempts: number
  readonly attempts: readonly WorkItemResumeAttempt[]
  readonly reports: readonly WorkItemResumeReport[]
  readonly reportsTotal: number
  readonly latestOutcome: WorkItemResumeOutcome | null
  readonly truncated: boolean
}

/**
 * The single wake-up owed for one admitted item.
 *
 * `generation` scopes the external event identity to one delivery attempt of
 * the item. Generation 0 is admission and keeps the historical identity
 * (`eventId === itemId`, `occurredAt === item.createdAt`); every re-arm
 * increments it and derives a fresh deterministic `eventId`, because the
 * automation intake dedupes occurrences by `(automationId, eventId,
 * occurredAt)` and would otherwise replay the *completed* occurrence instead of
 * starting a new run.
 *
 * `wakeAttempts` counts ambiguous wake failures inside the current generation.
 * It bounds recovery to exactly one re-wake: the row is retryable while the
 * value is 1, and a second ambiguous failure leaves the row failed so the gap
 * stays visible instead of looping forever.
 */
export interface WorkItemDispatchRecord {
  readonly itemId: string
  readonly automationId: string
  readonly eventId: string
  readonly occurredAt: number
  readonly generation: number
  readonly wakeAttempts: number
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

/**
 * One external thread this item follows for settlement.
 *
 * `kind` is the registered thread source (lower-kebab), `ref` is that source's
 * own host identifier. Nothing here is authenticated by this plugin; resolution
 * is the registered source's synchronous, read-only answer.
 */
export interface WorkItemThreadRef {
  readonly kind: string
  readonly ref: string
}

/** Whether a followed thread has finished. */
export type WorkItemThreadClosureState = 'open' | 'closed'

/** How a closed thread ended, as its own source reports it. */
export type WorkItemThreadOutcome = 'succeeded' | 'failed' | 'cancelled' | 'unknown'

/** One synchronous, read-only observation of a followed thread. */
export interface WorkItemThreadClosure {
  readonly state: WorkItemThreadClosureState
  readonly outcome: WorkItemThreadOutcome
  /** The source's own canonical revision identity for this observation. */
  readonly digest: string
  readonly observedAt?: number
}

/**
 * Host-only registration of one thread source.
 *
 * `resolve` must be synchronous and read-only: it observes, it never mutates
 * the host or the ledger. `undefined` means "this source cannot answer right
 * now", which keeps the follow open rather than guessing a closure.
 */
export interface WorkItemThreadSourceRegistration {
  /** Stable lower-kebab id; also the `kind` an admission follows. */
  readonly source: string
  /** Registration generation; a follow records it and a stale one cannot close. */
  readonly generation: string
  resolve(ref: string): WorkItemThreadClosure | undefined
  /**
   * Optional admission-time ref check. Synchronous and read-only; returning
   * false (or throwing) rejects the admission with `invalid-input` before any
   * write, so a source can refuse a ref that would close on stale evidence.
   */
  validate?(ref: string): boolean
}

/** Persisted lifecycle of one followed thread. */
export type WorkItemFollowState = 'open' | 'closed'

/** Why an open follow currently cannot be resolved; never a silent loss. */
export type WorkItemFollowDegradedReason = 'source-missing' | 'resolver-failed' | 'generation-mismatch'

/** One persisted follow of an item's settlement on an external thread. */
export interface WorkItemFollowRecord {
  readonly itemId: string
  readonly position: number
  readonly kind: string
  readonly ref: string
  readonly state: WorkItemFollowState
  /** Only a closed follow carries an outcome (and its source digest). */
  readonly outcome: WorkItemThreadOutcome | null
  readonly digest: string | null
  /** Registered source at admission; persisted for audit and fencing. */
  readonly source: string
  /** Source generation at admission; a newer registration cannot close this follow. */
  readonly sourceGeneration: string
  readonly openedAt: number
  readonly closedAt: number | null
}

/** Bounded follow health projection; counts only, never refs or digests. */
export interface WorkItemFollowHealth {
  readonly open: number
  readonly closed: number
  /**
   * Open follows this host currently cannot resolve: the source is no longer
   * registered, its generation moved, or its resolver failed. Such an item
   * stays `waiting` and is never guessed closed.
   */
  readonly unresolved: number
  readonly degraded: WorkItemFollowDegradedReason | null
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
  /**
   * Threads whose eventual closure bounds this item's settlement wait.
   *
   * A follow is not authority: it can only end the bounded wait early and park
   * the item in `waiting` while the thread is open. It never asserts that the
   * objective was achieved, and it cannot observe delivery evidence.
   */
  readonly follows?: readonly WorkItemThreadRef[]
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

/** Admission-authority revalidation projection for one health read. */
export interface WorkItemAuthorityHealth {
  /** Open items admitted before the basis was persisted; they gate nothing. */
  readonly legacy: number
  /** Open items currently parked by a failed revalidation. */
  readonly parked: number
  readonly lastDeniedAt: number | null
  readonly lastDeniedReason: string | null
}

/** Bounded runtime health projection; never exposes paths or briefs. */
export interface WorkItemHealth {
  readonly enabled: boolean
  readonly mode: 'observe' | 'active'
  readonly openItems: number
  readonly lastAdmitAt: number | null
  readonly lastDispatchAt: number | null
  /**
   * Dispatch rows failed with `unknown_after_send`: the peer may or may not
   * have committed the occurrence. Non-zero means the database really holds
   * such a gap; recovery retries each row once and then leaves it visible.
   */
  readonly dispatchUnknown: number
  readonly workerConnected: boolean
  readonly ownerRouteValid: boolean
  readonly settlement: WorkItemSettlementHealth
  readonly evaluation: WorkItemEvaluationHealth
  readonly follows: WorkItemFollowHealth
  readonly authority: WorkItemAuthorityHealth
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
  /**
   * A followed thread closed and ended the bounded wait. Thread closure is not
   * independent delivery evidence, so the revision stays `unverified`.
   */
  | 'closed-by-thread'

/** Which durable transition appended this outcome revision. */
export type WorkItemOutcomeSettledBy =
  | 'report-ready'
  | 'report-blocked'
  | 'report-failed'
  | 'withdrawn'
  | 'retry-exhausted'
  | 'observed-evidence'
  | 'window-expired'
  /** Every followed thread closed; the deferred terminal report settled the item. */
  | 'closed-by-thread'

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
  /**
   * Whether this revision has been handed to the trusted Evaluation producer
   * seam. Only the newest revision of an item is ever exportable, and only once
   * its evidence state is no longer `pending`.
   */
  readonly evaluationState: WorkItemEvaluationState
  /** Digest of the exact claims exported, so a replay is provably identical. */
  readonly evaluationDigest: string | null
  readonly evaluationRecordedAt: number | null
  /** Bounded export attempts; a stuck row stays visible instead of looping. */
  readonly evaluationAttempts: number
}

/** Trusted Evaluation export state of one settled outcome revision. */
export type WorkItemEvaluationState = 'pending' | 'exported' | 'skipped'

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
  /**
   * Items still parked in `waiting` because at least one followed thread stayed
   * open (or was unresolvable) this pass.
   */
  readonly deferred: number
  /** Items whose deferred terminal report settled because all follows closed. */
  readonly closedByThread: number
  /** Resolution degradation observed this pass; `null` when every source spoke. */
  readonly followDegraded: WorkItemFollowDegradedReason | null
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

/** Bounded trusted-Evaluation export health projection; never exposes claims. */
export interface WorkItemEvaluationHealth {
  /** True only in `active` mode, where settlement can actually export. */
  readonly enabled: boolean
  /** The trusted Evaluation producer discovered a sink on the host, if any. */
  readonly connected: boolean
  /** Settled revisions not yet exported; non-zero with no sink is a visible gap. */
  readonly pending: number
  readonly exported: number
  readonly skipped: number
  /** Set when the last export attempt failed and the row stays retryable. */
  readonly degraded: string | null
}
