import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderContextSnapshot, renderPrompt } from '../plugins/assistant-policy/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js'
import ToolRuntime from '../plugins/assistant-policy/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import * as NativeToolExecutor from '../plugins/assistant-policy/node_modules/@deepseek-ai/dsh-tool-executor-native/lib/index.js'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantPolicyService } from '@dsh-ray/assistant-policy'
import { OwnerConsoleService } from '../plugins/owner-console/src/service.ts'
import { tryBuildLarkCommandCard } from '../plugins/lark-channel/src/command-card.ts'
import { renderLarkMessage } from '../plugins/lark-channel/src/sdk.ts'
import {
  exportRayHomeClone,
  importRayHomeClone,
  migrateDshHomeToRayHome,
} from '../packages/cli/src/ray-home.ts'

const dirs: string[] = []

afterEach(async () => {
  while (dirs.length > 0) {
    await rm(dirs.pop()!, { recursive: true, force: true })
  }
})

describe('Ray Home P1 end-to-end acceptance', () => {
  test('mounts Ray Home on an arbitrary disk directory, migrates SQLite outside $DSH_HOME, shares unified self across channels, enforces Body Kernel, supports 1-turn veto, and migrates plaintext clone with credential re-auth list', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ray-p1-e2e-'))
    dirs.push(root)

    const dshHome = join(root, 'dsh-home')
    const externalRayHome = join(root, 'mnt', 'disk-ray', 'ray-home')
    const profileDir = join(dshHome, 'profiles', 'desktop')
    const workspace = join(dshHome, 'assistant-workspace')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(workspace, { recursive: true })
    mkdirSync(join(dshHome, 'assistant-policy'), { recursive: true })

    // 1. Seed pre-migration SQLite + migrate via CLI migration engine to external disk Ray Home
    const oldPolicyDb = join(dshHome, 'assistant-policy', 'desktop.sqlite')
    const initDb = new DatabaseSync(oldPolicyDb)
    initDb.exec('CREATE TABLE IF NOT EXISTS sample_state (k TEXT PRIMARY KEY, v TEXT);')
    initDb.prepare('INSERT INTO sample_state (k, v) VALUES (?, ?)').run('migrated', 'yes')
    initDb.close()

    writeFileSync(join(profileDir, 'cordis.patch.yml'), [
      '- id: dsh-ray-assistant-policy',
      '  name: "@dsh-ray/assistant-policy"',
      '  config:',
      `    databasePath: ${oldPolicyDb}`,
      '    toolDefaultEffect: allow',
      '',
    ].join('\n'), 'utf8')

    const migrated = migrateDshHomeToRayHome({ dshHome, rayHome: externalRayHome, profile: 'desktop' })
    expect(migrated.migratedDatabases.some(d => d.plugin === 'assistant-policy')).toBe(true)
    const migratedPolicyDb = join(externalRayHome, 'state', 'assistant-policy', 'desktop.sqlite')
    expect(existsSync(migratedPolicyDb)).toBe(true)

    // Verify migrated SQLite DB integrity outside $DSH_HOME
    const checkDb = new DatabaseSync(migratedPolicyDb, { readOnly: true })
    expect((checkDb.prepare('SELECT v FROM sample_state WHERE k = ?').get('migrated') as { v: string }).v).toBe('yes')
    checkDb.close()

    // 2. Boot Host services against migrated Ray Home on external disk
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(ApprovalService, { policy: 'never' })
    ctx.provide('typert' as never, { register: () => () => {} } as never)
    ctx.provide('profileContext' as never, { home: dshHome, name: 'desktop', dir: profileDir } as never)
    ctx.provide('personalMemory' as never, {
      listLearningTargets: () => [{ content: '回答直接切入重点' }],
    } as never)

    let larkSessionId = 'lark-ray-session-1'
    ctx.provide('assistantDelivery' as never, {
      ownsSession: (id: string) => id === larkSessionId,
    } as never)

    const policy = new AssistantPolicyService(ctx, {
      databasePath: migratedPolicyDb,
      rayHome: externalRayHome,
      toolDefaultEffect: 'allow',
      proposalMaintenanceIntervalMs: 0,
      rules: [{
        id: 'allow-all',
        effect: 'allow',
        subject: { kind: 'agent', id: '*', workspace: '*' },
        actions: ['*'],
        resource: { kind: '*', id: '*' },
        context: { initiators: ['foreground'] },
      }],
    })
    await policy.raySelf!.whenReady()
    policy.raySelf!.registerCredentialHandles([{
      id: 'lark-app-secret',
      service: 'feishu',
      label: '飞书应用密钥',
      required: true,
    }])

    const consoleSvc = new OwnerConsoleService(ctx, { feishuAppId: '' })
    await consoleSvc.registerAssistantSession('desktop-ray-session-1', true)

    // 3. Lark and Desktop share the exact same Self Model + Panel + /status Card 2.0
    const larkSession = Session.create(SessionId(larkSessionId), [], {
      version: SESSION_FORMAT_VERSION,
      id: SessionId(larkSessionId),
      createdAt: 1,
      isSeeded: false,
      cwd: workspace,
      agentPreset: 'standard',
    })
    const desktopSession = Session.create(SessionId('desktop-ray-session-1'), [], {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('desktop-ray-session-1'),
      createdAt: 1,
      isSeeded: false,
      cwd: workspace,
      agentPreset: 'standard',
    })
    const larkAssembly = await ctx.systemPrompt.assemble({ scope: { id: larkSession.id, session: larkSession } as never })
    const desktopAssembly = await ctx.systemPrompt.assemble({ scope: { id: desktopSession.id, session: desktopSession } as never })

    expect(renderPrompt(larkAssembly)).toContain('文鳐')
    expect(renderPrompt(desktopAssembly)).toContain('文鳐')
    expect(renderPrompt(desktopAssembly)).not.toContain('owner-console:wenyao-persona')
    expect(renderContextSnapshot(larkAssembly)).toContain(externalRayHome)
    expect(renderContextSnapshot(desktopAssembly)).toContain(externalRayHome)

    const desktopSnap = await consoleSvc.raySelfSnapshot()
    expect(desktopSnap.active).toBe(true)
    expect(desktopSnap.selfModel?.name).toBe('文鳐')
    expect(desktopSnap.selfModel?.ideals.length).toBeGreaterThanOrEqual(2)

    const card = tryBuildLarkCommandCard([
      '当前会话',
      '- 第 1 代（lark-ray）',
      '- 状态：空闲',
      '- 上下文消息：2',
      '- 已记录轮次：1',
      '- 模型：deepseek / deepseek-reasoner',
      '',
      '自我模型（Ray Home）',
      `- 身份：${desktopSnap.selfModel!.name}（v${desktopSnap.selfModel!.version}）`,
      `- 家目录：${externalRayHome}`,
      `- 自述：${desktopSnap.selfModel!.selfSummary}`,
      `- 阶段目标：${desktopSnap.selfModel!.stageGoals[0]!.title}`,
      `- 长期理想：${desktopSnap.selfModel!.ideals[0]!.title}`,
      '',
      '/new 会开始空白新 session 并保留旧会话；/stop 只停止当前任务，不清空上下文。',
    ].join('\n'))
    expect(card).toBeDefined()
    expect(renderLarkMessage({ commandCard: card! }).content).toContain(externalRayHome)

    // 4. Body Kernel write rejection even under danger-full-access + wildcard allow
    let bashRan = false
    ctx.tools.register({
      name: 'bash',
      description: 'bash test tool',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      output: {
        schema: { type: 'object', properties: { ran: { type: 'boolean' } }, required: ['ran'] },
        render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
      },
      async execute() {
        bashRan = true
        return { ran: true }
      },
    })
    ;(desktopSession as unknown as { append(type: string, data: unknown): void }).append('sandbox/mode', { mode: 'danger-full-access' })
    const denied = await ctx.tools.execute({
      calls: [{
        type: 'tool-call',
        id: ToolCallId('call-1'),
        name: 'bash',
        arguments: JSON.stringify({ command: `echo pwn > ${join(externalRayHome, 'kernel', 'kernel.json')}` }),
      }],
      agent: { id: desktopSession.id, session: desktopSession } as never,
      signal: new AbortController().signal,
    })
    expect(bashRan).toBe(false)
    expect(denied.results[0]?.result.isError).toBe(true)

    // 5. Autonomous update + 1-turn owner veto via consoleSvc.vetoRaySelf()
    policy.raySelf!.evolveSelfModel({
      name: '若飞',
      selfSummary: '尝试新名字',
      reason: '自我探索尝试',
    })
    expect((await consoleSvc.raySelfSnapshot()).selfModel?.name).toBe('若飞')
    const vetoRes = await consoleSvc.vetoRaySelf('', '', '还是继续叫文鳐')
    expect(vetoRes.applied).toBe(true)
    expect((await consoleSvc.raySelfSnapshot()).selfModel?.name).toBe('文鳐')
    const afterVetoAssembly = await ctx.systemPrompt.assemble({ scope: { id: larkSession.id, session: larkSession } as never })
    expect(renderPrompt(afterVetoAssembly)).not.toContain('若飞')

    // 6. Plaintext clone export -> import onto simulated machine B
    const usbClone = join(root, 'usb-drive', 'ray-clone')
    const exported = exportRayHomeClone({ rayHome: externalRayHome, outputDir: usbClone })
    expect(exported.credentialsExcluded).toBe(true)

    await ctx.fiber.restart()

    const machineBHome = join(root, 'machine-b', 'ray-home')
    const imported = importRayHomeClone({ sourceDir: usbClone, rayHome: machineBHome })
    expect(imported.rayId).toBe(exported.rayId)
    expect(imported.missingCredentials.some(c => c.id === 'lark-app-secret')).toBe(true)

    const ctxB = new Context()
    await ctxB.plugin(SystemPrompt)
    ctxB.provide('assistantDelivery' as never, { ownsSession: (id: string) => id === larkSessionId } as never)
    const policyB = new AssistantPolicyService(ctxB, {
      databasePath: join(machineBHome, 'state', 'assistant-policy', 'desktop.sqlite'),
      rayHome: machineBHome,
      proposalMaintenanceIntervalMs: 0,
    })
    await policyB.raySelf!.whenReady()
    expect(policyB.raySelf!.snapshot().selfModel.rayId).toBe(exported.rayId)
    expect(policyB.raySelf!.snapshot().selfModel.name).toBe('文鳐')
    expect(readFileSync(join(machineBHome, 'self', 'autobiography.jsonl'), 'utf8')).toContain('mig-')
    await ctxB.fiber.restart()
  })
})
