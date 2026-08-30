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

export const preferenceSchemaVersion = 1

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

    database.exec(`
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
