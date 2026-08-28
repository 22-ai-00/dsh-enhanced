import { createHash } from 'node:crypto'
import { describe, expect, test, vi } from 'vitest'
import { LarkDeliveryAdapter, type LarkAdapterOptions } from '../src/adapter.ts'
import { signLarkApprovalAction, verifyLarkApprovalAction } from '../src/approval.ts'
import { LARK_APPROVAL_CARD_MAX_BYTES, renderLarkMessage } from '../src/sdk.ts'
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
  readonly updateRawCard = vi.fn(async (_messageId: string, _card: Readonly<Record<string, unknown>>,
    _signal: AbortSignal) => {})
  readonly downloadMessageImage = vi.fn(async (_messageId: string, _fileKey: string,
    _options: { maxBytes: number; signal: AbortSignal }) => ({
    data: new Uint8Array(Buffer.from('89504e470d0a1a0a', 'hex')),
    mediaType: 'image/png' as const,
  }))
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
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

const permissionPicker = {
  operationId: 'permission-picker-1',
  issuedAt: 1_000,
  expiresAt: 2_000,
  current: 'full',
  expectedStateHash: 'a'.repeat(64),
  emergencyStopVersion: 0,
  bindingVersion: 7,
  sessionId: 'session-1',
} as const

const unavailablePermissionPickerOptions: LarkAdapterOptions[] = [
  { settlePermissionSelection: vi.fn() },
  { approvalSecret: 'test-secret-at-least-32-characters-long' },
]

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
  const flatten = (value: unknown): Array<Record<string, unknown>> => {
    if (Array.isArray(value)) return value.flatMap(flatten)
    if (value === null || typeof value !== 'object') return []
    const record = value as Record<string, unknown>
    return [record, ...Object.values(record).flatMap(flatten)]
  }
  return flatten(card)
}

function modelPickerElement(card: Record<string, unknown>, name: string): Record<string, unknown> {
  return modelPickerElements(card).find(element => element.name === name)!
}

describe('Lark delivery adapter', () => {
  test('exposes an image-only, message-bound inbound resource reader', async () => {
    const f = fixture()
    expect(f.adapter.capabilities.inboundImages).toBe(true)
    const signal = new AbortController().signal
    await expect(f.adapter.readInboundImage({
      eventId: 'om_in',
      attachment: { resourceType: 'image', providerRef: 'img_v3_safe', fileName: 'provider-name.png' },
      maxBytes: 1_024,
    }, signal)).resolves.toEqual({
      outcome: 'downloaded',
      data: new Uint8Array(Buffer.from('89504e470d0a1a0a', 'hex')),
      mediaType: 'image/png',
    })
    expect(f.transport.downloadMessageImage).toHaveBeenCalledWith('om_in', 'img_v3_safe', {
      maxBytes: 1_024,
      signal,
    })

    await expect(f.adapter.readInboundImage({
      eventId: 'om_in',
      attachment: { resourceType: 'file', providerRef: 'file_safe' },
      maxBytes: 1_024,
    }, signal)).resolves.toMatchObject({ outcome: 'not-downloaded', retryable: false })
    await expect(f.adapter.readInboundImage({
      eventId: 'om_in',
      attachment: { resourceType: 'image', providerRef: '../private' },
      maxBytes: 1_024,
    }, signal)).resolves.toMatchObject({ outcome: 'not-downloaded', retryable: false })
    expect(f.transport.downloadMessageImage).toHaveBeenCalledTimes(1)
  })

  test('does not advertise inbound images when a custom transport has no callable resource reader', () => {
    const channel = new FakeTransport()
    Object.defineProperty(channel, 'downloadMessageImage', { value: null })
    const adapter = new LarkDeliveryAdapter({
      account: 'primary-bot', tenant: 'tenant-a', requireMentionInGroups: true,
      maxTextBytes: 65_536, staleAfterMs: 60_000,
    }, channel)
    expect(adapter.capabilities.inboundImages).toBe(false)
  })

  test.each(unavailablePermissionPickerOptions)(
    'does not advertise permission cards without both signing and settlement support', options => {
      const adapter = new LarkDeliveryAdapter({
        account: 'primary-bot', tenant: 'tenant-a', requireMentionInGroups: true,
        maxTextBytes: 65_536, staleAfterMs: 60_000,
      }, new FakeTransport(), options)
      expect(adapter.capabilities.formats).not.toContain('permission-picker')
    },
  )

  test('maps image download cancellation, permission, throttling, and unknown failures without provider details', async () => {
    const f = fixture()
    const input = {
      eventId: 'om_in', attachment: { resourceType: 'image' as const, providerRef: 'img_v3_safe' }, maxBytes: 1_024,
    }
    const aborted = new AbortController()
    aborted.abort(new Error('secret cancellation reason'))
    await expect(f.adapter.readInboundImage(input, aborted.signal)).resolves.toEqual({
      outcome: 'not-downloaded', failureCode: 'lark-image-aborted', retryable: true,
    })
    expect(f.transport.downloadMessageImage).not.toHaveBeenCalled()

    f.transport.downloadMessageImage.mockRejectedValueOnce(
      new LarkTransportError('permission_denied', 'provider secret detail'),
    )
    await expect(f.adapter.readInboundImage(input, new AbortController().signal)).resolves.toEqual({
      outcome: 'not-downloaded', failureCode: 'lark-image-permission-denied', retryable: false,
    })

    f.transport.downloadMessageImage.mockRejectedValueOnce(
      new LarkTransportError('rate_limited', 'provider secret detail', 2_000),
    )
    await expect(f.adapter.readInboundImage(input, new AbortController().signal)).resolves.toEqual({
      outcome: 'not-downloaded', failureCode: 'lark-image-rate-limited', retryable: true, retryAfterMs: 2_000,
    })

    f.transport.downloadMessageImage.mockRejectedValueOnce(new Error('img_v3_do-not-leak'))
    const unknown = await f.adapter.readInboundImage(input, new AbortController().signal)
    expect(unknown).toEqual({ outcome: 'not-downloaded', failureCode: 'lark-image-unknown', retryable: true })
    expect(JSON.stringify(unknown)).not.toContain('img_v3_do-not-leak')
  })

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

  test('keeps a synthetic top-level group lane top-level even when Delivery supplies its inbound event id', async () => {
    const f = fixture()
    await f.adapter.start(f.context)
    const group = intent({ target: {
      principal: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_owner' },
      conversation: {
        channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', kind: 'group', chat: 'oc_group',
        thread: `dsh-lark-top-sender/${'a'.repeat(43)}`,
      },
    } })
    await expect(f.adapter.send(group, new AbortController().signal)).resolves.toMatchObject({ outcome: 'accepted' })
    expect(f.transport.send).toHaveBeenLastCalledWith('oc_group', { text: 'reply' }, {
      requestKey: 'reply-1',
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

  test('does not wait for a slow DONE reaction after Lark accepts the reply', async () => {
    const f = fixture()
    await f.adapter.start(f.context)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    f.transport.addReaction.mockImplementationOnce(async () => {
      await gate
      return 'reaction-done'
    })

    const send = f.adapter.send(intent(), new AbortController().signal)
    await expect(send).resolves.toEqual({ outcome: 'accepted', providerMessageId: 'om_sent' })
    expect(f.transport.addReaction).toHaveBeenCalledWith('om_in', 'DONE')
    release()
    await vi.waitFor(() => expect(f.transport.addReaction).toHaveResolved())
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
      .map(event => JSON.parse(event.content) as { message_id: string; content: string })
    // Feishu accepts an arbitrary JSON string for the event but only renders
    // its documented snake_case fields.  The former messageId/delta payload
    // therefore created blank COT text blocks in the real client.
    expect(contents.map(value => value.content)).toEqual([
      '正在分析请求并制定执行步骤…', '先确认当前目录', '再核对分组顺序',
    ])
    expect(contents.every(value => Object.hasOwn(value, 'message_id') && !Object.hasOwn(value, 'messageId'))).toBe(true)
    expect(contents.every(value => !Object.hasOwn(value, 'delta'))).toBe(true)
    // Distinct message_ids keep each step appended instead of overwriting the previous bubble.
    const stepIds = contents.slice(1).map(value => value.message_id)
    expect(new Set(stepIds).size).toBe(stepIds.length)
    // An empty step writes nothing at all.
    expect(JSON.stringify(calls)).not.toContain('"content":""')
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
    const recoverApprovalSettlement = vi.fn((_input: unknown): { status: string } | undefined => ({ status: 'approved' }))
    const adapter = new LarkDeliveryAdapter({
      account: 'primary-bot', tenant: 'tenant-a', requireMentionInGroups: true,
      maxTextBytes: 65_536, staleAfterMs: 60_000,
    }, transport, {
      now: () => 1_000,
      approvalSecret: 'test-secret-at-least-32-characters-long',
      settleApproval,
      recoverApprovalSettlement,
    })
    const context: DeliveryAdapterContext = { accept: vi.fn(async () => ({
      duplicate: false, inboxId: 'inbox-1', status: 'queued' as const,
    })),
      receipt: vi.fn(async () => {}) }
    await adapter.start(context)
    const approvalIntent = intent({
      format: 'approval', text: 'Approve this?',
      approval: { operationId: 'operation-1', proposalId: 'proposal-1', expectedVersion: 1,
        expiresAt: 2_000, title: 'Approval required', diffHash: sha256('Approve this?') },
    })
    await expect(adapter.send(approvalIntent, new AbortController().signal)).resolves.toMatchObject({ outcome: 'accepted' })
    const sent = transport.send.mock.calls.at(-1)![1] as { approval: { approveValue: { approval: string } } }
    await transport.emitCardAction({ messageId: 'om_card', chatId: 'oc_dm', operatorId: 'ou_owner',
      value: sent.approval.approveValue })
    expect(settleApproval).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'operation-1', callbackChatId: 'oc_dm', bindingId: 'binding-1',
      principal: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_owner' },
      proposalId: 'proposal-1', expectedVersion: 1, decision: 'approved',
      diffHash: sha256('Approve this?'),
    }))
    expect(recoverApprovalSettlement).not.toHaveBeenCalled()

    await transport.emitCardAction({ messageId: 'om_card', chatId: 'oc_attacker', operatorId: 'ou_owner',
      value: sent.approval.approveValue })
    expect(settleApproval).toHaveBeenCalledOnce()
    expect(recoverApprovalSettlement).not.toHaveBeenCalled()
    const secret = 'test-secret-at-least-32-characters-long'
    const signed = sent.approval.approveValue.approval
    const wrongRoute = signLarkApprovalAction(secret, {
      ...verifyLarkApprovalAction(secret, signed, 1_000),
      account: 'attacker-bot',
    })
    await transport.emitCardAction({ messageId: 'om_card', chatId: 'oc_dm', operatorId: 'ou_owner',
      value: { approval: wrongRoute } })
    expect(settleApproval).toHaveBeenCalledOnce()
    expect(recoverApprovalSettlement).not.toHaveBeenCalled()
    expect(adapter.health()).toMatchObject({ lastErrorCode: 'format_error' })
  })

  test('uses only durable recovery for an expired authenticated approval capability', async () => {
    const transport = new FakeTransport()
    const settleApproval = vi.fn(() => ({ status: 'approved' }))
    const recoverApprovalSettlement = vi.fn((_input: unknown): { status: string } | undefined => ({ status: 'approved' }))
    let now = 1_000
    const adapter = new LarkDeliveryAdapter({
      account: 'primary-bot', tenant: 'tenant-a', requireMentionInGroups: true,
      maxTextBytes: 65_536, staleAfterMs: 60_000,
    }, transport, {
      now: () => now,
      approvalSecret: 'test-secret-at-least-32-characters-long',
      settleApproval,
      recoverApprovalSettlement,
    })
    await adapter.start({ accept: vi.fn(), receipt: vi.fn() } as unknown as DeliveryAdapterContext)
    const text = 'Review exactly this diff'
    await adapter.send(intent({
      format: 'approval', text,
      approval: { operationId: 'operation-recovery', proposalId: 'proposal-recovery', expectedVersion: 4,
        expiresAt: 2_000, title: 'Approval required', diffHash: sha256(text) },
    }), new AbortController().signal)
    const sent = transport.send.mock.calls.at(-1)![1] as { approval: { approveValue: { approval: string } } }
    const token = sent.approval.approveValue.approval

    now = 2_000
    await transport.emitCardAction({ messageId: 'om_recovery', chatId: 'oc_dm', operatorId: 'ou_owner',
      value: sent.approval.approveValue })
    expect(settleApproval).not.toHaveBeenCalled()
    expect(recoverApprovalSettlement).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'operation-recovery', callbackChatId: 'oc_dm', bindingId: 'binding-1',
      principal: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_owner' },
      proposalId: 'proposal-recovery', expectedVersion: 4, decision: 'approved', diffHash: sha256(text),
    }))

    await transport.emitCardAction({ messageId: 'om_wrong_chat', chatId: 'oc_attacker', operatorId: 'ou_owner',
      value: sent.approval.approveValue })
    await transport.emitCardAction({ messageId: 'om_tampered', chatId: 'oc_dm', operatorId: 'ou_owner',
      value: { approval: `${token[0] === 'A' ? 'B' : 'A'}${token.slice(1)}` } })
    expect(settleApproval).not.toHaveBeenCalled()
    expect(recoverApprovalSettlement).toHaveBeenCalledOnce()

    recoverApprovalSettlement.mockReturnValueOnce(undefined)
    await transport.emitCardAction({ messageId: 'om_not_recoverable', chatId: 'oc_dm', operatorId: 'ou_owner',
      value: sent.approval.approveValue })
    expect(settleApproval).not.toHaveBeenCalled()
    expect(recoverApprovalSettlement).toHaveBeenCalledTimes(2)
    expect(adapter.health()).toMatchObject({ lastErrorCode: 'format_error' })
  })

  test('sends the exact hashed review text only within both approval-card byte budgets', async () => {
    const secret = 'test-secret-at-least-32-characters-long'
    const common = {
      version: 2 as const,
      channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', operationId: 'operation-sized',
      bindingId: 'binding-1', proposalId: 'proposal-sized', expectedVersion: 1,
      expiresAt: 2_000, chatId: 'oc_dm',
    }
    const card = (body: string) => {
      const diffHash = sha256(body)
      return { approval: {
        title: 'Approval required', body,
        approveValue: { approval: signLarkApprovalAction(secret, { ...common, diffHash, decision: 'approved' }) },
        rejectValue: { approval: signLarkApprovalAction(secret, { ...common, diffHash, decision: 'rejected' }) },
      } } as const
    }
    const emptyCardBytes = Buffer.byteLength(renderLarkMessage(card('')).content, 'utf8')
    const boundaryText = 'x'.repeat(LARK_APPROVAL_CARD_MAX_BYTES - emptyCardBytes)
    expect(Buffer.byteLength(renderLarkMessage(card(boundaryText)).content, 'utf8'))
      .toBe(LARK_APPROVAL_CARD_MAX_BYTES)

    const transport = new FakeTransport()
    const adapter = new LarkDeliveryAdapter({
      account: 'primary-bot', tenant: 'tenant-a', requireMentionInGroups: true,
      maxTextBytes: 65_536, staleAfterMs: 60_000,
    }, transport, { now: () => 1_000, approvalSecret: secret, settleApproval: vi.fn() })
    await adapter.start({ accept: vi.fn(), receipt: vi.fn() } as unknown as DeliveryAdapterContext)
    const approval = (text: string): OutboundIntent => intent({
      format: 'approval', text,
      approval: { operationId: common.operationId, proposalId: common.proposalId,
        expectedVersion: common.expectedVersion, expiresAt: common.expiresAt,
        title: 'Approval required', diffHash: sha256(text) },
    })

    await expect(adapter.send(approval(boundaryText), new AbortController().signal))
      .resolves.toMatchObject({ outcome: 'accepted' })
    await expect(adapter.send(approval(`${boundaryText}x`), new AbortController().signal)).resolves.toEqual({
      outcome: 'not-sent', failureCode: 'lark-approval-too-large', retryable: false,
    })
    await expect(adapter.send({ ...approval('different text'), approval: {
      ...approval('different text').approval!, diffHash: sha256('another diff'),
    } }, new AbortController().signal)).resolves.toEqual({
      outcome: 'not-sent', failureCode: 'lark-approval-diff-mismatch', retryable: false,
    })
    expect(transport.send).toHaveBeenCalledOnce()

    const configBoundTransport = new FakeTransport()
    const configBound = new LarkDeliveryAdapter({
      account: 'primary-bot', tenant: 'tenant-a', requireMentionInGroups: true,
      maxTextBytes: 4, staleAfterMs: 60_000,
    }, configBoundTransport, { now: () => 1_000, approvalSecret: secret, settleApproval: vi.fn() })
    await configBound.start({ accept: vi.fn(), receipt: vi.fn() } as unknown as DeliveryAdapterContext)
    await expect(configBound.send(approval('12345'), new AbortController().signal)).resolves.toEqual({
      outcome: 'not-sent', failureCode: 'lark-approval-too-large', retryable: false,
    })
    expect(configBoundTransport.send).not.toHaveBeenCalled()
  })

  test('cascades signed model callbacks without form state and settles the selected effort', async () => {
    const transport = new FakeTransport()
    const settleModelSelection = vi.fn(() => ({ status: 'pending' as const }))
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

    loadModelPicker.mockRejectedValueOnce(new Error('model card message does not match'))
    await expect(transport.emitCardAction({
      messageId: 'om_copied_card', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'select_static', option: 'claude-subscription', value: initialProvider.value,
    })).resolves.toEqual({ toast: { type: 'warning', content: '模型选择已结束，请重新发送 /model' } })
    expect(advanceModelPicker).not.toHaveBeenCalled()

    const providerUpdate = await transport.emitCardAction({
      messageId: 'om_sent', chatId: 'oc_dm', operatorId: 'ou_owner',
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
      messageId: 'om_sent', chatId: 'oc_dm', operatorId: 'ou_owner',
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
      operationId: 'model-picker-1', callbackChatId: 'oc_dm', cardMessageId: 'om_sent', bindingId: 'binding-1',
    }))

    const effortUpdate = await transport.emitCardAction({
      messageId: 'om_sent', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'select_static', option: 'high', value: modelEffort.value,
    }) as { card: { type: string; data: Record<string, unknown> } }
    const effortConfirm = modelPickerElement(effortUpdate.card.data, 'model_confirm')

    const staleUpdate = await transport.emitCardAction({
      messageId: 'om_sent', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'select_static', option: 'codex-subscription', value: initialProvider.value,
    }) as { card: { data: Record<string, unknown> } }
    expect(modelPickerElement(staleUpdate.card.data, 'model_route')).toMatchObject({
      initial_index: 2,
      initial_option: 'Opus',
    })
    expect(modelPickerElement(staleUpdate.card.data, 'model_effort'))
      .toMatchObject({ initial_index: 3, initial_option: 'High' })

    const confirmed = await transport.emitCardAction({
      messageId: 'om_sent', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'button', value: effortConfirm.value,
    })
    expect(confirmed).toEqual({ toast: { type: 'info', content: '模型选择已提交，正在验证' } })
    expect(settleModelSelection).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'model-picker-1', callbackChatId: 'oc_dm', bindingId: 'binding-1',
      cardMessageId: 'om_sent',
      principal: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_owner' },
      provider: 'claude-subscription', modelProvider: 'claude-subscription', model: 'opus', reasoningEffort: 'high',
      expectedRevision: 3,
    }))
    expect(advanceModelPicker).toHaveBeenCalledTimes(4)
    expect(advanceModelPicker).toHaveBeenCalledWith(expect.objectContaining({ cardMessageId: 'om_sent' }))

    const settleCalls = settleModelSelection.mock.calls.length
    settleModelSelection.mockRejectedValueOnce(new Error('model card message does not match'))
    await expect(transport.emitCardAction({
      messageId: 'om_copied_card', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'button', value: effortConfirm.value,
    })).resolves.toEqual({ toast: { type: 'warning', content: '卡片状态已更新，请重新发送 /model' } })
    expect(settleModelSelection).toHaveBeenCalledTimes(settleCalls + 1)
    expect(settleModelSelection).toHaveBeenLastCalledWith(expect.objectContaining({
      cardMessageId: 'om_copied_card',
    }))

    await transport.emitCardAction({
      messageId: '../bad-message', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'button', value: effortConfirm.value,
    })
    expect(settleModelSelection).toHaveBeenCalledTimes(settleCalls + 1)

    advanceModelPicker.mockRejectedValueOnce(new Error('selection already settled'))
    await expect(transport.emitCardAction({
      messageId: 'om_sent', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'select_static', option: 'codex-subscription', value: initialProvider.value,
    })).resolves.toEqual({ toast: { type: 'warning', content: '模型选择已结束，请重新发送 /model' } })

    loadModelPicker.mockImplementationOnce(() => { throw new Error('binding revoked') })
    await expect(transport.emitCardAction({
      messageId: 'om_sent', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'select_static', option: 'codex-subscription', value: initialProvider.value,
    })).resolves.toEqual({ toast: { type: 'warning', content: '模型选择已结束，请重新发送 /model' } })

    await transport.emitCardAction({
      messageId: 'om_sent', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'button', value: {
        ...(effortConfirm.value as Record<string, unknown>), modelPicker: 'tampered-token',
      },
    })
    expect(settleModelSelection).toHaveBeenCalledTimes(settleCalls + 1)
    expect(adapter.health()).toMatchObject({ lastErrorCode: 'format_error' })

    await transport.emitCardAction({
      messageId: 'om_sent', chatId: 'oc_attacker', operatorId: 'ou_owner',
      tag: 'button', value: effortConfirm.value,
    })
    expect(settleModelSelection).toHaveBeenCalledTimes(settleCalls + 1)
  })

  test('keeps a successful submission ACK and falls back to signed route IDs when labels cannot be loaded', async () => {
    const transport = new FakeTransport()
    const settleModelSelection = vi.fn(() => ({ status: 'pending' as const }))
    const loadModelPicker = vi.fn(() => {
      throw new Error('catalog unavailable after settlement')
    })
    const adapter = new LarkDeliveryAdapter({
      account: 'primary-bot', tenant: 'tenant-a', requireMentionInGroups: true,
      maxTextBytes: 65_536, staleAfterMs: 60_000,
    }, transport, {
      now: () => 1_000,
      approvalSecret: 'test-secret-at-least-32-characters-long',
      settleModelSelection,
      loadModelPicker,
      advanceModelPicker: durablePickerAdvance(),
    })
    await adapter.start({ accept: vi.fn(), receipt: vi.fn() } as unknown as DeliveryAdapterContext)
    await adapter.send(intent({ format: 'model-picker', text: '请选择模型', modelPicker }),
      new AbortController().signal)
    const sent = transport.send.mock.calls.at(-1)![1] as {
      modelPicker: import('../src/types.ts').LarkModelPickerCard
    }
    const submitted = await transport.emitCardAction({
      messageId: 'om_sent', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'button', value: sent.modelPicker.callbackValues.confirm,
    })

    expect(submitted).toEqual({ toast: { type: 'info', content: '模型选择已提交，正在验证' } })
    expect(settleModelSelection).toHaveBeenCalledOnce()
    expect(loadModelPicker).toHaveBeenCalledOnce()
  })

  test.each([
    {
      status: 'selected' as const,
      settlement: { status: 'selected' as const, selection: {
        provider: 'claude-subscription', model: 'opus', reasoningEffort: 'high',
      } },
      toast: { type: 'success', content: '模型已切换' },
      template: 'green',
      title: '模型切换成功',
      detail: '已完成验证；下一条消息起生效，并保留当前上下文。',
      displayed: ['Claude', 'Opus', 'High'],
    },
    {
      status: 'rejected' as const,
      settlement: { status: 'rejected' as const, reason: 'model-unavailable' as const },
      toast: { type: 'warning', content: '模型切换未生效' },
      template: 'orange',
      title: '模型切换未生效',
      detail: '所选模型当前不可用，模型未切换。请重新发送 /model。',
      displayed: ['Codex', 'Default', 'Low'],
    },
  ])('actively updates the exact original card to a read-only $status result',
    async ({ settlement, template, title, detail, displayed }) => {
    const transport = new FakeTransport()
    const settleModelSelection = vi.fn(() => ({ status: 'pending' as const }))
    let releaseFinal!: (value: typeof settlement) => void
    const final = new Promise<typeof settlement>(resolve => { releaseFinal = resolve })
    const awaitModelSelection = vi.fn(async () => await final)
    const adapter = new LarkDeliveryAdapter({
      account: 'primary-bot', tenant: 'tenant-a', requireMentionInGroups: true,
      maxTextBytes: 65_536, staleAfterMs: 60_000,
    }, transport, {
      now: () => 1_000,
      approvalSecret: 'test-secret-at-least-32-characters-long',
      settleModelSelection,
      awaitModelSelection,
      loadModelPicker: vi.fn(() => modelPicker),
      advanceModelPicker: durablePickerAdvance(),
    })
    await adapter.start({ accept: vi.fn(), receipt: vi.fn() } as unknown as DeliveryAdapterContext)
    await adapter.send(intent({ format: 'model-picker', text: '请选择模型', modelPicker }),
      new AbortController().signal)
    const sent = transport.send.mock.calls.at(-1)![1] as {
      modelPicker: import('../src/types.ts').LarkModelPickerCard
    }
    const action = {
      messageId: 'om_sent', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'button', value: sent.modelPicker.callbackValues.confirm,
    } as const
    const submitted = await transport.emitCardAction(action)
    expect(submitted).toEqual({ toast: { type: 'info', content: '模型选择已提交，正在验证' } })
    expect(transport.updateRawCard).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(transport.updateRawCard).toHaveBeenCalledOnce())
    const [pendingMessageId, pendingCard] = transport.updateRawCard.mock.calls[0]!
    expect(pendingMessageId).toBe('om_sent')
    expect(pendingCard).toMatchObject({
      header: { template: 'blue', title: { content: '模型选择已提交' } },
    })
    expect(awaitModelSelection).toHaveBeenCalledOnce()
    releaseFinal(settlement)
    await vi.waitFor(() => expect(transport.updateRawCard).toHaveBeenCalledTimes(2))
    const [messageId, result, signal] = transport.updateRawCard.mock.calls[1]!
    expect(messageId).toBe('om_sent')
    expect(signal.aborted).toBe(false)
    expect(result).toMatchObject({
      header: { template, title: { content: title }, subtitle: { content: detail } },
    })
    const tags = modelPickerElements(result).map(element => element.tag)
    expect(tags).not.toContain('select_static')
    expect(tags).not.toContain('button')
    expect(tags).not.toContain('form')
    const serialized = JSON.stringify(result)
    for (const value of displayed) expect(serialized).toContain(value)
    expect(serialized).not.toContain('正在验证')
    expect(serialized).not.toContain('"behaviors"')
    expect(serialized).not.toContain('"value"')
    expect(serialized).not.toContain('"callback"')
    expect(settleModelSelection).toHaveBeenCalledOnce()
    expect(awaitModelSelection).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'model-picker-1', cardMessageId: 'om_sent' }),
      expect.any(AbortSignal),
    )
  })

  test('resolves the pending callback before a synchronously available final result can patch the card', async () => {
    const transport = new FakeTransport()
    const order: string[] = []
    transport.updateRawCard.mockImplementation(async (_messageId, card) => {
      const title = (card.header as { title: { content: string } }).title.content
      order.push(title === '模型选择已提交' ? 'pending-patch' : 'final-patch')
    })
    const awaitModelSelection = vi.fn(async () => {
      order.push('watcher')
      return { status: 'selected' as const, selection: {
        provider: 'codex-subscription', model: 'default', reasoningEffort: 'low',
      } }
    })
    const adapter = new LarkDeliveryAdapter({
      account: 'primary-bot', tenant: 'tenant-a', requireMentionInGroups: true,
      maxTextBytes: 65_536, staleAfterMs: 60_000,
    }, transport, {
      now: () => 1_000,
      approvalSecret: 'test-secret-at-least-32-characters-long',
      settleModelSelection: vi.fn(() => ({ status: 'pending' as const })),
      awaitModelSelection,
      loadModelPicker: vi.fn(() => modelPicker),
      advanceModelPicker: durablePickerAdvance(),
    })
    await adapter.start({ accept: vi.fn(), receipt: vi.fn() } as unknown as DeliveryAdapterContext)
    await adapter.send(intent({ format: 'model-picker', text: '请选择模型', modelPicker }),
      new AbortController().signal)
    const sent = transport.send.mock.calls.at(-1)![1] as {
      modelPicker: import('../src/types.ts').LarkModelPickerCard
    }
    const confirmation = transport.emitCardAction({
      messageId: 'om_sent', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'button', value: sent.modelPicker.callbackValues.confirm,
    }).then(result => { order.push('ack'); return result })

    await expect(confirmation).resolves.toEqual({ toast: { type: 'info', content: '模型选择已提交，正在验证' } })
    expect(order).toEqual(['ack'])
    expect(awaitModelSelection).not.toHaveBeenCalled()
    await new Promise<void>(resolve => setImmediate(resolve))
    await vi.waitFor(() => expect(transport.updateRawCard).toHaveBeenCalledTimes(2))
    expect(order).toEqual(['ack', 'pending-patch', 'watcher', 'final-patch'])
  })

  test.each([
    { status: 'selected' as const, selection: { provider: 'codex-subscription', model: 'default' } },
    { status: 'rejected' as const, reason: 'model-unavailable' as const },
  ])('does not start a background update for a synchronous $status replay', async settlement => {
    const transport = new FakeTransport()
    const awaitModelSelection = vi.fn()
    const adapter = new LarkDeliveryAdapter({
      account: 'primary-bot', tenant: 'tenant-a', requireMentionInGroups: true,
      maxTextBytes: 65_536, staleAfterMs: 60_000,
    }, transport, {
      now: () => 1_000,
      approvalSecret: 'test-secret-at-least-32-characters-long',
      settleModelSelection: vi.fn(() => settlement),
      awaitModelSelection,
      loadModelPicker: vi.fn(() => modelPicker),
      advanceModelPicker: durablePickerAdvance(),
    })
    await adapter.start({ accept: vi.fn(), receipt: vi.fn() } as unknown as DeliveryAdapterContext)
    await adapter.send(intent({ format: 'model-picker', text: '请选择模型', modelPicker }),
      new AbortController().signal)
    const sent = transport.send.mock.calls.at(-1)![1] as {
      modelPicker: import('../src/types.ts').LarkModelPickerCard
    }
    await expect(transport.emitCardAction({
      messageId: 'om_sent', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'button', value: sent.modelPicker.callbackValues.confirm,
    })).resolves.toMatchObject({ card: { type: 'raw' } })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(awaitModelSelection).not.toHaveBeenCalled()
    expect(transport.updateRawCard).not.toHaveBeenCalled()
  })

  test('continues to the final card when the pending card update fails', async () => {
    const transport = new FakeTransport()
    transport.updateRawCard.mockRejectedValueOnce(new LarkTransportError('permission_denied', 'provider detail'))
    const settlement = { status: 'selected' as const, selection: {
      provider: 'codex-subscription', model: 'default', reasoningEffort: 'low',
    } }
    const settleModelSelection = vi.fn(() => ({ status: 'pending' as const }))
    const adapter = new LarkDeliveryAdapter({
      account: 'primary-bot', tenant: 'tenant-a', requireMentionInGroups: true,
      maxTextBytes: 65_536, staleAfterMs: 60_000,
    }, transport, {
      now: () => 1_000,
      approvalSecret: 'test-secret-at-least-32-characters-long',
      settleModelSelection,
      awaitModelSelection: vi.fn(async () => settlement),
      loadModelPicker: vi.fn(() => modelPicker),
      advanceModelPicker: durablePickerAdvance(),
    })
    await adapter.start({ accept: vi.fn(), receipt: vi.fn() } as unknown as DeliveryAdapterContext)
    await adapter.send(intent({ format: 'model-picker', text: '请选择模型', modelPicker }),
      new AbortController().signal)
    const sent = transport.send.mock.calls.at(-1)![1] as {
      modelPicker: import('../src/types.ts').LarkModelPickerCard
    }
    await expect(transport.emitCardAction({
      messageId: 'om_sent', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'button', value: sent.modelPicker.callbackValues.confirm,
    })).resolves.toEqual({ toast: { type: 'info', content: '模型选择已提交，正在验证' } })
    await vi.waitFor(() => expect(transport.updateRawCard).toHaveBeenCalledTimes(2))
    expect(transport.updateRawCard.mock.calls[0]![1]).toMatchObject({
      header: { template: 'blue', title: { content: '模型选择已提交' } },
    })
    expect(transport.updateRawCard.mock.calls[1]![1]).toMatchObject({
      header: { template: 'green', title: { content: '模型切换成功' } },
    })
    await vi.waitFor(() => expect(adapter.health()).toMatchObject({ lastErrorCode: 'permission_denied' }))
    expect(settleModelSelection).toHaveBeenCalledOnce()
  })

  test('cancels a pending final card update on adapter stop', async () => {
    const transport = new FakeTransport()
    let waiterSignal: AbortSignal | undefined
    let releaseFinal!: () => void
    const final = new Promise<{ status: 'selected'; selection: { provider: string; model: string } }>(resolve => {
      releaseFinal = () => resolve({ status: 'selected', selection: { provider: 'codex-subscription', model: 'default' } })
    })
    const adapter = new LarkDeliveryAdapter({
      account: 'primary-bot', tenant: 'tenant-a', requireMentionInGroups: true,
      maxTextBytes: 65_536, staleAfterMs: 60_000,
    }, transport, {
      now: () => 1_000,
      approvalSecret: 'test-secret-at-least-32-characters-long',
      settleModelSelection: vi.fn(() => ({ status: 'pending' as const })),
      awaitModelSelection: vi.fn(async (_input, signal) => { waiterSignal = signal; return await final }),
      loadModelPicker: vi.fn(() => modelPicker),
      advanceModelPicker: durablePickerAdvance(),
    })
    const dispose = await adapter.start({ accept: vi.fn(), receipt: vi.fn() } as unknown as DeliveryAdapterContext)
    await adapter.send(intent({ format: 'model-picker', text: '请选择模型', modelPicker }),
      new AbortController().signal)
    const sent = transport.send.mock.calls.at(-1)![1] as {
      modelPicker: import('../src/types.ts').LarkModelPickerCard
    }
    await transport.emitCardAction({ messageId: 'om_sent', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'button', value: sent.modelPicker.callbackValues.confirm })
    await vi.waitFor(() => expect(waiterSignal).toBeDefined())
    await dispose?.()
    expect(waiterSignal?.aborted).toBe(true)
    releaseFinal()
    await Promise.resolve()
    await Promise.resolve()
    expect(transport.updateRawCard).toHaveBeenCalledOnce()
    expect(transport.updateRawCard.mock.calls[0]![1]).toMatchObject({
      header: { template: 'blue', title: { content: '模型选择已提交' } },
    })
  })

  test('keeps a real __default__ effort distinct from the UI default choice', async () => {
    const transport = new FakeTransport()
    const settleModelSelection = vi.fn(() => ({ status: 'selected' as const, selection: {
      provider: 'custom', model: 'model', reasoningEffort: '__default__',
    } }))
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
      messageId: 'om_sent', chatId: 'oc_dm', operatorId: 'ou_owner',
      tag: 'select_static', option: literal.value, value: effort.value,
    }) as { card: { data: Record<string, unknown> } }
    await transport.emitCardAction({
      messageId: 'om_sent', chatId: 'oc_dm', operatorId: 'ou_owner', tag: 'button',
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

  test('sends signed permission choices and settles each exact owner button with all bound state', async () => {
    const transport = new FakeTransport()
    const settlePermissionSelection = vi.fn(() => ({ status: 'queued' as const }))
    const adapter = new LarkDeliveryAdapter({
      account: 'primary-bot', tenant: 'tenant-a', requireMentionInGroups: true,
      maxTextBytes: 65_536, staleAfterMs: 60_000,
    }, transport, {
      now: () => 1_100,
      approvalSecret: 'test-secret-at-least-32-characters-long',
      settlePermissionSelection,
    })
    await adapter.start({ accept: vi.fn(), receipt: vi.fn() } as unknown as DeliveryAdapterContext)

    expect(adapter.capabilities.formats).toContain('permission-picker')
    await expect(adapter.send(intent({
      format: 'permission-picker', text: '请选择权限模式', permissionPicker,
    }), new AbortController().signal)).resolves.toEqual({
      outcome: 'accepted', providerMessageId: 'om_sent',
    })
    const sent = transport.send.mock.calls.at(-1)![1] as {
      permissionPicker: import('../src/types.ts').LarkPermissionPickerCard
    }
    expect(sent.permissionPicker).toMatchObject({
      title: '选择权限模式', body: '当前：完全访问权限（full）。请选择新档位。', current: 'full',
    })
    const callbacks = sent.permissionPicker.callbackValues
    expect(Object.keys(callbacks).sort()).toEqual(['ask', 'auto', 'full'])
    expect(new Set(Object.values(callbacks).map(value => value.permissionPicker)).size).toBe(3)
    expect(Object.values(callbacks).every(value => value.permissionPicker.length > 64)).toBe(true)

    for (const targetLevel of ['ask', 'auto', 'full'] as const) {
      await expect(transport.emitCardAction({
        messageId: 'om_sent', chatId: 'oc_dm', operatorId: 'ou_owner',
        tag: 'button', value: callbacks[targetLevel],
      })).resolves.toEqual({ toast: { type: 'success', content: '权限切换已受理' } })
    }
    expect(settlePermissionSelection).toHaveBeenCalledTimes(3)
    for (const [index, targetLevel] of (['ask', 'auto', 'full'] as const).entries()) {
      const token = callbacks[targetLevel].permissionPicker
      expect(settlePermissionSelection).toHaveBeenNthCalledWith(index + 1, {
        operationId: 'permission-picker-1',
        callbackEventId: sha256(`om_sent\0ou_owner\0${token}`),
        callbackChatId: 'oc_dm',
        cardMessageId: 'om_sent',
        bindingId: 'binding-1',
        bindingVersion: 7,
        sessionId: 'session-1',
        principal: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_owner' },
        issuedAt: 1_000,
        expiresAt: 2_000,
        expectedStateHash: 'a'.repeat(64),
        emergencyStopVersion: 0,
        targetLevel,
      })
    }
  })

  test('rejects wrong permission-card owner, chat, button, message id, tampering, and expiry with a visible warning', async () => {
    const transport = new FakeTransport()
    const settlePermissionSelection = vi.fn()
    let now = 1_100
    const adapter = new LarkDeliveryAdapter({
      account: 'primary-bot', tenant: 'tenant-a', requireMentionInGroups: true,
      maxTextBytes: 65_536, staleAfterMs: 60_000,
    }, transport, {
      now: () => now,
      approvalSecret: 'test-secret-at-least-32-characters-long',
      settlePermissionSelection,
    })
    await adapter.start({ accept: vi.fn(), receipt: vi.fn() } as unknown as DeliveryAdapterContext)
    await adapter.send(intent({
      format: 'permission-picker', text: '请选择权限模式', permissionPicker,
    }), new AbortController().signal)
    const sent = transport.send.mock.calls.at(-1)![1] as {
      permissionPicker: import('../src/types.ts').LarkPermissionPickerCard
    }
    const valid = sent.permissionPicker.callbackValues.full
    const invalidActions: LarkCardAction[] = [
      { messageId: 'om_permission_card', chatId: 'oc_dm', operatorId: 'ou_attacker', tag: 'button', value: valid },
      { messageId: 'om_permission_card', chatId: 'oc_attacker', operatorId: 'ou_owner', tag: 'button', value: valid },
      { messageId: 'om_permission_card', chatId: 'oc_dm', operatorId: 'ou_owner', tag: 'select_static', value: valid },
      { messageId: '../bad-message', chatId: 'oc_dm', operatorId: 'ou_owner', tag: 'button', value: valid },
      { messageId: 'om_permission_card', chatId: 'oc_dm', operatorId: 'ou_owner', tag: 'button',
        value: { permissionPicker: `${valid.permissionPicker.slice(0, -1)}x` } },
    ]
    for (const action of invalidActions) {
      await expect(transport.emitCardAction(action)).resolves.toEqual({
        toast: { type: 'warning', content: '权限卡片无效或已失效，请重新发送 /permission' },
      })
    }
    now = permissionPicker.expiresAt
    await expect(transport.emitCardAction({
      messageId: 'om_permission_card', chatId: 'oc_dm', operatorId: 'ou_owner', tag: 'button', value: valid,
    })).resolves.toEqual({
      toast: { type: 'warning', content: '权限卡片已过期，请重新发送 /permission' },
    })
    expect(settlePermissionSelection).not.toHaveBeenCalled()
    expect(adapter.health()).toMatchObject({ lastErrorCode: 'format_error' })
  })

  test('shows a warning when permission selection settlement is stale', async () => {
    const transport = new FakeTransport()
    const settlePermissionSelection = vi.fn(() => { throw new Error('stale permission fingerprint') })
    const adapter = new LarkDeliveryAdapter({
      account: 'primary-bot', tenant: 'tenant-a', requireMentionInGroups: true,
      maxTextBytes: 65_536, staleAfterMs: 60_000,
    }, transport, {
      now: () => 1_100,
      approvalSecret: 'test-secret-at-least-32-characters-long',
      settlePermissionSelection,
    })
    await adapter.start({ accept: vi.fn(), receipt: vi.fn() } as unknown as DeliveryAdapterContext)
    await adapter.send(intent({
      format: 'permission-picker', text: '请选择权限模式', permissionPicker,
    }), new AbortController().signal)
    const sent = transport.send.mock.calls.at(-1)![1] as {
      permissionPicker: import('../src/types.ts').LarkPermissionPickerCard
    }

    await expect(transport.emitCardAction({
      messageId: 'om_permission_card', chatId: 'oc_dm', operatorId: 'ou_owner', tag: 'button',
      value: sent.permissionPicker.callbackValues.auto,
    })).resolves.toEqual({
      toast: { type: 'warning', content: '权限卡片状态已更新，请重新发送 /permission' },
    })
    expect(adapter.health()).toMatchObject({ lastErrorCode: 'unknown' })
  })

  test('falls back to the exact permission text when Lark rejects the permission-picker card format', async () => {
    const transport = new FakeTransport()
    transport.send.mockRejectedValueOnce(new LarkTransportError('format_error', 'invalid card'))
    const adapter = new LarkDeliveryAdapter({
      account: 'primary-bot', tenant: 'tenant-a', requireMentionInGroups: true,
      maxTextBytes: 65_536, staleAfterMs: 60_000,
    }, transport, {
      now: () => 1_100,
      approvalSecret: 'test-secret-at-least-32-characters-long',
      settlePermissionSelection: vi.fn(),
    })
    await adapter.start({ accept: vi.fn(), receipt: vi.fn() } as unknown as DeliveryAdapterContext)

    await expect(adapter.send(intent({
      format: 'permission-picker', text: '完整的三档权限文字说明', permissionPicker,
    }), new AbortController().signal)).resolves.toEqual({
      outcome: 'accepted', providerMessageId: 'om_sent',
    })
    expect(transport.send).toHaveBeenCalledTimes(2)
    expect(transport.send.mock.calls[1]?.[1]).toEqual({ text: '完整的三档权限文字说明' })
    expect(transport.send.mock.calls[1]?.[2]).toEqual({
      replyTo: 'om_in', requestKey: 'reply-1:permission-picker-fallback',
    })
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
