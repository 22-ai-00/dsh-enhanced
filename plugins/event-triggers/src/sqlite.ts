import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export class EventTriggerDatabaseError extends Error {
  constructor(readonly code: 'invalid-path' | 'invalid-schema' | 'schema-too-new', message: string) {
    super(message)
    this.name = 'EventTriggerDatabaseError'
  }
}

function assertColumns(database: DatabaseSync, table: string, expected: readonly string[]): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (columns.length !== expected.length || columns.some((column, index) => column.name !== expected[index])) {
    throw new EventTriggerDatabaseError('invalid-schema', `event trigger ${table} schema is invalid`)
  }
}

function assertSchema(database: DatabaseSync): void {
  assertColumns(database, 'trigger_state', [
    'trigger_id', 'first_observed_at', 'last_observed_at', 'last_fingerprint', 'last_truthy', 'edge_revision',
    'pending_fingerprint', 'pending_since', 'pending_revision', 'last_fire_at', 'fire_count',
  ])
  assertColumns(database, 'event_outbox', [
    'id', 'sequence', 'trigger_id', 'event_id', 'occurred_at', 'status', 'attempts', 'delivered_at', 'created_at',
    'next_attempt_at', 'last_attempt_at', 'last_error', 'envelope_canonical', 'envelope_digest',
  ])
  assertColumns(database, 'trigger_health', [
    'trigger_id', 'consecutive_failures', 'last_error', 'last_failed_at', 'last_success_at',
  ])
  assertColumns(database, 'event_sequence', ['sequence'])
  const sequenceSql = database.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'event_sequence'`)
    .get() as { sql: string } | undefined
  const outboxSql = database.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'event_outbox'`)
    .get() as { sql: string } | undefined
  const sourceIndex = database.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = 'event_outbox_source'`)
    .get() as { present: number } | undefined
  if (sequenceSql === undefined || outboxSql === undefined || sourceIndex === undefined
    || !/AUTOINCREMENT/u.test(sequenceSql.sql) || !/STRICT/u.test(outboxSql.sql)
    || !/sequence\s+INTEGER\s+NOT\s+NULL\s+UNIQUE\s+CHECK\s*\(sequence\s*>\s*0\)/iu.test(outboxSql.sql)) {
    throw new EventTriggerDatabaseError('invalid-schema', 'event trigger source sequence schema is invalid')
  }
}

function migrate(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    const version = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version > 4) throw new EventTriggerDatabaseError('schema-too-new', `event trigger schema ${version} is too new`)
    if (version === 4) { assertSchema(database); database.exec('COMMIT'); return }
    if (version === 0) database.exec(`
      CREATE TABLE trigger_state (
      trigger_id TEXT PRIMARY KEY,
      first_observed_at INTEGER NOT NULL,
      last_observed_at INTEGER NOT NULL,
      last_fingerprint TEXT NOT NULL,
      last_truthy INTEGER NOT NULL CHECK (last_truthy IN (0, 1)),
      edge_revision INTEGER NOT NULL DEFAULT 0,
      pending_fingerprint TEXT,
      pending_since INTEGER,
      pending_revision INTEGER,
      last_fire_at INTEGER,
      fire_count INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE event_outbox (
      id TEXT PRIMARY KEY,
      trigger_id TEXT NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      occurred_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'quarantined')),
      attempts INTEGER NOT NULL DEFAULT 0,
      delivered_at INTEGER,
      created_at INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      last_attempt_at INTEGER,
      last_error TEXT,
      envelope_canonical TEXT,
      envelope_digest TEXT,
      CHECK ((envelope_canonical IS NULL AND envelope_digest IS NULL)
        OR (envelope_canonical IS NOT NULL AND envelope_digest IS NOT NULL))
      ) STRICT;
      CREATE TABLE trigger_health (
        trigger_id TEXT PRIMARY KEY,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_failed_at INTEGER,
        last_success_at INTEGER
      ) STRICT;
      CREATE INDEX event_outbox_pending ON event_outbox(status, next_attempt_at, created_at, id);
    `)
    if (version === 1) database.exec(`
      DROP INDEX event_outbox_pending;
      ALTER TABLE event_outbox RENAME TO event_outbox_v1;
      CREATE TABLE event_outbox (
        id TEXT PRIMARY KEY,
        trigger_id TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        occurred_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'quarantined')),
        attempts INTEGER NOT NULL DEFAULT 0,
        delivered_at INTEGER,
        created_at INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL,
        last_attempt_at INTEGER,
        last_error TEXT
      ) STRICT;
      INSERT INTO event_outbox(
        id, trigger_id, event_id, occurred_at, status, attempts, delivered_at, created_at,
        next_attempt_at, last_attempt_at, last_error
      ) SELECT id, trigger_id, event_id, occurred_at, status, attempts, delivered_at, created_at,
        created_at, CASE WHEN attempts > 0 THEN created_at ELSE NULL END, NULL
      FROM event_outbox_v1;
      DROP TABLE event_outbox_v1;
      CREATE TABLE trigger_health (
        trigger_id TEXT PRIMARY KEY,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_failed_at INTEGER,
        last_success_at INTEGER
      ) STRICT;
      CREATE INDEX event_outbox_pending ON event_outbox(status, next_attempt_at, created_at, id);
    `)
    if (version === 1 || version === 2) database.exec(`
      ALTER TABLE event_outbox ADD COLUMN envelope_canonical TEXT;
      ALTER TABLE event_outbox ADD COLUMN envelope_digest TEXT;
    `)
    if (version <= 3) database.exec(`
      DROP INDEX IF EXISTS event_outbox_pending;
      ALTER TABLE event_outbox RENAME TO event_outbox_v3;
      CREATE TABLE event_outbox (
        id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL UNIQUE CHECK (sequence > 0),
        trigger_id TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        occurred_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'quarantined')),
        attempts INTEGER NOT NULL DEFAULT 0,
        delivered_at INTEGER,
        created_at INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL,
        last_attempt_at INTEGER,
        last_error TEXT,
        envelope_canonical TEXT,
        envelope_digest TEXT,
        CHECK ((envelope_canonical IS NULL AND envelope_digest IS NULL)
          OR (envelope_canonical IS NOT NULL AND envelope_digest IS NOT NULL))
      ) STRICT;
      CREATE TABLE event_sequence (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT
      ) STRICT;
      INSERT INTO event_sequence(sequence)
      SELECT sequence FROM (
        SELECT ROW_NUMBER() OVER (ORDER BY created_at, id) AS sequence FROM event_outbox_v3
      );
      INSERT INTO event_outbox(
        id, sequence, trigger_id, event_id, occurred_at, status, attempts, delivered_at, created_at,
        next_attempt_at, last_attempt_at, last_error, envelope_canonical, envelope_digest
      ) SELECT
        id, ROW_NUMBER() OVER (ORDER BY created_at, id), trigger_id, event_id, occurred_at, status, attempts,
        delivered_at, created_at, next_attempt_at, last_attempt_at, last_error, envelope_canonical, envelope_digest
      FROM event_outbox_v3;
      DROP TABLE event_outbox_v3;
      CREATE INDEX event_outbox_pending ON event_outbox(status, next_attempt_at, created_at, id);
      CREATE INDEX event_outbox_source ON event_outbox(trigger_id, sequence);
    `)
    database.exec('PRAGMA user_version = 4')
    assertSchema(database)
    database.exec('COMMIT')
  } catch (error) {
    try { database.exec('ROLLBACK') } catch {}
    throw error
  }
}

export function openEventTriggerDatabase(path: string): DatabaseSync {
  if (path !== ':memory:' && !isAbsolute(path)) {
    throw new EventTriggerDatabaseError('invalid-path', 'event trigger database path must be absolute')
  }
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    chmodSync(dirname(path), 0o700)
  }
  const database = new DatabaseSync(path)
  try {
    database.exec('PRAGMA foreign_keys = ON')
    database.exec('PRAGMA busy_timeout = 5000')
    database.exec('PRAGMA synchronous = FULL')
    migrate(database)
    if (path !== ':memory:') {
      database.exec('PRAGMA journal_mode = WAL')
      chmodSync(path, 0o600)
    }
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
