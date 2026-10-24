import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { DeliveryStore } from '../src/store.ts'
import type { OutboundIntent } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-restart-outbound-'))
  roots.push(root)
  const databasePath = join(root, 'delivery.sqlite')
  const store = new DeliveryStore({ path: databasePath, now: () => 1_000, codeGenerator: () => 'PAIR1234' })
  const principal = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner' }
  const conversation = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm' as const, chat: 'oc_owner' }
  const issued = store.issuePairing(principal, { ttlMs: 5_000, maxAttempts: 3 })
  store.confirmPairing({ challengeId: issued.challenge.id, principal, code: issued.code })
  const binding = store.createBinding({ conversation, principal, workspace: '/work/alpha', agentPreset: 'primary',
    sessionId: 'session-1', policyRef: 'owner-dm' })
  const intent = (idempotencyKey: string, format: OutboundIntent['format'] = 'plain'): OutboundIntent => ({
    idempotencyKey, bindingId: binding.id, target: { principal, conversation }, text: idempotencyKey, format,
  })
  return { store, databasePath, intent }
}

test('restart fence only claims a plain maintenance acknowledgement and preserves queued work until clear', async () => {
  const f = await fixture()
  try {
    const retry = f.store.enqueue(f.intent('background:retry'))
    const first = f.store.claimOutbox({ ownerId: 'sender', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!
    f.store.finishOutbox({ outboxId: retry.id, ownerId: 'sender', fencingToken: first.fencingToken,
      outcome: 'retry_wait', retryAt: 1_000 })
    const pending = f.store.enqueue(f.intent('background:pending'))
    const notice = f.store.enqueue(f.intent('inbound:original-inbox:maintenance'))
    const card = f.store.enqueue(f.intent('inbound:card-inbox:maintenance', 'markdown'))
    const decorated = f.store.enqueue({ ...f.intent('inbound:decorated-inbox:maintenance'),
      metadata: { unexpected: 'route' } })
    f.store.setRestartFence('request-1', 'old-invocation')

    const claims = f.store.claimOutbox({ ownerId: 'sender', leaseMs: 100, limit: 10, maxAttempts: 1 })
    expect(claims.map(claim => claim.record.id)).toEqual([notice.id])
    expect(claims[0]?.mode).toBe('send')
    expect(f.store.getOutbox(retry.id)).toMatchObject({ status: 'retry_wait', attemptCount: 1 })
    expect(f.store.getOutbox(pending.id)).toMatchObject({ status: 'pending', attemptCount: 0 })
    expect(f.store.getOutbox(card.id)).toMatchObject({ status: 'pending', attemptCount: 0 })
    expect(f.store.getOutbox(decorated.id)).toMatchObject({ status: 'pending', attemptCount: 0 })
    expect(f.store.claimOutbox({ ownerId: 'other', leaseMs: 100, limit: 10, maxAttempts: 1 })).toEqual([])

    f.store.finishOutbox({ outboxId: notice.id, ownerId: 'sender', fencingToken: claims[0]!.fencingToken,
      outcome: 'accepted', providerMessageId: 'notice-sent' })
    expect(f.store.claimOutbox({ ownerId: 'other', leaseMs: 100, limit: 10, maxAttempts: 1 })).toEqual([])
    f.store.clearRestartFence('request-1')
    const resumed = f.store.claimOutbox({ ownerId: 'sender', leaseMs: 100, limit: 10, maxAttempts: 3 })
    expect(resumed.map(claim => claim.record.id)).toEqual([retry.id])
    expect(f.store.claimOutbox({ ownerId: 'other', leaseMs: 100, limit: 10, maxAttempts: 3 })).toEqual([])
    f.store.finishOutbox({ outboxId: retry.id, ownerId: 'sender', fencingToken: resumed[0]!.fencingToken,
      outcome: 'accepted', providerMessageId: 'retry-sent' })
    expect(f.store.claimOutbox({ ownerId: 'sender', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]?.record.id)
      .toBe(pending.id)
  } finally { f.store.close() }
})

test('a connection opened before the fence cannot directly claim a pending outbound send', async () => {
  const f = await fixture()
  const pending = f.store.enqueue(f.intent('background:old-writer'))
  const oldWriter = new DatabaseSync(f.databasePath)
  try {
    f.store.setRestartFence('request-2', 'old-invocation')
    expect(() => oldWriter.prepare("UPDATE outbox_messages SET status = 'attempting' WHERE id = ?")
      .run(pending.id)).toThrow(/planned restart blocks new outbound sends/)
    expect(f.store.getOutbox(pending.id)).toMatchObject({ status: 'pending', attemptCount: 0 })
  } finally { oldWriter.close(); f.store.close() }
})


test('a definitely not-sent maintenance notice can retry within the existing attempt budget', async () => {
  const f = await fixture()
  try {
    const notice = f.store.enqueue(f.intent('inbound:retry-notice:maintenance'))
    f.store.setRestartFence('request-retry', 'old-invocation')
    const first = f.store.claimOutbox({ ownerId: 'sender', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!
    f.store.finishOutbox({ outboxId: notice.id, ownerId: 'sender', fencingToken: first.fencingToken,
      outcome: 'retry_wait', retryAt: 1_000 })
    const retried = f.store.claimOutbox({ ownerId: 'sender', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!
    expect(retried.record.id).toBe(notice.id)
    expect(retried.record.attemptCount).toBe(2)
    f.store.finishOutbox({ outboxId: notice.id, ownerId: 'sender', fencingToken: retried.fencingToken,
      outcome: 'accepted', providerMessageId: 'notice-sent' })
    expect(f.store.claimOutbox({ ownerId: 'sender', leaseMs: 100, limit: 1, maxAttempts: 3 })).toEqual([])
  } finally { f.store.close() }
})
