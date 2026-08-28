import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { resolveLlmRouteCapability } from '@dsh-enhanced/llm-route-capabilities'
import { describe, expect, it } from 'vitest'
import * as Plugin from '../src/index.ts'

describe('dsh-enhanced-traex-acp-provider', () => {
  it('exposes stable plugin and injection identity', () => {
    expect(Plugin.name).toBe('dsh-enhanced-traex-acp-provider')
    expect(Plugin.inject).toEqual(['llm', 'sessions', 'agents'])
    expect(Plugin.probeTraexReadiness).toBeTypeOf('function')
  })

  it('is disabled by default', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(Plugin, Plugin.Config())
    expect(ctx.llm.listProviders()).toEqual([])
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('registers opted-in TraeX and releases it with the Cordis fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const config = Plugin.Config()
    config.enabled = true
    const fiber = await ctx.plugin(Plugin, config)
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['traex-agent'])
    expect(resolveLlmRouteCapability(ctx.llm, 'traex-agent', 'default'))
      .toEqual({ provider: 'traex-agent', toolCalls: 'bridge' })
    await fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
    expect(resolveLlmRouteCapability(ctx.llm, 'traex-agent', 'default')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
