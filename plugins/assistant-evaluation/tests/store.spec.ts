import { chmodSync, closeSync, mkdtempSync, openSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { evaluationSchemaVersion, openEvaluationDatabase } from '../src/sqlite.ts'
import { EvaluationStore, EvaluationStoreError } from '../src/store.ts'
import type { OutcomeEnvelope } from '../src/types.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'assistant-evaluation-store-'))
  roots.push(value)
  return value
}

function envelope(overrides: Partial<OutcomeEnvelope> = {}): OutcomeEnvelope {
  return {
    scope: { workspace: '/work/alpha', preset: 'primary' },
    situation: 'weekly-report',
    executionStatus: 'succeeded',
    objectiveStatus: 'achieved',
    deliveryStatus: 'delivered',
    source: { kind: 'automation', id: 'automation:weekly-report' },
    trust: 'trusted',
    evidence: [{ kind: 'run', ref: 'run-1', digest: 'sha256:abc' }],
    metrics: { costUsdMicros: 120, latencyMs: 900, inputTokens: 50, outputTokens: 25, toolCalls: 2 },
    occurredAt: 1_000,
    idempotencyKey: 'outcome:weekly-report:1',
    evaluator: { id: 'automation-runner', version: '1.0.0' },
    ...overrides,
  }
}

describe('evaluation database', () => {
  test('creates a private WAL/FULL database through the migration path', () => {
    const path = join(root(), 'private', 'evaluation.sqlite')
    const database = openEvaluationDatabase(path)
    expect((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      .toBe(evaluationSchemaVersion)
    expect((database.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
    expect((database.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous).toBe(2)
    database.close()
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(path, '..')).mode & 0o077).toBe(0)
  })

  test('rejects relative paths, unsafe pre-existing files and newer schemas', () => {
    expect(() => openEvaluationDatabase('relative.sqlite')).toThrowError(/absolute/i)

    const unsafe = join(root(), 'unsafe.sqlite')
    closeSync(openSync(unsafe, 'w', 0o666))
    chmodSync(unsafe, 0o644)
    expect(() => openEvaluationDatabase(unsafe)).toThrowError(/permission/i)

    const future = join(root(), 'future.sqlite')
    const database = new DatabaseSync(future)
    database.exec(`PRAGMA user_version = ${evaluationSchemaVersion + 1}`)
    database.close()
    chmodSync(future, 0o600)
    expect(() => openEvaluationDatabase(future)).toThrowError(/newer/i)
  })

  test('migrates a version-one outcome ledger to linked self assessments', () => {
    const path = join(root(), 'v1.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE evaluation_schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO evaluation_schema_meta(key, value) VALUES ('schema-version', '1');
      CREATE TABLE evaluation_outcomes (id TEXT PRIMARY KEY) STRICT;
      PRAGMA user_version = 1;
    `)
    legacy.close()
    chmodSync(path, 0o600)

    const migrated = openEvaluationDatabase(path)
    expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      .toBe(evaluationSchemaVersion)
    expect((migrated.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_schema
      WHERE type = 'table' AND name = 'evaluation_self_assessments'
    `).get() as { count: number }).count).toBe(1)
    migrated.close()
  })
})

describe('evaluation store', () => {
  test('keeps execution, objective and delivery outcomes separate and replays exactly', () => {
    const store = new EvaluationStore({ path: ':memory:', now: () => 5_000 })
    const first = store.append(envelope())
    expect(first).toMatchObject({
      executionStatus: 'succeeded', objectiveStatus: 'achieved', deliveryStatus: 'delivered',
      recordedAt: 5_000,
    })
    expect(store.append(envelope())).toEqual(first)
    expect(() => store.append(envelope({ objectiveStatus: 'partial' })))
      .toThrowError(expect.objectContaining<Partial<EvaluationStoreError>>({ code: 'idempotency-conflict' }))
    store.close()
  })

  test('isolates exact scopes and enforces query filters and hard limits', () => {
    const store = new EvaluationStore({ path: ':memory:', maxQueryLimit: 2 })
    store.append(envelope())
    store.append(envelope({
      scope: { workspace: '/work/beta', preset: 'primary' }, idempotencyKey: 'beta', occurredAt: 2_000,
    }))
    store.append(envelope({
      situation: 'daily-plan', idempotencyKey: 'alpha-2', occurredAt: 3_000,
      executionStatus: 'failed', objectiveStatus: 'not-achieved', deliveryStatus: 'not-required',
      trust: 'self-reported', source: { kind: 'foreground', id: 'agent:primary' }, evidence: [], metrics: {},
    }))

    expect(store.query({ scope: { workspace: '/work/alpha', preset: 'primary' }, limit: 2 }))
      .toHaveLength(2)
    expect(store.query({
      scope: { workspace: '/work/alpha', preset: 'primary' }, situation: 'weekly-report',
      fromOccurredAt: 900, toOccurredAt: 1_100, limit: 2,
    }).map(item => item.idempotencyKey)).toEqual(['outcome:weekly-report:1'])
    expect(store.query({ scope: { workspace: '/work/beta', preset: 'primary' }, limit: 2 }))
      .toHaveLength(1)
    expect(() => store.query({ scope: { workspace: '/work/alpha', preset: 'primary' }, limit: 3 }))
      .toThrowError(/limit/i)
    expect(() => store.query({ scope: { workspace: 'relative', preset: 'primary' }, limit: 1 }))
      .toThrowError(/absolute/i)
    store.close()
  })

  test('summarizes status matrices and standard resource metrics over a bounded window', () => {
    const store = new EvaluationStore({ path: ':memory:', now: () => 10_000, maxSummaryWindowMs: 10_000 })
    store.append(envelope())
    store.append(envelope({
      idempotencyKey: 'outcome:2', occurredAt: 2_000, executionStatus: 'failed',
      objectiveStatus: 'partial', deliveryStatus: 'failed', trust: 'external',
      metrics: { costUsdMicros: 80, latencyMs: 1_100, inputTokens: 75, outputTokens: 30, toolCalls: 4 },
    }))
    const summary = store.summary({
      scope: { workspace: '/work/alpha', preset: 'primary' }, fromOccurredAt: 0, toOccurredAt: 10_000,
    })
    expect(summary).toMatchObject({
      total: 2,
      execution: { succeeded: 1, failed: 1, timedOut: 0, cancelled: 0, unknown: 0 },
      objective: { achieved: 1, partial: 1, notAchieved: 0, unknown: 0 },
      delivery: { delivered: 1, failed: 1, notRequired: 0, unknown: 0 },
      trust: { trusted: 1, selfReported: 0, external: 1 },
      metrics: { costUsdMicros: 200, inputTokens: 125, outputTokens: 55, toolCalls: 6, averageLatencyMs: 1_000 },
    })
    expect(() => store.summary({
      scope: { workspace: '/work/alpha', preset: 'primary' }, fromOccurredAt: 0, toOccurredAt: 10_001,
    })).toThrowError(/window/i)
    store.close()
  })

  test('rejects oversized, malformed or non-JSON evidence and metrics', () => {
    const store = new EvaluationStore({ path: ':memory:', maxMetricsBytes: 100, maxEvidenceRefs: 1 })
    expect(() => store.append(envelope({ evidence: [
      { kind: 'run', ref: 'one' }, { kind: 'run', ref: 'two' },
    ] }))).toThrowError(/evidence/i)
    expect(() => store.append(envelope({ idempotencyKey: 'large', metrics: { note: 'x'.repeat(200) } })))
      .toThrowError(/metrics/i)
    expect(() => store.append(envelope({ idempotencyKey: 'nan', metrics: { latencyMs: Number.NaN } })))
      .toThrowError(/metrics/i)
    expect(() => store.append(envelope({ idempotencyKey: 'negative', metrics: { toolCalls: -1 } })))
      .toThrowError(/toolCalls/i)
    store.close()
  })

  test('stores a scope-bound self assessment without double-counting the parent outcome', () => {
    const store = new EvaluationStore({ path: ':memory:', now: () => 5_000 })
    const outcome = store.append(envelope({ objectiveStatus: 'unknown' }))
    const input = {
      outcomeId: outcome.id,
      scope: outcome.scope,
      objectiveStatus: 'achieved' as const,
      evidence: [{ kind: 'memory-review', ref: 'memory-snapshot-1' }],
      occurredAt: 2_000,
      idempotencyKey: 'self-assessment:1',
      evaluator: { id: 'memory-assisted-reviewer', version: '1' },
    }
    const assessment = store.appendSelfAssessment(input)
    expect(assessment).toMatchObject({
      outcomeId: outcome.id,
      scope: outcome.scope,
      situation: 'weekly-report',
      executionStatus: 'succeeded',
      objectiveStatus: 'achieved',
      deliveryStatus: 'delivered',
      trust: 'self-reported',
      recordedAt: 5_000,
    })
    expect(store.appendSelfAssessment(input)).toEqual(assessment)
    expect(store.latestSelfAssessments(outcome.scope, [outcome.id])).toEqual([assessment])
    expect(store.latestSelfAssessments({ workspace: '/work/beta', preset: 'primary' }, [outcome.id])).toEqual([])
    expect(() => store.appendSelfAssessment({ ...input, objectiveStatus: 'partial' }))
      .toThrowError(expect.objectContaining<Partial<EvaluationStoreError>>({ code: 'idempotency-conflict' }))
    expect(() => store.appendSelfAssessment({
      ...input,
      idempotencyKey: 'wrong-scope',
      scope: { workspace: '/work/beta', preset: 'primary' },
    })).toThrowError(/scope/i)
    expect(store.summary({ scope: outcome.scope, fromOccurredAt: 0, toOccurredAt: 5_000 }).total).toBe(1)
    expect(store.health()).toMatchObject({ outcomes: 1, selfAssessments: 1 })
    store.close()
  })
})
