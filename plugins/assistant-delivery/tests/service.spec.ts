import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, {
  CallId,
  LlmAdapter,
  createToolResultMessage,
  createUserMessage,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import {
  AUTO_REVIEW_APPROVAL_REASON,
  AssistantPolicyService,
  HUMAN_APPROVAL_REASON,
} from '@dsh-enhanced/assistant-policy'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AssistantDeliveryService } from '../src/service.ts'
import type { ConversationBinding, ConversationRef, DeliveryAdapter, InboundEnvelope } from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
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

function foregroundWithHeader(sessionId: string, cwd: string, agentPreset: string): Agent {
  const id = SessionId(sessionId)
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 1, cwd, agentPreset })
  return { id, options: {}, session, inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    ctx: new Context(), status: 'idle', cancel() {}, whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {} }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

interface MountHarnessOptions {
  approval?: boolean
  flush?: false | ((session: Session) => void | Promise<void>)
  reviewer?: DeliveryReviewerAdapter
  reviewerMountOrder?: 'before-policy' | 'after-delivery'
  toolApprovalTtlMs?: number
}

class DeliveryReviewerAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly scripts: string[]) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Delivery test reviewer' }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: 'review-model', name: 'Review model' }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const script = this.scripts.shift()
    if (script === undefined) throw new Error('review script exhausted')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: script }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: script } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function reviewerAssessment(outcome: 'allow' | 'escalate'): string {
  return JSON.stringify({
    authorization: 'medium',
    outcome,
    rationale: outcome === 'allow' ? 'Narrow action is authorized.' : 'Owner review is required.',
    riskLevel: outcome === 'allow' ? 'low' : 'high',
  })
}

async function mountHarness(root: string, allow = true, options: MountHarnessOptions = {}) {
  const ctx = new Context()
  if (options.approval === true) {
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ApprovalService)
    if (options.reviewer !== undefined && options.reviewerMountOrder !== 'after-delivery') {
      await ctx.plugin(LlmRuntime)
      ctx.llm.registerAdapter(['delivery-reviewer'], options.reviewer)
    }
    if (options.flush !== false) ctx.on('session/flush', options.flush ?? (() => {}))
  }
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: allow ? [
    { id: 'local-pair', effect: 'allow', subject: { kind: 'external', id: 'local:test' },
      actions: ['pair.issue', 'pair.link', 'delivery.resolve'], resource: { kind: 'message', id: '*' },
      context: { initiators: ['foreground'] } },
    { id: 'external-owner', effect: 'allow', subject: { kind: 'external', id: 'lark/bot-1/tenant-a/ou_owner' },
      actions: ['approval.decide', 'pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' },
      context: { initiators: ['external'] } },
    { id: 'external-linked', effect: 'allow', subject: { kind: 'external', id: 'lark/bot-1/tenant-a/ou_linked' },
      actions: ['pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' },
      context: { initiators: ['external'] } },
    { id: 'background-send', effect: 'allow', subject: { kind: 'background', id: 'automation-1', workspace: '/work/alpha' },
      actions: ['approval.send', 'send'], resource: { kind: 'message', id: '*' }, context: { initiators: ['background'] } },
    { id: 'foreground-message', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
      actions: ['history', 'reply'], resource: { kind: 'message', id: '*' }, context: { initiators: ['foreground'] } },
    { id: 'forged-cwd-would-pass-policy', effect: 'allow',
      subject: { kind: 'agent', id: 'primary', workspace: '/work/forged' },
      actions: ['history', 'reply'], resource: { kind: 'message', id: '*' }, context: { initiators: ['foreground'] } },
    { id: 'forged-preset-would-pass-policy', effect: 'allow',
      subject: { kind: 'agent', id: 'forged', workspace: '/work/alpha' },
      actions: ['history', 'reply'], resource: { kind: 'message', id: '*' }, context: { initiators: ['foreground'] } },
  ] : [],
  ...(options.reviewer === undefined ? {} : {
    autoReview: { provider: 'delivery-reviewer', model: 'review-model' },
  }) })
  await ctx.plugin(AssistantDeliveryService, { databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'),
    schedulerEnabled: false,
    ...(options.toolApprovalTtlMs === undefined ? {} : { toolApprovalTtlMs: options.toolApprovalTtlMs }) })
  if (options.reviewer !== undefined && options.reviewerMountOrder === 'after-delivery') {
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['delivery-reviewer'], options.reviewer)
  }
  return { ctx, root, service: ctx.assistantDelivery }
}

async function harness(allow = true, options: MountHarnessOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-service-'))
  roots.push(root)
  return mountHarness(root, allow, options)
}

function registerApprovalAgent(ctx: Context, sessionId: string, input: {
  callId: string
  toolName: string
  arguments: string
}): Agent {
  const id = SessionId(sessionId)
  const session = ctx.sessions.create(id, { meta: { cwd: '/work/alpha', agentPreset: 'primary' } })
  const agent: Agent = { id, options: {}, session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    ctx: new Context(), status: 'idle', cancel() {}, whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {} }
  ctx.agents.register(agent)
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('approval/policy', { policy: 'ask' })
  appendSandboxMode(session, 'workspace-write')
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Please complete this exact requested action.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: CallId(input.callId),
    name: input.toolName, arguments: input.arguments })
  return agent
}

function appendSandboxMode(session: Session, mode: 'workspace-write' | 'danger-full-access'): void {
  const append = session.append as unknown as (type: string, data: unknown) => unknown
  append.call(session, 'sandbox/mode', { mode })
}

const principal = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner' }
const conversation = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm' as const, chat: 'oc_owner' }
const envelope: InboundEnvelope = { channel: 'lark', account: 'bot-1', eventId: 'evt-1', occurredAt: 1,
  principal, conversation, kind: 'text', text: 'hello' }

async function boundApprovalHarness(options: MountHarnessOptions & {
  sessionId?: string
  route?: ConversationRef
  arguments?: string
} = {}) {
  const { sessionId = 'delivery-session-approval', route = conversation,
    arguments: rawArguments = '{"path":"/work/alpha/a.txt"}', ...mountOptions } = options
  const fixture = await harness(true, { approval: true, ...mountOptions })
  const challenge = fixture.service.issuePairing('test', principal)
  fixture.service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
  if (mountOptions.reviewer === undefined) {
    fixture.service.registerInboundRuntime({ createSession: async () => ({ sessionId,
      workspace: '/work/alpha', agentPreset: 'primary', policyRef: 'owner-dm' }),
    process: async () => ({ outcome: 'processed' }) })
    await fixture.service.acceptInbound({ ...envelope, eventId: `evt-${sessionId}`, conversation: route })
  } else {
    const rawStore = (fixture.service as unknown as { deliveryStore: {
      createBinding(input: {
        conversation: ConversationRef
        principal: typeof principal
        workspace: string
        agentPreset: string
        sessionId: string
        policyRef: string
      }): ConversationBinding
    } }).deliveryStore
    rawStore.createBinding({ conversation: route, principal, workspace: '/work/alpha', agentPreset: 'primary',
      sessionId, policyRef: 'owner-dm' })
  }
  const binding = fixture.service.history(foreground(sessionId), {}).binding
  const agent = registerApprovalAgent(fixture.ctx, binding.sessionId, {
    callId: 'call-delivery-1', toolName: 'write_file', arguments: rawArguments,
  })
  return { ...fixture, agent, binding, rawArguments }
}

describe('assistant delivery Cordis service', () => {
  test('defaults external sessions to the shipped standard preset', () => {
    const config = AssistantDeliveryService.Config({
      databasePath: '/tmp/delivery.sqlite',
      spoolPath: '/tmp/spool',
    })
    expect(config.defaultAgentPreset).toBe('standard')
    expect(config.toolCapableProviders).toEqual(['deepseek-official'])
    expect(config.unknownRouteToolCalls).toBe('allow')
    expect(config.toolApprovalTtlMs).toBe(300_000)
    expect(() => AssistantDeliveryService.Config({
      databasePath: '/tmp/delivery.sqlite',
      spoolPath: '/tmp/spool',
      toolCapableProviders: ['bad route'],
    })).toThrow(/toolCapableProviders|pattern|invalid/i)
    for (const toolApprovalTtlMs of [999, 300_001]) {
      expect(() => AssistantDeliveryService.Config({
        databasePath: '/tmp/delivery.sqlite',
        spoolPath: '/tmp/spool',
        toolApprovalTtlMs,
      })).toThrow(/toolApprovalTtlMs|invalid/i)
    }
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
    const readInboundImage = vi.fn(async () => ({ outcome: 'downloaded' as const,
      data: new Uint8Array([1]), mediaType: 'image/png' as const }))
    await denied.service.registerAdapter({
      channel: 'lark',
      account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'], inboundImages: true },
      start: async () => {},
      readInboundImage,
      send: async () => ({ outcome: 'accepted', providerMessageId: 'om_unused' }),
    })
    await expect(denied.service.acceptInbound({ ...envelope,
      attachments: [{ resourceType: 'image', providerRef: 'private_unauthorized_image' }] }))
      .resolves.toMatchObject({ duplicate: false,
      status: 'dead_letter' })
    await denied.service.tick()
    await denied.service.whenIdle()
    expect(readInboundImage).not.toHaveBeenCalled()
    await denied.ctx.fiber.restart()
  })

  test('dead-letters a second authorized principal instead of entering another principal binding', async () => {
    const { ctx, service } = await harness()
    for (const candidate of [principal, { ...principal, user: 'ou_linked' }]) {
      const challenge = service.issuePairing('test', candidate)
      service.confirmPairing({ challengeId: challenge.challenge.id, principal: candidate, code: challenge.code })
    }
    const createSession = vi.fn(async () => ({ sessionId: 'group-session-1', workspace: '/work/alpha',
      agentPreset: 'primary', policyRef: 'owner-group' }))
    service.registerInboundRuntime({ createSession, process: async () => ({ outcome: 'processed' }) })
    const group = { ...conversation, kind: 'group' as const, chat: 'oc_shared_group', thread: 'omt_shared_thread' }
    const first = await service.acceptInbound({ ...envelope, eventId: 'evt-group-owner', conversation: group })
    const second = await service.acceptInbound({ ...envelope, eventId: 'evt-group-second', conversation: group,
      principal: { ...principal, user: 'ou_linked' } })

    expect(first.status).toBe('queued')
    expect(second.status).toBe('dead_letter')
    expect(createSession).toHaveBeenCalledOnce()
    const rawStore = (service as unknown as { deliveryStore: {
      getInbox(id: string): { status: string; failureCode?: string; bindingId?: string }
    } }).deliveryStore
    expect(rawStore.getInbox(second.inboxId)).toMatchObject({
      status: 'dead_letter', failureCode: 'binding-principal-mismatch',
    })
    expect(rawStore.getInbox(second.inboxId)).not.toHaveProperty('bindingId')
    await ctx.fiber.restart()
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
    expect(() => service.enqueueBackground({ sourceId: 'automation-1', workspace: '/work/other', bindingId: binding.id,
      idempotencyKey: 'automation:cross-workspace', text: 'no' }))
      .toThrowError(expect.objectContaining({ code: 'missing-binding' }))
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

  test('does not admit any outbound reply after the bound principal is revoked', async () => {
    const { ctx, service } = await harness()
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    service.registerInboundRuntime({ createSession: async () => ({ sessionId: 'delivery-session-revoked-send',
      workspace: '/work/alpha', agentPreset: 'primary', policyRef: 'owner-dm' }),
    process: async () => ({ outcome: 'processed' }) })
    await service.acceptInbound({ ...envelope, eventId: 'evt-revoked-send' })
    const agent = foreground('delivery-session-revoked-send')
    const binding = service.history(agent, {}).binding
    const rawStore = (service as unknown as { deliveryStore: {
      getPrincipal(input: typeof principal): { id: string; version: number }
      revokePrincipal(id: string, version: number): unknown
      listOutbox(input: { bindingId: string }): unknown[]
    } }).deliveryStore
    const owner = rawStore.getPrincipal(principal)
    rawStore.revokePrincipal(owner.id, owner.version)

    expect(() => service.enqueueBackground({ sourceId: 'automation-1', workspace: '/work/alpha',
      bindingId: binding.id, idempotencyKey: 'revoked-background', text: 'must not queue' }))
      .toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    expect(() => service.reply(agent, { idempotencyKey: 'revoked-reply', text: 'must not queue' }))
      .toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    const replyCommand = (service as unknown as { replyCommand(binding: ConversationBinding, input: {
      idempotencyKey: string
      text: string
      replyToEventId: string
    }): unknown }).replyCommand.bind(service)
    expect(() => replyCommand(binding, { idempotencyKey: 'revoked-command', text: 'must not queue',
      replyToEventId: 'evt-revoked-send' }))
      .toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    expect(rawStore.listOutbox({ bindingId: binding.id })).toHaveLength(0)
    await ctx.fiber.restart()
  })

  test('uses the same monotonic generation for a session recreated after revoke and re-pair', async () => {
    const { ctx, service } = await harness()
    const firstPairing = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: firstPairing.challenge.id, principal, code: firstPairing.code })
    const createSession = vi.fn(async (input: { generation: number }) => ({
      sessionId: `delivery-session-generation-${input.generation}`,
      workspace: '/work/alpha',
      agentPreset: 'primary',
      policyRef: 'owner-dm',
    }))
    service.registerInboundRuntime({ createSession, process: async () => ({ outcome: 'processed' }) })
    await service.acceptInbound({ ...envelope, eventId: 'evt-generation-1' })

    const rawStore = (service as unknown as { deliveryStore: {
      getPrincipal(input: typeof principal): { id: string; version: number }
      revokePrincipal(id: string, version: number): unknown
    } }).deliveryStore
    const owner = rawStore.getPrincipal(principal)
    rawStore.revokePrincipal(owner.id, owner.version)
    const secondPairing = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: secondPairing.challenge.id, principal, code: secondPairing.code })

    await service.acceptInbound({ ...envelope, eventId: 'evt-generation-2' })

    expect(createSession.mock.calls.map(([input]) => input.generation)).toEqual([1, 2])
    expect(service.history(foreground('delivery-session-generation-2'), {}).binding)
      .toMatchObject({ sessionId: 'delivery-session-generation-2', generation: 2 })
    await ctx.fiber.restart()
  })

  test('rejects forged Agent headers for reply and history even when Policy would allow the forged subject', async () => {
    const { ctx, service } = await harness()
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    service.registerInboundRuntime({ createSession: async () => ({ sessionId: 'delivery-session-1', workspace: '/work/alpha',
      agentPreset: 'primary', policyRef: 'owner-dm' }), process: async () => ({ outcome: 'processed' }) })
    await service.acceptInbound(envelope)
    const binding = service.history(foreground('delivery-session-1'), {}).binding
    const forgedAgents = [
      foregroundWithHeader('delivery-session-1', '/work/forged', 'primary'),
      foregroundWithHeader('delivery-session-1', '/work/alpha', 'forged'),
    ]
    for (const agent of forgedAgents) {
      expect(ctx.assistantPolicy.authorizeAgent(agent, 'reply', { kind: 'message', id: binding.id }))
        .toMatchObject({ effect: 'allow' })
      expect(ctx.assistantPolicy.authorizeAgent(agent, 'history', { kind: 'message', id: binding.id }))
        .toMatchObject({ effect: 'allow' })
      expect(() => service.reply(agent, { idempotencyKey: `forged-reply:${agent.session.header.agentPreset}`,
        text: 'must not send' })).toThrowError(expect.objectContaining({ code: 'missing-binding' }))
      expect(() => service.history(agent, {}))
        .toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    }
    expect(service.history(foreground('delivery-session-1'), {}).outbox).toHaveLength(0)
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

  test('routes one exact persisted tool call to its bound owner adapter', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(10_000)
    let flushedAsked = false
    const flush = vi.fn((session: Session) => {
      flushedAsked = session.events.some(event => event.type === 'approval/asked'
        && String(event.data.callId) === 'call-delivery-1')
    })
    const { ctx, service } = await harness(true, { approval: true, flush, toolApprovalTtlMs: 2_000 })
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    service.registerInboundRuntime({ createSession: async () => ({ sessionId: 'delivery-session-approval',
      workspace: '/work/alpha', agentPreset: 'primary', policyRef: 'owner-dm' }),
    process: async () => ({ outcome: 'processed' }) })
    await service.acceptInbound({ ...envelope, eventId: 'evt-tool-approval' })
    const binding = service.history(foreground('delivery-session-approval'), {}).binding
    const rawArguments = '{ "path": "/work/alpha/a.txt", "mode": "write" }'
    const agent = registerApprovalAgent(ctx, binding.sessionId, {
      callId: 'call-delivery-1', toolName: 'write_file', arguments: rawArguments,
    })
    const requestToolApproval = vi.fn(async () => 'allowed-once' as const)
    await service.registerAdapter({
      channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'], toolApprovals: true },
      start: async () => {}, requestToolApproval,
      send: async () => ({ outcome: 'accepted', providerMessageId: 'om_unused' }),
    })

    await expect(ctx.approval.request({ agent, toolName: 'write_file', callId: CallId('call-delivery-1'),
      reason: 'Write the requested file' })).resolves.toBe('allowed-once')

    expect(flush).toHaveBeenCalledWith(agent.session)
    expect(flushedAsked).toBe(true)
    expect(requestToolApproval).toHaveBeenCalledOnce()
    expect(requestToolApproval).toHaveBeenCalledWith(expect.objectContaining({
      operationId: expect.stringMatching(/^tool-approval:[0-9a-f-]{36}$/u),
      bindingId: binding.id,
      target: { conversation, principal },
      expiresAt: 12_000,
      actionHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      toolName: 'write_file',
      callId: 'call-delivery-1',
      reason: 'Write the requested file',
      arguments: rawArguments,
    }), expect.any(AbortSignal))
    await ctx.fiber.restart()
  })

  test('does not release an owner grant after the policy emergency stop is enabled', async () => {
    const fixture = await boundApprovalHarness({ sessionId: 'approval-emergency-stop' })
    let answer!: (outcome: 'allowed-once') => void
    const requestToolApproval = vi.fn(() => new Promise<'allowed-once'>(resolve => { answer = resolve }))
    await fixture.service.registerAdapter({
      channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'], toolApprovals: true },
      start: async () => {}, requestToolApproval,
      send: async () => ({ outcome: 'accepted', providerMessageId: 'om_unused' }),
    })

    const pending = fixture.ctx.approval.request({
      agent: fixture.agent,
      toolName: 'write_file',
      callId: CallId('call-delivery-1'),
      reason: 'Write the requested file',
    })
    await vi.waitFor(() => expect(requestToolApproval).toHaveBeenCalledOnce())
    fixture.ctx.assistantPolicy.setEmergencyStop({
      enabled: true,
      actor: 'test:owner',
      reason: 'stop before a pending one-shot grant is released',
    })
    answer('allowed-once')

    await expect(pending).resolves.toBe('unavailable')
    await fixture.ctx.fiber.restart()
  })

  test('does not show exact tool arguments when the policy emergency stop is already enabled', async () => {
    const fixture = await boundApprovalHarness({ sessionId: 'approval-emergency-stop-initial' })
    const requestToolApproval = vi.fn(async () => 'allowed-once' as const)
    await fixture.service.registerAdapter({
      channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'], toolApprovals: true },
      start: async () => {}, requestToolApproval,
      send: async () => ({ outcome: 'accepted', providerMessageId: 'om_unused' }),
    })
    fixture.ctx.assistantPolicy.setEmergencyStop({
      enabled: true,
      actor: 'test:owner',
      reason: 'stop before requesting approval',
    })

    await expect(fixture.ctx.approval.request({
      agent: fixture.agent,
      toolName: 'write_file',
      callId: CallId('call-delivery-1'),
      reason: 'Write the requested file',
    })).resolves.toBe('unavailable')
    expect(requestToolApproval).not.toHaveBeenCalled()
    await fixture.ctx.fiber.restart()
  })

  test('invalidates an owner grant across an emergency-stop enable-disable ABA', async () => {
    const fixture = await boundApprovalHarness({ sessionId: 'approval-emergency-stop-aba' })
    let answer!: (outcome: 'allowed-once') => void
    const requestToolApproval = vi.fn(() => new Promise<'allowed-once'>(resolve => { answer = resolve }))
    await fixture.service.registerAdapter({
      channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'], toolApprovals: true },
      start: async () => {}, requestToolApproval,
      send: async () => ({ outcome: 'accepted', providerMessageId: 'om_unused' }),
    })

    const pending = fixture.ctx.approval.request({
      agent: fixture.agent,
      toolName: 'write_file',
      callId: CallId('call-delivery-1'),
      reason: 'Write the requested file',
    })
    await vi.waitFor(() => expect(requestToolApproval).toHaveBeenCalledOnce())
    fixture.ctx.assistantPolicy.setEmergencyStop({
      enabled: true,
      actor: 'test:owner',
      reason: 'invalidate every outstanding owner grant',
    })
    fixture.ctx.assistantPolicy.setEmergencyStop({
      enabled: false,
      actor: 'test:owner',
      reason: 'resume only with fresh approval cards',
    })
    answer('allowed-once')

    await expect(pending).resolves.toBe('unavailable')
    await fixture.ctx.fiber.restart()
  })

  test('routes one exact open Code Mode sub-call and binds its dispatch identity', async () => {
    const fixture = await boundApprovalHarness({ sessionId: 'approval-code-dispatch' })
    const subCallId = CallId('call-delivery-1:code:0')
    const argumentsValue = { path: '/work/alpha/code-mode.txt', mode: 'write' }
    fixture.agent.session.append('tool/code-dispatch-start', {
      rootCallId: CallId('call-delivery-1'),
      parentCallId: CallId('call-delivery-1'),
      subCallId,
      name: 'write_file',
      arguments: argumentsValue,
    })
    const requestToolApproval = vi.fn(async () => 'allowed-once' as const)
    await fixture.service.registerAdapter({
      channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'], toolApprovals: true },
      start: async () => {}, requestToolApproval,
      send: async () => ({ outcome: 'accepted', providerMessageId: 'om_unused' }),
    })

    await expect(fixture.ctx.approval.request({
      agent: fixture.agent,
      toolName: 'write_file',
      callId: subCallId,
      reason: 'Write the requested file from Code Mode.',
    })).resolves.toBe('allowed-once')

    expect(requestToolApproval).toHaveBeenCalledOnce()
    expect(requestToolApproval).toHaveBeenCalledWith(expect.objectContaining({
      actionHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      toolName: 'write_file',
      callId: String(subCallId),
      arguments: JSON.stringify(argumentsValue),
    }), expect.any(AbortSignal))
    await fixture.ctx.fiber.restart()
  })

  test('never prompts for an already settled Code Mode sub-call', async () => {
    const fixture = await boundApprovalHarness({ sessionId: 'approval-code-dispatch-settled' })
    const dispatch = {
      rootCallId: CallId('call-delivery-1'),
      parentCallId: CallId('call-delivery-1'),
      subCallId: CallId('call-delivery-1:code:0'),
      name: 'write_file',
      arguments: { path: '/work/alpha/code-mode.txt', mode: 'write' },
    }
    fixture.agent.session.append('tool/code-dispatch-start', dispatch)
    fixture.agent.session.append('tool/code-dispatch', {
      ...dispatch,
      isError: false,
      content: [{ type: 'text', text: 'already settled' }],
    })
    const requestToolApproval = vi.fn(async () => 'allowed-once' as const)
    await fixture.service.registerAdapter({
      channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'], toolApprovals: true },
      start: async () => {}, requestToolApproval,
      send: async () => ({ outcome: 'accepted', providerMessageId: 'om_unused' }),
    })

    await expect(fixture.ctx.approval.request({
      agent: fixture.agent,
      toolName: 'write_file',
      callId: dispatch.subCallId,
      reason: 'Write the requested file from Code Mode.',
    })).resolves.toBe('unavailable')
    expect(requestToolApproval).not.toHaveBeenCalled()
    await fixture.ctx.fiber.restart()
  })

  test('falls through once only for unbound or auto-reviewed asks and claims bound user asks', async () => {
    const unboundFlush = vi.fn()
    const unbound = await harness(true, { approval: true, flush: unboundFlush })
    const unboundAgent = registerApprovalAgent(unbound.ctx, 'unbound-session', {
      callId: 'call-delivery-1', toolName: 'write_file', arguments: '{}',
    })
    const unboundNext = vi.fn(async () => 'rejected' as const)
    unbound.ctx.on('approval/request', unboundNext)
    await expect(unbound.ctx.approval.request({ agent: unboundAgent, toolName: 'write_file',
      callId: CallId('call-delivery-1') })).resolves.toBe('rejected')
    expect(unboundNext).toHaveBeenCalledOnce()
    expect(unboundFlush).not.toHaveBeenCalled()
    await unbound.ctx.fiber.restart()

    const flush = vi.fn()
    const bound = await boundApprovalHarness({ flush, sessionId: 'approval-waterfall' })
    bound.agent.session.append('assistant-policy/approval-reviewer', { reviewer: 'auto-review' })
    const next = vi.fn(async () => 'rejected' as const)
    bound.ctx.on('approval/request', next)
    await expect(bound.ctx.approval.request({ agent: bound.agent, toolName: 'write_file',
      callId: CallId('call-delivery-1') })).resolves.toBe('rejected')
    expect(next).toHaveBeenCalledOnce()
    expect(flush).not.toHaveBeenCalled()

    // `ask + none` is conservatively folded back to the human user reviewer.
    bound.agent.session.append('assistant-policy/approval-reviewer', { reviewer: 'none' })
    await expect(bound.ctx.approval.request({ agent: bound.agent, toolName: 'write_file',
      callId: CallId('call-delivery-1') })).resolves.toBe('unavailable')
    expect(next).toHaveBeenCalledOnce()
    expect(flush).not.toHaveBeenCalled()

    bound.agent.session.append('approval/policy', { policy: 'never' })
    appendSandboxMode(bound.agent.session, 'danger-full-access')
    const noneNext = vi.fn(async () => 'rejected' as const)
    const deliveryAnswerer = (bound.service as unknown as { requestToolApproval(
      approvalCtx: Context,
      request: { agent: Agent; toolName: string; callId: CallId },
      next: () => Promise<'rejected'>,
    ): Promise<string> }).requestToolApproval.bind(bound.service)
    await expect(deliveryAnswerer(bound.ctx, { agent: bound.agent, toolName: 'write_file',
      callId: CallId('call-delivery-1') }, noneNext)).resolves.toBe('unavailable')
    expect(noneNext).not.toHaveBeenCalled()
    await bound.ctx.fiber.restart()
  })

  test('composes ask, auto-review escalation, and full approval modes without routing by listener order', async () => {
    const contexts: Context[] = []
    const setup = async (
      sessionId: string,
      scripts: string[],
      reviewer: 'auto-review' | 'none' | 'user',
      reviewerMountOrder?: MountHarnessOptions['reviewerMountOrder'],
    ) => {
      const modelReviewer = new DeliveryReviewerAdapter(scripts)
      const fixture = await boundApprovalHarness({ sessionId, reviewer: modelReviewer,
        ...(reviewerMountOrder === undefined ? {} : { reviewerMountOrder }) })
      contexts.push(fixture.ctx)
      fixture.agent.session.append('assistant-policy/approval-reviewer', { reviewer })
      const requestToolApproval = vi.fn(async () => 'allowed-once' as const)
      await fixture.service.registerAdapter({
        channel: 'lark', account: 'bot-1',
        capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'], toolApprovals: true },
        start: async () => {}, requestToolApproval,
        send: async () => ({ outcome: 'accepted', providerMessageId: 'om_unused' }),
      })
      return { ...fixture, modelReviewer, requestToolApproval }
    }

    try {
      const ask = await setup('approval-mode-ask', [], 'user')
      await expect(ask.ctx.approval.request({ agent: ask.agent, toolName: 'write_file',
        callId: CallId('call-delivery-1'), reason: HUMAN_APPROVAL_REASON })).resolves.toBe('allowed-once')
      expect(ask.modelReviewer.requests).toHaveLength(0)
      expect(ask.requestToolApproval).toHaveBeenCalledOnce()

      const autoAllowed = await setup('approval-mode-auto-allowed', [reviewerAssessment('allow')], 'auto-review')
      await expect(autoAllowed.ctx.approval.request({ agent: autoAllowed.agent, toolName: 'write_file',
        callId: CallId('call-delivery-1'), reason: AUTO_REVIEW_APPROVAL_REASON })).resolves.toBe('allowed-once')
      expect(autoAllowed.modelReviewer.requests).toHaveLength(1)
      expect(autoAllowed.requestToolApproval).not.toHaveBeenCalled()

      const autoRisky = await setup('approval-mode-auto-risky', [], 'auto-review')
      await expect(autoRisky.ctx.approval.request({ agent: autoRisky.agent, toolName: 'write_file',
        callId: CallId('call-delivery-1'), reason: HUMAN_APPROVAL_REASON })).resolves.toBe('allowed-once')
      expect(autoRisky.modelReviewer.requests).toHaveLength(0)
      expect(autoRisky.requestToolApproval).toHaveBeenCalledOnce()

      const nativeEscalation = await setup('approval-mode-native-escalation', [], 'auto-review')
      const nativeCallId = CallId('call-native-escalation')
      const justification = 'Download the exact source archive requested by the user.'
      nativeEscalation.agent.session.append('tool/call', {
        turn: 1,
        step: 1,
        callId: nativeCallId,
        name: 'bash',
        arguments: JSON.stringify({
          command: 'curl https://example.com/archive.tgz',
          sandbox_permissions: 'danger-full-access',
          justification,
        }),
      })
      await expect(nativeEscalation.ctx.approval.request({
        agent: nativeEscalation.agent,
        toolName: 'bash',
        callId: nativeCallId,
        reason: `escalate sandbox to danger-full-access: ${justification}`,
      })).resolves.toBe('allowed-once')
      expect(nativeEscalation.modelReviewer.requests).toHaveLength(0)
      expect(nativeEscalation.requestToolApproval).toHaveBeenCalledOnce()

      const autoEscalated = await setup('approval-mode-auto-escalated',
        [reviewerAssessment('escalate')], 'auto-review', 'after-delivery')
      await expect(autoEscalated.ctx.approval.request({ agent: autoEscalated.agent, toolName: 'write_file',
        callId: CallId('call-delivery-1'), reason: AUTO_REVIEW_APPROVAL_REASON })).resolves.toBe('allowed-once')
      expect(autoEscalated.modelReviewer.requests).toHaveLength(1)
      expect(autoEscalated.requestToolApproval).toHaveBeenCalledOnce()

      const autoUnknown = await setup('approval-mode-auto-unknown', [], 'auto-review')
      await expect(autoUnknown.ctx.approval.request({ agent: autoUnknown.agent, toolName: 'write_file',
        callId: CallId('call-delivery-1'), reason: 'unowned custom approval request' }))
        .resolves.toBe('unavailable')
      expect(autoUnknown.modelReviewer.requests).toHaveLength(0)
      expect(autoUnknown.requestToolApproval).not.toHaveBeenCalled()

      const full = await setup('approval-mode-full', [], 'none')
      full.agent.session.append('approval/policy', { policy: 'never' })
      appendSandboxMode(full.agent.session, 'danger-full-access')
      await expect(full.ctx.approval.request({ agent: full.agent, toolName: 'write_file',
        callId: CallId('call-delivery-1'), reason: HUMAN_APPROVAL_REASON })).resolves.toBe('rejected')
      expect(full.modelReviewer.requests).toHaveLength(0)
      expect(full.requestToolApproval).not.toHaveBeenCalled()
    } finally {
      await Promise.all(contexts.map(ctx => ctx.fiber.restart()))
    }
  })

  test('keeps concurrent auto-review escalations bound to their exact requests', async () => {
    const modelReviewer = new DeliveryReviewerAdapter([
      reviewerAssessment('escalate'), reviewerAssessment('escalate'),
    ])
    const fixture = await boundApprovalHarness({ sessionId: 'approval-auto-concurrent', reviewer: modelReviewer })
    fixture.agent.session.append('assistant-policy/approval-reviewer', { reviewer: 'auto-review' })
    fixture.agent.session.append('tool/call', { turn: 1, step: 1, callId: CallId('call-delivery-2'),
      name: 'write_file', arguments: '{"path":"/work/alpha/b.txt"}' })
    const answers = new Map<string, (outcome: 'allowed-once') => void>()
    const requestToolApproval = vi.fn((input: Parameters<NonNullable<DeliveryAdapter['requestToolApproval']>>[0]) =>
      new Promise<'allowed-once'>(resolve => answers.set(input.callId, resolve)))
    await fixture.service.registerAdapter({
      channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'], toolApprovals: true },
      start: async () => {}, requestToolApproval,
      send: async () => ({ outcome: 'accepted', providerMessageId: 'om_unused' }),
    })

    const first = fixture.ctx.approval.request({ agent: fixture.agent, toolName: 'write_file',
      callId: CallId('call-delivery-1'), reason: AUTO_REVIEW_APPROVAL_REASON })
    const second = fixture.ctx.approval.request({ agent: fixture.agent, toolName: 'write_file',
      callId: CallId('call-delivery-2'), reason: AUTO_REVIEW_APPROVAL_REASON })
    await vi.waitFor(() => expect(requestToolApproval).toHaveBeenCalledTimes(2))
    expect(modelReviewer.requests).toHaveLength(2)
    expect(requestToolApproval.mock.calls.map(([input]) => [input.callId, input.arguments]).sort()).toEqual([
      ['call-delivery-1', fixture.rawArguments],
      ['call-delivery-2', '{"path":"/work/alpha/b.txt"}'],
    ])
    answers.get('call-delivery-2')!('allowed-once')
    answers.get('call-delivery-1')!('allowed-once')
    await expect(Promise.all([first, second])).resolves.toEqual(['allowed-once', 'allowed-once'])
    await fixture.ctx.fiber.restart()
  })

  test('does not leak one live auto-review escalation marker into a concurrent request', async () => {
    const modelReviewer = new DeliveryReviewerAdapter([reviewerAssessment('escalate')])
    const fixture = await boundApprovalHarness({ sessionId: 'approval-auto-isolation', reviewer: modelReviewer })
    fixture.agent.session.append('assistant-policy/approval-reviewer', { reviewer: 'auto-review' })
    fixture.agent.session.append('tool/call', { turn: 1, step: 1, callId: CallId('call-delivery-2'),
      name: 'write_file', arguments: '{"path":"/work/alpha/b.txt"}' })
    let answer!: (outcome: 'allowed-once') => void
    const requestToolApproval = vi.fn(() => new Promise<'allowed-once'>(resolve => { answer = resolve }))
    await fixture.service.registerAdapter({
      channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'], toolApprovals: true },
      start: async () => {}, requestToolApproval,
      send: async () => ({ outcome: 'accepted', providerMessageId: 'om_unused' }),
    })

    const escalated = fixture.ctx.approval.request({ agent: fixture.agent, toolName: 'write_file',
      callId: CallId('call-delivery-1'), reason: AUTO_REVIEW_APPROVAL_REASON })
    await vi.waitFor(() => expect(requestToolApproval).toHaveBeenCalledOnce())
    await expect(fixture.ctx.approval.request({ agent: fixture.agent, toolName: 'write_file',
      callId: CallId('call-delivery-2'), reason: 'unowned custom approval request' }))
      .resolves.toBe('unavailable')
    expect(modelReviewer.requests).toHaveLength(1)
    expect(requestToolApproval).toHaveBeenCalledOnce()
    expect(requestToolApproval).toHaveBeenCalledWith(expect.objectContaining({
      callId: 'call-delivery-1',
      arguments: fixture.rawArguments,
    }), expect.any(AbortSignal))
    answer('allowed-once')
    await expect(escalated).resolves.toBe('allowed-once')
    await fixture.ctx.fiber.restart()
  })

  test('requires a successful durability participant before prompting the owner', async () => {
    for (const [suffix, flush] of [
      ['missing', false],
      ['throwing', () => { throw new Error('disk unavailable') }],
    ] as const) {
      const fixture = await boundApprovalHarness({ flush, sessionId: `approval-flush-${suffix}` })
      const requestToolApproval = vi.fn(async () => 'allowed-once' as const)
      await fixture.service.registerAdapter({
        channel: 'lark', account: 'bot-1',
        capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'], toolApprovals: true },
        start: async () => {}, requestToolApproval,
        send: async () => ({ outcome: 'accepted', providerMessageId: 'om_unused' }),
      })

      await expect(fixture.ctx.approval.request({ agent: fixture.agent, toolName: 'write_file',
        callId: CallId('call-delivery-1') })).resolves.toBe('unavailable')
      expect(requestToolApproval).not.toHaveBeenCalled()
      await fixture.ctx.fiber.restart()
    }
  })

  test('rejects stale-turn, group, and oversized tool approval routes without prompting', async () => {
    const fixtures = [
      await boundApprovalHarness({ sessionId: 'approval-stale-turn' }),
      await boundApprovalHarness({ sessionId: 'approval-group',
        route: { ...conversation, kind: 'group', chat: 'oc_group_approval', thread: 'omt_group_approval' } }),
      await boundApprovalHarness({ sessionId: 'approval-oversized', arguments: 'x'.repeat(16 * 1024 + 1) }),
      await boundApprovalHarness({ sessionId: 'approval-completed-call' }),
    ]
    fixtures[0]!.agent.session.append('step/end', { turn: 1, step: 1 })
    fixtures[0]!.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    fixtures[0]!.agent.session.append('turn/start', { turn: 2 })
    fixtures[0]!.agent.session.append('step/start', { turn: 2, step: 1 })
    fixtures[3]!.agent.session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId: CallId('call-delivery-1'),
        content: [{ type: 'text', text: 'already finished' }], isError: false }) }, { surfaceOp: 'append' })

    for (const fixture of fixtures) {
      const requestToolApproval = vi.fn(async () => 'allowed-once' as const)
      await fixture.service.registerAdapter({
        channel: 'lark', account: 'bot-1',
        capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'], toolApprovals: true },
        start: async () => {}, requestToolApproval,
        send: async () => ({ outcome: 'accepted', providerMessageId: 'om_unused' }),
      })
      await expect(fixture.ctx.approval.request({ agent: fixture.agent, toolName: 'write_file',
        callId: CallId('call-delivery-1') })).resolves.toBe('unavailable')
      expect(requestToolApproval).not.toHaveBeenCalled()
      await fixture.ctx.fiber.restart()
    }
  })

  test('rejects an oversized approval reason instead of truncating authorization display', async () => {
    const fixture = await boundApprovalHarness({ sessionId: 'approval-reason-limit' })
    const requestToolApproval = vi.fn(async () => 'allowed-once' as const)
    await fixture.service.registerAdapter({
      channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'], toolApprovals: true },
      start: async () => {}, requestToolApproval,
      send: async () => ({ outcome: 'accepted', providerMessageId: 'om_unused' }),
    })
    await expect(fixture.ctx.approval.request({ agent: fixture.agent, toolName: 'write_file',
      callId: CallId('call-delivery-1'), reason: 'r'.repeat(2 * 1024 + 1) })).resolves.toBe('unavailable')
    expect(requestToolApproval).not.toHaveBeenCalled()
    await fixture.ctx.fiber.restart()
  })

  test('supports an explicit delegated owner route and invalidates it when unbound', async () => {
    const fixture = await boundApprovalHarness({ sessionId: 'approval-delegated-owner' })
    const delegated = registerApprovalAgent(fixture.ctx, 'approval-background-agent', {
      callId: 'call-delegated-1', toolName: 'write_file', arguments: '{"path":"/work/alpha/delegated.txt"}',
    })
    const unbind = fixture.service.bindAgentApprovalRoute(delegated, { bindingId: fixture.binding.id })
    const requestToolApproval = vi.fn(async () => {
      unbind()
      return 'allowed-once' as const
    })
    await fixture.service.registerAdapter({
      channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'], toolApprovals: true },
      start: async () => {}, requestToolApproval,
      send: async () => ({ outcome: 'accepted', providerMessageId: 'om_unused' }),
    })
    await expect(fixture.ctx.approval.request({ agent: delegated, toolName: 'write_file',
      callId: CallId('call-delegated-1') })).resolves.toBe('unavailable')
    expect(requestToolApproval).toHaveBeenCalledOnce()
    await fixture.ctx.fiber.restart()
  })

  test('revalidates reviewer and owner authority around persistence and the remote answer', async () => {
    const beforePrompt = await boundApprovalHarness({ sessionId: 'approval-reviewer-drift',
      flush: session => { session.append('assistant-policy/approval-reviewer', { reviewer: 'auto-review' }) } })
    const driftedPrompt = vi.fn(async () => 'allowed-once' as const)
    await beforePrompt.service.registerAdapter({
      channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'], toolApprovals: true },
      start: async () => {}, requestToolApproval: driftedPrompt,
      send: async () => ({ outcome: 'accepted', providerMessageId: 'om_unused' }),
    })
    await expect(beforePrompt.ctx.approval.request({ agent: beforePrompt.agent, toolName: 'write_file',
      callId: CallId('call-delivery-1') })).resolves.toBe('unavailable')
    expect(driftedPrompt).not.toHaveBeenCalled()
    await beforePrompt.ctx.fiber.restart()

    const afterPrompt = await boundApprovalHarness({ sessionId: 'approval-owner-revoked' })
    const rawStore = (afterPrompt.service as unknown as { deliveryStore: {
      getPrincipal(input: typeof principal): { id: string; version: number }
      revokePrincipal(id: string, version: number): unknown
    } }).deliveryStore
    const requestToolApproval = vi.fn(async () => {
      const owner = rawStore.getPrincipal(principal)
      rawStore.revokePrincipal(owner.id, owner.version)
      return 'allowed-once' as const
    })
    await afterPrompt.service.registerAdapter({
      channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'], toolApprovals: true },
      start: async () => {}, requestToolApproval,
      send: async () => ({ outcome: 'accepted', providerMessageId: 'om_unused' }),
    })
    await expect(afterPrompt.ctx.approval.request({ agent: afterPrompt.agent, toolName: 'write_file',
      callId: CallId('call-delivery-1') })).resolves.toBe('unavailable')
    expect(requestToolApproval).toHaveBeenCalledOnce()
    await afterPrompt.ctx.fiber.restart()
  })

  test('times out an open delivery approval and aborts the adapter request', async () => {
    vi.useFakeTimers()
    const fixture = await boundApprovalHarness({ sessionId: 'approval-timeout', toolApprovalTtlMs: 1_000 })
    let adapterSignal: AbortSignal | undefined
    const requestToolApproval = vi.fn((_input, signal: AbortSignal) => {
      adapterSignal = signal
      return new Promise<'allowed-once'>(() => {})
    })
    await fixture.service.registerAdapter({
      channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'], toolApprovals: true },
      start: async () => {}, requestToolApproval,
      send: async () => ({ outcome: 'accepted', providerMessageId: 'om_unused' }),
    })
    const outcome = fixture.ctx.approval.request({ agent: fixture.agent, toolName: 'write_file',
      callId: CallId('call-delivery-1') })
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(outcome).resolves.toBe('unavailable')
    expect(requestToolApproval).toHaveBeenCalledOnce()
    expect(adapterSignal?.aborted).toBe(true)
    await fixture.ctx.fiber.restart()
  })

  test('ignores a retained adapter receipt callback after the delivery store is closed', async () => {
    const { ctx, service } = await harness()
    let retainedContext: Parameters<NonNullable<DeliveryAdapter['start']>>[0] | undefined
    await service.registerAdapter({
      channel: 'lark',
      account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: ['delivered'], formats: ['plain'] },
      start: async context => { retainedContext = context },
      send: async () => ({ outcome: 'accepted', providerMessageId: 'om_late_receipt' }),
    })

    await ctx.fiber.restart()

    await expect(retainedContext!.receipt({
      channel: 'lark',
      account: 'bot-1',
      providerMessageId: 'om_late_receipt',
      status: 'delivered',
      occurredAt: Date.now(),
    })).resolves.toBeUndefined()
  })

  test('fences a late session creation before it can write to a closed delivery store', async () => {
    const { ctx, service } = await harness()
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const createSession = vi.fn(async () => {
      await gate
      return { sessionId: 'late-session', workspace: '/work/alpha', agentPreset: 'primary', policyRef: 'owner-dm' }
    })
    service.registerInboundRuntime({ createSession, process: async () => ({ outcome: 'processed' }) })
    const acceptance = service.acceptInbound({ ...envelope, eventId: 'evt-late-session' })
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledOnce())

    await ctx.fiber.restart()
    release()

    await expect(acceptance).rejects.toMatchObject({ code: 'disposed' })
  })

  test('correlates delayed approval decisions to an exact binding, principal, version, and operation id', async () => {
    const { ctx, service } = await harness()
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    service.registerInboundRuntime({ createSession: async () => ({ sessionId: 'delivery-session-1', workspace: '/work/alpha',
      agentPreset: 'primary', policyRef: 'owner-dm' }), process: async () => ({ outcome: 'processed' }) })
    await service.acceptInbound(envelope)
    const binding = service.history(foreground('delivery-session-1'), {}).binding
    const diff = 'send one reviewed status'
    const proposal = ctx.assistantPolicy.propose({ idempotencyKey: 'approval-1', requester: 'automation:test',
      principal: 'lark/bot-1/tenant-a/ou_owner', action: 'send', resource: { kind: 'message', id: binding.id },
      diff, summary: 'Send reviewed status', ttlMs: 5_000 })
    expect(service.enqueueApproval({ sourceId: 'automation-1', workspace: '/work/alpha', bindingId: binding.id,
      idempotencyKey: 'approval-card-1', text: diff, approval: {
        operationId: 'card-click-1', proposalId: proposal.proposalId, expectedVersion: 1,
        expiresAt: proposal.expiresAt, title: 'Send reviewed status', diffHash: proposal.diffHash,
      } })).toMatchObject({ intent: { format: 'approval', approval: { proposalId: proposal.proposalId } } })
    const input = { operationId: 'card-click-1', callbackEventId: 'card-event-1', callbackChatId: 'oc_owner', bindingId: binding.id,
      principal, proposalId: proposal.proposalId, expectedVersion: 1, diffHash: proposal.diffHash,
      decision: 'approved' as const, reason: 'owner approved' }
    expect(() => service.settleApproval({ ...input, operationId: 'missing-operation' }))
      .toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    expect(() => service.settleApproval({ ...input, diffHash: 'b'.repeat(64) }))
      .toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    expect(service.settleApproval(input)).toMatchObject({ status: 'approved', version: 2, replayed: false })
    expect(service.settleApproval(input)).toMatchObject({ status: 'approved', version: 2 })
    const getProposal = vi.spyOn(ctx.assistantPolicy, 'getProposal').mockReturnValueOnce(undefined)
    expect(service.recoverApprovalSettlement(input)).toBeUndefined()
    expect(getProposal).toHaveBeenCalledWith(proposal.proposalId)
    getProposal.mockRestore()
    expect(() => service.settleApproval({ ...input, decision: 'rejected' }))
      .toThrowError(expect.objectContaining({ code: 'idempotency-conflict' }))
    expect(() => service.settleApproval({ ...input, operationId: 'card-click-other-chat', callbackChatId: 'oc_attacker' }))
      .toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    await ctx.fiber.restart()
  })

  test('does not create a Delivery recovery settlement after Policy was already terminal', async () => {
    const { ctx, service } = await harness()
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    service.registerInboundRuntime({ createSession: async () => ({ sessionId: 'delivery-session-1', workspace: '/work/alpha',
      agentPreset: 'primary', policyRef: 'owner-dm' }), process: async () => ({ outcome: 'processed' }) })
    await service.acceptInbound(envelope)
    const binding = service.history(foreground('delivery-session-1'), {}).binding
    const diff = 'already decided before the card callback'
    const proposal = ctx.assistantPolicy.propose({ idempotencyKey: 'approval-preterminal', requester: 'automation:test',
      principal: 'lark/bot-1/tenant-a/ou_owner', action: 'send', resource: { kind: 'message', id: binding.id },
      diff, summary: 'Already terminal', ttlMs: 5_000 })
    const input = { operationId: 'approval-preterminal-operation', callbackEventId: 'approval-preterminal-event',
      callbackChatId: conversation.chat, bindingId: binding.id, principal, proposalId: proposal.proposalId,
      expectedVersion: proposal.version, diffHash: proposal.diffHash, decision: 'approved' as const,
      reason: 'owner approved exact change' }
    service.enqueueApproval({ sourceId: 'automation-1', workspace: binding.workspace, bindingId: binding.id,
      idempotencyKey: 'approval-preterminal-card', text: diff, approval: { operationId: input.operationId,
        proposalId: proposal.proposalId, expectedVersion: proposal.version, expiresAt: proposal.expiresAt,
        title: 'Already terminal', diffHash: proposal.diffHash } })
    ctx.assistantPolicy.decideProposal({ proposalId: proposal.proposalId,
      principal: 'lark/bot-1/tenant-a/ou_owner', expectedVersion: proposal.version,
      decision: input.decision, reason: input.reason })

    expect(() => service.settleApproval(input))
      .toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    expect(service.recoverApprovalSettlement(input)).toBeUndefined()
    await ctx.fiber.restart()
  })

  test('recovers an exact approval settlement after Policy committed but Delivery restarted before completion', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(10_000)
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-approval-recovery-'))
    roots.push(root)
    const first = await mountHarness(root)
    const challenge = first.service.issuePairing('test', principal)
    first.service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    first.service.registerInboundRuntime({ createSession: async () => ({ sessionId: 'delivery-session-1', workspace: '/work/alpha',
      agentPreset: 'primary', policyRef: 'owner-dm' }), process: async () => ({ outcome: 'processed' }) })
    await first.service.acceptInbound(envelope)
    const binding = first.service.history(foreground('delivery-session-1'), {}).binding
    const diff = 'persist the exact reviewed change'
    const proposal = first.ctx.assistantPolicy.propose({ idempotencyKey: 'approval-crash-recovery', requester: 'automation:test',
      principal: 'lark/bot-1/tenant-a/ou_owner', action: 'send', resource: { kind: 'message', id: binding.id },
      diff, summary: 'Persist reviewed change', ttlMs: 5_000 })
    const input = { operationId: 'approval-crash-operation', callbackEventId: 'approval-crash-event',
      callbackChatId: conversation.chat, bindingId: binding.id, principal, proposalId: proposal.proposalId,
      expectedVersion: proposal.version, diffHash: proposal.diffHash, decision: 'approved' as const,
      reason: 'owner approved exact change' }
    first.service.enqueueApproval({ sourceId: 'automation-1', workspace: binding.workspace, bindingId: binding.id,
      idempotencyKey: 'approval-crash-card', text: diff, approval: { operationId: input.operationId,
        proposalId: proposal.proposalId, expectedVersion: proposal.version, expiresAt: proposal.expiresAt,
        title: 'Persist reviewed change', diffHash: proposal.diffHash } })
    const rawStore = (first.service as unknown as { deliveryStore: {
      beginApprovalSettlement(input: { operationId: string; payload: unknown }): unknown
    } }).deliveryStore
    rawStore.beginApprovalSettlement({ operationId: input.operationId, payload: {
      callbackEventId: input.callbackEventId, callbackChatId: input.callbackChatId, bindingId: input.bindingId,
      principal, proposalId: input.proposalId, expectedVersion: input.expectedVersion,
      diffHash: input.diffHash, decision: input.decision, reason: input.reason,
    } })
    expect(first.ctx.assistantPolicy.decideProposal({ proposalId: input.proposalId,
      principal: 'lark/bot-1/tenant-a/ou_owner', expectedVersion: input.expectedVersion,
      decision: input.decision, reason: input.reason })).toMatchObject({ status: 'approved', replayed: false })
    await first.ctx.fiber.restart()

    vi.setSystemTime(proposal.expiresAt + 1)
    const restarted = await mountHarness(root)
    expect(() => restarted.service.settleApproval(input))
      .toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    expect(restarted.service.recoverApprovalSettlement(input))
      .toMatchObject({ status: 'approved', version: 2, replayed: true })
    expect(restarted.service.recoverApprovalSettlement(input))
      .toMatchObject({ status: 'approved', version: 2, replayed: true })
    await restarted.ctx.fiber.restart()
    vi.useRealTimers()
  })

  test('recovery-only approval settlement cannot create state or decide a pending or expiry terminal proposal', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(20_000)
    const { ctx, service } = await harness()
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    service.registerInboundRuntime({ createSession: async () => ({ sessionId: 'delivery-session-1', workspace: '/work/alpha',
      agentPreset: 'primary', policyRef: 'owner-dm' }), process: async () => ({ outcome: 'processed' }) })
    await service.acceptInbound(envelope)
    const binding = service.history(foreground('delivery-session-1'), {}).binding
    const diff = 'reviewed change that expires before a decision'
    const proposal = ctx.assistantPolicy.propose({ idempotencyKey: 'approval-expiry-recovery', requester: 'automation:test',
      principal: 'lark/bot-1/tenant-a/ou_owner', action: 'send', resource: { kind: 'message', id: binding.id },
      diff, summary: 'Expiry recovery', ttlMs: 100 })
    const input = { operationId: 'approval-expiry-operation', callbackEventId: 'approval-expiry-event',
      callbackChatId: conversation.chat, bindingId: binding.id, principal, proposalId: proposal.proposalId,
      expectedVersion: proposal.version, diffHash: proposal.diffHash, decision: 'approved' as const,
      reason: 'owner approved too late' }
    service.enqueueApproval({ sourceId: 'automation-1', workspace: binding.workspace, bindingId: binding.id,
      idempotencyKey: 'approval-expiry-card', text: diff, approval: { operationId: input.operationId,
        proposalId: proposal.proposalId, expectedVersion: proposal.version, expiresAt: proposal.expiresAt,
        title: 'Expiry recovery', diffHash: proposal.diffHash } })

    expect(service.recoverApprovalSettlement(input)).toBeUndefined()
    const rawStore = (service as unknown as { deliveryStore: {
      beginApprovalSettlement(input: { operationId: string; payload: unknown; createIfMissing?: boolean }): unknown
    } }).deliveryStore
    expect(() => rawStore.beginApprovalSettlement({ operationId: input.operationId, payload: {
      callbackEventId: input.callbackEventId, callbackChatId: input.callbackChatId, bindingId: input.bindingId,
      principal, proposalId: input.proposalId, expectedVersion: input.expectedVersion,
      diffHash: input.diffHash, decision: input.decision, reason: input.reason,
    }, createIfMissing: false })).toThrowError(expect.objectContaining({ code: 'not-found' }))

    rawStore.beginApprovalSettlement({ operationId: input.operationId, payload: {
      callbackEventId: input.callbackEventId, callbackChatId: input.callbackChatId, bindingId: input.bindingId,
      principal, proposalId: input.proposalId, expectedVersion: input.expectedVersion,
      diffHash: input.diffHash, decision: input.decision, reason: input.reason,
    } })
    vi.setSystemTime(proposal.expiresAt + 1)
    expect(ctx.assistantPolicy.decideProposal({ proposalId: proposal.proposalId,
      principal: 'lark/bot-1/tenant-a/ou_owner', expectedVersion: proposal.version,
      decision: input.decision, reason: input.reason })).toMatchObject({ status: 'expired' })
    expect(service.recoverApprovalSettlement(input)).toBeUndefined()
    await ctx.fiber.restart()
    vi.useRealTimers()
  })

  test('fails closed when a pending Delivery settlement disagrees with the terminal Policy decision', async () => {
    const { ctx, service } = await harness()
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    service.registerInboundRuntime({ createSession: async () => ({ sessionId: 'delivery-session-1', workspace: '/work/alpha',
      agentPreset: 'primary', policyRef: 'owner-dm' }), process: async () => ({ outcome: 'processed' }) })
    await service.acceptInbound(envelope)
    const binding = service.history(foreground('delivery-session-1'), {}).binding
    const diff = 'reviewed change with conflicting terminal decision'
    const proposal = ctx.assistantPolicy.propose({ idempotencyKey: 'approval-terminal-conflict', requester: 'automation:test',
      principal: 'lark/bot-1/tenant-a/ou_owner', action: 'send', resource: { kind: 'message', id: binding.id },
      diff, summary: 'Conflicting terminal decision', ttlMs: 5_000 })
    const input = { operationId: 'approval-terminal-conflict-operation', callbackEventId: 'approval-conflict-event',
      callbackChatId: conversation.chat, bindingId: binding.id, principal, proposalId: proposal.proposalId,
      expectedVersion: proposal.version, diffHash: proposal.diffHash, decision: 'approved' as const,
      reason: 'owner approved' }
    service.enqueueApproval({ sourceId: 'automation-1', workspace: binding.workspace, bindingId: binding.id,
      idempotencyKey: 'approval-terminal-conflict-card', text: diff, approval: { operationId: input.operationId,
        proposalId: proposal.proposalId, expectedVersion: proposal.version, expiresAt: proposal.expiresAt,
        title: 'Conflicting terminal decision', diffHash: proposal.diffHash } })
    const rawStore = (service as unknown as { deliveryStore: {
      beginApprovalSettlement(input: { operationId: string; payload: unknown }): unknown
    } }).deliveryStore
    rawStore.beginApprovalSettlement({ operationId: input.operationId, payload: {
      callbackEventId: input.callbackEventId, callbackChatId: input.callbackChatId, bindingId: input.bindingId,
      principal, proposalId: input.proposalId, expectedVersion: input.expectedVersion,
      diffHash: input.diffHash, decision: input.decision, reason: input.reason,
    } })
    ctx.assistantPolicy.decideProposal({ proposalId: input.proposalId, principal: 'lark/bot-1/tenant-a/ou_owner',
      expectedVersion: input.expectedVersion, decision: 'rejected', reason: 'owner rejected instead' })

    expect(() => service.settleApproval(input))
      .toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    await ctx.fiber.restart()
  })

  test('derives approval routes only from an active owner binding and authentic Agent header', async () => {
    const { ctx, service } = await harness()
    expect(() => service.prepareAgentApproval(foreground('unbound'), { sourceId: 'automation-1' }))
      .toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    service.registerInboundRuntime({ createSession: async () => ({ sessionId: 'delivery-session-1', workspace: '/work/alpha',
      agentPreset: 'primary', policyRef: 'owner-dm' }), process: async () => ({ outcome: 'processed' }) })
    await service.acceptInbound(envelope)
    expect(service.prepareAgentApproval(foreground('delivery-session-1'), { sourceId: 'automation-1' }))
      .toEqual(expect.objectContaining({ sourceId: 'automation-1', workspace: '/work/alpha',
        principal: 'lark/bot-1/tenant-a/ou_owner' }))
    const binding = service.history(foreground('delivery-session-1'), {}).binding
    const background = foregroundWithHeader('heartbeat-session', '/work/alpha', 'primary')
    const unbind = service.bindAgentApprovalRoute(background, { bindingId: binding.id })
    expect(service.prepareAgentApproval(background, { sourceId: 'automation-1' }))
      .toEqual(expect.objectContaining({ bindingId: binding.id, sourceId: 'automation-1' }))
    unbind()
    expect(() => service.prepareAgentApproval(background, { sourceId: 'automation-1' }))
      .toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    expect(() => service.bindAgentApprovalRoute(
      foregroundWithHeader('forged-heartbeat', '/work/forged', 'primary'), { bindingId: binding.id },
    )).toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    expect(() => service.prepareAgentApproval(
      foregroundWithHeader('delivery-session-1', '/work/forged', 'primary'), { sourceId: 'automation-1' },
    )).toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    expect(() => service.prepareAgentApproval(
      foregroundWithHeader('delivery-session-1', '/work/alpha', 'forged'), { sourceId: 'automation-1' },
    )).toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    await ctx.fiber.restart()
  })

  test('rejects linked or revoked principals as approval owners', async () => {
    const { ctx, service } = await harness()
    const ownerChallenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: ownerChallenge.challenge.id, principal, code: ownerChallenge.code })
    const linked = { ...principal, user: 'ou_linked' }
    const linkedChallenge = service.issuePairing('test', linked)
    const linkedRecord = service.confirmPairing({ challengeId: linkedChallenge.challenge.id, principal: linked,
      code: linkedChallenge.code })
    service.linkPrincipal({ operatorId: 'test', owner: principal, linked, expectedLinkedVersion: linkedRecord.version })
    const rawStore = (service as unknown as { deliveryStore: {
      createBinding(input: Record<string, unknown>): unknown
      getPrincipal(input: typeof principal): { id: string; version: number }
      revokePrincipal(id: string, version: number): unknown
    } }).deliveryStore
    rawStore.createBinding({ conversation, principal, workspace: '/work/alpha', agentPreset: 'primary',
      sessionId: 'session-owner', policyRef: 'owner-dm' })
    rawStore.createBinding({ conversation: { ...conversation, chat: 'oc_linked' }, principal: linked,
      workspace: '/work/alpha', agentPreset: 'primary', sessionId: 'session-linked', policyRef: 'owner-dm' })
    expect(() => service.prepareAgentApproval(foreground('session-linked'), { sourceId: 'automation-1' }))
      .toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    const owner = rawStore.getPrincipal(principal)
    rawStore.revokePrincipal(owner.id, owner.version)
    expect(() => service.prepareAgentApproval(foreground('session-owner'), { sourceId: 'automation-1' }))
      .toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    await ctx.fiber.restart()
  })

  test('validates approval cards against the immutable Policy proposal', async () => {
    const { ctx, service } = await harness()
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    service.registerInboundRuntime({ createSession: async () => ({ sessionId: 'delivery-session-1', workspace: '/work/alpha',
      agentPreset: 'primary', policyRef: 'owner-dm' }), process: async () => ({ outcome: 'processed' }) })
    await service.acceptInbound(envelope)
    const binding = service.history(foreground('delivery-session-1'), {}).binding
    const diff = 'review exact diff'
    const proposal = ctx.assistantPolicy.propose({ idempotencyKey: 'canonical-approval', requester: 'automation:test',
      principal: 'lark/bot-1/tenant-a/ou_owner', action: 'send', resource: { kind: 'message', id: binding.id },
      diff, summary: 'Review exact diff', ttlMs: 5_000 })
    const canonical = { sourceId: 'automation-1', workspace: binding.workspace, bindingId: binding.id,
      idempotencyKey: 'canonical-card', text: diff, approval: { operationId: `approval:${proposal.proposalId}`,
        proposalId: proposal.proposalId, expectedVersion: proposal.version, expiresAt: proposal.expiresAt,
        title: 'Review exact diff', diffHash: proposal.diffHash } }
    expect(() => service.enqueueApproval({ ...canonical, workspace: '/work/other' })).toThrow()
    for (const changed of [
      { ...canonical, text: 'misleading diff', idempotencyKey: 'canonical-card-text' },
      { ...canonical, idempotencyKey: 'canonical-card-title', approval: { ...canonical.approval, title: 'Misleading' } },
      { ...canonical, idempotencyKey: 'canonical-card-hash', approval: { ...canonical.approval, diffHash: sha256('other') } },
      { ...canonical, idempotencyKey: 'canonical-card-version', approval: { ...canonical.approval, expectedVersion: 2 } },
      { ...canonical, idempotencyKey: 'canonical-card-expiry', approval: { ...canonical.approval, expiresAt: proposal.expiresAt + 1 } },
    ]) expect(() => service.enqueueApproval(changed)).toThrow()
    expect(service.enqueueApproval(canonical)).toMatchObject({ intent: { approval: canonical.approval } })
    await ctx.fiber.restart()
  })

  test('drains Policy approval dispatches idempotently and does not let one bad route starve the batch', async () => {
    const { ctx, service } = await harness()
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    service.registerInboundRuntime({ createSession: async () => ({ sessionId: 'delivery-session-1', workspace: '/work/alpha',
      agentPreset: 'primary', policyRef: 'owner-dm' }), process: async () => ({ outcome: 'processed' }) })
    await service.acceptInbound(envelope)
    const binding = service.history(foreground('delivery-session-1'), {}).binding
    ctx.assistantPolicy.propose({ idempotencyKey: 'bad-dispatch', requester: 'automation:test',
      principal: 'lark/bot-1/tenant-a/ou_owner', action: 'send', resource: { kind: 'message', id: binding.id },
      diff: 'bad', summary: 'Bad route', ttlMs: 5_000,
      dispatch: { sourceId: 'automation-1', workspace: '/work/other', bindingId: binding.id,
        principal: 'lark/bot-1/tenant-a/ou_owner' } })
    const good = ctx.assistantPolicy.propose({ idempotencyKey: 'good-dispatch', requester: 'automation:test',
      principal: 'lark/bot-1/tenant-a/ou_owner', action: 'send', resource: { kind: 'message', id: binding.id },
      diff: 'good', summary: 'Good route', ttlMs: 5_000,
      dispatch: { sourceId: 'automation-1', workspace: '/work/alpha', bindingId: binding.id,
        principal: 'lark/bot-1/tenant-a/ou_owner' } })
    const mark = vi.spyOn(ctx.assistantPolicy, 'markApprovalDispatchEnqueued')
      .mockImplementationOnce(() => { throw new Error('simulated crash after durable enqueue') })
    await service.tick()
    await service.whenIdle()
    expect(service.history(foreground('delivery-session-1'), {}).outbox.filter(row =>
      row.intent.idempotencyKey === `approval-card:${good.proposalId}`)).toHaveLength(1)
    expect(ctx.assistantPolicy.listPendingApprovalDispatches().map(row => row.proposalId)).toContain(good.proposalId)
    mark.mockRestore()
    await service.tick()
    expect(service.history(foreground('delivery-session-1'), {}).outbox.filter(row =>
      row.intent.idempotencyKey === `approval-card:${good.proposalId}`)).toHaveLength(1)
    expect(ctx.assistantPolicy.listPendingApprovalDispatches().map(row => row.proposalId)).not.toContain(good.proposalId)
    await ctx.fiber.restart()
  })

  test('persists a fair dispatch cursor across restart so a poison first page cannot starve later approvals', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(30_000)
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-dispatch-fairness-'))
    roots.push(root)
    const first = await mountHarness(root)
    const challenge = first.service.issuePairing('test', principal)
    first.service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    first.service.registerInboundRuntime({ createSession: async () => ({ sessionId: 'delivery-session-1', workspace: '/work/alpha',
      agentPreset: 'primary', policyRef: 'owner-dm' }), process: async () => ({ outcome: 'processed' }) })
    await first.service.acceptInbound(envelope)
    const binding = first.service.history(foreground('delivery-session-1'), {}).binding
    const poison = Array.from({ length: 100 }, (_, index) => first.ctx.assistantPolicy.propose({
      idempotencyKey: `poison-dispatch-${index}`,
      requester: 'automation:test',
      principal: 'lark/bot-1/tenant-a/ou_owner',
      action: 'send',
      resource: { kind: 'message', id: `${binding.id}:poison:${index}` },
      diff: `poison ${index}`,
      summary: `Poison dispatch ${index}`,
      ttlMs: 60_000,
      dispatch: { sourceId: 'automation-1', workspace: `/work/poison-${index}`, bindingId: binding.id,
        principal: 'lark/bot-1/tenant-a/ou_owner' },
    }))
    vi.setSystemTime(30_001)
    const good = first.ctx.assistantPolicy.propose({
      idempotencyKey: 'fair-dispatch-101',
      requester: 'automation:test',
      principal: 'lark/bot-1/tenant-a/ou_owner',
      action: 'send',
      resource: { kind: 'message', id: `${binding.id}:good` },
      diff: 'the later valid approval',
      summary: 'Later valid approval',
      ttlMs: 60_000,
      dispatch: { sourceId: 'automation-1', workspace: binding.workspace, bindingId: binding.id,
        principal: 'lark/bot-1/tenant-a/ou_owner' },
    })

    await first.service.tick()
    expect(first.ctx.assistantPolicy.listPendingApprovalDispatches(100)
      .map(row => row.proposalId)).toEqual(expect.arrayContaining(poison.map(row => row.proposalId)))
    expect(first.ctx.assistantPolicy.listPendingApprovalDispatches(100, {
      createdAt: 30_000,
      proposalId: poison.map(row => row.proposalId).sort().at(-1)!,
    }).map(row => row.proposalId)).toContain(good.proposalId)
    await first.ctx.fiber.restart()

    const restarted = await mountHarness(root)
    const enqueue = vi.spyOn(restarted.service, 'enqueueApproval')
    await restarted.service.tick()
    expect(restarted.ctx.assistantPolicy.listPendingApprovalDispatches(100)
      .map(row => row.proposalId)).not.toContain(good.proposalId)
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `approval-card:${good.proposalId}`,
    }))

    enqueue.mockClear()
    await restarted.service.tick()
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `approval-card:${poison[0]!.proposalId}`,
    }))
    await restarted.ctx.fiber.restart()
    vi.useRealTimers()
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
