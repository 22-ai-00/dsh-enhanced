import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
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
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { deliveryProgressFromSessionEvent, modelPickerOperationId } from '../src/agent-runtime.ts'
import { AssistantDeliveryService } from '../src/service.ts'
import type {
  DeliveryAdapter, DeliveryProgressIntent, InboundEnvelope, OutboundFormat, OutboundIntent,
} from '../src/types.ts'

const roots: string[] = []
const PRESET_TOOLS = ['bash', 'read', 'grep', 'glob'] as const

const presetToolsPlugin = {
  name: 'assistant-delivery-test-tools',
  inject: ['tools'],
  apply(ctx: Context) {
    for (const name of PRESET_TOOLS) {
      ctx.tools.register(defineTool({
        name,
        description: `${name} preset fixture`,
        parameters: {},
        output: {
          schema: { type: 'object', additionalProperties: false, properties: {} },
          render: () => [],
        },
        async execute() { return {} },
      }))
    }
  },
}

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
  channelFormats: readonly OutboundFormat[] = ['plain', 'model-picker'],
  workspace = root,
  presetRoot?: string,
  agentPreset = 'primary',
  provideAgentPresets = true,
) {
  const ctx = new Context()
  if (presetRoot !== undefined) await ctx.plugin(Loader)
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' }, tools: { mode: 'native' } })
  if (presetRoot === undefined && provideAgentPresets) {
    const presetResolve = vi.fn(async (id?: string) => ({ id: id ?? agentPreset }))
    const presetMount = vi.fn(async (agentCtx: Agent['ctx'], id?: string) => {
      agentCtx.tools.register(defineTool({
        name: 'preset_probe',
        description: 'Visible only when the delivery Agent mounts its configured preset.',
        parameters: {},
        output: {
          schema: { type: 'object', additionalProperties: false,
            properties: { mounted: { type: 'boolean', required: true } } },
          render: (_args, output) => [{ type: 'text', text: JSON.stringify(output) }],
        },
        async execute() { return { mounted: true } },
      }))
      return { id: id ?? agentPreset }
    })
    ctx.provide('agentPresets' as never, { resolve: presetResolve, mount: presetMount } as never)
  } else if (presetRoot !== undefined) {
    ctx.loader.builtins['assistant-delivery-test-tools'] = presetToolsPlugin
    await ctx.plugin(AgentPresets, {
      default: agentPreset,
      roots: [{ path: presetRoot, trust: 'system' }],
      includeUserRoot: false,
    })
  }
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
    { id: 'agent-reply', effect: 'allow', subject: { kind: 'agent', id: agentPreset, workspace },
      actions: ['reply'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
  ] })
  await ctx.plugin(AssistantDeliveryService, { databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'),
    schedulerEnabled: false, defaultWorkspace: workspace, defaultAgentPreset: agentPreset, agentProvider: defaultRoute.provider,
    agentModel: defaultRoute.model })
  const llm = new ReplyAdapter()
  ctx.llm.registerAdapter(['mock'], llm)
  const alternate = new ReplyAdapter('Alternate provider', ['fast', 'precise'])
  ctx.llm.registerAdapter(['alternate'], alternate)
  await ctx.plugin(AgentLoop, { agents: [] })
  const sends: OutboundIntent[] = []
  const progresses: DeliveryProgressIntent[] = []
  const channel: DeliveryAdapter = { channel: 'lark', account: 'bot-1',
    capabilities: { reconcileUnknownSend: false, receipts: [], formats: channelFormats }, start: async () => {},
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
  test('namespaces model-picker operations by conversation as well as provider event id', () => {
    const first = modelPickerOperationId(conversation, 'same-event')
    expect(modelPickerOperationId(conversation, 'same-event')).toBe(first)
    expect(modelPickerOperationId({ ...conversation, account: 'bot-2' }, 'same-event')).not.toBe(first)
    expect(modelPickerOperationId({ ...conversation, chat: 'oc_other' }, 'same-event')).not.toBe(first)
  })

  test('asks for Markdown rendering when the channel declares that capability', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-markdown-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const f = await runtimeHarness(root, saved, undefined, ['plain', 'markdown', 'model-picker'])
    const pairing = f.service.issuePairing('test', principal)
    f.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    await f.service.acceptInbound(message('evt-md', 'first'))
    await drive(f.service)

    // Answers are authored as Markdown, so a capable channel must be told to render them.
    expect(f.sends.map(value => value.text)).toEqual(['reply-1'])
    expect(f.sends[0]?.format).toBe('markdown')
  })

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
    // This adapter does not declare `markdown`, so the answer degrades to plain text rather than
    // being dropped by the coordinator as an unsupported format.
    expect(first.sends[0]?.format).toBe('plain')
    expect(first.sends[0]?.replyToEventId).toBe('evt-1')
    // The mock provider emits no reasoning, so the phase label is what keeps the surface non-empty.
    expect(first.progresses.map(value => value.update.kind)).toEqual(['started', 'step', 'completed'])
    expect(first.progresses.filter(value => value.update.kind === 'step')
      .map(value => value.update.kind === 'step' ? value.update.text : '')).toEqual(['正在处理请求…'])
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

  test('mounts the durable preset before fresh and restarted Agent requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-preset-'))
    roots.push(root)
    const presetRoot = join(root, 'presets')
    await mkdir(join(presetRoot, 'standard'), { recursive: true })
    await writeFile(join(presetRoot, 'standard', 'agent.cordis.yml'), [
      '- id: tools',
      '  name: cordis:assistant-delivery-test-tools',
      '',
    ].join('\n'))
    const saved = new Map<string, SavedSession>()
    const first = await runtimeHarness(root, saved, undefined, undefined, root, presetRoot, 'standard')
    const firstPublished: Array<string | undefined> = []
    first.ctx.on('agent/created', ({ agent }) => {
      firstPublished.push(first.ctx.agentPresets.composedPreset(agent.ctx))
    })
    const pairing = first.service.issuePairing('test', principal)
    first.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    await first.service.acceptInbound(message('evt-preset-first', 'first'))
    expect(firstPublished).toEqual(['standard'])
    await drive(first.service)
    expect(firstPublished).toEqual(['standard', 'standard'])
    expect(first.llm.requests[0]?.tools?.map(tool => tool.name))
      .toEqual(expect.arrayContaining([...PRESET_TOOLS]))
    await first.ctx.fiber.restart()

    const restarted = await runtimeHarness(root, saved, undefined, undefined, root, presetRoot, 'standard')
    const restartedPublished: Array<string | undefined> = []
    restarted.ctx.on('agent/created', ({ agent }) => {
      restartedPublished.push(restarted.ctx.agentPresets.composedPreset(agent.ctx))
    })
    await restarted.service.acceptInbound(message('evt-preset-resume', 'after restart'))
    await drive(restarted.service)
    expect(restartedPublished).toEqual(['standard'])
    expect(restarted.llm.requests[0]?.tools?.map(tool => tool.name))
      .toEqual(expect.arrayContaining([...PRESET_TOOLS]))
    await restarted.ctx.fiber.restart()
  })

  test('keeps headless global-tool composition working when no AgentPresets roster is installed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-headless-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await runtimeHarness(root, saved, undefined, undefined, root, undefined, 'primary', false)
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    await fixture.service.acceptInbound(message('evt-headless', 'hello'))
    await drive(fixture.service)

    expect(fixture.llm.requests).toHaveLength(1)
    expect(fixture.llm.requests[0]?.tools?.map(tool => tool.name)).not.toContain('preset_probe')
    expect([...saved.values()][0]?.header.agentPreset).toBe('primary')
    await fixture.ctx.fiber.restart()
  })

  test('rolls back an unpublished binding when preset mounting fails and can retry the same event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-preset-failure-'))
    roots.push(root)
    const fixture = await runtimeHarness(root, new Map())
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    const mount = vi.spyOn(fixture.ctx.agentPresets, 'mount')
      .mockRejectedValueOnce(new Error('preset fixture unavailable'))
    const inbound = message('evt-preset-failure', 'hello')

    await expect(fixture.service.acceptInbound(inbound)).rejects.toThrow(/preset fixture unavailable/u)
    expect(mount).toHaveBeenCalledOnce()
    await expect(fixture.service.acceptInbound(inbound)).resolves.toMatchObject({ duplicate: true, status: 'queued' })
    await drive(fixture.service)

    expect(fixture.llm.requests).toHaveLength(1)
    await fixture.ctx.fiber.restart()
  })

  test('creates a missing configured workspace before starting its first Agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-workspace-'))
    roots.push(root)
    const workspace = join(root, 'missing', 'assistant-workspace')
    const saved = new Map<string, SavedSession>()
    const fixture = await runtimeHarness(root, saved, undefined, undefined, workspace)
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    await fixture.service.acceptInbound(message('evt-workspace', 'hello'))
    await drive(fixture.service)
    await expect(access(workspace)).resolves.toBeUndefined()
    await fixture.ctx.fiber.restart()
  })

  test('does not silently recreate a deleted durable workspace before a cold Agent resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-resume-workspace-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const saved = new Map<string, SavedSession>()
    const first = await runtimeHarness(root, saved, undefined, undefined, workspace)
    const pairing = first.service.issuePairing('test', principal)
    first.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    await first.service.acceptInbound(message('evt-resume-workspace-first', 'first'))
    await drive(first.service)
    await first.ctx.fiber.restart()
    await rm(workspace, { recursive: true, force: true })

    const restarted = await runtimeHarness(root, saved, undefined, undefined, workspace)
    await restarted.service.acceptInbound(message('evt-resume-workspace-second', 'second'))
    await drive(restarted.service)

    await expect(access(workspace)).rejects.toThrow()
    expect(restarted.llm.requests).toHaveLength(0)
    await restarted.ctx.fiber.restart()
  })

  test('dead-letters a durable Agent identity mismatch without retrying it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-identity-mismatch-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const first = await runtimeHarness(root, saved)
    const pairing = first.service.issuePairing('test', principal)
    first.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    await first.service.acceptInbound(message('evt-identity-first', 'first'))
    await drive(first.service)
    await first.ctx.fiber.restart()
    for (const [id, session] of saved) {
      saved.set(id, { ...session, header: { ...session.header, cwd: join(root, 'tampered-workspace') } })
    }

    const restarted = await runtimeHarness(root, saved)
    const inbound = message('evt-identity-mismatch', 'second')
    await restarted.service.acceptInbound(inbound)
    await drive(restarted.service)

    expect(restarted.llm.requests).toHaveLength(0)
    await expect(restarted.service.acceptInbound(inbound)).resolves.toMatchObject({
      duplicate: true,
      status: 'dead_letter',
    })
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

  test('turns the settled reasoning of an assistant message into one step update', () => {
    const event = (value: object) => value as SessionEvent
    // Providers differ: some emit no reasoning at all, so a step phase label always lands first.
    expect(deliveryProgressFromSessionEvent(event({
      type: 'step/start', data: { turn: 1, step: 1 },
    }))).toEqual({ kind: 'step', text: '正在处理请求…' })
    expect(deliveryProgressFromSessionEvent(event({
      type: 'step/start', data: { turn: 1, step: 3 },
    }))).toEqual({ kind: 'step', text: '正在继续处理（第 3 步）…' })
    // The durable reasoning block is the assistant's own settled summary, so a turn with no tool
    // call and no todo still reports what it did instead of leaving the panel empty.
    expect(deliveryProgressFromSessionEvent(event({
      type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [
        { type: 'reasoning', text: '  先确认当前目录  ' },
        { type: 'reasoning', text: '再核对分组顺序' },
        { type: 'text', text: '这是最终回复，不应出现在进度里' },
      ] } },
    }))).toEqual({ kind: 'step', text: '先确认当前目录\n再核对分组顺序' })
    // A reply-only message contributes no step, and the visible answer never leaks into progress.
    const replyOnly = deliveryProgressFromSessionEvent(event({
      type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [
        { type: 'text', text: '这是最终回复，不应出现在进度里' },
      ] } },
    }))
    expect(replyOnly).toBeUndefined()
    expect(deliveryProgressFromSessionEvent(event({
      type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [
        { type: 'reasoning', text: '   ' },
      ] } },
    }))).toBeUndefined()
    // Streaming deltas stay private; only the settled block is surfaced.
    expect(JSON.stringify(deliveryProgressFromSessionEvent(event({
      type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [
        { type: 'reasoning', text: '可见的步骤说明' },
        { type: 'text', text: '最终回复文本' },
      ] } },
    })))).not.toContain('最终回复文本')
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

    const mismatchCallback = {
      operationId: picker.modelPicker!.operationId,
      callbackEventId: 'card-callback-mismatch',
      callbackChatId: conversation.chat,
      bindingId: picker.bindingId,
      principal,
      provider: 'alternate',
      modelProvider: 'mock',
      model: 'delivery-model',
      reasoningEffort: 'high',
      expectedRevision: 0,
    } as const
    expect(fixture.service.settleModelSelection(mismatchCallback)).toEqual({ status: 'pending' })
    await fixture.service.whenIdle()
    expect(fixture.service.settleModelSelection(mismatchCallback))
      .toEqual({ status: 'rejected', reason: 'provider-model-mismatch' })
    await drive(fixture.service)
    expect(fixture.sends.at(-1)?.text).toContain('分组 alternate 与模型 mock/delivery-model 不匹配')
    expect(fixture.sends.filter(send => send.text.includes('分组 alternate 与模型'))).toHaveLength(1)

    await fixture.service.acceptInbound(message('evt-picker-valid', '/model', 'command'))
    await drive(fixture.service)
    const validPicker = fixture.sends.at(-1)!

    const selectionCallback = {
      operationId: validPicker.modelPicker!.operationId,
      callbackEventId: 'card-callback-1',
      callbackChatId: conversation.chat,
      bindingId: validPicker.bindingId,
      principal,
      provider: 'alternate',
      modelProvider: 'alternate',
      model: 'precise',
      reasoningEffort: 'high',
      expectedRevision: 0,
    } as const
    expect(fixture.service.settleModelSelection(selectionCallback)).toEqual({ status: 'pending' })
    await fixture.service.whenIdle()
    const selected = fixture.service.settleModelSelection(selectionCallback)
    expect(selected).toMatchObject({ status: 'selected', selection: {
      provider: 'alternate', model: 'precise', reasoningEffort: 'high',
    } })
    expect(fixture.service.settleModelSelection(selectionCallback)).toEqual(selected)
    await drive(fixture.service)
    expect(fixture.sends.at(-1)?.text).toContain('已切换到 alternate/precise，effort：high')
    expect(fixture.sends.filter(send => send.text.includes('已切换到 alternate/precise'))).toHaveLength(1)

    await fixture.service.acceptInbound(message('evt-after-card', 'use the card selection'))
    await drive(fixture.service)
    expect(fixture.alternate.requests.at(-1)).toMatchObject({
      provider: 'alternate', model: 'precise', reasoningEffort: 'high',
    })
    await fixture.ctx.fiber.restart()
  })

  test('rechecks policy after live model resolution before committing a card selection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-model-card-policy-'))
    roots.push(root)
    const fixture = await runtimeHarness(root, new Map())
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    await fixture.service.acceptInbound(message('evt-picker-policy', '/model', 'command'))
    await drive(fixture.service)
    const picker = fixture.sends.at(-1)!

    const originalResolve = fixture.alternate.resolveModel.bind(fixture.alternate)
    let releaseResolve!: () => void
    let markResolveStarted!: () => void
    const resolveGate = new Promise<void>(resolve => { releaseResolve = resolve })
    const resolveStarted = new Promise<void>(resolve => { markResolveStarted = resolve })
    fixture.alternate.resolveModel = async (provider, model) => {
      markResolveStarted()
      await resolveGate
      return await originalResolve(provider, model)
    }
    const selectionCallback = {
      operationId: picker.modelPicker!.operationId,
      callbackEventId: 'card-callback-policy',
      callbackChatId: conversation.chat,
      bindingId: picker.bindingId,
      principal,
      provider: 'alternate',
      modelProvider: 'alternate',
      model: 'precise',
      reasoningEffort: 'high',
      expectedRevision: 0,
    } as const
    const sentBeforeConfirmation = fixture.sends.length
    const authorize = vi.spyOn(fixture.ctx.assistantPolicy, 'authorize')
    expect(fixture.service.settleModelSelection(selectionCallback)).toEqual({ status: 'pending' })
    await resolveStarted
    fixture.ctx.assistantPolicy.setEmergencyStop({ enabled: true, actor: 'test', reason: 'test revocation race' })
    releaseResolve()
    await fixture.service.whenIdle()
    expect(authorize).toHaveBeenCalledOnce()
    fixture.ctx.assistantPolicy.setEmergencyStop({ enabled: false, actor: 'test', reason: 'test complete' })

    expect(fixture.service.settleModelSelection(selectionCallback))
      .toEqual({ status: 'rejected', reason: 'authorization-revoked' })
    await drive(fixture.service)
    expect(fixture.sends).toHaveLength(sentBeforeConfirmation)
    await fixture.ctx.fiber.restart()
  })

  test('bounds a model resolver that ignores cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-model-card-timeout-'))
    roots.push(root)
    const fixture = await runtimeHarness(root, new Map())
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    await fixture.service.acceptInbound(message('evt-picker-timeout', '/model', 'command'))
    await drive(fixture.service)
    const picker = fixture.sends.at(-1)!
    fixture.alternate.resolveModel = async () => await new Promise<never>(() => {})
    const selectionCallback = {
      operationId: picker.modelPicker!.operationId,
      callbackEventId: 'card-callback-timeout',
      callbackChatId: conversation.chat,
      bindingId: picker.bindingId,
      principal,
      provider: 'alternate',
      modelProvider: 'alternate',
      model: 'precise',
      reasoningEffort: 'high',
      expectedRevision: 0,
    } as const

    vi.useFakeTimers()
    try {
      expect(fixture.service.settleModelSelection(selectionCallback)).toEqual({ status: 'pending' })
      await vi.advanceTimersByTimeAsync(30_001)
      await fixture.service.whenIdle()
    } finally {
      vi.useRealTimers()
    }
    expect(fixture.service.settleModelSelection(selectionCallback))
      .toEqual({ status: 'rejected', reason: 'model-unavailable' })
    await fixture.ctx.fiber.restart()
  })
})
