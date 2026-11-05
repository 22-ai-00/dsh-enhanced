import { describe, expect, it } from 'vitest'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { familiesDevelopmentCases, familiesDevelopmentCorpus, familiesDevelopmentDataset } from '../../src/benchmark/families-corpus.js'
import { createNativeBenchmarkExecutor, nativeBenchmarkPlan, nativeReviewGuidance, nativeSystemText, type NativeBenchmarkConfig } from '../../src/benchmark/native.js'
import { benchmarkReport } from '../../src/benchmark/report.js'
import { runBenchmark } from '../../src/benchmark/runner.js'
import { BenchmarkStore } from '../../src/benchmark/store.js'

const caseIds = ['code-page-count-off-by-one', 'revocation-withdrawn-deploy-approval']
const config = (): NativeBenchmarkConfig => ({
  id: 'native-families-ablation', suite: 'families-v1', cases: caseIds,
  variants: [
    { id: 'baseline', role: 'baseline', persona: 'Answer JSON.' },
    { id: 'candidate', role: 'candidate', persona: 'Answer JSON carefully.', review: true },
    { id: 'no-review', role: 'ablation', persona: 'Answer JSON carefully.', review: false },
  ],
  model: { provider: 'fixture', model: 'fixture-model', temperature: 0, maxOutputTokens: 40, inputUsdMicrosPerMillionTokens: null, outputUsdMicrosPerMillionTokens: null, adapterDigest: 'a'.repeat(64), tokenCounterDigest: 'b'.repeat(64) },
  budget: { durationMs: 10_000, inputTokens: 100_000, outputTokens: 40, costUsdMicros: null, toolCalls: 0 }, repeats: 2, seed: 11,
})
const systemText = (options: GenerateOptions): string => options.messages.find(message => message.role === 'system')?.content.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
const userText = (options: GenerateOptions): string => options.messages.at(-1)!.content.filter(block => block.type === 'text').map(block => block.text).join('')

describe('native families-v1 suite with a review ablation', () => {
  it('binds the families dataset, review features and candidate-equal ablation versions', () => {
    const plan = nativeBenchmarkPlan(config())
    expect(plan.dataset).toEqual(familiesDevelopmentDataset)
    expect(plan.cases).toEqual(familiesDevelopmentCases().filter(item => caseIds.includes(item.id)))
    expect(plan.variants.map(item => [item.role, item.features.review])).toEqual([['baseline', false], ['candidate', true], ['ablation', false]])
    expect(plan.variants[2]!.versions).toEqual(plan.variants[1]!.versions)
    expect(plan.variants[1]!.versions.prompt).toBe(acceptanceDigest({ persona: 'Answer JSON carefully.', complete: true, review: acceptanceDigest({ section: 'native-benchmark-review-v1', text: nativeReviewGuidance }) }))
  })

  it('keeps historical prompt digests when no variant enables review', () => {
    const input = config(); input.variants = input.variants.slice(0, 2).map(({ review: _review, ...variant }) => variant)
    const plan = nativeBenchmarkPlan(input)
    expect(plan.variants.map(item => item.versions.prompt)).toEqual([acceptanceDigest({ persona: 'Answer JSON.', complete: true }), acceptanceDigest({ persona: 'Answer JSON carefully.', complete: true })])
    expect(nativeSystemText('p', false)).toBe('p')
    // A review-enabled sibling never changes the baseline's (or another review-free variant's) prompt digest.
    const reviewPlan = nativeBenchmarkPlan(config())
    expect(reviewPlan.variants[0]!.versions.prompt).toBe(acceptanceDigest({ persona: 'Answer JSON.', complete: true }))
    const mixed = config(); mixed.variants = [mixed.variants[0]!, { id: 'plain', role: 'candidate', persona: 'Answer JSON carefully.' }, { id: 'reviewed', role: 'candidate', persona: 'Answer JSON carefully.', review: true }]
    const mixedPlan = nativeBenchmarkPlan(mixed)
    expect(mixedPlan.variants[1]!.versions.prompt).toBe(plan.variants[1]!.versions.prompt)
    expect(mixedPlan.variants[2]!.versions.prompt).toBe(reviewPlan.variants[1]!.versions.prompt)
    expect(nativeSystemText('', true)).toBe(nativeReviewGuidance)
  })

  it.each([
    (value: NativeBenchmarkConfig) => { (value.variants[2] as { persona: string }).persona = 'different' },
    (value: NativeBenchmarkConfig) => { (value.variants[2] as { review?: boolean }).review = true },
    (value: NativeBenchmarkConfig) => { (value.variants[0] as { role: string }).role = 'candidate'; (value.variants as unknown[]).push({ id: 'base2', role: 'baseline', persona: 'x' }) },
    (value: NativeBenchmarkConfig) => { (value.variants[1] as { memory?: boolean }).memory = true },
    (value: NativeBenchmarkConfig) => { (value.variants[1] as { review?: unknown }).review = 'yes' },
  ])('rejects confounded or invalid ablations before any adapter runs', mutate => {
    const input = config(); mutate(input); let called = false
    expect(() => createNativeBenchmarkExecutor(input, async () => { called = true; throw new Error('should not run') })).toThrow()
    expect(called).toBe(false)
  })

  it('drives every arm through AgentLoop and reports candidate gain and ablation loss', async () => {
    const input = config(); const plan = nativeBenchmarkPlan(input); const seen: string[] = []
    class ReviewSensitiveAdapter extends LlmAdapter { override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const system = systemText(options); seen.push(system)
      const task = familiesDevelopmentCorpus.find(item => userText(options).includes(item.objective))!
      const text = JSON.stringify(system.includes(nativeReviewGuidance)
        ? { answer: task.acceptance.answer, citations: task.acceptance.citations } : { answer: 'wrong', citations: task.acceptance.citations })
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text }; yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: system.includes(nativeReviewGuidance) ? 9 : 4, outputTokens: 5 } }; yield { type: 'finish', reason: { kind: 'stop' } }
    } }
    const store = new BenchmarkStore(':memory:')
    try {
      const results = await runBenchmark(store, plan, createNativeBenchmarkExecutor(input, async () => ({ adapter: new ReviewSensitiveAdapter(), inputTokenUpperBound: () => 50, dispose() {} })))
      expect(results).toHaveLength(12)
      expect(seen).toContain(nativeSystemText('Answer JSON carefully.', true))
      expect(seen).toContain('Answer JSON carefully.')
      const report = benchmarkReport(plan, results)
      expect(report.complete).toBe(true)
      const [gain, ablation] = report.comparisons
      expect(gain).toMatchObject({ baselineId: 'baseline', variantId: 'candidate', wins: 4, losses: 0, successRateDelta: 1 })
      expect(ablation).toMatchObject({ baselineId: 'candidate', variantId: 'no-review', wins: 0, losses: 4, successRateDelta: -1 })
      expect(ablation!.byDomain.map(item => [item.domain, item.losses])).toEqual([['code', 2], ['revocation', 2]])
      expect(ablation!.metricDeltas.inputTokens).toMatchObject({ pairs: 4, missing: 0, median: -5, p10: -5, p90: -5 })
      expect(report.variants.find(item => item.id === 'candidate')!.taskSuccess).toMatchObject({ summarized: 2, allAchieved: 2, mixed: 0 })
    } finally { store.close() }
  })
})
