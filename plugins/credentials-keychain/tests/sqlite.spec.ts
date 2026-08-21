import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { credentialSchemaVersion, openCredentialDatabase } from '../src/sqlite.ts'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

describe('credential SQLite hardening', () => {
  test('requires an absolute path and creates private WAL/FULL storage', async () => {
    expect(() => openCredentialDatabase('relative.sqlite')).toThrow(/absolute/i)
    const root = await mkdtemp(join(tmpdir(), 'credential-sqlite-'))
    roots.push(root)
    await chmod(root, 0o755)
    const path = join(root, 'private', 'credentials.sqlite')
    const db = openCredentialDatabase(path)
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    expect(db.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 2 })
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: credentialSchemaVersion })
    expect((await stat(join(root, 'private'))).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    db.close()
  })

  test('refuses a future schema without rewriting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'credential-future-'))
    roots.push(root)
    const path = join(root, 'credentials.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec(`PRAGMA user_version = ${credentialSchemaVersion + 1}`)
    raw.close()
    expect(() => openCredentialDatabase(path)).toThrowError(expect.objectContaining({ code: 'schema-too-new' }))
    const inspect = new DatabaseSync(path)
    expect(inspect.prepare('PRAGMA user_version').get()).toEqual({ user_version: credentialSchemaVersion + 1 })
    inspect.close()
  })
})
