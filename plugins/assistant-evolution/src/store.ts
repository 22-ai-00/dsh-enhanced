import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { openEvolutionDatabase } from './sqlite.js'
import { evolutionMutationReview } from './review.js'
import type {
  EpisodeInput,
  EpisodeTrust,
  EvidenceReference,
  EvidenceSample,
  EvolutionCreationIntent,
  EvolutionMutation,
  EvolutionSettlementExpectation,
  GuidanceExposure,
  ProposalStatus,
  RuleCandidate,
  RuleInput,
  SituationStats,
  StoredEpisode,
  StoredAutonomousRollback,
  StoredProposal,
  StoredRule,
} from './types.js'
import { legacyEvolutionScope } from './types.js'

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
  unattributedTrustedEpisodes: number
  lastTrustedEpisodeAt: number
  autonomousRollbacks: number
}

interface EpisodeRow {
  id: string
  scope_key: string
  situation: string
  outcome: 'succeeded' | 'failed'
  detail: string
  source: 'automation' | 'foreground'
  trust: EpisodeTrust
  rule_id: string | null
  guidance_version: number | null
  claimed_rule_id: string | null
  occurred_at: number
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
    ruleId: row.rule_id ?? undefined,
    guidanceVersion: row.guidance_version ?? undefined,
    claimedRuleId: row.claimed_rule_id ?? undefined,
    occurredAt: row.occurred_at,
  })
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
    creationIntent: row.creation_intent_json === null
      ? undefined
      : JSON.parse(row.creation_intent_json) as EvolutionCreationIntent,
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
          WHERE trust = 'trusted' AND rule_id IS NULL) AS unattributed_trusted_episodes,
        (SELECT COALESCE(MAX(occurred_at), 0) FROM evolution_episodes
          WHERE trust = 'trusted') AS last_trusted_episode_at,
        (SELECT COUNT(*) FROM evolution_autonomous_rollbacks) AS autonomous_rollbacks
    `).get() as {
      active_rules: number
      retired_rules: number
      pending_proposals: number
      conflicted_proposals: number
      trusted_episodes: number
      unattributed_trusted_episodes: number
      last_trusted_episode_at: number
      autonomous_rollbacks: number
    }
    return Object.freeze({
      activeRules: row.active_rules,
      retiredRules: row.retired_rules,
      pendingProposals: row.pending_proposals,
      conflictedProposals: row.conflicted_proposals,
      trustedEpisodes: row.trusted_episodes,
      unattributedTrustedEpisodes: row.unattributed_trusted_episodes,
      lastTrustedEpisodeAt: row.last_trusted_episode_at,
      autonomousRollbacks: row.autonomous_rollbacks,
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
    if (scopeKey === legacyEvolutionScope && input.trust !== 'legacy') {
      throw new EvolutionStoreError('invalid-input', 'legacy scope may only contain quarantined evidence')
    }
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
    const id = `episode-${randomUUID()}`
    this.#database.prepare(`
      INSERT INTO evolution_episodes(
        id, idempotency_key, scope_key, situation, outcome, detail, source,
        trust, rule_id, guidance_version, claimed_rule_id, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(
      id, key, scopeKey, situation, input.outcome, detail, input.source,
      input.trust, trustedRuleId ?? null, guidanceVersion ?? null,
      claimedRuleId ?? null, input.occurredAt,
    )
    const winner = this.#database.prepare('SELECT * FROM evolution_episodes WHERE idempotency_key = ?')
      .get(key) as unknown as EpisodeRow
    // Replay must be exact; a reused key with different content is a caller bug.
    if (winner.scope_key !== scopeKey || winner.situation !== situation
      || winner.outcome !== input.outcome || winner.detail !== detail
      || winner.source !== input.source || winner.trust !== input.trust
      || (winner.rule_id ?? undefined) !== trustedRuleId
      || (winner.guidance_version ?? undefined) !== guidanceVersion
      || (winner.claimed_rule_id ?? undefined) !== claimedRuleId
      || winner.occurred_at !== input.occurredAt) {
      throw new EvolutionStoreError('idempotency-conflict', 'episode idempotency key was reused with different content')
    }
    return episode(winner)
  }

  /** Failure counts for one situation over the most recent `window` episodes. */
  stats(scopeKey: string, situation: string, window: number): SituationStats {
    const scope = this.#scopeKey(scopeKey)
    const label = this.#situation(situation)
    this.#requireWindow(window)
    const row = this.#database.prepare(`
      SELECT COUNT(*) AS total, SUM(outcome = 'failed') AS failures FROM (
        SELECT outcome FROM evolution_episodes
        WHERE scope_key = ? AND situation = ? AND trust = 'trusted' AND rule_id IS NULL
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
      WHERE scope_key = ? AND trust = 'trusted'
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

  #adoptionEpisodes(scopeKey: string, situation: string, window: number): EpisodeRow[] {
    const retired = this.#database.prepare(`
      SELECT updated_at FROM evolution_rules
      WHERE scope_key = ? AND situation = ? AND status = 'retired'
      ORDER BY generation DESC LIMIT 1
    `).get(scopeKey, situation) as { updated_at: number } | undefined
    if (retired === undefined) {
      return this.#database.prepare(`
        SELECT * FROM evolution_episodes
        WHERE scope_key = ? AND situation = ? AND trust = 'trusted' AND rule_id IS NULL
        ORDER BY occurred_at DESC, id DESC LIMIT ?
      `).all(scopeKey, situation, window) as unknown as EpisodeRow[]
    }
    return this.#database.prepare(`
      SELECT * FROM evolution_episodes
      WHERE scope_key = ? AND situation = ? AND trust = 'trusted'
        AND rule_id IS NULL AND occurred_at > ?
      ORDER BY occurred_at DESC, id DESC LIMIT ?
    `).all(scopeKey, situation, retired.updated_at, window) as unknown as EpisodeRow[]
  }

  #evaluationEpisodes(active: StoredRule, window: number): EpisodeRow[] {
    return this.#database.prepare(`
      SELECT * FROM evolution_episodes
      WHERE scope_key = ? AND situation = ? AND trust = 'trusted'
        AND rule_id = ? AND guidance_version = ? AND occurred_at > ?
      ORDER BY occurred_at DESC, id DESC LIMIT ?
    `).all(
      active.scopeKey, active.situation, active.id, active.generation, active.adoptedAt, window,
    ) as unknown as EpisodeRow[]
  }

  #statsFromEpisodes(scopeKey: string, situation: string, episodes: readonly EpisodeRow[]): SituationStats {
    return Object.freeze({
      scopeKey,
      situation,
      failures: episodes.filter(row => row.outcome === 'failed').length,
      total: episodes.length,
    })
  }

  #candidateEvidence(episodes: readonly EpisodeRow[], sampleLimit: number): {
    evidence: readonly EvidenceSample[]
    evidenceDigest: string
    evidenceTotal: number
  } {
    const evidence = episodes.slice(0, sampleLimit).map(row => Object.freeze({
      episodeId: row.id,
      outcome: row.outcome,
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
      ruleId: row.rule_id,
      guidanceVersion: row.guidance_version,
      occurredAt: row.occurred_at,
    })))
    return Object.freeze({
      evidence: Object.freeze(evidence),
      evidenceDigest,
      evidenceTotal: episodes.length,
    })
  }

  // ---- proposals -----------------------------------------------------------

  createProposal(input: {
    idempotencyKey: string
    requester: string
    principal: string
    mutation: EvolutionMutation
    expiresAt: number
    creationIntent?: EvolutionCreationIntent
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
      : (this.getRule(mutation.ruleId)?.scopeKey ?? legacyEvolutionScope)
    this.#database.prepare(`
      INSERT INTO evolution_proposals(
        id, policy_proposal_id, idempotency_key, requester, principal, scope_key, mutation_hash,
        mutation_json, creation_intent_json, settlement_expectation_json,
        status, expires_at, created_at, updated_at, version)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?, ?, 1)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(
      id, key, requester, principal, scopeKey, hash, JSON.stringify(mutation),
      creationIntentJson, input.expiresAt, now, now,
    )
    const winner = this.#database.prepare('SELECT * FROM evolution_proposals WHERE idempotency_key = ?')
      .get(key) as unknown as ProposalRow
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
      throw new EvolutionStoreError('idempotency-conflict', 'proposal idempotency key was reused with different content')
    }
    return proposal(winner)
  }

  attachPolicy(
    proposalId: string,
    policyProposalId: string,
    expectation?: EvolutionSettlementExpectation,
  ): StoredProposal {
    const policyId = this.#bounded(policyProposalId, 'policyProposalId', 200)
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
    const attached = this.#requireProposal(proposalId)
    if (attached.policy_proposal_id !== policyId
      || attached.settlement_expectation_json !== expectationJson) {
      throw new EvolutionStoreError('invalid-state', 'proposal is already attached to a different policy proposal')
    }
    return proposal(attached)
  }

  getProposal(proposalId: string): StoredProposal | undefined {
    const row = this.#database.prepare('SELECT * FROM evolution_proposals WHERE id = ?')
      .get(proposalId) as unknown as ProposalRow | undefined
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

  /** Move an inspected-but-still-pending row behind its peers, durably. */
  deferPendingProposal(proposalId: string): void {
    const now = this.#now()
    this.#database.prepare(`
      UPDATE evolution_proposals
      SET updated_at = CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END
      WHERE id = ? AND status = 'pending'
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

  #applyMutation(mutation: EvolutionMutation, proposalScopeKey: string, now: number): {
    status: ProposalStatus
    ruleId: string | undefined
  } {
    if (mutation.op === 'adopt') {
      const ruleId = mutation.ruleId
      if (ruleId === undefined || mutation.input.scopeKey !== proposalScopeKey) {
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
    if (existing === undefined || existing.scope_key !== proposalScopeKey || existing.status !== 'active'
      || existing.version !== mutation.expectedVersion
      || (mutation.evaluation !== undefined && mutation.baseline !== undefined
        && mutation.evidence !== undefined && (
        mutation.evaluation.scopeKey !== existing.scope_key
        || mutation.evaluation.situation !== existing.situation
        || mutation.baseline.scopeKey !== existing.scope_key
        || mutation.baseline.situation !== existing.situation
        || mutation.baseline.failures !== existing.baseline_failures
        || mutation.baseline.total !== existing.baseline_total
        || !this.#retirementEvidenceSamplesMatch(
          mutation as Extract<EvolutionMutation, { op: 'retire' }> & { evidence: EvidenceReference },
          existing,
        )))) {
      return { status: 'conflicted', ruleId: undefined }
    }
    const version = existing.version + 1
    this.#database.prepare(`
      UPDATE evolution_rules
      SET status = 'retired', retired_reason = ?, updated_at = ?, version = ?
      WHERE id = ? AND version = ?
    `).run(mutation.reason, now, version, mutation.ruleId, mutation.expectedVersion)
    this.#audit('retire', mutation.ruleId, version, now)
    return { status: 'approved', ruleId: mutation.ruleId }
  }

  #retirementEvidenceSamplesMatch(
    mutation: Extract<EvolutionMutation, { op: 'retire' }> & { evidence: EvidenceReference },
    active: RuleRow,
  ): boolean {
    const ids = mutation.evidence.sampleEpisodeIds
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.#database.prepare(`
      SELECT * FROM evolution_episodes WHERE id IN (${placeholders})
    `).all(...ids) as unknown as EpisodeRow[]
    return rows.length === ids.length && rows.every(row => row.scope_key === active.scope_key
      && row.situation === active.situation && row.trust === 'trusted'
      && row.rule_id === active.id && row.guidance_version === active.generation
      && row.occurred_at > active.adopted_at)
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
    const ruleId = this.#bounded(mutation.ruleId, 'ruleId', 200)
    if (mutation.evaluation === undefined || mutation.baseline === undefined
      || mutation.evidence === undefined) {
      throw new EvolutionStoreError('invalid-input', 'retirement evidence snapshot must be complete')
    }
    const evaluation = this.#validateStats(mutation.evaluation!, 'retirement evaluation')
    const baseline = this.#validateStats(mutation.baseline!, 'retirement baseline')
    if (evaluation.scopeKey !== baseline.scopeKey || evaluation.situation !== baseline.situation) {
      throw new EvolutionStoreError('invalid-input', 'retirement evaluation and baseline must match')
    }
    const evidence = this.#validateEvidenceReference(mutation.evidence!, evaluation.total)
    return {
      op: 'retire',
      ruleId,
      expectedVersion: mutation.expectedVersion,
      reason: this.#bounded(mutation.reason, 'reason', this.#maxDetailBytes),
      evaluation,
      baseline,
      evidence,
    }
  }

  #validateStoredMutation(mutation: EvolutionMutation): EvolutionMutation {
    const normalized = this.#validateMutation(mutation)
    if (normalized.op === 'retire') return normalized
    const ruleId = mutation.op === 'adopt' && mutation.ruleId !== undefined
      ? this.#serverRuleId(mutation.ruleId)
      : undefined
    if (ruleId === undefined) {
      throw new EvolutionStoreError('invalid-input', 'stored adoption mutation requires a server-issued rule UUID')
    }
    return { ...normalized, ruleId }
  }

  #proposalIntent(mutation: EvolutionMutation): EvolutionMutation {
    if (mutation.op === 'retire' || mutation.ruleId === undefined) return mutation
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
    return Object.freeze({
      sampleEpisodeIds: Object.freeze(sampleEpisodeIds),
      digest: input.digest,
      total: input.total,
    })
  }

  #validateCreationIntent(
    input: EvolutionCreationIntent,
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
      intent.dispatch = {
        sourceId: this.#rawBounded(input.dispatch.sourceId, 'dispatch sourceId', 500),
        bindingId: this.#rawBounded(input.dispatch.bindingId, 'dispatch bindingId', 500),
        workspace: this.#rawBounded(input.dispatch.workspace, 'dispatch workspace', 4_096),
        principal: this.#rawBounded(input.dispatch.principal, 'dispatch principal', 500),
      }
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
