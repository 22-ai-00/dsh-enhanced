import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AutomationArtifactStore } from '../src/artifacts.ts'
import {
  AutomationCoordinator,
  AutomationRunnerAmbiguousError,
  type AutomationDeliveryDispatcher,
  type AutomationRunner,
  type AutomationRunnerInput,
} from '../src/coordinator.ts'
import { AutomationStore } from '../src/store.ts'

const roots: string[] = []
const minute = 60_000

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function definition(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Coordinator', prompt: 'Run it.',
    schedule: { kind: 'at', at: '2026-08-21T10:01:00.000Z' },
    workspace: '/work/alpha', agentPreset: 'primary', provider: 'mock', model: 'mock-model',
    allowedTools: [], timeoutMs: minute, maxOutputTokens: 512, maxToolCalls: 0,
    misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0,
    principal: 'owner:lark:123', ...overrides,
  }
}

async function fixture(runner: AutomationRunner, overrides: Record<string, number> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-automations-coordinator-'))
  roots.push(root)
  const at = Date.parse('2026-08-21T10:01:00.000Z')
  const store = new AutomationStore({ path: join(root, 'state.sqlite'), now: () => at })
  const artifacts = new AutomationArtifactStore({ rootPath: join(root, 'runs'), maxBytes: 64_000 })
  const coordinator = new AutomationCoordinator({
    store, artifacts, runner, ownerId: 'coordinator-test', now: () => at,
    dutyLeaseMs: 10_000, taskLeaseMs: 5_000, misfireGraceMs: minute, maxCatchUp: 10,
    maxConcurrency: 2, ...overrides,
  })
  return { root, store, coordinator }
}

describe('automation coordinator', () => {
  test('catches up on startup, persists artifact before terminal run, and never duplicates across restart ticks', async () => {
    const calls: AutomationRunnerInput[] = []
    const runner: AutomationRunner = {
      async run(input) {
        calls.push(input)
        return { outcome: 'succeeded', sessionId: 'session-1', output: 'finished', usage: { outputTokens: 1 } }
      },
    }
    const value = await fixture(runner)
    value.store.createApproved({ automationId: 'auto-one', idempotencyKey: 'create:one', definition: definition() })
    await value.coordinator.tick()
    await value.coordinator.whenIdle()
    for (let index = 0; index < 100; index += 1) await value.coordinator.tick()
    expect(calls).toHaveLength(1)
    expect(value.store.listRuns({ automationId: 'auto-one', limit: 10 })).toEqual([
      expect.objectContaining({ status: 'succeeded', artifactRef: expect.stringMatching(/^occ-.*\.json$/), outputPreview: 'finished' }),
    ])
    value.coordinator.stop()
    value.store.close()
  })

  test('durably enqueues a successful run through Delivery with a stable key', async () => {
    const dispatcher: AutomationDeliveryDispatcher = {
      enqueueBackground: vi.fn(() => ({ id: 'outbox-1', status: 'pending' })),
    }
    const value = await fixture({
      async run() { return { outcome: 'succeeded', output: 'scheduled result', usage: {} } },
    })
    value.coordinator.setDeliveryDispatcher(dispatcher)
    value.store.createApproved({
      automationId: 'auto-delivery', idempotencyKey: 'create:delivery',
      definition: definition({ deliveryBindingId: 'binding-owner' }),
    })

    await value.coordinator.tick()
    await value.coordinator.whenIdle()
    await value.coordinator.tick()

    const run = value.store.listRuns({ automationId: 'auto-delivery', limit: 10 })[0]!
    expect(dispatcher.enqueueBackground).toHaveBeenCalledOnce()
    expect(dispatcher.enqueueBackground).toHaveBeenCalledWith({
      sourceId: 'auto-delivery', workspace: '/work/alpha', bindingId: 'binding-owner',
      idempotencyKey: `automation:${run.occurrenceId}:binding-owner`,
      text: 'scheduled result', format: 'markdown',
    })
    expect(run).toMatchObject({ status: 'succeeded' })
    expect(value.store.listRuns({ automationId: 'auto-delivery', limit: 10 })[0])
      .toMatchObject({ status: 'succeeded', deliveryStatus: 'enqueued', deliveryRef: 'outbox-1' })
    value.store.close()
  })

  test('keeps execution succeeded and retries the same delivery intent after restart-safe failure', async () => {
    const dispatcher: AutomationDeliveryDispatcher = {
      enqueueBackground: vi.fn()
        .mockImplementationOnce(() => { throw new Error('delivery unavailable') })
        .mockReturnValue({ id: 'outbox-recovered', status: 'pending' }),
    }
    const value = await fixture({
      async run() { return { outcome: 'succeeded', output: 'do not rerun me', usage: {} } },
    })
    value.coordinator.setDeliveryDispatcher(dispatcher)
    value.store.createApproved({
      automationId: 'auto-retry-delivery', idempotencyKey: 'create:retry-delivery',
      definition: definition({ deliveryBindingId: 'binding-owner' }),
    })

    await value.coordinator.tick()
    await value.coordinator.whenIdle()
    expect(value.store.listRuns({ automationId: 'auto-retry-delivery', limit: 10 })[0])
      .toMatchObject({ status: 'succeeded', deliveryStatus: 'pending' })

    await value.coordinator.tick()
    expect(dispatcher.enqueueBackground).toHaveBeenCalledTimes(2)
    expect(value.store.listRuns({ automationId: 'auto-retry-delivery', limit: 10 })[0])
      .toMatchObject({ status: 'succeeded', deliveryStatus: 'enqueued', deliveryRef: 'outbox-recovered' })
    value.store.close()
  })

  test.each(['', '  HEARTBEAT_OK  '])(
    'durably suppresses an exact no-op delivery result: %j',
    async output => {
      const dispatcher: AutomationDeliveryDispatcher = {
        enqueueBackground: vi.fn(() => ({ id: 'must-not-exist', status: 'pending' })),
      }
      const value = await fixture({
        async run() { return { outcome: 'succeeded', output, usage: {} } },
      })
      value.coordinator.setDeliveryDispatcher(dispatcher)
      value.store.createApproved({
        automationId: `auto-suppress-${output.length}`, idempotencyKey: `create:suppress:${output.length}`,
        definition: definition({
          deliveryBindingId: 'binding-owner',
          deliverySuppressExact: ['HEARTBEAT_OK'],
        }),
      })

      await value.coordinator.tick()
      await value.coordinator.whenIdle()
      await value.coordinator.tick()

      expect(dispatcher.enqueueBackground).not.toHaveBeenCalled()
      expect(value.store.listRuns({ limit: 10 })[0])
        .toMatchObject({ status: 'succeeded', deliveryStatus: 'suppressed' })
      expect(value.store.listPendingDeliveries(10)).toEqual([])
      value.store.close()
    },
  )

  test('bounds concurrent launches and releases capacity after completion', async () => {
    const pending: Array<() => void> = []
    let active = 0
    let peak = 0
    const runner: AutomationRunner = {
      async run() {
        active += 1
        peak = Math.max(peak, active)
        await new Promise<void>(resolve => pending.push(resolve))
        active -= 1
        return { outcome: 'succeeded', output: 'done', usage: {} }
      },
    }
    const value = await fixture(runner, { maxConcurrency: 2 })
    for (let index = 0; index < 3; index += 1) {
      value.store.createApproved({ automationId: `auto-${index}`, idempotencyKey: `create:${index}`, definition: definition() })
    }
    await value.coordinator.tick()
    expect(peak).toBe(2)
    expect(value.store.listTasks({ limit: 10 }).filter(task => task.status === 'scheduled')).toHaveLength(1)
    pending.splice(0).forEach(resolve => resolve())
    await value.coordinator.whenIdle()
    await value.coordinator.tick()
    pending.splice(0).forEach(resolve => resolve())
    await value.coordinator.whenIdle()
    expect(value.store.listRuns({ limit: 10 })).toHaveLength(3)
    value.store.close()
  })

  test('turns a timeout into an explicit terminal result and aborts the runner', async () => {
    vi.useFakeTimers()
    let aborted = false
    const runner: AutomationRunner = {
      async run(input) {
        await new Promise<void>(resolve => input.signal.addEventListener('abort', () => {
          aborted = true
          resolve()
        }, { once: true }))
        return { outcome: 'cancelled', output: '', usage: {} }
      },
    }
    const value = await fixture(runner)
    value.store.createApproved({
      automationId: 'auto-timeout', idempotencyKey: 'create:timeout', definition: definition({ timeoutMs: 1_000 }),
    })
    await value.coordinator.tick()
    await vi.advanceTimersByTimeAsync(1_000)
    await value.coordinator.whenIdle()
    expect(aborted).toBe(true)
    expect(value.store.listRuns({ automationId: 'auto-timeout', limit: 10 })[0]).toMatchObject({ status: 'timed_out' })
    value.store.close()
    vi.useRealTimers()
  })

  test('distinguishes a safe pre-execution rejection from an ambiguous post-side-effect failure', async () => {
    for (const [id, error, expected] of [
      ['safe', new Error('adapter unavailable before Agent creation'), 'failed'],
      ['ambiguous', new AutomationRunnerAmbiguousError('flush failed after Agent execution'), 'unknown'],
    ] as const) {
      const value = await fixture({ async run() { throw error } })
      value.store.createApproved({ automationId: `auto-${id}`, idempotencyKey: `create:${id}`, definition: definition() })
      await value.coordinator.tick()
      await value.coordinator.whenIdle()
      expect(value.store.listRuns({ automationId: `auto-${id}`, limit: 10 })[0]).toMatchObject({ status: expected })
      value.store.close()
    }
  })

  test('clean shutdown aborts active work and refuses new ticks', async () => {
    const runner: AutomationRunner = {
      async run(input) {
        await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }))
        return { outcome: 'cancelled', output: 'stopped', usage: {} }
      },
    }
    const value = await fixture(runner)
    value.store.createApproved({ automationId: 'auto-stop', idempotencyKey: 'create:stop', definition: definition() })
    await value.coordinator.tick()
    await value.coordinator.stop()
    expect(value.store.listRuns({ automationId: 'auto-stop', limit: 10 })[0]).toMatchObject({ status: 'cancelled' })
    await expect(value.coordinator.tick()).rejects.toThrow('stopped')
    value.store.close()
  })

  test('heartbeats long work and actively aborts the previous run under cancel-previous', async () => {
    vi.useFakeTimers()
    let now = Date.parse('2026-08-21T10:00:00.000Z')
    const root = await mkdtemp(join(tmpdir(), 'assistant-automations-heartbeat-'))
    roots.push(root)
    const store = new AutomationStore({ path: join(root, 'state.sqlite'), now: () => now })
    const artifacts = new AutomationArtifactStore({ rootPath: join(root, 'runs'), maxBytes: 64_000 })
    const signals: AbortSignal[] = []
    const runner: AutomationRunner = {
      async run(input) {
        signals.push(input.signal)
        await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }))
        return { outcome: 'cancelled', output: 'cancelled', usage: {} }
      },
    }
    store.createApproved({
      automationId: 'auto-overlap', idempotencyKey: 'create:overlap',
      definition: definition({
        schedule: { kind: 'every', anchorAt: '2026-08-21T10:01:00.000Z', intervalMs: minute },
        misfire: { kind: 'bounded-replay', limit: 2 }, overlap: 'cancel-previous', timeoutMs: 60_000,
      }),
    })
    now = Date.parse('2026-08-21T10:02:00.000Z')
    const coordinator = new AutomationCoordinator({
      store, artifacts, runner, ownerId: 'heartbeat-owner', now: () => now,
      dutyLeaseMs: 3_000, taskLeaseMs: 3_000, misfireGraceMs: 0, maxCatchUp: 10, maxConcurrency: 2,
    })
    await coordinator.tick()
    expect(signals).toHaveLength(2)
    expect(signals[0]!.aborted).toBe(true)
    now += 2_500
    await vi.advanceTimersByTimeAsync(2_500)
    const running = store.listTasks({ automationId: 'auto-overlap', limit: 10 }).find(task => task.status === 'running')
    expect(running?.leaseUntil).toBeGreaterThan(now)
    signals[1]!.dispatchEvent(new Event('abort'))
    await coordinator.stop()
    store.close()
    vi.useRealTimers()
  })
})
