import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ApprovalDispatchRoute } from '@dsh-enhanced/assistant-policy'
import { openEvolutionDatabase } from './sqlite.js'
import { evolutionMutationReview } from './review.js'
import type {
  EpisodeInput,
  EpisodeEvidenceKind,
  EpisodeSource,
  EpisodeTrust,
  EvidenceReference,
  EvidenceSample,
  EvolutionCreationIntent,
  EvolutionCreationInput,
  EvolutionMutation,
  EvolutionSettlementExpectation,
  GuidanceExposure,
  ProposalStatus,
  RuleCandidate,
  RuleInput,
  SituationStats,
  StoredEpisode,
  StoredEvolutionApplicationOutboxEntry,
  StoredEvolutionApplicationReceipt,
  StoredAutonomousRollback,
  StoredProposal,
  StoredRule,
  StoredSupervisedGrowthAnalystReview,
  StoredTaskLearningProjection,
  SupervisedGrowthAnalystEvidence,
  SupervisedGrowthAnalystContractVersion,
  TaskLearningProjectionInput,
  TaskLearningProjectionResult,
} from './types.js'
import {
  legacyEvolutionScope,
  SUPERVISED_GROWTH_ANALYST_CONTRACT_VERSION,
} from './types.js'

export type EvolutionStoreErrorCode =
  | 'idempotency-conflict'
  | 'invalid-input'
  | 'invalid-state'
  | 'not-found'
  | 'version-conflict'

export class EvolutionStoreError extends Error {
  constructor(readonly code: EvolutionStoreErrorCode, message: string) {
    super(message)
    this.name = 'EvolutionStoreError'
  }
}

export interface EvolutionStoreOptions {
  path: string
  now?: () => number
  maxSituationBytes?: number
  maxGuidanceBytes?: number
  maxDetailBytes?: number
}

/** Low-cardinality counters safe to expose through a local health seam. */
export interface EvolutionStoreHealth {
  activeRules: number
  retiredRules: number
  pendingProposals: number
  conflictedProposals: number
  trustedEpisodes: number
  qualityEligibleEpisodes: number
  operationalEpisodes: number
  legacyQuarantinedEpisodes: number
  unattributedTrustedEpisodes: number
  unattributedQualityEligibleEpisodes: number
  lastTrustedEpisodeAt: number
  lastQualityEligibleEpisodeAt: number
  autonomousRollbacks: number
  taskLearningProjections: number
  retractedTaskLearningProjections: number
  taskLearningProjectionRevisions: number
  taskLearningProjectionIntegrityErrors: number
}

interface EpisodeRow {
  id: string
  scope_key: string
  situation: string
  outcome: 'succeeded' | 'failed'
  detail: string
  source: EpisodeSource
  trust: EpisodeTrust
  evidence_kind: EpisodeEvidenceKind
  evidence_ref: string | null
  learning_subject_ref: string | null
  learning_eligible: 0 | 1
  rule_id: string | null
  guidance_version: number | null
  claimed_rule_id: string | null
  occurred_at: number
}

interface CandidateEpisodeRow extends EpisodeRow {
  task_subject_kind: 'automation-run' | 'outcome'
  task_subject_ref: string
  task_version: number
  task_digest: string
  task_disposition: 'upsert'
}

interface NormalizedEpisodeWrite {
  scopeKey: string
  situation: string
  outcome: 'succeeded' | 'failed'
  detail: string
  source: EpisodeSource
  trust: EpisodeTrust
  evidenceKind: EpisodeEvidenceKind
  evidenceRef: string | undefined
  learningSubjectRef: string | undefined
  learningEligible: 0 | 1
  ruleId: string | undefined
  guidanceVersion: number | undefined
  claimedRuleId: string | undefined
  occurredAt: number
}

interface RuleRow {
  id: string
  scope_key: string
  situation: string
  guidance: string
  status: 'active' | 'retired'
  baseline_failures: number
  baseline_total: number
  adopted_at: number
  updated_at: number
  retired_reason: string | null
  version: number
  generation: number
}

interface ProposalRow {
  id: string
  policy_proposal_id: string | null
  idempotency_key: string
  requester: string
  principal: string
  scope_key: string
  mutation_hash: string
  mutation_json: string
  creation_intent_json: string | null
  settlement_expectation_json: string | null
  status: ProposalStatus
  expires_at: number
  result_rule_id: string | null
  updated_at: number
  version: number
}

interface GuidanceExposureRow {
  session_id: string
  scope_key: string
  situation: string
  rule_id: string
  guidance_version: number
  exposed_at: number
}

interface AutonomousRollbackRow {
  idempotency_key: string
  scope_key: string
  rule_id: string
  expected_version: number
  result_version: number
  risk: 'low'
  reason: string
  evaluation_failures: number
  evaluation_total: number
  baseline_failures: number
  baseline_total: number
  evidence_digest: string
  evidence_total: number
  sample_episode_ids_json: string
  occurred_at: number
}

interface TaskLearningProjectionRow {
  scope_key: string
  scope_watermark: number
  subject_kind: 'automation-run' | 'outcome'
  subject_ref: string
  version: number
  digest: string
  disposition: 'upsert' | 'retract'
  situation: string
  episode_id: string | null
  updated_at: number
}

interface SupervisedGrowthAnalystReviewRow {
  review_token: string
  scope_key: string
  occurrence_id: string
  contract_version: SupervisedGrowthAnalystContractVersion
  situation: string
  failures: number
  total: number
  evidence_digest: string
  evidence_total: number
  evidence_window: number
  sample_episode_ids_json: string
  evidence_json: string
  scope_watermark: number
  task_revisions_json: string
  proposal_id: string | null
  created_at: number
  proposed_at: number | null
}

interface EvolutionApplicationReceiptRow {
  local_proposal_id: string
  policy_proposal_id: string
  application_status: 'applied' | 'conflicted' | 'expired' | 'rejected'
  operation: 'adopt' | 'owner-undo' | 'retire'
  terminal_at: number
  receipt_digest: string
  revision: number
  rule_id: string | null
  resulting_rule_version: number | null
  rule_status: 'active' | 'retired' | null
}

interface EvolutionApplicationOutboxRow extends EvolutionApplicationReceiptRow {
  state: 'pending' | 'published'
  attempt_count: number
  updated_at: number
  published_at: number | null
  last_error: string | null
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function episode(row: EpisodeRow): StoredEpisode {
  return Object.freeze({
    id: row.id,
    scopeKey: row.scope_key,
    situation: row.situation,
    outcome: row.outcome,
    detail: row.detail,
    source: row.source,
    trust: row.trust,
    evidenceKind: row.evidence_kind,
    evidenceRef: row.evidence_ref ?? undefined,
    learningSubjectRef: row.learning_subject_ref ?? undefined,
    learningEligible: row.learning_eligible === 1,
    ruleId: row.rule_id ?? undefined,
    guidanceVersion: row.guidance_version ?? undefined,
    claimedRuleId: row.claimed_rule_id ?? undefined,
    occurredAt: row.occurred_at,
  })
}

function exactEpisodePayload(
  row: EpisodeRow,
  input: NormalizedEpisodeWrite,
  allowCompatibleQuarantinedReplay = false,
): boolean {
  const compatibleQuarantinedReplay = allowCompatibleQuarantinedReplay
    && row.evidence_kind === 'legacy-unknown'
    && row.evidence_ref === null
    && row.learning_eligible === 0
    && input.evidenceKind === 'operational'
    && input.evidenceRef === undefined
    && input.learningEligible === 0
  return row.scope_key === input.scopeKey
    && row.situation === input.situation
    && row.outcome === input.outcome
    && row.detail === input.detail
    && row.source === input.source
    && row.trust === input.trust
    && (row.evidence_kind === input.evidenceKind || compatibleQuarantinedReplay)
    && (row.evidence_ref ?? undefined) === input.evidenceRef
    && (row.learning_subject_ref ?? undefined) === input.learningSubjectRef
    && (row.learning_eligible === input.learningEligible || compatibleQuarantinedReplay)
    && (row.rule_id ?? undefined) === input.ruleId
    && (row.guidance_version ?? undefined) === input.guidanceVersion
    && (row.claimed_rule_id ?? undefined) === input.claimedRuleId
    && row.occurred_at === input.occurredAt
}

function rule(row: RuleRow): StoredRule {
  return Object.freeze({
    id: row.id,
    scopeKey: row.scope_key,
    situation: row.situation,
    guidance: row.guidance,
    status: row.status,
    baselineFailures: row.baseline_failures,
    baselineTotal: row.baseline_total,
    adoptedAt: row.adopted_at,
    updatedAt: row.updated_at,
    retiredReason: row.retired_reason ?? undefined,
    version: row.version,
    generation: row.generation,
  })
}

function approvalDispatch(
  input: unknown,
  errorCode: Extract<EvolutionStoreErrorCode, 'invalid-input' | 'invalid-state'>,
  allowLegacy: boolean,
): Readonly<ApprovalDispatchRoute> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new EvolutionStoreError(errorCode, 'Policy dispatch is invalid')
  }
  const route = input as Record<string, unknown>
  const keys = Object.keys(route).sort().join(',')
  const legacyKeys = 'bindingId,principal,sourceId,workspace'
  const versionedLegacyKeys = 'bindingId,principal,routeVersion,sourceId,workspace'
  const v2Keys = [
    'bindingGeneration', 'bindingId', 'bindingVersion', 'principal', 'principalRecordId',
    'principalVersion', 'routeVersion', 'sourceId', 'workspace',
  ].sort().join(',')
  const legacy = keys === legacyKeys || (keys === versionedLegacyKeys && route['routeVersion'] === 1)
  const v2 = keys === v2Keys && route['routeVersion'] === 2
    && typeof route['bindingVersion'] === 'number'
    && Number.isSafeInteger(route['bindingVersion']) && route['bindingVersion'] > 0
    && typeof route['bindingGeneration'] === 'number'
    && Number.isSafeInteger(route['bindingGeneration']) && route['bindingGeneration'] > 0
    && typeof route['principalRecordId'] === 'string'
    && route['principalRecordId'].trim() !== ''
    && Buffer.byteLength(route['principalRecordId'], 'utf8') <= 500
    && typeof route['principalVersion'] === 'number'
    && Number.isSafeInteger(route['principalVersion']) && route['principalVersion'] > 0
  if ((!v2 && !(allowLegacy && legacy))
    || typeof route['sourceId'] !== 'string' || route['sourceId'].trim() === ''
    || typeof route['bindingId'] !== 'string' || route['bindingId'].trim() === ''
    || typeof route['workspace'] !== 'string' || route['workspace'].trim() === ''
    || typeof route['principal'] !== 'string' || route['principal'].trim() === '') {
    throw new EvolutionStoreError(errorCode, 'Policy dispatch is invalid')
  }
  return Object.freeze(input as ApprovalDispatchRoute)
}

function creationIntent(value: string | null): EvolutionCreationIntent | undefined {
  if (value === null) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new EvolutionStoreError('invalid-state', 'stored Policy creation intent is invalid')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EvolutionStoreError('invalid-state', 'stored Policy creation intent is invalid')
  }
  const intent = parsed as Record<string, unknown>
  if (Object.hasOwn(intent, 'dispatch') && intent['dispatch'] !== undefined) {
    intent['dispatch'] = approvalDispatch(intent['dispatch'], 'invalid-state', true)
  }
  return Object.freeze(parsed as EvolutionCreationIntent)
}

function proposal(row: ProposalRow): StoredProposal {
  return Object.freeze({
    proposalId: row.id,
    policyProposalId: row.policy_proposal_id ?? undefined,
    idempotencyKey: row.idempotency_key,
    requester: row.requester,
    principal: row.principal,
    scopeKey: row.scope_key,
    mutationHash: row.mutation_hash,
    mutation: JSON.parse(row.mutation_json) as EvolutionMutation,
    creationIntent: creationIntent(row.creation_intent_json),
    status: row.status,
    expiresAt: row.expires_at,
    resultRuleId: row.result_rule_id ?? undefined,
    settlementExpectation: row.settlement_expectation_json === null
      ? undefined
      : JSON.parse(row.settlement_expectation_json) as EvolutionSettlementExpectation,
    version: row.version,
  })
}

function guidanceExposure(row: GuidanceExposureRow): GuidanceExposure {
  return Object.freeze({
    sessionId: row.session_id,
    scopeKey: row.scope_key,
    situation: row.situation,
    ruleId: row.rule_id,
    guidanceVersion: row.guidance_version,
    exposedAt: row.exposed_at,
  })
}

function autonomousRollback(row: AutonomousRollbackRow, situation: string): StoredAutonomousRollback {
  return Object.freeze({
    scopeKey: row.scope_key,
    ruleId: row.rule_id,
    expectedVersion: row.expected_version,
    resultVersion: row.result_version,
    risk: row.risk,
    reason: row.reason,
    evaluation: Object.freeze({
      scopeKey: row.scope_key,
      situation,
      failures: row.evaluation_failures,
      total: row.evaluation_total,
    }),
    baseline: Object.freeze({
      scopeKey: row.scope_key,
      situation,
      failures: row.baseline_failures,
      total: row.baseline_total,
    }),
    evidence: Object.freeze({
      sampleEpisodeIds: Object.freeze(JSON.parse(row.sample_episode_ids_json) as string[]),
      digest: row.evidence_digest,
      total: row.evidence_total,
    }),
    occurredAt: row.occurred_at,
  })
}

function taskLearningProjection(row: TaskLearningProjectionRow): StoredTaskLearningProjection {
  return Object.freeze({
    scopeKey: row.scope_key,
    scopeWatermark: row.scope_watermark,
    subjectKind: row.subject_kind,
    subjectRef: row.subject_ref,
    version: row.version,
    digest: row.digest,
    disposition: row.disposition,
    situation: row.situation,
    ...(row.episode_id === null ? {} : { episodeId: row.episode_id }),
    updatedAt: row.updated_at,
  })
}

function supervisedGrowthAnalystReview(
  row: SupervisedGrowthAnalystReviewRow,
): StoredSupervisedGrowthAnalystReview {
  const evidence = JSON.parse(row.evidence_json) as EvidenceSample[]
  return Object.freeze({
    reviewToken: row.review_token,
    scopeKey: row.scope_key,
    occurrenceId: row.occurrence_id,
    evidence: Object.freeze({
      contractVersion: row.contract_version,
      situation: row.situation,
      failures: row.failures,
      total: row.total,
      evidenceDigest: row.evidence_digest,
      evidenceTotal: row.evidence_total,
      evidenceWindow: row.evidence_window,
      sampleEpisodeIds: Object.freeze(JSON.parse(row.sample_episode_ids_json) as string[]),
      evidence: Object.freeze(evidence.map(entry => Object.freeze({ ...entry }))),
      scopeWatermark: row.scope_watermark,
      taskRevisions: Object.freeze((JSON.parse(row.task_revisions_json) as Array<{
        subjectKind: 'automation-run' | 'outcome'
        subjectRef: string
        version: number
        digest: string
        disposition: 'upsert'
      }>).map(entry => Object.freeze({ ...entry }))),
    }),
    ...(row.proposal_id === null ? {} : { proposalId: row.proposal_id }),
    createdAt: row.created_at,
    ...(row.proposed_at === null ? {} : { proposedAt: row.proposed_at }),
  })
}

function evolutionApplicationReceipt(
  row: EvolutionApplicationReceiptRow,
): StoredEvolutionApplicationReceipt {
  return Object.freeze({
    localProposalId: row.local_proposal_id,
    policyProposalId: row.policy_proposal_id,
    applicationStatus: row.application_status,
    operation: row.operation,
    terminalAt: row.terminal_at,
    receiptDigest: row.receipt_digest,
    revision: row.revision,
    ...(row.rule_id === null ? {} : { ruleId: row.rule_id }),
    ...(row.resulting_rule_version === null
      ? {} : { resultingRuleVersion: row.resulting_rule_version }),
    ...(row.rule_status === null ? {} : { ruleStatus: row.rule_status }),
  })
}

function evolutionApplicationOutbox(
  row: EvolutionApplicationOutboxRow,
): StoredEvolutionApplicationOutboxEntry {
  return Object.freeze({
    receipt: evolutionApplicationReceipt(row),
    state: row.state,
    attemptCount: row.attempt_count,
    updatedAt: row.updated_at,
    ...(row.published_at === null ? {} : { publishedAt: row.published_at }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
  })
}

/**
 * Stable analyst proposal identity. Deliberately do not add guidance, owner,
 * execution, token, TTL, samples or timestamps: those are not the learned fact.
 */
export function supervisedGrowthAnalystProposalIdempotencyKey(input: {
  scopeKey: string
  situation: string
  evidenceDigest: string
  evidenceTotal: number
  contractVersion: SupervisedGrowthAnalystContractVersion
}): string {
  return `evolution-analyst:${digest([
    input.scopeKey,
    input.situation,
    input.evidenceDigest,
    input.evidenceTotal,
    input.contractVersion,
  ])}`
}

/**
 * Durable evidence and rule ledger.
 *
 * Two invariants matter most. First, a rule is data, not authority: nothing here
 * can widen what a tool call may do, because assistant-policy is consulted
 * separately and never reads this database. Second, adoption is never automatic —
 * the store can only *propose* a change, so an owner decision always stands
 * between an observation and a behavioural change.
 */
export class EvolutionStore {
  readonly #database: DatabaseSync
  readonly #now: () => number
  readonly #maxSituationBytes: number
  readonly #maxGuidanceBytes: number
  readonly #maxDetailBytes: number

  constructor(options: EvolutionStoreOptions) {
    this.#database = openEvolutionDatabase(options.path)
    this.#now = options.now ?? Date.now
    this.#maxSituationBytes = options.maxSituationBytes ?? 200
    this.#maxGuidanceBytes = options.maxGuidanceBytes ?? 2_048
    this.#maxDetailBytes = options.maxDetailBytes ?? 1_024
    this.#backfillEvolutionApplicationReceipts()
  }

  close(): void {
    this.#database.close()
  }

  /**
   * Return aggregate operational state only. The query deliberately projects no
   * situation, scope, guidance, detail, principal, path, or proposal body.
   */
  health(): Readonly<EvolutionStoreHealth> {
    const row = this.#database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM evolution_rules WHERE status = 'active') AS active_rules,
        (SELECT COUNT(*) FROM evolution_rules WHERE status = 'retired') AS retired_rules,
        (SELECT COUNT(*) FROM evolution_proposals WHERE status = 'pending') AS pending_proposals,
        (SELECT COUNT(*) FROM evolution_proposals WHERE status = 'conflicted') AS conflicted_proposals,
        (SELECT COUNT(*) FROM evolution_episodes WHERE trust = 'trusted') AS trusted_episodes,
        (SELECT COUNT(*) FROM evolution_episodes
          WHERE learning_eligible = 1) AS quality_eligible_episodes,
        (SELECT COUNT(*) FROM evolution_episodes
          WHERE evidence_kind = 'operational') AS operational_episodes,
        (SELECT COUNT(*) FROM evolution_episodes
          WHERE evidence_kind = 'legacy-unknown') AS legacy_quarantined_episodes,
        (SELECT COUNT(*) FROM evolution_episodes
          WHERE trust = 'trusted' AND rule_id IS NULL) AS unattributed_trusted_episodes,
        (SELECT COUNT(*) FROM evolution_episodes
          WHERE learning_eligible = 1 AND rule_id IS NULL) AS unattributed_quality_eligible_episodes,
        (SELECT COALESCE(MAX(occurred_at), 0) FROM evolution_episodes
          WHERE trust = 'trusted') AS last_trusted_episode_at,
        (SELECT COALESCE(MAX(occurred_at), 0) FROM evolution_episodes
          WHERE learning_eligible = 1) AS last_quality_eligible_episode_at,
        (SELECT COUNT(*) FROM evolution_autonomous_rollbacks) AS autonomous_rollbacks
        ,(SELECT COUNT(*) FROM evolution_task_learning_state) AS task_learning_projections
        ,(SELECT COUNT(*) FROM evolution_task_learning_state
          WHERE disposition = 'retract') AS retracted_task_learning_projections
        ,(SELECT COUNT(*) FROM evolution_task_learning_revisions) AS task_learning_projection_revisions
        ,(SELECT COUNT(*)
          FROM evolution_task_learning_state state
          LEFT JOIN evolution_task_learning_revisions revision
            ON revision.scope_key = state.scope_key
            AND revision.subject_kind = state.subject_kind
            AND revision.subject_ref = state.subject_ref
            AND revision.version = state.version
          LEFT JOIN evolution_episodes episode ON episode.id = state.episode_id
          WHERE revision.version IS NULL OR revision.digest <> state.digest
            OR revision.disposition <> state.disposition
            OR revision.situation <> state.situation
            OR NOT (revision.episode_id IS state.episode_id)
            OR (state.disposition = 'upsert' AND (
              episode.id IS NULL OR episode.learning_eligible <> 1
              OR episode.scope_key <> state.scope_key))
            OR (state.disposition = 'retract' AND state.episode_id IS NOT NULL)
        ) AS task_learning_projection_integrity_errors
    `).get() as {
      active_rules: number
      retired_rules: number
      pending_proposals: number
      conflicted_proposals: number
      trusted_episodes: number
      quality_eligible_episodes: number
      operational_episodes: number
      legacy_quarantined_episodes: number
      unattributed_trusted_episodes: number
      unattributed_quality_eligible_episodes: number
      last_trusted_episode_at: number
      last_quality_eligible_episode_at: number
      autonomous_rollbacks: number
      task_learning_projections: number
      retracted_task_learning_projections: number
      task_learning_projection_revisions: number
      task_learning_projection_integrity_errors: number
    }
    return Object.freeze({
      activeRules: row.active_rules,
      retiredRules: row.retired_rules,
      pendingProposals: row.pending_proposals,
      conflictedProposals: row.conflicted_proposals,
      trustedEpisodes: row.trusted_episodes,
      qualityEligibleEpisodes: row.quality_eligible_episodes,
      operationalEpisodes: row.operational_episodes,
      legacyQuarantinedEpisodes: row.legacy_quarantined_episodes,
      unattributedTrustedEpisodes: row.unattributed_trusted_episodes,
      unattributedQualityEligibleEpisodes: row.unattributed_quality_eligible_episodes,
      lastTrustedEpisodeAt: row.last_trusted_episode_at,
      lastQualityEligibleEpisodeAt: row.last_quality_eligible_episode_at,
      autonomousRollbacks: row.autonomous_rollbacks,
      taskLearningProjections: row.task_learning_projections,
      retractedTaskLearningProjections: row.retracted_task_learning_projections,
      taskLearningProjectionRevisions: row.task_learning_projection_revisions,
      taskLearningProjectionIntegrityErrors: row.task_learning_projection_integrity_errors,
    })
  }

  /** Record one observed outcome. Idempotent on `idempotencyKey`. */
  recordEpisode(input: EpisodeInput): StoredEpisode {
    const scopeKey = this.#scopeKey(input.scopeKey)
    const situation = this.#situation(input.situation)
    const detail = this.#bounded(input.detail, 'detail', this.#maxDetailBytes)
    const key = this.#bounded(input.idempotencyKey, 'idempotencyKey', 200)
    if (!Number.isSafeInteger(input.occurredAt) || input.occurredAt < 0) {
      throw new EvolutionStoreError('invalid-input', 'occurredAt must be a non-negative safe integer')
    }
    if (!['trusted', 'self-reported', 'legacy'].includes(input.trust)) {
      throw new EvolutionStoreError('invalid-input', 'trust is invalid')
    }
    if (!['operational', 'objective', 'verification', 'legacy-unknown'].includes(input.evidenceKind)) {
      throw new EvolutionStoreError('invalid-input', 'evidenceKind is invalid')
    }
    if (scopeKey === legacyEvolutionScope && input.trust !== 'legacy') {
      throw new EvolutionStoreError('invalid-input', 'legacy scope may only contain quarantined evidence')
    }
    if (input.trust === 'legacy' && input.evidenceKind !== 'legacy-unknown') {
      throw new EvolutionStoreError('invalid-input', 'legacy evidence must remain quarantined')
    }
    const evidenceRef = input.evidenceRef === undefined
      ? undefined
      : this.#opaque(input.evidenceRef, 'evidenceRef', 500)
    const learningSubjectRef = input.learningSubjectRef === undefined
      ? undefined
      : this.#opaque(input.learningSubjectRef, 'learningSubjectRef', 1_000)
    const isQualityKind = input.evidenceKind === 'objective' || input.evidenceKind === 'verification'
    if ((input.source === 'evaluation') !== isQualityKind) {
      throw new EvolutionStoreError(
        'invalid-input',
        'learning-eligible quality evidence must use authoritative Evaluation provenance',
      )
    }
    if (isQualityKind && (input.trust !== 'trusted' || evidenceRef === undefined
      || learningSubjectRef === undefined)) {
      throw new EvolutionStoreError(
        'invalid-input',
        'quality evidence requires trusted attribution, an Evaluation reference, and a learning subject',
      )
    }
    if (!isQualityKind && evidenceRef !== undefined) {
      throw new EvolutionStoreError('invalid-input', 'only quality evidence may carry an Evaluation reference')
    }
    if (!isQualityKind && learningSubjectRef !== undefined) {
      throw new EvolutionStoreError('invalid-input', 'only quality evidence may carry a learning subject')
    }
    const learningEligible = isQualityKind ? 1 : 0
    const trustedRuleId = input.trust === 'trusted' && input.ruleId !== undefined
      ? this.#bounded(input.ruleId, 'ruleId', 200)
      : undefined
    let guidanceVersion: number | undefined
    if (input.guidanceVersion !== undefined) {
      if (trustedRuleId === undefined || !Number.isSafeInteger(input.guidanceVersion)
        || input.guidanceVersion < 1 || input.guidanceVersion > 1_000_000_000) {
        throw new EvolutionStoreError(
          'invalid-input',
          'guidanceVersion requires trusted rule attribution and must be a positive safe integer',
        )
      }
      guidanceVersion = input.guidanceVersion
    }
    const claimedRuleId = input.trust === 'trusted'
      ? (input.claimedRuleId === undefined ? undefined : this.#bounded(input.claimedRuleId, 'claimedRuleId', 200))
      : (input.claimedRuleId ?? input.ruleId) === undefined
        ? undefined
        : this.#bounded((input.claimedRuleId ?? input.ruleId)!, 'claimedRuleId', 200)
    const normalized: NormalizedEpisodeWrite = {
      scopeKey,
      situation,
      outcome: input.outcome,
      detail,
      source: input.source,
      trust: input.trust,
      evidenceKind: input.evidenceKind,
      evidenceRef,
      learningSubjectRef,
      learningEligible,
      ruleId: trustedRuleId,
      guidanceVersion,
      claimedRuleId,
      occurredAt: input.occurredAt,
    }
    const id = `episode-${randomUUID()}`
    this.#database.prepare(`
      INSERT INTO evolution_episodes(
        id, idempotency_key, scope_key, situation, outcome, detail, source,
        trust, evidence_kind, evidence_ref, learning_subject_ref, learning_eligible,
        rule_id, guidance_version, claimed_rule_id, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `).run(
      id, key, scopeKey, situation, input.outcome, detail, input.source,
      input.trust, input.evidenceKind, evidenceRef ?? null, learningSubjectRef ?? null, learningEligible,
      trustedRuleId ?? null, guidanceVersion ?? null, claimedRuleId ?? null, input.occurredAt,
    )
    const idempotencyWinner = this.#database.prepare(
      'SELECT * FROM evolution_episodes WHERE idempotency_key = ?',
    ).get(key) as unknown as EpisodeRow | undefined
    if (idempotencyWinner !== undefined) {
      // Replay must be exact; a reused key with different content is a caller bug.
      if (!exactEpisodePayload(idempotencyWinner, normalized, true)) {
        throw new EvolutionStoreError(
          'idempotency-conflict',
          'episode idempotency key was reused with different content',
        )
      }
      return episode(idempotencyWinner)
    }
    if (learningEligible === 1) {
      const subjectWinner = this.#database.prepare(`
        SELECT * FROM evolution_episodes
        WHERE scope_key = ? AND learning_subject_ref = ?
          AND learning_eligible = 1
      `).get(scopeKey, learningSubjectRef!) as unknown as EpisodeRow | undefined
      if (subjectWinner !== undefined) {
        const exactEvaluationReplay = subjectWinner.evidence_ref === evidenceRef
        const matches = exactEvaluationReplay
          ? exactEpisodePayload(subjectWinner, normalized)
          : this.#sameLearningSubjectResult(subjectWinner, normalized)
        if (!matches) {
          throw new EvolutionStoreError(
            'idempotency-conflict',
            'immutable learning subject was assessed with a contradictory result',
          )
        }
        return episode(subjectWinner)
      }
      const evidenceWinner = this.#database.prepare(`
        SELECT * FROM evolution_episodes
        WHERE scope_key = ? AND evidence_ref = ?
          AND learning_eligible = 1
      `).get(scopeKey, evidenceRef!) as unknown as EpisodeRow | undefined
      if (evidenceWinner !== undefined) {
        if (!exactEpisodePayload(evidenceWinner, normalized)) {
          throw new EvolutionStoreError(
            'idempotency-conflict',
            'immutable quality evidence reference was reused with different content',
          )
        }
        return episode(evidenceWinner)
      }
    }
    throw new EvolutionStoreError(
      'invalid-state',
      'episode insert did not produce an exact idempotency or evidence winner',
    )
  }

  /**
   * Apply one authoritative Evaluation task revision.  The current pointer,
   * immutable revision audit, active learning vote and stale-proposal fence are
   * committed under one SQLite writer lock.
   *
   * The first accepted revision may be greater than one because several old
   * Evaluation outbox triggers all resolve to the latest canonical task.  A
   * lower revision is never acknowledged: it indicates an Evaluation rollback
   * or a mismatched database restore and must remain visible to recovery.
   */
  applyTaskLearningProjection(input: TaskLearningProjectionInput): TaskLearningProjectionResult {
    const scopeKey = this.#scopeKey(input.scopeKey)
    const subjectKind = input.subjectKind
    if (subjectKind !== 'automation-run' && subjectKind !== 'outcome') {
      throw new EvolutionStoreError('invalid-input', 'task learning subjectKind is invalid')
    }
    const subjectRef = this.#opaque(input.subjectRef, 'subjectRef', 1_000)
    if (!Number.isSafeInteger(input.version) || input.version < 1
      || input.version > 1_000_000_000) {
      throw new EvolutionStoreError('invalid-input', 'task learning version must be a positive safe integer')
    }
    if (!Number.isSafeInteger(input.scopeWatermark) || input.scopeWatermark < 1) {
      throw new EvolutionStoreError(
        'invalid-input',
        'task learning scope watermark must be a positive safe integer',
      )
    }
    const projectionDigest = this.#bounded(input.digest, 'digest', 64)
    if (!/^[a-f\d]{64}$/u.test(projectionDigest)) {
      throw new EvolutionStoreError('invalid-input', 'task learning digest must be lowercase SHA-256')
    }
    const situation = this.#situation(input.situation)
    if (!Number.isSafeInteger(input.occurredAt) || input.occurredAt < 0) {
      throw new EvolutionStoreError('invalid-input', 'task learning occurredAt is invalid')
    }
    if (input.disposition !== 'upsert' && input.disposition !== 'retract') {
      throw new EvolutionStoreError('invalid-input', 'task learning disposition is invalid')
    }

    let result!: TaskLearningProjectionResult
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const scopeWatermark = this.#database.prepare(`
        SELECT watermark FROM evolution_scope_learning_watermarks WHERE scope_key = ?
      `).get(scopeKey) as { watermark: number } | undefined
      if (scopeWatermark !== undefined && input.scopeWatermark < scopeWatermark.watermark) {
        throw new EvolutionStoreError(
          'version-conflict',
          'task learning receipt carries an older Evaluation scope watermark',
        )
      }
      const current = this.#database.prepare(`
        SELECT * FROM evolution_task_learning_state
        WHERE scope_key = ? AND subject_kind = ? AND subject_ref = ?
      `).get(scopeKey, subjectKind, subjectRef) as unknown as TaskLearningProjectionRow | undefined
      if (current !== undefined) this.#assertTaskLearningState(current)
      if (current !== undefined && input.version < current.version) {
        throw new EvolutionStoreError(
          'version-conflict',
          'task learning revision is older than the current authoritative state',
        )
      }
      if (current !== undefined && input.version === current.version) {
        if (current.digest !== projectionDigest || current.disposition !== input.disposition
          || current.situation !== situation) {
          throw new EvolutionStoreError(
            'idempotency-conflict',
            'task learning version was reused with different canonical content',
          )
        }
        this.#recordScopeLearningWatermark(scopeKey, input.scopeWatermark, this.#now())
        this.#database.prepare(`
          UPDATE evolution_task_learning_state SET scope_watermark = ?
          WHERE scope_key = ? AND subject_kind = ? AND subject_ref = ?
            AND scope_watermark <= ?
        `).run(
          input.scopeWatermark,
          scopeKey,
          subjectKind,
          subjectRef,
          input.scopeWatermark,
        )
        const replayState = this.#database.prepare(`
          SELECT * FROM evolution_task_learning_state
          WHERE scope_key = ? AND subject_kind = ? AND subject_ref = ?
        `).get(scopeKey, subjectKind, subjectRef) as unknown as TaskLearningProjectionRow
        const currentEpisode = replayState.episode_id === null
          ? undefined
          : this.#database.prepare('SELECT * FROM evolution_episodes WHERE id = ?')
            .get(replayState.episode_id) as unknown as EpisodeRow | undefined
        result = Object.freeze({
          projection: taskLearningProjection(replayState),
          ...(currentEpisode === undefined ? {} : { episode: episode(currentEpisode) }),
          replayed: true,
        })
        this.#database.exec('COMMIT')
        return result
      }

      if (current?.episode_id !== null && current?.episode_id !== undefined) {
        const invalidated = this.#database.prepare(`
          UPDATE evolution_episodes
          SET learning_subject_ref = NULL, learning_eligible = 0
          WHERE id = ? AND scope_key = ? AND learning_eligible = 1
        `).run(current.episode_id, scopeKey)
        if (invalidated.changes !== 1) {
          throw new EvolutionStoreError('invalid-state', 'current task learning vote could not be retracted')
        }
      }

      const now = this.#now()
      let storedEpisode: StoredEpisode | undefined
      if (input.disposition === 'upsert') {
        const identity = digest([
          'evaluation-task-revision/v1', scopeKey, subjectKind, subjectRef,
          input.version, projectionDigest,
        ])
        storedEpisode = this.recordEpisode({
          scopeKey,
          situation,
          outcome: input.outcome,
          detail: input.detail,
          source: 'evaluation',
          trust: 'trusted',
          evidenceKind: 'objective',
          evidenceRef: input.evidenceRef,
          learningSubjectRef: JSON.stringify([subjectKind, subjectRef]),
          occurredAt: input.occurredAt,
          idempotencyKey: `evaluation-task-revision:${identity}`,
          ...(input.ruleId === undefined ? {} : { ruleId: input.ruleId }),
          ...(input.guidanceVersion === undefined
            ? {} : { guidanceVersion: input.guidanceVersion }),
        })
      }
      this.#database.prepare(`
        INSERT INTO evolution_task_learning_revisions(
          scope_key, scope_watermark, subject_kind, subject_ref, version, digest, disposition,
          situation, episode_id, applied_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        scopeKey, input.scopeWatermark, subjectKind, subjectRef, input.version, projectionDigest,
        input.disposition, situation, storedEpisode?.id ?? null, now,
      )
      this.#database.prepare(`
        INSERT INTO evolution_task_learning_state(
          scope_key, scope_watermark, subject_kind, subject_ref, version, digest, disposition,
          situation, episode_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_key, subject_kind, subject_ref) DO UPDATE SET
          scope_watermark = excluded.scope_watermark,
          version = excluded.version,
          digest = excluded.digest,
          disposition = excluded.disposition,
          situation = excluded.situation,
          episode_id = excluded.episode_id,
          updated_at = excluded.updated_at
      `).run(
        scopeKey, input.scopeWatermark, subjectKind, subjectRef, input.version, projectionDigest,
        input.disposition, situation, storedEpisode?.id ?? null, now,
      )
      this.#recordScopeLearningWatermark(scopeKey, input.scopeWatermark, now)

      // Any evidence-dependent card for this exact scoped situation was built
      // from an older complete window.  Fence it before a later Policy decision
      // can apply stale guidance. Owner-undo is independent of learning data.
      const affected = this.#database.prepare(`
        SELECT * FROM evolution_proposals
        WHERE status = 'pending' AND scope_key = ?
          AND json_extract(mutation_json, '$.op') IN ('adopt', 'retire')
          AND COALESCE(
            json_extract(mutation_json, '$.input.situation'),
            json_extract(mutation_json, '$.situation')
          ) = ?
        ORDER BY id
      `).all(scopeKey, situation) as unknown as ProposalRow[]
      this.#database.prepare(`
        UPDATE evolution_proposals
        SET status = 'conflicted', version = version + 1, updated_at = ?
        WHERE status = 'pending' AND scope_key = ?
          AND json_extract(mutation_json, '$.op') IN ('adopt', 'retire')
          AND COALESCE(
            json_extract(mutation_json, '$.input.situation'),
            json_extract(mutation_json, '$.situation')
          ) = ?
      `).run(now, scopeKey, situation)
      for (const pending of affected) {
        const terminal = this.#requireProposal(pending.id)
        this.#recordEvolutionApplicationReceipt(terminal)
      }

      // A correction to an exact subject that justified an already-applied
      // local rule wins after that legal linearization point as well. Retire
      // only rules whose frozen full tuple contained this subject; unrelated
      // new evidence does not churn active guidance.
      this.#retireRulesDependingOnTaskRevision({
        scopeKey,
        subjectKind,
        subjectRef,
        now,
      })

      const saved = this.#database.prepare(`
        SELECT * FROM evolution_task_learning_state
        WHERE scope_key = ? AND subject_kind = ? AND subject_ref = ?
      `).get(scopeKey, subjectKind, subjectRef) as unknown as TaskLearningProjectionRow
      this.#assertTaskLearningState(saved)
      result = Object.freeze({
        projection: taskLearningProjection(saved),
        ...(storedEpisode === undefined ? {} : { episode: storedEpisode }),
        replayed: false,
      })
      this.#database.exec('COMMIT')
      return result
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  getTaskLearningProjection(input: {
    scopeKey: string
    subjectKind: 'automation-run' | 'outcome'
    subjectRef: string
  }): StoredTaskLearningProjection | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM evolution_task_learning_state
      WHERE scope_key = ? AND subject_kind = ? AND subject_ref = ?
    `).get(
      this.#scopeKey(input.scopeKey),
      input.subjectKind,
      this.#opaque(input.subjectRef, 'subjectRef', 1_000),
    ) as unknown as TaskLearningProjectionRow | undefined
    if (row === undefined) return undefined
    this.#assertTaskLearningState(row)
    return taskLearningProjection(row)
  }

  #sameLearningSubjectResult(row: EpisodeRow, input: NormalizedEpisodeWrite): boolean {
    // evidenceRef, detail, and evidenceKind are deliberately absent: several
    // immutable Evaluation rows (for example objective + verification) may
    // independently reach the same behavioural result for one immutable run.
    // The first row remains the provenance anchor; behavioural identity,
    // attribution, outcome, and run time must still match.
    return row.scope_key === input.scopeKey
      && row.learning_subject_ref === input.learningSubjectRef
      && row.situation === input.situation
      && row.outcome === input.outcome
      && row.source === input.source
      && row.trust === input.trust
      && row.learning_eligible === input.learningEligible
      && (row.rule_id ?? undefined) === input.ruleId
      && (row.guidance_version ?? undefined) === input.guidanceVersion
      && (row.claimed_rule_id ?? undefined) === input.claimedRuleId
      && row.occurred_at === input.occurredAt
  }

  #assertTaskLearningState(row: TaskLearningProjectionRow): void {
    const revision = this.#database.prepare(`
      SELECT scope_key, scope_watermark, subject_kind, subject_ref, version, digest, disposition,
        situation, episode_id, applied_at AS updated_at
      FROM evolution_task_learning_revisions
      WHERE scope_key = ? AND subject_kind = ? AND subject_ref = ? AND version = ?
    `).get(
      row.scope_key, row.subject_kind, row.subject_ref, row.version,
    ) as unknown as TaskLearningProjectionRow | undefined
    if (revision === undefined || revision.digest !== row.digest
      || revision.disposition !== row.disposition || revision.situation !== row.situation
      || revision.episode_id !== row.episode_id) {
      throw new EvolutionStoreError(
        'invalid-state',
        'task learning current state does not match its immutable revision',
      )
    }
    if (row.disposition === 'retract') {
      if (row.episode_id !== null) {
        throw new EvolutionStoreError('invalid-state', 'retracted task learning state has an active vote')
      }
      return
    }
    if (row.episode_id === null) {
      throw new EvolutionStoreError('invalid-state', 'upserted task learning state is missing its vote')
    }
    const active = this.#database.prepare('SELECT * FROM evolution_episodes WHERE id = ?')
      .get(row.episode_id) as unknown as EpisodeRow | undefined
    if (active === undefined || active.scope_key !== row.scope_key || active.situation !== row.situation
      || active.learning_eligible !== 1
      || active.learning_subject_ref !== JSON.stringify([row.subject_kind, row.subject_ref])) {
      throw new EvolutionStoreError('invalid-state', 'task learning vote does not match current state')
    }
  }

  /** Must be called under this store's writer transaction. */
  #recordScopeLearningWatermark(scopeKey: string, watermark: number, now: number): void {
    this.#database.prepare(`
      INSERT INTO evolution_scope_learning_watermarks(scope_key, watermark, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(scope_key) DO UPDATE SET
        watermark = excluded.watermark,
        updated_at = excluded.updated_at
      WHERE excluded.watermark >= evolution_scope_learning_watermarks.watermark
    `).run(scopeKey, watermark, now)
    const saved = this.#database.prepare(`
      SELECT watermark FROM evolution_scope_learning_watermarks WHERE scope_key = ?
    `).get(scopeKey) as { watermark: number } | undefined
    if (saved?.watermark !== watermark) {
      throw new EvolutionStoreError(
        'version-conflict',
        'Evaluation scope watermark moved backwards',
      )
    }
  }

  /** Must be called after the new task state is durable in the current writer transaction. */
  #retireRulesDependingOnTaskRevision(input: {
    scopeKey: string
    subjectKind: 'automation-run' | 'outcome'
    subjectRef: string
    now: number
  }): void {
    const rows = this.#database.prepare(`
      SELECT rule.*
      FROM evolution_proposals proposal
      JOIN evolution_rules rule ON rule.id = proposal.result_rule_id
      JOIN json_each(proposal.mutation_json, '$.evidence.taskRevisions') revision
      WHERE proposal.status = 'approved'
        AND proposal.scope_key = ?
        AND json_extract(proposal.mutation_json, '$.op') = 'adopt'
        AND rule.status = 'active'
        AND json_extract(revision.value, '$.subjectKind') = ?
        AND json_extract(revision.value, '$.subjectRef') = ?
      ORDER BY rule.id
    `).all(input.scopeKey, input.subjectKind, input.subjectRef) as unknown as RuleRow[]
    for (const row of rows) {
      const reason = 'Automatic safe rollback: authoritative Evaluation evidence '
        + `${input.subjectKind}:${input.subjectRef} changed after adoption.`
      const version = row.version + 1
      const retired = this.#database.prepare(`
        UPDATE evolution_rules
        SET status = 'retired', retired_reason = ?, updated_at = ?, version = ?
        WHERE id = ? AND status = 'active' AND version = ?
      `).run(reason, input.now, version, row.id, row.version)
      if (retired.changes === 1) {
        this.#audit('evidence-correction-rollback', row.id, version, input.now)
      }
    }
  }

  /** Failure counts over the most recent explicitly quality-eligible episodes. */
  stats(scopeKey: string, situation: string, window: number): SituationStats {
    const scope = this.#scopeKey(scopeKey)
    const label = this.#situation(situation)
    this.#requireWindow(window)
    const row = this.#database.prepare(`
      SELECT COUNT(*) AS total, SUM(outcome = 'failed') AS failures FROM (
        SELECT outcome FROM evolution_episodes
        WHERE scope_key = ? AND situation = ? AND learning_eligible = 1 AND rule_id IS NULL
        ORDER BY occurred_at DESC, id DESC LIMIT ?
      )
    `).get(scope, label, window) as { total: number; failures: number | null }
    return Object.freeze({ scopeKey: scope, situation: label, failures: row.failures ?? 0, total: row.total })
  }

  listRules(scopeKey: string, status?: 'active' | 'retired'): StoredRule[] {
    const scope = this.#scopeKey(scopeKey)
    const rows = this.#database.prepare(`
      SELECT * FROM evolution_rules
      WHERE scope_key = ? AND (? IS NULL OR status = ?)
      ORDER BY situation, adopted_at
    `).all(scope, status ?? null, status ?? null) as unknown as RuleRow[]
    return rows.map(row => rule(row))
  }

  getRule(ruleId: string): StoredRule | undefined {
    const row = this.#database.prepare('SELECT * FROM evolution_rules WHERE id = ?')
      .get(ruleId) as unknown as RuleRow | undefined
    return row === undefined ? undefined : rule(row)
  }

  /** Principal whose exact approved adoption created this immutable rule. */
  ruleApprovalPrincipal(ruleId: string): string | undefined {
    const id = this.#serverRuleId(ruleId)
    const rows = this.#database.prepare(`
      SELECT principal FROM evolution_proposals
      WHERE result_rule_id = ? AND status = 'approved'
        AND json_extract(mutation_json, '$.op') = 'adopt'
      ORDER BY id LIMIT 2
    `).all(id) as unknown as Array<{ principal: string }>
    return rows.length === 1 ? rows[0]!.principal : undefined
  }

  activeRule(scopeKey: string, situation: string): StoredRule | undefined {
    const row = this.#database.prepare(
      "SELECT * FROM evolution_rules WHERE scope_key = ? AND situation = ? AND status = 'active'",
    ).get(this.#scopeKey(scopeKey), this.#situation(situation)) as unknown as RuleRow | undefined
    return row === undefined ? undefined : rule(row)
  }

  nextGeneration(scopeKey: string, situation: string): number {
    const row = this.#database.prepare(`
      SELECT MAX(generation) AS generation FROM evolution_rules
      WHERE scope_key = ? AND situation = ?
    `).get(this.#scopeKey(scopeKey), this.#situation(situation)) as { generation: number | null }
    return (row.generation ?? 0) + 1
  }

  /** Persist proof only after the corresponding guidance injection returned. */
  recordGuidanceExposure(input: {
    sessionId: string
    scopeKey: string
    situation: string
    ruleId: string
    guidanceVersion: number
  }): GuidanceExposure {
    const sessionId = this.#opaque(input.sessionId, 'sessionId', 500)
    const scopeKey = this.#scopeKey(input.scopeKey)
    const situation = this.#situation(input.situation)
    const ruleId = this.#bounded(input.ruleId, 'ruleId', 200)
    if (!Number.isSafeInteger(input.guidanceVersion) || input.guidanceVersion < 1
      || input.guidanceVersion > 1_000_000_000) {
      throw new EvolutionStoreError('invalid-input', 'guidanceVersion must be a positive safe integer')
    }
    const rule = this.getRule(ruleId)
    if (rule === undefined || rule.scopeKey !== scopeKey || rule.situation !== situation
      || rule.generation !== input.guidanceVersion) {
      throw new EvolutionStoreError('invalid-state', 'guidance exposure does not match an immutable scoped rule')
    }
    const exposedAt = this.#now()
    this.#database.prepare(`
      INSERT INTO evolution_guidance_exposures(
        session_id, scope_key, situation, rule_id, guidance_version, exposed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, scope_key, rule_id, guidance_version) DO NOTHING
    `).run(sessionId, scopeKey, situation, ruleId, input.guidanceVersion, exposedAt)
    const row = this.#database.prepare(`
      SELECT * FROM evolution_guidance_exposures
      WHERE session_id = ? AND scope_key = ? AND rule_id = ? AND guidance_version = ?
    `).get(sessionId, scopeKey, ruleId, input.guidanceVersion) as unknown as GuidanceExposureRow
    if (row.situation !== situation) {
      throw new EvolutionStoreError('idempotency-conflict', 'guidance exposure identity was reused for another situation')
    }
    return guidanceExposure(row)
  }

  hasGuidanceExposure(
    sessionId: string,
    scopeKey: string,
    ruleId: string,
    guidanceVersion: number,
  ): boolean {
    const row = this.#database.prepare(`
      SELECT 1 AS present FROM evolution_guidance_exposures
      WHERE session_id = ? AND scope_key = ? AND rule_id = ? AND guidance_version = ?
    `).get(
      this.#opaque(sessionId, 'sessionId', 500),
      this.#scopeKey(scopeKey),
      this.#bounded(ruleId, 'ruleId', 200),
      guidanceVersion,
    ) as { present: 1 } | undefined
    return row !== undefined
  }

  countGuidanceExposures(sessionId: string, scopeKey: string): number {
    const row = this.#database.prepare(`
      SELECT COUNT(*) AS count FROM evolution_guidance_exposures
      WHERE session_id = ? AND scope_key = ?
    `).get(
      this.#opaque(sessionId, 'sessionId', 500),
      this.#scopeKey(scopeKey),
    ) as { count: number }
    return row.count
  }

  /** Return only an unambiguous exact-situation receipt for one session. */
  captureGuidanceExposure(
    sessionId: string,
    scopeKey: string,
    situation: string,
  ): GuidanceExposure | undefined {
    const rows = this.#database.prepare(`
      SELECT * FROM evolution_guidance_exposures
      WHERE session_id = ? AND scope_key = ? AND situation = ?
      ORDER BY exposed_at, rule_id, guidance_version
      LIMIT 2
    `).all(
      this.#opaque(sessionId, 'sessionId', 500),
      this.#scopeKey(scopeKey),
      this.#situation(situation),
    ) as unknown as GuidanceExposureRow[]
    return rows.length === 1 ? guidanceExposure(rows[0]!) : undefined
  }

  /**
   * Compute candidate rule changes from recorded evidence.
   *
   * This is the only place learning is inferred, and it deliberately stops at a
   * *candidate*. Two directions are detected:
   *
   * - `adopt`: a situation fails often enough, with a large enough sample, and has
   *   no active rule yet.
   * - `retire`: an active rule's situation is not doing better than the baseline
   *   it was adopted against, so the rule is not earning its place.
   *
   * A rule is never revised in place. Revision would silently rewrite behaviour
   * under an old approval, so a change is always retire-then-adopt, each with its
   * own decision.
   */
  candidates(options: {
    scopeKey: string
    window: number
    minSample: number
    adoptFailureRate: number
    retireFailureRate: number
    limit: number
    evidenceSampleLimit?: number
  }): RuleCandidate[] {
    const scopeKey = this.#scopeKey(options.scopeKey)
    this.#requireWindow(options.window)
    if (!Number.isSafeInteger(options.minSample) || options.minSample < 1) {
      throw new EvolutionStoreError('invalid-input', 'minSample must be a positive safe integer')
    }
    for (const [field, value] of [
      ['adoptFailureRate', options.adoptFailureRate],
      ['retireFailureRate', options.retireFailureRate],
    ] as const) {
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new EvolutionStoreError('invalid-input', `${field} must be within 0 and 1`)
      }
    }
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw new EvolutionStoreError('invalid-input', 'candidate limit must be between 1 and 100')
    }
    const evidenceSampleLimit = options.evidenceSampleLimit ?? 8
    if (!Number.isSafeInteger(evidenceSampleLimit)
      || evidenceSampleLimit < 1 || evidenceSampleLimit > 50) {
      throw new EvolutionStoreError('invalid-input', 'evidence sample limit must be between 1 and 50')
    }
    const situations = this.#database.prepare(`
      SELECT DISTINCT situation FROM evolution_episodes
      WHERE scope_key = ? AND learning_eligible = 1
      ORDER BY situation
    `).all(scopeKey) as unknown as { situation: string }[]
    const candidates: RuleCandidate[] = []
    for (const { situation } of situations) {
      if (candidates.length >= options.limit) break
      const active = this.activeRule(scopeKey, situation)
      const episodes = active === undefined
        ? this.#adoptionEpisodes(scopeKey, situation, options.window)
        : this.#evaluationEpisodes(active, options.window)
      const stats = this.#statsFromEpisodes(scopeKey, situation, episodes)
      if (stats.total < options.minSample) continue
      const provenance = this.#candidateEvidence(episodes, evidenceSampleLimit)
      const rate = stats.failures / stats.total
      if (active === undefined) {
        if (rate < options.adoptFailureRate) continue
        candidates.push(Object.freeze({
          scopeKey,
          situation,
          kind: 'adopt' as const,
          stats,
          ...provenance,
          rationale: `${stats.failures}/${stats.total} recent attempts failed and no rule is active`,
        }))
        continue
      }
      const retirement = this.#retirementCandidateFromRule(
        active,
        options.window,
        options.minSample,
        options.retireFailureRate,
        evidenceSampleLimit,
      )
      if (retirement !== undefined) candidates.push(retirement)
    }
    return candidates
  }

  /** Compute the candidate for one exact active rule, independent of list limits. */
  retirementCandidate(options: {
    scopeKey: string
    ruleId: string
    window: number
    minSample: number
    retireFailureRate: number
    evidenceSampleLimit?: number
  }): RuleCandidate | undefined {
    const scopeKey = this.#scopeKey(options.scopeKey)
    const ruleId = this.#bounded(options.ruleId, 'ruleId', 200)
    this.#requireWindow(options.window)
    if (!Number.isSafeInteger(options.minSample) || options.minSample < 1) {
      throw new EvolutionStoreError('invalid-input', 'minSample must be a positive safe integer')
    }
    if (!Number.isFinite(options.retireFailureRate)
      || options.retireFailureRate < 0 || options.retireFailureRate > 1) {
      throw new EvolutionStoreError('invalid-input', 'retireFailureRate must be within 0 and 1')
    }
    const evidenceSampleLimit = options.evidenceSampleLimit ?? 8
    if (!Number.isSafeInteger(evidenceSampleLimit)
      || evidenceSampleLimit < 1 || evidenceSampleLimit > 50) {
      throw new EvolutionStoreError('invalid-input', 'evidence sample limit must be between 1 and 50')
    }
    const active = this.getRule(ruleId)
    if (active === undefined || active.scopeKey !== scopeKey || active.status !== 'active') return undefined
    return this.#retirementCandidateFromRule(
      active,
      options.window,
      options.minSample,
      options.retireFailureRate,
      evidenceSampleLimit,
    )
  }

  /**
   * Freeze the one adoption candidate shown to an exact production analyst
   * execution. Repeating review in the same occurrence returns the same opaque
   * token; if its evidence changed, the old execution is fenced instead.
   */
  registerSupervisedGrowthAnalystReview(input: {
    scopeKey: string
    occurrenceId: string
    candidate: RuleCandidate
    evidenceWindow: number
  }): Readonly<{
    review: StoredSupervisedGrowthAnalystReview
    proposalExists: boolean
  }> {
    const scopeKey = this.#scopeKey(input.scopeKey)
    const occurrenceId = this.#opaque(input.occurrenceId, 'occurrenceId', 500)
    const evidence = this.#normalizeSupervisedGrowthAnalystEvidence(
      scopeKey,
      input.candidate,
      input.evidenceWindow,
    )
    const reviewToken = `analyst-review-${randomUUID()}`
    const sampleJson = JSON.stringify(evidence.sampleEpisodeIds)
    const evidenceJson = JSON.stringify(evidence.evidence)
    const taskRevisionsJson = JSON.stringify(evidence.taskRevisions)
    let row!: SupervisedGrowthAnalystReviewRow
    let proposalExists = false

    this.#database.exec('BEGIN IMMEDIATE')
    try {
      if (!this.#supervisedGrowthAnalystEvidenceMatches(scopeKey, evidence)) {
        throw new EvolutionStoreError(
          'version-conflict',
          'analyst review evidence changed before it could be frozen',
        )
      }
      const existing = this.#database.prepare(`
        SELECT * FROM evolution_supervised_analyst_reviews
        WHERE scope_key = ? AND occurrence_id = ?
      `).get(scopeKey, occurrenceId) as unknown as SupervisedGrowthAnalystReviewRow | undefined
      if (existing === undefined) {
        const now = this.#now()
        this.#database.prepare(`
          INSERT INTO evolution_supervised_analyst_reviews(
            review_token, scope_key, occurrence_id, contract_version, situation,
            failures, total, evidence_digest, evidence_total, evidence_window,
            sample_episode_ids_json, evidence_json, scope_watermark, task_revisions_json,
            proposal_id, created_at, proposed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)
        `).run(
          reviewToken,
          scopeKey,
          occurrenceId,
          evidence.contractVersion,
          evidence.situation,
          evidence.failures,
          evidence.total,
          evidence.evidenceDigest,
          evidence.evidenceTotal,
          evidence.evidenceWindow,
          sampleJson,
          evidenceJson,
          evidence.scopeWatermark,
          taskRevisionsJson,
          now,
        )
        row = this.#database.prepare(`
          SELECT * FROM evolution_supervised_analyst_reviews WHERE review_token = ?
        `).get(reviewToken) as unknown as SupervisedGrowthAnalystReviewRow
      } else {
        if (!this.#sameSupervisedGrowthAnalystReview(
          existing,
          evidence,
          sampleJson,
          evidenceJson,
          taskRevisionsJson,
        )) {
          throw new EvolutionStoreError(
            'version-conflict',
            'one analyst execution cannot review more than one evidence identity',
          )
        }
        row = existing
      }

      const key = supervisedGrowthAnalystProposalIdempotencyKey({
        scopeKey,
        situation: evidence.situation,
        evidenceDigest: evidence.evidenceDigest,
        evidenceTotal: evidence.evidenceTotal,
        contractVersion: evidence.contractVersion,
      })
      const winner = this.#database.prepare(`
        SELECT * FROM evolution_proposals WHERE idempotency_key = ?
      `).get(key) as unknown as ProposalRow | undefined
      if (winner !== undefined && !this.#supervisedGrowthAnalystProposalMatches(winner, evidence)) {
        throw new EvolutionStoreError('invalid-state', 'analyst proposal identity points to invalid content')
      }
      if (row.proposal_id !== null && winner?.id !== row.proposal_id) {
        throw new EvolutionStoreError('invalid-state', 'analyst execution points to another proposal')
      }
      proposalExists = winner !== undefined
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
    return Object.freeze({ review: supervisedGrowthAnalystReview(row), proposalExists })
  }

  getSupervisedGrowthAnalystReview(reviewToken: string): StoredSupervisedGrowthAnalystReview | undefined {
    const token = this.#analystReviewToken(reviewToken)
    const row = this.#database.prepare(`
      SELECT * FROM evolution_supervised_analyst_reviews WHERE review_token = ?
    `).get(token) as unknown as SupervisedGrowthAnalystReviewRow | undefined
    return row === undefined ? undefined : supervisedGrowthAnalystReview(row)
  }

  /**
   * Create or join the proposal for one evidence identity under the SQLite
   * writer lock. The existing proposal is deliberately returned without
   * comparing guidance: the first committed wording is the durable winner.
   */
  createSupervisedGrowthAnalystProposal(input: {
    reviewToken: string
    scopeKey: string
    occurrenceId: string
    requester: string
    principal: string
    mutation: Extract<EvolutionMutation, { op: 'adopt' }>
    expiresAt: number
    creationIntent: EvolutionCreationInput
  }): Readonly<{ proposal: StoredProposal; replayed: boolean }> {
    const reviewToken = this.#analystReviewToken(input.reviewToken)
    const scopeKey = this.#scopeKey(input.scopeKey)
    const occurrenceId = this.#opaque(input.occurrenceId, 'occurrenceId', 500)
    const requester = this.#bounded(input.requester, 'requester', 200)
    const principal = this.#bounded(input.principal, 'principal', 500)
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt < 0) {
      throw new EvolutionStoreError('invalid-input', 'proposal expiresAt must be a non-negative safe integer')
    }
    const mutation = this.#validateStoredMutation(input.mutation)
    if (mutation.op !== 'adopt' || mutation.evidence === undefined
      || mutation.input.scopeKey !== scopeKey) {
      throw new EvolutionStoreError('invalid-input', 'analyst may only create an evidence-bound adoption')
    }
    const key = supervisedGrowthAnalystProposalIdempotencyKey({
      scopeKey,
      situation: mutation.input.situation,
      evidenceDigest: mutation.evidence.digest,
      evidenceTotal: mutation.evidence.total,
      contractVersion: SUPERVISED_GROWTH_ANALYST_CONTRACT_VERSION,
    })
    const creationIntent = this.#validateCreationIntent(input.creationIntent, {
      key,
      requester,
      principal,
    })
    const creationIntentJson = JSON.stringify(creationIntent)
    const mutationJson = JSON.stringify(mutation)
    const mutationHash = digest(mutation)
    const id = `evolution-proposal-${randomUUID()}`
    let winner!: ProposalRow
    let replayed = false

    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const review = this.#database.prepare(`
        SELECT * FROM evolution_supervised_analyst_reviews WHERE review_token = ?
      `).get(reviewToken) as unknown as SupervisedGrowthAnalystReviewRow | undefined
      if (review === undefined || review.scope_key !== scopeKey
        || review.occurrence_id !== occurrenceId) {
        throw new EvolutionStoreError(
          'not-found',
          'analyst review token does not belong to this production execution',
        )
      }
      const evidence = supervisedGrowthAnalystReview(review).evidence
      if (!this.#supervisedGrowthAnalystMutationMatches(mutation, evidence)
        || !this.#proposalEvidenceMatches(mutation)) {
        throw new EvolutionStoreError(
          'version-conflict',
          'analyst proposal evidence no longer matches the frozen review',
        )
      }

      const existing = this.#database.prepare(`
        SELECT * FROM evolution_proposals WHERE idempotency_key = ?
      `).get(key) as unknown as ProposalRow | undefined
      if (review.proposal_id !== null) {
        if (existing?.id !== review.proposal_id) {
          throw new EvolutionStoreError('invalid-state', 'analyst execution proposal binding is corrupt')
        }
        winner = existing
        replayed = true
      } else if (existing !== undefined) {
        winner = existing
        replayed = true
      } else {
        const now = this.#now()
        this.#database.prepare(`
          INSERT INTO evolution_proposals(
            id, policy_proposal_id, idempotency_key, requester, principal, scope_key, mutation_hash,
            mutation_json, creation_intent_json, settlement_expectation_json,
            status, expires_at, created_at, updated_at, version)
          VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?, ?, 1)
        `).run(
          id,
          key,
          requester,
          principal,
          scopeKey,
          mutationHash,
          mutationJson,
          creationIntentJson,
          input.expiresAt,
          now,
          now,
        )
        winner = this.#database.prepare(`
          SELECT * FROM evolution_proposals WHERE idempotency_key = ?
        `).get(key) as unknown as ProposalRow
      }
      if (!this.#supervisedGrowthAnalystProposalMatches(winner, evidence)) {
        throw new EvolutionStoreError('invalid-state', 'analyst proposal winner does not match its evidence identity')
      }
      const proposedAt = this.#now()
      const linked = this.#database.prepare(`
        UPDATE evolution_supervised_analyst_reviews
        SET proposal_id = ?, proposed_at = COALESCE(proposed_at, ?)
        WHERE review_token = ? AND proposal_id IS NULL
      `).run(winner.id, proposedAt, reviewToken)
      if (linked.changes === 0 && review.proposal_id !== winner.id) {
        throw new EvolutionStoreError('invalid-state', 'analyst execution already proposed another change')
      }
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
    return Object.freeze({ proposal: proposal(winner), replayed })
  }

  /**
   * Retire one exact active guidance generation through the narrow autonomous
   * rollback lane.
   *
   * Eligibility is recomputed after `BEGIN IMMEDIATE`, then the rule update,
   * immutable evidence receipt and audit row commit together. The caller owns
   * only the exact target and expected version; risk, reason and evidence are
   * Host-derived. A replay of that exact tuple returns the durable winner.
   */
  rollbackRule(options: {
    scopeKey: string
    ruleId: string
    expectedVersion: number
    window: number
    minSample: number
    retireFailureRate: number
    evidenceSampleLimit?: number
  }): { rollback: StoredAutonomousRollback; rule: StoredRule; replayed: boolean } {
    const scopeKey = this.#scopeKey(options.scopeKey)
    const ruleId = this.#serverRuleId(options.ruleId)
    if (!Number.isSafeInteger(options.expectedVersion) || options.expectedVersion < 1
      || options.expectedVersion > 1_000_000_000) {
      throw new EvolutionStoreError('invalid-input', 'expectedVersion must be a positive safe integer')
    }
    this.#requireWindow(options.window)
    if (!Number.isSafeInteger(options.minSample) || options.minSample < 1) {
      throw new EvolutionStoreError('invalid-input', 'minSample must be a positive safe integer')
    }
    if (!Number.isFinite(options.retireFailureRate)
      || options.retireFailureRate < 0 || options.retireFailureRate > 1) {
      throw new EvolutionStoreError('invalid-input', 'retireFailureRate must be within 0 and 1')
    }
    const evidenceSampleLimit = options.evidenceSampleLimit ?? 8
    if (!Number.isSafeInteger(evidenceSampleLimit)
      || evidenceSampleLimit < 1 || evidenceSampleLimit > 50) {
      throw new EvolutionStoreError('invalid-input', 'evidence sample limit must be between 1 and 50')
    }
    const expectedVersion = options.expectedVersion
    const idempotencyKey = `rollback:${digest([scopeKey, ruleId, expectedVersion])}`
    let storedRollback: StoredAutonomousRollback | undefined
    let storedRule: StoredRule | undefined
    let replayed = false

    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.#database.prepare(`
        SELECT * FROM evolution_autonomous_rollbacks WHERE idempotency_key = ?
      `).get(idempotencyKey) as unknown as AutonomousRollbackRow | undefined
      if (previous !== undefined) {
        const existing = this.#database.prepare('SELECT * FROM evolution_rules WHERE id = ?')
          .get(ruleId) as unknown as RuleRow | undefined
        if (previous.scope_key !== scopeKey || previous.rule_id !== ruleId
          || previous.expected_version !== expectedVersion || existing === undefined
          || existing.scope_key !== scopeKey || existing.status !== 'retired'
          || existing.version !== previous.result_version
          || existing.retired_reason !== previous.reason) {
          throw new EvolutionStoreError('invalid-state', 'autonomous rollback receipt does not match the rule')
        }
        storedRollback = autonomousRollback(previous, existing.situation)
        storedRule = rule(existing)
        replayed = true
        this.#database.exec('COMMIT')
      } else {
        const existing = this.#database.prepare('SELECT * FROM evolution_rules WHERE id = ?')
          .get(ruleId) as unknown as RuleRow | undefined
        if (existing === undefined || existing.scope_key !== scopeKey) {
          throw new EvolutionStoreError('not-found', 'evolution rule was not found in the Agent scope')
        }
        if (existing.status !== 'active') {
          throw new EvolutionStoreError('invalid-state', 'evolution rule is not active')
        }
        if (existing.version !== expectedVersion) {
          throw new EvolutionStoreError('version-conflict', 'expectedVersion does not match the active rule')
        }

        const active = rule(existing)
        const episodes = this.#evaluationEpisodes(active, options.window)
        const evaluation = this.#statsFromEpisodes(scopeKey, existing.situation, episodes)
        const baseline = Object.freeze({
          scopeKey,
          situation: existing.situation,
          failures: existing.baseline_failures,
          total: existing.baseline_total,
        })
        const failureRate = evaluation.failures / evaluation.total
        const didNotImprove = evaluation.failures * baseline.total
          >= baseline.failures * evaluation.total
        if (evaluation.total < options.minSample
          || failureRate < options.retireFailureRate || !didNotImprove) {
          throw new EvolutionStoreError(
            'invalid-state',
            'autonomous rollback requires sufficient exact trusted post-exposure regression evidence',
          )
        }
        const provenance = this.#candidateEvidence(episodes, evidenceSampleLimit)
        const resultVersion = expectedVersion + 1
        const reason = 'Automatic low-risk rollback: exact trusted post-exposure failures '
          + `${evaluation.failures}/${evaluation.total} did not improve on adoption baseline `
          + `${baseline.failures}/${baseline.total}.`
        const now = this.#now()
        const updated = this.#database.prepare(`
          UPDATE evolution_rules
          SET status = 'retired', retired_reason = ?, updated_at = ?, version = ?
          WHERE id = ? AND scope_key = ? AND status = 'active' AND version = ?
        `).run(reason, now, resultVersion, ruleId, scopeKey, expectedVersion)
        if (updated.changes !== 1) {
          throw new EvolutionStoreError('version-conflict', 'active rule changed during autonomous rollback')
        }
        this.#database.prepare(`
          INSERT INTO evolution_autonomous_rollbacks(
            idempotency_key, scope_key, rule_id, expected_version, result_version,
            risk, reason, evaluation_failures, evaluation_total,
            baseline_failures, baseline_total, evidence_digest, evidence_total,
            sample_episode_ids_json, occurred_at)
          VALUES (?, ?, ?, ?, ?, 'low', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          idempotencyKey, scopeKey, ruleId, expectedVersion, resultVersion,
          reason, evaluation.failures, evaluation.total, baseline.failures, baseline.total,
          provenance.evidenceDigest, provenance.evidenceTotal,
          JSON.stringify(provenance.evidence.map(entry => entry.episodeId)), now,
        )
        this.#audit('rollback', ruleId, resultVersion, now)
        const persisted = this.#database.prepare(`
          SELECT * FROM evolution_autonomous_rollbacks WHERE idempotency_key = ?
        `).get(idempotencyKey) as unknown as AutonomousRollbackRow
        const updatedRule = this.#database.prepare('SELECT * FROM evolution_rules WHERE id = ?')
          .get(ruleId) as unknown as RuleRow
        storedRollback = autonomousRollback(persisted, updatedRule.situation)
        storedRule = rule(updatedRule)
        this.#database.exec('COMMIT')
      }
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }

    return { rollback: storedRollback!, rule: storedRule!, replayed }
  }

  #retirementCandidateFromRule(
    active: StoredRule,
    window: number,
    minSample: number,
    retireFailureRate: number,
    evidenceSampleLimit: number,
  ): RuleCandidate | undefined {
    const episodes = this.#evaluationEpisodes(active, window)
    const stats = this.#statsFromEpisodes(active.scopeKey, active.situation, episodes)
    if (stats.total < minSample) return undefined
    const rate = stats.failures / stats.total
    // An active rule must beat the baseline it was adopted against. Judging it
    // against a fixed threshold alone would keep a rule that made things worse.
    const baselineRate = active.baselineFailures / active.baselineTotal
    if (rate < retireFailureRate && rate <= baselineRate) return undefined
    const provenance = this.#candidateEvidence(episodes, evidenceSampleLimit)
    return Object.freeze({
      scopeKey: active.scopeKey,
      situation: active.situation,
      kind: 'retire' as const,
      stats,
      ruleId: active.id,
      ...provenance,
      baseline: Object.freeze({
        scopeKey: active.scopeKey,
        situation: active.situation,
        failures: active.baselineFailures,
        total: active.baselineTotal,
      }),
      rationale: `${stats.failures}/${stats.total} recent attempts failed against a `
        + `${active.baselineFailures}/${active.baselineTotal} baseline, so the active rule is not helping`,
    })
  }

  #adoptionEpisodes(scopeKey: string, situation: string, window: number): CandidateEpisodeRow[] {
    const retired = this.#database.prepare(`
      SELECT updated_at FROM evolution_rules
      WHERE scope_key = ? AND situation = ? AND status = 'retired'
      ORDER BY generation DESC LIMIT 1
    `).get(scopeKey, situation) as { updated_at: number } | undefined
    if (retired === undefined) {
      return this.#database.prepare(`
        SELECT episode.*, state.subject_kind AS task_subject_kind,
          state.subject_ref AS task_subject_ref, state.version AS task_version,
          state.digest AS task_digest, state.disposition AS task_disposition
        FROM evolution_episodes episode
        JOIN evolution_task_learning_state state
          ON state.scope_key = episode.scope_key AND state.episode_id = episode.id
          AND state.disposition = 'upsert'
        WHERE episode.scope_key = ? AND episode.situation = ?
          AND episode.learning_eligible = 1 AND episode.rule_id IS NULL
        ORDER BY episode.occurred_at DESC, episode.id DESC LIMIT ?
      `).all(scopeKey, situation, window) as unknown as CandidateEpisodeRow[]
    }
    return this.#database.prepare(`
      SELECT episode.*, state.subject_kind AS task_subject_kind,
        state.subject_ref AS task_subject_ref, state.version AS task_version,
        state.digest AS task_digest, state.disposition AS task_disposition
      FROM evolution_episodes episode
      JOIN evolution_task_learning_state state
        ON state.scope_key = episode.scope_key AND state.episode_id = episode.id
        AND state.disposition = 'upsert'
      WHERE episode.scope_key = ? AND episode.situation = ?
        AND episode.learning_eligible = 1 AND episode.rule_id IS NULL
        AND episode.occurred_at > ?
      ORDER BY episode.occurred_at DESC, episode.id DESC LIMIT ?
    `).all(scopeKey, situation, retired.updated_at, window) as unknown as CandidateEpisodeRow[]
  }

  #evaluationEpisodes(active: StoredRule, window: number): CandidateEpisodeRow[] {
    return this.#database.prepare(`
      SELECT episode.*, state.subject_kind AS task_subject_kind,
        state.subject_ref AS task_subject_ref, state.version AS task_version,
        state.digest AS task_digest, state.disposition AS task_disposition
      FROM evolution_episodes episode
      JOIN evolution_task_learning_state state
        ON state.scope_key = episode.scope_key AND state.episode_id = episode.id
        AND state.disposition = 'upsert'
      WHERE episode.scope_key = ? AND episode.situation = ? AND episode.learning_eligible = 1
        AND episode.rule_id = ? AND episode.guidance_version = ? AND episode.occurred_at > ?
      ORDER BY episode.occurred_at DESC, episode.id DESC LIMIT ?
    `).all(
      active.scopeKey, active.situation, active.id, active.generation, active.adoptedAt, window,
    ) as unknown as CandidateEpisodeRow[]
  }

  #statsFromEpisodes(scopeKey: string, situation: string, episodes: readonly EpisodeRow[]): SituationStats {
    return Object.freeze({
      scopeKey,
      situation,
      failures: episodes.filter(row => row.outcome === 'failed').length,
      total: episodes.length,
    })
  }

  #candidateEvidence(episodes: readonly CandidateEpisodeRow[], sampleLimit: number): {
    evidence: readonly EvidenceSample[]
    evidenceDigest: string
    evidenceTotal: number
    scopeWatermark: number
    taskRevisions: readonly Readonly<{
      subjectKind: 'automation-run' | 'outcome'
      subjectRef: string
      version: number
      digest: string
      disposition: 'upsert'
    }>[]
  } {
    if (episodes.length < 1) {
      throw new EvolutionStoreError('invalid-state', 'candidate evidence window is empty')
    }
    const watermark = this.#database.prepare(`
      SELECT watermark FROM evolution_scope_learning_watermarks WHERE scope_key = ?
    `).get(episodes[0]!.scope_key) as { watermark: number } | undefined
    if (watermark === undefined || !Number.isSafeInteger(watermark.watermark)
      || watermark.watermark < 1) {
      throw new EvolutionStoreError('invalid-state', 'candidate has no authoritative scope watermark')
    }
    const taskRevisions = episodes.map(row => Object.freeze({
      subjectKind: row.task_subject_kind,
      subjectRef: row.task_subject_ref,
      version: row.task_version,
      digest: row.task_digest,
      disposition: 'upsert' as const,
    }))
    const evidence = episodes.slice(0, sampleLimit).map(row => Object.freeze({
      episodeId: row.id,
      outcome: row.outcome,
      evidenceKind: row.evidence_kind as 'objective' | 'verification',
      evidenceRef: row.evidence_ref!,
      detail: row.detail,
      occurredAt: row.occurred_at,
    }))
    // Hash the complete exact query window, including the fields that establish
    // scope, trust and attribution. Only a bounded projection is model-visible.
    const evidenceDigest = digest(episodes.map(row => ({
      episodeId: row.id,
      scopeKey: row.scope_key,
      situation: row.situation,
      outcome: row.outcome,
      detail: row.detail,
      source: row.source,
      trust: row.trust,
      evidenceKind: row.evidence_kind,
      evidenceRef: row.evidence_ref,
      learningEligible: row.learning_eligible,
      ruleId: row.rule_id,
      guidanceVersion: row.guidance_version,
      occurredAt: row.occurred_at,
      taskSubjectKind: row.task_subject_kind,
      taskSubjectRef: row.task_subject_ref,
      taskVersion: row.task_version,
      taskDigest: row.task_digest,
    })))
    return Object.freeze({
      evidence: Object.freeze(evidence),
      evidenceDigest,
      evidenceTotal: episodes.length,
      scopeWatermark: watermark.watermark,
      taskRevisions: Object.freeze(taskRevisions),
    })
  }

  // ---- proposals -----------------------------------------------------------

  createProposal(input: {
    idempotencyKey: string
    requester: string
    principal: string
    mutation: EvolutionMutation
    expiresAt: number
    creationIntent?: EvolutionCreationInput
  }): StoredProposal {
    const key = this.#bounded(input.idempotencyKey, 'idempotencyKey', 200)
    const normalized = this.#validateMutation(input.mutation)
    const requester = this.#bounded(input.requester, 'requester', 200)
    const principal = this.#bounded(input.principal, 'principal', 500)
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt < 0) {
      throw new EvolutionStoreError('invalid-input', 'proposal expiresAt must be a non-negative safe integer')
    }
    const creationIntent = input.creationIntent === undefined
      ? undefined
      : this.#validateCreationIntent(input.creationIntent, { key, requester, principal })
    const creationIntentJson = creationIntent === undefined ? null : JSON.stringify(creationIntent)
    const now = this.#now()
    const id = `evolution-proposal-${randomUUID()}`
    const mutation: EvolutionMutation = normalized.op === 'adopt' && normalized.ruleId === undefined
      ? { ...normalized, ruleId: `rule-${randomUUID()}` }
      : normalized
    const hash = digest(mutation)
    const scopeKey = mutation.op === 'adopt'
      ? mutation.input.scopeKey
      : mutation.op === 'owner-undo'
        ? mutation.scopeKey
        : (this.getRule(mutation.ruleId)?.scopeKey ?? legacyEvolutionScope)
    let winner: ProposalRow | undefined
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      winner = this.#database.prepare('SELECT * FROM evolution_proposals WHERE idempotency_key = ?')
        .get(key) as unknown as ProposalRow | undefined
      if (winner === undefined) {
        // Candidate selection happens before this method is called. Recompute the
        // complete frozen window under the writer lock so a concurrent task
        // revision cannot create a proposal from stale evidence.
        if (!this.#proposalEvidenceMatches(mutation)) {
          throw new EvolutionStoreError(
            'version-conflict',
            'proposal evidence changed before the immutable proposal could be created',
          )
        }
        this.#database.prepare(`
          INSERT INTO evolution_proposals(
            id, policy_proposal_id, idempotency_key, requester, principal, scope_key, mutation_hash,
            mutation_json, creation_intent_json, settlement_expectation_json,
            status, expires_at, created_at, updated_at, version)
          VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?, ?, 1)
        `).run(
          id, key, requester, principal, scopeKey, hash, JSON.stringify(mutation),
          creationIntentJson, input.expiresAt, now, now,
        )
        winner = this.#database.prepare('SELECT * FROM evolution_proposals WHERE idempotency_key = ?')
          .get(key) as unknown as ProposalRow
      }
      let winnerIntentMatches = false
      try {
        winnerIntentMatches = digest(this.#proposalIntent(this.#validateMutation(
          JSON.parse(winner.mutation_json) as EvolutionMutation,
        ))) === digest(this.#proposalIntent(normalized))
      } catch {
        winnerIntentMatches = false
      }
      if (!winnerIntentMatches || winner.requester !== requester
        || winner.principal !== principal || winner.scope_key !== scopeKey
        || winner.creation_intent_json !== creationIntentJson) {
        throw new EvolutionStoreError(
          'idempotency-conflict',
          'proposal idempotency key was reused with different content',
        )
      }
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
    return proposal(winner!)
  }

  attachPolicy(
    proposalId: string,
    policyProposalId: string,
    expectation?: EvolutionSettlementExpectation,
  ): StoredProposal {
    const policyId = this.#bounded(policyProposalId, 'policyProposalId', 200)
    let attached!: ProposalRow
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const initial = this.#requireProposal(proposalId)
      let expectationJson: string | null = null
      if (expectation !== undefined) {
        const intent = initial.creation_intent_json === null
          ? undefined
          : JSON.parse(initial.creation_intent_json) as EvolutionCreationIntent
        if (expectation.proposalId !== policyId
          || expectation.requester !== initial.requester
          || expectation.principal !== initial.principal
          || !Number.isSafeInteger(expectation.expiresAt) || expectation.expiresAt < 0
          || expectation.expectedVersion !== 1
          || intent === undefined
          || expectation.action !== intent.action
          || expectation.resource.kind !== intent.resource.kind
          || expectation.resource.id !== intent.resource.id
          || expectation.summary !== intent.summary
          || expectation.diff !== intent.diff) {
          throw new EvolutionStoreError('invalid-input', 'settlement expectation does not match local creation intent')
        }
        expectationJson = JSON.stringify(expectation)
      }
      this.#database.prepare(`
        UPDATE evolution_proposals
        SET policy_proposal_id = ?, settlement_expectation_json = ?,
            expires_at = ?, updated_at = ?
        WHERE id = ? AND policy_proposal_id IS NULL
      `).run(
        policyId,
        expectationJson,
        expectation?.expiresAt ?? initial.expires_at,
        this.#now(),
        proposalId,
      )
      attached = this.#requireProposal(proposalId)
      if (attached.policy_proposal_id !== policyId
        || attached.settlement_expectation_json !== expectationJson) {
        throw new EvolutionStoreError('invalid-state', 'proposal is already attached to a different policy proposal')
      }
      // Projection invalidation may have won while Policy was creating the
      // external card. Attach the exact id anyway and atomically create its
      // terminal application receipt so the card is updated in place.
      this.#recordEvolutionApplicationReceipt(attached)
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
    return proposal(attached)
  }

  getProposal(proposalId: string): StoredProposal | undefined {
    const row = this.#database.prepare('SELECT * FROM evolution_proposals WHERE id = ?')
      .get(proposalId) as unknown as ProposalRow | undefined
    return row === undefined ? undefined : proposal(row)
  }

  getProposalByIdempotencyKey(idempotencyKey: string): StoredProposal | undefined {
    const key = this.#bounded(idempotencyKey, 'idempotencyKey', 200)
    const row = this.#database.prepare(
      'SELECT * FROM evolution_proposals WHERE idempotency_key = ?',
    ).get(key) as unknown as ProposalRow | undefined
    return row === undefined ? undefined : proposal(row)
  }

  listPendingProposals(limit: number): StoredProposal[] {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new EvolutionStoreError('invalid-input', 'pending proposal limit must be between 1 and 1000')
    }
    const rows = this.#database.prepare(`
      SELECT * FROM evolution_proposals WHERE status = 'pending'
      ORDER BY updated_at, id LIMIT ?
    `).all(limit) as unknown as ProposalRow[]
    return rows.map(row => proposal(row))
  }

  /**
   * Recover cross-database creation intents that may already own a Policy card
   * even when local evidence invalidation made the proposal terminal first.
   */
  listUnattachedProposalIntents(limit: number): StoredProposal[] {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new EvolutionStoreError('invalid-input', 'unattached proposal limit must be between 1 and 1000')
    }
    const rows = this.#database.prepare(`
      SELECT * FROM evolution_proposals
      WHERE policy_proposal_id IS NULL AND creation_intent_json IS NOT NULL
      ORDER BY updated_at, id LIMIT ?
    `).all(limit) as unknown as ProposalRow[]
    return rows.map(row => proposal(row))
  }

  /**
   * Policy has authoritatively confirmed that an expired unattached intent did
   * not create a proposal.  Drop only that now-useless recovery payload so the
   * terminal local conflict is not rediscovered forever.
   */
  completeAbandonedProposalRecovery(proposalId: string): StoredProposal {
    const id = this.#opaque(proposalId, 'proposalId', 200)
    const current = this.#requireProposal(id)
    if (current.policy_proposal_id !== null || current.status === 'pending') {
      throw new EvolutionStoreError(
        'invalid-state',
        'only a terminal unattached proposal can complete abandoned recovery',
      )
    }
    if (current.creation_intent_json === null) return proposal(current)
    const updated = this.#database.prepare(`
      UPDATE evolution_proposals SET creation_intent_json = NULL
      WHERE id = ? AND policy_proposal_id IS NULL AND status <> 'pending'
        AND creation_intent_json IS NOT NULL
    `).run(id)
    if (updated.changes !== 1) {
      throw new EvolutionStoreError('invalid-state', 'abandoned proposal recovery lost its update')
    }
    return proposal(this.#requireProposal(id))
  }

  getEvolutionApplicationReceipt(
    localProposalId: string,
  ): StoredEvolutionApplicationReceipt | undefined {
    const id = this.#opaque(localProposalId, 'localProposalId', 200)
    const row = this.#database.prepare(`
      SELECT * FROM evolution_application_receipts WHERE local_proposal_id = ?
    `).get(id) as unknown as EvolutionApplicationReceiptRow | undefined
    return row === undefined ? undefined : evolutionApplicationReceipt(row)
  }

  /** Independent terminal-presentation outbox; it never scans pending proposals. */
  listPendingEvolutionApplicationReceipts(
    limit: number,
  ): StoredEvolutionApplicationOutboxEntry[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new EvolutionStoreError('invalid-input', 'application outbox limit must be between 1 and 1000')
    }
    const rows = this.#database.prepare(`
      SELECT receipt.*, outbox.state, outbox.attempt_count, outbox.updated_at,
        outbox.published_at, outbox.last_error
      FROM evolution_application_outbox outbox
      JOIN evolution_application_receipts receipt
        ON receipt.local_proposal_id = outbox.local_proposal_id
      WHERE outbox.state = 'pending'
      ORDER BY outbox.updated_at, outbox.local_proposal_id
      LIMIT ?
    `).all(limit) as unknown as EvolutionApplicationOutboxRow[]
    return rows.map(row => evolutionApplicationOutbox(row))
  }

  settleEvolutionApplicationPublication(input: {
    localProposalId: string
    receiptDigest: string
    outcome: 'published' | 'retry'
    error?: string
  }): StoredEvolutionApplicationOutboxEntry {
    const localProposalId = this.#opaque(input.localProposalId, 'localProposalId', 200)
    if (!/^[a-f0-9]{64}$/u.test(input.receiptDigest)) {
      throw new EvolutionStoreError('invalid-input', 'application receipt digest is invalid')
    }
    if (input.outcome !== 'published' && input.outcome !== 'retry') {
      throw new EvolutionStoreError('invalid-input', 'application publication outcome is invalid')
    }
    const error = input.error === undefined
      ? undefined
      : this.#rawBounded(input.error, 'application publication error', 500)
    if (input.outcome === 'published' && error !== undefined) {
      throw new EvolutionStoreError('invalid-input', 'published application receipt cannot carry an error')
    }
    const now = this.#now()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const receipt = this.#database.prepare(`
        SELECT * FROM evolution_application_receipts WHERE local_proposal_id = ?
      `).get(localProposalId) as unknown as EvolutionApplicationReceiptRow | undefined
      if (receipt === undefined || receipt.receipt_digest !== input.receiptDigest) {
        throw new EvolutionStoreError('idempotency-conflict', 'application publication receipt changed')
      }
      const current = this.#database.prepare(`
        SELECT * FROM evolution_application_outbox WHERE local_proposal_id = ?
      `).get(localProposalId) as {
        state: 'pending' | 'published'
      } | undefined
      if (current === undefined) {
        throw new EvolutionStoreError('invalid-state', 'application receipt has no durable outbox row')
      }
      if (current.state !== 'published') {
        this.#database.prepare(`
          UPDATE evolution_application_outbox
          SET state = ?, attempt_count = attempt_count + 1, updated_at = ?,
            published_at = ?, last_error = ?
          WHERE local_proposal_id = ? AND state = 'pending'
        `).run(
          input.outcome === 'published' ? 'published' : 'pending',
          now,
          input.outcome === 'published' ? now : null,
          error ?? null,
          localProposalId,
        )
      }
      this.#database.exec('COMMIT')
    } catch (failure) {
      this.#database.exec('ROLLBACK')
      throw failure
    }
    const row = this.#database.prepare(`
      SELECT receipt.*, outbox.state, outbox.attempt_count, outbox.updated_at,
        outbox.published_at, outbox.last_error
      FROM evolution_application_outbox outbox
      JOIN evolution_application_receipts receipt
        ON receipt.local_proposal_id = outbox.local_proposal_id
      WHERE outbox.local_proposal_id = ?
    `).get(localProposalId) as unknown as EvolutionApplicationOutboxRow
    return evolutionApplicationOutbox(row)
  }

  /** Move an inspected-but-still-pending row behind its peers, durably. */
  deferPendingProposal(proposalId: string): void {
    const now = this.#now()
    this.#database.prepare(`
      UPDATE evolution_proposals
      SET updated_at = CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END
      WHERE id = ?
    `).run(now, now, proposalId)
  }

  /**
   * Apply one already-terminal policy status inside a single transaction.
   *
   * Both the rule change and the proposal's own settlement commit together, so a
   * crash can never leave an approved-but-unapplied rule or an applied-but-pending
   * proposal. Conflicts downgrade to `conflicted` rather than discarding the
   * owner's decision.
   */
  settleProposal(input: {
    proposalId: string
    policyStatus?: Exclude<ProposalStatus, 'pending' | 'conflicted'>
    policyVersion?: number
    /** A shared-validator failure; never trust fields from the forged snapshot. */
    securityConflict?: boolean
    /** Policy tuple already validated by the caller; re-bound under this writer lock. */
    reviewExpectation?: EvolutionSettlementExpectation
  }): { proposal: StoredProposal; replayed: boolean; rule: StoredRule | undefined } {
    let replayed = false
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const row = this.#requireProposal(input.proposalId)
      if (row.status !== 'pending') {
        replayed = true
        this.#recordEvolutionApplicationReceipt(row)
        this.#database.exec('COMMIT')
      } else {
        let securityConflict = input.securityConflict === true
        if (!securityConflict && (input.policyStatus === undefined
          || !Number.isSafeInteger(input.policyVersion)
          || input.policyVersion! <= row.version)) {
          throw new EvolutionStoreError('invalid-input', 'policy settlement must advance the proposal version')
        }
        let mutation: EvolutionMutation | undefined
        if (!securityConflict) {
          try {
            mutation = this.#validateStoredMutation(JSON.parse(row.mutation_json) as EvolutionMutation)
            securityConflict = digest(mutation) !== row.mutation_hash
          } catch {
            securityConflict = true
          }
        }
        if (!securityConflict) {
          let persistedExpectation: EvolutionSettlementExpectation | undefined
          try {
            persistedExpectation = row.settlement_expectation_json === null
              ? undefined
              : JSON.parse(row.settlement_expectation_json) as EvolutionSettlementExpectation
          } catch {
            securityConflict = true
          }
          const suppliedExpectation = input.reviewExpectation
          if (!securityConflict && (persistedExpectation === undefined) !== (suppliedExpectation === undefined)) {
            securityConflict = true
          }
          if (!securityConflict && persistedExpectation !== undefined && suppliedExpectation !== undefined) {
            const review = evolutionMutationReview(mutation!)
            securityConflict = JSON.stringify(persistedExpectation) !== JSON.stringify(suppliedExpectation)
              || review.action !== suppliedExpectation.action
              || review.resource.kind !== suppliedExpectation.resource.kind
              || review.resource.id !== suppliedExpectation.resource.id
              || review.summary !== suppliedExpectation.summary
              || review.diff !== suppliedExpectation.diff
          }
        }
        const now = this.#now()
        let status: ProposalStatus = securityConflict ? 'conflicted' : input.policyStatus!
        let ruleId: string | undefined
        if (!securityConflict && input.policyStatus === 'approved') {
          const applied = this.#applyMutation(mutation!, row.scope_key, now)
          status = applied.status
          ruleId = applied.ruleId
        }
        const version = securityConflict ? row.version + 1 : input.policyVersion!
        const updated = this.#database.prepare(`
          UPDATE evolution_proposals
          SET status = ?, result_rule_id = ?, updated_at = ?, version = ?
          WHERE id = ? AND status = 'pending'
        `).run(status, ruleId ?? null, now, version, input.proposalId)
        if (updated.changes !== 1) {
          throw new EvolutionStoreError('invalid-state', 'pending proposal settlement lost its transaction lock')
        }
        this.#recordEvolutionApplicationReceipt(this.#requireProposal(input.proposalId))
        this.#database.exec('COMMIT')
      }
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
    const settled = this.#requireProposal(input.proposalId)
    return {
      proposal: proposal(settled),
      replayed,
      rule: settled.result_rule_id === null ? undefined : this.getRule(settled.result_rule_id),
    }
  }

  #backfillEvolutionApplicationReceipts(): void {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const rows = this.#database.prepare(`
        SELECT proposal.* FROM evolution_proposals proposal
        LEFT JOIN evolution_application_receipts receipt
          ON receipt.local_proposal_id = proposal.id
        WHERE proposal.status <> 'pending' AND proposal.policy_proposal_id IS NOT NULL
          AND receipt.local_proposal_id IS NULL
        ORDER BY proposal.updated_at, proposal.id
      `).all() as unknown as ProposalRow[]
      for (const row of rows) this.#recordEvolutionApplicationReceipt(row)
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  /** Must be called while the proposal/rule writer transaction is held. */
  #recordEvolutionApplicationReceipt(row: ProposalRow): void {
    if (row.status === 'pending' || row.policy_proposal_id === null) return

    // The receipt describes the atomic application result at the proposal's
    // terminal linearization point.  A later authoritative evidence correction
    // may legitimately retire that rule, so terminal replay must not rebuild
    // the old receipt from the rule's newer state.  Keep the immutable winner,
    // but still bind it to this exact local/Policy proposal pair so a swapped or
    // forged receipt cannot be accepted during recovery.
    const existing = this.#database.prepare(`
      SELECT * FROM evolution_application_receipts WHERE local_proposal_id = ?
    `).get(row.id) as unknown as EvolutionApplicationReceiptRow | undefined
    if (existing !== undefined) {
      if (existing.local_proposal_id !== row.id
        || existing.policy_proposal_id !== row.policy_proposal_id) {
        throw new EvolutionStoreError(
          'idempotency-conflict',
          'application receipt proposal binding changed after settlement',
        )
      }
      const immutable = {
        schemaVersion: 1,
        localProposalId: existing.local_proposal_id,
        policyProposalId: existing.policy_proposal_id,
        applicationStatus: existing.application_status,
        operation: existing.operation,
        terminalAt: existing.terminal_at,
        revision: existing.revision,
        ...(existing.rule_id === null ? {} : { ruleId: existing.rule_id }),
        ...(existing.resulting_rule_version === null
          ? {} : { resultingRuleVersion: existing.resulting_rule_version }),
        ...(existing.rule_status === null ? {} : { ruleStatus: existing.rule_status }),
      }
      if (existing.receipt_digest
        !== digest(['evolution-application-receipt/v1', immutable])) {
        throw new EvolutionStoreError(
          'idempotency-conflict',
          'application receipt payload changed after settlement',
        )
      }
      this.#database.prepare(`
        INSERT INTO evolution_application_outbox(
          local_proposal_id, state, attempt_count, updated_at, published_at, last_error)
        VALUES (?, 'pending', 0, ?, NULL, NULL)
        ON CONFLICT(local_proposal_id) DO NOTHING
      `).run(row.id, existing.terminal_at)
      return
    }

    const operation = this.#evolutionApplicationOperation(row)
    // An ancient or externally corrupted row with no recoverable operation is
    // not safe to present. Normal settlements always have a validated operation.
    if (operation === undefined) return
    const applicationStatus: EvolutionApplicationReceiptRow['application_status'] =
      row.status === 'approved' ? 'applied' : row.status
    if (applicationStatus !== 'applied' && applicationStatus !== 'conflicted'
      && applicationStatus !== 'expired' && applicationStatus !== 'rejected') return

    let targetRuleId = row.result_rule_id ?? undefined
    if (targetRuleId === undefined) {
      try {
        const raw = JSON.parse(row.mutation_json) as { ruleId?: unknown }
        if (typeof raw.ruleId === 'string') targetRuleId = raw.ruleId
      } catch {
        // The operation may still be recoverable from the creation intent.
      }
    }
    const targetRule = targetRuleId === undefined
      ? undefined
      : this.#database.prepare('SELECT * FROM evolution_rules WHERE id = ?')
        .get(targetRuleId) as unknown as RuleRow | undefined
    if (applicationStatus === 'applied' && targetRule === undefined) {
      throw new EvolutionStoreError(
        'invalid-state',
        'applied evolution proposal has no exact resulting rule state',
      )
    }
    const canonical = {
      schemaVersion: 1,
      localProposalId: row.id,
      policyProposalId: row.policy_proposal_id,
      applicationStatus,
      operation,
      terminalAt: row.updated_at,
      revision: Math.max(2, row.version),
      ...(targetRuleId === undefined ? {} : { ruleId: targetRuleId }),
      ...(targetRule === undefined ? {} : {
        resultingRuleVersion: targetRule.version,
        ruleStatus: targetRule.status,
      }),
    }
    const receiptDigest = digest(['evolution-application-receipt/v1', canonical])
    this.#database.prepare(`
      INSERT INTO evolution_application_receipts(
        local_proposal_id, policy_proposal_id, application_status, operation,
        terminal_at, receipt_digest, revision, rule_id, resulting_rule_version, rule_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(local_proposal_id) DO NOTHING
    `).run(
      canonical.localProposalId,
      canonical.policyProposalId,
      canonical.applicationStatus,
      canonical.operation,
      canonical.terminalAt,
      receiptDigest,
      canonical.revision,
      targetRuleId ?? null,
      targetRule?.version ?? null,
      targetRule?.status ?? null,
    )
    const saved = this.#database.prepare(`
      SELECT * FROM evolution_application_receipts WHERE local_proposal_id = ?
    `).get(row.id) as unknown as EvolutionApplicationReceiptRow
    const expected = evolutionApplicationReceipt({
      local_proposal_id: canonical.localProposalId,
      policy_proposal_id: canonical.policyProposalId,
      application_status: canonical.applicationStatus,
      operation: canonical.operation,
      terminal_at: canonical.terminalAt,
      receipt_digest: receiptDigest,
      revision: canonical.revision,
      rule_id: targetRuleId ?? null,
      resulting_rule_version: targetRule?.version ?? null,
      rule_status: targetRule?.status ?? null,
    })
    if (JSON.stringify(evolutionApplicationReceipt(saved)) !== JSON.stringify(expected)) {
      throw new EvolutionStoreError('idempotency-conflict', 'application receipt changed after settlement')
    }
    this.#database.prepare(`
      INSERT INTO evolution_application_outbox(
        local_proposal_id, state, attempt_count, updated_at, published_at, last_error)
      VALUES (?, 'pending', 0, ?, NULL, NULL)
      ON CONFLICT(local_proposal_id) DO NOTHING
    `).run(row.id, row.updated_at)
  }

  #evolutionApplicationOperation(
    row: ProposalRow,
  ): 'adopt' | 'owner-undo' | 'retire' | undefined {
    try {
      const mutation = JSON.parse(row.mutation_json) as { op?: unknown }
      if (mutation.op === 'adopt' || mutation.op === 'owner-undo' || mutation.op === 'retire') {
        return mutation.op
      }
    } catch {
      // Fall through to the immutable Policy creation intent.
    }
    try {
      const intent = row.creation_intent_json === null
        ? undefined
        : JSON.parse(row.creation_intent_json) as { action?: unknown }
      if (intent?.action === 'evolution.adopt') return 'adopt'
      if (intent?.action === 'evolution.owner-undo') return 'owner-undo'
      if (intent?.action === 'evolution.retire') return 'retire'
    } catch {
      return undefined
    }
    return undefined
  }

  #applyMutation(mutation: EvolutionMutation, proposalScopeKey: string, now: number): {
    status: ProposalStatus
    ruleId: string | undefined
  } {
    if (mutation.op === 'adopt') {
      const ruleId = mutation.ruleId
      if (ruleId === undefined || mutation.input.scopeKey !== proposalScopeKey
        || (mutation.evidence !== undefined
          && !this.#adoptionEvidenceMatches(mutation, mutation.evidence))) {
        return { status: 'conflicted', ruleId: undefined }
      }
      // A second active rule for the same situation would make injected guidance
      // self-contradictory, so the unique index is treated as a conflict.
      const conflict = this.#database.prepare(
        "SELECT id FROM evolution_rules WHERE scope_key = ? AND situation = ? AND status = 'active'",
      ).get(mutation.input.scopeKey, mutation.input.situation) as { id: string } | undefined
      if (conflict !== undefined) return { status: 'conflicted', ruleId: undefined }
      const generation = this.nextGeneration(mutation.input.scopeKey, mutation.input.situation)
      this.#database.prepare(`
        INSERT INTO evolution_rules(
          id, scope_key, situation, guidance, status, baseline_failures, baseline_total,
          adopted_at, updated_at, retired_reason, version, generation)
        VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, 1, ?)
      `).run(
        ruleId, mutation.input.scopeKey, mutation.input.situation, mutation.input.guidance,
        mutation.baseline.failures, mutation.baseline.total, now, now, generation,
      )
      this.#audit('adopt', ruleId, 1, now)
      return { status: 'approved', ruleId }
    }
    const existing = this.#database.prepare('SELECT * FROM evolution_rules WHERE id = ?')
      .get(mutation.ruleId) as unknown as RuleRow | undefined
    const evidenceMismatch = mutation.op === 'retire' && existing !== undefined && (
      mutation.scopeKey !== existing.scope_key
      || mutation.situation !== existing.situation
      || mutation.guidance !== existing.guidance
      || mutation.generation !== existing.generation
      || mutation.evaluation.scopeKey !== existing.scope_key
      || mutation.evaluation.situation !== existing.situation
      || mutation.baseline.scopeKey !== existing.scope_key
      || mutation.baseline.situation !== existing.situation
      || mutation.baseline.failures !== existing.baseline_failures
      || mutation.baseline.total !== existing.baseline_total
      || !this.#retirementEvidenceMatches(mutation, existing)
    )
    if (existing === undefined || existing.scope_key !== proposalScopeKey || existing.status !== 'active'
      || existing.version !== mutation.expectedVersion
      || (mutation.op === 'owner-undo' && (
        mutation.scopeKey !== proposalScopeKey
        || mutation.situation !== existing.situation
        || mutation.guidance !== existing.guidance
        || mutation.generation !== existing.generation))
      || evidenceMismatch) {
      return { status: 'conflicted', ruleId: undefined }
    }
    const version = existing.version + 1
    this.#database.prepare(`
      UPDATE evolution_rules
      SET status = 'retired', retired_reason = ?, updated_at = ?, version = ?
      WHERE id = ? AND version = ?
    `).run(mutation.reason, now, version, mutation.ruleId, mutation.expectedVersion)
    this.#audit(mutation.op === 'owner-undo' ? 'owner-undo' : 'retire', mutation.ruleId, version, now)
    return { status: 'approved', ruleId: mutation.ruleId }
  }

  #normalizeSupervisedGrowthAnalystEvidence(
    scopeKey: string,
    candidate: RuleCandidate,
    evidenceWindow: number,
  ): SupervisedGrowthAnalystEvidence {
    this.#requireWindow(evidenceWindow)
    if (candidate.kind !== 'adopt' || candidate.scopeKey !== scopeKey) {
      throw new EvolutionStoreError('invalid-input', 'analyst review requires one scoped adoption candidate')
    }
    const stats = this.#validateStats(candidate.stats, 'analyst candidate')
    const situation = this.#situation(candidate.situation)
    if (stats.scopeKey !== scopeKey || stats.situation !== situation
      || candidate.evidenceTotal !== stats.total || evidenceWindow < candidate.evidenceTotal) {
      throw new EvolutionStoreError('invalid-input', 'analyst candidate statistics are inconsistent')
    }
    const reference = this.#validateEvidenceReference({
      sampleEpisodeIds: candidate.evidence.map(entry => entry.episodeId),
      digest: candidate.evidenceDigest,
      total: candidate.evidenceTotal,
      window: evidenceWindow,
      scopeWatermark: candidate.scopeWatermark,
      taskRevisions: candidate.taskRevisions,
    }, stats.total)
    if (candidate.evidence.length !== reference.sampleEpisodeIds.length) {
      throw new EvolutionStoreError('invalid-input', 'analyst evidence projection is incomplete')
    }
    const evidence = candidate.evidence.map((entry, index) => {
      const episodeId = reference.sampleEpisodeIds[index]!
      if (entry.episodeId !== episodeId
        || (entry.outcome !== 'succeeded' && entry.outcome !== 'failed')
        || (entry.evidenceKind !== 'objective' && entry.evidenceKind !== 'verification')
        || !Number.isSafeInteger(entry.occurredAt) || entry.occurredAt < 0) {
        throw new EvolutionStoreError('invalid-input', 'analyst evidence sample is invalid')
      }
      return Object.freeze({
        episodeId,
        outcome: entry.outcome,
        evidenceKind: entry.evidenceKind,
        evidenceRef: this.#opaque(entry.evidenceRef, 'evidenceRef', 500),
        detail: this.#bounded(entry.detail, 'detail', this.#maxDetailBytes),
        occurredAt: entry.occurredAt,
      })
    })
    return Object.freeze({
      contractVersion: SUPERVISED_GROWTH_ANALYST_CONTRACT_VERSION,
      situation,
      failures: stats.failures,
      total: stats.total,
      evidenceDigest: reference.digest,
      evidenceTotal: reference.total,
      evidenceWindow,
      sampleEpisodeIds: reference.sampleEpisodeIds,
      evidence: Object.freeze(evidence),
      scopeWatermark: reference.scopeWatermark!,
      taskRevisions: reference.taskRevisions!,
    })
  }

  #supervisedGrowthAnalystEvidenceMatches(
    scopeKey: string,
    evidence: SupervisedGrowthAnalystEvidence,
  ): boolean {
    const mutation: Extract<EvolutionMutation, { op: 'adopt' }> = {
      op: 'adopt',
      input: {
        scopeKey,
        situation: evidence.situation,
        guidance: 'Pending supervised analyst guidance.',
      },
      baseline: {
        scopeKey,
        situation: evidence.situation,
        failures: evidence.failures,
        total: evidence.total,
      },
      evidence: {
        sampleEpisodeIds: evidence.sampleEpisodeIds,
        digest: evidence.evidenceDigest,
        total: evidence.evidenceTotal,
        window: evidence.evidenceWindow,
        scopeWatermark: evidence.scopeWatermark,
        taskRevisions: evidence.taskRevisions,
      },
    }
    return this.#proposalEvidenceMatches(mutation)
  }

  #sameSupervisedGrowthAnalystReview(
    row: SupervisedGrowthAnalystReviewRow,
    evidence: SupervisedGrowthAnalystEvidence,
    sampleJson: string,
    evidenceJson: string,
    taskRevisionsJson: string,
  ): boolean {
    return row.contract_version === evidence.contractVersion
      && row.situation === evidence.situation
      && row.failures === evidence.failures
      && row.total === evidence.total
      && row.evidence_digest === evidence.evidenceDigest
      && row.evidence_total === evidence.evidenceTotal
      && row.evidence_window === evidence.evidenceWindow
      && row.sample_episode_ids_json === sampleJson
      && row.evidence_json === evidenceJson
      && row.scope_watermark === evidence.scopeWatermark
      && row.task_revisions_json === taskRevisionsJson
  }

  #supervisedGrowthAnalystMutationMatches(
    mutation: Extract<EvolutionMutation, { op: 'adopt' }>,
    evidence: SupervisedGrowthAnalystEvidence,
  ): boolean {
    return mutation.input.scopeKey !== ''
      && mutation.input.situation === evidence.situation
      && mutation.baseline.scopeKey === mutation.input.scopeKey
      && mutation.baseline.situation === evidence.situation
      && mutation.baseline.failures === evidence.failures
      && mutation.baseline.total === evidence.total
      && mutation.evidence !== undefined
      && mutation.evidence.digest === evidence.evidenceDigest
      && mutation.evidence.total === evidence.evidenceTotal
      && mutation.evidence.window === evidence.evidenceWindow
      && mutation.evidence.scopeWatermark === evidence.scopeWatermark
      && mutation.evidence.taskRevisions !== undefined
      && this.#sameTaskRevisions(mutation.evidence.taskRevisions, evidence.taskRevisions)
      && this.#sameEvidenceSamples(
        evidence.evidence,
        mutation.evidence.sampleEpisodeIds,
      )
  }

  #supervisedGrowthAnalystProposalMatches(
    row: ProposalRow,
    evidence: SupervisedGrowthAnalystEvidence,
  ): boolean {
    let mutation: EvolutionMutation
    try {
      mutation = this.#validateStoredMutation(JSON.parse(row.mutation_json) as EvolutionMutation)
    } catch {
      return false
    }
    if (mutation.op !== 'adopt' || mutation.evidence === undefined
      || row.scope_key !== mutation.input.scopeKey
      || !this.#supervisedGrowthAnalystMutationMatches(mutation, evidence)) return false
    const expectedKey = supervisedGrowthAnalystProposalIdempotencyKey({
      scopeKey: row.scope_key,
      situation: evidence.situation,
      evidenceDigest: evidence.evidenceDigest,
      evidenceTotal: evidence.evidenceTotal,
      contractVersion: evidence.contractVersion,
    })
    return row.idempotency_key === expectedKey && row.mutation_hash === digest(mutation)
  }

  #analystReviewToken(value: string): string {
    const token = this.#opaque(value, 'reviewToken', 200)
    if (!/^analyst-review-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(token)) {
      throw new EvolutionStoreError('invalid-input', 'analyst review token is invalid')
    }
    return token
  }

  #proposalEvidenceMatches(mutation: EvolutionMutation): boolean {
    if (mutation.op === 'owner-undo') return true
    if (mutation.op === 'adopt') {
      return mutation.evidence === undefined
        || this.#adoptionEvidenceMatches(mutation, mutation.evidence)
    }
    const active = this.#database.prepare('SELECT * FROM evolution_rules WHERE id = ?')
      .get(mutation.ruleId) as unknown as RuleRow | undefined
    return active !== undefined && this.#retirementEvidenceMatches(mutation, active)
  }

  #adoptionEvidenceMatches(
    mutation: Extract<EvolutionMutation, { op: 'adopt' }>,
    evidence: EvidenceReference,
  ): boolean {
    if (evidence.window !== undefined) {
      if (this.activeRule(mutation.input.scopeKey, mutation.input.situation) !== undefined) return false
      const episodes = this.#adoptionEpisodes(
        mutation.input.scopeKey,
        mutation.input.situation,
        evidence.window,
      )
      const stats = this.#statsFromEpisodes(
        mutation.input.scopeKey,
        mutation.input.situation,
        episodes,
      )
      const current = this.#candidateEvidence(episodes, evidence.sampleEpisodeIds.length)
      return stats.failures === mutation.baseline.failures
        && stats.total === mutation.baseline.total
        && current.evidenceTotal === evidence.total
        && current.evidenceDigest === evidence.digest
        && (evidence.scopeWatermark === undefined
          || current.scopeWatermark === evidence.scopeWatermark)
        && (evidence.taskRevisions === undefined
          || this.#sameTaskRevisions(current.taskRevisions, evidence.taskRevisions))
        && this.#sameEvidenceSamples(current.evidence, evidence.sampleEpisodeIds)
    }
    const ids = evidence.sampleEpisodeIds
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.#database.prepare(`
      SELECT * FROM evolution_episodes WHERE id IN (${placeholders})
    `).all(...ids) as unknown as EpisodeRow[]
    return rows.length === ids.length && rows.every(row => row.scope_key === mutation.input.scopeKey
      && row.situation === mutation.input.situation && row.trust === 'trusted'
      && row.learning_eligible === 1 && row.rule_id === null)
  }

  #retirementEvidenceMatches(
    mutation: Extract<EvolutionMutation, { op: 'retire' }> & { evidence: EvidenceReference },
    active: RuleRow,
  ): boolean {
    if (mutation.evidence.window !== undefined) {
      const currentRule = rule(active)
      const episodes = this.#evaluationEpisodes(currentRule, mutation.evidence.window)
      const stats = this.#statsFromEpisodes(active.scope_key, active.situation, episodes)
      const current = this.#candidateEvidence(episodes, mutation.evidence.sampleEpisodeIds.length)
      return stats.failures === mutation.evaluation.failures
        && stats.total === mutation.evaluation.total
        && current.evidenceTotal === mutation.evidence.total
        && current.evidenceDigest === mutation.evidence.digest
        && (mutation.evidence.scopeWatermark === undefined
          || current.scopeWatermark === mutation.evidence.scopeWatermark)
        && (mutation.evidence.taskRevisions === undefined
          || this.#sameTaskRevisions(current.taskRevisions, mutation.evidence.taskRevisions))
        && this.#sameEvidenceSamples(current.evidence, mutation.evidence.sampleEpisodeIds)
    }
    const ids = mutation.evidence.sampleEpisodeIds
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.#database.prepare(`
      SELECT * FROM evolution_episodes WHERE id IN (${placeholders})
    `).all(...ids) as unknown as EpisodeRow[]
    return rows.length === ids.length && rows.every(row => row.scope_key === active.scope_key
      && row.situation === active.situation && row.trust === 'trusted'
      && row.learning_eligible === 1
      && row.rule_id === active.id && row.guidance_version === active.generation
      && row.occurred_at > active.adopted_at)
  }

  #sameEvidenceSamples(
    current: readonly EvidenceSample[],
    expectedIds: readonly string[],
  ): boolean {
    return current.length === expectedIds.length
      && current.every((entry, index) => entry.episodeId === expectedIds[index])
  }

  #sameTaskRevisions(
    current: readonly Readonly<{
      subjectKind: 'automation-run' | 'outcome'
      subjectRef: string
      version: number
      digest: string
      disposition: 'upsert'
    }>[],
    expected: readonly Readonly<{
      subjectKind: 'automation-run' | 'outcome'
      subjectRef: string
      version: number
      digest: string
      disposition: 'upsert'
    }>[],
  ): boolean {
    return current.length === expected.length
      && current.every((entry, index) => JSON.stringify(entry) === JSON.stringify(expected[index]))
  }

  #audit(operation: string, ruleId: string, resultVersion: number, now: number): void {
    this.#database.prepare(`
      INSERT INTO evolution_audit(idempotency_key, operation, rule_id, result_version, occurred_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(`${operation}:${ruleId}:${resultVersion}`, operation, ruleId, resultVersion, now)
  }

  #validateMutation(mutation: EvolutionMutation): EvolutionMutation {
    if (mutation.op === 'adopt') {
      const scopeKey = this.#scopeKey(mutation.input.scopeKey)
      const situation = this.#situation(mutation.input.situation)
      const guidance = this.#bounded(mutation.input.guidance, 'guidance', this.#maxGuidanceBytes)
      if (!Number.isSafeInteger(mutation.baseline.total) || mutation.baseline.total < 1
        || !Number.isSafeInteger(mutation.baseline.failures) || mutation.baseline.failures < 0
        || mutation.baseline.failures > mutation.baseline.total) {
        throw new EvolutionStoreError('invalid-input', 'baseline must be a coherent failure count over a positive sample')
      }
      if (mutation.baseline.scopeKey !== scopeKey
        || this.#situation(mutation.baseline.situation) !== situation) {
        throw new EvolutionStoreError('invalid-input', 'baseline scope and situation must match the adopted rule')
      }
      const evidence = mutation.evidence === undefined
        ? undefined
        : this.#validateEvidenceReference(mutation.evidence, mutation.baseline.total)
      const ruleId = mutation.ruleId === undefined
        ? undefined
        : this.#optionalServerRuleId(mutation.ruleId)
      return {
        op: 'adopt',
        input: { scopeKey, situation, guidance },
        baseline: {
          scopeKey,
          situation,
          failures: mutation.baseline.failures,
          total: mutation.baseline.total,
        },
        ...(evidence === undefined ? {} : { evidence }),
        ...(ruleId === undefined ? {} : { ruleId }),
      }
    }
    if (!Number.isSafeInteger(mutation.expectedVersion) || mutation.expectedVersion < 1) {
      throw new EvolutionStoreError('invalid-input', 'expectedVersion must be a positive safe integer')
    }
    const ruleId = this.#serverRuleId(mutation.ruleId)
    if (mutation.op === 'owner-undo') {
      return {
        op: 'owner-undo',
        scopeKey: this.#scopeKey(mutation.scopeKey),
        ruleId,
        situation: this.#situation(mutation.situation),
        guidance: this.#bounded(mutation.guidance, 'guidance', this.#maxGuidanceBytes),
        generation: this.#positiveVersion(mutation.generation, 'generation'),
        expectedVersion: mutation.expectedVersion,
        reason: this.#bounded(mutation.reason, 'reason', this.#maxDetailBytes),
      }
    }
    if (mutation.evaluation === undefined || mutation.baseline === undefined
      || mutation.evidence === undefined) {
      throw new EvolutionStoreError('invalid-input', 'retirement evidence snapshot must be complete')
    }
    const evaluation = this.#validateStats(mutation.evaluation!, 'retirement evaluation')
    const baseline = this.#validateStats(mutation.baseline!, 'retirement baseline')
    const scopeKey = this.#scopeKey(mutation.scopeKey)
    const situation = this.#situation(mutation.situation)
    const guidance = this.#bounded(mutation.guidance, 'guidance', this.#maxGuidanceBytes)
    const generation = this.#positiveVersion(mutation.generation, 'generation')
    if (evaluation.scopeKey !== baseline.scopeKey || evaluation.situation !== baseline.situation
      || evaluation.scopeKey !== scopeKey || evaluation.situation !== situation) {
      throw new EvolutionStoreError('invalid-input', 'retirement evaluation and baseline must match')
    }
    const evidence = this.#validateEvidenceReference(mutation.evidence!, evaluation.total)
    return {
      op: 'retire',
      scopeKey,
      ruleId,
      situation,
      guidance,
      generation,
      expectedVersion: mutation.expectedVersion,
      reason: this.#bounded(mutation.reason, 'reason', this.#maxDetailBytes),
      evaluation,
      baseline,
      evidence,
    }
  }

  #validateStoredMutation(mutation: EvolutionMutation): EvolutionMutation {
    const normalized = this.#validateMutation(mutation)
    if (normalized.op !== 'adopt') return normalized
    const ruleId = mutation.op === 'adopt' && mutation.ruleId !== undefined
      ? this.#serverRuleId(mutation.ruleId)
      : undefined
    if (ruleId === undefined) {
      throw new EvolutionStoreError('invalid-input', 'stored adoption mutation requires a server-issued rule UUID')
    }
    return { ...normalized, ruleId }
  }

  #proposalIntent(mutation: EvolutionMutation): EvolutionMutation {
    if (mutation.op !== 'adopt' || mutation.ruleId === undefined) return mutation
    const { ruleId: _ruleId, ...intent } = mutation
    return intent
  }

  #serverRuleId(value: string): string {
    const ruleId = this.#bounded(value, 'ruleId', 200)
    const pattern = /^rule-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    if (!pattern.test(ruleId)) {
      throw new EvolutionStoreError('invalid-input', 'ruleId must be a server-issued rule UUID')
    }
    return ruleId
  }

  #positiveVersion(value: number, field: string): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000_000) {
      throw new EvolutionStoreError('invalid-input', `${field} must be a positive safe integer`)
    }
    return value
  }

  #optionalServerRuleId(value: string): string | undefined {
    const normalized = value.normalize('NFC').trim()
    const pattern = /^rule-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    return pattern.test(normalized) ? this.#serverRuleId(normalized) : undefined
  }

  #validateStats(input: SituationStats, field: string): SituationStats {
    const scopeKey = this.#scopeKey(input.scopeKey)
    const situation = this.#situation(input.situation)
    if (!Number.isSafeInteger(input.total) || input.total < 1
      || !Number.isSafeInteger(input.failures) || input.failures < 0
      || input.failures > input.total) {
      throw new EvolutionStoreError('invalid-input', `${field} must be coherent over a positive sample`)
    }
    return Object.freeze({ scopeKey, situation, failures: input.failures, total: input.total })
  }

  #validateEvidenceReference(input: EvidenceReference, baselineTotal: number): EvidenceReference {
    if (!Number.isSafeInteger(input.total) || input.total < 1 || input.total !== baselineTotal) {
      throw new EvolutionStoreError(
        'invalid-input',
        'evidence total must equal the positive baseline sample size',
      )
    }
    if (!/^[a-f0-9]{64}$/u.test(input.digest)) {
      throw new EvolutionStoreError('invalid-input', 'evidence digest must be a lowercase SHA-256 digest')
    }
    if (!Array.isArray(input.sampleEpisodeIds) || input.sampleEpisodeIds.length < 1
      || input.sampleEpisodeIds.length > 50 || input.sampleEpisodeIds.length > input.total) {
      throw new EvolutionStoreError('invalid-input', 'evidence sample IDs must be bounded by 1..50 and total')
    }
    const sampleEpisodeIds = input.sampleEpisodeIds.map(id => this.#bounded(id, 'episodeId', 200))
    const episodeIdPattern = /^episode-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    if (sampleEpisodeIds.some(id => !episodeIdPattern.test(id))) {
      throw new EvolutionStoreError('invalid-input', 'evidence sample IDs must be server-issued episode UUIDs')
    }
    if (new Set(sampleEpisodeIds).size !== sampleEpisodeIds.length) {
      throw new EvolutionStoreError('invalid-input', 'evidence sample IDs must be unique')
    }
    const window = input.window
    if (window !== undefined) this.#requireWindow(window)
    const hasScopeWatermark = input.scopeWatermark !== undefined
    const hasTaskRevisions = input.taskRevisions !== undefined
    if (hasScopeWatermark !== hasTaskRevisions) {
      throw new EvolutionStoreError(
        'invalid-input',
        'evidence scope watermark and task revisions must be frozen together',
      )
    }
    let scopeWatermark: number | undefined
    let taskRevisions: EvidenceReference['taskRevisions']
    if (hasScopeWatermark && hasTaskRevisions) {
      scopeWatermark = this.#positiveVersion(input.scopeWatermark!, 'evidence scopeWatermark')
      if (!Array.isArray(input.taskRevisions) || input.taskRevisions.length !== input.total) {
        throw new EvolutionStoreError(
          'invalid-input',
          'evidence task revisions must cover the complete evidence window',
        )
      }
      const seen = new Set<string>()
      taskRevisions = Object.freeze(input.taskRevisions.map((entry, index) => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)
          || (entry.subjectKind !== 'automation-run' && entry.subjectKind !== 'outcome')
          || entry.disposition !== 'upsert'
          || !/^[a-f0-9]{64}$/u.test(entry.digest)) {
          throw new EvolutionStoreError('invalid-input', `evidence task revision ${index} is invalid`)
        }
        const subjectRef = this.#opaque(entry.subjectRef, 'task subjectRef', 1_000)
        const identity = JSON.stringify([entry.subjectKind, subjectRef])
        if (seen.has(identity)) {
          throw new EvolutionStoreError('invalid-input', 'evidence task revisions contain a duplicate')
        }
        seen.add(identity)
        return Object.freeze({
          subjectKind: entry.subjectKind,
          subjectRef,
          version: this.#positiveVersion(entry.version, 'task revision version'),
          digest: entry.digest,
          disposition: 'upsert' as const,
        })
      }))
    }
    return Object.freeze({
      sampleEpisodeIds: Object.freeze(sampleEpisodeIds),
      digest: input.digest,
      total: input.total,
      ...(window === undefined ? {} : { window }),
      ...(scopeWatermark === undefined ? {} : { scopeWatermark }),
      ...(taskRevisions === undefined ? {} : { taskRevisions }),
    })
  }

  #validateCreationIntent(
    input: EvolutionCreationInput,
    expected: { key: string; requester: string; principal: string },
  ): EvolutionCreationIntent {
    if (input.idempotencyKey !== expected.key || input.requester !== expected.requester
      || input.principal !== expected.principal) {
      throw new EvolutionStoreError('invalid-input', 'Policy creation intent identity does not match local proposal')
    }
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1) {
      throw new EvolutionStoreError('invalid-input', 'Policy creation intent ttlMs must be positive')
    }
    const intent: EvolutionCreationIntent = {
      idempotencyKey: this.#rawBounded(input.idempotencyKey, 'creation idempotencyKey', 200),
      requester: this.#rawBounded(input.requester, 'creation requester', 200),
      principal: this.#rawBounded(input.principal, 'creation principal', 500),
      action: this.#rawBounded(input.action, 'creation action', 200),
      resource: {
        kind: this.#rawBounded(input.resource.kind, 'creation resource kind', 200),
        id: this.#rawBounded(input.resource.id, 'creation resource id', 2_048),
      },
      summary: this.#rawBounded(input.summary, 'creation summary', 120),
      diff: this.#rawBounded(input.diff, 'creation diff', 64 * 1_024, true),
      ttlMs: input.ttlMs,
    }
    if (input.dispatch !== undefined) {
      if (input.dispatch.principal !== expected.principal) {
        throw new EvolutionStoreError('invalid-input', 'Policy dispatch is bound to another principal')
      }
      this.#rawBounded(input.dispatch.sourceId, 'dispatch sourceId', 500)
      this.#rawBounded(input.dispatch.bindingId, 'dispatch bindingId', 500)
      this.#rawBounded(input.dispatch.workspace, 'dispatch workspace', 4_096)
      this.#rawBounded(input.dispatch.principal, 'dispatch principal', 500)
      intent.dispatch = approvalDispatch(
        JSON.parse(JSON.stringify(input.dispatch)) as unknown,
        'invalid-input',
        false,
      )
    }
    return intent
  }

  #requireProposal(proposalId: string): ProposalRow {
    const row = this.#database.prepare('SELECT * FROM evolution_proposals WHERE id = ?')
      .get(proposalId) as unknown as ProposalRow | undefined
    if (row === undefined) throw new EvolutionStoreError('not-found', 'evolution proposal was not found')
    return row
  }

  #requireWindow(window: number): void {
    if (!Number.isSafeInteger(window) || window < 1 || window > 10_000) {
      throw new EvolutionStoreError('invalid-input', 'window must be between 1 and 10000')
    }
  }

  #situation(value: string): string {
    return this.#bounded(value, 'situation', this.#maxSituationBytes)
  }

  #scopeKey(value: string): string {
    return this.#bounded(value, 'scopeKey', 2_048)
  }

  #bounded(value: string, field: string, maximum: number): string {
    const normalized = value.normalize('NFC').trim()
    if (normalized === '' || Buffer.byteLength(normalized, 'utf8') > maximum) {
      throw new EvolutionStoreError('invalid-input', `${field} must be non-empty and within ${maximum} bytes`)
    }
    return normalized
  }

  #rawBounded(
    value: string,
    field: string,
    maximum: number,
    allowEmpty = false,
  ): string {
    if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')
      || Buffer.byteLength(value, 'utf8') > maximum) {
      throw new EvolutionStoreError('invalid-input', `${field} must be within ${maximum} bytes`)
    }
    return value
  }

  #opaque(value: string, field: string, maximum: number): string {
    if (typeof value !== 'string' || value === '' || value.trim() !== value
      || Buffer.byteLength(value, 'utf8') > maximum) {
      throw new EvolutionStoreError(
        'invalid-input',
        `${field} must be an exact non-empty identifier within ${maximum} bytes`,
      )
    }
    return value
  }
}

export { digest as evolutionDigest, type RuleInput }
