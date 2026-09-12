import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  inspectRecoveryOperatorSnapshot,
  RECOVERY_OPERATOR_SNAPSHOT_PROTOCOL,
  RecoveryOperatorSnapshotError,
  type RecoveryOperatorSnapshotErrorCode,
} from '../src/operator.ts'
import { recoverySchemaVersion } from '../src/sqlite.ts'
import { RecoveryStore } from '../src/store.ts'

const fsControls = vi.hoisted(() => ({
  onOpen: null as null | (() => void),
  onRead: null as null | (() => void),
  onClose: null as null | (() => void),
  widenTemporaryDirectory: false,
  opens: 0,
  reads: 0,
  closes: 0,
}))
const sqliteControls = vi.hoisted(() => ({
  beforeOpen: null as null | (() => void),
  afterOpen: null as null | (() => void),
}))

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    mkdtempSync: ((...args: Parameters<typeof actual.mkdtempSync>) => {
      const path = actual.mkdtempSync(...args)
      if (fsControls.widenTemporaryDirectory) actual.chmodSync(path, 0o755)
      return path
    }) as typeof actual.mkdtempSync,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      const descriptor = actual.openSync(...args); fsControls.opens++; fsControls.onOpen?.(); return descriptor
    }) as typeof actual.openSync,
    readSync: ((...args: Parameters<typeof actual.readSync>) => {
      const count = actual.readSync(...args); fsControls.reads++; fsControls.onRead?.(); return count
    }) as typeof actual.readSync,
    closeSync: ((descriptor: number) => { actual.closeSync(descriptor); fsControls.closes++; fsControls.onClose?.() }) as typeof actual.closeSync,
  }
})

vi.mock('node:sqlite', async importOriginal => {
  const actual = await importOriginal<typeof import('node:sqlite')>()
  const ProbedDatabaseSync = new Proxy(actual.DatabaseSync, {
    construct(target, args) {
      sqliteControls.beforeOpen?.()
      const instance = Reflect.construct(target, args)
      sqliteControls.afterOpen?.()
      return instance
    },
  })
  return { ...actual, DatabaseSync: ProbedDatabaseSync }
})

const roots: string[] = []
const hash = (digit: string): string => digit.repeat(64)

function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), 'assistant-recovery-operator-')))
  roots.push(value)
  return value
}

function seeded(open = false): { path: string; store?: RecoveryStore } {
  const path = join(root(), 'recovery.sqlite')
  const store = new RecoveryStore({ path, now: () => 2_000 })
  const running = store.beginBootstrap({ attestationValid: false, attestations: [] })
  store.attestBootstrap({
    expectedGeneration: running.generation,
    attestations: [{
      automationId: 'recovery:supervised-growth',
      activationState: 'paused',
      activationNonce: 'activation-1',
      activationPlanDigest: hash('a'),
    }],
  })
  store.completeBootstrap({ expectedGeneration: running.generation, status: 'succeeded' })
  if (open) return { path, store }
  store.close()
  return { path }
}

function expectCode(action: () => unknown, code: RecoveryOperatorSnapshotErrorCode): void {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(RecoveryOperatorSnapshotError)
    expect((error as RecoveryOperatorSnapshotError).code).toBe(code)
    return
  }
  throw new Error(`expected RecoveryOperatorSnapshotError:${code}`)
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function sidecars(path: string): string[] {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return readdirSync(path.slice(0, path.lastIndexOf('/')))
    .filter(value => value.startsWith(`${name}-`)).sort()
}

function userVersion(path: string): number {
  const database = new DatabaseSync(`file:${path}?immutable=1`, { readOnly: true })
  try {
    return (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  } finally {
    database.close()
  }
}

function metadata(path: string): { digest: string; modifiedAt: bigint; size: bigint } {
  const stat = statSync(path, { bigint: true })
  return { digest: digest(path), modifiedAt: stat.mtimeNs, size: stat.size }
}

async function withTimestampDrift(path: string, action: () => unknown): Promise<unknown> {
  const signal = new SharedArrayBuffer(4)
  const view = new Int32Array(signal)
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads')
    const { utimesSync } = require('node:fs')
    const view = new Int32Array(workerData.signal)
    Atomics.store(view, 0, 1); Atomics.notify(view, 0)
    const until = Date.now() + 1000
    while (Date.now() < until) {
      const date = new Date(Date.now() + (Date.now() % 1000) + 1000)
      try { utimesSync(workerData.path, date, date) } catch {}
    }
    parentPort.postMessage('done')
  `, { eval: true, workerData: { path, signal } })
  Atomics.wait(view, 0, 0, 5_000)
  try {
    return action()
  } finally {
    await worker.terminate()
    utimesSync(path, new Date(), new Date())
  }
}

afterEach(() => {
  fsControls.onOpen = null; fsControls.onRead = null; fsControls.onClose = null
  fsControls.widenTemporaryDirectory = false
  fsControls.opens = 0; fsControls.reads = 0; fsControls.closes = 0
  sqliteControls.beforeOpen = null; sqliteControls.afterOpen = null
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Recovery operator snapshot', () => {
  it('returns a canonical frozen schema-v4 bootstrap snapshot with local database identity', () => {
    const { path } = seeded()
    const snapshot = inspectRecoveryOperatorSnapshot(path)
    expect(snapshot).toEqual({
      protocol: RECOVERY_OPERATOR_SNAPSHOT_PROTOCOL,
      schemaVersion: recoverySchemaVersion,
      database: {
        device: String(statSync(path, { bigint: true }).dev),
        inode: String(statSync(path, { bigint: true }).ino),
        size: Number(statSync(path, { bigint: true }).size),
        digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      bootstrap: {
        status: 'succeeded',
        generation: 1,
        attestationValid: true,
        attestationSetDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        attestations: [{
          automationId: 'recovery:supervised-growth', activationState: 'paused',
          activationNonce: 'activation-1', activationPlanDigest: hash('a'),
        }],
        updatedAt: 2_000,
      },
      snapshotDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
    expect(inspectRecoveryOperatorSnapshot(path)).toEqual(snapshot)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.database)).toBe(true)
    expect(Object.isFrozen(snapshot.bootstrap)).toBe(true)
    expect(Object.isFrozen(snapshot.bootstrap.attestations)).toBe(true)
    expect(Object.isFrozen(snapshot.bootstrap.attestations[0])).toBe(true)
  })

  it('does not alter clean database bytes, mtime, schema, or create WAL sidecars', () => {
    const { path } = seeded()
    const before = metadata(path)
    const version = userVersion(path)
    expect(sidecars(path)).toEqual([])
    inspectRecoveryOperatorSnapshot(path)
    expect(metadata(path)).toEqual(before)
    expect(userVersion(path)).toBe(version)
    expect(sidecars(path)).toEqual([])
  })

  it('reads committed WAL state without changing database/WAL bytes, database mtime, schema, or sidecar set', () => {
    const { path, store } = seeded(true)
    const beforeDatabase = metadata(path)
    const beforeWal = metadata(`${path}-wal`)
    const beforeSidecars = sidecars(path)
    const version = userVersion(path)
    const snapshot = inspectRecoveryOperatorSnapshot(path)
    expect(snapshot.bootstrap).toMatchObject({ status: 'succeeded', generation: 1 })
    expect(metadata(path)).toEqual(beforeDatabase)
    expect(metadata(`${path}-wal`)).toEqual(beforeWal)
    expect(userVersion(path)).toBe(version)
    expect(sidecars(path)).toEqual(beforeSidecars)
    store!.close()
  })

  it('distinguishes absent parent and absent database without creating either', () => {
    const parent = join(root(), 'absent')
    expectCode(() => inspectRecoveryOperatorSnapshot(join(parent, 'recovery.sqlite')), 'missing-parent')
    expect(existsSyncForTest(parent)).toBe(false)
    const directory = root()
    expectCode(() => inspectRecoveryOperatorSnapshot(join(directory, 'missing.sqlite')), 'missing-file')
    expect(readdirSync(directory)).toEqual([])
  })

  it('rejects symlinks, hardlinks, non-private modes, and unsafe parent modes', () => {
    const { path } = seeded()
    const directory = dirnameForTest(path)
    const symlink = join(directory, 'linked.sqlite')
    symlinkSync(path, symlink)
    expectCode(() => inspectRecoveryOperatorSnapshot(symlink), 'unsafe-file')
    rmSync(symlink)
    const hardlink = join(directory, 'hard.sqlite')
    linkSync(path, hardlink)
    expect(lstatSync(path).nlink).toBe(2)
    expectCode(() => inspectRecoveryOperatorSnapshot(path), 'unsafe-file')
    rmSync(hardlink)
    chmodSync(path, 0o640)
    expectCode(() => inspectRecoveryOperatorSnapshot(path), 'unsafe-file')
    chmodSync(path, 0o400)
    expectCode(() => inspectRecoveryOperatorSnapshot(path), 'unsafe-file')
    chmodSync(path, 0o600)
    chmodSync(directory, 0o750)
    expectCode(() => inspectRecoveryOperatorSnapshot(path), 'unsafe-parent')
    chmodSync(directory, 0o700)
    chmodSync(directory, 0o500)
    expect(inspectRecoveryOperatorSnapshot(path).bootstrap.status).toBe('succeeded')
    chmodSync(directory, 0o4700)
    expectCode(() => inspectRecoveryOperatorSnapshot(path), 'unsafe-parent')
    chmodSync(directory, 0o700)
    const linkedParent = join(root(), 'linked-parent')
    symlinkSync(directory, linkedParent)
    expectCode(
      () => inspectRecoveryOperatorSnapshot(join(linkedParent, 'recovery.sqlite')),
      'unsafe-parent',
    )
  })

  it.each([
    ['old', recoverySchemaVersion - 1, 'schema-too-old'],
    ['new', recoverySchemaVersion + 1, 'schema-too-new'],
  ] as const)('rejects %s schemas without migrating them', (_name, version, code) => {
    const path = join(root(), 'recovery.sqlite')
    const database = new DatabaseSync(path)
    database.exec(`PRAGMA user_version = ${version}`)
    database.close()
    chmodSync(path, 0o600)
    const before = metadata(path)
    expectCode(() => inspectRecoveryOperatorSnapshot(path), code)
    expect(metadata(path)).toEqual(before)
    expect(userVersion(path)).toBe(version)
  })

  it('fails closed for corrupt SQLite and inconsistent canonical bootstrap proof', () => {
    const corrupt = join(root(), 'corrupt.sqlite')
    writeFileSync(corrupt, 'not sqlite', { mode: 0o600 })
    expectCode(() => inspectRecoveryOperatorSnapshot(corrupt), 'database-corrupt')
    const { path } = seeded()
    const database = new DatabaseSync(path)
    database.prepare(`
      UPDATE recovery_runtime_state SET bootstrap_attestation_set_digest = ? WHERE singleton = 1
    `).run(hash('f'))
    database.close()
    expectCode(() => inspectRecoveryOperatorSnapshot(path), 'database-corrupt')
  })

  it('fails closed while a rollback journal proves the database is busy', () => {
    const { path } = seeded()
    const database = new DatabaseSync(path)
    database.exec('PRAGMA journal_mode = DELETE; BEGIN IMMEDIATE')
    database.prepare(`
      UPDATE recovery_runtime_state SET updated_at = updated_at + 1 WHERE singleton = 1
    `).run()
    expect(sidecars(path)).toContain('recovery.sqlite-journal')
    expectCode(() => inspectRecoveryOperatorSnapshot(path), 'database-busy')
    database.exec('ROLLBACK')
    database.close()
  })

  it('detects main database, WAL, and SHM identity drift with distinct error codes', async () => {
    for (const [suffix, code] of [
      ['', 'database-drift'],
      ['-wal', 'wal-drift'],
      ['-shm', 'shm-drift'],
    ] as const) {
      const { path, store } = seeded(true)
      // Make the stable database/WAL digest phase long enough for the worker to
      // overlap without exposing a test-only hook in the production API.
      const database = new DatabaseSync(path)
      database.exec('CREATE TABLE operator_padding (bytes BLOB) STRICT')
      database.prepare('INSERT INTO operator_padding(bytes) VALUES (zeroblob(?))').run(16 * 1024 * 1024)
      database.close()
      let thrown: unknown
      try {
        await withTimestampDrift(`${path}${suffix}`, () => inspectRecoveryOperatorSnapshot(path))
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(RecoveryOperatorSnapshotError)
      expect((thrown as RecoveryOperatorSnapshotError).code).toBe(code)
      store!.close()
    }
  })

  it('equates a clean byte-identical copy at a different inode by storage digest and bootstrap semantics', () => {
    // Headline cross-copy claim: copying the main database (e.g. operator
    // export to another path) yields a new inode, but content comparison must
    // ignore inode identity and match on the storage digest and bootstrap
    // semantics. The store is cleanly closed first, so the WAL is checkpointed
    // and no -wal/-shm sidecars remain.
    const { path } = seeded()
    expect(sidecars(path)).toEqual([])
    const copyDirectory = root()
    const copyPath = join(copyDirectory, 'recovery.sqlite')
    copyFileSync(path, copyPath)
    chmodSync(copyPath, 0o600)
    expect(statSync(path, { bigint: true }).ino)
      .not.toBe(statSync(copyPath, { bigint: true }).ino)

    const source = inspectRecoveryOperatorSnapshot(path)
    const copy = inspectRecoveryOperatorSnapshot(copyPath)
    expect(copy.database.digest).toBe(source.database.digest)
    expect(copy.database.size).toBe(source.database.size)
    expect(copy.bootstrap).toEqual(source.bootstrap)
    expect(copy.protocol).toBe(source.protocol)
    expect(copy.schemaVersion).toBe(source.schemaVersion)
    // The inode is allowed to change under a copy; callers compare on the
    // content/semantic digests above, not on inode identity.
    expect(copy.database.inode).not.toBe(source.database.inode)
    expect(copy.database.device).toBe(source.database.device)
    // Because the unsigned snapshot embeds the inode, its envelope digest
    // intentionally differs even though storage and semantics are equal.
    expect(copy.snapshotDigest).not.toBe(source.snapshotDigest)
  })

  it('reads live WAL state through a private copy without changing source bytes or sidecars', () => {
    const sourceDirectory = root()
    const path = join(sourceDirectory, 'recovery.sqlite')
    let store = new RecoveryStore({ path, now: () => 2_000 })
    const first = store.beginBootstrap({ attestationValid: false, attestations: [] })
    store.attestBootstrap({
      expectedGeneration: first.generation,
      attestations: [{
        automationId: 'recovery:supervised-growth',
        activationState: 'paused',
        activationNonce: 'activation-1',
        activationPlanDigest: hash('a'),
      }],
    })
    store.completeBootstrap({ expectedGeneration: first.generation, status: 'succeeded' })
    store.close()
    expect(sidecars(path)).toEqual([])

    // Reopen and durably begin a second generation whose frames stay only in
    // the WAL (no close, so no checkpoint truncates the -wal).
    store = new RecoveryStore({ path, now: () => 3_000 })
    const second = store.beginBootstrap({ attestationValid: false, attestations: [] })
    expect(second.generation).toBe(2)
    expect(second.status).toBe('running')
    expect(sidecars(path).sort()).toEqual(['recovery.sqlite-shm', 'recovery.sqlite-wal'])
    const source = inspectRecoveryOperatorSnapshot(path)
    expect(source.bootstrap).toMatchObject({ status: 'running', generation: 2 })

    const before = [metadata(path), metadata(`${path}-wal`), metadata(`${path}-shm`)]
    const snapshot = inspectRecoveryOperatorSnapshot(path)
    expect(snapshot.bootstrap).toMatchObject({ status: 'running', generation: 2 })
    expect(snapshot.database.digest).toBe(source.database.digest)
    expect([metadata(path), metadata(`${path}-wal`), metadata(`${path}-shm`)]).toEqual(before)
    expect(sidecars(path).sort()).toEqual(['recovery.sqlite-shm', 'recovery.sqlite-wal'])
    store.close()
  })

  it('removes the private temporary directory when pinning rejects its permissions', () => {
    const { path, store } = seeded(true)
    fsControls.widenTemporaryDirectory = true
    expectCode(() => inspectRecoveryOperatorSnapshot(path), 'database-unavailable')
    const leftovers = readdirSync(tmpdir())
      .filter(name => name.startsWith('assistant-recovery-operator-snapshot-'))
    expect(leftovers).toEqual([])
    fsControls.widenTemporaryDirectory = false
    store!.close()
  })

  it('unsafe-parent overrides a lower-level schema error discovered in the same snapshot', () => {
    const { path } = seeded()
    const database = new DatabaseSync(path)
    database.exec(`PRAGMA user_version = ${recoverySchemaVersion - 1}`)
    database.close(); chmodSync(path, 0o600)
    const parent = dirnameForTest(path)
    sqliteControls.afterOpen = () => chmodSync(parent, 0o755)
    try {
      expectCode(() => inspectRecoveryOperatorSnapshot(path), 'unsafe-parent')
    } finally {
      sqliteControls.afterOpen = null
      chmodSync(parent, 0o700)
    }
  })

  it('binds a non-WAL SQLite open to the original inode across a same-name parent ABA', () => {
    const { path } = seeded()
    const parent = dirnameForTest(path)
    const parked = `${parent}.parked`
    const malicious = `${parent}.malicious`
    const maliciousPath = join(malicious, 'recovery.sqlite')
    mkdirSyncForTest(malicious)
    const evil = new DatabaseSync(maliciousPath)
    evil.exec(`PRAGMA user_version = ${recoverySchemaVersion - 1}`)
    evil.close(); chmodSync(maliciousPath, 0o600)
    sqliteControls.beforeOpen = () => { renameSync(parent, parked); renameSync(malicious, parent) }
    sqliteControls.afterOpen = () => { renameSync(parent, malicious); renameSync(parked, parent) }
    expect(inspectRecoveryOperatorSnapshot(path).bootstrap).toMatchObject({ status: 'succeeded', generation: 1 })
    expect(fsControls.opens).toBeGreaterThan(0)
    expect(fsControls.reads).toBeGreaterThan(0)
    expect(fsControls.closes).toBeGreaterThan(0)
    sqliteControls.beforeOpen = null; sqliteControls.afterOpen = null
    expect(userVersion(path)).toBe(recoverySchemaVersion)
    rmSync(malicious, { recursive: true, force: true })
  })

  it('returns unsafe-parent when the pinned parent disappears during an active snapshot', () => {
    const { path } = seeded()
    const parent = dirnameForTest(path)
    const parked = `${parent}.parked`
    sqliteControls.beforeOpen = () => { renameSync(parent, parked) }
    expectCode(() => inspectRecoveryOperatorSnapshot(path), 'unsafe-parent')
    renameSync(parked, parent)
  })

  it.each([
    ['-wal without -shm', '-shm', 'shm-drift'],
    ['-shm without -wal', '-wal', 'wal-drift'],
  ] as const)('rejects an unpaired sidecar (%s) with %s', (_label, removedSuffix, code) => {
    const { path, store } = seeded(true)
    expect(sidecars(path).sort()).toEqual(['recovery.sqlite-shm', 'recovery.sqlite-wal'])
    rmSync(`${path}${removedSuffix}`)
    expectCode(() => inspectRecoveryOperatorSnapshot(path), code)
    store!.close()
  })

  it.each([
    ['-wal', 'hardlink', 'unsafe-wal'],
    ['-shm', 'hardlink', 'unsafe-shm'],
    ['-wal', 'symlink', 'unsafe-wal'],
    ['-shm', 'symlink', 'unsafe-shm'],
  ] as const)('rejects a %s sidecar substituted by a %s', (suffix, kind, code) => {
    const { path, store } = seeded(true)
    const sidecar = `${path}${suffix}`
    if (kind === 'hardlink') {
      // A second hard link raises nlink above 1, so the sidecar no longer has a
      // unique inode identity and must not be trusted.
      linkSync(sidecar, `${sidecar}.hard`)
      expect(lstatSync(sidecar, { bigint: true }).nlink).toBe(2n)
    } else {
      rmSync(sidecar)
      symlinkSync(`${sidecar}.target`, sidecar)
      expect(lstatSync(sidecar).isSymbolicLink()).toBe(true)
    }
    expectCode(() => inspectRecoveryOperatorSnapshot(path), code)
    store!.close()
  })

  it('classifies a dangling main-database symlink as missing-file rather than unsafe-file', () => {
    // Characterization of current behavior: a dangling symlink fails the
    // existsSync check before realpath resolution, so it reports missing-file.
    const directory = root()
    const dangling = join(directory, 'recovery.sqlite')
    symlinkSync(join(directory, 'does-not-exist'), dangling)
    expectCode(() => inspectRecoveryOperatorSnapshot(dangling), 'missing-file')
  })
})

function existsSyncForTest(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function dirnameForTest(path: string): string {
  return path.slice(0, path.lastIndexOf('/'))
}

function mkdirSyncForTest(path: string): void {
  mkdirSync(path, { mode: 0o700 })
}
