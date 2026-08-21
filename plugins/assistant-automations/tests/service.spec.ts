import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  AssistantAutomationsError,
  AssistantAutomationsService,
} from '../src/service.ts'
import type { AutomationDefinition } from '../src/types.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function agent(options: { cwd?: string; preset?: string } = {}): Agent {
  const id = SessionId(`automations-agent-${Math.random()}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION, id, createdAt: 1,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.preset === undefined ? {} : { agentPreset: options.preset }),
  })
  return {
    id, options: {}, session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    ctx: new Context(), status: 'idle', cancel() {}, whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {},
  }
}

function definition(): AutomationDefinition {
  return {
    name: 'Future review', prompt: 'Review safely.', schedule: { kind: 'at', at: '2030-01-01T00:00:00.000Z' },
    workspace: '/work/alpha', agentPreset: 'primary', provider: 'mock', model: 'mock-model', allowedTools: [],
    timeoutMs: 60_000, maxOutputTokens: 512, maxToolCalls: 0, misfire: { kind: 'latest' }, overlap: 'skip',
    retrySafety: 'never', maxRetries: 0, principal: 'owner:lark:123',
  }
}

async function harness(allow = true) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-automations-service-'))
  roots.push(root)
  const ctx = new Context()
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    rules: allow ? [
      {
        id: 'allow-agent-automations', effect: 'allow',
        subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
        actions: ['history', 'list', 'propose', 'run-dry'], resource: { kind: 'automation', id: '*' },
      },
      {
        id: 'allow-background-automations', effect: 'allow',
        subject: { kind: 'background', id: '*' }, actions: ['execute', 'reconcile'], resource: { kind: 'automation', id: '*' },
        context: { initiators: ['background'] },
      },
      {
        id: 'allow-test-event', effect: 'allow', subject: { kind: 'external', id: 'event-test' },
        actions: ['ingest'], resource: { kind: 'automation', id: 'auto-review' }, context: { initiators: ['external'] },
      },
    ] : [],
  })
  await ctx.plugin(AssistantAutomationsService, {
    databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'), schedulerEnabled: false,
  })
  return { ctx, root, service: ctx.assistantAutomations }
}

describe('assistant automations Cordis service', () => {
  test('registers ctx.assistantAutomations and exposes only approval-gated mutations', async () => {
    const { ctx, service } = await harness()
    const current = agent({ cwd: '/work/alpha', preset: 'primary' })
    const proposal = service.propose(current, {
      idempotencyKey: 'service:create', principal: 'owner:lark:123',
      mutation: { op: 'create', automationId: 'auto-review', definition: definition() },
    })
    expect(service.health()).toEqual({ activeAutomations: 0, pausedAutomations: 0,
      pendingTasks: 0, runningTasks: 0, failedRuns: 0, unknownRuns: 0 })
    expect(service.list(current)).toEqual([])
    const approved = service.decideProposal({
      proposalId: proposal.proposalId, principal: 'owner:lark:123', expectedVersion: 1,
      decision: 'approved', reason: 'reviewed',
    })
    expect(approved).toMatchObject({ status: 'approved', automation: { id: 'auto-review' } })
    expect(service.list(current)).toHaveLength(1)
    expect(service.health()).toMatchObject({ activeAutomations: 1, pausedAutomations: 0 })
    expect((service as unknown as Record<string, unknown>)['createApproved']).toBeUndefined()
    await ctx.fiber.restart()
  })

  test('fails closed for denied, absent, relative, or incomplete Agent identity', async () => {
    const denied = await harness(false)
    const input = { idempotencyKey: 'denied', principal: 'owner:lark:123',
      mutation: { op: 'create' as const, automationId: 'auto-review', definition: definition() } }
    expect(() => denied.service.propose(agent({ cwd: '/work/alpha', preset: 'primary' }), input))
      .toThrowError(expect.objectContaining<Partial<AssistantAutomationsError>>({ code: 'policy-denied' }))
    expect(() => denied.service.list(undefined))
      .toThrowError(expect.objectContaining<Partial<AssistantAutomationsError>>({ code: 'missing-identity' }))
    const relative = { session: { header: { cwd: 'relative', agentPreset: 'primary' } } } as unknown as Agent
    expect(() => denied.service.list(relative))
      .toThrowError(expect.objectContaining<Partial<AssistantAutomationsError>>({ code: 'missing-identity' }))
    expect(() => denied.service.list(agent({ cwd: '/work/alpha' })))
      .toThrowError(expect.objectContaining<Partial<AssistantAutomationsError>>({ code: 'missing-identity' }))
    await denied.ctx.fiber.restart()
  })

  test('authorizes external ingestion explicitly and deduplicates the source event', async () => {
    const { ctx, service } = await harness()
    const current = agent({ cwd: '/work/alpha', preset: 'primary' })
    const proposal = service.propose(current, { idempotencyKey: 'event-create', principal: 'owner:lark:123',
      mutation: { op: 'create', automationId: 'auto-review', definition: definition() } })
    service.decideProposal({ proposalId: proposal.proposalId, principal: 'owner:lark:123', expectedVersion: 1,
      decision: 'approved', reason: 'reviewed' })
    const first = service.ingestExternal({ sourceId: 'event-test', automationId: 'auto-review',
      eventId: 'webhook:1', occurredAt: 123_000 })
    expect(service.ingestExternal({ sourceId: 'event-test', automationId: 'auto-review',
      eventId: 'webhook:1', occurredAt: 123_000 })).toEqual(first)
    await ctx.fiber.restart()
  })

  test('policy-gates system-owned reconciliation and preserves the owner boundary', async () => {
    const allowed = await harness()
    const created = allowed.service.reconcileSystem({
      owner: 'assistant-heartbeat', automationId: 'heartbeat-primary',
      idempotencyKey: 'heartbeat-primary:v1', desiredStatus: 'paused', definition: definition(),
    })
    expect(created).toMatchObject({ id: 'heartbeat-primary', owner: 'assistant-heartbeat', status: 'paused' })
    expect(() => allowed.service.reconcileSystem({
      owner: 'other-plugin', automationId: 'heartbeat-primary',
      idempotencyKey: 'takeover', definition: definition(),
    })).toThrow(/owned/i)
    await allowed.ctx.fiber.restart()

    const denied = await harness(false)
    expect(() => denied.service.reconcileSystem({
      owner: 'assistant-heartbeat', automationId: 'heartbeat-primary',
      idempotencyKey: 'heartbeat-primary:v1', definition: definition(),
    })).toThrowError(expect.objectContaining<Partial<AssistantAutomationsError>>({ code: 'policy-denied' }))
    await denied.ctx.fiber.restart()
  })

  test('rejects unsafe configuration and all calls after disposal', async () => {
    for (const config of [
      undefined,
      { databasePath: 'relative.sqlite', runsPath: '/tmp/runs' },
      { databasePath: '/tmp/automations.sqlite', runsPath: 'relative' },
      { databasePath: '/tmp/automations.sqlite', runsPath: '/tmp/runs', maxConcurrency: 0 },
    ]) {
      const ctx = new Context()
      expect(() => new AssistantAutomationsService(ctx, config as never)).toThrow(/assistant-automations|absolute|concurrency/i)
      await ctx.fiber.restart()
    }
    const fixture = await harness()
    const current = agent({ cwd: '/work/alpha', preset: 'primary' })
    await fixture.ctx.fiber.restart()
    expect(() => fixture.service.list(current)).toThrowError(expect.objectContaining({ code: 'disposed' }))
  })
})
