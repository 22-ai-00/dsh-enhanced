import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { createNativeBenchmarkExecutor, nativeBenchmarkPlan, type NativeBenchmarkConfig } from '../../src/benchmark/native.js'
import { memoryDevelopmentCorpus, memoryDevelopmentPrompt } from '../../src/benchmark/memory-corpus.js'
import { benchmarkSchedule } from '../../src/benchmark/schema.js'
import type { BenchmarkExecutionRequest } from '../../src/benchmark/runner.js'

const config = (caseId = 'atlas-schema-select-journal'): NativeBenchmarkConfig => ({
  id: 'native-memory-development', suite: 'memory-v1', cases: [caseId],
  variants: [{ id: 'baseline', role: 'baseline', persona: 'Follow the current task.', memory: false }, { id: 'candidate', role: 'candidate', persona: 'Follow the current task.', memory: true }],
  model: { provider: 'fixture', model: 'fixture-model', temperature: 0, maxOutputTokens: 100,
    inputUsdMicrosPerMillionTokens: null, outputUsdMicrosPerMillionTokens: null,
    adapterDigest: 'a'.repeat(64), tokenCounterDigest: 'b'.repeat(64) },
  budget: { durationMs: 10_000, inputTokens: 10_000, outputTokens: 100, costUsdMicros: null, toolCalls: 0 }, repeats: 2, seed: 7,
})

function request(input: NativeBenchmarkConfig, variantId: string): BenchmarkExecutionRequest {
  const plan = nativeBenchmarkPlan(input)
  const cell = benchmarkSchedule(plan).find(item => item.variantId === variantId)!
  return { planId: plan.id, dataset: plan.dataset, cell, task: plan.cases[0]!, variant: plan.variants.find(item => item.id === variantId)!, budget: plan.budget, signal: new AbortController().signal }
}
const text = (options: GenerateOptions): string => options.messages.flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n')

describe('native Memory development comparison', () => {
  it('freezes a single retrieval difference and rejects persona or feature confounding', () => {
    const input = config(); const plan = nativeBenchmarkPlan(input)
    expect(plan.dataset).toMatchObject({ id: 'dsh-memory-grounding', split: 'development' })
    expect(plan.variants.map(variant => variant.features.memory)).toEqual([false, true])
    expect(plan.variants[0]!.versions).toEqual(plan.variants[1]!.versions)
    input.variants[1]!.persona += ' changed'
    expect(() => nativeBenchmarkPlan(input)).toThrow('identical personas')
    const wrong = config(); wrong.variants[0]!.memory = true
    expect(() => nativeBenchmarkPlan(wrong)).toThrow('only candidate retrieval')
  })

  it.each(memoryDevelopmentCorpus.flatMap(task => (['memory-v1', 'memory-v2'] as const).map(suite => [task.id, suite] as const)))('uses approved owner-scoped Memory through actual AgentLoop requests: %s (%s)', async (caseId, suite) => {
    const input = config(caseId); input.suite = suite
    const prompts = new Map<string, GenerateOptions>()
    const roots: string[] = []
    for (const variantId of ['baseline', 'candidate']) {
      let disposed = false
      class CaptureAdapter extends LlmAdapter {
        override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
          prompts.set(variantId, options)
          const output = '{"answer":"observed fixture","citations":[]}'
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: output }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: output } }
          yield { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 4, cacheWriteTokens: 2, outputTokens: 8, reasoningTokens: 3, totalTokens: 24 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
      const executor = createNativeBenchmarkExecutor(input, (_model, environment) => {
        expect(environment.ctx.sessions).toBeDefined(); expect(environment.ctx.agents).toBeDefined()
        expect(existsSync(environment.workspace)).toBe(true); roots.push(environment.workspace)
        return { adapter: new CaptureAdapter(), inputTokenUpperBound: () => 16, dispose: () => { disposed = true } }
      })
      const result = await executor.execute(request(input, variantId))
      expect(result.verdict).toBe('not-achieved')
      expect(result.metrics).toMatchObject({ inputTokens: 16, outputTokens: 8, costUsdMicros: null, toolCalls: 0 })
      expect(disposed).toBe(true); expect(existsSync(roots.at(-1)!)).toBe(false)
    }
    expect(roots[0]).not.toBe(roots[1])
    const baseline = prompts.get('baseline')!; const candidate = prompts.get('candidate')!
    for (const options of [baseline, candidate]) {
      expect(options.system).toBe(input.variants[0]!.persona)
      expect(options.tools ?? []).toEqual([])
      expect(text(options)).toContain(memoryDevelopmentPrompt(caseId, suite === 'memory-v2' ? '2' : '1'))
    }
    expect(text(baseline)).not.toContain('<memory_source>')
    const actual = text(candidate)
    expect(actual).toContain('<memory_source>')
    if (caseId === 'atlas-schema-select-journal') {
      expect(actual).toContain('journal-atlas-v2'); expect(actual).toContain('memory://atlas/journal')
      expect(actual).toContain('applicability unverified')
    } else if (caseId === 'atlas-schema-counterexample-pause') {
      expect(actual).toContain('counterexamples'); expect(actual).toContain('schema=1')
    } else if (caseId === 'claim-marker-conflict-needs-review') {
      expect(actual).toContain('claim disagreement: release.mode'); expect(actual).toContain('no value selected')
      expect(actual).not.toContain('release.mode=fast'); expect(actual).not.toContain('release.mode=safe')
    } else if (caseId === 'eu-west-visibility-boundary') {
      expect(actual).toContain('region-eu-west'); expect(actual).not.toContain('DO-NOT-LEAK')
    } else if (caseId === 'removed-mode-current-snapshot-wins') {
      expect(actual).not.toContain('memory://mode/old'); expect(actual).toContain('memory://mode/current')
    } else {
      expect(actual).toContain('42'); expect(actual).toContain('CANARY-MEMORY-ORCHID')
      expect(actual).toContain('memory://sample/k')
    }
  })

  it('allows explicitly observed token-only limits without pretending to send unsupported model parameters', async () => {
    const input = config(); input.model.temperature = null; input.model.inputLimitMode = 'estimate'; input.model.outputLimitMode = 'observed'
    class ObservedAdapter extends LlmAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        expect(options.temperature).toBeUndefined(); expect(options.maxTokens).toBeUndefined()
        const output = '{"answer":"journal-atlas-v2","citations":["current-state","memory://atlas/journal"]}'
        yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: output }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: output } }
        yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 8, reasoningTokens: 3 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const executor = createNativeBenchmarkExecutor(input, () => ({ adapter: new ObservedAdapter(), inputTokenEstimate: () => 10, dispose() {} }))
    expect((await executor.execute(request(input, 'candidate'))).verdict).toBe('achieved')
    input.budget.inputTokens = 12
    const exceeded = createNativeBenchmarkExecutor(input, () => ({ adapter: new ObservedAdapter(), inputTokenEstimate: () => 10, dispose() {} }))
    await expect(exceeded.execute(request(input, 'candidate'))).rejects.toThrow('incomplete native measurement')
    input.budget.costUsdMicros = 100
    expect(() => nativeBenchmarkPlan(input)).toThrow('priced budget requires preflight')
  })
  it('rejects an unknown cache tariff before constructing a priced adapter', () => {
    const input = config(); input.budget.costUsdMicros = 100
    input.model.inputUsdMicrosPerMillionTokens = 1; input.model.outputUsdMicrosPerMillionTokens = 1
    let loaded = false
    expect(() => createNativeBenchmarkExecutor(input, () => { loaded = true; throw new Error('not reached') })).toThrow('all input/cache/output')
    expect(loaded).toBe(false)
  })
})
