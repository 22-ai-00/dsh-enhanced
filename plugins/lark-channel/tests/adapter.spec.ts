import { describe, expect, test, vi } from 'vitest'
import { LarkDeliveryAdapter } from '../src/adapter.ts'
import { renderLarkMessage } from '../src/sdk.ts'
import { LarkTransportError } from '../src/types.ts'
import type {
  DeliveryAdapterContext,
  InboxStatus,
  InboundEnvelope,
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
  ],
  efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
} as const

function modelPickerForm(card: Record<string, unknown>): {
  name: string
  elements: Array<Record<string, unknown>>
} {
  const body = card.body as { elements: Array<Record<string, unknown>> }
  return body.elements.find(element => element.tag === 'form') as {
    name: string
    elements: Array<Record<string, unknown>>
  }
}

function modelPickerControls(form: { elements: Array<Record<string, unknown>> }): {
  provider: string
  model: string
  effort: string
  confirm: string
} {
  const selects = form.elements.filter(element => element.tag === 'select_static')
  const confirm = form.elements.find(element => element.tag === 'button')
  return {
    provider: String(selects[0]!.name),
    model: String(selects[1]!.name),
    effort: String(selects[2]!.name),
    confirm: String(confirm!.name),
  }
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

  test('sends a signed three-dropdown model form and settles its correlated submission', async () => {
    const transport = new FakeTransport()
    const settleModelSelection = vi.fn(() => ({ status: 'selected' as const }))
    const loadModelPicker = vi.fn(() => modelPicker)
    const adapter = new LarkDeliveryAdapter({
      account: 'primary-bot', tenant: 'tenant-a', requireMentionInGroups: true,
      maxTextBytes: 65_536, staleAfterMs: 60_000,
    }, transport, {
      now: () => 1_000,
      approvalSecret: 'test-secret-at-least-32-characters-long',
      settleModelSelection,
      loadModelPicker,
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
    const initialControls = modelPickerControls(modelPickerForm(sentCard))

    const providerUpdate = await transport.emitCardAction({
      messageId: 'om_model_card', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'select_static', name: initialControls.provider,
      formValue: { [initialControls.provider]: 'claude-subscription' },
      value: sent.modelPicker.confirmValue,
    }) as { card: { type: string; data: Record<string, unknown> } }
    expect(providerUpdate.card.type).toBe('raw')
    const providerForm = modelPickerForm(providerUpdate.card.data)
    const providerSelects = providerForm.elements.filter(element => element.tag === 'select_static')
    expect(providerSelects[1]).toMatchObject({
      name: expect.stringMatching(/^model_[a-f0-9]{16}$/u), initial_option: 'claude-subscription/sonnet',
      options: [{ text: { content: 'Sonnet' }, value: 'claude-subscription/sonnet' }],
    })
    expect(providerSelects[2]).toMatchObject({
      name: expect.stringMatching(/^effort_[a-f0-9]{16}$/u), initial_option: '__default__',
      options: [
        { text: { content: '默认（由模型决定）' }, value: '__default__' },
        { text: { content: 'High' }, value: 'high' },
      ],
    })
    const providerControls = modelPickerControls(providerForm)
    expect(providerControls).not.toEqual(initialControls)

    const modelUpdate = await transport.emitCardAction({
      messageId: 'om_model_card', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'select_static', name: initialControls.model, formValue: {
        [initialControls.provider]: 'codex-subscription',
        [initialControls.model]: 'codex-subscription/mini',
      },
      value: sent.modelPicker.confirmValue,
    }) as { card: { type: string; data: Record<string, unknown> } }
    expect(modelUpdate.card.type).toBe('raw')
    const modelForm = modelPickerForm(modelUpdate.card.data)
    expect(modelForm.elements.filter(element => element.tag === 'select_static')[2]).toMatchObject({
      name: expect.stringMatching(/^effort_[a-f0-9]{16}$/u), initial_option: '__default__',
      options: [{ text: { content: '默认（该模型无 effort 档位）' }, value: '__default__' }],
    })
    expect(loadModelPicker).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'model-picker-1', callbackChatId: 'oc_dm', bindingId: 'binding-1',
    }))
    await transport.emitCardAction({
      messageId: 'om_model_card', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'button', name: providerControls.confirm,
      value: sent.modelPicker.confirmValue,
      formValue: {
        [providerControls.provider]: 'claude-subscription',
        [providerControls.model]: 'claude-subscription/sonnet',
        [providerControls.effort]: 'high',
      },
    })
    expect(settleModelSelection).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'model-picker-1', callbackChatId: 'oc_dm', bindingId: 'binding-1',
      principal: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_owner' },
      provider: 'claude-subscription', modelProvider: 'claude-subscription', model: 'sonnet', reasoningEffort: 'high',
    }))

    await transport.emitCardAction({
      messageId: 'om_model_card', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'button', name: providerControls.confirm,
      value: sent.modelPicker.confirmValue,
      formValue: {
        [providerControls.provider]: 'claude-subscription',
        [providerControls.model]: 'codex-subscription/default',
        [providerControls.effort]: 'high',
      },
    })
    expect(settleModelSelection).toHaveBeenCalledTimes(1)
    expect(adapter.health()).toMatchObject({ lastErrorCode: 'format_error' })

    await transport.emitCardAction({
      messageId: 'om_model_card', chatId: 'oc_attacker', operatorId: 'ou_owner',
      tag: 'button', name: providerControls.confirm,
      value: sent.modelPicker.confirmValue,
      formValue: {
        [providerControls.provider]: 'claude-subscription',
        [providerControls.model]: 'claude-subscription/sonnet',
        [providerControls.effort]: 'high',
      },
    })
    expect(settleModelSelection).toHaveBeenCalledTimes(1)
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
