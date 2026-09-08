import { describe, expect, it } from 'vitest'
import { BenchmarkStore } from '../../src/benchmark/store.js'
import { emptyBenchmarkMetrics, runBenchmark } from '../../src/benchmark/runner.js'
import type { BenchmarkExecutionRequest } from '../../src/benchmark/runner.js'
import type { BenchmarkObservation, BenchmarkPlan } from '../../src/benchmark/types.js'

function plan(): BenchmarkPlan {
  const versions = { model: 'a'.repeat(64), prompt: 'b'.repeat(64), skills: 'c'.repeat(64), tools: 'd'.repeat(64), policy: 'e'.repeat(64), runtime: 'f'.repeat(64) }
  const features = { memory: true, planning: true, review: true, growth: true }
  return {
    schemaVersion: 1, id: 'run-1', dataset: { id: 'corpus', version: 'v1', digest: '1'.repeat(64), split: 'development' },
    comparison: 'capability', cases: [{ id: 'code', domain: 'code', inputDigest: '2'.repeat(64), acceptanceDigest: '3'.repeat(64) }],
    variants: [{ id: 'base', role: 'baseline', versions, features }, { id: 'candidate', role: 'candidate', versions, features }],
    budget: { durationMs: 1000, inputTokens: 10, outputTokens: 10, costUsdMicros: 10, toolCalls: 1 }, repeats: 2, seed: 42,
  }
}
function observed(request: BenchmarkExecutionRequest): BenchmarkObservation {
  return {
    versions: request.variant.versions, inputDigest: request.task.inputDigest, acceptanceDigest: request.task.acceptanceDigest,
    verdict: 'achieved', metrics: { inputTokens: 1, outputTokens: 1, costUsdMicros: 0, toolCalls: 0, rework: null, interventions: null, latencyMs: 999 },
    evidenceDigest: '4'.repeat(64), quiescent: true,
  }
}

describe('durable benchmark controller', () => {
  it('supports explicitly unpriced token budgets without inventing a monetary measurement', async () => {
    const store = new BenchmarkStore(':memory:')
    const input = plan(); input.budget.costUsdMicros = null
    try {
      const results = await runBenchmark(store, input, { async execute(request) {
        const value = observed(request); value.metrics.costUsdMicros = null; return value
      } })
      expect(results).toHaveLength(4)
      expect(results.every(result => result.status === 'completed' && result.metrics.costUsdMicros === null)).toBe(true)
    } finally { store.close() }
  })
  it('records intent before dispatch and never replays completed cells', async () => {
    const store = new BenchmarkStore(':memory:')
    try {
      const input = plan(); const seeds: number[] = []
      const execute = async (request: BenchmarkExecutionRequest): Promise<BenchmarkObservation> => {
        expect(store.plan(input.id)).toEqual(input)
        expect(() => store.start(input.id, request.cell, Date.now())).toThrow()
        expect(Object.isFrozen(request.variant)).toBe(true)
        seeds.push(request.cell.seed)
        return { ...observed(request), verdict: request.variant.role === 'baseline' ? 'not-achieved' : 'achieved' }
      }
      const results = await runBenchmark(store, input, { execute })
      expect(results.map(result => result.verdict)).toEqual(['not-achieved', 'achieved', 'achieved', 'not-achieved'])
      expect(results[0]!.metrics.latencyMs).not.toBe(999)
      expect(seeds[0]).toBe(seeds[1]); expect(seeds[2]).toBe(seeds[3])
      await runBenchmark(store, input, { execute })
      expect(seeds).toHaveLength(4)
    } finally { store.close() }
  })
  it.each(['model', 'input', 'acceptance', 'cost', 'missing-cost', 'quiescence'] as const)('rejects %s drift and halts successors', async defect => {
    const store = new BenchmarkStore(':memory:')
    let calls = 0
    try {
      const results = await runBenchmark(store, plan(), { async execute(request) {
        calls++
        const value = observed(request)
        if (defect === 'model') value.versions = { ...value.versions, model: '9'.repeat(64) }
        if (defect === 'input') value.inputDigest = '9'.repeat(64)
        if (defect === 'acceptance') value.acceptanceDigest = '9'.repeat(64)
        if (defect === 'cost') value.metrics.costUsdMicros = 11
        if (defect === 'missing-cost') value.metrics.costUsdMicros = null
        if (defect === 'quiescence') value.quiescent = false
        return value
      } })
      expect(calls).toBe(1)
      expect(results[0]!.verdict).toBe('unknown')
      expect(results[0]!.status).toBe('unknown')
      expect(results[0]!.evidenceDigest).toBeNull()
    } finally { store.close() }
  })
  it('bounds a hung executor, signals cancellation and ignores a late successful result', async () => {
    const store = new BenchmarkStore(':memory:')
    const input = plan(); input.budget.durationMs = 10
    let finish!: (observation: BenchmarkObservation) => void
    let captured!: BenchmarkExecutionRequest
    try {
      const results = await runBenchmark(store, input, { execute(request) {
        captured = request
        return new Promise(resolve => { finish = resolve })
      } })
      expect(captured.signal.aborted).toBe(true)
      expect(results).toHaveLength(1)
      expect(results[0]!.reason).toBe('timeout')
      expect(results[0]!.metrics).toEqual(emptyBenchmarkMetrics())
      finish(observed(captured))
      await Promise.resolve()
      expect(store.results(input.id)).toEqual(results)
      let relaunched = false
      await runBenchmark(store, input, { async execute(request) { relaunched = true; return observed(request) } })
      expect(relaunched).toBe(false)
    } finally { store.close() }
  })
  it('stops on caller cancellation and refuses an unfinished intent from another controller', async () => {
    const store = new BenchmarkStore(':memory:')
    const controller = new AbortController()
    let started!: () => void
    const began = new Promise<void>(resolve => { started = resolve })
    try {
      const running = runBenchmark(store, plan(), { execute() { started(); return new Promise(() => {}) } }, controller.signal)
      await began
      await expect(runBenchmark(store, plan(), { async execute(request) { return observed(request) } })).rejects.toThrow()
      controller.abort()
      expect((await running)[0]!.reason).toBe('interrupted')
    } finally { store.close() }
  })
  it('binds a synchronous failure snapshot without awaiting or accepting late success', async () => {
    const store = new BenchmarkStore(':memory:')
    const input = plan(); input.budget.durationMs = 10
    let calls = 0
    try {
      const results = await runBenchmark(store, input, {
        execute() { calls++; return new Promise(() => {}) },
        failure(request, reason) {
          expect(request.signal.aborted).toBe(true); expect(reason).toBe('timeout')
          return { ...observed(request), verdict: 'unknown', metrics: emptyBenchmarkMetrics(), quiescent: false }
        },
      })
      expect(calls).toBe(1)
      expect(results[0]).toMatchObject({ status: 'unknown', verdict: 'unknown', evidenceDigest: '4'.repeat(64), reason: 'timeout' })
    } finally { store.close() }
  })
  it.each(['upgrade', 'drift', 'throw'] as const)('keeps original unknown when failure diagnostics %s', async defect => {
    const store = new BenchmarkStore(':memory:')
    try {
      const results = await runBenchmark(store, plan(), {
        async execute() { throw new Error('provider failed') },
        failure(request) {
          if (defect === 'throw') throw new Error('diagnostics unavailable')
          return { ...observed(request), verdict: defect === 'upgrade' ? 'achieved' : 'unknown',
            inputDigest: defect === 'drift' ? '9'.repeat(64) : request.task.inputDigest }
        },
      })
      expect(results[0]).toMatchObject({ status: 'unknown', verdict: 'unknown', evidenceDigest: null, reason: 'adapter-error' })
    } finally { store.close() }
  })
})
