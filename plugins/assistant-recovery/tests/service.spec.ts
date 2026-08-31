import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {
  AutomationRecord,
  HostAutomationDefinition,
  HostAutomationExecutor,
  SystemAutomationReconcileInput,
} from '@dsh-enhanced/assistant-automations'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RECOVERY_CATALOG_DIGEST } from '../src/catalog.ts'
import type { Config, RecoveryJobConfig } from '../src/config.ts'
import {
  AssistantRecoveryService,
  recoveryAutomationId,
} from '../src/service.ts'
import { EMPTY_BOOTSTRAP_ATTESTATION_SET_DIGEST } from '../src/sqlite.ts'
import { RecoveryStore } from '../src/store.ts'

const roots: string[] = []
const contexts: Context[] = []
const principalLineage = Object.freeze({
  principalRecordId: 'principal-row-1',
  principalVersion: 1,
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function config(
  root: string,
  activationState: 'active' | 'paused' | 'preview',
  jobOverrides: Partial<RecoveryJobConfig> = {},
  maxStepDurationMs = 1_000,
): Config {
  return {
    databasePath: join(root, 'recovery.sqlite'),
    maxStepDurationMs,
    jobs: [{
      id: 'supervised-growth', activationState, activationNonce: 'activation-1',
      catalogDigest: RECOVERY_CATALOG_DIGEST,
      workspace: '/workspace', preset: 'owner', principal: 'lark/main/tenant/owner',
      ownerRouteId: 'owner-route', cron: '0 */2 * * *', timezone: 'UTC',
      budgetId: 'growth-runs', budgetAmount: 1,
      ...jobOverrides,
    }],
  }
}

function definitionHash(definition: HostAutomationDefinition): string {
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex')
}

class FakeAutomations {
  executor: HostAutomationExecutor | undefined
  record: AutomationRecord | undefined
  readonly unregister = vi.fn(() => { this.executor = undefined })
  readonly reconciliations: SystemAutomationReconcileInput[] = []
  readonly pauses: Array<{
    owner: string
    operationId: string
    automationId: string
    definitionHash: string
    expectedVersion: number
  }> = []
  readonly runSystemDry = vi.fn(async (input: {
    owner: string
    automationId: string
    definitionHash: string
    idempotencyKey: string
  }) => {
    if (this.executor === undefined || this.record === undefined) throw new Error('executor unavailable')
    const definition = this.record.definition as HostAutomationDefinition
    const result = await this.executor.execute({
      occurrenceId: `preview-${createHash('sha256').update(input.idempotencyKey).digest('hex')}`,
      automationId: input.automationId,
      definitionHash: input.definitionHash,
      executionMode: 'preview',
      targetScope: definition.execution.targetScope,
      principal: definition.principal,
      ownerRouteId: definition.execution.ownerRouteId,
      activationNonce: definition.execution.activationNonce,
      catalogDigest: definition.execution.catalogDigest,
      signal: new AbortController().signal,
    })
    const status = result.outcome === 'succeeded' ? 'succeeded' : result.outcome
    return {
      occurrence: { dryRun: true, status },
      run: { executionMode: 'preview', status },
    } as never
  })

  registerHostExecutor(executor: HostAutomationExecutor): () => void {
    if (this.executor !== undefined) throw new Error('duplicate executor')
    this.executor = executor
    return this.unregister
  }

  reconcileSystem(input: SystemAutomationReconcileInput): AutomationRecord {
    this.reconciliations.push(input)
    const prior = this.record
    const status = input.desiredStatus ?? 'active'
    if (prior?.owner === input.owner && prior.id === input.automationId
      && prior.status === status
      && definitionHash(prior.definition as HostAutomationDefinition)
        === definitionHash(input.definition as HostAutomationDefinition)) {
      return prior
    }
    this.record = Object.freeze({
      id: input.automationId,
      owner: input.owner,
      definition: input.definition,
      status,
      nextRunAt: undefined,
      createdAt: prior?.createdAt ?? 1,
      updatedAt: (prior?.updatedAt ?? 0) + 1,
      version: (prior?.version ?? 0) + 1,
    })
    return this.record
  }

  inspectSystemOwned(input: { owner: string; automationId: string }) {
    if (this.record?.owner !== input.owner || this.record.id !== input.automationId) {
      throw Object.assign(new Error('not found'), { code: 'not-found' })
    }
    return Object.freeze({
      owner: input.owner,
      automationId: input.automationId,
      automationStatus: this.record.status,
      definitionHash: definitionHash(this.record.definition as HostAutomationDefinition),
      definitionVersion: this.record.version,
      latestTerminalRuns: Object.freeze({}),
    })
  }

  listSystemOwned(input: { owner: string; limit?: number }) {
    if (this.record?.owner !== input.owner) return Object.freeze([])
    return Object.freeze([Object.freeze({
      owner: input.owner,
      automationId: this.record.id,
      automationStatus: this.record.status,
      definitionHash: definitionHash(this.record.definition as HostAutomationDefinition),
      definitionVersion: this.record.version,
    })])
  }

  pauseSystemOwned(input: {
    owner: string
    operationId: string
    automationId: string
    definitionHash: string
    expectedVersion: number
  }) {
    this.pauses.push(input)
    if (this.record === undefined || this.record.owner !== input.owner
      || this.record.id !== input.automationId
      || definitionHash(this.record.definition as HostAutomationDefinition) !== input.definitionHash
      || this.record.version !== input.expectedVersion || this.record.status !== 'active') {
      throw Object.assign(new Error('pause conflict'), { code: 'version-conflict' })
    }
    this.record = Object.freeze({
      ...this.record,
      status: 'paused' as const,
      version: this.record.version + 1,
      updatedAt: this.record.updatedAt + 1,
      nextRunAt: undefined,
    })
    return Object.freeze({
      ...input,
      definitionVersion: this.record.version,
      automationStatus: 'paused' as const,
      replayed: false,
    })
  }

  probeCircuitAndScheduleCanary(): never {
    throw new Error('no circuit candidate')
  }

}

function healthReport() {
  return {
    ready: true,
    severity: 'healthy',
    generatedAt: 1,
    providers: [
      'assistantAutomations', 'assistantEvaluation', 'preferenceLearning',
      'assistantEvolution', 'assistantRecovery',
    ].map(id => ({ id, status: 'ready', metrics: {} })),
    assessments: [],
    warnings: [],
  }
}

function context(
  automations: FakeAutomations,
  authorityHash = 'f'.repeat(64),
  bindingVersion = 1,
  generation = 1,
): Context {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('assistantAutomations' as never, automations as never)
  ctx.provide('assistantDelivery' as never, {
    validateOwnerRoute: (input: {
      authorityId: string
      principalId: string
      workspace: string
      agentPreset: string
    }) => Object.freeze({
      receiptVersion: 2 as const,
      authorityId: input.authorityId,
      authorityHash,
      principalId: input.principalId,
      principalRecordId: principalLineage.principalRecordId,
      principalVersion: principalLineage.principalVersion,
      workspace: input.workspace,
      agentPreset: input.agentPreset,
      bindingVersion,
      generation,
    }),
  } as never)
  ctx.provide('assistantEvaluation' as never, {
    health: () => ({ ready: true }),
    peekPendingProjection: () => undefined,
    reconcileProjection: async () => ({
      evaluationId: 'unused', status: 'recorded' as const, attemptCount: 0,
    }),
  } as never)
  ctx.provide('assistantEvolution' as never, {
    hostCandidates: () => [], hostListRules: () => [], hostRollbackOne: () => {},
  } as never)
  ctx.provide('assistantPreferenceLearning' as never, {
    health: () => ({ ready: true }),
    hostActivationCandidate: () => undefined,
    hostActivateOne: () => {},
    hostMaintainOne: () => ({
      deletedSignals: 0,
      replayed: false,
      ownerGeneration: 1,
      principalLineageId: principalLineage.principalRecordId,
      principalLineageVersion: principalLineage.principalVersion,
    }),
    hostOwnerFence: () => ({ ownerGeneration: 1, principalLineage }),
    hostReview: () => ({ hypotheses: [], activeOverlay: undefined }),
  } as never)
  ctx.provide('assistantHealth' as never, { hostGlobalSnapshot: () => healthReport() } as never)
  return ctx
}

describe('AssistantRecoveryService', () => {
  it('runs a model-free preview, records its durable attestation, and leaves the job paused', async () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-service-'))
    roots.push(root)
    const automations = new FakeAutomations()
    const ctx = context(automations)
    await ctx.plugin(AssistantRecoveryService, config(root, 'preview'))
    await ctx.assistantRecovery.whenIdle()

    expect(automations.runSystemDry).toHaveBeenCalledOnce()
    expect(automations.reconciliations.map(value => value.desiredStatus))
      .toEqual(['paused', 'active', 'paused'])
    expect(automations.record).toMatchObject({
      id: recoveryAutomationId('supervised-growth'), status: 'paused',
    })
    expect(automations.record!.definition).toMatchObject({
      schedule: { kind: 'at', at: '9999-12-31T23:59:59.999Z' },
      retrySafety: 'idempotent', maxRetries: 1,
      timeoutMs: 24_000,
      execution: {
        kind: 'host', executorId: 'assistant-recovery', runbookId: 'supervised-growth/v2',
        runbookVersion: 3, catalogDigest: RECOVERY_CATALOG_DIGEST, ownerRouteId: 'owner-route',
      },
    })
    const health = ctx.assistantRecovery.health()
    expect(health).toMatchObject({
      latestProductionStatus: 'none', lastSucceededAt: expect.any(Number),
      bootstrapStatus: 'succeeded',
      bootstrapGeneration: 1,
      bootstrapAttestationValid: true,
      bootstrapAttestationSetDigest: expect.stringMatching(/^[a-f\d]{64}$/u),
      bootstrapAttestations: [{
        automationId: recoveryAutomationId('supervised-growth'),
        activationState: 'preview',
        activationNonce: 'activation-1',
        activationPlanDigest: expect.stringMatching(/^[a-f\d]{64}$/u),
      }],
      bootstrapUpdatedAt: expect.any(Number),
    })
    expect(Object.isFrozen(health.bootstrapAttestations)).toBe(true)
    expect(Object.isFrozen(health.bootstrapAttestations[0])).toBe(true)
  })

  it('publishes every configured job in one canonical bootstrap attestation set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-service-'))
    roots.push(root)
    const automations = new FakeAutomations()
    const input = config(root, 'paused')
    const template = input.jobs![0]!
    input.jobs = [
      { ...template, id: 'zeta', activationNonce: 'nonce-zeta' },
      { ...template, id: 'alpha', activationNonce: 'nonce-alpha' },
    ]
    const ctx = context(automations)
    await ctx.plugin(AssistantRecoveryService, input)
    await ctx.assistantRecovery.whenIdle()

    expect(ctx.assistantRecovery.health()).toMatchObject({
      bootstrapStatus: 'succeeded',
      bootstrapGeneration: 1,
      bootstrapAttestationValid: true,
      bootstrapAttestations: [
        {
          automationId: 'recovery:alpha', activationState: 'paused',
          activationNonce: 'nonce-alpha', activationPlanDigest: expect.stringMatching(/^[a-f\d]{64}$/u),
        },
        {
          automationId: 'recovery:zeta', activationState: 'paused',
          activationNonce: 'nonce-zeta', activationPlanDigest: expect.stringMatching(/^[a-f\d]{64}$/u),
        },
      ],
    })
  })

  it.each([
    ['cron', { cron: '15 */3 * * *' }, 1_000],
    ['timezone', { timezone: 'Asia/Shanghai' }, 1_000],
    ['budget', { budgetAmount: 2 }, 1_000],
    ['step timeout', {}, 2_000],
  ] as const)('rejects activation when the previewed %s plan changes without a new preview', async (
    _field,
    overrides,
    maxStepDurationMs,
  ) => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-service-'))
    roots.push(root)
    const automations = new FakeAutomations()
    const preview = context(automations)
    await preview.plugin(AssistantRecoveryService, config(root, 'preview'))
    await preview.assistantRecovery.whenIdle()
    await preview.fiber.restart()
    contexts.splice(contexts.indexOf(preview), 1)

    const active = context(automations)
    await expect(active.plugin(
      AssistantRecoveryService,
      config(root, 'active', overrides, maxStepDurationMs),
    )).rejects.toMatchObject({ code: 'missing-preview' })
    expect(automations.record).toMatchObject({ status: 'paused' })
  })

  it('requires a new preview when the stable owner-route authority changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-service-'))
    roots.push(root)
    const automations = new FakeAutomations()
    const preview = context(automations, 'f'.repeat(64))
    await preview.plugin(AssistantRecoveryService, config(root, 'preview'))
    await preview.assistantRecovery.whenIdle()
    await preview.fiber.restart()
    contexts.splice(contexts.indexOf(preview), 1)

    const active = context(automations, 'e'.repeat(64))
    await expect(active.plugin(AssistantRecoveryService, config(root, 'active')))
      .rejects.toMatchObject({ code: 'missing-preview' })
    expect(automations.record).toMatchObject({ status: 'paused' })
  })

  it('keeps the preview valid across binding generations for the same stable authority', async () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-service-'))
    roots.push(root)
    const automations = new FakeAutomations()
    const preview = context(automations, 'f'.repeat(64), 1, 1)
    await preview.plugin(AssistantRecoveryService, config(root, 'preview'))
    await preview.assistantRecovery.whenIdle()
    await preview.fiber.restart()
    contexts.splice(contexts.indexOf(preview), 1)

    const active = context(automations, 'f'.repeat(64), 7, 12)
    await active.plugin(AssistantRecoveryService, config(root, 'active'))
    await active.assistantRecovery.whenIdle()
    expect(automations.record).toMatchObject({ status: 'active' })
  })

  it('pauses a previously active definition when its current plan has no matching preview', async () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-service-'))
    roots.push(root)
    const automations = new FakeAutomations()
    const preview = context(automations)
    await preview.plugin(AssistantRecoveryService, config(root, 'preview'))
    await preview.assistantRecovery.whenIdle()
    await preview.fiber.restart()
    contexts.splice(contexts.indexOf(preview), 1)

    const active = context(automations)
    await active.plugin(AssistantRecoveryService, config(root, 'active'))
    await active.assistantRecovery.whenIdle()
    await active.fiber.restart()
    contexts.splice(contexts.indexOf(active), 1)
    expect(automations.record).toMatchObject({ status: 'active' })

    const drifted = context(automations)
    await expect(drifted.plugin(
      AssistantRecoveryService,
      config(root, 'active', { cron: '15 */3 * * *' }),
    )).rejects.toMatchObject({ code: 'missing-preview' })
    expect(automations.record).toMatchObject({ status: 'paused' })
    expect(automations.pauses.at(-1)).toMatchObject({
      operationId: expect.stringMatching(/^recovery-unattested:v1:[a-f\d]{64}$/u),
      automationId: recoveryAutomationId('supervised-growth'),
    })
  })

  it('requires the prior exact preview before activating the production cron', async () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-service-'))
    roots.push(root)
    const automations = new FakeAutomations()
    const preview = context(automations)
    await preview.plugin(AssistantRecoveryService, config(root, 'preview'))
    await preview.assistantRecovery.whenIdle()
    await preview.fiber.restart()
    contexts.splice(contexts.indexOf(preview), 1)

    const active = context(automations)
    await active.plugin(AssistantRecoveryService, config(root, 'active'))
    await active.assistantRecovery.whenIdle()
    expect(automations.runSystemDry).toHaveBeenCalledOnce()
    expect(automations.record).toMatchObject({ status: 'active' })
    expect(automations.record!.definition).toMatchObject({
      schedule: { kind: 'cron', expression: '0 */2 * * *', timezone: 'UTC' },
      budgetId: 'growth-runs', budgetAmount: 1,
    })
  })

  it('pauses and records a content-free control failure when preview dispatch fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-service-'))
    roots.push(root)
    const automations = new FakeAutomations()
    automations.runSystemDry.mockRejectedValueOnce(
      Object.assign(new Error('sensitive upstream detail'), { code: 'policy-denied' }),
    )
    const ctx = context(automations)
    await ctx.plugin(AssistantRecoveryService, config(root, 'preview'))
    await expect(ctx.assistantRecovery.whenIdle()).rejects.toMatchObject({ code: 'policy-denied' })
    expect(automations.record).toMatchObject({ status: 'paused' })
    expect(ctx.assistantRecovery.health()).toMatchObject({
      failedRuns: 1,
      latestProductionStatus: 'none',
      lastFailedAt: expect.any(Number),
      bootstrapStatus: 'failed',
      bootstrapFailureCode: 'policy-denied',
    })
  })

  it('uses a deterministic steady-state reconciliation key across restarts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-service-'))
    roots.push(root)
    const automations = new FakeAutomations()

    for (let index = 0; index < 3; index += 1) {
      const ctx = context(automations)
      await ctx.plugin(AssistantRecoveryService, config(root, 'paused'))
      await ctx.assistantRecovery.whenIdle()
      await ctx.fiber.restart()
      contexts.splice(contexts.indexOf(ctx), 1)
    }

    expect(automations.reconciliations).toHaveLength(3)
    expect(automations.reconciliations[1]!.idempotencyKey)
      .toBe(automations.reconciliations[2]!.idempotencyKey)
    expect(automations.reconciliations[1]!.idempotencyKey).toMatch(/^recovery-reconcile:v1:[a-f\d]{64}$/u)
  })

  it('pauses an active system-owned job after it is removed from Recovery config', async () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-service-'))
    roots.push(root)
    const automations = new FakeAutomations()

    const preview = context(automations)
    await preview.plugin(AssistantRecoveryService, config(root, 'preview'))
    await preview.assistantRecovery.whenIdle()
    await preview.fiber.restart()
    contexts.splice(contexts.indexOf(preview), 1)

    const active = context(automations)
    await active.plugin(AssistantRecoveryService, config(root, 'active'))
    await active.assistantRecovery.whenIdle()
    await active.fiber.restart()
    contexts.splice(contexts.indexOf(active), 1)
    expect(automations.record).toMatchObject({ status: 'active' })

    const removed = context(automations)
    await removed.plugin(AssistantRecoveryService, {
      databasePath: join(root, 'recovery.sqlite'), maxStepDurationMs: 1_000, jobs: [],
    })
    await removed.assistantRecovery.whenIdle()
    expect(automations.record).toMatchObject({ status: 'paused' })
    expect(automations.pauses).toHaveLength(1)
    expect(automations.pauses[0]).toMatchObject({
      owner: 'dsh-enhanced-assistant-recovery',
      automationId: recoveryAutomationId('supervised-growth'),
      definitionHash: expect.stringMatching(/^[a-f\d]{64}$/u),
      expectedVersion: expect.any(Number),
    })
  })

  it('fails closed without creating an active definition when preview proof is absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-service-'))
    roots.push(root)
    const automations = new FakeAutomations()
    const ctx = context(automations)
    await expect(ctx.plugin(AssistantRecoveryService, config(root, 'active')))
      .rejects.toMatchObject({ code: 'missing-preview' })
    expect(automations.record).toBeUndefined()
    expect(automations.executor).toBeUndefined()
  })

  it('clears an older success when constructor fails before route planning', async () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-service-'))
    roots.push(root)
    const path = join(root, 'recovery.sqlite')
    const automations = new FakeAutomations()
    const first = context(automations)
    await first.plugin(AssistantRecoveryService, config(root, 'paused'))
    await first.assistantRecovery.whenIdle()
    expect(first.assistantRecovery.health()).toMatchObject({
      bootstrapStatus: 'succeeded', bootstrapGeneration: 1, bootstrapAttestationValid: true,
    })
    await first.fiber.restart()
    contexts.splice(contexts.indexOf(first), 1)

    const invalidRoute = context(automations, 'not-a-digest')
    await expect(invalidRoute.plugin(AssistantRecoveryService, config(root, 'paused')))
      .rejects.toMatchObject({ code: 'service-unavailable' })
    const store = new RecoveryStore({ path })
    expect(store.health()).toMatchObject({
      bootstrapStatus: 'failed',
      bootstrapFailureCode: 'service-unavailable',
      bootstrapGeneration: 2,
      bootstrapAttestationValid: false,
      bootstrapAttestationSetDigest: EMPTY_BOOTSTRAP_ATTESTATION_SET_DIGEST,
      bootstrapAttestations: [],
    })
    store.close()
  })

  it('retains the exact current attestation when constructor reconciliation fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-service-'))
    roots.push(root)
    const path = join(root, 'recovery.sqlite')
    const automations = new FakeAutomations()
    vi.spyOn(automations, 'reconcileSystem').mockImplementationOnce(() => {
      throw Object.assign(new Error('sensitive policy detail'), { code: 'policy-denied' })
    })
    const ctx = context(automations)
    await expect(ctx.plugin(AssistantRecoveryService, config(root, 'paused')))
      .rejects.toMatchObject({ code: 'policy-denied' })
    expect(automations.unregister).toHaveBeenCalledOnce()
    expect(automations.executor).toBeUndefined()

    const store = new RecoveryStore({ path })
    expect(store.health()).toMatchObject({
      bootstrapStatus: 'failed',
      bootstrapFailureCode: 'policy-denied',
      bootstrapGeneration: 1,
      bootstrapAttestationValid: true,
      bootstrapAttestations: [{
        automationId: recoveryAutomationId('supervised-growth'),
        activationState: 'paused',
        activationNonce: 'activation-1',
        activationPlanDigest: expect.stringMatching(/^[a-f\d]{64}$/u),
      }],
    })
    store.close()
  })

  it('unregisters the Host executor before closing its durable store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-service-'))
    roots.push(root)
    const automations = new FakeAutomations()
    const ctx = context(automations)
    await ctx.plugin(AssistantRecoveryService, config(root, 'paused'))
    await ctx.assistantRecovery.whenIdle()
    await ctx.fiber.restart()
    contexts.splice(contexts.indexOf(ctx), 1)
    expect(automations.unregister).toHaveBeenCalledOnce()
    expect(automations.executor).toBeUndefined()
  })
})
