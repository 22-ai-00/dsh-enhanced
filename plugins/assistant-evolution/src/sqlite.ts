import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const evolutionSchemaVersion = 3

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
      source TEXT NOT NULL CHECK (source IN ('automation', 'foreground')),
      scope_key TEXT NOT NULL,
      trust TEXT NOT NULL CHECK (trust IN ('trusted', 'self-reported', 'legacy')),
      rule_id TEXT,
      guidance_version INTEGER CHECK (guidance_version IS NULL OR guidance_version >= 1),
      claimed_rule_id TEXT,
      occurred_at INTEGER NOT NULL
    ) STRICT;

    CREATE INDEX evolution_episodes_adoption
      ON evolution_episodes(scope_key, situation, trust, rule_id, occurred_at DESC, id DESC);
    CREATE INDEX evolution_episodes_evaluation
      ON evolution_episodes(rule_id, trust, occurred_at DESC, id DESC);

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

    INSERT INTO schema_meta(key, value) VALUES ('schema-version', '3');
    PRAGMA user_version = 3;
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
      version = schemaVersion(database)
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
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
      database.exec('PRAGMA journal_mode = WAL')
      chmodSync(path, 0o600)
    }
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
