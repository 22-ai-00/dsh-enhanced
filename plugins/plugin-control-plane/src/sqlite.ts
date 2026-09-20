import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const controlPlaneSchemaVersion = 22

const hostAttestationDispatchesSchema = `CREATE TABLE IF NOT EXISTS host_attestation_dispatches (
  operation_id TEXT PRIMARY KEY REFERENCES host_attestation_operations(operation_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status IN ('claimed','completed')),
  claimed_at INTEGER NOT NULL, completed_at INTEGER,
  CHECK((status = 'claimed' AND completed_at IS NULL) OR (status = 'completed' AND completed_at IS NOT NULL AND completed_at >= claimed_at))
) STRICT, WITHOUT ROWID;`

const taskObservationsSchema = `CREATE TABLE IF NOT EXISTS task_observation_batches (
  id TEXT PRIMARY KEY, lane TEXT NOT NULL, plan_id TEXT NOT NULL REFERENCES activation_plans(id) ON DELETE RESTRICT,
  batch_json TEXT NOT NULL CHECK(json_valid(batch_json) AND json_type(batch_json) = 'object'),
  batch_digest TEXT NOT NULL CHECK(length(batch_digest) = 64),
  state TEXT NOT NULL CHECK(state IN ('pending','signed','applied','stale')),
  receipt_json TEXT CHECK(receipt_json IS NULL OR (json_valid(receipt_json) AND json_type(receipt_json) = 'object')),
  receipt_digest TEXT CHECK(receipt_digest IS NULL OR length(receipt_digest) = 64),
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS task_observation_batches_lane ON task_observation_batches(lane, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS task_observation_batches_open_lane ON task_observation_batches(lane) WHERE state IN ('pending','signed');`

const foregroundDeploymentsSchema = `CREATE TABLE IF NOT EXISTS foreground_deployments (
  inbox_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES activation_plans(id) ON DELETE RESTRICT,
  record_json TEXT NOT NULL CHECK(json_valid(record_json) AND json_type(record_json) = 'object'),
  record_digest TEXT NOT NULL CHECK(length(record_digest) = 64)
) STRICT, WITHOUT ROWID;`

const sourceAdoptionsSchema = `CREATE TABLE IF NOT EXISTS source_adoptions (
  source_plan_id TEXT PRIMARY KEY REFERENCES source_plans(id) ON DELETE RESTRICT,
  activation_plan_id TEXT NOT NULL UNIQUE REFERENCES activation_plans(id) ON DELETE RESTRICT,
  binding_json TEXT NOT NULL CHECK(json_valid(binding_json) AND json_type(binding_json) = 'object'),
  binding_digest TEXT NOT NULL CHECK(length(binding_digest) = 64),
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;`

export function controlPlaneOperationReceiptDigest(idempotencyKey: string, operation: string, inputDigest: string,
  resultJson: string, createdAt: number): string {
  return createHash('sha256').update(JSON.stringify([idempotencyKey, operation, inputDigest, resultJson, createdAt])).digest('hex')
}

export class ControlPlaneDatabaseError extends Error {
  constructor(readonly code: 'invalid-path' | 'schema-too-new' | 'unsafe-file', message: string) {
    super(message)
    this.name = 'ControlPlaneDatabaseError'
  }
}

function assertPrivateRegularFile(path: string): void {
  const value = lstatSync(path)
  const uid = process.getuid?.()
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1
    || (value.mode & 0o077) !== 0 || (uid !== undefined && value.uid !== uid)) {
    throw new ControlPlaneDatabaseError('unsafe-file', 'plugin-control-plane database must be a private, owner-owned regular file')
  }
}

function prepare(path: string): void {
  if (!isAbsolute(path)) throw new ControlPlaneDatabaseError('invalid-path', 'plugin-control-plane database path must be absolute')
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const directoryStat = lstatSync(directory)
  const uid = process.getuid?.()
  // The leaf directory itself must be a private, owner-owned real directory.
  // A symlinked ancestor (for example a distro that exposes $HOME through a
  // symlink such as /home/<user> -> /data00/home/<user>) is out of this
  // plugin's control and is tolerated, matching the sibling sqlite bundles.
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || (directoryStat.mode & 0o077) !== 0 || (uid !== undefined && directoryStat.uid !== uid)) {
    throw new ControlPlaneDatabaseError('unsafe-file', 'plugin-control-plane database directory must be a private, owner-owned real directory')
  }
  if (!existsSync(path)) closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600))
  assertPrivateRegularFile(path)
  for (const sidecar of [`${path}-wal`, `${path}-shm`]) if (existsSync(sidecar)) assertPrivateRegularFile(sidecar)
}

function createCurrent(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE capability_gaps (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      input_digest TEXT NOT NULL CHECK(length(input_digest) = 64),
      capability TEXT NOT NULL,
      context TEXT NOT NULL,
      expected_value REAL NOT NULL CHECK(expected_value >= 0),
      frequency REAL NOT NULL CHECK(frequency > 0),
      estimated_cost REAL NOT NULL CHECK(estimated_cost > 0),
      risk REAL NOT NULL CHECK(risk >= 0 AND risk <= 1),
      roi REAL NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open', 'matched', 'closed')),
      candidate_id TEXT,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE owner_task_failure_gaps (
      gap_id TEXT PRIMARY KEY REFERENCES capability_gaps(id) ON DELETE RESTRICT,
      reference_json TEXT NOT NULL CHECK(json_valid(reference_json) AND json_type(reference_json) = 'object'),
      reference_digest TEXT NOT NULL CHECK(length(reference_digest) = 64)
    ) STRICT, WITHOUT ROWID;


    CREATE TABLE activation_plans (
      id TEXT PRIMARY KEY,
      plan_digest TEXT NOT NULL UNIQUE CHECK(length(plan_digest) = 64),
      gap_id TEXT NOT NULL,
      gap_snapshot_json TEXT NOT NULL CHECK(json_valid(gap_snapshot_json) AND json_type(gap_snapshot_json) = 'object'),
      profile TEXT NOT NULL,
      candidate_json TEXT NOT NULL CHECK(json_valid(candidate_json) AND json_type(candidate_json) = 'object'),
      dossier_json TEXT NOT NULL CHECK(json_valid(dossier_json) AND json_type(dossier_json) = 'object'),
      installation_id TEXT NOT NULL,
      ledger_id TEXT NOT NULL,
      ledger_path TEXT NOT NULL,
      dsh_home TEXT NOT NULL,
      target_path TEXT NOT NULL,
      executor_id TEXT NOT NULL,
      executor_version TEXT NOT NULL,
      executor_path TEXT NOT NULL,
      executor_digest TEXT NOT NULL CHECK(length(executor_digest) = 64),
      status TEXT NOT NULL CHECK(status IN (
        'pending-approval', 'approved', 'staging', 'awaiting-reload',
        'awaiting-readiness', 'awaiting-effect-blocked-replay', 'awaiting-shadow',
        'awaiting-canary', 'awaiting-soak', 'awaiting-health',
        'commit-pending', 'rollback-pending', 'activated', 'rolled-back'
      )),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
      approval_json TEXT CHECK(approval_json IS NULL OR json_valid(approval_json)),
      approval_receipt_json TEXT CHECK(approval_receipt_json IS NULL OR (json_valid(approval_receipt_json) AND json_type(approval_receipt_json) = 'object')),
      activation_id TEXT,
      activation_fence INTEGER NOT NULL DEFAULT 0 CHECK(activation_fence >= 0),
      activation_lease_until INTEGER,
      activation_target_existed INTEGER CHECK(activation_target_existed IN (0, 1)),
      activation_target_baseline_json TEXT CHECK(activation_target_baseline_json IS NULL OR (json_valid(activation_target_baseline_json) AND json_type(activation_target_baseline_json) = 'array')),
      host_recovery_required INTEGER NOT NULL DEFAULT 0 CHECK(host_recovery_required IN (0, 1)),
      rollback_profile_restored INTEGER NOT NULL DEFAULT 0 CHECK(rollback_profile_restored IN (0, 1)),
      failure_code TEXT,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(gap_id) REFERENCES capability_gaps(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE INDEX activation_plans_status ON activation_plans(status, updated_at, id);
    CREATE UNIQUE INDEX activation_plans_active_target ON activation_plans(target_path) WHERE status IN (
      'staging', 'awaiting-reload', 'awaiting-readiness', 'awaiting-effect-blocked-replay',
      'awaiting-shadow', 'awaiting-canary', 'awaiting-soak', 'awaiting-health',
      'commit-pending', 'rollback-pending'
    );

    CREATE TABLE source_plans (
      id TEXT PRIMARY KEY,
      plan_digest TEXT NOT NULL UNIQUE CHECK(length(plan_digest) = 64),
      gap_id TEXT NOT NULL,
      gap_snapshot_json TEXT NOT NULL CHECK(json_valid(gap_snapshot_json) AND json_type(gap_snapshot_json) = 'object'),
      repository TEXT NOT NULL,
      worktree TEXT NOT NULL,
      base_commit TEXT NOT NULL CHECK(length(base_commit) = 40),
      plugin_name TEXT NOT NULL,
      generator_digest TEXT NOT NULL CHECK(length(generator_digest) = 64),
      scope_json TEXT NOT NULL CHECK(json_valid(scope_json) AND json_type(scope_json) = 'array'),
      mode TEXT NOT NULL DEFAULT 'create' CHECK(mode IN ('create', 'modify')),
      status TEXT NOT NULL CHECK(status IN (
        'expired', 'pending-approval', 'approved', 'running-local-checks', 'ready-for-human-review', 'local-checks-failed',
        'awaiting-pr', 'awaiting-review', 'awaiting-merge', 'awaiting-build', 'awaiting-sign', 'awaiting-publish',
        'awaiting-registry-verify', 'awaiting-catalog-admission', 'release-complete', 'release-failed', 'publish-ambiguous'
      )),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
      approval_json TEXT CHECK(approval_json IS NULL OR json_valid(approval_json)),
      checked_tree_digest TEXT CHECK(checked_tree_digest IS NULL OR (length(checked_tree_digest) = 64 AND checked_tree_digest NOT GLOB '*[^a-f0-9]*')),
      checked_patch_digest TEXT CHECK(checked_patch_digest IS NULL OR (length(checked_patch_digest) = 64 AND checked_patch_digest NOT GLOB '*[^a-f0-9]*')),
      checked_at INTEGER,
      prepared_evidence_json TEXT CHECK(prepared_evidence_json IS NULL OR
        (json_valid(prepared_evidence_json) AND json_type(prepared_evidence_json) = 'object')),
      release_authorization_json TEXT CHECK(release_authorization_json IS NULL OR (json_valid(release_authorization_json) AND json_type(release_authorization_json) = 'object')),
      release_authorization_digest TEXT CHECK(release_authorization_digest IS NULL OR length(release_authorization_digest) = 64),
      release_id TEXT,
      release_fence INTEGER NOT NULL DEFAULT 0 CHECK(release_fence >= 0),
      release_failure_phase TEXT CHECK(release_failure_phase IS NULL OR release_failure_phase IN (
        'pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission'
      )),
      release_failure_code TEXT,
      updated_at INTEGER NOT NULL,
      CHECK((checked_tree_digest IS NULL AND checked_patch_digest IS NULL AND checked_at IS NULL) OR
        (checked_tree_digest IS NOT NULL AND checked_patch_digest IS NOT NULL AND checked_at IS NOT NULL)),
      CHECK(mode = 'create' OR
        (checked_tree_digest IS NOT NULL AND checked_patch_digest IS NOT NULL AND checked_at IS NOT NULL)),
      CHECK((mode = 'create' AND prepared_evidence_json IS NULL) OR
        (mode = 'modify' AND prepared_evidence_json IS NOT NULL)),
      CHECK((release_authorization_json IS NULL AND release_authorization_digest IS NULL) OR
        (release_authorization_json IS NOT NULL AND release_authorization_digest IS NOT NULL)),
      FOREIGN KEY(gap_id) REFERENCES capability_gaps(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS source_job_authorities (
      authority_id TEXT PRIMARY KEY,
      authority_digest TEXT NOT NULL CHECK(length(authority_digest) = 64),
      expires_at INTEGER NOT NULL,
      max_submissions INTEGER NOT NULL CHECK(max_submissions >= 1),
      submissions INTEGER NOT NULL CHECK(submissions >= 0 AND submissions <= max_submissions)
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS source_jobs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL UNIQUE,
      authority_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      intent_json TEXT NOT NULL CHECK(json_valid(intent_json) AND json_type(intent_json) = 'object'),
      intent_digest TEXT NOT NULL CHECK(length(intent_digest) = 64),
      status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'prepared', 'failed', 'unknown')),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      definition_hash TEXT,
      occurrence_id TEXT,
      plan_id TEXT UNIQUE,
      failure_code TEXT,
      updated_at INTEGER NOT NULL,
      UNIQUE(authority_id, idempotency_key),
      FOREIGN KEY(authority_id) REFERENCES source_job_authorities(authority_id) ON DELETE RESTRICT,
      FOREIGN KEY(plan_id) REFERENCES source_plans(id) ON DELETE RESTRICT,
      CHECK((status = 'queued' AND occurrence_id IS NULL AND plan_id IS NULL AND failure_code IS NULL)
        OR (status = 'running' AND definition_hash IS NOT NULL AND occurrence_id IS NOT NULL AND plan_id IS NULL AND failure_code IS NULL)
        OR (status = 'prepared' AND definition_hash IS NOT NULL AND occurrence_id IS NOT NULL AND plan_id IS NOT NULL AND failure_code IS NULL)
        OR (status = 'failed' AND plan_id IS NULL AND failure_code IS NOT NULL)
        OR (status = 'unknown' AND definition_hash IS NOT NULL AND occurrence_id IS NOT NULL AND plan_id IS NULL AND failure_code IS NOT NULL))
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS source_jobs_single_active ON source_jobs((1)) WHERE status IN ('queued', 'running', 'unknown');
    CREATE INDEX IF NOT EXISTS source_jobs_created ON source_jobs(created_at, id);

    CREATE TABLE gap_plan_claims (
      gap_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL UNIQUE,
      plan_kind TEXT NOT NULL CHECK(plan_kind IN ('activation', 'source')),
      claimed_at INTEGER NOT NULL,
      FOREIGN KEY(gap_id) REFERENCES capability_gaps(id) ON DELETE RESTRICT
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS host_attestations (
      plan_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('reload', 'readiness', 'effect-blocked-replay', 'shadow', 'canary', 'soak', 'health', 'rollback')),
      receipt_id TEXT NOT NULL UNIQUE,
      receipt_digest TEXT NOT NULL CHECK(length(receipt_digest) = 64),
      receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND json_type(receipt_json) = 'object'),
      host_generation INTEGER NOT NULL CHECK(host_generation >= 1),
      created_at INTEGER NOT NULL,
      PRIMARY KEY(plan_id, phase),
      FOREIGN KEY(plan_id) REFERENCES activation_plans(id) ON DELETE RESTRICT
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS host_attestation_operations (
      plan_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('reload', 'readiness', 'effect-blocked-replay', 'shadow', 'canary', 'soak', 'health', 'rollback')),
      operation_id TEXT NOT NULL UNIQUE,
      binding_digest TEXT NOT NULL CHECK(length(binding_digest) = 64),
      request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
      request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json) = 'object'),
      status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'applied')),
      receipt_digest TEXT CHECK(receipt_digest IS NULL OR length(receipt_digest) = 64),
      receipt_json TEXT CHECK(receipt_json IS NULL OR (json_valid(receipt_json) AND json_type(receipt_json) = 'object')),
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      applied_at INTEGER,
      PRIMARY KEY(plan_id, phase),
      FOREIGN KEY(plan_id) REFERENCES activation_plans(id) ON DELETE RESTRICT
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE source_release_operations (
      plan_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission')),
      release_id TEXT NOT NULL,
      release_fence INTEGER NOT NULL CHECK(release_fence >= 1),
      attempt INTEGER NOT NULL CHECK(attempt >= 1),
      operation_id TEXT NOT NULL UNIQUE,
      binding_digest TEXT NOT NULL CHECK(length(binding_digest) = 64),
      request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
      request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json) = 'object'),
      status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'applied')),
      receipt_digest TEXT CHECK(receipt_digest IS NULL OR length(receipt_digest) = 64),
      receipt_json TEXT CHECK(receipt_json IS NULL OR (json_valid(receipt_json) AND json_type(receipt_json) = 'object')),
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      applied_at INTEGER,
      PRIMARY KEY(plan_id, phase, attempt),
      UNIQUE(plan_id, phase, release_fence),
      CHECK(
        (status = 'pending' AND receipt_digest IS NULL AND receipt_json IS NULL AND completed_at IS NULL AND applied_at IS NULL) OR
        (status = 'completed' AND receipt_digest IS NOT NULL AND receipt_json IS NOT NULL AND completed_at IS NOT NULL AND applied_at IS NULL) OR
        (status = 'applied' AND receipt_digest IS NOT NULL AND receipt_json IS NOT NULL AND completed_at IS NOT NULL AND applied_at IS NOT NULL)
      ),
      FOREIGN KEY(plan_id) REFERENCES source_plans(id) ON DELETE RESTRICT
    ) STRICT, WITHOUT ROWID;

    -- A release adapter can mutate an external registry.  Its durable dispatch
    -- claim is deliberately separate from the signed receipt: after a crash
    -- between dispatch and receipt persistence, the outcome is unknown and
    -- must be reconciled rather than executed again.
    CREATE TABLE source_release_dispatches (
      operation_id TEXT PRIMARY KEY REFERENCES source_release_operations(operation_id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK(status IN ('claimed', 'completed')),
      claimed_at INTEGER NOT NULL,
      completed_at INTEGER,
      CHECK((status = 'claimed' AND completed_at IS NULL) OR
        (status = 'completed' AND completed_at IS NOT NULL AND completed_at >= claimed_at))
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE host_attestation_dispatches (
      operation_id TEXT PRIMARY KEY REFERENCES host_attestation_operations(operation_id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK(status IN ('claimed', 'completed')),
      claimed_at INTEGER NOT NULL, completed_at INTEGER,
      CHECK((status = 'claimed' AND completed_at IS NULL) OR (status = 'completed' AND completed_at IS NOT NULL AND completed_at >= claimed_at))
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE operation_receipts (
      idempotency_key TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      input_digest TEXT NOT NULL CHECK(length(input_digest) = 64),
      result_json TEXT NOT NULL CHECK(json_valid(result_json)),
      result_digest TEXT NOT NULL CHECK(length(result_digest) = 64),
      created_at INTEGER NOT NULL
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE quarantined_legacy_plans (
      source TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      quarantined_at INTEGER NOT NULL
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE source_publish_reconciliations (
      plan_id TEXT NOT NULL,
      release_id TEXT NOT NULL,
      release_fence INTEGER NOT NULL CHECK(release_fence >= 1),
      attempt INTEGER NOT NULL CHECK(attempt >= 1),
      operation_id TEXT NOT NULL,
      binding_digest TEXT NOT NULL CHECK(length(binding_digest) = 64),
      request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
      request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json) = 'object'),
      status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'applied')),
      receipt_digest TEXT CHECK(receipt_digest IS NULL OR length(receipt_digest) = 64),
      receipt_json TEXT CHECK(receipt_json IS NULL OR (json_valid(receipt_json) AND json_type(receipt_json) = 'object')),
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      applied_at INTEGER,
      PRIMARY KEY(plan_id, attempt),
      UNIQUE(operation_id),
      CHECK(
        (status = 'pending' AND receipt_digest IS NULL AND receipt_json IS NULL AND completed_at IS NULL AND applied_at IS NULL) OR
        (status = 'completed' AND receipt_digest IS NOT NULL AND receipt_json IS NOT NULL AND completed_at IS NOT NULL AND applied_at IS NULL) OR
        (status = 'applied' AND receipt_digest IS NOT NULL AND receipt_json IS NOT NULL AND completed_at IS NOT NULL AND applied_at IS NOT NULL)
      ),
      FOREIGN KEY(plan_id) REFERENCES source_plans(id) ON DELETE RESTRICT
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX source_publish_reconciliations_release ON source_publish_reconciliations(plan_id, release_fence, created_at);

    -- Post-activation quality watch for a promoted plugin cohort. A watch is an
    -- independent lifecycle from the activation state machine: the activated
    -- state has no exit and its backup/stage are physically removed, so
    -- post-promotion quality is tracked here against the exact immutable
    -- package@version+integrity rather than by trying to re-open an activation.
    CREATE TABLE activation_watch (
      plan_id TEXT PRIMARY KEY,
      package_name TEXT NOT NULL,
      package_version TEXT NOT NULL,
      package_integrity TEXT NOT NULL,
      activation_id TEXT NOT NULL,
      fence INTEGER NOT NULL CHECK(fence >= 1),
      state TEXT NOT NULL CHECK(state IN ('watching', 'closed-regressed', 'closed-retracted')),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      last_host_generation INTEGER NOT NULL DEFAULT 0 CHECK(last_host_generation >= 0),
      healthy_observations INTEGER NOT NULL DEFAULT 0 CHECK(healthy_observations >= 0),
      close_disposition TEXT CHECK(close_disposition IS NULL OR close_disposition IN ('regressed', 'retracted')),
      close_at INTEGER,
      close_evidence_id TEXT,
      close_signature_digest TEXT CHECK(close_signature_digest IS NULL OR length(close_signature_digest) = 64),
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK(
        (state = 'watching' AND close_disposition IS NULL AND close_at IS NULL AND close_evidence_id IS NULL AND close_signature_digest IS NULL) OR
        (state IN ('closed-regressed', 'closed-retracted') AND close_disposition IS NOT NULL AND close_at IS NOT NULL
          AND close_evidence_id IS NOT NULL AND close_signature_digest IS NOT NULL)
      ),
      FOREIGN KEY(plan_id) REFERENCES activation_plans(id) ON DELETE RESTRICT
    ) STRICT, WITHOUT ROWID;

    -- Append-only signed observations. Positive healthy rows are kept as
    -- evidence but never close a watch; only a regressed Host observation or an
    -- owner retraction transitions the watch to a terminal state.
    CREATE TABLE activation_watch_evidence (
      observation_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      disposition TEXT NOT NULL CHECK(disposition IN ('regressed', 'healthy', 'retracted')),
      receipt_digest TEXT NOT NULL CHECK(length(receipt_digest) = 64),
      signature_digest TEXT NOT NULL CHECK(length(signature_digest) = 64),
      receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND json_type(receipt_json) = 'object'),
      host_generation INTEGER NOT NULL DEFAULT 0 CHECK(host_generation >= 0),
      failures INTEGER NOT NULL DEFAULT 0 CHECK(failures >= 0),
      checks INTEGER NOT NULL DEFAULT 0 CHECK(checks >= 0),
      created_at INTEGER NOT NULL,
      FOREIGN KEY(plan_id) REFERENCES activation_watch(plan_id) ON DELETE RESTRICT
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX activation_watch_evidence_plan ON activation_watch_evidence(plan_id, created_at);

    -- Core-file pins captured immediately before terminal promotion.  They are
    -- deliberately outside the immutable activation dossier: they describe the
    -- Host-visible deployment and give a post-promotion rollback an ABA-safe
    -- ordering without rewriting the approved plan.
    CREATE TABLE activation_deployment_checkpoints (
      plan_id TEXT PRIMARY KEY REFERENCES activation_plans(id) ON DELETE RESTRICT,
      baseline_json TEXT NOT NULL CHECK(json_valid(baseline_json) AND json_type(baseline_json) = 'array'),
      exposure_order INTEGER NOT NULL UNIQUE CHECK(exposure_order >= 1),
      successful_order INTEGER UNIQUE CHECK(successful_order IS NULL OR successful_order = exposure_order),
      recorded_at INTEGER NOT NULL,
      succeeded_at INTEGER
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX activation_deployment_checkpoints_success ON activation_deployment_checkpoints(successful_order)
      WHERE successful_order IS NOT NULL;
    CREATE TABLE activation_deployment_sequence (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      next_exposure_order INTEGER NOT NULL CHECK(next_exposure_order >= 1)
    ) STRICT, WITHOUT ROWID;
    INSERT INTO activation_deployment_sequence (singleton, next_exposure_order) VALUES (1, 1);

    PRAGMA user_version = 18;
  `)
}

function migrateV1(database: DatabaseSync): void {
  // v1 used mutable JSON plan files and carried no authoritative digest-bound
  // approval. Preserve them only as evidence; none can become activation input.
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
  const evidence: Array<{ source: string; payload: string }> = []
  for (const { name } of tables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new ControlPlaneDatabaseError('unsafe-file', 'legacy database contains an unsafe table name')
    const rows = database.prepare(`SELECT * FROM "${name}"`).all()
    rows.forEach((row, index) => evidence.push({ source: `${name}:${index}`, payload: JSON.stringify(row) }))
  }
  database.exec('BEGIN IMMEDIATE')
  try {
    for (const { name } of tables) database.exec(`DROP TABLE "${name}"`)
    createCurrent(database)
    const insert = database.prepare('INSERT INTO quarantined_legacy_plans (source, reason, payload_json, quarantined_at) VALUES (?, ?, ?, ?)')
    for (const item of evidence) insert.run(item.source, 'legacy-json-approval-is-not-authoritative', item.payload, Date.now())
    database.exec('COMMIT')
  } catch (error) { database.exec('ROLLBACK'); throw error }
}

function migrateV2ToV3(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    ALTER TABLE activation_plans RENAME TO activation_plans_v2;
    CREATE TABLE activation_plans (
      id TEXT PRIMARY KEY,
      plan_digest TEXT NOT NULL UNIQUE CHECK(length(plan_digest) = 64),
      gap_id TEXT,
      profile TEXT NOT NULL,
      candidate_json TEXT NOT NULL CHECK(json_valid(candidate_json) AND json_type(candidate_json) = 'object'),
      status TEXT NOT NULL CHECK(status IN (
        'pending-approval', 'approved', 'staging', 'readiness',
        'effect-blocked-replay', 'soaking', 'rollback-pending', 'activated',
        'rolled-back', 'ready-for-human-review'
      )),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
      approval_json TEXT CHECK(approval_json IS NULL OR json_valid(approval_json)),
      activation_id TEXT,
      activation_fence INTEGER NOT NULL DEFAULT 0 CHECK(activation_fence >= 0),
      activation_lease_until INTEGER,
      failure_code TEXT,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(gap_id) REFERENCES capability_gaps(id) ON DELETE RESTRICT
    ) STRICT;
    INSERT INTO activation_plans SELECT * FROM activation_plans_v2;
    DROP TABLE activation_plans_v2;
    CREATE INDEX activation_plans_status ON activation_plans(status, updated_at, id);
    PRAGMA user_version = 3;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `)
}

function migrateV3ToV4(database: DatabaseSync): void {
  const rows = database.prepare('SELECT * FROM activation_plans').all()
  database.exec('BEGIN IMMEDIATE')
  try {
    const quarantine = database.prepare('INSERT OR REPLACE INTO quarantined_legacy_plans (source, reason, payload_json, quarantined_at) VALUES (?, ?, ?, ?)')
    rows.forEach((row, index) => quarantine.run(`activation_plans_v3:${index}`, 'activation-plan-lacks-installation-target-executor-and-host-attestation-binding', JSON.stringify(row), Date.now()))
    database.exec(`
      DROP INDEX IF EXISTS activation_plans_status;
      DROP TABLE activation_plans;
      CREATE TABLE activation_plans (
        id TEXT PRIMARY KEY,
        plan_digest TEXT NOT NULL UNIQUE CHECK(length(plan_digest) = 64),
        gap_id TEXT NOT NULL,
        gap_snapshot_json TEXT NOT NULL CHECK(json_valid(gap_snapshot_json) AND json_type(gap_snapshot_json) = 'object'),
        profile TEXT NOT NULL,
        candidate_json TEXT NOT NULL CHECK(json_valid(candidate_json) AND json_type(candidate_json) = 'object'),
        dossier_json TEXT NOT NULL CHECK(json_valid(dossier_json) AND json_type(dossier_json) = 'object'),
        installation_id TEXT NOT NULL,
        dsh_home TEXT NOT NULL,
        target_path TEXT NOT NULL,
        executor_id TEXT NOT NULL,
        executor_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'pending-approval', 'approved', 'staging', 'awaiting-reload',
          'awaiting-readiness', 'awaiting-effect-blocked-replay', 'awaiting-shadow',
          'awaiting-canary', 'awaiting-soak', 'awaiting-health',
          'commit-pending', 'rollback-pending', 'activated', 'rolled-back'
        )),
        revision INTEGER NOT NULL CHECK(revision >= 1),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
        approval_json TEXT CHECK(approval_json IS NULL OR json_valid(approval_json)),
        activation_id TEXT,
        activation_fence INTEGER NOT NULL DEFAULT 0 CHECK(activation_fence >= 0),
        activation_lease_until INTEGER,
        failure_code TEXT,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(gap_id) REFERENCES capability_gaps(id) ON DELETE RESTRICT
      ) STRICT;
      CREATE INDEX activation_plans_status ON activation_plans(status, updated_at, id);
      CREATE TABLE source_plans (
        id TEXT PRIMARY KEY, plan_digest TEXT NOT NULL UNIQUE CHECK(length(plan_digest) = 64), gap_id TEXT NOT NULL,
        gap_snapshot_json TEXT NOT NULL CHECK(json_valid(gap_snapshot_json) AND json_type(gap_snapshot_json) = 'object'),
        repository TEXT NOT NULL, worktree TEXT NOT NULL, base_commit TEXT NOT NULL CHECK(length(base_commit) = 40),
        plugin_name TEXT NOT NULL, generator_digest TEXT NOT NULL CHECK(length(generator_digest) = 64),
        scope_json TEXT NOT NULL CHECK(json_valid(scope_json) AND json_type(scope_json) = 'array'),
        status TEXT NOT NULL CHECK(status IN ('pending-approval', 'approved', 'running-local-checks', 'ready-for-human-review', 'local-checks-failed')),
        revision INTEGER NOT NULL CHECK(revision >= 1), created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL CHECK(expires_at > created_at), approval_json TEXT CHECK(approval_json IS NULL OR json_valid(approval_json)),
        updated_at INTEGER NOT NULL, FOREIGN KEY(gap_id) REFERENCES capability_gaps(id) ON DELETE RESTRICT
      ) STRICT;
      CREATE TABLE gap_plan_claims (
        gap_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL UNIQUE,
        plan_kind TEXT NOT NULL CHECK(plan_kind IN ('activation', 'source')), claimed_at INTEGER NOT NULL,
        FOREIGN KEY(gap_id) REFERENCES capability_gaps(id) ON DELETE RESTRICT
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE host_attestations (
        plan_id TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('reload', 'readiness', 'effect-blocked-replay', 'shadow', 'canary', 'soak', 'health')),
        receipt_id TEXT NOT NULL UNIQUE, receipt_digest TEXT NOT NULL CHECK(length(receipt_digest) = 64),
        receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND json_type(receipt_json) = 'object'),
        host_generation INTEGER NOT NULL CHECK(host_generation >= 1), created_at INTEGER NOT NULL,
        PRIMARY KEY(plan_id, phase), FOREIGN KEY(plan_id) REFERENCES activation_plans(id) ON DELETE RESTRICT
      ) STRICT, WITHOUT ROWID;
      DELETE FROM operation_receipts WHERE operation IN ('create-plan', 'approve-plan', 'activate-plan');
      PRAGMA user_version = 4;
    `)
    database.exec('COMMIT')
  } catch (error) { database.exec('ROLLBACK'); throw error }
}

function migrateV4ToV5(database: DatabaseSync): void {
  database.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE activation_plans ADD COLUMN activation_target_existed INTEGER CHECK(activation_target_existed IN (0, 1));
    CREATE UNIQUE INDEX activation_plans_active_target ON activation_plans(target_path) WHERE status IN (
      'staging', 'awaiting-reload', 'awaiting-readiness', 'awaiting-effect-blocked-replay',
      'awaiting-shadow', 'awaiting-canary', 'awaiting-soak', 'awaiting-health',
      'commit-pending', 'rollback-pending'
    );
    PRAGMA user_version = 5;
    COMMIT;
  `)
}

function migrateV5ToV6(database: DatabaseSync): void {
  const rows = database.prepare('SELECT * FROM activation_plans').all() as Array<Record<string, unknown>>
  database.exec('BEGIN IMMEDIATE')
  try {
    const quarantine = database.prepare('INSERT OR REPLACE INTO quarantined_legacy_plans (source, reason, payload_json, quarantined_at) VALUES (?, ?, ?, ?)')
    rows.forEach((row, index) => quarantine.run(`activation_plans_v5:${index}`,
      'activation-plan-lacks-ledger-path-and-executor-file-digest-binding', JSON.stringify(row), Date.now()))
    for (const row of rows) {
      const gapId = row['gap_id']
      if (typeof gapId !== 'string' || gapId === '') throw new Error('legacy activation plan has an invalid gap id')
      database.prepare(`UPDATE capability_gaps SET status = 'open', candidate_id = NULL, revision = revision + 1,
        updated_at = ? WHERE id = ? AND status = 'matched'`).run(Date.now(), gapId)
    }
    database.exec(`
      DELETE FROM operation_receipts WHERE json_extract(result_json, '$.result.id') IN (SELECT id FROM activation_plans);
      DELETE FROM host_attestations;
      DELETE FROM gap_plan_claims WHERE plan_kind = 'activation';
      DELETE FROM activation_plans;
      ALTER TABLE activation_plans ADD COLUMN ledger_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE activation_plans ADD COLUMN ledger_path TEXT NOT NULL DEFAULT '';
      ALTER TABLE activation_plans ADD COLUMN executor_path TEXT NOT NULL DEFAULT '';
      ALTER TABLE activation_plans ADD COLUMN executor_digest TEXT NOT NULL DEFAULT '';
      PRAGMA user_version = 6;
    `)
    database.exec('COMMIT')
  } catch (error) { database.exec('ROLLBACK'); throw error }
}

function migrateV6ToV7(database: DatabaseSync): void {
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE host_attestation_operations (
      plan_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('reload', 'readiness', 'effect-blocked-replay', 'shadow', 'canary', 'soak', 'health')),
      operation_id TEXT NOT NULL UNIQUE,
      binding_digest TEXT NOT NULL CHECK(length(binding_digest) = 64),
      request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
      request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json) = 'object'),
      status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'applied')),
      receipt_digest TEXT CHECK(receipt_digest IS NULL OR length(receipt_digest) = 64),
      receipt_json TEXT CHECK(receipt_json IS NULL OR (json_valid(receipt_json) AND json_type(receipt_json) = 'object')),
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      applied_at INTEGER,
      PRIMARY KEY(plan_id, phase),
      FOREIGN KEY(plan_id) REFERENCES activation_plans(id) ON DELETE RESTRICT
    ) STRICT, WITHOUT ROWID;
    PRAGMA user_version = 7;
    COMMIT;
  `)
}

function migrateV7ToV8(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    ALTER TABLE source_plans RENAME TO source_plans_v7;
    CREATE TABLE source_plans (
      id TEXT PRIMARY KEY,
      plan_digest TEXT NOT NULL UNIQUE CHECK(length(plan_digest) = 64),
      gap_id TEXT NOT NULL,
      gap_snapshot_json TEXT NOT NULL CHECK(json_valid(gap_snapshot_json) AND json_type(gap_snapshot_json) = 'object'),
      repository TEXT NOT NULL,
      worktree TEXT NOT NULL,
      base_commit TEXT NOT NULL CHECK(length(base_commit) = 40),
      plugin_name TEXT NOT NULL,
      generator_digest TEXT NOT NULL CHECK(length(generator_digest) = 64),
      scope_json TEXT NOT NULL CHECK(json_valid(scope_json) AND json_type(scope_json) = 'array'),
      status TEXT NOT NULL CHECK(status IN (
        'pending-approval', 'approved', 'running-local-checks', 'ready-for-human-review', 'local-checks-failed',
        'awaiting-pr', 'awaiting-review', 'awaiting-merge', 'awaiting-build', 'awaiting-sign', 'awaiting-publish',
        'awaiting-registry-verify', 'awaiting-catalog-admission', 'release-complete', 'release-failed', 'publish-ambiguous'
      )),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
      approval_json TEXT CHECK(approval_json IS NULL OR json_valid(approval_json)),
      release_id TEXT,
      release_fence INTEGER NOT NULL DEFAULT 0 CHECK(release_fence >= 0),
      release_failure_phase TEXT CHECK(release_failure_phase IS NULL OR release_failure_phase IN (
        'pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission'
      )),
      release_failure_code TEXT,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(gap_id) REFERENCES capability_gaps(id) ON DELETE RESTRICT
    ) STRICT;
    INSERT INTO source_plans (id, plan_digest, gap_id, gap_snapshot_json, repository, worktree, base_commit,
      plugin_name, generator_digest, scope_json, status, revision, created_at, expires_at, approval_json,
      release_id, release_fence, release_failure_phase, release_failure_code, updated_at)
      SELECT id, plan_digest, gap_id, gap_snapshot_json, repository, worktree, base_commit, plugin_name,
        generator_digest, scope_json, status, revision, created_at, expires_at, approval_json,
        NULL, 0, NULL, NULL, updated_at FROM source_plans_v7;
    DROP TABLE source_plans_v7;
    CREATE TABLE source_release_operations (
      plan_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission')),
      operation_id TEXT NOT NULL UNIQUE,
      binding_digest TEXT NOT NULL CHECK(length(binding_digest) = 64),
      request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
      request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json) = 'object'),
      status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'applied')),
      receipt_digest TEXT CHECK(receipt_digest IS NULL OR length(receipt_digest) = 64),
      receipt_json TEXT CHECK(receipt_json IS NULL OR (json_valid(receipt_json) AND json_type(receipt_json) = 'object')),
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      applied_at INTEGER,
      PRIMARY KEY(plan_id, phase),
      FOREIGN KEY(plan_id) REFERENCES source_plans(id) ON DELETE RESTRICT
    ) STRICT, WITHOUT ROWID;
    PRAGMA user_version = 8;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `)
}

function migrateV8ToV9(database: DatabaseSync): void {
  const sourceColumns = new Set((database.prepare('PRAGMA table_info(source_plans)').all() as Array<{ name: string }>).map(column => column.name))
  const addSourceColumns = [
    sourceColumns.has('checked_tree_digest') ? '' : "ALTER TABLE source_plans ADD COLUMN checked_tree_digest TEXT CHECK(checked_tree_digest IS NULL OR (length(checked_tree_digest) = 64 AND checked_tree_digest NOT GLOB '*[^a-f0-9]*'));",
    sourceColumns.has('checked_patch_digest') ? '' : "ALTER TABLE source_plans ADD COLUMN checked_patch_digest TEXT CHECK(checked_patch_digest IS NULL OR (length(checked_patch_digest) = 64 AND checked_patch_digest NOT GLOB '*[^a-f0-9]*'));",
    sourceColumns.has('checked_at') ? '' : 'ALTER TABLE source_plans ADD COLUMN checked_at INTEGER;',
    sourceColumns.has('release_authorization_json') ? '' : `ALTER TABLE source_plans ADD COLUMN release_authorization_json TEXT
      CHECK(release_authorization_json IS NULL OR (json_valid(release_authorization_json) AND json_type(release_authorization_json) = 'object'));`,
    sourceColumns.has('release_authorization_digest') ? '' : 'ALTER TABLE source_plans ADD COLUMN release_authorization_digest TEXT CHECK(release_authorization_digest IS NULL OR length(release_authorization_digest) = 64);',
  ].join('\n')
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    -- The table did not exist in released v8. Keeping this cleanup inside the
    -- transaction also makes interrupted-development migrations atomic.
    DROP TABLE IF EXISTS source_publish_reconciliations;
    ${addSourceColumns}
    UPDATE source_plans SET status = 'release-failed', release_failure_code = 'legacy-unverifiable-release',
      release_failure_phase = CASE status
        WHEN 'awaiting-pr' THEN 'pr' WHEN 'awaiting-review' THEN 'review' WHEN 'awaiting-merge' THEN 'merge'
        WHEN 'awaiting-build' THEN 'build' WHEN 'awaiting-sign' THEN 'sign' WHEN 'awaiting-publish' THEN 'publish'
        WHEN 'awaiting-registry-verify' THEN 'registry-verify' WHEN 'awaiting-catalog-admission' THEN 'catalog-admission'
        WHEN 'publish-ambiguous' THEN 'publish' WHEN 'release-complete' THEN 'catalog-admission' ELSE release_failure_phase END,
      revision = revision + 1, updated_at = CASE WHEN updated_at < created_at THEN created_at ELSE updated_at END
      WHERE status IN ('awaiting-pr', 'awaiting-review', 'awaiting-merge', 'awaiting-build', 'awaiting-sign',
        'awaiting-publish', 'awaiting-registry-verify', 'awaiting-catalog-admission', 'publish-ambiguous', 'release-complete');
    ALTER TABLE source_release_operations RENAME TO source_release_operations_v8;
    CREATE TABLE source_release_operations (
      plan_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission')),
      release_id TEXT NOT NULL,
      release_fence INTEGER NOT NULL CHECK(release_fence >= 1),
      attempt INTEGER NOT NULL CHECK(attempt >= 1),
      operation_id TEXT NOT NULL UNIQUE,
      binding_digest TEXT NOT NULL CHECK(length(binding_digest) = 64),
      request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
      request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json) = 'object'),
      status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'applied')),
      receipt_digest TEXT CHECK(receipt_digest IS NULL OR length(receipt_digest) = 64),
      receipt_json TEXT CHECK(receipt_json IS NULL OR (json_valid(receipt_json) AND json_type(receipt_json) = 'object')),
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      applied_at INTEGER,
      PRIMARY KEY(plan_id, phase, attempt),
      UNIQUE(plan_id, phase, release_fence),
      CHECK(
        (status = 'pending' AND receipt_digest IS NULL AND receipt_json IS NULL AND completed_at IS NULL AND applied_at IS NULL) OR
        (status = 'completed' AND receipt_digest IS NOT NULL AND receipt_json IS NOT NULL AND completed_at IS NOT NULL AND applied_at IS NULL) OR
        (status = 'applied' AND receipt_digest IS NOT NULL AND receipt_json IS NOT NULL AND completed_at IS NOT NULL AND applied_at IS NOT NULL)
      ),
      FOREIGN KEY(plan_id) REFERENCES source_plans(id) ON DELETE RESTRICT
    ) STRICT, WITHOUT ROWID;
    INSERT OR REPLACE INTO quarantined_legacy_plans (source, reason, payload_json, quarantined_at)
      SELECT 'source_release_operations_v8:' || operation_id, 'release-operation-lacks-post-check-authorization-and-attempt-binding',
        json_object('plan_id', plan_id, 'phase', phase, 'operation_id', operation_id, 'binding_digest', binding_digest,
          'request_digest', request_digest, 'request_json', json(request_json), 'status', status,
          'receipt_digest', receipt_digest, 'receipt_json', CASE WHEN receipt_json IS NULL THEN NULL ELSE json(receipt_json) END,
          'created_at', created_at, 'completed_at', completed_at, 'applied_at', applied_at),
        CAST(strftime('%s', 'now') AS INTEGER) * 1000
      FROM source_release_operations_v8;
    DROP TABLE source_release_operations_v8;
    CREATE TABLE source_publish_reconciliations (
      plan_id TEXT NOT NULL,
      release_id TEXT NOT NULL,
      release_fence INTEGER NOT NULL CHECK(release_fence >= 1),
      attempt INTEGER NOT NULL CHECK(attempt >= 1),
      operation_id TEXT NOT NULL,
      binding_digest TEXT NOT NULL CHECK(length(binding_digest) = 64),
      request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
      request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json) = 'object'),
      status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'applied')),
      receipt_digest TEXT CHECK(receipt_digest IS NULL OR length(receipt_digest) = 64),
      receipt_json TEXT CHECK(receipt_json IS NULL OR (json_valid(receipt_json) AND json_type(receipt_json) = 'object')),
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      applied_at INTEGER,
      PRIMARY KEY(plan_id, attempt),
      UNIQUE(operation_id),
      CHECK(
        (status = 'pending' AND receipt_digest IS NULL AND receipt_json IS NULL AND completed_at IS NULL AND applied_at IS NULL) OR
        (status = 'completed' AND receipt_digest IS NOT NULL AND receipt_json IS NOT NULL AND completed_at IS NOT NULL AND applied_at IS NULL) OR
        (status = 'applied' AND receipt_digest IS NOT NULL AND receipt_json IS NOT NULL AND completed_at IS NOT NULL AND applied_at IS NOT NULL)
      ),
      FOREIGN KEY(plan_id) REFERENCES source_plans(id) ON DELETE RESTRICT
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX source_publish_reconciliations_release ON source_publish_reconciliations(plan_id, release_fence, created_at);
    PRAGMA user_version = 9;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `)
}

function migrateV9ToV10(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    const columns = new Set((database.prepare('PRAGMA table_info(operation_receipts)').all() as Array<{ name: string }>).map(column => column.name))
    const hadDigest = columns.has('result_digest')
    const receipts = database.prepare(`SELECT idempotency_key, operation, input_digest, result_json,
      ${hadDigest ? 'result_digest' : 'NULL AS result_digest'}, created_at FROM operation_receipts`).all() as Array<{
        idempotency_key: string; operation: string; input_digest: string; result_json: string; result_digest: string | null; created_at: number
      }>
    database.exec(`
      ALTER TABLE operation_receipts RENAME TO operation_receipts_v9;
      CREATE TABLE operation_receipts (
        idempotency_key TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        input_digest TEXT NOT NULL CHECK(length(input_digest) = 64),
        result_json TEXT NOT NULL CHECK(json_valid(result_json)),
        result_digest TEXT NOT NULL CHECK(length(result_digest) = 64),
        created_at INTEGER NOT NULL
      ) STRICT, WITHOUT ROWID;
    `)
    const insert = database.prepare(`INSERT INTO operation_receipts
      (idempotency_key, operation, input_digest, result_json, result_digest, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    const quarantine = database.prepare(`INSERT OR REPLACE INTO quarantined_legacy_plans
      (source, reason, payload_json, quarantined_at) VALUES (?, ?, ?, ?)`)
    for (const row of receipts) {
      const digest = controlPlaneOperationReceiptDigest(row.idempotency_key, row.operation, row.input_digest, row.result_json, row.created_at)
      if (!hadDigest || row.result_digest === null) {
        quarantine.run('operation_receipts_v9:' + row.idempotency_key, 'operation-receipt-lacks-full-envelope-digest',
          JSON.stringify({ idempotencyKey: row.idempotency_key, operation: row.operation, inputDigest: row.input_digest,
            result: JSON.parse(row.result_json) as unknown, createdAt: row.created_at }), Date.now())
        continue
      }
      if (row.result_digest !== digest) {
        throw new ControlPlaneDatabaseError('unsafe-file', 'schema-v9 operation receipt digest is corrupt')
      }
      insert.run(row.idempotency_key, row.operation, row.input_digest, row.result_json, digest, row.created_at)
    }
    database.exec('DROP TABLE operation_receipts_v9; PRAGMA user_version = 10; COMMIT')
  } catch (error) { database.exec('ROLLBACK'); throw error }
}

function migrateV10ToV11(database: DatabaseSync): void {
  const columns = new Set((database.prepare('PRAGMA table_info(activation_plans)').all() as Array<{ name: string }>).map(column => column.name))
  database.exec('BEGIN IMMEDIATE')
  try {
    if (!columns.has('approval_receipt_json')) {
      database.exec(`ALTER TABLE activation_plans ADD COLUMN approval_receipt_json TEXT
        CHECK(approval_receipt_json IS NULL OR (json_valid(approval_receipt_json) AND json_type(approval_receipt_json) = 'object'))`)
    }
    database.exec('PRAGMA user_version = 11; COMMIT')
  } catch (error) { database.exec('ROLLBACK'); throw error }
}

function migrateV11ToV12(database: DatabaseSync): void {
  // IF NOT EXISTS makes the migration idempotent when a database was created with
  // the current schema and its user_version was rolled back to exercise the full
  // migration chain (the v6/v8 fixtures do this). A real v11 database can never
  // contain these table names, so the guard cannot mask a structurally different
  // legacy table in production.
  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS activation_watch (
        plan_id TEXT PRIMARY KEY,
        package_name TEXT NOT NULL,
        package_version TEXT NOT NULL,
        package_integrity TEXT NOT NULL,
        activation_id TEXT NOT NULL,
        fence INTEGER NOT NULL CHECK(fence >= 1),
        state TEXT NOT NULL CHECK(state IN ('watching', 'closed-regressed', 'closed-retracted')),
        revision INTEGER NOT NULL CHECK(revision >= 1),
        last_host_generation INTEGER NOT NULL DEFAULT 0 CHECK(last_host_generation >= 0),
        healthy_observations INTEGER NOT NULL DEFAULT 0 CHECK(healthy_observations >= 0),
        close_disposition TEXT CHECK(close_disposition IS NULL OR close_disposition IN ('regressed', 'retracted')),
        close_at INTEGER,
        close_evidence_id TEXT,
        close_signature_digest TEXT CHECK(close_signature_digest IS NULL OR length(close_signature_digest) = 64),
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK(
          (state = 'watching' AND close_disposition IS NULL AND close_at IS NULL AND close_evidence_id IS NULL AND close_signature_digest IS NULL) OR
          (state IN ('closed-regressed', 'closed-retracted') AND close_disposition IS NOT NULL AND close_at IS NOT NULL
            AND close_evidence_id IS NOT NULL AND close_signature_digest IS NOT NULL)
        ),
        FOREIGN KEY(plan_id) REFERENCES activation_plans(id) ON DELETE RESTRICT
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS activation_watch_evidence (
        observation_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK(disposition IN ('regressed', 'healthy', 'retracted')),
        receipt_digest TEXT NOT NULL CHECK(length(receipt_digest) = 64),
        signature_digest TEXT NOT NULL CHECK(length(signature_digest) = 64),
        receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND json_type(receipt_json) = 'object'),
        host_generation INTEGER NOT NULL DEFAULT 0 CHECK(host_generation >= 0),
        failures INTEGER NOT NULL DEFAULT 0 CHECK(failures >= 0),
        checks INTEGER NOT NULL DEFAULT 0 CHECK(checks >= 0),
        created_at INTEGER NOT NULL,
        FOREIGN KEY(plan_id) REFERENCES activation_watch(plan_id) ON DELETE RESTRICT
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS activation_watch_evidence_plan ON activation_watch_evidence(plan_id, created_at);
    `)
    // Backfill watches for plans already promoted before the watch lifecycle existed.
    // The exact target is reconstructed from the immutable candidate snapshot pinned
    // in the plan row (candidate_json), never from a mutable current catalog.
    const activated = database.prepare(`SELECT id, candidate_json, activation_id, activation_fence, updated_at
      FROM activation_plans WHERE status = 'activated'`).all() as Array<{
        id: string; candidate_json: string; activation_id: string | null; activation_fence: number; updated_at: number
      }>
    const insert = database.prepare(`INSERT INTO activation_watch (plan_id, package_name, package_version, package_integrity,
      activation_id, fence, state, revision, last_host_generation, healthy_observations, started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'watching', 1, 0, 0, ?, ?)`)
    for (const row of activated) {
      const candidate = JSON.parse(row.candidate_json) as { package?: unknown; version?: unknown; integrity?: unknown }
      if (typeof candidate.package !== 'string' || typeof candidate.version !== 'string' || typeof candidate.integrity !== 'string'
        || typeof row.activation_id !== 'string' || row.activation_fence < 1) {
        throw new ControlPlaneDatabaseError('unsafe-file', 'legacy activated plan has an invalid immutable candidate binding')
      }
      insert.run(row.id, candidate.package, candidate.version, candidate.integrity,
        row.activation_id, row.activation_fence, row.updated_at, row.updated_at)
    }
    database.exec('PRAGMA user_version = 12; COMMIT')
  } catch (error) { database.exec('ROLLBACK'); throw error }
}

function migrateV12ToV13(database: DatabaseSync): void {
  // Add the 'modify' source-plan mode: a growth executor may prepare a patch for
  // an *existing* plugin in an isolated worktree and attach its frozen-build
  // evidence while the plan is still pending owner approval. SQLite cannot widen
  // a CHECK in place, so rebuild source_plans and copy every column verbatim;
  // every pre-existing row is backfilled to mode='create' with no prepared
  // evidence. Existing rows are all create-mode and retain their immutable
  // digest. Build the replacement under a temporary name before dropping the
  // parent, then rename it into place: renaming the old parent would rewrite
  // dependent foreign-key declarations to the temporary name.
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    CREATE TABLE source_plans_v13 (
      id TEXT PRIMARY KEY,
      plan_digest TEXT NOT NULL UNIQUE CHECK(length(plan_digest) = 64),
      gap_id TEXT NOT NULL,
      gap_snapshot_json TEXT NOT NULL CHECK(json_valid(gap_snapshot_json) AND json_type(gap_snapshot_json) = 'object'),
      repository TEXT NOT NULL,
      worktree TEXT NOT NULL,
      base_commit TEXT NOT NULL CHECK(length(base_commit) = 40),
      plugin_name TEXT NOT NULL,
      generator_digest TEXT NOT NULL CHECK(length(generator_digest) = 64),
      scope_json TEXT NOT NULL CHECK(json_valid(scope_json) AND json_type(scope_json) = 'array'),
      mode TEXT NOT NULL DEFAULT 'create' CHECK(mode IN ('create', 'modify')),
      status TEXT NOT NULL CHECK(status IN (
        'expired', 'pending-approval', 'approved', 'running-local-checks', 'ready-for-human-review', 'local-checks-failed',
        'awaiting-pr', 'awaiting-review', 'awaiting-merge', 'awaiting-build', 'awaiting-sign', 'awaiting-publish',
        'awaiting-registry-verify', 'awaiting-catalog-admission', 'release-complete', 'release-failed', 'publish-ambiguous'
      )),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
      approval_json TEXT CHECK(approval_json IS NULL OR json_valid(approval_json)),
      checked_tree_digest TEXT CHECK(checked_tree_digest IS NULL OR (length(checked_tree_digest) = 64 AND checked_tree_digest NOT GLOB '*[^a-f0-9]*')),
      checked_patch_digest TEXT CHECK(checked_patch_digest IS NULL OR (length(checked_patch_digest) = 64 AND checked_patch_digest NOT GLOB '*[^a-f0-9]*')),
      checked_at INTEGER,
      prepared_evidence_json TEXT CHECK(prepared_evidence_json IS NULL OR
        (json_valid(prepared_evidence_json) AND json_type(prepared_evidence_json) = 'object')),
      release_authorization_json TEXT CHECK(release_authorization_json IS NULL OR (json_valid(release_authorization_json) AND json_type(release_authorization_json) = 'object')),
      release_authorization_digest TEXT CHECK(release_authorization_digest IS NULL OR length(release_authorization_digest) = 64),
      release_id TEXT,
      release_fence INTEGER NOT NULL DEFAULT 0 CHECK(release_fence >= 0),
      release_failure_phase TEXT CHECK(release_failure_phase IS NULL OR release_failure_phase IN (
        'pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission'
      )),
      release_failure_code TEXT,
      updated_at INTEGER NOT NULL,
      CHECK((checked_tree_digest IS NULL AND checked_patch_digest IS NULL AND checked_at IS NULL) OR
        (checked_tree_digest IS NOT NULL AND checked_patch_digest IS NOT NULL AND checked_at IS NOT NULL)),
      CHECK(mode = 'create' OR
        (checked_tree_digest IS NOT NULL AND checked_patch_digest IS NOT NULL AND checked_at IS NOT NULL)),
      CHECK((mode = 'create' AND prepared_evidence_json IS NULL) OR
        (mode = 'modify' AND prepared_evidence_json IS NOT NULL)),
      CHECK((release_authorization_json IS NULL AND release_authorization_digest IS NULL) OR
        (release_authorization_json IS NOT NULL AND release_authorization_digest IS NOT NULL)),
      FOREIGN KEY(gap_id) REFERENCES capability_gaps(id) ON DELETE RESTRICT
    ) STRICT;
    INSERT INTO source_plans_v13 (id, plan_digest, gap_id, gap_snapshot_json, repository, worktree, base_commit,
      plugin_name, generator_digest, scope_json, mode, status, revision, created_at, expires_at, approval_json,
      checked_tree_digest, checked_patch_digest, checked_at, prepared_evidence_json,
      release_authorization_json, release_authorization_digest, release_id, release_fence,
      release_failure_phase, release_failure_code, updated_at)
      SELECT id, plan_digest, gap_id, gap_snapshot_json, repository, worktree, base_commit, plugin_name,
        generator_digest, scope_json, 'create', status, revision, created_at, expires_at, approval_json,
        checked_tree_digest, checked_patch_digest, checked_at, NULL,
        release_authorization_json, release_authorization_digest, release_id, release_fence,
        release_failure_phase, release_failure_code, updated_at FROM source_plans;
    DROP TABLE source_plans;
    ALTER TABLE source_plans_v13 RENAME TO source_plans;
    PRAGMA user_version = 13;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `)
}

function migrateV13ToV14(database: DatabaseSync): void {
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS source_job_authorities (
      authority_id TEXT PRIMARY KEY,
      authority_digest TEXT NOT NULL CHECK(length(authority_digest) = 64),
      expires_at INTEGER NOT NULL,
      max_submissions INTEGER NOT NULL CHECK(max_submissions >= 1),
      submissions INTEGER NOT NULL CHECK(submissions >= 0 AND submissions <= max_submissions)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS source_jobs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL UNIQUE,
      authority_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      intent_json TEXT NOT NULL CHECK(json_valid(intent_json) AND json_type(intent_json) = 'object'),
      intent_digest TEXT NOT NULL CHECK(length(intent_digest) = 64),
      status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'prepared', 'failed', 'unknown')),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      definition_hash TEXT,
      occurrence_id TEXT,
      plan_id TEXT UNIQUE,
      failure_code TEXT,
      updated_at INTEGER NOT NULL,
      UNIQUE(authority_id, idempotency_key),
      FOREIGN KEY(authority_id) REFERENCES source_job_authorities(authority_id) ON DELETE RESTRICT,
      FOREIGN KEY(plan_id) REFERENCES source_plans(id) ON DELETE RESTRICT,
      CHECK((status = 'queued' AND occurrence_id IS NULL AND plan_id IS NULL AND failure_code IS NULL)
        OR (status = 'running' AND definition_hash IS NOT NULL AND occurrence_id IS NOT NULL AND plan_id IS NULL AND failure_code IS NULL)
        OR (status = 'prepared' AND definition_hash IS NOT NULL AND occurrence_id IS NOT NULL AND plan_id IS NOT NULL AND failure_code IS NULL)
        OR (status = 'failed' AND plan_id IS NULL AND failure_code IS NOT NULL)
        OR (status = 'unknown' AND definition_hash IS NOT NULL AND occurrence_id IS NOT NULL AND plan_id IS NULL AND failure_code IS NOT NULL))
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS source_jobs_single_active ON source_jobs((1)) WHERE status IN ('queued', 'running', 'unknown');
    CREATE INDEX IF NOT EXISTS source_jobs_created ON source_jobs(created_at, id);
    PRAGMA user_version = 14;
    COMMIT;
  `)
}

function migrateV14ToV15(database: DatabaseSync): void {
  const columns = new Set((database.prepare('PRAGMA table_info(activation_plans)').all() as Array<{ name: string }>).map(row => row.name))
  const hasRollbackPhase = (database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'host_attestations'").get() as { sql?: string } | undefined)?.sql?.includes("'rollback'") === true
  database.exec(`
    BEGIN IMMEDIATE;
    ${columns.has('activation_target_baseline_json') ? '' : "ALTER TABLE activation_plans ADD COLUMN activation_target_baseline_json TEXT CHECK(activation_target_baseline_json IS NULL OR (json_valid(activation_target_baseline_json) AND json_type(activation_target_baseline_json) = 'array'));"}
    ${columns.has('host_recovery_required') ? '' : 'ALTER TABLE activation_plans ADD COLUMN host_recovery_required INTEGER NOT NULL DEFAULT 0 CHECK(host_recovery_required IN (0, 1));'}
    ${columns.has('rollback_profile_restored') ? '' : 'ALTER TABLE activation_plans ADD COLUMN rollback_profile_restored INTEGER NOT NULL DEFAULT 0 CHECK(rollback_profile_restored IN (0, 1));'}
    -- Older active Host states have no trustworthy core-file baseline. Keep them
    -- pending recovery, never manufacture a baseline from mutable files.
    UPDATE activation_plans SET host_recovery_required = 1
      WHERE status IN ('awaiting-reload', 'awaiting-readiness', 'awaiting-effect-blocked-replay', 'awaiting-shadow', 'awaiting-canary', 'awaiting-soak', 'awaiting-health', 'commit-pending', 'rollback-pending');
    ${hasRollbackPhase ? '' : 'ALTER TABLE host_attestations RENAME TO host_attestations_v14;'}
    CREATE TABLE IF NOT EXISTS host_attestations (
      plan_id TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('reload', 'readiness', 'effect-blocked-replay', 'shadow', 'canary', 'soak', 'health', 'rollback')),
      receipt_id TEXT NOT NULL UNIQUE, receipt_digest TEXT NOT NULL CHECK(length(receipt_digest) = 64),
      receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND json_type(receipt_json) = 'object'), host_generation INTEGER NOT NULL CHECK(host_generation >= 1),
      created_at INTEGER NOT NULL, PRIMARY KEY(plan_id, phase), FOREIGN KEY(plan_id) REFERENCES activation_plans(id) ON DELETE RESTRICT
    ) STRICT, WITHOUT ROWID;
    ${hasRollbackPhase ? '' : 'INSERT INTO host_attestations SELECT * FROM host_attestations_v14; DROP TABLE host_attestations_v14;'}
    ${hasRollbackPhase ? '' : 'ALTER TABLE host_attestation_operations RENAME TO host_attestation_operations_v14;'}
    CREATE TABLE IF NOT EXISTS host_attestation_operations (
      plan_id TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('reload', 'readiness', 'effect-blocked-replay', 'shadow', 'canary', 'soak', 'health', 'rollback')),
      operation_id TEXT NOT NULL UNIQUE, binding_digest TEXT NOT NULL CHECK(length(binding_digest) = 64), request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
      request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json) = 'object'), status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'applied')),
      receipt_digest TEXT CHECK(receipt_digest IS NULL OR length(receipt_digest) = 64), receipt_json TEXT CHECK(receipt_json IS NULL OR (json_valid(receipt_json) AND json_type(receipt_json) = 'object')),
      created_at INTEGER NOT NULL, completed_at INTEGER, applied_at INTEGER, PRIMARY KEY(plan_id, phase), FOREIGN KEY(plan_id) REFERENCES activation_plans(id) ON DELETE RESTRICT
    ) STRICT, WITHOUT ROWID;
    ${hasRollbackPhase ? '' : 'INSERT INTO host_attestation_operations SELECT * FROM host_attestation_operations_v14; DROP TABLE host_attestation_operations_v14;'}
    PRAGMA user_version = 15;
    COMMIT;
  `)
}

function migrateV15ToV16(database: DatabaseSync): void {
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS owner_task_failure_gaps (
      gap_id TEXT PRIMARY KEY REFERENCES capability_gaps(id) ON DELETE RESTRICT,
      reference_json TEXT NOT NULL CHECK(json_valid(reference_json) AND json_type(reference_json) = 'object'),
      reference_digest TEXT NOT NULL CHECK(length(reference_digest) = 64)
    ) STRICT, WITHOUT ROWID;
    PRAGMA user_version = 16;
    COMMIT;
  `)
}

function migrateV16ToV17(database: DatabaseSync): void {
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS activation_deployment_checkpoints (
      plan_id TEXT PRIMARY KEY REFERENCES activation_plans(id) ON DELETE RESTRICT,
      baseline_json TEXT NOT NULL CHECK(json_valid(baseline_json) AND json_type(baseline_json) = 'array'),
      exposure_order INTEGER NOT NULL UNIQUE CHECK(exposure_order >= 1),
      successful_order INTEGER UNIQUE CHECK(successful_order IS NULL OR successful_order = exposure_order),
      recorded_at INTEGER NOT NULL,
      succeeded_at INTEGER
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS activation_deployment_checkpoints_success ON activation_deployment_checkpoints(successful_order)
      WHERE successful_order IS NOT NULL;
    CREATE TABLE IF NOT EXISTS activation_deployment_sequence (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      next_exposure_order INTEGER NOT NULL CHECK(next_exposure_order >= 1)
    ) STRICT, WITHOUT ROWID;
    INSERT OR IGNORE INTO activation_deployment_sequence (singleton, next_exposure_order) VALUES (1, 1);
    -- Historical promotions did not retain a verified installed core-file pin.
    -- Do not invent one from mutable profile contents: they remain observable,
    -- but cannot be physically rolled back by this new path.
    PRAGMA user_version = 17;
    COMMIT;
  `)
}

function migrateV17ToV18(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS source_release_dispatches (
      operation_id TEXT PRIMARY KEY REFERENCES source_release_operations(operation_id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK(status IN ('claimed', 'completed')),
      claimed_at INTEGER NOT NULL,
      completed_at INTEGER,
      CHECK((status = 'claimed' AND completed_at IS NULL) OR
        (status = 'completed' AND completed_at IS NOT NULL AND completed_at >= claimed_at))
    ) STRICT, WITHOUT ROWID;
    -- A v17 pending operation may already have reached an external adapter
    -- before this binary could persist its signed receipt. Preserve that
    -- uncertainty; do not infer that dispatch is safe to repeat.
    INSERT OR IGNORE INTO source_release_dispatches (operation_id, status, claimed_at, completed_at)
      SELECT operation_id,
        CASE WHEN status = 'pending' THEN 'claimed' ELSE 'completed' END,
        created_at,
        CASE WHEN status = 'pending' THEN NULL ELSE completed_at END
      FROM source_release_operations;
    PRAGMA user_version = 18;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `)
}


export function openControlPlaneDatabase(path: string): DatabaseSync {
  prepare(path)
  const database = new DatabaseSync(path)
  try {
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    const version = Number((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    if (version > controlPlaneSchemaVersion) throw new ControlPlaneDatabaseError('schema-too-new', 'plugin-control-plane database schema is newer than this binary')
    if (version === 0) createCurrent(database)
    else if (version === 1) migrateV1(database)
    else {
      if (version === 2) migrateV2ToV3(database)
      if (version <= 3) migrateV3ToV4(database)
      if (version <= 4) migrateV4ToV5(database)
      if (version <= 5) migrateV5ToV6(database)
      if (version <= 6) migrateV6ToV7(database)
      if (version <= 7) migrateV7ToV8(database)
      if (version <= 8) migrateV8ToV9(database)
      if (version <= 9) migrateV9ToV10(database)
      if (version <= 10) migrateV10ToV11(database)
      if (version <= 11) migrateV11ToV12(database)
      if (version <= 12) migrateV12ToV13(database)
      if (version <= 13) migrateV13ToV14(database)
      if (version <= 14) migrateV14ToV15(database)
      if (version <= 15) migrateV15ToV16(database)
      if (version <= 16) migrateV16ToV17(database)
      if (version <= 17) migrateV17ToV18(database)
    }
    if (Number(database.prepare('PRAGMA user_version').get()?.user_version) < 19) {
      database.exec(`BEGIN IMMEDIATE; ${sourceAdoptionsSchema} PRAGMA user_version = 19; COMMIT;`)
    } else database.exec(sourceAdoptionsSchema)
    if (Number(database.prepare('PRAGMA user_version').get()?.user_version) < 20) {
      database.exec(`BEGIN IMMEDIATE; ${foregroundDeploymentsSchema} PRAGMA user_version = 20; COMMIT;`)
    } else database.exec(foregroundDeploymentsSchema)
    if (Number(database.prepare('PRAGMA user_version').get()?.user_version) < 21) {
      database.exec(`BEGIN IMMEDIATE; ${taskObservationsSchema} PRAGMA user_version = 21; COMMIT;`)
    } else database.exec(taskObservationsSchema)
    if (Number(database.prepare('PRAGMA user_version').get()?.user_version) < 22) {
      database.exec(`BEGIN IMMEDIATE; ${hostAttestationDispatchesSchema}
        INSERT OR IGNORE INTO host_attestation_dispatches (operation_id,status,claimed_at,completed_at)
          SELECT operation_id, CASE WHEN status = 'pending' THEN 'claimed' ELSE 'completed' END, created_at,
            CASE WHEN status = 'pending' THEN NULL ELSE completed_at END FROM host_attestation_operations;
        PRAGMA user_version = 22; COMMIT;`)
    } else database.exec(hostAttestationDispatchesSchema)
    database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
