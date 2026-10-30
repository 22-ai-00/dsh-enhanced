import { createHash } from 'node:crypto'
import { chmod, link, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { renameSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { canonicalOwnerRouteAuthority, externalPrincipalId, ownerRouteAuthorityHash } from '../src/canonical.ts'
import {
  ActiveLarkOwnerBindingsSnapshotError,
  inspectRevokedOwnerRouteLocally,
  revokedOwnerRouteSnapshotProtocol,
  type RevokedOwnerRouteQuery,
} from '../src/operator-snapshot.ts'
import { DeliveryStore } from '../src/store.ts'
import type { OwnerRouteAuthority } from '../src/types.ts'

// Only the two race tests enable these hooks; all database reads are real SQLite.
const sqliteControls = vi.hoisted(() => ({ beforeOpen: null as null | (() => void), afterOpen: null as null | (() => void) }))
vi.mock('node:sqlite', async importOriginal => {
  const actual = await importOriginal<typeof import('node:sqlite')>()
  return { ...actual, DatabaseSync: new Proxy(actual.DatabaseSync, {
    construct(target, args) {
      sqliteControls.beforeOpen?.()
      const instance = Reflect.construct(target, args)
      sqliteControls.afterOpen?.()
      return instance
    },
  }) }
})

const roots: string[] = []
const stores = new Set<DeliveryStore>()
const principal = { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_owner' }
const authority: OwnerRouteAuthority = {
  id: 'owner-route', conversation: { channel: 'lark', account: 'primary', tenant: 'personal', kind: 'dm', chat: 'oc_owner' },
  principal, workspace: '/work/owner', agentPreset: 'standard', policyRef: 'owner-dm', minimumGeneration: 1,
}

afterEach(async () => {
  sqliteControls.beforeOpen = null; sqliteControls.afterOpen = null
  for (const store of stores) store.close()
  stores.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function seeded(options: { active?: boolean; open?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'delivery-revoked-owner-snapshot-'))); roots.push(root)
  const path = join(root, 'delivery.sqlite')
  const store = new DeliveryStore({ path, codeGenerator: () => 'PAIR1234' })
  stores.add(store)
  const issued = store.issuePairing(principal, { ttlMs: 1_000, maxAttempts: 3 })
  const owner = store.confirmPairing({ challengeId: issued.challenge.id, principal, code: issued.code })
  if (!options.active) store.revokePrincipal(owner.id, owner.version)
  if (!options.open) { store.close(); stores.delete(store) }
  const query: RevokedOwnerRouteQuery = { databasePath: path, authority, principalRecordId: owner.id, frozenPrincipalVersion: owner.version }
  return { root, path, query, store }
}

function mutate(path: string, sql: string, ...parameters: Array<string | number>) {
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: false })
  try { database.prepare(sql).run(...parameters) } finally { database.close() }
}

function expectCode(operation: () => unknown, code: ActiveLarkOwnerBindingsSnapshotError['code']) {
  expect(operation).toThrowError(expect.objectContaining({ name: 'ActiveLarkOwnerBindingsSnapshotError', code,
    message: 'delivery revoked owner snapshot: inspection failed' }))
}

async function fingerprint(path: string) {
  try {
    const entry = await stat(path, { bigint: true })
    return { device: entry.dev, inode: entry.ino, size: entry.size, mode: entry.mode, mtimeNs: entry.mtimeNs,
      ctimeNs: entry.ctimeNs, digest: createHash('sha256').update(await readFile(path)).digest('hex') }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function storagePaths(path: string) { return [path, `${path}-wal`, `${path}-shm`, `${path}-journal`] }
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

describe('side-effect-free revoked owner route snapshot', () => {
  test.each([false, true])('proves revoked version 2 vs frozen 1 without any binding; live WAL=%s', async open => {
    const fixture = await seeded({ open })
    const paths = storagePaths(fixture.path)
    const before = await Promise.all(paths.map(fingerprint))
    const snapshot = inspectRevokedOwnerRouteLocally(fixture.query)
    expect(snapshot).toMatchObject({ protocol: revokedOwnerRouteSnapshotProtocol, schemaVersion: 27,
      authority: canonicalOwnerRouteAuthority(authority), frozenPrincipalVersion: 1,
      state: { status: 'revoked', authorityId: authority.id, authorityHash: ownerRouteAuthorityHash(authority),
        principalId: externalPrincipalId(principal), principalRecordId: fixture.query.principalRecordId, principalVersion: 2 },
      storageDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(snapshot.database.digest).toBe(before[0]!.digest)
    expect(snapshot.sidecars.wal === null).toBe(!open)
    expect(snapshot.sidecars.shm === null).toBe(!open)
    const { snapshotDigest, ...unsigned } = snapshot
    expect(snapshotDigest).toBe(createHash('sha256').update(canonicalJson(unsigned)).digest('hex'))
    const checkFrozen = (value: unknown) => {
      if (value === null || typeof value !== 'object') return
      expect(Object.isFrozen(value)).toBe(true)
      Object.values(value).forEach(checkFrozen)
    }
    checkFrozen(snapshot)
    expect(JSON.stringify(snapshot)).not.toMatch(/PAIR1234|binding|message|session/iu)
    expect(await Promise.all(paths.map(fingerprint))).toEqual(before)
  })

  test('canonicalizes trusted frozen authority without changing caller configuration', async () => {
    const fixture = await seeded()
    const inputAuthority = { ...authority, id: ' owner-route ', principal: { ...principal, user: ' ou_owner ' },
      workspace: ' /work/owner ', agentPreset: ' standard ', policyRef: ' owner-dm ' }
    const before = JSON.stringify(inputAuthority)
    expect(inspectRevokedOwnerRouteLocally({ ...fixture.query, authority: inputAuthority }).authority).toEqual(authority)
    expect(JSON.stringify(inputAuthority)).toBe(before)
    expect(Object.isFrozen(inputAuthority)).toBe(false)
  })

  test.each([
    { id: 'other-route' }, { conversation: { ...authority.conversation, chat: 'oc_other' } },
    { workspace: '/work/other' }, { agentPreset: 'other' }, { policyRef: 'other' }, { minimumGeneration: 2 },
  ])('binds the complete canonical route digest: %j', async change => {
    const fixture = await seeded()
    const first = inspectRevokedOwnerRouteLocally(fixture.query)
    const changedAuthority = { ...authority, ...change }
    const second = inspectRevokedOwnerRouteLocally({ ...fixture.query, authority: changedAuthority })
    expect(second.authority).toEqual(changedAuthority)
    expect(second.state.authorityHash).toBe(ownerRouteAuthorityHash(changedAuthority))
    expect(second.state.authorityHash).not.toBe(first.state.authorityHash)
    expect(second.snapshotDigest).not.toBe(first.snapshotDigest)
    expect(second.storageDigest).toBe(first.storageDigest)
  })

  test('rejects an active owner, even if there is no binding', async () => {
    const fixture = await seeded({ active: true })
    expectCode(() => inspectRevokedOwnerRouteLocally(fixture.query), 'owner-not-revoked')
  })

  test('rejects missing exact record and a different principal', async () => {
    const fixture = await seeded()
    expectCode(() => inspectRevokedOwnerRouteLocally({ ...fixture.query, principalRecordId: 'principal_00000000' }), 'owner-not-revoked')
    expectCode(() => inspectRevokedOwnerRouteLocally({ ...fixture.query,
      authority: { ...authority, principal: { ...principal, user: 'ou_other' } } }), 'owner-not-revoked')
  })

  test.each(["role='linked', linked_to_id=id", 'linked_to_id=id'])('rejects linked owner lineage: %s', async assignments => {
    const fixture = await seeded()
    mutate(fixture.path, `UPDATE delivery_principals SET ${assignments}`)
    expectCode(() => inspectRevokedOwnerRouteLocally(fixture.query), 'owner-not-revoked')
  })

  test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid frozen version %s', async frozenPrincipalVersion => {
    const fixture = await seeded()
    expectCode(() => inspectRevokedOwnerRouteLocally({ ...fixture.query, frozenPrincipalVersion }), 'invalid-scope')
  })

  test('accepts equal observed/frozen versions, rejects an older observed version, and binds frozen version', async () => {
    const fixture = await seeded()
    const first = inspectRevokedOwnerRouteLocally(fixture.query)
    const equal = inspectRevokedOwnerRouteLocally({ ...fixture.query, frozenPrincipalVersion: 2 })
    expect(equal.state.principalVersion).toBe(2)
    expect(equal.snapshotDigest).not.toBe(first.snapshotDigest)
    expectCode(() => inspectRevokedOwnerRouteLocally({ ...fixture.query, frozenPrincipalVersion: 3 }), 'owner-not-revoked')
  })

  test.each(['', 'principal_bad', ' principal_00000000 ', 'secret_record'])('rejects invalid exact record id %s', async principalRecordId => {
    const fixture = await seeded()
    expectCode(() => inspectRevokedOwnerRouteLocally({ ...fixture.query, principalRecordId }), 'invalid-scope')
  })

  test.each([
    { ...authority, minimumGeneration: 0 }, { ...authority, hidden: 'secret' },
    { ...authority, conversation: { ...authority.conversation, tenant: 'other' } },
  ])('rejects invalid full authority %j', async invalidAuthority => {
    const fixture = await seeded()
    expectCode(() => inspectRevokedOwnerRouteLocally({ ...fixture.query, authority: invalidAuthority }), 'invalid-scope')
  })

  test.each([
    ` ${JSON.stringify(principal)}`, JSON.stringify({ user: principal.user, channel: principal.channel, account: principal.account, tenant: principal.tenant }),
    JSON.stringify({ ...principal, user: ' ou_owner ' }), JSON.stringify({ ...principal, hidden: 'secret-content' }),
  ])('rejects noncanonical durable principal JSON', async principalJson => {
    const fixture = await seeded()
    mutate(fixture.path, 'UPDATE delivery_principals SET principal_json=?, key_hash=?', principalJson,
      createHash('sha256').update(principalJson).digest('hex'))
    expectCode(() => inspectRevokedOwnerRouteLocally(fixture.query), 'database-corrupt')
  })

  test('rejects an inconsistent durable key hash', async () => {
    const fixture = await seeded()
    mutate(fixture.path, 'UPDATE delivery_principals SET key_hash=?', '0'.repeat(64))
    expectCode(() => inspectRevokedOwnerRouteLocally(fixture.query), 'database-corrupt')
  })

  test.each(['version=9007199254740992', 'created_at=-1', 'updated_at=created_at-1'])('rejects invalid durable metadata: %s', async assignments => {
    const fixture = await seeded()
    mutate(fixture.path, `UPDATE delivery_principals SET ${assignments}`)
    expectCode(() => inspectRevokedOwnerRouteLocally(fixture.query), 'database-corrupt')
  })

  test.each([23, 24, 25, 26, 27])('reads reviewed owner table schema %s without changing bytes', async version => {
    const fixture = await seeded()
    mutate(fixture.path, `PRAGMA user_version=${version}`)
    const before = await Promise.all(storagePaths(fixture.path).map(fingerprint))
    expect(inspectRevokedOwnerRouteLocally(fixture.query).schemaVersion).toBe(version)
    expect(await Promise.all(storagePaths(fixture.path).map(fingerprint))).toEqual(before)
  })

  test.each([22, 28])('rejects unreviewed schema %s', async version => {
    const fixture = await seeded()
    mutate(fixture.path, `PRAGMA user_version=${version}`)
    expectCode(() => inspectRevokedOwnerRouteLocally(fixture.query), 'schema-unsupported')
  })

  test('rejects a corrupt database, failed quick_check and foreign key violations', async () => {
    const corrupt = await seeded()
    await writeFile(corrupt.path, 'secret-content', { mode: 0o600 })
    expectCode(() => inspectRevokedOwnerRouteLocally(corrupt.query), 'database-corrupt')
    const check = await seeded()
    const database = new DatabaseSync(check.path)
    try { database.exec('PRAGMA ignore_check_constraints=ON; UPDATE delivery_principals SET version=0') } finally { database.close() }
    expectCode(() => inspectRevokedOwnerRouteLocally(check.query), 'database-corrupt')
    const foreign = await seeded()
    mutate(foreign.path, "UPDATE delivery_principals SET linked_to_id='principal_00000000'")
    expectCode(() => inspectRevokedOwnerRouteLocally(foreign.query), 'database-corrupt')
  })

  test('rejects missing and noncanonical paths without creating a database', async () => {
    const fixture = await seeded()
    expectCode(() => inspectRevokedOwnerRouteLocally({ ...fixture.query, databasePath: join(fixture.root, 'missing.sqlite') }), 'database-missing')
    expectCode(() => inspectRevokedOwnerRouteLocally({ ...fixture.query, databasePath: 'delivery.sqlite' }), 'invalid-path')
    expect(await fingerprint(join(fixture.root, 'missing.sqlite'))).toBeNull()
  })

  test('rejects symlinks, hardlinks, nonprivate source and nonprivate parent', async () => {
    const fixture = await seeded()
    const symbolic = join(fixture.root, 'linked.sqlite'); await symlink(fixture.path, symbolic)
    expectCode(() => inspectRevokedOwnerRouteLocally({ ...fixture.query, databasePath: symbolic }), 'unsafe-path')
    const hard = join(fixture.root, 'hard.sqlite'); await link(fixture.path, hard)
    expectCode(() => inspectRevokedOwnerRouteLocally(fixture.query), 'unsafe-path')
    await rm(hard)
    await chmod(fixture.path, 0o640)
    expectCode(() => inspectRevokedOwnerRouteLocally(fixture.query), 'unsafe-path')
    await chmod(fixture.path, 0o600); await chmod(fixture.root, 0o750)
    expectCode(() => inspectRevokedOwnerRouteLocally(fixture.query), 'unsafe-parent')
  })

  test('rejects rollback journal, incomplete WAL set, and unsafe sidecars', async () => {
    const fixture = await seeded()
    await writeFile(`${fixture.path}-journal`, '', { mode: 0o600 })
    expectCode(() => inspectRevokedOwnerRouteLocally(fixture.query), 'database-busy')
    await rm(`${fixture.path}-journal`)
    await writeFile(`${fixture.path}-wal`, '', { mode: 0o600 })
    expectCode(() => inspectRevokedOwnerRouteLocally(fixture.query), 'database-drift')
    await rm(`${fixture.path}-wal`)
    await symlink(fixture.path, `${fixture.path}-wal`)
    expectCode(() => inspectRevokedOwnerRouteLocally(fixture.query), 'unsafe-path')
  })

  test('rejects source drift during the read', async () => {
    const fixture = await seeded()
    sqliteControls.afterOpen = () => utimesSync(fixture.path, new Date(0), new Date(0))
    expectCode(() => inspectRevokedOwnerRouteLocally(fixture.query), 'database-drift')
  })

  test.skipIf(process.platform !== 'linux')('binds the original database inode across a full pathname ABA', async () => {
    const fixture = await seeded()
    const replacement = await seeded({ active: true })
    const held = `${fixture.root}.held`
    sqliteControls.beforeOpen = () => {
      renameSync(fixture.root, held); renameSync(replacement.root, fixture.root)
    }
    sqliteControls.afterOpen = () => {
      renameSync(fixture.root, replacement.root); renameSync(held, fixture.root)
    }
    // A path-only reader would inspect the replacement active/missing record.
    expect(inspectRevokedOwnerRouteLocally(fixture.query).state.status).toBe('revoked')
  })
})
