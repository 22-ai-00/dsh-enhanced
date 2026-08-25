import { createHash } from 'node:crypto'
import type {
  AdapterSendResult,
  DeliveryAdapter,
  DeliveryAdapterContext,
  DeliveryProgressIntent,
  ModelPickerIntent,
  ModelPickerState,
  ModelRouteRef,
  OutboundIntent,
} from '@dsh-enhanced/assistant-delivery'
import {
  LarkApprovalError,
  signLarkApprovalAction,
  verifyLarkApprovalAction,
  verifyLarkApprovalActionForRecovery,
} from './approval.js'
import {
  LarkModelPickerError,
  parseLarkModelPickerCallback,
  signLarkModelPickerAction,
  verifyLarkModelPickerAction,
  type LarkModelPickerActionPayload,
  type LarkModelPickerCallbackValue,
} from './model-picker.js'
import { normalizeLarkMessage } from './normalize.js'
import { LarkProgressPresenter } from './progress.js'
import { LARK_APPROVAL_CARD_MAX_BYTES, renderLarkMessage } from './sdk.js'
import {
  LarkTransportError,
  type LarkChannelHealth,
  type LarkInboundConfig,
  type LarkSendOptions,
  type LarkTransport,
} from './types.js'

export interface LarkApprovalSettlementInput {
  operationId: string
  callbackEventId: string
  callbackChatId: string
  bindingId: string
  principal: { channel: string; account: string; tenant: string; user: string }
  proposalId: string
  expectedVersion: number
  diffHash: string
  decision: 'approved' | 'rejected'
  reason: string
}

export interface LarkAdapterOptions {
  now?: () => number
  showProgress?: boolean
  statusReactions?: boolean
  approvalSecret?: string
  settleApproval?(input: LarkApprovalSettlementInput): unknown | Promise<unknown>
  recoverApprovalSettlement?(input: LarkApprovalSettlementInput): unknown | undefined | Promise<unknown | undefined>
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
    expectedRevision: number
  }): unknown | Promise<unknown>
  loadModelPicker?(input: {
    operationId: string
    callbackChatId: string
    bindingId: string
    principal: { channel: string; account: string; tenant: string; user: string }
  }): ModelPickerIntent | undefined | Promise<ModelPickerIntent | undefined>
  advanceModelPicker?(input: {
    operationId: string
    callbackChatId: string
    bindingId: string
    principal: { channel: string; account: string; tenant: string; user: string }
    expected: ModelPickerState
    next: ModelRouteRef
  }): { applied: boolean; state: ModelPickerState } | Promise<{ applied: boolean; state: ModelPickerState }>
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

function defaultEffortOption(effortIds: readonly string[]): string {
  let value = '__default__'
  while (effortIds.includes(value)) value += '_'
  return value
}

interface ResolvedModelPicker {
  modelsByProvider: Map<string, ModelPickerIntent['models'][number][]>
  provider: string
  providerModels: ModelPickerIntent['models'][number][]
  route: string
  selectedModel: ModelPickerIntent['models'][number]
  linkedEfforts: Array<{ value: string; label: string }>
  defaultEffort: string
  initialEffort: string
}

function resolveModelPicker(
  picker: Readonly<ModelPickerIntent>,
  preferred: { provider?: string; route?: string; effort?: string | null } = {},
): ResolvedModelPicker {
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
  const defaultEffort = defaultEffortOption(linkedEfforts.map(effort => effort.value))
  const preferredEffort = preferred.effort
  const initialEffort = preferredEffort === null
    ? defaultEffort
    : preferredEffort !== undefined && linkedEfforts.some(effort => effort.value === preferredEffort)
      ? preferredEffort
      : route === currentRoute && picker.current.reasoningEffort !== undefined
        && linkedEfforts.some(effort => effort.value === picker.current.reasoningEffort)
        ? picker.current.reasoningEffort
        : defaultEffort
  return { modelsByProvider, provider, providerModels, route, selectedModel,
    linkedEfforts, defaultEffort, initialEffort }
}

function resolvedModelRoute(resolved: ResolvedModelPicker): ModelRouteRef {
  return { provider: resolved.provider, model: resolved.selectedModel.id,
    ...(resolved.initialEffort === resolved.defaultEffort ? {} : { reasoningEffort: resolved.initialEffort }) }
}

function modelPickerCard(
  picker: Readonly<ModelPickerIntent>,
  secret: string,
  capability: Pick<LarkModelPickerActionPayload, 'operationId' | 'bindingId' | 'expiresAt' | 'chatId' | 'revision'>,
  preferred: { provider?: string; route?: string; effort?: string | null } = {},
): import('./types.js').LarkModelPickerCard {
  const { modelsByProvider, provider, providerModels, route, selectedModel, linkedEfforts,
    defaultEffort, initialEffort } = resolveModelPicker(picker, preferred)
  const currentRoute = `${picker.current.provider}/${picker.current.model}`
  const signedState = {
    version: 3 as const,
    ...capability,
    provider,
    model: selectedModel.id,
    effort: initialEffort === defaultEffort ? null : initialEffort,
  }
  const callbackValue = (action: import('./model-picker.js').LarkModelPickerCallbackAction) => ({
    modelPicker: signLarkModelPickerAction(secret, { ...signedState, action }),
  })
  const currentEffort = picker.current.reasoningEffort === undefined ? '' : `，effort：${picker.current.reasoningEffort}`
  return {
    title: '选择会话模型',
    body: `当前模型：${currentRoute}${currentEffort}\n\n选择将在下一条消息生效，并保留当前上下文。`,
    providerOptions: picker.providers
      .filter(value => (modelsByProvider.get(value.id)?.length ?? 0) > 0)
      .map(value => ({ value: value.id, label: value.name })),
    modelOptions: providerModels.map(model => ({ value: `${model.provider}/${model.id}`, label: model.name })),
    effortOptions: [
      { value: defaultEffort, label: linkedEfforts.length === 0
        ? '默认（该模型无 effort 档位）'
        : '默认（由模型决定）' },
      ...linkedEfforts,
    ],
    initialProvider: provider,
    initialModel: route,
    initialEffort,
    callbackValues: {
      provider: callbackValue('provider'),
      model: callbackValue('model'),
      effort: callbackValue('effort'),
      confirm: callbackValue('confirm'),
    },
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
  private readonly recoverApprovalSettlement: LarkAdapterOptions['recoverApprovalSettlement']
  private readonly settleModelSelection: LarkAdapterOptions['settleModelSelection']
  private readonly loadModelPicker: LarkAdapterOptions['loadModelPicker']
  private readonly advanceModelPicker: LarkAdapterOptions['advanceModelPicker']
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
    this.recoverApprovalSettlement = options.recoverApprovalSettlement
    this.settleModelSelection = options.settleModelSelection
    this.loadModelPicker = options.loadModelPicker
    this.advanceModelPicker = options.advanceModelPicker
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
      if (Buffer.byteLength(intent.text, 'utf8') > this.config.maxTextBytes) {
        return { outcome: 'not-sent', failureCode: 'lark-approval-too-large', retryable: false }
      }
      if (createHash('sha256').update(intent.text).digest('hex') !== intent.approval.diffHash) {
        return { outcome: 'not-sent', failureCode: 'lark-approval-diff-mismatch', retryable: false }
      }
      if (this.now() >= intent.approval.expiresAt) {
        return { outcome: 'not-sent', failureCode: 'lark-approval-expired', retryable: false }
      }
      const common = {
        version: 2 as const,
        channel: conversation.channel,
        account: conversation.account,
        tenant: conversation.tenant,
        operationId: intent.approval.operationId,
        bindingId: intent.bindingId,
        proposalId: intent.approval.proposalId,
        expectedVersion: intent.approval.expectedVersion,
        expiresAt: intent.approval.expiresAt,
        chatId: conversation.chat,
        diffHash: intent.approval.diffHash,
      }
      input = { approval: {
        title: intent.approval.title,
        body: intent.text,
        approveValue: { approval: signLarkApprovalAction(this.approvalSecret, { ...common, decision: 'approved' }) },
        rejectValue: { approval: signLarkApprovalAction(this.approvalSecret, { ...common, decision: 'rejected' }) },
      } }
      if (Buffer.byteLength(renderLarkMessage(input).content, 'utf8') > LARK_APPROVAL_CARD_MAX_BYTES) {
        return { outcome: 'not-sent', failureCode: 'lark-approval-too-large', retryable: false }
      }
    } else if (intent.format === 'model-picker') {
      if (intent.modelPicker === undefined || this.approvalSecret === undefined
        || this.settleModelSelection === undefined || this.loadModelPicker === undefined
        || this.advanceModelPicker === undefined) {
        return { outcome: 'not-sent', failureCode: 'lark-model-picker-unavailable', retryable: false }
      }
      if (this.now() >= intent.modelPicker.expiresAt) {
        return { outcome: 'not-sent', failureCode: 'lark-model-picker-expired', retryable: false }
      }
      const picker = intent.modelPicker
      input = { modelPicker: modelPickerCard(picker, this.approvalSecret, {
        operationId: picker.operationId,
        bindingId: intent.bindingId,
        expiresAt: picker.expiresAt,
        chatId: conversation.chat,
        revision: 0,
      }) }
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
      void this.addReaction(intent.replyToEventId, 'DONE')
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
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new LarkApprovalError('invalid', 'Lark card action value is invalid')
      }
      if (typeof (value as { modelPicker?: unknown }).modelPicker === 'string') {
        return await this.handleModelPickerAction(action, parseLarkModelPickerCallback(value))
      }
      if (Object.keys(value).length !== 1 || typeof (value as { approval?: unknown }).approval !== 'string'
        || this.approvalSecret === undefined) {
        throw new LarkApprovalError('invalid', 'Lark approval action value is invalid')
      }
      const token = (value as { approval: string }).approval
      let expired = false
      let payload: import('./approval.js').LarkApprovalActionPayload
      try {
        payload = verifyLarkApprovalAction(this.approvalSecret, token, this.now())
      } catch (error) {
        if (!(error instanceof LarkApprovalError) || error.code !== 'expired') throw error
        payload = verifyLarkApprovalActionForRecovery(this.approvalSecret, token)
        expired = true
      }
      if (payload.channel !== this.channel || payload.account !== this.account
        || payload.tenant !== this.config.tenant || payload.chatId !== action.chatId) {
        throw new LarkApprovalError('invalid', 'Lark approval route does not match')
      }
      const callbackEventId = createHash('sha256')
        .update(`${action.messageId}\0${action.operatorId}\0${token}`)
        .digest('hex')
      const settlement = {
        operationId: payload.operationId,
        callbackEventId,
        callbackChatId: action.chatId,
        bindingId: payload.bindingId,
        principal: { channel: 'lark', account: this.account, tenant: this.config.tenant, user: action.operatorId },
        proposalId: payload.proposalId,
        expectedVersion: payload.expectedVersion,
        diffHash: payload.diffHash,
        decision: payload.decision,
        reason: `Lark owner ${payload.decision}`,
      }
      if (expired) {
        if (this.recoverApprovalSettlement === undefined
          || await this.recoverApprovalSettlement(settlement) === undefined) {
          throw new LarkApprovalError('invalid', 'expired Lark approval settlement is not recoverable')
        }
      } else {
        if (this.settleApproval === undefined) {
          throw new LarkApprovalError('invalid', 'Lark approval settlement is unavailable')
        }
        await this.settleApproval(settlement)
      }
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
    callback: LarkModelPickerCallbackValue,
  ): Promise<unknown> {
    if (this.approvalSecret === undefined || this.settleModelSelection === undefined) {
      throw new LarkModelPickerError('invalid', 'Lark model picker callback is unavailable')
    }
    const token = callback.modelPicker
    const payload = verifyLarkModelPickerAction(this.approvalSecret, token, this.now())
    if (payload.chatId !== action.chatId) throw new LarkModelPickerError('invalid', 'Lark model picker chat does not match')
    if (payload.action !== 'confirm') {
      const selectedOption = action.option
      if (this.loadModelPicker === undefined || this.advanceModelPicker === undefined
        || typeof selectedOption !== 'string') {
        throw new LarkModelPickerError('invalid', 'Lark model picker navigation is unavailable')
      }
      if (action.tag !== 'select_static') {
        throw new LarkModelPickerError('invalid', 'Lark model picker navigation action is invalid')
      }
      let picker: ModelPickerIntent | undefined
      try {
        picker = await this.loadModelPicker({
          operationId: payload.operationId,
          callbackChatId: action.chatId,
          bindingId: payload.bindingId,
          principal: { channel: 'lark', account: this.account, tenant: this.config.tenant, user: action.operatorId },
        })
      } catch (error) {
        this.recordPresentationFailure(error)
        return { toast: { type: 'warning', content: '模型选择已结束，请重新发送 /model' } }
      }
      if (picker === undefined || picker.operationId !== payload.operationId || picker.expiresAt !== payload.expiresAt) {
        return { toast: { type: 'warning', content: '模型选择已结束，请重新发送 /model' } }
      }
      const capability = {
        operationId: payload.operationId,
        bindingId: payload.bindingId,
        expiresAt: payload.expiresAt,
        chatId: payload.chatId,
      }
      let preferred: { provider?: string; route?: string; effort?: string | null }
      if (payload.action === 'provider') {
        if (!picker.providers.some(provider => provider.id === selectedOption)
          || !picker.models.some(model => model.provider === selectedOption)) {
          throw new LarkModelPickerError('invalid', 'Lark model picker provider is unavailable')
        }
        preferred = {
          provider: selectedOption,
          effort: null,
        }
      } else if (payload.action === 'model') {
        const selected = routeParts(selectedOption)
        if (selected === undefined || selected.provider !== payload.provider
          || !picker.models.some(model => model.provider === selected.provider && model.id === selected.model)) {
          throw new LarkModelPickerError('invalid', 'Lark model picker model is unavailable')
        }
        preferred = {
          provider: selected.provider,
          route: selectedOption,
          effort: null,
        }
      } else {
        const selectedModel = picker.models.find(model => model.provider === payload.provider && model.id === payload.model)
        const defaultEffort = selectedModel === undefined ? undefined : defaultEffortOption(selectedModel.effortIds)
        if (selectedModel === undefined || (selectedOption !== defaultEffort && !selectedModel.effortIds.includes(selectedOption))) {
          throw new LarkModelPickerError('invalid', 'Lark model picker effort is unavailable')
        }
        preferred = {
          provider: payload.provider,
          route: `${payload.provider}/${payload.model}`,
          effort: selectedOption === defaultEffort ? null : selectedOption,
        }
      }
      const next = resolvedModelRoute(resolveModelPicker(picker, preferred))
      let advanced: { applied: boolean; state: ModelPickerState }
      try {
        advanced = await this.advanceModelPicker({
          operationId: payload.operationId,
          callbackChatId: action.chatId,
          bindingId: payload.bindingId,
          principal: { channel: 'lark', account: this.account, tenant: this.config.tenant, user: action.operatorId },
          expected: { revision: payload.revision, provider: payload.provider, model: payload.model,
            ...(payload.effort === null ? {} : { reasoningEffort: payload.effort }) },
          next,
        })
      } catch (error) {
        this.recordPresentationFailure(error)
        return { toast: { type: 'warning', content: '模型选择已结束，请重新发送 /model' } }
      }
      const state = advanced.state
      return callbackCard(modelPickerCard(picker, this.approvalSecret, {
        ...capability, revision: state.revision,
      }, {
        provider: state.provider,
        route: `${state.provider}/${state.model}`,
        effort: state.reasoningEffort ?? null,
      }))
    }
    if (action.tag !== 'button') {
      throw new LarkModelPickerError('invalid', 'Lark model picker confirmation action is invalid')
    }
    const callbackEventId = createHash('sha256')
      .update(`${action.messageId}\0${action.operatorId}\0${token}`)
      .digest('hex')
    try {
      await this.settleModelSelection({
        operationId: payload.operationId,
        callbackEventId,
        callbackChatId: action.chatId,
        bindingId: payload.bindingId,
        principal: { channel: 'lark', account: this.account, tenant: this.config.tenant, user: action.operatorId },
        provider: payload.provider,
        modelProvider: payload.provider,
        model: payload.model,
        expectedRevision: payload.revision,
        ...(payload.effort === null ? {} : { reasoningEffort: payload.effort }),
      })
      return { toast: { type: 'success', content: '模型切换已受理' } }
    } catch (error) {
      this.recordPresentationFailure(error)
      return { toast: { type: 'warning', content: '卡片状态已更新，请重新发送 /model' } }
    }
  }
}
