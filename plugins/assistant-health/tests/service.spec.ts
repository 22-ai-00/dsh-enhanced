import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PreferenceLearningService } from '@dsh-enhanced/preference-learning'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  HOST_RECOVERY_BACKGROUND_ID,
  AssistantHealthError,
  AssistantHealthService,
} from '../src/service.ts'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class FakePolicy extends Service {
  allow = true
  emergencyStop = false
  requests: unknown[] = []
  constructor(ctx: Context) { super(ctx, 'assistantPolicy') }
  authorizeAgent() { return { effect: this.allow ? 'allow' : 'deny', reasonCode: this.allow ? 'rule-allow' : 'default-deny' } }
  authorize(request: unknown) {
    this.requests.push(request)
    return { effect: this.allow ? 'allow' : 'deny', reasonCode: this.allow ? 'rule-allow' : 'default-deny' }
  }
  health() { return { emergencyStop: this.emergencyStop, lastAuditSequence: 12, secret: 'SENTINEL-POLICY' } }
}

class Provider extends Service {
  constructor(ctx: Context, name: string, private readonly result: unknown, private readonly failure = false) { super(ctx, name) }
  health() { if (this.failure) throw new Error('SENTINEL-FAILURE'); return this.result }
}

class FakeSystemPrompt extends Service {
  constructor(ctx: Context) { super(ctx, 'systemPrompt') }
  context() { return () => {} }
}

function agent(): Agent { return { session: { header: { cwd: '/work/alpha', agentPreset: 'primary' } } } as unknown as Agent }

function harness(options: {
  missingWiki?: boolean
  failingDelivery?: boolean
  allow?: boolean
  larkState?: string
  emergencyStop?: boolean
  failedRuns?: number
  unknownRuns?: number
  failedEvaluationAttempts?: number
  deadLetterEvaluations?: number
  deadLetterInbox?: number
  unknownOutbox?: number
  deadLetterOutbox?: number
  actionableDeadLetterInbox?: number
  actionableDeadLetterOutbox?: number
  actionableUnknownOutbox?: number
  resolvedDeadLetterInbox?: number
  resolvedDeadLetterOutbox?: number
  resolvedUnknownOutbox?: number
  legacyDeliveryHealth?: boolean
  legacyPresentationHealth?: boolean
  pendingPresentations?: number
  deadPresentations?: number
  openCircuits?: number
  openIncidents?: number
  pendingIncidentAlerts?: number
  recoveryHealth?: unknown
  growthExperimentsHealth?: unknown
  controlPlaneHealth?: unknown
  conflictedProposals?: number
  failedLeases?: number
  preferenceEnabled?: boolean
  requiredProviders?: Array<'assistantPolicy' | 'personalMemory' | 'personalWiki' | 'assistantAutomations'
    | 'assistantEvaluation' | 'preferenceLearning' | 'assistantEvolution' | 'assistantRecovery'
    | 'assistantGrowthExperiments' | 'pluginControlPlane' | 'larkChannel'>
} = {}) {
  const ctx = new Context(); contexts.push(ctx)
  const policy = new FakePolicy(ctx); policy.allow = options.allow ?? true
  policy.emergencyStop = options.emergencyStop ?? false
  new Provider(ctx, 'personalMemory', { activeRecords: 3, removedRecords: 1, expiredRecords: 0,
    pendingProposals: 2, content: 'SENTINEL-MEMORY' })
  if (!options.missingWiki) new Provider(ctx, 'personalWiki', { pages: 4, lintErrors: 0, lintWarnings: 1,
    pendingProposals: 0, vaultPath: '/secret/path' })
  new Provider(ctx, 'assistantAutomations', { activeAutomations: 2, pausedAutomations: 1,
    pendingTasks: 3, runningTasks: 0, failedRuns: options.failedRuns ?? 0,
    unknownRuns: options.unknownRuns ?? 0, pendingEvaluations: 2, retryingEvaluations: 1,
    failedEvaluationAttempts: options.failedEvaluationAttempts ?? 0,
    deadLetterEvaluations: options.deadLetterEvaluations ?? 0, oldestPendingEvaluationAt: 119_000,
    ...(options.openCircuits === undefined ? {} : { openCircuits: options.openCircuits }),
    ...(options.openIncidents === undefined ? {} : { openIncidents: options.openIncidents }),
    ...(options.pendingIncidentAlerts === undefined
      ? {} : { pendingIncidentAlerts: options.pendingIncidentAlerts }) })
  new Provider(ctx, 'assistantEvaluation', { ready: true, schemaVersion: 2, outcomes: 11,
    trustedOutcomes: 9, selfReportedOutcomes: 1, externalOutcomes: 1, selfAssessments: 3,
    latestOccurredAt: 122_000, databasePath: '/secret/evaluation.sqlite', content: 'SENTINEL-EVALUATION' })
  new Provider(ctx, 'assistantPreferenceLearning', { ready: true, enabled: options.preferenceEnabled ?? true,
    schemaVersion: 1, signals: 7,
    hypotheses: 3, active: 1, shadow: 2, proposed: 0, rolledBack: 1, expired: 0,
    lastRecordedAt: 122_500, workspace: '/secret/preference', value: 'SENTINEL-PREFERENCE' })
  new Provider(ctx, 'assistantEvolution', { activeRules: 2, retiredRules: 1, pendingProposals: 1,
    conflictedProposals: options.conflictedProposals ?? 0, trustedEpisodes: 9,
    qualityEligibleEpisodes: 4, operationalEpisodes: 5, legacyQuarantinedEpisodes: 2,
    unattributedTrustedEpisodes: 4, lastTrustedEpisodeAt: 120_000, lastReconciledAt: 121_000,
    unattributedQualityEligibleEpisodes: 1, lastQualityEligibleEpisodeAt: 119_000,
    autonomousRollbacks: 1,
    scope: 'SENTINEL-EVOLUTION-SCOPE', guidance: 'SENTINEL-EVOLUTION-GUIDANCE' })
  const deadLetterInbox = options.deadLetterInbox ?? 0
  const deadLetterOutbox = options.deadLetterOutbox ?? 0
  const unknownOutbox = options.unknownOutbox ?? 0
  const deliveryResolutionMetrics = options.legacyDeliveryHealth ? {} : {
    actionableDeadLetterInbox: options.actionableDeadLetterInbox ?? deadLetterInbox,
    resolvedDeadLetterInbox: options.resolvedDeadLetterInbox ?? 0,
    actionableDeadLetterOutbox: options.actionableDeadLetterOutbox ?? deadLetterOutbox,
    resolvedDeadLetterOutbox: options.resolvedDeadLetterOutbox ?? 0,
    actionableUnknownOutbox: options.actionableUnknownOutbox ?? unknownOutbox,
    resolvedUnknownOutbox: options.resolvedUnknownOutbox ?? 0,
  }
  new Provider(ctx, 'assistantDelivery', { pendingInbox: 0, deadLetterInbox, pendingOutbox: 2,
    deadLetterOutbox, unknownOutbox, adapters: 1, ...deliveryResolutionMetrics,
    ...(options.legacyPresentationHealth ? {} : {
      pendingPresentations: options.pendingPresentations ?? 0,
      deadPresentations: options.deadPresentations ?? 0,
    }),
    rawMessage: 'SENTINEL' }, options.failingDelivery)
  new Provider(ctx, 'credentialsKeychain', { handles: 2, activeLeases: 0,
    failedLeases: options.failedLeases ?? 0 })
  new Provider(ctx, 'eventTriggers', { pendingEvents: 1, deliveredEvents: 9, triggersObserved: 2 })
  new Provider(ctx, 'assistantHeartbeat', { active: 1, paused: 1, empty: 1 })
  if (options.recoveryHealth !== undefined) new Provider(ctx, 'assistantRecovery', options.recoveryHealth)
  if (options.growthExperimentsHealth !== undefined) {
    new Provider(ctx, 'assistantGrowthExperiments', options.growthExperimentsHealth)
  }
  if (options.controlPlaneHealth !== undefined) {
    new Provider(ctx, 'pluginControlPlane', options.controlPlaneHealth)
  }
  new Provider(ctx, 'larkChannel', { state: options.larkState ?? 'connected', gapGeneration: 2, tenant: 'SENTINEL' })
  const service = new AssistantHealthService(ctx, {
    requiredProviders: options.requiredProviders
      ?? ['assistantPolicy', 'personalMemory', 'personalWiki', 'assistantAutomations'],
  }, { now: () => 123_000 })
  return { ctx, policy, service }
}

describe('assistant health service', () => {
  test('Host global snapshot is content-free, unscoped, and background Policy-authorized', () => {
    const { policy, service } = harness({
      openCircuits: 2, openIncidents: 1, pendingIncidentAlerts: 1,
      recoveryHealth: {
        runningRuns: 1, failedRuns: 3, unknownRuns: 1, incompleteSteps: 2,
        staleRuns: 0, staleSteps: 0,
        lastSucceededAt: 120_000, lastFailedAt: 122_000,
        latestProductionStatus: 'failed', consecutiveProductionFailures: 2,
        lastProductionRunAt: 122_000,
        incidentText: 'SENTINEL-RECOVERY-INCIDENT',
      },
    })
    const snapshot = service.hostGlobalSnapshot({
      principal: 'owner:lark:123', operationId: 'growth-run:health:1',
    })

    expect(policy.requests).toContainEqual({
      subject: {
        kind: 'background', id: HOST_RECOVERY_BACKGROUND_ID,
        principal: 'owner:lark:123',
      },
      action: 'inspect', resource: { kind: 'tool', id: 'assistant-health:global' },
      context: { initiator: 'background' },
    })
    expect(snapshot).toMatchObject({
      ready: true,
      severity: 'degraded',
      assessments: expect.arrayContaining([
        { providerId: 'assistantAutomations', severity: 'degraded', code: 'open-circuit-backlog' },
        { providerId: 'assistantAutomations', severity: 'degraded', code: 'open-incident-backlog' },
        { providerId: 'assistantAutomations', severity: 'degraded', code: 'pending-incident-alerts' },
        { providerId: 'assistantRecovery', severity: 'degraded', code: 'incomplete-recovery' },
      ]),
      providers: expect.arrayContaining([
        expect.objectContaining({ id: 'assistantAutomations', metrics: expect.objectContaining({
          openCircuits: 2, openIncidents: 1, pendingIncidentAlerts: 1,
        }) }),
        { id: 'assistantRecovery', status: 'ready', metrics: {
          runningRuns: 1, failedRuns: 3, unknownRuns: 1, incompleteSteps: 2,
          staleRuns: 0, staleSteps: 0,
          lastSucceededAt: 120_000, lastFailedAt: 122_000,
          latestProductionStatus: 'failed', consecutiveProductionFailures: 2,
          lastProductionRunAt: 122_000,
        } },
      ]),
    })
    expect(JSON.stringify(snapshot)).not.toMatch(/SENTINEL|incidentText/iu)
    for (const workspace of ['/work/alpha', '/work/beta']) {
      expect(() => service.hostGlobalSnapshot({
        scope: { workspace, preset: 'primary' },
        principal: 'owner:lark:123', operationId: `growth-run:health:forged:${workspace}`,
      } as never)).toThrowError(expect.objectContaining<Partial<AssistantHealthError>>({
        code: 'invalid-input',
      }))
    }
  })

  test('accepts Automations N-1 without circuit metrics and fails closed on malformed N', () => {
    expect(harness().service.readiness()).toEqual({ ready: true, warnings: [] })
    const invalid = harness({ openCircuits: -1 })
    expect(invalid.service.readiness()).toEqual({
      ready: false,
      warnings: ['provider-error:assistantAutomations'],
    })
  })

  test('accepts Automations incident projection only as an all-or-none N/N-1 pair', () => {
    const current = harness({ openIncidents: 2, pendingIncidentAlerts: 1 })
    expect(current.service.report(agent())).toMatchObject({
      severity: 'degraded',
      assessments: expect.arrayContaining([
        { providerId: 'assistantAutomations', severity: 'degraded', code: 'open-incident-backlog' },
        { providerId: 'assistantAutomations', severity: 'degraded', code: 'pending-incident-alerts' },
      ]),
    })
    const partial = harness({ openIncidents: 1 })
    expect(partial.service.report(agent()).providers).toContainEqual({
      id: 'assistantAutomations', status: 'error', metrics: {},
    })
  })

  test('treats Recovery as optional and validates its base and production projections independently', () => {
    expect(harness().service.report(agent()).providers).toContainEqual({
      id: 'assistantRecovery', status: 'missing', metrics: {},
    })
    const partial = harness({ recoveryHealth: {
      runningRuns: 0, failedRuns: 0, unknownRuns: 0, incompleteSteps: 0,
    } })
    expect(partial.service.report(agent()).providers).toContainEqual({
      id: 'assistantRecovery', status: 'error', metrics: {},
    })
    expect(partial.service.readiness().warnings).toContain(
      'provider-degraded:assistantRecovery:health-seam-error',
    )

    const partialProduction = harness({ recoveryHealth: {
      runningRuns: 0, failedRuns: 1, unknownRuns: 0, incompleteSteps: 0,
      lastSucceededAt: 120_000, lastFailedAt: 121_000,
      latestProductionStatus: 'succeeded',
    } })
    expect(partialProduction.service.report(agent()).providers).toContainEqual({
      id: 'assistantRecovery', status: 'error', metrics: {},
    })

    const malformedProduction = harness({ recoveryHealth: {
      runningRuns: 0, failedRuns: 1, unknownRuns: 0, incompleteSteps: 0,
      lastSucceededAt: 120_000, lastFailedAt: 121_000,
      latestProductionStatus: 'preview', consecutiveProductionFailures: 0,
      lastProductionRunAt: 122_000,
    } })
    expect(malformedProduction.service.report(agent()).providers).toContainEqual({
      id: 'assistantRecovery', status: 'error', metrics: {},
    })
  })

  test('Recovery health ignores lifetime failures and assesses only current production state', () => {
    const legacy = harness({ recoveryHealth: {
      runningRuns: 0, failedRuns: 7, unknownRuns: 3, incompleteSteps: 0,
      staleRuns: 0, staleSteps: 0,
      lastSucceededAt: 122_000, lastFailedAt: 120_000,
    } })
    expect(legacy.service.report(agent()).assessments).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ providerId: 'assistantRecovery' }),
    ]))

    const succeeded = harness({ recoveryHealth: {
      runningRuns: 0, failedRuns: 7, unknownRuns: 3, incompleteSteps: 0,
      staleRuns: 0, staleSteps: 0,
      lastSucceededAt: 122_000, lastFailedAt: 120_000,
      latestProductionStatus: 'succeeded', consecutiveProductionFailures: 0,
      lastProductionRunAt: 122_000,
    } })
    expect(succeeded.service.report(agent()).assessments).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ providerId: 'assistantRecovery' }),
    ]))

    for (const latestProductionStatus of ['failed', 'unknown'] as const) {
      const currentFailure = harness({ recoveryHealth: {
        runningRuns: 0, failedRuns: 7, unknownRuns: 3, incompleteSteps: 0,
        staleRuns: 0, staleSteps: 0,
        lastSucceededAt: 119_000, lastFailedAt: 122_000,
        latestProductionStatus, consecutiveProductionFailures: 2,
        lastProductionRunAt: 122_000,
      } })
      expect(currentFailure.service.report(agent()).assessments).toContainEqual({
        providerId: 'assistantRecovery', severity: 'degraded', code: 'incomplete-recovery',
      })
    }
  })

  test('Recovery bootstrap failure blocks readiness while active work is not self-degraded', () => {
    const active = harness({ recoveryHealth: {
      runningRuns: 1, failedRuns: 0, unknownRuns: 0, incompleteSteps: 1,
      staleRuns: 0, staleSteps: 0,
      lastSucceededAt: 0, lastFailedAt: 0,
      bootstrapStatus: 'running', bootstrapUpdatedAt: 122_000,
    } })
    expect(active.service.report(agent())).toMatchObject({
      ready: true,
      assessments: [{ providerId: 'assistantRecovery', severity: 'degraded', code: 'bootstrap-in-progress' }],
    })

    const failed = harness({
      requiredProviders: ['assistantRecovery'],
      recoveryHealth: {
        runningRuns: 0, failedRuns: 0, unknownRuns: 0, incompleteSteps: 0,
        staleRuns: 0, staleSteps: 0,
        lastSucceededAt: 0, lastFailedAt: 0,
        bootstrapStatus: 'failed', bootstrapFailureCode: 'preview-failed', bootstrapUpdatedAt: 122_000,
      },
    })
    expect(failed.service.readiness()).toEqual({
      ready: false,
      warnings: ['provider-unhealthy:assistantRecovery:bootstrap-failed'],
    })

    const partial = harness({ recoveryHealth: {
      runningRuns: 0, failedRuns: 0, unknownRuns: 0, incompleteSteps: 0,
      lastSucceededAt: 0, lastFailedAt: 0, bootstrapStatus: 'succeeded',
    } })
    expect(partial.service.report(agent()).providers).toContainEqual({
      id: 'assistantRecovery', status: 'error', metrics: {},
    })
  })

  test('projects exact Recovery bootstrap attestation atomically without exposing its job tuples', () => {
    const digest = 'a'.repeat(64)
    const exact = harness({
      requiredProviders: ['assistantRecovery'],
      recoveryHealth: {
        runningRuns: 0, failedRuns: 0, unknownRuns: 0, incompleteSteps: 0,
        staleRuns: 0, staleSteps: 0,
        lastSucceededAt: 122_000, lastFailedAt: 0,
        bootstrapStatus: 'succeeded', bootstrapUpdatedAt: 122_000,
        bootstrapGeneration: 7, bootstrapAttestationValid: true,
        bootstrapAttestationSetDigest: digest,
        bootstrapAttestations: [{
          automationId: 'SENTINEL-RECOVERY-JOB', activationState: 'active',
          activationNonce: 'SENTINEL-NONCE', activationPlanDigest: digest,
        }],
      },
    })
    const report = exact.service.report(agent())
    expect(report.providers).toContainEqual({
      id: 'assistantRecovery', status: 'ready', metrics: {
        runningRuns: 0, failedRuns: 0, unknownRuns: 0, incompleteSteps: 0,
        staleRuns: 0, staleSteps: 0,
        lastSucceededAt: 122_000, lastFailedAt: 0,
        bootstrapStatus: 'succeeded', bootstrapGeneration: 7,
        bootstrapAttestationValid: true, bootstrapAttestationSetDigest: digest,
        bootstrapUpdatedAt: 122_000,
      },
    })
    expect(JSON.stringify(report)).not.toMatch(/SENTINEL-RECOVERY-JOB|SENTINEL-NONCE/u)
    expect(exact.service.readiness()).toEqual({ ready: true, warnings: [] })

    const invalid = harness({
      requiredProviders: ['assistantRecovery'],
      recoveryHealth: {
        runningRuns: 0, failedRuns: 0, unknownRuns: 0, incompleteSteps: 0,
        staleRuns: 0, staleSteps: 0,
        lastSucceededAt: 122_000, lastFailedAt: 0,
        bootstrapStatus: 'succeeded', bootstrapUpdatedAt: 122_000,
        bootstrapGeneration: 8, bootstrapAttestationValid: false,
        bootstrapAttestationSetDigest: digest, bootstrapAttestations: [],
      },
    })
    expect(invalid.service.readiness()).toEqual({
      ready: false,
      warnings: ['provider-unhealthy:assistantRecovery:bootstrap-attestation-invalid'],
    })

    const partial = harness({ recoveryHealth: {
      runningRuns: 0, failedRuns: 0, unknownRuns: 0, incompleteSteps: 0,
      staleRuns: 0, staleSteps: 0,
      lastSucceededAt: 122_000, lastFailedAt: 0,
      bootstrapStatus: 'succeeded', bootstrapUpdatedAt: 122_000,
      bootstrapGeneration: 9, bootstrapAttestationValid: true,
    } })
    expect(partial.service.report(agent()).providers).toContainEqual({
      id: 'assistantRecovery', status: 'error', metrics: {},
    })
  })

  test('Recovery degrades only durable intents whose persisted deadlines are stale', () => {
    const value = harness({ recoveryHealth: {
      runningRuns: 1, failedRuns: 0, unknownRuns: 0, incompleteSteps: 1,
      staleRuns: 1, staleSteps: 1,
      lastSucceededAt: 0, lastFailedAt: 0,
    } })
    expect(value.service.report(agent()).assessments).toContainEqual({
      providerId: 'assistantRecovery', severity: 'degraded', code: 'stale-recovery-intent',
    })
  })

  test('projects Evaluation retry backlog atomically and degrades only actionable retries', () => {
    const ctx = new Context(); contexts.push(ctx)
    new FakePolicy(ctx)
    new Provider(ctx, 'assistantEvaluation', {
      ready: true, schemaVersion: 3, outcomes: 2, trustedOutcomes: 2,
      selfReportedOutcomes: 0, externalOutcomes: 0, selfAssessments: 0,
      pendingProjections: 1, retryingProjections: 1, projectionAttempts: 2,
      oldestPendingProjectionAt: 120_000,
    })
    const service = new AssistantHealthService(ctx, { requiredProviders: ['assistantEvaluation'] })
    expect(service.report(agent())).toMatchObject({
      ready: true,
      assessments: [{ providerId: 'assistantEvaluation', severity: 'degraded', code: 'projection-retry-backlog' }],
      providers: expect.arrayContaining([expect.objectContaining({
        id: 'assistantEvaluation', metrics: expect.objectContaining({ pendingProjections: 1, projectionAttempts: 2 }),
      })]),
    })
  })

  test('surfaces task-level owner judgement conflicts without exposing the raw outcomes', () => {
    const ctx = new Context(); contexts.push(ctx)
    new FakePolicy(ctx)
    new Provider(ctx, 'assistantEvaluation', {
      ready: true, schemaVersion: 4, outcomes: 3, trustedOutcomes: 3,
      selfReportedOutcomes: 0, externalOutcomes: 0, selfAssessments: 0,
      taskProjections: 1, conflictedTaskProjections: 1,
      pendingProjections: 0, retryingProjections: 0, projectionAttempts: 0,
    })
    const service = new AssistantHealthService(ctx, { requiredProviders: ['assistantEvaluation'] })

    expect(service.report(agent())).toMatchObject({
      ready: true,
      assessments: [{
        providerId: 'assistantEvaluation', severity: 'degraded', code: 'evaluation-task-conflicts',
      }],
      providers: expect.arrayContaining([expect.objectContaining({
        id: 'assistantEvaluation', metrics: expect.objectContaining({
          taskProjections: 1, conflictedTaskProjections: 1,
        }),
      })]),
    })
  })

  test('fails closed on a partial or inconsistent Evaluation task projection', () => {
    for (const projection of [
      { taskProjections: 1 },
      { taskProjections: 1, conflictedTaskProjections: 2 },
    ]) {
      const ctx = new Context(); contexts.push(ctx)
      new FakePolicy(ctx)
      new Provider(ctx, 'assistantEvaluation', {
        ready: true, schemaVersion: 4, outcomes: 3, trustedOutcomes: 3,
        selfReportedOutcomes: 0, externalOutcomes: 0, selfAssessments: 0,
        ...projection,
      })
      const service = new AssistantHealthService(ctx, { requiredProviders: ['assistantEvaluation'] })
      expect(service.report(agent()).providers).toContainEqual({
        id: 'assistantEvaluation', status: 'error', metrics: {},
      })
    }
  })

  test('accepts Evolution N-1 and fails closed on a partial N quality projection', () => {
    const base = {
      activeRules: 0, retiredRules: 0, pendingProposals: 0, conflictedProposals: 0,
      trustedEpisodes: 0, unattributedTrustedEpisodes: 0, lastTrustedEpisodeAt: 0,
      lastReconciledAt: 0, autonomousRollbacks: 0,
    }
    const legacyContext = new Context(); contexts.push(legacyContext)
    new FakePolicy(legacyContext)
    new Provider(legacyContext, 'assistantEvolution', base)
    const legacy = new AssistantHealthService(legacyContext, { requiredProviders: [] })
    expect(legacy.report(agent()).providers).toContainEqual({
      id: 'assistantEvolution', status: 'ready', metrics: base,
    })

    const partialContext = new Context(); contexts.push(partialContext)
    new FakePolicy(partialContext)
    new Provider(partialContext, 'assistantEvolution', { ...base, qualityEligibleEpisodes: 0 })
    const partial = new AssistantHealthService(partialContext, { requiredProviders: [] })
    expect(partial.report(agent()).providers).toContainEqual({
      id: 'assistantEvolution', status: 'error', metrics: {},
    })
  })

  test('projects only bounded growth-experiment metrics and blocks on an exhausted required rollback', () => {
    const fixture = harness({
      requiredProviders: ['assistantGrowthExperiments'],
      growthExperimentsHealth: {
        candidates: 3, readyCandidates: 1, activeExperiments: 1,
        rollbackPending: 2, promoted: 4, traceRevisions: 9, currentTraces: 6,
        exhaustedRollbacks: 1, lastErrorCode: 'canary-timeout',
        workflowPath: '/secret/workflow', principal: 'SENTINEL-GROWTH',
      },
    })

    expect(fixture.service.readiness()).toEqual({
      ready: false,
      warnings: [
        'provider-degraded:assistantGrowthExperiments:growth-rollback-pending',
        'provider-unhealthy:assistantGrowthExperiments:growth-rollback-exhausted',
        'provider-degraded:assistantGrowthExperiments:growth-runtime-error',
      ],
    })
    const provider = fixture.service.report(agent()).providers.find(
      current => current.id === 'assistantGrowthExperiments',
    )
    expect(provider).toEqual({
      id: 'assistantGrowthExperiments', status: 'ready', metrics: {
        candidates: 3, readyCandidates: 1, activeExperiments: 1,
        rollbackPending: 2, promoted: 4, traceRevisions: 9, currentTraces: 6,
        exhaustedRollbacks: 1, lastErrorCode: 'canary-timeout',
      },
    })
    expect(JSON.stringify(provider)).not.toMatch(/SENTINEL|workflowPath|principal/iu)
  })

  test('treats a required capability rollback as an unhealthy activation boundary', () => {
    const fixture = harness({
      requiredProviders: ['pluginControlPlane'],
      controlPlaneHealth: {
        gaps: 2, readyPlans: 1, activeActivations: 1, failed: 3,
        rollbackPending: 1, command: 'SENTINEL-CONTROL-PLANE',
      },
    })

    expect(fixture.service.readiness()).toEqual({
      ready: false,
      warnings: ['provider-unhealthy:pluginControlPlane:capability-rollback-pending'],
    })
    expect(fixture.service.report(agent()).providers).toContainEqual({
      id: 'pluginControlPlane', status: 'ready', metrics: {
        gaps: 2, readyPlans: 1, activeActivations: 1, failed: 3, rollbackPending: 1,
      },
    })
    expect(JSON.stringify(fixture.service.report(agent()))).not.toContain('SENTINEL-CONTROL-PLANE')
  })

  test('fails closed on incomplete or malformed growth and capability health contracts', () => {
    for (const fixture of [
      harness({
        requiredProviders: ['assistantGrowthExperiments'],
        growthExperimentsHealth: { candidates: 1 },
      }),
      harness({
        requiredProviders: ['pluginControlPlane'],
        controlPlaneHealth: {
          gaps: 0, readyPlans: 0, activeActivations: 0, failed: 0, rollbackPending: -1,
        },
      }),
    ]) {
      expect(fixture.service.readiness()).toMatchObject({ ready: false })
      expect(fixture.service.report(agent()).providers).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'error', metrics: {} }),
      ]))
    }
  })

  test('aggregates only whitelisted content-free metrics with bounded provider ids', () => {
    const { service } = harness()
    expect(service.liveness()).toEqual({ alive: true })
    expect(service.readiness()).toEqual({ ready: true, warnings: [] })
    const report = service.report(agent())
    expect(report).toMatchObject({ ready: true, severity: 'healthy', generatedAt: 123_000,
      assessments: [],
      providers: expect.arrayContaining([
        { id: 'personalMemory', status: 'ready', metrics: { activeRecords: 3, removedRecords: 1,
          expiredRecords: 0, pendingProposals: 2 } },
        { id: 'larkChannel', status: 'ready', metrics: { state: 'connected', gapGeneration: 2 } },
        { id: 'assistantEvaluation', status: 'ready', metrics: {
          ready: true, schemaVersion: 2, outcomes: 11, trustedOutcomes: 9,
          selfReportedOutcomes: 1, externalOutcomes: 1, selfAssessments: 3,
          latestOccurredAt: 122_000,
        } },
        { id: 'preferenceLearning', status: 'ready', metrics: {
          ready: true, enabled: true, schemaVersion: 1, signals: 7, hypotheses: 3,
          active: 1, shadow: 2, proposed: 0, rolledBack: 1, expired: 0,
          lastRecordedAt: 122_500,
        } },
        { id: 'assistantEvolution', status: 'ready', metrics: {
          activeRules: 2, retiredRules: 1, pendingProposals: 1, conflictedProposals: 0,
          trustedEpisodes: 9, unattributedTrustedEpisodes: 4,
          qualityEligibleEpisodes: 4, operationalEpisodes: 5, legacyQuarantinedEpisodes: 2,
          unattributedQualityEligibleEpisodes: 1, lastQualityEligibleEpisodeAt: 119_000,
          lastTrustedEpisodeAt: 120_000, lastReconciledAt: 121_000, autonomousRollbacks: 1,
        } },
        { id: 'assistantDelivery', status: 'ready', metrics: {
          pendingInbox: 0, deadLetterInbox: 0, pendingOutbox: 2, deadLetterOutbox: 0,
          unknownOutbox: 0, adapters: 1, actionableDeadLetterInbox: 0,
          resolvedDeadLetterInbox: 0, actionableDeadLetterOutbox: 0,
          resolvedDeadLetterOutbox: 0, actionableUnknownOutbox: 0, resolvedUnknownOutbox: 0,
          pendingPresentations: 0, deadPresentations: 0,
        } },
      ]) })
    const serialized = JSON.stringify(report)
    expect(serialized).not.toMatch(/SENTINEL|content|vaultPath|rawMessage|tenant|secret/i)
    expect(Buffer.byteLength(serialized)).toBeLessThan(16_384)
  })

  test('accepts an empty Evaluation ledger whose optional latest timestamp is absent', () => {
    const ctx = new Context(); contexts.push(ctx)
    new FakePolicy(ctx)
    new Provider(ctx, 'assistantEvaluation', { ready: true, schemaVersion: 2, outcomes: 0,
      trustedOutcomes: 0, selfReportedOutcomes: 0, externalOutcomes: 0, selfAssessments: 0 })
    const service = new AssistantHealthService(ctx, { requiredProviders: ['assistantEvaluation'] })

    expect(service.readiness()).toEqual({ ready: true, warnings: [] })
    expect(service.report(agent()).providers).toContainEqual({
      id: 'assistantEvaluation', status: 'ready', metrics: {
        ready: true, schemaVersion: 2, outcomes: 0, trustedOutcomes: 0,
        selfReportedOutcomes: 0, externalOutcomes: 0, selfAssessments: 0,
      },
    })
  })

  test('discovers the real Preference Learning service under its Cordis service name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-health-preference-'))
    roots.push(root)
    const ctx = new Context(); contexts.push(ctx)
    new FakePolicy(ctx)
    new FakeSystemPrompt(ctx)
    new PreferenceLearningService(ctx, { databasePath: join(root, 'preferences.sqlite') })
    const service = new AssistantHealthService(ctx, { requiredProviders: ['preferenceLearning'] })

    expect(ctx.get('preferenceLearning' as never)).toBeUndefined()
    expect(ctx.get('assistantPreferenceLearning' as never)).toBeDefined()
    expect(service.readiness()).toEqual({ ready: true, warnings: [] })
    expect(service.report(agent()).providers).toContainEqual({
      id: 'preferenceLearning', status: 'ready', metrics: {
        ready: true, enabled: true, schemaVersion: 9, signals: 0,
        hypotheses: 0, active: 0, shadow: 0, proposed: 0,
        rolledBack: 0, expired: 0,
      },
    })
  })

  test('marks missing required and throwing optional providers without exposing errors', () => {
    const { service } = harness({ missingWiki: true, failingDelivery: true })
    expect(service.readiness()).toEqual({ ready: false, warnings: [
      'provider-missing:personalWiki',
      'provider-degraded:assistantDelivery:health-seam-error',
    ] })
    const report = service.report(agent())
    expect(report.providers).toEqual(expect.arrayContaining([
      { id: 'personalWiki', status: 'missing', metrics: {} },
      { id: 'assistantDelivery', status: 'error', metrics: {} },
    ]))
    expect(report).toMatchObject({ severity: 'unhealthy', assessments: [
      { providerId: 'personalWiki', severity: 'unhealthy', code: 'required-provider-missing' },
      { providerId: 'assistantDelivery', severity: 'degraded', code: 'health-seam-error' },
    ] })
    expect(JSON.stringify(report)).not.toContain('SENTINEL-FAILURE')
  })

  test('lifetime counters remain observable without permanently polluting current health', () => {
    const fixture = harness({ failedRuns: 2, unknownRuns: 1, failedEvaluationAttempts: 7,
      conflictedProposals: 1, failedLeases: 4 })

    expect(fixture.service.readiness()).toEqual({ ready: true, warnings: [] })
    const report = fixture.service.report(agent())
    expect(report).toMatchObject({ ready: true, severity: 'healthy', assessments: [] })
    expect(report.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'assistantAutomations', metrics: expect.objectContaining({
        failedRuns: 2, unknownRuns: 1,
        failedEvaluationAttempts: 7,
      }) }),
      expect.objectContaining({ id: 'assistantEvolution', metrics: expect.objectContaining({
        conflictedProposals: 1,
      }) }),
      expect.objectContaining({ id: 'credentialsKeychain', metrics: expect.objectContaining({
        failedLeases: 4,
      }) }),
    ]))
  })

  test('reports current Evaluation dead-letter backlog without failing core readiness', () => {
    const fixture = harness({ deadLetterEvaluations: 2 })

    expect(fixture.service.readiness()).toEqual({ ready: true, warnings: [
      'provider-degraded:assistantAutomations:evaluation-dead-letter-backlog',
    ] })
    expect(fixture.service.report(agent())).toMatchObject({ ready: true, severity: 'degraded', assessments: [
      { providerId: 'assistantAutomations', severity: 'degraded', code: 'evaluation-dead-letter-backlog' },
    ] })
  })

  test('separates readiness from current business health and reports bounded operational reasons', () => {
    const fixture = harness({ unknownOutbox: 1, deadLetterOutbox: 3, larkState: 'disconnected' })

    expect(fixture.service.readiness()).toEqual({
      ready: true,
      warnings: [
        'provider-unhealthy:assistantDelivery:unknown-outbox-backlog',
        'provider-degraded:assistantDelivery:dead-letter-backlog',
        'provider-degraded:larkChannel:disconnected',
      ],
    })
    expect(fixture.service.report(agent())).toMatchObject({
      ready: true,
      severity: 'unhealthy',
      assessments: expect.arrayContaining([
        { providerId: 'assistantDelivery', severity: 'unhealthy', code: 'unknown-outbox-backlog' },
        { providerId: 'larkChannel', severity: 'degraded', code: 'disconnected' },
      ]),
    })
  })

  test('uses actionable Delivery counters so resolved terminal history does not poison health', () => {
    const fixture = harness({
      deadLetterInbox: 4,
      deadLetterOutbox: 3,
      unknownOutbox: 2,
      actionableDeadLetterInbox: 0,
      actionableDeadLetterOutbox: 0,
      actionableUnknownOutbox: 0,
      resolvedDeadLetterInbox: 4,
      resolvedDeadLetterOutbox: 3,
      resolvedUnknownOutbox: 2,
    })

    expect(fixture.service.readiness()).toEqual({ ready: true, warnings: [] })
    expect(fixture.service.report(agent())).toMatchObject({
      ready: true,
      severity: 'healthy',
      assessments: [],
      providers: expect.arrayContaining([
        expect.objectContaining({ id: 'assistantDelivery', metrics: expect.objectContaining({
          deadLetterInbox: 4,
          deadLetterOutbox: 3,
          unknownOutbox: 2,
          actionableDeadLetterInbox: 0,
          actionableDeadLetterOutbox: 0,
          actionableUnknownOutbox: 0,
          resolvedDeadLetterInbox: 4,
          resolvedDeadLetterOutbox: 3,
          resolvedUnknownOutbox: 2,
        }) }),
      ]),
    })
  })

  test('falls back to raw Delivery counters during a v8 to v9 rolling upgrade', () => {
    const fixture = harness({
      legacyDeliveryHealth: true,
      legacyPresentationHealth: true,
      deadLetterInbox: 1,
      unknownOutbox: 1,
    })

    expect(fixture.service.readiness()).toEqual({ ready: true, warnings: [
      'provider-unhealthy:assistantDelivery:unknown-outbox-backlog',
      'provider-degraded:assistantDelivery:dead-letter-backlog',
    ] })
    expect(fixture.service.report(agent()).providers).toContainEqual({
      id: 'assistantDelivery', status: 'ready', metrics: {
        pendingInbox: 0, deadLetterInbox: 1, pendingOutbox: 2,
        deadLetterOutbox: 0, unknownOutbox: 1, adapters: 1,
      },
    })
  })

  test('surfaces durable terminal-presentation backlog and dead letters atomically', () => {
    const fixture = harness({ pendingPresentations: 2, deadPresentations: 1 })

    expect(fixture.service.readiness()).toEqual({
      ready: true,
      warnings: [
        'provider-degraded:assistantDelivery:presentation-backlog',
        'provider-unhealthy:assistantDelivery:presentation-dead-letter',
      ],
    })
    expect(fixture.service.report(agent())).toMatchObject({
      ready: true,
      severity: 'unhealthy',
      assessments: expect.arrayContaining([
        { providerId: 'assistantDelivery', severity: 'degraded', code: 'presentation-backlog' },
        { providerId: 'assistantDelivery', severity: 'unhealthy', code: 'presentation-dead-letter' },
      ]),
      providers: expect.arrayContaining([expect.objectContaining({
        id: 'assistantDelivery', metrics: expect.objectContaining({
          pendingPresentations: 2, deadPresentations: 1,
        }),
      })]),
    })
  })

  test('accepts Delivery N-1 without presentation metrics and rejects a partial v10 pair', () => {
    expect(harness({ legacyPresentationHealth: true }).service.readiness())
      .toEqual({ ready: true, warnings: [] })

    const ctx = new Context(); contexts.push(ctx)
    new FakePolicy(ctx)
    new Provider(ctx, 'assistantDelivery', {
      pendingInbox: 0, deadLetterInbox: 0, pendingOutbox: 0,
      deadLetterOutbox: 0, unknownOutbox: 0, adapters: 1,
      pendingPresentations: 1,
    })
    const service = new AssistantHealthService(ctx, { requiredProviders: ['assistantDelivery'] })
    expect(service.readiness()).toEqual({
      ready: false,
      warnings: ['provider-error:assistantDelivery'],
    })
  })

  test.each([
    {
      label: 'partial',
      metrics: { pendingInbox: 0, deadLetterInbox: 0, pendingOutbox: 0,
        deadLetterOutbox: 0, unknownOutbox: 0, adapters: 1,
        actionableDeadLetterInbox: 0 },
    },
    {
      label: 'inconsistent',
      metrics: { pendingInbox: 0, deadLetterInbox: 0, pendingOutbox: 0,
        deadLetterOutbox: 0, unknownOutbox: 1, adapters: 1,
        actionableDeadLetterInbox: 0, resolvedDeadLetterInbox: 0,
        actionableDeadLetterOutbox: 0, resolvedDeadLetterOutbox: 0,
        actionableUnknownOutbox: 0, resolvedUnknownOutbox: 0 },
    },
  ])('fails closed on a $label Delivery v9 health projection', ({ metrics }) => {
    const ctx = new Context(); contexts.push(ctx)
    new FakePolicy(ctx)
    new Provider(ctx, 'assistantDelivery', metrics)
    const service = new AssistantHealthService(ctx, { requiredProviders: [] })

    expect(service.readiness()).toEqual({ ready: true, warnings: [
      'provider-degraded:assistantDelivery:health-seam-error',
    ] })
    expect(service.report(agent()).providers).toContainEqual({
      id: 'assistantDelivery', status: 'error', metrics: {},
    })
  })

  test('emergency stop and a required disconnected Lark channel fail readiness', () => {
    const fixture = harness({ emergencyStop: true, larkState: 'disconnected',
      requiredProviders: ['assistantPolicy', 'personalMemory', 'personalWiki', 'assistantAutomations',
        'assistantEvolution', 'larkChannel'] })

    expect(fixture.service.readiness()).toEqual({ ready: false, warnings: [
      'provider-unhealthy:assistantPolicy:emergency-stop',
      'provider-unhealthy:larkChannel:disconnected',
    ] })
    expect(fixture.service.report(agent())).toMatchObject({ ready: false, severity: 'unhealthy' })
  })

  test('a disabled required Preference Learning provider fails readiness', () => {
    const fixture = harness({ preferenceEnabled: false, requiredProviders: ['preferenceLearning'] })
    expect(fixture.service.readiness()).toEqual({
      ready: false,
      warnings: ['provider-unhealthy:preferenceLearning:disabled'],
    })
  })

  test.each(['connected-with-gap', 'reconnecting'])(
    'accepts the Lark adapter health state %s',
    (state) => {
      const fixture = harness({ larkState: state })
      expect(fixture.service.report(agent()).providers)
        .toContainEqual({ id: 'larkChannel', status: 'ready', metrics: { state, gapGeneration: 2 } })
      expect(fixture.service.report(agent()).severity).toBe('degraded')
    },
  )

  test('policy-gates detailed reports and fails after disposal', async () => {
    const fixture = harness({ allow: false })
    expect(() => fixture.service.report(agent()))
      .toThrowError(expect.objectContaining<Partial<AssistantHealthError>>({ code: 'policy-denied' }))
    await fixture.ctx.fiber.restart()
    expect(() => fixture.service.liveness())
      .toThrowError(expect.objectContaining<Partial<AssistantHealthError>>({ code: 'disposed' }))
  })
})
