import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import * as entrypoint from '../src/index.ts'
import plugin, { AssistantHeartbeatService, Config, name, version } from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

describe('dsh-enhanced-assistant-heartbeat entrypoint', () => {
  test('exports stable identity, service, and validated config', () => {
    expect(name).toBe('dsh-enhanced-assistant-heartbeat')
    expect(version).toBe(manifest.version)
    expect(plugin).toBe(AssistantHeartbeatService)
    expect(Config).toBe(AssistantHeartbeatService.Config)
    expect(entrypoint).not.toHaveProperty('HeartbeatScratch')
    expect(entrypoint).not.toHaveProperty('HeartbeatScratchError')
  })
})
