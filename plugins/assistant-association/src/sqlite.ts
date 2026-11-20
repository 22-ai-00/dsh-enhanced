import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ensureClusteringSchema } from './clustering.js'
import { ensureDreamingSchema } from './dreaming.js'
import { ensureEvalPoolSchema } from './eval-pool.js'
import { ensureIntakeSignalSchema } from './intake-signal.js'
import {
  computeDeterministicEdgeId,
  computeDeterministicSynonymId,
  DEFAULT_HEBBIAN_CONFIG,
  type ApplyHebbianCorrectionInput,
  type ApplyHebbianCorrectionResult,
  type ApplyHebbianDecayInput,
  type ApplyHebbianDecayResult,
  type ApplyHebbianUseInput,
  type ApplyHebbianUseResult,
  type AssocReadEventInput,
  type AssocReplayEpisodeInput,
  type AssociationNodeMetadata,
  type AssociationNodeStatus,
  type AssociationOwnerMode,
  type AssociationOwnerScope,
  type AssociationScopeMode,
  type AssociationSensitivity,
  type AssociationTrust,
  type AssocTaskTelemetryInput,
  type DerivedRefInput,
  type EdgeType,
  type ExposureRow,
  type HoldoutAssignmentRow,
  type HoldoutTaskKind,
  type IngestCursorRow,
  type NodeKind,
  type ProvenanceEdgeRef,
  type StepMetricRow,
  type StoredAssociationEdge,
  type StoredAssociationNode,
  type StoredAssociationSynonym,
  type StoredExposureRow,
  type UpsertEdgeInput,
  type UpsertNodeInput,
  type UpsertSynonymInput,
} from './types.js'

export const ASSOCIATION_SCHEMA_VERSION = 4

export type AssociationDatabaseErrorCode =
  | 'invalid-path'
  | 'unsafe-file'
  | 'schema-too-new'
  | 'schema-drift'

export class AssociationDatabaseError extends Error {
  constructor(
    readonly code: AssociationDatabaseErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AssociationDatabaseError'
  }
}

export function assertSafePrivateFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new AssociationDatabaseError(
      'unsafe-file',
      'association database must be one regular, unlinked file',
    )
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new AssociationDatabaseError(
      'unsafe-file',
      'association database permissions must not allow group or other access',
    )
  }
  const uid = process.getuid?.()
  if (uid !== undefined && stat.uid !== uid) {
    throw new AssociationDatabaseError(
      'unsafe-file',
      'association database must be owned by the current OS user',
    )
  }
}

function preparePrivateFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600)
    closeSync(fd)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  }
  assertSafePrivateFile(path)
  for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
    try {
      assertSafePrivateFile(sidecar)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }
}

const walRetryWait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))

function enableWal(database: DatabaseSync): void {
  const deadline = Date.now() + 5_000
  while (true) {
    try {
      const row = database.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode: string }
      if (row.journal_mode.toLowerCase() !== 'wal') {
        throw new Error(`association database refused WAL mode: ${row.journal_mode}`)
      }
      return
    } catch (error) {
      const retryable = error instanceof Error && /database is (?:busy|locked)/i.test(error.message)
      if (!retryable || Date.now() >= deadline) throw error
      Atomics.wait(walRetryWait, 0, 0, 10)
    }
  }
}

function createV1Schema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    INSERT INTO schema_meta(key, value) VALUES ('schema-version', '1');

    CREATE TABLE assoc_nodes (
      id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
      kind TEXT NOT NULL CHECK (kind IN (
        'memory', 'goal', 'work-item', 'automation', 'episode',
        'wiki', 'skill', 'event', 'dream', 'abstraction', 'web'
      )),
      source_plugin TEXT NOT NULL CHECK (length(source_plugin) BETWEEN 1 AND 64),
      source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 512),
      source_version INTEGER NOT NULL CHECK (source_version >= 0),
      owner_scope_key TEXT NOT NULL CHECK (length(owner_scope_key) = 64 AND owner_scope_key NOT GLOB '*[^0-9a-f]*'),
      owner_mode TEXT NOT NULL CHECK (owner_mode IN ('delivery', 'headless', 'system')),
      principal_digest TEXT CHECK (principal_digest IS NULL OR (length(principal_digest) = 64 AND principal_digest NOT GLOB '*[^0-9a-f]*')),
      principal_record_id TEXT,
      principal_version INTEGER CHECK (principal_version IS NULL OR principal_version >= 1),
      scope_mode TEXT NOT NULL CHECK (scope_mode IN ('user-global', 'workspace')),
      workspace TEXT NOT NULL,
      agent_preset TEXT NOT NULL,
      trust TEXT NOT NULL CHECK (trust IN ('trusted', 'low')),
      sensitivity TEXT NOT NULL CHECK (sensitivity IN ('private', 'sensitive')),
      title TEXT NOT NULL CHECK (length(title) <= 512),
      body TEXT NOT NULL,
      entities_json TEXT NOT NULL CHECK (json_valid(entities_json)),
      tokens_json TEXT NOT NULL CHECK (json_valid(tokens_json)),
      metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
      ttl_ms INTEGER CHECK (ttl_ms IS NULL OR ttl_ms > 0),
      expires_at INTEGER CHECK (expires_at IS NULL OR expires_at >= 0),
      status TEXT NOT NULL CHECK (status IN ('active', 'suppressed', 'withdrawn')),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      UNIQUE (owner_scope_key, source_plugin, kind, source_ref),
      CHECK (
        (owner_mode = 'delivery' AND principal_digest IS NOT NULL AND principal_record_id IS NOT NULL AND principal_record_id <> '' AND principal_version IS NOT NULL)
        OR (owner_mode IN ('headless', 'system') AND principal_record_id IS NULL AND principal_version IS NULL)
      )
    ) STRICT;

    CREATE INDEX assoc_nodes_active_scope ON assoc_nodes(status, owner_scope_key, updated_at DESC);
    CREATE INDEX assoc_nodes_source_lookup ON assoc_nodes(owner_scope_key, source_plugin, source_ref);
    CREATE INDEX assoc_nodes_expires ON assoc_nodes(expires_at) WHERE expires_at IS NOT NULL;

    CREATE TABLE assoc_edges (
      edge_id TEXT PRIMARY KEY CHECK (length(edge_id) = 64 AND edge_id NOT GLOB '*[^0-9a-f]*'),
      a_id TEXT NOT NULL REFERENCES assoc_nodes(id) ON DELETE CASCADE,
      b_id TEXT NOT NULL REFERENCES assoc_nodes(id) ON DELETE CASCADE,
      edge_type TEXT NOT NULL CHECK (edge_type IN ('cooccur', 'entity', 'dream', 'hebbian', 'synonym', 'abstraction')),
      weight REAL NOT NULL CHECK (weight >= 0.0 AND weight <= 10.0),
      trust TEXT NOT NULL CHECK (trust IN ('trusted', 'low')),
      reason TEXT NOT NULL CHECK (length(reason) <= 256),
      use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
      last_used_at INTEGER CHECK (last_used_at IS NULL OR last_used_at >= 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      CHECK (a_id <> b_id),
      UNIQUE (a_id, b_id, edge_type)
    ) STRICT;

    CREATE INDEX assoc_edges_a ON assoc_edges(a_id, weight DESC);
    CREATE INDEX assoc_edges_b ON assoc_edges(b_id, weight DESC);

    CREATE TABLE assoc_synonyms (
      id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
      owner_scope_key TEXT NOT NULL CHECK (length(owner_scope_key) = 64 AND owner_scope_key NOT GLOB '*[^0-9a-f]*'),
      surface TEXT NOT NULL CHECK (length(surface) BETWEEN 1 AND 256),
      canonical_entity TEXT NOT NULL CHECK (length(canonical_entity) BETWEEN 1 AND 256),
      source_node_id TEXT REFERENCES assoc_nodes(id) ON DELETE CASCADE,
      trust TEXT NOT NULL CHECK (trust IN ('trusted', 'low')),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      UNIQUE (owner_scope_key, surface, canonical_entity)
    ) STRICT;

    CREATE TABLE assoc_derived_from (
      source_node_id TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK (source_version >= 0),
      target_kind TEXT NOT NULL CHECK (target_kind IN ('node', 'edge', 'synonym')),
      target_id TEXT NOT NULL,
      PRIMARY KEY (source_node_id, source_version, target_kind, target_id)
    ) STRICT, WITHOUT ROWID;

    CREATE INDEX assoc_derived_from_target ON assoc_derived_from(target_kind, target_id);

    CREATE TABLE assoc_ingest_cursors (
      source_plugin TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      cursor_json TEXT NOT NULL CHECK (json_valid(cursor_json)),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      PRIMARY KEY (source_plugin, scope_key)
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE assoc_holdout_assignments (
      task_id TEXT PRIMARY KEY CHECK (length(task_id) BETWEEN 1 AND 512),
      owner_scope_key TEXT NOT NULL CHECK (length(owner_scope_key) = 64 AND owner_scope_key NOT GLOB '*[^0-9a-f]*'),
      task_kind TEXT NOT NULL CHECK (task_kind IN (
        'foreground-turn', 'automation-run', 'goal-step', 'goal-outcome', 'work-item', 'headless-session'
      )),
      session_id TEXT,
      turn_number INTEGER CHECK (turn_number IS NULL OR turn_number >= 0),
      in_holdout INTEGER NOT NULL CHECK (in_holdout IN (0, 1)),
      bucket_bps INTEGER NOT NULL CHECK (bucket_bps >= 0 AND bucket_bps < 10000),
      rate_bps INTEGER NOT NULL CHECK (rate_bps >= 1000 AND rate_bps <= 1500),
      hmac_digest TEXT NOT NULL CHECK (length(hmac_digest) = 64 AND hmac_digest NOT GLOB '*[^0-9a-f]*'),
      assigned_at INTEGER NOT NULL CHECK (assigned_at >= 0)
    ) STRICT;

    CREATE INDEX assoc_holdout_scope_time ON assoc_holdout_assignments(owner_scope_key, in_holdout, assigned_at DESC);
    CREATE INDEX assoc_holdout_session ON assoc_holdout_assignments(session_id, turn_number) WHERE session_id IS NOT NULL;

    CREATE TABLE assoc_step_metrics (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      owner_scope_key TEXT NOT NULL CHECK (length(owner_scope_key) = 64 AND owner_scope_key NOT GLOB '*[^0-9a-f]*'),
      in_holdout INTEGER NOT NULL CHECK (in_holdout IN (0, 1)),
      latency_us INTEGER NOT NULL CHECK (latency_us >= 0),
      timed_out INTEGER NOT NULL CHECK (timed_out IN (0, 1)),
      fallback_mode TEXT NOT NULL CHECK (fallback_mode IN ('none', 'memory-only', 'cold-start', 'timeout', 'holdout')),
      injected_count INTEGER NOT NULL CHECK (injected_count >= 0),
      candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
      source_counts_json TEXT NOT NULL CHECK (json_valid(source_counts_json)),
      occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0)
    ) STRICT;

    CREATE INDEX assoc_step_metrics_time ON assoc_step_metrics(occurred_at DESC, seq DESC);

    CREATE TABLE assoc_exposures (
      task_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      owner_scope_key TEXT NOT NULL CHECK (length(owner_scope_key) = 64 AND owner_scope_key NOT GLOB '*[^0-9a-f]*'),
      source_plugin TEXT NOT NULL,
      exposed_at INTEGER NOT NULL CHECK (exposed_at >= 0),
      assoc_read_count INTEGER NOT NULL DEFAULT 0 CHECK (assoc_read_count >= 0),
      weak_use_count INTEGER NOT NULL DEFAULT 0 CHECK (weak_use_count >= 0),
      corrected INTEGER NOT NULL DEFAULT 0 CHECK (corrected IN (0, 1)),
      PRIMARY KEY (task_id, node_id)
    ) STRICT, WITHOUT ROWID;

    CREATE INDEX assoc_exposures_scope_time ON assoc_exposures(owner_scope_key, exposed_at DESC);

    CREATE TABLE assoc_withdrawn_sources (
      owner_scope_key TEXT NOT NULL CHECK (length(owner_scope_key) = 64 AND owner_scope_key NOT GLOB '*[^0-9a-f]*'),
      source_plugin TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      withdrawn_at INTEGER NOT NULL CHECK (withdrawn_at >= 0),
      PRIMARY KEY (owner_scope_key, source_plugin, source_ref)
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE assoc_owner_scopes (
      owner_scope_key TEXT PRIMARY KEY CHECK (length(owner_scope_key) = 64 AND owner_scope_key NOT GLOB '*[^0-9a-f]*'),
      mode TEXT NOT NULL CHECK (mode IN ('delivery', 'headless', 'system')),
      principal_id TEXT NOT NULL,
      principal_digest TEXT NOT NULL CHECK (length(principal_digest) = 64 AND principal_digest NOT GLOB '*[^0-9a-f]*'),
      principal_record_id TEXT,
      principal_version INTEGER CHECK (principal_version IS NULL OR principal_version >= 1),
      workspace TEXT NOT NULL,
      agent_preset TEXT NOT NULL,
      authority_id TEXT,
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
    ) STRICT;
  `)
}

function migrateV1ToV2(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE assoc_edges ADD COLUMN last_decayed_at INTEGER CHECK (last_decayed_at IS NULL OR last_decayed_at >= 0);
    CREATE INDEX IF NOT EXISTS assoc_edges_decay ON assoc_edges(last_used_at, created_at, weight);

    ALTER TABLE assoc_exposures ADD COLUMN was_exposed INTEGER NOT NULL DEFAULT 1 CHECK (was_exposed IN (0, 1));
    ALTER TABLE assoc_exposures ADD COLUMN hop INTEGER NOT NULL DEFAULT 0 CHECK (hop >= 0 AND hop <= 2);
    ALTER TABLE assoc_exposures ADD COLUMN score REAL NOT NULL DEFAULT 0.0;
    ALTER TABLE assoc_exposures ADD COLUMN reason TEXT NOT NULL DEFAULT '';
    ALTER TABLE assoc_exposures ADD COLUMN provenance_edges_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(provenance_edges_json));
    ALTER TABLE assoc_exposures ADD COLUMN session_id TEXT;
    ALTER TABLE assoc_exposures ADD COLUMN strong_used INTEGER NOT NULL DEFAULT 0 CHECK (strong_used IN (0, 1));
    ALTER TABLE assoc_exposures ADD COLUMN weak_used INTEGER NOT NULL DEFAULT 0 CHECK (weak_used IN (0, 1));
    ALTER TABLE assoc_exposures ADD COLUMN hebbian_delta_applied REAL NOT NULL DEFAULT 0.0;
    ALTER TABLE assoc_exposures ADD COLUMN corrected_at INTEGER CHECK (corrected_at IS NULL OR corrected_at >= 0);
    CREATE INDEX IF NOT EXISTS assoc_exposures_node_time ON assoc_exposures(owner_scope_key, node_id, exposed_at DESC);

    UPDATE assoc_exposures
    SET strong_used = CASE WHEN assoc_read_count > 0 THEN 1 ELSE 0 END,
        weak_used = CASE WHEN weak_use_count > 0 THEN 1 ELSE 0 END
    WHERE was_exposed = 1 AND (assoc_read_count > 0 OR weak_use_count > 0);

    ALTER TABLE assoc_step_metrics ADD COLUMN profile_version INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE assoc_hebbian_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_scope_key TEXT NOT NULL CHECK (length(owner_scope_key) = 64 AND owner_scope_key NOT GLOB '*[^0-9a-f]*'),
      task_id TEXT,
      node_id TEXT,
      edge_id TEXT NOT NULL CHECK (length(edge_id) = 64 AND edge_id NOT GLOB '*[^0-9a-f]*'),
      event_kind TEXT NOT NULL CHECK (event_kind IN ('strong-use', 'weak-use', 'correction', 'decay')),
      delta REAL NOT NULL,
      weight_before REAL NOT NULL,
      weight_after REAL NOT NULL,
      occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0)
    ) STRICT;

    CREATE INDEX assoc_hebbian_events_scope_time ON assoc_hebbian_events(owner_scope_key, occurred_at DESC, seq DESC);
    CREATE INDEX assoc_hebbian_events_edge ON assoc_hebbian_events(edge_id, occurred_at DESC);

    CREATE TABLE assoc_read_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      node_id TEXT NOT NULL,
      owner_scope_key TEXT NOT NULL,
      hit INTEGER NOT NULL CHECK (hit IN (0, 1)),
      reason TEXT NOT NULL,
      occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0)
    ) STRICT;

    CREATE INDEX assoc_read_events_time ON assoc_read_events(occurred_at DESC, seq DESC);

    CREATE TABLE assoc_replay_episodes (
      task_id TEXT PRIMARY KEY CHECK (length(task_id) BETWEEN 1 AND 512),
      owner_scope_key TEXT NOT NULL CHECK (length(owner_scope_key) = 64 AND owner_scope_key NOT GLOB '*[^0-9a-f]*'),
      in_holdout INTEGER NOT NULL CHECK (in_holdout IN (0, 1)),
      cues_json TEXT NOT NULL CHECK (json_valid(cues_json)),
      used_node_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(used_node_ids_json)),
      corrected_node_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(corrected_node_ids_json)),
      profile_version INTEGER NOT NULL DEFAULT 0 CHECK (profile_version >= 0),
      occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0)
    ) STRICT;

    CREATE INDEX assoc_replay_episodes_scope_time ON assoc_replay_episodes(owner_scope_key, occurred_at DESC);

    CREATE TABLE assoc_task_telemetry (
      task_id TEXT PRIMARY KEY,
      owner_scope_key TEXT NOT NULL,
      in_holdout INTEGER NOT NULL CHECK (in_holdout IN (0, 1)),
      turns INTEGER NOT NULL DEFAULT 0 CHECK (turns >= 0),
      steps INTEGER NOT NULL DEFAULT 0 CHECK (steps >= 0),
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd_micros INTEGER,
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
    ) STRICT;

    CREATE INDEX assoc_task_telemetry_time ON assoc_task_telemetry(updated_at DESC);

    CREATE TABLE assoc_param_profile_versions (
      scope_key TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 0),
      parent_version INTEGER CHECK (parent_version IS NULL OR (parent_version >= 0 AND parent_version < version)),
      params_json TEXT NOT NULL CHECK (json_valid(params_json)),
      params_digest TEXT NOT NULL,
      basis_json TEXT NOT NULL CHECK (json_valid(basis_json)),
      change_json TEXT NOT NULL CHECK (json_valid(change_json)),
      origin TEXT NOT NULL CHECK (origin IN ('baseline', 'auto', 'replay', 'manual')),
      digest TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      PRIMARY KEY (scope_key, version)
    ) STRICT;

    CREATE TRIGGER assoc_param_profile_versions_immutable
      BEFORE UPDATE ON assoc_param_profile_versions
      BEGIN SELECT RAISE(ABORT, 'assoc_param_profile_versions are immutable'); END;

    CREATE TRIGGER assoc_param_profile_versions_no_delete
      BEFORE DELETE ON assoc_param_profile_versions
      BEGIN SELECT RAISE(ABORT, 'assoc_param_profile_versions are durable'); END;

    CREATE TABLE assoc_param_profile_heads (
      scope_key TEXT PRIMARY KEY,
      active_version INTEGER NOT NULL CHECK (active_version >= 0),
      latest_version INTEGER NOT NULL CHECK (latest_version >= active_version),
      active_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('idle', 'observing')),
      observing_version INTEGER,
      observe_from INTEGER,
      observe_until INTEGER,
      changed_at INTEGER NOT NULL CHECK (changed_at >= 0),
      CHECK (
        (state = 'idle' AND observing_version IS NULL AND observe_from IS NULL AND observe_until IS NULL)
        OR (state = 'observing' AND observing_version = active_version AND observe_from IS NOT NULL AND observe_until IS NOT NULL AND observe_until > observe_from)
      )
    ) STRICT;

    CREATE TRIGGER assoc_param_profile_heads_no_delete
      BEFORE DELETE ON assoc_param_profile_heads
      BEGIN SELECT RAISE(ABORT, 'assoc_param_profile_heads are durable'); END;

    CREATE TABLE assoc_param_profile_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('adopted', 'rolled-back', 'settled', 'request-rejected')),
      from_version INTEGER,
      to_version INTEGER,
      from_digest TEXT,
      to_digest TEXT,
      reason TEXT NOT NULL,
      detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
      idempotency_key TEXT NOT NULL UNIQUE,
      occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0)
    ) STRICT;

    CREATE INDEX assoc_param_profile_events_scope ON assoc_param_profile_events(scope_key, seq);

    CREATE TRIGGER assoc_param_profile_events_immutable
      BEFORE UPDATE ON assoc_param_profile_events
      BEGIN SELECT RAISE(ABORT, 'assoc_param_profile_events are immutable'); END;

    CREATE TRIGGER assoc_param_profile_events_no_delete
      BEFORE DELETE ON assoc_param_profile_events
      BEGIN SELECT RAISE(ABORT, 'assoc_param_profile_events are durable'); END;

    CREATE TABLE assoc_param_relax_proposals (
      proposal_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      parent_version INTEGER NOT NULL,
      parent_digest TEXT NOT NULL,
      candidate_json TEXT NOT NULL CHECK (json_valid(candidate_json)),
      params_digest TEXT NOT NULL,
      change_json TEXT NOT NULL CHECK (json_valid(change_json)),
      holdout_seal TEXT NOT NULL,
      window_from INTEGER NOT NULL,
      window_to INTEGER NOT NULL,
      basis_json TEXT NOT NULL CHECK (json_valid(basis_json)),
      status TEXT NOT NULL CHECK (status IN ('pending', 'adopted', 'rejected')),
      created_at INTEGER NOT NULL CHECK (created_at >= 0)
    ) STRICT;

    CREATE INDEX assoc_param_relax_proposals_scope ON assoc_param_relax_proposals(scope_key, created_at);

    CREATE TRIGGER assoc_param_relax_proposals_immutable
      BEFORE UPDATE ON assoc_param_relax_proposals
      BEGIN SELECT RAISE(ABORT, 'assoc_param_relax_proposals are immutable'); END;

    CREATE TRIGGER assoc_param_relax_proposals_no_delete
      BEFORE DELETE ON assoc_param_relax_proposals
      BEGIN SELECT RAISE(ABORT, 'assoc_param_relax_proposals are durable'); END;

    CREATE TABLE assoc_param_relax_decisions (
      decision_id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL UNIQUE,
      scope_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('adopted', 'rejected')),
      reason TEXT NOT NULL,
      replay_json TEXT NOT NULL CHECK (json_valid(replay_json)),
      decided_at INTEGER NOT NULL CHECK (decided_at >= 0),
      FOREIGN KEY (proposal_id) REFERENCES assoc_param_relax_proposals(proposal_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TRIGGER assoc_param_relax_decisions_immutable
      BEFORE UPDATE ON assoc_param_relax_decisions
      BEGIN SELECT RAISE(ABORT, 'assoc_param_relax_decisions are immutable'); END;

    CREATE TRIGGER assoc_param_relax_decisions_no_delete
      BEFORE DELETE ON assoc_param_relax_decisions
      BEGIN SELECT RAISE(ABORT, 'assoc_param_relax_decisions are durable'); END;

    CREATE TABLE assoc_param_rolled_back_digests (
      scope_key TEXT NOT NULL,
      params_digest TEXT NOT NULL,
      rolled_back_at INTEGER NOT NULL CHECK (rolled_back_at >= 0),
      from_version INTEGER NOT NULL,
      reason TEXT NOT NULL,
      PRIMARY KEY (scope_key, params_digest)
    ) STRICT;

    INSERT INTO schema_meta(key, value) VALUES ('schema-version', '2')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `)
}

function migrateV2ToV3(database: DatabaseSync): void {
  ensureDreamingSchema(database)
  ensureIntakeSignalSchema(database)
  ensureClusteringSchema(database)
  ensureEvalPoolSchema(database)
  database.exec(`
    INSERT INTO schema_meta(key, value) VALUES ('schema-version', '3')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `)
}

export function ensureWebLearningSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS assoc_web_learning_runs (
      run_id TEXT PRIMARY KEY,
      owner_scope_key TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('completed', 'budget-exhausted', 'skipped', 'failed')),
      reason TEXT,
      topics_considered INTEGER NOT NULL DEFAULT 0,
      requests_used INTEGER NOT NULL DEFAULT 0,
      pages_fetched INTEGER NOT NULL DEFAULT 0,
      bytes_fetched INTEGER NOT NULL DEFAULT 0,
      nodes_written INTEGER NOT NULL DEFAULT 0,
      details_json TEXT
    ) STRICT;

    CREATE INDEX IF NOT EXISTS assoc_web_runs_scope_started
      ON assoc_web_learning_runs(owner_scope_key, started_at DESC);

    CREATE TABLE IF NOT EXISTS assoc_web_learning_budget_usage (
      owner_scope_key TEXT NOT NULL,
      utc_day TEXT NOT NULL,
      requests_used INTEGER NOT NULL DEFAULT 0,
      pages_fetched INTEGER NOT NULL DEFAULT 0,
      bytes_fetched INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner_scope_key, utc_day)
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS assoc_web_learning_fetches (
      fetch_id TEXT PRIMARY KEY,
      owner_scope_key TEXT NOT NULL,
      run_id TEXT NOT NULL,
      canonical_url TEXT NOT NULL,
      domain TEXT NOT NULL,
      interest_key TEXT NOT NULL,
      status TEXT NOT NULL,
      bytes_fetched INTEGER NOT NULL DEFAULT 0,
      node_id TEXT,
      fetched_at INTEGER NOT NULL,
      expires_at INTEGER
    ) STRICT;

    CREATE INDEX IF NOT EXISTS assoc_web_fetches_scope_url
      ON assoc_web_learning_fetches(owner_scope_key, canonical_url, fetched_at DESC);
  `)
}

function migrateV3ToV4(database: DatabaseSync): void {
  ensureWebLearningSchema(database)
  database.exec(`
    INSERT INTO schema_meta(key, value) VALUES ('schema-version', '4')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `)
}

function migrate(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    const row = database.prepare('PRAGMA user_version').get() as { user_version: number }
    if (row.user_version > ASSOCIATION_SCHEMA_VERSION) {
      throw new AssociationDatabaseError(
        'schema-too-new',
        `association schema ${row.user_version} is newer than supported schema ${ASSOCIATION_SCHEMA_VERSION}`,
      )
    }
    if (row.user_version === 0) {
      createV1Schema(database)
      migrateV1ToV2(database)
      migrateV2ToV3(database)
      migrateV3ToV4(database)
      database.exec(`PRAGMA user_version = ${ASSOCIATION_SCHEMA_VERSION}`)
    } else if (row.user_version === 1) {
      migrateV1ToV2(database)
      migrateV2ToV3(database)
      migrateV3ToV4(database)
      database.exec(`PRAGMA user_version = ${ASSOCIATION_SCHEMA_VERSION}`)
    } else if (row.user_version === 2) {
      migrateV2ToV3(database)
      migrateV3ToV4(database)
      database.exec(`PRAGMA user_version = ${ASSOCIATION_SCHEMA_VERSION}`)
    } else if (row.user_version === 3) {
      migrateV3ToV4(database)
      database.exec(`PRAGMA user_version = ${ASSOCIATION_SCHEMA_VERSION}`)
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export function openAssociationDatabase(path: string): DatabaseSync {
  if (path !== ':memory:' && (!isAbsolute(path) || resolve(path) !== path)) {
    throw new AssociationDatabaseError(
      'invalid-path',
      'association database path must be :memory: or a canonical absolute path',
    )
  }
  if (path !== ':memory:') {
    preparePrivateFile(path)
  }
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
      for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
        try {
          chmodSync(sidecar, 0o600)
          assertSafePrivateFile(sidecar)
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        }
      }
    }
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

interface RawNodeRow {
  id: string
  kind: NodeKind
  source_plugin: string
  source_ref: string
  source_version: number
  owner_scope_key: string
  owner_mode: AssociationOwnerMode
  principal_digest: string | null
  principal_record_id: string | null
  principal_version: number | null
  scope_mode: AssociationScopeMode
  workspace: string
  agent_preset: string
  trust: AssociationTrust
  sensitivity: AssociationSensitivity
  title: string
  body: string
  entities_json: string
  tokens_json: string
  metadata_json: string
  ttl_ms: number | null
  expires_at: number | null
  status: AssociationNodeStatus
  created_at: number
  updated_at: number
}

function mapRawNode(row: RawNodeRow): StoredAssociationNode {
  return {
    id: row.id,
    kind: row.kind,
    sourcePlugin: row.source_plugin,
    sourceRef: row.source_ref,
    sourceVersion: row.source_version,
    ownerScopeKey: row.owner_scope_key,
    ownerMode: row.owner_mode,
    principalDigest: row.principal_digest,
    principalRecordId: row.principal_record_id,
    principalVersion: row.principal_version,
    scopeMode: row.scope_mode,
    workspace: row.workspace,
    agentPreset: row.agent_preset,
    trust: row.trust,
    sensitivity: row.sensitivity,
    title: row.title,
    body: row.body,
    entities: JSON.parse(row.entities_json) as string[],
    tokens: JSON.parse(row.tokens_json) as string[],
    metadata: JSON.parse(row.metadata_json) as AssociationNodeMetadata,
    ttlMs: row.ttl_ms,
    expiresAt: row.expires_at,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

interface RawExposureRow {
  task_id: string
  node_id: string
  owner_scope_key: string
  source_plugin: string
  exposed_at: number
  was_exposed: number
  hop: number
  score: number
  reason: string
  provenance_edges_json: string
  session_id: string | null
  assoc_read_count: number
  weak_use_count: number
  strong_used: number
  weak_used: number
  hebbian_delta_applied: number
  corrected: number
  corrected_at: number | null
}

function mapRawExposure(row: RawExposureRow): StoredExposureRow {
  let provenanceEdges: ProvenanceEdgeRef[] = []
  try {
    const parsed = JSON.parse(row.provenance_edges_json) as unknown
    if (Array.isArray(parsed)) {
      provenanceEdges = parsed as ProvenanceEdgeRef[]
    }
  } catch {
    provenanceEdges = []
  }
  return {
    taskId: row.task_id,
    nodeId: row.node_id,
    ownerScopeKey: row.owner_scope_key,
    sourcePlugin: row.source_plugin,
    exposedAt: row.exposed_at,
    wasExposed: row.was_exposed === 1,
    hop: row.hop,
    score: row.score,
    reason: row.reason,
    provenanceEdges,
    sessionId: row.session_id,
    assocReadCount: row.assoc_read_count,
    weakUseCount: row.weak_use_count,
    strongUsed: row.strong_used === 1,
    weakUsed: row.weak_used === 1,
    hebbianDeltaApplied: row.hebbian_delta_applied,
    corrected: row.corrected === 1,
    correctedAt: row.corrected_at,
  }
}

function clampEdgeWeight(value: number, weightMin: number, weightMax: number): number {
  const lo = Math.max(0.0, Math.min(10.0, weightMin))
  const hi = Math.max(lo, Math.min(10.0, weightMax))
  if (!Number.isFinite(value)) return lo
  return Math.min(hi, Math.max(lo, value))
}

function mergeUniqueStrings(existing: readonly string[], incoming: readonly string[]): string[] {
  if (incoming.length === 0) return [...existing]
  const seen = new Set<string>(existing)
  const merged = [...existing]
  for (const item of incoming) {
    if (!seen.has(item)) {
      seen.add(item)
      merged.push(item)
    }
  }
  return merged
}

export interface WithdrawalCascadeResult {
  readonly deletedNodeIds: readonly string[]
  readonly suppressedNodeIds: readonly string[]
  readonly deletedEdgeIds: readonly string[]
  readonly deletedSynonymIds: readonly string[]
}

export class AssociationStore {
  readonly #db: DatabaseSync

  constructor(database: DatabaseSync) {
    this.#db = database
  }

  get database(): DatabaseSync {
    return this.#db
  }

  close(): void {
    this.#db.close()
  }

  runInTransaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  upsertBatch(input: {
    readonly nodes: readonly UpsertNodeInput[]
    readonly edges: readonly UpsertEdgeInput[]
    readonly synonyms?: readonly UpsertSynonymInput[]
    readonly derivedRefs: readonly DerivedRefInput[]
    readonly cursor?: {
      readonly sourcePlugin: string
      readonly scopeKey: string
      readonly cursorJson: string
      readonly updatedAt?: number
    }
  }): WithdrawalCascadeResult {
    return this.runInTransaction(() => {
      const selectExisting = this.#db.prepare(
        'SELECT id, source_version FROM assoc_nodes WHERE id = ?',
      )
      const checkWithdrawnStmt = this.#db.prepare(
        'SELECT 1 AS ok FROM assoc_withdrawn_sources WHERE owner_scope_key = ? AND source_plugin = ? AND source_ref = ?',
      )
      const upsertNodeStmt = this.#db.prepare(`
        INSERT INTO assoc_nodes (
          id, kind, source_plugin, source_ref, source_version,
          owner_scope_key, owner_mode, principal_digest, principal_record_id, principal_version,
          scope_mode, workspace, agent_preset, trust, sensitivity,
          title, body, entities_json, tokens_json, metadata_json,
          ttl_ms, expires_at, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          source_plugin = excluded.source_plugin,
          source_ref = excluded.source_ref,
          source_version = excluded.source_version,
          owner_scope_key = excluded.owner_scope_key,
          owner_mode = excluded.owner_mode,
          principal_digest = excluded.principal_digest,
          principal_record_id = excluded.principal_record_id,
          principal_version = excluded.principal_version,
          scope_mode = excluded.scope_mode,
          workspace = excluded.workspace,
          agent_preset = excluded.agent_preset,
          trust = excluded.trust,
          sensitivity = excluded.sensitivity,
          title = excluded.title,
          body = excluded.body,
          entities_json = excluded.entities_json,
          tokens_json = excluded.tokens_json,
          metadata_json = excluded.metadata_json,
          ttl_ms = excluded.ttl_ms,
          expires_at = excluded.expires_at,
          status = excluded.status,
          updated_at = excluded.updated_at
      `)

      const deletedNodeIds: string[] = []
      const deletedEdgeIds: string[] = []
      const deletedSynonymIds: string[] = []
      const skippedWithdrawnNodeIds = new Set<string>()
      const skippedSynonymIds = new Set<string>()
      const synonymIdMap = new Map<string, string>()

      for (const node of input.nodes) {
        if (
          checkWithdrawnStmt.get(node.ownerScopeKey, node.sourcePlugin, node.sourceRef) !==
          undefined
        ) {
          skippedWithdrawnNodeIds.add(node.id)
          continue
        }
        const existing = selectExisting.get(node.id) as
          | { id: string; source_version: number }
          | undefined
        if (existing !== undefined && existing.source_version !== node.sourceVersion) {
          const cascade = this.#cascadeDerivedInCurrentTx([
            { nodeId: node.id, exactVersion: existing.source_version },
          ])
          deletedNodeIds.push(...cascade.deletedNodeIds)
          deletedEdgeIds.push(...cascade.deletedEdgeIds)
          deletedSynonymIds.push(...cascade.deletedSynonymIds)
        }
        upsertNodeStmt.run(
          node.id,
          node.kind,
          node.sourcePlugin,
          node.sourceRef,
          node.sourceVersion,
          node.ownerScopeKey,
          node.ownerMode,
          node.principalDigest,
          node.principalRecordId,
          node.principalVersion,
          node.scopeMode,
          node.workspace,
          node.agentPreset,
          node.trust,
          node.sensitivity,
          node.title.slice(0, 512),
          node.body,
          JSON.stringify(node.entities),
          JSON.stringify(node.tokens),
          JSON.stringify(node.metadata ?? {}),
          node.ttlMs ?? null,
          node.expiresAt ?? null,
          node.status ?? 'active',
          node.createdAt,
          node.updatedAt,
        )
      }

      if (input.edges.length > 0) {
        const checkNodeExists = this.#db.prepare('SELECT 1 AS ok FROM assoc_nodes WHERE id = ?')
        const upsertEdgeStmt = this.#db.prepare(`
          INSERT INTO assoc_edges (
            edge_id, a_id, b_id, edge_type, weight, trust, reason,
            use_count, last_used_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(a_id, b_id, edge_type) DO UPDATE SET
            weight = excluded.weight,
            trust = excluded.trust,
            reason = excluded.reason,
            updated_at = excluded.updated_at
        `)
        for (const edge of input.edges) {
          if (edge.aId === edge.bId) continue
          if (
            checkNodeExists.get(edge.aId) === undefined ||
            checkNodeExists.get(edge.bId) === undefined
          ) {
            continue
          }
          const clampedWeight = Math.min(10.0, Math.max(0.0, edge.weight))
          upsertEdgeStmt.run(
            edge.edgeId,
            edge.aId,
            edge.bId,
            edge.edgeType,
            clampedWeight,
            edge.trust,
            edge.reason.slice(0, 256),
            edge.useCount ?? 0,
            edge.lastUsedAt ?? null,
            edge.createdAt,
            edge.updatedAt,
          )
        }
      }

      if (input.synonyms && input.synonyms.length > 0) {
        const checkNodeExists = this.#db.prepare('SELECT 1 AS ok FROM assoc_nodes WHERE id = ?')
        const upsertSynonymStmt = this.#db.prepare(`
          INSERT INTO assoc_synonyms (
            id, owner_scope_key, surface, canonical_entity, source_node_id, trust, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(owner_scope_key, surface, canonical_entity) DO UPDATE SET
            source_node_id = excluded.source_node_id,
            trust = excluded.trust
        `)
        for (const syn of input.synonyms) {
          if (syn.sourceNodeId !== undefined && syn.sourceNodeId !== null) {
            if (
              skippedWithdrawnNodeIds.has(syn.sourceNodeId) ||
              checkNodeExists.get(syn.sourceNodeId) === undefined
            ) {
              skippedSynonymIds.add(syn.id)
              continue
            }
          }
          const deterministicId = computeDeterministicSynonymId(
            syn.ownerScopeKey,
            syn.surface,
            syn.canonicalEntity,
          )
          const resolvedId = /^syn-[0-9a-f]{24}$/u.test(syn.id) ? syn.id : deterministicId
          synonymIdMap.set(syn.id, resolvedId)
          upsertSynonymStmt.run(
            resolvedId,
            syn.ownerScopeKey,
            syn.surface,
            syn.canonicalEntity,
            syn.sourceNodeId ?? null,
            syn.trust,
            syn.createdAt,
          )
        }
      }

      if (input.derivedRefs.length > 0) {
        const insertDerivedStmt = this.#db.prepare(`
          INSERT OR IGNORE INTO assoc_derived_from (
            source_node_id, source_version, target_kind, target_id
          ) VALUES (?, ?, ?, ?)
        `)
        for (const ref of input.derivedRefs) {
          if (
            skippedWithdrawnNodeIds.has(ref.sourceNodeId) ||
            (ref.targetKind === 'node' && skippedWithdrawnNodeIds.has(ref.targetId)) ||
            (ref.targetKind === 'synonym' && skippedSynonymIds.has(ref.targetId))
          ) {
            continue
          }
          const resolvedTargetId =
            ref.targetKind === 'synonym'
              ? (synonymIdMap.get(ref.targetId) ?? ref.targetId)
              : ref.targetId
          insertDerivedStmt.run(
            ref.sourceNodeId,
            ref.sourceVersion,
            ref.targetKind,
            resolvedTargetId,
          )
        }
      }

      if (input.cursor) {
        this.#db
          .prepare(`
            INSERT INTO assoc_ingest_cursors (source_plugin, scope_key, cursor_json, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(source_plugin, scope_key) DO UPDATE SET
              cursor_json = excluded.cursor_json,
              updated_at = excluded.updated_at
          `)
          .run(
            input.cursor.sourcePlugin,
            input.cursor.scopeKey,
            input.cursor.cursorJson,
            input.cursor.updatedAt ?? Date.now(),
          )
      }

      return {
        deletedNodeIds,
        suppressedNodeIds: [],
        deletedEdgeIds,
        deletedSynonymIds,
      }
    })
  }

  withdrawSource(input: {
    readonly ownerScopeKey: string
    readonly sourcePlugin: string
    readonly sourceRef: string
    readonly hardDelete: boolean
    readonly maxSourceVersion?: number
    readonly recordWithdrawalTombstone?: boolean
    readonly nowMs?: number
  }): WithdrawalCascadeResult {
    return this.runInTransaction(() => {
      const matchingNodes = this.#db
        .prepare(`
          SELECT id, source_version FROM assoc_nodes
          WHERE owner_scope_key = ? AND source_plugin = ? AND source_ref = ?
        `)
        .all(input.ownerScopeKey, input.sourcePlugin, input.sourceRef) as Array<{
        id: string
        source_version: number
      }>

      const seeds: Array<{ nodeId: string; maxVersion?: number }> = matchingNodes.map((row) =>
        input.maxSourceVersion === undefined
          ? { nodeId: row.id }
          : { nodeId: row.id, maxVersion: input.maxSourceVersion },
      )

      const cascade = this.#cascadeDerivedInCurrentTx(seeds)
      const deletedNodeSet = new Set(cascade.deletedNodeIds)
      const deletedEdgeSet = new Set(cascade.deletedEdgeIds)
      const suppressedNodeIds: string[] = []

      const selectIncidentEdges = this.#db.prepare(
        'SELECT edge_id FROM assoc_edges WHERE a_id = ? OR b_id = ?',
      )
      const deleteEdgeById = this.#db.prepare('DELETE FROM assoc_edges WHERE edge_id = ?')
      const deleteDerivedEdgeByTarget = this.#db.prepare(
        "DELETE FROM assoc_derived_from WHERE target_kind = 'edge' AND target_id = ?",
      )
      const deleteNodeById = this.#db.prepare('DELETE FROM assoc_nodes WHERE id = ?')
      const suppressNodeById = this.#db.prepare(
        "UPDATE assoc_nodes SET status = 'suppressed', updated_at = ? WHERE id = ?",
      )
      const nowMs = input.nowMs ?? Date.now()

      for (const row of matchingNodes) {
        const incident = selectIncidentEdges.all(row.id, row.id) as Array<{ edge_id: string }>
        for (const edge of incident) {
          deletedEdgeSet.add(edge.edge_id)
          deleteEdgeById.run(edge.edge_id)
          deleteDerivedEdgeByTarget.run(edge.edge_id)
        }
        if (input.hardDelete) {
          deletedNodeSet.add(row.id)
          deleteNodeById.run(row.id)
        } else {
          suppressedNodeIds.push(row.id)
          suppressNodeById.run(nowMs, row.id)
        }
      }

      if (input.recordWithdrawalTombstone) {
        this.#db
          .prepare(`
            INSERT INTO assoc_withdrawn_sources (owner_scope_key, source_plugin, source_ref, withdrawn_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(owner_scope_key, source_plugin, source_ref) DO UPDATE SET
              withdrawn_at = excluded.withdrawn_at
          `)
          .run(input.ownerScopeKey, input.sourcePlugin, input.sourceRef, nowMs)
      }

      return {
        deletedNodeIds: [...deletedNodeSet],
        suppressedNodeIds,
        deletedEdgeIds: [...deletedEdgeSet],
        deletedSynonymIds: cascade.deletedSynonymIds,
      }
    })
  }

  #cascadeDerivedInCurrentTx(
    seeds: readonly {
      readonly nodeId: string
      readonly maxVersion?: number
      readonly exactVersion?: number
    }[],
  ): {
    readonly deletedNodeIds: string[]
    readonly deletedEdgeIds: string[]
    readonly deletedSynonymIds: string[]
  } {
    if (seeds.length === 0) {
      return { deletedNodeIds: [], deletedEdgeIds: [], deletedSynonymIds: [] }
    }

    const selectAllBySource = this.#db.prepare(
      'SELECT target_kind, target_id FROM assoc_derived_from WHERE source_node_id = ?',
    )
    const selectUpToVersionBySource = this.#db.prepare(
      'SELECT target_kind, target_id FROM assoc_derived_from WHERE source_node_id = ? AND source_version <= ?',
    )
    const selectExactVersionBySource = this.#db.prepare(
      'SELECT target_kind, target_id FROM assoc_derived_from WHERE source_node_id = ? AND source_version = ?',
    )
    const selectSynonymsBySourceNode = this.#db.prepare(
      'SELECT id FROM assoc_synonyms WHERE source_node_id = ?',
    )

    const visitedNodes = new Set<string>()
    const deletedNodeIds = new Set<string>()
    const deletedEdgeIds = new Set<string>()
    const deletedSynonymIds = new Set<string>()
    const queue: Array<{
      readonly nodeId: string
      readonly maxVersion?: number
      readonly exactVersion?: number
    }> = [...seeds]

    while (queue.length > 0) {
      const current = queue.shift()!
      const visitKey =
        current.exactVersion !== undefined
          ? `${current.nodeId}:eq:${current.exactVersion}`
          : current.maxVersion !== undefined
            ? `${current.nodeId}:le:${current.maxVersion}`
            : `${current.nodeId}:*`
      if (visitedNodes.has(visitKey)) continue
      visitedNodes.add(visitKey)

      const rows = (
        current.exactVersion !== undefined
          ? selectExactVersionBySource.all(current.nodeId, current.exactVersion)
          : current.maxVersion === undefined
            ? selectAllBySource.all(current.nodeId)
            : selectUpToVersionBySource.all(current.nodeId, current.maxVersion)
      ) as Array<{ target_kind: 'node' | 'edge' | 'synonym'; target_id: string }>

      for (const row of rows) {
        if (row.target_kind === 'edge') {
          deletedEdgeIds.add(row.target_id)
        } else if (row.target_kind === 'synonym') {
          deletedSynonymIds.add(row.target_id)
        } else if (row.target_kind === 'node') {
          if (!deletedNodeIds.has(row.target_id)) {
            deletedNodeIds.add(row.target_id)
            queue.push({ nodeId: row.target_id })
          }
        }
      }

      const attachedSynonyms = selectSynonymsBySourceNode.all(current.nodeId) as Array<{
        id: string
      }>
      for (const syn of attachedSynonyms) {
        deletedSynonymIds.add(syn.id)
      }
    }

    const deleteDerivedByTarget = this.#db.prepare(
      'DELETE FROM assoc_derived_from WHERE target_kind = ? AND target_id = ?',
    )
    const deleteSynonymById = this.#db.prepare('DELETE FROM assoc_synonyms WHERE id = ?')
    const deleteEdgeById = this.#db.prepare('DELETE FROM assoc_edges WHERE edge_id = ?')
    const selectIncidentEdges = this.#db.prepare(
      'SELECT edge_id FROM assoc_edges WHERE a_id = ? OR b_id = ?',
    )
    const deleteNodeById = this.#db.prepare('DELETE FROM assoc_nodes WHERE id = ?')
    const deleteDerivedBySourceAll = this.#db.prepare(
      'DELETE FROM assoc_derived_from WHERE source_node_id = ?',
    )
    const deleteDerivedBySourceVersion = this.#db.prepare(
      'DELETE FROM assoc_derived_from WHERE source_node_id = ? AND source_version <= ?',
    )
    const deleteDerivedBySourceExact = this.#db.prepare(
      'DELETE FROM assoc_derived_from WHERE source_node_id = ? AND source_version = ?',
    )

    for (const synId of deletedSynonymIds) {
      deleteSynonymById.run(synId)
      deleteDerivedByTarget.run('synonym', synId)
    }

    for (const nodeId of deletedNodeIds) {
      const incident = selectIncidentEdges.all(nodeId, nodeId) as Array<{ edge_id: string }>
      for (const edge of incident) {
        deletedEdgeIds.add(edge.edge_id)
      }
    }

    for (const edgeId of deletedEdgeIds) {
      deleteEdgeById.run(edgeId)
      deleteDerivedByTarget.run('edge', edgeId)
    }

    for (const nodeId of deletedNodeIds) {
      deleteNodeById.run(nodeId)
      deleteDerivedByTarget.run('node', nodeId)
      deleteDerivedBySourceAll.run(nodeId)
    }

    for (const seed of seeds) {
      if (seed.exactVersion !== undefined) {
        deleteDerivedBySourceExact.run(seed.nodeId, seed.exactVersion)
      } else if (seed.maxVersion === undefined) {
        deleteDerivedBySourceAll.run(seed.nodeId)
      } else {
        deleteDerivedBySourceVersion.run(seed.nodeId, seed.maxVersion)
      }
    }

    return {
      deletedNodeIds: [...deletedNodeIds],
      deletedEdgeIds: [...deletedEdgeIds],
      deletedSynonymIds: [...deletedSynonymIds],
    }
  }

  getNodeById(id: string): StoredAssociationNode | null {
    const row = this.#db
      .prepare('SELECT * FROM assoc_nodes WHERE id = ?')
      .get(id) as RawNodeRow | undefined
    return row === undefined ? null : mapRawNode(row)
  }

  attachNodeOutcomeId(nodeId: string, outcomeId: string): boolean {
    const row = this.#db
      .prepare('SELECT metadata_json FROM assoc_nodes WHERE id = ?')
      .get(nodeId) as { metadata_json: string } | undefined
    if (row === undefined) return false
    const meta = JSON.parse(row.metadata_json) as Record<string, unknown>
    const prevExtra =
      meta.extra !== null && typeof meta.extra === 'object' && !Array.isArray(meta.extra)
        ? (meta.extra as Record<string, unknown>)
        : {}
    if (prevExtra.outcomeId === outcomeId) return false
    const nextMeta = {
      ...meta,
      extra: {
        ...prevExtra,
        outcomeId,
      },
    }
    this.#db
      .prepare('UPDATE assoc_nodes SET metadata_json = ? WHERE id = ?')
      .run(JSON.stringify(nextMeta), nodeId)
    return true
  }

  isSourceWithdrawn(ownerScopeKey: string, sourcePlugin: string, sourceRef: string): boolean {
    const row = this.#db
      .prepare(
        'SELECT 1 AS ok FROM assoc_withdrawn_sources WHERE owner_scope_key = ? AND source_plugin = ? AND source_ref = ?',
      )
      .get(ownerScopeKey, sourcePlugin, sourceRef) as { ok: number } | undefined
    return row !== undefined
  }

  countActiveNodes(): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS cnt FROM assoc_nodes WHERE status = 'active'")
      .get() as { cnt: number }
    return row.cnt
  }

  loadActiveNodesPage(limit: number, offset: number): StoredAssociationNode[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM assoc_nodes WHERE status = 'active' ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?",
      )
      .all(limit, offset) as unknown as RawNodeRow[]
    return rows.map(mapRawNode)
  }

  loadActiveEdgesPage(limit: number, offset: number): StoredAssociationEdge[] {
    const rows = this.#db
      .prepare(`
        SELECT e.edge_id, e.a_id, e.b_id, e.edge_type, e.weight, e.trust, e.reason,
               e.use_count, e.last_used_at, e.last_decayed_at, e.created_at, e.updated_at
        FROM assoc_edges e
        JOIN assoc_nodes a ON a.id = e.a_id AND a.status = 'active'
        JOIN assoc_nodes b ON b.id = e.b_id AND b.status = 'active'
        ORDER BY e.edge_id ASC
        LIMIT ? OFFSET ?
      `)
      .all(limit, offset) as Array<{
      edge_id: string
      a_id: string
      b_id: string
      edge_type: EdgeType
      weight: number
      trust: AssociationTrust
      reason: string
      use_count: number
      last_used_at: number | null
      last_decayed_at: number | null
      created_at: number
      updated_at: number
    }>
    return rows.map((row) => ({
      edgeId: row.edge_id,
      aId: row.a_id,
      bId: row.b_id,
      edgeType: row.edge_type,
      weight: row.weight,
      trust: row.trust,
      reason: row.reason,
      useCount: row.use_count,
      lastUsedAt: row.last_used_at,
      lastDecayedAt: row.last_decayed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  loadActiveSynonymsPage(limit: number, offset: number): StoredAssociationSynonym[] {
    const rows = this.#db
      .prepare('SELECT * FROM assoc_synonyms ORDER BY id ASC LIMIT ? OFFSET ?')
      .all(limit, offset) as Array<{
      id: string
      owner_scope_key: string
      surface: string
      canonical_entity: string
      source_node_id: string | null
      trust: AssociationTrust
      created_at: number
    }>
    return rows.map((row) => ({
      id: row.id,
      ownerScopeKey: row.owner_scope_key,
      surface: row.surface,
      canonicalEntity: row.canonical_entity,
      sourceNodeId: row.source_node_id,
      trust: row.trust,
      createdAt: row.created_at,
    }))
  }

  getIngestCursor(sourcePlugin: string, scopeKey: string): IngestCursorRow | null {
    const row = this.#db
      .prepare('SELECT * FROM assoc_ingest_cursors WHERE source_plugin = ? AND scope_key = ?')
      .get(sourcePlugin, scopeKey) as
      | {
          source_plugin: string
          scope_key: string
          cursor_json: string
          updated_at: number
        }
      | undefined
    if (row === undefined) return null
    return {
      sourcePlugin: row.source_plugin,
      scopeKey: row.scope_key,
      cursorJson: row.cursor_json,
      updatedAt: row.updated_at,
    }
  }

  upsertIngestCursor(cursor: IngestCursorRow): void {
    this.#db
      .prepare(`
        INSERT INTO assoc_ingest_cursors (source_plugin, scope_key, cursor_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(source_plugin, scope_key) DO UPDATE SET
          cursor_json = excluded.cursor_json,
          updated_at = excluded.updated_at
      `)
      .run(cursor.sourcePlugin, cursor.scopeKey, cursor.cursorJson, cursor.updatedAt)
  }

  upsertOwnerScope(scope: AssociationOwnerScope, nowMs = Date.now()): void {
    this.#db
      .prepare(`
        INSERT INTO assoc_owner_scopes (
          owner_scope_key, mode, principal_id, principal_digest,
          principal_record_id, principal_version, workspace, agent_preset,
          authority_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_scope_key) DO UPDATE SET
          authority_id = COALESCE(excluded.authority_id, assoc_owner_scopes.authority_id),
          updated_at = excluded.updated_at
      `)
      .run(
        scope.ownerScopeKey,
        scope.mode,
        scope.principalId,
        scope.principalDigest,
        scope.principalRecordId,
        scope.principalVersion,
        scope.workspace,
        scope.agentPreset,
        scope.authorityId ?? null,
        nowMs,
      )
  }

  listOwnerScopes(): AssociationOwnerScope[] {
    const rows = this.#db
      .prepare('SELECT * FROM assoc_owner_scopes ORDER BY updated_at DESC, owner_scope_key ASC')
      .all() as Array<{
      owner_scope_key: string
      mode: AssociationOwnerMode
      principal_id: string
      principal_digest: string
      principal_record_id: string | null
      principal_version: number | null
      workspace: string
      agent_preset: string
      authority_id: string | null
    }>
    return rows.map((row) => ({
      mode: row.mode,
      ownerScopeKey: row.owner_scope_key,
      principalId: row.principal_id,
      principalDigest: row.principal_digest,
      principalRecordId: row.principal_record_id,
      principalVersion: row.principal_version,
      workspace: row.workspace,
      agentPreset: row.agent_preset,
      ...(row.authority_id === null ? {} : { authorityId: row.authority_id }),
    }))
  }

  findNodeBySourceRef(
    ownerScopeKey: string,
    sourcePlugin: string,
    sourceRef: string,
  ): StoredAssociationNode | null {
    const row = this.#db
      .prepare(
        'SELECT * FROM assoc_nodes WHERE owner_scope_key = ? AND source_plugin = ? AND source_ref = ?',
      )
      .get(ownerScopeKey, sourcePlugin, sourceRef) as RawNodeRow | undefined
    return row === undefined ? null : mapRawNode(row)
  }

  listActiveSourceRefsForPlugin(ownerScopeKey: string, sourcePlugin: string): string[] {
    const rows = this.#db
      .prepare(
        "SELECT source_ref FROM assoc_nodes WHERE owner_scope_key = ? AND source_plugin = ? AND status = 'active'",
      )
      .all(ownerScopeKey, sourcePlugin) as Array<{ source_ref: string }>
    return rows.map((row) => row.source_ref)
  }

  listActiveNodesBySourcePlugin(
    ownerScopeKey: string,
    sourcePlugin: string,
  ): StoredAssociationNode[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM assoc_nodes WHERE owner_scope_key = ? AND source_plugin = ? AND status = 'active'",
      )
      .all(ownerScopeKey, sourcePlugin) as unknown as RawNodeRow[]
    return rows.map(mapRawNode)
  }

  listCascadeNodeIdsForSource(
    ownerScopeKey: string,
    sourcePlugin: string,
    sourceRef: string,
  ): string[] {
    const matching = this.#db
      .prepare(
        'SELECT id FROM assoc_nodes WHERE owner_scope_key = ? AND source_plugin = ? AND source_ref = ?',
      )
      .all(ownerScopeKey, sourcePlugin, sourceRef) as Array<{ id: string }>
    if (matching.length === 0) return []
    const selectDerivedNodes = this.#db.prepare(
      "SELECT target_id FROM assoc_derived_from WHERE source_node_id = ? AND target_kind = 'node'",
    )
    const visited = new Set<string>()
    const queue: string[] = []
    for (const row of matching) {
      if (!visited.has(row.id)) {
        visited.add(row.id)
        queue.push(row.id)
      }
    }
    while (queue.length > 0) {
      const current = queue.shift()!
      const children = selectDerivedNodes.all(current) as Array<{ target_id: string }>
      for (const child of children) {
        if (!visited.has(child.target_id)) {
          visited.add(child.target_id)
          queue.push(child.target_id)
        }
      }
    }
    return [...visited]
  }

  loadEntityCandidateNodesForScope(
    ownerScopeKey: string,
    limit = 256,
  ): Array<{
    readonly id: string
    readonly sourceVersion: number
    readonly ownerScopeKey: string
    readonly trust: AssociationTrust
    readonly entities: readonly string[]
    readonly updatedAt: number
  }> {
    const rows = this.#db
      .prepare(`
        SELECT id, source_version, owner_scope_key, trust, entities_json, updated_at
        FROM assoc_nodes
        WHERE status = 'active' AND owner_scope_key = ? AND sensitivity = 'private'
        ORDER BY updated_at DESC, id ASC
        LIMIT ?
      `)
      .all(ownerScopeKey, limit) as Array<{
      id: string
      source_version: number
      owner_scope_key: string
      trust: AssociationTrust
      entities_json: string
      updated_at: number
    }>
    return rows.map((row) => ({
      id: row.id,
      sourceVersion: row.source_version,
      ownerScopeKey: row.owner_scope_key,
      trust: row.trust,
      entities: JSON.parse(row.entities_json) as string[],
      updatedAt: row.updated_at,
    }))
  }

  suppressNodeConflict(input: {
    readonly ownerScopeKey: string
    readonly sourcePlugin: string
    readonly sourceRef: string
    readonly objectiveStatus?: string
    readonly nowMs?: number
  }): WithdrawalCascadeResult {
    return this.runInTransaction(() => {
      const matchingNodes = this.#db
        .prepare(`
          SELECT id, source_version, metadata_json FROM assoc_nodes
          WHERE owner_scope_key = ? AND source_plugin = ? AND source_ref = ?
        `)
        .all(input.ownerScopeKey, input.sourcePlugin, input.sourceRef) as Array<{
        id: string
        source_version: number
        metadata_json: string
      }>

      const seeds = matchingNodes.map((row) => ({
        nodeId: row.id,
      }))
      const cascade = this.#cascadeDerivedInCurrentTx(seeds)
      const deletedEdgeSet = new Set(cascade.deletedEdgeIds)
      const suppressedNodeIds: string[] = []
      const nowMs = input.nowMs ?? Date.now()

      const selectIncidentEdges = this.#db.prepare(
        'SELECT edge_id FROM assoc_edges WHERE a_id = ? OR b_id = ?',
      )
      const deleteEdgeById = this.#db.prepare('DELETE FROM assoc_edges WHERE edge_id = ?')
      const deleteDerivedEdgeByTarget = this.#db.prepare(
        "DELETE FROM assoc_derived_from WHERE target_kind = 'edge' AND target_id = ?",
      )
      const updateNodeStmt = this.#db.prepare(`
        UPDATE assoc_nodes
        SET status = 'suppressed', trust = 'low', metadata_json = ?, updated_at = ?
        WHERE id = ?
      `)

      for (const row of matchingNodes) {
        const incident = selectIncidentEdges.all(row.id, row.id) as Array<{ edge_id: string }>
        for (const edge of incident) {
          deletedEdgeSet.add(edge.edge_id)
          deleteEdgeById.run(edge.edge_id)
          deleteDerivedEdgeByTarget.run(edge.edge_id)
        }
        const prevMeta = JSON.parse(row.metadata_json) as Record<string, unknown>
        const nextMeta: Record<string, unknown> = {
          ...prevMeta,
          conflicted: true,
          ...(input.objectiveStatus !== undefined
            ? { objectiveStatus: input.objectiveStatus }
            : {}),
        }
        updateNodeStmt.run(JSON.stringify(nextMeta), nowMs, row.id)
        suppressedNodeIds.push(row.id)
      }

      return {
        deletedNodeIds: cascade.deletedNodeIds,
        suppressedNodeIds,
        deletedEdgeIds: [...deletedEdgeSet],
        deletedSynonymIds: cascade.deletedSynonymIds,
      }
    })
  }

  recordHoldoutAssignment(row: HoldoutAssignmentRow): void {
    this.#db
      .prepare(`
        INSERT OR IGNORE INTO assoc_holdout_assignments (
          task_id, owner_scope_key, task_kind, session_id, turn_number,
          in_holdout, bucket_bps, rate_bps, hmac_digest, assigned_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        row.taskId,
        row.ownerScopeKey,
        row.taskKind,
        row.sessionId,
        row.turnNumber,
        row.inHoldout ? 1 : 0,
        row.bucketBps,
        row.rateBps,
        row.hmacDigest,
        row.assignedAt,
      )
  }

  getHoldoutAssignment(taskId: string): HoldoutAssignmentRow | null {
    const row = this.#db
      .prepare('SELECT * FROM assoc_holdout_assignments WHERE task_id = ?')
      .get(taskId) as
      | {
          task_id: string
          owner_scope_key: string
          task_kind: HoldoutTaskKind
          session_id: string | null
          turn_number: number | null
          in_holdout: number
          bucket_bps: number
          rate_bps: number
          hmac_digest: string
          assigned_at: number
        }
      | undefined
    if (row === undefined) return null
    return {
      taskId: row.task_id,
      ownerScopeKey: row.owner_scope_key,
      taskKind: row.task_kind,
      sessionId: row.session_id,
      turnNumber: row.turn_number,
      inHoldout: row.in_holdout === 1,
      bucketBps: row.bucket_bps,
      rateBps: row.rate_bps,
      hmacDigest: row.hmac_digest,
      assignedAt: row.assigned_at,
    }
  }

  recordMetricsAndExposures(
    metrics: readonly StepMetricRow[],
    exposures: readonly ExposureRow[],
  ): void {
    if (metrics.length === 0 && exposures.length === 0) return
    this.runInTransaction(() => {
      if (metrics.length > 0) {
        const insertMetric = this.#db.prepare(`
          INSERT INTO assoc_step_metrics (
            task_id, owner_scope_key, in_holdout, latency_us, timed_out,
            fallback_mode, injected_count, candidate_count, source_counts_json,
            profile_version, occurred_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        for (const m of metrics) {
          insertMetric.run(
            m.taskId,
            m.ownerScopeKey,
            m.inHoldout ? 1 : 0,
            m.latencyUs,
            m.timedOut ? 1 : 0,
            m.fallbackMode,
            m.injectedCount,
            m.candidateCount,
            JSON.stringify(m.sourceCounts),
            m.profileVersion ?? 0,
            m.occurredAt,
          )
        }
      }

      if (exposures.length > 0) {
        const upsertExposure = this.#db.prepare(`
          INSERT INTO assoc_exposures (
            task_id, node_id, owner_scope_key, source_plugin, exposed_at,
            assoc_read_count, weak_use_count, corrected,
            was_exposed, hop, score, reason, provenance_edges_json, session_id,
            strong_used, weak_used, hebbian_delta_applied, corrected_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_id, node_id) DO UPDATE SET
            was_exposed = MAX(assoc_exposures.was_exposed, excluded.was_exposed),
            hop = CASE WHEN excluded.was_exposed = 1 THEN excluded.hop ELSE assoc_exposures.hop END,
            score = CASE WHEN excluded.was_exposed = 1 THEN excluded.score ELSE assoc_exposures.score END,
            reason = CASE WHEN excluded.was_exposed = 1 AND excluded.reason <> '' THEN excluded.reason ELSE assoc_exposures.reason END,
            provenance_edges_json = CASE
              WHEN excluded.was_exposed = 1 AND excluded.hop = 0 THEN '[]'
              WHEN excluded.was_exposed = 1 AND excluded.provenance_edges_json <> '[]' THEN excluded.provenance_edges_json
              ELSE assoc_exposures.provenance_edges_json
            END,
            session_id = COALESCE(excluded.session_id, assoc_exposures.session_id),
            assoc_read_count = assoc_exposures.assoc_read_count + excluded.assoc_read_count,
            weak_use_count = assoc_exposures.weak_use_count + excluded.weak_use_count,
            strong_used = MAX(assoc_exposures.strong_used, excluded.strong_used),
            weak_used = MAX(assoc_exposures.weak_used, excluded.weak_used),
            hebbian_delta_applied = assoc_exposures.hebbian_delta_applied + excluded.hebbian_delta_applied,
            corrected = MAX(assoc_exposures.corrected, excluded.corrected),
            corrected_at = COALESCE(assoc_exposures.corrected_at, excluded.corrected_at)
        `)
        for (const exp of exposures) {
          const hop = Math.max(0, Math.min(2, Math.trunc(exp.hop ?? 0)))
          upsertExposure.run(
            exp.taskId,
            exp.nodeId,
            exp.ownerScopeKey,
            exp.sourcePlugin,
            exp.exposedAt,
            exp.assocReadCount ?? 0,
            exp.weakUseCount ?? 0,
            exp.corrected ? 1 : 0,
            exp.wasExposed === false ? 0 : 1,
            hop,
            exp.score ?? 0,
            exp.reason ?? '',
            JSON.stringify(exp.provenanceEdges ?? []),
            exp.sessionId ?? null,
            exp.strongUsed ? 1 : 0,
            exp.weakUsed ? 1 : 0,
            exp.hebbianDeltaApplied ?? 0,
            exp.correctedAt ?? null,
          )
        }
      }
    })
  }

  recordReadEvent(event: AssocReadEventInput): void {
    this.#db
      .prepare(`
        INSERT INTO assoc_read_events (
          task_id, node_id, owner_scope_key, hit, reason, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.taskId ?? null,
        event.nodeId,
        event.ownerScopeKey,
        event.hit ? 1 : 0,
        event.reason,
        event.occurredAt,
      )
  }

  upsertTaskTelemetry(input: AssocTaskTelemetryInput): void {
    this.runInTransaction(() => {
      const existing = this.#db
        .prepare(`
          SELECT turns, steps, input_tokens, output_tokens, cost_usd_micros
          FROM assoc_task_telemetry
          WHERE task_id = ?
        `)
        .get(input.taskId) as
        | {
            turns: number
            steps: number
            input_tokens: number | null
            output_tokens: number | null
            cost_usd_micros: number | null
          }
        | undefined

      const turns = Math.max(
        0,
        Math.trunc(input.turns ?? ((existing?.turns ?? 0) + (input.turnsDelta ?? 0))),
      )
      const steps = Math.max(
        0,
        Math.trunc(input.steps ?? ((existing?.steps ?? 0) + (input.stepsDelta ?? 0))),
      )

      const resolveOptionalCounter = (
        abs: number | null | undefined,
        delta: number | null | undefined,
        prev: number | null,
      ): number | null => {
        if (abs !== undefined) return abs
        if (delta !== undefined && delta !== null) {
          return (prev ?? 0) + delta
        }
        return prev
      }

      const inputTokens = resolveOptionalCounter(
        input.inputTokens,
        input.inputTokensDelta,
        existing?.input_tokens ?? null,
      )
      const outputTokens = resolveOptionalCounter(
        input.outputTokens,
        input.outputTokensDelta,
        existing?.output_tokens ?? null,
      )
      const costUsdMicros = resolveOptionalCounter(
        input.costUsdMicros,
        input.costUsdMicrosDelta,
        existing?.cost_usd_micros ?? null,
      )

      this.#db
        .prepare(`
          INSERT INTO assoc_task_telemetry (
            task_id, owner_scope_key, in_holdout, turns, steps,
            input_tokens, output_tokens, cost_usd_micros, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET
            in_holdout = excluded.in_holdout,
            turns = excluded.turns,
            steps = excluded.steps,
            input_tokens = excluded.input_tokens,
            output_tokens = excluded.output_tokens,
            cost_usd_micros = excluded.cost_usd_micros,
            updated_at = excluded.updated_at
        `)
        .run(
          input.taskId,
          input.ownerScopeKey,
          input.inHoldout ? 1 : 0,
          turns,
          steps,
          inputTokens,
          outputTokens,
          costUsdMicros,
          input.updatedAt,
        )
    })
  }

  upsertReplayEpisode(input: AssocReplayEpisodeInput): void {
    this.runInTransaction(() => {
      const existing = this.#db
        .prepare(`
          SELECT cues_json, used_node_ids_json, corrected_node_ids_json, profile_version
          FROM assoc_replay_episodes
          WHERE task_id = ?
        `)
        .get(input.taskId) as
        | {
            cues_json: string
            used_node_ids_json: string
            corrected_node_ids_json: string
            profile_version: number
          }
        | undefined

      const cuesJson =
        input.cues.length > 0 || existing === undefined
          ? JSON.stringify(input.cues)
          : existing.cues_json

      const prevUsed = existing !== undefined ? (JSON.parse(existing.used_node_ids_json) as string[]) : []
      const prevCorrected =
        existing !== undefined ? (JSON.parse(existing.corrected_node_ids_json) as string[]) : []
      const usedIds = mergeUniqueStrings(prevUsed, input.usedNodeIds ?? [])
      const correctedIds = mergeUniqueStrings(prevCorrected, input.correctedNodeIds ?? [])
      const profileVersion = input.profileVersion ?? existing?.profile_version ?? 0

      this.#db
        .prepare(`
          INSERT INTO assoc_replay_episodes (
            task_id, owner_scope_key, in_holdout, cues_json,
            used_node_ids_json, corrected_node_ids_json, profile_version, occurred_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET
            in_holdout = excluded.in_holdout,
            cues_json = excluded.cues_json,
            used_node_ids_json = excluded.used_node_ids_json,
            corrected_node_ids_json = excluded.corrected_node_ids_json,
            profile_version = excluded.profile_version,
            occurred_at = excluded.occurred_at
        `)
        .run(
          input.taskId,
          input.ownerScopeKey,
          input.inHoldout ? 1 : 0,
          cuesJson,
          JSON.stringify(usedIds),
          JSON.stringify(correctedIds),
          profileVersion,
          input.occurredAt,
        )
    })
  }

  hasExposedRow(taskId: string, nodeId: string): boolean {
    const row = this.#db
      .prepare(
        'SELECT 1 AS ok FROM assoc_exposures WHERE task_id = ? AND node_id = ? AND was_exposed = 1',
      )
      .get(taskId, nodeId) as { ok: number } | undefined
    return row !== undefined
  }

  findLatestUncorrectedMemoryExposure(
    ownerScopeKey: string,
    nodeId: string,
    minExposedAt = 0,
  ): StoredExposureRow | null {
    const row = this.#db
      .prepare(`
        SELECT * FROM assoc_exposures
        WHERE owner_scope_key = ?
          AND node_id = ?
          AND was_exposed = 1
          AND corrected = 0
          AND exposed_at >= ?
        ORDER BY (CASE WHEN strong_used = 1 OR weak_used = 1 THEN 1 ELSE 0 END) DESC,
                 exposed_at DESC
        LIMIT 1
      `)
      .get(ownerScopeKey, nodeId, minExposedAt) as RawExposureRow | undefined
    return row === undefined ? null : mapRawExposure(row)
  }

  #taskKindFamilyFallbackClause(
    taskId: string,
  ): { readonly sql: string; readonly params: readonly string[] } | null {
    if (taskId.startsWith('foreground-turn:')) {
      return null
    }
    if (taskId.startsWith('automation-run:')) {
      return { sql: "task_id LIKE 'automation-run:%'", params: [] }
    }
    if (taskId.startsWith('work-item:')) {
      return { sql: "task_id LIKE 'work-item:%'", params: [] }
    }
    if (taskId.startsWith('goal-step:') || taskId.startsWith('goal-outcome:')) {
      return { sql: "(task_id LIKE 'goal-step:%' OR task_id LIKE 'goal-outcome:%')", params: [] }
    }
    if (taskId.startsWith('headless-session:')) {
      return { sql: "task_id LIKE 'headless-session:%'", params: [] }
    }
    const colonIdx = taskId.indexOf(':')
    if (colonIdx > 0) {
      const prefix = taskId.slice(0, colonIdx)
      const escaped = prefix.replace(/[\\%_]/gu, (ch) => `\\${ch}`)
      return { sql: "task_id LIKE ? ESCAPE '\\'", params: [`${escaped}:%`] }
    }
    return { sql: "task_id NOT LIKE '%:%'", params: [] }
  }

  findExposuresByTaskOrSession(
    ownerScopeKey: string,
    taskId: string,
    sessionId?: string | null,
  ): StoredExposureRow[] {
    const byTask = this.#db
      .prepare(`
        SELECT * FROM assoc_exposures
        WHERE owner_scope_key = ? AND task_id = ? AND was_exposed = 1
        ORDER BY exposed_at ASC, node_id ASC
      `)
      .all(ownerScopeKey, taskId) as unknown as RawExposureRow[]
    if (byTask.length > 0) {
      return byTask.map(mapRawExposure)
    }
    const fallbackClause = this.#taskKindFamilyFallbackClause(taskId)
    if (
      fallbackClause !== null &&
      sessionId !== undefined &&
      sessionId !== null &&
      sessionId.length > 0
    ) {
      const bySession = this.#db
        .prepare(`
          SELECT * FROM assoc_exposures
          WHERE owner_scope_key = ? AND session_id = ?
            AND ${fallbackClause.sql}
            AND was_exposed = 1
          ORDER BY exposed_at ASC, node_id ASC
        `)
        .all(ownerScopeKey, sessionId, ...fallbackClause.params) as unknown as RawExposureRow[]
      return bySession.map(mapRawExposure)
    }
    return []
  }

  applyHebbianUse(input: ApplyHebbianUseInput): ApplyHebbianUseResult {
    return this.runInTransaction(() => {
      const cfg = input.hebbianConfig
      const alpha = cfg?.alpha ?? DEFAULT_HEBBIAN_CONFIG.alpha
      const weakRatio = cfg?.weakRatio ?? DEFAULT_HEBBIAN_CONFIG.weakRatio
      const wMin = cfg?.weightMin ?? DEFAULT_HEBBIAN_CONFIG.weightMin
      const wMax = cfg?.weightMax ?? DEFAULT_HEBBIAN_CONFIG.weightMax
      const initWeight = clampEdgeWeight(
        cfg?.initialHebbianWeight ?? DEFAULT_HEBBIAN_CONFIG.initialHebbianWeight,
        wMin,
        wMax,
      )
      const weakDelta = alpha * weakRatio

      const rawExp = this.#db
        .prepare(`
          SELECT * FROM assoc_exposures
          WHERE task_id = ? AND node_id = ?
        `)
        .get(input.taskId, input.nodeId) as RawExposureRow | undefined

      if (
        rawExp === undefined ||
        rawExp.was_exposed !== 1 ||
        rawExp.owner_scope_key !== input.ownerScopeKey ||
        rawExp.corrected === 1
      ) {
        return { appliedDelta: 0, updatedEdges: 0, createdEdges: 0 }
      }

      const exp = mapRawExposure(rawExp)
      let delta = 0
      let nextStrongUsed = exp.strongUsed ? 1 : 0
      let nextWeakUsed = exp.weakUsed ? 1 : 0
      const addReadCount = input.useKind === 'strong' ? 1 : 0
      const addWeakCount = input.useKind === 'weak' ? 1 : 0

      if (input.useKind === 'strong') {
        if (exp.strongUsed) {
          delta = 0
        } else if (exp.weakUsed) {
          const alreadyApplied =
            exp.hebbianDeltaApplied > 0 ? Math.min(alpha, exp.hebbianDeltaApplied) : weakDelta
          delta = Math.max(0, alpha - alreadyApplied)
          nextStrongUsed = 1
        } else {
          delta = Math.max(0, alpha)
          nextStrongUsed = 1
        }
      } else {
        if (exp.strongUsed || exp.weakUsed) {
          delta = 0
        } else {
          delta = Math.max(0, weakDelta)
          nextWeakUsed = 1
        }
      }

      this.#db
        .prepare(`
          UPDATE assoc_exposures
          SET assoc_read_count = assoc_read_count + ?,
              weak_use_count = weak_use_count + ?,
              strong_used = ?,
              weak_used = ?,
              hebbian_delta_applied = hebbian_delta_applied + ?,
              session_id = COALESCE(session_id, ?)
          WHERE task_id = ? AND node_id = ?
        `)
        .run(
          addReadCount,
          addWeakCount,
          nextStrongUsed,
          nextWeakUsed,
          delta,
          input.sessionId ?? null,
          input.taskId,
          input.nodeId,
        )

      if (delta <= 0) {
        return { appliedDelta: 0, updatedEdges: 0, createdEdges: 0 }
      }

      const selectActiveNode = this.#db.prepare(`
        SELECT id, source_version, owner_scope_key, sensitivity, trust
        FROM assoc_nodes
        WHERE id = ? AND status = 'active'
      `)
      const targetNode = selectActiveNode.get(input.nodeId) as
        | {
            id: string
            source_version: number
            owner_scope_key: string
            sensitivity: AssociationSensitivity
            trust: AssociationTrust
          }
        | undefined
      if (targetNode === undefined) {
        return { appliedDelta: delta, updatedEdges: 0, createdEdges: 0 }
      }

      const eventKind = input.useKind === 'strong' ? 'strong-use' : 'weak-use'
      const provenance =
        input.provenanceEdges !== undefined && input.provenanceEdges.length > 0
          ? input.provenanceEdges
          : exp.provenanceEdges

      const selectActiveEdge = this.#db.prepare(`
        SELECT e.edge_id, e.weight
        FROM assoc_edges e
        JOIN assoc_nodes a ON a.id = e.a_id AND a.status = 'active'
        JOIN assoc_nodes b ON b.id = e.b_id AND b.status = 'active'
        WHERE e.edge_id = ?
      `)
      const updateEdgeStmt = this.#db.prepare(`
        UPDATE assoc_edges
        SET weight = ?, use_count = use_count + 1, last_used_at = ?, last_decayed_at = ?, updated_at = ?
        WHERE edge_id = ?
      `)
      const insertHebbianEvent = this.#db.prepare(`
        INSERT INTO assoc_hebbian_events (
          owner_scope_key, task_id, node_id, edge_id, event_kind,
          delta, weight_before, weight_after, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      const processedEdges = new Set<string>()
      let updatedEdges = 0
      let createdEdges = 0

      for (const prov of provenance) {
        if (processedEdges.has(prov.edgeId)) continue
        processedEdges.add(prov.edgeId)
        const edgeRow = selectActiveEdge.get(prov.edgeId) as
          | { edge_id: string; weight: number }
          | undefined
        if (edgeRow === undefined) continue
        const weightBefore = edgeRow.weight
        const weightAfter = clampEdgeWeight(weightBefore + delta, wMin, wMax)
        updateEdgeStmt.run(weightAfter, input.nowMs, input.nowMs, input.nowMs, edgeRow.edge_id)
        insertHebbianEvent.run(
          input.ownerScopeKey,
          input.taskId,
          input.nodeId,
          edgeRow.edge_id,
          eventKind,
          weightAfter - weightBefore,
          weightBefore,
          weightAfter,
          input.nowMs,
        )
        updatedEdges += 1
      }

      if (
        provenance.length === 0 &&
        input.coActivatedNodeIds !== undefined &&
        input.coActivatedNodeIds.length > 0
      ) {
        const insertEdgeStmt = this.#db.prepare(`
          INSERT INTO assoc_edges (
            edge_id, a_id, b_id, edge_type, weight, trust, reason,
            use_count, last_used_at, last_decayed_at, created_at, updated_at
          ) VALUES (?, ?, ?, 'hebbian', ?, ?, 'hebbian:co-use', 1, ?, ?, ?, ?)
        `)
        const insertDerivedStmt = this.#db.prepare(`
          INSERT OR IGNORE INTO assoc_derived_from (
            source_node_id, source_version, target_kind, target_id
          ) VALUES (?, ?, 'edge', ?)
        `)
        const seenPeers = new Set<string>()

        for (const peerId of input.coActivatedNodeIds) {
          if (peerId === input.nodeId || seenPeers.has(peerId)) continue
          seenPeers.add(peerId)
          const peerNode = selectActiveNode.get(peerId) as
            | {
                id: string
                source_version: number
                owner_scope_key: string
                sensitivity: AssociationSensitivity
                trust: AssociationTrust
              }
            | undefined
          if (
            peerNode === undefined ||
            peerNode.owner_scope_key !== input.ownerScopeKey ||
            peerNode.sensitivity !== 'private'
          ) {
            continue
          }

          const [aId, bId] =
            input.nodeId <= peerId ? [input.nodeId, peerId] : [peerId, input.nodeId]
          const hebbianEdgeId = computeDeterministicEdgeId(aId, bId, 'hebbian')
          if (processedEdges.has(hebbianEdgeId)) continue
          processedEdges.add(hebbianEdgeId)

          const existingEdge = selectActiveEdge.get(hebbianEdgeId) as
            | { edge_id: string; weight: number }
            | undefined
          if (existingEdge !== undefined) {
            const weightBefore = existingEdge.weight
            const weightAfter = clampEdgeWeight(weightBefore + delta, wMin, wMax)
            updateEdgeStmt.run(
              weightAfter,
              input.nowMs,
              input.nowMs,
              input.nowMs,
              existingEdge.edge_id,
            )
            insertHebbianEvent.run(
              input.ownerScopeKey,
              input.taskId,
              input.nodeId,
              existingEdge.edge_id,
              eventKind,
              weightAfter - weightBefore,
              weightBefore,
              weightAfter,
              input.nowMs,
            )
            updatedEdges += 1
          } else {
            const createdWeight = clampEdgeWeight(initWeight + delta, wMin, wMax)
            const edgeTrust: AssociationTrust =
              targetNode.trust === 'low' || peerNode.trust === 'low' ? 'low' : 'trusted'
            insertEdgeStmt.run(
              hebbianEdgeId,
              aId,
              bId,
              createdWeight,
              edgeTrust,
              input.nowMs,
              input.nowMs,
              input.nowMs,
              input.nowMs,
            )
            insertDerivedStmt.run(targetNode.id, targetNode.source_version, hebbianEdgeId)
            insertDerivedStmt.run(peerNode.id, peerNode.source_version, hebbianEdgeId)
            insertHebbianEvent.run(
              input.ownerScopeKey,
              input.taskId,
              input.nodeId,
              hebbianEdgeId,
              eventKind,
              createdWeight,
              0,
              createdWeight,
              input.nowMs,
            )
            createdEdges += 1
          }
        }
      }

      return { appliedDelta: delta, updatedEdges, createdEdges }
    })
  }

  applyHebbianCorrection(input: ApplyHebbianCorrectionInput): ApplyHebbianCorrectionResult {
    return this.runInTransaction(() => {
      const cfg = input.hebbianConfig
      const beta = Math.max(0, cfg?.beta ?? DEFAULT_HEBBIAN_CONFIG.beta)
      const wMin = cfg?.weightMin ?? DEFAULT_HEBBIAN_CONFIG.weightMin
      const wMax = cfg?.weightMax ?? DEFAULT_HEBBIAN_CONFIG.weightMax

      let targets: RawExposureRow[] = []
      if (input.taskId !== undefined && input.taskId !== null && input.taskId.length > 0) {
        if (input.nodeId !== undefined && input.nodeId !== null && input.nodeId.length > 0) {
          targets = this.#db
            .prepare(`
              SELECT * FROM assoc_exposures
              WHERE owner_scope_key = ? AND task_id = ? AND node_id = ?
                AND was_exposed = 1 AND corrected = 0
            `)
            .all(input.ownerScopeKey, input.taskId, input.nodeId) as unknown as RawExposureRow[]
        } else {
          targets = this.#db
            .prepare(`
              SELECT * FROM assoc_exposures
              WHERE owner_scope_key = ? AND task_id = ?
                AND was_exposed = 1 AND corrected = 0
            `)
            .all(input.ownerScopeKey, input.taskId) as unknown as RawExposureRow[]
        }
        const fallbackClause = this.#taskKindFamilyFallbackClause(input.taskId)
        if (
          targets.length === 0 &&
          fallbackClause !== null &&
          input.sessionId !== undefined &&
          input.sessionId !== null &&
          input.sessionId.length > 0
        ) {
          targets = this.#db
            .prepare(`
              SELECT * FROM assoc_exposures
              WHERE owner_scope_key = ? AND session_id = ?
                AND ${fallbackClause.sql}
                AND was_exposed = 1 AND corrected = 0
            `)
            .all(
              input.ownerScopeKey,
              input.sessionId,
              ...fallbackClause.params,
            ) as unknown as RawExposureRow[]
        }
      } else if (input.nodeId !== undefined && input.nodeId !== null && input.nodeId.length > 0) {
        const single = this.#db
          .prepare(`
            SELECT * FROM assoc_exposures
            WHERE owner_scope_key = ? AND node_id = ?
              AND was_exposed = 1 AND corrected = 0 AND exposed_at >= ?
            ORDER BY (CASE WHEN strong_used = 1 OR weak_used = 1 THEN 1 ELSE 0 END) DESC,
                     exposed_at DESC
            LIMIT 1
          `)
          .get(input.ownerScopeKey, input.nodeId, input.minExposedAt ?? 0) as
          | RawExposureRow
          | undefined
        if (single !== undefined) {
          targets = [single]
        }
      }

      if (targets.length === 0) {
        return { correctedExposures: 0, updatedEdges: 0 }
      }

      const markCorrectedStmt = this.#db.prepare(`
        UPDATE assoc_exposures
        SET corrected = 1, corrected_at = ?
        WHERE task_id = ? AND node_id = ? AND corrected = 0
      `)
      let correctedExposures = 0
      for (const row of targets) {
        const res = markCorrectedStmt.run(input.nowMs, row.task_id, row.node_id)
        if (res.changes > 0) correctedExposures += 1
      }

      const mapped = targets.map(mapRawExposure)
      const usedTargets = mapped.filter((e) => e.strongUsed || e.weakUsed)
      const penalizedTargets = usedTargets.length > 0 ? usedTargets : mapped

      const edgeCandidates = new Map<string, { taskId: string; nodeId: string }>()
      const selectTaskExposedNodes = this.#db.prepare(`
        SELECT node_id FROM assoc_exposures
        WHERE task_id = ? AND owner_scope_key = ? AND was_exposed = 1
      `)
      const selectIncidentHebbian = this.#db.prepare(`
        SELECT edge_id, a_id, b_id FROM assoc_edges
        WHERE edge_type = 'hebbian' AND (a_id = ? OR b_id = ?)
      `)
      const selectTaskHebbianEvents = this.#db.prepare(`
        SELECT DISTINCT edge_id FROM assoc_hebbian_events
        WHERE owner_scope_key = ? AND task_id = ? AND node_id = ?
          AND event_kind IN ('strong-use', 'weak-use')
      `)

      for (const exp of penalizedTargets) {
        for (const prov of exp.provenanceEdges) {
          if (!edgeCandidates.has(prov.edgeId)) {
            edgeCandidates.set(prov.edgeId, { taskId: exp.taskId, nodeId: exp.nodeId })
          }
        }
        const hebbianEventRows = selectTaskHebbianEvents.all(
          input.ownerScopeKey,
          exp.taskId,
          exp.nodeId,
        ) as Array<{ edge_id: string }>
        for (const ev of hebbianEventRows) {
          if (!edgeCandidates.has(ev.edge_id)) {
            edgeCandidates.set(ev.edge_id, { taskId: exp.taskId, nodeId: exp.nodeId })
          }
        }
        const peerRows = selectTaskExposedNodes.all(exp.taskId, input.ownerScopeKey) as Array<{
          node_id: string
        }>
        const taskPeers = new Set(peerRows.map((p) => p.node_id))
        const incidentHebbian = selectIncidentHebbian.all(exp.nodeId, exp.nodeId) as Array<{
          edge_id: string
          a_id: string
          b_id: string
        }>
        for (const edge of incidentHebbian) {
          const otherId = edge.a_id === exp.nodeId ? edge.b_id : edge.a_id
          if (taskPeers.has(otherId) && !edgeCandidates.has(edge.edge_id)) {
            edgeCandidates.set(edge.edge_id, { taskId: exp.taskId, nodeId: exp.nodeId })
          }
        }
      }

      const selectEdgeWeight = this.#db.prepare(
        'SELECT edge_id, weight FROM assoc_edges WHERE edge_id = ?',
      )
      const updateEdgeWeight = this.#db.prepare(
        'UPDATE assoc_edges SET weight = ?, updated_at = ? WHERE edge_id = ?',
      )
      const insertHebbianEvent = this.#db.prepare(`
        INSERT INTO assoc_hebbian_events (
          owner_scope_key, task_id, node_id, edge_id, event_kind,
          delta, weight_before, weight_after, occurred_at
        ) VALUES (?, ?, ?, ?, 'correction', ?, ?, ?, ?)
      `)

      let updatedEdges = 0
      for (const [edgeId, meta] of edgeCandidates) {
        const edgeRow = selectEdgeWeight.get(edgeId) as
          | { edge_id: string; weight: number }
          | undefined
        if (edgeRow === undefined) continue
        const weightBefore = edgeRow.weight
        const weightAfter = clampEdgeWeight(weightBefore - beta, wMin, wMax)
        updateEdgeWeight.run(weightAfter, input.nowMs, edgeRow.edge_id)
        insertHebbianEvent.run(
          input.ownerScopeKey,
          meta.taskId,
          meta.nodeId,
          edgeRow.edge_id,
          weightAfter - weightBefore,
          weightBefore,
          weightAfter,
          input.nowMs,
        )
        updatedEdges += 1
      }

      return { correctedExposures, updatedEdges }
    })
  }

  applyHebbianDecayBatch(input: ApplyHebbianDecayInput): ApplyHebbianDecayResult {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 200)))
    const wMin = Math.max(0.0, Math.min(10.0, input.weightMin))
    const wMax = Math.max(wMin, Math.min(10.0, input.weightMax))

    return this.runInTransaction(() => {
      const rows = this.#db
        .prepare(`
          SELECT e.edge_id, e.a_id, e.weight, e.last_used_at, e.created_at, e.last_decayed_at,
                 a.owner_scope_key
          FROM assoc_edges e
          JOIN assoc_nodes a ON a.id = e.a_id
          WHERE e.weight > ?
            AND COALESCE(e.last_used_at, e.created_at) <= ?
            AND COALESCE(e.last_decayed_at, COALESCE(e.last_used_at, e.created_at) + ?) < ?
          ORDER BY COALESCE(e.last_decayed_at, COALESCE(e.last_used_at, e.created_at) + ?) ASC, e.edge_id ASC
          LIMIT ?
        `)
        .all(
          wMin,
          input.nowMs - input.nonUseGraceMs,
          input.nonUseGraceMs,
          input.nowMs,
          input.nonUseGraceMs,
          safeLimit + 1,
        ) as Array<{
        edge_id: string
        a_id: string
        weight: number
        last_used_at: number | null
        created_at: number
        last_decayed_at: number | null
        owner_scope_key: string
      }>

      const hasMore = rows.length > safeLimit
      const batch = hasMore ? rows.slice(0, safeLimit) : rows
      if (batch.length === 0) {
        return { decayedEdges: 0, hasMore: false }
      }

      const updateEdge = this.#db.prepare(`
        UPDATE assoc_edges
        SET weight = ?, last_decayed_at = ?, updated_at = ?
        WHERE edge_id = ?
      `)
      const insertEvent = this.#db.prepare(`
        INSERT INTO assoc_hebbian_events (
          owner_scope_key, task_id, node_id, edge_id, event_kind,
          delta, weight_before, weight_after, occurred_at
        ) VALUES (?, NULL, ?, ?, 'decay', ?, ?, ?, ?)
      `)

      let decayedEdges = 0
      for (const edge of batch) {
        const anchor = edge.last_used_at ?? edge.created_at
        const graceEnd = anchor + input.nonUseGraceMs
        const decayStart = Math.max(edge.last_decayed_at ?? graceEnd, graceEnd)
        const dt = Math.max(0, input.nowMs - decayStart)
        if (dt <= 0 || input.decayHalfLifeMs <= 0) continue

        const baseWeight = clampEdgeWeight(edge.weight, wMin, wMax)
        const decayed =
          baseWeight * Math.exp((-Math.LN2 * dt) / input.decayHalfLifeMs)
        const weightAfter = clampEdgeWeight(decayed, wMin, wMax)
        updateEdge.run(weightAfter, input.nowMs, input.nowMs, edge.edge_id)
        insertEvent.run(
          edge.owner_scope_key,
          edge.a_id,
          edge.edge_id,
          weightAfter - edge.weight,
          edge.weight,
          weightAfter,
          input.nowMs,
        )
        decayedEdges += 1
      }

      return { decayedEdges, hasMore }
    })
  }
}
