/**
 * 工程层测试：全部通过 adapter deps 注入 fetch、并使用伪造的 cordis 服务面，
 * 不发起任何真实网络请求、不使用真实密钥。这些用例不代表真实 Super Relay
 * 外部系统证据；真实协议以 src/contract.ts 的短期 primary-source contract 为准。
 */
import { readFileSync } from 'node:fs'
import { EMPTY_RESPONSE_CODE, createMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SuperRelayGoalMeteredAdapter } from '../src/adapter.ts'
import { Config, normalizeConfig } from '../src/config.ts'
import { assertCurrentContract, SUPER_RELAY_INPUT_TOKEN_UPPER_BOUND, SUPER_RELAY_MODELS, SUPER_RELAY_PROVIDER, apply, name, version } from '../src/index.ts'
import type { GoalBudgetMeter } from '@dsh-enhanced/assistant-goals'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
const MODEL = 'auto_model/alwaysday1'

function userMessage(text: string) {
  return [createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })]
}

function streamOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: SUPER_RELAY_PROVIDER, model: MODEL, maxTokens: 32, messages: userMessage('hello'), ...overrides }
}

function completedResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: MODEL,
    status: 'completed',
    incomplete_details: null,
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'working' }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    ...overrides,
  }
}

function jsonFetch(response: Record<string, unknown>, initAssertions?: (init: RequestInit) => void) {
  return async (_url: string, init: RequestInit) => {
    initAssertions?.(init)
    return new Response(JSON.stringify(response), { status: 200 })
  }
}

async function collect(adapter: SuperRelayGoalMeteredAdapter, options: GenerateOptions) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

/** 仅实现 apply() 实际使用的 cordis 服务面，避免装载重型运行时。 */
function fakeCtx() {
  const meters: GoalBudgetMeter[] = []
  const releaseOrder: string[] = []
  let capturedAdapter: SuperRelayGoalMeteredAdapter | undefined
  let capturedRoutes: readonly string[] | undefined
  let disposer: (() => void) | undefined
  const credentials = { resolve: vi.fn(async () => ({ value: 'test-key' })) }
  const ctx = {
    get: vi.fn((key: string) => key === 'credentials' ? credentials : undefined),
    llm: {
      registerAdapter: vi.fn((routes: readonly string[], adapter: SuperRelayGoalMeteredAdapter) => {
        capturedRoutes = routes
        capturedAdapter = adapter
        return () => { releaseOrder.push('adapter') }
      }),
    },
    assistantGoals: {
      registerBudgetMeter: vi.fn((meter: GoalBudgetMeter) => {
        meters.push(meter)
        return () => { releaseOrder.push(`meter:${meter.model}`) }
      }),
    },
    effect: vi.fn((executor: () => () => void) => { disposer = executor(); return disposer }),
  }
  return { ctx: ctx as any, meters, releaseOrder, credentials, adapter: () => capturedAdapter!, routes: () => capturedRoutes!, unload: () => disposer?.() }
}

afterEach(() => { vi.useRealTimers() })

describe('dsh-enhanced-assistant-super-relay-budget', () => {
  it('exposes stable plugin identity', () => {
    expect(name).toBe('dsh-enhanced-assistant-super-relay-budget')
    expect(version).toBe(manifest.version)
    expect(SUPER_RELAY_PROVIDER).toBe('super-relay')
    expect([...SUPER_RELAY_MODELS]).toEqual([MODEL])
    expect(SUPER_RELAY_INPUT_TOKEN_UPPER_BOUND).toBe(200_000)
  })

  describe('config', () => {
    it('applies conservative defaults', () => {
      const config = normalizeConfig()
      expect(config.enabled).toBe(false)
      expect(config.apiKeyEnv).toBe('SUPER_RELAY_API_KEY')
      expect(config.timeoutMs).toBe(60_000)
      expect(config.maxResponseBytes).toBe(4 * 1024 * 1024)
      expect(config.defaultMaxTokens).toBe(8_192)
    })

    it('rejects unknown config fields', () => {
      expect(() => Config({ bogus: 1 } as any)).toThrow(/unknown config field/)
    })

    it('rejects a non-constant-style apiKeyEnv name', () => {
      expect(() => normalizeConfig({ apiKeyEnv: 'lower_case' })).toThrow(/apiKeyEnv/)
    })
  })

  describe('apply lifecycle', () => {
    it('registers nothing while disabled', () => {
      const f = fakeCtx()
      apply(f.ctx, { enabled: false })
      expect(f.ctx.llm.registerAdapter).not.toHaveBeenCalled()
      expect(f.ctx.assistantGoals.registerBudgetMeter).not.toHaveBeenCalled()
    })

    it('registers the route adapter and one meter per model, then tears everything down on unload', async () => {
      const f = fakeCtx()
      apply(f.ctx, { enabled: true })
      expect(f.routes()).toEqual([SUPER_RELAY_PROVIDER])
      expect(f.adapter()).toBeInstanceOf(SuperRelayGoalMeteredAdapter)
      expect(f.meters.map(meter => meter.model)).toEqual([...SUPER_RELAY_MODELS])

      f.unload!()
      expect(f.releaseOrder).toContain('adapter')
      for (const model of SUPER_RELAY_MODELS) expect(f.releaseOrder).toContain(`meter:${model}`)
      // shutdown() flips the adapter inactive, so streaming is refused after unload.
      await expect(collect(f.adapter(), streamOptions())).rejects.toThrow()
    })
  })

  describe('goal meter', () => {
    function meters() {
      const f = fakeCtx()
      apply(f.ctx, { enabled: true })
      return f.meters
    }

    it('returns the conservative bound for a valid route and maxTokens', () => {
      const meter = meters()[0]!
      expect(meter.inputTokenUpperBound(streamOptions())).toBe(SUPER_RELAY_INPUT_TOKEN_UPPER_BOUND)
      expect(meter.inputUsdMicrosPerMillionTokens).toBeNull()
      expect(meter.outputUsdMicrosPerMillionTokens).toBeNull()
    })

    it.each([
      ['wrong provider', { provider: 'elsewhere' }],
      ['wrong model', { model: 'other-model' }],
      ['zero maxTokens', { maxTokens: 0 }],
      ['maxTokens above cap', { maxTokens: 32_769 }],
      ['fractional maxTokens', { maxTokens: 1.5 }],
    ])('rejects %s', (_label, override) => {
      const meter = meters()[0]!
      expect(() => meter.inputTokenUpperBound(streamOptions(override))).toThrow(/invalid route or maxTokens/)
    })

    it('fails closed once the protocol contract expires', () => {
      // Right now the contract is current, so the meter's bound does not throw.
      expect(() => meters()[0]!.inputTokenUpperBound(streamOptions())).not.toThrow()
      // The meter's bound calls this same shared contract gate internally.
      expect(() => assertCurrentContract(Date.parse('2026-11-01T00:00:00.000Z'))).toThrow(/contract has expired/)
    })
  })

  describe('Responses adapter protocol', () => {
    it('projects a completed text turn with disjoint usage and finish=stop', async () => {
      const adapter = new SuperRelayGoalMeteredAdapter(Config({ enabled: true }), {
        environment: { SUPER_RELAY_API_KEY: 'test-key' },
        fetch: jsonFetch(completedResponse(), init => {
          expect(init.redirect).toBe('error')
          expect(init.credentials).toBe('omit')
          expect(init.headers).toMatchObject({ authorization: 'Bearer test-key', accept: 'application/json' })
          expect(JSON.parse(String(init.body))).toMatchObject({ model: MODEL, stream: false, max_output_tokens: 32 })
        }),
      })
      const chunks = await collect(adapter, streamOptions())
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(chunks.find(chunk => chunk.type === 'usage')).toMatchObject({ usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } })
    })

    it('maps a function_call output item to a tool-call block with finish=tool-calls', async () => {
      const response = completedResponse({
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'calling' }] },
          { type: 'function_call', call_id: 'call_1', name: 'inspect', arguments: '{"x":1}' },
        ],
      })
      const adapter = new SuperRelayGoalMeteredAdapter(Config({ enabled: true }), { environment: { SUPER_RELAY_API_KEY: 'test-key' }, fetch: jsonFetch(response) })
      const chunks = await collect(adapter, streamOptions({ tools: [{ name: 'inspect', description: 'inspect a thing', parameters: { type: 'object' } }] }))
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
      const blockEnd = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
      expect(blockEnd).toMatchObject({ block: { name: 'inspect', arguments: '{"x":1}' } })
    })

    it.each([
      ['usage totals that are not additive', { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 99 } }],
      ['a non-array output', { output: 'nope' }],
      ['an unknown status', { status: 'failed' }],
    ])('rejects %s', async (_label, override) => {
      const adapter = new SuperRelayGoalMeteredAdapter(Config({ enabled: true }), { environment: { SUPER_RELAY_API_KEY: 'test-key' }, fetch: jsonFetch(completedResponse(override)) })
      await expect(collect(adapter, streamOptions())).rejects.toThrow()
    })

    it('flags an empty completion with the empty-response code', async () => {
      const adapter = new SuperRelayGoalMeteredAdapter(Config({ enabled: true }), { environment: { SUPER_RELAY_API_KEY: 'test-key' }, fetch: jsonFetch(completedResponse({ output: [] })) })
      await expect(collect(adapter, streamOptions())).rejects.toMatchObject({ code: EMPTY_RESPONSE_CODE })
    })

    it('rejects a system-role message; system text must travel as instructions', async () => {
      const adapter = new SuperRelayGoalMeteredAdapter(Config({ enabled: true }), { environment: { SUPER_RELAY_API_KEY: 'test-key' }, fetch: jsonFetch(completedResponse()) })
      const options = { ...streamOptions(), messages: [{ role: 'system', content: [{ type: 'text', text: 'be brief' }] }] } as GenerateOptions
      await expect(collect(adapter, options)).rejects.toThrow(/system prompt must be supplied as instructions/)
    })

    it('fails closed after contract expiry even with a healthy fetch', async () => {
      const adapter = new SuperRelayGoalMeteredAdapter(Config({ enabled: true }), {
        now: () => Date.parse('2026-11-01T00:00:00.000Z'),
        environment: { SUPER_RELAY_API_KEY: 'test-key' },
        fetch: jsonFetch(completedResponse()),
      })
      await expect(collect(adapter, streamOptions())).rejects.toThrow(/contract has expired/)
    })
  })

  describe('credentials', () => {
    it('fails with a missing credential rather than dispatching keyless', async () => {
      const adapter = new SuperRelayGoalMeteredAdapter(Config({ enabled: true }), { environment: {}, fetch: jsonFetch(completedResponse()) })
      await expect(collect(adapter, streamOptions())).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    })

    it('authorizes with a key resolved through the injected credential resolver', async () => {
      const resolver = { resolve: vi.fn(async () => ({ value: 'resolved-key' })) }
      const adapter = new SuperRelayGoalMeteredAdapter(Config({ enabled: true }), {
        credentialResolver: () => resolver,
        environment: {},
        fetch: jsonFetch(completedResponse(), init => expect(init.headers).toMatchObject({ authorization: 'Bearer resolved-key' })),
      })
      await collect(adapter, streamOptions())
      expect(resolver.resolve).toHaveBeenCalledOnce()
    })
  })

  describe('cancellation', () => {
    it('rejects a hanging upstream within its timeout instead of awaiting forever', async () => {
      const hanging = () => new Promise<Response>(() => {})
      const adapter = new SuperRelayGoalMeteredAdapter(Config({ enabled: true, timeoutMs: 1_000 }), { environment: { SUPER_RELAY_API_KEY: 'test-key' }, fetch: hanging })
      const started = Date.now()
      await expect(collect(adapter, streamOptions())).rejects.toThrow()
      expect(Date.now() - started).toBeLessThan(3_000)
    }, 8_000)
  })
})
