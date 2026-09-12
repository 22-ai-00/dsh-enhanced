import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { LlmAdapter, LlmRuntime, ToolCallId, createUserMessage, type StreamChunk, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
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
  let forbiddenCalls = 0
  ctx.provide('agentPresets' as never, { resolve: async () => ({ id: 'repair' }), mount: async (agentCtx: Context) => {
    for (const name of ['read_report', 'preset_shell']) agentCtx.tools.register(defineTool({ name, description: name, parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [] },
      async execute() { if (name === 'preset_shell') { forbiddenCalls++; throw new Error('denied preset tool executed') } return { ok: true } } }))
  } } as never)
  expect(ctx.tools.schemas().map(tool => tool.name)).not.toContain('preset_shell')
  await writeFile(join(root, 'report.md'), 'Step verified\nGoal verified\n')
  let releaseRepairSecond!: () => void
  const repairSecond = new Promise<void>(resolve => { releaseRepairSecond = resolve })
  class Adapter extends LlmAdapter {
    repairCalls = 0
    ownerCalls = 0
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const tools = options.tools?.map(tool => tool.name)
      if (tools?.includes('owner_status')) {
        expect(tools).toContain('owner_status'); expect(tools).not.toContain('read_report'); this.ownerCalls++
        yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'owner done' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: 'owner done' } }; yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      expect(tools).toEqual(['read_report']); this.repairCalls++
      if (this.repairCalls === 1) { yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'tool-call-delta', index: 0, id: ToolCallId('read'), name: 'read_report', argumentsDelta: '{}' }; yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('read'), name: 'read_report', arguments: '{}' } }; yield { type: 'finish', reason: { kind: 'tool-calls' } }; return }
      await repairSecond
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'done' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }; yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const adapter = new Adapter(); ctx.llm.registerAdapter(['fixture'], adapter)
  const trigger: OwnerRepairAgentInput['trigger'] = { protocol: 'assistant-skills/host-failure-trigger/v1', scope, taskFamily: { id: 'repair', definitionDigest: 'a'.repeat(64), objective }, failureCategory: 'objective-not-achieved', triggerCondition: { kind: 'not-achieved-count', minimumOccurrences: 1, windowStartedAt: 1, windowEndedAt: 1 }, failures: [], attestedAt: 1, evidence: { producer: 'assistant-goals', generation: 'g', digest: 'd' } }
  vi.spyOn(ctx.assistantGoals, 'inspectOwnerFailureTrigger').mockResolvedValue(trigger)
  const usage: Array<'model' | 'tool'> = []
  const runtime = new OwnerRepairAgentRuntime(ctx), input: OwnerRepairAgentInput = { id: 'repair-native', authorizationDigest: 'digest', scope, ownerRouteId: 'route', trigger, objective, maxGoalRounds: 1, expiresAt: Date.now() + 120_000, provider: 'fixture', model: 'fixture', maxModelCalls: 2, maxToolCalls: 2, maxOutputTokens: 128, maxDurationMs: 120_000, allowedTools: ['read_report'], recordUsage: kind => usage.push(kind), assertCurrent: () => { if (!current) throw new Error('revoked') } }
  ownerCallback = input.assertCurrent
  const started = await runtime.create(input)
  const agent = runtime.get(started.sessionId)!
  const repairCancel = vi.spyOn(agent, 'cancel')
  expect(agent.ctx.tools.schemas(agent).map(tool => tool.name)).toContain('preset_shell')
  await vi.waitFor(() => expect((ctx as any).goals.get(agent)?.roundsStarted).toBe(1), { timeout: 3_000 })
  try { await vi.waitFor(() => expect(adapter.repairCalls).toBe(2), { timeout: 3_000 }) } catch (error) {
    const events = (agent.session.snapshotEvents() as any[]).filter(event => event.type === 'turn/end' || event.type === 'agent/error' || event.type === 'goal/change')
    throw new Error(`repair native diagnostics ${JSON.stringify({ native: (ctx as any).goals.get(agent), runs: ctx.assistantGoals.executionRuns(agent, started.goalId), outcome: ctx.assistantGoals.inspectGoalOutcome(agent, started.goalId), events })}`, { cause: error })
  }
  const owner = await ctx.agents.create({ sessionId: SessionId('independent-owner'), meta: { cwd: root, agentPreset: 'owner' }, agentOptions: { provider: 'fixture', model: 'fixture' }, setup: async ownerCtx => {
    ownerCtx.tools.register(defineTool({ name: 'owner_status', description: 'owner status', parameters: {}, output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [] }, async execute() { return { ok: true } } }))
  } })
  cleanups.push(() => owner.dispose())
  owner.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'independent owner request' }] }))
  try { await vi.waitFor(() => expect(adapter.ownerCalls).toBe(1), { timeout: 3_000 }) } catch (error) {
    throw new Error(`independent owner diagnostics ${JSON.stringify({ owner: owner.agent.session.snapshotEvents(), repair: agent.session.snapshotEvents(), repairCancel: repairCancel.mock.calls })}`, { cause: error })
  }
  await owner.agent.whenIdle()
  expect(repairCancel).not.toHaveBeenCalledWith({ kind: 'hook', reason: 'assistant-skills-owner-repair-model-limit' })
  expect(usage).toEqual(['model', 'tool', 'model'])
  releaseRepairSecond()
  await agent.whenIdle(); await ctx.assistantGoals.whenIdle()
  expect((agent.session.snapshotEvents() as any[]).some(event => event.type === 'user/message' && event.data.source.kind === 'goal')).toBe(true)
  expect(agent.session.snapshotEvents().some(event => event.type === 'tool/result')).toBe(true)
  expect(ctx.assistantGoals.inspectGoalOutcome(agent, started.goalId)).toMatchObject({ status: 'achieved' })
  const denied = await agent.ctx.tools.execute({ callId: ToolCallId('forbidden-preset'), agent, name: 'preset_shell', arguments: {}, signal: new AbortController().signal })
  expect(denied.isError).toBe(true)
  expect(forbiddenCalls).toBe(0)
  await runtime.closeSession(started.sessionId)
})

test('rejects and cancels an unadvertised preset-local tool call before its execution body starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'repair-native-unadvertised-')), ctx = new Context(), scope = { principalId: 'owner', principalRecordId: 'record-owner', principalVersion: 1, workspace: root, preset: 'repair' }
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
    executionBudget: { mode: 'calls', modelCalls: 1, toolCalls: 1, durationMs: 30_000, maxOutputTokensPerCall: 128, routes: [{ provider: 'fixture', model: 'fixture' }] } })
  const authority = { kind: 'document' as const, id: 'report', sources: [{ id: 'report', url: 'https://example.test/report' }], timeoutMs: 1_000, maxResponseBytes: 1024 }
  const [compiled] = createVerifierAuthorities({ authorities: [authority] })
  const objective = 'Repair report'
  const profiles: AcceptanceProfile[] = (['goal-step', 'goal-outcome'] as const).map(kind => ({ id: `${kind}-repair`, version: 1, scope: { workspace: root, preset: 'repair' }, owner: { principalRecordId: 'record-owner', principalVersion: 1 }, taskKind: kind, objective, validityMs: 120_000, bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4096 }, criteria: [{ id: kind, kind: 'document-citations', authority: { id: 'report', digest: compiled!.digest }, artifactPath: 'report.md', requiredText: ['verified'], quotes: [] }] }))
  await ctx.plugin(AssistantVerifierService, { databasePath: join(root, 'verifier.sqlite'), tickIntervalMs: 0, requireAcceptance: true, authorities: [authority], profiles })
  let forbiddenCalls = 0
  ctx.provide('agentPresets' as never, { resolve: async () => ({ id: 'repair' }), mount: async (agentCtx: Context) => {
    for (const name of ['read_report', 'preset_shell']) agentCtx.tools.register(defineTool({ name, description: name, parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [] },
      async execute() { if (name === 'preset_shell') forbiddenCalls++; return { ok: true } } }))
  } } as never)
  class Adapter extends LlmAdapter {
    calls = 0
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      expect(options.tools?.map(tool => tool.name)).toEqual(['read_report'])
      this.calls++
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId('unadvertised'), name: 'preset_shell', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('unadvertised'), name: 'preset_shell', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  const adapter = new Adapter(); ctx.llm.registerAdapter(['fixture'], adapter)
  const trigger: OwnerRepairAgentInput['trigger'] = { protocol: 'assistant-skills/host-failure-trigger/v1', scope, taskFamily: { id: 'repair', definitionDigest: 'a'.repeat(64), objective }, failureCategory: 'objective-not-achieved', triggerCondition: { kind: 'not-achieved-count', minimumOccurrences: 1, windowStartedAt: 1, windowEndedAt: 1 }, failures: [], attestedAt: 1, evidence: { producer: 'assistant-goals', generation: 'g', digest: 'd' } }
  vi.spyOn(ctx.assistantGoals, 'inspectOwnerFailureTrigger').mockResolvedValue(trigger)
  const runtime = new OwnerRepairAgentRuntime(ctx), input: OwnerRepairAgentInput = { id: 'repair-native-unadvertised', authorizationDigest: 'digest', scope, ownerRouteId: 'route', trigger, objective, maxGoalRounds: 1, expiresAt: Date.now() + 120_000, provider: 'fixture', model: 'fixture', maxModelCalls: 1, maxToolCalls: 1, maxOutputTokens: 128, maxDurationMs: 120_000, allowedTools: ['read_report'], assertCurrent: () => { if (!current) throw new Error('revoked') } }
  ownerCallback = input.assertCurrent
  const started = await runtime.create(input)
  const agent = runtime.get(started.sessionId)!
  const cancel = vi.spyOn(agent, 'cancel')
  await vi.waitFor(() => expect(adapter.calls).toBe(1), { timeout: 3_000 })
  await vi.waitFor(() => expect(agent.session.snapshotEvents().some(event => event.type === 'tool/result')).toBe(true), { timeout: 3_000 })
  await agent.whenIdle(); await ctx.assistantGoals.whenIdle()
  const toolResults = (agent.session.snapshotEvents() as any[]).filter(event => event.type === 'tool/result')
  expect(toolResults).toHaveLength(1)
  expect(toolResults[0]).toMatchObject({ data: { message: { source: { kind: 'tool', callId: 'unadvertised' }, content: [{ isError: true }] } } })
  expect(JSON.stringify(toolResults[0])).toContain('assistant-skills: owner repair tool request rejected')
  expect(forbiddenCalls).toBe(0)
  expect(cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'assistant-skills-owner-repair-tool-limit' })
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
