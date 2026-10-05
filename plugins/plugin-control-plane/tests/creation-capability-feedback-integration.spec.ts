// Real Policy, Delivery, Evaluation, native Session events and SQLite. Agent,
// adoption/call records and transport acknowledgements are controlled fixtures;
// this verifies authenticated associations, not live adoption or quality gain.
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createInboxStub, mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import type { DeliveryStore } from '../../assistant-delivery/lib/store.js'
import { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { afterEach, expect, test, vi } from 'vitest'
import { inspectCreationCapabilityTaskAssociations } from '../src/creation-capability-feedback.ts'
import type { CreationCapabilityCallEvidence, CreationCapabilityRecord } from '../src/creation-capability-types.ts'
import { controlPlaneDigest } from '../src/store.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close() })
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cp-created-feedback-real-')))
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const principal = { channel: 'lark', account: 'bot', tenant: 'tenant', user: 'owner' }
  const conversation = { channel: 'lark', account: 'bot', tenant: 'tenant', kind: 'dm' as const, chat: 'owner-chat' }
  const authority = { id: 'route', conversation, principal, workspace: root, agentPreset: 'primary', policyRef: 'owner-dm', minimumGeneration: 1 }
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: [
    { id: 'pair', effect: 'allow', subject: { kind: 'external', id: 'local:test' }, actions: ['pair.issue'],
      resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
    { id: 'ingest', effect: 'allow', subject: { kind: 'external', id: 'lark/bot/tenant/owner' }, actions: ['pair.confirm', 'ingest'],
      resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
    { id: 'feedback', effect: 'allow', subject: { kind: 'external', id: 'lark/bot/tenant/owner', workspace: root }, actions: ['signal'],
      resource: { kind: 'preference', id: 'primary/*' }, context: { initiators: ['external'] } },
    { id: 'reply', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: root, principal: 'lark/bot/tenant/owner' }, actions: ['reply'],
      resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
  ] })
  await ctx.plugin(AssistantEvaluationService, { databasePath: join(root, 'evaluation.sqlite'), projectionIntervalMs: 0 })
  await ctx.plugin(AssistantDeliveryService, { databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'),
    schedulerEnabled: false, ownerRoutes: [authority] })
  const delivery = ctx.assistantDelivery, evaluation = ctx.assistantEvaluation
  const store = (delivery as unknown as { deliveryStore: DeliveryStore }).deliveryStore
  const pairing = delivery.issuePairing('test', principal)
  delivery.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
  const binding = store.createBinding({ conversation, principal, workspace: root, agentPreset: 'primary',
    sessionId: 'same-owner-session', policyRef: 'owner-dm' })
  const session = ctx.sessions.create(SessionId(binding.sessionId), { meta: { cwd: root, agentPreset: 'primary' } })
  const agent: Agent = { id: SessionId(binding.sessionId), options: {}, session, inbox: createInboxStub(), ctx: new Context(),
    status: 'idle', cancel() {}, whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal),
    send() {}, followup() {}, steer() {}, inject() {} }
  ctx.agents.register(agent)
  await delivery.registerAdapter({ channel: 'lark', account: 'bot', capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'] },
    start: async () => {}, send: async intent => ({ outcome: 'accepted', providerMessageId: sha(intent.idempotencyKey) }) })
  const envelope = (eventId: string, text: string, kind: 'text' | 'command' = 'text') =>
    ({ channel: 'lark', account: 'bot', eventId, occurredAt: Date.now(), principal, conversation, kind, text })
  const route = { authorityId: authority.id, principalId: 'lark/bot/tenant/owner', workspace: root, agentPreset: 'primary' }
  const owner = delivery.validateOwnerRoute(route)
  const scope = evaluation.canonicalHostScope({ workspace: root, preset: 'primary' })
  const adoptedAt = Date.now() - 5_000
  const artifact = Buffer.from('controlled adoption artifact')
  const receipt = { protocol: 'dsh-created-capability-adoption/v2' as const, authorityId: 'adoption', authorityDigest: 'a'.repeat(64), keyId: 'key',
    planId: 'plan', planDigest: 'b'.repeat(64), verificationDigest: 'c'.repeat(64), artifactSha256: sha(artifact.toString()), artifactBytes: artifact.length,
    source: { referenceDigest: 'd'.repeat(64), ownerDigest: 'e'.repeat(64), growthRunDigest: 'f'.repeat(64) },
    schemaDigest: '1'.repeat(64), toolsDigest: '2'.repeat(64), expiresAt: Date.now() + 60_000, adoptedAt, signature: 'fixture' }
  const record: CreationCapabilityRecord = { planId: 'plan', status: 'active', receipt, artifact,
    tools: [{ name: 'created_tool', originalName: 'tool', description: 'fixture', parameters: {} }],
    certificate: { plan: { id: 'plan', artifactSha256: receipt.artifactSha256, artifactBytes: artifact.length }, schemaDigest: receipt.schemaDigest,
      expiresAt: receipt.expiresAt } as CreationCapabilityRecord['certificate'] }
  let turn = 0
  const task = async (eventId: string) => {
    const inbox = store.acceptInbound(envelope(eventId, 'private ordinary task')).record
    store.queueInbox(inbox.id, binding.id)
    const claim = store.claimInbox({ ownerId: eventId, leaseMs: 60_000, limit: 1, maxAttempts: 3 })[0]!
    expect(claim?.record.id).toBe(inbox.id)
    expect(store.getInbox(inbox.id)).toMatchObject({ status: 'claimed', bindingId: binding.id })
    expect(store.getPrincipal(principal)).toMatchObject({ id: owner.principalRecordId, version: owner.principalVersion, role: 'owner' })
    expect(store.getBinding(binding.id)).toMatchObject({ status: 'active', version: binding.version, generation: binding.generation })
    ctx.emit('agent/inbox/claimed', { agent, turn: ++turn, message: createUserMessage({ content: [{ type: 'text', text: 'private ordinary task' }],
      source: { kind: 'delivery', channel: 'lark', account: 'bot', eventId, trust: 'untrusted' } as unknown as Parameters<typeof createUserMessage>[0]['source'] }) })
    store.bindForegroundTaskExecution({ inboxId: inbox.id, scope: { workspace: root, preset: 'primary' },
      owner: { principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion }, binding, dispatchedAt: Date.now() })
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    const callId = `${eventId}-call`
    session.append('tool/call', { turn, step: 1, callId: ToolCallId(callId), name: 'created_tool', arguments: '{"private":7}' })
    const foreground = delivery.inspectOwnerForegroundToolCall({ agent, authorityId: authority.id, callId,
      toolName: 'created_tool', argumentsJson: '{"private":7}' })!
    expect(foreground?.task.inboxId).toBe(inbox.id)
    store.finishForegroundTaskExecution({ inboxId: inbox.id, status: 'succeeded', quiescent: true, completedAt: Date.now() })
    store.finishInbox({ inboxId: inbox.id, ownerId: eventId, fencingToken: claim.fencingToken, outcome: 'processed' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    const reply = store.enqueue({ bindingId: binding.id, idempotencyKey: `inbound:${inbox.id}:reply`,
      target: { principal, conversation }, replyToEventId: eventId, text: 'private reply' })
    const send = store.claimOutbox({ ownerId: 'transport-fixture', leaseMs: 60_000, limit: 1, maxAttempts: 3 })[0]!
    expect(send.record.id).toBe(reply.id)
    const providerMessageId = sha(reply.intent.idempotencyKey)
    store.finishOutbox({ outboxId: reply.id, ownerId: 'transport-fixture', fencingToken: send.fencingToken,
      outcome: 'accepted', providerMessageId })
    const call: CreationCapabilityCallEvidence = { protocol: 'dsh-created-capability-call-evidence/v1', planId: 'plan', key: sha(callId),
      status: 'completed', attribution: 'foreground', toolAlias: 'created_tool', originalName: 'tool', receiptDigest: controlPlaneDigest(receipt),
      artifactSha256: receipt.artifactSha256, schemaDigest: receipt.schemaDigest, claimedAt: foreground.task.dispatchedAt, settledAt: Date.now(), foreground }
    return { inboxId: inbox.id, providerMessageId, call }
  }
  const feedback = async (item: Awaited<ReturnType<typeof task>>, eventId: string, command: string) => {
    await delivery.acceptInbound({ ...envelope(eventId, `/feedback ${command}`, 'command'), metadata: { replyToProviderMessageId: item.providerMessageId } })
    await delivery.tick(); await delivery.whenIdle(); await delivery.tick(); await delivery.whenIdle()
  }
  return { ctx, evaluation, delivery, store, principal, scope, owner, record, task, feedback }
}

function inspect(f: Awaited<ReturnType<typeof fixture>>, originalInboxId: string, calls: readonly CreationCapabilityCallEvidence[]) {
  return inspectCreationCapabilityTaskAssociations({ record: f.record, calls, triggerInboxId: originalInboxId,
    owner: f.owner, evaluation: f.evaluation, delivery: f.delivery, readSourceCurrent: () => {
      const source = f.evaluation.getTrustedForegroundLearningProjection({ scope: f.scope, inboxId: originalInboxId })!
      const authenticated = f.delivery.inspectOwnerForegroundLearningTask({ authorityId: f.owner.authorityId,
        principalId: f.owner.principalId, workspace: f.owner.workspace, agentPreset: f.owner.agentPreset, outcomeId: source.triggerOutcomeId })
      if (!authenticated || authenticated.canonical.objective?.status !== 'not-achieved'
        || authenticated.canonical.projection.disposition !== 'upsert') throw new Error('original source changed')
      return { scopeWatermark: source.scopeWatermark, projection: source.projection }
    } })
}

test('associates real authenticated task feedback, changes the current revision, and removes withdrawn results', async () => {
  const f = await fixture()
  const original = await f.task('original')
  await f.feedback(original, 'original-feedback', 'not-achieved')
  const later = await f.task('later')
  await f.feedback(later, 'later-feedback', 'not-achieved')
  const calls = [original.call, later.call]
  const read = () => inspect(f, original.inboxId, calls)
  const first = read()
  expect(first).toHaveLength(1)
  expect(first[0]).toMatchObject({ inboxId: later.inboxId, sessionId: 'same-owner-session',
    task: { judgement: 'owner-feedback', status: 'not-achieved' } })
  expect(JSON.stringify(first)).not.toContain('private')
  await f.feedback(later, 'later-correction', 'correct 1 not-achieved achieved')
  const corrected = read()
  expect(corrected).toHaveLength(1)
  expect(corrected[0]?.task.status).toBe('achieved')
  expect(corrected[0]?.task.projection.version).toBeGreaterThan(first[0]!.task.projection.version)
  expect(corrected[0]?.task.projection.digest).not.toBe(first[0]!.task.projection.digest)
  await f.feedback(later, 'later-withdrawal', 'withdraw 2 achieved')
  expect(read()).toEqual([])
  expect(calls[1]?.status).toBe('completed')
})

test('keeps separate Inbox outcomes in one Session and rejects an authenticated correction of the original source', async () => {
  const f = await fixture()
  const original = await f.task('original-distinct')
  await f.feedback(original, 'original-distinct-feedback', 'not-achieved')
  const one = await f.task('one')
  await f.feedback(one, 'one-feedback', 'achieved')
  const two = await f.task('two')
  await f.feedback(two, 'two-feedback', 'achieved')
  const calls = [one.call, two.call, { ...two.call, status: 'unknown' as const }]
  const observed = inspect(f, original.inboxId, calls)
  expect(observed.map(item => item.inboxId).sort()).toEqual([one.inboxId, two.inboxId].sort())
  expect(observed.every(item => item.sessionId === 'same-owner-session' && item.callKeys.length === 1)).toBe(true)
  await f.feedback(original, 'original-distinct-correction', 'correct 1 not-achieved achieved')
  expect(inspect(f, original.inboxId, calls)).toEqual([])
})

test('rejects real owner ABA between the first read and the canonical writer fence', async () => {
  const f = await fixture()
  const original = await f.task('original-aba')
  await f.feedback(original, 'original-aba-feedback', 'not-achieved')
  const later = await f.task('later-aba')
  await f.feedback(later, 'later-aba-feedback', 'achieved')
  expect(inspect(f, original.inboxId, [later.call])).toHaveLength(1)
  const fence = f.evaluation.withTrustedCanonicalTaskWriterFence.bind(f.evaluation)
  vi.spyOn(f.evaluation, 'withTrustedCanonicalTaskWriterFence').mockImplementationOnce((input, callback) => {
    f.store.handoffOwner({ ...f.principal, user: 'other-owner' })
    f.store.handoffOwner(f.principal)
    return fence(input, callback)
  })
  expect(inspect(f, original.inboxId, [later.call])).toEqual([])
  expect(later.call.status).toBe('completed')
})
