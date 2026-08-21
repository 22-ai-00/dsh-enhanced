import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantHealthError, AssistantHealthService } from '../src/service.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart())) })

class FakePolicy extends Service {
  allow = true
  constructor(ctx: Context) { super(ctx, 'assistantPolicy') }
  authorizeAgent() { return { effect: this.allow ? 'allow' : 'deny', reasonCode: this.allow ? 'rule-allow' : 'default-deny' } }
  health() { return { emergencyStop: false, lastAuditSequence: 12, secret: 'SENTINEL-POLICY' } }
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
} = {}) {
  const ctx = new Context(); contexts.push(ctx)
  const policy = new FakePolicy(ctx); policy.allow = options.allow ?? true
  new Provider(ctx, 'personalMemory', { activeRecords: 3, removedRecords: 1, expiredRecords: 0,
    pendingProposals: 2, content: 'SENTINEL-MEMORY' })
  if (!options.missingWiki) new Provider(ctx, 'personalWiki', { pages: 4, lintErrors: 0, lintWarnings: 1,
    pendingProposals: 0, vaultPath: '/secret/path' })
  new Provider(ctx, 'assistantAutomations', { activeAutomations: 2, pausedAutomations: 1,
    pendingTasks: 3, runningTasks: 0, failedRuns: 1, unknownRuns: 0 })
  new Provider(ctx, 'assistantDelivery', { pendingInbox: 0, deadLetterInbox: 1, pendingOutbox: 2,
    deadLetterOutbox: 0, unknownOutbox: 1, adapters: 1, rawMessage: 'SENTINEL' }, options.failingDelivery)
  new Provider(ctx, 'credentialsKeychain', { handles: 2, activeLeases: 0, failedLeases: 1 })
  new Provider(ctx, 'eventTriggers', { pendingEvents: 1, deliveredEvents: 9, triggersObserved: 2 })
  new Provider(ctx, 'assistantHeartbeat', { active: 1, paused: 1, empty: 1 })
  new Provider(ctx, 'larkChannel', { state: options.larkState ?? 'connected', gapGeneration: 2, tenant: 'SENTINEL' })
  const service = new AssistantHealthService(ctx, {
    requiredProviders: ['assistantPolicy', 'personalMemory', 'personalWiki', 'assistantAutomations'],
  }, { now: () => 123_000 })
  return { ctx, policy, service }
}

describe('assistant health service', () => {
  test('aggregates only whitelisted content-free metrics with bounded provider ids', () => {
    const { service } = harness()
    expect(service.liveness()).toEqual({ alive: true })
    expect(service.readiness()).toEqual({ ready: true, warnings: [] })
    const report = service.report(agent())
    expect(report).toMatchObject({ ready: true, generatedAt: 123_000,
      providers: expect.arrayContaining([
        { id: 'personalMemory', status: 'ready', metrics: { activeRecords: 3, removedRecords: 1,
          expiredRecords: 0, pendingProposals: 2 } },
        { id: 'larkChannel', status: 'ready', metrics: { state: 'connected', gapGeneration: 2 } },
      ]) })
    const serialized = JSON.stringify(report)
    expect(serialized).not.toMatch(/SENTINEL|content|vaultPath|rawMessage|tenant|secret/i)
    expect(Buffer.byteLength(serialized)).toBeLessThan(16_384)
  })

  test('marks missing required and throwing optional providers without exposing errors', () => {
    const { service } = harness({ missingWiki: true, failingDelivery: true })
    expect(service.readiness()).toEqual({ ready: false, warnings: ['provider-missing:personalWiki'] })
    const report = service.report(agent())
    expect(report.providers).toEqual(expect.arrayContaining([
      { id: 'personalWiki', status: 'missing', metrics: {} },
      { id: 'assistantDelivery', status: 'error', metrics: {} },
    ]))
    expect(JSON.stringify(report)).not.toContain('SENTINEL-FAILURE')
  })

  test.each(['connected-with-gap', 'reconnecting'])(
    'accepts the Lark adapter health state %s',
    (state) => {
      const fixture = harness({ larkState: state })
      expect(fixture.service.report(agent()).providers)
        .toContainEqual({ id: 'larkChannel', status: 'ready', metrics: { state, gapGeneration: 2 } })
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
