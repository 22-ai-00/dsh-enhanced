import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AssistantDeliveryService, type OwnerRouteAuthority } from '../src/index.ts'
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
})
