import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { CredentialDatabaseError, openCredentialDatabase } from './sqlite.js'
import type { CredentialLeaseRecord, CredentialLeaseStatus } from './types.js'

export type CredentialLedgerErrorCode =
  | 'idempotency-conflict'
  | 'invalid-input'
  | 'invalid-path'
  | 'invalid-state'
  | 'not-found'
  | 'schema-too-new'
  | 'version-conflict'

export class CredentialLedgerError extends Error {
  constructor(readonly code: CredentialLedgerErrorCode, message: string) {
    super(message)
    this.name = 'CredentialLedgerError'
  }
}

export interface CredentialLedgerOptions {
  path: string
  now?: () => number
}

export interface CredentialAuditRecord {
  sequence: number
  occurredAt: number
  action: string
  leaseId: string
  handleId: string
  consumer: string
  purpose: string
  outcome: string
  failureCode?: string
  actor?: string
  reason?: string
}

interface LeaseRow {
  id: string
  idempotency_key: string
  handle_id: string
  consumer: string
  purpose: string
  status: CredentialLeaseStatus
  issued_at: number
  expires_at: number
  settled_at: number | null
  failure_code: string | null
  version: number
}

interface AuditRow {
  sequence: number
  occurred_at: number
  action: string
  lease_id: string
  handle_id: string
  consumer: string
  purpose: string
  outcome: string
  failure_code: string | null
  actor: string | null
  reason: string | null
}

function text(value: string, field: string): void {
  if (value.trim().length === 0 || value.length > 256) {
    throw new CredentialLedgerError('invalid-input', `${field} must contain 1..256 characters`)
  }
}

function record(row: LeaseRow): CredentialLeaseRecord {
  return {
    id: row.id,
    handleId: row.handle_id,
    consumer: row.consumer,
    purpose: row.purpose,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    ...(row.settled_at === null ? {} : { settledAt: row.settled_at }),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    version: row.version,
  }
}

export class CredentialLedger {
  readonly #database: DatabaseSync
  readonly #now: () => number
  #closed = false

  constructor(options: CredentialLedgerOptions) {
    this.#now = options.now ?? Date.now
    try {
      this.#database = openCredentialDatabase(options.path)
    } catch (error) {
      if (error instanceof CredentialDatabaseError) throw new CredentialLedgerError(error.code, error.message)
      throw error
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#database.close()
  }

  begin(input: {
    handleId: string
    consumer: string
    purpose: string
    idempotencyKey: string
    ttlMs: number
  }): { record: CredentialLeaseRecord; replayed: boolean } {
    text(input.handleId, 'handleId')
    text(input.consumer, 'consumer')
    text(input.purpose, 'purpose')
    text(input.idempotencyKey, 'idempotencyKey')
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
      throw new CredentialLedgerError('invalid-input', 'ttlMs must be a positive safe integer')
    }
    const now = this.#now()
    return this.#transaction(() => {
      const existing = this.#byIdempotency(input.idempotencyKey)
      if (existing !== undefined) {
        if (existing.handle_id !== input.handleId || existing.consumer !== input.consumer
          || existing.purpose !== input.purpose || existing.expires_at - existing.issued_at !== input.ttlMs) {
          throw new CredentialLedgerError('idempotency-conflict', 'idempotency key belongs to another lease request')
        }
        if (existing.status === 'active' && existing.expires_at <= now) {
          const expired = this.#settleRow(existing, 'expired', 'lease-expired', now)
          return { record: record(expired), replayed: true }
        }
        return { record: record(existing), replayed: true }
      }
      const row: LeaseRow = {
        id: randomUUID(), idempotency_key: input.idempotencyKey, handle_id: input.handleId,
        consumer: input.consumer, purpose: input.purpose, status: 'active', issued_at: now,
        expires_at: now + input.ttlMs, settled_at: null, failure_code: null, version: 1,
      }
      this.#database.prepare(`
        INSERT INTO credential_leases(
          id, idempotency_key, handle_id, consumer, purpose, status, issued_at, expires_at,
          settled_at, failure_code, version
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, 1)
      `).run(row.id, row.idempotency_key, row.handle_id, row.consumer, row.purpose, row.issued_at, row.expires_at)
      this.#audit(row, 'lease.begin', 'active')
      return { record: record(row), replayed: false }
    })
  }

  get(id: string): CredentialLeaseRecord | undefined {
    const row = this.#row(id)
    return row === undefined ? undefined : record(row)
  }

  settle(input: {
    leaseId: string
    expectedVersion: number
    status: 'completed' | 'expired' | 'failed'
    failureCode?: string
  }): CredentialLeaseRecord {
    return this.#transaction(() => {
      const row = this.#required(input.leaseId)
      if (row.version !== input.expectedVersion) throw new CredentialLedgerError('version-conflict', 'lease version changed')
      if (row.status !== 'active') {
        if (row.status === input.status) return record(row)
        throw new CredentialLedgerError('invalid-state', `cannot settle a ${row.status} lease`)
      }
      return record(this.#settleRow(row, input.status, input.failureCode ?? null, this.#now()))
    })
  }

  revoke(input: { leaseId: string; expectedVersion: number; actor: string; reason: string }): CredentialLeaseRecord {
    text(input.actor, 'actor')
    text(input.reason, 'reason')
    return this.#transaction(() => {
      const row = this.#required(input.leaseId)
      if (row.version !== input.expectedVersion) throw new CredentialLedgerError('version-conflict', 'lease version changed')
      if (row.status === 'revoked') return record(row)
      if (row.status !== 'active') throw new CredentialLedgerError('invalid-state', `cannot revoke a ${row.status} lease`)
      const revoked = this.#settleRow(row, 'revoked', 'operator-revoked', this.#now(), input.actor, input.reason)
      return record(revoked)
    })
  }

  expire(): number {
    const now = this.#now()
    return this.#transaction(() => {
      const rows = this.#database.prepare(`
        SELECT * FROM credential_leases WHERE status = 'active' AND expires_at <= ? ORDER BY id
      `).all(now) as unknown as LeaseRow[]
      for (const row of rows) this.#settleRow(row, 'expired', 'lease-expired', now)
      return rows.length
    })
  }

  list(input: { status?: CredentialLeaseStatus; limit?: number } = {}): CredentialLeaseRecord[] {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1_000)
    const rows = input.status === undefined
      ? this.#database.prepare('SELECT * FROM credential_leases ORDER BY issued_at DESC, id DESC LIMIT ?').all(limit)
      : this.#database.prepare('SELECT * FROM credential_leases WHERE status = ? ORDER BY issued_at DESC, id DESC LIMIT ?')
          .all(input.status, limit)
    return (rows as unknown as LeaseRow[]).map(record)
  }

  listAudit(input: { limit?: number } = {}): CredentialAuditRecord[] {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1_000)
    const rows = this.#database.prepare('SELECT * FROM credential_audit ORDER BY sequence DESC LIMIT ?')
      .all(limit) as unknown as AuditRow[]
    return rows.map(row => ({
      sequence: row.sequence, occurredAt: row.occurred_at, action: row.action, leaseId: row.lease_id,
      handleId: row.handle_id, consumer: row.consumer, purpose: row.purpose, outcome: row.outcome,
      ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
      ...(row.actor === null ? {} : { actor: row.actor }),
      ...(row.reason === null ? {} : { reason: row.reason }),
    }))
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const value = operation()
      this.#database.exec('COMMIT')
      return value
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  #row(id: string): LeaseRow | undefined {
    return this.#database.prepare('SELECT * FROM credential_leases WHERE id = ?').get(id) as LeaseRow | undefined
  }

  #required(id: string): LeaseRow {
    const row = this.#row(id)
    if (row === undefined) throw new CredentialLedgerError('not-found', 'credential lease does not exist')
    return row
  }

  #byIdempotency(key: string): LeaseRow | undefined {
    return this.#database.prepare('SELECT * FROM credential_leases WHERE idempotency_key = ?').get(key) as LeaseRow | undefined
  }

  #settleRow(
    row: LeaseRow,
    status: Exclude<CredentialLeaseStatus, 'active'>,
    failureCode: string | null,
    now: number,
    actor?: string,
    reason?: string,
  ): LeaseRow {
    this.#database.prepare(`
      UPDATE credential_leases
      SET status = ?, settled_at = ?, failure_code = ?, version = version + 1
      WHERE id = ? AND version = ? AND status = 'active'
    `).run(status, now, failureCode, row.id, row.version)
    const updated: LeaseRow = { ...row, status, settled_at: now, failure_code: failureCode, version: row.version + 1 }
    this.#audit(updated, `lease.${status}`, status, actor, reason)
    return updated
  }

  #audit(row: LeaseRow, action: string, outcome: string, actor?: string, reason?: string): void {
    this.#database.prepare(`
      INSERT INTO credential_audit(
        occurred_at, action, lease_id, handle_id, consumer, purpose, outcome, failure_code, actor, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(this.#now(), action, row.id, row.handle_id, row.consumer, row.purpose, outcome,
      row.failure_code, actor ?? null, reason ?? null)
  }
}
