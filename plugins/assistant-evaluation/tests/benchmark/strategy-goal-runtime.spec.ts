import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, test } from 'vitest'
import { createStrategyGoalRuntime, strategyGoalTaskDigests, type StrategyGoalTask } from '../../src/benchmark/strategy-goal-runtime.js'
import { strategyBenchmarkCapabilityVersions, strategyBenchmarkJournalPlan, strategyBenchmarkProtocol, type StrategyBenchmarkPlan } from '../../src/benchmark/strategy-plan.js'
import { StrategyEvidenceStore } from '../../src/benchmark/strategy-evidence.js'
import { benchmarkSchedule } from '../../src/benchmark/schema.js'
import type { AssistantGoalsService } from '@dsh-enhanced/assistant-goals'
import type { NativeModelConfig } from '../../src/benchmark/native.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const task: StrategyGoalTask = { objective: 'Create a shell program that adds two integers from stdin.', publicPrompt: 'Create a shell program that adds two integers from stdin. Use goal_create with that exact objective and at most 3 rounds. Use isolation_run with grant_id benchmark-work to export answer.sh.', artifactPath: 'answer.sh',
  verification: { command: 'sh artifact < input', cases: [{ stdin: '19 23', expectedStdout: '42', expectedExitCode: 0 }], maxDurationMs: 5000, maxOutputBytes: 4096 } }
const model: NativeModelConfig = { provider: 'strategy-fixture', model: 'fixed', maxOutputTokens: 128, temperature: null,
  inputUsdMicrosPerMillionTokens: null, outputUsdMicrosPerMillionTokens: null, adapterDigest: 'a'.repeat(64), tokenCounterDigest: 'b'.repeat(64) }
function plan(): StrategyBenchmarkPlan {
  const capabilities = { common: { persona: 'a'.repeat(64), tools: 'b'.repeat(64), policy: 'c'.repeat(64), runtime: 'd'.repeat(64) }, strategy: { guide: 'e'.repeat(64), tool: 'f'.repeat(64), policy: '1'.repeat(64), runtime: '2'.repeat(64) } }
  return { schemaVersion: 1, protocol: strategyBenchmarkProtocol, capabilities, execution: { modelCalls: 16, maxOutputTokensPerCall: 128, maxGoalRounds: 3 }, benchmark: { schemaVersion: 1, id: 'strategy-runtime',
    comparison: 'capability', dataset: { id: 'public-fixture', version: '1', digest: acceptanceDigest(task), split: 'development' }, cases: [{ id: 'sum', domain: 'code', ...strategyGoalTaskDigests(task) }],
    budget: { durationMs: 100000, inputTokens: 1000, outputTokens: 2048, toolCalls: 8, costUsdMicros: null }, repeats: 2, seed: 1,
    variants: ([false, true] as const).map(enabled => ({ id: enabled ? 'adaptive-strategy' : 'direct', role: enabled ? 'candidate' : 'baseline',
      versions: { model: acceptanceDigest(model), skills: '0'.repeat(64), ...strategyBenchmarkCapabilityVersions(capabilities, enabled) }, features: { memory: false, planning: false, review: false, growth: false } })) } }
}

for (const strategy of [false, true]) test.skipIf(!process.env.DSH_ISOLATION_TEST_IMAGE)(`real isolated Goal comparison arm strategy=${strategy}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'strategy-goal-runtime-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace'); const stateRoot = join(root, 'state')
  await mkdir(workspace, { mode: 0o700 }); await mkdir(stateRoot, { mode: 0o700 })
  const source = plan(); const bound = strategyBenchmarkJournalPlan(source); const variant = bound.variants[strategy ? 1 : 0]!
  const cell = benchmarkSchedule(bound).find(cell => cell.variantId === variant.id)!
  let calls = 0; let children = 0; let compared = false; const written = new Set<number>(); let sawFeedback = false; let leaked = false
  class Adapter extends LlmAdapter {
    constructor(readonly ctx: Context) { super() }
    override providerInfo(provider: string) { return { id: provider, name: provider } }
    override async resolveModel(provider: string, id: string) { return { provider, id, name: id, inputModalities: ['text' as const] } }
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls++
      const serialized = JSON.stringify(options.messages)
      if (serialized.includes('isolated-unexpected-stdout')) sawFeedback = true
      if (serialized.includes('19 23') || serialized.includes('expectedStdout')) leaked = true
      const agent = this.ctx.agents.currentInitiator()!
      const native = (this.ctx.get('goals' as never) as unknown as { get(agent: unknown): { roundsStarted: number } | undefined }).get(agent)
      let name: string | undefined; let args: object = {}
      if (agent.session.header.origin === 'subagent') { children++; expect(options.tools ?? []).toEqual([]) }
      else if (!native) { name = 'goal_create'; args = { objective: task.objective, max_goal_rounds: 3 } }
      else if (native.roundsStarted > 0 && strategy && !compared) { compared = true; name = 'goal_strategy'; args = { kind: 'compare', question: 'Compare two implementations for this public task.' } }
      else if (native.roundsStarted > 0 && !written.has(native.roundsStarted)) {
        written.add(native.roundsStarted); name = 'isolation_run'; args = { grant_id: 'benchmark-work', idempotency_key: `artifact-${native.roundsStarted}`, command: 'cp source answer.sh',
          files: [{ path: 'source', content: native.roundsStarted === 1 ? 'printf wrong' : 'read a b; printf "%s" "$((a + b))"' }], artifacts: ['answer.sh'], timeout_ms: 15000 }
      }
      if (name) {
        const id = ToolCallId(`call-${calls}`); const json = JSON.stringify(args)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } }
      } else {
        const text = 'Continue from the independent feedback.'
        yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text }; yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }
      yield { type: 'finish', reason: { kind: name ? 'tool-calls' : 'stop' } }
    }
  }
  const runtime = await createStrategyGoalRuntime({ plan: source, request: { planId: bound.id, dataset: bound.dataset, cell, task: bound.cases[0]!, variant, budget: bound.budget, signal: new AbortController().signal }, task,
    workspace, stateRoot, persona: 'Solve the public task using the admitted Goal and isolation tools. Keep test vectors private.', model,
    factory: (_model, { ctx }) => ({ adapter: new Adapter(ctx), inputTokenUpperBound: () => 10, dispose() {} }),
    image: process.env.DSH_ISOLATION_TEST_IMAGE!, dockerPath: '/usr/bin/docker', stepMaxDurationMs: 25000 })
  cleanups.push(runtime.close)
  const result = await runtime.execute()
  const snapshot = result.snapshot as unknown as ReturnType<AssistantGoalsService['inspectOwnerGoalExecution']>
  const evidenceStore = new StrategyEvidenceStore({ stateDirectory: stateRoot, candidateWorkspace: workspace })
  const saved = evidenceStore.read(source, cell, result.evidence.digest)
  expect(saved.native.receipts).toHaveLength(4)
  expect(saved.native.outcomeAssessments).toHaveLength(2)
  expect(saved.native.receipts.filter(item => item.taskKind === 'goal-outcome').map(item => item.receipt.objectiveStatus).sort()).toEqual(['achieved', 'not-achieved'])
  const stale = saved.native.outcomeAssessments.find(item => item.contract.id !== saved.native.selectedOutcomeContractId)!
  const { planDigest: _planDigest, ...body } = saved
  expect(() => evidenceStore.write({ ...body, plan: source, native: { ...saved.native, selectedOutcomeContractId: stale.contract.id } })).toThrow('selected outcome')
  expect(() => evidenceStore.write({ ...body, plan: source, native: { ...saved.native, runs: saved.native.runs.map((run, index) => index === 0 ? { ...run, quiescent: false } : run) } })).toThrow('quiescence')
  expect(() => evidenceStore.write({ ...body, plan: source, meter: { ...saved.meter, traces: saved.meter.traces.map((trace, index) => index === 0 ? { ...trace, sessionId: 'unrelated-session' } : trace) } })).toThrow('quiescence')
  if (process.env.DSH_STRATEGY_RUNTIME_EVIDENCE_ROOT) await writeFile(join(process.env.DSH_STRATEGY_RUNTIME_EVIDENCE_ROOT, `object-${strategy}.json`), await readFile(result.evidence.path), { mode: 0o600 })
  expect(snapshot.executionRuns.length).toBeGreaterThanOrEqual(2)
  expect(result.meter.modelCalls - snapshot.budget!.modelCalls).toBe(2)
  expect(snapshot.acceptedTasks.filter(value => value.receipt !== null).length).toBeGreaterThanOrEqual(4)
  expect(snapshot.acceptedTasks.some(value => value.contract?.task.kind === 'goal-outcome' && value.receipt?.objectiveStatus === 'achieved')).toBe(true)
  if (process.env.DSH_STRATEGY_RUNTIME_EVIDENCE_ROOT) await writeFile(join(process.env.DSH_STRATEGY_RUNTIME_EVIDENCE_ROOT, `arm-${strategy}.json`), JSON.stringify(result), { mode: 0o600 })
  expect(result.snapshot).toMatchObject({ outcome: { status: 'achieved' }, budget: { heldCalls: 0 } })
  expect(result.meter).toMatchObject({ modelCalls: calls, inputTokens: calls * 10, heldModelCalls: 0 })
  expect(children).toBe(strategy ? 2 : 0); expect(sawFeedback).toBe(true); expect(leaked).toBe(false)
  expect(JSON.stringify(result.snapshot)).toContain('not-achieved')
  await runtime.close()
}, 120000)

async function cancellableRuntime(hangDispose = false) {
  const root = await mkdtemp(join(tmpdir(), 'strategy-goal-cancel-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace'); const stateRoot = join(root, 'state')
  await mkdir(workspace, { mode: 0o700 }); await mkdir(stateRoot, { mode: 0o700 })
  const source = plan(); const bound = strategyBenchmarkJournalPlan(source); const variant = bound.variants[0]!
  const cell = benchmarkSchedule(bound).find(cell => cell.variantId === variant.id)!
  const controller = new AbortController(); let started!: () => void; let releaseDispose!: () => void; let aborted = false
  const ready = new Promise<void>(resolve => { started = resolve })
  const disposing = new Promise<void>(resolve => { releaseDispose = resolve })
  class BlockedAdapter extends LlmAdapter {
    override providerInfo(id: string) { return { id, name: id } }
    override async resolveModel(provider: string, id: string) { return { provider, id, name: id, inputModalities: ['text' as const] } }
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      started()
      await new Promise<void>(resolve => {
        const stop = () => { aborted = true; resolve() }
        if (options.signal?.aborted) stop(); else options.signal?.addEventListener('abort', stop, { once: true })
      })
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'fixture' } } }
    }
  }
  const runtime = await createStrategyGoalRuntime({ plan: source, request: { planId: bound.id, dataset: bound.dataset, cell, task: bound.cases[0]!, variant, budget: bound.budget, signal: controller.signal }, task,
    workspace, stateRoot, persona: '', model, factory: () => ({ adapter: new BlockedAdapter(), inputTokenUpperBound: () => 10, dispose: () => hangDispose ? disposing : undefined }),
    image: `sha256:${'0'.repeat(64)}`, dockerPath: '/usr/bin/docker', stepMaxDurationMs: 25000, stopTimeoutMs: 1000 })
  return { runtime, ready, controller, releaseDispose, wasAborted: () => aborted }
}

test('cancellation reaches the native adapter and keeps the uncompleted outer reservation', async () => {
  const f = await cancellableRuntime()
  cleanups.push(f.runtime.close)
  const execution = f.runtime.execute().then(() => null, error => error as Error)
  await f.ready; f.controller.abort()
  expect(await execution).toBeInstanceOf(Error)
  expect(f.wasAborted()).toBe(true)
  expect(f.runtime.snapshotMeter()).toMatchObject({ modelCalls: 0, heldModelCalls: 1, heldInputTokens: 10, heldOutputTokens: 128 })
  await expect(f.runtime.execute()).rejects.toThrow('only once')
})

test('a non-cooperative adapter disposer is bounded and never changes unknown stop into success', async () => {
  const f = await cancellableRuntime(true)
  const first = f.runtime.close()
  expect(f.runtime.close()).toBe(first)
  await expect(first).rejects.toThrow('stop is unknown')
  f.releaseDispose()
  await expect(f.runtime.close()).rejects.toThrow('stop is unknown')
  await expect(f.runtime.execute()).rejects.toThrow('only once')
})
