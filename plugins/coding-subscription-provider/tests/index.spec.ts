import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import * as Plugin from '../src/index.ts'

describe('dsh-enhanced-coding-subscription-provider', () => {
  it('exposes stable plugin and injection identity', () => {
    expect(Plugin.name).toBe('dsh-enhanced-coding-subscription-provider')
    expect(Plugin.inject).toEqual(['llm'])
  })

  it('registers enabled providers and releases them with its Cordis fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const fiber = await ctx.plugin(Plugin, Plugin.Config())
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual([
      'codex-subscription',
      'cursor-subscription',
    ])
    await fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('can mount with only one explicitly enabled CLI', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const config = Plugin.Config()
    config.claude.enabled = false
    config.cursor.enabled = false
    config.grok.enabled = false
    const fiber = await ctx.plugin(Plugin, config)
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['codex-subscription'])
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
