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
import { EMPTY_BOOTSTRAP_ATTESTATION_SET_DIGEST } from './attestation.js'

export { EMPTY_BOOTSTRAP_ATTESTATION_SET_DIGEST } from './attestation.js'

export const recoverySchemaVersion = 5

// Existing v1 rows deliberately receive a digest that no current activation
// plan can produce. They remain auditable, but cannot attest a new schedule.
const LEGACY_ACTIVATION_PLAN_DIGEST = '2eb6dc66ca160135a7eb00a7c9a5217be11e45814929fa20863b0d0e0407a6c5'
const LEGACY_RUN_DEADLINE_MS = 850_000
const LEGACY_STEP_DEADLINE_MS = 70_000

export class RecoveryDatabaseError extends Error {
  constructor(
    readonly code: 'invalid-path' | 'schema-too-new' | 'unsafe-file',
    message: string,
  ) {
    super(message)
    this.name = 'RecoveryDatabaseError'
  }
}

function assertSafeFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new RecoveryDatabaseError(
      'unsafe-file',
      'assistant-recovery database must be one regular, unlinked file',
    )
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new RecoveryDatabaseError(
      'unsafe-file',
      'assistant-recovery database permissions must not allow group or other access',
    )
  }
  const uid = process.getuid?.()
  if (uid !== undefined && stat.uid !== uid) {
    throw new RecoveryDatabaseError(
      'unsafe-file',
      'assistant-recovery database must be owned by the current OS user',
    )
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

function createSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE recovery_runs (
      id TEXT PRIMARY KEY,
      occurrence_id TEXT NOT NULL UNIQUE,
      automation_id TEXT NOT NULL,
      definition_hash TEXT NOT NULL CHECK (length(definition_hash) = 64),
      execution_mode TEXT NOT NULL CHECK (execution_mode IN ('preview', 'production')),
      target_workspace TEXT NOT NULL,
      target_preset TEXT NOT NULL,
      principal TEXT NOT NULL,
      owner_route_id TEXT NOT NULL,
      activation_nonce TEXT NOT NULL,
      activation_plan_digest TEXT NOT NULL CHECK (length(activation_plan_digest) = 64),
      catalog_digest TEXT NOT NULL CHECK (length(catalog_digest) = 64),
      status TEXT NOT NULL CHECK (status IN ('failed', 'running', 'succeeded', 'unknown')),
      result_code TEXT,
      started_at INTEGER NOT NULL,
      deadline_at INTEGER NOT NULL CHECK (deadline_at >= started_at),
      finished_at INTEGER,
      version INTEGER NOT NULL CHECK (version >= 1),
      CHECK ((status = 'running') = (finished_at IS NULL AND result_code IS NULL))
    ) STRICT;

    CREATE INDEX recovery_runs_status
      ON recovery_runs(status, started_at, id);

    CREATE TABLE recovery_steps (
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL CHECK (step_id IN (
        'authority-admission',
        'ledger-reconcile',
        'retention-maintenance',
        't1-effects',
        'regression-rollback',
        'incident-review',
        'strategy-learning',
        'verification'
      )),
      step_index INTEGER NOT NULL CHECK (step_index >= 0 AND step_index < 8),
      idempotency_key TEXT NOT NULL UNIQUE,
      action_json TEXT NOT NULL CHECK (
        json_valid(action_json) AND json_type(action_json) = 'object' AND length(action_json) <= 2048),
      action_digest TEXT NOT NULL CHECK (length(action_digest) = 64),
      status TEXT NOT NULL CHECK (status IN ('failed', 'noop', 'started', 'succeeded', 'unknown')),
      before_digest TEXT NOT NULL CHECK (length(before_digest) = 64),
      after_digest TEXT CHECK (after_digest IS NULL OR length(after_digest) = 64),
      result_code TEXT,
      started_at INTEGER NOT NULL,
      deadline_at INTEGER NOT NULL CHECK (deadline_at >= started_at),
      finished_at INTEGER,
      version INTEGER NOT NULL CHECK (version >= 1),
      PRIMARY KEY(run_id, step_id),
      UNIQUE(run_id, step_index),
      FOREIGN KEY(run_id) REFERENCES recovery_runs(id) ON DELETE RESTRICT,
      CHECK ((status = 'started') = (
        finished_at IS NULL
        AND after_digest IS NULL
        AND result_code IS NULL
      )),
      CHECK (status = 'started' OR (
        finished_at IS NOT NULL AND after_digest IS NOT NULL AND result_code IS NOT NULL
      ))
    ) STRICT, WITHOUT ROWID;

    CREATE INDEX recovery_steps_incomplete
      ON recovery_steps(status, started_at, run_id);

    CREATE TABLE recovery_runtime_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      bootstrap_status TEXT NOT NULL CHECK (
        bootstrap_status IN ('failed', 'idle', 'running', 'succeeded')),
      bootstrap_failure_code TEXT,
      bootstrap_generation INTEGER NOT NULL CHECK (bootstrap_generation >= 0),
      bootstrap_attestation_valid INTEGER NOT NULL CHECK (bootstrap_attestation_valid IN (0, 1)),
      bootstrap_attestations_json TEXT NOT NULL CHECK (
        json_valid(bootstrap_attestations_json)
        AND json_type(bootstrap_attestations_json) = 'array'
        AND length(bootstrap_attestations_json) <= 131072),
      bootstrap_attestation_set_digest TEXT NOT NULL CHECK (
        length(bootstrap_attestation_set_digest) = 64),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      CHECK ((bootstrap_status = 'failed') = (bootstrap_failure_code IS NOT NULL))
    ) STRICT;

    INSERT INTO recovery_runtime_state (
      singleton, bootstrap_status, bootstrap_failure_code, bootstrap_generation,
      bootstrap_attestation_valid, bootstrap_attestations_json,
      bootstrap_attestation_set_digest, updated_at
    ) VALUES (
      1, 'idle', NULL, 0, 0, '[]', '${EMPTY_BOOTSTRAP_ATTESTATION_SET_DIGEST}', 0
    );

    PRAGMA user_version = 5;
  `)
}

// Legacy v1-v3 installs never carried the immutable action receipt columns;
// their step rows are audit-only and can never be resumed (the run keeps the
// unmatchable LEGACY_ACTIVATION_PLAN_DIGEST). When the v5 migration encounters
// such a table it fills the new NOT NULL columns with this fixed non-secret
// marker rather than fabricating receipts.
const LEGACY_STATE_DIGEST = '0'.repeat(64)
const LEGACY_ACTION_JSON = '{"kind":"noop","reasonCode":"legacy-v1-migration"}'

const RECOVERY_STEPS_V5_DDL = `
  CREATE TABLE recovery_steps_v5 (
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL CHECK (step_id IN (
      'authority-admission',
      'ledger-reconcile',
      'retention-maintenance',
      't1-effects',
      'regression-rollback',
      'incident-review',
      'strategy-learning',
      'verification'
    )),
    step_index INTEGER NOT NULL CHECK (step_index >= 0 AND step_index < 8),
    idempotency_key TEXT NOT NULL UNIQUE,
    action_json TEXT NOT NULL CHECK (
      json_valid(action_json) AND json_type(action_json) = 'object' AND length(action_json) <= 2048),
    action_digest TEXT NOT NULL CHECK (length(action_digest) = 64),
    status TEXT NOT NULL CHECK (status IN ('failed', 'noop', 'started', 'succeeded', 'unknown')),
    before_digest TEXT NOT NULL CHECK (length(before_digest) = 64),
    after_digest TEXT CHECK (after_digest IS NULL OR length(after_digest) = 64),
    result_code TEXT,
    started_at INTEGER NOT NULL,
    deadline_at INTEGER NOT NULL CHECK (deadline_at >= started_at),
    finished_at INTEGER,
    version INTEGER NOT NULL CHECK (version >= 1),
    PRIMARY KEY(run_id, step_id),
    UNIQUE(run_id, step_index),
    FOREIGN KEY(run_id) REFERENCES recovery_runs(id) ON DELETE RESTRICT,
    CHECK ((status = 'started') = (
      finished_at IS NULL
      AND after_digest IS NULL
      AND result_code IS NULL
    )),
    CHECK (status = 'started' OR (
      finished_at IS NOT NULL AND after_digest IS NOT NULL AND result_code IS NOT NULL
    ))
  ) STRICT, WITHOUT ROWID;
`

function migrateV4ToV5(database: DatabaseSync): void {
  // The strategy-learning step is wedged into the catalog before verification.
  // SQLite cannot alter a CHECK constraint or renumber rows in place, so rebuild
  // the steps table: verification moves from index 6 to 7, and strategy-learning
  // takes index 6. Pre-v5 runs carry the older catalog digest and can never be
  // resumed by v4-runbook code (exactJob pins the digest), so their rows are
  // preserved for audit only and simply lack a strategy-learning row.
  //
  // PRAGMA table_info returns no rows when the table is absent (a v3-only
  // install that never recorded a step); legacy v1-v3 installs have a minimal
  // steps table without step_index/action receipts and need synthetic fillers.
  const columns = database.prepare('PRAGMA table_info(recovery_steps)').all() as { name: string }[]
  const hasModernTable = columns.length > 0
  const hasStepIndex = columns.some(column => column.name === 'step_index')

  database.exec(RECOVERY_STEPS_V5_DDL)

  if (hasModernTable) {
    if (hasStepIndex) {
      database.exec(`
        INSERT INTO recovery_steps_v5 (
          run_id, step_id, step_index, idempotency_key, action_json, action_digest,
          status, before_digest, after_digest, result_code,
          started_at, deadline_at, finished_at, version
        )
        SELECT
          run_id, step_id,
          CASE WHEN step_id = 'verification' THEN step_index + 1 ELSE step_index END,
          idempotency_key, action_json, action_digest,
          status, before_digest, after_digest, result_code,
          started_at, deadline_at, finished_at, version
        FROM recovery_steps;
      `)
    } else {
      database.exec(`
        INSERT INTO recovery_steps_v5 (
          run_id, step_id, step_index, idempotency_key, action_json, action_digest,
          status, before_digest, after_digest, result_code,
          started_at, deadline_at, finished_at, version
        )
        SELECT
          run_id, step_id,
          CASE step_id
            WHEN 'authority-admission' THEN 0
            WHEN 'ledger-reconcile' THEN 1
            WHEN 'retention-maintenance' THEN 2
            WHEN 't1-effects' THEN 3
            WHEN 'regression-rollback' THEN 4
            WHEN 'incident-review' THEN 5
            WHEN 'verification' THEN 7
          END,
          'legacy:' || run_id || ':' || step_id,
          '${LEGACY_ACTION_JSON}',
          '${LEGACY_STATE_DIGEST}',
          'unknown',
          '${LEGACY_STATE_DIGEST}',
          '${LEGACY_STATE_DIGEST}',
          'legacy-v1-run',
          started_at, deadline_at, deadline_at, 1
        FROM recovery_steps;
      `)
    }
    database.exec(`
      DROP TABLE recovery_steps;
      ALTER TABLE recovery_steps_v5 RENAME TO recovery_steps;
      CREATE INDEX recovery_steps_incomplete
        ON recovery_steps(status, started_at, run_id);
    `)
  } else {
    database.exec(`
      ALTER TABLE recovery_steps_v5 RENAME TO recovery_steps;
      CREATE INDEX recovery_steps_incomplete
        ON recovery_steps(status, started_at, run_id);
    `)
  }

  database.exec('PRAGMA user_version = 5;')
}

function migrateV3ToV4(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE recovery_runtime_state ADD COLUMN bootstrap_generation
      INTEGER NOT NULL DEFAULT 0 CHECK (bootstrap_generation >= 0);
    ALTER TABLE recovery_runtime_state ADD COLUMN bootstrap_attestation_valid
      INTEGER NOT NULL DEFAULT 0 CHECK (bootstrap_attestation_valid IN (0, 1));
    ALTER TABLE recovery_runtime_state ADD COLUMN bootstrap_attestations_json
      TEXT NOT NULL DEFAULT '[]' CHECK (
        json_valid(bootstrap_attestations_json)
        AND json_type(bootstrap_attestations_json) = 'array'
        AND length(bootstrap_attestations_json) <= 131072);
    ALTER TABLE recovery_runtime_state ADD COLUMN bootstrap_attestation_set_digest
      TEXT NOT NULL DEFAULT '${EMPTY_BOOTSTRAP_ATTESTATION_SET_DIGEST}' CHECK (
        length(bootstrap_attestation_set_digest) = 64);

    -- A pre-v4 timestamp-only success cannot attest an exact activation
    -- generation. Reset it so the next service start must establish v4 proof.
    UPDATE recovery_runtime_state
      SET bootstrap_status = 'idle', bootstrap_failure_code = NULL,
          bootstrap_generation = 0, bootstrap_attestation_valid = 0,
          bootstrap_attestations_json = '[]',
          bootstrap_attestation_set_digest = '${EMPTY_BOOTSTRAP_ATTESTATION_SET_DIGEST}',
          updated_at = 0
      WHERE singleton = 1;

    PRAGMA user_version = 4;
  `)
}

function migrateV2ToV3(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE recovery_runs ADD COLUMN deadline_at INTEGER NOT NULL DEFAULT 0;
    UPDATE recovery_runs
      SET deadline_at = started_at + ${LEGACY_RUN_DEADLINE_MS};

    ALTER TABLE recovery_steps ADD COLUMN deadline_at INTEGER NOT NULL DEFAULT 0;
    UPDATE recovery_steps
      SET deadline_at = started_at + ${LEGACY_STEP_DEADLINE_MS};

    PRAGMA user_version = 3;
  `)
}

function migrateV1ToV2(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE recovery_runs ADD COLUMN activation_plan_digest TEXT NOT NULL
      DEFAULT '${LEGACY_ACTIVATION_PLAN_DIGEST}' CHECK (length(activation_plan_digest) = 64);

    CREATE TABLE recovery_runtime_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      bootstrap_status TEXT NOT NULL CHECK (
        bootstrap_status IN ('failed', 'idle', 'running', 'succeeded')),
      bootstrap_failure_code TEXT,
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      CHECK ((bootstrap_status = 'failed') = (bootstrap_failure_code IS NOT NULL))
    ) STRICT;

    INSERT INTO recovery_runtime_state (
      singleton, bootstrap_status, bootstrap_failure_code, updated_at
    ) VALUES (1, 'idle', NULL, 0);

    PRAGMA user_version = 2;
  `)
}

export function openRecoveryDatabase(path: string): DatabaseSync {
  if (!isAbsolute(path)) {
    throw new RecoveryDatabaseError('invalid-path', 'assistant-recovery databasePath must be absolute')
  }
  preparePrivateFile(path)
  const database = new DatabaseSync(path)
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = FULL;
    PRAGMA journal_mode = WAL;
  `)
  const version = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (version > recoverySchemaVersion) {
    database.close()
    throw new RecoveryDatabaseError(
      'schema-too-new',
      `recovery schema ${version} is newer than supported schema ${recoverySchemaVersion}`,
    )
  }
  if (version === 0) {
    database.exec('BEGIN IMMEDIATE')
    try {
      createSchema(database)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      database.close()
      throw error
    }
  } else if (version < recoverySchemaVersion) {
    database.exec('BEGIN IMMEDIATE')
    try {
      if (version === 1) migrateV1ToV2(database)
      if (version <= 2) migrateV2ToV3(database)
      if (version <= 3) migrateV3ToV4(database)
      if (version <= 4) migrateV4ToV5(database)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      database.close()
      throw error
    }
  }
  chmodSync(path, 0o600)
  return database
}
