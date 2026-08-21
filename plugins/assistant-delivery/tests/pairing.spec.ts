import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { DeliveryStore, DeliveryStoreError } from '../src/store.ts'
import type { ExternalPrincipalKey } from '../src/types.ts'

const roots: string[] = []
const principal: ExternalPrincipalKey = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner' }

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(options: { now?: number; codes?: string[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-pairing-'))
  roots.push(root)
  let now = options.now ?? 1_000
  const codes = [...(options.codes ?? ['ABCD2345'])]
  const path = join(root, 'delivery.sqlite')
  const store = new DeliveryStore({ path, now: () => now, codeGenerator: () => codes.shift() ?? 'ZZZZ9999' })
  return { path, store, setNow(value: number) { now = value } }
}

describe('owner pairing', () => {
  test('starts fail-closed and stores only a salted code hash', async () => {
    const { path, store } = await fixture()
    expect(store.isAuthorizedPrincipal(principal)).toBe(false)
    const issued = store.issuePairing(principal, { ttlMs: 5_000, maxAttempts: 3 })
    expect(issued).toMatchObject({ code: 'ABCD2345', challenge: { status: 'active', attempts: 0, expiresAt: 6_000 } })
    const raw = new DatabaseSync(path)
    expect(JSON.stringify(raw.prepare('SELECT * FROM pairing_challenges').get())).not.toContain('ABCD2345')
    raw.close()
    expect(store.isAuthorizedPrincipal(principal)).toBe(false)
    store.close()
  })

  test('consumes a valid code once and survives restart', async () => {
    const { path, store } = await fixture()
    const issued = store.issuePairing(principal, { ttlMs: 5_000, maxAttempts: 3 })
    const owner = store.confirmPairing({ challengeId: issued.challenge.id, principal, code: issued.code })
    expect(owner).toMatchObject({ role: 'owner', status: 'active', principal })
    expect(store.isAuthorizedPrincipal(principal)).toBe(true)
    expect(() => store.confirmPairing({ challengeId: issued.challenge.id, principal, code: issued.code }))
      .toThrowError(expect.objectContaining<Partial<DeliveryStoreError>>({ code: 'pairing-replayed' }))
    store.close()
    const reopened = new DeliveryStore({ path })
    expect(reopened.isAuthorizedPrincipal(principal)).toBe(true)
    reopened.close()
  })

  test('locks after bounded failures and expires at the exact deadline', async () => {
    const first = await fixture({ codes: ['WRONG999'] })
    const issued = first.store.issuePairing(principal, { ttlMs: 5_000, maxAttempts: 2 })
    expect(() => first.store.confirmPairing({ challengeId: issued.challenge.id, principal, code: 'BAD00001' }))
      .toThrowError(expect.objectContaining({ code: 'pairing-invalid' }))
    expect(() => first.store.confirmPairing({ challengeId: issued.challenge.id, principal, code: 'BAD00002' }))
      .toThrowError(expect.objectContaining({ code: 'pairing-locked' }))
    expect(() => first.store.confirmPairing({ challengeId: issued.challenge.id, principal, code: 'WRONG999' }))
      .toThrowError(expect.objectContaining({ code: 'pairing-locked' }))
    first.store.close()

    const second = await fixture({ now: 10_000 })
    const expiring = second.store.issuePairing(principal, { ttlMs: 100, maxAttempts: 3 })
    second.setNow(10_100)
    expect(() => second.store.confirmPairing({ challengeId: expiring.challenge.id, principal, code: expiring.code }))
      .toThrowError(expect.objectContaining({ code: 'pairing-expired' }))
    second.store.close()
  })

  test('binds a challenge to the exact account, tenant, and user', async () => {
    const { store } = await fixture()
    const issued = store.issuePairing(principal, { ttlMs: 5_000, maxAttempts: 3 })
    for (const changed of [
      { ...principal, account: 'bot-2' }, { ...principal, tenant: 'tenant-b' }, { ...principal, user: 'ou_other' },
    ]) {
      expect(() => store.confirmPairing({ challengeId: issued.challenge.id, principal: changed, code: issued.code }))
        .toThrowError(expect.objectContaining({ code: 'pairing-principal-mismatch' }))
    }
    store.close()
  })

  test('revocation fails closed', async () => {
    const { store } = await fixture()
    const issued = store.issuePairing(principal, { ttlMs: 5_000, maxAttempts: 3 })
    const owner = store.confirmPairing({ challengeId: issued.challenge.id, principal, code: issued.code })
    store.revokePrincipal(owner.id, owner.version)
    expect(store.isAuthorizedPrincipal(principal)).toBe(false)
    store.close()
  })

  test('links cross-platform principals only through an explicit owner operation', async () => {
    const { store } = await fixture({ codes: ['OWNER123', 'LINKED12'] })
    const ownerCode = store.issuePairing(principal, { ttlMs: 5_000, maxAttempts: 3 })
    const owner = store.confirmPairing({ challengeId: ownerCode.challenge.id, principal, code: ownerCode.code })
    const telegram = { channel: 'telegram', account: 'bot-tg', tenant: 'personal', user: 'tg_123' }
    const linkedCode = store.issuePairing(telegram, { ttlMs: 5_000, maxAttempts: 3 })
    const linked = store.confirmPairing({ challengeId: linkedCode.challenge.id, principal: telegram, code: linkedCode.code })
    expect(linked.linkedToId).toBeUndefined()
    expect(store.linkPrincipal({ owner: principal, linked: telegram, expectedLinkedVersion: linked.version }))
      .toMatchObject({ role: 'linked', linkedToId: owner.id, version: linked.version + 1 })
    expect(() => store.linkPrincipal({ owner: telegram, linked: principal, expectedLinkedVersion: owner.version }))
      .toThrowError(expect.objectContaining({ code: 'unauthorized-principal' }))
    store.close()
  })
})
