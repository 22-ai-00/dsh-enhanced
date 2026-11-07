import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createNativeAdapter, dshUsage } from '../scripts/benchmark/openai-compatible-adapter.mjs'
import { developmentCorpus } from '../plugins/assistant-evaluation/src/benchmark/corpus.ts'
import { createNativeBenchmarkExecutor, nativeBenchmarkPlan, type NativeBenchmarkConfig } from '../plugins/assistant-evaluation/src/benchmark/native.ts'
import { benchmarkSchedule } from '../plugins/assistant-evaluation/src/benchmark/schema.ts'

const adapterPath = join(import.meta.dirname, '..', 'scripts', 'benchmark', 'openai-compatible-adapter.mjs')
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function environment(max = 4) {
  const root = await mkdtemp(join(tmpdir(), 'gateway-adapter-')); roots.push(root)
  const ledger = join(root, 'calls.ndjson'); const trace = join(root, 'trace.ndjson')
  return { root, ledger, trace, env: {
    DSH_BENCH_GATEWAY_BASE_URL: 'https://gateway.invalid/v1/', BENCHMARK_API_KEY: 'test-key-not-secret',
    DSH_BENCH_GATEWAY_CALL_LEDGER: ledger, DSH_BENCH_GATEWAY_MAX_CALLS: String(max), DSH_BENCHMARK_TRACE: trace,
  } as Record<string, string> }
}

function sse(events: readonly unknown[], status = 200): Response {
  const body = events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('')
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
}

const model = (overrides: Record<string, unknown> = {}) => ({
  provider: 'benchmark-gateway', model: 'benchmark-model', temperature: 0, inputLimitMode: 'estimate', outputLimitMode: 'provider', maxOutputTokens: 100,
  inputUsdMicrosPerMillionTokens: null, outputUsdMicrosPerMillionTokens: null, adapterDigest: 'a'.repeat(64), tokenCounterDigest: 'a'.repeat(64), ...overrides,
})

const request = (overrides: Partial<GenerateOptions> = {}): GenerateOptions => ({
  provider: 'benchmark-gateway', model: 'benchmark-model', temperature: 0, maxTokens: 50,
  messages: [{ role: 'system', content: [{ type: 'text', text: 'persona' }] } as never, { role: 'user', content: [{ type: 'text', text: 'question' }] }],
  ...overrides,
})

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('Gateway OpenAI benchmark adapter', () => {
  test('fails closed for any other route, priced budget, or missing environment', async () => {
    const { env } = await environment()
    expect(() => createNativeAdapter(model({ provider: 'other' }), {}, { env, fetch: () => { throw new Error('no network') } })).toThrow('accepts only')
    expect(() => createNativeAdapter(model({ model: 'deepseek-chat' }), {}, { env })).toThrow('accepts only')
    expect(() => createNativeAdapter(model({ inputLimitMode: 'upper-bound' }), {}, { env })).toThrow('estimate')
    expect(() => createNativeAdapter(model({ inputUsdMicrosPerMillionTokens: 1, outputUsdMicrosPerMillionTokens: 1 }), {}, { env })).toThrow('null tariffs')
    for (const key of ['DSH_BENCH_GATEWAY_BASE_URL', 'BENCHMARK_API_KEY', 'DSH_BENCH_GATEWAY_CALL_LEDGER', 'DSH_BENCH_GATEWAY_MAX_CALLS']) {
      const partial = { ...env }; delete partial[key]
      expect(() => createNativeAdapter(model(), {}, { env: partial })).toThrow()
    }
    expect(() => createNativeAdapter(model(), {}, { env: { ...env, DSH_BENCH_GATEWAY_BASE_URL: 'https://u:p@gateway.invalid/v1' } })).toThrow('plain')
  })

  test('declares one route with retries disabled', async () => {
    const { env } = await environment()
    const { adapter, dispose } = createNativeAdapter(model(), {}, { env })
    expect(adapter.providerInfo('benchmark-gateway')).toEqual({ id: 'benchmark-gateway', name: expect.any(String) })
    expect(() => adapter.providerInfo('deepseek')).toThrow()
    expect(adapter.providerRetryPolicy('benchmark-gateway')).toMatchObject({ mode: 'normal', maxRetries: 0 })
    expect((await adapter.listModels('benchmark-gateway')).map((item: { id: string }) => item.id)).toEqual(['benchmark-model'])
    await expect(adapter.resolveModel('benchmark-gateway', 'benchmark-model')).resolves.toMatchObject({ id: 'benchmark-model' })
    await expect(adapter.resolveModel('benchmark-gateway', 'other')).rejects.toThrow()
    await dispose()
  })

  test('POSTs a streamed chat/completions request and emits reasoning, text, usage, finish', async () => {
    const { env, ledger, trace } = await environment()
    const seen: { url: string; init: RequestInit }[] = []
    const fetch = async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return sse([
        { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'think' } }] },
        { choices: [{ index: 0, delta: { content: 'Hel' } }] },
        { choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 30, completion_tokens: 7, total_tokens: 37, prompt_tokens_details: { cached_tokens: 10 }, completion_tokens_details: { reasoning_tokens: 2 } } },
        '[DONE]',
      ])
    }
    const { adapter, inputTokenEstimate } = createNativeAdapter(model(), {}, { env, fetch })
    const chunks = await collect(adapter.stream(request()))
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe('https://gateway.invalid/v1/chat/completions')
    expect(seen[0]!.init.method).toBe('POST')
    const headers = seen[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer test-key-not-secret'); expect(headers['user-agent'] ?? headers['User-Agent']).toBeTruthy()
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({
      model: 'benchmark-model', stream: true, stream_options: { include_usage: true }, temperature: 0, max_tokens: 50,
      messages: [{ role: 'system', content: 'persona' }, { role: 'user', content: 'question' }],
    })
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' }, { type: 'reasoning-delta', index: 0, text: 'think' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think' } },
      { type: 'block-start', index: 1, blockType: 'text' }, { type: 'text-delta', index: 1, text: 'Hel' }, { type: 'text-delta', index: 1, text: 'lo' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello' } },
      { type: 'usage', usage: { inputTokens: 20, cacheReadTokens: 10, outputTokens: 7, reasoningTokens: 2, totalTokens: 37 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect((await readFile(ledger, 'utf8')).trim().split('\n')).toHaveLength(1)
    const traced = await readFile(trace, 'utf8')
    expect(traced).toContain('"output":"Hello"'); expect(traced).not.toContain('test-key-not-secret'); expect(traced).not.toContain('gateway.invalid')
    expect(inputTokenEstimate(request())).toBeGreaterThan(2_048)
  })

  test('refuses before sending once the shared call cap is reached', async () => {
    const { env, ledger } = await environment(2)
    await writeFile(ledger, '{"n":1}\n')
    let sent = 0
    const fetch = async () => { sent++; return sse([{ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }]) }
    const { adapter } = createNativeAdapter(model(), {}, { env, fetch })
    await collect(adapter.stream(request()))
    await expect(collect(adapter.stream(request()))).rejects.toThrow('call cap reached (2/2)')
    expect(sent).toBe(1)
  })

  test('maps HTTP failures, missing usage, tool calls and foreign content to errors without leaking the key', async () => {
    const { env } = await environment(10)
    const cases: [() => Response, string][] = [
      [() => new Response('denied test-key-not-secret', { status: 401 }), 'HTTP 401'],
      [() => sse([{ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }] }]), 'without usage'],
      [() => sse([{ choices: [{ index: 0, delta: { tool_calls: [{ id: 't' }] } }] }]), 'tool call'],
      [() => sse([{ choices: [{ index: 0, delta: { content: 'x' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }]), 'finish_reason'],
    ]
    for (const [response, message] of cases) {
      const { adapter } = createNativeAdapter(model(), {}, { env, fetch: async () => response() })
      const error = await collect(adapter.stream(request())).then(() => undefined, (caught: Error) => caught)
      expect(error?.message).toContain(message); expect(error?.message).not.toContain('test-key-not-secret')
    }
    const { adapter } = createNativeAdapter(model(), {}, { env, fetch: async () => { throw new Error('must not send') } })
    await expect(collect(adapter.stream(request({ tools: [{ name: 't', description: 'd', parameters: {} } as never] })))).rejects.toThrow('does not send tools')
    await expect(collect(adapter.stream(request({ messages: [{ role: 'user', content: [{ type: 'image' } as never] }] })))).rejects.toThrow('unsupported')
    await expect(collect(adapter.stream(request({ model: 'other' })))).rejects.toThrow('serves only')
  })

  test('maps OpenAI usage to disjoint DSH usage', () => {
    expect(dshUsage({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 })).toEqual({ inputTokens: 5, outputTokens: 3, totalTokens: 8 })
    expect(dshUsage({ prompt_tokens: 5, completion_tokens: 3, prompt_cache_hit_tokens: 4 })).toEqual({ inputTokens: 1, cacheReadTokens: 4, outputTokens: 3 })
    expect(dshUsage({ prompt_tokens: 5 })).toBeUndefined()
  })

  test('drives one real native AgentLoop cell offline with the frozen file digest', async () => {
    const { env, ledger } = await environment()
    const digest = createHash('sha256').update(await readFile(adapterPath)).digest('hex')
    const task = developmentCorpus[0]!
    const text = JSON.stringify({ answer: task.acceptance.answer, citations: task.acceptance.citations })
    const fetch = async () => sse([
      { choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 400, completion_tokens: 40, total_tokens: 440 } }, '[DONE]',
    ])
    const config: NativeBenchmarkConfig = {
      id: 'gateway-offline', suite: 'research-v1', cases: [task.id],
      variants: [{ id: 'baseline', role: 'baseline', persona: 'Answer JSON.' }, { id: 'candidate', role: 'candidate', persona: 'Answer JSON carefully.' }],
      model: model({ adapterDigest: digest, tokenCounterDigest: digest }) as NativeBenchmarkConfig['model'],
      budget: { durationMs: 10_000, inputTokens: 40_000, outputTokens: 100, costUsdMicros: null, toolCalls: 0 }, repeats: 2, seed: 1,
    }
    const plan = nativeBenchmarkPlan(config); const cell = benchmarkSchedule(plan)[0]!
    const executor = createNativeBenchmarkExecutor(config, (selected, environment) => createNativeAdapter(selected, environment, { env, fetch }))
    const result = await executor.execute({ planId: plan.id, dataset: plan.dataset, cell, task: plan.cases[0]!, variant: plan.variants.find(item => item.id === cell.variantId)!, budget: plan.budget, signal: new AbortController().signal })
    expect(result.verdict).toBe('achieved')
    expect(result.metrics).toMatchObject({ inputTokens: 400, outputTokens: 40, costUsdMicros: null })
    expect((await readFile(ledger, 'utf8')).trim().split('\n')).toHaveLength(1)
  })
})
