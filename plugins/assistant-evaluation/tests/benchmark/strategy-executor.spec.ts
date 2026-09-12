import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, cpSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, test } from 'vitest'
import { createStrategyBenchmarkExecutor, createStrategyBenchmarkPlan, verifyStrategyBenchmarkResults } from '../../src/benchmark/strategy-executor.js'
import { strategyBenchmarkJournalPlan } from '../../src/benchmark/strategy-plan.js'
import { strategyDevelopmentTask } from '../../src/benchmark/strategy-corpus.js'
import type { StrategyBenchmarkConfig } from '../../src/benchmark/strategy-config.js'
import type { NativeAdapterFactory } from '../../src/benchmark/native.js'
import { StrategyEvidenceStore } from '../../src/benchmark/strategy-evidence.js'
import { BenchmarkStore } from '../../src/benchmark/store.js'
import { runBenchmark } from '../../src/benchmark/runner.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function config(): StrategyBenchmarkConfig {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'strategy-executor-'))); roots.push(root)
  return { suite: 'strategy-v1', id: 'strategy-executor', cases: ['integer-sum'], persona: 'Solve the public task with the admitted Goal and isolated tools.',
    model: { provider: 'strategy-fixture', model: 'fixed', temperature: null, maxOutputTokens: 128, inputUsdMicrosPerMillionTokens: null, outputUsdMicrosPerMillionTokens: null, adapterDigest: 'a'.repeat(64), tokenCounterDigest: 'b'.repeat(64) },
    execution: { modelCalls: 16, maxOutputTokensPerCall: 128, maxGoalRounds: 3 }, budget: { durationMs: 100000, inputTokens: 1000, outputTokens: 2048, toolCalls: 8, costUsdMicros: null },
    repeats: 2, seed: 1, image: process.env.DSH_ISOLATION_TEST_IMAGE ?? `sha256:${'0'.repeat(64)}`, dockerPath: '/usr/bin/docker', stepMaxDurationMs: 25000, stopTimeoutMs: 1000,
    workspaceDirectory: join(root, 'workspaces'), stateDirectory: join(root, 'state') }
}
const task = strategyDevelopmentTask('integer-sum')
const tasks = { 'integer-sum': task }

test.skipIf(!process.env.DSH_ISOLATION_TEST_IMAGE)('runs all paired native cells, reopens detailed evidence, and never replays completed cells', async () => {
  const input = config(); const plan = createStrategyBenchmarkPlan(input); const journal = strategyBenchmarkJournalPlan(plan)
  const database = new BenchmarkStore(join(roots.at(-1)!, 'journal.sqlite'))
  const workspaces = new Set<string>(); let factories = 0; let childCalls = 0; let privateLeak = false
  const factory: NativeAdapterFactory = (_model, { ctx, workspace }) => {
    factories++; workspaces.add(workspace)
    let calls = 0; let compared = false; const written = new Set<number>()
    class Adapter extends LlmAdapter {
      override providerInfo(id: string) { return { id, name: id } }
      override async resolveModel(provider: string, id: string) { return { provider, id, name: id, inputModalities: ['text' as const] } }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        calls++
        if (JSON.stringify(options.messages).includes('expectedStdout') || JSON.stringify(options.messages).includes('-5\\n10\\n-3')) privateLeak = true
        const agent = ctx.agents.currentInitiator()!
        const goal = (ctx.get('goals' as never) as unknown as { get(agent: unknown): { roundsStarted: number } | undefined }).get(agent)
        let name: string | undefined; let args: object = {}
        if (agent.session.header.origin === 'subagent') { childCalls++; expect(options.tools ?? []).toEqual([]) }
        else if (!goal) { name = 'goal_create'; args = { objective: task.objective, max_goal_rounds: 3 } }
        else if (goal.roundsStarted > 0 && !compared && options.tools?.some(tool => tool.name === 'goal_strategy')) {
          compared = true; name = 'goal_strategy'; args = { kind: 'compare', question: 'Compare two implementations of the public task.' }
        } else if (goal.roundsStarted > 0 && !written.has(goal.roundsStarted)) {
          written.add(goal.roundsStarted); name = 'isolation_run'
          args = { grant_id: 'benchmark-work', idempotency_key: `artifact-${goal.roundsStarted}`, command: 'cp source answer.sh',
            files: [{ path: 'source', content: goal.roundsStarted === 1 ? 'printf wrong' : "awk '{for(i=1;i<=NF;i++) s+=$i} END {print s+0}'" }], artifacts: ['answer.sh'], timeout_ms: 15000 }
        }
        if (name) {
          const id = ToolCallId(`call-${calls}`); const json = JSON.stringify(args)
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } }
        } else {
          const text = 'Continue from independent feedback.'
          yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text }; yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }; yield { type: 'finish', reason: { kind: name ? 'tool-calls' : 'stop' } }
      }
    }
    return { adapter: new Adapter(), inputTokenUpperBound: () => 10, dispose() {} }
  }
  try {
    const executor = createStrategyBenchmarkExecutor({ ...input, plan, tasks, factory })
    const results = await runBenchmark(database, journal, executor)
    const archive = process.env.DSH_STRATEGY_EXECUTOR_EVIDENCE_ROOT
    if (archive) {
      mkdirSync(archive, { recursive: true, mode: 0o700 })
      const destination = join(archive, basename(roots.at(-1)!))
      cpSync(roots.at(-1)!, destination, { recursive: true, errorOnExist: true, force: false })
      writeFileSync(join(destination, 'results.json'), JSON.stringify(results, null, 2), { mode: 0o600 })
    }
    expect(results).toHaveLength(4)
    expect(results.map(({ status, verdict }) => ({ status, verdict })), JSON.stringify(results)).toEqual(Array.from({ length: 4 }, () => ({ status: 'completed', verdict: 'achieved' })))
    expect(factories).toBe(4); expect(workspaces.size).toBe(4); expect(childCalls).toBe(4); expect(privateLeak).toBe(false)
    verifyStrategyBenchmarkResults(plan, results, input.stateDirectory, input.workspaceDirectory)
    const evidence = new StrategyEvidenceStore({ stateDirectory: input.stateDirectory, candidateWorkspace: input.workspaceDirectory })
    for (const result of results) {
      const cell = evidence.readCell(plan, result.cell, result.evidenceDigest!)
      const native = evidence.read(plan, result.cell, cell.nativeEvidenceDigest)
      expect(native.native.receipts).toHaveLength(4)
      expect(native.meter.modelCalls).toBe(result.cell.variantId === 'direct' ? 6 : 9)
      expect(cell.capabilities.requests).toHaveLength(native.meter.modelCalls)
    }
    await runBenchmark(database, journal, executor); expect(factories).toBe(4)
    const path = join(input.stateDirectory, 'strategy-evidence-v1', `${results[0]!.evidenceDigest}.json`)
    const object = JSON.parse(readFileSync(path, 'utf8')); object.evidence.nativeEvidenceDigest = '0'.repeat(64)
    writeFileSync(path, JSON.stringify(object))
    expect(() => verifyStrategyBenchmarkResults(plan, results, input.stateDirectory, input.workspaceDirectory)).toThrow()
  } finally { database.close() }
}, 240000)

test('a hanging setup produces a bound unknown failure and blocks later cells even after late disposal', async () => {
  const input = config(); const plan = createStrategyBenchmarkPlan(input); const journal = strategyBenchmarkJournalPlan(plan)
  const database = new BenchmarkStore(':memory:'); const controller = new AbortController()
  let entered!: () => void; let release!: () => void; let stopped!: () => void; let calls = 0
  const started = new Promise<void>(resolve => { entered = resolve }); const late = new Promise<void>(resolve => { release = resolve })
  const disposed = new Promise<void>(resolve => { stopped = resolve })
  class Adapter extends LlmAdapter { override stream(): AsyncIterable<StreamChunk> { throw new Error('must not run') } }
  const executor = createStrategyBenchmarkExecutor({ ...input, plan, tasks, factory: async () => {
    calls++; entered(); await late; return { adapter: new Adapter(), inputTokenUpperBound: () => 10, dispose: stopped }
  } })
  try {
    const running = runBenchmark(database, journal, executor, controller.signal)
    await started; controller.abort()
    const results = await running
    expect(results).toHaveLength(1); expect(results[0]).toMatchObject({ status: 'unknown', reason: 'interrupted', verdict: 'unknown', evidenceDigest: expect.any(String) })
    const evidence = new StrategyEvidenceStore({ stateDirectory: input.stateDirectory, candidateWorkspace: input.workspaceDirectory })
    const failure = evidence.readFailure(plan, results[0]!.cell, results[0]!.evidenceDigest!)
    expect(failure.snapshot.meter).toBeNull(); expect(failure.snapshot.cleanup).not.toBe('succeeded')
    release(); await disposed
    await runBenchmark(database, journal, executor); expect(calls).toBe(1)
    expect(database.results(plan.benchmark.id)).toEqual(results)
    verifyStrategyBenchmarkResults(plan, results, input.stateDirectory, input.workspaceDirectory)
  } finally { release(); database.close() }
})

test('rejects actual parent request schema drift before provider dispatch', async () => {
  const input = config(); const plan = createStrategyBenchmarkPlan(input); const database = new BenchmarkStore(':memory:'); let calls = 0
  class Adapter extends LlmAdapter {
    override providerInfo(id: string) { return { id, name: id } }
    override async resolveModel(provider: string, id: string) { return { provider, id, name: id, inputModalities: ['text' as const] } }
    override async *stream(): AsyncIterable<StreamChunk> { calls++; yield { type: 'finish', reason: { kind: 'stop' } } }
  }
  try {
    const executor = createStrategyBenchmarkExecutor({ ...input, plan, tasks, factory: (_model, { ctx }: { ctx: Context }) => {
      ctx.on('system-prompt/assemble', async (_assembly, _context, next) => { const value = await next(); return { ...value, tools: value.tools.map(tool => ({ ...tool, description: 'unexpected replacement' })) } })
      return { adapter: new Adapter(), inputTokenUpperBound: () => 10, dispose() {} }
    } })
    const results = await runBenchmark(database, strategyBenchmarkJournalPlan(plan), executor)
    expect(calls).toBe(0); expect(results).toHaveLength(1); expect(results[0]).toMatchObject({ status: 'unknown', evidenceDigest: expect.any(String) })
    verifyStrategyBenchmarkResults(plan, results, input.stateDirectory, input.workspaceDirectory)
  } finally { database.close() }
})
