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

export interface EvaluationTaskProjection {
  /** Stable scope-bound task identity. Automation outcomes share the exact run reference. */
  subjectKind: 'automation-run' | 'outcome'
  subjectRef: string
  /** Conflicting trusted owner judgements are quarantined instead of resolved by arrival order. */
  status: 'ready' | 'objective-conflict'
  primaryOutcomeId: string
  executionOutcomeId?: string
  objectiveOutcomeId?: string
  deliveryOutcomeId?: string
  /** Monotonic semantic revision consumed by downstream learning ledgers. */
  learningVersion: number
  /** SHA-256 of the complete canonical learning projection at this revision. */
  learningDigest: string
  /** `retract` removes any older eligible vote for this task. */
  learningDisposition: 'upsert' | 'retract'
}

/** One task-level projection assembled from immutable append-only outcome records. */
export interface ProjectedOutcome extends StoredOutcome {
  projection: Readonly<EvaluationTaskProjection>
}

/**
 * Minimal immutable proof returned to another trusted Host service. Metrics,
 * producer idempotency keys and record timestamps stay private to the ledger.
 */
export interface TrustedOutcomeReceipt {
  id: string
  scope: Readonly<EvaluationScope>
  /** Canonical JSON tuple of normalized absolute workspace and preset. */
  scopeKey: string
  situation: string
  executionStatus: ExecutionStatus
  objectiveStatus: ObjectiveStatus
  deliveryStatus: DeliveryStatus
  source: Readonly<OutcomeSource>
  trust: 'trusted'
  evidence: readonly Readonly<EvaluationEvidenceRef>[]
  occurredAt: number
  evaluator: Readonly<OutcomeEvaluator>
}

export interface TrustedTaskExecutionComponent {
  outcomeId: string
  status: ExecutionStatus
  source: Readonly<OutcomeSource>
  evidence: readonly Readonly<EvaluationEvidenceRef>[]
  occurredAt: number
  evaluator: Readonly<OutcomeEvaluator>
}

export interface TrustedTaskObjectiveComponent {
  outcomeId: string
  status: ObjectiveStatus
  source: Readonly<OutcomeSource>
  evidence: readonly Readonly<EvaluationEvidenceRef>[]
  occurredAt: number
  evaluator: Readonly<OutcomeEvaluator>
}

/**
 * Canonical, versioned task state exported to Evolution. `triggerOutcomeId` is
 * merely the append-only outbox row that caused reconciliation; every retry
 * resolves the current task projection represented by `projection`.
 *
 * Execution and objective provenance are deliberately separate.  For an
 * Automation task, execution comes from its immutable production receipt while
 * the objective may come from a later authenticated owner judgement.  A flat
 * source/evidence tuple cannot truthfully represent both authorities.
 */
export interface TrustedTaskLearningProjectionReceipt {
  triggerOutcomeId: string
  scope: Readonly<EvaluationScope>
  scopeKey: string
  /**
   * Monotonic canonical-learning revision for the complete scope.  It advances
   * in the same Evaluation writer transaction that changes a task projection
   * and queues its durable projection outbox row.
   */
  scopeWatermark: number
  situation: string
  execution?: Readonly<TrustedTaskExecutionComponent>
  objective?: Readonly<TrustedTaskObjectiveComponent>
  projection: Readonly<{
    subjectKind: 'automation-run' | 'outcome'
    subjectRef: string
    version: number
    digest: string
    disposition: 'upsert' | 'retract'
    /** Exact trusted objective row selected by canonical precedence. */
    evidenceOutcomeId?: string
  }>
}

/** Exact current task identity frozen into an Evolution evidence window. */
export interface EvaluationLearningEvidenceTuple {
  subjectKind: 'automation-run' | 'outcome'
  subjectRef: string
  version: number
  digest: string
  disposition: 'upsert'
}

/**
 * A complete scope-level fence snapshot.  The callback-capability accepting
 * this type is synchronous: it holds Evaluation's writer lock for its entire
 * execution, and callers must acquire any downstream lock only afterwards.
 */
export interface EvaluationLearningWriterFence {
  scopeWatermark: number
  evidence: readonly Readonly<EvaluationLearningEvidenceTuple>[]
}

export type EvaluationLearningWriterFenceFailure =
  | 'evidence-changed'
  | 'projection-pending'
  | 'watermark-changed'

export type EvaluationLearningWriterFenceResult<T> = Readonly<{
  matched: true
  value: T
}> | Readonly<{
  matched: false
  reason: EvaluationLearningWriterFenceFailure
}>

export const TRUSTED_EVALUATION_PRODUCER_PROTOCOL =
  'assistant-evaluation/trusted-producer/v1' as const

export interface TrustedAutomationEvaluationClaims {
  scope: Readonly<EvaluationScope>
  automationId: string
  situation: string
  runId: string
  executionMode: 'production'
  executionStatus: ExecutionStatus
  objectiveStatus: Extract<ObjectiveStatus, 'achieved' | 'not-achieved' | 'unknown'>
  deliveryStatus: Extract<DeliveryStatus, 'not-required' | 'unknown'>
  metrics: EvaluationMetrics
  occurredAt: number
  idempotencyKey: string
  evaluatorVersion: `terminal-v${number}` | `host-runbook-v${number}`
}

export interface TrustedAutomationEvaluationAppendInput {
  capabilityReceipt: unknown
  automationId: string
  runId: string
  idempotencyKey: string
}

/** Process-local owner carried by a registration across Cordis sibling scopes. */
export interface TrustedEvaluationRegistrationOwner {
  ownsTrustedAutomationEvaluationRegistration(
    registration: Readonly<TrustedAutomationEvaluationRegistration>,
  ): boolean
  ownsTrustedDeliveryEvaluationRegistration(
    registration: Readonly<TrustedDeliveryEvaluationRegistration>,
  ): boolean
}

export interface TrustedAutomationEvaluationRegistration {
  protocol: typeof TRUSTED_EVALUATION_PRODUCER_PROTOCOL
  producer: 'assistant-automations'
  generation: string
  owner: TrustedEvaluationRegistrationOwner
  issueCapability(claims: TrustedAutomationEvaluationClaims): unknown
  append(input: TrustedAutomationEvaluationAppendInput): StoredOutcome
}

export interface TrustedDeliveryEvaluationClaims {
  scope: Readonly<EvaluationScope>
  situation: string
  runId: string
  outboxId: string
  chatId: string
  principalId: string
  bindingId: string
  objectiveStatus: Extract<ObjectiveStatus, 'achieved' | 'partial' | 'not-achieved'>
  occurredAt: number
  idempotencyKey: string
}

export interface TrustedDeliveryEvaluationAppendInput {
  capabilityReceipt: unknown
  runId: string
  outboxId: string
  chatId: string
  principalId: string
  bindingId: string
  idempotencyKey: string
}

export interface TrustedDeliveryEvaluationRegistration {
  protocol: typeof TRUSTED_EVALUATION_PRODUCER_PROTOCOL
  producer: 'assistant-delivery'
  generation: string
  owner: TrustedEvaluationRegistrationOwner
  issueCapability(claims: TrustedDeliveryEvaluationClaims): unknown
  append(input: TrustedDeliveryEvaluationAppendInput): StoredOutcome
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
  taskProjections: number
  conflictedTaskProjections: number
  /** Append-only triggers still waiting to project their current canonical task state. */
  pendingProjections: number
  retryingProjections: number
  projectionAttempts: number
  oldestPendingProjectionAt?: number
  latestOccurredAt?: number
}

/** Durable Evaluation-owned work item for the optional Evolution sink. */
export interface EvaluationProjectionOutboxEntry {
  evaluationId: string
  scope: Readonly<EvaluationScope>
  status: 'pending'
  attemptCount: number
  nextAttemptAt: number
  lastFailureCode?: string
  createdAt: number
  updatedAt: number
}

export interface EvaluationProjectionState {
  evaluationId: string
  scope: Readonly<EvaluationScope>
  status: 'pending' | 'recorded'
  attemptCount: number
  nextAttemptAt: number
  lastFailureCode?: string
  createdAt: number
  updatedAt: number
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
  outcomes: readonly ProjectedOutcome[]
  /** Latest self-report per reviewed outcome; it never changes the parent summary. */
  selfAssessments: readonly StoredSelfAssessment[]
}
