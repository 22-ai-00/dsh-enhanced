import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { DeliveryAdapterRegistry, DeliveryCoordinator, InboundCoordinator } from '../src/coordinator.ts'
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

  test('rejects a pending registration before its adapter finishes starting and disposes the late result', async () => {
    const f = await fixture()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const dispose = vi.fn(async () => { throw new Error('late disposer rejected') })
    const late = adapter({ start: async () => { await gate; return dispose } })
    const registration = f.registry.register(late)
    await expect(f.registry.register(adapter())).rejects.toThrow(/already registered/i)

    const stopping = f.registry.stop()
    await expect(registration).rejects.toThrow(/stopped/i)

    release()
    await stopping
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
    expect(dispose).toHaveBeenCalledOnce()
    expect(f.registry.size()).toBe(0)
    f.store.close()
  })

  test('bounds registry shutdown and detaches a registration whose adapter never finishes starting', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    const never = new Promise<void | (() => void)>(() => {})
    const registration = f.registry.register(adapter({ start: async () => never }))
    const rejected = registration.then(
      () => undefined,
      error => error as Error,
    )
    await expect(f.registry.register(adapter())).rejects.toThrow(/already registered/i)

    let stopped = false
    const stopping = f.registry.stop().then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(5_000)

    expect(stopped).toBe(true)
    expect(await rejected).toMatchObject({ message: expect.stringMatching(/stopped/i) })
    await stopping
    expect(f.registry.size()).toBe(0)
    f.store.close()
  })

  test('bounds adapter unregister and registry shutdown when disposers never settle', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    const never = new Promise<void>(() => {})
    const unregister = await f.registry.register(adapter({ start: async () => async () => never }))
    let unregistered = false
    const unregistering = unregister().then(() => { unregistered = true })

    await vi.advanceTimersByTimeAsync(5_000)
    expect(unregistered).toBe(true)
    await unregistering

    await f.registry.register({ ...adapter({ start: async () => async () => never }), account: 'secondary-bot' })
    let stopped = false
    const stopping = f.registry.stop().then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(stopped).toBe(true)
    await stopping
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
    const f = await fixture({ maxAttempts: 2 })
    const row = f.store.enqueue(f.makeIntent('no-reconcile'))
    const next = f.store.enqueue(f.makeIntent('after-unknown'))
    const send = vi.fn(async (intent: Readonly<OutboundIntent>) => intent.idempotencyKey === 'no-reconcile'
      ? { outcome: 'unknown' as const, failureCode: 'lost' }
      : { outcome: 'accepted' as const, providerMessageId: 'om_after_unknown' })
    await f.registry.register(adapter({ send }))
    await f.coordinator.tick()
    await f.coordinator.whenIdle()
    for (let index = 0; index < 4; index += 1) {
      await f.coordinator.tick()
      await f.coordinator.whenIdle()
    }
    expect(send).toHaveBeenCalledOnce()
    expect(f.store.getOutbox(row.id)).toMatchObject({ status: 'unknown_after_send', attemptCount: 1,
      failureCode: 'lost' })
    expect(f.store.getOutbox(next.id)).toMatchObject({ status: 'pending', attemptCount: 0 })

    f.store.resolveOutbox({ outboxId: row.id, expectedAttemptCount: 1, resolution: 'cancel' })
    await f.coordinator.tick()
    await f.coordinator.whenIdle()
    expect(send).toHaveBeenCalledTimes(2)
    expect(f.store.getOutbox(next.id)).toMatchObject({ status: 'accepted', providerMessageId: 'om_after_unknown' })
    await f.registry.stop()
    f.store.close()
  })

  test('renews a long inbound Agent turn and preserves same-binding serialization', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    const first = f.store.acceptInbound({ channel: 'lark', account: 'bot-1', eventId: 'evt-long', occurredAt: 1,
      principal: f.makeIntent('x').target.principal, conversation: f.makeIntent('x').target.conversation,
      kind: 'text', text: 'long' }).record
    const second = f.store.acceptInbound({ channel: 'lark', account: 'bot-1', eventId: 'evt-next', occurredAt: 2,
      principal: f.makeIntent('x').target.principal, conversation: f.makeIntent('x').target.conversation,
      kind: 'text', text: 'next' }).record
    f.store.queueInbox(first.id, f.binding.id)
    f.store.queueInbox(second.id, f.binding.id)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const process = vi.fn(async (_binding, envelope: { eventId: string }) => {
      if (envelope.eventId === 'evt-long') await gate
      return { outcome: 'processed' as const }
    })
    const coordinator = new InboundCoordinator({ store: f.store, processor: () => ({ process }),
      ownerId: 'inbound-worker', leaseMs: 100, maxAttempts: 3, maxConcurrency: 2,
      retryBaseMs: 100, retryMaxMs: 10_000 })

    try {
      await coordinator.tick()
      expect(process).toHaveBeenCalledTimes(1)
      for (const now of [1_050, 1_100, 1_150, 1_200]) {
        f.setNow(now)
        await vi.advanceTimersByTimeAsync(50)
        await coordinator.tick()
      }
      expect(f.store.getInbox(first.id)).toMatchObject({ status: 'claimed', attemptCount: 1 })
      expect(f.store.getInbox(first.id)!.leaseUntil).toBeGreaterThan(1_200)
      expect(f.store.getInbox(second.id)).toMatchObject({ status: 'queued', attemptCount: 0 })
      expect(process).toHaveBeenCalledTimes(1)

      release()
      await coordinator.whenIdle()
      await coordinator.tick()
      await coordinator.whenIdle()
      expect(process).toHaveBeenCalledTimes(2)
      expect(f.store.getInbox(second.id)).toMatchObject({ status: 'processed', attemptCount: 1 })
    } finally {
      release()
      await coordinator.stop()
      f.store.close()
    }
  })

  test('renews a long outbox send without recovering or reconciling it concurrently', async () => {
    vi.useFakeTimers()
    const f = await fixture({ maxConcurrency: 2 })
    const row = f.store.enqueue(f.makeIntent('long-send'))
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const send = vi.fn(async () => {
      await gate
      return { outcome: 'accepted' as const, providerMessageId: 'om_long' }
    })
    const reconcile = vi.fn(async () => ({ outcome: 'unknown' as const }))
    await f.registry.register(adapter({ send, reconcile }))

    try {
      await f.coordinator.tick()
      expect(send).toHaveBeenCalledOnce()
      for (const now of [1_050, 1_100, 1_150, 1_200]) {
        f.setNow(now)
        await vi.advanceTimersByTimeAsync(50)
        await f.coordinator.tick()
      }
      expect(f.store.getOutbox(row.id)).toMatchObject({ status: 'attempting', attemptCount: 1 })
      expect(f.store.getOutbox(row.id)!.leaseUntil).toBeGreaterThan(1_200)
      expect(reconcile).not.toHaveBeenCalled()
      release()
      await f.coordinator.whenIdle()
      expect(f.store.getOutbox(row.id)).toMatchObject({ status: 'accepted', providerMessageId: 'om_long' })
    } finally {
      release()
      await f.coordinator.stop()
      await f.registry.stop()
      f.store.close()
    }
  })

  test('aborts an outbox adapter after lease renewal loses its fence and leaves recovery authoritative', async () => {
    vi.useFakeTimers()
    const f = await fixture({ maxConcurrency: 2 })
    const row = f.store.enqueue(f.makeIntent('outbox-lease-lost'))
    vi.spyOn(f.store, 'renewOutboxClaim').mockReturnValue(false)
    let observedSignal: AbortSignal | undefined
    const send = vi.fn(async (_intent: Readonly<OutboundIntent>, signal: AbortSignal) => {
      observedSignal = signal
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      // An adapter may ignore cancellation and return a late success. The lost
      // worker must still be unable to commit it.
      return { outcome: 'accepted' as const, providerMessageId: 'om_late' }
    })
    await f.registry.register(adapter({ send }))

    try {
      await f.coordinator.tick()
      await vi.advanceTimersByTimeAsync(34)
      expect(observedSignal?.aborted).toBe(true)
      await f.coordinator.whenIdle()
      expect(f.store.getOutbox(row.id)).toMatchObject({ status: 'attempting' })
      expect(f.store.getOutbox(row.id)?.providerMessageId).toBeUndefined()
      f.setNow(1_100)
      expect(f.store.recoverOutbox({ maxAttempts: 3 })).toEqual([
        expect.objectContaining({ id: row.id, status: 'unknown_after_send', failureCode: 'attempt-lease-expired' }),
      ])
    } finally {
      await f.coordinator.stop()
      await f.registry.stop()
      f.store.close()
    }
  })

  test('aborts an inbound processor after lease renewal loses its fence', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    const target = f.makeIntent('lease-lost').target
    const record = f.store.acceptInbound({ channel: 'lark', account: 'bot-1', eventId: 'evt-lease-lost', occurredAt: 1,
      principal: target.principal, conversation: target.conversation, kind: 'text', text: 'lease lost' }).record
    f.store.queueInbox(record.id, f.binding.id)
    vi.spyOn(f.store, 'renewInboxClaim').mockReturnValue(false)
    let observedSignal: AbortSignal | undefined
    let release!: () => void
    const process = vi.fn(async (_binding, _envelope, signal: AbortSignal) => {
      observedSignal = signal
      await new Promise<void>(resolve => {
        release = resolve
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
      if (signal.aborted) throw signal.reason
      return { outcome: 'processed' as const }
    })
    const coordinator = new InboundCoordinator({ store: f.store, processor: () => ({ process }),
      ownerId: 'inbound-worker', leaseMs: 100, maxAttempts: 3, maxConcurrency: 1,
      retryBaseMs: 100, retryMaxMs: 10_000 })

    try {
      await coordinator.tick()
      await vi.advanceTimersByTimeAsync(34)
      expect(observedSignal?.aborted).toBe(true)
      await coordinator.whenIdle()
      expect(f.store.getInbox(record.id)).toMatchObject({ status: 'claimed' })
      f.setNow(1_100)
      expect(f.store.recoverInbox({ maxAttempts: 3 })).toEqual([
        expect.objectContaining({ status: 'dead_letter', failureCode: 'dispatch-ambiguous' }),
      ])
    } finally {
      release()
      await coordinator.stop()
      f.store.close()
    }
  })

  test('dead-letters an inbox immediately when its binding was revoked', async () => {
    const f = await fixture()
    const target = f.makeIntent('revoked-inbound').target
    const record = f.store.acceptInbound({
      channel: 'lark', account: 'bot-1', eventId: 'evt-revoked-binding', occurredAt: 1,
      principal: target.principal, conversation: target.conversation, kind: 'text', text: 'stale route',
    }).record
    f.store.queueInbox(record.id, f.binding.id)
    f.store.rotateBinding({ bindingId: f.binding.id, expectedVersion: f.binding.version, sessionId: 'session-2' })
    const process = vi.fn(async () => ({ outcome: 'processed' as const }))
    const processor = vi.fn(() => ({ process }))
    const coordinator = new InboundCoordinator({ store: f.store, processor,
      ownerId: 'inbound-worker', leaseMs: 100, maxAttempts: 3, maxConcurrency: 1,
      retryBaseMs: 100, retryMaxMs: 10_000 })

    try {
      await coordinator.tick()
      await coordinator.whenIdle()
      expect(processor).not.toHaveBeenCalled()
      expect(process).not.toHaveBeenCalled()
      expect(f.store.getInbox(record.id)).toMatchObject({
        status: 'dead_letter', attemptCount: 1, failureCode: 'binding-revoked',
      })
      expect(f.store.getInbox(record.id)).not.toHaveProperty('nextAttemptAt')
    } finally {
      await coordinator.stop()
      f.store.close()
    }
  })

  test('bounds shutdown when an outbox send never observes cancellation', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    f.store.enqueue(f.makeIntent('never-send'))
    const send = vi.fn(async () => new Promise<AdapterSendResult>(() => {}))
    await f.registry.register(adapter({ send }))

    await f.coordinator.tick()
    const stopping = f.coordinator.stop()
    let stopped = false
    void stopping.then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(100)

    expect(stopped).toBe(true)
    await stopping
    await f.registry.stop()
    f.store.close()
  })

  test('drains a cooperative outbox send without waiting for the shutdown deadline', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    f.store.enqueue(f.makeIntent('cooperative-send'))
    const send = vi.fn(async (_intent: Readonly<OutboundIntent>, signal: AbortSignal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      return { outcome: 'accepted' as const, providerMessageId: 'om_cancelled' }
    })
    await f.registry.register(adapter({ send }))

    await f.coordinator.tick()
    await f.coordinator.stop()
    expect(send).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    await f.registry.stop()
    f.store.close()
  })

  test('does not touch the store when an outbox send settles after bounded shutdown', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    f.store.enqueue(f.makeIntent('late-send'))
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const send = vi.fn(async () => {
      await gate
      return { outcome: 'accepted' as const, providerMessageId: 'om_too_late' }
    })
    const finish = vi.spyOn(f.store, 'finishOutbox')
    await f.registry.register(adapter({ send }))
    const stopping = (async () => {
      await f.coordinator.tick()
      return f.coordinator.stop()
    })()
    let closed = false

    try {
      await vi.advanceTimersByTimeAsync(100)
      await stopping
      expect(finish).not.toHaveBeenCalled()
      f.store.close()
      closed = true
      release()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(finish).not.toHaveBeenCalled()
    } finally {
      release()
      await stopping
      await f.registry.stop()
      if (!closed) f.store.close()
    }
  })

  test('does not touch the store when outbox reconciliation rejects after bounded shutdown', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    const row = f.store.enqueue(f.makeIntent('late-reconcile'))
    let rejectReconcile!: (error: Error) => void
    const reconcileGate = new Promise<AdapterReconcileResult>((_resolve, reject) => { rejectReconcile = reject })
    const send = vi.fn(async () => ({ outcome: 'unknown' as const, failureCode: 'ambiguous' }))
    const reconcile = vi.fn(async () => reconcileGate)
    await f.registry.register(adapter({ send, reconcile }))
    await f.coordinator.tick()
    await f.coordinator.whenIdle()
    expect(f.store.getOutbox(row.id)).toMatchObject({ status: 'unknown_after_send' })
    const finish = vi.spyOn(f.store, 'finishOutbox')
    await f.coordinator.tick()
    expect(reconcile).toHaveBeenCalledOnce()
    const stopping = f.coordinator.stop()
    let closed = false

    try {
      await vi.advanceTimersByTimeAsync(100)
      await stopping
      expect(finish).not.toHaveBeenCalled()
      f.store.close()
      closed = true
      rejectReconcile(new Error('late provider failure'))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(finish).not.toHaveBeenCalled()
    } finally {
      rejectReconcile(new Error('test cleanup'))
      await stopping
      await f.registry.stop()
      if (!closed) f.store.close()
    }
  })

  test('does not touch the store when an inbound processor settles after bounded shutdown', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    const target = f.makeIntent('late-inbound').target
    const record = f.store.acceptInbound({
      channel: 'lark', account: 'bot-1', eventId: 'evt-late-processor', occurredAt: 1,
      principal: target.principal, conversation: target.conversation, kind: 'text', text: 'late turn',
    }).record
    f.store.queueInbox(record.id, f.binding.id)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const process = vi.fn(async () => {
      await gate
      return { outcome: 'processed' as const }
    })
    const finish = vi.spyOn(f.store, 'finishInbox')
    const coordinator = new InboundCoordinator({ store: f.store, processor: () => ({ process }),
      ownerId: 'inbound-worker', leaseMs: 100, maxAttempts: 3, maxConcurrency: 1,
      retryBaseMs: 100, retryMaxMs: 10_000 })
    const stopping = (async () => {
      await coordinator.tick()
      return coordinator.stop()
    })()
    let closed = false

    try {
      await vi.advanceTimersByTimeAsync(100)
      await stopping
      expect(finish).not.toHaveBeenCalled()
      f.store.close()
      closed = true
      release()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(finish).not.toHaveBeenCalled()
    } finally {
      release()
      await stopping
      if (!closed) f.store.close()
    }
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
