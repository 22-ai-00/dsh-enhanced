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

type EvidenceFixture = Awaited<ReturnType<typeof fixture>>
function evidenceSnapshot(f: EvidenceFixture, input: { goalId: string; sessionId: string; nativeGoalId: string; outcome: 'achieved' | 'not-achieved';
  verifiedAt?: number; objective?: string }) {
  const value = f.snapshot(), run = value.executionRuns[0]!, assessment = value.outcomeAssessments[0]!
  const definition = { version: 1, objective: input.objective ?? value.storedGoal.definition.objective,
    digest: acceptanceDigest({ objective: input.objective ?? value.storedGoal.definition.objective }) }
  const runId = `run-${input.goalId}`, stepContractId = `step-${input.goalId}`, outcomeContractId = `outcome-${input.goalId}`
  const stepContractDigest = acceptanceDigest({ kind: 'step', goalId: input.goalId })
  const outcomeContractDigest = acceptanceDigest({ kind: 'outcome', goalId: input.goalId })
  const receiptDigest = acceptanceDigest({ kind: 'receipt', goalId: input.goalId, outcome: input.outcome })
  value.storedGoal.id = input.goalId; value.storedGoal.definition = definition; value.storedGoal.originalObjective = definition.objective
  Object.assign(value.storedGoal.nativeAtLastObservation, { sessionId: input.sessionId, goalId: input.nativeGoalId, objective: definition.objective,
    phase: input.outcome === 'achieved' ? 'complete' : 'blocked' })
  run.intent.runId = runId; run.intent.objective = definition.objective; run.intent.task.ref = runId
  Object.assign(run.intent.task.goal, { id: input.goalId, definitionVersion: definition.version, definitionDigest: definition.digest, runId,
    sessionId: input.sessionId, nativeGoalId: input.nativeGoalId })
  run.acceptance = { contractId: stepContractId, contractDigest: stepContractDigest }
  assessment.triggerRunId = runId; assessment.contract.id = outcomeContractId; assessment.contract.digest = outcomeContractDigest
  assessment.contract.task.ref = `assessment-${input.goalId}`; assessment.contract.task.goal.assessmentId = `assessment-${input.goalId}`
  Object.assign(assessment.contract.task.goal, { id: input.goalId, definitionVersion: definition.version, definitionDigest: definition.digest,
    sessionId: input.sessionId, nativeGoalId: input.nativeGoalId })
  const stepAccepted = value.acceptedTasks[0]!, outcomeAccepted = value.acceptedTasks[1]!, verifiedAt = input.verifiedAt ?? Date.now()
  stepAccepted.contractId = stepContractId; stepAccepted.contract = { id: stepContractId, digest: stepContractDigest, task: structuredClone(run.intent.task) }
  stepAccepted.receipt.digest = acceptanceDigest({ kind: 'step-receipt', goalId: input.goalId })
  outcomeAccepted.contractId = outcomeContractId; outcomeAccepted.contract = structuredClone(assessment.contract)
  Object.assign(outcomeAccepted.receipt, { objectiveStatus: input.outcome, digest: receiptDigest, completedAt: verifiedAt, validUntil: verifiedAt + 60_000 })
  outcomeAccepted.verifierExecutionObservation = { ...assessment.execution!, executionRef: assessment.contract.task.ref }
  return value
}

function runProof(snapshot: ReturnType<EvidenceFixture['snapshot']>) {
  const run = snapshot.executionRuns[0]!, assessment = snapshot.outcomeAssessments[0]!
  return { protocol: 'assistant-goals/owner-run-trace/v1' as const, runId: run.intent.runId, turn: 4, nativeRevision: 2,
    definitionDigest: snapshot.storedGoal.definition.digest, outcomeProfile: assessment.contract.profile, steps: [],
    traceDigest: acceptanceDigest({ trace: run.intent.runId }) }
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
  const f = await fixture(), now = Date.now(), failedFirst = evidenceSnapshot(f, { goalId: 'goal-a', sessionId: 'session-a', nativeGoalId: 'native-a', outcome: 'not-achieved', verifiedAt: now - 1_000 })
  const failedLast = structuredClone(failedFirst), repairFirst = evidenceSnapshot(f, { goalId: 'repair-goal', sessionId: 'repair-session', nativeGoalId: 'repair-native', outcome: 'achieved', verifiedAt: now })
  const repairLast = structuredClone(repairFirst), snapshots = [failedFirst, repairFirst, failedLast, repairLast]
  vi.spyOn(f.service, 'inspectOwnerGoalExecution').mockImplementation(() => structuredClone(snapshots.shift()!) as never)
  vi.spyOn(f.service, 'inspectOwnerGoalRunProof').mockResolvedValue(runProof(failedFirst))
  vi.spyOn(f.service, 'trustedAcceptanceProducerGeneration').mockReturnValue('producer-generation')
  const summary = await f.service.inspectOwnerFailureCaptureSummary({ ownerRouteId: 'route', principalId: 'owner', workspace: f.root, preset: 'primary', taskFamilyId: 'repair-evidence',
    repair: { sessionId: 'repair-session', goalId: 'repair-goal' }, failures: [{ sessionId: 'session-a', goalId: 'goal-a' }], minimumOccurrences: 1 })
  expect(summary).toMatchObject({ protocol: 'assistant-skills/host-failure-evidence/v1', taskFamily: { id: 'repair-evidence', definitionDigest: failedFirst.storedGoal.definition.digest },
    failureCategory: 'objective-not-achieved', triggerCondition: { minimumOccurrences: 1 }, failures: [{ goal: { id: 'goal-a' }, runId: 'run-goal-a', outcome: 'not-achieved',
      execution: { status: 'succeeded', quiescent: true }, traceDigest: runProof(failedFirst).traceDigest }], repairGoal: { id: 'repair-goal', sessionId: 'repair-session', nativeGoalId: 'repair-native' },
    evidence: { producer: 'assistant-goals', generation: 'producer-generation' } })
  const { evidence, ...unsigned } = summary
  expect(evidence.digest).toBe(acceptanceDigest({ ...unsigned, evidence: { producer: 'assistant-goals', generation: evidence.generation } }))
})

test('aggregates repeated independent failures in canonical order before a later achieved repair', async () => {
  const f = await fixture(), now = Date.now()
  const goalA = evidenceSnapshot(f, { goalId: 'goal-a', sessionId: 'session-z', nativeGoalId: 'native-a', outcome: 'not-achieved', verifiedAt: now - 2_000 })
  const goalB = evidenceSnapshot(f, { goalId: 'goal-b', sessionId: 'session-a', nativeGoalId: 'native-b', outcome: 'not-achieved', verifiedAt: now - 2_000 })
  const repair = evidenceSnapshot(f, { goalId: 'repair-goal', sessionId: 'repair-session', nativeGoalId: 'repair-native', outcome: 'achieved', verifiedAt: now - 1_000 })
  // Input order is B, A; canonical locator and evidence ordering both read A, B.
  const snapshots = [goalA, goalB, repair, goalA, goalB, repair]
  vi.spyOn(f.service, 'inspectOwnerGoalExecution').mockImplementation(() => structuredClone(snapshots.shift()!) as never)
  vi.spyOn(f.service, 'inspectOwnerGoalRunProof').mockImplementation(async input => runProof(input.goalId === 'goal-a' ? goalA : goalB))
  vi.spyOn(f.service, 'trustedAcceptanceProducerGeneration').mockReturnValue('producer-generation')
  const summary = await f.service.inspectOwnerFailureCaptureSummary({ ownerRouteId: 'route', principalId: 'owner', workspace: f.root, preset: 'primary',
    taskFamilyId: 'repair-evidence', repair: { sessionId: 'repair-session', goalId: 'repair-goal' }, failures: [
      { sessionId: 'session-z', goalId: 'goal-a' }, { sessionId: 'session-a', goalId: 'goal-b' },
    ], minimumOccurrences: 2 })
  expect(summary.failureCategory).toBe('repeated-not-achieved')
  expect(summary.triggerCondition).toEqual({ kind: 'not-achieved-count', minimumOccurrences: 2, windowStartedAt: now - 2_000, windowEndedAt: now - 2_000 })
  expect(summary.failures.map(item => item.goal.id)).toEqual(['goal-a', 'goal-b'])
  expect(summary.repairGoal.id).toBe('repair-goal')
})

test.each(['duplicate-locator', 'duplicate-goal', 'duplicate-session', 'duplicate-native', 'duplicate-run', 'duplicate-contract-id',
  'duplicate-contract-digest', 'duplicate-receipt', 'minimum-mismatch', 'cross-scope', 'cross-definition', 'outcome-profile', 'repair-profile'] as const)(
  'rejects a non-independent repeated failure set: %s', async kind => {
    const f = await fixture(), now = Date.now()
    const goalA = evidenceSnapshot(f, { goalId: 'goal-a', sessionId: 'session-a', nativeGoalId: 'native-a', outcome: 'not-achieved', verifiedAt: now - 2_000 })
    const goalB = evidenceSnapshot(f, { goalId: 'goal-b', sessionId: 'session-b', nativeGoalId: 'native-b', outcome: 'not-achieved',
      verifiedAt: now - 1_500, ...(kind === 'cross-definition' ? { objective: 'Another task' } : {}) })
    const repair = evidenceSnapshot(f, { goalId: 'repair-goal', sessionId: 'repair-session', nativeGoalId: 'repair-native', outcome: 'achieved', verifiedAt: now - 1_000 })
    if (kind === 'cross-scope') goalB.storedGoal.scope.principalRecordId = 'other-record'
    if (kind === 'duplicate-goal') goalB.storedGoal.id = goalA.storedGoal.id
    if (kind === 'duplicate-session') goalB.storedGoal.nativeAtLastObservation.sessionId = goalA.storedGoal.nativeAtLastObservation.sessionId
    if (kind === 'duplicate-native') goalB.storedGoal.nativeAtLastObservation.goalId = goalA.storedGoal.nativeAtLastObservation.goalId
    if (kind === 'duplicate-run') {
      goalB.executionRuns[0]!.intent.runId = goalA.executionRuns[0]!.intent.runId
      goalB.outcomeAssessments[0]!.triggerRunId = goalA.executionRuns[0]!.intent.runId
    }
    if (kind === 'duplicate-contract-id') {
      goalB.outcomeAssessments[0]!.contract.id = goalA.outcomeAssessments[0]!.contract.id
      goalB.acceptedTasks[1]!.contractId = goalA.outcomeAssessments[0]!.contract.id
      goalB.acceptedTasks[1]!.contract.id = goalA.outcomeAssessments[0]!.contract.id
    }
    if (kind === 'duplicate-contract-digest') {
      goalB.outcomeAssessments[0]!.contract.digest = goalA.outcomeAssessments[0]!.contract.digest
      goalB.acceptedTasks[1]!.contract.digest = goalA.outcomeAssessments[0]!.contract.digest
    }
    if (kind === 'outcome-profile') {
      goalB.outcomeAssessments[0]!.contract.profile.digest = 'f'.repeat(64)
      ;(goalB.acceptedTasks[1]!.contract as typeof goalB.outcomeAssessments[number]['contract']).profile.digest = 'f'.repeat(64)
    }
    if (kind === 'repair-profile') {
      repair.outcomeAssessments[0]!.contract.profile.digest = 'e'.repeat(64)
      ;(repair.acceptedTasks[1]!.contract as typeof repair.outcomeAssessments[number]['contract']).profile.digest = 'e'.repeat(64)
    }
    if (kind === 'duplicate-receipt') goalB.acceptedTasks[1]!.receipt.digest = goalA.acceptedTasks[1]!.receipt.digest!
    const snapshots = [goalA, goalB, repair]
    vi.spyOn(f.service, 'inspectOwnerGoalExecution').mockImplementation(() => structuredClone(snapshots.shift()!) as never)
    vi.spyOn(f.service, 'inspectOwnerGoalRunProof').mockImplementation(async input => runProof(input.goalId === 'goal-a' ? goalA : goalB))
    const failures = kind === 'duplicate-locator'
      ? [{ sessionId: 'session-a', goalId: 'goal-a' }, { sessionId: 'session-a', goalId: 'goal-a' }]
      : [{ sessionId: 'session-a', goalId: 'goal-a' }, { sessionId: 'session-b', goalId: 'goal-b' }]
    await expect(f.service.inspectOwnerFailureCaptureSummary({ ownerRouteId: 'route', principalId: 'owner', workspace: f.root, preset: 'primary',
      taskFamilyId: 'repair-evidence', repair: { sessionId: 'repair-session', goalId: 'repair-goal' }, failures,
      minimumOccurrences: kind === 'minimum-mismatch' ? 3 : 2 })).rejects.toThrow()
  })

test.each(['trace', 'receipt', 'route'] as const)('rejects one drifting member of a repeated failure set: %s', async kind => {
  const f = await fixture(), now = Date.now()
  const goalA = evidenceSnapshot(f, { goalId: 'goal-a', sessionId: 'session-a', nativeGoalId: 'native-a', outcome: 'not-achieved', verifiedAt: now - 2_000 })
  const goalB = evidenceSnapshot(f, { goalId: 'goal-b', sessionId: 'session-b', nativeGoalId: 'native-b', outcome: 'not-achieved', verifiedAt: now - 1_500 })
  const repair = evidenceSnapshot(f, { goalId: 'repair-goal', sessionId: 'repair-session', nativeGoalId: 'repair-native', outcome: 'achieved', verifiedAt: now - 1_000 })
  const goalALast = structuredClone(goalA), goalBLast = structuredClone(goalB), repairLast = structuredClone(repair)
  if (kind === 'receipt') goalBLast.acceptedTasks[1]!.receipt.digest = 'f'.repeat(64)
  if (kind === 'route') goalBLast.ownerRoute = { route: 2 }
  const snapshots = [goalA, goalB, repair, goalALast, goalBLast, repairLast]
  vi.spyOn(f.service, 'inspectOwnerGoalExecution').mockImplementation(() => structuredClone(snapshots.shift()!) as never)
  vi.spyOn(f.service, 'inspectOwnerGoalRunProof').mockImplementation(async input => {
    const proof = runProof(input.goalId === 'goal-a' ? goalA : goalB)
    return kind === 'trace' && input.goalId === 'goal-b' ? { ...proof, runId: 'wrong-run' } : proof
  })
  await expect(f.service.inspectOwnerFailureCaptureSummary({ ownerRouteId: 'route', principalId: 'owner', workspace: f.root, preset: 'primary',
    taskFamilyId: 'repair-evidence', repair: { sessionId: 'repair-session', goalId: 'repair-goal' }, failures: [
      { sessionId: 'session-a', goalId: 'goal-a' }, { sessionId: 'session-b', goalId: 'goal-b' },
    ], minimumOccurrences: 2 })).rejects.toThrow()
})

test('rejects a repair that is not achieved strictly after every failure', async () => {
  const f = await fixture(), now = Date.now()
  const failure = evidenceSnapshot(f, { goalId: 'goal-a', sessionId: 'session-a', nativeGoalId: 'native-a', outcome: 'not-achieved', verifiedAt: now - 1_000 })
  const repair = evidenceSnapshot(f, { goalId: 'repair-goal', sessionId: 'repair-session', nativeGoalId: 'repair-native', outcome: 'achieved', verifiedAt: now - 1_000 })
  const snapshots = [failure, repair, failure, repair]
  vi.spyOn(f.service, 'inspectOwnerGoalExecution').mockImplementation(() => structuredClone(snapshots.shift()!) as never)
  vi.spyOn(f.service, 'inspectOwnerGoalRunProof').mockResolvedValue(runProof(failure))
  await expect(f.service.inspectOwnerFailureCaptureSummary({ ownerRouteId: 'route', principalId: 'owner', workspace: f.root, preset: 'primary',
    taskFamilyId: 'repair-evidence', repair: { sessionId: 'repair-session', goalId: 'repair-goal' },
    failures: [{ sessionId: 'session-a', goalId: 'goal-a' }], minimumOccurrences: 1 })).rejects.toThrow(/must follow/u)
})

test.each(['route-race', 'receipt-drift', 'unknown-execution', 'achieved-trigger', 'expired-receipt', 'cross-owner'] as const)('rejects invalid failure evidence: %s', async kind => {
  const f = await fixture(), now = Date.now(), failureFirst = evidenceSnapshot(f, { goalId: 'goal-a', sessionId: 'session-a', nativeGoalId: 'native-a', outcome: 'not-achieved', verifiedAt: now - 1_000 })
  const failureLast = structuredClone(failureFirst), repairFirst = evidenceSnapshot(f, { goalId: 'repair-goal', sessionId: 'repair-session', nativeGoalId: 'repair-native', outcome: 'achieved', verifiedAt: now })
  const repairLast = structuredClone(repairFirst)
  if (kind === 'route-race') failureLast.ownerRoute = { route: 2 }
  if (kind === 'receipt-drift') failureLast.acceptedTasks[1]!.receipt.validUntil++
  if (kind === 'unknown-execution') (failureFirst.executionRuns[0]! as any).execution = { status: 'unknown', quiescent: false, completedAt: 3 }
  if (kind === 'achieved-trigger') failureFirst.acceptedTasks[1]!.receipt.objectiveStatus = 'achieved'
  if (kind === 'expired-receipt') failureFirst.acceptedTasks[1]!.receipt.validUntil = Date.now() - 1
  if (kind === 'cross-owner') repairFirst.storedGoal.scope.principalId = 'other-owner'
  const snapshots = [failureFirst, repairFirst, failureLast, repairLast]
  vi.spyOn(f.service, 'inspectOwnerGoalExecution').mockImplementation(() => structuredClone(snapshots.shift()!) as never)
  vi.spyOn(f.service, 'inspectOwnerGoalRunProof').mockResolvedValue(runProof(failureFirst))
  await expect(f.service.inspectOwnerFailureCaptureSummary({ ownerRouteId: 'route', principalId: 'owner', workspace: f.root, preset: 'primary', taskFamilyId: 'repair-evidence',
    repair: { sessionId: 'repair-session', goalId: 'repair-goal' }, failures: [{ sessionId: 'session-a', goalId: 'goal-a' }], minimumOccurrences: 1 })).rejects.toThrow()
})

test('exports a repair-free owner failure trigger after double-reading exact evidence', async () => {
  const f = await fixture(), now = Date.now()
  const first = evidenceSnapshot(f, { goalId: 'goal-a', sessionId: 'session-a', nativeGoalId: 'native-a', outcome: 'not-achieved', verifiedAt: now })
  const current = structuredClone(first)
  const snapshots = [first, current]
  vi.spyOn(f.service, 'inspectOwnerGoalExecution').mockImplementation(() => structuredClone(snapshots.shift()!) as never)
  vi.spyOn(f.service, 'inspectOwnerGoalRunProof').mockResolvedValue(runProof(first))
  const trigger = await f.service.inspectOwnerFailureTrigger({ ownerRouteId: 'route', principalId: 'owner', workspace: f.root, preset: 'primary',
    taskFamilyId: 'repair-evidence', failures: [{ sessionId: 'session-a', goalId: 'goal-a' }], minimumOccurrences: 1 })
  expect(trigger).toMatchObject({ protocol: 'assistant-skills/host-failure-trigger/v1', taskFamily: { id: 'repair-evidence', objective: 'Repair exact evidence' },
    failureCategory: 'objective-not-achieved', failures: [{ goal: { id: 'goal-a' }, outcome: 'not-achieved' }] })
  expect('repairGoal' in trigger).toBe(false)
})

test.each(['drift', 'expired'] as const)('rejects owner failure trigger %s', async kind => {
  const f = await fixture(), first = evidenceSnapshot(f, { goalId: 'goal-a', sessionId: 'session-a', nativeGoalId: 'native-a', outcome: 'not-achieved' })
  const current = structuredClone(first)
  if (kind === 'drift') current.ownerRoute = { route: 2 }
  else current.acceptedTasks[1]!.receipt.validUntil = Date.now() - 1
  const snapshots = [first, current]
  vi.spyOn(f.service, 'inspectOwnerGoalExecution').mockImplementation(() => structuredClone(snapshots.shift()!) as never)
  vi.spyOn(f.service, 'inspectOwnerGoalRunProof').mockResolvedValue(runProof(first))
  await expect(f.service.inspectOwnerFailureTrigger({ ownerRouteId: 'route', principalId: 'owner', workspace: f.root, preset: 'primary',
    taskFamilyId: 'repair-evidence', failures: [{ sessionId: 'session-a', goalId: 'goal-a' }], minimumOccurrences: 1 })).rejects.toThrow()
})
