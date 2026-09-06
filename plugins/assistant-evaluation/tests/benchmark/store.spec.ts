import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { BenchmarkStore } from '../../src/benchmark/store.ts'
import { benchmarkSchedule } from '../../src/benchmark/schema.ts'
import type { BenchmarkPlan, BenchmarkResult } from '../../src/benchmark/types.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const root = () => { const path = mkdtempSync(join(tmpdir(), 'benchmark-store-')); roots.push(path); return path }
const digest = (value: string) => value.repeat(64).slice(0, 64)
const versions = () => ({ model: digest('a'), prompt: digest('b'), skills: digest('c'), tools: digest('d'), policy: digest('e'), runtime: digest('f') })
const features = () => ({ memory: false, planning: false, review: false, growth: false })
const plan = (): BenchmarkPlan => ({
  schemaVersion: 1, id: 'plan-1', dataset: { id: 'suite', version: '1', digest: digest('d'), split: 'development' }, comparison: 'capability',
  cases: [{ id: 'case-a', domain: 'code', inputDigest: digest('a'), acceptanceDigest: digest('c') }],
  variants: [{ id: 'baseline', role: 'baseline', versions: versions(), features: features() }, { id: 'candidate', role: 'candidate', versions: versions(), features: features() }],
  budget: { durationMs: 1000, inputTokens: 100, outputTokens: 100, costUsdMicros: 100, toolCalls: 10 }, repeats: 2, seed: 1,
})
const metrics = () => ({ inputTokens: 1, outputTokens: 1, costUsdMicros: 1, toolCalls: 1, rework: null, interventions: null, latencyMs: 1 })
const result = (input: BenchmarkPlan, index: number, startedAt = 10): BenchmarkResult => ({
  cell: benchmarkSchedule(input)[index]!, status: 'completed', verdict: 'achieved', metrics: metrics(), evidenceDigest: digest('e'), reason: 'verified', startedAt, completedAt: startedAt + 1,
})

describe('BenchmarkStore', () => {
  test('freezes a plan and replays the same manifest only', () => {
    const store = new BenchmarkStore(join(root(), 'benchmark.sqlite'))
    const input = plan()
    store.create(input)
    expect(store.plan(input.id)).toEqual(input)
    store.create(structuredClone(input))
    expect(() => store.create({ ...input, seed: 2 })).toThrow(/different|conflict/i)
    store.close()
  })

  test('persists a running intent and does not run it again after restart', () => {
    const path = join(root(), 'benchmark.sqlite')
    const input = plan()
    const first = new BenchmarkStore(path)
    first.create(input)
    const cell = benchmarkSchedule(input)[0]!
    expect(first.start(input.id, cell, 10)).toBe(true)
    first.close()
    const reopened = new BenchmarkStore(path)
    expect(() => reopened.start(input.id, cell, 11)).toThrow(/running intent/i)
    expect(reopened.results(input.id)).toEqual([])
    reopened.interrupt(input.id, 12)
    expect(reopened.results(input.id)).toEqual([expect.objectContaining({ cell, status: 'unknown', reason: 'interrupted', startedAt: 10, completedAt: 12 })])
    reopened.close()
  })

  test('allows only the scheduled first unfinished cell across connections', () => {
    const path = join(root(), 'benchmark.sqlite')
    const input = plan()
    const left = new BenchmarkStore(path)
    const right = new BenchmarkStore(path)
    left.create(input)
    const [first, second] = benchmarkSchedule(input)
    expect(() => left.start(input.id, second!, 10)).toThrow(/first unfinished/i)
    expect(left.start(input.id, first!, 10)).toBe(true)
    expect(() => right.start(input.id, second!, 10)).toThrow(/running intent/i)
    left.finish(input.id, result(input, 0))
    expect(right.start(input.id, second!, 20)).toBe(true)
    left.close(); right.close()
  })

  test('does not continue after an explicit interrupted terminal result', () => {
    const store = new BenchmarkStore(join(root(), 'benchmark.sqlite'))
    const input = plan(); const [first, second] = benchmarkSchedule(input)
    store.create(input)
    store.start(input.id, first!, 10)
    store.interrupt(input.id, 11)
    expect(() => store.start(input.id, second!, 12)).toThrow(/unknown terminal/i)
    store.close()
  })

  test('requires a result to match its intent and makes exact replay idempotent', () => {
    const store = new BenchmarkStore(join(root(), 'benchmark.sqlite'))
    const input = plan(); store.create(input)
    const [first, second] = benchmarkSchedule(input)
    expect(() => store.finish(input.id, result(input, 0))).toThrow(/running|intent/i)
    store.start(input.id, first!, 10)
    expect(() => store.finish(input.id, result(input, 0, 11))).toThrow(/started|intent/i)
    const exact = result(input, 0)
    store.finish(input.id, exact)
    store.finish(input.id, structuredClone(exact))
    expect(() => store.finish(input.id, { ...exact, verdict: 'not-achieved' })).toThrow(/different|conflict/i)
    expect(store.results(input.id)).toEqual([exact])
    expect(store.start(input.id, second!, 20)).toBe(true)
    store.close()
  })

  test('rejects non-scheduled cell identities and non-empty version-zero journals', () => {
    const store = new BenchmarkStore(join(root(), 'benchmark.sqlite'))
    const input = plan(); store.create(input)
    const first = benchmarkSchedule(input)[0]!
    expect(() => store.start(input.id, { ...first, caseId: 'other' }, 10)).toThrow(/exact|scheduled/i)
    store.close()

    const path = join(root(), 'legacy.sqlite')
    const database = new DatabaseSync(path)
    database.exec('CREATE TABLE legacy_state (value TEXT); PRAGMA user_version = 0')
    database.close(); chmodSync(path, 0o600)
    expect(() => new BenchmarkStore(path)).toThrow(/non-empty|version zero/i)

    const viewPath = join(root(), 'view-only.sqlite')
    const viewDatabase = new DatabaseSync(viewPath)
    viewDatabase.exec('CREATE VIEW legacy_view AS SELECT 1 AS value; PRAGMA user_version = 0')
    viewDatabase.close(); chmodSync(viewPath, 0o600)
    expect(() => new BenchmarkStore(viewPath)).toThrow(/non-empty|version zero/i)
    const unchanged = new DatabaseSync(viewPath)
    expect((unchanged.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name LIKE 'benchmark_journal_%'").get() as { count: number }).count).toBe(0)
    expect((unchanged.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(0)
    unchanged.close()
  })

  test('creates and reads the maximum 16,000-cell schedule without canonicalizing it as input data', () => {
    const input = plan()
    input.cases = Array.from({ length: 100 }, (_, index) => ({
      id: `case-${index}`, domain: 'code' as const,
      inputDigest: index.toString(16).padStart(64, 'a'), acceptanceDigest: index.toString(16).padStart(64, 'b'),
    }))
    const candidate = input.variants[1]!
    input.variants = [input.variants[0]!, ...Array.from({ length: 7 }, (_, index) => ({
      id: `candidate-${index}`, role: 'candidate' as const, versions: candidate.versions, features: candidate.features,
    }))]
    input.repeats = 20
    const store = new BenchmarkStore(join(root(), 'benchmark.sqlite'))
    store.create(input)
    expect(store.plan(input.id).cases).toHaveLength(100)
    store.close()
  })
})
