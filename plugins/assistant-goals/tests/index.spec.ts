import { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { name, version, AssistantGoalsService } from '../src/index.ts'
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
describe('assistant-goals bundle', () => {
  it('loads an inert ledger without optional native/identity services and disposes it', async () => {
    expect(name).toBe('dsh-enhanced-assistant-goals'); expect(version).toBe(manifest.version)
    const ctx = new Context()
    await ctx.plugin(AssistantGoalsService, { databasePath: ':memory:' })
    const service = ctx.assistantGoals
    expect(service.health()).toMatchObject({ ready: false, goals: 0 })
    await ctx.fiber.dispose()
    expect(() => service.health()).toThrow('disposed')
  })
})
