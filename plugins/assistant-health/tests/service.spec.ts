import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantHealthError, AssistantHealthService } from '../src/service.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart())) })

class FakePolicy extends Service {
  allow = true
  emergencyStop = false
  constructor(ctx: Context) { super(ctx, 'assistantPolicy') }
  authorizeAgent() { return { effect: this.allow ? 'allow' : 'deny', reasonCode: this.allow ? 'rule-allow' : 'default-deny' } }
  health() { return { emergencyStop: this.emergencyStop, lastAuditSequence: 12, secret: 'SENTINEL-POLICY' } }
}

class Provider extends Service {
  constructor(ctx: Context, name: string, private readonly result: unknown, private readonly failure = false) { super(ctx, name) }
  health() { if (this.failure) throw new Error('SENTINEL-FAILURE'); return this.result }
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
  unknownOutbox?: number
  deadLetterOutbox?: number
  conflictedProposals?: number
  failedLeases?: number
  preferenceEnabled?: boolean
  requiredProviders?: Array<'assistantPolicy' | 'personalMemory' | 'personalWiki' | 'assistantAutomations'
    | 'assistantEvaluation' | 'preferenceLearning' | 'assistantEvolution' | 'larkChannel'>
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
    deadLetterEvaluations: options.deadLetterEvaluations ?? 0, oldestPendingEvaluationAt: 119_000 })
  new Provider(ctx, 'assistantEvaluation', { ready: true, schemaVersion: 2, outcomes: 11,
    trustedOutcomes: 9, selfReportedOutcomes: 1, externalOutcomes: 1, selfAssessments: 3,
    latestOccurredAt: 122_000, databasePath: '/secret/evaluation.sqlite', content: 'SENTINEL-EVALUATION' })
  new Provider(ctx, 'preferenceLearning', { ready: true, enabled: options.preferenceEnabled ?? true,
    schemaVersion: 1, signals: 7,
    hypotheses: 3, active: 1, shadow: 2, proposed: 0, rolledBack: 1, expired: 0,
    lastRecordedAt: 122_500, workspace: '/secret/preference', value: 'SENTINEL-PREFERENCE' })
  new Provider(ctx, 'assistantEvolution', { activeRules: 2, retiredRules: 1, pendingProposals: 1,
    conflictedProposals: options.conflictedProposals ?? 0, trustedEpisodes: 9,
    unattributedTrustedEpisodes: 4, lastTrustedEpisodeAt: 120_000, lastReconciledAt: 121_000,
    autonomousRollbacks: 1,
    scope: 'SENTINEL-EVOLUTION-SCOPE', guidance: 'SENTINEL-EVOLUTION-GUIDANCE' })
  new Provider(ctx, 'assistantDelivery', { pendingInbox: 0, deadLetterInbox: 0, pendingOutbox: 2,
    deadLetterOutbox: options.deadLetterOutbox ?? 0, unknownOutbox: options.unknownOutbox ?? 0,
    adapters: 1, rawMessage: 'SENTINEL' }, options.failingDelivery)
  new Provider(ctx, 'credentialsKeychain', { handles: 2, activeLeases: 0,
    failedLeases: options.failedLeases ?? 0 })
  new Provider(ctx, 'eventTriggers', { pendingEvents: 1, deliveredEvents: 9, triggersObserved: 2 })
  new Provider(ctx, 'assistantHeartbeat', { active: 1, paused: 1, empty: 1 })
  new Provider(ctx, 'larkChannel', { state: options.larkState ?? 'connected', gapGeneration: 2, tenant: 'SENTINEL' })
  const service = new AssistantHealthService(ctx, {
    requiredProviders: options.requiredProviders
      ?? ['assistantPolicy', 'personalMemory', 'personalWiki', 'assistantAutomations'],
  }, { now: () => 123_000 })
  return { ctx, policy, service }
}

describe('assistant health service', () => {
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
          lastTrustedEpisodeAt: 120_000, lastReconciledAt: 121_000, autonomousRollbacks: 1,
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
