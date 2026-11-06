import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AssistantDeliveryService, ownerNotificationWithdrawalProtocol, type OwnerNotificationWithdrawal, type OwnerRouteAuthority } from '../src/index.ts'
import { DeliveryStore } from '../src/store.ts'

const roots: string[] = []
const contexts = new Set<Context>()
const principal = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner' }
const conversation = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm' as const, chat: 'oc_owner' }
const authority: OwnerRouteAuthority = {
  id: 'notice-owner', conversation, principal, workspace: '/work/alpha', agentPreset: 'primary',
  policyRef: 'owner-dm', minimumGeneration: 1,
}

interface Fixture {
  readonly ctx: Context
  readonly service: AssistantDeliveryService
  readonly store: DeliveryStore
  readonly send: ReturnType<typeof vi.fn>
  readonly binding: ReturnType<DeliveryStore['createBinding']>
}

afterEach(async () => {
  await Promise.all([...contexts].map(async ctx => {
    await ctx.fiber.restart()
    contexts.delete(ctx)
  }))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-notice-'))
  roots.push(root)
  const ctx = new Context()
  contexts.add(ctx)
  try {
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      rules: [
        { id: 'local-pair', effect: 'allow', subject: { kind: 'external', id: 'local:test' },
          actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' },
          context: { initiators: ['foreground'] } },
        { id: 'owner-pair', effect: 'allow', subject: { kind: 'external', id: 'lark/bot-1/tenant-a/ou_owner' },
          actions: ['pair.confirm'], resource: { kind: 'message', id: 'pairing' },
          context: { initiators: ['external'] } },
        { id: 'notice-send', effect: 'allow', subject: {
          kind: 'background', id: 'proactive-engine', workspace: '/work/alpha',
          principal: 'lark/bot-1/tenant-a/ou_owner',
        }, actions: ['send'], resource: { kind: 'message', id: '*' }, context: { initiators: ['background'] } },
      ],
    })
    await ctx.plugin(AssistantDeliveryService, {
      databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'), schedulerEnabled: false,
      retryBaseMs: 1, retryMaxMs: 1, ownerRoutes: [authority],
    })
    const service = ctx.assistantDelivery
    const store = (service as unknown as { deliveryStore: DeliveryStore }).deliveryStore
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    const binding = store.createBinding({ conversation, principal, workspace: '/work/alpha',
      agentPreset: 'primary', sessionId: 'session-1', policyRef: 'owner-dm' })
    const send = vi.fn(async () => ({ outcome: 'accepted' as const, providerMessageId: 'provider-notice' }))
    await service.registerAdapter({ channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'] }, start: async () => {}, send })
    return { ctx, service, store, send, binding }
  } catch (error) {
    await ctx.fiber.restart()
    contexts.delete(ctx)
    throw error
  }
}

function notificationInput(f: Fixture, overrides: Partial<{ expiresAt: number; idempotencyKey: string; sessionId: string; principalVersion: number; workspace: string; preset: string }> = {}) {
  const owner = f.store.getPrincipal(principal)!
  return {
    sourceId: 'proactive-engine', ownerRouteId: authority.id,
    scope: { principalId: 'lark/bot-1/tenant-a/ou_owner', principalRecordId: owner.id,
      principalVersion: overrides.principalVersion ?? owner.version, workspace: overrides.workspace ?? '/work/alpha',
      preset: overrides.preset ?? 'primary' },
    sessionId: overrides.sessionId ?? 'session-1', idempotencyKey: overrides.idempotencyKey ?? 'notice-1',
    text: 'A supervised action needs your attention.', expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
  }
}

/** Test owner service in its own ctx slot; it vouches only for registrations it created. */
function withdrawalAuthority(f: Fixture, slot = 'noticeAuthority') {
  const owned = new Set<object>()
  f.ctx.provide(slot as never, { ownsOwnerNotificationWithdrawal: (registration: object) => owned.has(registration) } as never)
  return {
    owned,
    register(isWithdrawn: (key: string) => boolean) {
      const registration: OwnerNotificationWithdrawal = Object.freeze({ protocol: ownerNotificationWithdrawalProtocol, authority: slot, sourceId: 'proactive-engine', isWithdrawn })
      owned.add(registration)
      return { registration, binding: f.service.registerOwnerNotificationWithdrawal(registration) }
    },
  }
}

async function drain(f: Fixture): Promise<void> {
  await f.service.tick()
  await f.service.whenIdle()
}

describe('typed owner notifications', () => {
  test('queues one idempotent typed notice through the real service and sends it once', async () => {
    const f = await fixture()
    const input = notificationInput(f)
    const first = f.service.enqueueOwnerNotification(input)
    const duplicate = f.service.enqueueOwnerNotification(input)
    expect(duplicate.id).toBe(first.id)
    expect(first.intent.metadata).toMatchObject({ 'dsh.native-notice': 'v1' })
    await drain(f)
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.store.getOutbox(first.id)).toMatchObject({ status: 'accepted', attemptCount: 1 })
  })

  test('rejects a typed notification whose frozen owner scope is not current', async () => {
    const f = await fixture()
    expect(() => f.service.enqueueOwnerNotification(notificationInput(f, { sessionId: 'other-session' })))
      .toThrowError(expect.objectContaining({ code: 'policy-denied' }))
    expect(f.store.listOutbox({ bindingId: f.binding.id })).toHaveLength(0)
  })

  test('does not let the general background enqueue seam forge a native-notice metadata prefix', async () => {
    const f = await fixture()
    expect(() => f.service.enqueueBackground({ sourceId: 'proactive-engine', workspace: '/work/alpha',
      bindingId: f.binding.id, idempotencyKey: 'forged-notice', text: 'forged', format: 'plain',
      metadata: { 'dsh.native-notice.untrusted': 'v1' } }))
      .toThrowError(expect.objectContaining({ code: 'runtime-conflict' }))
    expect(f.store.listOutbox({ bindingId: f.binding.id })).toHaveLength(0)
  })

  test('does not dispatch a notice that expires after it was queued', async () => {
    const f = await fixture()
    const expiresAt = Date.now() + 60_000
    const queued = f.service.enqueueOwnerNotification(notificationInput(f, { expiresAt }))
    const clock = vi.spyOn(Date, 'now').mockReturnValue(expiresAt)
    try { await drain(f) } finally { clock.mockRestore() }
    expect(f.send).not.toHaveBeenCalled()
    expect(f.store.getOutbox(queued.id)).toMatchObject({ status: 'dead', failureCode: expect.any(String) })
  })

  test('does not dispatch a notice after its owner principal is revoked', async () => {
    const f = await fixture()
    const queued = f.service.enqueueOwnerNotification(notificationInput(f))
    const owner = f.store.getPrincipal(principal)!
    f.store.revokePrincipal(owner.id, owner.version)
    await drain(f)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.store.getOutbox(queued.id)).toMatchObject({ status: 'dead', failureCode: expect.any(String) })
  })

  test('does not dispatch a notice after the owner binding is replaced by a new generation', async () => {
    const f = await fixture()
    const queued = f.service.enqueueOwnerNotification(notificationInput(f))
    f.store.rotateBinding({ bindingId: f.binding.id, expectedVersion: f.binding.version, sessionId: 'session-2' })
    await drain(f)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.store.getOutbox(queued.id)).toMatchObject({ status: 'dead', failureCode: expect.any(String) })
  })

  test('rechecks Policy before dispatch and fences a queued notice when send authority is revoked', async () => {
    const f = await fixture()
    const queued = f.service.enqueueOwnerNotification(notificationInput(f))
    const evaluate = vi.spyOn(f.ctx.assistantPolicy, 'evaluate')
    evaluate.mockReturnValue({ effect: 'deny', reasonCode: 'default-deny', ruleId: undefined })
    await drain(f)
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ action: 'send' }))
    expect(f.send).not.toHaveBeenCalled()
    expect(f.store.getOutbox(queued.id)).toMatchObject({ status: 'dead' })
  })

  test('withdraws a withdrawable notice at send time when its source reports it withdrawn', async () => {
    const f = await fixture()
    const withdrawn = new Set<string>(['notice-1'])
    const isWithdrawn = vi.fn((key: string) => withdrawn.has(key))
    const { binding } = withdrawalAuthority(f).register(isWithdrawn)
    const queued = f.service.enqueueOwnerNotification({ ...notificationInput(f), withdrawable: true, withdrawalHandle: binding.handle })
    expect(queued.intent.metadata).toMatchObject({ 'dsh.native-notice.withdrawable': 'v1', 'dsh.native-notice.withdrawalAuthority': 'noticeAuthority' })
    await drain(f)
    expect(isWithdrawn).toHaveBeenCalledWith('notice-1')
    expect(f.send).not.toHaveBeenCalled()
    expect(f.store.getOutbox(queued.id)).toMatchObject({ status: 'dead', failureCode: 'native-notice-withdrawn' })
    binding.unregister()
  })

  test('holds a withdrawable notice while its check is unregistered and sends once a vouched check is back', async () => {
    const f = await fixture()
    const owner = withdrawalAuthority(f)
    const first = owner.register(() => false)
    const queued = f.service.enqueueOwnerNotification({ ...notificationInput(f), withdrawable: true, withdrawalHandle: first.binding.handle })
    first.binding.unregister()
    await drain(f)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.store.getOutbox(queued.id)).toMatchObject({ status: 'retry_wait', failureCode: 'native-notice-withdrawal-unavailable' })
    const second = owner.register(() => false)
    expect(() => owner.register(() => false)).toThrowError(expect.objectContaining({ code: 'runtime-conflict' }))
    await new Promise(resolve => setTimeout(resolve, 5))
    await drain(f)
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.store.getOutbox(queued.id)).toMatchObject({ status: 'accepted' })
    second.binding.unregister()
  })

  test('a restarted owner whose old registration it no longer vouches for takes over queued notices', async () => {
    const f = await fixture()
    const owner = withdrawalAuthority(f)
    const old = owner.register(() => false)
    const queued = f.service.enqueueOwnerNotification({ ...notificationInput(f), withdrawable: true, withdrawalHandle: old.binding.handle })
    // Crash-style restart: the owner forgets its registration without unregistering.
    owner.owned.delete(old.registration)
    await drain(f)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.store.getOutbox(queued.id)).toMatchObject({ status: 'retry_wait', failureCode: 'native-notice-withdrawal-unavailable' })
    expect(() => f.service.inspectOwnerNotification({ sourceId: 'proactive-engine', idempotencyKey: 'notice-1', withdrawalHandle: old.binding.handle }))
      .toThrowError(expect.objectContaining({ code: 'runtime-conflict' }))
    const isWithdrawn = vi.fn(() => true)
    const next = owner.register(isWithdrawn)
    expect(f.service.inspectOwnerNotification({ sourceId: 'proactive-engine', idempotencyKey: 'notice-1', withdrawalHandle: next.binding.handle }))
      .toEqual({ outboxId: queued.id, status: 'retry_wait' })
    await new Promise(resolve => setTimeout(resolve, 5))
    await drain(f)
    expect(isWithdrawn).toHaveBeenCalledWith('notice-1')
    expect(f.send).not.toHaveBeenCalled()
    expect(f.store.getOutbox(queued.id)).toMatchObject({ status: 'dead', failureCode: 'native-notice-withdrawn' })
  })

  test('a foreign registration for the same source can neither squat the owner slot nor reach its notices', async () => {
    const f = await fixture()
    const owner = withdrawalAuthority(f)
    // Unvouched object claiming the owner's authority: rejected before it can register.
    expect(() => f.service.registerOwnerNotificationWithdrawal({ protocol: ownerNotificationWithdrawalProtocol,
      authority: 'noticeAuthority', sourceId: 'proactive-engine', isWithdrawn: () => false }))
      .toThrowError(expect.objectContaining({ code: 'runtime-conflict' }))
    // A missing slot vouches for nothing.
    expect(() => f.service.registerOwnerNotificationWithdrawal({ protocol: ownerNotificationWithdrawalProtocol,
      authority: 'missingAuthority', sourceId: 'proactive-engine', isWithdrawn: () => false }))
      .toThrowError(expect.objectContaining({ code: 'runtime-conflict' }))
    // A foreign authority that vouches for itself registers first under the same source.
    const squatIsWithdrawn = vi.fn(() => false)
    const squatter = withdrawalAuthority(f, 'squatAuthority').register(squatIsWithdrawn)
    const ownerIsWithdrawn = vi.fn(() => true)
    const legit = owner.register(ownerIsWithdrawn)
    expect(squatter.binding.handle).not.toBe(legit.binding.handle)
    const queued = f.service.enqueueOwnerNotification({ ...notificationInput(f), withdrawable: true, withdrawalHandle: legit.binding.handle })
    expect(f.service.inspectOwnerNotification({ sourceId: 'proactive-engine', idempotencyKey: 'notice-1', withdrawalHandle: squatter.binding.handle })).toBeUndefined()
    squatter.binding.unregister()
    await drain(f)
    expect(squatIsWithdrawn).not.toHaveBeenCalled()
    expect(ownerIsWithdrawn).toHaveBeenCalledWith('notice-1')
    expect(f.send).not.toHaveBeenCalled()
    expect(f.store.getOutbox(queued.id)).toMatchObject({ status: 'dead', failureCode: 'native-notice-withdrawn' })
  })

  test('enqueue rejects a withdrawable notice without a live handle for its source', async () => {
    const f = await fixture()
    const { binding } = withdrawalAuthority(f).register(() => false)
    expect(() => f.service.enqueueOwnerNotification({ ...notificationInput(f), withdrawable: true }))
      .toThrowError(expect.objectContaining({ code: 'policy-denied' }))
    expect(() => f.service.enqueueOwnerNotification({ ...notificationInput(f), withdrawable: true, withdrawalHandle: 'not-a-handle' }))
      .toThrowError(expect.objectContaining({ code: 'policy-denied' }))
    expect(() => f.service.enqueueOwnerNotification({ ...notificationInput(f), sourceId: 'other-source', withdrawable: true, withdrawalHandle: binding.handle }))
      .toThrowError(expect.objectContaining({ code: 'policy-denied' }))
    expect(() => f.service.enqueueOwnerNotification({ ...notificationInput(f), withdrawalHandle: binding.handle }))
      .toThrowError(expect.objectContaining({ code: 'policy-denied' }))
    binding.unregister()
    expect(() => f.service.enqueueOwnerNotification({ ...notificationInput(f), withdrawable: true, withdrawalHandle: binding.handle }))
      .toThrowError(expect.objectContaining({ code: 'policy-denied' }))
    expect(f.store.listOutbox({ bindingId: f.binding.id })).toHaveLength(0)
  })

  test('a throwing withdrawal check fails closed and never sends', async () => {
    const f = await fixture()
    const { binding } = withdrawalAuthority(f).register(() => { throw new Error('boom') })
    const queued = f.service.enqueueOwnerNotification({ ...notificationInput(f), withdrawable: true, withdrawalHandle: binding.handle })
    await drain(f)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.store.getOutbox(queued.id)).toMatchObject({ status: 'retry_wait', failureCode: 'native-notice-withdrawal-unavailable' })
  })

  test('a notice queued without withdrawable ignores the withdrawal registry', async () => {
    const f = await fixture()
    withdrawalAuthority(f).register(() => true)
    const queued = f.service.enqueueOwnerNotification(notificationInput(f))
    await drain(f)
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.store.getOutbox(queued.id)).toMatchObject({ status: 'accepted' })
  })

  test('inspects an owner notice by key only through the live handle of the authority that queued it', async () => {
    const f = await fixture()
    const { binding } = withdrawalAuthority(f).register(() => false)
    const plain = f.service.enqueueOwnerNotification(notificationInput(f, { idempotencyKey: 'plain-notice' }))
    const queued = f.service.enqueueOwnerNotification({ ...notificationInput(f), withdrawable: true, withdrawalHandle: binding.handle })
    const inspect = (input: Partial<{ sourceId: string; idempotencyKey: string; withdrawalHandle: string }>) => f.service.inspectOwnerNotification({
      sourceId: 'proactive-engine', idempotencyKey: 'notice-1', withdrawalHandle: binding.handle, ...input })
    expect(inspect({})).toEqual({ outboxId: queued.id, status: 'pending' })
    expect(plain.id).toEqual(expect.any(String))
    expect(inspect({ idempotencyKey: 'plain-notice' })).toBeUndefined()
    expect(inspect({ idempotencyKey: 'missing' })).toBeUndefined()
    expect(() => inspect({ sourceId: 'other-source' })).toThrowError(expect.objectContaining({ code: 'runtime-conflict' }))
    expect(() => inspect({ withdrawalHandle: 'not-a-handle' })).toThrowError(expect.objectContaining({ code: 'runtime-conflict' }))
    expect(() => inspect({ idempotencyKey: '' })).toThrowError(expect.objectContaining({ code: 'runtime-conflict' }))
  })
})
