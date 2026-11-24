export interface OpportunityScope {
  principalId: string; principalRecordId: string; principalVersion: number; workspace: string; preset: string
}
/** Operator estimates in utility units; neither probabilities nor money are independently verified. */
export interface PreparationSettings {
  provider: string; model: string; budgetId: string; maxOutputTokens: number; timeoutMs: number
}
export interface OpportunityProfile {
  /** Explicit opt-in to paid, tool-free generation; omitted prepare keeps metadata-only behavior. */
  preparation?: PreparationSettings
  id: string
  mode: 'prepare' | 'remind' | 'execute'
  expectedBenefit: number; successPpm: number; executionCost: number; interruptionCost: number; possibleLoss: number; minimumUtility: number
  mergeWindowMs: number; cooldownMs: number; rejectionCooldownMs: number
  quietHours?: { timezone: string; startMinute: number; endMinute: number }
  maxDecisionsPerGoal: number; maxExecutionsPerGoal: number; maxRemindersPerGoal: number
}
/** Supplied by the live Goals service from an already owner-authorized wait; never by an event body. */
export interface OpportunityInput {
  waitId: string; profileId: string; scope: OpportunityScope; goalId: string; sessionId: string
  definitionDigest: string; objective: string; nativeGoalId: string; nativeRevision: number; ownerRouteId: string
  sourceDigest: string; sourceId: string
  /**
   * `digest` is the canonical envelope digest (unique per event). `observationDigest` is the source's
   * content digest (`observation.digest`); optional for older Goals, which then never dedupe a reminder.
   */
  event: { id: string; sequence: number; digest: string; occurredAt: number; observationDigest?: string }
  expiresAt: number
}
export type OpportunityReason = 'cancelled' | 'coalescing' | 'quiet-hours' | 'cooldown' | 'rejected-cooldown' | 'below-threshold' | 'budget' | 'expired' | 'prepared' | 'reminder' | 'unchanged' | 'execution' | 'attention-muted'
export interface OpportunityDecision {
  id: string; waitId: string; profileId: string; scope: OpportunityScope; goalId: string; sessionId: string; ownerRouteId: string
  sourceId: string; eventId: string; eventSequence: number; eventDigest: string; sourceDigest: string
  /** Content digest of the triggering observation, when the caller supplied one. */
  eventObservationDigest?: string | undefined
  objective: string; definitionDigest: string; nativeGoalId: string; nativeRevision: number
  mode: 'prepare' | 'remind' | 'execute' | 'suppress'
  state: 'pending' | 'decided' | 'closed'; reason: OpportunityReason; utility: number
  firstObservedAt: number; updatedAt: number; eligibleAt: number; expiresAt: number; observations: number
  feedback?: 'accepted' | 'rejected'
  /** Evaluation attention version (WP22) applied to this decision; absent when untuned. */
  attentionTuning?: { version: number; digest: string }
}
export interface OpportunityEvaluation {
  /** consume advances this wait's source cursor; execute still goes through the original GoalWake authority. */
  disposition: 'defer' | 'consume' | 'execute'
  decision: Readonly<OpportunityDecision>
}

/** Optional runtime telemetry supplied to OpportunityEngine.evaluate for WP12 dynamic utility. */
export interface ProactiveRuntimeContext {
  /** True when the owner is currently in an active turn or an agent is running. */
  readonly userActive?: boolean
  /** Elapsed ms since last known owner interaction (>= 0). */
  readonly idleDurationMs?: number
  /** Recent owner-facing notification count in the rolling window (>= 0). */
  readonly recentNotificationCount?: number
  /** Explicit urgency signal in [0, 1_000_000] ppm; when omitted, derived from remaining TTL. */
  readonly urgencyPpm?: number
  /** Historical acceptance rate in [0, 1_000_000] ppm. */
  readonly acceptanceRatePpm?: number
  /** Sample count accompanying acceptanceRatePpm (>= 0). */
  readonly acceptanceSamples?: number
}

/** Internal/test signal bundle passed into computeDynamicUtility. */
export interface ProactiveDynamicSignals extends ProactiveRuntimeContext {
  /** Remaining TTL in ms (`expiresAt - now`); values in [0, URGENCY_WINDOW_MS) add urgency bonus. */
  readonly remainingTtlMs?: number
  /** Durable accepted feedback count in local history (>= 0). */
  readonly acceptedCount?: number
  /** Durable rejected feedback count in local history (>= 0). */
  readonly rejectedCount?: number
  /** Tighten-only overlay delta already folded into `profile.interruptionCost`; never undercut by idle discount. */
  readonly overlayInterruptionCostDelta?: number
}

/** Deterministic integer breakdown of WP12 dynamic utility & interruption cost. */
export interface ProactiveDynamicUtilityBreakdown {
  readonly baseUtility: number
  readonly baseInterruptionCost: number
  readonly effectiveInterruptionCost: number
  readonly activityAdjustment: number
  readonly frequencyPenalty: number
  readonly urgencyBonus: number
  readonly acceptanceAdjustment: number
  readonly effectiveUtility: number
}

export type ProactiveDraftState = 'queued' | 'running' | 'draft' | 'failed' | 'cancelled' | 'unknown'

export interface ProactiveDraftFilter {
  scope?: OpportunityScope
  workspace?: string
  preset?: string
  goalId?: string
  state?: ProactiveDraftState
  onlyDrafts?: boolean
  limit?: number
}

export interface ProactiveDraftInspection {
  id: string
  goalId: string
  profileId: string
  scope: OpportunityScope
  objective: string
  state: ProactiveDraftState
  reason?: string
  feedback?: 'accepted' | 'rejected'
  decisionState: OpportunityDecision['state']
  createdAt: number
  updatedAt: number
  deadlineAt: number
  output?: string
  sessionId?: string
  usage?: Readonly<Record<string, unknown>>
  diagnostic?: Readonly<{ failureClass: string; failurePhase: string; failureCode: string }>
  verified: false
}

export interface ProactiveOpportunityFilter {
  scope?: OpportunityScope
  workspace?: string
  preset?: string
  principalId?: string
  goalId?: string
  state?: OpportunityDecision['state']
  mode?: OpportunityDecision['mode']
  limit?: number
}

export interface ProactiveOpportunityInspection extends OpportunityDecision {
  preparation?: {
    state: ProactiveDraftState
    reason?: string | undefined
    updatedAt: number
    output?: string | undefined
    sessionId?: string | undefined
    usage?: Readonly<Record<string, unknown>> | undefined
    diagnostic?: Readonly<{ failureClass: string; failurePhase: string; failureCode: string }> | undefined
    verified?: false | undefined
  }
}

export interface ProactiveAttentionQuestionFilter {
  scope?: { workspace: string; preset: string }
  workspace?: string
  preset?: string
  includeResolved?: boolean
  limit?: number
}

export interface ProactiveAttentionQuestionInspection {
  questionId: string
  scope: { workspace: string; preset: string }
  proposalId: string
  parameter: string
  parentValue: number | boolean
  candidateValue: number | boolean
  delta: number | boolean
  exceeded: readonly string[]
  choices: readonly ['authorize-once', 'decline']
  delivery: { status: 'queued' | 'closed' | 'expired'; outboxId: string | null; recordedAt: number } | null
  reply: { choice: 'authorize-once' | 'decline'; repliedAt: number } | null
  decision: { decision: string; reason: string; decidedAt: number } | null
  open: boolean
  createdAt: number
}

export type ProactiveAttentionQuestionResolveResult =
  | {
    status: 'applied'
    questionId: string
    choice: 'authorize-once' | 'decline'
    proposalId: string
    grantId: string | null
    adoption: 'deferred' | 'declined' | 'proposal-terminal'
  }
  | { status: 'rejected'; reason: string }
