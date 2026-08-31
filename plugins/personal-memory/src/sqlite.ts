import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const memorySchemaVersion = 4

export class MemoryDatabaseError extends Error {
  constructor(
    readonly code: 'invalid-path' | 'schema-too-new' | 'unsafe-file',
    message: string,
  ) {
    super(message)
    this.name = 'MemoryDatabaseError'
  }
}

const namespaceColumns = `
  namespace_mode TEXT NOT NULL CHECK (namespace_mode IN ('delivery', 'headless', 'legacy-quarantine')),
  namespace_key TEXT NOT NULL,
  principal_digest TEXT,
  principal_record_id TEXT,
  principal_version INTEGER,
  headless_lineage_id TEXT,
  headless_lineage_version INTEGER`

const namespaceConstraint = `CHECK (
  (namespace_mode = 'legacy-quarantine' AND namespace_key = 'legacy-v2'
    AND principal_digest IS NULL AND principal_record_id IS NULL AND principal_version IS NULL
    AND headless_lineage_id IS NULL AND headless_lineage_version IS NULL)
  OR
  (namespace_mode = 'delivery' AND length(namespace_key) = 64
    AND namespace_key NOT GLOB '*[^0-9a-f]*'
    AND length(principal_digest) = 64 AND principal_digest NOT GLOB '*[^0-9a-f]*'
    AND principal_record_id IS NOT NULL AND principal_record_id <> '' AND principal_version >= 1
    AND headless_lineage_id IS NULL AND headless_lineage_version IS NULL)
  OR
  (namespace_mode = 'headless' AND length(namespace_key) = 64
    AND namespace_key NOT GLOB '*[^0-9a-f]*'
    AND length(principal_digest) = 64 AND principal_digest NOT GLOB '*[^0-9a-f]*'
    AND principal_record_id IS NULL AND principal_version IS NULL
    AND headless_lineage_id IS NOT NULL AND headless_lineage_id <> ''
    AND headless_lineage_version >= 1)
)`

function createV3Tables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE memory_records (
      id TEXT PRIMARY KEY,
      ${namespaceColumns},
      owner TEXT NOT NULL CHECK (owner IN ('user', 'agent')),
      scope TEXT NOT NULL CHECK (scope IN ('user-global', 'workspace')),
      workspace TEXT NOT NULL,
      agent_preset TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'instruction', 'experience')),
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      sensitivity TEXT NOT NULL CHECK (sensitivity IN ('private', 'sensitive')),
      trust TEXT NOT NULL CHECK (trust IN ('user-confirmed', 'agent-observed', 'external')),
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      provenance_json TEXT NOT NULL,
      supersedes TEXT,
      expires_at INTEGER,
      status TEXT NOT NULL CHECK (status IN ('active', 'removed')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      ${namespaceConstraint}
    ) STRICT;

    CREATE TABLE memory_tokens (
      memory_id TEXT NOT NULL,
      token TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1,
      PRIMARY KEY (memory_id, token),
      FOREIGN KEY (memory_id) REFERENCES memory_records(id) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE memory_proposals (
      id TEXT PRIMARY KEY,
      ${namespaceColumns},
      policy_proposal_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL,
      requester TEXT NOT NULL,
      principal TEXT NOT NULL,
      mutation_hash TEXT NOT NULL,
      mutation_json TEXT NOT NULL,
      promotion_json TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'conflicted')),
      not_after INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      result_memory_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      ${namespaceConstraint}
    ) STRICT;

    CREATE TABLE memory_proposal_intents (
      id TEXT PRIMARY KEY,
      ${namespaceColumns},
      idempotency_key TEXT NOT NULL,
      requester TEXT NOT NULL,
      principal TEXT NOT NULL,
      mutation_hash TEXT NOT NULL,
      mutation_json TEXT NOT NULL,
      promotion_json TEXT,
      ttl_ms INTEGER NOT NULL CHECK (ttl_ms > 0),
      not_after INTEGER NOT NULL,
      dispatch_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ${namespaceConstraint}
    ) STRICT;

    CREATE TABLE memory_audit (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      ${namespaceColumns},
      idempotency_key TEXT NOT NULL,
      mutation_hash TEXT NOT NULL,
      operation TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      result_version INTEGER NOT NULL,
      occurred_at INTEGER NOT NULL,
      ${namespaceConstraint}
    ) STRICT;

    CREATE TABLE memory_promotion_results (
      promotion_id TEXT NOT NULL,
      promotion_generation INTEGER NOT NULL CHECK (promotion_generation >= 1),
      request_digest TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
      ${namespaceColumns},
      owner_generation INTEGER NOT NULL CHECK (owner_generation >= 1),
      contract_version INTEGER NOT NULL CHECK (contract_version = 1),
      result_version INTEGER NOT NULL CHECK (result_version >= 1),
      status TEXT NOT NULL CHECK (status IN ('confirmed', 'rejected', 'expired', 'conflicted', 'stale-owner')),
      memory_proposal_id TEXT NOT NULL UNIQUE,
      memory_proposal_version INTEGER NOT NULL CHECK (memory_proposal_version >= 1),
      occurred_at INTEGER NOT NULL,
      receipt_digest TEXT NOT NULL CHECK (length(receipt_digest) = 64 AND receipt_digest NOT GLOB '*[^0-9a-f]*'),
      memory_record_id TEXT,
      memory_record_version INTEGER,
      memory_record_digest TEXT,
      state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (promotion_id, promotion_generation),
      CHECK (
        (status = 'confirmed' AND memory_record_id IS NOT NULL AND memory_record_version >= 1
          AND length(memory_record_digest) = 64 AND memory_record_digest NOT GLOB '*[^0-9a-f]*')
        OR
        (status <> 'confirmed' AND memory_record_id IS NULL
          AND memory_record_version IS NULL AND memory_record_digest IS NULL)
      ),
      ${namespaceConstraint}
    ) STRICT;

    CREATE TABLE memory_promotion_cancellations (
      promotion_id TEXT NOT NULL,
      promotion_generation INTEGER NOT NULL CHECK (promotion_generation >= 1),
      request_digest TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
      principal_record_id TEXT NOT NULL CHECK (principal_record_id <> ''),
      principal_version INTEGER NOT NULL CHECK (principal_version >= 1),
      owner_generation INTEGER NOT NULL CHECK (owner_generation >= 1),
      cancellation_digest TEXT NOT NULL CHECK (
        length(cancellation_digest) = 64 AND cancellation_digest NOT GLOB '*[^0-9a-f]*'
      ),
      reason TEXT NOT NULL CHECK (reason IN ('forget', 'owner-rotated', 'superseded')),
      occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
      receipt_digest TEXT NOT NULL CHECK (
        length(receipt_digest) = 64 AND receipt_digest NOT GLOB '*[^0-9a-f]*'
      ),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (promotion_id, promotion_generation)
    ) STRICT;
  `)
}

function createV4CompensationTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE memory_promotion_compensations (
      promotion_id TEXT NOT NULL,
      promotion_generation INTEGER NOT NULL CHECK (promotion_generation >= 1),
      request_digest TEXT NOT NULL CHECK (
        length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
      ),
      cancellation_digest TEXT NOT NULL CHECK (
        length(cancellation_digest) = 64 AND cancellation_digest NOT GLOB '*[^0-9a-f]*'
      ),
      memory_proposal_id TEXT NOT NULL,
      memory_proposal_version INTEGER NOT NULL CHECK (memory_proposal_version >= 1),
      memory_record_id TEXT NOT NULL,
      memory_record_version INTEGER NOT NULL CHECK (memory_record_version >= 1),
      memory_record_digest TEXT NOT NULL CHECK (
        length(memory_record_digest) = 64 AND memory_record_digest NOT GLOB '*[^0-9a-f]*'
      ),
      removed_record_version INTEGER NOT NULL CHECK (removed_record_version >= 2),
      compensated_at INTEGER NOT NULL CHECK (compensated_at >= 0),
      PRIMARY KEY (promotion_id, promotion_generation)
    ) STRICT;
  `)
}

function createV3Indexes(database: DatabaseSync): void {
  database.exec(`
    CREATE INDEX memory_records_scope
      ON memory_records(namespace_key, owner, scope, workspace, agent_preset, status, updated_at DESC);
    CREATE INDEX memory_records_hash
      ON memory_records(namespace_key, owner, scope, workspace, agent_preset, content_hash, status);
    CREATE INDEX memory_tokens_token ON memory_tokens(token, memory_id);
    CREATE UNIQUE INDEX memory_proposals_idempotency
      ON memory_proposals(namespace_key, idempotency_key);
    CREATE INDEX memory_proposals_reconcile
      ON memory_proposals(namespace_mode, status, updated_at, id);
    CREATE UNIQUE INDEX memory_proposal_intents_idempotency
      ON memory_proposal_intents(namespace_key, idempotency_key);
    CREATE INDEX memory_proposal_intents_reconcile
      ON memory_proposal_intents(namespace_mode, updated_at, id);
    CREATE UNIQUE INDEX memory_audit_idempotency
      ON memory_audit(namespace_key, idempotency_key);
    CREATE INDEX memory_promotion_results_pending
      ON memory_promotion_results(state, updated_at, promotion_id, promotion_generation);
  `)
}

function assertSafeFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new MemoryDatabaseError('unsafe-file', 'memory database must be one regular, unlinked file')
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new MemoryDatabaseError('unsafe-file', 'memory database permissions must not allow group or other access')
  }
  const uid = process.getuid?.()
  if (uid !== undefined && stat.uid !== uid) {
    throw new MemoryDatabaseError('unsafe-file', 'memory database must be owned by the current OS user')
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
  for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
    try {
      assertSafeFile(sidecar)
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
        throw new Error(`memory database refused WAL mode: ${row.journal_mode}`)
      }
      return
    } catch (error) {
      const retryable = error instanceof Error && /database is (?:busy|locked)/i.test(error.message)
      if (!retryable || Date.now() >= deadline) throw error
      Atomics.wait(walRetryWait, 0, 0, 10)
    }
  }
}

function createFresh(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    INSERT INTO schema_meta(key, value) VALUES ('schema-version', '4');
  `)
  createV3Tables(database)
  createV4CompensationTable(database)
  createV3Indexes(database)
}

function migrateV3ToV4(database: DatabaseSync): void {
  createV4CompensationTable(database)
  database.exec(`
    UPDATE schema_meta SET value = '4' WHERE key = 'schema-version';
    PRAGMA user_version = 4;
  `)
}

function migrateV1ToV2(database: DatabaseSync): void {
  database.exec(`
    CREATE INDEX memory_proposals_reconcile
      ON memory_proposals(status, updated_at, id);
    CREATE TABLE memory_proposal_intents (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      requester TEXT NOT NULL,
      principal TEXT NOT NULL,
      mutation_hash TEXT NOT NULL,
      mutation_json TEXT NOT NULL,
      ttl_ms INTEGER NOT NULL CHECK (ttl_ms > 0),
      dispatch_source_id TEXT,
      dispatch_binding_id TEXT,
      dispatch_workspace TEXT,
      dispatch_principal TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (
        (dispatch_source_id IS NULL AND dispatch_binding_id IS NULL
          AND dispatch_workspace IS NULL AND dispatch_principal IS NULL)
        OR
        (dispatch_source_id IS NOT NULL AND dispatch_binding_id IS NOT NULL
          AND dispatch_workspace IS NOT NULL AND dispatch_principal IS NOT NULL)
      )
    ) STRICT;
    CREATE INDEX memory_proposal_intents_reconcile
      ON memory_proposal_intents(updated_at, id);
    UPDATE schema_meta SET value = '2' WHERE key = 'schema-version';
    PRAGMA user_version = 2;
  `)
}

function migrateV2ToV3(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE memory_records RENAME TO memory_records_v2;
    ALTER TABLE memory_tokens RENAME TO memory_tokens_v2;
    ALTER TABLE memory_proposals RENAME TO memory_proposals_v2;
    ALTER TABLE memory_proposal_intents RENAME TO memory_proposal_intents_v2;
    ALTER TABLE memory_audit RENAME TO memory_audit_v2;
  `)
  createV3Tables(database)
  database.exec(`
    INSERT INTO memory_records(
      id, namespace_mode, namespace_key, principal_digest, principal_record_id, principal_version,
      headless_lineage_id, headless_lineage_version, owner, scope, workspace, agent_preset,
      kind, content, content_hash, sensitivity, trust, confidence, provenance_json, supersedes, expires_at,
      status, created_at, updated_at, version
    ) SELECT id, 'legacy-quarantine', 'legacy-v2', NULL, NULL, NULL, NULL, NULL, owner, scope, workspace,
      agent_preset, kind, content, content_hash, sensitivity, trust, confidence, provenance_json, supersedes,
      expires_at, status, created_at, updated_at, version FROM memory_records_v2;
    INSERT INTO memory_tokens(memory_id, token, weight)
      SELECT memory_id, token, weight FROM memory_tokens_v2;
    INSERT INTO memory_proposals(
      id, namespace_mode, namespace_key, principal_digest, principal_record_id, principal_version,
      headless_lineage_id, headless_lineage_version, policy_proposal_id, idempotency_key,
      requester, principal, mutation_hash, mutation_json, promotion_json, status, not_after, expires_at, result_memory_id,
      created_at, updated_at, version
    ) SELECT id, 'legacy-quarantine', 'legacy-v2', NULL, NULL, NULL, NULL, NULL, policy_proposal_id,
      idempotency_key, requester, principal, mutation_hash, mutation_json, NULL,
      CASE WHEN status = 'pending' THEN 'conflicted' ELSE status END, expires_at, expires_at, result_memory_id,
      created_at, updated_at, CASE WHEN status = 'pending' THEN version + 1 ELSE version END
      FROM memory_proposals_v2;
    INSERT INTO memory_proposal_intents(
      id, namespace_mode, namespace_key, principal_digest, principal_record_id, principal_version,
      headless_lineage_id, headless_lineage_version, idempotency_key, requester, principal,
      mutation_hash, mutation_json, promotion_json, ttl_ms, not_after, dispatch_json, created_at, updated_at
    ) SELECT id, 'legacy-quarantine', 'legacy-v2', NULL, NULL, NULL, NULL, NULL, idempotency_key, requester,
      principal, mutation_hash, mutation_json, NULL, ttl_ms, created_at + ttl_ms,
      CASE WHEN dispatch_source_id IS NULL THEN NULL ELSE json_object(
        'sourceId', dispatch_source_id, 'bindingId', dispatch_binding_id,
        'workspace', dispatch_workspace, 'principal', dispatch_principal) END, created_at, updated_at
      FROM memory_proposal_intents_v2;
    INSERT INTO memory_audit(
      sequence, namespace_mode, namespace_key, principal_digest, principal_record_id, principal_version,
      headless_lineage_id, headless_lineage_version, idempotency_key, mutation_hash,
      operation, memory_id, result_version, occurred_at
    ) SELECT sequence, 'legacy-quarantine', 'legacy-v2', NULL, NULL, NULL, NULL, NULL, idempotency_key,
      mutation_hash, operation, memory_id, result_version, occurred_at FROM memory_audit_v2;

    DROP TABLE memory_tokens_v2;
    DROP TABLE memory_records_v2;
    DROP TABLE memory_proposals_v2;
    DROP TABLE memory_proposal_intents_v2;
    DROP TABLE memory_audit_v2;
  `)
  createV3Indexes(database)
  database.exec(`
    UPDATE schema_meta SET value = '3' WHERE key = 'schema-version';
    PRAGMA user_version = 3;
  `)
}

function migrate(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    let row = database.prepare('PRAGMA user_version').get() as { user_version: number }
    if (row.user_version > memorySchemaVersion) {
      throw new MemoryDatabaseError(
        'schema-too-new',
        `memory schema ${row.user_version} is newer than supported schema ${memorySchemaVersion}`,
      )
    }
    if (row.user_version === 0) {
      createFresh(database)
      database.exec('PRAGMA user_version = 4')
    } else {
      if (row.user_version === 1) migrateV1ToV2(database)
      row = database.prepare('PRAGMA user_version').get() as { user_version: number }
      if (row.user_version === 2) migrateV2ToV3(database)
      row = database.prepare('PRAGMA user_version').get() as { user_version: number }
      if (row.user_version === 3) migrateV3ToV4(database)
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export function openMemoryDatabase(path: string): DatabaseSync {
  if (path !== ':memory:' && !isAbsolute(path)) {
    throw new MemoryDatabaseError('invalid-path', 'memory database path must be absolute')
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
      for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
        try {
          chmodSync(sidecar, 0o600)
          assertSafeFile(sidecar)
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
