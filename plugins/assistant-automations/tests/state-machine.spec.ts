import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { AutomationStore, AutomationStoreError } from '../src/store.ts'

const roots: string[] = []
const minute = 60_000

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(start = Date.parse('2026-08-21T10:00:00.000Z')) {
  let now = start
  const root = await mkdtemp(join(tmpdir(), 'assistant-automations-state-'))
  roots.push(root)
  const path = join(root, 'state.sqlite')
  const store = new AutomationStore({ path, now: () => now })
  return { root, path, store, now: () => now, setNow: (value: number) => { now = value } }
}

function definition(overrides: Record<string, unknown> = {}) {
  return {
    name: 'State machine', prompt: 'Run one bounded task.',
    schedule: { kind: 'at', at: '2026-08-21T10:01:00.000Z' },
    workspace: '/work/alpha', agentPreset: 'primary', provider: 'mock', model: 'mock-model',
    allowedTools: [], timeoutMs: minute, maxOutputTokens: 512, maxToolCalls: 0,
    misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0,
    principal: 'owner:lark:123', ...overrides,
  }
}

function due(store: AutomationStore, automationId: string, overrides: Record<string, unknown> = {}) {
  store.createApproved({ automationId, idempotencyKey: `create:${automationId}`, definition: definition(overrides) })
  store.materializeDue({ now: Date.parse('2026-08-21T10:01:00.000Z'), misfireGraceMs: minute, maxCatchUp: 10 })
  return store.listTasks({ automationId, limit: 10 })[0]!
}

describe('duty ownership and fencing', () => {
  test('acquires, renews, and takes over only at expiry with monotonic fencing', async () => {
    const { store } = await fixture()
    const first = store.acquireDuty({ ownerId: 'owner-a', now: 1_000, leaseMs: 500 })
    expect(first).toEqual({ acquired: true, ownerId: 'owner-a', fencingToken: 1, leaseUntil: 1_500 })
    expect(store.acquireDuty({ ownerId: 'owner-b', now: 1_499, leaseMs: 500 })).toMatchObject({ acquired: false })
    expect(store.renewDuty({ ownerId: 'owner-a', fencingToken: 1, now: 1_200, leaseMs: 500 }))
      .toMatchObject({ acquired: true, leaseUntil: 1_700, fencingToken: 1 })
    const takeover = store.acquireDuty({ ownerId: 'owner-b', now: 1_700, leaseMs: 500 })
    expect(takeover).toEqual({ acquired: true, ownerId: 'owner-b', fencingToken: 2, leaseUntil: 2_200 })
    expect(() => store.renewDuty({ ownerId: 'owner-a', fencingToken: 1, now: 1_701, leaseMs: 500 }))
      .toThrowError(expect.objectContaining<Partial<AutomationStoreError>>({ code: 'stale-fence' }))
    store.close()
  })

  test('denies stale claim, heartbeat, and completion after takeover', async () => {
    const { store } = await fixture()
    const task = due(store, 'auto-fence')
    store.acquireDuty({ ownerId: 'owner-a', now: 1_000, leaseMs: 500 })
    const claimed = store.claimNextTask({ ownerId: 'owner-a', fencingToken: 1, now: 1_100, leaseMs: 300 })
    expect(claimed?.id).toBe(task.id)
    store.startTask({ taskId: task.id, ownerId: 'owner-a', fencingToken: 1, now: 1_200, leaseMs: 300, sessionId: 's1' })
    store.acquireDuty({ ownerId: 'owner-b', now: 1_500, leaseMs: 500 })
    expect(() => store.heartbeatTask({ taskId: task.id, ownerId: 'owner-a', fencingToken: 1, now: 1_501, leaseMs: 300 }))
      .toThrowError(expect.objectContaining<Partial<AutomationStoreError>>({ code: 'stale-fence' }))
    expect(() => store.completeTask({
      taskId: task.id, ownerId: 'owner-a', fencingToken: 1, now: 1_501,
      outcome: 'succeeded', outputPreview: 'late', usage: {},
    })).toThrowError(expect.objectContaining<Partial<AutomationStoreError>>({ code: 'stale-fence' }))
    store.close()
  })
})

describe('task recovery and overlap', () => {
  test('requeues expired claimed work but marks ambiguous running work unknown', async () => {
    const { store } = await fixture()
    const claimedTask = due(store, 'auto-claimed')
    const runningTask = due(store, 'auto-running', { schedule: { kind: 'at', at: '2026-08-21T10:01:00.000Z' } })
    store.acquireDuty({ ownerId: 'owner-a', now: 1_000, leaseMs: 10_000 })
    store.claimTask({ taskId: claimedTask.id, ownerId: 'owner-a', fencingToken: 1, now: 1_100, leaseMs: 100 })
    store.claimTask({ taskId: runningTask.id, ownerId: 'owner-a', fencingToken: 1, now: 1_100, leaseMs: 100 })
    store.startTask({ taskId: runningTask.id, ownerId: 'owner-a', fencingToken: 1, now: 1_150, leaseMs: 100, sessionId: 'run' })
    expect(store.recoverExpiredTasks({ now: 1_250 })).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: claimedTask.id, status: 'scheduled' }),
      expect.objectContaining({ id: runningTask.id, status: 'unknown' }),
    ]))
    expect(store.listOccurrences({ limit: 10 }).find(value => value.automationId === 'auto-running'))
      .toMatchObject({ status: 'unknown', reason: 'runner-lease-expired' })
    const recoveredRun = store.listRuns({ automationId: 'auto-running', limit: 10 })[0]!
    expect(recoveredRun).toMatchObject({ status: 'unknown', evidenceStatus: 'suppressed' })
    expect(store.listPendingEvaluations(10)).toEqual([
      expect.objectContaining({
        runId: recoveredRun.id,
        payload: expect.objectContaining({
          scope: { workspace: '/work/alpha', preset: 'primary' },
          executionStatus: 'unknown', objectiveStatus: 'unknown', deliveryStatus: 'not-required',
        }),
      }),
    ])
    store.close()
  })

  test('only retries ambiguous running work when immutable retry safety permits it', async () => {
    const { store } = await fixture()
    const task = due(store, 'auto-retry', { retrySafety: 'idempotent', maxRetries: 1 })
    store.acquireDuty({ ownerId: 'owner-a', now: 1_000, leaseMs: 10_000 })
    store.claimTask({ taskId: task.id, ownerId: 'owner-a', fencingToken: 1, now: 1_100, leaseMs: 100 })
    store.startTask({ taskId: task.id, ownerId: 'owner-a', fencingToken: 1, now: 1_150, leaseMs: 100, sessionId: 'first' })
    expect(store.recoverExpiredTasks({ now: 1_250 })).toEqual([
      expect.objectContaining({ id: task.id, status: 'scheduled', attemptCount: 1 }),
    ])
    const retry = store.claimTask({ taskId: task.id, ownerId: 'owner-a', fencingToken: 1, now: 1_251, leaseMs: 100 })
    expect(retry).toMatchObject({ status: 'claimed', attemptCount: 2 })
    store.startTask({ taskId: task.id, ownerId: 'owner-a', fencingToken: 1, now: 1_252, leaseMs: 100, sessionId: 'second' })
    expect(store.recoverExpiredTasks({ now: 1_352 })).toEqual([
      expect.objectContaining({ id: task.id, status: 'unknown', attemptCount: 2 }),
    ])
    expect(store.listRuns({ automationId: 'auto-retry', limit: 10 }))
      .toEqual([expect.objectContaining({ status: 'unknown' })])
    store.close()
  })

  test('applies skip, queue-one, and cancel-previous without parallelizing hidden work', async () => {
    const { store } = await fixture()
    for (const overlap of ['skip', 'queue-one', 'cancel-previous'] as const) {
      const id = `auto-${overlap}`
      store.createApproved({
        automationId: id, idempotencyKey: `create:${id}`,
        definition: definition({
          schedule: { kind: 'every', anchorAt: '2026-08-21T10:01:00.000Z', intervalMs: minute },
          overlap, misfire: { kind: 'bounded-replay', limit: 2 },
        }),
      })
    }
    store.materializeDue({ now: Date.parse('2026-08-21T10:02:00.000Z'), misfireGraceMs: 0, maxCatchUp: 10 })
    store.acquireDuty({ ownerId: 'owner-a', now: 1_000, leaseMs: 10_000 })

    for (const overlap of ['skip', 'queue-one', 'cancel-previous'] as const) {
      const tasks = store.listTasks({ automationId: `auto-${overlap}`, limit: 10 })
      store.claimTask({ taskId: tasks[0]!.id, ownerId: 'owner-a', fencingToken: 1, now: 1_100, leaseMs: 1_000 })
      store.startTask({ taskId: tasks[0]!.id, ownerId: 'owner-a', fencingToken: 1, now: 1_101, leaseMs: 1_000, sessionId: overlap })
      const next = store.claimTask({ taskId: tasks[1]!.id, ownerId: 'owner-a', fencingToken: 1, now: 1_102, leaseMs: 1_000 })
      if (overlap === 'skip') expect(next).toMatchObject({ status: 'cancelled' })
      if (overlap === 'queue-one') expect(next).toBeUndefined()
      if (overlap === 'cancel-previous') {
        expect(next).toMatchObject({ status: 'claimed' })
        expect(store.listTasks({ automationId: `auto-${overlap}`, limit: 10 })[0])
          .toMatchObject({ status: 'running', cancelRequested: true })
      }
    }
    store.close()
  })

  test('commits one terminal run and makes completion idempotent for the winning fence', async () => {
    const { store } = await fixture()
    const task = due(store, 'auto-complete')
    store.acquireDuty({ ownerId: 'owner-a', now: 1_000, leaseMs: 10_000 })
    store.claimTask({ taskId: task.id, ownerId: 'owner-a', fencingToken: 1, now: 1_100, leaseMs: 1_000 })
    store.startTask({ taskId: task.id, ownerId: 'owner-a', fencingToken: 1, now: 1_101, leaseMs: 1_000, sessionId: 'session-1' })
    const input = {
      taskId: task.id, ownerId: 'owner-a', fencingToken: 1, now: 1_200,
      outcome: 'succeeded' as const, sessionId: 'session-1', artifactRef: 'runs/run.json',
      outputPreview: 'done', usage: { outputTokens: 2 },
    }
    expect(store.completeTask(input)).toMatchObject({
      status: 'succeeded', outputPreview: 'done', evidenceStatus: 'pending',
      evidence: {
        situation: 'automation:auto-complete', outcome: 'succeeded',
        detail: 'automation "State machine": run succeeded',
        idempotencyKey: expect.stringMatching(/^automation-run:run-/),
        occurredAt: 1_200, workspace: '/work/alpha', agentPreset: 'primary',
        automationId: 'auto-complete', runId: expect.stringMatching(/^run-/),
      },
    })
    expect(store.completeTask(input)).toMatchObject({ status: 'succeeded', evidenceStatus: 'pending' })
    expect(store.listRuns({ automationId: 'auto-complete', limit: 10 })).toHaveLength(1)
    expect(store.listPendingEvaluations(10)).toEqual([
      expect.objectContaining({
        runId: expect.stringMatching(/^run-/), kind: 'terminal', status: 'pending',
        payload: expect.objectContaining({
          scope: { workspace: '/work/alpha', preset: 'primary' },
          situation: 'automation:auto-complete',
          executionStatus: 'succeeded', objectiveStatus: 'unknown', deliveryStatus: 'not-required',
          source: { kind: 'automation', id: 'assistant-automations' }, trust: 'trusted',
          metrics: expect.objectContaining({ outputTokens: 2 }),
          evaluator: { id: 'assistant-automations', version: 'terminal-v1' },
        }),
      }),
    ])
    store.close()
  })

  test('attributes trusted evidence to the immutable claim snapshot across a running reconcile', async () => {
    const { store } = await fixture()
    store.reconcileSystemOwned({
      owner: 'heartbeat', automationId: 'mutable-system', idempotencyKey: 'system:old',
      definition: definition({
        workspace: '/work/old', agentPreset: 'old',
        schedule: { kind: 'at', at: '2027-08-21T10:01:00.000Z' },
      }),
    })
    store.createManual({ automationId: 'mutable-system', requestId: 'one', dryRun: false })
    const duty = store.acquireDuty({ ownerId: 'owner-a', now: 1_000, leaseMs: 10_000 })
    const claimed = store.claimNextTask({
      ownerId: 'owner-a', fencingToken: duty.fencingToken, now: 1_100, leaseMs: 1_000,
    })!
    expect(store.getTaskExecutionSnapshot(claimed.id)).toMatchObject({
      version: 1, definition: { workspace: '/work/old', agentPreset: 'old' },
    })
    store.startTask({
      taskId: claimed.id, ownerId: 'owner-a', fencingToken: duty.fencingToken,
      now: 1_101, leaseMs: 1_000, sessionId: 'old-session',
    })
    store.reconcileSystemOwned({
      owner: 'heartbeat', automationId: 'mutable-system', idempotencyKey: 'system:new',
      definition: definition({
        workspace: '/work/new', agentPreset: 'new', deliveryBindingId: 'new-binding',
        schedule: { kind: 'at', at: '2027-08-21T10:01:00.000Z' },
      }),
    })
    const run = store.completeTask({
      taskId: claimed.id, ownerId: 'owner-a', fencingToken: duty.fencingToken,
      now: 1_200, outcome: 'succeeded', outputPreview: 'done', usage: {},
    })

    expect(store.get('mutable-system')).toMatchObject({
      version: 2, definition: { workspace: '/work/new', agentPreset: 'new', deliveryBindingId: 'new-binding' },
    })
    expect(run).toMatchObject({
      evidence: { workspace: '/work/old', agentPreset: 'old' },
    })
    expect(run).not.toHaveProperty('deliveryStatus')
    expect(store.getRunExecutionSnapshot(run.id)).toMatchObject({
      version: 1, definition: { workspace: '/work/old', agentPreset: 'old' },
    })
    expect(store.listPendingEvaluations(10)[0]?.payload).toMatchObject({
      scope: { workspace: '/work/old', preset: 'old' }, deliveryStatus: 'not-required',
    })
    store.close()
  })

  test.each(['cancelled', 'unknown'] as const)(
    'atomically suppresses %s evidence instead of creating a retryable observation',
    async outcome => {
      const { store } = await fixture()
      const task = due(store, `auto-${outcome}`)
      const duty = store.acquireDuty({ ownerId: 'owner-a', now: 1_000, leaseMs: 10_000 })
      store.claimTask({ taskId: task.id, ownerId: 'owner-a', fencingToken: duty.fencingToken,
        now: 1_100, leaseMs: 1_000 })
      store.startTask({ taskId: task.id, ownerId: 'owner-a', fencingToken: duty.fencingToken,
        now: 1_101, leaseMs: 1_000, sessionId: 'session-1' })

      const run = store.completeTask({
        taskId: task.id, ownerId: 'owner-a', fencingToken: duty.fencingToken,
        now: 1_200, outcome, outputPreview: '', usage: {},
      })

      expect(run).toMatchObject({ status: outcome, evidenceStatus: 'suppressed' })
      expect(run).not.toHaveProperty('evidence')
      expect(store.listPendingEvidence(10)).toEqual([])
      expect(store.listPendingEvaluations(10)).toEqual([
        expect.objectContaining({
          runId: run.id,
          payload: expect.objectContaining({
            executionStatus: outcome,
            objectiveStatus: 'unknown',
            deliveryStatus: 'not-required',
          }),
        }),
      ])
      store.close()
    },
  )

  test('uses distinct stable situation hashes for maximum-length automation ids', async () => {
    const { store } = await fixture()
    const ids = ['a'.repeat(500), 'b'.repeat(500)]
    for (const [index, automationId] of ids.entries()) {
      store.createApproved({
        automationId, idempotencyKey: `create:long:${index}`, definition: definition(),
      })
      store.materializeDue({
        now: Date.parse('2026-08-21T10:01:00.000Z'), misfireGraceMs: minute, maxCatchUp: 10,
      })
    }
    const duty = store.acquireDuty({ ownerId: 'owner-a', now: 1_000, leaseMs: 10_000 })
    for (const automationId of ids) {
      const task = store.listTasks({ automationId, limit: 1 })[0]!
      store.claimTask({
        taskId: task.id, ownerId: 'owner-a', fencingToken: duty.fencingToken, now: 1_100, leaseMs: 1_000,
      })
      store.startTask({
        taskId: task.id, ownerId: 'owner-a', fencingToken: duty.fencingToken,
        now: 1_101, leaseMs: 1_000, sessionId: `session-${automationId[0]}`,
      })
      store.completeTask({
        taskId: task.id, ownerId: 'owner-a', fencingToken: duty.fencingToken,
        now: 1_200, outcome: 'succeeded', outputPreview: 'done', usage: {},
      })
    }
    const situations = store.listPendingEvaluations(10).map(entry => entry.payload.situation)
    expect(situations).toHaveLength(2)
    expect(new Set(situations).size).toBe(2)
    expect(situations.every(value => /^automation:[a-f0-9]{64}$/u.test(value))).toBe(true)
    store.close()
  })

  test('durably rotates a failing evidence row behind its pending peers', async () => {
    const value = await fixture()
    for (const automationId of ['auto-evidence-a', 'auto-evidence-b']) {
      value.store.createApproved({
        automationId,
        idempotencyKey: `create:${automationId}`,
        definition: definition({ schedule: { kind: 'at', at: '2027-08-21T10:01:00.000Z' } }),
      })
      value.store.createManual({ automationId, requestId: 'one', dryRun: false })
    }
    const duty = value.store.acquireDuty({ ownerId: 'owner-a', now: value.now(), leaseMs: 10_000 })
    for (let index = 0; index < 2; index += 1) {
      const claimed = value.store.claimNextTask({
        ownerId: 'owner-a', fencingToken: duty.fencingToken, now: value.now(), leaseMs: 1_000,
      })!
      value.store.startTask({
        taskId: claimed.id, ownerId: 'owner-a', fencingToken: duty.fencingToken,
        now: value.now(), leaseMs: 1_000, sessionId: `session-${index}`,
      })
      value.store.completeTask({
        taskId: claimed.id, ownerId: 'owner-a', fencingToken: duty.fencingToken,
        now: value.now(), outcome: 'succeeded', outputPreview: 'done', usage: {},
      })
    }

    const first = value.store.listPendingEvidence(1)[0]!
    value.store.deferRunEvidence({ runId: first.id, expectedStatus: 'pending', now: value.now() })

    expect(value.store.listPendingEvidence(1)[0]?.id).not.toBe(first.id)
    value.store.close()
  })

  test('backs off and dead-letters a permanently failing Evaluation observation', async () => {
    const value = await fixture()
    const task = due(value.store, 'auto-evaluation-poison')
    const duty = value.store.acquireDuty({ ownerId: 'owner-a', now: 1_000, leaseMs: 10_000 })
    value.store.claimTask({
      taskId: task.id, ownerId: 'owner-a', fencingToken: duty.fencingToken, now: 1_100, leaseMs: 1_000,
    })
    value.store.startTask({
      taskId: task.id, ownerId: 'owner-a', fencingToken: duty.fencingToken,
      now: 1_101, leaseMs: 1_000, sessionId: 'session-poison',
    })
    value.store.completeTask({
      taskId: task.id, ownerId: 'owner-a', fencingToken: duty.fencingToken,
      now: 1_200, outcome: 'failed', outputPreview: 'failed', usage: {},
    })
    let entry = value.store.listPendingEvaluations(10)[0]!
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const at = 2_000 + attempt
      entry = value.store.deferEvaluation({
        id: entry.id, expectedStatus: 'pending', now: at, retryAt: at + 1_000,
        maxAttempts: 8, errorCode: 'invalid-input',
      })
      expect(entry.attemptCount).toBe(attempt)
      if (attempt < 8) {
        expect(entry).toMatchObject({ status: 'pending', nextAttemptAt: at + 1_000, lastErrorCode: 'invalid-input' })
        expect(value.store.listPendingEvaluations(10, at + 999)).toEqual([])
      }
    }
    expect(entry).toMatchObject({
      status: 'dead-letter', attemptCount: 8, lastErrorCode: 'invalid-input', lastFailureAt: 2_008,
    })
    expect(value.store.listPendingEvaluations(10)).toEqual([])
    value.store.close()
  })

  test('migrates v2 run rows into the durable evidence lane without losing terminal history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-automations-v2-'))
    roots.push(root)
    const path = join(root, 'state.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE automation_definitions (
        id TEXT PRIMARY KEY, definition_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE automation_runs (
        id TEXT PRIMARY KEY, occurrence_id TEXT NOT NULL UNIQUE, automation_id TEXT NOT NULL,
        task_id TEXT NOT NULL UNIQUE, attempt_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL, session_id TEXT, artifact_ref TEXT, output_preview TEXT NOT NULL,
        usage_json TEXT NOT NULL, delivery_status TEXT, delivery_ref TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO automation_definitions(id, definition_json) VALUES
        ('legacy-auto', '{"name":"Legacy name","workspace":"/work/legacy","agentPreset":"legacy"}'),
        ('legacy-oversized', json_object(
          'name', 'Oversized legacy', 'workspace', '/' || printf('%.*c', 20000, 'x'), 'agentPreset', 'legacy'
        )),
        ('legacy-malformed', 'not-json');
      INSERT INTO automation_runs VALUES
        ('legacy-success', 'occ-1', 'legacy-auto', 'task-1', 'attempt-1', 'succeeded',
         'synthetic-session', NULL, 'done', '{}', NULL, NULL, 1000, 1000),
        ('legacy-failed', 'occ-2', 'legacy-auto', 'task-2', 'attempt-2', 'failed',
         NULL, NULL, '', '{}', NULL, NULL, 1001, 1001),
        ('legacy-timeout', 'occ-3', 'legacy-auto', 'task-3', 'attempt-3', 'timed_out',
         NULL, NULL, '', '{}', NULL, NULL, 1002, 1002),
        ('legacy-cancel', 'occ-4', 'legacy-auto', 'task-4', 'attempt-4', 'cancelled',
         NULL, NULL, '', '{}', NULL, NULL, 1003, 1003),
        ('legacy-unknown', 'occ-5', 'legacy-auto', 'task-5', 'attempt-5', 'unknown',
         NULL, NULL, '', '{}', NULL, NULL, 1004, 1004),
        ('legacy-oversized', 'occ-6', 'legacy-oversized', 'task-6', 'attempt-6', 'succeeded',
         NULL, NULL, '', '{}', NULL, NULL, 1005, 1005),
        ('legacy-malformed', 'occ-7', 'legacy-malformed', 'task-7', 'attempt-7', 'succeeded',
         NULL, NULL, '', '{}', NULL, NULL, 1006, 1006);
      PRAGMA user_version = 2;
    `)
    legacy.close()

    const migrated = new AutomationStore({ path })
    const runs = migrated.listRuns({ limit: 10 })
    expect(runs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'legacy-success', evidenceStatus: 'pending', evidence: {
          situation: 'automation:legacy-auto', outcome: 'succeeded',
          detail: 'automation "Legacy name": run succeeded',
          idempotencyKey: 'automation-run:legacy-success', occurredAt: 1000,
          workspace: '/work/legacy', agentPreset: 'legacy', automationId: 'legacy-auto',
          runId: 'legacy-success',
        },
      }),
      expect.objectContaining({ id: 'legacy-failed', evidenceStatus: 'pending' }),
      expect.objectContaining({ id: 'legacy-timeout', evidenceStatus: 'pending' }),
      expect.objectContaining({ id: 'legacy-cancel', evidenceStatus: 'suppressed' }),
      expect.objectContaining({ id: 'legacy-unknown', evidenceStatus: 'suppressed' }),
      expect.objectContaining({ id: 'legacy-oversized', evidenceStatus: 'suppressed' }),
      expect.objectContaining({ id: 'legacy-malformed', evidenceStatus: 'suppressed' }),
    ]))
    expect(runs.filter(run => run.evidenceStatus === 'suppressed').every(run => run.evidence === undefined)).toBe(true)
    expect(migrated.listPendingEvidence(10)).toHaveLength(3)
    // The original v2 schema had no immutable execution snapshot. Its evidence
    // was synthesized from the definition at migration time, so it must never
    // be promoted into a trusted cross-scope Evaluation observation.
    expect(migrated.listPendingEvaluations(10)).toEqual([])
    migrated.close()
  })

  test('atomically records pending delivery only for successful delivery-bound runs', async () => {
    const value = await fixture()
    value.store.createApproved({
      automationId: 'delivery-bound', idempotencyKey: 'create:delivery-bound',
      definition: definition({ deliveryBindingId: 'binding-owner' }),
    })
    const occurrence = value.store.createManual({ automationId: 'delivery-bound', requestId: 'one', dryRun: false })
    const duty = value.store.acquireDuty({ ownerId: 'owner-a', now: value.now(), leaseMs: 1_000 })
    const claimed = value.store.claimNextTask({ ownerId: 'owner-a', fencingToken: duty.fencingToken,
      now: value.now(), leaseMs: 1_000 })!
    value.store.startTask({ taskId: claimed.id, ownerId: 'owner-a', fencingToken: duty.fencingToken,
      now: value.now(), leaseMs: 1_000, sessionId: 'session-delivery' })
    const run = value.store.completeTask({ taskId: claimed.id, ownerId: 'owner-a', fencingToken: duty.fencingToken,
      now: value.now(), outcome: 'succeeded', outputPreview: 'done', usage: {} })
    expect(run).toMatchObject({ occurrenceId: occurrence.id, deliveryStatus: 'pending' })
    expect(value.store.getPendingEvaluationForRun(run.id)?.payload.deliveryStatus).toBe('unknown')
    expect(value.store.listPendingDeliveries(10)).toEqual([expect.objectContaining({ id: run.id })])

    expect(value.store.completeRunDelivery({ runId: run.id, expectedStatus: 'pending',
      deliveryRef: 'outbox-1', now: value.now() + 1 })).toMatchObject({
        status: 'succeeded', deliveryStatus: 'enqueued', deliveryRef: 'outbox-1',
      })
    expect(value.store.listPendingDeliveries(10)).toEqual([])
    value.store.close()
  })

  test('persists terminal suppression idempotently without a delivery reference', async () => {
    const value = await fixture()
    value.store.createApproved({
      automationId: 'delivery-suppressed', idempotencyKey: 'create:delivery-suppressed',
      definition: definition({ deliveryBindingId: 'binding-owner', deliverySuppressExact: ['HEARTBEAT_OK'] }),
    })
    value.store.createManual({ automationId: 'delivery-suppressed', requestId: 'one', dryRun: false })
    const duty = value.store.acquireDuty({ ownerId: 'owner-a', now: value.now(), leaseMs: 1_000 })
    const claimed = value.store.claimNextTask({ ownerId: 'owner-a', fencingToken: duty.fencingToken,
      now: value.now(), leaseMs: 1_000 })!
    value.store.startTask({ taskId: claimed.id, ownerId: 'owner-a', fencingToken: duty.fencingToken,
      now: value.now(), leaseMs: 1_000, sessionId: 'session-delivery' })
    const run = value.store.completeTask({ taskId: claimed.id, ownerId: 'owner-a', fencingToken: duty.fencingToken,
      now: value.now(), outcome: 'succeeded', outputPreview: 'HEARTBEAT_OK', usage: {} })

    expect(run).toMatchObject({ deliveryStatus: 'suppressed' })
    expect(value.store.getPendingEvaluationForRun(run.id)?.payload.deliveryStatus).toBe('not-required')
    const suppressed = value.store.suppressRunDelivery({ runId: run.id, expectedStatus: 'pending', now: value.now() + 1 })
    expect(suppressed).toMatchObject({ deliveryStatus: 'suppressed' })
    expect(suppressed).not.toHaveProperty('deliveryRef')
    const replay = value.store.suppressRunDelivery({ runId: run.id, expectedStatus: 'pending', now: value.now() + 1 })
    expect(replay).toMatchObject({ deliveryStatus: 'suppressed' })
    expect(replay).not.toHaveProperty('deliveryRef')
    expect(value.store.listPendingDeliveries(10)).toEqual([])
    value.store.close()
  })

  test.each(['failed', 'timed_out', 'cancelled', 'unknown'] as const)(
    'marks delivery not-required when a delivery-bound run ends %s',
    async outcome => {
      const value = await fixture()
      const automationId = `delivery-${outcome}`
      value.store.createApproved({
        automationId, idempotencyKey: `create:${automationId}`,
        definition: definition({
          deliveryBindingId: 'binding-owner',
          schedule: { kind: 'at', at: '2027-08-21T10:01:00.000Z' },
        }),
      })
      value.store.createManual({ automationId, requestId: 'one', dryRun: false })
      const duty = value.store.acquireDuty({ ownerId: 'owner-a', now: value.now(), leaseMs: 1_000 })
      const claimed = value.store.claimNextTask({
        ownerId: 'owner-a', fencingToken: duty.fencingToken, now: value.now(), leaseMs: 1_000,
      })!
      value.store.startTask({
        taskId: claimed.id, ownerId: 'owner-a', fencingToken: duty.fencingToken,
        now: value.now(), leaseMs: 1_000, sessionId: 'session-delivery',
      })
      const run = value.store.completeTask({
        taskId: claimed.id, ownerId: 'owner-a', fencingToken: duty.fencingToken,
        now: value.now(), outcome, outputPreview: 'failure', usage: {},
      })
      expect(run).not.toHaveProperty('deliveryStatus')
      expect(value.store.getPendingEvaluationForRun(run.id)?.payload).toMatchObject({
        executionStatus: outcome === 'timed_out' ? 'timed-out' : outcome,
        deliveryStatus: 'not-required',
      })
      value.store.close()
    },
  )
})

describe('scope-bound run history', () => {
  test('uses immutable claim scope and returns newest runs first', async () => {
    const { store } = await fixture()
    const alpha = due(store, 'history-alpha', { workspace: '/work/alpha', agentPreset: 'primary' })
    const beta = due(store, 'history-beta', { workspace: '/work/beta', agentPreset: 'secondary' })
    const duty = store.acquireDuty({ ownerId: 'history-owner', now: 1_000, leaseMs: 100_000 })
    for (const [task, session, now] of [[alpha, 'alpha-session', 2_000], [beta, 'beta-session', 3_000]] as const) {
      store.claimTask({ taskId: task.id, ownerId: 'history-owner', fencingToken: duty.fencingToken,
        now: now - 20, leaseMs: 10_000 })
      store.startTask({ taskId: task.id, ownerId: 'history-owner', fencingToken: duty.fencingToken,
        now: now - 10, leaseMs: 10_000, sessionId: session })
      store.completeTask({ taskId: task.id, ownerId: 'history-owner', fencingToken: duty.fencingToken,
        now, outcome: 'succeeded', outputPreview: `${session}-private-output`, usage: {} })
    }

    expect(store.listRunsForExecutionScope({
      workspace: '/work/alpha/../alpha', agentPreset: 'primary', limit: 20,
    })).toEqual([
      expect.objectContaining({ automationId: 'history-alpha', outputPreview: 'alpha-session-private-output' }),
    ])
    expect(store.listRunsForExecutionScope({
      workspace: '/work/beta', agentPreset: 'secondary', limit: 20,
    })).toEqual([
      expect.objectContaining({ automationId: 'history-beta', outputPreview: 'beta-session-private-output' }),
    ])
    store.close()
  })
})

describe('content-free health metrics', () => {
  test('distinguishes current Evaluation backlog from lifetime failed attempts', async () => {
    const value = await fixture()
    const task = due(value.store, 'auto-evaluation-health')
    const duty = value.store.acquireDuty({ ownerId: 'owner-a', now: value.now(), leaseMs: minute })
    value.store.claimTask({ taskId: task.id, ownerId: 'owner-a', fencingToken: duty.fencingToken,
      now: value.now(), leaseMs: minute })
    value.store.startTask({ taskId: task.id, ownerId: 'owner-a', fencingToken: duty.fencingToken,
      now: value.now(), leaseMs: minute, sessionId: 'evaluation-health' })
    value.store.completeTask({ taskId: task.id, ownerId: 'owner-a', fencingToken: duty.fencingToken,
      now: value.now(), outcome: 'failed', outputPreview: 'failed', usage: {} })

    expect(value.store.health()).toMatchObject({
      pendingEvaluations: 1, retryingEvaluations: 0, failedEvaluationAttempts: 0,
      deadLetterEvaluations: 0, oldestPendingEvaluationAt: value.now(),
    })
    const entry = value.store.listPendingEvaluations(1, value.now())[0]!
    value.store.deferEvaluation({ id: entry.id, expectedStatus: 'pending', now: value.now(),
      retryAt: value.now() + 1_000, maxAttempts: 2, errorCode: 'temporary' })
    expect(value.store.health()).toMatchObject({
      pendingEvaluations: 1, retryingEvaluations: 1, failedEvaluationAttempts: 1,
      deadLetterEvaluations: 0, oldestPendingEvaluationAt: value.now(),
    })
    value.store.deferEvaluation({ id: entry.id, expectedStatus: 'pending', now: value.now() + 1,
      retryAt: value.now() + 2_000, maxAttempts: 2, errorCode: 'permanent' })
    expect(value.store.health()).toMatchObject({
      pendingEvaluations: 0, retryingEvaluations: 0, failedEvaluationAttempts: 2,
      deadLetterEvaluations: 1, oldestPendingEvaluationAt: 0,
    })
    value.store.close()
  })
})
