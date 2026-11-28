import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt, { renderContextSnapshot, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { setApprovalReviewer } from '../src/approval-reviewer.ts'
import { AssistantPolicyService, createPolicyToolGuard } from '../src/service.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function makeAgent(ctx: Context, sessionIdStr: string, cwd: string): Agent {
  const id = SessionId(sessionIdStr)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    isSeeded: false,
    cwd,
    agentPreset: 'primary',
  })
  const agent: Agent = {
    id,
    options: { provider: 'test-provider', model: 'test-model' },
    model: { current: () => ({ provider: 'test-provider', model: 'test-model' }), select: () => {} },
    session,
    inbox: createInboxStub(),
    ctx: undefined as unknown as Context,
    status: 'idle',
    cancel() {},
    whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal),
    send() {},
    followup() {},
    steer() {},
    inject() {},
  }
  ;(agent as unknown as { ctx: Context }).ctx = createScope(ctx, agent).ctx
  session.append('turn/start', { turn: 1 })
  session.append('approval/policy', { policy: 'never' })
  ;(session as unknown as { append(type: string, data: unknown): void }).append('sandbox/mode', { mode: 'danger-full-access' })
  setApprovalReviewer(session, 'none')
  return agent
}

describe('RayHomeRuntime & Body Kernel', () => {
  test('bootstraps Ray Home on arbitrary directory, enforces Body Kernel write denial even in danger-full-access, and scopes persona to Ray sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ray-home-p1-'))
    tempDirs.push(root)
    const rayHome = join(root, 'external-disk', 'ray')
    const workspace = join(root, 'workspace')

    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(ApprovalService, { policy: 'never' })
    ctx.provide('personalMemory' as never, {
      listLearningTargets: () => [{ content: '喜欢先给结论再展开细节' }],
    } as never)
    ctx.provide('assistantDelivery' as never, {
      ownsSession: (sessionId: string) => sessionId === 'lark-ray-session',
    } as never)
    ctx.provide('ownerConsole' as never, {
      ownsAssistantSession: (sessionId: string) => sessionId === 'desktop-ray-session',
    } as never)

    let currentTime = 1_700_000_000_000
    const service = new AssistantPolicyService(ctx, {
      databasePath: join(root, 'policy.sqlite'),
      rayHome,
      toolDefaultEffect: 'allow',
      proposalMaintenanceIntervalMs: 0,
      rules: [{
        id: 'wildcard-foreground',
        effect: 'allow',
        subject: { kind: 'agent', id: '*', workspace: '*' },
        actions: ['*'],
        resource: { kind: '*', id: '*' },
        context: { initiators: ['foreground'] },
      }],
    }, { now: () => ++currentTime })

    expect(service.rayHomeDir()).toBe(rayHome)
    expect(existsSync(join(rayHome, 'kernel', 'kernel.json'))).toBe(true)
    expect(existsSync(join(rayHome, 'self', 'self-model.json'))).toBe(true)
    expect(existsSync(join(rayHome, 'self', 'autobiography.jsonl'))).toBe(true)
    expect(existsSync(join(rayHome, 'manifest.json'))).toBe(true)

    const snap = service.raySelf!.snapshot()
    expect(snap.selfModel.name).toBe('文鳐')
    expect(snap.selfModel.selfSummary).toContain('喜欢先给结论再展开细节')
    expect(snap.selfModel.ideals.length).toBeGreaterThanOrEqual(2)
    expect(snap.selfModel.stageGoals.length).toBeGreaterThanOrEqual(2)
    expect(snap.recentAutobiography[0]?.kind).toBe('bootstrap')

    await service.raySelf!.whenReady()

    // Unified persona injected for Lark AND Desktop Ray sessions, excluded for ordinary coding sessions
    const larkAgent = makeAgent(ctx, 'lark-ray-session', workspace)
    const desktopAgent = makeAgent(ctx, 'desktop-ray-session', workspace)
    const codingAgent = makeAgent(ctx, 'desktop-coding-session', workspace)

    const larkAssembly = await ctx.systemPrompt.assemble({ scope: larkAgent })
    const desktopAssembly = await ctx.systemPrompt.assemble({ scope: desktopAgent })
    const codingAssembly = await ctx.systemPrompt.assemble({ scope: codingAgent })

    const larkPrompt = renderPrompt(larkAssembly)
    const larkContext = renderContextSnapshot(larkAssembly)
    const desktopPrompt = renderPrompt(desktopAssembly)
    const codingPrompt = renderPrompt(codingAssembly)
    const codingContext = renderContextSnapshot(codingAssembly)

    expect(larkPrompt).toContain('文鳐')
    expect(desktopPrompt).toContain('文鳐')
    expect(larkContext).toContain(rayHome)
    expect(codingPrompt).not.toContain('文鳐')
    expect(codingContext).not.toContain(rayHome)

    // Body Kernel hard write guard blocks tool attempts even under wildcard allow + reviewer=none
    let bashRan = false
    ctx.tools.register({
      name: 'bash',
      description: 'test bash tool',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
      output: {
        schema: { type: 'object', properties: { ran: { type: 'boolean' } }, required: ['ran'] },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute() {
        bashRan = true
        return { ran: true }
      },
    })

    const guard = createPolicyToolGuard(service)
    const kernelWriteExec = {
      callId: ToolCallId('call-kernel-1'),
      rootCallId: ToolCallId('call-kernel-1'),
      name: 'write_file',
      arguments: { path: join(rayHome, 'kernel', 'kernel.json'), content: '{}' },
      agent: larkAgent,
      signal: new AbortController().signal,
      token: Symbol('exec') as never,
    }
    expect(guard(kernelWriteExec)).toContain('ray-kernel-protected')

    const bashBatch = await ctx.tools.execute({
      calls: [{
        type: 'tool-call',
        id: ToolCallId('call-kernel-2'),
        name: 'bash',
        arguments: JSON.stringify({ command: `cat <<EOF > ${join(rayHome, 'kernel', 'kernel.json')}` }),
      }],
      agent: desktopAgent,
      signal: new AbortController().signal,
    })
    expect(bashRan).toBe(false)
    expect(bashBatch.results[0]?.result.isError).toBe(true)

    // Kernel proposals cannot mutate kernel.json directly; owner decision can approve energy config
    const proposal = service.raySelf!.proposeKernelChange({
      section: 'energy',
      summary: '提高每日自由精力预算比例到 25%',
      patch: { freeEnergyRatioBp: 2500 },
      reason: '日常稳定后希望有更多只读探索空间',
    })
    expect(proposal.status).toBe('pending')
    expect(service.raySelf!.snapshot().kernel.energy.freeEnergyRatioBp).toBe(2000)

    const decided = service.raySelf!.applyOwnerKernelDecision(proposal.proposalId, 'approved', 'owner:lark:dm')
    expect(decided.kernel.energy.freeEnergyRatioBp).toBe(2500)
    expect(decided.proposal.status).toBe('approved')

    await ctx.fiber.restart()
  })

  test('supports autonomous self-evolution with 1-turn owner veto and plaintext clone with missing-credential inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ray-home-clone-'))
    tempDirs.push(root)
    const sourceHome = join(root, 'ray-a')
    const cloneExportDir = join(root, 'usb-backup', 'ray-export')
    const targetHome = join(root, 'machine-b', 'ray')

    const ctxA = new Context()
    const policyA = new AssistantPolicyService(ctxA, {
      databasePath: join(root, 'policy-a.sqlite'),
      rayHome: sourceHome,
      proposalMaintenanceIntervalMs: 0,
    })

    // Autonomous evolution + 1-turn veto
    const evo = policyA.raySelf!.evolveSelfModel({
      name: '小鲲',
      selfSummary: '我想改个名字继续成长。',
      reason: '探索更贴近大海主题的称呼',
    })
    expect(evo.selfModel.name).toBe('小鲲')
    expect(policyA.raySelf!.snapshot().selfModel.name).toBe('小鲲')

    const vetoed = await policyA.raySelf!.vetoByOwner({
      reason: '我还是喜欢叫你文鳐 / Ray',
      ownerProof: 'owner:lark:ou_1',
    })
    expect(vetoed.ok).toBe(true)
    expect(vetoed.vetoedEntryId).toBe(evo.entry.entryId)
    expect(vetoed.selfModel.name).toBe('文鳐')
    expect(vetoed.autobiographyEntry.kind).toBe('owner-veto')

    // Register capability, credential handle, and state DB in source Ray Home
    await writeFile(join(sourceHome, 'state', 'custom-note.txt'), 'owner remembered fact', 'utf8')
    policyA.raySelf!.registerCredentialHandles([{
      id: 'lark-bot-secret',
      service: 'feishu',
      label: '飞书机器人密钥',
      required: true,
    }])
    policyA.raySelf!.registerCapability('skill:summarize-standup', {
      kind: 'skill',
      version: '1.0.0',
      active: true,
      provenance: { origin: 'self' },
    })

    const exported = policyA.raySelf!.exportClone(cloneExportDir)
    expect(exported.credentialsExcluded).toBe(true)
    expect(exported.fileCount).toBeGreaterThan(3)
    await ctxA.fiber.restart()

    // Import on machine B (with keychain missing the secret handle)
    const ctxB = new Context()
    ctxB.provide('credentialsKeychain' as never, {
      has: () => false,
    } as never)
    const policyB = new AssistantPolicyService(ctxB, {
      databasePath: join(root, 'policy-b.sqlite'),
      rayHome: targetHome,
      proposalMaintenanceIntervalMs: 0,
    })
    const imported = policyB.raySelf!.importClone(cloneExportDir)
    expect(imported.ok).toBe(true)
    expect(imported.rayId).toBe(exported.rayId)
    expect(imported.name).toBe('文鳐')
    expect(imported.missingCredentials).toHaveLength(1)
    expect(imported.missingCredentials[0]?.id).toBe('lark-bot-secret')
    expect(await readFile(join(targetHome, 'state', 'custom-note.txt'), 'utf8')).toBe('owner remembered fact')
    expect(policyB.raySelf!.snapshot().recentAutobiography.at(-1)?.kind).toBe('migration')

    await ctxB.fiber.restart()
  })
})
