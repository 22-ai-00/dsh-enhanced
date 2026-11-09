import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { controlPlaneSchemaVersion, openControlPlaneDatabase } from '../src/sqlite.ts'
import { controlPlaneDigest, ControlPlaneStore } from '../src/store.ts'

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
  createdAt: 1_000, expiresAt: 2_000, idempotencyKey: 'key-1',
}

describe('owner instruction store (schema 37)', () => {
  it('records and reads one instruction with a frozen owner receipt', () => {
    const { store, path } = ledger()
    expect(Number((new DatabaseSync(path).prepare('PRAGMA user_version').get() as { user_version: number }).user_version))
      .toBe(controlPlaneSchemaVersion)
    const recorded = store.recordOwnerInstruction(base)
    expect(recorded).toEqual({ ...base, ownerDigest: controlPlaneDigest(receipt) })
    expect(store.getOwnerInstruction('instruction-1')).toEqual(recorded)
    expect(store.getOwnerInstruction('absent')).toBeUndefined()
    store.close()
  })

  it('is idempotent for identical input and refuses a reused key with different input', () => {
    const { store } = ledger()
    const first = store.recordOwnerInstruction(base)
    const again = store.recordOwnerInstruction({ ...base, createdAt: 1_500 })
    expect(again).toEqual(first)
    expect(() => store.recordOwnerInstruction({ ...base, filesDigest: 'c'.repeat(64) })).toThrow(/different input/u)
    expect(() => store.recordOwnerInstruction({ ...base, idempotencyKey: 'key-2' })).toThrow(/different input/u)
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
