import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, test } from 'vitest'
import { createStrategyBenchmarkExecutor, createStrategyBenchmarkPlan } from '../../src/benchmark/strategy-executor.js'
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'strategy-unknown-'))); roots.push(root)
  return { suite: 'strategy-v1', id: 'strategy-unknown', cases: ['integer-sum'], persona: 'Solve the public task with the admitted Goal and isolated tools.',
    model: { provider: 'unknown-fixture', model: 'fixed', temperature: null, maxOutputTokens: 128, inputUsdMicrosPerMillionTokens: null, outputUsdMicrosPerMillionTokens: null, adapterDigest: 'a'.repeat(64), tokenCounterDigest: 'b'.repeat(64) },
    execution: { modelCalls: 16, maxOutputTokensPerCall: 128, maxGoalRounds: 3 }, budget: { durationMs: 100000, inputTokens: 1000, outputTokens: 2048, toolCalls: 8, costUsdMicros: null }, repeats: 2, seed: 1,
    image: `sha256:${'0'.repeat(64)}`, dockerPath: process.execPath, stepMaxDurationMs: 25000, stopTimeoutMs: 1000,
    workspaceDirectory: join(root, 'workspaces'), stateDirectory: join(root, 'state') }
}

test('a native Goal with no artifact remains unknown, persists failure evidence, and blocks replay', async () => {
  const input = config(); const task = strategyDevelopmentTask('integer-sum'); const plan = createStrategyBenchmarkPlan(input); const journal = strategyBenchmarkJournalPlan(plan)
  const store = new BenchmarkStore(':memory:'); let factories = 0
  const factory: NativeAdapterFactory = (_model) => {
    factories++; let calls = 0
    class Adapter extends LlmAdapter {
      override providerInfo(id: string) { return { id, name: id } }
      override async resolveModel(provider: string, id: string) { return { provider, id, name: id, inputModalities: ['text' as const] } }
      override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        calls++
        if (calls === 1) {
          const id = ToolCallId('goal-create-only'); const argumentsJson = JSON.stringify({ objective: task.objective, max_goal_rounds: 3 })
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id, name: 'goal_create', argumentsDelta: argumentsJson }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'goal_create', arguments: argumentsJson } }
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'No artifact is available.' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'No artifact is available.' } }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }; yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    return { adapter: new Adapter(), inputTokenUpperBound: () => 10, dispose() {} }
  }
  try {
    const executor = createStrategyBenchmarkExecutor({ ...input, plan, tasks: { 'integer-sum': task }, factory })
    const results = await runBenchmark(store, journal, executor)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ status: 'unknown', verdict: 'unknown', evidenceDigest: expect.any(String) })
    const evidence = new StrategyEvidenceStore({ stateDirectory: input.stateDirectory, candidateWorkspace: input.workspaceDirectory })
    const failure = evidence.readFailure(plan, results[0]!.cell, results[0]!.evidenceDigest!)
    expect(failure.snapshot.lastGoalObservation?.value).toEqual(expect.objectContaining({ outcome: expect.objectContaining({ status: 'unknown' }) }))
    await runBenchmark(store, journal, executor)
    expect(factories).toBe(1)
  } finally { store.close() }
}, 120000)
