import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostAutomationExecutorInput } from '@dsh-enhanced/assistant-automations'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RecoveryAutomationExecutor } from '../src/automation-executor.ts'
import { RECOVERY_CATALOG_DIGEST } from '../src/catalog.ts'
import type { NormalizedRecoveryJob } from '../src/config.ts'
import { RecoveryExecutor } from '../src/executor.ts'
import {
  HostRecoveryRunbookPort,
  RECOVERY_SYSTEM_OWNER,
  type RecoveryRuntimePorts,
} from '../src/port.ts'
import { RecoveryStore } from '../src/store.ts'

const roots: string[] = []
const hash = (digit: string) => digit.repeat(64)
const automationId = 'recovery:supervised-growth'
const activationPlanDigest = hash('e')
const authorityHash = hash('f')
const principalLineage = Object.freeze({
  principalRecordId: 'principal-row-1',
  principalVersion: 1,
})
const preferenceOwnerGeneration = 1

function job(): NormalizedRecoveryJob {
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
  })
}

function healthReport() {
  return Object.freeze({
    ready: true,
    severity: 'healthy' as const,
    generatedAt: 1,
    providers: Object.freeze([
      'assistantAutomations', 'assistantEvaluation', 'preferenceLearning',
      'assistantEvolution', 'assistantRecovery',
    ].map(id => Object.freeze({ id, status: 'ready' as const, metrics: Object.freeze({}) }))),
    assessments: Object.freeze([]),
    warnings: Object.freeze([]),
  })
}

function executorInput(): HostAutomationExecutorInput {
  return Object.freeze({
    occurrenceId: 'occurrence-resume-1',
    automationId,
    definitionHash: hash('a'),
    executionMode: 'production',
    targetScope: Object.freeze({ workspace: '/workspace', preset: 'owner' }),
    principal: 'lark/main/tenant/owner',
    ownerRouteId: 'owner-route',
    activationNonce: 'activation-1',
    catalogDigest: RECOVERY_CATALOG_DIGEST,
    signal: new AbortController().signal,
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Recovery durable Host resume integration', () => {
  it('reuses the exact sink receipt after commit-before-step-receipt crash even when learning is paused', async () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-resume-'))
    roots.push(root)
    const path = join(root, 'recovery.sqlite')
    let candidatePending = true
    let preferencePaused = false
    const activationReceipts = new Map<string, Readonly<{
      hypothesisId: string
      expectedVersion: number
      resultVersion: number
      ownerGeneration: number
      principalLineageId: string
      principalLineageVersion: number
    }>>()
    const activationCalls: Array<Readonly<{ operationId: string; replayed: boolean }>> = []
    const hostActivationCandidate = vi.fn(() => candidatePending
      ? Object.freeze({
          hypothesisId: 'hypothesis-1',
          expectedVersion: 3,
          ownerGeneration: preferenceOwnerGeneration,
          principalLineage,
        })
      : undefined)
    const hostActivateOne = vi.fn((input: {
      operationId: string
      hypothesisId: string
      expectedVersion: number
      ownerGeneration: number
      principalLineage: typeof principalLineage
    }) => {
      const prior = activationReceipts.get(input.operationId)
      const replayed = prior !== undefined
      if (!replayed && preferencePaused) throw new Error('preference learning is paused')
      const receipt = prior ?? Object.freeze({
        hypothesisId: input.hypothesisId,
        expectedVersion: input.expectedVersion,
        resultVersion: input.expectedVersion + 1,
        ownerGeneration: input.ownerGeneration,
        principalLineageId: input.principalLineage.principalRecordId,
        principalLineageVersion: input.principalLineage.principalVersion,
      })
      if (!replayed) {
        activationReceipts.set(input.operationId, receipt)
        candidatePending = false
      }
      activationCalls.push(Object.freeze({ operationId: input.operationId, replayed }))
      return Object.freeze({ ...receipt, replayed })
    })
    const runtime: RecoveryRuntimePorts = {
      automations: {
        inspectSystemOwned: vi.fn(() => Object.freeze({
          owner: RECOVERY_SYSTEM_OWNER,
          automationId,
          automationStatus: 'active' as const,
          definitionHash: hash('a'),
          definitionVersion: 1,
          latestTerminalRuns: Object.freeze({}),
        })),
      },
      delivery: {
        validateOwnerRoute: vi.fn(input => Object.freeze({
          receiptVersion: 2 as const,
          authorityId: input.authorityId,
          authorityHash,
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
        peekPendingProjection: vi.fn(() => undefined),
        reconcileProjection: vi.fn(),
      },
      evolution: {
        hostCandidates: vi.fn(() => []),
        hostListRules: vi.fn(() => []),
        hostRollbackOne: vi.fn(),
      },
      preference: {
        health: vi.fn(() => ({ ready: true } as never)),
        hostActivationCandidate: hostActivationCandidate as never,
        hostActivateOne: hostActivateOne as never,
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
        hostReview: vi.fn(() => ({ hypotheses: [], activeOverlay: undefined } as never)),
      },
      health: {
        hostGlobalSnapshot: vi.fn(() => healthReport() as never),
      },
    }
    const makePort = () => new HostRecoveryRunbookPort(
      new Map([[automationId, job()]]),
      runtime,
      new Map([[automationId, activationPlanDigest]]),
      new Map([[automationId, authorityHash]]),
    )
    const makeExecutor = (store: RecoveryStore) => new RecoveryAutomationExecutor(
      new RecoveryExecutor(store, makePort(), 1_000),
      () => activationPlanDigest,
    )

    const firstStore = new RecoveryStore({ path, now: () => 1_000 })
    const originalCompleteStep = firstStore.completeStep.bind(firstStore)
    let injected = false
    const settlement = vi.spyOn(firstStore, 'completeStep').mockImplementation((input) => {
      if (!injected && input.stepId === 't1-effects') {
        injected = true
        throw new Error('injected crash after durable preference activation')
      }
      return originalCompleteStep(input)
    })
    await expect(makeExecutor(firstStore).execute(executorInput()))
      .rejects.toThrow(/crash after durable preference activation/u)
    const startedRun = firstStore.getRunByOccurrence('occurrence-resume-1')!
    expect(firstStore.getStep(startedRun.id, 't1-effects')).toMatchObject({
      status: 'started',
      action: {
        kind: 'activate-preference',
        hypothesisId: 'hypothesis-1',
        expectedVersion: 3,
        ownerGeneration: preferenceOwnerGeneration,
        principalLineage,
      },
      idempotencyKey: 'recovery:3:occurrence-resume-1:t1-effects',
    })
    settlement.mockRestore()
    firstStore.close()

    // The owner pauses learning after the Preference mutation committed but
    // before Recovery could persist its outer step receipt. Recovery must use
    // the same exact operation/fence and receive the durable replay rather
    // than treating the already-applied effect as ambiguous.
    preferencePaused = true
    const restartedStore = new RecoveryStore({ path, now: () => 2_000 })
    await expect(makeExecutor(restartedStore).execute(executorInput())).resolves.toMatchObject({
      outcome: 'succeeded',
      sideEffectState: 'possible',
      retryability: 'unsafe',
    })
    expect(hostActivationCandidate).toHaveBeenCalledOnce()
    expect(activationCalls).toEqual([
      { operationId: 'recovery:3:occurrence-resume-1:t1-effects', replayed: false },
      { operationId: 'recovery:3:occurrence-resume-1:t1-effects', replayed: true },
    ])
    expect(restartedStore.getRunByOccurrence('occurrence-resume-1')).toMatchObject({
      status: 'succeeded', resultCode: 'runbook-complete',
    })
    restartedStore.close()
  })

  it('replays the persisted maintenance owner fence after a commit-before-step-receipt crash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-maintenance-resume-'))
    roots.push(root)
    const path = join(root, 'recovery.sqlite')
    const maintenanceReceipts = new Map<string, Readonly<{
      deletedSignals: number
      ownerGeneration: number
      principalLineageId: string
      principalLineageVersion: number
    }>>()
    const maintenanceCalls: Array<Readonly<{ operationId: string; replayed: boolean }>> = []
    const hostOwnerFence = vi.fn(() => Object.freeze({
      ownerGeneration: preferenceOwnerGeneration,
      principalLineage,
    }))
    const hostMaintainOne = vi.fn((input: {
      operationId: string
      ownerGeneration?: number
      principalLineage: typeof principalLineage
    }) => {
      const prior = maintenanceReceipts.get(input.operationId)
      const replayed = prior !== undefined
      const receipt = prior ?? Object.freeze({
        deletedSignals: 1,
        ownerGeneration: input.ownerGeneration!,
        principalLineageId: input.principalLineage.principalRecordId,
        principalLineageVersion: input.principalLineage.principalVersion,
      })
      if (!replayed) maintenanceReceipts.set(input.operationId, receipt)
      maintenanceCalls.push(Object.freeze({ operationId: input.operationId, replayed }))
      return Object.freeze({ ...receipt, replayed })
    })
    const runtime: RecoveryRuntimePorts = {
      automations: {
        inspectSystemOwned: vi.fn(() => Object.freeze({
          owner: RECOVERY_SYSTEM_OWNER,
          automationId,
          automationStatus: 'active' as const,
          definitionHash: hash('a'),
          definitionVersion: 1,
          latestTerminalRuns: Object.freeze({}),
        })),
      },
      delivery: {
        validateOwnerRoute: vi.fn(input => Object.freeze({
          receiptVersion: 2 as const,
          authorityId: input.authorityId,
          authorityHash,
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
        peekPendingProjection: vi.fn(() => undefined),
        reconcileProjection: vi.fn(),
      },
      evolution: {
        hostCandidates: vi.fn(() => []),
        hostListRules: vi.fn(() => []),
        hostRollbackOne: vi.fn(),
      },
      preference: {
        health: vi.fn(() => ({ ready: true } as never)),
        hostActivationCandidate: vi.fn(() => undefined),
        hostActivateOne: vi.fn(),
        hostMaintainOne: hostMaintainOne as never,
        hostOwnerFence: hostOwnerFence as never,
        hostReview: vi.fn(() => ({ hypotheses: [], activeOverlay: undefined } as never)),
      },
      health: {
        hostGlobalSnapshot: vi.fn(() => healthReport() as never),
      },
    }
    const makePort = () => new HostRecoveryRunbookPort(
      new Map([[automationId, job()]]),
      runtime,
      new Map([[automationId, activationPlanDigest]]),
      new Map([[automationId, authorityHash]]),
    )
    const makeExecutor = (store: RecoveryStore) => new RecoveryAutomationExecutor(
      new RecoveryExecutor(store, makePort(), 1_000),
      () => activationPlanDigest,
    )

    const firstStore = new RecoveryStore({ path, now: () => 1_000 })
    const originalCompleteStep = firstStore.completeStep.bind(firstStore)
    let injected = false
    const settlement = vi.spyOn(firstStore, 'completeStep').mockImplementation((input) => {
      if (!injected && input.stepId === 'retention-maintenance') {
        injected = true
        throw new Error('injected crash after durable preference maintenance')
      }
      return originalCompleteStep(input)
    })
    await expect(makeExecutor(firstStore).execute(executorInput()))
      .rejects.toThrow(/crash after durable preference maintenance/u)
    const startedRun = firstStore.getRunByOccurrence('occurrence-resume-1')!
    expect(firstStore.getStep(startedRun.id, 'retention-maintenance')).toMatchObject({
      status: 'started',
      action: {
        kind: 'maintain-preferences',
        limit: 1,
        ownerGeneration: preferenceOwnerGeneration,
        principalLineage,
      },
      idempotencyKey: 'recovery:3:occurrence-resume-1:retention-maintenance',
    })
    settlement.mockRestore()
    firstStore.close()

    const restartedStore = new RecoveryStore({ path, now: () => 2_000 })
    await expect(makeExecutor(restartedStore).execute(executorInput())).resolves.toMatchObject({
      outcome: 'succeeded',
      sideEffectState: 'possible',
      retryability: 'unsafe',
    })
    expect(hostOwnerFence).toHaveBeenCalledOnce()
    expect(maintenanceCalls).toEqual([
      { operationId: 'recovery:3:occurrence-resume-1:retention-maintenance', replayed: false },
      { operationId: 'recovery:3:occurrence-resume-1:retention-maintenance', replayed: true },
    ])
    expect(restartedStore.getRunByOccurrence('occurrence-resume-1')).toMatchObject({
      status: 'succeeded', resultCode: 'runbook-complete',
    })
    restartedStore.close()
  })
})
