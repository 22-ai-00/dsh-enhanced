import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import plugin, { AssistantDreamingService, Config, hasCompleteDreamingPrerequisites, name, version, normalizeConfig } from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
  dsh?: { bundle?: { patch?: string } }
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}
const bundle = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

describe('dsh-enhanced-assistant-dreaming entrypoint', () => {
  test('exports stable identity, service and validated config', () => {
    expect(name).toBe('dsh-enhanced-assistant-dreaming')
    expect(version).toBe(manifest.version)
    expect(plugin).toBe(AssistantDreamingService)
    expect(Config).toBe(AssistantDreamingService.Config)
  })

  test('publishes the exact Cordis injection and service contract', () => {
    // The Loader mounts the default-exported service class, so its static
    // inject map (not a patch-row inject list) is the dependency gate.
    expect(AssistantDreamingService.inject).toEqual([
      'assistantAutomations', 'assistantDelivery', 'assistantEvaluation',
      'assistantGoals', 'assistantSkills', 'agents', 'sessions', 'tools',
    ])
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(bundle).toContain('- insert:')
    expect(bundle).toContain('id: dsh-enhanced-assistant-dreaming')
    expect(bundle).toContain("name: '@dsh-enhanced/assistant-dreaming'")
    // The bundle row carries no config: installing the package is a dormant,
    // zero-write state and enabling is a separate owner decision.
    expect(bundle).not.toContain('enabled: true')
  })

  test('declares every runtime Host import and sibling DSH bundle as an optional peer', () => {
    // These are imported as values by lib/*.js; they must never be ordinary
    // dependencies (a second Host runtime copy breaks service identity).
    for (const peer of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-tools']) {
      expect(manifest.peerDependencies?.[peer]).toBe('>=0.2.2-rc.5 <0.3.0')
      expect(manifest.peerDependenciesMeta?.[peer]?.optional).toBe(true)
      expect(manifest.dependencies?.[peer]).toBeUndefined()
    }
    for (const sibling of [
      '@dsh-enhanced/assistant-automations',
      '@dsh-enhanced/assistant-delivery',
      '@dsh-enhanced/assistant-evaluation',
      '@dsh-enhanced/assistant-goals',
      '@dsh-enhanced/assistant-policy',
      '@dsh-enhanced/assistant-skills',
      '@dsh-enhanced/personal-memory',
    ]) {
      expect(manifest.peerDependencies?.[sibling]).toBeTruthy()
      expect(manifest.peerDependenciesMeta?.[sibling]?.optional).toBe(true)
      expect(manifest.dependencies?.[sibling]).toBeUndefined()
    }
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@deepseek-ai/schemastery',
      '@dsh-enhanced/task-acceptance-contract',
    ])
  })

  test('dormant default configuration has no scheduler, scope or store path', () => {
    const config = normalizeConfig()
    expect(config).toMatchObject({ enabled: false, retired: false, scope: null, databasePath: null })
    expect(config.notifyOwner).toBe(false)
    expect(config.maxDreamsPerDay).toBe(3)
  })

  test('lottery window defaults to 5000 and is bounded and owner-configurable', () => {
    expect(normalizeConfig().lotteryWindow).toBe(5_000)
    expect(normalizeConfig({ lotteryWindow: 0 }).lotteryWindow).toBe(0)
    expect(normalizeConfig({ lotteryWindow: 123_456 }).lotteryWindow).toBe(123_456)
    expect(() => normalizeConfig({ lotteryWindow: 500_001 })).toThrow()
    expect(() => normalizeConfig({ lotteryWindow: -1 })).toThrow()
    expect(() => normalizeConfig({ lotteryWindow: 1.5 })).toThrow()
  })

  test('fail-closed validation rejects an enabled config without scope and store', () => {
    expect(() => normalizeConfig({
      enabled: true, provider: 'p', model: 'm', budgetId: 'b', budgetAmount: 1,
    })).toThrow(/scope/)
    expect(() => normalizeConfig({
      enabled: true,
      scope: { workspace: '/tmp', preset: 'p', principalId: 'i', ownerRouteId: 'r' },
      databasePath: 'relative/path', provider: 'p', model: 'm', budgetId: 'b', budgetAmount: 1,
    })).toThrow(/canonical absolute/)
  })

  test('fails closed when retired is set without enabled', () => {
    // The disabled path returns before reconcile, so it cannot pause anything;
    // accepting retired+disabled would falsely look like a safe retirement.
    expect(() => normalizeConfig({ retired: true })).toThrow(/retired requires enabled/u)
    expect(() => normalizeConfig({ enabled: false, retired: true })).toThrow(/retired requires enabled/u)
    expect(() => normalizeConfig({ retired: false })).not.toThrow()
  })

  test('rejects non-canonical scope workspace, oversized budgets and dead credential fields', () => {
    const base = {
      enabled: true,
      scope: { workspace: '/tmp', preset: 'p', principalId: 'i', ownerRouteId: 'r' },
      databasePath: '/tmp/dream.sqlite', provider: 'p', model: 'm', budgetId: 'b', budgetAmount: 1,
    }
    expect(() => normalizeConfig({ ...base, scope: { ...base.scope, workspace: 'tmp/relative' } }))
      .toThrow(/scope\.workspace/u)
    expect(() => normalizeConfig({ ...base, budgetAmount: 1_000_000_001 }))
      .toThrow(/budgetAmount/u)
    // apiKeyEnv was a declared-but-unused config field; unknown fields must be
    // rejected rather than silently ignored.
    expect(() => normalizeConfig({ ...base, apiKeyEnv: 'DREAM_API_KEY' } as never))
      .toThrow(/unknown config field: apiKeyEnv/u)
  })

  test('auto-enables when prerequisites are complete and enabled is omitted, while preserving explicit false opt-out', () => {
    const completeWithoutEnabled = {
      scope: { workspace: '/tmp/ws', preset: 'standard', principalId: 'owner-1', ownerRouteId: 'route-1' },
      databasePath: '/tmp/dream.sqlite',
      provider: 'p',
      model: 'm',
      budgetId: 'b',
      budgetAmount: 1,
    }
    expect(Config(completeWithoutEnabled).enabled).toBe(true)
    expect(Config['~standard'].validate(completeWithoutEnabled)).toMatchObject({ value: { enabled: true } })
    expect(normalizeConfig(completeWithoutEnabled)).toMatchObject({ enabled: true, retired: false })

    // Explicit opt-out stays disabled even when all prerequisites are complete.
    expect(Config({ ...completeWithoutEnabled, enabled: false }).enabled).toBe(false)
    expect(normalizeConfig({ ...completeWithoutEnabled, enabled: false }).enabled).toBe(false)

    // Incomplete prerequisites stay dormant when enabled is omitted.
    expect(normalizeConfig({ databasePath: '/tmp/dream.sqlite' }).enabled).toBe(false)
    expect(normalizeConfig({
      scope: { workspace: 'relative/ws', preset: 'standard', principalId: 'owner-1', ownerRouteId: 'route-1' },
      databasePath: '/tmp/dream.sqlite', provider: 'p', model: 'm', budgetId: 'b', budgetAmount: 1,
    }).enabled).toBe(false)

    // retired without explicit enabled still fails closed.
    expect(() => normalizeConfig({ ...completeWithoutEnabled, retired: true })).toThrow(/retired requires enabled/u)
  })

  test('rejects whitespace-only strings in prerequisites, schema validation, and explicit enabled configs', () => {
    const complete = {
      scope: { workspace: '/tmp/ws', preset: 'standard', principalId: 'owner-1', ownerRouteId: 'route-1' },
      databasePath: '/tmp/dream.sqlite',
      provider: 'p',
      model: 'm',
      budgetId: 'b',
      budgetAmount: 1,
    }
    const cases: Array<Record<string, unknown>> = [
      { ...complete, scope: { ...complete.scope, preset: '   ' } },
      { ...complete, scope: { ...complete.scope, principalId: '\t\n' } },
      { ...complete, scope: { ...complete.scope, ownerRouteId: '   ' } },
      { ...complete, provider: '   ' },
      { ...complete, model: '\t\n' },
      { ...complete, budgetId: '   ' },
    ]
    for (const invalid of cases) {
      expect(hasCompleteDreamingPrerequisites(invalid as never)).toBe(false)
      expect(Config['~standard'].validate(invalid)).toHaveProperty('issues')
      expect(() => Config(invalid as never)).toThrow()
      expect(() => normalizeConfig(invalid as never)).toThrow()
      expect(() => normalizeConfig({ ...invalid, enabled: true } as never)).toThrow()
    }
    expect(() => normalizeConfig({ ...complete, activeHours: { timezone: '   ', startMinute: 0, endMinute: 60 } })).toThrow()
    expect(() => normalizeConfig({ ...complete, reasoningEffort: '\t\n' })).toThrow()
  })

  test('rejects control characters and outer whitespace across all bounded text config fields', () => {
    const valid = {
      scope: { workspace: '/tmp/ws', preset: 'standard', principalId: 'owner-1', ownerRouteId: 'route-1' },
      databasePath: '/tmp/dream.sqlite',
      provider: 'openai',
      model: 'gpt-4o',
      reasoningEffort: 'medium',
      budgetId: 'budget-1',
      budgetAmount: 1,
      activeHours: { timezone: 'UTC', startMinute: 60, endMinute: 120 },
    }
    expect(normalizeConfig(valid).enabled).toBe(true)
    expect(normalizeConfig({
      ...valid,
      scope: { ...valid.scope, workspace: '/tmp/my workspace' },
      model: 'gpt 4o',
    }).enabled).toBe(true)

    const badValues = [' primary ', '\u00a0gpt-4o\u00a0', 'bad\nval', 'bad\x00val', 'bad\x7fval']
    const mutators: Array<(bad: string) => Record<string, unknown>> = [
      bad => ({ ...valid, scope: { ...valid.scope, workspace: `${valid.scope.workspace}${bad}` } }),
      bad => ({ ...valid, scope: { ...valid.scope, preset: bad } }),
      bad => ({ ...valid, scope: { ...valid.scope, principalId: bad } }),
      bad => ({ ...valid, scope: { ...valid.scope, ownerRouteId: bad } }),
      bad => ({ ...valid, databasePath: `${valid.databasePath}${bad}` }),
      bad => ({ ...valid, budgetId: bad }),
      bad => ({ ...valid, provider: bad }),
      bad => ({ ...valid, model: bad }),
      bad => ({ ...valid, reasoningEffort: bad }),
      bad => ({ ...valid, activeHours: { ...valid.activeHours, timezone: bad } }),
    ]
    for (const leading of [' /tmp/ws', '\u00a0/tmp/ws']) {
      for (const candidate of [
        { ...valid, scope: { ...valid.scope, workspace: leading } },
        { ...valid, databasePath: leading },
      ]) {
        expect(Config['~standard'].validate(candidate)).toHaveProperty('issues')
        expect(() => Config(candidate as never)).toThrow()
        expect(() => normalizeConfig(candidate as never)).toThrow()
      }
    }
    for (const mutate of mutators) {
      for (const bad of badValues) {
        const candidate = mutate(bad)
        expect(Config['~standard'].validate(candidate)).toHaveProperty('issues')
        expect(() => Config(candidate as never)).toThrow()
        expect(() => normalizeConfig(candidate as never)).toThrow()
        expect(() => normalizeConfig({ ...candidate, enabled: true } as never)).toThrow()
      }
    }
    for (const bad of badValues) {
      expect(hasCompleteDreamingPrerequisites({
        ...valid,
        scope: { ...valid.scope, preset: bad },
      } as never)).toBe(false)
      expect(hasCompleteDreamingPrerequisites({
        ...valid,
        databasePath: `/tmp/${bad}`,
      } as never)).toBe(false)
    }
  })
})
