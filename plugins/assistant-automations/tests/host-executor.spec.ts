import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  HostAutomationExecutorRegistry,
  HostExecutorRegistryError,
  validateHostExecutorResult,
  type HostAutomationExecutor,
} from '../src/host-executors.ts'
import type { AutomationRunnerInput } from '../src/coordinator.ts'
import { HostAutomationRunner } from '../src/runner.ts'
import { AutomationStore, normalizeAutomationDefinition } from '../src/store.ts'
import type { HostAutomationDefinition, HostAutomationExecutionSpec } from '../src/types.ts'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function execution(overrides: Partial<HostAutomationExecutionSpec> = {}): HostAutomationExecutionSpec {
  return {
    kind: 'host',
    executorId: 'assistant-recovery',
    executorContractVersion: 2,
    runbookId: 'supervised-growth/v2',
    runbookVersion: 2,
    catalogDigest: 'a'.repeat(64),
    targetScope: { workspace: '/work/alpha', preset: 'primary' },
    scopeDigest: digest(['/work/alpha', 'primary']),
    ownerRouteId: 'lark/main/tenant/owner',
    activationNonce: 'activation-1',
    ...overrides,
  }
}

function hostDefinition(overrides: Record<string, unknown> = {}): HostAutomationDefinition {
  return {
    name: 'Supervised growth v2',
    schedule: { kind: 'every', anchorAt: '2026-08-21T10:00:00.000Z', intervalMs: 60_000 },
    workspace: '/work/alpha',
    agentPreset: 'primary',
    timeoutMs: 60_000,
    misfire: { kind: 'latest' },
    overlap: 'skip',
    retrySafety: 'never',
    maxRetries: 0,
    principal: 'owner:lark:123',
    budgetId: 'growth-runs',
    budgetAmount: 1,
    execution: execution(),
    ...overrides,
  } as HostAutomationDefinition
}

function executor(overrides: Partial<HostAutomationExecutor> = {}): HostAutomationExecutor {
  return {
    descriptor: {
      executorId: 'assistant-recovery',
      contractVersion: 2,
      catalogDigest: 'a'.repeat(64),
    },
    accepts: spec => spec.runbookId === 'supervised-growth/v2' && spec.runbookVersion === 2,
    execute: vi.fn(async () => ({
      outcome: 'succeeded' as const,
      failureClass: 'none' as const,
      failurePhase: 'none' as const,
      failureCode: 'none',
      sideEffectState: 'none' as const,
      retryability: 'safe' as const,
    })),
    ...overrides,
  }
}

function runnerInput(
  definition: HostAutomationDefinition,
  overrides: {
    automationId?: string
    occurrenceId?: string
    attemptCount?: number
  } = {},
): AutomationRunnerInput {
  const automationId = overrides.automationId ?? 'growth-v2'
  const occurrenceId = overrides.occurrenceId ?? 'occ-growth'
  return {
    automation: {
      id: automationId, owner: 'assistant-recovery', definition, status: 'active',
      nextRunAt: undefined, createdAt: 1, updatedAt: 1, version: 1,
    },
    occurrence: {
      id: occurrenceId, automationId, triggerKind: 'manual', triggerKey: 'one',
      scheduledAt: 1, status: 'pending', dryRun: false, createdAt: 1, updatedAt: 1,
    },
    task: {
      id: `task-${occurrenceId}`, occurrenceId, automationId, status: 'running',
      cancelRequested: false, attemptCount: overrides.attemptCount ?? 1,
      createdAt: 1, updatedAt: 1,
    },
    sessionId: 'host-internal-session',
    signal: new AbortController().signal,
  }
}

function hostBudgetKey(
  automationId: string,
  occurrenceId: string,
  definition: HostAutomationDefinition,
  budgetId: string,
): string {
  const immutableDefinitionHash = digest(definition)
  const keyDigest = createHash('sha256').update(JSON.stringify([
    'assistant-automations-host-budget/v1', automationId, occurrenceId,
    immutableDefinitionHash, 'automation-runs', budgetId,
  ])).digest('hex')
  return `automation-budget:host:v1:${keyDigest}`
}

describe('Host automation execution contract', () => {
  test('normalizes an exact Host-only surface and recomputes the target scope digest', () => {
    const normalized = normalizeAutomationDefinition(hostDefinition({
      execution: execution({ scopeDigest: 'f'.repeat(64) }),
    }))
    expect(normalized).toMatchObject({
      workspace: '/work/alpha', agentPreset: 'primary',
      execution: {
        kind: 'host', targetScope: { workspace: '/work/alpha', preset: 'primary' },
        scopeDigest: digest(['/work/alpha', 'primary']),
      },
    })
    expect('prompt' in normalized).toBe(false)
    expect(() => normalizeAutomationDefinition({ ...hostDefinition(), prompt: 'model must not run' }))
      .toThrowError(/unknown field|Host/u)
    expect(() => normalizeAutomationDefinition({ ...hostDefinition(), approvalBindingId: 'owner-route' }))
      .toThrowError(/unknown field|Host/u)
    expect(() => normalizeAutomationDefinition(hostDefinition({
      execution: execution({ targetScope: { workspace: '/work/other', preset: 'primary' } }),
    }))).toThrowError(/targetScope/u)
  })

  test('fails closed on duplicate descriptors, overlapping accepts, and disposed registration tokens', async () => {
    const registry = new HostAutomationExecutorRegistry()
    const first = executor()
    const dispose = registry.register(first)
    expect(() => registry.register(executor())).toThrowError(
      expect.objectContaining<Partial<HostExecutorRegistryError>>({ code: 'duplicate-descriptor' }),
    )
    const proof = registry.prove(execution())
    expect(proof).toMatchObject({ available: true })

    const conflicting = executor({
      descriptor: { executorId: 'rogue', contractVersion: 1, catalogDigest: 'b'.repeat(64) },
      accepts: () => true,
    })
    const disposeConflict = registry.register(conflicting)
    expect(registry.prove(execution())).toMatchObject({
      available: false, reasonCode: 'host-executor-acceptance-conflict',
    })
    disposeConflict()

    dispose()
    expect(registry.prove(execution())).toMatchObject({
      available: false, reasonCode: 'host-executor-unavailable',
    })
    await expect(registry.execute(proof, {
      occurrenceId: 'occ-1', automationId: 'auto-1', definitionHash: 'c'.repeat(64),
      executionMode: 'production', targetScope: { workspace: '/work/alpha', preset: 'primary' },
      principal: 'owner:lark:123', ownerRouteId: 'lark/main/tenant/owner',
      activationNonce: 'activation-1', catalogDigest: 'a'.repeat(64), signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'stale-registration' })
  })

  test('bounds a non-cooperative Host callback when its registration is unloaded', async () => {
    const registry = new HostAutomationExecutorRegistry()
    let started!: () => void
    const didStart = new Promise<void>(resolve => { started = resolve })
    const dispose = registry.register(executor({
      execute: vi.fn(async (): Promise<never> => {
        started()
        return await new Promise<never>(() => {})
      }),
    }))
    const proof = registry.prove(execution())
    const pending = registry.execute(proof, {
      occurrenceId: 'occ-1', automationId: 'auto-1', definitionHash: 'c'.repeat(64),
      executionMode: 'production', targetScope: { workspace: '/work/alpha', preset: 'primary' },
      principal: 'owner:lark:123', ownerRouteId: 'lark/main/tenant/owner',
      activationNonce: 'activation-1', catalogDigest: 'a'.repeat(64), signal: new AbortController().signal,
    })
    await didStart
    dispose()
    await expect(pending).rejects.toMatchObject({ code: 'stale-registration' })
  })

  test('validates terminal Host results without content or arbitrary metrics', () => {
    expect(validateHostExecutorResult({
      outcome: 'failed', failureClass: 'configuration', failurePhase: 'host-execution',
      failureCode: 'catalog-mismatch', sideEffectState: 'none', retryability: 'after-intervention',
    })).toMatchObject({ failureCode: 'catalog-mismatch' })
    expect(() => validateHostExecutorResult({
      outcome: 'succeeded', failureClass: 'none', failurePhase: 'none', failureCode: 'none',
      sideEffectState: 'possible', retryability: 'safe',
    })).toThrowError(/contradict/u)
    expect(() => validateHostExecutorResult({
      outcome: 'succeeded', failureClass: 'configuration', failurePhase: 'host-execution',
      failureCode: 'bad', sideEffectState: 'none', retryability: 'safe',
    })).toThrowError(/contradict/u)
  })

  test('re-proves availability before budget and invokes Recovery-shaped input without a model surface', async () => {
    const order: string[] = []
    let received: unknown
    const registry = new HostAutomationExecutorRegistry()
    registry.register(executor({
      execute: vi.fn(async input => {
        order.push('execute')
        received = input
        return {
          outcome: 'succeeded' as const, failureClass: 'none' as const, failurePhase: 'none' as const,
          failureCode: 'none', sideEffectState: 'none' as const, retryability: 'safe' as const,
        }
      }),
    }))
    const policy = {
      getBudgetConfig: vi.fn(() => ({ id: 'growth-runs', metric: 'automation-runs' })),
      reserve: vi.fn(() => {
        order.push('reserve')
        return { reservationId: 'reservation-1', status: 'reserved', replayed: false }
      }),
      finalize: vi.fn(() => { order.push('finalize') }),
      release: vi.fn(),
    }
    const definition = normalizeAutomationDefinition(hostDefinition()) as HostAutomationDefinition
    const input: AutomationRunnerInput = {
      automation: {
        id: 'growth-v2', owner: 'assistant-recovery', definition, status: 'active',
        nextRunAt: undefined, createdAt: 1, updatedAt: 1, version: 1,
      },
      occurrence: {
        id: 'occ-growth', automationId: 'growth-v2', triggerKind: 'manual', triggerKey: 'one',
        scheduledAt: 1, status: 'pending', dryRun: false, createdAt: 1, updatedAt: 1,
      },
      task: {
        id: 'task-growth', occurrenceId: 'occ-growth', automationId: 'growth-v2', status: 'running',
        cancelRequested: false, attemptCount: 1, createdAt: 1, updatedAt: 1,
      },
      sessionId: 'host-internal-session',
      signal: new AbortController().signal,
    }
    const result = await new HostAutomationRunner(
      registry,
      policy as never,
    ).run(input)
    expect(order).toEqual(['reserve', 'execute', 'finalize'])
    expect(received).toMatchObject({
      occurrenceId: 'occ-growth', automationId: 'growth-v2', executionMode: 'production',
      targetScope: { workspace: '/work/alpha', preset: 'primary' },
      principal: 'owner:lark:123', ownerRouteId: 'lark/main/tenant/owner',
      activationNonce: 'activation-1', catalogDigest: 'a'.repeat(64), signal: expect.any(AbortSignal),
    })
    expect(received).not.toHaveProperty('prompt')
    expect(received).not.toHaveProperty('model')
    expect(result).toMatchObject({
      outcome: 'succeeded', usage: {}, diagnostic: {
        failureClass: 'none', failurePhase: 'none', promptSubmissionState: 'not-applicable',
        sideEffectState: 'possible', retryability: 'unsafe', budgetSettlementState: 'finalized',
      },
    })
  })

  test('resumes an exact idempotent Recovery occurrence with its still-reserved pre-crash budget receipt', async () => {
    const execute = vi.fn(async () => ({
      outcome: 'succeeded' as const, failureClass: 'none' as const, failurePhase: 'none' as const,
      failureCode: 'none', sideEffectState: 'none' as const, retryability: 'safe' as const,
    }))
    const registry = new HostAutomationExecutorRegistry()
    registry.register(executor({ execute }))
    const definition = normalizeAutomationDefinition(hostDefinition({
      retrySafety: 'idempotent', maxRetries: 1,
    })) as HostAutomationDefinition
    const recovered = runnerInput(definition, { attemptCount: 2 })
    const expectedKey = hostBudgetKey('growth-v2', 'occ-growth', definition, 'growth-runs')
    const policy = {
      getBudgetConfig: vi.fn(() => ({ id: 'growth-runs', metric: 'automation-runs' })),
      // Simulates a prior process that durably reserved, entered Recovery,
      // and died before the runner could finalize the reservation.
      reserve: vi.fn((request: { idempotencyKey: string }) => {
        expect(request.idempotencyKey).toBe(expectedKey)
        return { reservationId: 'reservation-before-crash', status: 'reserved', replayed: true }
      }),
      finalize: vi.fn(),
      release: vi.fn(),
    }

    await expect(new HostAutomationRunner(registry, policy as never).run(recovered))
      .resolves.toMatchObject({
        outcome: 'succeeded',
        diagnostic: { budgetSettlementState: 'finalized' },
      })
    expect(execute).toHaveBeenCalledOnce()
    expect(policy.finalize).toHaveBeenCalledWith('reservation-before-crash', 1)
    expect(policy.release).not.toHaveBeenCalled()
  })

  test('reuses the durable Policy reservation across a process restart for the same Recovery occurrence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-automations-budget-resume-'))
    temporaryRoots.push(root)
    const databasePath = join(root, 'policy.sqlite')
    const definition = normalizeAutomationDefinition(hostDefinition({
      retrySafety: 'idempotent', maxRetries: 1,
    })) as HostAutomationDefinition
    const idempotencyKey = hostBudgetKey('growth-v2', 'occ-growth', definition, 'growth-runs')
    const reservationRequest = {
      budgetId: 'growth-runs',
      subject: {
        kind: 'background' as const, id: 'growth-v2',
        workspace: definition.workspace, principal: definition.principal,
      },
      amount: 1,
      idempotencyKey,
    }
    const config = {
      databasePath,
      rules: [],
      budgets: [{
        id: 'growth-runs', metric: 'automation-runs', limit: 7,
        periodMs: 86_400_000, scope: 'subject' as const,
      }],
    }

    const crashedContext = new Context()
    const crashedPolicy = new AssistantPolicyService(crashedContext, config)
    const beforeCrash = crashedPolicy.reserve(reservationRequest)
    expect(beforeCrash).toMatchObject({ status: 'reserved', replayed: false })
    // No finalize/release: this is the exact durable state left by a hard
    // process death after reserve and before the Host runner settled.
    await crashedContext.fiber.restart()

    const resumedContext = new Context()
    const resumedPolicy = new AssistantPolicyService(resumedContext, config)
    expect(resumedPolicy.reserve(reservationRequest)).toMatchObject({
      reservationId: beforeCrash.reservationId, status: 'reserved', replayed: true,
    })
    const finalize = vi.spyOn(resumedPolicy, 'finalize')
    const execute = vi.fn(async () => ({
      outcome: 'succeeded' as const, failureClass: 'none' as const, failurePhase: 'none' as const,
      failureCode: 'none', sideEffectState: 'none' as const, retryability: 'safe' as const,
    }))
    const registry = new HostAutomationExecutorRegistry()
    registry.register(executor({ execute }))

    await expect(new HostAutomationRunner(registry, resumedPolicy)
      .run(runnerInput(definition, { attemptCount: 2 }))).resolves.toMatchObject({
      outcome: 'succeeded', diagnostic: { budgetSettlementState: 'finalized' },
    })
    expect(execute).toHaveBeenCalledOnce()
    expect(finalize).toHaveBeenCalledWith(beforeCrash.reservationId, 1)
    expect(resumedPolicy.reserve(reservationRequest)).toMatchObject({
      reservationId: beforeCrash.reservationId, status: 'finalized', replayed: true,
    })
    await resumedContext.fiber.restart()
  })

  test('replays an exact finalized Recovery budget only to obtain its durable terminal result', async () => {
    const execute = vi.fn(async () => ({
      outcome: 'succeeded' as const, failureClass: 'none' as const, failurePhase: 'none' as const,
      failureCode: 'none', sideEffectState: 'none' as const, retryability: 'safe' as const,
    }))
    const registry = new HostAutomationExecutorRegistry()
    registry.register(executor({ execute }))
    const definition = normalizeAutomationDefinition(hostDefinition({
      retrySafety: 'idempotent', maxRetries: 1,
    })) as HostAutomationDefinition
    const policy = {
      getBudgetConfig: vi.fn(() => ({ id: 'growth-runs', metric: 'automation-runs' })),
      reserve: vi.fn(() => ({
        reservationId: 'reservation-finalized-before-commit', status: 'finalized', replayed: true,
      })),
      finalize: vi.fn(), release: vi.fn(),
    }

    await expect(new HostAutomationRunner(registry, policy as never)
      .run(runnerInput(definition, { attemptCount: 2 }))).resolves.toMatchObject({
      outcome: 'succeeded',
      diagnostic: {
        sideEffectState: 'possible', retryability: 'unsafe', budgetSettlementState: 'finalized',
      },
    })
    expect(execute).toHaveBeenCalledOnce()
    expect(policy.finalize).not.toHaveBeenCalled()
    expect(policy.release).not.toHaveBeenCalled()
  })

  test('recovers after durable Recovery and budget finalization but before the Automations terminal commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-automations-finalized-resume-'))
    temporaryRoots.push(root)
    const automationDatabasePath = join(root, 'automations.sqlite')
    const policyDatabasePath = join(root, 'policy.sqlite')
    const recoveryDatabasePath = join(root, 'recovery-result.sqlite')
    const policyConfig = {
      databasePath: policyDatabasePath,
      rules: [],
      budgets: [{
        id: 'growth-runs', metric: 'automation-runs', limit: 7,
        periodMs: 86_400_000, scope: 'subject' as const,
      }],
    }
    const definition = normalizeAutomationDefinition(hostDefinition({
      retrySafety: 'idempotent', maxRetries: 1,
    })) as HostAutomationDefinition
    const automationId = 'growth-finalized-crash'
    const ownerOne = 'coordinator-before-crash'
    const ownerTwo = 'coordinator-after-restart'
    const executionCalls: string[] = []
    const durableExecutor = (): HostAutomationExecutor => executor({
      execute: vi.fn(async input => {
        executionCalls.push(input.occurrenceId)
        const operationKey = JSON.stringify([
          input.automationId, input.occurrenceId, input.definitionHash,
          input.executionMode, input.catalogDigest,
        ])
        const database = new DatabaseSync(recoveryDatabasePath)
        try {
          database.exec(`
            CREATE TABLE IF NOT EXISTS durable_recovery_results (
              operation_key TEXT PRIMARY KEY,
              terminal_result_json TEXT NOT NULL,
              side_effect_count INTEGER NOT NULL,
              invocation_count INTEGER NOT NULL
            ) STRICT
          `)
          const terminalResult = JSON.stringify({
            outcome: 'succeeded', failureClass: 'none', failurePhase: 'none',
            failureCode: 'none', sideEffectState: 'none', retryability: 'safe',
          })
          database.prepare(`
            INSERT INTO durable_recovery_results(
              operation_key, terminal_result_json, side_effect_count, invocation_count)
            VALUES (?, ?, 1, 1)
            ON CONFLICT(operation_key) DO UPDATE SET
              invocation_count = invocation_count + 1
          `).run(operationKey, terminalResult)
          const stored = database.prepare(`
            SELECT terminal_result_json FROM durable_recovery_results WHERE operation_key = ?
          `).get(operationKey) as { terminal_result_json: string }
          return JSON.parse(stored.terminal_result_json)
        } finally {
          database.close()
        }
      }),
    })
    const availability = (store: AutomationStore) => [{
      automationId,
      definitionHash: store.getDefinitionHash(automationId)!,
      stage: 'claim' as const,
      available: true,
      reasonCode: 'host-executor-available',
    }]

    const beforeCrashStore = new AutomationStore({ path: automationDatabasePath, now: () => 1_000 })
    beforeCrashStore.createApproved({
      automationId, idempotencyKey: 'growth-finalized-crash:v1', definition,
    })
    const occurrence = beforeCrashStore.createManual({
      automationId, requestId: 'same-occurrence', dryRun: false,
    })
    const task = beforeCrashStore.listTasks({ automationId, limit: 10 })[0]!
    const firstDuty = beforeCrashStore.acquireDuty({ ownerId: ownerOne, now: 1_000, leaseMs: 100 })
    const firstClaim = beforeCrashStore.claimTask({
      taskId: task.id, ownerId: ownerOne, fencingToken: firstDuty.fencingToken,
      now: 1_001, leaseMs: 100, hostAvailability: availability(beforeCrashStore),
    })!
    const firstStarted = beforeCrashStore.startTask({
      taskId: firstClaim.id, ownerId: ownerOne, fencingToken: firstDuty.fencingToken,
      now: 1_002, leaseMs: 100, sessionId: 'recovery-before-crash',
    })
    const beforeCrashContext = new Context()
    const beforeCrashPolicy = new AssistantPolicyService(beforeCrashContext, policyConfig)
    const firstRegistry = new HostAutomationExecutorRegistry()
    firstRegistry.register(durableExecutor())
    const firstResult = await new HostAutomationRunner(firstRegistry, beforeCrashPolicy).run({
      automation: beforeCrashStore.getTaskExecutionSnapshot(task.id)!,
      occurrence,
      task: firstStarted,
      sessionId: 'recovery-before-crash',
      signal: new AbortController().signal,
    })
    expect(firstResult).toMatchObject({
      outcome: 'succeeded', diagnostic: { budgetSettlementState: 'finalized' },
    })
    // Fault injection: the Host runner returned after Recovery and Policy were
    // durable, but the coordinator process dies before store.completeTask().
    expect(beforeCrashStore.getTaskRecord(task.id)).toMatchObject({ status: 'running', attemptCount: 1 })
    expect(beforeCrashStore.listRuns({ automationId, limit: 10 })).toEqual([])
    beforeCrashStore.close()
    await beforeCrashContext.fiber.restart()

    const restartedStore = new AutomationStore({ path: automationDatabasePath, now: () => 1_200 })
    expect(restartedStore.recoverExpiredTasks({ now: 1_200 })).toEqual([
      expect.objectContaining({ id: task.id, status: 'scheduled', attemptCount: 1 }),
    ])
    const secondDuty = restartedStore.acquireDuty({ ownerId: ownerTwo, now: 1_200, leaseMs: 1_000 })
    const secondClaim = restartedStore.claimTask({
      taskId: task.id, ownerId: ownerTwo, fencingToken: secondDuty.fencingToken,
      now: 1_201, leaseMs: 500, hostAvailability: availability(restartedStore),
    })!
    const secondStarted = restartedStore.startTask({
      taskId: secondClaim.id, ownerId: ownerTwo, fencingToken: secondDuty.fencingToken,
      now: 1_202, leaseMs: 500, sessionId: 'recovery-after-restart',
    })
    const restartedContext = new Context()
    const restartedPolicy = new AssistantPolicyService(restartedContext, policyConfig)
    const finalizeAfterRestart = vi.spyOn(restartedPolicy, 'finalize')
    const releaseAfterRestart = vi.spyOn(restartedPolicy, 'release')
    const secondRegistry = new HostAutomationExecutorRegistry()
    secondRegistry.register(durableExecutor())
    const secondResult = await new HostAutomationRunner(secondRegistry, restartedPolicy).run({
      automation: restartedStore.getTaskExecutionSnapshot(task.id)!,
      occurrence: restartedStore.getOccurrence(occurrence.id)!,
      task: secondStarted,
      sessionId: 'recovery-after-restart',
      signal: new AbortController().signal,
    })
    expect(secondResult).toMatchObject({
      outcome: 'succeeded',
      diagnostic: { sideEffectState: 'possible', budgetSettlementState: 'finalized' },
    })
    expect(finalizeAfterRestart).not.toHaveBeenCalled()
    expect(releaseAfterRestart).not.toHaveBeenCalled()
    const run = restartedStore.completeTask({
      taskId: task.id, ownerId: ownerTwo, fencingToken: secondDuty.fencingToken,
      now: 1_203, outcome: secondResult.outcome,
      sessionId: 'recovery-after-restart', outputPreview: secondResult.output,
      usage: secondResult.usage, diagnostic: secondResult.diagnostic!,
    })
    expect(run).toMatchObject({
      status: 'succeeded', diagnostic: { budgetSettlementState: 'finalized' },
    })
    expect(restartedStore.getTaskRecord(task.id)).toMatchObject({ status: 'succeeded', attemptCount: 2 })
    expect(restartedStore.getOccurrence(occurrence.id)).toMatchObject({ status: 'succeeded' })
    expect(restartedStore.listRuns({ automationId, limit: 10 })).toEqual([
      expect.objectContaining({ id: run.id, status: 'succeeded' }),
    ])
    restartedStore.close()
    await restartedContext.fiber.restart()

    const policyDatabase = new DatabaseSync(policyDatabasePath, { readOnly: true })
    expect(policyDatabase.prepare(`
      SELECT COUNT(*) AS count, MIN(status) AS status, TOTAL(actual_amount) AS actual
      FROM budget_reservations
    `).get()).toEqual({ count: 1, status: 'finalized', actual: 1 })
    expect(policyDatabase.prepare(`
      SELECT TOTAL(reserved_amount) AS reserved, TOTAL(spent_amount) AS spent FROM budget_periods
    `).get()).toEqual({ reserved: 0, spent: 1 })
    policyDatabase.close()
    const recoveryDatabase = new DatabaseSync(recoveryDatabasePath, { readOnly: true })
    expect(recoveryDatabase.prepare(`
      SELECT COUNT(*) AS rows, TOTAL(side_effect_count) AS effects,
        TOTAL(invocation_count) AS invocations
      FROM durable_recovery_results
    `).get()).toEqual({ rows: 1, effects: 1, invocations: 2 })
    recoveryDatabase.close()
    expect(executionCalls).toEqual([occurrence.id, occurrence.id])
  })

  test(
    'keeps a replayed released Recovery budget terminal and never resumes the executor',
    async () => {
      const execute = vi.fn(async () => ({
        outcome: 'succeeded' as const, failureClass: 'none' as const, failurePhase: 'none' as const,
        failureCode: 'none', sideEffectState: 'none' as const, retryability: 'safe' as const,
      }))
      const registry = new HostAutomationExecutorRegistry()
      registry.register(executor({ execute }))
      const definition = normalizeAutomationDefinition(hostDefinition({
        retrySafety: 'idempotent', maxRetries: 1,
      })) as HostAutomationDefinition
      const policy = {
        getBudgetConfig: vi.fn(() => ({ id: 'growth-runs', metric: 'automation-runs' })),
        reserve: vi.fn(() => ({ reservationId: 'reservation-terminal', status: 'released', replayed: true })),
        finalize: vi.fn(), release: vi.fn(),
      }

      await expect(new HostAutomationRunner(registry, policy as never)
        .run(runnerInput(definition, { attemptCount: 2 }))).rejects.toMatchObject({
        diagnostic: {
          failureCode: 'automation-budget-reservation-replayed',
          budgetSettlementState: 'released',
        },
      })
      expect(execute).not.toHaveBeenCalled()
      expect(policy.finalize).not.toHaveBeenCalled()
      expect(policy.release).not.toHaveBeenCalled()
    },
  )

  test('releases and rejects a fresh reservation when a recovered occurrence has a different immutable definition key', async () => {
    const execute = vi.fn(async () => ({
      outcome: 'succeeded' as const, failureClass: 'none' as const, failurePhase: 'none' as const,
      failureCode: 'none', sideEffectState: 'none' as const, retryability: 'safe' as const,
    }))
    const registry = new HostAutomationExecutorRegistry()
    registry.register(executor({ execute }))
    const priorDefinition = normalizeAutomationDefinition(hostDefinition({
      retrySafety: 'idempotent', maxRetries: 1,
    })) as HostAutomationDefinition
    const changedDefinition = normalizeAutomationDefinition(hostDefinition({
      retrySafety: 'idempotent', maxRetries: 1,
      execution: execution({ activationNonce: 'changed-after-crash' }),
    })) as HostAutomationDefinition
    const priorKey = hostBudgetKey('growth-v2', 'occ-growth', priorDefinition, 'growth-runs')
    const changedKey = hostBudgetKey('growth-v2', 'occ-growth', changedDefinition, 'growth-runs')
    expect(changedKey).not.toBe(priorKey)
    const policy = {
      getBudgetConfig: vi.fn(() => ({ id: 'growth-runs', metric: 'automation-runs' })),
      reserve: vi.fn((request: { idempotencyKey: string }) => {
        expect(request.idempotencyKey).toBe(changedKey)
        return { reservationId: 'fresh-different-key', status: 'reserved', replayed: false }
      }),
      finalize: vi.fn(),
      release: vi.fn(() => ({
        reservationId: 'fresh-different-key', status: 'released', replayed: false,
      })),
    }

    await expect(new HostAutomationRunner(registry, policy as never)
      .run(runnerInput(changedDefinition, { attemptCount: 2 }))).rejects.toMatchObject({
      diagnostic: {
        failureClass: 'budget', failurePhase: 'budget-reservation',
        failureCode: 'host-recovery-resume-key-mismatch', sideEffectState: 'none',
        budgetSettlementState: 'released',
      },
    })
    expect(policy.release).toHaveBeenCalledWith('fresh-different-key')
    expect(policy.finalize).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  test('releases and rejects a fresh reservation when the recovered occurrence identity changed', async () => {
    const execute = vi.fn(async () => ({
      outcome: 'succeeded' as const, failureClass: 'none' as const, failurePhase: 'none' as const,
      failureCode: 'none', sideEffectState: 'none' as const, retryability: 'safe' as const,
    }))
    const registry = new HostAutomationExecutorRegistry()
    registry.register(executor({ execute }))
    const definition = normalizeAutomationDefinition(hostDefinition({
      retrySafety: 'idempotent', maxRetries: 1,
    })) as HostAutomationDefinition
    const priorKey = hostBudgetKey('growth-v2', 'occ-growth', definition, 'growth-runs')
    const changedKey = hostBudgetKey('growth-v2', 'occ-other', definition, 'growth-runs')
    expect(changedKey).not.toBe(priorKey)
    const policy = {
      getBudgetConfig: vi.fn(() => ({ id: 'growth-runs', metric: 'automation-runs' })),
      reserve: vi.fn((request: { idempotencyKey: string }) => {
        expect(request.idempotencyKey).toBe(changedKey)
        return { reservationId: 'fresh-changed-occurrence', status: 'reserved', replayed: false }
      }),
      finalize: vi.fn(),
      release: vi.fn(() => ({
        reservationId: 'fresh-changed-occurrence', status: 'released', replayed: false,
      })),
    }

    await expect(new HostAutomationRunner(registry, policy as never).run(runnerInput(
      definition, { attemptCount: 2, occurrenceId: 'occ-other' },
    ))).rejects.toMatchObject({
      diagnostic: {
        failureCode: 'host-recovery-resume-key-mismatch', sideEffectState: 'none',
        budgetSettlementState: 'released',
      },
    })
    expect(policy.release).toHaveBeenCalledWith('fresh-changed-occurrence')
    expect(policy.finalize).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  test.each([
    ['non-idempotent Recovery', hostDefinition({ retrySafety: 'never', maxRetries: 1 }), 2],
    ['ordinary idempotent Host', hostDefinition({
      retrySafety: 'idempotent', maxRetries: 1,
      execution: execution({ executorId: 'ordinary-host' }),
    }), 2],
    ['Recovery beyond maxRetries', hostDefinition({ retrySafety: 'idempotent', maxRetries: 1 }), 3],
  ] as const)('rejects a recovered %s before touching Policy budget', async (_label, rawDefinition, attemptCount) => {
    const definition = normalizeAutomationDefinition(rawDefinition) as HostAutomationDefinition
    const reserve = vi.fn()
    await expect(new HostAutomationRunner(new HostAutomationExecutorRegistry(), {
      reserve,
    } as never).run(runnerInput(definition, { attemptCount }))).rejects.toMatchObject({
      diagnostic: {
        failurePhase: 'preflight', failureCode: 'host-recovery-resume-not-authorized',
        sideEffectState: 'none', budgetSettlementState: 'not-reserved',
      },
    })
    expect(reserve).not.toHaveBeenCalled()
  })

  test.each(['reserved', 'finalized'] as const)(
    'does not treat a first-attempt %s replay as Recovery crash continuation', async status => {
    const execute = vi.fn(async () => ({
      outcome: 'succeeded' as const, failureClass: 'none' as const, failurePhase: 'none' as const,
      failureCode: 'none', sideEffectState: 'none' as const, retryability: 'safe' as const,
    }))
    const registry = new HostAutomationExecutorRegistry()
    registry.register(executor({ execute }))
    const definition = normalizeAutomationDefinition(hostDefinition({
      retrySafety: 'idempotent', maxRetries: 1,
    })) as HostAutomationDefinition
    const policy = {
      getBudgetConfig: vi.fn(() => ({ id: 'growth-runs', metric: 'automation-runs' })),
      reserve: vi.fn(() => ({ reservationId: 'concurrent-reservation', status, replayed: true })),
      finalize: vi.fn(), release: vi.fn(),
    }

    await expect(new HostAutomationRunner(registry, policy as never)
      .run(runnerInput(definition))).rejects.toMatchObject({
      diagnostic: {
        failureCode: 'automation-budget-reservation-replayed',
        sideEffectState: 'unknown', retryability: 'unsafe', budgetSettlementState: status,
      },
    })
    expect(execute).not.toHaveBeenCalled()
    expect(policy.finalize).not.toHaveBeenCalled()
    expect(policy.release).not.toHaveBeenCalled()
    },
  )

  test('does not touch Policy budget when the exact Host executor is unavailable', async () => {
    const reserve = vi.fn()
    const definition = normalizeAutomationDefinition(hostDefinition()) as HostAutomationDefinition
    const input = {
      automation: { id: 'growth-v2', owner: 'assistant-recovery', definition, status: 'active' as const,
        nextRunAt: undefined, createdAt: 1, updatedAt: 1, version: 1 },
      occurrence: { id: 'occ-growth', automationId: 'growth-v2', triggerKind: 'manual' as const,
        triggerKey: 'one', scheduledAt: 1, status: 'pending' as const, dryRun: false, createdAt: 1, updatedAt: 1 },
      task: { id: 'task-growth', occurrenceId: 'occ-growth', automationId: 'growth-v2', status: 'running' as const,
        cancelRequested: false, attemptCount: 1, createdAt: 1, updatedAt: 1 },
      sessionId: 'host-internal-session', signal: new AbortController().signal,
    }
    await expect(new HostAutomationRunner(new HostAutomationExecutorRegistry(), {
      reserve,
    } as never, { allowUnbudgetedExecution: true }).run(input)).rejects.toMatchObject({
      diagnostic: {
        failurePhase: 'executor-availability', failureCode: 'host-executor-unavailable',
        promptSubmissionState: 'not-applicable', budgetSettlementState: 'not-reserved',
      },
    })
    expect(reserve).not.toHaveBeenCalled()
  })
})
