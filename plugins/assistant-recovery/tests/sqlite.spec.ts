import {
  chmodSync,
  closeSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EMPTY_BOOTSTRAP_ATTESTATION_SET_DIGEST,
  RecoveryDatabaseError,
  openRecoveryDatabase,
  recoverySchemaVersion,
} from '../src/sqlite.ts'

const roots: string[] = []

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'assistant-recovery-sqlite-'))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

describe('recovery database', () => {
  it('creates a private WAL/FULL ledger', () => {
    const path = join(root(), 'private', 'recovery.sqlite')
    const database = openRecoveryDatabase(path)
    expect((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      .toBe(recoverySchemaVersion)
    expect((database.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode)
      .toBe('wal')
    expect((database.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous)
      .toBe(2)
    database.close()
    expect(lstatSync(path).mode & 0o777).toBe(0o600)
    expect(lstatSync(join(path, '..')).mode & 0o077).toBe(0)
  })

  it('rejects relative, permissive, symlink and hard-linked files', () => {
    expect(() => openRecoveryDatabase('relative.sqlite'))
      .toThrowError(expect.objectContaining<Partial<RecoveryDatabaseError>>({ code: 'invalid-path' }))

    const directory = root()
    const permissive = join(directory, 'permissive.sqlite')
    closeSync(openSync(permissive, 'w', 0o666))
    chmodSync(permissive, 0o644)
    expect(() => openRecoveryDatabase(permissive))
      .toThrowError(expect.objectContaining<Partial<RecoveryDatabaseError>>({ code: 'unsafe-file' }))

    const target = join(directory, 'target.sqlite')
    closeSync(openSync(target, 'w', 0o600))
    const symlink = join(directory, 'symlink.sqlite')
    symlinkSync(target, symlink)
    expect(() => openRecoveryDatabase(symlink))
      .toThrowError(expect.objectContaining<Partial<RecoveryDatabaseError>>({ code: 'unsafe-file' }))

    const linked = join(directory, 'linked.sqlite')
    linkSync(target, linked)
    expect(() => openRecoveryDatabase(target))
      .toThrowError(expect.objectContaining<Partial<RecoveryDatabaseError>>({ code: 'unsafe-file' }))
  })

  it('rejects a database created by a newer Recovery schema', () => {
    const path = join(root(), 'future.sqlite')
    const database = new DatabaseSync(path)
    database.exec(`PRAGMA user_version = ${recoverySchemaVersion + 1}`)
    database.close()
    chmodSync(path, 0o600)
    expect(() => openRecoveryDatabase(path))
      .toThrowError(expect.objectContaining<Partial<RecoveryDatabaseError>>({ code: 'schema-too-new' }))
  })

  it('migrates v1 runs to a non-attesting legacy plan digest and adds bootstrap state', () => {
    const path = join(root(), 'legacy.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE recovery_runs (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL) STRICT;
      CREATE TABLE recovery_steps (
        run_id TEXT NOT NULL, step_id TEXT NOT NULL, started_at INTEGER NOT NULL,
        PRIMARY KEY(run_id, step_id)
      ) STRICT, WITHOUT ROWID;
      INSERT INTO recovery_runs(id, started_at) VALUES ('legacy-run', 1000);
      INSERT INTO recovery_steps(run_id, step_id, started_at)
        VALUES ('legacy-run', 'authority-admission', 2000);
      PRAGMA user_version = 1;
    `)
    legacy.close()
    chmodSync(path, 0o600)

    const migrated = openRecoveryDatabase(path)
    expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      .toBe(recoverySchemaVersion)
    expect(migrated.prepare(`
      SELECT activation_plan_digest, deadline_at FROM recovery_runs WHERE id = 'legacy-run'
    `).get()).toEqual({
      activation_plan_digest: '2eb6dc66ca160135a7eb00a7c9a5217be11e45814929fa20863b0d0e0407a6c5',
      deadline_at: 851_000,
    })
    expect(migrated.prepare(`
      SELECT deadline_at FROM recovery_steps
      WHERE run_id = 'legacy-run' AND step_id = 'authority-admission'
    `).get()).toEqual({ deadline_at: 72_000 })
    expect(migrated.prepare(`
      SELECT bootstrap_status, bootstrap_failure_code, bootstrap_generation,
             bootstrap_attestation_valid, bootstrap_attestations_json,
             bootstrap_attestation_set_digest, updated_at
      FROM recovery_runtime_state WHERE singleton = 1
    `).get()).toEqual({
      bootstrap_status: 'idle',
      bootstrap_failure_code: null,
      bootstrap_generation: 0,
      bootstrap_attestation_valid: 0,
      bootstrap_attestations_json: '[]',
      bootstrap_attestation_set_digest: EMPTY_BOOTSTRAP_ATTESTATION_SET_DIGEST,
      updated_at: 0,
    })
    migrated.close()
  })

  it('invalidates timestamp-only v3 bootstrap success during migration', () => {
    const path = join(root(), 'legacy-v3.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE recovery_runtime_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        bootstrap_status TEXT NOT NULL CHECK (
          bootstrap_status IN ('failed', 'idle', 'running', 'succeeded')),
        bootstrap_failure_code TEXT,
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
        CHECK ((bootstrap_status = 'failed') = (bootstrap_failure_code IS NOT NULL))
      ) STRICT;
      INSERT INTO recovery_runtime_state (
        singleton, bootstrap_status, bootstrap_failure_code, updated_at
      ) VALUES (1, 'succeeded', NULL, 987654321);
      PRAGMA user_version = 3;
    `)
    legacy.close()
    chmodSync(path, 0o600)

    const migrated = openRecoveryDatabase(path)
    expect(migrated.prepare(`
      SELECT bootstrap_status, bootstrap_generation, bootstrap_attestation_valid,
             bootstrap_attestations_json, bootstrap_attestation_set_digest, updated_at
      FROM recovery_runtime_state WHERE singleton = 1
    `).get()).toEqual({
      bootstrap_status: 'idle',
      bootstrap_generation: 0,
      bootstrap_attestation_valid: 0,
      bootstrap_attestations_json: '[]',
      bootstrap_attestation_set_digest: EMPTY_BOOTSTRAP_ATTESTATION_SET_DIGEST,
      updated_at: 0,
    })
    migrated.close()
  })
})
