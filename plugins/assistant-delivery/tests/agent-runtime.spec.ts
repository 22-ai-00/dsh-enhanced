import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import { AttachmentId, type AttachmentStore, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { PresetSpec } from '@deepseek-ai/dsh-permission-presets'
import {
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  SessionPreparation,
  type Session,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { effectiveApprovalPolicy, setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { approvalReviewerOf, AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import {
  registerLlmRouteCapability,
} from '@dsh-enhanced/llm-route-capabilities'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { deliveryProgressFromSessionEvent, modelPickerOperationId } from '../src/agent-runtime.ts'
import { AssistantDeliveryService } from '../src/service.ts'
import type {
  ConversationBinding, DeliveryAdapter, DeliveryProgressIntent, InboundEnvelope, OutboundFormat, OutboundIntent,
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

interface PermissionHarnessOptions {
  providePresets?: boolean
  provideApproval?: boolean
  presets?: Record<string, PresetSpec>
  onResolve?(): void
  leaseMs?: number
}

const testPermissionPresets = {
  'guarded-dynamic-id': {
    sandbox: 'workspace-write',
    approval: 'ask',
    name: 'Guarded workspace',
  },
  'unlocked-dynamic-id': {
    sandbox: 'danger-full-access',
    approval: 'never',
    name: 'Unrestricted host',
  },
} as const satisfies Record<string, PresetSpec>

function lastPermissionPreset(events: readonly SessionEvent[]): string | undefined {
  return events.findLast(event => event.type === 'permission/preset')?.data.preset
}

function sandboxModeOf(event: SessionEvent): PresetSpec['sandbox'] | undefined {
  const candidate = event as unknown as { type: string; data?: { mode?: unknown } }
  return candidate.type === 'sandbox/mode'
    && (candidate.data?.mode === 'workspace-write' || candidate.data?.mode === 'danger-full-access')
    ? candidate.data.mode
    : undefined
}

function lastSandboxMode(events: readonly SessionEvent[]): PresetSpec['sandbox'] | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const mode = sandboxModeOf(events[index]!)
    if (mode !== undefined) return mode
  }
  return undefined
}

function permissionPresetFixture(options: PermissionHarnessOptions) {
  const presets: Readonly<Record<string, PresetSpec>> = options.presets ?? testPermissionPresets
  const names = Object.keys(presets)
  const resolve = vi.fn((name: string): PresetSpec => {
    options.onResolve?.()
    const preset = presets[name]
    if (preset === undefined) throw new Error(`unknown test permission preset: ${name}`)
    return preset
  })
  const current = (events: readonly SessionEvent[]): string => {
    const sandbox = lastSandboxMode(events) ?? 'workspace-write'
    const approval = effectiveApprovalPolicy(events) ?? 'ask'
    const selected = lastPermissionPreset(events)
    if (selected !== undefined) {
      const preset = presets[selected]
      if (preset?.sandbox === sandbox && preset.approval === approval) return selected
    }
    return names.find(name => presets[name]?.sandbox === sandbox && presets[name]?.approval === approval) ?? 'custom'
  }
  const set = vi.fn((session: Session, name: string): void => {
    const preset = resolve(name)
    if (current(session.events) !== name) session.append('permission/preset', { preset: name })
    if ((lastSandboxMode(session.events) ?? 'workspace-write') !== preset.sandbox) {
      const appendSandbox = session.append as unknown as (
        type: 'sandbox/mode',
        data: { mode: PresetSpec['sandbox'] },
      ) => void
      appendSandbox.call(session, 'sandbox/mode', { mode: preset.sandbox })
    }
    if ((effectiveApprovalPolicy(session.events) ?? 'ask') !== preset.approval) {
      setApprovalPolicy(session, preset.approval)
    }
  })
  return { names, resolve, current, set }
}

class ReplyAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly providerName = 'Mock provider',
    private readonly models: readonly string[] = ['delivery-model'],
    private readonly inputModalities: NonNullable<LlmModelInfo['inputModalities']> = ['text'],
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.providerName }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.models.map(model => ({ provider, id: model, name: model, inputModalities: this.inputModalities }))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const effortIds = model === 'fast' ? ['low'] : model === 'precise' ? ['high'] : ['low', 'high']
    return { provider, id: model, name: model, inputModalities: this.inputModalities, reasoning: {
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
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function imageRef(id = 'delivery-image'): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(`memory:${id}`),
    mediaType: 'image/png',
    bytes: png.byteLength,
    width: 1,
    height: 1,
    name: 'photo.png',
  }
}

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
  toolCapableProviders: readonly string[] = ['mock', 'alternate'],
  presetToolMode: 'probe' | 'empty' = 'probe',
  image?: {
    attachments?: AttachmentStore
    inputModalities?: LlmModelInfo['inputModalities']
    readInboundImage: NonNullable<DeliveryAdapter['readInboundImage']>
  },
  permissions?: PermissionHarnessOptions,
) {
  const ctx = new Context()
  if (presetRoot !== undefined) await ctx.plugin(Loader)
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' }, tools: { mode: 'native' } })
  if (presetRoot === undefined && provideAgentPresets) {
    const presetResolve = vi.fn(async (id?: string) => ({ id: id ?? agentPreset }))
    const presetMount = vi.fn(async (agentCtx: Agent['ctx'], id?: string) => {
      if (presetToolMode === 'empty') {
        agentCtx.tools.restrict({ deny: agentCtx.tools.schemas().map(schema => schema.name) })
        return { id: id ?? agentPreset }
      }
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
  const permissionPresets = permissions === undefined || permissions.providePresets === false
    ? undefined
    : permissionPresetFixture(permissions)
  if (permissionPresets !== undefined) {
    ctx.provide('permissionPresets' as never, permissionPresets as never)
  }
  if (permissions !== undefined && permissions.provideApproval !== false) {
    ctx.provide('approval' as never, {
      config: { policy: 'ask' },
      setPolicy(agent: Agent, policy: 'ask' | 'never') {
        if ((effectiveApprovalPolicy(agent.session.events) ?? 'ask') !== policy) {
          setApprovalPolicy(agent.session, policy)
        }
      },
    } as never)
  }
  if (image?.attachments !== undefined) ctx.provide('attachments', image.attachments)
  await ctx.plugin(AssistantDeliveryService, { databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'),
    schedulerEnabled: false, defaultWorkspace: workspace, defaultAgentPreset: agentPreset, agentProvider: defaultRoute.provider,
    agentModel: defaultRoute.model, toolCapableProviders: [...toolCapableProviders],
    ...(permissions?.leaseMs === undefined ? {} : { leaseMs: permissions.leaseMs }) })
  const llm = new ReplyAdapter('Mock provider', ['delivery-model'], image?.inputModalities ?? ['text'])
  ctx.llm.registerAdapter(['mock'], llm)
  const alternate = new ReplyAdapter('Alternate provider', ['fast', 'precise'])
  ctx.llm.registerAdapter(['alternate'], alternate)
  await ctx.plugin(AgentLoop, { agents: [] })
  const sends: OutboundIntent[] = []
  const progresses: DeliveryProgressIntent[] = []
  const channel: DeliveryAdapter = { channel: 'lark', account: 'bot-1',
    capabilities: { reconcileUnknownSend: false, receipts: [], formats: channelFormats,
      ...(image === undefined ? {} : { inboundImages: true }) }, start: async () => {},
    ...(image === undefined ? {} : { readInboundImage: image.readInboundImage }),
    progress: async intent => { progresses.push(intent) },
    send: async intent => {
      sends.push(intent)
      return {
        outcome: 'accepted',
        providerMessageId: `om_${createHash('sha256').update(intent.idempotencyKey).digest('hex').slice(0, 32)}`,
      }
    } }
  await ctx.assistantDelivery.registerAdapter(channel)
  return { ctx, llm, alternate, permissionPresets, progresses, sends, service: ctx.assistantDelivery }
}

async function drive(service: AssistantDeliveryService): Promise<void> {
  await service.tick()
  await service.whenIdle()
  await service.tick()
  await service.whenIdle()
}

function runtimeStore(service: AssistantDeliveryService): {
  getActiveBinding(conversation: Readonly<ConversationBinding['conversation']>): ConversationBinding | undefined
  getPrincipal(principal: Readonly<ConversationBinding['principal']>): { id: string; version: number } | undefined
  getInbox(id: string): { status: string; failureCode?: string; leaseUntil?: number } | undefined
  markInboxDispatching(input: unknown): unknown
  renewInboxClaim(input: { inboxId: string; ownerId: string; fencingToken: number; leaseMs: number }): boolean
  revokePrincipal(id: string, expectedVersion: number): unknown
  rotateBinding(input: { bindingId: string; expectedVersion: number; sessionId: string }): ConversationBinding
} {
  return (service as unknown as { deliveryStore: ReturnType<typeof runtimeStore> }).deliveryStore
}

async function permissionRuntimeHarness(
  root: string,
  saved: Map<string, SavedSession>,
  permissions: PermissionHarnessOptions,
) {
  return await runtimeHarness(
    root,
    saved,
    undefined,
    undefined,
    root,
    undefined,
    'primary',
    true,
    ['mock', 'alternate'],
    'probe',
    undefined,
    permissions,
  )
}

function activeSessionEvents(service: AssistantDeliveryService, saved: Map<string, SavedSession>): readonly SessionEvent[] {
  const binding = runtimeStore(service).getActiveBinding(conversation)
  if (binding === undefined) throw new Error('active test binding is missing')
  const session = saved.get(binding.sessionId)
  if (session === undefined) throw new Error('active test session is missing')
  return session.events
}

function expectSafeAskPermission(
  permissionPresets: ReturnType<typeof permissionPresetFixture>,
  events: readonly SessionEvent[],
): void {
  expect(permissionPresets.current(events)).toBe('guarded-dynamic-id')
  expect(lastSandboxMode(events)).toBe('workspace-write')
  expect(effectiveApprovalPolicy(events) ?? 'ask').toBe('ask')
  expect(approvalReviewerOf(events)).toBe('user')
}

function attachmentFixture() {
  const saved = imageRef()
  const saveImages = vi.fn(async () => [saved] as const)
  const attachments = {
    imageLimits: {
      maxImageBytes: 1_024,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 4_096,
      maxImagePixels: 1_000_000,
      maxImageDimension: 1_000,
      mediaTypes: ['image/png'] as const,
    },
    saveImages,
    validateImage: vi.fn(async () => {}),
    saveImage: vi.fn(async () => saved),
    readImage: vi.fn(async () => ({ ref: saved, data: png })),
  } as unknown as AttachmentStore
  return { attachments, saveImages, saved }
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

  test.each(['principal', 'binding'] as const)(
    'rechecks the exact active %s after Agent idle before publishing a final reply or terminal progress',
    async revocation => {
      const root = await mkdtemp(join(tmpdir(), `assistant-delivery-idle-${revocation}-`))
      roots.push(root)
      const fixture = await runtimeHarness(root, new Map())
      const pairing = fixture.service.issuePairing('test', principal)
      fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
      const accepted = await fixture.service.acceptInbound(message(`evt-idle-${revocation}`, 'long task result'))
      const store = runtimeStore(fixture.service)
      const binding = store.getActiveBinding(conversation)!
      const owner = store.getPrincipal(principal)!
      let sawRunning = false
      let progressCountAtRevocation = -1
      fixture.ctx.on('agent/status', ({ status }) => {
        if (status === 'running') {
          sawRunning = true
          return
        }
        if (!sawRunning || progressCountAtRevocation >= 0) return
        progressCountAtRevocation = fixture.progresses.length
        if (revocation === 'principal') store.revokePrincipal(owner.id, owner.version)
        else store.rotateBinding({
          bindingId: binding.id,
          expectedVersion: binding.version,
          sessionId: `replacement-${binding.sessionId}`,
        })
      })

      await drive(fixture.service)

      expect(progressCountAtRevocation).toBeGreaterThanOrEqual(0)
      expect(fixture.progresses).toHaveLength(progressCountAtRevocation)
      expect(fixture.sends).toEqual([])
      expect(store.getInbox(accepted.inboxId)).toMatchObject({
        status: 'dead_letter',
        failureCode: 'processor-ambiguous',
      })
      await fixture.ctx.fiber.restart()
    },
  )

  test('rechecks full authorization immediately before every queued progress publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-progress-authorization-'))
    roots.push(root)
    const fixture = await runtimeHarness(root, new Map())
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    let progressCountAtRevocation = -1
    fixture.ctx.on('session/event', (_session, event) => {
      if (event.type !== 'step/start' || progressCountAtRevocation >= 0) return
      progressCountAtRevocation = fixture.progresses.length
      fixture.ctx.assistantPolicy.setEmergencyStop({
        enabled: true,
        actor: 'test',
        reason: 'revoke progress publication during the active turn',
      })
    })
    const accepted = await fixture.service.acceptInbound(message('evt-progress-revoked', 'long task'))

    await drive(fixture.service)

    expect(progressCountAtRevocation).toBeGreaterThanOrEqual(0)
    expect(fixture.progresses).toHaveLength(progressCountAtRevocation)
    expect(fixture.sends).toEqual([])
    expect(runtimeStore(fixture.service).getInbox(accepted.inboxId)).toMatchObject({
      status: 'dead_letter',
      failureCode: 'processor-ambiguous',
    })
    await fixture.ctx.fiber.restart()
  })

  test('retries an authorization callback failure before dispatch without marking or following up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-authorization-check-failed-'))
    roots.push(root)
    const fixture = await runtimeHarness(root, new Map())
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    const accepted = await fixture.service.acceptInbound(message('evt-authorization-check-failed', 'do not dispatch'))
    const store = runtimeStore(fixture.service)
    const markDispatching = vi.spyOn(store, 'markInboxDispatching')
    vi.spyOn(fixture.ctx.assistantPolicy, 'evaluate').mockImplementation(() => {
      throw new Error('authorization store unavailable')
    })

    await drive(fixture.service)

    expect(markDispatching).not.toHaveBeenCalled()
    expect(fixture.llm.requests).toEqual([])
    expect(fixture.progresses).toEqual([])
    expect(fixture.sends).toEqual([])
    expect(store.getInbox(accepted.inboxId)).toMatchObject({
      status: 'retry_wait',
      failureCode: 'inbound-authorization-check-failed',
    })
    await fixture.ctx.fiber.restart()
  })

  test('materializes a pure Lark image into an ImageBlock and resumes it without provider re-download', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-image-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const attachment = attachmentFixture()
    const readInboundImage = vi.fn(async () => ({
      outcome: 'downloaded' as const,
      data: png,
      mediaType: 'image/png' as const,
    }))
    const imageOptions = {
      attachments: attachment.attachments,
      inputModalities: ['text', 'image'] as const,
      readInboundImage,
    }
    const first = await runtimeHarness(
      root, saved, undefined, undefined, root, undefined, 'primary', true,
      ['mock', 'alternate'], 'probe', imageOptions,
    )
    const pairing = first.service.issuePairing('test', principal)
    first.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    const inbound: InboundEnvelope = {
      ...message('evt-image', ''),
      attachments: [{ resourceType: 'image', providerRef: 'img_private_do_not_prompt', fileName: 'photo.png' }],
    }

    await first.service.acceptInbound(inbound)
    await drive(first.service)

    expect(readInboundImage).toHaveBeenCalledOnce()
    expect(readInboundImage).toHaveBeenCalledWith({
      eventId: 'evt-image',
      attachment: inbound.attachments![0],
      maxBytes: 1_024,
    }, expect.any(AbortSignal))
    expect(attachment.saveImages).toHaveBeenCalledOnce()
    expect(attachment.saveImages).toHaveBeenCalledWith([
      { data: png, mediaType: 'image/png', name: 'photo.png' },
    ])
    const imageMessage = first.llm.requests[0]?.messages.at(-1)
    expect(imageMessage?.content).toEqual([{ type: 'image', attachment: attachment.saved }])
    expect(JSON.stringify(first.llm.requests[0])).not.toContain('img_private_do_not_prompt')
    expect(JSON.stringify([...saved.values()])).not.toContain('img_private_do_not_prompt')
    expect(JSON.stringify([...saved.values()])).toContain(String(attachment.saved.attachmentId))
    await first.ctx.fiber.restart()

    const restarted = await runtimeHarness(
      root, saved, undefined, undefined, root, undefined, 'primary', true,
      ['mock', 'alternate'], 'probe', imageOptions,
    )
    await restarted.service.acceptInbound(message('evt-image-followup', 'what was in that image?'))
    await drive(restarted.service)

    expect(readInboundImage).toHaveBeenCalledOnce()
    expect(JSON.stringify(restarted.llm.requests[0]?.messages)).toContain(String(attachment.saved.attachmentId))
    expect(JSON.stringify(restarted.llm.requests[0]?.messages)).not.toContain('img_private_do_not_prompt')

    await restarted.service.acceptInbound(message('evt-image-switch', '/model use alternate/fast', 'command'))
    await drive(restarted.service)
    expect(restarted.sends.at(-1)?.text).toContain('已切换到 alternate/fast')
    await restarted.service.acceptInbound(message('evt-image-after-switch', 'continue with the old image'))
    await drive(restarted.service)
    expect(restarted.alternate.requests).toHaveLength(0)
    expect(restarted.sends.at(-1)?.text).toContain('不支持图片输入')
    await restarted.ctx.fiber.restart()
  })

  test('rejects image input before download for text-only models and skips image I/O for commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-image-text-only-'))
    roots.push(root)
    const attachment = attachmentFixture()
    const readInboundImage = vi.fn(async () => ({
      outcome: 'downloaded' as const,
      data: png,
      mediaType: 'image/png' as const,
    }))
    const fixture = await runtimeHarness(
      root, new Map(), undefined, undefined, root, undefined, 'primary', true,
      ['mock', 'alternate'], 'probe', {
        attachments: attachment.attachments,
        inputModalities: ['text'],
        readInboundImage,
      },
    )
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    await fixture.service.acceptInbound({
      ...message('evt-image-text-only', ''),
      attachments: [{ resourceType: 'image', providerRef: 'img_text_only' }],
    })
    await drive(fixture.service)
    expect(readInboundImage).not.toHaveBeenCalled()
    expect(attachment.saveImages).not.toHaveBeenCalled()
    expect(fixture.llm.requests).toHaveLength(0)
    expect(fixture.sends.at(-1)?.text).toContain('不支持图片输入')
    expect(fixture.sends.at(-1)?.text).toContain('/model')

    await fixture.service.acceptInbound({
      ...message('evt-image-command', '/model', 'command'),
      attachments: [{ resourceType: 'image', providerRef: 'img_command' }],
    })
    await drive(fixture.service)
    expect(readInboundImage).not.toHaveBeenCalled()
    expect(attachment.saveImages).not.toHaveBeenCalled()
    await fixture.ctx.fiber.restart()
  })

  test('retries without downloading when no AttachmentStore is installed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-image-no-store-'))
    roots.push(root)
    const readInboundImage = vi.fn(async () => ({
      outcome: 'downloaded' as const,
      data: png,
      mediaType: 'image/png' as const,
    }))
    const fixture = await runtimeHarness(
      root, new Map(), undefined, undefined, root, undefined, 'primary', true,
      ['mock', 'alternate'], 'probe', {
        inputModalities: ['text', 'image'],
        readInboundImage,
      },
    )
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    const inbound = {
      ...message('evt-image-no-store', ''),
      attachments: [{ resourceType: 'image' as const, providerRef: 'img_no_store' }],
    }

    await fixture.service.acceptInbound(inbound)
    await drive(fixture.service)

    expect(readInboundImage).not.toHaveBeenCalled()
    expect(fixture.llm.requests).toHaveLength(0)
    await expect(fixture.service.acceptInbound(inbound)).resolves.toMatchObject({
      duplicate: true,
      status: 'retry_wait',
    })
    await fixture.ctx.fiber.restart()
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

  test('rejects a text-only coding subscription before provider execution but keeps session creation durable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-text-only-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await runtimeHarness(root, saved, {
      provider: 'codex-subscription', model: 'default',
    }, undefined, root, undefined, 'primary', true, ['codex-subscription'])
    const codex = new ReplyAdapter('Codex subscription')
    fixture.ctx.llm.registerAdapter(['codex-subscription'], codex)
    registerLlmRouteCapability(fixture.ctx.llm, {
      provider: 'codex-subscription', toolCalls: 'none',
    })
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    const inbound = message('evt-codex-tools', 'use the preset tool')
    await fixture.service.acceptInbound(inbound)
    expect(saved.size).toBe(1)
    await drive(fixture.service)

    expect(codex.requests).toHaveLength(0)
    expect(fixture.sends.at(-1)?.text).toContain('codex-subscription/default')
    expect(fixture.sends.at(-1)?.text).toContain('primary')
    expect(fixture.sends.at(-1)?.text).toContain('/model')
    await expect(fixture.service.acceptInbound(inbound))
      .resolves.toMatchObject({ duplicate: true, status: 'processed' })
    await fixture.ctx.fiber.restart()
  })

  test('accepts a TraeX bridge declaration for a tool-bearing preset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-traex-bridge-'))
    roots.push(root)
    const fixture = await runtimeHarness(root, new Map(), {
      provider: 'traex-agent', model: 'default',
    }, undefined, root, undefined, 'primary', true, [])
    const trae = new ReplyAdapter('TraeX bridge')
    fixture.ctx.llm.registerAdapter(['traex-agent'], trae)
    registerLlmRouteCapability(fixture.ctx.llm, { provider: 'traex-agent', toolCalls: 'bridge' })
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    await fixture.service.acceptInbound(message('evt-traex-tools', 'hello'))
    await drive(fixture.service)

    expect(trae.requests).toHaveLength(1)
    expect(trae.requests[0]?.tools?.map(tool => tool.name)).toContain('preset_probe')
    await fixture.ctx.fiber.restart()
  })

  test('fails closed for an undeclared provider when the mounted preset has tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-unknown-tools-'))
    roots.push(root)
    const fixture = await runtimeHarness(root, new Map(), {
      provider: 'unknown-route', model: 'model',
    }, undefined, root, undefined, 'primary', true, [])
    const unknown = new ReplyAdapter('Unknown route')
    fixture.ctx.llm.registerAdapter(['unknown-route'], unknown)
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    await fixture.service.acceptInbound(message('evt-unknown-tools', 'hello'))
    await drive(fixture.service)

    expect(unknown.requests).toHaveLength(0)
    expect(fixture.sends.at(-1)?.text).toContain('unknown-route/model')
    await fixture.ctx.fiber.restart()
  })

  test('allows an undeclared provider when the final Agent scope exposes no tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-empty-tools-'))
    roots.push(root)
    const fixture = await runtimeHarness(root, new Map(), {
      provider: 'unknown-route', model: 'model',
    }, undefined, root, undefined, 'primary', true, [], 'empty')
    const unknown = new ReplyAdapter('Unknown route')
    fixture.ctx.llm.registerAdapter(['unknown-route'], unknown)
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    await fixture.service.acceptInbound(message('evt-empty-tools', 'hello'))
    await drive(fixture.service)

    expect(unknown.requests).toHaveLength(1)
    expect(unknown.requests[0]?.tools ?? []).toEqual([])
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

  test('/permissions reports all three levels and folds an auto reviewer after restart without an Agent turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permissions-fold-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const first = await permissionRuntimeHarness(root, saved, {})
    const pairing = first.service.issuePairing('test', principal)
    first.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    await first.service.acceptInbound(message('evt-permissions-show', '/permissions', 'command'))
    await drive(first.service)
    expect(first.llm.requests).toHaveLength(0)
    expect(first.alternate.requests).toHaveLength(0)
    expect(first.sends.at(-1)?.text).toContain('当前权限：请求批准（ask）')
    expect(first.sends.at(-1)?.text).toContain('请求批准（ask）')
    expect(first.sends.at(-1)?.text).toContain('帮我批准（auto）')
    expect(first.sends.at(-1)?.text).toContain('完全访问权限（full）')

    const bindingBefore = runtimeStore(first.service).getActiveBinding(conversation)!
    await first.service.acceptInbound(message('evt-permission-auto', '/permission auto', 'command'))
    await drive(first.service)
    const events = activeSessionEvents(first.service, saved)
    expect(approvalReviewerOf(events)).toBe('auto-review')
    expect(runtimeStore(first.service).getActiveBinding(conversation)?.sessionId).toBe(bindingBefore.sessionId)
    expect([...saved.keys()]).toEqual([bindingBefore.sessionId])
    expect(first.sends.at(-1)?.text).toContain('已切换到 帮我批准（auto）')
    expect(first.llm.requests).toHaveLength(0)
    await first.ctx.fiber.restart()

    const restarted = await permissionRuntimeHarness(root, saved, {})
    await restarted.service.acceptInbound(message('evt-permissions-restart', '/permission', 'command'))
    await drive(restarted.service)
    expect(restarted.sends.at(-1)?.text).toContain('当前权限：帮我批准（auto）')
    expect(restarted.llm.requests).toHaveLength(0)
    await restarted.ctx.fiber.restart()
  })

  test('/permission full requires confirmation and persists crash-safe upgrade and downgrade event order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permissions-full-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await permissionRuntimeHarness(root, saved, {})
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    await fixture.service.acceptInbound(message('evt-permission-full-warning', '/permission full', 'command'))
    await drive(fixture.service)
    const beforeConfirm = activeSessionEvents(fixture.service, saved)
    expect(fixture.sends.at(-1)?.text).toContain('🟠')
    expect(fixture.sends.at(-1)?.text).toContain('danger-full-access')
    expect(fixture.sends.at(-1)?.text).toContain('任意文件')
    expect(fixture.sends.at(-1)?.text).toContain('网络')
    expect(fixture.sends.at(-1)?.text).toContain('/permission full confirm')
    expect(fixture.llm.requests).toHaveLength(0)

    await fixture.service.acceptInbound(message('evt-permission-full-confirm', '/permissions full confirm', 'command'))
    await drive(fixture.service)
    const upgraded = activeSessionEvents(fixture.service, saved)
    const upgradeEvents = upgraded.slice(beforeConfirm.length)
    const reviewerNone = upgradeEvents.findIndex(event => event.type === 'assistant-policy/approval-reviewer'
      && event.data.reviewer === 'none')
    const approvalNever = upgradeEvents.findIndex(event => event.type === 'approval/policy'
      && event.data.policy === 'never')
    const sandboxDanger = upgradeEvents.findIndex(event => sandboxModeOf(event) === 'danger-full-access')
    expect(reviewerNone).toBeGreaterThanOrEqual(0)
    expect(approvalNever).toBeGreaterThan(reviewerNone)
    expect(sandboxDanger).toBeGreaterThan(approvalNever)
    expect(lastPermissionPreset(upgraded)).toBe('unlocked-dynamic-id')
    expect(approvalReviewerOf(upgraded)).toBe('none')
    expect(fixture.sends.at(-1)?.text).toContain('已切换到 完全访问权限（full）')

    const beforeDowngrade = upgraded.length
    await fixture.service.acceptInbound(message('evt-permission-ask', '/permission ask', 'command'))
    await drive(fixture.service)
    const downgraded = activeSessionEvents(fixture.service, saved)
    const downgradeEvents = downgraded.slice(beforeDowngrade)
    const sandboxWorkspace = downgradeEvents.findIndex(event => sandboxModeOf(event) === 'workspace-write')
    const reviewerUser = downgradeEvents.findIndex(event => event.type === 'assistant-policy/approval-reviewer'
      && event.data.reviewer === 'user')
    expect(sandboxWorkspace).toBeGreaterThanOrEqual(0)
    expect(reviewerUser).toBeGreaterThan(sandboxWorkspace)
    expect(lastPermissionPreset(downgraded)).toBe('guarded-dynamic-id')
    expect(approvalReviewerOf(downgraded)).toBe('user')
    expect(fixture.llm.requests).toHaveLength(0)
    await fixture.ctx.fiber.restart()
  })

  test('/permission fences a held flush so lease loss cannot retry full ahead of a later ask', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permissions-lease-fence-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await permissionRuntimeHarness(root, saved, { leaseMs: 1_000 })
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    await fixture.service.acceptInbound(message('evt-permission-lease-seed', '/permission full', 'command'))
    await drive(fixture.service)

    const sessions = fixture.ctx.sessions
    const originalFlush = sessions.flush.bind(sessions)
    let releaseFlush!: () => void
    let markFlushStarted!: () => void
    const flushGate = new Promise<void>(resolve => { releaseFlush = resolve })
    const flushStarted = new Promise<void>(resolve => { markFlushStarted = resolve })
    const flush = vi.spyOn(sessions, 'flush').mockImplementationOnce(async session => {
      markFlushStarted()
      await flushGate
      return await originalFlush(session)
    })
    const store = runtimeStore(fixture.service)
    const renew = vi.spyOn(store, 'renewInboxClaim').mockReturnValue(false)
    const full = await fixture.service.acceptInbound(
      message('evt-permission-lease-full', '/permission full confirm', 'command'),
    )

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      await fixture.service.tick()
      await flushStarted
      expect(store.getInbox(full.inboxId)).toMatchObject({
        status: 'claimed',
        failureCode: 'dispatch-started',
      })

      await vi.advanceTimersByTimeAsync(334)
      expect(renew).toHaveBeenCalled()
      const ask = await fixture.service.acceptInbound(
        message('evt-permission-lease-ask', '/permission ask', 'command'),
      )
      releaseFlush()
      await fixture.service.whenIdle()

      const leaseUntil = store.getInbox(full.inboxId)?.leaseUntil
      if (leaseUntil === undefined) throw new Error('held permission inbox is missing its lease deadline')
      vi.useRealTimers()
      await new Promise(resolve => setTimeout(resolve, Math.max(1, leaseUntil - Date.now() + 5)))
      await fixture.service.tick()
      await fixture.service.whenIdle()
      expect(store.getInbox(full.inboxId)).toMatchObject({
        status: 'dead_letter',
        failureCode: 'dispatch-ambiguous',
      })
      expect(store.getInbox(ask.inboxId)).toMatchObject({ status: 'processed' })
      expectSafeAskPermission(fixture.permissionPresets!, activeSessionEvents(fixture.service, saved))
    } finally {
      releaseFlush()
      vi.useRealTimers()
      renew.mockRestore()
      flush.mockRestore()
      await fixture.ctx.fiber.restart()
    }
  })

  test('/permission compensates full to ask in memory when both the mutation and compensation flush return false', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permissions-flush-false-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await permissionRuntimeHarness(root, saved, {})
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    await fixture.service.acceptInbound(message('evt-permission-flush-seed', '/permission full', 'command'))
    await drive(fixture.service)
    const binding = runtimeStore(fixture.service).getActiveBinding(conversation)!
    const persistedBefore = saved.get(binding.sessionId)!.events
    const logsAtFlush: SessionEvent[][] = []
    const flush = vi.spyOn(fixture.ctx.sessions, 'flush')
      .mockImplementationOnce(async session => {
        logsAtFlush.push([...session.events])
        return false
      })
      .mockImplementationOnce(async session => {
        logsAtFlush.push([...session.events])
        return false
      })
    const accepted = await fixture.service.acceptInbound(
      message('evt-permission-flush-false', '/permission full confirm', 'command'),
    )
    await drive(fixture.service)

    const transition = logsAtFlush[0]!.slice(persistedBefore.length).filter(event => [
      'assistant-policy/approval-reviewer',
      'approval/policy',
      'permission/preset',
      'sandbox/mode',
    ].includes(event.type))
    expect(transition.map(event => event.type)).toEqual([
      'assistant-policy/approval-reviewer',
      'approval/policy',
      'permission/preset',
      'sandbox/mode',
    ])
    expect(transition[0]?.data).toEqual({ reviewer: 'none' })
    expect(transition[1]?.data).toEqual({ policy: 'never' })
    expect(transition[3]?.data).toEqual({ mode: 'danger-full-access' })
    expect(flush).toHaveBeenCalledTimes(2)
    expectSafeAskPermission(fixture.permissionPresets!, logsAtFlush[1]!)
    expect(fixture.sends).toHaveLength(1)
    expect(fixture.sends[0]?.text).toContain('🟠')
    expect(runtimeStore(fixture.service).getInbox(accepted.inboxId)).toMatchObject({
      status: 'dead_letter',
      failureCode: 'processor-ambiguous',
    })
    expect(saved.get(binding.sessionId)?.events).toEqual(persistedBefore)
    flush.mockRestore()
    await fixture.ctx.fiber.restart()
  })

  test('/permission compensates full to ask in memory when both durability flush attempts throw', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permissions-flush-throw-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await permissionRuntimeHarness(root, saved, {})
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    await fixture.service.acceptInbound(message('evt-permission-throw-seed', '/permission full', 'command'))
    await drive(fixture.service)

    const logsAtFlush: SessionEvent[][] = []
    const flush = vi.spyOn(fixture.ctx.sessions, 'flush')
      .mockImplementationOnce(async session => {
        logsAtFlush.push([...session.events])
        throw new Error('primary durability unavailable')
      })
      .mockImplementationOnce(async session => {
        logsAtFlush.push([...session.events])
        throw new Error('compensation durability unavailable')
      })
    const accepted = await fixture.service.acceptInbound(
      message('evt-permission-flush-throw', '/permission full confirm', 'command'),
    )
    await drive(fixture.service)
    flush.mockRestore()

    expect(logsAtFlush).toHaveLength(2)
    expect(lastSandboxMode(logsAtFlush[0]!)).toBe('danger-full-access')
    expectSafeAskPermission(fixture.permissionPresets!, logsAtFlush[1]!)
    expect(fixture.sends).toHaveLength(1)
    expect(runtimeStore(fixture.service).getInbox(accepted.inboxId)).toMatchObject({
      status: 'dead_letter',
      failureCode: 'processor-ambiguous',
    })
    await fixture.ctx.fiber.restart()
  })

  test('/permission compensates to ask when the full preset mutation throws after appending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permissions-mutation-throw-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await permissionRuntimeHarness(root, saved, {})
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    await fixture.service.acceptInbound(message('evt-permission-mutation-seed', '/permission full', 'command'))
    await drive(fixture.service)

    const setPreset = fixture.permissionPresets!.set
    const setPresetNormally = setPreset.getMockImplementation()
    if (setPresetNormally === undefined) throw new Error('permission preset test setter is missing')
    setPreset.mockImplementationOnce((session, name) => {
      setPresetNormally(session, name)
      throw new Error('preset observer failed after append')
    })
    const accepted = await fixture.service.acceptInbound(
      message('evt-permission-mutation-throw', '/permission full confirm', 'command'),
    )
    await drive(fixture.service)

    expect(setPreset.mock.calls.map(([, name]) => name)).toEqual([
      'unlocked-dynamic-id',
      'guarded-dynamic-id',
    ])
    expectSafeAskPermission(fixture.permissionPresets!, activeSessionEvents(fixture.service, saved))
    expect(fixture.sends).toHaveLength(1)
    expect(runtimeStore(fixture.service).getInbox(accepted.inboxId)).toMatchObject({
      status: 'dead_letter',
      failureCode: 'processor-ambiguous',
    })
    await fixture.ctx.fiber.restart()
  })

  test('/permission compensates a failed auto downgrade to ask before its second best-effort flush', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permissions-auto-compensate-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await permissionRuntimeHarness(root, saved, {})
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    await fixture.service.acceptInbound(message('evt-permission-auto-full', '/permission full confirm', 'command'))
    await drive(fixture.service)
    expect(approvalReviewerOf(activeSessionEvents(fixture.service, saved))).toBe('none')
    const sentBeforeDowngrade = fixture.sends.length

    const logsAtFlush: SessionEvent[][] = []
    const flush = vi.spyOn(fixture.ctx.sessions, 'flush')
      .mockImplementationOnce(async session => {
        logsAtFlush.push([...session.events])
        return false
      })
      .mockImplementationOnce(async session => {
        logsAtFlush.push([...session.events])
        return false
      })
    const accepted = await fixture.service.acceptInbound(
      message('evt-permission-auto-failed', '/permission auto', 'command'),
    )
    await drive(fixture.service)
    flush.mockRestore()

    expect(logsAtFlush).toHaveLength(2)
    expect(approvalReviewerOf(logsAtFlush[0]!)).toBe('auto-review')
    expectSafeAskPermission(fixture.permissionPresets!, logsAtFlush[1]!)
    expect(fixture.sends).toHaveLength(sentBeforeDowngrade)
    expect(runtimeStore(fixture.service).getInbox(accepted.inboxId)).toMatchObject({
      status: 'dead_letter',
      failureCode: 'processor-ambiguous',
    })
    await fixture.ctx.fiber.restart()
  })

  test('/permission rejects invalid input and fails closed when a required service or bundle is missing', async () => {
    const invalidRoot = await mkdtemp(join(tmpdir(), 'assistant-delivery-permissions-invalid-'))
    roots.push(invalidRoot)
    const invalidSaved = new Map<string, SavedSession>()
    const invalid = await permissionRuntimeHarness(invalidRoot, invalidSaved, {})
    const invalidPairing = invalid.service.issuePairing('test', principal)
    invalid.service.confirmPairing({ challengeId: invalidPairing.challenge.id, principal, code: invalidPairing.code })
    await invalid.service.acceptInbound(message('evt-permission-invalid', '/permissions full now', 'command'))
    await drive(invalid.service)
    expect(invalid.sends.at(-1)?.text).toContain('用法：/permission')
    expect(invalid.llm.requests).toHaveLength(0)
    expect(activeSessionEvents(invalid.service, invalidSaved)
      .filter(event => event.type === 'assistant-policy/approval-reviewer')).toEqual([])
    await invalid.ctx.fiber.restart()

    const noServiceRoot = await mkdtemp(join(tmpdir(), 'assistant-delivery-permissions-no-service-'))
    roots.push(noServiceRoot)
    const noServiceSaved = new Map<string, SavedSession>()
    const noService = await permissionRuntimeHarness(noServiceRoot, noServiceSaved, { providePresets: false })
    const noServicePairing = noService.service.issuePairing('test', principal)
    noService.service.confirmPairing({ challengeId: noServicePairing.challenge.id,
      principal, code: noServicePairing.code })
    await noService.service.acceptInbound(message('evt-permission-no-service', '/permission auto', 'command'))
    await drive(noService.service)
    expect(noService.sends.at(-1)?.text).toContain('权限服务不可用')
    expect(noService.llm.requests).toHaveLength(0)
    await noService.ctx.fiber.restart()

    const noBundleRoot = await mkdtemp(join(tmpdir(), 'assistant-delivery-permissions-no-bundle-'))
    roots.push(noBundleRoot)
    const noBundleSaved = new Map<string, SavedSession>()
    const noBundle = await permissionRuntimeHarness(noBundleRoot, noBundleSaved, {
      presets: { 'only-safe-dynamic': testPermissionPresets['guarded-dynamic-id'] },
    })
    const noBundlePairing = noBundle.service.issuePairing('test', principal)
    noBundle.service.confirmPairing({ challengeId: noBundlePairing.challenge.id,
      principal, code: noBundlePairing.code })
    await noBundle.service.acceptInbound(message('evt-permission-no-bundle', '/permission full confirm', 'command'))
    await drive(noBundle.service)
    expect(noBundle.sends.at(-1)?.text).toContain('缺少 danger-full-access + never')
    expect(activeSessionEvents(noBundle.service, noBundleSaved)
      .filter(event => event.type === 'assistant-policy/approval-reviewer')).toEqual([])
    await noBundle.ctx.fiber.restart()

    const noApprovalRoot = await mkdtemp(join(tmpdir(), 'assistant-delivery-permissions-no-approval-'))
    roots.push(noApprovalRoot)
    const noApprovalSaved = new Map<string, SavedSession>()
    const noApproval = await permissionRuntimeHarness(noApprovalRoot, noApprovalSaved, { provideApproval: false })
    const noApprovalPairing = noApproval.service.issuePairing('test', principal)
    noApproval.service.confirmPairing({ challengeId: noApprovalPairing.challenge.id,
      principal, code: noApprovalPairing.code })
    await noApproval.service.acceptInbound(message('evt-permission-no-approval', '/permission full confirm', 'command'))
    await drive(noApproval.service)
    expect(noApproval.sends.at(-1)?.text).toContain('权限服务不可用')
    expect(activeSessionEvents(noApproval.service, noApprovalSaved)
      .filter(event => event.type === 'assistant-policy/approval-reviewer')).toEqual([])
    await noApproval.ctx.fiber.restart()
  })

  test('/permission rechecks the exact owner after bundle resolution and writes nothing after revocation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permissions-revoked-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    let revokeOnResolve = false
    let revoked = false
    let fixture!: Awaited<ReturnType<typeof permissionRuntimeHarness>>
    const permissions: PermissionHarnessOptions = { onResolve: () => {
      if (!revokeOnResolve || revoked) return
      const store = runtimeStore(fixture.service)
      const owner = store.getPrincipal(principal)!
      store.revokePrincipal(owner.id, owner.version)
      revoked = true
    } }
    fixture = await permissionRuntimeHarness(root, saved, permissions)
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    const accepted = await fixture.service.acceptInbound(message('evt-permission-revoked', '/permission auto', 'command'))
    const sessionId = runtimeStore(fixture.service).getActiveBinding(conversation)!.sessionId
    revokeOnResolve = true
    await drive(fixture.service)

    expect(revoked).toBe(true)
    expect(fixture.sends).toEqual([])
    expect(fixture.llm.requests).toHaveLength(0)
    expect(saved.get(sessionId)?.events
      .filter(event => event.type === 'assistant-policy/approval-reviewer')).toEqual([])
    expect(runtimeStore(fixture.service).getInbox(accepted.inboxId)).toMatchObject({
      status: 'dead_letter',
      failureCode: 'permission-authorization-revoked',
    })
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
