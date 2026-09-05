import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AssistantDeliveryService } from '../src/service.ts'
import { DeliveryStore } from '../src/store.ts'
import type {
  AskUserQuestionAnswer,
} from '@deepseek-ai/dsh-user-questions'
import type {
  ConversationBinding,
  DeliveryAdapter,
  DeliveryUserQuestionOutcome,
} from '../src/types.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.restart()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const principal = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner' }
const conversation = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm' as const, chat: 'oc_owner' }
const questions = [{
  id: 'history-copy',
  question: '希望如何继续？',
  header: '确认范围',
  options: [
    { label: '复制全部 (Recommended)', description: '保留全部历史与记忆' },
    { label: '只复制近期对话', description: '仅保留最近上下文' },
  ],
}]
const exactAnswer: AskUserQuestionAnswer = {
  answers: [{ id: 'history-copy', selected: ['复制全部 (Recommended)'] }],
}

function storeOf(service: AssistantDeliveryService): DeliveryStore {
  return (service as unknown as { deliveryStore: DeliveryStore }).deliveryStore
}

function adapter(
  requestUserQuestion: NonNullable<DeliveryAdapter['requestUserQuestion']>,
): DeliveryAdapter {
  return {
    channel: 'lark',
    account: 'bot-1',
    capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'], userQuestions: true },
    start: async () => {},
    requestUserQuestion,
    send: async () => ({ outcome: 'accepted', providerMessageId: 'om_unused' }),
  }
}

function liveAgent(ctx: Context, sessionId: string): Agent {
  const id = SessionId(sessionId)
  const session = ctx.sessions.create(id, { meta: { cwd: '/work/alpha', agentPreset: 'primary' } })
  const agent: Agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    ctx: new Context(),
    status: 'idle',
    cancel() {},
    whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal),
    send() {},
    followup() {},
    steer() {},
    inject() {},
  }
  ctx.agents.register(agent)
  return agent
}

async function fixture(options: { blockingAnswererBeforeDelivery?: boolean } = {}): Promise<{
  ctx: Context
  service: AssistantDeliveryService
  store: DeliveryStore
  binding: ConversationBinding
  agent: Agent
  earlierAnswerer: ReturnType<typeof vi.fn<() => Promise<AskUserQuestionAnswer>>>
}> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-user-question-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  const earlierAnswerer = vi.fn(() => new Promise<AskUserQuestionAnswer>(() => {}))
  if (options.blockingAnswererBeforeDelivery === true) {
    ctx.on('user-questions/request', earlierAnswerer)
  }
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    rules: [
      { id: 'pair-issue', effect: 'allow', subject: { kind: 'external', id: 'local:test' },
        actions: ['pair.issue'], resource: { kind: 'message', id: '*' }, context: { initiators: ['foreground'] } },
      { id: 'pair-confirm', effect: 'allow', subject: { kind: 'external', id: 'lark/bot-1/tenant-a/ou_owner' },
        actions: ['pair.confirm'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
    ],
  })
  await ctx.plugin(AssistantDeliveryService, {
    databasePath: join(root, 'delivery.sqlite'),
    spoolPath: join(root, 'spool'),
    schedulerEnabled: false,
  })
  const service = ctx.assistantDelivery
  const challenge = service.issuePairing('test', principal)
  service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
  const store = storeOf(service)
  const binding = store.createBinding({
    conversation,
    principal,
    workspace: '/work/alpha',
    agentPreset: 'primary',
    sessionId: 'user-question-session',
    policyRef: 'owner-dm',
  })
  return { ctx, service, store, binding, agent: liveAgent(ctx, binding.sessionId), earlierAnswerer }
}

describe('assistant delivery user-question waterfall answerer', () => {
  test('routes an exact live owner Agent question to its capable adapter', async () => {
    const f = await fixture()
    const requestUserQuestion = vi.fn(async (): Promise<DeliveryUserQuestionOutcome> => ({
      outcome: 'answered',
      answer: exactAnswer,
    }))
    await f.service.registerAdapter(adapter(requestUserQuestion))

    await expect(f.ctx.userQuestions.ask({ agent: f.agent, questions })).resolves.toEqual(exactAnswer)
    expect(requestUserQuestion).toHaveBeenCalledWith(expect.objectContaining({
      operationId: expect.any(String),
      bindingId: f.binding.id,
      bindingVersion: f.binding.version,
      bindingGeneration: f.binding.generation,
      sessionId: f.binding.sessionId,
      target: { conversation, principal },
      questions,
    }), expect.any(AbortSignal))
  })

  test('runs before an earlier blocking answerer so a Web listener cannot starve the channel', async () => {
    const f = await fixture({ blockingAnswererBeforeDelivery: true })
    const requestUserQuestion = vi.fn(async (): Promise<DeliveryUserQuestionOutcome> => ({
      outcome: 'answered', answer: exactAnswer,
    }))
    await f.service.registerAdapter(adapter(requestUserQuestion))

    await expect(f.ctx.userQuestions.ask({ agent: f.agent, questions })).resolves.toEqual(exactAnswer)
    expect(requestUserQuestion).toHaveBeenCalledOnce()
    expect(f.earlierAnswerer).not.toHaveBeenCalled()
  })

  test('declines agentless and non-Delivery questions to the next answerer', async () => {
    const f = await fixture()
    const fallback = vi.fn(async () => exactAnswer)
    f.ctx.on('user-questions/request', fallback)
    const requestUserQuestion = vi.fn(async (): Promise<DeliveryUserQuestionOutcome> => ({
      outcome: 'answered', answer: exactAnswer,
    }))
    await f.service.registerAdapter(adapter(requestUserQuestion))

    await expect(f.ctx.userQuestions.ask({ questions })).resolves.toEqual(exactAnswer)
    const unrelated = liveAgent(f.ctx, 'unrelated-session')
    await expect(f.ctx.userQuestions.ask({ agent: unrelated, questions })).resolves.toEqual(exactAnswer)
    expect(fallback).toHaveBeenCalledTimes(2)
    expect(requestUserQuestion).not.toHaveBeenCalled()
  })

  test('passes adapter unavailability to the next answerer', async () => {
    const f = await fixture()
    const fallback = vi.fn(async () => exactAnswer)
    f.ctx.on('user-questions/request', fallback)
    const requestUserQuestion = vi.fn(async (): Promise<DeliveryUserQuestionOutcome> => ({ outcome: 'unavailable' }))
    await f.service.registerAdapter(adapter(requestUserQuestion))

    await expect(f.ctx.userQuestions.ask({ agent: f.agent, questions })).resolves.toEqual(exactAnswer)
    expect(requestUserQuestion).toHaveBeenCalledOnce()
    expect(fallback).toHaveBeenCalledOnce()
  })

  test('passes an adapter failure to the next answerer', async () => {
    const f = await fixture()
    const fallback = vi.fn(async () => exactAnswer)
    f.ctx.on('user-questions/request', fallback)
    await f.service.registerAdapter(adapter(async () => { throw new Error('channel offline') }))

    await expect(f.ctx.userQuestions.ask({ agent: f.agent, questions })).resolves.toEqual(exactAnswer)
    expect(fallback).toHaveBeenCalledOnce()
  })

  test.each([
    [null],
    [{ outcome: 'unexpected' }],
    [{ answers: [] }],
    [{ answers: [{ id: 'wrong-id', selected: ['复制全部 (Recommended)'] }] }],
    [{ answers: [{ id: 'history-copy', selected: ['复制全部 (Recommended)', '复制全部 (Recommended)'] }] }],
    [{ answers: [{ id: 'history-copy', selected: ['不存在的选项'] }] }],
    [{ answers: [{ id: 'history-copy', selected: ['复制全部 (Recommended)', '只复制近期对话'] }] }],
    [{ answers: [{ id: 'history-copy', selected: ['复制全部 (Recommended)'], custom: '自定义' }] }],
    [{ answers: [{ id: 'history-copy', selected: [], custom: '   ' }] }],
  ] as const)('passes malformed adapter answer %# to the next answerer', async malformed => {
    const f = await fixture()
    const fallback = vi.fn(async () => exactAnswer)
    f.ctx.on('user-questions/request', fallback)
    const requestUserQuestion = vi.fn(async (): Promise<DeliveryUserQuestionOutcome> =>
      malformed !== null && 'answers' in malformed
        ? { outcome: 'answered', answer: malformed as never }
        : malformed as never)
    await f.service.registerAdapter(adapter(requestUserQuestion))

    await expect(f.ctx.userQuestions.ask({ agent: f.agent, questions })).resolves.toEqual(exactAnswer)
    expect(fallback).toHaveBeenCalledOnce()
  })

  test('fails closed instead of falling through when an existing binding is no longer active', async () => {
    const f = await fixture()
    const fallback = vi.fn(async () => exactAnswer)
    f.ctx.on('user-questions/request', fallback)
    await f.service.registerAdapter(adapter(async () => ({ outcome: 'answered', answer: exactAnswer })))
    f.store.rotateBinding({
      bindingId: f.binding.id,
      expectedVersion: f.binding.version,
      sessionId: 'replacement-session',
    })

    await expect(f.ctx.userQuestions.ask({ agent: f.agent, questions }))
      .rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_ABORTED' })
    expect(fallback).not.toHaveBeenCalled()
  })

  test('propagates caller cancellation into the adapter request', async () => {
    const f = await fixture()
    let adapterSignal!: AbortSignal
    const requestUserQuestion = vi.fn((_input: unknown, signal: AbortSignal) =>
      new Promise<DeliveryUserQuestionOutcome>(resolve => {
        adapterSignal = signal
        signal.addEventListener('abort', () => resolve({ outcome: 'cancelled' }), { once: true })
      }))
    await f.service.registerAdapter(adapter(requestUserQuestion))
    const controller = new AbortController()
    const pending = f.ctx.userQuestions.ask({ agent: f.agent, questions, signal: controller.signal })
    await vi.waitFor(() => expect(requestUserQuestion).toHaveBeenCalledOnce())

    controller.abort(new Error('caller stopped'))
    await expect(pending).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_ABORTED' })
    expect(adapterSignal.aborted).toBe(true)
  })

  test('fails closed when the active binding generation changes before the answer returns', async () => {
    const f = await fixture()
    let answer!: (outcome: DeliveryUserQuestionOutcome) => void
    const requestUserQuestion = vi.fn(() => new Promise<DeliveryUserQuestionOutcome>(resolve => { answer = resolve }))
    await f.service.registerAdapter(adapter(requestUserQuestion))
    const pending = f.ctx.userQuestions.ask({ agent: f.agent, questions })
    await vi.waitFor(() => expect(requestUserQuestion).toHaveBeenCalledOnce())
    f.store.rotateBinding({
      bindingId: f.binding.id,
      expectedVersion: f.binding.version,
      sessionId: 'replacement-session',
    })

    answer({ outcome: 'answered', answer: exactAnswer })
    await expect(pending).rejects.toMatchObject({ code: 'ASK_ABORTED' })
  })

  test('aborts an in-flight channel question when its adapter unregisters', async () => {
    const f = await fixture()
    let adapterSignal!: AbortSignal
    const requestUserQuestion = vi.fn((_input: unknown, signal: AbortSignal) =>
      new Promise<DeliveryUserQuestionOutcome>(resolve => {
        adapterSignal = signal
        signal.addEventListener('abort', () => resolve({ outcome: 'cancelled' }), { once: true })
      }))
    const unregister = await f.service.registerAdapter(adapter(requestUserQuestion))
    const pending = f.ctx.userQuestions.ask({ agent: f.agent, questions })
    await vi.waitFor(() => expect(requestUserQuestion).toHaveBeenCalledOnce())

    await unregister()
    await expect(pending).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_ABORTED' })
    expect(adapterSignal.aborted).toBe(true)
  })
})
