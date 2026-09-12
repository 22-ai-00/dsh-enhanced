import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, test } from 'vitest'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { createStrategyGoalRuntime, strategyGoalTaskDigests, type StrategyGoalRuntimeControl, type StrategyGoalTask } from '../../src/benchmark/strategy-goal-runtime.js'
import { strategyBenchmarkCapabilityVersions, strategyBenchmarkJournalPlan, strategyBenchmarkProtocol, type StrategyBenchmarkPlan } from '../../src/benchmark/strategy-plan.js'
import { benchmarkSchedule } from '../../src/benchmark/schema.js'
import type { NativeModelConfig } from '../../src/benchmark/native.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const task: StrategyGoalTask = { objective: 'Create answer.sh.', publicPrompt: 'Create answer.sh.', artifactPath: 'answer.sh', verification: { command: 'sh artifact', cases: [{ stdin: '', expectedStdout: '', expectedExitCode: 0 }], maxDurationMs: 1000, maxOutputBytes: 1024 } }
const model: NativeModelConfig = { provider: 'lifecycle-fixture', model: 'fixed', temperature: null, maxOutputTokens: 32, inputUsdMicrosPerMillionTokens: null, outputUsdMicrosPerMillionTokens: null, adapterDigest: 'a'.repeat(64), tokenCounterDigest: 'b'.repeat(64) }
function plan(): StrategyBenchmarkPlan {
  const capabilities = { common: { persona: 'a'.repeat(64), tools: 'b'.repeat(64), policy: 'c'.repeat(64), runtime: 'd'.repeat(64) }, strategy: { guide: 'e'.repeat(64), tool: 'f'.repeat(64), policy: '1'.repeat(64), runtime: '2'.repeat(64) } }
  return { schemaVersion: 1, protocol: strategyBenchmarkProtocol, capabilities, execution: { modelCalls: 4, maxOutputTokensPerCall: 32, maxGoalRounds: 1 }, benchmark: { schemaVersion: 1, id: 'strategy-lifecycle', comparison: 'capability', dataset: { id: 'fixture', version: '1', digest: acceptanceDigest(task), split: 'development' }, cases: [{ id: 'case', domain: 'code', ...strategyGoalTaskDigests(task) }], budget: { durationMs: 20000, inputTokens: 100, outputTokens: 128, toolCalls: 2, costUsdMicros: null }, repeats: 2, seed: 1, variants: [{ id: 'direct', role: 'baseline', versions: { model: acceptanceDigest(model), skills: '0'.repeat(64), ...strategyBenchmarkCapabilityVersions(capabilities, false) }, features: { memory: false, planning: false, review: false, growth: false } }, { id: 'adaptive-strategy', role: 'candidate', versions: { model: acceptanceDigest(model), skills: '0'.repeat(64), ...strategyBenchmarkCapabilityVersions(capabilities, true) }, features: { memory: false, planning: false, review: false, growth: false } }] } }
}

test('registers lifecycle before setup and disposes a factory binding that arrives after cancellation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'strategy-lifecycle-'))); cleanups.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace'); const stateRoot = join(root, 'state'); await mkdir(workspace, { mode: 0o700 }); await mkdir(stateRoot, { mode: 0o700 })
  const source = plan(); const bound = strategyBenchmarkJournalPlan(source); const variant = bound.variants[0]!; const cell = benchmarkSchedule(bound).find(value => value.variantId === variant.id)!
  const abort = new AbortController(); let control: StrategyGoalRuntimeControl | undefined; let started!: () => void; const factoryStarted = new Promise<void>(resolve => { started = resolve }); let release!: () => void; const late = new Promise<void>(resolve => { release = resolve }); let disposed = 0; let streams = 0
  class LateAdapter extends LlmAdapter { override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { streams++; yield { type: 'finish', reason: { kind: 'stop' } } } }
  const setup = createStrategyGoalRuntime({ plan: source, request: { planId: bound.id, dataset: bound.dataset, cell, task: bound.cases[0]!, variant, budget: bound.budget, signal: abort.signal }, task, workspace, stateRoot, persona: '', model,
    factory: async () => { started(); await late; return { adapter: new LateAdapter(), inputTokenUpperBound: () => 1, dispose: () => { disposed++ } } }, image: `sha256:${'0'.repeat(64)}`, dockerPath: '/usr/bin/docker', stepMaxDurationMs: 4000, stopTimeoutMs: 1000,
    lifecycle: value => { control = value }, })
  expect(control?.snapshot()).toMatchObject({ stage: 'setup', runtimeRoot: null, meter: null, goalSnapshot: null, cleanup: 'pending' })
  await factoryStarted; abort.abort(); const stopping = control!.close()
  expect(control?.snapshot()).toMatchObject({ stage: 'cleanup', cleanup: 'pending' })
  await expect(stopping).rejects.toThrow('stop is unknown')
  expect(control?.snapshot()).toMatchObject({ stage: 'cleanup', cleanup: 'unknown' })
  release(); await expect(setup).rejects.toThrow('strategy runtime setup failed')
  expect(disposed).toBe(1); expect(streams).toBe(0)
  await expect(control!.close()).rejects.toThrow('stop is unknown')
  expect(control?.snapshot()).toMatchObject({ cleanup: 'unknown', stage: 'cleanup', meter: null })
})

test('observer failure closes setup without replacing the observer exception', async () => {
  const source = plan(); const bound = strategyBenchmarkJournalPlan(source); const variant = bound.variants[0]!; const cell = benchmarkSchedule(bound).find(value => value.variantId === variant.id)!
  let control: StrategyGoalRuntimeControl | undefined
  await expect(createStrategyGoalRuntime({ plan: source, request: { planId: bound.id, dataset: bound.dataset, cell, task: bound.cases[0]!, variant, budget: bound.budget, signal: new AbortController().signal }, task, workspace: '/tmp/unused', stateRoot: '/tmp/unused-state', persona: '', model, factory: async () => { throw new Error('factory must not run') }, image: `sha256:${'0'.repeat(64)}`, dockerPath: '/usr/bin/docker', stepMaxDurationMs: 4000, lifecycle: value => { control = value; throw new Error('observer failed') } })).rejects.toThrow('observer failed')
  expect(control?.snapshot()).toMatchObject({ stage: 'closed', cleanup: 'succeeded', runtimeRoot: null, meter: null, goalSnapshot: null })
})
