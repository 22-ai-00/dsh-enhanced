import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
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
    name: 'Future review', prompt: 'Review safely.', schedule: { kind: 'at' as const, at: '2030-01-01T00:00:00.000Z' },
    workspace: '/work/alpha', agentPreset: 'primary', provider: 'mock', model: 'mock-model', allowedTools: [],
    timeoutMs: 60_000, maxOutputTokens: 512, maxToolCalls: 0, misfire: { kind: 'latest' }, overlap: 'skip',
    retrySafety: 'never', maxRetries: 0, principal: 'owner:lark:123',
  }
}

function proposedDefinition(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Future review', prompt: 'Review safely.', schedule: { kind: 'at' as const, at: '2030-01-01T00:00:00.000Z' },
    allowedTools: [],
    ...overrides,
  }
}

const proposalDefaults = {
  provider: 'trusted-provider', model: 'trusted-model', allowedTools: ['evolution_review'],
  timeoutMs: 30_000, maxOutputTokens: 256, maxToolCalls: 1,
  misfireKind: 'latest' as const, misfireLimit: 1, overlap: 'skip' as const,
  retrySafety: 'never' as const, maxRetries: 0,
  budgetId: 'growth-budget', budgetAmount: 1,
}

async function harness(allow = true, options: {
  deliveryRoute?: false | { sourceId: string; bindingId: string; workspace: string; principal: string }
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-automations-service-'))
  roots.push(root)
  const ctx = new Context()
  const prepareAgentApproval = vi.fn(() => options.deliveryRoute === false
    ? (() => { throw new Error('disabled') })()
    : options.deliveryRoute ?? {
        sourceId: 'dsh-enhanced-assistant-automations', bindingId: 'binding-owner',
        workspace: '/work/alpha', principal: 'lark/main/tenant/owner',
      })
  if (options.deliveryRoute !== false) {
    ctx.provide('assistantDelivery' as never, { prepareAgentApproval } as never)
  }
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    budgets: [{ id: 'growth-budget', metric: 'automation-runs', limit: 100, periodMs: 60_000, scope: 'subject' }],
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
    proposalDefaults,
    allowUnbudgetedExecution: true,
  })
  return { ctx, root, service: ctx.assistantAutomations, prepareAgentApproval }
}

describe('assistant automations Cordis service', () => {
  test('defaults audited route capabilities, requires hard budgets, and exposes bounded trusted proposal defaults', () => {
    const config = AssistantAutomationsService.Config({
      databasePath: '/tmp/automations.sqlite',
      runsPath: '/tmp/runs',
    })
    expect(config.toolCapableProviders).toEqual(['deepseek-official'])
    expect(config.allowUnbudgetedExecution).toBe(false)
    expect(config.proposalDefaults).toEqual({
      provider: 'deepseek-official', model: 'deepseek-chat', allowedTools: [],
      timeoutMs: 60_000, maxOutputTokens: 512, maxToolCalls: 0,
      misfireKind: 'latest', misfireLimit: 1, overlap: 'skip', retrySafety: 'never', maxRetries: 0,
      budgetId: 'assistant-automations-proposals', budgetAmount: 1,
    })
    expect(() => AssistantAutomationsService.Config({
      databasePath: '/tmp/automations.sqlite',
      runsPath: '/tmp/runs',
      toolCapableProviders: ['bad route'],
    })).toThrow(/toolCapableProviders|pattern|invalid/i)
    expect(() => AssistantAutomationsService.Config({
      databasePath: '/tmp/automations.sqlite', runsPath: '/tmp/runs',
      proposalDefaults: { ...proposalDefaults, budgetId: '' },
    })).toThrow(/proposalDefaults|budgetId|pattern|invalid/i)
  })

  test('derives create authority from the authenticated Delivery route and trusted config', async () => {
    const fixture = await harness()
    const current = agent({ cwd: '/work/alpha', preset: 'primary' })
    const proposal = fixture.service.propose(current, {
      idempotencyKey: 'service:trusted-create',
      mutation: {
        op: 'create', automationId: 'auto-review',
        definition: proposedDefinition({
          workspace: '/work/attacker', agentPreset: 'attacker', provider: 'attacker', model: 'attacker',
          timeoutMs: 1, maxOutputTokens: 1, maxToolCalls: 999, principal: 'attacker',
          budgetId: 'attacker', budgetAmount: 1, deliveryBindingId: 'attacker',
        }),
      } as never,
    })
    expect(fixture.prepareAgentApproval).toHaveBeenCalledWith(current, {
      sourceId: 'dsh-enhanced-assistant-automations',
    })
    fixture.service.decideProposal({ proposalId: proposal.proposalId, principal: 'lark/main/tenant/owner',
      expectedVersion: 1, decision: 'approved', reason: 'reviewed' })
    expect(fixture.service.list(current)[0]?.definition).toEqual({
      name: 'Future review', prompt: 'Review safely.', schedule: { kind: 'at', at: '2030-01-01T00:00:00.000Z' },
      workspace: '/work/alpha', agentPreset: 'primary', provider: 'trusted-provider', model: 'trusted-model',
      allowedTools: [], timeoutMs: 30_000, maxOutputTokens: 256, maxToolCalls: 1,
      misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0,
      principal: 'lark/main/tenant/owner', budgetId: 'growth-budget', budgetAmount: 1,
      deliveryBindingId: 'binding-owner',
    })
    await fixture.ctx.fiber.restart()
  })

  test('enforces the configured tool subset and exact Delivery/headless route', async () => {
    const routed = await harness()
    const current = agent({ cwd: '/work/alpha', preset: 'primary' })
    expect(() => routed.service.propose(current, {
      idempotencyKey: 'service:forged-principal', principal: 'attacker',
      mutation: { op: 'create', automationId: 'forged', definition: proposedDefinition() } as never,
    })).toThrowError(expect.objectContaining({ code: 'unauthorized-principal' }))
    expect(() => routed.service.propose(current, {
      idempotencyKey: 'service:extra-tool',
      mutation: { op: 'create', automationId: 'extra-tool', definition: proposedDefinition({
        allowedTools: ['evolution_review', 'shell'],
      }) } as never,
    })).toThrow(/allowed.*tool|tool.*allow/i)
    await routed.ctx.fiber.restart()

    const mismatched = await harness(true, { deliveryRoute: {
      sourceId: 'dsh-enhanced-assistant-automations', bindingId: 'binding-owner',
      workspace: '/work/other', principal: 'lark/main/tenant/owner',
    } })
    expect(() => mismatched.service.propose(current, {
      idempotencyKey: 'service:wrong-workspace',
      mutation: { op: 'create', automationId: 'wrong-workspace', definition: proposedDefinition() } as never,
    })).toThrow(/approval route|workspace/i)
    await mismatched.ctx.fiber.restart()

    const headless = await harness(true, { deliveryRoute: false })
    expect(() => headless.service.propose(current, {
      idempotencyKey: 'service:missing-headless-principal',
      mutation: { op: 'create', automationId: 'missing-principal', definition: proposedDefinition() } as never,
    })).toThrow(/approval route|principal/i)
    const pending = headless.service.propose(current, {
      idempotencyKey: 'service:headless', principal: 'headless:owner',
      mutation: { op: 'create', automationId: 'headless', definition: proposedDefinition() } as never,
    })
    headless.service.decideProposal({ proposalId: pending.proposalId, principal: 'headless:owner',
      expectedVersion: 1, decision: 'approved', reason: 'headless review' })
    expect(headless.service.list(current)[0]?.definition).toMatchObject({
      workspace: '/work/alpha', agentPreset: 'primary', principal: 'headless:owner',
    })
    await headless.ctx.fiber.restart()
  })

  test('registers ctx.assistantAutomations and exposes only approval-gated mutations', async () => {
    const { ctx, service } = await harness()
    const current = agent({ cwd: '/work/alpha', preset: 'primary' })
    const proposal = service.propose(current, {
      idempotencyKey: 'service:create',
      mutation: { op: 'create', automationId: 'auto-review', definition: proposedDefinition() } as never,
    })
    expect(service.health()).toEqual({ activeAutomations: 0, pausedAutomations: 0,
      pendingTasks: 0, runningTasks: 0, failedRuns: 0, unknownRuns: 0 })
    expect(service.list(current)).toEqual([])
    const approved = service.decideProposal({
      proposalId: proposal.proposalId, principal: 'lark/main/tenant/owner', expectedVersion: 1,
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
    const input = { idempotencyKey: 'denied',
      mutation: { op: 'create' as const, automationId: 'auto-review', definition: proposedDefinition() } }
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
    const proposal = service.propose(current, { idempotencyKey: 'event-create',
      mutation: { op: 'create', automationId: 'auto-review', definition: proposedDefinition() } as never })
    service.decideProposal({ proposalId: proposal.proposalId, principal: 'lark/main/tenant/owner', expectedVersion: 1,
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
