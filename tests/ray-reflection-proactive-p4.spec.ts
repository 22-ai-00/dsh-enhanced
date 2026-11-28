import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  KNOWN_SESSION_EVENT_TYPES,
  SessionId,
  SessionLogOffset,
  type Session,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies } from '../plugins/assistant-delivery/node_modules/@deepseek-ai/dsh-agent-loop-testkit/lib/index.js'
import { renderContextSections } from '../plugins/assistant-policy/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { AssistantPolicyService } from '@dsh-ray/assistant-policy'
import { AssistantProactiveService } from '../plugins/assistant-proactive/lib/index.js'
import { parseLearningCommand, learningCommandUsage } from '../plugins/assistant-delivery/src/learning-command.ts'
import { tryBuildLarkCommandCard } from '../plugins/lark-channel/src/command-card.ts'
import { apply as applyOwnerConsole } from '../plugins/owner-console/lib/index.js'
import type { OwnerConsoleService } from '../plugins/owner-console/lib/service.js'
import TypertRegistry from '../plugins/owner-console/node_modules/@deepseek-ai/dsh-typert-registry/lib/index.js'
import { afterEach, describe, expect, test } from 'vitest'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'ray-p4-test': { kind: 'ray-p4-test' }
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

describe('Ray P4 end-to-end: Kernel energy ledger, 4-cadence reflection, aspirations, unified idea pool & growth panel', () => {
  test('enforces Kernel energy & write protection, bridges dreaming into 3-tier idea pool with reaction tuning, runs 4 reflections, and exposes /learning growth + console panel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ray-p4-e2e-'))
    tempDirs.push(root)
    const rayHome = join(root, 'ray-home')
    const workspace = join(root, 'workspace')
    mkdirSync(workspace, { recursive: true })

    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(`${root}/`).href
    await ctx.plugin(Loader, { baseUrl: import.meta.url })
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    await ctx.plugin(TypertRegistry)

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

    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(rayHome, 'state', 'policy.sqlite'),
      rayHome,
      toolDefaultEffect: 'allow',
    })
    const raySelf = ctx.assistantPolicy.raySelf!
    await raySelf.whenReady()

    // Mock assistantDreaming with onIdeaRecorded hook to verify dreaming -> idea pool bridge
    const recordedListeners = new Set<(idea: { id: string; summary: string; detail: string }) => void>()
    ctx.provide('assistantDreaming' as never, {
      onIdeaRecorded: (fn: (idea: { id: string; summary: string; detail: string }) => void) => {
        recordedListeners.add(fn)
        return () => { recordedListeners.delete(fn) }
      },
    } as never)

    await ctx.plugin(AssistantProactiveService, {
      databasePath: join(rayHome, 'state', 'proactive.sqlite'),
      profiles: [],
    })
    applyOwnerConsole(ctx, { feishuAppId: '' })

    const rayCog = ctx.assistantProactive.rayCognitiveRuntime()!
    expect(rayCog).toBeDefined()

    // 1. Reduce Kernel daily cap via owner-approved proposal so free-energy ceiling and wind-down trigger cleanly
    const prop = raySelf.proposeKernelChange({
      section: 'energy',
      summary: '测试阶段调整每日精力上限与自由精力占比',
      patch: { dailyTokenCap: 10_000, freeEnergyRatioBp: 2_000 },
      reason: 'P4 测试验证 20% 自由精力分配与 wind-down',
    })
    raySelf.applyOwnerKernelDecision(prop.proposalId, 'approved', 'owner:p4:test')
    expect(raySelf.snapshot().kernel.energy.dailyTokenCap).toBe(10_000)

    // Protect <rayHome>/energy/energy.sqlite from direct agent tool/shell writes
    const deniedWrite = raySelf.inspectToolExecutionForKernel({
      name: 'write_file',
      arguments: { path: join(rayHome, 'energy', 'energy.sqlite'), content: 'corrupt' },
      agent: undefined,
    } as never)
    expect(deniedWrite).toContain('RAY_KERNEL_WRITE_DENIED')
    const deniedBash = raySelf.inspectToolExecutionForKernel({
      name: 'bash',
      arguments: { command: `sqlite3 ${join(rayHome, 'energy', 'energy.sqlite')} "DELETE FROM ray_energy_daily;"` },
      agent: undefined,
    } as never)
    expect(deniedBash).toContain('RAY_KERNEL_WRITE_DENIED')

    // 2. Verify Dreaming -> Unified Idea Pool ingestion (Tier 1: silent_explore consumes free energy)
    for (const fn of recordedListeners) {
      fn({
        id: 'dream-p4-1',
        summary: '梳理 SQLite WAL 备份自动化脚手架草稿',
        detail: '结合早期情景记忆调研增量 VACUUM INTO 与校验流程（仅内部草稿）',
      })
    }
    const pooledAfterDream = ctx.assistantProactive.rayListIdeas({ limit: 10 })
    const dreamIdea = pooledAfterDream.find(i => i.ideaId === 'dream-dream-p4-1')
    expect(dreamIdea).toBeDefined()
    expect(dreamIdea!.source).toBe('dreaming')
    expect(dreamIdea!.tier).toBe('silent_explore')
    expect(dreamIdea!.status).toBe('explored')
    expect(dreamIdea!.explorationNote).toContain('静默探索')

    // 3. Tier 2 (natural_mention) + Tier 3 (propose_work external-effect gate) + owner reaction tuning
    raySelf.evolveSelfModel({
      interests: [
        { id: 'int-rust', topic: 'Rust 异步运行时性能分析与调优', weight: 0.9, lastActiveAt: Date.now(), source: 'conversation' },
        { id: 'int-stale', topic: '十天前未再聊起的冷门工具', weight: 0.5, lastActiveAt: Date.now() - 10 * 86_400_000, source: 'conversation' },
      ],
      reason: '初始化兴趣分布以验证点子匹配与衰减',
    })

    const mentionIngest = ctx.assistantProactive.rayIngestIdea({
      ideaId: 'idea-rust-bench',
      source: 'conversation',
      title: 'Rust async channel benchmark 对比记录',
      summary: '刚刚联想到一个 Rust 异步运行时 benchmark 对比点，可顺口提及供下次参考。',
      topic: 'Rust 异步运行时性能',
      ownerValueHint: 0.65,
      autoExplore: false,
    })!
    expect(mentionIngest.idea.tier).toBe('natural_mention')

    const externalIngest = ctx.assistantProactive.rayIngestIdea({
      ideaId: 'idea-send-pr',
      source: 'event',
      title: '向远程仓库推送重构 PR',
      summary: '涉及外部 GitHub 副作用，必须先征求 owner 明确同意才能开工',
      topic: '外部 GitHub PR 推送',
      requiresExternalEffect: true,
      autoExplore: false,
    })!
    expect(externalIngest.idea.tier).toBe('propose_work')
    expect(ctx.assistantProactive.raySurfaceNaturalMention('准备提 PR', externalIngest.idea.ideaId)?.reason)
      .toBe('propose-work-requires-explicit-owner-consent')

    // Assemble runtime context on active conversation mentioning Rust -> ray:proactive-mentions surfaces mention!
    const fakeSession = ctx.sessions.create(SessionId('desktop-p4-main'), {
      meta: { cwd: workspace, agentPreset: 'standard' },
    })
    ;(fakeSession as unknown as { append(t: string, d: unknown, o?: unknown): void }).append('user/message', createUserMessage({
      content: [{ type: 'text', text: '我们看看 Rust 异步运行时性能还有哪些瓶颈？' }],
      source: { kind: 'ray-p4-test' },
    }), { surfaceOp: 'append' })
    const fakeAgent = { id: 'lead', session: fakeSession }
    const assembled = await ctx.systemPrompt.assemble({ scope: fakeAgent as never, agent: fakeAgent as never } as never)
    const contextText = renderContextSections(assembled).map(s => s.text).join('\n')
    expect(contextText).toContain('可顺口提及的联想点子')
    expect(contextText).toContain('idea-rust-bench')

    const surfaced = ctx.assistantProactive.raySurfaceNaturalMention('Rust 异步运行时性能', 'idea-rust-bench')!
    expect(surfaced.surfaced).toBe(true)

    const initialWeight = raySelf.snapshot().selfModel.interests.find(i => i.id === 'int-rust')!.weight
    const reactAcc = ctx.assistantProactive.rayRecordIdeaReaction('idea-rust-bench', 'accepted')!
    const boostedWeight = raySelf.snapshot().selfModel.interests.find(i => i.id === 'int-rust')!.weight
    expect(boostedWeight).toBeGreaterThanOrEqual(initialWeight)
    const capBeforeAnnoyed = reactAcc.tuning.dailyNaturalMentionCap
    const threshBeforeAnnoyed = reactAcc.tuning.naturalMentionThreshold

    const annoyedIngest = ctx.assistantProactive.rayIngestIdea({
      ideaId: 'idea-annoyed-1',
      source: 'web-learning',
      title: '顺口打扰测试点子',
      summary: '测试 owner 表示嫌烦后的兴趣衰减与阈值上调',
      topic: 'Rust 异步运行时性能',
      ownerValueHint: 0.7,
      autoExplore: false,
    })!
    const reactAnnoyed = ctx.assistantProactive.rayRecordIdeaReaction(annoyedIngest.idea.ideaId, 'annoyed')!
    expect(reactAnnoyed.tuning.naturalMentionThreshold).toBeGreaterThan(threshBeforeAnnoyed)
    expect(reactAnnoyed.tuning.dailyNaturalMentionCap).toBeLessThanOrEqual(capBeforeAnnoyed)
    expect(raySelf.snapshot().selfModel.interests.find(i => i.id === 'int-rust')!.weight).toBeLessThan(boostedWeight)

    // 4. Record objective growth events & candidate triple, run all 4 reflection cadences
    raySelf.recordGrowthEvent({ category: 'owner-task', metricKey: 'p4-task', value: 10 })
    raySelf.recordGrowthEvent({ category: 'owner-correction', metricKey: 'p4-corr', value: 1 })
    raySelf.recordGrowthEvent({ category: 'verified-pass', metricKey: 'p4-pass', value: 8 })
    raySelf.recordGrowthEvent({ category: 'newly-regressed', metricKey: 'p4-reg', value: 1 })
    raySelf.recordGrowthEvent({ category: 'persistent-gap', metricKey: 'p4-gap', value: 3 })
    raySelf.recordGrowthEvent({ category: 'capability-invocation', metricKey: 'p4-cap', value: 5 })
    ctx.assistantProactive.rayRecordCandidateOutcome({
      candidateId: 'cand-p4-demo',
      kind: 'skill',
      rootCause: '缺少离线重放前的幂等校验',
      predictedImpact: '降低重复调用失败率 30%',
      observedOutcome: '实测 5 次零重复错误',
      supplier: 'mock/ray-fast',
      disposition: 'adopted',
    })

    const r1 = ctx.assistantProactive.rayRunReflection('aftertaste', { tokens: 200, seedTopics: ['增量索引优化'] })!
    const r2 = ctx.assistantProactive.rayRunReflection('daily-diary', { tokens: 200 })!
    const r3 = ctx.assistantProactive.rayRunReflection('weekly-review', { tokens: 200 })!
    const r4 = ctx.assistantProactive.rayRunReflection('stage-review', {
      tokens: 200,
      completedGoalIds: ['goal-p1-home'],
    })!
    expect(r1.ok && r2.ok && r3.ok && r4.ok).toBe(true)
    expect(existsSync(join(rayHome, 'reflections', 'weekly-review.jsonl'))).toBe(true)
    expect(readFileSync(join(rayHome, 'reflections', 'weekly-review.jsonl'), 'utf8')).toContain('优先修复新伤退化 1 项（固有缺口 3 项）')
    const activeGoalsAfterStage = raySelf.snapshot().selfModel.stageGoals.filter(g => g.status === 'active')
    expect(activeGoalsAfterStage.length).toBeGreaterThanOrEqual(2)
    expect(activeGoalsAfterStage.length).toBeLessThanOrEqual(4)
    expect(raySelf.snapshot().selfModel.interests.find(i => i.id === 'int-stale')!.weight).toBeLessThan(0.5)

    // 5. Exhaust free energy & verify wind-down blocks reflection while owner work stays unblocked
    raySelf.energy.consumeOwnerEnergy(8_600, 'owner:p4-heavy-turn') // hits >85% of 10,000 cap -> windDown!
    expect(raySelf.energySnapshot().windDown).toBe(true)
    expect(raySelf.energy.checkOwnerEnergyBudget(1_000).allowed).toBe(true)
    const skippedRefl = ctx.assistantProactive.rayRunReflection('daily-diary', { tokens: 100 })!
    expect(skippedRefl.skipped).toBe(true)

    // 6. Verify /learning growth grammar (leaving legacy /learning help unchanged), Card 2.0, and owner-console rayGrowthReport RPC
    expect(parseLearningCommand(' growth')).toEqual({ kind: 'growth' })
    expect(learningCommandUsage).not.toContain('growth') // preserves strict existing /learning help assertions

    const consoleService = ctx.get('ownerConsole' as never) as unknown as OwnerConsoleService
    const consoleGrowth = await consoleService.rayGrowthReport()
    expect(consoleGrowth.active).toBe(true)
    expect(consoleGrowth.ownerService?.newlyRegressedCount).toBe(1)
    expect(consoleGrowth.ownerService?.persistentGapCount).toBe(3)
    expect(consoleGrowth.proactiveValue?.selfCapabilityInvocations).toBe(5)
    expect(consoleGrowth.selfGoals?.trustLevel).toBe('low-self-reported')

    const growthCard = tryBuildLarkCommandCard([
      `Ray 独立成长度量报告（身体内核不可篡改口径 · ${consoleGrowth.energy!.dayKey}）：`,
      `【服务 Owner 指标】任务=10｜纠正=1`,
      `【退化与缺口】新伤退化 (newly_regressed)=1｜固有缺口 (persistent_gap)=3`,
    ].join('\n'))
    expect(growthCard).toBeDefined()
    expect(growthCard!.title).toBe('Ray 独立成长度量报告')

    // 7. Tool authorization & subagent boundary check for ray_idea_pool & ray_reflect
    raySelf.setSessionRole('desktop-p4-main', 'front-consciousness')
    const signal = new AbortController().signal
    const leadToolSet = await ctx.tools.resolve({
      agent: fakeAgent as never,
      modelSelection: { provider: 'mock', model: 'ray-fast' } as never,
      signal,
    })
    expect(leadToolSet.view(fakeAgent as never).has('ray_idea_pool')).toBe(true)
    expect(leadToolSet.view(fakeAgent as never).has('ray_reflect')).toBe(true)
    const allowedToolCall = await ctx.tools.execute({
      calls: [{
        type: 'tool-call',
        id: ToolCallId('lead-p4-pool'),
        name: 'ray_idea_pool',
        arguments: JSON.stringify({ action: 'list', limit: 5 }),
      }],
      agent: fakeAgent as never,
      toolSet: leadToolSet,
      signal,
    })
    expect(allowedToolCall.results[0]?.result.isError, JSON.stringify(allowedToolCall.results[0])).toBeFalsy()

    const subSession = ctx.sessions.create(SessionId('subagent-p4-deny'), {
      meta: { cwd: workspace, agentPreset: 'standard', origin: 'subagent' },
    })
    const subAgent = { id: 'sub', session: subSession as Session }
    const subToolSet = await ctx.tools.resolve({
      agent: subAgent as never,
      modelSelection: { provider: 'mock', model: 'ray-fast' } as never,
      signal,
    })
    expect(subToolSet.view(subAgent as never).has('ray_reflect')).toBe(false)
    const subDenied = await ctx.tools.execute({
      calls: [{
        type: 'tool-call',
        id: ToolCallId('sub-p4-deny'),
        name: 'ray_reflect',
        arguments: JSON.stringify({ cadence: 'daily-diary' }),
      }],
      agent: subAgent as never,
      toolSet: subToolSet,
      signal,
    })
    expect(subDenied.results[0]?.result.isError).toBe(true)
  })
})
