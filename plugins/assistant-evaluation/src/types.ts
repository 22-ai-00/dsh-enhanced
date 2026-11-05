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
  ownerFeedbackState?: Readonly<OwnerObjectiveState>
  id: string
  /** Canonical JSON tuple of normalized absolute workspace and preset. */
  scopeKey: string
  recordedAt: number
}

export interface EvaluationTaskProjection {
  /** Stable scope-bound task identity. Automation outcomes share the exact run reference. */
  subjectKind: 'automation-run' | 'foreground-turn' | 'goal-step' | 'goal-outcome' | 'work-item' | 'outcome'
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
    subjectKind: 'automation-run' | 'foreground-turn' | 'goal-step' | 'goal-outcome' | 'work-item' | 'outcome'
    subjectRef: string
    version: number
    digest: string
    disposition: 'upsert' | 'retract'
    /** Exact trusted objective row selected by canonical precedence. */
    evidenceOutcomeId?: string
  }>
}

/** A restart-safe incremental view of current trusted canonical task heads. */
export interface TrustedTaskLearningProjectionFeedPage {
  items: readonly Readonly<{ watermark: number; receipt: TrustedTaskLearningProjectionReceipt }>[]
  nextCursor: Readonly<{ scopeKey: string; watermark: number }>
  scopeWatermark: number
  hasMore: boolean
}

/** Exact current task identity frozen into an Evolution evidence window. */
export interface EvaluationLearningEvidenceTuple {
  subjectKind: 'automation-run' | 'foreground-turn' | 'goal-step' | 'goal-outcome' | 'work-item' | 'outcome'
  subjectRef: string
  version: number
  digest: string
  disposition: 'upsert'
}

/**
 * Exact current canonical task identity. Unlike promotion evidence, a Host
 * reconciliation may need to fence a retraction so stale downstream state can
 * be invalidated under the same Evaluation writer lock.
 */
export interface EvaluationCanonicalLearningEvidenceTuple {
  subjectKind: 'automation-run' | 'foreground-turn' | 'goal-step' | 'goal-outcome' | 'work-item' | 'outcome'
  subjectRef: string
  version: number
  digest: string
  disposition: 'upsert' | 'retract'
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

/** A scope-level fence for exact canonical reconciliation, including retracts. */
export interface EvaluationCanonicalLearningWriterFence {
  scopeWatermark: number
  evidence: readonly Readonly<EvaluationCanonicalLearningEvidenceTuple>[]
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
  ownsTrustedVerifierEvaluationRegistration(
    registration: Readonly<TrustedVerifierEvaluationRegistration>,
  ): boolean
  ownsTrustedWorkItemEvaluationRegistration(
    registration: Readonly<TrustedWorkItemEvaluationRegistration>,
  ): boolean
}

/**
 * Settled work-item claims one trusted Evaluation revision.
 *
 * The producer may state only facts it durably observed: the item, the outcome
 * revision, how it settled, the evidence state and the deterministic identity.
 * Objective and delivery status are literal `'unknown'` and there is no
 * execution-status field at all, so this capability is type-level incapable of
 * claiming that a work item achieved an objective.
 */
export interface TrustedWorkItemEvaluationClaims {
  scope: Readonly<EvaluationScope>
  itemId: string
  outcomeRevision: number
  settledBy: WorkItemSettledBy
  evidenceState: Extract<WorkItemEvaluationEvidenceState, 'observed' | 'unverified' | 'not-applicable'>
  situation: string
  occurredAt: number
  idempotencyKey: string
  /** Digest of the immutable outcome revision this claim exports. */
  digest: string
  metrics: EvaluationMetrics
  objectiveStatus: 'unknown'
  deliveryStatus: 'unknown'
}

/** Work-item outcome vocabulary mirrored structurally; no runtime package dependency. */
export type WorkItemSettledBy =
  | 'report-ready'
  | 'report-blocked'
  | 'report-failed'
  | 'withdrawn'
  | 'retry-exhausted'
  | 'observed-evidence'
  | 'window-expired'
  /**
   * Every followed external thread closed, so the bounded settlement wait ended
   * before its deadline without in-window delivery evidence. The value is
   * exported verbatim: it is still an unverified settlement and still cannot
   * assert an objective.
   */
  | 'closed-by-thread'

/** Work-item evidence vocabulary mirrored structurally. */
export type WorkItemEvaluationEvidenceState = 'pending' | 'observed' | 'unverified' | 'not-applicable'

/** Private work-items-to-ledger capability; append is idempotent on the claims identity. */
export interface TrustedWorkItemEvaluationRegistration {
  protocol: 'assistant-work-items/evaluation/v1'
  generation: string
  owner: TrustedEvaluationRegistrationOwner
  append(claims: Readonly<TrustedWorkItemEvaluationClaims>): Promise<void>
}

/** Private verifier-to-ledger capability.  It carries the immutable acceptance
 * pair and the Host re-read execution, never a caller supplied verdict. */
export interface TrustedVerifierEvaluationRegistration {
  protocol: 'assistant-verifier/evaluation/v1'
  generation: string
  owner: TrustedEvaluationRegistrationOwner
  append(input: Readonly<{ contract: unknown; receipt: unknown; execution: unknown }>): Promise<void>
}

export interface TrustedAutomationEvaluationRegistration {
  protocol: typeof TRUSTED_EVALUATION_PRODUCER_PROTOCOL
  producer: 'assistant-automations'
  generation: string
  owner: TrustedEvaluationRegistrationOwner
  issueCapability(claims: TrustedAutomationEvaluationClaims): unknown
  append(input: TrustedAutomationEvaluationAppendInput): StoredOutcome
}

/** Host-attested owner command. The previous version and label are a CAS precondition. */
export interface OwnerObjectiveCommand {
  operationId: string
  principalRecordId: string
  principalVersion: number
  action: 'initial' | 'correct' | 'withdraw'
  expectedVersion?: number
  previousStatus?: ObjectiveStatus
}

export interface OwnerObjectiveState {
  version: number
  objectiveStatus: ObjectiveStatus
}

/**
 * Structural view of the process-local Goals proof used to authorize owner
 * feedback for one terminal whole-goal assessment. Evaluation deliberately
 * does not import the optional Goals package at runtime.
 */
export interface TrustedGoalOutcomeOwnerProof {
  protocol: 'assistant-goals/owner-goal-outcome-feedback/v1'
  locator: Readonly<{
    protocol: 'assistant-goals/owner-goal-outcome-locator/v1'
    ownerRouteId: string
    principalId: string
    principalRecordId: string
    principalVersion: number
    workspace: string
    preset: string
    bindingId: string
    bindingVersion: number
    bindingGeneration: number
    sessionId: string
    goalId: string
    assessmentId: string
  }>
  goal: Readonly<{
    definitionVersion: number
    definitionDigest: string
    nativeGoalId: string
    phase: 'complete' | 'blocked'
  }>
  runId: string
  profile: Readonly<{ id: string; version: number; digest: string }>
  contract: Readonly<{ id: string; digest: string }>
  receipt: Readonly<{
    id: string
    digest: string
    objectiveStatus: Extract<ObjectiveStatus, 'achieved' | 'not-achieved'>
    completedAt: number
    validUntil: number
  }>
  proofDigest: string
}

/** Current WorkItems-generation proof for an exact durable terminal report. */
export interface TrustedWorkItemOwnerFeedbackProof {
  protocol: 'assistant-work-items/owner-report-feedback/v1'
  itemId: string
  reportRevision: number
  reportDigest: string
  sourceId: string
  itemKind: string
  scope: Readonly<EvaluationScope>
  owner: Readonly<{ ownerRouteId: string; principalId: string; principalRecordId: string; principalVersion: number }>
  originBindingId: string
  production: Readonly<{
    automationId: string; occurrenceId: string; runId: string; definitionHash: string; definitionVersion: number
    executionStatus: Exclude<ExecutionStatus, 'unknown'>; completedAt: number; quiescent: true; budgetSettlementState: 'finalized'
  }>
  supplier: Readonly<{ provider: string; model: string; reasoningEffort?: string }>
  planDigest: string
  task: Readonly<{ brief: string; briefTruncated: boolean }>
  report: Readonly<{ status: 'ready' | 'blocked' | 'failed'; text: string; truncated: boolean; recordedAt: number }>
  proofDigest: string
}

interface TrustedDeliveryEvaluationClaimsBase {
  scope: Readonly<EvaluationScope>
  situation: string
  /** Legacy Automation subject reference retained for rolling producer compatibility. */
  runId: string
  outboxId: string
  chatId: string
  principalId: string
  bindingId: string
  objectiveStatus: ObjectiveStatus
  ownerCommand?: Readonly<OwnerObjectiveCommand>
  initialIdempotencyKey?: string
  occurredAt: number
  idempotencyKey: string
}

export type TrustedDeliveryEvaluationClaims = TrustedDeliveryEvaluationClaimsBase & (
  | Readonly<{
    /** Defaults to the legacy Automation subject when omitted by an older Delivery producer. */
    subjectKind?: 'automation-run' | 'foreground-turn'
    /** Defaults to `runId` for legacy Automation feedback. */
    subjectRef?: string
    goalOutcomeCapability?: never
    workItemOutcomeCapability?: never
  }>
  | Readonly<{
    subjectKind: 'goal-outcome'
    subjectRef: string
    /** Opaque process-local capability minted by the current Goals generation. */
    goalOutcomeCapability: unknown
    workItemOutcomeCapability?: never
  }>
  | Readonly<{
    subjectKind: 'work-item'
    subjectRef: string
    /** Opaque process-local capability minted by the current WorkItems generation. */
    workItemOutcomeCapability: unknown
    goalOutcomeCapability?: never
  }>
)

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
  ownerRevisionProtocol?: 'owner-objective-revision/v1' | 'owner-objective-revision/v2'
  protocol: typeof TRUSTED_EVALUATION_PRODUCER_PROTOCOL
  producer: 'assistant-delivery'
  generation: string
  owner: TrustedEvaluationRegistrationOwner
  issueCapability(claims: TrustedDeliveryEvaluationClaims): unknown
  inspect?(capabilityReceipt: unknown): OwnerObjectiveState | undefined
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
  /** WP22 notification heads and their append-only revisions. */
  notificationOutcomes: number
  notificationOutcomeRevisions: number
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
  /** not-required means this subject is unsupported by the optional Evolution sink. */
  status: 'pending' | 'recorded' | 'not-required'
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

/**
 * WP22 per-notification outcome vocabulary. `accepted`/`rejected` require a
 * current Host-recorded owner judgement; `reacted` is an owner reply (or a
 * partial judgement); `expired-unhandled` is a sent notification without any
 * reaction once the configured response window elapsed.
 */
export const notificationOutcomes = [
  'pending', 'delivered', 'reacted', 'accepted', 'rejected', 'expired-unhandled', 'failed',
] as const
export type NotificationOutcome = typeof notificationOutcomes[number]

export const NOTIFICATION_OUTCOME_RECORD_PROTOCOL = 'assistant-evaluation/notification-outcome/v1' as const
export const NOTIFICATION_OUTCOME_FACTS_PROTOCOL = 'assistant-delivery/notification-outcome-facts/v1' as const

/** Structural mirror of Delivery's text-free notification facts; no runtime package dependency. */
export interface NotificationOutcomeFactInput {
  auditSequence: number
  outboxId: string
  bindingId: string
  scope: Readonly<EvaluationScope>
  lane: string
  sourceId: string
  purpose: 'result' | 'attention' | 'answer'
  purposeSource: 'declared' | 'lane' | 'default'
  workItemId?: string
  questionId?: string
  answersQuestionId?: string
  verdict: 'would-accept' | 'would-attach' | 'would-reject'
  reasons: readonly string[]
  auditedAt: number
  transport: Readonly<{ status: string; acceptedAt?: number; deliveredAt?: number; readAt?: number }>
  reaction?: Readonly<{ firstAt: number; count?: number }>
  judgement?: Readonly<{
    source: 'owner-objective' | 'work-item-feedback'
    version: number
    objectiveStatus: ObjectiveStatus
  }>
}

/** Canonical content of one notification-outcome revision; its SHA-256 is the revision digest. */
export interface NotificationOutcomeRecord {
  protocol: typeof NOTIFICATION_OUTCOME_RECORD_PROTOCOL
  classifier: Readonly<{ id: 'notification-outcome'; version: 1 }>
  notificationId: string
  scope: Readonly<EvaluationScope>
  bindingId: string
  lane: string
  sourceId: string
  purpose: NotificationOutcomeFactInput['purpose']
  purposeSource: NotificationOutcomeFactInput['purposeSource']
  workItemId?: string
  questionId?: string
  answersQuestionId?: string
  verdict: NotificationOutcomeFactInput['verdict']
  reasons: readonly string[]
  notifiedAt: number
  outcome: NotificationOutcome
  transport: Readonly<{ status: string; acceptedAt?: number; deliveredAt?: number; readAt?: number }>
  reaction?: Readonly<{ firstAt: number }>
  judgement?: Readonly<{ source: 'owner-objective' | 'work-item-feedback'; version: number; objectiveStatus: Exclude<ObjectiveStatus, 'unknown'> }>
  /**
   * Set only for `expired-unhandled`: the deterministic expiry boundary and the
   * response window that produced it. The window is deliberately absent from
   * every other record, so a window change only revises notifications whose
   * expiry classification actually changes.
   */
  expiry?: Readonly<{ at: number; responseWindowMs: number }>
}

export interface StoredNotificationOutcome {
  notificationId: string
  scopeKey: string
  version: number
  digest: string
  /** Per-scope notification watermark of this revision (not the task-learning watermark). */
  watermark: number
  recordedAt: number
  record: Readonly<NotificationOutcomeRecord>
}

export interface NotificationOutcomeHistory {
  head: Readonly<StoredNotificationOutcome>
  revisions: readonly Readonly<StoredNotificationOutcome>[]
}

/** Restart-safe page of current notification heads after a per-scope watermark. */
export interface NotificationOutcomeFeedPage {
  items: readonly Readonly<StoredNotificationOutcome>[]
  nextCursor: Readonly<{ scopeKey: string; watermark: number }>
  scopeWatermark: number
  hasMore: boolean
}

export interface NotificationOutcomeSummary {
  scope: Readonly<EvaluationScope>
  scopeKey: string
  fromNotifiedAt: number
  toNotifiedAt: number
  total: number
  outcomes: Readonly<Record<NotificationOutcome, number>>
  /** Attention verdict x current outcome, for WP19 would-accept concordance. */
  byVerdict: Readonly<Record<NotificationOutcomeFactInput['verdict'], Readonly<Record<NotificationOutcome, number>>>>
}

export interface NotificationOutcomeSyncResult {
  ingested: number
  refreshed: number
  revised: number
  invalid: number
}
