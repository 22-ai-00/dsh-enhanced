import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { evaluationSchemaVersion, openEvaluationDatabase } from './sqlite.js'
import {
  deliveryStatuses,
  executionStatuses,
  objectiveStatuses,
  outcomeSourceKinds,
  outcomeTrustLevels,
} from './types.js'
import type {
  DeliveryStatus,
  EvaluationEvidenceRef,
  EvaluationHealth,
  EvaluationJson,
  EvaluationMetrics,
  EvaluationScope,
  ExecutionStatus,
  ObjectiveStatus,
  OutcomeEnvelope,
  OutcomeQuery,
  OutcomeSourceKind,
  OutcomeSummary,
  OutcomeSummaryQuery,
  OutcomeTrust,
  SelfAssessmentInput,
  StoredSelfAssessment,
  StoredOutcome,
} from './types.js'

export type EvaluationStoreErrorCode = 'idempotency-conflict' | 'invalid-input' | 'not-found'

export class EvaluationStoreError extends Error {
  constructor(readonly code: EvaluationStoreErrorCode, message: string) {
    super(message)
    this.name = 'EvaluationStoreError'
  }
}

export interface EvaluationStoreOptions {
  path: string
  now?: () => number
  maxQueryLimit?: number
  maxSituationBytes?: number
  maxMetricsBytes?: number
  maxEvidenceRefs?: number
  maxSummaryWindowMs?: number
  defaultSummaryWindowMs?: number
}

interface OutcomeRow {
  id: string
  idempotency_key: string
  payload_hash: string
  scope_key: string
  workspace: string
  preset: string
  situation: string
  execution_status: ExecutionStatus
  objective_status: ObjectiveStatus
  delivery_status: DeliveryStatus
  source_kind: OutcomeSourceKind
  source_id: string
  trust: OutcomeTrust
  evidence_json: string
  metrics_json: string
  occurred_at: number
  recorded_at: number
  evaluator_id: string
  evaluator_version: string
}

interface NormalizedEnvelope extends OutcomeEnvelope {
  scopeKey: string
}

interface SelfAssessmentRow {
  id: string
  outcome_id: string
  idempotency_key: string
  payload_hash: string
  scope_key: string
  objective_status: ObjectiveStatus
  evidence_json: string
  occurred_at: number
  recorded_at: number
  evaluator_id: string
  evaluator_version: string
  workspace: string
  preset: string
  situation: string
  execution_status: ExecutionStatus
  delivery_status: DeliveryStatus
}

const standardIntegerMetrics = new Set([
  'costUsdMicros', 'latencyMs', 'inputTokens', 'outputTokens', 'toolCalls', 'retries',
])

function boundedText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string') throw new EvaluationStoreError('invalid-input', `${label} must be a string`)
  const normalized = value.normalize('NFC').trim()
  if (normalized === '' || Buffer.byteLength(normalized) > maxBytes) {
    throw new EvaluationStoreError('invalid-input', `${label} must contain 1-${maxBytes} UTF-8 bytes`)
  }
  return normalized
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new EvaluationStoreError('invalid-input', `${label} must be a non-negative safe integer`)
  }
  return value as number
}

export function canonicalEvaluationScope(input: EvaluationScope): { scope: EvaluationScope; scopeKey: string } {
  const workspace = boundedText(input.workspace, 'scope.workspace', 4_096)
  if (!isAbsolute(workspace)) {
    throw new EvaluationStoreError('invalid-input', 'scope.workspace must be absolute')
  }
  const scope = Object.freeze({ workspace: resolve(workspace), preset: boundedText(input.preset, 'scope.preset', 200) })
  return { scope, scopeKey: JSON.stringify([scope.workspace, scope.preset]) }
}

function canonicalJson(
  value: unknown,
  label: string,
  state: { nodes: number },
  depth = 0,
): EvaluationJson {
  state.nodes += 1
  if (state.nodes > 128 || depth > 4) {
    throw new EvaluationStoreError('invalid-input', `${label} exceeds the JSON complexity limit`)
  }
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      throw new EvaluationStoreError('invalid-input', `${label} contains an invalid number`)
    }
    return value
  }
  if (typeof value === 'string') {
    const normalized = value.normalize('NFC')
    if (Buffer.byteLength(normalized) > 256) {
      throw new EvaluationStoreError('invalid-input', `${label} contains an oversized string`)
    }
    return normalized
  }
  if (Array.isArray(value)) {
    if (value.length > 32) throw new EvaluationStoreError('invalid-input', `${label} contains an oversized array`)
    return value.map((entry, index) => canonicalJson(entry, `${label}[${index}]`, state, depth + 1))
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new EvaluationStoreError('invalid-input', `${label} must contain JSON values only`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new EvaluationStoreError('invalid-input', `${label} must contain plain JSON objects only`)
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 32) throw new EvaluationStoreError('invalid-input', `${label} contains too many keys`)
  const output: Record<string, EvaluationJson> = {}
  for (const [rawKey, entry] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    const key = boundedText(rawKey, `${label} key`, 64)
    if (['__proto__', 'constructor', 'prototype'].includes(key) || key in output) {
      throw new EvaluationStoreError('invalid-input', `${label} contains an unsafe or duplicate key`)
    }
    if (entry === undefined) throw new EvaluationStoreError('invalid-input', `${label}.${key} must be JSON`)
    output[key] = canonicalJson(entry, `${label}.${key}`, state, depth + 1)
  }
  return output
}

function metrics(input: EvaluationMetrics, maxBytes: number): EvaluationMetrics {
  const normalized = canonicalJson(input, 'metrics', { nodes: 0 })
  if (Array.isArray(normalized) || normalized === null || typeof normalized !== 'object') {
    throw new EvaluationStoreError('invalid-input', 'metrics must be a JSON object')
  }
  const object = normalized as Readonly<Record<string, EvaluationJson>>
  for (const key of standardIntegerMetrics) {
    const value = object[key]
    if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) {
      throw new EvaluationStoreError('invalid-input', `metrics.${key} must be a non-negative safe integer`)
    }
  }
  if (Buffer.byteLength(JSON.stringify(normalized)) > maxBytes) {
    throw new EvaluationStoreError('invalid-input', `metrics exceeds the ${maxBytes}-byte limit`)
  }
  return Object.freeze(object) as EvaluationMetrics
}

function evidence(input: readonly EvaluationEvidenceRef[], maximum: number): readonly EvaluationEvidenceRef[] {
  if (!Array.isArray(input) || input.length > maximum) {
    throw new EvaluationStoreError('invalid-input', `evidence exceeds the ${maximum}-reference limit`)
  }
  return Object.freeze(input.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new EvaluationStoreError('invalid-input', `evidence[${index}] must be an object`)
    }
    const kind = boundedText(entry.kind, `evidence[${index}].kind`, 64)
    const ref = boundedText(entry.ref, `evidence[${index}].ref`, 512)
    const digest = entry.digest === undefined
      ? undefined
      : boundedText(entry.digest, `evidence[${index}].digest`, 128)
    return Object.freeze({ kind, ref, ...(digest === undefined ? {} : { digest }) })
  }))
}

function oneOf<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new EvaluationStoreError('invalid-input', `${label} is invalid`)
  }
  return value as T
}

function stored(row: OutcomeRow): StoredOutcome {
  return Object.freeze({
    id: row.id,
    idempotencyKey: row.idempotency_key,
    scopeKey: row.scope_key,
    scope: Object.freeze({ workspace: row.workspace, preset: row.preset }),
    situation: row.situation,
    executionStatus: row.execution_status,
    objectiveStatus: row.objective_status,
    deliveryStatus: row.delivery_status,
    source: Object.freeze({ kind: row.source_kind, id: row.source_id }),
    trust: row.trust,
    evidence: Object.freeze(JSON.parse(row.evidence_json) as EvaluationEvidenceRef[]),
    metrics: Object.freeze(JSON.parse(row.metrics_json) as EvaluationMetrics),
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    evaluator: Object.freeze({ id: row.evaluator_id, version: row.evaluator_version }),
  })
}

function selfAssessment(row: SelfAssessmentRow): StoredSelfAssessment {
  return Object.freeze({
    id: row.id,
    outcomeId: row.outcome_id,
    idempotencyKey: row.idempotency_key,
    scopeKey: row.scope_key,
    scope: Object.freeze({ workspace: row.workspace, preset: row.preset }),
    situation: row.situation,
    executionStatus: row.execution_status,
    objectiveStatus: row.objective_status,
    deliveryStatus: row.delivery_status,
    trust: 'self-reported' as const,
    evidence: Object.freeze(JSON.parse(row.evidence_json) as EvaluationEvidenceRef[]),
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    evaluator: Object.freeze({ id: row.evaluator_id, version: row.evaluator_version }),
  })
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export class EvaluationStore {
  readonly #database: DatabaseSync
  readonly #now: () => number
  readonly #maxQueryLimit: number
  readonly #maxSituationBytes: number
  readonly #maxMetricsBytes: number
  readonly #maxEvidenceRefs: number
  readonly #maxSummaryWindowMs: number
  readonly #defaultSummaryWindowMs: number

  constructor(options: EvaluationStoreOptions) {
    this.#database = openEvaluationDatabase(options.path)
    this.#now = options.now ?? Date.now
    this.#maxQueryLimit = options.maxQueryLimit ?? 100
    this.#maxSituationBytes = options.maxSituationBytes ?? 200
    this.#maxMetricsBytes = options.maxMetricsBytes ?? 4_096
    this.#maxEvidenceRefs = options.maxEvidenceRefs ?? 32
    this.#maxSummaryWindowMs = options.maxSummaryWindowMs ?? 31_536_000_000
    this.#defaultSummaryWindowMs = options.defaultSummaryWindowMs
      ?? Math.min(2_592_000_000, this.#maxSummaryWindowMs)
    for (const [label, value] of [
      ['maxQueryLimit', this.#maxQueryLimit], ['maxSituationBytes', this.#maxSituationBytes],
      ['maxMetricsBytes', this.#maxMetricsBytes], ['maxEvidenceRefs', this.#maxEvidenceRefs],
      ['maxSummaryWindowMs', this.#maxSummaryWindowMs], ['defaultSummaryWindowMs', this.#defaultSummaryWindowMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        this.#database.close()
        throw new EvaluationStoreError('invalid-input', `${label} must be a positive safe integer`)
      }
    }
    if (this.#defaultSummaryWindowMs > this.#maxSummaryWindowMs) {
      this.#database.close()
      throw new EvaluationStoreError('invalid-input', 'default summary window exceeds the maximum window')
    }
  }

  close(): void { this.#database.close() }

  getOutcome(scopeInput: EvaluationScope, outcomeIdInput: string): StoredOutcome | undefined {
    const { scopeKey } = canonicalEvaluationScope(scopeInput)
    const outcomeId = boundedText(outcomeIdInput, 'outcomeId', 200)
    const row = this.#database.prepare(`
      SELECT * FROM evaluation_outcomes WHERE id = ? AND scope_key = ?
    `).get(outcomeId, scopeKey) as unknown as OutcomeRow | undefined
    return row === undefined ? undefined : stored(row)
  }

  append(input: OutcomeEnvelope): StoredOutcome {
    const normalized = this.#normalize(input)
    const payloadHash = digest(normalized)
    const id = `outcome-${randomUUID()}`
    const recordedAt = timestamp(this.#now(), 'recordedAt')
    const metric = normalized.metrics
    this.#database.prepare(`
      INSERT INTO evaluation_outcomes(
        id, idempotency_key, payload_hash, scope_key, workspace, preset, situation,
        execution_status, objective_status, delivery_status, source_kind, source_id,
        trust, evidence_json, metrics_json, cost_usd_micros, latency_ms, input_tokens,
        output_tokens, tool_calls, occurred_at, recorded_at, evaluator_id, evaluator_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(
      id, normalized.idempotencyKey, payloadHash, normalized.scopeKey,
      normalized.scope.workspace, normalized.scope.preset, normalized.situation,
      normalized.executionStatus, normalized.objectiveStatus, normalized.deliveryStatus,
      normalized.source.kind, normalized.source.id, normalized.trust,
      JSON.stringify(normalized.evidence), JSON.stringify(normalized.metrics),
      metric.costUsdMicros ?? null, metric.latencyMs ?? null, metric.inputTokens ?? null,
      metric.outputTokens ?? null, metric.toolCalls ?? null, normalized.occurredAt,
      recordedAt, normalized.evaluator.id, normalized.evaluator.version,
    )
    const winner = this.#database.prepare('SELECT * FROM evaluation_outcomes WHERE idempotency_key = ?')
      .get(normalized.idempotencyKey) as unknown as OutcomeRow
    if (winner.payload_hash !== payloadHash) {
      throw new EvaluationStoreError(
        'idempotency-conflict',
        'evaluation outcome idempotency key was reused with different content',
      )
    }
    return stored(winner)
  }

  /**
   * Append a self-reported objective judgement linked to an immutable Host
   * outcome. Execution and delivery are inherited, metrics are not copied, and
   * the assessment never participates in the trusted outcome count.
   */
  appendSelfAssessment(input: SelfAssessmentInput): StoredSelfAssessment {
    const { scope, scopeKey } = canonicalEvaluationScope(input.scope)
    const outcomeId = boundedText(input.outcomeId, 'outcomeId', 200)
    const target = this.#database.prepare('SELECT * FROM evaluation_outcomes WHERE id = ?')
      .get(outcomeId) as unknown as OutcomeRow | undefined
    if (target === undefined) throw new EvaluationStoreError('not-found', 'self-assessment outcome was not found')
    if (target.scope_key !== scopeKey) {
      throw new EvaluationStoreError('invalid-input', 'self-assessment scope does not match the referenced outcome')
    }
    const normalized = Object.freeze({
      outcomeId,
      scope,
      scopeKey,
      objectiveStatus: oneOf(input.objectiveStatus, objectiveStatuses, 'objectiveStatus'),
      evidence: evidence(input.evidence, this.#maxEvidenceRefs),
      occurredAt: timestamp(input.occurredAt, 'occurredAt'),
      idempotencyKey: boundedText(input.idempotencyKey, 'idempotencyKey', 200),
      evaluator: Object.freeze({
        id: boundedText(input.evaluator?.id, 'evaluator.id', 200),
        version: boundedText(input.evaluator?.version, 'evaluator.version', 100),
      }),
    })
    const payloadHash = digest(normalized)
    const recordedAt = timestamp(this.#now(), 'recordedAt')
    this.#database.prepare(`
      INSERT INTO evaluation_self_assessments(
        id, outcome_id, idempotency_key, payload_hash, scope_key,
        objective_status, evidence_json, occurred_at, recorded_at, evaluator_id, evaluator_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(
      `assessment-${randomUUID()}`,
      outcomeId,
      normalized.idempotencyKey,
      payloadHash,
      scopeKey,
      normalized.objectiveStatus,
      JSON.stringify(normalized.evidence),
      normalized.occurredAt,
      recordedAt,
      normalized.evaluator.id,
      normalized.evaluator.version,
    )
    const winner = this.#database.prepare(`
      SELECT assessment.*, outcome.workspace, outcome.preset, outcome.situation,
        outcome.execution_status, outcome.delivery_status
      FROM evaluation_self_assessments assessment
      JOIN evaluation_outcomes outcome ON outcome.id = assessment.outcome_id
      WHERE assessment.idempotency_key = ?
    `).get(normalized.idempotencyKey) as unknown as SelfAssessmentRow
    if (winner.payload_hash !== payloadHash) {
      throw new EvaluationStoreError(
        'idempotency-conflict',
        'self-assessment idempotency key was reused with different content',
      )
    }
    return selfAssessment(winner)
  }

  /** Latest self-report for each requested parent, preserving parent order. */
  latestSelfAssessments(
    scopeInput: EvaluationScope,
    outcomeIdsInput: readonly string[],
  ): StoredSelfAssessment[] {
    const { scopeKey } = canonicalEvaluationScope(scopeInput)
    if (!Array.isArray(outcomeIdsInput) || outcomeIdsInput.length > this.#maxQueryLimit) {
      throw new EvaluationStoreError('invalid-input', 'self-assessment parent query exceeds the limit')
    }
    const outcomeIds = outcomeIdsInput.map(id => boundedText(id, 'outcomeId', 200))
    if (new Set(outcomeIds).size !== outcomeIds.length) {
      throw new EvaluationStoreError('invalid-input', 'self-assessment parent query contains a duplicate')
    }
    if (outcomeIds.length === 0) return []
    const placeholders = outcomeIds.map(() => '?').join(', ')
    const rows = this.#database.prepare(`
      SELECT assessment.*, outcome.workspace, outcome.preset, outcome.situation,
        outcome.execution_status, outcome.delivery_status
      FROM evaluation_self_assessments assessment
      JOIN evaluation_outcomes outcome ON outcome.id = assessment.outcome_id
      WHERE assessment.scope_key = ? AND assessment.outcome_id IN (${placeholders})
      ORDER BY assessment.occurred_at DESC, assessment.id DESC
    `).all(scopeKey, ...outcomeIds) as unknown as SelfAssessmentRow[]
    const latest = new Map<string, StoredSelfAssessment>()
    for (const row of rows) {
      if (!latest.has(row.outcome_id)) latest.set(row.outcome_id, selfAssessment(row))
    }
    return outcomeIds.flatMap(id => {
      const assessment = latest.get(id)
      return assessment === undefined ? [] : [assessment]
    })
  }

  query(input: OutcomeQuery): StoredOutcome[] {
    const { scopeKey } = canonicalEvaluationScope(input.scope)
    const limit = input.limit ?? Math.min(50, this.#maxQueryLimit)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.#maxQueryLimit) {
      throw new EvaluationStoreError('invalid-input', `query limit must be between 1 and ${this.#maxQueryLimit}`)
    }
    const clauses = ['scope_key = ?']
    const parameters: Array<string | number> = [scopeKey]
    const add = (column: string, value: string | number | undefined) => {
      if (value === undefined) return
      clauses.push(`${column} = ?`)
      parameters.push(value)
    }
    add('situation', input.situation === undefined ? undefined : this.#situation(input.situation))
    add('execution_status', input.executionStatus === undefined
      ? undefined : oneOf(input.executionStatus, executionStatuses, 'executionStatus'))
    add('objective_status', input.objectiveStatus === undefined
      ? undefined : oneOf(input.objectiveStatus, objectiveStatuses, 'objectiveStatus'))
    add('delivery_status', input.deliveryStatus === undefined
      ? undefined : oneOf(input.deliveryStatus, deliveryStatuses, 'deliveryStatus'))
    add('source_kind', input.sourceKind === undefined
      ? undefined : oneOf(input.sourceKind, outcomeSourceKinds, 'sourceKind'))
    add('trust', input.trust === undefined ? undefined : oneOf(input.trust, outcomeTrustLevels, 'trust'))
    if (input.excludeSituationPrefix !== undefined) {
      const prefix = this.#situation(input.excludeSituationPrefix)
      clauses.push('substr(situation, 1, length(?)) <> ?')
      parameters.push(prefix, prefix)
    }
    const [from, to] = this.#optionalRange(input.fromOccurredAt, input.toOccurredAt)
    if (from !== undefined) { clauses.push('occurred_at >= ?'); parameters.push(from) }
    if (to !== undefined) { clauses.push('occurred_at <= ?'); parameters.push(to) }
    parameters.push(limit)
    const rows = this.#database.prepare(`
      SELECT * FROM evaluation_outcomes WHERE ${clauses.join(' AND ')}
      ORDER BY occurred_at DESC, id DESC LIMIT ?
    `).all(...parameters) as unknown as OutcomeRow[]
    return rows.map(row => stored(row))
  }

  summary(input: OutcomeSummaryQuery): OutcomeSummary {
    const { scope, scopeKey } = canonicalEvaluationScope(input.scope)
    const [fromOccurredAt, toOccurredAt] = this.#summaryRange(input.fromOccurredAt, input.toOccurredAt)
    const situation = input.situation === undefined ? undefined : this.#situation(input.situation)
    const excludeSituationPrefix = input.excludeSituationPrefix === undefined
      ? undefined
      : this.#situation(input.excludeSituationPrefix)
    const row = this.#database.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(execution_status = 'succeeded') AS execution_succeeded,
        SUM(execution_status = 'failed') AS execution_failed,
        SUM(execution_status = 'timed-out') AS execution_timed_out,
        SUM(execution_status = 'cancelled') AS execution_cancelled,
        SUM(execution_status = 'unknown') AS execution_unknown,
        SUM(objective_status = 'achieved') AS objective_achieved,
        SUM(objective_status = 'partial') AS objective_partial,
        SUM(objective_status = 'not-achieved') AS objective_not_achieved,
        SUM(objective_status = 'unknown') AS objective_unknown,
        SUM(delivery_status = 'delivered') AS delivery_delivered,
        SUM(delivery_status = 'failed') AS delivery_failed,
        SUM(delivery_status = 'not-required') AS delivery_not_required,
        SUM(delivery_status = 'unknown') AS delivery_unknown,
        SUM(trust = 'trusted') AS trust_trusted,
        SUM(trust = 'self-reported') AS trust_self_reported,
        SUM(trust = 'external') AS trust_external,
        TOTAL(cost_usd_micros) AS cost_usd_micros,
        TOTAL(input_tokens) AS input_tokens,
        TOTAL(output_tokens) AS output_tokens,
        TOTAL(tool_calls) AS tool_calls,
        TOTAL(latency_ms) AS latency_total,
        COUNT(latency_ms) AS latency_count
      FROM evaluation_outcomes
      WHERE scope_key = ? AND occurred_at >= ? AND occurred_at <= ?
        AND (? IS NULL OR situation = ?)
        AND (? IS NULL OR substr(situation, 1, length(?)) <> ?)
    `).get(
      scopeKey,
      fromOccurredAt,
      toOccurredAt,
      situation ?? null,
      situation ?? null,
      excludeSituationPrefix ?? null,
      excludeSituationPrefix ?? null,
      excludeSituationPrefix ?? null,
    ) as Record<string, number>
    const count = (key: string) => row[key] ?? 0
    const latencyCount = count('latency_count')
    return Object.freeze({
      scope,
      scopeKey,
      ...(situation === undefined ? {} : { situation }),
      fromOccurredAt,
      toOccurredAt,
      total: count('total'),
      execution: Object.freeze({
        succeeded: count('execution_succeeded'), failed: count('execution_failed'),
        timedOut: count('execution_timed_out'), cancelled: count('execution_cancelled'), unknown: count('execution_unknown'),
      }),
      objective: Object.freeze({
        achieved: count('objective_achieved'), partial: count('objective_partial'),
        notAchieved: count('objective_not_achieved'), unknown: count('objective_unknown'),
      }),
      delivery: Object.freeze({
        delivered: count('delivery_delivered'), failed: count('delivery_failed'),
        notRequired: count('delivery_not_required'), unknown: count('delivery_unknown'),
      }),
      trust: Object.freeze({
        trusted: count('trust_trusted'), selfReported: count('trust_self_reported'), external: count('trust_external'),
      }),
      metrics: Object.freeze({
        costUsdMicros: count('cost_usd_micros'), inputTokens: count('input_tokens'),
        outputTokens: count('output_tokens'), toolCalls: count('tool_calls'),
        ...(latencyCount === 0 ? {} : { averageLatencyMs: Math.round(count('latency_total') / latencyCount) }),
      }),
    })
  }

  health(): EvaluationHealth {
    const row = this.#database.prepare(`
      SELECT COUNT(*) AS outcomes,
        SUM(trust = 'trusted') AS trusted,
        SUM(trust = 'self-reported') AS self_reported,
        SUM(trust = 'external') AS external,
        MAX(occurred_at) AS latest
      FROM evaluation_outcomes
    `).get() as { outcomes: number; trusted: number | null; self_reported: number | null; external: number | null; latest: number | null }
    const assessmentRow = this.#database.prepare('SELECT COUNT(*) AS count FROM evaluation_self_assessments')
      .get() as { count: number }
    return Object.freeze({
      ready: true,
      schemaVersion: evaluationSchemaVersion,
      outcomes: row.outcomes,
      trustedOutcomes: row.trusted ?? 0,
      selfReportedOutcomes: row.self_reported ?? 0,
      externalOutcomes: row.external ?? 0,
      selfAssessments: assessmentRow.count,
      ...(row.latest === null ? {} : { latestOccurredAt: row.latest }),
    })
  }

  #normalize(input: OutcomeEnvelope): NormalizedEnvelope {
    const { scope, scopeKey } = canonicalEvaluationScope(input.scope)
    const situation = this.#situation(input.situation)
    const sourceKind = oneOf(input.source?.kind, outcomeSourceKinds, 'source.kind')
    const sourceId = boundedText(input.source?.id, 'source.id', 200)
    const evaluatorId = boundedText(input.evaluator?.id, 'evaluator.id', 200)
    const evaluatorVersion = boundedText(input.evaluator?.version, 'evaluator.version', 100)
    return Object.freeze({
      scope,
      scopeKey,
      situation,
      executionStatus: oneOf(input.executionStatus, executionStatuses, 'executionStatus'),
      objectiveStatus: oneOf(input.objectiveStatus, objectiveStatuses, 'objectiveStatus'),
      deliveryStatus: oneOf(input.deliveryStatus, deliveryStatuses, 'deliveryStatus'),
      source: Object.freeze({ kind: sourceKind, id: sourceId }),
      trust: oneOf(input.trust, outcomeTrustLevels, 'trust'),
      evidence: evidence(input.evidence, this.#maxEvidenceRefs),
      metrics: metrics(input.metrics, this.#maxMetricsBytes),
      occurredAt: timestamp(input.occurredAt, 'occurredAt'),
      idempotencyKey: boundedText(input.idempotencyKey, 'idempotencyKey', 200),
      evaluator: Object.freeze({ id: evaluatorId, version: evaluatorVersion }),
    })
  }

  #situation(value: string): string { return boundedText(value, 'situation', this.#maxSituationBytes) }

  #optionalRange(fromInput?: number, toInput?: number): [number | undefined, number | undefined] {
    const from = fromInput === undefined ? undefined : timestamp(fromInput, 'fromOccurredAt')
    const to = toInput === undefined ? undefined : timestamp(toInput, 'toOccurredAt')
    if (from !== undefined && to !== undefined && from > to) {
      throw new EvaluationStoreError('invalid-input', 'query time range is reversed')
    }
    return [from, to]
  }

  #summaryRange(fromInput?: number, toInput?: number): [number, number] {
    const to = toInput === undefined ? timestamp(this.#now(), 'toOccurredAt') : timestamp(toInput, 'toOccurredAt')
    const from = fromInput === undefined ? Math.max(0, to - this.#defaultSummaryWindowMs) : timestamp(fromInput, 'fromOccurredAt')
    if (from > to) throw new EvaluationStoreError('invalid-input', 'summary time range is reversed')
    if (to - from > this.#maxSummaryWindowMs) {
      throw new EvaluationStoreError('invalid-input', `summary window exceeds ${this.#maxSummaryWindowMs}ms`)
    }
    return [from, to]
  }
}
