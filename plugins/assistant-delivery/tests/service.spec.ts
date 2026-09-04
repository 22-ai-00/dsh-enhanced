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
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AssistantDeliveryService, type DeliveryInboundRuntime } from '../src/service.ts'
import { DeliveryStore } from '../src/store.ts'
import type {
  ConversationBinding,
  ConversationRef,
  DeliveryAdapter,
  InboundEnvelope,
  ModelSelectionSettlementInput,
} from '../src/index.ts'

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
  permissionReplyBudget?: number
  resolutionBudget?: number
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
  const budgets = [
    ...(options.permissionReplyBudget === undefined ? [] : [{
      id: 'permission-replies', metric: 'replies', limit: options.permissionReplyBudget,
      periodMs: 60_000, scope: 'global' as const,
    }]),
    ...(options.resolutionBudget === undefined ? [] : [{
      id: 'delivery-resolutions', metric: 'delivery-resolutions', limit: options.resolutionBudget,
      periodMs: 60_000, scope: 'subject' as const,
    }]),
  ]
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: allow ? [
    { id: 'local-pair', effect: 'allow', subject: { kind: 'external', id: 'local:test' },
      actions: options.resolutionBudget === undefined
        ? ['pair.issue', 'pair.link', 'delivery.resolve'] : ['pair.issue', 'pair.link'],
      resource: { kind: 'message', id: '*' }, context: { initiators: ['foreground'] } },
    ...(options.resolutionBudget === undefined ? [] : [{
      id: 'local-test-resolution', effect: 'allow' as const,
      subject: { kind: 'external' as const, id: 'local:test' },
      actions: ['delivery.resolve'], resource: { kind: 'message' as const, id: '*' },
      context: { initiators: ['foreground' as const] },
      budget: { id: 'delivery-resolutions', amount: 1 },
    }, {
      id: 'local-other-resolution', effect: 'allow' as const,
      subject: { kind: 'external' as const, id: 'local:other' },
      actions: ['delivery.resolve'], resource: { kind: 'message' as const, id: '*' },
      context: { initiators: ['foreground' as const] },
      budget: { id: 'delivery-resolutions', amount: 1 },
    }]),
    { id: 'external-owner', effect: 'allow', subject: { kind: 'external', id: 'lark/bot-1/tenant-a/ou_owner' },
      actions: ['approval.decide', 'pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' },
      context: { initiators: ['external'] } },
    { id: 'external-linked', effect: 'allow', subject: { kind: 'external', id: 'lark/bot-1/tenant-a/ou_linked' },
      actions: ['pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' },
      context: { initiators: ['external'] } },
    { id: 'external-other-account', effect: 'allow',
      subject: { kind: 'external', id: 'lark/bot-2/tenant-a/ou_owner' },
      actions: options.permissionReplyBudget === undefined ? ['pair.confirm'] : ['pair.confirm', 'ingest'],
      resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
    { id: 'external-other-connector', effect: 'allow',
      subject: { kind: 'external', id: 'slack/bot-1/tenant-a/ou_owner' },
      actions: ['pair.confirm'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
    { id: 'external-owner-agent-reply', effect: 'allow', subject: {
      kind: 'agent', id: 'primary', workspace: '/work/alpha', principal: 'lark/bot-1/tenant-a/ou_owner',
    }, actions: ['reply'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] },
    ...(options.permissionReplyBudget === undefined
      ? {}
      : { budget: { id: 'permission-replies', amount: 1 } }) },
    ...(options.permissionReplyBudget === undefined ? [] : [{
      id: 'external-other-account-agent-reply', effect: 'allow' as const, subject: {
        kind: 'agent' as const, id: 'primary', workspace: '/work/alpha',
        principal: 'lark/bot-2/tenant-a/ou_owner',
      }, actions: ['reply'], resource: { kind: 'message' as const, id: '*' },
      context: { initiators: ['external' as const] },
      budget: { id: 'permission-replies', amount: 1 },
    }]),
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
  ...(budgets.length === 0 ? {} : { budgets }),
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

function runtimeStoreFromService(service: AssistantDeliveryService): DeliveryStore {
  return (service as unknown as { deliveryStore: DeliveryStore }).deliveryStore
}

function approvalRouteFor(
  service: AssistantDeliveryService,
  binding: Readonly<ConversationBinding>,
  sourceId = 'automation-1',
) {
  return service.prepareAgentApproval(foreground(binding.sessionId), { sourceId })
}

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
  test.each([
    { label: 'selected', result: { status: 'selected' as const, selection: {
      provider: 'alternate', model: 'precise', reasoningEffort: 'high',
    } } },
    { label: 'rejected', result: { status: 'rejected' as const, reason: 'model-unavailable' as const } },
  ])('observes a durable $label settlement completed through another store connection', async ({ label, result }) => {
    const { ctx, root, service } = await harness()
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    const firstStore = runtimeStoreFromService(service)
    const binding = firstStore.createBinding({
      conversation, principal, workspace: '/work/alpha', agentPreset: 'primary',
      sessionId: `cross-instance-${label}`, policyRef: 'owner-dm',
    })
    const input: ModelSelectionSettlementInput = {
      operationId: `picker-cross-instance-${label}`,
      callbackEventId: `callback-cross-instance-${label}`,
      callbackChatId: conversation.chat,
      cardMessageId: `om_cross_instance_${label}`,
      bindingId: binding.id,
      principal,
      provider: 'alternate',
      modelProvider: 'alternate',
      model: 'precise',
      reasoningEffort: 'high',
      expectedRevision: 0,
    }
    const expected = { revision: 0, provider: input.modelProvider, model: input.model, reasoningEffort: 'high' }
    const payload = {
      callbackEventId: input.callbackEventId, callbackChatId: input.callbackChatId,
      cardMessageId: input.cardMessageId, bindingId: input.bindingId, principal: input.principal,
      provider: input.provider, modelProvider: input.modelProvider, model: input.model,
      reasoningEffort: input.reasoningEffort!, expectedRevision: input.expectedRevision,
    }
    firstStore.beginModelSelectionSettlement({
      operationId: input.operationId, bindingId: binding.id, expected, payload,
    })
    const waited = service.awaitModelSelection(input, new AbortController().signal)
    const secondStore = new DeliveryStore({ path: join(root, 'delivery.sqlite') })
    try {
      const pending = secondStore.beginModelSelectionSettlement({
        operationId: input.operationId, bindingId: binding.id, expected, payload,
      })
      secondStore.completeModelSelectionSettlement({
        operationId: input.operationId, payloadHash: pending.payloadHash, result,
        ...(result.status === 'selected' ? {
          selection: { conversation, route: result.selection },
          reply: {
            idempotencyKey: `model-selection:${input.callbackEventId}:reply`,
            bindingId: binding.id, target: { conversation, principal }, text: 'selected', format: 'plain' as const,
          },
        } : {}),
      })
      await expect(waited).resolves.toEqual(result)
    } finally {
      secondStore.close()
      await ctx.fiber.restart()
    }
  })

  test('defaults external sessions to the shipped standard preset', () => {
    const config = AssistantDeliveryService.Config({
      databasePath: '/tmp/delivery.sqlite',
      spoolPath: '/tmp/spool',
    })
    expect(config.defaultAgentPreset).toBe('standard')
    expect(config.toolApprovalTtlMs).toBe(300_000)
    expect(config.agentMaxAutoContinuationTurns).toBe(2)
    for (const agentMaxAutoContinuationTurns of [0, 8]) {
      expect(AssistantDeliveryService.Config({
        databasePath: '/tmp/delivery.sqlite',
        spoolPath: '/tmp/spool',
        agentMaxAutoContinuationTurns,
      }).agentMaxAutoContinuationTurns).toBe(agentMaxAutoContinuationTurns)
    }
    for (const agentMaxAutoContinuationTurns of [-1, 1.5, 9]) {
      expect(() => AssistantDeliveryService.Config({
        databasePath: '/tmp/delivery.sqlite',
        spoolPath: '/tmp/spool',
        agentMaxAutoContinuationTurns,
      })).toThrow(/agentMaxAutoContinuationTurns|invalid/i)
    }
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

  test('/stop interrupts the live binding before joining its strictly serialized Inbox lane', async () => {
    const { ctx, service } = await harness()
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    let markStarted!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const cancelActive = vi.fn(() => {
      release()
      return true
    })
    const runtime = {
      createSession: async () => ({ sessionId: 'delivery-session-stop', workspace: '/work/alpha',
        agentPreset: 'primary', policyRef: 'owner-dm' }),
      cancelActive,
      process: vi.fn(async (_binding: Readonly<ConversationBinding>, input: Readonly<InboundEnvelope>) => {
        if (input.eventId === 'evt-long-running') {
          markStarted()
          await gate
        }
        return { outcome: 'processed' as const }
      }),
    }
    service.registerInboundRuntime(runtime)
    await service.acceptInbound({ ...envelope, eventId: 'evt-long-running', text: 'keep working' })
    await service.tick()
    await started

    try {
      const stopped = await service.acceptInbound({
        ...envelope,
        eventId: 'evt-stop',
        kind: 'command',
        text: '/stop',
      })
      expect(stopped.status).toBe('queued')
      expect(cancelActive).toHaveBeenCalledOnce()
      expect(cancelActive).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'delivery-session-stop', generation: 1 }),
        'stop',
      )
    } finally {
      release()
    }
    await service.whenIdle()
    await ctx.fiber.restart()
  })

  test.each(['/stop', '/new'])('%s marks a live permission dispatch before asking the runtime to abort', async command => {
    const { ctx, service } = await harness()
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    let markStarted!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let permissionInboxId = ''
    let markerSeenByCancel: string | undefined
    service.registerInboundRuntime({
      dispatchControl: 'explicit',
      createSession: async ({ generation }) => ({
        sessionId: `delivery-session-permission-cancel-${generation}`,
        workspace: '/work/alpha',
        agentPreset: 'primary',
        policyRef: 'owner-dm',
      }),
      cancelActive: async () => {
        markerSeenByCancel = runtimeStoreFromService(service).getInbox(permissionInboxId)?.failureCode
        release()
        return true
      },
      process: async (_binding, input, _signal, _prepared, markDispatching) => {
        if (input.eventId === 'evt-live-permission') {
          markDispatching?.()
          markStarted()
          await gate
        }
        return { outcome: 'processed' as const }
      },
    })
    const permission = await service.acceptInbound({
      ...envelope,
      eventId: 'evt-live-permission',
      kind: 'command',
      text: '/permission full confirm',
    })
    permissionInboxId = permission.inboxId
    await service.tick()
    await started

    await service.acceptInbound({
      ...envelope,
      eventId: `evt-${command.slice(1)}-permission-cancel`,
      kind: 'command',
      text: command,
    })

    expect(markerSeenByCancel).toBe('permission-cancelled-recovery')
    await service.whenIdle()
    await ctx.fiber.restart()
  })

  test('/stop fences older queued work so only the stop acknowledgement enters the runtime lane', async () => {
    const { ctx, service } = await harness()
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    const process = vi.fn(async (..._args: Parameters<DeliveryInboundRuntime['process']>) => (
      { outcome: 'processed' as const }
    ))
    let releaseDrain!: () => void
    const drain = new Promise<void>(resolve => { releaseDrain = resolve })
    let markCancelStarted!: () => void
    const cancelStarted = new Promise<void>(resolve => { markCancelStarted = resolve })
    service.registerInboundRuntime({
      createSession: async () => ({ sessionId: 'delivery-session-stop-fence', workspace: '/work/alpha',
        agentPreset: 'primary', policyRef: 'owner-dm' }),
      cancelActive: async () => {
        markCancelStarted()
        await drain
        return false
      },
      process,
    } as DeliveryInboundRuntime)

    const first = await service.acceptInbound({ ...envelope, eventId: 'evt-before-stop-1', text: 'first' })
    const second = await service.acceptInbound({ ...envelope, eventId: 'evt-before-stop-2', text: 'second' })
    const racedBeforeStopResult = service.acceptInbound({
      ...envelope,
      eventId: 'evt-raced-before-stop',
      text: 'must be fenced even if accept has not queued it yet',
    })
    const stopResult = service.acceptInbound({
      ...envelope,
      eventId: 'evt-stop-fence',
      kind: 'command',
      text: '/stop',
    })
    await cancelStarted
    const followingResult = service.acceptInbound({
      ...envelope,
      eventId: 'evt-after-stop-fence',
      text: 'work after stop',
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(runtimeStoreFromService(service).getInboxByProviderEvent('lark', 'bot-1', 'evt-after-stop-fence'))
      .toMatchObject({ status: 'received' })
    releaseDrain()
    const [racedBeforeStop, stop, following] = await Promise.all([
      racedBeforeStopResult,
      stopResult,
      followingResult,
    ])

    expect(service.history(foreground('delivery-session-stop-fence'), {}).inbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.inboxId, status: 'dead_letter',
        failureCode: 'user-stopped-before-dispatch' }),
      expect.objectContaining({ id: second.inboxId, status: 'dead_letter',
        failureCode: 'user-stopped-before-dispatch' }),
      expect.objectContaining({ id: racedBeforeStop.inboxId, status: 'dead_letter',
        failureCode: 'user-stopped-before-dispatch' }),
      expect.objectContaining({ id: stop.inboxId, status: 'queued' }),
      expect.objectContaining({ id: following.inboxId, status: 'queued' }),
    ]))
    await service.tick()
    await service.whenIdle()
    await service.tick()
    await service.whenIdle()
    expect(process).toHaveBeenCalledTimes(2)
    expect(process.mock.calls[0]?.[0]).toMatchObject({ sessionId: 'delivery-session-stop-fence' })
    expect(process.mock.calls[0]?.[1]).toMatchObject({ eventId: 'evt-stop-fence' })
    expect(process.mock.calls[1]?.[1]).toMatchObject({ eventId: 'evt-after-stop-fence' })
    await ctx.fiber.restart()
  })

  test('/new waits for old-generation drain and fences following messages onto the new binding', async () => {
    const { ctx, service } = await harness()
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    let releaseDrain!: () => void
    const drain = new Promise<void>(resolve => { releaseDrain = resolve })
    let markCancelStarted!: () => void
    const cancelStarted = new Promise<void>(resolve => { markCancelStarted = resolve })
    const createSession = vi.fn(async ({ generation }: { generation: number }) => ({
      sessionId: `delivery-session-generation-${generation}`,
      workspace: '/work/alpha',
      agentPreset: 'primary',
      policyRef: 'owner-dm',
    }))
    const runtime = {
      createSession,
      cancelActive: vi.fn(async () => {
        markCancelStarted()
        await drain
        return true
      }),
      process: vi.fn(async () => ({ outcome: 'processed' as const })),
    }
    service.registerInboundRuntime(runtime as DeliveryInboundRuntime)
    await service.acceptInbound({ ...envelope, eventId: 'evt-generation-1', text: 'generation one' })

    const newResult = service.acceptInbound({ ...envelope, eventId: 'evt-new-drain', kind: 'command', text: '/new' })
    await cancelStarted
    const duplicateNewResult = service.acceptInbound({
      ...envelope,
      eventId: 'evt-new-drain',
      kind: 'command',
      text: '/new',
    })
    const followingResult = service.acceptInbound({ ...envelope, eventId: 'evt-after-new', text: 'new generation work' })
    await Promise.resolve()
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(runtimeStoreFromService(service).getInboxByProviderEvent('lark', 'bot-1', 'evt-after-new'))
      .toMatchObject({ status: 'received' })

    releaseDrain()
    const [rotated, duplicate, following] = await Promise.all([newResult, duplicateNewResult, followingResult])
    const active = runtimeStoreFromService(service).getActiveBinding(conversation)!
    expect(active).toMatchObject({ generation: 2, sessionId: 'delivery-session-generation-2' })
    expect(runtimeStoreFromService(service).getInbox(rotated.inboxId)).toMatchObject({
      status: 'queued', bindingId: active.id,
    })
    expect(runtimeStoreFromService(service).getInbox(following.inboxId)).toMatchObject({
      status: 'queued', bindingId: active.id,
    })
    expect([rotated.duplicate, duplicate.duplicate].sort()).toEqual([false, true])
    expect(duplicate.inboxId).toBe(rotated.inboxId)
    expect(createSession).toHaveBeenCalledTimes(2)
    await ctx.fiber.restart()
  })

  test('/new commits rotation and its exact command Inbox atomically across an after-commit crash and reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-new-atomic-'))
    roots.push(root)
    const first = await mountHarness(root)
    const challenge = first.service.issuePairing('test', principal)
    first.service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    const createSession = vi.fn(async ({ generation }: { generation: number }) => ({
      sessionId: `delivery-session-atomic-${generation}`,
      workspace: '/work/alpha',
      agentPreset: 'primary',
      policyRef: 'owner-dm',
    }))
    first.service.registerInboundRuntime({
      createSession,
      cancelActive: async () => false,
      process: async () => ({ outcome: 'processed' }),
    })
    await first.service.acceptInbound({ ...envelope, eventId: 'evt-atomic-seed' })

    const original = DeliveryStore.prototype.rotateBindingAndQueueCommand
    const crash = vi.spyOn(DeliveryStore.prototype, 'rotateBindingAndQueueCommand')
      .mockImplementationOnce(function (this: DeliveryStore, input) {
        original.call(this, input)
        throw new Error('test failpoint: process crashed immediately after the atomic commit')
      })
    const command = { ...envelope, eventId: 'evt-new-atomic', kind: 'command' as const, text: '/new' }
    await expect(first.service.acceptInbound(command)).rejects.toThrow(/failpoint/)
    crash.mockRestore()

    const committed = runtimeStoreFromService(first.service).getActiveBinding(conversation)!
    expect(committed).toMatchObject({ generation: 2, sessionId: 'delivery-session-atomic-2' })
    expect(runtimeStoreFromService(first.service).getInboxByProviderEvent('lark', 'bot-1', 'evt-new-atomic'))
      .toMatchObject({ status: 'queued', bindingId: committed.id })
    await first.ctx.fiber.restart()

    const reopened = await mountHarness(root)
    const replayCreate = vi.fn(async () => ({
      sessionId: 'must-not-create-generation-3',
      workspace: '/work/alpha',
      agentPreset: 'primary',
      policyRef: 'owner-dm',
    }))
    reopened.service.registerInboundRuntime({
      createSession: replayCreate,
      process: async () => ({ outcome: 'processed' }),
    })
    const replay = await reopened.service.acceptInbound(command)
    expect(replay).toMatchObject({ duplicate: true, status: 'queued' })
    expect(runtimeStoreFromService(reopened.service).getActiveBinding(conversation)).toMatchObject({
      generation: 2,
      sessionId: 'delivery-session-atomic-2',
    })
    expect(replayCreate).not.toHaveBeenCalled()
    expect(createSession).toHaveBeenCalledTimes(2)
    await reopened.ctx.fiber.restart()
  })

  test('/new uses one exact-command grammar from admission through atomic rotation', async () => {
    const { ctx, service } = await harness()
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    service.registerInboundRuntime({
      createSession: async ({ generation }) => ({ sessionId: `delivery-session-grammar-${generation}`,
        workspace: '/work/alpha', agentPreset: 'primary', policyRef: 'owner-dm' }),
      cancelActive: async () => false,
      process: async () => ({ outcome: 'processed' }),
    })
    await service.acceptInbound({ ...envelope, eventId: 'evt-grammar-generation-1', text: 'generation one' })

    const reset = await service.acceptInbound({
      ...envelope,
      eventId: 'evt-new-shared-grammar',
      kind: 'command',
      text: '/new \u00a0',
    })

    const store = runtimeStoreFromService(service)
    const active = store.getActiveBinding(conversation)!
    expect(active).toMatchObject({ generation: 2, sessionId: 'delivery-session-grammar-2' })
    expect(store.getInbox(reset.inboxId)).toMatchObject({ status: 'queued', bindingId: active.id })
    await ctx.fiber.restart()
  })

  test('recovers a durable pre-commit /new after reopen without provider retransmission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-new-precommit-'))
    roots.push(root)
    const first = await mountHarness(root)
    const challenge = first.service.issuePairing('test', principal)
    first.service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    let markCancelStarted!: () => void
    const cancelStarted = new Promise<void>(resolve => { markCancelStarted = resolve })
    const abandonedDrain = new Promise<void>(() => {})
    first.service.registerInboundRuntime({
      createSession: async () => ({ sessionId: 'delivery-session-precommit-1', workspace: '/work/alpha',
        agentPreset: 'primary', policyRef: 'owner-dm' }),
      cancelActive: async () => {
        markCancelStarted()
        await abandonedDrain
        return false
      },
      process: async () => ({ outcome: 'processed' }),
    })
    const oldWork = await first.service.acceptInbound({
      ...envelope,
      eventId: 'evt-before-precommit-new',
      text: 'old generation queued work',
    })
    const resetEnvelope = {
      ...envelope,
      eventId: 'evt-precommit-new',
      kind: 'command' as const,
      text: '/new \u00a0',
    }
    void first.service.acceptInbound(resetEnvelope)
    await cancelStarted
    const strandedEnvelope = {
      ...envelope,
      eventId: 'evt-stranded-after-precommit-new',
      text: 'already received behind the blocked reset',
    }
    void first.service.acceptInbound(strandedEnvelope)
    await Promise.resolve()
    const firstStore = runtimeStoreFromService(first.service)
    const reset = firstStore.getInboxByProviderEvent('lark', 'bot-1', resetEnvelope.eventId)!
    const stranded = firstStore.getInboxByProviderEvent('lark', 'bot-1', strandedEnvelope.eventId)!
    expect(reset.status).toBe('received')
    expect(stranded.status).toBe('received')
    await first.ctx.fiber.restart()

    const reopened = await mountHarness(root)
    const createSession = vi.fn(async ({ generation }: { generation: number }) => ({
      sessionId: `delivery-session-precommit-${generation}`,
      workspace: '/work/alpha',
      agentPreset: 'primary',
      policyRef: 'owner-dm',
    }))
    const process = vi.fn(async (..._args: Parameters<DeliveryInboundRuntime['process']>) => (
      { outcome: 'processed' as const }
    ))
    reopened.service.registerInboundRuntime({
      createSession,
      cancelActive: async () => false,
      process,
    })
    const following = await reopened.service.acceptInbound({
      ...envelope,
      eventId: 'evt-after-precommit-new',
      text: 'must enter the recovered generation',
    })

    const store = runtimeStoreFromService(reopened.service)
    const active = store.getActiveBinding(conversation)!
    expect(active).toMatchObject({ generation: 2, sessionId: 'delivery-session-precommit-2' })
    expect(store.getInbox(reset.id)).toMatchObject({ status: 'queued', bindingId: active.id })
    expect(store.getInbox(stranded.id)).toMatchObject({ status: 'queued', bindingId: active.id })
    expect(store.getInbox(following.inboxId)).toMatchObject({ status: 'queued', bindingId: active.id })
    expect(store.getInbox(oldWork.inboxId)).toMatchObject({
      status: 'dead_letter',
      failureCode: 'new-session-before-dispatch',
    })
    expect(createSession).toHaveBeenCalledOnce()
    for (let index = 0; index < 3; index += 1) {
      await reopened.service.tick()
      await reopened.service.whenIdle()
    }
    expect(process.mock.calls.map(call => call[1].eventId)).toEqual([
      'evt-precommit-new',
      'evt-stranded-after-precommit-new',
      'evt-after-precommit-new',
    ])
    await reopened.ctx.fiber.restart()
  })

  test('recovers a durable pre-commit /stop after reopen without provider retransmission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-stop-precommit-'))
    roots.push(root)
    const first = await mountHarness(root)
    const challenge = first.service.issuePairing('test', principal)
    first.service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    let markCancelStarted!: () => void
    const cancelStarted = new Promise<void>(resolve => { markCancelStarted = resolve })
    const abandonedDrain = new Promise<void>(() => {})
    first.service.registerInboundRuntime({
      createSession: async () => ({ sessionId: 'delivery-session-stop-precommit', workspace: '/work/alpha',
        agentPreset: 'primary', policyRef: 'owner-dm' }),
      cancelActive: async () => {
        markCancelStarted()
        await abandonedDrain
        return false
      },
      process: async () => ({ outcome: 'processed' }),
    })
    const oldWork = await first.service.acceptInbound({
      ...envelope,
      eventId: 'evt-before-precommit-stop',
      text: 'queued work that stop must fence',
    })
    const stopEnvelope = {
      ...envelope,
      eventId: 'evt-precommit-stop',
      kind: 'command' as const,
      text: '/stop',
    }
    void first.service.acceptInbound(stopEnvelope)
    await cancelStarted
    const strandedEnvelope = {
      ...envelope,
      eventId: 'evt-stranded-after-precommit-stop',
      text: 'already received behind the blocked stop',
    }
    void first.service.acceptInbound(strandedEnvelope)
    await Promise.resolve()
    const firstStore = runtimeStoreFromService(first.service)
    const stop = firstStore.getInboxByProviderEvent('lark', 'bot-1', stopEnvelope.eventId)!
    const stranded = firstStore.getInboxByProviderEvent('lark', 'bot-1', strandedEnvelope.eventId)!
    expect(stop.status).toBe('received')
    expect(stranded.status).toBe('received')
    await first.ctx.fiber.restart()

    const reopened = await mountHarness(root)
    const process = vi.fn(async (..._args: Parameters<DeliveryInboundRuntime['process']>) => (
      { outcome: 'processed' as const }
    ))
    reopened.service.registerInboundRuntime({
      createSession: async () => { throw new Error('existing session must be preserved by recovered /stop') },
      cancelActive: async () => false,
      process,
    })
    const following = await reopened.service.acceptInbound({
      ...envelope,
      eventId: 'evt-after-precommit-stop',
      text: 'must remain behind the recovered stop',
    })

    const store = runtimeStoreFromService(reopened.service)
    const active = store.getActiveBinding(conversation)!
    expect(active).toMatchObject({ generation: 1, sessionId: 'delivery-session-stop-precommit' })
    expect(store.getInbox(stop.id)).toMatchObject({ status: 'queued', bindingId: active.id })
    expect(store.getInbox(stranded.id)).toMatchObject({ status: 'queued', bindingId: active.id })
    expect(store.getInbox(following.inboxId)).toMatchObject({ status: 'queued', bindingId: active.id })
    expect(store.getInbox(oldWork.inboxId)).toMatchObject({
      status: 'dead_letter',
      failureCode: 'user-stopped-before-dispatch',
    })
    for (let index = 0; index < 3; index += 1) {
      await reopened.service.tick()
      await reopened.service.whenIdle()
    }
    expect(process.mock.calls.map(call => call[1].eventId)).toEqual([
      'evt-precommit-stop',
      'evt-stranded-after-precommit-stop',
      'evt-after-precommit-stop',
    ])
    await reopened.ctx.fiber.restart()
  })

  test('/new aborts an earlier claimed preparation before the fresh generation is admitted', async () => {
    const { ctx, service } = await harness()
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    let markPrepareStarted!: () => void
    const prepareStarted = new Promise<void>(resolve => { markPrepareStarted = resolve })
    let prepareSignal: AbortSignal | undefined
    let generation = 0
    service.registerInboundRuntime({
      dispatchControl: 'explicit',
      createSession: async () => ({ sessionId: `delivery-session-prepare-${++generation}`, workspace: '/work/alpha',
        agentPreset: 'primary', policyRef: 'owner-dm' }),
      cancelActive: async () => false,
      prepare: async (_binding, _input, signal) => {
        prepareSignal = signal
        markPrepareStarted()
        await new Promise<void>(resolve => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return { outcome: 'not-processed' as const, failureCode: 'preparation-cancelled', retryable: false }
      },
      process: vi.fn(async () => ({ outcome: 'processed' as const })),
    })
    await service.acceptInbound({ ...envelope, eventId: 'evt-preparing-old', text: 'prepare an image' })
    const oldTick = service.tick()
    await prepareStarted

    try {
      const rotated = await service.acceptInbound({
        ...envelope,
        eventId: 'evt-new-aborts-prepare',
        kind: 'command',
        text: '/new',
      })
      expect(rotated.status).toBe('queued')
      expect(prepareSignal?.aborted).toBe(true)
      expect(runtimeStoreFromService(service).getActiveBinding(conversation)).toMatchObject({ generation: 2 })
    } finally {
      await ctx.fiber.restart()
      await oldTick
    }
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
    expect(() => service.enqueueBackground({
      sourceId: 'automation-1', workspace: '/work/alpha', bindingId: binding.id,
      idempotencyKey: 'automation:forged-learning', text: 'forged result',
      metadata: { 'dsh.learning.runId': 'run-from-somewhere-else' },
    })).toThrowError(expect.objectContaining({ code: 'runtime-conflict' }))
    const outputPreview = 'verified automation result'
    const outputDigest = createHash('sha256').update(outputPreview).digest('hex')
    ctx.provide('assistantAutomations', {
      resolveDeliveryEvidence: () => Object.freeze({
        schemaVersion: 1, source: 'assistant-automations', executionKind: 'agent',
        automationId: 'automation-1', runId: 'run-verified', occurrenceId: 'occurrence-verified',
        workspace: '/work/alpha', agentPreset: 'primary', bindingId: binding.id,
        situation: 'automation:automation-1', occurredAt: 123,
        executionStatus: 'succeeded', outputDigest, proofDigest: 'b'.repeat(64),
      }),
    } as never)
    expect(service.enqueueAutomationResult({
      automationId: 'automation-1', runId: 'run-verified', workspace: '/work/alpha',
      bindingId: binding.id, outputPreview,
    })).toMatchObject({
      intent: {
        text: expect.stringContaining('/feedback not-achieved'),
        metadata: {
          'dsh.learning.schemaVersion': '2',
          'dsh.learning.runId': 'run-verified',
          'dsh.learning.outputDigest': outputDigest,
          'dsh.learning.proofDigest': 'b'.repeat(64),
        },
      },
    })
    expect((service as unknown as Record<string, unknown>)['store']).toBeUndefined()
    await ctx.fiber.restart()
  })

  test('policy-gates control replies by the binding exact external principal', async () => {
    const { ctx, service } = await harness()
    const candidates = [
      { principal, conversation },
      {
        principal: { ...principal, account: 'bot-2' },
        conversation: { ...conversation, account: 'bot-2', chat: 'oc_other_account' },
      },
      {
        principal: { ...principal, channel: 'slack' },
        conversation: { ...conversation, channel: 'slack', chat: 'D_other_connector' },
      },
    ] as const
    for (const candidate of candidates) {
      const challenge = service.issuePairing('test', candidate.principal)
      service.confirmPairing({
        challengeId: challenge.challenge.id,
        principal: candidate.principal,
        code: challenge.code,
      })
    }
    const rawStore = (service as unknown as { deliveryStore: {
      createBinding(input: {
        conversation: ConversationRef
        principal: typeof principal
        workspace: string
        agentPreset: string
        sessionId: string
        policyRef: string
      }): ConversationBinding
    } }).deliveryStore
    const bindings = candidates.map((candidate, index) => rawStore.createBinding({
      conversation: candidate.conversation,
      principal: candidate.principal,
      workspace: '/work/alpha',
      agentPreset: 'primary',
      sessionId: `control-reply-session-${index}`,
      policyRef: 'owner-dm',
    }))
    const replyCommand = (service as unknown as { replyCommand(binding: ConversationBinding, input: {
      idempotencyKey: string
      text: string
      replyToEventId: string
    }): unknown }).replyCommand.bind(service)

    expect(replyCommand(bindings[0]!, {
      idempotencyKey: 'control-reply-owner', text: 'owner reply', replyToEventId: 'evt-owner',
    })).toMatchObject({ status: 'pending' })
    for (const [index, binding] of bindings.slice(1).entries()) {
      expect(() => replyCommand(binding, {
        idempotencyKey: `control-reply-other-${index}`,
        text: 'must not queue',
        replyToEventId: `evt-other-${index}`,
      })).toThrowError(expect.objectContaining({ code: 'policy-denied' }))
    }
    await ctx.fiber.restart()
  })

  test('scopes permission reply budget and Outbox idempotency by Inbox across accounts sharing an event id', async () => {
    const { ctx, service } = await harness(true, { permissionReplyBudget: 2 })
    const secondPrincipal = { ...principal, account: 'bot-2' }
    const secondConversation = { ...conversation, account: 'bot-2', chat: 'oc_owner_bot_2' }
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    service.registerInboundRuntime({
      createSession: async ({ envelope: input }) => ({
        sessionId: `delivery-session-${input.account}`,
        workspace: '/work/alpha',
        agentPreset: 'primary',
        policyRef: 'owner-dm',
      }),
      process: async () => ({ outcome: 'processed' }),
    })
    const eventId = 'evt-shared-permission-budget'
    const envelopes = [
      { ...envelope, eventId, kind: 'command' as const, text: '/permissions' },
      {
        ...envelope,
        account: secondPrincipal.account,
        eventId,
        principal: secondPrincipal,
        conversation: secondConversation,
        kind: 'command' as const,
        text: '/permissions',
      },
    ]
    const store = runtimeStoreFromService(service)
    const internal = service as unknown as {
      deliveryStore: { handoffOwner(input: typeof principal): unknown }
      authorizePermissionReply(binding: ConversationBinding, input: InboundEnvelope): boolean
      replyCommand(binding: ConversationBinding, input: {
        idempotencyKey: string
        text: string
        replyToEventId: string
      }): { intent: { idempotencyKey: string } }
    }
    const accepted: Awaited<ReturnType<typeof service.acceptInbound>>[] = []
    const replies: { intent: { idempotencyKey: string } }[] = []
    for (const [index, input] of envelopes.entries()) {
      if (index === 1) internal.deliveryStore.handoffOwner(secondPrincipal)
      accepted.push(await service.acceptInbound(input))
      const binding = store.getActiveBinding(input.conversation)!
      expect(internal.authorizePermissionReply(binding, input)).toBe(true)
      replies.push(internal.replyCommand(binding, {
        idempotencyKey: `inbound:${eventId}:reply`,
        text: `permission reply ${index}`,
        replyToEventId: eventId,
      }))
    }

    expect(replies.map(reply => reply.intent.idempotencyKey)).toEqual([
      `inbound:${accepted[0]!.inboxId}:reply`,
      `inbound:${accepted[1]!.inboxId}:reply`,
    ])
    const exhausted = {
      ...envelopes[1]!,
      eventId: 'evt-permission-budget-exhausted',
    }
    await service.acceptInbound(exhausted)
    expect(internal.authorizePermissionReply(store.getActiveBinding(secondConversation)!, exhausted)).toBe(false)
    await ctx.fiber.restart()
  })

  test('scopes ordinary Agent replies by Inbox across accounts sharing an event id', async () => {
    const { ctx, service } = await harness(true, { permissionReplyBudget: 2 })
    const secondPrincipal = { ...principal, account: 'bot-2' }
    const secondConversation = { ...conversation, account: 'bot-2', chat: 'oc_agent_reply_bot_2' }
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    service.registerInboundRuntime({
      createSession: async ({ envelope: input }) => ({
        sessionId: `agent-reply-session-${input.account}`,
        workspace: '/work/alpha',
        agentPreset: 'primary',
        policyRef: 'owner-dm',
      }),
      process: async () => ({ outcome: 'processed' }),
    })
    const eventId = 'evt-shared-agent-reply'
    const envelopes = [
      { ...envelope, eventId },
      {
        ...envelope,
        account: secondPrincipal.account,
        eventId,
        principal: secondPrincipal,
        conversation: secondConversation,
      },
    ]
    const internal = service as unknown as {
      deliveryStore: { handoffOwner(input: typeof principal): unknown }
    }
    const accepted: Awaited<ReturnType<typeof service.acceptInbound>>[] = []
    const replies: { intent: { idempotencyKey: string } }[] = []
    for (const [index, input] of envelopes.entries()) {
      if (index === 1) internal.deliveryStore.handoffOwner(secondPrincipal)
      accepted.push(await service.acceptInbound(input))
      replies.push(service.reply(foreground(`agent-reply-session-${input.account}`), {
        idempotencyKey: `inbound:${eventId}:reply`,
        text: `agent reply ${index}`,
        replyToEventId: eventId,
      }))
    }

    expect(replies.map(reply => reply.intent.idempotencyKey)).toEqual([
      `inbound:${accepted[0]!.inboxId}:reply`,
      `inbound:${accepted[1]!.inboxId}:reply`,
    ])
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
    expect(service.health()).toEqual({ pendingInbox: 0, deadLetterInbox: 0,
      actionableDeadLetterInbox: 0, resolvedDeadLetterInbox: 0, pendingOutbox: 0,
      deadLetterOutbox: 0, actionableDeadLetterOutbox: 0, resolvedDeadLetterOutbox: 0,
      unknownOutbox: 0, actionableUnknownOutbox: 0, resolvedUnknownOutbox: 0,
      pendingPresentations: 0, deadPresentations: 0, adapters: 0 })
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
    expect(service.enqueueApproval({ route: approvalRouteFor(service, binding),
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
    service.enqueueApproval({ route: approvalRouteFor(service, binding),
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
    first.service.enqueueApproval({ route: approvalRouteFor(first.service, binding),
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
    service.enqueueApproval({ route: approvalRouteFor(service, binding),
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
    service.enqueueApproval({ route: approvalRouteFor(service, binding),
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
    const binding = service.history(foreground('delivery-session-1'), {}).binding
    const owner = runtimeStoreFromService(service).getPrincipal(principal)!
    expect(service.prepareAgentApproval(foreground('delivery-session-1'), { sourceId: 'automation-1' }))
      .toEqual({
        routeVersion: 2,
        sourceId: 'automation-1',
        bindingId: binding.id,
        bindingVersion: binding.version,
        bindingGeneration: binding.generation,
        workspace: '/work/alpha',
        principal: 'lark/bot-1/tenant-a/ou_owner',
        principalRecordId: owner.id,
        principalVersion: owner.version,
      })
    expect(service.preferencePrincipalForAgent(foreground('delivery-session-1'))).toEqual({
      scope: { workspace: '/work/alpha', preset: 'primary' },
      principalId: 'lark/bot-1/tenant-a/ou_owner',
      principalLineage: { principalRecordId: owner.id, principalVersion: owner.version },
      bindingId: binding.id,
      bindingVersion: binding.version,
      bindingGeneration: binding.generation,
      sessionId: binding.sessionId,
    })
    expect(service.preferencePrincipalForAgent(
      foregroundWithHeader('delivery-session-1', '/work/forged', 'primary'),
    )).toBeUndefined()
    expect(service.preferencePrincipalForAgent(
      foregroundWithHeader('delivery-session-1', '/work/alpha', 'forged'),
    )).toBeUndefined()
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

  test('mints a unique v2 Preference approval route and reports stale owner fences', async () => {
    const { ctx, service } = await harness()
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    const store = runtimeStoreFromService(service)
    const binding = store.createBinding({
      conversation, principal, workspace: '/work/alpha', agentPreset: 'primary',
      sessionId: 'preference-owner', policyRef: 'owner-dm',
    })
    const owner = store.getPrincipal(principal)!
    const authority = {
      sourceId: 'preference-promotion',
      scope: { workspace: binding.workspace, preset: binding.agentPreset },
      principalId: 'lark/bot-1/tenant-a/ou_owner',
      principalLineage: { principalRecordId: owner.id, principalVersion: owner.version },
      ownerGeneration: binding.generation,
    }
    expect(service.prepareOwnerApprovalForPreference(authority)).toEqual({
      routeVersion: 2,
      sourceId: authority.sourceId,
      bindingId: binding.id,
      bindingVersion: binding.version,
      bindingGeneration: binding.generation,
      workspace: binding.workspace,
      principal: authority.principalId,
      principalRecordId: owner.id,
      principalVersion: owner.version,
    })
    expect(service.prepareOwnerApprovalForPreference({ ...authority, ownerGeneration: binding.generation + 1 }))
      .toEqual({ kind: 'stale-owner' })
    expect(service.prepareOwnerApprovalForPreference({ ...authority, principalLineage: {
      ...authority.principalLineage, principalVersion: owner.version + 1,
    } })).toEqual({ kind: 'stale-owner' })
    expect(() => service.prepareOwnerApprovalForPreference({ ...authority, bindingId: binding.id } as never))
      .toThrowError(expect.objectContaining({ code: 'runtime-conflict' }))
    const second = store.createBinding({
      conversation: { ...conversation, chat: 'oc_second_owner_route' },
      principal, workspace: '/work/alpha', agentPreset: 'primary',
      sessionId: 'preference-owner-second', policyRef: 'owner-dm',
    })
    expect(service.prepareOwnerApprovalForPreference(authority)).toEqual({ kind: 'stale-owner' })
    store.rotateBinding({
      bindingId: second.id, expectedVersion: second.version, sessionId: 'preference-owner-second-next',
    })

    const next = store.rotateBinding({
      bindingId: binding.id, expectedVersion: binding.version, sessionId: 'preference-owner-next',
    })
    expect(service.preferencePrincipalForAgent(foreground(binding.sessionId))).toBeUndefined()
    expect(service.prepareOwnerApprovalForPreference(authority)).toEqual({ kind: 'stale-owner' })
    expect(service.prepareOwnerApprovalForPreference({ ...authority, ownerGeneration: next.generation }))
      .toEqual({ kind: 'stale-owner' })
    store.revokePrincipal(owner.id, owner.version)
    expect(service.preferencePrincipalForAgent(foreground(next.sessionId))).toBeUndefined()
    expect(service.prepareOwnerApprovalForPreference({ ...authority, ownerGeneration: next.generation }))
      .toEqual({ kind: 'stale-owner' })
    await ctx.fiber.restart()
  })

  test('derives a workflow approval route from the revalidated private template owner', async () => {
    const { ctx, service } = await harness()
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    const store = runtimeStoreFromService(service)
    const binding = store.createBinding({
      conversation, principal, workspace: '/work/alpha', agentPreset: 'primary',
      sessionId: 'workflow-approval-owner', policyRef: 'owner-dm',
    })
    const template = {
      templateRef: 'workflow-template:test',
      templateDigest: 'a'.repeat(64),
      privacyAttestation: {
        kind: 'deterministic-deidentification' as const,
        method: 'assistant-delivery-redaction-v1' as const,
        attestationId: 'workflow-review:test',
        attestationDigest: 'b'.repeat(64),
      },
    }
    const resolved = {
      contractVersion: 1 as const,
      template,
      scope: { workspace: binding.workspace, preset: binding.agentPreset },
      ownerBindingId: binding.id,
      principalId: 'lark/bot-1/tenant-a/ou_owner',
      name: 'Daily summary',
      prompt: 'Summarize current workspace state.',
      schedule: { kind: 'cron' as const, expression: '0 9 * * *', timezone: 'UTC' },
      timeoutMs: 60_000,
      toolCatalogIds: ['assistant.agent-turn'],
      deliveryBindingId: binding.id,
    }
    const resolve = vi.spyOn(service, 'resolveWorkflowAutomationTemplate').mockReturnValue(resolved)
    const input = { sourceId: 'assistant-growth-automations', contractVersion: 1 as const, template,
      scope: resolved.scope, ownerBindingId: binding.id }
    const owner = store.getPrincipal(principal)!
    expect(service.prepareWorkflowApproval(input)).toEqual({
      routeVersion: 2, sourceId: input.sourceId, bindingId: binding.id,
      bindingVersion: binding.version, bindingGeneration: binding.generation,
      workspace: binding.workspace, principal: resolved.principalId,
      principalRecordId: owner.id, principalVersion: owner.version,
    })
    resolve.mockImplementationOnce(() => {
      store.rotateBinding({ bindingId: binding.id, expectedVersion: binding.version,
        sessionId: 'workflow-approval-owner-next' })
      return resolved
    })
    expect(() => service.prepareWorkflowApproval(input))
      .toThrowError(expect.objectContaining({ code: 'missing-binding' }))
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
    const canonical = { route: approvalRouteFor(service, binding),
      idempotencyKey: 'canonical-card', text: diff, approval: { operationId: `approval:${proposal.proposalId}`,
        proposalId: proposal.proposalId, expectedVersion: proposal.version, expiresAt: proposal.expiresAt,
        title: 'Review exact diff', diffHash: proposal.diffHash } }
    expect(() => service.enqueueApproval({ ...canonical, route: { ...canonical.route, workspace: '/work/other' } })).toThrow()
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
    const exactRoute = approvalRouteFor(service, binding)
    ctx.assistantPolicy.propose({ idempotencyKey: 'bad-dispatch', requester: 'automation:test',
      principal: 'lark/bot-1/tenant-a/ou_owner', action: 'send', resource: { kind: 'message', id: binding.id },
      diff: 'bad', summary: 'Bad route', ttlMs: 5_000,
      dispatch: { ...exactRoute, workspace: '/work/other' } })
    const good = ctx.assistantPolicy.propose({ idempotencyKey: 'good-dispatch', requester: 'automation:test',
      principal: 'lark/bot-1/tenant-a/ou_owner', action: 'send', resource: { kind: 'message', id: binding.id },
      diff: 'good', summary: 'Good route', ttlMs: 5_000,
      dispatch: exactRoute })
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

  test('durably replaces the original approval card only with a domain application terminal state', async () => {
    const { ctx, root, service } = await harness()
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    service.registerInboundRuntime({ createSession: async () => ({ sessionId: 'delivery-session-1',
      workspace: '/work/alpha', agentPreset: 'primary', policyRef: 'owner-dm' }),
    process: async () => ({ outcome: 'processed' }) })
    await service.acceptInbound(envelope)
    const binding = service.history(foreground('delivery-session-1'), {}).binding
    const route = approvalRouteFor(service, binding)
    const updatePresentation = vi.fn(async () => {})
    await service.registerAdapter({
      channel: 'lark',
      account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain', 'markdown', 'approval'] },
      start: async () => {},
      send: async () => ({ outcome: 'accepted', providerMessageId: 'om_domain_terminal' }),
      updatePresentation,
    })
    const proposal = ctx.assistantPolicy.propose({
      idempotencyKey: 'domain-terminal-dispatch',
      requester: 'automation:test',
      principal: 'lark/bot-1/tenant-a/ou_owner',
      action: 'send',
      resource: { kind: 'message', id: binding.id },
      diff: 'adopt exact rule',
      summary: 'Adopt exact rule',
      ttlMs: 60_000,
      dispatch: route,
    })
    await service.tick()
    await service.whenIdle()
    expect(service.history(foreground('delivery-session-1'), {}).outbox.find(row =>
      row.intent.idempotencyKey === `approval-card:${proposal.proposalId}`))
      .toMatchObject({ status: 'accepted', providerMessageId: 'om_domain_terminal' })

    const presentationStore = new DeliveryStore({ path: join(root, 'delivery.sqlite') })
    expect(presentationStore.publishDeliveryPresentation({
      presentationKey: `approval-application:${proposal.proposalId}`,
      originalOutboxIdempotencyKey: `approval-card:${proposal.proposalId}`,
      revision: 1,
      presentation: {
        kind: 'approval-application',
        policyProposalId: proposal.proposalId,
        localProposalId: 'evolution-proposal-1',
        applicationStatus: 'conflicted',
        operation: 'adopt',
        terminalAt: 2_000,
        receiptDigest: 'a'.repeat(64),
      },
    })).toMatchObject({ status: 'pending', presentedRevision: 0 })
    await service.tick()
    await service.whenIdle()
    expect(updatePresentation).toHaveBeenCalledOnce()
    expect(updatePresentation).toHaveBeenCalledWith(
      'om_domain_terminal',
      expect.objectContaining({ applicationStatus: 'conflicted', policyProposalId: proposal.proposalId }),
      expect.any(AbortSignal),
    )
    expect(service.getDeliveryPresentation(`approval-application:${proposal.proposalId}`))
      .toMatchObject({ status: 'presented', presentedRevision: 1, providerMessageId: 'om_domain_terminal' })
    presentationStore.close()
    await ctx.fiber.restart()
  })

  test('keeps an authoritative application terminal retryable past max attempts until its provider recovers', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    const { ctx, service } = await harness()
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    service.registerInboundRuntime({ createSession: async () => ({ sessionId: 'delivery-session-1',
      workspace: '/work/alpha', agentPreset: 'primary', policyRef: 'owner-dm' }),
    process: async () => ({ outcome: 'processed' }) })
    await service.acceptInbound(envelope)
    const binding = service.history(foreground('delivery-session-1'), {}).binding
    const route = approvalRouteFor(service, binding)
    const updatePresentation = vi.fn(async (): Promise<void> => {
      throw new Error('provider temporarily unavailable')
    })
    await service.registerAdapter({
      channel: 'lark',
      account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain', 'approval'] },
      start: async () => {},
      send: async () => ({ outcome: 'accepted', providerMessageId: 'om_presentation_recovery' }),
      updatePresentation,
    })
    const proposal = ctx.assistantPolicy.propose({
      idempotencyKey: 'presentation-recovery-dispatch',
      requester: 'automation:test',
      principal: 'lark/bot-1/tenant-a/ou_owner',
      action: 'send',
      resource: { kind: 'message', id: binding.id },
      diff: 'apply exact state',
      summary: 'Apply exact state',
      ttlMs: 60_000,
      dispatch: route,
    })
    await service.tick()
    await service.whenIdle()
    expect(service.history(foreground('delivery-session-1'), {}).outbox.find(row =>
      row.intent.idempotencyKey === `approval-card:${proposal.proposalId}`))
      .toMatchObject({ status: 'accepted', providerMessageId: 'om_presentation_recovery' })

    const presentationKey = `approval-application:${proposal.proposalId}`
    runtimeStoreFromService(service).publishDeliveryPresentation({
      presentationKey,
      originalOutboxIdempotencyKey: `approval-card:${proposal.proposalId}`,
      revision: 1,
      presentation: {
        kind: 'approval-application',
        policyProposalId: proposal.proposalId,
        localProposalId: 'evolution-proposal-recovery',
        applicationStatus: 'conflicted',
        operation: 'adopt',
        terminalAt: 1_000_001,
        receiptDigest: 'b'.repeat(64),
      },
    })

    // Delivery's regular send limit is five attempts. A completed domain
    // receipt remains authoritative, so provider failures must keep this
    // projection retryable even after that bound has been crossed.
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await service.tick()
      await service.whenIdle()
      const pending = service.getDeliveryPresentation(presentationKey)!
      expect(updatePresentation).toHaveBeenCalledTimes(attempt)
      expect(pending).toMatchObject({ status: 'retry_wait', attemptCount: attempt,
        failureCode: 'presentation-error' })
      // Move past even the capped backoff without relying on an internal
      // scheduling field in the public projection record.
      vi.setSystemTime(Date.now() + 300_000)
    }

    updatePresentation.mockResolvedValueOnce(undefined)
    await service.tick()
    await service.whenIdle()
    expect(updatePresentation).toHaveBeenCalledTimes(7)
    expect(service.getDeliveryPresentation(presentationKey)).toMatchObject({
      status: 'presented', attemptCount: 7, presentedRevision: 1,
      providerMessageId: 'om_presentation_recovery',
    })
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
    const exactRoute = approvalRouteFor(first.service, binding)
    const poison = Array.from({ length: 100 }, (_, index) => first.ctx.assistantPolicy.propose({
      idempotencyKey: `poison-dispatch-${index}`,
      requester: 'automation:test',
      principal: 'lark/bot-1/tenant-a/ou_owner',
      action: 'send',
      resource: { kind: 'message', id: `${binding.id}:poison:${index}` },
      diff: `poison ${index}`,
      summary: `Poison dispatch ${index}`,
      ttlMs: 60_000,
      dispatch: { ...exactRoute, workspace: `/work/poison-${index}` },
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
      dispatch: exactRoute,
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
    const { ctx, root, service } = await harness(true, { resolutionBudget: 1 })
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
    const auditBeforeInvalidOperator = ctx.assistantPolicy.health().lastAuditSequence
    expect(() => service.resolveDeadLetter({ operatorId: 'te\nst', kind: 'outbox', id: unknown.id,
      expectedAttemptCount: unknown.attemptCount, resolution: 'retry' }))
      .toThrowError(expect.objectContaining({ code: 'runtime-conflict' }))
    expect(ctx.assistantPolicy.health().lastAuditSequence).toBe(auditBeforeInvalidOperator)
    const resolution = { operatorId: 'test', kind: 'outbox' as const, id: unknown.id,
      expectedAttemptCount: unknown.attemptCount, resolution: 'retry' as const }
    expect(service.resolveDeadLetter(resolution))
      .toMatchObject({ record: { status: 'pending' }, receipt: { operatorId: 'test' }, replayed: false })
    expect(service.resolveDeadLetter(resolution))
      .toMatchObject({ record: { status: 'pending' }, receipt: { operatorId: 'test' }, replayed: true })
    expect(() => service.resolveDeadLetter({ ...resolution, operatorId: 'other' }))
      .toThrowError(expect.objectContaining({ code: 'version-conflict' }))
    const policyDatabase = new DatabaseSync(join(root, 'policy.sqlite'), { readOnly: true })
    const reservations = policyDatabase.prepare(`
      SELECT scope, metric, status FROM budget_reservations
      WHERE metric = 'delivery-resolutions' ORDER BY scope
    `).all()
    policyDatabase.close()
    expect(reservations).toEqual([
      { scope: 'external:local:other', metric: 'delivery-resolutions', status: 'finalized' },
      { scope: 'external:local:test', metric: 'delivery-resolutions', status: 'finalized' },
    ])
    await ctx.fiber.restart()
  })
})
