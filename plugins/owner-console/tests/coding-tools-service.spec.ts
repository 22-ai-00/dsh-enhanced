import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { describe, expect, it, vi } from 'vitest'
import { CodingToolProber, sanitizedProbeEnv, type ProbeExecFn } from '../src/probes.ts'
import { OwnerConsoleService } from '../src/service.ts'
import type { SettingsDescriptor, SettingsService } from '../src/settings.ts'
import { CodingToolProbeSchema, OwnerConsoleStatusSchema, WRITE_RESULT } from '../src/typert.ts'

type Entry = { ns: string; value: Record<string, unknown> }

function fakeSettings(entries: Entry[]) {
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
    ns: entry.ns, schema: {}, value: { ...entry.value }, revision: 4, applies: 'live',
  }))
  return { service: { describe, mutate } satisfies SettingsService, entries, mutate }
}

async function mountService(options: {
  entries?: Entry[]
  installedBundles?: readonly string[]
  providers?: readonly { id: string; name?: string }[]
  execFn?: ProbeExecFn
  now?: () => number
  withLoader?: boolean
  agentDefaultModel?: { currentSelection?: () => { provider: string; model: string; reasoningEffort?: string }; saveSelection?: (next: unknown) => Promise<void> }
} = {}) {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  const settings = fakeSettings(options.entries ?? [])
  ctx.provide('settings' as never, settings.service as never)
  if (options.installedBundles !== undefined) {
    ctx.provide('pluginManager' as never, {
      listBundles: async () => options.installedBundles!.map(name => ({
        name, version: '0.1.73', enabled: true, installed: true, removable: true, optional: true, rows: [],
      })),
      listPlugins: async () => [],
      setBundleEnabled: async () => ({ changed: false, application: 'applied', target: '' }),
      setPluginEnabled: async () => ({ changed: false, application: 'applied', target: '' }),
      installBundle: async () => ({ changed: false, application: 'applied', target: '' }),
      removeBundle: async () => ({ changed: false, application: 'applied', target: '' }),
    } as never)
  }
  if (options.providers !== undefined) {
    ctx.provide('llm' as never, { listProviders: () => options.providers! } as never)
  }
  if (options.agentDefaultModel !== undefined) {
    ctx.provide('agentDefaultModel' as never, options.agentDefaultModel as never)
  }
  if (options.withLoader) {
    const loaderIds = (options.entries ?? []).map(e => e.ns)
    ctx.provide('loader' as never, {
      entries: () => loaderIds.map(id => ({
        id: `include:${id}`,
        options: { id, config: {} },
        fiber: { update: vi.fn() },
        refresh: async () => undefined,
      })),
    } as never)
  }
  const prober = new CodingToolProber(options.execFn, options.now)
  const service = new OwnerConsoleService(ctx, { feishuAppId: '' }, prober)
  return { ctx, service, settings, prober }
}

describe('owner console coding tools (TraeX & Antigravity) and default model route', () => {
  it('reads agy, defaultModel, and llmProviders in status() cleanly', async () => {
    const { ctx, service } = await mountService({
      entries: [
        { ns: 'dsh-enhanced-traex-acp-provider', value: { enabled: false, command: '/bin/traex', agyEnabled: true, agyCommand: '/opt/agy' } },
        { ns: 'agent-default-model', value: { provider: 'agy-agent', model: 'gemini-4-carbon', reasoningEffort: 'high' } },
      ],
      installedBundles: ['@dsh-enhanced/traex-acp-provider'],
      providers: [{ id: 'agy-agent', name: 'Antigravity Agent (local ACP)' }, { id: 'deepseek-official', name: 'DeepSeek' }],
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'agy-agent', model: 'gemini-4-carbon', reasoningEffort: 'high' }),
      },
    })
    try {
      const status = OwnerConsoleStatusSchema.parse(await service.status())
      expect(status.traex).toEqual({
        entry: 'dsh-enhanced-traex-acp-provider', installed: true, enabled: false, command: '/bin/traex',
      })
      expect(status.agy).toEqual({
        entry: 'dsh-enhanced-traex-acp-provider', installed: true, enabled: true, command: '/opt/agy',
      })
      expect(status.defaultModel).toEqual({
        entry: 'agent-default-model', available: true, provider: 'agy-agent', model: 'gemini-4-carbon', reasoningEffort: 'high',
      })
      expect(status.llmProviders).toEqual([
        { id: 'agy-agent', name: 'Antigravity Agent (local ACP)' },
        { id: 'deepseek-official', name: 'DeepSeek' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('toggles agyEnabled and agyCommand via configureAgy without disturbing traex', async () => {
    const { ctx, service, settings } = await mountService({
      entries: [{ ns: 'dsh-enhanced-traex-acp-provider', value: { enabled: true, command: 'traex', agyEnabled: false, agyCommand: 'agy' } }],
      withLoader: true,
    })
    try {
      const enabled = WRITE_RESULT.parse(await service.configureAgy(true, '/usr/local/bin/agy'))
      expect(enabled.applied).toBe(true)
      expect(settings.mutate).toHaveBeenCalledWith('dsh-enhanced-traex-acp-provider', [
        { op: 'set', path: ['agyEnabled'], value: true },
        { op: 'set', path: ['agyCommand'], value: '/usr/local/bin/agy' },
      ], 4)
      expect(settings.entries[0]!.value).toMatchObject({ enabled: true, command: 'traex', agyEnabled: true, agyCommand: '/usr/local/bin/agy' })

      const bad = await service.configureAgy(true, 'agy\n--evil')
      expect(bad.applied).toBe(false)

      const disabled = WRITE_RESULT.parse(await service.configureAgy(false, ''))
      expect(disabled.applied).toBe(true)
      expect(settings.entries[0]!.value['agyEnabled']).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('switches default model route and auto-enables inactive ACP route via volatile config', async () => {
    const { ctx, service, settings } = await mountService({
      entries: [
        { ns: 'dsh-enhanced-traex-acp-provider', value: { enabled: false, command: 'traex', agyEnabled: false, agyCommand: 'agy' } },
        { ns: 'agent-default-model', value: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'medium' } },
      ],
      withLoader: true,
    })
    try {
      const res = WRITE_RESULT.parse(await service.setDefaultModelRoute('agy-agent', 'default', ''))
      expect(res.applied).toBe(true)
      expect(res.note).toContain('agy-agent / default')
      expect(settings.entries[0]!.value['agyEnabled']).toBe(true)
      expect(settings.entries[1]!.value).toEqual({ provider: 'agy-agent', model: 'default' })

      const withEffort = WRITE_RESULT.parse(await service.setDefaultModelRoute('traex-agent', 'Doubao-Seed-Code', 'high'))
      expect(withEffort.applied).toBe(true)
      expect(settings.entries[0]!.value['enabled']).toBe(true)
      expect(settings.entries[1]!.value).toEqual({ provider: 'traex-agent', model: 'Doubao-Seed-Code', reasoningEffort: 'high' })

      expect((await service.setDefaultModelRoute('bad provider!', 'default', '')).applied).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('probes traex and agy read-only without secret leakage, supporting cache, force refresh and inflight dedup', async () => {
    let clock = 1_000
    const execCalls: string[][] = []
    let releaseAgy: (() => void) | undefined
    const execFn: ProbeExecFn = async (cmd, args) => {
      execCalls.push([cmd, ...args])
      if (cmd.includes('traex')) {
        return { stdout: 'Logged in using Trae', stderr: '', exitCode: 0 }
      }
      if (args[0] === '--version') {
        return { stdout: '1.5.9', stderr: '', exitCode: 0 }
      }
      await new Promise<void>(resolve => { releaseAgy = resolve })
      return { stdout: 'gemini-4-carbon\ngemini-4-argon\nclaude-opus-5-5\n', stderr: '', exitCode: 0 }
    }

    const { ctx, service } = await mountService({
      entries: [{ ns: 'dsh-enhanced-traex-acp-provider', value: { enabled: true, command: 'traex', agyEnabled: true, agyCommand: 'agy' } }],
      installedBundles: ['@dsh-enhanced/traex-acp-provider'],
      providers: [{ id: 'traex-agent' }, { id: 'agy-agent' }],
      execFn,
      now: () => clock,
    })

    try {
      const traexRes = CodingToolProbeSchema.parse(await service.probeCodingTool('traex', '', false))
      expect(traexRes).toMatchObject({ tool: 'traex', binaryFound: true, loggedIn: true, ready: true, state: 'ready', cached: false })

      // Within 15s TTL cache returns cached result without respawning traex.
      clock += 5_000
      const traexCached = CodingToolProbeSchema.parse(await service.probeCodingTool('traex', '', false))
      expect(traexCached.cached).toBe(true)
      expect(execCalls.filter(c => c[0] === 'traex')).toHaveLength(1)

      // Concurrent agy probes coalesce into one subprocess pair (--version + models).
      const p1 = service.probeCodingTool('agy', '', false)
      const p2 = service.probeCodingTool('agy', '', false)
      await vi.waitFor(() => { expect(releaseAgy).toBeTypeOf('function') })
      releaseAgy!()
      const [agy1, agy2] = await Promise.all([p1, p2])
      expect(CodingToolProbeSchema.parse(agy1)).toMatchObject({ tool: 'agy', binaryFound: true, loggedIn: true, ready: true, modelCount: 3 })
      expect(CodingToolProbeSchema.parse(agy2).ready).toBe(true)
      expect(execCalls.filter(c => c[0] === 'agy')).toHaveLength(2)

      // Force bypasses TTL cache.
      releaseAgy = undefined
      const agyForced = service.probeCodingTool('agy', '', true)
      await vi.waitFor(() => { expect(releaseAgy).toBeTypeOf('function') })
      releaseAgy!()
      expect((await agyForced).cached).toBe(false)
      expect(execCalls.filter(c => c[0] === 'agy')).toHaveLength(4)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('distinguishes missing binaries and auth-required errors and strips secret env vars from subprocess', async () => {
    vi.stubEnv('LARK_APP_SECRET', 'super-secret-value')
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-secret')
    const env = sanitizedProbeEnv()
    expect(env['LARK_APP_SECRET']).toBeUndefined()
    expect(env['DEEPSEEK_API_KEY']).toBeUndefined()
    vi.unstubAllEnvs()

    const execFn: ProbeExecFn = async (cmd, args) => {
      if (cmd === 'missing-agy' && args[0] === '--version') {
        return { stdout: '', stderr: 'spawn ENOENT', exitCode: 1, errorCode: 'ENOENT' }
      }
      return { stdout: '', stderr: 'Error: Please sign in to view available models', exitCode: 1 }
    }

    const { ctx, service } = await mountService({ execFn })
    try {
      const missing = CodingToolProbeSchema.parse(await service.probeCodingTool('agy', 'missing-agy', true))
      expect(missing.state).toBe('missing-binary')
      expect(missing.binaryFound).toBe(false)
      expect(missing.remediation).toContain('Antigravity')

      const needAuth = CodingToolProbeSchema.parse(await service.probeCodingTool('agy', 'agy', true))
      expect(needAuth.state).toBe('auth-required')
      expect(needAuth.binaryFound).toBe(true)
      expect(needAuth.loggedIn).toBe(false)
      expect(needAuth.remediation).toContain('acp --login')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
