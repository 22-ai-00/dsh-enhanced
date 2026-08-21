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
  status: 'delivered' | 'pending'
  attempts: number
  deliveredAt?: number
  createdAt: number
}

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
  status: 'delivered' | 'pending'
  attempts: number
  delivered_at: number | null
  created_at: number
}

function event(row: OutboxRow): TriggerOutboxEvent {
  return Object.freeze({
    id: row.id, triggerId: row.trigger_id, eventId: row.event_id, occurredAt: row.occurred_at,
    status: row.status, attempts: row.attempts,
    ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }), createdAt: row.created_at,
  })
}

function stableEventId(triggerId: string, key: string): string {
  return `event-${createHash('sha256').update(`${triggerId}\0${key}`).digest('hex')}`
}

function validTime(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new EventTriggerStoreError('invalid-input', `${field} is invalid`)
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
    maxFires: number
    ttlMs?: number
  }): { accepted: boolean; event: TriggerOutboxEvent | undefined } {
    validTime(input.occurredAt, 'occurredAt')
    return this.transaction(() => {
      const prior = this.byEventId(stableEventId(input.triggerId, `webhook:${input.eventId}`))
      if (prior !== undefined) return { accepted: false, event: prior }
      let state = this.state(input.triggerId)
      if (state === undefined) {
        this.database.prepare(`
          INSERT INTO trigger_state(
            trigger_id, first_observed_at, last_observed_at, last_fingerprint, last_truthy,
            edge_revision, pending_fingerprint, pending_since, pending_revision, last_fire_at, fire_count
          ) VALUES (?, ?, ?, '', 1, 0, NULL, NULL, NULL, NULL, 0)
        `).run(input.triggerId, input.occurredAt, input.occurredAt)
        state = this.state(input.triggerId)!
      }
      if ((input.ttlMs !== undefined && input.occurredAt >= state.first_observed_at + input.ttlMs)
        || state.fire_count >= input.maxFires) return { accepted: false, event: undefined }
      const created = this.insertOutbox(input.triggerId, `webhook:${input.eventId}`, input.occurredAt)
      this.database.prepare(`
        UPDATE trigger_state SET last_observed_at = ?, last_fire_at = ?, fire_count = fire_count + 1
        WHERE trigger_id = ?
      `).run(input.occurredAt, input.occurredAt, input.triggerId)
      return { accepted: created !== undefined, event: created }
    })
  }

  hasWebhookEvent(triggerId: string, externalEventId: string): boolean {
    return this.byEventId(stableEventId(triggerId, `webhook:${externalEventId}`)) !== undefined
  }

  pending(limit = 1_000): TriggerOutboxEvent[] {
    return (this.database.prepare(`
      SELECT * FROM event_outbox WHERE status = 'pending' ORDER BY created_at, id LIMIT ?
    `).all(limit) as unknown as OutboxRow[]).map(event)
  }

  markAttempt(id: string): void {
    this.database.prepare("UPDATE event_outbox SET attempts = attempts + 1 WHERE id = ? AND status = 'pending'").run(id)
  }

  markDelivered(id: string): TriggerOutboxEvent {
    const now = this.now()
    this.database.prepare(`
      UPDATE event_outbox SET status = 'delivered', delivered_at = ? WHERE id = ? AND status = 'pending'
    `).run(now, id)
    const row = this.database.prepare('SELECT * FROM event_outbox WHERE id = ?').get(id) as OutboxRow | undefined
    if (row === undefined) throw new EventTriggerStoreError('invalid-input', 'event outbox row was not found')
    return event(row)
  }

  health(): { pendingEvents: number; deliveredEvents: number; triggersObserved: number } {
    const count = (sql: string) => (this.database.prepare(sql).get() as { count: number }).count
    return {
      pendingEvents: count("SELECT COUNT(*) AS count FROM event_outbox WHERE status = 'pending'"),
      deliveredEvents: count("SELECT COUNT(*) AS count FROM event_outbox WHERE status = 'delivered'"),
      triggersObserved: count('SELECT COUNT(*) AS count FROM trigger_state'),
    }
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
        id, trigger_id, event_id, occurred_at, status, attempts, delivered_at, created_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, ?)
    `).run(id, triggerId, eventId, occurredAt, this.now())
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
