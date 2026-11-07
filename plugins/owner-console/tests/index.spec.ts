import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Config, apply, name, version } from '../src/index.ts'
import type { OwnerConsoleService } from '../src/service.ts'
import type { SettingsDescriptor, SettingsService } from '../src/settings.ts'
import { OwnerConsoleStatusSchema, TYPERT, WRITE_RESULT } from '../src/typert.ts'
import { applyInstall, blockedBuildNames, readIntakeAgreement, readIntakeAgreementAvailability, readTrendSnapshots } from '../src/service.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
  peerDependencies: Record<string, string>
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

async function mount(settings?: SettingsService, loader?: FakeLoader, manager?: unknown, lark?: unknown,
  keychain: unknown = {}) {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  if (settings !== undefined) ctx.provide('settings' as never, settings as never)
  if (lark !== undefined) ctx.provide('larkChannel' as never, lark as never)
  // The handle mode requires the keychain provider; by default it exposes no listHandles, so the
  // existence check fails soft. A supplied probe exercises the verified path.
  ctx.provide('credentialsKeychain' as never, keychain as never)
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

  it('declares the verified 0.2 DSH line so the live app can install it', () => {
    for (const name of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/dsh-typert-registry']) {
      expect(manifest.peerDependencies[name]).toBe('>=0.2.1-rc.2 <0.3.0')
    }
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
    expect(wires('@dsh-enhanced/owner-console#ownerConsole/installProjectBundle')).toEqual(['spec', 'approvedBuilds'])
    expect(wires('@dsh-enhanced/owner-console#ownerConsole/removeProjectBundle')).toEqual(['name'])
    expect(wires('@dsh-enhanced/owner-console#ownerConsole/trendSnapshots')).toEqual(['planId', 'beforeSequence', 'limit'])
    expect(wires('@dsh-enhanced/owner-console#ownerConsole/intakeAgreement')).toEqual(['workspace', 'preset'])
  })

  it('reports absent entries, strict providers and no fabricated connection', async () => {
    const { ctx, console } = await mount()
    try {
      const status = await console.status()
      expect(status.feishu).toEqual({ mode: 'env', installed: false, enabled: false, appIdConfigured: false, connected: false, connection: 'absent' })
      expect(status.traex).toEqual({ installed: false, enabled: false, command: '' })
      expect(status.dependencies.map(item => item.name)).toEqual(['assistantPolicy', 'assistantDelivery', 'assistantSkills'])
      expect(status.dependencies.every(item => item.available === false)).toBe(true)
      expect(status.evaluation).toEqual({ intakeAgreement: 'absent' })
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
      installBundle: vi.fn(async (spec: string, _options?: unknown) => ({ changed: true, application: 'applied' as const, target: spec, enabled: true })),
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

const ESC = '\u001b'
/** pnpm 11's own failure line, decorated with the colour escapes the Host forwards verbatim. */
const ANSI_BUILD_BLOCKED = `${ESC}[41m${ESC}[31m[${ESC}[39m${ESC}[49m${ESC}[41m${ESC}[30mERR_PNPM_IGNORED_BUILDS${ESC}[39m${ESC}[49m${ESC}[41m${ESC}[31m${ESC}[39m${ESC}[49m ${ESC}[31mIgnored build scripts: protobufjs@7.6.6${ESC}[39m\n\nRun "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.\n`

function fakeManager(install: (spec: string, options?: unknown) => unknown) {
  return {
    listBundles: vi.fn(async () => []),
    listPlugins: vi.fn(async () => []),
    installBundle: vi.fn(async (spec: string, options?: unknown) => {
      const result = await install(spec, options)
      return result as never
    }),
  }
}

describe('owner console install failures', () => {
  it('reads build names out of pnpm\'s coloured refusal even when the Host recorded none', async () => {
    const manager = fakeManager(() => ({ changed: false, application: 'failed', target: '@dsh-enhanced/lark-channel',
      error: { code: 'operation-error', diagnostic: ANSI_BUILD_BLOCKED }, pendingBuilds: [],
      packageResult: { kind: 'build-blocked', exitCode: 1 } }))
    const { ctx, console } = await mount(undefined, undefined, manager)
    try {
      const refused = await console.installProjectBundle(' @dsh-enhanced/lark-channel ')
      expect(refused).toMatchObject({ applied: false, entry: '@dsh-enhanced/lark-channel' })
      // pnpm named the script; the panel offers the owner an approval for exactly that name.
      expect(refused.pendingBuilds).toEqual(['protobufjs@7.6.6'])
      expect(refused.note).toContain('protobufjs@7.6.6')
      expect(refused.note).toContain('allowBuilds')
      expect(refused.note).not.toContain(ESC)
      expect(manager.installBundle).toHaveBeenCalledExactlyOnceWith('@dsh-enhanced/lark-channel',
        { enabled: true, saveExact: true })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('writes the confirmed names to the profile when the Host holds no pending approval', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owner-console-builds-'))
    const manager = fakeManager((_spec, options) => {
      if ((options as { approvedBuilds?: readonly string[] }).approvedBuilds !== undefined) {
        return { changed: false, application: 'failed', target: '@dsh-enhanced/lark-channel',
          error: { code: 'stale-approval', diagnostic: 'not pending' }, pendingBuilds: [] }
      }
      return manager.installBundle.mock.calls.length === 1
        ? { changed: false, application: 'failed', target: '@dsh-enhanced/lark-channel',
          error: { code: 'operation-error', diagnostic: ANSI_BUILD_BLOCKED }, pendingBuilds: [],
          packageResult: { kind: 'build-blocked', exitCode: 1 } }
        : { changed: true, application: 'restart-required', target: '@dsh-enhanced/lark-channel' }
    })
    const { ctx, console } = await mount(undefined, undefined, manager)
    ctx.provide('profileContext' as never, { dir } as never)
    try {
      const refused = await console.installProjectBundle('@dsh-enhanced/lark-channel')
      expect(refused.pendingBuilds).toEqual(['protobufjs@7.6.6'])
      const retried = await console.installProjectBundle('@dsh-enhanced/lark-channel', ['protobufjs@7.6.6'])
      expect(retried).toMatchObject({ applied: true, entry: '@dsh-enhanced/lark-channel' })
      expect(manager.installBundle).toHaveBeenLastCalledWith('@dsh-enhanced/lark-channel',
        { enabled: true, saveExact: true })
      expect(await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('protobufjs@7.6.6: true')
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps the Host-recorded build names and pre-writes exactly those on a confirmed retry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owner-console-builds-'))
    const manager = fakeManager(() => (manager.installBundle.mock.calls.length === 1
      ? { changed: false, application: 'failed', target: '@dsh-enhanced/lark-channel',
        error: { code: 'operation-error', diagnostic: ANSI_BUILD_BLOCKED }, pendingBuilds: ['protobufjs@7.6.6'],
        packageResult: { kind: 'build-blocked', exitCode: 1 } }
      : { changed: true, application: 'restart-required', target: '@dsh-enhanced/lark-channel' }))
    const { ctx, console } = await mount(undefined, undefined, manager)
    ctx.provide('profileContext' as never, { dir } as never)
    try {
      const refused = await console.installProjectBundle('@dsh-enhanced/lark-channel')
      expect(refused).toMatchObject({ applied: false, pendingBuilds: ['protobufjs@7.6.6'] })
      expect(refused.note).toContain('确认允许')
      const retried = await console.installProjectBundle('@dsh-enhanced/lark-channel', ['protobufjs@7.6.6'])
      expect(retried).toMatchObject({ applied: true, entry: '@dsh-enhanced/lark-channel' })
      // The names are written before the retry; the Host never sees an approval flag it might reject.
      expect(await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('protobufjs@7.6.6: true')
      expect(manager.installBundle).toHaveBeenLastCalledWith('@dsh-enhanced/lark-channel',
        { enabled: true, saveExact: true })
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports a compatibility refusal with the exact package and runtime versions', async () => {
    const manager = fakeManager(() => ({ changed: false, application: 'failed', target: '@dsh-enhanced/traex-acp-provider',
      error: { code: 'incompatible-version', incompatible: [{ name: '@dsh-enhanced/traex-acp-provider', version: '0.1.65',
        runtimeVersion: '0.2.2-rc.1', requirements: { '@deepseek-ai/dsh-llm': '0.2.1-rc.2' } }] } }))
    const { ctx, console } = await mount(undefined, undefined, manager)
    try {
      const refused = await console.installProjectBundle('@dsh-enhanced/traex-acp-provider')
      expect(refused.applied).toBe(false)
      expect(refused.note).toContain('@dsh-enhanced/traex-acp-provider@0.1.65')
      expect(refused.note).toContain('@deepseek-ai/dsh-llm 0.2.1-rc.2')
      expect(refused.note).toContain('0.2.2-rc.1')
      expect(refused.note).toContain('兼容豁免')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects malformed approvals before touching the Host manager', async () => {
    const manager = fakeManager(() => ({ changed: true, application: 'applied', target: '@dsh-enhanced/lark-channel' }))
    const { ctx, console } = await mount(undefined, undefined, manager)
    try {
      for (const names of [[''], ['pkg*'], ['pkg\n2'], ['x'.repeat(201)],
        Array.from({ length: 65 }, (_value, index) => `pkg${String(index)}`)]) {
        expect((await console.installProjectBundle('@dsh-enhanced/lark-channel', names)).applied).toBe(false)
      }
      expect(manager.installBundle).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reads build names out of coloured, plain and hostile pnpm output', () => {
    expect(blockedBuildNames(ANSI_BUILD_BLOCKED)).toEqual(['protobufjs@7.6.6'])
    expect(blockedBuildNames('   Ignored build scripts: esbuild@0.21.5, @scope/native.')).toEqual(['esbuild@0.21.5', '@scope/native'])
    expect(blockedBuildNames('Ignored build scripts: esbuild@1, esbuild@1')).toEqual(['esbuild@1'])
    expect(blockedBuildNames('Ignored build scripts: *')).toEqual([])
    expect(blockedBuildNames('nothing to see')).toEqual([])
    expect(blockedBuildNames('')).toEqual([])
  })

  it('bounds a generic diagnostic instead of echoing the whole pnpm log', () => {
    const bounded = applyInstall({ changed: false, application: 'failed', target: '@dsh-enhanced/lark-channel',
      error: { code: 'operation-error', diagnostic: `${ESC}[31m${'x'.repeat(4_000)}${ESC}[39m` },
      packageResult: { kind: 'network', exitCode: 1 } })
    expect(bounded.applied).toBe(false)
    expect(bounded.note).toContain('operation-error')
    expect(bounded.note).not.toContain(ESC)
    expect(bounded.note.length).toBeLessThan(800)
  })

  it('keeps the approval list bounded on the wire', async () => {
    expect(WRITE_RESULT.safeParse({ applied: false, entry: 'e', note: 'n', pendingBuilds: ['protobufjs@7.6.6'] }).success).toBe(true)
    const many = Array.from({ length: 65 }, (_value, index) => `pkg${String(index)}`)
    expect(WRITE_RESULT.safeParse({ applied: false, entry: 'e', note: 'n', pendingBuilds: many }).success).toBe(false)
    // A Host list the wire would reject is bounded by the service instead of failing the whole result.
    const hostile = [...many, '', 'line\nbreak', 'x'.repeat(201)]
    const manager = fakeManager(() => ({ changed: false, application: 'failed', target: '@dsh-enhanced/lark-channel',
      error: { code: 'operation-error', diagnostic: ANSI_BUILD_BLOCKED }, pendingBuilds: hostile,
      packageResult: { kind: 'build-blocked', exitCode: 1 } }))
    const { ctx, console } = await mount(undefined, undefined, manager)
    try {
      const result = await console.installProjectBundle('@dsh-enhanced/lark-channel')
      expect(result.pendingBuilds).toHaveLength(64)
      expect(WRITE_RESULT.safeParse(result).success).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

const larkBundle = (overrides: Record<string, unknown> = {}) => ({
  name: '@dsh-enhanced/lark-channel', enabled: true, installed: true, removable: true, optional: false,
  rows: [{ rowId: 'dsh-enhanced-lark-channel', moduleName: '@dsh-enhanced/lark-channel' }], ...overrides,
})
const traexBundle = (overrides: Record<string, unknown> = {}) => ({
  name: '@dsh-enhanced/traex-acp-provider', enabled: true, installed: true, removable: true, optional: false,
  rows: [{ rowId: 'dsh-enhanced-traex-acp-provider', moduleName: '@dsh-enhanced/traex-acp-provider' }], ...overrides,
})
const managerWith = (bundles: readonly unknown[], plugins: readonly unknown[] = []) => ({
  listBundles: vi.fn(async () => bundles),
  listPlugins: vi.fn(async () => plugins),
})

describe('owner console honest status and configuration repair', () => {
  it('keeps errored bundles visible and isolates a rejecting inventory read', async () => {
    const manager = managerWith([
      larkBundle({ error: { code: 'incompatible-version', diagnostic: 'pins 0.2.1-rc.2' } }),
      { name: '@dsh-enhanced/helper', enabled: true, installed: true, removable: false, optional: false,
        error: { code: 'not-bundle' } },
    ], [{ entryId: 'lark', moduleName: '@dsh-enhanced/lark-channel', enabled: true, fiberPhase: 'failed',
      diagnostic: 'cannot inject assistantDelivery' }])
    const mounted = await mount(undefined, undefined, manager)
    try {
      const status = await mounted.console.status()
      // Only the not-bundle dependency row is filtered; an incompatible installed bundle stays visible.
      expect(status.bundles.map(bundle => bundle.name)).toEqual(['@dsh-enhanced/lark-channel'])
      expect(status.bundles[0]!.error).toEqual({ code: 'incompatible-version', diagnostic: 'pins 0.2.1-rc.2' })
      expect(status.bundles[0]!.rows).toEqual([{ rowId: 'dsh-enhanced-lark-channel', moduleName: '@dsh-enhanced/lark-channel' }])
      expect(status.plugins[0]!.diagnostic).toBe('cannot inject assistantDelivery')
      expect(status.host).toMatchObject({ pluginManager: true, bundles: 'ok', plugins: 'ok' })
    } finally {
      await mounted.ctx.fiber.dispose()
    }

    const broken = {
      listBundles: vi.fn(async () => { throw new Error('bundle list exploded') }),
      listPlugins: vi.fn(async () => [{ entryId: 'lark', moduleName: '@dsh-enhanced/lark-channel', enabled: true, fiberPhase: 'active' }]),
    }
    const partial = await mount(undefined, undefined, broken)
    try {
      const status = await partial.console.status()
      // The rejecting list is reported, the other list still answers, and neither looks like "absent".
      expect(status.host).toMatchObject({ bundles: 'failed', plugins: 'ok' })
      expect(status.host.diagnostic).toContain('bundle list exploded')
      expect(status.bundles).toEqual([])
      expect(status.plugins).toHaveLength(1)
    } finally {
      await partial.ctx.fiber.dispose()
    }
  })

  it('reports an absent Host plugin manager instead of claiming nothing is installed', async () => {
    const mounted = await mount()
    try {
      const status = await mounted.console.status()
      expect(status.host).toMatchObject({ settings: false, pluginManager: false, bundles: 'unavailable', plugins: 'unavailable' })
    } finally {
      await mounted.ctx.fiber.dispose()
    }
  })

  it('does not claim a reload it could not verify', async () => {
    let active = true
    const settings = {
      describe: () => active ? [{ ns: 'dsh-enhanced-traex-acp-provider', schema: {}, value: { enabled: false, command: 'traex' },
        revision: 1, applies: 'live' as const }] : [],
      mutate: vi.fn(async () => { active = false }),
    } satisfies SettingsService
    const loader: FakeLoader = { entries: new Map([['dsh-enhanced-traex-acp-provider', { updated: [], refreshed: 0 }]]) }
    const mounted = await mount(settings, loader)
    try {
      const result = await mounted.console.configureTraex(true, '')
      expect(result.applied).toBe(true)
      expect(result.note).toContain('未能确认条目已恢复加载')
      expect(result.note).not.toContain('条目已重新加载')
    } finally {
      await mounted.ctx.fiber.dispose()
    }
  })

  it('forwards pending build names and the pnpm log path on every failure branch', () => {
    const logPath = '/Users/owner/.dsh/profiles/desktop/.plugin-manager/logs/operation-x/pnpm.log'
    const generic = applyInstall({ changed: false, application: 'failed', target: '@dsh-enhanced/lark-channel',
      error: { code: 'operation-error', diagnostic: 'network down' }, pendingBuilds: ['protobufjs@7.6.6'],
      packageResult: { kind: 'network', exitCode: 1, logPath } })
    expect(generic.pendingBuilds).toEqual(['protobufjs@7.6.6'])
    expect(generic.note).toContain(logPath)
    const incompatible = applyInstall({ changed: false, application: 'failed', target: '@dsh-enhanced/traex-acp-provider',
      error: { code: 'incompatible-version', incompatible: [{ name: '@dsh-enhanced/traex-acp-provider', version: '0.1.65',
        runtimeVersion: '0.2.2-rc.1', requirements: { '@deepseek-ai/dsh-llm': '0.2.1-rc.2' } }] },
      pendingBuilds: ['esbuild@1'], packageResult: { logPath } })
    expect(incompatible.pendingBuilds).toEqual(['esbuild@1'])
    expect(incompatible.note).toContain(logPath)
  })

  it('verifies keychain handles when the provider can list them, and fails soft otherwise', async () => {
    const lark = fakeSettings([{ ns: 'dsh-enhanced-lark-channel',
      value: { enabled: false, appId: 'cli_0123456789abcdef', account: 'owner', tenant: 'tenant' } }])
    const missing = await mount(lark.service, undefined, undefined, undefined, { listHandles: () => [{ id: 'other-handle' }] })
    try {
      const result = await missing.console.configureFeishu('cli_0123456789abcdef', '', 'missing-handle', 'owner', 'tenant', false)
      expect(result.applied).toBe(false)
      expect(result.note).toContain('没有 handle "missing-handle"')
      expect(result.note).toContain('other-handle')
      expect(lark.mutate).not.toHaveBeenCalled()
    } finally {
      await missing.ctx.fiber.dispose()
    }
    const failing = await mount(lark.service, undefined, undefined, undefined, { listHandles: () => { throw new Error('keychain down') } })
    try {
      const result = await failing.console.configureFeishu('cli_0123456789abcdef', '', 'fine-handle', 'owner', 'tenant', false)
      expect(result.applied).toBe(true)
      expect(result.note).toContain('未能校验 keychain handle')
    } finally {
      await failing.ctx.fiber.dispose()
    }
  })

  it('maps settings.mutate refusals and repairs a stalled target instead of the generic refusal', async () => {
    const entries = fakeSettings([{ ns: 'dsh-enhanced-other', value: {} }])
    const volatile = { ...entries.service, mutate: vi.fn(async () => { throw new Error('Config field "blob" is not volatile') }) }
    const mapped = await mount(volatile)
    try {
      const result = await mapped.console.configureBundle('dsh-enhanced-other', { blob: 1 })
      expect(result.applied).toBe(false)
      expect(result.note).toContain('字段不能实时修改')
      expect(result.note).toContain('blob')
    } finally {
      await mapped.ctx.fiber.dispose()
    }
    const conflict = { ...entries.service, mutate: vi.fn(async () => { throw new Error('settings namespace "x" changed since it was read') }) }
    const raced = await mount(conflict)
    try {
      expect((await raced.console.configureBundle('dsh-enhanced-other', { enabled: false })).note).toContain('CAS 冲突')
    } finally {
      await raced.ctx.fiber.dispose()
    }

    // Installed + enabled but its fiber failed: show the phase, diagnostic, missing bundles and repair.
    const manager = managerWith([larkBundle(), traexBundle()],
      [{ entryId: 'lark', moduleName: '@dsh-enhanced/lark-channel', enabled: true, fiberPhase: 'failed',
        diagnostic: 'cannot inject assistantDelivery' },
      { entryId: 'traex', moduleName: '@dsh-enhanced/traex-acp-provider', enabled: true, fiberPhase: 'pending' }])
    const stalled = await mount(fakeSettings([]).service, undefined, manager)
    try {
      const result = await stalled.console.configureBundle('dsh-enhanced-lark-channel', { enabled: false })
      expect(result.applied).toBe(false)
      expect(result.note).toContain('已启用但未加载')
      expect(result.note).toContain('failed')
      expect(result.note).toContain('cannot inject assistantDelivery')
      expect(result.note).toContain('@dsh-enhanced/assistant-delivery')
      expect(result.note).toContain('disabled: true')
      // The same repair context answers the Feishu card's generic target refusal.
      const feishu = await stalled.console.configureFeishu('cli_0123456789abcdef', 'LARK_APP_SECRET', '', 'owner', 'tenant', false)
      expect(feishu.note).toContain('已启用但未加载')
      expect((await stalled.console.configureTraex(true, '')).note).toContain('已启用但未加载')
    } finally {
      await stalled.ctx.fiber.dispose()
    }

    // Active fiber but the entry exposes no live field in describe(): say that, not "not loaded".
    const active = await mount(fakeSettings([]).service, undefined,
      managerWith([larkBundle()], [{ entryId: 'lark', moduleName: '@dsh-enhanced/lark-channel', enabled: true, fiberPhase: 'active' }]))
    try {
      expect((await active.console.configureBundle('dsh-enhanced-lark-channel', { enabled: false })).note)
        .toContain('没有声明任何可实时修改的配置字段')
    } finally {
      await active.ctx.fiber.dispose()
    }

    // Installed but the bundle layer is not selected: the honest next step is 启用, not 安装/配置.
    const disabled = await mount(fakeSettings([]).service, undefined, managerWith([larkBundle({ enabled: false }), traexBundle({ enabled: false })]))
    try {
      expect((await disabled.console.configureTraex(true, '')).note).toContain('已安装但未启用')
    } finally {
      await disabled.ctx.fiber.dispose()
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

function agreementCell(overrides: Record<string, unknown> = {}) {
  return { notifications: 4, items: 3, outcomes: { pending: 1, delivered: 0, reacted: 1, accepted: 1, rejected: 1, 'expired-unhandled': 0, failed: 0 },
    agreed: 2, disagreed: 1, agreementPpm: 666_667, ...overrides }
}
function agreement(overrides: Record<string, unknown> = {}) {
  return { protocol: 'assistant-evaluation/intake-attention-agreement/v1', causal: false, scope: { workspace: '/work/alpha', preset: 'primary' },
    fromNotifiedAt: 1_000, toNotifiedAt: 2_000, scanned: 6, truncated: false, provenanceAvailable: true, notIntake: 1, unresolved: 0, foreign: 1,
    intake: agreementCell(), byLevel: { accept: agreementCell(), notify: agreementCell({ notifications: 0, items: 0, agreed: 0, disagreed: 0, agreementPpm: null,
      outcomes: { pending: 0, delivered: 0, reacted: 0, accepted: 0, rejected: 0, 'expired-unhandled': 0, failed: 0 } }) }, ...overrides }
}

describe('owner console intake agreement (read-only)', () => {
  it('reports absent without Evaluation and disabled while its switch is off', () => {
    expect(readIntakeAgreement(undefined, '/work/alpha', 'primary')).toEqual({ state: 'absent', causal: false })
    const read = vi.fn(() => undefined)
    expect(readIntakeAgreement({ inspectIntakeAttentionAgreement: read }, '/work/alpha', 'primary')).toEqual({ state: 'disabled', causal: false })
    expect(read).toHaveBeenCalledExactlyOnceWith({ scope: { workspace: '/work/alpha', preset: 'primary' } })
  })

  it('maps the counts in level order and forwards only the trimmed scope', () => {
    const read = vi.fn(() => agreement())
    const provider = { inspectIntakeAttentionAgreement: read, attentionTuningAdopt: vi.fn() }
    const result = readIntakeAgreement(provider, ' /work/alpha ', ' primary ')
    expect(read).toHaveBeenCalledExactlyOnceWith({ scope: { workspace: '/work/alpha', preset: 'primary' } })
    expect(provider.attentionTuningAdopt).not.toHaveBeenCalled()
    expect(result.state).toBe('ok')
    expect(result.causal).toBe(false)
    expect(result.summary).toMatchObject({ fromNotifiedAt: 1_000, toNotifiedAt: 2_000, scanned: 6, truncated: false, provenanceAvailable: true,
      notIntake: 1, unresolved: 0, foreign: 1, intake: agreementCell() })
    expect(result.summary!.byLevel.map(entry => entry.level)).toEqual(['notify', 'accept'])
    expect(result.summary!.byLevel[0]!.cell.agreementPpm).toBeNull()
    // Counts only: the scope echo and protocol never reach the panel.
    expect(JSON.stringify(result)).not.toContain('/work/alpha')
  })

  it('reports unverifiable for an empty scope, a refused read, a causal claim or an odd shape', () => {
    const unverifiable = { state: 'unverifiable', causal: false }
    const provider = (value: unknown) => ({ inspectIntakeAttentionAgreement: () => value })
    const read = vi.fn(() => agreement())
    expect(readIntakeAgreement({ inspectIntakeAttentionAgreement: read }, ' ', 'primary')).toEqual(unverifiable)
    expect(readIntakeAgreement({ inspectIntakeAttentionAgreement: read }, '/work/alpha', '')).toEqual(unverifiable)
    expect(read).not.toHaveBeenCalled()
    expect(readIntakeAgreement({}, '/work/alpha', 'primary')).toEqual(unverifiable)
    expect(readIntakeAgreement({ inspectIntakeAttentionAgreement: () => { throw new Error('invalid-input') } }, '/work/alpha', 'primary')).toEqual(unverifiable)
    expect(readIntakeAgreement(provider(agreement({ causal: true })), '/work/alpha', 'primary')).toEqual(unverifiable)
    expect(readIntakeAgreement(provider(agreement({ protocol: 'other/v1' })), '/work/alpha', 'primary')).toEqual(unverifiable)
    expect(readIntakeAgreement(provider(agreement({ scanned: -1 })), '/work/alpha', 'primary')).toEqual(unverifiable)
    expect(readIntakeAgreement(provider(agreement({ intake: agreementCell({ agreementPpm: 2_000_000 }) })), '/work/alpha', 'primary')).toEqual(unverifiable)
    expect(readIntakeAgreement(provider(agreement({ intake: agreementCell({ outcomes: { accepted: 1 } }) })), '/work/alpha', 'primary')).toEqual(unverifiable)
    expect(readIntakeAgreement(provider(null), '/work/alpha', 'primary')).toEqual(unverifiable)
    expect(readIntakeAgreement(provider(agreement({ scanned: Number.NaN })), '/work/alpha', 'primary')).toEqual(unverifiable)
    const hostile = agreement()
    Object.defineProperty(hostile, 'scanned', { get() { throw new Error('getter') } })
    expect(readIntakeAgreement(provider(hostile), '/work/alpha', 'primary')).toEqual(unverifiable)
  })

  it('reports unverifiable for a field-valid answer whose counts contradict each other', () => {
    const provider = (value: unknown) => ({ inspectIntakeAttentionAgreement: () => value })
    const unverifiable = { state: 'unverifiable', causal: false }
    for (const overrides of [
      { intake: agreementCell({ agreed: 3 }) },
      { intake: agreementCell({ disagreed: 0 }) },
      { intake: agreementCell({ agreementPpm: 0 }) },
      { intake: agreementCell({ notifications: 5 }) },
      { intake: agreementCell({ items: 5 }) },
      { scanned: 3 },
      { fromNotifiedAt: 2_000 },
      { byLevel: { accept: agreementCell(), digest: agreementCell() } },
    ]) {
      expect(readIntakeAgreement(provider(agreement(overrides)), '/work/alpha', 'primary')).toEqual(unverifiable)
    }
    expect(readIntakeAgreement(provider(agreement()), '/work/alpha', 'primary').state).toBe('ok')
  })
})

const evaluationEntry = (config: unknown, extra: Record<string, unknown> = {}) =>
  ({ id: 'include:eval', options: { id: 'dsh-enhanced-assistant-evaluation', name: '@dsh-enhanced/assistant-evaluation', config, ...extra },
    refresh: async () => undefined })
const loaderOf = (...entries: unknown[]) => ({ entries: () => entries })

describe('owner console intake agreement availability (scope-free)', () => {
  it('reports absent, disabled and available without calling Evaluation', () => {
    const read = vi.fn(() => { throw new Error('must not scan') })
    const provider = { inspectIntakeAttentionAgreement: read }
    expect(readIntakeAgreementAvailability(undefined, loaderOf(evaluationEntry({ intakeAttentionAgreementEnabled: true })))).toBe('absent')
    expect(readIntakeAgreementAvailability(null, undefined)).toBe('absent')
    // Evaluation defaults the switch off, so a missing key is disabled.
    expect(readIntakeAgreementAvailability(provider, loaderOf(evaluationEntry({ databasePath: '/secret/evaluation.sqlite' })))).toBe('disabled')
    expect(readIntakeAgreementAvailability(provider, loaderOf(evaluationEntry(undefined)))).toBe('disabled')
    expect(readIntakeAgreementAvailability(provider, loaderOf(evaluationEntry({ intakeAttentionAgreementEnabled: false })))).toBe('disabled')
    expect(readIntakeAgreementAvailability(provider, loaderOf(
      evaluationEntry({ intakeAttentionAgreementEnabled: false }, { disabled: true }),
      evaluationEntry({ intakeAttentionAgreementEnabled: true }),
      { id: 'other', options: { id: 'other', name: '@dsh-enhanced/lark-channel', config: { intakeAttentionAgreementEnabled: false } } },
    ))).toBe('available')
    expect(read).not.toHaveBeenCalled()
  })

  it('reports unknown when the read or its switch cannot be determined', () => {
    const provider = { inspectIntakeAttentionAgreement: () => undefined }
    const on = evaluationEntry({ intakeAttentionAgreementEnabled: true })
    expect(readIntakeAgreementAvailability({}, loaderOf(on))).toBe('unknown')
    expect(readIntakeAgreementAvailability(provider, undefined)).toBe('unknown')
    expect(readIntakeAgreementAvailability(provider, {})).toBe('unknown')
    expect(readIntakeAgreementAvailability(provider, loaderOf())).toBe('unknown')
    expect(readIntakeAgreementAvailability(provider, loaderOf(on, evaluationEntry({})))).toBe('unknown')
    expect(readIntakeAgreementAvailability(provider, loaderOf(evaluationEntry({ intakeAttentionAgreementEnabled: 'yes' })))).toBe('unknown')
    expect(readIntakeAgreementAvailability(provider, { entries: () => { throw new Error('loader down') } })).toBe('unknown')
  })

  it('surfaces only the availability enum in status, never scope, counts or config', async () => {
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    const read = vi.fn(() => agreement())
    ctx.provide('assistantEvaluation' as never, { inspectIntakeAttentionAgreement: read } as never)
    ctx.provide('loader' as never, loaderOf(evaluationEntry({ intakeAttentionAgreementEnabled: true,
      databasePath: '/secret/evaluation.sqlite' })) as never)
    apply(ctx, Config(defaults))
    try {
      const status = await (ctx.get('ownerConsole' as never) as unknown as OwnerConsoleService).status()
      expect(status.evaluation).toEqual({ intakeAgreement: 'available' })
      expect(Object.isFrozen(status.evaluation)).toBe(true)
      expect(OwnerConsoleStatusSchema.safeParse(status).success).toBe(true)
      expect(read).not.toHaveBeenCalled()
      expect(JSON.stringify(status)).not.toContain('/secret')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
