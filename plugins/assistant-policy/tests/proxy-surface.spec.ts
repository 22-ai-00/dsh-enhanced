import { Context, symbols } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantPolicyService } from '../src/service.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
})

describe('AssistantPolicyService live Cordis Proxy surface (T3-EW-02)', () => {
  test('all public methods operate cleanly via ctx.get("assistantPolicy") and child Context Proxies', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const now = Date.now()
    await ctx.plugin(AssistantPolicyService, {
      databasePath: ':memory:',
      budgets: [{ id: 'b-1', limit: 10, periodMs: 60_000, metric: 'tool_calls', scope: 'global' }],
      rules: [
        {
          id: 'r-allow',
          effect: 'allow',
          subject: { kind: 'background', id: 'worker-1', workspace: '/w', principal: 'web/a/t/u' },
          actions: ['admit'],
          resource: { kind: 'automation', id: 'worker-1' },
          context: { initiators: ['background'] },
          budget: { id: 'b-1', amount: 1 },
          lease: { leaseId: 'lease-1', expiresAtMs: now + 60_000, maxUses: 5 },
        },
      ],
    })

    const proxy = ctx.get('assistantPolicy')!
    const child = ctx.extend({})
    const childProxy = child.assistantPolicy
    expect(proxy).toBeDefined()
    expect((proxy as unknown as Record<symbol, unknown>)[symbols.original]).not.toBe(proxy)
    expect((childProxy as unknown as Record<symbol, unknown>)[symbols.original]).toBe(
      (proxy as unknown as Record<symbol, unknown>)[symbols.original],
    )

    expect(proxy.health().emergencyStop).toBe(false)
    expect(childProxy.inspectHostConfiguration().rules).toHaveLength(1)
    expect(proxy.getBudgetConfig('b-1')?.limit).toBe(10)
    expect(proxy.getCommitHead({ kind: 'automation', id: 'worker-1' })).toBeUndefined()

    const evalRes = proxy.evaluate({
      subject: { kind: 'background', id: 'worker-1', workspace: '/w', principal: 'web/a/t/u' },
      action: 'admit',
      resource: { kind: 'automation', id: 'worker-1' },
      context: { initiator: 'background' },
    })
    expect(evalRes.effect).toBe('allow')

    const authRes = childProxy.authorize({
      subject: { kind: 'background', id: 'worker-1', workspace: '/w', principal: 'web/a/t/u' },
      action: 'admit',
      resource: { kind: 'automation', id: 'worker-1' },
      context: { initiator: 'background' },
      idempotencyKey: 'proxy-auth-1',
    })
    expect(authRes.effect).toBe('allow')
    expect(proxy.getLeaseState('lease-1')?.uses).toBe(1)
    expect(proxy.revokeLease('lease-1').revoked).toBe(true)

    const reserved = proxy.reserve({
      budgetId: 'b-1',
      amount: 2,
      idempotencyKey: 'res-1',
      subject: { kind: 'background', id: 'worker-1', workspace: '/w', principal: 'web/a/t/u' },
    })
    expect(reserved.status).toBe('reserved')
    expect(childProxy.finalize(reserved.reservationId, 2).status).toBe('finalized')

    const reserved2 = proxy.reserve({
      budgetId: 'b-1',
      amount: 1,
      idempotencyKey: 'res-2',
      subject: { kind: 'background', id: 'worker-1', workspace: '/w', principal: 'web/a/t/u' },
    })
    expect(reserved2.status).toBe('reserved')
    expect(childProxy.release(reserved2.reservationId).status).toBe('released')
    expect(proxy.releaseByIdempotencyKey('res-2')?.status).toBe('released')

    const prop = proxy.propose({
      idempotencyKey: 'prop-idem-1',
      requester: 'worker-1',
      principal: 'web/a/t/u',
      action: 'admit',
      resource: { kind: 'automation', id: 'worker-1' },
      diff: 'diff',
      summary: 'Test approval',
      ttlMs: 60_000,
    })
    expect(prop.status).toBe('pending')
    expect(childProxy.getProposal(prop.proposalId)?.proposalId).toBe(prop.proposalId)
    expect(proxy.getProposalByIdempotencyKey({
      idempotencyKey: 'prop-idem-1',
      requester: 'worker-1',
      principal: 'web/a/t/u',
      action: 'admit',
      resource: { kind: 'automation', id: 'worker-1' },
    })?.proposalId).toBe(prop.proposalId)
    expect(proxy.decideProposal({
      proposalId: prop.proposalId,
      principal: 'web/a/t/u',
      decision: 'approved',
      expectedVersion: prop.version,
      reason: 'proxy test',
    }).status).toBe('approved')
    expect(proxy.expireProposals()).toBe(0)
    expect(proxy.listPendingApprovalDispatches(10)).toEqual([])
    expect(proxy.listProposalStatesForRoute({
      routeVersion: 2,
      sourceId: 'src-1',
      bindingId: 'b-1',
      bindingVersion: 1,
      bindingGeneration: 1,
      workspace: '/w',
      principal: 'web/a/t/u',
      principalRecordId: 'owner-1',
      principalVersion: 1,
    }, 10).proposals).toEqual([])

    expect(proxy.contextToolPreauthorizationVersion()).toBe(1)
    expect(proxy.checkpointToolPreauthorizationVersion()).toBe(1)
    expect(proxy.delegatedSkillToolPreauthorizationVersion()).toBe(1)
    expect(proxy.workItemToolPreauthorizationVersion()).toBe(1)
    expect(proxy.workItemGrowthToolPreauthorizationVersion()).toBe(1)
    expect(proxy.isAutoReviewEscalation({} as never)).toBe(false)

    const stop = proxy.setEmergencyStop({ enabled: true, actor: 'owner', reason: 'proxy test' })
    expect(stop.enabled).toBe(true)
    expect(childProxy.getEmergencyStop().enabled).toBe(true)
    proxy.setEmergencyStop({ enabled: false, actor: 'owner', reason: 'clear' })

    expect(proxy.queryAudit({ limit: 10 }).length).toBeGreaterThan(0)
    const unregisterAnswerer = proxy.registerHumanApprovalAnswerer({
      ownerRouteId: 'route-1',
      answer: () => ({ status: 'ignored' }),
    } as never)
    unregisterAnswerer()
  })
})
