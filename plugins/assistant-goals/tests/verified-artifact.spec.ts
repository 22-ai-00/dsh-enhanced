import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createTaskAcceptanceContract, createTaskVerificationReceipt } from '@dsh-enhanced/task-acceptance-contract'
import { buildOwnerVerifiedArtifacts, validateOwnerVerifiedArtifactsInput } from '../src/verified-artifact.ts'

const now = 1_800_000_000_000
const scope = { principalId: 'owner', principalRecordId: 'record-owner', principalVersion: 1, workspace: '/workspace', preset: 'primary' }
const goal = { id: 'goal', definition: { version: 1, digest: createHash('sha256').update('{"objective":"deliver"}').digest('hex'), objective: 'deliver' }, nativeAtLastObservation: { sessionId: 'session', goalId: 'native', revision: 3, phase: 'complete' } }
const task = { kind: 'goal-step' as const, ref: 'run', goal: { id: goal.id, definitionVersion: 1, definitionDigest: goal.definition.digest, stepId: 'round-1', runId: 'run', sessionId: 'session', nativeGoalId: 'native', nativeRevision: 2 } }
const criterion = (id: string) => ({ id, kind: 'isolated-process-behavior' as const, authority: { id: 'runner', digest: 'a'.repeat(64) }, artifactPath: 'artifacts/release.txt', testSetId: 'set' })
const step = createTaskAcceptanceContract({ protocol: 'task-acceptance/v4', id: 'step', scope: { workspace: scope.workspace, preset: scope.preset }, owner: { principalRecordId: scope.principalRecordId, principalVersion: 1 }, task, objective: goal.definition.objective, profile: { id: 'step-profile', version: 1, digest: 'b'.repeat(64) }, issuedAt: now - 10, expiresAt: now + 10_000, criteria: [criterion('step-file')], bounds: { maxDurationMs: 1000, maxEvidenceBytes: 4096 } })
const outcomeTask = { kind: 'goal-outcome' as const, ref: 'assessment', goal: { id: goal.id, definitionVersion: 1, definitionDigest: goal.definition.digest, assessmentId: 'assessment', sessionId: 'session', nativeGoalId: 'native' } }
const outcome = createTaskAcceptanceContract({ protocol: 'task-acceptance/v4', id: 'outcome', scope: { workspace: scope.workspace, preset: scope.preset }, owner: { principalRecordId: scope.principalRecordId, principalVersion: scope.principalVersion }, task: outcomeTask, objective: goal.definition.objective, profile: { id: 'outcome-profile', version: 1, digest: 'c'.repeat(64) }, issuedAt: now - 10, expiresAt: now + 9_000, criteria: [criterion('outcome-file')], bounds: { maxDurationMs: 1000, maxEvidenceBytes: 4096 } })
const content = 'approved artifact\n'; const sha256 = createHash('sha256').update(content).digest('hex')
const receipt = (contract: typeof step, id: string, criterionId: string) => createTaskVerificationReceipt(contract, { protocol: 'task-verification/v4', id, contractId: contract.id, contractDigest: contract.digest, scope: contract.scope, owner: contract.owner, task: contract.task, results: [{ criterionId, status: 'passed', reason: 'verified', artifactDigest: sha256, evidence: [{ kind: 'isolated-artifact', ref: 'job', digest: sha256 }] }], startedAt: now - 5, completedAt: now - 1, validUntil: now + 8_000 })
function snapshot() {
  const execution = { status: 'succeeded', quiescent: true, completedAt: now - 1, executionRef: 'run' }
  return { ownerRoute: { route: 1 }, storedGoal: { ...goal, scope }, executionRuns: [{ intent: { runId: 'run', task }, acceptance: { contractId: step.id, contractDigest: step.digest }, execution: { status: 'succeeded', quiescent: true, completedAt: now - 1 } }], outcomeAssessments: [{ contract: outcome, triggerRunId: 'run', execution: { status: 'succeeded', quiescent: true, completedAt: now - 1 } }], acceptedTasks: [{ state: 'done', contract: step, receipt: receipt(step, 'step-receipt', 'step-file'), verifierExecutionObservation: execution }, { state: 'done', contract: outcome, receipt: receipt(outcome, 'outcome-receipt', 'outcome-file'), verifierExecutionObservation: { ...execution, executionRef: 'assessment' } }] }
}

describe('verified artifact source', () => {
  it('returns only jointly accepted, isolated artifact bytes in a frozen snapshot', () => {
    const input = validateOwnerVerifiedArtifactsInput({ ownerRouteId: 'route', principalId: 'owner', workspace: '/workspace', preset: 'primary', sessionId: 'session', goalId: 'goal', runId: 'run', paths: ['artifacts/release.txt'] })
    const result = buildOwnerVerifiedArtifacts(snapshot(), snapshot(), input, { readAcceptedArtifact: () => ({ path: input.paths[0], content, sha256, jobId: 'job' }) }, now)
    expect(result).toMatchObject({ protocol: 'assistant-goals/verified-artifacts/v1', runId: 'run', acceptance: { stepContractId: 'step', outcomeContractId: 'outcome', validUntil: now + 8_000 }, files: [{ path: 'artifacts/release.txt', content, sha256, jobId: 'job' }] })
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.files)).toBe(true)
  })

  it('rejects unsafe paths, unaccepted files, altered content, and failed receipts', () => {
    expect(() => validateOwnerVerifiedArtifactsInput({ ownerRouteId: 'route', principalId: 'owner', workspace: '/workspace', preset: 'primary', sessionId: 'session', goalId: 'goal', runId: 'run', paths: ['../secret'] })).toThrow('unavailable')
    const input = validateOwnerVerifiedArtifactsInput({ ownerRouteId: 'route', principalId: 'owner', workspace: '/workspace', preset: 'primary', sessionId: 'session', goalId: 'goal', runId: 'run', paths: ['artifacts/release.txt'] })
    expect(() => buildOwnerVerifiedArtifacts(snapshot(), snapshot(), input, { readAcceptedArtifact: () => ({ path: input.paths[0], content: 'altered', sha256, jobId: 'job' }) }, now)).toThrow('unavailable')
    const changed = snapshot(); changed.acceptedTasks[1] = { ...changed.acceptedTasks[1]!, state: 'needs-attention' }
    expect(() => buildOwnerVerifiedArtifacts(changed, changed, input, { readAcceptedArtifact: () => ({ path: input.paths[0], content, sha256, jobId: 'job' }) }, now)).toThrow('unavailable')
  })

  it('rejects a different owner, run, definition/session, expiry, and unknown execution', () => {
    const input = validateOwnerVerifiedArtifactsInput({ ownerRouteId: 'route', principalId: 'owner', workspace: '/workspace', preset: 'primary', sessionId: 'session', goalId: 'goal', runId: 'run', paths: ['artifacts/release.txt'] })
    const artifact = { readAcceptedArtifact: () => ({ path: input.paths[0], content, sha256, jobId: 'job' }) }
    const cases: Array<(value: any) => void> = [
      value => { value.storedGoal.scope = { ...value.storedGoal.scope, principalRecordId: 'record-other' } },
      value => { value.executionRuns[0].intent.runId = 'other-run' },
      value => { value.storedGoal.definition = { ...value.storedGoal.definition, digest: 'd'.repeat(64) } },
      value => { value.storedGoal.nativeAtLastObservation.sessionId = 'other-session' },
      value => { value.executionRuns[0].execution = { status: 'unknown', quiescent: false, completedAt: now - 1 } },
    ]
    for (const mutate of cases) { const value = snapshot(); mutate(value); expect(() => buildOwnerVerifiedArtifacts(value, value, input, artifact, now)).toThrow('unavailable') }
    const routeChanged = snapshot(); routeChanged.ownerRoute = { route: 2 }
    expect(() => buildOwnerVerifiedArtifacts(snapshot(), routeChanged, input, artifact, now)).toThrow('unavailable')
    expect(() => buildOwnerVerifiedArtifacts(snapshot(), snapshot(), input, artifact, now + 8_001)).toThrow('unavailable')
    const unaccepted = validateOwnerVerifiedArtifactsInput({ ...input, paths: ['artifacts/not-accepted.txt'] })
    expect(() => buildOwnerVerifiedArtifacts(snapshot(), snapshot(), unaccepted, artifact, now)).toThrow('unavailable')
  })
})
