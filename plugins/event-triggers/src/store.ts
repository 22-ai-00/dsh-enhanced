import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { externalEventDigest, parseExternalEventEnvelope } from '@dsh-enhanced/assistant-automations/external-event'
import { EventTriggerDatabaseError, openEventTriggerDatabase } from './sqlite.js'
import type { FireWhen } from './config.js'

export type EventTriggerStoreErrorCode = 'invalid-input' | 'invalid-path' | 'invalid-schema' | 'schema-too-new'
export class EventTriggerStoreError extends Error {
  constructor(readonly code: EventTriggerStoreErrorCode, message: string) {
    super(message)
    this.name = 'EventTriggerStoreError'
  }
}

export interface TriggerOutboxEvent {
  id: string
  /** Durable, never-reused event-source cursor. */
  sequence: number
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
  /** Undefined only for rows written before provenance envelopes were introduced. */
  envelope?: Readonly<{ canonical: string; digest: string }>
}

/** Internal raw source row. Provenance parsing remains at the host boundary. */
export interface EventSourceCandidate {
  sequence: number
  eventId: string
  canonical: string
  digest: string
}

export interface GoalSourceClaim {
  triggerId: string
  scope: { principalId: string; principalRecordId: string; principalVersion: number; workspace: string; preset: string }
  goalId: string
  definition: { version: number; digest: string }
  native: { sessionId: string; goalId: string; revision: number }
  configDigest: string
  automationId: string
}

export interface StoredGoalSourceClaim extends GoalSourceClaim { retiredAt?: number }

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
  sequence: number
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
  envelope_canonical: string | null
  envelope_digest: string | null
}

function validateEnvelope(
  canonical: string,
  digest: string,
  binding: Pick<TriggerOutboxEvent, 'triggerId' | 'eventId' | 'occurredAt'>,
): void {
  try {
    const envelope = parseExternalEventEnvelope(JSON.parse(canonical))
    if (externalEventDigest(envelope) !== digest
      || envelope.source.id !== `event-triggers:${binding.triggerId}`
      || envelope.event.id !== binding.eventId
      || envelope.event.occurredAt !== binding.occurredAt) {
      throw new Error('mismatch')
    }
  } catch {
    throw new EventTriggerStoreError('invalid-input', 'event outbox provenance is invalid or does not bind its row')
  }
}

function event(row: OutboxRow): TriggerOutboxEvent {
  const hasEnvelope = row.envelope_canonical !== null || row.envelope_digest !== null
  if (hasEnvelope) {
    if (row.envelope_canonical === null || row.envelope_digest === null) {
      throw new EventTriggerStoreError('invalid-input', 'event outbox provenance is invalid or does not bind its row')
    }
    validateEnvelope(row.envelope_canonical, row.envelope_digest, {
      triggerId: row.trigger_id, eventId: row.event_id, occurredAt: row.occurred_at,
    })
  }
  return Object.freeze({
    id: row.id, sequence: row.sequence, triggerId: row.trigger_id, eventId: row.event_id, occurredAt: row.occurred_at,
    status: row.status, attempts: row.attempts,
    ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }),
    nextAttemptAt: row.next_attempt_at,
    ...(row.last_attempt_at === null ? {} : { lastAttemptAt: row.last_attempt_at }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    createdAt: row.created_at,
    ...(hasEnvelope ? { envelope: Object.freeze({ canonical: row.envelope_canonical!, digest: row.envelope_digest! }) } : {}),
  })
}

function stableEventId(triggerId: string, key: string): string {
  return `event-${createHash('sha256').update(`${triggerId}\0${key}`).digest('hex')}`
}

function validTime(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new EventTriggerStoreError('invalid-input', `${field} is invalid`)
}

const identifier = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
function validClaim(value: unknown): value is GoalSourceClaim {
  if (!value || typeof value !== 'object') return false
  const claim = value as GoalSourceClaim
  const scope = claim.scope
  return identifier(claim.triggerId, 200) && identifier(claim.goalId) && Number.isSafeInteger(claim.definition?.version) && claim.definition.version > 0
    && sha256(claim.definition?.digest) && identifier(claim.native?.sessionId) && identifier(claim.native?.goalId)
    && Number.isSafeInteger(claim.native?.revision) && claim.native.revision >= 0 && sha256(claim.configDigest)
    && identifier(claim.automationId, 200) && !!scope && identifier(scope.principalId) && identifier(scope.principalRecordId)
    && Number.isSafeInteger(scope.principalVersion) && scope.principalVersion > 0 && identifier(scope.workspace, 4_096) && identifier(scope.preset)
}
function sameClaim(left: GoalSourceClaim, right: GoalSourceClaim): boolean {
  const key = (value: GoalSourceClaim) => [value.triggerId, value.scope.principalId, value.scope.principalRecordId,
    value.scope.principalVersion, value.scope.workspace, value.scope.preset, value.goalId, value.definition.version,
    value.definition.digest, value.native.sessionId, value.native.goalId, value.configDigest, value.automationId]
  return JSON.stringify(key(left)) === JSON.stringify(key(right)) && right.native.revision >= left.native.revision
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
    /** Creates an immutable provenance snapshot after the stable outbox event id is known. */
    envelope?: (eventId: string, revision: string) => Readonly<{ canonical: string; digest: string }>
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
      const created = this.insertOutbox(input.triggerId, `edge:${state.pending_revision}`, input.occurredAt, input.envelope)
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
    envelope?: (eventId: string, revision: string) => Readonly<{ canonical: string; digest: string }>
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
      const created = this.insertOutbox(input.triggerId, `webhook:${input.eventId}`, input.occurredAt, input.envelope)
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

  /** Returns a bounded raw page; malformed provenance is validated by the reader. */
  sourceCandidatesAfter(input: {
    triggerId: string
    afterSequence: number
    throughSequence: number
    deadlineAt: number
    sourceId: string
    kind: 'file' | 'http-json' | 'webhook' | 'github-repository'
    version: string
    configDigest: string
    automationId: string
  }, limit = 100): EventSourceCandidate[] {
    validTime(input.afterSequence, 'afterSequence')
    validTime(input.throughSequence, 'throughSequence')
    validTime(input.deadlineAt, 'deadlineAt')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new EventTriggerStoreError('invalid-input', 'source candidate limit is invalid')
    }
    const rows = this.database.prepare(`
      SELECT sequence, event_id AS eventId, envelope_canonical AS canonical, envelope_digest AS digest
      FROM event_outbox
      WHERE trigger_id = ? AND sequence > ? AND sequence <= ?
        AND envelope_canonical IS NOT NULL AND envelope_digest IS NOT NULL
        AND CASE WHEN json_valid(envelope_canonical) THEN json_extract(envelope_canonical, '$.source.id') END = ?
        AND CASE WHEN json_valid(envelope_canonical) THEN json_extract(envelope_canonical, '$.source.kind') END = ?
        AND CASE WHEN json_valid(envelope_canonical) THEN json_extract(envelope_canonical, '$.source.version') END = ?
        AND CASE WHEN json_valid(envelope_canonical) THEN json_extract(envelope_canonical, '$.source.configDigest') END = ?
        AND CASE WHEN json_valid(envelope_canonical) THEN json_extract(envelope_canonical, '$.target.automationId') END = ?
        AND CASE WHEN json_valid(envelope_canonical) THEN json_extract(envelope_canonical, '$.event.receivedAt') END <= ?
      ORDER BY sequence LIMIT ?
    `).all(
      input.triggerId, input.afterSequence, input.throughSequence, input.sourceId, input.kind, input.version,
      input.configDigest, input.automationId, input.deadlineAt, limit,
    ) as unknown as EventSourceCandidate[]
    return rows
  }

  sourceHighWaterSequence(): number {
    return (this.database.prepare(`
      SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'event_sequence'), 0) AS sequence
    `).get() as { sequence: number }).sequence
  }

  claimGoalSource(input: GoalSourceClaim): StoredGoalSourceClaim {
    if (!validClaim(input)) throw new EventTriggerStoreError('invalid-input', 'event goal source claim is invalid')
    return this.transaction(() => {
      const prior = this.goalSourceClaim(input.triggerId)
      if (prior !== undefined) {
        if (!sameClaim(prior, input)) throw new EventTriggerStoreError('invalid-input', 'event goal source is already claimed by another goal')
        return prior
      }
      this.database.prepare(`INSERT INTO goal_source_claims(
        trigger_id, scope_json, goal_id, definition_version, definition_digest, session_id, native_goal_id,
        native_revision, config_digest, automation_id, retired_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
        input.triggerId, JSON.stringify(input.scope), input.goalId, input.definition.version, input.definition.digest,
        input.native.sessionId, input.native.goalId, input.native.revision, input.configDigest, input.automationId,
      )
      return this.goalSourceClaim(input.triggerId)!
    })
  }

  goalSourceClaim(triggerId: string): StoredGoalSourceClaim | undefined {
    const row = this.database.prepare(`SELECT trigger_id, scope_json, goal_id, definition_version, definition_digest,
      session_id, native_goal_id, native_revision, config_digest, automation_id, retired_at
      FROM goal_source_claims WHERE trigger_id = ?`).get(triggerId) as {
        trigger_id: string; scope_json: string; goal_id: string; definition_version: number; definition_digest: string
        session_id: string; native_goal_id: string; native_revision: number; config_digest: string; automation_id: string; retired_at: number | null
      } | undefined
    if (!row) return undefined
    let scope: GoalSourceClaim['scope']
    try { scope = JSON.parse(row.scope_json) as GoalSourceClaim['scope'] } catch { throw new EventTriggerStoreError('invalid-schema', 'event goal source claim is malformed') }
    const value: StoredGoalSourceClaim = { triggerId: row.trigger_id, scope, goalId: row.goal_id,
      definition: { version: row.definition_version, digest: row.definition_digest },
      native: { sessionId: row.session_id, goalId: row.native_goal_id, revision: row.native_revision },
      configDigest: row.config_digest, automationId: row.automation_id,
      ...(row.retired_at === null ? {} : { retiredAt: row.retired_at }) }
    if (!validClaim(value) || (value.retiredAt !== undefined && (!Number.isSafeInteger(value.retiredAt) || value.retiredAt < 0))) {
      throw new EventTriggerStoreError('invalid-schema', 'event goal source claim is invalid')
    }
    return Object.freeze(value)
  }

  retireGoalSource(input: GoalSourceClaim): StoredGoalSourceClaim {
    if (!validClaim(input)) throw new EventTriggerStoreError('invalid-input', 'event goal source claim is invalid')
    return this.transaction(() => {
      const prior = this.goalSourceClaim(input.triggerId)
      if (!prior || !sameClaim(prior, input)) throw new EventTriggerStoreError('invalid-input', 'event goal source claim does not match')
      if (prior.retiredAt !== undefined) return prior
      this.database.prepare('UPDATE goal_source_claims SET retired_at = ? WHERE trigger_id = ? AND retired_at IS NULL')
        .run(this.now(), input.triggerId)
      return this.goalSourceClaim(input.triggerId)!
    })
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

  private insertOutbox(
    triggerId: string,
    key: string,
    occurredAt: number,
    provenance?: (eventId: string, revision: string) => Readonly<{ canonical: string; digest: string }>,
  ): TriggerOutboxEvent | undefined {
    const eventId = stableEventId(triggerId, key)
    const id = `outbox-${eventId.slice('event-'.length)}`
    const envelope = provenance?.(eventId, key)
    if (envelope !== undefined) {
      validateEnvelope(envelope.canonical, envelope.digest, { triggerId, eventId, occurredAt })
    }
    const allocation = this.database.prepare('INSERT INTO event_sequence DEFAULT VALUES').run()
    const sequence = Number(allocation.lastInsertRowid)
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new EventTriggerStoreError('invalid-input', 'event sequence allocation is invalid')
    }
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO event_outbox(
        id, sequence, trigger_id, event_id, occurred_at, status, attempts, delivered_at, created_at,
        next_attempt_at, last_attempt_at, last_error, envelope_canonical, envelope_digest
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?, NULL, NULL, ?, ?)
    `).run(id, sequence, triggerId, eventId, occurredAt, this.now(), this.now(), envelope?.canonical ?? null, envelope?.digest ?? null)
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
