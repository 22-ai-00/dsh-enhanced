import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const policySchemaVersion = 5

export const legacyApprovalIntentHash = 'legacy-v4-unbound'

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
  const sampled = database.prepare('PRAGMA user_version').get() as { user_version: number }
  if (sampled.user_version > policySchemaVersion) {
    throw new PolicyDatabaseError(
      'schema-too-new',
      `policy database schema ${sampled.user_version} is newer than supported schema ${policySchemaVersion}`,
    )
  }
  if (sampled.user_version === policySchemaVersion) return

  let transactionOpen = false
  try {
    database.exec('BEGIN IMMEDIATE')
    transactionOpen = true
    // Every migration decision is based on the version observed after the write
    // lock. Concurrent openers may have completed several steps while we waited.
    const locked = database.prepare('PRAGMA user_version').get() as { user_version: number }
    if (locked.user_version > policySchemaVersion) {
      throw new PolicyDatabaseError(
        'schema-too-new',
        `policy database schema ${locked.user_version} is newer than supported schema ${policySchemaVersion}`,
      )
    }
    let version = locked.user_version

    if (version === 0) {
      database.exec(`
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
          diff_text TEXT,
          summary TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          decided_at INTEGER,
          decided_by TEXT,
          decision_reason TEXT,
          version INTEGER NOT NULL DEFAULT 1
        ) STRICT;

        CREATE TABLE approval_dispatches (
          proposal_id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL,
          binding_id TEXT NOT NULL,
          workspace TEXT NOT NULL,
          principal TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending', 'enqueued')),
          payload_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          enqueued_at INTEGER,
          version INTEGER NOT NULL DEFAULT 1,
          proposal_version INTEGER NOT NULL,
          FOREIGN KEY (proposal_id) REFERENCES approval_proposals(id) ON DELETE CASCADE
        ) STRICT;

        CREATE INDEX approval_dispatches_pending_idx
          ON approval_dispatches(state, created_at, proposal_id);

        CREATE TABLE approval_idempotency_tombstones (
          idempotency_key TEXT PRIMARY KEY,
          not_after INTEGER NOT NULL,
          abandoned_at INTEGER NOT NULL,
          intent_hash TEXT NOT NULL CHECK (
            length(intent_hash) = 64 AND intent_hash NOT GLOB '*[^0-9a-f]*'
          )
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

        INSERT INTO schema_meta(key, value) VALUES ('schema-version', '5');
      `)
      version = 5
    }

    if (version === 1) {
      database.exec(`
        ALTER TABLE approval_proposals ADD COLUMN diff_text TEXT;
        CREATE TABLE approval_dispatches (
          proposal_id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL,
          binding_id TEXT NOT NULL,
          workspace TEXT NOT NULL,
          principal TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending', 'enqueued')),
          payload_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          enqueued_at INTEGER,
          version INTEGER NOT NULL DEFAULT 1,
          proposal_version INTEGER NOT NULL,
          FOREIGN KEY (proposal_id) REFERENCES approval_proposals(id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX approval_dispatches_pending_idx
          ON approval_dispatches(state, created_at, proposal_id);
      `)
      version = 3
    }

    if (version === 2) {
      database.exec(`
        ALTER TABLE approval_dispatches
          ADD COLUMN proposal_version INTEGER NOT NULL DEFAULT 1;
        UPDATE approval_proposals
        SET diff_text = NULL
        WHERE status <> 'pending'
           OR NOT EXISTS (
             SELECT 1 FROM approval_dispatches
             WHERE approval_dispatches.proposal_id = approval_proposals.id
               AND approval_dispatches.state = 'pending'
           );
      `)
      version = 3
    }

    if (version === 3) {
      database.exec(`
        CREATE TABLE approval_idempotency_tombstones (
          idempotency_key TEXT PRIMARY KEY,
          not_after INTEGER NOT NULL,
          abandoned_at INTEGER NOT NULL
        ) STRICT;
      `)
      version = 4
    }

    if (version === 4) {
      // Rebuild instead of ADD COLUMN ... DEFAULT so future inserts cannot
      // accidentally create an unverifiable legacy sentinel.
      database.exec(`
        ALTER TABLE approval_idempotency_tombstones
          RENAME TO approval_idempotency_tombstones_v4;
        CREATE TABLE approval_idempotency_tombstones (
          idempotency_key TEXT PRIMARY KEY,
          not_after INTEGER NOT NULL,
          abandoned_at INTEGER NOT NULL,
          intent_hash TEXT NOT NULL CHECK (
            intent_hash = '${legacyApprovalIntentHash}'
            OR (length(intent_hash) = 64 AND intent_hash NOT GLOB '*[^0-9a-f]*')
          )
        ) STRICT;
        INSERT INTO approval_idempotency_tombstones(
          idempotency_key, not_after, abandoned_at, intent_hash
        )
        SELECT idempotency_key, not_after, abandoned_at, '${legacyApprovalIntentHash}'
        FROM approval_idempotency_tombstones_v4;
        DROP TABLE approval_idempotency_tombstones_v4;
      `)
      version = 5
    }

    if (version !== policySchemaVersion) {
      throw new Error(`unsupported policy database schema ${version}`)
    }
    database.prepare(`UPDATE schema_meta SET value = ? WHERE key = 'schema-version'`)
      .run(String(policySchemaVersion))
    database.exec(`PRAGMA user_version = ${policySchemaVersion}; COMMIT`)
    transactionOpen = false
  } catch (error) {
    if (transactionOpen) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // SQLite may already have rolled back a failed schema transaction.
      }
    }
    throw error
  }
}

const walRetryWait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))

function enableWal(database: DatabaseSync): void {
  const deadline = Date.now() + 5_000
  while (true) {
    try {
      const row = database.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode: string }
      if (row.journal_mode.toLowerCase() !== 'wal') {
        throw new Error(`policy database refused WAL mode: ${row.journal_mode}`)
      }
      return
    } catch (error) {
      const retryable = error instanceof Error && /database is (?:busy|locked)/i.test(error.message)
      if (!retryable || Date.now() >= deadline) throw error
      Atomics.wait(walRetryWait, 0, 0, 10)
    }
  }
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
    migrate(database)
    if (path !== ':memory:') enableWal(database)
    if (path !== ':memory:') chmodSync(path, 0o600)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
