import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseStrategyBenchmarkConfig, type StrategyBenchmarkConfig } from '../../src/benchmark/strategy-config.ts'
import { strategyDevelopmentDataset } from '../../src/benchmark/strategy-corpus.ts'
import {
  isStrategySuite, strategyCasesForSuite, strategyCorpusForSuite, strategyDatasetForSuite,
  strategyTaskForSuite, strategyV2Cases, strategyV2Corpus, strategyV2Dataset, strategyV2Task,
} from '../../src/benchmark/strategy-corpus-v2.ts'
import { strategyGoalTaskDigests } from '../../src/benchmark/strategy-goal-runtime.ts'
import { benchmarkCli } from '../../src/benchmark/cli.js'
import { BenchmarkStore } from '../../src/benchmark/store.js'
import { createStrategyBenchmarkPlan } from '../../src/benchmark/strategy-executor.js'
import { strategyBenchmarkJournalPlan } from '../../src/benchmark/strategy-plan.js'

const hash = (character: string) => character.repeat(64)

// Adding the v2 corpus must not change a single byte of the v1 dataset identity.
const V1_DATASET_DIGEST = 'b9e5dc4dfe34f1c5446ce7eac3b8adff7b983c0b04238cc3b9dd3eeca6a3d780'
const V2_CASE_IDS = ['session-gap-split', 'closed-range-intersection', 'greedy-paragraph-wrap', 'quoted-csv-account-totals']

const v2Fixture = (): StrategyBenchmarkConfig => ({
  suite: 'strategy-v2', id: 'strategy-v2-development', cases: strategyV2Cases().map(task => task.id), persona: 'Build the requested artifact.',
  model: { provider: 'fixture/provider', model: 'fixture-model', temperature: 0, inputLimitMode: 'upper-bound', outputLimitMode: 'provider', maxOutputTokens: 64,
    inputUsdMicrosPerMillionTokens: 1, outputUsdMicrosPerMillionTokens: 1, cacheReadUsdMicrosPerMillionTokens: 1, cacheWriteUsdMicrosPerMillionTokens: 1, adapterDigest: hash('a'), tokenCounterDigest: hash('b') },
  budget: { durationMs: 150_000, inputTokens: 2_000, outputTokens: 500, costUsdMicros: 100, toolCalls: 20 }, execution: { modelCalls: 4, maxOutputTokensPerCall: 64, maxGoalRounds: 3 },
  repeats: 2, seed: 7, image: `sha256:${hash('c')}`, dockerPath: '/usr/bin/docker', stepMaxDurationMs: 45_000, stopTimeoutMs: 1_000, workspaceDirectory: '/var/tmp/strategy-v2-work', stateDirectory: '/var/tmp/strategy-v2-state',
})

describe('strategy-v2 corpus', () => {
  it('leaves the v1 dataset digest byte-identical', () => {
    expect(strategyDevelopmentDataset).toEqual({ id: 'dsh-strategy-development', version: '1', split: 'development', digest: V1_DATASET_DIGEST })
  })

  it('publishes an independent dataset whose digest commits to all four private tasks', () => {
    expect(strategyV2Dataset).toEqual({ id: 'dsh-strategy-development-v2', version: '1', split: 'development', digest: expect.any(String) })
    expect(strategyV2Dataset.digest).not.toBe(V1_DATASET_DIGEST)
    expect(strategyV2Dataset.digest).toBe(acceptanceDigest(strategyV2Corpus.map(task => {
      const full = strategyV2Task(task.id)
      return { id: task.id, domain: task.domain, task: full, digests: strategyGoalTaskDigests(full) }
    })))
  })

  it('exposes the four harder cases, each with eight private vectors and one public example', () => {
    expect(strategyV2Corpus.map(task => task.id)).toEqual(V2_CASE_IDS)
    expect(strategyV2Cases().map(task => task.id)).toEqual(V2_CASE_IDS)
    for (const id of V2_CASE_IDS) {
      const publicTask = strategyV2Corpus.find(task => task.id === id)!
      expect(Object.hasOwn(publicTask, 'verification')).toBe(false)
      expect(publicTask.examples).toHaveLength(1)
      const full = strategyV2Task(id)
      expect(full.verification.cases).toHaveLength(8)
      expect(strategyV2Cases().find(item => item.id === id)).toMatchObject(strategyGoalTaskDigests(full))
      // Every non-trivial private expectation stays out of the model-visible prompt.
      const secret = full.verification.cases.map(vector => vector.expectedStdout).find(text => text !== '')!
      expect(publicTask.publicPrompt).not.toContain(secret)
      expect(publicTask.publicPrompt).toContain(publicTask.objective)
    }
  })

  it('anchors the distinguishing boundary semantics in private vectors', () => {
    expect(strategyV2Task('session-gap-split').verification.cases).toContainEqual(expect.objectContaining({ stdin: '09:00:00\n09:05:01\n', expectedStdout: '09:00:00-09:00:00 1\n09:05:01-09:05:01 1\n' }))
    expect(strategyV2Task('session-gap-split').verification.cases).toContainEqual(expect.objectContaining({ stdin: '23:58:00\n00:02:00\n', expectedStdout: '23:58:00-00:02:00 2\n' }))
    expect(strategyV2Task('closed-range-intersection').verification.cases).toContainEqual(expect.objectContaining({ stdin: 'alpha 5 5\nalpha 5 10\n', expectedStdout: 'alpha 5 5\n' }))
    expect(strategyV2Task('closed-range-intersection').verification.cases).toContainEqual(expect.objectContaining({ stdin: 'zeta 1 2\ndelta 10 0\n', expectedStdout: 'NONE\n' }))
    expect(strategyV2Task('greedy-paragraph-wrap').verification.cases).toContainEqual(expect.objectContaining({ stdin: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx y\n', expectedStdout: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\ny\n' }))
    expect(strategyV2Task('quoted-csv-account-totals').verification.cases).toContainEqual(expect.objectContaining({ stdin: expect.stringContaining('"a""b"'), expectedStdout: 'US\ta"b\t12\n' }))
  })

  it('routes every suite-scoped resolver correctly and type-guards the suite union', () => {
    expect(isStrategySuite('strategy-v1')).toBe(true); expect(isStrategySuite('strategy-v2')).toBe(true); expect(isStrategySuite('memory-v1')).toBe(false)
    expect(strategyCorpusForSuite('strategy-v1')).toHaveLength(4); expect(strategyCorpusForSuite('strategy-v2')).toBe(strategyV2Corpus)
    expect(strategyDatasetForSuite('strategy-v1')).toBe(strategyDevelopmentDataset); expect(strategyDatasetForSuite('strategy-v2')).toBe(strategyV2Dataset)
    expect(strategyCasesForSuite('strategy-v2').map(task => task.id)).toEqual(V2_CASE_IDS)
    expect(strategyTaskForSuite('strategy-v2', 'session-gap-split').verification.command).toBe('sh artifact < input')
    expect(() => strategyTaskForSuite('strategy-v2', 'integer-sum')).toThrow('unknown strategy-v2 case')
  })
})

describe('strategy-v2 configuration', () => {
  it('accepts the v2 suite once the eight-vector verification window fits the step budget', () => {
    const parsed = parseStrategyBenchmarkConfig(v2Fixture())
    expect(parsed.suite).toBe('strategy-v2'); expect(Object.isFrozen(parsed)).toBe(true)
  })

  it.each([
    (input: any) => { input.suite = 'memory-v1' },
    (input: any) => { input.cases = ['integer-sum'] },
    (input: any) => { input.cases = ['session-gap-split', 'session-gap-split'] },
    (input: any) => { input.stepMaxDurationMs = 40_000 },
  ])('rejects a v2 config that cannot be enforced', mutate => {
    const input = v2Fixture(); mutate(input); expect(() => parseStrategyBenchmarkConfig(input)).toThrow()
  })

  it('never accepts a v2 case under the v1 suite', () => {
    const input = v2Fixture(); input.suite = 'strategy-v1'
    expect(() => parseStrategyBenchmarkConfig(input)).toThrow('cases must be unique strategy development cases')
  })
})

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function workspaceDir(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'strategy-v2-cli-')); directories.push(path); return path }
const capture = () => { const chunks: string[] = []; return { chunks, io: { stdout(text: string) { chunks.push(text) } } } }
const fileConfig = (root: string, config: StrategyBenchmarkConfig) => ({ ...config, workspaceDirectory: join(root, 'workspaces'), stateDirectory: join(root, 'state') })

describe('strategy-v2 benchmark CLI', () => {
  it('exports only the v2 public corpus', async () => {
    const output = capture()
    expect(await benchmarkCli(['corpus', '--suite', 'strategy-v2'], output.io)).toBe(0)
    const corpus = JSON.parse(output.chunks.join(''))
    expect(corpus.dataset.id).toBe('dsh-strategy-development-v2')
    expect(corpus.tasks).toHaveLength(4)
    expect(corpus.tasks.every((task: Record<string, unknown>) => !('verification' in task))).toBe(true)
    expect(output.chunks.join('')).not.toContain('expectedStdout')
  })

  it('freezes a v2 plan with an independent digest and the full 16-cell schedule', async () => {
    const root = await workspaceDir(); const path = join(root, 'config.json')
    await writeFile(path, JSON.stringify(fileConfig(root, v2Fixture())))
    const v2 = capture()
    expect(await benchmarkCli(['plan', '--config', path], v2.io)).toBe(0)
    const planned = JSON.parse(v2.chunks.join(''))
    expect(planned.plannedCells).toBe(16)
    expect(planned.plan.benchmark.dataset.id).toBe('dsh-strategy-development-v2')

    const v1Root = await workspaceDir(); const v1Path = join(v1Root, 'config.json')
    const v1Config: StrategyBenchmarkConfig = { ...v2Fixture(), suite: 'strategy-v1', id: 'strategy-v1-cli', stepMaxDurationMs: 20_000, workspaceDirectory: join(v1Root, 'w'), stateDirectory: join(v1Root, 's') }
    v1Config.cases = ['integer-sum']
    await writeFile(v1Path, JSON.stringify(v1Config))
    const v1 = capture()
    expect(await benchmarkCli(['plan', '--config', v1Path], v1.io)).toBe(0)
    expect(planned.planDigest).not.toBe(JSON.parse(v1.chunks.join('')).planDigest)
  })

  it('treats v2 doctor like v1 and never claims readiness without a config', async () => {
    const output = capture()
    expect(await benchmarkCli(['doctor', '--suite', 'strategy-v2'], output.io)).toBe(2)
    expect(JSON.parse(output.chunks.join(''))).toMatchObject({ ready: false, isolation: { ready: false } })
  })

  it('routes a stored v2 plan through strategy evidence revalidation when reporting', async () => {
    const root = await workspaceDir(); const config = fileConfig(root, v2Fixture())
    const database = join(root, 'strategy-v2.sqlite')
    const plan = createStrategyBenchmarkPlan(config)
    expect(plan.benchmark.dataset.id).toBe('dsh-strategy-development-v2')
    const store = new BenchmarkStore(database)
    try { store.create(strategyBenchmarkJournalPlan(plan)) } finally { store.close() }
    // Without the v2 dataset-id branch this would silently take the plain native report path.
    await expect(benchmarkCli(['report', '--database', database, '--plan', plan.benchmark.id], capture().io)).rejects.toThrow('strategy report requires --config')
  })
})
