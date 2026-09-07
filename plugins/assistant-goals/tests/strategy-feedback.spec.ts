import { describe, expect, test, vi } from 'vitest'
import { createTaskAcceptanceContract, createTaskVerificationReceipt } from '@dsh-enhanced/task-acceptance-contract'
import { buildGoalStrategyHistory } from '../src/strategy-feedback.ts'
import type { GoalExecutionRun, GoalRecord } from '../src/types.ts'
import type { StrategyRecord } from '../src/strategy-store.ts'

const sha = 'a'.repeat(64)
const goal: GoalRecord = {
  id: 'goal-1', scope: { principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 2, workspace: '/work/goal', preset: 'primary' },
  originalObjective: 'finish', definition: { version: 3, digest: sha, objective: 'finish' },
  native: { sessionId: 'session-1', goalId: 'native-goal-1', revision: 5, objective: 'finish', phase: 'active', roundsStarted: 1, maxGoalRounds: 3, updatedAt: 1 },
  checkpoint: { nextStep: '', blockers: [], assumptions: [], evidenceRefs: [], dependencies: [] }, version: 1, createdAt: 1, updatedAt: 1,
}
function accepted(runId = 'run-1', status: 'passed' | 'failed' = 'failed') {
  const run: GoalExecutionRun = { intent: { runId, scope: goal.scope, objective: goal.definition.objective,
    admission: { issuedAt: 100, expiresAt: 5_000, maxGoalRounds: 3, round: 1, authorizationDigest: sha },
    task: { kind: 'goal-step', ref: runId, goal: { id: goal.id, definitionVersion: goal.definition.version, definitionDigest: sha,
      stepId: `step-${runId}`, runId, sessionId: goal.native.sessionId, nativeGoalId: goal.native.goalId, nativeRevision: 5 } },
  }, dispatchedAt: 200, execution: { status: 'succeeded', quiescent: true, completedAt: 800 } }
  const contract = createTaskAcceptanceContract({ protocol: 'task-acceptance/v2', id: `contract-${runId}`,
    scope: { workspace: goal.scope.workspace, preset: goal.scope.preset }, owner: { principalRecordId: goal.scope.principalRecordId, principalVersion: goal.scope.principalVersion },
    task: run.intent.task, objective: run.intent.objective, profile: { id: 'goal-profile', version: 1, digest: sha }, issuedAt: 100, expiresAt: 5_000,
    criteria: [{ id: 'answer', kind: 'document-citations', authority: { id: 'sources', digest: sha }, artifactPath: 'report.md', requiredText: ['done'], quotes: [] }],
    bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 },
  })
  run.acceptance = { contractId: contract.id, contractDigest: contract.digest }
  const receipt = createTaskVerificationReceipt(contract, { protocol: 'task-verification/v2', id: `receipt-${runId}`, contractId: contract.id, contractDigest: contract.digest,
    scope: contract.scope, owner: contract.owner, task: contract.task,
    results: [{ criterionId: 'answer', status, reason: status === 'passed' ? 'matched' : 'answer-mismatch', evidence: [{ kind: 'document', ref: 'report.md', digest: sha }] }],
    startedAt: 800, completedAt: 900, validUntil: 4_000,
  })
  return { run, proof: { contract, receipt, execution: { ...run.execution, executionRef: runId } } }
}
const strategy = (): StrategyRecord => ({
  intent: { id: 'strategy-1', goalId: goal.id, parentRunId: 'run-1', parentSessionId: goal.native.sessionId,
    definitionVersion: goal.definition.version, definitionDigest: sha, scope: goal.scope, kind: 'review', requestDigest: sha,
    provider: 'provider', model: 'model', maxChildren: 1, maxDurationMs: 200, createdAt: 300, expiresAt: 500 },
  state: 'settled', version: 4, children: [{ sessionId: 'child-1', stopReason: 'completed', quiescent: true }],
  completedAt: 450, outcome: 'advice', outputDigest: sha,
})
const usage = () => ({ modelCalls: 1, heldCalls: 0, inputTokens: 10, outputTokens: 4, costUsdMicros: null })

describe('exact strategy parent feedback', () => {
  test('associates advice with its failed parent, never a later passing run or causal credit', () => {
    const first = accepted(); const later = accepted('run-2', 'passed')
    const result = buildGoalStrategyHistory(goal, [strategy()], [later.run, first.run], id => id === first.proof.contract.id ? first.proof : later.proof, usage, 1_000)
    expect(result.records[0]).toMatchObject({ outcome: 'advice', attribution: 'same-parent-step-only', nextAction: 'revise-solution',
      parentStep: { runId: 'run-1', status: 'not-achieved', criteria: [{ status: 'failed' }] }, children: [{ usage: { modelCalls: 1 } }] })
    expect(JSON.stringify(result)).not.toContain('receipt-run-2')
    expect(Object.isFrozen(result.records[0]?.parentStep)).toBe(true)
    expect(Object.isFrozen(result.records[0]?.children[0]?.usage)).toBe(true)
  })

  test('does not look up a substituted parent/session/definition/scope/time or duplicate run', () => {
    const first = accepted(); const lookup = vi.fn(() => first.proof)
    const alternatives: GoalExecutionRun[][] = [[], [first.run, first.run],
      [{ ...first.run, intent: { ...first.run.intent, scope: { ...goal.scope, principalVersion: 3 } } }],
      [{ ...first.run, intent: { ...first.run.intent, task: { ...first.run.intent.task, goal: { ...first.run.intent.task.goal, sessionId: 'other' } } } }],
      [{ ...first.run, intent: { ...first.run.intent, task: { ...first.run.intent.task, goal: { ...first.run.intent.task.goal, definitionDigest: 'b'.repeat(64) } } } }],
      [{ ...first.run, dispatchedAt: 301 }],
    ]
    for (const runs of alternatives) expect(buildGoalStrategyHistory(goal, [strategy()], runs, lookup, usage, 1_000).records[0]).toMatchObject({ parentStep: null, nextAction: 'inspect-parent-verification' })
    expect(lookup).not.toHaveBeenCalled()
  })

  test('rechecks receipt identity, availability and expiry instead of caching parent success', () => {
    const first = accepted('run-1', 'passed')
    const assess = (lookup: ((id: string) => unknown) | undefined, now = 1_000) => buildGoalStrategyHistory(goal, [strategy()], [first.run], lookup, usage, now).records[0]!
    expect(assess(() => first.proof)).toMatchObject({ parentStep: { status: 'achieved' }, nextAction: 'review-remaining-goal' })
    expect(assess(() => first.proof, 4_001)).toMatchObject({ parentStep: { status: 'expired' }, nextAction: 'inspect-parent-verification' })
    expect(assess(undefined).parentStep?.status).toBe('unavailable')
    expect(assess(() => ({ ...first.proof, receipt: { ...first.proof.receipt, contractId: 'forged' } })).parentStep?.status).toBe('invalid')
    expect(assess(() => ({ ...first.proof, receipt: null }))).toMatchObject({ parentStep: { status: 'pending' }, nextAction: 'await-parent-verification' })
  })

  test('preserves operational uncertainty and old definitions without inventing reasoning failure', () => {
    const first = accepted('run-1', 'passed')
    const value = strategy(); value.state = 'unknown'; value.outcome = 'unknown'; value.children[0]!.quiescent = false
    expect(buildGoalStrategyHistory(goal, [value], [first.run], () => first.proof, usage, 1_000).records[0]).toMatchObject({ parentStep: { status: 'achieved' }, nextAction: 'reconcile-execution' })
    const changed = { ...goal, definition: { ...goal.definition, version: 4 } }
    expect(buildGoalStrategyHistory(changed, [strategy()], [first.run], () => first.proof, usage, 1_000).records[0]).toMatchObject({ definitionCurrent: false, parentStep: { status: 'achieved' }, nextAction: 'plan-current-definition' })
    value.state = 'settled'; value.outcome = 'execution-failed'; value.children[0]!.quiescent = true
    expect(buildGoalStrategyHistory(goal, [value], [first.run], () => first.proof, usage, 1_000).records[0]?.nextAction).toBe('inspect-strategy-execution')
  })

  test('bounds history and excludes foreign strategies before calling receipt or usage lookup', () => {
    const value = strategy(); value.intent.scope = { ...goal.scope, principalId: 'foreign' }
    const lookup = vi.fn(); const count = vi.fn(usage)
    expect(buildGoalStrategyHistory(goal, [value], [], lookup, count, 1_000).records).toEqual([])
    expect(count).not.toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled()
    expect(buildGoalStrategyHistory(goal, Array.from({ length: 40 }, strategy), [], undefined, usage, 1_000).records).toHaveLength(3)
  })
})
