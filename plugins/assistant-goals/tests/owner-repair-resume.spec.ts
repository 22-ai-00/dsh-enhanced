import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import GoalService from '@deepseek-ai/dsh-goal'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { AssistantGoalsService } from '../src/service.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'goal-owner-repair-resume-')), ctx = new Context(), owners = new Set<Agent>(), denied = new Set<string>()
  cleanups.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); new SessionProjectionRegistry(ctx)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: true, persona: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(GoalService)
  const receipt = { authorityId: 'route', principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 1, workspace: root, agentPreset: 'primary' }
  ctx.provide('assistantDelivery' as never, {
    preferencePrincipalForAgent: (agent: Agent) => owners.has(agent) ? { principalId: 'owner', principalLineage: { principalRecordId: 'owner-record', principalVersion: 1 }, scope: { workspace: root, preset: 'primary' } } : undefined,
    currentPreferenceTurn: (agent: Agent) => owners.has(agent) ? { principalId: 'owner', principalLineage: { principalRecordId: 'owner-record', principalVersion: 1 }, scope: { workspace: root, preset: 'primary' } } : undefined,
    validateOwnerRoute: () => receipt,
  } as never)
  ctx.provide('assistantPolicy' as never, { authorizeAgent: (_agent: Agent, action: string) => ({ effect: denied.has(action) ? 'deny' : 'allow' }), evaluateAgent: (_agent: Agent, action: string) => ({ effect: denied.has(action) ? 'deny' : 'allow' }) } as never)
  await ctx.plugin(AssistantGoalsService, { databasePath: join(root, 'goals.sqlite'), verifyNativeRounds: true, verifyGoalOutcome: true,
    executionBudget: { mode: 'calls', modelCalls: 4, toolCalls: 4, durationMs: 60_000, maxOutputTokensPerCall: 256, routes: [{ provider: 'fixture', model: 'fixture' }] } })
  const handle = await ctx.agents.create({ sessionId: SessionId('repair-session'), meta: { cwd: root, agentPreset: 'primary' }, agentOptions: { provider: 'fixture', model: 'fixture' } })
  cleanups.push(() => handle.dispose()); owners.add(handle.agent)
  const objective = 'Repair original objective'; ctx.goals.create(handle.agent, { objective, maxGoalRounds: 2 })
  const created = ctx.assistantGoals.taskContext(handle.agent)!.goal
  ctx.goals.disarm(handle.agent)
  const paused = ctx.assistantGoals.inspect(handle.agent, created.id); owners.delete(handle.agent)
  let current = true
  const trigger = { protocol: 'assistant-skills/host-failure-trigger/v1' as const, scope: paused.scope, taskFamily: { id: 'repair', definitionDigest: paused.definition.digest, objective }, failureCategory: 'objective-not-achieved' as const,
    triggerCondition: { kind: 'not-achieved-count' as const, minimumOccurrences: 1, windowStartedAt: 1, windowEndedAt: 1 }, failures: [{ goal: { id: 'failure-goal', definition: { version: 1, digest: paused.definition.digest, objective }, sessionId: 'failure-session', nativeGoalId: 'failure-native' }, runId: 'failure-run', execution: { status: 'succeeded' as const, quiescent: true as const }, outcome: 'not-achieved' as const, acceptance: { contractId: 'contract', contractDigest: 'a'.repeat(64), receiptDigest: 'b'.repeat(64), verifiedAt: 1, validUntil: Date.now() + 60_000 }, traceDigest: 'c'.repeat(64) }], attestedAt: Date.now(), evidence: { producer: 'assistant-goals' as const, generation: 'old-process', digest: '' } }
  trigger.evidence.digest = acceptanceDigest({ ...trigger, evidence: { producer: trigger.evidence.producer, generation: trigger.evidence.generation } })
  const input = { authorizationId: 'authorization', authorizationDigest: 'd'.repeat(64), ownerRouteId: 'route', scope: paused.scope, trigger, objective, maxGoalRounds: 2, expiresAt: Date.now() + 60_000,
    repair: { sessionId: String(handle.agent.session.id), goalId: paused.id, nativeGoalId: paused.native.goalId, definitionDigest: paused.definition.digest } }
  ctx.provide('assistantSkills' as never, { ownsOwnerAuthorizedRepairResume: (_input: unknown, callback: () => void) => callback === authority && current } as never)
  const authority = () => { if (!current) throw new Error('revoked') }
  vi.spyOn(ctx.assistantGoals, 'inspectOwnerFailureTrigger').mockResolvedValue(structuredClone(trigger))
  return { ctx, agent: handle.agent, owners, paused, input, authority, deny: (action: string) => denied.add(action), revoke: () => { current = false } }
}

test('rearms exactly the persisted active repair after native continuation is disarmed', async () => {
  const f = await fixture(), create = vi.spyOn(f.ctx.goals, 'create')
  vi.spyOn(f.ctx.assistantGoals, 'inspectOwnerFailureTrigger').mockResolvedValue({ ...structuredClone(f.input.trigger), attestedAt: Date.now() + 1,
    evidence: { producer: 'assistant-goals', generation: 'new-process', digest: 'f'.repeat(64) } } as never)
  const result = await f.ctx.assistantGoals.resumeOwnerAuthorizedRepair(f.agent, f.input, f.authority)
  expect(result.id).toBe(f.paused.id); expect(result.native.goalId).toBe(f.paused.native.goalId); expect(result.native.revision).toBe(f.paused.native.revision + 1)
  expect(create).not.toHaveBeenCalled(); expect(f.ctx.goals.get(f.agent)!.maxGoalRounds).toBe(2)
})

test('complete repair only mounts its original evidence and duplicate recovery cannot rearm it', async () => {
  const f = await fixture(), resume = vi.spyOn(f.ctx.goals, 'resume')
  f.owners.add(f.agent); const native = f.ctx.goals.get(f.agent)!; f.ctx.goals.complete(f.agent, { id: native.id, revision: native.revision }); f.owners.delete(f.agent)
  const result = await f.ctx.assistantGoals.resumeOwnerAuthorizedRepair(f.agent, f.input, f.authority)
  expect(result.id).toBe(f.paused.id); expect(result.native.phase).toBe('complete'); expect(resume).not.toHaveBeenCalled()
  await expect(f.ctx.assistantGoals.resumeOwnerAuthorizedRepair(f.agent, f.input, f.authority)).rejects.toThrow(/already bound/u)
  expect(resume).not.toHaveBeenCalled()
})

test('preserves an owner pause and never calls native resume', async () => {
  const f = await fixture(), resume = vi.spyOn(f.ctx.goals, 'resume')
  f.owners.add(f.agent); const native = f.ctx.goals.get(f.agent)!; f.ctx.goals.pause(f.agent, { id: native.id, revision: native.revision }); f.owners.delete(f.agent)
  await expect(f.ctx.assistantGoals.resumeOwnerAuthorizedRepair(f.agent, f.input, f.authority)).rejects.toThrow(/resumable repair Goal/u)
  expect(resume).not.toHaveBeenCalled()
})

test('requires the original execute authority rather than a separate resume action', async () => {
  const f = await fixture(), resume = vi.spyOn(f.ctx.goals, 'resume'); f.deny('execute')
  await expect(f.ctx.assistantGoals.resumeOwnerAuthorizedRepair(f.agent, f.input, f.authority)).rejects.toThrow(/policy/u)
  expect(resume).not.toHaveBeenCalled()
})

test.each(['goal', 'definition'] as const)('rejects a changed repair %s before native resume', async field => {
  const f = await fixture(), resume = vi.spyOn(f.ctx.goals, 'resume')
  if (field === 'goal') f.input.repair.goalId = 'other-goal'
  else f.input.repair.definitionDigest = 'e'.repeat(64)
  await expect(f.ctx.assistantGoals.resumeOwnerAuthorizedRepair(f.agent, f.input, f.authority)).rejects.toThrow()
  expect(resume).not.toHaveBeenCalled()
})

test('rechecks revocation after the async source read before native resume', async () => {
  const f = await fixture(), resume = vi.spyOn(f.ctx.goals, 'resume')
  let release!: () => void
  vi.spyOn(f.ctx.assistantGoals, 'inspectOwnerFailureTrigger').mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve }); return structuredClone(f.input.trigger) as never })
  const pending = f.ctx.assistantGoals.resumeOwnerAuthorizedRepair(f.agent, f.input, f.authority)
  await vi.waitFor(() => expect(release).toBeTypeOf('function')); f.revoke(); release()
  await expect(pending).rejects.toThrow(/capability|revoked/u); expect(resume).not.toHaveBeenCalled()
})
