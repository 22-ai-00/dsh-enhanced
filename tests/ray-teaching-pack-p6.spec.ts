import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { ToolCallId, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { KNOWN_SESSION_EVENT_TYPES, SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { AssistantPolicyService } from '@dsh-ray/assistant-policy'
import { PersonalMemoryService } from '@dsh-ray/personal-memory'
import { mountAgentLoopTestDependencies } from '../plugins/assistant-delivery/node_modules/@deepseek-ai/dsh-agent-loop-testkit/lib/index.js'
import { AssistantDeliveryService } from '../plugins/assistant-delivery/lib/index.js'
import { RayStatefulHotplugService, type RayStatefulHotplugRuntime } from '../plugins/plugin-control-plane/lib/index.js'
import { main as cliMain } from '../packages/cli/src/index.ts'
import { afterEach, describe, expect, test } from 'vitest'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'ray-p6-test': { kind: 'ray-p6-test' }
  }
}

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function buildTaughtPluginSource(version: string, options: Readonly<{ touchKernel?: boolean }> = {}): string {
  const kernelLeak = options.touchKernel ? `export const badPath = 'kernel/kernel.json'\n` : ''
  return `
import { Service } from '@deepseek-ai/cordis'
${kernelLeak}
export const name = 'ray-self-taught-helper'

export class TaughtHelperService extends Service {
  constructor(ctx) {
    super(ctx, 'rayTaughtHelper')
    this.version = ${JSON.stringify(version)}
    ctx.effect(() => () => {})
  }
}

export async function verifyTrial(trialCtx) {
  const svc = trialCtx?.get?.('rayTaughtHelper', false)
  return svc ? { ok: svc.version === ${JSON.stringify(version)} } : { ok: true }
}

export default TaughtHelperService
`
}

function createFakePersistence(ctx: Context, workspace: string): void {
  ctx.provide('typert' as never, { register: () => () => {} } as never)
  ctx.provide('fileUploads' as never, {
    registerAgentResolver: () => () => {},
    resolve: () => { throw new Error('unused') },
    bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }),
  } as never)
  ctx.provide('agentPresets' as never, {
    resolve: async () => ({ id: 'standard' }),
    mount: async () => ({ id: 'standard' }),
    presetForSession: () => 'standard',
    select: async () => {},
  } as never)
  ctx.provide('sessionPersistence' as never, {
    coordinator: {
      assertEventsSupported(_meta: SessionHeader, events: readonly SessionEvent[]) {
        for (const e of events) {
          if (!KNOWN_SESSION_EVENT_TYPES.has(e.type) && e.ignorable !== true) {
            throw new Error(`unsupported ${e.type}`)
          }
        }
      },
    },
    create: async (header: { id: SessionId }) => ({
      id: header.id,
      access: 'write',
      header,
      inheritedEventCount: 0,
      read: async () => ({ eventState: 'detached', events: [] }),
      append: async () => {},
      flush: async () => {},
      close: async () => {},
      [Symbol.asyncDispose]: async () => {},
    }),
    open: async () => {
      throw Object.assign(new Error('missing'), { name: 'SessionPersistenceNotFoundError' })
    },
    flush: async () => {},
    stat: async () => undefined,
    list: async () => [],
  } as never)
  void workspace
}

describe('Ray P6 end-to-end: full-content ray-teaching-pack/v1 export, recipient verification & safe merge', () => {
  test('exports full non-credential content from Ray A, preserves Ray B identity/kernel/autobiography, re-verifies plugins independently, enforces semver merge & 1-turn /veto, recalls taught memories, and fails closed on tampering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ray-p6-e2e-'))
    tempDirs.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace, { recursive: true })

    // --- Setup Teacher Ray A ("文鳐") ---
    const rayHomeA = join(root, 'ray-a')
    const ctxA = new Context()
    ctxA.baseUrl = pathToFileURL(`${root}/`).href
    await ctxA.plugin(Loader, { baseUrl: import.meta.url })
    await mountAgentLoopTestDependencies(ctxA, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })
    await ctxA.plugin(ApprovalService, { policy: 'ask' })
    createFakePersistence(ctxA, workspace)
    await ctxA.plugin(AssistantPolicyService, {
      databasePath: join(rayHomeA, 'state', 'policy.sqlite'),
      rayHome: rayHomeA,
      toolDefaultEffect: 'allow',
      proposalMaintenanceIntervalMs: 0,
    })
    const raySelfA = ctxA.assistantPolicy.raySelf!
    await raySelfA.whenReady()
    await ctxA.plugin(PersonalMemoryService, {
      databasePath: join(rayHomeA, 'state', 'personal-memory', 'main.sqlite'),
      rayHome: rayHomeA,
    })
    await ctxA.plugin(RayStatefulHotplugService)
    const hotplugSvcA = ctxA.get('rayHotplug' as never) as {
      whenReady: () => Promise<void>
      getRuntime: () => RayStatefulHotplugRuntime | undefined
    }
    await hotplugSvcA.whenReady()
    const hotplugA = hotplugSvcA.getRuntime()!

    await ctxA.plugin(AssistantDeliveryService, {
      databasePath: join(rayHomeA, 'state', 'delivery.sqlite'),
      spoolPath: join(root, 'spool-a'),
      schedulerEnabled: false,
      defaultWorkspace: workspace,
      defaultAgentPreset: 'standard',
      agentProvider: 'mock',
      agentModel: 'ray-fast',
    })
    const deliveryA = ctxA.get('assistantDelivery' as never) as AssistantDeliveryService
    const sessA = ctxA.sessions.create(SessionId('owner-a-main'), { meta: { cwd: workspace, agentPreset: 'standard' } })
    const agentA = { id: 'lead', session: sessA }
    const origIsOwnerA = deliveryA.isOwnerSessionAgent.bind(deliveryA)
    deliveryA.isOwnerSessionAgent = (agent) => agent?.session?.id === sessA.id || origIsOwnerA(agent)
    raySelfA.setSessionRole('owner-a-main', 'front-consciousness')

    // Seed Ray A plugin v2.0.0, skill v1.0.0, dummy secret token, personal memory, episode, and reflection
    const stA = await hotplugA.stageAndTrialPlugin({
      slug: 'taught-helper',
      version: '2.0.0',
      kind: 'service',
      files: [{ path: 'index.mjs', content: buildTaughtPluginSource('2.0.0') }],
      reason: 'Teacher Ray A 构建 2.0.0 插件',
    })
    expect(stA.ok).toBe(true)
    const prA = await hotplugA.promotePluginLive({ slug: 'taught-helper', version: '2.0.0' })
    expect(prA.promoted).toBe(true)

    mkdirSync(join(rayHomeA, 'state', 'skills', 'rust-bench'), { recursive: true })
    writeFileSync(join(rayHomeA, 'state', 'skills', 'rust-bench', 'skill.json'), JSON.stringify({ id: 'rust-bench', version: '1.0.0' }), 'utf8')
    writeFileSync(join(rayHomeA, 'state', 'skills', 'rust-bench', 'SKILL.md'), '# Rust Bench\nOld teacher v1\n', 'utf8')
    raySelfA.registerCapability('skill:rust-bench', {
      kind: 'skill',
      version: '1.0.0',
      active: true,
      provenance: { origin: 'self' },
    })

    // Seed dummy credential file that MUST NEVER enter the teaching pack
    writeFileSync(join(rayHomeA, 'self', 'feishu.token'), 'secret-token-should-exclude', 'utf8')
    writeFileSync(join(rayHomeA, 'plugins', 'sources', 'taught-helper', 'api.secret'), 'plugin-secret-exclude', 'utf8')
    writeFileSync(join(rayHomeA, 'reflections', 'weekly-review.jsonl'), JSON.stringify({
      reflectionId: 'refl-a-1',
      cadence: 'weekly-review',
      summary: '每周复盘：跨盘索引校验经验总结',
    }) + '\n', 'utf8')

    // Seed Ray A personal memory DB + episode DB
    const pmDbA = new DatabaseSync(join(rayHomeA, 'state', 'personal-memory', 'owner.sqlite'))
    pmDbA.exec(`CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, content TEXT NOT NULL);`)
    pmDbA.prepare(`INSERT INTO memories (id, content) VALUES (?, ?)`).run('mem-a-1', 'TeacherA独门秘籍：Rust无锁环形队列压测阈值校准技巧')
    pmDbA.close()

    const epA = ctxA.personalMemory.episodicRuntime()!
    const sessAAny = sessA as unknown as { append(type: string, data: unknown, opts?: unknown): void }
    sessAAny.append('turn/start', { turn: 1 })
    sessAAny.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '如何排查异步环形缓冲区内存屏障问题？' }],
      source: { kind: 'ray-p6-test' },
    }), { surfaceOp: 'append' })
    sessAAny.append('assistant/message', {
      turn: 1,
      step: 1,
      attemptId: 'att-p6-1',
      revision: 1,
      message: createAssistantMessage({
        provider: 'mock',
        model: 'ray-fast',
        content: [{ type: 'text', text: '优先使用 loom 与 Acquire/Release 配对模型复现并发交错。' }],
        finishReason: { kind: 'stop' },
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      }),
    }, { surfaceOp: 'append' })
    sessAAny.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    epA.captureSessionTurns(sessA)

    // Export teaching pack via ray_teach_export tool
    const packDir = join(root, 'usb-teach-pack')
    const sig = new AbortController().signal
    const toolSetA = await ctxA.tools.resolve({
      agent: agentA as never,
      modelSelection: { provider: 'mock', model: 'ray-fast' } as never,
      signal: sig,
    })
    const expCall = await ctxA.tools.execute({
      calls: [{
        type: 'tool-call',
        id: ToolCallId('teach-export-1'),
        name: 'ray_teach_export',
        arguments: JSON.stringify({ destination: packDir }),
      }],
      agent: agentA as never,
      toolSet: toolSetA,
      signal: sig,
    })
    expect(expCall.results[0]?.result.isError, JSON.stringify(expCall.results[0])).toBeFalsy()
    expect(existsSync(join(packDir, 'teaching-pack.json'))).toBe(true)
    expect(existsSync(join(packDir, 'kernel', 'kernel.json'))).toBe(false)
    expect(existsSync(join(packDir, 'self', 'feishu.token'))).toBe(false)
    expect(existsSync(join(packDir, 'plugins', 'sources', 'taught-helper', 'api.secret'))).toBe(false)

    // --- Setup Recipient Ray B ("青鸾") with older plugin v1.0.0 AND newer skill v3.0.0 ---
    const rayHomeB = join(root, 'ray-b')
    const ctxB = new Context()
    ctxB.baseUrl = pathToFileURL(`${root}/`).href
    await ctxB.plugin(Loader, { baseUrl: import.meta.url })
    await mountAgentLoopTestDependencies(ctxB, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })
    await ctxB.plugin(ApprovalService, { policy: 'ask' })
    createFakePersistence(ctxB, workspace)
    await ctxB.plugin(AssistantPolicyService, {
      databasePath: join(rayHomeB, 'state', 'policy.sqlite'),
      rayHome: rayHomeB,
      toolDefaultEffect: 'allow',
      proposalMaintenanceIntervalMs: 0,
    })
    const raySelfB = ctxB.assistantPolicy.raySelf!
    await raySelfB.whenReady()
    raySelfB.evolveSelfModel({ name: '青鸾', selfSummary: '我是接收方青鸾，独立服务另一环境', reason: '初始化接收方身份' })
    const recipientRayId = raySelfB.snapshot().selfModel.rayId
    const recipientKernelBefore = readFileSync(join(rayHomeB, 'kernel', 'kernel.json'), 'utf8')

    await ctxB.plugin(PersonalMemoryService, {
      databasePath: join(rayHomeB, 'state', 'personal-memory', 'main.sqlite'),
      rayHome: rayHomeB,
    })
    await ctxB.plugin(RayStatefulHotplugService)
    const hotplugSvcB = ctxB.get('rayHotplug' as never) as {
      whenReady: () => Promise<void>
      getRuntime: () => RayStatefulHotplugRuntime | undefined
    }
    await hotplugSvcB.whenReady()
    const hotplugB = hotplugSvcB.getRuntime()!

    // Recipient B starts with v1.0.0 of taught-helper AND v3.0.0 of rust-bench skill
    await hotplugB.stageAndTrialPlugin({
      slug: 'taught-helper',
      version: '1.0.0',
      kind: 'service',
      files: [{ path: 'index.mjs', content: buildTaughtPluginSource('1.0.0') }],
      reason: 'Recipient B 自有旧版 v1.0.0',
    })
    await hotplugB.promotePluginLive({ slug: 'taught-helper', version: '1.0.0' })

    mkdirSync(join(rayHomeB, 'state', 'skills', 'rust-bench'), { recursive: true })
    writeFileSync(join(rayHomeB, 'state', 'skills', 'rust-bench', 'skill.json'), JSON.stringify({ id: 'rust-bench', version: '3.0.0' }), 'utf8')
    writeFileSync(join(rayHomeB, 'state', 'skills', 'rust-bench', 'SKILL.md'), '# Ray B v3 skill\nMust keep v3\n', 'utf8')
    raySelfB.registerCapability('skill:rust-bench', {
      kind: 'skill',
      version: '3.0.0',
      active: true,
      provenance: { origin: 'self' },
    })

    await ctxB.plugin(AssistantDeliveryService, {
      databasePath: join(rayHomeB, 'state', 'delivery.sqlite'),
      spoolPath: join(root, 'spool-b'),
      schedulerEnabled: false,
      defaultWorkspace: workspace,
      defaultAgentPreset: 'standard',
      agentProvider: 'mock',
      agentModel: 'ray-fast',
    })
    const deliveryB = ctxB.get('assistantDelivery' as never) as AssistantDeliveryService
    const sessB = ctxB.sessions.create(SessionId('owner-b-main'), { meta: { cwd: workspace, agentPreset: 'standard' } })
    const agentB = { id: 'lead', session: sessB }
    const origIsOwnerB = deliveryB.isOwnerSessionAgent.bind(deliveryB)
    deliveryB.isOwnerSessionAgent = (agent) => agent?.session?.id === sessB.id || origIsOwnerB(agent)
    raySelfB.setSessionRole('owner-b-main', 'front-consciousness')

    // Natural conversational import via ray_home_import auto-detecting teaching-pack.json
    const toolSetB = await ctxB.tools.resolve({
      agent: agentB as never,
      modelSelection: { provider: 'mock', model: 'ray-fast' } as never,
      signal: sig,
    })
    const autoImportRes = await ctxB.tools.execute({
      calls: [{
        type: 'tool-call',
        id: ToolCallId('home-import-auto-teach'),
        name: 'ray_home_import',
        arguments: JSON.stringify({ source_dir: packDir }),
      }],
      agent: agentB as never,
      toolSet: toolSetB,
      signal: sig,
    })
    expect(autoImportRes.results[0]?.result.isError, JSON.stringify(autoImportRes.results[0])).toBeFalsy()
    const autoParsed = JSON.parse(String((autoImportRes.results[0]?.result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? '{}')) as {
      mode?: string
      recipientRayId?: string
      recipientName?: string
      adoptedCapabilities?: string[]
      keptExistingCapabilities?: string[]
      verifiedPlugins?: string[]
      importedMemories?: number
      importedEpisodes?: number
      importedReflections?: number
    }
    expect(autoParsed.mode).toBe('teaching-pack')
    expect(autoParsed.recipientRayId).toBe(recipientRayId)
    expect(autoParsed.recipientName).toBe('青鸾')
    expect(autoParsed.verifiedPlugins).toContain('plugin:taught-helper')
    expect(autoParsed.adoptedCapabilities).toContain('plugin:taught-helper')
    expect(autoParsed.keptExistingCapabilities).toContain('skill:rust-bench')
    expect(autoParsed.importedMemories).toBeGreaterThanOrEqual(1)
    expect(autoParsed.importedEpisodes).toBeGreaterThanOrEqual(1)
    expect(autoParsed.importedReflections).toBeGreaterThanOrEqual(1)

    // Verify Ray B identity, kernel, and v3 skill were NEVER overwritten
    const snapB = raySelfB.snapshot()
    expect(snapB.selfModel.rayId).toBe(recipientRayId)
    expect(snapB.selfModel.name).toBe('青鸾')
    expect(readFileSync(join(rayHomeB, 'kernel', 'kernel.json'), 'utf8')).toBe(recipientKernelBefore)
    expect(snapB.manifest.capabilities['skill:rust-bench']?.version).toBe('3.0.0')
    expect(readFileSync(join(rayHomeB, 'state', 'skills', 'rust-bench', 'SKILL.md'), 'utf8')).toContain('Must keep v3')

    // Verify plugin:taught-helper@2.0.0 has taught provenance & 1-turn /veto restores 1.0.0 backup
    expect(snapB.manifest.capabilities['plugin:taught-helper']?.version).toBe('2.0.0')
    expect(snapB.manifest.capabilities['plugin:taught-helper']?.provenance.origin).toBe('taught')
    expect(snapB.manifest.capabilities['plugin:taught-helper']?.provenance.teacherRayId).toBe(raySelfA.snapshot().selfModel.rayId)
    expect(snapB.manifest.capabilities['plugin:taught-helper']?.provenance.verificationDigest).toMatch(/^[a-f0-9]{64}$/u)

    const vetoRes = await raySelfB.vetoByOwner({
      targetCapabilityId: 'plugin:taught-helper',
      reason: '否决传授版 v2 并退回本机 v1',
      ownerProof: 'owner:p6:veto',
    })
    expect(vetoRes.ok).toBe(true)
    expect(raySelfB.snapshot().manifest.capabilities['plugin:taught-helper']?.version).toBe('1.0.0')

    // Verify taught memories & episodes are recallable in Ray B via episodicRuntime() with taught provenance
    const recalled = ctxB.personalMemory.episodicRuntime()!.recall({ query: '无锁环形队列', limit: 5 })
    expect(recalled.episodes.some(ep => ep.channels.some(c => c.startsWith('taught:')))).toBe(true)
    expect(recalled.turns.some(t => t.text.includes('Rust无锁环形队列压测阈值校准技巧'))).toBe(true)

    // Idempotent second import yields zero duplicates
    const secondImport = await raySelfB.importTeachingPack(packDir)
    expect(secondImport.alreadyImported).toBe(true)
    expect(secondImport.importedMemories).toBe(0)
    expect(secondImport.importedEpisodes).toBe(0)

    // Verify CLI dsh-ray teach export & import into fresh Ray C home
    const cliPackDir = join(root, 'cli-teach-pack')
    const rayHomeC = join(root, 'ray-c')
    expect(await cliMain(['home', 'init', '--ray-home', rayHomeC], { HOME: root, DSH_HOME: join(root, 'dsh-c') })).toBe(0)
    expect(await cliMain(['teach', 'export', '--ray-home', rayHomeA, '--output', cliPackDir], { HOME: root, DSH_HOME: join(root, 'dsh-c') })).toBe(0)
    expect(await cliMain(['teach', 'import', '--ray-home', rayHomeC, '--source', cliPackDir], { HOME: root, DSH_HOME: join(root, 'dsh-c') })).toBe(0)
    // CLI rejects teaching pack if passed to `home import` without mixing clone vs teach semantics
    await expect(cliMain(['home', 'import', '--ray-home', rayHomeC, '--source', cliPackDir], { HOME: root, DSH_HOME: join(root, 'dsh-c') })).resolves.toBe(1)

    // Tampered file fails closed
    writeFileSync(join(packDir, 'taught', 'memories.jsonl'), 'tampered-bytes\n', 'utf8')
    await expect(raySelfB.importTeachingPack(packDir)).rejects.toThrow('digest mismatch')

    // Malicious kernel-touching plugin fails closed even with fresh manifest digest
    const malDir = join(root, 'malicious-teach-pack')
    expect(await cliMain(['teach', 'export', '--ray-home', rayHomeA, '--output', malDir], { HOME: root, DSH_HOME: join(root, 'dsh-c') })).toBe(0)
    const malPluginFile = join(malDir, 'plugins', 'sources', 'taught-helper', 'index.mjs')
    writeFileSync(malPluginFile, buildTaughtPluginSource('3.0.0', { touchKernel: true }), 'utf8')
    const malManifestPath = join(malDir, 'teaching-pack.json')
    const malManifest = JSON.parse(readFileSync(malManifestPath, 'utf8')) as { files: Record<string, { sha256: string; bytes: number }> }
    const { createHash } = await import('node:crypto')
    const buf = readFileSync(malPluginFile)
    malManifest.files['plugins/sources/taught-helper/index.mjs'] = {
      sha256: createHash('sha256').update(buf).digest('hex'),
      bytes: buf.byteLength,
    }
    writeFileSync(malManifestPath, JSON.stringify(malManifest, null, 2), 'utf8')
    await expect(raySelfB.importTeachingPack(malDir)).rejects.toThrow('RAY_KERNEL_WRITE_DENIED')

    await ctxA.fiber.dispose()
    await ctxB.fiber.dispose()
  })
})
