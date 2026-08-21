import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const policySchemaVersion = 1

export class PolicyDatabaseError extends Error {
  constructor(
    readonly code: 'invalid-path' | 'schema-too-new',
    message: string,
  ) {
    super(message)
    this.name = 'PolicyDatabaseError'
  }
}

function migrate(database: DatabaseSync): void {
  const current = database.prepare('PRAGMA user_version').get() as { user_version: number }
  if (current.user_version > policySchemaVersion) {
    throw new PolicyDatabaseError(
      'schema-too-new',
      `policy database schema ${current.user_version} is newer than supported schema ${policySchemaVersion}`,
    )
  }
  if (current.user_version === policySchemaVersion) return

  database.exec(`
    BEGIN IMMEDIATE;

    CREATE TABLE schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE budget_periods (
      scope TEXT NOT NULL,
      metric TEXT NOT NULL,
      period_start INTEGER NOT NULL,
      period_ms INTEGER NOT NULL,
      limit_amount REAL NOT NULL CHECK (limit_amount > 0),
      reserved_amount REAL NOT NULL DEFAULT 0 CHECK (reserved_amount >= 0),
      spent_amount REAL NOT NULL DEFAULT 0 CHECK (spent_amount >= 0),
      version INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (scope, metric, period_start, period_ms)
    ) STRICT;

    CREATE TABLE budget_reservations (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL,
      metric TEXT NOT NULL,
      period_start INTEGER NOT NULL,
      period_ms INTEGER NOT NULL,
      amount REAL NOT NULL CHECK (amount > 0),
      actual_amount REAL,
      status TEXT NOT NULL CHECK (status IN ('reserved', 'finalized', 'released')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (scope, metric, period_start, period_ms)
        REFERENCES budget_periods(scope, metric, period_start, period_ms)
    ) STRICT;

    CREATE TABLE emergency_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      reason TEXT NOT NULL,
      actor TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE approval_proposals (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      requester TEXT NOT NULL,
      principal TEXT NOT NULL,
      action TEXT NOT NULL,
      resource_kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      diff_hash TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      decided_at INTEGER,
      decided_by TEXT,
      decision_reason TEXT,
      version INTEGER NOT NULL DEFAULT 1
    ) STRICT;

    CREATE TABLE audit_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      occurred_at INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      resource_kind TEXT NOT NULL,
      resource_hash TEXT NOT NULL,
      outcome TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      details_json TEXT NOT NULL
    ) STRICT;

    INSERT INTO schema_meta(key, value) VALUES ('schema-version', '1');
    PRAGMA user_version = 1;
    COMMIT;
  `)
}

export function openPolicyDatabase(path: string): DatabaseSync {
  if (path !== ':memory:' && !isAbsolute(path)) {
    throw new PolicyDatabaseError('invalid-path', 'policy database path must be absolute')
  }

  if (path !== ':memory:') {
    const parent = dirname(path)
    mkdirSync(parent, { recursive: true, mode: 0o700 })
  }

  const database = new DatabaseSync(path)
  try {
    database.exec('PRAGMA foreign_keys = ON')
    database.exec('PRAGMA busy_timeout = 5000')
    database.exec('PRAGMA synchronous = FULL')
    if (path !== ':memory:') database.exec('PRAGMA journal_mode = WAL')
    migrate(database)
    if (path !== ':memory:') chmodSync(path, 0o600)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
