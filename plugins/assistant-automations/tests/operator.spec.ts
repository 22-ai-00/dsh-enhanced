import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { chmodSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, test, vi } from 'vitest'

let procLocksReadFailure = false
const sqliteControls = vi.hoisted(() => ({
  beforeOpen: null as null | (() => void),
  afterOpen: null as null | (() => void),
}))
const raceControls = vi.hoisted(() => ({
  onSourceRead: null as null | ((path: string) => void),
}))
const tempControls = vi.hoisted(() => ({
  widenAfterOpen: false,
  lastPath: null as string | null,
}))

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const descriptorPaths = new Map<number, string>()
  return {
    ...actual,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      const descriptor = actual.openSync(...args)
      const path = String(args[0] ?? '')
      if (tempControls.widenAfterOpen && /\/automations-operator-snapshot-[^/]*$/u.test(path)) {
        tempControls.lastPath = path
        actual.chmodSync(path, 0o755)
      }
      descriptorPaths.set(descriptor, String(args[0]))
      return descriptor
    }) as typeof actual.openSync,
    readSync: ((...args: Parameters<typeof actual.readSync>) => {
      const count = actual.readSync(...args)
      if (count > 0) raceControls.onSourceRead?.(descriptorPaths.get(args[0] as number) ?? '')
      return count
    }) as typeof actual.readSync,
    closeSync: ((descriptor: number) => {
      actual.closeSync(descriptor)
      descriptorPaths.delete(descriptor)
    }) as typeof actual.closeSync,
    readFileSync: (path: unknown, ...rest: unknown[]) => {
      if (procLocksReadFailure && path === '/proc/locks') throw new Error('mock /proc/locks unreadable')
      return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest)
    },
  }
})

vi.mock('node:sqlite', async importOriginal => {
  const actual = await importOriginal<typeof import('node:sqlite')>()
  const RealDatabaseSync = actual.DatabaseSync
  const ProbedDatabaseSync = new Proxy(RealDatabaseSync, {
    construct(target, args) {
      sqliteControls.beforeOpen?.()
      const instance = Reflect.construct(target, args)
      sqliteControls.afterOpen?.()
      return instance
    },
  })
  return { ...actual, DatabaseSync: ProbedDatabaseSync }
})

import {
  AutomationOperatorSnapshotError,
  automationDefinitionDigest,
  decodeDeviceId,
  inspectAutomationsOperatorSnapshot,
  listActiveAutomationsLocally,
  listAutomationsLocally,
  parseWritableProcLock,
} from '../src/operator.ts'
import { AutomationStore } from '../src/store.ts'

const roots: string[] = []
const minute = 60_000

afterEach(async () => {
  procLocksReadFailure = false
  sqliteControls.beforeOpen = null
  sqliteControls.afterOpen = null
  raceControls.onSourceRead = null
  tempControls.widenAfterOpen = false
  tempControls.lastPath = null
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function definition(name: string) {
  return {
    name, prompt: `Run ${name}.`,
    schedule: { kind: 'every', anchorAt: '2026-09-11T00:00:00.000Z', intervalMs: 15 * minute },
    workspace: '/work/operator', agentPreset: 'primary', provider: 'mock', model: 'mock-model',
    allowedTools: ['wiki_search'], timeoutMs: minute, maxOutputTokens: 2_048, maxToolCalls: 4,
    misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0,
    principal: 'owner:test',
  }
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'automations-operator-'))); roots.push(root)
  const state = join(root, 'state'); const path = join(state, 'automations.sqlite')
  const store = new AutomationStore({ path, now: () => Date.parse('2026-09-11T00:00:00.000Z') })
  return { root, state, path, store }
}

async function fingerprint(path: string) {
  try {
    const metadata = await stat(path, { bigint: true }); const bytes = await readFile(path)
    return { device: metadata.dev, inode: metadata.ino, size: metadata.size, mode: metadata.mode,
      mtimeNs: metadata.mtimeNs, ctimeNs: metadata.ctimeNs, digest: createHash('sha256').update(bytes).digest('hex') }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: unknown }).code === 'ENOENT') return null
    throw error
  }
}

function expectCode(operation: () => unknown, code: AutomationOperatorSnapshotError['code']): void {
  expect(operation).toThrowError(expect.objectContaining<Partial<AutomationOperatorSnapshotError>>({ code }))
}

type RaceAction = 'chmod-parent' | 'remove-parent' | 'swap-parent'

interface RaceWorker {
  readonly worker: Worker
  readonly ready: Int32Array
  readonly gate: Int32Array
  readonly done: Int32Array
}

function startRaceWorker(action: RaceAction, paths: readonly string[]): RaceWorker {
  const readyBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  const gateBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  const doneBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  const ready = new Int32Array(readyBuffer)
  const gate = new Int32Array(gateBuffer)
  const done = new Int32Array(doneBuffer)
  const worker = new Worker(`
    const { workerData } = require('node:worker_threads')
    const fs = require('node:fs')
    const ready = new Int32Array(workerData.ready)
    const gate = new Int32Array(workerData.gate)
    const done = new Int32Array(workerData.done)
    Atomics.store(ready, 0, 1)
    Atomics.notify(ready, 0)
    Atomics.wait(gate, 0, 0)
    try {
      if (workerData.action === 'chmod-parent') {
        fs.chmodSync(workerData.paths[0], 0o755)
      } else if (workerData.action === 'remove-parent') {
        fs.renameSync(workerData.paths[0], workerData.paths[1])
      } else {
        fs.renameSync(workerData.paths[0], workerData.paths[1])
        fs.renameSync(workerData.paths[2], workerData.paths[0])
      }
      Atomics.store(done, 0, 1)
    } catch {
      Atomics.store(done, 0, 2)
    } finally {
      Atomics.notify(done, 0)
    }
  `, {
    eval: true,
    workerData: { ready: readyBuffer, gate: gateBuffer, done: doneBuffer, action, paths },
  })
  if (Atomics.wait(ready, 0, 0, 5_000) === 'timed-out' || Atomics.load(ready, 0) !== 1) {
    throw new Error('race worker did not reach its ready handshake')
  }
  return { worker, ready, gate, done }
}

function armSourceRace(race: RaceWorker, sourcePath: string): void {
  raceControls.onSourceRead = path => {
    if (path !== sourcePath) return
    raceControls.onSourceRead = null
    Atomics.store(race.gate, 0, 1)
    Atomics.notify(race.gate, 0)
    if (Atomics.wait(race.done, 0, 0, 5_000) === 'timed-out' || Atomics.load(race.done, 0) !== 1) {
      throw new Error('race worker did not complete its triggered mutation')
    }
  }
}

async function finishRaceWorker(race: RaceWorker): Promise<void> {
  await race.worker.terminate()
}

describe('read-only Automations operator snapshot', () => {
  test('returns a canonical, deeply frozen, content-free complete inventory without changing storage', async () => {
    const f = await fixture()
    const active = f.store.reconcileSystemOwned({ owner: 'owner-b', automationId: 'z-active',
      idempotencyKey: 'create-z', definition: definition('active') })
    f.store.reconcileSystemOwned({ owner: 'owner-a', automationId: 'a-paused',
      idempotencyKey: 'create-a', desiredStatus: 'paused', definition: definition('paused') })
    const deleted = f.store.createApproved({ automationId: 'm-deleted', idempotencyKey: 'create-m', definition: definition('deleted') })
    f.store.changeApproved({ automationId: deleted.id, operation: 'delete', expectedVersion: deleted.version, idempotencyKey: 'delete-m' })
    f.store.close()

    const paths = [f.path, `${f.path}-wal`, `${f.path}-shm`]
    const before = await Promise.all(paths.map(fingerprint))
    const versionBeforeDatabase = new DatabaseSync(`file:${f.path}?mode=ro&immutable=1`, { readOnly: true })
    const versionBefore = versionBeforeDatabase.prepare('PRAGMA user_version').get(); versionBeforeDatabase.close()
    const snapshot = inspectAutomationsOperatorSnapshot(f.path)
    const versionDatabase = new DatabaseSync(`file:${f.path}?mode=ro&immutable=1`, { readOnly: true })
    const versionAfter = versionDatabase.prepare('PRAGMA user_version').get(); versionDatabase.close()
    const after = await Promise.all(paths.map(fingerprint))

    expect(snapshot).toMatchObject({ protocol: 'assistant-automations-operator-snapshot/v1', schemaVersion: 15,
      inFlightCount: 0, records: [
        { id: 'a-paused', owner: 'owner-a', status: 'paused', runningTaskCount: 0 },
        { id: 'm-deleted', status: 'deleted', runningTaskCount: 0 },
        { id: 'z-active', owner: 'owner-b', status: 'active', runningTaskCount: 0 },
      ] })
    expect(snapshot.records[0]).not.toHaveProperty('definition')
    expect(JSON.stringify(snapshot)).not.toContain('Run paused')
    expect(snapshot.records[2]?.definitionHash).toBe(automationDefinitionDigest(active.definition))
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.database)).toBe(true)
    expect(Object.isFrozen(snapshot.sidecars)).toBe(true)
    expect(Object.isFrozen(snapshot.records)).toBe(true)
    expect(snapshot.records.every(Object.isFrozen)).toBe(true)
    expect(versionAfter).toEqual(versionBefore)
    expect(after).toEqual(before)

    const compatible = listAutomationsLocally(f.path)
    expect(compatible.map(record => record.id)).toEqual(['a-paused', 'm-deleted', 'z-active'])
    expect(compatible[0]?.definition).toEqual(definition('paused'))
    expect(Object.isFrozen(compatible[0]?.definition)).toBe(true)
  })

  test('compatibility projections return an empty inventory for a never-created database while the strict snapshot keeps failing (B-M1)', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'automations-operator-missing-'))); roots.push(root)
    await chmod(root, 0o700)
    const path = join(root, 'automations.sqlite')
    // Fresh-profile shape: private parent exists, database file was never created.
    expectCode(() => inspectAutomationsOperatorSnapshot(path), 'database-missing')
    expect(listAutomationsLocally(path)).toEqual([])
    expect(listActiveAutomationsLocally(path)).toEqual([])
    // Any other defect must still surface through the compatibility names.
    const targetRoot = await realpath(await mkdtemp(join(tmpdir(), 'automations-operator-missing-link-'))); roots.push(targetRoot)
    await chmod(targetRoot, 0o700)
    const target = join(targetRoot, 'automations.sqlite'); new AutomationStore({ path: target }).close()
    const linked = join(root, 'linked.sqlite'); await symlink(target, linked)
    expectCode(() => listAutomationsLocally(linked), 'unsafe-path')
  })

  test('reports claimed/running tasks per definition and globally without exposing task content', async () => {
    const f = await fixture()
    const created = f.store.createApproved({ automationId: 'active', idempotencyKey: 'create', definition: definition('active') })
    f.store.close()
    const database = new DatabaseSync(f.path)
    database.exec('PRAGMA foreign_keys=OFF')
    database.prepare(`INSERT INTO automation_occurrences(
      id, automation_id, trigger_kind, trigger_key, scheduled_at, status, reason, dry_run,
      external_event_json, external_event_digest, created_at, updated_at
    ) VALUES (?, ?, 'manual', ?, 1, 'pending', NULL, 0, NULL, NULL, 1, 1)`).run('occ-secret', created.id, 'manual-secret')
    database.prepare(`INSERT INTO automation_tasks(
      id, occurrence_id, automation_id, status, cancel_requested, claimed_by, fencing_token, lease_until, attempt_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, 1, 1, 1)`).run('task-secret', 'occ-secret', created.id, 'running', 'private-runner', 9, 99)
    database.close()
    const snapshot = inspectAutomationsOperatorSnapshot(f.path)
    expect(snapshot.inFlightCount).toBe(1)
    expect(snapshot.records[0]?.runningTaskCount).toBe(1)
    expect(JSON.stringify(snapshot)).not.toMatch(/task-secret|private-runner|occ-secret/u)
  })

  test('rejects missing, relative, symlinked, hardlinked, public-mode and non-private-parent paths', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'automations-operator-paths-'))); roots.push(root)
    await chmod(root, 0o700)
    expectCode(() => inspectAutomationsOperatorSnapshot(join(root, 'missing.sqlite')), 'database-missing')
    expectCode(() => inspectAutomationsOperatorSnapshot('relative.sqlite'), 'invalid-path')

    const targetRoot = await realpath(await mkdtemp(join(tmpdir(), 'automations-operator-target-'))); roots.push(targetRoot)
    const state = join(targetRoot, 'state'); const target = join(state, 'automations.sqlite')
    new AutomationStore({ path: target }).close()
    const symlinkPath = join(root, 'symlink.sqlite'); await symlink(target, symlinkPath)
    expectCode(() => inspectAutomationsOperatorSnapshot(symlinkPath), 'unsafe-path')
    const hardlinkPath = join(state, 'hardlink.sqlite'); await link(target, hardlinkPath)
    expectCode(() => inspectAutomationsOperatorSnapshot(target), 'unsafe-path')
    await rm(hardlinkPath)
    await chmod(target, 0o640)
    expectCode(() => inspectAutomationsOperatorSnapshot(target), 'unsafe-path')
    await chmod(target, 0o400)
    expectCode(() => inspectAutomationsOperatorSnapshot(target), 'unsafe-path')
    await chmod(target, 0o600); await chmod(state, 0o750)
    expectCode(() => inspectAutomationsOperatorSnapshot(target), 'unsafe-parent')
    await chmod(state, 0o500)
    expect(inspectAutomationsOperatorSnapshot(target).records).toEqual([])
    await chmod(state, 0o4700)
    expectCode(() => inspectAutomationsOperatorSnapshot(target), 'unsafe-parent')
    await chmod(state, 0o700)

    const ancestorRoot = await realpath(await mkdtemp(join(tmpdir(), 'automations-operator-ancestor-'))); roots.push(ancestorRoot)
    await chmod(ancestorRoot, 0o700); const realParent = join(ancestorRoot, 'real'); await mkdir(realParent, { mode: 0o700 })
    const ancestorTarget = join(realParent, 'automations.sqlite'); new AutomationStore({ path: ancestorTarget }).close()
    const linkedParent = join(ancestorRoot, 'linked'); await symlink(realParent, linkedParent)
    expectCode(() => inspectAutomationsOperatorSnapshot(join(linkedParent, 'automations.sqlite')), 'unsafe-path')
  })

  test.each([14, 16])('rejects schema v%s without migrating it', async version => {
    const root = await realpath(await mkdtemp(join(tmpdir(), `automations-operator-v${version}-`))); roots.push(root)
    await chmod(root, 0o700); const path = join(root, 'automations.sqlite')
    const database = new DatabaseSync(path); database.exec(`PRAGMA user_version=${version}`); database.close(); await chmod(path, 0o600)
    const before = await fingerprint(path)
    expectCode(() => inspectAutomationsOperatorSnapshot(path), 'schema-unsupported')
    expect(await fingerprint(path)).toEqual(before)
    const check = new DatabaseSync(path, { readOnly: true })
    expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: version }); check.close()
  })

  test('rejects corrupt SQLite and canonical-definition/digest drift', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'automations-operator-corrupt-'))); roots.push(root)
    await chmod(root, 0o700); const corrupt = join(root, 'corrupt.sqlite')
    await writeFile(corrupt, 'not sqlite'); await chmod(corrupt, 0o600)
    expectCode(() => inspectAutomationsOperatorSnapshot(corrupt), 'database-corrupt')

    const f = await fixture(); f.store.createApproved({ automationId: 'drift', idempotencyKey: 'create', definition: definition('drift') }); f.store.close()
    const database = new DatabaseSync(f.path)
    database.prepare('UPDATE automation_definitions SET definition_hash=? WHERE id=?').run('0'.repeat(64), 'drift')
    database.close()
    expectCode(() => inspectAutomationsOperatorSnapshot(f.path), 'database-corrupt')
  })

  test.each([
    ['JSON bytes', (database: DatabaseSync) => database.prepare(
      'UPDATE automation_definitions SET definition_json=? WHERE id=?',
    ).run(JSON.stringify({ ...definition('drift'), prompt: 'changed' }), 'drift')],
    ['row metadata', (database: DatabaseSync) => database.prepare(
      "UPDATE automation_definitions SET status='paused', next_run_at=1 WHERE id=?",
    ).run('drift')],
  ])('rejects corrupt %s', async (_label, mutate) => {
    const f = await fixture(); f.store.createApproved({ automationId: 'drift', idempotencyKey: 'create', definition: definition('drift') }); f.store.close()
    const database = new DatabaseSync(f.path); mutate(database); database.close()
    expectCode(() => inspectAutomationsOperatorSnapshot(f.path), 'database-corrupt')
  })

  test('reads committed live WAL state from a private copy without changing source sidecars', async () => {
    const f = await fixture()
    f.store.createApproved({ automationId: 'wal', idempotencyKey: 'create', definition: definition('wal') }); f.store.close()
    const seed = new DatabaseSync(f.path)
    seed.prepare(`INSERT INTO automation_occurrences(
      id, automation_id, trigger_kind, trigger_key, scheduled_at, status, reason, dry_run,
      external_event_json, external_event_digest, created_at, updated_at
    ) VALUES (?, 'wal', 'manual', ?, 1, 'pending', NULL, 0, NULL, NULL, 1, 1)`).run('occ-storage-digest', 'manual-storage-digest')
    seed.prepare(`INSERT INTO automation_tasks(
      id, occurrence_id, automation_id, status, cancel_requested, claimed_by, fencing_token, lease_until,
      attempt_count, created_at, updated_at
    ) VALUES ('task-storage-digest', 'occ-storage-digest', 'wal', 'scheduled', 0, NULL, NULL, NULL, 0, 1, 1)`).run()
    seed.close()
    const writer = new DatabaseSync(f.path); writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0')
    await chmod(`${f.path}-wal`, 0o600); await chmod(`${f.path}-shm`, 0o600)
    const beforeLedgerChange = inspectAutomationsOperatorSnapshot(f.path)
    writer.prepare("UPDATE automation_tasks SET status='failed', updated_at=updated_at+1 WHERE id=?")
      .run('task-storage-digest')
    await chmod(`${f.path}-wal`, 0o600); await chmod(`${f.path}-shm`, 0o600)
    const before = await Promise.all([f.path, `${f.path}-wal`, `${f.path}-shm`].map(fingerprint))
    const snapshot = inspectAutomationsOperatorSnapshot(f.path)
    expect(snapshot.records).toEqual(beforeLedgerChange.records)
    expect(snapshot.storageDigest).not.toBe(beforeLedgerChange.storageDigest)
    expect(snapshot.inventoryDigest).not.toBe(beforeLedgerChange.inventoryDigest)
    expect(snapshot.sidecars.wal).not.toBeNull(); expect(snapshot.sidecars.shm).not.toBeNull()
    expect(await Promise.all([f.path, `${f.path}-wal`, `${f.path}-shm`].map(fingerprint))).toEqual(before)
    await chmod(`${f.path}-wal`, 0o644)
    expectCode(() => inspectAutomationsOperatorSnapshot(f.path), 'unsafe-path')
    await chmod(`${f.path}-wal`, 0o600); writer.close()
  })

  test('rejects source WAL drift while constructing the private copy', async () => {
    const f = await fixture()
    f.store.createApproved({ automationId: 'wal-drift', idempotencyKey: 'create', definition: definition('wal-drift') }); f.store.close()
    const writer = new DatabaseSync(f.path); writer.exec('PRAGMA wal_autocheckpoint=0')
    writer.exec('CREATE TABLE operator_copy_padding(bytes BLOB) STRICT')
    writer.prepare('INSERT INTO operator_copy_padding VALUES (zeroblob(?))').run(128 * 1024 * 1024)
    await chmod(`${f.path}-wal`, 0o600); await chmod(`${f.path}-shm`, 0o600)
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { readdirSync, statSync, utimesSync } from 'node:fs'
      const wal = process.argv[2]
      const started = BigInt(process.argv[1])
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        if (readdirSync(${JSON.stringify(tmpdir())}).some(name => {
          if (!name.startsWith('automations-operator-snapshot-')) return false
          try { return statSync(${JSON.stringify(tmpdir())} + '/' + name, { bigint: true }).ctimeNs >= started } catch { return false }
        })) {
          const now = new Date(); utimesSync(wal, now, now); process.exit(0)
        }
      }
      process.exit(2)
    `, (BigInt(Date.now()) * 1_000_000n).toString(), `${f.path}-wal`], { stdio: 'ignore' })
    expectCode(() => inspectAutomationsOperatorSnapshot(f.path), 'database-drift')
    await new Promise<void>((resolve, reject) => {
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`WAL drift helper exited ${code}`)))
      child.once('error', reject)
    })
    writer.close()
  })

  test('rechecks temporary directory permissions through the pinned directory descriptor', async () => {
    const f = await fixture()
    f.store.createApproved({ automationId: 'temp-pin', idempotencyKey: 'create', definition: definition('temp-pin') })
    f.store.close()
    const writer = new DatabaseSync(f.path); writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0')
    writer.prepare("UPDATE automation_definitions SET updated_at=updated_at+1 WHERE id='temp-pin'").run()
    await chmod(`${f.path}-wal`, 0o600); await chmod(`${f.path}-shm`, 0o600)
    tempControls.widenAfterOpen = true
    expectCode(() => inspectAutomationsOperatorSnapshot(f.path), 'unsafe-path')
    if (tempControls.lastPath !== null) {
      await expect(lstat(tempControls.lastPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    tempControls.widenAfterOpen = false
    writer.close()
  })

  test('unsafe-parent overrides a lower-level schema error discovered in the same snapshot', async () => {
    const f = await fixture(); f.store.close()
    const database = new DatabaseSync(f.path)
    database.exec('PRAGMA user_version = 14')
    database.close(); await chmod(f.path, 0o600)
    sqliteControls.afterOpen = () => chmodSync(f.state, 0o755)
    try {
      expectCode(() => inspectAutomationsOperatorSnapshot(f.path), 'unsafe-parent')
    } finally {
      sqliteControls.afterOpen = null
      await chmod(f.state, 0o700)
    }
  })

  test.runIf(process.platform === 'linux')('fails closed on an exclusive locking-mode connection and does not alter the database timestamp', async () => {
    // PRAGMA locking_mode=EXCLUSIVE locks the main database inode itself. That is
    // not the shape of a production WAL writer (whose WRITE lock lands on -shm);
    // the ordinary WAL transaction case is covered by the dedicated test below.
    const f = await fixture(); f.store.close()
    const before = await fingerprint(f.path)
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite'
      const database = new DatabaseSync(process.argv[1])
      database.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE')
      process.stdout.write('ready\\n')
      setTimeout(() => { database.exec('ROLLBACK'); database.close() }, 2000)
    `, f.path], { stdio: ['ignore', 'pipe', 'ignore'] })
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.stdout.once('data', () => resolve()) })
    try {
      expectCode(() => inspectAutomationsOperatorSnapshot(f.path), 'database-busy')
      expect(await fingerprint(f.path)).toEqual(before)
    } finally { child.kill('SIGTERM') }
  })

  test.runIf(process.platform === 'linux')('fails closed when the database identity drifts during inspection', async () => {
    const f = await fixture(); f.store.close()
    const database = new DatabaseSync(f.path)
    database.exec('CREATE TABLE operator_drift_padding(bytes BLOB) STRICT')
    database.prepare('INSERT INTO operator_drift_padding VALUES (zeroblob(?))').run(128 * 1024 * 1024)
    database.close()
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { utimesSync } from 'node:fs'
      const path = process.argv[1]
      process.stdout.write('ready\\n')
      const timer = setInterval(() => { const now = new Date(); utimesSync(path, now, now) }, 1)
      setTimeout(() => { clearInterval(timer); process.exit(0) }, 2000)
    `, f.path], { stdio: ['ignore', 'pipe', 'ignore'] })
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.stdout.once('data', () => resolve())
    })
    try {
      expectCode(() => inspectAutomationsOperatorSnapshot(f.path), 'database-drift')
    } finally {
      child.kill('SIGTERM')
    }
    expect((await lstat(f.path)).isFile()).toBe(true)
  })

  test('decodes full-width Linux dev_t values and parses /proc/locks writer rows', () => {
    expect(decodeDeviceId(0xfe01n)).toEqual({ major: 0xfen, minor: 0x01n })
    // Synthetic user-space dev_t encoding major 0x1fedc / minor 0x654321, where
    // both components carry bits above the legacy 8/12-bit masks.
    const wide = 0x1f006543edc21n
    expect(decodeDeviceId(wide)).toEqual({ major: 0x1fedcn, minor: 0x654321n })
    // High major bits must not bleed into the minor (the old mask bug).
    expect(decodeDeviceId(0x10000000000ffn)).toEqual({ major: 0x10000n, minor: 0xffn })

    const held = '137: POSIX  ADVISORY  WRITE 657039 fe:01:40268 120 120'
    expect(parseWritableProcLock(held)).toEqual({ major: 0xfen, minor: 1n, inode: '40268' })
    // Blocked writers shift every column by the leading "->" marker.
    const blocked = '2: -> POSIX  ADVISORY  WRITE 1234 fe:01:40268 120 120'
    expect(parseWritableProcLock(blocked)).toEqual({ major: 0xfen, minor: 1n, inode: '40268' })
    expect(parseWritableProcLock('139: POSIX  ADVISORY  READ 657039 fe:01:40266 1073741826 1073742335')).toBeNull()
    expect(parseWritableProcLock('not a locks row')).toBeNull()
    expect(parseWritableProcLock('')).toBeNull()
  })

  test.runIf(process.platform === 'linux')('fails closed when a hot rollback journal sits next to the database', async () => {
    const f = await fixture(); f.store.createApproved({
      automationId: 'journal', idempotencyKey: 'create', definition: definition('journal'),
    }); f.store.close()
    await writeFile(`${f.path}-journal`, Buffer.alloc(4096, 0x5a))
    await chmod(`${f.path}-journal`, 0o600)
    const before = await fingerprint(f.path)
    expectCode(() => inspectAutomationsOperatorSnapshot(f.path), 'database-busy')
    expect(await fingerprint(f.path)).toEqual(before)
  })

  test.runIf(process.platform === 'linux')('fails closed on an ordinary WAL write transaction, whose WRITE lock is on the SHM inode', async () => {
    const f = await fixture()
    f.store.createApproved({ automationId: 'wal-writer', idempotencyKey: 'create', definition: definition('wal-writer') })
    f.store.close()
    const keeper = new DatabaseSync(f.path)
    keeper.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0')
    const writer = new DatabaseSync(f.path)
    try {
      // This is the production WAL writer shape: a plain BEGIN IMMEDIATE takes
      // only the SHM byte-120 WRITE lock, never a lock on the main inode.
      writer.exec('BEGIN IMMEDIATE')
      expectCode(() => inspectAutomationsOperatorSnapshot(f.path), 'database-busy')
      writer.exec('ROLLBACK')
    } finally {
      writer.close(); keeper.close()
    }
  })

  test('fails closed (busy) when /proc/locks cannot be read', async () => {
    const f = await fixture(); f.store.close()
    procLocksReadFailure = true
    expectCode(() => inspectAutomationsOperatorSnapshot(f.path), 'database-busy')
    procLocksReadFailure = false
  })

  test.runIf(process.platform === 'linux')('fails closed if a rollback journal appears during the snapshot window', async () => {
    const f = await fixture()
    f.store.createApproved({ automationId: 'wal-journal-drift', idempotencyKey: 'create', definition: definition('wal-journal-drift') }); f.store.close()
    const writer = new DatabaseSync(f.path); writer.exec('PRAGMA wal_autocheckpoint=0')
    writer.exec('CREATE TABLE operator_journal_padding(bytes BLOB) STRICT')
    writer.prepare('INSERT INTO operator_journal_padding VALUES (zeroblob(?))').run(128 * 1024 * 1024)
    await chmod(`${f.path}-wal`, 0o600); await chmod(`${f.path}-shm`, 0o600)
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { writeFileSync, readdirSync, statSync } from 'node:fs'
      const started = BigInt(process.argv[1]); const journal = process.argv[2]
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        if (readdirSync(${JSON.stringify(tmpdir())}).some(name => {
          if (!name.startsWith('automations-operator-snapshot-')) return false
          try { return statSync(${JSON.stringify(tmpdir())} + '/' + name, { bigint: true }).ctimeNs >= started } catch { return false }
        })) {
          writeFileSync(journal, Buffer.alloc(4096, 0x5a)); process.exit(0)
        }
      }
      process.exit(2)
    `, (BigInt(Date.now()) * 1_000_000n).toString(), `${f.path}-journal`], { stdio: 'ignore' })
    expectCode(() => inspectAutomationsOperatorSnapshot(f.path), 'database-drift')
    await new Promise<void>((resolve, reject) => {
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`journal drift helper exited ${code}`)))
      child.once('error', reject)
    })
    await rm(`${f.path}-journal`, { force: true })
    writer.close()
  })

  test.runIf(process.platform === 'linux')('detects ctime-only identity drift even when size, mtime and mode are unchanged', async () => {
    const f = await fixture(); f.store.close()
    const database = new DatabaseSync(f.path)
    database.exec('CREATE TABLE operator_ctime_padding(bytes BLOB) STRICT')
    database.prepare('INSERT INTO operator_ctime_padding VALUES (zeroblob(?))').run(128 * 1024 * 1024)
    database.close()
    // Pin mtime to a whole second; the child only advances atime, so mtime,
    // size, mode, uid and nlink stay equal while ctime is forced forward.
    await utimes(f.path, 1_700_000_000, 1_700_000_000)
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { utimesSync } from 'node:fs'
      const path = process.argv[1]
      process.stdout.write('ready\\n')
      const timer = setInterval(() => utimesSync(path, 1_700_000_100, 1_700_000_000), 1)
      setTimeout(() => { clearInterval(timer); process.exit(0) }, 2000)
    `, f.path], { stdio: ['ignore', 'pipe', 'ignore'] })
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.stdout.once('data', () => resolve())
    })
    try {
      expectCode(() => inspectAutomationsOperatorSnapshot(f.path), 'database-drift')
    } finally {
      child.kill('SIGTERM')
    }
  })

  test.runIf(process.platform === 'linux')('fails closed with unsafe-parent when the pinned parent mode is widened during the snapshot', async () => {
    const f = await fixture(); f.store.close()
    const database = new DatabaseSync(f.path)
    database.exec('CREATE TABLE operator_parent_padding(bytes BLOB) STRICT')
    database.prepare('INSERT INTO operator_parent_padding(bytes) VALUES (zeroblob(?))').run(16 * 1024 * 1024)
    database.close()
    const race = startRaceWorker('chmod-parent', [f.state])
    armSourceRace(race, f.path)
    expectCode(() => inspectAutomationsOperatorSnapshot(f.path), 'unsafe-parent')
    await chmod(f.state, 0o700)
    await finishRaceWorker(race)
  })

  test.runIf(process.platform === 'linux')('fails closed when the pinned parent is swapped for a same-name replacement tree mid-snapshot', async () => {
    const f = await fixture(); f.store.close()
    const database = new DatabaseSync(f.path)
    database.exec('CREATE TABLE operator_parent_swap_padding(bytes BLOB) STRICT')
    database.prepare('INSERT INTO operator_parent_swap_padding(bytes) VALUES (zeroblob(?))').run(16 * 1024 * 1024)
    database.close()
    const replacement = await realpath(await mkdtemp(join(tmpdir(), 'automations-parent-replacement-'))); roots.push(replacement)
    const moved = `${f.state}.old`; roots.push(moved)
    const race = startRaceWorker('swap-parent', [f.state, moved, replacement])
    armSourceRace(race, f.path)
    let thrown: AutomationOperatorSnapshotError | undefined
    try {
      inspectAutomationsOperatorSnapshot(f.path)
    } catch (error) {
      thrown = error as AutomationOperatorSnapshotError
    }
    expect(thrown).toBeInstanceOf(AutomationOperatorSnapshotError)
    expect(['database-drift', 'unsafe-parent']).toContain(thrown!.code)
    await finishRaceWorker(race)
  })

  test.runIf(process.platform === 'linux')('M1: parent disappearance during an active snapshot stays unsafe-parent and compatibility layers do not return []', async () => {
    const f = await fixture()
    f.store.createApproved({ automationId: 'parent-removal', idempotencyKey: 'create', definition: definition('parent-removal') })
    f.store.close()
    for (const suffix of ['-wal', '-shm', '-journal']) {
      await rm(`${f.path}${suffix}`, { force: true })
    }
    const database = new DatabaseSync(f.path)
    database.exec('CREATE TABLE operator_parent_removal_padding(bytes BLOB) STRICT')
    database.prepare('INSERT INTO operator_parent_removal_padding(bytes) VALUES (zeroblob(?))').run(16 * 1024 * 1024)
    database.close()
    const moved = `${f.state}.removed`; roots.push(moved)
    const race = startRaceWorker('remove-parent', [f.state, moved])
    armSourceRace(race, f.path)
    expectCode(() => inspectAutomationsOperatorSnapshot(f.path), 'unsafe-parent')
    expectCode(() => listAutomationsLocally(f.path), 'unsafe-parent')
    expectCode(() => listActiveAutomationsLocally(f.path), 'unsafe-parent')
    await finishRaceWorker(race)
  })

  test.runIf(process.platform === 'linux')('H1: full parent ABA around the SQLite open cannot make the snapshot read a same-name malicious database', async () => {
    const f = await fixture()
    const created = f.store.createApproved({ automationId: 'aba-original', idempotencyKey: 'create', definition: definition('aba-original') })
    f.store.close()
    for (const suffix of ['-wal', '-shm', '-journal']) {
      await rm(`${f.path}${suffix}`, { force: true })
    }
    const evilRoot = await realpath(await mkdtemp(join(tmpdir(), 'automations-aba-evil-'))); roots.push(evilRoot)
    const evilState = join(evilRoot, 'state')
    const evilPath = join(evilState, 'automations.sqlite')
    new AutomationStore({
      path: evilPath,
      now: () => Date.parse('2026-09-11T00:00:00.000Z'),
    }).close()
    for (const suffix of ['-wal', '-shm', '-journal']) {
      await rm(`${evilPath}${suffix}`, { force: true })
    }
    const moved = `${f.state}.aba-old`; const evilBack = `${f.state}.aba-evil`
    roots.push(moved, evilBack)
    sqliteControls.beforeOpen = () => {
      renameSync(f.state, moved)
      renameSync(evilState, f.state)
    }
    sqliteControls.afterOpen = () => {
      renameSync(f.state, evilBack)
      renameSync(moved, f.state)
    }
    let snapshot
    try {
      snapshot = inspectAutomationsOperatorSnapshot(f.path)
    } finally {
      sqliteControls.beforeOpen = null
      sqliteControls.afterOpen = null
    }
    expect(snapshot.records).toHaveLength(1)
    expect(snapshot.records[0]?.id).toBe(created.id)
  })
})
