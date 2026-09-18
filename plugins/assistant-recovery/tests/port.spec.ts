import { describe, expect, it, vi } from 'vitest'
import { RECOVERY_CATALOG_DIGEST } from '../src/catalog.ts'
import type { NormalizedRecoveryJob } from '../src/config.ts'
import type { RecoveryExecutionContext } from '../src/executor.ts'
import {
  HostRecoveryRunbookPort,
  RECOVERY_SYSTEM_OWNER,
  type RecoveryRuntimePorts,
} from '../src/port.ts'

const hash = (value: string) => value.repeat(64)
const principalLineage = Object.freeze({
  principalRecordId: 'principal-row-1',
  principalVersion: 1,
})
const preferenceOwnerGeneration = 1

function activationAction() {
  return Object.freeze({
    kind: 'activate-preference' as const,
    hypothesisId: 'hypothesis-1',
    expectedVersion: 3,
    ownerGeneration: preferenceOwnerGeneration,
    principalLineage,
  })
}

function maintenanceAction() {
  return Object.freeze({
    kind: 'maintain-preferences' as const,
    limit: 1 as const,
    ownerGeneration: preferenceOwnerGeneration,
    principalLineage,
  })
}

function job(overrides: Partial<NormalizedRecoveryJob> = {}): NormalizedRecoveryJob {
  return Object.freeze({
    id: 'supervised-growth',
    activationState: 'active',
    activationNonce: 'activation-1',
    catalogDigest: RECOVERY_CATALOG_DIGEST,
    workspace: '/workspace',
    preset: 'owner',
    principal: 'lark/main/tenant/owner',
    ownerRouteId: 'owner-route',
    cron: '0 */2 * * *',
    timezone: 'UTC',
    budgetId: 'growth-runs',
    budgetAmount: 1,
    ...overrides,
  })
}

function context(overrides: Partial<RecoveryExecutionContext> = {}): RecoveryExecutionContext {
  return Object.freeze({
    runId: 'run-1',
    occurrenceId: 'occurrence-1',
    automationId: 'recovery:supervised-growth',
    definitionHash: hash('a'),
    executionMode: 'production',
    targetScope: { workspace: '/workspace', preset: 'owner' },
    principal: 'lark/main/tenant/owner',
    ownerRouteId: 'owner-route',
    activationNonce: 'activation-1',
    activationPlanDigest: hash('e'),
    catalogDigest: RECOVERY_CATALOG_DIGEST,
    ...overrides,
  })
}

function healthReport() {
  return Object.freeze({
    ready: true,
    severity: 'healthy' as const,
    generatedAt: 10,
    providers: Object.freeze([
      'assistantAutomations', 'assistantEvaluation', 'preferenceLearning',
      'assistantEvolution', 'assistantRecovery',
    ].map(id => Object.freeze({ id, status: 'ready' as const, metrics: Object.freeze({}) }))),
    assessments: Object.freeze([]),
    warnings: Object.freeze([]),
  })
}

function runtime(overrides: Partial<RecoveryRuntimePorts> = {}): RecoveryRuntimePorts {
  const projection = Object.freeze({
    owner: RECOVERY_SYSTEM_OWNER,
    automationId: 'recovery:supervised-growth',
    automationStatus: 'active' as const,
    definitionHash: hash('a'),
    definitionVersion: 1,
    latestTerminalRuns: Object.freeze({}),
  })
  return {
    automations: {
      inspectSystemOwned: vi.fn(() => projection),
    },
    delivery: {
      validateOwnerRoute: vi.fn(input => Object.freeze({
        receiptVersion: 2 as const,
        authorityId: input.authorityId,
        authorityHash: hash('f'),
        principalId: input.principalId,
        principalRecordId: principalLineage.principalRecordId,
        principalVersion: principalLineage.principalVersion,
        workspace: input.workspace,
        agentPreset: input.agentPreset,
        bindingVersion: 1,
        generation: 1,
      })),
    },
    evaluation: {
      health: vi.fn(() => ({ ready: true } as never)),
    },
    evolution: {
      hostCandidates: vi.fn(() => []),
      hostGoalDefinitionEpisodes: vi.fn(() => []),
      hostListRules: vi.fn(() => []),
      hostRollbackOne: vi.fn(),
    },
    goals: {
      hostSummarizeAdviceByDefinition: vi.fn(() => []),
    },
    preference: {
      health: vi.fn(() => ({ ready: true } as never)),
      hostActivationCandidate: vi.fn(() => undefined),
      hostActivateOne: vi.fn(),
      hostMaintainOne: vi.fn(() => ({
        deletedSignals: 0,
        replayed: false,
        ownerGeneration: preferenceOwnerGeneration,
        principalLineageId: principalLineage.principalRecordId,
        principalLineageVersion: principalLineage.principalVersion,
      })),
      hostOwnerFence: vi.fn(() => ({
        ownerGeneration: preferenceOwnerGeneration,
        principalLineage,
      })),
      hostReview: vi.fn(() => ({ hypotheses: [], activeOverlay: undefined })),
    },
    health: {
      hostGlobalSnapshot: vi.fn(() => healthReport() as never),
    },
    ...overrides,
  }
}

function port(current = runtime(), configured = job()): HostRecoveryRunbookPort {
  return new HostRecoveryRunbookPort(
    new Map([['recovery:supervised-growth', configured]]),
    current,
    new Map([['recovery:supervised-growth', hash('e')]]),
    new Map([['recovery:supervised-growth', hash('f')]]),
  )
}

describe('HostRecoveryRunbookPort', () => {
  it('admits only the exact configured active definition and required Host providers', async () => {
    const current = runtime()
    const adapter = port(current)
    const planned = await adapter.plan(
      context(),
      'authority-admission',
      new AbortController().signal,
    )
    expect(planned).toMatchObject({ action: { kind: 'verify-authority' } })
    expect(planned.beforeDigest).toMatch(/^[a-f\d]{64}$/u)
    await expect(adapter.execute(
      context(),
      'authority-admission',
      { kind: 'verify-authority' },
      'recovery:4:occurrence-1:authority-admission',
      new AbortController().signal,
    )).resolves.toMatchObject({ status: 'succeeded', resultCode: 'authority-verified' })
    expect(current.health.hostGlobalSnapshot).toHaveBeenLastCalledWith({
      principal: 'lark/main/tenant/owner',
      operationId: 'recovery:4:occurrence-1:authority-admission',
    })
    expect(current.delivery.validateOwnerRoute).toHaveBeenCalledWith({
      authorityId: 'owner-route',
      principalId: 'lark/main/tenant/owner',
      workspace: '/workspace',
      agentPreset: 'owner',
    })
  })

  it('fails closed before any mutation when authority scope or definition drifts', async () => {
    await expect(port().plan(
      context({ ownerRouteId: 'forged-route' }),
      'authority-admission',
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'authority-scope-mismatch', sideEffectState: 'none',
    })
    await expect(port().plan(
      context({ activationPlanDigest: hash('d') }),
      'authority-admission',
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'authority-scope-mismatch', sideEffectState: 'none',
    })

    const current = runtime({
      automations: {
        inspectSystemOwned: vi.fn(() => ({
          owner: RECOVERY_SYSTEM_OWNER,
          automationId: 'recovery:supervised-growth',
          automationStatus: 'active', definitionHash: hash('b'), definitionVersion: 2,
          latestTerminalRuns: {},
        })),
      } as never,
    })
    await expect(port(current).plan(
      context(),
      'authority-admission',
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'automation-definition-mismatch', sideEffectState: 'none',
    })
  })

  it('allows only its own bootstrap-in-progress degradation and rejects every other degraded final state', async () => {
    const bootstrap = runtime({ health: {
      hostGlobalSnapshot: vi.fn(() => ({
        ...healthReport(),
        severity: 'degraded',
        assessments: [{
          providerId: 'assistantRecovery', severity: 'degraded', code: 'bootstrap-in-progress',
        }],
      } as never)),
    } })
    await expect(port(bootstrap).execute(
      context(), 'verification', { kind: 'verify-health' },
      'recovery:4:occurrence-1:verification', new AbortController().signal,
    )).resolves.toMatchObject({ status: 'succeeded', resultCode: 'health-verified' })

    const degraded = runtime({ health: {
      hostGlobalSnapshot: vi.fn(() => ({
        ...healthReport(),
        severity: 'degraded',
        assessments: [{
          providerId: 'assistantEvaluation', severity: 'degraded', code: 'projection-retry-backlog',
        }],
      } as never)),
    } })
    await expect(port(degraded).execute(
      context(), 'authority-admission', { kind: 'verify-authority' },
      'recovery:4:occurrence-1:authority-admission', new AbortController().signal,
    )).resolves.toMatchObject({ status: 'succeeded', resultCode: 'authority-verified' })
    await expect(port(degraded).execute(
      context(), 'verification', { kind: 'verify-health' },
      'recovery:4:occurrence-1:verification', new AbortController().signal,
    )).rejects.toMatchObject({ code: 'health-not-ready', sideEffectState: 'none' })
  })

  it('persists the exact Evaluation id selected by the read-only peek before projection', async () => {
    const reconcileProjection = vi.fn(async () => ({
      evaluationId: 'evaluation-7', status: 'recorded' as const, attemptCount: 0,
    }))
    const current = runtime({
      evaluation: {
        health: vi.fn(() => ({ ready: true } as never)),
        peekPendingProjection: vi.fn(() => ({ evaluationId: 'evaluation-7', attemptCount: 0 })),
        reconcileProjection,
      },
    })
    const adapter = port(current)
    const planned = await adapter.plan(context(), 'ledger-reconcile', new AbortController().signal)
    expect(planned.action).toEqual({ kind: 'project-evaluation', evaluationId: 'evaluation-7' })

    await expect(adapter.execute(
      context(),
      'ledger-reconcile',
      planned.action,
      'recovery:4:occurrence-1:ledger-reconcile',
      new AbortController().signal,
    )).resolves.toMatchObject({ status: 'succeeded', resultCode: 'quality-projected' })
    expect(reconcileProjection).toHaveBeenCalledWith(expect.objectContaining({
      evaluationId: 'evaluation-7',
      operationId: 'recovery:4:occurrence-1:ledger-reconcile',
    }))
  })

  it('treats a deferred exact projection as a possible-effect failure', async () => {
    const current = runtime({
      evaluation: {
        health: vi.fn(() => ({ ready: true } as never)),
        peekPendingProjection: vi.fn(() => ({ evaluationId: 'evaluation-7', attemptCount: 0 })),
        reconcileProjection: vi.fn(async () => ({
          evaluationId: 'evaluation-7', status: 'deferred' as const, attemptCount: 1,
        })),
      },
    })
    await expect(port(current).execute(
      context(),
      'ledger-reconcile',
      { kind: 'project-evaluation', evaluationId: 'evaluation-7' },
      'recovery:4:occurrence-1:ledger-reconcile',
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'projection-deferred', sideEffectState: 'possible',
    })
  })

  it('uses the Recovery step idempotency key for one scoped retention mutation', async () => {
    const hostOwnerFence = vi.fn(() => ({
      ownerGeneration: preferenceOwnerGeneration,
      principalLineage,
    }))
    const hostMaintainOne = vi.fn(() => ({
      deletedSignals: 1,
      replayed: false,
      ownerGeneration: preferenceOwnerGeneration,
      principalLineageId: principalLineage.principalRecordId,
      principalLineageVersion: principalLineage.principalVersion,
    }))
    const current = runtime({ preference: {
      ...runtime().preference,
      hostOwnerFence,
      hostMaintainOne,
    } })
    const adapter = port(current)
    const planned = await adapter.plan(context(), 'retention-maintenance', new AbortController().signal)
    expect(planned.action).toEqual(maintenanceAction())
    expect(hostOwnerFence).toHaveBeenCalledWith(expect.objectContaining({
      principal: 'lark/main/tenant/owner',
      principalLineage,
      operationId: 'recovery:plan:4:occurrence-1:retention-maintenance',
    }))
    await expect(adapter.execute(
      context(),
      'retention-maintenance',
      planned.action,
      'recovery:4:occurrence-1:retention-maintenance',
      new AbortController().signal,
    )).resolves.toMatchObject({ status: 'succeeded', resultCode: 'preference-retained' })
    expect(hostMaintainOne).toHaveBeenCalledWith(expect.objectContaining({
      principal: 'lark/main/tenant/owner',
      principalLineage,
      ownerGeneration: preferenceOwnerGeneration,
      operationId: 'recovery:4:occurrence-1:retention-maintenance',
    }))
  })

  it('rejects an unfenced legacy retention action before crossing the Preference boundary', async () => {
    const current = runtime()
    await expect(port(current).execute(
      context(),
      'retention-maintenance',
      { kind: 'maintain-preferences', limit: 1 },
      'recovery:4:occurrence-1:retention-maintenance',
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'preference-maintenance-action-unfenced', sideEffectState: 'none',
    })
    expect(current.delivery.validateOwnerRoute).not.toHaveBeenCalled()
    expect(current.preference.hostMaintainOne).not.toHaveBeenCalled()
  })

  it('rejects stale A-to-B-to-A retention lineage before deleting a new owner signal', async () => {
    const hostMaintainOne = vi.fn()
    const current = runtime({
      delivery: {
        validateOwnerRoute: vi.fn(input => Object.freeze({
          receiptVersion: 2 as const,
          authorityId: input.authorityId,
          authorityHash: hash('f'),
          principalId: input.principalId,
          principalRecordId: 'principal-row-3',
          principalVersion: 1,
          workspace: input.workspace,
          agentPreset: input.agentPreset,
          bindingVersion: 3,
          generation: 3,
        })),
      },
      preference: { ...runtime().preference, hostMaintainOne },
    })

    await expect(port(current).execute(
      context(),
      'retention-maintenance',
      maintenanceAction(),
      'recovery:4:occurrence-1:retention-maintenance',
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'owner-route-lineage-mismatch', sideEffectState: 'none' })
    expect(hostMaintainOne).not.toHaveBeenCalled()
  })

  it('requires a maintenance receipt to echo the complete durable owner fence', async () => {
    const current = runtime({ preference: {
      ...runtime().preference,
      hostMaintainOne: vi.fn(() => ({
        deletedSignals: 1,
        replayed: false,
        ownerGeneration: preferenceOwnerGeneration + 1,
        principalLineageId: principalLineage.principalRecordId,
        principalLineageVersion: principalLineage.principalVersion,
      })),
    } })
    await expect(port(current).execute(
      context(),
      'retention-maintenance',
      maintenanceAction(),
      'recovery:4:occurrence-1:retention-maintenance',
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'preference-maintenance-receipt-invalid', sideEffectState: 'possible',
    })
  })

  it('never falls back to an arm-only circuit repair when the atomic canary seam is absent', async () => {
    await expect(port().plan(
      context(), 'incident-review', new AbortController().signal,
    )).resolves.toMatchObject({
      action: { kind: 'noop', reasonCode: 'circuit-canary-seam-unavailable' },
    })
  })

  it('persists the exact Delivery lineage and Preference generation selected for activation', async () => {
    const hostActivationCandidate = vi.fn(() => Object.freeze({
      hypothesisId: 'hypothesis-1',
      expectedVersion: 3,
      ownerGeneration: preferenceOwnerGeneration,
      principalLineage,
    }))
    const current = runtime({ preference: {
      ...runtime().preference,
      hostActivationCandidate,
    } })

    await expect(port(current).plan(
      context(),
      't1-effects',
      new AbortController().signal,
    )).resolves.toMatchObject({ action: activationAction() })
    expect(hostActivationCandidate).toHaveBeenCalledWith(expect.objectContaining({
      principal: 'lark/main/tenant/owner',
      principalLineage,
      operationId: 'recovery:plan:4:occurrence-1:t1-effects',
    }))
  })

  it.each([
    ['missing generation', (receipt: Record<string, unknown>) => {
      const { generation: _generation, ...rest } = receipt
      return rest
    }],
    ['invalid generation', (receipt: Record<string, unknown>) => ({ ...receipt, generation: 0 })],
    ['missing lineage id', (receipt: Record<string, unknown>) => {
      const { principalRecordId: _principalRecordId, ...rest } = receipt
      return rest
    }],
    ['missing lineage version', (receipt: Record<string, unknown>) => {
      const { principalVersion: _principalVersion, ...rest } = receipt
      return rest
    }],
    ['invalid lineage version', (receipt: Record<string, unknown>) => ({ ...receipt, principalVersion: 0 })],
  ])('rejects an owner-route receipt with %s', async (_label, mutate) => {
    const current = runtime()
    const valid = current.delivery.validateOwnerRoute({
      authorityId: 'owner-route',
      principalId: 'lark/main/tenant/owner',
      workspace: '/workspace',
      agentPreset: 'owner',
    })
    current.delivery.validateOwnerRoute = vi.fn(() => mutate({ ...valid }) as never)
    await expect(port(current).plan(
      context(),
      't1-effects',
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'owner-route-receipt-invalid', sideEffectState: 'none' })
    expect(current.preference.hostActivationCandidate).not.toHaveBeenCalled()
  })

  it('replays an exact activation receipt without requiring the candidate to remain pending', async () => {
    const hostActivateOne = vi.fn(() => ({
      hypothesisId: 'hypothesis-1', expectedVersion: 3, resultVersion: 4, replayed: true,
      ownerGeneration: preferenceOwnerGeneration,
      principalLineageId: principalLineage.principalRecordId,
      principalLineageVersion: principalLineage.principalVersion,
    }))
    const current = runtime({ preference: {
      ...runtime().preference,
      hostActivationCandidate: vi.fn(() => undefined),
      hostActivateOne,
    } })
    await expect(port(current).execute(
      context(),
      't1-effects',
      activationAction(),
      'recovery:4:occurrence-1:t1-effects',
      new AbortController().signal,
    )).resolves.toMatchObject({ status: 'succeeded', resultCode: 'preference-activated' })
    expect(hostActivateOne).toHaveBeenCalledWith(expect.objectContaining({
      hypothesisId: 'hypothesis-1', expectedVersion: 3,
      ownerGeneration: preferenceOwnerGeneration,
      principalLineage,
      operationId: 'recovery:4:occurrence-1:t1-effects',
    }))
  })

  it('rejects a dangling generation-1 Host activation receipt for an A3 action', async () => {
    const lineageA3 = Object.freeze({
      principalRecordId: principalLineage.principalRecordId,
      principalVersion: 3,
    })
    const action = Object.freeze({
      ...activationAction(),
      ownerGeneration: 3,
      principalLineage: lineageA3,
    })
    const hostActivateOne = vi.fn(() => ({
      hypothesisId: action.hypothesisId,
      expectedVersion: action.expectedVersion,
      resultVersion: action.expectedVersion + 1,
      replayed: true,
      ownerGeneration: 1,
      principalLineageId: principalLineage.principalRecordId,
      principalLineageVersion: 1,
    }))
    const current = runtime({
      delivery: {
        validateOwnerRoute: vi.fn(input => Object.freeze({
          receiptVersion: 2 as const,
          authorityId: input.authorityId,
          authorityHash: hash('f'),
          principalId: input.principalId,
          principalRecordId: lineageA3.principalRecordId,
          principalVersion: lineageA3.principalVersion,
          workspace: input.workspace,
          agentPreset: input.agentPreset,
          bindingVersion: 3,
          generation: 3,
        })),
      },
      preference: { ...runtime().preference, hostActivateOne },
    })

    await expect(port(current).execute(
      context(),
      't1-effects',
      action,
      'recovery:4:occurrence-1:t1-effects',
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'preference-activation-receipt-invalid', sideEffectState: 'possible',
    })
    expect(hostActivateOne).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['missing generation', {
      hypothesisId: 'hypothesis-1', expectedVersion: 3, resultVersion: 4, replayed: true,
      principalLineageId: principalLineage.principalRecordId,
      principalLineageVersion: principalLineage.principalVersion,
    }],
    ['wrong generation', {
      hypothesisId: 'hypothesis-1', expectedVersion: 3, resultVersion: 4, replayed: true,
      ownerGeneration: preferenceOwnerGeneration + 1,
      principalLineageId: principalLineage.principalRecordId,
      principalLineageVersion: principalLineage.principalVersion,
    }],
    ['missing lineage', {
      hypothesisId: 'hypothesis-1', expectedVersion: 3, resultVersion: 4, replayed: true,
      ownerGeneration: preferenceOwnerGeneration,
    }],
    ['wrong lineage id', {
      hypothesisId: 'hypothesis-1', expectedVersion: 3, resultVersion: 4, replayed: true,
      ownerGeneration: preferenceOwnerGeneration,
      principalLineageId: 'principal-row-old',
      principalLineageVersion: principalLineage.principalVersion,
    }],
    ['wrong lineage version', {
      hypothesisId: 'hypothesis-1', expectedVersion: 3, resultVersion: 4, replayed: true,
      ownerGeneration: preferenceOwnerGeneration,
      principalLineageId: principalLineage.principalRecordId,
      principalLineageVersion: principalLineage.principalVersion + 1,
    }],
  ])('rejects an activation receipt with %s', async (_label, receipt) => {
    const hostActivateOne = vi.fn(() => receipt as never)
    const current = runtime({ preference: { ...runtime().preference, hostActivateOne } })
    await expect(port(current).execute(
      context(),
      't1-effects',
      activationAction(),
      'recovery:4:occurrence-1:t1-effects',
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'preference-activation-receipt-invalid', sideEffectState: 'possible',
    })
  })

  it('replays an exact Evolution rollback receipt after sink commit without reselecting a candidate', async () => {
    const hostRollbackOne = vi.fn(() => ({
      rule: { id: 'rule-1', version: 8, status: 'retired' }, replayed: true,
      rollback: {
        ruleId: 'rule-1', expectedVersion: 7, resultVersion: 8,
        evidence: { digest: hash('a') },
      },
    }))
    const current = runtime({ evolution: {
      ...runtime().evolution,
      hostCandidates: vi.fn(() => []),
      hostListRules: vi.fn(() => []),
      hostRollbackOne: hostRollbackOne as never,
    } })
    await expect(port(current).execute(
      context(),
      'regression-rollback',
      { kind: 'rollback-evolution', ruleId: 'rule-1', expectedVersion: 7 },
      'recovery:4:occurrence-1:regression-rollback',
      new AbortController().signal,
    )).resolves.toMatchObject({ status: 'succeeded', resultCode: 'evolution-rolled-back' })
    expect(hostRollbackOne).toHaveBeenCalledWith(expect.objectContaining({
      ruleId: 'rule-1', expectedVersion: 7,
      operationId: 'recovery:4:occurrence-1:regression-rollback',
    }))
  })

  it('replays one atomic circuit-canary receipt after arm and scheduling commit', async () => {
    const probeCircuitAndScheduleCanary = vi.fn(() => ({
      operationId: 'recovery:4:occurrence-1:incident-review',
      circuit: {
        automationId: 'recovery:sibling', definitionHash: hash('c'),
        state: 'half-open', version: 4,
      },
      occurrenceId: 'occurrence-canary', taskId: 'task-canary', executionMode: 'production' as const,
      replayed: true,
    }))
    const current = runtime({ automations: {
      ...runtime().automations,
      probeCircuitAndScheduleCanary,
    } })
    await expect(port(current).execute(
      context(),
      'incident-review',
      {
        kind: 'probe-automation-circuit', automationId: 'recovery:sibling',
        definitionHash: hash('c'), expectedVersion: 3,
      },
      'recovery:4:occurrence-1:incident-review',
      new AbortController().signal,
    )).resolves.toMatchObject({ status: 'succeeded', resultCode: 'circuit-canary-scheduled' })
    expect(probeCircuitAndScheduleCanary).toHaveBeenCalledWith({
      owner: RECOVERY_SYSTEM_OWNER,
      operationId: 'recovery:4:occurrence-1:incident-review',
      automationId: 'recovery:sibling',
      definitionHash: hash('c'),
      expectedCircuitVersion: 3,
    })
  })

  it('does not reinterpret a valid durable mutation receipt when cancellation races after commit', async () => {
    const controller = new AbortController()
    const hostActivateOne = vi.fn(() => {
      controller.abort(new Error('cancelled after durable commit'))
      return {
        hypothesisId: 'hypothesis-1', expectedVersion: 3, resultVersion: 4, replayed: false,
        ownerGeneration: preferenceOwnerGeneration,
        principalLineageId: principalLineage.principalRecordId,
        principalLineageVersion: principalLineage.principalVersion,
      }
    })
    const current = runtime({ preference: {
      ...runtime().preference,
      hostActivateOne,
    } })
    await expect(port(current).execute(
      context(),
      't1-effects',
      activationAction(),
      'recovery:4:occurrence-1:t1-effects',
      controller.signal,
    )).resolves.toMatchObject({ status: 'succeeded', resultCode: 'preference-activated' })
  })

  it('revalidates the exact live owner route immediately before a mutation', async () => {
    const hostActivateOne = vi.fn()
    const current = runtime({
      delivery: {
        validateOwnerRoute: vi.fn(() => {
          throw Object.assign(new Error('route revoked'), { code: 'missing-binding' })
        }),
      },
      preference: { ...runtime().preference, hostActivateOne },
    })
    await expect(port(current).execute(
      context(),
      't1-effects',
      activationAction(),
      'recovery:4:occurrence-1:t1-effects',
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'missing-binding', sideEffectState: 'none' })
    expect(hostActivateOne).not.toHaveBeenCalled()
  })

  it('rejects a durable activation action after the same external owner id acquires a new row lineage', async () => {
    const hostActivateOne = vi.fn()
    const current = runtime({
      delivery: {
        validateOwnerRoute: vi.fn(input => Object.freeze({
          receiptVersion: 2 as const,
          authorityId: input.authorityId,
          authorityHash: hash('f'),
          principalId: input.principalId,
          principalRecordId: 'principal-row-3',
          principalVersion: 1,
          workspace: input.workspace,
          agentPreset: input.agentPreset,
          bindingVersion: 3,
          generation: 3,
        })),
      },
      preference: { ...runtime().preference, hostActivateOne },
    })

    await expect(port(current).execute(
      context(),
      't1-effects',
      activationAction(),
      'recovery:4:occurrence-1:t1-effects',
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'owner-route-lineage-mismatch', sideEffectState: 'none' })
    expect(hostActivateOne).not.toHaveBeenCalled()
  })

  it('fails closed when the live route resolves to a different stable authority', async () => {
    const hostActivateOne = vi.fn()
    const current = runtime({
      delivery: {
        validateOwnerRoute: vi.fn(input => Object.freeze({
          receiptVersion: 2 as const,
          authorityId: input.authorityId,
          authorityHash: hash('a'),
          principalId: input.principalId,
          principalRecordId: principalLineage.principalRecordId,
          principalVersion: principalLineage.principalVersion,
          workspace: input.workspace,
          agentPreset: input.agentPreset,
          bindingVersion: 2,
          generation: 9,
        })),
      },
      preference: { ...runtime().preference, hostActivateOne },
    })
    await expect(port(current).execute(
      context(),
      't1-effects',
      activationAction(),
      'recovery:4:occurrence-1:t1-effects',
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'owner-route-authority-mismatch', sideEffectState: 'none',
    })
    expect(hostActivateOne).not.toHaveBeenCalled()
  })
})

const learningDigest = 'a'.repeat(64)
const otherDigest = 'b'.repeat(64)
const learningSituation = `goal-definition:${learningDigest}`
const otherSituation = `goal-definition:${otherDigest}`

function learningRuntime(
  episodes: Array<{
    situation: string
    failures: number
    succeeded: number
    total: number
    lastOccurredAt?: number
  }>,
  advice: Array<{
    situation: string
    goalInstances: number
    adviceRuns: number
    distinctRequests: number
  }>,
): RecoveryRuntimePorts {
  return runtime({
    evolution: {
      ...runtime().evolution,
      hostGoalDefinitionEpisodes: vi.fn(() => episodes.map(value => Object.freeze({
        situation: value.situation,
        failures: value.failures,
        succeeded: value.succeeded,
        total: value.total,
        lastOccurredAt: value.lastOccurredAt ?? 4_000,
      }))),
    },
    goals: {
      hostSummarizeAdviceByDefinition: vi.fn(() => advice.map(value => Object.freeze({
        situation: value.situation,
        definitionDigest: value.situation.slice('goal-definition:'.length),
        goalInstances: value.goalInstances,
        adviceRuns: value.adviceRuns,
        distinctRequests: value.distinctRequests,
        requests: Object.freeze([]),
      }))),
    },
  })
}

describe('HostRecoveryRunbookPort strategy-learning (read-only step)', () => {
  it('joins trusted failures with recurring advice and covers observations and frozen floors in both digests', async () => {
    const current = learningRuntime(
      [{ situation: learningSituation, failures: 3, succeeded: 0, total: 3, lastOccurredAt: 4_000 }],
      [{ situation: learningSituation, goalInstances: 2, adviceRuns: 3, distinctRequests: 1 }],
    )
    const adapter = port(current)

    const planned = await adapter.plan(
      context(), 'strategy-learning', new AbortController().signal,
    )
    expect(planned.action).toEqual({ kind: 'observe-strategy-learning' })
    expect(planned.beforeDigest).toMatch(/^[a-f\d]{64}$/u)

    // Goals-side scope is the frozen 5-field GoalScope derived from the owner
    // route receipt, never the evolution scope token.
    expect(current.goals.hostSummarizeAdviceByDefinition).toHaveBeenLastCalledWith({
      principalId: 'lark/main/tenant/owner',
      principalRecordId: 'principal-row-1',
      principalVersion: 1,
      workspace: '/workspace',
      preset: 'owner',
    })
    // Evolution is queried with the canonical branded host scope and a
    // phase-specific operation id.
    expect(current.evolution.hostGoalDefinitionEpisodes).toHaveBeenLastCalledWith(
      expect.objectContaining({
        principal: 'lark/main/tenant/owner',
        scope: { workspace: '/workspace', preset: 'owner' },
        operationId: 'recovery:plan:4:occurrence-1:strategy-learning',
      }),
    )

    await expect(adapter.execute(
      context(),
      'strategy-learning',
      { kind: 'observe-strategy-learning' },
      'recovery:4:occurrence-1:strategy-learning',
      new AbortController().signal,
    )).resolves.toMatchObject({ status: 'succeeded', resultCode: 'strategy-learning-signals' })
    expect(current.evolution.hostGoalDefinitionEpisodes).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operationId: 'recovery:execute:4:occurrence-1:strategy-learning',
      }),
    )
  })

  it('enforces the frozen floors of 3 trusted episodes and 2 repeated advice runs', async () => {
    // 3 trusted failures but only one repeated advice run: observed, yet not
    // flagged as a repeated-and-failing learning signal.
    const oneRepeat = learningRuntime(
      [{ situation: learningSituation, failures: 3, succeeded: 0, total: 3 }],
      [{ situation: learningSituation, goalInstances: 1, adviceRuns: 2, distinctRequests: 1 }],
    )
    await expect(port(oneRepeat).execute(
      context(),
      'strategy-learning',
      { kind: 'observe-strategy-learning' },
      'recovery:4:occurrence-1:strategy-learning',
      new AbortController().signal,
    )).resolves.toMatchObject({ status: 'succeeded', resultCode: 'strategy-learning-observed' })

    // Below the trusted-episode floor, however strongly the advice repeats:
    // nothing is observed at all.
    const belowTrustedFloor = learningRuntime(
      [{ situation: learningSituation, failures: 2, succeeded: 0, total: 2 }],
      [{ situation: learningSituation, goalInstances: 1, adviceRuns: 4, distinctRequests: 1 }],
    )
    const planned = await port(belowTrustedFloor).plan(
      context(), 'strategy-learning', new AbortController().signal,
    )
    expect(planned.action).toEqual({ kind: 'observe-strategy-learning' })
    await expect(port(belowTrustedFloor).execute(
      context(),
      'strategy-learning',
      { kind: 'observe-strategy-learning' },
      'recovery:4:occurrence-1:strategy-learning',
      new AbortController().signal,
    )).resolves.toMatchObject({ status: 'succeeded', resultCode: 'strategy-learning-observed' })
  })

  it('never manufactures an observation from goals-side advice repetition alone', async () => {
    const current = learningRuntime(
      [],
      [{ situation: learningSituation, goalInstances: 2, adviceRuns: 3, distinctRequests: 1 }],
    )
    await expect(port(current).execute(
      context(),
      'strategy-learning',
      { kind: 'observe-strategy-learning' },
      'recovery:4:occurrence-1:strategy-learning',
      new AbortController().signal,
    )).resolves.toMatchObject({ status: 'succeeded', resultCode: 'strategy-learning-observed' })
  })

  it('ignores advice for a different content-bound definition instead of cross-attributing it', async () => {
    const current = learningRuntime(
      [{ situation: learningSituation, failures: 3, succeeded: 0, total: 3 }],
      [{ situation: otherSituation, goalInstances: 2, adviceRuns: 3, distinctRequests: 1 }],
    )
    const planned = await port(current).plan(
      context(), 'strategy-learning', new AbortController().signal,
    )
    // The digest is still a 64-hex receipt, but with zero matching advice the
    // situation cannot be flagged repeated-and-failing.
    expect(planned.beforeDigest).toMatch(/^[a-f\d]{64}$/u)
    await expect(port(current).execute(
      context(),
      'strategy-learning',
      { kind: 'observe-strategy-learning' },
      'recovery:4:occurrence-1:strategy-learning',
      new AbortController().signal,
    )).resolves.toMatchObject({ status: 'succeeded', resultCode: 'strategy-learning-observed' })
  })

  it('fails closed read-only when the live owner route is forbidden, before either ledger is read', async () => {
    const current = learningRuntime(
      [{ situation: learningSituation, failures: 3, succeeded: 0, total: 3 }],
      [{ situation: learningSituation, goalInstances: 2, adviceRuns: 3, distinctRequests: 1 }],
    )
    current.delivery.validateOwnerRoute = vi.fn(() => {
      throw Object.assign(new Error('route forbidden'), { code: 'forbidden' })
    })
    await expect(port(current).plan(
      context(), 'strategy-learning', new AbortController().signal,
    )).rejects.toMatchObject({ code: 'forbidden', sideEffectState: 'none' })
    await expect(port(current).execute(
      context(),
      'strategy-learning',
      { kind: 'observe-strategy-learning' },
      'recovery:4:occurrence-1:strategy-learning',
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'forbidden', sideEffectState: 'none' })
    expect(current.goals.hostSummarizeAdviceByDefinition).not.toHaveBeenCalled()
    expect(current.evolution.hostGoalDefinitionEpisodes).not.toHaveBeenCalled()
  })

  it('fails closed read-only when the goals seam rejects, without querying evolution episodes', async () => {
    const current = learningRuntime(
      [{ situation: learningSituation, failures: 3, succeeded: 0, total: 3 }],
      [],
    )
    current.goals.hostSummarizeAdviceByDefinition = vi.fn(() => {
      throw Object.assign(new Error('not authorized'), { code: 'unauthorized-principal' })
    })
    await expect(port(current).plan(
      context(), 'strategy-learning', new AbortController().signal,
    )).rejects.toMatchObject({ code: 'unauthorized-principal', sideEffectState: 'none' })
    expect(current.evolution.hostGoalDefinitionEpisodes).not.toHaveBeenCalled()
  })

  it('rereads both ledgers at execute time instead of trusting the plan-time snapshot', async () => {
    let episodesVisible = false
    const episodesSeam = vi.fn(() => episodesVisible
      ? [Object.freeze({
        situation: learningSituation, failures: 3, succeeded: 0, total: 3, lastOccurredAt: 4_000,
      })]
      : [])
    const adviceSeam = vi.fn(() => [Object.freeze({
      situation: learningSituation,
      definitionDigest: learningDigest,
      goalInstances: 2, adviceRuns: 3, distinctRequests: 1, requests: Object.freeze([]),
    })])
    const current = runtime({
      evolution: { ...runtime().evolution, hostGoalDefinitionEpisodes: episodesSeam },
      goals: { hostSummarizeAdviceByDefinition: adviceSeam },
    })
    const adapter = port(current)

    // Plan time: the evolution ledger has no trusted episodes yet.
    const plannedEmpty = await adapter.plan(
      context(), 'strategy-learning', new AbortController().signal,
    )
    // Execute time: three trusted failures have since been projected. The
    // receipt must reflect the live read, flagging the signal.
    episodesVisible = true
    const plannedSignals = await adapter.plan(
      context(), 'strategy-learning', new AbortController().signal,
    )
    expect(plannedSignals.beforeDigest).not.toBe(plannedEmpty.beforeDigest)
    await expect(adapter.execute(
      context(),
      'strategy-learning',
      { kind: 'observe-strategy-learning' },
      'recovery:4:occurrence-1:strategy-learning',
      new AbortController().signal,
    )).resolves.toMatchObject({ status: 'succeeded', resultCode: 'strategy-learning-signals' })
    expect(episodesSeam).toHaveBeenCalledTimes(3)
    expect(adviceSeam).toHaveBeenCalledTimes(3)
  })

  it('executes the read-only observation for real in preview mode', async () => {
    const current = learningRuntime(
      [{ situation: learningSituation, failures: 3, succeeded: 0, total: 3 }],
      [{ situation: learningSituation, goalInstances: 2, adviceRuns: 3, distinctRequests: 1 }],
    )
    const configured = job({ activationState: 'preview' })
    const adapter = port(current, configured)
    const previewContext = context({ executionMode: 'preview' })
    const planned = await adapter.plan(
      previewContext, 'strategy-learning', new AbortController().signal,
    )
    expect(planned.action).toEqual({ kind: 'observe-strategy-learning' })
    await expect(adapter.execute(
      previewContext,
      'strategy-learning',
      planned.action,
      'recovery:4:occurrence-1:strategy-learning',
      new AbortController().signal,
    )).resolves.toMatchObject({ status: 'succeeded', resultCode: 'strategy-learning-signals' })
  })
})
