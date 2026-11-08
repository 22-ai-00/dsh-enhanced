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
