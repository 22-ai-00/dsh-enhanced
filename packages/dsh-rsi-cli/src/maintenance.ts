import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export class MaintenanceError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'MaintenanceError'
    this.code = code
  }
}

function fail(code: string, message: string): never {
  throw new MaintenanceError(code, message)
}

function openStore(path: string): DatabaseSync {
  if (!existsSync(path)) fail('not-found', 'ledger not found: ' + path)
  const database = new DatabaseSync(path)
  database.exec('PRAGMA busy_timeout = 15000')
  return database
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    database.exec('COMMIT')
    return result
  } catch (error) {
    try { database.exec('ROLLBACK') } catch { /* already rolled back */ }
    throw error
  }
}

export function canonicalOperatorId(input: unknown): string {
  if (typeof input !== 'string') fail('invalid-operator', 'operator id must be a string')
  const normalized = input.normalize('NFC').trim()
  const hasControl = [...normalized].some((character) => {
    const code = character.codePointAt(0)!
    return code <= 0x1f || code === 0x7f
  })
  if (normalized === '' || Buffer.byteLength(normalized, 'utf8') > 256 || hasControl) {
    fail('invalid-operator', 'operator id is invalid')
  }
  return normalized
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function requiredText(value: unknown, field: string, maximum = 500): string {
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value, 'utf8') > maximum) {
    fail('invalid-input', field + ' must be a non-empty string of at most ' + maximum + ' bytes')
  }
  return value
}

function requiredInteger(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    fail('invalid-input', field + ' must be a safe integer >= ' + minimum)
  }
  return value
}

export interface DeadLetterRow {
  readonly kind: 'inbox' | 'outbox'
  readonly id: string
  readonly attemptCount: number
  readonly status: string
  readonly failureCode: string | null
  readonly updatedAt: number
}

export function deliveryLedgerPath(dshHome: string): string {
  return join(dshHome, 'assistant-delivery', 'state.sqlite')
}

export function automationsLedgerPath(dshHome: string): string {
  return join(dshHome, 'assistant-automations', 'state.sqlite')
}

export function listDeadLetters(dshHome: string): DeadLetterRow[] {
  const database = openStore(deliveryLedgerPath(dshHome))
  try {
    const inbox = database.prepare(
      "SELECT id, attempt_count, status, failure_code, updated_at FROM inbox_messages WHERE status = 'dead_letter' ORDER BY updated_at",
    ).all() as unknown as { id: string; attempt_count: number; status: string; failure_code: string | null; updated_at: number }[]
    const outbox = database.prepare(
      "SELECT id, attempt_count, status, failure_code, updated_at FROM outbox_messages WHERE status IN ('dead','unknown_after_send') ORDER BY updated_at",
    ).all() as unknown as { id: string; attempt_count: number; status: string; failure_code: string | null; updated_at: number }[]
    return [
      ...inbox.map((row) => ({ kind: 'inbox' as const, id: row.id, attemptCount: row.attempt_count,
        status: row.status, failureCode: row.failure_code, updatedAt: row.updated_at })),
      ...outbox.map((row) => ({ kind: 'outbox' as const, id: row.id, attemptCount: row.attempt_count,
        status: row.status, failureCode: row.failure_code, updatedAt: row.updated_at })),
    ]
  } finally { database.close() }
}

export interface DeadLetterResolution {
  readonly kind: 'inbox' | 'outbox'
  readonly id: string
  readonly attemptCount: number
  readonly resolution: 'cancel' | 'retry'
  readonly operatorId: string
  readonly replayed: boolean
  readonly status: string
}

export function resolveDeadLetter(input: {
  dshHome: string
  kind: 'inbox' | 'outbox'
  id: string
  expectedAttemptCount: number
  resolution: 'cancel' | 'retry'
  operatorId: string
}): DeadLetterResolution {
  if (input.kind !== 'inbox' && input.kind !== 'outbox') fail('invalid-input', 'kind must be inbox or outbox')
  if (input.resolution !== 'cancel' && input.resolution !== 'retry') fail('invalid-input', 'resolution must be cancel or retry')
  const id = requiredText(input.id, 'id')
  const attemptCount = requiredInteger(input.expectedAttemptCount, 'expectedAttemptCount')
  const operatorId = canonicalOperatorId(input.operatorId)
  const database = openStore(deliveryLedgerPath(input.dshHome))
  try {
    return transaction(database, () => {
      const table = input.kind === 'inbox' ? 'inbox_messages' : 'outbox_messages'
      const current = database.prepare(
        'SELECT status, attempt_count, failure_code FROM ' + table + ' WHERE id = ?',
      ).get(id) as { status: string; attempt_count: number; failure_code: string | null } | undefined
      if (current === undefined) fail('not-found', input.kind + ' ' + id + ' was not found')

      const receipt = database.prepare(
        'SELECT resolution, operator_id FROM dead_letter_resolutions WHERE kind = ? AND message_id = ? AND attempt_count = ?',
      ).get(input.kind, id, attemptCount) as { resolution: string; operator_id: string } | undefined
      if (receipt !== undefined) {
        if (receipt.resolution === input.resolution && receipt.operator_id === operatorId) {
          return { kind: input.kind, id, attemptCount, resolution: input.resolution,
            operatorId, replayed: true, status: current.status }
        }
        fail('conflict', 'this dead-letter attempt already settled with a different decision')
      }

      const actionable = input.kind === 'inbox'
        ? current.status === 'dead_letter'
        : current.status === 'dead' || current.status === 'unknown_after_send'
      if (!actionable) fail('conflict', input.kind + ' ' + id + ' is not an actionable dead letter (status ' + current.status + ')')
      if (current.attempt_count !== attemptCount) {
        fail('conflict', 'attempt count changed: stored ' + current.attempt_count + ', expected ' + attemptCount)
      }
      if (input.resolution === 'retry' && input.kind === 'outbox' && current.status === 'unknown_after_send') {
        fail('conflict', 'an unknown-after-send outbox row cannot be retried without duplicating a send')
      }

      const now = Date.now()
      database.prepare(
        'INSERT INTO dead_letter_resolutions (kind, message_id, attempt_count, receipt_version, resolution, original_status, original_failure_code, operator_id, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)',
      ).run(input.kind, id, attemptCount, input.resolution, current.status, current.failure_code ?? null, operatorId, now)

      let changed: { changes: number | bigint }
      if (input.kind === 'inbox') {
        changed = database.prepare(
          'UPDATE inbox_messages SET status = ?, failure_code = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ? AND status = ? AND attempt_count = ?',
        ).run(input.resolution === 'retry' ? 'queued' : 'dead_letter',
          input.resolution === 'retry' ? null : 'operator-cancelled', now, id, current.status, attemptCount)
      } else {
        const targetStatus = input.resolution === 'retry' ? 'pending' : current.status
        const targetFailure = input.resolution === 'retry'
          ? null
          : current.status === 'unknown_after_send' ? 'operator-cancelled-unknown' : 'operator-cancelled'
        changed = database.prepare(
          'UPDATE outbox_messages SET status = ?, failure_code = ?, next_attempt_at = NULL, claimed_by = NULL, fencing_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND status = ? AND attempt_count = ?',
        ).run(targetStatus, targetFailure, now, id, current.status, attemptCount)
      }
      if (changed.changes !== 1) fail('conflict', input.kind + ' ' + id + ' changed during the update')

      const after = database.prepare('SELECT status FROM ' + table + ' WHERE id = ?').get(id) as { status: string }
      return { kind: input.kind, id, attemptCount, resolution: input.resolution,
        operatorId, replayed: false, status: after.status }
    })
  } finally { database.close() }
}

export interface SystemAutomationRow {
  readonly automationId: string
  readonly systemOwner: string
  readonly definitionHash: string
  readonly status: string
  readonly version: number
  readonly circuitState: string | null
  readonly circuitFailureCode: string | null
}

export function listSystemAutomations(dshHome: string): SystemAutomationRow[] {
  const database = openStore(automationsLedgerPath(dshHome))
  try {
    return database.prepare(
      'SELECT d.id AS automationId, d.system_owner AS systemOwner, d.definition_hash AS definitionHash, d.status AS status, d.version AS version, c.state AS circuitState, c.failure_code AS circuitFailureCode FROM automation_definitions d LEFT JOIN automation_circuits c ON c.automation_id = d.id AND c.definition_hash = d.definition_hash WHERE d.system_owner IS NOT NULL ORDER BY d.status, d.id',
    ).all() as unknown as SystemAutomationRow[]
  } finally { database.close() }
}

export interface SystemAutomationPauseReceipt {
  readonly operationId: string
  readonly owner: string
  readonly automationId: string
  readonly definitionHash: string
  readonly expectedVersion: number
  readonly definitionVersion: number
  readonly automationStatus: 'paused'
  readonly replayed: boolean
}

export function pauseSystemAutomation(input: {
  dshHome: string
  owner: string
  automationId: string
  definitionHash: string
  expectedVersion: number
  operationId: string
}): SystemAutomationPauseReceipt {
  const owner = requiredText(input.owner, 'owner', 200)
  const automationId = requiredText(input.automationId, 'automationId')
  const operationId = requiredText(input.operationId, 'operationId')
  if (!/^[a-f0-9]{64}$/u.test(input.definitionHash)) fail('invalid-input', 'definitionHash must be 64 lowercase hex characters')
  const expectedVersion = requiredInteger(input.expectedVersion, 'expectedVersion', 1)

  const inputHash = hash({ lane: 'pause-system-owned-v1', owner, automationId,
    definitionHash: input.definitionHash, expectedVersion })

  const database = openStore(automationsLedgerPath(input.dshHome))
  try {
    return transaction(database, () => {
      const prior = database.prepare(
        'SELECT input_hash, result_json FROM automation_system_reconciles WHERE idempotency_key = ?',
      ).get(operationId) as { input_hash: string; result_json: string } | undefined
      if (prior !== undefined) {
        if (prior.input_hash !== inputHash) fail('conflict', 'this operation id already recorded a different pause')
        const stored = JSON.parse(prior.result_json) as Omit<SystemAutomationPauseReceipt, 'operationId' | 'replayed'>
        return { operationId, ...stored, replayed: true }
      }

      const current = database.prepare(
        'SELECT system_owner, definition_hash, status, version FROM automation_definitions WHERE id = ?',
      ).get(automationId) as { system_owner: string | null; definition_hash: string; status: string; version: number } | undefined
      if (current === undefined || current.system_owner !== owner || current.definition_hash !== input.definitionHash) {
        fail('not-found', 'exact system-owned automation definition was not found')
      }
      if (current.version !== expectedVersion) {
        fail('conflict', 'version changed: stored ' + current.version + ', expected ' + expectedVersion)
      }
      if (current.status !== 'active') fail('conflict', 'only an active automation can be paused (status ' + current.status + ')')

      const now = Date.now()
      const changed = database.prepare(
        "UPDATE automation_definitions SET status = 'paused', next_run_at = NULL, updated_at = ?, version = version + 1 WHERE id = ? AND system_owner = ? AND definition_hash = ? AND version = ? AND status = 'active'",
      ).run(now, automationId, owner, input.definitionHash, expectedVersion)
      if (changed.changes !== 1) fail('conflict', 'automation changed before the pause commit')

      const stored = { owner, automationId, definitionHash: input.definitionHash, expectedVersion,
        definitionVersion: expectedVersion + 1, automationStatus: 'paused' as const }
      database.prepare(
        'INSERT INTO automation_system_reconciles (idempotency_key, system_owner, automation_id, input_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(operationId, owner, automationId, inputHash, JSON.stringify(stored), now)
      return { operationId, ...stored, replayed: false }
    })
  } finally { database.close() }
}
