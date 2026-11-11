import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { controlPlaneSchemaVersion, openControlPlaneDatabase } from '../src/sqlite.ts'
import { controlPlaneDigest, createOwnerInstructionReviewFreeze, ControlPlaneStore } from '../src/store.ts'

const reviewAuthority = {
  protocol: 'assistant-growth/revision-acceptance-authority/v1' as const, authorityId: 'fixture-revision-review',
  keyId: 'fixture-review-key', authorityDigest: '9'.repeat(64), namePrefix: 'demo-', expiresAt: 8_640_000_000_000_000,
}
const review = (provider = 'fixture-supplier', model = 'fixture-review-model',
  window: { verificationMs: number; regressionMs: number; adoptionMs: number } = { verificationMs: 1_800_000, regressionMs: 0, adoptionMs: 0 }) =>
  createOwnerInstructionReviewFreeze({
    supplier: { provider, model },
    budget: { protocol: 'plugin-control-plane/owner-instruction-review-budget/v1', authority: reviewAuthority,
      verifierKeyDigest: 'a'.repeat(64), window },
  })

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function ledger(now = () => 5_000): { path: string; store: ControlPlaneStore } {
  const root = mkdtempSync(join(tmpdir(), 'cp-owner-instruction-'))
  roots.push(root)
  const path = join(root, 'control.sqlite')
  return { path, store: new ControlPlaneStore({ path, now }) }
}

const receipt = {
  receiptVersion: 2 as const, authorityId: 'authority', authorityHash: 'a'.repeat(64), principalId: 'principal',
  principalRecordId: 'record', principalVersion: 3, workspace: '/workspace', agentPreset: 'primary',
  bindingVersion: 2, generation: 4,
}

const base = {
  instructionId: 'instruction-1', ownerReceipt: receipt, ownerRouteId: 'owner-route',
  planId: 'plan-1', pluginName: 'demo-plugin', filesDigest: 'b'.repeat(64),
  createdAt: 1_000, expiresAt: 2_000, idempotencyKey: 'key-1', review: review(),
}

describe('owner instruction store (schema 37)', () => {
  it('records and reads one instruction with a frozen owner receipt', () => {
    const { store, path } = ledger()
    expect(Number((new DatabaseSync(path).prepare('PRAGMA user_version').get() as { user_version: number }).user_version))
      .toBe(controlPlaneSchemaVersion)
    const recorded = store.recordOwnerInstruction(base)
    const { review: _review, ...fields } = base
    expect(recorded).toEqual({ ...fields, ownerDigest: controlPlaneDigest(receipt) })
    expect(store.getOwnerInstruction('instruction-1')).toEqual(recorded)
    expect(store.getOwnerInstructionReviewFreeze('instruction-1')).toEqual(base.review)
    expect(store.getOwnerInstruction('absent')).toBeUndefined()
    expect(store.getOwnerInstructionReviewFreeze('absent')).toBeUndefined()
    store.close()
  })

  it('is idempotent for identical input and refuses a reused key with different input', () => {
    const { store } = ledger()
    const first = store.recordOwnerInstruction(base)
    const again = store.recordOwnerInstruction({ ...base, createdAt: 1_500 })
    expect(again).toEqual(first)
    expect(() => store.recordOwnerInstruction({ ...base, filesDigest: 'c'.repeat(64) })).toThrow(/different input/u)
    expect(() => store.recordOwnerInstruction({ ...base, idempotencyKey: 'key-2' })).toThrow(/different input/u)
    expect(() => store.recordOwnerInstruction({ ...base, review: review('other-supplier') })).toThrow(/different input/u)
    store.close()
  })

  it('rejects malformed identities, digests and timing', () => {
    const { store } = ledger()
    for (const change of [
      { instructionId: '../escape' }, { instructionId: '' }, { planId: 'bad plan id' },
      { filesDigest: 'xyz' }, { idempotencyKey: 'bad key' }, { createdAt: 0 }, { expiresAt: 1_000 },
      { expiresAt: 500 }, { ownerRouteId: '' },
    ]) {
      expect(() => store.recordOwnerInstruction({ ...base, ...change })).toThrow()
    }
    store.close()
  })

  it('detects a tampered stored receipt', () => {
    const { store, path } = ledger()
    store.recordOwnerInstruction(base)
    store.close()
    const raw = new DatabaseSync(path)
    raw.exec(`UPDATE source_owner_instructions
      SET owner_receipt_json=json_set(owner_receipt_json,'$.generation',99)`)
    raw.close()
    const reopened = new ControlPlaneStore({ path, now: () => 6_000 })
    expect(() => reopened.getOwnerInstruction('instruction-1')).toThrow(/corrupt/u)
    reopened.close()
  })
})

describe('schema 37 migration', () => {
  it('adds the owner instruction table to a schema 36 ledger', () => {
    const { path } = ledger()
    openControlPlaneDatabase(path).close()
    const legacy = new DatabaseSync(path)
    legacy.exec('DROP TABLE source_owner_instructions; PRAGMA user_version = 36;')
    legacy.close()
    const migrated = openControlPlaneDatabase(path)
    const version = Number((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    expect(version).toBe(controlPlaneSchemaVersion)
    expect(version).toBeGreaterThanOrEqual(37)
    expect(migrated.prepare("SELECT name FROM sqlite_schema WHERE tbl_name='source_owner_instructions' ORDER BY name")
      .all().map(row => (row as { name: string }).name)).toEqual(['source_owner_instructions',
      'sqlite_autoindex_source_owner_instructions_2'])
    migrated.close()
  })

  it('fails closed on a missing or unknown instruction table', () => {
    const { path } = ledger()
    openControlPlaneDatabase(path).close()
    const dropped = new DatabaseSync(path)
    dropped.exec('DROP TABLE source_owner_instructions')
    dropped.close()
    expect(() => openControlPlaneDatabase(path)).toThrow(/missing source owner instruction schema/u)
    const { path: second } = ledger()
    openControlPlaneDatabase(second).close()
    const changed = new DatabaseSync(second)
    changed.exec(`DROP TABLE source_owner_instructions;
      CREATE TABLE source_owner_instructions (instruction_id TEXT PRIMARY KEY) STRICT;
      PRAGMA user_version = 36;`)
    changed.close()
    expect(() => openControlPlaneDatabase(second)).toThrow(/unknown source owner instruction schema/u)
  })
})

describe('schema 41 owner instruction review freeze', () => {
  it('keeps a frozen supplier and budget for a new instruction', () => {
    const { store, path } = ledger()
    store.recordOwnerInstruction(base)
    const freeze = store.getOwnerInstructionReviewFreeze('instruction-1')!
    expect(freeze).toEqual(base.review)
    expect(freeze.digest).toMatch(/^[a-f0-9]{64}$/u)
    store.close()
    const raw = new DatabaseSync(path)
    const row = raw.prepare(`SELECT review_supplier_json, review_budget_json, review_freeze_digest
      FROM source_owner_instructions WHERE instruction_id='instruction-1'`).get() as
      { review_supplier_json: string; review_budget_json: string; review_freeze_digest: string }
    expect(JSON.parse(row.review_supplier_json)).toEqual(base.review.supplier)
    expect(JSON.parse(row.review_budget_json)).toEqual(base.review.budget)
    expect(row.review_freeze_digest).toBe(base.review.digest)
    raw.close()
  })

  it('returns no freeze for a legacy row, which every execution path fails closed', () => {
    const { store, path } = ledger()
    store.recordOwnerInstruction(base)
    store.close()
    const raw = new DatabaseSync(path)
    raw.exec(`UPDATE source_owner_instructions SET review_supplier_json=NULL,
      review_budget_json=NULL, review_freeze_digest=NULL`)
    raw.close()
    const reopened = new ControlPlaneStore({ path, now: () => 6_000 })
    expect(reopened.getOwnerInstruction('instruction-1')).toBeDefined()
    expect(reopened.getOwnerInstructionReviewFreeze('instruction-1')).toBeUndefined()
    reopened.close()
  })

  it('fails closed on a partially written or tampered freeze', () => {
    const { store, path } = ledger()
    store.recordOwnerInstruction(base)
    store.close()
    const partial = new DatabaseSync(path)
    partial.exec("UPDATE source_owner_instructions SET review_budget_json=NULL")
    partial.close()
    expect(() => new ControlPlaneStore({ path, now: () => 6_000 }).getOwnerInstructionReviewFreeze('instruction-1'))
      .toThrow(/corrupt/u)
    const tampered = new DatabaseSync(path)
    tampered.exec("UPDATE source_owner_instructions SET review_budget_json=json_set(review_budget_json,'$.verifierKeyDigest','b'||substr(" +
      "json_extract(review_budget_json,'$.verifierKeyDigest'),2))")
    tampered.close()
    expect(() => new ControlPlaneStore({ path, now: () => 6_000 }).getOwnerInstructionReviewFreeze('instruction-1'))
      .toThrow(/corrupt/u)
  })

  it('migrates a schema 40 instruction row without inventing a freeze', () => {
    const { store, path } = ledger()
    store.recordOwnerInstruction(base)
    store.close()
    const raw = new DatabaseSync(path)
    const current = raw.prepare("SELECT sql FROM sqlite_schema WHERE name='source_owner_instructions'")
      .get() as { sql: string }
    const v40 = current.sql.replace(/\n, review_supplier_json[\s\S]*?\) STRICT, WITHOUT ROWID$/u, '\n) STRICT, WITHOUT ROWID')
    expect(v40).not.toBe(current.sql)
    raw.exec(`BEGIN IMMEDIATE;
      ALTER TABLE source_owner_instructions RENAME TO source_owner_instructions_v41;
      ${v40};
      INSERT INTO source_owner_instructions
        (instruction_id, owner_receipt_json, owner_digest, owner_route_id, plan_id, plugin_name,
          files_digest, created_at, expires_at, idempotency_key)
        SELECT instruction_id, owner_receipt_json, owner_digest, owner_route_id, plan_id, plugin_name,
          files_digest, created_at, expires_at, idempotency_key FROM source_owner_instructions_v41;
      DROP TABLE source_owner_instructions_v41;
      PRAGMA user_version = 40;
      COMMIT;`)
    raw.close()
    const migrated = openControlPlaneDatabase(path)
    expect(Number((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version))
      .toBe(controlPlaneSchemaVersion)
    expect((migrated.prepare("PRAGMA table_info('source_owner_instructions')").all() as { name: string }[])
      .map(column => column.name)).toEqual(expect.arrayContaining(
        ['review_supplier_json', 'review_budget_json', 'review_freeze_digest']))
    migrated.close()
    const reopened = new ControlPlaneStore({ path, now: () => 6_000 })
    expect(reopened.getOwnerInstruction('instruction-1')).toMatchObject({ instructionId: 'instruction-1' })
    expect(reopened.getOwnerInstructionReviewFreeze('instruction-1')).toBeUndefined()
    reopened.close()
  })

  it('fails closed when a current schema 41 table carries an extra column', () => {
    const { path } = ledger()
    openControlPlaneDatabase(path).close()
    const raw = new DatabaseSync(path)
    raw.exec('ALTER TABLE source_owner_instructions ADD COLUMN extra_review_note TEXT')
    expect(Number((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version))
      .toBe(controlPlaneSchemaVersion)
    raw.close()
    expect(() => openControlPlaneDatabase(path)).toThrow(/unknown source owner instruction schema/u)
  })
})
