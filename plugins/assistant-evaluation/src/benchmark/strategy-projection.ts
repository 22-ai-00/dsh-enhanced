/**
 * Strategy-only read-only projection of the immutable evidence objects.
 *
 * This never becomes evidence itself: it re-derives coordination cost splits and a
 * conservative failure attribution from evidence that verifyStrategyBenchmarkResults
 * has already reopened and bound. The shared BenchmarkMetrics/BenchmarkResult shape
 * (persisted across suites and in the journal) is intentionally untouched.
 */
import { benchmarkSchedule } from './schema.js'
import { strategyBenchmarkJournalPlan, type StrategyBenchmarkPlan } from './strategy-plan.js'
import { StrategyEvidenceStore, type StrategyEvidenceObject } from './strategy-evidence.js'
import { tokenUsageCost, type TokenUsageRates } from './usage.js'
import type { BenchmarkResult } from './types.js'

export const strategyProjectionProtocol = 'dsh-native-goal-strategy-projection/v1'

/**
 * Criterion reasons emitted with status 'failed' by the independent verifier
 * (plugins/assistant-verifier drivers.ts failed() calls). Every one of these means
 * the candidate delivered an artifact that was actually inspected and found wrong.
 * artifact-unavailable / altered / timeout / io reasons are status 'unknown' and
 * cannot distinguish an undelivered artifact from a tool failure, so they stay unknown.
 */
export const behaviorFailureReasons = [
  'citation-mismatch', 'citation-missing', 'isolated-unexpected-exit-code', 'isolated-unexpected-stdout',
  'readback-object-mismatch', 'readback-revision-mismatch', 'readback-value-mismatch',
  'repository-head-mismatch', 'repository-requirements-not-met', 'required-text-missing',
  'unexpected-exit-code', 'unexpected-stdout',
] as const
const behaviorFailureReasonSet = new Set<string>(behaviorFailureReasons)

export type StrategyFailureClassification = 'achieved' | 'delivered-incorrect-behavior' | 'undelivered-or-unknown'

export interface StrategyCriterionAttribution {
  readonly criterionId: string
  /** Raw CriterionResult.reason, preserved verbatim for audit. */
  readonly reason: string
  /** True only for the independent-verifier behavior-failure whitelist; never inferred from model prose. */
  readonly behaviorFailure: boolean
}
export interface StrategyReceiptAttribution {
  readonly contractId: string
  readonly taskKind: 'goal-step' | 'goal-outcome'
  readonly objectiveStatus: 'achieved' | 'not-achieved' | 'unknown'
  readonly quiescent: boolean
  readonly failedCriteria: readonly StrategyCriterionAttribution[]
}
export interface StrategySessionCost {
  readonly modelCalls: number
  readonly inputTokens: number
  readonly outputTokens: number
  /** Null when any settled usage class lacks an exact tariff; never estimated. */
  readonly costUsdMicros: number | null
}
export interface StrategyCellProjection {
  readonly cellId: string
  readonly caseId: string
  readonly variantId: string
  readonly repeat: number
  readonly status: 'completed' | 'unknown'
  readonly verdict: 'achieved' | 'not-achieved' | 'unknown'
  readonly attribution: {
    readonly classification: StrategyFailureClassification
    /**
     * 'receipt-behavior-failure': an independent quiescent receipt has a failed
     * criterion on the behavior-failure whitelist.
     * 'infrastructure-unknown': a failure object; the infrastructure reason is preserved.
     * 'no-behavior-failure-receipt': completed cell without an auditable behavior failure.
     * 'achieved': the cell achieved its outcome contract.
     */
    readonly basis: 'achieved' | 'receipt-behavior-failure' | 'infrastructure-unknown' | 'no-behavior-failure-receipt'
    /** Present only for failure objects; BenchmarkResult.reason is infrastructure-level. */
    readonly infrastructureReason: BenchmarkResult['reason'] | null
    readonly receipts: readonly StrategyReceiptAttribution[]
  }
  /**
   * Settled-trace cost split by evidence-attributed session role. Null for unknown
   * cells because the run was not quiescent and a partial split cannot support a
   * paired conclusion.
   */
  readonly costs: {
    readonly parent: StrategySessionCost
    readonly children: StrategySessionCost
  } | null
}
export interface StrategyCoordinationPair {
  readonly caseId: string
  readonly repeat: number
  readonly directCellId: string | null
  readonly candidateCellId: string | null
  /** False when either arm is missing or unknown; such pairs cannot prove a cost. */
  readonly comparable: boolean
  /**
   * Two objective views of coordination cost, null unless comparable:
   * - candidateChildren: strategy-child sessions only (zero on the direct arm by construction).
   * - extra: whole-cell candidate minus direct, including any parent-call difference.
   */
  readonly coordination: {
    readonly candidateChildren: StrategySessionCost
    readonly extra: {
      readonly modelCalls: number
      readonly inputTokens: number
      readonly outputTokens: number
      readonly costUsdMicros: number | null
    }
  } | null
}
export interface StrategyBenchmarkProjection {
  readonly protocol: typeof strategyProjectionProtocol
  readonly version: 1
  /** True only when both base tariffs are configured; null costs accompany a false value. */
  readonly tariffComplete: boolean
  readonly cells: readonly StrategyCellProjection[]
  readonly pairs: readonly StrategyCoordinationPair[]
  /** A measurement projection never grants promotion authority. */
  readonly promotionAuthorized: false
}

type SettledTrace = StrategyEvidenceObject['meter']['traces'][number]

/**
 * Sums settled traces attributed to one session role, recomputing cost per trace.
 * A settled trace always counts one model call. In observed-call-count mode the
 * evidence meter freezes usage=null: the call still counts, tokens add nothing and
 * the monetary total becomes null (never estimated). Token-mode traces are
 * evidence-guaranteed to carry non-null usage, so usage=null is self-describing.
 */
export function accumulateSessionCost(traces: readonly SettledTrace[], sessions: ReadonlySet<string>, rates: Readonly<TokenUsageRates>): StrategySessionCost {
  let modelCalls = 0; let inputTokens = 0; let outputTokens = 0; let costUsdMicros: number | null = 0
  for (const trace of traces) {
    if (trace.phase !== 'settled' || trace.sessionId === null || !sessions.has(trace.sessionId)) continue
    modelCalls += 1
    if (trace.usage === null) { costUsdMicros = null; continue }
    inputTokens += trace.usage.inputTokens; outputTokens += trace.usage.outputTokens
    const cost = tokenUsageCost(trace.usage, rates)
    costUsdMicros = cost === null || costUsdMicros === null ? null : costUsdMicros + cost
  }
  return Object.freeze({ modelCalls, inputTokens, outputTokens, costUsdMicros })
}

function receiptAttribution(receipts: readonly ReceiptSignal[]): readonly StrategyReceiptAttribution[] {
  return Object.freeze(receipts.map(entry => Object.freeze({
    contractId: entry.contract.id, taskKind: entry.taskKind, objectiveStatus: entry.receipt.objectiveStatus, quiescent: entry.quiescent,
    failedCriteria: Object.freeze(entry.receipt.results
      .filter(result => result.status === 'failed')
      .map(result => Object.freeze({ criterionId: result.criterionId, reason: result.reason, behaviorFailure: behaviorFailureReasonSet.has(result.reason) }))),
  })))
}

/** Terminal unknown cell: a failure object proves uncertainty, never an acceptance. */
export function unknownStrategyCellProjection(result: BenchmarkResult): StrategyCellProjection {
  return Object.freeze({
    cellId: result.cell.id, caseId: result.cell.caseId, variantId: result.cell.variantId, repeat: result.cell.repeat,
    status: 'unknown', verdict: 'unknown',
    attribution: Object.freeze({ classification: 'undelivered-or-unknown', basis: 'infrastructure-unknown',
      infrastructureReason: result.reason, receipts: Object.freeze([]) }),
    costs: null,
  })
}

/** The only objective evidence fields the cell projection reads; the full object is structurally assignable. */
export interface ProjectedCellEvidence {
  readonly meter: { readonly traces: readonly SettledTrace[] }
  readonly native: {
    readonly parent: { readonly sessionId: string }
    readonly strategies: readonly { readonly children: readonly { readonly sessionId: string }[] }[]
    readonly receipts: readonly ReceiptSignal[]
  }
}
interface ReceiptSignal {
  readonly contract: { readonly id: string }
  readonly taskKind: 'goal-step' | 'goal-outcome'
  readonly quiescent: boolean
  readonly receipt: {
    readonly objectiveStatus: 'achieved' | 'not-achieved' | 'unknown'
    readonly results: readonly { readonly criterionId: string; readonly status: 'passed' | 'failed' | 'unknown'; readonly reason: string }[]
  }
}

/**
 * Pure derivation over a reopened, already-verified evidence object. No binding
 * checks are repeated here: callers must obtain `native` through the evidence store
 * after verifyStrategyBenchmarkResults, never from candidate prose.
 */
export function projectStrategyCell(result: BenchmarkResult, native: Readonly<ProjectedCellEvidence>, rates: Readonly<TokenUsageRates>): StrategyCellProjection {
  benchmarkAssertCompleted(result)
  const childSessions = new Set(native.native.strategies.flatMap(strategy => strategy.children.map(child => child.sessionId)))
  const costs = Object.freeze({
    parent: accumulateSessionCost(native.meter.traces, new Set([native.native.parent.sessionId]), rates),
    children: accumulateSessionCost(native.meter.traces, childSessions, rates),
  })
  const receipts = receiptAttribution(native.native.receipts)
  const hasBehaviorFailure = receipts.some(receipt => receipt.quiescent && receipt.failedCriteria.some(criterion => criterion.behaviorFailure))
  const classification: StrategyFailureClassification = result.verdict === 'achieved' ? 'achieved'
    : result.verdict === 'not-achieved' && hasBehaviorFailure ? 'delivered-incorrect-behavior'
    : 'undelivered-or-unknown'
  const basis = classification === 'achieved' ? 'achieved' as const
    : classification === 'delivered-incorrect-behavior' ? 'receipt-behavior-failure' as const
    : 'no-behavior-failure-receipt' as const
  return Object.freeze({
    cellId: result.cell.id, caseId: result.cell.caseId, variantId: result.cell.variantId, repeat: result.cell.repeat,
    status: 'completed', verdict: result.verdict,
    attribution: Object.freeze({ classification, basis, infrastructureReason: null, receipts }),
    costs,
  })
}

function benchmarkAssertCompleted(result: BenchmarkResult): void {
  if (result.status !== 'completed' || result.evidenceDigest === null) throw new Error('strategy projection: completed result requires bound evidence')
}

function totalCellCost(costs: NonNullable<StrategyCellProjection['costs']>): StrategySessionCost {
  const costUsdMicros = costs.parent.costUsdMicros === null || costs.children.costUsdMicros === null
    ? null : costs.parent.costUsdMicros + costs.children.costUsdMicros
  return Object.freeze({
    modelCalls: costs.parent.modelCalls + costs.children.modelCalls,
    inputTokens: costs.parent.inputTokens + costs.children.inputTokens,
    outputTokens: costs.parent.outputTokens + costs.children.outputTokens,
    costUsdMicros,
  })
}

/** Pairs direct/adaptive-strategy arms by (caseId, repeat) over the planned schedule. */
export function pairStrategyCells(plan: StrategyBenchmarkPlan, cells: readonly StrategyCellProjection[]): readonly StrategyCoordinationPair[] {
  const byKey = new Map(cells.map(cell => [`${cell.caseId} ${cell.variantId} ${cell.repeat}`, cell]))
  const meta: { caseId: string; repeat: number }[] = []
  const seen = new Set<string>()
  for (const cell of benchmarkSchedule(strategyBenchmarkJournalPlan(plan))) {
    const key = `${cell.caseId} ${cell.repeat}`
    if (!seen.has(key)) { seen.add(key); meta.push({ caseId: cell.caseId, repeat: cell.repeat }) }
  }
  return Object.freeze(meta.map(({ caseId, repeat }) => {
    const direct = byKey.get(`${caseId} direct ${repeat}`)
    const candidate = byKey.get(`${caseId} adaptive-strategy ${repeat}`)
    const comparable = direct !== undefined && candidate !== undefined && direct.status === 'completed' && candidate.status === 'completed'
      && direct.costs !== null && candidate.costs !== null
    let coordination: StrategyCoordinationPair['coordination'] = null
    if (comparable) {
      const directTotal = totalCellCost(direct.costs!)
      const candidateTotal = totalCellCost(candidate!.costs!)
      const extraCost = directTotal.costUsdMicros === null || candidateTotal.costUsdMicros === null ? null
        : candidateTotal.costUsdMicros - directTotal.costUsdMicros
      coordination = Object.freeze({
        candidateChildren: candidate!.costs!.children,
        extra: Object.freeze({
          modelCalls: candidateTotal.modelCalls - directTotal.modelCalls,
          inputTokens: candidateTotal.inputTokens - directTotal.inputTokens,
          outputTokens: candidateTotal.outputTokens - directTotal.outputTokens,
          costUsdMicros: extraCost,
        }),
      })
    }
    return Object.freeze({ caseId, repeat, directCellId: direct?.cellId ?? null, candidateCellId: candidate?.cellId ?? null, comparable, coordination })
  }))
}

/**
 * Reopens every evidence object (the caller must run verifyStrategyBenchmarkResults
 * first) and derives the strategy-only projection. Rates are the frozen model
 * tariffs; absent tariffs yield null costs rather than invented pricing.
 */
export function collectStrategyBenchmarkProjection(plan: StrategyBenchmarkPlan, results: readonly BenchmarkResult[],
  stateDirectory: string, workspaceDirectory: string, rates: Readonly<TokenUsageRates>): Readonly<StrategyBenchmarkProjection> {
  const evidence = new StrategyEvidenceStore({ stateDirectory, candidateWorkspace: workspaceDirectory, createDirectories: false })
  const tariffComplete = rates.inputUsdMicrosPerMillionTokens !== null && rates.outputUsdMicrosPerMillionTokens !== null
  const cells: StrategyCellProjection[] = []
  for (const result of results) {
    if (result.status === 'unknown') { cells.push(unknownStrategyCellProjection(result)); continue }
    const cell = evidence.readCell(plan, result.cell, result.evidenceDigest!)
    const native = evidence.read(plan, result.cell, cell.nativeEvidenceDigest)
    cells.push(projectStrategyCell(result, native, rates))
  }
  return Object.freeze({ protocol: strategyProjectionProtocol, version: 1, tariffComplete,
    cells: Object.freeze(cells), pairs: pairStrategyCells(plan, cells), promotionAuthorized: false })
}
