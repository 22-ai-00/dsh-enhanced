import {
  acceptanceCanonicalJson,
  validateTaskAcceptanceContract,
  validateTaskVerificationReceipt,
} from '@dsh-enhanced/task-acceptance-contract'
import type { GoalExecutionRun, GoalRecord } from './types.js'

const MAX_RUNS = 50
const MAX_HISTORY = 3
const MAX_EVIDENCE = 3
const MAX_TEXT = 256

export type GoalFeedbackStatus = 'achieved' | 'not-achieved' | 'unknown' | 'pending' | 'unavailable' | 'invalid' | 'expired'

export interface GoalFeedbackText { readonly excerpt: string; readonly truncated: boolean }
export interface GoalFeedbackCriterion {
  readonly id: string; readonly status: 'passed' | 'failed' | 'unknown'; readonly reason: string
  readonly reasonTruncated: boolean
  readonly evidence: readonly Readonly<{ kind: string; ref: string; truncated: boolean }> []
  readonly definition: Readonly<{ kind: string; artifactPath?: string; objectId?: string; requiredText?: readonly GoalFeedbackText[]; requiredTextTruncated?: boolean }>
  readonly evidenceTruncated: boolean
}
export interface GoalStepFeedback {
  readonly runId: string; readonly definitionVersion: number; readonly status: GoalFeedbackStatus
  readonly execution: Readonly<{ status: 'succeeded' | 'unknown'; quiescent: boolean; completedAt: number; executionRef: string }> | null
  readonly criteria: readonly GoalFeedbackCriterion[]
  readonly criteriaTruncated: boolean
  readonly verification?: Readonly<{ contractId: string; receiptId: string; verifiedAt: number; validUntil: number }>
}
export interface GoalFeedback {
  readonly protocol: 'assistant-goals/feedback/v1'
  readonly goalId: string
  readonly goalOutcome: 'unverified'
  readonly definition: Readonly<{ version: number; digest: string; objective: GoalFeedbackText }>
  readonly verification: Readonly<{
    current: GoalStepFeedback | null
    pending: GoalStepFeedback | null
    history: readonly GoalStepFeedback[]
  }>
  readonly nextAction: 'reconcile-execution' | 'await-verification' | 'gather-evidence' | 'revise-plan' | 'review-remaining-criteria' | 'plan-current-definition' | 'inspect-verification'
}

type AcceptedTaskLookup = Readonly<{ contract: unknown; receipt: unknown; execution: unknown }>

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) freeze((value as Record<PropertyKey, unknown>)[key])
    Object.freeze(value)
  }
  return value
}
function excerpt(value: unknown): GoalFeedbackText {
  const text = typeof value === 'string' ? value : ''
  return freeze({ excerpt: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT })
}
function same(left: unknown, right: unknown): boolean {
  try { return acceptanceCanonicalJson(left) === acceptanceCanonicalJson(right) } catch { return false }
}
function unavailable(run: GoalExecutionRun, status: Extract<GoalFeedbackStatus, 'pending' | 'unavailable' | 'invalid' | 'unknown' | 'expired'>): GoalStepFeedback {
  const execution = run.execution === undefined ? null : freeze({ ...run.execution, executionRef: run.intent.runId })
  return freeze({ runId: run.intent.runId, definitionVersion: run.intent.task.goal.definitionVersion, status, execution, criteria: freeze([]), criteriaTruncated: false })
}
function criteria(contract: ReturnType<typeof validateTaskAcceptanceContract>, receipt: ReturnType<typeof validateTaskVerificationReceipt>): { values: readonly GoalFeedbackCriterion[]; truncated: boolean } {
  const values = receipt.results.slice(0, 32).map(result => {
    const criterion = contract.criteria.find(item => item.id === result.criterionId)!
    const definition = criterion.kind === 'process-behavior' || criterion.kind === 'isolated-process-behavior' || criterion.kind === 'document-citations'
      ? { kind: criterion.kind, artifactPath: criterion.artifactPath,
        ...(criterion.kind === 'document-citations' ? { requiredText: freeze(criterion.requiredText.slice(0, 3).map(excerpt)), requiredTextTruncated: criterion.requiredText.length > 3 } : {}) }
      : { kind: criterion.kind, objectId: criterion.objectId }
    const boundedReason = excerpt(result.reason)
    return freeze({
      id: result.criterionId, status: result.status, reason: boundedReason.excerpt, reasonTruncated: boundedReason.truncated,
      evidence: freeze(result.evidence.slice(0, MAX_EVIDENCE).map(item => {
        const bounded = excerpt(item.ref)
        return freeze({ kind: item.kind, ref: bounded.excerpt, truncated: bounded.truncated })
      })),
      definition: freeze(definition), evidenceTruncated: result.evidence.length > MAX_EVIDENCE,
    })
  })
  return freeze({ values: freeze(values), truncated: receipt.results.length > 32 })
}
function assessed(run: GoalExecutionRun, lookup: ((id: string) => unknown) | undefined, now: number): GoalStepFeedback {
  // The private execution ledger itself establishes uncertainty. Losing the
  // Verifier must never hide an unreconciled dispatch or make replay look safe.
  if (run.execution === undefined) return unavailable(run, run.intent.admission.expiresAt <= now ? 'expired' : 'pending')
  if (!run.execution.quiescent || run.execution.status === 'unknown') return unavailable(run, 'unknown')
  if (run.acceptance === undefined || lookup === undefined) return unavailable(run, 'unavailable')
  let raw: unknown
  try { raw = lookup(run.acceptance.contractId) } catch { return unavailable(run, 'unavailable') }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return unavailable(run, 'unavailable')
  const item = raw as Partial<AcceptedTaskLookup>
  try {
    const contract = validateTaskAcceptanceContract(item.contract)
    const execution = item.execution as Partial<{ status: unknown; quiescent: unknown; completedAt: unknown; executionRef: unknown }> | null
    if ((contract.protocol !== 'task-acceptance/v2' && contract.protocol !== 'task-acceptance/v4') || contract.id !== run.acceptance.contractId
      || contract.digest !== run.acceptance.contractDigest || !same(contract.task, run.intent.task)
      || contract.scope.workspace !== run.intent.scope.workspace || contract.scope.preset !== run.intent.scope.preset
      || contract.owner.principalRecordId !== run.intent.scope.principalRecordId || contract.owner.principalVersion !== run.intent.scope.principalVersion
      || contract.objective !== run.intent.objective || contract.issuedAt < run.intent.admission.issuedAt
      || run.dispatchedAt === undefined || contract.issuedAt > run.dispatchedAt || run.dispatchedAt >= run.intent.admission.expiresAt) return unavailable(run, 'invalid')
    if (run.execution.completedAt < run.dispatchedAt || run.execution.completedAt >= run.intent.admission.expiresAt || run.execution.completedAt > now) return unavailable(run, 'invalid')
    if (execution === null || typeof execution !== 'object') {
      return unavailable(run, item.receipt === null || item.receipt === undefined
        ? contract.expiresAt <= now ? 'expired' : 'pending' : 'invalid')
    }
    if (execution.status !== run.execution.status || execution.quiescent !== run.execution.quiescent
      || execution.completedAt !== run.execution.completedAt || execution.executionRef !== run.intent.runId) return unavailable(run, 'invalid')
    const actual = freeze({ ...run.execution, executionRef: run.intent.runId })
    if (item.receipt === null || item.receipt === undefined) {
      return freeze({ runId: run.intent.runId, definitionVersion: run.intent.task.goal.definitionVersion, status: contract.expiresAt <= now ? 'expired' : 'pending', execution: actual, criteria: freeze([]), criteriaTruncated: false })
    }
    const receipt = validateTaskVerificationReceipt(contract, item.receipt)
    if (receipt.startedAt < run.execution.completedAt || receipt.completedAt < receipt.startedAt || receipt.completedAt > now) return unavailable(run, 'invalid')
    const summarized = criteria(contract, receipt)
    const verification = freeze({ contractId: contract.id, receiptId: receipt.id, verifiedAt: receipt.completedAt, validUntil: receipt.validUntil })
    if (receipt.validUntil <= now) return freeze({ runId: run.intent.runId, definitionVersion: run.intent.task.goal.definitionVersion, status: 'expired', execution: actual, criteria: summarized.values, criteriaTruncated: summarized.truncated, verification })
    return freeze({ runId: run.intent.runId, definitionVersion: run.intent.task.goal.definitionVersion, status: receipt.objectiveStatus, execution: actual, criteria: summarized.values, criteriaTruncated: summarized.truncated, verification })
  } catch { return unavailable(run, 'invalid') }
}

/** Pure, bounded read-model. It never treats a checkpoint or one step as goal completion. */
export function buildGoalFeedback(
  record: GoalRecord,
  runs: readonly GoalExecutionRun[],
  lookup: ((id: string) => unknown) | undefined,
  now: number,
): GoalFeedback {
  const considered = (Array.isArray(runs) ? runs : []).filter(run => run?.intent?.task?.goal?.id === record.id
    && run.intent.scope.principalId === record.scope.principalId && run.intent.scope.principalRecordId === record.scope.principalRecordId
    && run.intent.scope.principalVersion === record.scope.principalVersion && run.intent.scope.workspace === record.scope.workspace
    && run.intent.scope.preset === record.scope.preset).slice(0, MAX_RUNS)
  const entries = considered.map(run => assessed(run, lookup, now))
  const current = entries.filter((_entry, index) => considered[index]!.intent.task.goal.id === record.id
    && considered[index]!.intent.task.goal.definitionVersion === record.definition.version
    && considered[index]!.intent.task.goal.definitionDigest === record.definition.digest)
  const latest = current[0] ?? null
  const settled = current.find(entry => entry.status !== 'pending') ?? null
  const pending = latest?.status === 'pending' ? latest : null
  const unreconciled = entries.find(entry => entry.status === 'unknown' && entry.execution?.quiescent === false) ?? null
  const historical = freeze(entries.slice(0, MAX_HISTORY))
  const hasOldDefinition = entries.some((_entry, index) => considered[index]!.intent.task.goal.definitionVersion !== record.definition.version
    || considered[index]!.intent.task.goal.definitionDigest !== record.definition.digest)
  const nextAction = unreconciled !== null ? 'reconcile-execution'
    : latest?.status === 'unknown' ? 'gather-evidence'
    : pending !== null ? 'await-verification'
      : hasOldDefinition && settled === null ? 'plan-current-definition'
        : settled?.status === 'not-achieved' ? 'revise-plan'
          : settled?.status === 'achieved' ? 'review-remaining-criteria'
            : settled?.status === 'unknown' ? 'gather-evidence'
              : settled?.status === 'invalid' || settled?.status === 'unavailable' || settled?.status === 'expired' ? 'inspect-verification'
          : 'plan-current-definition'
  return freeze({ protocol: 'assistant-goals/feedback/v1', goalId: record.id, goalOutcome: 'unverified',
    definition: freeze({ version: record.definition.version, digest: record.definition.digest, objective: excerpt(record.definition.objective) }),
    verification: freeze({ current: settled, pending, history: historical }), nextAction })
}
