import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { AssistantDeliveryService } from '../src/service.ts'
import { DeliveryStore } from '../src/store.ts'

const roots: string[] = []
const contexts: Context[] = []
const principal = { channel: 'lark', account: 'bot', tenant: 'tenant', user: 'owner' }
const conversation = { channel: 'lark', account: 'bot', tenant: 'tenant', kind: 'dm' as const, chat: 'owner-chat' }
const authority = { id: 'owner-route', conversation, principal, workspace: '/work/owner',
  agentPreset: 'primary', policyRef: 'owner-dm', minimumGeneration: 1 }

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'delivery-owner-agent-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: [
    { id: 'issue', effect: 'allow', subject: { kind: 'external', id: 'local:test' },
      actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' },
      context: { initiators: ['foreground'] } },
    { id: 'confirm', effect: 'allow', subject: { kind: 'external', id: 'lark/bot/tenant/owner' },
      actions: ['pair.confirm'], resource: { kind: 'message', id: 'pairing' },
      context: { initiators: ['external'] } },
  ] })
  await ctx.plugin(AssistantDeliveryService, { databasePath: join(root, 'delivery.sqlite'),
    spoolPath: join(root, 'spool'), schedulerEnabled: false, ownerRoutes: [authority] })
  const service = ctx.assistantDelivery
  const store = (service as unknown as { deliveryStore: DeliveryStore }).deliveryStore
  const challenge = service.issuePairing('test', principal)
  service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
  const binding = store.createBinding({ conversation, principal, workspace: authority.workspace,
    agentPreset: authority.agentPreset, sessionId: 'owner-session-1', policyRef: authority.policyRef })
  return { ctx, service, store, binding }
}

function register(ctx: Context, sessionId: string): Agent {
  const id = SessionId(sessionId)
  const session = ctx.sessions.create(id, { meta: { cwd: authority.workspace, agentPreset: authority.agentPreset } })
  const agent: Agent = { id, options: {}, session, inbox: createInboxStub(), ctx: new Context(),
    status: 'idle', cancel() {}, whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal),
    send() {}, followup() {}, steer() {}, inject() {} }
  ctx.agents.register(agent)
  return agent
}

test('attests only the registered live Agent and Session on the exact owner route', async () => {
  const f = await fixture()
  const agent = register(f.ctx, f.binding.sessionId)
  const receipt = f.service.validateOwnerAgentForRoute(agent, authority.id)
  expect(receipt).toEqual(f.service.validateOwnerRoute({ authorityId: authority.id,
    principalId: 'lark/bot/tenant/owner', workspace: authority.workspace, agentPreset: authority.agentPreset }))
  expect(Object.isFrozen(receipt)).toBe(true)
  expect(receipt).not.toHaveProperty('sessionId')
  expect(receipt).not.toHaveProperty('bindingId')
  expect(f.service.validateOwnerAgentForRoute({ ...agent } as Agent, authority.id)).toBeUndefined()
  expect(f.service.validateOwnerAgentForRoute({ ...agent, session: {
    ...agent.session, id: agent.session.id, header: agent.session.header,
  } } as Agent, authority.id)).toBeUndefined()
  expect(f.service.validateOwnerAgentForRoute({ ...agent, id: SessionId('other-id') }, authority.id)).toBeUndefined()
  expect(f.service.validateOwnerAgentForRoute(agent, 'wrong-route')).toBeUndefined()
})

test('rejects stale, revoked, and principal-mismatched owners, then accepts the new live session', async () => {
  const f = await fixture()
  const oldAgent = register(f.ctx, f.binding.sessionId)
  const second = f.store.rotateBinding({ bindingId: f.binding.id, expectedVersion: f.binding.version,
    sessionId: 'owner-session-2' })
  expect(f.service.validateOwnerAgentForRoute(oldAgent, authority.id)).toBeUndefined()
  const nextAgent = register(f.ctx, second.sessionId)
  expect(f.service.validateOwnerAgentForRoute(nextAgent, authority.id)?.generation).toBe(2)
  const principalRow = f.store.getPrincipal(principal)!
  f.store.revokePrincipal(principalRow.id, principalRow.version)
  expect(f.service.validateOwnerAgentForRoute(nextAgent, authority.id)).toBeUndefined()
})

test('fails closed without core Host services and on a changed principal lineage during validation', async () => {
  const f = await fixture()
  const agent = register(f.ctx, f.binding.sessionId)
  const original = f.service.preferencePrincipalForAgent.bind(f.service)
  vi.spyOn(f.service, 'preferencePrincipalForAgent').mockImplementation(caller => {
    const value = original(caller)
    return value === undefined ? undefined : { ...value, principalLineage: {
      ...value.principalLineage, principalVersion: value.principalLineage.principalVersion + 1,
    } }
  })
  expect(f.service.validateOwnerAgentForRoute(agent, authority.id)).toBeUndefined()
  vi.restoreAllMocks()
  vi.spyOn(f.ctx, 'get').mockReturnValue(undefined)
  expect(f.service.validateOwnerAgentForRoute(agent, authority.id)).toBeUndefined()
})

test('read fence rejects rotation after receipt creation and propagates unexpected store errors', async () => {
  const f = await fixture()
  const agent = register(f.ctx, f.binding.sessionId)
  const original = f.service.validateOwnerRoute.bind(f.service)
  vi.spyOn(f.service, 'validateOwnerRoute').mockImplementation(input => {
    const receipt = original(input)
    f.store.rotateBinding({ bindingId: f.binding.id, expectedVersion: f.binding.version,
      sessionId: 'owner-session-2' })
    return receipt
  })
  expect(f.service.validateOwnerAgentForRoute(agent, authority.id)).toBeUndefined()
  vi.restoreAllMocks()
  vi.spyOn(f.service, 'preferencePrincipalForAgent').mockImplementation(() => {
    throw new Error('database read failed')
  })
  expect(() => f.service.validateOwnerAgentForRoute(agent, authority.id)).toThrow('database read failed')
})
