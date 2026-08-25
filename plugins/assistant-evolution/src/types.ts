/** Whether an observed episode ended well. Deliberately binary: a rule is only
 * worth adopting if the difference it makes is unambiguous. */
export type EpisodeOutcome = 'succeeded' | 'failed'

/** Where an episode came from. Unattended runs and foreground turns are both
 * admissible evidence, but the origin is recorded so review can weigh them. */
export type EpisodeSource = 'automation' | 'foreground'

/** Whether the recorder is authoritative for the fact it reports. */
export type EpisodeTrust = 'trusted' | 'self-reported' | 'legacy'

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
  ruleId: string | undefined
  guidanceVersion: number | undefined
  claimedRuleId: string | undefined
  occurredAt: number
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
  detail: string
  occurredAt: number
}

/** Immutable provenance frozen into an adoption proposal. */
export interface EvidenceReference {
  sampleEpisodeIds: readonly string[]
  /** Digest of the complete ordered candidate window, not only the samples. */
  digest: string
  total: number
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
      ruleId: string
      expectedVersion: number
      reason: string
      /** Exact post-adoption window that justified retiring this rule. */
      evaluation: SituationStats
      /** Immutable adoption baseline copied from the exact active rule. */
      baseline: SituationStats
      /** Exact attributed candidate provenance reviewed by the owner. */
      evidence: EvidenceReference
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
  /** Bounded, human-readable justification shown to the owner on review. */
  rationale: string
}
