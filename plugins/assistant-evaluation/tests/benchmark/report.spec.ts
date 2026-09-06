import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { benchmarkReport } from '../../src/benchmark/report.ts'
import { benchmarkSchedule } from '../../src/benchmark/schema.ts'
import type { BenchmarkPlan, BenchmarkResult } from '../../src/benchmark/types.ts'

const plan = (overrides: Partial<BenchmarkPlan> = {}): BenchmarkPlan => ({
  schemaVersion: 1,
  id: 'plan-1',
  dataset: { id: 'suite', version: '1', digest: digest('dataset'), split: 'development' },
  comparison: 'capability',
  cases: [{ id: 'case-a', domain: 'code', inputDigest: digest('input-a'), acceptanceDigest: digest('accept-a') }],
  variants: [
    { id: 'baseline', role: 'baseline', versions: versions(), features: features() },
    { id: 'candidate', role: 'candidate', versions: versions(), features: features() },
  ],
  budget: { durationMs: 1_000, inputTokens: 1_000, outputTokens: 1_000, costUsdMicros: 1_000, toolCalls: 10 },
  repeats: 2,
  seed: 41,
  ...overrides,
})

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const versions = () => ({ model: digest('a'), prompt: digest('b'), skills: digest('c'), tools: digest('d'), policy: digest('e'), runtime: digest('f') })
const features = () => ({ memory: false, planning: false, review: false, growth: false })
const metrics = (overrides: Partial<BenchmarkResult['metrics']> = {}) => ({
  inputTokens: 0, outputTokens: 0, costUsdMicros: 0, toolCalls: 0, rework: null, interventions: null, latencyMs: 0, ...overrides,
})
const result = (inputPlan: BenchmarkPlan, caseId: string, variantId: string, repeat: number, overrides: Partial<BenchmarkResult> = {}): BenchmarkResult => ({
  cell: benchmarkSchedule(inputPlan).find((cell) => cell.caseId === caseId && cell.variantId === variantId && cell.repeat === repeat)!,
  status: 'completed', verdict: 'achieved', metrics: metrics(), evidenceDigest: digest('e'), reason: 'verified', startedAt: 10, completedAt: 20,
  ...overrides,
})

describe('benchmarkReport', () => {
  it('counts absent planned cells as unknown and retains metric absence separately from zero', () => {
    const input = plan()
    const before = structuredClone(input)
    const report = benchmarkReport(input, [result(input, 'case-a', 'baseline', 0)])

    expect(report.expectedCells).toBe(4)
    expect(report.recordedCells).toBe(1)
    expect(report.complete).toBe(false)
    expect(report.variants.find((variant) => variant.id === 'baseline')).toMatchObject({
      expected: 2, recorded: 1, achieved: 1, notAchieved: 0, unknown: 1, successRate: 0.5,
    })
    expect(report.variants.find((variant) => variant.id === 'baseline')?.metrics.inputTokens).toMatchObject({ measured: 1, missing: 1, mean: 0, median: 0, p95: 0 })
    expect(report.variants.find((variant) => variant.id === 'baseline')?.metrics.rework).toMatchObject({ measured: 0, missing: 2, mean: null, median: null, p95: null })
    expect(report.variants.find((variant) => variant.id === 'candidate')).toMatchObject({ expected: 2, recorded: 0, achieved: 0, notAchieved: 0, unknown: 2, successRate: 0, successInterval95: null })
    expect(input).toEqual(before)
  })

  it('rejects duplicate and non-scheduled result cells', () => {
    const input = plan()
    const baseline = result(input, 'case-a', 'baseline', 0)
    expect(() => benchmarkReport(input, [baseline, baseline])).toThrow(/duplicate/i)
    expect(() => benchmarkReport(input, [{ ...baseline, cell: { ...baseline.cell, variantId: 'elsewhere' } }])).toThrow(/match|scheduled|member/i)
  })

  it('uses nearest-rank p95 and withholds task intervals for incomplete reports', () => {
    const input = plan({ repeats: 4 })
    const results = [0, 1, 2, 3].map((repeat, index) => result(input, 'case-a', 'baseline', repeat, { verdict: index === 0 ? 'achieved' : 'not-achieved', metrics: metrics({ latencyMs: ([1, 2, 3, 100] as const).at(index)! }) }))
    const report = benchmarkReport(input, results)
    const baseline = report.variants.find((variant) => variant.id === 'baseline')!
    expect(baseline.successRate).toBe(0.25)
    expect(baseline.successInterval95).toBeNull()
    expect(baseline.metrics.latencyMs).toMatchObject({ measured: 4, missing: 0, mean: 26.5, median: 2.5, p95: 100 })
  })

  it('keeps unknown pair outcomes separate and refuses to infer a gain over an unknown baseline', () => {
    const input = plan()
    const report = benchmarkReport(input, [
      result(input, 'case-a', 'baseline', 0, { verdict: 'not-achieved' }),
      result(input, 'case-a', 'candidate', 0, { verdict: 'achieved' }),
      result(input, 'case-a', 'baseline', 1, { status: 'unknown', verdict: 'unknown', evidenceDigest: null, reason: 'interrupted' }),
      result(input, 'case-a', 'candidate', 1, { verdict: 'achieved' }),
    ])
    expect(report.comparisons).toEqual([expect.objectContaining({ paired: 1, missingPairs: 0, wins: 1, losses: 0, ties: 0, unknownPairs: 1, successRateDelta: null })])
    expect(report.comparisons[0]?.taskBootstrapInterval95).toBeNull()
  })

  it('bootstraps cases rather than treating repeats as independent and is deterministic', () => {
    const input = plan({
      cases: [
        { id: 'case-a', domain: 'code', inputDigest: digest('input-a'), acceptanceDigest: digest('accept-a') },
        { id: 'case-b', domain: 'research', inputDigest: digest('input-b'), acceptanceDigest: digest('accept-b') },
      ],
      repeats: 2,
    })
    const results: BenchmarkResult[] = []
    for (const caseId of ['case-a', 'case-b']) for (const repeat of [0, 1]) {
      results.push(result(input, caseId, 'baseline', repeat, { verdict: caseId === 'case-a' ? 'not-achieved' : 'achieved' }))
      results.push(result(input, caseId, 'candidate', repeat, { verdict: 'achieved' }))
    }
    const firstReport = benchmarkReport(input, results)
    const first = firstReport.comparisons[0]!
    const second = benchmarkReport(input, results).comparisons[0]!
    expect(first).toMatchObject({ paired: 4, wins: 2, ties: 2, successRateDelta: 0.5 })
    expect(first.taskBootstrapInterval95).toEqual(second.taskBootstrapInterval95)
    expect(first.taskBootstrapInterval95).not.toBeNull()
    expect(firstReport.variants.every((variant) => variant.successInterval95 !== null)).toBe(true)
  })

  it('withholds gain and confidence for fully recorded multi-task runs with an unknown baseline', () => {
    const input = plan({ cases: [
      { id: 'case-a', domain: 'code', inputDigest: digest('first-input'), acceptanceDigest: digest('first-judge') },
      { id: 'case-b', domain: 'research', inputDigest: digest('second-input'), acceptanceDigest: digest('second-judge') },
    ] })
    const results = benchmarkSchedule(input).map(cell => result(input, cell.caseId, cell.variantId, cell.repeat))
    results[0] = { ...results[0]!, verdict: 'unknown' }
    const report = benchmarkReport(input, results)
    expect(report.complete).toBe(true)
    expect(report.variants.find(variant => variant.id === 'baseline')!.successInterval95).toBeNull()
    expect(report.comparisons[0]).toMatchObject({ unknownPairs: 1, successRateDelta: null, taskBootstrapInterval95: null })
  })

  it('withholds paired bootstrap intervals when a cell is missing', () => {
    const input = plan({ cases: [
      { id: 'case-a', domain: 'code', inputDigest: digest('input-a'), acceptanceDigest: digest('accept-a') },
      { id: 'case-b', domain: 'research', inputDigest: digest('input-b'), acceptanceDigest: digest('accept-b') },
    ] })
    const results = benchmarkSchedule(input)
      .filter((cell) => !(cell.caseId === 'case-b' && cell.variantId === 'candidate' && cell.repeat === 1))
      .map((cell) => result(input, cell.caseId, cell.variantId, cell.repeat))
    const comparison = benchmarkReport(input, results).comparisons[0]!
    expect(comparison).toMatchObject({ missingPairs: 1, taskBootstrapInterval95: null })
  })

  it('compares an ablation with its candidate reference arm', () => {
    const input = plan({
      variants: [
        { id: 'baseline', role: 'baseline', versions: versions(), features: features() },
        { id: 'candidate', role: 'candidate', versions: versions(), features: { ...features(), memory: true } },
        { id: 'without-memory', role: 'ablation', versions: versions(), features: features() },
      ],
    })
    const results = benchmarkSchedule(input).map((cell) => result(input, cell.caseId, cell.variantId, cell.repeat))
    expect(benchmarkReport(input, results).comparisons.find((comparison) => comparison.variantId === 'without-memory')).toMatchObject({ baselineId: 'candidate', variantId: 'without-memory' })
  })

  it('rejects non-finite and negative measurements without mutating inputs', () => {
    const input = plan()
    const observed = result(input, 'case-a', 'baseline', 0, { metrics: metrics({ latencyMs: Number.NaN }) })
    const before = structuredClone(observed)
    expect(() => benchmarkReport(input, [observed])).toThrow(/invalid|finite|non-negative/i)
    expect(observed).toEqual(before)
  })
})
