import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const automationSchemaVersion = 4

export class AutomationDatabaseError extends Error {
  constructor(readonly code: 'invalid-path' | 'schema-too-new', message: string) {
    super(message)
    this.name = 'AutomationDatabaseError'
  }
}

function migrate(database: DatabaseSync): void {
  let version = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (version > automationSchemaVersion) {
    throw new AutomationDatabaseError(
      'schema-too-new',
      `automation schema ${version} is newer than supported schema ${automationSchemaVersion}`,
    )
  }
  if (version === automationSchemaVersion) return
  if (version === 0) {
    database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE automation_definitions (
      id TEXT PRIMARY KEY,
      create_idempotency_key TEXT NOT NULL UNIQUE,
      system_owner TEXT,
      definition_hash TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'deleted')),
      next_run_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1)
    ) STRICT;
    CREATE INDEX automation_due ON automation_definitions(status, next_run_at, id);

    CREATE TABLE automation_changes (
      idempotency_key TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      expected_version INTEGER NOT NULL,
      input_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (automation_id) REFERENCES automation_definitions(id)
    ) STRICT;

    CREATE TABLE automation_occurrences (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('scheduled', 'manual', 'external')),
      trigger_key TEXT NOT NULL,
      scheduled_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'skipped', 'succeeded', 'failed', 'timed_out', 'cancelled', 'unknown')),
      reason TEXT,
      dry_run INTEGER NOT NULL CHECK (dry_run IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (automation_id, trigger_kind, trigger_key),
      FOREIGN KEY (automation_id) REFERENCES automation_definitions(id)
    ) STRICT;
    CREATE INDEX automation_occurrence_history ON automation_occurrences(automation_id, scheduled_at DESC, id DESC);

    CREATE TABLE automation_tasks (
      id TEXT PRIMARY KEY,
      occurrence_id TEXT NOT NULL UNIQUE,
      automation_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('scheduled', 'claimed', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled', 'lost', 'unknown')),
      cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
      claimed_by TEXT,
      fencing_token INTEGER,
      lease_until INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (occurrence_id) REFERENCES automation_occurrences(id),
      FOREIGN KEY (automation_id) REFERENCES automation_definitions(id)
    ) STRICT;
    CREATE INDEX automation_task_claim ON automation_tasks(status, created_at, id);

    CREATE TABLE automation_attempts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      owner_id TEXT NOT NULL,
      fencing_token INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('claimed', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled', 'lost', 'unknown')),
      session_id TEXT,
      failure_code TEXT,
      started_at INTEGER,
      finished_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (task_id, attempt_number),
      FOREIGN KEY (task_id) REFERENCES automation_tasks(id)
    ) STRICT;

    CREATE TABLE automation_runs (
      id TEXT PRIMARY KEY,
      occurrence_id TEXT NOT NULL UNIQUE,
      automation_id TEXT NOT NULL,
      task_id TEXT NOT NULL UNIQUE,
      attempt_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'timed_out', 'cancelled', 'unknown')),
      session_id TEXT,
      artifact_ref TEXT,
      output_preview TEXT NOT NULL,
      usage_json TEXT NOT NULL,
      delivery_status TEXT,
      delivery_ref TEXT,
      evidence_status TEXT NOT NULL CHECK (evidence_status IN ('pending', 'recorded', 'suppressed')),
      evidence_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (
        (evidence_status IN ('pending', 'recorded') AND evidence_json IS NOT NULL)
        OR (evidence_status = 'suppressed' AND evidence_json IS NULL)
      ),
      FOREIGN KEY (occurrence_id) REFERENCES automation_occurrences(id),
      FOREIGN KEY (automation_id) REFERENCES automation_definitions(id),
      FOREIGN KEY (task_id) REFERENCES automation_tasks(id),
      FOREIGN KEY (attempt_id) REFERENCES automation_attempts(id)
    ) STRICT;

    CREATE TABLE duty_lease (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      owner_id TEXT NOT NULL,
      fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
      lease_until INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE automation_proposals (
      id TEXT PRIMARY KEY,
      policy_proposal_id TEXT UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      requester TEXT NOT NULL,
      principal TEXT NOT NULL,
      dispatch_json TEXT CHECK (dispatch_json IS NULL OR json_valid(dispatch_json)),
      change_hash TEXT NOT NULL,
      change_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'conflicted')),
      expires_at INTEGER NOT NULL,
      ttl_ms INTEGER NOT NULL CHECK (ttl_ms > 0),
      result_automation_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    ) STRICT;

    CREATE TABLE automation_system_reconciles (
      idempotency_key TEXT PRIMARY KEY,
      system_owner TEXT NOT NULL,
      automation_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (automation_id) REFERENCES automation_definitions(id)
    ) STRICT;

    PRAGMA user_version = 4;
    COMMIT;
    `)
    return
  }
  if (version === 1) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE automation_definitions ADD COLUMN system_owner TEXT;
      CREATE TABLE automation_system_reconciles (
        idempotency_key TEXT PRIMARY KEY,
        system_owner TEXT NOT NULL,
        automation_id TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (automation_id) REFERENCES automation_definitions(id)
      ) STRICT;
      PRAGMA user_version = 2;
      COMMIT;
    `)
    version = 2
  }
  if (version === 2) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE automation_runs ADD COLUMN evidence_status TEXT NOT NULL DEFAULT 'suppressed'
        CHECK (evidence_status IN ('pending', 'recorded', 'suppressed'));
      ALTER TABLE automation_runs ADD COLUMN evidence_json TEXT;
      WITH evidence_eligible(id) AS (
        SELECT run.id
        FROM automation_runs AS run
        JOIN automation_definitions AS definition ON definition.id = run.automation_id
        WHERE run.status IN ('succeeded', 'failed', 'timed_out')
          AND json_valid(definition.definition_json)
          AND json_type(definition.definition_json, '$.name') = 'text'
          AND length(CAST(json_extract(definition.definition_json, '$.name') AS BLOB)) BETWEEN 1 AND 500
          AND json_type(definition.definition_json, '$.workspace') = 'text'
          AND length(CAST(json_extract(definition.definition_json, '$.workspace') AS BLOB)) BETWEEN 1 AND 4096
          AND json_type(definition.definition_json, '$.agentPreset') = 'text'
          AND length(CAST(json_extract(definition.definition_json, '$.agentPreset') AS BLOB)) BETWEEN 1 AND 200
      )
      UPDATE automation_runs AS run
      SET evidence_status = CASE
            WHEN run.id IN (SELECT id FROM evidence_eligible) THEN 'pending'
            ELSE 'suppressed'
          END,
          evidence_json = CASE
            WHEN run.id IN (SELECT id FROM evidence_eligible) THEN (
              SELECT json_object(
                'situation', 'automation:' || run.automation_id,
                'outcome', CASE WHEN run.status = 'succeeded' THEN 'succeeded' ELSE 'failed' END,
                'detail', 'automation "' || json_extract(definition_json, '$.name') || '": run ' || run.status,
                'idempotencyKey', 'automation-run:' || run.id,
                'occurredAt', run.created_at,
                'workspace', json_extract(definition_json, '$.workspace'),
                'agentPreset', json_extract(definition_json, '$.agentPreset'),
                'automationId', run.automation_id,
                'runId', run.id
              )
              FROM automation_definitions
              WHERE id = run.automation_id
            )
            ELSE NULL
          END;
      PRAGMA user_version = 3;
      COMMIT;
    `)
    version = 3
  }
  if (version === 3) {
    const proposalsTable = database.prepare(`
      SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'automation_proposals'
    `).get() as { present: number } | undefined
    if (proposalsTable === undefined) {
      // Some narrow rc.8 test/repair databases contain only the execution tables.
      // They cannot host proposals, but may still be opened read-only by AutomationStore.
      database.exec('PRAGMA user_version = 4')
    } else {
      database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE automation_proposals ADD COLUMN dispatch_json TEXT
          CHECK (dispatch_json IS NULL OR json_valid(dispatch_json));
        ALTER TABLE automation_proposals ADD COLUMN ttl_ms INTEGER;
        UPDATE automation_proposals
        SET ttl_ms = expires_at - created_at
        WHERE ttl_ms IS NULL AND expires_at > created_at;
        PRAGMA user_version = 4;
        COMMIT;
      `)
    }
  }
}

export function openAutomationDatabase(path: string): DatabaseSync {
  if (path !== ':memory:' && !isAbsolute(path)) {
    throw new AutomationDatabaseError('invalid-path', 'automation database path must be absolute')
  }
  if (path !== ':memory:') {
    const directory = dirname(path)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
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
