import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { AssistantDeliveryService } from '../src/service.ts'
import { DeliveryStore } from '../src/store.ts'
import type { ConversationBinding, ConversationRef, ExternalPrincipalKey } from '../src/types.ts'

const roots: string[] = []
const contexts: Context[] = []
const owner = { channel: 'lark', account: 'bot', tenant: 'tenant', user: 'owner' }
const ownerConversation = { channel: 'lark', account: 'bot', tenant: 'tenant', kind: 'dm' as const, chat: 'owner-chat' }
const alias = { channel: 'telegram', account: 'bot-tg', tenant: 'personal', user: 'alias' }
const aliasConversation = { channel: 'telegram', account: 'bot-tg', tenant: 'personal', kind: 'dm' as const, chat: 'alias-chat' }
const authority = { id: 'owner-route', conversation: ownerConversation, principal: owner, workspace: '/work/owner',
  agentPreset: 'primary', policyRef: 'owner-dm', minimumGeneration: 1 }
const id = (key: ExternalPrincipalKey) => `${key.channel}/${key.account}/${key.tenant}/${key.user}`

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'delivery-owner-alias-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: [
    { id: 'issue', effect: 'allow', subject: { kind: 'external', id: 'local:test' },
      actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
    ...[owner, alias].map(key => ({ id: `confirm-${key.user}`, effect: 'allow' as const, subject: { kind: 'external' as const, id: id(key) },
      actions: ['pair.confirm', 'ingest'], resource: { kind: 'message' as const, id: '*' }, context: { initiators: ['external' as const] } })),
    ...[owner, alias].map(key => ({ id: `reply-${key.user}`, effect: 'allow' as const, subject: { kind: 'agent' as const, id: 'primary',
      workspace: '/work/owner', principal: id(key) }, actions: ['reply'], resource: { kind: 'message' as const, id: '*' },
    context: { initiators: ['external' as const] } })),
  ] })
  await ctx.plugin(AssistantDeliveryService, { databasePath: join(root, 'delivery.sqlite'),
    spoolPath: join(root, 'spool'), schedulerEnabled: false, ownerRoutes: [authority] })
  const service = ctx.assistantDelivery
  const store = (service as unknown as { deliveryStore: DeliveryStore }).deliveryStore
  const pair = (key: ExternalPrincipalKey) => {
    const challenge = service.issuePairing('test', key)
    return service.confirmPairing({ challengeId: challenge.challenge.id, principal: key, code: challenge.code })
  }
  pair(owner)
  const candidate = pair(alias)
  const agentFor = async (conversation: ConversationRef, principal: ExternalPrincipalKey, sessionId: string) => {
    const binding = store.createBinding({ conversation, principal, workspace: authority.workspace,
      agentPreset: authority.agentPreset, sessionId, policyRef: authority.policyRef })
    const sid = SessionId(binding.sessionId)
    const session = ctx.sessions.create(sid, { meta: { cwd: authority.workspace, agentPreset: authority.agentPreset } })
    const agent: Agent = { id: sid, options: {}, session, inbox: createInboxStub(), ctx: new Context(),
      status: 'idle', cancel() {}, whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal),
      send() {}, followup() {}, steer() {}, inject() {} }
    await ctx.agents.register(agent)
    return { binding, agent }
  }
  const ownerSide = await agentFor(ownerConversation, owner, 'owner-session')
  const aliasSide = await agentFor(aliasConversation, alias, 'alias-session')
  const link = () => store.linkPrincipal({ owner, linked: alias, expectedLinkedVersion: store.getPrincipal(alias)!.version })
  return { ctx, service, store, pair, candidate, ownerSide, aliasSide, link }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

function claimAlias(f: Fixture, binding: ConversationBinding, agent: Agent, eventId: string, turn: number) {
  const envelope = { channel: alias.channel, account: alias.account, eventId, occurredAt: turn,
    principal: alias, conversation: aliasConversation, kind: 'text' as const, text: `list my work items ${turn}` }
  const inbox = f.store.acceptInbound(envelope).record
  f.store.queueInbox(inbox.id, binding.id)
  const claimed = f.store.claimInbox({ ownerId: `worker-${eventId}`, leaseMs: 60_000, limit: 1, maxAttempts: 3 })[0]!
  expect(claimed.record.id).toBe(inbox.id)
  f.ctx.emit('agent/inbox/claimed', { agent, turn,
    message: createUserMessage({ content: [{ type: 'text', text: envelope.text }],
      source: { kind: 'delivery', channel: envelope.channel, account: envelope.account, eventId, trust: 'untrusted' } }) })
  agent.session.append('turn/start', { turn })
  agent.session.append('step/start', { turn, step: 1 })
  agent.session.append('tool/call', { turn, step: 1, callId: ToolCallId(`call-${turn}`),
    name: 'work_item_list', arguments: '{}' })
  return { inbox, claimed }
}

const callFor = (agent: Agent, turn: number) => ({ agent, authorityId: authority.id, callId: `call-${turn}`,
  toolName: 'work_item_list', argumentsJson: '{}' })

test('a linked alias gets a distinct read-only receipt rooted in the current owner', async () => {
  const f = await fixture()
  const { agent } = f.aliasSide
  expect(f.candidate).toMatchObject({ role: 'linked', status: 'active' })
  expect(f.candidate.linkedToId).toBeUndefined()
  // A linked principal with NULL linked_to_id is not an alias of anyone.
  const first = claimAlias(f, f.aliasSide.binding, agent, 'unlinked', 1)
  expect(f.service.inspectOwnerAliasRoute(agent, authority.id)).toBeUndefined()
  expect(f.service.inspectOwnerAliasForegroundToolCall(callFor(agent, 1))).toBeUndefined()

  const linked = f.link()
  const rootRow = f.store.getPrincipal(owner)!
  expect(linked).toMatchObject({ role: 'linked', linkedToId: rootRow.id })
  const receipt = f.service.inspectOwnerAliasRoute(agent, authority.id)
  expect(receipt).toEqual({ protocol: 'assistant-delivery/owner-alias-receipt/v1', authorityId: authority.id,
    authorityHash: expect.any(String), workspace: authority.workspace, agentPreset: authority.agentPreset,
    alias: { principalId: id(alias), principalRecordId: linked.id, principalVersion: linked.version,
      bindingId: f.aliasSide.binding.id, bindingVersion: f.aliasSide.binding.version,
      bindingGeneration: f.aliasSide.binding.generation, sessionId: 'alias-session' },
    root: { principalId: id(owner), principalRecordId: rootRow.id, principalVersion: rootRow.version,
      bindingVersion: f.ownerSide.binding.version, generation: f.ownerSide.binding.generation } })
  expect(Object.isFrozen(receipt)).toBe(true)
  expect(receipt).not.toHaveProperty('receiptVersion')
  const v2 = f.service.validateOwnerAgentForRoute(f.ownerSide.agent, authority.id)
  expect(v2?.receiptVersion).toBe(2)
  expect(receipt?.authorityHash).toBe(v2?.authorityHash)

  // The turn captured before linking is not an alias turn; a fresh claimed turn is.
  expect(f.service.inspectOwnerAliasForegroundToolCall(callFor(agent, 1))).toBeUndefined()
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  f.store.finishInbox({ inboxId: first.inbox.id, ownerId: first.claimed.record.claimedBy!,
    fencingToken: first.claimed.fencingToken!, outcome: 'processed' })
  claimAlias(f, f.aliasSide.binding, agent, 'linked-turn', 2)
  const proof = f.service.inspectOwnerAliasForegroundToolCall(callFor(agent, 2))
  expect(proof).toMatchObject({ protocol: 'assistant-delivery/owner-alias-foreground-tool-call/v1', receipt, turn: 2,
    call: { id: 'call-2', toolName: 'work_item_list' } })
  expect(JSON.stringify(proof)).not.toContain('list my work items')
  expect(f.service.inspectOwnerAliasForegroundToolCall({ ...callFor(agent, 2), argumentsJson: '{"limit":1}' })).toBeUndefined()
  expect(f.service.inspectOwnerAliasForegroundToolCall({ ...callFor(agent, 2), agent: { ...agent } })).toBeUndefined()

  // Owner-only surfaces stay owner-only for the alias Agent.
  expect(f.service.validateOwnerAgentForRoute(agent, authority.id)).toBeUndefined()
  expect(f.service.inspectOwnerForegroundToolCall(callFor(agent, 2))).toBeUndefined()
  expect(f.service.currentPreferenceTurn(agent)).toBeUndefined()
  expect(() => f.service.prepareAgentApproval(agent, { sourceId: 'alias-approval' })).toThrow()
  // And the exact owner is not an alias.
  expect(f.service.inspectOwnerAliasRoute(f.ownerSide.agent, authority.id)).toBeUndefined()

  agent.session.append('tool/result', { turn: 2, step: 1, message: createToolResultMessage({ callId: ToolCallId('call-2'),
    content: [{ type: 'text', text: 'done' }], isError: false }) }, { surfaceOp: 'append' })
  expect(f.service.inspectOwnerAliasForegroundToolCall(callFor(agent, 2))).toBeUndefined()
})

test('unlinking the alias, an owner version change, and an owner handoff all change or revoke the receipt', async () => {
  const f = await fixture()
  f.link()
  const before = f.service.inspectOwnerAliasRoute(f.aliasSide.agent, authority.id)!
  // Owner re-pair bumps the root version: the receipt is no longer the same (ABA-visible).
  f.pair(owner)
  const after = f.service.inspectOwnerAliasRoute(f.aliasSide.agent, authority.id)!
  expect(after.root.principalRecordId).toBe(before.root.principalRecordId)
  expect(after.root.principalVersion).toBe(before.root.principalVersion + 1)

  // Unlink (revoke the alias principal) revokes the alias binding and the receipt.
  const aliasRow = f.store.getPrincipal(alias)!
  f.store.revokePrincipal(aliasRow.id, aliasRow.version)
  expect(f.service.inspectOwnerAliasRoute(f.aliasSide.agent, authority.id)).toBeUndefined()

  const handoff = await fixture()
  handoff.link()
  expect(handoff.service.inspectOwnerAliasRoute(handoff.aliasSide.agent, authority.id)).toBeDefined()
  handoff.store.handoffOwner({ channel: 'lark', account: 'bot', tenant: 'tenant', user: 'replacement' })
  expect(handoff.service.inspectOwnerAliasRoute(handoff.aliasSide.agent, authority.id)).toBeUndefined()

  const ownerRevoked = await fixture()
  ownerRevoked.link()
  const root = ownerRevoked.store.getPrincipal(owner)!
  ownerRevoked.store.revokePrincipal(root.id, root.version)
  expect(ownerRevoked.service.inspectOwnerAliasRoute(ownerRevoked.aliasSide.agent, authority.id)).toBeUndefined()
})

test('an alias binding in another workspace or a rotated alias binding is not an alias route', async () => {
  const f = await fixture()
  f.link()
  claimAlias(f, f.aliasSide.binding, f.aliasSide.agent, 'rotating', 1)
  expect(f.service.inspectOwnerAliasForegroundToolCall(callFor(f.aliasSide.agent, 1))).toBeDefined()
  f.store.rotateBinding({ bindingId: f.aliasSide.binding.id, expectedVersion: f.aliasSide.binding.version,
    sessionId: 'alias-session-new' })
  expect(f.service.inspectOwnerAliasRoute(f.aliasSide.agent, authority.id)).toBeUndefined()
  expect(f.service.inspectOwnerAliasForegroundToolCall(callFor(f.aliasSide.agent, 1))).toBeUndefined()
  expect(f.service.inspectOwnerAliasRoute(f.aliasSide.agent, 'unknown-route')).toBeUndefined()
})
