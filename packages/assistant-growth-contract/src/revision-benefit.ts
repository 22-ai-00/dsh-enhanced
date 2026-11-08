import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'

/**
 * P1-4 benefit contract: a revision may replace its adopted parent only when
 * the candidate window proves non-inferior under the SAME supplier and budget.
 * Comparison inputs are canonical, Host-derived window statistics; deployment
 * association is never causal evidence, and every verdict keeps the failed
 * attempts visible.
 */

export interface RevisionBenefitModel {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface RevisionBenefitBudget {
  budgetId: string
  amount: number
}

/** Owner-frozen comparison contract; pins, never model input. */
export interface RevisionBenefitContract {
  protocol: 'assistant-growth/revision-benefit-contract/v1'
  model: RevisionBenefitModel
  budget: RevisionBenefitBudget
  /** Minimum distinct canonical task revisions per window before any verdict. */
  minimumTaskRevisions: number
  /** Maximum tolerated regression for each non-inferiority metric, in relative terms. */
  thresholds: {
    /** Candidate failure rate may exceed parent by at most this fraction. */
    maxFailureRateDelta: number
    /** Candidate rework (repeat corrections of the same revision) rate delta cap. */
    maxReworkRateDelta: number
    /** Candidate corrected/withdrawn task rate delta cap. */
    maxCorrectionRateDelta: number
    /** Candidate mean latency may exceed parent mean by at most this fraction. */
    maxLatencyRatio: number
    /** Candidate mean token cost may exceed parent mean by at most this fraction. */
    maxCostRatio: number
  }
  createdAt: number
  expiresAt: number
}

/**
 * One observation window over authenticated task outcomes for one artifact
 * version. Every count is over distinct canonical task revisions; corrected
 * and withdrawn revisions are EXCLUDED from the quality aggregates and
 * reported separately so exclusion can be audited.
 */
export interface RevisionBenefitWindowStats {
  protocol: 'assistant-growth/revision-benefit-window/v1'
  /** Digest binding this window to one artifact (parent or candidate). */
  artifactSha256: string
  windowStart: number
  windowEnd: number
  /** Distinct canonical task revisions observed, before exclusions. */
  taskRevisions: number
  /** Revisions excluded because the owner corrected or withdrew them. */
  correctedOrWithdrawn: number
  /** Revisions whose objective was not achieved, over the INCLUDED set. */
  failed: number
  /** Included revisions that required a repeat delivery for the same task. */
  reworked: number
  /** Sum of delivery latency ms over the INCLUDED set (mean derives from taskRevisions - correctedOrWithdrawn). */
  latencyMsTotal: number
  /** Sum of billed token cost over the INCLUDED set. */
  tokensTotal: number
  inputTokensTotal: number
  outputTokensTotal: number
}

export type RevisionBenefitVerdict =
  | { status: 'insufficient'; reason: 'below-minimum-samples' | 'contract-expired' | 'cost-or-latency-unmeasured' }
  | { status: 'inferior'; reason: string }
  | { status: 'non-inferior'; reason: 'all-metrics-within-thresholds' }

export interface RevisionBenefitEvaluation {
  verdict: RevisionBenefitVerdict
  parent: { included: number; failureRate: number; reworkRate: number; correctionRate: number; meanLatencyMs: number; meanTokens: number }
  candidate: { included: number; failureRate: number; reworkRate: number; correctionRate: number; meanLatencyMs: number; meanTokens: number }
}

const RATE_EPSILON = 1e-9

function finiteRate(numerator: number, denominator: number): number {
  return denominator <= 0 ? 0 : numerator / denominator
}

function isGrowthRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Structural validation for one window; numbers must be non-negative safe integers. */
export function validateRevisionBenefitWindowStats(value: unknown): asserts value is RevisionBenefitWindowStats {
  if (!isGrowthRecord(value) || utilTypes.isProxy(value)) throw new Error('benefit window must be a plain record')
  const required = ['protocol', 'artifactSha256', 'windowStart', 'windowEnd', 'taskRevisions',
    'correctedOrWithdrawn', 'failed', 'reworked', 'latencyMsTotal', 'tokensTotal', 'inputTokensTotal', 'outputTokensTotal']
  for (const key of required) if (!(key in value)) throw new Error(`benefit window missing ${key}`)
  if (value.protocol !== 'assistant-growth/revision-benefit-window/v1') throw new Error('benefit window protocol mismatch')
  if (typeof value.artifactSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.artifactSha256)) throw new Error('benefit window artifact digest invalid')
  const windowStart = value.windowStart, windowEnd = value.windowEnd, taskRevisions = value.taskRevisions
  const correctedOrWithdrawn = value.correctedOrWithdrawn, failed = value.failed, reworked = value.reworked
  for (const item of [windowStart, windowEnd, taskRevisions, correctedOrWithdrawn, failed, reworked,
    value.latencyMsTotal, value.tokensTotal, value.inputTokensTotal, value.outputTokensTotal]) {
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0) throw new Error('benefit window counter invalid')
  }
  if ((windowEnd as number) <= (windowStart as number)) throw new Error('benefit window must be nonempty')
  if ((failed as number) + (reworked as number) > Math.max(0, (taskRevisions as number) - (correctedOrWithdrawn as number))) {
    throw new Error('benefit window counters exceed the included set')
  }
}

export function validateRevisionBenefitContract(value: unknown): asserts value is RevisionBenefitContract {
  if (!isGrowthRecord(value) || utilTypes.isProxy(value)) throw new Error('benefit contract must be a plain record')
  if (value.protocol !== 'assistant-growth/revision-benefit-contract/v1') throw new Error('benefit contract protocol mismatch')
  const model = value.model as RevisionBenefitModel | undefined
  if (!isGrowthRecord(model) || typeof model.provider !== 'string' || !model.provider
    || typeof model.model !== 'string' || !model.model
    || model.reasoningEffort !== undefined && (typeof model.reasoningEffort !== 'string' || !model.reasoningEffort)) {
    throw new Error('benefit contract model invalid')
  }
  const budget = value.budget as RevisionBenefitBudget | undefined
  if (!isGrowthRecord(budget) || typeof budget.budgetId !== 'string' || !budget.budgetId
    || typeof budget.amount !== 'number' || !Number.isSafeInteger(budget.amount) || budget.amount < 1) {
    throw new Error('benefit contract budget invalid')
  }
  const thresholds = value.thresholds as RevisionBenefitContract['thresholds'] | undefined
  if (!isGrowthRecord(thresholds)) throw new Error('benefit contract thresholds missing')
  for (const key of ['maxFailureRateDelta', 'maxReworkRateDelta', 'maxCorrectionRateDelta'] as const) {
    const item = thresholds[key]
    if (typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item > 1) throw new Error(`benefit threshold ${key} invalid`)
  }
  for (const key of ['maxLatencyRatio', 'maxCostRatio'] as const) {
    const item = thresholds[key]
    if (typeof item !== 'number' || !Number.isFinite(item) || item < 1 || item > 100) throw new Error(`benefit threshold ${key} invalid`)
  }
  if (typeof value.minimumTaskRevisions !== 'number' || !Number.isSafeInteger(value.minimumTaskRevisions)
    || value.minimumTaskRevisions < 1 || value.minimumTaskRevisions > 1_000) throw new Error('benefit contract minimumTaskRevisions invalid')
  if (typeof value.createdAt !== 'number' || !Number.isSafeInteger(value.createdAt)
    || typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt <= value.createdAt) throw new Error('benefit contract lifetime invalid')
}

export function revisionBenefitContractDigest(value: RevisionBenefitContract): string {
  validateRevisionBenefitContract(value)
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function summarize(stats: RevisionBenefitWindowStats): RevisionBenefitEvaluation['parent'] {
  const included = Math.max(0, stats.taskRevisions - stats.correctedOrWithdrawn)
  return {
    included,
    failureRate: finiteRate(stats.failed, included),
    reworkRate: finiteRate(stats.reworked, included),
    correctionRate: finiteRate(stats.correctedOrWithdrawn, stats.taskRevisions),
    meanLatencyMs: finiteRate(stats.latencyMsTotal, included),
    meanTokens: finiteRate(stats.tokensTotal, included),
  }
}

/**
 * Deterministic non-inferiority evaluation. The candidate is compared against
 * the parent under the contract thresholds; every metric violation names
 * itself in the inferior reason, and sample-short windows stay insufficient.
 */
export function evaluateRevisionBenefit(
  contract: RevisionBenefitContract,
  parent: RevisionBenefitWindowStats,
  candidate: RevisionBenefitWindowStats,
  now: number,
): RevisionBenefitEvaluation {
  validateRevisionBenefitContract(contract)
  validateRevisionBenefitWindowStats(parent)
  validateRevisionBenefitWindowStats(candidate)
  const parentSummary = summarize(parent)
  const candidateSummary = summarize(candidate)
  const evaluation: RevisionBenefitEvaluation = {
    verdict: { status: 'insufficient', reason: 'below-minimum-samples' },
    parent: parentSummary,
    candidate: candidateSummary,
  }
  if (now >= contract.expiresAt) {
    return { ...evaluation, verdict: { status: 'insufficient', reason: 'contract-expired' } }
  }
  if (parentSummary.included < contract.minimumTaskRevisions
    || candidateSummary.included < contract.minimumTaskRevisions) {
    return evaluation
  }
  // Cost and latency must be measurable on both windows before any quality
  // claim: an unmeasured axis never passes non-inferiority by default.
  if (parentSummary.meanTokens <= 0 || candidateSummary.meanTokens <= 0
    || parentSummary.meanLatencyMs <= 0 || candidateSummary.meanLatencyMs <= 0) {
    return { ...evaluation, verdict: { status: 'insufficient', reason: 'cost-or-latency-unmeasured' } }
  }
  const thresholds = contract.thresholds
  if (candidateSummary.failureRate > parentSummary.failureRate + thresholds.maxFailureRateDelta + RATE_EPSILON) {
    return { ...evaluation, verdict: { status: 'inferior', reason: 'failure-rate' } }
  }
  if (candidateSummary.reworkRate > parentSummary.reworkRate + thresholds.maxReworkRateDelta + RATE_EPSILON) {
    return { ...evaluation, verdict: { status: 'inferior', reason: 'rework-rate' } }
  }
  if (candidateSummary.correctionRate > parentSummary.correctionRate + thresholds.maxCorrectionRateDelta + RATE_EPSILON) {
    return { ...evaluation, verdict: { status: 'inferior', reason: 'correction-rate' } }
  }
  if (candidateSummary.meanLatencyMs > parentSummary.meanLatencyMs * thresholds.maxLatencyRatio + RATE_EPSILON) {
    return { ...evaluation, verdict: { status: 'inferior', reason: 'latency' } }
  }
  if (candidateSummary.meanTokens > parentSummary.meanTokens * thresholds.maxCostRatio + RATE_EPSILON) {
    return { ...evaluation, verdict: { status: 'inferior', reason: 'cost' } }
  }
  return { ...evaluation, verdict: { status: 'non-inferior', reason: 'all-metrics-within-thresholds' } }
}
