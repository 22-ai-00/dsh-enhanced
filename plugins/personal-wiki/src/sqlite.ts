import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const wikiSchemaVersion = 1

export class WikiDatabaseError extends Error {
  constructor(readonly code: 'invalid-path' | 'schema-too-new', message: string) {
    super(message)
    this.name = 'WikiDatabaseError'
  }
}

function migrate(database: DatabaseSync): void {
  const row = database.prepare('PRAGMA user_version').get() as { user_version: number }
  if (row.user_version > wikiSchemaVersion) {
    throw new WikiDatabaseError(
      'schema-too-new',
      `wiki schema ${row.user_version} is newer than supported schema ${wikiSchemaVersion}`,
    )
  }
  if (row.user_version === wikiSchemaVersion) return
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE wiki_proposals (
      id TEXT PRIMARY KEY,
      policy_proposal_id TEXT UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      requester TEXT NOT NULL,
      principal TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      write_hash TEXT NOT NULL,
      write_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'conflicted')),
      expires_at INTEGER NOT NULL,
      result_page_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    ) STRICT;
    CREATE TABLE wiki_audit (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT NOT NULL,
      write_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      result_page_id TEXT,
      occurred_at INTEGER NOT NULL,
      UNIQUE(proposal_id, status)
    ) STRICT;
    PRAGMA user_version = 1;
    COMMIT;
  `)
}

export function openWikiDatabase(path: string): DatabaseSync {
  if (path !== ':memory:' && !isAbsolute(path)) {
    throw new WikiDatabaseError('invalid-path', 'wiki database path must be absolute')
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
