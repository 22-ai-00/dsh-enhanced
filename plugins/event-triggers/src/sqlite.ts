import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export class EventTriggerDatabaseError extends Error {
  constructor(readonly code: 'invalid-path' | 'schema-too-new', message: string) {
    super(message)
    this.name = 'EventTriggerDatabaseError'
  }
}

function migrate(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    const version = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version > 2) throw new EventTriggerDatabaseError('schema-too-new', `event trigger schema ${version} is too new`)
    if (version === 2) { database.exec('COMMIT'); return }
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
      last_error TEXT
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
    database.exec('PRAGMA user_version = 2')
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
