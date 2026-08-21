import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantPolicyService } from '../src/service.ts'
import type { PolicyRequest } from '../src/types.ts'

const temporaryRoots: string[] = []

async function databasePath() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-policy-service-'))
  temporaryRoots.push(root)
  return join(root, 'policy.sqlite')
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const request: PolicyRequest = {
  subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
  action: 'read',
  resource: { kind: 'filesystem', id: '/work/alpha/README.md' },
  context: { initiator: 'foreground' },
}

describe('assistant policy Cordis service', () => {
  test('registers the typed service and snapshots its rule config', async () => {
    const ctx = new Context()
    const rules = [{
      id: 'allow-workspace-read',
      effect: 'allow' as const,
      actions: ['read'],
      resource: { kind: 'filesystem' as const, id: '/work/alpha/*' },
    }]
    const service = new AssistantPolicyService(ctx, {
      databasePath: await databasePath(),
      rules,
    })
    rules[0]!.actions = ['write']

    let injectedDecision: string | undefined
    await ctx.inject(['assistantPolicy'], (injected) => {
      injectedDecision = injected.assistantPolicy.evaluate(request).effect
    })
    expect(injectedDecision).toBe('allow')
    expect(service.evaluate(request).effect).toBe('allow')
    expect(service.evaluate({ ...request, action: 'write' }).effect).toBe('deny')
    expect(service.health()).toEqual({ emergencyStop: false, lastAuditSequence: 0 })
    await ctx.fiber.restart()
  })

  test('rejects absent, null, and relative database configuration', async () => {
    for (const config of [undefined, null, { databasePath: 'relative.sqlite', rules: [] }]) {
      const ctx = new Context()
      expect(() => new AssistantPolicyService(ctx, config as never)).toThrow(/assistant-policy|absolute/i)
      await ctx.fiber.restart()
    }
  })

  test('places emergency stop ahead of configured allow rules', async () => {
    const ctx = new Context()
    const service = new AssistantPolicyService(ctx, {
      databasePath: await databasePath(),
      rules: [{ id: 'allow-read', effect: 'allow', actions: ['read'] }],
    })
    expect(service.evaluate(request).reasonCode).toBe('rule-allow')

    service.setEmergencyStop({ enabled: true, actor: 'owner', reason: 'incident' })

    expect(service.evaluate(request)).toEqual({
      effect: 'deny',
      reasonCode: 'emergency-stop',
      ruleId: undefined,
    })
    await ctx.fiber.restart()
  })

  test('audits authorization without persisting raw resource identifiers', async () => {
    const ctx = new Context()
    const service = new AssistantPolicyService(ctx, {
      databasePath: await databasePath(),
      rules: [{ id: 'allow-read', effect: 'allow', actions: ['read'] }],
    })

    const decision = service.authorize(request, {
      auditDetails: { path: request.resource.id, token: 'sk-private' },
    })

    expect(decision.effect).toBe('allow')
    expect(service.queryAudit({ limit: 10 })).toEqual([
      expect.objectContaining({
        actor: 'agent:primary',
        action: 'read',
        outcome: 'allowed',
        reasonCode: 'rule-allow',
        details: { path: '[REDACTED]', token: '[REDACTED]' },
      }),
    ])
    await ctx.fiber.restart()
  })

  test('delegates budget and approval operations through the service seam', async () => {
    const ctx = new Context()
    const service = new AssistantPolicyService(ctx, {
      databasePath: await databasePath(),
      rules: [],
      budgets: [{
        id: 'turns',
        metric: 'turns',
        limit: 2,
        periodMs: 60_000,
        scope: 'subject',
      }],
    })
    const reservation = service.reserve({
      budgetId: 'turns',
      subject: request.subject,
      amount: 1,
      idempotencyKey: 'turn-1',
    })
    expect(service.finalize(reservation.reservationId, 1).status).toBe('finalized')

    const proposal = service.propose({
      idempotencyKey: 'proposal-1',
      requester: 'agent:primary',
      principal: 'owner',
      action: 'memory.add',
      resource: { kind: 'memory', id: 'fact-1' },
      diff: '+ fact',
      summary: 'Remember a fact',
      ttlMs: 60_000,
    })
    expect(service.decideProposal({
      proposalId: proposal.proposalId,
      principal: 'owner',
      expectedVersion: proposal.version,
      decision: 'approved',
      reason: 'confirmed',
    }).status).toBe('approved')
    expect(service.queryAudit({ limit: 10 }).map(event => event.action)).toEqual([
      'budget.reserve',
      'budget.finalize',
      'approval.propose',
      'approval.decide',
    ])
    await ctx.fiber.restart()
  })

  test('enforces configured hard budgets without accepting caller-owned limits', async () => {
    const ctx = new Context()
    const service = new AssistantPolicyService(ctx, {
      databasePath: await databasePath(),
      rules: [{
        id: 'allow-budgeted-read',
        effect: 'allow',
        actions: ['read'],
        budget: { id: 'read-operations', amount: 1 },
      }],
      budgets: [{
        id: 'read-operations',
        metric: 'operations',
        limit: 2,
        periodMs: 60_000,
        scope: 'subject',
      }],
    })

    expect(service.authorize(request, { idempotencyKey: 'read-1' }).effect).toBe('allow')
    expect(service.authorize(request, { idempotencyKey: 'read-2' }).effect).toBe('allow')
    expect(service.authorize(request, { idempotencyKey: 'read-3' })).toMatchObject({
      effect: 'deny',
      reasonCode: 'budget-exhausted',
    })
    expect(service.reserve).toBeTypeOf('function')
    await ctx.fiber.restart()
  })

  test('fails closed when an allow rule references an unknown budget', async () => {
    const ctx = new Context()
    const service = new AssistantPolicyService(ctx, {
      databasePath: await databasePath(),
      rules: [{
        id: 'allow-with-missing-budget',
        effect: 'allow',
        actions: ['read'],
        budget: { id: 'not-configured', amount: 1 },
      }],
    })

    expect(service.authorize(request, { idempotencyKey: 'read-1' })).toMatchObject({
      effect: 'deny',
      reasonCode: 'budget-not-configured',
    })
    await ctx.fiber.restart()
  })

  test('requires an idempotency key for every budgeted authorization', async () => {
    const ctx = new Context()
    const service = new AssistantPolicyService(ctx, {
      databasePath: await databasePath(),
      rules: [{
        id: 'allow-budgeted-read',
        effect: 'allow',
        actions: ['read'],
        budget: { id: 'reads', amount: 1 },
      }],
      budgets: [{ id: 'reads', metric: 'reads', limit: 5, periodMs: 60_000, scope: 'subject' }],
    })

    expect(service.authorize(request)).toMatchObject({
      effect: 'deny',
      reasonCode: 'budget-idempotency-required',
    })
    await ctx.fiber.restart()
  })

  test('audits emergency-stop state changes with the authenticated actor', async () => {
    const ctx = new Context()
    const service = new AssistantPolicyService(ctx, {
      databasePath: await databasePath(),
      rules: [],
    })

    service.setEmergencyStop({ enabled: true, actor: 'owner:lark:123', reason: 'incident' })

    expect(service.queryAudit({ limit: 10 })).toEqual([
      expect.objectContaining({
        actor: 'owner:lark:123',
        action: 'policy.emergency-stop',
        outcome: 'enabled',
        reasonCode: 'owner-change',
        details: { enabled: true, reason: 'incident' },
      }),
    ])
    await ctx.fiber.restart()
  })

  test('fails service calls after Cordis lifecycle disposal', async () => {
    const ctx = new Context()
    const service = new AssistantPolicyService(ctx, {
      databasePath: await databasePath(),
      rules: [],
    })

    await ctx.fiber.restart()

    expect(() => service.evaluate(request)).toThrow(/disposed/i)
  })
})
