import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import plugin, { Config, MemoryWikiBridgeService, name, version } from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

describe('dsh-enhanced-memory-wiki-bridge entrypoint', () => {
  test('exports stable identity, service, and validated config', () => {
    expect(name).toBe('dsh-enhanced-memory-wiki-bridge')
    expect(version).toBe(manifest.version)
    expect(plugin).toBe(MemoryWikiBridgeService)
    expect(Config).toBe(MemoryWikiBridgeService.Config)
  })
})
