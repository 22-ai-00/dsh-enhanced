import { describe, expect, it } from 'vitest'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { developmentCases, developmentCorpus, developmentDataset } from '../../src/benchmark/corpus.js'
import { createNativeBenchmarkExecutor, nativeBenchmarkPlan, type NativeBenchmarkConfig } from '../../src/benchmark/native.js'
import { runBenchmark, type BenchmarkExecutionRequest } from '../../src/benchmark/runner.js'
import { benchmarkSchedule } from '../../src/benchmark/schema.js'
import { BenchmarkStore } from '../../src/benchmark/store.js'
import type { BenchmarkCase, BenchmarkVariant } from '../../src/benchmark/types.js'

const digest = (value: string): string => value.repeat(64).slice(0, 64)
const config = (): NativeBenchmarkConfig => ({
  id: 'native-public-development', cases: [developmentCases()[0]!.id],
  variants: [{ id: 'baseline', role: 'baseline', persona: 'Answer JSON.' }, { id: 'candidate', role: 'candidate', persona: 'Answer JSON carefully.' }],
  model: { provider: 'fixture', model: 'fixture-model', temperature: 0, maxOutputTokens: 20, inputUsdMicrosPerMillionTokens: 1, outputUsdMicrosPerMillionTokens: 1, cacheReadUsdMicrosPerMillionTokens: 1, cacheWriteUsdMicrosPerMillionTokens: 1, adapterDigest: digest('a'), tokenCounterDigest: digest('b') },
  budget: { durationMs: 1_000, inputTokens: 100, outputTokens: 20, costUsdMicros: 100, toolCalls: 0 }, repeats: 2, seed: 7,
})

describe('native AgentLoop benchmark plan', () => {
  it('binds public development cases, exact persona, and feature-off variants', () => {
    const input = config(); const plan = nativeBenchmarkPlan(input)
    expect(plan.dataset).toEqual(developmentDataset)
    expect(plan.cases).toEqual(developmentCases().filter(item => item.id === input.cases[0]))
    expect(plan.variants.map(item => item.features)).toEqual([{ memory: false, planning: false, review: false, growth: false }, { memory: false, planning: false, review: false, growth: false }])
    expect(plan.variants[0]!.versions.prompt).not.toBe(plan.variants[1]!.versions.prompt)
    expect(() => (plan.cases as BenchmarkCase[]).pop()).toThrow()
    expect(() => (plan.variants as BenchmarkVariant[]).splice(0, 1)).toThrow()
  })

  it.each([
    (value: NativeBenchmarkConfig) => { value.cases = ['unknown'] },
    (value: NativeBenchmarkConfig) => { value.model.maxOutputTokens = value.budget.outputTokens + 1 },
    (value: NativeBenchmarkConfig) => { value.model.temperature = 3 },
    (value: NativeBenchmarkConfig) => { value.variants[1]!.role = 'baseline' },
  ])('rejects unsupported bounded input before the adapter factory runs', async mutate => {
    const input = config(); mutate(input); let called = false
    expect(() => createNativeBenchmarkExecutor(input, async () => { called = true; throw new Error('should not run') })).toThrow()
    expect(called).toBe(false)
  })

  it('uses strict plain input and accepts a slash-containing route', () => {
    const slash = config(); slash.model.model = 'opensource/deepseek_v4_flash_0731'
    expect(nativeBenchmarkPlan(slash).variants[0]!.versions.model).toMatch(/^[a-f0-9]{64}$/u)
    expect(() => nativeBenchmarkPlan({ ...config(), extra: true } as NativeBenchmarkConfig)).toThrow('unexpected benchmark fields')
    const getter = config(); Object.defineProperty(getter, 'id', { enumerable: true, get: () => 'native-public-development' })
    expect(() => nativeBenchmarkPlan(getter)).toThrow('plain enumerable')
  })

  it('rejects a drifted execution request before it reaches the adapter factory', async () => {
    const input = config(); const plan = nativeBenchmarkPlan(input); let called = false
    const executor = createNativeBenchmarkExecutor(input, async () => { called = true; throw new Error('should not run') })
    const request: BenchmarkExecutionRequest = { planId: 'drifted', dataset: plan.dataset, cell: { id: 'cell', caseId: plan.cases[0]!.id, variantId: plan.variants[0]!.id, repeat: 0, seed: 1 }, task: plan.cases[0]!, variant: plan.variants[0]!, budget: plan.budget, signal: new AbortController().signal }
    await expect(executor.execute(request)).rejects.toThrow('native benchmark request drift')
    expect(called).toBe(false)
  })

  it('drives a real fresh AgentLoop and records the independently judged response', async () => {
    const input = config(); const plan = nativeBenchmarkPlan(input); const calls: GenerateOptions[] = []; let disposed = false
    class DeterministicAdapter extends LlmAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        calls.push(options)
        const task = developmentCorpus.find(item => item.id === input.cases[0])!
        const text = JSON.stringify({ answer: task.acceptance.answer, citations: task.acceptance.citations })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 5 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const executor = createNativeBenchmarkExecutor(input, async () => ({ adapter: new DeterministicAdapter(), inputTokenUpperBound: () => 4, dispose: () => { disposed = true } }))
    const cell = benchmarkSchedule(plan)[0]!
    const request: BenchmarkExecutionRequest = { planId: plan.id, dataset: plan.dataset, cell, task: plan.cases[0]!, variant: plan.variants.find(item => item.id === cell.variantId)!, budget: plan.budget, signal: new AbortController().signal }
    const result = await executor.execute(request)
    expect(result.verdict).toBe('achieved'); expect(result.quiescent).toBe(true); expect(disposed).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ provider: input.model.provider, model: input.model.model, temperature: input.model.temperature, maxTokens: input.model.maxOutputTokens, system: input.variants.find(item => item.id === cell.variantId)!.persona })
    expect(calls[0]!.tools ?? []).toEqual([])
    expect(calls[0]!.messages.at(-1)?.content).toContainEqual(expect.objectContaining({ type: 'text', text: expect.stringContaining('原始用户任务') }))

    const tokenOnly = config()
    tokenOnly.model.inputUsdMicrosPerMillionTokens = null; tokenOnly.model.outputUsdMicrosPerMillionTokens = null; tokenOnly.budget.costUsdMicros = null
    const tokenPlan = nativeBenchmarkPlan(tokenOnly); const tokenCell = benchmarkSchedule(tokenPlan)[0]!
    const tokenExecutor = createNativeBenchmarkExecutor(tokenOnly, async () => ({ adapter: new DeterministicAdapter(), inputTokenUpperBound: () => 4, dispose() {} }))
    const tokenResult = await tokenExecutor.execute({ planId: tokenPlan.id, dataset: tokenPlan.dataset, cell: tokenCell, task: tokenPlan.cases[0]!, variant: tokenPlan.variants.find(item => item.id === tokenCell.variantId)!, budget: tokenPlan.budget, signal: new AbortController().signal })
    expect(tokenResult.verdict).toBe('achieved'); expect(tokenResult.metrics.costUsdMicros).toBeNull()
  })

  it('runs paired cells through the durable runner', async () => {
    const input = config(); const plan = nativeBenchmarkPlan(input); const task = developmentCorpus[0]!
    class PairedAdapter extends LlmAdapter { override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const text = JSON.stringify({ answer: options.system === input.variants[1]!.persona ? task.acceptance.answer : 'wrong', citations: task.acceptance.citations })
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text }; yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 5 } }; yield { type: 'finish', reason: { kind: 'stop' } }
    } }
    const store = new BenchmarkStore(':memory:')
    try {
      const results = await runBenchmark(store, plan, createNativeBenchmarkExecutor(input, async () => ({ adapter: new PairedAdapter(), inputTokenUpperBound: () => 4, dispose() {} })))
      expect(results).toHaveLength(4)
      expect(results.filter(item => item.cell.variantId === 'baseline').every(item => item.verdict === 'not-achieved')).toBe(true)
      expect(results.filter(item => item.cell.variantId === 'candidate').every(item => item.verdict === 'achieved')).toBe(true)
    } finally { store.close() }
  })

  it('rejects missing usage and a correct-looking non-completed turn', async () => {
    const input = config(); const plan = nativeBenchmarkPlan(input); const cell = benchmarkSchedule(plan)[0]!; const task = developmentCorpus[0]!
    const request = (): BenchmarkExecutionRequest => ({ planId: plan.id, dataset: plan.dataset, cell, task: plan.cases[0]!, variant: plan.variants.find(item => item.id === cell.variantId)!, budget: plan.budget, signal: new AbortController().signal })
    class TerminalAdapter extends LlmAdapter {
      constructor(private readonly withUsage: boolean, private readonly finish: 'stop' | 'max-tokens') { super() }
      override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        const text = JSON.stringify({ answer: task.acceptance.answer, citations: task.acceptance.citations })
        yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text }; yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        if (this.withUsage) yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 5 } }
        yield { type: 'finish', reason: this.finish === 'stop' ? { kind: 'stop' } : { kind: 'max-tokens' } }
      }
    }
    await expect(createNativeBenchmarkExecutor(input, async () => ({ adapter: new TerminalAdapter(false, 'stop'), inputTokenUpperBound: () => 4, dispose() {} })).execute(request())).rejects.toThrow('incomplete native measurement')
    await expect(createNativeBenchmarkExecutor(input, async () => ({ adapter: new TerminalAdapter(true, 'max-tokens'), inputTokenUpperBound: () => 4, dispose() {} })).execute(request())).rejects.toThrow('incomplete native measurement')
    class BadTotalAdapter extends TerminalAdapter { override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> { for await (const chunk of super.stream(options)) yield chunk.type === 'usage' ? { ...chunk, usage: { ...chunk.usage, totalTokens: 1_000_000 } } : chunk } }
    await expect(createNativeBenchmarkExecutor(input, async () => ({ adapter: new BadTotalAdapter(true, 'stop'), inputTokenUpperBound: () => 4, dispose() {} })).execute(request())).rejects.toThrow('incomplete native measurement')
  })

  it('cancels a hanging provider and runner records timeout before a hung disposer settles', async () => {
    const input = config(); input.budget.durationMs = 20; const plan = nativeBenchmarkPlan(input); let providerSawAbort = false; let releaseDispose!: () => void
    const disposeGate = new Promise<void>(resolve => { releaseDispose = resolve })
    class HangingAdapter extends LlmAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => { providerSawAbort = true; resolve() }, { once: true }))
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } }
      }
    }
    const store = new BenchmarkStore(':memory:')
    try {
      const running = runBenchmark(store, plan, createNativeBenchmarkExecutor(input, async () => ({ adapter: new HangingAdapter(), inputTokenUpperBound: () => 4, dispose: () => disposeGate })))
      const results = await running
      expect(results).toHaveLength(1); expect(results[0]!.reason).toBe('timeout'); expect(providerSawAbort).toBe(true)
      const frozen = store.results(plan.id); releaseDispose(); await Promise.resolve(); await Promise.resolve()
      expect(store.results(plan.id)).toEqual(frozen)
    } finally { releaseDispose?.(); store.close() }
  })

  it('rejects a completed observation when binding cleanup fails', async () => {
    const input = config(); const plan = nativeBenchmarkPlan(input); const cell = benchmarkSchedule(plan)[0]!; const task = developmentCorpus[0]!
    class GoodAdapter extends LlmAdapter { override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
      const text = JSON.stringify({ answer: task.acceptance.answer, citations: task.acceptance.citations }); yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text }; yield { type: 'block-end', index: 0, block: { type: 'text', text } }; yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 } }; yield { type: 'finish', reason: { kind: 'stop' } }
    } }
    let disposed = false
    const executor = createNativeBenchmarkExecutor(input, async () => ({ adapter: new GoodAdapter(), inputTokenUpperBound: () => 4, dispose: () => { disposed = true; throw new Error('dispose failed') } }))
    await expect(executor.execute({ planId: plan.id, dataset: plan.dataset, cell, task: plan.cases[0]!, variant: plan.variants.find(item => item.id === cell.variantId)!, budget: plan.budget, signal: new AbortController().signal })).rejects.toThrow('cleanup failed')
    expect(disposed).toBe(true)
  })
})
