import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import type { InboundProcessResult } from './coordinator.js'
import type { DeliveryInboundRuntime } from './service.js'
import { DeliveryStoreError } from './store.js'
import type {
  ConversationBinding,
  ConversationModelSelection,
  ConversationRef,
  DeliveryProgressUpdate,
  InboundEnvelope,
  ModelPickerIntent,
  ModelRouteRef,
} from './types.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    delivery: {
      kind: 'delivery'
      channel: string
      account: string
      eventId: string
      trust: 'untrusted'
    }
  }
}

interface DshDeliveryRuntimeOptions {
  workspace: string
  agentPreset: string
  policyRef: string
  provider: string
  model: string
  maxOutputTokens: number
  getModelSelection(conversation: ConversationRef): ConversationModelSelection | undefined
  setModelSelection(
    conversation: ConversationRef,
    route: ModelRouteRef,
  ): ConversationModelSelection
  clearModelSelection(conversation: ConversationRef): boolean
  modelPickerTtlMs: number
  progress(
    binding: Readonly<ConversationBinding>,
    eventId: string,
    update: DeliveryProgressUpdate,
  ): Promise<void>
  replyCommand(binding: Readonly<ConversationBinding>, eventId: string, input: ModelCommandReply): void
  reply(agent: Agent, eventId: string, input: ModelCommandReply): void
}

interface ModelCommandReply {
  text: string
  format?: 'model-picker' | 'plain'
  modelPicker?: ModelPickerIntent
  fallbackText?: string
}

const MAX_CATALOG_MODELS = 50
const MAX_PROGRESS_TODOS = 20
const MAX_PROGRESS_TEXT_CHARS = 240

function boundedProgressText(value: string): string {
  return [...value].slice(0, MAX_PROGRESS_TEXT_CHARS).join('')
}

/**
 * Convert one durable session fact into a deliberately narrow, user-visible progress update.
 * Raw reasoning chunks, tool arguments, result content, and error details never cross this boundary.
 */
export function deliveryProgressFromSessionEvent(event: SessionEvent): DeliveryProgressUpdate | undefined {
  if (event.type === 'tool/call') {
    return {
      kind: 'tool-started',
      callId: String(event.data.callId),
      toolName: boundedProgressText(event.data.name),
    }
  }
  if (event.type === 'tool/result') {
    const block = event.data.message.content.find(value => value.type === 'tool-result')
    const callId = block?.type === 'tool-result'
      ? block.toolCallId
      : event.data.message.source?.callId
    if (callId === undefined) return undefined
    return { kind: 'tool-finished', callId: String(callId), failed: event.data.error !== undefined }
  }
  if (event.type === 'todo/write') {
    return { kind: 'todos', todos: event.data.todos.slice(0, MAX_PROGRESS_TODOS).map(todo => ({
      content: boundedProgressText(todo.content),
      status: todo.status,
    })) }
  }
  return undefined
}

function parseModelRoute(value: string): ModelRouteRef | undefined {
  const separator = value.indexOf('/')
  if (separator <= 0 || separator === value.length - 1) return undefined
  const provider = value.slice(0, separator).trim()
  const model = value.slice(separator + 1).trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(provider)
    || model.length > 512 || /[\s\p{Cc}]/u.test(model)) return undefined
  return { provider, model }
}

function modelCommand(envelope: Readonly<InboundEnvelope>): string | undefined {
  if (envelope.kind !== 'command') return undefined
  const line = envelope.text.trim()
  return line === '/model' || line.startsWith('/model ') ? line.slice('/model'.length).trim() : undefined
}

function routeLabel(route: ModelRouteRef): string {
  return `${route.provider}/${route.model}${route.reasoningEffort === undefined ? '' : `，effort：${route.reasoningEffort}`}`
}

function displayName(value: string): string {
  return [...value].slice(0, 120).join('')
}

function toModelRoute(route: ModelRouteRef): ModelRouteRef {
  return {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
  }
}

function agentSelection(route: ModelRouteRef) {
  return {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }),
  }
}

async function modelCatalog(
  llm: LlmRuntime,
  current: ModelRouteRef,
  isDefault: boolean,
  eventId: string,
  expiresAt: number,
  signal: AbortSignal,
): Promise<ModelCommandReply> {
  const providers = llm.listProviders()
  const catalogs = await Promise.all(providers.map(async provider => {
    try {
      return { provider, models: await llm.listModels(provider.id) }
    } catch {
      return { provider, models: undefined }
    }
  }))
  const fallback = [
    `当前模型：${routeLabel(current)}${isDefault ? '（默认）' : ''}`,
    '',
    '可用模型（来自 DSH 实时目录）：',
  ]
  const models: ModelPickerIntent['models'][number][] = []
  const visibleProviders = new Map<string, ModelPickerIntent['providers'][number]>()
  let shown = 0
  let hidden = 0
  for (const catalog of catalogs) {
    fallback.push(`${catalog.provider.name} [${catalog.provider.id}]`)
    if (catalog.models === undefined) {
      fallback.push('- 目录暂不可用')
      continue
    }
    if (catalog.models.length === 0) {
      fallback.push('- 未提供可枚举模型')
      continue
    }
    for (const model of catalog.models) {
      if (shown >= MAX_CATALOG_MODELS) {
        hidden += 1
        continue
      }
      const route = `${catalog.provider.id}/${model.id}`
      const marker = catalog.provider.id === current.provider && model.id === current.model ? '（当前）' : ''
      const display = model.name === model.id ? '' : ` — ${model.name}`
      fallback.push(`- ${route}${display}${marker}`)
      visibleProviders.set(catalog.provider.id, {
        id: catalog.provider.id,
        name: displayName(catalog.provider.name),
      })
      models.push({ provider: catalog.provider.id, id: model.id, name: displayName(model.name), effortIds: [] })
      shown += 1
    }
  }
  if (providers.length === 0) fallback.push('- 当前没有已注册的模型 provider')
  if (hidden > 0) fallback.push(`- 另有 ${hidden} 个模型未展示`)
  fallback.push('', '切换：/model use <provider/model>', '恢复默认：/model reset')
  if (models.length === 0) return { text: fallback.join('\n'), format: 'plain' }
  const resolved = await Promise.allSettled(models.map(model => llm.resolveModelInfo(model.provider, model.id, signal)))
  const efforts = new Map<string, string>()
  const linkedModels = models.map((model, index) => {
    const result = resolved[index]
    if (result?.status !== 'fulfilled') return model
    const effortIds = new Set<string>()
    for (const effort of result.value.reasoning?.efforts ?? []) {
      const id = String(effort.id)
      if (!efforts.has(id) && efforts.size >= 20) continue
      efforts.set(id, displayName(effort.name))
      if (effortIds.size < 20) effortIds.add(id)
    }
    return { ...model, effortIds: [...effortIds] }
  })
  return {
    text: `当前模型：${routeLabel(current)}${isDefault ? '（默认）' : ''}`,
    format: 'model-picker',
    modelPicker: {
      operationId: `model-picker-${createHash('sha256').update(eventId).digest('hex').slice(0, 32)}`,
      expiresAt,
      current,
      providers: [...visibleProviders.values()],
      models: linkedModels,
      efforts: [...efforts].map(([id, name]) => ({ id, name })),
    },
    fallbackText: fallback.join('\n'),
  }
}

async function runModelCommand(
  argument: string,
  llm: LlmRuntime,
  conversation: ConversationRef,
  defaults: ModelRouteRef,
  options: DshDeliveryRuntimeOptions,
  signal: AbortSignal,
  eventId: string,
): Promise<ModelCommandReply> {
  const current = options.getModelSelection(conversation)
  const route = toModelRoute(current ?? defaults)
  if (argument === '') {
    return modelCatalog(
      llm,
      route,
      current === undefined,
      eventId,
      Date.now() + options.modelPickerTtlMs,
      signal,
    )
  }
  if (argument === 'reset') {
    const changed = options.clearModelSelection(conversation)
    return { text: changed
      ? `已恢复默认模型 ${routeLabel(defaults)}。\n下一条消息起生效，上下文保留。`
      : `本会话已在使用默认模型 ${routeLabel(defaults)}。` }
  }
  if (!argument.startsWith('use ')) {
    return { text: '用法：/model、/model use <provider/model>、/model reset' }
  }
  const target = argument.slice('use '.length).trim()
  const selected = parseModelRoute(target)
  if (selected === undefined) return { text: '用法：/model use <provider/model>' }
  if (!llm.listProviders().some(provider => provider.id === selected.provider)) {
    return { text: `没有注册 provider “${selected.provider}”。发送 /model 查看当前可用模型。` }
  }
  try {
    await llm.resolveModelInfo(selected.provider, selected.model, signal)
  } catch (error) {
    if (signal.aborted) throw error
    const code = typeof error === 'object' && error !== null && 'code' in error
      && typeof (error as { code: unknown }).code === 'string'
      ? `（${(error as { code: string }).code}）`
      : ''
    return { text: `模型 ${routeLabel(selected)} 当前不可用${code}。发送 /model 重新选择。` }
  }
  const changed = current?.provider !== selected.provider || current.model !== selected.model
  if (!changed && current.reasoningEffort === undefined) return { text: `本会话已在使用 ${routeLabel(selected)}。` }
  options.setModelSelection(conversation, selected)
  return { text: `已切换到 ${routeLabel(selected)}。\n下一条消息起生效，上下文保留。` }
}

function modelCommandFailure(error: unknown): InboundProcessResult {
  const deterministic = error instanceof DeliveryStoreError
    && (error.code === 'invalid-intent' || error.code === 'invalid-binding')
  return {
    outcome: 'not-processed',
    failureCode: deterministic ? 'model-command-invalid' : 'model-command-failed',
    retryable: !deterministic,
  }
}

function sessionId(conversation: InboundEnvelope['conversation'], generation: number): SessionId {
  const hash = createHash('sha256').update(JSON.stringify({ conversation, generation })).digest('hex').slice(0, 32)
  return SessionId(`delivery-${hash}-g${generation}`)
}

function finalAssistant(events: readonly SessionEvent[], from: number): { text: string; completed: boolean } {
  let text = ''
  let completed = false
  for (const event of events.slice(from)) {
    if (event.type === 'assistant/message') {
      text = event.data.message.content.filter(block => block.type === 'text')
        .map(block => block.type === 'text' ? block.text : '').join('')
    }
    if (event.type === 'turn/end') {
      const reason = event.data.reason
      completed = typeof reason === 'object' && reason !== null && 'kind' in reason
        && ['completed', 'max-tokens'].includes((reason as { kind: string }).kind)
    }
  }
  return { text, completed }
}

export class DshDeliveryRuntime implements DeliveryInboundRuntime {
  constructor(
    private readonly ctx: Context,
    private readonly policy: AssistantPolicyService,
    private readonly options: DshDeliveryRuntimeOptions,
  ) {}

  async createSession(input: {
    envelope: Readonly<InboundEnvelope>
    generation: number
    previous?: Readonly<ConversationBinding>
    signal: AbortSignal
  }): Promise<{ sessionId: string; workspace: string; agentPreset: string; policyRef: string }> {
    const agents = this.ctx.get('agents')
    const sessions = this.ctx.get('sessions')
    if (agents === undefined || sessions === undefined) throw new Error('assistant-delivery: agents and sessions services are required')
    const id = sessionId(input.envelope.conversation, input.generation)
    const selected = agentSelection(toModelRoute(this.options.getModelSelection(input.envelope.conversation)
      ?? { provider: this.options.provider, model: this.options.model }))
    let handle: AgentHandle | undefined
    let unbind: (() => void) | undefined
    try {
      handle = await agents.create({ sessionId: id,
        meta: { cwd: input.previous?.workspace ?? this.options.workspace,
          agentPreset: input.previous?.agentPreset ?? this.options.agentPreset },
        agentOptions: { provider: selected.provider, model: selected.model,
          maxTokens: this.options.maxOutputTokens }, signal: input.signal,
        setup: agentCtx => {
          if (agentCtx.agent === undefined) throw new Error('assistant-delivery: unpublished Agent identity is missing')
          unbind = this.policy.bindInitiator(agentCtx.agent, 'external')
          installModelSelection(agentCtx, { current: selected,
            assembled: undefined })
        } })
      await sessions.flush(handle.agent.session)
      return { sessionId: String(id), workspace: input.previous?.workspace ?? this.options.workspace,
        agentPreset: input.previous?.agentPreset ?? this.options.agentPreset,
        policyRef: input.previous?.policyRef ?? this.options.policyRef }
    } finally {
      unbind?.()
      await handle?.dispose()
    }
  }

  async process(
    binding: Readonly<ConversationBinding>,
    envelope: Readonly<InboundEnvelope>,
    signal: AbortSignal,
  ): Promise<InboundProcessResult> {
    if (envelope.kind === 'command' && envelope.text.trim() === '/new') return { outcome: 'processed' }
    const command = modelCommand(envelope)
    if (command !== undefined) {
      const llm = this.ctx.get('llm')
      if (llm === undefined) {
        return { outcome: 'not-processed', failureCode: 'model-directory-unavailable', retryable: true }
      }
      let reply: ModelCommandReply | undefined
      try {
        reply = await runModelCommand(command, llm, envelope.conversation, {
          provider: this.options.provider,
          model: this.options.model,
        }, this.options, signal, envelope.eventId)
        this.options.replyCommand(binding, envelope.eventId, reply)
        return { outcome: 'processed' }
      } catch (error) {
        if (reply?.format === 'model-picker' && reply.fallbackText !== undefined
          && error instanceof DeliveryStoreError
          && (error.code === 'invalid-intent' || error.code === 'invalid-binding')) {
          try {
            this.options.replyCommand(binding, envelope.eventId, { text: reply.fallbackText, format: 'plain' })
            return { outcome: 'processed' }
          } catch (fallbackError) {
            return modelCommandFailure(fallbackError)
          }
        }
        return modelCommandFailure(error)
      }
    }
    const agents = this.ctx.get('agents')
    const sessions = this.ctx.get('sessions')
    if (agents === undefined || sessions === undefined) {
      return { outcome: 'not-processed', failureCode: 'agent-runtime-unavailable', retryable: true }
    }
    const selected = agentSelection(toModelRoute(this.options.getModelSelection(envelope.conversation)
      ?? { provider: this.options.provider, model: this.options.model }))
    let handle: AgentHandle | undefined
    let unbind: (() => void) | undefined
    let dispatched = false
    let removeAbort: (() => void) | undefined
    let removeProgress: (() => void) | undefined
    let progressQueue = Promise.resolve()
    const publishProgress = (update: DeliveryProgressUpdate): void => {
      progressQueue = progressQueue
        .then(() => this.options.progress(binding, envelope.eventId, update))
        // Progress is presentation-only: its provider failure must never retry an Agent turn.
        .catch(() => {})
    }
    try {
      handle = await agents.resume({ resumeSessionId: SessionId(binding.sessionId), signal,
        agentOptions: { provider: selected.provider, model: selected.model,
          maxTokens: this.options.maxOutputTokens },
        setup: agentCtx => {
          if (agentCtx.agent === undefined) throw new Error('assistant-delivery: unpublished Agent identity is missing')
          unbind = this.policy.bindInitiator(agentCtx.agent, 'external')
          installModelSelection(agentCtx, { current: selected,
            assembled: undefined })
        } })
      const agent = handle.agent
      const from = agent.session.events.length
      removeProgress = this.ctx.on('session/event', (session, event) => {
        if (session !== agent.session) return
        const update = deliveryProgressFromSessionEvent(event)
        if (update !== undefined) publishProgress(update)
      })
      publishProgress({ kind: 'started' })
      const abort = () => agent.cancel({ kind: 'hook', reason: 'assistant-delivery-signal' })
      signal.addEventListener('abort', abort, { once: true })
      removeAbort = () => signal.removeEventListener('abort', abort)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: envelope.text }], source: {
        kind: 'delivery', channel: envelope.channel, account: envelope.account, eventId: envelope.eventId,
        trust: 'untrusted',
      } }))
      dispatched = true
      await agent.whenIdle()
      const output = finalAssistant(agent.session.events, from)
      await sessions.flush(agent.session)
      if (!output.completed) {
        publishProgress({ kind: 'failed' })
        await progressQueue
        return { outcome: 'not-processed', failureCode: 'agent-turn-incomplete', retryable: false }
      }
      if (output.text !== '') this.options.reply(agent, envelope.eventId, { text: output.text })
      publishProgress({ kind: 'completed' })
      await progressQueue
      return { outcome: 'processed' }
    } catch (error) {
      if (dispatched) {
        publishProgress({ kind: 'failed' })
        await progressQueue
        throw new Error(`assistant-delivery: Agent turn became ambiguous: ${String(error)}`, { cause: error })
      }
      return { outcome: 'not-processed', failureCode: 'agent-resume-failed', retryable: true }
    } finally {
      removeAbort?.()
      removeProgress?.()
      unbind?.()
      await handle?.dispose()
    }
  }
}
