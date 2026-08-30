import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AutomationArtifactStore } from '../src/artifacts.ts'
import {
  AutomationCoordinator,
  AutomationRunnerAmbiguousError,
  type AutomationDeliveryDispatcher,
  type AutomationEvaluationRecorder,
  type AutomationOutcomeRecorder,
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
  let at = Date.parse('2026-08-21T10:01:00.000Z')
  const store = new AutomationStore({ path: join(root, 'state.sqlite'), now: () => at })
  const artifacts = new AutomationArtifactStore({ rootPath: join(root, 'runs'), maxBytes: 64_000 })
  const coordinator = new AutomationCoordinator({
    store, artifacts, runner, ownerId: 'coordinator-test', now: () => at,
    dutyLeaseMs: 10_000, taskLeaseMs: 5_000, misfireGraceMs: minute, maxCatchUp: 10,
    maxConcurrency: 2, ...overrides,
  })
  return { root, store, coordinator, advance: (milliseconds: number) => { at += milliseconds } }
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

  test('durably retries learning evidence after a sink failure without failing or rerunning work', async () => {
    const recorded: Parameters<AutomationOutcomeRecorder['recordAutomationOutcome']>[0][] = []
    let available = false
    const value = await fixture({
      async run() { return { outcome: 'failed', output: 'did not work', usage: {} } },
    })
    value.coordinator.setOutcomeRecorder({
      recordAutomationOutcome(input) {
        if (!available) throw new Error('evidence sink is down')
        recorded.push(input)
      },
    })
    value.store.createApproved({
      automationId: 'auto-eco', idempotencyKey: 'create:eco', definition: definition({ name: 'Weekly report' }),
    })

    await value.coordinator.tick()
    await value.coordinator.whenIdle()

    const run = value.store.listRuns({ automationId: 'auto-eco', limit: 10 })[0]!
    expect(run).toMatchObject({ status: 'failed', evidenceStatus: 'pending' })
    expect(recorded).toEqual([])

    available = true
    await value.coordinator.tick()
    expect(recorded).toEqual([{
      situation: 'automation:auto-eco',
      outcome: 'failed',
      detail: 'automation "Weekly report": run failed',
      idempotencyKey: `automation-run:${run.id}`,
      occurredAt: expect.any(Number),
      workspace: '/work/alpha',
      agentPreset: 'primary',
      automationId: 'auto-eco',
      runId: run.id,
    }])
    expect(value.store.listRuns({ automationId: 'auto-eco', limit: 10 })[0])
      .toMatchObject({ evidenceStatus: 'recorded' })
    await value.coordinator.tick()
    expect(recorded).toHaveLength(1)
    value.coordinator.stop()
    value.store.close()
  })

  test('durably retries unified evaluation without rerunning work or coupling Evolution evidence', async () => {
    const recorded: Parameters<AutomationEvaluationRecorder['append']>[0][] = []
    let available = false
    let executions = 0
    const value = await fixture({
      async run() {
        executions += 1
        return { outcome: 'failed', output: 'did not work', usage: { inputTokens: 7, outputTokens: 2 } }
      },
    })
    value.coordinator.setEvaluationRecorder({
      async append(input) {
        if (!available) throw new Error('evaluation ledger is down')
        recorded.push(input)
      },
    })
    value.store.createApproved({
      automationId: 'auto-evaluation', idempotencyKey: 'create:evaluation', definition: definition(),
    })

    await value.coordinator.tick()
    await value.coordinator.whenIdle()
    expect(executions).toBe(1)
    expect(recorded).toEqual([])
    expect(value.store.listPendingEvaluations(10)).toEqual([
      expect.objectContaining({
        status: 'pending', payload: expect.objectContaining({
          executionStatus: 'failed', objectiveStatus: 'unknown', deliveryStatus: 'not-required',
          metrics: expect.objectContaining({ inputTokens: 7, outputTokens: 2 }),
        }),
      }),
    ])

    available = true
    value.advance(1_000)
    await value.coordinator.tick()
    await value.coordinator.whenIdle()
    expect(executions).toBe(1)
    expect(recorded).toHaveLength(1)
    expect(value.store.listPendingEvaluations(10)).toEqual([])
    // Evolution owns a separate outbox and remains pending because no Evolution
    // recorder was attached; Evaluation success cannot settle it.
    expect(value.store.listPendingEvidence(10)).toHaveLength(1)
    await value.coordinator.stop()
    value.store.close()
  })

  test('flushes a durable Evaluation backlog when the optional sink is attached later', async () => {
    let executions = 0
    const value = await fixture({
      async run() {
        executions += 1
        return { outcome: 'succeeded', output: 'done', usage: {} }
      },
    })
    value.store.createApproved({
      automationId: 'evaluation-late-attach', idempotencyKey: 'create:evaluation-late-attach',
      definition: definition(),
    })
    await value.coordinator.tick()
    await value.coordinator.whenIdle()
    expect(executions).toBe(1)
    expect(value.store.listPendingEvaluations(10)).toHaveLength(1)

    const recorded: Parameters<AutomationEvaluationRecorder['append']>[0][] = []
    value.coordinator.setEvaluationRecorder({ async append(input) { recorded.push(input) } })
    await value.coordinator.whenIdle()

    expect(recorded).toHaveLength(1)
    expect(value.store.listPendingEvaluations(10)).toEqual([])
    expect(executions).toBe(1)
    await value.coordinator.stop()
    value.store.close()
  })

  test('recovers pending evidence after restart when a recorder is attached later', async () => {
    let executions = 0
    const runner: AutomationRunner = {
      async run() {
        executions += 1
        return { outcome: 'succeeded', output: 'fine', usage: {} }
      },
    }
    const value = await fixture(runner)
    value.store.createApproved({
      automationId: 'auto-resilient', idempotencyKey: 'create:resilient', definition: definition(),
    })

    await value.coordinator.tick()
    await value.coordinator.whenIdle()
    expect(value.store.listRuns({ automationId: 'auto-resilient', limit: 10 })[0])
      .toMatchObject({ status: 'succeeded', evidenceStatus: 'pending' })
    await value.coordinator.stop()
    value.store.close()

    const reopened = new AutomationStore({ path: join(value.root, 'state.sqlite') })
    const recorded: Parameters<AutomationOutcomeRecorder['recordAutomationOutcome']>[0][] = []
    const restarted = new AutomationCoordinator({
      store: reopened,
      artifacts: new AutomationArtifactStore({ rootPath: join(value.root, 'runs'), maxBytes: 64_000 }),
      runner,
      ownerId: 'coordinator-restarted',
      now: () => Date.parse('2026-08-21T10:01:10.001Z'),
      dutyLeaseMs: 10_000,
      taskLeaseMs: 5_000,
      misfireGraceMs: minute,
      maxCatchUp: 10,
      maxConcurrency: 2,
    })
    restarted.setOutcomeRecorder({ recordAutomationOutcome(input) { recorded.push(input) } })
    await restarted.tick()

    expect(executions).toBe(1)
    expect(recorded).toHaveLength(1)
    expect(reopened.listRuns({ automationId: 'auto-resilient', limit: 10 })[0])
      .toMatchObject({ evidenceStatus: 'recorded' })
    await restarted.stop()
    reopened.close()
  })

  test('durably suppresses nondecisive outcomes', async () => {
    const recorded: unknown[] = []
    const value = await fixture({
      async run() {
        return { outcome: 'cancelled', output: '', usage: {} }
      },
    })
    value.coordinator.setOutcomeRecorder({
      recordAutomationOutcome(input) { recorded.push(input) },
    })
    value.store.createApproved({
      automationId: 'auto-cancelled', idempotencyKey: 'create:cancelled', definition: definition(),
    })

    await value.coordinator.tick()
    await value.coordinator.whenIdle()

    expect(recorded).toEqual([])
    expect(value.store.listRuns({ automationId: 'auto-cancelled', limit: 10 })[0])
      .toMatchObject({ status: 'cancelled', evidenceStatus: 'suppressed' })
    expect(value.store.listPendingEvidence(10)).toEqual([])
    value.coordinator.stop()
    value.store.close()
  })

  test('uses immutable automation identity across renames while preserving the display name in detail', async () => {
    const recorded: Parameters<AutomationOutcomeRecorder['recordAutomationOutcome']>[0][] = []
    const value = await fixture({
      async run() { return { outcome: 'succeeded', output: 'done', usage: {} } },
    })
    value.coordinator.setOutcomeRecorder({ recordAutomationOutcome(input) { recorded.push(input) } })
    value.store.reconcileSystemOwned({
      owner: 'heartbeat', automationId: 'auto-renamed', idempotencyKey: 'auto-renamed:v1',
      definition: definition({
        name: 'Old display name', schedule: { kind: 'at', at: '2027-08-21T10:01:00.000Z' },
      }),
    })
    value.store.createManual({ automationId: 'auto-renamed', requestId: 'first', dryRun: false })
    await value.coordinator.tick()
    await value.coordinator.whenIdle()
    await value.coordinator.tick()

    value.store.reconcileSystemOwned({
      owner: 'heartbeat', automationId: 'auto-renamed', idempotencyKey: 'auto-renamed:v2',
      definition: definition({
        name: 'New display name', schedule: { kind: 'at', at: '2027-08-21T10:01:00.000Z' },
      }),
    })
    value.store.createManual({ automationId: 'auto-renamed', requestId: 'second', dryRun: false })
    await value.coordinator.tick()
    await value.coordinator.whenIdle()
    await value.coordinator.tick()

    expect(recorded.map(item => item.situation)).toEqual([
      'automation:auto-renamed', 'automation:auto-renamed',
    ])
    expect(recorded.map(item => item.detail)).toEqual([
      'automation "Old display name": run succeeded',
      'automation "New display name": run succeeded',
    ])
    await value.coordinator.stop()
    value.store.close()
  })

  test('queries a durable exposure receipt only after the runner returns its exact session', async () => {
    const recorded: Parameters<AutomationOutcomeRecorder['recordAutomationOutcome']>[0][] = []
    const captures: Parameters<NonNullable<AutomationOutcomeRecorder['captureAutomationExposure']>>[0][] = []
    const order: string[] = []
    let receiptPersisted = false
    const value = await fixture({
      async run(input) {
        order.push('runner')
        receiptPersisted = true
        return { outcome: 'succeeded', sessionId: input.sessionId, output: 'done', usage: {} }
      },
    })
    value.coordinator.setOutcomeRecorder({
      async captureAutomationExposure(input) {
        order.push('receipt-query')
        captures.push(input)
        return receiptPersisted ? { ruleId: 'rule-weekly-v2', guidanceVersion: 2 } : undefined
      },
      recordAutomationOutcome(input) { recorded.push(input) },
    })
    value.store.createApproved({
      automationId: 'auto-exposure', idempotencyKey: 'create:exposure', definition: definition(),
    })

    await value.coordinator.tick()
    await value.coordinator.whenIdle()
    await value.coordinator.tick()

    expect(captures).toEqual([{
      workspace: '/work/alpha', agentPreset: 'primary', automationId: 'auto-exposure',
      sessionId: expect.stringMatching(/^automation-/),
    }])
    expect(recorded).toEqual([expect.objectContaining({
      automationId: 'auto-exposure', sessionId: captures[0]!.sessionId,
      ruleId: 'rule-weekly-v2', guidanceVersion: 2,
    })])
    expect(order).toEqual(['runner', 'receipt-query'])
    await value.coordinator.stop()
    value.store.close()
  })

  test('does not attribute a merely planned exposure without a persisted receipt', async () => {
    const recorded: Parameters<AutomationOutcomeRecorder['recordAutomationOutcome']>[0][] = []
    const value = await fixture({
      async run(input) { return { outcome: 'failed', sessionId: input.sessionId, output: 'failed', usage: {} } },
    })
    value.coordinator.setOutcomeRecorder({
      captureAutomationExposure() { return undefined },
      recordAutomationOutcome(input) { recorded.push(input) },
    })
    value.store.createApproved({
      automationId: 'auto-no-receipt', idempotencyKey: 'create:no-receipt', definition: definition(),
    })

    await value.coordinator.tick()
    await value.coordinator.whenIdle()
    await value.coordinator.tick()

    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toHaveProperty('sessionId')
    expect(recorded[0]).not.toHaveProperty('ruleId')
    expect(recorded[0]).not.toHaveProperty('guidanceVersion')
    await value.coordinator.stop()
    value.store.close()
  })

  test.each([
    ['missing', undefined],
    ['wrong', 'another-session'],
  ] as const)('omits exposure for a %s runner session receipt', async (_label, returnedSessionId) => {
    const recorded: Parameters<AutomationOutcomeRecorder['recordAutomationOutcome']>[0][] = []
    let queries = 0
    const value = await fixture({
      async run() {
        return {
          outcome: 'failed',
          ...(returnedSessionId === undefined ? {} : { sessionId: returnedSessionId }),
          output: 'setup rejected',
          usage: {},
        }
      },
    })
    value.coordinator.setOutcomeRecorder({
      captureAutomationExposure() {
        queries += 1
        return { ruleId: 'must-not-be-attributed', guidanceVersion: 9 }
      },
      recordAutomationOutcome(input) { recorded.push(input) },
    })
    value.store.createApproved({
      automationId: `auto-${_label}-session`, idempotencyKey: `create:${_label}-session`,
      definition: definition(),
    })

    await value.coordinator.tick()
    await value.coordinator.whenIdle()
    await value.coordinator.tick()

    expect(queries).toBe(0)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).not.toHaveProperty('sessionId')
    expect(recorded[0]).not.toHaveProperty('ruleId')
    expect(recorded[0]).not.toHaveProperty('guidanceVersion')
    await value.coordinator.stop()
    value.store.close()
  })

  test('bounds a stalled exposure receipt query and still commits the terminal run', async () => {
    vi.useFakeTimers()
    const recorded: Parameters<AutomationOutcomeRecorder['recordAutomationOutcome']>[0][] = []
    const value = await fixture({
      async run(input) {
        return { outcome: 'succeeded', sessionId: input.sessionId, output: 'done', usage: {} }
      },
    })
    value.coordinator.setOutcomeRecorder({
      captureAutomationExposure() { return new Promise(() => {}) },
      recordAutomationOutcome(input) { recorded.push(input) },
    })
    value.store.createApproved({
      automationId: 'auto-stalled-receipt', idempotencyKey: 'create:stalled-receipt', definition: definition(),
    })

    await value.coordinator.tick()
    await vi.advanceTimersByTimeAsync(2_000)
    await value.coordinator.whenIdle()

    expect(recorded).toHaveLength(1)
    expect(recorded[0]).not.toHaveProperty('ruleId')
    expect(recorded[0]).not.toHaveProperty('guidanceVersion')
    expect(value.store.listRuns({ automationId: 'auto-stalled-receipt', limit: 10 })[0])
      .toMatchObject({ status: 'succeeded', evidenceStatus: 'recorded' })
    await value.coordinator.stop()
    value.store.close()
    vi.useRealTimers()
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
