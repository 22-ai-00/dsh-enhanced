import { createHash } from 'node:crypto'
import type {
  AdapterSendResult,
  DeliveryAdapter,
  DeliveryAdapterContext,
  DeliveryProgressIntent,
  ModelPickerIntent,
  OutboundIntent,
} from '@dsh-enhanced/assistant-delivery'
import { LarkApprovalError, signLarkApprovalAction, verifyLarkApprovalAction } from './approval.js'
import {
  LarkModelPickerError,
  signLarkModelPickerAction,
  verifyLarkModelPickerAction,
} from './model-picker.js'
import { normalizeLarkMessage } from './normalize.js'
import { LarkProgressPresenter } from './progress.js'
import { modelPickerControlNames, parseModelPickerControlName, renderLarkMessage } from './sdk.js'
import {
  LarkTransportError,
  type LarkChannelHealth,
  type LarkInboundConfig,
  type LarkSendOptions,
  type LarkTransport,
} from './types.js'

export interface LarkAdapterOptions {
  now?: () => number
  showProgress?: boolean
  statusReactions?: boolean
  approvalSecret?: string
  settleApproval?(input: {
    operationId: string
    callbackEventId: string
    callbackChatId: string
    bindingId: string
    principal: { channel: string; account: string; tenant: string; user: string }
    proposalId: string
    expectedVersion: number
    decision: 'approved' | 'rejected'
    reason: string
  }): unknown | Promise<unknown>
  settleModelSelection?(input: {
    operationId: string
    callbackEventId: string
    callbackChatId: string
    bindingId: string
    principal: { channel: string; account: string; tenant: string; user: string }
    provider: string
    modelProvider: string
    model: string
    reasoningEffort?: string
  }): unknown | Promise<unknown>
  loadModelPicker?(input: {
    operationId: string
    callbackChatId: string
    bindingId: string
    principal: { channel: string; account: string; tenant: string; user: string }
  }): ModelPickerIntent | undefined | Promise<ModelPickerIntent | undefined>
}

function failureCode(code: string): string {
  return `lark-${code.replaceAll('_', '-')}`
}

function modelPickerFallbackText(intent: Readonly<OutboundIntent>): string {
  const picker = intent.modelPicker
  if (picker === undefined) return intent.text
  return [
    '飞书未接受模型选择卡片，已回退为文字目录。',
    intent.text,
    '',
    '可用模型：',
    ...picker.models.map(model => `- ${model.provider}/${model.id}${model.name === model.id ? '' : ` — ${model.name}`}`),
    '',
    '切换：/model use <provider/model>',
    '恢复默认：/model reset',
  ].join('\n')
}

function sendFailure(error: unknown): AdapterSendResult {
  if (!(error instanceof LarkTransportError)) {
    return { outcome: 'unknown', failureCode: 'lark-unknown' }
  }
  if (error.code === 'send_timeout' || error.code === 'unknown') {
    return { outcome: 'unknown', failureCode: failureCode(error.code) }
  }
  const retryable = error.code === 'rate_limited' || error.code === 'not_connected'
  return {
    outcome: 'not-sent',
    failureCode: failureCode(error.code),
    retryable,
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
  }
}

function routeParts(route: string): { provider: string; model: string } | undefined {
  const separator = route.indexOf('/')
  if (separator <= 0 || separator === route.length - 1) return undefined
  return { provider: route.slice(0, separator), model: route.slice(separator + 1) }
}

function modelPickerCard(
  picker: Readonly<ModelPickerIntent>,
  confirmValue: { modelPicker: string },
  preferred: { provider?: string; route?: string } = {},
): import('./types.js').LarkModelPickerCard {
  const modelsByProvider = new Map<string, ModelPickerIntent['models'][number][]>()
  for (const model of picker.models) {
    const models = modelsByProvider.get(model.provider) ?? []
    models.push(model)
    modelsByProvider.set(model.provider, models)
  }
  const provider = [preferred.provider, picker.current.provider, ...picker.providers.map(value => value.id)]
    .find(value => value !== undefined && (modelsByProvider.get(value)?.length ?? 0) > 0)
  if (provider === undefined) throw new LarkModelPickerError('invalid', 'model picker has no selectable provider')
  const providerModels = modelsByProvider.get(provider)!
  const currentRoute = `${picker.current.provider}/${picker.current.model}`
  const route = [preferred.route, currentRoute]
    .find(value => value !== undefined && providerModels.some(model => `${model.provider}/${model.id}` === value))
    ?? `${providerModels[0]!.provider}/${providerModels[0]!.id}`
  const selectedModel = providerModels.find(model => `${model.provider}/${model.id}` === route)!
  const effortNames = new Map(picker.efforts.map(effort => [effort.id, effort.name]))
  const linkedEfforts = (selectedModel.effortIds ?? [])
    .flatMap(id => effortNames.has(id) ? [{ value: id, label: effortNames.get(id)! }] : [])
  const initialEffort = route === currentRoute && picker.current.reasoningEffort !== undefined
    && linkedEfforts.some(effort => effort.value === picker.current.reasoningEffort)
    ? picker.current.reasoningEffort
    : '__default__'
  const currentEffort = picker.current.reasoningEffort === undefined ? '' : `，effort：${picker.current.reasoningEffort}`
  return {
    title: '选择会话模型',
    body: `当前模型：${currentRoute}${currentEffort}\n\n选择将在下一条消息生效，并保留当前上下文。`,
    providerOptions: picker.providers
      .filter(value => (modelsByProvider.get(value.id)?.length ?? 0) > 0)
      .map(value => ({ value: value.id, label: value.name })),
    modelOptions: providerModels.map(model => ({ value: `${model.provider}/${model.id}`, label: model.name })),
    effortOptions: [
      { value: '__default__', label: linkedEfforts.length === 0
        ? '默认（该模型无 effort 档位）'
        : '默认（由模型决定）' },
      ...linkedEfforts,
    ],
    initialProvider: provider,
    initialModel: route,
    initialEffort,
    confirmValue,
  }
}

function callbackCard(card: import('./types.js').LarkModelPickerCard): Readonly<Record<string, unknown>> {
  const rendered = renderLarkMessage({ modelPicker: card })
  if (rendered.msgType !== 'interactive') {
    throw new LarkModelPickerError('invalid', 'model picker callback did not render a card')
  }
  const value = JSON.parse(rendered.content) as unknown
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LarkModelPickerError('invalid', 'model picker callback card is invalid')
  }
  return { card: { type: 'raw', data: value as Readonly<Record<string, unknown>> } }
}

export class LarkDeliveryAdapter implements DeliveryAdapter {
  readonly channel = 'lark'
  readonly account: string
  readonly capabilities = Object.freeze({
    reconcileUnknownSend: false,
    receipts: [] as const,
    formats: ['plain', 'markdown', 'approval', 'model-picker'] as const,
  })

  private readonly now: () => number
  private readonly approvalSecret: string | undefined
  private readonly settleApproval: LarkAdapterOptions['settleApproval']
  private readonly settleModelSelection: LarkAdapterOptions['settleModelSelection']
  private readonly loadModelPicker: LarkAdapterOptions['loadModelPicker']
  private readonly statusReactions: boolean
  private readonly progressPresenter: LarkProgressPresenter
  private state: LarkChannelHealth['state'] = 'disconnected'
  private gapGeneration = 0
  private lastErrorCode: LarkChannelHealth['lastErrorCode']

  constructor(
    private readonly config: LarkInboundConfig,
    private readonly transport: LarkTransport,
    options: LarkAdapterOptions = {},
  ) {
    this.account = config.account
    this.now = options.now ?? Date.now
    this.approvalSecret = options.approvalSecret
    this.settleApproval = options.settleApproval
    this.settleModelSelection = options.settleModelSelection
    this.loadModelPicker = options.loadModelPicker
    this.statusReactions = options.statusReactions ?? true
    this.progressPresenter = new LarkProgressPresenter(
      transport,
      options.showProgress ?? true,
      error => this.recordPresentationFailure(error),
    )
  }

  async start(context: DeliveryAdapterContext): Promise<() => Promise<void>> {
    this.state = 'connecting'
    const unsubscribe = this.transport.subscribe({
      message: async message => {
        const normalized = normalizeLarkMessage(this.config, message, this.now())
        if (normalized.outcome !== 'accept') return
        const accepted = await context.accept(normalized.envelope)
        if (this.statusReactions && !accepted.duplicate && accepted.status === 'queued') {
          // The durable Inbox acknowledgement is the critical path. A slow or
          // unavailable reaction endpoint must not hold the WebSocket handler open.
          void this.addReaction(message.messageId, 'Get')
        }
      },
      cardAction: async action => this.handleCardAction(action),
      reconnecting: () => {
        this.gapGeneration += 1
        this.state = 'reconnecting'
      },
      reconnected: () => { this.state = 'connected-with-gap' },
      error: error => { this.lastErrorCode = error.code },
    })
    try {
      await this.transport.connect()
      this.state = 'connected'
    } catch (error) {
      unsubscribe()
      this.state = 'disconnected'
      await this.transport.disconnect().catch(() => {})
      throw error
    }
    let active = true
    return async () => {
      if (!active) return
      active = false
      unsubscribe()
      this.state = 'disconnected'
      await this.transport.disconnect()
    }
  }

  health(): LarkChannelHealth {
    return {
      state: this.state,
      gapGeneration: this.gapGeneration,
      ...(this.lastErrorCode === undefined ? {} : { lastErrorCode: this.lastErrorCode }),
    }
  }

  async progress(intent: Readonly<DeliveryProgressIntent>): Promise<void> {
    if (!this.matchesTarget(intent.target)) return
    await this.progressPresenter.publish(intent)
  }

  async send(intent: Readonly<OutboundIntent>, signal: AbortSignal): Promise<AdapterSendResult> {
    const conversation = intent.target.conversation
    if (!this.matchesTarget(intent.target)) {
      return { outcome: 'not-sent', failureCode: 'lark-route-mismatch', retryable: false }
    }
    if (signal.aborted) return { outcome: 'not-sent', failureCode: 'lark-aborted', retryable: true }
    let input: import('./types.js').LarkSendInput
    if (intent.format === 'approval') {
      if (intent.approval === undefined || this.approvalSecret === undefined || this.settleApproval === undefined) {
        return { outcome: 'not-sent', failureCode: 'lark-approval-unavailable', retryable: false }
      }
      if (this.now() >= intent.approval.expiresAt) {
        return { outcome: 'not-sent', failureCode: 'lark-approval-expired', retryable: false }
      }
      const common = {
        version: 1 as const,
        operationId: intent.approval.operationId,
        bindingId: intent.bindingId,
        proposalId: intent.approval.proposalId,
        expectedVersion: intent.approval.expectedVersion,
        expiresAt: intent.approval.expiresAt,
        chatId: conversation.chat,
      }
      input = { approval: {
        title: intent.approval.title,
        body: intent.text,
        approveValue: { approval: signLarkApprovalAction(this.approvalSecret, { ...common, decision: 'approved' }) },
        rejectValue: { approval: signLarkApprovalAction(this.approvalSecret, { ...common, decision: 'rejected' }) },
      } }
    } else if (intent.format === 'model-picker') {
      if (intent.modelPicker === undefined || this.approvalSecret === undefined || this.settleModelSelection === undefined) {
        return { outcome: 'not-sent', failureCode: 'lark-model-picker-unavailable', retryable: false }
      }
      if (this.now() >= intent.modelPicker.expiresAt) {
        return { outcome: 'not-sent', failureCode: 'lark-model-picker-expired', retryable: false }
      }
      const picker = intent.modelPicker
      const confirmValue = { modelPicker: signLarkModelPickerAction(this.approvalSecret, {
          version: 1,
          operationId: picker.operationId,
          bindingId: intent.bindingId,
          expiresAt: picker.expiresAt,
          chatId: conversation.chat,
        }) }
      input = { modelPicker: modelPickerCard(picker, confirmValue) }
    } else {
      input = intent.format === 'markdown' ? { markdown: intent.text } : { text: intent.text }
    }
    const options: LarkSendOptions = {
      requestKey: intent.idempotencyKey,
      ...(intent.replyToEventId === undefined && conversation.kind !== 'group'
        ? {}
        : { replyTo: intent.replyToEventId ?? conversation.thread }),
      ...(conversation.kind === 'group' ? { replyInThread: true } : {}),
    }
    let result: Awaited<ReturnType<LarkTransport['send']>>
    try {
      result = await this.transport.send(conversation.chat, input, options)
    } catch (error) {
      if (!(error instanceof LarkTransportError) || error.code !== 'format_error'
        || intent.format !== 'model-picker' || intent.modelPicker === undefined) {
        return sendFailure(error)
      }
      try {
        result = await this.transport.send(conversation.chat, { text: modelPickerFallbackText(intent) }, {
          ...options,
          requestKey: `${intent.idempotencyKey}:model-picker-fallback`,
        })
      } catch (fallbackError) {
        return sendFailure(fallbackError)
      }
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._@/-]{0,255}$/u.test(result.messageId)) {
      return { outcome: 'unknown', failureCode: 'invalid-provider-result' }
    }
    if (this.statusReactions && intent.replyToEventId !== undefined) {
      await this.addReaction(intent.replyToEventId, 'DONE')
    }
    return { outcome: 'accepted', providerMessageId: result.messageId }
  }

  private matchesTarget(target: Readonly<OutboundIntent['target']>): boolean {
    const { conversation, principal } = target
    return conversation.channel === this.channel
      && principal.channel === this.channel
      && conversation.account === this.account
      && principal.account === this.account
      && conversation.tenant === this.config.tenant
      && principal.tenant === this.config.tenant
  }

  private async addReaction(messageId: string, emojiType: 'DONE' | 'Get'): Promise<void> {
    try {
      await this.transport.addReaction(messageId, emojiType)
    } catch (error) {
      this.recordPresentationFailure(error)
    }
  }

  private recordPresentationFailure(error: unknown): void {
    this.lastErrorCode = error instanceof LarkTransportError ? error.code : 'unknown'
  }

  private async handleCardAction(action: import('./types.js').LarkCardAction): Promise<unknown> {
    try {
      const value = action.value
      if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1) {
        throw new LarkApprovalError('invalid', 'Lark card action value is invalid')
      }
      if (typeof (value as { modelPicker?: unknown }).modelPicker === 'string') {
        return await this.handleModelPickerAction(action, (value as { modelPicker: string }).modelPicker)
      }
      if (typeof (value as { approval?: unknown }).approval !== 'string'
        || this.approvalSecret === undefined || this.settleApproval === undefined) {
        throw new LarkApprovalError('invalid', 'Lark approval action value is invalid')
      }
      const token = (value as { approval: string }).approval
      const payload = verifyLarkApprovalAction(this.approvalSecret, token, this.now())
      if (payload.chatId !== action.chatId) throw new LarkApprovalError('invalid', 'Lark approval chat does not match')
      const callbackEventId = createHash('sha256')
        .update(`${action.messageId}\0${action.operatorId}\0${token}`)
        .digest('hex')
      await this.settleApproval({
        operationId: payload.operationId,
        callbackEventId,
        callbackChatId: action.chatId,
        bindingId: payload.bindingId,
        principal: { channel: 'lark', account: this.account, tenant: this.config.tenant, user: action.operatorId },
        proposalId: payload.proposalId,
        expectedVersion: payload.expectedVersion,
        decision: payload.decision,
        reason: `Lark owner ${payload.decision}`,
      })
    } catch (error) {
      if (error instanceof LarkApprovalError || error instanceof LarkModelPickerError) {
        this.lastErrorCode = 'format_error'
        return
      }
      throw error
    }
  }

  private async handleModelPickerAction(
    action: import('./types.js').LarkCardAction,
    token: string,
  ): Promise<unknown> {
    if (this.approvalSecret === undefined || this.settleModelSelection === undefined) {
      throw new LarkModelPickerError('invalid', 'Lark model picker callback is unavailable')
    }
    const payload = verifyLarkModelPickerAction(this.approvalSecret, token, this.now())
    if (payload.chatId !== action.chatId) throw new LarkModelPickerError('invalid', 'Lark model picker chat does not match')
    const control = parseModelPickerControlName(action.name)
    if (action.tag === 'select_static' && (control?.kind === 'provider' || control?.kind === 'model')) {
      const selectedOption = action.option
        ?? (action.name === undefined ? undefined : action.formValue?.[action.name])
      if (this.loadModelPicker === undefined || typeof selectedOption !== 'string') {
        throw new LarkModelPickerError('invalid', 'Lark model picker navigation is unavailable')
      }
      const picker = await this.loadModelPicker({
        operationId: payload.operationId,
        callbackChatId: action.chatId,
        bindingId: payload.bindingId,
        principal: { channel: 'lark', account: this.account, tenant: this.config.tenant, user: action.operatorId },
      })
      if (picker === undefined || picker.expiresAt !== payload.expiresAt) {
        throw new LarkModelPickerError('invalid', 'Lark model picker catalog is unavailable')
      }
      if (control.kind === 'provider') {
        if (!picker.providers.some(provider => provider.id === selectedOption)) {
          throw new LarkModelPickerError('invalid', 'Lark model picker provider is unavailable')
        }
        return callbackCard(modelPickerCard(picker, { modelPicker: token }, { provider: selectedOption }))
      }
      const selected = routeParts(selectedOption)
      if (selected === undefined || !picker.models.some(model => model.provider === selected.provider && model.id === selected.model)) {
        throw new LarkModelPickerError('invalid', 'Lark model picker model is unavailable')
      }
      return callbackCard(modelPickerCard(picker, { modelPicker: token }, {
        provider: selected.provider,
        route: selectedOption,
      }))
    }
    if (action.tag !== 'button' || control?.kind !== 'confirm') {
      throw new LarkModelPickerError('invalid', 'Lark model picker action is invalid')
    }
    const form = action.formValue
    const provider = form?.[`provider_${control.state}`]
    const route = form?.[`model_${control.state}`]
    const effort = form?.[`effort_${control.state}`]
    if (typeof provider !== 'string' || typeof route !== 'string' || typeof effort !== 'string') {
      throw new LarkModelPickerError('invalid', 'Lark model picker form is incomplete')
    }
    const selected = routeParts(route)
    if (selected === undefined) {
      throw new LarkModelPickerError('invalid', 'Lark model picker route is invalid')
    }
    if (selected.provider !== provider) {
      throw new LarkModelPickerError('invalid', 'Lark model picker provider does not match the selected model')
    }
    const expectedControls = modelPickerControlNames({
      confirmValue: { modelPicker: token },
      initialProvider: provider,
      initialModel: route,
    })
    if (action.name !== expectedControls.confirm) {
      throw new LarkModelPickerError('invalid', 'Lark model picker form state is stale')
    }
    const modelProvider = selected.provider
    const model = selected.model
    const callbackEventId = createHash('sha256')
      .update(`${action.messageId}\0${action.operatorId}\0${token}\0${provider}\0${model}\0${effort}`)
      .digest('hex')
    await this.settleModelSelection({
      operationId: payload.operationId,
      callbackEventId,
      callbackChatId: action.chatId,
      bindingId: payload.bindingId,
      principal: { channel: 'lark', account: this.account, tenant: this.config.tenant, user: action.operatorId },
      provider,
      modelProvider,
      model,
      ...(effort === '__default__' ? {} : { reasoningEffort: effort }),
    })
  }
}
