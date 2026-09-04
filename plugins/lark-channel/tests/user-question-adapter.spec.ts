import { describe, expect, test, vi } from 'vitest'
import type {
  DeliveryAdapterContext,
  DeliveryUserQuestionRequest,
  InboundEnvelope,
} from '@dsh-enhanced/assistant-delivery'
import { LarkDeliveryAdapter } from '../src/adapter.ts'
import { larkTopLevelSenderThread } from '../src/group-thread.ts'
import { renderLarkMessage } from '../src/sdk.ts'
import { verifyLarkUserQuestionAction } from '../src/user-question.ts'
import type {
  LarkCardAction,
  LarkMessage,
  LarkSendInput,
  LarkSendOptions,
  LarkTransport,
  LarkTransportHandlers,
} from '../src/types.ts'

const secret = 'test-secret-at-least-32-characters-long'

class FakeTransport implements LarkTransport {
  handlers: LarkTransportHandlers | undefined
  private messageSequence = 0
  readonly connect = vi.fn(async () => {})
  readonly disconnect = vi.fn(async () => {})
  readonly send = vi.fn(async (_chatId: string, _input: LarkSendInput, _options?: LarkSendOptions) => ({
    messageId: `om_question_${++this.messageSequence}`,
  }))
  readonly updateRawCard = vi.fn(async (
    _messageId: string,
    _card: Readonly<Record<string, unknown>>,
    _signal: AbortSignal,
  ) => {})
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

  async emitMessage(message: Partial<LarkMessage> = {}): Promise<void> {
    await this.handlers?.message({
      messageId: 'om_answer_1',
      chatId: 'oc_dm',
      chatType: 'p2p',
      senderId: 'ou_owner',
      content: '自定义回答',
      rawContentType: 'text',
      resources: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: 1_001,
      ...message,
    })
  }
}

function request(overrides: Partial<DeliveryUserQuestionRequest> = {}): DeliveryUserQuestionRequest {
  return {
    operationId: 'question-rpc-1',
    bindingId: 'binding-1',
    bindingVersion: 1,
    bindingGeneration: 1,
    sessionId: 'session-1',
    target: {
      principal: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_owner' },
      conversation: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', kind: 'dm', chat: 'oc_dm' },
    },
    questions: [{
      id: 'strategy',
      header: '复制策略',
      question: '你希望怎样复制历史和记忆？',
      options: [
        { label: '只复制文档', description: '复制可维护的知识文档' },
        { label: '完整复制 (Recommended)', description: '复制历史、记忆与知识文档' },
      ],
    }],
    ...overrides,
  }
}

async function fixture(options: { approvalSecret?: string; userQuestionTtlMs?: number } = {}) {
  const transport = new FakeTransport()
  const adapter = new LarkDeliveryAdapter({
    account: 'primary-bot', tenant: 'tenant-a', requireMentionInGroups: true,
    maxTextBytes: 65_536, staleAfterMs: 60_000,
  }, transport, {
    now: () => 1_000,
    ...(options.approvalSecret === undefined ? {} : { approvalSecret: options.approvalSecret }),
    userQuestionTtlMs: options.userQuestionTtlMs ?? 60_000,
  })
  const context: DeliveryAdapterContext = {
    accept: vi.fn(async (_envelope: InboundEnvelope) => ({
      duplicate: false, inboxId: 'inbox-1', status: 'queued' as const,
    })),
    receipt: vi.fn(async () => {}),
  }
  const dispose = await adapter.start(context)
  return { adapter, context, dispose, transport }
}

function sentQuestionCard(transport: FakeTransport) {
  return transport.send.mock.calls.at(-1)![1] as Extract<LarkSendInput, { userQuestion: unknown }>
}

function allObjects(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(allObjects)
  if (value === null || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  return [record, ...Object.values(record).flatMap(allObjects)]
}

function callbackValue(card: unknown, name: string): { userQuestion: string } {
  const control = allObjects(card).find(value => value.name === name)
  if (control === undefined) throw new Error(`missing callback control ${name}`)
  return control.value as { userQuestion: string }
}

describe('Lark ask_user_question adapter', () => {
  test('advertises the capability only with a signing secret', async () => {
    const disabled = await fixture()
    expect(disabled.adapter.capabilities.userQuestions).toBe(false)
    await disabled.dispose?.()

    const enabled = await fixture({ approvalSecret: secret })
    expect(enabled.adapter.capabilities.userQuestions).toBe(true)
    await enabled.dispose?.()
  })

  test('renders recommended options as signed buttons and resumes the exact request once', async () => {
    const f = await fixture({ approvalSecret: secret })
    const pending = f.adapter.requestUserQuestion(request(), new AbortController().signal)
    await vi.waitFor(() => expect(f.transport.send).toHaveBeenCalledOnce())
    const sent = sentQuestionCard(f.transport)
    expect(sent.userQuestion.options).toMatchObject([
      { label: '只复制文档', recommended: false },
      { label: '完整复制', recommended: true },
    ])
    const rendered = JSON.parse(renderLarkMessage(sent).content) as Record<string, unknown>
    expect(rendered).toMatchObject({
      schema: '2.0',
      config: { enable_forward_interaction: false },
    })
    const token = sent.userQuestion.options[1]!.value.userQuestion
    expect(verifyLarkUserQuestionAction(secret, token, 1_000)).toMatchObject({
      rpcId: 'question-rpc-1',
      bindingId: 'binding-1',
      bindingVersion: 1,
      bindingGeneration: 1,
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      questionIndex: 0,
      optionIndex: 1,
      action: 'select',
      revision: 0,
    })

    let settled = false
    void pending.then(() => { settled = true })
    await f.transport.emitCardAction({
      messageId: 'om_question_1', chatId: 'oc_dm', operatorId: 'ou_other', tag: 'button',
      value: sent.userQuestion.options[1]!.value,
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    const response = await f.transport.emitCardAction({
      messageId: 'om_question_1', chatId: 'oc_dm', operatorId: 'ou_owner', tag: 'button',
      value: sent.userQuestion.options[1]!.value,
    })
    await expect(pending).resolves.toEqual({
      outcome: 'answered',
      answer: { answers: [{ id: 'strategy', selected: ['完整复制 (Recommended)'] }] },
    })
    expect(response).toMatchObject({ toast: { type: 'success' }, card: { type: 'raw' } })
    expect(f.context.accept).not.toHaveBeenCalled()
    await f.dispose?.()
  })

  test('collects multi-select and free-text questions sequentially without creating another turn', async () => {
    const f = await fixture({ approvalSecret: secret })
    const pending = f.adapter.requestUserQuestion(request({
      questions: [{
        id: 'parts', question: '要复制哪些部分？', multiSelect: true,
        options: [{ label: '历史' }, { label: '记忆' }, { label: 'Wiki' }],
      }, {
        id: 'name', question: '新副本叫什么名字？',
      }],
    }), new AbortController().signal)
    await vi.waitFor(() => expect(f.transport.send).toHaveBeenCalledOnce())
    const first = sentQuestionCard(f.transport)

    const toggled = await f.transport.emitCardAction({
      messageId: 'om_question_1', chatId: 'oc_dm', operatorId: 'ou_owner', tag: 'button',
      value: first.userQuestion.options[0]!.value,
    }) as { card: { data: unknown } }
    expect(JSON.stringify(toggled.card.data)).toContain('✓ 已选')
    const submit = callbackValue(toggled.card.data, 'user_question_submit')
    const next = await f.transport.emitCardAction({
      messageId: 'om_question_1', chatId: 'oc_dm', operatorId: 'ou_owner', tag: 'button', value: submit,
    }) as { card: { data: unknown } }
    expect(JSON.stringify(next.card.data)).toContain('新副本叫什么名字？')
    expect(JSON.stringify(next.card.data)).toContain('请直接回复这张问题卡片')

    await f.transport.emitMessage({
      messageId: 'om_text_answer',
      content: '暖树副本',
      replyToMessageId: 'om_question_1',
    })
    await expect(pending).resolves.toEqual({
      outcome: 'answered',
      answer: { answers: [
        { id: 'parts', selected: ['历史'] },
        { id: 'name', selected: [], custom: '暖树副本' },
      ] },
    })
    expect(f.context.accept).not.toHaveBeenCalled()
    expect(f.transport.updateRawCard).toHaveBeenCalledWith(
      'om_question_1', expect.any(Object), expect.any(AbortSignal),
    )

    await f.transport.emitMessage({
      messageId: 'om_text_answer',
      content: '暖树副本',
      replyToMessageId: 'om_question_1',
    })
    expect(f.context.accept).not.toHaveBeenCalled()
    await f.dispose?.()
  })

  test('accepts only an exact DM reply to the question card and never swallows a new message', async () => {
    const f = await fixture({ approvalSecret: secret })
    const controller = new AbortController()
    const pending = f.adapter.requestUserQuestion(request({
      questions: [{ id: 'detail', question: '还需要补充什么？' }],
    }), controller.signal)
    await vi.waitFor(() => expect(f.transport.send).toHaveBeenCalledOnce())
    let settled = false
    void pending.then(() => { settled = true })

    await f.transport.emitMessage({ messageId: 'om_other', senderId: 'ou_other', content: '不应成为回答' })
    expect(f.context.accept).toHaveBeenCalledOnce()
    await f.transport.emitMessage({ messageId: 'om_stop', content: '/stop' })
    expect(f.context.accept).toHaveBeenCalledTimes(2)
    await f.transport.emitMessage({ messageId: 'om_new_turn', content: '这是一个新的普通问题' })
    expect(f.context.accept).toHaveBeenCalledTimes(3)
    await Promise.resolve()
    expect(settled).toBe(false)

    await f.transport.emitMessage({
      messageId: 'om_direct_answer',
      content: '保持无感切换',
      replyToMessageId: 'om_question_1',
    })
    await expect(pending).resolves.toEqual({
      outcome: 'answered',
      answer: { answers: [{ id: 'detail', selected: [], custom: '保持无感切换' }] },
    })
    expect(f.context.accept).toHaveBeenCalledTimes(3)
    await f.dispose?.()
  })

  test('cancels on the signed cancel button and closes presentation when the Host resolves elsewhere', async () => {
    const f = await fixture({ approvalSecret: secret })
    const cancelled = f.adapter.requestUserQuestion(request(), new AbortController().signal)
    await vi.waitFor(() => expect(f.transport.send).toHaveBeenCalledOnce())
    const card = sentQuestionCard(f.transport)
    const callback = await f.transport.emitCardAction({
      messageId: 'om_question_1', chatId: 'oc_dm', operatorId: 'ou_owner', tag: 'button',
      value: card.userQuestion.cancelValue!,
    })
    await expect(cancelled).resolves.toEqual({ outcome: 'cancelled' })
    expect(callback).toMatchObject({ toast: { type: 'info' }, card: { type: 'raw' } })

    const controller = new AbortController()
    const resolved = f.adapter.requestUserQuestion(request({ operationId: 'question-rpc-2' }), controller.signal)
    await vi.waitFor(() => expect(f.transport.send).toHaveBeenCalledTimes(2))
    controller.abort(new Error('question resolved by another client'))
    await expect(resolved).resolves.toEqual({ outcome: 'unavailable' })
    await vi.waitFor(() => expect(f.transport.updateRawCard).toHaveBeenCalled())
    expect(JSON.stringify(f.transport.updateRawCard.mock.calls.at(-1)![1])).toContain('本次问题已处理')
    await f.dispose?.()
  })

  test('answers a top-level group question by an exact owner reply to its card', async () => {
    const f = await fixture({ approvalSecret: secret })
    const pending = f.adapter.requestUserQuestion(request({
      target: {
        principal: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_owner' },
        conversation: {
          channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', kind: 'group', chat: 'oc_group',
          thread: larkTopLevelSenderThread('ou_owner'),
        },
      },
      questions: [{ id: 'group-detail', question: '群内复制要叫什么？' }],
    }), new AbortController().signal)
    await vi.waitFor(() => expect(f.transport.send).toHaveBeenCalledOnce())
    expect(f.transport.send.mock.calls[0]![0]).toBe('oc_group')
    expect(f.transport.send.mock.calls[0]![2]).not.toHaveProperty('replyTo')

    let settled = false
    void pending.then(() => { settled = true })
    await f.transport.emitMessage({
      messageId: 'om_group_other',
      chatId: 'oc_group',
      chatType: 'group',
      senderId: 'ou_other',
      content: '不应成为回答',
      mentionedBot: false,
      rootId: 'om_question_1',
      replyToMessageId: 'om_question_1',
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(f.context.accept).not.toHaveBeenCalled()

    await f.transport.emitMessage({
      messageId: 'om_group_answer',
      chatId: 'oc_group',
      chatType: 'group',
      content: '暖树群内副本',
      mentionedBot: false,
      rootId: 'om_question_1',
      replyToMessageId: 'om_question_1',
    })
    await expect(pending).resolves.toEqual({
      outcome: 'answered',
      answer: { answers: [{ id: 'group-detail', selected: [], custom: '暖树群内副本' }] },
    })
    expect(f.context.accept).not.toHaveBeenCalled()
    await f.dispose?.()
  })
})
