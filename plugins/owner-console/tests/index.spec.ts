import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { Config, apply, name, version } from '../src/index.ts'
import type { OwnerConsoleService } from '../src/service.ts'
import type { SettingsDescriptor, SettingsService } from '../src/settings.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}
const defaults = { feishuMode: 'lark-cli' as const, feishuAppId: '', enableTraex: false }

type Entry = { ns: string, value: Record<string, unknown> }

function fakeSettings(entries: Entry[]) {
  const update = vi.fn(async () => undefined)
  const descriptors = (): readonly SettingsDescriptor[] => entries.map(entry => ({
    ns: entry.ns, schema: {}, value: entry.value, revision: 3, applies: 'live',
  }))
  return { service: { describe: descriptors, update } satisfies SettingsService, entries, update }
}

async function mount(settings?: SettingsService) {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  if (settings !== undefined) ctx.provide('settings' as never, settings as never)
  apply(ctx, Config(defaults))
  return { ctx, console: ctx.get('ownerConsole' as never) as unknown as OwnerConsoleService }
}

describe('dsh-enhanced-owner-console', () => {
  it('exposes stable identity and conservative defaults', () => {
    expect(name).toBe('dsh-enhanced-owner-console')
    expect(version).toBe(manifest.version)
    expect(Config({} as never)).toEqual(defaults)
    expect(() => Config({ feishuMode: 'webhook' } as never)).toThrow()
  })

  it('reports absent entries, strict providers and no fabricated connection', async () => {
    const { ctx, console } = await mount()
    try {
      const status = console.status()
      expect(status.feishu).toEqual({
        mode: 'lark-cli', enabled: false, appIdConfigured: false, connected: false,
        setupCommand: expect.stringContaining('dsh-lark-setup --profile'),
      })
      expect(status.traex).toEqual({ enabled: false, command: '' })
      expect(status.dependencies.map(item => item.name)).toEqual(['assistantPolicy', 'assistantDelivery', 'assistantSkills'])
      expect(status.dependencies.every(item => item.available === false)).toBe(true)
      expect(status.bundles).toEqual([])
      expect(Object.isFrozen(status)).toBe(true)
      expect(ctx.get('ownerConsole' as never)).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
    expect(ctx.get('ownerConsole' as never)).toBeUndefined()
  })

  it('reads the real entries and never surfaces secret values', async () => {
    const lark = fakeSettings([
      { ns: 'dsh-enhanced-lark-channel', value: { enabled: true, appId: 'cli_0123456789abcdef', account: 'owner', appSecretEnv: 'LARK_APP_SECRET' } },
      { ns: 'dsh-enhanced-traex-acp-provider', value: { enabled: false, command: 'traex' } },
      { ns: 'dsh-enhanced-other', value: { enabled: true } },
      { ns: 'personal-assistant', value: { enabled: true } },
    ])
    const { ctx, console } = await mount(lark.service)
    try {
      const status = console.status()
      expect(status.feishu).toMatchObject({ entry: 'dsh-enhanced-lark-channel', enabled: true, appIdConfigured: true })
      expect(status.traex).toEqual({ entry: 'dsh-enhanced-traex-acp-provider', enabled: false, command: 'traex' })
      expect(status.bundles.map(item => item.entry))
        .toEqual(['dsh-enhanced-lark-channel', 'dsh-enhanced-traex-acp-provider', 'dsh-enhanced-other'])
      expect(JSON.stringify(status)).not.toContain('LARK_APP_SECRET')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('writes exactly one lark-channel entry with a secret reference, never plaintext', async () => {
    const lark = fakeSettings([{ ns: 'dsh-enhanced-lark-channel', value: {} }])
    const { ctx, console } = await mount(lark.service)
    try {
      await expect(console.configureFeishu('app', 'cli_0123456789abcdef', 'LARK_APP_SECRET', '', '', ''))
        .resolves.toMatchObject({ applied: true, entry: 'dsh-enhanced-lark-channel' })
      expect(lark.update).toHaveBeenCalledWith('dsh-enhanced-lark-channel', {
        enabled: true, appId: 'cli_0123456789abcdef', account: 'feishu', tenant: 'feishu', appSecretEnv: 'LARK_APP_SECRET',
      }, 3)
      await expect(console.configureFeishu('app', 'cli_0123456789abcdef', '', '', '', ''))
        .rejects.toThrow(/exactly one secret reference/u)
      await expect(console.configureFeishu('app', 'cli_0123456789abcdef', 'A', 'handle', '', ''))
        .rejects.toThrow(/exactly one secret reference/u)
      await expect(console.configureFeishu('app', 'nope', 'A', '', '', '')).rejects.toThrow(/appId/u)
      await expect(console.configureFeishu('lark-cli', '', 'A', '', '', '')).rejects.toThrow(/一键模式/u)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('toggles only the TraeX entry and bounds its command line', async () => {
    const traex = fakeSettings([{ ns: 'dsh-enhanced-traex-acp-provider', value: {} }])
    const { ctx, console } = await mount(traex.service)
    try {
      await expect(console.configureTraex(true, 'traex')).resolves.toMatchObject({ applied: true })
      expect(traex.update).toHaveBeenCalledWith('dsh-enhanced-traex-acp-provider', { enabled: true, command: 'traex' }, 3)
      await expect(console.configureTraex(false, '')).resolves.toMatchObject({ applied: true })
      await expect(console.configureTraex(true, 'a\nb')).rejects.toThrow(/one bounded line/u)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('configures only this project\'s bundle entries with a bounded object', async () => {
    const bundles = fakeSettings([
      { ns: 'dsh-enhanced-other', value: {} },
      { ns: 'personal-assistant', value: {} },
    ])
    const { ctx, console } = await mount(bundles.service)
    try {
      await expect(console.configureBundle('dsh-enhanced-other', { enabled: false }))
        .resolves.toMatchObject({ applied: true, entry: 'dsh-enhanced-other' })
      expect(bundles.update).toHaveBeenCalledWith('dsh-enhanced-other', { enabled: false }, 3)
      await expect(console.configureBundle('personal-assistant', { enabled: false })).rejects.toThrow(/dsh-enhanced/u)
      await expect(console.configureBundle('dsh-enhanced-missing', {})).rejects.toThrow(/not installed/u)
      await expect(console.configureBundle('dsh-enhanced-other', [] as never)).rejects.toThrow(/JSON object/u)
      await expect(console.configureBundle('dsh-enhanced-other', { blob: 'x'.repeat(20_000) })).rejects.toThrow(/too large/u)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses to write when the Host settings service is absent', async () => {
    const { ctx, console } = await mount()
    try {
      await expect(console.configureTraex(true, '')).rejects.toThrow(/settings service is unavailable/u)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
