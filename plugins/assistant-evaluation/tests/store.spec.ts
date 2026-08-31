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
      CREATE TABLE evaluation_outcomes (
        id TEXT PRIMARY KEY,
        trust TEXT NOT NULL,
        objective_status TEXT NOT NULL,
        recorded_at INTEGER NOT NULL
      ) STRICT;
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

  test('conservatively backfills version-three rows into a durable task projection', () => {
    const path = join(root(), 'v3.sqlite')
    const current = openEvaluationDatabase(path)
    current.exec(`
      DROP VIEW evaluation_task_projection_view;
      DROP TABLE evaluation_scope_watermarks;
      DROP TABLE evaluation_task_projections;
      DROP INDEX evaluation_outcomes_task_subject;
      ALTER TABLE evaluation_outcomes DROP COLUMN task_subject_key;
      ALTER TABLE evaluation_outcomes DROP COLUMN task_subject_kind;
      ALTER TABLE evaluation_outcomes DROP COLUMN task_subject_ref;
      UPDATE evaluation_schema_meta SET value = '3' WHERE key = 'schema-version';
      PRAGMA user_version = 3;
    `)
    const insert = current.prepare(`
      INSERT INTO evaluation_outcomes(
        id, idempotency_key, payload_hash, scope_key, workspace, preset, situation,
        execution_status, objective_status, delivery_status, source_kind, source_id,
        trust, evidence_json, metrics_json, cost_usd_micros, latency_ms, input_tokens,
        output_tokens, tool_calls, occurred_at, recorded_at, evaluator_id, evaluator_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const scopeKey = JSON.stringify(['/work/alpha', 'primary'])
    const runId = 'run-migrated-v3'
    insert.run(
      'legacy-terminal', 'legacy-terminal-key', 'terminal-hash', scopeKey, '/work/alpha', 'primary',
      'automation:migrated', 'succeeded', 'unknown', 'not-required', 'automation', 'assistant-automations',
      'trusted', JSON.stringify([{ kind: 'automation-run', ref: runId }]),
      JSON.stringify({ outputTokens: 9 }), null, 10, null, 9, null, 1_000, 1_000,
      'assistant-automations', 'terminal-v1',
    )
    insert.run(
      'legacy-owner', 'legacy-owner-key', 'owner-hash', scopeKey, '/work/alpha', 'primary',
      'automation:migrated', 'succeeded', 'achieved', 'delivered', 'user-feedback',
      'assistant-delivery/typed-owner-feedback', 'trusted', JSON.stringify([
        { kind: 'automation-run', ref: runId }, { kind: 'delivery-outbox', ref: 'legacy-outbox' },
      ]), '{}', null, null, null, null, null, 1_000, 2_000,
      'assistant-delivery-owner-feedback', '2',
    )
    current.close()

    const store = new EvaluationStore({ path })
    expect(store.query({ scope: { workspace: '/work/alpha', preset: 'primary' }, limit: 10 }))
      .toHaveLength(2)
    expect(store.queryTasks({ scope: { workspace: '/work/alpha', preset: 'primary' }, limit: 10 }))
      .toEqual([expect.objectContaining({
        id: 'legacy-terminal', objectiveStatus: 'achieved', deliveryStatus: 'delivered',
        metrics: { outputTokens: 9 },
        projection: expect.objectContaining({ subjectKind: 'automation-run', subjectRef: runId }),
      })])
    expect(store.health()).toMatchObject({ schemaVersion: 7, taskProjections: 1 })
    store.close()
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

  test('queues every trusted semantic revision, including a retract, and settles projection idempotently', () => {
    let now = 5_000
    const store = new EvaluationStore({ path: ':memory:', now: () => now })
    const eligible = store.append(envelope())
    const retract = store.append(envelope({ idempotencyKey: 'unknown', objectiveStatus: 'unknown' }))
    store.append(envelope({ idempotencyKey: 'untrusted', trust: 'self-reported' }))
    expect(store.listPendingProjections()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        evaluationId: eligible.id,
        scope: eligible.scope,
        status: 'pending',
        attemptCount: 0,
      }),
      expect.objectContaining({
        evaluationId: retract.id,
        scope: retract.scope,
        status: 'pending',
        attemptCount: 0,
      }),
    ]))
    expect(store.completeProjection({ evaluationId: retract.id, now })).toBe(true)
    now = 5_100
    expect(store.deferProjection({
      evaluationId: eligible.id, now, retryAt: now + 1_000, failureCode: 'sink-unavailable',
    })).toBe(true)
    expect(store.listPendingProjections(10, now)).toEqual([])
    expect(store.health()).toMatchObject({
      pendingProjections: 1, retryingProjections: 1, projectionAttempts: 1,
    })
    now += 1_000
    expect(store.listPendingProjections(10, now)[0]).toMatchObject({ attemptCount: 1 })
    expect(store.completeProjection({ evaluationId: eligible.id, now })).toBe(true)
    expect(store.completeProjection({ evaluationId: eligible.id, now })).toBe(false)
    expect(store.health()).toMatchObject({ pendingProjections: 0 })
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

  test('projects one Automation task from terminal execution plus authenticated owner objective feedback', () => {
    let now = 5_000
    const store = new EvaluationStore({ path: ':memory:', now: () => now })
    const runId = `run-task-occ-${'a'.repeat(64)}`
    const terminal = store.append(envelope({
      situation: 'automation:weekly-report',
      objectiveStatus: 'unknown',
      deliveryStatus: 'not-required',
      source: { kind: 'automation', id: 'assistant-automations' },
      evidence: [{ kind: 'automation-run', ref: runId }],
      metrics: { costUsdMicros: 120, latencyMs: 900, inputTokens: 50, outputTokens: 25, toolCalls: 2 },
      idempotencyKey: `assistant-automations:terminal:${runId}:v1`,
      evaluator: { id: 'assistant-automations', version: 'terminal-v1' },
    }))
    now = 6_000
    const owner = store.append(envelope({
      situation: 'automation:weekly-report',
      objectiveStatus: 'achieved',
      deliveryStatus: 'delivered',
      source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' },
      evidence: [
        { kind: 'automation-run', ref: runId },
        { kind: 'delivery-outbox', ref: 'outbox-1' },
      ],
      metrics: {},
      idempotencyKey: 'assistant-delivery:objective-feedback-v2:one',
      evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' },
    }))

    expect(store.query({ scope: terminal.scope, limit: 10 })).toHaveLength(2)
    expect(store.queryTasks({ scope: terminal.scope, limit: 10 })).toEqual([
      expect.objectContaining({
        id: terminal.id,
        executionStatus: 'succeeded',
        objectiveStatus: 'achieved',
        deliveryStatus: 'delivered',
        source: { kind: 'automation', id: 'assistant-automations' },
        metrics: { costUsdMicros: 120, latencyMs: 900, inputTokens: 50, outputTokens: 25, toolCalls: 2 },
        projection: expect.objectContaining({
          subjectKind: 'automation-run',
          subjectRef: runId,
          status: 'ready',
          primaryOutcomeId: terminal.id,
          executionOutcomeId: terminal.id,
          objectiveOutcomeId: owner.id,
          deliveryOutcomeId: owner.id,
          learningVersion: 2,
          learningDisposition: 'upsert',
        }),
      }),
    ])
    expect(store.summary({ scope: terminal.scope, fromOccurredAt: 0, toOccurredAt: 10_000 }))
      .toMatchObject({
        total: 1,
        execution: { succeeded: 1 },
        objective: { achieved: 1, unknown: 0 },
        delivery: { delivered: 1 },
        trust: { trusted: 1 },
        metrics: { costUsdMicros: 120, inputTokens: 50, outputTokens: 25, toolCalls: 2 },
      })
    store.close()
  })

  test('does not let linked self-reported or unauthenticated feedback override a trusted terminal task', () => {
    let now = 5_000
    const store = new EvaluationStore({ path: ':memory:', now: () => now })
    const runId = `run-task-occ-${'b'.repeat(64)}`
    const terminal = store.append(envelope({
      objectiveStatus: 'unknown', deliveryStatus: 'not-required',
      source: { kind: 'automation', id: 'assistant-automations' },
      evidence: [{ kind: 'automation-run', ref: runId }], metrics: { toolCalls: 3 },
      idempotencyKey: 'terminal-self-report',
      evaluator: { id: 'assistant-automations', version: 'terminal-v1' },
    }))
    now = 6_000
    store.append(envelope({
      objectiveStatus: 'achieved', deliveryStatus: 'delivered', trust: 'self-reported',
      source: { kind: 'foreground', id: 'agent:primary' },
      evidence: [{ kind: 'automation-run', ref: runId }], metrics: { toolCalls: 99 },
      idempotencyKey: 'linked-self-report', evaluator: { id: 'model-review', version: '1' },
    }))
    now = 7_000
    store.append(envelope({
      objectiveStatus: 'not-achieved', deliveryStatus: 'delivered', trust: 'trusted',
      source: { kind: 'user-feedback', id: 'legacy-untyped-feedback' },
      evidence: [{ kind: 'automation-run', ref: runId }], metrics: {},
      idempotencyKey: 'linked-untyped-feedback', evaluator: { id: 'legacy-feedback', version: '1' },
    }))
    expect(store.queryTasks({ scope: terminal.scope, limit: 10 })[0]).toMatchObject({
      id: terminal.id,
      objectiveStatus: 'unknown',
      deliveryStatus: 'not-required',
      trust: 'trusted',
      metrics: { toolCalls: 3 },
    })
    store.close()
  })

  test('quarantines conflicting owner objectives instead of resolving them by last write', () => {
    let now = 5_000
    const store = new EvaluationStore({ path: ':memory:', now: () => now })
    const runId = `run-task-occ-${'c'.repeat(64)}`
    const terminal = store.append(envelope({
      objectiveStatus: 'unknown', deliveryStatus: 'not-required',
      source: { kind: 'automation', id: 'assistant-automations' },
      evidence: [{ kind: 'automation-run', ref: runId }], metrics: {}, idempotencyKey: 'terminal-conflict',
      evaluator: { id: 'assistant-automations', version: 'terminal-v1' },
    }))
    const owner = (objectiveStatus: 'achieved' | 'not-achieved', key: string) => store.append(envelope({
      objectiveStatus, deliveryStatus: 'delivered',
      source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' },
      evidence: [
        { kind: 'automation-run', ref: runId },
        { kind: 'delivery-outbox', ref: 'outbox-conflict' },
      ],
      metrics: {}, idempotencyKey: key,
      evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' },
    }))
    now = 6_000
    owner('achieved', 'owner-achieved')
    now = 7_000
    owner('not-achieved', 'owner-not-achieved')

    expect(store.query({ scope: terminal.scope, limit: 10 })).toHaveLength(3)
    expect(store.queryTasks({ scope: terminal.scope, limit: 10 })[0]).toMatchObject({
      objectiveStatus: 'unknown',
      deliveryStatus: 'delivered',
      projection: { status: 'objective-conflict' },
    })
    expect(store.queryTasks({ scope: terminal.scope, limit: 10 })[0]?.projection.objectiveOutcomeId)
      .toBeUndefined()
    expect(store.summary({ scope: terminal.scope, fromOccurredAt: 0, toOccurredAt: 10_000 }))
      .toMatchObject({ total: 1, objective: { achieved: 0, notAchieved: 0, unknown: 1 } })
    expect(store.health()).toMatchObject({ taskProjections: 1, conflictedTaskProjections: 1 })
    store.close()
  })

  test('collapses repeated equal owner judgements and uses recorded time as the deterministic tie-break', () => {
    let now = 5_000
    const store = new EvaluationStore({ path: ':memory:', now: () => now })
    const runId = `run-task-occ-${'e'.repeat(64)}`
    const terminal = store.append(envelope({
      objectiveStatus: 'unknown', deliveryStatus: 'not-required',
      source: { kind: 'automation', id: 'assistant-automations' },
      evidence: [{ kind: 'automation-run', ref: runId }], metrics: {}, idempotencyKey: 'repeat-terminal',
      evaluator: { id: 'assistant-automations', version: 'terminal-v1' },
    }))
    const appendOwner = (key: string) => store.append(envelope({
      objectiveStatus: 'partial', deliveryStatus: 'delivered',
      source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' },
      evidence: [
        { kind: 'automation-run', ref: runId }, { kind: 'delivery-outbox', ref: 'repeat-outbox' },
      ],
      metrics: {}, idempotencyKey: key,
      evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' },
    }))
    now = 6_000
    appendOwner('repeat-owner-one')
    now = 7_000
    const latestOwner = appendOwner('repeat-owner-two')
    expect(store.query({ scope: terminal.scope, limit: 10 })).toHaveLength(3)
    expect(store.queryTasks({ scope: terminal.scope, limit: 10 })).toEqual([
      expect.objectContaining({
        objectiveStatus: 'partial',
        projection: expect.objectContaining({
          status: 'ready', objectiveOutcomeId: latestOwner.id, deliveryOutcomeId: latestOwner.id,
        }),
      }),
    ])
    expect(store.summary({ scope: terminal.scope, fromOccurredAt: 0, toOccurredAt: 10_000 }))
      .toMatchObject({ total: 1, objective: { partial: 1 } })
    store.close()
  })

  test('keeps outcomes without one exact Automation run reference as independent tasks', () => {
    const store = new EvaluationStore({ path: ':memory:' })
    const first = store.append(envelope({ idempotencyKey: 'independent-one', evidence: [] }))
    store.append(envelope({
      idempotencyKey: 'independent-two', evidence: [
        { kind: 'automation-run', ref: 'run-one' },
        { kind: 'automation-run', ref: 'run-two' },
      ],
    }))
    const tasks = store.queryTasks({ scope: first.scope, limit: 10 })
    expect(tasks).toHaveLength(2)
    expect(tasks.every(task => task.projection.subjectKind === 'outcome')).toBe(true)
    store.close()
  })
})
