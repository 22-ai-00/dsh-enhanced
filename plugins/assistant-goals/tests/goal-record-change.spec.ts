import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import GoalService from '@deepseek-ai/dsh-goal'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { AssistantGoalsService } from '../src/service.ts'
import type { GoalRecordChangeEvent } from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('assistant-goals onGoalRecordChange', () => {
  it('emits post-commit events for create, checkpoint, edit, and clear, and ignores read-only inspect/list', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goals-change-'))
    const ctx = new Context()
    ctx.provide('workingDirectory' as never, { ensure: async () => root, set: async () => root } as never)
    cleanups.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })

    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    new SessionProjectionRegistry(ctx)
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: true, personaPrefix: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(GoalService)

    const attestation = (agent: Agent) => ({
      scope: { workspace: root, preset: 'primary' },
      principalId: 'owner:1',
      principalLineage: { principalRecordId: 'rec-1', principalVersion: 1 },
      bindingId: `binding-${agent.session.id}`,
      bindingVersion: 1,
      bindingGeneration: 1,
      sessionId: String(agent.session.id),
    })
    ctx.provide('assistantDelivery' as never, {
      preferencePrincipalForAgent: attestation,
      currentPreferenceTurn: attestation,
    } as never)
    ctx.provide('assistantPolicy' as never, {
      authorizeAgent: () => ({ effect: 'allow' }),
      evaluateAgent: () => ({ effect: 'allow' }),
    } as never)

    await ctx.plugin(AssistantGoalsService, { databasePath: join(root, 'goals.sqlite') })
    const service = ctx.assistantGoals

    const events: GoalRecordChangeEvent[] = []
    const unsub = service.onGoalRecordChange(event => events.push(event))

    const handle1 = await ctx.agents.create({
      sessionId: SessionId('goal-change-sess-1'),
      meta: { cwd: root, agentPreset: 'primary' },
      agentOptions: { provider: 'fixture', model: 'fixture' },
    })
    cleanups.push(() => handle1.dispose())
    const agent = handle1.agent

    const created = service.create(agent, 'Ship association S1', 3)
    expect(events).toHaveLength(1)
    expect(events[0]?.record?.id).toBe(created.id)
    expect(events[0]?.record?.definition.objective).toBe('Ship association S1')
    expect(events[0]?.clearedGoalId).toBeUndefined()

    // Read-only list / inspect must not fire change events
    expect(service.list(agent)).toHaveLength(1)
    expect(service.inspect(agent, created.id).id).toBe(created.id)
    expect(events).toHaveLength(1)

    const checkpointed = service.checkpoint(agent, created.id, created.version, {
      nextStep: 'Implement MemoryStore change hook',
      blockers: [],
      assumptions: [],
      evidenceRefs: [],
      dependencies: [],
    })
    expect(events).toHaveLength(2)
    expect(events[1]?.record?.version).toBe(checkpointed.version)
    expect(events[1]?.record?.checkpoint.nextStep).toBe('Implement MemoryStore change hook')

    const edited = service.control(agent, {
      goalId: created.id,
      expectedRevision: checkpointed.native.revision,
      operation: 'edit',
      objective: 'Ship association S1 cleanly',
    })
    expect(events).toHaveLength(3)
    expect(events[2]?.record?.definition.objective).toBe('Ship association S1 cleanly')

    const cleared = service.control(agent, {
      goalId: created.id,
      expectedRevision: edited.native.revision,
      operation: 'clear',
    })
    expect(events).toHaveLength(4)
    expect(events[3]?.record?.native.phase).toBe('cleared')
    expect(events[3]?.clearedGoalId).toBe(cleared.id)

    unsub()
    const handle2 = await ctx.agents.create({
      sessionId: SessionId('goal-change-sess-2'),
      meta: { cwd: root, agentPreset: 'primary' },
      agentOptions: { provider: 'fixture', model: 'fixture' },
    })
    cleanups.push(() => handle2.dispose())
    service.create(handle2.agent, 'Another goal after unsub', 2)
    expect(events).toHaveLength(4)
  })
})
