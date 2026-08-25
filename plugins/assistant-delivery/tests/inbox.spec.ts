import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { DeliveryStore } from '../src/store.ts'
import type { InboundEnvelope } from '../src/types.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-inbox-'))
  roots.push(root)
  let now = 1_000
  const store = new DeliveryStore({ path: join(root, 'delivery.sqlite'), now: () => now, codeGenerator: () => 'PAIR1234' })
  const principal = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner' }
  const conversation = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm' as const, chat: 'oc_owner' }
  const issued = store.issuePairing(principal, { ttlMs: 5_000, maxAttempts: 3 })
  store.confirmPairing({ challengeId: issued.challenge.id, principal, code: issued.code })
  const binding = store.createBinding({ conversation, principal, workspace: '/work/alpha', agentPreset: 'primary',
    sessionId: 'session-1', policyRef: 'owner-dm' })
  return { binding, principal, conversation, store, setNow(value: number) { now = value } }
}

function envelope(eventId: string, value: Awaited<ReturnType<typeof fixture>>, text = 'hello'): InboundEnvelope {
  return { channel: 'lark', account: 'bot-1', eventId, occurredAt: 900, principal: value.principal,
    conversation: value.conversation, kind: 'text', text, metadata: { source: 'websocket' } }
}

function addBinding(value: Awaited<ReturnType<typeof fixture>>, index: number) {
  const principal = { ...value.principal, user: `ou_batch_${index}` }
  const issued = value.store.issuePairing(principal, { ttlMs: 5_000, maxAttempts: 3 })
  value.store.confirmPairing({ challengeId: issued.challenge.id, principal, code: issued.code })
  const conversation = { ...value.conversation, chat: `oc_batch_${index}` }
  const binding = value.store.createBinding({ conversation, principal, workspace: `/work/batch-${index}`,
    agentPreset: 'primary', sessionId: `session-batch-${index}`, policyRef: 'owner-dm' })
  return { binding, conversation, principal }
}

describe('durable inbox', () => {
  test('deduplicates exact provider events and conflicts on changed payload', async () => {
    const f = await fixture()
    const first = f.store.acceptInbound(envelope('evt-1', f))
    expect(first).toMatchObject({ duplicate: false, record: { status: 'received', eventId: 'evt-1' } })
    expect(f.store.acceptInbound(envelope('evt-1', f))).toEqual({ duplicate: true, record: first.record })
    expect(() => f.store.acceptInbound(envelope('evt-1', f, 'changed')))
      .toThrowError(expect.objectContaining({ code: 'idempotency-conflict' }))
    f.store.close()
  })

  test('rejects namespace confusion, oversize content, and unbounded metadata', async () => {
    const f = await fixture()
    expect(() => f.store.acceptInbound({ ...envelope('evt-1', f), account: 'bot-2' }))
      .toThrowError(expect.objectContaining({ code: 'invalid-envelope' }))
    expect(() => f.store.acceptInbound(envelope('evt-2', f, 'x'.repeat(65_537))))
      .toThrowError(expect.objectContaining({ code: 'invalid-envelope' }))
    expect(() => f.store.acceptInbound({ ...envelope('evt-3', f), metadata: Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`k${index}`, 'v']),
    ) })).toThrowError(expect.objectContaining({ code: 'invalid-envelope' }))
    f.store.close()
  })

  test('persists bounded attachment descriptors as quarantined metadata before any download', async () => {
    const f = await fixture()
    const accepted = f.store.acceptInbound({
      ...envelope('evt-attachment', f),
      attachments: [
        { resourceType: 'file', providerRef: 'file_1', fileName: 'report.pdf' },
        { resourceType: 'image', providerRef: 'image_1' },
      ],
    })
    expect(f.store.listAttachments({ ownerKind: 'inbox', ownerId: accepted.record.id })).toEqual([
      expect.objectContaining({ ownerId: accepted.record.id, resourceType: 'file', providerRef: 'file_1',
        fileName: 'report.pdf', status: 'metadata' }),
      expect.objectContaining({ ownerId: accepted.record.id, resourceType: 'image', providerRef: 'image_1',
        status: 'metadata' }),
    ])
    expect(f.store.acceptInbound({
      ...envelope('evt-attachment', f),
      attachments: [
        { resourceType: 'file', providerRef: 'file_1', fileName: 'report.pdf' },
        { resourceType: 'image', providerRef: 'image_1' },
      ],
    })).toMatchObject({ duplicate: true, record: { id: accepted.record.id } })
    expect(f.store.listAttachments({ ownerKind: 'inbox', ownerId: accepted.record.id })).toHaveLength(2)
    f.store.close()
  })

  test('rejects unbounded or malformed attachment descriptors without partial inbox state', async () => {
    const f = await fixture()
    expect(() => f.store.acceptInbound({
      ...envelope('evt-too-many-files', f),
      attachments: Array.from({ length: 11 }, (_, index) => ({ resourceType: 'file' as const,
        providerRef: `file_${index}` })),
    })).toThrowError(expect.objectContaining({ code: 'invalid-envelope' }))
    expect(() => f.store.acceptInbound({
      ...envelope('evt-bad-file', f),
      attachments: [{ resourceType: 'file', providerRef: '../escape', fileName: 'bad\0name' }],
    })).toThrowError(expect.objectContaining({ code: 'invalid-envelope' }))
    expect(f.store.getInboxByProviderEvent('lark', 'bot-1', 'evt-too-many-files')).toBeUndefined()
    expect(f.store.getInboxByProviderEvent('lark', 'bot-1', 'evt-bad-file')).toBeUndefined()
    f.store.close()
  })

  test('claims in binding order, serializes a lane, and allows another lane', async () => {
    const f = await fixture()
    const secondPrincipal = { ...f.principal, user: 'ou_second' }
    const issued = f.store.issuePairing(secondPrincipal, { ttlMs: 5_000, maxAttempts: 3 })
    f.store.confirmPairing({ challengeId: issued.challenge.id, principal: secondPrincipal, code: issued.code })
    const secondConversation = { ...f.conversation, chat: 'oc_second' }
    const secondBinding = f.store.createBinding({ conversation: secondConversation, principal: secondPrincipal,
      workspace: '/work/beta', agentPreset: 'primary', sessionId: 'session-2', policyRef: 'owner-dm' })
    const one = f.store.acceptInbound(envelope('evt-1', f)).record
    const two = f.store.acceptInbound(envelope('evt-2', f)).record
    const other = f.store.acceptInbound({ ...envelope('evt-3', f), principal: secondPrincipal,
      conversation: secondConversation }).record
    for (const [record, binding] of [[one, f.binding], [two, f.binding], [other, secondBinding]] as const) {
      f.store.queueInbox(record.id, binding.id)
    }
    const claims = f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 10, maxAttempts: 3 })
    expect(claims.map(claim => claim.record.id)).toEqual([one.id, other.id])
    expect(f.store.claimInbox({ ownerId: 'worker-b', leaseMs: 100, limit: 10, maxAttempts: 3 })).toEqual([])
    f.store.finishInbox({ inboxId: one.id, ownerId: 'worker-a', fencingToken: claims[0]!.fencingToken,
      outcome: 'processed' })
    expect(f.store.claimInbox({ ownerId: 'worker-b', leaseMs: 100, limit: 10, maxAttempts: 3 })[0]?.record.id).toBe(two.id)
    f.store.close()
  })

  test('recovers expired claims and rejects stale completion fencing', async () => {
    const f = await fixture()
    const record = f.store.acceptInbound(envelope('evt-1', f)).record
    f.store.queueInbox(record.id, f.binding.id)
    const first = f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 2 })[0]!
    f.setNow(1_100)
    expect(f.store.recoverInbox({ maxAttempts: 2 })).toEqual([expect.objectContaining({ id: record.id, status: 'retry_wait' })])
    const second = f.store.claimInbox({ ownerId: 'worker-b', leaseMs: 100, limit: 1, maxAttempts: 2 })[0]!
    expect(second.fencingToken).toBeGreaterThan(first.fencingToken)
    expect(() => f.store.finishInbox({ inboxId: record.id, ownerId: 'worker-a', fencingToken: first.fencingToken,
      outcome: 'processed' })).toThrowError(expect.objectContaining({ code: 'stale-fence' }))
    f.store.finishInbox({ inboxId: record.id, ownerId: 'worker-b', fencingToken: second.fencingToken,
      outcome: 'retry_wait', failureCode: 'temporary', retryAt: 1_200 })
    f.setNow(1_200)
    const third = f.store.claimInbox({ ownerId: 'worker-c', leaseMs: 100, limit: 1, maxAttempts: 2 })
    expect(third).toEqual([])
    expect(f.store.getInbox(record.id)).toMatchObject({ status: 'dead_letter', attemptCount: 2 })
    f.store.close()
  })

  test('renews only the current unexpired inbox claim', async () => {
    const f = await fixture()
    const record = f.store.acceptInbound(envelope('evt-renew', f)).record
    f.store.queueInbox(record.id, f.binding.id)
    const claim = f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!

    f.setNow(1_050)
    expect(f.store.renewInboxClaim({
      inboxId: record.id, ownerId: 'worker-a', fencingToken: claim.fencingToken, leaseMs: 100,
    })).toBe(true)
    expect(f.store.getInbox(record.id)).toMatchObject({ status: 'claimed', leaseUntil: 1_150 })
    expect(f.store.renewInboxClaim({
      inboxId: record.id, ownerId: 'worker-b', fencingToken: claim.fencingToken, leaseMs: 100,
    })).toBe(false)
    expect(f.store.renewInboxClaim({
      inboxId: record.id, ownerId: 'worker-a', fencingToken: claim.fencingToken + 1, leaseMs: 100,
    })).toBe(false)

    f.setNow(1_150)
    expect(f.store.renewInboxClaim({
      inboxId: record.id, ownerId: 'worker-a', fencingToken: claim.fencingToken, leaseMs: 100,
    })).toBe(false)
    expect(() => f.store.markInboxDispatching({
      inboxId: record.id, ownerId: 'worker-a', fencingToken: claim.fencingToken,
    })).toThrowError(expect.objectContaining({ code: 'stale-fence' }))
    expect(() => f.store.finishInbox({
      inboxId: record.id, ownerId: 'worker-a', fencingToken: claim.fencingToken, outcome: 'processed',
    })).toThrowError(expect.objectContaining({ code: 'stale-fence' }))
    expect(f.store.recoverInbox({ maxAttempts: 3 })).toEqual([
      expect.objectContaining({ id: record.id, status: 'retry_wait', failureCode: 'lease-expired' }),
    ])
    f.store.close()
  })

  test('claims one explicit operator retry after automatic attempts are exhausted', async () => {
    const f = await fixture()
    const record = f.store.acceptInbound(envelope('evt-operator-retry', f)).record
    f.store.queueInbox(record.id, f.binding.id)
    const first = f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 1 })[0]!
    f.store.finishInbox({ inboxId: record.id, ownerId: 'worker-a', fencingToken: first.fencingToken,
      outcome: 'retry_wait', failureCode: 'temporary', retryAt: 1_100 })
    f.setNow(1_100)
    expect(f.store.claimInbox({ ownerId: 'worker-b', leaseMs: 100, limit: 1, maxAttempts: 1 })).toEqual([])
    expect(f.store.getInbox(record.id)).toMatchObject({ status: 'dead_letter', attemptCount: 1,
      failureCode: 'attempts-exhausted' })

    expect(f.store.resolveInbox({ inboxId: record.id, expectedAttemptCount: 1, resolution: 'retry' }))
      .toMatchObject({ status: 'queued', attemptCount: 1 })
    const retried = f.store.claimInbox({ ownerId: 'worker-c', leaseMs: 100, limit: 1, maxAttempts: 1 })[0]!
    expect(retried).toMatchObject({ fencingToken: 2, record: { id: record.id, status: 'claimed', attemptCount: 2 } })
    expect(() => f.store.finishInbox({ inboxId: record.id, ownerId: 'worker-a', fencingToken: first.fencingToken,
      outcome: 'processed' })).toThrowError(expect.objectContaining({ code: 'stale-fence' }))
    f.store.close()
  })

  test('never replays a claim whose external Agent dispatch may already have started', async () => {
    const f = await fixture()
    const record = f.store.acceptInbound(envelope('evt-ambiguous', f)).record
    f.store.queueInbox(record.id, f.binding.id)
    const claim = f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!
    f.store.markInboxDispatching({ inboxId: record.id, ownerId: 'worker-a', fencingToken: claim.fencingToken })
    f.setNow(1_100)
    expect(f.store.recoverInbox({ maxAttempts: 3 })).toEqual([
      expect.objectContaining({ id: record.id, status: 'dead_letter', failureCode: 'dispatch-ambiguous' }),
    ])
    expect(f.store.claimInbox({ ownerId: 'worker-b', leaseMs: 100, limit: 1, maxAttempts: 3 })).toEqual([])
    f.store.close()
  })

  test('bounds expired inbox recovery to the requested database batch', async () => {
    const f = await fixture()
    const records = Array.from({ length: 3 }, (_, index) => {
      const route = addBinding(f, index)
      const record = f.store.acceptInbound({ ...envelope(`evt-expired-${index}`, f),
        principal: route.principal, conversation: route.conversation }).record
      f.store.queueInbox(record.id, route.binding.id)
      return record
    })
    expect(f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 3, maxAttempts: 3 })).toHaveLength(3)
    f.setNow(1_100)

    expect(f.store.recoverInbox({ maxAttempts: 3, limit: 2 })).toHaveLength(2)
    expect(records.map(record => f.store.getInbox(record.id)?.status)).toEqual([
      'retry_wait', 'retry_wait', 'claimed',
    ])
    expect(f.store.recoverInbox({ maxAttempts: 3, limit: 2 })).toHaveLength(1)
    f.store.close()
  })

  test('bounds exhausted inbox cleanup performed by a claim call', async () => {
    const f = await fixture()
    const records = Array.from({ length: 3 }, (_, index) => {
      const route = addBinding(f, index)
      const record = f.store.acceptInbound({ ...envelope(`evt-exhausted-${index}`, f),
        principal: route.principal, conversation: route.conversation }).record
      f.store.queueInbox(record.id, route.binding.id)
      return record
    })
    const claims = f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 3, maxAttempts: 1 })
    for (const claim of claims) {
      f.store.finishInbox({ inboxId: claim.record.id, ownerId: 'worker-a', fencingToken: claim.fencingToken,
        outcome: 'retry_wait', failureCode: 'temporary', retryAt: 1_100 })
    }
    f.setNow(1_100)

    expect(f.store.claimInbox({ ownerId: 'worker-b', leaseMs: 100, limit: 1, maxAttempts: 1,
      maintenanceLimit: 2 })).toEqual([])
    expect(records.map(record => f.store.getInbox(record.id)?.status)).toEqual([
      'dead_letter', 'dead_letter', 'retry_wait',
    ])
    expect(f.store.claimInbox({ ownerId: 'worker-c', leaseMs: 100, limit: 1, maxAttempts: 1,
      maintenanceLimit: 2 })).toEqual([])
    expect(f.store.getInbox(records[2]!.id)).toMatchObject({ status: 'dead_letter',
      failureCode: 'attempts-exhausted' })
    f.store.close()
  })

  test('deduplicates the same persisted event over 100 cold store reopenings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-reopen-'))
    roots.push(root)
    const path = join(root, 'delivery.sqlite')
    const value: InboundEnvelope = { channel: 'lark', account: 'bot-1', eventId: 'evt-stable', occurredAt: 1,
      principal: { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner' },
      conversation: { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm', chat: 'oc_owner' },
      kind: 'text', text: 'stable' }
    let id: string | undefined
    for (let index = 0; index < 100; index += 1) {
      const store = new DeliveryStore({ path })
      const accepted = store.acceptInbound(value)
      if (id === undefined) id = accepted.record.id
      else expect(accepted).toMatchObject({ duplicate: true, record: { id } })
      store.close()
    }
  })
})
