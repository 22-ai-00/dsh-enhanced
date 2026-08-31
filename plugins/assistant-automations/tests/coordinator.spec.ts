import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { DeliveryPresentationUpdate } from '@dsh-enhanced/assistant-delivery'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AutomationArtifactStore } from '../src/artifacts.ts'
import { HostAutomationExecutorRegistry } from '../src/host-executors.ts'
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

async function fixture(
  runner: AutomationRunner,
  overrides: Record<string, number> = {},
  hostExecutors?: HostAutomationExecutorRegistry,
) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-automations-coordinator-'))
  roots.push(root)
  let at = Date.parse('2026-08-21T10:01:00.000Z')
  const store = new AutomationStore({ path: join(root, 'state.sqlite'), now: () => at })
  const artifacts = new AutomationArtifactStore({ rootPath: join(root, 'runs'), maxBytes: 64_000 })
  const coordinator = new AutomationCoordinator({
    store, artifacts, runner, ownerId: 'coordinator-test', now: () => at,
    dutyLeaseMs: 10_000, taskLeaseMs: 5_000, misfireGraceMs: minute, maxCatchUp: 10,
    maxConcurrency: 2, ...overrides,
    ...(hostExecutors === undefined ? {} : { hostExecutors }),
  })
  return { root, store, artifacts, coordinator, advance: (milliseconds: number) => { at += milliseconds } }
}

function hostDefinition(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Supervised growth v2',
    schedule: { kind: 'at', at: '2026-08-21T10:01:00.000Z' },
    workspace: '/work/alpha', agentPreset: 'primary', timeoutMs: minute,
    misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0,
    principal: 'owner:lark:123',
    execution: {
      kind: 'host', executorId: 'assistant-recovery', executorContractVersion: 2,
      runbookId: 'supervised-growth/v2', runbookVersion: 2,
      catalogDigest: 'a'.repeat(64),
      targetScope: { workspace: '/work/alpha', preset: 'primary' },
      scopeDigest: '0'.repeat(64), ownerRouteId: 'lark/main/tenant/owner', activationNonce: 'activation-1',
    },
    ...overrides,
  }
}

describe('automation coordinator', () => {
  test('a clean restart takes duty immediately without waiting for the old lease', async () => {
    const calls: string[] = []
    const runner: AutomationRunner = {
      async run(input) {
        calls.push(input.automation.id)
        return { outcome: 'succeeded', sessionId: input.sessionId, output: 'done', usage: {} }
      },
    }
    const value = await fixture(runner)
    value.store.createApproved({
      automationId: 'before-restart', idempotencyKey: 'restart:first', definition: definition(),
    })
    await value.coordinator.tick()
    await value.coordinator.whenIdle()
    await value.coordinator.stop()

    value.store.createApproved({
      automationId: 'after-restart', idempotencyKey: 'restart:second', definition: definition(),
    })
    const restarted = new AutomationCoordinator({
      store: value.store, artifacts: value.artifacts, runner, ownerId: 'coordinator-restarted',
      now: () => Date.parse('2026-08-21T10:01:00.000Z'), dutyLeaseMs: 10_000,
      taskLeaseMs: 5_000, misfireGraceMs: minute, maxCatchUp: 10, maxConcurrency: 2,
    })
    await restarted.tick()
    await restarted.whenIdle()

    expect(calls).toEqual(['before-restart', 'after-restart'])
    await restarted.stop()
    value.store.close()
  })

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
    await value.coordinator.stop()
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
    await value.coordinator.stop()
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
    await value.coordinator.stop()
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

  test('never captures or records learning exposure for an exact-session preview', async () => {
    const captureAutomationExposure = vi.fn(() => ({ ruleId: 'must-not-observe-preview', guidanceVersion: 1 }))
    const recordAutomationOutcome = vi.fn()
    const value = await fixture({
      async run(input) {
        return { outcome: 'succeeded', sessionId: input.sessionId, output: 'preview only', usage: {} }
      },
    })
    value.coordinator.setOutcomeRecorder({ captureAutomationExposure, recordAutomationOutcome })
    value.store.createApproved({
      automationId: 'auto-preview-exposure', idempotencyKey: 'create:preview-exposure',
      definition: definition({ schedule: { kind: 'at', at: '2027-08-21T10:01:00.000Z' } }),
    })
    value.store.createManual({ automationId: 'auto-preview-exposure', requestId: 'preview', dryRun: true })

    await value.coordinator.tick()
    await value.coordinator.whenIdle()
    await value.coordinator.tick()

    expect(captureAutomationExposure).not.toHaveBeenCalled()
    expect(recordAutomationOutcome).not.toHaveBeenCalled()
    expect(value.store.listRuns({ automationId: 'auto-preview-exposure', limit: 10 })[0])
      .toMatchObject({ executionMode: 'preview', evidenceStatus: 'suppressed' })
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

  test('times out a non-cooperative runner with a durable unknown receipt and fences its late result', async () => {
    vi.useFakeTimers()
    let finish!: (value: Awaited<ReturnType<AutomationRunner['run']>>) => void
    const value = await fixture({
      run() {
        return new Promise(resolve => { finish = resolve })
      },
    })
    value.store.createApproved({
      automationId: 'auto-non-cooperative', idempotencyKey: 'create:non-cooperative',
      definition: definition({ timeoutMs: 1_000 }),
    })

    await value.coordinator.tick()
    await vi.advanceTimersByTimeAsync(1_000)
    await value.coordinator.whenIdle()
    expect(value.store.listRuns({ automationId: 'auto-non-cooperative', limit: 10 })[0]).toMatchObject({
      status: 'timed_out',
      diagnostic: {
        failureClass: 'timeout', failureCode: 'execution-timeout',
        promptSubmissionState: 'unknown', sideEffectState: 'unknown', retryability: 'unsafe',
      },
    })

    finish({ outcome: 'succeeded', output: 'too late', usage: {}, diagnostic: {
      schemaVersion: 1, failureClass: 'none', failurePhase: 'none', failureCode: 'none',
      promptSubmissionState: 'submitted', sideEffectState: 'none', retryability: 'safe',
      budgetSettlementState: 'not-required',
    } })
    await vi.runAllTimersAsync()
    expect(value.store.listRuns({ automationId: 'auto-non-cooperative', limit: 10 })).toEqual([
      expect.objectContaining({ status: 'timed_out', outputPreview: expect.not.stringContaining('too late') }),
    ])
    await value.coordinator.stop()
    value.store.close()
    vi.useRealTimers()
  }, 2_000)

  test('cleans execution timers and commits unknown when circuit projection throws', async () => {
    vi.useFakeTimers()
    const runner: AutomationRunner = {
      run: vi.fn(async () => ({ outcome: 'succeeded' as const, output: 'must not run', usage: {} })),
    }
    const value = await fixture(runner)
    vi.spyOn(value.store, 'acquireCircuitExecutionForTask').mockImplementationOnce(() => {
      throw new Error('corrupt circuit projection')
    })
    value.store.createApproved({
      automationId: 'auto-corrupt-circuit', idempotencyKey: 'create:corrupt-circuit', definition: definition(),
    })

    await value.coordinator.tick()
    await value.coordinator.whenIdle()

    expect(runner.run).not.toHaveBeenCalled()
    expect(value.store.listRuns({ automationId: 'auto-corrupt-circuit', limit: 10 })[0]).toMatchObject({
      status: 'unknown', diagnostic: {
        failureClass: 'infrastructure', failurePhase: 'preflight', failureCode: 'circuit-admission-failed',
        promptSubmissionState: 'not-submitted', sideEffectState: 'none',
      },
    })
    expect(vi.getTimerCount()).toBe(0)
    await value.coordinator.stop()
    value.store.close()
    vi.useRealTimers()
  })

  test('durably quarantines a corrupt immutable snapshot before invoking the runner', async () => {
    const run = vi.fn(async () => ({ outcome: 'succeeded' as const, output: 'must not run', usage: {} }))
    const value = await fixture({ run })
    value.store.createApproved({
      automationId: 'auto-corrupt-snapshot', idempotencyKey: 'create:corrupt-snapshot',
      definition: definition({ schedule: { kind: 'at', at: '2027-08-21T10:01:00.000Z' } }),
    })
    value.store.createManual({ automationId: 'auto-corrupt-snapshot', requestId: 'corrupt', dryRun: false })
    const duty = value.store.acquireDuty({
      ownerId: 'coordinator-test', now: Date.parse('2026-08-21T10:01:00.000Z'), leaseMs: 10_000,
    })
    const claimed = value.store.claimNextTask({
      ownerId: 'coordinator-test', fencingToken: duty.fencingToken,
      now: Date.parse('2026-08-21T10:01:00.001Z'), leaseMs: 5_000,
    })!
    const database = new DatabaseSync(join(value.root, 'state.sqlite'))
    database.prepare(`
      UPDATE automation_attempts SET automation_snapshot_json = '{}' WHERE task_id = ?
    `).run(claimed.id)
    database.close()
    const executor = value.coordinator as unknown as {
      fencingToken: number | undefined
      execute(task: typeof claimed, controller: AbortController): Promise<void>
    }
    executor.fencingToken = duty.fencingToken

    await executor.execute(claimed, new AbortController())

    expect(run).not.toHaveBeenCalled()
    expect(value.store.getTaskRecord(claimed.id)).toMatchObject({ status: 'unknown' })
    expect(value.store.getOccurrence(claimed.occurrenceId)).toMatchObject({
      status: 'unknown', reason: 'execution-snapshot-invalid',
    })
    const quarantinedRun = value.store.listRuns({ automationId: 'auto-corrupt-snapshot', limit: 10 })[0]!
    expect(quarantinedRun).toMatchObject({
      status: 'unknown', executionMode: 'production', evidenceStatus: 'suppressed',
      diagnostic: {
        failureClass: 'infrastructure', failurePhase: 'recovery', failureCode: 'execution-snapshot-invalid',
      },
    })
    expect(quarantinedRun).not.toHaveProperty('definitionHash')
    await value.coordinator.stop()
    value.store.close()
  })

  test('commits a content-free unknown receipt immediately when artifact persistence fails', async () => {
    const value = await fixture({
      async run(input) {
        return { outcome: 'succeeded', sessionId: input.sessionId, output: 'sensitive completed output', usage: {}, diagnostic: {
          schemaVersion: 1, failureClass: 'none', failurePhase: 'none', failureCode: 'none',
          promptSubmissionState: 'submitted', sideEffectState: 'possible', retryability: 'unsafe',
          budgetSettlementState: 'not-required',
        } }
      },
    })
    vi.spyOn(value.artifacts, 'write').mockImplementationOnce(() => { throw new Error('disk fault') })
    value.store.createApproved({
      automationId: 'auto-artifact-fault', idempotencyKey: 'create:artifact-fault', definition: definition(),
    })

    await value.coordinator.tick()
    await value.coordinator.whenIdle()

    const run = value.store.listRuns({ automationId: 'auto-artifact-fault', limit: 10 })[0]!
    expect(run).toMatchObject({
      status: 'unknown', outputPreview: 'artifact persistence failed', evidenceStatus: 'suppressed',
      diagnostic: {
        failureClass: 'infrastructure', failurePhase: 'artifact-write', failureCode: 'artifact-write-failed',
        promptSubmissionState: 'submitted', sideEffectState: 'possible', retryability: 'unsafe',
      },
    })
    expect(run).not.toHaveProperty('artifactRef')
    await value.coordinator.stop()
    value.store.close()
  })

  test('durably enqueues a successful run through Delivery with a stable key', async () => {
    const dispatcher: AutomationDeliveryDispatcher = {
      enqueueBackground: vi.fn(() => ({ id: 'outbox-1', status: 'pending' })),
      enqueueAutomationResult: vi.fn(() => ({ id: 'outbox-1', status: 'pending' })),
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
    expect(dispatcher.enqueueBackground).not.toHaveBeenCalled()
    expect(dispatcher.enqueueAutomationResult).toHaveBeenCalledOnce()
    expect(dispatcher.enqueueAutomationResult).toHaveBeenCalledWith({
      automationId: 'auto-delivery', runId: run.id, workspace: '/work/alpha',
      bindingId: 'binding-owner', outputPreview: 'scheduled result',
    })
    expect(run).toMatchObject({ status: 'succeeded' })
    expect(value.store.listRuns({ automationId: 'auto-delivery', limit: 10 })[0])
      .toMatchObject({ status: 'succeeded', deliveryStatus: 'enqueued', deliveryRef: 'outbox-1' })
    value.store.close()
  })

  test('never enqueues Delivery for a successful delivery-bound dry run', async () => {
    const dispatcher: AutomationDeliveryDispatcher = {
      enqueueBackground: vi.fn(() => ({ id: 'must-not-exist', status: 'pending' })),
    }
    const value = await fixture({
      async run() { return { outcome: 'succeeded', output: 'preview only', usage: {} } },
    })
    value.coordinator.setDeliveryDispatcher(dispatcher)
    value.store.createApproved({
      automationId: 'auto-dry-run-delivery', idempotencyKey: 'create:dry-run-delivery',
      definition: definition({
        deliveryBindingId: 'binding-owner',
        schedule: { kind: 'at', at: '2026-08-21T11:01:00.000Z' },
      }),
    })
    value.store.createManual({
      automationId: 'auto-dry-run-delivery', requestId: 'preview-one', dryRun: true,
    })

    await value.coordinator.tick()
    await value.coordinator.whenIdle()
    await value.coordinator.tick()

    expect(dispatcher.enqueueBackground).not.toHaveBeenCalled()
    const run = value.store.listRuns({ automationId: 'auto-dry-run-delivery', limit: 10 })[0]!
    expect(run).toMatchObject({ status: 'succeeded' })
    expect(value.store.getRunExecutionMode(run.id)).toBe('preview')
    expect(run).not.toHaveProperty('deliveryStatus')
    expect(run.evidenceStatus).toBe('suppressed')
    expect(value.store.getPendingEvaluationForRun(run.id)).toBeUndefined()
    expect(value.store.listPendingEvaluations(10)).toEqual([])
    expect(value.store.listPendingEvidence(10)).toEqual([])
    expect(value.store.listPendingDeliveries(10)).toEqual([])
    value.store.close()
  })

  test('suppresses a legacy pending preview before the Delivery sink', async () => {
    const dispatcher: AutomationDeliveryDispatcher = {
      enqueueBackground: vi.fn(() => ({ id: 'must-not-exist', status: 'pending' })),
    }
    const value = await fixture({
      async run() { return { outcome: 'succeeded', output: 'legacy preview', usage: {} } },
    })
    value.coordinator.setDeliveryDispatcher(dispatcher)
    value.store.createApproved({
      automationId: 'legacy-dry-run-delivery', idempotencyKey: 'create:legacy-dry-run-delivery',
      definition: definition({
        deliveryBindingId: 'binding-owner',
        schedule: { kind: 'at', at: '2026-08-21T11:01:00.000Z' },
      }),
    })
    value.store.createManual({
      automationId: 'legacy-dry-run-delivery', requestId: 'legacy-preview', dryRun: true,
    })
    await value.coordinator.tick()
    await value.coordinator.whenIdle()
    const run = value.store.listRuns({ automationId: 'legacy-dry-run-delivery', limit: 10 })[0]!

    const database = new DatabaseSync(join(value.root, 'state.sqlite'))
    database.prepare(`UPDATE automation_runs SET delivery_status = 'pending' WHERE id = ?`).run(run.id)
    database.close()

    await value.coordinator.tick()

    expect(dispatcher.enqueueBackground).not.toHaveBeenCalled()
    expect(value.store.getRun(run.id)).toMatchObject({ deliveryStatus: 'suppressed' })
    expect(value.store.listPendingDeliveries(10)).toEqual([])
    value.store.close()
  })

  test('keeps execution succeeded and retries the same delivery intent after restart-safe failure', async () => {
    const dispatcher: AutomationDeliveryDispatcher = {
      enqueueBackground: vi.fn(),
      enqueueAutomationResult: vi.fn()
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
    expect(dispatcher.enqueueAutomationResult).toHaveBeenCalledTimes(2)
    expect(value.store.listRuns({ automationId: 'auto-retry-delivery', limit: 10 })[0])
      .toMatchObject({ status: 'succeeded', deliveryStatus: 'enqueued', deliveryRef: 'outbox-recovered' })
    value.store.close()
  })

  test('persists an exact configuration circuit across restart and fences definition ABA', async () => {
    let executions = 0
    const runner: AutomationRunner = {
      async run() {
        executions += 1
        return {
          outcome: 'failed', output: 'immutable tool surface mismatch', usage: {},
          diagnostic: {
            schemaVersion: 1, failureClass: 'configuration', failurePhase: 'agent-setup',
            failureCode: 'tool-surface-mismatch', promptSubmissionState: 'not-submitted',
            sideEffectState: 'none', retryability: 'after-intervention',
            budgetSettlementState: 'not-required',
          },
        }
      },
    }
    const value = await fixture(runner)
    const v1 = definition({
      prompt: 'v1', schedule: { kind: 'at', at: '2027-08-21T10:01:00.000Z' },
    })
    value.store.reconcileSystemOwned({
      owner: 'heartbeat', automationId: 'circuit-aba', idempotencyKey: 'circuit:v1', definition: v1,
    })
    value.store.createManual({ automationId: 'circuit-aba', requestId: 'first', dryRun: false })
    await value.coordinator.tick()
    await value.coordinator.whenIdle()
    const hashV1 = value.store.getDefinitionHash('circuit-aba')!
    expect(value.store.getCircuit('circuit-aba', hashV1)).toMatchObject({
      state: 'open', version: 1, failureCode: 'tool-surface-mismatch',
    })

    // Queue another exact-v1 occurrence, then prove a new process blocks it
    // before the runner (and therefore before any budget reservation/Agent).
    value.store.createManual({ automationId: 'circuit-aba', requestId: 'restart-blocked', dryRun: false })
    await value.coordinator.stop()
    value.store.close()

    const reopened = new AutomationStore({ path: join(value.root, 'state.sqlite') })
    const restartNow = Date.parse('2026-08-21T10:01:20.000Z')
    const restarted = new AutomationCoordinator({
      store: reopened,
      artifacts: new AutomationArtifactStore({ rootPath: join(value.root, 'runs'), maxBytes: 64_000 }),
      runner,
      ownerId: 'coordinator-circuit-restart',
      now: () => restartNow,
      dutyLeaseMs: 10_000,
      taskLeaseMs: 5_000,
      misfireGraceMs: minute,
      maxCatchUp: 10,
      maxConcurrency: 1,
    })
    await restarted.tick()
    await restarted.whenIdle()
    expect(executions).toBe(1)
    expect(reopened.listRuns({ automationId: 'circuit-aba', limit: 10 }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ diagnostic: expect.objectContaining({ failureCode: 'circuit-open' }) }),
      ]))

    // A genuinely changed definition gets an independent circuit key.
    reopened.reconcileSystemOwned({
      owner: 'heartbeat', automationId: 'circuit-aba', idempotencyKey: 'circuit:v2',
      definition: { ...v1, prompt: 'v2' },
    })
    const hashV2 = reopened.getDefinitionHash('circuit-aba')!
    expect(hashV2).not.toBe(hashV1)
    reopened.createManual({ automationId: 'circuit-aba', requestId: 'changed-definition', dryRun: false })
    await restarted.tick()
    await restarted.whenIdle()
    expect(executions).toBe(2)
    expect(reopened.getCircuit('circuit-aba', hashV2)).toMatchObject({ state: 'open' })

    // Reverting to the exact old bytes is an ABA and revives the old open
    // circuit. Only the Host's exact hash/version probe may close it.
    reopened.reconcileSystemOwned({
      owner: 'heartbeat', automationId: 'circuit-aba', idempotencyKey: 'circuit:v1-again', definition: v1,
    })
    expect(reopened.getDefinitionHash('circuit-aba')).toBe(hashV1)
    reopened.createManual({ automationId: 'circuit-aba', requestId: 'aba-blocked', dryRun: false })
    await restarted.tick()
    await restarted.whenIdle()
    expect(executions).toBe(2)
    const oldCircuit = reopened.getCircuit('circuit-aba', hashV1)!
    reopened.armCircuitProbe({
      owner: 'heartbeat', operationId: 'probe:circuit-aba',
      automationId: 'circuit-aba', definitionHash: hashV1,
      expectedVersion: oldCircuit.version, now: restartNow + 1, leaseMs: 5_000,
    })
    reopened.createManual({ automationId: 'circuit-aba', requestId: 'exact-probe', dryRun: false })
    await restarted.tick()
    await restarted.whenIdle()
    expect(executions).toBe(3)
    expect(reopened.getCircuit('circuit-aba', hashV1)).toMatchObject({ state: 'open', version: 4 })

    await restarted.stop()
    reopened.close()
  })

  test('runs only one coordinator task through an armed exact-definition probe', async () => {
    const run = vi.fn(async (input: AutomationRunnerInput) => ({
      outcome: 'succeeded' as const, sessionId: input.sessionId, output: 'probe passed', usage: {}, diagnostic: {
        schemaVersion: 1 as const, failureClass: 'none' as const, failurePhase: 'none' as const,
        failureCode: 'none', promptSubmissionState: 'submitted' as const,
        sideEffectState: 'possible' as const, retryability: 'unsafe' as const,
        budgetSettlementState: 'not-required' as const,
      },
    }))
    const value = await fixture({ run })
    value.store.reconcileSystemOwned({
      owner: 'heartbeat', automationId: 'circuit-single-runner', idempotencyKey: 'create:circuit-single-runner',
      definition: definition({
        overlap: 'cancel-previous', schedule: { kind: 'at', at: '2027-08-21T10:01:00.000Z' },
      }),
    })
    value.store.createManual({ automationId: 'circuit-single-runner', requestId: 'opening', dryRun: false })
    const duty = value.store.acquireDuty({ ownerId: 'coordinator-test', now: Date.parse('2026-08-21T10:01:00.000Z'), leaseMs: 10_000 })
    const opening = value.store.claimNextTask({
      ownerId: 'coordinator-test', fencingToken: duty.fencingToken,
      now: Date.parse('2026-08-21T10:01:00.001Z'), leaseMs: 5_000,
    })!
    value.store.startTask({
      taskId: opening.id, ownerId: 'coordinator-test', fencingToken: duty.fencingToken,
      now: Date.parse('2026-08-21T10:01:00.002Z'), leaseMs: 5_000, sessionId: 'opening',
    })
    value.store.completeTask({
      taskId: opening.id, ownerId: 'coordinator-test', fencingToken: duty.fencingToken,
      now: Date.parse('2026-08-21T10:01:00.003Z'), outcome: 'failed', outputPreview: 'bad config', usage: {},
      diagnostic: {
        schemaVersion: 1, failureClass: 'configuration', failurePhase: 'preflight',
        failureCode: 'bad-configuration', promptSubmissionState: 'not-submitted', sideEffectState: 'none',
        retryability: 'after-intervention', budgetSettlementState: 'not-required',
      },
    })
    const definitionHash = value.store.getDefinitionHash('circuit-single-runner')!
    const open = value.store.getCircuit('circuit-single-runner', definitionHash)!
    value.store.armCircuitProbe({
      owner: 'heartbeat', operationId: 'probe:single-runner',
      automationId: 'circuit-single-runner', definitionHash, expectedVersion: open.version,
      now: Date.parse('2026-08-21T10:01:00.004Z'), leaseMs: 5_000,
    })
    value.store.createManual({ automationId: 'circuit-single-runner', requestId: 'probe-a', dryRun: false })
    value.store.createManual({ automationId: 'circuit-single-runner', requestId: 'probe-b', dryRun: false })
    const first = value.store.claimNextTask({
      ownerId: 'coordinator-test', fencingToken: duty.fencingToken,
      now: Date.parse('2026-08-21T10:01:00.005Z'), leaseMs: 5_000,
    })!
    const second = value.store.claimNextTask({
      ownerId: 'coordinator-test', fencingToken: duty.fencingToken,
      now: Date.parse('2026-08-21T10:01:00.006Z'), leaseMs: 5_000,
    })!
    const executor = value.coordinator as unknown as {
      fencingToken: number | undefined
      execute(claimed: typeof first, controller: AbortController): Promise<void>
    }
    executor.fencingToken = duty.fencingToken

    await Promise.all([
      executor.execute(first, new AbortController()),
      executor.execute(second, new AbortController()),
    ])

    expect(run).toHaveBeenCalledOnce()
    expect(value.store.listRuns({ automationId: 'circuit-single-runner', limit: 10 }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'succeeded' }),
        expect.objectContaining({ status: 'failed', diagnostic: expect.objectContaining({ failureCode: 'circuit-open' }) }),
      ]))
    expect(value.store.getCircuit('circuit-single-runner', definitionHash)).toMatchObject({
      state: 'closed', version: open.version + 3,
    })
    await value.coordinator.stop()
    value.store.close()
  })

  test.each(['configuration', 'policy', 'budget'] as const)(
    'opens a persistent exact-definition circuit on the first %s failure',
    async failureClass => {
      const value = await fixture({
        async run() {
          return {
            outcome: failureClass === 'policy' ? 'cancelled' : 'failed',
            output: `${failureClass} failure`,
            usage: {},
            diagnostic: {
              schemaVersion: 1, failureClass,
              failurePhase: failureClass === 'budget' ? 'budget-reservation' : 'preflight',
              failureCode: `${failureClass}-failed`,
              promptSubmissionState: 'not-submitted', sideEffectState: 'none',
              retryability: 'after-intervention', budgetSettlementState: 'not-required',
            },
          }
        },
      })
      const automationId = `circuit-${failureClass}`
      value.store.createApproved({
        automationId, idempotencyKey: `create:${automationId}`, definition: definition(),
      })
      await value.coordinator.tick()
      await value.coordinator.whenIdle()
      const definitionHash = value.store.getDefinitionHash(automationId)!
      expect(value.store.getCircuit(automationId, definitionHash)).toMatchObject({
        state: 'open', failureClass, failureCode: `${failureClass}-failed`, version: 1,
      })
      expect(value.store.health().openCircuits).toBe(1)
      await value.coordinator.stop()
      value.store.close()
    },
  )

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
      automationId: 'auto-timeout', idempotencyKey: 'create:timeout',
      definition: definition({ timeoutMs: 1_000, approvalBindingId: 'binding-timeout-owner' }),
    })
    await value.coordinator.tick()
    await vi.advanceTimersByTimeAsync(1_000)
    await value.coordinator.whenIdle()
    expect(aborted).toBe(true)
    expect(value.store.listRuns({ automationId: 'auto-timeout', limit: 10 })[0]).toMatchObject({ status: 'timed_out' })
    expect(value.store.listIncidents({ automationId: 'auto-timeout', limit: 10 }))
      .toEqual([expect.objectContaining({
        state: 'open', failureClass: 'timeout', failureCode: 'execution-timeout',
        notificationRouteId: 'binding-timeout-owner',
      })])
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

  test('fences Host materialization on an exact registry proof and durably routes a content-free incident', async () => {
    const registry = new HostAutomationExecutorRegistry()
    const run = vi.fn(async () => ({
      outcome: 'succeeded' as const,
      output: 'host complete', usage: {}, diagnostic: {
        schemaVersion: 1 as const, failureClass: 'none' as const, failurePhase: 'none' as const,
        failureCode: 'none', promptSubmissionState: 'not-applicable' as const,
        sideEffectState: 'none' as const, retryability: 'safe' as const,
        budgetSettlementState: 'not-required' as const,
      },
    }))
    const value = await fixture({ run }, {}, registry)
    const route = vi.fn((_input: unknown) => ({ id: 'incident-outbox-1', status: 'pending' }))
    const publish = vi.fn((_input: DeliveryPresentationUpdate) => ({ status: 'pending' }))
    value.coordinator.setDeliveryDispatcher({
      enqueueBackground: vi.fn(), enqueueBackgroundRoute: route,
      publishDeliveryPresentation: publish,
    })
    value.store.reconcileSystemOwned({
      owner: 'assistant-recovery', automationId: 'growth-host', idempotencyKey: 'growth-host:v1',
      definition: hostDefinition(),
    })

    await value.coordinator.tick()
    await value.coordinator.whenIdle()
    expect(run).not.toHaveBeenCalled()
    expect(value.store.listTasks({ automationId: 'growth-host', limit: 10 })).toEqual([])
    expect(value.store.listIncidents({ automationId: 'growth-host', limit: 10 })).toEqual([
      expect.objectContaining({
        stage: 'materialize', state: 'open', failureCode: 'host-executor-unavailable',
        lifecycleGeneration: 1, presentationRevision: 1,
        alertStatus: 'enqueued', alertRef: 'incident-outbox-1',
      }),
    ])
    expect(route).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'assistant-automations-incidents', authorityId: 'lark/main/tenant/owner',
      text: expect.stringMatching(/^Automation incident incident-/u), format: 'plain',
    }))
    expect(route.mock.calls[0]![0]).not.toHaveProperty('workspace')
    expect(route.mock.calls[0]![0]).not.toHaveProperty('prompt')

    const dispose = registry.register({
      descriptor: { executorId: 'assistant-recovery', contractVersion: 2, catalogDigest: 'a'.repeat(64) },
      accepts: spec => spec.runbookId === 'supervised-growth/v2',
      async execute() {
        return { outcome: 'succeeded', failureClass: 'none', failurePhase: 'none', failureCode: 'none',
          sideEffectState: 'none', retryability: 'safe' }
      },
    })
    await value.coordinator.tick()
    await value.coordinator.whenIdle()
    await value.coordinator.tick()
    expect(run).toHaveBeenCalledOnce()
    expect(value.store.listRuns({ automationId: 'growth-host', limit: 10 }))
      .toEqual([expect.objectContaining({ status: 'succeeded', executionMode: 'production' })])
    expect(value.store.listPendingEvaluations(10)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({
        objectiveStatus: 'achieved',
        evaluator: { id: 'assistant-automations', version: 'host-runbook-v1' },
      }) }),
    ])
    expect(value.store.listIncidents({ automationId: 'growth-host', limit: 10 }))
      .toEqual([expect.objectContaining({
        stage: 'materialize', state: 'resolved', lifecycleGeneration: 1,
        presentationRevision: 2, alertStatus: 'enqueued', alertRef: 'incident-outbox-1',
      })])
    expect(route).toHaveBeenCalledOnce()
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish.mock.calls.map(call => call[0])).toEqual([
      expect.objectContaining({ revision: 1, presentation: expect.objectContaining({ state: 'open' }) }),
      expect.objectContaining({ revision: 2, presentation: expect.objectContaining({ state: 'resolved' }) }),
    ])
    expect(publish.mock.calls[0]![0]).toMatchObject({
      presentationKey: publish.mock.calls[1]![0].presentationKey,
      originalOutboxIdempotencyKey: publish.mock.calls[1]![0].originalOutboxIdempotencyKey,
    })
    dispose()
    await value.coordinator.stop()
    value.store.close()
  })

  test('keeps an incident pending when emergency-stop Delivery refuses the alert', async () => {
    const value = await fixture({ run: vi.fn() }, {}, new HostAutomationExecutorRegistry())
    value.coordinator.setDeliveryDispatcher({
      enqueueBackground: vi.fn(),
      enqueueBackgroundRoute: vi.fn(() => { throw Object.assign(new Error('emergency stop'), { code: 'policy-denied' }) }),
      publishDeliveryPresentation: vi.fn(),
    })
    value.store.reconcileSystemOwned({
      owner: 'assistant-recovery', automationId: 'growth-emergency', idempotencyKey: 'growth-emergency:v1',
      definition: hostDefinition(),
    })
    await value.coordinator.tick()
    expect(value.store.listIncidents({ automationId: 'growth-emergency', limit: 10 }))
      .toEqual([expect.objectContaining({ state: 'open', alertStatus: 'pending' })])
    expect(value.store.health()).toMatchObject({ openIncidents: 1, pendingIncidentAlerts: 1 })
    await value.coordinator.stop()
    value.store.close()
  })

  test('keeps an approval-routed analyst incident durable across restart and resolves its recovery', async () => {
    let execution = 0
    let finishRecovery: ((value: Awaited<ReturnType<AutomationRunner['run']>>) => void) | undefined
    const runner: AutomationRunner = {
      async run() {
        execution += 1
        if (execution === 1) {
          return {
            outcome: 'failed', output: 'private provider failure output', usage: {}, diagnostic: {
              schemaVersion: 1, failureClass: 'provider', failurePhase: 'model-execution',
              failureCode: 'provider-unavailable', promptSubmissionState: 'submitted',
              sideEffectState: 'possible', retryability: 'unsafe', budgetSettlementState: 'not-required',
            },
          }
        }
        return await new Promise(resolve => { finishRecovery = resolve })
      },
    }
    const value = await fixture(runner)
    const enqueue = vi.fn((input: { idempotencyKey: string }) => ({
      id: `outbox:${input.idempotencyKey}`, status: 'pending',
    }))
    const route = vi.fn((_input: unknown) => ({ id: 'must-not-use-owner-route', status: 'pending' }))
    const publish = vi.fn((_input: DeliveryPresentationUpdate) => ({ status: 'pending' }))
    const delivery: AutomationDeliveryDispatcher = {
      enqueueBackground: enqueue,
      enqueueBackgroundRoute: route,
      publishDeliveryPresentation: publish,
    }
    value.coordinator.setDeliveryDispatcher(delivery)
    value.store.reconcileSystemOwned({
      owner: 'assistant-heartbeat', automationId: 'heartbeat:supervised-growth-analyst',
      idempotencyKey: 'analyst:v1', definition: definition({
        name: 'Supervised growth analyst',
        schedule: { kind: 'at', at: '2027-08-21T10:01:00.000Z' },
        approvalBindingId: 'binding-approval-owner',
        // A legacy result binding must never override the narrower approval route.
        deliveryBindingId: 'binding-legacy-result',
        deliverySuppressExact: ['ordinary successful analyst output'],
      }),
    })
    value.store.createManual({
      automationId: 'heartbeat:supervised-growth-analyst', requestId: 'incident-open', dryRun: false,
    })

    await value.coordinator.tick()
    await value.coordinator.whenIdle()
    await value.coordinator.tick()
    const definitionHash = value.store.getDefinitionHash('heartbeat:supervised-growth-analyst')!
    expect(value.store.getCurrentIncident('heartbeat:supervised-growth-analyst', definitionHash)).toMatchObject({
      stage: 'terminal', state: 'open', failureClass: 'provider', failureCode: 'provider-unavailable',
      notificationRouteId: 'binding-approval-owner', lifecycleGeneration: 1,
      presentationRevision: 1, alertStatus: 'enqueued',
    })
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'assistant-automations-incidents', workspace: '/work/alpha',
      bindingId: 'binding-approval-owner',
      idempotencyKey: expect.stringMatching(/:g1:r1$/u),
    }))
    expect(JSON.stringify(enqueue.mock.calls)).not.toContain('private provider failure output')
    expect(route).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    await value.coordinator.stop()

    const restarted = new AutomationCoordinator({
      store: value.store, artifacts: value.artifacts, runner, ownerId: 'coordinator-restarted-analyst',
      now: () => Date.parse('2026-08-21T10:01:00.000Z'), dutyLeaseMs: 10_000,
      taskLeaseMs: 5_000, misfireGraceMs: minute, maxCatchUp: 10, maxConcurrency: 2,
    })
    restarted.setDeliveryDispatcher(delivery)
    await restarted.tick()
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(execution).toBe(1)

    value.store.createManual({
      automationId: 'heartbeat:supervised-growth-analyst', requestId: 'incident-recovery', dryRun: false,
    })
    await restarted.tick()
    expect(value.store.getCurrentIncident('heartbeat:supervised-growth-analyst', definitionHash)).toMatchObject({
      state: 'recovering', lifecycleGeneration: 1, presentationRevision: 2, alertStatus: 'enqueued',
    })
    expect(enqueue.mock.calls.map(call => call[0].idempotencyKey)).toEqual([
      expect.stringMatching(/:g1:r1$/u), expect.stringMatching(/:g1:r2$/u),
    ])
    finishRecovery?.({
      outcome: 'succeeded', output: 'ordinary successful analyst output', usage: {}, diagnostic: {
        schemaVersion: 1, failureClass: 'none', failurePhase: 'none', failureCode: 'none',
        promptSubmissionState: 'submitted', sideEffectState: 'possible', retryability: 'unsafe',
        budgetSettlementState: 'not-required',
      },
    })
    await restarted.whenIdle()
    await restarted.tick()
    expect(value.store.listIncidents({ automationId: 'heartbeat:supervised-growth-analyst', limit: 10 }))
      .toEqual([expect.objectContaining({
        state: 'resolved', lifecycleGeneration: 1, presentationRevision: 3,
        alertStatus: 'enqueued', resolvedAt: expect.any(Number),
      })])
    expect(enqueue.mock.calls.map(call => call[0].idempotencyKey)).toEqual([
      expect.stringMatching(/:g1:r1$/u), expect.stringMatching(/:g1:r2$/u),
      expect.stringMatching(/:g1:r3$/u),
    ])
    expect(value.store.listRuns({ automationId: 'heartbeat:supervised-growth-analyst', limit: 10 }))
      .toHaveLength(2)
    await restarted.stop()
    value.store.close()
  })

  test('does not invent an Agent incident for an ordinary successful output', async () => {
    const value = await fixture({
      async run() {
        return { outcome: 'succeeded', output: 'daily review complete', usage: {}, diagnostic: {
          schemaVersion: 1, failureClass: 'none', failurePhase: 'none', failureCode: 'none',
          promptSubmissionState: 'submitted', sideEffectState: 'possible', retryability: 'unsafe',
          budgetSettlementState: 'not-required',
        } }
      },
    })
    value.store.createApproved({
      automationId: 'agent-success-only', idempotencyKey: 'agent-success-only:v1',
      definition: definition({ approvalBindingId: 'binding-owner' }),
    })
    await value.coordinator.tick()
    await value.coordinator.whenIdle()

    expect(value.store.listRuns({ automationId: 'agent-success-only', limit: 10 }))
      .toEqual([expect.objectContaining({ status: 'succeeded', outputPreview: 'daily review complete' })])
    expect(value.store.listIncidents({ automationId: 'agent-success-only', limit: 10 })).toEqual([])
    await value.coordinator.stop()
    value.store.close()
  })

  test('commits a Host terminal incident and its exact-definition circuit with the terminal run', async () => {
    const registry = new HostAutomationExecutorRegistry()
    registry.register({
      descriptor: { executorId: 'assistant-recovery', contractVersion: 2, catalogDigest: 'a'.repeat(64) },
      accepts: () => true,
      async execute() {
        return { outcome: 'succeeded', failureClass: 'none', failurePhase: 'none', failureCode: 'none',
          sideEffectState: 'none', retryability: 'safe' }
      },
    })
    const value = await fixture({
      async run() {
        return { outcome: 'failed', output: 'not exposed to incident', usage: {}, diagnostic: {
          schemaVersion: 1, failureClass: 'configuration', failurePhase: 'host-execution',
          failureCode: 'catalog-mismatch', promptSubmissionState: 'not-applicable',
          sideEffectState: 'none', retryability: 'after-intervention', budgetSettlementState: 'not-required',
        } }
      },
    }, {}, registry)
    value.store.reconcileSystemOwned({
      owner: 'assistant-recovery', automationId: 'growth-terminal', idempotencyKey: 'growth-terminal:v1',
      definition: hostDefinition(),
    })
    await value.coordinator.tick()
    await value.coordinator.whenIdle()
    const terminal = value.store.listRuns({ automationId: 'growth-terminal', limit: 10 })[0]!
    const definitionHash = value.store.getDefinitionHash('growth-terminal')!
    expect(terminal).toMatchObject({ status: 'failed', diagnostic: { failureCode: 'catalog-mismatch' } })
    expect(value.store.listPendingEvaluations(10)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({
        objectiveStatus: 'not-achieved',
        evaluator: { id: 'assistant-automations', version: 'host-runbook-v1' },
      }) }),
    ])
    expect(value.store.getCircuit('growth-terminal', definitionHash))
      .toMatchObject({ state: 'open', failureClass: 'configuration', failureCode: 'catalog-mismatch' })
    expect(value.store.listIncidents({ automationId: 'growth-terminal', limit: 10 }))
      .toEqual([expect.objectContaining({
        stage: 'terminal', state: 'open', runId: terminal.id,
        notificationRouteId: 'lark/main/tenant/owner', failureCode: 'catalog-mismatch', alertStatus: 'pending',
      })])
    await value.coordinator.stop()
    value.store.close()
  })

  test('versions detail, recovering, resolved, and reopened incident generations onto exact messages', async () => {
    const registry = new HostAutomationExecutorRegistry()
    registry.register({
      descriptor: { executorId: 'assistant-recovery', contractVersion: 2, catalogDigest: 'a'.repeat(64) },
      accepts: () => true,
      async execute() {
        return { outcome: 'succeeded', failureClass: 'none', failurePhase: 'none', failureCode: 'none',
          sideEffectState: 'none', retryability: 'safe' }
      },
    })
    const outcomes = [
      { outcome: 'failed' as const, failureCode: 'catalog-mismatch' },
      { outcome: 'failed' as const, failureCode: 'attestation-mismatch' },
      { outcome: 'succeeded' as const, failureCode: 'none' },
      { outcome: 'failed' as const, failureCode: 'route-drift' },
    ]
    const value = await fixture({
      async run() {
        const next = outcomes.shift()!
        return next.outcome === 'succeeded'
          ? { outcome: 'succeeded', output: 'recovered', usage: {}, diagnostic: {
              schemaVersion: 1, failureClass: 'none', failurePhase: 'none', failureCode: 'none',
              promptSubmissionState: 'not-applicable', sideEffectState: 'none', retryability: 'safe',
              budgetSettlementState: 'not-required',
            } }
          : { outcome: 'failed', output: 'bounded failure', usage: {}, diagnostic: {
              schemaVersion: 1, failureClass: 'configuration', failurePhase: 'host-execution',
              failureCode: next.failureCode, promptSubmissionState: 'not-applicable',
              sideEffectState: 'none', retryability: 'after-intervention', budgetSettlementState: 'not-required',
            } }
      },
    }, {}, registry)
    const route = vi.fn((input: { idempotencyKey: string }) => ({
      id: `outbox:${input.idempotencyKey}`, status: 'pending',
    }))
    const publish = vi.fn((_input: DeliveryPresentationUpdate) => ({ status: 'pending' }))
    value.coordinator.setDeliveryDispatcher({ enqueueBackground: vi.fn(), enqueueBackgroundRoute: route,
      publishDeliveryPresentation: publish })
    value.store.reconcileSystemOwned({
      owner: 'assistant-recovery', automationId: 'growth-lifecycle', idempotencyKey: 'growth-lifecycle:v1',
      definition: hostDefinition({ schedule: { kind: 'at', at: '2027-08-21T10:01:00.000Z' } }),
    })

    value.store.createManual({ automationId: 'growth-lifecycle', requestId: 'open-g1', dryRun: false })
    await value.coordinator.tick()
    await value.coordinator.whenIdle()
    await value.coordinator.tick()
    const definitionHash = value.store.getDefinitionHash('growth-lifecycle')!
    expect(value.store.getCurrentIncident('growth-lifecycle', definitionHash)).toMatchObject({
      state: 'open', failureCode: 'catalog-mismatch', lifecycleGeneration: 1,
      presentationRevision: 1, alertStatus: 'enqueued',
    })

    value.advance(100)
    let circuit = value.store.getCircuit('growth-lifecycle', definitionHash)!
    value.store.probeCircuitAndScheduleCanary({
      owner: 'assistant-recovery', operationId: 'probe:g1:first', automationId: 'growth-lifecycle',
      definitionHash, expectedVersion: circuit.version,
      now: Date.parse('2026-08-21T10:01:00.000Z') + 100, leaseMs: 5_000,
    })
    expect(value.store.getCurrentIncident('growth-lifecycle', definitionHash)).toMatchObject({
      state: 'recovering', lifecycleGeneration: 1, presentationRevision: 2, alertStatus: 'pending',
    })
    await value.coordinator.tick()
    await value.coordinator.whenIdle()
    await value.coordinator.tick()
    expect(value.store.getCurrentIncident('growth-lifecycle', definitionHash)).toMatchObject({
      state: 'open', failureCode: 'attestation-mismatch', lifecycleGeneration: 1,
      presentationRevision: 3, alertStatus: 'enqueued',
    })

    value.advance(100)
    circuit = value.store.getCircuit('growth-lifecycle', definitionHash)!
    value.store.probeCircuitAndScheduleCanary({
      owner: 'assistant-recovery', operationId: 'probe:g1:second', automationId: 'growth-lifecycle',
      definitionHash, expectedVersion: circuit.version,
      now: Date.parse('2026-08-21T10:01:00.000Z') + 200, leaseMs: 5_000,
    })
    await value.coordinator.tick()
    await value.coordinator.whenIdle()
    await value.coordinator.tick()
    expect(value.store.listIncidents({ automationId: 'growth-lifecycle', limit: 10 }))
      .toEqual([expect.objectContaining({
        state: 'resolved', lifecycleGeneration: 1, presentationRevision: 5,
        alertStatus: 'enqueued', resolvedAt: expect.any(Number),
      })])

    value.advance(100)
    value.store.createManual({ automationId: 'growth-lifecycle', requestId: 'reopen-g2', dryRun: false })
    await value.coordinator.tick()
    await value.coordinator.whenIdle()
    await value.coordinator.tick()
    expect(value.store.getCurrentIncident('growth-lifecycle', definitionHash)).toMatchObject({
      state: 'open', failureCode: 'route-drift', lifecycleGeneration: 2,
      presentationRevision: 6, alertStatus: 'enqueued',
    })
    expect(route).toHaveBeenCalledTimes(2)
    expect(route.mock.calls.map(call => call[0].idempotencyKey)).toEqual([
      expect.stringMatching(/:g1$/u), expect.stringMatching(/:g2$/u),
    ])
    expect(publish.mock.calls.map(call => call[0].presentation.kind === 'automation-incident'
      ? call[0].presentation.state : 'unexpected'))
      .toEqual(['open', 'recovering', 'open', 'recovering', 'resolved', 'open'])
    expect(new Set(publish.mock.calls.slice(0, 5).map(call => call[0].presentationKey)).size).toBe(1)
    expect(publish.mock.calls[5]![0].presentationKey).not.toBe(publish.mock.calls[0]![0].presentationKey)
    await value.coordinator.stop()
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
