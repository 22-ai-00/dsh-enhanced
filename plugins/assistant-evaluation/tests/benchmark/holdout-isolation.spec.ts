import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { developmentCases, developmentDataset } from '../../src/benchmark/corpus.ts'
import { familiesDevelopmentCases } from '../../src/benchmark/families-corpus.ts'
import {
  assertCandidateGenerationInput, assertHoldoutIsolation, holdoutIsolationOverlaps, publicDevelopmentManifests,
} from '../../src/benchmark/holdout-isolation.ts'
import { runBenchmark } from '../../src/benchmark/runner.ts'
import { BenchmarkStore } from '../../src/benchmark/store.ts'
import type { BenchmarkCase, BenchmarkPlan } from '../../src/benchmark/types.ts'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const versions = () => ({ model: digest('a'), prompt: digest('b'), skills: digest('c'), tools: digest('d'), policy: digest('e'), runtime: digest('f') })
const features = () => ({ memory: false, planning: false, review: false, growth: false })
const privateCase: BenchmarkCase = { id: 'private-1', domain: 'code', inputDigest: digest('private-input'), acceptanceDigest: digest('private-accept') }
const plan = (overrides: Partial<BenchmarkPlan> = {}, cases: readonly BenchmarkCase[] = [privateCase]): BenchmarkPlan => ({
  schemaVersion: 1, id: 'holdout-plan',
  dataset: { id: 'private-holdout', version: '1', digest: digest('private-dataset'), split: 'holdout' },
  comparison: 'capability', cases,
  variants: [
    { id: 'baseline', role: 'baseline', versions: versions(), features: features() },
    { id: 'candidate', role: 'candidate', versions: versions(), features: features() },
  ],
  budget: { durationMs: 1_000, inputTokens: 1_000, outputTokens: 1_000, costUsdMicros: null, toolCalls: 0 },
  repeats: 2, seed: 3, ...overrides,
})

describe('holdout isolation', () => {
  it('lists the lightweight public development manifests', () => {
    expect(publicDevelopmentManifests().map(item => item.suite)).toEqual(['research-v1', 'families-v1', 'memory-v1', 'memory-v2'])
    for (const manifest of publicDevelopmentManifests()) expect(manifest.dataset.split).toBe('development')
  })

  it('accepts a disjoint holdout plan', () => {
    expect(holdoutIsolationOverlaps(plan())).toEqual([])
    expect(() => assertHoldoutIsolation(plan())).not.toThrow()
  })

  it('detects every overlap kind without exposing private input', () => {
    const research = developmentCases()[0]!; const families = familiesDevelopmentCases()[0]!
    const overlaps = holdoutIsolationOverlaps(plan({ dataset: { ...developmentDataset, split: 'holdout' } }, [
      { ...privateCase, id: research.id },
      { ...privateCase, id: 'private-2', inputDigest: families.inputDigest },
      { ...privateCase, id: 'private-3', inputDigest: digest('x'), acceptanceDigest: research.acceptanceDigest },
    ]))
    expect(overlaps).toEqual([
      { suite: 'research-v1', kind: 'dataset-id', holdoutRef: developmentDataset.id },
      { suite: 'research-v1', kind: 'dataset-digest', holdoutRef: developmentDataset.id },
      { suite: 'research-v1', kind: 'case-id', holdoutRef: research.id },
      { suite: 'research-v1', kind: 'acceptance-digest', holdoutRef: 'private-3' },
      { suite: 'families-v1', kind: 'input-digest', holdoutRef: 'private-2' },
    ])
    expect(() => assertHoldoutIsolation(plan({}, [{ ...privateCase, inputDigest: families.inputDigest }])))
      .toThrow('holdout overlaps public development data (families-v1:input-digest)')
  })

  it('checks caller-supplied manifests such as strategy suites', () => {
    const extra = [{ suite: 'strategy-x', dataset: { id: 'strategy-x', version: '1', digest: digest('sx'), split: 'development' as const }, cases: [privateCase] }]
    expect(() => assertHoldoutIsolation(plan(), extra)).toThrow('strategy-x:acceptance-digest, strategy-x:case-id, strategy-x:input-digest')
    expect(() => holdoutIsolationOverlaps(plan(), [{ ...extra[0]!, dataset: { ...extra[0]!.dataset, split: 'holdout' } }])).toThrow('public manifest must be a development split')
  })

  it('enforces isolation at the shared runBenchmark entry before any plan or cell is recorded', async () => {
    const research = developmentCases()[0]!
    const leaked = plan({ id: 'leaked-holdout' }, [{ ...privateCase, inputDigest: research.inputDigest }])
    const store = new BenchmarkStore(':memory:'); let executed = 0
    try {
      await expect(runBenchmark(store, leaked, { async execute() { executed++; throw new Error('must not run') } }))
        .rejects.toThrow('holdout overlaps public development data (research-v1:input-digest)')
      expect(executed).toBe(0)
      expect(() => store.plan('leaked-holdout')).toThrow()
    } finally { store.close() }
  })

  it('rejects non-holdout plans for isolation and holdout plans for candidate generation', () => {
    const development = plan({ dataset: { id: 'private-dev', version: '1', digest: digest('dev'), split: 'development' } })
    expect(() => assertHoldoutIsolation(development)).toThrow('holdout isolation requires a holdout dataset')
    expect(() => assertCandidateGenerationInput(plan())).toThrow('holdout data must never be used for candidate generation')
    expect(assertCandidateGenerationInput(development).dataset.split).toBe('development')
  })
})
