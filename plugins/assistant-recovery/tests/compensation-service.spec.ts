import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AssistantCompensationService,
  AssistantRecoveryService,
  CompensationLedger,
  RecoveryCompensationError,
  inspectRecoveryOperatorSnapshot,
  normalizeCompensationRequest,
} from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createRecoveryContext(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  const principalLineage = Object.freeze({ principalRecordId: 'principal-row-1', principalVersion: 1 })
  ctx.provide('assistantAutomations' as never, {
    registerHostExecutor: () => () => {},
    reconcileSystem: () => ({ id: 'x', owner: 'recovery', definition: {}, status: 'paused', version: 1, createdAt: 1, updatedAt: 1 }),
    inspectSystemOwned: () => { throw Object.assign(new Error('not found'), { code: 'not-found' }) },
    listSystemOwned: () => [],
    pauseSystemOwned: () => { throw new Error('unused') },
    probeCircuitAndScheduleCanary: () => { throw new Error('unused') },
    runSystemDry: async () => { throw new Error('unused') },
  } as never)
  ctx.provide('assistantDelivery' as never, {
    validateOwnerRoute: (input: { authorityId: string; principalId: string; workspace: string; agentPreset: string }) =>
      Object.freeze({
        receiptVersion: 2 as const,
        authorityId: input.authorityId,
        authorityHash: createHash('sha256').update('auth').digest('hex'),
        principalId: input.principalId,
        principalRecordId: principalLineage.principalRecordId,
        principalVersion: principalLineage.principalVersion,
        workspace: input.workspace,
        agentPreset: input.agentPreset,
        bindingVersion: 1,
        generation: 1,
      }),
  } as never)
  ctx.provide('assistantEvaluation' as never, {
    health: () => ({ ready: true }),
    peekPendingProjection: () => undefined,
    reconcileProjection: async () => ({ evaluationId: 'unused', status: 'recorded', attemptCount: 0 }),
  } as never)
  ctx.provide('assistantEvolution' as never, {
    hostCandidates: () => [],
    hostGoalDefinitionEpisodes: () => [],
    hostListRules: () => [],
    hostRollbackOne: () => {},
  } as never)
  ctx.provide('assistantGoals' as never, {
    hostSummarizeAdviceByDefinition: () => [],
  } as never)
  ctx.provide('assistantPreferenceLearning' as never, {
    health: () => ({ ready: true }),
    hostActivationCandidate: () => undefined,
    hostActivateOne: () => {},
    hostMaintainOne: () => ({ deletedSignals: 0, replayed: false, ownerGeneration: 1, principalLineageId: 'principal-row-1', principalLineageVersion: 1 }),
    hostOwnerFence: () => ({ ownerGeneration: 1, principalLineage }),
    hostReview: () => ({ hypotheses: [], activeOverlay: undefined }),
  } as never)
  ctx.provide('assistantHealth' as never, {
    hostGlobalSnapshot: () => ({ ready: true, severity: 'healthy', generatedAt: 1, providers: [], assessments: [], warnings: [] }),
  } as never)
  return ctx
}

describe('Compensation services in Cordis', () => {
  it('mounts standalone AssistantCompensationService without the 7 supervised-growth peers and recovers on restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-comp-standalone-'))
    roots.push(root)
    const dbPath = join(root, 'comp.sqlite')

    // Seed an incomplete prepared row to verify startup crash recovery.
    const seed = new CompensationLedger({ path: dbPath })
    const seededReq = normalizeCompensationRequest(
      { idempotencyKey: 'crashed-before-restart', kind: 'fs.restore', target: { path: 'a.txt' } },
      'rollback-state',
      Date.now() + 60_000,
    )
    const capturing = seed.prepareCapturing(seededReq).record
    const sealed = seed.sealPrepared(capturing.id, capturing.version, { content: 'old' })
    seed.close()

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(AssistantCompensationService, { databasePath: dbPath })

    const service = ctx.get('assistantCompensation')!
    expect(service).toBeDefined()
    expect(service.getCompensationStatus?.({ id: sealed.id })?.status).toBe('unknown')
    expect(service.getCompensationStatus?.({ id: sealed.id })?.resultCode).toBe('recovery-crash-no-replay')

    const spy = vi.fn(() => ({ status: 'succeeded' as const, resultCode: 'done', receipt: { ok: true } }))
    service.registerCompensator?.({
      kind: 'fs.restore',
      category: 'rollback-state',
      compensate: spy,
    })
    expect(service.hasCompensator('fs.restore')).toBe(true)

    const result = await service.executeCompensation({
      idempotencyKey: 'fresh-run-1',
      kind: 'fs.restore',
      target: { path: 'b.txt' },
    })
    expect(result.status).toBe('succeeded')
    expect(spy).toHaveBeenCalledTimes(1)

    await ctx.fiber.restart()
    expect(ctx.get('assistantCompensation', false)).toBeUndefined()
  })

  it('exposes compensation APIs on AssistantRecoveryService and provides assistantCompensation while active', async () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-comp-svc-'))
    roots.push(root)
    const dbPath = join(root, 'recovery.sqlite')
    const ctx = createRecoveryContext()

    await ctx.plugin(AssistantRecoveryService, { databasePath: dbPath, jobs: [] })
    await ctx.assistantRecovery.whenIdle()

    const provided = ctx.get('assistantCompensation', false)
    expect(provided).toBeDefined()
    expect(typeof provided?.executeCompensation).toBe('function')

    ctx.assistantRecovery.registerCompensator({
      kind: 'lark.undo-msg',
      category: 'notify-undo',
      capturePreimage: () => ({ messageId: 'om_1' }),
      compensate: () => ({ status: 'succeeded', resultCode: 'recalled' }),
    })

    const res = await provided!.executeCompensation({
      idempotencyKey: 'svc-comp-1',
      kind: 'lark.undo-msg',
      target: { messageId: 'om_1' },
      runId: 'skill-run-1',
      stepId: 'step-1',
      sourcePlugin: 'dsh-ray-assistant-skills',
    })
    expect(res.status).toBe('succeeded')
    expect(ctx.assistantRecovery.listCompensations({ runId: 'skill-run-1' })).toHaveLength(1)
    expect(ctx.assistantRecovery.listCompensationAudit(res.id).map(a => a.event)).toEqual([
      'capturing',
      'prepared',
      'dispatched',
      'settled',
    ])

    // Operator snapshot & PRAGMA user_version remain v5.
    const snapshot = inspectRecoveryOperatorSnapshot(dbPath)
    expect(snapshot.schemaVersion).toBe(5)

    const recoveryRef = ctx.assistantRecovery
    await ctx.fiber.restart()
    expect(ctx.get('assistantCompensation', false)).toBeUndefined()
    expect(() => recoveryRef.listCompensations()).toThrowError(
      expect.objectContaining<Partial<RecoveryCompensationError>>({ code: 'disposed' }),
    )
  })
})
