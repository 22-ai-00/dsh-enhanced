// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantChatRegistry } from '../src/assistant-chat.ts'
import {
  AutonomyWizardCard, CodingToolsCard, WenyaoSettingsSection,
  type ConsoleRemote,
} from '../src/client.ts'
import type { ConsoleController } from '../src/settings-cards.ts'
import { ModelCatalogReader, readOwnerConsoleModelCatalog } from '../src/model-catalog.ts'
import { resolveEffectiveModelCatalog } from '../src/model-route-ui.ts'
import { CodingToolProber } from '../src/probes.ts'
import { OwnerConsoleService } from '../src/service.ts'
import type { SettingsDescriptor, SettingsService } from '../src/settings.ts'
import {
  AUTONOMY_TIER_DEFAULTS, AssistantChatContextSchema, OwnerConsoleModelCatalogSchema,
  type AutonomySetupStatus, type OwnerConsoleModelCatalog, type OwnerConsoleStatus,
} from '../src/typert.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function fakeSettings(entries: Array<{ ns: string; value: Record<string, unknown> }>) {
  const mutate = vi.fn(async (ns: string, ops: readonly { op: string; path: readonly string[]; value?: unknown }[]) => {
    const target = entries.find(e => e.ns === ns)
    if (!target) throw new Error(`No configurable plugin entry "${ns}"`)
    for (const op of ops) {
      const key = op.path[0]!
      if (op.op === 'set') target.value[key] = op.value
      else if (op.op === 'unset') Reflect.deleteProperty(target.value, key)
    }
  })
  const describe = (): readonly SettingsDescriptor[] => entries.map(entry => ({
    ns: entry.ns, schema: {}, value: { ...entry.value }, revision: 1, applies: 'live',
  }))
  return { service: { describe, mutate } satisfies SettingsService, entries, mutate }
}

function sampleStatus(): OwnerConsoleStatus {
  return {
    feishu: { mode: 'env', installed: true, entry: 'dsh-ray-lark-channel', enabled: true, appIdConfigured: true, connected: true, connection: 'connected' },
    traex: { entry: 'dsh-ray-traex-acp-provider', installed: true, enabled: false, command: 'traex' },
    agy: { entry: 'dsh-ray-traex-acp-provider', installed: true, enabled: true, command: '/Users/owner/.local/bin/agy' },
    defaultModel: { entry: 'agent-default-model', available: true, provider: 'agy-agent', model: 'gemini-4-hydrogen', reasoningEffort: 'high' },
    llmProviders: [
      { id: 'agy-agent', name: 'Antigravity' },
      { id: 'llmgw', name: 'LLMBox Seed' },
    ],
    host: { settings: true, pluginManager: true, bundles: 'ok', plugins: 'ok' },
    dependencies: [],
    evaluation: { intakeAgreement: 'absent' },
    bundles: [],
    plugins: [],
  }
}

function sampleCatalog(): OwnerConsoleModelCatalog {
  return {
    protocol: 'owner-console/model-catalog/v1',
    fetchedAt: 1_760_000_000_000,
    defaultSelection: { provider: 'agy-agent', model: 'gemini-4-hydrogen', reasoningEffort: 'high' },
    providers: [
      {
        id: 'agy-agent',
        name: 'Antigravity ACP',
        kind: 'acp',
        active: true,
        models: [
          { id: 'default', name: 'Antigravity 默认模型', efforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }] },
          { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
          { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }] },
        ],
      },
      {
        id: 'llmgw',
        name: 'LLMBox Seed',
        kind: 'api',
        active: true,
        models: [
          {
            id: 'seed-2.0-pro',
            name: 'Seed 2.0 Pro',
            efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }],
            defaultEffort: 'medium',
          },
          {
            id: 'deepseek-v4',
            name: 'DeepSeek V4',
            efforts: [{ id: 'minimal', name: 'Minimal' }, { id: 'high', name: 'High' }],
          },
        ],
      },
      {
        id: 'traex-agent',
        name: 'TraeX ACP',
        kind: 'acp',
        active: false,
        models: [
          { id: 'default', name: 'TraeX 默认当前模型 (default)', efforts: [{ id: 'low', name: 'low' }, { id: 'medium', name: 'medium' }, { id: 'high', name: 'high' }] },
        ],
        diagnostic: '路由当前未启用；设为默认或启用后自动激活',
      },
    ],
  }
}

describe('Host modelCatalog & scoped assistant chat registration', () => {
  it('aggregates active + dormant providers, isolates provider timeouts/errors, and invalidates cache on route writes', async () => {
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    const settings = fakeSettings([
      { ns: 'dsh-ray-traex-acp-provider', value: { enabled: false, command: 'traex', agyEnabled: true, agyCommand: 'agy' } },
      { ns: 'agent-default-model', value: { provider: 'llmgw', model: 'seed-2.0-pro', reasoningEffort: 'medium' } },
    ])
    ctx.provide('settings' as never, settings.service as never)
    ctx.provide('pluginManager' as never, {
      listBundles: async () => [
        { name: '@dsh-ray/traex-acp-provider', version: '0.1.78', enabled: true, installed: true, removable: true, optional: true, rows: [] },
      ],
      listPlugins: async () => [],
    } as never)

    let catalogFetchCount = 0
    const listModels = vi.fn(async (provider: string) => {
      if (provider === 'llmgw') {
        catalogFetchCount += 1
        return [{ id: 'seed-2.0-pro', name: 'Seed 2.0 Pro' }]
      }
      if (provider === 'hanging-acp') {
        return await new Promise<never>(() => undefined)
      }
      throw new Error('provider offline')
    })
    ctx.provide('llm' as never, {
      listProviders: () => [
        { id: 'llmgw', name: 'LLMBox Seed' },
        { id: 'hanging-acp', name: 'Hanging ACP' },
        { id: 'broken-api', name: 'Broken API' },
      ],
      listConfigurableProviders: () => [
        { provider: 'traex-agent', displayName: 'TraeX ACP' },
        { provider: 'agy-agent', displayName: 'Antigravity ACP' },
      ],
      listModels,
      resolveModelInfo: async (_provider: string, model: string) => {
        if (model === 'seed-2.0-pro') {
          return {
            reasoning: {
              efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }],
              defaultEffort: 'medium',
            },
          }
        }
        return undefined
      },
    } as never)

    const reader = new ModelCatalogReader({ providerTimeoutMs: 40, cacheTtlMs: 30_000 })
    const service = new OwnerConsoleService(ctx, { feishuAppId: '' }, new CodingToolProber(), undefined, reader)
    try {
      const cat1 = await service.modelCatalog(false)
      expect(OwnerConsoleModelCatalogSchema.safeParse(cat1).success).toBe(true)
      expect(cat1.defaultSelection).toEqual({ provider: 'llmgw', model: 'seed-2.0-pro', reasoningEffort: 'medium' })

      const llmgw = cat1.providers.find(p => p.id === 'llmgw')
      expect(llmgw?.active).toBe(true)
      expect(llmgw?.models).toEqual([
        {
          id: 'seed-2.0-pro',
          name: 'Seed 2.0 Pro',
          efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }],
          defaultEffort: 'medium',
        },
      ])

      const hanging = cat1.providers.find(p => p.id === 'hanging-acp')
      expect(hanging?.diagnostic).toContain('timed out')
      const broken = cat1.providers.find(p => p.id === 'broken-api')
      expect(broken?.diagnostic).toContain('provider offline')

      const dormantTraex = cat1.providers.find(p => p.id === 'traex-agent')
      expect(dormantTraex?.active).toBe(false)
      expect(dormantTraex?.models[0]?.id).toBe('default')

      // Cached read within TTL reuses result without calling listModels again.
      const cat2 = await service.modelCatalog(false)
      expect(cat2).toBe(cat1)
      expect(catalogFetchCount).toBe(1)

      // Mutating default route invalidates the cache.
      await service.setDefaultModelRoute('llmgw', 'deepseek-v4', 'high')
      const cat3 = await service.modelCatalog(false)
      expect(cat3).not.toBe(cat1)
      expect(cat3.defaultSelection).toEqual({ provider: 'llmgw', model: 'deepseek-v4', reasoningEffort: 'high' })
      expect(catalogFetchCount).toBe(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('persists assistant sessions under $DSH_HOME (0600) and scopes Wenyao systemPrompt strictly to registered sessions', async () => {
    const dshHome = await realpath(await mkdtemp(join(tmpdir(), 'wenyao-assistant-chat-')))
    const profileDir = join(dshHome, 'profiles', 'desktop')
    const prevHome = process.env['DSH_HOME']
    process.env['DSH_HOME'] = dshHome
    let registeredSection: { name: string; order: number; interpolate?: boolean; text: (arg: unknown) => string } | undefined

    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    ctx.provide('profileContext' as never, { name: 'desktop', dir: profileDir } as never)
    ctx.provide('personalMemory' as never, {} as never)
    ctx.provide('larkChannel' as never, { health: () => ({ state: 'connected' }) } as never)
    ctx.provide('systemPrompt' as never, {
      section: (def: { name: string; order: number; interpolate?: boolean; text: (arg: unknown) => string }) => {
        registeredSection = def
        return () => { registeredSection = undefined }
      },
    } as never)

    const service = new OwnerConsoleService(ctx, { feishuAppId: '' })
    try {
      const initialCtx = await service.assistantChatContext()
      expect(AssistantChatContextSchema.safeParse(initialCtx).success).toBe(true)
      expect(initialCtx.workspace).toBe(join(dshHome, 'assistant-workspace'))
      expect(initialCtx.activeSessionId).toBeNull()
      expect(initialCtx.capabilities.memory).toBe(true)
      expect(initialCtx.capabilities.feishuConnected).toBe(true)

      const reg = await service.registerAssistantSession('session-wenyao-1', true)
      expect(reg.applied).toBe(true)

      const savedFile = join(dshHome, 'owner-console', 'assistant-sessions.json')
      const raw = await readFile(savedFile, 'utf8')
      expect(JSON.parse(raw)).toMatchObject({
        schemaVersion: 1,
        activeSessionId: 'session-wenyao-1',
        sessionIds: ['session-wenyao-1'],
      })
      expect((await stat(savedFile)).mode & 0o777).toBe(0o600)

      expect(registeredSection).toBeDefined()
      expect(registeredSection!.name).toBe('owner-console:wenyao-persona')
      expect(registeredSection!.interpolate).toBe(false)

      // Registered Wenyao session gets the persona; normal coding sessions receive empty string ''.
      const wenyaoPrompt = registeredSection!.text({ agent: { id: 'session-wenyao-1', session: { id: 'session-wenyao-1' } } })
      expect(wenyaoPrompt).toContain('文鳐（Ray / 小鳐）')
      expect(wenyaoPrompt).toContain(join(dshHome, 'assistant-workspace'))
      expect(wenyaoPrompt).toContain('长期记忆（personal-memory）')

      const codingPrompt = registeredSection!.text({ agent: { id: 'coding-session-99', session: { id: 'coding-session-99' } } })
      expect(codingPrompt).toBe('')
      expect(registeredSection!.text(undefined)).toBe('')
    } finally {
      if (prevHome === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = prevHome
      await ctx.fiber.dispose()
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it('registers both systemPrompt.section (wenyao-persona) and systemPrompt.context (wenyao-identity-context, order 130) scoped strictly to Wenyao sessions', async () => {
    const dshHome = await realpath(await mkdtemp(join(tmpdir(), 'wenyao-dual-prompt-')))
    const prevHome = process.env['DSH_HOME']
    process.env['DSH_HOME'] = dshHome
    type PromptDef = { name: string; order: number; interpolate?: boolean; required?: boolean; text: (arg: unknown) => string }
    let registeredSection: PromptDef | undefined
    let registeredContext: PromptDef | undefined
    const disposeSection = vi.fn(() => { registeredSection = undefined })
    const disposeContext = vi.fn(() => { registeredContext = undefined })

    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    ctx.provide('profileContext' as never, { name: 'desktop', dir: join(dshHome, 'profiles', 'desktop') } as never)
    ctx.provide('systemPrompt' as never, {
      section: (def: PromptDef) => {
        registeredSection = def
        return disposeSection
      },
      context: (def: PromptDef) => {
        registeredContext = def
        return disposeContext
      },
    } as never)

    const service = new OwnerConsoleService(ctx, { feishuAppId: '' })
    try {
      await service.registerAssistantSession('session-wenyao-dual', true)

      expect(registeredSection).toBeDefined()
      expect(registeredSection!.name).toBe('owner-console:wenyao-persona')
      expect(registeredSection!.order).toBe(10)
      expect(registeredSection!.interpolate).toBe(false)

      expect(registeredContext).toBeDefined()
      expect(registeredContext!.name).toBe('owner-console:wenyao-identity-context')
      expect(registeredContext!.order).toBe(130)
      expect(registeredContext!.interpolate).toBe(false)
      expect(registeredContext!.required).toBe(true)

      const wenyaoArg = { agent: { id: 'session-wenyao-dual', session: { id: 'session-wenyao-dual' } } }
      expect(registeredSection!.text(wenyaoArg)).toContain('文鳐（Ray / 小鳐）')
      expect(registeredContext!.text(wenyaoArg)).toContain('文鳐（Ray / 小鳐）')
      expect(registeredContext!.text(wenyaoArg)).toContain('"lead"')

      const nonWenyaoArg = { agent: { id: 'coding-session-42', session: { id: 'coding-session-42' } } }
      expect(registeredSection!.text(nonWenyaoArg)).toBe('')
      expect(registeredContext!.text(nonWenyaoArg)).toBe('')
      expect(registeredSection!.text(undefined)).toBe('')
      expect(registeredContext!.text(undefined)).toBe('')
    } finally {
      if (prevHome === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = prevHome
      await ctx.fiber.dispose()
      await rm(dshHome, { recursive: true, force: true })
    }
    expect(disposeSection).toHaveBeenCalledOnce()
    expect(disposeContext).toHaveBeenCalledOnce()
  })

  it('rejects symlinked $DSH_HOME/owner-console without mutating in-memory registry and preserves activeSessionId across 32-session eviction', async () => {
    const dshHome = await realpath(await mkdtemp(join(tmpdir(), 'wenyao-symlink-home-')))
    const outsideDir = await realpath(await mkdtemp(join(tmpdir(), 'wenyao-symlink-outside-')))
    const evictionHome = await realpath(await mkdtemp(join(tmpdir(), 'wenyao-evict-home-')))
    const ctx = new Context()
    try {
      await symlink(outsideDir, join(dshHome, 'owner-console'))
      const symlinkRegistry = new AssistantChatRegistry(ctx, { DSH_HOME: dshHome })

      expect(() => symlinkRegistry.registerSession('sess-evil', true)).toThrow(/unsafe/i)
      expect(symlinkRegistry.hasSession('sess-evil')).toBe(false)
      expect(symlinkRegistry.snapshot()).toEqual({ activeSessionId: null, knownSessionIds: [] })
      expect(await readdir(outsideDir)).toEqual([])

      // Register active session first, then add 35 non-active sessions to trigger >32 eviction.
      const evictRegistry = new AssistantChatRegistry(ctx, { DSH_HOME: evictionHome })
      evictRegistry.registerSession('sess-active', true)
      for (let i = 1; i <= 35; i += 1) {
        evictRegistry.registerSession(`sess-${i}`, false)
      }
      const snap = evictRegistry.snapshot()
      expect(snap.knownSessionIds).toHaveLength(32)
      expect(snap.activeSessionId).toBe('sess-active')
      expect(evictRegistry.hasSession('sess-active')).toBe(true)
      expect(evictRegistry.hasSession('sess-1')).toBe(false)
      expect(evictRegistry.hasSession('sess-35')).toBe(true)

      // Also verify reload from disk keeps an activeSessionId sitting before the trailing 32 entries.
      const reloadFile = join(evictionHome, 'owner-console', 'assistant-sessions.json')
      await mkdir(join(evictionHome, 'owner-console'), { recursive: true })
      await writeFile(reloadFile, JSON.stringify({
        schemaVersion: 1,
        activeSessionId: 'sess-oldest-active',
        sessionIds: ['sess-oldest-active', ...Array.from({ length: 35 }, (_v, idx) => `sess-disk-${idx + 1}`)],
      }), 'utf8')
      const reloaded = new AssistantChatRegistry(ctx, { DSH_HOME: evictionHome })
      const reloadedSnap = reloaded.snapshot()
      expect(reloadedSnap.knownSessionIds).toHaveLength(32)
      expect(reloadedSnap.activeSessionId).toBe('sess-oldest-active')
      expect(reloaded.hasSession('sess-oldest-active')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
      await rm(dshHome, { recursive: true, force: true })
      await rm(outsideDir, { recursive: true, force: true })
      await rm(evictionHome, { recursive: true, force: true })
    }
  })

  it('omits synthetic efforts on fallback/dormant providers, deduplicates dormant API models, guards force refresh races, and invalidates on llm events', async () => {
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    const status: OwnerConsoleStatus = {
      ...sampleStatus(),
      traex: { entry: 'dsh-ray-traex-acp-provider', installed: true, enabled: true, command: 'traex' },
      agy: { entry: 'dsh-ray-traex-acp-provider', installed: true, enabled: false, command: 'agy' },
      defaultModel: { entry: 'agent-default-model', available: true, provider: 'dormant-api', model: 'deepseek-r1' },
    }
    ctx.provide('llm' as never, {
      listProviders: () => [{ id: 'traex-agent', name: 'TraeX ACP' }],
      listConfigurableProviders: () => [{ provider: 'agy-agent', displayName: 'Antigravity ACP' }],
      listModels: async () => await new Promise<never>(() => undefined),
    } as never)

    try {
      const cat = await readOwnerConsoleModelCatalog(ctx, status, { providerTimeoutMs: 25 })
      const traex = cat.providers.find(p => p.id === 'traex-agent')
      expect(traex?.diagnostic).toContain('timed out')
      expect(traex?.models).toEqual([
        { id: 'default', name: 'TraeX 默认当前模型 (default)', efforts: [] },
      ])

      const dormantAgy = cat.providers.find(p => p.id === 'agy-agent')
      expect(dormantAgy?.active).toBe(false)
      expect(dormantAgy?.models).toEqual([
        { id: 'default', name: 'Antigravity 默认当前模型 (default)', efforts: [] },
      ])

      const dormantApi = cat.providers.find(p => p.id === 'dormant-api')
      expect(dormantApi?.active).toBe(false)
      expect(dormantApi?.models).toEqual([
        { id: 'deepseek-r1', name: 'deepseek-r1', efforts: [] },
      ])
    } finally {
      await ctx.fiber.dispose()
    }

    // force: true must not be clobbered by a slower in-flight force: false read.
    const raceCtx = new Context()
    let releaseSlow!: (models: readonly { id: string; name: string }[]) => void
    const slowPromise = new Promise<readonly { id: string; name: string }[]>(resolve => { releaseSlow = resolve })
    let listCall = 0
    raceCtx.provide('llm' as never, {
      listProviders: () => [{ id: 'llmgw', name: 'LLMBox' }],
      listModels: vi.fn(async () => {
        listCall += 1
        if (listCall === 1) return await slowPromise
        return [{ id: 'fresh-model', name: 'Fresh Model' }]
      }),
    } as never)
    const raceStatus: OwnerConsoleStatus = {
      ...sampleStatus(),
      traex: { installed: false, enabled: false, command: '' },
      agy: { installed: false, enabled: false, command: '' },
      defaultModel: { entry: 'agent-default-model', available: true, provider: 'llmgw', model: 'fresh-model' },
    }
    const raceReader = new ModelCatalogReader({ cacheTtlMs: 30_000, providerTimeoutMs: 1_000 })
    try {
      const slowRead = raceReader.read(raceCtx, raceStatus, false)
      const freshRead = await raceReader.read(raceCtx, raceStatus, true)
      expect(freshRead.providers.find(p => p.id === 'llmgw')?.models.map(m => m.id)).toEqual(['fresh-model'])

      releaseSlow([{ id: 'stale-model', name: 'Stale Model' }])
      await slowRead

      const afterSlow = await raceReader.read(raceCtx, raceStatus, false)
      expect(afterSlow).toBe(freshRead)
      expect(afterSlow.providers.find(p => p.id === 'llmgw')?.models.map(m => m.id)).toEqual(['fresh-model'])
      expect(listCall).toBe(2)
    } finally {
      await raceCtx.fiber.dispose()
    }

    // llm/adapters-updated and llm/models-updated invalidate OwnerConsoleService's catalog cache.
    const evtCtx = new Context()
    await evtCtx.plugin(TypertRegistry)
    let eventFetchCount = 0
    evtCtx.provide('llm' as never, {
      listProviders: () => [{ id: 'llmgw', name: 'LLMBox' }],
      listModels: vi.fn(async () => {
        eventFetchCount += 1
        return [{ id: `model-v${eventFetchCount}`, name: `Model v${eventFetchCount}` }]
      }),
    } as never)
    const evtService = new OwnerConsoleService(
      evtCtx,
      { feishuAppId: '' },
      new CodingToolProber(),
      undefined,
      new ModelCatalogReader({ cacheTtlMs: 30_000, providerTimeoutMs: 1_000 }),
    )
    try {
      const c1 = await evtService.modelCatalog(false)
      expect(eventFetchCount).toBe(1)
      expect(await evtService.modelCatalog(false)).toBe(c1)

      evtCtx.emit('llm/adapters-updated' as never)
      const c2 = await evtService.modelCatalog(false)
      expect(c2).not.toBe(c1)
      expect(eventFetchCount).toBe(2)

      evtCtx.emit('llm/models-updated' as never)
      const c3 = await evtService.modelCatalog(false)
      expect(c3).not.toBe(c2)
      expect(eventFetchCount).toBe(3)
    } finally {
      await evtCtx.fiber.dispose()
    }
  })
})

describe('/model cascading dropdowns and settings category filter UI', () => {
  const roots: Array<{ root: Root; el: HTMLElement }> = []

  afterEach(async () => {
    for (const item of roots.splice(0)) {
      await act(async () => { item.root.unmount() })
      item.el.remove()
    }
  })

  async function flush() {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
    })
  }

  function makeAutonomySetup(): AutonomySetupStatus {
    return {
      profile: {
        dshHome: '/tmp/dsh-home',
        profileName: 'desktop',
        patchPath: '/tmp/dsh-home/profiles/desktop/cordis.patch.yml',
        patchExists: true,
        writable: true,
        dbPathsScoped: true,
        unscopedDbPaths: [],
        restartCommand: 'dsh',
      },
      ownerRoute: {
        configured: true,
        active: true,
        channel: 'lark',
        authorityId: 'owner-lark',
        principalId: 'lark/primary/personal/ou_1',
        workspace: '/tmp/dsh-home/assistant-workspace',
        preset: 'standard',
        webGrantReady: true,
        missingReason: null,
      },
      modelRoute: {
        provider: 'agy-agent',
        model: 'gemini-4-hydrogen',
        reasoningEffort: 'high',
        routeKind: 'agy-agent',
        traexInstalled: true,
        traexEnabled: false,
        agyEnabled: true,
        apiProviders: [{ id: 'llmgw', name: 'LLMBox Seed' }],
        ready: true,
        missingReason: null,
      },
      grants: {
        memoryLearning: { installed: true, configured: false, enabled: false, threeAuthoritiesIndependent: false, expiresAt: null, expired: false, workItemExperiences: false, databasePath: null },
        dreaming: { installed: true, configured: false, enabled: false, retired: false, maxDreamsPerDay: null, maxIdeasPerWake: null, databasePath: null },
        growthDriver: { installed: true, configured: false, enabled: false, usageEnabled: false, dreamingIdeasEnabled: false, databasePath: null },
        assistantPolicy: { installed: true, schedulerEnabled: true, allowUnbudgetedExecution: false, rulesCount: 1, budgetsCount: 0, ready: false },
      },
      activeTier: 'conservative',
      activeBudgets: AUTONOMY_TIER_DEFAULTS.conservative,
      overallReady: false,
      blockingReasons: [],
    }
  }

  function baseRemote(overrides: Partial<ConsoleRemote> = {}): ConsoleRemote {
    const okWrite = async () => ({ ok: true as const, value: { applied: true, entry: 'ok', note: 'ok' } })
    return {
      status: async () => ({ ok: true, value: sampleStatus() }),
      trendSnapshots: async () => ({ ok: true, value: { state: 'absent', causal: false, items: [] } }),
      intakeAgreement: async () => ({ ok: true, value: { state: 'absent', causal: false } }),
      intakeAgreementHistory: async () => ({ ok: true, value: { state: 'absent', causal: false } }),
      configureFeishu: okWrite,
      configureTraex: okWrite,
      configureBundle: okWrite,
      setBundleEnabled: okWrite,
      setPluginEnabled: okWrite,
      installProjectBundle: okWrite,
      removeProjectBundle: okWrite,
      configureAgy: okWrite,
      setDefaultModelRoute: okWrite,
      modelCatalog: async () => ({ ok: true, value: sampleCatalog() }),
      autonomySetupStatus: async () => ({ ok: true, value: makeAutonomySetup() }),
      ...overrides,
    }
  }

  it('cascades AutonomyWizardCard provider -> model -> effort dropdowns without keeping stale gemini-4-hydrogen', async () => {
    const configureAutonomySetup = vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'cordis.patch.yml', note: 'ok' } }))
    const remote = baseRemote({ configureAutonomySetup })
    const ctrl: ConsoleController = {
      remote,
      navigation: { openConversation: vi.fn(), openPlugins: vi.fn() },
      status: sampleStatus(),
      overview: undefined,
      autonomySetup: makeAutonomySetup(),
      modelCatalog: sampleCatalog(),
      loadingModelCatalog: false,
      upgradeStatus: undefined,
      upgradePreview: undefined,
      doctorReport: undefined,
      checkingDoctor: false,
      traexProbe: undefined,
      agyProbe: undefined,
      probingTool: undefined,
      checkingUpgrade: false,
      previewingUpgrade: false,
      busy: false,
      error: '',
      notice: '',
      setError: vi.fn(),
      setNotice: vi.fn(),
      refresh: vi.fn(async () => undefined),
      refreshModelCatalog: vi.fn(async () => undefined),
      checkDoctor: vi.fn(async () => undefined),
      probeTool: vi.fn(async () => undefined),
      checkUpgrade: vi.fn(async () => undefined),
      previewUpgrade: vi.fn(async () => undefined),
      run: vi.fn(async fn => { await fn() }),
      runInstall: vi.fn(async () => undefined),
      confirmOwner: () => true,
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push({ root, el: container })

    await act(async () => { root.render(createElement(AutonomyWizardCard, { ctrl })) })
    await flush()

    const provSel = container.querySelector('[data-model-route-select="provider"]') as HTMLSelectElement
    const modelSel = container.querySelector('[data-model-route-select="model"]') as HTMLSelectElement
    const effortSel = container.querySelector('[data-model-route-select="effort"]') as HTMLSelectElement

    expect(provSel.value).toBe('agy-agent')
    expect(modelSel.value).toBe('gemini-4-hydrogen')
    expect(effortSel.value).toBe('high')

    // Switch provider from agy-agent -> llmgw: stale gemini-4-hydrogen is replaced by seed-2.0-pro, and incompatible effort resets cleanly.
    await act(async () => {
      provSel.value = 'llmgw'
      provSel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()

    expect(provSel.value).toBe('llmgw')
    expect(modelSel.value).toBe('seed-2.0-pro')
    expect(effortSel.value).toBe('')
    expect([...effortSel.options].map(o => o.value)).toEqual(['', 'low', 'medium'])

    // Change effort and submit.
    await act(async () => {
      effortSel.value = 'medium'
      effortSel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const submitBtn = [...container.querySelectorAll('button')].find(b => b.textContent === '授权开启记忆自学习 / 做梦 / 技能演化')!
    await act(async () => { submitBtn.click() })
    await flush()

    expect(configureAutonomySetup).toHaveBeenCalledWith(
      'enable', 'conservative', 'llmgw', 'seed-2.0-pro', 'medium', true, true, true, false, AUTONOMY_TIER_DEFAULTS.conservative,
    )
  })

  it('uses known-path command dropdowns and /model default selectors in CodingToolsCard, and filters cards by category in WenyaoSettingsSection', async () => {
    const setDefaultModelRoute = vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'agent-default-model', note: 'ok' } }))
    const configureTraex = vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'traex', note: 'ok' } }))
    const remote = baseRemote({
      configureTraex,
      setDefaultModelRoute,
      probeCodingTool: vi.fn(async (tool: 'traex' | 'agy') => ({
        ok: true as const,
        value: {
          tool,
          command: `/Users/owner/.local/bin/${tool}`,
          installed: true,
          binaryFound: true,
          loggedIn: true,
          enabled: tool === 'agy',
          routeRegistered: tool === 'agy',
          ready: true,
          state: 'ready' as const,
          summary: 'ok',
          discoveredPath: `/Users/owner/.local/bin/${tool}`,
          needsPathPin: false,
          checkedAt: 100,
          cached: false,
        },
      })),
    })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push({ root, el: container })

    await act(async () => {
      root.render(createElement(WenyaoSettingsSection, {
        remote,
        navigation: { openConversation: vi.fn(), openPlugins: vi.fn() },
      }))
    })
    await flush()

    // Category filter defaults to 'all' (everything visible), narrows cleanly to 'models', and restores 'all'.
    expect(container.querySelector('[data-owner-console-deck="all"]')).not.toBeNull()
    expect(container.textContent).toContain('系统体检与一键自动修复')
    expect(container.textContent).toContain('编程工具与默认模型')
    expect(container.textContent).toContain('远程接入（飞书）')

    const modelsTab = container.querySelector('[data-owner-console-category="models"]') as HTMLButtonElement
    await act(async () => { modelsTab.click() })
    await flush()
    expect(container.querySelector('[data-owner-console-deck="models"]')).not.toBeNull()
    expect(container.textContent).toContain('编程工具与默认模型')
    expect(container.textContent).not.toContain('远程接入（飞书）')

    // Inside CodingToolsCard, verify CLI command dropdown & /model default switcher work without typing raw IDs.
    const traexPathSelect = container.querySelector('[data-command-path-select="traex"]') as HTMLSelectElement
    expect([...traexPathSelect.options].some(o => o.value === '/Users/owner/.local/bin/traex')).toBe(true)
    await act(async () => {
      traexPathSelect.value = '/Users/owner/.local/bin/traex'
      traexPathSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const enableButtons = [...container.querySelectorAll('button')].filter(b => b.textContent === '启用')
    await act(async () => { enableButtons[0]!.click() })
    await flush()
    expect(configureTraex).toHaveBeenCalledWith(true, '/Users/owner/.local/bin/traex')

    const modelSel = container.querySelector('[data-model-route-select="model"]') as HTMLSelectElement
    await act(async () => {
      modelSel.value = 'claude-sonnet-5-5'
      modelSel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const setDefaultBtn = [...container.querySelectorAll('button')].find(b => b.textContent === '设为默认模型')!
    await act(async () => { setDefaultBtn.click() })
    await flush()
    expect(setDefaultModelRoute).toHaveBeenCalledWith('agy-agent', 'claude-sonnet-5-5', 'high')

    // Restore 'all'.
    const allTab = container.querySelector('[data-owner-console-category="all"]') as HTMLButtonElement
    await act(async () => { allTab.click() })
    await flush()
    expect(container.textContent).toContain('远程接入（飞书）')
  })

  it('keeps CodingToolsCard standalone rendering consistent', async () => {
    const ctrl: ConsoleController = {
      remote: baseRemote(),
      navigation: { openConversation: vi.fn(), openPlugins: vi.fn() },
      status: sampleStatus(),
      overview: undefined,
      autonomySetup: undefined,
      modelCatalog: sampleCatalog(),
      loadingModelCatalog: false,
      upgradeStatus: undefined,
      upgradePreview: undefined,
      doctorReport: undefined,
      checkingDoctor: false,
      traexProbe: undefined,
      agyProbe: undefined,
      probingTool: undefined,
      checkingUpgrade: false,
      previewingUpgrade: false,
      busy: false,
      error: '',
      notice: '',
      setError: vi.fn(),
      setNotice: vi.fn(),
      refresh: vi.fn(async () => undefined),
      refreshModelCatalog: vi.fn(async () => undefined),
      checkDoctor: vi.fn(async () => undefined),
      probeTool: vi.fn(async () => undefined),
      checkUpgrade: vi.fn(async () => undefined),
      previewUpgrade: vi.fn(async () => undefined),
      run: vi.fn(async fn => { await fn() }),
      runInstall: vi.fn(async () => undefined),
      confirmOwner: () => true,
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push({ root, el: container })
    await act(async () => { root.render(createElement(CodingToolsCard, { ctrl })) })
    expect(container.querySelector('[data-model-route-controls="grid"]')).not.toBeNull()
  })

  it('resolveEffectiveModelCatalog does not inject uninstalled ACP providers when Host modelCatalog is present', () => {
    const hostCatalog: OwnerConsoleModelCatalog = {
      protocol: 'owner-console/model-catalog/v1',
      fetchedAt: 1_760_000_000_000,
      defaultSelection: { provider: 'llmgw', model: 'seed-2.0-pro' },
      providers: [
        {
          id: 'llmgw',
          name: 'LLMBox Seed',
          kind: 'api',
          active: true,
          models: [{ id: 'seed-2.0-pro', name: 'Seed 2.0 Pro', efforts: [] }],
        },
      ],
    }
    const statusWithoutAcp: OwnerConsoleStatus = {
      ...sampleStatus(),
      traex: { installed: false, enabled: false, command: '' },
      agy: { installed: false, enabled: false, command: '' },
      defaultModel: { entry: 'agent-default-model', available: true, provider: 'llmgw', model: 'seed-2.0-pro' },
      llmProviders: [{ id: 'llmgw', name: 'LLMBox Seed' }],
    }

    const fromHost = resolveEffectiveModelCatalog({ modelCatalog: hostCatalog, status: statusWithoutAcp })
    expect(fromHost.providers.map(p => p.id)).toEqual(['llmgw'])

    // Even if status/autonomySetup are omitted, Host modelCatalog remains authoritative and never injects ACP stubs.
    const hostOnly = resolveEffectiveModelCatalog({ modelCatalog: hostCatalog })
    expect(hostOnly.providers.map(p => p.id)).toEqual(['llmgw'])

    // When modelCatalog is absent, only installed ACP providers are added (with empty efforts).
    const fallbackNone = resolveEffectiveModelCatalog({ status: statusWithoutAcp })
    expect(fallbackNone.providers.map(p => p.id)).toEqual(['llmgw'])
  })

  it('CommandPathControl prefers already-configured path over discoveredPath when rendering and enabling', async () => {
    const configureTraex = vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'traex', note: 'ok' } }))
    const statusWithCustomPath: OwnerConsoleStatus = {
      ...sampleStatus(),
      traex: { entry: 'dsh-ray-traex-acp-provider', installed: true, enabled: false, command: '/opt/custom/bin/traex' },
    }
    const ctrl: ConsoleController = {
      remote: baseRemote({ configureTraex }),
      navigation: { openConversation: vi.fn(), openPlugins: vi.fn() },
      status: statusWithCustomPath,
      overview: undefined,
      autonomySetup: undefined,
      modelCatalog: sampleCatalog(),
      loadingModelCatalog: false,
      upgradeStatus: undefined,
      upgradePreview: undefined,
      doctorReport: undefined,
      checkingDoctor: false,
      traexProbe: {
        tool: 'traex',
        command: '/opt/custom/bin/traex',
        installed: true,
        binaryFound: true,
        loggedIn: true,
        enabled: false,
        routeRegistered: false,
        ready: true,
        state: 'disabled',
        summary: 'ok',
        discoveredPath: '/Users/owner/.local/bin/traex',
        needsPathPin: false,
        checkedAt: 100,
        cached: false,
      },
      agyProbe: undefined,
      probingTool: undefined,
      checkingUpgrade: false,
      previewingUpgrade: false,
      busy: false,
      error: '',
      notice: '',
      setError: vi.fn(),
      setNotice: vi.fn(),
      refresh: vi.fn(async () => undefined),
      refreshModelCatalog: vi.fn(async () => undefined),
      checkDoctor: vi.fn(async () => undefined),
      probeTool: vi.fn(async () => undefined),
      checkUpgrade: vi.fn(async () => undefined),
      previewUpgrade: vi.fn(async () => undefined),
      run: vi.fn(async fn => { await fn() }),
      runInstall: vi.fn(async () => undefined),
      confirmOwner: () => true,
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push({ root, el: container })

    await act(async () => { root.render(createElement(CodingToolsCard, { ctrl })) })
    await flush()

    const traexPathSelect = container.querySelector('[data-command-path-select="traex"]') as HTMLSelectElement
    expect(traexPathSelect.value).toBe('/opt/custom/bin/traex')
    expect(traexPathSelect.options[0]?.value).toBe('/opt/custom/bin/traex')
    expect([...traexPathSelect.options].some(o => o.value === '/Users/owner/.local/bin/traex')).toBe(true)

    const enableButtons = [...container.querySelectorAll('button')].filter(b => b.textContent === '启用')
    await act(async () => { enableButtons[0]!.click() })
    await flush()
    expect(configureTraex).toHaveBeenCalledWith(true, '/opt/custom/bin/traex')
  })
})
