import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { DeliveryStore } from '../src/store.ts'
import type { DeliveryReceipt, OutboundIntent } from '../src/types.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-outbox-'))
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

function intent(key: string, f: Awaited<ReturnType<typeof fixture>>, text = 'hello'): OutboundIntent {
  return { idempotencyKey: key, bindingId: f.binding.id, target: { principal: f.principal, conversation: f.conversation },
    text, format: 'plain' }
}

describe('durable outbox', () => {
  test('persists immutable idempotent intents before any adapter work', async () => {
    const f = await fixture()
    const first = f.store.enqueue(intent('automation:one:owner', f))
    expect(first).toMatchObject({ status: 'pending', attemptCount: 0 })
    expect(f.store.enqueue(intent('automation:one:owner', f))).toEqual(first)
    expect(() => f.store.enqueue(intent('automation:one:owner', f, 'changed')))
      .toThrowError(expect.objectContaining({ code: 'idempotency-conflict' }))
    f.store.close()
  })

  test('rejects arbitrary or mismatched routes and bounded content violations', async () => {
    const f = await fixture()
    expect(() => f.store.enqueue({ ...intent('route-1', f), bindingId: 'forged' }))
      .toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    expect(() => f.store.enqueue({ ...intent('route-2', f), target: {
      ...intent('route-2', f).target, conversation: { ...f.conversation, chat: 'other' },
    } })).toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    expect(() => f.store.enqueue(intent('route-3', f, 'x'.repeat(65_537))))
      .toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    f.store.close()
  })

  test('stores only a typed, bounded approval card intent', async () => {
    const f = await fixture()
    const approval: OutboundIntent = {
      ...intent('approval:one', f, 'Approve this reviewed action?'),
      format: 'approval',
      approval: {
        operationId: 'operation-1', proposalId: 'proposal-1', expectedVersion: 1,
        expiresAt: 10_000, title: 'Approval required',
      },
    }
    expect(f.store.enqueue(approval)).toMatchObject({ status: 'pending', intent: approval })
    expect(() => f.store.enqueue({ ...intent('approval:missing', f), format: 'approval' }))
      .toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    expect(() => f.store.enqueue({ ...intent('approval:forged', f), approval: approval.approval! }))
      .toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    expect(() => f.store.enqueue({ ...approval, idempotencyKey: 'approval:bad-expiry',
      approval: { ...approval.approval!, expiresAt: -1 } }))
      .toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    f.store.close()
  })

  test('stores only a typed, bounded model-picker intent', async () => {
    const f = await fixture()
    const modelPicker: OutboundIntent = {
      ...intent('model-picker:one', f, '请选择模型'),
      format: 'model-picker',
      modelPicker: {
        operationId: 'model-picker-1',
        expiresAt: 10_000,
        current: { provider: 'codex-subscription', model: 'default', reasoningEffort: 'high' },
        providers: [{ id: 'codex-subscription', name: 'Codex' }],
        models: [{ provider: 'codex-subscription', id: 'default', name: 'Default', effortIds: ['high'] }],
        efforts: [{ id: 'high', name: 'High' }],
      },
    }
    expect(f.store.enqueue(modelPicker)).toMatchObject({ status: 'pending', intent: modelPicker })
    expect(f.store.getModelPicker('model-picker-1', f.binding.id)).toEqual(modelPicker.modelPicker)
    expect(() => f.store.enqueue({ ...intent('model-picker:missing', f), format: 'model-picker' }))
      .toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    expect(() => f.store.enqueue({ ...modelPicker, idempotencyKey: 'model-picker:oversized',
      modelPicker: { ...modelPicker.modelPicker!, providers: Array.from({ length: 21 }, (_, index) => ({
        id: `provider-${index}`, name: `Provider ${index}`,
      })) } })).toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    expect(() => f.store.enqueue({ ...modelPicker, idempotencyKey: 'model-picker:bad-effort-link',
      modelPicker: { ...modelPicker.modelPicker!, models: [{
        provider: 'codex-subscription', id: 'default', name: 'Default', effortIds: ['missing'],
      }] } })).toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    f.store.close()
  })

  test('serializes a route lane and fences send completion', async () => {
    const f = await fixture()
    const one = f.store.enqueue(intent('one', f))
    const two = f.store.enqueue(intent('two', f))
    const first = f.store.claimOutbox({ ownerId: 'worker-a', leaseMs: 100, limit: 10, maxAttempts: 3 })
    expect(first).toEqual([expect.objectContaining({ mode: 'send', record: expect.objectContaining({ id: one.id }) })])
    expect(f.store.claimOutbox({ ownerId: 'worker-b', leaseMs: 100, limit: 10, maxAttempts: 3 })).toEqual([])
    expect(() => f.store.finishOutbox({ outboxId: one.id, ownerId: 'worker-b', fencingToken: first[0]!.fencingToken,
      outcome: 'accepted', providerMessageId: 'om_1' })).toThrowError(expect.objectContaining({ code: 'stale-fence' }))
    f.store.finishOutbox({ outboxId: one.id, ownerId: 'worker-a', fencingToken: first[0]!.fencingToken,
      outcome: 'accepted', providerMessageId: 'om_1' })
    expect(f.store.claimOutbox({ ownerId: 'worker-b', leaseMs: 100, limit: 10, maxAttempts: 3 })[0]?.record.id).toBe(two.id)
    f.store.close()
  })

  test('keeps ambiguous sends unknown and only claims them for reconciliation', async () => {
    const f = await fixture()
    const record = f.store.enqueue(intent('ambiguous', f))
    const send = f.store.claimOutbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 4 })[0]!
    f.store.finishOutbox({ outboxId: record.id, ownerId: 'worker-a', fencingToken: send.fencingToken,
      outcome: 'unknown_after_send', failureCode: 'response-lost' })
    const reconcile = f.store.claimOutbox({ ownerId: 'worker-b', leaseMs: 100, limit: 1, maxAttempts: 4 })[0]!
    expect(reconcile).toMatchObject({ mode: 'reconcile', record: { id: record.id, status: 'attempting' } })
    f.setNow(1_100)
    expect(f.store.recoverOutbox({ maxAttempts: 4 })).toEqual([
      expect.objectContaining({ id: record.id, status: 'unknown_after_send' }),
    ])
    const next = f.store.claimOutbox({ ownerId: 'worker-c', leaseMs: 100, limit: 1, maxAttempts: 4 })[0]!
    expect(next.mode).toBe('reconcile')
    f.store.finishOutbox({ outboxId: record.id, ownerId: 'worker-c', fencingToken: next.fencingToken,
      outcome: 'accepted', providerMessageId: 'om_reconciled' })
    f.store.close()
  })

  test('uses explicit retry timing and dead-letters exhausted attempts', async () => {
    const f = await fixture()
    const record = f.store.enqueue(intent('retry', f))
    const first = f.store.claimOutbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 2 })[0]!
    f.store.finishOutbox({ outboxId: record.id, ownerId: 'worker-a', fencingToken: first.fencingToken,
      outcome: 'retry_wait', failureCode: 'rate-limit', retryAt: 1_200 })
    expect(f.store.claimOutbox({ ownerId: 'worker-b', leaseMs: 100, limit: 1, maxAttempts: 2 })).toEqual([])
    f.setNow(1_200)
    const second = f.store.claimOutbox({ ownerId: 'worker-b', leaseMs: 100, limit: 1, maxAttempts: 2 })[0]!
    f.store.finishOutbox({ outboxId: record.id, ownerId: 'worker-b', fencingToken: second.fencingToken,
      outcome: 'retry_wait', failureCode: 'rate-limit', retryAt: 1_300 })
    f.setNow(1_300)
    expect(f.store.claimOutbox({ ownerId: 'worker-c', leaseMs: 100, limit: 1, maxAttempts: 2 })).toEqual([])
    expect(f.store.getOutbox(record.id)).toMatchObject({ status: 'dead', failureCode: 'attempts-exhausted' })
    f.store.close()
  })

  test('applies matching receipts monotonically and idempotently', async () => {
    const f = await fixture()
    const record = f.store.enqueue(intent('receipt', f))
    const claim = f.store.claimOutbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!
    f.store.finishOutbox({ outboxId: record.id, ownerId: 'worker-a', fencingToken: claim.fencingToken,
      outcome: 'accepted', providerMessageId: 'om_1' })
    const delivered: DeliveryReceipt = { channel: 'lark', account: 'bot-1', providerMessageId: 'om_1',
      status: 'delivered', occurredAt: 1_100 }
    expect(f.store.recordReceipt(delivered)).toMatchObject({ status: 'delivered' })
    expect(f.store.recordReceipt(delivered)).toMatchObject({ status: 'delivered' })
    expect(f.store.recordReceipt({ ...delivered, status: 'accepted', occurredAt: 1_200 })).toMatchObject({ status: 'delivered' })
    expect(() => f.store.recordReceipt({ ...delivered, providerMessageId: 'om_other' }))
      .toThrowError(expect.objectContaining({ code: 'receipt-mismatch' }))
    f.store.close()
  })
})
