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
  EvaluationLearningEvidenceTuple,
  EvaluationLearningWriterFence,
  EvaluationLearningWriterFenceResult,
  EvaluationMetrics,
  EvaluationProjectionOutboxEntry,
  EvaluationProjectionState,
  EvaluationScope,
  ExecutionStatus,
  ObjectiveStatus,
  OutcomeEnvelope,
  OutcomeQuery,
  OutcomeSourceKind,
  OutcomeSummary,
  OutcomeSummaryQuery,
  OutcomeTrust,
  ProjectedOutcome,
  SelfAssessmentInput,
  StoredSelfAssessment,
  StoredOutcome,
  TrustedTaskLearningProjectionReceipt,
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
  task_subject_key: string | null
  task_subject_kind: 'automation-run' | 'outcome' | null
  task_subject_ref: string | null
}

interface ProjectedOutcomeRow extends OutcomeRow {
  task_subject_key: string
  task_subject_kind: 'automation-run' | 'outcome'
  task_subject_ref: string
  task_objective_conflicted: 0 | 1
  task_primary_outcome_id: string
  task_execution_outcome_id: string | null
  task_objective_outcome_id: string | null
  task_delivery_outcome_id: string | null
  task_learning_version: number
  task_learning_digest: string
  task_learning_disposition: 'upsert' | 'retract'
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

interface ProjectionOutboxRow {
  evaluation_id: string
  status: 'pending' | 'recorded'
  attempt_count: number
  next_attempt_at: number
  last_failure_at: number | null
  last_failure_code: string | null
  created_at: number
  updated_at: number
  workspace: string
  preset: string
}

function projectionState(row: ProjectionOutboxRow): EvaluationProjectionState {
  return Object.freeze({
    evaluationId: row.evaluation_id,
    scope: Object.freeze({ workspace: row.workspace, preset: row.preset }),
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    ...(row.last_failure_code === null ? {} : { lastFailureCode: row.last_failure_code }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
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

function trustedEvidence(row: OutcomeRow): readonly Readonly<EvaluationEvidenceRef>[] {
  return Object.freeze((JSON.parse(row.evidence_json) as EvaluationEvidenceRef[])
    .map(entry => Object.freeze({ ...entry })))
}

function executionComponent(row: OutcomeRow | undefined) {
  if (row === undefined) return undefined
  return Object.freeze({
    outcomeId: row.id,
    status: row.execution_status,
    source: Object.freeze({ kind: row.source_kind, id: row.source_id }),
    evidence: trustedEvidence(row),
    occurredAt: row.occurred_at,
    evaluator: Object.freeze({ id: row.evaluator_id, version: row.evaluator_version }),
  })
}

function objectiveComponent(row: OutcomeRow | undefined) {
  if (row === undefined) return undefined
  return Object.freeze({
    outcomeId: row.id,
    status: row.objective_status,
    source: Object.freeze({ kind: row.source_kind, id: row.source_id }),
    evidence: trustedEvidence(row),
    occurredAt: row.occurred_at,
    evaluator: Object.freeze({ id: row.evaluator_id, version: row.evaluator_version }),
  })
}

function projected(row: ProjectedOutcomeRow): ProjectedOutcome {
  return Object.freeze({
    ...stored(row),
    projection: Object.freeze({
      subjectKind: row.task_subject_kind,
      subjectRef: row.task_subject_ref,
      status: row.task_objective_conflicted === 1 ? 'objective-conflict' as const : 'ready' as const,
      primaryOutcomeId: row.task_primary_outcome_id,
      ...(row.task_execution_outcome_id === null
        ? {} : { executionOutcomeId: row.task_execution_outcome_id }),
      ...(row.task_objective_outcome_id === null
        ? {} : { objectiveOutcomeId: row.task_objective_outcome_id }),
      ...(row.task_delivery_outcome_id === null
        ? {} : { deliveryOutcomeId: row.task_delivery_outcome_id }),
      learningVersion: row.task_learning_version,
      learningDigest: row.task_learning_digest,
      learningDisposition: row.task_learning_disposition,
    }),
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

/** Stable cross-package digest for one canonical task learning revision. */
export function evaluationLearningProjectionDigest(input: {
  scopeKey: string
  situation: string
  execution?: Readonly<{
    outcomeId: string
    status: ExecutionStatus
    source: Readonly<{ kind: OutcomeSourceKind; id: string }>
    evidence: readonly Readonly<EvaluationEvidenceRef>[]
    occurredAt: number
    evaluator: Readonly<{ id: string; version: string }>
  }>
  objective?: Readonly<{
    outcomeId: string
    status: ObjectiveStatus
    source: Readonly<{ kind: OutcomeSourceKind; id: string }>
    evidence: readonly Readonly<EvaluationEvidenceRef>[]
    occurredAt: number
    evaluator: Readonly<{ id: string; version: string }>
  }>
  projection: Readonly<{
    subjectKind: 'automation-run' | 'outcome'
    subjectRef: string
    disposition: 'upsert' | 'retract'
    evidenceOutcomeId?: string
  }>
}): string {
  return digest([
    'evaluation-task-learning/v1',
    input.scopeKey,
    input.projection.subjectKind,
    input.projection.subjectRef,
    input.projection.disposition,
    input.situation,
    input.execution === undefined ? null : [
      input.execution.outcomeId,
      input.execution.status,
      input.execution.source.kind,
      input.execution.source.id,
      input.execution.evidence.map(entry => [entry.kind, entry.ref, entry.digest ?? null]),
      input.execution.occurredAt,
      input.execution.evaluator.id,
      input.execution.evaluator.version,
    ],
    input.objective === undefined ? null : [
      input.objective.outcomeId,
      input.objective.status,
      input.objective.source.kind,
      input.objective.source.id,
      input.objective.evidence.map(entry => [entry.kind, entry.ref, entry.digest ?? null]),
      input.objective.occurredAt,
      input.objective.evaluator.id,
      input.objective.evaluator.version,
    ],
    input.projection.evidenceOutcomeId ?? null,
  ])
}

interface TaskSubject {
  key: string
  kind: 'automation-run' | 'outcome'
  ref: string
}

function taskSubject(
  scopeKey: string,
  outcomeId: string,
  references: readonly EvaluationEvidenceRef[],
): TaskSubject {
  const automationRunRefs = new Set(references
    .filter(reference => reference.kind === 'automation-run')
    .map(reference => reference.ref))
  if (automationRunRefs.size === 1) {
    const ref = [...automationRunRefs][0]!
    return Object.freeze({
      key: JSON.stringify([scopeKey, 'automation-run', ref]),
      kind: 'automation-run' as const,
      ref,
    })
  }
  return Object.freeze({
    key: JSON.stringify([scopeKey, 'outcome', outcomeId]),
    kind: 'outcome' as const,
    ref: outcomeId,
  })
}

function newer(left: OutcomeRow, right: OutcomeRow): number {
  if (left.recorded_at !== right.recorded_at) return left.recorded_at - right.recorded_at
  return left.id === right.id ? 0 : left.id > right.id ? 1 : -1
}

function latest(rows: readonly OutcomeRow[]): OutcomeRow | undefined {
  return rows.reduce<OutcomeRow | undefined>((winner, row) => (
    winner === undefined || newer(row, winner) > 0 ? row : winner
  ), undefined)
}

function containsEvidence(row: OutcomeRow, kind: string): boolean {
  try {
    return (JSON.parse(row.evidence_json) as unknown[]).some(entry => (
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      && (entry as { kind?: unknown }).kind === kind
    ))
  } catch {
    return false
  }
}

function isAuthoritativeAutomationTerminal(row: OutcomeRow): boolean {
  return row.trust === 'trusted'
    && row.source_kind === 'automation'
    && row.source_id === 'assistant-automations'
    && row.evaluator_id === 'assistant-automations'
    && /^(?:terminal|host-runbook)-v[1-9][0-9]*$/u.test(row.evaluator_version)
    && containsEvidence(row, 'automation-run')
}

function isAuthenticatedOwnerFeedback(row: OutcomeRow): boolean {
  return row.trust === 'trusted'
    && row.source_kind === 'user-feedback'
    && row.source_id === 'assistant-delivery/typed-owner-feedback'
    && row.evaluator_id === 'assistant-delivery-owner-feedback'
    && row.evaluator_version === '2'
    && containsEvidence(row, 'automation-run')
    && containsEvidence(row, 'delivery-outbox')
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
    try {
      this.#rebuildTaskProjections()
    } catch (error) {
      this.#database.close()
      throw error
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
    const subject = taskSubject(normalized.scopeKey, id, normalized.evidence)
    const recordedAt = timestamp(this.#now(), 'recordedAt')
    const metric = normalized.metrics
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#database.prepare(`
        INSERT INTO evaluation_outcomes(
          id, idempotency_key, payload_hash, scope_key, workspace, preset, situation,
          execution_status, objective_status, delivery_status, source_kind, source_id,
          trust, evidence_json, metrics_json, cost_usd_micros, latency_ms, input_tokens,
          output_tokens, tool_calls, occurred_at, recorded_at, evaluator_id, evaluator_version,
          task_subject_key, task_subject_kind, task_subject_ref)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        subject.key, subject.kind, subject.ref,
      )
      const winner = this.#database.prepare('SELECT * FROM evaluation_outcomes WHERE idempotency_key = ?')
        .get(normalized.idempotencyKey) as unknown as OutcomeRow
      if (winner.payload_hash !== payloadHash) {
        throw new EvaluationStoreError(
          'idempotency-conflict',
          'evaluation outcome idempotency key was reused with different content',
        )
      }
      const winnerSubject = winner.task_subject_key === null
        ? taskSubject(winner.scope_key, winner.id, JSON.parse(winner.evidence_json) as EvaluationEvidenceRef[])
        : {
            key: winner.task_subject_key,
            kind: winner.task_subject_kind!,
            ref: winner.task_subject_ref!,
          }
      this.#database.prepare(`
        INSERT INTO evaluation_task_projections(
          subject_key, scope_key, subject_kind, subject_ref, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(subject_key) DO NOTHING
      `).run(
        winnerSubject.key,
        winner.scope_key,
        winnerSubject.kind,
        winnerSubject.ref,
        winner.recorded_at,
      )
      const refreshed = this.#refreshTaskProjection(winnerSubject.key)
      if (winner.trust === 'trusted' && refreshed.learningVersionChanged) {
        this.#database.prepare(`
          INSERT INTO evaluation_projection_outbox(
            evaluation_id, status, attempt_count, next_attempt_at,
            last_failure_at, last_failure_code, created_at, updated_at)
          VALUES (?, 'pending', 0, ?, NULL, NULL, ?, ?)
          ON CONFLICT(evaluation_id) DO NOTHING
        `).run(winner.id, winner.recorded_at, winner.recorded_at, winner.recorded_at)
        this.#advanceScopeWatermark(winner.scope_key, winner.recorded_at)
      }
      this.#database.exec('COMMIT')
      return stored(winner)
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  listPendingProjections(limitInput = 100, nowInput = this.#now()): EvaluationProjectionOutboxEntry[] {
    const limit = timestamp(limitInput, 'projection limit')
    const now = timestamp(nowInput, 'projection now')
    if (limit < 1 || limit > 1_000) {
      throw new EvaluationStoreError('invalid-input', 'projection limit must be between 1 and 1000')
    }
    const rows = this.#database.prepare(`
      SELECT projection.*, outcome.workspace, outcome.preset
      FROM evaluation_projection_outbox projection
      JOIN evaluation_outcomes outcome ON outcome.id = projection.evaluation_id
      WHERE projection.status = 'pending' AND projection.next_attempt_at <= ?
      ORDER BY projection.next_attempt_at, projection.created_at, projection.evaluation_id
      LIMIT ?
    `).all(now, limit) as unknown as ProjectionOutboxRow[]
    return rows.map(row => projectionState(row) as EvaluationProjectionOutboxEntry)
  }

  peekPendingProjection(scopeInput: EvaluationScope, nowInput = this.#now()): EvaluationProjectionOutboxEntry | undefined {
    const { scopeKey } = canonicalEvaluationScope(scopeInput)
    const now = timestamp(nowInput, 'projection now')
    const row = this.#database.prepare(`
      SELECT projection.*, outcome.workspace, outcome.preset
      FROM evaluation_projection_outbox projection
      JOIN evaluation_outcomes outcome ON outcome.id = projection.evaluation_id
      WHERE projection.status = 'pending' AND projection.next_attempt_at <= ?
        AND outcome.scope_key = ? AND outcome.trust = 'trusted'
      ORDER BY projection.next_attempt_at, projection.created_at, projection.evaluation_id
      LIMIT 1
    `).get(now, scopeKey) as unknown as ProjectionOutboxRow | undefined
    return row === undefined ? undefined : projectionState(row) as EvaluationProjectionOutboxEntry
  }

  getProjection(scopeInput: EvaluationScope, evaluationIdInput: string): EvaluationProjectionState | undefined {
    const { scopeKey } = canonicalEvaluationScope(scopeInput)
    const evaluationId = boundedText(evaluationIdInput, 'evaluationId', 200)
    const row = this.#database.prepare(`
      SELECT projection.*, outcome.workspace, outcome.preset
      FROM evaluation_projection_outbox projection
      JOIN evaluation_outcomes outcome ON outcome.id = projection.evaluation_id
      WHERE projection.evaluation_id = ? AND outcome.scope_key = ?
        AND outcome.trust = 'trusted'
    `).get(evaluationId, scopeKey) as unknown as ProjectionOutboxRow | undefined
    return row === undefined ? undefined : projectionState(row)
  }

  completeProjection(input: { evaluationId: string; now: number }): boolean {
    const evaluationId = boundedText(input.evaluationId, 'evaluationId', 200)
    const now = timestamp(input.now, 'projection completion time')
    return this.#database.prepare(`
      UPDATE evaluation_projection_outbox
      SET status = 'recorded', updated_at = ?, last_failure_code = NULL
      WHERE evaluation_id = ? AND status = 'pending'
    `).run(now, evaluationId).changes === 1
  }

  deferProjection(input: {
    evaluationId: string
    now: number
    retryAt: number
    failureCode: string
  }): boolean {
    const evaluationId = boundedText(input.evaluationId, 'evaluationId', 200)
    const now = timestamp(input.now, 'projection failure time')
    const retryAt = timestamp(input.retryAt, 'projection retry time')
    if (retryAt <= now) throw new EvaluationStoreError('invalid-input', 'projection retry must be in the future')
    const failureCode = boundedText(input.failureCode, 'projection failureCode', 64)
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(failureCode)) {
      throw new EvaluationStoreError('invalid-input', 'projection failureCode is invalid')
    }
    return this.#database.prepare(`
      UPDATE evaluation_projection_outbox
      SET attempt_count = attempt_count + 1, next_attempt_at = ?,
        last_failure_at = ?, last_failure_code = ?, updated_at = ?
      WHERE evaluation_id = ? AND status = 'pending'
    `).run(retryAt, now, failureCode, now, evaluationId).changes === 1
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

  /** Resolve the task projection containing one immutable audit outcome. */
  getTaskProjection(scopeInput: EvaluationScope, outcomeIdInput: string): ProjectedOutcome | undefined {
    const { scopeKey } = canonicalEvaluationScope(scopeInput)
    const outcomeId = boundedText(outcomeIdInput, 'outcomeId', 200)
    const row = this.#database.prepare(`
      SELECT task.*
      FROM evaluation_outcomes audit
      JOIN evaluation_task_projection_view task
        ON task.task_subject_key = audit.task_subject_key
      WHERE audit.id = ? AND audit.scope_key = ?
    `).get(outcomeId, scopeKey) as unknown as ProjectedOutcomeRow | undefined
    return row === undefined ? undefined : projected(row)
  }

  /**
   * Resolve an append-only outbox trigger to the latest canonical state of its
   * task. The trigger may be arbitrarily old; version/digest always describe
   * the current task projection.
   */
  getTaskLearningProjection(
    scopeInput: EvaluationScope,
    outcomeIdInput: string,
  ): TrustedTaskLearningProjectionReceipt | undefined {
    const { scopeKey } = canonicalEvaluationScope(scopeInput)
    const outcomeId = boundedText(outcomeIdInput, 'outcomeId', 200)
    const row = this.#database.prepare(`
      SELECT task.*
      FROM evaluation_projection_outbox outbox
      JOIN evaluation_outcomes audit ON audit.id = outbox.evaluation_id
      JOIN evaluation_task_projection_view task
        ON task.task_subject_key = audit.task_subject_key
      WHERE audit.id = ? AND audit.scope_key = ? AND audit.trust = 'trusted'
    `).get(outcomeId, scopeKey) as unknown as ProjectedOutcomeRow | undefined
    if (row === undefined || row.trust !== 'trusted') return undefined
    const watermarkRow = this.#database.prepare(`
      SELECT watermark FROM evaluation_scope_watermarks WHERE scope_key = ?
    `).get(scopeKey) as { watermark: number } | undefined
    if (watermarkRow === undefined || !Number.isSafeInteger(watermarkRow.watermark)
      || watermarkRow.watermark < 1) {
      throw new EvaluationStoreError('invalid-input', 'canonical scope watermark is unavailable')
    }
    const task = projected(row)
    const selected = (id: string | undefined): OutcomeRow | undefined => id === undefined
      ? undefined
      : this.#database.prepare('SELECT * FROM evaluation_outcomes WHERE id = ? AND scope_key = ?')
        .get(id, scopeKey) as unknown as OutcomeRow | undefined
    const execution = executionComponent(selected(task.projection.executionOutcomeId))
    const objective = task.projection.status === 'objective-conflict'
      ? undefined
      : objectiveComponent(selected(task.projection.objectiveOutcomeId))
    const projection = Object.freeze({
      subjectKind: task.projection.subjectKind,
      subjectRef: task.projection.subjectRef,
      version: task.projection.learningVersion,
      digest: task.projection.learningDigest,
      disposition: task.projection.learningDisposition,
      ...(task.projection.objectiveOutcomeId === undefined
        ? {} : { evidenceOutcomeId: task.projection.objectiveOutcomeId }),
    })
    const receipt: TrustedTaskLearningProjectionReceipt = Object.freeze({
      triggerOutcomeId: outcomeId,
      scope: Object.freeze({ ...task.scope }),
      scopeKey: task.scopeKey,
      scopeWatermark: watermarkRow.watermark,
      situation: task.situation,
      ...(execution === undefined ? {} : { execution }),
      ...(objective === undefined ? {} : { objective }),
      projection,
    })
    if (projection.version < 1 || !/^[a-f\d]{64}$/u.test(projection.digest)
      || evaluationLearningProjectionDigest(receipt) !== projection.digest) {
      throw new EvaluationStoreError('invalid-input', 'canonical task learning projection is corrupt')
    }
    return receipt
  }

  /**
   * Hold Evaluation's scope writer fence while a synchronous downstream
   * callback acquires and commits its own writer transaction.  The fixed lock
   * order is Evaluation first, downstream second; a Promise-returning callback
   * is rejected so the lock can never escape this stack frame.
   */
  withLearningWriterFence<T>(
    scopeInput: EvaluationScope,
    fenceInput: EvaluationLearningWriterFence,
    callback: () => T,
  ): EvaluationLearningWriterFenceResult<T> {
    const { scopeKey } = canonicalEvaluationScope(scopeInput)
    const fence = this.#normalizeLearningWriterFence(fenceInput)
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const watermark = this.#database.prepare(`
        SELECT watermark FROM evaluation_scope_watermarks WHERE scope_key = ?
      `).get(scopeKey) as { watermark: number } | undefined
      if (watermark?.watermark !== fence.scopeWatermark) {
        this.#database.exec('COMMIT')
        return Object.freeze({ matched: false as const, reason: 'watermark-changed' as const })
      }
      const pending = this.#database.prepare(`
        SELECT 1 AS present
        FROM evaluation_projection_outbox outbox
        JOIN evaluation_outcomes outcome ON outcome.id = outbox.evaluation_id
        WHERE outcome.scope_key = ? AND outcome.trust = 'trusted'
          AND outbox.status = 'pending'
        LIMIT 1
      `).get(scopeKey) as { present: 1 } | undefined
      if (pending !== undefined) {
        this.#database.exec('COMMIT')
        return Object.freeze({ matched: false as const, reason: 'projection-pending' as const })
      }
      const statement = this.#database.prepare(`
        SELECT learning_version AS version, learning_digest AS digest,
          learning_disposition AS disposition
        FROM evaluation_task_projections
        WHERE scope_key = ? AND subject_kind = ? AND subject_ref = ?
      `)
      for (const evidence of fence.evidence) {
        const current = statement.get(
          scopeKey,
          evidence.subjectKind,
          evidence.subjectRef,
        ) as { version: number; digest: string; disposition: 'upsert' | 'retract' } | undefined
        if (current === undefined || current.version !== evidence.version
          || current.digest !== evidence.digest || current.disposition !== 'upsert') {
          this.#database.exec('COMMIT')
          return Object.freeze({ matched: false as const, reason: 'evidence-changed' as const })
        }
      }
      const value = callback()
      if (typeof value === 'object' && value !== null && 'then' in value
        && typeof (value as { then?: unknown }).then === 'function') {
        throw new EvaluationStoreError(
          'invalid-input',
          'learning writer fence callback must be synchronous',
        )
      }
      this.#database.exec('COMMIT')
      return Object.freeze({ matched: true as const, value })
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  /** Query one deterministic latest row per task; raw query() remains the audit API. */
  queryTasks(input: OutcomeQuery): ProjectedOutcome[] {
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
      SELECT * FROM evaluation_task_projection_view WHERE ${clauses.join(' AND ')}
      ORDER BY occurred_at DESC, task_subject_key DESC LIMIT ?
    `).all(...parameters) as unknown as ProjectedOutcomeRow[]
    return rows.map(row => projected(row))
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
      FROM evaluation_task_projection_view
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
    const taskRow = this.#database.prepare(`
      SELECT COUNT(*) AS count, SUM(objective_conflicted) AS conflicted
      FROM evaluation_task_projections WHERE primary_outcome_id IS NOT NULL
    `).get() as { count: number; conflicted: number | null }
    const projectionRow = this.#database.prepare(`
      SELECT COUNT(*) AS pending,
        SUM(attempt_count > 0) AS retrying,
        TOTAL(attempt_count) AS attempts,
        MIN(created_at) AS oldest
      FROM evaluation_projection_outbox WHERE status = 'pending'
    `).get() as { pending: number; retrying: number | null; attempts: number; oldest: number | null }
    return Object.freeze({
      ready: true,
      schemaVersion: evaluationSchemaVersion,
      outcomes: row.outcomes,
      trustedOutcomes: row.trusted ?? 0,
      selfReportedOutcomes: row.self_reported ?? 0,
      externalOutcomes: row.external ?? 0,
      selfAssessments: assessmentRow.count,
      taskProjections: taskRow.count,
      conflictedTaskProjections: taskRow.conflicted ?? 0,
      pendingProjections: projectionRow.pending,
      retryingProjections: projectionRow.retrying ?? 0,
      projectionAttempts: projectionRow.attempts,
      ...(projectionRow.oldest === null ? {} : { oldestPendingProjectionAt: projectionRow.oldest }),
      ...(row.latest === null ? {} : { latestOccurredAt: row.latest }),
    })
  }

  #rebuildTaskProjections(): void {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const rows = this.#database.prepare(`
        SELECT * FROM evaluation_outcomes ORDER BY recorded_at, id
      `).all() as unknown as OutcomeRow[]
      const updateOutcome = this.#database.prepare(`
        UPDATE evaluation_outcomes
        SET task_subject_key = ?, task_subject_kind = ?, task_subject_ref = ?
        WHERE id = ?
      `)
      const insertSubject = this.#database.prepare(`
        INSERT INTO evaluation_task_projections(
          subject_key, scope_key, subject_kind, subject_ref, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(subject_key) DO UPDATE SET
          scope_key = excluded.scope_key,
          subject_kind = excluded.subject_kind,
          subject_ref = excluded.subject_ref
      `)
      const subjects = new Set<string>()
      for (const row of rows) {
        const subject = row.task_subject_key === null
          || row.task_subject_kind === null
          || row.task_subject_ref === null
          ? taskSubject(row.scope_key, row.id, JSON.parse(row.evidence_json) as EvaluationEvidenceRef[])
          : { key: row.task_subject_key, kind: row.task_subject_kind, ref: row.task_subject_ref }
        if (row.task_subject_key !== subject.key
          || row.task_subject_kind !== subject.kind
          || row.task_subject_ref !== subject.ref) {
          updateOutcome.run(subject.key, subject.kind, subject.ref, row.id)
        }
        insertSubject.run(subject.key, row.scope_key, subject.kind, subject.ref, row.recorded_at)
        subjects.add(subject.key)
      }
      for (const subjectKey of [...subjects].sort()) {
        const refreshed = this.#refreshTaskProjection(subjectKey)
        if (!refreshed.learningVersionChanged) continue
        const current = this.#database.prepare(`
          SELECT projection.scope_key, projection.primary_outcome_id, projection.updated_at,
            outcome.trust
          FROM evaluation_task_projections projection
          JOIN evaluation_outcomes outcome ON outcome.id = projection.primary_outcome_id
          WHERE projection.subject_key = ?
        `).get(subjectKey) as {
          scope_key: string
          primary_outcome_id: string
          updated_at: number
          trust: OutcomeTrust
        }
        if (current.trust !== 'trusted') continue
        this.#database.prepare(`
          INSERT INTO evaluation_projection_outbox(
            evaluation_id, status, attempt_count, next_attempt_at,
            last_failure_at, last_failure_code, created_at, updated_at)
          VALUES (?, 'pending', 0, ?, NULL, NULL, ?, ?)
          ON CONFLICT(evaluation_id) DO UPDATE SET
            status = 'pending', attempt_count = 0,
            next_attempt_at = excluded.next_attempt_at,
            last_failure_at = NULL, last_failure_code = NULL,
            updated_at = excluded.updated_at
        `).run(
          current.primary_outcome_id,
          current.updated_at,
          current.updated_at,
          current.updated_at,
        )
        this.#advanceScopeWatermark(current.scope_key, current.updated_at)
      }
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  #refreshTaskProjection(subjectKey: string): { learningVersionChanged: boolean } {
    const projection = this.#database.prepare(`
      SELECT subject_kind, subject_ref, learning_version, learning_digest, learning_disposition
      FROM evaluation_task_projections WHERE subject_key = ?
    `).get(subjectKey) as {
      subject_kind: 'automation-run' | 'outcome'
      subject_ref: string
      learning_version: number
      learning_digest: string | null
      learning_disposition: 'upsert' | 'retract' | null
    } | undefined
    if (projection === undefined) {
      throw new EvaluationStoreError('not-found', 'task projection subject was not found')
    }
    const rows = this.#database.prepare(`
      SELECT * FROM evaluation_outcomes WHERE task_subject_key = ?
      ORDER BY recorded_at, id
    `).all(subjectKey) as unknown as OutcomeRow[]
    if (rows.length === 0) return { learningVersionChanged: false }

    let primary: OutcomeRow
    let execution: OutcomeRow | undefined
    let objective: OutcomeRow | undefined
    let delivery: OutcomeRow | undefined
    let objectiveConflicted = false
    if (projection.subject_kind === 'outcome') {
      primary = latest(rows)!
      execution = primary
      objective = primary
      delivery = primary
    } else {
      const terminals = rows.filter(row => isAuthoritativeAutomationTerminal(row))
      execution = latest(terminals)

      const owners = rows.filter(row => isAuthenticatedOwnerFeedback(row)
        && row.objective_status !== 'unknown')
      const ownerStatuses = new Set(owners.map(row => row.objective_status))
      if (ownerStatuses.size > 1) objectiveConflicted = true
      else if (owners.length > 0) objective = latest(owners)
      else {
        const trustedObjectives = rows.filter(row => row.trust === 'trusted'
          && row.source_kind !== 'user-feedback'
          && row.objective_status !== 'unknown')
        const ranked = trustedObjectives.map(row => ({
          row,
          // Independent trusted evaluators supersede the terminal producer's
          // initial objective, while an owner judgement has already won above.
          rank: isAuthoritativeAutomationTerminal(row) ? 1 : 2,
        })).sort((left, right) => left.rank - right.rank || newer(left.row, right.row))
        objective = ranked.at(-1)?.row
      }

      const ownerDelivery = latest(rows.filter(row => isAuthenticatedOwnerFeedback(row)
        && row.delivery_status === 'delivered'))
      const trustedDelivery = latest(rows.filter(row => row.trust === 'trusted'
        && row.source_kind === 'delivery' && row.delivery_status !== 'unknown'))
      delivery = ownerDelivery ?? trustedDelivery ?? execution

      const rankedPrimary = rows.map(row => ({
        row,
        rank: isAuthoritativeAutomationTerminal(row)
          ? 4
          : isAuthenticatedOwnerFeedback(row)
            ? 3
            : row.trust === 'trusted'
              ? 2
              : row.trust === 'external' ? 1 : 0,
      })).sort((left, right) => left.rank - right.rank || newer(left.row, right.row))
      primary = rankedPrimary.at(-1)!.row
    }
    const objectiveStatus = objectiveConflicted ? 'unknown' : objective?.objective_status ?? 'unknown'
    const objectiveSituationMismatch = objective !== undefined && objective.situation !== primary.situation
    const hostRunbook = execution !== undefined && isAuthoritativeAutomationTerminal(execution)
      && /^host-runbook-v[1-9][0-9]*$/u.test(execution.evaluator_version)
    const learningDisposition = !objectiveConflicted
      && !objectiveSituationMismatch
      && objective?.trust === 'trusted'
      && (objectiveStatus === 'achieved' || objectiveStatus === 'not-achieved')
      && (projection.subject_kind !== 'automation-run' || execution !== undefined)
      && !hostRunbook
      ? 'upsert' as const
      : 'retract' as const
    const evidenceOutcomeId = objectiveConflicted ? undefined : objective?.id
    const learningExecution = executionComponent(execution)
    const learningObjective = objectiveConflicted ? undefined : objectiveComponent(objective)
    const learningDigest = evaluationLearningProjectionDigest({
      scopeKey: primary.scope_key,
      situation: primary.situation,
      ...(learningExecution === undefined ? {} : { execution: learningExecution }),
      ...(learningObjective === undefined ? {} : { objective: learningObjective }),
      projection: {
        subjectKind: projection.subject_kind,
        subjectRef: projection.subject_ref,
        disposition: learningDisposition,
        ...(evidenceOutcomeId === undefined ? {} : { evidenceOutcomeId }),
      },
    })
    const learningVersionChanged = projection.learning_digest !== learningDigest
      || projection.learning_disposition !== learningDisposition
    const learningVersion = projection.learning_version === 0
      ? 1
      : learningVersionChanged
        ? projection.learning_version + 1
        : projection.learning_version
    if (!Number.isSafeInteger(learningVersion)) {
      throw new EvaluationStoreError('invalid-input', 'task learning projection version overflow')
    }
    const updatedAt = Math.max(...rows.map(row => row.recorded_at))
    this.#database.prepare(`
      UPDATE evaluation_task_projections
      SET primary_outcome_id = ?, execution_outcome_id = ?, objective_outcome_id = ?,
        delivery_outcome_id = ?, objective_conflicted = ?, learning_version = ?,
        learning_digest = ?, learning_disposition = ?, updated_at = ?
      WHERE subject_key = ?
    `).run(
      primary.id,
      execution?.id ?? null,
      objectiveConflicted ? null : objective?.id ?? null,
      delivery?.id ?? null,
      objectiveConflicted ? 1 : 0,
      learningVersion,
      learningDigest,
      learningDisposition,
      updatedAt,
      subjectKey,
    )
    return { learningVersionChanged: projection.learning_version === 0 || learningVersionChanged }
  }

  #advanceScopeWatermark(scopeKey: string, updatedAt: number): number {
    this.#database.prepare(`
      INSERT INTO evaluation_scope_watermarks(scope_key, watermark, updated_at)
      VALUES (?, 1, ?)
      ON CONFLICT(scope_key) DO UPDATE SET
        watermark = evaluation_scope_watermarks.watermark + 1,
        updated_at = excluded.updated_at
    `).run(scopeKey, updatedAt)
    const row = this.#database.prepare(`
      SELECT watermark FROM evaluation_scope_watermarks WHERE scope_key = ?
    `).get(scopeKey) as { watermark: number }
    if (!Number.isSafeInteger(row.watermark) || row.watermark < 1) {
      throw new EvaluationStoreError('invalid-input', 'canonical scope watermark overflow')
    }
    return row.watermark
  }

  #normalizeLearningWriterFence(
    input: EvaluationLearningWriterFence,
  ): Readonly<{ scopeWatermark: number; evidence: readonly Readonly<EvaluationLearningEvidenceTuple>[] }> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)
      || !Number.isSafeInteger(input.scopeWatermark) || input.scopeWatermark < 1
      || !Array.isArray(input.evidence) || input.evidence.length < 1
      || input.evidence.length > 10_000) {
      throw new EvaluationStoreError('invalid-input', 'learning writer fence is invalid')
    }
    const seen = new Set<string>()
    const entries = input.evidence.map((raw, index) => {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)
        || raw.disposition !== 'upsert'
        || (raw.subjectKind !== 'automation-run' && raw.subjectKind !== 'outcome')
        || !Number.isSafeInteger(raw.version) || raw.version < 1
        || raw.version > 1_000_000_000
        || typeof raw.digest !== 'string' || !/^[a-f\d]{64}$/u.test(raw.digest)) {
        throw new EvaluationStoreError('invalid-input', `learning writer fence evidence[${index}] is invalid`)
      }
      const subjectRef = boundedText(raw.subjectRef, `evidence[${index}].subjectRef`, 1_000)
      const identity = JSON.stringify([raw.subjectKind, subjectRef])
      if (seen.has(identity)) {
        throw new EvaluationStoreError('invalid-input', 'learning writer fence contains duplicate evidence')
      }
      seen.add(identity)
      return Object.freeze({
        subjectKind: raw.subjectKind,
        subjectRef,
        version: raw.version,
        digest: raw.digest,
        disposition: 'upsert' as const,
      })
    })
    return Object.freeze({
      scopeWatermark: input.scopeWatermark,
      evidence: Object.freeze(entries),
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
