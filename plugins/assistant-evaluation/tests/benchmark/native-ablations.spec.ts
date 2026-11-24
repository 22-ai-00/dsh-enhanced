import { describe, expect, it } from 'vitest'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { developmentCorpus } from '../../src/benchmark/corpus.js'
import { familiesDevelopmentCorpus } from '../../src/benchmark/families-corpus.js'
import { memoryDevelopmentCorpus } from '../../src/benchmark/memory-corpus.js'
import {
  createNativeBenchmarkExecutor,
  nativeBenchmarkPlan,
  nativeGrowthGuidance,
  nativePlanningGuidance,
  nativeReviewGuidance,
  nativeSystemText,
  type NativeBenchmarkConfig,
} from '../../src/benchmark/native.js'
import { validatePlanSteps } from '../../src/benchmark/planning-runtime.js'
import { benchmarkReport } from '../../src/benchmark/report.js'
import { runBenchmark } from '../../src/benchmark/runner.js'
import { benchmarkSchedule } from '../../src/benchmark/schema.js'
import { BenchmarkStore } from '../../src/benchmark/store.js'

const modelConfig = () => ({
  provider: 'fixture',
  model: 'fixture-model',
  temperature: 0,
  maxOutputTokens: 200,
  inputUsdMicrosPerMillionTokens: null,
  outputUsdMicrosPerMillionTokens: null,
  adapterDigest: 'a'.repeat(64),
  tokenCounterDigest: 'b'.repeat(64),
})

const systemText = (options: GenerateOptions): string =>
  options.messages.find(m => m.role === 'system')?.content.filter(b => b.type === 'text').map(b => b.text).join('') ?? ''
const allMessageText = (options: GenerateOptions): string =>
  options.messages.flatMap(m => m.content.filter(b => b.type === 'text').map(b => b.text)).join('\n')

function* textChunks(text: string, inputTokens = 10, outputTokens = 8): Iterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens, outputTokens } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function* toolCallChunks(callId: string, name: string, args: unknown, inputTokens = 8, outputTokens = 6): Iterable<StreamChunk> {
  const rawArgs = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: callId as never, name, argumentsDelta: rawArgs }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId as never, name, arguments: rawArgs } }
  yield { type: 'usage', usage: { inputTokens, outputTokens } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

describe('native planning and growth ablations', () => {
  it('enforces multi-ablation version symmetry across all 6 keys and isolates baseline digests', () => {
    const config: NativeBenchmarkConfig = {
      id: 'multi-ablation-plan',
      suite: 'families-v1',
      cases: ['revocation-withdrawn-deploy-approval'],
      variants: [
        { id: 'baseline', role: 'baseline', persona: 'Base persona.' },
        { id: 'candidate', role: 'candidate', persona: 'Candidate persona.', planning: true, review: true, growth: true },
        { id: 'no-planning', role: 'ablation', persona: 'Candidate persona.', planning: false, review: true, growth: true },
        { id: 'no-growth', role: 'ablation', persona: 'Candidate persona.', planning: true, review: true, growth: false },
        { id: 'no-review', role: 'ablation', persona: 'Candidate persona.', planning: true, review: false, growth: true },
      ],
      model: modelConfig(),
      budget: { durationMs: 10_000, inputTokens: 100_000, outputTokens: 1_000, costUsdMicros: null, toolCalls: 8 },
      repeats: 2,
      seed: 13,
    }
    const plan = nativeBenchmarkPlan(config)
    const candidate = plan.variants.find(v => v.id === 'candidate')!
    const baseline = plan.variants.find(v => v.id === 'baseline')!
    expect(candidate.features).toEqual({ memory: false, planning: true, review: true, growth: true })
    for (const ablationId of ['no-planning', 'no-growth', 'no-review']) {
      const ablation = plan.variants.find(v => v.id === ablationId)!
      expect(ablation.versions).toEqual(candidate.versions)
    }
    expect(baseline.versions.prompt).not.toBe(candidate.versions.prompt)
    expect(baseline.versions.skills).not.toBe(candidate.versions.skills)
    expect(baseline.versions.policy).not.toBe(candidate.versions.policy)

    expect(nativeSystemText('P', { planning: true, review: true, growth: true })).toBe(
      `P\n\n${nativePlanningGuidance}\n\n${nativeReviewGuidance}\n\n${nativeGrowthGuidance}`,
    )

    // Invalid ablation: disabling 2 features at once fails
    const badTwo = structuredClone(config)
    badTwo.variants = [config.variants[0]!, config.variants[1]!, { id: 'no-two', role: 'ablation', persona: 'Candidate persona.', planning: false, review: false, growth: true }]
    expect(() => nativeBenchmarkPlan(badTwo)).toThrow('exactly one')

    // Invalid ablation: disabling feature candidate did not enable
    const badUnenabled = structuredClone(config)
    badUnenabled.variants = [
      config.variants[0]!,
      { id: 'candidate', role: 'candidate', persona: 'Candidate persona.', planning: true },
      { id: 'no-growth', role: 'ablation', persona: 'Candidate persona.', planning: true, growth: false },
    ]
    expect(() => nativeBenchmarkPlan(badUnenabled)).toThrow('disable exactly one')

    // Invalid ablation: persona drift
    const badPersona = structuredClone(config)
    badPersona.variants = [config.variants[0]!, config.variants[1]!, { id: 'no-p', role: 'ablation', persona: 'Changed!', planning: false, review: true, growth: true }]
    expect(() => nativeBenchmarkPlan(badPersona)).toThrow('preserve candidate persona')
  })

  it('executes genuine 2-turn Plan->Execute when budget.toolCalls === 0 and reports planning ablation delta', async () => {
    const task = developmentCorpus[0]!
    const config: NativeBenchmarkConfig = {
      id: 'zero-tool-planning-ablation',
      suite: 'research-v1',
      cases: [task.id],
      variants: [
        { id: 'baseline', role: 'baseline', persona: 'Answer JSON.' },
        { id: 'candidate', role: 'candidate', persona: 'Answer JSON carefully.', planning: true },
        { id: 'no-planning', role: 'ablation', persona: 'Answer JSON carefully.', planning: false },
      ],
      model: modelConfig(),
      budget: { durationMs: 10_000, inputTokens: 100_000, outputTokens: 1_000, costUsdMicros: null, toolCalls: 0 },
      repeats: 2,
      seed: 17,
    }
    const plan = nativeBenchmarkPlan(config)

    class ZeroToolPlanningAdapter extends LlmAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        expect(options.tools ?? []).toEqual([])
        const text = allMessageText(options)
        if (text.includes('【执行阶段')) {
          expect(text).toContain('<plan_state revision="1"')
          expect(text).toContain('<draft_plan>')
          yield* textChunks(JSON.stringify(task.acceptance), 25, 10)
          return
        }
        if (text.includes('【规划阶段')) {
          expect(text).toContain('<plan_state revision="0" status="empty"')
          yield* textChunks('Step 1: check qa-summary; Step 2: check qa-correction; Step 3: apply release-rule.', 15, 12)
          return
        }
        // Baseline and no-planning run 1 turn without <plan_state> and fail multi-constraint check
        expect(text).not.toContain('<plan_state')
        yield* textChunks(JSON.stringify({ answer: '可以开始', citations: task.acceptance.citations }), 12, 8)
      }
    }

    const store = new BenchmarkStore(':memory:')
    try {
      const results = await runBenchmark(
        store,
        plan,
        createNativeBenchmarkExecutor(config, async () => ({
          adapter: new ZeroToolPlanningAdapter(),
          inputTokenUpperBound: () => 500,
          dispose() {},
        })),
      )
      expect(results).toHaveLength(6)
      const report = benchmarkReport(plan, results)
      expect(report.complete).toBe(true)
      const [gain, noPlan] = report.comparisons
      expect(gain).toMatchObject({ baselineId: 'baseline', variantId: 'candidate', wins: 2, losses: 0, successRateDelta: 1 })
      expect(noPlan).toMatchObject({ baselineId: 'candidate', variantId: 'no-planning', wins: 0, losses: 2, successRateDelta: -1 })
      // Real planning token overhead: no-planning uses 12 input vs candidate 15+25=40 -> delta -28
      expect(noPlan!.metricDeltas.inputTokens.median).toBe(-28)
    } finally {
      store.close()
    }

    // Turn 1 hitting max-tokens rejects cleanly without running Turn 2
    let turn2Called = false
    class FailingTurn1Adapter extends LlmAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        if (allMessageText(options).includes('【执行阶段')) turn2Called = true
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'partial' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
      }
    }
    const candidateCell = benchmarkSchedule(plan).find(c => c.variantId === 'candidate')!
    const exec = createNativeBenchmarkExecutor(config, async () => ({
      adapter: new FailingTurn1Adapter(),
      inputTokenUpperBound: () => 500,
      dispose() {},
    }))
    await expect(exec.execute({
      planId: plan.id,
      dataset: plan.dataset,
      cell: candidateCell,
      task: plan.cases[0]!,
      variant: plan.variants.find(v => v.id === 'candidate')!,
      budget: plan.budget,
      signal: new AbortController().signal,
    })).rejects.toThrow('incomplete native measurement')
    expect(turn2Called).toBe(false)
  }, 20_000)

  it('validates plan DAG invariants and isolates planning/growth tools and dynamic contexts across ablations', async () => {
    expect(() => validatePlanSteps([
      { id: 'a', title: 'A', status: 'pending', dependsOn: ['b'] },
      { id: 'b', title: 'B', status: 'pending', dependsOn: ['a'] },
    ])).toThrow('cyclic')
    expect(() => validatePlanSteps([
      { id: 'a', title: 'A', status: 'pending', dependsOn: ['missing'] },
    ])).toThrow('missing')
    expect(() => validatePlanSteps([
      { id: 'a', title: 'A', status: 'pending', dependsOn: ['a'] },
    ])).toThrow('itself')

    const task = familiesDevelopmentCorpus.find(t => t.id === 'revocation-withdrawn-deploy-approval')!
    const config: NativeBenchmarkConfig = {
      id: 'tool-enabled-ablations',
      suite: 'families-v1',
      cases: [task.id],
      variants: [
        { id: 'baseline', role: 'baseline', persona: 'Use tools.' },
        { id: 'candidate', role: 'candidate', persona: 'Use tools carefully.', planning: true, growth: true },
        { id: 'no-planning', role: 'ablation', persona: 'Use tools carefully.', planning: false, growth: true },
        { id: 'no-growth', role: 'ablation', persona: 'Use tools carefully.', planning: true, growth: false },
      ],
      model: modelConfig(),
      budget: { durationMs: 15_000, inputTokens: 100_000, outputTokens: 2_000, costUsdMicros: null, toolCalls: 16 },
      repeats: 2,
      seed: 19,
    }
    const plan = nativeBenchmarkPlan(config)

    class AblationToolAdapter extends LlmAdapter {
      private seq = 0
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const sys = systemText(options)
        const msgText = allMessageText(options)
        const toolNames = (options.tools ?? []).map(t => t.name)
        const hasPlanning = sys.includes(nativePlanningGuidance)
        const hasGrowth = sys.includes(nativeGrowthGuidance)

        if (hasPlanning) {
          expect(toolNames).toContain('plan_write')
          expect(toolNames).toContain('plan_read')
          expect(msgText).toContain('<plan_state')
        } else {
          expect(toolNames).not.toContain('plan_write')
          expect(toolNames).not.toContain('plan_read')
          expect(msgText).not.toContain('<plan_state')
        }

        if (hasGrowth) {
          expect(toolNames).toContain('growth_lookup')
          expect(toolNames).toContain('growth_record')
          expect(msgText).toContain('<growth_context domain="revocation">')
          // Retired records must never be surfaced
          expect(msgText).not.toContain('lesson-revocation-retired-trust-stage1')
        } else {
          expect(toolNames).not.toContain('growth_lookup')
          expect(toolNames).not.toContain('growth_record')
          expect(msgText).not.toContain('<growth_context')
        }

        const stage2Idx = options.messages.findIndex(m => m.role === 'user' && m.content.some(b => b.type === 'text' && b.text.includes('部署执行窗口现已开启')))
        if (stage2Idx === -1) {
          const t1 = options.messages.filter(m => m.role === 'tool').length
          if (hasPlanning && t1 === 0) {
            yield* toolCallChunks(`a-${++this.seq}`, 'plan_write', {
              goal: 'Check approval before deploying r42',
              steps: [
                { id: 's1', title: 'Check stage 1 approval', status: 'in_progress', dependsOn: [] },
                { id: 's2', title: 'Re-check approval at deploy window', status: 'pending', dependsOn: ['s1'] },
              ],
            })
            return
          }
          const offset = hasPlanning ? 1 : 0
          if (t1 === offset) {
            if (hasPlanning) expect(msgText).toContain('Check stage 1 approval')
            yield* toolCallChunks(`a-${++this.seq}`, 'approval_check', { approvalId: 'A-7' })
          } else {
            yield* textChunks('{"status":"stage1-ok"}')
          }
          return
        }

        const t2 = options.messages.slice(stage2Idx).filter(m => m.role === 'tool').length
        if (hasPlanning && hasGrowth) {
          // Candidate uses growth_lookup, re-checks approval, records candidate lesson, updates plan, answers right
          if (t2 === 0) yield* toolCallChunks(`a-${++this.seq}`, 'growth_lookup', { domain: 'revocation' })
          else if (t2 === 1) yield* toolCallChunks(`a-${++this.seq}`, 'approval_check', { approvalId: 'A-7' })
          else if (t2 === 2) yield* toolCallChunks(`a-${++this.seq}`, 'growth_record', { domain: 'revocation', rule: 'CANDIDATE_ONLY_NEVER_AUTO_ACTIVE' })
          else if (t2 === 3) {
            // Confirm growth_record returns status: 'candidate' and growth_lookup never surfaces candidate records as active
            const lastToolText = options.messages.at(-1)!.content.filter(b => b.type === 'text').map(b => b.text).join('')
            expect(lastToolText).toContain('"status":"candidate"')
            yield* toolCallChunks(`a-${++this.seq}`, 'growth_lookup', { domain: 'revocation', query: 'CANDIDATE_ONLY_NEVER_AUTO_ACTIVE' })
          }
          else if (t2 === 4) {
            const lookupText = options.messages.at(-1)!.content.filter(b => b.type === 'text').map(b => b.text).join('')
            expect(lookupText).not.toContain('CANDIDATE_ONLY_NEVER_AUTO_ACTIVE')
            yield* toolCallChunks(`a-${++this.seq}`, 'plan_write', {
              goal: 'Check approval before deploying r42',
              steps: [
                { id: 's1', title: 'Check stage 1 approval', status: 'completed', dependsOn: [] },
                { id: 's2', title: 'Re-check approval at deploy window', status: 'completed', dependsOn: ['s1'] },
              ],
            })
          }
          else yield* textChunks(JSON.stringify(task.acceptance))
        } else {
          // Ablations & baseline make the error that planning/growth prevents (deploy without re-check)
          if (t2 === 0) yield* toolCallChunks(`a-${++this.seq}`, 'deploy_release', { releaseId: 'r42', approvalId: 'A-7' })
          else yield* textChunks(JSON.stringify({ answer: '可部署', citations: task.acceptance.citations }))
        }
      }
    }

    const store = new BenchmarkStore(':memory:')
    try {
      const results = await runBenchmark(
        store,
        plan,
        createNativeBenchmarkExecutor(config, async () => ({
          adapter: new AblationToolAdapter(),
          inputTokenUpperBound: () => 500,
          dispose() {},
        })),
      )
      expect(results).toHaveLength(8)
      const report = benchmarkReport(plan, results)
      expect(report.complete).toBe(true)
      const noPlan = report.comparisons.find(c => c.variantId === 'no-planning')!
      const noGrowth = report.comparisons.find(c => c.variantId === 'no-growth')!
      expect(noPlan).toMatchObject({ baselineId: 'candidate', wins: 0, losses: 2, successRateDelta: -1 })
      expect(noGrowth).toMatchObject({ baselineId: 'candidate', wins: 0, losses: 2, successRateDelta: -1 })
    } finally {
      store.close()
    }
  }, 20_000)

  it('rejects forced calls to ablated-away tools (plan_write / growth_lookup)', async () => {
    const task = familiesDevelopmentCorpus.find(t => t.id === 'code-config-flag-precedence')!
    const config: NativeBenchmarkConfig = {
      id: 'forced-tool-rejection',
      suite: 'families-v1',
      cases: [task.id],
      variants: [
        { id: 'baseline', role: 'baseline', persona: 'Use tools.' },
        { id: 'candidate', role: 'candidate', persona: 'Use tools.', planning: true, growth: true },
        { id: 'no-planning', role: 'ablation', persona: 'Use tools.', planning: false, growth: true },
      ],
      model: modelConfig(),
      budget: { durationMs: 10_000, inputTokens: 100_000, outputTokens: 500, costUsdMicros: null, toolCalls: 4 },
      repeats: 2,
      seed: 23,
    }
    const plan = nativeBenchmarkPlan(config)
    const noPlanCell = benchmarkSchedule(plan).find(c => c.variantId === 'no-planning')!

    class ForcedPlanWriteAdapter extends LlmAdapter {
      override async *stream(): AsyncIterable<StreamChunk> {
        yield* toolCallChunks('bad-1', 'plan_write', { goal: 'illegal', steps: [{ id: 's1', title: 'x', status: 'pending', dependsOn: [] }] })
      }
    }
    const exec = createNativeBenchmarkExecutor(config, async () => ({
      adapter: new ForcedPlanWriteAdapter(),
      inputTokenUpperBound: () => 100,
      dispose() {},
    }))
    await expect(exec.execute({
      planId: plan.id,
      dataset: plan.dataset,
      cell: noPlanCell,
      task: plan.cases[0]!,
      variant: plan.variants.find(v => v.id === 'no-planning')!,
      budget: plan.budget,
      signal: new AbortController().signal,
    })).rejects.toThrow()
  })

  it('composes memory + planning + growth cleanly on memory-v2 without Cordis collisions', async () => {
    const task = memoryDevelopmentCorpus[0]!
    const config: NativeBenchmarkConfig = {
      id: 'combined-memory-planning-growth',
      suite: 'memory-v2',
      cases: [task.id],
      variants: [
        { id: 'baseline', role: 'baseline', persona: 'Follow the task.', memory: false },
        { id: 'candidate', role: 'candidate', persona: 'Follow the task.', memory: true, planning: true, growth: true },
      ],
      model: modelConfig(),
      budget: { durationMs: 15_000, inputTokens: 100_000, outputTokens: 1_000, costUsdMicros: null, toolCalls: 0 },
      repeats: 2,
      seed: 29,
    }
    const plan = nativeBenchmarkPlan(config)
    const candidateCell = benchmarkSchedule(plan).find(c => c.variantId === 'candidate')!
    let sawAllContexts = false

    class CombinedAdapter extends LlmAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const full = allMessageText(options)
        if (full.includes('<memory_source>') && full.includes('<plan_state') && full.includes('<growth_context')) {
          sawAllContexts = true
        }
        if (full.includes('【执行阶段')) {
          yield* textChunks(JSON.stringify(task.acceptance))
        } else {
          yield* textChunks('Plan: inspect <memory_source> and <growth_context> before answering.')
        }
      }
    }

    const exec = createNativeBenchmarkExecutor(config, async () => ({
      adapter: new CombinedAdapter(),
      inputTokenUpperBound: () => 500,
      dispose() {},
    }))
    const res = await exec.execute({
      planId: plan.id,
      dataset: plan.dataset,
      cell: candidateCell,
      task: plan.cases[0]!,
      variant: plan.variants.find(v => v.id === 'candidate')!,
      budget: plan.budget,
      signal: new AbortController().signal,
    })
    expect(res.verdict).toBe('achieved')
    expect(sawAllContexts).toBe(true)
    expect(res.metrics.toolCalls).toBe(0)
  }, 20_000)
})
