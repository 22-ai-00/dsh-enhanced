import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { validateTaskAcceptanceContract, validateTaskVerificationReceipt } from '@dsh-enhanced/task-acceptance-contract'
import type { GoalScope } from './types.js'

export interface OwnerVerifiedArtifactsInput {
  readonly ownerRouteId: string
  readonly principalId: string
  readonly workspace: string
  readonly preset: string
  readonly sessionId: string
  readonly goalId: string
  readonly runId: string
  readonly paths: readonly string[]
}

type AcceptedTask = { readonly state: string; readonly contract: unknown; readonly receipt: unknown; readonly verifierExecutionObservation: unknown }
type Snapshot = { readonly ownerRoute: unknown; readonly storedGoal: { readonly id: string; readonly scope: GoalScope; readonly definition: { readonly version: number; readonly digest: string; readonly objective: string }; readonly nativeAtLastObservation: { readonly sessionId: string; readonly goalId: string; readonly revision: number; readonly phase: string } }; readonly executionRuns: readonly unknown[]; readonly outcomeAssessments: readonly { readonly contract: unknown; readonly triggerRunId: string | null; readonly execution: unknown }[]; readonly acceptedTasks: readonly AcceptedTask[] }
type Artifact = { readonly path: string; readonly content: string; readonly sha256: string; readonly jobId: string }
type Isolation = { readAcceptedArtifact(contract: unknown, path: string): unknown }

const freeze = <T>(value: T): Readonly<T> => {
  const copy = JSON.parse(JSON.stringify(value)) as T
  const visit = (item: unknown): void => {
    if (item === null || typeof item !== 'object' || Object.isFrozen(item)) return
    for (const child of Object.values(item as Record<string, unknown>)) visit(child)
    Object.freeze(item)
  }
  visit(copy)
  return copy as Readonly<T>
}
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)
const failed = (): never => { throw new Error('assistant-goals: verified artifact evidence is unavailable') }

export function validateOwnerVerifiedArtifactsInput(value: unknown): OwnerVerifiedArtifactsInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) failed()
  const input = value as Record<string, unknown>; const keys = Object.keys(input)
  if (keys.length !== 8 || !['ownerRouteId', 'principalId', 'workspace', 'preset', 'sessionId', 'goalId', 'runId', 'paths'].every(key => keys.includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(input)).some(item => !item.enumerable || !('value' in item))) failed()
  for (const key of ['ownerRouteId', 'principalId', 'workspace', 'preset', 'sessionId', 'goalId', 'runId'] as const) {
    if (typeof input[key] !== 'string' || input[key].length === 0 || input[key].length > 4096) failed()
  }
  const rawPaths = input.paths
  if (!Array.isArray(rawPaths) || rawPaths.length < 1 || rawPaths.length > 32) failed()
  const paths = (rawPaths as unknown[]).map((path): string => {
    if (typeof path !== 'string' || path.length === 0 || path.length > 4096 || posix.isAbsolute(path) || posix.normalize(path) !== path || path.split('/').includes('..') || path.includes('\\')) failed()
    return path as string
  })
  if (new Set(paths).size !== paths.length) failed()
  return Object.freeze({ ownerRouteId: input.ownerRouteId as string, principalId: input.principalId as string, workspace: input.workspace as string,
    preset: input.preset as string, sessionId: input.sessionId as string, goalId: input.goalId as string, runId: input.runId as string, paths: Object.freeze(paths as string[]) })
}

function accepted(snapshot: Snapshot, id: string, kind: 'goal-step' | 'goal-outcome', now: number) {
  const item = snapshot.acceptedTasks.find(entry => {
    try { return validateTaskAcceptanceContract(entry.contract).id === id } catch { return false }
  })
  const found = item
  if (found === undefined || found.state !== 'done' || found.verifierExecutionObservation === null) return failed()
  const contract = validateTaskAcceptanceContract(found.contract)
  const receipt = validateTaskVerificationReceipt(contract, found.receipt)
  const execution = found.verifierExecutionObservation as { status?: unknown; quiescent?: unknown }
  if (contract.protocol !== 'task-acceptance/v4' || contract.task.kind !== kind || receipt.objectiveStatus !== 'achieved'
    || receipt.validUntil <= now || execution.status !== 'succeeded' || execution.quiescent !== true) failed()
  return { contract, receipt }
}

function artifactEvidence(receipt: ReturnType<typeof validateTaskVerificationReceipt>, criterionId: string, artifact: Artifact): boolean {
  const result = receipt.results.find(item => item.criterionId === criterionId)
  return result?.status === 'passed' && result.artifactDigest === artifact.sha256
    && result.evidence.some(item => item.kind === 'isolated-artifact' && item.ref === artifact.jobId && item.digest === artifact.sha256)
}

/** Builds a delivery-safe artifact snapshot from two independently read owner snapshots. */
export function buildOwnerVerifiedArtifacts(first: unknown, last: unknown, input: OwnerVerifiedArtifactsInput, isolation: Isolation, now = Date.now()) {
  const before = first as Snapshot; const after = last as Snapshot
  if (!before || !after || !same(before.ownerRoute, after.ownerRoute) || !same(before.storedGoal, after.storedGoal) || !same(before.executionRuns, after.executionRuns)
    || !same(before.outcomeAssessments, after.outcomeAssessments) || !same(before.acceptedTasks, after.acceptedTasks)) failed()
  const goal = before.storedGoal
  if (goal.id !== input.goalId || goal.nativeAtLastObservation.sessionId !== input.sessionId || !['active', 'complete'].includes(goal.nativeAtLastObservation.phase)) failed()
  const run = (before.executionRuns as readonly any[]).find(entry => entry?.intent?.runId === input.runId)
  if (!run || run.intent?.task?.kind !== 'goal-step' || run.intent.task.ref !== input.runId || run.intent.task.goal?.id !== goal.id
    || run.intent.task.goal.definitionVersion !== goal.definition.version || run.intent.task.goal.definitionDigest !== goal.definition.digest
    || run.intent.task.goal.sessionId !== goal.nativeAtLastObservation.sessionId || run.intent.task.goal.nativeGoalId !== goal.nativeAtLastObservation.goalId
    || run.execution?.status !== 'succeeded' || run.execution?.quiescent !== true || !run.acceptance?.contractId) failed()
  const step = accepted(before, run.acceptance.contractId, 'goal-step', now)
  if (step.contract.digest !== run.acceptance.contractDigest || !same(step.contract.task, run.intent.task)
    || step.contract.scope.workspace !== goal.scope.workspace || step.contract.scope.preset !== goal.scope.preset
    || step.contract.owner.principalRecordId !== goal.scope.principalRecordId || step.contract.owner.principalVersion !== goal.scope.principalVersion) failed()
  const assessment = before.outcomeAssessments[0]
  if (assessment === undefined || assessment.triggerRunId !== input.runId || assessment.execution === null) return failed()
  const outcomeContract = validateTaskAcceptanceContract(assessment.contract)
  if (outcomeContract.task.kind !== 'goal-outcome' || outcomeContract.task.goal.id !== goal.id
    || outcomeContract.task.goal.definitionVersion !== goal.definition.version || outcomeContract.task.goal.definitionDigest !== goal.definition.digest
    || outcomeContract.task.goal.sessionId !== goal.nativeAtLastObservation.sessionId || outcomeContract.task.goal.nativeGoalId !== goal.nativeAtLastObservation.goalId) failed()
  const outcome = accepted(before, outcomeContract.id, 'goal-outcome', now)
  if (!same(outcome.contract, outcomeContract) || outcome.contract.scope.workspace !== goal.scope.workspace || outcome.contract.scope.preset !== goal.scope.preset
    || outcome.contract.owner.principalRecordId !== goal.scope.principalRecordId || outcome.contract.owner.principalVersion !== goal.scope.principalVersion) failed()
  const files: Artifact[] = []; let bytes = 0
  for (const path of input.paths) {
    const stepCriteria = step.contract.criteria.filter(item => item.kind === 'isolated-process-behavior' && item.artifactPath === path)
    const outcomeCriteria = outcome.contract.criteria.filter(item => item.kind === 'isolated-process-behavior' && item.artifactPath === path)
    if (stepCriteria.length === 0 || outcomeCriteria.length === 0) failed()
    const raw = isolation.readAcceptedArtifact(step.contract, path) as Partial<Artifact>
    if (!raw || raw.path !== path || typeof raw.content !== 'string' || typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256) || typeof raw.jobId !== 'string' || raw.jobId.length === 0) failed()
    const artifact: Artifact = { path, content: raw.content as string, sha256: raw.sha256 as string, jobId: raw.jobId as string }
    if (createHash('sha256').update(artifact.content).digest('hex') !== artifact.sha256 || !stepCriteria.every(item => artifactEvidence(step.receipt, item.id, artifact))
      || !outcomeCriteria.every(item => artifactEvidence(outcome.receipt, item.id, artifact))) failed()
    bytes += Buffer.byteLength(artifact.content, 'utf8'); if (bytes > 1_048_576) failed()
    files.push(artifact)
  }
  return freeze({ protocol: 'assistant-goals/verified-artifacts/v1' as const, scope: goal.scope,
    goal: { id: goal.id, definition: goal.definition, sessionId: goal.nativeAtLastObservation.sessionId, nativeGoalId: goal.nativeAtLastObservation.goalId }, runId: input.runId,
    acceptance: { stepContractId: step.contract.id, stepContractDigest: step.contract.digest, outcomeContractId: outcome.contract.id, outcomeContractDigest: outcome.contract.digest,
      stepReceiptDigest: step.receipt.digest, outcomeReceiptDigest: outcome.receipt.digest, validUntil: Math.min(step.receipt.validUntil, outcome.receipt.validUntil) }, files })
}
