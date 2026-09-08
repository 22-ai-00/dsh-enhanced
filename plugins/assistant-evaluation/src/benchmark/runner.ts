import { acceptanceCanonicalJson } from '@dsh-enhanced/task-acceptance-contract'
import {
  benchmarkAssert, benchmarkHash, benchmarkObject, benchmarkSchedule, benchmarkSnapshot,
  parseBenchmarkMetrics, parseBenchmarkPlan,
} from './schema.js'
import { BenchmarkStore } from './store.js'
import type {
  BenchmarkBudget, BenchmarkCase, BenchmarkCell, BenchmarkMetrics, BenchmarkObservation,
  BenchmarkPlan, BenchmarkResult, BenchmarkVariant,
} from './types.js'

export interface BenchmarkExecutionRequest {
  readonly planId: string
  readonly dataset: BenchmarkPlan['dataset']
  readonly cell: BenchmarkCell
  readonly task: BenchmarkCase
  readonly variant: BenchmarkVariant
  readonly budget: BenchmarkBudget
  readonly signal: AbortSignal
}

/**
 * Trusted Host integration, not a model-produced result or a general-purpose process command.
 * Implementations must enforce budgets, isolate cells, inspect actually loaded versions and use
 * an independent judge. The controller checks returned evidence; it cannot establish OS isolation.
 */
export interface BenchmarkExecutor {
  execute(request: BenchmarkExecutionRequest): Promise<BenchmarkObservation>
  /** Synchronous Host snapshot after cancellation. Must never wait for possibly live work. */
  failure?(request: BenchmarkExecutionRequest, reason: Exclude<BenchmarkResult['reason'], 'verified'>): BenchmarkObservation | undefined
}

export const emptyBenchmarkMetrics = (): BenchmarkMetrics => ({
  inputTokens: null, outputTokens: null, costUsdMicros: null, toolCalls: null,
  rework: null, interventions: null, latencyMs: null,
})

function observation(input: unknown, request: BenchmarkExecutionRequest): BenchmarkObservation {
  const raw = benchmarkObject(benchmarkSnapshot(input), ['versions', 'inputDigest', 'acceptanceDigest', 'verdict', 'metrics', 'evidenceDigest', 'quiescent'])
  benchmarkAssert(acceptanceCanonicalJson(raw.versions) === acceptanceCanonicalJson(request.variant.versions)
    && raw.inputDigest === request.task.inputDigest && raw.acceptanceDigest === request.task.acceptanceDigest,
  'benchmark observation changed frozen inputs or versions')
  benchmarkHash(raw.evidenceDigest)
  benchmarkAssert(['achieved', 'not-achieved', 'unknown'].includes(raw.verdict as string) && typeof raw.quiescent === 'boolean', 'invalid benchmark observation')
  parseBenchmarkMetrics(raw.metrics)
  return raw as unknown as BenchmarkObservation
}

/** Serial by design: a cell must settle before another can use the Host resources. */
export async function runBenchmark(
  store: BenchmarkStore, input: BenchmarkPlan, executor: BenchmarkExecutor, signal?: AbortSignal,
): Promise<readonly BenchmarkResult[]> {
  const plan = parseBenchmarkPlan(input)
  store.create(plan)
  for (const cell of benchmarkSchedule(plan)) {
    if (signal?.aborted) break
    const recorded = store.results(plan.id)
    // Unknown transport/lifecycle means old work may still be running. Never launch its successor.
    if (recorded.some(result => result.status === 'unknown')) break
    if (recorded.some(result => result.cell.id === cell.id)) continue
    const startedAt = Date.now()
    if (!store.start(plan.id, cell, startedAt)) continue
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let removeAbort: (() => void) | undefined
    const request: BenchmarkExecutionRequest = Object.freeze({
      planId: plan.id, dataset: plan.dataset, cell,
      task: plan.cases.find(task => task.id === cell.caseId)!,
      variant: plan.variants.find(variant => variant.id === cell.variantId)!,
      budget: plan.budget, signal: controller.signal,
    })
    let result: BenchmarkResult
    const unknown = (reason: BenchmarkResult['reason'], metrics = emptyBenchmarkMetrics()): BenchmarkResult => ({
      cell, status: 'unknown', verdict: 'unknown', metrics, evidenceDigest: null,
      reason, startedAt, completedAt: Math.max(startedAt, Date.now()),
    })
    const startedMonotonic = performance.now()
    try {
      type Outcome = { kind: 'observation'; value: BenchmarkObservation } | { kind: 'error' | 'timeout' | 'interrupted' }
      const stop = new Promise<Outcome>(resolve => {
        const abort = (): void => { controller.abort(); resolve({ kind: 'interrupted' }) }
        signal?.addEventListener('abort', abort, { once: true })
        removeAbort = () => signal?.removeEventListener('abort', abort)
        if (signal?.aborted) abort()
        timer = setTimeout(() => { controller.abort(); resolve({ kind: 'timeout' }) }, plan.budget.durationMs)
      })
      const execution: Promise<Outcome> = Promise.resolve().then(async () => {
        if (controller.signal.aborted) return { kind: 'interrupted' } as const
        return { kind: 'observation', value: await executor.execute(request) } as const
      }).catch(() => ({ kind: 'error' } as const))
      const outcome = await Promise.race([execution, stop])
      const elapsed = Math.ceil(performance.now() - startedMonotonic)
      if (outcome.kind !== 'observation') {
        result = unknown(outcome.kind === 'error' ? 'adapter-error' : outcome.kind)
      } else if (signal?.aborted) {
        controller.abort()
        result = unknown('interrupted')
      } else {
        try {
          const value = observation(outcome.value, request)
          const metrics = { ...value.metrics, latencyMs: elapsed }
          const budgetKeys = ['inputTokens', 'outputTokens', 'toolCalls'] as const
          const missingCost = plan.budget.costUsdMicros !== null && metrics.costUsdMicros === null
          const exceededCost = plan.budget.costUsdMicros !== null && metrics.costUsdMicros !== null && metrics.costUsdMicros > plan.budget.costUsdMicros
          if (!value.quiescent) result = unknown('not-quiescent', metrics)
          else if (missingCost || budgetKeys.some(key => metrics[key] === null)) result = unknown('invalid-observation', metrics)
          else if (exceededCost || elapsed > plan.budget.durationMs || budgetKeys.some(key => metrics[key]! > plan.budget[key])) result = unknown('budget-exceeded', metrics)
          else result = {
            cell, status: 'completed', verdict: value.verdict, metrics,
            evidenceDigest: value.evidenceDigest, reason: 'verified',
            startedAt, completedAt: Math.max(startedAt, Date.now()),
          }
        } catch { result = unknown('invalid-observation') }
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      removeAbort?.()
    }
    if (result.status === 'unknown') {
      controller.abort()
      try {
        const captured = executor.failure?.(request, result.reason as Exclude<BenchmarkResult['reason'], 'verified'>)
        if (captured !== undefined) {
          const value = observation(captured, request)
          benchmarkAssert(value.verdict === 'unknown', 'failure snapshot cannot upgrade a result')
          result = { ...result, metrics: { ...value.metrics, latencyMs: result.metrics.latencyMs }, evidenceDigest: value.evidenceDigest }
        }
      } catch { /* The original unknown result remains authoritative if diagnostics cannot be saved. */ }
    }
    store.finish(plan.id, result)
    if (result.status === 'unknown') break
  }
  return store.results(plan.id)
}
