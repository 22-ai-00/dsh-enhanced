import { Context } from '@deepseek-ai/cordis'
import { createMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { DEEPSEEK_CHAT_COMPLETIONS_CONTRACT, DEEPSEEK_INPUT_TOKEN_UPPER_BOUND, DEEPSEEK_PROVIDER } from '@dsh-enhanced/assistant-deepseek-budget'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNativeAdapter } from '../../src/benchmark/deepseek.js'
import type { NativeModelConfig } from '../../src/benchmark/native.js'

const digest = 'a'.repeat(64)
const model = (): NativeModelConfig => ({
  provider: DEEPSEEK_PROVIDER,
  model: 'deepseek-v4-flash',
  temperature: null,
  inputLimitMode: 'upper-bound',
  outputLimitMode: 'provider',
  maxOutputTokens: 17,
  inputUsdMicrosPerMillionTokens: null,
  outputUsdMicrosPerMillionTokens: null,
  adapterDigest: digest,
  tokenCounterDigest: digest,
})

const request = (input = model()): GenerateOptions => ({
  provider: input.provider,
  model: input.model,
  maxTokens: input.maxOutputTokens,
  messages: [createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })],
})

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('DeepSeek native benchmark adapter', () => {
  it('uses the production adapter with frozen wire limit and validated usage', async () => {
    const calls: Array<{ url: unknown; init: RequestInit }> = []
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-only-key')
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({
        model: 'deepseek-v4-flash',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 3, prompt_cache_hit_tokens: 1, prompt_cache_miss_tokens: 2, completion_tokens: 4, total_tokens: 7 },
      }))
    }))
    const binding = await createNativeAdapter(model(), { ctx: new Context(), workspace: '/unused' })
    const chunks = await collect(binding.adapter.stream(request()))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.deepseek.com/chat/completions')
    expect(calls[0]!.init.redirect).toBe('error')
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ model: 'deepseek-v4-flash', stream: false, max_tokens: 17 })
    expect(chunks.find(chunk => chunk.type === 'usage')).toMatchObject({ usage: { inputTokens: 2, cacheReadTokens: 1, outputTokens: 4, totalTokens: 7 } })
    expect(binding.inputTokenUpperBound?.(request())).toBe(DEEPSEEK_INPUT_TOKEN_UPPER_BOUND)
    expect(binding.adapter.providerRetryPolicy(DEEPSEEK_PROVIDER)).toMatchObject({ maxRetries: 0 })
    await expect(binding.adapter.listModels(DEEPSEEK_PROVIDER)).resolves.toMatchObject([{ id: 'deepseek-v4-flash' }])
    await expect(binding.adapter.resolveModel(DEEPSEEK_PROVIDER, 'deepseek-v4-flash')).resolves.toMatchObject({ id: 'deepseek-v4-flash' })
    binding.dispose()
  })

  it('resolves the credentials service at each production request', async () => {
    const ctx = new Context(); let resolves = 0
    ctx.provide('credentials' as never, { async resolve() { resolves++; return { value: 'test-only-key' } } } as never)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      model: 'deepseek-v4-flash', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }))))
    const binding = await createNativeAdapter(model(), { ctx, workspace: '/unused' })
    await collect(binding.adapter.stream(request()))
    await collect(binding.adapter.stream(request()))
    expect(resolves).toBe(2)
    binding.dispose()
  })

  it.each([
    (input: NativeModelConfig) => { input.provider = 'other' },
    (input: NativeModelConfig) => { input.model = 'deepseek-v4-unknown' },
    (input: NativeModelConfig) => { input.inputLimitMode = 'estimate' },
    (input: NativeModelConfig) => { input.outputLimitMode = 'observed' },
    (input: NativeModelConfig) => { input.temperature = 3 },
    (input: NativeModelConfig) => { input.maxOutputTokens = 32_769 },
    (input: NativeModelConfig) => { input.inputUsdMicrosPerMillionTokens = 1 },
    (input: NativeModelConfig) => { input.outputUsdMicrosPerMillionTokens = 1 },
    (input: NativeModelConfig) => { input.cacheReadUsdMicrosPerMillionTokens = 1 },
    (input: NativeModelConfig) => { input.cacheWriteUsdMicrosPerMillionTokens = 1 },
  ])('rejects a model configuration outside the fixed unpriced route', async mutate => {
    const input = model(); mutate(input)
    await expect(createNativeAdapter(input, { ctx: new Context(), workspace: '/unused' })).rejects.toThrow()
  })

  it('rejects route, model, limit, and temperature drift before dispatch', async () => {
    const fetched = vi.fn()
    vi.stubGlobal('fetch', fetched)
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-only-key')
    const input = model(); input.temperature = 0
    const binding = await createNativeAdapter(input, { ctx: new Context(), workspace: '/unused' })
    for (const mutate of [
      (options: GenerateOptions) => { options.provider = 'other' },
      (options: GenerateOptions) => { options.model = 'deepseek-v4-pro' },
      (options: GenerateOptions) => { options.maxTokens = 16 },
      (options: GenerateOptions) => { options.temperature = 1 },
    ]) {
      const options = { ...request(input), temperature: 0 }
      mutate(options)
      await expect(collect(binding.adapter.stream(options))).rejects.toThrow('request drift')
      expect(() => binding.inputTokenUpperBound?.(options)).toThrow('request drift')
    }
    expect(fetched).not.toHaveBeenCalled()
    binding.dispose()
  })

  it('rejects an expired contract and refuses requests after idempotent disposal', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(DEEPSEEK_CHAT_COMPLETIONS_CONTRACT.expiresAt))
    await expect(createNativeAdapter(model(), { ctx: new Context(), workspace: '/unused' })).rejects.toThrow('contract has expired')
    vi.restoreAllMocks()
    const binding = await createNativeAdapter(model(), { ctx: new Context(), workspace: '/unused' })
    binding.dispose(); binding.dispose()
    await expect(collect(binding.adapter.stream(request()))).rejects.toThrow('disposed')
    expect(() => binding.inputTokenUpperBound?.(request())).toThrow('disposed')
  })
})
