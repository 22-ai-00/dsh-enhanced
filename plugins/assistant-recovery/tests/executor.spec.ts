import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RECOVERY_CATALOG, RECOVERY_CATALOG_DIGEST } from '../src/catalog.ts'
import {
  RecoveryExecutor,
  RecoveryPortError,
  type RecoveryExecutionContext,
  type RecoveryExecutorInput,
  type RecoveryRunbookPort,
} from '../src/executor.ts'
import { RecoveryStore } from '../src/store.ts'
import type { RecoveryStepAction, RecoveryStepId } from '../src/types.ts'

const roots: string[] = []
const hash = (digit: string) => digit.repeat(64)
const preferenceLineage = Object.freeze({
  principalRecordId: 'principal-row-1',
  principalVersion: 1,
})

function preferenceActivationAction(hypothesisId = 'pref-1', expectedVersion = 3) {
  return Object.freeze({
    kind: 'activate-preference' as const,
    hypothesisId,
    expectedVersion,
    ownerGeneration: 1,
    principalLineage: preferenceLineage,
  })
}

function preferenceMaintenanceAction() {
  return Object.freeze({
    kind: 'maintain-preferences' as const,
    limit: 1 as const,
    ownerGeneration: 1,
    principalLineage: preferenceLineage,
  })
}

function fixture(): { store: RecoveryStore; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-executor-'))
  roots.push(root)
  const path = join(root, 'recovery.sqlite')
  return { store: new RecoveryStore({ path, now: () => 5_000 }), path }
}

function input(overrides: Partial<RecoveryExecutorInput> = {}): RecoveryExecutorInput {
  return {
    occurrenceId: 'occurrence-1',
    automationId: 'recovery:supervised-growth',
    definitionHash: hash('a'),
    executionMode: 'production',
    targetScope: { workspace: '/workspace', preset: 'owner' },
    principal: 'lark/account/tenant/user',
    ownerRouteId: 'owner-route',
    activationNonce: 'activation-1',
    activationPlanDigest: hash('e'),
    catalogDigest: RECOVERY_CATALOG_DIGEST,
    signal: new AbortController().signal,
    ...overrides,
  }
}

function actionFor(stepId: RecoveryStepId): RecoveryStepAction {
  switch (stepId) {
    case 'authority-admission': return { kind: 'verify-authority' }
    case 'ledger-reconcile': return { kind: 'project-evaluation', evaluationId: 'evaluation-1' }
    case 'retention-maintenance': return preferenceMaintenanceAction()
    case 't1-effects': return preferenceActivationAction()
    case 'regression-rollback': return { kind: 'rollback-evolution', ruleId: 'rule-1', expectedVersion: 4 }
    case 'incident-review': return {
      kind: 'probe-automation-circuit',
      automationId: 'heartbeat:supervised-growth',
      definitionHash: hash('c'),
      expectedVersion: 2,
    }
    case 'verification': return { kind: 'verify-health' }
  }
}

class Port implements RecoveryRunbookPort {
  readonly planned: RecoveryStepId[] = []
  readonly executed: Array<{ stepId: RecoveryStepId; action: RecoveryStepAction; idempotencyKey: string }> = []
  planOverride?: (context: RecoveryExecutionContext, stepId: RecoveryStepId) => ReturnType<RecoveryRunbookPort['plan']>
  executeOverride?: (
    context: RecoveryExecutionContext,
    stepId: RecoveryStepId,
    action: RecoveryStepAction,
    idempotencyKey: string,
  ) => ReturnType<RecoveryRunbookPort['execute']>

  async plan(context: RecoveryExecutionContext, stepId: RecoveryStepId): ReturnType<RecoveryRunbookPort['plan']> {
    this.planned.push(stepId)
    if (this.planOverride !== undefined) return this.planOverride(context, stepId)
    return { action: actionFor(stepId), beforeDigest: hash('b') }
  }

  async execute(
    context: RecoveryExecutionContext,
    stepId: RecoveryStepId,
    action: RecoveryStepAction,
    idempotencyKey: string,
  ): ReturnType<RecoveryRunbookPort['execute']> {
    this.executed.push({ stepId, action, idempotencyKey })
    if (this.executeOverride !== undefined) return this.executeOverride(context, stepId, action, idempotencyKey)
    return { status: 'succeeded', resultCode: `${stepId}.complete`, afterDigest: hash('d') }
  }
}

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RecoveryExecutor', () => {
  it('executes the fixed catalog once in order and passes durable operation ids', async () => {
    const { store } = fixture()
    const port = new Port()
    const result = await new RecoveryExecutor(store, port, 1_000).execute(input())

    expect(result).toMatchObject({ status: 'succeeded', resultCode: 'runbook-complete' })
    expect(port.planned).toEqual(RECOVERY_CATALOG.map(step => step.id))
    expect(port.executed.map(call => call.stepId)).toEqual(port.planned)
    expect(port.executed.map(call => call.idempotencyKey)).toEqual(
      RECOVERY_CATALOG.map(step => `recovery:3:occurrence-1:${step.id}`),
    )
    expect(result.steps).toHaveLength(7)
    store.close()
  })

  it('plans a preview but never calls a mutating port action', async () => {
    const { store } = fixture()
    const port = new Port()
    const result = await new RecoveryExecutor(store, port, 1_000).execute(input({ executionMode: 'preview' }))

    expect(result).toMatchObject({ status: 'succeeded', resultCode: 'preview-verified' })
    expect(port.executed.map(call => call.stepId)).toEqual(['authority-admission', 'verification'])
    expect(result.steps.filter(step => step.resultCode === 'preview-suppressed')).toHaveLength(5)
    store.close()
  })

  it('resumes a durable started action without planning a different target', async () => {
    const { store } = fixture()
    const executionInput = input()
    const started = store.beginRun({
      ...executionInput,
      catalogDigest: executionInput.catalogDigest!,
    }).run
    const intent = store.beginStep({
      runId: started.id,
      stepId: 'authority-admission',
      action: { kind: 'verify-authority' },
      beforeDigest: hash('b'),
    }).step
    const port = new Port()

    const result = await new RecoveryExecutor(store, port, 1_000).execute(executionInput)
    expect(result.status).toBe('succeeded')
    expect(port.planned).not.toContain('authority-admission')
    expect(port.executed[0]).toMatchObject({
      stepId: 'authority-admission',
      idempotencyKey: intent.idempotencyKey,
      action: intent.action,
    })
    store.close()
  })

  it('settles an expired resumed mutation as unknown without touching the downstream port', async () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-expired-mutation-'))
    roots.push(root)
    const path = join(root, 'recovery.sqlite')
    let now = 1_000
    const created = new RecoveryStore({ path, now: () => now, maxStepDurationMs: 100, deadlineGraceMs: 0 })
    const executionInput = input()
    const run = created.beginRun({ ...executionInput, catalogDigest: executionInput.catalogDigest! }).run
    const admission = created.beginStep({
      runId: run.id,
      stepId: 'authority-admission',
      action: { kind: 'verify-authority' },
      beforeDigest: hash('b'),
    }).step
    created.completeStep({
      runId: run.id,
      stepId: admission.stepId,
      expectedVersion: admission.version,
      status: 'succeeded',
      beforeDigest: admission.beforeDigest,
      afterDigest: hash('d'),
      resultCode: 'authority-admission.complete',
    })
    const intent = created.beginStep({
      runId: run.id,
      stepId: 'ledger-reconcile',
      action: { kind: 'project-evaluation', evaluationId: 'evaluation-1' },
      beforeDigest: hash('b'),
    }).step
    created.close()

    now = intent.deadlineAt
    const restarted = new RecoveryStore({ path, now: () => now, maxStepDurationMs: 100, deadlineGraceMs: 0 })
    const port = new Port()
    const result = await new RecoveryExecutor(restarted, port, 1_000).execute(executionInput)
    expect(result).toMatchObject({
      status: 'unknown', resultCode: 'action-deadline-expired-ambiguous',
    })
    expect(result.steps.at(-1)).toMatchObject({
      stepId: 'ledger-reconcile', status: 'unknown',
      resultCode: 'action-deadline-expired-ambiguous',
    })
    expect(port.planned).toEqual([])
    expect(port.executed).toEqual([])
    restarted.close()
  })

  it('settles an expired resumed read-only intent as failed without calling the port', async () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-expired-read-'))
    roots.push(root)
    const path = join(root, 'recovery.sqlite')
    let now = 1_000
    const created = new RecoveryStore({ path, now: () => now, maxStepDurationMs: 100, deadlineGraceMs: 0 })
    const executionInput = input()
    const run = created.beginRun({ ...executionInput, catalogDigest: executionInput.catalogDigest! }).run
    const intent = created.beginStep({
      runId: run.id,
      stepId: 'authority-admission',
      action: { kind: 'verify-authority' },
      beforeDigest: hash('b'),
    }).step
    created.close()

    now = intent.deadlineAt
    const restarted = new RecoveryStore({ path, now: () => now, maxStepDurationMs: 100, deadlineGraceMs: 0 })
    const port = new Port()
    const result = await new RecoveryExecutor(restarted, port, 1_000).execute(executionInput)
    expect(result).toMatchObject({ status: 'failed', resultCode: 'action-deadline-expired' })
    expect(port.planned).toEqual([])
    expect(port.executed).toEqual([])
    restarted.close()
  })

  it('does not start planning when a recovered run is at its persisted deadline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-expired-run-'))
    roots.push(root)
    const path = join(root, 'recovery.sqlite')
    let now = 1_000
    const created = new RecoveryStore({ path, now: () => now, maxStepDurationMs: 100, deadlineGraceMs: 0 })
    const executionInput = input()
    const run = created.beginRun({ ...executionInput, catalogDigest: executionInput.catalogDigest! }).run
    created.close()

    now = run.deadlineAt
    const restarted = new RecoveryStore({ path, now: () => now, maxStepDurationMs: 100, deadlineGraceMs: 0 })
    const port = new Port()
    const result = await new RecoveryExecutor(restarted, port, 1_000).execute(executionInput)
    expect(result).toMatchObject({ status: 'failed', resultCode: 'run-deadline-expired' })
    expect(result.steps).toEqual([])
    expect(port.planned).toEqual([])
    expect(port.executed).toEqual([])
    restarted.close()
  })

  it('caps planning by the recovered run deadline instead of resetting to config timeout', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-plan-budget-'))
    roots.push(root)
    const path = join(root, 'recovery.sqlite')
    const store = new RecoveryStore({ path, now: Date.now, maxStepDurationMs: 100, deadlineGraceMs: 0 })
    const executionInput = input()
    store.beginRun({ ...executionInput, catalogDigest: executionInput.catalogDigest! })
    vi.setSystemTime(2_350)
    const port = new Port()
    port.planOverride = async () => new Promise(() => {})

    const operation = new RecoveryExecutor(store, port, 1_000).execute(executionInput)
    await vi.advanceTimersByTimeAsync(49)
    let settled = false
    void operation.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(operation).resolves.toMatchObject({
      status: 'failed', resultCode: 'run-deadline-expired',
    })
    expect(store.listSteps(store.getRunByOccurrence('occurrence-1')!.id)).toEqual([])
    store.close()
  })

  it('caps execution by the persisted step deadline instead of resetting to config timeout', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-action-budget-'))
    roots.push(root)
    const store = new RecoveryStore({
      path: join(root, 'recovery.sqlite'), now: Date.now, maxStepDurationMs: 100, deadlineGraceMs: 0,
    })
    const port = new Port()
    port.executeOverride = async (_context, stepId) => stepId === 'authority-admission'
      ? new Promise(() => {})
      : { status: 'succeeded', resultCode: `${stepId}.complete`, afterDigest: hash('d') }

    const operation = new RecoveryExecutor(store, port, 1_000).execute(input())
    await vi.advanceTimersByTimeAsync(99)
    let settled = false
    void operation.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(operation).resolves.toMatchObject({
      status: 'failed', resultCode: 'action-deadline-expired',
    })
    expect(port.executed.map(value => value.stepId)).toEqual(['authority-admission'])
    store.close()
  })

  it('is bounded when a mutating port ignores abort and records ambiguity without later actions', async () => {
    vi.useFakeTimers()
    const { store } = fixture()
    const port = new Port()
    port.executeOverride = async (_context, stepId) => {
      if (stepId === 't1-effects') return new Promise(() => {})
      return { status: 'succeeded', resultCode: `${stepId}.complete`, afterDigest: hash('d') }
    }
    const operation = new RecoveryExecutor(store, port, 100).execute(input())
    await vi.advanceTimersByTimeAsync(99)
    let settled = false
    void operation.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    const result = await operation

    expect(result).toMatchObject({ status: 'unknown', resultCode: 'action-timeout-ambiguous' })
    expect(result.steps.at(-1)).toMatchObject({
      stepId: 't1-effects', status: 'unknown', resultCode: 'action-timeout-ambiguous',
    })
    expect(port.executed.map(call => call.stepId)).not.toContain('regression-rollback')
    store.close()
  })

  it('marks a proven pre-effect mutation failure as failed instead of ambiguous', async () => {
    const { store } = fixture()
    const port = new Port()
    port.executeOverride = async (_context, stepId) => {
      if (stepId === 'ledger-reconcile') throw new RecoveryPortError('policy-denied', 'none')
      return { status: 'succeeded', resultCode: `${stepId}.complete`, afterDigest: hash('d') }
    }
    const result = await new RecoveryExecutor(store, port, 1_000).execute(input())

    expect(result).toMatchObject({ status: 'failed', resultCode: 'policy-denied' })
    expect(result.steps.at(-1)).toMatchObject({ status: 'failed', resultCode: 'policy-denied' })
    store.close()
  })

  it('settles a valid mutation receipt before honoring cancellation that races after sink commit', async () => {
    const { store } = fixture()
    const controller = new AbortController()
    const port = new Port()
    port.executeOverride = async (_context, stepId) => {
      if (stepId === 't1-effects') controller.abort(new Error('cancelled after commit'))
      return { status: 'succeeded', resultCode: `${stepId}.complete`, afterDigest: hash('d') }
    }

    const result = await new RecoveryExecutor(store, port, 1_000).execute(input({
      signal: controller.signal,
    }))
    expect(result).toMatchObject({ status: 'failed', resultCode: 'execution-cancelled' })
    expect(result.steps.find(step => step.stepId === 't1-effects')).toMatchObject({
      status: 'succeeded', resultCode: 't1-effects.complete',
    })
    expect(result.steps.find(step => step.stepId === 't1-effects')).not.toMatchObject({ status: 'unknown' })
    store.close()
  })

  it('keeps a durable mutation receipt when the Store clock reaches the deadline before settlement', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-receipt-boundary-'))
    roots.push(root)
    const store = new RecoveryStore({
      path: join(root, 'recovery.sqlite'), now: Date.now, maxStepDurationMs: 100, deadlineGraceMs: 0,
    })
    const port = new Port()
    port.executeOverride = async (_context, stepId) => {
      if (stepId === 't1-effects') vi.setSystemTime(1_100)
      return { status: 'succeeded', resultCode: `${stepId}.complete`, afterDigest: hash('d') }
    }

    const result = await new RecoveryExecutor(store, port, 1_000).execute(input())
    expect(result.status).toBe('succeeded')
    expect(result.steps.find(step => step.stepId === 't1-effects')).toMatchObject({
      status: 'succeeded', resultCode: 't1-effects.complete',
    })
    store.close()
  })

  it('settles unknown when the persisted deadline wins before a mutation may commit', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-deadline-race-'))
    roots.push(root)
    const store = new RecoveryStore({
      path: join(root, 'recovery.sqlite'), now: Date.now, maxStepDurationMs: 100, deadlineGraceMs: 0,
    })
    const port = new Port()
    let lateSinkCommit = false
    port.executeOverride = async (_context, stepId) => {
      if (stepId !== 't1-effects') {
        return { status: 'succeeded', resultCode: `${stepId}.complete`, afterDigest: hash('d') }
      }
      return new Promise(resolve => {
        setTimeout(() => {
          lateSinkCommit = true
          resolve({ status: 'succeeded', resultCode: 't1-effects.complete', afterDigest: hash('d') })
        }, 101)
      })
    }

    const operation = new RecoveryExecutor(store, port, 1_000).execute(input())
    await vi.advanceTimersByTimeAsync(100)
    await expect(operation).resolves.toMatchObject({
      status: 'unknown', resultCode: 'action-deadline-expired-ambiguous',
    })
    expect(lateSinkCommit).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(lateSinkCommit).toBe(true)
    expect(store.getRunByOccurrence('occurrence-1')).toMatchObject({
      status: 'unknown', resultCode: 'action-deadline-expired-ambiguous',
    })
    store.close()
  })

  it('keeps a resumed mutation unknown when the replay is refused before a new effect', async () => {
    const { store } = fixture()
    const executionInput = input()
    const run = store.beginRun({ ...executionInput, catalogDigest: executionInput.catalogDigest! }).run
    const completed = store.beginStep({
      runId: run.id,
      stepId: 'authority-admission',
      action: { kind: 'verify-authority' },
      beforeDigest: hash('b'),
    }).step
    store.completeStep({
      runId: run.id,
      stepId: 'authority-admission',
      expectedVersion: completed.version,
      status: 'succeeded',
      beforeDigest: hash('b'),
      afterDigest: hash('d'),
      resultCode: 'authority-admission.complete',
    })
    store.beginStep({
      runId: run.id,
      stepId: 'ledger-reconcile',
      action: { kind: 'project-evaluation', evaluationId: 'evaluation-1' },
      beforeDigest: hash('b'),
    })
    const port = new Port()
    port.executeOverride = async (_context, stepId) => {
      if (stepId === 'ledger-reconcile') throw new RecoveryPortError('policy-denied', 'none')
      return { status: 'succeeded', resultCode: `${stepId}.complete`, afterDigest: hash('d') }
    }

    const result = await new RecoveryExecutor(store, port, 1_000).execute(executionInput)
    expect(result).toMatchObject({ status: 'unknown', resultCode: 'policy-denied' })
    expect(result.steps.at(-1)).toMatchObject({
      stepId: 'ledger-reconcile', status: 'unknown', resultCode: 'policy-denied',
    })
    store.close()
  })

  it('fails closed when planning cannot prove an exact action', async () => {
    const { store } = fixture()
    const port = new Port()
    port.planOverride = async (_context, stepId) => {
      if (stepId === 'retention-maintenance') throw new RecoveryPortError('provider-unavailable', 'none')
      return { action: actionFor(stepId), beforeDigest: hash('b') }
    }
    const result = await new RecoveryExecutor(store, port, 1_000).execute(input())

    expect(result).toMatchObject({ status: 'failed', resultCode: 'provider-unavailable' })
    expect(result.steps.at(-1)).toMatchObject({
      stepId: 'retention-maintenance', action: { kind: 'noop' }, status: 'failed',
    })
    expect(port.executed.map(call => call.stepId)).not.toContain('retention-maintenance')
    store.close()
  })

  it('treats a malformed post-mutation receipt as ambiguous', async () => {
    const { store } = fixture()
    const port = new Port()
    port.executeOverride = async (_context, stepId) => ({
      status: 'succeeded',
      resultCode: `${stepId}.complete`,
      afterDigest: stepId === 'ledger-reconcile' ? 'not-a-digest' : hash('d'),
    })
    const result = await new RecoveryExecutor(store, port, 1_000).execute(input())

    expect(result).toMatchObject({ status: 'unknown', resultCode: 'after-digest-invalid' })
    store.close()
  })

  it('replays a terminal run without planning or executing again', async () => {
    const created = fixture()
    const firstPort = new Port()
    const first = await new RecoveryExecutor(created.store, firstPort, 1_000).execute(input())
    created.store.close()

    const restarted = new RecoveryStore({ path: created.path, now: () => 6_000 })
    const replayPort = new Port()
    const replayed = await new RecoveryExecutor(restarted, replayPort, 1_000).execute(input())
    expect(replayed).toEqual(first)
    expect(replayPort.planned).toEqual([])
    expect(replayPort.executed).toEqual([])
    restarted.close()
  })

  it.each([
    {
      label: 'preference activation',
      stepId: 't1-effects' as const,
      action: preferenceActivationAction(),
    },
    {
      label: 'Evolution rollback',
      stepId: 'regression-rollback' as const,
      action: { kind: 'rollback-evolution' as const, ruleId: 'rule-1', expectedVersion: 4 },
    },
    {
      label: 'atomic circuit canary',
      stepId: 'incident-review' as const,
      action: {
        kind: 'probe-automation-circuit' as const,
        automationId: 'recovery:sibling', definitionHash: hash('c'), expectedVersion: 2,
      },
    },
  ])('replays the exact $label sink receipt after commit-before-Recovery-receipt crash and restart', async ({
    stepId,
    action,
  }) => {
    const { store, path } = fixture()
    const sink = new Map<string, RecoveryStepAction>()
    const sinkCalls: Array<{ idempotencyKey: string; replayed: boolean }> = []
    const makePort = (): Port => {
      const port = new Port()
      port.planOverride = async (_context, currentStep) => {
        if (currentStep === 'authority-admission') {
          return { action: { kind: 'verify-authority' }, beforeDigest: hash('b') }
        }
        if (currentStep === 'verification') {
          return { action: { kind: 'verify-health' }, beforeDigest: hash('b') }
        }
        if (currentStep === stepId) return { action, beforeDigest: hash('b') }
        return { action: { kind: 'noop', reasonCode: 'no-change' }, beforeDigest: hash('b') }
      }
      port.executeOverride = async (_context, currentStep, currentAction, idempotencyKey) => {
        if (currentStep === stepId) {
          const replayed = sink.has(idempotencyKey)
          if (!replayed) sink.set(idempotencyKey, currentAction)
          sinkCalls.push({ idempotencyKey, replayed })
        }
        return { status: 'succeeded', resultCode: `${currentStep}.complete`, afterDigest: hash('d') }
      }
      return port
    }
    const original = store.completeStep.bind(store)
    let injected = false
    const settlement = vi.spyOn(store, 'completeStep').mockImplementation((request) => {
      if (!injected && request.stepId === stepId) {
        injected = true
        throw new Error('injected recovery step database fault')
      }
      return original(request)
    })
    const firstPort = makePort()
    await expect(new RecoveryExecutor(store, firstPort, 1_000).execute(input()))
      .rejects.toThrow(/database fault/u)
    const run = store.getRunByOccurrence('occurrence-1')!
    expect(store.getStep(run.id, stepId)).toMatchObject({ status: 'started', action })

    settlement.mockRestore()
    store.close()
    const restarted = new RecoveryStore({ path, now: () => 6_000 })
    const replayPort = makePort()
    const result = await new RecoveryExecutor(restarted, replayPort, 1_000).execute(input())
    expect(result.status).toBe('succeeded')
    expect(replayPort.planned).not.toContain(stepId)
    expect(replayPort.executed[0]).toMatchObject({
      stepId,
      action,
    })
    expect(sinkCalls).toEqual([
      { idempotencyKey: `recovery:3:occurrence-1:${stepId}`, replayed: false },
      { idempotencyKey: `recovery:3:occurrence-1:${stepId}`, replayed: true },
    ])
    expect(sink.get(`recovery:3:occurrence-1:${stepId}`)).toEqual(action)
    restarted.close()
  })

  it('never replays a crash-left mutation intent after its persisted deadline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-expired-crash-'))
    roots.push(root)
    const path = join(root, 'recovery.sqlite')
    let now = 1_000
    const store = new RecoveryStore({ path, now: () => now, maxStepDurationMs: 100, deadlineGraceMs: 0 })
    const sinkCalls: string[] = []
    const firstPort = new Port()
    firstPort.executeOverride = async (_context, stepId, _action, idempotencyKey) => {
      if (stepId === 't1-effects') sinkCalls.push(idempotencyKey)
      return { status: 'succeeded', resultCode: `${stepId}.complete`, afterDigest: hash('d') }
    }
    const original = store.completeStep.bind(store)
    let injected = false
    const settlement = vi.spyOn(store, 'completeStep').mockImplementation((request) => {
      if (!injected && request.stepId === 't1-effects') {
        injected = true
        throw new Error('injected receipt-store crash')
      }
      return original(request)
    })
    await expect(new RecoveryExecutor(store, firstPort, 1_000).execute(input()))
      .rejects.toThrow(/receipt-store crash/u)
    const run = store.getRunByOccurrence('occurrence-1')!
    const intent = store.getStep(run.id, 't1-effects')!
    expect(intent.status).toBe('started')
    expect(sinkCalls).toEqual(['recovery:3:occurrence-1:t1-effects'])
    settlement.mockRestore()
    store.close()

    now = intent.deadlineAt
    const restarted = new RecoveryStore({ path, now: () => now, maxStepDurationMs: 100, deadlineGraceMs: 0 })
    const replayPort = new Port()
    const terminal = vi.spyOn(restarted, 'completeRun').mockImplementationOnce(() => {
      throw new Error('injected deadline run-settlement crash')
    })
    await expect(new RecoveryExecutor(restarted, replayPort, 1_000).execute(input()))
      .rejects.toThrow(/run-settlement crash/u)
    expect(restarted.getStep(run.id, 't1-effects')).toMatchObject({
      status: 'unknown', resultCode: 'action-deadline-expired-ambiguous',
    })
    expect(replayPort.planned).toEqual([])
    expect(replayPort.executed).toEqual([])
    expect(sinkCalls).toEqual(['recovery:3:occurrence-1:t1-effects'])
    terminal.mockRestore()
    restarted.close()

    const settled = new RecoveryStore({ path, now: () => now, maxStepDurationMs: 100, deadlineGraceMs: 0 })
    const finalPort = new Port()
    const result = await new RecoveryExecutor(settled, finalPort, 1_000).execute(input())
    expect(result).toMatchObject({
      status: 'unknown', resultCode: 'action-deadline-expired-ambiguous',
    })
    expect(finalPort.planned).toEqual([])
    expect(finalPort.executed).toEqual([])
    settled.close()
  })

  it('does not execute ports again when only the final run commit failed', async () => {
    const { store } = fixture()
    const terminal = vi.spyOn(store, 'completeRun')
    terminal.mockImplementationOnce(() => {
      throw new Error('injected recovery terminal commit fault')
    })
    const firstPort = new Port()
    await expect(new RecoveryExecutor(store, firstPort, 1_000).execute(input()))
      .rejects.toThrow(/terminal commit fault/u)

    terminal.mockRestore()
    const replayPort = new Port()
    const result = await new RecoveryExecutor(store, replayPort, 1_000).execute(input())
    expect(result.status).toBe('succeeded')
    expect(replayPort.planned).toEqual([])
    expect(replayPort.executed).toEqual([])
    store.close()
  })
})
