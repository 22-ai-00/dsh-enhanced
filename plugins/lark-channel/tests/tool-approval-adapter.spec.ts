import { describe, expect, test, vi } from 'vitest'
import type {
  DeliveryAdapterContext,
  DeliveryToolApprovalRequest,
  InboundEnvelope,
} from '@dsh-enhanced/assistant-delivery'
import { LarkDeliveryAdapter } from '../src/adapter.ts'
import { renderLarkMessage } from '../src/sdk.ts'
import {
  signLarkToolApprovalAction,
  verifyLarkToolApprovalAction,
} from '../src/tool-approval.ts'
import { LarkTransportError } from '../src/types.ts'
import type {
  LarkCardAction,
  LarkSendInput,
  LarkSendOptions,
  LarkTransport,
  LarkTransportHandlers,
} from '../src/types.ts'

const secret = 'test-secret-at-least-32-characters-long'
const actionHash = 'a'.repeat(64)

class FakeTransport implements LarkTransport {
  handlers: LarkTransportHandlers | undefined
  readonly connect = vi.fn(async () => {})
  readonly disconnect = vi.fn(async () => {})
  readonly send = vi.fn(async (_chatId: string, _input: LarkSendInput, _options?: LarkSendOptions) => ({
    messageId: 'om_tool_card',
  }))
  readonly addReaction = vi.fn(async (_messageId: string, _emojiType: string) => 'reaction-1')
  readonly createProgress = vi.fn(async (_chatId: string, _options: { replyTo: string; hidden: boolean }) => ({
    cotId: 'cot-1', messageId: 'om_cot',
  }))
  readonly writeProgress = vi.fn(async () => {})

  subscribe(handlers: LarkTransportHandlers): () => void {
    this.handlers = handlers
    return () => { if (this.handlers === handlers) this.handlers = undefined }
  }

  async emitCardAction(action: LarkCardAction): Promise<unknown> {
    return await this.handlers?.cardAction(action)
  }
}

function request(overrides: Partial<DeliveryToolApprovalRequest> = {}): DeliveryToolApprovalRequest {
  return {
    operationId: 'tool-approval-1',
    bindingId: 'binding-1',
    target: {
      principal: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_owner' },
      conversation: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', kind: 'dm', chat: 'oc_dm' },
    },
    expiresAt: 2_000,
    actionHash,
    toolName: 'exec_command',
    callId: 'call-1',
    reason: '需要读取工作区状态',
    arguments: '{"cmd":"git status --short"}',
    ...overrides,
  }
}

async function fixture(options: { now?: () => number; approvalSecret?: string } = {}) {
  const transport = new FakeTransport()
  const adapter = new LarkDeliveryAdapter({
    account: 'primary-bot', tenant: 'tenant-a', requireMentionInGroups: true,
    maxTextBytes: 65_536, staleAfterMs: 60_000,
  }, transport, {
    now: options.now ?? (() => 1_000),
    ...(options.approvalSecret === undefined ? {} : { approvalSecret: options.approvalSecret }),
  })
  const context: DeliveryAdapterContext = {
    accept: vi.fn(async (_envelope: InboundEnvelope) => ({
      duplicate: false, inboxId: 'inbox-1', status: 'queued' as const,
    })),
    receipt: vi.fn(async () => {}),
  }
  const dispose = await adapter.start(context)
  return { adapter, dispose, transport }
}

function sentToolCard(transport: FakeTransport) {
  return transport.send.mock.calls.at(-1)![1] as Extract<LarkSendInput, { toolApproval: unknown }>
}

describe('Lark open-turn tool approval adapter', () => {
  test('advertises the capability only with a usable signing secret', async () => {
    const without = await fixture()
    expect(without.adapter.capabilities.toolApprovals).toBe(false)
    await without.dispose?.()

    const weak = await fixture({ approvalSecret: 'short' })
    expect(weak.adapter.capabilities.toolApprovals).toBe(false)
    await weak.dispose?.()

    const enabled = await fixture({ approvalSecret: secret })
    expect(enabled.adapter.capabilities.toolApprovals).toBe(true)
    await enabled.dispose?.()
  })

  test('sends a non-forwardable signed review card and resolves the exact owner decision once', async () => {
    const f = await fixture({ approvalSecret: secret })
    const pending = f.adapter.requestToolApproval(request(), new AbortController().signal)
    await vi.waitFor(() => expect(f.transport.send).toHaveBeenCalledOnce())

    expect(f.transport.send).toHaveBeenCalledWith('oc_dm', expect.objectContaining({
      toolApproval: expect.any(Object),
    }), {
      requestKey: `tool-approval:tool-approval-1:${actionHash}`,
    })
    const sent = sentToolCard(f.transport)
    const card = JSON.parse(renderLarkMessage(sent).content) as Record<string, unknown>
    expect(card).toMatchObject({ config: { enable_forward_interaction: false } })
    const serialized = JSON.stringify(card)
    expect(serialized).toContain('不可信审阅文本')
    expect(serialized).toContain('exec_command')
    expect(serialized).toContain('需要读取工作区状态')
    expect(serialized).toContain('git status --short')

    const allowToken = sent.toolApproval.allowValue.toolApproval
    const rejectToken = sent.toolApproval.rejectValue.toolApproval
    expect(allowToken).not.toBe(rejectToken)
    expect(verifyLarkToolApprovalAction(secret, allowToken, 1_000)).toEqual({
      version: 1,
      channel: 'lark',
      account: 'primary-bot',
      tenant: 'tenant-a',
      operationId: 'tool-approval-1',
      bindingId: 'binding-1',
      chatId: 'oc_dm',
      ownerUser: 'ou_owner',
      actionHash,
      toolName: 'exec_command',
      callId: 'call-1',
      expiresAt: 2_000,
      decision: 'allowed-once',
    })

    await f.transport.emitCardAction({
      messageId: 'om_tool_card', chatId: 'oc_dm', operatorId: 'ou_owner', tag: 'button',
      value: sent.toolApproval.allowValue,
    })
    await expect(pending).resolves.toBe('allowed-once')

    await f.transport.emitCardAction({
      messageId: 'om_tool_card', chatId: 'oc_dm', operatorId: 'ou_owner', tag: 'button',
      value: sent.toolApproval.rejectValue,
    })
    expect(f.adapter.health()).toMatchObject({ lastErrorCode: 'format_error' })
    await f.dispose?.()
  })

  test('keeps a pending request open across wrong chat, operator, message, tag, and action hash callbacks', async () => {
    const f = await fixture({ approvalSecret: secret })
    const pending = f.adapter.requestToolApproval(request(), new AbortController().signal)
    await vi.waitFor(() => expect(f.transport.send).toHaveBeenCalledOnce())
    const sent = sentToolCard(f.transport)
    const token = sent.toolApproval.allowValue.toolApproval
    const wrongHash = signLarkToolApprovalAction(secret, {
      ...verifyLarkToolApprovalAction(secret, token, 1_000),
      actionHash: 'b'.repeat(64),
    })
    const invalidActions: LarkCardAction[] = [
      { messageId: 'om_tool_card', chatId: 'oc_other', operatorId: 'ou_owner', tag: 'button',
        value: sent.toolApproval.allowValue },
      { messageId: 'om_tool_card', chatId: 'oc_dm', operatorId: 'ou_other', tag: 'button',
        value: sent.toolApproval.allowValue },
      { messageId: 'om_other', chatId: 'oc_dm', operatorId: 'ou_owner', tag: 'button',
        value: sent.toolApproval.allowValue },
      { messageId: 'om_tool_card', chatId: 'oc_dm', operatorId: 'ou_owner', tag: 'select_static',
        value: sent.toolApproval.allowValue },
      { messageId: 'om_tool_card', chatId: 'oc_dm', operatorId: 'ou_owner', tag: 'button',
        value: { toolApproval: wrongHash } },
    ]
    let settled = false
    void pending.then(() => { settled = true })
    for (const action of invalidActions) await f.transport.emitCardAction(action)
    await Promise.resolve()
    expect(settled).toBe(false)

    await f.transport.emitCardAction({
      messageId: 'om_tool_card', chatId: 'oc_dm', operatorId: 'ou_owner', tag: 'button',
      value: sent.toolApproval.rejectValue,
    })
    await expect(pending).resolves.toBe('rejected')
    await f.dispose?.()
  })

  test('binds an authenticated callback that arrives before the send promise exposes its message id', async () => {
    const f = await fixture({ approvalSecret: secret })
    let acceptSend!: (result: { messageId: string }) => void
    f.transport.send.mockImplementationOnce(async () => await new Promise(resolve => { acceptSend = resolve }))
    const controller = new AbortController()
    const pending = f.adapter.requestToolApproval(request({ operationId: 'early-callback' }), controller.signal)
    await vi.waitFor(() => expect(f.transport.send).toHaveBeenCalledOnce())
    const sent = sentToolCard(f.transport)
    await expect(f.transport.emitCardAction({
      messageId: 'x'.repeat(257), chatId: 'oc_dm', operatorId: 'ou_owner', tag: 'button',
      value: sent.toolApproval.allowValue,
    })).resolves.toBeUndefined()
    expect(f.adapter.health()).toMatchObject({ lastErrorCode: 'format_error' })
    await f.transport.emitCardAction({
      messageId: 'om_tool_card', chatId: 'oc_dm', operatorId: 'ou_owner', tag: 'button',
      value: sent.toolApproval.allowValue,
    })
    acceptSend({ messageId: 'om_tool_card' })
    const observed = await Promise.race([
      pending,
      new Promise<'still-pending'>(resolve => setTimeout(() => resolve('still-pending'), 25)),
    ])
    try {
      expect(observed).toBe('allowed-once')
    } finally {
      controller.abort()
      await f.dispose?.()
    }
  })

  test('rejects mismatched or unbounded requests before sending provider-controlled review text', async () => {
    const f = await fixture({ approvalSecret: secret })
    const invalid = [
      request({ actionHash: 'invalid' }),
      request({ toolName: 'x'.repeat(513) }),
      request({ reason: 'x'.repeat(2_049) }),
      request({ arguments: 'x'.repeat(16_385) }),
      request({ expiresAt: 1_000 }),
      request({ target: {
        principal: { channel: 'lark', account: 'other', tenant: 'tenant-a', user: 'ou_owner' },
        conversation: { channel: 'lark', account: 'other', tenant: 'tenant-a', kind: 'dm', chat: 'oc_dm' },
      } }),
      request({ target: {
        principal: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou\nsecret' },
        conversation: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', kind: 'dm', chat: 'oc_dm' },
      } }),
      request({ target: {
        principal: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_owner' },
        conversation: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', kind: 'dm', chat: '../escape' },
      } }),
    ]
    for (const value of invalid) {
      await expect(f.adapter.requestToolApproval(value, new AbortController().signal)).resolves.toBe('unavailable')
    }
    expect(f.transport.send).not.toHaveBeenCalled()
    await f.dispose?.()
  })

  test('fails closed on missing required fields and bidi controls in review text', async () => {
    const f = await fixture({ approvalSecret: secret })
    const invalid = [
      { ...request({ operationId: 'missing-call-id' }), callId: undefined },
      { ...request({ operationId: 'missing-arguments' }), arguments: undefined },
      request({ operationId: 'bidi-reason', reason: 'safe\u202Etxt.exe' }),
      request({ operationId: 'bidi-arguments', arguments: '{"cmd":"safe\u202Etxt.exe"}' }),
    ] as unknown as DeliveryToolApprovalRequest[]
    for (const value of invalid) {
      const controller = new AbortController()
      const observed = await Promise.race([
        f.adapter.requestToolApproval(value, controller.signal),
        new Promise<'still-pending'>(resolve => setTimeout(() => resolve('still-pending'), 25)),
      ])
      controller.abort()
      expect(observed).toBe('unavailable')
    }
    expect(f.transport.send).not.toHaveBeenCalled()
    await f.dispose?.()
  })

  test('refuses group and thread targets so exact tool arguments are visible only in the owner DM', async () => {
    const f = await fixture({ approvalSecret: secret })
    const invalidTargets = [
      request({ target: {
        principal: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_owner' },
        conversation: {
          channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', kind: 'group',
          chat: 'oc_group', thread: 'om_thread',
        },
      } }),
      request({ operationId: 'dm-thread', target: {
        principal: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_owner' },
        conversation: {
          channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', kind: 'dm',
          chat: 'oc_dm', thread: 'om_untrusted_route',
        },
      } }),
    ]
    for (const invalid of invalidTargets) {
      const controller = new AbortController()
      const observed = await Promise.race([
        f.adapter.requestToolApproval(invalid, controller.signal),
        new Promise<'still-pending'>(resolve => setTimeout(() => resolve('still-pending'), 25)),
      ])
      controller.abort()
      expect(observed).toBe('unavailable')
    }
    expect(f.transport.send).not.toHaveBeenCalled()
    await f.dispose?.()
  })

  test('accepts the Delivery review-text bounds when the rendered card remains within its byte budget', async () => {
    const f = await fixture({ approvalSecret: secret })
    const controller = new AbortController()
    const pending = f.adapter.requestToolApproval(request({
      operationId: 'delivery-review-bounds',
      toolName: 't'.repeat(512),
      callId: 'c'.repeat(512),
      reason: 'r'.repeat(2_048),
      arguments: 'a'.repeat(16_384),
    }), controller.signal)
    await vi.waitFor(() => expect(f.transport.send).toHaveBeenCalledOnce())
    controller.abort()
    await expect(pending).resolves.toBe('cancelled')
    await f.dispose?.()
  })

  test('does not send a stale card when the request expires while its timer is being armed', async () => {
    let reads = 0
    const f = await fixture({
      approvalSecret: secret,
      now: () => reads++ === 0 ? 1_000 : 2_000,
    })
    await expect(f.adapter.requestToolApproval(request(), new AbortController().signal))
      .resolves.toBe('unavailable')
    expect(f.transport.send).not.toHaveBeenCalled()
    await f.dispose?.()
  })

  test('settles abort, expiry, reconnect, disposal, and send failure without leaving a usable callback', async () => {
    vi.useFakeTimers()
    try {
      let now = 1_000
      const f = await fixture({ approvalSecret: secret, now: () => now })

      const preAborted = new AbortController()
      preAborted.abort(new Error('provider secret abort reason'))
      await expect(f.adapter.requestToolApproval(request({ operationId: 'pre-abort' }), preAborted.signal))
        .resolves.toBe('cancelled')
      expect(f.transport.send).not.toHaveBeenCalled()

      const expiry = f.adapter.requestToolApproval(request({ operationId: 'expiry', expiresAt: 1_010 }),
        new AbortController().signal)
      now = 1_010
      await vi.advanceTimersByTimeAsync(10)
      await expect(expiry).resolves.toBe('unavailable')

      f.transport.send.mockRejectedValueOnce(new Error('provider payload must not leak'))
      await expect(f.adapter.requestToolApproval(request({ operationId: 'send-failed' }),
        new AbortController().signal)).resolves.toBe('unavailable')

      const abortController = new AbortController()
      const aborted = f.adapter.requestToolApproval(request({ operationId: 'abort-in-flight' }), abortController.signal)
      await vi.waitFor(() => expect(f.transport.send).toHaveBeenCalled())
      abortController.abort(new Error('provider secret abort reason'))
      await expect(aborted).resolves.toBe('cancelled')

      const reconnecting = f.adapter.requestToolApproval(request({ operationId: 'reconnecting' }),
        new AbortController().signal)
      f.transport.handlers?.reconnecting()
      await expect(reconnecting).resolves.toBe('unavailable')
      f.transport.handlers?.reconnected()
      const sendsAfterReconnect = f.transport.send.mock.calls.length
      await expect(f.adapter.requestToolApproval(request({ operationId: 'reconnecting' }),
        new AbortController().signal)).resolves.toBe('unavailable')
      expect(f.transport.send).toHaveBeenCalledTimes(sendsAfterReconnect)

      const disconnected = f.adapter.requestToolApproval(request({ operationId: 'disconnected' }),
        new AbortController().signal)
      f.transport.handlers?.error(new LarkTransportError('not_connected', 'provider detail must not leak'))
      await expect(disconnected).resolves.toBe('unavailable')
      const sendsAfterDisconnect = f.transport.send.mock.calls.length
      await expect(f.adapter.requestToolApproval(request({ operationId: 'after-disconnect' }),
        new AbortController().signal)).resolves.toBe('unavailable')
      expect(f.transport.send).toHaveBeenCalledTimes(sendsAfterDisconnect)

      const disposed = f.adapter.requestToolApproval(request({ operationId: 'disposed' }),
        new AbortController().signal)
      await f.dispose?.()
      await expect(disposed).resolves.toBe('unavailable')
    } finally {
      vi.useRealTimers()
    }
  })

  test('allows only one pending request per operation and fails closed on an invalid provider message id', async () => {
    const f = await fixture({ approvalSecret: secret })
    const controller = new AbortController()
    const first = f.adapter.requestToolApproval(request(), controller.signal)
    await vi.waitFor(() => expect(f.transport.send).toHaveBeenCalledOnce())
    await expect(f.adapter.requestToolApproval(request(), new AbortController().signal)).resolves.toBe('unavailable')
    expect(f.transport.send).toHaveBeenCalledOnce()
    controller.abort()
    await expect(first).resolves.toBe('cancelled')

    f.transport.send.mockResolvedValueOnce({ messageId: '../invalid' })
    await expect(f.adapter.requestToolApproval(request({ operationId: 'bad-provider-id' }),
      new AbortController().signal)).resolves.toBe('unavailable')
    await f.dispose?.()
  })

  test('tombstones a settled operation until expiry so an old card cannot approve a replacement', async () => {
    vi.useFakeTimers()
    try {
      let now = 1_000
      const f = await fixture({ approvalSecret: secret, now: () => now })
      const first = f.adapter.requestToolApproval(request({ expiresAt: 1_010 }), new AbortController().signal)
      await vi.waitFor(() => expect(f.transport.send).toHaveBeenCalledOnce())
      const oldCard = sentToolCard(f.transport)
      await f.transport.emitCardAction({
        messageId: 'om_tool_card', chatId: 'oc_dm', operatorId: 'ou_owner', tag: 'button',
        value: oldCard.toolApproval.rejectValue,
      })
      await expect(first).resolves.toBe('rejected')

      await expect(f.adapter.requestToolApproval(request({ expiresAt: 1_010 }), new AbortController().signal))
        .resolves.toBe('unavailable')
      expect(f.transport.send).toHaveBeenCalledOnce()

      now = 1_010
      await vi.advanceTimersByTimeAsync(10)
      const nextHash = 'b'.repeat(64)
      const replacement = f.adapter.requestToolApproval(request({ expiresAt: 2_000, actionHash: nextHash }),
        new AbortController().signal)
      await vi.waitFor(() => expect(f.transport.send).toHaveBeenCalledTimes(2))
      const newCard = sentToolCard(f.transport)
      await f.transport.emitCardAction({
        messageId: 'om_tool_card', chatId: 'oc_dm', operatorId: 'ou_owner', tag: 'button',
        value: oldCard.toolApproval.allowValue,
      })
      await Promise.resolve()
      await f.transport.emitCardAction({
        messageId: 'om_tool_card', chatId: 'oc_dm', operatorId: 'ou_owner', tag: 'button',
        value: newCard.toolApproval.rejectValue,
      })
      await expect(replacement).resolves.toBe('rejected')
      await f.dispose?.()
    } finally {
      vi.useRealTimers()
    }
  })

  test('settles an expired pending request before reusing its operation when the timer callback is late', async () => {
    vi.useFakeTimers()
    try {
      let now = 1_000
      const f = await fixture({ approvalSecret: secret, now: () => now })
      let firstOutcome: string | undefined
      const first = f.adapter.requestToolApproval(request({ expiresAt: 1_010 }),
        new AbortController().signal)
      void first.then(outcome => { firstOutcome = outcome })
      await vi.waitFor(() => expect(f.transport.send).toHaveBeenCalledOnce())

      now = 1_010
      const replacementController = new AbortController()
      const replacement = f.adapter.requestToolApproval(request({ expiresAt: 2_000, actionHash: 'b'.repeat(64) }),
        replacementController.signal)
      await vi.waitFor(() => expect(f.transport.send).toHaveBeenCalledTimes(2))
      await Promise.resolve()
      expect(firstOutcome).toBe('unavailable')

      replacementController.abort()
      await expect(replacement).resolves.toBe('cancelled')
      await f.dispose?.()
    } finally {
      vi.useRealTimers()
    }
  })
})
