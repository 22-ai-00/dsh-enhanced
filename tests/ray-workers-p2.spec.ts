import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '../plugins/assistant-delivery/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'
import { mountAgentLoopTestDependencies } from '../plugins/assistant-delivery/node_modules/@deepseek-ai/dsh-agent-loop-testkit/lib/index.js'
import {
  LlmAdapter,
  ReasoningEffortId,
  ToolCallId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  KNOWN_SESSION_EVENT_TYPES,
  SessionId,
  SessionLogOffset,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import { defineTool } from '../plugins/assistant-delivery/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { AssistantPolicyService, type PolicyRule } from '@dsh-ray/assistant-policy'
import { AssistantDeliveryService, type DeliveryAdapter, type InboundEnvelope, type OutboundIntent } from '@dsh-ray/assistant-delivery'
import { OwnerConsoleService } from '../plugins/owner-console/src/service.ts'
import { afterEach, describe, expect, test, vi } from 'vitest'

interface SavedSession {
  readonly header: SessionHeader
  readonly events: SessionEvent[]
  readonly inheritedEventCount: SessionLogOffset
}

interface PersistedHandle {
  readonly id: SessionId
  readonly access: 'read' | 'write'
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  read(offset?: number, length?: number, options?: { signal?: AbortSignal }): Promise<{ eventState: 'detached'; events: SessionEvent[] }>
  append(events: readonly SessionEvent[], options?: { signal?: AbortSignal }): Promise<void>
  flush(options?: { signal?: AbortSignal }): Promise<void>
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v) },
      e => { signal.removeEventListener('abort', onAbort); reject(e) },
    )
  })
}

function flattenMessagesText(messages: GenerateOptions['messages']): string {
  return messages.map(m => m.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('\n')).join('\n')
}

function countToolResults(messages: GenerateOptions['messages'], toolName: string): number {
  const callIds = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    for (const b of m.content) {
      if (b.type === 'tool-call' && b.name === toolName) callIds.add(String(b.id))
    }
  }
  return messages.filter(m => m.role === 'tool' && callIds.has(String(m.toolCallId))).length
}

function hasToolResult(messages: GenerateOptions['messages'], toolName: string): boolean {
  return countToolResults(messages, toolName) > 0
}

const ownerPrincipal = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner' }
const ownerConversation = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm' as const, chat: 'oc_owner' }

function inboundMsg(eventId: string, text: string, kind: 'text' | 'command' = 'text'): InboundEnvelope {
  return {
    channel: 'lark',
    account: 'bot-1',
    eventId,
    occurredAt: Date.now(),
    principal: ownerPrincipal,
    conversation: ownerConversation,
    kind,
    text,
  }
}

async function driveDelivery(service: AssistantDeliveryService): Promise<void> {
  await service.tick()
  await service.whenIdle()
  await service.tick()
  await service.whenIdle()
}

async function waitUntil(stage: string, predicate: () => boolean, diag?: () => string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitUntil [${stage}] timed out${diag ? ` diag=${diag()}` : ''}`)
    await new Promise(resolve => setTimeout(resolve, 15))
  }
}

const tempRoots: string[] = []

afterEach(async () => {
  while (tempRoots.length > 0) {
    await rm(tempRoots.pop()!, { recursive: true, force: true })
  }
})

async function withDeadline<T>(stage: string, promise: Promise<T>, diag?: () => string, timeoutMs = 4_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`TIMED OUT at [${stage}]${diag ? ` diag=${diag()}` : ''}`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

describe('Ray P2 end-to-end: front consciousness + persistent recoverable workers', () => {
  test('dispatches concurrent workers without blocking front chat, routes mid-run steer without cancelling, supports ticket_handback, enforces preauth, and recovers across restart', { timeout: 15_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'ray-p2-e2e-'))
    tempRoots.push(root)

    const rayHome = join(root, 'ray-home')
    const dshHome = join(root, 'dsh-home')
    const workspace = join(dshHome, 'workspace')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(join(dshHome, 'profiles', 'desktop'), { recursive: true })
    const saved = new Map<string, SavedSession>()
    const allWorkerRequests: GenerateOptions[] = []

    const stepAGate = deferred<void>()
    const stepAEntered = deferred<void>()
    const stepCGate = deferred<void>()
    const stepCEntered = deferred<void>()
    const bStartGate = deferred<void>()

    let ticketBId = ''
    let ticketAId = ''
    let ticketCId = ''
    let frontDispatchedAB = false
    let frontFollowedA = false
    let frontDispatchedC = false

    class ScriptedRayAdapter extends LlmAdapter {
      private callSeq = 0

      override providerInfo(provider: string): LlmProviderInfo {
        return { id: provider, name: 'Mock Ray Provider' }
      }

      override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
        return [{ provider, id: 'ray-fast', name: 'ray-fast', inputModalities: ['text'] }]
      }

      override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        return {
          provider,
          id: model,
          name: model,
          inputModalities: ['text'],
          reasoning: {
            efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }],
            defaultEffort: ReasoningEffortId('low'),
          },
        }
      }

      override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const idx = ++this.callSeq
        const allText = flattenMessagesText(options.messages)

        // Worker path
        if (allText.includes('[Ray Persistent Worker Ticket]')) {
          allWorkerRequests.push(options)
          if (allText.includes('标题：A架构调研') || allText.includes('title: A架构调研')) {
            if (!hasToolResult(options.messages, 'worker_step')) {
              const callId = ToolCallId(`wstep-a-${idx}`)
              yield { type: 'block-start', index: 0, blockType: 'tool-call' }
              yield { type: 'tool-call-delta', index: 0, id: callId, name: 'worker_step', argumentsDelta: '{"label":"workerA"}' }
              yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'worker_step', arguments: '{"label":"workerA"}' } }
              yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } }
              yield { type: 'finish', reason: { kind: 'tool-calls' } }
              return
            }
            const steeredNote = allText.includes('加上兼容性检查') ? '（已包含兼容性检查）' : ''
            const text = `A架构调研完成${steeredNote}。`
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'text-delta', index: 0, text }
            yield { type: 'block-end', index: 0, block: { type: 'text', text } }
            yield { type: 'usage', usage: { inputTokens: 25, outputTokens: 12, totalTokens: 37 } }
            yield { type: 'finish', reason: { kind: 'stop' } }
            return
          }

          if (allText.includes('标题：B越界调研') || allText.includes('title: B越界调研')) {
            await raceAbort(bStartGate.promise, options.signal)
            if (!hasToolResult(options.messages, 'ticket_handback')) {
              const callId = ToolCallId(`whandback-b-${idx}`)
              const args = JSON.stringify({
                reason: '需要修改安全内核参数，超出普通调研范围',
                summary: '已完成前置评估，需由前台和主人确认内核提案',
                suggested_next_step: '请主人在群内确认是否发起内核提案',
              })
              yield { type: 'block-start', index: 0, blockType: 'tool-call' }
              yield { type: 'tool-call-delta', index: 0, id: callId, name: 'ticket_handback', argumentsDelta: args }
              yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'ticket_handback', arguments: args } }
              yield { type: 'usage', usage: { inputTokens: 18, outputTokens: 14, totalTokens: 32 } }
              yield { type: 'finish', reason: { kind: 'tool-calls' } }
              return
            }
            const text = '已通过 ticket_handback 交回前台处理。'
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'text-delta', index: 0, text }
            yield { type: 'block-end', index: 0, block: { type: 'text', text } }
            yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } }
            yield { type: 'finish', reason: { kind: 'stop' } }
            return
          }

          if (allText.includes('标题：C重启恢复任务') || allText.includes('title: C重启恢复任务')) {
            if (!allText.includes('宿主刚刚重启恢复')) {
              const callId = ToolCallId(`wstep-c-${idx}`)
              yield { type: 'block-start', index: 0, blockType: 'tool-call' }
              yield { type: 'tool-call-delta', index: 0, id: callId, name: 'worker_step', argumentsDelta: '{"label":"workerC"}' }
              yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'worker_step', arguments: '{"label":"workerC"}' } }
              yield { type: 'usage', usage: { inputTokens: 15, outputTokens: 8, totalTokens: 23 } }
              yield { type: 'finish', reason: { kind: 'tool-calls' } }
              return
            }
            const text = 'C任务已在宿主重启恢复后顺利完成。'
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'text-delta', index: 0, text }
            yield { type: 'block-end', index: 0, block: { type: 'text', text } }
            yield { type: 'usage', usage: { inputTokens: 15, outputTokens: 10, totalTokens: 25 } }
            yield { type: 'finish', reason: { kind: 'stop' } }
            return
          }
        }

        // Front consciousness path
        const userMessages = options.messages.filter(m => m.role === 'user' && m.source?.kind !== 'runtime-context')
        const lastUserText = userMessages[userMessages.length - 1]?.content
          .flatMap(b => (b.type === 'text' ? [b.text] : [])).join('') ?? ''

        if (lastUserText.includes('同时做A和B') && !frontDispatchedAB && countToolResults(options.messages, 'ticket_dispatch') < 2) {
          frontDispatchedAB = true
          const c1 = ToolCallId(`dispatch-a-${idx}`)
          const c2 = ToolCallId(`dispatch-b-${idx}`)
          const args1 = JSON.stringify({ title: 'A架构调研', objective: '调研A架构并发边界', scope_summary: '仅调研架构不改内核' })
          const args2 = JSON.stringify({ title: 'B越界调研', objective: '评估B内核权限调整', scope_summary: '仅调研，不可修改安全内核' })
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id: c1, name: 'ticket_dispatch', argumentsDelta: args1 }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: c1, name: 'ticket_dispatch', arguments: args1 } }
          yield { type: 'block-start', index: 1, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 1, id: c2, name: 'ticket_dispatch', argumentsDelta: args2 }
          yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: c2, name: 'ticket_dispatch', arguments: args2 } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }

        if (lastUserText.includes('先随便聊一句')) {
          const text = '我在的，两个后台 worker 正在并发推进，随时说！'
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }

        if (lastUserText.includes('给A补充兼容性检查') && !frontFollowedA && !hasToolResult(options.messages, 'ticket_followup')) {
          frontFollowedA = true
          const c = ToolCallId(`followup-a-${idx}`)
          const args = JSON.stringify({ ticket_id: ticketAId, message: '加上兼容性检查' })
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id: c, name: 'ticket_followup', argumentsDelta: args }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: c, name: 'ticket_followup', arguments: args } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }

        if (lastUserText.includes('启动长期任务C') && !frontDispatchedC) {
          frontDispatchedC = true
          const c = ToolCallId(`dispatch-c-${idx}`)
          const args = JSON.stringify({ title: 'C重启恢复任务', objective: '持续运行直到重启后完成', scope_summary: '长流程任务' })
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id: c, name: 'ticket_dispatch', argumentsDelta: args }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: c, name: 'ticket_dispatch', arguments: args } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }

        const text = lastUserText.includes('同时做A和B')
          ? '已派出两位持久助手（A架构调研、B越界调研），你可以随时插话或聊别的。'
          : `前台已处理完成：${lastUserText}`
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }

    async function bootHost(phase: 'host1' | 'host2') {
      const ctx = new Context()
      ctx.baseUrl = pathToFileURL(`${root}/`).href
      await ctx.plugin(Loader, { baseUrl: import.meta.url })
      await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })
      await ctx.plugin(ApprovalService, { policy: 'ask' })
      ctx.on('approval/request', async () => 'allowed-once', { prepend: true })

      ctx.provide('typert' as never, { register: () => () => {} } as never)
      ctx.provide('profileContext' as never, { home: dshHome, name: 'desktop', dir: join(dshHome, 'profiles', 'desktop') } as never)
      ctx.provide('fileUploads' as never, {
        registerAgentResolver: () => () => {},
        resolve: () => { throw new Error('unused') },
        bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }),
      } as never)

      const fallbackWriters = new Map<string, PersistedHandle>()
      const makeHandle = (id: SessionId, access: 'read' | 'write'): PersistedHandle => {
        const key = String(id)
        const pending: SessionEvent[] = []
        let closed = false
        const header = saved.get(key)!.header
        const inheritedEventCount = saved.get(key)!.inheritedEventCount
        const handle: PersistedHandle = {
          id,
          access,
          header: structuredClone(header),
          inheritedEventCount,
          async read(offset = 0, length?: number) {
            const events = [...saved.get(key)!.events, ...pending]
            return { eventState: 'detached', events: structuredClone(events.slice(offset, length === undefined ? undefined : offset + length)) }
          },
          async append(events) {
            if (access !== 'write') throw new Error('read-only')
            pending.push(...structuredClone(events))
          },
          async flush() {
            if (access !== 'write') throw new Error('read-only')
            const cur = saved.get(key)!
            saved.set(key, { ...cur, events: [...cur.events, ...pending.splice(0)] })
          },
          async close() {
            closed = true
            if (access === 'write') fallbackWriters.delete(key)
          },
          async [Symbol.asyncDispose]() {
            if (!closed) await this.close()
          },
        }
        if (access === 'write') fallbackWriters.set(key, handle)
        return handle
      }

      ctx.provide('sessionPersistence' as never, {
        coordinator: {
          assertEventsSupported(_meta: SessionHeader, events: readonly SessionEvent[]) {
            for (const e of events) {
              if (!KNOWN_SESSION_EVENT_TYPES.has(e.type) && e.ignorable !== true) {
                throw new Error(`unsupported event ${e.type}`)
              }
            }
          },
        },
        create: async (header: SessionHeader) => {
          saved.set(String(header.id), {
            header: structuredClone(header),
            events: [],
            inheritedEventCount: SessionLogOffset(0),
          })
          return makeHandle(header.id, 'write')
        },
        open: async (id: SessionId, access: 'read' | 'write') => {
          if (!saved.has(String(id))) {
            throw Object.assign(new Error(`missing session ${id}`), { name: 'SessionPersistenceNotFoundError' })
          }
          return makeHandle(id, access)
        },
        flush: async () => {
          await Promise.all([...fallbackWriters.values()].map(h => h.flush()))
        },
        stat: async (id: SessionId) => {
          const val = saved.get(String(id))
          return val === undefined ? undefined : {
            header: structuredClone(val.header),
            revision: createHash('sha256').update(JSON.stringify(val)).digest('hex'),
          }
        },
        list: async () => [...saved.values()].map(val => ({
          header: structuredClone(val.header),
          revision: createHash('sha256').update(JSON.stringify(val)).digest('hex'),
        })),
      } as never)

      ctx.on('session/event', (session, event) => {
        const w = fallbackWriters.get(String(session.id))
        if (w !== undefined) void w.append([event])
      })
      ctx.on('session/flush', session => fallbackWriters.get(String(session.id))?.flush())
      ctx.on('session/disposed', session => { void fallbackWriters.get(String(session.id))?.close() })

      ctx.provide('agentPresets' as never, {
        resolve: async (id = 'standard') => ({ id }),
        mount: async () => ({ id: 'standard' }),
        presetForSession: () => 'standard',
        select: async () => {},
      } as never)

      const rules: PolicyRule[] = [
        {
          id: 'local-pair',
          effect: 'allow',
          subject: { kind: 'external', id: 'local:cli' },
          actions: ['pair.issue'],
          resource: { kind: 'message', id: 'pairing' },
          context: { initiators: ['foreground'] },
        },
        {
          id: 'owner-external',
          effect: 'allow',
          subject: { kind: 'external', id: 'lark/bot-1/tenant-a/ou_owner' },
          actions: ['pair.confirm', 'ingest'],
          resource: { kind: 'message', id: '*' },
          context: { initiators: ['external'] },
        },
        {
          id: 'owner-reply',
          effect: 'allow',
          subject: { kind: 'agent', id: 'standard', workspace, principal: 'lark/bot-1/tenant-a/ou_owner' },
          actions: ['reply'],
          resource: { kind: 'message', id: '*' },
          context: { initiators: ['external'] },
        },
        {
          id: 'worker-step-allow',
          effect: 'allow',
          subject: { kind: 'agent', id: 'standard', workspace, principal: 'lark/bot-1/tenant-a/ou_owner' },
          actions: ['execute'],
          resource: { kind: 'tool', id: 'worker_step' },
          context: { initiators: ['external'] },
        },
        ...(['ticket_dispatch', 'ticket_list', 'ticket_followup', 'ticket_handback', 'ray_owner_veto'].map(toolName => ({
          id: `allow-${toolName}`,
          effect: 'allow' as const,
          subject: { kind: 'agent' as const, id: 'standard', workspace, principal: 'lark/bot-1/tenant-a/ou_owner' },
          actions: ['execute'],
          resource: { kind: 'tool' as const, id: toolName },
          context: { initiators: ['external' as const] },
        }))),
        {
          id: 'worker-narration-send',
          effect: 'allow',
          subject: { kind: 'background', id: 'assistant-delivery/worker-tickets', workspace, principal: 'lark/bot-1/tenant-a/ou_owner' },
          actions: ['send'],
          resource: { kind: 'message', id: '*' },
          context: { initiators: ['background'] },
        },
      ]

      await ctx.plugin(AssistantPolicyService, {
        databasePath: join(rayHome, 'state', 'policy.sqlite'),
        rayHome,
        toolDefaultEffect: 'deny',
        proposalMaintenanceIntervalMs: 0,
        rules,
      })
      const policy = ctx.assistantPolicy
      await policy.raySelf!.whenReady()

      ctx.tools.register(defineTool({
        name: 'worker_step',
        description: 'Simulates an interruptible long step inside a worker session.',
        parameters: { label: { type: 'string', required: true } },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { done: { type: 'boolean', required: true } } },
          render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
        },
        async execute(args, exec) {
          if (args.label === 'workerA') {
            stepAEntered.resolve()
            await raceAbort(stepAGate.promise, exec.signal)
          } else if (args.label === 'workerC') {
            stepCEntered.resolve()
            if (phase === 'host1') {
              await raceAbort(stepCGate.promise, exec.signal)
            }
          }
          return { done: true }
        },
      }))

      await ctx.plugin(AssistantDeliveryService, {
        databasePath: join(root, 'delivery.sqlite'),
        spoolPath: join(root, 'spool'),
        schedulerEnabled: false,
        defaultWorkspace: workspace,
        defaultAgentPreset: 'standard',
        agentProvider: 'mock',
        agentModel: 'ray-fast',
        attentionEnforce: true,
        attentionAttachOverCap: true,
      })
      const delivery = ctx.assistantDelivery

      const sends: OutboundIntent[] = []
      const larkAdapter: DeliveryAdapter = {
        channel: 'lark',
        account: 'bot-1',
        capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain', 'markdown'], textAttachments: true },
        start: async () => {},
        send: async intent => {
          sends.push(intent)
          return {
            outcome: 'accepted',
            providerMessageId: `om_${createHash('sha256').update(intent.idempotencyKey).digest('hex').slice(0, 24)}`,
          }
        },
      }
      await delivery.registerAdapter(larkAdapter)

      ctx.llm.registerAdapter(['mock'], new ScriptedRayAdapter())
      await ctx.plugin(AgentLoop, { agents: [] })

      const consoleSvc = new OwnerConsoleService(ctx, { feishuAppId: '' })
      return { ctx, policy, delivery, consoleSvc, sends }
    }

    // --- Boot Host 1 ---
    const host1 = await bootHost('host1')
    const challenge = host1.delivery.issuePairing('cli', ownerPrincipal)
    host1.delivery.confirmPairing({ challengeId: challenge.challenge.id, principal: ownerPrincipal, code: challenge.code })

    // 1. Dispatch 2 concurrent workers while front responds promptly
    await host1.delivery.acceptInbound(inboundMsg('ev-dispatch-ab', '同时做A和B'))
    await driveDelivery(host1.delivery)

    const ticketsAfterDispatch = host1.delivery.listRayWorkerTickets()
    expect(ticketsAfterDispatch.filter(t => t.status === 'running')).toHaveLength(2)
    ticketAId = ticketsAfterDispatch.find(t => t.title === 'A架构调研')!.ticketId
    ticketBId = ticketsAfterDispatch.find(t => t.title === 'B越界调研')!.ticketId
    expect(host1.sends.some(s => s.replyToEventId === 'ev-dispatch-ab' && s.text.includes('A架构调研'))).toBe(true)

    // Front stays immediately responsive for casual chat while workers run
    await host1.delivery.acceptInbound(inboundMsg('ev-chat-while-busy', '在吗，先随便聊一句'))
    await driveDelivery(host1.delivery)
    expect(host1.sends.some(s => s.replyToEventId === 'ev-chat-while-busy' && s.text.includes('正在并发推进'))).toBe(true)
    expect(host1.delivery.workerTicketsRuntime()!.getTicket(ticketAId)?.status).toBe('running')

    // /tickets and Desktop OwnerConsoleService inspect unified worker ledger
    await host1.delivery.acceptInbound(inboundMsg('ev-cmd-tickets', '/tickets', 'command'))
    await driveDelivery(host1.delivery)
    expect(host1.sends.some(s => s.replyToEventId === 'ev-cmd-tickets' && s.text.includes('A架构调研'))).toBe(true)

    const consoleTickets = await host1.consoleSvc.rayWorkerTickets()
    expect(consoleTickets.active).toBe(true)
    expect(consoleTickets.tickets.map(t => t.title)).toContain('A架构调研')

    // 2. Mid-run interruption -> ticket_followup (steer) without cancelling Worker A
    await withDeadline('stepAEntered', stepAEntered.promise, () => JSON.stringify({
      tickets: host1.delivery.listRayWorkerTickets(),
      workerCalls: allWorkerRequests.length,
    }))
    const workerASessionId = host1.delivery.listRayWorkerTickets().find(t => t.ticketId === ticketAId)!.sessionId
    const workerAAgent = host1.ctx.get('agents')!.get(SessionId(workerASessionId))!
    const cancelSpy = vi.spyOn(workerAAgent, 'cancel')

    await host1.delivery.acceptInbound(inboundMsg('ev-steer-a', '给A补充兼容性检查'))
    await driveDelivery(host1.delivery)

    expect(cancelSpy).not.toHaveBeenCalled()
    expect(host1.delivery.workerTicketsRuntime()!.listTicketEvents(ticketAId).some(e => e.kind === 'steer')).toBe(true)

    stepAGate.resolve()
    await waitUntil('A-completed', () => host1.delivery.listRayWorkerTickets().find(t => t.ticketId === ticketAId)?.status === 'completed',
      () => JSON.stringify({
        ticketA: host1.delivery.listRayWorkerTickets().find(t => t.ticketId === ticketAId),
        workerAStatus: workerAAgent.status,
        workerACalls: allWorkerRequests.length,
        workerAEvents: host1.ctx.get('agents')!.get(SessionId(workerASessionId))?.session.snapshotEvents().map(e => e.type),
      }))
    await driveDelivery(host1.delivery)

    const ticketAAfter = host1.delivery.listRayWorkerTickets().find(t => t.ticketId === ticketAId)!
    expect(ticketAAfter.sessionId).toBe(workerASessionId)
    expect(ticketAAfter.resultSummary).toContain('兼容性检查')
    expect(ticketAAfter.narrationText).toContain('A架构调研')
    expect(host1.sends.some(s => s.replyToEventId === undefined && s.text.includes('A架构调研') && s.text.includes('兼容性检查'))).toBe(true)

    // 3. Scope overflow ticket_handback on Worker B + preauthorization boundary checks
    expect(() => host1.delivery.history(workerAAgent, { limit: 1 })).toThrow()
    const frontSessionEntry = saved.get([...saved.keys()].find(id => !id.startsWith('ray_worker_'))!)!
    expect(frontSessionEntry).toBeDefined()
    const frontHandle = await host1.ctx.get('agents')!.resume({
      resumeSessionId: frontSessionEntry.header.id,
      setup: async (agentCtx, prepared) => {
        if (prepared !== undefined) {
          const unbind = host1.policy.bindInitiator(prepared, 'external', 'lark/bot-1/tenant-a/ou_owner')
          agentCtx.effect(() => unbind)
        }
      },
    })
    const frontAgent = frontHandle.agent
    expect(host1.delivery.isOwnerSessionAgent(frontAgent)).toBe(true)
    expect(host1.delivery.ownsWorkerSessionAgent(frontAgent)).toBe(false)

    // Front must NOT call ticket_handback; Worker must NOT call ticket_dispatch or ray_owner_veto
    const deniedFrontHandback = await host1.ctx.tools.execute({
      calls: [{
        type: 'tool-call',
        id: ToolCallId('deny-front-handback'),
        name: 'ticket_handback',
        arguments: JSON.stringify({ reason: 'test', summary: 'test' }),
      }],
      agent: frontAgent,
      signal: new AbortController().signal,
    })
    expect(deniedFrontHandback.results[0]?.result.isError).toBe(true)
    await frontHandle.dispose()

    const workerBSessionId = host1.delivery.listRayWorkerTickets().find(t => t.ticketId === ticketBId)!.sessionId
    bStartGate.resolve()
    await waitUntil('B-handed_back', () => host1.delivery.listRayWorkerTickets().find(t => t.ticketId === ticketBId)?.status === 'handed_back',
      () => JSON.stringify({
        ticketB: host1.delivery.listRayWorkerTickets().find(t => t.ticketId === ticketBId),
        workerBEvents: host1.ctx.get('agents')!.get(SessionId(workerBSessionId))?.session.snapshotEvents().map(e => e.type),
      }))

    const workerBAgent = host1.ctx.get('agents')!.get(SessionId(workerBSessionId))
    if (workerBAgent !== undefined) {
      const deniedWorkerDispatch = await host1.ctx.tools.execute({
        calls: [{
          type: 'tool-call',
          id: ToolCallId('deny-worker-dispatch'),
          name: 'ticket_dispatch',
          arguments: JSON.stringify({ title: 'x', objective: 'y' }),
        }],
        agent: workerBAgent,
        signal: new AbortController().signal,
      })
      expect(deniedWorkerDispatch.results[0]?.result.isError).toBe(true)
    }

    await driveDelivery(host1.delivery)
    const ticketBAfter = host1.delivery.listRayWorkerTickets().find(t => t.ticketId === ticketBId)!
    expect(ticketBAfter.status).toBe('handed_back')
    expect(ticketBAfter.handbackReason).toContain('超出普通调研范围')
    expect(host1.sends.some(s => s.replyToEventId === undefined && s.text.includes('B越界调研') && s.text.includes('交回前台'))).toBe(true)

    // 4. Cold Restart Recovery on unfinished running ticket C
    await host1.delivery.acceptInbound(inboundMsg('ev-dispatch-c', '启动长期任务C'))
    await driveDelivery(host1.delivery)
    await withDeadline('stepCEntered', stepCEntered.promise, () => JSON.stringify({
      tickets: host1.delivery.listRayWorkerTickets(),
    }))

    ticketCId = host1.delivery.listRayWorkerTickets().find(t => t.title === 'C重启恢复任务')!.ticketId
    expect(host1.delivery.listRayWorkerTickets().find(t => t.ticketId === ticketCId)?.status).toBe('running')

    // Simulate Host 1 graceful shutdown while Worker C is still running
    await withDeadline('host1.fiber.restart', host1.ctx.fiber.restart())

    const dbBeforeRestart = new DatabaseSync(join(rayHome, 'state', 'tickets.sqlite'), { readOnly: true })
    const rowBefore = dbBeforeRestart.prepare('SELECT status FROM ray_tickets WHERE ticket_id = ?').get(ticketCId) as { status: string }
    dbBeforeRestart.close()
    expect(rowBefore.status).toBe('running')

    // Boot Host 2 and recover unfinished running ticket C
    const host2 = await bootHost('host2')
    const recoveredCount = await host2.delivery.recoverRayWorkerTickets()
    expect(recoveredCount).toBe(1)

    await waitUntil('C-completed', () => host2.delivery.listRayWorkerTickets().find(t => t.ticketId === ticketCId)?.status === 'completed',
      () => JSON.stringify({
        ticketC: host2.delivery.listRayWorkerTickets().find(t => t.ticketId === ticketCId),
      }))
    await driveDelivery(host2.delivery)

    const ticketCAfter = host2.delivery.listRayWorkerTickets().find(t => t.ticketId === ticketCId)!
    expect(ticketCAfter.status).toBe('completed')
    expect(ticketCAfter.resultSummary).toContain('宿主重启恢复后顺利完成')
    expect(host2.delivery.workerTicketsRuntime()!.listTicketEvents(ticketCId).some(e => e.kind === 'resumed')).toBe(true)
    expect(host2.sends.some(s => s.text.includes('C重启恢复任务') && s.text.includes('宿主重启恢复'))).toBe(true)

    const consoleTicketsAfter = await host2.consoleSvc.rayWorkerTickets()
    expect(consoleTicketsAfter.tickets.find(t => t.ticketId === ticketCId)?.status).toBe('completed')

    await host2.ctx.fiber.restart()
  })
})
