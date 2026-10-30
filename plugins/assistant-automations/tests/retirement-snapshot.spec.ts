import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmodSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import {
  AutomationOperatorSnapshotError,
  inspectAutomationRetirementSnapshot,
  inspectAutomationsOperatorSnapshot,
} from '../src/operator.ts'
import { AutomationStore } from '../src/store.ts'

const roots: string[] = []
const now = Date.parse('2026-10-30T00:00:00.000Z')
const triggers = ['automation_retirements_no_update', 'automation_retirements_no_delete',
  'automation_retired_no_activate_insert', 'automation_retired_no_activate_update']

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function definition(name: string) {
  return {
    name, prompt: `privileged definition ${name}`,
    schedule: { kind: 'every', anchorAt: '2026-10-30T00:00:00.000Z', intervalMs: 60_000 },
    workspace: '/work/retirement', agentPreset: 'primary', provider: 'mock', model: 'mock-model',
    allowedTools: ['wiki_search'], timeoutMs: 60_000, maxOutputTokens: 2_048, maxToolCalls: 4,
    misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0, principal: 'owner:test',
  }
}

async function fixture(version: 15 | 16 = 16, retired = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'automations-retirement-proof-')))
  roots.push(root)
  const path = join(root, 'state', 'automations.sqlite')
  const store = new AutomationStore({ path, now: () => now })
  for (const automationId of ['scanner-a', 'scanner-b']) {
    store.reconcileSystemOwned({ owner: 'old-owner', automationId,
      idempotencyKey: `create-${automationId}`, definition: definition(automationId) })
    if (retired) {
      const record = store.get(automationId)!
      store.retireSystemOwned({ owner: 'old-owner', automationId, operationId: `retire-${automationId}`,
        definitionHash: createHash('sha256').update(JSON.stringify(record.definition)).digest('hex'),
        expectedVersion: record.version, reason: 'owner-revoked', evidenceDigest: 'a'.repeat(64) })
    }
  }
  store.close()
  mutate(path, database => {
    database.exec('PRAGMA journal_mode=DELETE')
    if (version === 15) {
      for (const name of triggers) database.exec(`DROP TRIGGER ${name}`)
      database.exec('DROP TABLE automation_system_retirements; PRAGMA user_version=15')
    }
    database.prepare(`INSERT INTO automation_occurrences(id,automation_id,trigger_kind,trigger_key,scheduled_at,
      status,dry_run,created_at,updated_at) VALUES ('occurrence','scanner-a','manual','manual',?,'unknown',0,?,?)`).run(now, now, now)
    database.prepare(`INSERT INTO automation_tasks(id,occurrence_id,automation_id,status,cancel_requested,attempt_count,created_at,updated_at)
      VALUES ('task','occurrence','scanner-a','unknown',0,0,?,?)`).run(now, now)
  })
  return { root, path }
}

function mutate(path: string, action: (database: DatabaseSync) => void) {
  const database = new DatabaseSync(path)
  try { action(database) } finally { database.close() }
}

function fingerprint(path: string) {
  return ['', '-wal', '-shm'].map(suffix => {
    try {
      const value = lstatSync(path + suffix, { bigint: true })
      return { device: value.dev, inode: value.ino, size: value.size, mode: value.mode,
        mtime: value.mtimeNs, ctime: value.ctimeNs,
        digest: createHash('sha256').update(readFileSync(path + suffix)).digest('hex') }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  })
}

function expectCode(action: () => unknown, code: AutomationOperatorSnapshotError['code']) {
  expect(action).toThrowError(expect.objectContaining({ code }))
}

function history(path: string, name: string) {
  return inspectAutomationRetirementSnapshot(path).historyTables.find(table => table.name === name)!
}

describe('privileged Automations retirement snapshot', () => {
  test.each([15, 16] as const)('reads real schema v%i without changing bytes, inode, mode or sidecars', async version => {
    const f = await fixture(version)
    const before = fingerprint(f.path)
    const proof = inspectAutomationRetirementSnapshot(f.path)
    expect(proof.protocol).toBe('assistant-automations/retirement-snapshot/v1')
    expect(proof.schemaVersion).toBe(version)
    expect(proof.records).toHaveLength(2)
    expect(proof.records[0]?.definition).toEqual(definition('scanner-a'))
    expect(proof.records[0]?.immutableDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(proof.records[0]?.createIdempotencyKeyDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(proof.retirements).toEqual([])
    expect(proof.historyTables).toHaveLength(15)
    expect(proof.schemaEntries.filter(entry => entry.type === 'trigger')).toHaveLength(version === 15 ? 0 : 4)
    expect(proof.schemaEntries.some(entry => entry.name === 'automation_system_retirements')).toBe(version === 16)
    expect(proof.inFlightCount).toBe(0)
    expect(Object.isFrozen(proof)).toBe(true)
    expect(Object.isFrozen(proof.records[0]?.definition)).toBe(true)
    expect(Object.isFrozen(proof.schemaEntries[0])).toBe(true)
    expect(inspectAutomationRetirementSnapshot(f.path)).toEqual(proof)
    expect(fingerprint(f.path)).toEqual(before)
    if (version === 15) expectCode(() => inspectAutomationsOperatorSnapshot(f.path), 'schema-unsupported')
    else {
      const ordinary = inspectAutomationsOperatorSnapshot(f.path)
      expect(ordinary.records[0]).not.toHaveProperty('definition')
      expect(ordinary).not.toHaveProperty('retirements')
    }
  })

  test('returns every exact bound retirement receipt and preserves immutable definition digests', async () => {
    const f = await fixture(16, true)
    const before = fingerprint(f.path)
    const proof = inspectAutomationRetirementSnapshot(f.path)
    expect(proof.retirements).toHaveLength(2)
    expect(proof.retirements[0]).toEqual({ owner: 'old-owner', automationId: 'scanner-a', operationId: 'retire-scanner-a',
      definitionHash: proof.records[0]!.definitionHash, expectedVersion: 1, definitionVersion: 2,
      automationStatus: 'paused', reason: 'owner-revoked', evidenceDigest: 'a'.repeat(64), retiredAt: now })
    expect(Object.isFrozen(proof.retirements[0])).toBe(true)
    expect(fingerprint(f.path)).toEqual(before)
    const active = await fixture()
    expect(proof.records.map(record => record.immutableDigest))
      .toEqual(inspectAutomationRetirementSnapshot(active.path).records.map(record => record.immutableDigest))
  })

  test('permanent markers remain valid after the formal soft-delete API', async () => {
    const f = await fixture(16, true)
    const retired = inspectAutomationRetirementSnapshot(f.path)
    const store = new AutomationStore({ path: f.path, now: () => now + 60_000 })
    try {
      expect(store.changeApproved({ automationId: 'scanner-b', operation: 'delete', expectedVersion: 2,
        idempotencyKey: 'delete-retired-scanner-b' })).toMatchObject({ status: 'deleted', version: 3, updatedAt: now + 60_000 })
      expect(() => store.changeApproved({ automationId: 'scanner-b', operation: 'resume', expectedVersion: 3,
        idempotencyKey: 'resume-deleted' })).toThrow(/permanently retired/u)
    } finally { store.close() }
    const before = fingerprint(f.path)
    const proof = inspectAutomationRetirementSnapshot(f.path)
    expect(proof.records[1]).toMatchObject({ id: 'scanner-b', status: 'deleted', version: 3, updatedAt: now + 60_000 })
    expect(proof.records[1]?.immutableDigest).toBe(retired.records[1]?.immutableDigest)
    expect(proof.retirements).toEqual(retired.retirements)
    expect(fingerprint(f.path)).toEqual(before)
  })

  test('permanent markers remain valid after their definition is physically absent', async () => {
    const f = await fixture(16, true)
    const retired = inspectAutomationRetirementSnapshot(f.path)
    mutate(f.path, database => {
      // Remove dependent history first, leaving no FK orphans. The permanent
      // marker deliberately has no definition FK and must survive independently.
      database.prepare("DELETE FROM automation_system_reconciles WHERE automation_id='scanner-b'").run()
      database.prepare("DELETE FROM automation_definitions WHERE id='scanner-b'").run()
    })
    const before = fingerprint(f.path)
    const proof = inspectAutomationRetirementSnapshot(f.path)
    expect(proof.records.map(record => record.id)).toEqual(['scanner-a'])
    expect(proof.retirements).toEqual(retired.retirements)
    expect(fingerprint(f.path)).toEqual(before)
  })

  test('rejects a deleted state manufactured without the formal delete receipt', async () => {
    const f = await fixture(16, true)
    mutate(f.path, database => database.exec("UPDATE automation_definitions SET status='deleted',version=3 WHERE id='scanner-b'"))
    expectCode(() => inspectAutomationRetirementSnapshot(f.path), 'database-corrupt')
  })

  test.each([
    "UPDATE automation_definitions SET version=4 WHERE id='scanner-b'",
    "UPDATE automation_definitions SET updated_at=updated_at+1 WHERE id='scanner-b'",
    "UPDATE automation_definitions SET system_owner='other-owner' WHERE id='scanner-b'",
    "DELETE FROM automation_changes WHERE automation_id='scanner-b'",
    "UPDATE automation_changes SET expected_version=3 WHERE automation_id='scanner-b'",
    "UPDATE automation_changes SET result_json='{}' WHERE automation_id='scanner-b'",
    "UPDATE automation_changes SET input_hash='invalid-hash' WHERE automation_id='scanner-b'",
    "UPDATE automation_changes SET operation='pause' WHERE automation_id='scanner-b'",
  ])('rejects a tampered formal delete state or receipt: %s', async sql => {
    const f = await fixture(16, true)
    const store = new AutomationStore({ path: f.path, now: () => now + 60_000 })
    try {
      store.changeApproved({ automationId: 'scanner-b', operation: 'delete', expectedVersion: 2,
        idempotencyKey: 'delete-retired-scanner-b' })
    } finally { store.close() }
    mutate(f.path, database => database.exec(sql))
    expectCode(() => inspectAutomationRetirementSnapshot(f.path), 'database-corrupt')
  })

  test('rejects a reactivated definition even when the retirement trigger has been restored', async () => {
    const f = await fixture(16, true)
    mutate(f.path, database => {
      const trigger = database.prepare("SELECT sql FROM sqlite_schema WHERE name='automation_retired_no_activate_update'").get()!
      database.exec('DROP TRIGGER automation_retired_no_activate_update')
      database.prepare("UPDATE automation_definitions SET status='active' WHERE id='scanner-b'").run()
      database.exec(String(trigger.sql))
    })
    expectCode(() => inspectAutomationRetirementSnapshot(f.path), 'database-corrupt')
  })

  test('still validates every permanent marker field when its definition is absent', async () => {
    const f = await fixture(16, true)
    mutate(f.path, database => {
      database.prepare("DELETE FROM automation_system_reconciles WHERE automation_id='scanner-b'").run()
      database.prepare("DELETE FROM automation_definitions WHERE id='scanner-b'").run()
      database.exec('DROP TRIGGER automation_retirements_no_update')
      database.prepare("UPDATE automation_system_retirements SET operation_id=' invalid' WHERE automation_id='scanner-b'").run()
      database.exec(`CREATE TRIGGER automation_retirements_no_update BEFORE UPDATE ON automation_system_retirements
        BEGIN SELECT RAISE(ABORT, 'system retirement is immutable'); END`)
    })
    expectCode(() => inspectAutomationRetirementSnapshot(f.path), 'database-corrupt')
  })

  test('hashes same-count unknown task and reconcile changes without exposing stored history bodies', async () => {
    const f = await fixture()
    const before = inspectAutomationRetirementSnapshot(f.path)
    mutate(f.path, database => database.prepare("UPDATE automation_tasks SET claimed_by='SECRET_TASK_BODY'").run())
    const afterTask = inspectAutomationRetirementSnapshot(f.path)
    expect(afterTask.historyTables.find(table => table.name === 'automation_tasks')?.rowCount).toBe(1)
    expect(afterTask.historyTables.find(table => table.name === 'automation_tasks')?.digest)
      .not.toBe(before.historyTables.find(table => table.name === 'automation_tasks')?.digest)
    expect(afterTask.snapshotDigest).not.toBe(before.snapshotDigest)
    expect(JSON.stringify(afterTask)).not.toContain('SECRET_TASK_BODY')
    const prior = history(f.path, 'automation_system_reconciles')
    mutate(f.path, database => database.prepare("UPDATE automation_system_reconciles SET result_json='SECRET_RECONCILE_BODY'").run())
    expect(history(f.path, 'automation_system_reconciles')).toMatchObject({ rowCount: prior.rowCount })
    expect(history(f.path, 'automation_system_reconciles').digest).not.toBe(prior.digest)
    expect(JSON.stringify(inspectAutomationRetirementSnapshot(f.path))).not.toContain('SECRET_RECONCILE_BODY')
  })

  test('canonical history is independent of physical row ordering and supports WITHOUT ROWID', async () => {
    const f = await fixture()
    const before = history(f.path, 'automation_system_reconciles')
    mutate(f.path, database => {
      database.exec(`ALTER TABLE automation_system_reconciles RENAME TO old_reconciles;
        CREATE TABLE automation_system_reconciles (
          idempotency_key TEXT PRIMARY KEY, system_owner TEXT NOT NULL, automation_id TEXT NOT NULL,
          input_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL,
          FOREIGN KEY(automation_id) REFERENCES automation_definitions(id)
        ) STRICT, WITHOUT ROWID;
        INSERT INTO automation_system_reconciles SELECT * FROM old_reconciles ORDER BY idempotency_key DESC;
        DROP TABLE old_reconciles`)
    })
    expect(history(f.path, 'automation_system_reconciles')).toEqual(before)
  })

  test('preserves large integers, exact malformed UTF-8 text bytes, NUL and null versus text', async () => {
    const f = await fixture()
    mutate(f.path, database => {
      database.prepare(`INSERT INTO automation_changes VALUES ('large','scanner-a','test',?,'hash',?,?)`)
        .run(9_223_372_036_854_775_806n, 'body\0tail', now)
    })
    const original = history(f.path, 'automation_changes')
    mutate(f.path, database => database.prepare('UPDATE automation_changes SET expected_version=?').run(9_223_372_036_854_775_807n))
    expect(history(f.path, 'automation_changes').digest).not.toBe(original.digest)
    mutate(f.path, database => database.exec("UPDATE automation_changes SET result_json=CAST(x'80' AS TEXT)"))
    const firstInvalid = history(f.path, 'automation_changes')
    mutate(f.path, database => database.exec("UPDATE automation_changes SET result_json=CAST(x'81' AS TEXT)"))
    expect(history(f.path, 'automation_changes').digest).not.toBe(firstInvalid.digest)
    const nullValue = history(f.path, 'automation_tasks')
    mutate(f.path, database => database.prepare("UPDATE automation_tasks SET claimed_by='null'").run())
    expect(history(f.path, 'automation_tasks').digest).not.toBe(nullValue.digest)
  })

  test('creation-key changes alter immutable proof while malformed definition text fails closed', async () => {
    const f = await fixture()
    const before = inspectAutomationRetirementSnapshot(f.path)
    mutate(f.path, database => database.prepare("UPDATE automation_definitions SET create_idempotency_key='new-key' WHERE id='scanner-a'").run())
    const after = inspectAutomationRetirementSnapshot(f.path)
    expect(after.records[0]?.immutableDigest).not.toBe(before.records[0]?.immutableDigest)
    expect(after.records[0]?.createIdempotencyKeyDigest).not.toBe(before.records[0]?.createIdempotencyKeyDigest)
    mutate(f.path, database => database.exec("UPDATE automation_definitions SET create_idempotency_key=CAST(x'80' AS TEXT) WHERE id='scanner-a'"))
    expectCode(() => inspectAutomationRetirementSnapshot(f.path), 'database-corrupt')
  })

  test('validates positive in-flight counts and rejects orphan tasks', async () => {
    const f = await fixture()
    mutate(f.path, database => database.prepare("UPDATE automation_tasks SET status='running'").run())
    const proof = inspectAutomationRetirementSnapshot(f.path)
    expect(proof.inFlightCount).toBe(1)
    expect(proof.records[0]?.runningTaskCount).toBe(1)
    mutate(f.path, database => {
      database.exec('PRAGMA foreign_keys=OFF')
      database.prepare("UPDATE automation_tasks SET automation_id='missing'").run()
    })
    expectCode(() => inspectAutomationRetirementSnapshot(f.path), 'database-corrupt')
  })

  test.each([
    "operation_id=' bad-operation'", "evidence_digest='zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'",
    "system_owner='different-owner'", "expected_version=2,definition_version=3", "retired_at=retired_at+1",
  ])('rejects corrupt or unbound marker %s', async mutation => {
    const f = await fixture(16, true)
    mutate(f.path, database => {
      database.exec('DROP TRIGGER automation_retirements_no_update')
      database.exec(`UPDATE automation_system_retirements SET ${mutation} WHERE automation_id='scanner-a'`)
      database.exec(`CREATE TRIGGER automation_retirements_no_update BEFORE UPDATE ON automation_system_retirements
        BEGIN SELECT RAISE(ABORT, 'system retirement is immutable'); END`)
    })
    expectCode(() => inspectAutomationRetirementSnapshot(f.path), 'database-corrupt')
  })

  test('binds valid evidence/operation changes and exposes additional otherwise valid markers', async () => {
    const f = await fixture(16, true)
    const before = inspectAutomationRetirementSnapshot(f.path)
    mutate(f.path, database => {
      database.exec('DROP TRIGGER automation_retirements_no_update')
      database.prepare("UPDATE automation_system_retirements SET evidence_digest=?,operation_id='new-operation' WHERE automation_id='scanner-a'").run('b'.repeat(64))
      database.exec(`CREATE TRIGGER automation_retirements_no_update BEFORE UPDATE ON automation_system_retirements
        BEGIN SELECT RAISE(ABORT, 'system retirement is immutable'); END`)
    })
    const after = inspectAutomationRetirementSnapshot(f.path)
    expect(after.retirements[0]?.operationId).toBe('new-operation')
    expect(after.retirements[0]?.evidenceDigest).toBe('b'.repeat(64))
    expect(after.snapshotDigest).not.toBe(before.snapshotDigest)
    // Inventory includes scanner-b's marker; callers must compare the complete set.
    expect(after.retirements.map(receipt => receipt.automationId)).toEqual(['scanner-a', 'scanner-b'])
  })

  test.each(triggers)('rejects a missing or tampered retirement protection: %s', async name => {
    const f = await fixture()
    mutate(f.path, database => database.exec(`DROP TRIGGER ${name}`))
    expectCode(() => inspectAutomationRetirementSnapshot(f.path), 'schema-unsupported')
    mutate(f.path, database => database.exec(`CREATE TRIGGER ${name} BEFORE UPDATE ON automation_system_retirements
      BEGIN SELECT 1; END`))
    expectCode(() => inspectAutomationRetirementSnapshot(f.path), 'schema-unsupported')
  })

  test.each([
    'PRAGMA user_version=17',
    'CREATE TABLE unexpected_history(id TEXT) STRICT',
    'CREATE VIEW unexpected_view AS SELECT id FROM automation_tasks',
    'CREATE INDEX unexpected_index ON automation_tasks(status)',
    'ALTER TABLE automation_tasks ADD COLUMN unexpected TEXT',
  ])('rejects unsupported schema: %s', async sql => {
    const f = await fixture()
    mutate(f.path, database => database.exec(sql))
    expectCode(() => inspectAutomationRetirementSnapshot(f.path), 'schema-unsupported')
  })

  test('rejects a v16 schema falsely labeled v15, tampered retirement table and corrupt definitions', async () => {
    const f = await fixture()
    mutate(f.path, database => database.exec('PRAGMA user_version=15'))
    expectCode(() => inspectAutomationRetirementSnapshot(f.path), 'schema-unsupported')
    mutate(f.path, database => database.exec('PRAGMA user_version=16; ALTER TABLE automation_system_retirements ADD COLUMN unexpected TEXT'))
    expectCode(() => inspectAutomationRetirementSnapshot(f.path), 'schema-unsupported')
    const corrupt = await fixture()
    mutate(corrupt.path, database => database.prepare("UPDATE automation_definitions SET definition_json='{}'").run())
    expectCode(() => inspectAutomationRetirementSnapshot(corrupt.path), 'database-corrupt')
  })

  test.runIf(process.platform === 'linux')('reads complete WAL data from pinned copies and preserves every source byte and inode', async () => {
    const f = await fixture()
    const keeper = spawn(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite'
      const database = new DatabaseSync(process.argv[1])
      database.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0')
      database.prepare("UPDATE automation_tasks SET claimed_by='WAL_PRIVATE_BODY',status='running'").run()
      process.stdout.write('ready\\n')
      process.stdin.on('data', () => { database.close(); process.exit(0) })
    `, f.path], { stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      await new Promise<void>((resolve, reject) => {
        keeper.once('error', reject)
        keeper.stdout.once('data', () => resolve())
        keeper.once('exit', code => reject(new Error(`keeper exited ${code} before ready`)))
      })
      for (const suffix of ['-wal', '-shm']) chmodSync(f.path + suffix, 0o600)
      const before = fingerprint(f.path)
      const proof = inspectAutomationRetirementSnapshot(f.path)
      expect(proof.inFlightCount).toBe(1)
      expect(proof.sidecars.wal).not.toBeNull()
      expect(JSON.stringify(proof)).not.toContain('WAL_PRIVATE_BODY')
      expect(fingerprint(f.path)).toEqual(before)
    } finally {
      if (keeper.exitCode === null && keeper.signalCode === null) {
        keeper.kill('SIGTERM')
        await new Promise<void>(resolve => keeper.once('exit', () => resolve()))
      }
    }
  })

  test('fails closed for unsafe files, incomplete WAL and rollback journals', async () => {
    const f = await fixture()
    chmodSync(f.path, 0o644)
    expectCode(() => inspectAutomationRetirementSnapshot(f.path), 'unsafe-path')
    chmodSync(f.path, 0o600)
    writeFileSync(`${f.path}-wal`, '', { mode: 0o600 })
    expectCode(() => inspectAutomationRetirementSnapshot(f.path), 'database-drift')
    renameSync(`${f.path}-wal`, `${f.path}-journal`)
    expectCode(() => inspectAutomationRetirementSnapshot(f.path), 'database-busy')
  })
})
