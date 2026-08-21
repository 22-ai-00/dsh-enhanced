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
  const version = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (version > 1) throw new EventTriggerDatabaseError('schema-too-new', `event trigger schema ${version} is too new`)
  if (version === 1) return
  database.exec(`
    BEGIN IMMEDIATE;
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
      status TEXT NOT NULL CHECK (status IN ('pending', 'delivered')),
      attempts INTEGER NOT NULL DEFAULT 0,
      delivered_at INTEGER,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX event_outbox_pending ON event_outbox(status, created_at, id);
    PRAGMA user_version = 1;
    COMMIT;
  `)
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
