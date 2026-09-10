import type { AssistantGoalsService, GoalScope, OwnerGoalRunProof } from '@dsh-enhanced/assistant-goals'
import { acceptanceDigest, validateTaskAcceptanceContract, validateTaskVerificationReceipt } from '@dsh-enhanced/task-acceptance-contract'
import type { SkillRun, SkillWatchObservation, SkillWatchTaskFamily } from './store.js'

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return false
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => descriptor.enumerable && 'value' in descriptor)
}
function exact(value: unknown, allowed: readonly string[]): Record<string, unknown> | undefined {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) return
  return value
}
function inputs(value: unknown): unknown {
  if (value === undefined) return {}
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 262144) return
  try { const parsed: unknown = JSON.parse(value); return record(parsed) ? parsed : undefined } catch { return }
}

/**
 * A deployment observation may credit only the exact persisted skill_run.
 * Metadata calls are narrow, parameter-validated reads; every other call is
 * business execution and therefore breaks causal attribution.
 */
export function soleSkillRunTrace(trace: OwnerGoalRunProof, run: SkillRun, source: {
  intent: { runId: string; task: { goal: { nativeRevision: number } } }
}): string | undefined {
  const { traceDigest: _traceDigest, ...payload } = trace
  if (!record(trace) || Object.keys(trace).length !== 8 || trace.protocol !== 'assistant-goals/owner-run-trace/v1'
    || trace.traceDigest !== acceptanceDigest(payload) || trace.runId !== run.goalExecutionRunId || source.intent.runId !== run.goalExecutionRunId
    || trace.definitionDigest !== run.goalDefinitionDigest || trace.nativeRevision !== source.intent.task.goal.nativeRevision
    || !Number.isSafeInteger(trace.turn) || trace.turn < 1 || !Array.isArray(trace.steps) || trace.steps.length < 1 || trace.steps.length > 32
    || !record(trace.outcomeProfile) || Object.keys(trace.outcomeProfile).length !== 3 || typeof trace.outcomeProfile.id !== 'string'
    || !Number.isSafeInteger(trace.outcomeProfile.version) || trace.outcomeProfile.version < 1 || typeof trace.outcomeProfile.digest !== 'string'
    || !/^[a-f0-9]{64}$/u.test(trace.outcomeProfile.digest)) return
  const ids = new Set<string>(); let skillRuns = 0
  for (const step of trace.steps) {
    if (!record(step) || Object.keys(step).length !== 4 || !['id', 'name', 'arguments', 'outcome'].every(key => Object.hasOwn(step, key))
      || typeof step.id !== 'string' || step.id.length < 1 || step.id.length > 512 || ids.has(step.id)
      || typeof step.name !== 'string' || step.name.length < 1 || step.name.length > 128 || step.outcome !== 'succeeded') return
    ids.add(step.id)
    const args = exact(step.arguments, step.name === 'skill_run' ? ['goal_id', 'name', 'version', 'inputs_json', 'invocation_id']
      : step.name === 'skill_status' ? ['run_id'] : step.name === 'goal_context' ? ['goal_id', 'focus'] : [])
    if (!args) return
    if (step.name === 'skill_run') {
      skillRuns++
      const parsedInputs = inputs(args.inputs_json)
      if (skillRuns !== 1 || args.goal_id !== run.goalId || args.name !== run.skillName || args.version !== run.version
        || args.invocation_id !== run.invocationId || parsedInputs === undefined || acceptanceDigest(parsedInputs) !== acceptanceDigest(run.inputs)) return
      continue
    }
    if (step.name === 'get_goal' && Object.keys(args).length === 0) continue
    if (step.name === 'skill_status' && (Object.keys(args).length === 0 || args.run_id === run.id)) continue
    if (step.name === 'goal_context' && (Object.keys(args).length === 0
      || args.goal_id === run.goalId && (args.focus === undefined || args.focus === false))) continue
    return
  }
  return skillRuns === 1 ? trace.traceDigest : undefined
}

/** Host snapshots are revalidated against the invocation captured before native dispatch. */
export function watchObservation(snapshot: ReturnType<AssistantGoalsService['inspectOwnerGoalExecution']>, scope: GoalScope, run: SkillRun, now: number, trace: OwnerGoalRunProof, taskFamily?: SkillWatchTaskFamily): SkillWatchObservation | undefined {
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
  if (trace.outcomeProfile.id !== contract.profile.id || trace.outcomeProfile.version !== contract.profile.version || trace.outcomeProfile.digest !== contract.profile.digest
    || taskFamily !== undefined && (taskFamily.goalDefinitionDigest !== run.goalDefinitionDigest
    || contract.profile.id !== taskFamily.outcomeProfile.id || contract.profile.version !== taskFamily.outcomeProfile.version
    || contract.profile.digest !== taskFamily.outcomeProfile.digest)) return
  const accepted = snapshot.acceptedTasks.find(value => value.contractId === contract.id && value.contract?.digest === contract.digest && value.state === 'done')
  if (!accepted?.receipt || acceptanceDigest(accepted.verifierExecutionObservation) !== acceptanceDigest({ ...assessment.execution, executionRef: contract.task.ref })) return
  const receipt = validateTaskVerificationReceipt(contract, accepted.receipt)
  if (!['achieved', 'not-achieved'].includes(receipt.objectiveStatus) || receipt.validUntil <= now || receipt.completedAt > now
    || receipt.startedAt < Math.max(run.updatedAt, source.execution.completedAt, assessment.execution.completedAt)) return
  const executionTraceDigest = soleSkillRunTrace(trace, run, source)
  if (executionTraceDigest === undefined) return
  return { runId: run.id, receiptDigest: receipt.digest, objectiveStatus: receipt.objectiveStatus as 'achieved' | 'not-achieved', verifiedAt: receipt.completedAt, validUntil: receipt.validUntil, executionTraceDigest,
    ...(taskFamily === undefined ? {} : { taskFamilyDigest: acceptanceDigest(taskFamily) }) }
}
