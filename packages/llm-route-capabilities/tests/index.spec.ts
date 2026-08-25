import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { describe, expect, test } from 'vitest'
import {
  registerLlmRouteCapability,
  resolveLlmRouteCapability,
} from '../src/index.ts'

async function runtime() {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  return ctx
}

describe('LLM route capability registry', () => {
  test('resolves a provider declaration and lets an exact model override it', async () => {
    const ctx = await runtime()
    registerLlmRouteCapability(ctx.llm, { provider: 'provider-a', toolCalls: 'native' })
    registerLlmRouteCapability(ctx.llm, { provider: 'provider-a', model: 'text-only', toolCalls: 'none' })

    expect(resolveLlmRouteCapability(ctx.llm, 'provider-a', 'general')).toEqual({
      provider: 'provider-a',
      toolCalls: 'native',
    })
    expect(resolveLlmRouteCapability(ctx.llm, 'provider-a', 'text-only')).toEqual({
      provider: 'provider-a',
      model: 'text-only',
      toolCalls: 'none',
    })
    await ctx.fiber.dispose()
  })

  test('rejects duplicate selectors without replacing the original declaration', async () => {
    const ctx = await runtime()
    registerLlmRouteCapability(ctx.llm, { provider: 'provider-a', toolCalls: 'bridge' })

    expect(() => registerLlmRouteCapability(ctx.llm, {
      provider: 'provider-a',
      toolCalls: 'bridge',
    })).toThrow(/duplicate.*provider-a/i)
    expect(() => registerLlmRouteCapability(ctx.llm, {
      provider: 'provider-a',
      toolCalls: 'none',
    })).toThrow(/duplicate.*provider-a/i)
    expect(resolveLlmRouteCapability(ctx.llm, 'provider-a', 'model')).toMatchObject({ toolCalls: 'bridge' })
    await ctx.fiber.dispose()
  })

  test('uses token-safe idempotent disposers across re-registration', async () => {
    const ctx = await runtime()
    const disposeOld = registerLlmRouteCapability(ctx.llm, { provider: 'provider-a', toolCalls: 'none' })
    disposeOld()
    const disposeCurrent = registerLlmRouteCapability(ctx.llm, { provider: 'provider-a', toolCalls: 'native' })

    disposeOld()
    expect(resolveLlmRouteCapability(ctx.llm, 'provider-a', 'model')).toMatchObject({ toolCalls: 'native' })
    disposeCurrent()
    disposeCurrent()
    expect(resolveLlmRouteCapability(ctx.llm, 'provider-a', 'model')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  test('isolates declarations by exact LlmRuntime instance', async () => {
    const first = await runtime()
    const second = await runtime()
    registerLlmRouteCapability(first.llm, { provider: 'provider-a', toolCalls: 'bridge' })

    expect(resolveLlmRouteCapability(first.llm, 'provider-a', 'model')).toMatchObject({ toolCalls: 'bridge' })
    expect(resolveLlmRouteCapability(second.llm, 'provider-a', 'model')).toBeUndefined()
    await first.fiber.dispose()
    await second.fiber.dispose()
  })

  test('validates selector and tool-call mode at the registry boundary', async () => {
    const ctx = await runtime()
    expect(() => registerLlmRouteCapability(ctx.llm, {
      provider: '',
      toolCalls: 'native',
    })).toThrow(/provider/i)
    expect(() => registerLlmRouteCapability(ctx.llm, {
      provider: 'provider-a',
      model: '',
      toolCalls: 'native',
    })).toThrow(/model/i)
    expect(() => registerLlmRouteCapability(ctx.llm, {
      provider: 'provider-a',
      toolCalls: 'future' as 'native',
    })).toThrow(/tool.*mode/i)
    await ctx.fiber.dispose()
  })
})
