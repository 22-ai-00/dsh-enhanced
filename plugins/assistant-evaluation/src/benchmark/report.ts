import {
  benchmarkMetricKeys,
  benchmarkPlanDigest,
  benchmarkResultParser,
  benchmarkSchedule,
  parseBenchmarkPlan,
} from './schema.js'
import { benchmarkDomains } from './types.js'
import type {
  BenchmarkDomain, BenchmarkDomainComparison, BenchmarkMetricSummary, BenchmarkMetrics, BenchmarkPairedDelta, BenchmarkPlan,
  BenchmarkReport, BenchmarkResult, BenchmarkTaskSuccessDistribution,
} from './types.js'

type MetricSummary = BenchmarkMetricSummary
type ParsedResult = Readonly<BenchmarkResult>

function nearestRank(values: readonly number[], percentile: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)]!
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = sorted.length / 2
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[Math.floor(middle)]!
}

const mean = (values: readonly number[]): number | null => values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length

function distribution(values: readonly number[], missing: number): MetricSummary {
  if (values.length === 0) return { measured: 0, missing, mean: null, median: null, p95: null, min: null, p10: null, p90: null, max: null }
  const sorted = [...values].sort((left, right) => left - right)
  return {
    measured: values.length,
    missing,
    mean: mean(sorted),
    median: median(sorted),
    p95: nearestRank(sorted, 0.95),
    min: sorted[0]!,
    p10: nearestRank(sorted, 0.10),
    p90: nearestRank(sorted, 0.90),
    max: sorted[sorted.length - 1]!,
  }
}

function pairedDelta(values: readonly number[], missing: number): BenchmarkPairedDelta {
  return { pairs: values.length, missing, mean: mean(values), p10: nearestRank(values, 0.10), median: median(values), p90: nearestRank(values, 0.90) }
}

/** Domains in canonical `benchmarkDomains` order, restricted to those present in the plan. */
function planDomains(plan: BenchmarkPlan): readonly BenchmarkDomain[] {
  return benchmarkDomains.filter(domain => plan.cases.some(task => task.domain === domain))
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
    const byDomain = planDomains(plan).map(domain => {
      const tasks = plan.cases.filter(task => task.domain === domain)
      const ids = new Set(tasks.map(task => task.id))
      const domainCells = expectedCells.filter(cell => ids.has(cell.caseId))
      const domainResults = domainCells.map(cell => results.get(cell.id))
      const domainAchieved = domainResults.filter(result => result?.verdict === 'achieved').length
      const domainNotAchieved = domainResults.filter(result => result?.verdict === 'not-achieved').length
      return {
        domain, tasks: tasks.length, expected: domainCells.length, achieved: domainAchieved, notAchieved: domainNotAchieved,
        unknown: domainCells.length - domainAchieved - domainNotAchieved, successRate: domainAchieved / domainCells.length,
      }
    })
    const taskRates: number[] = []
    for (const task of plan.cases) {
      let successes = 0
      let known = true
      for (let repeat = 0; repeat < plan.repeats; repeat++) {
        const verdict = lookup(task.id, variant.id, repeat)?.verdict
        if (verdict !== 'achieved' && verdict !== 'not-achieved') { known = false; break }
        successes += Number(verdict === 'achieved')
      }
      if (known) taskRates.push(successes / plan.repeats)
    }
    const sortedRates = [...taskRates].sort((left, right) => left - right)
    const taskSuccess: BenchmarkTaskSuccessDistribution = {
      tasks: plan.cases.length,
      summarized: taskRates.length,
      allAchieved: taskRates.filter(rate => rate === 1).length,
      noneAchieved: taskRates.filter(rate => rate === 0).length,
      mixed: taskRates.filter(rate => rate > 0 && rate < 1).length,
      min: sortedRates[0] ?? null,
      median: median(sortedRates),
      max: sortedRates[sortedRates.length - 1] ?? null,
    }
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
      byDomain,
      taskSuccess,
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
    const domains = new Map<BenchmarkDomain, BenchmarkDomainComparison>(planDomains(plan).map(domain => [domain, {
      domain, paired: 0, missingPairs: 0, wins: 0, losses: 0, ties: 0, unknownPairs: 0,
    }]))
    const metricValues = new Map<keyof BenchmarkMetrics, number[]>(benchmarkMetricKeys.map(key => [key, []]))
    for (const task of plan.cases) for (let repeat = 0; repeat < plan.repeats; repeat++) {
      const domain = domains.get(task.domain)!
      const baselineResult = lookup(task.id, reference.id, repeat)
      const variantResult = lookup(task.id, variant.id, repeat)
      if (baselineResult === undefined || variantResult === undefined) { missingPairs++; domain.missingPairs++; continue }
      for (const key of benchmarkMetricKeys) {
        const left = variantResult.metrics[key]; const right = baselineResult.metrics[key]
        if (left !== null && right !== null) metricValues.get(key)!.push(left - right)
      }
      const delta = Number(variantResult.verdict === 'achieved') - Number(baselineResult.verdict === 'achieved')
      deltas.push(delta)
      const caseDeltas = byCase.get(task.id) ?? []
      caseDeltas.push(delta)
      byCase.set(task.id, caseDeltas)
      if (baselineResult.verdict === 'unknown' || variantResult.verdict === 'unknown') { unknownPairs++; domain.unknownPairs++; continue }
      paired++; domain.paired++
      if (delta > 0) { wins++; domain.wins++ } else if (delta < 0) { losses++; domain.losses++ } else { ties++; domain.ties++ }
    }
    const totalPairs = plan.cases.length * plan.repeats
    const metricDeltas = Object.fromEntries(benchmarkMetricKeys.map(key => {
      const values = metricValues.get(key)!
      return [key, pairedDelta(values, totalPairs - values.length)]
    })) as BenchmarkReport['comparisons'][number]['metricDeltas']
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
      byDomain: [...domains.values()],
      metricDeltas,
    }
  })

  return {
    schemaVersion: 1,
    distributionVersion: 1,
    planDigest: benchmarkPlanDigest(plan),
    complete,
    expectedCells: scheduled.length,
    recordedCells: results.size,
    variants,
    comparisons,
    promotionAuthorized: false,
  }
}
