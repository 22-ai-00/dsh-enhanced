import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const evolutionSchemaVersion = 12

export class EvolutionDatabaseError extends Error {
  constructor(
    readonly code: 'invalid-path' | 'schema-too-new',
    message: string,
  ) {
    super(message)
    this.name = 'EvolutionDatabaseError'
  }
}

function schemaVersion(database: DatabaseSync): number {
  return (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function assertSupported(version: number): void {
  if (version > evolutionSchemaVersion) {
    throw new EvolutionDatabaseError(
      'schema-too-new',
      `evolution schema ${version} is newer than supported schema ${evolutionSchemaVersion}`,
    )
  }
}

function migrateV1ToV2(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE evolution_episodes
      ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'legacy:v1';
    ALTER TABLE evolution_episodes
      ADD COLUMN trust TEXT NOT NULL DEFAULT 'legacy'
      CHECK (trust IN ('trusted', 'self-reported', 'legacy'));
    ALTER TABLE evolution_episodes ADD COLUMN claimed_rule_id TEXT;
    UPDATE evolution_episodes SET claimed_rule_id = rule_id, rule_id = NULL;

    ALTER TABLE evolution_rules
      ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'legacy:v1';
    ALTER TABLE evolution_rules
      ADD COLUMN generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0);

    ALTER TABLE evolution_proposals
      ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'legacy:v1';
    UPDATE evolution_proposals SET status = 'expired' WHERE status = 'pending';

    DROP INDEX IF EXISTS evolution_episodes_situation;
    DROP INDEX IF EXISTS evolution_episodes_rule;
    DROP INDEX IF EXISTS evolution_rules_active_situation;
    CREATE INDEX evolution_episodes_adoption
      ON evolution_episodes(scope_key, situation, trust, rule_id, occurred_at DESC, id DESC);
    CREATE INDEX evolution_episodes_evaluation
      ON evolution_episodes(rule_id, trust, occurred_at DESC, id DESC);
    CREATE UNIQUE INDEX evolution_rules_active_scope_situation
      ON evolution_rules(scope_key, situation)
      WHERE status = 'active' AND scope_key <> 'legacy:v1';
    CREATE UNIQUE INDEX evolution_rules_scope_generation
      ON evolution_rules(scope_key, situation, generation)
      WHERE scope_key <> 'legacy:v1';

    INSERT INTO schema_meta(key, value) VALUES ('schema-version', '2')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    PRAGMA user_version = 2;
  `)
}

function migrateV2ToV3(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE evolution_episodes ADD COLUMN guidance_version INTEGER
      CHECK (guidance_version IS NULL OR guidance_version >= 1);
    ALTER TABLE evolution_proposals ADD COLUMN creation_intent_json TEXT;
    ALTER TABLE evolution_proposals ADD COLUMN settlement_expectation_json TEXT;

    -- Early unreleased v2 rows did not freeze the complete Policy tuple. They
    -- cannot be validated or safely replayed after a crash, so quarantine their
    -- pending mutations as durable security conflicts rather than guessing.
    UPDATE evolution_proposals
      SET status = 'conflicted', version = version + 1
      WHERE status = 'pending';

    CREATE TABLE evolution_guidance_exposures (
      session_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      situation TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      guidance_version INTEGER NOT NULL CHECK (guidance_version >= 1),
      exposed_at INTEGER NOT NULL,
      PRIMARY KEY(session_id, scope_key, rule_id, guidance_version)
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX evolution_guidance_exposures_lookup
      ON evolution_guidance_exposures(session_id, scope_key, situation, exposed_at, rule_id);

    INSERT INTO schema_meta(key, value) VALUES ('schema-version', '3')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    PRAGMA user_version = 3;
  `)
}

function migrateV3ToV4(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE evolution_autonomous_rollbacks (
      idempotency_key TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      expected_version INTEGER NOT NULL CHECK (expected_version >= 1),
      result_version INTEGER NOT NULL CHECK (result_version = expected_version + 1),
      risk TEXT NOT NULL CHECK (risk = 'low'),
      reason TEXT NOT NULL,
      evaluation_failures INTEGER NOT NULL CHECK (evaluation_failures >= 0),
      evaluation_total INTEGER NOT NULL CHECK (
        evaluation_total > 0 AND evaluation_failures <= evaluation_total),
      baseline_failures INTEGER NOT NULL CHECK (baseline_failures >= 0),
      baseline_total INTEGER NOT NULL CHECK (
        baseline_total > 0 AND baseline_failures <= baseline_total),
      evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64),
      evidence_total INTEGER NOT NULL CHECK (evidence_total = evaluation_total),
      sample_episode_ids_json TEXT NOT NULL CHECK (
        json_valid(sample_episode_ids_json) AND json_type(sample_episode_ids_json) = 'array'),
      occurred_at INTEGER NOT NULL,
      UNIQUE(scope_key, rule_id, expected_version),
      FOREIGN KEY(rule_id) REFERENCES evolution_rules(id)
    ) STRICT;
    CREATE INDEX evolution_autonomous_rollbacks_occurred
      ON evolution_autonomous_rollbacks(occurred_at);

    INSERT INTO schema_meta(key, value) VALUES ('schema-version', '4')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    PRAGMA user_version = 4;
  `)
}

function migrateV4ToV5(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE evolution_episodes ADD COLUMN evidence_kind TEXT NOT NULL
      DEFAULT 'legacy-unknown'
      CHECK (evidence_kind IN ('operational', 'objective', 'verification', 'legacy-unknown'));
    ALTER TABLE evolution_episodes ADD COLUMN evidence_ref TEXT;
    ALTER TABLE evolution_episodes ADD COLUMN learning_eligible INTEGER NOT NULL DEFAULT 0
      CHECK (learning_eligible IN (0, 1))
      CHECK (learning_eligible = 0 OR (
        trust = 'trusted'
        AND evidence_kind IN ('objective', 'verification')
        AND evidence_ref IS NOT NULL));

    -- A v4 trusted automation row proved only that execution stopped in a
    -- binary state. It did not prove objective correctness. Keep every row for
    -- audit, but quarantine it from all learning projections.
    UPDATE evolution_episodes
      SET evidence_kind = 'legacy-unknown', evidence_ref = NULL, learning_eligible = 0;

    -- Every pre-v5 pending mutation was computed from evidence that did not
    -- distinguish execution status from objective quality. A later approval
    -- must not activate that stale conclusion after the evidence quarantine.
    UPDATE evolution_proposals
      SET status = 'conflicted', version = version + 1
      WHERE status = 'pending';

    DROP INDEX IF EXISTS evolution_episodes_adoption;
    DROP INDEX IF EXISTS evolution_episodes_evaluation;
    CREATE INDEX evolution_episodes_adoption
      ON evolution_episodes(
        scope_key, situation, learning_eligible, rule_id, occurred_at DESC, id DESC);
    CREATE INDEX evolution_episodes_evaluation
      ON evolution_episodes(
        rule_id, guidance_version, learning_eligible, occurred_at DESC, id DESC);

    INSERT INTO schema_meta(key, value) VALUES ('schema-version', '5')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    PRAGMA user_version = 5;
  `)
}

function migrateV5ToV6(database: DatabaseSync): void {
  database.exec(`
    -- v5 made immutable Evaluation references mandatory, but caller-owned
    -- idempotency keys could still alias the same result into several rows.
    -- Retain the earliest deterministic row and quarantine every duplicate so
    -- historical ledgers migrate before the uniqueness constraint is created.
    CREATE TEMP TABLE evolution_v6_duplicate_quality AS
      WITH ranked AS (
        SELECT id, scope_key,
          row_number() OVER (
            PARTITION BY scope_key, evidence_ref
            ORDER BY occurred_at ASC, id ASC
          ) AS duplicate_rank
        FROM evolution_episodes
        WHERE learning_eligible = 1
          AND evidence_kind IN ('objective', 'verification')
          AND evidence_ref IS NOT NULL
      )
      SELECT id, scope_key FROM ranked WHERE duplicate_rank > 1;

    UPDATE evolution_episodes
      SET evidence_kind = 'legacy-unknown', evidence_ref = NULL, learning_eligible = 0
      WHERE id IN (SELECT id FROM evolution_v6_duplicate_quality);

    -- A pending mutation in an affected scope may have been computed from an
    -- inflated sample. Preserve it for audit but prevent delayed activation.
    UPDATE evolution_proposals
      SET status = 'conflicted', version = version + 1
      WHERE status = 'pending'
        AND scope_key IN (SELECT DISTINCT scope_key FROM evolution_v6_duplicate_quality);

    DROP TABLE evolution_v6_duplicate_quality;

    CREATE UNIQUE INDEX evolution_episodes_quality_evidence_identity
      ON evolution_episodes(scope_key, evidence_ref)
      WHERE learning_eligible = 1;

    INSERT INTO schema_meta(key, value) VALUES ('schema-version', '6')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    PRAGMA user_version = 6;
  `)
}

function migrateV6ToV7(database: DatabaseSync): void {
  database.exec(`
    -- Every pre-v7 quality row came through the retired caller-controlled
    -- projection seam and cannot be rebound to an authoritative Evaluation
    -- receipt after the fact. Preserve it for audit, but revoke learning
    -- eligibility and invalidate pending conclusions derived from it.
    CREATE TEMP TABLE evolution_v7_legacy_quality_scopes AS
      SELECT DISTINCT scope_key FROM evolution_episodes WHERE learning_eligible = 1;

    UPDATE evolution_episodes
      SET evidence_kind = 'legacy-unknown', evidence_ref = NULL, learning_eligible = 0
      WHERE learning_eligible = 1;
    UPDATE evolution_proposals
      SET status = 'conflicted', version = version + 1
      WHERE status = 'pending'
        AND scope_key IN (SELECT scope_key FROM evolution_v7_legacy_quality_scopes);
    DROP TABLE evolution_v7_legacy_quality_scopes;

    -- Evaluation is an independent provenance source. Rebuild the table because
    -- SQLite cannot widen an existing CHECK constraint in place.
    ALTER TABLE evolution_episodes RENAME TO evolution_episodes_v6;
    DROP INDEX IF EXISTS evolution_episodes_adoption;
    DROP INDEX IF EXISTS evolution_episodes_evaluation;
    DROP INDEX IF EXISTS evolution_episodes_quality_evidence_identity;

    CREATE TABLE evolution_episodes (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      situation TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
      detail TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('automation', 'evaluation', 'foreground')),
      scope_key TEXT NOT NULL,
      trust TEXT NOT NULL CHECK (trust IN ('trusted', 'self-reported', 'legacy')),
      evidence_kind TEXT NOT NULL CHECK (
        evidence_kind IN ('operational', 'objective', 'verification', 'legacy-unknown')),
      evidence_ref TEXT,
      learning_eligible INTEGER NOT NULL CHECK (learning_eligible IN (0, 1)),
      rule_id TEXT,
      guidance_version INTEGER CHECK (guidance_version IS NULL OR guidance_version >= 1),
      claimed_rule_id TEXT,
      occurred_at INTEGER NOT NULL,
      CHECK (learning_eligible = 0 OR (
        source = 'evaluation'
        AND
        trust = 'trusted'
        AND evidence_kind IN ('objective', 'verification')
        AND evidence_ref IS NOT NULL))
    ) STRICT;

    INSERT INTO evolution_episodes(
      id, idempotency_key, situation, outcome, detail, source, scope_key,
      trust, evidence_kind, evidence_ref, learning_eligible,
      rule_id, guidance_version, claimed_rule_id, occurred_at)
    SELECT
      id, idempotency_key, situation, outcome, detail, source, scope_key,
      trust, evidence_kind, evidence_ref, learning_eligible,
      rule_id, guidance_version, claimed_rule_id, occurred_at
    FROM evolution_episodes_v6;
    DROP TABLE evolution_episodes_v6;

    CREATE INDEX evolution_episodes_adoption
      ON evolution_episodes(
        scope_key, situation, learning_eligible, rule_id, occurred_at DESC, id DESC);
    CREATE INDEX evolution_episodes_evaluation
      ON evolution_episodes(
        rule_id, guidance_version, learning_eligible, occurred_at DESC, id DESC);
    CREATE UNIQUE INDEX evolution_episodes_quality_evidence_identity
      ON evolution_episodes(scope_key, evidence_ref)
      WHERE learning_eligible = 1;

    INSERT INTO schema_meta(key, value) VALUES ('schema-version', '7')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    PRAGMA user_version = 7;
  `)
}

function migrateV7ToV8(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE evolution_episodes ADD COLUMN learning_subject_ref TEXT;

    -- v7 recorded only the Evaluation identity. For an Automation objective it
    -- therefore cannot prove whether several Evaluation rows assessed one run.
    -- Preserve those rows for audit, but quarantine every old learning row and
    -- every pending conclusion that may have counted it more than once.
    CREATE TEMP TABLE evolution_v8_legacy_learning_scopes AS
      SELECT DISTINCT scope_key FROM evolution_episodes WHERE learning_eligible = 1;
    UPDATE evolution_episodes
      SET evidence_kind = 'legacy-unknown', evidence_ref = NULL,
          learning_subject_ref = NULL, learning_eligible = 0
      WHERE learning_eligible = 1;
    UPDATE evolution_proposals
      SET status = 'conflicted', version = version + 1
      WHERE status = 'pending'
        AND scope_key IN (SELECT scope_key FROM evolution_v8_legacy_learning_scopes);
    DROP TABLE evolution_v8_legacy_learning_scopes;

    CREATE UNIQUE INDEX evolution_episodes_learning_subject_identity
      ON evolution_episodes(scope_key, learning_subject_ref)
      WHERE learning_eligible = 1;

    -- SQLite cannot extend the v7 table CHECK in place. These triggers make the
    -- migrated schema enforce the same invariant as a fresh v8 database.
    CREATE TRIGGER evolution_episodes_learning_subject_insert
      BEFORE INSERT ON evolution_episodes
      WHEN (NEW.learning_eligible = 1 AND NEW.learning_subject_ref IS NULL)
        OR (NEW.learning_eligible = 0 AND NEW.learning_subject_ref IS NOT NULL)
      BEGIN
        SELECT RAISE(ABORT, 'learning subject eligibility mismatch');
      END;
    CREATE TRIGGER evolution_episodes_learning_subject_update
      BEFORE UPDATE OF learning_eligible, learning_subject_ref ON evolution_episodes
      WHEN (NEW.learning_eligible = 1 AND NEW.learning_subject_ref IS NULL)
        OR (NEW.learning_eligible = 0 AND NEW.learning_subject_ref IS NOT NULL)
      BEGIN
        SELECT RAISE(ABORT, 'learning subject eligibility mismatch');
      END;

    INSERT INTO schema_meta(key, value) VALUES ('schema-version', '8')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    PRAGMA user_version = 8;
  `)
}

const taskLearningProjectionSchema = `
  CREATE TABLE evolution_task_learning_state (
    scope_key TEXT NOT NULL,
    scope_watermark INTEGER NOT NULL CHECK (scope_watermark >= 1),
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('automation-run', 'outcome')),
    subject_ref TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    disposition TEXT NOT NULL CHECK (disposition IN ('upsert', 'retract')),
    situation TEXT NOT NULL,
    episode_id TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(scope_key, subject_kind, subject_ref),
    CHECK ((disposition = 'upsert' AND episode_id IS NOT NULL)
      OR (disposition = 'retract' AND episode_id IS NULL)),
    FOREIGN KEY(episode_id) REFERENCES evolution_episodes(id) ON DELETE RESTRICT
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX evolution_task_learning_state_situation
    ON evolution_task_learning_state(scope_key, situation, disposition, updated_at DESC);

  CREATE TABLE evolution_task_learning_revisions (
    scope_key TEXT NOT NULL,
    scope_watermark INTEGER NOT NULL CHECK (scope_watermark >= 1),
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('automation-run', 'outcome')),
    subject_ref TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    disposition TEXT NOT NULL CHECK (disposition IN ('upsert', 'retract')),
    situation TEXT NOT NULL,
    episode_id TEXT,
    applied_at INTEGER NOT NULL,
    PRIMARY KEY(scope_key, subject_kind, subject_ref, version),
    CHECK ((disposition = 'upsert' AND episode_id IS NOT NULL)
      OR (disposition = 'retract' AND episode_id IS NULL)),
    FOREIGN KEY(episode_id) REFERENCES evolution_episodes(id) ON DELETE RESTRICT
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX evolution_task_learning_revisions_applied
    ON evolution_task_learning_revisions(applied_at, scope_key, subject_kind, subject_ref);
`

const supervisedGrowthAnalystSchema = `
  CREATE TABLE evolution_supervised_analyst_reviews (
    review_token TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    occurrence_id TEXT NOT NULL,
    contract_version TEXT NOT NULL CHECK (contract_version = 'supervised-growth-analyst/v1'),
    situation TEXT NOT NULL,
    failures INTEGER NOT NULL CHECK (failures >= 0),
    total INTEGER NOT NULL CHECK (total > 0 AND failures <= total),
    evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64),
    evidence_total INTEGER NOT NULL CHECK (evidence_total = total),
    evidence_window INTEGER NOT NULL CHECK (evidence_window >= evidence_total),
    sample_episode_ids_json TEXT NOT NULL CHECK (
      json_valid(sample_episode_ids_json)
      AND json_type(sample_episode_ids_json) = 'array'
      AND json_array_length(sample_episode_ids_json) BETWEEN 1 AND 50
      AND json_array_length(sample_episode_ids_json) <= evidence_total),
    evidence_json TEXT NOT NULL CHECK (
      json_valid(evidence_json) AND json_type(evidence_json) = 'array'),
    scope_watermark INTEGER NOT NULL CHECK (scope_watermark >= 1),
    task_revisions_json TEXT NOT NULL CHECK (
      json_valid(task_revisions_json) AND json_type(task_revisions_json) = 'array'),
    proposal_id TEXT,
    created_at INTEGER NOT NULL,
    proposed_at INTEGER,
    UNIQUE(scope_key, occurrence_id),
    FOREIGN KEY(proposal_id) REFERENCES evolution_proposals(id) ON DELETE RESTRICT
  ) STRICT;
  CREATE INDEX evolution_supervised_analyst_reviews_proposal
    ON evolution_supervised_analyst_reviews(proposal_id)
    WHERE proposal_id IS NOT NULL;
`

const applicationReceiptSchema = `
  CREATE TABLE evolution_application_receipts (
    local_proposal_id TEXT PRIMARY KEY,
    policy_proposal_id TEXT NOT NULL UNIQUE,
    application_status TEXT NOT NULL CHECK (
      application_status IN ('applied', 'conflicted', 'expired', 'rejected')),
    operation TEXT NOT NULL CHECK (operation IN ('adopt', 'owner-undo', 'retire')),
    terminal_at INTEGER NOT NULL,
    receipt_digest TEXT NOT NULL UNIQUE CHECK (length(receipt_digest) = 64),
    revision INTEGER NOT NULL CHECK (revision >= 2),
    rule_id TEXT,
    resulting_rule_version INTEGER CHECK (
      resulting_rule_version IS NULL OR resulting_rule_version >= 1),
    rule_status TEXT CHECK (rule_status IS NULL OR rule_status IN ('active', 'retired')),
    CHECK (application_status <> 'applied' OR (
      rule_id IS NOT NULL AND resulting_rule_version IS NOT NULL AND rule_status IS NOT NULL)),
    FOREIGN KEY(local_proposal_id) REFERENCES evolution_proposals(id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE evolution_application_outbox (
    local_proposal_id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('pending', 'published')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    updated_at INTEGER NOT NULL,
    published_at INTEGER,
    last_error TEXT,
    FOREIGN KEY(local_proposal_id)
      REFERENCES evolution_application_receipts(local_proposal_id) ON DELETE RESTRICT
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX evolution_application_outbox_pending
    ON evolution_application_outbox(state, updated_at, local_proposal_id);
`

function migrateV8ToV9(database: DatabaseSync): void {
  database.exec(`
    -- v8 rows were projected from a raw immutable Evaluation outcome.  They
    -- cannot represent a later owner override or objective conflict, so they
    -- must not remain votes once the canonical task projection becomes the
    -- only source.  Evaluation v5 requeues retained tasks and repopulates this
    -- ledger through the versioned seam after startup.
    CREATE TEMP TABLE evolution_v9_legacy_learning_scopes AS
      SELECT DISTINCT scope_key FROM evolution_episodes WHERE learning_eligible = 1;
    UPDATE evolution_episodes
      SET evidence_kind = 'legacy-unknown', evidence_ref = NULL,
          learning_subject_ref = NULL, learning_eligible = 0
      WHERE learning_eligible = 1;
    UPDATE evolution_proposals
      SET status = 'conflicted', version = version + 1
      WHERE status = 'pending'
        AND scope_key IN (SELECT scope_key FROM evolution_v9_legacy_learning_scopes);
    DROP TABLE evolution_v9_legacy_learning_scopes;

    ${taskLearningProjectionSchema}

    INSERT INTO schema_meta(key, value) VALUES ('schema-version', '9')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    PRAGMA user_version = 9;
  `)
}

function migrateV9ToV10(database: DatabaseSync): void {
  database.exec(`
    ${supervisedGrowthAnalystSchema}

    INSERT INTO schema_meta(key, value) VALUES ('schema-version', '10')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    PRAGMA user_version = 10;
  `)
}

function migrateV10ToV11(database: DatabaseSync): void {
  database.exec(`
    ${applicationReceiptSchema}

    INSERT INTO schema_meta(key, value) VALUES ('schema-version', '11')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    PRAGMA user_version = 11;
  `)
}

function migrateV11ToV12(database: DatabaseSync): void {
  const hasColumn = (table: string, column: string): boolean => database
    .prepare(`SELECT name FROM pragma_table_info(?) WHERE name = ?`)
    .get(table, column) !== undefined
  if (!hasColumn('evolution_task_learning_state', 'scope_watermark')) {
    database.exec(`ALTER TABLE evolution_task_learning_state
      ADD COLUMN scope_watermark INTEGER NOT NULL DEFAULT 0 CHECK (scope_watermark >= 0)`)
  }
  if (!hasColumn('evolution_task_learning_revisions', 'scope_watermark')) {
    database.exec(`ALTER TABLE evolution_task_learning_revisions
      ADD COLUMN scope_watermark INTEGER NOT NULL DEFAULT 0 CHECK (scope_watermark >= 0)`)
  }
  if (!hasColumn('evolution_supervised_analyst_reviews', 'scope_watermark')) {
    database.exec(`ALTER TABLE evolution_supervised_analyst_reviews
      ADD COLUMN scope_watermark INTEGER NOT NULL DEFAULT 0 CHECK (scope_watermark >= 0)`)
  }
  if (!hasColumn('evolution_supervised_analyst_reviews', 'task_revisions_json')) {
    database.exec(`ALTER TABLE evolution_supervised_analyst_reviews
      ADD COLUMN task_revisions_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(task_revisions_json) AND json_type(task_revisions_json) = 'array')`)
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS evolution_scope_learning_watermarks (
      scope_key TEXT PRIMARY KEY,
      watermark INTEGER NOT NULL CHECK (watermark >= 1),
      updated_at INTEGER NOT NULL
    ) STRICT, WITHOUT ROWID;

    -- No pre-v12 pending proposal froze the authoritative Evaluation scope
    -- watermark and complete task tuple. Preserve it for audit, but never let a
    -- later approval apply it. Attached rows receive terminal receipts during
    -- the normal constructor backfill.
    UPDATE evolution_proposals
      SET status = 'conflicted', version = version + 1
      WHERE status = 'pending';

    INSERT INTO schema_meta(key, value) VALUES ('schema-version', '12')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    PRAGMA user_version = 12;
  `)
}

function createCurrentSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    -- One observed outcome. Episodes are append-only and carry only trusted
    -- attribution proven by a durable session exposure receipt.
    CREATE TABLE evolution_episodes (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      situation TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
      detail TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('automation', 'evaluation', 'foreground')),
      scope_key TEXT NOT NULL,
      trust TEXT NOT NULL CHECK (trust IN ('trusted', 'self-reported', 'legacy')),
      evidence_kind TEXT NOT NULL CHECK (
        evidence_kind IN ('operational', 'objective', 'verification', 'legacy-unknown')),
      evidence_ref TEXT,
      learning_subject_ref TEXT,
      learning_eligible INTEGER NOT NULL CHECK (learning_eligible IN (0, 1)),
      rule_id TEXT,
      guidance_version INTEGER CHECK (guidance_version IS NULL OR guidance_version >= 1),
      claimed_rule_id TEXT,
      occurred_at INTEGER NOT NULL,
      CHECK ((learning_eligible = 0 AND learning_subject_ref IS NULL) OR (
        learning_eligible = 1
        AND learning_subject_ref IS NOT NULL
        AND
        source = 'evaluation'
        AND
        trust = 'trusted'
        AND evidence_kind IN ('objective', 'verification')
        AND evidence_ref IS NOT NULL))
    ) STRICT;

    CREATE INDEX evolution_episodes_adoption
      ON evolution_episodes(
        scope_key, situation, learning_eligible, rule_id, occurred_at DESC, id DESC);
    CREATE INDEX evolution_episodes_evaluation
      ON evolution_episodes(
        rule_id, guidance_version, learning_eligible, occurred_at DESC, id DESC);
    CREATE UNIQUE INDEX evolution_episodes_quality_evidence_identity
      ON evolution_episodes(scope_key, evidence_ref)
      WHERE learning_eligible = 1;
    CREATE UNIQUE INDEX evolution_episodes_learning_subject_identity
      ON evolution_episodes(scope_key, learning_subject_ref)
      WHERE learning_eligible = 1;

    CREATE TABLE evolution_rules (
      id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      situation TEXT NOT NULL,
      guidance TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
      baseline_failures INTEGER NOT NULL CHECK (baseline_failures >= 0),
      baseline_total INTEGER NOT NULL CHECK (baseline_total > 0),
      adopted_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      retired_reason TEXT,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      generation INTEGER NOT NULL CHECK (generation >= 1)
    ) STRICT;

    CREATE UNIQUE INDEX evolution_rules_active_scope_situation
      ON evolution_rules(scope_key, situation) WHERE status = 'active';
    CREATE UNIQUE INDEX evolution_rules_scope_generation
      ON evolution_rules(scope_key, situation, generation);

    CREATE TABLE evolution_proposals (
      id TEXT PRIMARY KEY,
      policy_proposal_id TEXT UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      requester TEXT NOT NULL,
      principal TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      mutation_hash TEXT NOT NULL,
      mutation_json TEXT NOT NULL,
      creation_intent_json TEXT,
      settlement_expectation_json TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'conflicted')),
      expires_at INTEGER NOT NULL,
      result_rule_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    ) STRICT;

    CREATE TABLE evolution_audit (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL UNIQUE,
      operation TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      result_version INTEGER NOT NULL,
      occurred_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE evolution_guidance_exposures (
      session_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      situation TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      guidance_version INTEGER NOT NULL CHECK (guidance_version >= 1),
      exposed_at INTEGER NOT NULL,
      PRIMARY KEY(session_id, scope_key, rule_id, guidance_version)
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX evolution_guidance_exposures_lookup
      ON evolution_guidance_exposures(session_id, scope_key, situation, exposed_at, rule_id);

    CREATE TABLE evolution_autonomous_rollbacks (
      idempotency_key TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      expected_version INTEGER NOT NULL CHECK (expected_version >= 1),
      result_version INTEGER NOT NULL CHECK (result_version = expected_version + 1),
      risk TEXT NOT NULL CHECK (risk = 'low'),
      reason TEXT NOT NULL,
      evaluation_failures INTEGER NOT NULL CHECK (evaluation_failures >= 0),
      evaluation_total INTEGER NOT NULL CHECK (
        evaluation_total > 0 AND evaluation_failures <= evaluation_total),
      baseline_failures INTEGER NOT NULL CHECK (baseline_failures >= 0),
      baseline_total INTEGER NOT NULL CHECK (
        baseline_total > 0 AND baseline_failures <= baseline_total),
      evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64),
      evidence_total INTEGER NOT NULL CHECK (evidence_total = evaluation_total),
      sample_episode_ids_json TEXT NOT NULL CHECK (
        json_valid(sample_episode_ids_json) AND json_type(sample_episode_ids_json) = 'array'),
      occurred_at INTEGER NOT NULL,
      UNIQUE(scope_key, rule_id, expected_version),
      FOREIGN KEY(rule_id) REFERENCES evolution_rules(id)
    ) STRICT;
    CREATE INDEX evolution_autonomous_rollbacks_occurred
      ON evolution_autonomous_rollbacks(occurred_at);

    ${taskLearningProjectionSchema}

    CREATE TABLE evolution_scope_learning_watermarks (
      scope_key TEXT PRIMARY KEY,
      watermark INTEGER NOT NULL CHECK (watermark >= 1),
      updated_at INTEGER NOT NULL
    ) STRICT, WITHOUT ROWID;

    ${supervisedGrowthAnalystSchema}

    ${applicationReceiptSchema}

    INSERT INTO schema_meta(key, value) VALUES ('schema-version', '12');
    PRAGMA user_version = 12;
  `)
}

/** Serialize every schema transition and re-read the version after the lock. */
function migrate(database: DatabaseSync): void {
  const initial = schemaVersion(database)
  assertSupported(initial)
  if (initial === evolutionSchemaVersion) return

  database.exec('BEGIN IMMEDIATE')
  try {
    let version = schemaVersion(database)
    assertSupported(version)
    if (version === 0) {
      createCurrentSchema(database)
      version = evolutionSchemaVersion
    }
    while (version < evolutionSchemaVersion) {
      if (version === 1) migrateV1ToV2(database)
      else if (version === 2) migrateV2ToV3(database)
      else if (version === 3) migrateV3ToV4(database)
      else if (version === 4) migrateV4ToV5(database)
      else if (version === 5) migrateV5ToV6(database)
      else if (version === 6) migrateV6ToV7(database)
      else if (version === 7) migrateV7ToV8(database)
      else if (version === 8) migrateV8ToV9(database)
      else if (version === 9) migrateV9ToV10(database)
      else if (version === 10) migrateV10ToV11(database)
      else if (version === 11) migrateV11ToV12(database)
      version = schemaVersion(database)
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
        throw new Error(`evolution database refused WAL mode: ${row.journal_mode}`)
      }
      return
    } catch (error) {
      const retryable = error instanceof Error && /database is (?:busy|locked)/i.test(error.message)
      if (!retryable || Date.now() >= deadline) throw error
      Atomics.wait(walRetryWait, 0, 0, 10)
    }
  }
}

export function openEvolutionDatabase(path: string): DatabaseSync {
  if (path !== ':memory:' && !isAbsolute(path)) {
    throw new EvolutionDatabaseError('invalid-path', 'evolution database path must be absolute')
  }
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
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
