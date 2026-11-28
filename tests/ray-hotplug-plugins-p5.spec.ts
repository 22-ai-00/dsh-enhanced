import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { AssistantPolicyService } from '@dsh-ray/assistant-policy'
import { mountAgentLoopTestDependencies } from '../plugins/assistant-delivery/node_modules/@deepseek-ai/dsh-agent-loop-testkit/lib/index.js'
import { AssistantProactiveService } from '../plugins/assistant-proactive/lib/index.js'
import {
  RAY_SPINE_AND_KERNEL_PLUGIN_DENYLIST,
  RayStatefulHotplugService,
  type RayStatefulHotplugRuntime,
} from '../plugins/plugin-control-plane/lib/index.js'
import { afterEach, describe, expect, test } from 'vitest'

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function buildStatefulNoteServiceSource(version: string, options: Readonly<{ failLive?: boolean }> = {}): string {
  const failLive = options.failLive === true
  return `
import { Service } from '@deepseek-ai/cordis'

export const name = 'ray-self-stateful-notes'

export class StatefulNotesService extends Service {
  constructor(ctx) {
    super(ctx, 'rayStatefulNotes')
    this.count = 0
    this.version = ${JSON.stringify(version)}
    this.disposed = false
    ctx.effect(() => () => {
      this.disposed = true
    })
  }

  record(note) {
    this.count += 1
    return { count: this.count, version: this.version, note }
  }

  status() {
    return { count: this.count, version: this.version, disposed: this.disposed }
  }
}

export async function verifyTrial(trialCtx) {
  const svc = trialCtx.get('rayStatefulNotes', false)
  if (!svc) return { ok: false, reason: 'service-not-mounted-in-trial' }
  const first = svc.record('trial-1')
  const second = svc.record('trial-2')
  return { ok: first.count === 1 && second.count === 2, reason: 'stateful-counter-verified' }
}

export async function verifyLive(hostCtx) {
  ${failLive ? `return { ok: false, reason: 'simulated-v2-live-regression' }` : `
  const svc = hostCtx.get('rayStatefulNotes', false)
  return svc ? { ok: true } : { ok: false, reason: 'missing-live-service' }
  `}
}

export default StatefulNotesService
`
}

describe('Ray P5 end-to-end: staged stateful Cordis hotplug, live zero-restart promotion & Fiber disposal rollback', () => {
  test('trials stateful plugin in isolated child Context, hot-loads live without Host restart, auto-rolls back failing v2 to v1, refines [iff] preconditions, enforces 1-turn /veto, and protects spine/kernel plugins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ray-p5-e2e-'))
    tempDirs.push(root)
    const rayHome = join(root, 'ray-home')
    const workspace = join(root, 'workspace')
    mkdirSync(workspace, { recursive: true })

    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(`${root}/`).href
    await ctx.plugin(Loader, { baseUrl: import.meta.url })
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })
    await ctx.plugin(ApprovalService, { policy: 'ask' })

    let aliveMarker = 'alive-v0'
    ctx.provide('rayTestHostMarker' as never, { ping: () => aliveMarker } as never)

    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(rayHome, 'state', 'policy.sqlite'),
      rayHome,
      toolDefaultEffect: 'allow',
    })
    const raySelf = ctx.assistantPolicy.raySelf!
    await raySelf.whenReady()

    await ctx.plugin(AssistantProactiveService, {
      databasePath: join(rayHome, 'state', 'proactive.sqlite'),
      profiles: [],
    })

    await ctx.plugin(RayStatefulHotplugService)
    const hotplugSvc = ctx.get('rayHotplug' as never) as {
      whenReady: () => Promise<void>
      getRuntime: () => RayStatefulHotplugRuntime | undefined
    }
    await hotplugSvc.whenReady()
    const hotplug = hotplugSvc.getRuntime()!
    expect(hotplug).toBeDefined()

    // 1. Refuse spine & kernel packages + any kernel/energy touching code
    for (const protectedId of ['@dsh-ray/assistant-delivery', '@dsh-ray/plugin-control-plane', '@dsh-ray/assistant-policy']) {
      expect(RAY_SPINE_AND_KERNEL_PLUGIN_DENYLIST).toContain(protectedId)
    }
    const deniedSpine = await hotplug.stageAndTrialPlugin({
      slug: 'assistant-delivery',
      version: '9.9.9',
      kind: 'service',
      files: [{ path: 'index.mjs', content: 'export default function apply() {}' }],
    })
    expect(deniedSpine.ok).toBe(false)
    expect(deniedSpine.reason).toContain('RAY_HOTPLUG_DENIED')

    const deniedKernelTouch = await hotplug.stageAndTrialPlugin({
      slug: 'bad-kernel-writer',
      version: '0.1.0',
      kind: 'service',
      files: [{ path: 'index.mjs', content: `export default function apply() { return ${JSON.stringify(join(rayHome, 'kernel', 'kernel.json'))} }` }],
    })
    expect(deniedKernelTouch.ok).toBe(false)
    expect(deniedKernelTouch.reason).toContain('RAY_KERNEL_WRITE_DENIED')

    // 2. Stage 1 isolated trial of stateful plugin v1 -> does not leak into live Host ctx until Stage 2 promote
    const trialV1 = await hotplug.stageAndTrialPlugin({
      slug: 'stateful-notes',
      version: '1.0.0',
      kind: 'service',
      files: [{ path: 'index.mjs', content: buildStatefulNoteServiceSource('1.0.0') }],
      reason: 'P5 有状态笔记插件初版试运行',
    })
    expect(trialV1.ok).toBe(true)
    expect(trialV1.trialFiberDisposed).toBe(true)
    expect(trialV1.revision?.status).toBe('trial_verified')
    expect(trialV1.revision?.verificationDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(ctx.get('rayStatefulNotes' as never, false)).toBeUndefined()
    expect(existsSync(join(rayHome, 'plugins', 'hotplug.sqlite'))).toBe(true)

    // 3. Stage 2 live Cordis hot-load without Host restart (active host session/service remains untouched)
    const activeSession = ctx.sessions.create(SessionId('desktop-p5-live'), {
      meta: { cwd: workspace, agentPreset: 'standard' },
    })
    const promoteV1 = await hotplug.promotePluginLive({
      slug: 'stateful-notes',
      version: '1.0.0',
      reason: '通过隔离 trial，热加载进活 Host',
    })
    expect(promoteV1.ok).toBe(true)
    expect(promoteV1.promoted).toBe(true)
    expect(aliveMarker).toBe('alive-v0')
    expect(ctx.sessions.get(SessionId('desktop-p5-live'))).toBe(activeSession)

    const liveSvcV1 = ctx.get('rayStatefulNotes' as never, false) as {
      record: (note: string) => { count: number; version: string }
      status: () => { count: number; version: string; disposed: boolean }
    }
    expect(liveSvcV1).toBeDefined()
    expect(liveSvcV1.record('hello').count).toBe(1)
    expect(liveSvcV1.record('world').count).toBe(2)
    expect(hotplug.confirmObservedPlugin('stateful-notes')).toBe(true)
    expect(raySelf.snapshot().manifest.capabilities['plugin:stateful-notes']?.version).toBe('1.0.0')

    // 4. GUARD-inspired [iff] precondition narrowing blocks unsafe promotion when unmet
    const narrowed = await hotplug.revisePrecondition('stateful-notes', {
      requiredServices: ['missingRequiredHardwareService'],
      iffNote: 'requires hardware bridge service',
      reason: '收敛插件生效前提',
    })
    expect(narrowed.ok).toBe(true)
    const blockedByIff = await hotplug.promotePluginLive({ slug: 'stateful-notes', version: '1.0.0' })
    expect(blockedByIff.promoted).toBe(false)
    expect(blockedByIff.reason).toContain('precondition-unmet')

    // 5. Stage v2 whose verifyLive probe fails -> Stage 3 automatically disposes v2 Fiber & restores v1 live!
    const trialV2 = await hotplug.stageAndTrialPlugin({
      slug: 'stateful-notes',
      version: '2.0.0',
      kind: 'service',
      files: [{ path: 'index.mjs', content: buildStatefulNoteServiceSource('2.0.0', { failLive: true }) }],
      reason: 'P5 退化版本 v2（隔离 trial 通过但活进程观察失败）',
    })
    expect(trialV2.ok).toBe(true)

    const promoteV2 = await hotplug.promotePluginLive({
      slug: 'stateful-notes',
      version: '2.0.0',
      reason: '尝试热升级到 v2',
    })
    expect(promoteV2.promoted).toBe(false)
    expect(promoteV2.rolledBack).toBe(true)
    expect(promoteV2.restoredVersion).toBe('1.0.0')

    // v1 is immediately live again on hostCtx without Host restart, and rollback was logged
    const restoredSvc = ctx.get('rayStatefulNotes' as never, false) as { status: () => { version: string; disposed: boolean } }
    expect(restoredSvc.status().version).toBe('1.0.0')
    expect(restoredSvc.status().disposed).toBe(false)
    expect(readFileSync(join(rayHome, 'self', 'autobiography.jsonl'), 'utf8')).toContain('回退至稳定版 1.0.0')
    const outcomes = ctx.assistantProactive.rayCognitiveRuntime()!.listCandidateOutcomes(10)
    expect(outcomes.some(o => o.disposition === 'rolled_back')).toBe(true)

    // 6. Owner 1-turn /veto tears down the live plugin Fiber immediately without Host restart
    const vetoRes = await raySelf.vetoByOwner({
      targetCapabilityId: 'plugin:stateful-notes',
      reason: 'owner 否决该自创插件并要求立刻释放作用域',
      ownerProof: 'owner:p5:test',
    })
    expect(vetoRes.ok).toBe(true)
    expect(ctx.get('rayStatefulNotes' as never, false)).toBeUndefined()
    expect(restoredSvc.status().disposed).toBe(true)
    expect(raySelf.snapshot().manifest.capabilities['plugin:stateful-notes']?.active).toBe(false)

    // 7. Ray tool boundary check (ray_plugin_list allowed for Ray front session, denied for subagent)
    raySelf.setSessionRole('desktop-p5-live', 'front-consciousness')
    const leadAgent = { id: 'lead', session: activeSession }
    const signal = new AbortController().signal
    const leadToolSet = await ctx.tools.resolve({
      agent: leadAgent as never,
      modelSelection: { provider: 'mock', model: 'ray-fast' } as never,
      signal,
    })
    expect(leadToolSet.view(leadAgent as never).has('ray_plugin_list')).toBe(true)
    const listRes = await ctx.tools.execute({
      calls: [{
        type: 'tool-call',
        id: ToolCallId('lead-p5-list'),
        name: 'ray_plugin_list',
        arguments: JSON.stringify({ slug: 'stateful-notes' }),
      }],
      agent: leadAgent as never,
      toolSet: leadToolSet,
      signal,
    })
    expect(listRes.results[0]?.result.isError, JSON.stringify(listRes.results[0])).toBeFalsy()

    const subSession = ctx.sessions.create(SessionId('subagent-p5-deny'), {
      meta: { cwd: workspace, agentPreset: 'standard', origin: 'subagent' },
    })
    const subAgent = { id: 'sub', session: subSession as Session }
    const subToolSet = await ctx.tools.resolve({
      agent: subAgent as never,
      modelSelection: { provider: 'mock', model: 'ray-fast' } as never,
      signal,
    })
    expect(subToolSet.view(subAgent as never).has('ray_plugin_stage_trial')).toBe(false)
    const subDenied = await ctx.tools.execute({
      calls: [{
        type: 'tool-call',
        id: ToolCallId('sub-p5-deny'),
        name: 'ray_plugin_stage_trial',
        arguments: JSON.stringify({ slug: 'x', version: '1.0.0', kind: 'service', files_json: '[]' }),
      }],
      agent: subAgent as never,
      toolSet: subToolSet,
      signal,
    })
    expect(subDenied.results[0]?.result.isError).toBe(true)

    await hotplug.close()
    await ctx.fiber.dispose()
  })
})
