import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import GoalService from '@deepseek-ai/dsh-goal'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { AssistantGoalsService } from '../src/service.js'
import { verifiedRunId } from '../src/verified-workflow.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'goal-owner-evidence-')), ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); new SessionProjectionRegistry(ctx)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: true, persona: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(GoalService)
  ctx.provide('assistantDelivery' as never, {} as never); ctx.provide('assistantPolicy' as never, {} as never)
  await ctx.plugin(AssistantGoalsService, { databasePath: join(root, 'goals.sqlite') })
  await ctx.plugin(SessionQueryEngine as unknown as new (ctx: Context) => SessionQueryEngine)
  const scope = { principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 1, workspace: root, preset: 'primary' }
  const definition = { version: 1, objective: 'Repair exact evidence', digest: acceptanceDigest({ objective: 'Repair exact evidence' }) }
  const turn = 4, runId = verifiedRunId(scope, 'goal-a', 'session-a', turn), nativeRevision = 2
  const task = { kind: 'goal-step' as const, ref: runId, goal: { id: 'goal-a', definitionVersion: 1, definitionDigest: definition.digest,
    stepId: 'step-a', runId, sessionId: 'session-a', nativeGoalId: 'native-a', nativeRevision } }
  const run = { intent: { runId, scope, objective: definition.objective, admission: { issuedAt: 1, expiresAt: Number.MAX_SAFE_INTEGER, maxGoalRounds: 1, round: 1, authorizationDigest: 'auth' }, task },
    acceptance: { contractId: 'step-contract', contractDigest: 'a'.repeat(64) }, dispatchedAt: 2, execution: { status: 'succeeded' as const, quiescent: true, completedAt: 3 } }
  const outcomeTask = { kind: 'goal-outcome' as const, ref: 'assessment-a', goal: { id: 'goal-a', definitionVersion: 1, definitionDigest: definition.digest,
    assessmentId: 'assessment-a', sessionId: 'session-a', nativeGoalId: 'native-a' } }
  const outcomeContract = { id: 'outcome-contract', digest: 'b'.repeat(64), task: outcomeTask, profile: { id: 'outcome-profile', version: 3, digest: 'c'.repeat(64) } }
  const now = Date.now()
  const snapshot = () => structuredClone({ protocol: 'assistant-goals/owner-execution-snapshot/v1', ownerRoute: { route: 1 }, storedGoal: { id: 'goal-a', scope,
    originalObjective: definition.objective, definition, checkpoint: {}, version: 1, createdAt: 1, updatedAt: 2,
    nativeAtLastObservation: { sessionId: 'session-a', goalId: 'native-a', revision: 3, objective: definition.objective, phase: 'blocked', roundsStarted: 1, maxGoalRounds: 1, updatedAt: 2 } },
  executionRuns: [run], strategyRecords: [], outcomeAssessments: [{ contract: outcomeContract, triggerRunId: runId, dispatchedAt: 3, execution: { status: 'succeeded', quiescent: true, completedAt: 4 } }],
  acceptedTasks: [{ contractId: 'step-contract', state: 'done', attempts: 1, reason: null, contract: { id: 'step-contract', digest: 'a'.repeat(64), task }, receipt: { objectiveStatus: 'achieved', validUntil: now + 60_000, completedAt: now }, verifierExecutionObservation: { ...run.execution, executionRef: runId } },
    { contractId: 'outcome-contract', state: 'done', attempts: 1, reason: null, contract: outcomeContract, receipt: { objectiveStatus: 'not-achieved', digest: 'd'.repeat(64), validUntil: now + 60_000, completedAt: now }, verifierExecutionObservation: { status: 'succeeded', quiescent: true, completedAt: 4, executionRef: 'assessment-a' } }] })
  const events = () => [{ seq: 0, type: 'turn/start', data: { turn } }, { seq: 1, type: 'user/message', data: { turn, source: { kind: 'goal', goalId: 'native-a', revision: nativeRevision, round: 1 } } },
    { seq: 2, type: 'tool/call', data: { turn, callId: 'failed-write', name: 'write', arguments: '{"path":"a"}' } },
    { seq: 3, type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [2], data: { turn, message: { isError: true, source: { callId: 'failed-write' }, content: [{ type: 'tool-result', toolCallId: 'failed-write', isError: true }] } } },
    { seq: 4, type: 'tool/call', data: { turn, callId: 'read-after', name: 'read', arguments: '{"path":"a"}' } },
    { seq: 5, type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [4], data: { turn, message: { source: { callId: 'read-after' }, content: [{ type: 'tool-result', toolCallId: 'read-after' }] } } },
    { seq: 6, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }]
  const observation = (raw = events()) => ({ source: 'live', header: { id: 'session-a', cwd: root, agentPreset: 'primary', origin: 'user', delegationDepth: 0 },
    events: raw, inheritedEventCount: 0, cursor: raw.at(-1)!.seq, retain() { return this }, [Symbol.dispose]() {} })
  return { ctx, service: ctx.assistantGoals, root, scope, runId, snapshot, events, observation }
}

test('returns an integrity-bound exact run trace and preserves failed calls', async () => {
  const f = await fixture(), snapshots = [f.snapshot(), f.snapshot()], observations = [f.observation(), f.observation()]
  const inspect = vi.spyOn(f.service, 'inspectOwnerGoalExecution').mockImplementation(() => snapshots.shift()! as never)
  const observe = vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockImplementation(async () => observations.shift()! as never)
  const proof = await f.service.inspectOwnerGoalRunProof({ ownerRouteId: 'route', principalId: 'owner', workspace: f.root, preset: 'primary', sessionId: 'session-a', goalId: 'goal-a', runId: f.runId })
  expect(proof).toMatchObject({ protocol: 'assistant-goals/owner-run-trace/v1', runId: f.runId, turn: 4, nativeRevision: 2,
    definitionDigest: f.snapshot().storedGoal.definition.digest, outcomeProfile: { id: 'outcome-profile', version: 3 },
    steps: [{ id: 'failed-write', name: 'write', outcome: 'failed' }, { id: 'read-after', name: 'read', outcome: 'succeeded' }] })
  const { traceDigest, ...payload } = proof
  expect(traceDigest).toBe(acceptanceDigest(payload))
  expect(inspect).toHaveBeenCalledTimes(2); expect(observe).toHaveBeenCalledTimes(2)
})

test('ignores replacement and copied results while retaining the original causal results', async () => {
  const f = await fixture(), raw = f.events() as any[], end = raw.pop()!, failed = structuredClone(raw[3]!)
  raw.push({ ...failed, seq: 6, surfaceOp: { op: 'replace', start: 3, end: 3 }, sourceEventSeqs: [3] },
    { ...failed, seq: 7, surfaceOp: 'append', sourceEventSeqs: [3] }, { ...end, seq: 8 })
  vi.spyOn(f.service, 'inspectOwnerGoalExecution').mockImplementation(() => f.snapshot() as never)
  vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockImplementation(async () => f.observation(raw) as never)
  await expect(f.service.inspectOwnerGoalRunProof({ ownerRouteId: 'route', principalId: 'owner', workspace: f.root, preset: 'primary',
    sessionId: 'session-a', goalId: 'goal-a', runId: f.runId })).resolves.toMatchObject({
    steps: [{ id: 'failed-write', outcome: 'failed' }, { id: 'read-after', outcome: 'succeeded' }],
  })
})

test('rejects a result without the exact causal call source', async () => {
  const f = await fixture(), raw = f.events()
  raw[3]!.sourceEventSeqs = [1]
  vi.spyOn(f.service, 'inspectOwnerGoalExecution').mockImplementation(() => f.snapshot() as never)
  vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockImplementation(async () => f.observation(raw) as never)
  await expect(f.service.inspectOwnerGoalRunProof({ ownerRouteId: 'route', principalId: 'owner', workspace: f.root, preset: 'primary',
    sessionId: 'session-a', goalId: 'goal-a', runId: f.runId })).rejects.toThrow(/unconfirmed/u)
})

test.each(['before-source', 'after-end'] as const)('excludes a settled call %s from the exact owner run proof', async position => {
  const f = await fixture(), raw = f.events() as any[]
  const call = { type: 'tool/call', data: { turn: 4, callId: `outside-${position}`, name: 'write', arguments: '{}' } }
  const result = { type: 'tool/result', surfaceOp: 'append', data: { turn: 4, message: { source: { callId: `outside-${position}` },
    content: [{ type: 'tool-result', toolCallId: `outside-${position}` }] } } }
  if (position === 'before-source') {
    for (const event of raw.slice(1)) {
      event.seq += 2
      if (Array.isArray(event.sourceEventSeqs)) event.sourceEventSeqs = event.sourceEventSeqs.map((seq: number) => seq + 2)
    }
    raw.splice(1, 0, { ...call, seq: 1 }, { ...result, seq: 2, sourceEventSeqs: [1] })
  } else {
    raw.push({ ...call, seq: 7 }, { ...result, seq: 8, sourceEventSeqs: [7] })
  }
  vi.spyOn(f.service, 'inspectOwnerGoalExecution').mockImplementation(() => f.snapshot() as never)
  vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockImplementation(async () => f.observation(raw) as never)
  await expect(f.service.inspectOwnerGoalRunProof({ ownerRouteId: 'route', principalId: 'owner', workspace: f.root, preset: 'primary',
    sessionId: 'session-a', goalId: 'goal-a', runId: f.runId })).resolves.toMatchObject({
    steps: [{ id: 'failed-write' }, { id: 'read-after' }],
  })
})

test.each(['route-race', 'receipt-drift', 'session-event-drift', 'run-mismatch'] as const)('rejects unstable or mismatched run proof: %s', async kind => {
  const f = await fixture(), first = f.snapshot(), second = f.snapshot(), firstEvents = f.events(), secondEvents = f.events()
  if (kind === 'route-race') second.ownerRoute = { route: 2 }
  if (kind === 'receipt-drift') second.acceptedTasks[1]!.receipt.validUntil++
  if (kind === 'session-event-drift') secondEvents[4]!.data.callId = 'changed-call'
  const snapshots = [first, second]
  vi.spyOn(f.service, 'inspectOwnerGoalExecution').mockImplementation(() => structuredClone(snapshots.shift()!) as never)
  const observations = [f.observation(firstEvents), f.observation(secondEvents)]
  vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockImplementation(async () => observations.shift()! as never)
  await expect(f.service.inspectOwnerGoalRunProof({ ownerRouteId: 'route', principalId: 'owner', workspace: f.root, preset: 'primary', sessionId: 'session-a', goalId: 'goal-a',
    runId: kind === 'run-mismatch' ? 'other-run' : f.runId })).rejects.toThrow()
})

test('derives one Host failure evidence summary from stable exact snapshots', async () => {
  const f = await fixture(), failedFirst = f.snapshot(), failedLast = f.snapshot()
  const repair = () => {
    const value = f.snapshot()
    value.storedGoal.id = 'repair-goal'; value.storedGoal.nativeAtLastObservation.sessionId = 'repair-session'; value.storedGoal.nativeAtLastObservation.goalId = 'repair-native'
    value.executionRuns = []; value.outcomeAssessments = []; value.acceptedTasks = []
    return value
  }
  const repairFirst = repair(), repairLast = repair(), snapshots = [failedFirst, repairFirst, failedLast, repairLast]
  vi.spyOn(f.service, 'inspectOwnerGoalExecution').mockImplementation(() => structuredClone(snapshots.shift()!) as never)
  vi.spyOn(f.service, 'inspectOwnerGoalRunProof').mockResolvedValue({ protocol: 'assistant-goals/owner-run-trace/v1', runId: f.runId, turn: 4, nativeRevision: 2,
    definitionDigest: failedFirst.storedGoal.definition.digest, outcomeProfile: failedFirst.outcomeAssessments[0]!.contract.profile, steps: [], traceDigest: 'e'.repeat(64) })
  vi.spyOn(f.service, 'trustedAcceptanceProducerGeneration').mockReturnValue('producer-generation')
  const summary = await f.service.inspectOwnerFailureCaptureSummary({ ownerRouteId: 'route', principalId: 'owner', workspace: f.root, preset: 'primary', taskFamilyId: 'repair-evidence',
    repair: { sessionId: 'repair-session', goalId: 'repair-goal' }, failures: [{ sessionId: 'session-a', goalId: 'goal-a' }], minimumOccurrences: 1 })
  expect(summary).toMatchObject({ protocol: 'assistant-skills/host-failure-evidence/v1', taskFamily: { id: 'repair-evidence', definitionDigest: failedFirst.storedGoal.definition.digest },
    failureCategory: 'objective-not-achieved', triggerCondition: { minimumOccurrences: 1 }, failures: [{ goal: { id: 'goal-a' }, runId: f.runId, outcome: 'not-achieved',
      execution: { status: 'succeeded', quiescent: true }, traceDigest: 'e'.repeat(64) }], repairGoal: { id: 'repair-goal', sessionId: 'repair-session', nativeGoalId: 'repair-native' },
    evidence: { producer: 'assistant-goals', generation: 'producer-generation' } })
  const { evidence, ...unsigned } = summary
  expect(evidence.digest).toBe(acceptanceDigest({ ...unsigned, evidence: { producer: 'assistant-goals', generation: evidence.generation } }))
})

test.each(['route-race', 'receipt-drift', 'unknown-execution', 'achieved-trigger', 'expired-receipt', 'cross-owner'] as const)('rejects invalid failure evidence: %s', async kind => {
  const f = await fixture(), failureFirst = f.snapshot(), failureLast = f.snapshot()
  const repair = () => {
    const value = f.snapshot()
    value.storedGoal.id = 'repair-goal'; value.storedGoal.nativeAtLastObservation.sessionId = 'repair-session'; value.storedGoal.nativeAtLastObservation.goalId = 'repair-native'
    value.executionRuns = []; value.outcomeAssessments = []; value.acceptedTasks = []
    return value
  }
  const repairFirst = repair(), repairLast = repair()
  if (kind === 'route-race') failureLast.ownerRoute = { route: 2 }
  if (kind === 'receipt-drift') failureLast.acceptedTasks[1]!.receipt.validUntil++
  if (kind === 'unknown-execution') (failureFirst.executionRuns[0]! as any).execution = { status: 'unknown', quiescent: false, completedAt: 3 }
  if (kind === 'achieved-trigger') failureFirst.acceptedTasks[1]!.receipt.objectiveStatus = 'achieved'
  if (kind === 'expired-receipt') failureFirst.acceptedTasks[1]!.receipt.validUntil = Date.now() - 1
  if (kind === 'cross-owner') repairFirst.storedGoal.scope.principalId = 'other-owner'
  const snapshots = [failureFirst, repairFirst, failureLast, repairLast]
  vi.spyOn(f.service, 'inspectOwnerGoalExecution').mockImplementation(() => structuredClone(snapshots.shift()!) as never)
  vi.spyOn(f.service, 'inspectOwnerGoalRunProof').mockResolvedValue({ protocol: 'assistant-goals/owner-run-trace/v1', runId: f.runId, turn: 4, nativeRevision: 2,
    definitionDigest: failureFirst.storedGoal.definition.digest, outcomeProfile: failureFirst.outcomeAssessments[0]!.contract.profile, steps: [], traceDigest: 'e'.repeat(64) })
  await expect(f.service.inspectOwnerFailureCaptureSummary({ ownerRouteId: 'route', principalId: 'owner', workspace: f.root, preset: 'primary', taskFamilyId: 'repair-evidence',
    repair: { sessionId: 'repair-session', goalId: 'repair-goal' }, failures: [{ sessionId: 'session-a', goalId: 'goal-a' }], minimumOccurrences: 1 })).rejects.toThrow()
})
