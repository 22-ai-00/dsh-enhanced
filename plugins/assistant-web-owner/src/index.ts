import type { Agent, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionController as BundledSessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionAddress, SessionControlFrame, SessionCreateRequest, SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller'
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { version } from './version.js'
import { TYPERT } from './typert.js'
import { DeliveryNoticesService } from './notices.js'

export const name = 'dsh-enhanced-assistant-web-owner'
export { version }
export const inject = [...BundledSessionController.inject, 'assistantDelivery', 'typert']

export interface DeliveryNotice {
  readonly id: string
  readonly text: string
  readonly createdAt: number
}

export interface Config {
  readonly principal: Readonly<{ readonly account: string, readonly tenant: string, readonly user: string }>
  readonly workspace: string
  readonly preset: string
  readonly maxExecutionMs?: number
}

/** Trusted Host capability with a fixed pre-paired owner and scope; no raw lease manager is exposed. */
export interface NativeWebOwnerAccess {
  create(options: CreateAgentOptions): Promise<AgentHandle>
  resume(options: ResumeAgentOptions): Promise<AgentHandle>
  get(sessionId: SessionId): Agent | undefined
  assertSession(sessionId: SessionId): void
  ownsSession(sessionId: SessionId): boolean
  notifications(sessionId: SessionId): readonly DeliveryNotice[]
  prompt<T>(input: { readonly sessionId: SessionId, readonly requestId: string, readonly text: string, readonly content: readonly unknown[] }, invoke: () => Promise<T>, signal: AbortSignal): Promise<T>
  dispose(): Promise<void>
}

type DeliveryBridge = { bindNativeWebOwner(ctx: Context, input: { readonly principal: { readonly channel: 'web', readonly account: string, readonly tenant: string, readonly user: string }, readonly workspace: string, readonly preset: string, readonly maxExecutionMs?: number }): NativeWebOwnerAccess }

export const Config: Schema<Config> = Schema.object({
  principal: Schema.object({ account: Schema.string().min(1).required(), tenant: Schema.string().min(1).required(), user: Schema.string().min(1).required() }).required(),
  workspace: Schema.string().min(1).required(),
  preset: Schema.string().min(1).required(),
  maxExecutionMs: Schema.natural().min(1).max(300_000).default(300_000),
}) as Schema<Config>

function fail(message: string): never { throw new Error(`assistant-web-owner: ${message}`) }
function assertOwned(access: NativeWebOwnerAccess, sessionId: SessionId): void { access.assertSession(sessionId) }
function sessionIdForAddress(address: SessionAddress): SessionId {
  if (address.kind !== 'session') fail('subagent session addresses are not supported by the Web owner')
  return address.sessionId
}
function textContent(content: readonly unknown[]): string {
  return content.filter((part): part is { type: 'text', text: string } => typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string').map(part => part.text).join('')
}
function ownedControl(frame: SessionControlFrame, access: NativeWebOwnerAccess): SessionControlFrame | undefined {
  if (frame.type === 'baseline') {
    const filter = <T>(rows: Readonly<Record<SessionId, T>>): Record<SessionId, T> => Object.fromEntries(Object.entries(rows).filter(([id]) => access.ownsSession(id as SessionId))) as Record<SessionId, T>
    return { type: 'baseline', value: { queues: filter(frame.value.queues), jobs: filter(frame.value.jobs), projections: filter(frame.value.projections) } }
  }
  return access.ownsSession(frame.sessionId) ? frame : undefined
}

function ownedAgents(originalRegistry: Context['agents'], access: NativeWebOwnerAccess): unknown {
  return {
    get: (sessionId: SessionId) => access.get(sessionId),
    create: (options: CreateAgentOptions) => access.create(options),
    resume: (options: ResumeAgentOptions) => access.resume(options),
    currentInitiator: originalRegistry.currentInitiator.bind(originalRegistry),
    isOwnedBy: originalRegistry.isOwnedBy.bind(originalRegistry),
  }
}

async function resolveOwnedWorkspace(ctx: Context, config: Config): Promise<Workspace> {
  // Delivery uses config.workspace as a durable scope key. Do not replace it
  // with realpath output: instead refuse a spelling that would drift that key.
  if (await realpath(config.workspace) !== config.workspace) fail('workspace must be its canonical path')
  const registry = ctx.workspaceRegistry
  const workspace = await registry.resolveByPath(config.workspace) ?? await registry.create(config.workspace)
  if (workspace.path !== config.workspace) fail('workspace registry returned a non-canonical path')
  return workspace
}

type SessionControllerConstructor = { new(ctx: Context, config: Record<string, never>): BundledSessionController; readonly inject: readonly string[] }

/** Resolve from the Host entrypoint so the controller and AgentLoop share one ABI. */
export async function resolveHostSessionController(hostEntrypoint = process.argv[1]): Promise<SessionControllerConstructor> {
  // A global `dsh` is commonly a symlink into its package's lib/bin.js.  The
  // Host's peer closure is anchored at that canonical entry, not the global
  // bin directory containing the symlink.
  const hostRequire = hostEntrypoint === undefined
    ? createRequire(import.meta.url)
    : createRequire(await realpath(hostEntrypoint))
  const entry = hostRequire.resolve('@deepseek-ai/dsh-api-session-controller')
  const module = await import(pathToFileURL(entry).href) as { SessionController?: unknown }
  const candidate = module.SessionController
  if (typeof candidate !== 'function' || !Array.isArray((candidate as { inject?: unknown }).inject)) {
    fail('Host SessionController is unavailable')
  }
  return candidate as SessionControllerConstructor
}

async function wrapController(ctx: Context, config: Config, access: NativeWebOwnerAccess, originalRegistry: Context['agents'], workspace: Workspace): Promise<void> {
  const isolated = ctx
  const pendingAdded = new Map<SessionId, unknown>()
  let creating = 0
  const emit = isolated.emit.bind(isolated) as (...args: unknown[]) => unknown
  const plugin = isolated.plugin.bind(isolated) as (...args: unknown[]) => unknown
  const scoped = isolated.extend({ plugin: ((input: unknown, ...args: unknown[]) => {
    if (typeof input === 'function' && input.name === 'SessionSkillCatalog') {
      const Catalog = input as unknown as { new(ctx: Context): { list(request: { sessionId: SessionId }, signal: AbortSignal): unknown }; inject: string[] }
      return plugin({ name: 'assistant-web-owner-skills', inject: Catalog.inject, apply(skillCtx: Context) {
        const skills = new Catalog(skillCtx)
        const list = skills.list.bind(skills)
        Object.defineProperty(skills, 'list', { value: (request: { sessionId: SessionId }, signal: AbortSignal) => {
          access.assertSession(request.sessionId)
          return list(request, signal)
        }, configurable: true })
      } }, ...args)
    }
    return plugin(input, ...args)
  }) as Context['plugin'], emit: ((event: string, ...args: unknown[]) => {
    if (event.startsWith('api-session/')) {
      const id = (event === 'api-session/added' ? (args[0] as { sessionId?: SessionId })?.sessionId : args[0]) as SessionId
      if (!access.ownsSession(id)) {
        if (event === 'api-session/added' && creating > 0 && pendingAdded.size < 100) pendingAdded.set(id, args[0])
        return
      }
      // Native session/disposed means the in-memory handle detached. This
      // adapter deliberately evicts idle Agents while keeping their durable
      // owner binding and history; forwarding "removed" would clear the UI's
      // selected session before the user can send its first message.
      if (event === 'api-session/removed') return
    }
    return emit(event, ...args)
  }) as Context['emit'] })
  scoped.provide('agents', ownedAgents(originalRegistry, access))
  // The constructor comes from the active Host package, while this scoped
  // facade keeps its existing isolated-agent ownership and RPC boundary.
  // Its exact inject list must own the nested Context: later Hosts require
  // fileUploads while the supported 0.1.2 Host does not provide that service.
  const Controller = await resolveHostSessionController()
  // `scoped` is backed by the currently-loading owner fiber.  Its `agents`
  // provider becomes visible only after this apply callback settles, so do
  // not await the child here: that would make its exact Controller.inject
  // list wait on its own parent.  Cordis owns and activates this child after
  // the provider is live, and reloads it with the active Host inject list.
  scoped.inject(Controller.inject, controllerCtx => {
    const controller = new Controller(controllerCtx, {})
    // Keep the unwrapped methods before installing own properties.  The Typert
    // gateway resolves a Remote operation with Reflect.get(), so the own
    // properties below are intentionally what the gateway sees.
    const native = Object.fromEntries([
    'resolveAgent', 'inspect', 'list', 'search', 'create', 'selectModel', 'rename',
    'attachment', 'updateQueue', 'cancel', 'prompt', 'page', 'follow', 'control',
    ].map(method => [method, (controller as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!.bind(controller)])) as Record<string, (...args: unknown[]) => unknown>
    const replace = (method: string, wrapper: (...args: never[]) => unknown) => Object.defineProperty(controller, method, { value: wrapper, enumerable: true, configurable: true, writable: false })
    const call = (method: string, args: unknown[]) => Reflect.apply(native[method]!, controller, args)
    replace('resolveAgent', async (id: SessionId) => { assertOwned(access, id); return call('resolveAgent', [id]) })
    replace('inspect', async (id: SessionId, signal?: AbortSignal) => { assertOwned(access, id); return call('inspect', [id, signal]) })
    replace('list', async (request: never, signal: AbortSignal) => { const value = await call('list', [request, signal]) as { items: readonly { sessionId: SessionId }[] }; return { ...value, items: value.items.filter(item => access.ownsSession(item.sessionId)) } })
    replace('search', async (request: never, signal: AbortSignal) => { const value = await call('search', [request, signal]) as { items: readonly { sessionId: SessionId }[] }; return { ...value, items: value.items.filter(item => access.ownsSession(item.sessionId)) } })
    replace('create', async (request: SessionCreateRequest) => {
    if (request.workspaceId !== undefined && request.workspaceId !== workspace.id) fail('the configured workspaceId is required')
    if (request.workspaceId !== undefined && request.cwd !== undefined) fail('workspaceId and cwd cannot be combined')
    if (request.cwd !== undefined && request.cwd !== config.workspace) fail('the configured workspace is required')
    const current = ctx.workspaceRegistry.get(workspace.id)
    if (current?.path !== config.workspace) fail('the configured workspaceId is no longer available')
    if (request.agentPreset !== undefined && request.agentPreset !== config.preset) fail('the configured preset is required')
    if (request.sessionId !== undefined && !access.ownsSession(request.sessionId)) fail('cannot adopt a session outside this Web owner')
    creating += 1
    try {
      const value = await call('create', [{ sessionId: request.sessionId, workspaceId: workspace.id, agentPreset: config.preset }]) as { sessionId: SessionId }
      assertOwned(access, value.sessionId)
      const added = pendingAdded.get(value.sessionId)
      if (added !== undefined) emit('api-session/added', added)
      return value
    } finally { creating -= 1; if (creating === 0) pendingAdded.clear() }
    })
    for (const method of ['selectModel', 'rename', 'attachment'] as const) replace(method, async (request: { sessionId: SessionId }) => { assertOwned(access, request.sessionId); return call(method, [request]) })
    for (const method of ['updateQueue', 'cancel'] as const) replace(method, (request: { sessionId: SessionId }) => { assertOwned(access, request.sessionId); return call(method, [request]) })
    replace('fork', async (request: { sessionId: SessionId }) => { assertOwned(access, request.sessionId); fail('fork is not supported until a new Web owner binding can be created atomically') })
    replace('prompt', async (request: SessionPromptRequest, signal: AbortSignal) => {
    assertOwned(access, request.sessionId); signal.throwIfAborted()
    const resolved = await call('resolveAgent', [request.sessionId]) as { agent?: Agent, error?: unknown }
    if (resolved.agent === undefined) throw resolved.error ?? new Error('session agent could not be resolved')
    if (request.content.some(part => part.type !== 'text')) fail('图片输入尚未接入，请先发送文本')
    const content = request.content
    return access.prompt({ sessionId: request.sessionId, requestId: request.requestId, text: textContent(content), content }, () => Promise.resolve(call('prompt', [request, signal])), signal)
    })
    replace('page', async (request: { address: SessionAddress }, signal: AbortSignal) => {
    const id = sessionIdForAddress(request.address)
    assertOwned(access, id)
    const page = await call('page', [request, signal])
    assertOwned(access, id)
    return page
    })
    replace('follow', async function* (request: { address: SessionAddress }, signal: AbortSignal) {
    const id = sessionIdForAddress(request.address)
    assertOwned(access, id)
    for await (const frame of call('follow', [request, signal]) as AsyncIterable<unknown>) {
      assertOwned(access, id)
      yield frame
    }
    })
    replace('control', async function* (signal: AbortSignal) { for await (const frame of call('control', [signal]) as AsyncIterable<SessionControlFrame>) { const filtered = ownedControl(frame, access); if (filtered !== undefined) yield filtered } })
    replace('openWorkspacePath', async () => fail('opening arbitrary host paths is disabled for the Web owner'))
    replace('canOpenWorkspacePath', () => false)
  })
}

export async function apply(ctx: Context, input: Config): Promise<void> {
  const config = Config(input)
  if (!config.workspace.startsWith('/')) fail('workspace must be an absolute path')
  const originalRegistry = ctx.agents
  // The facade provider must own an independently activated fiber whose ctx
  // already has this isolation. Otherwise Cordis cannot notify its dependents.
  const isolated = ctx.isolate('agents')
  await isolated.plugin({ inject: inject.filter(key => key !== 'agents'), async apply(owner: Context) {
    const delivery = owner.get('assistantDelivery') as DeliveryBridge | undefined
    if (delivery === undefined) fail('assistantDelivery is required')
    const access = delivery.bindNativeWebOwner(owner, { principal: { channel: 'web', ...config.principal }, workspace: config.workspace, preset: config.preset, ...(config.maxExecutionMs === undefined ? {} : { maxExecutionMs: config.maxExecutionMs }) })
    try {
      const workspace = await resolveOwnedWorkspace(owner, config)
      // This service only closes over the fixed Web-owner capability. The
      // capability checks lineage, expiry and current send policy on every call.
      new DeliveryNoticesService(owner, access)
      owner.typert.register(TYPERT)
      await wrapController(owner, config, access, originalRegistry, workspace)
    } catch (error) {
      await access.dispose()
      throw error
    }
  } })
}
