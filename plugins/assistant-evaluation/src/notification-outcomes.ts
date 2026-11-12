import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { canonicalEvaluationScope, EvaluationStoreError } from './store.js'
import {
  NOTIFICATION_OUTCOME_RECORD_PROTOCOL,
  notificationOutcomes,
  objectiveStatuses,
  type EvaluationScope,
  type NotificationDeliveryState,
  type NotificationOutcome,
  type NotificationOutcomeFactInput,
  type NotificationOutcomeFeedPage,
  type NotificationOutcomeHistory,
  type NotificationOutcomeRecord,
  type NotificationOutcomeSummary,
  type StoredNotificationOutcome,
} from './types.js'

const purposes = ['result', 'attention', 'answer'] as const
const purposeSources = ['declared', 'lane', 'default'] as const
const verdicts = ['would-accept', 'would-attach', 'would-reject'] as const
const transportStatuses = ['pending', 'attempting', 'accepted', 'delivered', 'read', 'retry_wait', 'dead', 'unknown_after_send'] as const
const judgementSources = ['owner-objective', 'work-item-feedback'] as const

function invalid(message: string): never {
  throw new EvaluationStoreError('invalid-input', `notification outcome fact: ${message}`)
}

function plain(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.trim() !== value || /\p{Cc}/u.test(value)) {
    invalid(`${label} must be a bounded identifier`)
  }
  return value
}

function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : text(value, label)
}

function time(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(`${label} must be a non-negative safe integer`)
  return value as number
}

function optionalTime(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : time(value, label)
}

function member<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) invalid(`${label} is not recognised`)
  return value as T
}

/** Strict shape check: Delivery facts are trusted Host data, but never trusted to be well-formed. */
export function normalizeNotificationOutcomeFact(input: unknown): NotificationOutcomeFactInput {
  const fact = plain(input, 'fact')
  const transport = plain(fact.transport, 'transport')
  const reasons = fact.reasons
  if (!Array.isArray(reasons) || reasons.length > 32) invalid('reasons must be a bounded array')
  const scope = plain(fact.scope, 'scope')
  const reaction = fact.reaction === undefined ? undefined : plain(fact.reaction, 'reaction')
  const judgement = fact.judgement === undefined ? undefined : plain(fact.judgement, 'judgement')
  if (judgement !== undefined && (!Number.isSafeInteger(judgement.version) || (judgement.version as number) < 1)) {
    invalid('judgement.version must be a positive integer')
  }
  const route = fact.route === undefined ? undefined : plain(fact.route, 'route')
  if (route !== undefined && (Object.keys(route).length !== 2 || route.kind !== 'linked')) invalid('route must be a linked route')
  const originBindingId = route === undefined ? undefined : text(route.originBindingId, 'route.originBindingId')
  if (originBindingId !== undefined && originBindingId === fact.bindingId) invalid('route.originBindingId must differ from bindingId')
  const workItemId = optionalText(fact.workItemId, 'workItemId')
  const questionId = optionalText(fact.questionId, 'questionId')
  const answersQuestionId = optionalText(fact.answersQuestionId, 'answersQuestionId')
  const acceptedAt = optionalTime(transport.acceptedAt, 'transport.acceptedAt')
  const deliveredAt = optionalTime(transport.deliveredAt, 'transport.deliveredAt')
  const readAt = optionalTime(transport.readAt, 'transport.readAt')
  const readReceipts = fact.readReceipts === undefined ? undefined
    : member(fact.readReceipts, ['none', 'best-effort', 'complete'] as const, 'readReceipts')
  return {
    auditSequence: time(fact.auditSequence, 'auditSequence'),
    outboxId: text(fact.outboxId, 'outboxId'),
    bindingId: text(fact.bindingId, 'bindingId'),
    scope: canonicalEvaluationScope({ workspace: scope.workspace as string, preset: scope.preset as string }).scope,
    lane: text(fact.lane, 'lane', 64),
    sourceId: text(fact.sourceId, 'sourceId'),
    purpose: member(fact.purpose, purposes, 'purpose'),
    purposeSource: member(fact.purposeSource, purposeSources, 'purposeSource'),
    ...(workItemId === undefined ? {} : { workItemId }),
    ...(questionId === undefined ? {} : { questionId }),
    ...(answersQuestionId === undefined ? {} : { answersQuestionId }),
    verdict: member(fact.verdict, verdicts, 'verdict'),
    reasons: reasons.map((reason, index) => text(reason, `reasons[${index}]`, 64)),
    auditedAt: time(fact.auditedAt, 'auditedAt'),
    transport: {
      status: member(transport.status, transportStatuses, 'transport.status'),
      ...(acceptedAt === undefined ? {} : { acceptedAt }),
      ...(deliveredAt === undefined ? {} : { deliveredAt }),
      ...(readAt === undefined ? {} : { readAt }),
    },
    ...(readReceipts === undefined ? {} : { readReceipts }),
    ...(reaction === undefined ? {} : { reaction: { firstAt: time(reaction.firstAt, 'reaction.firstAt') } }),
    ...(judgement === undefined ? {} : { judgement: {
      source: member(judgement.source, judgementSources, 'judgement.source'),
      version: judgement.version as number,
      objectiveStatus: member(judgement.objectiveStatus, objectiveStatuses, 'judgement.objectiveStatus'),
    } }),
    ...(originBindingId === undefined ? {} : { route: { kind: 'linked' as const, originBindingId } }),
  }
}

/**
 * Deterministic `notification-outcome/v1` classifier. Precedence: an owner
 * judgement (rejected, accepted) beats a reply (reacted), which beats transport
 * state. A withdrawn judgement (`unknown`) contributes nothing. Expiry depends
 * only on `now`, the earliest sent timestamp and the configured window. An
 * optional linked route is carried verbatim and never affects the outcome, so
 * the classifier stays at version 1 and route-free records keep their digests.
 */
export function classifyNotificationOutcome(fact: NotificationOutcomeFactInput, now: number, responseWindowMs: number): NotificationOutcomeRecord {
  const judgement = fact.judgement !== undefined && fact.judgement.objectiveStatus !== 'unknown'
    ? { source: fact.judgement.source, version: fact.judgement.version, objectiveStatus: fact.judgement.objectiveStatus }
    : undefined
  const sentTimes = [fact.transport.acceptedAt, fact.transport.deliveredAt, fact.transport.readAt].filter(value => value !== undefined)
  const sentAt = sentTimes.length === 0 ? undefined : Math.min(...sentTimes)
  let outcome: NotificationOutcome
  let expiry: { at: number; responseWindowMs: number } | undefined
  // v1 records stay byte-identical (no readReceipts → no new fields). v2 adds a
  // delivery-state projection without touching the frozen outcome vocabulary.
  const classifierVersion: 1 | 2 = fact.readReceipts === undefined ? 1 : 2
  let deliveryState: NotificationDeliveryState | undefined
  if (judgement?.objectiveStatus === 'not-achieved') outcome = 'rejected'
  else if (judgement?.objectiveStatus === 'achieved') outcome = 'accepted'
  else if (fact.reaction !== undefined || judgement?.objectiveStatus === 'partial') outcome = 'reacted'
  else if (fact.transport.status === 'dead') outcome = 'failed'
  else if (sentAt !== undefined) {
    if (now >= sentAt + responseWindowMs) {
      outcome = 'expired-unhandled'
      expiry = { at: sentAt + responseWindowMs, responseWindowMs }
    }
    else outcome = 'delivered'
  } else outcome = 'pending'
  if (classifierVersion === 2 && judgement === undefined && fact.reaction === undefined
    && outcome !== 'failed' && sentAt !== undefined) {
    const expired = now >= sentAt + responseWindowMs
    if (fact.transport.readAt !== undefined) deliveryState = expired ? 'ignored' : 'read'
    // Absence of a read event is only evidence of a miss when the adapter
    // declares complete coverage; best-effort gaps must not become "missed".
    else if (expired && fact.readReceipts === 'complete') deliveryState = 'missed'
  }
  return {
    protocol: NOTIFICATION_OUTCOME_RECORD_PROTOCOL,
    classifier: { id: 'notification-outcome', version: classifierVersion },
    notificationId: fact.outboxId,
    scope: { workspace: fact.scope.workspace, preset: fact.scope.preset },
    bindingId: fact.bindingId,
    lane: fact.lane,
    sourceId: fact.sourceId,
    purpose: fact.purpose,
    purposeSource: fact.purposeSource,
    ...(fact.workItemId === undefined ? {} : { workItemId: fact.workItemId }),
    ...(fact.questionId === undefined ? {} : { questionId: fact.questionId }),
    ...(fact.answersQuestionId === undefined ? {} : { answersQuestionId: fact.answersQuestionId }),
    verdict: fact.verdict,
    reasons: [...fact.reasons],
    notifiedAt: fact.auditedAt,
    outcome,
    ...(deliveryState === undefined ? {} : { deliveryState }),
    transport: { ...fact.transport },
    ...(fact.reaction === undefined ? {} : { reaction: { firstAt: fact.reaction.firstAt } }),
    ...(judgement === undefined ? {} : { judgement }),
    ...(fact.route === undefined ? {} : { route: { kind: fact.route.kind, originBindingId: fact.route.originBindingId } }),
    ...(expiry === undefined ? {} : { expiry }),
  }
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).filter(key => record[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
}

export function notificationOutcomeDigest(record: NotificationOutcomeRecord): string {
  return createHash('sha256').update(stable(record)).digest('hex')
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry)
    Object.freeze(value)
  }
  return value
}

interface RevisionRow {
  notification_id: string; version: number; scope_key: string; record_json: string; digest: string; watermark: number; recorded_at: number
}

function stored(row: RevisionRow): StoredNotificationOutcome {
  return deepFreeze({
    notificationId: row.notification_id, scopeKey: row.scope_key, version: row.version, digest: row.digest,
    watermark: row.watermark, recordedAt: row.recorded_at, record: JSON.parse(row.record_json) as NotificationOutcomeRecord,
  })
}

function emptyCounts(): Record<NotificationOutcome, number> {
  return Object.fromEntries(notificationOutcomes.map(outcome => [outcome, 0])) as Record<NotificationOutcome, number>
}

/**
 * Evaluation-owned revisable ledger keyed by notification (Delivery Outbox id).
 * Each changed classification appends an immutable revision and advances the
 * scope's notification watermark in one writer transaction; an unchanged
 * digest only refreshes the check time. Nothing here touches task projections,
 * the Evolution outbox or any parameter.
 */
export class NotificationOutcomeLedger {
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

  /** Apply one fact; returns whether a new revision was appended. */
  apply(factInput: unknown, responseWindowMs: number): Readonly<{ revised: boolean; head: StoredNotificationOutcome }> {
    const fact = normalizeNotificationOutcomeFact(factInput)
    const { scopeKey } = canonicalEvaluationScope(fact.scope)
    return this.#transaction(() => {
      const now = this.#now()
      const record = classifyNotificationOutcome(fact, now, responseWindowMs)
      const digest = notificationOutcomeDigest(record)
      const head = this.#database.prepare('SELECT scope_key, version, digest FROM evaluation_notification_outcome_heads WHERE notification_id=?')
        .get(fact.outboxId) as { scope_key: string; version: number; digest: string } | undefined
      if (head !== undefined && head.scope_key !== scopeKey) {
        throw new EvaluationStoreError('version-conflict', 'notification outcome scope changed')
      }
      if (head?.digest === digest) {
        this.#database.prepare('UPDATE evaluation_notification_outcome_heads SET last_checked_at=? WHERE notification_id=?').run(now, fact.outboxId)
        return { revised: false, head: this.#get(fact.outboxId, head.version)! }
      }
      const version = (head?.version ?? 0) + 1
      this.#database.prepare(`INSERT INTO evaluation_notification_watermarks(scope_key, watermark) VALUES (?, 1)
        ON CONFLICT(scope_key) DO UPDATE SET watermark = watermark + 1`).run(scopeKey)
      const watermark = (this.#database.prepare('SELECT watermark FROM evaluation_notification_watermarks WHERE scope_key=?')
        .get(scopeKey) as { watermark: number }).watermark
      this.#database.prepare(`INSERT INTO evaluation_notification_outcome_revisions
        (notification_id, version, scope_key, outcome, record_json, digest, watermark, recorded_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(fact.outboxId, version, scopeKey, record.outcome, stable(record), digest, watermark, now)
      if (head === undefined) {
        this.#database.prepare(`INSERT INTO evaluation_notification_outcome_heads
          (notification_id, scope_key, version, digest, outcome, occurred_at, watermark, last_checked_at) VALUES (?,?,?,?,?,?,?,?)`)
          .run(fact.outboxId, scopeKey, version, digest, record.outcome, record.notifiedAt, watermark, now)
      } else {
        this.#database.prepare(`UPDATE evaluation_notification_outcome_heads
          SET version=?, digest=?, outcome=?, watermark=?, last_checked_at=? WHERE notification_id=?`)
          .run(version, digest, record.outcome, watermark, now, fact.outboxId)
      }
      return { revised: true, head: this.#get(fact.outboxId, version)! }
    })
  }

  /** Mark a head as checked without a fact (e.g. Delivery no longer reports it). */
  touch(notificationId: string): void {
    this.#database.prepare('UPDATE evaluation_notification_outcome_heads SET last_checked_at=? WHERE notification_id=?')
      .run(this.#now(), notificationId)
  }

  syncCursor(): number {
    return (this.#database.prepare('SELECT after_sequence FROM evaluation_notification_sync_cursor WHERE id=1')
      .get() as { after_sequence: number } | undefined)?.after_sequence ?? 0
  }

  advanceSyncCursor(afterSequence: number): void {
    this.#database.prepare(`INSERT INTO evaluation_notification_sync_cursor(id, after_sequence, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET after_sequence=max(after_sequence, excluded.after_sequence), updated_at=excluded.updated_at`)
      .run(afterSequence, this.#now())
  }

  /** Heads notified at or after `notifiedSince`, least recently checked first. */
  dueForRefresh(notifiedSince: number, limit: number): readonly string[] {
    return (this.#database.prepare(`SELECT notification_id FROM evaluation_notification_outcome_heads
      WHERE occurred_at >= ? ORDER BY last_checked_at, notification_id LIMIT ?`).all(notifiedSince, limit) as { notification_id: string }[])
      .map(row => row.notification_id)
  }

  #get(notificationId: string, version: number): StoredNotificationOutcome | undefined {
    const row = this.#database.prepare('SELECT * FROM evaluation_notification_outcome_revisions WHERE notification_id=? AND version=?')
      .get(notificationId, version) as unknown as RevisionRow | undefined
    return row === undefined ? undefined : stored(row)
  }

  history(scopeInput: EvaluationScope, notificationId: string): NotificationOutcomeHistory | undefined {
    const { scopeKey } = canonicalEvaluationScope(scopeInput)
    const rows = this.#database.prepare(`SELECT r.* FROM evaluation_notification_outcome_revisions r
      WHERE r.notification_id=? AND r.scope_key=? ORDER BY r.version`).all(notificationId, scopeKey) as unknown as RevisionRow[]
    if (rows.length === 0) return undefined
    const revisions = rows.map(stored)
    return Object.freeze({ head: revisions.at(-1)!, revisions: Object.freeze(revisions) })
  }

  feed(scopeInput: EvaluationScope, afterInput: Readonly<{ scopeKey: string; watermark: number }> | undefined, limit: number): NotificationOutcomeFeedPage {
    const { scopeKey } = canonicalEvaluationScope(scopeInput)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid('feed limit must be between 1 and 100')
    if (afterInput !== undefined && (afterInput === null || typeof afterInput !== 'object' || Array.isArray(afterInput)
      || Object.keys(afterInput).length !== 2 || afterInput.scopeKey !== scopeKey
      || !Number.isSafeInteger(afterInput.watermark) || afterInput.watermark < 0)) invalid('feed cursor is invalid')
    const after = afterInput?.watermark ?? 0
    this.#database.exec('BEGIN')
    try {
      const scopeWatermark = (this.#database.prepare('SELECT watermark FROM evaluation_notification_watermarks WHERE scope_key=?')
        .get(scopeKey) as { watermark: number } | undefined)?.watermark ?? 0
      if (after > scopeWatermark) invalid('feed cursor is ahead of scope')
      const rows = this.#database.prepare(`SELECT r.* FROM evaluation_notification_outcome_heads h
        JOIN evaluation_notification_outcome_revisions r ON r.notification_id=h.notification_id AND r.version=h.version
        WHERE h.scope_key=? AND h.watermark>? ORDER BY h.watermark LIMIT ?`).all(scopeKey, after, limit + 1) as unknown as RevisionRow[]
      const items = rows.slice(0, limit).map(stored)
      return Object.freeze({
        items: Object.freeze(items),
        nextCursor: Object.freeze({ scopeKey, watermark: items.at(-1)?.watermark ?? after }),
        scopeWatermark,
        hasMore: rows.length > limit,
      })
    } finally {
      this.#database.exec('COMMIT')
    }
  }

  summary(scopeInput: EvaluationScope, fromNotifiedAt: number, toNotifiedAt: number): NotificationOutcomeSummary {
    const { scope, scopeKey } = canonicalEvaluationScope(scopeInput)
    const rows = this.#database.prepare(`SELECT h.outcome AS outcome, json_extract(r.record_json, '$.verdict') AS verdict, COUNT(*) AS count
      FROM evaluation_notification_outcome_heads h
      JOIN evaluation_notification_outcome_revisions r ON r.notification_id=h.notification_id AND r.version=h.version
      WHERE h.scope_key=? AND h.occurred_at>=? AND h.occurred_at<? GROUP BY h.outcome, verdict`)
      .all(scopeKey, fromNotifiedAt, toNotifiedAt) as { outcome: NotificationOutcome; verdict: typeof verdicts[number]; count: number }[]
    const outcomes = emptyCounts()
    const byVerdict = Object.fromEntries(verdicts.map(verdict => [verdict, emptyCounts()])) as Record<typeof verdicts[number], Record<NotificationOutcome, number>>
    let total = 0
    for (const row of rows) {
      outcomes[row.outcome] += row.count
      byVerdict[row.verdict][row.outcome] += row.count
      total += row.count
    }
    return deepFreeze({ scope, scopeKey, fromNotifiedAt, toNotifiedAt, total, outcomes, byVerdict })
  }

  /**
   * Current heads in `[from, to)` notification time whose record names a work
   * item, oldest first, at most `limit` (plus whether more exist). Read-only;
   * a scan of the scope's heads in the window (no index on the work item).
   */
  workItemHeads(scopeInput: EvaluationScope, fromNotifiedAt: number, toNotifiedAt: number, limit: number):
    Readonly<{ records: readonly NotificationOutcomeRecord[]; truncated: boolean }> {
    const { scopeKey } = canonicalEvaluationScope(scopeInput)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) invalid('work item head limit is invalid')
    const rows = this.#database.prepare(`SELECT r.* FROM evaluation_notification_outcome_heads h
      JOIN evaluation_notification_outcome_revisions r ON r.notification_id=h.notification_id AND r.version=h.version
      WHERE h.scope_key=? AND h.occurred_at>=? AND h.occurred_at<?
        AND json_extract(r.record_json, '$.workItemId') IS NOT NULL
      ORDER BY h.occurred_at, h.notification_id LIMIT ?`).all(scopeKey, fromNotifiedAt, toNotifiedAt, limit + 1) as unknown as RevisionRow[]
    return Object.freeze({ records: Object.freeze(rows.slice(0, limit).map(row => stored(row).record)), truncated: rows.length > limit })
  }

  /**
   * Distinct owner scopes that currently have at least one work-item result
   * notification. Used only by the E1 persistence tick; bounded and ordered so
   * a multi-scope database rotates deterministically instead of scanning every
   * scope on each tick.
   */
  workItemScopes(limit: number): readonly EvaluationScope[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) invalid('work item scope limit is invalid')
    const rows = this.#database.prepare(`SELECT DISTINCT r.scope_key FROM evaluation_notification_outcome_heads h
      JOIN evaluation_notification_outcome_revisions r ON r.notification_id=h.notification_id AND r.version=h.version
      WHERE json_extract(r.record_json, '$.workItemId') IS NOT NULL
      ORDER BY r.scope_key LIMIT ?`).all(limit) as { scope_key: string }[]
    const scopes: EvaluationScope[] = []
    for (const row of rows) {
      let parsed: unknown
      try { parsed = JSON.parse(row.scope_key) } catch { continue }
      if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') continue
      try { scopes.push(canonicalEvaluationScope({ workspace: parsed[0], preset: parsed[1] }).scope) } catch { continue }
    }
    return Object.freeze(scopes)
  }

  counts(): Readonly<{ notifications: number; revisions: number }> {
    const heads = this.#database.prepare('SELECT COUNT(*) AS count FROM evaluation_notification_outcome_heads').get() as { count: number }
    const revisions = this.#database.prepare('SELECT COUNT(*) AS count FROM evaluation_notification_outcome_revisions').get() as { count: number }
    return { notifications: heads.count, revisions: revisions.count }
  }
}
