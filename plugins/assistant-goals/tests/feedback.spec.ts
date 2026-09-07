import { describe, expect, test } from 'vitest'
import { createTaskAcceptanceContract, createTaskVerificationReceipt } from '@dsh-enhanced/task-acceptance-contract'
import { buildGoalFeedback } from '../src/feedback.ts'
import type { GoalExecutionRun, GoalRecord } from '../src/types.ts'

const sha = 'a'.repeat(64)
const record = (): GoalRecord => ({
  id: 'goal-1', scope: { principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 2, workspace: '/work/goal', preset: 'primary' },
  originalObjective: 'finish', definition: { version: 3, digest: sha, objective: 'x'.repeat(300) },
  native: { sessionId: 'session-1', goalId: 'native-goal-1', revision: 5, objective: 'finish', phase: 'active', roundsStarted: 1, maxGoalRounds: 3, updatedAt: 1 },
  checkpoint: { nextStep: 'untrusted checkpoint', blockers: [], assumptions: [], evidenceRefs: [], dependencies: [] }, version: 1, createdAt: 1, updatedAt: 1,
})
function run(overrides: Partial<GoalExecutionRun> = {}): GoalExecutionRun {
  const goal = record()
  return { intent: { runId: 'run-1', scope: goal.scope, objective: goal.definition.objective,
    admission: { issuedAt: 100, expiresAt: 5_000, maxGoalRounds: 3, round: 1, authorizationDigest: sha },
    task: { kind: 'goal-step', ref: 'run-1', goal: { id: goal.id, definitionVersion: goal.definition.version, definitionDigest: goal.definition.digest, stepId: 'step-1', runId: 'run-1', sessionId: 'session-1', nativeGoalId: 'native-goal-1', nativeRevision: 5 } },
  }, acceptance: { contractId: 'contract-1', contractDigest: sha }, dispatchedAt: 200,
  execution: { status: 'succeeded', quiescent: true, completedAt: 300 }, ...overrides }
}
function accepted(status: 'passed' | 'failed' | 'unknown' = 'passed', validUntil = 4_000, options: { ownerVersion?: number; taskRef?: string } = {}) {
  const value = run(); const goal = record()
  const task = options.taskRef === undefined ? value.intent.task : { ...value.intent.task, ref: options.taskRef, goal: { ...value.intent.task.goal, runId: options.taskRef } }
  const contract = createTaskAcceptanceContract({ protocol: 'task-acceptance/v2', id: 'contract-1',
    scope: { workspace: goal.scope.workspace, preset: goal.scope.preset }, owner: { principalRecordId: goal.scope.principalRecordId, principalVersion: options.ownerVersion ?? goal.scope.principalVersion },
    task, objective: value.intent.objective, profile: { id: 'goal-profile', version: 1, digest: sha }, issuedAt: 100, expiresAt: 5_000,
    criteria: [{ id: 'criterion-1', kind: 'document-citations', authority: { id: 'sources', digest: sha }, artifactPath: 'report.md', requiredText: ['done'], quotes: [] }], bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 },
  })
  const receipt = createTaskVerificationReceipt(contract, { protocol: 'task-verification/v2', id: 'receipt-1', contractId: contract.id, contractDigest: contract.digest,
    scope: contract.scope, owner: contract.owner, task: contract.task,
    results: [{ criterionId: 'criterion-1', status, reason: status === 'passed' ? 'verified' : status === 'failed' ? 'not-verified' : 'verification-unavailable', evidence: [{ kind: 'document', ref: 'report.md', digest: sha }] }],
    startedAt: 300, completedAt: 400, validUntil,
  })
  return { contract, receipt, execution: { status: 'succeeded', quiescent: true, completedAt: 300, executionRef: 'run-1' } }
}
function acceptedV4() {
  const value = run(); const goal = record()
  const contract = createTaskAcceptanceContract({ protocol: 'task-acceptance/v4', id: 'contract-v4',
    scope: { workspace: goal.scope.workspace, preset: goal.scope.preset }, owner: { principalRecordId: goal.scope.principalRecordId, principalVersion: goal.scope.principalVersion },
    task: value.intent.task, objective: value.intent.objective, profile: { id: 'goal-profile', version: 1, digest: sha }, issuedAt: 100, expiresAt: 5_000,
    criteria: [{ id: 'isolated', kind: 'isolated-process-behavior', authority: { id: 'isolation-runner', digest: sha }, artifactPath: 'artifacts/behavior.sh', testSetId: 'private-set' }], bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 },
  })
  const receipt = createTaskVerificationReceipt(contract, { protocol: 'task-verification/v4', id: 'receipt-v4', contractId: contract.id, contractDigest: contract.digest,
    scope: contract.scope, owner: contract.owner, task: contract.task,
    results: [{ criterionId: 'isolated', status: 'passed', reason: 'verified', evidence: [{ kind: 'isolated-artifact', ref: 'job-1:isolated', digest: sha }] }],
    startedAt: 300, completedAt: 400, validUntil: 4_000,
  })
  return { contract, receipt, execution: { status: 'succeeded', quiescent: true, completedAt: 300, executionRef: 'run-1' } }
}

describe('goal feedback', () => {
  test('binds a current v2 receipt to the exact run and exposes bounded criteria without completing the goal', () => {
    const proof = accepted()
    const input = run({ acceptance: { contractId: proof.contract.id, contractDigest: proof.contract.digest } })
    const feedback = buildGoalFeedback(record(), [input], id => id === proof.contract.id ? { contract: proof.contract, receipt: proof.receipt, execution: proof.execution } : null, 1_000)
    expect(feedback).toMatchObject({ goalOutcome: 'unverified', definition: { objective: { truncated: true } }, verification: { current: { status: 'achieved', criteria: [{ id: 'criterion-1', status: 'passed', evidence: [{ ref: 'report.md' }] }] }, pending: null } })
    expect(Object.isFrozen(feedback)).toBe(true)
  })

  test('binds a v4 isolated goal-step receipt without exposing a private test set', () => {
    const proof = acceptedV4(); const input = run({ acceptance: { contractId: proof.contract.id, contractDigest: proof.contract.digest } })
    const feedback = buildGoalFeedback(record(), [input], id => id === proof.contract.id ? { contract: proof.contract, receipt: proof.receipt, execution: proof.execution } : null, 1_000)
    expect(feedback.verification.current).toMatchObject({ status: 'achieved', criteria: [{ id: 'isolated', definition: { kind: 'isolated-process-behavior', artifactPath: 'artifacts/behavior.sh' } }] })
    expect(JSON.stringify(feedback)).not.toContain('private-set')
  })

  test('fails closed for forged receipt, task, owner, and execution bindings, and expires old successes', () => {
    const proof = accepted()
    const input = run({ acceptance: { contractId: proof.contract.id, contractDigest: proof.contract.digest } })
    const forged = [
      { contract: proof.contract, receipt: { ...proof.receipt, contractId: 'other-contract' }, execution: proof.execution },
      { contract: { ...proof.contract, task: { ...proof.contract.task, ref: 'other-run' } }, receipt: proof.receipt, execution: proof.execution },
      { contract: { ...proof.contract, owner: { ...proof.contract.owner, principalVersion: 3 } }, receipt: proof.receipt, execution: proof.execution },
      { contract: proof.contract, receipt: proof.receipt, execution: { ...proof.execution, executionRef: 'other-run' } },
    ]
    for (const value of forged) {
      expect(buildGoalFeedback(record(), [input], () => value, 1_000).verification.current?.status).toBe('invalid')
    }
    expect(buildGoalFeedback(record(), [run({ acceptance: { contractId: proof.contract.id, contractDigest: 'b'.repeat(64) } })], () => ({ contract: proof.contract, receipt: proof.receipt, execution: proof.execution }), 1_000).verification.current?.status).toBe('invalid')
    for (const signed of [accepted('passed', 4_000, { ownerVersion: 3 }), accepted('passed', 4_000, { taskRef: 're-signed-run' })]) {
      const signedInput = run({ acceptance: { contractId: signed.contract.id, contractDigest: signed.contract.digest } })
      expect(buildGoalFeedback(record(), [signedInput], () => ({ contract: signed.contract, receipt: signed.receipt, execution: proof.execution }), 1_000).verification.current?.status).toBe('invalid')
    }
    expect(buildGoalFeedback(record(), [input], () => ({ contract: proof.contract, receipt: proof.receipt, execution: proof.execution }), 350).verification.current?.status).toBe('invalid')
    expect(buildGoalFeedback(record(), [input], () => { throw new Error('lookup unavailable') }, 1_000).verification.current?.status).toBe('unavailable')
    const expiredProof = accepted('passed', 900)
    const expiredInput = run({ acceptance: { contractId: expiredProof.contract.id, contractDigest: expiredProof.contract.digest } })
    expect(buildGoalFeedback(record(), [expiredInput], () => ({ contract: expiredProof.contract, receipt: expiredProof.receipt, execution: expiredProof.execution }), 1_000).verification.current?.status).toBe('expired')
  })

  test('keeps a latest unknown terminal from being hidden by an earlier failure and treats a missing receipt as pending', () => {
    const proof = accepted('failed')
    const failed = run({ acceptance: { contractId: proof.contract.id, contractDigest: proof.contract.digest } })
    const pending = run({ intent: { ...run().intent, runId: 'run-2', task: { ...run().intent.task, ref: 'run-2', goal: { ...run().intent.task.goal, runId: 'run-2' } } }, execution: { status: 'unknown', quiescent: false, completedAt: 500 } })
    const output = buildGoalFeedback(record(), [pending, failed], id => id === proof.contract.id ? { contract: proof.contract, receipt: proof.receipt, execution: proof.execution } : null, 1_000)
    expect(output.verification.current?.status).toBe('unknown')
    expect(output.verification.pending).toBeNull()
    expect(output.nextAction).toBe('reconcile-execution')
    const preparing = run(); delete preparing.execution; delete preparing.dispatchedAt
    const offline = buildGoalFeedback(record(), [preparing, pending, failed], undefined, 1_000)
    expect(offline.verification.pending?.status).toBe('pending')
    expect(offline.verification.current?.status).toBe('unknown')
    expect(offline.nextAction).toBe('reconcile-execution')
    const edited = { ...record(), definition: { ...record().definition, version: 4 } }
    expect(buildGoalFeedback(edited, [pending], undefined, 1_000).nextAction).toBe('reconcile-execution')
    const awaiting = buildGoalFeedback(record(), [failed], () => ({ contract: proof.contract, receipt: null, execution: proof.execution }), 1_000)
    expect(awaiting.verification.current).toBeNull()
    expect(awaiting.verification.pending?.status).toBe('pending')
    expect(awaiting.nextAction).toBe('await-verification')
    expect(buildGoalFeedback(record(), [failed], () => ({ contract: proof.contract, receipt: null, execution: null }), 6_000).verification.current?.status).toBe('expired')
    const old = run({ intent: { ...run().intent, task: { ...run().intent.task, goal: { ...run().intent.task.goal, definitionVersion: 2 } } } })
    expect(buildGoalFeedback(record(), [old], undefined, 1_000).nextAction).toBe('plan-current-definition')
    expect(buildGoalFeedback(record(), [failed], undefined, 1_000).verification.current?.status).toBe('unavailable')
  })

  test('bounds caller-provided run history to fifty and feedback history to three', () => {
    const runs = Array.from({ length: 60 }, (_, index) => {
      const pending = run({ intent: { ...run().intent, runId: `run-${index}`, task: { ...run().intent.task, ref: `run-${index}`, goal: { ...run().intent.task.goal, runId: `run-${index}` } } } })
      delete pending.execution
      return pending
    })
    const feedback = buildGoalFeedback(record(), runs, undefined, 1_000)
    expect(feedback.verification.history).toHaveLength(3)
    expect(feedback.verification.history.map(entry => entry.runId)).toEqual(['run-0', 'run-1', 'run-2'])
    const foreign = run({ intent: { ...run().intent, scope: { ...run().intent.scope, principalId: 'other-owner' } } })
    expect(buildGoalFeedback(record(), [foreign], undefined, 1_000).verification.history).toEqual([])
  })
})
