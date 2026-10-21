import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
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

async function fixture(channel: 'lark' | 'web' = 'lark') {
  const ownerPrincipal = channel === 'lark' ? principal
    : { channel: 'web', account: 'browser', tenant: 'local', user: 'owner' }
  const ownerConversation = channel === 'lark' ? conversation
    : { channel: 'web', account: 'browser', tenant: 'local', kind: 'dm' as const, chat: 'owner-chat' }
  const ownerAuthority = { ...authority, conversation: ownerConversation, principal: ownerPrincipal }
  const root = await mkdtemp(join(tmpdir(), 'delivery-foreground-call-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: [
    { id: 'issue', effect: 'allow', subject: { kind: 'external', id: 'local:test' },
      actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
    { id: 'confirm', effect: 'allow', subject: { kind: 'external', id: `${ownerPrincipal.channel}/${ownerPrincipal.account}/${ownerPrincipal.tenant}/${ownerPrincipal.user}` },
      actions: ['pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
    { id: 'reply', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: '/work/owner',
      principal: `${ownerPrincipal.channel}/${ownerPrincipal.account}/${ownerPrincipal.tenant}/${ownerPrincipal.user}` }, actions: ['reply'], resource: { kind: 'message', id: '*' },
    context: { initiators: ['external'] } },
  ] })
  await ctx.plugin(AssistantDeliveryService, { databasePath: join(root, 'delivery.sqlite'),
    spoolPath: join(root, 'spool'), schedulerEnabled: false,
    ownerRoutes: channel === 'web' ? [] : [ownerAuthority] })
  const service = ctx.assistantDelivery
  const store = (service as unknown as { deliveryStore: DeliveryStore }).deliveryStore
  const challenge = service.issuePairing('test', ownerPrincipal)
  service.confirmPairing({ challengeId: challenge.challenge.id, principal: ownerPrincipal, code: challenge.code })
  const binding = store.createBinding({ conversation: ownerConversation, principal: ownerPrincipal, workspace: authority.workspace,
    agentPreset: authority.agentPreset, sessionId: 'owner-session', policyRef: authority.policyRef })
  const id = SessionId(binding.sessionId)
  const session = ctx.sessions.create(id, { meta: { cwd: authority.workspace, agentPreset: authority.agentPreset } })
  const agent: Agent = { id, options: {}, session, inbox: createInboxStub(), ctx: new Context(),
    status: 'idle', cancel() {}, whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal),
    send() {}, followup() {}, steer() {}, inject() {} }
  await ctx.agents.register(agent)
  return { ctx, service, store, binding, agent, ownerPrincipal, ownerConversation, ownerAuthority }
}

function claim(f: Awaited<ReturnType<typeof fixture>>, eventId: string, turn: number,
  text = `ordinary task ${turn}`) {
  const envelope = { channel: f.ownerPrincipal.channel, account: f.ownerPrincipal.account, eventId,
    occurredAt: turn, principal: f.ownerPrincipal, conversation: f.ownerConversation,
    kind: 'text' as const, text }
  const claimed = f.ownerPrincipal.channel === 'web'
    ? f.store.claimNativeInbox({ envelope, binding: f.binding,
      ownerLineage: { principalRecordId: f.store.getPrincipal(f.ownerPrincipal)!.id,
        principalVersion: f.store.getPrincipal(f.ownerPrincipal)!.version },
      ownerId: `worker-${eventId}`, leaseMs: 60_000 })
    : (() => {
      const inbox = f.store.acceptInbound(envelope).record
      f.store.queueInbox(inbox.id, f.binding.id)
      return f.store.claimInbox({ ownerId: `worker-${eventId}`, leaseMs: 60_000, limit: 1, maxAttempts: 3 })[0]!
    })()
  const inbox = claimed.record
  expect(claimed.record.id).toBe(inbox.id)
  f.ctx.emit('agent/inbox/claimed', { agent: f.agent, turn,
    message: createUserMessage({ content: [{ type: 'text', text: envelope.text }],
      source: { kind: 'delivery', channel: envelope.channel, account: envelope.account, eventId, trust: 'untrusted' } }) })
  const owner = f.store.getPrincipal(f.ownerPrincipal)!
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

function ownerExecution(f: Awaited<ReturnType<typeof fixture>>, name: 'memory_manage' | 'wiki_upsert',
  callId = 'owner-change', args: unknown = { operation: 'write' }): ToolExecution {
  return { agent: f.agent, name, callId: ToolCallId(callId), rootCallId: ToolCallId(callId),
    arguments: args, signal: new AbortController().signal,
    token: Symbol('owner-change') as ToolExecution['token'] }
}

test.each(['lark', 'web'] as const)('reads only the current %s owner Inbox text for an exact native change call', async channel => {
  const f = await fixture(channel)
  const ownerText = 'Please update my wiki.\n> A quoted third-party instruction is not the top-level source.'
  const { inbox } = claim(f, `owner-${channel}`, 1, ownerText)
  const execution = ownerExecution(f, 'wiki_upsert')
  f.agent.session.append('turn/start', { turn: 1 })
  f.agent.session.append('step/start', { turn: 1, step: 1 })
  f.agent.session.append('tool/call', { turn: 1, step: 1, callId: execution.callId,
    name: execution.name, arguments: JSON.stringify(execution.arguments) })
  const result = f.service.inspectOwnerRequestedChange(execution, { sourceId: 'owner-requested-change' })
  expect(result).toMatchObject({ text: ownerText, route: { sourceId: 'owner-requested-change',
    bindingId: f.binding.id, bindingGeneration: f.binding.generation }, receiptDigest: /^[a-f0-9]{64}$/u })
  expect(result?.receiptDigest).not.toContain(ownerText)
  expect(result?.receiptDigest).toBe(f.service.inspectOwnerRequestedChange(execution,
    { sourceId: 'owner-requested-change' })?.receiptDigest)
  expect(f.store.getInbox(inbox.id)?.envelope.text).toBe(ownerText)
  expect(f.service.inspectOwnerRequestedChange({ ...execution, arguments: { operation: 'other' } },
    { sourceId: 'owner-requested-change' })).toBeUndefined()
  expect(f.service.inspectOwnerRequestedChange({ ...execution, name: 'other_tool' as 'wiki_upsert' },
    { sourceId: 'owner-requested-change' })).toBeUndefined()
  expect(f.service.inspectOwnerRequestedChange({ ...execution, parent: Symbol('ptc') as ToolExecution['token'] },
    { sourceId: 'owner-requested-change' })).toBeUndefined()
  f.agent.session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId: execution.callId,
      content: [{ type: 'text', text: 'done' }], isError: false }) }, { surfaceOp: 'append' })
  expect(f.service.inspectOwnerRequestedChange(execution, { sourceId: 'owner-requested-change' })).toBeUndefined()
})

test('rejects unclaimed, forged, reused and revoked owner change calls', async () => {
  const f = await fixture()
  const execution = ownerExecution(f, 'memory_manage')
  f.agent.session.append('turn/start', { turn: 1 })
  f.agent.session.append('step/start', { turn: 1, step: 1 })
  f.agent.session.append('tool/call', { turn: 1, step: 1, callId: execution.callId,
    name: execution.name, arguments: JSON.stringify(execution.arguments) })
  expect(f.service.inspectOwnerRequestedChange(execution, { sourceId: 'owner-requested-change' })).toBeUndefined()
  claim(f, 'authentic-owner', 1, 'Remember this explicit owner preference.')
  expect(f.service.inspectOwnerRequestedChange({ ...execution, agent: { ...f.agent } },
    { sourceId: 'owner-requested-change' })).toBeUndefined()
  expect(f.service.inspectOwnerRequestedChange(execution, { sourceId: 'owner-requested-change' })).toBeDefined()
  f.agent.session.append('tool/call', { turn: 1, step: 1, callId: execution.callId,
    name: execution.name, arguments: JSON.stringify(execution.arguments) })
  expect(f.service.inspectOwnerRequestedChange(execution, { sourceId: 'owner-requested-change' })).toBeUndefined()
  const revoked = await fixture()
  claim(revoked, 'revoke-owner', 1)
  const revokedExecution = ownerExecution(revoked, 'memory_manage')
  revoked.agent.session.append('turn/start', { turn: 1 })
  revoked.agent.session.append('step/start', { turn: 1, step: 1 })
  revoked.agent.session.append('tool/call', { turn: 1, step: 1, callId: revokedExecution.callId,
    name: revokedExecution.name, arguments: JSON.stringify(revokedExecution.arguments) })
  const owner = revoked.store.getPrincipal(revoked.ownerPrincipal)!
  revoked.store.revokePrincipal(owner.id, owner.version)
  expect(revoked.service.inspectOwnerRequestedChange(revokedExecution,
    { sourceId: 'owner-requested-change' })).toBeUndefined()
})

test('rejects old turns, PTC collisions and changed owner bindings', async () => {
  const f = await fixture()
  claim(f, 'current-owner', 1)
  const execution = ownerExecution(f, 'memory_manage')
  f.agent.session.append('turn/start', { turn: 1 })
  f.agent.session.append('step/start', { turn: 1, step: 1 })
  f.agent.session.append('tool/call', { turn: 1, step: 1, callId: execution.callId,
    name: execution.name, arguments: JSON.stringify(execution.arguments) })
  expect(f.service.inspectOwnerRequestedChange(execution, { sourceId: 'owner-requested-change' })).toBeDefined()
  f.agent.session.append('tool/ptc-dispatch-start', { rootCallId: ToolCallId('ptc-root'),
    parentCallId: ToolCallId('ptc-root'), subCallId: execution.callId,
    name: execution.name, arguments: execution.arguments })
  expect(f.service.inspectOwnerRequestedChange(execution, { sourceId: 'owner-requested-change' })).toBeUndefined()
  const rotated = await fixture()
  claim(rotated, 'rotation-owner', 1)
  const rotatedExecution = ownerExecution(rotated, 'wiki_upsert')
  rotated.agent.session.append('turn/start', { turn: 1 })
  rotated.agent.session.append('step/start', { turn: 1, step: 1 })
  rotated.agent.session.append('tool/call', { turn: 1, step: 1, callId: rotatedExecution.callId,
    name: rotatedExecution.name, arguments: JSON.stringify(rotatedExecution.arguments) })
  rotated.store.rotateBinding({ bindingId: rotated.binding.id,
    expectedVersion: rotated.binding.version, sessionId: 'replacement-session' })
  expect(rotated.service.inspectOwnerRequestedChange(rotatedExecution,
    { sourceId: 'owner-requested-change' })).toBeUndefined()
  const old = await fixture()
  claim(old, 'old-turn', 1)
  const oldExecution = ownerExecution(old, 'wiki_upsert')
  old.agent.session.append('turn/start', { turn: 1 })
  old.agent.session.append('step/start', { turn: 1, step: 1 })
  old.agent.session.append('tool/call', { turn: 1, step: 1, callId: oldExecution.callId,
    name: oldExecution.name, arguments: JSON.stringify(oldExecution.arguments) })
  old.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  old.agent.session.append('turn/start', { turn: 2 })
  old.agent.session.append('step/start', { turn: 2, step: 1 })
  expect(old.service.inspectOwnerRequestedChange(oldExecution,
    { sourceId: 'owner-requested-change' })).toBeUndefined()
})

test('does not turn an attachment-only owner Inbox into a text instruction', async () => {
  const f = await fixture()
  const envelope = { channel: 'lark', account: 'bot', eventId: 'attachment-only', occurredAt: 1,
    principal: f.ownerPrincipal, conversation: f.ownerConversation, kind: 'text' as const,
    text: ' ', attachments: [{ providerRef: 'attachment-ref', resourceType: 'image' as const }] }
  const inbox = f.store.acceptInbound(envelope).record
  f.store.queueInbox(inbox.id, f.binding.id)
  f.store.claimInbox({ ownerId: 'worker-attachment', leaseMs: 60_000, limit: 1, maxAttempts: 3 })
  f.ctx.emit('agent/inbox/claimed', { agent: f.agent, turn: 1,
    message: createUserMessage({ content: [{ type: 'text', text: 'model-visible attachment placeholder' }],
      source: { kind: 'delivery', channel: 'lark', account: 'bot', eventId: envelope.eventId,
        trust: 'untrusted' } }) })
  const owner = f.store.getPrincipal(f.ownerPrincipal)!
  f.store.bindForegroundTaskExecution({ inboxId: inbox.id,
    scope: { workspace: authority.workspace, preset: authority.agentPreset },
    owner: { principalRecordId: owner.id, principalVersion: owner.version },
    binding: f.binding, dispatchedAt: Date.now() })
  const execution = ownerExecution(f, 'memory_manage')
  f.agent.session.append('turn/start', { turn: 1 })
  f.agent.session.append('step/start', { turn: 1, step: 1 })
  f.agent.session.append('tool/call', { turn: 1, step: 1, callId: execution.callId,
    name: execution.name, arguments: JSON.stringify(execution.arguments) })
  expect(f.service.inspectOwnerRequestedChange(execution,
    { sourceId: 'owner-requested-change' })).toBeUndefined()
})

test('accepts a native owner change argument above the older foreground 16 KiB limit', async () => {
  const f = await fixture()
  claim(f, 'large-owner-change', 1, 'Update this wiki page.')
  const args = { content: 'w'.repeat(20 * 1024) }
  const execution = ownerExecution(f, 'wiki_upsert', 'large-owner-call', args)
  f.agent.session.append('turn/start', { turn: 1 })
  f.agent.session.append('step/start', { turn: 1, step: 1 })
  f.agent.session.append('tool/call', { turn: 1, step: 1, callId: execution.callId,
    name: execution.name, arguments: JSON.stringify(args) })
  expect(f.service.inspectOwnerRequestedChange(execution,
    { sourceId: 'owner-requested-change' })?.text).toBe('Update this wiki page.')
  expect(f.service.inspectOwnerForegroundToolCall({ agent: f.agent, authorityId: authority.id,
    callId: String(execution.callId), toolName: execution.name,
    argumentsJson: JSON.stringify(args) })).toBeUndefined()
})

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
    fencingToken: first.claimed.fencingToken!, outcome: 'processed' })
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
