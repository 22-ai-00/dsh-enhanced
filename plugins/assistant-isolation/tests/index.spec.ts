import { Context } from '@deepseek-ai/cordis'
import { readFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import plugin, { apply, name, version } from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string; files: string[] }
describe('assistant-isolation bundle', () => {
  it('ships its supervisor and loads the real Cordis service with no grants', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'isolation-bundle-')))
    const ctx = new Context()
    try {
      expect(plugin.name).toBe(name)
      expect(name).toBe('dsh-enhanced-assistant-isolation')
      expect(version).toBe(manifest.version)
      expect(manifest.files).toContain('runtime')
      expect(plugin.apply).toBe(apply)
      await ctx.plugin(plugin, { stateRoot: root })
      expect(ctx.assistantIsolation).toBeDefined()
    } finally { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) }
  })
})
