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
  const mutate = vi.fn(async () => undefined)
  const descriptors = (): readonly SettingsDescriptor[] => entries.map(entry => ({
    ns: entry.ns, schema: {}, value: entry.value, revision: 3, applies: 'live',
  }))
  return { service: { describe: descriptors, mutate } satisfies SettingsService, entries, mutate }
}

type FakeLoader = { entries: Map<string, { updated: unknown[], refreshed: number }> }

async function mount(settings?: SettingsService, loader?: FakeLoader) {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  if (settings !== undefined) ctx.provide('settings' as never, settings as never)
  if (loader !== undefined) {
    ctx.provide('loader' as never, {
      entries: () => [...loader.entries].map(([id, state]) => ({
        id: `include:${id}`, options: { id, config: { enabled: true } },
        fiber: { update: (config: unknown) => { state.updated.push(config) } },
        refresh: async () => { state.refreshed += 1 },
      })),
    } as never)
  }
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

  it('derives the pairing mode from the secret-source discriminator', async () => {
    const envMode = fakeSettings([{ ns: 'dsh-enhanced-lark-channel',
      value: { enabled: true, appId: 'cli_0123456789abcdef', appSecretEnv: 'LARK_APP_SECRET', secretSource: 'env', credentialHandle: 'inherited-handle' } }])
    const mounted = await mount(envMode.service)
    try {
      expect(mounted.console.status().feishu).toMatchObject({ mode: 'lark-cli' })
    } finally {
      await mounted.ctx.fiber.dispose()
    }
    const handleMode = fakeSettings([{ ns: 'dsh-enhanced-lark-channel',
      value: { enabled: true, appId: 'cli_0123456789abcdef', credentialHandle: 'owner-handle', secretSource: 'handle' } }])
    const second = await mount(handleMode.service)
    try {
      expect(second.console.status().feishu).toMatchObject({ mode: 'app' })
    } finally {
      await second.ctx.fiber.dispose()
    }
  })

  it('writes one lark-channel entry with exactly one secret reference and preserves identity', async () => {
    const lark = fakeSettings([{ ns: 'dsh-enhanced-lark-channel', value: { account: 'owner-acct', tenant: 'owner-tenant', credentialHandle: 'old-handle' } }])
    const { ctx, console } = await mount(lark.service)
    try {
      vi.stubEnv('LARK_APP_SECRET', 'present')
      vi.stubEnv('A', 'present')
      await expect(console.configureFeishu('app', 'cli_0123456789abcdef', 'LARK_APP_SECRET', '', '', ''))
        .resolves.toMatchObject({ applied: true, entry: 'dsh-enhanced-lark-channel' })
      expect(lark.mutate).toHaveBeenCalledWith('dsh-enhanced-lark-channel', [
        { op: 'set', path: ['enabled'], value: true },
        { op: 'set', path: ['appId'], value: 'cli_0123456789abcdef' },
        { op: 'set', path: ['account'], value: 'owner-acct' },
        { op: 'set', path: ['tenant'], value: 'owner-tenant' },
        { op: 'set', path: ['appSecretEnv'], value: 'LARK_APP_SECRET' },
        { op: 'set', path: ['secretSource'], value: 'env' },
        { op: 'unset', path: ['credentialHandle'] },
      ], 3)
      const envMissing = await console.configureFeishu('app', 'cli_0123456789abcdef', 'MISSING_SECRET', '', '', '')
      expect(envMissing.applied).toBe(false)
      expect(envMissing.note).toContain('MISSING_SECRET')
      const both = await console.configureFeishu('app', 'cli_0123456789abcdef', 'A', 'handle', '', '')
      expect(both).toMatchObject({ applied: false })
      expect(both.note).toMatch(/二选一/u)
      expect((await console.configureFeishu('app', 'nope', 'A', '', '', '')).note).toMatch(/appId/u)
      expect((await console.configureFeishu('lark-cli', '', 'A', '', '', '')).note).toMatch(/LARK_APP_ID/u)
    } finally {
      vi.unstubAllEnvs()
      await ctx.fiber.dispose()
    }
  })

  it('toggles only the TraeX entry and bounds its command line', async () => {
    const traex = fakeSettings([{ ns: 'dsh-enhanced-traex-acp-provider', value: {} }])
    const { ctx, console } = await mount(traex.service)
    try {
      const loader: FakeLoader = { entries: new Map([['dsh-enhanced-traex-acp-provider', { updated: [], refreshed: 0 }]]) }
      const mounted = await mount(traex.service, loader)
      try {
        await expect(mounted.console.configureTraex(true, 'traex')).resolves.toMatchObject({ applied: true })
        expect(loader.entries.get('dsh-enhanced-traex-acp-provider')).toEqual({ updated: [{ enabled: true }], refreshed: 0 })
      } finally {
        await mounted.ctx.fiber.dispose()
      }
      await expect(console.configureTraex(true, 'traex')).resolves.toMatchObject({ applied: true })
      expect(traex.mutate).toHaveBeenCalledWith('dsh-enhanced-traex-acp-provider', [
        { op: 'set', path: ['enabled'], value: true },
        { op: 'set', path: ['command'], value: 'traex' },
      ], 3)
      await expect(console.configureTraex(false, '')).resolves.toMatchObject({ applied: true })
      expect((await console.configureTraex(true, 'a\nb')).applied).toBe(false)
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
      expect(bundles.mutate).toHaveBeenCalledWith('dsh-enhanced-other', [{ op: 'set', path: ['enabled'], value: false }], 3)
      expect((await console.configureBundle('personal-assistant', { enabled: false })).applied).toBe(false)
      expect((await console.configureBundle('dsh-enhanced-missing', {})).applied).toBe(false)
      expect((await console.configureBundle('dsh-enhanced-other', [] as never)).applied).toBe(false)
      expect((await console.configureBundle('dsh-enhanced-other', { blob: 'x'.repeat(20_000) })).applied).toBe(false)
      expect((await console.configureBundle('dsh-enhanced-other', {})).applied).toBe(false)
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
