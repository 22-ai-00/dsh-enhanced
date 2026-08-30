import { createHash } from 'node:crypto'
import type {
  AdapterSendResult,
  AdapterInboundImageReadResult,
  DeliveryAdapter,
  DeliveryAdapterContext,
  DeliveryProgressIntent,
  DeliveryToolApprovalOutcome,
  DeliveryToolApprovalRequest,
  ModelPickerIntent,
  ModelPickerState,
  ModelRouteRef,
  ModelSelectionResult,
  ModelSelectionSettlementInput,
  ModelSelectionTerminalResult,
  OutboundIntent,
  InboundImageReadInput,
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
import { isLarkTopLevelSenderThread } from './group-thread.js'
import { normalizeLarkMessage } from './normalize.js'
import {
  LarkPermissionPickerError,
  parseLarkPermissionPickerCallback,
  signLarkPermissionPickerAction,
  verifyLarkPermissionPickerAction,
  type LarkPermissionPickerActionPayload,
} from './permission-picker.js'
import { LarkProgressPresenter } from './progress.js'
import { LARK_APPROVAL_CARD_MAX_BYTES, renderLarkMessage } from './sdk.js'
import {
  LarkToolApprovalError,
  signLarkToolApprovalAction,
  verifyLarkToolApprovalAction,
  type LarkToolApprovalActionPayload,
} from './tool-approval.js'
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
  progressDetails?: 'off' | 'direct'
  statusReactions?: boolean
  approvalSecret?: string
  settleApproval?(input: LarkApprovalSettlementInput): unknown | Promise<unknown>
  recoverApprovalSettlement?(input: LarkApprovalSettlementInput): unknown | undefined | Promise<unknown | undefined>
  settleModelSelection?(input: ModelSelectionSettlementInput): ModelSelectionResult | Promise<ModelSelectionResult>
  awaitModelSelection?(
    input: ModelSelectionSettlementInput,
    signal: AbortSignal,
  ): ModelSelectionTerminalResult | undefined | Promise<ModelSelectionTerminalResult | undefined>
  settlePermissionSelection?(input: {
    operationId: string
    callbackEventId: string
    callbackChatId: string
    cardMessageId: string
    bindingId: string
    bindingVersion: number
    sessionId: string
    principal: { channel: string; account: string; tenant: string; user: string }
    issuedAt: number
    expiresAt: number
    expectedStateHash: string
    emergencyStopVersion: number
    targetLevel: 'ask' | 'auto' | 'full'
  }): unknown | Promise<unknown>
  loadModelPicker?(input: {
    operationId: string
    callbackChatId: string
    cardMessageId: string
    bindingId: string
    principal: { channel: string; account: string; tenant: string; user: string }
  }): ModelPickerIntent | undefined | Promise<ModelPickerIntent | undefined>
  advanceModelPicker?(input: {
    operationId: string
    callbackChatId: string
    cardMessageId: string
    bindingId: string
    principal: { channel: string; account: string; tenant: string; user: string }
    expected: ModelPickerState
    next: ModelRouteRef
  }): { applied: boolean; state: ModelPickerState } | Promise<{ applied: boolean; state: ModelPickerState }>
}

interface PendingToolApproval {
  readonly payload: Omit<LarkToolApprovalActionPayload, 'decision'>
  readonly signal: AbortSignal
  readonly abort: () => void
  readonly resolve: (outcome: DeliveryToolApprovalOutcome) => void
  earlyAction?: { messageId: string; decision: 'allowed-once' | 'rejected' }
  providerMessageId?: string
}

interface ToolApprovalTombstone {
  readonly expiresAt: number
  timer?: ReturnType<typeof setTimeout>
}

const LARK_TOOL_APPROVAL_REASON_MAX_BYTES = 2 * 1_024
const LARK_TOOL_APPROVAL_ARGUMENTS_MAX_BYTES = 16 * 1_024
const LARK_TOOL_APPROVAL_MAX_TIMER_MS = 2_147_483_647
const larkCallbackIdentifier = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,255}$/u
const larkProviderMessageIdentifier = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,255}$/u
// Lark can reject or render a Markdown card blank when it contains a GFM table. This mirrors the
// proven Hermes Feishu compatibility rule while leaving ordinary Markdown cards unchanged.
const larkMarkdownTable = /^\|.*\|\r?\n\|[-|: ]+\|/mu

function hasUsableApprovalSecret(secret: string | undefined): secret is string {
  return secret !== undefined && Buffer.byteLength(secret, 'utf8') >= 16
}

function boundedReviewText(value: string | undefined, maxBytes: number): boolean {
  return value === undefined || (Buffer.byteLength(value, 'utf8') <= maxBytes
    && !/(?:\p{Cc}|\p{Bidi_Control})/u.test(
      value.replaceAll('\n', '').replaceAll('\r', '').replaceAll('\t', ''),
    ))
}

function sameToolApprovalPayload(
  left: Omit<LarkToolApprovalActionPayload, 'decision'>,
  right: LarkToolApprovalActionPayload,
): boolean {
  return left.version === right.version
    && left.channel === right.channel
    && left.account === right.account
    && left.tenant === right.tenant
    && left.operationId === right.operationId
    && left.bindingId === right.bindingId
    && left.chatId === right.chatId
    && left.ownerUser === right.ownerUser
    && left.actionHash === right.actionHash
    && left.toolName === right.toolName
    && left.callId === right.callId
    && left.expiresAt === right.expiresAt
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

function permissionPickerCard(
  intent: NonNullable<OutboundIntent['permissionPicker']>,
  secret: string,
  capability: Pick<LarkPermissionPickerActionPayload,
    'channel' | 'account' | 'tenant' | 'bindingId' | 'chatId' | 'ownerUser'>,
): import('./types.js').LarkPermissionPickerCard {
  const current = intent.current === 'ask'
    ? '请求批准（ask）'
    : intent.current === 'auto'
      ? '帮我批准（auto）'
      : intent.current === 'full'
        ? '完全访问权限（full）'
        : '自定义安全组合（custom）'
  const callbackValue = (level: LarkPermissionPickerActionPayload['level']) => ({
    permissionPicker: signLarkPermissionPickerAction(secret, {
      version: 2,
      ...capability,
      operationId: intent.operationId,
      bindingVersion: intent.bindingVersion,
      sessionId: intent.sessionId,
      issuedAt: intent.issuedAt,
      expiresAt: intent.expiresAt,
      expectedStateHash: intent.expectedStateHash,
      emergencyStopVersion: intent.emergencyStopVersion,
      level,
    }),
  })
  return {
    title: '选择权限模式',
    body: `当前：${current}。请选择新档位。`,
    current: intent.current,
    callbackValues: {
      ask: callbackValue('ask'),
      auto: callbackValue('auto'),
      full: callbackValue('full'),
    },
  }
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

function modelSelectionRejectionMessage(reason: Extract<ModelSelectionResult, { status: 'rejected' }>['reason']): string {
  switch (reason) {
    case 'authorization-revoked': return '当前账号或会话授权已失效，模型未切换。请重新发送 /model。'
    case 'invalid-effort': return '所选 effort 当前不可用，模型未切换。请重新发送 /model。'
    case 'model-unavailable': return '所选模型当前不可用，模型未切换。请重新发送 /model。'
    case 'provider-model-mismatch': return '模型与 provider 不匹配，模型未切换。请重新发送 /model。'
    case 'provider-unavailable': return '所选 provider 当前不可用，模型未切换。请重新发送 /model。'
    case 'selection-superseded': return '该模型选择已被更晚的操作取代，未更改当前模型。'
  }
  return '模型切换未生效，请重新发送 /model。'
}

function modelSelectionResultCard(
  result: ModelSelectionResult,
  payload: Pick<LarkModelPickerActionPayload, 'provider' | 'model' | 'effort'>,
  picker: Readonly<ModelPickerIntent> | undefined,
): import('./types.js').LarkModelSelectionResultCard {
  const route = result.status === 'selected'
    ? { ...result.selection, effort: result.selection.reasoningEffort ?? null }
    : payload
  const provider = picker?.providers.find(value => value.id === route.provider)?.name ?? route.provider
  const selectedModel = picker?.models.find(value =>
    value.provider === route.provider && value.id === route.model)
  const model = selectedModel?.name ?? route.model
  const effort = route.effort === null
    ? selectedModel?.effortIds.length === 0
      ? '默认（该模型无 effort 档位）'
      : '默认（由模型决定）'
    : picker?.efforts.find(value => value.id === route.effort)?.name ?? route.effort
  const routeCard = { provider, model, effort }
  return result.status === 'rejected'
    ? { status: 'rejected', explanation: modelSelectionRejectionMessage(result.reason), ...routeCard }
    : { status: result.status, ...routeCard }
}

function callbackCard(input: import('./types.js').LarkSendInput): Readonly<Record<string, unknown>> {
  return { card: { type: 'raw', data: rawCard(input) } }
}

function rawCard(input: import('./types.js').LarkSendInput): Readonly<Record<string, unknown>> {
  const rendered = renderLarkMessage(input)
  if (rendered.msgType !== 'interactive') {
    throw new LarkModelPickerError('invalid', 'model picker callback did not render a card')
  }
  const value = JSON.parse(rendered.content) as unknown
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LarkModelPickerError('invalid', 'model picker callback card is invalid')
  }
  return value as Readonly<Record<string, unknown>>
}

const MODEL_SELECTION_FINAL_UPDATE_TIMEOUT_MS = 120_000

interface PendingModelSelectionUpdate {
  readonly controller: AbortController
  start?: ReturnType<typeof setImmediate>
  deadline?: ReturnType<typeof setTimeout>
}

export class LarkDeliveryAdapter implements DeliveryAdapter {
  readonly channel = 'lark'
  readonly account: string
  readonly capabilities: DeliveryAdapter['capabilities']

  private readonly now: () => number
  private readonly approvalSecret: string | undefined
  private readonly settleApproval: LarkAdapterOptions['settleApproval']
  private readonly recoverApprovalSettlement: LarkAdapterOptions['recoverApprovalSettlement']
  private readonly settleModelSelection: LarkAdapterOptions['settleModelSelection']
  private readonly awaitModelSelection: LarkAdapterOptions['awaitModelSelection']
  private readonly settlePermissionSelection: LarkAdapterOptions['settlePermissionSelection']
  private readonly loadModelPicker: LarkAdapterOptions['loadModelPicker']
  private readonly advanceModelPicker: LarkAdapterOptions['advanceModelPicker']
  private readonly statusReactions: boolean
  private readonly progressPresenter: LarkProgressPresenter
  private readonly pendingToolApprovals = new Map<string, PendingToolApproval>()
  private readonly toolApprovalTombstones = new Map<string, ToolApprovalTombstone>()
  private readonly modelSelectionUpdates = new Map<string, PendingModelSelectionUpdate>()
  private state: LarkChannelHealth['state'] = 'disconnected'
  private gapGeneration = 0
  private lastErrorCode: LarkChannelHealth['lastErrorCode']

  constructor(
    private readonly config: LarkInboundConfig,
    private readonly transport: LarkTransport,
    options: LarkAdapterOptions = {},
  ) {
    this.account = config.account
    const permissionPickerAvailable = hasUsableApprovalSecret(options.approvalSecret)
      && options.settlePermissionSelection !== undefined
    this.capabilities = Object.freeze({
      reconcileUnknownSend: false,
      receipts: [] as const,
      formats: permissionPickerAvailable
        ? ['plain', 'markdown', 'approval', 'model-picker', 'permission-picker'] as const
        : ['plain', 'markdown', 'approval', 'model-picker'] as const,
      inboundImages: typeof transport.downloadMessageImage === 'function',
      toolApprovals: hasUsableApprovalSecret(options.approvalSecret),
    })
    this.now = options.now ?? Date.now
    this.approvalSecret = options.approvalSecret
    this.settleApproval = options.settleApproval
    this.recoverApprovalSettlement = options.recoverApprovalSettlement
    this.settleModelSelection = options.settleModelSelection
    this.awaitModelSelection = options.awaitModelSelection
    this.settlePermissionSelection = options.settlePermissionSelection
    this.loadModelPicker = options.loadModelPicker
    this.advanceModelPicker = options.advanceModelPicker
    this.statusReactions = options.statusReactions ?? true
    this.progressPresenter = new LarkProgressPresenter(
      transport,
      options.showProgress ?? true,
      options.progressDetails ?? 'direct',
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
        this.cancelPendingToolApprovals('unavailable')
        this.gapGeneration += 1
        this.state = 'reconnecting'
      },
      reconnected: () => { this.state = 'connected-with-gap' },
      error: error => {
        this.lastErrorCode = error.code
        if (error.code === 'not_connected') {
          this.state = 'disconnected'
          this.cancelPendingToolApprovals('unavailable')
        }
      },
    })
    try {
      await this.transport.connect()
      this.state = 'connected'
    } catch (error) {
      unsubscribe()
      this.state = 'disconnected'
      this.cancelPendingToolApprovals('unavailable', true)
      await this.transport.disconnect().catch(() => {})
      throw error
    }
    let active = true
    return async () => {
      if (!active) return
      active = false
      unsubscribe()
      this.state = 'disconnected'
      this.cancelPendingToolApprovals('unavailable', true)
      this.cancelModelSelectionUpdates()
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

  async requestToolApproval(
    input: Readonly<DeliveryToolApprovalRequest>,
    signal: AbortSignal,
  ): Promise<DeliveryToolApprovalOutcome> {
    if (signal.aborted) return 'cancelled'
    if (!hasUsableApprovalSecret(this.approvalSecret)
      || (this.state !== 'connected' && this.state !== 'connected-with-gap')
      || !this.matchesTarget(input.target)
      || !larkCallbackIdentifier.test(input.target.conversation.chat)
      || !larkCallbackIdentifier.test(input.target.principal.user)
      || input.target.conversation.kind !== 'dm'
      || input.target.conversation.thread !== undefined
      || typeof input.callId !== 'string'
      || typeof input.arguments !== 'string'
      || !boundedReviewText(input.reason, LARK_TOOL_APPROVAL_REASON_MAX_BYTES)
      || !boundedReviewText(input.arguments, LARK_TOOL_APPROVAL_ARGUMENTS_MAX_BYTES)) {
      return 'unavailable'
    }
    let now: number
    try {
      now = this.now()
    } catch {
      return 'unavailable'
    }
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(input.expiresAt)
      || !Number.isSafeInteger(input.expiresAt - now) || now >= input.expiresAt) {
      return 'unavailable'
    }
    const previousTombstone = this.toolApprovalTombstones.get(input.operationId)
    if (previousTombstone !== undefined) {
      if (now < previousTombstone.expiresAt) return 'unavailable'
      const expiredPending = this.pendingToolApprovals.get(input.operationId)
      if (expiredPending !== undefined) this.settleToolApproval(expiredPending, 'unavailable')
      this.deleteToolApprovalTombstone(input.operationId, previousTombstone)
    }
    const payload: Omit<LarkToolApprovalActionPayload, 'decision'> = {
      version: 1,
      channel: this.channel,
      account: this.account,
      tenant: this.config.tenant,
      operationId: input.operationId,
      bindingId: input.bindingId,
      chatId: input.target.conversation.chat,
      ownerUser: input.target.principal.user,
      actionHash: input.actionHash,
      toolName: input.toolName,
      callId: input.callId,
      expiresAt: input.expiresAt,
    }
    let card: Extract<import('./types.js').LarkSendInput, { toolApproval: unknown }>
    try {
      card = { toolApproval: {
        title: '工具调用需要确认',
        toolName: input.toolName,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        arguments: input.arguments,
        allowValue: { toolApproval: signLarkToolApprovalAction(
          this.approvalSecret,
          { ...payload, decision: 'allowed-once' },
        ) },
        rejectValue: { toolApproval: signLarkToolApprovalAction(
          this.approvalSecret,
          { ...payload, decision: 'rejected' },
        ) },
      } }
      if (Buffer.byteLength(renderLarkMessage(card).content, 'utf8') > LARK_APPROVAL_CARD_MAX_BYTES) {
        return 'unavailable'
      }
    } catch {
      return 'unavailable'
    }

    let resolve!: (outcome: DeliveryToolApprovalOutcome) => void
    const outcome = new Promise<DeliveryToolApprovalOutcome>(settle => { resolve = settle })
    let pending!: PendingToolApproval
    const abort = () => { this.settleToolApproval(pending, 'cancelled') }
    pending = { payload, signal, abort, resolve }
    const tombstone: ToolApprovalTombstone = { expiresAt: input.expiresAt }
    this.pendingToolApprovals.set(input.operationId, pending)
    this.toolApprovalTombstones.set(input.operationId, tombstone)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      this.settleToolApproval(pending, 'cancelled')
      return outcome
    }
    this.armToolApprovalTombstone(input.operationId, tombstone)
    if (this.pendingToolApprovals.get(input.operationId) !== pending) return outcome

    const sendOptions: LarkSendOptions = {
      requestKey: `tool-approval:${input.operationId}:${input.actionHash}`,
    }
    let sending: Promise<Awaited<ReturnType<LarkTransport['send']>>>
    try {
      sending = Promise.resolve(this.transport.send(input.target.conversation.chat, card, sendOptions))
    } catch (error) {
      this.recordPresentationFailure(error)
      this.settleToolApproval(pending, 'unavailable')
      return outcome
    }
    void sending.then(result => {
      if (this.pendingToolApprovals.get(input.operationId) !== pending) return
      if (!larkProviderMessageIdentifier.test(result.messageId)) {
        this.settleToolApproval(pending, 'unavailable')
        return
      }
      pending.providerMessageId = result.messageId
      const earlyAction = pending.earlyAction
      delete pending.earlyAction
      if (earlyAction?.messageId === result.messageId) {
        this.settleToolApproval(pending, earlyAction.decision)
      }
    }, error => {
      this.recordPresentationFailure(error)
      this.settleToolApproval(pending, 'unavailable')
    })
    return outcome
  }

  async readInboundImage(
    input: Readonly<InboundImageReadInput>,
    signal: AbortSignal,
  ): Promise<AdapterInboundImageReadResult> {
    if (input.attachment.resourceType !== 'image') {
      return { outcome: 'not-downloaded', failureCode: 'lark-image-type-unsupported', retryable: false }
    }
    const identifier = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,255}$/u
    if (!identifier.test(input.eventId) || !identifier.test(input.attachment.providerRef)
      || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) {
      return { outcome: 'not-downloaded', failureCode: 'lark-image-reference-invalid', retryable: false }
    }
    if (signal.aborted) {
      return { outcome: 'not-downloaded', failureCode: 'lark-image-aborted', retryable: true }
    }
    const download = this.transport.downloadMessageImage
    if (typeof download !== 'function') {
      return { outcome: 'not-downloaded', failureCode: 'lark-image-download-unavailable', retryable: false }
    }
    try {
      const image = await download.call(
        this.transport,
        input.eventId,
        input.attachment.providerRef,
        { maxBytes: input.maxBytes, signal },
      )
      if (signal.aborted) {
        return { outcome: 'not-downloaded', failureCode: 'lark-image-aborted', retryable: true }
      }
      return {
        outcome: 'downloaded',
        data: image.data,
        mediaType: image.mediaType,
      }
    } catch (error) {
      if (signal.aborted) {
        return { outcome: 'not-downloaded', failureCode: 'lark-image-aborted', retryable: true }
      }
      const code = error instanceof LarkTransportError ? error.code : 'unknown'
      const retryable = code !== 'format_error' && code !== 'permission_denied' && code !== 'target_revoked'
      return {
        outcome: 'not-downloaded',
        failureCode: `lark-image-${code.replaceAll('_', '-')}`,
        retryable,
        ...(error instanceof LarkTransportError && error.retryAfterMs !== undefined
          ? { retryAfterMs: error.retryAfterMs }
          : {}),
      }
    }
  }

  async send(intent: Readonly<OutboundIntent>, signal: AbortSignal): Promise<AdapterSendResult> {
    const conversation = intent.target.conversation
    if (!this.matchesTarget(intent.target)) {
      return { outcome: 'not-sent', failureCode: 'lark-route-mismatch', retryable: false }
    }
    if (signal.aborted) return { outcome: 'not-sent', failureCode: 'lark-aborted', retryable: true }
    const useMarkdownCard = intent.format === 'markdown' && !larkMarkdownTable.test(intent.text)
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
    } else if (intent.format === 'permission-picker') {
      if (intent.permissionPicker === undefined || this.approvalSecret === undefined
        || this.settlePermissionSelection === undefined) {
        return { outcome: 'not-sent', failureCode: 'lark-permission-picker-unavailable', retryable: false }
      }
      if (this.now() >= intent.permissionPicker.expiresAt) {
        return { outcome: 'not-sent', failureCode: 'lark-permission-picker-expired', retryable: false }
      }
      input = { permissionPicker: permissionPickerCard(
        intent.permissionPicker,
        this.approvalSecret,
        {
          channel: conversation.channel,
          account: conversation.account,
          tenant: conversation.tenant,
          bindingId: intent.bindingId,
          chatId: conversation.chat,
          ownerUser: intent.target.principal.user,
        },
      ) }
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
      input = useMarkdownCard ? { markdown: intent.text } : { text: intent.text }
    }
    // A synthetic lane represents all standalone group messages from one
    // sender. Replying to the inbound event would make Lark create a provider
    // thread; the user's next reply would then carry a real rootId and be
    // normalized into a different Delivery conversation/session. Keep this
    // lane top-level so later standalone messages retain the same context.
    const syntheticTopLevelGroup = conversation.kind === 'group'
      && isLarkTopLevelSenderThread(conversation.thread)
    const providerReplyTarget = syntheticTopLevelGroup
      ? undefined
      : (intent.replyToEventId
        ?? (conversation.kind === 'group' ? conversation.thread : undefined))
    const options: LarkSendOptions = {
      requestKey: intent.idempotencyKey,
      ...(providerReplyTarget === undefined ? {} : { replyTo: providerReplyTarget }),
      ...(conversation.kind === 'group' && providerReplyTarget !== undefined ? { replyInThread: true } : {}),
    }
    let result: Awaited<ReturnType<LarkTransport['send']>>
    try {
      result = await this.transport.send(conversation.chat, input, options)
    } catch (error) {
      if (!(error instanceof LarkTransportError) || error.code !== 'format_error') {
        return sendFailure(error)
      }
      // Agent-authored Markdown can be valid for DSH yet contain a construct the current Lark
      // card parser rejects. The answer is already durable at this boundary, so preserve it with
      // a text message instead of dead-lettering the only user-visible result.
      const fallback = useMarkdownCard
        ? { text: intent.text, suffix: 'markdown-fallback' }
        : intent.format === 'permission-picker' && intent.permissionPicker !== undefined
          ? { text: intent.text, suffix: 'permission-picker-fallback' }
          : intent.format === 'model-picker' && intent.modelPicker !== undefined
            ? { text: modelPickerFallbackText(intent), suffix: 'model-picker-fallback' }
            : undefined
      if (fallback === undefined) return sendFailure(error)
      try {
        result = await this.transport.send(conversation.chat, { text: fallback.text }, {
          ...options,
          requestKey: `${intent.idempotencyKey}:${fallback.suffix}`,
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

  private armToolApprovalTombstone(operationId: string, tombstone: ToolApprovalTombstone): void {
    const expire = () => {
      if (this.toolApprovalTombstones.get(operationId) !== tombstone) return
      let remaining: number
      try {
        remaining = tombstone.expiresAt - this.now()
      } catch {
        const pending = this.pendingToolApprovals.get(operationId)
        if (pending !== undefined) this.settleToolApproval(pending, 'unavailable')
        tombstone.timer = setTimeout(expire, 1_000)
        tombstone.timer.unref()
        return
      }
      if (!Number.isSafeInteger(remaining)) {
        const pending = this.pendingToolApprovals.get(operationId)
        if (pending !== undefined) this.settleToolApproval(pending, 'unavailable')
        tombstone.timer = setTimeout(expire, 1_000)
        tombstone.timer.unref()
        return
      }
      if (remaining <= 0) {
        const pending = this.pendingToolApprovals.get(operationId)
        if (pending !== undefined) this.settleToolApproval(pending, 'unavailable')
        this.deleteToolApprovalTombstone(operationId, tombstone)
        return
      }
      tombstone.timer = setTimeout(expire, Math.min(remaining, LARK_TOOL_APPROVAL_MAX_TIMER_MS))
      tombstone.timer.unref()
    }
    expire()
  }

  private deleteToolApprovalTombstone(operationId: string, tombstone: ToolApprovalTombstone): boolean {
    if (this.toolApprovalTombstones.get(operationId) !== tombstone) return false
    this.toolApprovalTombstones.delete(operationId)
    if (tombstone.timer !== undefined) clearTimeout(tombstone.timer)
    return true
  }

  private settleToolApproval(pending: PendingToolApproval, outcome: DeliveryToolApprovalOutcome): boolean {
    if (this.pendingToolApprovals.get(pending.payload.operationId) !== pending) return false
    this.pendingToolApprovals.delete(pending.payload.operationId)
    pending.signal.removeEventListener('abort', pending.abort)
    pending.resolve(outcome)
    return true
  }

  private cancelPendingToolApprovals(
    outcome: 'cancelled' | 'unavailable',
    clearTombstones = false,
  ): void {
    for (const pending of this.pendingToolApprovals.values()) {
      this.settleToolApproval(pending, outcome)
    }
    if (!clearTombstones) return
    for (const [operationId, tombstone] of this.toolApprovalTombstones) {
      this.deleteToolApprovalTombstone(operationId, tombstone)
    }
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

  private cancelModelSelectionUpdates(): void {
    for (const pending of this.modelSelectionUpdates.values()) {
      if (pending.start !== undefined) clearImmediate(pending.start)
      if (pending.deadline !== undefined) clearTimeout(pending.deadline)
      pending.controller.abort(new Error('lark-channel: model selection presentation stopped'))
    }
    this.modelSelectionUpdates.clear()
  }

  private startModelSelectionFinalUpdate(
    input: ModelSelectionSettlementInput,
    payload: Pick<LarkModelPickerActionPayload, 'provider' | 'model' | 'effort'>,
    picker: Readonly<ModelPickerIntent> | undefined,
  ): void {
    const awaitModelSelection = this.awaitModelSelection
    const updateRawCard = this.transport.updateRawCard?.bind(this.transport)
    if (awaitModelSelection === undefined || updateRawCard === undefined
      || this.modelSelectionUpdates.has(input.callbackEventId)) return
    const controller = new AbortController()
    const pending: PendingModelSelectionUpdate = { controller }
    this.modelSelectionUpdates.set(input.callbackEventId, pending)
    // Card callback ACKs are sent after this handler resolves. Start the
    // independent PATCH lifecycle in the next macrotask, then serialize the
    // pending and terminal replacements on one chain so provider-side request
    // reordering cannot restore the pending card over the terminal result.
    pending.start = setImmediate(() => {
      delete pending.start
      if (controller.signal.aborted || this.modelSelectionUpdates.get(input.callbackEventId) !== pending) return
      pending.deadline = setTimeout(() => {
        controller.abort(new Error('lark-channel: model selection final update timed out'))
      }, MODEL_SELECTION_FINAL_UPDATE_TIMEOUT_MS)
      pending.deadline.unref?.()
      void updateRawCard(input.cardMessageId, rawCard({
        modelSelectionResult: modelSelectionResultCard({ status: 'pending' }, payload, picker),
      }), controller.signal)
        .catch(error => {
          if (!controller.signal.aborted) this.recordPresentationFailure(error)
        })
        .then(async () => {
          if (controller.signal.aborted) return undefined
          return await awaitModelSelection(input, controller.signal)
        })
        .then(async result => {
          if (result === undefined || controller.signal.aborted) return
          await updateRawCard(input.cardMessageId, rawCard({
            modelSelectionResult: modelSelectionResultCard(result, payload, picker),
          }), controller.signal)
        })
        .catch(error => {
          if (!controller.signal.aborted) this.recordPresentationFailure(error)
        })
        .finally(() => {
          if (pending.deadline !== undefined) clearTimeout(pending.deadline)
          if (this.modelSelectionUpdates.get(input.callbackEventId) === pending) {
            this.modelSelectionUpdates.delete(input.callbackEventId)
          }
        })
    })
    pending.start.unref?.()
  }

  private async handleCardAction(action: import('./types.js').LarkCardAction): Promise<unknown> {
    try {
      const value = action.value
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new LarkApprovalError('invalid', 'Lark card action value is invalid')
      }
      if (typeof (value as { toolApproval?: unknown }).toolApproval === 'string') {
        if (Object.keys(value).length !== 1) {
          throw new LarkToolApprovalError('invalid', 'Lark tool approval action value is invalid')
        }
        return this.handleToolApprovalAction(action, (value as { toolApproval: string }).toolApproval)
      }
      if (Object.prototype.hasOwnProperty.call(value, 'permissionPicker')) {
        return await this.handlePermissionPickerAction(action, parseLarkPermissionPickerCallback(value))
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
      if (error instanceof LarkPermissionPickerError) {
        this.lastErrorCode = 'format_error'
        return { toast: { type: 'warning', content: error.code === 'expired'
          ? '权限卡片已过期，请重新发送 /permission'
          : '权限卡片无效或已失效，请重新发送 /permission' } }
      }
      if (error instanceof LarkApprovalError || error instanceof LarkModelPickerError
        || error instanceof LarkToolApprovalError) {
        this.lastErrorCode = 'format_error'
        return
      }
      throw error
    }
  }

  private async handlePermissionPickerAction(
    action: import('./types.js').LarkCardAction,
    callback: import('./permission-picker.js').LarkPermissionPickerCallbackValue,
  ): Promise<unknown> {
    if (!hasUsableApprovalSecret(this.approvalSecret) || this.settlePermissionSelection === undefined
      || action.tag !== 'button' || !larkProviderMessageIdentifier.test(action.messageId)) {
      throw new LarkPermissionPickerError('invalid', 'Lark permission picker callback is unavailable')
    }
    const token = callback.permissionPicker
    const payload = verifyLarkPermissionPickerAction(this.approvalSecret, token, this.now())
    if (payload.channel !== this.channel || payload.account !== this.account
      || payload.tenant !== this.config.tenant || payload.chatId !== action.chatId
      || payload.ownerUser !== action.operatorId) {
      throw new LarkPermissionPickerError('invalid', 'Lark permission picker route does not match')
    }
    const callbackEventId = createHash('sha256')
      .update(`${action.messageId}\0${action.operatorId}\0${token}`)
      .digest('hex')
    try {
      await this.settlePermissionSelection({
        operationId: payload.operationId,
        callbackEventId,
        callbackChatId: action.chatId,
        cardMessageId: action.messageId,
        bindingId: payload.bindingId,
        bindingVersion: payload.bindingVersion,
        sessionId: payload.sessionId,
        principal: {
          channel: payload.channel,
          account: payload.account,
          tenant: payload.tenant,
          user: payload.ownerUser,
        },
        issuedAt: payload.issuedAt,
        expiresAt: payload.expiresAt,
        expectedStateHash: payload.expectedStateHash,
        emergencyStopVersion: payload.emergencyStopVersion,
        targetLevel: payload.level,
      })
      return { toast: { type: 'success', content: '权限切换已受理' } }
    } catch (error) {
      this.recordPresentationFailure(error)
      return { toast: { type: 'warning', content: '权限卡片状态已更新，请重新发送 /permission' } }
    }
  }

  private handleToolApprovalAction(
    action: import('./types.js').LarkCardAction,
    token: string,
  ): Readonly<Record<string, unknown>> {
    if (!hasUsableApprovalSecret(this.approvalSecret) || action.tag !== 'button'
      || !larkProviderMessageIdentifier.test(action.messageId)) {
      throw new LarkToolApprovalError('invalid', 'Lark tool approval callback is unavailable')
    }
    const payload = verifyLarkToolApprovalAction(this.approvalSecret, token, this.now())
    if (payload.channel !== this.channel || payload.account !== this.account
      || payload.tenant !== this.config.tenant || payload.chatId !== action.chatId
      || payload.ownerUser !== action.operatorId) {
      throw new LarkToolApprovalError('invalid', 'Lark tool approval route does not match')
    }
    const pending = this.pendingToolApprovals.get(payload.operationId)
    if (pending === undefined || !sameToolApprovalPayload(pending.payload, payload)) {
      throw new LarkToolApprovalError('invalid', 'Lark tool approval request does not match')
    }
    if (pending.providerMessageId === undefined) {
      const earlyAction = pending.earlyAction
      if (earlyAction !== undefined && (earlyAction.messageId !== action.messageId
        || earlyAction.decision !== payload.decision)) {
        throw new LarkToolApprovalError('invalid', 'Lark tool approval request does not match')
      }
      pending.earlyAction = { messageId: action.messageId, decision: payload.decision }
      return { toast: { type: 'info', content: '正在确认工具审批卡片' } }
    }
    if (pending.providerMessageId !== action.messageId) {
      throw new LarkToolApprovalError('invalid', 'Lark tool approval request does not match')
    }
    if (!this.settleToolApproval(pending, payload.decision)) {
      throw new LarkToolApprovalError('invalid', 'Lark tool approval request is no longer pending')
    }
    return { toast: { type: payload.decision === 'allowed-once' ? 'success' : 'info',
      content: payload.decision === 'allowed-once' ? '已仅允许本次工具调用' : '已拒绝工具调用' } }
  }

  private async handleModelPickerAction(
    action: import('./types.js').LarkCardAction,
    callback: LarkModelPickerCallbackValue,
  ): Promise<unknown> {
    if (this.approvalSecret === undefined || this.settleModelSelection === undefined
      || !larkProviderMessageIdentifier.test(action.messageId)) {
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
          cardMessageId: action.messageId,
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
          cardMessageId: action.messageId,
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
      return callbackCard({ modelPicker: modelPickerCard(picker, this.approvalSecret, {
        ...capability, revision: state.revision,
      }, {
        provider: state.provider,
        route: `${state.provider}/${state.model}`,
        effort: state.reasoningEffort ?? null,
      }) })
    }
    if (action.tag !== 'button') {
      throw new LarkModelPickerError('invalid', 'Lark model picker confirmation action is invalid')
    }
    const callbackEventId = createHash('sha256')
      .update(`${action.messageId}\0${action.operatorId}\0${token}`)
      .digest('hex')
    try {
      const settlementInput: ModelSelectionSettlementInput = {
        operationId: payload.operationId,
        callbackEventId,
        callbackChatId: action.chatId,
        cardMessageId: action.messageId,
        bindingId: payload.bindingId,
        principal: { channel: 'lark', account: this.account, tenant: this.config.tenant, user: action.operatorId },
        provider: payload.provider,
        modelProvider: payload.provider,
        model: payload.model,
        expectedRevision: payload.revision,
        ...(payload.effort === null ? {} : { reasoningEffort: payload.effort }),
      }
      const settlement = await this.settleModelSelection(settlementInput)
      let picker: ModelPickerIntent | undefined
      if (this.loadModelPicker !== undefined) {
        try {
          picker = await this.loadModelPicker({
            operationId: payload.operationId,
            callbackChatId: action.chatId,
            cardMessageId: action.messageId,
            bindingId: payload.bindingId,
            principal: {
              channel: 'lark',
              account: this.account,
              tenant: this.config.tenant,
              user: action.operatorId,
            },
          })
        } catch {
          // Settlement already succeeded. Catalog labels are optional presentation data,
          // so keep the ACK successful and render the signed IDs instead.
        }
      }
      if (settlement.status === 'pending') {
        this.startModelSelectionFinalUpdate(settlementInput, payload, picker)
      }
      if (settlement.status === 'pending') {
        return { toast: { type: 'info', content: '模型选择已提交，正在验证' } }
      }
      return {
        toast: settlement.status === 'selected'
          ? { type: 'success', content: '模型已切换' }
          : { type: 'warning', content: '模型切换未生效' },
        ...callbackCard({ modelSelectionResult: modelSelectionResultCard(settlement, payload, picker) }),
      }
    } catch (error) {
      this.recordPresentationFailure(error)
      return { toast: { type: 'warning', content: '卡片状态已更新，请重新发送 /model' } }
    }
  }
}
