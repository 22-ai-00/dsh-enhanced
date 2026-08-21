import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionPreparation, type SessionEvent, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { deliveryProgressFromSessionEvent } from '../src/agent-runtime.ts'
import { AssistantDeliveryService } from '../src/service.ts'
import type { DeliveryAdapter, DeliveryProgressIntent, InboundEnvelope, OutboundIntent } from '../src/types.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface SavedSession { header: SessionHeader; events: readonly SessionEvent[] }

class ReplyAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly providerName = 'Mock provider',
    private readonly models: readonly string[] = ['delivery-model'],
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.providerName }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.models.map(model => ({ provider, id: model, name: model }))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const effortIds = model === 'fast' ? ['low'] : model === 'precise' ? ['high'] : ['low', 'high']
    return { provider, id: model, name: model, reasoning: {
      efforts: effortIds.map(id => ({ id: ReasoningEffortId(id), name: id === 'low' ? 'Low' : 'High' })),
      defaultEffort: ReasoningEffortId(effortIds[0]!),
    } }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = `reply-${this.requests.length}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const principal = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner' }
const conversation = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm' as const, chat: 'oc_owner' }

function message(eventId: string, text: string, kind: 'command' | 'text' = 'text'): InboundEnvelope {
  return { channel: 'lark', account: 'bot-1', eventId, occurredAt: Date.now(), principal, conversation, kind, text }
}

async function runtimeHarness(
  root: string,
  saved: Map<string, SavedSession>,
  defaultRoute = { provider: 'mock', model: 'delivery-model' },
) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' } })
  ctx.on('session/flush', session => {
    saved.set(String(session.id), structuredClone({ header: session.header, events: session.events }))
  })
  ctx.provide('sessionPersistence' as never, {
    prepare: async (id: SessionId) => {
      const value = saved.get(String(id))
      if (value === undefined) throw new Error(`session not found: ${id}`)
      const restored = structuredClone(value)
      return SessionPreparation.create(ctx.sessions.prepare(id, {
        seedSource: 'persistence', seed: [...restored.events], meta: restored.header,
      }))
    },
  } as never)
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: [
    { id: 'local-pair', effect: 'allow', subject: { kind: 'external', id: 'local:test' }, actions: ['pair.issue'],
      resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
    { id: 'owner-ingest', effect: 'allow', subject: { kind: 'external', id: 'lark/bot-1/tenant-a/ou_owner' },
      actions: ['pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
    { id: 'agent-reply', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: root },
      actions: ['reply'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
  ] })
  await ctx.plugin(AssistantDeliveryService, { databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'),
    schedulerEnabled: false, defaultWorkspace: root, defaultAgentPreset: 'primary', agentProvider: defaultRoute.provider,
    agentModel: defaultRoute.model })
  const llm = new ReplyAdapter()
  ctx.llm.registerAdapter(['mock'], llm)
  const alternate = new ReplyAdapter('Alternate provider', ['fast', 'precise'])
  ctx.llm.registerAdapter(['alternate'], alternate)
  await ctx.plugin(AgentLoop, { agents: [] })
  const sends: OutboundIntent[] = []
  const progresses: DeliveryProgressIntent[] = []
  const channel: DeliveryAdapter = { channel: 'lark', account: 'bot-1',
    capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain', 'model-picker'] }, start: async () => {},
    progress: async intent => { progresses.push(intent) },
    send: async intent => { sends.push(intent); return { outcome: 'accepted', providerMessageId: `om_${sends.length}` } } }
  await ctx.assistantDelivery.registerAdapter(channel)
  return { ctx, llm, alternate, progresses, sends, service: ctx.assistantDelivery }
}

async function drive(service: AssistantDeliveryService): Promise<void> {
  await service.tick()
  await service.whenIdle()
  await service.tick()
  await service.whenIdle()
}

describe('real rc.8 delivery Agent runtime', () => {
  test('persists one owner session, resumes across turns/restart, and deduplicates provider events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-agent-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const first = await runtimeHarness(root, saved)
    const pairing = first.service.issuePairing('test', principal)
    first.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    await first.service.acceptInbound(message('evt-1', 'first'))
    await drive(first.service)
    expect(first.llm.requests).toHaveLength(1)
    expect(first.llm.requests[0]).toMatchObject({ provider: 'mock', model: 'delivery-model' })
    expect(first.llm.requests[0]!.messages.at(-1)?.source).toEqual({ kind: 'delivery', channel: 'lark',
      account: 'bot-1', eventId: 'evt-1', trust: 'untrusted' })
    expect(first.sends.map(value => value.text)).toEqual(['reply-1'])
    expect(first.sends[0]?.replyToEventId).toBe('evt-1')
    expect(first.progresses.map(value => value.update.kind)).toEqual(['started', 'completed'])
    expect(first.progresses.every(value => value.eventId === 'evt-1')).toBe(true)

    const secondMessage = message('evt-2', 'second')
    await first.service.acceptInbound(secondMessage)
    await drive(first.service)
    expect(first.llm.requests).toHaveLength(2)
    expect(JSON.stringify(first.llm.requests[1]!.messages)).toContain('first')
    expect(await first.service.acceptInbound(secondMessage)).toMatchObject({ duplicate: true,
      status: 'processed' })
    await drive(first.service)
    expect(first.llm.requests).toHaveLength(2)
    await first.ctx.fiber.restart()

    const restarted = await runtimeHarness(root, saved)
    await restarted.service.acceptInbound(message('evt-3', 'after restart'))
    await drive(restarted.service)
    expect(restarted.llm.requests).toHaveLength(1)
    expect(JSON.stringify(restarted.llm.requests[0]!.messages)).toContain('second')
    expect(restarted.sends.map(value => value.text)).toEqual(['reply-1'])
    await restarted.ctx.fiber.restart()
  })

  test('turns session events into safe progress without exposing reasoning, arguments, or tool output', () => {
    const event = (value: object) => value as SessionEvent
    expect(deliveryProgressFromSessionEvent(event({
      type: 'assistant/chunk', data: { turn: 1, step: 1,
        chunk: { type: 'reasoning-delta', index: 0, text: 'private chain of thought' } },
    }))).toBeUndefined()
    expect(deliveryProgressFromSessionEvent(event({
      type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'web.search',
        arguments: '{"secret":"must-not-leak"}' },
    }))).toEqual({ kind: 'tool-started', callId: 'call-1', toolName: 'web.search' })
    expect(deliveryProgressFromSessionEvent(event({
      type: 'tool/result', data: { turn: 1, step: 1,
        message: { source: { callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1',
          content: [{ type: 'text', text: 'sensitive tool result' }] }] } },
    }))).toEqual({ kind: 'tool-finished', callId: 'call-1', failed: false })
    expect(deliveryProgressFromSessionEvent(event({
      type: 'todo/write', data: { todos: [
        { content: '核对官方接口', status: 'completed' },
        { content: '实现并验证', status: 'in_progress' },
      ] },
    }))).toEqual({ kind: 'todos', todos: [
      { content: '核对官方接口', status: 'completed' },
      { content: '实现并验证', status: 'in_progress' },
    ] })
    const serialized = JSON.stringify([
      deliveryProgressFromSessionEvent(event({ type: 'assistant/chunk', data: { turn: 1, step: 1,
        chunk: { type: 'reasoning-delta', index: 0, text: 'private chain of thought' } } })),
      deliveryProgressFromSessionEvent(event({ type: 'tool/call', data: { turn: 1, step: 1,
        callId: 'call-1', name: 'web.search', arguments: '{"secret":"must-not-leak"}' } })),
      deliveryProgressFromSessionEvent(event({ type: 'tool/result', data: { turn: 1, step: 1,
        message: { source: { callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1',
          content: [{ type: 'text', text: 'sensitive tool result' }] }] } } })),
    ])
    expect(serialized).not.toContain('private chain of thought')
    expect(serialized).not.toContain('must-not-leak')
    expect(serialized).not.toContain('sensitive tool result')
  })

  test('/new rotates generation without deleting the persisted old session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-new-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await runtimeHarness(root, saved)
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    await fixture.service.acceptInbound(message('evt-1', 'first'))
    await drive(fixture.service)
    const before = new Set(saved.keys())
    await fixture.service.acceptInbound(message('evt-new', '/new', 'command'))
    await drive(fixture.service)
    expect(saved.size).toBe(before.size + 1)
    expect([...before].every(id => saved.has(id))).toBe(true)
    expect(fixture.llm.requests).toHaveLength(1)
    await fixture.ctx.fiber.restart()
  })

  test('/model lists live routes without an LLM turn and persists a per-conversation switch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-model-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const first = await runtimeHarness(root, saved, { provider: 'missing-default', model: 'unavailable' })
    const pairing = first.service.issuePairing('test', principal)
    first.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    await first.service.acceptInbound(message('evt-model-list', '/model', 'command'))
    await drive(first.service)
    expect(first.llm.requests).toHaveLength(0)
    expect(first.alternate.requests).toHaveLength(0)
    expect(first.sends.at(-1)).toMatchObject({
      format: 'model-picker',
      modelPicker: {
        current: { provider: 'missing-default', model: 'unavailable' },
        providers: expect.arrayContaining([{ id: 'alternate', name: 'Alternate provider' }]),
        models: expect.arrayContaining([{
          provider: 'alternate', id: 'fast', name: 'fast', effortIds: ['low'],
        }]),
        efforts: expect.arrayContaining([{ id: 'high', name: 'High' }]),
      },
    })
    const catalogReply = first.sends.at(-1)!
    expect(first.service.getModelPickerForCallback({
      operationId: catalogReply.modelPicker!.operationId,
      callbackChatId: conversation.chat,
      bindingId: catalogReply.bindingId,
      principal,
    })).toEqual(catalogReply.modelPicker)

    await first.service.acceptInbound(message('evt-model-use', '/model use alternate/fast', 'command'))
    await drive(first.service)
    expect(first.llm.requests).toHaveLength(0)
    expect(first.alternate.requests).toHaveLength(0)
    expect(first.sends.at(-1)?.text).toContain('已切换到 alternate/fast')
    expect(first.sends.at(-1)?.text).toContain('下一条消息起生效，上下文保留')

    await first.service.acceptInbound(message('evt-model-list-after-use', '/model', 'command'))
    await drive(first.service)
    expect(first.sends.at(-1)).toMatchObject({
      format: 'model-picker',
      replyToEventId: 'evt-model-list-after-use',
    })
    expect(first.sends.at(-1)?.modelPicker?.current).toEqual({ provider: 'alternate', model: 'fast' })

    await first.service.acceptInbound(message('evt-new-after-model', '/new', 'command'))
    await drive(first.service)
    expect(first.alternate.requests).toHaveLength(0)
    await first.ctx.fiber.restart()

    const restarted = await runtimeHarness(root, saved)
    await restarted.service.acceptInbound(message('evt-after-model-restart', 'hello on selected model'))
    await drive(restarted.service)
    expect(restarted.llm.requests).toHaveLength(0)
    expect(restarted.alternate.requests).toHaveLength(1)
    expect(restarted.alternate.requests[0]).toMatchObject({ provider: 'alternate', model: 'fast' })
    await restarted.ctx.fiber.restart()
  })

  test('/model remains available when the bound Agent session cannot resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-model-recovery-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await runtimeHarness(root, saved)
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    const inbound = message('evt-model-recovery', '/model', 'command')
    await fixture.service.acceptInbound(inbound)
    saved.clear()
    await drive(fixture.service)

    expect(fixture.llm.requests).toHaveLength(0)
    expect(fixture.alternate.requests).toHaveLength(0)
    expect(fixture.sends.at(-1)).toMatchObject({
      format: 'model-picker',
      replyToEventId: 'evt-model-recovery',
    })
    expect(await fixture.service.acceptInbound(inbound)).toMatchObject({ duplicate: true, status: 'processed' })
    await fixture.ctx.fiber.restart()
  })

  test('/model falls back to the text catalog when a malformed card option is rejected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-model-fallback-'))
    roots.push(root)
    const fixture = await runtimeHarness(root, new Map())
    fixture.ctx.llm.registerAdapter(['broken'], new ReplyAdapter('Broken provider', ['bad model']))
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    const inbound = message('evt-model-fallback', '/model', 'command')
    await fixture.service.acceptInbound(inbound)
    await drive(fixture.service)

    expect(fixture.sends.at(-1)).toMatchObject({ format: 'plain', replyToEventId: 'evt-model-fallback' })
    expect(fixture.sends.at(-1)?.text).toContain('broken/bad model')
    expect(fixture.sends.at(-1)?.text).toContain('/model use <provider/model>')
    expect(await fixture.service.acceptInbound(inbound)).toMatchObject({ duplicate: true, status: 'processed' })
    await fixture.ctx.fiber.restart()
  })

  test('/model refuses an unregistered provider and reset restores the deployment default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-model-reset-'))
    roots.push(root)
    const fixture = await runtimeHarness(root, new Map())
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    await fixture.service.acceptInbound(message('evt-model-invalid', '/model use missing/model', 'command'))
    await drive(fixture.service)
    expect(fixture.sends.at(-1)?.text).toContain('没有注册 provider “missing”')

    await fixture.service.acceptInbound(message('evt-model-use', '/model use alternate/precise', 'command'))
    await drive(fixture.service)
    await fixture.service.acceptInbound(message('evt-model-reset', '/model reset', 'command'))
    await drive(fixture.service)
    expect(fixture.sends.at(-1)?.text).toContain('已恢复默认模型 mock/delivery-model')

    await fixture.service.acceptInbound(message('evt-after-reset', 'hello on default'))
    await drive(fixture.service)
    expect(fixture.llm.requests).toHaveLength(1)
    expect(fixture.llm.requests[0]).toMatchObject({ provider: 'mock', model: 'delivery-model' })
    expect(fixture.alternate.requests).toHaveLength(0)
    await fixture.ctx.fiber.restart()
  })

  test('a correlated model-card confirmation applies provider, model, and effort to the next turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-model-card-'))
    roots.push(root)
    const fixture = await runtimeHarness(root, new Map())
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    await fixture.service.acceptInbound(message('evt-picker', '/model', 'command'))
    await drive(fixture.service)
    const picker = fixture.sends.at(-1)!

    await expect(fixture.service.settleModelSelection({
      operationId: picker.modelPicker!.operationId,
      callbackEventId: 'card-callback-mismatch',
      callbackChatId: conversation.chat,
      bindingId: picker.bindingId,
      principal,
      provider: 'alternate',
      modelProvider: 'mock',
      model: 'delivery-model',
      reasoningEffort: 'high',
    })).resolves.toEqual({ status: 'rejected', reason: 'provider-model-mismatch' })
    await drive(fixture.service)
    expect(fixture.sends.at(-1)?.text).toContain('分组 alternate 与模型 mock/delivery-model 不匹配')

    await expect(fixture.service.settleModelSelection({
      operationId: picker.modelPicker!.operationId,
      callbackEventId: 'card-callback-1',
      callbackChatId: conversation.chat,
      bindingId: picker.bindingId,
      principal,
      provider: 'alternate',
      modelProvider: 'alternate',
      model: 'precise',
      reasoningEffort: 'high',
    })).resolves.toMatchObject({ status: 'selected', selection: {
      provider: 'alternate', model: 'precise', reasoningEffort: 'high',
    } })
    await drive(fixture.service)
    expect(fixture.sends.at(-1)?.text).toContain('已切换到 alternate/precise，effort：high')

    await fixture.service.acceptInbound(message('evt-after-card', 'use the card selection'))
    await drive(fixture.service)
    expect(fixture.alternate.requests.at(-1)).toMatchObject({
      provider: 'alternate', model: 'precise', reasoningEffort: 'high',
    })
    await fixture.ctx.fiber.restart()
  })
})
