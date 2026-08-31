/** Binary terminal projection. Its quality meaning is determined separately by
 * evidenceKind; execution success alone is never treated as task success. */
export type EpisodeOutcome = 'succeeded' | 'failed'

/** Where an episode came from. Source is provenance, never learning authority. */
export type EpisodeSource = 'automation' | 'evaluation' | 'foreground'

/** Whether the recorder is authoritative for the fact it reports. */
export type EpisodeTrust = 'trusted' | 'self-reported' | 'legacy'

/**
 * Why an episode exists in the ledger.
 *
 * Execution status is operational telemetry, not evidence that an answer was
 * correct or useful. Only an authoritative objective assertion or independent
 * verification may influence behavioural learning. Rows written before this
 * distinction existed are permanently quarantined as `legacy-unknown`.
 */
export type EpisodeEvidenceKind = 'operational' | 'objective' | 'verification' | 'legacy-unknown'

export type QualityEvidenceKind = Extract<EpisodeEvidenceKind, 'objective' | 'verification'>

export type TaskLearningSubjectKind = 'automation-run' | 'outcome'
export type TaskLearningDisposition = 'upsert' | 'retract'

/** Reserved scope used only for rows that predate scoped evidence. */
export const legacyEvolutionScope = 'legacy:v1'

export type RuleStatus = 'active' | 'retired'

export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'conflicted'

export interface EpisodeInput {
  /** Canonical JSON tuple of absolute workspace and Agent preset. */
  scopeKey: string
  /**
   * Stable, coarse label for the recurring situation, for example
   * `weekly-report`. Guidance is only ever injected for the situation it was
   * learned in, so this label is what scopes a rule's blast radius.
   */
  situation: string
  outcome: EpisodeOutcome
  /** Short human-readable note on what happened. Never a prompt or a host path. */
  detail: string
  source: EpisodeSource
  trust: EpisodeTrust
  evidenceKind: EpisodeEvidenceKind
  /** Immutable ID in the authoritative Evaluation ledger. Required for quality evidence. */
  evidenceRef?: string
  /**
   * Immutable unit whose behaviour may be learned from. For an Automation
   * objective this is the exact production run, not the Evaluation row that
   * happened to assess it. For every other objective it is the Evaluation
   * outcome itself.
   */
  learningSubjectRef?: string
  /** Trusted infrastructure attribution. Model-supplied values never enter this field. */
  ruleId?: string
  /** Immutable rule generation captured by trusted injection infrastructure. */
  guidanceVersion?: number
  /** Untrusted/model-supplied association retained only for audit. */
  claimedRuleId?: string
  occurredAt: number
  idempotencyKey: string
}

export interface StoredEpisode {
  id: string
  scopeKey: string
  situation: string
  outcome: EpisodeOutcome
  detail: string
  source: EpisodeSource
  trust: EpisodeTrust
  evidenceKind: EpisodeEvidenceKind
  evidenceRef: string | undefined
  learningSubjectRef: string | undefined
  /** Host-derived projection; callers cannot mark arbitrary telemetry eligible. */
  learningEligible: boolean
  ruleId: string | undefined
  guidanceVersion: number | undefined
  claimedRuleId: string | undefined
  occurredAt: number
}

/** Current monotonic state of one Evaluation-owned learning subject. */
export interface StoredTaskLearningProjection {
  scopeKey: string
  /** Latest Evaluation scope watermark carried by the applying receipt. */
  scopeWatermark: number
  subjectKind: TaskLearningSubjectKind
  subjectRef: string
  version: number
  digest: string
  disposition: TaskLearningDisposition
  situation: string
  episodeId?: string
  updatedAt: number
}

export type TaskLearningProjectionInput = {
  scopeKey: string
  scopeWatermark: number
  subjectKind: TaskLearningSubjectKind
  subjectRef: string
  version: number
  digest: string
  situation: string
  occurredAt: number
} & ({
  disposition: 'upsert'
  outcome: EpisodeOutcome
  detail: string
  evidenceRef: string
  ruleId?: string
  guidanceVersion?: number
} | {
  disposition: 'retract'
})

export interface TaskLearningProjectionResult {
  projection: Readonly<StoredTaskLearningProjection>
  episode?: Readonly<StoredEpisode>
  replayed: boolean
}

export interface RuleInput {
  scopeKey: string
  situation: string
  /**
   * Advisory instruction injected as context for this situation. It cannot grant
   * authority: every tool call is still authorized by assistant-policy, which
   * never consults this table.
   */
  guidance: string
}

export interface StoredRule {
  id: string
  scopeKey: string
  situation: string
  guidance: string
  status: RuleStatus
  /** Failure count over the window that justified adoption. */
  baselineFailures: number
  /** Sample size over that window, so later comparison is like-for-like. */
  baselineTotal: number
  adoptedAt: number
  updatedAt: number
  retiredReason: string | undefined
  version: number
  /** Immutable adoption generation within one scoped situation. */
  generation: number
}

/**
 * Immutable receipt for a Host-authorized, evidence-gated rollback.
 *
 * This lane can only retire one exact active guidance generation. The risk
 * classification and evidence snapshot are computed by the store while holding
 * the SQLite writer lock; callers cannot provide or weaken either one.
 */
export interface StoredAutonomousRollback {
  scopeKey: string
  ruleId: string
  expectedVersion: number
  resultVersion: number
  risk: 'low'
  reason: string
  evaluation: SituationStats
  baseline: SituationStats
  evidence: EvidenceReference
  occurredAt: number
}

/** Observed failure rate for one situation over a bounded recent window. */
export interface SituationStats {
  scopeKey: string
  situation: string
  failures: number
  total: number
}

/**
 * A bounded projection of an episode used to compute a candidate. The detail is
 * outcome data, not an instruction, and model-visible renderers must preserve
 * that trust boundary.
 */
export interface EvidenceSample {
  episodeId: string
  outcome: EpisodeOutcome
  evidenceKind: QualityEvidenceKind
  evidenceRef: string
  detail: string
  occurredAt: number
}

/** Immutable provenance frozen into an adoption proposal. */
export interface EvidenceReference {
  sampleEpisodeIds: readonly string[]
  /** Digest of the complete ordered candidate window, not only the samples. */
  digest: string
  total: number
  /** Exact configured candidate window used for full digest revalidation. */
  window?: number
  /** Required for every v12 evidence-dependent proposal. */
  scopeWatermark?: number
  /** Complete ordered task-revision identity for the exact evidence window. */
  taskRevisions?: readonly Readonly<{
    subjectKind: TaskLearningSubjectKind
    subjectRef: string
    version: number
    digest: string
    disposition: 'upsert'
  }>[]
}

export type EvolutionMutation =
  | {
      op: 'adopt'
      ruleId?: string
      input: RuleInput
      baseline: SituationStats
      /** Optional only for legacy/direct store callers; Service proposals always freeze it. */
      evidence?: EvidenceReference
    }
  | {
      op: 'retire'
      /** Frozen exact active-rule review snapshot; all are server-derived. */
      scopeKey: string
      ruleId: string
      situation: string
      guidance: string
      generation: number
      expectedVersion: number
      reason: string
      /** Exact post-adoption window that justified retiring this rule. */
      evaluation: SituationStats
      /** Immutable adoption baseline copied from the exact active rule. */
      baseline: SituationStats
      /** Exact attributed candidate provenance reviewed by the owner. */
      evidence: EvidenceReference
    }
  | {
      /** Owner-approved immediate removal; it can never revise guidance. */
      op: 'owner-undo'
      scopeKey: string
      ruleId: string
      situation: string
      guidance: string
      generation: number
      expectedVersion: number
      reason: string
    }

/** Caller intent. Scope, baseline, generation and immutable rule ID are server-owned. */
export type EvolutionProposalMutation =
  | {
      op: 'adopt'
      input: Omit<RuleInput, 'scopeKey'>
      /** Accepted for source compatibility, but never trusted by the service. */
      baseline?: SituationStats
      /** Accepted for source compatibility, but never used as the stored rule ID. */
      ruleId?: string
    }
  | Pick<Extract<EvolutionMutation, { op: 'retire' }>, 'op' | 'ruleId' | 'expectedVersion' | 'reason'>

export interface StoredProposal {
  proposalId: string
  policyProposalId: string | undefined
  idempotencyKey: string
  requester: string
  principal: string
  scopeKey: string
  mutationHash: string
  mutation: EvolutionMutation
  creationIntent: EvolutionCreationIntent | undefined
  status: ProposalStatus
  expiresAt: number
  resultRuleId: string | undefined
  /** Complete immutable Policy tuple used to validate a terminal snapshot. */
  settlementExpectation: EvolutionSettlementExpectation | undefined
  version: number
}

export interface EvolutionSettlementExpectation {
  proposalId: string
  requester: string
  principal: string
  action: string
  resource: Readonly<{ kind: string; id: string }>
  summary: string
  diff: string
  expiresAt: number
  expectedVersion: number
}

/** Complete Policy proposal input frozen before crossing the database boundary. */
export interface EvolutionCreationIntent {
  idempotencyKey: string
  requester: string
  principal: string
  action: string
  resource: Readonly<{ kind: string; id: string }>
  diff: string
  summary: string
  ttlMs: number
  dispatch?: Readonly<{
    sourceId: string
    bindingId: string
    workspace: string
    principal: string
  }>
}

/** Durable proof that an exact immutable rule was injected into a session. */
export interface GuidanceExposure {
  sessionId: string
  scopeKey: string
  situation: string
  ruleId: string
  guidanceVersion: number
  exposedAt: number
}

/**
 * One candidate rule change with the evidence that motivated it. Candidates are
 * computed, never adopted automatically: adoption always goes through an
 * approval proposal.
 */
export interface RuleCandidate {
  scopeKey: string
  situation: string
  kind: 'adopt' | 'retire'
  /** Recent evidence supporting the change. */
  stats: SituationStats
  /** Present for `retire`: the rule that is not earning its place. */
  ruleId?: string
  /** Baseline the active rule was adopted against, for like-for-like comparison. */
  baseline?: SituationStats
  /** Bounded newest-first episode projections from the exact statistics window. */
  evidence: readonly EvidenceSample[]
  /** Digest of every eligible episode in the exact ordered statistics window. */
  evidenceDigest: string
  /** Number of eligible episodes covered by the digest. */
  evidenceTotal: number
  /** Evaluation scope state from which the complete window was computed. */
  scopeWatermark: number
  /** Complete ordered identity, not merely the bounded display samples. */
  taskRevisions: readonly Readonly<{
    subjectKind: TaskLearningSubjectKind
    subjectRef: string
    version: number
    digest: string
    disposition: 'upsert'
  }>[]
  /** Bounded, human-readable justification shown to the owner on review. */
  rationale: string
}

/** Immutable protocol spoken by the dedicated supervised-growth analyst. */
export const SUPERVISED_GROWTH_ANALYST_CONTRACT_VERSION = 'supervised-growth-analyst/v1' as const
export type SupervisedGrowthAnalystContractVersion =
  typeof SUPERVISED_GROWTH_ANALYST_CONTRACT_VERSION

/**
 * Complete identity of the exact adoption window reviewed by the analyst.
 *
 * `evidenceDigest` binds every eligible episode in the ordered window. Samples
 * are a bounded, human-readable projection and never replace that full digest.
 */
export interface SupervisedGrowthAnalystEvidence {
  contractVersion: SupervisedGrowthAnalystContractVersion
  situation: string
  failures: number
  total: number
  evidenceDigest: string
  evidenceTotal: number
  evidenceWindow: number
  sampleEpisodeIds: readonly string[]
  evidence: readonly EvidenceSample[]
  scopeWatermark: number
  taskRevisions: readonly Readonly<{
    subjectKind: TaskLearningSubjectKind
    subjectRef: string
    version: number
    digest: string
    disposition: 'upsert'
  }>[]
}

/** At most one adoption candidate is exposed to one analyst execution. */
export interface SupervisedGrowthAnalystCandidate extends SupervisedGrowthAnalystEvidence {
  /** Random durable capability; it deliberately reveals no evidence fields. */
  reviewToken: string
  /** True when this exact evidence identity already owns a durable proposal. */
  proposalExists: boolean
}

export interface SupervisedGrowthAnalystReview {
  contractVersion: SupervisedGrowthAnalystContractVersion
  candidate?: Readonly<SupervisedGrowthAnalystCandidate>
}

/** The analyst supplies wording only; target, baseline and evidence stay frozen. */
export interface SupervisedGrowthAnalystProposalInput {
  reviewToken: string
  guidance: string
}

/** Durable binding between one production execution and its frozen review. */
export interface StoredSupervisedGrowthAnalystReview {
  reviewToken: string
  scopeKey: string
  occurrenceId: string
  evidence: Readonly<SupervisedGrowthAnalystEvidence>
  proposalId?: string
  createdAt: number
  proposedAt?: number
}

export type EvolutionApplicationStatus = 'applied' | 'conflicted' | 'expired' | 'rejected'
export type EvolutionApplicationOperation = 'adopt' | 'owner-undo' | 'retire'

/** Domain-authoritative result of applying one terminal Policy decision. */
export interface StoredEvolutionApplicationReceipt {
  localProposalId: string
  policyProposalId: string
  applicationStatus: EvolutionApplicationStatus
  operation: EvolutionApplicationOperation
  terminalAt: number
  receiptDigest: string
  revision: number
  ruleId?: string
  resultingRuleVersion?: number
  ruleStatus?: RuleStatus
}

/** Durable producer outbox state; Delivery acknowledgement is not settlement. */
export interface StoredEvolutionApplicationOutboxEntry {
  receipt: Readonly<StoredEvolutionApplicationReceipt>
  state: 'pending' | 'published'
  attemptCount: number
  updatedAt: number
  publishedAt?: number
  lastError?: string
}
