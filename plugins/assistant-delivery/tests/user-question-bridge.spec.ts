import { Context } from '@deepseek-ai/cordis'
import type { ClientResponse, RpcReceipt } from '@deepseek-ai/dsh-host-apiproxy/api'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AssistantDeliveryService } from '../src/service.ts'
import { DeliveryStore } from '../src/store.ts'
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

interface FakeMuxWaiter {
  finish(frame: unknown | undefined): void
}

class FakeApiProxy {
  private readonly queued: unknown[] = []
  private readonly waiters: FakeMuxWaiter[] = []
  readonly responses: ClientResponse[] = []
  readonly events = {
    mux: vi.fn((_request: unknown, signal: AbortSignal): AsyncIterable<unknown> => this.open(signal)),
  }
  readonly respond = vi.fn(async (response: ClientResponse): Promise<RpcReceipt> => {
    this.responses.push(response)
    return { accepted: true }
  })

  emit(frame: unknown): void {
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.queued.push(frame)
    else waiter.finish(frame)
  }

  private async *open(signal: AbortSignal): AsyncGenerator<unknown> {
    while (!signal.aborted) {
      const frame = await this.next(signal)
      if (frame === undefined) return
      yield frame
    }
  }

  private async next(signal: AbortSignal): Promise<unknown | undefined> {
    const queued = this.queued.shift()
    if (queued !== undefined) return queued
    return await new Promise(resolve => {
      let settled = false
      const waiter: FakeMuxWaiter = {
        finish: frame => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', onAbort)
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          resolve(frame)
        },
      }
      const onAbort = () => waiter.finish(undefined)
      if (signal.aborted) onAbort()
      else {
        this.waiters.push(waiter)
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }
}

function storeOf(service: AssistantDeliveryService): DeliveryStore {
  return (service as unknown as { deliveryStore: DeliveryStore }).deliveryStore
}

function requested(rpcId: string, sessionId: string, batch = questions): unknown {
  return { rpcId, payload: { type: 'question/requested', sessionId, questions: batch } }
}

function resolved(rpcId: string, sessionId: string): unknown {
  return { rpcId: 'resolved-frame', payload: {
    type: 'question/resolved', sessionId, questionRpcId: rpcId, outcome: 'cancelled',
  } }
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

async function fixture(): Promise<{
  ctx: Context
  proxy: FakeApiProxy
  service: AssistantDeliveryService
  store: DeliveryStore
  binding: ConversationBinding
}> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-user-question-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  const proxy = new FakeApiProxy()
  ctx.provide('apiProxy' as never, proxy as never)
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
  await vi.waitFor(() => expect(proxy.events.mux).toHaveBeenCalledOnce())
  return { ctx, proxy, service, store, binding }
}

describe('assistant delivery ApiProxy user-question bridge', () => {
  test('routes one exact active owner question to a capable adapter and echoes its batch answer', async () => {
    const f = await fixture()
    let answer!: (outcome: DeliveryUserQuestionOutcome) => void
    const requestUserQuestion = vi.fn(() => new Promise<DeliveryUserQuestionOutcome>(resolve => { answer = resolve }))
    await f.service.registerAdapter(adapter(requestUserQuestion))

    f.proxy.emit(requested('rpc-answer', f.binding.sessionId))
    await vi.waitFor(() => expect(requestUserQuestion).toHaveBeenCalledOnce())
    expect(requestUserQuestion).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'rpc-answer',
      bindingId: f.binding.id,
      bindingVersion: f.binding.version,
      bindingGeneration: f.binding.generation,
      sessionId: f.binding.sessionId,
      target: { conversation, principal },
      questions,
    }), expect.any(AbortSignal))

    const exactAnswer = { answers: [{ id: 'history-copy', selected: ['复制全部 (Recommended)'] }] }
    answer({ outcome: 'answered', answer: exactAnswer })
    await vi.waitFor(() => expect(f.proxy.respond).toHaveBeenCalledOnce())
    expect(f.proxy.respond).toHaveBeenCalledWith({
      type: 'client-response',
      rpcId: 'rpc-answer',
      result: { ok: true, value: { sessionId: f.binding.sessionId, answer: exactAnswer } },
    })

    // ApiProxy replays pending requests with the same rpcId. A response tombstone
    // makes that replay idempotent rather than rendering a second card.
    f.proxy.emit(requested('rpc-answer', f.binding.sessionId))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(requestUserQuestion).toHaveBeenCalledOnce()
  })

  test('holds a request until its capable adapter registers and deduplicates its replay', async () => {
    const f = await fixture()
    f.proxy.emit(requested('rpc-late-adapter', f.binding.sessionId))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(f.proxy.respond).not.toHaveBeenCalled()

    let answer!: (outcome: DeliveryUserQuestionOutcome) => void
    const requestUserQuestion = vi.fn(() => new Promise<DeliveryUserQuestionOutcome>(resolve => { answer = resolve }))
    await f.service.registerAdapter(adapter(requestUserQuestion))
    await vi.waitFor(() => expect(requestUserQuestion).toHaveBeenCalledOnce())
    f.proxy.emit(requested('rpc-late-adapter', f.binding.sessionId))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(requestUserQuestion).toHaveBeenCalledOnce()

    answer({ outcome: 'cancelled' })
    await vi.waitFor(() => expect(f.proxy.respond).toHaveBeenCalledOnce())
    expect(f.proxy.responses[0]).toMatchObject({
      type: 'client-response',
      rpcId: 'rpc-late-adapter',
      result: { ok: false, error: { code: 'cancelled' } },
    })
  })

  test('observes but never answers or cancels a Web-only session with no Delivery binding', async () => {
    const f = await fixture()
    const requestUserQuestion = vi.fn(async (): Promise<DeliveryUserQuestionOutcome> => ({ outcome: 'cancelled' }))
    await f.service.registerAdapter(adapter(requestUserQuestion))

    f.proxy.emit(requested('rpc-web-only', 'web-session-without-delivery-binding'))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(requestUserQuestion).not.toHaveBeenCalled()
    expect(f.proxy.respond).not.toHaveBeenCalled()

    f.proxy.emit(resolved('rpc-web-only', 'web-session-without-delivery-binding'))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(f.proxy.respond).not.toHaveBeenCalled()
  })

  test('aborts an adapter request on ApiProxy resolution and never replies after it has resolved', async () => {
    const f = await fixture()
    let requestSignal!: AbortSignal
    const requestUserQuestion = vi.fn((_input: unknown, signal: AbortSignal) => new Promise<DeliveryUserQuestionOutcome>(resolve => {
      requestSignal = signal
      signal.addEventListener('abort', () => resolve({ outcome: 'cancelled' }), { once: true })
    }))
    await f.service.registerAdapter(adapter(requestUserQuestion))

    f.proxy.emit(requested('rpc-resolved', f.binding.sessionId))
    await vi.waitFor(() => expect(requestUserQuestion).toHaveBeenCalledOnce())
    f.proxy.emit(resolved('rpc-resolved', f.binding.sessionId))
    await vi.waitFor(() => expect(requestSignal.aborted).toBe(true))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(f.proxy.respond).not.toHaveBeenCalled()

    f.proxy.emit(requested('rpc-resolved', f.binding.sessionId))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(requestUserQuestion).toHaveBeenCalledOnce()
  })

  test('fails closed when the active binding generation changes before an adapter answer returns', async () => {
    const f = await fixture()
    let answer!: (outcome: DeliveryUserQuestionOutcome) => void
    const requestUserQuestion = vi.fn(() => new Promise<DeliveryUserQuestionOutcome>(resolve => { answer = resolve }))
    await f.service.registerAdapter(adapter(requestUserQuestion))

    f.proxy.emit(requested('rpc-generation-fence', f.binding.sessionId))
    await vi.waitFor(() => expect(requestUserQuestion).toHaveBeenCalledOnce())
    f.store.rotateBinding({
      bindingId: f.binding.id,
      expectedVersion: f.binding.version,
      sessionId: 'replacement-session',
    })
    answer({ outcome: 'answered', answer: {
      answers: [{ id: 'history-copy', selected: ['复制全部 (Recommended)'] }],
    } })

    await vi.waitFor(() => expect(f.proxy.respond).toHaveBeenCalledOnce())
    expect(f.proxy.responses[0]).toMatchObject({
      type: 'client-response',
      rpcId: 'rpc-generation-fence',
      result: { ok: false, error: { code: 'cancelled' } },
    })
  })

  test('falls back to a valid cancellation when ApiProxy rejects an adapter answer payload', async () => {
    const f = await fixture()
    f.proxy.respond
      .mockResolvedValueOnce({ accepted: false, reason: 'bad-response' })
      .mockResolvedValueOnce({ accepted: true })
    const requestUserQuestion = vi.fn(async (): Promise<DeliveryUserQuestionOutcome> => ({
      outcome: 'answered',
      answer: { answers: [{ id: 'wrong-id', selected: ['not-an-option'] }] },
    }))
    await f.service.registerAdapter(adapter(requestUserQuestion))

    f.proxy.emit(requested('rpc-bad-answer', f.binding.sessionId))
    await vi.waitFor(() => expect(f.proxy.respond).toHaveBeenCalledTimes(2))
    expect(f.proxy.respond.mock.calls[0]![0]).toMatchObject({
      rpcId: 'rpc-bad-answer', result: { ok: true },
    })
    expect(f.proxy.respond.mock.calls[1]![0]).toMatchObject({
      rpcId: 'rpc-bad-answer', result: { ok: false, error: { code: 'cancelled' } },
    })
  })
})
