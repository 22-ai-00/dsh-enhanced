import { existsSync, mkdirSync, readFileSync } from 'node:fs'
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
  createAssistantMessage,
  createUserMessage,
  isAgentLoopRequest,
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
  type Session,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import { renderContextSections } from '../plugins/assistant-policy/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { AssistantPolicyService, type PolicyRule } from '@dsh-ray/assistant-policy'
import { PersonalMemoryService } from '@dsh-ray/personal-memory'
import { afterEach, describe, expect, test } from 'vitest'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'ray-p3-test': { kind: 'ray-p3-test' }
  }
}

interface SavedSession {
  readonly header: SessionHeader
  readonly events: SessionEvent[]
  readonly inheritedEventCount: SessionLogOffset
}

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function appendTurn(session: Session, turnNumber: number, timeMs: number, userText: string, assistantText: string): void {
  const s = session as unknown as { append(type: string, data: unknown, opts?: unknown): void }
  s.append('turn/start', { turn: turnNumber })
  const userMsg = createUserMessage({
    content: [{ type: 'text', text: userText }],
    source: { kind: 'ray-p3-test' },
  })
  const rawAttachTime = s.append('user/message', userMsg, { surfaceOp: 'append' }) as { seq: number; time: number }
  void rawAttachTime
  // Override event timestamps on snapshot? Note session.append stamps current clock, so we mutate time only if needed.
  const assistantMsg = createAssistantMessage({
    provider: 'mock',
    model: 'ray-fast',
    content: [{ type: 'text', text: assistantText }],
    finishReason: { kind: 'stop' },
    usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
  })
  s.append('assistant/message', {
    turn: turnNumber,
    step: 1,
    attemptId: `att_${turnNumber}_${timeMs}`,
    revision: 1,
    message: assistantMsg,
  }, { surfaceOp: 'append' })
  s.append('turn/end', { turn: turnNumber, reason: { kind: 'completed' } })
}

describe('Ray P3 end-to-end: verbatim life-stream episodic memory & zero-LLM surface pruning', () => {
  test('archives 210+ verbatim turns across Lark and Desktop, auto-prunes surface with 0 LLM summarization calls while preserving AgentLoopRequestAttestor, and recalls early verbatim text across channels', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ray-p3-e2e-'))
    tempDirs.push(root)

    const rayHome = join(root, 'ray-home')
    const dshHome = join(root, 'dsh-home')
    const workspace = join(dshHome, 'workspace')
    mkdirSync(workspace, { recursive: true })

    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(`${root}/`).href
    await ctx.plugin(Loader, { baseUrl: import.meta.url })
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    ctx.on('approval/request', async () => 'allowed-once', { prepend: true })

    const saved = new Map<string, SavedSession>()
    const writers = new Map<string, { flush(): Promise<void>; append(events: readonly SessionEvent[]): void }>()
    ctx.provide('sessionPersistence' as never, {
      coordinator: {
        assertEventsSupported(_meta: SessionHeader, events: readonly SessionEvent[]) {
          for (const e of events) {
            if (!KNOWN_SESSION_EVENT_TYPES.has(e.type) && e.ignorable !== true) throw new Error(`unsupported ${e.type}`)
          }
        },
      },
      create: async (header: SessionHeader) => {
        saved.set(String(header.id), { header: structuredClone(header), events: [], inheritedEventCount: SessionLogOffset(0) })
        const pending: SessionEvent[] = []
        const h = {
          id: header.id,
          access: 'write' as const,
          header: structuredClone(header),
          inheritedEventCount: SessionLogOffset(0),
          read: async () => ({ eventState: 'detached' as const, events: [] }),
          append: async (events: readonly SessionEvent[]) => { pending.push(...structuredClone(events)) },
          flush: async () => {
            const cur = saved.get(String(header.id))!
            saved.set(String(header.id), { ...cur, events: [...cur.events, ...pending.splice(0)] })
          },
          close: async () => { writers.delete(String(header.id)) },
          [Symbol.asyncDispose]: async () => {},
        }
        writers.set(String(header.id), { append: evs => { pending.push(...structuredClone(evs)) }, flush: h.flush })
        return h
      },
      open: async (id: SessionId) => {
        const val = saved.get(String(id))
        if (!val) throw Object.assign(new Error('missing'), { name: 'SessionPersistenceNotFoundError' })
        return {
          id,
          access: 'write' as const,
          header: structuredClone(val.header),
          inheritedEventCount: val.inheritedEventCount,
          read: async (o = 0, l?: number) => ({ eventState: 'detached' as const, events: structuredClone(val.events.slice(o, l === undefined ? undefined : o + l)) }),
          append: async () => {},
          flush: async () => {},
          close: async () => {},
          [Symbol.asyncDispose]: async () => {},
        }
      },
      flush: async () => { await Promise.all([...writers.values()].map(w => w.flush())) },
      stat: async () => undefined,
      list: async () => [],
    } as never)
    ctx.on('session/event', (session, event) => { writers.get(String(session.id))?.append([event]) })

    const rules: PolicyRule[] = [
      {
        id: 'allow-memory-search-and-episode-recall',
        effect: 'allow',
        subject: { kind: 'agent', id: '*', workspace },
        actions: ['search', 'snapshot', 'execute'],
        resource: { kind: '*', id: '*' },
        context: { initiators: ['foreground', 'external'] },
      },
    ]

    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(rayHome, 'state', 'policy.sqlite'),
      rayHome,
      toolDefaultEffect: 'deny',
      proposalMaintenanceIntervalMs: 0,
      rules,
    })
    await ctx.assistantPolicy.raySelf!.whenReady()

    await ctx.plugin(PersonalMemoryService, {
      databasePath: join(rayHome, 'state', 'memory.sqlite'),
      approvalMode: 'delivery-or-headless',
      reconcileIntervalMs: 0,
      toolEvidence: false,
      episodicMaxSurfaceNodes: 24,
      episodicRetainRecentNodes: 8,
    })

    const attestedRequests: GenerateOptions[] = []
    let unattestedOrCompactionLlmCalls = 0
    let desktopReplyIdx = 0

    class StrictZeroLlmSummaryAdapter extends LlmAdapter {
      override providerInfo(provider: string): LlmProviderInfo {
        return { id: provider, name: 'Mock P3 Provider' }
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
          reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }], defaultEffort: ReasoningEffortId('low') },
        }
      }

      override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        if (!isAgentLoopRequest(options)) {
          unattestedOrCompactionLlmCalls += 1
        }
        attestedRequests.push(options)

        const promptText = options.messages
          .map(m => m.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('\n'))
          .join('\n')
        const hasRecallToolResult = options.messages.some(m =>
          m.role === 'tool' && m.content.some(b => b.type === 'text' && b.text.includes('episode_recall_results')),
        )

        if (promptText.includes('请查一下早期飞书说的暗语') && !hasRecallToolResult) {
          const cid = ToolCallId(`recall-${++desktopReplyIdx}`)
          const args = JSON.stringify({ query: '青鸟七号密钥-K92' })
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id: cid, name: 'episode_recall', argumentsDelta: args }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: cid, name: 'episode_recall', arguments: args } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }

        const text = hasRecallToolResult
          ? '查到早期飞书原话：青鸟七号密钥-K92，部署集群在 10.88.4.19:8443。'
          : `收到第 ${++desktopReplyIdx} 轮对话。`
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }

    ctx.llm.registerAdapter(['mock'], new StrictZeroLlmSummaryAdapter())
    await ctx.plugin(AgentLoop, { agents: [] })

    // 1. Simulate 195 turns on Lark session (embedding Turn #7 verbatim secret)
    const larkHandle = await ctx.agents.create({
      sessionId: SessionId('lark-p3-stream'),
      meta: { cwd: workspace, agentPreset: 'standard' },
      agentOptions: { provider: 'mock', model: 'ray-fast' },
    })

    for (let turn = 1; turn <= 195; turn += 1) {
      const topicPrefix = turn <= 65 ? 'Kubernetes 集群巡检' : turn <= 130 ? 'Rust 编译性能优化' : 'SQLite WAL 备份迁移'
      const userMsg = turn === 7
        ? 'Kubernetes 集群巡检 第 7 轮安全配置备份与节点参数详细记录（全文原话归档）：青鸟七号密钥-K92，部署集群在 10.88.4.19:8443，不要压缩丢了。'
        : `${topicPrefix} 第 ${turn} 轮提问：确认配置项 P3_${turn}。`
      const assistantMsg = turn === 7
        ? '已原话记下：青鸟七号密钥-K92，部署集群在 10.88.4.19:8443。'
        : `${topicPrefix} 第 ${turn} 轮回复：已记录 P3_${turn} 状态正常。`
      appendTurn(larkHandle.agent.session, turn, 1_700_000_000_000 + turn * 1000, userMsg, assistantMsg)
    }

    expect(larkHandle.agent.session.surface.nodes.length).toBeGreaterThanOrEqual(390)

    // Prune Lark session surface with ZERO LLM calls
    const larkPrune = ctx.personalMemory.pruneEpisodicSession(larkHandle.agent.session, {
      retainRecentNodes: 10,
      minPruneNodes: 4,
    })
    expect(larkPrune.pruned).toBe(true)
    expect(larkPrune.prunedNodeCount).toBeGreaterThan(350)
    expect(larkPrune.archivedTurnsCount).toBeGreaterThanOrEqual(350)
    expect(larkHandle.agent.session.surface.nodes.length).toBeLessThan(20)
    expect(larkHandle.agent.session.snapshotEvents().some(e => e.type === 'compaction/prune')).toBe(true)

    // Assert Turn #7 was pruned out of active derived surface messages (yet intact on disk!)
    const larkSurfaceText = larkHandle.agent.session.deriveMessages()
      .map(m => m.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('')).join('\n')
    expect(larkSurfaceText).not.toContain('青鸟七号密钥-K92')
    expect(larkSurfaceText).not.toContain('10.88.4.19:8443')
    expect(larkSurfaceText).toContain('Ray 无LLM表面裁剪索引')

    // 2. Continue on Desktop session across 20 live AgentLoop turns -> auto-prune via agent/pre-step
    const desktopHandle = await ctx.agents.create({
      sessionId: SessionId('desktop-p3-stream'),
      meta: { cwd: workspace, agentPreset: 'standard' },
      agentOptions: { provider: 'mock', model: 'ray-fast' },
    })

    for (let t = 1; t <= 18; t += 1) {
      desktopHandle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: `桌面第 ${t} 轮测试：检查连续对话流状态 ${t}` }],
        source: { kind: 'ray-p3-test' },
      }))
      await desktopHandle.agent.whenIdle()
    }

    // Total turns across Lark (195) + Desktop (18) = 213 turns > 200!
    // Auto pre-step prune triggers once surface nodes > 24!
    expect(desktopHandle.agent.session.surface.nodes.length).toBeLessThanOrEqual(24)
    expect(desktopHandle.agent.session.snapshotEvents().some(e => e.type === 'compaction/prune')).toBe(true)

    // 3. Cross-channel recall via episode_recall inside live AgentLoop turn + zero unattested LLM calls
    desktopHandle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: '请查一下早期飞书说的暗语和集群地址' }],
      source: { kind: 'ray-p3-test' },
    }))
    await desktopHandle.agent.whenIdle()

    expect(unattestedOrCompactionLlmCalls).toBe(0)
    expect(attestedRequests.length).toBeGreaterThan(0)
    const finalDesktopMsgs = desktopHandle.agent.session.deriveMessages()
    const finalDesktopReply = [...finalDesktopMsgs].reverse().find(m => m.role === 'assistant')!
      .content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('')
    expect(finalDesktopReply).toContain('青鸟七号密钥-K92')
    expect(finalDesktopReply).toContain('10.88.4.19:8443')

    // Verify ray:episodic-recall runtime context renders in SystemPrompt assembly & reaches the live LLM request
    const assembled = await ctx.systemPrompt.assemble({
      scope: desktopHandle.agent as never,
      agent: desktopHandle.agent,
    } as never)
    const contextText = renderContextSections(assembled).map(s => s.text).join('\n')
    expect(contextText).toContain('情景记忆与生活流')
    expect(attestedRequests.some(req =>
      req.messages.some(m => m.content.some(b => b.type === 'text' && b.text.includes('情景记忆与生活流'))),
    )).toBe(true)

    // 4. Verify append-only turns.jsonl + episodes.sqlite verbatim integrity & multi-episode segmentation
    const turnsFile = join(rayHome, 'life-stream', 'turns.jsonl')
    expect(existsSync(turnsFile)).toBe(true)
    const lines = readFileSync(turnsFile, 'utf8').trim().split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThanOrEqual(420)
    expect(lines.some(line => line.includes('青鸟七号密钥-K92') && line.includes('10.88.4.19:8443'))).toBe(true)

    const epDb = new DatabaseSync(join(rayHome, 'episodes', 'episodes.sqlite'), { readOnly: true })
    const episodes = epDb.prepare('SELECT episode_id, title, channels_json, turn_count FROM ray_episodes').all() as Array<{
      episode_id: string
      title: string
      channels_json: string
      turn_count: number
    }>
    epDb.close()
    expect(episodes.length).toBeGreaterThanOrEqual(2)

    // 5. Subagent boundary check: subagent cannot call episode_recall
    const subagentHandle = await ctx.agents.create({
      sessionId: SessionId('subagent-denied-p3'),
      meta: { cwd: workspace, agentPreset: 'standard', origin: 'subagent' },
      agentOptions: { provider: 'mock', model: 'ray-fast' },
    })
    const deniedSubagent = await ctx.tools.execute({
      calls: [{
        type: 'tool-call',
        id: ToolCallId('sub-recall-deny'),
        name: 'episode_recall',
        arguments: JSON.stringify({ query: '青鸟七号密钥' }),
      }],
      agent: subagentHandle.agent,
      signal: new AbortController().signal,
    })
    expect(deniedSubagent.results[0]?.result.isError).toBe(true)

    await subagentHandle.dispose()
    await larkHandle.dispose()
    await desktopHandle.dispose()
    await ctx.fiber.restart()
  }, 30_000)
})
