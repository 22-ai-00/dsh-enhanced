import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createAssistantMessage,
  createMessage,
  deepFreeze,
  freezeMessage,
  type GenerateOptions,
} from '@deepseek-ai/dsh-llm'
import { describe, expect, test } from 'vitest'
import {
  createAgentLoopRequestAttestor,
  registerLlmRouteCapability,
  resolveLlmRouteCapability,
} from '../src/index.ts'

async function runtime() {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  return ctx
}

const SESSION_ID = 'session-live' as NonNullable<GenerateOptions['sessionId']>

function attestorFixture(messages: GenerateOptions['messages']) {
  const header = {
    config: { provider: 'traex-agent', model: 'default', maxTokens: 2048 },
    system: 'system prompt',
    tools: [{ name: 'lookup', description: 'Lookup', parameters: { type: 'object' } }],
  }
  const session = {
    id: SESSION_ID,
    header: { cwd: '/workspace' },
    requestHeader: () => header,
    deriveMessages: () => [...messages],
  }
  const agent = {
    id: SESSION_ID,
    status: 'running',
    session,
  }
  let current: unknown = agent
  let registered: unknown = agent
  const attestor = createAgentLoopRequestAttestor({
    currentInitiator: () => current as never,
    get: () => registered as never,
  }, ['traex-agent'])
  return {
    agent,
    attestor,
    header,
    session,
    setCurrent(value: unknown) { current = value },
    setRegistered(value: unknown) { registered = value },
  }
}

function envelope(
  messages: GenerateOptions['messages'],
  overrides: Partial<GenerateOptions> = {},
): GenerateOptions {
  return deepFreeze({
    provider: 'traex-agent',
    model: 'default',
    maxTokens: 2048,
    messages,
    system: 'system prompt',
    tools: [{ name: 'lookup', description: 'Lookup', parameters: { type: 'object' } }],
    sessionId: SESSION_ID,
    signal: new AbortController().signal,
    ...overrides,
  })
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

describe('Agent Loop request attestor', () => {
  test('accepts an exact frozen ordinary request for the exact running Agent and Session', () => {
    const message = createMessage({
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'hello' }],
    })
    const fixture = attestorFixture([message])

    expect(fixture.attestor.claim(envelope([message]), fixture.session)).toBe(true)
  })

  test('accepts only the forAdapter replayState-removal clone of derived history', () => {
    const historical = createAssistantMessage({
      source: { provider: 'super-relay', model: 'relay-model', replayState: { cursor: 'private' } },
      content: [{ type: 'text', text: 'prior answer' }],
    })
    const stripped = freezeMessage({
      ...historical,
      source: { kind: 'model' as const, provider: 'super-relay', model: 'relay-model' },
    })
    const fixture = attestorFixture([historical])

    expect(fixture.attestor.claim(envelope([stripped]), fixture.session)).toBe(true)
    const changed = freezeMessage({
      ...stripped,
      content: [{ type: 'text' as const, text: 'tampered' }],
    })
    expect(fixture.attestor.claim(envelope([changed]), fixture.session)).toBe(false)
  })

  test('does not accept replayState removal from a route owned by the target adapter', () => {
    const historical = createAssistantMessage({
      source: { provider: 'traex-agent', model: 'old-model', replayState: { cursor: 'owned' } },
      content: [{ type: 'text', text: 'prior answer' }],
    })
    const stripped = freezeMessage({
      ...historical,
      source: { kind: 'model' as const, provider: 'traex-agent', model: 'old-model' },
    })
    const fixture = attestorFixture([historical])

    expect(fixture.attestor.claim(envelope([stripped]), fixture.session)).toBe(false)
  })

  test('rejects empty, duplicate, and malformed owned route declarations', () => {
    const agents = { currentInitiator: () => undefined, get: () => undefined }
    expect(() => createAgentLoopRequestAttestor(agents as never, [])).toThrow(/provider routes/i)
    expect(() => createAgentLoopRequestAttestor(agents as never, ['route', 'route'])).toThrow(/provider routes/i)
    expect(() => createAgentLoopRequestAttestor(agents as never, ['bad route'])).toThrow(/provider routes/i)
  })

  test('rejects auxiliary, transformed, shallow-frozen, stale, and ambient-only calls', () => {
    const message = createMessage({
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'hello' }],
    })
    const fixture = attestorFixture([message])

    expect(fixture.attestor.claim(envelope([message], { purpose: 'session-title' }), fixture.session)).toBe(false)
    expect(fixture.attestor.claim(deepFreeze({
      ...envelope([message]),
      purpose: undefined,
    } as unknown as GenerateOptions), fixture.session)).toBe(false)
    expect(fixture.attestor.claim(deepFreeze({ ...envelope([message]), extra: true }) as GenerateOptions, fixture.session)).toBe(false)
    expect(fixture.attestor.claim(Object.freeze({
      ...envelope([message]),
      messages: [{ ...message, content: [{ type: 'text' as const, text: 'mutable' }] }],
    }), fixture.session)).toBe(false)

    fixture.setRegistered({ ...fixture.agent })
    expect(fixture.attestor.claim(envelope([message]), fixture.session)).toBe(false)
    fixture.setRegistered(fixture.agent)
    fixture.setCurrent({ ...fixture.agent, status: 'idle' })
    expect(fixture.attestor.claim(envelope([message]), fixture.session)).toBe(false)
    fixture.setCurrent(undefined)
    expect(fixture.attestor.claim(envelope([message]), fixture.session)).toBe(false)
    fixture.setCurrent(fixture.agent)
    expect(fixture.attestor.claim(envelope([message]), { ...fixture.session })).toBe(false)
  })
})
