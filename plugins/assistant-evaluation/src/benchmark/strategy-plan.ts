import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { benchmarkAssert, benchmarkHash, benchmarkInteger, benchmarkObject, benchmarkSchedule, benchmarkSnapshot, parseBenchmarkPlan } from './schema.js'
import type { BenchmarkExecutionRequest } from './runner.js'
import type { BenchmarkPlan } from './types.js'

export const strategyBenchmarkProtocol = 'dsh-native-goal-strategy-benchmark-v1'

/** Separate execution contract: schema-v1 benchmark budgets cannot express these limits. */
export interface StrategyBenchmarkExecutionLimits {
  modelCalls: number
  maxOutputTokensPerCall: number
  maxGoalRounds: number
}

export interface StrategyBenchmarkPlan {
  schemaVersion: 1
  protocol: typeof strategyBenchmarkProtocol
  /** Unbound version manifest. Use strategyBenchmarkJournalPlan for scheduling/persistence. */
  benchmark: BenchmarkPlan
  execution: StrategyBenchmarkExecutionLimits
  capabilities: StrategyBenchmarkCapabilities
}

/** Operator-frozen manifests, to be compared with actual mounted capabilities by the executor. */
export interface StrategyBenchmarkCapabilities {
  common: { persona: string; tools: string; policy: string; runtime: string }
  strategy: { guide: string; tool: string; policy: string; runtime: string }
}

export function strategyBenchmarkCapabilityVersions(input: StrategyBenchmarkCapabilities, enabled: boolean) {
  const raw = benchmarkObject(benchmarkSnapshot(input), ['common', 'strategy'])
  const common = benchmarkObject(raw.common, ['persona', 'tools', 'policy', 'runtime'])
  const strategy = benchmarkObject(raw.strategy, ['guide', 'tool', 'policy', 'runtime'])
  Object.values(common).forEach(benchmarkHash); Object.values(strategy).forEach(benchmarkHash)
  return Object.freeze({
    prompt: acceptanceDigest({ commonPersona: common.persona, strategyGuide: enabled ? strategy.guide : null }),
    tools: acceptanceDigest({ commonTools: common.tools, strategyTool: enabled ? strategy.tool : null }),
    policy: acceptanceDigest({ commonPolicy: common.policy, strategyPolicy: enabled ? strategy.policy : null }),
    runtime: acceptanceDigest({ commonRuntime: common.runtime, strategyRuntime: enabled ? strategy.runtime : null }),
  })
}

/** Both arms use the same non-strategy feature configuration and one execution limit set. */
export function parseStrategyBenchmarkPlan(value: unknown): Readonly<StrategyBenchmarkPlan> {
  const copy = benchmarkSnapshot(value)
  const raw = benchmarkObject(copy, ['schemaVersion', 'protocol', 'benchmark', 'execution', 'capabilities'])
  benchmarkAssert(raw.schemaVersion === 1 && raw.protocol === strategyBenchmarkProtocol, 'unsupported strategy benchmark protocol')
  const benchmark = parseBenchmarkPlan(raw.benchmark)
  const execution = benchmarkObject(raw.execution, ['modelCalls', 'maxOutputTokensPerCall', 'maxGoalRounds'])
  benchmarkInteger(execution.modelCalls, 1, 10_000)
  benchmarkInteger(execution.maxOutputTokensPerCall, 1, benchmark.budget.outputTokens)
  benchmarkInteger(execution.maxGoalRounds, 1, 100)
  benchmarkAssert(benchmark.comparison === 'capability' && benchmark.variants.length === 2, 'strategy benchmark requires exactly two capability arms')
  const direct = benchmark.variants.find(variant => variant.id === 'direct')
  const adaptive = benchmark.variants.find(variant => variant.id === 'adaptive-strategy')
  benchmarkAssert(direct?.role === 'baseline' && adaptive?.role === 'candidate', 'strategy benchmark requires direct baseline and adaptive-strategy candidate')
  benchmarkAssert(acceptanceCanonicalJson(direct.features) === acceptanceCanonicalJson(adaptive.features), 'strategy arms must preserve non-strategy features')
  benchmarkAssert(direct.versions.skills === adaptive.versions.skills, 'strategy arms must preserve common skills')
  for (const variant of [direct, adaptive]) {
    const expected = strategyBenchmarkCapabilityVersions(raw.capabilities as StrategyBenchmarkCapabilities, variant === adaptive)
    benchmarkAssert((['prompt', 'tools', 'policy', 'runtime'] as const).every(key => variant.versions[key] === expected[key]), 'strategy arm capability manifest drift')
  }
  // This establishes manifest consistency, not attestation of a loaded runtime.
  // The native executor must compare these same common/strategy descriptors
  // with actual persona, registered tools, Policy and loaded runtime versions.
  return copy as StrategyBenchmarkPlan
}

export function strategyBenchmarkPlanDigest(input: StrategyBenchmarkPlan): string {
  return acceptanceDigest(parseStrategyBenchmarkPlan(input))
}

/**
 * Bind the complete execution contract into the existing journal's frozen version manifest.
 * Reusing a plan id with different call/round/output limits is rejected by BenchmarkStore.
 * This binding is not enforcement: the native executor must install the outer meter and
 * native round limit from the same parsed contract before starting any agent request.
 */
export function strategyBenchmarkJournalPlan(input: StrategyBenchmarkPlan): Readonly<BenchmarkPlan> {
  const parsed = parseStrategyBenchmarkPlan(input)
  const digest = strategyBenchmarkPlanDigest(parsed)
  return parseBenchmarkPlan({ ...parsed.benchmark, variants: parsed.benchmark.variants.map(variant => ({ ...variant,
    versions: { ...variant.versions, runtime: acceptanceDigest({ protocol: parsed.protocol, strategyPlanDigest: digest, runtime: variant.versions.runtime }) },
  })) })
}

/** Called before constructing a runtime or invoking a trusted provider factory. */
export function strategyBenchmarkRequestLimits(input: StrategyBenchmarkPlan, request: BenchmarkExecutionRequest): Readonly<StrategyBenchmarkExecutionLimits> {
  const parsed = parseStrategyBenchmarkPlan(input)
  const plan = strategyBenchmarkJournalPlan(parsed)
  const cell = benchmarkSchedule(plan).find(value => value.id === request.cell.id)
  const same = (left: unknown, right: unknown): boolean => acceptanceCanonicalJson(left) === acceptanceCanonicalJson(right)
  benchmarkAssert(cell !== undefined && request.planId === plan.id && same(request.cell, cell)
    && same(request.dataset, plan.dataset) && same(request.budget, plan.budget)
    && same(request.task, plan.cases.find(value => value.id === cell.caseId))
    && same(request.variant, plan.variants.find(value => value.id === cell.variantId)), 'strategy benchmark request drift')
  benchmarkAssert(!request.signal.aborted, 'strategy benchmark aborted')
  return parsed.execution
}
