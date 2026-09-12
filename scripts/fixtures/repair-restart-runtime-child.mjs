import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const [mode, root] = process.argv.slice(2)
if (!['create', 'resume'].includes(mode) || !root) throw new Error('usage: repair-restart-runtime-child.mjs <create|resume> <root>')
const scope = { principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 1, workspace: root, preset: 'repair' }
const paths = { sessions: join(root, 'sessions'), goals: join(root, 'goals.sqlite'), skills: join(root, 'skills.sqlite'), verifier: join(root, 'verifier.sqlite') }
const goalRequire = createRequire(new URL('../../plugins/assistant-goals/package.json', import.meta.url))
const skillsRequire = createRequire(new URL('../../plugins/assistant-skills/package.json', import.meta.url))
const loadGoal = async name => await import(pathToFileURL(goalRequire.resolve(name)).href)
const { Context } = await loadGoal('@deepseek-ai/cordis')
const { AgentRegistry } = await loadGoal('@deepseek-ai/dsh-agent')
const { default: AgentLoop } = await loadGoal('@deepseek-ai/dsh-agent-loop')
const { LlmAdapter, LlmRuntime, ToolCallId } = await loadGoal('@deepseek-ai/dsh-llm')
const { SessionStore } = await loadGoal('@deepseek-ai/dsh-session')
const { SessionProjectionRegistry } = await loadGoal('@deepseek-ai/dsh-session-projection')
const { default: JsonlSessionPersistence } = await loadGoal('@deepseek-ai/dsh-session-persistence-jsonl')
const { default: SystemPrompt } = await loadGoal('@deepseek-ai/dsh-system-prompt')
const { default: ToolRuntime, defineTool } = await loadGoal('@deepseek-ai/dsh-tools')
const { AssistantGoalsService } = await import(pathToFileURL(goalRequire.resolve('@dsh-enhanced/assistant-goals')).href)
const { AssistantVerifierService, createVerifierAuthorities } = await loadGoal('@dsh-enhanced/assistant-verifier')
const { OwnerRepairAgentRuntime } = await import(pathToFileURL(skillsRequire.resolve('./lib/repair-agent.js')).href)
const { SkillStore } = await import(pathToFileURL(skillsRequire.resolve('./lib/store.js')).href)
const { default: GoalService } = await import(pathToFileURL(goalRequire.resolve('@deepseek-ai/dsh-goal')).href)
const driver = await import(pathToFileURL(goalRequire.resolve('@deepseek-ai/dsh-goal-round-driver')).href)

function output(value) { process.stdout.write(`${JSON.stringify(value)}\n`) }
async function waitFor(check, label) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)) }
  throw new Error(`timed out waiting for ${label}`)
}
function settledRound(agent, goalId, nativeGoalId, round) {
  return ctx.assistantGoals.executionRuns(agent, goalId).map(run => ({ run, goal: run.intent.task.goal }))
    .find(({ run, goal }) => goal.nativeGoalId === nativeGoalId && run.intent.admission.round === round
      && run.execution?.status === 'succeeded' && run.execution.quiescent === true && run.acceptance !== undefined)
}
function settlementView(value) {
  const { run, goal } = value
  return { runId: run.intent.runId, nativeGoalId: goal.nativeGoalId, nativeRevision: goal.nativeRevision,
    round: run.intent.admission.round, execution: run.execution, acceptance: run.acceptance }
}

const ctx = new Context()
const store = new SkillStore(paths.skills)
let runtime
let createAuthority
let repairAgent
let pausedAtCheckpoint = false
let releaseCheckpointFinish
const checkpointFinish = new Promise(resolve => { releaseCheckpointFinish = resolve })
ctx.provide('assistantDelivery', { preferencePrincipalForAgent: () => undefined, currentPreferenceTurn: () => undefined,
  validateOwnerRoute: ({ authorityId, principalId, workspace, agentPreset }) => authorityId === 'route' && principalId === 'owner' && workspace === root && agentPreset === 'repair'
    ? { authorityId, principalId, principalRecordId: 'owner-record', principalVersion: 1, workspace, agentPreset, bindingVersion: 1, generation: 1 } : undefined })
ctx.provide('assistantPolicy', { bindInitiator: () => () => {}, authorizeAgent: () => ({ effect: 'allow' }), evaluateAgent: () => ({ effect: 'allow' }) })
ctx.provide('assistantSkills', { ownsOwnerAuthorizedRepair: (_input, callback) => callback === createAuthority,
  ownsOwnerAuthorizedRepairResume: (input, callback) => runtime?.ownsResume(input, callback) === true })
await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); new SessionProjectionRegistry(ctx)
await ctx.plugin(JsonlSessionPersistence, { root: paths.sessions, compression: 'none', packChunks: false, writeBatchMaxDelayMs: 1 })
await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: true, persona: '' })
await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(GoalService)
await ctx.plugin({ inject: driver.inject, apply: driver.apply }, {})
await mkdir(root, { recursive: true }); await writeFile(join(root, 'report.md'), 'verified\n')
if (mode === 'create') await writeFile(join(root, 'recovered-artifact.json'), JSON.stringify({ mode: 'checkpoint' }))
await ctx.plugin(AssistantGoalsService, { databasePath: paths.goals, preauthorizedCreateMaxRounds: 2, verifyNativeRounds: true, verifyGoalOutcome: true,
  executionBudget: { mode: 'calls', modelCalls: 4, toolCalls: 3, durationMs: 60_000, maxOutputTokensPerCall: 128, routes: [{ provider: 'fixture', model: 'fixture' }] } })
const authority = { kind: 'document', id: 'report', sources: [{ id: 'report', url: 'https://example.test/report' }], timeoutMs: 1_000, maxResponseBytes: 1024 }
const [compiled] = createVerifierAuthorities({ authorities: [authority] })
const profiles = ['goal-step', 'goal-outcome'].map(kind => ({ id: `${kind}-repair`, version: 1, scope: { workspace: root, preset: 'repair' }, owner: { principalRecordId: 'owner-record', principalVersion: 1 }, taskKind: kind, objective: 'repair restart objective', validityMs: 120_000, bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4096 }, criteria: [{ id: kind, kind: 'document-citations', authority: { id: 'report', digest: compiled.digest }, artifactPath: kind === 'goal-step' ? 'report.md' : 'recovered-artifact.json', requiredText: kind === 'goal-step' ? ['verified'] : ['resume'], quotes: [] }] }))
await ctx.plugin(AssistantVerifierService, { databasePath: paths.verifier, tickIntervalMs: 0, requireAcceptance: true, authorities: [authority], profiles })
ctx.provide('agentPresets', { resolve: async () => ({ id: 'repair' }), mount: async agentCtx => {
  agentCtx.tools.register(defineTool({ name: 'checkpoint_tool', description: 'persist a checkpoint', parameters: {}, output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [] }, async execute(_args, execution) { if (mode === 'create') { ctx.goals.disarm(execution.agent); pausedAtCheckpoint = true } return { ok: true } } }))
  agentCtx.tools.register(defineTool({ name: 'write_recovered_artifact', description: 'write recovered artifact', parameters: {}, output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [] }, async execute() { await writeFile(join(root, 'recovered-artifact.json'), JSON.stringify({ session: 'repaired', mode: 'resume' })); return { ok: true } } }))
} })
class Adapter extends LlmAdapter {
  calls = 0
  async *stream(_options) {
    this.calls++
    const name = mode === 'create' && this.calls === 1 ? 'checkpoint_tool' : mode === 'resume' && this.calls === 1 ? 'write_recovered_artifact' : undefined
    if (!name) { yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'recovered done' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: 'recovered done' } }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: ToolCallId(`${mode}-${this.calls}`), name, argumentsDelta: '{}' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`${mode}-${this.calls}`), name, arguments: '{}' } }
    if (mode === 'create') { await checkpointFinish; if (repairAgent) { ctx.goals.disarm(repairAgent); pausedAtCheckpoint = true } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
const adapter = new Adapter(); ctx.llm.registerAdapter(['fixture'], adapter)
const trigger = { protocol: 'assistant-skills/host-failure-trigger/v1', scope, taskFamily: { id: 'repair', definitionDigest: 'a'.repeat(64), objective: 'repair restart objective' }, failureCategory: 'objective-not-achieved', triggerCondition: { kind: 'not-achieved-count', minimumOccurrences: 1, windowStartedAt: 1, windowEndedAt: 1 }, failures: [], attestedAt: 1, evidence: { producer: 'assistant-goals', generation: 'fixture-host', digest: 'd'.repeat(64) } }
ctx.assistantGoals.inspectOwnerFailureTrigger = async () => structuredClone(trigger)
const authorization = { invocationId: 'restart', ownerRouteId: 'route', source: { goalId: 'source-goal', sessionId: 'source-session', nativeGoalId: 'source-native', definitionDigest: 'a'.repeat(64) }, profileId: 'profile', profileDigest: 'b'.repeat(64), skillName: 'repair-skill', parentVersion: 1, parentDigest: 'c'.repeat(64), maxIterations: 1, expiresAt: Date.now() + 60_000 }
const continuation = mode === 'create' ? store.createRepairContinuation(scope, authorization, { route: 'fixture' }) : store.listRepairContinuations(scope)[0]
if (!continuation) throw new Error('repair continuation missing')
if (mode === 'resume') Object.assign(authorization, continuation.authorization)
const usage = store.repairUsage(scope, continuation.id)
const input = { id: continuation.id, iteration: continuation.iteration, authorizationDigest: continuation.authorizationDigest, scope, ownerRouteId: 'route', trigger, objective: trigger.taskFamily.objective, maxGoalRounds: 2, expiresAt: authorization.expiresAt, provider: 'fixture', model: 'fixture', maxModelCalls: 4, maxToolCalls: 2, maxOutputTokens: 128, maxDurationMs: 30_000, allowedTools: ['checkpoint_tool', 'write_recovered_artifact'], initialModelCalls: usage.modelCalls, initialToolCalls: usage.toolCalls, recordUsage: kind => store.chargeRepairUsage(scope, continuation.id, kind, kind === 'model' ? 4 : 2), assertCurrent: () => {} }
runtime = new OwnerRepairAgentRuntime(ctx, store)
if (mode === 'create') {
  createAuthority = input.assertCurrent
  const started = await runtime.create(input)
  const agent = runtime.get(started.sessionId)
  repairAgent = agent
  releaseCheckpointFinish()
  await waitFor(() => agent.session.snapshotEvents().find(event => event.type === 'tool/result'), 'persisted native tool result')
  await ctx.sessions.flush(agent.session)
  let checkpoint = store.transitionRepairContinuation(scope, continuation.id, continuation.revision, 'source-confirmed', { trigger })
  checkpoint = store.transitionRepairContinuation(scope, checkpoint.id, checkpoint.revision, 'creating-repair', checkpoint.checkpoint)
  checkpoint = store.transitionRepairContinuation(scope, checkpoint.id, checkpoint.revision, 'repairing', { trigger, repair: { sessionId: started.sessionId, goalId: started.goalId, nativeGoalId: ctx.goals.get(agent).id, definitionDigest: ctx.assistantGoals.inspect(agent, started.goalId).definition.digest } })
  await waitFor(() => { const execution = store.inspectRepairExecution(scope, continuation.id, 1); return execution?.pendingModel === 0 && execution?.pendingTool === 0 && ctx.goals.get(agent)?.phase === 'active' && pausedAtCheckpoint ? execution : undefined }, 'safe disarmed repair checkpoint')
  const record = ctx.assistantGoals.inspect(agent, started.goalId)
  const settlement = await waitFor(() => settledRound(agent, started.goalId, record.native.goalId, 1), 'settled first native goal round')
  const firstOutcome = await waitFor(() => {
    const snapshot = ctx.assistantGoals.inspectOwnerGoalExecution({ ownerRouteId: 'route', principalId: 'owner', workspace: root, preset: 'repair', sessionId: started.sessionId, goalId: started.goalId })
    const assessment = snapshot.outcomeAssessments.find(item => item.contract.task.ref === snapshot.outcome?.assessmentId)
    return snapshot.outcome?.status === 'not-achieved' && assessment?.triggerRunId === settlement.run.intent.runId
      && assessment.execution?.status === 'succeeded' && assessment.execution.quiescent
      ? { ...snapshot.outcome, triggerRunId: assessment.triggerRunId } : undefined
  }, 'settled first whole-goal failure assessment')
  const execution = store.inspectRepairExecution(scope, continuation.id, 1)
  output({ event: 'ready', continuationId: continuation.id, sessionId: started.sessionId, goalId: started.goalId, nativeGoalId: record.native.goalId, definitionDigest: record.definition.digest, native: record.native, usage: store.repairUsage(scope, continuation.id), execution, deadlineAt: execution.deadlineAt, settlement: settlementView(settlement), firstOutcome })
  setInterval(() => {}, 1_000)
} else {
  const prior = store.listRepairContinuations(scope)[0]
  const repair = prior.checkpoint.repair
  if (!repair) throw new Error('repair checkpoint missing')
  const resumed = await runtime.resume(input, repair)
  const agent = runtime.get(resumed.sessionId)
  try { await waitFor(() => ctx.goals.get(agent)?.phase === 'complete', 'resumed native completion') } catch (error) {
    throw new Error(`resumed native diagnostics ${JSON.stringify({ native: ctx.goals.get(agent), usage: store.repairUsage(scope, prior.id),
      snapshot: ctx.assistantGoals.inspectOwnerGoalExecution({ ownerRouteId: 'route', principalId: 'owner', workspace: root, preset: 'repair', sessionId: resumed.sessionId, goalId: resumed.goalId }),
      health: ctx.assistantGoals.health(), events: agent.session.snapshotEvents().filter(event => ['goal/change', 'turn/end', 'agent/error', 'tool/result'].includes(event.type)) })}`, { cause: error })
  }
  await ctx.sessions.flush(agent.session)
  const record = ctx.assistantGoals.inspect(agent, resumed.goalId)
  const settlement = await waitFor(() => settledRound(agent, resumed.goalId, repair.nativeGoalId, 1), 'preserved first native goal settlement')
  const execution = store.inspectRepairExecution(scope, prior.id, 1)
  output({ event: 'resumed', continuationId: prior.id, sessionId: resumed.sessionId, goalId: resumed.goalId, nativeGoalId: record.native.goalId, definitionDigest: record.definition.digest, native: record.native, usage: store.repairUsage(scope, prior.id), execution, deadlineAt: execution.deadlineAt, settlement: settlementView(settlement), artifact: join(root, 'recovered-artifact.json'), modelCalls: adapter.calls })
  await runtime.closeSession(resumed.sessionId); await ctx.fiber.dispose(); store.close()
}
