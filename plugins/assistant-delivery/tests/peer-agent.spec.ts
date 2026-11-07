import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { DeliveryStore, DeliveryStoreError } from '../src/store.ts'
import type { ExternalPrincipalKey } from '../src/types.ts'

const roots: string[] = []
const owner: ExternalPrincipalKey = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner' }
const peer: ExternalPrincipalKey = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_peer_bot' }

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-peer-'))
  roots.push(root)
  const store = new DeliveryStore({ path: join(root, 'delivery.sqlite'), now: () => 1_000,
    codeGenerator: () => 'ABCD2345' })
  const issued = store.issuePairing(owner, { ttlMs: 5_000, maxAttempts: 3 })
  const ownerRecord = store.confirmPairing({ challengeId: issued.challenge.id, principal: owner, code: issued.code })
  return { store, ownerRecord }
}

describe('explicit peer-agent principal', () => {
  test('links an allowlisted peer bot to the active owner without granting owner role', async () => {
    const { store, ownerRecord } = await fixture()
    expect(store.activeOwnerPrincipal()?.id).toBe(ownerRecord.id)
    expect(store.isAuthorizedPrincipal(peer)).toBe(false)
    const linked = store.ensurePeerPrincipal(peer, ownerRecord.id)
    expect(linked).toMatchObject({ role: 'linked', status: 'active', principal: peer,
      linkedToId: ownerRecord.id })
    expect(store.isAuthorizedPrincipal(peer)).toBe(true)
    // Idempotent: the same configured peer is reused, never duplicated.
    expect(store.ensurePeerPrincipal(peer, ownerRecord.id).id).toBe(linked.id)
    // It remains a linked principal, not a second owner.
    expect(store.activeOwnerPrincipal()?.id).toBe(ownerRecord.id)
    store.close()
  })

  test('refuses a peer when owner authority is absent or the row is revoked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-peer-'))
    roots.push(root)
    const store = new DeliveryStore({ path: join(root, 'delivery.sqlite'), now: () => 1_000 })
    expect(store.activeOwnerPrincipal()).toBeUndefined()
    expect(() => store.ensurePeerPrincipal(peer, 'missing-owner'))
      .toThrowError(expect.objectContaining<Partial<DeliveryStoreError>>({ code: 'unauthorized-principal' }))
    store.close()

    const { store: owned, ownerRecord } = await fixture()
    const linked = owned.ensurePeerPrincipal(peer, ownerRecord.id)
    owned.revokePrincipal(linked.id, linked.version)
    expect(() => owned.ensurePeerPrincipal(peer, ownerRecord.id))
      .toThrowError(expect.objectContaining<Partial<DeliveryStoreError>>({ code: 'unauthorized-principal' }))
    owned.close()
  })
})
