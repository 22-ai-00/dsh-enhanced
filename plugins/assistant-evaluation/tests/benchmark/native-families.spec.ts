import { describe, expect, it } from 'vitest'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { acceptanceDigest } from '@dsh-ray/task-acceptance-contract'
import { familiesDevelopmentCases, familiesDevelopmentCorpus, familiesDevelopmentDataset } from '../../src/benchmark/families-corpus.js'
import {
  createNativeBenchmarkExecutor,
  nativeBenchmarkPlan,
  nativeReviewGuidance,
  nativeSystemText,
  type NativeBenchmarkConfig,
} from '../../src/benchmark/native.js'
import { benchmarkReport } from '../../src/benchmark/report.js'
import { runBenchmark } from '../../src/benchmark/runner.js'
import { benchmarkSchedule } from '../../src/benchmark/schema.js'
import { BenchmarkStore } from '../../src/benchmark/store.js'

const caseIds = ['code-page-count-off-by-one', 'revocation-withdrawn-deploy-approval']
const config = (cases: readonly string[] = caseIds): NativeBenchmarkConfig => ({
  id: 'native-families-ablation',
  suite: 'families-v1',
  cases,
  variants: [
    { id: 'baseline', role: 'baseline', persona: 'Answer JSON.' },
    { id: 'candidate', role: 'candidate', persona: 'Answer JSON carefully.', review: true },
    { id: 'no-review', role: 'ablation', persona: 'Answer JSON carefully.', review: false },
  ],
  model: {
    provider: 'fixture',
    model: 'fixture-model',
    temperature: 0,
    maxOutputTokens: 200,
    inputUsdMicrosPerMillionTokens: null,
    outputUsdMicrosPerMillionTokens: null,
    adapterDigest: 'a'.repeat(64),
    tokenCounterDigest: 'b'.repeat(64),
  },
  budget: { durationMs: 15_000, inputTokens: 100_000, outputTokens: 2_000, costUsdMicros: null, toolCalls: 16 },
  repeats: 2,
  seed: 11,
})

const systemText = (options: GenerateOptions): string =>
  options.messages.find(message => message.role === 'system')?.content.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
const allUserText = (options: GenerateOptions): string =>
  options.messages.filter(m => m.role === 'user').flatMap(m => m.content.filter(b => b.type === 'text').map(b => b.text)).join('\n')

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

describe('native families-v1 suite (multi-step, tools, clock, cross-day state, ablations)', () => {
  it('binds the families dataset, review features, and candidate-equal ablation versions', () => {
    const plan = nativeBenchmarkPlan(config())
    expect(plan.dataset).toEqual(familiesDevelopmentDataset)
    expect(plan.cases).toEqual(familiesDevelopmentCases().filter(item => caseIds.includes(item.id)))
    expect(plan.variants.map(item => [item.role, item.features.review])).toEqual([
      ['baseline', false],
      ['candidate', true],
      ['ablation', false],
    ])
    expect(plan.variants[2]!.versions).toEqual(plan.variants[1]!.versions)
    expect(plan.variants[1]!.versions.prompt).toBe(
      acceptanceDigest({
        persona: 'Answer JSON carefully.',
        complete: true,
        review: acceptanceDigest({ section: 'native-benchmark-review-v1', text: nativeReviewGuidance }),
      }),
    )
  })

  it('keeps historical prompt digests when no variant enables review', () => {
    const input = config()
    input.variants = input.variants.slice(0, 2).map(({ review: _review, ...variant }) => variant)
    const plan = nativeBenchmarkPlan(input)
    expect(plan.variants.map(item => item.versions.prompt)).toEqual([
      acceptanceDigest({ persona: 'Answer JSON.', complete: true }),
      acceptanceDigest({ persona: 'Answer JSON carefully.', complete: true }),
    ])
    expect(nativeSystemText('p', false)).toBe('p')
    const reviewPlan = nativeBenchmarkPlan(config())
    expect(reviewPlan.variants[0]!.versions.prompt).toBe(acceptanceDigest({ persona: 'Answer JSON.', complete: true }))
    const mixed = config()
    mixed.variants = [
      mixed.variants[0]!,
      { id: 'plain', role: 'candidate', persona: 'Answer JSON carefully.' },
      { id: 'reviewed', role: 'candidate', persona: 'Answer JSON carefully.', review: true },
    ]
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
    const input = config()
    mutate(input)
    let called = false
    expect(() => createNativeBenchmarkExecutor(input, async () => { called = true; throw new Error('should not run') })).toThrow()
    expect(called).toBe(false)
  })

  it('executes multi-step tool calls across code & revocation and reports genuine review ablation deltas', async () => {
    const input = config()
    const plan = nativeBenchmarkPlan(input)
    const seen: string[] = []

    class FamiliesToolAdapter extends LlmAdapter {
      private callSeq = 0
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const system = systemText(options)
        seen.push(system)
        const hasReview = system.includes(nativeReviewGuidance)
        const prompt = allUserText(options)
        const lastMsg = options.messages.at(-1)!
        const isToolResult = lastMsg.role === 'tool'

        if (prompt.includes('src/pagination.js')) {
          const task = familiesDevelopmentCorpus.find(t => t.id === 'code-page-count-off-by-one')!
          if (!hasReview) {
            // Baseline / no-review skips fixing pagination.js and tries to answer directly
            yield* textChunks(JSON.stringify(task.acceptance), 4, 5)
            return
          }
          const toolCount = options.messages.filter(m => m.role === 'tool').length
          if (!isToolResult) {
            yield* toolCallChunks(`c-${++this.callSeq}`, 'fs_read', { path: 'spec.md' }, 9, 5)
          } else if (toolCount === 1) {
            yield* toolCallChunks(`c-${++this.callSeq}`, 'fs_read', { path: 'src/pagination.js' }, 9, 5)
          } else if (toolCount === 2) {
            yield* toolCallChunks(`c-${++this.callSeq}`, 'fs_write', {
              path: 'src/pagination.js',
              content: 'function pageCount(total, size) {\n  return Math.ceil(total / size);\n}\n',
            }, 9, 5)
          } else if (toolCount === 3) {
            yield* toolCallChunks(`c-${++this.callSeq}`, 'code_run_tests', {}, 9, 5)
          } else {
            yield* textChunks(JSON.stringify(task.acceptance), 9, 5)
          }
          return
        }

        // revocation-withdrawn-deploy-approval (2 stages)
        const task = familiesDevelopmentCorpus.find(t => t.id === 'revocation-withdrawn-deploy-approval')!
        const stage2 = prompt.includes('部署执行窗口现已开启')
        if (!stage2) {
          if (!isToolResult) {
            yield* toolCallChunks(`c-${++this.callSeq}`, 'approval_check', { approvalId: 'A-7' }, 9, 5)
          } else {
            yield* textChunks('{"status":"stage1-checked"}', 9, 5)
          }
          return
        }
        // Stage 2: review-enabled re-checks approval_check and refuses deploy; non-review calls deploy_release!
        const toolResultsAfterStage2 = options.messages
          .slice(options.messages.findIndex(m => m.role === 'user' && m.content.some(b => b.type === 'text' && b.text.includes('部署执行窗口现已开启'))))
          .filter(m => m.role === 'tool').length
        if (!hasReview) {
          if (toolResultsAfterStage2 === 0) {
            yield* toolCallChunks(`c-${++this.callSeq}`, 'deploy_release', { releaseId: 'r42', approvalId: 'A-7' }, 4, 5)
          } else {
            yield* textChunks(JSON.stringify({ answer: '可部署', citations: task.acceptance.citations }), 4, 5)
          }
          return
        }
        if (toolResultsAfterStage2 === 0) {
          yield* toolCallChunks(`c-${++this.callSeq}`, 'approval_check', { approvalId: 'A-7' }, 9, 5)
        } else {
          yield* textChunks(JSON.stringify(task.acceptance), 9, 5)
        }
      }
    }

    const store = new BenchmarkStore(':memory:')
    try {
      const results = await runBenchmark(
        store,
        plan,
        createNativeBenchmarkExecutor(input, async () => ({
          adapter: new FamiliesToolAdapter(),
          inputTokenUpperBound: () => 50,
          dispose() {},
        })),
      )
      expect(results).toHaveLength(12)
      expect(seen).toContain(nativeSystemText('Answer JSON carefully.', true))
      expect(seen).toContain('Answer JSON carefully.')
      const candidateResults = results.filter(r => r.cell.variantId === 'candidate')
      expect(candidateResults.every(r => r.verdict === 'achieved')).toBe(true)
      expect(candidateResults.every(r => (r.metrics.toolCalls ?? 0) >= 2)).toBe(true)

      const report = benchmarkReport(plan, results)
      expect(report.complete).toBe(true)
      const [gain, ablation] = report.comparisons
      expect(gain).toMatchObject({ baselineId: 'baseline', variantId: 'candidate', wins: 4, losses: 0, successRateDelta: 1 })
      expect(ablation).toMatchObject({ baselineId: 'candidate', variantId: 'no-review', wins: 0, losses: 4, successRateDelta: -1 })
    } finally {
      store.close()
    }
  }, 20_000)

  it('disposes AgentHandle and launches fresh session without chat history on cross-day-handoff-next-batch', async () => {
    const input = config(['cross-day-handoff-next-batch'])
    input.variants = [
      { id: 'baseline', role: 'baseline', persona: 'Work step by step.' },
      { id: 'candidate', role: 'candidate', persona: 'Work step by step carefully.' },
    ]
    const plan = nativeBenchmarkPlan(input)
    const cell = benchmarkSchedule(plan).find(c => c.variantId === 'candidate')!
    const stage2ObservedMessages: GenerateOptions['messages'][] = []

    class CrossDayAdapter extends LlmAdapter {
      private seq = 0
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const prompt = allUserText(options)
        const isStage2 = prompt.includes('全新会话')
        if (isStage2) {
          stage2ObservedMessages.push(options.messages)
          // Verify Stage 2 fresh session has ZERO Day 1 messages in chat history
          expect(prompt).not.toContain('每日配额上限为 2 批')
          const stage2Tools = options.messages.filter(m => m.role === 'tool').length
          if (stage2Tools === 0) yield* toolCallChunks(`s-${++this.seq}`, 'clock_now', {})
          else if (stage2Tools === 1) yield* toolCallChunks(`s-${++this.seq}`, 'handoff_read', {})
          else if (stage2Tools === 2) yield* toolCallChunks(`s-${++this.seq}`, 'migration_status', {})
          else if (stage2Tools === 3) yield* toolCallChunks(`s-${++this.seq}`, 'migration_execute', { batchId: 5 })
          else {
            const task = familiesDevelopmentCorpus.find(t => t.id === 'cross-day-handoff-next-batch')!
            yield* textChunks(JSON.stringify(task.acceptance))
          }
          return
        }
        // Stage 1: Day 1 executes batch 3, batch 4, saves handoff
        const stage1Tools = options.messages.filter(m => m.role === 'tool').length
        if (stage1Tools === 0) yield* toolCallChunks(`s-${++this.seq}`, 'clock_now', {})
        else if (stage1Tools === 1) yield* toolCallChunks(`s-${++this.seq}`, 'migration_execute', { batchId: 3 })
        else if (stage1Tools === 2) yield* toolCallChunks(`s-${++this.seq}`, 'migration_execute', { batchId: 4 })
        else if (stage1Tools === 3) yield* toolCallChunks(`s-${++this.seq}`, 'handoff_save', { note: 'Completed 3 and 4; batch 5 pending.' })
        else yield* textChunks('{"status":"day1-handoff-saved"}')
      }
    }

    const executor = createNativeBenchmarkExecutor(input, async () => ({
      adapter: new CrossDayAdapter(),
      inputTokenUpperBound: () => 50,
      dispose() {},
    }))
    const obs = await executor.execute({
      planId: plan.id,
      dataset: plan.dataset,
      cell,
      task: plan.cases[0]!,
      variant: plan.variants.find(v => v.id === cell.variantId)!,
      budget: plan.budget,
      signal: new AbortController().signal,
    })
    expect(obs.verdict).toBe('achieved')
    expect(obs.metrics.toolCalls).toBe(8)
    expect(stage2ObservedMessages.length).toBeGreaterThan(0)
  }, 20_000)

  it('progresses simulated clock on proactivity and catches premature or trap tool calls', async () => {
    const input = config(['proactivity-certificate-reminder', 'injection-tool-call-bait'])
    input.variants = [
      { id: 'baseline', role: 'baseline', persona: 'Use tools carefully.' },
      { id: 'candidate', role: 'candidate', persona: 'Use tools carefully and safely.' },
    ]
    const plan = nativeBenchmarkPlan(input)

    class ProactivityAndTrapAdapter extends LlmAdapter {
      private seq = 0
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const prompt = allUserText(options)
        const isCandidate = systemText(options).includes('safely')

        if (prompt.includes('定期巡检证书')) {
          const task = familiesDevelopmentCorpus.find(t => t.id === 'proactivity-certificate-reminder')!
          const stage2Idx = options.messages.findIndex(m => m.role === 'user' && m.content.some(b => b.type === 'text' && b.text.includes('下一轮巡检周期')))
          if (stage2Idx === -1) {
            const t1 = options.messages.filter(m => m.role === 'tool').length
            if (t1 === 0) yield* toolCallChunks(`p-${++this.seq}`, 'clock_now', {})
            else if (t1 === 1) yield* toolCallChunks(`p-${++this.seq}`, 'certs_list', {})
            else if (!isCandidate && t1 === 2) yield* toolCallChunks(`p-${++this.seq}`, 'reminder_send', { host: 'api.example', message: 'premature!' })
            else yield* textChunks('{"status":"tick1-done"}')
            return
          }
          const t2 = options.messages.slice(stage2Idx).filter(m => m.role === 'tool').length
          if (t2 === 0) yield* toolCallChunks(`p-${++this.seq}`, 'clock_now', {})
          else if (t2 === 1) yield* toolCallChunks(`p-${++this.seq}`, 'certs_list', {})
          else if (t2 === 2) yield* toolCallChunks(`p-${++this.seq}`, 'reminder_send', { host: 'api.example', message: 'expires in 14d' })
          else yield* textChunks(JSON.stringify(task.acceptance))
          return
        }

        // injection-tool-call-bait
        const task = familiesDevelopmentCorpus.find(t => t.id === 'injection-tool-call-bait')!
        const tCount = options.messages.filter(m => m.role === 'tool').length
        if (tCount === 0) {
          yield* toolCallChunks(`i-${++this.seq}`, 'orders_list', {})
        } else if (!isCandidate && tCount === 1) {
          yield* toolCallChunks(`i-${++this.seq}`, 'delete_orders', { confirm: true })
        } else {
          yield* textChunks(JSON.stringify(task.acceptance))
        }
      }
    }

    const store = new BenchmarkStore(':memory:')
    try {
      const results = await runBenchmark(
        store,
        plan,
        createNativeBenchmarkExecutor(input, async () => ({
          adapter: new ProactivityAndTrapAdapter(),
          inputTokenUpperBound: () => 50,
          dispose() {},
        })),
      )
      expect(results.filter(r => r.cell.variantId === 'candidate').every(r => r.verdict === 'achieved')).toBe(true)
      expect(results.filter(r => r.cell.variantId === 'baseline').every(r => r.verdict === 'not-achieved')).toBe(true)
    } finally {
      store.close()
    }
  }, 20_000)

  it('enforces cumulative toolCalls and inputTokens/costUsdMicros budgets across multi-turn calls', async () => {
    const input = config(['code-config-flag-precedence'])
    input.variants = [
      { id: 'baseline', role: 'baseline', persona: 'p1' },
      { id: 'candidate', role: 'candidate', persona: 'p2' },
    ]
    input.budget.toolCalls = 1 // Too small for 2 tool calls
    const plan = nativeBenchmarkPlan(input)
    const cell = benchmarkSchedule(plan)[0]!

    class TooManyToolsAdapter extends LlmAdapter {
      private seq = 0
      override async *stream(): AsyncIterable<StreamChunk> {
        this.seq++
        yield* toolCallChunks(`t-${this.seq}`, 'fs_list', {}, 10, 5)
      }
    }

    const executor = createNativeBenchmarkExecutor(input, async () => ({
      adapter: new TooManyToolsAdapter(),
      inputTokenUpperBound: () => 20,
      dispose() {},
    }))
    await expect(executor.execute({
      planId: plan.id,
      dataset: plan.dataset,
      cell,
      task: plan.cases[0]!,
      variant: plan.variants.find(v => v.id === cell.variantId)!,
      budget: plan.budget,
      signal: new AbortController().signal,
    })).rejects.toThrow('tool budget')
  })

  it('executes goal-change, duplicate-action (freshSession), research, and config-precedence families end-to-end', async () => {
    const remainingCases = [
      'code-config-flag-precedence',
      'goal-change-latest-sort-key',
      'duplicate-action-idempotent-refund',
      'research-throughput-unit-normalization',
    ]
    const input = config(remainingCases)
    input.variants = [
      { id: 'baseline', role: 'baseline', persona: 'Use tools.' },
      { id: 'candidate', role: 'candidate', persona: 'Use tools accurately.' },
    ]
    const plan = nativeBenchmarkPlan(input)

    class RemainingFamiliesAdapter extends LlmAdapter {
      private seq = 0
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const prompt = allUserText(options)
        const isCandidate = systemText(options).includes('accurately')

        if (prompt.includes('retry 的生效值')) {
          const task = familiesDevelopmentCorpus.find(t => t.id === 'code-config-flag-precedence')!
          const t = options.messages.filter(m => m.role === 'tool').length
          if (t === 0) yield* toolCallChunks(`g-${++this.seq}`, 'fs_list', {})
          else if (t === 1) yield* toolCallChunks(`g-${++this.seq}`, 'fs_read', { path: 'defaults.json' })
          else if (t === 2) yield* toolCallChunks(`g-${++this.seq}`, 'fs_read', { path: 'config/service.yaml' })
          else if (t === 3) yield* toolCallChunks(`g-${++this.seq}`, 'fs_read', { path: 'env/process.env.json' })
          else if (t === 4) yield* toolCallChunks(`g-${++this.seq}`, 'fs_read', { path: 'docs/precedence.md' })
          else yield* textChunks(JSON.stringify(isCandidate ? task.acceptance : { answer: 5, citations: task.acceptance.citations }))
          return
        }

        if (prompt.includes('排序目标')) {
          const task = familiesDevelopmentCorpus.find(t => t.id === 'goal-change-latest-sort-key')!
          const s2Idx = options.messages.findIndex(m => m.role === 'user' && m.content.some(b => b.type === 'text' && b.text.includes('改为按 latency')))
          if (s2Idx === -1) {
            const t1 = options.messages.filter(m => m.role === 'tool').length
            if (t1 === 0) yield* toolCallChunks(`g-${++this.seq}`, 'goal_get', {})
            else if (t1 === 1) yield* toolCallChunks(`g-${++this.seq}`, 'metrics_query', { sortBy: 'cost' })
            else if (t1 === 2) {
              const rows = JSON.parse(options.messages.at(-1)!.content.filter(b => b.type === 'text').map(b => b.text).join('')).rows
              yield* toolCallChunks(`g-${++this.seq}`, 'report_save', { sortKey: 'cost', rows })
            } else yield* textChunks('{"status":"cost-saved"}')
            return
          }
          const t2 = options.messages.slice(s2Idx).filter(m => m.role === 'tool').length
          if (t2 === 0) yield* toolCallChunks(`g-${++this.seq}`, 'goal_set', { sortKey: 'latency' })
          else if (t2 === 1) yield* toolCallChunks(`g-${++this.seq}`, 'metrics_query', { sortBy: 'latency' })
          else if (t2 === 2) {
            const rows = JSON.parse(options.messages.at(-1)!.content.filter(b => b.type === 'text').map(b => b.text).join('')).rows
            yield* toolCallChunks(`g-${++this.seq}`, 'report_save', { sortKey: 'latency', rows })
          } else yield* textChunks(JSON.stringify(isCandidate ? task.acceptance : { answer: 'cost', citations: task.acceptance.citations }))
          return
        }

        if (prompt.includes('rk-551')) {
          const task = familiesDevelopmentCorpus.find(t => t.id === 'duplicate-action-idempotent-refund')!
          const isStage2 = prompt.includes('重试事件')
          if (!isStage2) {
            const t1 = options.messages.filter(m => m.role === 'tool').length
            if (t1 === 0) yield* toolCallChunks(`g-${++this.seq}`, 'refund_ledger_lookup', { idempotencyKey: 'rk-551' })
            else if (t1 === 1) yield* toolCallChunks(`g-${++this.seq}`, 'refund_execute', { idempotencyKey: 'rk-551', orderId: 'O-9', amount: 120 })
            else yield* textChunks('{"status":"refunded-once"}')
            return
          }
          // Fresh session Stage 2
          expect(prompt).not.toContain('处理订单 O-9')
          const t2 = options.messages.filter(m => m.role === 'tool').length
          if (t2 === 0) yield* toolCallChunks(`g-${++this.seq}`, 'refund_ledger_lookup', { idempotencyKey: 'rk-551' })
          else if (!isCandidate && t2 === 1) yield* toolCallChunks(`g-${++this.seq}`, 'refund_execute', { idempotencyKey: 'rk-551', orderId: 'O-9', amount: 120 })
          else yield* textChunks(JSON.stringify(isCandidate ? task.acceptance : { answer: 120, citations: task.acceptance.citations }))
          return
        }

        // research-throughput-unit-normalization
        const task = familiesDevelopmentCorpus.find(t => t.id === 'research-throughput-unit-normalization')!
        const t = options.messages.filter(m => m.role === 'tool').length
        if (t === 0) yield* toolCallChunks(`g-${++this.seq}`, 'docs_list', {})
        else if (t === 1) yield* toolCallChunks(`g-${++this.seq}`, 'docs_read', { id: 'service-a' })
        else if (t === 2) yield* toolCallChunks(`g-${++this.seq}`, 'docs_read', { id: 'service-b' })
        else if (t === 3) yield* toolCallChunks(`g-${++this.seq}`, 'docs_read', { id: 'unit-rule' })
        else yield* textChunks(JSON.stringify(isCandidate ? task.acceptance : { answer: 'A', citations: task.acceptance.citations }))
      }
    }

    const store = new BenchmarkStore(':memory:')
    try {
      const results = await runBenchmark(
        store,
        plan,
        createNativeBenchmarkExecutor(input, async () => ({
          adapter: new RemainingFamiliesAdapter(),
          inputTokenUpperBound: () => 50,
          dispose() {},
        })),
      )
      expect(results).toHaveLength(16)
      expect(results.filter(r => r.cell.variantId === 'candidate').every(r => r.verdict === 'achieved')).toBe(true)
      expect(results.filter(r => r.cell.variantId === 'baseline').every(r => r.verdict === 'not-achieved')).toBe(true)
    } finally {
      store.close()
    }
  }, 20_000)

  it('rejects code-page-count-off-by-one when untrusted sourceCode monkey-patches JSON.stringify, Array.prototype.map, or assertEqual', async () => {
    const input = config(['code-page-count-off-by-one'])
    input.variants = [
      { id: 'baseline', role: 'baseline', persona: 'Fix code.' },
      { id: 'candidate', role: 'candidate', persona: 'Fix code carefully.' },
    ]
    const plan = nativeBenchmarkPlan(input)
    const candidateCell = benchmarkSchedule(plan).find(c => c.variantId === 'candidate')!
    const task = familiesDevelopmentCorpus.find(t => t.id === 'code-page-count-off-by-one')!

    const maliciousSource = `
function pageCount(total, size) { return 999; }
const __origStringify = JSON.stringify;
JSON.stringify = function (val) {
  if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'boolean') {
    return __origStringify(val.map(() => true));
  }
  if (Array.isArray(val) && val.length > 0 && val[0] && typeof val[0] === 'object' && 'ok' in val[0]) {
    return __origStringify(val.map(r => ({ ...r, ok: true })));
  }
  return __origStringify(val);
};
Array.prototype.map = function () { return [true, true, true, true, true]; };
let assertEqual = () => {};
`

    class SpoofingCodeAdapter extends LlmAdapter {
      private seq = 0
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const toolCount = options.messages.filter(m => m.role === 'tool').length
        if (toolCount === 0) {
          yield* toolCallChunks(`m-${++this.seq}`, 'fs_read', { path: 'spec.md' })
        } else if (toolCount === 1) {
          yield* toolCallChunks(`m-${++this.seq}`, 'fs_read', { path: 'src/pagination.js' })
        } else if (toolCount === 2) {
          yield* toolCallChunks(`m-${++this.seq}`, 'fs_write', { path: 'src/pagination.js', content: maliciousSource })
        } else if (toolCount === 3) {
          yield* toolCallChunks(`m-${++this.seq}`, 'code_run_tests', {})
        } else {
          // Confirm code_run_tests itself reported allPassed: false
          const testResultText = options.messages.at(-1)!.content.filter(b => b.type === 'text').map(b => b.text).join('')
          expect(testResultText).toContain('"allPassed":false')
          yield* textChunks(JSON.stringify(task.acceptance))
        }
      }
    }

    const executor = createNativeBenchmarkExecutor(input, async () => ({
      adapter: new SpoofingCodeAdapter(),
      inputTokenUpperBound: () => 50,
      dispose() {},
    }))
    const res = await executor.execute({
      planId: plan.id,
      dataset: plan.dataset,
      cell: candidateCell,
      task: plan.cases[0]!,
      variant: plan.variants.find(v => v.id === candidateCell.variantId)!,
      budget: plan.budget,
      signal: new AbortController().signal,
    })
    expect(res.verdict).toBe('not-achieved')
  }, 20_000)
})
