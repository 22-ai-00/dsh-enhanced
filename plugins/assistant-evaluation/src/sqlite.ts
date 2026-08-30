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

export const evaluationSchemaVersion = 2

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
          evaluator_version TEXT NOT NULL
        ) STRICT;

        CREATE INDEX evaluation_outcomes_scope_time
          ON evaluation_outcomes(scope_key, occurred_at DESC, id DESC);
        CREATE INDEX evaluation_outcomes_scope_situation_time
          ON evaluation_outcomes(scope_key, situation, occurred_at DESC, id DESC);
        CREATE INDEX evaluation_outcomes_summary
          ON evaluation_outcomes(scope_key, occurred_at, situation, trust);

        ${selfAssessmentSchema}

        INSERT INTO evaluation_schema_meta(key, value) VALUES ('schema-version', '2');
        PRAGMA user_version = 2;
      `)
    }
    if (schemaVersion(database) === 1) {
      database.exec(`
        ${selfAssessmentSchema}
        UPDATE evaluation_schema_meta SET value = '2' WHERE key = 'schema-version';
        PRAGMA user_version = 2;
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
