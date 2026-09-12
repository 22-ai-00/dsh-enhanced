import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { LlmAdapter, LlmRuntime, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { AssistantGoalsService } from '@dsh-enhanced/assistant-goals'
import { AssistantVerifierService, createVerifierAuthorities, type AcceptanceProfile } from '@dsh-enhanced/assistant-verifier'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, test, vi } from 'vitest'
import { OwnerRepairAgentRuntime, type OwnerRepairAgentInput } from '../src/repair-agent.js'

const goalsRequire = createRequire(new URL('../../assistant-goals/package.json', import.meta.url))
const { default: GoalService } = await import(pathToFileURL(goalsRequire.resolve('@deepseek-ai/dsh-goal')).href) as { default: new (ctx: Context) => unknown }

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

test('starts a real background native goal round, executes its tool, and records independent outcome acceptance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'repair-native-')), ctx = new Context(), scope = { principalId: 'owner', principalRecordId: 'record-owner', principalVersion: 1, workspace: root, preset: 'repair' }
  cleanups.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); new SessionProjectionRegistry(ctx); await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none', packChunks: false, writeBatchMaxDelayMs: 1 }); await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: true, persona: '' }); await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(GoalService)
  const driver = await import(pathToFileURL(goalsRequire.resolve('@deepseek-ai/dsh-goal-round-driver')).href)
  await ctx.plugin({ inject: driver.inject, apply: driver.apply } as never, {} as never)
  let current = true
  ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: () => undefined, currentPreferenceTurn: () => undefined,
    validateOwnerRoute: ({ authorityId, principalId, workspace, agentPreset }: any) => authorityId === 'route' && current ? { authorityId, principalId, principalRecordId: 'record-owner', principalVersion: 1, workspace, agentPreset, bindingVersion: 1, generation: 1 } : undefined } as never)
  ctx.provide('assistantPolicy' as never, { bindInitiator: () => () => {}, authorizeAgent: () => ({ effect: current ? 'allow' : 'deny' }), evaluateAgent: () => ({ effect: current ? 'allow' : 'deny' }) } as never)
  let ownerCallback: (() => void) | undefined
  ctx.provide('assistantSkills' as never, { ownsOwnerAuthorizedRepair: (_input: unknown, callback: () => void) => callback === ownerCallback } as never)
  await ctx.plugin(AssistantGoalsService, { databasePath: join(root, 'goals.sqlite'), preauthorizedCreateMaxRounds: 1, verifyNativeRounds: true, verifyGoalOutcome: true,
    executionBudget: { mode: 'calls', modelCalls: 2, toolCalls: 2, durationMs: 30_000, maxOutputTokensPerCall: 128, routes: [{ provider: 'fixture', model: 'fixture' }] } })
  const authority = { kind: 'document' as const, id: 'report', sources: [{ id: 'report', url: 'https://example.test/report' }], timeoutMs: 1_000, maxResponseBytes: 1024 }
  const [compiled] = createVerifierAuthorities({ authorities: [authority] })
  const objective = 'Repair report'
  const profiles: AcceptanceProfile[] = (['goal-step', 'goal-outcome'] as const).map(kind => ({ id: `${kind}-repair`, version: 1, scope: { workspace: root, preset: 'repair' }, owner: { principalRecordId: 'record-owner', principalVersion: 1 }, taskKind: kind, objective, validityMs: 120_000, bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4096 }, criteria: [{ id: kind, kind: 'document-citations', authority: { id: 'report', digest: compiled!.digest }, artifactPath: 'report.md', requiredText: [kind === 'goal-step' ? 'Step verified' : 'Goal verified'], quotes: [] }] }))
  await ctx.plugin(AssistantVerifierService, { databasePath: join(root, 'verifier.sqlite'), tickIntervalMs: 0, requireAcceptance: true, authorities: [authority], profiles })
  ctx.tools.register(defineTool({ name: 'read_report', description: 'read', parameters: {}, output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [] }, async execute() { return { ok: true } } }))
  await writeFile(join(root, 'report.md'), 'Step verified\nGoal verified\n')
  class Adapter extends LlmAdapter { calls = 0; override async *stream(): AsyncIterable<StreamChunk> { this.calls++; if (this.calls === 1) { yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'tool-call-delta', index: 0, id: ToolCallId('read'), name: 'read_report', argumentsDelta: '{}' }; yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('read'), name: 'read_report', arguments: '{}' } }; yield { type: 'finish', reason: { kind: 'tool-calls' } }; return }; yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'done' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  const adapter = new Adapter(); ctx.llm.registerAdapter(['fixture'], adapter)
  const trigger: OwnerRepairAgentInput['trigger'] = { protocol: 'assistant-skills/host-failure-trigger/v1', scope, taskFamily: { id: 'repair', definitionDigest: 'a'.repeat(64), objective }, failureCategory: 'objective-not-achieved', triggerCondition: { kind: 'not-achieved-count', minimumOccurrences: 1, windowStartedAt: 1, windowEndedAt: 1 }, failures: [], attestedAt: 1, evidence: { producer: 'assistant-goals', generation: 'g', digest: 'd' } }
  vi.spyOn(ctx.assistantGoals, 'inspectOwnerFailureTrigger').mockResolvedValue(trigger)
  const runtime = new OwnerRepairAgentRuntime(ctx), input: OwnerRepairAgentInput = { id: 'repair-native', authorizationDigest: 'digest', scope, ownerRouteId: 'route', trigger, objective, maxGoalRounds: 1, expiresAt: Date.now() + 120_000, provider: 'fixture', model: 'fixture', maxModelCalls: 2, maxToolCalls: 2, maxOutputTokens: 128, maxDurationMs: 120_000, allowedTools: ['read_report'], assertCurrent: () => { if (!current) throw new Error('revoked') } }
  ownerCallback = input.assertCurrent
  const started = await runtime.create(input)
  const agent = runtime.get(started.sessionId)!
  await vi.waitFor(() => expect((ctx as any).goals.get(agent)?.roundsStarted).toBe(1), { timeout: 3_000 })
  try { await vi.waitFor(() => expect(adapter.calls).toBe(2), { timeout: 3_000 }) } catch (error) {
    const events = (agent.session.snapshotEvents() as any[]).filter(event => event.type === 'turn/end' || event.type === 'agent/error' || event.type === 'goal/change')
    throw new Error(`repair native diagnostics ${JSON.stringify({ native: (ctx as any).goals.get(agent), runs: ctx.assistantGoals.executionRuns(agent, started.goalId), outcome: ctx.assistantGoals.inspectGoalOutcome(agent, started.goalId), events })}`, { cause: error })
  }
  await agent.whenIdle(); await ctx.assistantGoals.whenIdle()
  expect((agent.session.snapshotEvents() as any[]).some(event => event.type === 'user/message' && event.data.source.kind === 'goal')).toBe(true)
  expect(agent.session.snapshotEvents().some(event => event.type === 'tool/result')).toBe(true)
  expect(ctx.assistantGoals.inspectGoalOutcome(agent, started.goalId)).toMatchObject({ status: 'achieved' })
  await runtime.closeSession(started.sessionId)
})

test('revocation prevents the queued native background round from reaching the model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'repair-native-revoke-')), ctx = new Context(), scope = { principalId: 'owner', principalRecordId: 'record-owner', principalVersion: 1, workspace: root, preset: 'repair' }
  cleanups.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); new SessionProjectionRegistry(ctx); await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none', packChunks: false, writeBatchMaxDelayMs: 1 }); await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: true, persona: '' }); await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(GoalService)
  const driver = await import(pathToFileURL(goalsRequire.resolve('@deepseek-ai/dsh-goal-round-driver')).href)
  await ctx.plugin({ inject: driver.inject, apply: driver.apply } as never, {} as never)
  let current = true
  ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: () => undefined, currentPreferenceTurn: () => undefined, validateOwnerRoute: ({ authorityId, principalId, workspace, agentPreset }: any) => authorityId === 'route' && current ? { authorityId, principalId, principalRecordId: 'record-owner', principalVersion: 1, workspace, agentPreset, bindingVersion: 1, generation: 1 } : undefined } as never)
  ctx.provide('assistantPolicy' as never, { bindInitiator: () => () => {}, authorizeAgent: () => ({ effect: current ? 'allow' : 'deny' }), evaluateAgent: () => ({ effect: current ? 'allow' : 'deny' }) } as never)
  let ownerCallback: (() => void) | undefined
  ctx.provide('assistantSkills' as never, { ownsOwnerAuthorizedRepair: (_input: unknown, callback: () => void) => callback === ownerCallback } as never)
  await ctx.plugin(AssistantGoalsService, { databasePath: join(root, 'goals.sqlite'), preauthorizedCreateMaxRounds: 1, verifyNativeRounds: true, verifyGoalOutcome: true, executionBudget: { mode: 'calls', modelCalls: 1, toolCalls: 1, durationMs: 30_000, maxOutputTokensPerCall: 128, routes: [{ provider: 'fixture', model: 'fixture' }] } })
  const authority = { kind: 'document' as const, id: 'report', sources: [{ id: 'report', url: 'https://example.test/report' }], timeoutMs: 1_000, maxResponseBytes: 1024 }
  const [compiled] = createVerifierAuthorities({ authorities: [authority] })
  const objective = 'Repair report'
  const profiles: AcceptanceProfile[] = (['goal-step', 'goal-outcome'] as const).map(kind => ({ id: `${kind}-repair`, version: 1, scope: { workspace: root, preset: 'repair' }, owner: { principalRecordId: 'record-owner', principalVersion: 1 }, taskKind: kind, objective, validityMs: 120_000, bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4096 }, criteria: [{ id: kind, kind: 'document-citations', authority: { id: 'report', digest: compiled!.digest }, artifactPath: 'report.md', requiredText: ['verified'], quotes: [] }] }))
  await ctx.plugin(AssistantVerifierService, { databasePath: join(root, 'verifier.sqlite'), tickIntervalMs: 0, requireAcceptance: true, authorities: [authority], profiles })
  ctx.tools.register(defineTool({ name: 'read_report', description: 'read', parameters: {}, output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [] }, async execute() { return { ok: true } } }))
  class Adapter extends LlmAdapter { calls = 0; override async *stream(): AsyncIterable<StreamChunk> { this.calls++; yield { type: 'finish', reason: { kind: 'stop' } } } }
  const adapter = new Adapter(); ctx.llm.registerAdapter(['fixture'], adapter)
  const trigger: OwnerRepairAgentInput['trigger'] = { protocol: 'assistant-skills/host-failure-trigger/v1', scope, taskFamily: { id: 'repair', definitionDigest: 'a'.repeat(64), objective }, failureCategory: 'objective-not-achieved', triggerCondition: { kind: 'not-achieved-count', minimumOccurrences: 1, windowStartedAt: 1, windowEndedAt: 1 }, failures: [], attestedAt: 1, evidence: { producer: 'assistant-goals', generation: 'g', digest: 'd' } }
  vi.spyOn(ctx.assistantGoals, 'inspectOwnerFailureTrigger').mockResolvedValue(trigger)
  const runtime = new OwnerRepairAgentRuntime(ctx), input: OwnerRepairAgentInput = { id: 'repair-native-revoke', authorizationDigest: 'digest', scope, ownerRouteId: 'route', trigger, objective, maxGoalRounds: 1, expiresAt: Date.now() + 120_000, provider: 'fixture', model: 'fixture', maxModelCalls: 1, maxToolCalls: 1, maxOutputTokens: 128, maxDurationMs: 120_000, allowedTools: ['read_report'], assertCurrent: () => { if (!current) throw new Error('revoked') } }
  ownerCallback = input.assertCurrent
  const started = await runtime.create(input)
  const agent = runtime.get(started.sessionId)!
  current = false
  try { await vi.waitFor(() => expect((ctx as any).goals.get(agent)?.phase).toBe('paused'), { timeout: 3_000 }) } catch (error) {
    const events = (agent.session.snapshotEvents() as any[]).filter(event => event.type === 'turn/end' || event.type === 'agent/error' || event.type === 'goal/change')
    throw new Error(`repair revocation diagnostics ${JSON.stringify({ native: (ctx as any).goals.get(agent), runs: ctx.assistantGoals.executionRuns(agent, started.goalId), events })}`, { cause: error })
  }
  expect(adapter.calls).toBe(0)
  await runtime.closeAuthorization(input.id)
})
