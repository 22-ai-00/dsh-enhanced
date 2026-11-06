import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { Config, apply, name, version } from '../src/index.ts'
import type { OwnerConsoleService } from '../src/service.ts'
import type { SettingsDescriptor, SettingsService } from '../src/settings.ts'
import { TYPERT } from '../src/typert.ts'
import { readTrendSnapshots } from '../src/service.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}
const defaults = { feishuAppId: '' }

type Entry = { ns: string, value: Record<string, unknown> }

function fakeSettings(entries: Entry[]) {
  const mutate = vi.fn(async () => undefined)
  const descriptors = (): readonly SettingsDescriptor[] => entries.map(entry => ({
    ns: entry.ns, schema: {}, value: entry.value, revision: 3, applies: 'live',
  }))
  return { service: { describe: descriptors, mutate } satisfies SettingsService, entries, mutate }
}

type FakeLoader = { entries: Map<string, { updated: unknown[], refreshed: number }> }

async function mount(settings?: SettingsService, loader?: FakeLoader, manager?: unknown, lark?: unknown) {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  if (settings !== undefined) ctx.provide('settings' as never, settings as never)
  if (lark !== undefined) ctx.provide('larkChannel' as never, lark as never)
  // The handle mode requires the keychain provider; the fixture only checks that
  // the reference path is reachable, not the provider's own behaviour.
  ctx.provide('credentialsKeychain' as never, {} as never)
  if (manager !== undefined) ctx.provide('pluginManager' as never, manager as never)
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
    expect(() => Config({ feishuAppId: 5 } as never)).toThrow()
  })

  it('keeps every remote wire order equal to its Host method parameter order', () => {
    // Typert dispatch is positional: parameters.map(p => named[p.wire]) is applied
    // to the service method, so the declared order must match the implementation.
    const wires = (id: string) => TYPERT.invocations.find(invocation => invocation.id === id)!
      .parameters.map(parameter => parameter.wire)
    expect(wires('@dsh-enhanced/owner-console#ownerConsole/configureFeishu'))
      .toEqual(['appId', 'appSecretEnv', 'credentialHandle', 'account', 'tenant', 'discoverAppId'])
    expect(wires('@dsh-enhanced/owner-console#ownerConsole/configureTraex')).toEqual(['enabled', 'command'])
    expect(wires('@dsh-enhanced/owner-console#ownerConsole/configureBundle')).toEqual(['entry', 'config'])
    expect(wires('@dsh-enhanced/owner-console#ownerConsole/setBundleEnabled')).toEqual(['name', 'enabled'])
    expect(wires('@dsh-enhanced/owner-console#ownerConsole/setPluginEnabled')).toEqual(['entryId', 'enabled'])
    expect(wires('@dsh-enhanced/owner-console#ownerConsole/installProjectBundle')).toEqual(['spec'])
    expect(wires('@dsh-enhanced/owner-console#ownerConsole/removeProjectBundle')).toEqual(['name'])
    expect(wires('@dsh-enhanced/owner-console#ownerConsole/trendSnapshots')).toEqual(['planId', 'beforeSequence', 'limit'])
  })

  it('reports absent entries, strict providers and no fabricated connection', async () => {
    const { ctx, console } = await mount()
    try {
      const status = await console.status()
      expect(status.feishu).toEqual({ mode: 'env', installed: false, enabled: false, appIdConfigured: false, connected: false, connection: 'absent' })
      expect(status.traex).toEqual({ installed: false, enabled: false, command: '' })
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
      const status = await console.status()
      expect(status.feishu).toMatchObject({ entry: 'dsh-enhanced-lark-channel', enabled: true, appIdConfigured: true })
      expect(status.traex).toEqual({ entry: 'dsh-enhanced-traex-acp-provider', installed: false, enabled: false, command: 'traex' })
      expect(status.bundles).toEqual([])
      expect(status.plugins).toEqual([])
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
      expect((await mounted.console.status()).feishu).toMatchObject({ mode: 'env' })
    } finally {
      await mounted.ctx.fiber.dispose()
    }
    const handleMode = fakeSettings([{ ns: 'dsh-enhanced-lark-channel',
      value: { enabled: true, appId: 'cli_0123456789abcdef', credentialHandle: 'owner-handle', secretSource: 'handle' } }])
    const second = await mount(handleMode.service)
    try {
      expect((await second.console.status()).feishu).toMatchObject({ mode: 'handle' })
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
      await expect(console.configureFeishu('cli_0123456789abcdef', 'LARK_APP_SECRET', '', '', '', false))
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
      // The secret source is derived from the reference the owner actually filled.
      await expect(console.configureFeishu('cli_0123456789abcdef', '', 'owner-handle', '', '', false))
        .resolves.toMatchObject({ applied: true })
      expect(lark.mutate).toHaveBeenLastCalledWith('dsh-enhanced-lark-channel', [
        { op: 'set', path: ['enabled'], value: true },
        { op: 'set', path: ['appId'], value: 'cli_0123456789abcdef' },
        { op: 'set', path: ['account'], value: 'owner-acct' },
        { op: 'set', path: ['tenant'], value: 'owner-tenant' },
        { op: 'unset', path: ['appSecretEnv'] },
        { op: 'set', path: ['secretSource'], value: 'handle' },
        { op: 'set', path: ['credentialHandle'], value: 'owner-handle' },
      ], 3)
      const envMissing = await console.configureFeishu('cli_0123456789abcdef', 'MISSING_SECRET', '', '', '', false)
      expect(envMissing.applied).toBe(false)
      expect(envMissing.note).toContain('MISSING_SECRET')
      const both = await console.configureFeishu('cli_0123456789abcdef', 'A', 'handle', '', '', false)
      expect(both).toMatchObject({ applied: false })
      expect(both.note).toMatch(/二选一/u)
      expect((await console.configureFeishu('nope', 'A', '', '', '', false)).note).toMatch(/appId/u)
      expect((await console.configureFeishu('', 'A', '', '', '', true)).note).toMatch(/LARK_APP_ID/u)
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

  it('lists and toggles only this project\'s bundles and loaded entries', async () => {
    const manager = {
      listBundles: vi.fn(async () => [
        { name: '@dsh-enhanced/lark-channel', version: '0.1.65', enabled: true, installed: true, removable: true, optional: false },
        { name: '@dsh-enhanced/traex-acp-provider', version: '0.1.65', enabled: false, installed: true, removable: true, optional: false },
        { name: 'other-package', enabled: true, installed: true, removable: true, optional: false },
      ]),
      listPlugins: vi.fn(async () => [
        { entryId: 'lark-entry', moduleName: '@dsh-enhanced/lark-channel', enabled: true, fiberPhase: 'active' as const },
        { entryId: 'foreign-entry', moduleName: '@deepseek-ai/dsh-base', enabled: true, fiberPhase: 'active' as const },
      ]),
      setBundleEnabled: vi.fn(async (name: string) => ({ changed: true, application: 'applied' as const, target: name, enabled: true })),
      setPluginEnabled: vi.fn(async (entryId: string) => ({ changed: true, application: 'restart-required' as const, target: entryId, enabled: false })),
      installBundle: vi.fn(async (spec: string) => ({ changed: true, application: 'applied' as const, target: spec, enabled: true })),
      removeBundle: vi.fn(async (name: string) => ({ changed: true, application: 'applied' as const, target: name, enabled: false })),
    }
    const { ctx, console } = await mount(undefined, undefined, manager)
    try {
      const status = await console.status()
      expect(status.bundles.map(item => item.name))
        .toEqual(['@dsh-enhanced/lark-channel', '@dsh-enhanced/traex-acp-provider'])
      expect(status.plugins).toEqual([{ entryId: 'lark-entry', moduleName: '@dsh-enhanced/lark-channel', enabled: true, fiberPhase: 'active' }])
      expect(status.feishu.installed).toBe(true)
      expect(status.traex.installed).toBe(true)
      expect(status.bundles[0]).toMatchObject({ enabled: true, installed: true, removable: true })
      await expect(console.setBundleEnabled('@dsh-enhanced/lark-channel', false)).resolves.toMatchObject({ applied: true })
      expect((await console.setBundleEnabled('other-package', false)).applied).toBe(false)
      const toggled = await console.setPluginEnabled('lark-entry', false)
      expect(toggled.applied).toBe(true)
      expect(toggled.note).toMatch(/restart-required|重启/u)
      expect((await console.setPluginEnabled('foreign-entry', false)).applied).toBe(false)
      await expect(console.installProjectBundle('@dsh-enhanced/hello')).resolves.toMatchObject({ applied: true })
      expect(manager.installBundle).toHaveBeenCalledWith('@dsh-enhanced/hello', { enabled: true, saveExact: true })
      expect((await console.installProjectBundle('./local-path')).applied).toBe(false)
      await expect(console.removeProjectBundle('@dsh-enhanced/lark-channel')).resolves.toMatchObject({ applied: true, entry: '@dsh-enhanced/lark-channel' })
      expect(manager.removeBundle).toHaveBeenCalledWith('@dsh-enhanced/lark-channel')
      expect((await console.removeProjectBundle('other-package')).applied).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not count a non-bundle dependency row as installed', async () => {
    const manager = {
      listBundles: vi.fn(async () => [
        { name: '@dsh-enhanced/lark-channel', enabled: true, installed: true, removable: false, optional: false, error: { code: 'not-bundle' } },
      ]),
      listPlugins: vi.fn(async () => []),
    }
    const { ctx, console } = await mount(undefined, undefined, manager)
    try {
      const status = await console.status()
      expect(status.feishu.installed).toBe(false)
      expect(status.traex.installed).toBe(false)
      // A not-bundle dependency must not appear as a manageable bundle row.
      expect(status.bundles).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports the lark-channel health snapshot instead of mere service presence', async () => {
    const cases: ReadonlyArray<readonly [unknown, Record<string, unknown>]> = [
      [{ state: 'connected', gapGeneration: 0 }, { connected: true, connection: 'connected' }],
      [{ state: 'connected-with-gap', gapGeneration: 2 }, { connected: true, connection: 'connected-with-gap' }],
      [{ state: 'reconnecting', gapGeneration: 1, lastErrorCode: 'rate_limited' },
        { connected: false, connection: 'reconnecting', lastErrorCode: 'rate_limited' }],
      [{ state: 'disabled', gapGeneration: 0 }, { connected: false, connection: 'disabled' }],
      // Unknown states and error codes are dropped rather than passed to the panel.
      [{ state: 'online', gapGeneration: 0 }, { connected: false, connection: 'unknown' }],
      [{ state: 'absent', gapGeneration: 0 }, { connected: false, connection: 'unknown' }],
      [{ state: 'disconnected', gapGeneration: 0, lastErrorCode: 'token=secret' }, { connected: false, connection: 'disconnected' }],
      [null, { connected: false, connection: 'unknown' }],
    ]
    for (const [health, expected] of cases) {
      const probe = vi.fn(() => health)
      const { ctx, console } = await mount(undefined, undefined, undefined, { health: probe })
      try {
        const feishu = (await console.status()).feishu
        expect(feishu).toMatchObject(expected)
        if (!('lastErrorCode' in expected)) expect(feishu).not.toHaveProperty('lastErrorCode')
        expect(probe).toHaveBeenCalledOnce()
        expect(JSON.stringify(feishu)).not.toContain('secret')
      } finally {
        await ctx.fiber.dispose()
      }
    }
  })

  it('reports an inactive or health-less lark-channel as loaded with unknown state', async () => {
    for (const provider of [{ health: () => { throw new Error('inactive') } }, {}]) {
      const { ctx, console } = await mount(undefined, undefined, undefined, provider)
      try {
        expect((await console.status()).feishu).toMatchObject({ connected: false, connection: 'unknown' })
      } finally {
        await ctx.fiber.dispose()
      }
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

const D = (c: string) => c.repeat(64)
function snapshotRecord(sequence: number, overrides: Record<string, unknown> = {}) {
  return { sequence, sealedAt: 5_000 + sequence, snapshot: {
    protocol: 'dsh-created-capability-ordinary-use-trend-snapshot/v1', causal: false, planId: 'plan', receiptDigest: D('a'),
    inputsDigest: D('b'), trendDigest: D('c'), digest: D('d'),
    window: { windowMs: 86_400_000, preWindows: 2, postWindows: 2, startExclusive: 10, endInclusive: 20, complete: false },
    models: [], flags: ['partial-window'],
    trend: { causal: false, cohorts: { treatedSessions: 3, controlSessions: 4 }, rowsDigest: D('e'), strata: [
      { model: { state: 'frozen', provider: 'supplier', model: 'task-model', reasoningEffort: 'high' },
        differenceInDifferences: { status: 'estimated', estimate: 0.17, adjustedEstimate: 0.14, standardError: 0.2,
          interval95: { low: -0.27, high: 0.55 } }, parallelTrend: { status: 'not-flagged', testedWindows: 2, gapChange: 0 } },
      { model: { state: 'missing' }, differenceInDifferences: { status: 'insufficient' },
        parallelTrend: { status: 'untestable', testedWindows: 0 } }] },
    ...overrides } }
}

describe('owner console trend snapshots (read-only)', () => {
  it('reports absent without a control plane', () => {
    expect(readTrendSnapshots(undefined, '', 0, 10)).toEqual({ state: 'absent', causal: false, items: [] })
  })

  it('maps one bounded page and forwards only the read query', () => {
    const read = vi.fn(() => ({ protocol: 'dsh-created-capability-ordinary-use-trend-snapshot-list/v1', causal: false,
      items: [snapshotRecord(2)], nextBeforeSequence: 2 }))
    const provider = { inspectCreatedCapabilityOrdinaryUseTrendSnapshots: read, sealCreatedCapabilityOrdinaryUseTrendSnapshot: vi.fn() }
    const page = readTrendSnapshots(provider, ' plan ', 7, 10)
    expect(read).toHaveBeenCalledExactlyOnceWith({ planId: 'plan', beforeSequence: 7, limit: 10 })
    expect(provider.sealCreatedCapabilityOrdinaryUseTrendSnapshot).not.toHaveBeenCalled()
    expect(page).toEqual({ state: 'ok', causal: false, nextBeforeSequence: 2, items: [{
      sequence: 2, sealedAt: 5_002, planId: 'plan', digest: D('d'), inputsDigest: D('b'), trendDigest: D('c'),
      window: { windowMs: 86_400_000, preWindows: 2, postWindows: 2, startExclusive: 10, endInclusive: 20, complete: false },
      cohorts: { treatedSessions: 3, controlSessions: 4 }, flags: ['partial-window'], strata: [
        { model: { state: 'frozen', provider: 'supplier', model: 'task-model', reasoningEffort: 'high' },
          differenceInDifferences: { status: 'estimated', estimate: 0.17, low: -0.27, high: 0.55 }, parallelTrend: 'not-flagged' },
        { model: { state: 'missing' }, differenceInDifferences: { status: 'insufficient' }, parallelTrend: 'untestable' }] }] })
    readTrendSnapshots(provider, '', 0, 100)
    expect(read).toHaveBeenLastCalledWith({ limit: 100 })
  })

  it('reports unverifiable for refused queries, tampered rows or a causal claim', () => {
    const unverifiable = { state: 'unverifiable', causal: false, items: [] }
    const page = (items: unknown[]) => ({ inspectCreatedCapabilityOrdinaryUseTrendSnapshots: () => ({ causal: false, items }) })
    // The control plane returns undefined when a stored row fails its digest check.
    expect(readTrendSnapshots({ inspectCreatedCapabilityOrdinaryUseTrendSnapshots: () => undefined }, '', 0, 10)).toEqual(unverifiable)
    expect(readTrendSnapshots({ inspectCreatedCapabilityOrdinaryUseTrendSnapshots: () => { throw new Error('x') } }, '', 0, 10))
      .toEqual(unverifiable)
    expect(readTrendSnapshots({}, '', 0, 10)).toEqual(unverifiable)
    expect(readTrendSnapshots(page([snapshotRecord(1, { causal: true })]), '', 0, 10)).toEqual(unverifiable)
    expect(readTrendSnapshots(page([snapshotRecord(1, { digest: 'nope' })]), '', 0, 10)).toEqual(unverifiable)
    expect(readTrendSnapshots(page([]), '', 0, 0)).toEqual(unverifiable)
    expect(readTrendSnapshots(page([]), '', 0, 101)).toEqual(unverifiable)
    expect(readTrendSnapshots(page([]), '', -1, 10)).toEqual(unverifiable)
    expect(readTrendSnapshots(page([]), '', 0, 10)).toEqual({ state: 'ok', causal: false, items: [] })
  })
})
