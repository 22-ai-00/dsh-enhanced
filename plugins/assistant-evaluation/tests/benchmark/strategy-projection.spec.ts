import { describe, expect, test } from 'vitest'
import { benchmarkSchedule } from '../../src/benchmark/schema.ts'
import { strategyBenchmarkCapabilityVersions, strategyBenchmarkJournalPlan, strategyBenchmarkProtocol, type StrategyBenchmarkPlan } from '../../src/benchmark/strategy-plan.ts'
import type { StrategyEvidenceObject } from '../../src/benchmark/strategy-evidence.ts'
import type { BenchmarkResult } from '../../src/benchmark/types.ts'
import type { TokenUsageRates } from '../../src/benchmark/usage.ts'
import {
  accumulateSessionCost, behaviorFailureReasons, pairStrategyCells, projectStrategyCell,
  unknownStrategyCellProjection, type ProjectedCellEvidence,
} from '../../src/benchmark/strategy-projection.ts'

const hash = (value: string) => value.repeat(64).slice(0, 64)
type SettledTrace = StrategyEvidenceObject['meter']['traces'][number]

const rates: TokenUsageRates = {
  inputUsdMicrosPerMillionTokens: 1_000_000, // $1 / 1M uncached input
  outputUsdMicrosPerMillionTokens: 2_000_000, // $2 / 1M output
  cacheReadUsdMicrosPerMillionTokens: null,
  cacheWriteUsdMicrosPerMillionTokens: null,
}

function trace(partial: Partial<SettledTrace> & { sessionId: string | null }): SettledTrace {
  const { sessionId = 'parent', ...rest } = partial
  return {
    id: 1, agentId: 'parent', startedAt: 1, completedAt: 2, phase: 'settled', dispatched: true,
    reservedInputTokens: 100, reservedOutputTokens: 50, reservedCostUsdMicros: null,
    usage: { inputTokens: 10, uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 15 },
    reason: null, ...rest, sessionId,
  }
}

function completedResult(partial: { verdict?: BenchmarkResult['verdict']; cell?: Partial<BenchmarkResult['cell']> } = {}): BenchmarkResult {
  return {
    cell: { id: 'cell', caseId: 'case', variantId: 'direct', repeat: 0, seed: 1, ...partial.cell },
    status: 'completed', verdict: partial.verdict ?? 'achieved',
    metrics: { inputTokens: 0, outputTokens: 0, costUsdMicros: null, toolCalls: 0, rework: 0, interventions: 0, latencyMs: 1 },
    evidenceDigest: hash('e'), reason: 'verified', startedAt: 1, completedAt: 2,
  }
}
const unknownResult = (cell: Partial<BenchmarkResult['cell']> = {}, reason: BenchmarkResult['reason'] = 'timeout'): BenchmarkResult => ({
  cell: { id: 'cell-u', caseId: 'case', variantId: 'direct', repeat: 0, seed: 1, ...cell },
  status: 'unknown', verdict: 'unknown',
  metrics: { inputTokens: null, outputTokens: null, costUsdMicros: null, toolCalls: null, rework: null, interventions: null, latencyMs: null },
  evidenceDigest: null, reason, startedAt: 1, completedAt: 2,
})

function evidence(input: {
  parent?: string
  children?: readonly string[]
  traces?: readonly SettledTrace[]
  receipts?: ProjectedCellEvidence['native']['receipts']
} = {}): ProjectedCellEvidence {
  return {
    meter: { traces: input.traces ?? [trace({ sessionId: input.parent ?? 'parent' })] },
    native: {
      parent: { sessionId: input.parent ?? 'parent' },
      strategies: input.children === undefined ? []
        : [{ children: input.children.map(sessionId => ({ sessionId })) }],
      receipts: input.receipts ?? [],
    },
  }
}
const receipt = (quiescent: boolean, results: Readonly<ProjectedCellEvidence['native']['receipts'][number]['receipt']['results']>,
  objectiveStatus: 'achieved' | 'not-achieved' | 'unknown' = 'not-achieved', contractId = 'contract'): ProjectedCellEvidence['native']['receipts'][number] => ({
  contract: { id: contractId }, taskKind: 'goal-outcome', quiescent,
  receipt: { objectiveStatus, results },
})
const criterion = (criterionId: string, status: 'passed' | 'failed' | 'unknown', reasonName: string) => ({ criterionId, status, reason: reasonName })

function plan(observationMode: StrategyBenchmarkPlan['execution']['observationMode'] = 'enforced-upper-bound-provider-output'): StrategyBenchmarkPlan {
  const versions = { model: hash('1'), prompt: hash('2'), skills: hash('3'), tools: hash('4'), policy: hash('5'), runtime: hash('6') }
  const capabilities = { common: { persona: hash('a'), tools: hash('b'), policy: hash('c'), runtime: hash('d') }, strategy: { guide: hash('e'), tool: hash('f'), policy: hash('1'), runtime: hash('2') } }
  return {
    schemaVersion: 1, protocol: strategyBenchmarkProtocol, execution: { modelCalls: 3, maxOutputTokensPerCall: 10, maxGoalRounds: 2, observationMode }, capabilities,
    benchmark: {
      schemaVersion: 1, id: 'strategy-projection', dataset: { id: 'public', version: '1', digest: hash('a'), split: 'development' }, comparison: 'capability',
      cases: [{ id: 'case', domain: 'code', inputDigest: hash('b'), acceptanceDigest: hash('c') }],
      budget: { durationMs: 1000, inputTokens: 100, outputTokens: 50, costUsdMicros: null, toolCalls: 3 }, repeats: 2, seed: 1,
      variants: [
        { id: 'direct', role: 'baseline', features: { memory: false, planning: false, review: false, growth: false }, versions: { ...versions, ...strategyBenchmarkCapabilityVersions(capabilities, false) } },
        { id: 'adaptive-strategy', role: 'candidate', features: { memory: false, planning: false, review: false, growth: false }, versions: { ...versions, ...strategyBenchmarkCapabilityVersions(capabilities, true) } },
      ],
    },
  }
}

describe('accumulateSessionCost', () => {
  test('sums only settled traces attributed to the requested sessions', () => {
    const traces = [
      trace({ id: 1, sessionId: 'parent' }), // 10 in / 5 out, 10 + 10 micros
      trace({ id: 2, sessionId: 'child-1' }),
      trace({ id: 3, sessionId: null }),
      trace({ id: 4, sessionId: 'parent', phase: 'retained', usage: null, completedAt: null, dispatched: false }),
      trace({ id: 5, sessionId: 'stranger' }),
    ]
    const parent = accumulateSessionCost(traces, new Set(['parent']), rates)
    expect(parent).toEqual({ modelCalls: 1, inputTokens: 10, outputTokens: 5, costUsdMicros: 20 })
    const children = accumulateSessionCost(traces, new Set(['child-1']), rates)
    expect(children).toEqual({ modelCalls: 1, inputTokens: 10, outputTokens: 5, costUsdMicros: 20 })
  })

  test('returns null cost but keeps token counts when a billed class lacks its tariff', () => {
    // 6 uncached + 4 cache-read input; cache-read tariff is null, so exact cost is unknowable.
    const priced = trace({ sessionId: 'child-1', usage: { inputTokens: 10, uncachedInputTokens: 6, outputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 15 } })
    const split = accumulateSessionCost([priced], new Set(['child-1']), rates)
    expect(split.costUsdMicros).toBeNull()
    expect(split).toMatchObject({ modelCalls: 1, inputTokens: 10, outputTokens: 5 })

    // Zero cache-read tokens do not require the optional tariff.
    const free = trace({ sessionId: 'child-1' })
    expect(accumulateSessionCost([free], new Set(['child-1']), rates).costUsdMicros).toBe(20)
  })

  test('observed-call-count settled trace (usage=null) counts the call but never invents tokens or cost', () => {
    const callsTrace = trace({ sessionId: 'parent', reservedInputTokens: 0, reservedOutputTokens: 0, usage: null })
    const split = accumulateSessionCost([callsTrace, trace({ sessionId: 'parent', reservedInputTokens: 0, reservedOutputTokens: 0, usage: null, id: 2 })], new Set(['parent']), rates)
    expect(split).toEqual({ modelCalls: 2, inputTokens: 0, outputTokens: 0, costUsdMicros: null })
  })
})

describe('unknownStrategyCellProjection', () => {
  test('a failure object stays infrastructure-unknown with no costs or receipts', () => {
    const projection = unknownStrategyCellProjection(unknownResult({ variantId: 'adaptive-strategy' }, 'not-quiescent'))
    expect(projection).toMatchObject({
      status: 'unknown', verdict: 'unknown',
      attribution: { classification: 'undelivered-or-unknown', basis: 'infrastructure-unknown', infrastructureReason: 'not-quiescent', receipts: [] },
      costs: null,
    })
  })
})

describe('projectStrategyCell', () => {
  test('achieved verdict classifies achieved and splits parent vs child session costs', () => {
    const value = evidence({
      children: ['child-1', 'child-2'],
      traces: [
        trace({ id: 1, sessionId: 'parent' }),
        trace({ id: 2, sessionId: 'parent' }),
        trace({ id: 3, sessionId: 'child-1' }),
        trace({ id: 4, sessionId: 'child-2' }),
      ],
    })
    const projection = projectStrategyCell(completedResult({ verdict: 'achieved', cell: { variantId: 'adaptive-strategy' } }), value, rates)
    expect(projection.attribution).toMatchObject({ classification: 'achieved', basis: 'achieved', infrastructureReason: null })
    expect(projection.costs?.parent).toEqual({ modelCalls: 2, inputTokens: 20, outputTokens: 10, costUsdMicros: 40 })
    expect(projection.costs?.children).toEqual({ modelCalls: 2, inputTokens: 20, outputTokens: 10, costUsdMicros: 40 })
  })

  test('not-achieved with a quiescent whitelist failed criterion is delivered-incorrect-behavior and preserves the raw reason', () => {
    const reasonName = behaviorFailureReasons[0]! // citation-mismatch
    const value = evidence({
      receipts: [
        receipt(true, [criterion('ok', 'passed', 'ok'), criterion('bad', 'failed', reasonName), criterion('weird', 'failed', 'some-future-reason')]),
      ],
    })
    const projection = projectStrategyCell(completedResult({ verdict: 'not-achieved' }), value, rates)
    expect(projection.attribution).toMatchObject({ classification: 'delivered-incorrect-behavior', basis: 'receipt-behavior-failure' })
    const criteria = projection.attribution.receipts[0]!.failedCriteria
    expect(criteria).toHaveLength(2)
    expect(criteria[0]).toEqual({ criterionId: 'bad', reason: reasonName, behaviorFailure: true })
    // Unknown/unlisted reasons are carried verbatim but never self-classified as behavior failures.
    expect(criteria[1]).toEqual({ criterionId: 'weird', reason: 'some-future-reason', behaviorFailure: false })
  })

  test('unknown criterion reasons (e.g. artifact unavailable) stay undelivered-or-unknown', () => {
    const value = evidence({
      receipts: [
        receipt(true, [criterion('missing', 'unknown', 'artifact-unavailable')]),
      ],
    })
    const projection = projectStrategyCell(completedResult({ verdict: 'not-achieved' }), value, rates)
    expect(projection.attribution).toMatchObject({ classification: 'undelivered-or-unknown', basis: 'no-behavior-failure-receipt' })
    expect(projection.attribution.receipts[0]!.failedCriteria).toEqual([])
  })

  test('a behavior-failure criterion on a non-quiescent receipt does not upgrade the attribution', () => {
    const value = evidence({
      receipts: [
        receipt(false, [criterion('bad', 'failed', 'unexpected-exit-code')]),
      ],
    })
    const projection = projectStrategyCell(completedResult({ verdict: 'not-achieved' }), value, rates)
    expect(projection.attribution).toMatchObject({ classification: 'undelivered-or-unknown', basis: 'no-behavior-failure-receipt' })
    // The raw signal is still carried for audit; only the conservative classification is withheld.
    expect(projection.attribution.receipts[0]!.failedCriteria[0]).toMatchObject({ behaviorFailure: true, reason: 'unexpected-exit-code' })
    expect(projection.attribution.receipts[0]!.quiescent).toBe(false)
  })

  test('refuses to project a result without bound completed evidence', () => {
    const value = evidence()
    expect(() => projectStrategyCell(unknownResult(), value, rates)).toThrow('completed result requires bound evidence')
    const noDigest = completedResult({ verdict: 'achieved' });
    (noDigest as { evidenceDigest: string | null }).evidenceDigest = null
    expect(() => projectStrategyCell(noDigest, value, rates)).toThrow('completed result requires bound evidence')
  })
})

describe('pairStrategyCells', () => {
  test('computes the candidate-minus-direct coordination extra with a childless direct arm', async () => {
    const input = plan()
    const scheduled = benchmarkSchedule(strategyBenchmarkJournalPlan(input))
    expect(scheduled.map(cell => `${cell.variantId}:${cell.repeat}`)).toEqual(['direct:0', 'adaptive-strategy:0', 'adaptive-strategy:1', 'direct:1'])

    const directRepeat0 = scheduled[0]!
    const candidateRepeat0 = scheduled[1]!
    const direct = projectStrategyCell(
      completedResult({ verdict: 'achieved', cell: { id: directRepeat0.id, caseId: 'case', variantId: 'direct', repeat: 0 } }),
      evidence({ traces: [trace({ id: 1, sessionId: 'parent' })] }), rates)
    const candidate = projectStrategyCell(
      completedResult({ verdict: 'achieved', cell: { id: candidateRepeat0.id, caseId: 'case', variantId: 'adaptive-strategy', repeat: 0 } }),
      evidence({
        children: ['child-1'],
        traces: [trace({ id: 1, sessionId: 'parent' }), trace({ id: 2, sessionId: 'child-1' })],
      }), rates)

    const pairs = pairStrategyCells(input, [direct, candidate])
    expect(pairs).toHaveLength(2)
    expect(pairs[0]).toMatchObject({
      caseId: 'case', repeat: 0, directCellId: directRepeat0.id, candidateCellId: candidateRepeat0.id, comparable: true,
    })
    // Direct arm has zero child cost by construction; extra is exactly one added settled call.
    expect(pairs[0]!.coordination!.candidateChildren).toEqual({ modelCalls: 1, inputTokens: 10, outputTokens: 5, costUsdMicros: 20 })
    expect(pairs[0]!.coordination!.extra).toEqual({ modelCalls: 1, inputTokens: 10, outputTokens: 5, costUsdMicros: 20 })
    // The repeat-1 pair is absent entirely and therefore not comparable.
    expect(pairs[1]).toMatchObject({ repeat: 1, comparable: false, coordination: null, directCellId: null, candidateCellId: null })
  })

  test('an unknown arm makes the pair non-comparable even when the sibling completed', () => {
    const input = plan()
    const candidate = projectStrategyCell(
      completedResult({ verdict: 'not-achieved', cell: { id: 'cand', variantId: 'adaptive-strategy', repeat: 0 } }),
      evidence(), rates)
    const pairs = pairStrategyCells(input, [unknownStrategyCellProjection(unknownResult({ variantId: 'direct', repeat: 0 }, 'timeout')), candidate])
    expect(pairs[0]).toMatchObject({ comparable: false, coordination: null })
  })

  test('comparable pairs still report null (never estimated) extra cost when tariffs are incomplete', () => {
    const input = plan()
    // Cache-read usage without a cache-read tariff makes every per-trace cost null.
    const unpriced = trace({
      sessionId: 'parent',
      usage: { inputTokens: 10, uncachedInputTokens: 6, outputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 15 },
    })
    const direct = projectStrategyCell(
      completedResult({ verdict: 'achieved', cell: { id: 'd0', caseId: 'case', variantId: 'direct', repeat: 0, seed: 1 } }),
      evidence({ traces: [unpriced] }), rates)
    const candidate = projectStrategyCell(
      completedResult({ verdict: 'achieved', cell: { id: 'a0', caseId: 'case', variantId: 'adaptive-strategy', repeat: 0, seed: 1 } }),
      evidence({ children: ['child-1'], traces: [{ ...unpriced, id: 1, sessionId: 'parent' }, { ...unpriced, id: 2, sessionId: 'child-1' }] }), rates)
    const pair = pairStrategyCells(input, [direct, candidate])[0]!
    expect(pair.comparable).toBe(true)
    expect(pair.coordination!.extra).toMatchObject({ modelCalls: 1, inputTokens: 10, outputTokens: 5, costUsdMicros: null })
    expect(pair.coordination!.candidateChildren.costUsdMicros).toBeNull()
  })

  test('observed-call-count pairs report only the extra model calls; tokens stay zero and cost null', () => {
    const input = plan('observed-call-count')
    const scheduled = benchmarkSchedule(strategyBenchmarkJournalPlan(input))
    const callsTrace = (id: number, sessionId: string): SettledTrace => trace({ id, sessionId, reservedInputTokens: 0, reservedOutputTokens: 0, usage: null })
    const direct = projectStrategyCell(
      completedResult({ verdict: 'achieved', cell: { id: scheduled[0]!.id, caseId: 'case', variantId: 'direct', repeat: 0 } }),
      evidence({ traces: [callsTrace(1, 'parent')] }), rates)
    const candidate = projectStrategyCell(
      completedResult({ verdict: 'achieved', cell: { id: scheduled[1]!.id, caseId: 'case', variantId: 'adaptive-strategy', repeat: 0 } }),
      evidence({ children: ['child-1'], traces: [callsTrace(1, 'parent'), callsTrace(2, 'parent'), callsTrace(3, 'child-1')] }), rates)
    const pair = pairStrategyCells(input, [direct, candidate])[0]!
    expect(pair.comparable).toBe(true)
    expect(pair.coordination!.candidateChildren).toEqual({ modelCalls: 1, inputTokens: 0, outputTokens: 0, costUsdMicros: null })
    // 3 candidate calls - 1 direct call = 2 extra model calls; no token or monetary figures are invented.
    expect(pair.coordination!.extra).toEqual({ modelCalls: 2, inputTokens: 0, outputTokens: 0, costUsdMicros: null })
  })
})
