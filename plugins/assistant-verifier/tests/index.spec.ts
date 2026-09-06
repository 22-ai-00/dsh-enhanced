import { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { apply, name, version } from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}

describe('dsh-enhanced-assistant-verifier', () => {
  it('exposes stable plugin identity', () => {
    expect(name).toBe('dsh-enhanced-assistant-verifier')
    expect(version).toBe(manifest.version)
  })

  it('loads through the Cordis entrypoint and disposes its database', async () => {
    const ctx = new Context()
    apply(ctx, { databasePath: ':memory:', tickIntervalMs: 0 })
    const service = ctx.assistantVerifier
    expect(service.continuations()).toEqual([])
    await ctx.fiber.restart()
    expect(() => service.continuations()).toThrow('disposed')
  })
})
