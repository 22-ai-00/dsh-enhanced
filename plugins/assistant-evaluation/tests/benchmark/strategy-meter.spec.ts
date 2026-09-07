import { afterEach, describe, expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Context as RealContext } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { installStrategyBenchmarkMeter, type StrategyBenchmarkMeter } from '../../src/benchmark/strategy-meter.js'

const meters: StrategyBenchmarkMeter[] = []
const contexts: RealContext[] = []
afterEach(async () => { meters.splice(0).forEach(meter => meter.dispose()); await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

type StreamHook = (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>
type ToolHook = (execution: { signal?: AbortSignal }, next: () => Promise<unknown>) => Promise<unknown>
function fixture(input: { calls?: number; tools?: number; cost?: number; abort?: AbortController; upper?: (options: GenerateOptions) => number | Promise<number> } = {}) {
  const hooks = new Map<string, Function>()
  const ctx = { on(name: string, listener: Function) { hooks.set(name, listener) }, effect() {}, get() { return undefined } } as unknown as Context
  const abort = input.abort ?? new AbortController()
  const meter = installStrategyBenchmarkMeter(ctx, { signal: abort.signal, modelCalls: input.calls ?? 2, maxOutputTokens: 5,
    budget: { durationMs: 20_000, inputTokens: 20, outputTokens: 10, costUsdMicros: input.cost ?? null, toolCalls: input.tools ?? 2 },
    model: { provider: 'test', model: 'strategy', temperature: null, inputLimitMode: 'upper-bound', outputLimitMode: 'provider', maxOutputTokens: 5,
      inputUsdMicrosPerMillionTokens: input.cost === undefined ? null : 1_000_000, outputUsdMicrosPerMillionTokens: input.cost === undefined ? null : 1_000_000,
      cacheReadUsdMicrosPerMillionTokens: 1_000_000, cacheWriteUsdMicrosPerMillionTokens: 1_000_000, adapterDigest: 'a'.repeat(64), tokenCounterDigest: 'b'.repeat(64) },
    binding: { inputTokenUpperBound: input.upper ?? (() => 3), dispose: () => {}, adapter: {} as never },
  })
  meters.push(meter)
  return { abort, meter, stream: hooks.get('llm/stream') as StreamHook, tool: hooks.get('tools/execute') as ToolHook }
}
const options = (): GenerateOptions => ({ provider: 'test', model: 'strategy', maxTokens: 5, messages: [] })
async function consume(stream: AsyncIterable<StreamChunk>): Promise<void> { for await (const _ of stream) {} }
async function* complete(input = 3, output = 2): AsyncIterable<StreamChunk> {
  yield { type: 'usage', usage: { inputTokens: input, outputTokens: output, totalTokens: input + output } } as StreamChunk
  yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
}

describe('strategy benchmark outer meter', () => {
  test('observes actual LlmRuntime streams and ToolRuntime dispatch in one Context', async () => {
    const ctx = new RealContext(); contexts.push(ctx); await ctx.plugin(LlmRuntime); await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false, persona: '' }); await ctx.plugin(ToolRuntime, { mode: 'native' })
    class Adapter extends LlmAdapter { override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      expect(options.signal?.aborted).toBe(false)
      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
    const meter = installStrategyBenchmarkMeter(ctx, { signal: new AbortController().signal, modelCalls: 2, maxOutputTokens: 5,
      budget: { durationMs: 20_000, inputTokens: 10, outputTokens: 10, costUsdMicros: null, toolCalls: 1 },
      model: { provider: 'test', model: 'strategy', temperature: null, inputLimitMode: 'upper-bound', outputLimitMode: 'provider', maxOutputTokens: 5, inputUsdMicrosPerMillionTokens: null, outputUsdMicrosPerMillionTokens: null, adapterDigest: 'a'.repeat(64), tokenCounterDigest: 'b'.repeat(64) },
      binding: { inputTokenUpperBound: () => 2, dispose: () => {}, adapter: {} as never },
    })
    ctx.llm.registerAdapter(['test'], new Adapter())
    await consume(ctx.llm.stream({ ...options(), signal: meter.signal, sessionId: 'foreground' as never }))
    await consume(ctx.llm.stream({ ...options(), signal: meter.signal, sessionId: 'strategy-child' as never }))
    let ran = 0
    ctx.tools.register(defineTool({ name: 'meter_tool', description: 'test meter tool', parameters: {}, output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] }, async execute() { ran++; return {} } }))
    const result = await ctx.tools.execute({ callId: ToolCallId('meter-tool'), name: 'meter_tool', arguments: {}, signal: meter.signal })
    expect(result.isError).toBe(false); expect(ran).toBe(1)
    expect(meter.snapshot()).toMatchObject({ modelCalls: 2, toolCalls: 1, heldModelCalls: 0 })
    meter.assertComplete(); meter.dispose()
  })

  test('settles sequential requests against one shared ledger', async () => {
    const { meter, stream } = fixture({ upper: () => 4 })
    await consume(stream(options(), () => complete(3, 2)))
    await consume(stream(options(), () => complete(4, 1)))
    expect(meter.snapshot()).toMatchObject({ modelCalls: 2, inputTokens: 7, outputTokens: 3, heldModelCalls: 0 })
    expect(meter.snapshot().traces.map(trace => trace.phase)).toEqual(['settled', 'settled'])
    expect(() => meter.assertComplete()).not.toThrow()
  })

  test('atomically admits only one of concurrent asynchronous preflights', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const { meter, stream } = fixture({ calls: 1, upper: async () => { await gate; return 3 } })
    const first = consume(stream(options(), () => complete()))
    const second = consume(stream(options(), () => complete()))
    release()
    await expect(first).resolves.toBeUndefined()
    await expect(second).rejects.toThrow('shared-budget')
    expect(meter.snapshot()).toMatchObject({ modelCalls: 1, heldModelCalls: 0 })
  })

  test('retains reservations for missing usage, dispatch failure, and late disposal', async () => {
    const missing = fixture()
    await expect(consume(missing.stream(options(), async function* () { yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk }))).rejects.toThrow('stream')
    expect(missing.meter.snapshot()).toMatchObject({ heldModelCalls: 1 })
    expect(() => missing.meter.assertComplete()).toThrow('incomplete')

    const dispatch = fixture()
    await expect(consume(dispatch.stream(options(), () => { throw new Error('adapter failed before iterator') }))).rejects.toThrow('adapter failed')
    expect(dispatch.meter.snapshot()).toMatchObject({ heldModelCalls: 1, traces: [{ dispatched: false, phase: 'retained' }] })

    const late = fixture()
    await expect(consume(late.stream(options(), async function* () { late.meter.dispose(); yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk }))).rejects.toThrow('cancelled')
    expect(late.meter.snapshot()).toMatchObject({ heldModelCalls: 1 })
  })

  test('counts actual tool dispatches and fences cancellation before dispatch', async () => {
    const { abort, meter, tool } = fixture({ tools: 1 })
    await expect(tool({ signal: new AbortController().signal }, async () => 'first')).resolves.toBe('first')
    await expect(tool({ signal: new AbortController().signal }, async () => 'second')).rejects.toThrow('tool-budget')
    expect(meter.snapshot().toolCalls).toBe(1)
    abort.abort()
    await expect(tool({ signal: new AbortController().signal }, async () => 'never')).rejects.toThrow('tool-budget')
  })

  test('retains a bounded cancellation observation during asynchronous preflight', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const { meter, stream } = fixture({ upper: async () => { await gate; return 3 } })
    const running = consume(stream(options(), () => complete()))
    meter.dispose(); release()
    await expect(running).rejects.toThrow('input-bound')
    expect(meter.snapshot().traces).toMatchObject([{ phase: 'rejected', reason: 'input-bound' }])
    expect(() => meter.assertComplete()).toThrow('incomplete')
  })

  test('does not accept an empty measurement as complete', () => {
    const { meter } = fixture()
    expect(() => meter.assertComplete()).toThrow('incomplete')
  })

  test('the explicit meter signal aborts a real adapter stream on disposal', async () => {
    const ctx = new RealContext(); contexts.push(ctx); await ctx.plugin(LlmRuntime)
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve }); let sawAbort = false
    class BlockingAdapter extends LlmAdapter { override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      started()
      await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => { sawAbort = true; resolve() }, { once: true }))
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'fixture' } } }
    } }
    const meter = installStrategyBenchmarkMeter(ctx, { signal: new AbortController().signal, modelCalls: 1, maxOutputTokens: 5,
      budget: { durationMs: 20_000, inputTokens: 10, outputTokens: 5, costUsdMicros: null, toolCalls: 0 },
      model: { provider: 'test', model: 'strategy', temperature: null, inputLimitMode: 'upper-bound', outputLimitMode: 'provider', maxOutputTokens: 5, inputUsdMicrosPerMillionTokens: null, outputUsdMicrosPerMillionTokens: null, adapterDigest: 'a'.repeat(64), tokenCounterDigest: 'b'.repeat(64) },
      binding: { inputTokenUpperBound: () => 2, dispose: () => {}, adapter: {} as never },
    })
    ctx.llm.registerAdapter(['test'], new BlockingAdapter())
    const running = consume(ctx.llm.stream({ ...options(), signal: meter.signal }))
    await ready; meter.dispose()
    await expect(running).rejects.toThrow()
    expect(sawAbort).toBe(true)
  })

  test('rejects non-enforcing setup modes rather than claiming an observation', () => {
    const hooks = new Map<string, Function>()
    const ctx = { on(name: string, listener: Function) { hooks.set(name, listener) }, effect() {}, get() { return undefined } } as unknown as Context
    expect(() => installStrategyBenchmarkMeter(ctx, { signal: new AbortController().signal, modelCalls: 1, maxOutputTokens: 5,
      budget: { durationMs: 1, inputTokens: 1, outputTokens: 5, costUsdMicros: null, toolCalls: 0 },
      model: { provider: 'test', model: 'strategy', temperature: null, inputLimitMode: 'estimate', outputLimitMode: 'provider', maxOutputTokens: 5, inputUsdMicrosPerMillionTokens: null, outputUsdMicrosPerMillionTokens: null, adapterDigest: 'a'.repeat(64), tokenCounterDigest: 'b'.repeat(64) },
      binding: { inputTokenUpperBound: () => 1, dispose: () => {}, adapter: {} as never },
    })).toThrow('invalid enforced observation configuration')
  })

  test('preserves unknown priced reservations and rejects the next request before dispatch', async () => {
    const { meter, stream } = fixture({ cost: 10 })
    await expect(consume(stream(options(), () => { throw new Error('PRIVATE PROVIDER DETAIL') }))).rejects.toThrow('PRIVATE PROVIDER DETAIL')
    expect(meter.snapshot()).toMatchObject({ heldModelCalls: 1, heldCostUsdMicros: 8, costUsdMicros: 0 })
    let dispatched = false
    await expect(consume(stream(options(), () => { dispatched = true; return complete() }))).rejects.toThrow('shared-budget')
    expect(dispatched).toBe(false)
    expect(JSON.stringify(meter.snapshot())).not.toContain('PRIVATE PROVIDER DETAIL')
  })

  test('refuses completion while a tool is still running and does not refund failed tools', async () => {
    const { meter, stream, tool } = fixture()
    await consume(stream(options(), () => complete()))
    let release!: () => void
    const running = tool({ signal: new AbortController().signal }, () => new Promise(resolve => { release = () => resolve('done') }))
    expect(meter.snapshot().activeToolCalls).toBe(1)
    expect(() => meter.assertComplete()).toThrow('incomplete')
    release(); await running
    await expect(tool({ signal: new AbortController().signal }, async () => { throw new Error('tool failed') })).rejects.toThrow('tool failed')
    expect(meter.snapshot()).toMatchObject({ toolCalls: 2, activeToolCalls: 0 })
    meter.assertComplete()
  })

  test('retains an early-closed stream and rejects chunks after finish', async () => {
    const early = fixture()
    const iterator = early.stream(options(), () => complete())[Symbol.asyncIterator]()
    await iterator.next(); await iterator.return?.()
    expect(early.meter.snapshot()).toMatchObject({ heldModelCalls: 1, traces: [{ phase: 'retained' }] })
    const late = fixture()
    await expect(consume(late.stream(options(), async function* () { yield* complete(); yield { type: 'text-delta', index: 0, text: 'after finish' } }))).rejects.toThrow('stream')
    expect(late.meter.snapshot().heldModelCalls).toBe(1)
  })
})
