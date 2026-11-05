/**
 * WP19 stage 3: purpose enforcement (opt-in Delivery config `attentionEnforce`,
 * default off). With it on, a background/owner notice whose purpose is missing
 * or fails the Host checks, or that exceeds its caps while
 * `attentionAttachOverCap` is off, is rejected before it is queued.
 *
 * A rejected notice never becomes an Outbox row, and the v31
 * `delivery_attention_audit` table is keyed by `outbox_id` with an Outbox
 * foreign key and a closed `verdict` CHECK, so it cannot hold a `rejected`
 * verdict without a schema bump. Rejections are therefore recorded in this
 * process-local, bounded, non-durable log, like the stage 2c progress audit.
 * A rejection never opens or settles a question, so the durable ledger that
 * decides it is unchanged by it and a retry after restart is decided again
 * the same way.
 */
import { attentionAuditReasons, type AttentionAssessment, type AttentionAuditReason, type AttentionLane } from './attention.js'

/** Enforcement-only reasons, appended after the audit reasons. */
export const attentionEnforcementOnlyReasons = ['split-evasion', 'attachment-unsupported'] as const
export type AttentionRejectionReason = AttentionAuditReason | typeof attentionEnforcementOnlyReasons[number]
const rejectionReasonOrder: readonly AttentionRejectionReason[] = [...attentionAuditReasons, ...attentionEnforcementOnlyReasons]

/** Purpose reasons that reject under enforcement: the stage 1 would-reject set plus an undeclared purpose. */
export const attentionEnforcedPurposeReasons: ReadonlySet<AttentionAuditReason> = new Set([
  'missing-purpose', 'invalid-envelope', 'attention-missing-work-item', 'attention-question-invalid', 'attention-question-not-current',
  'attention-question-already-answered', 'answer-missing-question', 'answer-unknown-question', 'answer-already-used',
  'answer-work-item-mismatch', 'attention-question-reused',
])

const capReasons: ReadonlySet<AttentionAuditReason> = new Set(['over-word-cap', 'over-grapheme-cap'])

/**
 * Pure: reasons one assessment is rejected for, in fixed order. Over-cap text
 * is rejected only when it cannot take the stage 2b attachment path.
 * `text-exposes-*` stay audit-only.
 */
export function attentionEnforcementReasons(assessment: Readonly<Pick<AttentionAssessment, 'reasons'>>, attachOverCap: boolean): readonly AttentionAuditReason[] {
  return Object.freeze(assessment.reasons.filter(reason => attentionEnforcedPurposeReasons.has(reason)
    || (!attachOverCap && capReasons.has(reason))))
}

export function orderAttentionRejectionReasons(reasons: Iterable<AttentionRejectionReason>): readonly AttentionRejectionReason[] {
  const set = new Set(reasons)
  return Object.freeze(rejectionReasonOrder.filter(reason => set.has(reason)))
}

export interface AttentionRejectionEntry {
  /** Process-local read cursor, strictly increasing from 1. */
  sequence: number
  bindingId: string
  lane: AttentionLane
  sourceId: string
  idempotencyKey: string
  purpose: AttentionAssessment['purpose']
  purposeSource: AttentionAssessment['purposeSource']
  workItemId?: string
  questionId?: string
  answersQuestionId?: string
  wordCount: number
  wordCap: number
  verdict: 'rejected'
  reasons: readonly AttentionRejectionReason[]
  recordedAt: number
}

export interface AttentionRejectionPage {
  entries: readonly AttentionRejectionEntry[]
  hasMore: boolean
  nextAfterSequence: number | null
  /** Always false: entries live in this Host process only. */
  durable: false
  /** Entries evicted from the bounded ring since this Host started. */
  evicted: number
}

export class AttentionRejectionLog {
  private readonly entries: AttentionRejectionEntry[] = []
  private sequence = 0
  private evictedEntries = 0

  constructor(private readonly maxEntries = 1000, private readonly now: () => number = Date.now) {}

  /** A retry of the same key rejected for the same reasons returns the retained entry instead of appending. */
  record(input: Readonly<{ bindingId: string; lane: AttentionLane; sourceId: string; idempotencyKey: string
    assessment: Readonly<AttentionAssessment>; reasons: readonly AttentionRejectionReason[] }>): AttentionRejectionEntry {
    const reasons = orderAttentionRejectionReasons(input.reasons)
    const retained = this.entries.findLast(entry => entry.bindingId === input.bindingId && entry.lane === input.lane
      && entry.idempotencyKey === input.idempotencyKey)
    if (retained !== undefined && retained.sourceId === input.sourceId && retained.reasons.join() === reasons.join()) return retained
    const { assessment } = input
    this.sequence += 1
    const entry: AttentionRejectionEntry = Object.freeze({
      sequence: this.sequence, bindingId: input.bindingId, lane: input.lane, sourceId: input.sourceId, idempotencyKey: input.idempotencyKey,
      purpose: assessment.purpose, purposeSource: assessment.purposeSource,
      ...(assessment.workItemId === undefined ? {} : { workItemId: assessment.workItemId }),
      ...(assessment.questionId === undefined ? {} : { questionId: assessment.questionId }),
      ...(assessment.answersQuestionId === undefined ? {} : { answersQuestionId: assessment.answersQuestionId }),
      wordCount: assessment.wordCount, wordCap: assessment.wordCap, verdict: 'rejected' as const, reasons, recordedAt: this.now(),
    })
    this.entries.push(entry)
    while (this.entries.length > this.maxEntries) { this.entries.shift(); this.evictedEntries += 1 }
    return entry
  }

  /** `afterSequence`/`limit` are validated by the caller. */
  list(afterSequence: number, limit: number): AttentionRejectionPage {
    const start = this.entries.findIndex(entry => entry.sequence > afterSequence)
    const remaining = start < 0 ? [] : this.entries.slice(start)
    const entries = Object.freeze(remaining.slice(0, limit))
    const hasMore = remaining.length > limit
    return Object.freeze({ entries, hasMore, nextAfterSequence: hasMore ? entries.at(-1)!.sequence : null, durable: false as const,
      evicted: this.evictedEntries })
  }
}
