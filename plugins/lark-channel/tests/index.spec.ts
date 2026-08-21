import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, test, vi } from 'vitest'
import plugin, { apply, Config, LarkChannelService, inject, name, version } from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

describe('dsh-enhanced-lark-channel entrypoint', () => {
  test('exports stable identity, injection, service, and config', () => {
    expect(name).toBe('dsh-enhanced-lark-channel')
    expect(version).toBe(manifest.version)
    expect(inject).toEqual(['assistantDelivery'])
    expect(plugin).toMatchObject({ name, inject, Config, apply })
    expect(Config).toBe(LarkChannelService.Config)
  })

  test('declares credentialHandle as a conditional Cordis dependency', () => {
    const injectOptional = vi.fn()
    apply({ inject: injectOptional } as unknown as Context, {
      enabled: true,
      account: 'primary',
      tenant: 'tenant-a',
      appId: 'cli_0123456789abcdef',
      credentialHandle: 'lark-app-secret',
    })

    expect(injectOptional).toHaveBeenCalledOnce()
    expect(injectOptional).toHaveBeenCalledWith(['credentialsKeychain'], expect.any(Function))
  })

  test('preserves the stable plugin identity when DSH loads the default export', async () => {
    const ctx = new Context()
    let callerName: string | undefined
    ctx.provide('assistantDelivery', { registerAdapter: vi.fn() })
    ctx.provide('credentialsKeychain', {
      async withSecret(caller: Context) {
        callerName = caller.fiber.name
      },
    })

    const fiber = await ctx.plugin(plugin, {
      enabled: true,
      account: 'primary',
      tenant: 'tenant-a',
      appId: 'cli_0123456789abcdef',
      credentialHandle: 'lark-app-secret',
    })

    expect(callerName).toBe('dsh-enhanced-lark-channel')
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
