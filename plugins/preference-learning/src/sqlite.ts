import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const preferenceSchemaVersion = 9

export type PreferenceDatabaseErrorCode = 'invalid-path' | 'unsafe-file' | 'schema-too-new'

export class PreferenceDatabaseError extends Error {
  constructor(readonly code: PreferenceDatabaseErrorCode, message: string) {
    super(message)
    this.name = 'PreferenceDatabaseError'
  }
}

function assertSafeFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new PreferenceDatabaseError('unsafe-file', 'preference database must be one regular, unlinked file')
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new PreferenceDatabaseError('unsafe-file', 'preference database permissions must not allow group or other access')
  }
  const uid = process.getuid?.()
  if (uid !== undefined && stat.uid !== uid) {
    throw new PreferenceDatabaseError('unsafe-file', 'preference database must be owned by the current OS user')
  }
}

function preparePrivateFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600)
    closeSync(descriptor)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  }
  assertSafeFile(path)
}

function userVersion(database: DatabaseSync): number {
  return (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function migrate(database: DatabaseSync): void {
  let transactionStarted = false
  try {
    database.exec('BEGIN IMMEDIATE')
    transactionStarted = true

    // The version must be read while holding the write reservation. Another process may
    // have completed the same migration while this connection was waiting for the lock.
    const current = userVersion(database)
    if (current > preferenceSchemaVersion) {
      throw new PreferenceDatabaseError(
        'schema-too-new',
        `preference schema ${current} is newer than supported schema ${preferenceSchemaVersion}`,
      )
    }
    if (current === preferenceSchemaVersion) {
      database.exec('COMMIT')
      transactionStarted = false
      return
    }

    if (current < 1) database.exec(`
      CREATE TABLE preference_schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE preference_signals (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload_hash TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        workspace TEXT NOT NULL,
        preset TEXT NOT NULL,
        preference_key TEXT NOT NULL,
        candidate_value TEXT NOT NULL,
        risk_tier TEXT NOT NULL CHECK (risk_tier IN ('T0', 'T1', 'T2', 'T3')),
        stance TEXT NOT NULL CHECK (stance IN ('support', 'contradict')),
        actor_trust TEXT NOT NULL CHECK (actor_trust IN (
          'owner-authenticated', 'delegated-authenticated', 'system-attested', 'unverified'
        )),
        interpretation_trust TEXT NOT NULL CHECK (interpretation_trust IN (
          'explicit-selection', 'typed-feedback', 'behavioral-inference', 'model-inference'
        )),
        source TEXT NOT NULL CHECK (source IN (
          'direct-owner-feedback', 'signed-ui-feedback', 'delivery-observation',
          'evaluation-outcome', 'system-observation'
        )),
        occurred_at INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX preference_signals_scope_key_time
        ON preference_signals(scope_key, preference_key, occurred_at DESC, id DESC);

      CREATE TABLE preference_hypotheses (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        workspace TEXT NOT NULL,
        preset TEXT NOT NULL,
        preference_key TEXT NOT NULL,
        candidate_value TEXT NOT NULL,
        risk_tier TEXT NOT NULL CHECK (risk_tier IN ('T1', 'T2')),
        claim_state TEXT NOT NULL CHECK (claim_state IN (
          'tentative', 'proposed', 'confirmed', 'rejected', 'expired'
        )),
        effect_state TEXT NOT NULL CHECK (effect_state IN (
          'shadow', 'active', 'suppressed', 'rolled-back', 'inactive'
        )),
        confidence_bps INTEGER NOT NULL,
        contradiction_bps INTEGER NOT NULL,
        supporting_signals INTEGER NOT NULL,
        contradicting_signals INTEGER NOT NULL,
        evidence_mass INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        activated_at INTEGER,
        rolled_back_at INTEGER,
        version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(scope_key, preference_key, candidate_value)
      ) STRICT;
      CREATE INDEX preference_hypotheses_scope_state
        ON preference_hypotheses(scope_key, effect_state, updated_at DESC, id DESC);
      CREATE UNIQUE INDEX preference_hypotheses_one_active_key
        ON preference_hypotheses(scope_key, preference_key) WHERE effect_state = 'active';

      CREATE TABLE preference_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hypothesis_id TEXT NOT NULL,
        from_claim_state TEXT,
        to_claim_state TEXT NOT NULL,
        from_effect_state TEXT,
        to_effect_state TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN (
          'created', 'evidence-updated', 'activated', 'owner-rejected', 'contradicted',
          'regression', 'expired', 'superseded', 'operator-request'
        )),
        version INTEGER NOT NULL,
        occurred_at INTEGER NOT NULL,
        FOREIGN KEY (hypothesis_id) REFERENCES preference_hypotheses(id) ON DELETE RESTRICT
      ) STRICT;
      CREATE INDEX preference_transitions_hypothesis
        ON preference_transitions(hypothesis_id, version DESC, id DESC);

      CREATE TABLE preference_scope_tombstones (
        id TEXT PRIMARY KEY,
        scope_digest TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload_hash TEXT NOT NULL,
        forgotten_through INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL,
        deleted_signals INTEGER NOT NULL,
        deleted_hypotheses INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX preference_scope_tombstones_scope
        ON preference_scope_tombstones(scope_digest, forgotten_through DESC, id DESC);

      INSERT INTO preference_schema_meta(key, value) VALUES ('schema-version', '1');
      PRAGMA user_version = 1;
    `)
    if (current < 2) database.exec(`
      CREATE TABLE preference_host_maintenance_receipts (
        idempotency_key TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        scope_digest TEXT NOT NULL,
        deleted_signals INTEGER NOT NULL CHECK (deleted_signals IN (0, 1)),
        occurred_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX preference_host_maintenance_scope_time
        ON preference_host_maintenance_receipts(scope_digest, occurred_at DESC, idempotency_key);
      UPDATE preference_schema_meta SET value = '2' WHERE key = 'schema-version';
      PRAGMA user_version = 2;
    `)
    if (current < 3) database.exec(`
      CREATE TABLE preference_host_activation_receipts (
        idempotency_key TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        scope_digest TEXT NOT NULL,
        hypothesis_id TEXT NOT NULL,
        expected_version INTEGER NOT NULL CHECK (expected_version >= 1),
        result_version INTEGER NOT NULL CHECK (result_version = expected_version + 1),
        occurred_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX preference_host_activation_scope_time
        ON preference_host_activation_receipts(scope_digest, occurred_at DESC, idempotency_key);
      UPDATE preference_schema_meta SET value = '3' WHERE key = 'schema-version';
      PRAGMA user_version = 3;
    `)
    if (current < 4) database.exec(`
      CREATE TABLE preference_exposures (
        idempotency_key TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        workspace TEXT NOT NULL,
        preset TEXT NOT NULL,
        hypothesis_id TEXT NOT NULL,
        hypothesis_version INTEGER NOT NULL CHECK (hypothesis_version >= 1),
        session_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        source_inbox_id TEXT,
        reply_outbox_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'bound')),
        exposed_at INTEGER NOT NULL,
        bound_at INTEGER,
        expires_at INTEGER NOT NULL,
        CHECK ((state = 'pending' AND source_inbox_id IS NULL AND reply_outbox_id IS NULL AND bound_at IS NULL)
          OR (state = 'bound' AND source_inbox_id IS NOT NULL AND reply_outbox_id IS NOT NULL AND bound_at IS NOT NULL))
      ) STRICT;
      CREATE INDEX preference_exposures_turn
        ON preference_exposures(scope_key, session_id, source_event_id, state, hypothesis_id);
      CREATE INDEX preference_exposures_outbox
        ON preference_exposures(scope_key, reply_outbox_id, state, hypothesis_id);
      CREATE INDEX preference_exposures_expiry
        ON preference_exposures(expires_at, idempotency_key);
      CREATE TABLE preference_exposure_corrections (
        signal_id TEXT NOT NULL,
        hypothesis_id TEXT NOT NULL,
        hypothesis_version INTEGER NOT NULL CHECK (hypothesis_version >= 1),
        source_inbox_id TEXT NOT NULL,
        reply_outbox_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        PRIMARY KEY (signal_id, hypothesis_id, hypothesis_version)
      ) STRICT;
      CREATE INDEX preference_exposure_corrections_target
        ON preference_exposure_corrections(reply_outbox_id, hypothesis_id, occurred_at);
      UPDATE preference_schema_meta SET value = '4' WHERE key = 'schema-version';
      PRAGMA user_version = 4;
    `)
    if (current < 5) database.exec(`
      CREATE TABLE preference_scope_principals (
        scope_key TEXT PRIMARY KEY,
        scope_digest TEXT NOT NULL,
        principal_digest TEXT NOT NULL CHECK (
          length(principal_digest) = 64 AND principal_digest NOT GLOB '*[^a-f0-9]*'
        ),
        generation INTEGER NOT NULL CHECK (generation >= 1),
        claimed_at INTEGER NOT NULL,
        purge_pending INTEGER NOT NULL CHECK (purge_pending IN (0, 1)),
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX preference_scope_principals_digest
        ON preference_scope_principals(scope_digest, principal_digest);
      UPDATE preference_schema_meta SET value = '5' WHERE key = 'schema-version';
      PRAGMA user_version = 5;
    `)
    if (current < 6) database.exec(`
      ALTER TABLE preference_scope_principals
        ADD COLUMN principal_lineage_id TEXT;
      ALTER TABLE preference_scope_principals
        ADD COLUMN principal_lineage_version INTEGER;
      ALTER TABLE preference_scope_principals
        ADD COLUMN learning_paused INTEGER NOT NULL DEFAULT 0
        CHECK (learning_paused IN (0, 1));
      ALTER TABLE preference_scope_principals
        ADD COLUMN paused_at INTEGER;
      ALTER TABLE preference_scope_principals
        ADD COLUMN control_version INTEGER NOT NULL DEFAULT 1 CHECK (control_version >= 1);
      ALTER TABLE preference_scope_principals
        ADD COLUMN ignore_events_through INTEGER NOT NULL DEFAULT -1 CHECK (ignore_events_through >= -1);
      ALTER TABLE preference_host_activation_receipts
        ADD COLUMN owner_generation INTEGER;
      ALTER TABLE preference_host_activation_receipts
        ADD COLUMN principal_lineage_id TEXT;
      ALTER TABLE preference_host_activation_receipts
        ADD COLUMN principal_lineage_version INTEGER;
      ALTER TABLE preference_host_maintenance_receipts
        ADD COLUMN owner_generation INTEGER;
      ALTER TABLE preference_host_maintenance_receipts
        ADD COLUMN principal_lineage_id TEXT;
      ALTER TABLE preference_host_maintenance_receipts
        ADD COLUMN principal_lineage_version INTEGER;
      CREATE TABLE preference_owner_control_receipts (
        idempotency_key TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        scope_digest TEXT NOT NULL,
        principal_digest TEXT NOT NULL CHECK (
          length(principal_digest) = 64 AND principal_digest NOT GLOB '*[^a-f0-9]*'
        ),
        generation INTEGER NOT NULL CHECK (generation >= 1),
        action TEXT NOT NULL CHECK (action IN ('pause', 'resume')),
        result_paused INTEGER NOT NULL CHECK (result_paused IN (0, 1)),
        result_control_version INTEGER NOT NULL CHECK (result_control_version >= 1),
        result_ignore_events_through INTEGER NOT NULL CHECK (result_ignore_events_through >= -1),
        occurred_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX preference_owner_control_scope_time
        ON preference_owner_control_receipts(scope_digest, occurred_at DESC, idempotency_key);
      UPDATE preference_schema_meta SET value = '6' WHERE key = 'schema-version';
      PRAGMA user_version = 6;
    `)
    if (current < 7) database.exec(`
      ALTER TABLE preference_scope_principals
        ADD COLUMN admission_cursor_epoch TEXT;
      ALTER TABLE preference_scope_principals
        ADD COLUMN lineage_claim_sequence INTEGER
        CHECK (lineage_claim_sequence IS NULL OR lineage_claim_sequence >= 1);
      ALTER TABLE preference_scope_principals
        ADD COLUMN admission_high_water INTEGER
        CHECK (admission_high_water IS NULL OR admission_high_water >= 1);
      ALTER TABLE preference_scope_principals
        ADD COLUMN admission_high_water_kind TEXT
        CHECK (admission_high_water_kind IN ('control', 'event'));
      ALTER TABLE preference_scope_principals
        ADD COLUMN ignore_events_through_sequence INTEGER
        CHECK (ignore_events_through_sequence IS NULL OR ignore_events_through_sequence >= 1);

      -- v6 control receipts were ordered only by millisecond timestamps and
      -- cannot safely participate in the v7 total order. Drop them instead of
      -- inventing cursors during a rolling upgrade.
      DROP TABLE preference_owner_control_receipts;
      CREATE TABLE preference_owner_control_receipts (
        idempotency_key TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        scope_digest TEXT NOT NULL,
        principal_digest TEXT NOT NULL CHECK (
          length(principal_digest) = 64 AND principal_digest NOT GLOB '*[^a-f0-9]*'
        ),
        generation INTEGER NOT NULL CHECK (generation >= 1),
        action TEXT NOT NULL CHECK (action IN ('forget', 'pause', 'resume', 'status')),
        admission_cursor_epoch TEXT NOT NULL,
        admission_cursor_sequence INTEGER NOT NULL CHECK (admission_cursor_sequence >= 1),
        result_applied INTEGER NOT NULL CHECK (result_applied IN (0, 1)),
        result_paused INTEGER NOT NULL CHECK (result_paused IN (0, 1)),
        result_control_version INTEGER NOT NULL CHECK (result_control_version >= 1),
        result_admission_high_water INTEGER
          CHECK (result_admission_high_water IS NULL OR result_admission_high_water >= 1),
        result_ignore_events_through_sequence INTEGER
          CHECK (result_ignore_events_through_sequence IS NULL
            OR result_ignore_events_through_sequence >= 1),
        result_signals INTEGER NOT NULL CHECK (result_signals >= 0),
        result_hypotheses INTEGER NOT NULL CHECK (result_hypotheses >= 0),
        result_active_overlays INTEGER NOT NULL CHECK (result_active_overlays >= 0),
        result_shadow_hypotheses INTEGER NOT NULL CHECK (result_shadow_hypotheses >= 0),
        result_deleted_signals INTEGER NOT NULL DEFAULT 0 CHECK (result_deleted_signals >= 0),
        result_deleted_hypotheses INTEGER NOT NULL DEFAULT 0 CHECK (result_deleted_hypotheses >= 0),
        result_forgotten_through INTEGER NOT NULL DEFAULT -1 CHECK (result_forgotten_through >= -1),
        occurred_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX preference_owner_control_scope_time
        ON preference_owner_control_receipts(
          scope_digest, admission_cursor_epoch, admission_cursor_sequence DESC, idempotency_key
        );
      UPDATE preference_schema_meta SET value = '7' WHERE key = 'schema-version';
      PRAGMA user_version = 7;
    `)
    if (current < 8) database.exec(`
      ALTER TABLE preference_owner_control_receipts
        RENAME TO preference_owner_control_receipts_v7;
      DROP INDEX preference_owner_control_scope_time;
      CREATE TABLE preference_owner_control_receipts (
        idempotency_key TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        scope_digest TEXT NOT NULL,
        principal_digest TEXT NOT NULL CHECK (
          length(principal_digest) = 64 AND principal_digest NOT GLOB '*[^a-f0-9]*'
        ),
        generation INTEGER NOT NULL CHECK (generation >= 1),
        action TEXT NOT NULL CHECK (action IN (
          'explain', 'forget', 'pause', 'resume', 'rollback', 'status'
        )),
        target_preference_key TEXT,
        admission_cursor_epoch TEXT NOT NULL,
        admission_cursor_sequence INTEGER NOT NULL CHECK (admission_cursor_sequence >= 1),
        result_applied INTEGER NOT NULL CHECK (result_applied IN (0, 1)),
        result_paused INTEGER NOT NULL CHECK (result_paused IN (0, 1)),
        result_control_version INTEGER NOT NULL CHECK (result_control_version >= 1),
        result_admission_high_water INTEGER
          CHECK (result_admission_high_water IS NULL OR result_admission_high_water >= 1),
        result_ignore_events_through_sequence INTEGER
          CHECK (result_ignore_events_through_sequence IS NULL
            OR result_ignore_events_through_sequence >= 1),
        result_signals INTEGER NOT NULL CHECK (result_signals >= 0),
        result_hypotheses INTEGER NOT NULL CHECK (result_hypotheses >= 0),
        result_active_overlays INTEGER NOT NULL CHECK (result_active_overlays >= 0),
        result_stored_active_overlays INTEGER NOT NULL DEFAULT 0
          CHECK (result_stored_active_overlays >= 0),
        result_shadow_hypotheses INTEGER NOT NULL CHECK (result_shadow_hypotheses >= 0),
        result_deleted_signals INTEGER NOT NULL DEFAULT 0 CHECK (result_deleted_signals >= 0),
        result_deleted_hypotheses INTEGER NOT NULL DEFAULT 0 CHECK (result_deleted_hypotheses >= 0),
        result_forgotten_through INTEGER NOT NULL DEFAULT -1 CHECK (result_forgotten_through >= -1),
        result_explanation_json TEXT,
        result_rolled_back INTEGER NOT NULL DEFAULT 0 CHECK (result_rolled_back IN (0, 1)),
        result_rolled_back_version INTEGER
          CHECK (result_rolled_back_version IS NULL OR result_rolled_back_version >= 2),
        occurred_at INTEGER NOT NULL,
        CHECK ((action = 'rollback' AND target_preference_key IS NOT NULL)
          OR (action != 'rollback' AND target_preference_key IS NULL)),
        CHECK ((action = 'explain' AND result_explanation_json IS NOT NULL)
          OR (action != 'explain' AND result_explanation_json IS NULL)),
        CHECK (result_rolled_back = 0 OR action = 'rollback')
      ) STRICT;
      INSERT INTO preference_owner_control_receipts(
        idempotency_key, payload_hash, scope_digest, principal_digest, generation,
        action, admission_cursor_epoch, admission_cursor_sequence, result_applied,
        result_paused, result_control_version, result_admission_high_water,
        result_ignore_events_through_sequence, result_signals, result_hypotheses,
        result_active_overlays, result_stored_active_overlays, result_shadow_hypotheses,
        result_deleted_signals, result_deleted_hypotheses,
        result_forgotten_through, occurred_at
      )
      SELECT idempotency_key, payload_hash, scope_digest, principal_digest, generation,
        action, admission_cursor_epoch, admission_cursor_sequence, result_applied,
        result_paused, result_control_version, result_admission_high_water,
        result_ignore_events_through_sequence, result_signals, result_hypotheses,
        result_active_overlays, result_active_overlays, result_shadow_hypotheses,
        result_deleted_signals, result_deleted_hypotheses,
        result_forgotten_through, occurred_at
      FROM preference_owner_control_receipts_v7;
      DROP TABLE preference_owner_control_receipts_v7;
      CREATE INDEX preference_owner_control_scope_time
        ON preference_owner_control_receipts(
          scope_digest, admission_cursor_epoch, admission_cursor_sequence DESC, idempotency_key
        );
      UPDATE preference_schema_meta SET value = '8' WHERE key = 'schema-version';
      PRAGMA user_version = 8;
    `)
    if (current < 9) database.exec(`
      ALTER TABLE preference_owner_control_receipts
        RENAME TO preference_owner_control_receipts_v8;
      DROP INDEX preference_owner_control_scope_time;
      CREATE TABLE preference_owner_control_receipts (
        idempotency_key TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        scope_digest TEXT NOT NULL,
        principal_digest TEXT NOT NULL CHECK (
          length(principal_digest) = 64 AND principal_digest NOT GLOB '*[^a-f0-9]*'
        ),
        generation INTEGER NOT NULL CHECK (generation >= 1),
        action TEXT NOT NULL CHECK (action IN (
          'explain', 'export', 'forget', 'pause', 'resume', 'rollback', 'status'
        )),
        target_preference_key TEXT,
        admission_cursor_epoch TEXT NOT NULL,
        admission_cursor_sequence INTEGER NOT NULL CHECK (admission_cursor_sequence >= 1),
        result_applied INTEGER NOT NULL CHECK (result_applied IN (0, 1)),
        result_paused INTEGER NOT NULL CHECK (result_paused IN (0, 1)),
        result_control_version INTEGER NOT NULL CHECK (result_control_version >= 1),
        result_admission_high_water INTEGER
          CHECK (result_admission_high_water IS NULL OR result_admission_high_water >= 1),
        result_ignore_events_through_sequence INTEGER
          CHECK (result_ignore_events_through_sequence IS NULL
            OR result_ignore_events_through_sequence >= 1),
        result_signals INTEGER NOT NULL CHECK (result_signals >= 0),
        result_hypotheses INTEGER NOT NULL CHECK (result_hypotheses >= 0),
        result_active_overlays INTEGER NOT NULL CHECK (result_active_overlays >= 0),
        result_stored_active_overlays INTEGER NOT NULL DEFAULT 0
          CHECK (result_stored_active_overlays >= 0),
        result_shadow_hypotheses INTEGER NOT NULL CHECK (result_shadow_hypotheses >= 0),
        result_deleted_signals INTEGER NOT NULL DEFAULT 0 CHECK (result_deleted_signals >= 0),
        result_deleted_hypotheses INTEGER NOT NULL DEFAULT 0 CHECK (result_deleted_hypotheses >= 0),
        result_forgotten_through INTEGER NOT NULL DEFAULT -1 CHECK (result_forgotten_through >= -1),
        result_explanation_json TEXT,
        result_rolled_back INTEGER NOT NULL DEFAULT 0 CHECK (result_rolled_back IN (0, 1)),
        result_rolled_back_version INTEGER
          CHECK (result_rolled_back_version IS NULL OR result_rolled_back_version >= 2),
        occurred_at INTEGER NOT NULL,
        CHECK ((action = 'rollback' AND target_preference_key IS NOT NULL)
          OR (action != 'rollback' AND target_preference_key IS NULL)),
        CHECK ((action IN ('explain', 'export') AND result_explanation_json IS NOT NULL)
          OR (action NOT IN ('explain', 'export') AND result_explanation_json IS NULL)),
        CHECK (result_rolled_back = 0 OR action = 'rollback')
      ) STRICT;
      INSERT INTO preference_owner_control_receipts(
        idempotency_key, payload_hash, scope_digest, principal_digest, generation,
        action, target_preference_key, admission_cursor_epoch, admission_cursor_sequence,
        result_applied, result_paused, result_control_version, result_admission_high_water,
        result_ignore_events_through_sequence, result_signals, result_hypotheses,
        result_active_overlays, result_stored_active_overlays, result_shadow_hypotheses,
        result_deleted_signals, result_deleted_hypotheses, result_forgotten_through,
        result_explanation_json, result_rolled_back, result_rolled_back_version, occurred_at
      )
      SELECT idempotency_key, payload_hash, scope_digest, principal_digest, generation,
        action, target_preference_key, admission_cursor_epoch, admission_cursor_sequence,
        result_applied, result_paused, result_control_version, result_admission_high_water,
        result_ignore_events_through_sequence, result_signals, result_hypotheses,
        result_active_overlays, result_stored_active_overlays, result_shadow_hypotheses,
        result_deleted_signals, result_deleted_hypotheses, result_forgotten_through,
        result_explanation_json, result_rolled_back, result_rolled_back_version, occurred_at
      FROM preference_owner_control_receipts_v8;
      DROP TABLE preference_owner_control_receipts_v8;
      CREATE INDEX preference_owner_control_scope_time
        ON preference_owner_control_receipts(
          scope_digest, admission_cursor_epoch, admission_cursor_sequence DESC, idempotency_key
        );
      UPDATE preference_schema_meta SET value = '9' WHERE key = 'schema-version';
      PRAGMA user_version = 9;
    `)
    database.exec('COMMIT')
    transactionStarted = false
  } catch (error) {
    if (transactionStarted) {
      try {
        database.exec('ROLLBACK')
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'preference schema migration and rollback failed')
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
        throw new Error(`preference database refused WAL mode: ${row.journal_mode}`)
      }
      return
    } catch (error) {
      const retryable = error instanceof Error && /database is (?:busy|locked)/i.test(error.message)
      if (!retryable || Date.now() >= deadline) throw error
      Atomics.wait(walRetryWait, 0, 0, 10)
    }
  }
}

export function openPreferenceDatabase(path: string): DatabaseSync {
  if (path !== ':memory:' && !isAbsolute(path)) {
    throw new PreferenceDatabaseError('invalid-path', 'preference database path must be absolute')
  }
  if (path !== ':memory:') preparePrivateFile(path)
  const database = new DatabaseSync(path)
  try {
    database.exec('PRAGMA foreign_keys = ON')
    database.exec('PRAGMA busy_timeout = 5000')
    database.exec('PRAGMA synchronous = FULL')
    database.exec('PRAGMA secure_delete = ON')
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
