import { describe, expect, it } from 'vitest'
import type { OwnerGoalRunProof } from '@dsh-enhanced/assistant-goals'
import { canonicalEvaluationScope, evaluationLearningProjectionDigest } from '@dsh-enhanced/assistant-evaluation'
import { acceptanceDigest, createTaskAcceptanceContract, createTaskVerificationReceipt } from '@dsh-enhanced/task-acceptance-contract'
import type { SkillRun } from '../src/store.ts'
import { soleSkillRunTrace, watchObservation, watchObservationResult } from '../src/watch-proof.ts'

const now = 10_000
const scope = { principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: '/workspace', preset: 'primary' }
const run: SkillRun = { id: 'skill-run-proof', invocationId: 'invoke', goalId: 'goal', sessionId: 'session', skillName: 'read-report', version: 2, inputs: { path: 'report.md' },
  state: 'succeeded', steps: [{ id: 'read', state: 'succeeded' }], goalExecutionRunId: 'goal-run', goalDefinitionDigest: 'd'.repeat(64), nativeGoalId: 'native', createdAt: 100, updatedAt: 200 }
const goal = { id: run.goalId, definitionVersion: 1, definitionDigest: run.goalDefinitionDigest!, sessionId: run.sessionId, nativeGoalId: run.nativeGoalId!, nativeRevision: 3, stepId: 'step', runId: run.goalExecutionRunId! }
const source = { intent: { runId: run.goalExecutionRunId!, scope, objective: 'Read report.', admission: { issuedAt: 10, expiresAt: 20_000, maxGoalRounds: 2, round: 1, authorizationDigest: 'a'.repeat(64) }, task: { kind: 'goal-step' as const, ref: run.goalExecutionRunId!, goal } },
  dispatchedAt: 50, execution: { status: 'succeeded' as const, quiescent: true as const, completedAt: 150 } }
function proof(steps: OwnerGoalRunProof['steps'] = [
  { id: 'context', name: 'goal_context', arguments: { goal_id: run.goalId, focus: false }, outcome: 'succeeded' },
  { id: 'invoke', name: 'skill_run', arguments: { goal_id: run.goalId, name: run.skillName, version: run.version, inputs_json: JSON.stringify(run.inputs), invocation_id: run.invocationId }, outcome: 'succeeded' },
  { id: 'status', name: 'skill_status', arguments: { run_id: run.id }, outcome: 'succeeded' },
  { id: 'goal', name: 'get_goal', arguments: {}, outcome: 'succeeded' },
]): OwnerGoalRunProof {
  const payload = { protocol: 'assistant-goals/owner-run-trace/v1' as const, runId: run.goalExecutionRunId!, turn: 4, nativeRevision: 3, definitionDigest: run.goalDefinitionDigest!,
    outcomeProfile: { id: 'profile', version: 1, digest: 'b'.repeat(64) }, steps }
  return { ...payload, traceDigest: acceptanceDigest(payload) }
}
const trace = proof()
const taskFamily = { goalDefinitionDigest: run.goalDefinitionDigest!, outcomeProfile: { id: 'profile', version: 1, digest: 'b'.repeat(64) } }
const trusted = (value: unknown) => {
  try {
    const receipt = value as ReturnType<typeof canonicalOutcome>
    return evaluationLearningProjectionDigest(receipt) === receipt.projection.digest
  } catch { return false }
}

function canonicalOutcome(status: 'achieved' | 'not-achieved', version = 1, disposition: 'upsert' | 'retract' = 'upsert') {
  const evaluationScope = { workspace: scope.workspace, preset: scope.preset }
  const scopeKey = canonicalEvaluationScope(evaluationScope).scopeKey
  const subjectRef = 'assessment'
  const execution = { outcomeId: 'evaluation-execution', status: 'succeeded' as const, source: { kind: 'evaluator' as const, id: 'assistant-verifier' },
    evidence: [{ kind: 'goal-outcome' as const, ref: subjectRef }], occurredAt: 600, evaluator: { id: 'assistant-verifier', version: '1' } }
  const objective = disposition === 'retract' ? undefined : { outcomeId: `evaluation-objective-${version}`, status, source: { kind: version === 1 ? 'evaluator' as const : 'user-feedback' as const, id: version === 1 ? 'assistant-verifier' : 'assistant-delivery/typed-owner-feedback' },
    evidence: [{ kind: 'goal-outcome' as const, ref: subjectRef }], occurredAt: 600 + version, evaluator: { id: version === 1 ? 'assistant-verifier' : 'assistant-delivery-owner-feedback', version: version === 1 ? '1' : '2' } }
  const projectionBase = { subjectKind: 'goal-outcome' as const, subjectRef, disposition, ...(objective === undefined ? {} : { evidenceOutcomeId: objective.outcomeId }) }
  const digest = evaluationLearningProjectionDigest({ scopeKey, situation: 'goal:goal:definition:1', execution, ...(objective === undefined ? {} : { objective }), projection: projectionBase })
  return { triggerOutcomeId: objective?.outcomeId ?? `evaluation-retract-${version}`, scope: evaluationScope, scopeKey, scopeWatermark: version, situation: 'goal:goal:definition:1', execution,
    ...(objective === undefined ? {} : { objective }), projection: { ...projectionBase, version, digest } }
}

function snapshot(status: 'achieved' | 'not-achieved') {
  const taskGoal = { id: run.goalId, definitionVersion: 1, definitionDigest: run.goalDefinitionDigest!, sessionId: run.sessionId, nativeGoalId: run.nativeGoalId! }
  const contract = createTaskAcceptanceContract({ protocol: 'task-acceptance/v3', id: 'outcome', task: { kind: 'goal-outcome', ref: 'assessment', goal: { ...taskGoal, assessmentId: 'assessment' } },
    scope: { workspace: scope.workspace, preset: scope.preset }, owner: { principalRecordId: scope.principalRecordId, principalVersion: scope.principalVersion }, objective: 'Read report.',
    profile: { id: 'profile', version: 1, digest: 'b'.repeat(64) }, criteria: [{ id: 'result', kind: 'target-readback', authority: { id: 'authority', digest: 'c'.repeat(64) }, objectId: 'report', expected: [{ pointer: '/ready', value: true }] }],
    issuedAt: 300, expiresAt: 20_000, bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 } })
  const execution = { status: 'succeeded' as const, quiescent: true, completedAt: 400 }
  const receipt = createTaskVerificationReceipt(contract, { protocol: 'task-verification/v3', id: 'receipt', contractId: contract.id, contractDigest: contract.digest, scope: contract.scope, owner: contract.owner, task: contract.task,
    results: [{ criterionId: 'result', status: status === 'achieved' ? 'passed' : 'failed', reason: 'independent-result', evidence: [] }], startedAt: 500, completedAt: 600, validUntil: 20_000 })
  return { storedGoal: { id: run.goalId, scope, definition: { version: 1, digest: run.goalDefinitionDigest!, objective: 'Read report.' }, nativeAtLastObservation: { sessionId: run.sessionId, goalId: run.nativeGoalId! } },
    executionRuns: [source], outcomeAssessments: [{ triggerRunId: run.goalExecutionRunId!, contract, dispatchedAt: 350, execution }],
    acceptedTasks: [{ contractId: contract.id, state: 'done', contract, receipt, verifierExecutionObservation: { ...execution, executionRef: contract.task.ref } }] }
}

describe('deployment watch causal proof', () => {
  it('accepts one exact skill_run plus only bounded metadata reads and binds the trace digest to the observation', () => {
    const digest = soleSkillRunTrace(trace, run, source)
    expect(digest).toMatch(/^[a-f0-9]{64}$/u)
    expect(watchObservation(snapshot('achieved') as never, scope, run, now, trace, taskFamily)).toMatchObject({ runId: run.id, objectiveStatus: 'achieved', executionTraceDigest: digest })
  })

  it.each([
    ['a write', [{ id: 'write', name: 'write', arguments: { file_path: 'report.md', content: 'fixed' }, outcome: 'succeeded' as const }]],
    ['a second skill run', [trace.steps[1]!, { ...trace.steps[1]!, id: 'invoke-again' }]],
    ['an unknown read', [{ id: 'read', name: 'read', arguments: { file_path: 'report.md' }, outcome: 'succeeded' as const }]],
    ['a goal mutation', [{ id: 'control', name: 'update_goal', arguments: { status: 'complete' }, outcome: 'succeeded' as const }]],
  ])('rejects %s alongside the claimed run', (_name, extra) => {
    const changed = proof([trace.steps[0]!, trace.steps[1]!, ...extra])
    expect(soleSkillRunTrace(changed, run, source)).toBeUndefined()
    expect(watchObservation(snapshot('achieved') as never, scope, run, now, changed)).toBeUndefined()
  })

  it('rejects failed calls, parameter drift, the wrong metered round and missing skill execution', () => {
    const { traceDigest: _traceDigest, ...payload } = trace
    const cases: OwnerGoalRunProof[] = [
      proof([{ id: 'failed-read', name: 'get_goal', arguments: {}, outcome: 'failed' }, trace.steps[1]!]),
      proof([{ ...trace.steps[1]!, arguments: { goal_id: run.goalId, name: run.skillName, version: run.version, inputs_json: '{}', invocation_id: run.invocationId } }]),
      { ...payload, nativeRevision: 4, traceDigest: acceptanceDigest({ ...payload, nativeRevision: 4 }) },
      proof([{ id: 'goal', name: 'get_goal', arguments: {}, outcome: 'succeeded' }]),
      { ...trace, traceDigest: 'f'.repeat(64) },
    ]
    for (const value of cases) expect(soleSkillRunTrace(value, run, source)).toBeUndefined()
  })

  it('keeps non-deployment outcome semantics after exact causal proof', () => {
    const observation = watchObservation(snapshot('not-achieved') as never, scope, run, now, trace)
    expect(observation).toMatchObject({ runId: run.id, objectiveStatus: 'not-achieved' })
    expect(observation).not.toHaveProperty('taskFamilyDigest')
  })

  it.each([
    { ...taskFamily, goalDefinitionDigest: 'e'.repeat(64) },
    { ...taskFamily, outcomeProfile: { ...taskFamily.outcomeProfile, id: 'other' } },
    { ...taskFamily, outcomeProfile: { ...taskFamily.outcomeProfile, version: 2 } },
    { ...taskFamily, outcomeProfile: { ...taskFamily.outcomeProfile, digest: 'e'.repeat(64) } },
  ])('rejects an unrelated Goal or outcome profile for both positive and negative outcomes', family => {
    expect(watchObservation(snapshot('achieved') as never, scope, run, now, trace, family)).toBeUndefined()
    expect(watchObservation(snapshot('not-achieved') as never, scope, run, now, trace, family)).toBeUndefined()
  })

  it('uses the latest canonical revision rather than preserving the original achieved receipt forever', () => {
    const firstSnapshot = snapshot('achieved')
    const first = watchObservationResult(firstSnapshot as never, scope, run, now, trace, taskFamily, canonicalOutcome('achieved'), trusted)
    expect(first).toMatchObject({ kind: 'current', observation: { runId: run.id, objectiveStatus: 'achieved', canonical: {
      subjectKind: 'goal-outcome', subjectRef: 'assessment', version: 1, disposition: 'upsert', scopeWatermark: 1,
    } } })

    // The immutable verifier receipt remains achieved. The canonical owner
    // correction is the newer truth consumed by deployment monitoring.
    const correctedSnapshot = snapshot('achieved')
    const corrected = watchObservationResult(correctedSnapshot as never, scope, run, now, trace, taskFamily, canonicalOutcome('not-achieved', 2), trusted)
    expect(corrected).toMatchObject({ kind: 'current', observation: { runId: run.id, objectiveStatus: 'not-achieved', canonical: {
      subjectKind: 'goal-outcome', subjectRef: 'assessment', version: 2, disposition: 'upsert', scopeWatermark: 2,
    } } })
    expect(corrected).not.toEqual(first)
  })

  it('turns a canonical withdrawal into an explicit invalidation of the prior observation', () => {
    const snapshotValue = snapshot('achieved')
    const withdrawn = watchObservationResult(snapshotValue as never, scope, run, now, trace, taskFamily, canonicalOutcome('achieved', 3, 'retract'), trusted)
    expect(withdrawn).toMatchObject({ kind: 'invalidated', runId: run.id, canonical: {
      subjectKind: 'goal-outcome', subjectRef: 'assessment', version: 3, disposition: 'retract', scopeWatermark: 3,
    } })
    expect(withdrawn).not.toHaveProperty('observation')
  })

  it.each([
    ['wrong canonical run', (value: ReturnType<typeof canonicalOutcome>) => { value.projection.subjectRef = 'other-assessment'; return value }],
    ['wrong canonical owner scope', (value: ReturnType<typeof canonicalOutcome>) => { value.scope = { ...value.scope, workspace: '/foreign' }; return value }],
    ['wrong canonical projection digest', (value: ReturnType<typeof canonicalOutcome>) => { value.projection.digest = 'f'.repeat(64); return value }],
  ])('rejects %s instead of weakening exact run, owner, or profile binding', (_name, mutate) => {
    const canonical = mutate(canonicalOutcome('achieved', 2))
    expect(watchObservationResult(snapshot('achieved') as never, scope, run, now, trace, taskFamily, canonical, trusted)).toBeUndefined()
  })
})
