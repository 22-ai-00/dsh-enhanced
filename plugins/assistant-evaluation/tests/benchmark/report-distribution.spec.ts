import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { benchmarkReport } from '../../src/benchmark/report.ts'
import { benchmarkSchedule } from '../../src/benchmark/schema.ts'
import type { BenchmarkPlan, BenchmarkResult } from '../../src/benchmark/types.ts'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const versions = () => ({ model: digest('a'), prompt: digest('b'), skills: digest('c'), tools: digest('d'), policy: digest('e'), runtime: digest('f') })
const features = () => ({ memory: false, planning: false, review: false, growth: false })
const plan: BenchmarkPlan = {
  schemaVersion: 1, id: 'distribution-plan',
  dataset: { id: 'suite', version: '1', digest: digest('dataset'), split: 'development' },
  comparison: 'capability',
  cases: [
    { id: 'case-b', domain: 'research', inputDigest: digest('input-b'), acceptanceDigest: digest('accept-b') },
    { id: 'case-a', domain: 'code', inputDigest: digest('input-a'), acceptanceDigest: digest('accept-a') },
  ],
  variants: [
    { id: 'baseline', role: 'baseline', versions: versions(), features: features() },
    { id: 'candidate', role: 'candidate', versions: versions(), features: features() },
  ],
  budget: { durationMs: 1_000, inputTokens: 1_000, outputTokens: 1_000, costUsdMicros: 1_000, toolCalls: 10 },
  repeats: 2, seed: 7,
}
const result = (caseId: string, variantId: string, repeat: number, verdict: 'achieved' | 'not-achieved' | 'unknown', latencyMs: number): BenchmarkResult => ({
  cell: benchmarkSchedule(plan).find(cell => cell.caseId === caseId && cell.variantId === variantId && cell.repeat === repeat)!,
  // A completed cell may still carry an unknown verdict (judge could not decide) with full measurements.
  status: 'completed', verdict, evidenceDigest: digest('e'), reason: 'verified', startedAt: 10, completedAt: 20,
  metrics: { inputTokens: 1, outputTokens: 1, costUsdMicros: 0, toolCalls: 0, rework: null, interventions: null, latencyMs },
})

describe('benchmarkReport distribution fields', () => {
  const results = [
    result('case-a', 'baseline', 0, 'achieved', 10), result('case-a', 'baseline', 1, 'not-achieved', 20),
    result('case-b', 'baseline', 0, 'not-achieved', 30), result('case-b', 'baseline', 1, 'not-achieved', 40),
    result('case-a', 'candidate', 0, 'achieved', 5), result('case-a', 'candidate', 1, 'achieved', 15),
    result('case-b', 'candidate', 0, 'achieved', 25),
  ]
  const report = benchmarkReport(plan, results)
  const baseline = report.variants.find(item => item.id === 'baseline')!
  const candidate = report.variants.find(item => item.id === 'candidate')!

  it('reports min/p10/p90/max alongside the mean, with nulls for unmeasured metrics', () => {
    expect(report.distributionVersion).toBe(1)
    expect(baseline.metrics.latencyMs).toEqual({ measured: 4, missing: 0, mean: 25, median: 25, p95: 40, min: 10, p10: 10, p90: 40, max: 40 })
    expect(candidate.metrics.latencyMs).toMatchObject({ measured: 3, missing: 1, min: 5, max: 25, median: 15 })
    expect(baseline.metrics.rework).toEqual({ measured: 0, missing: 4, mean: null, median: null, p95: null, min: null, p10: null, p90: null, max: null })
  })

  it('splits outcomes by domain in canonical order and summarizes per-task repeat agreement', () => {
    expect(baseline.byDomain).toEqual([
      { domain: 'code', tasks: 1, expected: 2, achieved: 1, notAchieved: 1, unknown: 0, successRate: 0.5 },
      { domain: 'research', tasks: 1, expected: 2, achieved: 0, notAchieved: 2, unknown: 0, successRate: 0 },
    ])
    expect(baseline.taskSuccess).toEqual({ tasks: 2, summarized: 2, allAchieved: 0, noneAchieved: 1, mixed: 1, min: 0, median: 0.25, max: 0.5 })
    // case-b has an unrecorded repeat, so it is not summarized rather than counted as a failure.
    expect(candidate.taskSuccess).toEqual({ tasks: 2, summarized: 1, allAchieved: 1, noneAchieved: 0, mixed: 0, min: 1, median: 1, max: 1 })
  })

  it('reports per-domain paired outcomes and paired metric deltas over measured pairs only', () => {
    const comparison = report.comparisons[0]!
    expect(comparison.byDomain.map(item => item.domain)).toEqual(['code', 'research'])
    expect(comparison.byDomain[0]).toMatchObject({ wins: 1, losses: 0, ties: 1 })
    expect(comparison.byDomain[1]).toMatchObject({ wins: 1, losses: 0 })
    expect(comparison.metricDeltas.latencyMs).toEqual({ pairs: 3, unknownVerdictPairs: 0, missing: 1, mean: -5, p10: -5, median: -5, p90: -5 })
    expect(comparison.metricDeltas.rework).toEqual({ pairs: 0, unknownVerdictPairs: 0, missing: 4, mean: null, p10: null, median: null, p90: null })
    expect(report.promotionAuthorized).toBe(false)
  })

  it('keeps measured unknown-verdict pairs out of metric deltas and counts them separately', () => {
    // The last candidate cell completed with full measurements but an unknown verdict.
    const report = benchmarkReport(plan, [...results, result('case-b', 'candidate', 1, 'unknown', 1_000)])
    const comparison = report.comparisons[0]!
    expect(comparison.unknownPairs).toBe(1)
    expect(comparison.metricDeltas.latencyMs).toEqual({ pairs: 3, unknownVerdictPairs: 1, missing: 0, mean: -5, p10: -5, median: -5, p90: -5 })
    expect(comparison.metricDeltas.rework).toEqual({ pairs: 0, unknownVerdictPairs: 1, missing: 3, mean: null, p10: null, median: null, p90: null })
  })

  it('handles single-value and empty samples without inventing quantiles', () => {
    const single = benchmarkReport(plan, [result('case-a', 'baseline', 0, 'achieved', 7)])
    expect(single.variants[0]!.metrics.latencyMs).toEqual({ measured: 1, missing: 3, mean: 7, median: 7, p95: 7, min: 7, p10: 7, p90: 7, max: 7 })
    expect(single.variants[1]!.taskSuccess).toEqual({ tasks: 2, summarized: 0, allAchieved: 0, noneAchieved: 0, mixed: 0, min: null, median: null, max: null })
    expect(single.comparisons[0]!.metricDeltas.latencyMs).toEqual({ pairs: 0, unknownVerdictPairs: 0, missing: 4, mean: null, p10: null, median: null, p90: null })
  })
})
