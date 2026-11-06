import { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { apply, name, version } from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
  dependencies: Record<string, string>
  peerDependencies: Record<string, string>
  peerDependenciesMeta: Record<string, { optional?: boolean }>
}

const hostPackages = ['@deepseek-ai/dsh-fs', '@deepseek-ai/dsh-fs-local', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-working-directory']

describe('dsh-enhanced-assistant-skills', () => {
  it('exposes stable plugin identity', () => {
    expect(name).toBe('dsh-enhanced-assistant-skills')
    expect(version).toBe(manifest.version)
  })

  it('loads through the Cordis entrypoint', async () => {
    const ctx = new Context()
    apply(ctx, { databasePath: ':memory:' })
    expect(ctx.assistantSkills).toBeDefined()
    await ctx.fiber.restart()
  })

  it('takes host DSH services as optional peers so installs never shadow the runtime', () => {
    for (const dependency of Object.keys(manifest.dependencies)) {
      expect(dependency.startsWith('@deepseek-ai/dsh-')).toBe(false)
    }
    for (const dependency of hostPackages) {
      expect(manifest.peerDependencies[dependency]).toBe('>=0.2.1-rc.2 <0.3.0')
      expect(manifest.peerDependenciesMeta[dependency]?.optional).toBe(true)
    }
  })
})
