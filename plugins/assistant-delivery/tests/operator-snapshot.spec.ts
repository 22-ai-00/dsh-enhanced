import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { inspectActiveWebOwnerBindingLocally, listActiveIdleWebOwnerBindingsLocally } from '../src/operator-snapshot.ts'
import { DeliveryStore } from '../src/store.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function seeded() {
  const root = await mkdtemp(join(tmpdir(), 'delivery-operator-snapshot-')); roots.push(root)
  const path = join(root, 'delivery.sqlite'); const store = new DeliveryStore({ path, codeGenerator: () => 'PAIR1234' })
  const principal = { channel: 'web', account: 'profile', tenant: 'local', user: 'operator' }
  const issued = store.issuePairing(principal, { ttlMs: 1_000, maxAttempts: 3 })
  store.confirmPairing({ challengeId: issued.challenge.id, principal, code: issued.code })
  const binding = store.createBinding({ conversation: { channel: 'web', account: 'profile', tenant: 'local', kind: 'dm', chat: 'session-a' }, principal,
    workspace: '/work/a', agentPreset: 'primary', sessionId: 'session-a', policyRef: 'owner-dm' })
  return { path, store, principal, binding }
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
    const current = new DatabaseSync(fixture.path); current.exec('PRAGMA user_version = 19'); current.close()
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
