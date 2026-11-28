// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkScopedDbPath } from '../src/autonomy-setup.ts'
import { OwnerConsoleService } from '../src/service.ts'
import { RaySelfPanelCard, type ConsoleController, type ConsoleRemote } from '../src/settings-cards.ts'
import { TYPERT } from '../src/typert.ts'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('owner-console Ray Self integration & path fences', () => {
  it('registers typert descriptors and delegates Desktop prompt injection when assistantPolicy.raySelf is active', async () => {
    const names = TYPERT.invocations.map(m => m.method)
    expect(names).toContain('raySelfSnapshot')
    expect(names).toContain('vetoRaySelf')
    expect(names).toContain('decideRayKernelProposal')
    expect(names).toContain('importRayHome')
    expect(names).toContain('rayWorkerTickets')

    const dshHome = mkdtempSync(join(tmpdir(), 'oc-ray-dsh-'))
    const rayHome = mkdtempSync(join(tmpdir(), 'oc-ray-home-'))
    tempDirs.push(dshHome, rayHome)

    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.provide('typert' as never, { register: () => () => {} } as never)
    ctx.provide('profileContext' as never, { home: dshHome, name: 'desktop', dir: join(dshHome, 'profiles', 'desktop') } as never)
    ctx.provide('assistantPolicy' as never, {
      rayHomeDir: () => rayHome,
      raySelf: {
        snapshot: () => ({
          rayHome,
          kernel: { energy: { dailyTokenCap: 500_000, freeEnergyRatioBp: 2000 } },
          proposals: [],
          selfModel: {
            rayId: 'ray-1',
            version: 1,
            name: '文鳐',
            aliases: ['Ray', '小鳐'],
            selfSummary: '首次启动的自述',
            values: ['owner优先'],
            ideals: [{ id: 'ideal-1', title: '诚实', narrative: '永远向 owner 呈报真实证据' }],
            stageGoals: [{ id: 'g1', title: '建家', completionCriteria: '完成 P1', status: 'active' as const }],
            interests: [{ id: 'i1', topic: '架构', weight: 0.8, lastActiveAt: 1 }],
          },
          recentAutobiography: [{
            entryId: 'e1',
            timestamp: 1,
            kind: 'bootstrap',
            summary: '首次苏醒',
            reason: 'first-boot',
          }],
          missingCredentials: [],
        }),
        vetoByOwner: async () => ({
          ok: true,
          vetoedEntryId: 'e2',
          selfModel: { name: '文鳐' },
          autobiographyEntry: { summary: 'Owner 否决生效' },
        }),
        applyOwnerKernelDecision: (proposalId: string, decision: 'approved' | 'rejected') => ({
          proposal: { proposalId, summary: '调整自由精力', status: decision },
        }),
        importClone: (_sourceDir: string) => ({
          ok: true as const,
          name: '文鳐',
          importedFiles: 4,
          missingCredentials: [{ id: 'feishu-secret', service: 'feishu', label: '飞书密钥', required: true }],
        }),
      },
    } as never)

    const svc = new OwnerConsoleService(ctx, { feishuAppId: '' })
    await svc.registerAssistantSession('desktop-session-1', true)
    expect(svc.ownsAssistantSession('desktop-session-1')).toBe(true)
    expect(svc.ownsAssistantSession('other-session')).toBe(false)

    // When raySelf is active, owner-console suppresses its duplicate wenyao persona section
    await new Promise(resolve => setTimeout(resolve, 10))
    const session = Session.create(SessionId('desktop-session-1'), [], {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('desktop-session-1'),
      createdAt: 1,
      isSeeded: false,
      cwd: dshHome,
      agentPreset: 'standard',
    })
    const assembly = await ctx.systemPrompt.assemble({ scope: { id: session.id, session } as never })
    expect(renderPrompt(assembly)).not.toContain('owner-console:wenyao-persona')

    const snap = await svc.raySelfSnapshot()
    expect(snap.active).toBe(true)
    expect(snap.selfModel?.name).toBe('文鳐')
    expect(snap.selfModel?.ideals).toHaveLength(1)

    const vetoRes = await svc.vetoRaySelf('', '', '恢复原名')
    expect(vetoRes.applied).toBe(true)

    const proposalRes = await svc.decideRayKernelProposal('prop-1', 'approved')
    expect(proposalRes.applied).toBe(true)

    const importRes = await svc.importRayHome(rayHome)
    expect(importRes.applied).toBe(true)
    expect(importRes.note).toContain('飞书密钥')

    await ctx.fiber.restart()
  })

  it('allows configured Ray Home DB paths while blocking unconfigured external DB escapes', () => {
    const root = mkdtempSync(join(tmpdir(), 'oc-fence-'))
    tempDirs.push(root)
    const dshHome = join(root, 'dsh')
    const rayHome = join(root, 'external-disk', 'ray')
    const rogueDir = join(root, 'rogue')
    mkdirSync(join(dshHome, 'profiles', 'desktop'), { recursive: true })
    mkdirSync(join(rayHome, 'state'), { recursive: true })
    mkdirSync(rogueDir, { recursive: true })

    const insideRay = checkScopedDbPath(join(rayHome, 'state', 'memory.sqlite'), dshHome, rayHome)
    expect(insideRay.scoped).toBe(true)

    const outsideBoth = checkScopedDbPath(join(rogueDir, 'leak.sqlite'), dshHome, rayHome)
    expect(outsideBoth.scoped).toBe(false)
  })

  it('renders RaySelfPanelCard with ideals, stage goals, proposals, and veto controls', async () => {
    ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const vetoCalls: string[] = []
    const remote: ConsoleRemote = {
      status: async () => ({ ok: false }),
      trendSnapshots: async () => ({ ok: false }),
      intakeAgreement: async () => ({ ok: false }),
      intakeAgreementHistory: async () => ({ ok: false }),
      configureFeishu: async () => ({ ok: false }),
      configureTraex: async () => ({ ok: false }),
      configureBundle: async () => ({ ok: false }),
      setBundleEnabled: async () => ({ ok: false }),
      setPluginEnabled: async () => ({ ok: false }),
      installProjectBundle: async () => ({ ok: false }),
      removeProjectBundle: async () => ({ ok: false }),
      raySelfSnapshot: async () => ({
        ok: true,
        value: {
          active: true,
          rayHome: '/Volumes/External/ray',
          selfModel: {
            rayId: 'ray-ui-1',
            version: 2,
            name: '文鳐',
            aliases: ['Ray'],
            selfSummary: '一个独立自主的个人助手',
            values: ['owner优先'],
            ideals: [{ id: 'id-1', title: '助人自强', narrative: '持续帮主人省心' }],
            stageGoals: [{ id: 'g-1', title: '完成记忆沉淀', completionCriteria: '0 丢失', status: 'active' }],
            interests: [],
          },
          recentAutobiography: [{
            entryId: 'auto-1',
            timestamp: 1000,
            kind: 'bootstrap',
            summary: '初次在 /Volumes/External/ray 启动',
            reason: 'init',
          }],
          pendingProposals: [{
            proposalId: 'prop-99',
            section: 'energy',
            summary: '调整自由时间占比',
            reason: '更多探索时间',
            proposedAt: 1000,
            status: 'pending',
          }],
          missingCredentials: [],
          energy: { dailyTokenCap: 100_000, freeEnergyRatioBp: 2000 },
        },
      }),
      vetoRaySelf: async (_e, _c, reason) => {
        vetoCalls.push(reason)
        return { ok: true, value: { applied: true, entry: 'assistant-policy', note: 'vetoed' } }
      },
      rayWorkerTickets: async () => ({
        ok: true,
        value: {
          active: true,
          tickets: [{
            ticketId: 'tkt_demo_1',
            sessionId: 'ray_worker_1',
            title: '并发调研架构',
            status: 'running',
            sourceChannel: 'lark',
            usedTokens: 420,
            updatedAt: 1000,
          }],
        },
      }),
    }
    const ctrl = {
      remote,
      busy: false,
      run: async (action: () => Promise<unknown>) => { await action() },
    } as unknown as ConsoleController

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(RaySelfPanelCard, { ctrl, remote }))
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
    })

    expect(container.textContent).toContain('文鳐自我模型与 Ray Home')
    expect(container.textContent).toContain('/Volumes/External/ray')
    expect(container.textContent).toContain('助人自强')
    expect(container.textContent).toContain('完成记忆沉淀')
    expect(container.textContent).toContain('prop-99')
    expect(container.textContent).toContain('并发调研架构')

    const buttons = [...container.querySelectorAll('button')]
    const vetoBtn = buttons.find(b => b.textContent?.includes('1 轮推翻最近演化'))
    expect(vetoBtn).toBeDefined()
    await act(async () => { vetoBtn!.click() })
    expect(vetoCalls).toHaveLength(1)

    await act(async () => { root.unmount() })
    container.remove()
  })
})
