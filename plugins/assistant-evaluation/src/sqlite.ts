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

export const evaluationSchemaVersion = 15

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
    status TEXT NOT NULL CHECK (status IN ('pending', 'recorded', 'not-required')),
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

const taskProjectionFeedSchema = `
  CREATE TABLE IF NOT EXISTS evaluation_task_projection_feed_heads (
    subject_key TEXT PRIMARY KEY REFERENCES evaluation_task_projections(subject_key) ON DELETE RESTRICT,
    scope_key TEXT NOT NULL,
    watermark INTEGER NOT NULL CHECK (watermark >= 1)
  ) STRICT, WITHOUT ROWID;
  CREATE UNIQUE INDEX IF NOT EXISTS evaluation_task_projection_feed_scope_watermark
    ON evaluation_task_projection_feed_heads(scope_key, watermark);
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
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('automation-run', 'foreground-turn', 'goal-step', 'goal-outcome', 'work-item', 'outcome')),
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

/**
 * WP22 per-notification outcome canon. Revisions are immutable; the head names
 * the current revision and carries a per-scope notification watermark used as a
 * restart-safe read cursor. Separate from task-learning watermarks so this
 * read-only feed never fences or advances Evolution evidence.
 */
const notificationOutcomeSchema = `
  CREATE TABLE evaluation_notification_outcome_revisions (
    notification_id TEXT NOT NULL CHECK (length(notification_id) BETWEEN 1 AND 256),
    version INTEGER NOT NULL CHECK (version >= 1),
    scope_key TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('pending','delivered','reacted','accepted','rejected','expired-unhandled','failed')),
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    watermark INTEGER NOT NULL CHECK (watermark >= 1),
    recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0),
    PRIMARY KEY (notification_id, version),
    UNIQUE (scope_key, watermark)
  ) STRICT;
  CREATE TRIGGER evaluation_notification_outcome_revisions_immutable
    BEFORE UPDATE ON evaluation_notification_outcome_revisions
    BEGIN SELECT RAISE(ABORT, 'notification outcome revisions are immutable'); END;
  CREATE TRIGGER evaluation_notification_outcome_revisions_no_delete
    BEFORE DELETE ON evaluation_notification_outcome_revisions
    BEGIN SELECT RAISE(ABORT, 'notification outcome revisions are durable'); END;
  CREATE TABLE evaluation_notification_outcome_heads (
    notification_id TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    outcome TEXT NOT NULL,
    occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
    watermark INTEGER NOT NULL CHECK (watermark >= 1),
    last_checked_at INTEGER NOT NULL CHECK (last_checked_at >= 0),
    UNIQUE (scope_key, watermark),
    FOREIGN KEY (notification_id, version) REFERENCES evaluation_notification_outcome_revisions(notification_id, version)
  ) STRICT;
  -- Re-check scans range over occurred_at so heads older than the observation
  -- horizon are never visited again; the scan is bounded by in-horizon heads.
  CREATE INDEX evaluation_notification_outcome_heads_due
    ON evaluation_notification_outcome_heads(occurred_at, last_checked_at);
  CREATE INDEX evaluation_notification_outcome_heads_scope_time
    ON evaluation_notification_outcome_heads(scope_key, occurred_at);
  CREATE TRIGGER evaluation_notification_outcome_heads_insert_matches_revision
    BEFORE INSERT ON evaluation_notification_outcome_heads
    WHEN NOT EXISTS (SELECT 1 FROM evaluation_notification_outcome_revisions r
      WHERE r.notification_id = NEW.notification_id AND r.version = NEW.version AND r.scope_key = NEW.scope_key
        AND r.digest = NEW.digest AND r.outcome = NEW.outcome AND r.watermark = NEW.watermark
        AND json_extract(r.record_json, '$.notifiedAt') = NEW.occurred_at)
    BEGIN SELECT RAISE(ABORT, 'notification outcome head must match its revision'); END;
  CREATE TRIGGER evaluation_notification_outcome_heads_update_matches_revision
    BEFORE UPDATE ON evaluation_notification_outcome_heads
    WHEN NOT EXISTS (SELECT 1 FROM evaluation_notification_outcome_revisions r
      WHERE r.notification_id = NEW.notification_id AND r.version = NEW.version AND r.scope_key = NEW.scope_key
        AND r.digest = NEW.digest AND r.outcome = NEW.outcome AND r.watermark = NEW.watermark
        AND json_extract(r.record_json, '$.notifiedAt') = NEW.occurred_at)
    BEGIN SELECT RAISE(ABORT, 'notification outcome head must match its revision'); END;
  CREATE TRIGGER evaluation_notification_outcome_heads_identity_immutable
    BEFORE UPDATE OF notification_id, scope_key, occurred_at ON evaluation_notification_outcome_heads
    WHEN NEW.notification_id IS NOT OLD.notification_id OR NEW.scope_key IS NOT OLD.scope_key
      OR NEW.occurred_at IS NOT OLD.occurred_at
    BEGIN SELECT RAISE(ABORT, 'notification outcome head identity is immutable'); END;
  CREATE TRIGGER evaluation_notification_outcome_heads_monotonic
    BEFORE UPDATE OF version, watermark ON evaluation_notification_outcome_heads
    WHEN NEW.version <= OLD.version OR NEW.watermark <= OLD.watermark
    BEGIN SELECT RAISE(ABORT, 'notification outcome head must advance'); END;
  CREATE TRIGGER evaluation_notification_outcome_heads_no_delete
    BEFORE DELETE ON evaluation_notification_outcome_heads
    BEGIN SELECT RAISE(ABORT, 'notification outcome heads are durable'); END;
  CREATE TABLE evaluation_notification_watermarks (
    scope_key TEXT PRIMARY KEY,
    watermark INTEGER NOT NULL CHECK (watermark >= 1)
  ) STRICT;
  CREATE TRIGGER evaluation_notification_watermarks_monotonic
    BEFORE UPDATE ON evaluation_notification_watermarks
    WHEN NEW.scope_key IS NOT OLD.scope_key OR NEW.watermark <= OLD.watermark
    BEGIN SELECT RAISE(ABORT, 'notification watermark must advance'); END;
  CREATE TRIGGER evaluation_notification_watermarks_no_delete
    BEFORE DELETE ON evaluation_notification_watermarks
    BEGIN SELECT RAISE(ABORT, 'notification watermarks are durable'); END;
  CREATE TABLE evaluation_notification_sync_cursor (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    after_sequence INTEGER NOT NULL CHECK (after_sequence >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
  ) STRICT;
  CREATE TRIGGER evaluation_notification_sync_cursor_monotonic
    BEFORE UPDATE ON evaluation_notification_sync_cursor
    WHEN NEW.after_sequence < OLD.after_sequence
    BEGIN SELECT RAISE(ABORT, 'notification sync cursor must not regress'); END;
  CREATE TRIGGER evaluation_notification_sync_cursor_no_delete
    BEFORE DELETE ON evaluation_notification_sync_cursor
    BEGIN SELECT RAISE(ABORT, 'notification sync cursor is durable'); END;
`

/**
 * WP22 slice 2 attention-tuning canon. Each version is immutable, names its
 * exact parent (0 = built-in default) and carries the basis outcome summary
 * plus scope notification watermark it was derived from. The head names the
 * active version and a durable observation window; events are append-only.
 */
const attentionTuningSchema = `
  CREATE TABLE evaluation_attention_tuning_versions (
    scope_key TEXT NOT NULL,
    lane TEXT NOT NULL CHECK (length(lane) BETWEEN 1 AND 64),
    source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 256),
    version INTEGER NOT NULL CHECK (version >= 1),
    parent_version INTEGER NOT NULL CHECK (parent_version >= 0 AND parent_version < version),
    parameters_json TEXT NOT NULL CHECK (json_valid(parameters_json)),
    basis_json TEXT NOT NULL CHECK (json_valid(basis_json)),
    change_json TEXT NOT NULL CHECK (json_valid(change_json)),
    origin TEXT NOT NULL CHECK (origin IN ('auto','request')),
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (scope_key, lane, source_id, version)
  ) STRICT;
  CREATE TRIGGER evaluation_attention_tuning_versions_immutable
    BEFORE UPDATE ON evaluation_attention_tuning_versions
    BEGIN SELECT RAISE(ABORT, 'attention tuning versions are immutable'); END;
  CREATE TRIGGER evaluation_attention_tuning_versions_no_delete
    BEFORE DELETE ON evaluation_attention_tuning_versions
    BEGIN SELECT RAISE(ABORT, 'attention tuning versions are durable'); END;
  CREATE TABLE evaluation_attention_tuning_heads (
    scope_key TEXT NOT NULL,
    lane TEXT NOT NULL,
    source_id TEXT NOT NULL,
    workspace TEXT NOT NULL,
    preset TEXT NOT NULL,
    active_version INTEGER NOT NULL CHECK (active_version >= 0),
    latest_version INTEGER NOT NULL CHECK (latest_version >= active_version),
    state TEXT NOT NULL CHECK (state IN ('idle','observing')),
    observing_version INTEGER,
    observe_from INTEGER,
    observe_until INTEGER,
    changed_at INTEGER NOT NULL CHECK (changed_at >= 0),
    CHECK ((state = 'idle' AND observing_version IS NULL AND observe_from IS NULL AND observe_until IS NULL)
      OR (state = 'observing' AND observing_version = active_version AND observe_from IS NOT NULL AND observe_until > observe_from)),
    PRIMARY KEY (scope_key, lane, source_id)
  ) STRICT;
  CREATE TRIGGER evaluation_attention_tuning_heads_no_delete
    BEFORE DELETE ON evaluation_attention_tuning_heads
    BEGIN SELECT RAISE(ABORT, 'attention tuning heads are durable'); END;
  CREATE TABLE evaluation_attention_tuning_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_key TEXT NOT NULL,
    lane TEXT NOT NULL,
    source_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('adopted','rolled-back','settled','request-rejected')),
    from_version INTEGER NOT NULL CHECK (from_version >= 0),
    to_version INTEGER NOT NULL CHECK (to_version >= 0),
    reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 64),
    detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
    idempotency_key TEXT UNIQUE,
    occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0)
  ) STRICT;
  CREATE INDEX evaluation_attention_tuning_events_cohort
    ON evaluation_attention_tuning_events(scope_key, lane, source_id, sequence);
  CREATE TRIGGER evaluation_attention_tuning_events_immutable
    BEFORE UPDATE ON evaluation_attention_tuning_events
    BEGIN SELECT RAISE(ABORT, 'attention tuning events are immutable'); END;
  CREATE TRIGGER evaluation_attention_tuning_events_no_delete
    BEFORE DELETE ON evaluation_attention_tuning_events
    BEGIN SELECT RAISE(ABORT, 'attention tuning events are durable'); END;
`

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
    if (schemaVersion(database) === 7) {
      database.exec(`
        CREATE TABLE evaluation_owner_revisions (
          outcome_id TEXT PRIMARY KEY REFERENCES evaluation_outcomes(id),
          subject_key TEXT NOT NULL,
          lineage TEXT NOT NULL,
          version INTEGER NOT NULL,
          previous_outcome_id TEXT,
          action TEXT NOT NULL,
          command_json TEXT NOT NULL,
          UNIQUE(subject_key, lineage, version)
        ) STRICT;
        CREATE TABLE evaluation_owner_commands (
          operation_id TEXT PRIMARY KEY,
          payload_hash TEXT NOT NULL,
          outcome_id TEXT REFERENCES evaluation_outcomes(id),
          failure_code TEXT
        ) STRICT;
        UPDATE evaluation_schema_meta SET value = '8' WHERE key = 'schema-version';
        PRAGMA user_version = 8;
      `)
    }
    if (schemaVersion(database) === 8) {
      // SQLite CHECK constraints cannot be widened in place.  Preserve every
      // existing v8 projection while enabling the distinct foreground subject.
      database.exec(`
        DROP VIEW evaluation_task_projection_view;
        ALTER TABLE evaluation_task_projections RENAME TO evaluation_task_projections_v8;
        DROP INDEX evaluation_task_projections_scope_time;
        CREATE TABLE evaluation_task_projections (
          subject_key TEXT PRIMARY KEY,
          scope_key TEXT NOT NULL,
          subject_kind TEXT NOT NULL CHECK (subject_kind IN ('automation-run', 'foreground-turn', 'outcome')),
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
        INSERT INTO evaluation_task_projections (
          subject_key, scope_key, subject_kind, subject_ref, primary_outcome_id,
          execution_outcome_id, objective_outcome_id, delivery_outcome_id,
          objective_conflicted, learning_version, learning_digest, learning_disposition, updated_at
        ) SELECT subject_key, scope_key, subject_kind, subject_ref, primary_outcome_id,
          execution_outcome_id, objective_outcome_id, delivery_outcome_id,
          objective_conflicted, learning_version, learning_digest, learning_disposition, updated_at
          FROM evaluation_task_projections_v8;
        DROP TABLE evaluation_task_projections_v8;
        ${taskProjectionViewSchema}
        UPDATE evaluation_schema_meta SET value = '9' WHERE key = 'schema-version';
        PRAGMA user_version = 9;
      `)
    }
    if (schemaVersion(database) === 9) {
      // Rebuild only the constrained projection table; its rows and all
      // outcome/foreign-key references remain intact across the v9 -> v10 step.
      database.exec(`
        DROP VIEW evaluation_task_projection_view;
        ALTER TABLE evaluation_task_projections RENAME TO evaluation_task_projections_v9;
        DROP INDEX evaluation_task_projections_scope_time;
        ${taskProjectionSchema.replace('CREATE INDEX evaluation_outcomes_task_subject\n    ON evaluation_outcomes(task_subject_key, recorded_at, id);', '')}
        INSERT INTO evaluation_task_projections SELECT * FROM evaluation_task_projections_v9;
        DROP TABLE evaluation_task_projections_v9;
        UPDATE evaluation_schema_meta SET value = '10' WHERE key = 'schema-version';
        PRAGMA user_version = 10;
      `)
    }
    if (schemaVersion(database) === 10) {
      // Preserve all historical projections while widening only the durable
      // subject-kind constraint for whole-goal verifier assessments.
      database.exec(`
        DROP VIEW evaluation_task_projection_view;
        ALTER TABLE evaluation_task_projections RENAME TO evaluation_task_projections_v10;
        DROP INDEX evaluation_task_projections_scope_time;
        ${taskProjectionSchema.replace('CREATE INDEX evaluation_outcomes_task_subject\n    ON evaluation_outcomes(task_subject_key, recorded_at, id);', '')}
        INSERT INTO evaluation_task_projections SELECT * FROM evaluation_task_projections_v10;
        DROP TABLE evaluation_task_projections_v10;
        UPDATE evaluation_schema_meta SET value = '11' WHERE key = 'schema-version';
        PRAGMA user_version = 11;
      `)
    }
    if (schemaVersion(database) === 11) {
      // Historical projections had a scope fence but no cursorable head. Give
      // every existing canonical subject a stable new watermark exactly once.
      const overflow = database.prepare(`
        SELECT 1 FROM evaluation_scope_watermarks watermark
        JOIN (
          SELECT scope_key, COUNT(*) AS count FROM evaluation_task_projections
          WHERE learning_version >= 1 AND learning_digest IS NOT NULL GROUP BY scope_key
        ) projection ON projection.scope_key = watermark.scope_key
        WHERE watermark.watermark > ${Number.MAX_SAFE_INTEGER} - projection.count LIMIT 1
      `).get()
      if (overflow !== undefined) throw new Error('evaluation projection feed watermark overflow')
      database.exec(`
        ${taskProjectionFeedSchema}
        INSERT INTO evaluation_scope_watermarks(scope_key, watermark, updated_at)
        SELECT scope_key, 0, MAX(updated_at) FROM evaluation_task_projections
        GROUP BY scope_key ON CONFLICT(scope_key) DO NOTHING;
        INSERT INTO evaluation_task_projection_feed_heads(subject_key, scope_key, watermark)
        SELECT projection.subject_key, projection.scope_key,
          existing.watermark + ROW_NUMBER() OVER (PARTITION BY projection.scope_key ORDER BY projection.subject_key)
        FROM evaluation_task_projections projection
        JOIN evaluation_outcomes primary_outcome ON primary_outcome.id = projection.primary_outcome_id
        JOIN evaluation_scope_watermarks existing ON existing.scope_key = projection.scope_key
        WHERE primary_outcome.trust = 'trusted'
          AND projection.learning_version >= 1 AND projection.learning_digest IS NOT NULL
        ON CONFLICT(subject_key) DO NOTHING;
        UPDATE evaluation_scope_watermarks
        SET watermark = watermark + (
          SELECT COUNT(*) FROM evaluation_task_projection_feed_heads head
          WHERE head.scope_key = evaluation_scope_watermarks.scope_key
        );
        UPDATE evaluation_schema_meta SET value = '12' WHERE key = 'schema-version';
        PRAGMA user_version = 12;
      `)
    }
    if (schemaVersion(database) === 12) {
      // Preserve feed heads and every semantic revision verbatim while widening
      // the projection identity. Historical settlement evidence is not re-keyed.
      database.exec(`
        CREATE TEMP TABLE evaluation_v12_feed AS SELECT * FROM evaluation_task_projection_feed_heads;
        DROP TABLE evaluation_task_projection_feed_heads;
        DROP VIEW evaluation_task_projection_view;
        ALTER TABLE evaluation_task_projections RENAME TO evaluation_task_projections_v12;
        DROP INDEX evaluation_task_projections_scope_time;
        ${taskProjectionSchema.replace('CREATE INDEX evaluation_outcomes_task_subject\n    ON evaluation_outcomes(task_subject_key, recorded_at, id);', '')}
        INSERT INTO evaluation_task_projections SELECT * FROM evaluation_task_projections_v12;
        DROP TABLE evaluation_task_projections_v12;
        ${taskProjectionFeedSchema}
        INSERT INTO evaluation_task_projection_feed_heads SELECT * FROM evaluation_v12_feed;
        DROP TABLE evaluation_v12_feed;
        CREATE TEMP TABLE evaluation_v12_outbox AS SELECT * FROM evaluation_projection_outbox;
        DROP TABLE evaluation_projection_outbox;
        ${projectionOutboxSchema}
        INSERT INTO evaluation_projection_outbox SELECT * FROM evaluation_v12_outbox;
        DROP TABLE evaluation_v12_outbox;
        UPDATE evaluation_schema_meta SET value = '13' WHERE key = 'schema-version';
        PRAGMA user_version = 13;
      `)
    }
    if (schemaVersion(database) === 13) {
      database.exec(`
        ${notificationOutcomeSchema}
        UPDATE evaluation_schema_meta SET value = '14' WHERE key = 'schema-version';
        PRAGMA user_version = 14;
      `)
    }
    if (schemaVersion(database) === 14) {
      database.exec(`
        ${attentionTuningSchema}
        UPDATE evaluation_schema_meta SET value = '15' WHERE key = 'schema-version';
        PRAGMA user_version = 15;
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
