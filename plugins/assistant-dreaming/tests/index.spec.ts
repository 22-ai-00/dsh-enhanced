import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import plugin, { AssistantDreamingService, Config, name, version, normalizeConfig } from '../src/index.ts'

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

  test('declares every runtime Host import as an optional peer', () => {
    // These are imported as values by lib/*.js; they must never be ordinary
    // dependencies (a second Host runtime copy breaks service identity).
    for (const peer of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-tools']) {
      expect(manifest.peerDependencies?.[peer]).toBe('>=0.2.1-rc.2 <0.3.0')
      expect(manifest.peerDependenciesMeta?.[peer]?.optional).toBe(true)
      expect(manifest.dependencies?.[peer]).toBeUndefined()
    }
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
})
