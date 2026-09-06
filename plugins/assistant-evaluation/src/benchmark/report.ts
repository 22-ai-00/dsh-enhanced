import {
  benchmarkMetricKeys,
  benchmarkPlanDigest,
  benchmarkResultParser,
  benchmarkSchedule,
  parseBenchmarkPlan,
} from './schema.js'
import type { BenchmarkMetrics, BenchmarkPlan, BenchmarkReport, BenchmarkResult } from './types.js'

type MetricSummary = BenchmarkReport['variants'][number]['metrics'][keyof BenchmarkMetrics]
type ParsedResult = Readonly<BenchmarkResult>

function nearestRank(values: readonly number[], percentile: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)]!
}

function distribution(values: readonly number[], missing: number): MetricSummary {
  if (values.length === 0) return { measured: 0, missing, mean: null, median: null, p95: null }
  const sorted = [...values].sort((left, right) => left - right)
  const middle = sorted.length / 2
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[Math.floor(middle)]!
  return {
    measured: values.length,
    missing,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    median,
    p95: nearestRank(sorted, 0.95),
  }
}

function generator(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function clusteredInterval(caseMeans: readonly number[]): readonly [number, number] | null {
  if (caseMeans.length < 2) return null
  const next = generator(0x4d595df4)
  const samples: number[] = []
  for (let draw = 0; draw < 2_000; draw++) {
    let sum = 0
    for (let index = 0; index < caseMeans.length; index++) sum += caseMeans[Math.floor(next() * caseMeans.length)]!
    samples.push(sum / caseMeans.length)
  }
  return [nearestRank(samples, 0.025)!, nearestRank(samples, 0.975)!]
}

/** Produces descriptive, paired benchmark statistics; it never authorizes promotion. */
export function benchmarkReport(input: BenchmarkPlan, inputResults: readonly BenchmarkResult[]): BenchmarkReport {
  const plan = parseBenchmarkPlan(input)
  const scheduled = benchmarkSchedule(plan)
  const parseResult = benchmarkResultParser(plan)
  const results = new Map<string, ParsedResult>()
  for (const inputResult of inputResults) {
    const result = parseResult(inputResult)
    if (results.has(result.cell.id)) throw new Error(`duplicate benchmark result cell: ${result.cell.id}`)
    results.set(result.cell.id, result)
  }

  const cellKey = (caseId: string, variantId: string, repeat: number) => `${caseId}\u0000${variantId}\u0000${repeat}`
  const cells = new Map(scheduled.map(cell => [cellKey(cell.caseId, cell.variantId, cell.repeat), cell] as const))
  const lookup = (caseId: string, variantId: string, repeat: number): ParsedResult | undefined => {
    const cell = cells.get(cellKey(caseId, variantId, repeat))
    return cell === undefined ? undefined : results.get(cell.id)
  }
  const complete = results.size === scheduled.length

  const variants = plan.variants.map(variant => {
    const expectedCells = scheduled.filter(cell => cell.variantId === variant.id)
    const variantResults = expectedCells.map(cell => results.get(cell.id)).filter((result): result is ParsedResult => result !== undefined)
    const achieved = variantResults.filter(result => result.verdict === 'achieved').length
    const notAchieved = variantResults.filter(result => result.verdict === 'not-achieved').length
    const unknown = expectedCells.length - achieved - notAchieved
    const metrics = Object.fromEntries(benchmarkMetricKeys.map(key => {
      const measured = variantResults.map(result => result.metrics[key]).filter((value): value is number => value !== null)
      return [key, distribution(measured, expectedCells.length - measured.length)]
    })) as BenchmarkReport['variants'][number]['metrics']
    return {
      id: variant.id,
      expected: expectedCells.length,
      recorded: variantResults.length,
      achieved,
      notAchieved,
      unknown,
      successRate: achieved / expectedCells.length,
      successInterval95: !complete || unknown > 0 ? null : clusteredInterval(plan.cases.map(task => {
        let successes = 0
        for (let repeat = 0; repeat < plan.repeats; repeat++) successes += Number(lookup(task.id, variant.id, repeat)?.verdict === 'achieved')
        return successes / plan.repeats
      })),
      metrics,
    }
  })

  const baseline = plan.variants.find(variant => variant.role === 'baseline')!
  const candidate = plan.variants.find(variant => variant.role === 'candidate')
  const comparisons = plan.variants.filter(variant => variant.id !== baseline.id).map(variant => {
    const reference = variant.role === 'ablation' ? candidate! : baseline
    let paired = 0
    let missingPairs = 0
    let wins = 0
    let losses = 0
    let ties = 0
    let unknownPairs = 0
    const deltas: number[] = []
    const byCase = new Map<string, number[]>()
    for (const task of plan.cases) for (let repeat = 0; repeat < plan.repeats; repeat++) {
      const baselineResult = lookup(task.id, reference.id, repeat)
      const variantResult = lookup(task.id, variant.id, repeat)
      if (baselineResult === undefined || variantResult === undefined) { missingPairs++; continue }
      const delta = Number(variantResult.verdict === 'achieved') - Number(baselineResult.verdict === 'achieved')
      deltas.push(delta)
      const caseDeltas = byCase.get(task.id) ?? []
      caseDeltas.push(delta)
      byCase.set(task.id, caseDeltas)
      if (baselineResult.verdict === 'unknown' || variantResult.verdict === 'unknown') { unknownPairs++; continue }
      paired++
      if (delta > 0) wins++
      else if (delta < 0) losses++
      else ties++
    }
    const caseMeans = [...byCase.values()].map(values => values.reduce((sum, value) => sum + value, 0) / values.length)
    return {
      baselineId: reference.id,
      variantId: variant.id,
      paired,
      missingPairs,
      wins,
      losses,
      ties,
      unknownPairs,
      successRateDelta: deltas.length === 0 || missingPairs > 0 || unknownPairs > 0 ? null : deltas.reduce((sum, value) => sum + value, 0) / deltas.length,
      taskBootstrapInterval95: missingPairs > 0 || unknownPairs > 0 ? null : clusteredInterval(caseMeans),
    }
  })

  return {
    schemaVersion: 1,
    planDigest: benchmarkPlanDigest(plan),
    complete,
    expectedCells: scheduled.length,
    recordedCells: results.size,
    variants,
    comparisons,
    promotionAuthorized: false,
  }
}
