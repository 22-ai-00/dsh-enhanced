import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  MaintenanceError,
  listDeadLetters,
  listSystemAutomations,
  pauseSystemAutomation,
  resolveDeadLetter,
} from '../src/maintenance.ts'

const DELIVERY_SCHEMA = `
  CREATE TABLE inbox_messages (
    id TEXT PRIMARY KEY, channel TEXT, account TEXT, event_id TEXT, envelope_hash TEXT,
    envelope_json TEXT, status TEXT, binding_id TEXT, attempt_count INTEGER,
    next_attempt_at INTEGER, claimed_by TEXT, fencing_token TEXT, lease_until INTEGER,
    failure_code TEXT, received_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE outbox_messages (
    id TEXT PRIMARY KEY, idempotency_key TEXT, binding_id TEXT, intent_hash TEXT,
    intent_json TEXT, channel TEXT, account TEXT, lane_hash TEXT, status TEXT,
    provider_message_id TEXT, attempt_count INTEGER, next_attempt_at INTEGER,
    claimed_by TEXT, fencing_token TEXT, lease_until INTEGER, failure_code TEXT,
    created_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE dead_letter_resolutions (
    kind TEXT NOT NULL, message_id TEXT NOT NULL, attempt_count INTEGER NOT NULL,
    receipt_version INTEGER NOT NULL, resolution TEXT NOT NULL, original_status TEXT NOT NULL,
    original_failure_code TEXT, operator_id TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (kind, message_id, attempt_count)
  );
  CREATE TRIGGER dead_letter_inbox_resolution_fence
  BEFORE UPDATE ON inbox_messages
  WHEN OLD.status = 'dead_letter' AND NEW.attempt_count = OLD.attempt_count AND (
    NEW.status = 'queued' OR (NEW.status = 'dead_letter' AND NEW.failure_code = 'operator-cancelled')
  ) AND NOT EXISTS (
    SELECT 1 FROM dead_letter_resolutions
    WHERE kind = 'inbox' AND message_id = OLD.id AND attempt_count = OLD.attempt_count
  )
  BEGIN SELECT RAISE(ABORT, 'dead-letter inbox update requires an operator receipt'); END;
`

const AUTOMATIONS_SCHEMA = `
  CREATE TABLE automation_definitions (
    id TEXT PRIMARY KEY, create_idempotency_key TEXT, system_owner TEXT,
    definition_hash TEXT, definition_json TEXT, status TEXT, next_run_at INTEGER,
    created_at INTEGER, updated_at INTEGER, version INTEGER
  );
  CREATE TABLE automation_circuits (
    automation_id TEXT, definition_hash TEXT, state TEXT, failure_class TEXT,
    failure_phase TEXT, failure_code TEXT, opened_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE automation_system_reconciles (
    idempotency_key TEXT PRIMARY KEY, system_owner TEXT, automation_id TEXT,
    input_hash TEXT, result_json TEXT, created_at INTEGER
  );
`

describe('dsh-rsi maintenance', () => {
  let root: string
  let dshHome: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rsi-cli-maintenance-'))
    dshHome = join(root, '.dsh')
    await mkdir(join(dshHome, 'assistant-delivery'), { recursive: true })
    await mkdir(join(dshHome, 'assistant-automations'), { recursive: true })
    const delivery = new DatabaseSync(join(dshHome, 'assistant-delivery', 'state.sqlite'))
    delivery.exec(DELIVERY_SCHEMA)
    delivery.prepare(
      "INSERT INTO inbox_messages (id, status, attempt_count, failure_code, updated_at) VALUES ('inbox-1', 'dead_letter', 2, 'unauthorized-principal', 100)",
    ).run()
    delivery.prepare(
      "INSERT INTO inbox_messages (id, status, attempt_count, failure_code, updated_at) VALUES ('inbox-live', 'processed', 1, NULL, 100)",
    ).run()
    delivery.close()
    const automations = new DatabaseSync(join(dshHome, 'assistant-automations', 'state.sqlite'))
    automations.exec(AUTOMATIONS_SCHEMA)
    automations.prepare(
      "INSERT INTO automation_definitions (id, system_owner, definition_hash, status, next_run_at, created_at, updated_at, version) VALUES ('auto-1', 'assistant-automations', ?, 'active', 500, 1, 1, 3)",
    ).run('a'.repeat(64))
    automations.prepare(
      "INSERT INTO automation_circuits (automation_id, definition_hash, state, failure_code) VALUES ('auto-1', ?, 'open', 'host-recovery-resume-not-authorized')",
    ).run('a'.repeat(64))
    automations.close()
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  test('lists only actionable dead letters', () => {
    const rows = listDeadLetters(dshHome)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'inbox', id: 'inbox-1', attemptCount: 2, status: 'dead_letter' })
  })

  test('cancel persists a receipt and leaves the row terminal', () => {
    const receipt = resolveDeadLetter({
      dshHome, kind: 'inbox', id: 'inbox-1', expectedAttemptCount: 2,
      resolution: 'cancel', operatorId: 'operator-a',
    })
    expect(receipt).toMatchObject({ replayed: false, status: 'dead_letter' })
    const database = new DatabaseSync(join(dshHome, 'assistant-delivery', 'state.sqlite'), { readOnly: true })
    const receiptRow = database.prepare(
      "SELECT resolution, operator_id FROM dead_letter_resolutions WHERE kind = 'inbox' AND message_id = 'inbox-1' AND attempt_count = 2",
    ).get() as { resolution: string; operator_id: string }
    expect(receiptRow).toEqual({ resolution: 'cancel', operator_id: 'operator-a' })
    const row = database.prepare("SELECT status, failure_code FROM inbox_messages WHERE id = 'inbox-1'").get() as { status: string; failure_code: string }
    expect(row).toEqual({ status: 'dead_letter', failure_code: 'operator-cancelled' })
    database.close()
  })

  test('retry re-queues the row', () => {
    resolveDeadLetter({ dshHome, kind: 'inbox', id: 'inbox-1', expectedAttemptCount: 2,
      resolution: 'retry', operatorId: 'operator-a' })
    const database = new DatabaseSync(join(dshHome, 'assistant-delivery', 'state.sqlite'), { readOnly: true })
    const row = database.prepare("SELECT status, failure_code FROM inbox_messages WHERE id = 'inbox-1'").get() as { status: string; failure_code: string | null }
    expect(row).toEqual({ status: 'queued', failure_code: null })
    database.close()
  })

  test('replays the same decision and conflicts on a different one', () => {
    const first = resolveDeadLetter({ dshHome, kind: 'inbox', id: 'inbox-1', expectedAttemptCount: 2,
      resolution: 'cancel', operatorId: 'operator-a' })
    expect(first.replayed).toBe(false)
    const replay = resolveDeadLetter({ dshHome, kind: 'inbox', id: 'inbox-1', expectedAttemptCount: 2,
      resolution: 'cancel', operatorId: 'operator-a' })
    expect(replay.replayed).toBe(true)
    expect(() => resolveDeadLetter({ dshHome, kind: 'inbox', id: 'inbox-1', expectedAttemptCount: 2,
      resolution: 'retry', operatorId: 'operator-a' })).toThrow(MaintenanceError)
    expect(() => resolveDeadLetter({ dshHome, kind: 'inbox', id: 'inbox-1', expectedAttemptCount: 2,
      resolution: 'cancel', operatorId: 'operator-b' })).toThrow(MaintenanceError)
  })

  test('rejects a stale attempt count and a non-dead row', () => {
    expect(() => resolveDeadLetter({ dshHome, kind: 'inbox', id: 'inbox-1', expectedAttemptCount: 1,
      resolution: 'cancel', operatorId: 'operator-a' })).toThrow(/attempt count changed/u)
    expect(() => resolveDeadLetter({ dshHome, kind: 'inbox', id: 'inbox-live', expectedAttemptCount: 1,
      resolution: 'cancel', operatorId: 'operator-a' })).toThrow(/not an actionable dead letter/u)
  })

  test('rejects an invalid operator identity', () => {
    expect(() => resolveDeadLetter({ dshHome, kind: 'inbox', id: 'inbox-1', expectedAttemptCount: 2,
      resolution: 'cancel', operatorId: 'bad\u0001id' })).toThrow(/operator id is invalid/u)
    expect(() => resolveDeadLetter({ dshHome, kind: 'inbox', id: 'inbox-1', expectedAttemptCount: 2,
      resolution: 'cancel', operatorId: '   ' })).toThrow(/operator id is invalid/u)
  })

  test('lists system automations with their circuit state', () => {
    const rows = listSystemAutomations(dshHome)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      automationId: 'auto-1', status: 'active', version: 3,
      circuitState: 'open', circuitFailureCode: 'host-recovery-resume-not-authorized',
    })
  })

  test('pauses a system automation and replays the same operation id', () => {
    const receipt = pauseSystemAutomation({ dshHome, owner: 'assistant-automations', automationId: 'auto-1',
      definitionHash: 'a'.repeat(64), expectedVersion: 3, operationId: 'op-1' })
    expect(receipt).toMatchObject({ automationStatus: 'paused', definitionVersion: 4, replayed: false })
    const replay = pauseSystemAutomation({ dshHome, owner: 'assistant-automations', automationId: 'auto-1',
      definitionHash: 'a'.repeat(64), expectedVersion: 3, operationId: 'op-1' })
    expect(replay.replayed).toBe(true)
    const database = new DatabaseSync(join(dshHome, 'assistant-automations', 'state.sqlite'), { readOnly: true })
    const row = database.prepare("SELECT status, version, next_run_at FROM automation_definitions WHERE id = 'auto-1'").get() as { status: string; version: number; next_run_at: number | null }
    expect(row).toEqual({ status: 'paused', version: 4, next_run_at: null })
    database.close()
  })

  test('rejects a wrong hash, wrong version or reused operation id', () => {
    expect(() => pauseSystemAutomation({ dshHome, owner: 'assistant-automations', automationId: 'auto-1',
      definitionHash: 'b'.repeat(64), expectedVersion: 3, operationId: 'op-x' })).toThrow(/was not found/u)
    expect(() => pauseSystemAutomation({ dshHome, owner: 'assistant-automations', automationId: 'auto-1',
      definitionHash: 'a'.repeat(64), expectedVersion: 2, operationId: 'op-x' })).toThrow(/version changed/u)
    pauseSystemAutomation({ dshHome, owner: 'assistant-automations', automationId: 'auto-1',
      definitionHash: 'a'.repeat(64), expectedVersion: 3, operationId: 'op-1' })
    expect(() => pauseSystemAutomation({ dshHome, owner: 'assistant-automations', automationId: 'auto-1',
      definitionHash: 'a'.repeat(64), expectedVersion: 4, operationId: 'op-1' })).toThrow(/different pause/u)
  })

  test('rejects pausing an already paused automation', () => {
    pauseSystemAutomation({ dshHome, owner: 'assistant-automations', automationId: 'auto-1',
      definitionHash: 'a'.repeat(64), expectedVersion: 3, operationId: 'op-1' })
    expect(() => pauseSystemAutomation({ dshHome, owner: 'assistant-automations', automationId: 'auto-1',
      definitionHash: 'a'.repeat(64), expectedVersion: 4, operationId: 'op-2' })).toThrow(/only an active automation/u)
  })
})
