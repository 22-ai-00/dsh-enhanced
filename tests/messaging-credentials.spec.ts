import { Context } from '@deepseek-ai/cordis'
import type { DeliveryAdapter, DeliveryAdapterContext } from '@dsh-enhanced/assistant-delivery'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { CredentialsKeychainService } from '@dsh-enhanced/credentials-keychain'
import { LarkChannelService } from '@dsh-enhanced/lark-channel'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

describe('Lark and credential composition', () => {
  test('keeps the live adapter inside an authorized secret-free credential lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-credential-composition-'))
    roots.push(root)
    const ctx = new Context()
    await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: [
      { id: 'lark-credential', effect: 'allow', subject: { kind: 'background', id: 'dsh-enhanced-lark-channel' },
        actions: ['credential.use'], resource: { kind: 'credential', id: 'lark-app-secret' },
        context: { initiators: ['background'] } },
      { id: 'credential-operator', effect: 'allow', subject: { kind: 'external', id: 'local:owner' },
        actions: ['credential.revoke'], resource: { kind: 'credential', id: 'lark-app-secret' },
        context: { initiators: ['foreground'] } },
    ] })
    new CredentialsKeychainService(ctx, {
      databasePath: join(root, 'credentials.sqlite'), handles: [{
        id: 'lark-app-secret', provider: 'environment', environmentName: 'LARK_APP_SECRET',
        consumers: ['dsh-enhanced-lark-channel'], purposes: ['connect'], maxLeaseMs: 60_000,
      }],
    }, { env: { LARK_APP_SECRET: 'composition-secret' } })
    const context: DeliveryAdapterContext = {
      accept: vi.fn(async () => ({ duplicate: false, inboxId: 'inbox-1' })), receipt: vi.fn(async () => {}),
    }
    const disconnect = vi.fn(async () => {})
    ctx.provide('assistantDelivery', {
      registerAdapter: async (adapter: DeliveryAdapter) => {
        const dispose = await adapter.start(context)
        return async () => { await dispose?.() }
      },
    })
    let service!: LarkChannelService
    const Plugin = {
      name: 'dsh-enhanced-lark-channel', inject: ['assistantDelivery'],
      apply(scoped: Context) {
        service = new LarkChannelService(scoped, {
          enabled: true, account: 'primary', tenant: 'tenant-a', appId: 'cli_0123456789abcdef',
          credentialHandle: 'lark-app-secret', credentialLeaseMs: 60_000,
        }, { createTransport: options => {
          expect(options.appSecret).toBe('composition-secret')
          return { subscribe: () => () => {}, connect: async () => {}, disconnect,
            send: async () => ({ messageId: 'om_sent' }) }
        } })
      },
    }
    const larkFiber = await ctx.plugin(Plugin)
    await service.whenReady()
    expect(ctx.credentialsKeychain.health()).toMatchObject({ activeLeases: 1, failedLeases: 0 })
    expect(JSON.stringify(ctx.credentialsKeychain.listLeases())).not.toContain('composition-secret')
    const lease = ctx.credentialsKeychain.listLeases()[0]!
    ctx.credentialsKeychain.revoke({ operatorId: 'owner', leaseId: lease.id,
      expectedVersion: lease.version, reason: 'rotate application secret' })
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledOnce())
    expect(ctx.credentialsKeychain.listLeases()[0]).toMatchObject({ status: 'revoked' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(ctx.credentialsKeychain.listLeases()).toHaveLength(1)
    await larkFiber.dispose()
    expect(disconnect).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })
})
