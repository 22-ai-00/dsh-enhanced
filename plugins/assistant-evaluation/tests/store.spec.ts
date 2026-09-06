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
      DROP TABLE evaluation_owner_commands;
      DROP TABLE evaluation_owner_revisions;
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
    expect(store.health()).toMatchObject({ schemaVersion: 10, taskProjections: 1 })
    store.close()
  })

  test('preserves a schema-nine projection and its evidence while rebuilding the v10 subject constraint', () => {
    const path = join(root(), 'v9.sqlite')
    const store = new EvaluationStore({ path, now: () => 2_000 })
    const stored = store.append(envelope({
      situation: 'automation:v9-migration',
      evidence: [{ kind: 'automation-run', ref: 'v9-run', digest: 'sha256:v9' }],
      idempotencyKey: 'v9-projection-evidence',
    }))
    expect(store.queryTasks({ scope: stored.scope, limit: 10 })).toEqual([
      expect.objectContaining({ id: stored.id, evidence: stored.evidence,
        projection: expect.objectContaining({ subjectKind: 'automation-run', subjectRef: 'v9-run' }) }),
    ])
    store.close()

    const legacy = new DatabaseSync(path)
    const v9View = legacy.prepare(`SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = 'evaluation_task_projection_view'`)
      .get() as { sql: string }
    legacy.exec(`
      DROP VIEW evaluation_task_projection_view;
      ALTER TABLE evaluation_task_projections RENAME TO evaluation_task_projections_v9_fixture;
      DROP INDEX evaluation_task_projections_scope_time;
      CREATE TABLE evaluation_task_projections (
        subject_key TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        subject_kind TEXT NOT NULL CHECK (subject_kind IN ('automation-run', 'foreground-turn', 'outcome')),
        subject_ref TEXT NOT NULL,
        primary_outcome_id TEXT,
        execution_outcome_id TEXT,
        objective_outcome_id TEXT,
        delivery_outcome_id TEXT,
        objective_conflicted INTEGER NOT NULL DEFAULT 0 CHECK (objective_conflicted IN (0, 1)),
        learning_version INTEGER NOT NULL DEFAULT 0 CHECK (learning_version >= 0),
        learning_digest TEXT CHECK (learning_digest IS NULL OR length(learning_digest) = 64),
        learning_disposition TEXT CHECK (learning_disposition IN ('upsert', 'retract')),
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (primary_outcome_id) REFERENCES evaluation_outcomes(id) ON DELETE RESTRICT,
        FOREIGN KEY (execution_outcome_id) REFERENCES evaluation_outcomes(id) ON DELETE RESTRICT,
        FOREIGN KEY (objective_outcome_id) REFERENCES evaluation_outcomes(id) ON DELETE RESTRICT,
        FOREIGN KEY (delivery_outcome_id) REFERENCES evaluation_outcomes(id) ON DELETE RESTRICT
      ) STRICT;
      CREATE INDEX evaluation_task_projections_scope_time
        ON evaluation_task_projections(scope_key, updated_at DESC, subject_key);
      ${v9View.sql};
      INSERT INTO evaluation_task_projections SELECT * FROM evaluation_task_projections_v9_fixture;
      DROP TABLE evaluation_task_projections_v9_fixture;
      UPDATE evaluation_schema_meta SET value = '9' WHERE key = 'schema-version';
      PRAGMA user_version = 9;
    `)
    legacy.close()

    const migrated = openEvaluationDatabase(path)
    expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(10)
    expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(migrated.prepare(`SELECT subject_kind, subject_ref, primary_outcome_id FROM evaluation_task_projections`).all())
      .toEqual([{ subject_kind: 'automation-run', subject_ref: 'v9-run', primary_outcome_id: stored.id }])
    expect(migrated.prepare(`SELECT evidence_json FROM evaluation_task_projection_view WHERE id = ?`).get(stored.id))
      .toEqual({ evidence_json: JSON.stringify(stored.evidence) })
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

describe('linked owner objective revisions', () => {
  test('keeps a legacy Automation run id equal to a typed subject label unambiguous', () => {
    const store = new EvaluationStore({ path: join(root(), 'legacy-subject-label.sqlite') })
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const runId = 'foreground-turn'
    const lineage = { principalRecordId: 'host-owner', principalVersion: 1 }
    store.append(envelope({ scope, evidence: [{ kind: 'automation-run', ref: runId }, { kind: 'delivery-outbox', ref: 'result' }],
      source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' },
      evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' }, idempotencyKey: 'legacy-label' }),
    { ...lineage, action: 'initial', operationId: 'legacy-label' })
    expect(store.ownerObjectiveState(scope, runId, lineage.principalRecordId, lineage.principalVersion))
      .toEqual({ version: 1, objectiveStatus: 'achieved' })
    store.close()
  })

  test('CAS revisions preserve immutable audit, quarantine independent conflict and never revive terminal success after withdrawal or restart', () => {
    const path = join(root(), 'owner.sqlite')
    let store = new EvaluationStore({ path, now: () => 2000 })
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const runId = 'owner-run'
    store.append(envelope({ scope, situation: 'automation:owner',
      source: { kind: 'automation', id: 'assistant-automations' },
      evaluator: { id: 'assistant-automations', version: 'terminal-v1' },
      evidence: [{ kind: 'automation-run', ref: runId }], idempotencyKey: 'terminal' }))
    const owner = (status: OutcomeEnvelope['objectiveStatus'], key: string) => envelope({
      scope, situation: 'automation:owner', objectiveStatus: status,
      source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' },
      evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' },
      evidence: [{ kind: 'automation-run', ref: runId }, { kind: 'delivery-outbox', ref: 'result' }],
      idempotencyKey: key,
    })
    const lineage = { principalRecordId: 'host-owner', principalVersion: 1 }
    const initial = store.append(owner('achieved', 'initial'), { ...lineage, action: 'initial', operationId: 'evt-1' })
    const initialVersion = store.queryTasks({ scope })[0]!.projection.learningVersion
    expect(store.append(owner('achieved', 'initial'), { ...lineage, action: 'initial', operationId: 'evt-2' }).id).toBe(initial.id)
    expect(store.queryTasks({ scope })[0]!.projection.learningVersion).toBe(initialVersion)
    expect(() => store.append(owner('not-achieved', 'initial'), { ...lineage, action: 'initial', operationId: 'evt-conflict' })).toThrow(/initial judgement/)
    const futureCommand = { ...lineage, action: 'correct' as const, operationId: 'future-command', expectedVersion: 3, previousStatus: 'unknown' as const }
    expect(() => store.append(owner('achieved', 'future-outcome'), futureCommand)).toThrow(/judgement changed/)
    const correctedCommand = { ...lineage, action: 'correct' as const, operationId: 'evt-3', expectedVersion: 1, previousStatus: 'achieved' as const }
    const corrected = store.append(owner('not-achieved', 'correct'), correctedCommand)
    expect(corrected.ownerFeedbackState).toEqual({ version: 2, objectiveStatus: 'not-achieved' })
    expect(store.queryTasks({ scope })[0]).toMatchObject({ objectiveStatus: 'not-achieved', executionStatus: 'succeeded', projection: { status: 'ready' } })
    const withdrawal = { ...lineage, action: 'withdraw' as const, operationId: 'evt-4', expectedVersion: 2, previousStatus: 'not-achieved' as const }
    store.append(owner('unknown', 'withdraw'), withdrawal)
    expect(store.queryTasks({ scope })[0]).toMatchObject({ objectiveStatus: 'unknown', projection: { learningDisposition: 'retract' } })
    expect(store.append(owner('not-achieved', 'correct'), correctedCommand)).toEqual(corrected)
    expect(() => store.append(owner('achieved', 'stale'), { ...correctedCommand, operationId: 'evt-stale' })).toThrow(/feedback|judgement/)
    expect(() => store.append(owner('achieved', 'wrong-owner'), { ...correctedCommand, operationId: 'evt-wrong', principalRecordId: 'another-owner' })).toThrow(/judgement/)
    store.close()
    store = new EvaluationStore({ path, now: () => 3000 })
    expect(store.queryTasks({ scope })[0]).toMatchObject({ objectiveStatus: 'unknown', projection: { learningDisposition: 'retract' } })
    expect(store.getOutcome(scope, initial.id)?.objectiveStatus).toBe('achieved')
    expect(() => store.append(owner('not-achieved', 'initial'), { ...lineage, action: 'initial', operationId: 'evt-conflict' })).toThrow(/judgement changed/)

    expect(() => store.append(owner('achieved', 'future-outcome'), futureCommand)).toThrow(/judgement changed/)
    store.append(owner('partial', 'correct-again'), { ...lineage, action: 'correct', operationId: 'evt-5', expectedVersion: 3, previousStatus: 'unknown' })
    expect(store.queryTasks({ scope })[0]?.objectiveStatus).toBe('partial')
    store.append(owner('achieved', 'independent-owner'))
    expect(store.queryTasks({ scope })[0]).toMatchObject({ objectiveStatus: 'unknown', projection: { status: 'objective-conflict' } })
    expect(store.query({ scope, limit: 20 })).toHaveLength(6)
    store.close()
  })

  test('foreground owner revisions supersede the verifier outcome and remain withdrawn after restart', () => {
    const path = join(root(), 'foreground-owner.sqlite')
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const inboxId = 'inbox:foreground-owner'
    const lineage = { principalRecordId: 'host-owner', principalVersion: 1 }
    const owner = (status: OutcomeEnvelope['objectiveStatus'], key: string) => envelope({
      scope, situation: `foreground:${inboxId}`, objectiveStatus: status,
      source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' },
      evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' },
      evidence: [{ kind: 'foreground-turn', ref: inboxId }, { kind: 'delivery-outbox', ref: 'outbox:result' }],
      idempotencyKey: key,
    })
    let store = new EvaluationStore({ path, now: () => 2_000 })
    store.append(envelope({ scope, situation: `foreground:${inboxId}`,
      source: { kind: 'evaluator', id: 'assistant-verifier' },
      evaluator: { id: 'assistant-verifier', version: '1' },
      evidence: [{ kind: 'foreground-turn', ref: inboxId }, { kind: 'acceptance-contract', ref: 'contract' },
        { kind: 'verification-receipt', ref: 'receipt' }], idempotencyKey: 'foreground-terminal' }))
    store.append(owner('achieved', 'foreground-initial'), { ...lineage, action: 'initial', operationId: 'foreground-1' })
    store.append(owner('partial', 'foreground-correct'), { ...lineage, action: 'correct', operationId: 'foreground-2', expectedVersion: 1, previousStatus: 'achieved' })
    store.append(owner('unknown', 'foreground-withdraw'), { ...lineage, action: 'withdraw', operationId: 'foreground-3', expectedVersion: 2, previousStatus: 'partial' })
    expect(store.queryTasks({ scope })[0]).toMatchObject({
      executionStatus: 'succeeded', objectiveStatus: 'unknown', projection: { learningDisposition: 'retract' },
    })
    store.close()
    store = new EvaluationStore({ path, now: () => 3_000 })
    expect(store.queryTasks({ scope })[0]).toMatchObject({ objectiveStatus: 'unknown', projection: { learningDisposition: 'retract' } })
    store.close()
  })
})

test('schema-seven feedback is lazily adopted by an exact Host target and remains withdrawable', () => {
  const path = join(root(), 'legacy-owner.sqlite')
  let store = new EvaluationStore({ path })
  const original = envelope({ source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' },
    evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' },
    evidence: [{ kind: 'automation-run', ref: 'legacy-run' }, { kind: 'delivery-outbox', ref: 'legacy-outbox' }],
    idempotencyKey: 'legacy-initial' })
  const old = store.append(original)
  store.close()
  const db = new DatabaseSync(path)
  db.exec("DROP TABLE evaluation_owner_commands; DROP TABLE evaluation_owner_revisions; UPDATE evaluation_schema_meta SET value = '7' WHERE key = 'schema-version'; PRAGMA user_version = 7")
  db.close()
  store = new EvaluationStore({ path })
  const lineage = { principalRecordId: 'owner-record', principalVersion: 1 }
  const claims = { scope: old.scope, situation: old.situation, runId: 'legacy-run', outboxId: 'legacy-outbox',
    chatId: 'chat', principalId: 'owner', bindingId: 'binding', objectiveStatus: 'achieved' as const,
    occurredAt: old.occurredAt, idempotencyKey: 'legacy-initial', initialIdempotencyKey: 'legacy-initial',
    ownerCommand: { ...lineage, action: 'initial' as const, operationId: 'adopt' } }
  expect(() => store.adoptLegacyOwnerFeedback({ ...claims, outboxId: 'wrong-result' })).toThrow(/exact delivered result/)
  store.adoptLegacyOwnerFeedback(claims)
  expect(store.ownerObjectiveState(old.scope, 'legacy-run', 'owner-record', 1)).toEqual({ version: 1, objectiveStatus: 'achieved' })
  store.append({ ...original, objectiveStatus: 'partial', idempotencyKey: 'legacy-correct' },
    { ...lineage, action: 'correct', operationId: 'legacy-correct', expectedVersion: 1, previousStatus: 'achieved' })
  store.append({ ...original, objectiveStatus: 'unknown', idempotencyKey: 'legacy-withdraw' },
    { ...lineage, action: 'withdraw', operationId: 'legacy-withdraw', expectedVersion: 2, previousStatus: 'partial' })
  store.close()
  store = new EvaluationStore({ path })
  expect(store.getOutcome(old.scope, old.id)?.objectiveStatus).toBe('achieved')
  expect(store.ownerObjectiveState(old.scope, 'legacy-run', 'owner-record', 1)).toEqual({ version: 3, objectiveStatus: 'unknown' })
  expect(store.ownerObjectiveState(old.scope, 'legacy-run', 'owner-record', 2)).toBeUndefined()
  expect(() => store.append({ ...original, idempotencyKey: 'changed-owner-version' },
    { ...lineage, principalVersion: 2, action: 'correct', operationId: 'changed-owner-version', expectedVersion: 3, previousStatus: 'unknown' })).toThrow(/judgement changed/)
  store.close()
})
