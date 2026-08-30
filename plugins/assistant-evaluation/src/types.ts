export const executionStatuses = ['succeeded', 'failed', 'timed-out', 'cancelled', 'unknown'] as const
export type ExecutionStatus = typeof executionStatuses[number]

export const objectiveStatuses = ['achieved', 'partial', 'not-achieved', 'unknown'] as const
export type ObjectiveStatus = typeof objectiveStatuses[number]

export const deliveryStatuses = ['delivered', 'failed', 'not-required', 'unknown'] as const
export type DeliveryStatus = typeof deliveryStatuses[number]

export const outcomeSourceKinds = [
  'automation', 'foreground', 'delivery', 'user-feedback', 'system', 'evaluator', 'import',
] as const
export type OutcomeSourceKind = typeof outcomeSourceKinds[number]

export const outcomeTrustLevels = ['trusted', 'self-reported', 'external'] as const
export type OutcomeTrust = typeof outcomeTrustLevels[number]

export type EvaluationJson = null | boolean | number | string | readonly EvaluationJson[] | {
  readonly [key: string]: EvaluationJson
}

/**
 * Resource measurements are data, never instructions. The standard keys use
 * integer units so independent producers can aggregate them without rounding.
 * Additional JSON keys are allowed, but the store applies byte/depth/node limits.
 */
export type EvaluationMetrics = Readonly<{
  costUsdMicros?: number
  latencyMs?: number
  inputTokens?: number
  outputTokens?: number
  toolCalls?: number
  retries?: number
  [key: string]: EvaluationJson | undefined
}>

export interface EvaluationScope {
  /** Absolute workspace path. Exact workspace + preset is the isolation key. */
  workspace: string
  preset: string
}

export interface OutcomeSource {
  kind: OutcomeSourceKind
  /** Stable Host-owned producer identifier, not model prose. */
  id: string
}

export interface OutcomeEvaluator {
  /** Evaluator implementation or assertion suite. */
  id: string
  /** Version of the logic that assigned the three statuses. */
  version: string
}

export interface EvaluationEvidenceRef {
  /** Bounded evidence class such as `run`, `receipt`, `assertion` or `feedback`. */
  kind: string
  /** Opaque durable reference. Raw evidence is not copied into this ledger. */
  ref: string
  /** Optional content digest supplied by the trusted producer. */
  digest?: string
}

/** One append-only assessment. Execution success never implies objective success or delivery. */
export interface OutcomeEnvelope {
  scope: EvaluationScope
  situation: string
  executionStatus: ExecutionStatus
  objectiveStatus: ObjectiveStatus
  deliveryStatus: DeliveryStatus
  source: OutcomeSource
  trust: OutcomeTrust
  evidence: readonly EvaluationEvidenceRef[]
  metrics: EvaluationMetrics
  occurredAt: number
  idempotencyKey: string
  evaluator: OutcomeEvaluator
}

export interface StoredOutcome extends OutcomeEnvelope {
  id: string
  /** Canonical JSON tuple of normalized absolute workspace and preset. */
  scopeKey: string
  recordedAt: number
}

/**
 * A model/evaluator judgement linked to an existing Host outcome. It is kept in
 * a separate table so a later self-assessment cannot double-count task volume or
 * silently upgrade its own trust.
 */
export interface SelfAssessmentInput {
  outcomeId: string
  scope: EvaluationScope
  objectiveStatus: ObjectiveStatus
  evidence: readonly EvaluationEvidenceRef[]
  occurredAt: number
  idempotencyKey: string
  evaluator: OutcomeEvaluator
}

export interface StoredSelfAssessment extends SelfAssessmentInput {
  id: string
  scopeKey: string
  situation: string
  /** Immutable terminal statuses inherited from the referenced Host outcome. */
  executionStatus: ExecutionStatus
  deliveryStatus: DeliveryStatus
  trust: 'self-reported'
  recordedAt: number
}

export interface OutcomeQuery {
  /** Mandatory exact scope: cross-workspace scans are not part of the API. */
  scope: EvaluationScope
  situation?: string
  executionStatus?: ExecutionStatus
  objectiveStatus?: ObjectiveStatus
  deliveryStatus?: DeliveryStatus
  sourceKind?: OutcomeSourceKind
  trust?: OutcomeTrust
  /** Host-owned maintenance filter; exact prefix semantics, not a glob. */
  excludeSituationPrefix?: string
  fromOccurredAt?: number
  toOccurredAt?: number
  /** Required to be a positive integer no greater than the configured hard cap. */
  limit?: number
}

export interface OutcomeSummaryQuery {
  scope: EvaluationScope
  situation?: string
  /** Host-owned maintenance filter; exact prefix semantics, not a glob. */
  excludeSituationPrefix?: string
  fromOccurredAt?: number
  toOccurredAt?: number
}

export interface OutcomeSummary {
  scope: EvaluationScope
  scopeKey: string
  situation?: string
  fromOccurredAt: number
  toOccurredAt: number
  total: number
  execution: Readonly<{ succeeded: number; failed: number; timedOut: number; cancelled: number; unknown: number }>
  objective: Readonly<{ achieved: number; partial: number; notAchieved: number; unknown: number }>
  delivery: Readonly<{ delivered: number; failed: number; notRequired: number; unknown: number }>
  trust: Readonly<{ trusted: number; selfReported: number; external: number }>
  metrics: Readonly<{
    costUsdMicros: number
    inputTokens: number
    outputTokens: number
    toolCalls: number
    averageLatencyMs?: number
  }>
}

export interface EvaluationHealth {
  ready: true
  schemaVersion: number
  outcomes: number
  trustedOutcomes: number
  selfReportedOutcomes: number
  externalOutcomes: number
  selfAssessments: number
  latestOccurredAt?: number
}

/** Runtime limits exposed to Host producers before they build a durable append intent. */
export interface EvaluationLimits {
  maxQueryLimit: number
  maxReviewOutcomes: number
  maxSituationBytes: number
  maxMetricsBytes: number
  maxEvidenceRefs: number
  defaultSummaryWindowMs: number
  maxSummaryWindowMs: number
}

export interface EvaluationReviewRequest {
  situation?: string
  lookbackDays?: number
  limit?: number
}

export interface EvaluationSelfAssessRequest {
  outcomeId: string
  objectiveStatus: ObjectiveStatus
  /** IDs returned by memory_search_confirmed. They remain claimed references, not trusted evidence. */
  memoryIds?: readonly string[]
}

export interface EvaluationReview {
  summary: OutcomeSummary
  outcomes: readonly StoredOutcome[]
  /** Latest self-report per reviewed outcome; it never changes the parent summary. */
  selfAssessments: readonly StoredSelfAssessment[]
}
