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

const receipt = { instructionId: 'instruction-1', jobId: 'source-job-' + 'a'.repeat(64) }

const base = {
  planId: 'plan-1', pluginName: 'demo-plugin', expectedBaseCommit: commit,
  files, ttlMs: 900_000, idempotencyKey: 'key-1', createdAt: 1_000,
}

describe('owner instruction request store', () => {
  it('records and reads one pending request with frozen files and digest', () => {
    const { store, path } = ledger()
    expect(Number((new DatabaseSync(path).prepare('PRAGMA user_version').get() as { user_version: number }).user_version))
      .toBe(controlPlaneSchemaVersion)
    const recorded = store.recordOwnerInstructionRequest(base)
    expect(recorded.status).toBe('pending')
    expect(recorded.failureCode).toBeNull()
    expect(recorded.claimedAt).toBeNull()
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
    expect(store.claimOwnerInstructionRequest(first.requestId, 5_000)).toBe(1)
    expect(store.listPendingOwnerInstructionRequests(5_000).map(item => item.requestId)).toEqual([
      second.requestId, third.requestId,
    ])
    // After second's expiry it drops out while the claimed first stays claimed.
    expect(store.listPendingOwnerInstructionRequests(902_500).map(item => item.requestId)).toEqual([third.requestId])
    // A claim after expiry is refused.
    expect(store.claimOwnerInstructionRequest(third.requestId, 903_500)).toBeUndefined()
    store.close()
  })

  it('claims with a CAS so a second tick cannot drain the same request', () => {
    const { store } = ledger()
    const recorded = store.recordOwnerInstructionRequest(base)
    expect(store.claimOwnerInstructionRequest(recorded.requestId, 5_000)).toBe(1)
    expect(store.claimOwnerInstructionRequest(recorded.requestId, 5_000)).toBeUndefined()
    expect(store.getOwnerInstructionRequest(recorded.requestId)).toMatchObject({ status: 'claimed', claimedAt: 5_000 })
    store.close()
  })

  it('requeues an orphaned claim after the timeout but leaves a fresh claim pinned', () => {
    const { store } = ledger()
    const orphan = store.recordOwnerInstructionRequest(base)
    const fresh = store.recordOwnerInstructionRequest({ ...base, planId: 'plan-2', idempotencyKey: 'key-2', createdAt: 2_000 })
    expect(store.claimOwnerInstructionRequest(orphan.requestId, 5_000)).toBe(1)
    expect(store.claimOwnerInstructionRequest(fresh.requestId, 290_000)).toBe(1)
    // At t=305000 the first claim is 300000ms old (stale), the second only 15000ms.
    expect(store.reclaimOrphanedOwnerInstructionRequests(305_000, 300_000)).toBe(1)
    const requeued = store.getOwnerInstructionRequest(orphan.requestId)
    expect(requeued).toMatchObject({ status: 'pending', claimedAt: null })
    expect(store.getOwnerInstructionRequest(fresh.requestId)).toMatchObject({ status: 'claimed', claimedAt: 290_000 })
    // The requeued row is listable and claimable again.
    expect(store.listPendingOwnerInstructionRequests(305_000).map(item => item.requestId)).toEqual([orphan.requestId])
    expect(store.claimOwnerInstructionRequest(orphan.requestId, 305_000)).toBe(2)
    expect(store.acceptOwnerInstructionRequest(orphan.requestId, 1, receipt)).toBe(false)
    expect(store.rejectOwnerInstructionRequest(orphan.requestId, 1, 'stale-claim')).toBe(false)
    expect(store.releaseOwnerInstructionRequestClaim(orphan.requestId, 1)).toBe(false)
    expect(store.getOwnerInstructionRequest(orphan.requestId)).toMatchObject({ status: 'claimed', claimGeneration: 2 })
    // A second reclamation with no stale claims changes nothing.
    expect(store.reclaimOrphanedOwnerInstructionRequests(305_001, 300_000)).toBe(0)
    expect(() => store.reclaimOrphanedOwnerInstructionRequests(305_000, 0)).toThrow()
    store.close()
  })

  it('releases a live claim back to pending but never reopens an accepted or rejected row', () => {
    const { store } = ledger()
    const claimed = store.recordOwnerInstructionRequest(base)
    expect(store.claimOwnerInstructionRequest(claimed.requestId, 5_000)).toBe(1)
    store.releaseOwnerInstructionRequestClaim(claimed.requestId, 1)
    expect(store.getOwnerInstructionRequest(claimed.requestId)).toMatchObject({ status: 'pending', claimedAt: null })
    expect(store.listPendingOwnerInstructionRequests(5_000).map(item => item.requestId)).toEqual([claimed.requestId])
    // A settled row is unaffected by a release.
    const accepted = store.recordOwnerInstructionRequest({ ...base, planId: 'plan-2', idempotencyKey: 'key-accepted' })
    expect(store.claimOwnerInstructionRequest(accepted.requestId, 5_000)).toBe(1)
    store.acceptOwnerInstructionRequest(accepted.requestId, 1, receipt)
    store.releaseOwnerInstructionRequestClaim(accepted.requestId, 1)
    expect(store.getOwnerInstructionRequest(accepted.requestId)?.status).toBe('accepted')
    const rejected = store.recordOwnerInstructionRequest({ ...base, planId: 'plan-3', idempotencyKey: 'key-rejected' })
    expect(store.claimOwnerInstructionRequest(rejected.requestId, 5_000)).toBe(1)
    store.rejectOwnerInstructionRequest(rejected.requestId, 1, 'parent-mismatch')
    store.releaseOwnerInstructionRequestClaim(rejected.requestId, 1)
    expect(store.getOwnerInstructionRequest(rejected.requestId)?.status).toBe('rejected')
    // Releasing an unclaimed pending row is a no-op that stays pending.
    const untouched = store.recordOwnerInstructionRequest({ ...base, planId: 'plan-4', idempotencyKey: 'key-untouched' })
    store.releaseOwnerInstructionRequestClaim(untouched.requestId, 1)
    expect(store.getOwnerInstructionRequest(untouched.requestId)?.status).toBe('pending')
    store.close()
  })

  it('rejects a claimed request with a bounded failure code and never reopens it', () => {
    const { store } = ledger()
    const recorded = store.recordOwnerInstructionRequest(base)
    expect(store.rejectOwnerInstructionRequest(recorded.requestId, 1, 'owner-route-unavailable')).toBe(false)
    expect(store.claimOwnerInstructionRequest(recorded.requestId, 5_000)).toBe(1)
    expect(store.rejectOwnerInstructionRequest(recorded.requestId, 1, 'owner-route-unavailable')).toBe(true)
    const rejected = store.getOwnerInstructionRequest(recorded.requestId)
    expect(rejected?.status).toBe('rejected')
    expect(rejected?.failureCode).toBe('owner-route-unavailable')
    expect(store.claimOwnerInstructionRequest(recorded.requestId, 5_000)).toBeUndefined()
    expect(store.listPendingOwnerInstructionRequests(5_000)).toEqual([])
    expect(() => store.rejectOwnerInstructionRequest(recorded.requestId, 1, '')).toThrow()
    expect(() => store.rejectOwnerInstructionRequest(recorded.requestId, 1, 'x'.repeat(121))).toThrow()
    store.close()
  })

  it('accepts only a live claim and never re-lists an accepted request', () => {
    const { store } = ledger()
    const recorded = store.recordOwnerInstructionRequest(base)
    // Accepting before a claim does nothing.
    store.acceptOwnerInstructionRequest(recorded.requestId, 1, receipt)
    expect(store.getOwnerInstructionRequest(recorded.requestId)?.status).toBe('pending')
    expect(store.claimOwnerInstructionRequest(recorded.requestId, 5_000)).toBe(1)
    store.acceptOwnerInstructionRequest(recorded.requestId, 1, receipt)
    const accepted = store.getOwnerInstructionRequest(recorded.requestId)
    expect(accepted).toMatchObject({ status: 'accepted', ...receipt })
    expect(accepted?.failureCode).toBeNull()
    expect(store.claimOwnerInstructionRequest(recorded.requestId, 5_000)).toBeUndefined()
    expect(store.listPendingOwnerInstructionRequests(5_000)).toEqual([])
    // A second accept is idempotent and cannot move an accepted row.
    store.acceptOwnerInstructionRequest(recorded.requestId, 1, receipt)
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

describe('owner instruction request migrations', () => {
  const v38TableDdl = `CREATE TABLE source_owner_instruction_requests (
  request_id TEXT PRIMARY KEY CHECK(length(request_id) > 0 AND length(request_id) <= 160),
  plan_id TEXT NOT NULL CHECK(length(plan_id) > 0 AND length(plan_id) <= 160),
  plugin_name TEXT NOT NULL CHECK(length(plugin_name) > 0 AND length(plugin_name) <= 160),
  expected_base_commit TEXT NOT NULL CHECK(length(expected_base_commit) = 40 AND expected_base_commit NOT GLOB '*[^a-f0-9]*'),
  files_json TEXT NOT NULL CHECK(json_valid(files_json) AND json_type(files_json) = 'array' AND length(files_json) <= 1048576),
  files_digest TEXT NOT NULL CHECK(length(files_digest) = 64 AND files_digest NOT GLOB '*[^a-f0-9]*'),
  ttl_ms INTEGER NOT NULL CHECK(ttl_ms >= 900000 AND ttl_ms <= 86400000),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) > 0 AND length(idempotency_key) <= 160),
  created_at INTEGER NOT NULL CHECK(created_at > 0),
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
  status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'accepted', 'rejected')),
  failure_code TEXT CHECK(failure_code IS NULL OR (length(failure_code) > 0 AND length(failure_code) <= 120))
) STRICT, WITHOUT ROWID`

  it('adds the owner instruction request table to a schema 37 ledger and migrates it to the current schema', () => {
    const { path } = ledger()
    openControlPlaneDatabase(path).close()
    const legacy = new DatabaseSync(path)
    legacy.exec('DROP TABLE source_owner_instruction_requests; PRAGMA user_version = 37;')
    legacy.close()
    const migrated = openControlPlaneDatabase(path)
    const version = Number((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    expect(version).toBe(controlPlaneSchemaVersion)
    expect(version).toBeGreaterThanOrEqual(39)
    expect((migrated.prepare("PRAGMA table_info('source_owner_instruction_requests')").all() as { name: string }[])
      .map(column => column.name)).toContain('claimed_at')
    migrated.close()
  })

  it('adds claimed_at to a populated schema 38 ledger without losing rows', () => {
    const { path, store } = ledger()
    const recorded = store.recordOwnerInstructionRequest(base)
    store.close()
    const legacy = new DatabaseSync(path)
    legacy.exec(`DROP TABLE source_owner_instruction_requests; ${v38TableDdl}; PRAGMA user_version = 38;`)
    legacy.prepare(`INSERT INTO source_owner_instruction_requests
      (request_id, plan_id, plugin_name, expected_base_commit, files_json, files_digest, ttl_ms,
        idempotency_key, created_at, expires_at, status, failure_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL)`)
      .run(recorded.requestId, recorded.planId, recorded.pluginName, recorded.expectedBaseCommit,
        JSON.stringify(recorded.files), recorded.filesDigest, recorded.ttlMs,
        recorded.idempotencyKey, recorded.createdAt, recorded.expiresAt)
    legacy.close()
    const migrated = openControlPlaneDatabase(path)
    expect(Number((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(controlPlaneSchemaVersion)
    migrated.close()
    const reopened = new ControlPlaneStore({ path, now: () => 6_000 })
    expect(reopened.getOwnerInstructionRequest(recorded.requestId)).toMatchObject({ requestId: recorded.requestId,
      status: 'pending', claimedAt: null })
    expect(reopened.claimOwnerInstructionRequest(recorded.requestId, 7_000)).toBe(1)
    expect(reopened.getOwnerInstructionRequest(recorded.requestId)?.claimedAt).toBe(7_000)
    reopened.close()
  })

  it('migrates a schema 39 accepted row without inventing its admission receipt', () => {
    const { path, store } = ledger()
    const row = store.recordOwnerInstructionRequest(base)
    store.close()
    const legacy = new DatabaseSync(path)
    legacy.exec(`DROP TABLE source_owner_instruction_requests; ${v38TableDdl};
      ALTER TABLE source_owner_instruction_requests ADD COLUMN claimed_at INTEGER CHECK(claimed_at IS NULL OR claimed_at > 0);
      PRAGMA user_version = 39;`)
    legacy.prepare(`INSERT INTO source_owner_instruction_requests
      (request_id, plan_id, plugin_name, expected_base_commit, files_json, files_digest, ttl_ms,
        idempotency_key, created_at, expires_at, status, failure_code, claimed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', NULL, ?)`)
      .run(row.requestId, row.planId, row.pluginName, row.expectedBaseCommit, JSON.stringify(row.files),
        row.filesDigest, row.ttlMs, row.idempotencyKey, row.createdAt, row.expiresAt, 5_000)
    legacy.close()
    const reopened = new ControlPlaneStore({ path })
    try {
      expect(reopened.getOwnerInstructionRequest(row.requestId)).toMatchObject({
        status: 'accepted', claimGeneration: 0, instructionId: null, jobId: null,
      })
    } finally { reopened.close() }
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
