import { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { apply, name, version } from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}

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
})
