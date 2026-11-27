import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { resolveLlmRouteCapability } from '@dsh-ray/llm-route-capabilities'
import { describe, expect, it } from 'vitest'
import * as Plugin from '../src/index.ts'

describe('dsh-ray-traex-acp-provider', () => {
  it('exposes stable plugin and injection identity', () => {
    expect(Plugin.name).toBe('dsh-ray-traex-acp-provider')
    expect(Plugin.inject).toEqual(['llm', 'sessions', 'agents'])
    expect(Plugin.probeTraexReadiness).toBeTypeOf('function')
    expect(Plugin.probeAcpReadiness).toBeTypeOf('function')
    expect(Plugin.resolveAcpCommand).toBeTypeOf('function')
    expect(Plugin.DEFAULT_CATALOG_CACHE_TTL_MS).toBe(20 * 60_000)
    expect(Plugin.DEFAULT_MAX_REQUEST_IMAGE_BYTES).toBe(24 * 1024 * 1024)
    expect(Plugin.ACP_PROVIDER_ROUTES).toEqual(['traex-agent', 'agy-agent'])
  })

  it('declares the verified 0.2 DSH line so the live app can install it', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      peerDependencies: Record<string, string>
    }
    for (const name of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session']) {
      expect(manifest.peerDependencies[name]).toBe('>=0.2.2-rc.5 <0.3.0')
    }
  })

  it('is disabled by default while advertising configurable ACP providers', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    ctx.provide('sessionProjections', {
      register: async () => ({ stateOf: () => ({}), readerFor: () => () => ({}), dispose: async () => {} }),
    } as never)
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(Plugin, Plugin.Config())
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider)).toEqual(['traex-agent', 'agy-agent'])
    await fiber.dispose()
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('registers opted-in TraeX and releases it with the Cordis fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    ctx.provide('sessionProjections', {
      register: async () => ({ stateOf: () => ({}), readerFor: () => () => ({}), dispose: async () => {} }),
    } as never)
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

  it('registers Antigravity alone or alongside TraeX and releases both on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    ctx.provide('sessionProjections', {
      register: async () => ({ stateOf: () => ({}), readerFor: () => () => ({}), dispose: async () => {} }),
    } as never)
    await ctx.plugin(AgentRegistry)

    const agyOnlyConfig = Plugin.Config()
    agyOnlyConfig.agyEnabled = true
    const agyFiber = await ctx.plugin(Plugin, agyOnlyConfig)
    expect(ctx.llm.listProviders()).toEqual([{ id: 'agy-agent', name: 'Antigravity Agent (local ACP)' }])
    expect(resolveLlmRouteCapability(ctx.llm, 'agy-agent', 'default'))
      .toEqual({ provider: 'agy-agent', toolCalls: 'bridge' })
    await agyFiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])

    const bothConfig = Plugin.Config()
    bothConfig.enabled = true
    bothConfig.agyEnabled = true
    const bothFiber = await ctx.plugin(Plugin, bothConfig)
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['traex-agent', 'agy-agent'])
    expect(resolveLlmRouteCapability(ctx.llm, 'traex-agent', 'default'))
      .toEqual({ provider: 'traex-agent', toolCalls: 'bridge' })
    expect(resolveLlmRouteCapability(ctx.llm, 'agy-agent', 'default'))
      .toEqual({ provider: 'agy-agent', toolCalls: 'bridge' })
    await bothFiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
    expect(resolveLlmRouteCapability(ctx.llm, 'traex-agent', 'default')).toBeUndefined()
    expect(resolveLlmRouteCapability(ctx.llm, 'agy-agent', 'default')).toBeUndefined()
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('wires optional ctx.attachments dynamically into registered traex-agent and agy-agent routes', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    ctx.provide('sessionProjections', {
      register: async () => ({ stateOf: () => ({}), readerFor: () => () => ({}), dispose: async () => {} }),
    } as never)
    await ctx.plugin(AgentRegistry)

    const config = Plugin.Config()
    config.enabled = true
    config.agyEnabled = true
    await ctx.plugin(Plugin, config)

    await expect(ctx.llm.resolveModelInfo('agy-agent', 'gemini-pro-orchestrator-neon')).resolves.toMatchObject({
      inputModalities: ['text'],
    })
    await expect(ctx.llm.resolveModelInfo('traex-agent', 'default')).resolves.toMatchObject({
      inputModalities: ['text'],
    })

    const disposeAttachments = ctx.provide('attachments' as never, {
      readImage: async (ref: never) => ({ ref, data: Uint8Array.from([1, 2, 3]) }),
    } as never)

    await expect(ctx.llm.resolveModelInfo('agy-agent', 'gemini-pro-orchestrator-neon')).resolves.toMatchObject({
      inputModalities: ['text', 'image'],
    })
    await expect(ctx.llm.resolveModelInfo('traex-agent', 'default')).resolves.toMatchObject({
      inputModalities: ['text', 'image'],
    })

    disposeAttachments()
    await expect(ctx.llm.resolveModelInfo('agy-agent', 'gemini-pro-orchestrator-neon')).resolves.toMatchObject({
      inputModalities: ['text'],
    })

    await ctx.fiber.dispose()
  })
})
