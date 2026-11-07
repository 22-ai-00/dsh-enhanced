import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantDeliveryService } from '../src/service.ts'
import { DeliveryStore, DeliveryStoreError } from '../src/store.ts'
import type { ExternalPrincipalKey, InboundEnvelope } from '../src/types.ts'

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
    // The live allowlist is re-read for every bot message; an explicit
    // reauthorization re-links the same tuple to the current owner.
    expect(owned.ensurePeerPrincipal(peer, ownerRecord.id, { reauthorize: true }))
      .toMatchObject({ role: 'linked', status: 'active', linkedToId: ownerRecord.id })
    owned.close()
  })
})

async function serviceFixture(root: string, peers: readonly ExternalPrincipalKey[]) {
  const ctx = new Context()
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, `policy-${peers.length}.sqlite`),
    rules: [
      { id: 'local-pair', effect: 'allow', subject: { kind: 'external', id: 'local:test' },
        actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
      { id: 'owner-pair', effect: 'allow', subject: { kind: 'external', id: 'lark/bot-1/tenant-a/ou_owner' },
        actions: ['pair.confirm'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['external'] } },
      { id: 'ingest', effect: 'allow', subject: { kind: 'external', id: 'lark/bot-1/tenant-a/*' },
        actions: ['ingest'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
    ],
  })
  await ctx.plugin(AssistantDeliveryService, {
    databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'), schedulerEnabled: false,
    peerAgents: peers.map(item => ({ channel: item.channel, account: item.account, tenant: item.tenant, user: item.user })),
  })
  const service = ctx.assistantDelivery
  const store = (service as unknown as { deliveryStore: DeliveryStore }).deliveryStore
  if (!store.isAuthorizedPrincipal(owner)) {
    const challenge = service.issuePairing('test', owner)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal: owner, code: challenge.code })
  }
  return { ctx, service, store }
}

function peerEnvelope(eventId: string): InboundEnvelope {
  return { channel: 'lark', account: 'bot-1', eventId, occurredAt: 1_700_000_000_000,
    principal: { ...peer }, conversation: { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm', chat: 'oc_peer' },
    kind: 'text', text: 'hello', metadata: { senderIsBot: 'true' } }
}

describe('live peer allowlist admission', () => {
  test('re-reads the allowlist for every bot message, even after the principal was activated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-peer-service-'))
    roots.push(root)
    const first = await serviceFixture(root, [peer])
    const admitted = await first.service.acceptInbound(peerEnvelope('evt-peer-1'))
    expect(first.store.getInbox(admitted.inboxId)?.failureCode).not.toBe('unauthorized-principal')
    await first.ctx.fiber.dispose()

    // Same active linked principal, but the current allowlist no longer names
    // it. The next message must be rejected rather than inheriting the old row.
    const second = await serviceFixture(root, [])
    const rejected = await second.service.acceptInbound(peerEnvelope('evt-peer-2'))
    expect(rejected.status).toBe('dead_letter')
    expect(second.store.getInbox(rejected.inboxId)?.failureCode).toBe('unauthorized-principal')
    await second.ctx.fiber.dispose()
  })
})
