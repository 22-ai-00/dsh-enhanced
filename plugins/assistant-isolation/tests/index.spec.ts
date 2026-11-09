import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, readFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import plugin, { apply, name, version } from '../src/index.ts'
import { cleanupNativeFixtures, nativeConfigWithRuntime } from './helpers/native-config.js'

afterAll(async () => { await cleanupNativeFixtures() })

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string; files: string[] }
describe('assistant-isolation bundle', () => {
  it.skipIf(process.platform !== 'linux' || (process.getuid?.() ?? 0) === 0)('ships its supervisor and loads the real Cordis service with no grants', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'isolation-bundle-')))
    const root = join(base, 'state'); mkdirSync(root, { recursive: true, mode: 0o700 })
    const ctx = new Context()
    try {
      expect(plugin.name).toBe(name)
      expect(name).toBe('dsh-enhanced-assistant-isolation')
      expect(version).toBe(manifest.version)
      expect(manifest.files).toContain('runtime')
      expect(plugin.apply).toBe(apply)
      await ctx.plugin(plugin, await nativeConfigWithRuntime(root))
      expect(ctx.assistantIsolation).toBeDefined()
    } finally { await ctx.fiber.dispose(); rmSync(base, { recursive: true, force: true }) }
  })
})
