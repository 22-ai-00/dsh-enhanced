/**
 * Outcome derivation: the pure, deterministic rules that turn a durable
 * lifecycle transition or an independently observed receipt into one
 * append-only outcome revision.
 *
 * The central rule of this module is that a worker self-report is never proof.
 * A `ready` report only *opens* a bounded window in which the delivery channel
 * may still produce an authenticated execution receipt; until that receipt is
 * observed, the objective stays `unknown`. No automatic path in this plugin can
 * ever derive `achieved` or `partial`.
 */
import type { PeerOwnerForegroundTaskSource } from './peers.ts'
import type {
  WorkItemExecutionStatus,
  WorkItemObjectiveStatus,
  WorkItemOutcomeEvidence,
  WorkItemOutcomeEvidenceReason,
  WorkItemOutcomeEvidenceState,
  WorkItemOutcomeRecord,
  WorkItemOutcomeSettledBy,
  WorkItemOutcomeTrust,
  WorkItemProvenance,
  WorkItemRecord,
  WorkItemReportStatus,
} from './types.ts'

/** Source version whose receipts are authenticated execution evidence. */
export const OUTCOME_EVIDENCE_SOURCE = 'assistant-delivery/owner-foreground-source/v1'

/**
 * Signal source ids whose admitted items are tied to a guarded execution that
 * `assistant-delivery` can later describe. Everything else has no independent
 * channel and therefore settles as `not-applicable` immediately.
 */
export const SETTLEABLE_SOURCE_IDS: readonly string[] = Object.freeze(['owner-foreground-failures'])

/** Hard cap on the canonical evidence payload; oversized evidence is dropped, never truncated. */
export const MAX_OUTCOME_EVIDENCE_BYTES = 2048

/** Outcome fields a caller supplies; the store owns identity, revision and timestamps. */
export interface WorkItemOutcomeDraft {
  readonly settledBy: WorkItemOutcomeSettledBy
  readonly executionStatus: WorkItemExecutionStatus
  readonly objectiveStatus: WorkItemObjectiveStatus
  readonly trust: WorkItemOutcomeTrust
  readonly evidenceState: WorkItemOutcomeEvidenceState
  readonly evidenceReason: WorkItemOutcomeEvidenceReason | null
  readonly evidence: WorkItemOutcomeEvidence | null
  readonly baselineSequence: number | null
  readonly inboxId: string | null
  /**
   * Authority hash of the receipt that *admitted* this execution.
   *
   * Persisted so a later receipt can be fenced against the admitted owner
   * route rather than against a same-pass value, which would be tautological.
   */
  readonly authorityHash: string | null
  readonly deadlineAt: number | null
  readonly settledAt: number
}

/** The admitted execution an outcome is fenced above. */
export interface SettlementBaseline {
  readonly inboxId: string
  readonly completionSequence: number
  /** Missing/invalid admitted hash still opens the window but can never match. */
  readonly authorityHash: string | null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * Extract the execution baseline from an admission's provenance evidence.
 *
 * Only a settleable source carries one; a malformed or incomplete evidence
 * object yields `null` rather than a guessed baseline, so the item settles as
 * `not-applicable` instead of opening an unverifiable window.
 */
export function settlementBaseline(provenance: WorkItemProvenance | null): SettlementBaseline | null {
  if (provenance === null) return null
  if (!SETTLEABLE_SOURCE_IDS.includes(provenance.source)) return null
  const evidence = provenance.evidence
  if (evidence === undefined) return null
  const inboxId = nonEmptyString(evidence['inboxId'])
  const completionSequence = positiveInteger(evidence['completionSequence'])
  if (inboxId === null || completionSequence === null) return null
  const authorityHash = nonEmptyString(evidence['authorityHash'])
  return Object.freeze({ inboxId, completionSequence, authorityHash })
}

/**
 * Derive the outcome revision for a terminal report.
 *
 * `progress` and `waiting` are not terminal and produce nothing. `ready` is the
 * only status that opens a settlement window, and only when the admitted signal
 * has an independently observable execution.
 */
export function deriveReportOutcome(input: {
  readonly status: WorkItemReportStatus
  readonly provenance: WorkItemProvenance | null
  readonly now: number
  readonly windowMs: number
}): WorkItemOutcomeDraft | null {
  const baseline = settlementBaseline(input.provenance)
  switch (input.status) {
    case 'ready':
      return baseline === null
        ? Object.freeze({
          settledBy: 'report-ready' as const,
          executionStatus: 'succeeded' as const,
          objectiveStatus: 'unknown' as const,
          trust: 'agent-self-report' as const,
          evidenceState: 'not-applicable' as const,
          evidenceReason: 'no-independent-source' as const,
          evidence: null,
          baselineSequence: null,
          inboxId: null,
          authorityHash: null,
          deadlineAt: null,
          settledAt: input.now,
        })
        : Object.freeze({
          settledBy: 'report-ready' as const,
          executionStatus: 'succeeded' as const,
          objectiveStatus: 'unknown' as const,
          trust: 'agent-self-report' as const,
          evidenceState: 'pending' as const,
          evidenceReason: null,
          evidence: null,
          baselineSequence: baseline.completionSequence,
          inboxId: baseline.inboxId,
          authorityHash: baseline.authorityHash,
          deadlineAt: input.now + input.windowMs,
          settledAt: input.now,
        })
    case 'blocked':
      return Object.freeze({
        settledBy: 'report-blocked' as const,
        executionStatus: 'succeeded' as const,
        objectiveStatus: 'not-achieved' as const,
        trust: 'agent-self-report' as const,
        evidenceState: 'not-applicable' as const,
        evidenceReason: null,
        evidence: null,
        baselineSequence: null,
        inboxId: null,
        authorityHash: null,
        deadlineAt: null,
        settledAt: input.now,
      })
    case 'failed':
      return Object.freeze({
        settledBy: 'report-failed' as const,
        executionStatus: 'failed' as const,
        objectiveStatus: 'not-achieved' as const,
        trust: 'agent-self-report' as const,
        evidenceState: 'not-applicable' as const,
        evidenceReason: null,
        evidence: null,
        baselineSequence: null,
        inboxId: null,
        authorityHash: null,
        deadlineAt: null,
        settledAt: input.now,
      })
    case 'progress':
    case 'waiting':
      return null
  }
}

/** Terminal report statuses whose settlement a followed thread can defer. */
export type WorkItemDeferredReportStatus = Extract<WorkItemReportStatus, 'ready' | 'blocked' | 'failed'>

/**
 * Derive the outcome revision for a terminal report that was deferred until its
 * followed threads closed.
 *
 * The report's own honest mapping is reused (a `ready` report stays
 * `objectiveStatus: unknown`, a `blocked`/`failed` report stays
 * `not-achieved`), but the revision is marked as thread-settled: closure is not
 * delivery evidence, so the revision is `unverified` with `closed-by-thread`
 * and never opens another window. This path can never derive `achieved` or
 * `partial`.
 */
export function threadClosureOutcome(input: {
  readonly status: WorkItemDeferredReportStatus
  readonly provenance: WorkItemProvenance | null
  readonly now: number
}): WorkItemOutcomeDraft {
  const base = deriveReportOutcome({ ...input, windowMs: 0 })
  if (base === null) throw new Error('a terminal report status always derives an outcome')
  return Object.freeze({
    ...base,
    settledBy: 'closed-by-thread' as const,
    evidenceState: 'unverified' as const,
    evidenceReason: 'closed-by-thread' as const,
    evidence: null,
    deadlineAt: null,
    settledAt: input.now,
  })
}

/** Derive the outcome for a dropped (withdrawn) item. */
export function deriveWithdrawalOutcome(now: number): WorkItemOutcomeDraft {
  return Object.freeze({
    settledBy: 'withdrawn' as const,
    executionStatus: 'cancelled' as const,
    objectiveStatus: 'unknown' as const,
    trust: 'external-receipt' as const,
    evidenceState: 'not-applicable' as const,
    evidenceReason: null,
    evidence: null,
    baselineSequence: null,
    inboxId: null,
    authorityHash: null,
    deadlineAt: null,
    settledAt: now,
  })
}

/** Derive the outcome for an item whose attempt budget was exhausted. */
export function deriveRetryExhaustedOutcome(now: number): WorkItemOutcomeDraft {
  return Object.freeze({
    settledBy: 'retry-exhausted' as const,
    executionStatus: 'unknown' as const,
    objectiveStatus: 'not-achieved' as const,
    trust: 'agent-self-report' as const,
    evidenceState: 'not-applicable' as const,
    evidenceReason: null,
    evidence: null,
    baselineSequence: null,
    inboxId: null,
    authorityHash: null,
    deadlineAt: null,
    settledAt: now,
  })
}

/**
 * Whether one delivery receipt is evidence for one pending outcome.
 *
 * Every clause is an authenticated identity check: same protocol, same inbox,
 * same owner scope, same principal, same authority hash as the *admission* that
 * opened the window, and a completion strictly newer than the admitted
 * execution's sequence. A receipt for the *original* failed execution
 * (sequence ≤ baseline) therefore never counts as evidence that the repair
 * succeeded, and a receipt minted under a different owner route cannot settle
 * an item admitted under this one.
 */
export function matchesOutcomeEvidence(input: {
  readonly item: WorkItemRecord
  readonly outcome: WorkItemOutcomeRecord
  readonly source: PeerOwnerForegroundTaskSource
  readonly authorityHash: string
}): boolean {
  const { item, outcome, source, authorityHash } = input
  if (source.protocol !== OUTCOME_EVIDENCE_SOURCE) return false
  if (outcome.inboxId === null || outcome.baselineSequence === null) return false
  // The fence is the *admitted* hash persisted on the outcome, not whatever the
  // current receipt happens to claim.
  if (outcome.authorityHash === null || source.authorityHash !== outcome.authorityHash) return false
  if (source.inboxId !== outcome.inboxId) return false
  if (source.completionSequence <= outcome.baselineSequence) return false
  if (source.execution.status !== 'succeeded') return false
  if (source.execution.quiescent !== true) return false
  if (source.scope.workspace !== item.scope.workspace) return false
  if (source.scope.preset !== item.scope.preset) return false
  if (source.principalId !== item.scope.principalId) return false
  if (source.authorityHash !== authorityHash) return false
  return true
}

/** Evidence keys in canonical serialization order; nothing else may reach the ledger. */
const EVIDENCE_ORDER = [
  'inboxId',
  'completionSequence',
  'completedAt',
  'executionStatus',
  'sourceDigest',
  'bindingVersion',
  'bindingGeneration',
  'scope',
] as const

function scopeLabel(source: PeerOwnerForegroundTaskSource): string {
  return `${source.scope.workspace}/${source.scope.preset}`
}

/**
 * Build the allowlisted evidence payload for one matched receipt.
 *
 * The payload is canonical JSON (fixed key order) and is either stored whole or
 * dropped whole: oversized evidence becomes `null` with
 * `evidence-too-large`, because a truncated receipt would be a fabricated one.
 */
export function outcomeEvidenceFor(source: PeerOwnerForegroundTaskSource): {
  readonly evidence: WorkItemOutcomeEvidence | null
  readonly reason: WorkItemOutcomeEvidenceReason | null
} {
  const payload: WorkItemOutcomeEvidence = {
    inboxId: source.inboxId,
    completionSequence: source.completionSequence,
    completedAt: source.execution.completedAt,
    executionStatus: source.execution.status,
    sourceDigest: source.sourceDigest,
    bindingVersion: source.binding.version,
    bindingGeneration: source.binding.generation,
    scope: scopeLabel(source),
  }
  // Re-serialize through the ordered key list so the stored JSON is canonical
  // regardless of how the caller built the object.
  const ordered: Record<string, string | number | boolean> = {}
  for (const key of EVIDENCE_ORDER) {
    const value = payload[key]
    if (value !== undefined) ordered[key] = value
  }
  const evidence = Object.freeze(ordered) as WorkItemOutcomeEvidence
  const bytes = Buffer.byteLength(JSON.stringify(evidence), 'utf8')
  if (bytes > MAX_OUTCOME_EVIDENCE_BYTES) {
    return Object.freeze({ evidence: null, reason: 'evidence-too-large' as const })
  }
  return Object.freeze({ evidence, reason: null })
}

/**
 * Revision N+1 for a pending outcome whose window is still open but produced no
 * matching receipt yet: the window expired with no evidence.
 */
export function expiredOutcome(outcome: WorkItemOutcomeRecord, now: number, degraded: boolean): WorkItemOutcomeDraft {
  return Object.freeze({
    settledBy: 'window-expired' as const,
    executionStatus: outcome.executionStatus,
    objectiveStatus: outcome.objectiveStatus,
    trust: outcome.trust,
    evidenceState: 'unverified' as const,
    evidenceReason: (degraded ? 'channel-unavailable' : 'window-expired') as WorkItemOutcomeEvidenceReason,
    evidence: null,
    baselineSequence: outcome.baselineSequence,
    inboxId: outcome.inboxId,
    authorityHash: outcome.authorityHash,
    deadlineAt: null,
    settledAt: now,
  })
}

/**
 * Revision N+1 for a pending outcome that now has a matching receipt.
 *
 * Trust moves to `external-receipt` because an authenticated execution was
 * observed, but the objective status is inherited unchanged: observed success
 * of the guarded execution is still not proof that the owner's objective was
 * achieved.
 */
export function observedOutcome(
  outcome: WorkItemOutcomeRecord,
  evidence: WorkItemOutcomeEvidence | null,
  reason: WorkItemOutcomeEvidenceReason | null,
  now: number,
): WorkItemOutcomeDraft {
  return Object.freeze({
    settledBy: 'observed-evidence' as const,
    executionStatus: outcome.executionStatus,
    objectiveStatus: outcome.objectiveStatus,
    trust: 'external-receipt' as const,
    evidenceState: evidence === null ? ('unverified' as const) : ('observed' as const),
    evidenceReason: evidence === null ? reason : null,
    evidence,
    baselineSequence: outcome.baselineSequence,
    inboxId: outcome.inboxId,
    authorityHash: outcome.authorityHash,
    deadlineAt: null,
    settledAt: now,
  })
}
