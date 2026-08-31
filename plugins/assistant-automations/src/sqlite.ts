import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const automationSchemaVersion = 10

const growthTablesV10 = `
  CREATE TABLE automation_growth_operations (
    operation_id TEXT PRIMARY KEY,
    operation_kind TEXT NOT NULL CHECK (operation_kind IN (
      'approval-proposal', 'approval-settlement', 'replay', 'shadow',
      'canary', 'canary-inspection', 'promotion', 'rollback'
    )),
    payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
    receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    CHECK ((status = 'completed') = (receipt_json IS NOT NULL))
  ) STRICT;

  CREATE TABLE automation_growth_artifacts (
    artifact_id TEXT PRIMARY KEY,
    experiment_id TEXT NOT NULL UNIQUE,
    candidate_id TEXT NOT NULL,
    candidate_revision INTEGER NOT NULL CHECK (candidate_revision >= 1),
    candidate_digest TEXT NOT NULL CHECK (length(candidate_digest) = 64),
    workspace TEXT NOT NULL,
    preset TEXT NOT NULL,
    owner_binding_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    template_ref TEXT NOT NULL,
    template_digest TEXT NOT NULL CHECK (length(template_digest) = 64),
    privacy_attestation_json TEXT NOT NULL CHECK (
      json_valid(privacy_attestation_json) AND json_type(privacy_attestation_json) = 'object'
    ),
    evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64),
    evidence_count INTEGER NOT NULL CHECK (evidence_count >= 1),
    steps_json TEXT NOT NULL CHECK (json_valid(steps_json) AND json_type(steps_json) = 'array'),
    automation_id TEXT NOT NULL UNIQUE,
    definition_hash TEXT NOT NULL CHECK (length(definition_hash) = 64),
    definition_version INTEGER NOT NULL CHECK (definition_version >= 1),
    proposal_id TEXT UNIQUE,
    approval_diff_hash TEXT NOT NULL CHECK (length(approval_diff_hash) = 64),
    deadline_at INTEGER NOT NULL CHECK (deadline_at >= 0),
    state TEXT NOT NULL CHECK (state IN (
      'approval-pending', 'paused', 'canary-pending', 'promoted', 'rejected', 'rolled-back'
    )),
    shadow_task_id TEXT UNIQUE,
    canary_task_id TEXT UNIQUE,
    canary_run_id TEXT UNIQUE,
    canary_evaluation_id TEXT UNIQUE,
    canary_evaluation_digest TEXT CHECK (
      canary_evaluation_digest IS NULL OR length(canary_evaluation_digest) = 64
    ),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    FOREIGN KEY (automation_id) REFERENCES automation_definitions(id) ON DELETE RESTRICT,
    FOREIGN KEY (shadow_task_id) REFERENCES automation_tasks(id) ON DELETE RESTRICT,
    FOREIGN KEY (canary_task_id) REFERENCES automation_tasks(id) ON DELETE RESTRICT,
    FOREIGN KEY (canary_run_id) REFERENCES automation_runs(id) ON DELETE RESTRICT
  ) STRICT;
  CREATE INDEX automation_growth_artifact_state
    ON automation_growth_artifacts(state, updated_at, artifact_id);
`

const incidentTableV9 = `
  CREATE TABLE automation_incidents (
    id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL,
    definition_hash TEXT NOT NULL,
    stage TEXT NOT NULL CHECK (stage IN ('materialize', 'claim', 'terminal')),
    state TEXT NOT NULL CHECK (state IN ('open', 'recovering', 'resolved')),
    failure_class TEXT NOT NULL CHECK (failure_class IN (
      'budget', 'cancelled', 'configuration', 'execution', 'infrastructure',
      'policy', 'provider', 'timeout', 'unknown'
    )),
    failure_phase TEXT NOT NULL,
    failure_code TEXT NOT NULL,
    side_effect_state TEXT NOT NULL CHECK (side_effect_state IN ('none', 'possible', 'unknown')),
    retryability TEXT NOT NULL CHECK (retryability IN ('safe', 'unsafe', 'after-intervention', 'unknown')),
    notification_route_id TEXT NOT NULL,
    lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation >= 1),
    presentation_revision INTEGER NOT NULL CHECK (presentation_revision >= 1),
    alert_status TEXT NOT NULL CHECK (alert_status IN ('pending', 'enqueued', 'suppressed')),
    alert_ref TEXT,
    run_id TEXT,
    opened_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    resolved_at INTEGER,
    version INTEGER NOT NULL CHECK (version >= 1),
    UNIQUE (automation_id, definition_hash, stage),
    CHECK (
      (state IN ('open', 'recovering') AND resolved_at IS NULL)
      OR (state = 'resolved' AND resolved_at IS NOT NULL)
    ),
    CHECK (
      (alert_status = 'enqueued' AND alert_ref IS NOT NULL)
      OR alert_status IN ('pending', 'suppressed')
    )
  ) STRICT;
  CREATE INDEX automation_open_incidents
    ON automation_incidents(state, updated_at, automation_id);
  CREATE INDEX automation_incident_alert_outbox
    ON automation_incidents(alert_status, opened_at, id);

  CREATE TABLE IF NOT EXISTS automation_circuit_operations (
    operation_id TEXT PRIMARY KEY,
    system_owner TEXT NOT NULL,
    automation_id TEXT NOT NULL,
    definition_hash TEXT NOT NULL,
    expected_circuit_version INTEGER NOT NULL CHECK (expected_circuit_version >= 1),
    lease_ms INTEGER NOT NULL CHECK (lease_ms > 0),
    input_hash TEXT NOT NULL,
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS automation_circuit_operation_scope
    ON automation_circuit_operations(system_owner, automation_id, definition_hash, created_at);
`

export class AutomationDatabaseError extends Error {
  constructor(readonly code: 'invalid-path' | 'schema-too-new', message: string) {
    super(message)
    this.name = 'AutomationDatabaseError'
  }
}

function repairCircuitPreviewV7(database: DatabaseSync): void {
  const table = database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'automation_circuits'
  `).get() as { sql: string } | undefined
  const columns = table === undefined
    ? []
    : database.prepare(`PRAGMA table_info('automation_circuits')`).all() as unknown as Array<{ name: string }>
  if (['probe_token', 'probe_lease_until', 'probe_task_id'].every(
    name => columns.some(column => column.name === name),
  ) && table?.sql.includes("'half-open'") === true && table.sql.includes("'probing'") === true) return
  const create = `
    CREATE TABLE automation_circuits (
      automation_id TEXT NOT NULL,
      definition_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('open', 'half-open', 'probing', 'closed')),
      failure_class TEXT NOT NULL CHECK (failure_class IN ('configuration', 'policy', 'budget')),
      failure_phase TEXT NOT NULL,
      failure_code TEXT NOT NULL,
      opened_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      probe_token TEXT,
      probe_lease_until INTEGER,
      probe_task_id TEXT,
      version INTEGER NOT NULL CHECK (version >= 1),
      CHECK (
        (state IN ('open', 'closed') AND probe_token IS NULL AND probe_lease_until IS NULL AND probe_task_id IS NULL)
        OR (state = 'half-open' AND probe_token IS NOT NULL AND probe_lease_until IS NOT NULL AND probe_task_id IS NULL)
        OR (state = 'probing' AND probe_token IS NOT NULL AND probe_lease_until IS NOT NULL AND probe_task_id IS NOT NULL)
      ),
      PRIMARY KEY (automation_id, definition_hash)
    ) STRICT;
  `
  if (table === undefined) {
    database.exec(`
      BEGIN IMMEDIATE;
      ${create}
      CREATE INDEX automation_open_circuits ON automation_circuits(state, updated_at, automation_id);
      COMMIT;
    `)
    return
  }
  // v7 existed briefly as a preview with a binary open/closed table. Rebuild
  // it in-place while preserving every exact-definition circuit and version.
  database.exec(`
    BEGIN IMMEDIATE;
    DROP INDEX IF EXISTS automation_open_circuits;
    ALTER TABLE automation_circuits RENAME TO automation_circuits_preview_v7;
    ${create}
    INSERT INTO automation_circuits(
      automation_id, definition_hash, state, failure_class, failure_phase,
      failure_code, opened_at, updated_at, version
    )
    SELECT automation_id, definition_hash, state, failure_class, failure_phase,
      failure_code, opened_at, updated_at, version
    FROM automation_circuits_preview_v7;
    DROP TABLE automation_circuits_preview_v7;
    CREATE INDEX automation_open_circuits ON automation_circuits(state, updated_at, automation_id);
    COMMIT;
  `)
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
      automation_snapshot_hash TEXT NOT NULL,
      automation_snapshot_json TEXT NOT NULL CHECK (json_valid(automation_snapshot_json)),
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
      execution_mode TEXT NOT NULL CHECK (execution_mode IN ('production', 'preview', 'unknown')),
      definition_hash TEXT,
      diagnostic_json TEXT NOT NULL CHECK (json_valid(diagnostic_json)),
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

    CREATE TABLE automation_evaluation_outbox (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      observation_kind TEXT NOT NULL CHECK (observation_kind IN ('terminal')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'recorded', 'dead-letter')),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at INTEGER NOT NULL,
      last_failure_at INTEGER,
      last_error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES automation_runs(id)
    ) STRICT;
    CREATE INDEX automation_evaluation_dispatch
      ON automation_evaluation_outbox(status, next_attempt_at, id);

    CREATE TABLE automation_circuits (
      automation_id TEXT NOT NULL,
      definition_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('open', 'half-open', 'probing', 'closed')),
      failure_class TEXT NOT NULL CHECK (failure_class IN ('configuration', 'policy', 'budget')),
      failure_phase TEXT NOT NULL,
      failure_code TEXT NOT NULL,
      opened_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      probe_token TEXT,
      probe_lease_until INTEGER,
      probe_task_id TEXT,
      version INTEGER NOT NULL CHECK (version >= 1),
      CHECK (
        (state IN ('open', 'closed') AND probe_token IS NULL AND probe_lease_until IS NULL AND probe_task_id IS NULL)
        OR (state = 'half-open' AND probe_token IS NOT NULL AND probe_lease_until IS NOT NULL AND probe_task_id IS NULL)
        OR (state = 'probing' AND probe_token IS NOT NULL AND probe_lease_until IS NOT NULL AND probe_task_id IS NOT NULL)
      ),
      PRIMARY KEY (automation_id, definition_hash)
    ) STRICT;
    CREATE INDEX automation_open_circuits ON automation_circuits(state, updated_at, automation_id);

    ${incidentTableV9}

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

    ${growthTablesV10}
    PRAGMA user_version = 10;
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
    version = 4
  }
  if (version === 4) {
    const hasRuns = database.prepare(`
      SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'automation_runs'
    `).get() !== undefined
    database.exec(`
      BEGIN IMMEDIATE;
      ${hasRuns ? `
      CREATE TABLE automation_evaluation_outbox (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        observation_kind TEXT NOT NULL CHECK (observation_kind IN ('terminal')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'recorded')),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (run_id, observation_kind),
        FOREIGN KEY (run_id) REFERENCES automation_runs(id)
      ) STRICT;
      CREATE INDEX automation_evaluation_dispatch
        ON automation_evaluation_outbox(status, updated_at, id);

      ` : ''}

      PRAGMA user_version = 5;
      COMMIT;
    `)
    version = 5
  }
  if (version === 5) {
    const hasAttempts = database.prepare(`
      SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'automation_attempts'
    `).get() !== undefined
    const hasOutbox = database.prepare(`
      SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'automation_evaluation_outbox'
    `).get() !== undefined
    const hasRuns = database.prepare(`
      SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'automation_runs'
    `).get() !== undefined
    if (!hasRuns) {
      database.exec(`
        BEGIN IMMEDIATE;
        ${hasAttempts ? `
        ALTER TABLE automation_attempts ADD COLUMN automation_snapshot_hash TEXT;
        ALTER TABLE automation_attempts ADD COLUMN automation_snapshot_json TEXT
          CHECK (automation_snapshot_json IS NULL OR json_valid(automation_snapshot_json));
        ` : ''}
        DROP INDEX IF EXISTS automation_evaluation_dispatch;
        DROP TABLE IF EXISTS automation_evaluation_outbox;
        PRAGMA user_version = 6;
        COMMIT;
      `)
      version = 6
    } else {
      database.exec(`
        BEGIN IMMEDIATE;
        ${hasAttempts ? `
        ALTER TABLE automation_attempts ADD COLUMN automation_snapshot_hash TEXT;
        ALTER TABLE automation_attempts ADD COLUMN automation_snapshot_json TEXT
          CHECK (automation_snapshot_json IS NULL OR json_valid(automation_snapshot_json));
        ` : ''}
        ${hasOutbox ? `
        ALTER TABLE automation_evaluation_outbox RENAME TO automation_evaluation_outbox_v5;
        DROP INDEX IF EXISTS automation_evaluation_dispatch;
        ` : ''}
        CREATE TABLE automation_evaluation_outbox (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          observation_kind TEXT NOT NULL CHECK (observation_kind IN ('terminal')),
          status TEXT NOT NULL CHECK (status IN ('pending', 'recorded', 'dead-letter')),
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
          attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
          next_attempt_at INTEGER NOT NULL,
          last_failure_at INTEGER,
          last_error_code TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (run_id) REFERENCES automation_runs(id)
        ) STRICT;
        ${hasOutbox ? `
        INSERT INTO automation_evaluation_outbox(
          id, run_id, observation_kind, status, payload_json, attempt_count,
          next_attempt_at, last_failure_at, last_error_code, created_at, updated_at
        )
        SELECT id, run_id, observation_kind,
          CASE WHEN status = 'pending' THEN 'dead-letter' ELSE status END,
          payload_json,
          CASE WHEN status = 'pending' THEN 1 ELSE 0 END,
          updated_at,
          CASE WHEN status = 'pending' THEN updated_at ELSE NULL END,
          CASE WHEN status = 'pending' THEN 'legacy-unverifiable-provenance' ELSE NULL END,
          created_at, updated_at
        FROM automation_evaluation_outbox_v5;
        DROP TABLE automation_evaluation_outbox_v5;
        ` : ''}
        CREATE INDEX automation_evaluation_dispatch
          ON automation_evaluation_outbox(status, next_attempt_at, id);
        PRAGMA user_version = 6;
        COMMIT;
      `)
      version = 6
    }
  }
  if (version === 6) {
    const hasRuns = database.prepare(`
      SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'automation_runs'
    `).get() !== undefined
    const hasOccurrences = database.prepare(`
      SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'automation_occurrences'
    `).get() !== undefined
    const legacyDiagnostic = JSON.stringify({
      schemaVersion: 1,
      failureClass: 'unknown',
      failurePhase: 'unknown',
      failureCode: 'legacy-runner-unclassified',
      promptSubmissionState: 'unknown',
      sideEffectState: 'unknown',
      retryability: 'unknown',
      budgetSettlementState: 'unknown',
    }).replaceAll("'", "''")
    database.exec(`
      BEGIN IMMEDIATE;
      ${hasRuns ? `
      ALTER TABLE automation_runs ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'unknown'
        CHECK (execution_mode IN ('production', 'preview', 'unknown'));
      ALTER TABLE automation_runs ADD COLUMN definition_hash TEXT;
      ALTER TABLE automation_runs ADD COLUMN diagnostic_json TEXT NOT NULL DEFAULT '${legacyDiagnostic}'
        CHECK (json_valid(diagnostic_json));
      ${hasOccurrences ? `
      UPDATE automation_runs AS run
      SET execution_mode = 'preview'
      WHERE EXISTS (
        SELECT 1 FROM automation_occurrences AS occurrence
        WHERE occurrence.id = run.occurrence_id AND occurrence.dry_run = 1
      );
      UPDATE automation_runs AS run
      SET evidence_status = 'suppressed', evidence_json = NULL,
          delivery_ref = CASE WHEN delivery_status = 'pending' THEN NULL ELSE delivery_ref END,
          delivery_status = CASE WHEN delivery_status = 'pending' THEN 'suppressed' ELSE delivery_status END
      WHERE EXISTS (
        SELECT 1 FROM automation_occurrences AS occurrence
        WHERE occurrence.id = run.occurrence_id AND occurrence.dry_run = 1
      );
      ` : ''}
      ` : ''}
      CREATE TABLE automation_circuits (
        automation_id TEXT NOT NULL,
        definition_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open', 'half-open', 'probing', 'closed')),
        failure_class TEXT NOT NULL CHECK (failure_class IN ('configuration', 'policy', 'budget')),
        failure_phase TEXT NOT NULL,
        failure_code TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        probe_token TEXT,
        probe_lease_until INTEGER,
        probe_task_id TEXT,
        version INTEGER NOT NULL CHECK (version >= 1),
        CHECK (
          (state IN ('open', 'closed') AND probe_token IS NULL AND probe_lease_until IS NULL AND probe_task_id IS NULL)
          OR (state = 'half-open' AND probe_token IS NOT NULL AND probe_lease_until IS NOT NULL AND probe_task_id IS NULL)
          OR (state = 'probing' AND probe_token IS NOT NULL AND probe_lease_until IS NOT NULL AND probe_task_id IS NOT NULL)
        ),
        PRIMARY KEY (automation_id, definition_hash)
      ) STRICT;
      CREATE INDEX automation_open_circuits ON automation_circuits(state, updated_at, automation_id);
      PRAGMA user_version = 7;
      COMMIT;
    `)
    version = 7
  }
  if (version === 7) {
    repairCircuitPreviewV7(database)
    database.exec(`
      BEGIN IMMEDIATE;
      ${incidentTableV9}
      PRAGMA user_version = 9;
      COMMIT;
    `)
    version = 9
  }
  if (version === 8) {
    const hasIncidents = database.prepare(`
      SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'automation_incidents'
    `).get() !== undefined
    if (!hasIncidents) {
      database.exec(`
        BEGIN IMMEDIATE;
        ${incidentTableV9}
        PRAGMA user_version = 9;
        COMMIT;
      `)
      version = 9
    } else {
      database.exec(`
        BEGIN IMMEDIATE;
        DROP INDEX IF EXISTS automation_open_incidents;
        DROP INDEX IF EXISTS automation_incident_alert_outbox;
        ALTER TABLE automation_incidents RENAME TO automation_incidents_v8;
        ${incidentTableV9}
        INSERT INTO automation_incidents(
          id, automation_id, definition_hash, stage, state, failure_class,
          failure_phase, failure_code, side_effect_state, retryability,
          notification_route_id, lifecycle_generation, presentation_revision,
          alert_status, alert_ref, run_id, opened_at, updated_at, resolved_at, version
        )
        SELECT id, automation_id, definition_hash, stage, state, failure_class,
          failure_phase, failure_code, side_effect_state, retryability,
          notification_route_id, 1, version,
          CASE WHEN state = 'open' THEN 'pending' ELSE 'suppressed' END,
          NULL, run_id, opened_at, updated_at, resolved_at, version
        FROM automation_incidents_v8;
        DROP TABLE automation_incidents_v8;
        PRAGMA user_version = 9;
        COMMIT;
      `)
      version = 9
    }
  }
  if (version === 9) {
    database.exec(`
      BEGIN IMMEDIATE;
      ${growthTablesV10}
      PRAGMA user_version = 10;
      COMMIT;
    `)
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
