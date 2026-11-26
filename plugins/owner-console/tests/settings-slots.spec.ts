// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BundleConfigSlotView, GeneralCodingToolItem, ModelsCodingAgentsFooter,
  WenyaoSectionIcon, WenyaoSettingsSection, type ConsoleRemote,
} from '../src/client.ts'
import type { CodingToolProbe, OwnerConsoleAssistantOverview, OwnerConsoleStatus } from '../src/typert.ts'

function makeRemote() {
  let defaultProvider = 'traex-agent'
  const buildStatus = (): OwnerConsoleStatus => ({
    feishu: { mode: 'env', installed: true, entry: 'dsh-ray-lark-channel', enabled: true, appIdConfigured: true, connected: true, connection: 'connected' },
    traex: { entry: 'dsh-ray-traex-acp-provider', installed: true, enabled: true, command: 'traex' },
    agy: { entry: 'dsh-ray-traex-acp-provider', installed: true, enabled: false, command: 'agy' },
    defaultModel: { entry: 'agent-default-model', available: true, provider: defaultProvider, model: 'default' },
    llmProviders: [
      { id: 'traex-agent', name: 'TraeX Agent' },
      { id: 'agy-agent', name: 'Antigravity Agent' },
      { id: 'deepseek-official', name: 'DeepSeek 官方' },
    ],
    host: { settings: true, pluginManager: true, bundles: 'ok', plugins: 'ok' },
    dependencies: [
      { name: 'assistantPolicy', available: true },
      { name: 'assistantDelivery', available: true },
      { name: 'assistantSkills', available: true },
    ],
    evaluation: { intakeAgreement: 'available' },
    bundles: [
      { name: '@dsh-ray/traex-acp-provider', version: '0.1.73', enabled: true, installed: true, removable: true, rows: [] },
      { name: '@dsh-ray/assistant-dreaming', version: '0.1.73', enabled: true, installed: true, removable: true, rows: [] },
    ],
    plugins: [
      { entryId: 'dsh-ray-traex-acp-provider', moduleName: '@dsh-ray/traex-acp-provider', enabled: true, fiberPhase: 'active' },
    ],
  })
  const overview: OwnerConsoleAssistantOverview = {
    resolvedScope: { workspace: '/ws/ray', preset: 'standard' },
    dreaming: {
      state: 'ok',
      health: { enabled: true, scheduler: 'active', lastRunAt: 1_000, lastRunOutcome: 'succeeded', runs: 2, ideas: 1, recorded: 1 },
      ideas: [{ id: 'idea-1', runId: 'r-1', createdAt: 1_000, dayKey: '2026-11-17', state: 'recorded', summary: '自动整理 PR 变更', detail: '根据近 5 次工作项汇总', evidenceCount: 2 }],
      canAcknowledge: true,
      canValidate: true,
      canReject: true,
      canRetire: true,
      missingPrerequisites: [],
    },
    proactive: {
      state: 'ok',
      profileCount: 1,
      intakeEvaluation: { enabled: true, registered: true, callsLastHour: 3, consecutiveFailures: 0 },
      canResolveDraft: true,
      drafts: [{ id: 'draft-1', goalId: 'goal-1', objective: '整理发布清单', state: 'draft', updatedAt: 2_000, outputPreview: '草稿内容预览', verified: false }],
      attentionQuestions: [{
        questionId: 'q-1', cohortLane: 'owner-notification', cohortSourceId: 'assistant-proactive/v1',
        workspace: '/ws/ray', preset: 'standard', open: true, actionable: true,
        deliveryStatus: 'queued', recordedAt: 3_000, questionSummary: 'minimumUtilityDelta: 10 → 5',
      }],
    },
    workItems: {
      state: 'ok',
      health: {
        enabled: true, mode: 'observe', openItems: 1, workerConnected: true, ownerRouteValid: true,
        evaluationPending: 0, admitMode: 'observe', hasAcceptanceObjective: true, pendingAdmissions: 0,
      },
      queue: [{ id: 'evt-1', entryKind: 'admission', source: 'lark-channel', outcome: 'would-admit', observeReason: 'configured-observe', recordedAt: 4_000 }],
    },
    memoryLearning: {
      state: 'ok',
      health: { enabled: true, connected: true, available: true, remainingExtractions: 8, counts: { adopted: 3, queued: 1, rejected: 0 } },
    },
    growthDriver: {
      state: 'ok',
      health: {
        enabled: true, outcome: 'ran', lastWakeAt: 5_000, reason: 'succeeded',
        usageEnabled: true, usageConnected: true, usageCounts: { reviewed: 2 },
        dreamingIntake: { enabled: true, considered: 1, ingested: 1, rejectedUnvalidated: 0 },
      },
      proposals: [],
    },
  }

  const setDefaultModelRoute = vi.fn(async (provider: string, model: string) => {
    defaultProvider = provider
    return { ok: true as const, value: { applied: true, entry: 'agent-default-model', note: `已切换到 ${provider}/${model}` } }
  })
  const probeCodingTool = vi.fn(async (tool: 'traex' | 'agy'): Promise<{ ok: true; value: CodingToolProbe }> => ({
    ok: true as const,
    value: {
      tool, command: tool, installed: true, binaryFound: true, loggedIn: true, enabled: true,
      routeRegistered: true, ready: true, state: 'ready', summary: `${tool} 已就绪`, modelCount: tool === 'agy' ? 9 : undefined,
      checkedAt: 1_000, cached: false,
    },
  }))
  const actDreamingIdea = vi.fn(async (ideaId: string, action: string) => ({
    ok: true as const, value: { applied: true, entry: 'dsh-ray-assistant-dreaming', note: `${ideaId}:${action}` },
  }))
  const actAttentionQuestion = vi.fn(async (_w: string, _p: string, _l: string, _s: string, qid: string, choice: string) => ({
    ok: true as const, value: { applied: true, entry: 'dsh-ray-assistant-proactive', note: `${qid}:${choice}` },
  }))
  const actProactiveDraft = vi.fn(async (id: string, action: string) => ({
    ok: true as const, value: { applied: true, entry: 'dsh-ray-assistant-proactive', note: `${id}:${action}` },
  }))

  const remote: ConsoleRemote = {
    status: vi.fn(async () => ({ ok: true as const, value: buildStatus() })),
    trendSnapshots: vi.fn(async () => ({ ok: true as const, value: { state: 'ok' as const, causal: false as const, items: [] } })),
    intakeAgreement: vi.fn(async () => ({ ok: true as const, value: { state: 'disabled' as const, causal: false as const } })),
    intakeAgreementHistory: vi.fn(async () => ({ ok: true as const, value: { state: 'disabled' as const, causal: false as const } })),
    configureFeishu: vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'lark', note: 'ok' } })),
    configureTraex: vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'traex', note: 'ok' } })),
    configureAgy: vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'traex', note: 'ok' } })),
    probeCodingTool,
    setDefaultModelRoute,
    assistantOverview: vi.fn(async () => ({ ok: true as const, value: overview })),
    actDreamingIdea,
    actAttentionQuestion,
    actProactiveDraft,
    configureBundle: vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'b', note: 'ok' } })),
    setBundleEnabled: vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'b', note: 'ok' } })),
    setPluginEnabled: vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'p', note: 'ok' } })),
    installProjectBundle: vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'i', note: 'ok' } })),
    removeProjectBundle: vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'r', note: 'ok' } })),
  }
  return { remote, setDefaultModelRoute, probeCodingTool, actDreamingIdea, actAttentionQuestion, actProactiveDraft }
}

describe('owner console upstream DSH settings slot components', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    container.remove()
  })

  it('renders WenyaoSettingsSection, closes modal before navigation, and dispatches Dreaming/Proactive/WP22 actions', async () => {
    const { remote, actDreamingIdea, actAttentionQuestion, actProactiveDraft } = makeRemote()
    const navigation = { openConversation: vi.fn(), openPlugins: vi.fn() }
    const close = vi.fn()

    await act(async () => {
      root.render(createElement(WenyaoSettingsSection, { remote, navigation, close }))
    })
    await act(async () => { await Promise.resolve() })

    expect(container.textContent).toContain('文鳐 Ray 助手设置')
    expect(container.textContent).toContain('自动整理 PR 变更')
    expect(container.textContent).toContain('整理发布清单')
    expect(container.textContent).toContain('minimumUtilityDelta: 10 → 5')
    expect(container.textContent).toContain('would-admit')
    expect(container.textContent).toContain('Dreaming 想法输入')

    const clickButton = async (label: string) => {
      const btn = [...container.querySelectorAll('button')].find(b => b.textContent === label)
      expect(btn).toBeDefined()
      await act(async () => { btn!.click() })
      await act(async () => { await Promise.resolve() })
    }

    await clickButton('已阅确认')
    expect(actDreamingIdea).toHaveBeenCalledWith('idea-1', 'acknowledge', 'owner-acknowledged')

    await clickButton('验证通过')
    expect(actDreamingIdea).toHaveBeenCalledWith('idea-1', 'validate', 'owner-validated')

    await clickButton('仅本次授权')
    expect(actAttentionQuestion).toHaveBeenCalledWith('/ws/ray', 'standard', 'owner-notification', 'assistant-proactive/v1', 'q-1', 'authorize-once')

    await clickButton('接受草稿')
    expect(actProactiveDraft).toHaveBeenCalledWith('draft-1', 'accept', '/ws/ray', 'standard')

    await clickButton('开始对话')
    expect(close).toHaveBeenCalledOnce()
    expect(navigation.openConversation).toHaveBeenCalledOnce()
  })

  it('renders GeneralCodingToolItem, ModelsCodingAgentsFooter, WenyaoSectionIcon, and all 6 plugins.bundle.config cards', async () => {
    const { remote, setDefaultModelRoute, probeCodingTool } = makeRemote()
    const navigation = { openConversation: vi.fn(), openPlugins: vi.fn() }

    await act(async () => {
      root.render(createElement('div', {},
        createElement(WenyaoSectionIcon, { size: 16, active: true }),
        createElement(GeneralCodingToolItem, { remote, navigation }),
        createElement(ModelsCodingAgentsFooter, { remote, navigation }),
      ))
    })
    await act(async () => { await Promise.resolve() })

    expect(container.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/webp;base64,/)
    expect(container.textContent).toContain('默认编程工具（TraeX / Antigravity）')
    expect(container.textContent).toContain('本地编程工具（ACP：TraeX / Antigravity）')

    const switchBtn = [...container.querySelectorAll('button')].find(b => b.textContent === '启用 Antigravity')
    expect(switchBtn).toBeDefined()
    await act(async () => { switchBtn!.click() })
    await act(async () => { await Promise.resolve() })
    expect(setDefaultModelRoute).toHaveBeenCalledWith('agy-agent', 'default', '')

    const probeBtn = [...container.querySelectorAll('button')].find(b => b.textContent === '探测就绪状态')
    expect(probeBtn).toBeDefined()
    await act(async () => { probeBtn!.click() })
    await act(async () => { await Promise.resolve() })
    expect(probeCodingTool).toHaveBeenCalledWith('traex', 'traex', true)
    expect(probeCodingTool).toHaveBeenCalledWith('agy', 'agy', true)

    const slugs = [
      '@dsh-ray/traex-acp-provider',
      '@dsh-ray/lark-channel',
      '@dsh-ray/assistant-proactive',
      '@dsh-ray/assistant-dreaming',
      '@dsh-ray/assistant-growth-driver',
      '@dsh-ray/assistant-memory-learning',
    ]
    for (const packageName of slugs) {
      await act(async () => {
        root.render(createElement(BundleConfigSlotView, { packageName, view: 'summary', remote, navigation }))
      })
      expect(container.textContent?.trim().length).toBeGreaterThan(0)
      await act(async () => {
        root.render(createElement(BundleConfigSlotView, { packageName, view: 'page', remote, navigation }))
      })
      await act(async () => { await Promise.resolve() })
      expect(container.querySelector(`[data-owner-console-bundle-config="${packageName}"]`)).not.toBeNull()
    }
  })
})
