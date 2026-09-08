import type { AssistantGoalsService, GoalScope } from '@dsh-enhanced/assistant-goals'
import { acceptanceDigest, validateTaskAcceptanceContract, validateTaskVerificationReceipt } from '@dsh-enhanced/task-acceptance-contract'
import type { SkillRun, SkillWatchObservation } from './store.js'

/** Host snapshots are revalidated against the invocation captured before native dispatch. */
export function watchObservation(snapshot: ReturnType<AssistantGoalsService['inspectOwnerGoalExecution']>, scope: GoalScope, run: SkillRun, now: number): SkillWatchObservation | undefined {
  if (!run.goalExecutionRunId || !run.goalDefinitionDigest || !run.nativeGoalId || run.candidateId || run.state !== 'succeeded') return
  const record = snapshot.storedGoal
  if (record.id !== run.goalId || acceptanceDigest(record.scope) !== acceptanceDigest(scope) || record.definition.digest !== run.goalDefinitionDigest
    || record.nativeAtLastObservation.sessionId !== run.sessionId || record.nativeAtLastObservation.goalId !== run.nativeGoalId) return
  const source = snapshot.executionRuns.find(value => value.intent.runId === run.goalExecutionRunId)
  if (!source || source.execution?.status !== 'succeeded' || !source.execution.quiescent || source.dispatchedAt === undefined
    || acceptanceDigest(source.intent.scope) !== acceptanceDigest(scope)) return
  const expected = { id: run.goalId, definitionVersion: record.definition.version, definitionDigest: run.goalDefinitionDigest, sessionId: run.sessionId, nativeGoalId: run.nativeGoalId }
  const assessments = snapshot.outcomeAssessments.filter(value => value.triggerRunId === run.goalExecutionRunId)
  if (assessments.length !== 1) return
  const assessment = assessments[0]!
  const contract = validateTaskAcceptanceContract(assessment.contract)
  if (contract.task.kind !== 'goal-outcome' || Object.entries(expected).some(([key, value]) => contract.task.kind !== 'goal-outcome'
    || contract.task.goal[key as keyof typeof expected] !== value || source.intent.task.goal[key as keyof typeof expected] !== value)
    || contract.owner.principalRecordId !== scope.principalRecordId || contract.owner.principalVersion !== scope.principalVersion
    || contract.scope.workspace !== scope.workspace || contract.scope.preset !== scope.preset
    || assessment.execution?.status !== 'succeeded' || !assessment.execution.quiescent || assessment.dispatchedAt === null) return
  const accepted = snapshot.acceptedTasks.find(value => value.contractId === contract.id && value.contract?.digest === contract.digest && value.state === 'done')
  if (!accepted?.receipt || acceptanceDigest(accepted.verifierExecutionObservation) !== acceptanceDigest({ ...assessment.execution, executionRef: contract.task.ref })) return
  const receipt = validateTaskVerificationReceipt(contract, accepted.receipt)
  if (!['achieved', 'not-achieved'].includes(receipt.objectiveStatus) || receipt.validUntil <= now || receipt.completedAt > now
    || receipt.startedAt < Math.max(run.updatedAt, source.execution.completedAt, assessment.execution.completedAt)) return
  return { runId: run.id, receiptDigest: receipt.digest, objectiveStatus: receipt.objectiveStatus as 'achieved' | 'not-achieved', verifiedAt: receipt.completedAt, validUntil: receipt.validUntil }
}
