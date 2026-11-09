import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { controlPlaneSchemaVersion, openControlPlaneDatabase } from '../src/sqlite.ts'
import { controlPlaneDigest, ControlPlaneStore } from '../src/store.ts'
import type { ScopedPluginFile } from '../src/source-workspace.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function ledger(now = () => 5_000): { path: string; store: ControlPlaneStore } {
  const root = mkdtempSync(join(tmpdir(), 'cp-owner-instruction-request-'))
  roots.push(root)
  const path = join(root, 'control.sqlite')
  return { path, store: new ControlPlaneStore({ path, now }) }
}

const files: ScopedPluginFile[] = [{ path: 'README.md', content: '# demo\n' }, { path: 'src/index.ts', content: "export const value = 1\n" }]
const commit = 'a'.repeat(40)

const base = {
  planId: 'plan-1', pluginName: 'demo-plugin', expectedBaseCommit: commit,
  files, ttlMs: 900_000, idempotencyKey: 'key-1', createdAt: 1_000,
}

describe('owner instruction request store (schema 38)', () => {
  it('records and reads one pending request with frozen files and digest', () => {
    const { store, path } = ledger()
    expect(Number((new DatabaseSync(path).prepare('PRAGMA user_version').get() as { user_version: number }).user_version))
      .toBe(controlPlaneSchemaVersion)
    const recorded = store.recordOwnerInstructionRequest(base)
    expect(recorded.status).toBe('pending')
    expect(recorded.failureCode).toBeNull()
    expect(recorded.expiresAt).toBe(base.createdAt + base.ttlMs)
    expect(recorded.filesDigest).toBe(controlPlaneDigest(files))
    expect(recorded.requestId).toMatch(/^oir-[a-f0-9]{32}$/u)
    expect(recorded.files).toEqual(files)
    expect(store.getOwnerInstructionRequest(recorded.requestId)).toEqual(recorded)
    expect(store.getOwnerInstructionRequest('absent-oir')).toBeUndefined()
    store.close()
  })

  it('is idempotent for identical input and refuses a reused key with a different payload', () => {
    const { store } = ledger()
    const first = store.recordOwnerInstructionRequest(base)
    const again = store.recordOwnerInstructionRequest({ ...base })
    expect(again).toEqual(first)
    // A distinct idempotency key is a distinct, independently valid request.
    const second = store.recordOwnerInstructionRequest({ ...base, idempotencyKey: 'key-2' })
    expect(second.requestId).not.toBe(first.requestId)
    // Reusing the same key while changing any frozen payload collides on the UNIQUE key.
    expect(() => store.recordOwnerInstructionRequest({ ...base, files: [{ path: 'README.md', content: '# changed\n' }] }))
      .toThrow(/different input|UNIQUE/u)
    expect(() => store.recordOwnerInstructionRequest({ ...base, expectedBaseCommit: 'b'.repeat(40) }))
      .toThrow(/different input|UNIQUE/u)
    expect(() => store.recordOwnerInstructionRequest({ ...base, ttlMs: 1_000_000 })).toThrow(/different input|UNIQUE/u)
    store.close()
  })

  it('validates identities, base commit, ttl and the candidate file boundary', () => {
    const { store } = ledger()
    for (const change of [
      { planId: '../escape' }, { planId: '' }, { idempotencyKey: 'bad key' },
      { expectedBaseCommit: 'not-a-commit' }, { expectedBaseCommit: 'a'.repeat(39) },
      { ttlMs: 899_999 }, { ttlMs: 86_400_001 }, { createdAt: 0 },
      { files: [{ path: 'package.json', content: '{}' }] },
      { files: [{ path: 'src/version.ts', content: 'export const x = 1' }] },
      { files: [] as ScopedPluginFile[] },
    ]) {
      expect(() => store.recordOwnerInstructionRequest({ ...base, ...change })).toThrow()
    }
    store.close()
  })

  it('lists only pending unexpired requests oldest first', () => {
    const { store } = ledger()
    const first = store.recordOwnerInstructionRequest({ ...base, createdAt: 1_000 })
    const second = store.recordOwnerInstructionRequest({ ...base, planId: 'plan-2', idempotencyKey: 'key-2', createdAt: 2_000 })
    const third = store.recordOwnerInstructionRequest({ ...base, planId: 'plan-3', idempotencyKey: 'key-3', createdAt: 3_000 })
    // second expiresAt = 2000 + 900000 = 902000; third = 903000.
    expect(store.claimOwnerInstructionRequest(first.requestId, 5_000)).toBe(true)
    expect(store.listPendingOwnerInstructionRequests(5_000).map(item => item.requestId)).toEqual([
      second.requestId, third.requestId,
    ])
    // After second's expiry it drops out while the claimed first stays claimed.
    expect(store.listPendingOwnerInstructionRequests(902_500).map(item => item.requestId)).toEqual([third.requestId])
    // A claim after expiry is refused.
    expect(store.claimOwnerInstructionRequest(third.requestId, 903_500)).toBe(false)
    store.close()
  })

  it('claims with a CAS so a second tick cannot drain the same request', () => {
    const { store } = ledger()
    const recorded = store.recordOwnerInstructionRequest(base)
    expect(store.claimOwnerInstructionRequest(recorded.requestId, 5_000)).toBe(true)
    expect(store.claimOwnerInstructionRequest(recorded.requestId, 5_000)).toBe(false)
    expect(store.getOwnerInstructionRequest(recorded.requestId)?.status).toBe('claimed')
    store.close()
  })

  it('rejects a pending or claimed request with a bounded failure code and never reopens it', () => {
    const { store } = ledger()
    const recorded = store.recordOwnerInstructionRequest(base)
    store.rejectOwnerInstructionRequest(recorded.requestId, 'owner-route-unavailable', 5_000)
    const rejected = store.getOwnerInstructionRequest(recorded.requestId)
    expect(rejected?.status).toBe('rejected')
    expect(rejected?.failureCode).toBe('owner-route-unavailable')
    expect(store.claimOwnerInstructionRequest(recorded.requestId, 5_000)).toBe(false)
    expect(store.listPendingOwnerInstructionRequests(5_000)).toEqual([])
    expect(() => store.rejectOwnerInstructionRequest(recorded.requestId, '', 5_000)).toThrow()
    expect(() => store.rejectOwnerInstructionRequest(recorded.requestId, 'x'.repeat(121), 5_000)).toThrow()
    store.close()
  })

  it('accepts only a live claim and never re-lists an accepted request', () => {
    const { store } = ledger()
    const recorded = store.recordOwnerInstructionRequest(base)
    // Accepting before a claim does nothing.
    store.acceptOwnerInstructionRequest(recorded.requestId)
    expect(store.getOwnerInstructionRequest(recorded.requestId)?.status).toBe('pending')
    expect(store.claimOwnerInstructionRequest(recorded.requestId, 5_000)).toBe(true)
    store.acceptOwnerInstructionRequest(recorded.requestId)
    const accepted = store.getOwnerInstructionRequest(recorded.requestId)
    expect(accepted?.status).toBe('accepted')
    expect(accepted?.failureCode).toBeNull()
    expect(store.claimOwnerInstructionRequest(recorded.requestId, 5_000)).toBe(false)
    expect(store.listPendingOwnerInstructionRequests(5_000)).toEqual([])
    // A second accept is idempotent and cannot move an accepted row.
    store.acceptOwnerInstructionRequest(recorded.requestId)
    expect(store.getOwnerInstructionRequest(recorded.requestId)?.status).toBe('accepted')
    store.close()
  })

  it('detects tampered stored files against the frozen digest', () => {
    const { store, path } = ledger()
    const recorded = store.recordOwnerInstructionRequest(base)
    store.close()
    const raw = new DatabaseSync(path)
    raw.exec(`UPDATE source_owner_instruction_requests SET files_json=json_set(files_json,'$[0].content','# tampered')`)
    raw.close()
    const reopened = new ControlPlaneStore({ path, now: () => 6_000 })
    expect(() => reopened.getOwnerInstructionRequest(recorded.requestId)).toThrow(/corrupt/u)
    reopened.close()
  })
})

describe('schema 38 migration', () => {
  it('adds the owner instruction request table to a schema 37 ledger', () => {
    const { path } = ledger()
    openControlPlaneDatabase(path).close()
    const legacy = new DatabaseSync(path)
    legacy.exec('DROP TABLE source_owner_instruction_requests; PRAGMA user_version = 37;')
    legacy.close()
    const migrated = openControlPlaneDatabase(path)
    const version = Number((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    expect(version).toBe(controlPlaneSchemaVersion)
    expect(version).toBeGreaterThanOrEqual(38)
    expect(migrated.prepare("SELECT name FROM sqlite_schema WHERE tbl_name='source_owner_instruction_requests' ORDER BY name")
      .all().map(row => (row as { name: string }).name)).toEqual([
        'source_owner_instruction_requests',
        'sqlite_autoindex_source_owner_instruction_requests_2',
      ])
    migrated.close()
  })

  it('fails closed on a missing or unknown request table', () => {
    const { path } = ledger()
    openControlPlaneDatabase(path).close()
    const dropped = new DatabaseSync(path)
    dropped.exec('DROP TABLE source_owner_instruction_requests')
    dropped.close()
    expect(() => openControlPlaneDatabase(path)).toThrow(/missing source owner instruction request schema/u)
    const { path: second } = ledger()
    openControlPlaneDatabase(second).close()
    const changed = new DatabaseSync(second)
    changed.exec(`DROP TABLE source_owner_instruction_requests;
      CREATE TABLE source_owner_instruction_requests (request_id TEXT PRIMARY KEY) STRICT;
      PRAGMA user_version = 37;`)
    changed.close()
    expect(() => openControlPlaneDatabase(second)).toThrow(/unknown source owner instruction request schema/u)
  })
})
