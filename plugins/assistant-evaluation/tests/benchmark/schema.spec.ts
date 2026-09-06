import { describe, expect, it } from 'vitest'
import { benchmarkPlanDigest, benchmarkSchedule, parseBenchmarkPlan } from '../../src/benchmark/schema.js'
import type { BenchmarkPlan } from '../../src/benchmark/types.js'

export function benchmarkFixture(): BenchmarkPlan {
  const versions = { model: '1'.repeat(64), prompt: '2'.repeat(64), skills: '3'.repeat(64), tools: '4'.repeat(64), policy: '5'.repeat(64), runtime: '6'.repeat(64) }
  const features = { memory: true, planning: true, review: true, growth: true }
  return {
    schemaVersion: 1, id: 'comparison-1',
    dataset: { id: 'fixed-tasks', version: 'v1', digest: 'a'.repeat(64), split: 'development' },
    comparison: 'capability', cases: [{ id: 'code-1', domain: 'code', inputDigest: 'b'.repeat(64), acceptanceDigest: 'c'.repeat(64) }],
    variants: [{ id: 'baseline', role: 'baseline', versions: { ...versions }, features: { ...features } },
      { id: 'candidate', role: 'candidate', versions: { ...versions, skills: '7'.repeat(64) }, features: { ...features } }],
    budget: { durationMs: 1000, inputTokens: 1000, outputTokens: 1000, costUsdMicros: 1000, toolCalls: 10 },
    repeats: 2, seed: 42,
  }
}

describe('frozen paired benchmark plans', () => {
  it('detaches and freezes all inputs and rotates paired order without changing pair seeds', () => {
    const input = benchmarkFixture()
    const plan = parseBenchmarkPlan(input)
    input.variants[0]!.versions.model = '9'.repeat(64)
    expect(plan.variants[0]!.versions.model).toBe('1'.repeat(64))
    expect(Object.isFrozen(plan.variants[0]!.versions)).toBe(true)
    const cells = benchmarkSchedule(plan)
    expect(cells.map(cell => cell.variantId)).toEqual(['baseline', 'candidate', 'candidate', 'baseline'])
    expect(cells[0]!.seed).toBe(cells[1]!.seed)
    expect(cells[2]!.seed).toBe(cells[3]!.seed)
    expect(new Set(cells.map(cell => cell.id)).size).toBe(4)
    expect(benchmarkSchedule(plan)).toEqual(cells)
  })
  it('rejects confounding model changes and isolates model-only experiments', () => {
    const plan = benchmarkFixture()
    plan.variants[1]!.versions.model = '8'.repeat(64)
    expect(() => parseBenchmarkPlan(plan)).toThrow('same model')
    plan.comparison = 'model'
    expect(() => parseBenchmarkPlan(plan)).toThrow('only model')
    plan.variants[1]!.versions.skills = plan.variants[0]!.versions.skills
    expect(parseBenchmarkPlan(plan).comparison).toBe('model')
  })
  it('binds dataset, budgets, features and input digests in the plan hash', () => {
    const plan = benchmarkFixture()
    const old = benchmarkPlanDigest(plan)
    plan.budget.toolCalls++
    expect(benchmarkPlanDigest(plan)).not.toBe(old)
  })
  it('rejects getters without invoking them, hidden fields, sparse lists and unsupported properties', () => {
    let calls = 0
    const accessor = { ...benchmarkFixture() }
    Object.defineProperty(accessor, 'id', { enumerable: true, get() { calls++; return 'x' } })
    expect(() => parseBenchmarkPlan(accessor)).toThrow()
    expect(calls).toBe(0)
    const hidden = benchmarkFixture()
    Object.defineProperty(hidden, 'extra', { value: 1 })
    expect(() => parseBenchmarkPlan(hidden)).toThrow()
    const sparse = benchmarkFixture()
    const cases = [...sparse.cases]; cases.length = 2
    expect(() => parseBenchmarkPlan({ ...sparse, cases })).toThrow()
    expect(() => parseBenchmarkPlan({ ...sparse, answers: 'leak' })).toThrow()
  })
  it('rejects duplicate identities, unsafe budgets and oversized task sets', () => {
    const plan = benchmarkFixture()
    expect(() => parseBenchmarkPlan({ ...plan, cases: [plan.cases[0], plan.cases[0]] })).toThrow()
    expect(() => parseBenchmarkPlan({ ...plan, cases: [plan.cases[0], { ...plan.cases[0], id: 'renamed-duplicate' }] })).toThrow('duplicate task input')
    expect(() => parseBenchmarkPlan({ ...plan, repeats: 1 })).toThrow()
    expect(() => parseBenchmarkPlan({ ...plan, budget: { ...plan.budget, costUsdMicros: -1 } })).toThrow()
    expect(() => parseBenchmarkPlan({ ...plan, cases: Array.from({ length: 101 }, (_, i) => ({ ...plan.cases[0], id: `case-${i}` })) })).toThrow()
  })
})
