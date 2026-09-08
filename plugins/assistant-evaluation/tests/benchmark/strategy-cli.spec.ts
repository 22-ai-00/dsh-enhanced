import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { benchmarkCli } from '../../src/benchmark/cli.js'
import { BenchmarkStore } from '../../src/benchmark/store.js'
import { createStrategyBenchmarkPlan } from '../../src/benchmark/strategy-executor.js'
import { strategyBenchmarkJournalPlan } from '../../src/benchmark/strategy-plan.js'
import { strategyDevelopmentCases } from '../../src/benchmark/strategy-corpus.js'
import type { StrategyBenchmarkConfig } from '../../src/benchmark/strategy-config.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function workspace(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'strategy-cli-')); directories.push(path); return path }
const hash = (character: string) => character.repeat(64)
const configuration = (root: string, image = `sha256:${hash('c')}`): StrategyBenchmarkConfig => ({
  suite: 'strategy-v1', id: 'strategy-cli-development', cases: [strategyDevelopmentCases()[0]!.id], persona: 'Build the requested artifact.',
  model: { provider: 'fixture/provider', model: 'fixture-model', temperature: null, inputLimitMode: 'upper-bound', outputLimitMode: 'provider', maxOutputTokens: 64,
    inputUsdMicrosPerMillionTokens: null, outputUsdMicrosPerMillionTokens: null, adapterDigest: hash('a'), tokenCounterDigest: hash('b') },
  budget: { durationMs: 90_000, inputTokens: 2_000, outputTokens: 500, costUsdMicros: null, toolCalls: 20 }, execution: { modelCalls: 4, maxOutputTokensPerCall: 64, maxGoalRounds: 3 },
  repeats: 2, seed: 7, image, dockerPath: '/usr/bin/docker', stepMaxDurationMs: 20_000, stopTimeoutMs: 1_000,
  workspaceDirectory: join(root, 'workspaces'), stateDirectory: join(root, 'state'),
})
const capture = () => { const chunks: string[] = []; return { chunks, io: { stdout(text: string) { chunks.push(text) } } } }

describe('strategy-v1 benchmark CLI', () => {
  it('exports only public corpus fields', async () => {
    const output = capture()
    expect(await benchmarkCli(['corpus', '--suite', 'strategy-v1'], output.io)).toBe(0)
    const corpus = JSON.parse(output.chunks.join(''))
    expect(corpus.dataset.id).toBe('dsh-strategy-development')
    expect(corpus.tasks).toHaveLength(strategyDevelopmentCases().length)
    expect(corpus.tasks.every((task: Record<string, unknown>) => !('verification' in task) && !('acceptance' in task))).toBe(true)
    expect(output.chunks.join('')).not.toContain('expectedStdout')
  })

  it('freezes a strategy plan without loading an adapter and commits changed image configuration', async () => {
    const root = await workspace(); const first = join(root, 'first.json'); const second = join(root, 'second.json')
    await writeFile(first, JSON.stringify(configuration(root))); await writeFile(second, JSON.stringify(configuration(root, `sha256:${hash('d')}`)))
    const one = capture(); const two = capture()
    expect(await benchmarkCli(['plan', '--config', first], one.io)).toBe(0)
    expect(await benchmarkCli(['plan', '--config', second], two.io)).toBe(0)
    const left = JSON.parse(one.chunks.join('')); const right = JSON.parse(two.chunks.join(''))
    expect(left).toMatchObject({ plannedCells: 4, inputLimitMode: 'upper-bound', outputLimitMode: 'provider' })
    expect(left.planDigest).not.toBe(right.planDigest)
    expect(JSON.stringify(left.plan)).not.toContain('expectedStdout')
  })

  it('does not claim strategy readiness without a configuration or runnable isolation probe', async () => {
    const output = capture()
    expect(await benchmarkCli(['doctor', '--suite', 'strategy-v1'], output.io)).toBe(2)
    expect(JSON.parse(output.chunks.join(''))).toMatchObject({ ready: false, isolation: { ready: false } })
  })

  it('rejects a strategy report without the config needed to revalidate evidence', async () => {
    const root = await workspace(); const database = join(root, 'strategy.sqlite'); const plan = createStrategyBenchmarkPlan(configuration(root)); const store = new BenchmarkStore(database)
    try { store.create(strategyBenchmarkJournalPlan(plan)) } finally { store.close() }
    await expect(benchmarkCli(['report', '--database', database, '--plan', plan.benchmark.id], capture().io)).rejects.toThrow('strategy report requires --config')
  })
})
