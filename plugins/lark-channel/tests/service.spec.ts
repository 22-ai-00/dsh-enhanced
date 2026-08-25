import { Context } from '@deepseek-ai/cordis'
import { describe, expect, test, vi } from 'vitest'
import { signLarkApprovalAction } from '../src/approval.ts'
import { LarkChannelService } from '../src/service.ts'
import type { DeliveryAdapter, DeliveryAdapterContext } from '@dsh-enhanced/assistant-delivery'
import type { LarkTransport, LarkTransportHandlers } from '../src/types.ts'

function transport(): LarkTransport {
  return {
    subscribe: vi.fn((_handlers: LarkTransportHandlers) => () => {}),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    addReaction: vi.fn(async () => 'reaction-1'),
    createProgress: vi.fn(async () => ({ cotId: 'cot-1', messageId: 'om_cot' })),
    writeProgress: vi.fn(async () => {}),
    send: vi.fn(async () => ({ messageId: 'om_sent' })),
  }
}

describe('Lark Cordis service', () => {
  test('resolves a named environment secret once and registers the thin adapter', async () => {
    const ctx = new Context()
    const unregister = vi.fn(async () => {})
    const adapterContext: DeliveryAdapterContext = {
      accept: vi.fn(async () => ({ duplicate: false, inboxId: 'inbox-1', status: 'queued' as const })),
      receipt: vi.fn(async () => {}),
    }
    const registerAdapter = vi.fn(async (adapter: DeliveryAdapter) => {
      const dispose = await adapter.start(adapterContext)
      return async () => { await dispose?.(); await unregister() }
    })
    ctx.provide('assistantDelivery', { registerAdapter })
    const channel = transport()
    const createTransport = vi.fn((input: { appSecret: string; imageDownloadTimeoutMs: number }) => {
      expect(input.appSecret).toBe('super-secret-value')
      expect(input.imageDownloadTimeoutMs).toBe(30_000)
      return channel
    })
    const service = new LarkChannelService(ctx, {
      enabled: true, account: 'primary', tenant: 'tenant-a', appId: 'cli_0123456789abcdef', appSecretEnv: 'LARK_APP_SECRET',
    }, { env: { LARK_APP_SECRET: 'super-secret-value' }, createTransport })
    await service.whenReady()
    expect(registerAdapter).toHaveBeenCalledOnce()
    expect(service.health()).toMatchObject({ state: 'connected', gapGeneration: 0 })
    expect(JSON.stringify(service.health())).not.toContain('super-secret')
    await ctx.fiber.restart()
    expect(unregister).toHaveBeenCalledOnce()
  })

  test('wires expired authenticated callbacks to delivery settlement recovery', async () => {
    const ctx = new Context()
    const secret = 'super-secret-value-for-approval-recovery'
    let handlers: LarkTransportHandlers | undefined
    const channel = transport()
    channel.subscribe = vi.fn((value: LarkTransportHandlers) => {
      handlers = value
      return () => { handlers = undefined }
    })
    const settleApproval = vi.fn()
    const recoverApprovalSettlement = vi.fn(() => ({ status: 'approved' as const }))
    ctx.provide('assistantDelivery', {
      settleApproval,
      recoverApprovalSettlement,
      registerAdapter: async (adapter: DeliveryAdapter) => {
        const dispose = await adapter.start({ accept: vi.fn(), receipt: vi.fn() } as unknown as DeliveryAdapterContext)
        return async () => { await dispose?.() }
      },
    })
    const service = new LarkChannelService(ctx, {
      enabled: true, account: 'primary', tenant: 'tenant-a', appId: 'cli_0123456789abcdef',
      appSecretEnv: 'LARK_APP_SECRET',
    }, { env: { LARK_APP_SECRET: secret }, createTransport: () => channel })
    await service.whenReady()
    const expiresAt = Date.now() - 1
    const token = signLarkApprovalAction(secret, {
      version: 2, channel: 'lark', account: 'primary', tenant: 'tenant-a', operationId: 'operation-recovery',
      bindingId: 'binding-1', proposalId: 'proposal-1', expectedVersion: 1, expiresAt,
      chatId: 'oc_owner', diffHash: 'a'.repeat(64), decision: 'approved',
    })

    await handlers?.cardAction({ messageId: 'om_card', chatId: 'oc_owner', operatorId: 'ou_owner',
      value: { approval: token } })
    expect(settleApproval).not.toHaveBeenCalled()
    expect(recoverApprovalSettlement).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'operation-recovery', callbackChatId: 'oc_owner', bindingId: 'binding-1',
      proposalId: 'proposal-1', expectedVersion: 1, diffHash: 'a'.repeat(64), decision: 'approved',
    }))
    await ctx.fiber.restart()
  })

  test('fails closed for missing delivery service or missing/empty secret', () => {
    const config = { enabled: true, account: 'primary', tenant: 'tenant-a', appId: 'cli_0123456789abcdef',
      appSecretEnv: 'LARK_APP_SECRET' }
    expect(() => new LarkChannelService(new Context(), config, { env: {}, createTransport: () => transport() }))
      .toThrow(/assistantDelivery/i)
    const missing = new Context()
    missing.provide('assistantDelivery', { registerAdapter: vi.fn() })
    expect(() => new LarkChannelService(missing, config, { env: {}, createTransport: () => transport() }))
      .toThrow(/LARK_APP_SECRET/)
    const empty = new Context()
    empty.provide('assistantDelivery', { registerAdapter: vi.fn() })
    expect(() => new LarkChannelService(empty, config, {
      env: { LARK_APP_SECRET: '   ' }, createTransport: () => transport(),
    })).toThrow(/LARK_APP_SECRET/)
  })

  test('is safely installable while disabled without resolving credentials or opening a connection', async () => {
    const ctx = new Context()
    const registerAdapter = vi.fn()
    ctx.provide('assistantDelivery', { registerAdapter })
    const createTransport = vi.fn(() => transport())
    const service = new LarkChannelService(ctx, {
      account: 'primary', tenant: 'replace-me', appId: 'cli_0000000000000000', appSecretEnv: 'LARK_APP_SECRET',
    }, { env: {}, createTransport })
    await service.whenReady()
    expect(service.health()).toEqual({ state: 'disabled', gapGeneration: 0 })
    expect(registerAdapter).not.toHaveBeenCalled()
    expect(createTransport).not.toHaveBeenCalled()
    await ctx.fiber.restart()
  })

  test('holds adapter lifecycle inside an audited credential-handle callback', async () => {
    const ctx = new Context()
    const adapterContext: DeliveryAdapterContext = {
      accept: vi.fn(async () => ({ duplicate: false, inboxId: 'inbox-1', status: 'queued' as const })),
      receipt: vi.fn(async () => {}),
    }
    const unregister = vi.fn(async () => {})
    ctx.provide('assistantDelivery', {
      registerAdapter: async (adapter: DeliveryAdapter) => {
        const dispose = await adapter.start(adapterContext)
        return async () => { await dispose?.(); await unregister() }
      },
    })
    const withSecret = vi.fn(async <T>(caller: Context, request: { handleId: string; purpose: string },
      callback: (value: string, signal: AbortSignal, lease: { id: string; handleId: string; consumer: string;
        purpose: string; expiresAt: number }) => Promise<T>) => {
      expect(caller.fiber.name).toBe('dsh-enhanced-lark-channel')
      expect(request).toMatchObject({ handleId: 'lark-app-secret', purpose: 'connect' })
      return callback('leased-secret', new AbortController().signal, { id: 'lease-1', handleId: 'lark-app-secret',
        consumer: caller.fiber.name, purpose: 'connect', expiresAt: Date.now() + 3_600_000 })
    })
    ctx.provide('credentialsKeychain', { withSecret })
    const channel = transport()
    let service!: LarkChannelService
    const Plugin = {
      name: 'dsh-enhanced-lark-channel', inject: ['assistantDelivery'],
      apply(scoped: Context) {
        service = new LarkChannelService(scoped, { enabled: true, account: 'primary', tenant: 'tenant-a',
          appId: 'cli_0123456789abcdef', credentialHandle: 'lark-app-secret', credentialLeaseMs: 3_600_000 },
        { env: {}, createTransport: input => { expect(input.appSecret).toBe('leased-secret'); return channel } })
      },
    }
    const fiber = await ctx.plugin(Plugin)
    await service.whenReady()
    expect(withSecret).toHaveBeenCalledOnce()
    expect(service.health()).toMatchObject({ state: 'connected' })
    await fiber.dispose()
    expect(unregister).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  test('renews a naturally expired credential lease without surviving operator revocation semantics', async () => {
    const ctx = new Context()
    const adapterContext: DeliveryAdapterContext = {
      accept: vi.fn(async () => ({ duplicate: false, inboxId: 'inbox-1', status: 'queued' as const })),
      receipt: vi.fn(async () => {}),
    }
    const disconnects: Array<ReturnType<typeof vi.fn>> = []
    ctx.provide('assistantDelivery', {
      registerAdapter: async (adapter: DeliveryAdapter) => {
        const dispose = await adapter.start(adapterContext)
        return async () => { await dispose?.() }
      },
    })
    const leaseControllers: AbortController[] = []
    const withSecret = vi.fn(async <T>(
      _caller: Context,
      _request: { idempotencyKey: string },
      callback: (value: string, signal: AbortSignal) => Promise<T>,
    ) => {
      const controller = new AbortController()
      leaseControllers.push(controller)
      const result = callback('leased-secret', controller.signal)
      if (leaseControllers.length === 1) {
        queueMicrotask(() => {
          const reason = Object.assign(new Error('credential lease expired'), {
            name: 'CredentialLeaseAbortError', code: 'expired',
          })
          controller.abort(reason)
        })
      }
      return result
    })
    ctx.provide('credentialsKeychain', { withSecret })
    let service!: LarkChannelService
    const Plugin = {
      name: 'dsh-enhanced-lark-channel', inject: ['assistantDelivery', 'credentialsKeychain'],
      apply(scoped: Context) {
        service = new LarkChannelService(scoped, {
          enabled: true, account: 'primary', tenant: 'tenant-a', appId: 'cli_0123456789abcdef',
          credentialHandle: 'lark-app-secret', credentialLeaseMs: 3_600_000,
        }, { createTransport: () => {
          const channel = transport()
          disconnects.push(channel.disconnect as ReturnType<typeof vi.fn>)
          return channel
        } })
      },
    }

    const fiber = await ctx.plugin(Plugin)
    await service.whenReady()
    await vi.waitFor(() => expect(withSecret).toHaveBeenCalledTimes(2))
    expect(disconnects).toHaveLength(2)
    expect(disconnects[0]).toHaveBeenCalledOnce()
    await fiber.dispose()
    expect(disconnects[1]).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })
})
