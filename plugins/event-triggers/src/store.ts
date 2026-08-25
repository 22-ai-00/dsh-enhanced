import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { EventTriggerDatabaseError, openEventTriggerDatabase } from './sqlite.js'
import type { FireWhen } from './config.js'

export type EventTriggerStoreErrorCode = 'invalid-input' | 'invalid-path' | 'schema-too-new'
export class EventTriggerStoreError extends Error {
  constructor(readonly code: EventTriggerStoreErrorCode, message: string) {
    super(message)
    this.name = 'EventTriggerStoreError'
  }
}

export interface TriggerOutboxEvent {
  id: string
  triggerId: string
  eventId: string
  occurredAt: number
  status: 'delivered' | 'pending' | 'quarantined'
  attempts: number
  deliveredAt?: number
  nextAttemptAt: number
  lastAttemptAt?: number
  lastError?: string
  createdAt: number
}

export type WebhookAcceptance =
  | { accepted: true; event: TriggerOutboxEvent }
  | { accepted: false; event?: TriggerOutboxEvent; reason: 'cooldown' | 'limit' | 'replay' | 'ttl' }

interface StateRow {
  trigger_id: string
  first_observed_at: number
  last_observed_at: number
  last_fingerprint: string
  last_truthy: number
  edge_revision: number
  pending_fingerprint: string | null
  pending_since: number | null
  pending_revision: number | null
  last_fire_at: number | null
  fire_count: number
}

interface OutboxRow {
  id: string
  trigger_id: string
  event_id: string
  occurred_at: number
  status: 'delivered' | 'pending' | 'quarantined'
  attempts: number
  delivered_at: number | null
  created_at: number
  next_attempt_at: number
  last_attempt_at: number | null
  last_error: string | null
}

function event(row: OutboxRow): TriggerOutboxEvent {
  return Object.freeze({
    id: row.id, triggerId: row.trigger_id, eventId: row.event_id, occurredAt: row.occurred_at,
    status: row.status, attempts: row.attempts,
    ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }),
    nextAttemptAt: row.next_attempt_at,
    ...(row.last_attempt_at === null ? {} : { lastAttemptAt: row.last_attempt_at }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    createdAt: row.created_at,
  })
}

function stableEventId(triggerId: string, key: string): string {
  return `event-${createHash('sha256').update(`${triggerId}\0${key}`).digest('hex')}`
}

function validTime(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new EventTriggerStoreError('invalid-input', `${field} is invalid`)
}

function errorText(value: unknown): string {
  try {
    const candidate: unknown = value instanceof Error ? value.message : value
    const text = typeof candidate === 'string' ? candidate : 'unknown failure'
    const printable = [...text.slice(0, 2_048).normalize('NFC')].map(character => {
      const codePoint = character.codePointAt(0)!
      return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character
    }).join('')
    return printable.slice(0, 512) || 'unknown failure'
  } catch {
    return 'unknown failure'
  }
}

export class EventTriggerStore {
  private readonly database: DatabaseSync
  private readonly now: () => number
  private closed = false

  constructor(options: { path: string; now?: () => number }) {
    this.now = options.now ?? Date.now
    try { this.database = openEventTriggerDatabase(options.path) } catch (error) {
      if (error instanceof EventTriggerDatabaseError) throw new EventTriggerStoreError(error.code, error.message)
      throw error
    }
  }

  close(): void { if (!this.closed) { this.closed = true; this.database.close() } }

  observe(input: {
    triggerId: string
    fingerprint: string
    truthy: boolean
    occurredAt: number
    fireWhen: FireWhen
    debounceMs: number
    cooldownMs: number
    maxFires: number
    ttlMs?: number
  }): TriggerOutboxEvent[] {
    validTime(input.occurredAt, 'occurredAt')
    return this.transaction(() => {
      let state = this.state(input.triggerId)
      if (state === undefined) {
        this.database.prepare(`
          INSERT INTO trigger_state(
            trigger_id, first_observed_at, last_observed_at, last_fingerprint, last_truthy,
            edge_revision, pending_fingerprint, pending_since, pending_revision, last_fire_at, fire_count
          ) VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, 0)
        `).run(input.triggerId, input.occurredAt, input.occurredAt, input.fingerprint, input.truthy ? 1 : 0)
        return []
      }
      if ((input.ttlMs !== undefined && input.occurredAt >= state.first_observed_at + input.ttlMs)
        || state.fire_count >= input.maxFires) return []
      if (state.last_fingerprint !== input.fingerprint) {
        const revision = state.edge_revision + 1
        const qualifies = input.fireWhen === 'changed' || (input.truthy && state.last_truthy === 0)
        this.database.prepare(`
          UPDATE trigger_state
          SET last_observed_at = ?, last_fingerprint = ?, last_truthy = ?, edge_revision = ?,
              pending_fingerprint = ?, pending_since = ?, pending_revision = ?
          WHERE trigger_id = ?
        `).run(
          input.occurredAt, input.fingerprint, input.truthy ? 1 : 0, revision,
          qualifies ? input.fingerprint : null, qualifies ? input.occurredAt : null, qualifies ? revision : null,
          input.triggerId,
        )
        state = this.state(input.triggerId)!
      } else {
        this.database.prepare('UPDATE trigger_state SET last_observed_at = ? WHERE trigger_id = ?')
          .run(input.occurredAt, input.triggerId)
      }
      if (state.pending_revision === null || state.pending_since === null) return []
      if (input.occurredAt < state.pending_since + input.debounceMs) return []
      if (state.last_fire_at !== null && input.occurredAt < state.last_fire_at + input.cooldownMs) return []
      const created = this.insertOutbox(input.triggerId, `edge:${state.pending_revision}`, input.occurredAt)
      this.database.prepare(`
        UPDATE trigger_state SET pending_fingerprint = NULL, pending_since = NULL, pending_revision = NULL,
          last_fire_at = ?, fire_count = fire_count + 1 WHERE trigger_id = ?
      `).run(input.occurredAt, input.triggerId)
      return created === undefined ? [] : [created]
    })
  }

  acceptWebhook(input: {
    triggerId: string
    eventId: string
    occurredAt: number
    /** Trusted server receipt time. Defaults to occurredAt for API compatibility. */
    acceptedAt?: number
    cooldownMs?: number
    maxFires: number
    ttlMs?: number
  }): WebhookAcceptance {
    validTime(input.occurredAt, 'occurredAt')
    const acceptedAt = input.acceptedAt ?? input.occurredAt
    validTime(acceptedAt, 'acceptedAt')
    return this.transaction(() => {
      const prior = this.byEventId(stableEventId(input.triggerId, `webhook:${input.eventId}`))
      if (prior !== undefined) return { accepted: false, event: prior, reason: 'replay' }
      let state = this.state(input.triggerId)
      if (state === undefined) {
        this.database.prepare(`
          INSERT INTO trigger_state(
            trigger_id, first_observed_at, last_observed_at, last_fingerprint, last_truthy,
            edge_revision, pending_fingerprint, pending_since, pending_revision, last_fire_at, fire_count
          ) VALUES (?, ?, ?, '', 1, 0, NULL, NULL, NULL, NULL, 0)
        `).run(input.triggerId, acceptedAt, acceptedAt)
        state = this.state(input.triggerId)!
      }
      if (input.ttlMs !== undefined && acceptedAt >= state.first_observed_at + input.ttlMs) {
        return { accepted: false, reason: 'ttl' }
      }
      if (state.fire_count >= input.maxFires) return { accepted: false, reason: 'limit' }
      if (state.last_fire_at !== null && acceptedAt < state.last_fire_at + (input.cooldownMs ?? 0)) {
        return { accepted: false, reason: 'cooldown' }
      }
      const created = this.insertOutbox(input.triggerId, `webhook:${input.eventId}`, input.occurredAt)
      if (created === undefined) return { accepted: false, reason: 'replay' }
      this.database.prepare(`
        UPDATE trigger_state SET last_observed_at = ?, last_fire_at = ?, fire_count = fire_count + 1
        WHERE trigger_id = ?
      `).run(acceptedAt, acceptedAt, input.triggerId)
      return { accepted: true, event: created }
    })
  }

  hasWebhookEvent(triggerId: string, externalEventId: string): boolean {
    return this.byEventId(stableEventId(triggerId, `webhook:${externalEventId}`)) !== undefined
  }

  pending(limit = 1_000): TriggerOutboxEvent[] {
    return (this.database.prepare(`
      SELECT * FROM event_outbox
      WHERE status = 'pending' AND next_attempt_at <= ?
      ORDER BY next_attempt_at, created_at, id LIMIT ?
    `).all(this.now(), limit) as unknown as OutboxRow[]).map(event)
  }

  markAttempt(id: string): void {
    this.database.prepare(`
      UPDATE event_outbox SET attempts = attempts + 1, last_attempt_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(this.now(), id)
  }

  markRetry(id: string, error: unknown, nextAttemptAt: number): void {
    validTime(nextAttemptAt, 'nextAttemptAt')
    this.database.prepare(`
      UPDATE event_outbox SET next_attempt_at = ?, last_error = ?
      WHERE id = ? AND status = 'pending'
    `).run(nextAttemptAt, errorText(error), id)
  }

  quarantine(id: string, reason: unknown): void {
    this.database.prepare(`
      UPDATE event_outbox
      SET status = 'quarantined', last_attempt_at = ?, last_error = ?
      WHERE id = ? AND status = 'pending'
    `).run(this.now(), errorText(reason), id)
  }

  markDelivered(id: string): TriggerOutboxEvent {
    const now = this.now()
    this.database.prepare(`
      UPDATE event_outbox
      SET status = 'delivered', delivered_at = ?, last_error = NULL
      WHERE id = ? AND status = 'pending'
    `).run(now, id)
    const row = this.database.prepare('SELECT * FROM event_outbox WHERE id = ?').get(id) as OutboxRow | undefined
    if (row === undefined) throw new EventTriggerStoreError('invalid-input', 'event outbox row was not found')
    return event(row)
  }

  markTriggerFailure(triggerId: string, error: unknown, failedAt = this.now()): void {
    validTime(failedAt, 'failedAt')
    this.database.prepare(`
      INSERT INTO trigger_health(trigger_id, consecutive_failures, last_error, last_failed_at, last_success_at)
      VALUES (?, 1, ?, ?, NULL)
      ON CONFLICT(trigger_id) DO UPDATE SET
        consecutive_failures = consecutive_failures + 1,
        last_error = excluded.last_error,
        last_failed_at = excluded.last_failed_at
    `).run(triggerId, errorText(error), failedAt)
  }

  markTriggerSuccess(triggerId: string, succeededAt = this.now()): void {
    validTime(succeededAt, 'succeededAt')
    this.database.prepare(`
      INSERT INTO trigger_health(trigger_id, consecutive_failures, last_error, last_failed_at, last_success_at)
      VALUES (?, 0, NULL, NULL, ?)
      ON CONFLICT(trigger_id) DO UPDATE SET
        consecutive_failures = 0, last_error = NULL, last_success_at = excluded.last_success_at
    `).run(triggerId, succeededAt)
  }

  health(): {
    pendingEvents: number
    retryingEvents: number
    quarantinedEvents: number
    deliveredEvents: number
    triggersObserved: number
    failingTriggers: number
    lastOutboxError?: string
    lastTriggerError?: string
  } {
    const count = (sql: string) => (this.database.prepare(sql).get() as { count: number }).count
    const outboxError = this.database.prepare(`
      SELECT last_error FROM event_outbox WHERE last_error IS NOT NULL
      ORDER BY COALESCE(last_attempt_at, created_at) DESC, id DESC LIMIT 1
    `).get() as { last_error: string } | undefined
    const triggerError = this.database.prepare(`
      SELECT last_error FROM trigger_health WHERE consecutive_failures > 0 AND last_error IS NOT NULL
      ORDER BY last_failed_at DESC, trigger_id DESC LIMIT 1
    `).get() as { last_error: string } | undefined
    return Object.freeze({
      pendingEvents: count("SELECT COUNT(*) AS count FROM event_outbox WHERE status = 'pending'"),
      retryingEvents: count("SELECT COUNT(*) AS count FROM event_outbox WHERE status = 'pending' AND attempts > 0"),
      quarantinedEvents: count("SELECT COUNT(*) AS count FROM event_outbox WHERE status = 'quarantined'"),
      deliveredEvents: count("SELECT COUNT(*) AS count FROM event_outbox WHERE status = 'delivered'"),
      triggersObserved: count('SELECT COUNT(*) AS count FROM trigger_state'),
      failingTriggers: count('SELECT COUNT(*) AS count FROM trigger_health WHERE consecutive_failures > 0'),
      ...(outboxError === undefined ? {} : { lastOutboxError: outboxError.last_error }),
      ...(triggerError === undefined ? {} : { lastTriggerError: triggerError.last_error }),
    })
  }

  private state(id: string): StateRow | undefined {
    return this.database.prepare('SELECT * FROM trigger_state WHERE trigger_id = ?').get(id) as StateRow | undefined
  }

  private byEventId(eventId: string): TriggerOutboxEvent | undefined {
    const row = this.database.prepare('SELECT * FROM event_outbox WHERE event_id = ?').get(eventId) as OutboxRow | undefined
    return row === undefined ? undefined : event(row)
  }

  private insertOutbox(triggerId: string, key: string, occurredAt: number): TriggerOutboxEvent | undefined {
    const eventId = stableEventId(triggerId, key)
    const id = `outbox-${eventId.slice('event-'.length)}`
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO event_outbox(
        id, trigger_id, event_id, occurred_at, status, attempts, delivered_at, created_at,
        next_attempt_at, last_attempt_at, last_error
      ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, ?, ?, NULL, NULL)
    `).run(id, triggerId, eventId, occurredAt, this.now(), this.now())
    if (result.changes === 0) return undefined
    return this.byEventId(eventId)
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try { const result = operation(); this.database.exec('COMMIT'); return result } catch (error) {
      this.database.exec('ROLLBACK'); throw error
    }
  }
}
