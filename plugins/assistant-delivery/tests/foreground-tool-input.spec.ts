import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ToolCallId, createToolResultMessage, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { AssistantDeliveryService } from '../src/service.ts'
import { DeliveryStore } from '../src/store.ts'

// Real Cordis, AgentLoop-created Agent, native Session events, Delivery/Policy and
// persisted Inbox/execution. No provider calls: the supplier throws if dispatched.
class NeverDispatched extends LlmAdapter {
  calls = 0
  override async resolveModel(provider: string, id: string) { return { provider, id, name: id, inputModalities: ['text'] as const } }
  override stream(_request: GenerateOptions): AsyncIterable<StreamChunk> { this.calls++; throw new Error('unexpected model dispatch') }
}
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'delivery-tool-input-')), ctx = new Context(), supplier = new NeverDispatched()
  let handle: AgentHandle | undefined
  cleanup.push(async () => { expect(supplier.calls).toBe(0); try { await handle?.dispose(); await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })
  ctx.llm.registerAdapter(['local-proof'], supplier)
  const principal = { channel: 'lark', account: 'bot', tenant: 'tenant', user: 'owner' }
  const conversation = { channel: 'lark', account: 'bot', tenant: 'tenant', kind: 'dm' as const, chat: 'owner-chat' }
  const authority = { id: 'owner-route', conversation, principal, workspace: root, agentPreset: 'primary', policyRef: 'owner-dm', minimumGeneration: 1 }
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: [
    { id: 'issue', effect: 'allow', subject: { kind: 'external', id: 'local:test' }, actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
    { id: 'confirm', effect: 'allow', subject: { kind: 'external', id: 'lark/bot/tenant/owner' }, actions: ['pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
    { id: 'reply', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: root, principal: 'lark/bot/tenant/owner' }, actions: ['reply'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
  ] }).await()
  await ctx.plugin(AssistantDeliveryService, { databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'), schedulerEnabled: false, ownerRoutes: [authority] }).await()
  const service = ctx.assistantDelivery, store = (service as unknown as { deliveryStore: DeliveryStore }).deliveryStore
  const challenge = service.issuePairing('test', principal); service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
  const binding = store.createBinding({ conversation, principal, workspace: root, agentPreset: 'primary', sessionId: 'owner-session', policyRef: 'owner-dm' })
  await ctx.plugin(AgentLoop, { agents: [] }).await()
  handle = await ctx.agents.create({ sessionId: binding.sessionId as never, meta: { cwd: root, agentPreset: 'primary' }, agentOptions: { provider: 'local-proof', model: 'never-dispatch' } })
  const agent = handle.agent
  let previousClaim: { inboxId: string; ownerId: string; fencingToken: number } | undefined
  const claim = (eventId = 'owner-input', turn = 1, text = '主人原话🧭：继续这个任务，不是工具参数。🙂') => {
    if (previousClaim) store.finishInbox({ ...previousClaim, outcome: 'processed' })
    const envelope = { channel: principal.channel, account: principal.account, eventId, occurredAt: turn, principal, conversation, kind: 'text' as const, text }
    const inbox = store.acceptInbound(envelope).record; store.queueInbox(inbox.id, binding.id)
    const claimed = store.claimInbox({ ownerId: `fixture-${eventId}`, leaseMs: 60000, limit: 1, maxAttempts: 3 })[0]!
    expect(claimed.record.id).toBe(inbox.id)
    previousClaim = { inboxId: inbox.id, ownerId: `fixture-${eventId}`, fencingToken: claimed.fencingToken }
    ctx.emit('agent/inbox/claimed', { agent, turn, message: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'delivery', channel: principal.channel, account: principal.account, eventId, trust: 'untrusted' } }) })
    const owner = store.getPrincipal(principal)!
    store.bindForegroundTaskExecution({ inboxId: inbox.id, scope: { workspace: root, preset: 'primary' }, owner: { principalRecordId: owner.id, principalVersion: owner.version }, binding, dispatchedAt: Date.now() })
    return inbox
  }
  const call = (callId = 'actual-call', turn = 1, args = '{"notTheHumanText":"injected model replacement"}') => {
    agent.session.append('turn/start', { turn }); agent.session.append('step/start', { turn, step: 1 })
    return agent.session.append('tool/call', { turn, step: 1, callId: ToolCallId(callId), name: 'work_item_continue', arguments: args })
  }
  const request = (callId = 'actual-call') => ({ agent, authorityId: authority.id, callId, toolName: 'work_item_continue', argumentsJson: '{"notTheHumanText":"injected model replacement"}' })
  const snapshot = () => {
    const db = new DatabaseSync(join(root, 'delivery.sqlite'), { readOnly: true })
    try { return ['inbox_messages', 'conversation_bindings', 'delivery_principals', 'delivery_foreground_executions', 'outbox_messages'].map(name => db.prepare(`SELECT * FROM ${name}`).all()) }
    finally { db.close() }
  }
  return { root, ctx, agent, store, service, principal, binding, authority, claim, call, request, snapshot }
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

test('pages the actual pending human input with native attestation, stable retry identity and zero ledger writes', async () => {
  const f = await fixture(), text = '主人原话🧭：保留这句🙂'.repeat(3), inbox = f.claim('human-one', 1, text), event = f.call()
  f.store.recordForegroundExecutionModelSelection({ inboxId: inbox.id, provider: 'actual-provider', model: 'actual-model', reasoningEffort: 'high' })
  const before = f.snapshot(), first = f.service.readOwnerForegroundToolInput({ ...f.request(), maxBytes: 4 })!
  expect(first).toMatchObject({ protocol: 'assistant-delivery/foreground-tool-input/v1', modelSelectionState: 'frozen', modelSelection: { provider: 'actual-provider', model: 'actual-model', reasoningEffort: 'high' },
    attestation: { task: { inboxId: inbox.id }, call: { id: 'actual-call', eventSeq: event.seq } }, input: { fullTextDigest: hash(text), fullBytes: Buffer.byteLength(text), offset: 0 } })
  let offset = 0, reconstructed = ''
  for (let pages = 0; ; pages++) {
    expect(pages).toBeLessThan(100)
    const page = f.service.readOwnerForegroundToolInput({ ...f.request(), offset, maxBytes: 7 })!
    expect(page.sourceDigest).toBe(first.sourceDigest); expect(page.input.text).not.toContain('\uFFFD')
    expect(page.input.returnedBytes).toBe(Buffer.byteLength(page.input.text)); expect(page.input.returnedBytes).toBeLessThanOrEqual(7)
    reconstructed += page.input.text
    if (page.input.nextOffset === undefined) break
    expect(page.input.nextOffset).toBe(offset + page.input.returnedBytes); offset = page.input.nextOffset
  }
  expect(reconstructed).toBe(text); expect(reconstructed).not.toContain('injected model replacement')
  const retryArguments = '{"item_id":"a different model hint"}'
  f.agent.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('retry-call'), name: 'work_item_continue', arguments: retryArguments })
  const retry = f.service.readOwnerForegroundToolInput({ ...f.request('retry-call'), argumentsJson: retryArguments })!
  expect(retry.sourceDigest).toBe(first.sourceDigest); expect(retry.attestation.call.id).toBe('retry-call')
  expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(first.input)).toBe(true); expect(Object.isFrozen(first.modelSelection)).toBe(true)
  expect(f.snapshot()).toEqual(before)
})

test('supplies persisted missing/frozen/inconsistent model state and binds transitions into sourceDigest', async () => {
  const f = await fixture(), inbox = f.claim(); f.call()
  const missing = f.service.readOwnerForegroundToolInput(f.request())!
  expect(missing.modelSelectionState).toBe('missing'); expect(missing.modelSelection).toBeUndefined()
  f.store.recordForegroundExecutionModelSelection({ inboxId: inbox.id, provider: 'recorded', model: 'not-agent-options' })
  const frozen = f.service.readOwnerForegroundToolInput(f.request())!
  expect(frozen.modelSelection).toEqual({ provider: 'recorded', model: 'not-agent-options' }); expect(frozen.sourceDigest).not.toBe(missing.sourceDigest)
  f.store.recordForegroundExecutionModelSelection({ inboxId: inbox.id, provider: 'other', model: 'changed' })
  const inconsistent = f.service.readOwnerForegroundToolInput(f.request())!
  expect(inconsistent.modelSelectionState).toBe('inconsistent'); expect(inconsistent.modelSelection).toBeUndefined(); expect(inconsistent.sourceDigest).not.toBe(frozen.sourceDigest)
})

test('rejects invalid byte windows and offsets inside a UTF-8 codepoint', async () => {
  const f = await fixture(); f.claim('unicode', 1, '🧭中文🙂'); f.call()
  for (const maxBytes of [0, 3, 8193, 4.5, NaN]) expect(() => f.service.readOwnerForegroundToolInput({ ...f.request(), maxBytes })).toThrow('byte page is invalid')
  for (const offset of [-1, 0.5]) expect(() => f.service.readOwnerForegroundToolInput({ ...f.request(), offset })).toThrow('byte page')
  for (const offset of [1, 2, 3, 100]) expect(() => f.service.readOwnerForegroundToolInput({ ...f.request(), offset })).toThrow('offset')
  const end = f.service.readOwnerForegroundToolInput({ ...f.request(), offset: Buffer.byteLength('🧭中文🙂'), maxBytes: 4 })!
  expect(end.input).toMatchObject({ text: '', returnedBytes: 0 }); expect(end.input.nextOffset).toBeUndefined()
})

test('rejects unclaimed/forged/shadow/changed-argument/settled native calls without widening terminal input readers', async () => {
  const f = await fixture(); f.call()
  expect(f.service.readOwnerForegroundToolInput(f.request())).toBeUndefined()
  const inbox = f.claim()
  expect(f.service.readOwnerForegroundToolInput({ ...f.request(), agent: { ...f.agent } as Agent })).toBeUndefined()
  expect(f.service.readOwnerForegroundToolInput({ ...f.request(), argumentsJson: '{"notTheHumanText":"different"}' })).toBeUndefined()
  expect(f.service.readOwnerForegroundToolInput({ ...f.request(), callId: 'shadow-call' })).toBeUndefined()
  expect(f.service.readOwnerForegroundToolInput(f.request())).toBeDefined()
  for (const selector of [{ inboxId: 'another-inbox' }, { path: '/private/input' }, { text: 'model supplied replacement' }, { owner: 'another owner' }]) expect(f.service.readOwnerForegroundToolInput({ ...f.request(), ...selector })).toBeUndefined()
  f.agent.session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('actual-call'), content: [{ type: 'text', text: 'done' }], isError: false }) }, { surfaceOp: 'append' })
  expect(f.service.readOwnerForegroundToolInput(f.request())).toBeUndefined()
  const scope = { authorityId: 'owner-route', workspace: f.root, agentPreset: 'primary', principalId: 'lark/bot/tenant/owner' }
  const owner = f.service.validateOwnerRoute(scope)
  const expectedOwner = { authorityHash: owner.authorityHash, principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion }
  expect(f.service.inspectOwnerForegroundTaskSource({ ...scope, expectedOwner, inboxId: inbox.id })).toBeUndefined()
  expect(f.service.listOwnerForegroundTaskSources({ ...scope, expectedOwner }).items).toEqual([])
  expect(f.service.readOwnerForegroundTaskInput({ ...scope, expectedOwner: { authorityHash: owner.authorityHash, principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion }, inboxId: inbox.id, expectedSourceDigest: '0'.repeat(64) })).toBeUndefined()
})

test('large persisted input is bounded by default and by the maximum UTF-8 page size', async () => {
  const f = await fixture(), text = '🧭'.repeat(3000); f.claim('large-human-input', 1, text); f.call()
  const first = f.service.readOwnerForegroundToolInput(f.request())!
  expect(first.input.returnedBytes).toBe(4096); expect(first.input.fullBytes).toBe(12000); expect(first.input.fullTextDigest).toBe(hash(text))
  const largest = f.service.readOwnerForegroundToolInput({ ...f.request(), maxBytes: 8192 })!
  expect(largest.input.returnedBytes).toBe(8192); expect(largest.input.nextOffset).toBe(8192)
  const rest = f.service.readOwnerForegroundToolInput({ ...f.request(), offset: 8192, maxBytes: 8192 })!
  expect(largest.input.text + rest.input.text).toBe(text); expect(rest.input.nextOffset).toBeUndefined()
  expect(rest.sourceDigest).toBe(first.sourceDigest)
})

test('rejects duplicate native call identity and PTC shadow calls', async () => {
  const duplicate = await fixture(); duplicate.claim(); duplicate.call()
  duplicate.agent.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('actual-call'), name: 'work_item_continue', arguments: duplicate.request().argumentsJson })
  expect(duplicate.service.readOwnerForegroundToolInput(duplicate.request())).toBeUndefined()
  const ptc = await fixture(); ptc.claim(); ptc.call()
  ptc.agent.session.append('tool/ptc-dispatch-start', { rootCallId: ToolCallId('ptc-root'), parentCallId: ToolCallId('ptc-root'), subCallId: ToolCallId('actual-call'), name: 'work_item_continue', arguments: JSON.parse(ptc.request().argumentsJson) })
  expect(ptc.service.readOwnerForegroundToolInput(ptc.request())).toBeUndefined()
})

test('rejects owner revocation, binding generation drift, old turns and terminal execution', async () => {
  const revoked = await fixture(); revoked.claim(); revoked.call(); const owner = revoked.store.getPrincipal(revoked.principal)!
  revoked.store.revokePrincipal(owner.id, owner.version); expect(revoked.service.readOwnerForegroundToolInput(revoked.request())).toBeUndefined()
  const rotated = await fixture(); rotated.claim(); rotated.call(); rotated.store.rotateBinding({ bindingId: rotated.binding.id, expectedVersion: rotated.binding.version, sessionId: 'new-owner-session' })
  expect(rotated.service.readOwnerForegroundToolInput(rotated.request())).toBeUndefined()
  const next = await fixture(); next.claim('first', 1); next.call(); const old = next.service.readOwnerForegroundToolInput(next.request())!
  next.claim('second', 2, 'a different real human input'); next.call('second-call', 2)
  expect(next.service.readOwnerForegroundToolInput(next.request())).toBeUndefined()
  const current = next.service.readOwnerForegroundToolInput(next.request('second-call'))!
  expect(current.sourceDigest).not.toBe(old.sourceDigest)
  next.store.finishForegroundTaskExecution({ inboxId: current.attestation.task.inboxId, status: 'failed', quiescent: false, completedAt: Date.now() })
  expect(next.service.readOwnerForegroundToolInput(next.request('second-call'))).toBeUndefined()
})
