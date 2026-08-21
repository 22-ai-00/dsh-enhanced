import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import plugin, { AssistantHealthService, Config, name, version } from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

describe('dsh-enhanced-assistant-health entrypoint', () => {
  test('exports stable identity, service, and validated config', () => {
    expect(name).toBe('dsh-enhanced-assistant-health')
    expect(version).toBe(manifest.version)
    expect(plugin).toBe(AssistantHealthService)
    expect(Config).toBe(AssistantHealthService.Config)
  })
})
