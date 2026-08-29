import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { resolveLlmRouteCapability } from '@dsh-enhanced/llm-route-capabilities'
import { describe, expect, it } from 'vitest'
import * as Plugin from '../src/index.ts'

describe('dsh-enhanced-coding-subscription-provider', () => {
  it('exposes stable plugin and injection identity', () => {
    expect(Plugin.name).toBe('dsh-enhanced-coding-subscription-provider')
    expect(Plugin.inject).toEqual(['llm', 'sessions', 'agents'])
  })

  it('registers enabled providers and releases them with its Cordis fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(Plugin, Plugin.Config())
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual([
      'codex-subscription',
      'cursor-subscription',
    ])
    expect(resolveLlmRouteCapability(ctx.llm, 'codex-subscription', 'default'))
      .toMatchObject({ toolCalls: 'bridge' })
    expect(resolveLlmRouteCapability(ctx.llm, 'cursor-subscription', 'default'))
      .toMatchObject({ toolCalls: 'bridge' })
    await fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
    expect(resolveLlmRouteCapability(ctx.llm, 'codex-subscription', 'default')).toBeUndefined()
    expect(resolveLlmRouteCapability(ctx.llm, 'cursor-subscription', 'default')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('can mount with only one explicitly enabled CLI', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const config = Plugin.Config()
    config.claude.enabled = false
    config.cursor.enabled = false
    config.grok.enabled = false
    const fiber = await ctx.plugin(Plugin, config)
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['codex-subscription'])
    expect(resolveLlmRouteCapability(ctx.llm, 'codex-subscription', 'default'))
      .toMatchObject({ toolCalls: 'bridge' })
    expect(resolveLlmRouteCapability(ctx.llm, 'cursor-subscription', 'default')).toBeUndefined()
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('publishes the controlled tool bridge for every CLI-backed route', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const config = Plugin.Config()
    config.claude.enabled = true
    config.grok.enabled = true
    config.grok.userVerifiedSubscription = true
    const fiber = await ctx.plugin(Plugin, config)

    for (const provider of [
      'codex-subscription',
      'claude-subscription',
      'cursor-subscription',
      'grok-subscription',
    ]) {
      expect(resolveLlmRouteCapability(ctx.llm, provider, 'default'))
        .toMatchObject({ toolCalls: 'bridge' })
    }

    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('advertises native tool calls only for Codex direct while CLI routes use the controlled bridge', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const config = Plugin.Config()
    config.codex.transport = 'direct-responses'
    config.cursor.enabled = false
    const fiber = await ctx.plugin(Plugin, config)

    expect(resolveLlmRouteCapability(ctx.llm, 'codex-subscription', 'default'))
      .toMatchObject({ toolCalls: 'native' })

    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('observes attachment service installation and removal live without retaining the store', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const config = Plugin.Config()
    config.codex.transport = 'direct-responses'
    config.cursor.enabled = false
    const fiber = await ctx.plugin(Plugin, config)

    await expect(ctx.llm.listModels('codex-subscription')).resolves.toEqual([
      expect.objectContaining({ id: 'default', inputModalities: ['text'] }),
    ])

    const disposeAttachments = ctx.provide('attachments', {
      readImage: async (ref: never, _signal?: AbortSignal) => ({ ref, data: new Uint8Array([1]) }),
    } as never)
    await expect(ctx.llm.listModels('codex-subscription')).resolves.toEqual([
      expect.objectContaining({ id: 'default', inputModalities: ['text', 'image'] }),
    ])

    await disposeAttachments()
    await expect(ctx.llm.listModels('codex-subscription')).resolves.toEqual([
      expect.objectContaining({ id: 'default', inputModalities: ['text'] }),
    ])

    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
