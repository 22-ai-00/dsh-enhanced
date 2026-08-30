import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, test, vi } from 'vitest'
import plugin, { apply, Config, LarkChannelService, inject, name, version } from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
  bin: Record<string, string>
  files: string[]
  peerDependencies: Record<string, string>
  devDependencies: Record<string, string>
}

describe('dsh-enhanced-lark-channel entrypoint', () => {
  test('exports stable identity, injection, service, and config', () => {
    expect(name).toBe('dsh-enhanced-lark-channel')
    expect(version).toBe(manifest.version)
    expect(inject).toEqual(['assistantDelivery'])
    expect(plugin).toMatchObject({ name, inject, Config, apply })
    expect(Config).toBe(LarkChannelService.Config)
  })

  test('ships stable setup bin wrappers that exist before lib is built', () => {
    expect(manifest.bin).toEqual({
      'dsh-lark-setup': './bin/dsh-lark-setup.js',
      'dsh-supervised-growth-setup': './bin/dsh-supervised-growth-setup.js',
    })
    expect(manifest.files).toContain('bin')
    for (const path of Object.values(manifest.bin)) {
      expect(readFileSync(new URL(`..${path.slice(1)}`, import.meta.url), 'utf8')).toMatch(/^#!\/usr\/bin\/env node/u)
    }
  })

  test('does not couple the channel or supervised activator to a specific model provider', () => {
    expect(manifest.peerDependencies).not.toHaveProperty('@dsh-enhanced/traex-acp-provider')
    expect(manifest.devDependencies).not.toHaveProperty('@dsh-enhanced/traex-acp-provider')
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
