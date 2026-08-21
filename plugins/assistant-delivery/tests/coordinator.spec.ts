import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { DeliveryAdapterRegistry, DeliveryCoordinator } from '../src/coordinator.ts'
import { DeliveryStore } from '../src/store.ts'
import type {
  AdapterReconcileResult,
  AdapterSendResult,
  DeliveryAdapter,
  DeliveryAdapterContext,
  OutboundIntent,
} from '../src/types.ts'

const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(options: { maxAttempts?: number; maxConcurrency?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-coordinator-'))
  roots.push(root)
  let now = 1_000
  const store = new DeliveryStore({ path: join(root, 'delivery.sqlite'), now: () => now, codeGenerator: () => 'PAIR1234' })
  const principal = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner' }
  const conversation = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm' as const, chat: 'oc_owner' }
  const issued = store.issuePairing(principal, { ttlMs: 5_000, maxAttempts: 3 })
  store.confirmPairing({ challengeId: issued.challenge.id, principal, code: issued.code })
  const binding = store.createBinding({ conversation, principal, workspace: '/work/alpha', agentPreset: 'primary',
    sessionId: 'session-1', policyRef: 'owner-dm' })
  const context: DeliveryAdapterContext = { accept: vi.fn(), receipt: vi.fn() }
  const registry = new DeliveryAdapterRegistry(context)
  const coordinator = new DeliveryCoordinator({ store, registry, ownerId: 'delivery-worker', leaseMs: 100,
    maxAttempts: options.maxAttempts ?? 4, maxConcurrency: options.maxConcurrency ?? 2,
    retryBaseMs: 100, retryMaxMs: 10_000, now: () => now, random: () => 0 })
  const makeIntent = (key: string): OutboundIntent => ({ idempotencyKey: key, bindingId: binding.id,
    target: { principal, conversation }, text: key, format: 'plain' })
  return { binding, context, coordinator, makeIntent, registry, store, setNow(value: number) { now = value } }
}

function adapter(options: {
  send?: (intent: Readonly<OutboundIntent>, signal: AbortSignal) => Promise<AdapterSendResult>
  reconcile?: (record: Parameters<NonNullable<DeliveryAdapter['reconcileUnknownSend']>>[0], signal: AbortSignal) => Promise<AdapterReconcileResult>
  start?: (context: DeliveryAdapterContext) => Promise<void | (() => void | Promise<void>)>
} = {}): DeliveryAdapter {
  return {
    channel: 'lark', account: 'bot-1',
    capabilities: { reconcileUnknownSend: options.reconcile !== undefined, receipts: ['delivered', 'read'], formats: ['plain'] },
    start: options.start ?? (async () => {}),
    send: options.send ?? (async () => ({ outcome: 'accepted', providerMessageId: 'om_default' })),
    ...(options.reconcile === undefined ? {} : { reconcileUnknownSend: options.reconcile }),
  }
}

describe('adapter registry and delivery coordinator', () => {
  test('starts and disposes one adapter for an exact channel/account key', async () => {
    const f = await fixture()
    const dispose = vi.fn()
    const first = adapter({ start: async context => { expect(context).toBe(f.context); return dispose } })
    const unregister = await f.registry.register(first)
    expect(f.registry.get('lark', 'bot-1')).toBe(first)
    await expect(f.registry.register(adapter())).rejects.toThrow(/already registered/i)
    await unregister()
    expect(dispose).toHaveBeenCalledOnce()
    expect(f.registry.get('lark', 'bot-1')).toBeUndefined()
    f.store.close()
  })

  test('sends only after durable claim and records accepted provider identity', async () => {
    const f = await fixture()
    const row = f.store.enqueue(f.makeIntent('accepted'))
    const send = vi.fn(async () => {
      expect(f.store.getOutbox(row.id)).toMatchObject({ status: 'attempting', attemptCount: 1 })
      return { outcome: 'accepted' as const, providerMessageId: 'om_accepted' }
    })
    await f.registry.register(adapter({ send }))
    await f.coordinator.tick()
    await f.coordinator.whenIdle()
    expect(send).toHaveBeenCalledOnce()
    expect(f.store.getOutbox(row.id)).toMatchObject({ status: 'accepted', providerMessageId: 'om_accepted' })
    await f.registry.stop()
    f.store.close()
  })

  test('treats thrown sends as ambiguous and reconciles instead of resending', async () => {
    const f = await fixture()
    const row = f.store.enqueue(f.makeIntent('ambiguous'))
    const send = vi.fn(async () => { throw new Error('connection reset after write') })
    const reconcile = vi.fn(async () => ({ outcome: 'delivered' as const, providerMessageId: 'om_found' }))
    await f.registry.register(adapter({ send, reconcile }))
    await f.coordinator.tick()
    await f.coordinator.whenIdle()
    expect(f.store.getOutbox(row.id)).toMatchObject({ status: 'unknown_after_send' })
    await f.coordinator.tick()
    await f.coordinator.whenIdle()
    expect(send).toHaveBeenCalledOnce()
    expect(reconcile).toHaveBeenCalledOnce()
    expect(f.store.getOutbox(row.id)).toMatchObject({ status: 'delivered', providerMessageId: 'om_found' })
    await f.registry.stop()
    f.store.close()
  })

  test('leaves unknown attempts unresolved when the adapter cannot reconcile', async () => {
    const f = await fixture()
    const row = f.store.enqueue(f.makeIntent('no-reconcile'))
    const send = vi.fn(async () => ({ outcome: 'unknown' as const, failureCode: 'lost' }))
    await f.registry.register(adapter({ send }))
    await f.coordinator.tick()
    await f.coordinator.whenIdle()
    await f.coordinator.tick()
    await f.coordinator.whenIdle()
    expect(send).toHaveBeenCalledOnce()
    expect(f.store.getOutbox(row.id)).toMatchObject({ status: 'unknown_after_send', failureCode: 'reconcile-unsupported' })
    await f.registry.stop()
    f.store.close()
  })

  test('honors Retry-After for proven not-sent failures and never retries permanent failures', async () => {
    const f = await fixture()
    const dead = f.store.enqueue(f.makeIntent('dead'))
    const retry = f.store.enqueue(f.makeIntent('retry'))
    const send = vi.fn(async (value: Readonly<OutboundIntent>) => value.idempotencyKey === 'retry'
      ? { outcome: 'not-sent' as const, failureCode: 'rate-limit', retryable: true, retryAfterMs: 500 }
      : { outcome: 'not-sent' as const, failureCode: 'forbidden', retryable: false })
    await f.registry.register(adapter({ send }))
    await f.coordinator.tick()
    await f.coordinator.whenIdle()
    expect(f.store.getOutbox(dead.id)).toMatchObject({ status: 'dead', failureCode: 'forbidden' })
    await f.coordinator.tick()
    await f.coordinator.whenIdle()
    expect(f.store.getOutbox(retry.id)).toMatchObject({ status: 'retry_wait', nextAttemptAt: 1_500 })
    await f.registry.stop()
    f.store.close()
  })

  test('bounds parallel sends while preserving independent lanes', async () => {
    const f = await fixture({ maxConcurrency: 1 })
    f.store.enqueue(f.makeIntent('one'))
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const send = vi.fn(async () => { await gate; return { outcome: 'accepted' as const, providerMessageId: 'om_1' } })
    await f.registry.register(adapter({ send }))
    await f.coordinator.tick()
    expect(send).toHaveBeenCalledOnce()
    await f.coordinator.tick()
    expect(send).toHaveBeenCalledOnce()
    release()
    await f.coordinator.whenIdle()
    await f.registry.stop()
    f.store.close()
  })
})
