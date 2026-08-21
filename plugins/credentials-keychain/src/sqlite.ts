import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const credentialSchemaVersion = 1

export class CredentialDatabaseError extends Error {
  constructor(readonly code: 'invalid-path' | 'schema-too-new', message: string) {
    super(message)
    this.name = 'CredentialDatabaseError'
  }
}

function migrate(database: DatabaseSync): void {
  const current = database.prepare('PRAGMA user_version').get() as { user_version: number }
  if (current.user_version > credentialSchemaVersion) {
    throw new CredentialDatabaseError('schema-too-new',
      `credential schema ${current.user_version} is newer than supported schema ${credentialSchemaVersion}`)
  }
  if (current.user_version === credentialSchemaVersion) return
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE credential_leases (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      handle_id TEXT NOT NULL,
      consumer TEXT NOT NULL,
      purpose TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'expired', 'failed', 'revoked')),
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      settled_at INTEGER,
      failure_code TEXT,
      version INTEGER NOT NULL DEFAULT 1
    ) STRICT;
    CREATE INDEX credential_leases_status_expiry ON credential_leases(status, expires_at);
    CREATE TABLE credential_audit (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at INTEGER NOT NULL,
      action TEXT NOT NULL,
      lease_id TEXT NOT NULL,
      handle_id TEXT NOT NULL,
      consumer TEXT NOT NULL,
      purpose TEXT NOT NULL,
      outcome TEXT NOT NULL,
      failure_code TEXT,
      actor TEXT,
      reason TEXT
    ) STRICT;
    PRAGMA user_version = 1;
    COMMIT;
  `)
}

export function openCredentialDatabase(path: string): DatabaseSync {
  if (path !== ':memory:' && !isAbsolute(path)) {
    throw new CredentialDatabaseError('invalid-path', 'credential database path must be absolute')
  }
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const database = new DatabaseSync(path)
  try {
    database.exec('PRAGMA foreign_keys = ON')
    database.exec('PRAGMA busy_timeout = 5000')
    database.exec('PRAGMA synchronous = FULL')
    if (path !== ':memory:') database.exec('PRAGMA journal_mode = WAL')
    migrate(database)
    if (path !== ':memory:') chmodSync(path, 0o600)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
