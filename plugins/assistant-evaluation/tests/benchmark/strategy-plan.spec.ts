import { describe, expect, it } from 'vitest'
import { BenchmarkStore } from '../../src/benchmark/store.js'
import { benchmarkSchedule } from '../../src/benchmark/schema.js'
import { parseStrategyBenchmarkPlan, strategyBenchmarkCapabilityVersions, strategyBenchmarkJournalPlan, strategyBenchmarkPlanDigest, strategyBenchmarkProtocol, strategyBenchmarkRequestLimits, type StrategyBenchmarkPlan } from '../../src/benchmark/strategy-plan.js'
import type { BenchmarkExecutionRequest } from '../../src/benchmark/runner.js'

function fixture(): StrategyBenchmarkPlan {
  const versions = { model: '1'.repeat(64), prompt: '2'.repeat(64), skills: '3'.repeat(64), tools: '4'.repeat(64), policy: '5'.repeat(64), runtime: '6'.repeat(64) }
  const features = { memory: false, planning: false, review: false, growth: false }
  const capabilities = { common: { persona: 'a'.repeat(64), tools: 'b'.repeat(64), policy: 'c'.repeat(64), runtime: 'd'.repeat(64) },
    strategy: { guide: 'e'.repeat(64), tool: 'f'.repeat(64), policy: '1'.repeat(64), runtime: '2'.repeat(64) } }
  return { schemaVersion: 1, protocol: strategyBenchmarkProtocol,
    benchmark: { schemaVersion: 1, id: 'strategy-dev', dataset: { id: 'public-code', version: '1', digest: 'a'.repeat(64), split: 'development' }, comparison: 'capability',
      cases: [{ id: 'sum', domain: 'code', inputDigest: 'b'.repeat(64), acceptanceDigest: 'c'.repeat(64) }],
      variants: [{ id: 'direct', role: 'baseline', versions: { ...versions, ...strategyBenchmarkCapabilityVersions(capabilities, false) }, features: { ...features } },
        { id: 'adaptive-strategy', role: 'candidate', versions: { ...versions, ...strategyBenchmarkCapabilityVersions(capabilities, true) }, features: { ...features } }],
      budget: { durationMs: 1000, inputTokens: 100, outputTokens: 50, costUsdMicros: null, toolCalls: 10 }, repeats: 2, seed: 7 },
    execution: { modelCalls: 8, maxOutputTokensPerCall: 10, maxGoalRounds: 3 }, capabilities }
}

describe('native strategy execution contract', () => {
  it('freezes detached limits and rejects changed execution contracts under an existing journal id', () => {
    const raw = fixture(); const parsed = parseStrategyBenchmarkPlan(raw)
    const store = new BenchmarkStore(':memory:')
    try {
      store.create(strategyBenchmarkJournalPlan(parsed))
      raw.execution.modelCalls++
      expect(parsed.execution.modelCalls).toBe(8)
      expect(Object.isFrozen(parsed.execution)).toBe(true)
      expect(strategyBenchmarkPlanDigest(raw)).not.toBe(strategyBenchmarkPlanDigest(parsed))
      expect(() => store.create(strategyBenchmarkJournalPlan(raw))).toThrow('different frozen content')
    } finally { store.close() }
  })

  it.each(['modelCalls', 'maxOutputTokensPerCall', 'maxGoalRounds'] as const)('binds %s into both journal runtime versions', field => {
    const raw = fixture(); const before = strategyBenchmarkJournalPlan(raw)
    raw.execution[field]++
    const after = strategyBenchmarkJournalPlan(raw)
    expect(after.variants.every((value, index) => value.versions.runtime !== before.variants[index]!.versions.runtime)).toBe(true)
    expect(after.budget).toEqual(before.budget)
  })

  it('checks exact journal-bound requests before exposing execution limits', () => {
    const raw = fixture(); const plan = strategyBenchmarkJournalPlan(raw); const cell = benchmarkSchedule(plan)[0]!
    const controller = new AbortController()
    const request: BenchmarkExecutionRequest = { planId: plan.id, dataset: plan.dataset, cell, task: plan.cases[0]!, variant: plan.variants[0]!, budget: plan.budget, signal: controller.signal }
    expect(strategyBenchmarkRequestLimits(raw, request)).toEqual(raw.execution)
    expect(() => strategyBenchmarkRequestLimits(raw, { ...request, variant: raw.benchmark.variants[0]! })).toThrow('drift')
    expect(() => strategyBenchmarkRequestLimits(raw, { ...request, budget: { ...plan.budget, outputTokens: 51 } })).toThrow('drift')
    raw.execution.modelCalls++
    expect(() => strategyBenchmarkRequestLimits(raw, request)).toThrow('drift')
    raw.execution.modelCalls--; controller.abort()
    expect(() => strategyBenchmarkRequestLimits(raw, request)).toThrow('aborted')
  })

  it('rejects capability confounders and unbounded or unrecognized contracts', () => {
    const raw = fixture()
    expect(() => parseStrategyBenchmarkPlan({ ...raw, execution: { ...raw.execution, modelCalls: 0 } })).toThrow()
    expect(() => parseStrategyBenchmarkPlan({ ...raw, execution: { ...raw.execution, maxOutputTokensPerCall: 51 } })).toThrow()
    expect(() => parseStrategyBenchmarkPlan({ ...raw, execution: { ...raw.execution, maxGoalRounds: Infinity } })).toThrow()
    expect(() => parseStrategyBenchmarkPlan({ ...raw, execution: { ...raw.execution, candidateBonus: 1 } })).toThrow()
    raw.benchmark.variants[1]!.features = { ...raw.benchmark.variants[1]!.features, memory: true }
    expect(() => parseStrategyBenchmarkPlan(raw)).toThrow('non-strategy')
    raw.benchmark.variants[1]!.features = { ...raw.benchmark.variants[1]!.features, memory: false }
    raw.benchmark.variants[1]!.versions.skills = '8'.repeat(64)
    expect(() => parseStrategyBenchmarkPlan(raw)).toThrow('common skills')
  })

  it('rejects accessors without invoking them', () => {
    const raw = fixture(); let calls = 0
    Object.defineProperty(raw.execution, 'modelCalls', { enumerable: true, get() { calls++; return 8 } })
    expect(() => parseStrategyBenchmarkPlan(raw)).toThrow('plain enumerable')
    expect(calls).toBe(0)
  })

  it.each(['prompt', 'tools', 'policy', 'runtime'] as const)('rejects unrelated %s changes and an undeclared candidate feature', key => {
    const raw = fixture()
    raw.benchmark.variants[1]!.versions[key] = '9'.repeat(64)
    expect(() => parseStrategyBenchmarkPlan(raw)).toThrow('capability manifest')
    raw.benchmark.variants[1]!.versions = { ...raw.benchmark.variants[0]!.versions }
    expect(() => parseStrategyBenchmarkPlan(raw)).toThrow('capability manifest')
  })
})
