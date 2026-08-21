import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import plugin, { AssistantDeliveryService, Config, name, version } from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}

describe('dsh-enhanced-assistant-delivery', () => {
  it('exposes stable plugin identity', () => {
    expect(name).toBe('dsh-enhanced-assistant-delivery')
    expect(version).toBe(manifest.version)
  })

  it('exports the Cordis service and validated config entrypoint', () => {
    expect(plugin).toBe(AssistantDeliveryService)
    expect(Config).toBe(AssistantDeliveryService.Config)
  })
})
