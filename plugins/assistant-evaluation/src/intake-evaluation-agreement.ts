/**
 * WP22: canonical ingestion and correlation of WP20 `would-accept` intake
 * evaluations against admitted work-item outcomes, notification outcomes, and
 * subsequent owner feedback or withdrawals.
 *
 * Reads only the text-free `listIntakeEvaluationFeed` surface structurally
 * from WorkItems (no runtime dependency) and maintains a durable incremental
 * cursor plus immutable revision history alongside notification outcomes.
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { canonicalEvaluationScope, EvaluationStoreError } from './store.js'
import type { EvaluationScope, NotificationOutcome } from './types.js'

export const WORK_ITEM_INTAKE_EVALUATION_FEED_PROTOCOL = 'work-items/intake-evaluation-feed/v1' as const
export const INTAKE_EVALUATION_AGREEMENT_PROTOCOL = 'assistant-evaluation/intake-evaluation-agreement/v1' as const

export type IntakeEvaluationOutcomeKind = 'agreed' | 'disagreed' | 'pending'
export type IntakeEvaluationAgreementStatus =
  | 'true-positive'
  | 'false-positive'
  | 'false-negative'
  | 'true-negative'
  | 'pending'
export type IntakeEvaluationOutcomeSource =
  | 'none'
  | 'work-item-outcome'
  | 'work-item-verdict'
  | 'notification-outcome'
  | 'owner-feedback'
  | 'owner-withdrawal'

export interface IntakeEvaluationFeedCursor {
  readonly afterSeq: number
  readonly afterRecordedAt: number
  readonly afterId: string
}

/** Structural WorkItems WP22 feed adapter; Evaluation keeps no runtime dependency on WorkItems. */
export interface IntakeEvaluationFeedSource {
  listIntakeEvaluationFeed(options?: Readonly<{
    afterSeq?: number
    afterRecordedAt?: number
    afterId?: string
    limit?: number
    workspace?: string
    preset?: string
    onlyWithOutcome?: boolean
  }>): unknown
}

export function isIntakeEvaluationFeedSource(value: unknown): value is IntakeEvaluationFeedSource {
  return typeof value === 'object' && value !== null
    && typeof (value as { listIntakeEvaluationFeed?: unknown }).listIntakeEvaluationFeed === 'function'
}

export interface StoredIntakeEvaluationAgreement {
  readonly evalId: string
  readonly source: string
  readonly sourceEventId: string
  readonly ruleId: string
  readonly policyVersion: string
  readonly scope: EvaluationScope | null
  readonly scopeKey: string | null
  readonly itemId: string | null
  readonly wouldAccept: boolean
  readonly evaluationLevel: 'ignore' | 'digest' | 'notify' | 'accept'
  readonly mode: 'observe' | 'auto'
  readonly outcomeKind: IntakeEvaluationOutcomeKind
  readonly agreementStatus: IntakeEvaluationAgreementStatus
  readonly outcomeSource: IntakeEvaluationOutcomeSource
  readonly evaluatedAt: number
  readonly feedRecordedAt: number
  readonly version: number
  readonly digest: string
  readonly updatedAt: number
}

export interface IntakeEvaluationAgreementRevision {
  readonly evalId: string
  readonly version: number
  readonly outcomeKind: IntakeEvaluationOutcomeKind
  readonly agreementStatus: IntakeEvaluationAgreementStatus
  readonly outcomeSource: IntakeEvaluationOutcomeSource
  readonly digest: string
  readonly recordedAt: number
  readonly feedSignals: Readonly<Record<string, unknown>>
}

export interface IntakeEvaluationAgreementHistory {
  readonly head: StoredIntakeEvaluationAgreement
  readonly revisions: readonly IntakeEvaluationAgreementRevision[]
}

export interface IntakeEvaluationAgreementSummary {
  readonly protocol: typeof INTAKE_EVALUATION_AGREEMENT_PROTOCOL
  readonly scope: EvaluationScope | null
  readonly source: string | null
  readonly ruleId: string | null
  readonly fromEvaluatedAt: number
  readonly toEvaluatedAt: number
  readonly total: number
  readonly truePositive: number
  readonly falsePositive: number
  readonly falseNegative: number
  readonly trueNegative: number
  readonly pending: number
  readonly agreed: number
  readonly disagreed: number
  readonly decided: number
  /** agreed / decided in ppm; null when decided === 0. */
  readonly agreementPpm: number | null
  /** falsePositive / (truePositive + falsePositive) in ppm; null when denominator === 0. */
  readonly falsePositiveRatePpm: number | null
  /** falseNegative / (trueNegative + falseNegative) in ppm; null when denominator === 0. */
  readonly falseNegativeRatePpm: number | null
}

export interface IntakeEvaluationSyncResult {
  readonly enabled: boolean
  readonly available: boolean
  readonly ingested: number
  readonly correlated: number
  readonly revised: number
  readonly invalid: number
  readonly cursor: IntakeEvaluationFeedCursor
}

const LEVELS = ['ignore', 'digest', 'notify', 'accept'] as const
const POSITIVE_NOTIFICATIONS: ReadonlySet<NotificationOutcome> = new Set(['accepted', 'reacted'])
const NEGATIVE_NOTIFICATIONS: ReadonlySet<NotificationOutcome> = new Set(['rejected', 'expired-unhandled'])
const FORBIDDEN_BODY_FIELDS = ['text', 'body', 'title', 'brief', 'prompt', 'sourceText', 'objective', 'messages'] as const

const AUTHORITY_RANK: Readonly<Record<Exclude<IntakeEvaluationOutcomeSource, 'none'>, number>> = Object.freeze({
  'owner-feedback': 4,
  'owner-withdrawal': 3,
  'notification-outcome': 2,
  'work-item-verdict': 1,
  'work-item-outcome': 0,
})

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).filter(key => record[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

function sha256(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : canonical(value), 'utf8').digest('hex')
}

function invalid(message: string): never {
  throw new EvaluationStoreError('invalid-input', message)
}

function nonEmptyString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    invalid(`intake evaluation ${label} must be a non-empty string`)
  }
  return value
}

function nonNegInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(`intake evaluation ${label} must be a non-negative integer`)
  }
  return value
}

function optionalPlainRecord(value: unknown, label: string): Record<string, unknown> | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) invalid(`intake evaluation ${label} must be an object`)
  const record = value as Record<string, unknown>
  for (const forbidden of FORBIDDEN_BODY_FIELDS) {
    if (Object.hasOwn(record, forbidden)) invalid(`intake evaluation ${label} must not contain raw text field ${forbidden}`)
  }
  return record
}

export function intakeEvaluationCanonicalId(source: string, sourceEventId: string, ruleId: string, policyVersion: string): string {
  return sha256({
    protocol: 'assistant-evaluation/intake-evaluation/v1',
    source,
    sourceEventId,
    ruleId,
    policyVersion,
  })
}

export interface NormalizedFeedItem {
  readonly evalId: string
  readonly feedId: string
  readonly seq: number
  readonly recordedAt: number
  readonly evaluatedAt: number
  readonly source: string
  readonly sourceEventId: string
  readonly ruleId: string
  readonly policyVersion: string
  readonly mode: 'observe' | 'auto'
  readonly evaluationLevel: 'ignore' | 'digest' | 'notify' | 'accept'
  readonly wouldAccept: boolean
  readonly itemId: string | null
  readonly scope: EvaluationScope | null
  readonly scopeKey: string | null
  readonly feedSignals: Readonly<{
    metadataDigest: string
    sourceDigest: string
    contentDigest: string | null
    outcome: Readonly<{
      revision: number
      settledBy: string
      executionStatus: string
      objectiveStatus: string
      evidenceState: string
      settledAt: number
      recordedAt: number
      ownerWithdrawn: boolean
    }> | null
    acceptanceVerdict: Readonly<{
      objectiveStatus: 'achieved' | 'not-achieved' | 'unknown'
      receiptDigest: string
      completedAt: number
      recordedAt: number
    }> | null
    ownerCorrection: Readonly<{
      kind: 'withdrawn'
      stateReason: string | null
      recordedAt: number
    }> | null
  }>
}

function normalizeFeedItem(raw: unknown): NormalizedFeedItem {
  const item = optionalPlainRecord(raw, 'feed item')
  if (item === null) invalid('intake evaluation feed item must be an object')
  const seq = nonNegInt(item['seq'], 'seq')
  if (seq < 1) invalid('intake evaluation seq must be positive')
  const feedId = nonEmptyString(item['id'], 'id', 256)
  const recordedAt = nonNegInt(item['recordedAt'], 'recordedAt')
  const evaluatedAt = nonNegInt(item['evaluatedAt'], 'evaluatedAt')
  const source = nonEmptyString(item['source'], 'source', 64)
  const sourceEventId = nonEmptyString(item['sourceEventId'], 'sourceEventId', 256)
  const ruleId = nonEmptyString(item['ruleId'], 'ruleId', 256)
  const policyVersion = nonEmptyString(item['policyVersion'], 'policyVersion', 256)
  if (typeof item['wouldAccept'] !== 'boolean') invalid('intake evaluation wouldAccept must be a boolean')
  const mode = item['mode']
  if (mode !== 'observe' && mode !== 'auto') invalid('intake evaluation mode is invalid')
  const level = item['evaluationLevel']
  if (!(LEVELS as readonly unknown[]).includes(level)) invalid('intake evaluation level is invalid')
  const metadataDigest = nonEmptyString(item['metadataDigest'], 'metadataDigest', 128)
  const sourceDigest = nonEmptyString(item['sourceDigest'], 'sourceDigest', 128)
  const contentDigest = item['contentDigest'] === null || item['contentDigest'] === undefined
    ? null : nonEmptyString(item['contentDigest'], 'contentDigest', 128)
  const itemId = item['itemId'] === null || item['itemId'] === undefined
    ? null : nonEmptyString(item['itemId'], 'itemId', 256)

  let scope: EvaluationScope | null = null
  let scopeKey: string | null = null
  if (item['scope'] !== null && item['scope'] !== undefined) {
    const scopeObj = optionalPlainRecord(item['scope'], 'scope')
    if (scopeObj === null) invalid('intake evaluation scope must be an object')
    const canonicalScope = canonicalEvaluationScope({
      workspace: scopeObj['workspace'] as string,
      preset: scopeObj['preset'] as string,
    })
    scope = canonicalScope.scope
    scopeKey = canonicalScope.scopeKey
  }

  const rawOutcome = optionalPlainRecord(item['outcome'], 'outcome')
  const outcome = rawOutcome === null ? null : Object.freeze({
    revision: nonNegInt(rawOutcome['revision'], 'outcome.revision'),
    settledBy: nonEmptyString(rawOutcome['settledBy'], 'outcome.settledBy', 64),
    executionStatus: nonEmptyString(rawOutcome['executionStatus'], 'outcome.executionStatus', 64),
    objectiveStatus: nonEmptyString(rawOutcome['objectiveStatus'], 'outcome.objectiveStatus', 64),
    evidenceState: nonEmptyString(rawOutcome['evidenceState'], 'outcome.evidenceState', 64),
    settledAt: nonNegInt(rawOutcome['settledAt'], 'outcome.settledAt'),
    recordedAt: nonNegInt(rawOutcome['recordedAt'], 'outcome.recordedAt'),
    ownerWithdrawn: rawOutcome['ownerWithdrawn'] === true || rawOutcome['settledBy'] === 'withdrawn',
  })

  const rawVerdict = optionalPlainRecord(item['acceptanceVerdict'], 'acceptanceVerdict')
  let acceptanceVerdict: NormalizedFeedItem['feedSignals']['acceptanceVerdict'] = null
  if (rawVerdict !== null) {
    const obj = rawVerdict['objectiveStatus']
    if (obj !== 'achieved' && obj !== 'not-achieved' && obj !== 'unknown') {
      invalid('intake evaluation acceptanceVerdict.objectiveStatus is invalid')
    }
    acceptanceVerdict = Object.freeze({
      objectiveStatus: obj,
      receiptDigest: nonEmptyString(rawVerdict['receiptDigest'], 'acceptanceVerdict.receiptDigest', 128),
      completedAt: nonNegInt(rawVerdict['completedAt'], 'acceptanceVerdict.completedAt'),
      recordedAt: nonNegInt(rawVerdict['recordedAt'], 'acceptanceVerdict.recordedAt'),
    })
  }

  const rawCorrection = optionalPlainRecord(item['ownerCorrection'], 'ownerCorrection')
  let ownerCorrection: NormalizedFeedItem['feedSignals']['ownerCorrection'] = null
  if (rawCorrection !== null) {
    if (rawCorrection['kind'] !== 'withdrawn') invalid('intake evaluation ownerCorrection.kind is invalid')
    ownerCorrection = Object.freeze({
      kind: 'withdrawn' as const,
      stateReason: rawCorrection['stateReason'] === null || rawCorrection['stateReason'] === undefined
        ? null : nonEmptyString(rawCorrection['stateReason'], 'ownerCorrection.stateReason', 256),
      recordedAt: nonNegInt(rawCorrection['recordedAt'], 'ownerCorrection.recordedAt'),
    })
  }

  return Object.freeze({
    evalId: intakeEvaluationCanonicalId(source, sourceEventId, ruleId, policyVersion),
    feedId,
    seq,
    recordedAt,
    evaluatedAt,
    source,
    sourceEventId,
    ruleId,
    policyVersion,
    mode,
    evaluationLevel: level as NormalizedFeedItem['evaluationLevel'],
    wouldAccept: item['wouldAccept'] as boolean,
    itemId,
    scope,
    scopeKey,
    feedSignals: Object.freeze({
      metadataDigest,
      sourceDigest,
      contentDigest,
      outcome,
      acceptanceVerdict,
      ownerCorrection,
    }),
  })
}

export function normalizeFeedCursor(raw: unknown): IntakeEvaluationFeedCursor | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) invalid('intake evaluation cursor must be an object')
  const record = raw as Record<string, unknown>
  return Object.freeze({
    afterSeq: nonNegInt(record['afterSeq'], 'cursor.afterSeq'),
    afterRecordedAt: nonNegInt(record['afterRecordedAt'], 'cursor.afterRecordedAt'),
    afterId: nonEmptyString(record['afterId'], 'cursor.afterId', 256),
  })
}

export function normalizeFeedPage(raw: unknown): Readonly<{
  items: readonly unknown[]
  hasMore: boolean
  nextCursor: IntakeEvaluationFeedCursor | null
}> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) invalid('intake evaluation feed page must be an object')
  const record = raw as Record<string, unknown>
  if (record['protocol'] !== WORK_ITEM_INTAKE_EVALUATION_FEED_PROTOCOL) {
    invalid('intake evaluation feed protocol is unsupported')
  }
  if (!Array.isArray(record['items'])) invalid('intake evaluation feed items must be an array')
  if (typeof record['hasMore'] !== 'boolean') invalid('intake evaluation feed hasMore must be a boolean')
  return Object.freeze({
    items: record['items'] as readonly unknown[],
    hasMore: record['hasMore'],
    nextCursor: normalizeFeedCursor(record['nextCursor']),
  })
}

interface CandidateSignal {
  readonly positive: boolean
  readonly source: Exclude<IntakeEvaluationOutcomeSource, 'none'>
  readonly at: number
  readonly authorityRank: number
  readonly detail: Readonly<Record<string, unknown>>
}

function classifyAgreement(
  wouldAccept: boolean,
  winning: CandidateSignal | undefined,
): Readonly<{
  outcomeKind: IntakeEvaluationOutcomeKind
  agreementStatus: IntakeEvaluationAgreementStatus
  outcomeSource: IntakeEvaluationOutcomeSource
}> {
  if (winning === undefined) {
    return { outcomeKind: 'pending', agreementStatus: 'pending', outcomeSource: 'none' }
  }
  if (wouldAccept && winning.positive) {
    return { outcomeKind: 'agreed', agreementStatus: 'true-positive', outcomeSource: winning.source }
  }
  if (wouldAccept && !winning.positive) {
    return { outcomeKind: 'disagreed', agreementStatus: 'false-positive', outcomeSource: winning.source }
  }
  if (!wouldAccept && winning.positive) {
    return { outcomeKind: 'disagreed', agreementStatus: 'false-negative', outcomeSource: winning.source }
  }
  return { outcomeKind: 'agreed', agreementStatus: 'true-negative', outcomeSource: winning.source }
}

function cursorAdvances(next: IntakeEvaluationFeedCursor, prev: IntakeEvaluationFeedCursor): boolean {
  if (next.afterRecordedAt > prev.afterRecordedAt) return true
  if (next.afterRecordedAt < prev.afterRecordedAt) return false
  if (next.afterId > prev.afterId) return true
  if (next.afterId < prev.afterId) return false
  return next.afterSeq > prev.afterSeq
}

interface HeadDbRow {
  eval_id: string
  source: string
  source_event_id: string
  rule_id: string
  policy_version: string
  scope_key: string | null
  workspace: string | null
  preset: string | null
  item_id: string | null
  would_accept: 0 | 1
  evaluation_level: StoredIntakeEvaluationAgreement['evaluationLevel']
  mode: StoredIntakeEvaluationAgreement['mode']
  outcome_kind: IntakeEvaluationOutcomeKind
  agreement_status: IntakeEvaluationAgreementStatus
  outcome_source: IntakeEvaluationOutcomeSource
  evaluated_at: number
  feed_recorded_at: number
  version: number
  latest_digest: string
  updated_at: number
}

function toStoredHead(row: HeadDbRow): StoredIntakeEvaluationAgreement {
  return Object.freeze({
    evalId: row.eval_id,
    source: row.source,
    sourceEventId: row.source_event_id,
    ruleId: row.rule_id,
    policyVersion: row.policy_version,
    scope: row.workspace !== null && row.preset !== null
      ? Object.freeze({ workspace: row.workspace, preset: row.preset })
      : null,
    scopeKey: row.scope_key,
    itemId: row.item_id,
    wouldAccept: row.would_accept === 1,
    evaluationLevel: row.evaluation_level,
    mode: row.mode,
    outcomeKind: row.outcome_kind,
    agreementStatus: row.agreement_status,
    outcomeSource: row.outcome_source,
    evaluatedAt: row.evaluated_at,
    feedRecordedAt: row.feed_recorded_at,
    version: row.version,
    digest: row.latest_digest,
    updatedAt: row.updated_at,
  })
}

/**
 * Durable WP20 `would-accept` correlation ledger stored inside Evaluation SQLite
 * (schema 19) alongside notification outcomes.
 */
export class IntakeEvaluationAgreementLedger {
  readonly #database: DatabaseSync
  readonly #now: () => number

  constructor(database: DatabaseSync, now: () => number) {
    this.#database = database
    this.#now = now
  }

  #transaction<T>(fn: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.#database.exec('COMMIT')
      return value
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  /** Durable incremental feed cursor (`{ afterSeq: 0, afterRecordedAt: 0, afterId: '' }` initially). */
  syncCursor(): IntakeEvaluationFeedCursor {
    const row = this.#database.prepare(
      'SELECT after_seq, after_recorded_at, after_id FROM evaluation_intake_evaluation_sync_cursor WHERE id = 1',
    ).get() as { after_seq: number; after_recorded_at: number; after_id: string } | undefined
    return row === undefined
      ? Object.freeze({ afterSeq: 0, afterRecordedAt: 0, afterId: '' })
      : Object.freeze({ afterSeq: row.after_seq, afterRecordedAt: row.after_recorded_at, afterId: row.after_id })
  }

  /** Advance the durable cursor monotonically; identical or regressive writes are ignored/rejected. */
  advanceSyncCursor(next: IntakeEvaluationFeedCursor): boolean {
    const normalized = normalizeFeedCursor(next)
    if (normalized === null) return false
    return this.#transaction(() => {
      const existing = this.#database.prepare(
        'SELECT after_seq, after_recorded_at, after_id FROM evaluation_intake_evaluation_sync_cursor WHERE id = 1',
      ).get() as { after_seq: number; after_recorded_at: number; after_id: string } | undefined
      const now = this.#now()
      if (existing === undefined) {
        this.#database.prepare(`INSERT INTO evaluation_intake_evaluation_sync_cursor
          (id, after_seq, after_recorded_at, after_id, updated_at) VALUES (1, ?, ?, ?, ?)`)
          .run(normalized.afterSeq, normalized.afterRecordedAt, normalized.afterId, now)
        return true
      }
      const prev: IntakeEvaluationFeedCursor = {
        afterSeq: existing.after_seq,
        afterRecordedAt: existing.after_recorded_at,
        afterId: existing.after_id,
      }
      if (!cursorAdvances(normalized, prev)) return false
      this.#database.prepare(`UPDATE evaluation_intake_evaluation_sync_cursor
        SET after_seq = ?, after_recorded_at = ?, after_id = ?, updated_at = ? WHERE id = 1`)
        .run(normalized.afterSeq, normalized.afterRecordedAt, normalized.afterId, now)
      return true
    })
  }

  /** Look up local notification / owner feedback signals referencing `itemId`, plus inferred scope if needed. */
  #localSignals(itemId: string, expectedScopeKey: string | null): Readonly<{
    signals: CandidateSignal[]
    inferredScope: Readonly<{ scopeKey: string; scope: EvaluationScope }> | null
  }> {
    const signals: CandidateSignal[] = []
    let inferredScope: Readonly<{ scopeKey: string; scope: EvaluationScope }> | null = null

    const notifRows = this.#database.prepare(`
      SELECT h.notification_id, h.scope_key, h.outcome, h.occurred_at, r.record_json
      FROM evaluation_notification_outcome_heads h
      JOIN evaluation_notification_outcome_revisions r
        ON r.notification_id = h.notification_id AND r.version = h.version
      WHERE json_extract(r.record_json, '$.workItemId') = ?
        AND (? IS NULL OR h.scope_key = ?)
      ORDER BY h.occurred_at DESC, h.version DESC, h.notification_id DESC
    `).all(itemId, expectedScopeKey, expectedScopeKey) as Array<{
      notification_id: string
      scope_key: string
      outcome: NotificationOutcome
      occurred_at: number
      record_json: string
    }>
    for (const row of notifRows) {
      if (inferredScope === null) {
        try {
          const parsed = JSON.parse(row.record_json) as { scope?: { workspace?: string; preset?: string } }
          if (parsed?.scope?.workspace && parsed?.scope?.preset) {
            inferredScope = canonicalEvaluationScope({
              workspace: parsed.scope.workspace,
              preset: parsed.scope.preset,
            })
          }
        } catch { /* ignore malformed historical record */ }
      }
      if (POSITIVE_NOTIFICATIONS.has(row.outcome) || NEGATIVE_NOTIFICATIONS.has(row.outcome)) {
        signals.push({
          positive: POSITIVE_NOTIFICATIONS.has(row.outcome),
          source: 'notification-outcome',
          at: row.occurred_at,
          authorityRank: AUTHORITY_RANK['notification-outcome'],
          detail: { notificationId: row.notification_id, outcome: row.outcome },
        })
        break
      }
    }

    const projection = this.#database.prepare(`
      SELECT p.scope_key, p.learning_disposition, p.updated_at,
        o.id AS outcome_id, o.objective_status, o.occurred_at, o.source_kind, o.workspace, o.preset
      FROM evaluation_task_projections p
      JOIN evaluation_outcomes o ON o.id = COALESCE(p.objective_outcome_id, p.primary_outcome_id)
      WHERE p.subject_kind = 'work-item' AND p.subject_ref = ?
        AND o.source_kind = 'user-feedback'
        AND (? IS NULL OR p.scope_key = ?)
      ORDER BY p.updated_at DESC LIMIT 1
    `).get(itemId, expectedScopeKey, expectedScopeKey) as {
      scope_key: string
      learning_disposition: 'upsert' | 'retract' | null
      updated_at: number
      outcome_id: string
      objective_status: 'achieved' | 'partial' | 'not-achieved' | 'unknown'
      occurred_at: number
      source_kind: string
      workspace: string
      preset: string
    } | undefined
    if (projection !== undefined) {
      if (inferredScope === null) {
        inferredScope = canonicalEvaluationScope({
          workspace: projection.workspace,
          preset: projection.preset,
        })
      }
      if (projection.learning_disposition === 'retract') {
        signals.push({
          positive: false,
          source: 'owner-feedback',
          at: projection.occurred_at,
          authorityRank: AUTHORITY_RANK['owner-feedback'],
          detail: { outcomeId: projection.outcome_id, disposition: 'retract' },
        })
      } else if (projection.objective_status === 'achieved' || projection.objective_status === 'not-achieved') {
        signals.push({
          positive: projection.objective_status === 'achieved',
          source: 'owner-feedback',
          at: projection.occurred_at,
          authorityRank: AUTHORITY_RANK['owner-feedback'],
          detail: { outcomeId: projection.outcome_id, objectiveStatus: projection.objective_status },
        })
      }
    }

    return { signals, inferredScope }
  }

  #resolveDecision(
    itemId: string | null,
    scope: EvaluationScope | null,
    scopeKey: string | null,
    wouldAccept: boolean,
    feedSignals: NormalizedFeedItem['feedSignals'],
  ): Readonly<{
    outcomeKind: IntakeEvaluationOutcomeKind
    agreementStatus: IntakeEvaluationAgreementStatus
    outcomeSource: IntakeEvaluationOutcomeSource
    winning: CandidateSignal | null
    scope: EvaluationScope | null
    scopeKey: string | null
  }> {
    const candidates: CandidateSignal[] = []
    if (feedSignals.ownerCorrection?.kind === 'withdrawn' || feedSignals.outcome?.ownerWithdrawn) {
      candidates.push({
        positive: false,
        source: 'owner-withdrawal',
        at: feedSignals.ownerCorrection?.recordedAt ?? feedSignals.outcome?.settledAt ?? 0,
        authorityRank: AUTHORITY_RANK['owner-withdrawal'],
        detail: {
          settledBy: 'withdrawn',
          stateReason: feedSignals.ownerCorrection?.stateReason ?? null,
        },
      })
    }
    if (feedSignals.acceptanceVerdict !== null && feedSignals.acceptanceVerdict.objectiveStatus !== 'unknown') {
      candidates.push({
        positive: feedSignals.acceptanceVerdict.objectiveStatus === 'achieved',
        source: 'work-item-verdict',
        at: feedSignals.acceptanceVerdict.recordedAt,
        authorityRank: AUTHORITY_RANK['work-item-verdict'],
        detail: {
          objectiveStatus: feedSignals.acceptanceVerdict.objectiveStatus,
          receiptDigest: feedSignals.acceptanceVerdict.receiptDigest,
        },
      })
    }
    if (feedSignals.outcome !== null && !feedSignals.outcome.ownerWithdrawn) {
      const o = feedSignals.outcome
      if (o.evidenceState === 'observed' && o.objectiveStatus === 'achieved') {
        candidates.push({
          positive: true,
          source: 'work-item-outcome',
          at: o.recordedAt,
          authorityRank: AUTHORITY_RANK['work-item-outcome'],
          detail: { revision: o.revision, settledBy: o.settledBy, objectiveStatus: o.objectiveStatus },
        })
      } else if (o.objectiveStatus === 'not-achieved'
        || o.settledBy === 'report-failed' || o.settledBy === 'retry-exhausted' || o.settledBy === 'report-blocked') {
        candidates.push({
          positive: false,
          source: 'work-item-outcome',
          at: o.recordedAt,
          authorityRank: AUTHORITY_RANK['work-item-outcome'],
          detail: { revision: o.revision, settledBy: o.settledBy, objectiveStatus: o.objectiveStatus },
        })
      }
    }

    let resolvedScope = scope
    let resolvedScopeKey = scopeKey
    if (itemId !== null) {
      const local = this.#localSignals(itemId, resolvedScopeKey)
      candidates.push(...local.signals)
      if (resolvedScopeKey === null && local.inferredScope !== null) {
        resolvedScope = local.inferredScope.scope
        resolvedScopeKey = local.inferredScope.scopeKey
      }
    }

    candidates.sort((a, b) => (a.at !== b.at ? b.at - a.at : b.authorityRank - a.authorityRank))
    const winning = candidates[0]
    const classified = classifyAgreement(wouldAccept, winning)
    return Object.freeze({
      ...classified,
      winning: winning ?? null,
      scope: resolvedScope,
      scopeKey: resolvedScopeKey,
    })
  }

  #upsertInTx(input: {
    evalId: string
    source: string
    sourceEventId: string
    ruleId: string
    policyVersion: string
    mode: 'observe' | 'auto'
    evaluationLevel: 'ignore' | 'digest' | 'notify' | 'accept'
    wouldAccept: boolean
    evaluatedAt: number
    feedRecordedAt: number
    itemId: string | null
    scope: EvaluationScope | null
    scopeKey: string | null
    feedSignals: NormalizedFeedItem['feedSignals']
    now: number
  }): Readonly<{ head: StoredIntakeEvaluationAgreement; revised: boolean }> {
    const decision = this.#resolveDecision(input.itemId, input.scope, input.scopeKey, input.wouldAccept, input.feedSignals)
    const canonicalBody = {
      protocol: INTAKE_EVALUATION_AGREEMENT_PROTOCOL,
      evalId: input.evalId,
      source: input.source,
      sourceEventId: input.sourceEventId,
      ruleId: input.ruleId,
      policyVersion: input.policyVersion,
      scopeKey: decision.scopeKey,
      itemId: input.itemId,
      wouldAccept: input.wouldAccept,
      evaluationLevel: input.evaluationLevel,
      mode: input.mode,
      outcomeKind: decision.outcomeKind,
      agreementStatus: decision.agreementStatus,
      outcomeSource: decision.outcomeSource,
      winningSignal: decision.winning,
      feedSignals: input.feedSignals,
    }
    const digest = sha256(canonicalBody)
    const recordJson = canonical(canonicalBody)

    const existing = this.#database.prepare('SELECT * FROM evaluation_intake_evaluation_heads WHERE eval_id = ?')
      .get(input.evalId) as unknown as HeadDbRow | undefined
    if (existing === undefined) {
      this.#database.prepare(`INSERT INTO evaluation_intake_evaluation_heads (
        eval_id, source, source_event_id, rule_id, policy_version,
        scope_key, workspace, preset, item_id,
        would_accept, evaluation_level, mode,
        outcome_kind, agreement_status, outcome_source,
        evaluated_at, feed_recorded_at, version, latest_digest, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(
        input.evalId, input.source, input.sourceEventId, input.ruleId, input.policyVersion,
        decision.scopeKey, decision.scope?.workspace ?? null, decision.scope?.preset ?? null, input.itemId,
        input.wouldAccept ? 1 : 0, input.evaluationLevel, input.mode,
        decision.outcomeKind, decision.agreementStatus, decision.outcomeSource,
        input.evaluatedAt, input.feedRecordedAt, digest, input.now,
      )
      this.#database.prepare(`INSERT INTO evaluation_intake_evaluation_revisions
        (eval_id, version, outcome_kind, agreement_status, outcome_source, record_digest, record_json, recorded_at)
        VALUES (?,1,?,?,?,?,?,?)`).run(
        input.evalId, decision.outcomeKind, decision.agreementStatus, decision.outcomeSource,
        digest, recordJson, input.now,
      )
      const head = this.#database.prepare('SELECT * FROM evaluation_intake_evaluation_heads WHERE eval_id = ?')
        .get(input.evalId) as unknown as HeadDbRow
      return Object.freeze({ head: toStoredHead(head), revised: true })
    }

    if (existing.source !== input.source || existing.source_event_id !== input.sourceEventId
      || existing.rule_id !== input.ruleId || existing.policy_version !== input.policyVersion
      || (existing.would_accept === 1) !== input.wouldAccept || existing.evaluation_level !== input.evaluationLevel
      || existing.evaluated_at !== input.evaluatedAt) {
      throw new EvaluationStoreError('version-conflict', 'immutable intake evaluation fields disagree with persisted head')
    }
    if (existing.latest_digest === digest && input.feedRecordedAt <= existing.feed_recorded_at) {
      return Object.freeze({ head: toStoredHead(existing), revised: false })
    }
    if (existing.latest_digest === digest) {
      return Object.freeze({ head: toStoredHead(existing), revised: false })
    }

    const nextVersion = existing.version + 1
    const nextFeedRecordedAt = Math.max(existing.feed_recorded_at, input.feedRecordedAt)
    this.#database.prepare(`UPDATE evaluation_intake_evaluation_heads SET
      scope_key = ?, workspace = ?, preset = ?, item_id = ?,
      outcome_kind = ?, agreement_status = ?, outcome_source = ?,
      feed_recorded_at = ?, version = ?, latest_digest = ?, updated_at = ?
      WHERE eval_id = ?`).run(
      decision.scopeKey, decision.scope?.workspace ?? null, decision.scope?.preset ?? null, input.itemId,
      decision.outcomeKind, decision.agreementStatus, decision.outcomeSource,
      nextFeedRecordedAt, nextVersion, digest, input.now, input.evalId,
    )
    this.#database.prepare(`INSERT INTO evaluation_intake_evaluation_revisions
      (eval_id, version, outcome_kind, agreement_status, outcome_source, record_digest, record_json, recorded_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      input.evalId, nextVersion, decision.outcomeKind, decision.agreementStatus, decision.outcomeSource,
      digest, recordJson, input.now,
    )
    const updated = this.#database.prepare('SELECT * FROM evaluation_intake_evaluation_heads WHERE eval_id = ?')
      .get(input.evalId) as unknown as HeadDbRow
    return Object.freeze({ head: toStoredHead(updated), revised: true })
  }

  /** Validate and apply one feed item against canonical state and local owner outcomes. */
  applyFeedItem(rawItem: unknown): Readonly<{ head: StoredIntakeEvaluationAgreement; revised: boolean }> {
    const normalized = normalizeFeedItem(rawItem)
    return this.#transaction(() => this.#upsertInTx({
      evalId: normalized.evalId,
      source: normalized.source,
      sourceEventId: normalized.sourceEventId,
      ruleId: normalized.ruleId,
      policyVersion: normalized.policyVersion,
      mode: normalized.mode,
      evaluationLevel: normalized.evaluationLevel,
      wouldAccept: normalized.wouldAccept,
      evaluatedAt: normalized.evaluatedAt,
      feedRecordedAt: normalized.recordedAt,
      itemId: normalized.itemId,
      scope: normalized.scope,
      scopeKey: normalized.scopeKey,
      feedSignals: normalized.feedSignals,
      now: this.#now(),
    }))
  }

  /**
   * Re-evaluate correlations for already-ingested heads that name a `workItemId`
   * so late local notification reactions or owner feedback revisions produce a
   * new immutable agreement revision even without a new WorkItems feed row.
   */
  reconcileLocalCorrelations(limit = 500): Readonly<{ checked: number; revised: number }> {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 2000))
    return this.#transaction(() => {
      const now = this.#now()
      const rows = this.#database.prepare(`
        SELECT h.*, r.record_json
        FROM evaluation_intake_evaluation_heads h
        JOIN evaluation_intake_evaluation_revisions r
          ON r.eval_id = h.eval_id AND r.version = h.version
        WHERE h.item_id IS NOT NULL AND (
          EXISTS (
            SELECT 1 FROM evaluation_notification_outcome_heads nh
            JOIN evaluation_notification_outcome_revisions nr
              ON nr.notification_id = nh.notification_id AND nr.version = nh.version
            WHERE json_extract(nr.record_json, '$.workItemId') = h.item_id
          )
          OR EXISTS (
            SELECT 1 FROM evaluation_task_projections tp
            WHERE tp.subject_kind = 'work-item' AND tp.subject_ref = h.item_id
          )
        )
        ORDER BY h.updated_at ASC, h.eval_id ASC
        LIMIT ?
      `).all(safeLimit) as unknown as Array<HeadDbRow & { record_json: string }>
      let revised = 0
      for (const row of rows) {
        let feedSignals: NormalizedFeedItem['feedSignals']
        try {
          const parsed = JSON.parse(row.record_json) as { feedSignals?: NormalizedFeedItem['feedSignals'] }
          feedSignals = parsed.feedSignals ?? {
            metadataDigest: '0'.repeat(64),
            sourceDigest: '0'.repeat(64),
            contentDigest: null,
            outcome: null,
            acceptanceVerdict: null,
            ownerCorrection: null,
          }
        } catch {
          continue
        }
        const scope = row.workspace !== null && row.preset !== null
          ? Object.freeze({ workspace: row.workspace, preset: row.preset })
          : null
        const result = this.#upsertInTx({
          evalId: row.eval_id,
          source: row.source,
          sourceEventId: row.source_event_id,
          ruleId: row.rule_id,
          policyVersion: row.policy_version,
          mode: row.mode,
          evaluationLevel: row.evaluation_level,
          wouldAccept: row.would_accept === 1,
          evaluatedAt: row.evaluated_at,
          feedRecordedAt: row.feed_recorded_at,
          itemId: row.item_id,
          scope,
          scopeKey: row.scope_key,
          feedSignals,
          now,
        })
        if (result.revised) revised += 1
      }
      return Object.freeze({ checked: rows.length, revised })
    })
  }

  /** Total distinct intake evaluation heads persisted. */
  count(): number {
    const row = this.#database.prepare('SELECT COUNT(*) AS count FROM evaluation_intake_evaluation_heads').get() as { count: number }
    return row.count
  }

  /** Full revision history for one intake evaluation key or evalId. */
  history(input: { evalId?: string; source?: string; sourceEventId?: string; ruleId?: string; policyVersion?: string }): IntakeEvaluationAgreementHistory | undefined {
    const evalId = input.evalId !== undefined
      ? input.evalId
      : input.source && input.sourceEventId && input.ruleId && input.policyVersion
        ? intakeEvaluationCanonicalId(input.source, input.sourceEventId, input.ruleId, input.policyVersion)
        : invalid('history lookup requires evalId or (source, sourceEventId, ruleId, policyVersion)')
    const headRow = this.#database.prepare('SELECT * FROM evaluation_intake_evaluation_heads WHERE eval_id = ?')
      .get(evalId) as unknown as HeadDbRow | undefined
    if (headRow === undefined) return undefined
    const revRows = this.#database.prepare(`SELECT eval_id, version, outcome_kind, agreement_status, outcome_source, record_digest, record_json, recorded_at
      FROM evaluation_intake_evaluation_revisions WHERE eval_id = ? ORDER BY version ASC`).all(evalId) as Array<{
      eval_id: string
      version: number
      outcome_kind: IntakeEvaluationOutcomeKind
      agreement_status: IntakeEvaluationAgreementStatus
      outcome_source: IntakeEvaluationOutcomeSource
      record_digest: string
      record_json: string
      recorded_at: number
    }>
    const revisions = Object.freeze(revRows.map(rev => {
      let feedSignals: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(rev.record_json) as { feedSignals?: Record<string, unknown> }
        if (parsed.feedSignals) feedSignals = parsed.feedSignals
      } catch { /* ignore */ }
      return Object.freeze({
        evalId: rev.eval_id,
        version: rev.version,
        outcomeKind: rev.outcome_kind,
        agreementStatus: rev.agreement_status,
        outcomeSource: rev.outcome_source,
        digest: rev.record_digest,
        recordedAt: rev.recorded_at,
        feedSignals: Object.freeze(feedSignals),
      })
    }))
    return Object.freeze({ head: toStoredHead(headRow), revisions })
  }

  /** Paginated list of stored canonical intake evaluation agreement heads. */
  list(options: {
    scope?: EvaluationScope
    source?: string
    ruleId?: string
    agreementStatus?: IntakeEvaluationAgreementStatus
    afterEvaluatedAt?: number
    afterEvalId?: string
    limit?: number
  } = {}): Readonly<{
    items: readonly StoredIntakeEvaluationAgreement[]
    hasMore: boolean
    nextCursor: Readonly<{ afterEvaluatedAt: number; afterEvalId: string }> | null
  }> {
    const scopeKey = options.scope === undefined ? null : canonicalEvaluationScope(options.scope).scopeKey
    const source = options.source === undefined ? null : nonEmptyString(options.source, 'source', 64)
    const ruleId = options.ruleId === undefined ? null : nonEmptyString(options.ruleId, 'ruleId', 256)
    const agreementStatus = options.agreementStatus ?? null
    const limit = options.limit === undefined ? 100 : Math.max(1, Math.min(Math.trunc(options.limit), 500))
    const hasCursor = options.afterEvaluatedAt !== undefined || options.afterEvalId !== undefined
    if (hasCursor && (options.afterEvaluatedAt === undefined || options.afterEvalId === undefined)) {
      invalid('afterEvaluatedAt and afterEvalId must be provided together')
    }
    const afterAt = options.afterEvaluatedAt ?? -1
    const afterId = options.afterEvalId ?? ''
    const rows = this.#database.prepare(`
      SELECT * FROM evaluation_intake_evaluation_heads
      WHERE (? IS NULL OR scope_key = ?)
        AND (? IS NULL OR source = ?)
        AND (? IS NULL OR rule_id = ?)
        AND (? IS NULL OR agreement_status = ?)
        AND (? < 0 OR (evaluated_at, eval_id) > (?, ?))
      ORDER BY evaluated_at ASC, eval_id ASC
      LIMIT ?
    `).all(
      scopeKey, scopeKey,
      source, source,
      ruleId, ruleId,
      agreementStatus, agreementStatus,
      afterAt, afterAt, afterId,
      limit + 1,
    ) as unknown as HeadDbRow[]
    const hasMore = rows.length > limit
    const items = Object.freeze(rows.slice(0, limit).map(toStoredHead))
    const last = items.at(-1)
    const nextCursor = last === undefined ? null : Object.freeze({ afterEvaluatedAt: last.evaluatedAt, afterEvalId: last.evalId })
    return Object.freeze({ items, hasMore, nextCursor })
  }

  /** Summary metrics over persisted intake evaluations in canonical state. */
  summary(options: {
    scope?: EvaluationScope
    source?: string
    ruleId?: string
    fromEvaluatedAt?: number
    toEvaluatedAt?: number
  } = {}): IntakeEvaluationAgreementSummary {
    const scopeInfo = options.scope === undefined ? null : canonicalEvaluationScope(options.scope)
    const scopeKey = scopeInfo?.scopeKey ?? null
    const source = options.source === undefined ? null : nonEmptyString(options.source, 'source', 64)
    const ruleId = options.ruleId === undefined ? null : nonEmptyString(options.ruleId, 'ruleId', 256)
    const fromEvaluatedAt = options.fromEvaluatedAt === undefined ? 0 : nonNegInt(options.fromEvaluatedAt, 'fromEvaluatedAt')
    const toEvaluatedAt = options.toEvaluatedAt === undefined ? this.#now() + 1 : nonNegInt(options.toEvaluatedAt, 'toEvaluatedAt')
    if (toEvaluatedAt <= fromEvaluatedAt) invalid('summary window is empty or reversed')
    const rows = this.#database.prepare(`
      SELECT agreement_status, COUNT(*) AS count
      FROM evaluation_intake_evaluation_heads
      WHERE (? IS NULL OR scope_key = ?)
        AND (? IS NULL OR source = ?)
        AND (? IS NULL OR rule_id = ?)
        AND evaluated_at >= ? AND evaluated_at < ?
      GROUP BY agreement_status
    `).all(scopeKey, scopeKey, source, source, ruleId, ruleId, fromEvaluatedAt, toEvaluatedAt) as Array<{
      agreement_status: IntakeEvaluationAgreementStatus
      count: number
    }>
    const countOf = (status: IntakeEvaluationAgreementStatus) => rows.find(r => r.agreement_status === status)?.count ?? 0
    const truePositive = countOf('true-positive')
    const falsePositive = countOf('false-positive')
    const falseNegative = countOf('false-negative')
    const trueNegative = countOf('true-negative')
    const pending = countOf('pending')
    const agreed = truePositive + trueNegative
    const disagreed = falsePositive + falseNegative
    const decided = agreed + disagreed
    const acceptedTotal = truePositive + falsePositive
    const rejectedTotal = trueNegative + falseNegative
    return Object.freeze({
      protocol: INTAKE_EVALUATION_AGREEMENT_PROTOCOL,
      scope: scopeInfo?.scope ?? null,
      source,
      ruleId,
      fromEvaluatedAt,
      toEvaluatedAt,
      total: decided + pending,
      truePositive,
      falsePositive,
      falseNegative,
      trueNegative,
      pending,
      agreed,
      disagreed,
      decided,
      agreementPpm: decided === 0 ? null : Math.floor((agreed * 1_000_000) / decided),
      falsePositiveRatePpm: acceptedTotal === 0 ? null : Math.floor((falsePositive * 1_000_000) / acceptedTotal),
      falseNegativeRatePpm: rejectedTotal === 0 ? null : Math.floor((falseNegative * 1_000_000) / rejectedTotal),
    })
  }
}
