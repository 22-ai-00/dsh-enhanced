import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { describe, expect, it } from 'vitest'
import { parseStrategyBenchmarkConfig, type StrategyBenchmarkConfig } from '../../src/benchmark/strategy-config.ts'
import { strategyDevelopmentCases, strategyDevelopmentCorpus, strategyDevelopmentDataset, strategyDevelopmentTask } from '../../src/benchmark/strategy-corpus.ts'
import { strategyGoalTaskDigests } from '../../src/benchmark/strategy-goal-runtime.ts'

const hash = (character: string) => character.repeat(64)
const fixture = (): StrategyBenchmarkConfig => ({
  suite: 'strategy-v1', id: 'strategy-public-development', cases: strategyDevelopmentCases().map(task => task.id), persona: 'Build the requested artifact.',
  model: { provider: 'fixture/provider', model: 'fixture-model', temperature: 0, inputLimitMode: 'upper-bound', outputLimitMode: 'provider', maxOutputTokens: 64,
    inputUsdMicrosPerMillionTokens: 1, outputUsdMicrosPerMillionTokens: 1, cacheReadUsdMicrosPerMillionTokens: 1, cacheWriteUsdMicrosPerMillionTokens: 1, adapterDigest: hash('a'), tokenCounterDigest: hash('b') },
  budget: { durationMs: 90_000, inputTokens: 2_000, outputTokens: 500, costUsdMicros: 100, toolCalls: 20 }, execution: { modelCalls: 4, maxOutputTokensPerCall: 64, maxGoalRounds: 3 },
  repeats: 2, seed: 7, image: `sha256:${hash('c')}`, dockerPath: '/usr/bin/docker', stepMaxDurationMs: 20_000, stopTimeoutMs: 1_000, workspaceDirectory: '/var/tmp/strategy-work', stateDirectory: '/var/tmp/strategy-state',
})

describe('strategy-v1 configuration', () => {
  it('accepts a fully bounded configuration without touching paths or adapters', () => {
    const input = fixture(); const parsed = parseStrategyBenchmarkConfig(input)
    expect(parsed).toEqual(input); expect(Object.isFrozen(parsed)).toBe(true)
  })
  it.each([
    (input: any) => { input.suite = 'memory-v1' },
    (input: any) => { input.cases = ['missing'] },
    (input: any) => { input.cases = [input.cases[0], input.cases[0]] },
    (input: any) => { input.model.inputLimitMode = 'estimate' },
    (input: any) => { input.model.outputLimitMode = 'observed' },
    (input: any) => { input.model.maxOutputTokens = 65 },
    (input: any) => { input.budget.costUsdMicros = 1; input.model.cacheReadUsdMicrosPerMillionTokens = null },
    (input: any) => { input.workspaceDirectory = 'relative' },
    (input: any) => { input.image = 'latest' },
  ])('rejects a config that cannot be enforced before execution', mutate => {
    const input = fixture(); mutate(input); expect(() => parseStrategyBenchmarkConfig(input)).toThrow()
  })
  it('rejects unknown properties and accessors before evaluating their value', () => {
    expect(() => parseStrategyBenchmarkConfig({ ...fixture(), extra: true })).toThrow('unexpected benchmark fields')
    const input = fixture(); let reads = 0
    Object.defineProperty(input, 'id', { enumerable: true, get: () => { reads++; return 'bad' } })
    expect(() => parseStrategyBenchmarkConfig(input)).toThrow('plain enumerable')
    expect(reads).toBe(0)
  })
})

describe('public strategy development corpus', () => {
  it('keeps verification vectors private while binding every public case to its complete task', () => {
    expect(strategyDevelopmentCorpus).toHaveLength(4)
    expect(strategyDevelopmentDataset).toEqual({ id: 'dsh-strategy-development', version: '1', split: 'development', digest: expect.any(String) })
    for (const task of strategyDevelopmentCorpus) {
      expect(Object.hasOwn(task, 'verification')).toBe(false)
      const complete = strategyDevelopmentTask(task.id); const digests = strategyGoalTaskDigests(complete)
      expect(strategyDevelopmentCases().find(item => item.id === task.id)).toMatchObject(digests)
      expect(task.publicPrompt).toContain(task.objective)
      expect(task.publicPrompt).not.toContain(complete.verification.cases[0]!.expectedStdout)
    }
  })
  it('has boundary vectors that distinguish touching ranges, lexical ties, cycles, and empty input behavior', () => {
    expect(strategyDevelopmentTask('merge-touching-intervals').verification.cases).toContainEqual(expect.objectContaining({ stdin: '1 1\n2 2\n4 4\n', expectedStdout: '1 2\n4 4\n' }))
    expect(strategyDevelopmentTask('word-frequency-lexical-ties').verification.cases).toContainEqual(expect.objectContaining({ stdin: 'z a z a\n', expectedStdout: 'a 2\nz 2\n' }))
    expect(strategyDevelopmentTask('dependency-topological-order').verification.cases).toContainEqual(expect.objectContaining({ expectedStdout: 'CYCLE\n' }))
    expect(strategyDevelopmentTask('integer-sum').verification.cases).toContainEqual(expect.objectContaining({ stdin: '', expectedStdout: '0\n' }))
    expect(strategyDevelopmentDataset.digest).toBe(acceptanceDigest(strategyDevelopmentCorpus.map(task => {
      const full = strategyDevelopmentTask(task.id)
      return { id: task.id, domain: task.domain, task: full, digests: strategyGoalTaskDigests(full) }
    })))
  })
})
