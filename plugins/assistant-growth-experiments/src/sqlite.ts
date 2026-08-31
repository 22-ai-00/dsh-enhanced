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

export const growthExperimentsSchemaVersion = 2

export class GrowthExperimentsDatabaseError extends Error {
  constructor(
    readonly code: 'invalid-path' | 'schema-too-new' | 'unsafe-file',
    message: string,
  ) {
    super(message)
    this.name = 'GrowthExperimentsDatabaseError'
  }
}

function assertSafeFile(path: string): void {
  const stat = lstatSync(path)
  const uid = process.getuid?.()
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid)) {
    throw new GrowthExperimentsDatabaseError(
      'unsafe-file',
      'assistant-growth-experiments database must be one private regular file owned by this OS user',
    )
  }
}

function preparePrivateFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (!existsSync(path)) {
    const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600)
    closeSync(descriptor)
  }
  chmodSync(path, 0o600)
  assertSafeFile(path)
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE workflow_trace_revisions (
      scope_key TEXT NOT NULL,
      source_id TEXT NOT NULL CHECK (source_id = 'assistantDelivery'),
      source_generation INTEGER NOT NULL CHECK (source_generation >= 1),
      source_authority_digest TEXT NOT NULL CHECK (length(source_authority_digest) = 64),
      workspace TEXT NOT NULL,
      preset TEXT NOT NULL,
      subject_ref TEXT NOT NULL CHECK (length(subject_ref) = 64),
      version INTEGER NOT NULL CHECK (version >= 1),
      digest TEXT NOT NULL CHECK (length(digest) = 64),
      disposition TEXT NOT NULL CHECK (disposition IN ('upsert', 'retract')),
      signature TEXT CHECK (signature IS NULL OR length(signature) = 64),
      evidence_json TEXT CHECK (
        evidence_json IS NULL OR (
          json_valid(evidence_json) AND json_type(evidence_json) = 'object'
          AND length(evidence_json) <= 65536
        )
      ),
      received_at INTEGER NOT NULL CHECK (received_at >= 0),
      PRIMARY KEY(scope_key, subject_ref, version),
      CHECK ((disposition = 'upsert') = (signature IS NOT NULL AND evidence_json IS NOT NULL))
    ) STRICT, WITHOUT ROWID;

    CREATE INDEX workflow_trace_revision_latest
      ON workflow_trace_revisions(scope_key, subject_ref, version DESC);

    CREATE TABLE workflow_trace_current (
      scope_key TEXT NOT NULL,
      source_id TEXT NOT NULL CHECK (source_id = 'assistantDelivery'),
      source_generation INTEGER NOT NULL CHECK (source_generation >= 1),
      source_authority_digest TEXT NOT NULL CHECK (length(source_authority_digest) = 64),
      workspace TEXT NOT NULL,
      preset TEXT NOT NULL,
      subject_ref TEXT NOT NULL CHECK (length(subject_ref) = 64),
      version INTEGER NOT NULL CHECK (version >= 1),
      digest TEXT NOT NULL CHECK (length(digest) = 64),
      signature TEXT NOT NULL CHECK (length(signature) = 64),
      evidence_json TEXT NOT NULL CHECK (
        json_valid(evidence_json) AND json_type(evidence_json) = 'object'
        AND length(evidence_json) <= 65536
      ),
      PRIMARY KEY(scope_key, subject_ref)
    ) STRICT, WITHOUT ROWID;

    CREATE INDEX workflow_trace_current_signature
      ON workflow_trace_current(scope_key, signature, subject_ref);

    CREATE TABLE workflow_candidates (
      id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      workspace TEXT NOT NULL,
      preset TEXT NOT NULL,
      owner_binding_id TEXT NOT NULL,
      signature TEXT NOT NULL CHECK (length(signature) = 64),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64),
      evidence_count INTEGER NOT NULL CHECK (evidence_count >= 0),
      owner_explicit_count INTEGER NOT NULL CHECK (owner_explicit_count >= 0),
      verified_success_count INTEGER NOT NULL CHECK (verified_success_count >= 0),
      template_json TEXT NOT NULL CHECK (
        json_valid(template_json) AND json_type(template_json) = 'object'
        AND length(template_json) <= 32768
      ),
      steps_json TEXT NOT NULL CHECK (
        json_valid(steps_json) AND json_type(steps_json) = 'array'
        AND length(steps_json) <= 32768
      ),
      state TEXT NOT NULL CHECK (state IN (
        'conflicted', 'observing', 'promoted', 'ready', 'rejected',
        'retracted', 'rolled-back', 'running'
      )),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
      UNIQUE(scope_key, signature)
    ) STRICT;

    CREATE INDEX workflow_candidates_ready
      ON workflow_candidates(state, updated_at, id);

    CREATE TABLE growth_experiments (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      candidate_revision INTEGER NOT NULL CHECK (candidate_revision >= 1),
      candidate_digest TEXT NOT NULL CHECK (length(candidate_digest) = 64),
      candidate_json TEXT NOT NULL CHECK (
        json_valid(candidate_json) AND json_type(candidate_json) = 'object'
        AND length(candidate_json) <= 65536
      ),
      state TEXT NOT NULL CHECK (state IN (
        'approval-pending', 'approval-requesting', 'canary-pending', 'conflicted',
        'expired', 'promoted', 'promotion-pending', 'rejected', 'replay-pending',
        'rollback-pending', 'rolled-back', 'shadow-pending'
      )),
      version INTEGER NOT NULL CHECK (version >= 1),
      operation_id TEXT NOT NULL UNIQUE,
      operation_kind TEXT CHECK (operation_kind IS NULL OR operation_kind IN (
        'approval-proposal', 'approval-settlement', 'canary', 'canary-inspection', 'promotion',
        'replay', 'rollback', 'shadow'
      )),
      deadline_at INTEGER NOT NULL CHECK (deadline_at >= 0),
      canary_exposure_count INTEGER NOT NULL CHECK (canary_exposure_count BETWEEN 0 AND 1),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at INTEGER NOT NULL DEFAULT 0 CHECK (next_attempt_at >= 0),
      proposal_id TEXT,
      artifact_id TEXT,
      artifact_version INTEGER CHECK (artifact_version IS NULL OR artifact_version >= 1),
      artifact_digest TEXT CHECK (artifact_digest IS NULL OR length(artifact_digest) = 64),
      terminal_code TEXT,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
      FOREIGN KEY(candidate_id) REFERENCES workflow_candidates(id) ON DELETE RESTRICT,
      CHECK (
        (artifact_id IS NULL AND artifact_version IS NULL AND artifact_digest IS NULL)
        OR (artifact_id IS NOT NULL AND artifact_version IS NOT NULL AND artifact_digest IS NOT NULL)
      ),
      CHECK (state NOT IN (
        'replay-pending', 'shadow-pending', 'canary-pending', 'promotion-pending',
        'rollback-pending', 'promoted', 'rolled-back'
      ) OR artifact_id IS NOT NULL),
      CHECK (state != 'approval-pending' OR proposal_id IS NOT NULL),
      CHECK (operation_kind != 'approval-settlement' OR proposal_id IS NOT NULL),
      CHECK (operation_kind != 'canary-inspection' OR canary_exposure_count = 1),
      CHECK (state != 'promoted' OR canary_exposure_count = 1),
      CHECK (
        (state = 'approval-requesting' AND operation_kind IN ('approval-proposal', 'approval-settlement'))
        OR (state = 'replay-pending' AND operation_kind = 'replay')
        OR (state = 'shadow-pending' AND operation_kind = 'shadow')
        OR (state = 'canary-pending' AND operation_kind IN ('canary', 'canary-inspection'))
        OR (state = 'promotion-pending' AND operation_kind = 'promotion')
        OR (state = 'rollback-pending' AND operation_kind = 'rollback')
        OR (state IN ('conflicted', 'expired', 'promoted', 'rejected', 'rolled-back') AND operation_kind IS NULL)
        OR state = 'approval-pending'
      )
    ) STRICT;

    CREATE INDEX growth_experiments_active
      ON growth_experiments(state, updated_at, id);
    CREATE INDEX growth_experiments_candidate
      ON growth_experiments(candidate_id, created_at DESC, id DESC);

    CREATE TABLE growth_runtime_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      last_error_code TEXT,
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
    ) STRICT;
    INSERT INTO growth_runtime_state(singleton, last_error_code, updated_at) VALUES (1, NULL, 0);

    PRAGMA user_version = 2;
  `)
}

export function openGrowthExperimentsDatabase(path: string): DatabaseSync {
  if (!isAbsolute(path)) {
    throw new GrowthExperimentsDatabaseError(
      'invalid-path',
      'assistant-growth-experiments databasePath must be absolute',
    )
  }
  preparePrivateFile(path)
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: true })
  try {
    database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;')
    const row = database.prepare('PRAGMA user_version').get() as { user_version: number }
    if (row.user_version > growthExperimentsSchemaVersion) {
      throw new GrowthExperimentsDatabaseError(
        'schema-too-new',
        `assistant-growth-experiments schema ${row.user_version} is newer than supported ${growthExperimentsSchemaVersion}`,
      )
    }
    if (row.user_version === 0) createSchema(database)
    if (row.user_version === 1) {
      // v1 was an unreleased prototype that stored raw prompt-bearing
      // templates. It cannot be upgraded without preserving data that violates
      // the content-free Growth boundary, so fail closed and require an
      // operator to archive/remove that prototype database explicitly.
      throw new GrowthExperimentsDatabaseError(
        'schema-too-new',
        'assistant-growth-experiments schema 1 contains legacy prompt-bearing templates and is not safely migratable',
      )
    }
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
