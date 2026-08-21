import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const memorySchemaVersion = 1

export class MemoryDatabaseError extends Error {
  constructor(
    readonly code: 'invalid-path' | 'schema-too-new',
    message: string,
  ) {
    super(message)
    this.name = 'MemoryDatabaseError'
  }
}

function migrate(database: DatabaseSync): void {
  const row = database.prepare('PRAGMA user_version').get() as { user_version: number }
  if (row.user_version > memorySchemaVersion) {
    throw new MemoryDatabaseError(
      'schema-too-new',
      `memory schema ${row.user_version} is newer than supported schema ${memorySchemaVersion}`,
    )
  }
  if (row.user_version === memorySchemaVersion) return

  database.exec(`
    BEGIN IMMEDIATE;

    CREATE TABLE schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE memory_records (
      id TEXT PRIMARY KEY,
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
      version INTEGER NOT NULL CHECK (version >= 1)
    ) STRICT;

    CREATE INDEX memory_records_scope
      ON memory_records(owner, scope, workspace, agent_preset, status, updated_at DESC);
    CREATE INDEX memory_records_hash
      ON memory_records(owner, scope, workspace, agent_preset, content_hash, status);

    CREATE TABLE memory_tokens (
      memory_id TEXT NOT NULL,
      token TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1,
      PRIMARY KEY (memory_id, token),
      FOREIGN KEY (memory_id) REFERENCES memory_records(id) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX memory_tokens_token ON memory_tokens(token, memory_id);

    CREATE TABLE memory_proposals (
      id TEXT PRIMARY KEY,
      policy_proposal_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      requester TEXT NOT NULL,
      principal TEXT NOT NULL,
      mutation_hash TEXT NOT NULL,
      mutation_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'conflicted')),
      expires_at INTEGER NOT NULL,
      result_memory_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    ) STRICT;

    CREATE TABLE memory_audit (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL UNIQUE,
      mutation_hash TEXT NOT NULL,
      operation TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      result_version INTEGER NOT NULL,
      occurred_at INTEGER NOT NULL
    ) STRICT;

    INSERT INTO schema_meta(key, value) VALUES ('schema-version', '1');
    PRAGMA user_version = 1;
    COMMIT;
  `)
}

export function openMemoryDatabase(path: string): DatabaseSync {
  if (path !== ':memory:' && !isAbsolute(path)) {
    throw new MemoryDatabaseError('invalid-path', 'memory database path must be absolute')
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
