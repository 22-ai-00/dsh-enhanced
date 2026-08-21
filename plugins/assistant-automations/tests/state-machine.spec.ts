import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  const store = new AutomationStore({ path: join(root, 'state.sqlite'), now: () => now })
  return { store, now: () => now, setNow: (value: number) => { now = value } }
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
    expect(store.completeTask(input)).toMatchObject({ status: 'succeeded', outputPreview: 'done' })
    expect(store.completeTask(input)).toMatchObject({ status: 'succeeded', outputPreview: 'done' })
    expect(store.listRuns({ automationId: 'auto-complete', limit: 10 })).toHaveLength(1)
    store.close()
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

    const suppressed = value.store.suppressRunDelivery({ runId: run.id, expectedStatus: 'pending', now: value.now() + 1 })
    expect(suppressed).toMatchObject({ deliveryStatus: 'suppressed' })
    expect(suppressed).not.toHaveProperty('deliveryRef')
    const replay = value.store.suppressRunDelivery({ runId: run.id, expectedStatus: 'pending', now: value.now() + 1 })
    expect(replay).toMatchObject({ deliveryStatus: 'suppressed' })
    expect(replay).not.toHaveProperty('deliveryRef')
    expect(value.store.listPendingDeliveries(10)).toEqual([])
    value.store.close()
  })
})
