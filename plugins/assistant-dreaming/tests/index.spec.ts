import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import plugin, { AssistantDreamingService, Config, name, version, normalizeConfig } from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

describe('dsh-enhanced-assistant-dreaming entrypoint', () => {
  test('exports stable identity, service and validated config', () => {
    expect(name).toBe('dsh-enhanced-assistant-dreaming')
    expect(version).toBe(manifest.version)
    expect(plugin).toBe(AssistantDreamingService)
    expect(Config).toBe(AssistantDreamingService.Config)
  })

  test('dormant default configuration has no scheduler, scope or store path', () => {
    const config = normalizeConfig()
    expect(config).toMatchObject({ enabled: false, scope: null, databasePath: null })
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
})
