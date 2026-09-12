import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { DEEPSEEK_INPUT_TOKEN_UPPER_BOUND, DEEPSEEK_PROVIDER } from '@dsh-enhanced/assistant-deepseek-budget'
import { createNativeAdapter } from '../../src/benchmark/deepseek.js'
import { createStrategyBenchmarkExecutor, createStrategyBenchmarkPlan, verifyStrategyBenchmarkResults } from '../../src/benchmark/strategy-executor.js'
import { strategyBenchmarkJournalPlan } from '../../src/benchmark/strategy-plan.js'
import { strategyDevelopmentTask } from '../../src/benchmark/strategy-corpus.js'
import { StrategyEvidenceStore } from '../../src/benchmark/strategy-evidence.js'
import { BenchmarkStore } from '../../src/benchmark/store.js'
import { runBenchmark } from '../../src/benchmark/runner.js'
import type { StrategyBenchmarkConfig } from '../../src/benchmark/strategy-config.js'
import type { NativeAdapterFactory } from '../../src/benchmark/native.js'

const roots: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function config(): StrategyBenchmarkConfig {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'strategy-deepseek-runtime-')))
  roots.push(root)
  return {
    suite: 'strategy-v1', id: 'strategy-deepseek-runtime', cases: ['integer-sum'], persona: 'Solve the public task with the admitted Goal and isolated tools.',
    model: { provider: DEEPSEEK_PROVIDER, model: 'deepseek-v4-flash', temperature: null, inputLimitMode: 'upper-bound', outputLimitMode: 'provider', maxOutputTokens: 1024,
      inputUsdMicrosPerMillionTokens: null, outputUsdMicrosPerMillionTokens: null, adapterDigest: 'a'.repeat(64), tokenCounterDigest: 'b'.repeat(64) },
    execution: { modelCalls: 16, maxOutputTokensPerCall: 1024, maxGoalRounds: 3 },
    budget: { durationMs: 100000, inputTokens: 4_194_304, outputTokens: 8192, toolCalls: 16, costUsdMicros: null },
    repeats: 2, seed: 1, image: process.env.DSH_ISOLATION_TEST_IMAGE ?? `sha256:${'0'.repeat(64)}`, dockerPath: '/usr/bin/docker', stepMaxDurationMs: 25000, stopTimeoutMs: 1000,
    workspaceDirectory: join(root, 'workspaces'), stateDirectory: join(root, 'state'),
  }
}

type WireObservation = { endpoint: string; redirect: RequestInit['redirect']; model: unknown; maxTokens: unknown; thinking: unknown; reasoningEffort: unknown; cacheSafe: boolean; privateLeak: boolean; feedbackObserved: boolean; correctArtifact: boolean; childNoTools: boolean }
const task = strategyDevelopmentTask('integer-sum')

test.skipIf(!process.env.DSH_ISOLATION_TEST_IMAGE)('runs the real DeepSeek Goal route through paired cells without leaking verifier inputs', async () => {
  const input = config()
  const plan = createStrategyBenchmarkPlan(input)
  const journal = strategyBenchmarkJournalPlan(plan)
  const database = new BenchmarkStore(join(roots.at(-1)!, 'journal.sqlite'))
  const wires: WireObservation[] = []
  const workspaces = new Set<string>()
  let activeFixture: (() => { name?: string; args?: object; text?: string; correctArtifact?: boolean; child?: boolean }) | undefined
  let factories = 0
  let childCalls = 0

  vi.stubEnv('DEEPSEEK_API_KEY', 'test-only-key')
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model?: unknown; max_tokens?: unknown; thinking?: unknown; reasoning_effort?: unknown; messages?: unknown; tools?: unknown }
    const serialized = JSON.stringify(body.messages)
    const privateLeak = serialized.includes('expectedStdout') || serialized.includes('expectedExitCode') || serialized.includes('-5\\n10\\n-3')
    const fixture = activeFixture?.()
    if (!fixture) throw new Error('DeepSeek fixture dispatched outside a native Goal request')
    const feedbackObserved = serialized.includes('isolated-unexpected-stdout')
    if (fixture.correctArtifact) expect(feedbackObserved).toBe(true)
    wires.push({ endpoint: String(url), redirect: init?.redirect, model: body.model, maxTokens: body.max_tokens, thinking: body.thinking, reasoningEffort: body.reasoning_effort,
      cacheSafe: !serialized.includes('DEEPSEEK_API_KEY'), privateLeak, feedbackObserved, correctArtifact: fixture.correctArtifact === true,
      childNoTools: fixture.child === true && (body.tools === undefined || Array.isArray(body.tools) && body.tools.length === 0) })
    expect(String(url)).toBe('https://api.deepseek.com/chat/completions')
    expect(init?.redirect).toBe('error')
    expect(body).toMatchObject({ model: 'deepseek-v4-flash', stream: false, max_tokens: 1024, thinking: { type: 'enabled' }, reasoning_effort: 'high' })
    expect(privateLeak).toBe(false)
    const message: Record<string, unknown> = { role: 'assistant', content: fixture.name === undefined ? (fixture.text ?? 'Continue from independent feedback.') : null, reasoning_content: 'Continue the current task.' }
    if (fixture.name !== undefined) message.tool_calls = [{ id: `deepseek-fixture-${wires.length}`, type: 'function', function: { name: fixture.name, arguments: JSON.stringify(fixture.args ?? {}) } }]
    return new Response(JSON.stringify({ id: `deepseek-response-${wires.length}`, object: 'chat.completion', model: 'deepseek-v4-flash',
      choices: [{ index: 0, message, finish_reason: fixture.name === undefined ? 'stop' : 'tool_calls' }],
      usage: { prompt_tokens: 12, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 9, completion_tokens: 8, total_tokens: 20, completion_tokens_details: { reasoning_tokens: 2 } },
    }), { headers: { 'content-type': 'application/json' } })
  }))

  const factory: NativeAdapterFactory = (model, { ctx, workspace }) => {
    factories++
    workspaces.add(workspace)
    let compared = false
    const written = new Set<number>()
    let currentTools: readonly { name: string }[] | undefined
    // This wrapper only observes the real request so the provider fixture can
    // choose its deterministic response from the live Goal state.
    ctx.on('llm/stream', async function* (options, next) {
      currentTools = options.tools
      yield* next()
    })
    activeFixture = () => {
      const agent = ctx.agents.currentInitiator()!
      const goal = (ctx.get('goals' as never) as unknown as { get(agent: unknown): { roundsStarted: number } | undefined }).get(agent)
      if (agent.session.header.origin === 'subagent') {
        childCalls++
        return { child: true }
      }
      if (!goal) return { name: 'goal_create', args: { objective: task.objective, max_goal_rounds: 3 } }
      if (goal.roundsStarted > 0 && !compared && currentTools?.some(tool => tool.name === 'goal_strategy')) {
        compared = true
        return { name: 'goal_strategy', args: { kind: 'compare', question: 'Compare two implementations of the public task.' } }
      }
      if (goal.roundsStarted > 0 && !written.has(goal.roundsStarted)) {
        written.add(goal.roundsStarted)
        return { name: 'isolation_run', args: { grant_id: 'benchmark-work', idempotency_key: `artifact-${goal.roundsStarted}`, command: 'cp source answer.sh',
          files: [{ path: 'source', content: goal.roundsStarted === 1 ? 'printf wrong' : "awk '{for(i=1;i<=NF;i++) s+=$i} END {print s+0}'" }], artifacts: ['answer.sh'], timeout_ms: 15000 },
          ...(goal.roundsStarted === 1 ? {} : { correctArtifact: true }) }
      }
      return {}
    }
    return createNativeAdapter(model, { ctx, workspace })
  }

  try {
    const executor = createStrategyBenchmarkExecutor({ ...input, plan, tasks: { 'integer-sum': task }, factory })
    const results = await runBenchmark(database, journal, executor)
    const archive = process.env.DSH_STRATEGY_DEEPSEEK_EVIDENCE_ROOT
    if (archive) {
      mkdirSync(archive, { recursive: true, mode: 0o700 })
      const destination = join(archive, basename(roots.at(-1)!))
      cpSync(roots.at(-1)!, destination, { recursive: true, errorOnExist: true, force: false })
      writeFileSync(join(destination, 'results.json'), JSON.stringify(results, null, 2), { mode: 0o600 })
      writeFileSync(join(destination, 'deepseek-wire.json'), JSON.stringify(wires, null, 2), { mode: 0o600 })
    }

    expect(results).toHaveLength(4)
    expect(results.map(({ status, verdict }) => ({ status, verdict }))).toEqual(Array.from({ length: 4 }, () => ({ status: 'completed', verdict: 'achieved' })))
    expect(factories).toBe(4)
    expect(workspaces.size).toBe(4)
    expect(childCalls).toBe(4)
    expect(wires).toHaveLength(30)
    expect(wires.every(wire => wire.endpoint === 'https://api.deepseek.com/chat/completions' && wire.redirect === 'error' && wire.model === 'deepseek-v4-flash'
      && wire.maxTokens === 1024 && JSON.stringify(wire.thinking) === JSON.stringify({ type: 'enabled' }) && wire.reasoningEffort === 'high' && wire.cacheSafe && !wire.privateLeak)).toBe(true)
    expect(wires.filter(wire => wire.correctArtifact && wire.feedbackObserved)).toHaveLength(4)
    expect(wires.filter(wire => wire.childNoTools)).toHaveLength(4)
    verifyStrategyBenchmarkResults(plan, results, input.stateDirectory, input.workspaceDirectory)

    const evidence = new StrategyEvidenceStore({ stateDirectory: input.stateDirectory, candidateWorkspace: input.workspaceDirectory })
    for (const result of results) {
      const cell = evidence.readCell(plan, result.cell, result.evidenceDigest!)
      const native = evidence.read(plan, result.cell, cell.nativeEvidenceDigest)
      expect(native.native.receipts).toHaveLength(4)
      expect(native.meter.modelCalls).toBe(result.cell.variantId === 'direct' ? 6 : 9)
      expect(native.meter.traces).toHaveLength(native.meter.modelCalls)
      expect(native.meter.traces).toEqual(expect.arrayContaining([expect.objectContaining({ reservedInputTokens: DEEPSEEK_INPUT_TOKEN_UPPER_BOUND,
        usage: expect.objectContaining({ inputTokens: 12, uncachedInputTokens: 9, cacheReadTokens: 3, cacheWriteTokens: 0, outputTokens: 8, reasoningTokens: 2, totalTokens: 20 }) })]))
      expect(native.meter.inputTokens).toBe(native.meter.modelCalls * 12)
      expect(native.meter.outputTokens).toBe(native.meter.modelCalls * 8)
      const sources = cell.capabilities.sourceIdentity as Record<'common.runtime', readonly { packageName: string }[]>
      const runtimeSources = sources['common.runtime']
      expect(runtimeSources).toBeDefined()
      const runtimePackages = runtimeSources!.map(source => source.packageName)
      expect(runtimePackages).toContain('@dsh-enhanced/assistant-deepseek-budget')
      expect(runtimePackages).toContain('@deepseek-ai/dsh-credentials')
      expect(cell.capabilities.requests).toHaveLength(native.meter.modelCalls)
    }
    await runBenchmark(database, journal, executor)
    expect(wires).toHaveLength(30)
  } finally {
    database.close()
  }
}, 240000)
