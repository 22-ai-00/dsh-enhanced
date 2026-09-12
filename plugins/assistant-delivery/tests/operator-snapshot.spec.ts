import { createHash } from 'node:crypto'
import { chmod, link, lstat, mkdtemp, readFile, realpath, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { chmodSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, test, vi } from 'vitest'

// Fault-injection switches for the private-copy hardening tests. The mock is
// file-level, but with both switches off it is a pure pass-through, so every
// other test in this file exercises the real node:fs implementation.
const operatorFsControls = vi.hoisted(() => ({
  tamperPrivateCopy: false,
  widenTemporaryDirectory: false,
  widenTemporaryDirectoryAfterOpen: false,
  foreignTemporaryOwner: false,
  lastTemporaryDirectory: null as string | null,
}))

// Deterministic ABA triggers: beforeOpen fires immediately before SQLite's
// native open, afterOpen immediately after it and before the operator's
// post-open checks. Together they bracket the exact H1 swap window with no
// timing race: swap to a malicious tree beforeOpen, restore the original tree
// afterOpen. A path-based open reads the malicious inode while every later
// check sees the restored original; an fd-bound open keeps reading the pin.
const sqliteControls = vi.hoisted(() => ({
  beforeOpen: null as null | (() => void),
  afterOpen: null as null | (() => void),
}))

const raceControls = vi.hoisted(() => ({
  onSourceRead: null as null | (() => void),
}))

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const copiedWriters = new Map<number, string>()
  const descriptorPaths = new Map<number, string>()
  // The operator's private main-database copy lives under a
  // "delivery-operator-snapshot-*" directory; fixture databases live under
  // "delivery-lark-operator-snapshot-*", so this matches only the copy.
  const privateCopyPattern = /delivery-operator-snapshot-[^/]+\/delivery\.sqlite$/u
  // On Linux the copy is created THROUGH the pinned directory fd, so the writer
  // path is the /proc/self/fd anchor rather than the swappable tmp path.
  const anchoredCopyPattern = /\/proc\/self\/fd\/\d+\/delivery\.sqlite$/u
  const temporaryDirectoryPattern = /delivery-operator-snapshot-[^/]+$/u
  const isExclusiveCreator = (path: unknown, flags: unknown): path is string =>
    typeof path === 'string'
    && (privateCopyPattern.test(path) || anchoredCopyPattern.test(path))
    && typeof flags === 'number'
    && Boolean(flags & actual.constants.O_CREAT)
    && Boolean(flags & actual.constants.O_EXCL)
  return {
    ...actual,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      const descriptor = actual.openSync(...args)
      const [path, flags] = args
      if (typeof path === 'string') {
        descriptorPaths.set(descriptor, path)
        if (operatorFsControls.widenTemporaryDirectoryAfterOpen
          && path === operatorFsControls.lastTemporaryDirectory) {
          actual.chmodSync(path, 0o755)
        }
        if (operatorFsControls.tamperPrivateCopy && isExclusiveCreator(path, flags)) {
          copiedWriters.set(descriptor, path)
        }
      }
      return descriptor
    }) as typeof actual.openSync,
    readSync: ((...args: Parameters<typeof actual.readSync>) => {
      const count = actual.readSync(...args)
      const [descriptor] = args
      if (count > 0 && descriptorPaths.get(descriptor)?.includes('/delivery-lark-operator-snapshot-')) {
        raceControls.onSourceRead?.()
      }
      return count
    }) as typeof actual.readSync,
    closeSync: ((descriptor: number) => {
      actual.closeSync(descriptor)
      descriptorPaths.delete(descriptor)
      const path = copiedWriters.get(descriptor)
      if (path !== undefined) {
        copiedWriters.delete(descriptor)
        // Simulate another local actor mutating the copy in the window between
        // the writer closing and the byte-for-byte re-open verification. The
        // first byte (the SQLite magic header) is flipped in place: same size,
        // different digest, so only the digest comparison can catch it.
        if (operatorFsControls.tamperPrivateCopy) {
          const bytes = actual.readFileSync(path)
          bytes[0] = (bytes[0] ?? 0) ^ 0xff
          actual.writeFileSync(path, bytes)
        }
      }
    }) as typeof actual.closeSync,
    lstatSync: ((path: string, options?: { bigint?: boolean }) => {
      // A non-root test process cannot chown, so simulate a foreign-owned
      // temporary directory by stamping only the reported uid (one above ours).
      if (options?.bigint === true) {
        const stats = actual.lstatSync(path, { bigint: true })
        if (operatorFsControls.foreignTemporaryOwner && temporaryDirectoryPattern.test(path)) {
          const stamped: typeof stats = Object.create(stats as object)
          Object.defineProperty(stamped, 'uid', {
            value: stats.uid + 1n, enumerable: true, configurable: true, writable: true,
          })
          return stamped
        }
        return stats
      }
      return actual.lstatSync(path)
    }) as typeof actual.lstatSync,
    mkdtempSync: ((...args: Parameters<typeof actual.mkdtempSync>) => {
      const path = actual.mkdtempSync(...args)
      if (temporaryDirectoryPattern.test(path)) operatorFsControls.lastTemporaryDirectory = path
      if (operatorFsControls.widenTemporaryDirectory) actual.chmodSync(path, 0o755)
      return path
    }) as typeof actual.mkdtempSync,
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
  ActiveLarkOwnerBindingsSnapshotError,
  inspectActiveLarkOwnerBindingsLocally,
  inspectActiveWebOwnerBindingLocally,
  listActiveIdleWebOwnerBindingsLocally,
} from '../src/operator-snapshot.ts'
import { DeliveryStore } from '../src/store.ts'

const roots: string[] = []
afterEach(async () => {
  operatorFsControls.tamperPrivateCopy = false
  operatorFsControls.widenTemporaryDirectory = false
  operatorFsControls.widenTemporaryDirectoryAfterOpen = false
  operatorFsControls.foreignTemporaryOwner = false
  operatorFsControls.lastTemporaryDirectory = null
  sqliteControls.beforeOpen = null
  sqliteControls.afterOpen = null
  raceControls.onSourceRead = null
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function seeded() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'delivery-operator-snapshot-'))); roots.push(root)
  const path = join(root, 'delivery.sqlite'); const store = new DeliveryStore({ path, codeGenerator: () => 'PAIR1234' })
  const principal = { channel: 'web', account: 'profile', tenant: 'local', user: 'operator' }
  const issued = store.issuePairing(principal, { ttlMs: 1_000, maxAttempts: 3 })
  store.confirmPairing({ challengeId: issued.challenge.id, principal, code: issued.code })
  const binding = store.createBinding({ conversation: { channel: 'web', account: 'profile', tenant: 'local', kind: 'dm', chat: 'session-a' }, principal,
    workspace: '/work/a', agentPreset: 'primary', sessionId: 'session-a', policyRef: 'owner-dm' })
  return { path, store, principal, binding }
}

async function larkSeeded() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'delivery-lark-operator-snapshot-'))); roots.push(root)
  const path = join(root, 'delivery.sqlite'); const store = new DeliveryStore({ path, codeGenerator: () => 'PAIR1234' })
  const principal = { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_owner' }
  const issued = store.issuePairing(principal, { ttlMs: 1_000, maxAttempts: 3 })
  store.confirmPairing({ challengeId: issued.challenge.id, principal, code: issued.code })
  const binding = store.createBinding({
    conversation: { channel: 'lark', account: 'primary', tenant: 'personal', kind: 'dm', chat: 'oc_owner' },
    principal, workspace: '/work/owner', agentPreset: 'standard', sessionId: 'owner', policyRef: 'owner-dm',
  })
  return { root, path, store, principal, binding }
}

async function fingerprint(path: string) {
  try {
    const metadata = await stat(path, { bigint: true })
    return { device: metadata.dev, inode: metadata.ino, size: metadata.size, mode: metadata.mode,
      mtimeNs: metadata.mtimeNs, ctimeNs: metadata.ctimeNs, digest: createHash('sha256').update(await readFile(path)).digest('hex') }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function larkQuery(path: string) {
  return { databasePath: path, account: 'primary', tenant: 'personal', workspace: '/work/owner', agentPreset: 'standard' }
}

function expectLarkCode(operation: () => unknown, code: ActiveLarkOwnerBindingsSnapshotError['code']): void {
  expect(operation).toThrowError(expect.objectContaining<Partial<ActiveLarkOwnerBindingsSnapshotError>>({ code }))
}

type RaceAction = 'chmod-parent' | 'swap-parent' | 'utimes-file'

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
      if (workerData.action === 'utimes-file') {
        fs.utimesSync(workerData.paths[0], new Date(), new Date())
      } else if (workerData.action === 'chmod-parent') {
        fs.chmodSync(workerData.paths[0], 0o755)
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
  const waitStatus = Atomics.wait(ready, 0, 0, 5_000)
  if (waitStatus === 'timed-out' || Atomics.load(ready, 0) !== 1) {
    throw new Error('race worker did not reach its ready handshake')
  }
  return { worker, ready, gate, done }
}

function armSourceReadTrigger(race: RaceWorker): void {
  raceControls.onSourceRead = () => {
    raceControls.onSourceRead = null
    Atomics.store(race.gate, 0, 1)
    Atomics.notify(race.gate, 0)
    const status = Atomics.wait(race.done, 0, 0, 5_000)
    if (status === 'timed-out' || Atomics.load(race.done, 0) !== 1) {
      throw new Error('race worker did not complete its triggered mutation')
    }
  }
}

async function finishRaceWorker(race: RaceWorker): Promise<void> {
  await race.worker.terminate()
}

describe('local active Web owner snapshot', () => {
  test('discovers only exact owner idle sessions without changing the database or hiding ambiguity', async () => {
    const fixture = await seeded()
    const query = { databasePath: fixture.path, expectedPrincipal: fixture.principal, workspace: '/work/a', agentPreset: 'primary' }
    const list = () => listActiveIdleWebOwnerBindingsLocally(query)
    const create = (sessionId: string, workspace = '/work/a') => fixture.store.createBinding({
      conversation: { ...fixture.binding.conversation, chat: sessionId }, principal: fixture.principal,
      workspace, agentPreset: 'primary', sessionId, policyRef: 'owner-dm',
    })
    expect(list()).toMatchObject({ status: 'matched', snapshots: [{ binding: { sessionId: 'session-a' } }] })
    const second = create('session-b'); create('foreign-workspace', '/work/b')
    const before = createHash('sha256').update(await readFile(fixture.path)).digest('hex')
    const multiple = list()
    expect(multiple.status === 'matched' && multiple.snapshots.map(value => value.binding.sessionId)).toEqual(['session-a', 'session-b'])
    expect(createHash('sha256').update(await readFile(fixture.path)).digest('hex')).toBe(before)
    const lease = fixture.store.claimSessionLease({ kind: 'bound', binding: second }, 'holder', 10_000)
    expect(list()).toMatchObject({ status: 'matched', snapshots: [{ binding: { sessionId: 'session-a' } }] })
    expect(listActiveIdleWebOwnerBindingsLocally({ ...query, expectedPrincipal: { ...fixture.principal, user: 'other' } })).toEqual({ status: 'matched', snapshots: [] })
    if (lease.kind === 'claimed') fixture.store.finishSessionLease(lease.lease, { quiescent: false })
    const owner = fixture.store.getPrincipal(fixture.principal)!
    fixture.store.revokePrincipal(owner.id, owner.version)
    expect(list()).toEqual({ status: 'matched', snapshots: [] })
    fixture.store.close()
  })

  test('fails discovery closed for missing/private/schema-invalid databases and too many sessions', async () => {
    const fixture = await seeded()
    const query = { databasePath: fixture.path, expectedPrincipal: fixture.principal, workspace: '/work/a', agentPreset: 'primary' }
    expect(listActiveIdleWebOwnerBindingsLocally({ ...query, databasePath: `${fixture.path}.missing` }).status).toBe('unavailable')
    await chmod(fixture.path, 0o644)
    expect(listActiveIdleWebOwnerBindingsLocally(query).status).toBe('unavailable')
    await chmod(fixture.path, 0o600)
    for (let index = 0; index < 100; index++) fixture.store.createBinding({
      conversation: { ...fixture.binding.conversation, chat: `session-${index}` }, principal: fixture.principal,
      workspace: '/work/a', agentPreset: 'primary', sessionId: `session-${index}`, policyRef: 'owner-dm',
    })
    expect(listActiveIdleWebOwnerBindingsLocally(query)).toEqual({ status: 'unavailable', reason: 'too-many-sessions' })
    fixture.store.close()
    const database = new DatabaseSync(fixture.path); database.exec('PRAGMA user_version = 18'); database.close()
    expect(listActiveIdleWebOwnerBindingsLocally(query).status).toBe('unavailable')
    const old = new DatabaseSync(fixture.path, { readOnly: true })
    expect(old.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 18 }); old.close()
  })
  test('reads an exact active owner binding without changing the database', async () => {
    const fixture = await seeded()
    const before = createHash('sha256').update(await readFile(fixture.path)).digest('hex')
    const result = inspectActiveWebOwnerBindingLocally({ databasePath: fixture.path, sessionId: 'session-a', expectedPrincipal: fixture.principal, workspace: '/work/a', agentPreset: 'primary' })
    const after = createHash('sha256').update(await readFile(fixture.path)).digest('hex')
    expect(result).toMatchObject({ status: 'matched', snapshot: { binding: { id: fixture.binding.id, generation: 1 }, owner: { role: 'owner', status: 'active' } } })
    expect(after).toBe(before)
    fixture.store.close()
  })

  test('rejects absent, mismatched, revoked, and non-released session state', async () => {
    const fixture = await seeded()
    const query = { databasePath: fixture.path, sessionId: 'session-a', expectedPrincipal: fixture.principal, workspace: '/work/a', agentPreset: 'primary' }
    expect(inspectActiveWebOwnerBindingLocally({ ...query, sessionId: 'missing' })).toEqual({ status: 'mismatch' })
    expect(inspectActiveWebOwnerBindingLocally({ ...query, workspace: '/other' })).toEqual({ status: 'mismatch' })
    const claim = fixture.store.claimSessionLease({ kind: 'bound', binding: fixture.binding }, 'holder', 10_000)
    expect(inspectActiveWebOwnerBindingLocally(query)).toEqual({ status: 'busy' })
    if (claim.kind === 'claimed') fixture.store.finishSessionLease(claim.lease, { quiescent: true })
    const owner = fixture.store.getPrincipal(fixture.principal)!
    fixture.store.revokePrincipal(owner.id, owner.version)
    expect(inspectActiveWebOwnerBindingLocally(query)).toEqual({ status: 'mismatch' })
    fixture.store.close()
    expect(inspectActiveWebOwnerBindingLocally({ ...query, databasePath: `${fixture.path}.missing` })).toEqual({ status: 'unavailable' })
  })

  test('rejects foreign or non-canonical Web conversation JSON, old schemas, private-mode violations, and unknown leases', async () => {
    const fixture = await seeded()
    const query = { databasePath: fixture.path, sessionId: 'session-a', expectedPrincipal: fixture.principal, workspace: '/work/a', agentPreset: 'primary' }
    const database = new DatabaseSync(fixture.path)
    database.prepare('UPDATE conversation_bindings SET conversation_json = ? WHERE id = ?').run(JSON.stringify({ channel: 'lark', account: 'profile', tenant: 'local', kind: 'dm', chat: 'session-a' }), fixture.binding.id)
    database.close()
    expect(inspectActiveWebOwnerBindingLocally(query)).toEqual({ status: 'mismatch' })
    const repaired = new DatabaseSync(fixture.path)
    repaired.prepare('UPDATE conversation_bindings SET conversation_json = ? WHERE id = ?').run(JSON.stringify({ ...fixture.binding.conversation, ignored: true }), fixture.binding.id)
    repaired.close()
    expect(inspectActiveWebOwnerBindingLocally(query)).toEqual({ status: 'unavailable' })
    const schema = new DatabaseSync(fixture.path); schema.exec('PRAGMA user_version = 18'); schema.close()
    expect(inspectActiveWebOwnerBindingLocally(query)).toEqual({ status: 'unavailable' })
    const current = new DatabaseSync(fixture.path); current.exec('PRAGMA user_version = 20'); current.close()
    await chmod(fixture.path, 0o644)
    expect(inspectActiveWebOwnerBindingLocally(query)).toEqual({ status: 'unavailable' })
    await chmod(fixture.path, 0o600)
    const canonical = new DatabaseSync(fixture.path)
    canonical.prepare('UPDATE conversation_bindings SET conversation_json = ? WHERE id = ?').run(JSON.stringify(fixture.binding.conversation), fixture.binding.id)
    canonical.close()
    const claim = fixture.store.claimSessionLease({ kind: 'bound', binding: fixture.binding }, 'holder', 10_000)
    expect(claim.kind).toBe('claimed')
    if (claim.kind === 'claimed') {
      fixture.store.markSessionLeaseDispatched(claim.lease)
      fixture.store.finishSessionLease(claim.lease, { quiescent: false })
    }
    expect(inspectActiveWebOwnerBindingLocally(query)).toEqual({ status: 'busy' })
    fixture.store.close()
  })
})

describe('side-effect-free active Lark owner snapshot', () => {
  test('returns a versioned, deeply frozen, content-free exact snapshot without changing storage', async () => {
    const fixture = await larkSeeded()
    fixture.store.close()
    const paths = [fixture.path, `${fixture.path}-wal`, `${fixture.path}-shm`, `${fixture.path}-journal`]
    const before = await Promise.all(paths.map(fingerprint))
    const beforeVersionDatabase = new DatabaseSync(`file:${fixture.path}?mode=ro&immutable=1`, { readOnly: true })
    const versionBefore = beforeVersionDatabase.prepare('PRAGMA user_version').get(); beforeVersionDatabase.close()

    const snapshot = inspectActiveLarkOwnerBindingsLocally(larkQuery(fixture.path))

    const afterVersionDatabase = new DatabaseSync(`file:${fixture.path}?mode=ro&immutable=1`, { readOnly: true })
    const versionAfter = afterVersionDatabase.prepare('PRAGMA user_version').get(); afterVersionDatabase.close()
    expect(await Promise.all(paths.map(fingerprint))).toEqual(before)
    expect(versionAfter).toEqual(versionBefore)
    expect(snapshot).toMatchObject({
      protocol: 'assistant-delivery/active-lark-owner-bindings-snapshot/v1', schemaVersion: 20,
      scope: { account: 'primary', tenant: 'personal', workspace: '/work/owner', agentPreset: 'standard' },
      database: { device: expect.any(String), inode: expect.any(String), size: expect.any(String),
        mtimeNs: expect.any(String), digest: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      storageDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      snapshotDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      bindings: [{ ...fixture.binding, owner: { principal: fixture.principal, role: 'owner', status: 'active' } }],
    })
    expect(snapshot.sidecars).toEqual({ wal: null, shm: null })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.scope)).toBe(true)
    expect(Object.isFrozen(snapshot.database)).toBe(true)
    expect(Object.isFrozen(snapshot.sidecars)).toBe(true)
    expect(Object.isFrozen(snapshot.bindings)).toBe(true)
    expect(Object.isFrozen(snapshot.bindings[0])).toBe(true)
    expect(Object.isFrozen(snapshot.bindings[0]?.conversation)).toBe(true)
    expect(Object.isFrozen(snapshot.bindings[0]?.principal)).toBe(true)
    expect(Object.isFrozen(snapshot.bindings[0]?.owner)).toBe(true)
    expect(JSON.stringify(snapshot)).not.toMatch(/message|PAIR1234/iu)
  })

  test('returns none, one, or multiple exact matches in canonical order and excludes the wrong scope', async () => {
    const fixture = await larkSeeded()
    fixture.store.createBinding({
      conversation: { channel: 'lark', account: 'primary', tenant: 'personal', kind: 'dm', chat: 'oc_second' },
      principal: fixture.principal, workspace: '/work/owner', agentPreset: 'standard', sessionId: 'second', policyRef: 'owner-dm',
    })
    fixture.store.createBinding({
      conversation: { channel: 'lark', account: 'primary', tenant: 'personal', kind: 'dm', chat: 'oc_workspace' },
      principal: fixture.principal, workspace: '/work/other', agentPreset: 'standard', sessionId: 'other-workspace', policyRef: 'owner-dm',
    })
    fixture.store.createBinding({
      conversation: { channel: 'lark', account: 'primary', tenant: 'personal', kind: 'dm', chat: 'oc_preset' },
      principal: fixture.principal, workspace: '/work/owner', agentPreset: 'other', sessionId: 'other-preset', policyRef: 'owner-dm',
    })
    fixture.store.createBinding({
      conversation: { channel: 'lark', account: 'primary', tenant: 'personal', kind: 'group', chat: 'oc_group', thread: 'om_root' },
      principal: fixture.principal, workspace: '/work/owner', agentPreset: 'standard', sessionId: 'group', policyRef: 'owner-group',
    })
    fixture.store.close()
    const bindings = inspectActiveLarkOwnerBindingsLocally(larkQuery(fixture.path)).bindings
    expect(bindings).toHaveLength(2)
    expect(bindings.map(binding => binding.id)).toEqual(bindings.map(binding => binding.id).sort())
    expect(bindings.map(binding => binding.sessionId).sort()).toEqual(['owner', 'second'])
    expect(inspectActiveLarkOwnerBindingsLocally({ ...larkQuery(fixture.path), account: 'other' }).bindings).toEqual([])
    expect(inspectActiveLarkOwnerBindingsLocally({ ...larkQuery(fixture.path), tenant: 'other' }).bindings).toEqual([])
    expect(inspectActiveLarkOwnerBindingsLocally({ ...larkQuery(fixture.path), workspace: '/work/missing' }).bindings).toEqual([])
    expect(inspectActiveLarkOwnerBindingsLocally({ ...larkQuery(fixture.path), agentPreset: 'missing' }).bindings).toEqual([])
  })

  test('excludes inactive bindings and non-owner or inactive principals', async () => {
    const inactiveBinding = await larkSeeded(); inactiveBinding.store.close()
    let database = new DatabaseSync(inactiveBinding.path)
    database.prepare(`UPDATE conversation_bindings SET status='revoked' WHERE id=?`).run(inactiveBinding.binding.id); database.close()
    expect(inspectActiveLarkOwnerBindingsLocally(larkQuery(inactiveBinding.path)).bindings).toEqual([])

    const nonOwner = await larkSeeded(); nonOwner.store.close(); database = new DatabaseSync(nonOwner.path)
    database.prepare(`UPDATE delivery_principals SET role='linked', linked_to_id=id WHERE role='owner'`).run(); database.close()
    expect(inspectActiveLarkOwnerBindingsLocally(larkQuery(nonOwner.path)).bindings).toEqual([])

    const inactiveOwner = await larkSeeded(); inactiveOwner.store.close(); database = new DatabaseSync(inactiveOwner.path)
    database.prepare(`UPDATE delivery_principals SET status='revoked' WHERE role='owner'`).run(); database.close()
    expect(inspectActiveLarkOwnerBindingsLocally(larkQuery(inactiveOwner.path)).bindings).toEqual([])
  })

  test('fails closed for missing, corrupt, non-current-schema, symlinked, hardlinked, and non-private storage', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'delivery-lark-operator-invalid-')); roots.push(parent)
    expectLarkCode(() => inspectActiveLarkOwnerBindingsLocally(larkQuery(join(parent, 'missing.sqlite'))), 'database-missing')
    expectLarkCode(() => inspectActiveLarkOwnerBindingsLocally({ ...larkQuery('/relative'), databasePath: 'relative.sqlite' }), 'invalid-path')
    const corrupt = join(parent, 'corrupt.sqlite'); await writeFile(corrupt, 'not sqlite', { mode: 0o600 })
    expectLarkCode(() => inspectActiveLarkOwnerBindingsLocally(larkQuery(corrupt)), 'database-corrupt')

    for (const version of [19, 21]) {
      const path = join(parent, `schema-${version}.sqlite`); const schema = new DatabaseSync(path)
      schema.exec(`PRAGMA user_version=${version}`); schema.close(); await chmod(path, 0o600)
      const before = await fingerprint(path)
      expectLarkCode(() => inspectActiveLarkOwnerBindingsLocally(larkQuery(path)), 'schema-unsupported')
      expect(await fingerprint(path)).toEqual(before)
    }

    const fixture = await larkSeeded(); fixture.store.close()
    const linked = join(fixture.root, 'linked.sqlite'); await symlink(fixture.path, linked)
    expectLarkCode(() => inspectActiveLarkOwnerBindingsLocally(larkQuery(linked)), 'unsafe-path')
    await rm(linked)
    const hardlinked = join(fixture.root, 'hardlinked.sqlite'); await link(fixture.path, hardlinked)
    expect((await lstat(fixture.path)).nlink).toBe(2)
    expectLarkCode(() => inspectActiveLarkOwnerBindingsLocally(larkQuery(fixture.path)), 'unsafe-path')
    await rm(hardlinked); await chmod(fixture.path, 0o640)
    expectLarkCode(() => inspectActiveLarkOwnerBindingsLocally(larkQuery(fixture.path)), 'unsafe-path')
    await chmod(fixture.path, 0o400)
    expectLarkCode(() => inspectActiveLarkOwnerBindingsLocally(larkQuery(fixture.path)), 'unsafe-path')
    await chmod(fixture.path, 0o600); await chmod(fixture.root, 0o750)
    expectLarkCode(() => inspectActiveLarkOwnerBindingsLocally(larkQuery(fixture.path)), 'unsafe-parent')
    await chmod(fixture.root, 0o500)
    expect(inspectActiveLarkOwnerBindingsLocally(larkQuery(fixture.path)).bindings).toHaveLength(1)
    await chmod(fixture.root, 0o4700)
    expectLarkCode(() => inspectActiveLarkOwnerBindingsLocally(larkQuery(fixture.path)), 'unsafe-parent')
    await chmod(fixture.root, 0o700)
    const linkedParent = await mkdtemp(join(tmpdir(), 'delivery-lark-operator-linked-parent-')); roots.push(linkedParent)
    await rm(linkedParent, { recursive: true, force: true })
    await symlink(fixture.root, linkedParent)
    expectLarkCode(
      () => inspectActiveLarkOwnerBindingsLocally(larkQuery(join(linkedParent, 'delivery.sqlite'))),
      'unsafe-path',
    )
    await rm(linkedParent)
  })

  test('reads committed WAL state through a private copy without changing source sidecars', async () => {
    const fixture = await larkSeeded()
    const writer = new DatabaseSync(fixture.path); writer.exec('PRAGMA wal_autocheckpoint=0')
    writer.prepare('UPDATE conversation_bindings SET updated_at=updated_at+1, version=version+1 WHERE id=?').run(fixture.binding.id)
    await chmod(`${fixture.path}-wal`, 0o600); await chmod(`${fixture.path}-shm`, 0o600)
    const paths = [fixture.path, `${fixture.path}-wal`, `${fixture.path}-shm`]
    const before = await Promise.all(paths.map(fingerprint))
    const snapshot = inspectActiveLarkOwnerBindingsLocally(larkQuery(fixture.path))
    expect(snapshot.bindings[0]).toMatchObject({ id: fixture.binding.id, updatedAt: fixture.binding.updatedAt + 1, version: 2 })
    expect(snapshot.sidecars.wal).not.toBeNull(); expect(snapshot.sidecars.shm).not.toBeNull()
    expect(await Promise.all(paths.map(fingerprint))).toEqual(before)
    writer.close(); fixture.store.close()
  })

  test('fails closed when the private copy bytes diverge from the pinned source after writing', async () => {
    const fixture = await larkSeeded()
    const writer = new DatabaseSync(fixture.path); writer.exec('PRAGMA wal_autocheckpoint=0')
    writer.prepare('UPDATE conversation_bindings SET updated_at=updated_at+1, version=version+1 WHERE id=?').run(fixture.binding.id)
    await chmod(`${fixture.path}-wal`, 0o600); await chmod(`${fixture.path}-shm`, 0o600)
    // Forces the writer of the operator's private main-database copy to be
    // followed by a mutation before the byte-for-byte re-open verification.
    operatorFsControls.tamperPrivateCopy = true
    expectLarkCode(() => inspectActiveLarkOwnerBindingsLocally(larkQuery(fixture.path)), 'database-drift')
    operatorFsControls.tamperPrivateCopy = false
    writer.close(); fixture.store.close()
  })

  test('fails closed when the private temporary snapshot directory is not 0700', async () => {
    const fixture = await larkSeeded()
    const writer = new DatabaseSync(fixture.path); writer.exec('PRAGMA wal_autocheckpoint=0')
    writer.prepare('UPDATE conversation_bindings SET updated_at=updated_at+1, version=version+1 WHERE id=?').run(fixture.binding.id)
    await chmod(`${fixture.path}-wal`, 0o600); await chmod(`${fixture.path}-shm`, 0o600)
    // Forces the freshly created private snapshot directory to be group/other
    // readable, simulating a tmpdir with an unexpected umask or tampering.
    operatorFsControls.widenTemporaryDirectory = true
    expectLarkCode(() => inspectActiveLarkOwnerBindingsLocally(larkQuery(fixture.path)), 'unsafe-path')
    operatorFsControls.widenTemporaryDirectory = false
    writer.close(); fixture.store.close()
  })

  test('fails closed when the private temporary snapshot directory is foreign-owned', async () => {
    const fixture = await larkSeeded()
    const writer = new DatabaseSync(fixture.path); writer.exec('PRAGMA wal_autocheckpoint=0')
    writer.prepare('UPDATE conversation_bindings SET updated_at=updated_at+1, version=version+1 WHERE id=?').run(fixture.binding.id)
    await chmod(`${fixture.path}-wal`, 0o600); await chmod(`${fixture.path}-shm`, 0o600)
    // A non-root process cannot really chown, so the lstat result for the
    // temporary directory is stamped with a uid one above the current user.
    operatorFsControls.foreignTemporaryOwner = true
    expectLarkCode(() => inspectActiveLarkOwnerBindingsLocally(larkQuery(fixture.path)), 'unsafe-path')
    operatorFsControls.foreignTemporaryOwner = false
    writer.close(); fixture.store.close()
  })

  test('rechecks temporary directory permissions through the pinned directory descriptor', async () => {
    const fixture = await larkSeeded()
    const writer = new DatabaseSync(fixture.path); writer.exec('PRAGMA wal_autocheckpoint=0')
    writer.prepare('UPDATE conversation_bindings SET updated_at=updated_at+1, version=version+1 WHERE id=?').run(fixture.binding.id)
    await chmod(`${fixture.path}-wal`, 0o600); await chmod(`${fixture.path}-shm`, 0o600)
    operatorFsControls.widenTemporaryDirectoryAfterOpen = true
    expectLarkCode(() => inspectActiveLarkOwnerBindingsLocally(larkQuery(fixture.path)), 'unsafe-path')
    const temporary = operatorFsControls.lastTemporaryDirectory
    if (temporary !== null) await expect(lstat(temporary)).rejects.toMatchObject({ code: 'ENOENT' })
    operatorFsControls.widenTemporaryDirectoryAfterOpen = false
    writer.close(); fixture.store.close()
  })

  test('unsafe-parent overrides a lower-level schema error discovered in the same snapshot', async () => {
    const fixture = await larkSeeded(); fixture.store.close()
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try { await rm(`${fixture.path}${suffix}`, { force: true }) } catch {}
    }
    const invalid = new DatabaseSync(fixture.path)
    invalid.exec('PRAGMA user_version = 18')
    invalid.close(); await chmod(fixture.path, 0o600)
    sqliteControls.afterOpen = () => chmodSync(fixture.root, 0o755)
    try {
      expectLarkCode(() => inspectActiveLarkOwnerBindingsLocally(larkQuery(fixture.path)), 'unsafe-parent')
    } finally {
      sqliteControls.afterOpen = null
      await chmod(fixture.root, 0o700)
    }
  })

  test('rejects an incomplete sidecar set and source drift', async () => {
    const fixture = await larkSeeded(); fixture.store.close()
    await writeFile(`${fixture.path}-wal`, '', { mode: 0o600 })
    expectLarkCode(() => inspectActiveLarkOwnerBindingsLocally(larkQuery(fixture.path)), 'database-drift')
    await rm(`${fixture.path}-wal`)

    // Ensure the operator has a second read window after the worker mutates
    // mtime on the first pinned-source read.
    await truncate(fixture.path, 1024 * 1024)
    const race = startRaceWorker('utimes-file', [fixture.path])
    armSourceReadTrigger(race)
    expectLarkCode(() => inspectActiveLarkOwnerBindingsLocally(larkQuery(fixture.path)), 'database-drift')
    await finishRaceWorker(race)
  })

  test('fails closed with unsafe-parent when the pinned parent mode is widened during the snapshot', async () => {
    const fixture = await larkSeeded(); fixture.store.close()
    // Pad the main file so the pinned hash phase stays open long enough for a
    // concurrent same-UID actor to widen the parent directory mode.
    const padder = new DatabaseSync(fixture.path)
    padder.exec('CREATE TABLE operator_parent_padding (bytes BLOB) STRICT')
    padder.prepare('INSERT INTO operator_parent_padding(bytes) VALUES (zeroblob(?))').run(16 * 1024 * 1024)
    padder.close()
    const race = startRaceWorker('chmod-parent', [fixture.root])
    armSourceReadTrigger(race)
    expectLarkCode(() => inspectActiveLarkOwnerBindingsLocally(larkQuery(fixture.path)), 'unsafe-parent')
    await chmod(fixture.root, 0o700)
    await finishRaceWorker(race)
  })

  test('fails closed when the pinned parent is swapped for a same-name replacement tree mid-snapshot', async () => {
    const fixture = await larkSeeded(); fixture.store.close()
    const padder = new DatabaseSync(fixture.path)
    padder.exec('CREATE TABLE operator_parent_swap_padding (bytes BLOB) STRICT')
    padder.prepare('INSERT INTO operator_parent_swap_padding(bytes) VALUES (zeroblob(?))').run(16 * 1024 * 1024)
    padder.close()
    const replacement = await mkdtemp(join(tmpdir(), 'delivery-parent-replacement-')); roots.push(replacement)
    const moved = `${fixture.root}.old`; roots.push(moved)
    const race = startRaceWorker('swap-parent', [fixture.root, moved, replacement])
    armSourceReadTrigger(race)
    let thrown: ActiveLarkOwnerBindingsSnapshotError | undefined
    try {
      inspectActiveLarkOwnerBindingsLocally(larkQuery(fixture.path))
    } catch (error) {
      thrown = error as ActiveLarkOwnerBindingsSnapshotError
    }
    expect(thrown).toBeInstanceOf(ActiveLarkOwnerBindingsSnapshotError)
    expect(['database-drift', 'unsafe-parent']).toContain(thrown!.code)
    await finishRaceWorker(race)
  })

  test('H1: full parent ABA around the SQLite open cannot make the snapshot read a same-name malicious database', async () => {
    const fixture = await larkSeeded(); fixture.store.close()
    // Non-WAL source: close the last connection and clear any sidecars so the
    // operator takes the direct source-fd path.
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try { await rm(`${fixture.path}${suffix}`, { force: true }) } catch {}
    }
    // A valid, same-schema, private delivery database with NO bindings. Read via
    // a path-based open it would yield an empty inventory; the pinned original
    // must instead yield the real binding.
    const evil = await mkdtemp(join(tmpdir(), 'delivery-aba-evil-')); roots.push(evil)
    const evilStore = new DeliveryStore({
      path: join(evil, 'delivery.sqlite'), codeGenerator: () => 'EVIL1234',
    }); evilStore.close()
    await chmod(join(evil, 'delivery.sqlite'), 0o600)
    const original = fixture.root
    const moved = `${original}.aba-old`; const evilBack = `${original}.aba-evil`
    roots.push(moved, evilBack)
    sqliteControls.beforeOpen = () => {
      renameSync(original, moved); renameSync(evil, original)
    }
    sqliteControls.afterOpen = () => {
      renameSync(original, evilBack); renameSync(moved, original)
    }
    let snapshot
    try {
      snapshot = inspectActiveLarkOwnerBindingsLocally(larkQuery(fixture.path))
    } finally {
      sqliteControls.beforeOpen = null; sqliteControls.afterOpen = null
    }
    // The result provably came from the pinned inode, never the empty malicious
    // database that occupied the path only during the open.
    expect(snapshot.bindings).toHaveLength(1)
    expect(snapshot.bindings[0]?.id).toBe(fixture.binding.id)
  })
})
