import { describe, expect, test, vi } from 'vitest'
import { LarkDeliveryAdapter } from '../src/adapter.ts'
import { renderLarkMessage } from '../src/sdk.ts'
import { LarkTransportError } from '../src/types.ts'
import type {
  DeliveryAdapterContext,
  InboxStatus,
  InboundEnvelope,
  ModelPickerState,
  OutboundIntent,
} from '@dsh-enhanced/assistant-delivery'
import type {
  LarkCardAction,
  LarkMessage,
  LarkSendInput,
  LarkSendOptions,
  LarkTransport,
  LarkTransportHandlers,
} from '../src/types.ts'

class FakeTransport implements LarkTransport {
  handlers: LarkTransportHandlers | undefined
  readonly connect = vi.fn(async () => {})
  readonly disconnect = vi.fn(async () => {})
  readonly send = vi.fn(async (_chatId: string, _input: LarkSendInput, _options?: LarkSendOptions) => ({ messageId: 'om_sent' }))
  readonly addReaction = vi.fn(async (_messageId: string, _emojiType: string) => 'reaction-1')
  readonly createProgress = vi.fn(async (_chatId: string, _options: { replyTo: string; hidden: boolean }) => ({
    cotId: 'cot-1', messageId: 'om_cot',
  }))
  readonly writeProgress = vi.fn(async (_handle: { cotId: string; messageId: string },
    _events: readonly { eventType: string; content: string; timestamp: string }[]) => {})
  subscribe(handlers: LarkTransportHandlers): () => void {
    if (this.handlers !== undefined) throw new Error('duplicate handlers')
    this.handlers = handlers
    return () => { if (this.handlers === handlers) this.handlers = undefined }
  }
  async emitMessage(value: LarkMessage): Promise<void> { await this.handlers?.message(value) }
  async emitCardAction(value: LarkCardAction): Promise<unknown> { return this.handlers?.cardAction(value) }
}

const baseMessage: LarkMessage = {
  messageId: 'om_in', chatId: 'oc_dm', chatType: 'p2p', senderId: 'ou_owner', content: 'hello',
  rawContentType: 'text', resources: [], mentionAll: false, mentionedBot: false, createTime: 1_000,
}

function intent(overrides: Partial<OutboundIntent> = {}): OutboundIntent {
  return {
    idempotencyKey: 'reply-1', bindingId: 'binding-1',
    target: {
      principal: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_owner' },
      conversation: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', kind: 'dm', chat: 'oc_dm' },
    },
    text: 'reply', format: 'plain', replyToEventId: 'om_in', ...overrides,
  }
}

function fixture() {
  const transport = new FakeTransport()
  const accept = vi.fn(async (_envelope: InboundEnvelope): Promise<{
    duplicate: boolean
    inboxId: string
    status: InboxStatus
  }> => ({ duplicate: false, inboxId: 'inbox-1', status: 'queued' }))
  const context: DeliveryAdapterContext = { accept, receipt: vi.fn(async () => {}) }
  const adapter = new LarkDeliveryAdapter({
    account: 'primary-bot', tenant: 'tenant-a', requireMentionInGroups: true,
    maxTextBytes: 65_536, staleAfterMs: 60_000,
  }, transport, { now: () => 1_100 })
  return { accept, adapter, context, transport }
}

const modelPicker = {
  operationId: 'model-picker-1',
  expiresAt: 2_000,
  current: { provider: 'codex-subscription', model: 'default', reasoningEffort: 'low' },
  providers: [
    { id: 'codex-subscription', name: 'Codex' },
    { id: 'claude-subscription', name: 'Claude' },
  ],
  models: [
    { provider: 'codex-subscription', id: 'default', name: 'Default', effortIds: ['low', 'high'] },
    { provider: 'codex-subscription', id: 'mini', name: 'Mini', effortIds: [] },
    { provider: 'claude-subscription', id: 'sonnet', name: 'Sonnet', effortIds: ['high'] },
    { provider: 'claude-subscription', id: 'opus', name: 'Opus', effortIds: ['low', 'high'] },
  ],
  efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
} as const

function durablePickerAdvance() {
  let current: ModelPickerState | undefined
  return vi.fn((input: { expected: ModelPickerState; next: Omit<ModelPickerState, 'revision'> }) => {
    if (current !== undefined && (current.revision !== input.expected.revision
      || current.provider !== input.expected.provider || current.model !== input.expected.model
      || current.reasoningEffort !== input.expected.reasoningEffort)) {
      return { applied: false, state: current }
    }
    current = { ...input.next, revision: (current?.revision ?? 0) + 1 }
    return { applied: true, state: current }
  })
}

function modelPickerElements(card: Record<string, unknown>): Array<Record<string, unknown>> {
  const body = card.body as { elements: Array<Record<string, unknown>> }
  // Each select now sits inside its own bordered container, so walk the tree rather than
  // assuming the controls are direct children of body.
  const flatten = (elements: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
    elements.flatMap(element => {
      const nested = element.elements
      return Array.isArray(nested)
        ? [element, ...flatten(nested as Array<Record<string, unknown>>)]
        : [element]
    })
  return flatten(body.elements)
}

function modelPickerElement(card: Record<string, unknown>, name: string): Record<string, unknown> {
  return modelPickerElements(card).find(element => element.name === name)!
}

describe('Lark delivery adapter', () => {
  test('persists inbound through delivery before the provider listener resolves', async () => {
    const f = fixture()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    f.accept.mockImplementationOnce(async () => {
      await gate
      return { duplicate: false, inboxId: 'inbox-1', status: 'queued' }
    })
    const dispose = await f.adapter.start(f.context)
    const pending = f.transport.emitMessage(baseMessage)
    await Promise.resolve()
    expect(f.accept).toHaveBeenCalledOnce()
    let resolved = false
    void pending.then(() => { resolved = true })
    await Promise.resolve()
    expect(resolved).toBe(false)
    release()
    await pending
    expect(resolved).toBe(true)
    await vi.waitFor(() => expect(f.transport.addReaction).toHaveBeenCalledWith('om_in', 'Get'))
    await dispose?.()
  })

  test('adds Get only for a newly queued inbound and treats reaction failure as presentation-only', async () => {
    const f = fixture()
    await f.adapter.start(f.context)
    await f.transport.emitMessage(baseMessage)
    await vi.waitFor(() => expect(f.transport.addReaction).toHaveBeenCalledWith('om_in', 'Get'))

    f.accept.mockResolvedValueOnce({ duplicate: true, inboxId: 'inbox-1', status: 'queued' })
    await f.transport.emitMessage({ ...baseMessage, messageId: 'om_duplicate' })
    f.accept.mockResolvedValueOnce({ duplicate: false, inboxId: 'inbox-denied', status: 'dead_letter' })
    await f.transport.emitMessage({ ...baseMessage, messageId: 'om_denied' })
    expect(f.transport.addReaction).toHaveBeenCalledTimes(1)

    f.transport.addReaction.mockRejectedValueOnce(new LarkTransportError('permission_denied', 'missing scope'))
    await expect(f.transport.emitMessage({ ...baseMessage, messageId: 'om_reaction_failure' })).resolves.toBeUndefined()
    await vi.waitFor(() => expect(f.adapter.health()).toMatchObject({ lastErrorCode: 'permission_denied' }))
  })

  test('renders plain and Markdown/card sends with exact reply/thread targets', async () => {
    const f = fixture()
    await f.adapter.start(f.context)
    await expect(f.adapter.send(intent(), new AbortController().signal)).resolves.toEqual({
      outcome: 'accepted', providerMessageId: 'om_sent',
    })
    expect(f.transport.send).toHaveBeenLastCalledWith('oc_dm', { text: 'reply' }, {
      replyTo: 'om_in', requestKey: 'reply-1',
    })
    expect(f.transport.addReaction).toHaveBeenLastCalledWith('om_in', 'DONE')

    const group = intent({ format: 'markdown', text: '**done**', target: {
      principal: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_owner' },
      conversation: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', kind: 'group', chat: 'oc_group', thread: 'omt_1' },
    } })
    await f.adapter.send(group, new AbortController().signal)
    expect(f.transport.send).toHaveBeenLastCalledWith('oc_group', { markdown: '**done**' }, {
      replyTo: 'om_in', replyInThread: true, requestKey: 'reply-1',
    })
  })

  test('keeps a successful final reply accepted when the DONE reaction fails', async () => {
    const f = fixture()
    await f.adapter.start(f.context)
    f.transport.addReaction.mockRejectedValueOnce(new LarkTransportError('permission_denied', 'missing scope'))
    await expect(f.adapter.send(intent(), new AbortController().signal)).resolves.toEqual({
      outcome: 'accepted', providerMessageId: 'om_sent',
    })
    expect(f.transport.send).toHaveBeenCalledOnce()
    expect(f.transport.addReaction).toHaveBeenCalledWith('om_in', 'DONE')
  })

  test('renders only safe native progress events and never a reasoning event', async () => {
    const f = fixture()
    await f.adapter.start(f.context)
    const common = {
      bindingId: 'binding-1', eventId: 'om_in', target: intent().target,
    }
    await f.adapter.progress?.({ ...common, update: { kind: 'started' } })
    await f.adapter.progress?.({ ...common, update: {
      kind: 'tool-started', callId: 'call-1', toolName: 'web.search',
    } })
    await f.adapter.progress?.({ ...common, update: {
      kind: 'tool-finished', callId: 'call-1', failed: false,
    } })
    await f.adapter.progress?.({ ...common, update: { kind: 'todos', todos: [
      { content: '核对接口', status: 'completed' },
      { content: '运行测试', status: 'in_progress' },
    ] } })
    await f.adapter.progress?.({ ...common, update: { kind: 'completed' } })

    expect(f.transport.createProgress).toHaveBeenCalledOnce()
    expect(f.transport.createProgress).toHaveBeenCalledWith('oc_dm', { replyTo: 'om_in', hidden: false })
    const serialized = JSON.stringify(f.transport.writeProgress.mock.calls)
    expect(serialized).toContain('RUN_STARTED')
    expect(serialized).toContain('TOOL_CALL_START')
    expect(serialized).toContain('TOOL_CALL_RESULT')
    expect(serialized).toContain('RUN_FINISHED')
    expect(serialized).toContain('核对接口')
    expect(serialized).not.toContain('REASONING_')
  })

  test('renders a reasoning-only turn as its own step bubble per step', async () => {
    const f = fixture()
    await f.adapter.start(f.context)
    const common = { bindingId: 'binding-1', eventId: 'om_in', target: intent().target }
    await f.adapter.progress?.({ ...common, update: { kind: 'started' } })
    // A turn that calls no tool and writes no todo must still say something.
    await f.adapter.progress?.({ ...common, update: { kind: 'step', text: '先确认当前目录' } })
    await f.adapter.progress?.({ ...common, update: { kind: 'step', text: '再核对分组顺序' } })
    await f.adapter.progress?.({ ...common, update: { kind: 'step', text: '' } })
    await f.adapter.progress?.({ ...common, update: { kind: 'completed' } })

    const calls = f.transport.writeProgress.mock.calls
    const events = calls.flatMap(call => call[1] as readonly { eventType: string; content: string }[])
    const contents = events
      .filter(event => event.eventType === 'TEXT_MESSAGE_CONTENT')
      .map(event => JSON.parse(event.content) as { messageId: string; delta: string })
    expect(contents.map(value => value.delta)).toEqual([
      '正在分析请求并制定执行步骤…', '先确认当前目录', '再核对分组顺序',
    ])
    // Distinct messageIds keep each step appended instead of overwriting the previous bubble.
    const stepIds = contents.slice(1).map(value => value.messageId)
    expect(new Set(stepIds).size).toBe(stepIds.length)
    // An empty step writes nothing at all.
    expect(JSON.stringify(calls)).not.toContain('"delta":""')
  })

  test('states a failed turn in the panel body instead of leaving it on the opening line', async () => {
    const f = fixture()
    await f.adapter.start(f.context)
    const common = { bindingId: 'binding-1', eventId: 'om_in', target: intent().target }
    await f.adapter.progress?.({ ...common, update: { kind: 'started' } })
    // The provider can fail before emitting any output, so the failure itself must be visible.
    await f.adapter.progress?.({ ...common, update: { kind: 'failed', code: 'ACP_PROTOCOL_ERROR' } })

    const serialized = JSON.stringify(f.transport.writeProgress.mock.calls)
    expect(serialized).toContain('RUN_ERROR')
    expect(serialized).toContain('ACP_PROTOCOL_ERROR')
    expect(serialized).toContain('任务未完成')
  })

  test('renders a failure without an upstream code as a plain incomplete notice', async () => {
    const f = fixture()
    await f.adapter.start(f.context)
    const common = { bindingId: 'binding-1', eventId: 'om_in', target: intent().target }
    await f.adapter.progress?.({ ...common, update: { kind: 'started' } })
    await f.adapter.progress?.({ ...common, update: { kind: 'failed' } })

    const serialized = JSON.stringify(f.transport.writeProgress.mock.calls)
    expect(serialized).toContain('任务未完成')
    expect(serialized).not.toContain('undefined')
  })

  test('sends a signed approval card and settles only the correlated actor and chat', async () => {
    const transport = new FakeTransport()
    const settleApproval = vi.fn(() => ({ status: 'approved' }))
    const adapter = new LarkDeliveryAdapter({
      account: 'primary-bot', tenant: 'tenant-a', requireMentionInGroups: true,
      maxTextBytes: 65_536, staleAfterMs: 60_000,
    }, transport, {
      now: () => 1_000,
      approvalSecret: 'test-secret-at-least-32-characters-long',
      settleApproval,
    })
    const context: DeliveryAdapterContext = { accept: vi.fn(async () => ({
      duplicate: false, inboxId: 'inbox-1', status: 'queued' as const,
    })),
      receipt: vi.fn(async () => {}) }
    await adapter.start(context)
    const approvalIntent = intent({
      format: 'approval', text: 'Approve this?',
      approval: { operationId: 'operation-1', proposalId: 'proposal-1', expectedVersion: 1,
        expiresAt: 2_000, title: 'Approval required' },
    })
    await expect(adapter.send(approvalIntent, new AbortController().signal)).resolves.toMatchObject({ outcome: 'accepted' })
    const sent = transport.send.mock.calls.at(-1)![1] as { approval: { approveValue: { approval: string } } }
    await transport.emitCardAction({ messageId: 'om_card', chatId: 'oc_dm', operatorId: 'ou_owner',
      value: sent.approval.approveValue })
    expect(settleApproval).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'operation-1', callbackChatId: 'oc_dm', bindingId: 'binding-1',
      principal: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_owner' },
      proposalId: 'proposal-1', expectedVersion: 1, decision: 'approved',
    }))

    await transport.emitCardAction({ messageId: 'om_card', chatId: 'oc_attacker', operatorId: 'ou_owner',
      value: sent.approval.approveValue })
    expect(settleApproval).toHaveBeenCalledOnce()
    expect(adapter.health()).toMatchObject({ lastErrorCode: 'format_error' })
  })

  test('cascades signed model callbacks without form state and settles the selected effort', async () => {
    const transport = new FakeTransport()
    const settleModelSelection = vi.fn(() => ({ status: 'selected' as const }))
    const loadModelPicker = vi.fn(() => modelPicker)
    const advanceModelPicker = durablePickerAdvance()
    const adapter = new LarkDeliveryAdapter({
      account: 'primary-bot', tenant: 'tenant-a', requireMentionInGroups: true,
      maxTextBytes: 65_536, staleAfterMs: 60_000,
    }, transport, {
      now: () => 1_000,
      approvalSecret: 'test-secret-at-least-32-characters-long',
      settleModelSelection,
      loadModelPicker,
      advanceModelPicker,
    })
    const context: DeliveryAdapterContext = { accept: vi.fn(async () => ({
      duplicate: false, inboxId: 'inbox-1', status: 'queued' as const,
    })),
      receipt: vi.fn(async () => {}) }
    await adapter.start(context)
    await adapter.send(intent({ format: 'model-picker', text: '请选择模型', modelPicker }), new AbortController().signal)
    const sent = transport.send.mock.calls.at(-1)![1] as {
      modelPicker: import('../src/types.ts').LarkModelPickerCard
    }
    expect(sent.modelPicker.modelOptions).toEqual([
      { value: 'codex-subscription/default', label: 'Default' },
      { value: 'codex-subscription/mini', label: 'Mini' },
    ])
    expect(sent.modelPicker.effortOptions).toEqual([
      { value: '__default__', label: '默认（由模型决定）' },
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
    ])
    const sentCard = JSON.parse(renderLarkMessage({ modelPicker: sent.modelPicker }).content) as Record<string, unknown>
    expect(modelPickerElements(sentCard).some(element => element.tag === 'form')).toBe(false)
    const initialProvider = modelPickerElement(sentCard, 'model_provider')

    const providerUpdate = await transport.emitCardAction({
      messageId: 'om_model_card', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'select_static', option: 'claude-subscription',
      value: initialProvider.value,
    }) as { card: { type: string; data: Record<string, unknown> } }
    expect(providerUpdate.card.type).toBe('raw')
    const providerModel = modelPickerElement(providerUpdate.card.data, 'model_route')
    expect(providerModel).toMatchObject({
      initial_index: 1,
      initial_option: 'Sonnet',
      options: [
        { text: { content: 'Sonnet' }, value: 'claude-subscription/sonnet' },
        { text: { content: 'Opus' }, value: 'claude-subscription/opus' },
      ],
    })
    const providerEffort = modelPickerElement(providerUpdate.card.data, 'model_effort')
    expect(providerEffort).toMatchObject({
      initial_index: 1,
      initial_option: '默认（由模型决定）',
      options: [
        { text: { content: '默认（由模型决定）' }, value: '__default__' },
        { text: { content: 'High' }, value: 'high' },
      ],
    })

    const modelUpdate = await transport.emitCardAction({
      messageId: 'om_model_card', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'select_static', option: 'claude-subscription/opus',
      value: providerModel.value,
    }) as { card: { type: string; data: Record<string, unknown> } }
    expect(modelUpdate.card.type).toBe('raw')
    const modelEffort = modelPickerElement(modelUpdate.card.data, 'model_effort')
    expect(modelEffort).toMatchObject({
      initial_index: 1,
      initial_option: '默认（由模型决定）',
      options: [
        { text: { content: '默认（由模型决定）' }, value: '__default__' },
        { text: { content: 'Low' }, value: 'low' },
        { text: { content: 'High' }, value: 'high' },
      ],
    })
    expect(loadModelPicker).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'model-picker-1', callbackChatId: 'oc_dm', bindingId: 'binding-1',
    }))

    const effortUpdate = await transport.emitCardAction({
      messageId: 'om_model_card', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'select_static', option: 'high', value: modelEffort.value,
    }) as { card: { type: string; data: Record<string, unknown> } }
    const effortConfirm = modelPickerElement(effortUpdate.card.data, 'model_confirm')

    const staleUpdate = await transport.emitCardAction({
      messageId: 'om_model_card', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'select_static', option: 'codex-subscription', value: initialProvider.value,
    }) as { card: { data: Record<string, unknown> } }
    expect(modelPickerElement(staleUpdate.card.data, 'model_route')).toMatchObject({
      initial_index: 2,
      initial_option: 'Opus',
    })
    expect(modelPickerElement(staleUpdate.card.data, 'model_effort'))
      .toMatchObject({ initial_index: 3, initial_option: 'High' })

    await expect(transport.emitCardAction({
      messageId: 'om_model_card', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'button', value: effortConfirm.value,
    })).resolves.toEqual({ toast: { type: 'success', content: '模型切换已受理' } })
    expect(settleModelSelection).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'model-picker-1', callbackChatId: 'oc_dm', bindingId: 'binding-1',
      principal: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_owner' },
      provider: 'claude-subscription', modelProvider: 'claude-subscription', model: 'opus', reasoningEffort: 'high',
      expectedRevision: 3,
    }))
    expect(advanceModelPicker).toHaveBeenCalledTimes(4)

    advanceModelPicker.mockRejectedValueOnce(new Error('selection already settled'))
    await expect(transport.emitCardAction({
      messageId: 'om_model_card', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'select_static', option: 'codex-subscription', value: initialProvider.value,
    })).resolves.toEqual({ toast: { type: 'warning', content: '模型选择已结束，请重新发送 /model' } })

    loadModelPicker.mockImplementationOnce(() => { throw new Error('binding revoked') })
    await expect(transport.emitCardAction({
      messageId: 'om_model_card', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'select_static', option: 'codex-subscription', value: initialProvider.value,
    })).resolves.toEqual({ toast: { type: 'warning', content: '模型选择已结束，请重新发送 /model' } })

    await transport.emitCardAction({
      messageId: 'om_model_card', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'button', value: {
        ...(effortConfirm.value as Record<string, unknown>), modelPicker: 'tampered-token',
      },
    })
    expect(settleModelSelection).toHaveBeenCalledTimes(1)
    expect(adapter.health()).toMatchObject({ lastErrorCode: 'format_error' })

    await transport.emitCardAction({
      messageId: 'om_model_card', chatId: 'oc_attacker', operatorId: 'ou_owner',
      tag: 'button', value: effortConfirm.value,
    })
    expect(settleModelSelection).toHaveBeenCalledTimes(1)
  })

  test('keeps a real __default__ effort distinct from the UI default choice', async () => {
    const transport = new FakeTransport()
    const settleModelSelection = vi.fn(() => ({ status: 'selected' as const }))
    const advanceModelPicker = durablePickerAdvance()
    const collidingPicker = {
      operationId: 'model-picker-default-effort',
      expiresAt: 2_000,
      current: { provider: 'custom', model: 'model' },
      providers: [{ id: 'custom', name: 'Custom' }],
      models: [{ provider: 'custom', id: 'model', name: 'Model', effortIds: ['__default__'] }],
      efforts: [{ id: '__default__', name: 'Literal __default__ effort' }],
    } as const
    const adapter = new LarkDeliveryAdapter({
      account: 'primary-bot', tenant: 'tenant-a', requireMentionInGroups: true,
      maxTextBytes: 65_536, staleAfterMs: 60_000,
    }, transport, {
      now: () => 1_000,
      approvalSecret: 'test-secret-at-least-32-characters-long',
      settleModelSelection,
      loadModelPicker: vi.fn(() => collidingPicker),
      advanceModelPicker,
    })
    await adapter.start({ accept: vi.fn(), receipt: vi.fn() } as unknown as DeliveryAdapterContext)
    await adapter.send(intent({ format: 'model-picker', text: '请选择模型', modelPicker: collidingPicker }),
      new AbortController().signal)
    const sent = transport.send.mock.calls.at(-1)![1] as { modelPicker: Parameters<typeof renderLarkMessage>[0] extends {
      modelPicker: infer T
    } ? T : never }
    const card = JSON.parse(renderLarkMessage({ modelPicker: sent.modelPicker }).content) as Record<string, unknown>
    const effort = modelPickerElement(card, 'model_effort')
    const options = effort.options as Array<{ text: { content: string }; value: string }>
    expect(new Set(options.map(option => option.value)).size).toBe(2)
    const literal = options.find(option => option.text.content === 'Literal __default__ effort')!
    const update = await transport.emitCardAction({
      messageId: 'om_model_card', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'select_static', option: literal.value, value: effort.value,
    }) as { card: { data: Record<string, unknown> } }
    await transport.emitCardAction({
      messageId: 'om_model_card', chatId: 'oc_dm', operatorId: 'ou_owner', tag: 'button',
      value: modelPickerElement(update.card.data, 'model_confirm').value,
    })
    expect(settleModelSelection).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'custom', model: 'model', reasoningEffort: '__default__',
    }))
  })

  test('falls back to a usable text catalog when Lark rejects the model-picker card format', async () => {
    const transport = new FakeTransport()
    transport.send.mockRejectedValueOnce(new LarkTransportError('format_error', 'invalid card'))
    const adapter = new LarkDeliveryAdapter({
      account: 'primary-bot', tenant: 'tenant-a', requireMentionInGroups: true,
      maxTextBytes: 65_536, staleAfterMs: 60_000,
    }, transport, {
      now: () => 1_000,
      approvalSecret: 'test-secret-at-least-32-characters-long',
      settleModelSelection: vi.fn(),
      loadModelPicker: vi.fn(() => modelPicker),
      advanceModelPicker: durablePickerAdvance(),
    })
    await adapter.start({ accept: vi.fn(), receipt: vi.fn() } as unknown as DeliveryAdapterContext)

    await expect(adapter.send(intent({
      format: 'model-picker', text: '当前模型：codex-subscription/default', modelPicker,
    }), new AbortController().signal)).resolves.toEqual({
      outcome: 'accepted', providerMessageId: 'om_sent',
    })
    expect(transport.send).toHaveBeenCalledTimes(2)
    expect(transport.send.mock.calls[1]?.[1]).toMatchObject({
      text: expect.stringContaining('飞书未接受模型选择卡片'),
    })
    const fallback = (transport.send.mock.calls[1]![1] as { text: string }).text
    expect(fallback).toContain('codex-subscription/default')
    expect(fallback).toContain('/model use <provider/model>')
    expect(transport.send.mock.calls[1]?.[2]).toEqual({
      replyTo: 'om_in', requestKey: 'reply-1:model-picker-fallback',
    })
    expect(transport.addReaction).toHaveBeenCalledWith('om_in', 'DONE')
  })

  test('fails closed on route/account/tenant mismatch and invalid provider result', async () => {
    const f = fixture()
    await f.adapter.start(f.context)
    await expect(f.adapter.send(intent({ target: {
      principal: { channel: 'lark', account: 'other', tenant: 'tenant-a', user: 'ou_owner' },
      conversation: { channel: 'lark', account: 'other', tenant: 'tenant-a', kind: 'dm', chat: 'oc_dm' },
    } }), new AbortController().signal)).resolves.toMatchObject({ outcome: 'not-sent', retryable: false })
    f.transport.send.mockResolvedValueOnce({ messageId: '' })
    await expect(f.adapter.send(intent(), new AbortController().signal)).resolves.toMatchObject({
      outcome: 'unknown', failureCode: 'invalid-provider-result',
    })
  })

  test.each([
    ['permission_denied', false, undefined],
    ['format_error', false, undefined],
    ['rate_limited', true, 2_000],
    ['not_connected', true, undefined],
  ] as const)('classifies definitely-unsent %s failures', async (code, retryable, retryAfterMs) => {
    const f = fixture()
    await f.adapter.start(f.context)
    f.transport.send.mockRejectedValueOnce(new LarkTransportError(code, code, retryAfterMs))
    await expect(f.adapter.send(intent(), new AbortController().signal)).resolves.toEqual({
      outcome: 'not-sent', failureCode: `lark-${code.replaceAll('_', '-')}`, retryable,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    })
  })

  test.each(['send_timeout', 'unknown'] as const)('preserves ambiguous %s sends for operator reconciliation', async code => {
    const f = fixture()
    await f.adapter.start(f.context)
    f.transport.send.mockRejectedValueOnce(new LarkTransportError(code, code))
    await expect(f.adapter.send(intent(), new AbortController().signal)).resolves.toEqual({
      outcome: 'unknown', failureCode: `lark-${code.replaceAll('_', '-')}`,
    })
  })

  test('cleans up listeners and exposes reconnect-gap health without claiming replay', async () => {
    const f = fixture()
    const dispose = await f.adapter.start(f.context)
    f.transport.handlers?.reconnecting()
    expect(f.adapter.health()).toMatchObject({ state: 'reconnecting', gapGeneration: 1 })
    f.transport.handlers?.reconnected()
    expect(f.adapter.health()).toMatchObject({ state: 'connected-with-gap', gapGeneration: 1 })
    await dispose?.()
    expect(f.transport.handlers).toBeUndefined()
    expect(f.transport.disconnect).toHaveBeenCalledOnce()
  })

  test('rolls back subscriptions and disconnects when connect fails', async () => {
    const f = fixture()
    f.transport.connect.mockRejectedValueOnce(new Error('bad credentials'))
    await expect(f.adapter.start(f.context)).rejects.toThrow(/bad credentials/)
    expect(f.transport.handlers).toBeUndefined()
    expect(f.transport.disconnect).toHaveBeenCalledOnce()
  })
})
