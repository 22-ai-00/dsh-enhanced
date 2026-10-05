import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { AssistantDeliveryService } from '../src/service.ts'
import { DeliveryStore } from '../src/store.ts'

const roots: string[] = []
const contexts: Context[] = []
const principal = { channel: 'lark', account: 'bot', tenant: 'tenant', user: 'owner' }
const conversation = { channel: 'lark', account: 'bot', tenant: 'tenant', kind: 'dm' as const, chat: 'owner-chat' }
const authority = { id: 'owner-route', conversation, principal, workspace: '/work/owner',
  agentPreset: 'primary', policyRef: 'owner-dm', minimumGeneration: 1 }

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'delivery-foreground-call-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: [
    { id: 'issue', effect: 'allow', subject: { kind: 'external', id: 'local:test' },
      actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
    { id: 'confirm', effect: 'allow', subject: { kind: 'external', id: 'lark/bot/tenant/owner' },
      actions: ['pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
    { id: 'reply', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: '/work/owner',
      principal: 'lark/bot/tenant/owner' }, actions: ['reply'], resource: { kind: 'message', id: '*' },
    context: { initiators: ['external'] } },
  ] })
  await ctx.plugin(AssistantDeliveryService, { databasePath: join(root, 'delivery.sqlite'),
    spoolPath: join(root, 'spool'), schedulerEnabled: false, ownerRoutes: [authority] })
  const service = ctx.assistantDelivery
  const store = (service as unknown as { deliveryStore: DeliveryStore }).deliveryStore
  const challenge = service.issuePairing('test', principal)
  service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
  const binding = store.createBinding({ conversation, principal, workspace: authority.workspace,
    agentPreset: authority.agentPreset, sessionId: 'owner-session', policyRef: authority.policyRef })
  const id = SessionId(binding.sessionId)
  const session = ctx.sessions.create(id, { meta: { cwd: authority.workspace, agentPreset: authority.agentPreset } })
  const agent: Agent = { id, options: {}, session, inbox: createInboxStub(), ctx: new Context(),
    status: 'idle', cancel() {}, whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal),
    send() {}, followup() {}, steer() {}, inject() {} }
  ctx.agents.register(agent)
  return { ctx, service, store, binding, agent }
}

function claim(f: Awaited<ReturnType<typeof fixture>>, eventId: string, turn: number) {
  const envelope = { channel: 'lark', account: 'bot', eventId, occurredAt: turn, principal, conversation,
    kind: 'text' as const, text: `ordinary task ${turn}` }
  const inbox = f.store.acceptInbound(envelope).record
  f.store.queueInbox(inbox.id, f.binding.id)
  const claimed = f.store.claimInbox({ ownerId: `worker-${eventId}`, leaseMs: 60_000, limit: 1, maxAttempts: 3 })[0]!
  expect(claimed.record.id).toBe(inbox.id)
  f.ctx.emit('agent/inbox/claimed', { agent: f.agent, turn,
    message: createUserMessage({ content: [{ type: 'text', text: envelope.text }],
      source: { kind: 'delivery', channel: 'lark', account: 'bot', eventId, trust: 'untrusted' } }) })
  const owner = f.store.getPrincipal(principal)!
  f.store.bindForegroundTaskExecution({ inboxId: inbox.id,
    scope: { workspace: authority.workspace, preset: authority.agentPreset },
    owner: { principalRecordId: owner.id, principalVersion: owner.version },
    binding: f.binding, dispatchedAt: Date.now() })
  return { inbox, claimed }
}

function appendCall(agent: Agent, turn: number, callId: string, argumentsJson = '{ "value": 7 }') {
  agent.session.append('turn/start', { turn })
  agent.session.append('step/start', { turn, step: 1 })
  const event = agent.session.append('tool/call', { turn, step: 1, callId: ToolCallId(callId),
    name: 'created_tool', arguments: argumentsJson })
  return event
}

function request(f: Awaited<ReturnType<typeof fixture>>, callId = 'native-call', argumentsJson = '{"value":7}') {
  return { agent: f.agent, authorityId: authority.id, callId, toolName: 'created_tool', argumentsJson }
}

test('attests one registered native call with the exact pending owner Inbox and frozen content-free digests', async () => {
  const f = await fixture()
  const { inbox } = claim(f, 'event-1', 1)
  expect(f.service.inspectOwnerForegroundToolCall(request(f))).toBeUndefined()
  const event = appendCall(f.agent, 1, 'native-call')
  expect(f.service.validateOwnerAgentForRoute(f.agent, authority.id)).toBeDefined()
  expect(f.service.currentPreferenceTurn(f.agent)).toBeDefined()
  expect(f.store.inspectPendingForegroundToolTask({ inboxId: inbox.id, sessionId: f.binding.sessionId,
    scope: { workspace: authority.workspace, preset: authority.agentPreset },
    owner: { principalRecordId: f.store.getPrincipal(principal)!.id, principalVersion: 1 },
    binding: { id: f.binding.id, version: f.binding.version, generation: f.binding.generation } })).toBeDefined()
  const actual = f.service.inspectOwnerForegroundToolCall(request(f))
  expect(actual).toEqual({ protocol: 'assistant-delivery/foreground-tool-call/v1',
    task: { protocol: 'assistant-delivery/foreground-task/v1', inboxId: inbox.id,
      sessionId: f.binding.sessionId, scope: { workspace: authority.workspace, preset: authority.agentPreset },
      owner: { principalRecordId: f.store.getPrincipal(principal)!.id, principalVersion: 1 },
      binding: { id: f.binding.id, version: f.binding.version, generation: f.binding.generation },
      dispatchedAt: expect.any(Number) },
    turn: 1, call: { id: 'native-call', toolName: 'created_tool', eventSeq: event.seq,
      eventDigest: createHash('sha256').update(JSON.stringify(['tool/call', event.seq, 1, 1,
        'native-call', 'created_tool', '{ "value": 7 }'])).digest('hex'),
      argumentsDigest: createHash('sha256').update('{"value":7}').digest('hex') } })
  expect(Object.isFrozen(actual)).toBe(true)
  expect(Object.isFrozen(actual?.task)).toBe(true)
  expect(Object.isFrozen(actual?.task.binding)).toBe(true)
  expect(Object.isFrozen(actual?.task.scope)).toBe(true)
  expect(Object.isFrozen(actual?.task.owner)).toBe(true)
  expect(Object.isFrozen(actual?.call)).toBe(true)
  expect(JSON.stringify(actual)).not.toContain('ordinary task')
  expect(JSON.stringify(actual)).not.toContain('"value"')
  f.agent.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('parallel-call'),
    name: 'created_tool', arguments: '{"value":7}' })
  expect(f.service.inspectOwnerForegroundToolCall(request(f))?.call.id).toBe('native-call')
  expect(f.service.inspectOwnerForegroundToolCall(request(f, 'parallel-call'))?.call.id).toBe('parallel-call')
  f.agent.session.append('step/end', { turn: 1, step: 1 })
  expect(f.service.inspectOwnerForegroundToolCall(request(f))).toBeUndefined()
  expect(f.service.inspectOwnerForegroundToolCall(request(f, 'parallel-call'))).toBeUndefined()
})

test('rejects fake Agent, open unrelated turn, mismatched arguments, duplicate and settled native calls', async () => {
  const f = await fixture()
  claim(f, 'event-2', 1)
  appendCall(f.agent, 1, 'native-call')
  const valid = request(f)
  expect(f.service.inspectOwnerForegroundToolCall({ ...valid, agent: { ...f.agent } })).toBeUndefined()
  expect(f.service.inspectOwnerForegroundToolCall({ ...valid, callId: 'old-call' })).toBeUndefined()
  expect(f.service.inspectOwnerForegroundToolCall({ ...valid, toolName: 'other_tool' })).toBeUndefined()
  expect(f.service.inspectOwnerForegroundToolCall({ ...valid, argumentsJson: '{ "value":7}' })).toBeUndefined()
  expect(f.service.inspectOwnerForegroundToolCall({ ...valid, argumentsJson: 'not json' })).toBeUndefined()
  f.agent.session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId: ToolCallId('native-call'),
      content: [{ type: 'text', text: 'done' }], isError: false }) }, { surfaceOp: 'append' })
  expect(f.service.inspectOwnerForegroundToolCall(valid)).toBeUndefined()
  const duplicate = await fixture()
  claim(duplicate, 'event-duplicate', 1)
  appendCall(duplicate.agent, 1, 'native-call')
  const duplicateRequest = request(duplicate)
  duplicate.agent.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('native-call'),
    name: 'created_tool', arguments: '{}' })
  expect(duplicate.service.inspectOwnerForegroundToolCall(duplicateRequest)).toBeUndefined()
  const ptc = await fixture()
  claim(ptc, 'event-ptc', 1)
  appendCall(ptc.agent, 1, 'native-call')
  ptc.agent.session.append('tool/ptc-dispatch-start', { rootCallId: ToolCallId('root-call'),
    parentCallId: ToolCallId('root-call'), subCallId: ToolCallId('native-call'),
    name: 'created_tool', arguments: { value: 7 } })
  expect(ptc.service.inspectOwnerForegroundToolCall(request(ptc))).toBeUndefined()
  const late = await fixture()
  claim(late, 'event-late', 1)
  late.agent.session.append('turn/start', { turn: 1 })
  late.agent.session.append('step/start', { turn: 1, step: 1 })
  late.agent.session.append('step/end', { turn: 1, step: 1 })
  late.agent.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('native-call'),
    name: 'created_tool', arguments: '{"value":7}' })
  expect(late.service.inspectOwnerForegroundToolCall(request(late))).toBeUndefined()
  duplicate.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  duplicate.agent.session.append('turn/start', { turn: 2 })
  duplicate.agent.session.append('step/start', { turn: 2, step: 1 })
  duplicate.agent.session.append('tool/call', { turn: 2, step: 1, callId: ToolCallId('new-call'),
    name: 'created_tool', arguments: '{}' })
  expect(duplicate.service.inspectOwnerForegroundToolCall({ ...duplicateRequest, callId: 'new-call', argumentsJson: '{}' })).toBeUndefined()
})

test('does not attribute an older call to another Inbox in the same Session', async () => {
  const f = await fixture()
  const first = claim(f, 'event-first', 1)
  appendCall(f.agent, 1, 'reused-call')
  expect(f.service.inspectOwnerForegroundToolCall(request(f, 'reused-call'))).toBeDefined()
  f.agent.session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId: ToolCallId('reused-call'),
      content: [{ type: 'text', text: 'done' }], isError: false }) }, { surfaceOp: 'append' })
  f.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  f.store.finishForegroundTaskExecution({ inboxId: first.inbox.id, status: 'succeeded', quiescent: true, completedAt: Date.now() })
  f.store.finishInbox({ inboxId: first.inbox.id, ownerId: first.claimed.record.claimedBy!,
    fencingToken: first.claimed.fencingToken, outcome: 'processed' })
  const second = claim(f, 'event-second', 2)
  expect(f.service.inspectOwnerForegroundToolCall(request(f, 'reused-call'))).toBeUndefined()
  appendCall(f.agent, 2, 'reused-call')
  expect(f.service.inspectOwnerForegroundToolCall(request(f, 'reused-call'))).toBeUndefined()
  const other = f.agent.session.append('tool/call', { turn: 2, step: 1,
    callId: ToolCallId('fresh-call'), name: 'created_tool', arguments: '{"value":7}' })
  expect(f.service.inspectOwnerForegroundToolCall(request(f, 'fresh-call'))?.task.inboxId).toBe(second.inbox.id)
  expect(other.seq).toBeGreaterThan(0)
  f.store.finishForegroundTaskExecution({ inboxId: second.inbox.id, status: 'succeeded', quiescent: true, completedAt: Date.now() })
  expect(f.service.inspectOwnerForegroundToolCall(request(f, 'fresh-call'))).toBeUndefined()
})

test('rejects owner rotation and binding drift even while the original call remains open', async () => {
  const f = await fixture()
  claim(f, 'event-rotation', 1)
  appendCall(f.agent, 1, 'native-call')
  expect(f.service.inspectOwnerForegroundToolCall(request(f))).toBeDefined()
  f.store.rotateBinding({ bindingId: f.binding.id, expectedVersion: f.binding.version,
    sessionId: 'owner-session-new' })
  expect(f.service.inspectOwnerForegroundToolCall(request(f))).toBeUndefined()
  const revoked = await fixture()
  claim(revoked, 'event-revoked', 1)
  appendCall(revoked.agent, 1, 'native-call')
  const owner = revoked.store.getPrincipal(principal)!
  revoked.store.revokePrincipal(owner.id, owner.version)
  expect(revoked.service.inspectOwnerForegroundToolCall(request(revoked))).toBeUndefined()
})
