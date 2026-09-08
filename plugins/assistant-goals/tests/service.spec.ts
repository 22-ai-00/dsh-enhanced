import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import GoalService from '@deepseek-ai/dsh-goal'
import { LlmRuntime, LlmAdapter, ToolCallId, createUserMessage, type StreamChunk, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantGoalsService, type Config as GoalsConfig } from '../src/service.ts'
import { GoalEventWaitStore } from '../src/event-wait-store.ts'
import { GoalExecutionStore } from '../src/execution-store.ts'
import { acceptanceDigest, createTaskAcceptanceContract, createTaskVerificationReceipt } from '@dsh-enhanced/task-acceptance-contract'
import { AssistantVerifierService, createVerifierAuthorities } from '@dsh-enhanced/assistant-verifier'
import type { AcceptanceProfile } from '@dsh-enhanced/assistant-verifier'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function harness(databasePath?: string, maxContextChars?: number, duringGoalChange?: (agent: Agent) => void, verifyNativeRounds = false, verifyGoalOutcome = false, stepMaxDurationMs?: number,
  options: Pick<GoalsConfig, 'preauthorizedCreateMaxRounds' | 'preauthorizedSchedule' | 'executionBudget' | 'backgroundWake' | 'eventWaits'> = {}, productionPersistence = false) {
  const root = await mkdtemp(join(tmpdir(), 'business-goals-'))
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); new SessionProjectionRegistry(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'),
    ...(productionPersistence ? {} : { compression: 'none' as const, packChunks: false, writeBatchMaxDelayMs: 1 }) })
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: true, persona: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(GoalService)
  const owners = new Map<Agent, string>(); const handles = new Map<Agent, { dispose(): Promise<void> }>(); const human = new Set<Agent>(); let allowed = true; let routeAvailable = true; const deniedActions = new Set<string>()
  const attestation = (agent: Agent) => {
    const principalId = owners.get(agent)
    return principalId === undefined ? undefined : { scope: { workspace: root, preset: 'primary' }, principalId,
      principalLineage: { principalRecordId: `record-${principalId}`, principalVersion: 1 }, bindingId: `binding-${agent.session.id}`, bindingVersion: 1, bindingGeneration: 1, sessionId: String(agent.session.id) }
  }
  // Unit seam only. Actual Delivery owner/turn handling is covered separately
  // in assistant-delivery's real runtime integration test.
  ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: attestation,
    currentPreferenceTurn: (agent: Agent) => human.has(agent) ? attestation(agent) : undefined,
    goalWakeResultVersion: () => 1, goalWakeSettlementVersion: () => 1,
    validateOwnerRoute: ({ authorityId, principalId, workspace, agentPreset }: { authorityId: string; principalId: string; workspace: string; agentPreset: string }) => {
      if (!routeAvailable) throw new Error('owner route revoked')
      return { authorityId, principalId, principalRecordId: `record-${principalId}`, principalVersion: 1, workspace, agentPreset }
    } } as never)
  ctx.provide('assistantPolicy' as never, { authorizeAgent: (_agent: Agent, action: string) => ({ effect: allowed && !deniedActions.has(action) ? 'allow' : 'deny' }),
    evaluateAgent: (_agent: Agent, action: string) => ({ effect: allowed && !deniedActions.has(action) ? 'allow' : 'deny' }), evaluate: () => ({ effect: allowed ? 'allow' : 'deny' }), getBudgetConfig: () => ({ metric: 'automation-runs' }) } as never)
  ctx.provide('assistantAutomations' as never, { registerHostExecutor: () => () => {} } as never)
  ctx.provide('eventTriggers' as never, { sourceSnapshot: () => ({ protocol: 'dsh-event-source/v1', sourceId: 'event-triggers:file', kind: 'file', version: '1', configDigest: 'a'.repeat(64), target: { automationId: 'automation' }, highWaterSequence: 0 }), firstEventAfter: () => undefined, subscribeSourceChanges: () => () => {} } as never)
  if (duringGoalChange !== undefined) ctx.on('goal/changed', ({ agent }) => duringGoalChange(agent))
  const path = databasePath ?? join(root, 'goals.sqlite')
  const plugin = await ctx.plugin(AssistantGoalsService, { databasePath: path, verifyNativeRounds, verifyGoalOutcome,
    ...(maxContextChars === undefined ? {} : { maxContextChars }), ...(stepMaxDurationMs === undefined ? {} : { stepMaxDurationMs }), ...options })
  const create = async (id: string, owner?: string) => {
    const handle = await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd: root, agentPreset: 'primary' }, agentOptions: { provider: 'fixture', model: 'fixture' } })
    if (owner !== undefined) owners.set(handle.agent, owner)
    handles.set(handle.agent, handle)
    cleanups.push(() => handle.dispose())
    return handle.agent
  }
  return { ctx, root, path, plugin, owners, human, create, async dispose(agent: Agent) { await handles.get(agent)?.dispose() }, revokeRoute() { routeAvailable = false }, restoreRoute() { routeAvailable = true }, deny() { allowed = false }, denyAction(action: string) { deniedActions.add(action) }, service: ctx.assistantGoals }
}
const documentAuthority = { kind: 'document' as const, id: 'sources', sources: [{ id: 'source', url: 'https://example.org/source' }], timeoutMs: 1_000, maxResponseBytes: 1_024 }
const [compiledDocumentAuthority] = createVerifierAuthorities({ authorities: [documentAuthority] })
async function installNativeGoalRoundDriver(ctx: Context): Promise<void> {
  const requireFromGoals = createRequire(new URL('../package.json', import.meta.url))
  const entry = requireFromGoals.resolve('@deepseek-ai/dsh-goal-round-driver')
  const driver = await import(pathToFileURL(entry).href) as { inject: readonly string[]; apply(ctx: Context): void }
  await ctx.plugin({ inject: driver.inject, apply: driver.apply } as never, {} as never)
}
function registerReadReportTool(ctx: Context, root: string): void {
  ctx.tools.register(defineTool({
    name: 'read_report',
    description: 'Read the independently verified report artifact.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { content: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.content }],
    },
    async execute() { return { content: await readFile(join(root, 'report.md'), 'utf8') } },
  }))
}

function goalProfiles(root: string, objective: string, options: { version?: number; validityMs?: number; wholeRequiredText?: string; scope?: AcceptanceProfile['scope']; owner?: AcceptanceProfile['owner'] } = {}) {
  const criteria = (id: string, requiredText: string) => [{ id, kind: 'document-citations' as const,
    authority: { id: 'sources', digest: compiledDocumentAuthority!.digest }, artifactPath: 'report.md', requiredText: [requiredText], quotes: [] }]
  const profiles: AcceptanceProfile[] = [
    { id: 'goal-step-profile', version: options.version ?? 1, scope: options.scope ?? { workspace: root, preset: 'primary' }, owner: options.owner ?? { principalRecordId: 'record-owner', principalVersion: 1 },
      taskKind: 'goal-step', objective, validityMs: options.validityMs ?? 10_000, bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 }, criteria: criteria('step', 'Step verified') },
    { id: 'goal-outcome-profile', version: options.version ?? 1, scope: options.scope ?? { workspace: root, preset: 'primary' }, owner: options.owner ?? { principalRecordId: 'record-owner', principalVersion: 1 },
      taskKind: 'goal-outcome', objective, validityMs: options.validityMs ?? 10_000, bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 }, criteria: criteria('whole', options.wholeRequiredText ?? 'Goal verified') },
  ]
  return profiles
}
async function installGoalVerifier(f: Awaited<ReturnType<typeof harness>>, profiles: AcceptanceProfile[]) {
  const plugin = await f.ctx.plugin(AssistantVerifierService, { databasePath: `${f.path}.verifier`, tickIntervalMs: 0, requireAcceptance: true,
    authorities: [documentAuthority], profiles })
  return { dispose: () => plugin.dispose(), service: f.ctx.assistantVerifier }
}
const checkpoint = { nextStep: 'Check repository state', blockers: [], assumptions: [{ statement: 'Latest build was green', expiresAt: 0 }], evidenceRefs: ['run:one'], dependencies: [] }
const scheduleBudget = { modelCalls: 2, toolCalls: 2, inputTokens: 1_000, outputTokens: 1_000, durationMs: 60_000, maxOutputTokensPerCall: 500 }
const scheduleWake = { ownerRouteId: 'route-owner', budgetId: 'wake-budget' }

describe('owner-scoped native goal context', () => {
  it('explains the configured native goal entry only to a live authorized owner turn', async () => {
    const f = await harness(undefined, undefined, undefined, true, true, undefined, { preauthorizedCreateMaxRounds: 3, executionBudget: scheduleBudget })
    const owner = await f.create('entry-owner', 'owner'), other = await f.create('entry-other')
    expect(f.service.snapshot(owner)).toBe('')
    f.human.add(owner)
    expect(f.service.snapshot(owner)).toContain('Only for an explicitly requested finite or continuing goal')
    expect(f.service.snapshot(owner)).toContain('Do not start a goal for greetings or readiness checks')
    expect(f.service.snapshot(owner)).toContain('when the owner requested capture, scheduling, or waiting, omit it or use false')
    expect(f.service.snapshot(owner).toLowerCase()).toContain('this context grants no authority')
    expect(f.service.snapshot(other)).toBe('')
    expect(f.ctx.goals.get(owner)).toBeUndefined()
    f.denyAction('create')
    expect(f.service.snapshot(owner)).toBe('')
  })

  it('shows only complete exact owner acceptance objectives without revealing private checks', async () => {
    const f = await harness(undefined, 1024, undefined, true, true, undefined, { preauthorizedCreateMaxRounds: 3, executionBudget: scheduleBudget })
    const owner = await f.create('entry-profile-owner', 'owner')
    f.human.add(owner)
    const objective = 'Fix the "approved" program <value> {{template}}'
    const own = goalProfiles(f.root, objective, { wholeRequiredText: 'PRIVATE_EXPECTED_OUTPUT' })
    const foreign = goalProfiles(f.root, 'Foreign task', { owner: { principalRecordId: 'record-foreign', principalVersion: 1 } }).map(p => ({ ...p, id: `foreign-${p.id}` }))
    const incomplete = goalProfiles(f.root, 'Missing outcome profile').slice(0, 1).map(p => ({ ...p, id: `incomplete-${p.id}` }))
    const oversized = goalProfiles(f.root, 'x'.repeat(1500)).map(p => ({ ...p, id: `large-${p.id}` }))
    const verifier = await installGoalVerifier(f, [...own, ...foreign, ...incomplete, ...oversized])
    const context = f.service.snapshot(owner)
    expect(context).toContain('<approved-goal-objective>\nFix the "approved" program &lt;value&gt; &#123;&#123;template&#125;&#125;\n</approved-goal-objective>')
    expect(context).not.toContain('\\"approved\\"')
    expect(context).not.toContain('{{template}}')
    expect(context).not.toContain('PRIVATE_EXPECTED_OUTPUT')
    expect(context).not.toContain('Foreign task')
    expect(context).not.toContain('Missing outcome profile')
    expect(context).not.toContain('xxx')
    expect(context.length).toBeLessThanOrEqual(1024)
    expect(f.ctx.goals.get(owner)).toBeUndefined()
    f.owners.set(owner, 'foreign')
    expect(f.service.snapshot(owner)).not.toContain('Fix the "approved" program')
    f.owners.set(owner, 'owner')
    await verifier.dispose()
    expect(f.service.snapshot(owner)).not.toContain('Fix the "approved" program')
  })

  it.each(['repository-readback', 'readback'] as const)('preauthorizes only compiled safe outcome authority (%s)', async kind => {
    const route = { provider: 'fixture', model: 'fixture' }
    const f = await harness(undefined, undefined, undefined, true, true, 1_000, { preauthorizedCreateMaxRounds: 2,
      executionBudget: { mode: 'calls', modelCalls: 4, toolCalls: 4, durationMs: 120_000, maxOutputTokensPerCall: 500, routes: [route] } })
    const agent = await f.create(`preauth-${kind}`, 'owner'); f.human.add(agent)
    const objective = 'Verify repository outcome'
    const isolated = { kind: 'isolated-runner' as const, id: 'isolated', stateRoot: join(f.root, 'verification'), image: `sha256:${'a'.repeat(64)}`,
      dockerPath: realpathSync(process.execPath), command: 'cat /workspace/artifact', expiresAt: Date.now() + 300_000,
      maxRuns: 4, maxTotalDurationMs: 10_000, maxDurationMs: 1_000, maxOutputBytes: 1024, testSets: [{ id: 'cases', cases: [{ stdin: '', expectedStdout: 'ok', expectedExitCode: 0 }] }] }
    const remote = kind === 'repository-readback'
      ? { kind, id: 'remote', grantId: 'repository', grantRevision: 1, repository: 'octo/example', branch: 'automation/fix', baseBranch: 'main',
          requiredChecks: [{ name: 'tests', appId: 42 }], reviewerIds: [], minApprovals: 0, timeoutMs: 1_000, freshnessMs: 5_000 }
      : { kind, id: 'remote', urlTemplate: 'https://example.org/{id}', objectIdPointer: '/id', timeoutMs: 1_000, maxResponseBytes: 1024 }
    const authorities = createVerifierAuthorities({ authorities: [isolated, remote] })
    const profiles = goalProfiles(f.root, objective, { validityMs: 120_000 }).map(profile => ({ ...profile, criteria: profile.taskKind === 'goal-step'
      ? [{ id: 'step', kind: 'isolated-process-behavior' as const, authority: { id: authorities[0]!.id, digest: authorities[0]!.digest }, artifactPath: 'result.txt', testSetId: 'cases' }]
      : [{ id: 'whole', kind: 'target-readback' as const, authority: { id: authorities[1]!.id, digest: authorities[1]!.digest }, objectId: 'octo/example:automation/fix', expected: [{ pointer: '/ready', value: true }] }] }))
    await f.ctx.plugin(AssistantVerifierService, { databasePath: `${f.path}.verifier`, tickIntervalMs: 0, requireAcceptance: true, authorities: [isolated, remote], profiles })
    const execution = { agent, arguments: { objective, max_goal_rounds: 2 }, signal: new AbortController().signal } as never
    expect(f.service.preauthorizeCreate(execution)).toBe(kind === 'repository-readback')
    f.denyAction('create'); expect(f.service.preauthorizeCreate(execution)).toBe(false)
  })

  it('keeps goal schedule preauthorization disabled by default', async () => {
    const f = await harness()
    expect(f.service.preauthorizedCreateEnabled).toBe(false)
    expect(f.service.preauthorizedScheduleEnabled).toBe(false)
    expect(f.service.eventWaitsEnabled).toBe(false)
    expect(Reflect.set(f.service, 'eventWaitsEnabled', true)).toBe(false)
    expect(Object.getOwnPropertyDescriptor(f.service, 'preauthorizedCreateEnabled')).toMatchObject({ value: false, writable: false, configurable: false })
    expect(Object.getOwnPropertyDescriptor(f.service, 'preauthorizedScheduleEnabled')).toMatchObject({ value: false, writable: false, configurable: false })
    expect(Reflect.set(f.service, 'preauthorizedScheduleEnabled', true)).toBe(false)
    expect(f.service.preauthorizedScheduleEnabled).toBe(false)
  })

  it('requires every durable prerequisite before enabling schedule preauthorization', async () => {
    await expect(harness(undefined, undefined, undefined, false, true, undefined, {
      preauthorizedSchedule: true, executionBudget: scheduleBudget, backgroundWake: scheduleWake,
    })).rejects.toThrow('execution budget requires verified native rounds')
    await expect(harness(undefined, undefined, undefined, true, true, undefined, {
      preauthorizedSchedule: true, executionBudget: scheduleBudget,
    })).rejects.toThrow('preauthorized schedule requires durable wake')
    await expect(harness(undefined, undefined, undefined, true, false, undefined, {
      preauthorizedSchedule: true, executionBudget: scheduleBudget, backgroundWake: scheduleWake,
    })).rejects.toThrow('preauthorized schedule requires durable wake')
  })

  it('requires durable verified outcome and wake prerequisites for event waits', async () => {
    await expect(harness(undefined, undefined, undefined, true, false, undefined, {
      eventWaits: true, executionBudget: scheduleBudget, backgroundWake: scheduleWake,
    })).rejects.toThrow('event waits require durable wake, budgets and verified outcomes')
    await expect(harness(undefined, undefined, undefined, true, true, undefined, {
      eventWaits: true, executionBudget: scheduleBudget,
    })).rejects.toThrow('event waits require durable wake, budgets and verified outcomes')
  })

  it.each(['success', 'storage-failure', 'trailing-tool', 'multiple-steps', 'compressed-persistence'] as const)('drives an admitted native event wait without an owner turn: %s', async scenario => {
    const nativeBudget = { mode: 'calls' as const, modelCalls: 4, toolCalls: 4, durationMs: 60_000, maxOutputTokensPerCall: 500, routes: [{ provider: 'fixture', model: 'fixture' }] }
    const f = await harness(undefined, undefined, undefined, true, true, 2_000, { eventWaits: true, executionBudget: nativeBudget, backgroundWake: scheduleWake }, scenario === 'compressed-persistence')
    await installNativeGoalRoundDriver(f.ctx)
    const agent = await f.create('native-event-wait', 'owner'); f.human.add(agent)
    const objective = 'Pause the admitted goal for an event'; await installGoalVerifier(f, goalProfiles(f.root, objective))
    const lateTool = vi.fn(async () => ({ result: 'must not execute' }))
    f.ctx.tools.register(defineTool({ name: 'late_probe', description: 'Test paused-round fence', parameters: {}, output: { schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.result }] }, execute: lateTool }))
    const failedAction = vi.fn(async () => ({ result: 'Action exited 1; no artifact produced.' }))
    f.ctx.tools.register(defineTool({ name: 'failed_action', description: 'Return an ordinary failed action payload', parameters: {}, output: { schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.result }] }, execute: failedAction }))
    if (scenario === 'storage-failure') {
      const spy = vi.spyOn(GoalEventWaitStore.prototype, 'prepare').mockImplementation(() => { throw new Error('unavailable wait storage') })
      cleanups.push(async () => { spy.mockRestore() })
    }
    let calls = 0; let record!: ReturnType<AssistantGoalsService['create']>
    class Adapter extends LlmAdapter { async *stream(): AsyncIterable<StreamChunk> {
      calls++
      if (calls === 1) { yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ready' } }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
      f.human.delete(agent)
      if (scenario === 'multiple-steps' && calls < 4) {
        const id = ToolCallId(`failed-action-${calls}`)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'failed_action', argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'failed_action', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
      }
      const argumentsText = JSON.stringify({ goal_id: record.id, expected_revision: record.native.revision, trigger_id: 'file', expires_at: Date.now() + 10_000 })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'tool-call-delta', index: 0, id: ToolCallId('wait-event'), name: 'goal_wait_event', argumentsDelta: argumentsText }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('wait-event'), name: 'goal_wait_event', arguments: argumentsText } }
      if (scenario === 'trailing-tool') {
        yield { type: 'block-start', index: 1, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 1, id: ToolCallId('late-probe'), name: 'late_probe', argumentsDelta: '{}' }
        yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('late-probe'), name: 'late_probe', arguments: '{}' } }
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } }
    f.ctx.llm.registerAdapter(['fixture'], new Adapter())
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'prepare goal' }] }))
    await vi.waitFor(() => expect(calls).toBe(1), { timeout: 2_000 }); await agent.whenIdle()
    record = f.service.create(agent, objective, 2)
    await vi.waitFor(() => expect(f.ctx.goals.get(agent)?.roundsStarted).toBe(1), { timeout: 2_000 })
    const expectedCalls = scenario === 'multiple-steps' ? 4 : 2
    try { await vi.waitFor(() => expect(calls).toBe(expectedCalls), { timeout: 2_000 }) } catch {
      throw new Error(JSON.stringify({ native: f.ctx.goals.get(agent), runs: f.service.executionRuns(agent, record.id), events: agent.session.snapshotEvents().map(event => ({ type: event.type, data: event.data })) }))
    }
    await agent.whenIdle(); await f.service.whenIdle()
    expect(f.service.inspect(agent, record.id).native).toMatchObject({ phase: 'paused', revision: record.native.revision + 1 })
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    const waitResults = results.flatMap(event => event.data.message.content).filter(block => block.type === 'tool-result' && block.toolCallId === 'wait-event')
    expect(waitResults).toHaveLength(1)
    expect(waitResults[0], JSON.stringify(results)).toMatchObject({ isError: scenario === 'storage-failure' })
    expect(f.human.has(agent)).toBe(false); expect(calls).toBe(expectedCalls); expect(lateTool).not.toHaveBeenCalled()
    expect(failedAction).toHaveBeenCalledTimes(scenario === 'multiple-steps' ? 2 : 0)
    if (scenario === 'storage-failure') {
      expect(f.service.eventWaitsForGoal(agent, record.id)).toEqual([])
      expect(f.service.executionRuns(agent, record.id)).toMatchObject([{ execution: { status: 'unknown', quiescent: false } }])
    } else {
      expect(f.service.eventWaitsForGoal(agent, record.id)).toMatchObject([{ state: 'waiting' }])
      expect(f.service.executionRuns(agent, record.id)).toMatchObject([{ execution: { status: 'succeeded', quiescent: true } }])
    }
  })

  it('reports an exact Agent settlement while a verified event wait flushes durably', async () => {
    const nativeBudget = { mode: 'calls' as const, modelCalls: 4, toolCalls: 4, durationMs: 60_000, maxOutputTokensPerCall: 500, routes: [{ provider: 'fixture', model: 'fixture' }] }
    const f = await harness(undefined, undefined, undefined, true, true, 2_000, { eventWaits: true, executionBudget: nativeBudget, backgroundWake: scheduleWake })
    await installNativeGoalRoundDriver(f.ctx)
    const agent = await f.create('native-event-wait-settlement', 'owner'); f.human.add(agent)
    const objective = 'Pause only after the verified event wait is durable'; await installGoalVerifier(f, goalProfiles(f.root, objective))
    let record!: ReturnType<AssistantGoalsService['create']>; let calls = 0; let waitIssued = false
    // The first request is the owner turn; the native round is deterministically turn 2.
    const nativeTurn = 2
    class Adapter extends LlmAdapter { async *stream(): AsyncIterable<StreamChunk> {
      calls += 1
      if (calls === 1) { yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ready' } }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
      f.human.delete(agent)
      const argumentsText = JSON.stringify({ goal_id: record.id, expected_revision: record.native.revision, trigger_id: 'file', expires_at: Date.now() + 10_000 })
      waitIssued = true
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'tool-call-delta', index: 0, id: ToolCallId('settlement-wait-event'), name: 'goal_wait_event', argumentsDelta: argumentsText }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('settlement-wait-event'), name: 'goal_wait_event', arguments: argumentsText } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } }
    f.ctx.llm.registerAdapter(['fixture'], new Adapter())
    let releaseFlush!: () => void; const flushGate = new Promise<void>(resolve => { releaseFlush = resolve }); let terminalFlushStarted = false
    const originalFlush = f.ctx.sessions.flush.bind(f.ctx.sessions)
    const flush = vi.spyOn(f.ctx.sessions, 'flush').mockImplementation(async session => {
      const nativeTurnEnded = agent.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data.turn === nativeTurn)
      if (waitIssued && nativeTurnEnded && session === agent.session && f.service.hasPendingExecutionSettlement(agent)) {
        terminalFlushStarted = true; await flushGate
      }
      return await originalFlush(session)
    })
    try {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'prepare goal' }] }))
      await vi.waitFor(() => expect(calls).toBe(1), { timeout: 2_000 }); await agent.whenIdle()
      record = f.service.create(agent, objective, 2)
      await vi.waitFor(() => expect(f.ctx.goals.get(agent)?.roundsStarted).toBe(1), { timeout: 2_000 })
      await vi.waitFor(() => expect(terminalFlushStarted).toBe(true), { timeout: 2_000 })
      expect(agent.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data.turn === nativeTurn)).toBe(true)
      expect(f.service.executionRuns(agent, record.id)).toMatchObject([{ dispatchedAt: expect.any(Number) }])
      expect(f.ctx.goals.get(agent)).toMatchObject({ phase: 'paused' })
      expect(f.service.hasPendingExecutionSettlement(agent)).toBe(true)
      releaseFlush()
      await agent.whenIdle()
      await f.service.whenIdle()
      expect(f.service.hasPendingExecutionSettlement(agent)).toBe(false)
      expect(f.service.eventWaitsForGoal(agent, record.id)).toMatchObject([{ state: 'waiting' }])
      expect(f.service.executionRuns(agent, record.id)).toMatchObject([{ execution: { status: 'succeeded', quiescent: true } }])
    } finally { releaseFlush(); flush.mockRestore() }
  })

  it('exposes an immutable enabled schedule gate only for a durable verified configuration', async () => {
    const f = await harness(undefined, undefined, undefined, true, true, undefined, {
      preauthorizedSchedule: true, executionBudget: scheduleBudget, backgroundWake: scheduleWake,
    })
    expect(f.service.preauthorizedScheduleEnabled).toBe(true)
    expect(Object.getOwnPropertyDescriptor(f.service, 'preauthorizedScheduleEnabled')).toMatchObject({ value: true, writable: false, configurable: false })
    expect(Reflect.set(f.service, 'preauthorizedScheduleEnabled', false)).toBe(false)
    expect(f.service.preauthorizedScheduleEnabled).toBe(true)
  })

  it('returns only the current active owner-scoped task projection and refreshes edits', async () => {
    const f = await harness(); const agent = await f.create('task-context', 'owner'); f.human.add(agent)
    const created = f.service.create(agent, 'Original current objective')
    expect(f.service.inspectActiveWorkflowCaptureContext(agent, created.id)).toMatchObject({ scope: created.scope, goalId: created.id,
      sessionId: String(agent.session.id), nativeGoalId: created.native.goalId, definition: created.definition })
    expect(() => f.service.inspectActiveWorkflowCaptureContext(agent, created.native.goalId)).toThrow(`Use business goal_id ${created.id} returned by goal_create/goal_context`)
    expect(f.service.taskContext(agent)).toMatchObject({ protocol: 'goal-task-context/v1', active: true,
      scope: created.scope, goal: { id: created.id, definition: { version: created.definition.version, digest: created.definition.digest }, native: { goalId: created.native.goalId }, objective: 'Original current objective' }, checkpoint: { nextStep: '' } })
    const checkpointed = f.service.checkpoint(agent, created.id, created.version, { ...checkpoint, nextStep: 'Inspect the changed source' })
    const edited = f.service.control(agent, { goalId: created.id, expectedRevision: checkpointed.native.revision, operation: 'edit', objective: 'Edited current objective' })
    expect(f.service.taskContext(agent)).toMatchObject({ goal: { id: edited.id, definition: { version: edited.definition.version, digest: edited.definition.digest }, native: { revision: edited.native.revision }, objective: 'Edited current objective' }, checkpoint: { nextStep: 'Inspect the changed source' } })
    const other = await f.create('task-context-other', 'other')
    expect(f.service.taskContext(other)).toBeUndefined()
    f.owners.delete(agent)
    expect(f.service.taskContext(agent)).toBeUndefined()
    f.owners.set(agent, 'owner')
    expect(f.service.taskContext(agent)?.goal.id).toBe(edited.id)
    f.ctx.goals.complete(agent, { id: edited.native.goalId as never, revision: edited.native.revision })
    expect(f.service.taskContext(agent)).toBeUndefined()
  })

  it('uses an explicit same-owner focus as retrieval context but hides it when snapshot authority is revoked', async () => {
    const f = await harness(); const first = await f.create('task-focus-first', 'owner'); const second = await f.create('task-focus-second', 'owner')
    f.human.add(first); const record = f.service.create(first, 'Focused owner objective')
    const saved = f.service.checkpoint(first, record.id, record.version, { ...checkpoint, nextStep: 'Use focused next step' })
    f.service.focus(second, saved.id)
    expect(f.service.taskContext(second)).toMatchObject({ active: true, goal: { id: saved.id, definition: { version: saved.definition.version, digest: saved.definition.digest } }, checkpoint: { nextStep: 'Use focused next step' } })
    f.denyAction('snapshot')
    expect(f.service.taskContext(second)).toBeUndefined()
  })

  it('drops a previously achieved feedback result when the Host verifier is unloaded', async () => {
    const f = await harness(undefined, undefined, undefined, true)
    const agent = await f.create('feedback-unload', 'owner'); f.human.add(agent)
    const record = f.service.create(agent, 'Check independent evidence')
    const now = Date.now()
    const task = { kind: 'goal-step' as const, ref: 'feedback-run', goal: { id: record.id,
      definitionVersion: record.definition.version, definitionDigest: record.definition.digest,
      stepId: 'round-1', runId: 'feedback-run', sessionId: record.native.sessionId,
      nativeGoalId: record.native.goalId, nativeRevision: record.native.revision } }
    const contract = createTaskAcceptanceContract({ protocol: 'task-acceptance/v2', id: 'feedback-contract', task,
      objective: record.definition.objective, scope: { workspace: f.root, preset: 'primary' },
      owner: { principalRecordId: record.scope.principalRecordId, principalVersion: record.scope.principalVersion },
      profile: { id: 'feedback-profile', version: 1, digest: 'a'.repeat(64) }, issuedAt: now, expiresAt: now + 60_000,
      criteria: [{ id: 'result', kind: 'document-citations', authority: { id: 'source', digest: 'a'.repeat(64) }, artifactPath: 'report.md', requiredText: ['Done'], quotes: [] }],
      bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 } })
    const execution = { status: 'succeeded' as const, quiescent: true, completedAt: now }
    const store = new GoalExecutionStore(`${f.path}.executions`)
    try {
      store.prepare({ runId: task.ref, task, scope: record.scope, objective: record.definition.objective,
        admission: { issuedAt: now, expiresAt: now + 60_000, maxGoalRounds: 3, round: 1,
          authorizationDigest: acceptanceDigest({ scope: record.scope, action: 'execute', resource: { kind: 'goal', id: 'business-context' } }) } })
      store.bindAcceptance(task.ref, { contractId: contract.id, contractDigest: contract.digest })
      store.markDispatched(task.ref, now); store.finish(task.ref, execution)
    } finally { store.close() }
    const receipt = createTaskVerificationReceipt(contract, { protocol: 'task-verification/v2', id: 'feedback-receipt',
      contractId: contract.id, contractDigest: contract.digest, scope: contract.scope, owner: contract.owner, task,
      results: [{ criterionId: 'result', status: 'passed', reason: 'verified', evidence: [] }],
      startedAt: now, completedAt: now, validUntil: now + 60_000 })
    // Read-only Host seam; the real producer/Verifier path is tested in Delivery.
    const verifier = await f.ctx.plugin((ctx: Context) => {
      ctx.provide('assistantVerifier', { inspectAcceptedTask: () => ({ contract, receipt, execution: { ...execution, executionRef: task.ref } }) } as never)
    })
    expect(f.service.describeForAgent(agent, record.id)).toContain('"status":"achieved"')
    await verifier.dispose()
    expect(f.service.describeForAgent(agent, record.id)).toContain('"status":"unavailable"')
    expect(f.service.snapshot(agent)).not.toContain('"status":"achieved"')
  })

  it('scopes feedback inspection and refreshes authorization after asynchronous prompt assembly', async () => {
    const f = await harness(undefined, undefined, undefined, true)
    const agent = await f.create('feedback-owner', 'owner'); f.human.add(agent)
    const record = f.service.create(agent, 'Private feedback objective')
    expect(f.service.describeForAgent(agent, record.id)).toContain('assistant-goals/feedback/v1')
    const other = await f.create('feedback-other', 'other')
    expect(() => f.service.describeForAgent(other, record.id)).toThrow('goal not found')
    expect(() => f.service.describeForAgent({ ...agent } as Agent, record.id)).toThrow('exact live agent')
    f.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const result = await next()
      f.owners.delete(agent)
      return result
    })
    const assembly = await f.ctx.systemPrompt.assemble({ agent })
    expect(assembly.contexts.find(item => item.name === 'assistant-goals:current-context')?.text).toBe('')
    expect(JSON.stringify(assembly.contexts)).not.toContain('Private feedback objective')
  })

  it('binds only newly created goals in a current owner turn; never adopts old unbound goals', async () => {
    const f = await harness(); const agent = await f.create('unowned')
    f.ctx.goals.create(agent, { objective: 'Private old goal' })
    f.owners.set(agent, 'owner'); f.human.add(agent)
    expect(f.service.list(agent)).toEqual([])
    const old = f.ctx.goals.get(agent)!
    f.ctx.goals.edit(agent, old, { objective: 'Do not retroactively adopt' })
    expect(f.service.list(agent)).toEqual([])
    f.ctx.goals.clear(agent, f.ctx.goals.get(agent)!)
    f.ctx.goals.create(agent, { objective: 'New owner-authorized goal' })
    expect(f.service.list(agent)).toHaveLength(1)
    expect(() => f.service.list({ ...agent } as Agent)).toThrow('exact live agent')
  })

  it('creates through the owner bridge only in the current human turn and preserves native exclusivity', async () => {
    const f = await harness(); const agent = await f.create('bridge', 'owner')
    expect(() => f.service.create(agent, 'Requested objective', 2)).toThrow('current authenticated owner turn')
    expect(f.ctx.goals.get(agent)).toBeUndefined()
    f.human.add(agent)
    const record = f.service.create(agent, 'Requested objective', 2)
    expect(record.native).toMatchObject({ objective: 'Requested objective', maxGoalRounds: 2 })
    expect(f.ctx.goals.get(agent)?.id).toBe(record.native.goalId)
    expect(() => f.service.create(agent, 'Do not replace the first goal')).toThrow()
    f.ctx.goals.complete(agent, f.ctx.goals.get(agent)!)
    const next = f.service.create(agent, 'A new native goal after completion', 2)
    expect(next.id).not.toBe(record.id)
    expect(f.service.list(agent)).toHaveLength(2)
    expect(f.service.inspect(agent, record.id)).toMatchObject({ originalObjective: 'Requested objective', native: { phase: 'complete' } })
    expect(f.service.describe(f.service.inspect(agent, record.id))).toContain('awaiting-verification')
    f.deny()
    expect(() => f.service.create(agent, 'Denied')).toThrow('policy denied')
  })

  it('preserves original objective, records clear/complete without claiming verified success, and rechecks policy', async () => {
    const f = await harness(); const agent = await f.create('changes', 'owner'); f.human.add(agent)
    f.ctx.goals.create(agent, { objective: 'Original objective' })
    let record = f.service.list(agent)[0]!
    record = f.service.checkpoint(agent, record.id, record.version, checkpoint)
    f.ctx.goals.edit(agent, f.ctx.goals.get(agent)!, { objective: 'Revised objective' })
    expect(f.service.inspect(agent, record.id)).toMatchObject({ originalObjective: 'Original objective', native: { objective: 'Revised objective' } })
    f.ctx.goals.complete(agent, f.ctx.goals.get(agent)!)
    expect(f.service.snapshot(agent)).toContain('awaiting-verification')
    f.ctx.goals.clear(agent, f.ctx.goals.get(agent)!)
    expect(f.service.inspect(agent, record.id).native.phase).toBe('cleared')
    f.deny()
    expect(f.service.snapshot(agent)).toBe('')
    expect(() => f.service.inspect(agent, record.id)).toThrow('policy denied')
  })

  it('focuses cross-session context for the same owner without creating or resuming native goals', async () => {
    const f = await harness(); const first = await f.create('first', 'owner'); f.human.add(first)
    f.ctx.goals.create(first, { objective: 'Investigate <system>{{secret}}</system>' })
    let record = f.service.list(first)[0]!
    record = f.service.checkpoint(first, record.id, record.version, checkpoint)
    const second = await f.create('second', 'owner')
    f.service.focus(second, record.id)
    const text = f.service.snapshot(second)
    expect(text).toContain('Check repository state'); expect(text).toContain('"stale":true')
    expect(text).not.toContain('<system>'); expect(text).not.toContain('{{secret}}')
    expect(f.ctx.goals.get(second)).toBeUndefined()
    expect(f.ctx.goals.get(first)?.roundsStarted).toBe(0)
    const other = await f.create('foreign', 'other')
    expect(f.service.list(other)).toEqual([])
    expect(() => f.service.focus(other, record.id)).toThrow('goal not found')
    expect(() => f.service.checkpoint(other, record.id, record.version, checkpoint)).toThrow()
  })

  it('bounds escaped context and catalog, replaces focus on a new native goal, and drops revoked ownership', async () => {
    const f = await harness(undefined, 1024)
    const first = await f.create('budget-first', 'owner'); f.human.add(first)
    f.ctx.goals.create(first, { objective: '<{&>'.repeat(300) })
    const old = f.service.list(first)[0]!
    expect(f.service.snapshot(first)).toContain('exceeds the configured budget')
    const second = await f.create('budget-second', 'owner'); f.human.add(second)
    f.service.focus(second, old.id)
    f.ctx.goals.create(second, { objective: 'New short goal' })
    expect(f.service.snapshot(second)).toContain('New short goal')
    expect(f.service.snapshot(second).length).toBeLessThanOrEqual(1024)
    expect(f.service.catalog(second).length).toBeLessThanOrEqual(1024)
    f.owners.delete(second)
    expect(f.service.snapshot(second)).toBe('')
    expect(() => f.service.inspect(second, old.id)).toThrow('authenticated owner required')
  })

  it('persists a focus across service reload and injects fresh context through a real AgentLoop request', async () => {
    const f = await harness(); const agent = await f.create('live', 'owner'); f.human.add(agent)
    f.ctx.goals.create(agent, { objective: 'Continue after reload' })
    const record = f.service.list(agent)[0]!
    f.service.checkpoint(agent, record.id, record.version, checkpoint)
    await f.plugin.dispose()
    await f.ctx.plugin(AssistantGoalsService, { databasePath: f.path })
    const requests: GenerateOptions[] = []
    class Adapter extends LlmAdapter { async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'Working' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Working' } }; yield { type: 'finish', reason: { kind: 'stop' } }
    } }
    f.ctx.llm.registerAdapter(['fixture'], new Adapter())
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue the goal' }] }))
    await agent.whenIdle()
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0]!.messages)).toContain('Check repository state')
    expect(agent.session.snapshotEvents().some(event => event.type === 'user/message' && JSON.stringify(event.data).includes('Check repository state'))).toBe(true)
    expect(f.ctx.assistantGoals.snapshot(agent)).toContain('Continue after reload')
  })

  it('controls only the current session binding through native CAS and retains business history', async () => {
    const f = await harness(); const first = await f.create('control-first', 'owner'); f.human.add(first)
    f.ctx.goals.create(first, { objective: 'Original control objective', maxGoalRounds: 3 })
    let record = f.service.list(first)[0]!
    record = f.service.checkpoint(first, record.id, record.version, checkpoint)
    const edited = f.service.control(first, { goalId: record.id, expectedRevision: record.native.revision, operation: 'edit', objective: 'Edited control objective' })
    expect(edited).toMatchObject({ originalObjective: 'Original control objective', checkpoint, native: { objective: 'Edited control objective', phase: 'active' } })
    const paused = f.service.control(first, { goalId: record.id, expectedRevision: edited.native.revision, operation: 'pause' })
    expect(paused.native.phase).toBe('paused')
    const resumed = f.service.control(first, { goalId: record.id, expectedRevision: paused.native.revision, operation: 'resume' })
    expect(resumed.native).toMatchObject({ phase: 'active', revision: paused.native.revision + 1 })
    const beforeStale = f.ctx.goals.get(first)!
    expect(() => f.service.control(first, { goalId: record.id, expectedRevision: paused.native.revision, operation: 'pause' })).toThrow()
    expect(f.ctx.goals.get(first)).toEqual(beforeStale)
    const second = await f.create('control-second', 'owner'); f.human.add(second)
    f.service.focus(second, record.id)
    expect(() => f.service.control(second, { goalId: record.id, expectedRevision: resumed.native.revision, operation: 'clear' })).toThrow('current session')
    expect(f.ctx.goals.get(first)).toMatchObject({ id: resumed.native.goalId, revision: resumed.native.revision })
    const cleared = f.service.control(first, { goalId: record.id, expectedRevision: resumed.native.revision, operation: 'clear' })
    expect(cleared.native.phase).toBe('cleared')
    expect(f.ctx.goals.get(first)).toBeUndefined()
    await f.plugin.dispose()
    await f.ctx.plugin(AssistantGoalsService, { databasePath: f.path })
    expect(f.ctx.assistantGoals.inspect(first, record.id).native.phase).toBe('cleared')
  })

  it('requires the live owner turn and per-operation policy before control CAS', async () => {
    const f = await harness(); const agent = await f.create('control-guard', 'owner')
    f.human.add(agent); f.ctx.goals.create(agent, { objective: 'Guarded goal' })
    const record = f.service.list(agent)[0]!
    f.human.delete(agent)
    expect(() => f.service.control(agent, { goalId: record.id, expectedRevision: record.native.revision, operation: 'pause' })).toThrow('current authenticated owner turn')
    expect(f.ctx.goals.get(agent)?.phase).toBe('active')
    f.human.add(agent); f.denyAction('pause')
    expect(() => f.service.control(agent, { goalId: record.id, expectedRevision: record.native.revision, operation: 'pause' })).toThrow('policy denied')
    expect(f.ctx.goals.get(agent)?.phase).toBe('active')
    f.owners.delete(agent)
    expect(() => f.service.control(agent, { goalId: record.id, expectedRevision: record.native.revision, operation: 'pause' })).toThrow('authenticated owner required')
  })

  it('rejects malformed direct control input before native mutation', async () => {
    const f = await harness(); const agent = await f.create('control-input', 'owner'); f.human.add(agent)
    f.ctx.goals.create(agent, { objective: 'Input goal' })
    const record = f.service.list(agent)[0]!
    expect(() => f.service.control(agent, { goalId: record.id, expectedRevision: record.native.revision, operation: 'edit' })).toThrow('invalid control input')
    expect(() => f.service.control(agent, { goalId: record.id, expectedRevision: record.native.revision, operation: 'pause', objective: 'nope' } as never)).toThrow('invalid control input')
    expect(() => f.service.control(agent, { goalId: record.id, expectedRevision: 0, operation: 'pause' })).toThrow('invalid control input')
    expect(f.ctx.goals.get(agent)).toMatchObject({ id: record.native.goalId, revision: record.native.revision, phase: 'active' })
  })

  it('reports a partial commit when owner revocation prevents the native change from being projected', async () => {
    let revoke = false
    let f!: Awaited<ReturnType<typeof harness>>
    f = await harness(undefined, undefined, agent => { if (revoke) f.owners.delete(agent) })
    const agent = await f.create('control-partial', 'owner'); f.human.add(agent)
    f.ctx.goals.create(agent, { objective: 'Projection failure goal' })
    const record = f.service.list(agent)[0]!
    revoke = true
    expect(() => f.service.control(agent, { goalId: record.id, expectedRevision: record.native.revision, operation: 'pause' }))
      .toThrow('native goal changed but business context could not be read back')
    expect(f.ctx.goals.get(agent)).toMatchObject({ id: record.native.goalId, phase: 'paused', revision: record.native.revision + 1 })
  })

  it('does not return projected goal data when a later native listener revokes the owner', async () => {
    const f = await harness(); const agent = await f.create('control-late-revocation', 'owner'); f.human.add(agent)
    f.ctx.goals.create(agent, { objective: 'Late revocation goal' })
    const record = f.service.list(agent)[0]!
    f.ctx.on('goal/changed', ({ agent: changed }) => { if (changed === agent) f.owners.delete(agent) })
    expect(() => f.service.control(agent, { goalId: record.id, expectedRevision: record.native.revision, operation: 'pause' }))
      .toThrow('native goal changed but business context could not be read back')
    expect(f.ctx.goals.get(agent)).toMatchObject({ id: record.native.goalId, phase: 'paused', revision: record.native.revision + 1 })
    f.owners.set(agent, 'owner')
    expect(f.service.inspect(agent, record.id).native.phase).toBe('paused')
  })

  it('normalizes control input before synchronous native change listeners can mutate the caller object', async () => {
    let mutate = false
    const input = { goalId: '', expectedRevision: 0, operation: 'pause' as const }
    const f = await harness(undefined, undefined, () => { if (mutate) input.expectedRevision = 999 })
    const agent = await f.create('control-snapshot', 'owner'); f.human.add(agent)
    f.ctx.goals.create(agent, { objective: 'Snapshot goal' })
    const record = f.service.list(agent)[0]!
    input.goalId = record.id; input.expectedRevision = record.native.revision
    mutate = true
    const paused = f.service.control(agent, input)
    expect(paused.native).toMatchObject({ phase: 'paused', revision: record.native.revision + 1 })
    expect(input.expectedRevision).toBe(999)
  })

  it('rejects goal creation before native, business, or verifier state exists when whole-goal preflight is incomplete or mismatched', async () => {
    const assertUnchanged = (f: Awaited<ReturnType<typeof harness>>, agent: Agent, verifier?: { service: AssistantVerifierService }) => {
      expect(f.ctx.goals.get(agent)).toBeUndefined()
      expect(f.service.list(agent)).toEqual([])
      if (verifier !== undefined) {
        expect(verifier.service.health()).toMatchObject({ awaitingExecution: 0, pendingVerification: 0, pendingReceipts: 0 })
        const db = new DatabaseSync(`${f.path}.verifier`, { readOnly: true })
        try { expect(db.prepare('SELECT id FROM acceptance_contracts').all()).toEqual([]) } finally { db.close() }
      }
    }
    const absent = await harness(undefined, undefined, undefined, true, true, 1_000)
    const absentAgent = await absent.create('preflight-absent', 'owner'); absent.human.add(absentAgent)
    expect(() => absent.service.create(absentAgent, 'No verifier')).toThrow('whole-goal verifier unavailable')
    assertUnchanged(absent, absentAgent)

    for (const [id, profiles, objective] of [
      ['missing-step', goalProfiles('', 'Missing step').filter(profile => profile.taskKind === 'goal-outcome'), 'Missing step'],
      ['missing-whole', goalProfiles('', 'Missing whole').filter(profile => profile.taskKind === 'goal-step'), 'Missing whole'],
      ['wrong-owner', goalProfiles('', 'Wrong owner', { owner: { principalRecordId: 'record-other', principalVersion: 1 } }), 'Wrong owner'],
      ['wrong-scope', goalProfiles('', 'Wrong scope', { scope: { workspace: '/tmp/foreign-goal-scope', preset: 'primary' } }), 'Wrong scope'],
      ['wrong-objective', goalProfiles('', 'Other objective'), 'Wanted objective'],
    ] as const) {
      const f = await harness(undefined, undefined, undefined, true, true, 1_000)
      const agent = await f.create(id, 'owner'); f.human.add(agent)
      const bound = profiles.map(profile => ({ ...profile, scope: profile.scope.workspace === '' ? { ...profile.scope, workspace: f.root } : profile.scope }))
      const verifier = await installGoalVerifier(f, bound)
      expect(() => f.service.create(agent, objective)).toThrow(/exact goal-step|whole-goal success specification/)
      assertUnchanged(f, agent, verifier)
    }
  })

  it('trims an objective for exact preflight selection and freezes whole-goal conditions before create returns', async () => {
    const f = await harness(undefined, undefined, undefined, true, true, 1_000)
    const agent = await f.create('preflight-trim', 'owner'); f.human.add(agent)
    await installGoalVerifier(f, goalProfiles(f.root, 'Trimmed objective'))
    const record = f.service.create(agent, '  Trimmed objective  ')
    expect(record.native.objective).toBe('Trimmed objective')
    expect(f.service.inspectGoalOutcome(agent, record.id)).toMatchObject({ definitionVersion: record.definition.version,
      conditions: { profileId: 'goal-outcome-profile', profileVersion: 1, criteria: expect.any(Array), expiresAt: expect.any(Number) } })
  })

  it('preflights objective edits without changing the old native revision or frozen definition, then freezes exact replacement profiles', async () => {
    const f = await harness(undefined, undefined, undefined, true, true, 1_000)
    const agent = await f.create('preflight-edit', 'owner'); f.human.add(agent)
    let verifier = await installGoalVerifier(f, goalProfiles(f.root, 'Initial objective'))
    const original = f.service.create(agent, 'Initial objective')
    const originalOutcome = f.service.inspectGoalOutcome(agent, original.id)!
    expect(() => f.service.control(agent, { goalId: original.id, expectedRevision: original.native.revision, operation: 'edit', objective: 'Unconfigured objective' }))
      .toThrow('exact goal-step')
    expect(f.ctx.goals.get(agent)).toMatchObject({ objective: 'Initial objective', revision: original.native.revision })
    expect(f.service.inspect(agent, original.id).definition).toEqual(original.definition)
    expect(f.service.inspectGoalOutcome(agent, original.id)?.conditions).toEqual(originalOutcome.conditions)

    await verifier.dispose()
    verifier = await installGoalVerifier(f, [...goalProfiles(f.root, 'Initial objective'), ...goalProfiles(f.root, 'Configured replacement', { version: 2 }).map(profile => ({ ...profile, id: `replacement-${profile.id}` }))])
    const updated = f.service.control(agent, { goalId: original.id, expectedRevision: original.native.revision, operation: 'edit', objective: 'Configured replacement' })
    expect(updated).toMatchObject({ native: { objective: 'Configured replacement', revision: original.native.revision + 1 }, definition: { version: original.definition.version + 1 } })
    expect(f.service.inspectGoalOutcome(agent, original.id)).toMatchObject({ definitionVersion: updated.definition.version,
      conditions: { profileId: 'replacement-goal-outcome-profile', profileVersion: 2 } })
    await verifier.dispose()
  })

  it('keeps frozen conditions for max-round edits and rejects reconfigured or expired conditions before native mutation', async () => {
    const f = await harness(undefined, undefined, undefined, true, true, 1_000)
    const agent = await f.create('preflight-frozen', 'owner'); f.human.add(agent)
    let verifier = await installGoalVerifier(f, goalProfiles(f.root, 'Frozen objective'))
    const created = f.service.create(agent, 'Frozen objective', 2)
    const frozen = f.service.inspectGoalOutcome(agent, created.id)!.conditions!
    let rounds = f.service.control(agent, { goalId: created.id, expectedRevision: created.native.revision, operation: 'edit', maxGoalRounds: 3 })
    expect(f.service.inspectGoalOutcome(agent, created.id)?.conditions).toEqual(frozen)

    // A new run can use a newly configured step profile; the whole-goal
    // specification and its absolute deadline remain the original template.
    await verifier.dispose()
    verifier = await installGoalVerifier(f, goalProfiles(f.root, 'Frozen objective').map(profile => profile.taskKind === 'goal-step'
      ? { ...profile, version: 2 } : profile))
    rounds = f.service.control(agent, { goalId: created.id, expectedRevision: rounds.native.revision, operation: 'edit', maxGoalRounds: 3 })
    expect(f.service.inspectGoalOutcome(agent, created.id)?.conditions).toEqual(frozen)

    await verifier.dispose()
    verifier = await installGoalVerifier(f, goalProfiles(f.root, 'Frozen objective', { version: 2, wholeRequiredText: 'Changed condition' }))
    expect(() => f.service.control(agent, { goalId: created.id, expectedRevision: rounds.native.revision, operation: 'edit', maxGoalRounds: 4 }))
      .toThrow('frozen success specification')
    expect(f.ctx.goals.get(agent)).toMatchObject({ revision: rounds.native.revision, maxGoalRounds: 3 })

    await verifier.dispose()
    verifier = await installGoalVerifier(f, goalProfiles(f.root, 'Frozen objective'))
    const now = vi.spyOn(Date, 'now').mockReturnValue(frozen.expiresAt - 3_000)
    try {
      expect(() => f.service.control(agent, { goalId: created.id, expectedRevision: rounds.native.revision, operation: 'edit', maxGoalRounds: 4 }))
        .toThrow('frozen whole-goal deadline')
    } finally { now.mockRestore() }
    expect(f.ctx.goals.get(agent)).toMatchObject({ revision: rounds.native.revision, maxGoalRounds: 3 })
    await verifier.dispose()

    const short = await harness(undefined, undefined, undefined, true, true, 1_000)
    const shortAgent = await short.create('preflight-short', 'owner'); short.human.add(shortAgent)
    const shortVerifier = await installGoalVerifier(short, goalProfiles(short.root, 'Short validity', { validityMs: 3_000 }))
    expect(() => short.service.create(shortAgent, 'Short validity')).toThrow('acceptance validity')
    expect(short.ctx.goals.get(shortAgent)).toBeUndefined()
    expect(short.service.list(shortAgent)).toEqual([])
    expect(shortVerifier.service.health()).toMatchObject({ awaitingExecution: 0, pendingVerification: 0, pendingReceipts: 0 })
  })

  it('exports a contiguous two-round owner workflow after the final independent whole-goal acceptance', async () => {
    const f = await harness(undefined, undefined, undefined, true, true, 2_000)
    await installNativeGoalRoundDriver(f.ctx)
    const agent = await f.create('verified-workflow-source', 'owner'); f.human.add(agent)
    const objective = 'Produce the independently verified workflow report'
    await writeFile(join(f.root, 'report.md'), 'Step verified\n')
    registerReadReportTool(f.ctx, f.root)
    await installGoalVerifier(f, goalProfiles(f.root, objective))
    let record!: ReturnType<AssistantGoalsService['create']>
    let requests = 0
    class Adapter extends LlmAdapter {
      async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests++
        if (requests === 1) {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: 'ready' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ready' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        if (requests === 2 || requests === 4) {
          if (requests === 4) await writeFile(join(f.root, 'report.md'), 'Step verified\nGoal verified\n')
          const id = requests === 2 ? 'read-source-first' : 'read-source-final'
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id: ToolCallId(id), name: 'read_report', argumentsDelta: '{}' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name: 'read_report', arguments: '{}' } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'The report is ready for independent verification.' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'The report is ready for independent verification.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    f.ctx.llm.registerAdapter(['fixture'], new Adapter())
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Prepare the native goal driver.' }] }))
    await vi.waitFor(() => expect(requests).toBe(1), { timeout: 2_000 })
    await agent.whenIdle()
    expect(f.ctx.fiber.state).toBe(2)
    record = f.service.create(agent, objective, 2)
    await vi.waitFor(() => expect(f.ctx.goals.get(agent)?.roundsStarted).toBe(1), { timeout: 2_000 })
    await vi.waitFor(() => expect(requests).toBe(5), { timeout: 2_000 })
    await agent.whenIdle(); await f.service.whenIdle()
    const complete = f.service.inspect(agent, record.id)
    const durable = await f.ctx.sessionPersistence.readRaw(agent.session.id)
    expect(durable?.content).toContain('read-source')
    expect(requests).toBe(5)
    expect(complete.native).toMatchObject({ phase: 'complete', roundsStarted: 2, revision: record.native.revision + 2 })
    expect(f.service.inspectGoalOutcome(agent, record.id)).toMatchObject({ status: 'achieved', nativeCompletion: 'complete' })

    // The harness keeps its owner-turn seam asserted; capture happens only after
    // the autonomous source turn has completed and been independently accepted.
    const sourceResults = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(sourceResults.some(event => event.data.message.content.some(block => block.type === 'tool-result' && block.isError === true)), JSON.stringify(sourceResults)).toBe(false)
    const exported = f.service.inspectVerifiedWorkflowSource(agent, record.id)
    const historical = f.service.inspectVerifiedWorkflowRun(agent, record.id, exported.runId)
    expect(historical).toEqual(exported)
    await f.ctx.plugin(SessionQueryEngine, [])
    const ownerInput = { ownerRouteId: 'owner-route', principalId: 'owner', workspace: f.root,
      preset: 'primary', sessionId: String(agent.session.id), goalId: record.id }
    // This Host read has no Agent argument; it only observes the existing
    // Session log and does not create or activate an Agent.
    const ownerSource = await f.service.inspectOwnerVerifiedWorkflowSource(ownerInput)
    expect(ownerSource).toMatchObject({ ...exported, segments: [{ round: 1, turn: expect.any(Number), runId: expect.any(String), nativeRevision: expect.any(Number), steps: [{ id: 'read-source-first' }] },
      { round: 2, turn: exported.turn, runId: exported.runId, nativeRevision: expect.any(Number), steps: exported.steps }] })
    f.human.delete(agent)
    expect(() => f.service.inspectVerifiedWorkflowSource(agent, record.id)).toThrow('current authenticated owner turn required')
    f.human.add(agent)
    const controller = new AbortController(); controller.abort()
    await expect(f.service.inspectOwnerVerifiedWorkflowSource(ownerInput, controller.signal)).rejects.toMatchObject({ code: 'unavailable' })
    const query = f.ctx.sessionQuery
    const nativeObserve = query.observeSession.bind(query)
    let disposed = false
    const routeRead = vi.spyOn(query, 'observeSession').mockImplementation(async (...args) => {
      const observed = await nativeObserve(...args); const dispose = observed[Symbol.dispose].bind(observed)
      f.revokeRoute()
      return { ...observed, [Symbol.dispose]() { disposed = true; dispose() } }
    })
    try {
      await expect(f.service.inspectOwnerVerifiedWorkflowSource(ownerInput)).rejects.toMatchObject({ code: 'rejected' })
      expect(disposed).toBe(true)
    } finally { routeRead.mockRestore(); f.restoreRoute() }
    const headerRead = vi.spyOn(query, 'observeSession').mockImplementation(async (...args) => {
      const observed = await nativeObserve(...args)
      return { ...observed, header: { ...observed.header, cwd: `${f.root}-wrong` } }
    })
    try { await expect(f.service.inspectOwnerVerifiedWorkflowSource(ownerInput)).rejects.toMatchObject({ code: 'rejected' }) }
    finally { headerRead.mockRestore() }
    expect(() => f.service.inspectVerifiedWorkflowRun(agent, record.id, `${exported.runId}-wrong`)).toThrow(/achieved whole-goal outcome|exact achieved historical run/u)
    expect(exported).toMatchObject({ protocol: 'assistant-goals/verified-workflow-source/v1', scope: complete.scope,
      goal: { id: record.id, definition: complete.definition, sessionId: String(agent.session.id), nativeGoalId: complete.native.goalId },
      acceptance: { contractId: expect.any(String), contractDigest: expect.stringMatching(/^[a-f0-9]{64}$/u), receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u), validUntil: expect.any(Number) },
      steps: [{ id: 'read-source-final', toolName: 'read_report', arguments: {} }],
    })
    expect(exported.runId).toMatch(/^goal-run-[a-f0-9]{64}$/u)
    const events = agent.session.snapshotEvents()
    expect(events.some(event => event.type === 'user/message' && event.data.source.kind === 'goal' && event.data.source.round === 1)).toBe(true)
    expect(events.some(event => event.type === 'user/message' && event.data.source.kind === 'goal' && event.data.source.round === 2)).toBe(true)
    expect(events.some(event => event.type === 'turn/end' && event.data.turn === exported.turn)).toBe(true)
    expect(requests).toBe(5)
    f.ctx.goals.create(agent, { objective: 'A different current goal after the accepted workflow' })
    expect(() => f.service.inspectVerifiedWorkflowSource(agent, record.id)).toThrow('exact completed native goal')
    expect(f.service.inspectVerifiedWorkflowRun(agent, record.id, exported.runId)).toEqual(exported)
    await f.dispose(agent)
    expect(f.ctx.sessions.get(agent.session.id)).toBeUndefined()
    await expect(f.service.inspectOwnerVerifiedWorkflowSource({ ownerRouteId: 'owner-route', principalId: 'owner', workspace: f.root,
      preset: 'primary', sessionId: String(agent.session.id), goalId: record.id })).resolves.toEqual(ownerSource)
  })

  it('rejects historical workflow export when ownership scope changes or the accepted receipt expires', async () => {
    // The positive integration above owns the native run setup. Here use its
    // service-level guards with a completed goal fixture so the failure is at
    // the owner scope/receipt boundary rather than a helper parser.
    const f = await harness(undefined, undefined, undefined, true, true, 2_000)
    await installNativeGoalRoundDriver(f.ctx)
    const agent = await f.create('verified-workflow-guards', 'owner'); f.human.add(agent)
    await writeFile(join(f.root, 'report.md'), 'Step verified\nGoal verified\n')
    registerReadReportTool(f.ctx, f.root)
    const objective = 'Reject stale workflow source evidence'
    await installGoalVerifier(f, goalProfiles(f.root, objective, { validityMs: 10_000 }))
    let record!: ReturnType<AssistantGoalsService['create']>
    let calls = 0
    class Adapter extends LlmAdapter {
      async *stream(): AsyncIterable<StreamChunk> {
        calls++
        if (calls === 1) {
          yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'ready' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ready' } }; yield { type: 'finish', reason: { kind: 'stop' } }; return
        }
        if (calls === 2) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'tool-call-delta', index: 0, id: ToolCallId('read-guard'), name: 'read_report', argumentsDelta: '{}' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('read-guard'), name: 'read_report', arguments: '{}' } }; yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'done' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }; yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    f.ctx.llm.registerAdapter(['fixture'], new Adapter())
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Prepare the native goal driver.' }] }))
    await vi.waitFor(() => expect(calls).toBe(1), { timeout: 2_000 })
    await agent.whenIdle()
    record = f.service.create(agent, objective, 1)
    await vi.waitFor(() => expect(f.ctx.goals.get(agent)?.roundsStarted).toBe(1), { timeout: 2_000 })
    await vi.waitFor(() => expect(calls).toBe(3), { timeout: 2_000 })
    await agent.whenIdle(); await f.service.whenIdle()
    const sourceResults = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(sourceResults.some(event => event.data.message.content.some(block => block.type === 'tool-result' && block.isError === true)), JSON.stringify(sourceResults)).toBe(false)
    const historical = f.service.inspectVerifiedWorkflowSource(agent, record.id)
    expect(historical.steps).toHaveLength(1)
    f.owners.set(agent, 'other')
    expect(() => f.service.inspectVerifiedWorkflowSource(agent, record.id)).toThrow('exact completed native goal')
    expect(() => f.service.inspectVerifiedWorkflowRun(agent, record.id, historical.runId)).toThrow(/exact completed native goal|owner|scope|authenticated/u)
    f.owners.set(agent, 'owner')
    const future = Date.now() + 20_000
    const now = vi.spyOn(Date, 'now').mockReturnValue(future)
    try {
      expect(() => f.service.inspectVerifiedWorkflowSource(agent, record.id)).toThrow(/achieved whole-goal outcome|current accepted outcome/u)
      expect(() => f.service.inspectVerifiedWorkflowRun(agent, record.id, historical.runId)).toThrow(/achieved whole-goal outcome|current accepted outcome/u)
    }
    finally { now.mockRestore() }
  })
})

describe('owner verified artifact Host boundary', () => {
  it('reads Isolation between two owner snapshots and rejects route or receipt changes during that read', async () => {
    const f = await harness()
    const definition = { version: 1, digest: acceptanceDigest({ objective: 'deliver' }), objective: 'deliver' }
    const scope = { principalId: 'owner', principalRecordId: 'record-owner', principalVersion: 1, workspace: '/workspace', preset: 'primary' }
    const stepTask = { kind: 'goal-step' as const, ref: 'run', goal: { id: 'goal', definitionVersion: 1, definitionDigest: definition.digest, stepId: 'round-1', runId: 'run', sessionId: 'session', nativeGoalId: 'native', nativeRevision: 1 } }
    const isolated = (id: string) => ({ id, kind: 'isolated-process-behavior' as const, authority: { id: 'runner', digest: 'a'.repeat(64) }, artifactPath: 'artifacts/release.txt', testSetId: 'set' })
    const make = (task: any, id: string, criterionId: string) => createTaskAcceptanceContract({ protocol: 'task-acceptance/v4', id, scope: { workspace: scope.workspace, preset: scope.preset }, owner: { principalRecordId: scope.principalRecordId, principalVersion: 1 }, task, objective: definition.objective, profile: { id: `${id}-profile`, version: 1, digest: 'b'.repeat(64) }, issuedAt: Date.now() - 1, expiresAt: Date.now() + 60_000, criteria: [isolated(criterionId)], bounds: { maxDurationMs: 1000, maxEvidenceBytes: 4096 } })
    const step = make(stepTask, 'step', 'step-file')
    const outcomeTask = { kind: 'goal-outcome' as const, ref: 'assessment', goal: { id: 'goal', definitionVersion: 1, definitionDigest: definition.digest, assessmentId: 'assessment', sessionId: 'session', nativeGoalId: 'native' } }
    const outcome = make(outcomeTask, 'outcome', 'outcome-file')
    const content = 'artifact'; const sha256 = createHash('sha256').update(content).digest('hex'); const observedAt = Date.now()
    const receipt = (contract: any, id: string, criterionId: string) => createTaskVerificationReceipt(contract, { protocol: 'task-verification/v4', id, contractId: contract.id, contractDigest: contract.digest, scope: contract.scope, owner: contract.owner, task: contract.task, results: [{ criterionId, status: 'passed', reason: 'verified', artifactDigest: sha256, evidence: [{ kind: 'isolated-artifact', ref: 'job', digest: sha256 }] }], startedAt: observedAt, completedAt: observedAt, validUntil: observedAt + 30_000 })
    const snapshot = () => ({ ownerRoute: { route: 1 }, storedGoal: { id: 'goal', scope, definition, nativeAtLastObservation: { sessionId: 'session', goalId: 'native', revision: 2, phase: 'complete' } }, executionRuns: [{ intent: { runId: 'run', task: stepTask }, acceptance: { contractId: step.id, contractDigest: step.digest }, execution: { status: 'succeeded', quiescent: true, completedAt: observedAt } }], outcomeAssessments: [{ contract: outcome, triggerRunId: 'run', execution: { status: 'succeeded', quiescent: true, completedAt: observedAt } }], acceptedTasks: [{ state: 'done', contract: step, receipt: receipt(step, 'step-receipt', 'step-file'), verifierExecutionObservation: { status: 'succeeded', quiescent: true, completedAt: observedAt, executionRef: 'run' } }, { state: 'done', contract: outcome, receipt: receipt(outcome, 'outcome-receipt', 'outcome-file'), verifierExecutionObservation: { status: 'succeeded', quiescent: true, completedAt: observedAt, executionRef: 'assessment' } }] })
    const reads = [snapshot(), snapshot()]; const ownerRead = vi.fn(() => reads.shift()!)
    Object.defineProperty(f.service, 'inspectOwnerGoalExecution', { value: ownerRead })
    await f.ctx.plugin((ctx: Context) => { ctx.provide('assistantIsolation' as never, { readAcceptedArtifact: vi.fn(() => ({ path: 'artifacts/release.txt', content, sha256, jobId: 'job' })) } as never) })
    const input = { ownerRouteId: 'route', principalId: 'owner', workspace: '/workspace', preset: 'primary', sessionId: 'session', goalId: 'goal', runId: 'run', paths: ['artifacts/release.txt'] }
    expect(f.service.inspectOwnerVerifiedArtifacts(input)).toMatchObject({ protocol: 'assistant-goals/verified-artifacts/v1', files: [{ sha256 }] })
    expect(ownerRead).toHaveBeenCalledTimes(2)
    expect(ownerRead).toHaveBeenNthCalledWith(1, { ownerRouteId: 'route', principalId: 'owner', workspace: '/workspace', preset: 'primary', sessionId: 'session', goalId: 'goal' })
    const changed = snapshot(); const stale = changed.acceptedTasks[1]!
    changed.acceptedTasks[1] = { ...stale, receipt: { ...stale.receipt, validUntil: observedAt + 29_999 } } as typeof stale
    reads.push(snapshot(), changed)
    expect(() => f.service.inspectOwnerVerifiedArtifacts(input)).toThrow('unavailable')
    const routeChanged = snapshot(); routeChanged.ownerRoute = { route: 2 }
    reads.push(snapshot(), routeChanged)
    expect(() => f.service.inspectOwnerVerifiedArtifacts(input)).toThrow('unavailable')
    expect(ownerRead).toHaveBeenCalledTimes(6)
  })
})
