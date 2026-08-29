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
  KNOWN_SESSION_EVENT_TYPES,
  SessionPreparation,
  type Session,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { effectiveApprovalPolicy, setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { approvalReviewerOf, AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { registerLlmRouteCapability } from '@dsh-enhanced/llm-route-capabilities'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { deliveryProgressFromSessionEvent, modelPickerOperationId } from '../src/agent-runtime.ts'
import { AssistantDeliveryService } from '../src/service.ts'
import { DeliveryStore } from '../src/store.ts'
import type {
  ConversationBinding, ConversationModelSelection, ConversationRef, DeliveryAdapter, DeliveryProgressIntent,
  InboundEnvelope, ModelRouteRef, OutboundFormat, OutboundIntent,
} from '../src/types.ts'

const roots: string[] = []
const PRESET_TOOLS = ['bash', 'read', 'grep', 'glob'] as const
const require = createRequire(import.meta.url)

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

interface DurableStoredSession {
  events: SessionEvent[]
  meta: SessionHeader
  revision: string
}

interface PersistenceBackend {
  readonly name: string
  appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void>
  commitRepair(meta: SessionHeader, tornMarker: undefined, closers: readonly SessionEvent[]): Promise<void>
  list(): Promise<SessionHeader[]>
  loadStored(id: SessionId): Promise<DurableStoredSession | undefined>
  readStoredRevision(id: SessionId): Promise<string | undefined>
}

interface PersistenceCoordinator {
  assertEventsSupported(meta: SessionHeader, events: readonly SessionEvent[]): void
  prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation>
}

type PersistenceCoordinatorConstructor = new (
  ctx: Context,
  backend: PersistenceBackend,
  options: { preparedSessionCacheSize: number; writeBatchMaxDelayMs: number },
) => PersistenceCoordinator

async function persistenceCoordinatorConstructor(): Promise<PersistenceCoordinatorConstructor> {
  const loopPackage = require.resolve('@deepseek-ai/dsh-agent-loop/package.json')
  const entrypoint = require.resolve('@deepseek-ai/dsh-session-persistence', {
    paths: [dirname(loopPackage)],
  })
  const module = await import(pathToFileURL(entrypoint).href) as {
    PersistenceCoordinator: PersistenceCoordinatorConstructor
  }
  return module.PersistenceCoordinator
}

function persistenceBackend(stored: Map<string, DurableStoredSession>): PersistenceBackend {
  let revision = 0
  const snapshot = (value: DurableStoredSession): DurableStoredSession => structuredClone(value)
  return {
    name: 'assistant-delivery-session-adoption-test',
    async appendBatch(meta, events, isMaterialized) {
      const current = stored.get(String(meta.id))
      revision += 1
      if (!isMaterialized || current === undefined) {
        stored.set(String(meta.id), snapshot({ meta, events: [...events], revision: `test:${revision}` }))
        return
      }
      current.events.push(...structuredClone(events))
      current.revision = `test:${revision}`
    },
    async commitRepair(meta, _tornMarker, closers) {
      const current = stored.get(String(meta.id))
      if (current === undefined) throw new Error(`missing stored session ${meta.id}`)
      revision += 1
      current.events.push(...structuredClone(closers))
      current.revision = `test:${revision}`
    },
    async list() {
      return [...stored.values()].map(value => structuredClone(value.meta))
    },
    async loadStored(id) {
      const current = stored.get(String(id))
      return current === undefined ? undefined : snapshot(current)
    },
    async readStoredRevision(id) {
      return stored.get(String(id))?.revision
    },
  }
}

function realPersistence(
  PersistenceCoordinator: PersistenceCoordinatorConstructor,
  stored: Map<string, DurableStoredSession>,
): (ctx: Context) => unknown {
  return ctx => {
    const backend = persistenceBackend(stored)
    const coordinator = new PersistenceCoordinator(ctx, backend, {
      preparedSessionCacheSize: 1,
      writeBatchMaxDelayMs: 1,
    })
    return {
      coordinator,
      list: () => backend.list(),
      prepare: (id: SessionId, signal?: AbortSignal) => coordinator.prepare(id, signal),
    }
  }
}

interface PermissionHarnessOptions {
  providePresets?: boolean
  provideApproval?: boolean
  allowAgentReply?: boolean
  presets?: Record<string, PresetSpec>
  seedDefaultPreset?: string
  onResolve?(): void
  leaseMs?: number
  replyBudget?: number
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

const distinctDynamicPermissionPresets = {
  'ask-dynamic-id': {
    sandbox: 'workspace-write',
    approval: 'ask',
    name: 'Ask dynamically',
  },
  'auto-dynamic-id': {
    sandbox: 'workspace-write',
    approval: 'ask',
    name: 'Auto dynamically',
  },
  'full-dynamic-id': {
    sandbox: 'danger-full-access',
    approval: 'never',
    name: 'Full dynamically',
  },
} as const satisfies Record<string, PresetSpec>

const canonicalPermissionPresets = {
  'workspace-write': {
    sandbox: 'workspace-write',
    approval: 'ask',
    name: 'Ask',
  },
  auto: {
    sandbox: 'workspace-write',
    approval: 'ask',
    name: 'Auto',
  },
  'danger-full-access': {
    sandbox: 'danger-full-access',
    approval: 'never',
    name: 'Full',
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

function replyProviderMessageId(service: AssistantDeliveryService, eventId: string): string {
  const inbox = runtimeStore(service).getInboxByProviderEvent('lark', 'bot-1', eventId)
  if (inbox === undefined) throw new Error(`reply fixture Inbox is missing: ${eventId}`)
  return `om_${createHash('sha256').update(`inbound:${inbox.id}:reply`).digest('hex').slice(0, 32)}`
}

function leavePermissionDispatchClaimedAfterDurableFlush(databasePath: string, eventId: string): void {
  const database = new DatabaseSync(databasePath)
  try {
    const inbox = database.prepare(`
      SELECT id FROM inbox_messages WHERE channel = 'lark' AND account = 'bot-1' AND event_id = ?
    `).get(eventId) as { id: string } | undefined
    if (inbox === undefined) throw new Error('permission crash fixture Inbox is missing')
    const outbox = database.prepare('SELECT id FROM outbox_messages WHERE idempotency_key = ?')
      .get(`inbound:${inbox.id}:reply`) as { id: string } | undefined
    if (outbox !== undefined) {
      database.prepare('DELETE FROM outbox_attempts WHERE outbox_id = ?').run(outbox.id)
      database.prepare('DELETE FROM outbox_messages WHERE id = ?').run(outbox.id)
    }
    const changed = database.prepare(`
      UPDATE inbox_messages SET status = 'claimed', claimed_by = 'crashed-host',
        fencing_token = attempt_count, lease_until = 1, next_attempt_at = NULL,
        failure_code = 'dispatch-started', updated_at = 1
      WHERE event_id = ? AND status = 'processed'
    `).run(eventId)
    if (changed.changes !== 1) throw new Error('permission crash fixture Inbox was not processed')
  } finally {
    database.close()
  }
}

async function runtimeHarness(
  root: string,
  saved: Map<string, SavedSession>,
  defaultRoute = { provider: 'mock', model: 'delivery-model' },
  channelFormats: readonly OutboundFormat[] = ['plain', 'model-picker', 'permission-picker'],
  workspace = root,
  presetRoot?: string,
  agentPreset = 'primary',
  provideAgentPresets = true,
  presetToolMode: 'probe' | 'empty' = 'probe',
  image?: {
    attachments?: AttachmentStore
    inputModalities?: LlmModelInfo['inputModalities']
    readInboundImage: NonNullable<DeliveryAdapter['readInboundImage']>
  },
  permissions?: PermissionHarnessOptions,
  sessionPersistence?: (ctx: Context) => unknown,
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
  const fallbackPersistence = {
    coordinator: {
      assertEventsSupported(_meta: SessionHeader, events: readonly SessionEvent[]) {
        for (const event of events) {
          if (KNOWN_SESSION_EVENT_TYPES.has(event.type) || event.ignorable === true) continue
          throw new Error(`unknown required session event type: ${event.type}`)
        }
      },
    },
    list: async () => [...saved.values()].map(value => structuredClone(value.header)),
    prepare: async (id: SessionId) => {
      const value = saved.get(String(id))
      if (value === undefined) throw new Error(`session "${id}" not found`)
      const restored = structuredClone(value)
      return SessionPreparation.create(ctx.sessions.prepare(id, {
        seedSource: 'persistence', seed: [...restored.events], meta: restored.header,
      }))
    },
  }
  ctx.provide('sessionPersistence' as never, (sessionPersistence?.(ctx) ?? fallbackPersistence) as never)
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: [
    { id: 'local-pair', effect: 'allow', subject: { kind: 'external', id: 'local:test' }, actions: ['pair.issue'],
      resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
    { id: 'owner-ingest', effect: 'allow', subject: { kind: 'external', id: 'lark/bot-1/tenant-a/ou_owner' },
      actions: ['pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
    ...(permissions?.allowAgentReply === false ? [] : [{ id: 'agent-reply', effect: 'allow' as const, subject: {
      kind: 'agent' as const, id: agentPreset, workspace, principal: 'lark/bot-1/tenant-a/ou_owner',
    },
      actions: ['reply'], resource: { kind: 'message' as const, id: '*' },
      context: { initiators: ['external' as const] },
      ...(permissions?.replyBudget === undefined
        ? {}
        : { budget: { id: 'permission-replies', amount: 1 } }) }]),
  ], ...(permissions?.replyBudget === undefined ? {} : { budgets: [{
    id: 'permission-replies',
    metric: 'replies',
    limit: permissions.replyBudget,
    periodMs: 60_000,
    scope: 'subject' as const,
  }] }) })
  const permissionPresets = permissions === undefined || permissions.providePresets === false
    ? undefined
    : permissionPresetFixture(permissions)
  if (permissionPresets !== undefined) {
    ctx.provide('permissionPresets' as never, permissionPresets as never)
    const defaultPreset = permissions?.seedDefaultPreset ?? permissionPresets.names[0]!
    ctx.on('session/created', session => {
      if (session.events.some(event => [
        'permission/preset', 'sandbox/mode', 'approval/policy',
      ].includes(String(event.type)))) return
      const spec = permissionPresets.resolve(defaultPreset)
      session.append('permission/preset', { preset: defaultPreset })
      const append = session.append as unknown as (type: string, data: unknown) => unknown
      append.call(session, 'sandbox/mode', { mode: spec.sandbox })
      append.call(session, 'approval/policy', { policy: spec.approval })
    })
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
    agentModel: defaultRoute.model,
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
  getModelSelection(conversation: ConversationRef): ConversationModelSelection | undefined
  setModelSelection(conversation: ConversationRef, route: ModelRouteRef): ConversationModelSelection
  getPrincipal(principal: Readonly<ConversationBinding['principal']>): { id: string; version: number } | undefined
  getInbox(id: string): {
    status: string
    failureCode?: string
    leaseUntil?: number
    nextAttemptAt?: number
  } | undefined
  getInboxByProviderEvent(channel: string, account: string, eventId: string): {
    id: string
    status: string
    bindingId?: string
  } | undefined
  deadLetterInbox(id: string, failureCode: string): unknown
  markInboxDispatching(input: unknown): unknown
  renewInboxClaim(input: { inboxId: string; ownerId: string; fencingToken: number; leaseMs: number }): boolean
  revokePrincipal(id: string, expectedVersion: number): unknown
  rotateBinding(input: { bindingId: string; expectedVersion: number; sessionId: string }): ConversationBinding
} {
  return (service as unknown as { deliveryStore: ReturnType<typeof runtimeStore> }).deliveryStore
}

function suspendApprovalReviewerReader(ctx: Context): () => void {
  const persistence = ctx.get('sessionPersistence') as undefined | {
    coordinator?: { assertEventsSupported(meta: SessionHeader, events: readonly SessionEvent[]): void }
  }
  const coordinator = persistence?.coordinator
  if (persistence === undefined || coordinator === undefined) {
    throw new Error('reviewer reader suspension fixture requires a persistence coordinator')
  }
  persistence.coordinator = {
    assertEventsSupported: coordinator.assertEventsSupported.bind(coordinator),
  }
  return () => { persistence.coordinator = coordinator }
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
    'probe',
    undefined,
    permissions,
  )
}

async function persistentRuntimeHarness(
  root: string,
  stored: Map<string, DurableStoredSession>,
  PersistenceCoordinator: PersistenceCoordinatorConstructor,
) {
  return await runtimeHarness(
    root,
    new Map(),
    undefined,
    undefined,
    root,
    undefined,
    'primary',
    true,
    'probe',
    undefined,
    { seedDefaultPreset: 'unlocked-dynamic-id' },
    realPersistence(PersistenceCoordinator, stored),
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

function expectSafeFullPermission(
  permissionPresets: ReturnType<typeof permissionPresetFixture>,
  events: readonly SessionEvent[],
): void {
  expect(permissionPresets.current(events)).toBe('unlocked-dynamic-id')
  expect(lastSandboxMode(events)).toBe('danger-full-access')
  expect(effectiveApprovalPolicy(events)).toBe('never')
  expect(approvalReviewerOf(events)).toBe('none')
}

function nativeFullEvents(persisted: SavedSession): SessionEvent[] {
  return [
    ...persisted.events,
    {
      type: 'permission/preset',
      seq: persisted.events.length,
      time: Date.now(),
      data: { preset: 'unlocked-dynamic-id' },
    },
    {
      type: 'sandbox/mode',
      seq: persisted.events.length + 1,
      time: Date.now(),
      data: { mode: 'danger-full-access' },
    },
    {
      type: 'approval/policy',
      seq: persisted.events.length + 2,
      time: Date.now(),
      data: { policy: 'never' },
    },
  ]
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

  test('isolates new sessions by durable Delivery database instance while preserving cold resume', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'assistant-delivery-instance-first-'))
    const secondRoot = await mkdtemp(join(tmpdir(), 'assistant-delivery-instance-second-'))
    roots.push(firstRoot, secondRoot)
    const saved = new Map<string, SavedSession>()

    const first = await runtimeHarness(firstRoot, saved)
    const firstPairing = first.service.issuePairing('test', principal)
    first.service.confirmPairing({ challengeId: firstPairing.challenge.id, principal, code: firstPairing.code })
    await first.service.acceptInbound(message('evt-instance-first', 'first database context'))
    await drive(first.service)
    const firstBinding = runtimeStore(first.service).getActiveBinding(conversation)!
    expect(first.llm.requests).toHaveLength(1)
    await first.ctx.fiber.restart()

    const second = await runtimeHarness(secondRoot, saved)
    const secondPairing = second.service.issuePairing('test', principal)
    second.service.confirmPairing({ challengeId: secondPairing.challenge.id, principal, code: secondPairing.code })
    await second.service.acceptInbound(message('evt-instance-second', 'second database context'))
    await drive(second.service)
    const secondBinding = runtimeStore(second.service).getActiveBinding(conversation)!
    expect(second.llm.requests).toHaveLength(1)
    expect(JSON.stringify(second.llm.requests[0]!.messages)).not.toContain('first database context')
    expect(secondBinding.sessionId).not.toBe(firstBinding.sessionId)
    expect(saved.has(firstBinding.sessionId)).toBe(true)
    expect(saved.has(secondBinding.sessionId)).toBe(true)
    await second.ctx.fiber.restart()

    const reopened = await runtimeHarness(secondRoot, saved)
    await reopened.service.acceptInbound(message('evt-instance-reopen', 'resume second database context'))
    await drive(reopened.service)
    expect(runtimeStore(reopened.service).getActiveBinding(conversation)?.sessionId).toBe(secondBinding.sessionId)
    expect(JSON.stringify(reopened.llm.requests[0]!.messages)).toContain('second database context')
    expect(JSON.stringify(reopened.llm.requests[0]!.messages)).not.toContain('first database context')
    await reopened.ctx.fiber.restart()
  })

  test('adopts a durable unbound generation-1 session after create flush crashes before binding commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-adopt-generation-1-'))
    roots.push(root)
    const stored = new Map<string, DurableStoredSession>()
    const PersistenceCoordinator = await persistenceCoordinatorConstructor()
    const first = await persistentRuntimeHarness(root, stored, PersistenceCoordinator)
    const pairing = first.service.issuePairing('test', principal)
    first.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    const crash = vi.spyOn(DeliveryStore.prototype, 'createBinding').mockImplementationOnce(() => {
      expect(stored.size).toBe(1)
      throw new Error('simulated crash after generation-1 session flush')
    })
    await expect(first.service.acceptInbound(message('evt-orphan-generation-1', 'persist before binding')))
      .rejects.toThrow('simulated crash')
    crash.mockRestore()
    expect(runtimeStore(first.service).getActiveBinding(conversation)).toBeUndefined()
    expect(runtimeStore(first.service).getInboxByProviderEvent('lark', 'bot-1', 'evt-orphan-generation-1'))
      .toMatchObject({ status: 'received' })
    await first.ctx.fiber.restart()

    const reopened = await persistentRuntimeHarness(root, stored, PersistenceCoordinator)
    const following = await reopened.service.acceptInbound(message(
      'evt-after-orphan-generation-1',
      'must reuse the durable session',
    ))
    const active = runtimeStore(reopened.service).getActiveBinding(conversation)!
    const orphan = runtimeStore(reopened.service)
      .getInboxByProviderEvent('lark', 'bot-1', 'evt-orphan-generation-1')!
    expect(active).toMatchObject({ generation: 1 })
    expect(orphan).toMatchObject({ status: 'queued', bindingId: active.id })
    expect(runtimeStore(reopened.service).getInbox(following.inboxId))
      .toMatchObject({ status: 'queued' })
    expect(stored.size).toBe(1)
    await reopened.ctx.fiber.restart()
  })

  test('adopts a durable /new session after create flush crashes before atomic rotation commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-adopt-new-generation-'))
    roots.push(root)
    const stored = new Map<string, DurableStoredSession>()
    const PersistenceCoordinator = await persistenceCoordinatorConstructor()
    const first = await persistentRuntimeHarness(root, stored, PersistenceCoordinator)
    const pairing = first.service.issuePairing('test', principal)
    first.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    await first.service.acceptInbound(message('evt-before-orphan-new', 'generation one'))
    expect(stored.size).toBe(1)

    const crash = vi.spyOn(DeliveryStore.prototype, 'rotateBindingAndQueueCommand')
      .mockImplementationOnce(() => {
        expect(stored.size).toBe(2)
        throw new Error('simulated crash after generation-2 session flush')
      })
    await expect(first.service.acceptInbound(message('evt-orphan-new', '/new', 'command')))
      .rejects.toThrow('simulated crash')
    crash.mockRestore()
    expect(runtimeStore(first.service).getActiveBinding(conversation)).toMatchObject({ generation: 1 })
    expect(runtimeStore(first.service).getInboxByProviderEvent('lark', 'bot-1', 'evt-orphan-new'))
      .toMatchObject({ status: 'received' })
    await first.ctx.fiber.restart()

    const reopened = await persistentRuntimeHarness(root, stored, PersistenceCoordinator)
    const following = await reopened.service.acceptInbound(message(
      'evt-after-orphan-new',
      'must enter the adopted generation',
    ))
    const active = runtimeStore(reopened.service).getActiveBinding(conversation)!
    const reset = runtimeStore(reopened.service)
      .getInboxByProviderEvent('lark', 'bot-1', 'evt-orphan-new')!
    expect(active).toMatchObject({ generation: 2 })
    expect(reset).toMatchObject({ status: 'queued', bindingId: active.id })
    expect(runtimeStore(reopened.service).getInbox(following.inboxId))
      .toMatchObject({ status: 'queued' })
    expect(stored.size).toBe(2)
    await reopened.ctx.fiber.restart()
  })

  test('/stop cancels the live DSH turn out of band and preserves the current session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-stop-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await runtimeHarness(root, saved)
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    let markStopped!: () => void
    const stopped = new Promise<void>(resolve => { markStopped = resolve })
    vi.spyOn(fixture.llm, 'stream').mockImplementation(async function* (options) {
      fixture.llm.requests.push(options)
      const signal = options.signal
      if (signal === undefined) throw new Error('test expected the Agent turn to own a cancellation signal')
      markStarted()
      await new Promise<void>(resolve => {
        const onAbort = (): void => {
          markStopped()
          resolve()
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })
      yield* [] as StreamChunk[]
    })

    const first = await fixture.service.acceptInbound(message('evt-stop-task', 'keep working'))
    const bindingBefore = runtimeStore(fixture.service).getActiveBinding(conversation)!
    const runningTick = fixture.service.tick()
    await started

    const stop = await fixture.service.acceptInbound(message('evt-stop-command', '/stop', 'command'))
    await stopped
    await runningTick
    await drive(fixture.service)

    const bindingAfter = runtimeStore(fixture.service).getActiveBinding(conversation)!
    expect(bindingAfter).toMatchObject({
      id: bindingBefore.id,
      generation: bindingBefore.generation,
      sessionId: bindingBefore.sessionId,
    })
    expect(runtimeStore(fixture.service).getInbox(first.inboxId)).toMatchObject({ status: 'processed' })
    expect(runtimeStore(fixture.service).getInbox(stop.inboxId)).toMatchObject({ status: 'processed' })
    expect(fixture.llm.requests).toHaveLength(1)
    expect(fixture.sends.map(value => value.text)).toEqual([
      '已处理停止请求；当前 session 与已完成上下文保留。',
    ])
    expect(saved.get(bindingBefore.sessionId)?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'turn/end',
        data: expect.objectContaining({
          reason: expect.objectContaining({
            kind: 'aborted',
            reason: expect.objectContaining({ kind: 'user' }),
          }),
        }),
      }),
    ]))
    await fixture.ctx.fiber.restart()
  })

  test('/new is not held by pending presentation progress and suppresses the cancelled old reply', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-new-pending-progress-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await runtimeHarness(root, saved)
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    let markTurnStarted!: () => void
    const turnStarted = new Promise<void>(resolve => { markTurnStarted = resolve })
    vi.spyOn(fixture.llm, 'stream').mockImplementation(async function* (options) {
      fixture.llm.requests.push(options)
      const signal = options.signal
      if (signal === undefined) throw new Error('test expected a cancellation signal')
      markTurnStarted()
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
      yield* [] as StreamChunk[]
    })

    const adapter = (fixture.service as unknown as { registry: {
      get(channel: string, account: string): DeliveryAdapter | undefined
    } }).registry.get('lark', 'bot-1')!
    const originalProgress = adapter.progress!
    let markProgressStarted!: () => void
    const progressStarted = new Promise<void>(resolve => { markProgressStarted = resolve })
    let releaseProgress!: () => void
    const progressGate = new Promise<void>(resolve => { releaseProgress = resolve })
    vi.spyOn(adapter, 'progress').mockImplementation(async intent => {
      markProgressStarted()
      await progressGate
      await originalProgress(intent)
    })

    const old = await fixture.service.acceptInbound(message('evt-new-running', 'old generation task'))
    const oldBinding = runtimeStore(fixture.service).getActiveBinding(conversation)!
    const runningTick = fixture.service.tick()
    await Promise.all([turnStarted, progressStarted])

    const command = await fixture.service.acceptInbound(message('evt-new-live', '/new', 'command'))
    const fresh = runtimeStore(fixture.service).getActiveBinding(conversation)!
    expect(fresh).toMatchObject({ generation: 2 })
    expect(fresh.id).not.toBe(oldBinding.id)
    await runningTick
    await drive(fixture.service)

    expect(runtimeStore(fixture.service).getInbox(old.inboxId)).toMatchObject({ status: 'processed' })
    expect(runtimeStore(fixture.service).getInbox(command.inboxId)).toMatchObject({ status: 'processed' })
    expect(fixture.sends.map(value => value.text)).toEqual([
      expect.stringContaining('已开始新会话'),
    ])

    releaseProgress()
    await Promise.resolve()
    await fixture.ctx.fiber.restart()
  })

  test('never publishes a reply when the completed turn cannot cross the durability barrier', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-turn-flush-'))
    roots.push(root)
    const fixture = await runtimeHarness(root, new Map())
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    const accepted = await fixture.service.acceptInbound(message('evt-turn-flush-false', 'must be durable'))
    const flush = vi.spyOn(fixture.ctx.sessions, 'flush').mockResolvedValueOnce(false)

    await drive(fixture.service)

    expect(flush).toHaveBeenCalled()
    expect(fixture.sends).toEqual([])
    expect(runtimeStore(fixture.service).getInbox(accepted.inboxId)).toMatchObject({
      status: 'dead_letter',
    })
    await fixture.ctx.fiber.restart()
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
      'probe', imageOptions,
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
      'probe', imageOptions,
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
      'probe', {
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
      'probe', {
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

  test('passes the same preset-owned tool schemas to every selected provider', async () => {
    for (const [index, provider] of [
      'codex-subscription',
      'claude-subscription',
      'cursor-subscription',
      'grok-subscription',
      'traex-agent',
      'super-relay',
    ].entries()) {
      const root = await mkdtemp(join(tmpdir(), `assistant-delivery-model-equality-${index}-`))
      roots.push(root)
      const saved = new Map<string, SavedSession>()
      const fixture = await runtimeHarness(root, saved, { provider, model: 'default' })
      const adapter = new ReplyAdapter(`Provider ${provider}`)
      fixture.ctx.llm.registerAdapter([provider], adapter)
      if (provider === 'codex-subscription') {
        registerLlmRouteCapability(fixture.ctx.llm, { provider, toolCalls: 'bridge' })
      } else if (provider === 'claude-subscription') {
        registerLlmRouteCapability(fixture.ctx.llm, { provider, toolCalls: 'native' })
      }
      const pairing = fixture.service.issuePairing('test', principal)
      fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

      await fixture.service.acceptInbound(message(`evt-equal-tools-${index}`, 'use the preset tool'))
      await drive(fixture.service)

      expect(saved.size).toBe(1)
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('preset_probe')
      await fixture.ctx.fiber.restart()
    }
  })

  test('fails closed only when an adapter explicitly declares no tool-call protocol', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-none-protocol-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await runtimeHarness(root, saved, {
      provider: 'text-only-route', model: 'model',
    })
    const textOnly = new ReplyAdapter('Text-only adapter')
    fixture.ctx.llm.registerAdapter(['text-only-route'], textOnly)
    registerLlmRouteCapability(fixture.ctx.llm, { provider: 'text-only-route', toolCalls: 'none' })
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    await fixture.service.acceptInbound(message('evt-none-protocol', 'use the preset tool'))
    expect(saved.size).toBe(1)
    await drive(fixture.service)

    expect(textOnly.requests).toHaveLength(0)
    expect(fixture.sends.at(-1)?.text).toContain('text-only-route/model')
    expect(fixture.sends.at(-1)?.text).toContain('DSH tool-call')
    expect(fixture.sends.at(-1)?.text).toContain('升级或修复该 provider adapter')
    expect(fixture.sends.at(-1)?.text).not.toContain('发送 /model')
    await fixture.ctx.fiber.restart()
  })

  test('allows an explicit none declaration when the final Agent tool scope is empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-empty-tools-'))
    roots.push(root)
    const fixture = await runtimeHarness(root, new Map(), {
      provider: 'unknown-route', model: 'model',
    }, undefined, root, undefined, 'primary', true, 'empty')
    const unknown = new ReplyAdapter('Unknown route')
    fixture.ctx.llm.registerAdapter(['unknown-route'], unknown)
    registerLlmRouteCapability(fixture.ctx.llm, { provider: 'unknown-route', toolCalls: 'none' })
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

  test('turns session events into useful bounded progress while redacting reasoning and credentials', () => {
    const event = (value: object) => value as SessionEvent
    expect(deliveryProgressFromSessionEvent(event({
      type: 'assistant/chunk', data: { turn: 1, step: 1,
        chunk: { type: 'reasoning-delta', index: 0, text: 'private chain of thought' } },
    }))).toBeUndefined()
    const started = deliveryProgressFromSessionEvent(event({
      type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'web.search',
        arguments: '{"query":"release notes","api_key":"must-not-leak","refreshToken":"also-private","nested":{"awsSecretAccessKey":"private-too"}}' },
    }))
    expect(started).toMatchObject({ kind: 'tool-started', callId: 'call-1', toolName: 'web.search' })
    expect(started?.kind === 'tool-started' ? started.argumentsPreview : '').toContain('release notes')
    expect(started?.kind === 'tool-started' ? started.argumentsPreview : '').toContain('[REDACTED]')
    expect(started?.kind === 'tool-started' ? started.argumentsPreview : '').not.toContain('also-private')
    expect(started?.kind === 'tool-started' ? started.argumentsPreview : '').not.toContain('private-too')
    const finished = deliveryProgressFromSessionEvent(event({
      type: 'tool/result', data: { turn: 1, step: 1,
        message: { source: { callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1',
          content: [
            { type: 'reasoning', text: 'hidden tool thought' },
            { type: 'text', text: [
              'Found 2 matching release notes',
              'Authorization: Bearer secret-token',
              'OPENAI_API_KEY=openai-private',
              'AZURE_OPENAI_API_KEY="azure-private"',
              "AWS_ACCESS_KEY_ID='aws-private'",
              'myClientSecret="client-private"',
              'someRefreshToken=refresh-private',
              'credentials=credential-private',
              'password="dangling-private\\',
              '{"message":"password=\\"inner-password-private\\""}',
              '{"message":"OPENAI_API_KEY=\\"inner-key-private\\""}',
            ].join('\n') },
          ] }] } },
    }))
    expect(finished).toMatchObject({ kind: 'tool-finished', callId: 'call-1', failed: false })
    expect(finished?.kind === 'tool-finished' ? finished.resultPreview : '').toContain('Found 2 matching release notes')
    expect(finished?.kind === 'tool-finished' ? finished.resultPreview : '').toContain('[REDACTED]')
    expect(finished?.kind === 'tool-finished' ? finished.resultPreview : '')
      .toContain('password=[REDACTED]')
    expect(finished?.kind === 'tool-finished' ? finished.resultPreview : '')
      .toContain('OPENAI_API_KEY=[REDACTED]')
    for (const secret of [
      'openai-private', 'azure-private', 'aws-private', 'client-private', 'refresh-private',
      'credential-private', 'dangling-private', 'inner-password-private', 'inner-key-private',
    ]) {
      expect(finished?.kind === 'tool-finished' ? finished.resultPreview : '').not.toContain(secret)
    }
    expect(finished?.kind === 'tool-finished' ? finished.resultPreview : '').not.toContain('hidden tool thought')
    expect(deliveryProgressFromSessionEvent(event({
      type: 'tool/result', data: { turn: 1, step: 1,
        message: { source: { callId: 'call-rejected' }, content: [{ type: 'tool-result',
          toolCallId: 'call-rejected', content: [{ type: 'text', text: 'the user rejected tool' }],
          isError: true }] }, error: { name: 'ToolError', code: 'USER_REJECTED' } },
    }))).toEqual({ kind: 'tool-finished', callId: 'call-rejected', failed: true,
      resultPreview: 'the user rejected tool', code: 'USER_REJECTED' })
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
        callId: 'call-1', name: 'web.search', arguments: '{"query":"release notes","api_key":"must-not-leak"}' } })),
      deliveryProgressFromSessionEvent(event({ type: 'tool/result', data: { turn: 1, step: 1,
        message: { source: { callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1',
          content: [{ type: 'text', text: 'Found release note; token=must-not-leak-too' }] }] } } })),
    ])
    expect(serialized).not.toContain('private chain of thought')
    expect(serialized).not.toContain('must-not-leak')
    expect(serialized).toContain('release notes')
    expect(serialized).toContain('Found release note')
  })

  test('uses neutral phases and never exposes assembled or interrupted assistant reasoning', () => {
    const event = (value: object) => value as SessionEvent
    // Providers differ: some emit no reasoning at all, so a step phase label always lands first.
    expect(deliveryProgressFromSessionEvent(event({
      type: 'step/start', data: { turn: 1, step: 1 },
    }))).toEqual({ kind: 'step', text: '正在处理请求…' })
    expect(deliveryProgressFromSessionEvent(event({
      type: 'step/start', data: { turn: 1, step: 3 },
    }))).toEqual({ kind: 'step', text: '正在继续处理（第 3 步）…' })
    const assembled = {
      type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [
        { type: 'reasoning', text: '  先确认当前目录  ' },
        { type: 'reasoning', text: '再核对分组顺序' },
        { type: 'text', text: '这是最终回复，不应出现在进度里' },
      ] } },
    }
    expect(deliveryProgressFromSessionEvent(event(assembled))).toBeUndefined()
    expect(deliveryProgressFromSessionEvent(event({
      ...assembled, data: { ...assembled.data, interrupted: true },
    }))).toBeUndefined()
    // A reply-only message also contributes no step; step/start keeps the panel informative.
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
  })

  test('keeps oversized tool previews bounded and tool arguments valid JSON', () => {
    const event = (value: object) => value as SessionEvent
    const started = deliveryProgressFromSessionEvent(event({
      type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-large', name: 'memory_search',
        arguments: JSON.stringify({ query: '\\\u0000'.repeat(2_000), token: 'do-not-expose' }) },
    }))
    expect(started?.kind).toBe('tool-started')
    if (started?.kind !== 'tool-started' || started.argumentsPreview === undefined) {
      throw new Error('missing tool argument preview')
    }
    expect([...started.argumentsPreview].length).toBeLessThanOrEqual(1_500)
    expect(() => JSON.parse(started.argumentsPreview!)).not.toThrow()
    expect(started.argumentsPreview).not.toContain('do-not-expose')

    const finished = deliveryProgressFromSessionEvent(event({
      type: 'tool/result', data: { turn: 1, step: 1,
        message: { source: { callId: 'call-large' }, content: [{ type: 'tool-result', toolCallId: 'call-large',
          content: [{ type: 'text', text: `result\n"token":"${'must-not-leak-'.repeat(300)}` }] }] } },
    }))
    expect(finished?.kind).toBe('tool-finished')
    if (finished?.kind !== 'tool-finished' || finished.resultPreview === undefined) {
      throw new Error('missing tool result preview')
    }
    expect([...finished.resultPreview].length).toBeLessThanOrEqual(1_500)
    expect(finished.resultPreview).toContain('result')
    expect(finished.resultPreview).toContain('[REDACTED]')
    expect(finished.resultPreview).not.toContain('must-not-leak')
  })

  test('redacts structured values and fail-closes unquoted result credentials by line', () => {
    const event = (value: object) => value as SessionEvent
    const finished = deliveryProgressFromSessionEvent(event({
      type: 'tool/result', data: { turn: 1, step: 1,
        message: { source: { callId: 'call-result-secrets' }, content: [{ type: 'tool-result',
          toolCallId: 'call-result-secrets', content: [
            { type: 'text', text: '{"token":{"value":"nested-secret"},"summary":"kept"}' },
            { type: 'text', text: 'Cookie: sid=first-secret; csrf=second-secret' },
            { type: 'text', text: 'password: correct horse battery staple' },
            { type: 'text', text: 'message: token=nested-line-secret' },
            { type: 'text', text: 'safe=password=nested-equals-secret' },
            { type: 'text', text: 'output: Cookie: sid=nested-cookie-secret' },
            { type: 'text', text: 'message: "{\\"token\\":\\"escaped-scalar-secret\\"}"' },
            { type: 'text', text: 'message: "{\\"token\\":{\\"value\\":\\"escaped-object-secret\\"}}"' },
            { type: 'text', text: String.raw`password=\"abc\\\"escaped-inner-secret\"` },
            { type: 'text', text: String.raw`message: "password=\"abc\\\"nested-inner-secret\""` },
            { type: 'text', text: 'password="abc\\\rcr-only-secret"' },
            ...[1, 2, 3, 4].map(count => {
              const slashes = '\\'.repeat(count)
              return { type: 'text' as const,
                text: `message: "{${slashes}"token${slashes}":${slashes}"escaped-key-${count}-secret${slashes}"}"` }
            }),
            { type: 'text', text: String.raw`message: "{\'password\':\'single-key-secret\'}"` },
          ] }] } },
    }))
    if (finished?.kind !== 'tool-finished' || finished.resultPreview === undefined) {
      throw new Error('missing tool result preview')
    }
    expect(finished.resultPreview).toContain('"summary": "kept"')
    expect(finished.resultPreview).toContain('Cookie: [REDACTED]')
    expect(finished.resultPreview).toContain('password: [REDACTED]')
    for (const secret of [
      'nested-secret', 'first-secret', 'second-secret', 'correct', 'horse', 'battery', 'staple',
      'nested-line-secret', 'nested-equals-secret', 'nested-cookie-secret',
      'escaped-scalar-secret', 'escaped-object-secret',
      'escaped-inner-secret', 'nested-inner-secret', 'cr-only-secret',
      'escaped-key-1-secret', 'escaped-key-2-secret', 'escaped-key-3-secret',
      'escaped-key-4-secret', 'single-key-secret',
    ]) expect(finished.resultPreview).not.toContain(secret)
  })

  test('does not parse or echo an oversized result block', () => {
    const event = (value: object) => value as SessionEvent
    const finished = deliveryProgressFromSessionEvent(event({
      type: 'tool/result', data: { turn: 1, step: 1,
        message: { source: { callId: 'call-oversized-result' }, content: [{ type: 'tool-result',
          toolCallId: 'call-oversized-result', content: [{ type: 'text', text: JSON.stringify({
            summary: 'oversized-private', padding: 'x'.repeat(40_000),
          }) }] }] } },
    }))
    expect(finished).toEqual({ kind: 'tool-finished', callId: 'call-oversized-result', failed: false,
      resultPreview: '{"truncated":true}' })
  })

  test('does not echo raw empty, malformed, or oversized tool argument payloads', () => {
    const event = (value: object) => value as SessionEvent
    const preview = (argumentsValue: string) => {
      const update = deliveryProgressFromSessionEvent(event({
        type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-edge', name: 'edge',
          arguments: argumentsValue },
      }))
      if (update?.kind !== 'tool-started') throw new Error('missing tool argument preview')
      return update.argumentsPreview
    }
    expect(preview('')).toBe('{}')
    expect(preview('{"password":"malformed-private\\')).toBe('{"invalidJson":true}')
    expect(preview(`{"someRefreshToken":"oversized-private","padding":"${'x'.repeat(40_000)}"}`))
      .toBe('{"truncated":true}')
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
    expect(fixture.sends.at(-1)?.text).toContain('已开始新会话')
    expect(fixture.sends.at(-1)?.text).toContain('旧会话已保留')
    await fixture.ctx.fiber.restart()
  })

  test('/status reports the active generation and context without starting a model turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-status-'))
    roots.push(root)
    const fixture = await runtimeHarness(root, new Map())
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    await fixture.service.acceptInbound(message('evt-status-seed', 'remember this'))
    await drive(fixture.service)
    await fixture.service.acceptInbound(message('evt-status', '/status', 'command'))
    await drive(fixture.service)

    expect(fixture.llm.requests).toHaveLength(1)
    expect(fixture.sends.at(-1)?.text).toContain('当前会话')
    expect(fixture.sends.at(-1)?.text).toContain('第 1 代')
    expect(fixture.sends.at(-1)?.text).toContain('上下文消息')
    await fixture.ctx.fiber.restart()
  })

  test('/status reports an unreadable session without deleting its persisted history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-status-unreadable-'))
    roots.push(root)
    const fixture = await runtimeHarness(root, new Map())
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    const resumeFailure = new Error('raw persistence detail must not be shown')
    resumeFailure.name = 'SessionFormatUnsupportedError'
    vi.spyOn(fixture.ctx.agents, 'resume').mockRejectedValueOnce(resumeFailure)

    const accepted = await fixture.service.acceptInbound(message('evt-status-unreadable', '/status', 'command'))
    await drive(fixture.service)

    expect(fixture.llm.requests).toEqual([])
    expect(runtimeStore(fixture.service).getInbox(accepted.inboxId)).toMatchObject({ status: 'processed' })
    expect(fixture.sends.at(-1)?.text).toContain('当前会话暂时无法恢复')
    expect(fixture.sends.at(-1)?.text).toContain('原历史未删除')
    expect(fixture.sends.at(-1)?.text).toContain('session-format-unsupported')
    expect(fixture.sends.at(-1)?.text).not.toContain('raw persistence detail')
    expect(fixture.sends.at(-1)?.text).toContain('/new')
    await fixture.ctx.fiber.restart()
  })

  test('an unknown slash command is rejected by the command plane and never enters model history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-unknown-command-'))
    roots.push(root)
    const fixture = await runtimeHarness(root, new Map())
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    await fixture.service.acceptInbound(message('evt-unknown-command', '/definitely-unknown', 'command'))
    await drive(fixture.service)

    expect(fixture.llm.requests).toEqual([])
    expect(fixture.sends.at(-1)?.text).toContain('未知命令')
    expect(fixture.sends.at(-1)?.text).toContain('/help')
    await fixture.ctx.fiber.restart()
  })

  test('delegates registered DSH commands to the exact resumed Agent without a conversation turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-native-command-'))
    roots.push(root)
    const fixture = await runtimeHarness(root, new Map())
    const execute = vi.fn(async (
      _agent: unknown,
      _line: string,
      _images: readonly never[],
      _signal: AbortSignal,
    ) => ({
      commandId: 'cmd-test-1',
      result: { kind: 'success' as const, text: 'Compacted 12 history items.' },
    }))
    fixture.ctx.provide('commands' as never, {
      list: () => [{ name: 'compact', description: 'Compact older conversation history' }],
      execute,
    } as never)
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    await fixture.service.acceptInbound(message('evt-compact', '/compact', 'command'))
    await drive(fixture.service)

    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ id: expect.stringContaining('delivery-') })
    expect(execute.mock.calls[0]?.[1]).toBe('/compact')
    expect(execute.mock.calls[0]?.[2]).toEqual([])
    expect(execute.mock.calls[0]?.[3]).toBeInstanceOf(AbortSignal)
    expect(fixture.llm.requests).toEqual([])
    expect(fixture.sends.at(-1)?.text).toBe('Compacted 12 history items.')
    await fixture.ctx.fiber.restart()
  })

  test('delegates only the audited non-turn-starting native command allowlist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-native-command-allowlist-'))
    roots.push(root)
    const fixture = await runtimeHarness(root, new Map())
    const execute = vi.fn()
    fixture.ctx.provide('commands' as never, {
      list: () => [
        { name: 'compact', description: 'Compact older conversation history' },
        { name: 'plan', description: 'Start an interactive planning turn' },
      ],
      execute,
    } as never)
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    await fixture.service.acceptInbound(message('evt-help-native-allowlist', '/help', 'command'))
    await drive(fixture.service)
    expect(fixture.sends.at(-1)?.text).toContain('/compact')
    expect(fixture.sends.at(-1)?.text).not.toContain('/plan')

    await fixture.service.acceptInbound(message('evt-plan-native-allowlist', '/plan write a proposal', 'command'))
    await drive(fixture.service)
    expect(execute).not.toHaveBeenCalled()
    expect(fixture.llm.requests).toEqual([])
    expect(fixture.sends.at(-1)?.text).toContain('未知命令 /plan')
    await fixture.ctx.fiber.restart()
  })

  test('invalid slash command envelopes never enter the model or native command runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-invalid-command-envelope-'))
    roots.push(root)
    const fixture = await runtimeHarness(root, new Map())
    const execute = vi.fn()
    fixture.ctx.provide('commands' as never, {
      list: () => [{ name: 'compact', description: 'Compact older conversation history' }],
      execute,
    } as never)
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    for (const [index, line] of ['/STOP', '/123', '/', '/compact\u00a0now'].entries()) {
      await fixture.service.acceptInbound(message(`evt-invalid-command-${index}`, line, 'command'))
      await drive(fixture.service)
      expect(fixture.sends.at(-1)?.text).toContain('命令格式无效')
    }

    expect(execute).not.toHaveBeenCalled()
    expect(fixture.llm.requests).toEqual([])
    await fixture.ctx.fiber.restart()
  })

  test('rechecks live inbound authorization immediately before native command execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-native-command-authorization-'))
    roots.push(root)
    const fixture = await runtimeHarness(root, new Map())
    const execute = vi.fn()
    const store = runtimeStore(fixture.service)
    fixture.ctx.provide('commands' as never, {
      list: () => {
        const owner = store.getPrincipal(principal)!
        store.revokePrincipal(owner.id, owner.version)
        return [{ name: 'compact', description: 'Compact older conversation history' }]
      },
      execute,
    } as never)
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    const accepted = await fixture.service.acceptInbound(message('evt-compact-revoked', '/compact', 'command'))
    await drive(fixture.service)

    expect(execute).not.toHaveBeenCalled()
    expect(fixture.llm.requests).toEqual([])
    expect(store.getInbox(accepted.inboxId)).toMatchObject({
      status: 'dead_letter',
      failureCode: 'inbound-authorization-revoked',
    })
    await fixture.ctx.fiber.restart()
  })

  test('never acknowledges a native command whose execution result is unresolved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-native-command-unresolved-'))
    roots.push(root)
    const fixture = await runtimeHarness(root, new Map())
    fixture.ctx.provide('commands' as never, {
      list: () => [{ name: 'compact', description: 'Compact older conversation history' }],
      execute: vi.fn(async () => undefined),
    } as never)
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    const accepted = await fixture.service.acceptInbound(message('evt-compact-unresolved', '/compact', 'command'))
    await drive(fixture.service)

    expect(runtimeStore(fixture.service).getInbox(accepted.inboxId)).toMatchObject({
      status: 'dead_letter',
      failureCode: 'processor-ambiguous',
    })
    expect(fixture.sends.some(send => send.text.includes('/compact 已完成'))).toBe(false)
    expect(fixture.llm.requests).toEqual([])
    await fixture.ctx.fiber.restart()
  })

  test('does not reply after native command execution when its session flush throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-native-command-flush-'))
    roots.push(root)
    const fixture = await runtimeHarness(root, new Map())
    const execute = vi.fn(async () => ({
      commandId: 'cmd-test-flush',
      result: { kind: 'success' as const, text: 'must not be acknowledged' },
    }))
    fixture.ctx.provide('commands' as never, {
      list: () => [{ name: 'compact', description: 'Compact older conversation history' }],
      execute,
    } as never)
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    await fixture.service.acceptInbound(message('evt-native-flush-seed', 'seed the durable session'))
    await drive(fixture.service)
    const sendsBefore = fixture.sends.length
    vi.spyOn(fixture.ctx.sessions, 'flush').mockRejectedValueOnce(new Error('persistence offline'))

    const accepted = await fixture.service.acceptInbound(message('evt-compact-flush', '/compact', 'command'))
    await drive(fixture.service)

    expect(execute).toHaveBeenCalledOnce()
    expect(runtimeStore(fixture.service).getInbox(accepted.inboxId)).toMatchObject({
      status: 'dead_letter',
      failureCode: 'processor-ambiguous',
    })
    expect(fixture.sends).toHaveLength(sendsBefore)
    expect(fixture.sends.some(send => send.text.includes('must not be acknowledged'))).toBe(false)
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
    const bindingBefore = runtimeStore(first.service).getActiveBinding(conversation)!
    expect(first.llm.requests).toHaveLength(0)
    expect(first.alternate.requests).toHaveLength(0)
    expect(first.sends.at(-1)?.text).toContain('当前权限：请求批准（ask）')
    expect(first.sends.at(-1)?.text).toContain('请求批准（ask）')
    expect(first.sends.at(-1)?.text).toContain('帮我批准（auto）')
    expect(first.sends.at(-1)?.text).toContain('完全访问权限（full）')
    expect(first.sends.at(-1)).toMatchObject({
      format: 'permission-picker',
      permissionPicker: {
        current: 'ask',
        bindingVersion: bindingBefore.version,
        sessionId: bindingBefore.sessionId,
        expectedStateHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        emergencyStopVersion: 0,
      },
    })
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

  test('/permission maps two declared workspace bundles to distinct dynamic ask and auto targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permissions-distinct-dynamic-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await permissionRuntimeHarness(root, saved, { presets: distinctDynamicPermissionPresets })
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    await fixture.service.acceptInbound(message('evt-dynamic-auto', '/permission auto', 'command'))
    await drive(fixture.service)
    let events = activeSessionEvents(fixture.service, saved)
    expect(lastPermissionPreset(events)).toBe('auto-dynamic-id')
    expect(approvalReviewerOf(events)).toBe('auto-review')

    await fixture.service.acceptInbound(message('evt-dynamic-ask', '/permission ask', 'command'))
    await drive(fixture.service)
    events = activeSessionEvents(fixture.service, saved)
    expect(lastPermissionPreset(events)).toBe('ask-dynamic-id')
    expect(approvalReviewerOf(events)).toBe('user')
    expect(fixture.permissionPresets?.set.mock.calls.map(([, name]) => name)).toEqual([
      'auto-dynamic-id',
      'ask-dynamic-id',
    ])
    await fixture.ctx.fiber.restart()
  })

  test('/permission uses canonical preset intent without writing new legacy reviewer events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permissions-canonical-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await permissionRuntimeHarness(root, saved, { presets: canonicalPermissionPresets })
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    await fixture.service.acceptInbound(message('evt-canonical-auto', '/permission auto', 'command'))
    await drive(fixture.service)
    let events = activeSessionEvents(fixture.service, saved)
    expect(lastPermissionPreset(events)).toBe('auto')
    expect(approvalReviewerOf(events)).toBe('auto-review')
    expect(events.some(event => event.type === 'assistant-policy/approval-reviewer')).toBe(false)

    await fixture.service.acceptInbound(message('evt-canonical-full', '/permission full confirm', 'command'))
    await drive(fixture.service)
    events = activeSessionEvents(fixture.service, saved)
    expect(lastPermissionPreset(events)).toBe('danger-full-access')
    expect(approvalReviewerOf(events)).toBe('none')

    await fixture.service.acceptInbound(message('evt-canonical-full-auto', '/permission auto', 'command'))
    await drive(fixture.service)
    events = activeSessionEvents(fixture.service, saved)
    expect(lastPermissionPreset(events)).toBe('auto')
    expect(approvalReviewerOf(events)).toBe('auto-review')

    await fixture.service.acceptInbound(message('evt-canonical-web-ask', '/permission ask', 'command'))
    await drive(fixture.service)
    events = activeSessionEvents(fixture.service, saved)
    expect(lastPermissionPreset(events)).toBe('workspace-write')
    expect(approvalReviewerOf(events)).toBe('user')
    expect(events.some(event => event.type === 'assistant-policy/approval-reviewer')).toBe(false)
    await fixture.ctx.fiber.restart()
  })

  test('/permission rejects a real owner whose exact Delivery Agent reply Policy is denied before mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permissions-reply-policy-denied-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await permissionRuntimeHarness(root, saved, { allowAgentReply: false })
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    const accepted = await fixture.service.acceptInbound(
      message('evt-permission-reply-policy-denied', '/permission auto', 'command'),
    )
    await drive(fixture.service)

    const events = activeSessionEvents(fixture.service, saved)
    expect(lastPermissionPreset(events)).toBe('guarded-dynamic-id')
    expect(approvalReviewerOf(events)).toBe('user')
    expect(fixture.permissionPresets?.set).not.toHaveBeenCalled()
    expect(fixture.sends).toEqual([])
    expect(runtimeStore(fixture.service).getInbox(accepted.inboxId)).toMatchObject({
      status: 'dead_letter',
      failureCode: 'permission-authorization-revoked',
    })
    await fixture.ctx.fiber.restart()
  })

  test('permission picker settlement rechecks exact Agent reply Policy before accepting its Inbox', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permissions-picker-reply-policy-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const first = await permissionRuntimeHarness(root, saved, {})
    const pairing = first.service.issuePairing('test', principal)
    first.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    const cardEventId = 'evt-permission-picker-policy-card'
    await first.service.acceptInbound(message(cardEventId, '/permissions', 'command'))
    await drive(first.service)
    const picker = first.sends.at(-1)?.permissionPicker
    const binding = runtimeStore(first.service).getActiveBinding(conversation)!
    if (picker === undefined) throw new Error('permission picker fixture is missing')
    const cardMessageId = replyProviderMessageId(first.service, cardEventId)
    const before = structuredClone(activeSessionEvents(first.service, saved))
    await first.ctx.fiber.restart()

    const denied = await permissionRuntimeHarness(root, saved, { allowAgentReply: false })
    await expect(denied.service.settlePermissionSelection({
      operationId: picker.operationId,
      callbackEventId: 'callback-permission-picker-policy-denied',
      callbackChatId: conversation.chat,
      cardMessageId,
      bindingId: binding.id,
      bindingVersion: picker.bindingVersion,
      sessionId: picker.sessionId,
      principal,
      issuedAt: picker.issuedAt,
      expiresAt: picker.expiresAt,
      expectedStateHash: picker.expectedStateHash,
      emergencyStopVersion: picker.emergencyStopVersion,
      targetLevel: 'auto',
    })).rejects.toMatchObject({ code: 'missing-binding' })
    expect(activeSessionEvents(denied.service, saved)).toEqual(before)
    expect(denied.permissionPresets?.set).not.toHaveBeenCalled()
    await denied.ctx.fiber.restart()
  })

  test('rejects a permission picker across an emergency-stop enable-disable ABA', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permissions-picker-emergency-aba-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await permissionRuntimeHarness(root, saved, {})
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    const cardEventId = 'evt-permission-picker-emergency-aba'
    await fixture.service.acceptInbound(message(cardEventId, '/permissions', 'command'))
    await drive(fixture.service)
    const picker = fixture.sends.at(-1)?.permissionPicker
    const binding = runtimeStore(fixture.service).getActiveBinding(conversation)!
    if (picker === undefined) throw new Error('permission picker fixture is missing')
    const emergencyStopVersion = (picker as { emergencyStopVersion?: number })
      .emergencyStopVersion
    const before = structuredClone(activeSessionEvents(fixture.service, saved))

    fixture.ctx.assistantPolicy.setEmergencyStop({ enabled: true, actor: 'test', reason: 'picker ABA start' })
    fixture.ctx.assistantPolicy.setEmergencyStop({ enabled: false, actor: 'test', reason: 'picker ABA end' })

    let rejected: unknown
    try {
      await fixture.service.settlePermissionSelection({
        operationId: picker.operationId,
        callbackEventId: 'callback-permission-picker-emergency-aba',
        callbackChatId: conversation.chat,
        cardMessageId: replyProviderMessageId(fixture.service, cardEventId),
        bindingId: binding.id,
        bindingVersion: picker.bindingVersion,
        sessionId: picker.sessionId,
        principal,
        issuedAt: picker.issuedAt,
        expiresAt: picker.expiresAt,
        expectedStateHash: picker.expectedStateHash,
        emergencyStopVersion: emergencyStopVersion!,
        targetLevel: 'full',
      } as Parameters<typeof fixture.service.settlePermissionSelection>[0] & { emergencyStopVersion: number })
    } catch (error) {
      rejected = error
    }
    await drive(fixture.service)

    expect(emergencyStopVersion).toBe(0)
    expect(rejected).toMatchObject({ code: 'missing-binding' })
    expect(activeSessionEvents(fixture.service, saved)).toEqual(before)
    expect(fixture.permissionPresets?.set).not.toHaveBeenCalledWith(expect.anything(), 'unlocked-dynamic-id')
    await fixture.ctx.fiber.restart()
  })

  test('compensates to ask when emergency stop performs an ABA during picker flush', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permissions-picker-flush-aba-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await permissionRuntimeHarness(root, saved, {})
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    const cardEventId = 'evt-permission-picker-flush-aba'
    await fixture.service.acceptInbound(message(cardEventId, '/permissions', 'command'))
    await drive(fixture.service)
    const picker = fixture.sends.at(-1)?.permissionPicker
    const binding = runtimeStore(fixture.service).getActiveBinding(conversation)!
    if (picker === undefined) throw new Error('permission picker fixture is missing')

    const sessions = fixture.ctx.sessions
    const originalFlush = sessions.flush.bind(sessions)
    const flush = vi.spyOn(sessions, 'flush').mockImplementationOnce(async session => {
      fixture.ctx.assistantPolicy.setEmergencyStop({ enabled: true, actor: 'test', reason: 'picker flush ABA start' })
      fixture.ctx.assistantPolicy.setEmergencyStop({ enabled: false, actor: 'test', reason: 'picker flush ABA end' })
      return await originalFlush(session)
    })

    const accepted = await fixture.service.settlePermissionSelection({
      operationId: picker.operationId,
      callbackEventId: 'callback-permission-picker-flush-aba',
      callbackChatId: conversation.chat,
      cardMessageId: replyProviderMessageId(fixture.service, cardEventId),
      bindingId: binding.id,
      bindingVersion: picker.bindingVersion,
      sessionId: picker.sessionId,
      principal,
      issuedAt: picker.issuedAt,
      expiresAt: picker.expiresAt,
      expectedStateHash: picker.expectedStateHash,
      emergencyStopVersion: picker.emergencyStopVersion,
      targetLevel: 'full',
    })
    expect(accepted).toMatchObject({ status: 'queued' })
    await drive(fixture.service)

    expect(flush).toHaveBeenCalled()
    expect(fixture.ctx.assistantPolicy.getEmergencyStop()).toMatchObject({ enabled: false, version: 2 })
    expectSafeAskPermission(fixture.permissionPresets!, activeSessionEvents(fixture.service, saved))
    expect(fixture.sends.some(send => send.text.includes('已切换到完全访问权限'))).toBe(false)
    flush.mockRestore()
    await fixture.ctx.fiber.restart()
  })

  test('a one-reply hard budget rejects a picker callback before any permission mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permissions-picker-reply-budget-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await permissionRuntimeHarness(root, saved, { replyBudget: 1 })
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    const cardEventId = 'evt-permission-picker-reply-budget'
    await fixture.service.acceptInbound(message(cardEventId, '/permissions', 'command'))
    await drive(fixture.service)
    const picker = fixture.sends.at(-1)?.permissionPicker
    const binding = runtimeStore(fixture.service).getActiveBinding(conversation)!
    if (picker === undefined) throw new Error('permission picker fixture is missing')
    const before = structuredClone(activeSessionEvents(fixture.service, saved))

    await expect(fixture.service.settlePermissionSelection({
      operationId: picker.operationId,
      callbackEventId: 'callback-permission-picker-reply-budget',
      callbackChatId: conversation.chat,
      cardMessageId: replyProviderMessageId(fixture.service, cardEventId),
      bindingId: binding.id,
      bindingVersion: picker.bindingVersion,
      sessionId: picker.sessionId,
      principal,
      issuedAt: picker.issuedAt,
      expiresAt: picker.expiresAt,
      expectedStateHash: picker.expectedStateHash,
      emergencyStopVersion: picker.emergencyStopVersion,
      targetLevel: 'full',
    })).rejects.toMatchObject({ code: 'policy-denied' })

    expect(activeSessionEvents(fixture.service, saved)).toEqual(before)
    expectSafeAskPermission(fixture.permissionPresets!, before)
    expect(runtimeStore(fixture.service).getInboxByProviderEvent(
      'lark', 'bot-1', replyProviderMessageId(fixture.service, cardEventId),
    )).toMatchObject({ status: 'dead_letter' })
    expect(fixture.sends).toHaveLength(1)
    await fixture.ctx.fiber.restart()
  })

  test('an exhausted reply budget blocks /permissions before native-full reviewer adoption', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permissions-show-reply-budget-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await permissionRuntimeHarness(root, saved, {
      replyBudget: 1,
      seedDefaultPreset: 'unlocked-dynamic-id',
    })
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    await fixture.service.acceptInbound(message('evt-permission-budget-seed', '/permission full', 'command'))
    await drive(fixture.service)
    const binding = runtimeStore(fixture.service).getActiveBinding(conversation)!
    const persisted = saved.get(binding.sessionId)!
    const withoutReviewer = {
      header: persisted.header,
      events: persisted.events.filter(event => String(event.type) !== 'assistant-policy/approval-reviewer'),
    }
    saved.set(binding.sessionId, withoutReviewer)
    const sendsBefore = fixture.sends.length

    const accepted = await fixture.service.acceptInbound(
      message('evt-permission-budget-show', '/permissions', 'command'),
    )
    await drive(fixture.service)

    expect(runtimeStore(fixture.service).getInbox(accepted.inboxId)).toMatchObject({
      status: 'dead_letter',
      failureCode: 'permission-reply-authorization-denied',
    })
    expect(fixture.sends).toHaveLength(sendsBefore)
    expect(saved.get(binding.sessionId)).toEqual(withoutReviewer)
    expect(approvalReviewerOf(withoutReviewer.events)).toBe('user')
    await fixture.ctx.fiber.restart()
  })

  test('/permission compensates a committed elevation when its success reply cannot be enqueued', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permissions-post-commit-reply-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await permissionRuntimeHarness(root, saved, {})
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    const internal = fixture.service as unknown as { replyCommand(binding: ConversationBinding, input: unknown): unknown }
    const replyCommand = vi.spyOn(internal, 'replyCommand')
      .mockImplementationOnce(() => { throw new Error('outbox unavailable before enqueue') })
    const flush = vi.spyOn(fixture.ctx.sessions, 'flush')

    const accepted = await fixture.service.acceptInbound(
      message('evt-permission-post-commit-reply', '/permission full confirm', 'command'),
    )
    await drive(fixture.service)

    expect(replyCommand).toHaveBeenCalledTimes(2)
    expect(flush.mock.calls.length).toBeGreaterThanOrEqual(2)
    expectSafeAskPermission(fixture.permissionPresets!, activeSessionEvents(fixture.service, saved))
    expect(fixture.sends).toHaveLength(1)
    expect(fixture.sends[0]?.text).toContain('成功回复入队失败')
    expect(runtimeStore(fixture.service).getInbox(accepted.inboxId)).toMatchObject({ status: 'processed' })
    replyCommand.mockRestore()
    flush.mockRestore()
    await fixture.ctx.fiber.restart()
  })

  test.each(['reply-policy', 'controller'] as const)(
    'cold reopen reconciles a textual permission flush when %s is unavailable before Outbox enqueue',
    async deniedAuthority => {
      const root = await mkdtemp(join(tmpdir(), `assistant-delivery-permission-text-hard-reopen-${deniedAuthority}-`))
      roots.push(root)
      const saved = new Map<string, SavedSession>()
      const eventId = `evt-permission-text-hard-reopen-${deniedAuthority}`
      const first = await permissionRuntimeHarness(root, saved, {})
      const pairing = first.service.issuePairing('test', principal)
      first.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
      const accepted = await first.service.acceptInbound(message(eventId, '/permission full confirm', 'command'))
      await drive(first.service)
      const before = structuredClone(activeSessionEvents(first.service, saved))
      expect(lastSandboxMode(before)).toBe('danger-full-access')
      expect(runtimeStore(first.service).getInbox(accepted.inboxId)).toMatchObject({ status: 'processed' })
      await first.ctx.fiber.restart()

      leavePermissionDispatchClaimedAfterDurableFlush(join(root, 'delivery.sqlite'), eventId)
      let clock = Date.now()
      const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
      const denied = await permissionRuntimeHarness(
        root,
        saved,
        deniedAuthority === 'reply-policy' ? { allowAgentReply: false } : {},
      )
      const internal = denied.service as unknown as {
        isPermissionController(binding: ConversationBinding, envelope: InboundEnvelope): boolean
      }
      const controller = deniedAuthority === 'controller'
        ? vi.spyOn(internal, 'isPermissionController').mockReturnValue(false)
        : undefined
      let reopened: Awaited<ReturnType<typeof permissionRuntimeHarness>> | undefined
      try {
        await denied.service.tick()
        await denied.service.whenIdle()
        const waiting = runtimeStore(denied.service).getInbox(accepted.inboxId)
        expect(waiting).toMatchObject({
          status: 'retry_wait',
          failureCode: 'permission-dispatch-recovery',
        })
        expectSafeAskPermission(denied.permissionPresets!, activeSessionEvents(denied.service, saved))
        expect(denied.sends).toEqual([])
        if (waiting?.nextAttemptAt === undefined) throw new Error('commit recovery reply retry is missing')
        await denied.ctx.fiber.restart()

        clock = waiting.nextAttemptAt
        reopened = await permissionRuntimeHarness(root, saved, {})
        await drive(reopened.service)

        expect(runtimeStore(reopened.service).getInbox(accepted.inboxId)).toMatchObject({ status: 'processed' })
        expect(reopened.sends).toHaveLength(1)
        expect(reopened.sends[0]?.text).toContain('确认持久化前中断')
        expectSafeAskPermission(reopened.permissionPresets!, activeSessionEvents(reopened.service, saved))
      } finally {
        controller?.mockRestore()
        await denied.ctx.fiber.restart()
        await reopened?.ctx.fiber.restart()
        now.mockRestore()
      }
    },
  )

  test('cold reopen converges a partial picker callback state to ask before stale hash and expiry checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permission-picker-hard-reopen-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const first = await permissionRuntimeHarness(root, saved, {})
    const pairing = first.service.issuePairing('test', principal)
    first.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    const cardEventId = 'evt-permission-picker-hard-reopen-card'
    await first.service.acceptInbound(message(cardEventId, '/permissions', 'command'))
    await drive(first.service)
    const picker = first.sends.at(-1)?.permissionPicker
    const binding = runtimeStore(first.service).getActiveBinding(conversation)!
    if (picker === undefined) throw new Error('permission picker fixture is missing')
    const callbackEventId = replyProviderMessageId(first.service, cardEventId)
    const accepted = await first.service.settlePermissionSelection({
      operationId: picker.operationId,
      callbackEventId: 'callback-permission-picker-hard-reopen',
      callbackChatId: conversation.chat,
      cardMessageId: callbackEventId,
      bindingId: binding.id,
      bindingVersion: picker.bindingVersion,
      sessionId: picker.sessionId,
      principal,
      issuedAt: picker.issuedAt,
      expiresAt: picker.expiresAt,
      expectedStateHash: picker.expectedStateHash,
      emergencyStopVersion: picker.emergencyStopVersion,
      targetLevel: 'full',
    })
    await drive(first.service)
    const before = structuredClone(activeSessionEvents(first.service, saved))
    expectSafeFullPermission(first.permissionPresets!, before)
    const persisted = saved.get(binding.sessionId)!
    saved.set(binding.sessionId, {
      header: persisted.header,
      events: [...persisted.events, {
        type: 'sandbox/mode',
        seq: persisted.events.length,
        time: picker.expiresAt,
        data: { mode: 'workspace-write' },
      }],
    })
    await first.ctx.fiber.restart()

    leavePermissionDispatchClaimedAfterDurableFlush(join(root, 'delivery.sqlite'), callbackEventId)
    const now = vi.spyOn(Date, 'now').mockReturnValue(picker.expiresAt + 1)
    const reopened = await permissionRuntimeHarness(root, saved, {})
    try {
      await drive(reopened.service)
      expect(runtimeStore(reopened.service).getInbox(accepted.inboxId)).toMatchObject({ status: 'processed' })
      expect(reopened.permissionPresets?.set).toHaveBeenCalled()
      expect(reopened.sends).toHaveLength(1)
      expect(reopened.sends[0]?.text).toContain('确认持久化前中断')
      expectSafeAskPermission(reopened.permissionPresets!, activeSessionEvents(reopened.service, saved))
    } finally {
      now.mockRestore()
      await reopened.ctx.fiber.restart()
    }
  })

  test('/permissions falls back to the complete plain overview when the channel has no picker support', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permissions-plain-fallback-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await runtimeHarness(root, saved, undefined, ['plain'], root, undefined, 'primary', true,
      'probe', undefined, {})
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    await fixture.service.acceptInbound(message('evt-permissions-plain-fallback', '/permissions', 'command'))
    await drive(fixture.service)

    expect(fixture.sends.at(-1)).toMatchObject({ format: 'plain' })
    expect(fixture.sends.at(-1)?.permissionPicker).toBeUndefined()
    expect(fixture.sends.at(-1)?.text).toContain('/permission full confirm')
    expect(fixture.llm.requests).toHaveLength(0)
    await fixture.ctx.fiber.restart()
  })

  test('a permission picker callback queues the exact full command once and reuses its durable result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permission-picker-callback-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await permissionRuntimeHarness(root, saved, {})
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    const cardEventId = 'evt-permission-picker-full'
    await fixture.service.acceptInbound(message(cardEventId, '/permissions', 'command'))
    await drive(fixture.service)

    const picker = fixture.sends.at(-1)?.permissionPicker
    const binding = runtimeStore(fixture.service).getActiveBinding(conversation)!
    if (picker === undefined) throw new Error('permission picker fixture is missing')
    const selection = {
      operationId: picker.operationId,
      callbackEventId: 'callback-permission-picker-full',
      callbackChatId: conversation.chat,
      cardMessageId: replyProviderMessageId(fixture.service, cardEventId),
      bindingId: binding.id,
      bindingVersion: picker.bindingVersion,
      sessionId: picker.sessionId,
      principal,
      issuedAt: picker.issuedAt,
      expiresAt: picker.expiresAt,
      expectedStateHash: picker.expectedStateHash,
      emergencyStopVersion: picker.emergencyStopVersion,
      targetLevel: 'full' as const,
    }

    await expect(fixture.service.settlePermissionSelection({
      ...selection,
      cardMessageId: 'om_copied_card',
    })).rejects.toMatchObject({ code: 'missing-binding' })
    const accepted = await fixture.service.settlePermissionSelection(selection)
    expect(accepted).toMatchObject({ duplicate: false, status: 'queued' })
    await drive(fixture.service)

    const events = activeSessionEvents(fixture.service, saved)
    expect(lastSandboxMode(events)).toBe('danger-full-access')
    expect(effectiveApprovalPolicy(events)).toBe('never')
    expect(approvalReviewerOf(events)).toBe('none')
    expect(fixture.sends.at(-1)?.text).toContain('已切换到 完全访问权限（full）')

    await expect(fixture.service.settlePermissionSelection(selection)).resolves.toMatchObject({
      duplicate: true,
      status: 'processed',
    })
    await expect(fixture.service.settlePermissionSelection({ ...selection, targetLevel: 'ask' }))
      .rejects.toMatchObject({ code: 'idempotency-conflict' })
    await fixture.ctx.fiber.restart()
  })

  test('a permission picker callback cannot cross a concurrent /new generation boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permission-picker-new-race-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await permissionRuntimeHarness(root, saved, {})
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    const cardEventId = 'evt-permission-picker-before-new'
    await fixture.service.acceptInbound(message(cardEventId, '/permissions', 'command'))
    await drive(fixture.service)

    const picker = fixture.sends.at(-1)?.permissionPicker
    const oldBinding = runtimeStore(fixture.service).getActiveBinding(conversation)!
    if (picker === undefined) throw new Error('permission picker fixture is missing')
    const selection = {
      operationId: picker.operationId,
      callbackEventId: 'callback-permission-picker-during-new',
      callbackChatId: conversation.chat,
      cardMessageId: replyProviderMessageId(fixture.service, cardEventId),
      bindingId: oldBinding.id,
      bindingVersion: picker.bindingVersion,
      sessionId: picker.sessionId,
      principal,
      issuedAt: picker.issuedAt,
      expiresAt: picker.expiresAt,
      expectedStateHash: picker.expectedStateHash,
      emergencyStopVersion: picker.emergencyStopVersion,
      targetLevel: 'full' as const,
    }

    const originalCreate = fixture.ctx.agents.create.bind(fixture.ctx.agents)
    let markCreateStarted!: () => void
    let releaseCreate!: () => void
    const createStarted = new Promise<void>(resolve => { markCreateStarted = resolve })
    const createGate = new Promise<void>(resolve => { releaseCreate = resolve })
    const create = vi.spyOn(fixture.ctx.agents, 'create').mockImplementationOnce(async input => {
      markCreateStarted()
      await createGate
      return await originalCreate(input)
    })
    try {
      const reset = fixture.service.acceptInbound(message('evt-new-racing-permission-picker', '/new', 'command'))
      await createStarted
      let selectionSettled = false
      const settlement = fixture.service.settlePermissionSelection(selection).finally(() => {
        selectionSettled = true
      })
      await Promise.resolve()
      expect(selectionSettled).toBe(false)

      releaseCreate()
      await expect(reset).resolves.toMatchObject({ status: 'queued' })
      await expect(settlement).rejects.toMatchObject({ code: 'missing-binding' })
      const active = runtimeStore(fixture.service).getActiveBinding(conversation)!
      expect(active).toMatchObject({ generation: 2 })
      expect(active.id).not.toBe(oldBinding.id)
      expect(runtimeStore(fixture.service).getInboxByProviderEvent(
        'lark',
        'bot-1',
        selection.cardMessageId,
      )).toMatchObject({ status: 'dead_letter' })
    } finally {
      releaseCreate()
      create.mockRestore()
      await fixture.ctx.fiber.restart()
    }
  })

  test('a permission picker queued before expiry cannot elevate after its durable Inbox is delayed past expiry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permission-picker-delayed-expiry-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await permissionRuntimeHarness(root, saved, {})
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    const cardEventId = 'evt-permission-picker-delayed-expiry'
    await fixture.service.acceptInbound(message(cardEventId, '/permissions', 'command'))
    await drive(fixture.service)

    const picker = fixture.sends.at(-1)?.permissionPicker
    const binding = runtimeStore(fixture.service).getActiveBinding(conversation)!
    if (picker === undefined) throw new Error('permission picker fixture is missing')
    const accepted = await fixture.service.settlePermissionSelection({
      operationId: picker.operationId,
      callbackEventId: 'callback-permission-picker-delayed-expiry',
      callbackChatId: conversation.chat,
      cardMessageId: replyProviderMessageId(fixture.service, cardEventId),
      bindingId: binding.id,
      bindingVersion: picker.bindingVersion,
      sessionId: picker.sessionId,
      principal,
      issuedAt: picker.issuedAt,
      expiresAt: picker.expiresAt,
      expectedStateHash: picker.expectedStateHash,
      emergencyStopVersion: picker.emergencyStopVersion,
      targetLevel: 'full',
    })
    expect(accepted).toMatchObject({ status: 'queued' })

    const now = vi.spyOn(Date, 'now').mockReturnValue(picker.expiresAt)
    try {
      await drive(fixture.service)
      const events = activeSessionEvents(fixture.service, saved)
      expect(fixture.permissionPresets!.current(events)).toBe('guarded-dynamic-id')
      expect(lastSandboxMode(events)).not.toBe('danger-full-access')
      expect(effectiveApprovalPolicy(events) ?? 'ask').toBe('ask')
      expect(approvalReviewerOf(events)).toBe('user')
      expect(fixture.sends.at(-1)?.text).toContain('权限卡片已过期')
    } finally {
      now.mockRestore()
      await fixture.ctx.fiber.restart()
    }
  })

  test('a permission picker rechecks expiry after a held session resume and before its first mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permission-picker-resume-expiry-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await permissionRuntimeHarness(root, saved, {})
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    const cardEventId = 'evt-permission-picker-resume-expiry'
    await fixture.service.acceptInbound(message(cardEventId, '/permissions', 'command'))
    await drive(fixture.service)

    const picker = fixture.sends.at(-1)?.permissionPicker
    const binding = runtimeStore(fixture.service).getActiveBinding(conversation)!
    if (picker === undefined) throw new Error('permission picker fixture is missing')
    await fixture.service.settlePermissionSelection({
      operationId: picker.operationId,
      callbackEventId: 'callback-permission-picker-resume-expiry',
      callbackChatId: conversation.chat,
      cardMessageId: replyProviderMessageId(fixture.service, cardEventId),
      bindingId: binding.id,
      bindingVersion: picker.bindingVersion,
      sessionId: picker.sessionId,
      principal,
      issuedAt: picker.issuedAt,
      expiresAt: picker.expiresAt,
      expectedStateHash: picker.expectedStateHash,
      emergencyStopVersion: picker.emergencyStopVersion,
      targetLevel: 'full',
    })

    const originalResume = fixture.ctx.agents.resume.bind(fixture.ctx.agents)
    let releaseResume!: () => void
    let markResumeStarted!: () => void
    const resumeGate = new Promise<void>(resolve => { releaseResume = resolve })
    const resumeStarted = new Promise<void>(resolve => { markResumeStarted = resolve })
    let clock = picker.expiresAt - 1
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const resume = vi.spyOn(fixture.ctx.agents, 'resume').mockImplementationOnce(async input => {
      markResumeStarted()
      await resumeGate
      return await originalResume(input)
    })
    try {
      await fixture.service.tick()
      await resumeStarted
      clock = picker.expiresAt
      releaseResume()
      await fixture.service.whenIdle()
      await fixture.service.tick()
      await fixture.service.whenIdle()

      const events = activeSessionEvents(fixture.service, saved)
      expect(fixture.permissionPresets!.current(events)).toBe('guarded-dynamic-id')
      expect(lastSandboxMode(events)).not.toBe('danger-full-access')
      expect(effectiveApprovalPolicy(events) ?? 'ask').toBe('ask')
      expect(approvalReviewerOf(events)).toBe('user')
      expect(fixture.sends.at(-1)?.text).toContain('权限卡片已过期')
    } finally {
      releaseResume()
      resume.mockRestore()
      now.mockRestore()
      await fixture.ctx.fiber.restart()
    }
  })

  test('replaying a permission picker whose durable Inbox failed reports a conflict instead of success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permission-picker-dead-letter-replay-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await permissionRuntimeHarness(root, saved, {})
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    const cardEventId = 'evt-permission-picker-dead-letter-replay'
    await fixture.service.acceptInbound(message(cardEventId, '/permissions', 'command'))
    await drive(fixture.service)

    const picker = fixture.sends.at(-1)?.permissionPicker
    const binding = runtimeStore(fixture.service).getActiveBinding(conversation)!
    if (picker === undefined) throw new Error('permission picker fixture is missing')
    const selection = {
      operationId: picker.operationId,
      callbackEventId: 'callback-permission-picker-dead-letter-replay',
      callbackChatId: conversation.chat,
      cardMessageId: replyProviderMessageId(fixture.service, cardEventId),
      bindingId: binding.id,
      bindingVersion: picker.bindingVersion,
      sessionId: picker.sessionId,
      principal,
      issuedAt: picker.issuedAt,
      expiresAt: picker.expiresAt,
      expectedStateHash: picker.expectedStateHash,
      emergencyStopVersion: picker.emergencyStopVersion,
      targetLevel: 'full' as const,
    }
    const accepted = await fixture.service.settlePermissionSelection(selection)
    runtimeStore(fixture.service).deadLetterInbox(accepted.inboxId, 'test-permission-failure')

    await expect(fixture.service.settlePermissionSelection(selection)).rejects.toMatchObject({
      code: 'runtime-conflict',
    })
    await fixture.ctx.fiber.restart()
  })

  test('an old permission picker cannot overwrite a newer textual permission choice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permission-picker-stale-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await permissionRuntimeHarness(root, saved, {})
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    const cardEventId = 'evt-permission-picker-stale-card'
    await fixture.service.acceptInbound(message(cardEventId, '/permissions', 'command'))
    await drive(fixture.service)
    const picker = fixture.sends.at(-1)?.permissionPicker
    const binding = runtimeStore(fixture.service).getActiveBinding(conversation)!
    if (picker === undefined) throw new Error('permission picker fixture is missing')

    await fixture.service.acceptInbound(message('evt-permission-picker-newer-auto', '/permission auto', 'command'))
    await drive(fixture.service)
    expect(approvalReviewerOf(activeSessionEvents(fixture.service, saved))).toBe('auto-review')

    await fixture.service.settlePermissionSelection({
      operationId: picker.operationId,
      callbackEventId: 'callback-permission-picker-stale-full',
      callbackChatId: conversation.chat,
      cardMessageId: replyProviderMessageId(fixture.service, cardEventId),
      bindingId: binding.id,
      bindingVersion: picker.bindingVersion,
      sessionId: picker.sessionId,
      principal,
      issuedAt: picker.issuedAt,
      expiresAt: picker.expiresAt,
      expectedStateHash: picker.expectedStateHash,
      emergencyStopVersion: picker.emergencyStopVersion,
      targetLevel: 'full',
    })
    await drive(fixture.service)

    const events = activeSessionEvents(fixture.service, saved)
    expect(lastSandboxMode(events)).toBe('workspace-write')
    expect(effectiveApprovalPolicy(events) ?? 'ask').toBe('ask')
    expect(approvalReviewerOf(events)).toBe('auto-review')
    expect(fixture.sends.at(-1)?.text).toContain('权限卡片已过期或状态已变化')
    await fixture.ctx.fiber.restart()
  })

  test('/permission adopts an explicit native full preset that predates reviewer events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permissions-native-full-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const first = await permissionRuntimeHarness(root, saved, {})
    const pairing = first.service.issuePairing('test', principal)
    first.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    await first.service.acceptInbound(message('evt-native-full-seed', 'create the durable owner session'))
    await drive(first.service)
    const binding = runtimeStore(first.service).getActiveBinding(conversation)!
    await first.ctx.fiber.restart()

    const persisted = saved.get(binding.sessionId)!
    const nativeFull = nativeFullEvents(persisted)
    expect(approvalReviewerOf(nativeFull)).toBe('user')
    saved.set(binding.sessionId, { header: persisted.header, events: nativeFull })

    const restarted = await permissionRuntimeHarness(root, saved, {})
    await restarted.service.acceptInbound(message('evt-native-full-show', '/permission', 'command'))
    await drive(restarted.service)

    const reconciled = activeSessionEvents(restarted.service, saved)
    expect(restarted.sends.at(-1)?.text).toContain('当前权限：完全访问权限（full）')
    expect(approvalReviewerOf(reconciled)).toBe('none')
    expect(reconciled.filter(event => event.type === 'assistant-policy/approval-reviewer')).toEqual([
      expect.objectContaining({ data: { reviewer: 'none' } }),
    ])
    expect(lastPermissionPreset(reconciled)).toBe('unlocked-dynamic-id')
    expect(lastSandboxMode(reconciled)).toBe('danger-full-access')
    expect(effectiveApprovalPolicy(reconciled)).toBe('never')
    await restarted.ctx.fiber.restart()
  })

  test.each([
    ['permission command', '/permissions', 'command', 'permission-reviewer-reader-unavailable'],
    ['ordinary turn', 'continue the legacy full session', 'text', 'agent-resume-failed'],
  ] as const)(
    'legacy native-full adoption blocks a %s until its reviewer reader is proven',
    async (_kind, text, kind, failureCode) => {
      let clock = 16_000
      const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
      const root = await mkdtemp(join(tmpdir(), `assistant-delivery-native-full-reader-${kind}-`))
      roots.push(root)
      const saved = new Map<string, SavedSession>()
      const first = await permissionRuntimeHarness(root, saved, {})
      const pairing = first.service.issuePairing('test', principal)
      first.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
      await first.service.acceptInbound(message(`evt-native-full-reader-${kind}-seed`, 'create the owner session'))
      await drive(first.service)
      const binding = runtimeStore(first.service).getActiveBinding(conversation)!
      await first.ctx.fiber.restart()

      const persisted = saved.get(binding.sessionId)!
      saved.set(binding.sessionId, { header: persisted.header, events: nativeFullEvents(persisted) })
      const restarted = await permissionRuntimeHarness(root, saved, {})
      const restoreReader = suspendApprovalReviewerReader(restarted.ctx)
      const accepted = await restarted.service.acceptInbound(
        message(`evt-native-full-reader-${kind}`, text, kind),
      )
      try {
        await restarted.service.tick()
        await restarted.service.whenIdle()
        const waiting = runtimeStore(restarted.service).getInbox(accepted.inboxId)
        expect(waiting).toMatchObject({ status: 'retry_wait', failureCode })
        expect(activeSessionEvents(restarted.service, saved)
          .filter(event => event.type === 'assistant-policy/approval-reviewer')).toEqual([])
        expect(restarted.llm.requests).toEqual([])
        expect(restarted.sends).toEqual([])
        if (waiting?.nextAttemptAt === undefined) throw new Error('legacy reviewer reader retry is missing')

        restoreReader()
        clock = waiting.nextAttemptAt
        await drive(restarted.service)
        expect(runtimeStore(restarted.service).getInbox(accepted.inboxId)).toMatchObject({ status: 'processed' })
        const events = activeSessionEvents(restarted.service, saved)
        expect(approvalReviewerOf(events)).toBe('none')
        expect(events.filter(event => event.type === 'assistant-policy/approval-reviewer')).toEqual([
          expect.objectContaining({ data: { reviewer: 'none' } }),
        ])
        if (kind === 'text') expect(restarted.llm.requests).toHaveLength(1)
        else expect(restarted.sends.at(-1)?.text).toContain('完全访问权限（full）')
      } finally {
        restoreReader()
        now.mockRestore()
        await restarted.ctx.fiber.restart()
      }
    },
  )

  test('fresh native full defaults persist reviewer none before the first ordinary Agent turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permissions-native-full-fresh-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await permissionRuntimeHarness(root, saved, {
      seedDefaultPreset: 'unlocked-dynamic-id',
    })
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    await fixture.service.acceptInbound(message('evt-native-full-fresh', 'run the first full-access turn'))
    await drive(fixture.service)

    const events = activeSessionEvents(fixture.service, saved)
    expect(fixture.llm.requests).toHaveLength(1)
    expect(approvalReviewerOf(events)).toBe('none')
    expect(events.filter(event => event.type === 'assistant-policy/approval-reviewer')).toEqual([
      expect.objectContaining({ data: { reviewer: 'none' } }),
    ])
    await fixture.ctx.fiber.restart()
  })

  test('fresh dynamic native-full session creation waits for reviewer reader proof before its first flush', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permissions-native-full-create-reader-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await permissionRuntimeHarness(root, saved, {
      seedDefaultPreset: 'unlocked-dynamic-id',
    })
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    const restoreReader = suspendApprovalReviewerReader(fixture.ctx)
    const event = message('evt-native-full-create-reader', 'create only after the reviewer reader is proven')
    try {
      await expect(fixture.service.acceptInbound(event)).rejects.toThrow(/reader.*proven|reader readiness/i)
      expect(runtimeStore(fixture.service).getActiveBinding(conversation)).toBeUndefined()
      expect([...saved.values()].flatMap(session => session.events)
        .filter(item => item.type === 'assistant-policy/approval-reviewer')).toEqual([])

      restoreReader()
      await fixture.service.acceptInbound(event)
      await drive(fixture.service)
      const events = activeSessionEvents(fixture.service, saved)
      expect(approvalReviewerOf(events)).toBe('none')
      expect(events.filter(item => item.type === 'assistant-policy/approval-reviewer')).toEqual([
        expect.objectContaining({ data: { reviewer: 'none' } }),
      ])
    } finally {
      restoreReader()
      await fixture.ctx.fiber.restart()
    }
  })

  test('waits for the shared Policy native-full migration and honors its conservative compensation', async () => {
    let clock = 17_000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permissions-native-full-barrier-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const first = await permissionRuntimeHarness(root, saved, {})
    const pairing = first.service.issuePairing('test', principal)
    first.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    await first.service.acceptInbound(message('evt-native-full-barrier-seed', 'create the durable owner session'))
    await drive(first.service)
    const binding = runtimeStore(first.service).getActiveBinding(conversation)!
    await first.ctx.fiber.restart()

    const persisted = saved.get(binding.sessionId)!
    saved.set(binding.sessionId, { header: persisted.header, events: nativeFullEvents(persisted) })
    const restarted = await permissionRuntimeHarness(root, saved, {})
    const store = runtimeStore(restarted.service)
    const markDispatching = vi.spyOn(store, 'markInboxDispatching')
    const logsAtFlush: SessionEvent[][] = []
    let releaseFlush!: () => void
    let markFlushStarted!: () => void
    const flushGate = new Promise<void>(resolve => { releaseFlush = resolve })
    const flushStarted = new Promise<void>(resolve => { markFlushStarted = resolve })
    const flush = vi.spyOn(restarted.ctx.sessions, 'flush')
      .mockImplementationOnce(async session => {
        logsAtFlush.push([...session.events])
        markFlushStarted()
        await flushGate
        return false
      })

    const accepted = await restarted.service.acceptInbound(
      message('evt-native-full-barrier', 'do not execute before the reviewer migration is durable'),
    )
    await restarted.service.tick()
    await flushStarted

    expect(restarted.llm.requests).toHaveLength(0)
    expect(markDispatching).not.toHaveBeenCalled()
    releaseFlush()
    await restarted.service.whenIdle()
    await restarted.service.tick()
    await restarted.service.whenIdle()

    expect(logsAtFlush).toHaveLength(1)
    expect(approvalReviewerOf(logsAtFlush[0]!)).toBe('none')
    expect(lastSandboxMode(logsAtFlush[0]!)).toBe('danger-full-access')
    expect(effectiveApprovalPolicy(logsAtFlush[0]!)).toBe('never')
    const waiting = store.getInbox(accepted.inboxId)
    expect(waiting).toMatchObject({ status: 'retry_wait', failureCode: 'agent-resume-failed' })
    expect(restarted.llm.requests).toHaveLength(0)
    const compensated = activeSessionEvents(restarted.service, saved)
    expect(approvalReviewerOf(compensated)).toBe('user')
    expect(compensated.filter(event => event.type === 'assistant-policy/approval-reviewer').map(event => event.data))
      .toEqual([{ reviewer: 'none' }, { reviewer: 'user' }])
    if (waiting?.nextAttemptAt === undefined) throw new Error('native full reconciliation retry is missing')
    clock = waiting.nextAttemptAt
    await drive(restarted.service)
    expect(store.getInbox(accepted.inboxId)).toMatchObject({ status: 'processed' })
    expect(restarted.llm.requests).toHaveLength(1)
    flush.mockRestore()
    now.mockRestore()
    await restarted.ctx.fiber.restart()
  })

  test.each(['user', 'corrupt-reviewer'] as const)(
    'native full adoption never overwrites an existing %s reviewer event', async reviewer => {
    const root = await mkdtemp(join(tmpdir(), `assistant-delivery-permissions-native-full-${reviewer}-`))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const first = await permissionRuntimeHarness(root, saved, {})
    const pairing = first.service.issuePairing('test', principal)
    first.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    await first.service.acceptInbound(message('evt-native-full-malformed-seed', 'create the durable owner session'))
    await drive(first.service)
    const binding = runtimeStore(first.service).getActiveBinding(conversation)!
    await first.ctx.fiber.restart()

    const persisted = saved.get(binding.sessionId)!
    const full = nativeFullEvents(persisted)
    const existingReviewer = {
      type: 'assistant-policy/approval-reviewer',
      seq: full.length,
      time: Date.now(),
      data: { reviewer },
    } as unknown as SessionEvent
    saved.set(binding.sessionId, { header: persisted.header, events: [...full, existingReviewer] })

    const restarted = await permissionRuntimeHarness(root, saved, {})
    await restarted.service.acceptInbound(message('evt-native-full-malformed', '/permission', 'command'))
    await drive(restarted.service)

    const events = activeSessionEvents(restarted.service, saved)
    expect(restarted.sends.at(-1)?.text).toContain('当前权限：自定义安全组合（custom）')
    expect(events.filter(event => event.type === 'assistant-policy/approval-reviewer')).toEqual([existingReviewer])
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
    expect(approvalNever).toBeGreaterThanOrEqual(0)
    expect(sandboxDanger).toBeGreaterThan(approvalNever)
    expect(reviewerNone).toBeGreaterThan(sandboxDanger)
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
    expect(reviewerUser).toBe(-1)
    expect(lastPermissionPreset(downgraded)).toBe('guarded-dynamic-id')
    expect(approvalReviewerOf(downgraded)).toBe('user')
    expect(fixture.llm.requests).toHaveLength(0)
    await fixture.ctx.fiber.restart()
  })

  test('canonical permission presets derive reviewer state without waiting for the custom-event reader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permissions-canonical-reader-bypass-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await permissionRuntimeHarness(root, saved, { presets: canonicalPermissionPresets })
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    await fixture.service.acceptInbound(message('evt-canonical-reader-seed', '/permission full', 'command'))
    await drive(fixture.service)
    const restoreReader = suspendApprovalReviewerReader(fixture.ctx)
    const accepted = await fixture.service.acceptInbound(
      message('evt-canonical-reader-full', '/permission full confirm', 'command'),
    )
    try {
      await drive(fixture.service)
      expect(runtimeStore(fixture.service).getInbox(accepted.inboxId)).toMatchObject({ status: 'processed' })
      const events = activeSessionEvents(fixture.service, saved)
      expect(fixture.permissionPresets!.current(events)).toBe('danger-full-access')
      expect(lastSandboxMode(events)).toBe('danger-full-access')
      expect(effectiveApprovalPolicy(events)).toBe('never')
      expect(approvalReviewerOf(events)).toBe('none')
      expect(events.filter(event => event.type === 'assistant-policy/approval-reviewer')).toEqual([])
    } finally {
      restoreReader()
      await fixture.ctx.fiber.restart()
    }
  })

  test('/permission reconciles a held-flush lease loss without replaying full ahead of a later ask', async () => {
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
      await fixture.service.tick()
      await fixture.service.whenIdle()
      expect(store.getInbox(full.inboxId)).toMatchObject({
        status: 'processed',
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

  test.each(['false', 'throw'] as const)(
    '/stop durably recovers a flushed full switch when compensation flush returns %s',
    async compensationFailure => {
      let clock = 10_000
      const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
      const root = await mkdtemp(join(tmpdir(), `assistant-delivery-permission-stop-${compensationFailure}-`))
      roots.push(root)
      const saved = new Map<string, SavedSession>()
      const fixture = await permissionRuntimeHarness(root, saved, {})
      const pairing = fixture.service.issuePairing('test', principal)
      fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
      await fixture.service.acceptInbound(message('evt-permission-stop-seed', '/permission full', 'command'))
      await drive(fixture.service)

      const sessions = fixture.ctx.sessions
      const originalFlush = sessions.flush.bind(sessions)
      let releaseDurableFull!: () => void
      let markDurableFull!: () => void
      const durableFull = new Promise<void>(resolve => { markDurableFull = resolve })
      const flushGate = new Promise<void>(resolve => { releaseDurableFull = resolve })
      const flush = vi.spyOn(sessions, 'flush')
        .mockImplementationOnce(async session => {
          const result = await originalFlush(session)
          markDurableFull()
          await flushGate
          return result
        })
        .mockImplementationOnce(async () => {
          if (compensationFailure === 'throw') throw new Error('compensation persistence unavailable')
          return false
        })
      const runtime = (fixture.service as unknown as {
        runtime: { cancelActive(binding: ConversationBinding, command: 'new' | 'stop'): Promise<boolean> }
      }).runtime
      const cancel = vi.spyOn(runtime, 'cancelActive')
      const full = await fixture.service.acceptInbound(
        message(`evt-permission-stop-full-${compensationFailure}`, '/permission full confirm', 'command'),
      )
      let reopened: Awaited<ReturnType<typeof permissionRuntimeHarness>> | undefined
      let firstClosed = false
      try {
        await fixture.service.tick()
        await durableFull
        const stopPromise = fixture.service.acceptInbound(
          message(`evt-permission-stop-command-${compensationFailure}`, '/stop', 'command'),
        )
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith(
          expect.anything(), 'stop',
        ))
        releaseDurableFull()
        const stop = await stopPromise
        await fixture.service.whenIdle()

        const interrupted = runtimeStore(fixture.service).getInbox(full.inboxId)
        expect(interrupted).toMatchObject({
          status: 'retry_wait',
          failureCode: 'permission-cancelled-recovery',
        })
        if (interrupted?.nextAttemptAt === undefined) throw new Error('permission recovery retry is missing')
        // The first full flush is the only durable session snapshot: both
        // compensation attempts failed. Reopen the complete runtime so the
        // recovery cannot accidentally reuse its in-memory ask events.
        expectSafeFullPermission(fixture.permissionPresets!, activeSessionEvents(fixture.service, saved))
        cancel.mockRestore()
        flush.mockRestore()
        await fixture.ctx.fiber.restart()
        firstClosed = true

        clock = interrupted.nextAttemptAt
        reopened = await permissionRuntimeHarness(root, saved, {})
        const recoveryFlush = vi.spyOn(reopened.ctx.sessions, 'flush')
          .mockImplementationOnce(async () => {
            if (compensationFailure === 'throw') throw new Error('cold compensation persistence unavailable')
            return false
          })
        await reopened.service.tick()
        await reopened.service.whenIdle()

        const stillInterrupted = runtimeStore(reopened.service).getInbox(full.inboxId)
        expect(stillInterrupted).toMatchObject({
          status: 'retry_wait',
          failureCode: 'permission-cancelled-recovery',
        })
        expectSafeFullPermission(reopened.permissionPresets!, activeSessionEvents(reopened.service, saved))
        expect(reopened.sends.some(send => send.text.includes('权限切换已停止'))).toBe(false)
        if (stillInterrupted?.nextAttemptAt === undefined) throw new Error('permission recovery retry was terminalized')

        recoveryFlush.mockRestore()
        clock = stillInterrupted.nextAttemptAt
        await drive(reopened.service)

        const waitingStop = runtimeStore(reopened.service).getInbox(stop.inboxId)
        if (waitingStop?.status === 'retry_wait') {
          if (waitingStop.nextAttemptAt === undefined) throw new Error('stop retry is missing')
          clock = waitingStop.nextAttemptAt
          await drive(reopened.service)
        }
        await reopened.service.tick()
        await reopened.service.whenIdle()

        expect(runtimeStore(reopened.service).getInbox(full.inboxId)).toMatchObject({ status: 'processed' })
        expect(runtimeStore(reopened.service).getInbox(stop.inboxId)).toMatchObject({ status: 'processed' })
        expectSafeAskPermission(reopened.permissionPresets!, activeSessionEvents(reopened.service, saved))
        expect(reopened.sends.some(send => send.text.includes('权限切换已停止'))).toBe(true)
        expect(reopened.sends.some(send => send.text.includes('已处理停止请求'))).toBe(true)
      } finally {
        releaseDurableFull()
        if (!firstClosed) {
          cancel.mockRestore()
          flush.mockRestore()
          await fixture.ctx.fiber.restart()
        }
        await reopened?.ctx.fiber.restart()
        now.mockRestore()
      }
    },
  )

  test.each([
    ['full', '/permission full confirm'],
    ['auto', '/permission auto'],
  ] as const)(
    'a dynamic %s switch waits for reviewer reader proof and keeps failed compensation retryable',
    async (level, command) => {
      let clock = 18_000
      const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
      const root = await mkdtemp(join(tmpdir(), `assistant-delivery-permission-reader-${level}-`))
      roots.push(root)
      const saved = new Map<string, SavedSession>()
      const fixture = await permissionRuntimeHarness(root, saved, {})
      const pairing = fixture.service.issuePairing('test', principal)
      fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
      await fixture.service.acceptInbound(message(`evt-permission-reader-${level}-seed`, '/permission full', 'command'))
      await drive(fixture.service)
      const sendsBefore = fixture.sends.length
      const restoreReader = suspendApprovalReviewerReader(fixture.ctx)
      const accepted = await fixture.service.acceptInbound(
        message(`evt-permission-reader-${level}`, command, 'command'),
      )
      try {
        await fixture.service.tick()
        await fixture.service.whenIdle()
        const waiting = runtimeStore(fixture.service).getInbox(accepted.inboxId)
        expect(waiting).toMatchObject({
          status: 'retry_wait',
          failureCode: 'permission-failure-notice-recovery',
        })
        expectSafeAskPermission(fixture.permissionPresets!, activeSessionEvents(fixture.service, saved))
        expect(activeSessionEvents(fixture.service, saved)
          .filter(event => event.type === 'assistant-policy/approval-reviewer')).toEqual([])
        expect(fixture.sends).toHaveLength(sendsBefore)
        if (waiting?.nextAttemptAt === undefined) throw new Error('reviewer reader recovery retry is missing')

        restoreReader()
        clock = waiting.nextAttemptAt
        await drive(fixture.service)
        expect(runtimeStore(fixture.service).getInbox(accepted.inboxId)).toMatchObject({ status: 'processed' })
        expectSafeAskPermission(fixture.permissionPresets!, activeSessionEvents(fixture.service, saved))
        expect(fixture.sends.at(-1)?.text).toContain('权限切换未完成')
      } finally {
        restoreReader()
        now.mockRestore()
        await fixture.ctx.fiber.restart()
      }
    },
  )

  test('permission compensation waits for reader proof before appending a dynamic ask reviewer', async () => {
    let clock = 19_000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permission-reader-compensation-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await permissionRuntimeHarness(root, saved, {})
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    await fixture.service.acceptInbound(message('evt-permission-reader-compensation-seed', '/permission auto', 'command'))
    await drive(fixture.service)
    const before = activeSessionEvents(fixture.service, saved)
    expect(approvalReviewerOf(before)).toBe('auto-review')
    const sendsBefore = fixture.sends.length
    const restoreReader = suspendApprovalReviewerReader(fixture.ctx)
    const accepted = await fixture.service.acceptInbound(
      message('evt-permission-reader-compensation', '/permission ask', 'command'),
    )
    try {
      await fixture.service.tick()
      await fixture.service.whenIdle()
      const waiting = runtimeStore(fixture.service).getInbox(accepted.inboxId)
      expect(waiting).toMatchObject({
        status: 'retry_wait',
        failureCode: 'permission-failure-notice-recovery',
      })
      const held = activeSessionEvents(fixture.service, saved)
      expect(approvalReviewerOf(held)).toBe('auto-review')
      expect(held.filter(event => event.type === 'assistant-policy/approval-reviewer').map(event => event.data))
        .toEqual([{ reviewer: 'auto-review' }])
      expect(fixture.sends).toHaveLength(sendsBefore)
      if (waiting?.nextAttemptAt === undefined) throw new Error('reviewer compensation retry is missing')

      restoreReader()
      clock = waiting.nextAttemptAt
      await drive(fixture.service)
      expect(runtimeStore(fixture.service).getInbox(accepted.inboxId)).toMatchObject({ status: 'processed' })
      const compensated = activeSessionEvents(fixture.service, saved)
      expectSafeAskPermission(fixture.permissionPresets!, compensated)
      expect(compensated.filter(event => event.type === 'assistant-policy/approval-reviewer').map(event => event.data))
        .toEqual([{ reviewer: 'auto-review' }, { reviewer: 'user' }])
      expect(fixture.sends.at(-1)?.text).toContain('权限切换未完成')
    } finally {
      restoreReader()
      now.mockRestore()
      await fixture.ctx.fiber.restart()
    }
  })

  test('a transient failure-notice enqueue is retried from ask without replaying full', async () => {
    let clock = 20_000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permission-failure-notice-retry-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await permissionRuntimeHarness(root, saved, {})
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    await fixture.service.acceptInbound(message('evt-permission-notice-seed', '/permission full', 'command'))
    await drive(fixture.service)
    const sendsBeforeSwitch = fixture.sends.length

    const sessions = fixture.ctx.sessions
    const originalFlush = sessions.flush.bind(sessions)
    const flush = vi.spyOn(sessions, 'flush')
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(session => originalFlush(session))
    const internal = fixture.service as unknown as {
      replyCommand(binding: ConversationBinding, input: unknown): unknown
    }
    const replyCommand = vi.spyOn(internal, 'replyCommand')
      .mockImplementationOnce(() => { throw new Error('temporary Outbox enqueue failure') })
    const switched = await fixture.service.acceptInbound(
      message('evt-permission-failure-notice-retry', '/permission full confirm', 'command'),
    )
    try {
      await fixture.service.tick()
      await fixture.service.whenIdle()
      const waiting = runtimeStore(fixture.service).getInbox(switched.inboxId)
      expect(waiting).toMatchObject({
        status: 'retry_wait',
        failureCode: 'permission-failure-notice-recovery',
      })
      expectSafeAskPermission(fixture.permissionPresets!, activeSessionEvents(fixture.service, saved))
      if (waiting?.nextAttemptAt === undefined) throw new Error('permission notice retry is missing')
      clock = waiting.nextAttemptAt
      await drive(fixture.service)

      expect(runtimeStore(fixture.service).getInbox(switched.inboxId)).toMatchObject({ status: 'processed' })
      expectSafeAskPermission(fixture.permissionPresets!, activeSessionEvents(fixture.service, saved))
      expect(fixture.sends).toHaveLength(sendsBeforeSwitch + 1)
      expect(fixture.sends.at(-1)?.text).toContain('权限切换未完成')
    } finally {
      replyCommand.mockRestore()
      flush.mockRestore()
      now.mockRestore()
      await fixture.ctx.fiber.restart()
    }
  })

  test('permission recovery preserves its marker across a missing dependency and reply authorization denial', async () => {
    let clock = 22_000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permission-recovery-preflight-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const first = await permissionRuntimeHarness(root, saved, {})
    const pairing = first.service.issuePairing('test', principal)
    first.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    await first.service.acceptInbound(message('evt-permission-recovery-preflight-seed', '/permission full', 'command'))
    await drive(first.service)

    const sessions = first.ctx.sessions
    const originalFlush = sessions.flush.bind(sessions)
    const flush = vi.spyOn(sessions, 'flush')
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(session => originalFlush(session))
    const internal = first.service as unknown as {
      replyCommand(binding: ConversationBinding, input: unknown): unknown
    }
    const replyCommand = vi.spyOn(internal, 'replyCommand')
      .mockImplementationOnce(() => { throw new Error('seed recovery marker') })
    const accepted = await first.service.acceptInbound(
      message('evt-permission-recovery-preflight', '/permission full confirm', 'command'),
    )
    let missing: Awaited<ReturnType<typeof permissionRuntimeHarness>> | undefined
    let denied: Awaited<ReturnType<typeof permissionRuntimeHarness>> | undefined
    let recovered: Awaited<ReturnType<typeof permissionRuntimeHarness>> | undefined
    try {
      await first.service.tick()
      await first.service.whenIdle()
      const seeded = runtimeStore(first.service).getInbox(accepted.inboxId)
      expect(seeded).toMatchObject({
        status: 'retry_wait',
        failureCode: 'permission-failure-notice-recovery',
      })
      if (seeded?.nextAttemptAt === undefined) throw new Error('seeded permission recovery retry is missing')
      flush.mockRestore()
      replyCommand.mockRestore()
      clock = seeded.nextAttemptAt
      const resume = vi.spyOn(first.ctx.agents, 'resume')
        .mockRejectedValueOnce(new Error('temporary session resume failure'))
      await first.service.tick()
      await first.service.whenIdle()
      resume.mockRestore()
      const afterResume = runtimeStore(first.service).getInbox(accepted.inboxId)
      expect(afterResume).toMatchObject({
        status: 'retry_wait',
        failureCode: 'permission-failure-notice-recovery',
      })
      if (afterResume?.nextAttemptAt === undefined) throw new Error('resume recovery retry is missing')
      await first.ctx.fiber.restart()

      clock = afterResume.nextAttemptAt
      missing = await permissionRuntimeHarness(root, saved, { provideApproval: false })
      await missing.service.tick()
      await missing.service.whenIdle()
      const afterMissing = runtimeStore(missing.service).getInbox(accepted.inboxId)
      expect(afterMissing).toMatchObject({
        status: 'retry_wait',
        failureCode: 'permission-failure-notice-recovery',
      })
      expect(missing.sends).toEqual([])
      if (afterMissing?.nextAttemptAt === undefined) throw new Error('dependency recovery retry is missing')
      await missing.ctx.fiber.restart()

      clock = afterMissing.nextAttemptAt
      denied = await permissionRuntimeHarness(root, saved, { allowAgentReply: false })
      await denied.service.tick()
      await denied.service.whenIdle()
      const afterDenied = runtimeStore(denied.service).getInbox(accepted.inboxId)
      expect(afterDenied).toMatchObject({
        status: 'retry_wait',
        failureCode: 'permission-failure-notice-recovery',
      })
      expectSafeAskPermission(denied.permissionPresets!, activeSessionEvents(denied.service, saved))
      expect(denied.sends).toEqual([])
      if (afterDenied?.nextAttemptAt === undefined) throw new Error('authorization recovery retry is missing')
      await denied.ctx.fiber.restart()

      clock = afterDenied.nextAttemptAt
      recovered = await permissionRuntimeHarness(root, saved, {})
      await drive(recovered.service)
      expect(runtimeStore(recovered.service).getInbox(accepted.inboxId)).toMatchObject({ status: 'processed' })
      expectSafeAskPermission(recovered.permissionPresets!, activeSessionEvents(recovered.service, saved))
      expect(recovered.sends.some(send => send.text.includes('权限切换未完成'))).toBe(true)
    } finally {
      flush.mockRestore()
      replyCommand.mockRestore()
      await first.ctx.fiber.restart()
      await missing?.ctx.fiber.restart()
      await denied?.ctx.fiber.restart()
      await recovered?.ctx.fiber.restart()
      now.mockRestore()
    }
  })

  test('a controller revocation after durable full keeps recovery retryable until cold compensation is durable', async () => {
    let clock = 25_000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-permission-controller-recovery-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const fixture = await permissionRuntimeHarness(root, saved, {})
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    await fixture.service.acceptInbound(message('evt-permission-controller-seed', '/permission full', 'command'))
    await drive(fixture.service)

    const internal = fixture.service as unknown as {
      isPermissionController(binding: ConversationBinding, envelope: InboundEnvelope): boolean
    }
    const originalController = internal.isPermissionController.bind(internal)
    let revoked = false
    const controller = vi.spyOn(internal, 'isPermissionController')
      .mockImplementation((binding, envelope) => !revoked && originalController(binding, envelope))
    const sessions = fixture.ctx.sessions
    const originalFlush = sessions.flush.bind(sessions)
    const flush = vi.spyOn(sessions, 'flush')
      .mockImplementationOnce(async session => {
        const result = await originalFlush(session)
        revoked = true
        return result
      })
      .mockResolvedValueOnce(false)
    const accepted = await fixture.service.acceptInbound(
      message('evt-permission-controller-recovery', '/permission full confirm', 'command'),
    )
    let reopened: Awaited<ReturnType<typeof permissionRuntimeHarness>> | undefined
    try {
      await fixture.service.tick()
      await fixture.service.whenIdle()
      const waiting = runtimeStore(fixture.service).getInbox(accepted.inboxId)
      expect(waiting).toMatchObject({
        status: 'retry_wait',
        failureCode: 'permission-failure-notice-recovery',
      })
      expectSafeFullPermission(fixture.permissionPresets!, activeSessionEvents(fixture.service, saved))
      if (waiting?.nextAttemptAt === undefined) throw new Error('controller recovery retry is missing')

      controller.mockRestore()
      flush.mockRestore()
      await fixture.ctx.fiber.restart()
      clock = waiting.nextAttemptAt
      reopened = await permissionRuntimeHarness(root, saved, {})
      await drive(reopened.service)

      expect(runtimeStore(reopened.service).getInbox(accepted.inboxId)).toMatchObject({ status: 'processed' })
      expectSafeAskPermission(reopened.permissionPresets!, activeSessionEvents(reopened.service, saved))
      expect(reopened.sends.some(send => send.text.includes('权限切换未完成'))).toBe(true)
    } finally {
      controller.mockRestore()
      flush.mockRestore()
      await fixture.ctx.fiber.restart()
      await reopened?.ctx.fiber.restart()
      now.mockRestore()
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
      'approval/policy',
      'permission/preset',
      'sandbox/mode',
      'assistant-policy/approval-reviewer',
    ])
    expect(transition[0]?.data).toEqual({ policy: 'never' })
    expect(transition[2]?.data).toEqual({ mode: 'danger-full-access' })
    expect(transition[3]?.data).toEqual({ reviewer: 'none' })
    expect(flush).toHaveBeenCalledTimes(2)
    expectSafeAskPermission(fixture.permissionPresets!, logsAtFlush[1]!)
    expect(fixture.sends).toHaveLength(1)
    expect(fixture.sends[0]?.text).toContain('🟠')
    expect(runtimeStore(fixture.service).getInbox(accepted.inboxId)).toMatchObject({
      status: 'retry_wait',
      failureCode: 'permission-failure-notice-recovery',
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
      status: 'retry_wait',
      failureCode: 'permission-failure-notice-recovery',
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
    expect(fixture.sends).toHaveLength(2)
    expect(fixture.sends.at(-1)?.text).toContain('已安全恢复并持久化')
    expect(runtimeStore(fixture.service).getInbox(accepted.inboxId)).toMatchObject({ status: 'processed' })
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
      status: 'retry_wait',
      failureCode: 'permission-failure-notice-recovery',
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
      cardMessageId: replyProviderMessageId(first.service, 'evt-model-list'),
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

  test('clears a stale persisted reasoning effort before dispatch and uses the live model default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-stale-effort-'))
    roots.push(root)
    const fixture = await runtimeHarness(root, new Map())
    const pairing = fixture.service.issuePairing('test', principal)
    fixture.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    const store = runtimeStore(fixture.service)
    const stale = store.setModelSelection(conversation, {
      provider: 'alternate', model: 'precise', reasoningEffort: 'max',
    })
    expect(stale).toMatchObject({ provider: 'alternate', model: 'precise', reasoningEffort: 'max' })

    await fixture.service.acceptInbound(message('evt-stale-effort', 'continue with the selected model'))
    await drive(fixture.service)

    // `precise` only advertises high in this fixture. The stale max must never
    // reach the Agent request, and DSH may then materialize the live default.
    expect(fixture.alternate.requests).toHaveLength(1)
    expect(fixture.alternate.requests[0]).toMatchObject({
      provider: 'alternate', model: 'precise', reasoningEffort: 'high',
    })
    expect(store.getModelSelection(conversation)).toMatchObject({ provider: 'alternate', model: 'precise' })
    expect(store.getModelSelection(conversation)?.reasoningEffort).toBeUndefined()
    const inbox = runtimeStore(fixture.service).getInboxByProviderEvent('lark', 'bot-1', 'evt-stale-effort')
    expect(inbox).toMatchObject({ status: 'processed' })
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
    const pickerMessageId = replyProviderMessageId(fixture.service, 'evt-picker')
    const copiedCard = {
      operationId: picker.modelPicker!.operationId,
      callbackEventId: 'card-callback-copied',
      callbackChatId: conversation.chat,
      cardMessageId: 'om_copied_card',
      bindingId: picker.bindingId,
      principal,
      provider: 'alternate',
      modelProvider: 'alternate',
      model: 'precise',
      reasoningEffort: 'high',
      expectedRevision: 0,
    } as const
    expect(fixture.service.getModelPickerForCallback({
      operationId: copiedCard.operationId, callbackChatId: copiedCard.callbackChatId,
      cardMessageId: copiedCard.cardMessageId, bindingId: copiedCard.bindingId, principal,
    })).toBeUndefined()
    expect(() => fixture.service.advanceModelPickerForCallback({
      operationId: copiedCard.operationId, callbackChatId: copiedCard.callbackChatId,
      cardMessageId: copiedCard.cardMessageId, bindingId: copiedCard.bindingId, principal,
      expected: { revision: 0, provider: 'mock', model: 'delivery-model' },
      next: { provider: 'alternate', model: 'precise', reasoningEffort: 'high' },
    })).toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    expect(() => fixture.service.settleModelSelection(copiedCard))
      .toThrowError(expect.objectContaining({ code: 'missing-binding' }))

    const mismatchCallback = {
      operationId: picker.modelPicker!.operationId,
      callbackEventId: 'card-callback-mismatch',
      callbackChatId: conversation.chat,
      cardMessageId: pickerMessageId,
      bindingId: picker.bindingId,
      principal,
      provider: 'alternate',
      modelProvider: 'mock',
      model: 'delivery-model',
      reasoningEffort: 'high',
      expectedRevision: 0,
    } as const
    expect(fixture.service.settleModelSelection(mismatchCallback)).toEqual({ status: 'pending' })
    const rejectedWait = fixture.service.awaitModelSelection(
      mismatchCallback, new AbortController().signal,
    )
    await fixture.service.whenIdle()
    expect(await rejectedWait).toEqual({ status: 'rejected', reason: 'provider-model-mismatch' })
    expect(fixture.service.settleModelSelection(mismatchCallback))
      .toEqual({ status: 'rejected', reason: 'provider-model-mismatch' })
    const persistedRejected = fixture.service.settleModelSelection(mismatchCallback)
    expect(persistedRejected).toEqual({ status: 'rejected', reason: 'provider-model-mismatch' })
    await drive(fixture.service)
    expect(fixture.sends.at(-1)?.text).toContain('分组 alternate 与模型 mock/delivery-model 不匹配')
    expect(fixture.sends.filter(send => send.text.includes('分组 alternate 与模型'))).toHaveLength(1)
    expect(fixture.service.settleModelSelection(mismatchCallback)).toEqual(persistedRejected)

    await fixture.service.acceptInbound(message('evt-picker-valid', '/model', 'command'))
    await drive(fixture.service)
    const validPicker = fixture.sends.at(-1)!

    const selectionCallback = {
      operationId: validPicker.modelPicker!.operationId,
      callbackEventId: 'card-callback-1',
      callbackChatId: conversation.chat,
      cardMessageId: replyProviderMessageId(fixture.service, 'evt-picker-valid'),
      bindingId: validPicker.bindingId,
      principal,
      provider: 'alternate',
      modelProvider: 'alternate',
      model: 'precise',
      reasoningEffort: 'high',
      expectedRevision: 0,
    } as const
    expect(fixture.service.settleModelSelection(selectionCallback)).toEqual({ status: 'pending' })
    const selectedWait = fixture.service.awaitModelSelection(
      selectionCallback, new AbortController().signal,
    )
    await fixture.service.whenIdle()
    expect(await selectedWait).toMatchObject({ status: 'selected', selection: {
      provider: 'alternate', model: 'precise', reasoningEffort: 'high',
    } })
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

  test('binds model navigation and selected replay to the original card across restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-model-card-restart-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const first = await runtimeHarness(root, saved)
    const pairing = first.service.issuePairing('test', principal)
    first.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    const cardEventId = 'evt-picker-restart'
    await first.service.acceptInbound(message(cardEventId, '/model', 'command'))
    await drive(first.service)
    const picker = first.sends.at(-1)!
    const cardMessageId = replyProviderMessageId(first.service, cardEventId)
    const bindingId = picker.bindingId
    await first.ctx.fiber.restart()

    const reopened = await runtimeHarness(root, saved)
    const callbackBase = {
      operationId: picker.modelPicker!.operationId,
      callbackChatId: conversation.chat,
      bindingId,
      principal,
    } as const
    expect(reopened.service.getModelPickerForCallback({
      ...callbackBase, cardMessageId: 'om_copied_card',
    })).toBeUndefined()
    expect(() => reopened.service.advanceModelPickerForCallback({
      ...callbackBase,
      cardMessageId: 'om_copied_card',
      expected: { revision: 0, provider: 'mock', model: 'delivery-model' },
      next: { provider: 'alternate', model: 'precise', reasoningEffort: 'high' },
    })).toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    const advanced = reopened.service.advanceModelPickerForCallback({
      ...callbackBase,
      cardMessageId,
      expected: { revision: 0, provider: 'mock', model: 'delivery-model' },
      next: { provider: 'alternate', model: 'precise', reasoningEffort: 'high' },
    })
    expect(advanced).toMatchObject({ applied: true, state: {
      revision: 1, provider: 'alternate', model: 'precise', reasoningEffort: 'high',
    } })
    const selectionCallback = {
      ...callbackBase,
      callbackEventId: 'card-callback-restart',
      cardMessageId,
      provider: 'alternate',
      modelProvider: 'alternate',
      model: 'precise',
      reasoningEffort: 'high',
      expectedRevision: 1,
    } as const
    expect(reopened.service.settleModelSelection(selectionCallback)).toEqual({ status: 'pending' })
    await reopened.service.whenIdle()
    const selected = reopened.service.settleModelSelection(selectionCallback)
    expect(selected).toMatchObject({ status: 'selected', selection: {
      provider: 'alternate', model: 'precise', reasoningEffort: 'high',
    } })
    await reopened.ctx.fiber.restart()

    const replayed = await runtimeHarness(root, saved)
    expect(replayed.service.settleModelSelection(selectionCallback)).toEqual(selected)
    expect(() => replayed.service.settleModelSelection({
      ...selectionCallback, cardMessageId: 'om_copied_card', callbackEventId: 'card-callback-copied',
    })).toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    await replayed.ctx.fiber.restart()
  })

  test('binds a rejected model-selection replay to the original card across restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-model-card-rejected-restart-'))
    roots.push(root)
    const saved = new Map<string, SavedSession>()
    const first = await runtimeHarness(root, saved)
    const pairing = first.service.issuePairing('test', principal)
    first.service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    const cardEventId = 'evt-picker-rejected-restart'
    await first.service.acceptInbound(message(cardEventId, '/model', 'command'))
    await drive(first.service)
    const picker = first.sends.at(-1)!
    const rejectedCallback = {
      operationId: picker.modelPicker!.operationId,
      callbackEventId: 'card-callback-rejected-restart',
      callbackChatId: conversation.chat,
      cardMessageId: replyProviderMessageId(first.service, cardEventId),
      bindingId: picker.bindingId,
      principal,
      provider: 'alternate',
      modelProvider: 'mock',
      model: 'delivery-model',
      reasoningEffort: 'high',
      expectedRevision: 0,
    } as const
    expect(first.service.settleModelSelection(rejectedCallback)).toEqual({ status: 'pending' })
    await first.service.whenIdle()
    const rejected = first.service.settleModelSelection(rejectedCallback)
    expect(rejected).toEqual({ status: 'rejected', reason: 'provider-model-mismatch' })
    await first.ctx.fiber.restart()

    const reopened = await runtimeHarness(root, saved)
    expect(reopened.service.settleModelSelection(rejectedCallback)).toEqual(rejected)
    expect(() => reopened.service.settleModelSelection({
      ...rejectedCallback, cardMessageId: 'om_copied_card', callbackEventId: 'card-callback-copied-rejected',
    })).toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    await reopened.ctx.fiber.restart()
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
      cardMessageId: replyProviderMessageId(fixture.service, 'evt-picker-policy'),
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
      cardMessageId: replyProviderMessageId(fixture.service, 'evt-picker-timeout'),
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
