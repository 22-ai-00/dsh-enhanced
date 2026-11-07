import type { DatabaseSync } from 'node:sqlite'
import { canonicalEvaluationScope, EvaluationStoreError } from './store.js'
import {
  normalizeAttentionCohort,
  type AttentionCohort,
  type AttentionGrantExceeded,
  type AttentionOwnerQuestion,
  type AttentionTuningParameter,
} from './attention-tuning.js'
import type { EvaluationScope } from './types.js'

/** Delivery `sourceId` of owner-question notices; a distinct cohort, so they never feed attention tuning. */
export const ATTENTION_OWNER_QUESTION_SOURCE_ID = 'assistant-evaluation/attention-owner-notice/v1' as const

/**
 * Slice 5 reply-consumer protocol: Delivery hands a genuine reply to one of
 * its accepted/delivered/read owner notices to the live service in the
 * registration's authority slot, which must vouch for the exact registration
 * object through `ownsOwnerNotificationReply`.
 */
export const ATTENTION_OWNER_QUESTION_REPLY_PROTOCOL = 'assistant-delivery/owner-notification-reply/v1' as const

export const attentionOwnerQuestionChoices = ['authorize-once', 'decline'] as const
export type AttentionOwnerQuestionChoice = typeof attentionOwnerQuestionChoices[number]

/**
 * Exact owner reply phrases. Only the whole trimmed reply is compared, case
 * insensitively; nothing here is a model interpretation. A reply must already
 * target the one delivered notice, so these short phrases are unambiguous.
 */
const attentionOwnerQuestionAuthorizeReplies = [
  'authorize-once', 'authorize once', 'allow once', '同意一次', '授权一次', '批准一次',
] as const
const attentionOwnerQuestionDeclineReplies = ['decline', '拒绝', '不同意', '不用了'] as const

export function parseAttentionOwnerQuestionChoice(input: unknown): AttentionOwnerQuestionChoice | undefined {
  if (typeof input !== 'string') return undefined
  const text = input.trim().toLowerCase()
  if ((attentionOwnerQuestionAuthorizeReplies as readonly string[]).includes(text)) return 'authorize-once'
  if ((attentionOwnerQuestionDeclineReplies as readonly string[]).includes(text)) return 'decline'
  return undefined
}

/**
 * Terminal per-question delivery state, written at most once:
 * `queued` (handed to Delivery, carries the Outbox id), `closed` (a newer
 * grant or a recorded reply closed it first; never sent) or `expired` (the
 * notice TTL elapsed before it could be queued; never sent).
 */
export type AttentionOwnerQuestionDeliveryStatus = 'queued' | 'closed' | 'expired'

export interface AttentionOwnerQuestionDelivery {
  readonly questionId: string
  readonly status: AttentionOwnerQuestionDeliveryStatus
  readonly outboxId: string | null
  readonly idempotencyKey: string
  readonly recordedAt: number
}

export interface AttentionOwnerQuestionReply {
  readonly questionId: string
  readonly choice: AttentionOwnerQuestionChoice
  readonly repliedAt: number
}

export type AttentionOwnerQuestionReplyResult =
  | Readonly<{ status: 'recorded'; questionId: string; choice: AttentionOwnerQuestionChoice; repliedAt: number }>
  | Readonly<{ status: 'rejected'; reason: 'delivery-disabled' | 'unknown-question' | 'question-closed' | 'question-expired' | 'reply-conflict' }>

export interface AttentionOwnerQuestionStatus {
  readonly enabled: boolean
  readonly deliveries: readonly AttentionOwnerQuestionDelivery[]
  readonly replies: readonly AttentionOwnerQuestionReply[]
}

/** One tick outcome per scope/cohort whose latest question still needed a delivery decision. */
export type AttentionOwnerQuestionTickAction =
  | Readonly<{ action: 'queued'; questionId: string; outboxId: string }>
  | Readonly<{ action: 'closed' | 'expired'; questionId: string }>
  | Readonly<{ action: 'deferred'; questionId: string; reason: 'delivery-unavailable' | 'route-mismatch' | 'enqueue-failed' }>
  | Readonly<{ action: 'unverifiable' }>

export function attentionOwnerQuestionIdempotencyKey(questionId: string): string {
  return `attention-owner-question:${questionId}`
}

const parameterLabels: Readonly<Record<AttentionTuningParameter, string>> = Object.freeze({
  interruptionCostDelta: 'interruption cost offset',
  minimumUtilityDelta: 'notice threshold offset',
  quietExtensionMinutes: 'quiet-hours extension (minutes)',
  muted: 'mute',
})

const exceededLabels: Readonly<Record<AttentionGrantExceeded, string>> = Object.freeze({
  'no-grant': 'no owner grant is active',
  'grant-unverifiable': 'the stored grant could not be verified',
  'grant-expired': 'the grant has expired',
  'grant-exhausted': 'the grant has no adoptions left',
  'outside-bounds': 'the change is outside the granted bounds',
  'step-too-large': 'the change is larger than the grant allows',
})

function valueText(value: number | boolean): string {
  return typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value)
}

/**
 * Deterministic plain-text notice for one owner question. It names the
 * human-readable parameter, never an internal id, digest or estimate term,
 * and stays well inside Delivery's `result` caps. `repliesRead` is the
 * slice-5 opt-in: only then does the notice invite an exact reply, because
 * only then does Delivery route a reply back to this service.
 */
export function attentionOwnerQuestionText(question: AttentionOwnerQuestion, scope: EvaluationScope,
  options: Readonly<{ repliesRead?: boolean }> = {}): string {
  const label = parameterLabels[question.change.parameter] ?? 'attention setting'
  const checked = question.replay.shared.decided + question.replay.discriminating.decided
  const reasons = question.exceeded.map(reason => exceededLabels[reason] ?? 'the grant does not cover it')
  return [
    'Attention settings: a looser setting passed its replay check and needs your approval.',
    `Workspace: ${scope.workspace} (${scope.preset})`,
    `Notices: ${question.cohort.sourceId} on ${question.cohort.lane}`,
    `Change: ${label} from ${valueText(question.change.from)} to ${valueText(question.change.to)} (${question.steps} step${question.steps === 1 ? '' : 's'}).`,
    `Held-out notices replayed: ${checked}.`,
    `Approval is needed because ${reasons.length === 0 ? 'no owner grant covers it' : reasons.join('; ')}.`,
    ...(options.repliesRead === true
      ? ['To allow this single change, reply exactly "authorize-once". To refuse it, reply "decline". Nothing changes until your reply is recorded.']
      : ['To allow this single change, record an owner grant through the host configuration. Replies to this message are not read. Nothing changes until an owner grant is recorded.']),
  ].join('\n')
}

function invalid(message: string): never {
  throw new EvaluationStoreError('invalid-input', `attention owner question: ${message}`)
}

/**
 * WP22 slice 4 delivery and reply ledger for owner questions. Both tables are
 * append-only with one row per question, so a question is handed to Delivery
 * at most once and a reply is recorded at most once. Nothing here creates a
 * grant or changes a tuning version.
 */
export class AttentionOwnerQuestionLedger {
  readonly #database: DatabaseSync
  readonly #now: () => number

  constructor(database: DatabaseSync, now: () => number) {
    this.#database = database
    this.#now = now
  }

  #transaction<T>(fn: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.#database.exec('COMMIT')
      return value
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  delivery(questionId: string): AttentionOwnerQuestionDelivery | undefined {
    const row = this.#database.prepare(`SELECT question_id, status, outbox_id, idempotency_key, recorded_at
      FROM evaluation_attention_owner_question_deliveries WHERE question_id=?`).get(questionId) as
      { question_id: string; status: AttentionOwnerQuestionDeliveryStatus; outbox_id: string | null; idempotency_key: string; recorded_at: number } | undefined
    return row === undefined ? undefined : Object.freeze({ questionId: row.question_id, status: row.status, outboxId: row.outbox_id,
      idempotencyKey: row.idempotency_key, recordedAt: row.recorded_at })
  }

  reply(questionId: string): AttentionOwnerQuestionReply | undefined {
    const row = this.#database.prepare(`SELECT question_id, choice, replied_at FROM evaluation_attention_owner_question_replies
      WHERE question_id=?`).get(questionId) as { question_id: string; choice: AttentionOwnerQuestionChoice; replied_at: number } | undefined
    return row === undefined ? undefined : Object.freeze({ questionId: row.question_id, choice: row.choice, repliedAt: row.replied_at })
  }

  /** Write the single terminal delivery row; an existing row wins and is returned unchanged. */
  recordDelivery(scopeInput: EvaluationScope, cohortInput: AttentionCohort, questionId: string,
    status: AttentionOwnerQuestionDeliveryStatus, outboxId: string | null): AttentionOwnerQuestionDelivery {
    const { scopeKey } = canonicalEvaluationScope(scopeInput)
    const cohort = normalizeAttentionCohort(cohortInput)
    if ((status === 'queued') !== (typeof outboxId === 'string')) invalid('only a queued delivery carries an Outbox id')
    return this.#transaction(() => {
      const existing = this.delivery(questionId)
      if (existing !== undefined) return existing
      this.#database.prepare(`INSERT INTO evaluation_attention_owner_question_deliveries
        (question_id, scope_key, lane, source_id, status, outbox_id, idempotency_key, recorded_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(questionId, scopeKey, cohort.lane, cohort.sourceId, status, outboxId, attentionOwnerQuestionIdempotencyKey(questionId), this.#now())
      return this.delivery(questionId)!
    })
  }

  /**
   * Record-only owner reply. The caller has already established that the
   * question is the cohort's latest and whether it is open and expired; a new
   * reply needs open and not expired. Replaying the same choice is idempotent
   * and a different choice is a conflict.
   */
  recordReply(scopeInput: EvaluationScope, cohortInput: AttentionCohort, questionId: string, choiceInput: unknown,
    open: boolean, expired: boolean): AttentionOwnerQuestionReplyResult {
    return this.#transaction(() => this.recordReplyInTransaction(scopeInput, cohortInput, questionId, choiceInput, open, expired))
  }

  /**
   * Same contract as `recordReply`, but the caller owns the surrounding
   * `BEGIN IMMEDIATE`. Slice 5 uses it inside the tuning ledger's transaction
   * so a recorded owner reply and the grant or proposal decision it applies to
   * commit atomically. Never call it outside a transaction.
   */
  recordReplyInTransaction(scopeInput: EvaluationScope, cohortInput: AttentionCohort, questionId: string, choiceInput: unknown,
    open: boolean, expired: boolean): AttentionOwnerQuestionReplyResult {
    const { scopeKey } = canonicalEvaluationScope(scopeInput)
    const cohort = normalizeAttentionCohort(cohortInput)
    if (typeof choiceInput !== 'string' || !(attentionOwnerQuestionChoices as readonly string[]).includes(choiceInput)) invalid('choice is not recognised')
    const choice = choiceInput as AttentionOwnerQuestionChoice
    const existing = this.reply(questionId)
    if (existing !== undefined) {
      return existing.choice === choice
        ? Object.freeze({ status: 'recorded' as const, questionId, choice, repliedAt: existing.repliedAt })
        : Object.freeze({ status: 'rejected' as const, reason: 'reply-conflict' as const })
    }
    if (!open) return Object.freeze({ status: 'rejected' as const, reason: 'question-closed' as const })
    if (expired) return Object.freeze({ status: 'rejected' as const, reason: 'question-expired' as const })
    const repliedAt = this.#now()
    this.#database.prepare(`INSERT INTO evaluation_attention_owner_question_replies
      (question_id, scope_key, lane, source_id, choice, replied_at) VALUES (?,?,?,?,?,?)`)
      .run(questionId, scopeKey, cohort.lane, cohort.sourceId, choice, repliedAt)
    return Object.freeze({ status: 'recorded' as const, questionId, choice, repliedAt })
  }

  status(scopeInput: EvaluationScope, cohortInput: AttentionCohort, enabled: boolean, limit = 50): AttentionOwnerQuestionStatus {
    const { scopeKey } = canonicalEvaluationScope(scopeInput)
    const cohort = normalizeAttentionCohort(cohortInput)
    const deliveries = (this.#database.prepare(`SELECT question_id FROM evaluation_attention_owner_question_deliveries
      WHERE scope_key=? AND lane=? AND source_id=? ORDER BY recorded_at DESC, rowid DESC LIMIT ?`)
      .all(scopeKey, cohort.lane, cohort.sourceId, limit) as { question_id: string }[]).reverse().map(row => this.delivery(row.question_id)!)
    const replies = (this.#database.prepare(`SELECT question_id FROM evaluation_attention_owner_question_replies
      WHERE scope_key=? AND lane=? AND source_id=? ORDER BY replied_at DESC, rowid DESC LIMIT ?`)
      .all(scopeKey, cohort.lane, cohort.sourceId, limit) as { question_id: string }[]).reverse().map(row => this.reply(row.question_id)!)
    return Object.freeze({ enabled, deliveries: Object.freeze(deliveries), replies: Object.freeze(replies) })
  }
}
