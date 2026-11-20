import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Context } from '@deepseek-ai/cordis'
import { type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantSkillsService } from '../src/service.ts'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function makeAgent(ctx: Context, workspace: string, id: string): Agent {
  const sid = SessionId(id)
  const session = Session.create(sid, [], {
    version: SESSION_FORMAT_VERSION,
    id: sid,
    createdAt: 1,
    isSeeded: false,
    cwd: workspace,
    agentPreset: 'primary',
  })
  const value: Agent = {
    id: sid,
    options: { provider: 'fixture', model: 'fixture' },
    model: { current: () => ({ provider: 'fixture', model: 'fixture' }), select: () => {} },
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
  ;(value as unknown as { ctx: Context }).ctx = createScope(ctx, value).ctx
  session.append('turn/start', { turn: 1 })
  return value
}

describe('assistant-skills host change seam', () => {
  test('onSkillChange fires on save and retire with error isolation, unsubscribe, and dispose cleanup', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'assistant-skills-host-seams-')))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.restart())

    const owner = makeAgent(ctx, root, 'owner-session')
    const ownerSession = String(owner.session.id)
    const scope = {
      principalId: 'owner',
      principalRecordId: 'owner-record',
      principalVersion: 1,
      workspace: root,
      preset: 'primary',
    }

    const principal = () => ({
      principalId: 'owner',
      principalLineage: { principalRecordId: 'owner-record', principalVersion: 1 },
      scope: { workspace: root, preset: 'primary' },
    })

    ctx.provide('agents' as never, { get: (id: string) => (id === owner.id ? owner : undefined), list: () => [owner] } as never)
    ctx.provide('assistantDelivery' as never, {
      preferencePrincipalForAgent: principal,
      currentPreferenceTurn: principal,
    } as never)
    ctx.provide('assistantPolicy' as never, {
      evaluateAgent: () => ({ effect: 'allow' }),
      authorizeAgent: () => ({ effect: 'allow' }),
    } as never)

    const source = {
      protocol: 'assistant-goals/verified-workflow-source/v1' as const,
      scope,
      goal: {
        id: 'source-goal',
        definition: { version: 1, digest: 'a'.repeat(64), objective: 'Write artifact' },
        sessionId: ownerSession,
        nativeGoalId: 'native-source-goal',
      },
      runId: 'verified-run',
      turn: 1,
      acceptance: {
        contractId: 'contract',
        contractDigest: 'b'.repeat(64),
        receiptDigest: 'c'.repeat(64),
        verifiedAt: Date.now(),
        validUntil: Date.now() + 60_000,
      },
      steps: [{ id: 'step-1', toolName: 'write', arguments: { file: 'out.txt', data: 'ok' } }],
      failedObservations: [],
    }
    ctx.provide('assistantGoals' as never, {
      inspectVerifiedWorkflowSource: () => source,
    } as never)

    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(SkillRegistry)
    const plugin = await ctx.plugin(AssistantSkillsService, {
      databasePath: join(root, 'skills.sqlite'),
      allowedTools: ['write'],
    })

    const service = ctx.get('assistantSkills' as never) as unknown as AssistantSkillsService
    let notifications = 0
    const unsubThrow = service.onSkillChange(() => {
      throw new Error('listener failure')
    })
    const unsub = service.onSkillChange(() => {
      notifications += 1
    })

    const execute = async (name: string, args: unknown) => {
      const result = await owner.ctx.get('tools')!.execute({
        calls: [{ type: 'tool-call', id: ToolCallId(`call-${Math.random()}`), name, arguments: JSON.stringify(args) }],
        signal: new AbortController().signal,
        agent: owner,
      })
      return result.results[0]!.result
    }

    const saved = await execute('skill_save', {
      goal_id: 'source-goal',
      name: 'saved-write',
      description: 'Saved write skill',
      bindings_json: '[]',
      expected_version: 0,
    })
    expect(saved.isError).toBe(false)
    expect(notifications).toBe(1)
    expect(service.inspectOwnerActiveSkills(scope).map(skill => skill.name)).toEqual(['saved-write'])
    expect(service.inspectOwnerSkillCandidates(scope)).toEqual([])

    const drafted = await execute('skill_candidate', {
      goal_id: 'source-goal',
      name: 'candidate-write',
      description: 'Candidate write skill',
      bindings_json: '[]',
      parent_version: 0,
      reason: 'Draft candidate for proxy inspection',
      trigger: 'manual-check',
    })
    expect(drafted.isError).toBe(false)
    expect(service.inspectOwnerSkillCandidates(scope)).toMatchObject([
      { definition: { name: 'candidate-write' }, parentVersion: 0, state: 'pending' },
    ])

    const retired = await execute('skill_retire', { name: 'saved-write', expected_version: 1 })
    expect(retired.isError).toBe(false)
    expect(notifications).toBe(2)
    expect(service.inspectOwnerActiveSkills(scope)).toEqual([])

    unsub()
    unsub()
    unsubThrow()

    const savedTwo = await execute('skill_save', {
      goal_id: 'source-goal',
      name: 'saved-write-two',
      description: 'Second saved write skill',
      bindings_json: '[]',
      expected_version: 0,
    })
    expect(savedTwo.isError).toBe(false)
    expect(notifications).toBe(2)

    await plugin.dispose()
    expect(() => service.onSkillChange(() => {})).toThrow(/inactive/i)
    expect(() => service.inspectOwnerSkillCandidates(scope)).toThrow(/inactive/i)
  })
})
