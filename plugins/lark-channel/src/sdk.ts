import { createHash } from 'node:crypto'
import {
  AppType,
  Client,
  Domain,
  EventDispatcher,
  LoggerLevel,
  WSClient,
  normalize,
  normalizeCardAction,
  type BotIdentity,
  type Logger,
  type NormalizedMessage,
  type RawMessageEvent,
  type RawCardActionEvent,
} from '@larksuiteoapi/node-sdk'
import {
  LarkTransportError,
  type LarkMessage,
  type LarkProgressEvent,
  type LarkProgressHandle,
  type LarkSendInput,
  type LarkSendOptions,
  type LarkSendResult,
  type LarkTransport,
  type LarkTransportErrorCode,
  type LarkTransportHandlers,
} from './types.js'
import { installLarkCardCallbackBridge } from './ws-card-callback.js'

const LARK_PROGRESS_API = '/open-apis/im/v1/message_cot'

/** Provider-safe UTF-8 budget for the complete serialized approval card. */
export const LARK_APPROVAL_CARD_MAX_BYTES = 28 * 1_024

export interface OfficialLarkTransportOptions {
  appId: string
  appSecret: string
  domain: 'feishu' | 'lark'
  handshakeTimeoutMs: number
}

interface ErrorShape {
  code?: unknown
  response?: { status?: unknown; headers?: Record<string, unknown> }
}

function providerFailureCode(code: unknown): LarkTransportErrorCode | undefined {
  if (code === 99991400 || code === 99991663) return 'permission_denied'
  if (code === 230020) return 'rate_limited'
  if (code === 200530) return 'format_error'
  return undefined
}

const silentLogger: Logger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
}

function retryAfter(headers: Record<string, unknown> | undefined): number | undefined {
  const value = headers?.['retry-after']
  const seconds = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1_000) : undefined
}

export function classifyLarkSdkFailure(error: unknown): { code: LarkTransportErrorCode; retryAfterMs?: number } {
  const shape = error !== null && typeof error === 'object' ? error as ErrorShape : {}
  const status = typeof shape.response?.status === 'number' ? shape.response.status : undefined
  if (status === 429) {
    const delay = retryAfter(shape.response?.headers)
    return { code: 'rate_limited', ...(delay === undefined ? {} : { retryAfterMs: delay }) }
  }
  if (status === 401 || status === 403) return { code: 'permission_denied' }
  if (status !== undefined && status >= 400 && status < 500) return { code: 'format_error' }
  const providerCode = providerFailureCode(shape.code)
  if (providerCode !== undefined) return { code: providerCode }
  if (shape.code === 'ETIMEDOUT' || shape.code === 'ECONNABORTED') return { code: 'send_timeout' }
  return { code: 'unknown' }
}

export function larkRequestUuid(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)
}

export function createLarkProgressRequest(chatId: string, options: { replyTo: string; hidden: boolean }) {
  return {
    method: 'POST' as const,
    url: `${LARK_PROGRESS_API}?receive_id_type=chat_id`,
    data: {
      receive_id: chatId,
      origin_message_id: options.replyTo,
      cot_hidden: options.hidden,
      enable_badge: false,
      update_feed_rank: false,
    },
  }
}

export function writeLarkProgressRequest(handle: LarkProgressHandle, events: readonly LarkProgressEvent[]) {
  return {
    method: 'PUT' as const,
    url: LARK_PROGRESS_API,
    data: {
      cot_id: handle.cotId,
      message_id: handle.messageId,
      events: events.map(event => ({
        event_type: event.eventType,
        content: event.content,
        timestamp: event.timestamp,
      })),
    },
  }
}

export const LARK_MODEL_PICKER_CONTROLS = Object.freeze({
  provider: 'model_provider',
  model: 'model_route',
  effort: 'model_effort',
  confirm: 'model_confirm',
})

export function renderLarkMessage(input: LarkSendInput): { msgType: 'interactive' | 'text'; content: string } {
  if ('text' in input) return { msgType: 'text', content: JSON.stringify({ text: input.text }) }
  if ('modelPicker' in input) {
    const picker = input.modelPicker
    const callback = (action: import('./model-picker.js').LarkModelPickerCallbackAction) => picker.callbackValues[action]
    const select = (
      name: string,
      placeholder: string,
      options: readonly { value: string; label: string }[],
      initial: string | undefined,
      action: import('./model-picker.js').LarkModelPickerCallbackAction,
    ) => {
      const value = callback(action)
      // Lark resolves `initial_option` against the option's displayed text, not its
      // callback value, so a route-shaped or synthetic initial value never matches and
      // the client silently falls back to the first option. Address the selection by its
      // 1-based `initial_index`, and only add the textual form when that label identifies
      // exactly one option, because `initial_option` overrides `initial_index`. An initial
      // value absent from `options` preselects nothing.
      const selected = initial === undefined
        ? -1
        : options.findIndex(option => option.value === initial)
      const label = selected < 0 ? undefined : options[selected]!.label
      const unambiguous = label !== undefined
        && options.filter(option => option.label === label).length === 1
      return {
        tag: 'select_static',
        name,
        width: 'fill',
        placeholder: { tag: 'plain_text', content: placeholder },
        options: options.map(option => ({
          text: { tag: 'plain_text', content: option.label },
          value: option.value,
        })),
        value,
        behaviors: [{ type: 'callback', value }],
        ...(selected < 0 ? {} : { initial_index: selected + 1 }),
        ...(unambiguous ? { initial_option: label } : {}),
      }
    }
    const confirmValue = callback('confirm')
    // Layout follows the card style guide: header carries "what this is" (title + subtitle + icon),
    // each of the three selects sits in its own bordered surface so the groups read as blocks
    // instead of a flat run of markdown labels, and the single primary button is the only focus.
    const field = (label: string, hint: string, control: object, last = false) => ({
      tag: 'interactive_container',
      behaviors: [],
      width: 'fill',
      corner_radius: '8px',
      has_border: true,
      border_color: 'blue-100',
      background_style: 'blue-50',
      padding: '12px 12px 12px 12px',
      direction: 'vertical',
      vertical_spacing: '4px',
      // A trailing container keeps no bottom margin, so the card does not end on dead space.
      margin: last ? '0px 0px 12px 0px' : '0px 0px 8px 0px',
      elements: [
        { tag: 'markdown', content: `**<font color='blue'>${label}</font>**`, text_align: 'left' },
        { tag: 'markdown', content: `<font color='grey'>${hint}</font>`, text_size: 'notation', text_align: 'left' },
        control,
      ],
    })
    return {
      msgType: 'interactive',
      content: JSON.stringify({
        schema: '2.0',
        config: { update_multi: true, enable_forward_interaction: false },
        header: {
          template: 'blue',
          title: { tag: 'plain_text', content: picker.title },
          subtitle: { tag: 'plain_text', content: picker.body },
          icon: { tag: 'standard_icon', token: 'myai_colorful' },
        },
        body: { padding: '12px 12px 20px 12px', elements: [
          field('分组 / Provider', '先选分组，模型与 effort 会随之更新', select(
            LARK_MODEL_PICKER_CONTROLS.provider, '请选择模型分组',
            picker.providerOptions, picker.initialProvider, 'provider')),
          field('模型', '该分组下当前可用的模型', select(
            LARK_MODEL_PICKER_CONTROLS.model, '请选择模型',
            picker.modelOptions, picker.initialModel, 'model')),
          field('Effort 程度', '仅对支持 effort 档位的模型生效', select(
            LARK_MODEL_PICKER_CONTROLS.effort, '请选择 effort',
            picker.effortOptions, picker.initialEffort, 'effort'), true),
          { tag: 'button', name: LARK_MODEL_PICKER_CONTROLS.confirm, type: 'primary', width: 'fill',
            icon: { tag: 'standard_icon', token: 'done_outlined' },
            text: { tag: 'plain_text', content: '确认选择' }, value: confirmValue,
            behaviors: [{ type: 'callback', value: confirmValue }] },
        ] },
      }),
    }
  }
  if ('approval' in input) return {
    msgType: 'interactive',
    content: JSON.stringify({
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: input.approval.title } },
      body: { elements: [
        { tag: 'div', text: { tag: 'plain_text', content: 'Proposed change (treat as untrusted review text):' } },
        { tag: 'div', text: { tag: 'plain_text', content: input.approval.body } },
        { tag: 'action', actions: [
          { tag: 'button', text: { tag: 'plain_text', content: 'Approve' }, type: 'primary', value: input.approval.approveValue },
          { tag: 'button', text: { tag: 'plain_text', content: 'Reject' }, type: 'danger', value: input.approval.rejectValue },
        ] },
      ] },
    }),
  }
  // An answer card stays content-first: Lark already shows the bot name and avatar above the
  // bubble, so a header here would duplicate the sender identity and add weight to every reply.
  // `wide_screen_mode` is what keeps authored Markdown tables from wrapping into unreadable rows.
  return {
    msgType: 'interactive',
    content: JSON.stringify({
      schema: '2.0',
      config: { wide_screen_mode: true },
      body: {
        padding: '12px 16px 12px 16px',
        elements: [{ tag: 'markdown', content: input.markdown, text_align: 'left' }],
      },
    }),
  }
}

function asLarkMessage(message: NormalizedMessage): LarkMessage {
  return {
    messageId: message.messageId,
    chatId: message.chatId,
    chatType: message.chatType,
    senderId: message.senderId,
    content: message.content,
    rawContentType: message.rawContentType,
    resources: message.resources,
    mentionAll: message.mentionAll,
    mentionedBot: message.mentionedBot,
    createTime: message.createTime,
    ...(message.rootId === undefined ? {} : { rootId: message.rootId }),
    ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
    ...(message.replyToMessageId === undefined ? {} : { replyToMessageId: message.replyToMessageId }),
  }
}

function providerError(result: { code: number | undefined; msg: string | undefined }): LarkTransportError {
  const classified = providerFailureCode(result.code)
  if (classified === 'permission_denied') {
    return new LarkTransportError('permission_denied', 'Lark rejected the application credential or permission')
  }
  if (classified === 'rate_limited' || /rate|frequency|too many/iu.test(result.msg ?? '')) {
    return new LarkTransportError('rate_limited', 'Lark rate limited the message')
  }
  if (classified === 'format_error') {
    return new LarkTransportError('format_error', 'Lark rejected the message card format')
  }
  return new LarkTransportError('unknown', `Lark rejected the message with code ${String(result.code ?? 'missing')}`)
}

export class OfficialLarkTransport implements LarkTransport {
  private readonly client: Client
  private readonly dispatcher: EventDispatcher
  private readonly ws: WSClient
  private readonly handshakeTimeoutMs: number
  private handlers: LarkTransportHandlers | undefined
  private identity: BotIdentity | undefined
  private pendingHandshake: { resolve(): void; reject(error: Error): void } | undefined

  constructor(options: OfficialLarkTransportOptions) {
    const domain = options.domain === 'lark' ? Domain.Lark : Domain.Feishu
    const shared = { appId: options.appId, appSecret: options.appSecret, domain,
      logger: silentLogger, loggerLevel: LoggerLevel.error, source: 'dsh-enhanced-lark-channel' }
    this.handshakeTimeoutMs = options.handshakeTimeoutMs
    this.client = new Client({ ...shared, appType: AppType.SelfBuild })
    this.dispatcher = new EventDispatcher({ logger: silentLogger, loggerLevel: LoggerLevel.error })
    this.dispatcher.register({
      'im.message.receive_v1': async raw => {
        if (this.handlers === undefined || this.identity === undefined) return
        const message = await normalize(raw as unknown as RawMessageEvent, {
          botIdentity: this.identity,
          stripBotMentions: true,
        })
        await this.handlers.message(asLarkMessage(message))
      },
      'card.action.trigger': async (raw: unknown) => {
        if (this.handlers === undefined) return
        const action = normalizeCardAction(raw as unknown as RawCardActionEvent)
        if (action === null) return
        return await this.handlers.cardAction({
          messageId: action.messageId,
          chatId: action.chatId,
          operatorId: action.operator.openId,
          value: action.action.value,
          tag: action.action.tag,
          ...(action.action.name === undefined ? {} : { name: action.action.name }),
          ...(action.action.option === undefined ? {} : { option: action.action.option }),
        })
      },
    })
    this.ws = new WSClient({
      ...shared,
      autoReconnect: true,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
      onReady: () => this.pendingHandshake?.resolve(),
      onError: error => {
        const normalized = new LarkTransportError('not_connected', 'Lark WebSocket connection failed')
        if (this.pendingHandshake !== undefined) this.pendingHandshake.reject(normalized)
        else this.handlers?.error(normalized)
        void error
      },
      onReconnecting: () => this.handlers?.reconnecting(),
      onReconnected: () => this.handlers?.reconnected(),
    })
    installLarkCardCallbackBridge(this.ws)
  }

  subscribe(handlers: LarkTransportHandlers): () => void {
    if (this.handlers !== undefined) throw new Error('lark-channel: transport is already subscribed')
    this.handlers = handlers
    return () => { if (this.handlers === handlers) this.handlers = undefined }
  }

  async connect(): Promise<void> {
    this.identity = await this.fetchBotIdentity()
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.pendingHandshake = undefined
        this.ws.close({ force: true })
        reject(new LarkTransportError('not_connected', 'Lark WebSocket handshake timed out'))
      }, this.handshakeTimeoutMs + 1_000)
      timer.unref?.()
      this.pendingHandshake = {
        resolve: () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.pendingHandshake = undefined
          resolve()
        },
        reject: error => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.pendingHandshake = undefined
          reject(error)
        },
      }
      void this.ws.start({ eventDispatcher: this.dispatcher }).catch(error => {
        void error
        this.pendingHandshake?.reject(new LarkTransportError('not_connected', 'Lark WebSocket startup failed'))
      })
    })
  }

  async disconnect(): Promise<void> {
    this.pendingHandshake?.reject(new LarkTransportError('not_connected', 'Lark transport stopped'))
    this.ws.close({ force: true })
  }

  async addReaction(messageId: string, emojiType: string): Promise<string> {
    try {
      const response = await this.client.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      })
      if (response.code !== undefined && response.code !== 0) {
        throw providerError({ code: response.code, msg: response.msg })
      }
      const reactionId = response.data?.reaction_id
      if (reactionId === undefined || reactionId === '') {
        throw new LarkTransportError('unknown', 'Lark accepted reaction omitted reaction identity')
      }
      return reactionId
    } catch (error) {
      if (error instanceof LarkTransportError) throw error
      const classified = classifyLarkSdkFailure(error)
      throw new LarkTransportError(classified.code, 'Lark reaction request failed', classified.retryAfterMs)
    }
  }

  async createProgress(chatId: string, options: { replyTo: string; hidden: boolean }): Promise<LarkProgressHandle> {
    try {
      const response = await this.client.request<{
        code?: number
        msg?: string
        data?: { cot_id?: string; message_id?: string }
      }>(createLarkProgressRequest(chatId, options))
      if (response.code !== undefined && response.code !== 0) {
        throw providerError({ code: response.code, msg: response.msg })
      }
      const cotId = response.data?.cot_id
      const messageId = response.data?.message_id
      if (cotId === undefined || messageId === undefined) {
        throw new LarkTransportError('unknown', 'Lark accepted progress request omitted progress identity')
      }
      return { cotId, messageId }
    } catch (error) {
      if (error instanceof LarkTransportError) throw error
      const classified = classifyLarkSdkFailure(error)
      throw new LarkTransportError(classified.code, 'Lark progress request failed', classified.retryAfterMs)
    }
  }

  async writeProgress(handle: LarkProgressHandle, events: readonly LarkProgressEvent[]): Promise<void> {
    try {
      const response = await this.client.request<{ code?: number; msg?: string }>(
        writeLarkProgressRequest(handle, events),
      )
      if (response.code !== undefined && response.code !== 0) {
        throw providerError({ code: response.code, msg: response.msg })
      }
    } catch (error) {
      if (error instanceof LarkTransportError) throw error
      const classified = classifyLarkSdkFailure(error)
      throw new LarkTransportError(classified.code, 'Lark progress update failed', classified.retryAfterMs)
    }
  }

  async send(chatId: string, input: LarkSendInput, options: LarkSendOptions = {}): Promise<LarkSendResult> {
    const rendered = renderLarkMessage(input)
    const uuid = larkRequestUuid(options.requestKey ?? `${chatId}:${rendered.content}`)
    try {
      const response = options.replyTo === undefined
        ? await this.client.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: chatId, msg_type: rendered.msgType, content: rendered.content, uuid },
          })
        : await this.client.im.v1.message.reply({
            path: { message_id: options.replyTo },
            data: { msg_type: rendered.msgType, content: rendered.content, uuid,
              ...(options.replyInThread === undefined ? {} : { reply_in_thread: options.replyInThread }) },
          })
      if (response.code !== 0) throw providerError({ code: response.code, msg: response.msg })
      const messageId = response.data?.message_id
      if (messageId === undefined) throw new LarkTransportError('unknown', 'Lark accepted response omitted message identity')
      return { messageId }
    } catch (error) {
      if (error instanceof LarkTransportError) throw error
      const classified = classifyLarkSdkFailure(error)
      throw new LarkTransportError(classified.code, 'Lark SDK request failed', classified.retryAfterMs)
    }
  }

  private async fetchBotIdentity(): Promise<BotIdentity> {
    try {
      const response = await this.client.request<{ bot?: { open_id?: string; app_name?: string } }>({
        url: '/open-apis/bot/v3/info', method: 'GET',
      })
      if (response.bot?.open_id === undefined) {
        throw new LarkTransportError('permission_denied', 'Lark bot identity is unavailable')
      }
      return { openId: response.bot.open_id, name: response.bot.app_name ?? 'bot' }
    } catch (error) {
      if (error instanceof LarkTransportError) throw error
      const classified = classifyLarkSdkFailure(error)
      throw new LarkTransportError(classified.code, 'Lark bot identity request failed', classified.retryAfterMs)
    }
  }
}

export function createOfficialLarkTransport(options: OfficialLarkTransportOptions): LarkTransport {
  return new OfficialLarkTransport(options)
}
