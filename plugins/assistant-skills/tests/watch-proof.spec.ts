import { describe, expect, it } from 'vitest'
import type { OwnerGoalRunProof } from '@dsh-enhanced/assistant-goals'
import { acceptanceDigest, createTaskAcceptanceContract, createTaskVerificationReceipt } from '@dsh-enhanced/task-acceptance-contract'
import type { SkillRun } from '../src/store.ts'
import { soleSkillRunTrace, watchObservation } from '../src/watch-proof.ts'

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
})
