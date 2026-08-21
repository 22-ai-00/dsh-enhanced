import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AssistantDeliveryService } from '../src/service.ts'
import type { DeliveryAdapter, InboundEnvelope } from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function foreground(sessionId: string): Agent {
  const id = SessionId(sessionId)
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 1,
    cwd: '/work/alpha', agentPreset: 'primary' })
  return { id, options: {}, session, inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    ctx: new Context(), status: 'idle', cancel() {}, whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {} }
}

async function harness(allow = true) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-service-'))
  roots.push(root)
  const ctx = new Context()
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: allow ? [
    { id: 'local-pair', effect: 'allow', subject: { kind: 'external', id: 'local:test' },
      actions: ['pair.issue', 'pair.link', 'delivery.resolve'], resource: { kind: 'message', id: '*' },
      context: { initiators: ['foreground'] } },
    { id: 'external-owner', effect: 'allow', subject: { kind: 'external', id: 'lark/bot-1/tenant-a/ou_owner' },
      actions: ['approval.decide', 'pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' },
      context: { initiators: ['external'] } },
    { id: 'background-send', effect: 'allow', subject: { kind: 'background', id: 'automation-1', workspace: '/work/alpha' },
      actions: ['approval.send', 'send'], resource: { kind: 'message', id: '*' }, context: { initiators: ['background'] } },
    { id: 'foreground-message', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
      actions: ['history', 'reply'], resource: { kind: 'message', id: '*' }, context: { initiators: ['foreground'] } },
  ] : [] })
  await ctx.plugin(AssistantDeliveryService, { databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'),
    schedulerEnabled: false })
  return { ctx, root, service: ctx.assistantDelivery }
}

const principal = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner' }
const conversation = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm' as const, chat: 'oc_owner' }
const envelope: InboundEnvelope = { channel: 'lark', account: 'bot-1', eventId: 'evt-1', occurredAt: 1,
  principal, conversation, kind: 'text', text: 'hello' }

describe('assistant delivery Cordis service', () => {
  test('defaults external sessions to the shipped standard preset', () => {
    const config = AssistantDeliveryService.Config({
      databasePath: '/tmp/delivery.sqlite',
      spoolPath: '/tmp/spool',
    })
    expect(config.defaultAgentPreset).toBe('standard')
  })

  test('fails closed without policy and rejects unsafe configuration', async () => {
    const ctx = new Context()
    expect(() => new AssistantDeliveryService(ctx, { databasePath: '/tmp/delivery.sqlite', spoolPath: '/tmp/spool' }))
      .toThrow(/assistantPolicy/i)
    const fixture = await harness()
    await fixture.ctx.fiber.restart()
    let index = 0
    for (const config of [
      { databasePath: 'relative', spoolPath: '/tmp/spool' },
      { databasePath: '/tmp/delivery.sqlite', spoolPath: 'relative' },
      { databasePath: '/tmp/delivery.sqlite', spoolPath: '/tmp/spool', maxConcurrency: 0 },
    ]) {
      const policyCtx = new Context()
      await policyCtx.plugin(AssistantPolicyService, { databasePath: join(fixture.root, `policy-${index++}.sqlite`) })
      expect(() => new AssistantDeliveryService(policyCtx, config)).toThrow(/assistant-delivery|absolute|concurrency/i)
      await policyCtx.fiber.restart()
    }
  })

  test('pairs explicitly, single-flights binding creation, and queues a persisted inbound event', async () => {
    const { ctx, service } = await harness()
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    const createSession = vi.fn(async () => ({ sessionId: 'delivery-session-1', workspace: '/work/alpha',
      agentPreset: 'primary', policyRef: 'owner-dm' }))
    const process = vi.fn(async () => ({ outcome: 'processed' as const }))
    service.registerInboundRuntime({ createSession, process })
    const [first, duplicate] = await Promise.all([service.acceptInbound(envelope), service.acceptInbound(envelope)])
    expect([first.duplicate, duplicate.duplicate].sort()).toEqual([false, true])
    expect(createSession).toHaveBeenCalledOnce()
    expect(service.history(foreground('delivery-session-1'), {})).toMatchObject({
      inbox: [expect.objectContaining({ eventId: 'evt-1', status: 'queued' })],
    })
    await service.tick()
    await service.whenIdle()
    expect(process).toHaveBeenCalledOnce()
    expect(service.history(foreground('delivery-session-1'), {}).inbox[0]).toMatchObject({ status: 'processed' })
    await ctx.fiber.restart()
  })

  test('persists and dead-letters unknown or policy-denied senders before acknowledgement', async () => {
    const denied = await harness(false)
    await expect(denied.service.acceptInbound(envelope)).resolves.toMatchObject({ duplicate: false,
      status: 'dead_letter' })
    await denied.ctx.fiber.restart()
  })

  test('builds outbound targets only from an existing binding and policy-gates background and reply sends', async () => {
    const { ctx, service } = await harness()
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    service.registerInboundRuntime({ createSession: async () => ({ sessionId: 'delivery-session-1', workspace: '/work/alpha',
      agentPreset: 'primary', policyRef: 'owner-dm' }), process: async () => ({ outcome: 'processed' }) })
    await service.acceptInbound(envelope)
    const binding = service.history(foreground('delivery-session-1'), {}).binding
    expect(service.enqueueBackground({ sourceId: 'automation-1', workspace: '/work/alpha', bindingId: binding.id,
      idempotencyKey: 'automation:1', text: 'done' })).toMatchObject({ status: 'pending', intent: { target: { conversation } } })
    expect(service.reply(foreground('delivery-session-1'), { idempotencyKey: 'reply:1', text: 'reply' }))
      .toMatchObject({ status: 'pending', intent: { bindingId: binding.id } })
    expect(service.reply(foreground('delivery-session-1'), {
      idempotencyKey: 'reply:to-event', text: 'reply', replyToEventId: 'om_original',
    })).toMatchObject({ intent: { replyToEventId: 'om_original' } })
    expect(() => service.enqueueBackground({ sourceId: 'forged', workspace: '/work/alpha', bindingId: binding.id,
      idempotencyKey: 'forged', text: 'no' })).toThrowError(expect.objectContaining({ code: 'policy-denied' }))
    expect((service as unknown as Record<string, unknown>)['store']).toBeUndefined()
    await ctx.fiber.restart()
  })

  test('owns adapter lifecycle and rejects calls after disposal', async () => {
    const { ctx, service } = await harness()
    expect(service.health()).toEqual({ pendingInbox: 0, deadLetterInbox: 0, pendingOutbox: 0,
      deadLetterOutbox: 0, unknownOutbox: 0, adapters: 0 })
    const dispose = vi.fn()
    const adapter: DeliveryAdapter = { channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'] },
      start: async () => dispose, send: async () => ({ outcome: 'accepted', providerMessageId: 'om_1' }) }
    await service.registerAdapter(adapter)
    expect(service.health()).toMatchObject({ adapters: 1 })
    await ctx.fiber.restart()
    expect(dispose).toHaveBeenCalledOnce()
    expect(() => service.registerAdapter(adapter)).toThrow(/disposed/i)
  })

  test('correlates delayed approval decisions to an exact binding, principal, version, and operation id', async () => {
    const { ctx, service } = await harness()
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    service.registerInboundRuntime({ createSession: async () => ({ sessionId: 'delivery-session-1', workspace: '/work/alpha',
      agentPreset: 'primary', policyRef: 'owner-dm' }), process: async () => ({ outcome: 'processed' }) })
    await service.acceptInbound(envelope)
    const binding = service.history(foreground('delivery-session-1'), {}).binding
    const proposal = ctx.assistantPolicy.propose({ idempotencyKey: 'approval-1', requester: 'automation:test',
      principal: 'lark/bot-1/tenant-a/ou_owner', action: 'send', resource: { kind: 'message', id: binding.id },
      diff: 'send one reviewed status', summary: 'Send reviewed status', ttlMs: 5_000 })
    expect(service.enqueueApproval({ sourceId: 'automation-1', workspace: '/work/alpha', bindingId: binding.id,
      idempotencyKey: 'approval-card-1', text: 'Approve sending the status?', approval: {
        operationId: 'card-click-1', proposalId: proposal.proposalId, expectedVersion: 1,
        expiresAt: proposal.expiresAt, title: 'Approval required',
      } })).toMatchObject({ intent: { format: 'approval', approval: { proposalId: proposal.proposalId } } })
    const input = { operationId: 'card-click-1', callbackEventId: 'card-event-1', callbackChatId: 'oc_owner', bindingId: binding.id,
      principal, proposalId: proposal.proposalId, expectedVersion: 1, decision: 'approved' as const, reason: 'owner approved' }
    expect(service.settleApproval(input)).toMatchObject({ status: 'approved', version: 2, replayed: false })
    expect(service.settleApproval(input)).toMatchObject({ status: 'approved', version: 2 })
    expect(() => service.settleApproval({ ...input, decision: 'rejected' }))
      .toThrowError(expect.objectContaining({ code: 'idempotency-conflict' }))
    expect(() => service.settleApproval({ ...input, operationId: 'card-click-other-chat', callbackChatId: 'oc_attacker' }))
      .toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    await ctx.fiber.restart()
  })

  test('requires an explicit policy-gated operator decision before retrying an ambiguous send', async () => {
    const { ctx, service } = await harness()
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    service.registerInboundRuntime({ createSession: async () => ({ sessionId: 'delivery-session-1', workspace: '/work/alpha',
      agentPreset: 'primary', policyRef: 'owner-dm' }), process: async () => ({ outcome: 'processed' }) })
    await service.acceptInbound(envelope)
    const binding = service.history(foreground('delivery-session-1'), {}).binding
    service.enqueueBackground({ sourceId: 'automation-1', workspace: '/work/alpha', bindingId: binding.id,
      idempotencyKey: 'ambiguous-1', text: 'possibly sent' })
    await service.registerAdapter({ channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'] }, start: async () => {},
      send: async () => ({ outcome: 'unknown', failureCode: 'response-lost' }) })
    await service.tick()
    await service.whenIdle()
    const unknown = service.history(foreground('delivery-session-1'), {}).outbox[0]!
    expect(unknown.status).toBe('unknown_after_send')
    expect(service.resolveDeadLetter({ operatorId: 'test', kind: 'outbox', id: unknown.id,
      expectedAttemptCount: unknown.attemptCount, resolution: 'retry' })).toMatchObject({ status: 'pending' })
    await ctx.fiber.restart()
  })
})
