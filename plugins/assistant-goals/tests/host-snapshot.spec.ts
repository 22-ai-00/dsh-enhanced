import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import GoalService from '@deepseek-ai/dsh-goal'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantGoalsService } from '../src/service.js'

interface OwnerRouteRequest { authorityId: string; principalId: string; workspace: string; agentPreset: string }

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'goal-owner-snapshot-')); const ctx = new Context(); let live = true; let version = 1; let routeReads = 0; let changeDuringRead = false
  cleanups.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); new SessionProjectionRegistry(ctx)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: true, persona: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(GoalService)
  const owner = { principalId: 'owner', principalRecordId: 'record-owner', principalVersion: version, workspace: root, preset: 'primary' }
  ctx.provide('assistantDelivery' as never, {
    preferencePrincipalForAgent: () => ({ scope: { workspace: root, preset: 'primary' }, principalId: owner.principalId, principalLineage: { principalRecordId: owner.principalRecordId, principalVersion: version } }),
    currentPreferenceTurn: () => ({ scope: { workspace: root, preset: 'primary' }, principalId: owner.principalId, principalLineage: { principalRecordId: owner.principalRecordId, principalVersion: version } }),
    validateOwnerRoute: ({ authorityId, principalId, workspace, agentPreset }: OwnerRouteRequest) => {
      if (!live || authorityId !== 'owner-route' || principalId !== 'owner' || workspace !== root || agentPreset !== 'primary') throw new Error('denied')
      if (++routeReads === 2 && changeDuringRead) version++
      return Object.freeze({ receiptVersion: 2 as const, authorityId, authorityHash: 'a'.repeat(64), principalId, principalRecordId: owner.principalRecordId, principalVersion: version, workspace, agentPreset, bindingVersion: version, generation: version })
    },
  } as never)
  ctx.provide('assistantPolicy' as never, { authorizeAgent: () => ({ effect: 'allow' }) } as never)
  await ctx.plugin(AssistantGoalsService, { databasePath: join(root, 'goals.sqlite') })
  const handle = await ctx.agents.create({ sessionId: SessionId('snapshot-owner'), meta: { cwd: root, agentPreset: 'primary' }, agentOptions: { provider: 'fixture', model: 'fixture' } })
  const record = ctx.assistantGoals.create(handle.agent, 'Persist exact snapshot evidence')
  return { ctx, handle, record, root, revoke() { live = false }, rotate() { version++ }, changeDuringRead() { changeDuringRead = true; routeReads = 0 } }
}

describe('owner post-quiescence goal snapshot', () => {
  test('returns only the exact durable goal after its native Agent has drained', async () => {
    const f = await fixture(); await f.handle.dispose()
    const value = f.ctx.assistantGoals.inspectOwnerGoalExecution({ ownerRouteId: 'owner-route', principalId: 'owner', workspace: f.root, preset: 'primary', sessionId: 'snapshot-owner', goalId: f.record.id })
    expect(value).toMatchObject({ protocol: 'assistant-goals/owner-execution-snapshot/v1', storedGoal: { id: f.record.id, definition: f.record.definition, nativeAtLastObservation: { sessionId: 'snapshot-owner' } }, executionRuns: [], acceptedTasks: [] })
    expect(Object.isFrozen(value)).toBe(true)
  })

  test('rejects a wrong session and a revoked or rotated owner route', async () => {
    const f = await fixture(); const input = { ownerRouteId: 'owner-route', principalId: 'owner', workspace: f.root, preset: 'primary', sessionId: 'wrong-session', goalId: f.record.id }
    expect(() => f.ctx.assistantGoals.inspectOwnerGoalExecution(input)).toThrow('exact goal evidence')
    f.revoke(); expect(() => f.ctx.assistantGoals.inspectOwnerGoalExecution({ ...input, sessionId: 'snapshot-owner' })).toThrow()
    const fresh = await fixture(); fresh.rotate()
    expect(() => fresh.ctx.assistantGoals.inspectOwnerGoalExecution({ ...input, workspace: fresh.root, sessionId: 'snapshot-owner', goalId: fresh.record.id })).toThrow('exact goal evidence')
  })

  test('rejects accessors before route validation and detects a route change during the read', async () => {
    const f = await fixture(); let read = false
    const accessor = { ownerRouteId: 'owner-route', principalId: 'owner', workspace: f.root, preset: 'primary', sessionId: 'snapshot-owner', goalId: f.record.id }
    Object.defineProperty(accessor, 'goalId', { enumerable: true, get() { read = true; return f.record.id } })
    expect(() => f.ctx.assistantGoals.inspectOwnerGoalExecution(accessor)).toThrow('invalid owner execution snapshot input')
    expect(read).toBe(false)
    f.changeDuringRead()
    expect(() => f.ctx.assistantGoals.inspectOwnerGoalExecution({ ownerRouteId: 'owner-route', principalId: 'owner', workspace: f.root, preset: 'primary', sessionId: 'snapshot-owner', goalId: f.record.id })).toThrow('changed during evidence read')
  })
})
