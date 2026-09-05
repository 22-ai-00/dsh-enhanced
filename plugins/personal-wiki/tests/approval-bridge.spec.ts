import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import {
  AssistantPolicyService,
  type ApprovalDispatchRoute,
} from '@dsh-enhanced/assistant-policy'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  PERSONAL_WIKI_APPROVAL_SOURCE,
  PersonalWikiError,
  PersonalWikiService,
} from '../src/service.ts'

const temporaryRoots: string[] = []

function agent(options: { cwd?: string; preset?: string } = {}): Agent {
  const id = SessionId(`wiki-approval-agent-${Math.random()}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    cwd: options.cwd ?? '/work/alpha',
    agentPreset: options.preset ?? 'primary',
    isSeeded: false,
  })
  return {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    ctx: new Context(),
    status: 'idle',
    cancel() {},
    whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal),
    send() {},
    followup() {},
    steer() {},
    inject() {},
  }
}

function mutation(title = 'Trusted route') {
  return {
    op: 'create' as const,
    input: {
      title,
      type: 'concept' as const,
      authority: 'curated' as const,
      status: 'active' as const,
      tags: ['approval'],
      aliases: [],
      sources: [{ uri: 'https://example.test/approval', sha256: 'a'.repeat(64) }],
      body: '# Trusted route\n\nApproval authority comes from Delivery.',
    },
  }
}

async function harness(route?: ApprovalDispatchRoute | false) {
  const root = await mkdtemp(join(tmpdir(), 'personal-wiki-approval-bridge-'))
  temporaryRoots.push(root)
  const ctx = new Context()
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    proposalMaintenanceIntervalMs: 0,
    rules: [{
      id: 'allow-wiki-proposal',
      effect: 'allow',
      subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
      actions: ['propose'],
      resource: { kind: 'wiki', id: '*' },
    }],
  })
  const prepareAgentApproval = vi.fn(() => {
    if (route === false || route === undefined) throw new Error('approval route unavailable')
    return route
  })
  if (route !== false) ctx.provide('assistantDelivery', { prepareAgentApproval })
  await ctx.plugin(PersonalWikiService, {
    vaultRoot: join(root, 'vault'),
    databasePath: join(root, 'wiki.sqlite'),
    defaultProposalTtlMs: 60_000,
    reconcileIntervalMs: 0,
  })
  return { ctx, service: ctx.personalWiki, policy: ctx.assistantPolicy, prepareAgentApproval }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('personal wiki production approval bridge', () => {
  test('derives owner authority from the exact Agent binding and persists the exact dispatch', async () => {
    const route: ApprovalDispatchRoute = {
      routeVersion: 2,
      sourceId: PERSONAL_WIKI_APPROVAL_SOURCE,
      bindingId: 'binding-owner-dm',
      bindingVersion: 3,
      bindingGeneration: 2,
      workspace: '/work/alpha',
      principal: 'lark/main/tenant/owner',
      principalRecordId: 'principal-owner',
      principalVersion: 4,
    }
    const { ctx, service, policy, prepareAgentApproval } = await harness(route)

    const proposal = service.propose(agent(), {
      idempotencyKey: 'wiki:delivery-route',
      mutation: mutation(),
    })

    expect(prepareAgentApproval).toHaveBeenCalledWith(
      expect.objectContaining({ session: expect.anything() }),
      { sourceId: PERSONAL_WIKI_APPROVAL_SOURCE },
    )
    const dispatches = policy.listPendingApprovalDispatches()
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0]).toMatchObject({
      proposalId: proposal.policyProposalId,
      sourceId: PERSONAL_WIKI_APPROVAL_SOURCE,
      bindingId: route.bindingId,
      workspace: route.workspace,
      principal: route.principal,
      requester: 'agent:primary',
      action: 'wiki.create',
      resource: { kind: 'wiki', id: proposal.write.pageId },
      summary: proposal.summary,
      diff: proposal.diff,
      expiresAt: proposal.expiresAt,
      proposalVersion: 1,
      state: 'pending',
    })
    expect(dispatches[0]?.diffHash).toBe(createHash('sha256').update(proposal.diff).digest('hex'))
    await ctx.fiber.restart()
  })

  test('rejects a model-forged principal and an inexact route workspace before Policy proposal creation', async () => {
    const exact: ApprovalDispatchRoute = {
      routeVersion: 2,
      sourceId: PERSONAL_WIKI_APPROVAL_SOURCE,
      bindingId: 'binding-owner-dm',
      bindingVersion: 3,
      bindingGeneration: 2,
      workspace: '/work/alpha',
      principal: 'lark/main/tenant/owner',
      principalRecordId: 'principal-owner',
      principalVersion: 4,
    }
    const first = await harness(exact)
    expect(() => first.service.propose(agent(), {
      idempotencyKey: 'wiki:forged-principal',
      principal: 'lark/main/tenant/attacker',
      mutation: mutation('Forged principal'),
    })).toThrowError(expect.objectContaining<Partial<PersonalWikiError>>({ code: 'unauthorized-principal' }))
    expect(first.policy.listPendingApprovalDispatches()).toEqual([])
    await first.ctx.fiber.restart()

    const second = await harness({ ...exact, workspace: '/work/other' })
    expect(() => second.service.propose(agent(), {
      idempotencyKey: 'wiki:wrong-workspace',
      mutation: mutation('Wrong workspace'),
    })).toThrowError(expect.objectContaining<Partial<PersonalWikiError>>({ code: 'missing-approval-route' }))
    expect(second.policy.listPendingApprovalDispatches()).toEqual([])
    await second.ctx.fiber.restart()
  })

  test('keeps an explicit principal only for trusted headless use and otherwise fails closed', async () => {
    const { ctx, service, policy } = await harness(false)
    const headless = service.propose(agent(), {
      idempotencyKey: 'wiki:headless',
      principal: 'owner:headless:primary',
      mutation: mutation('Headless'),
    })
    expect(headless.status).toBe('pending')
    expect(policy.listPendingApprovalDispatches()).toEqual([])

    expect(() => service.propose(agent(), {
      idempotencyKey: 'wiki:no-route',
      mutation: mutation('No route'),
    })).toThrowError(expect.objectContaining<Partial<PersonalWikiError>>({ code: 'missing-approval-route' }))
    await ctx.fiber.restart()
  })
})
