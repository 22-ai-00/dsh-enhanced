import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Config, apply, name, version } from '../src/index.ts'
import type { OwnerConsoleService } from '../src/service.ts'
import type { OwnerConsoleStatus } from '../src/typert.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}

const defaults = { feishuMode: 'lark-cli' as const, feishuAppId: '', enableTraex: false }

describe('dsh-enhanced-owner-console', () => {
  it('exposes stable plugin identity and conservative defaults', () => {
    expect(name).toBe('dsh-enhanced-owner-console')
    expect(version).toBe(manifest.version)
    expect(Config({} as never)).toEqual(defaults)
    expect(Config({ feishuMode: 'app', feishuAppId: 'cli_owner', enableTraex: true }))
      .toEqual({ feishuMode: 'app', feishuAppId: 'cli_owner', enableTraex: true })
    expect(() => Config({ feishuMode: 'webhook' } as never)).toThrow()
  })

  it('registers a read-only status façade that never fabricates a connection', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(TypertRegistry)
      apply(ctx, Config(defaults))
      const console = ctx.get('ownerConsole' as never) as unknown as OwnerConsoleService
      const status = console.status() as OwnerConsoleStatus
      expect(status.feishu).toEqual({ mode: 'lark-cli', connected: false, appIdConfigured: false })
      expect(status.traex).toEqual({ enabled: false })
      expect(status.dependencies.map(item => item.name))
        .toEqual(['assistantPolicy', 'assistantDelivery', 'assistantSkills'])
      expect(status.dependencies.every(item => item.available === false)).toBe(true)
      expect(Object.isFrozen(status)).toBe(true)
      expect(ctx.get('ownerConsole' as never)).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
    expect(ctx.get('ownerConsole' as never)).toBeUndefined()
  })

  it('reports only active providers and never treats a stale registration as connected', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(TypertRegistry)
      ctx.provide('larkChannel' as never, {} as never)
      apply(ctx, Config({ ...defaults, feishuMode: 'app', feishuAppId: 'cli_owner' }))
      const console = ctx.get('ownerConsole' as never) as unknown as OwnerConsoleService
      const status = console.status()
      expect(status.feishu).toEqual({ mode: 'app', connected: true, appIdConfigured: true })
      expect(status.dependencies.every(item => item.available === false)).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the dependency hints out of the identity checks', () => {
    expect(Config({ feishuMode: 'app', feishuAppId: 'x', enableTraex: true }))
      .toMatchObject({ enableTraex: true })
  })
})
