import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { benchmarkDomains } from './types.js'
import type { BenchmarkCell, BenchmarkMetrics, BenchmarkPlan, BenchmarkResult } from './types.js'

export class BenchmarkError extends Error {
  constructor(message: string) { super(message); this.name = 'BenchmarkError' }
}
export function benchmarkAssert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new BenchmarkError(message)
}
/** Reject getters/non-enumerable fields before taking a detached bounded JSON snapshot. */
export function benchmarkSnapshot<T>(value: T): T {
  const seen = new Set<object>()
  let nodes = 0
  const inspect = (entry: unknown, depth: number): void => {
    benchmarkAssert(++nodes <= 4096 && depth <= 16, 'benchmark data too complex')
    if (entry === null || typeof entry !== 'object') return
    benchmarkAssert(!seen.has(entry), 'cyclic benchmark data')
    seen.add(entry)
    for (const key of Reflect.ownKeys(entry)) {
      if (Array.isArray(entry) && key === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(entry, key)!
      benchmarkAssert(typeof key === 'string' && descriptor.enumerable && 'value' in descriptor, 'benchmark data must be plain enumerable data')
      inspect(descriptor.value, depth + 1)
    }
    seen.delete(entry)
  }
  inspect(value, 0)
  const copy = JSON.parse(acceptanceCanonicalJson(value)) as T
  const freeze = (entry: unknown): void => {
    if (entry === null || typeof entry !== 'object') return
    for (const child of Object.values(entry)) freeze(child)
    Object.freeze(entry)
  }
  freeze(copy)
  return copy
}
export function benchmarkObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  benchmarkAssert(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected benchmark object')
  const object = value as Record<string, unknown>
  benchmarkAssert(Object.keys(object).sort().join('|') === [...keys].sort().join('|'), 'unexpected benchmark fields')
  return object
}
export function benchmarkInteger(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  benchmarkAssert(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max, 'invalid benchmark integer')
}
export function benchmarkHash(value: unknown): asserts value is string {
  benchmarkAssert(typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value), 'expected SHA-256 benchmark digest')
}
function id(value: unknown): asserts value is string {
  benchmarkAssert(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value), 'invalid benchmark identifier')
}
export const benchmarkVersionKeys = ['model', 'prompt', 'skills', 'tools', 'policy', 'runtime'] as const
export const benchmarkMetricKeys = ['inputTokens', 'outputTokens', 'costUsdMicros', 'toolCalls', 'rework', 'interventions', 'latencyMs'] as const

export function parseBenchmarkPlan(value: unknown): Readonly<BenchmarkPlan> {
  const input = benchmarkSnapshot(value)
  const plan = benchmarkObject(input, ['schemaVersion', 'id', 'dataset', 'comparison', 'cases', 'variants', 'budget', 'repeats', 'seed'])
  benchmarkAssert(plan.schemaVersion === 1, 'unsupported benchmark schema')
  id(plan.id)
  benchmarkAssert(plan.comparison === 'capability' || plan.comparison === 'model', 'invalid comparison')
  const dataset = benchmarkObject(plan.dataset, ['id', 'version', 'digest', 'split'])
  id(dataset.id); id(dataset.version); benchmarkHash(dataset.digest)
  benchmarkAssert(dataset.split === 'development' || dataset.split === 'holdout', 'invalid dataset split')
  benchmarkAssert(Array.isArray(plan.cases) && plan.cases.length >= 1 && plan.cases.length <= 100, 'expected 1..100 benchmark cases')
  const caseIds = new Set<string>()
  const inputDigests = new Set<string>()
  for (const raw of plan.cases) {
    const entry = benchmarkObject(raw, ['id', 'domain', 'inputDigest', 'acceptanceDigest'])
    id(entry.id); benchmarkHash(entry.inputDigest); benchmarkHash(entry.acceptanceDigest)
    benchmarkAssert(benchmarkDomains.includes(entry.domain as typeof benchmarkDomains[number]) && !caseIds.has(entry.id), 'invalid or duplicate benchmark case')
    benchmarkAssert(!inputDigests.has(entry.inputDigest), 'duplicate task input must be a repeat, not a separate task')
    caseIds.add(entry.id)
    inputDigests.add(entry.inputDigest)
  }
  benchmarkAssert(Array.isArray(plan.variants) && plan.variants.length >= 2 && plan.variants.length <= 8, 'expected 2..8 variants')
  const variantIds = new Set<string>()
  for (const raw of plan.variants) {
    const variant = benchmarkObject(raw, ['id', 'role', 'versions', 'features'])
    id(variant.id)
    benchmarkAssert(!variantIds.has(variant.id) && ['baseline', 'candidate', 'ablation'].includes(variant.role as string), 'invalid or duplicate variant')
    variantIds.add(variant.id)
    const versions = benchmarkObject(variant.versions, benchmarkVersionKeys)
    Object.values(versions).forEach(benchmarkHash)
    const features = benchmarkObject(variant.features, ['memory', 'planning', 'review', 'growth'])
    benchmarkAssert(Object.values(features).every(flag => typeof flag === 'boolean'), 'invalid feature flags')
  }
  const parsed = input as BenchmarkPlan
  benchmarkAssert(parsed.variants.filter(variant => variant.role === 'baseline').length === 1, 'exactly one baseline required')
  const baseline = parsed.variants.find(variant => variant.role === 'baseline')!
  for (const variant of parsed.variants) {
    if (parsed.comparison === 'capability') {
      benchmarkAssert(variant.versions.model === baseline.versions.model, 'capability comparisons require the same model configuration')
    } else {
      benchmarkAssert(benchmarkVersionKeys.filter(key => key !== 'model').every(key => variant.versions[key] === baseline.versions[key])
        && acceptanceCanonicalJson(variant.features) === acceptanceCanonicalJson(baseline.features), 'model comparisons must change only model configuration')
    }
  }
  const candidates = parsed.variants.filter(variant => variant.role === 'candidate')
  for (const variant of parsed.variants.filter(variant => variant.role === 'ablation')) {
    benchmarkAssert(parsed.comparison === 'capability' && candidates.length === 1, 'ablations require exactly one capability candidate')
    const candidate = candidates[0]!
    benchmarkAssert(acceptanceCanonicalJson(candidate.versions) === acceptanceCanonicalJson(variant.versions), 'ablations must preserve candidate versions')
    const keys = ['memory', 'planning', 'review', 'growth'] as const
    const differences = keys.filter(key => variant.features[key] !== candidate.features[key])
    benchmarkAssert(differences.length === 1 && candidate.features[differences[0]!] && !variant.features[differences[0]!], 'ablation must disable exactly one candidate feature')
  }
  const budget = benchmarkObject(plan.budget, ['durationMs', 'inputTokens', 'outputTokens', 'costUsdMicros', 'toolCalls'])
  benchmarkInteger(budget.durationMs, 1, 86_400_000)
  for (const key of ['inputTokens', 'outputTokens', 'costUsdMicros', 'toolCalls']) benchmarkInteger(budget[key], 0, 1_000_000_000)
  benchmarkInteger(plan.repeats, 2, 20); benchmarkInteger(plan.seed, 0, 0xffffffff)
  return parsed
}

export function benchmarkPlanDigest(plan: BenchmarkPlan): string { return acceptanceDigest(parseBenchmarkPlan(plan)) }

export function benchmarkSchedule(input: BenchmarkPlan): readonly BenchmarkCell[] {
  const plan = parseBenchmarkPlan(input)
  const cells: BenchmarkCell[] = []
  for (let repeat = 0; repeat < plan.repeats; repeat++) {
    plan.cases.forEach((task, caseIndex) => {
      const seed = Number.parseInt(acceptanceDigest([plan.seed, task.id, repeat]).slice(0, 8), 16)
      for (let index = 0; index < plan.variants.length; index++) {
        const variant = plan.variants[(index + repeat + caseIndex) % plan.variants.length]!
        cells.push({ id: acceptanceDigest([plan.id, task.id, variant.id, repeat]), caseId: task.id, variantId: variant.id, repeat, seed })
      }
    })
  }
  return Object.freeze(cells.map(cell => Object.freeze(cell)))
}

export function parseBenchmarkMetrics(value: unknown): BenchmarkMetrics {
  const metrics = benchmarkObject(benchmarkSnapshot(value), benchmarkMetricKeys)
  for (const entry of Object.values(metrics)) if (entry !== null) benchmarkInteger(entry, 0, 1_000_000_000_000)
  return metrics as unknown as BenchmarkMetrics
}

function parseResult(plan: BenchmarkPlan, expectedCells: ReadonlyMap<string, BenchmarkCell>, value: unknown): BenchmarkResult {
  const raw = benchmarkObject(benchmarkSnapshot(value), ['cell', 'status', 'verdict', 'metrics', 'evidenceDigest', 'reason', 'startedAt', 'completedAt'])
  const cell = benchmarkObject(raw.cell, ['id', 'caseId', 'variantId', 'repeat', 'seed'])
  const expected = expectedCells.get(cell.id as string)
  benchmarkAssert(expected && acceptanceCanonicalJson(expected) === acceptanceCanonicalJson(cell), 'result does not match planned cell')
  benchmarkAssert(raw.status === 'completed' || raw.status === 'unknown', 'invalid result status')
  benchmarkAssert(['achieved', 'not-achieved', 'unknown'].includes(raw.verdict as string), 'invalid verdict')
  benchmarkAssert(['verified', 'adapter-error', 'interrupted', 'timeout', 'invalid-observation', 'budget-exceeded', 'not-quiescent'].includes(raw.reason as string), 'invalid result reason')
  benchmarkAssert(raw.status === 'completed' ? raw.reason === 'verified' : raw.verdict === 'unknown' && raw.reason !== 'verified', 'inconsistent result status')
  if (raw.evidenceDigest !== null) benchmarkHash(raw.evidenceDigest)
  if (raw.status === 'completed') benchmarkHash(raw.evidenceDigest)
  const metrics = parseBenchmarkMetrics(raw.metrics)
  if (raw.status === 'completed') {
    for (const key of ['inputTokens', 'outputTokens', 'costUsdMicros', 'toolCalls'] as const) {
      benchmarkAssert(metrics[key] !== null && metrics[key]! <= plan.budget[key], 'completed result lacks in-budget measurement')
    }
    benchmarkAssert(metrics.latencyMs !== null && metrics.latencyMs <= plan.budget.durationMs, 'completed result lacks in-budget latency')
  }
  benchmarkInteger(raw.startedAt); benchmarkInteger(raw.completedAt)
  benchmarkAssert(raw.completedAt >= raw.startedAt, 'result ends before start')
  return raw as unknown as BenchmarkResult
}

/** Compile identity validation once for a batch rather than hashing every schedule per result. */
export function benchmarkResultParser(input: BenchmarkPlan): (value: unknown) => BenchmarkResult {
  const plan = parseBenchmarkPlan(input)
  const cells = new Map(benchmarkSchedule(plan).map(cell => [cell.id, cell]))
  return value => parseResult(plan, cells, value)
}

export function parseBenchmarkResult(plan: BenchmarkPlan, value: unknown): BenchmarkResult {
  return benchmarkResultParser(plan)(value)
}
