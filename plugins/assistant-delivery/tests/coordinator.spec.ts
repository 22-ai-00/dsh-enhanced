import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { DeliveryAdapterRegistry, DeliveryCoordinator, InboundCoordinator } from '../src/coordinator.ts'
import { DeliveryStore } from '../src/store.ts'
import type {
  AdapterReconcileResult,
  AdapterSendResult,
  ConversationBinding,
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

  test('does not send a pending outbox after revoking its exact principal', async () => {
    const f = await fixture()
    const row = f.store.enqueue(f.makeIntent('pending-principal-revoked'))
    const send = vi.fn(async () => ({ outcome: 'accepted' as const, providerMessageId: 'om_forbidden' }))
    await f.registry.register(adapter({ send }))
    const principal = f.store.getPrincipal(f.binding.principal)!

    f.store.revokePrincipal(principal.id, principal.version)
    await f.coordinator.tick()
    await f.coordinator.whenIdle()

    expect(send).not.toHaveBeenCalled()
    expect(f.store.getOutbox(row.id)).toMatchObject({ status: 'dead', failureCode: 'binding-revoked' })
    await f.registry.stop()
    f.store.close()
  })

  test.each([
    ['inactive principal', (f: Awaited<ReturnType<typeof fixture>>) => {
      vi.spyOn(f.store, 'isAuthorizedPrincipal').mockReturnValue(false)
    }, 'principal-revoked'],
    ['changed target', (f: Awaited<ReturnType<typeof fixture>>) => {
      const original = f.store.getBinding.bind(f.store)
      vi.spyOn(f.store, 'getBinding').mockImplementation(id => {
        const binding = original(id)
        return binding?.id === f.binding.id
          ? { ...binding, conversation: { ...binding.conversation, chat: 'oc_changed_after_enqueue' } }
          : binding
      })
    }, 'binding-target-mismatch'],
  ] as const)('fails closed before send when the claimed outbox has an %s', async (_scenario, mutate, failureCode) => {
    const f = await fixture()
    const row = f.store.enqueue(f.makeIntent(`outbox-gate-${failureCode}`))
    const send = vi.fn(async () => ({ outcome: 'accepted' as const, providerMessageId: 'om_forbidden' }))
    await f.registry.register(adapter({ send }))
    mutate(f)

    await f.coordinator.tick()
    await f.coordinator.whenIdle()

    expect(send).not.toHaveBeenCalled()
    expect(f.store.getOutbox(row.id)).toMatchObject({ status: 'dead', failureCode })
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

  test('prepares inbound data before the dispatch marker and passes it to the processor', async () => {
    const f = await fixture()
    const target = f.makeIntent('prepared-inbound').target
    const record = f.store.acceptInbound({
      channel: 'lark', account: 'bot-1', eventId: 'evt-prepared-inbound', occurredAt: 1,
      principal: target.principal, conversation: target.conversation, kind: 'text', text: 'with image',
    }).record
    f.store.queueInbox(record.id, f.binding.id)
    const order: string[] = []
    const prepared = Object.freeze({ imageAttachments: Object.freeze([]) })
    const prepare = vi.fn(async (
      _binding: unknown,
      _envelope: unknown,
      _signal: AbortSignal,
      context: { inboxId: string; ownerId: string; fencingToken: number },
    ) => {
      order.push('prepare')
      expect(context).toEqual({ inboxId: record.id, ownerId: 'inbound-worker', fencingToken: 1 })
      expect(f.store.getInbox(record.id)).toMatchObject({ status: 'claimed' })
      expect(f.store.getInbox(record.id)).not.toHaveProperty('failureCode')
      return { outcome: 'prepared' as const, message: prepared }
    })
    const originalMark = f.store.markInboxDispatching.bind(f.store)
    const mark = vi.spyOn(f.store, 'markInboxDispatching').mockImplementation(input => {
      order.push('mark')
      return originalMark(input)
    })
    const process = vi.fn(async (
      _binding: unknown,
      _envelope: unknown,
      _signal: AbortSignal,
      message?: unknown,
    ) => {
      order.push('process')
      expect(message).toBe(prepared)
      expect(f.store.getInbox(record.id)).toMatchObject({ status: 'claimed', failureCode: 'dispatch-started' })
      return { outcome: 'processed' as const }
    })
    const coordinator = new InboundCoordinator({ store: f.store, processor: () => ({ prepare, process }),
      ownerId: 'inbound-worker', leaseMs: 100, maxAttempts: 3, maxConcurrency: 1,
      retryBaseMs: 100, retryMaxMs: 10_000, now: () => 1_000, random: () => 0 })

    try {
      await coordinator.tick()
      await coordinator.whenIdle()
      expect(order).toEqual(['prepare', 'mark', 'process'])
      expect(prepare).toHaveBeenCalledOnce()
      expect(mark).toHaveBeenCalledOnce()
      expect(process).toHaveBeenCalledOnce()
      expect(f.store.getInbox(record.id)).toMatchObject({ status: 'processed' })
    } finally {
      await coordinator.stop()
      f.store.close()
    }
  })

  test('retries a retryable preparation failure without marking dispatch', async () => {
    const f = await fixture()
    const target = f.makeIntent('prepare-retry').target
    const record = f.store.acceptInbound({
      channel: 'lark', account: 'bot-1', eventId: 'evt-prepare-retry', occurredAt: 1,
      principal: target.principal, conversation: target.conversation, kind: 'text', text: 'retry preparation',
    }).record
    f.store.queueInbox(record.id, f.binding.id)
    const prepare = vi.fn(async () => ({ outcome: 'not-processed' as const,
      failureCode: 'image-download-temporary', retryable: true, retryAfterMs: 500 }))
    const process = vi.fn(async () => ({ outcome: 'processed' as const }))
    const mark = vi.spyOn(f.store, 'markInboxDispatching')
    const coordinator = new InboundCoordinator({ store: f.store, processor: () => ({ prepare, process }),
      ownerId: 'inbound-worker', leaseMs: 100, maxAttempts: 3, maxConcurrency: 1,
      retryBaseMs: 100, retryMaxMs: 10_000, now: () => 1_000, random: () => 0 })

    try {
      await coordinator.tick()
      await coordinator.whenIdle()
      expect(mark).not.toHaveBeenCalled()
      expect(process).not.toHaveBeenCalled()
      expect(f.store.getInbox(record.id)).toMatchObject({
        status: 'retry_wait', failureCode: 'image-download-temporary', nextAttemptAt: 1_500,
      })
    } finally {
      await coordinator.stop()
      f.store.close()
    }
  })

  test('dead-letters a permanent preparation failure without marking dispatch', async () => {
    const f = await fixture()
    const target = f.makeIntent('prepare-dead').target
    const record = f.store.acceptInbound({
      channel: 'lark', account: 'bot-1', eventId: 'evt-prepare-dead', occurredAt: 1,
      principal: target.principal, conversation: target.conversation, kind: 'text', text: 'bad image',
    }).record
    f.store.queueInbox(record.id, f.binding.id)
    const prepare = vi.fn(async () => ({ outcome: 'not-processed' as const,
      failureCode: 'image-format-invalid', retryable: false }))
    const process = vi.fn(async () => ({ outcome: 'processed' as const }))
    const mark = vi.spyOn(f.store, 'markInboxDispatching')
    const coordinator = new InboundCoordinator({ store: f.store, processor: () => ({ prepare, process }),
      ownerId: 'inbound-worker', leaseMs: 100, maxAttempts: 3, maxConcurrency: 1,
      retryBaseMs: 100, retryMaxMs: 10_000, now: () => 1_000, random: () => 0 })

    try {
      await coordinator.tick()
      await coordinator.whenIdle()
      expect(mark).not.toHaveBeenCalled()
      expect(process).not.toHaveBeenCalled()
      expect(f.store.getInbox(record.id)).toMatchObject({
        status: 'dead_letter', failureCode: 'image-format-invalid',
      })
    } finally {
      await coordinator.stop()
      f.store.close()
    }
  })

  test('retries a thrown preparation safely without marking dispatch ambiguous', async () => {
    const f = await fixture()
    const target = f.makeIntent('prepare-throw').target
    const record = f.store.acceptInbound({
      channel: 'lark', account: 'bot-1', eventId: 'evt-prepare-throw', occurredAt: 1,
      principal: target.principal, conversation: target.conversation, kind: 'text', text: 'throw before dispatch',
    }).record
    f.store.queueInbox(record.id, f.binding.id)
    const prepare = vi.fn(async () => { throw new Error('temporary private detail') })
    const process = vi.fn(async () => ({ outcome: 'processed' as const }))
    const mark = vi.spyOn(f.store, 'markInboxDispatching')
    const coordinator = new InboundCoordinator({ store: f.store, processor: () => ({ prepare, process }),
      ownerId: 'inbound-worker', leaseMs: 100, maxAttempts: 3, maxConcurrency: 1,
      retryBaseMs: 100, retryMaxMs: 10_000, now: () => 1_000, random: () => 0 })

    try {
      await coordinator.tick()
      await coordinator.whenIdle()
      expect(mark).not.toHaveBeenCalled()
      expect(process).not.toHaveBeenCalled()
      expect(f.store.getInbox(record.id)).toMatchObject({
        status: 'retry_wait', failureCode: 'prepare-threw', nextAttemptAt: 1_100,
      })
    } finally {
      await coordinator.stop()
      f.store.close()
    }
  })

  test('dead-letters a binding revoked during preparation before marking dispatch', async () => {
    const f = await fixture()
    const target = f.makeIntent('prepare-revoked-binding').target
    const record = f.store.acceptInbound({
      channel: 'lark', account: 'bot-1', eventId: 'evt-prepare-revoked-binding', occurredAt: 1,
      principal: target.principal, conversation: target.conversation, kind: 'text', text: 'rotate during preparation',
    }).record
    f.store.queueInbox(record.id, f.binding.id)
    const prepare = vi.fn(async () => {
      f.store.rotateBinding({ bindingId: f.binding.id, expectedVersion: f.binding.version, sessionId: 'session-2' })
      return { outcome: 'prepared' as const, message: { imageAttachments: [] } }
    })
    const process = vi.fn(async () => ({ outcome: 'processed' as const }))
    const mark = vi.spyOn(f.store, 'markInboxDispatching')
    const coordinator = new InboundCoordinator({ store: f.store, processor: () => ({ prepare, process }),
      ownerId: 'inbound-worker', leaseMs: 100, maxAttempts: 3, maxConcurrency: 1,
      retryBaseMs: 100, retryMaxMs: 10_000 })

    try {
      await coordinator.tick()
      await coordinator.whenIdle()
      expect(mark).not.toHaveBeenCalled()
      expect(process).not.toHaveBeenCalled()
      expect(f.store.getInbox(record.id)).toMatchObject({
        status: 'dead_letter', failureCode: 'binding-revoked',
      })
    } finally {
      await coordinator.stop()
      f.store.close()
    }
  })

  test('rejects an explicit dispatch gate when setup revokes its binding', async () => {
    const f = await fixture()
    const target = f.makeIntent('explicit-setup-revoked-binding').target
    const record = f.store.acceptInbound({
      channel: 'lark', account: 'bot-1', eventId: 'evt-explicit-setup-revoked-binding', occurredAt: 1,
      principal: target.principal, conversation: target.conversation, kind: 'text', text: 'rotate during setup',
    }).record
    f.store.queueInbox(record.id, f.binding.id)
    const mark = vi.spyOn(f.store, 'markInboxDispatching')
    let externalDispatchStarted = false
    const process = vi.fn(async (
      _binding: unknown,
      _envelope: unknown,
      _signal: AbortSignal,
      _prepared?: unknown,
      markDispatching?: () => void,
    ) => {
      f.store.rotateBinding({ bindingId: f.binding.id, expectedVersion: f.binding.version, sessionId: 'session-2' })
      markDispatching!()
      externalDispatchStarted = true
      return { outcome: 'processed' as const }
    })
    const coordinator = new InboundCoordinator({ store: f.store,
      processor: () => ({ dispatchControl: 'explicit' as const, process }),
      ownerId: 'inbound-worker', leaseMs: 100, maxAttempts: 3, maxConcurrency: 1,
      retryBaseMs: 100, retryMaxMs: 10_000 })

    try {
      await coordinator.tick()
      await coordinator.whenIdle()
      expect(mark).not.toHaveBeenCalled()
      expect(externalDispatchStarted).toBe(false)
      expect(f.store.getInbox(record.id)).toMatchObject({
        status: 'dead_letter', failureCode: 'binding-revoked',
      })
    } finally {
      await coordinator.stop()
      f.store.close()
    }
  })

  test('rejects an explicit dispatch gate when setup changes its active binding route', async () => {
    const f = await fixture()
    const target = f.makeIntent('explicit-setup-changed-binding').target
    const record = f.store.acceptInbound({
      channel: 'lark', account: 'bot-1', eventId: 'evt-explicit-setup-changed-binding', occurredAt: 1,
      principal: target.principal, conversation: target.conversation, kind: 'text', text: 'change during setup',
    }).record
    f.store.queueInbox(record.id, f.binding.id)
    const originalGetBinding = f.store.getBinding.bind(f.store)
    let setupChangedBinding = false
    vi.spyOn(f.store, 'getBinding').mockImplementation(id => {
      const current = originalGetBinding(id)
      return setupChangedBinding && current?.id === f.binding.id
        ? { ...current, version: current.version + 1, sessionId: 'session-changed' }
        : current
    })
    const mark = vi.spyOn(f.store, 'markInboxDispatching')
    let externalDispatchStarted = false
    const process = vi.fn(async (
      _binding: unknown,
      _envelope: unknown,
      _signal: AbortSignal,
      _prepared?: unknown,
      markDispatching?: () => void,
    ) => {
      setupChangedBinding = true
      markDispatching!()
      externalDispatchStarted = true
      return { outcome: 'processed' as const }
    })
    const coordinator = new InboundCoordinator({ store: f.store,
      processor: () => ({ dispatchControl: 'explicit' as const, process }),
      ownerId: 'inbound-worker', leaseMs: 100, maxAttempts: 3, maxConcurrency: 1,
      retryBaseMs: 100, retryMaxMs: 10_000 })

    try {
      await coordinator.tick()
      await coordinator.whenIdle()
      expect(mark).not.toHaveBeenCalled()
      expect(externalDispatchStarted).toBe(false)
      expect(f.store.getInbox(record.id)).toMatchObject({
        status: 'dead_letter', failureCode: 'binding-changed-before-dispatch',
      })
    } finally {
      await coordinator.stop()
      f.store.close()
    }
  })

  test('rejects an explicit dispatch gate when setup revokes its principal authorization', async () => {
    const f = await fixture()
    const target = f.makeIntent('explicit-setup-revoked-principal').target
    const record = f.store.acceptInbound({
      channel: 'lark', account: 'bot-1', eventId: 'evt-explicit-setup-revoked-principal', occurredAt: 1,
      principal: target.principal, conversation: target.conversation, kind: 'text', text: 'revoke during setup',
    }).record
    f.store.queueInbox(record.id, f.binding.id)
    const principal = f.store.getPrincipal(f.binding.principal)!
    const mark = vi.spyOn(f.store, 'markInboxDispatching')
    let externalDispatchStarted = false
    const process = vi.fn(async (
      _binding: unknown,
      _envelope: unknown,
      _signal: AbortSignal,
      _prepared?: unknown,
      markDispatching?: () => void,
    ) => {
      f.store.revokePrincipal(principal.id, principal.version)
      markDispatching!()
      externalDispatchStarted = true
      return { outcome: 'processed' as const }
    })
    const coordinator = new InboundCoordinator({ store: f.store,
      processor: () => ({ dispatchControl: 'explicit' as const, process }),
      ownerId: 'inbound-worker', leaseMs: 100, maxAttempts: 3, maxConcurrency: 1,
      retryBaseMs: 100, retryMaxMs: 10_000 })

    try {
      await coordinator.tick()
      await coordinator.whenIdle()
      expect(mark).not.toHaveBeenCalled()
      expect(externalDispatchStarted).toBe(false)
      expect(f.store.getInbox(record.id)).toMatchObject({
        status: 'dead_letter', failureCode: 'authorization-revoked-before-dispatch',
      })
    } finally {
      await coordinator.stop()
      f.store.close()
    }
  })

  test.each([
    ['rotates the binding', (f: Awaited<ReturnType<typeof fixture>>) => {
      f.store.rotateBinding({ bindingId: f.binding.id, expectedVersion: f.binding.version, sessionId: 'session-2' })
    }, 'binding-changed-before-dispatch'],
    ['revokes the principal', (f: Awaited<ReturnType<typeof fixture>>) => {
      const principal = f.store.getPrincipal(f.binding.principal)!
      f.store.revokePrincipal(principal.id, principal.version)
    }, 'authorization-revoked-before-dispatch'],
  ] as const)(
    'fails closed when a concurrent writer %s after precheck but inside the dispatch marker',
    async (_scenario, mutate, failureCode) => {
      const f = await fixture()
      const target = f.makeIntent(`atomic-marker-${failureCode}`).target
      const record = f.store.acceptInbound({
        channel: 'lark', account: 'bot-1', eventId: `evt-atomic-marker-${failureCode}`, occurredAt: 1,
        principal: target.principal, conversation: target.conversation, kind: 'text', text: 'must not dispatch',
      }).record
      f.store.queueInbox(record.id, f.binding.id)
      const originalMark = f.store.markInboxDispatching.bind(f.store)
      vi.spyOn(f.store, 'markInboxDispatching').mockImplementation(input => {
        mutate(f)
        return originalMark(input)
      })
      const process = vi.fn(async () => ({ outcome: 'processed' as const }))
      const coordinator = new InboundCoordinator({ store: f.store, processor: () => ({ process }),
        ownerId: 'inbound-worker', leaseMs: 100, maxAttempts: 3, maxConcurrency: 1,
        retryBaseMs: 100, retryMaxMs: 10_000 })

      try {
        await coordinator.tick()
        await coordinator.whenIdle()
        expect(process).not.toHaveBeenCalled()
        expect(f.store.getInbox(record.id)).toMatchObject({ status: 'dead_letter', failureCode })
        expect(f.store.getInbox(record.id)?.failureCode).not.toBe('dispatch-started')
      } finally {
        await coordinator.stop()
        f.store.close()
      }
    },
  )

  test.each([
    ['version', (binding: ConversationBinding) => ({ ...binding, version: binding.version + 1 })],
    ['session', (binding: ConversationBinding) => ({ ...binding, sessionId: 'session-changed' })],
    ['generation', (binding: ConversationBinding) => ({ ...binding, generation: binding.generation + 1 })],
    ['principal', (binding: ConversationBinding) => ({ ...binding,
      principal: { ...binding.principal, user: 'ou_changed' } })],
    ['conversation', (binding: ConversationBinding) => ({ ...binding,
      conversation: { ...binding.conversation, chat: 'oc_changed' } })],
  ] as const)('dead-letters a binding whose %s changes during preparation', async (_field, mutate) => {
    const f = await fixture()
    const target = f.makeIntent('prepare-changed-binding').target
    const record = f.store.acceptInbound({
      channel: 'lark', account: 'bot-1', eventId: `evt-prepare-changed-binding-${_field}`, occurredAt: 1,
      principal: target.principal, conversation: target.conversation, kind: 'text', text: 'change during preparation',
    }).record
    f.store.queueInbox(record.id, f.binding.id)
    const originalGetBinding = f.store.getBinding.bind(f.store)
    let prepared = false
    vi.spyOn(f.store, 'getBinding').mockImplementation(id => {
      const current = originalGetBinding(id)
      return prepared && current?.id === f.binding.id ? mutate(current) : current
    })
    const prepare = vi.fn(async () => {
      prepared = true
      return { outcome: 'prepared' as const, message: { imageAttachments: [] } }
    })
    const process = vi.fn(async () => ({ outcome: 'processed' as const }))
    const mark = vi.spyOn(f.store, 'markInboxDispatching')
    const coordinator = new InboundCoordinator({ store: f.store, processor: () => ({ prepare, process }),
      ownerId: 'inbound-worker', leaseMs: 100, maxAttempts: 3, maxConcurrency: 1,
      retryBaseMs: 100, retryMaxMs: 10_000 })

    try {
      await coordinator.tick()
      await coordinator.whenIdle()
      expect(mark).not.toHaveBeenCalled()
      expect(process).not.toHaveBeenCalled()
      expect(f.store.getInbox(record.id)).toMatchObject({
        status: 'dead_letter', failureCode: 'binding-changed-before-dispatch',
      })
    } finally {
      await coordinator.stop()
      f.store.close()
    }
  })

  test('recovers lease loss during preparation as safe retry instead of dispatch ambiguity', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    const target = f.makeIntent('prepare-lease-lost').target
    const record = f.store.acceptInbound({
      channel: 'lark', account: 'bot-1', eventId: 'evt-prepare-lease-lost', occurredAt: 1,
      principal: target.principal, conversation: target.conversation, kind: 'text', text: 'lease lost before dispatch',
    }).record
    f.store.queueInbox(record.id, f.binding.id)
    vi.spyOn(f.store, 'renewInboxClaim').mockReturnValue(false)
    let observedSignal: AbortSignal | undefined
    const prepare = vi.fn(async (_binding: unknown, _envelope: unknown, signal: AbortSignal) => {
      observedSignal = signal
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      throw signal.reason
    })
    const process = vi.fn(async () => ({ outcome: 'processed' as const }))
    const mark = vi.spyOn(f.store, 'markInboxDispatching')
    const coordinator = new InboundCoordinator({ store: f.store, processor: () => ({ prepare, process }),
      ownerId: 'inbound-worker', leaseMs: 100, maxAttempts: 3, maxConcurrency: 1,
      retryBaseMs: 100, retryMaxMs: 10_000 })

    try {
      await coordinator.tick()
      await vi.advanceTimersByTimeAsync(34)
      expect(observedSignal?.aborted).toBe(true)
      await coordinator.whenIdle()
      expect(mark).not.toHaveBeenCalled()
      expect(process).not.toHaveBeenCalled()
      expect(f.store.getInbox(record.id)).toMatchObject({ status: 'claimed' })
      expect(f.store.getInbox(record.id)).not.toHaveProperty('failureCode')
      f.setNow(1_100)
      expect(f.store.recoverInbox({ maxAttempts: 3 })).toEqual([
        expect.objectContaining({ status: 'retry_wait', failureCode: 'lease-expired' }),
      ])
    } finally {
      await coordinator.stop()
      f.store.close()
    }
  })

  test('keeps processor throws ambiguous after preparation has been marked for dispatch', async () => {
    const f = await fixture()
    const target = f.makeIntent('process-throw').target
    const record = f.store.acceptInbound({
      channel: 'lark', account: 'bot-1', eventId: 'evt-process-throw', occurredAt: 1,
      principal: target.principal, conversation: target.conversation, kind: 'text', text: 'throw after dispatch',
    }).record
    f.store.queueInbox(record.id, f.binding.id)
    const prepare = vi.fn(async () => ({ outcome: 'prepared' as const, message: { imageAttachments: [] } }))
    const process = vi.fn(async () => { throw new Error('possibly dispatched') })
    const coordinator = new InboundCoordinator({ store: f.store, processor: () => ({ prepare, process }),
      ownerId: 'inbound-worker', leaseMs: 100, maxAttempts: 3, maxConcurrency: 1,
      retryBaseMs: 100, retryMaxMs: 10_000 })

    try {
      await coordinator.tick()
      await coordinator.whenIdle()
      expect(prepare).toHaveBeenCalledOnce()
      expect(process).toHaveBeenCalledOnce()
      expect(f.store.getInbox(record.id)).toMatchObject({
        status: 'dead_letter', failureCode: 'processor-ambiguous',
      })
    } finally {
      await coordinator.stop()
      f.store.close()
    }
  })

  test('retries an explicit processor throw before its dispatch gate is marked', async () => {
    const f = await fixture()
    const target = f.makeIntent('explicit-pre-dispatch-throw').target
    const record = f.store.acceptInbound({
      channel: 'lark', account: 'bot-1', eventId: 'evt-explicit-pre-dispatch-throw', occurredAt: 1,
      principal: target.principal, conversation: target.conversation, kind: 'text', text: 'fail before followup',
    }).record
    f.store.queueInbox(record.id, f.binding.id)
    const mark = vi.spyOn(f.store, 'markInboxDispatching')
    const process = vi.fn(async (
      _binding: unknown,
      _envelope: unknown,
      _signal: AbortSignal,
      _prepared?: unknown,
      markDispatching?: () => void,
    ) => {
      expect(markDispatching).toBeTypeOf('function')
      throw new Error('local setup failed')
    })
    const coordinator = new InboundCoordinator({ store: f.store,
      processor: () => ({ dispatchControl: 'explicit' as const, process }),
      ownerId: 'inbound-worker', leaseMs: 100, maxAttempts: 3, maxConcurrency: 1,
      retryBaseMs: 100, retryMaxMs: 10_000, now: () => 1_000, random: () => 0 })

    try {
      await coordinator.tick()
      await coordinator.whenIdle()
      expect(mark).not.toHaveBeenCalled()
      expect(f.store.getInbox(record.id)).toMatchObject({
        status: 'retry_wait', failureCode: 'processor-threw-before-dispatch', nextAttemptAt: 1_100,
      })
    } finally {
      await coordinator.stop()
      f.store.close()
    }
  })

  test('keeps an explicit processor throw ambiguous after its dispatch gate is marked', async () => {
    const f = await fixture()
    const target = f.makeIntent('explicit-post-dispatch-throw').target
    const record = f.store.acceptInbound({
      channel: 'lark', account: 'bot-1', eventId: 'evt-explicit-post-dispatch-throw', occurredAt: 1,
      principal: target.principal, conversation: target.conversation, kind: 'text', text: 'fail after followup',
    }).record
    f.store.queueInbox(record.id, f.binding.id)
    const mark = vi.spyOn(f.store, 'markInboxDispatching')
    const process = vi.fn(async (
      _binding: unknown,
      _envelope: unknown,
      _signal: AbortSignal,
      _prepared?: unknown,
      markDispatching?: () => void,
    ) => {
      markDispatching!()
      expect(f.store.getInbox(record.id)).toMatchObject({ failureCode: 'dispatch-started' })
      throw new Error('possibly dispatched')
    })
    const coordinator = new InboundCoordinator({ store: f.store,
      processor: () => ({ dispatchControl: 'explicit' as const, process }),
      ownerId: 'inbound-worker', leaseMs: 100, maxAttempts: 3, maxConcurrency: 1,
      retryBaseMs: 100, retryMaxMs: 10_000 })

    try {
      await coordinator.tick()
      await coordinator.whenIdle()
      expect(mark).toHaveBeenCalledOnce()
      expect(f.store.getInbox(record.id)).toMatchObject({
        status: 'dead_letter', failureCode: 'processor-ambiguous',
      })
    } finally {
      await coordinator.stop()
      f.store.close()
    }
  })

  test('marks an explicit dispatch gate at most once', async () => {
    const f = await fixture()
    const target = f.makeIntent('explicit-idempotent-gate').target
    const record = f.store.acceptInbound({
      channel: 'lark', account: 'bot-1', eventId: 'evt-explicit-idempotent-gate', occurredAt: 1,
      principal: target.principal, conversation: target.conversation, kind: 'text', text: 'one dispatch marker',
    }).record
    f.store.queueInbox(record.id, f.binding.id)
    const mark = vi.spyOn(f.store, 'markInboxDispatching')
    const process = vi.fn(async (
      _binding: unknown,
      _envelope: unknown,
      _signal: AbortSignal,
      _prepared?: unknown,
      markDispatching?: () => void,
    ) => {
      markDispatching!()
      markDispatching!()
      return { outcome: 'processed' as const }
    })
    const coordinator = new InboundCoordinator({ store: f.store,
      processor: () => ({ dispatchControl: 'explicit' as const, process }),
      ownerId: 'inbound-worker', leaseMs: 100, maxAttempts: 3, maxConcurrency: 1,
      retryBaseMs: 100, retryMaxMs: 10_000 })

    try {
      await coordinator.tick()
      await coordinator.whenIdle()
      expect(mark).toHaveBeenCalledOnce()
      expect(f.store.getInbox(record.id)).toMatchObject({ status: 'processed' })
    } finally {
      await coordinator.stop()
      f.store.close()
    }
  })

  test('rejects a retained explicit dispatch gate after the processor settles', async () => {
    const f = await fixture()
    const target = f.makeIntent('explicit-late-gate').target
    const record = f.store.acceptInbound({
      channel: 'lark', account: 'bot-1', eventId: 'evt-explicit-late-gate', occurredAt: 1,
      principal: target.principal, conversation: target.conversation, kind: 'text', text: 'late gate',
    }).record
    f.store.queueInbox(record.id, f.binding.id)
    const mark = vi.spyOn(f.store, 'markInboxDispatching')
    let retainedGate: (() => void) | undefined
    const process = vi.fn(async (
      _binding: unknown,
      _envelope: unknown,
      _signal: AbortSignal,
      _prepared?: unknown,
      markDispatching?: () => void,
    ) => {
      retainedGate = markDispatching
      markDispatching!()
      return { outcome: 'processed' as const }
    })
    const coordinator = new InboundCoordinator({ store: f.store,
      processor: () => ({ dispatchControl: 'explicit' as const, process }),
      ownerId: 'inbound-worker', leaseMs: 100, maxAttempts: 3, maxConcurrency: 1,
      retryBaseMs: 100, retryMaxMs: 10_000 })

    try {
      await coordinator.tick()
      await coordinator.whenIdle()
      expect(() => retainedGate!()).toThrow(/gate is closed/i)
      expect(mark).toHaveBeenCalledOnce()
      expect(f.store.getInbox(record.id)).toMatchObject({ status: 'processed' })
    } finally {
      await coordinator.stop()
      f.store.close()
    }
  })

  test('settles an explicit processed result without requiring a dispatch marker', async () => {
    const f = await fixture()
    const target = f.makeIntent('explicit-local-processed').target
    const record = f.store.acceptInbound({
      channel: 'lark', account: 'bot-1', eventId: 'evt-explicit-local-processed', occurredAt: 1,
      principal: target.principal, conversation: target.conversation, kind: 'command', text: '/local',
    }).record
    f.store.queueInbox(record.id, f.binding.id)
    const mark = vi.spyOn(f.store, 'markInboxDispatching')
    const process = vi.fn(async () => ({ outcome: 'processed' as const }))
    const coordinator = new InboundCoordinator({ store: f.store,
      processor: () => ({ dispatchControl: 'explicit' as const, process }),
      ownerId: 'inbound-worker', leaseMs: 100, maxAttempts: 3, maxConcurrency: 1,
      retryBaseMs: 100, retryMaxMs: 10_000 })

    try {
      await coordinator.tick()
      await coordinator.whenIdle()
      expect(mark).not.toHaveBeenCalled()
      expect(f.store.getInbox(record.id)).toMatchObject({ status: 'processed' })
    } finally {
      await coordinator.stop()
      f.store.close()
    }
  })

  test('settles an explicit not-processed result without requiring a dispatch marker', async () => {
    const f = await fixture()
    const target = f.makeIntent('explicit-local-failure').target
    const record = f.store.acceptInbound({
      channel: 'lark', account: 'bot-1', eventId: 'evt-explicit-local-failure', occurredAt: 1,
      principal: target.principal, conversation: target.conversation, kind: 'text', text: 'local failure',
    }).record
    f.store.queueInbox(record.id, f.binding.id)
    const mark = vi.spyOn(f.store, 'markInboxDispatching')
    const process = vi.fn(async () => ({ outcome: 'not-processed' as const,
      failureCode: 'local-prerequisite-unavailable', retryable: true }))
    const coordinator = new InboundCoordinator({ store: f.store,
      processor: () => ({ dispatchControl: 'explicit' as const, process }),
      ownerId: 'inbound-worker', leaseMs: 100, maxAttempts: 3, maxConcurrency: 1,
      retryBaseMs: 100, retryMaxMs: 10_000, now: () => 1_000, random: () => 0 })

    try {
      await coordinator.tick()
      await coordinator.whenIdle()
      expect(mark).not.toHaveBeenCalled()
      expect(f.store.getInbox(record.id)).toMatchObject({
        status: 'retry_wait', failureCode: 'local-prerequisite-unavailable', nextAttemptAt: 1_100,
      })
    } finally {
      await coordinator.stop()
      f.store.close()
    }
  })

  test('dead-letters an explicit retryable result after dispatch is marked without replaying it', async () => {
    const f = await fixture()
    const target = f.makeIntent('explicit-post-dispatch-not-processed').target
    const record = f.store.acceptInbound({
      channel: 'lark', account: 'bot-1', eventId: 'evt-explicit-post-dispatch-not-processed', occurredAt: 1,
      principal: target.principal, conversation: target.conversation, kind: 'text', text: 'retry after dispatch',
    }).record
    f.store.queueInbox(record.id, f.binding.id)
    const mark = vi.spyOn(f.store, 'markInboxDispatching')
    const process = vi.fn(async (
      _binding: unknown,
      _envelope: unknown,
      _signal: AbortSignal,
      _prepared?: unknown,
      markDispatching?: () => void,
    ) => {
      markDispatching!()
      return { outcome: 'not-processed' as const,
        failureCode: 'processor-requested-retry', retryable: true }
    })
    const coordinator = new InboundCoordinator({ store: f.store,
      processor: () => ({ dispatchControl: 'explicit' as const, process }),
      ownerId: 'inbound-worker', leaseMs: 100, maxAttempts: 3, maxConcurrency: 1,
      retryBaseMs: 100, retryMaxMs: 10_000, now: () => 1_000, random: () => 0 })

    try {
      await coordinator.tick()
      await coordinator.whenIdle()
      f.setNow(1_100)
      await coordinator.tick()
      await coordinator.whenIdle()

      expect(mark).toHaveBeenCalledOnce()
      expect(process).toHaveBeenCalledOnce()
      expect(f.store.getInbox(record.id)).toMatchObject({
        status: 'dead_letter', attemptCount: 1, failureCode: 'processor-ambiguous',
      })
    } finally {
      await coordinator.stop()
      f.store.close()
    }
  })

  test('throws from an explicit gate whose durable marker write fails', async () => {
    const f = await fixture()
    const target = f.makeIntent('explicit-marker-failure').target
    const record = f.store.acceptInbound({
      channel: 'lark', account: 'bot-1', eventId: 'evt-explicit-marker-failure', occurredAt: 1,
      principal: target.principal, conversation: target.conversation, kind: 'text', text: 'marker failure',
    }).record
    f.store.queueInbox(record.id, f.binding.id)
    const mark = vi.spyOn(f.store, 'markInboxDispatching').mockImplementation(() => { throw new Error('marker failed') })
    let continuedAfterGate = false
    const process = vi.fn(async (
      _binding: unknown,
      _envelope: unknown,
      _signal: AbortSignal,
      _prepared?: unknown,
      markDispatching?: () => void,
    ) => {
      markDispatching!()
      continuedAfterGate = true
      return { outcome: 'processed' as const }
    })
    const coordinator = new InboundCoordinator({ store: f.store,
      processor: () => ({ dispatchControl: 'explicit' as const, process }),
      ownerId: 'inbound-worker', leaseMs: 100, maxAttempts: 3, maxConcurrency: 1,
      retryBaseMs: 100, retryMaxMs: 10_000, now: () => 1_000, random: () => 0 })

    try {
      await coordinator.tick()
      await coordinator.whenIdle()
      expect(mark).toHaveBeenCalledOnce()
      expect(continuedAfterGate).toBe(false)
      expect(f.store.getInbox(record.id)).toMatchObject({
        status: 'retry_wait', failureCode: 'processor-threw-before-dispatch', nextAttemptAt: 1_100,
      })
    } finally {
      await coordinator.stop()
      f.store.close()
    }
  })

  test('does not call the processor when the dispatch marker loses its fence', async () => {
    const f = await fixture()
    const target = f.makeIntent('marker-fence-lost').target
    const record = f.store.acceptInbound({
      channel: 'lark', account: 'bot-1', eventId: 'evt-marker-fence-lost', occurredAt: 1,
      principal: target.principal, conversation: target.conversation, kind: 'text', text: 'stale marker',
    }).record
    f.store.queueInbox(record.id, f.binding.id)
    const prepare = vi.fn(async () => ({ outcome: 'prepared' as const, message: { imageAttachments: [] } }))
    const process = vi.fn(async () => ({ outcome: 'processed' as const }))
    vi.spyOn(f.store, 'markInboxDispatching').mockImplementation(() => { throw new Error('stale fence') })
    const coordinator = new InboundCoordinator({ store: f.store, processor: () => ({ prepare, process }),
      ownerId: 'inbound-worker', leaseMs: 100, maxAttempts: 3, maxConcurrency: 1,
      retryBaseMs: 100, retryMaxMs: 10_000 })

    try {
      await coordinator.tick()
      await coordinator.whenIdle()
      expect(prepare).toHaveBeenCalledOnce()
      expect(process).not.toHaveBeenCalled()
      expect(f.store.getInbox(record.id)).toMatchObject({ status: 'claimed' })
      expect(f.store.getInbox(record.id)).not.toHaveProperty('failureCode')
      f.setNow(1_100)
      expect(f.store.recoverInbox({ maxAttempts: 3 })).toEqual([
        expect.objectContaining({ status: 'retry_wait', failureCode: 'lease-expired' }),
      ])
    } finally {
      await coordinator.stop()
      f.store.close()
    }
  })

  test('ignores preparation that settles after bounded shutdown', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    const target = f.makeIntent('late-prepare').target
    const record = f.store.acceptInbound({
      channel: 'lark', account: 'bot-1', eventId: 'evt-late-prepare', occurredAt: 1,
      principal: target.principal, conversation: target.conversation, kind: 'text', text: 'late preparation',
    }).record
    f.store.queueInbox(record.id, f.binding.id)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const prepare = vi.fn(async () => {
      await gate
      return { outcome: 'prepared' as const, message: { imageAttachments: [] } }
    })
    const process = vi.fn(async () => ({ outcome: 'processed' as const }))
    const mark = vi.spyOn(f.store, 'markInboxDispatching')
    const finish = vi.spyOn(f.store, 'finishInbox')
    const coordinator = new InboundCoordinator({ store: f.store, processor: () => ({ prepare, process }),
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
      expect(mark).not.toHaveBeenCalled()
      expect(finish).not.toHaveBeenCalled()
      f.store.close()
      closed = true
      release()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(mark).not.toHaveBeenCalled()
      expect(finish).not.toHaveBeenCalled()
      expect(process).not.toHaveBeenCalled()
    } finally {
      release()
      await stopping
      if (!closed) f.store.close()
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
