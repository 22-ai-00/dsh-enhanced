import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const evaluationSchemaVersion = 7

export type EvaluationDatabaseErrorCode = 'invalid-path' | 'unsafe-file' | 'schema-too-new'

export class EvaluationDatabaseError extends Error {
  constructor(readonly code: EvaluationDatabaseErrorCode, message: string) {
    super(message)
    this.name = 'EvaluationDatabaseError'
  }
}

function assertSafeFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new EvaluationDatabaseError('unsafe-file', 'evaluation database must be one regular, unlinked file')
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new EvaluationDatabaseError('unsafe-file', 'evaluation database permissions must not allow group or other access')
  }
  const uid = process.getuid?.()
  if (uid !== undefined && stat.uid !== uid) {
    throw new EvaluationDatabaseError('unsafe-file', 'evaluation database must be owned by the current OS user')
  }
}

function preparePrivateFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (!existsSync(path)) {
    const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600)
    closeSync(descriptor)
  }
  assertSafeFile(path)
}

function schemaVersion(database: DatabaseSync): number {
  return (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

const selfAssessmentSchema = `
  CREATE TABLE evaluation_self_assessments (
    id TEXT PRIMARY KEY,
    outcome_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    payload_hash TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    objective_status TEXT NOT NULL
      CHECK (objective_status IN ('achieved', 'partial', 'not-achieved', 'unknown')),
    evidence_json TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL,
    evaluator_id TEXT NOT NULL,
    evaluator_version TEXT NOT NULL,
    FOREIGN KEY (outcome_id) REFERENCES evaluation_outcomes(id) ON DELETE RESTRICT
  ) STRICT;
  CREATE INDEX evaluation_self_assessments_scope_time
    ON evaluation_self_assessments(scope_key, occurred_at DESC, id DESC);
  CREATE INDEX evaluation_self_assessments_outcome_time
    ON evaluation_self_assessments(outcome_id, occurred_at DESC, id DESC);
`

const projectionOutboxSchema = `
  CREATE TABLE evaluation_projection_outbox (
    evaluation_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('pending', 'recorded')),
    attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
    next_attempt_at INTEGER NOT NULL,
    last_failure_at INTEGER,
    last_failure_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (evaluation_id) REFERENCES evaluation_outcomes(id) ON DELETE RESTRICT
  ) STRICT;
  CREATE INDEX evaluation_projection_outbox_due
    ON evaluation_projection_outbox(status, next_attempt_at, created_at, evaluation_id);
`

const scopeWatermarkSchema = `
  CREATE TABLE evaluation_scope_watermarks (
    scope_key TEXT PRIMARY KEY,
    watermark INTEGER NOT NULL CHECK (watermark >= 0),
    updated_at INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID;
`

const taskProjectionViewSchema = `
  CREATE VIEW evaluation_task_projection_view AS
  SELECT
    projection.subject_key AS task_subject_key,
    projection.subject_kind AS task_subject_kind,
    projection.subject_ref AS task_subject_ref,
    projection.objective_conflicted AS task_objective_conflicted,
    projection.primary_outcome_id AS task_primary_outcome_id,
    projection.execution_outcome_id AS task_execution_outcome_id,
    projection.objective_outcome_id AS task_objective_outcome_id,
    projection.delivery_outcome_id AS task_delivery_outcome_id,
    projection.learning_version AS task_learning_version,
    projection.learning_digest AS task_learning_digest,
    projection.learning_disposition AS task_learning_disposition,
    primary_outcome.id,
    primary_outcome.idempotency_key,
    primary_outcome.payload_hash,
    primary_outcome.scope_key,
    primary_outcome.workspace,
    primary_outcome.preset,
    primary_outcome.situation,
    COALESCE(execution_outcome.execution_status, 'unknown') AS execution_status,
    CASE
      WHEN projection.objective_conflicted = 1 THEN 'unknown'
      ELSE COALESCE(objective_outcome.objective_status, 'unknown')
    END AS objective_status,
    COALESCE(delivery_outcome.delivery_status, 'unknown') AS delivery_status,
    primary_outcome.source_kind,
    primary_outcome.source_id,
    primary_outcome.trust,
    primary_outcome.evidence_json,
    COALESCE(execution_outcome.metrics_json, '{}') AS metrics_json,
    execution_outcome.cost_usd_micros,
    execution_outcome.latency_ms,
    execution_outcome.input_tokens,
    execution_outcome.output_tokens,
    execution_outcome.tool_calls,
    COALESCE(execution_outcome.occurred_at, primary_outcome.occurred_at) AS occurred_at,
    projection.updated_at AS recorded_at,
    primary_outcome.evaluator_id,
    primary_outcome.evaluator_version
  FROM evaluation_task_projections projection
  JOIN evaluation_outcomes primary_outcome ON primary_outcome.id = projection.primary_outcome_id
  LEFT JOIN evaluation_outcomes execution_outcome ON execution_outcome.id = projection.execution_outcome_id
  LEFT JOIN evaluation_outcomes objective_outcome ON objective_outcome.id = projection.objective_outcome_id
  LEFT JOIN evaluation_outcomes delivery_outcome ON delivery_outcome.id = projection.delivery_outcome_id;
`

/**
 * Schema emitted by the v3 -> v4 migration.  Keep this definition separate
 * from the current view: a database that is genuinely at v4 does not have the
 * versioned learning columns yet.  Reusing the current schema here caused the
 * same migration transaction to create those columns and then try to add them
 * again in the v4 -> v5 step.
 */
const legacyTaskProjectionViewSchema = `
  CREATE VIEW evaluation_task_projection_view AS
  SELECT
    projection.subject_key AS task_subject_key,
    projection.subject_kind AS task_subject_kind,
    projection.subject_ref AS task_subject_ref,
    projection.objective_conflicted AS task_objective_conflicted,
    projection.primary_outcome_id AS task_primary_outcome_id,
    projection.execution_outcome_id AS task_execution_outcome_id,
    projection.objective_outcome_id AS task_objective_outcome_id,
    projection.delivery_outcome_id AS task_delivery_outcome_id,
    primary_outcome.id,
    primary_outcome.idempotency_key,
    primary_outcome.payload_hash,
    primary_outcome.scope_key,
    primary_outcome.workspace,
    primary_outcome.preset,
    primary_outcome.situation,
    COALESCE(execution_outcome.execution_status, 'unknown') AS execution_status,
    CASE
      WHEN projection.objective_conflicted = 1 THEN 'unknown'
      ELSE COALESCE(objective_outcome.objective_status, 'unknown')
    END AS objective_status,
    COALESCE(delivery_outcome.delivery_status, 'unknown') AS delivery_status,
    primary_outcome.source_kind,
    primary_outcome.source_id,
    primary_outcome.trust,
    primary_outcome.evidence_json,
    COALESCE(execution_outcome.metrics_json, '{}') AS metrics_json,
    execution_outcome.cost_usd_micros,
    execution_outcome.latency_ms,
    execution_outcome.input_tokens,
    execution_outcome.output_tokens,
    execution_outcome.tool_calls,
    COALESCE(execution_outcome.occurred_at, primary_outcome.occurred_at) AS occurred_at,
    projection.updated_at AS recorded_at,
    primary_outcome.evaluator_id,
    primary_outcome.evaluator_version
  FROM evaluation_task_projections projection
  JOIN evaluation_outcomes primary_outcome ON primary_outcome.id = projection.primary_outcome_id
  LEFT JOIN evaluation_outcomes execution_outcome ON execution_outcome.id = projection.execution_outcome_id
  LEFT JOIN evaluation_outcomes objective_outcome ON objective_outcome.id = projection.objective_outcome_id
  LEFT JOIN evaluation_outcomes delivery_outcome ON delivery_outcome.id = projection.delivery_outcome_id;
`

const taskProjectionSchema = `
  CREATE INDEX evaluation_outcomes_task_subject
    ON evaluation_outcomes(task_subject_key, recorded_at, id);
  CREATE TABLE evaluation_task_projections (
    subject_key TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('automation-run', 'outcome')),
    subject_ref TEXT NOT NULL,
    primary_outcome_id TEXT,
    execution_outcome_id TEXT,
    objective_outcome_id TEXT,
    delivery_outcome_id TEXT,
    objective_conflicted INTEGER NOT NULL DEFAULT 0 CHECK (objective_conflicted IN (0, 1)),
    learning_version INTEGER NOT NULL DEFAULT 0 CHECK (learning_version >= 0),
    learning_digest TEXT CHECK (learning_digest IS NULL OR length(learning_digest) = 64),
    learning_disposition TEXT CHECK (learning_disposition IN ('upsert', 'retract')),
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (primary_outcome_id) REFERENCES evaluation_outcomes(id) ON DELETE RESTRICT,
    FOREIGN KEY (execution_outcome_id) REFERENCES evaluation_outcomes(id) ON DELETE RESTRICT,
    FOREIGN KEY (objective_outcome_id) REFERENCES evaluation_outcomes(id) ON DELETE RESTRICT,
    FOREIGN KEY (delivery_outcome_id) REFERENCES evaluation_outcomes(id) ON DELETE RESTRICT
  ) STRICT;
  CREATE INDEX evaluation_task_projections_scope_time
    ON evaluation_task_projections(scope_key, updated_at DESC, subject_key);

  ${taskProjectionViewSchema}
`

const legacyTaskProjectionSchema = `
  CREATE INDEX evaluation_outcomes_task_subject
    ON evaluation_outcomes(task_subject_key, recorded_at, id);
  CREATE TABLE evaluation_task_projections (
    subject_key TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('automation-run', 'outcome')),
    subject_ref TEXT NOT NULL,
    primary_outcome_id TEXT,
    execution_outcome_id TEXT,
    objective_outcome_id TEXT,
    delivery_outcome_id TEXT,
    objective_conflicted INTEGER NOT NULL DEFAULT 0 CHECK (objective_conflicted IN (0, 1)),
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (primary_outcome_id) REFERENCES evaluation_outcomes(id) ON DELETE RESTRICT,
    FOREIGN KEY (execution_outcome_id) REFERENCES evaluation_outcomes(id) ON DELETE RESTRICT,
    FOREIGN KEY (objective_outcome_id) REFERENCES evaluation_outcomes(id) ON DELETE RESTRICT,
    FOREIGN KEY (delivery_outcome_id) REFERENCES evaluation_outcomes(id) ON DELETE RESTRICT
  ) STRICT;
  CREATE INDEX evaluation_task_projections_scope_time
    ON evaluation_task_projections(scope_key, updated_at DESC, subject_key);

  ${legacyTaskProjectionViewSchema}
`

function legacyTaskSubject(scopeKey: string, id: string, evidenceJson: string): {
  key: string
  kind: 'automation-run' | 'outcome'
  ref: string
} {
  try {
    const parsed = JSON.parse(evidenceJson) as unknown
    if (Array.isArray(parsed)) {
      const refs = new Set(parsed.flatMap(entry => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
        const candidate = entry as { kind?: unknown; ref?: unknown }
        return candidate.kind === 'automation-run' && typeof candidate.ref === 'string'
          && candidate.ref.trim() !== ''
          ? [candidate.ref]
          : []
      }))
      if (refs.size === 1) {
        const ref = [...refs][0]!
        return { key: JSON.stringify([scopeKey, 'automation-run', ref]), kind: 'automation-run', ref }
      }
    }
  } catch {
    // A malformed legacy reference is deliberately not guessed into a shared task.
  }
  return { key: JSON.stringify([scopeKey, 'outcome', id]), kind: 'outcome', ref: id }
}

function migrate(database: DatabaseSync): void {
  const initial = schemaVersion(database)
  if (initial > evaluationSchemaVersion) {
    throw new EvaluationDatabaseError(
      'schema-too-new',
      `evaluation schema ${initial} is newer than supported schema ${evaluationSchemaVersion}`,
    )
  }
  if (initial === evaluationSchemaVersion) return

  database.exec('BEGIN IMMEDIATE')
  try {
    if (schemaVersion(database) === 0) {
      database.exec(`
        CREATE TABLE evaluation_schema_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT;

        CREATE TABLE evaluation_outcomes (
          id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          payload_hash TEXT NOT NULL,
          scope_key TEXT NOT NULL,
          workspace TEXT NOT NULL,
          preset TEXT NOT NULL,
          situation TEXT NOT NULL,
          execution_status TEXT NOT NULL
            CHECK (execution_status IN ('succeeded', 'failed', 'timed-out', 'cancelled', 'unknown')),
          objective_status TEXT NOT NULL
            CHECK (objective_status IN ('achieved', 'partial', 'not-achieved', 'unknown')),
          delivery_status TEXT NOT NULL
            CHECK (delivery_status IN ('delivered', 'failed', 'not-required', 'unknown')),
          source_kind TEXT NOT NULL
            CHECK (source_kind IN ('automation', 'foreground', 'delivery', 'user-feedback', 'system', 'evaluator', 'import')),
          source_id TEXT NOT NULL,
          trust TEXT NOT NULL CHECK (trust IN ('trusted', 'self-reported', 'external')),
          evidence_json TEXT NOT NULL,
          metrics_json TEXT NOT NULL,
          cost_usd_micros INTEGER,
          latency_ms INTEGER,
          input_tokens INTEGER,
          output_tokens INTEGER,
          tool_calls INTEGER,
          occurred_at INTEGER NOT NULL,
          recorded_at INTEGER NOT NULL,
          evaluator_id TEXT NOT NULL,
          evaluator_version TEXT NOT NULL,
          task_subject_key TEXT,
          task_subject_kind TEXT,
          task_subject_ref TEXT
        ) STRICT;

        CREATE INDEX evaluation_outcomes_scope_time
          ON evaluation_outcomes(scope_key, occurred_at DESC, id DESC);
        CREATE INDEX evaluation_outcomes_scope_situation_time
          ON evaluation_outcomes(scope_key, situation, occurred_at DESC, id DESC);
        CREATE INDEX evaluation_outcomes_summary
          ON evaluation_outcomes(scope_key, occurred_at, situation, trust);

        ${selfAssessmentSchema}
        ${projectionOutboxSchema}
        ${taskProjectionSchema}
        ${scopeWatermarkSchema}

        INSERT INTO evaluation_schema_meta(key, value) VALUES ('schema-version', '7');
        PRAGMA user_version = 7;
      `)
    }
    if (schemaVersion(database) === 1) {
      database.exec(`
        ${selfAssessmentSchema}
        UPDATE evaluation_schema_meta SET value = '2' WHERE key = 'schema-version';
        PRAGMA user_version = 2;
      `)
    }
    if (schemaVersion(database) === 2) {
      database.exec(`
        ${projectionOutboxSchema}
        INSERT INTO evaluation_projection_outbox(
          evaluation_id, status, attempt_count, next_attempt_at,
          last_failure_at, last_failure_code, created_at, updated_at)
        SELECT id, 'pending', 0, recorded_at, NULL, NULL, recorded_at, recorded_at
        FROM evaluation_outcomes
        WHERE trust = 'trusted' AND objective_status <> 'unknown';
        UPDATE evaluation_schema_meta SET value = '3' WHERE key = 'schema-version';
        PRAGMA user_version = 3;
      `)
    }
    if (schemaVersion(database) === 3) {
      database.exec(`
        ALTER TABLE evaluation_outcomes ADD COLUMN task_subject_key TEXT;
        ALTER TABLE evaluation_outcomes ADD COLUMN task_subject_kind TEXT;
        ALTER TABLE evaluation_outcomes ADD COLUMN task_subject_ref TEXT;
        ${legacyTaskProjectionSchema}
      `)
      const columns = new Set((database.prepare('PRAGMA table_info(evaluation_outcomes)').all() as Array<{
        name: string
      }>).map(column => column.name))
      if (columns.has('scope_key') && columns.has('evidence_json')) {
        const rows = database.prepare(`
          SELECT id, scope_key, evidence_json FROM evaluation_outcomes
          ORDER BY recorded_at, id
        `).all() as Array<{ id: string; scope_key: string; evidence_json: string }>
        const update = database.prepare(`
          UPDATE evaluation_outcomes
          SET task_subject_key = ?, task_subject_kind = ?, task_subject_ref = ?
          WHERE id = ?
        `)
        const insert = database.prepare(`
          INSERT INTO evaluation_task_projections(
            subject_key, scope_key, subject_kind, subject_ref, updated_at)
          VALUES (?, ?, ?, ?, 0)
          ON CONFLICT(subject_key) DO NOTHING
        `)
        for (const row of rows) {
          const subject = legacyTaskSubject(row.scope_key, row.id, row.evidence_json)
          update.run(subject.key, subject.kind, subject.ref, row.id)
          insert.run(subject.key, row.scope_key, subject.kind, subject.ref)
        }
      }
      database.exec(`
        UPDATE evaluation_schema_meta SET value = '4' WHERE key = 'schema-version';
        PRAGMA user_version = 4;
      `)
    }
    if (schemaVersion(database) === 4) {
      database.exec(`
        DROP VIEW evaluation_task_projection_view;
        ALTER TABLE evaluation_task_projections
          ADD COLUMN learning_version INTEGER NOT NULL DEFAULT 0 CHECK (learning_version >= 0);
        ALTER TABLE evaluation_task_projections
          ADD COLUMN learning_digest TEXT CHECK (learning_digest IS NULL OR length(learning_digest) = 64);
        ALTER TABLE evaluation_task_projections
          ADD COLUMN learning_disposition TEXT CHECK (learning_disposition IN ('upsert', 'retract'));
        ${taskProjectionViewSchema}

        -- v4 delivered raw outcome state. Re-run each retained trigger once so
        -- Evolution can replace it with the canonical versioned task state.
        UPDATE evaluation_projection_outbox
        SET status = 'pending', attempt_count = 0, next_attempt_at = updated_at,
            last_failure_at = NULL, last_failure_code = NULL;
        INSERT INTO evaluation_projection_outbox(
          evaluation_id, status, attempt_count, next_attempt_at,
          last_failure_at, last_failure_code, created_at, updated_at)
        SELECT projection.primary_outcome_id, 'pending', 0, projection.updated_at,
          NULL, NULL, projection.updated_at, projection.updated_at
        FROM evaluation_task_projections projection
        JOIN evaluation_outcomes outcome ON outcome.id = projection.primary_outcome_id
        WHERE outcome.trust = 'trusted'
        ON CONFLICT(evaluation_id) DO NOTHING;

        UPDATE evaluation_schema_meta SET value = '5' WHERE key = 'schema-version';
        PRAGMA user_version = 5;
      `)
    }
    if (schemaVersion(database) === 5) {
      database.exec(`
        -- Protocol v2 uses a distinct task-revision sink capability.  A v5
        -- Evaluation may already have marked a trigger recorded after an older
        -- Evolution accepted the raw-outcome protocol, which would otherwise
        -- lose a later retract forever.  Requeue every retained task once when
        -- crossing this compatibility boundary.
        UPDATE evaluation_projection_outbox
        SET status = 'pending', attempt_count = 0, next_attempt_at = updated_at,
            last_failure_at = NULL, last_failure_code = NULL;
        INSERT INTO evaluation_projection_outbox(
          evaluation_id, status, attempt_count, next_attempt_at,
          last_failure_at, last_failure_code, created_at, updated_at)
        SELECT projection.primary_outcome_id, 'pending', 0, projection.updated_at,
          NULL, NULL, projection.updated_at, projection.updated_at
        FROM evaluation_task_projections projection
        JOIN evaluation_outcomes outcome ON outcome.id = projection.primary_outcome_id
        WHERE outcome.trust = 'trusted'
        ON CONFLICT(evaluation_id) DO UPDATE SET
          status = 'pending', attempt_count = 0,
          next_attempt_at = excluded.next_attempt_at,
          last_failure_at = NULL, last_failure_code = NULL,
          updated_at = excluded.updated_at;

        UPDATE evaluation_schema_meta SET value = '6' WHERE key = 'schema-version';
        PRAGMA user_version = 6;
      `)
    }
    if (schemaVersion(database) === 6) {
      database.exec(`
        ${scopeWatermarkSchema}
        -- The sum of each subject's monotonic learning revision is the exact
        -- number of retained canonical changes represented by a v6 database.
        -- New changes increment this scope value one at a time.
        INSERT INTO evaluation_scope_watermarks(scope_key, watermark, updated_at)
        SELECT scope_key, SUM(learning_version), MAX(updated_at)
        FROM evaluation_task_projections
        GROUP BY scope_key;

        -- Protocol v3 carries the scope watermark and is mandatory for the
        -- downstream writer fence. A v6 sink acknowledgement is insufficient.
        UPDATE evaluation_projection_outbox
        SET status = 'pending', attempt_count = 0, next_attempt_at = updated_at,
            last_failure_at = NULL, last_failure_code = NULL;
        INSERT INTO evaluation_projection_outbox(
          evaluation_id, status, attempt_count, next_attempt_at,
          last_failure_at, last_failure_code, created_at, updated_at)
        SELECT projection.primary_outcome_id, 'pending', 0, projection.updated_at,
          NULL, NULL, projection.updated_at, projection.updated_at
        FROM evaluation_task_projections projection
        JOIN evaluation_outcomes outcome ON outcome.id = projection.primary_outcome_id
        WHERE outcome.trust = 'trusted'
        ON CONFLICT(evaluation_id) DO UPDATE SET
          status = 'pending', attempt_count = 0,
          next_attempt_at = excluded.next_attempt_at,
          last_failure_at = NULL, last_failure_code = NULL,
          updated_at = excluded.updated_at;

        UPDATE evaluation_schema_meta SET value = '7' WHERE key = 'schema-version';
        PRAGMA user_version = 7;
      `)
    }
    if (schemaVersion(database) !== evaluationSchemaVersion) {
      throw new Error('evaluation migration did not reach the current schema')
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
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
        throw new Error(`evaluation database refused WAL mode: ${row.journal_mode}`)
      }
      return
    } catch (error) {
      const retryable = error instanceof Error && /database is (?:busy|locked)/i.test(error.message)
      if (!retryable || Date.now() >= deadline) throw error
      Atomics.wait(walRetryWait, 0, 0, 10)
    }
  }
}

export function openEvaluationDatabase(path: string): DatabaseSync {
  if (path !== ':memory:' && !isAbsolute(path)) {
    throw new EvaluationDatabaseError('invalid-path', 'evaluation database path must be absolute')
  }
  if (path !== ':memory:') preparePrivateFile(path)
  const database = new DatabaseSync(path)
  try {
    database.exec('PRAGMA foreign_keys = ON')
    database.exec('PRAGMA busy_timeout = 5000')
    database.exec('PRAGMA synchronous = FULL')
    migrate(database)
    if (path !== ':memory:') {
      enableWal(database)
      chmodSync(path, 0o600)
    }
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
