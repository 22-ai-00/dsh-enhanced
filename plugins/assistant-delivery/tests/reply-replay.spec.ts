import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ReplyReplayBlockedError, type ReplyReplayBlockedAttempt } from '../src/reply-replay.ts'
import { AssistantDeliveryService } from '../src/service.ts'

const roots: string[] = []
const agents: Agent[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(agents.splice(0).map(current => current.ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function agent(sessionId: string): Agent {
  const id = SessionId(sessionId)
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 1,
    cwd: '/work/alpha', isSeeded: false, agentPreset: 'primary' })
  session.append('approval/policy', { policy: 'never' })
  session.append('assistant-policy/approval-reviewer', { reviewer: 'none' })
  const append = session.append as unknown as (type: string, data: unknown) => unknown
  append.call(session, 'sandbox/mode', { mode: 'danger-full-access' })
  const created = { id, options: {}, session, inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    ctx: new Context(), status: 'idle', cancel() {}, whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {} } as Agent
  agents.push(created)
  return created
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-reply-replay-'))
  roots.push(root)
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: [
    { id: 'pair', effect: 'allow', subject: { kind: 'external', id: 'local:test' }, actions: ['pair.issue'],
      resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
    { id: 'owner', effect: 'allow', subject: { kind: 'external', id: 'lark/bot/tenant/owner' },
      actions: ['pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
    { id: 'delivery', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
      actions: ['reply', 'history'], resource: { kind: 'message', id: '*' }, context: { initiators: ['foreground'] } },
    { id: 'tools', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
      actions: ['execute'], resource: { kind: 'tool', id: 'delivery_*' }, context: { initiators: ['foreground'] } },
  ] })
  const config = { databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'), schedulerEnabled: false }
  const deliveryFiber = ctx.plugin(AssistantDeliveryService, config)
  await deliveryFiber
  const service = ctx.assistantDelivery
  const principal = { channel: 'lark', account: 'bot', tenant: 'tenant', user: 'owner' }
  const conversation = { channel: 'lark', account: 'bot', tenant: 'tenant', kind: 'dm' as const, chat: 'chat' }
  const pairing = service.issuePairing('test', principal)
  service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
  service.registerInboundRuntime({ createSession: async () => ({ sessionId: 'blocked-session',
    workspace: '/work/alpha', agentPreset: 'primary', policyRef: 'owner-dm' }), process: async () => ({ outcome: 'processed' }) })
  await service.acceptInbound({ channel: 'lark', account: 'bot', eventId: 'evt-1', occurredAt: 1,
    principal, conversation, kind: 'text', text: 'hello' })
  const blocked = agent('blocked-session')
  const other = agent('other-session')
  const store = service as unknown as { deliveryStore: { createBinding(input: unknown): unknown } }
  store.deliveryStore.createBinding({ conversation: { ...conversation, chat: 'other-chat' }, principal,
    workspace: '/work/alpha', agentPreset: 'primary', sessionId: 'other-session', policyRef: 'owner-dm' })
  const send = vi.fn(async () => ({ outcome: 'accepted' as const, providerMessageId: 'unused' }))
  await service.registerAdapter({ channel: 'lark', account: 'bot', capabilities: {
    reconcileUnknownSend: false, receipts: [], formats: ['plain'], inboundImages: false,
  }, start: async () => {}, send })
  return { ctx, service, blocked, other, send, deliveryFiber, config }
}

function toolReply(agent_: Agent) {
  return { callId: ToolCallId(`reply-replay-${Math.random()}`), name: 'delivery_reply',
    arguments: { idempotency_key: 'blocked-reply', text: 'must not escape' }, agent: agent_,
    signal: new AbortController().signal }
}

describe('reply replay block', () => {
  test('fences the real delivery_reply route before Policy, Outbox, and adapters while another Agent remains usable', async () => {
    const f = await harness()
    const handle = f.service.blockAgentRepliesForReplay(f.blocked, {
      operationId: 'replay-1', maximumAttempts: 2, expiresAt: Date.now() + 60_000,
    })
    const native = await f.ctx.tools.execute(toolReply(f.blocked))
    expect(native.isError).toBe(true)
    expect(f.service.history(f.blocked, {}).outbox).toEqual([])
    expect(f.send).not.toHaveBeenCalled()
    expect(handle.snapshot()).toMatchObject({ contract: 'assistant-delivery/reply-replay-block/v1', attempts: [{
      sequence: 1, operationId: 'replay-1', blocked: true,
    }] })
    expect(f.service.reply(f.other, { idempotencyKey: 'other-reply', text: 'allowed' })).toMatchObject({ status: 'pending' })
    await f.service.tick()
    expect(f.send).toHaveBeenCalledOnce()
    await f.ctx.fiber.restart()
  })

  test('keeps a bounded tombstone across duplicate registration, close, expiry, exhaustion, and agent Fiber unload', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-20T00:00:00.000Z'))
    const f = await harness()
    const handle = f.service.blockAgentRepliesForReplay(f.blocked, {
      operationId: 'replay-2', maximumAttempts: 1, expiresAt: Date.now() + 1_000,
    })
    expect(() => f.service.blockAgentRepliesForReplay(f.blocked, {
      operationId: 'replay-again', maximumAttempts: 1, expiresAt: Date.now() + 1_000,
    })).toThrow(/already registered/)
    expect(() => f.service.reply(f.blocked, { idempotencyKey: 'first', text: 'first' }))
      .toThrow(ReplyReplayBlockedError)
    expect(handle.snapshot()).toMatchObject({ status: 'attempt-limit', attempts: [{ sequence: 1 }] })
    expect(() => f.service.reply(f.blocked, { idempotencyKey: 'late-limit', text: 'late' }))
      .toThrow(ReplyReplayBlockedError)
    expect(handle.snapshot()).toMatchObject({ invalidated: true, attempts: [{ sequence: 1 }] })
    handle.close()
    expect(() => f.service.reply(f.blocked, { idempotencyKey: 'late-close', text: 'late' }))
      .toThrow(ReplyReplayBlockedError)
    await f.blocked.ctx.fiber.restart()
    expect(() => f.service.reply(f.blocked, { idempotencyKey: 'late-unload', text: 'late' }))
      .toThrow(ReplyReplayBlockedError)
    const closing = agent('closing-agent')
    const closed = f.service.blockAgentRepliesForReplay(closing, {
      operationId: 'replay-close', maximumAttempts: 2, expiresAt: Date.now() + 1_000,
    })
    closed.close()
    const closedSnapshot = closed.snapshot()
    expect(closedSnapshot).toMatchObject({ status: 'closed', attempts: [] })
    expect(Object.isFrozen(closedSnapshot)).toBe(true)
    expect(Object.isFrozen(closedSnapshot.attempts)).toBe(true)
    expect(() => (closedSnapshot.attempts as ReplyReplayBlockedAttempt[]).push({
      sequence: 99, operationId: 'forged', inputDigest: 'x', observedAt: 0, blocked: true,
    })).toThrow()
    expect(() => f.service.reply(closing, { idempotencyKey: 'late-active-close', text: 'late' }))
      .toThrow(ReplyReplayBlockedError)
    expect(closed.snapshot()).toMatchObject({ status: 'closed', invalidated: true, attempts: [] })
    const unloaded = f.service.blockAgentRepliesForReplay(f.other, {
      operationId: 'replay-unload', maximumAttempts: 1, expiresAt: Date.now() + 1_000,
    })
    await f.other.ctx.fiber.restart()
    expect(unloaded.snapshot()).toMatchObject({ status: 'owner-unloaded', attempts: [] })
    expect(() => f.service.reply(f.other, { idempotencyKey: 'late-provider-unload', text: 'late' }))
      .toThrow(ReplyReplayBlockedError)
    expect(f.service.history(f.blocked, {}).outbox).toEqual([])
    expect(f.send).not.toHaveBeenCalled()
    await f.ctx.fiber.restart()
  })

  test('expires an active fence without converting late calls into new proof', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-20T00:00:00.000Z'))
    const f = await harness()
    const handle = f.service.blockAgentRepliesForReplay(f.blocked, {
      operationId: 'replay-3', maximumAttempts: 2, expiresAt: Date.now() + 1_000,
    })
    vi.advanceTimersByTime(1_001)
    expect(() => f.service.reply(f.blocked, { idempotencyKey: 'expired', text: 'late' }))
      .toThrow(ReplyReplayBlockedError)
    expect(handle.snapshot()).toMatchObject({ status: 'expired', attempts: [] })
    await f.ctx.fiber.restart()
  })

  test('rejects malformed replay authority before registering a tombstone', async () => {
    const f = await harness()
    for (const config of [
      { operationId: '', maximumAttempts: 1, expiresAt: Date.now() + 1_000 },
      { operationId: 'valid', maximumAttempts: 0, expiresAt: Date.now() + 1_000 },
      { operationId: 'valid', maximumAttempts: 1, expiresAt: Date.now() - 1 },
      { operationId: 'valid', maximumAttempts: 1_001, expiresAt: Date.now() + 1_000 },
    ]) expect(() => f.service.blockAgentRepliesForReplay(f.blocked, config)).toThrow()
    expect(f.service.reply(f.blocked, { idempotencyKey: 'still-unblocked', text: 'allowed' })).toMatchObject({ status: 'pending' })
    await f.ctx.fiber.restart()
  })

  test('keeps the exact Agent blocked after the Delivery provider is replaced', async () => {
    const f = await harness()
    const block = f.service.blockAgentRepliesForReplay(f.blocked, {
      operationId: 'provider-replacement', maximumAttempts: 2, expiresAt: Date.now() + 60_000,
    })
    block.close()
    await f.deliveryFiber.dispose()
    await f.ctx.plugin(AssistantDeliveryService, f.config)
    expect(() => f.ctx.assistantDelivery.reply(f.blocked, { idempotencyKey: 'after-replacement', text: 'still blocked' }))
      .toThrow(ReplyReplayBlockedError)
    expect(block.snapshot()).toMatchObject({ status: 'closed', invalidated: true, attempts: [] })
    expect(f.ctx.assistantDelivery.history(f.blocked, {}).outbox).toEqual([])
    expect(f.send).not.toHaveBeenCalled()
    await f.ctx.fiber.dispose()
  })
})
