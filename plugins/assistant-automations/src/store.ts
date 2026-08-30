import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  dueOccurrences,
  nextOccurrence,
  previousOccurrence,
  validateSchedule,
  type AutomationSchedule,
} from './schedule.js'
import { AutomationDatabaseError, openAutomationDatabase } from './sqlite.js'
import type {
  AutomationDefinition,
  AutomationDeliveryStatus,
  AutomationEvaluationOutboxEntry,
  AutomationEvaluationOutcome,
  AutomationEvaluationStatus,
  AutomationEvidenceAttribution,
  AutomationEvidenceStatus,
  AutomationOccurrence,
  AutomationOutcomeEvidence,
  AutomationRecord,
  AutomationRun,
  AutomationRunStatus,
  AutomationStatus,
  AutomationTask,
  AutomationTaskStatus,
  DutyLease,
  MisfirePolicy,
  OccurrenceStatus,
  OccurrenceTriggerKind,
  OverlapPolicy,
  RetrySafety,
} from './types.js'

export type AutomationStoreErrorCode =
  | 'idempotency-conflict'
  | 'invalid-definition'
  | 'invalid-path'
  | 'invalid-state'
  | 'not-found'
  | 'schema-too-new'
  | 'stale-fence'
  | 'version-conflict'

export class AutomationStoreError extends Error {
  constructor(readonly code: AutomationStoreErrorCode, message: string) {
    super(message)
    this.name = 'AutomationStoreError'
  }
}

interface DefinitionRow {
  id: string
  create_idempotency_key: string
  system_owner: string | null
  definition_hash: string
  definition_json: string
  status: AutomationStatus
  next_run_at: number | null
  created_at: number
  updated_at: number
  version: number
}

interface OccurrenceRow {
  id: string
  automation_id: string
  trigger_kind: OccurrenceTriggerKind
  trigger_key: string
  scheduled_at: number
  status: OccurrenceStatus
  reason: string | null
  dry_run: number
  created_at: number
  updated_at: number
}

interface TaskRow {
  id: string
  occurrence_id: string
  automation_id: string
  status: AutomationTaskStatus
  cancel_requested: number
  claimed_by: string | null
  fencing_token: number | null
  lease_until: number | null
  attempt_count: number
  created_at: number
  updated_at: number
}

interface DutyRow {
  owner_id: string
  fencing_token: number
  lease_until: number
}

interface AttemptRow {
  id: string
  task_id: string
  attempt_number: number
  owner_id: string
  fencing_token: number
  status: AutomationTaskStatus
  session_id: string | null
  failure_code: string | null
  started_at: number | null
  finished_at: number | null
  automation_snapshot_hash: string | null
  automation_snapshot_json: string | null
  created_at: number
  updated_at: number
}

interface RunRow {
  id: string
  occurrence_id: string
  automation_id: string
  task_id: string
  attempt_id: string
  status: AutomationRunStatus
  session_id: string | null
  artifact_ref: string | null
  output_preview: string
  usage_json: string
  delivery_status: string | null
  delivery_ref: string | null
  evidence_status: AutomationEvidenceStatus
  evidence_json: string | null
  created_at: number
  updated_at: number
}

interface EvaluationOutboxRow {
  id: string
  run_id: string
  observation_kind: 'terminal'
  status: AutomationEvaluationStatus
  payload_json: string
  attempt_count: number
  next_attempt_at: number
  last_failure_at: number | null
  last_error_code: string | null
  created_at: number
  updated_at: number
}

interface ScopedRunRow extends RunRow {
  scope_snapshot_hash: string | null
  scope_snapshot_json: string | null
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function text(value: unknown, field: string, maximum = 1_000): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AutomationStoreError('invalid-definition', `${field} must be a non-empty string`)
  }
  const normalized = value.normalize('NFC').trim()
  if (Buffer.byteLength(normalized, 'utf8') > maximum) {
    throw new AutomationStoreError('invalid-definition', `${field} exceeds its byte limit`)
  }
  return normalized
}

function safeInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new AutomationStoreError('invalid-definition', `${field} must be between ${minimum} and ${maximum}`)
  }
  return value as number
}

function misfire(value: unknown): MisfirePolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AutomationStoreError('invalid-definition', 'misfire must be an object')
  }
  const input = value as Record<string, unknown>
  if (input['kind'] === 'skip' || input['kind'] === 'latest') {
    if (Object.keys(input).some(key => key !== 'kind')) {
      throw new AutomationStoreError('invalid-definition', 'misfire contains an unknown field')
    }
    return Object.freeze({ kind: input['kind'] })
  }
  if (input['kind'] === 'bounded-replay') {
    if (Object.keys(input).some(key => key !== 'kind' && key !== 'limit')) {
      throw new AutomationStoreError('invalid-definition', 'misfire contains an unknown field')
    }
    return Object.freeze({ kind: 'bounded-replay', limit: safeInteger(input['limit'], 'misfire.limit', 1, 100) })
  }
  throw new AutomationStoreError('invalid-definition', 'invalid misfire policy')
}

export function normalizeAutomationDefinition(
  value: unknown,
  maxPromptBytes = 16_384,
  maxAllowedTools = 100,
): AutomationDefinition {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AutomationStoreError('invalid-definition', 'automation definition must be an object')
  }
  const input = value as Record<string, unknown>
  const allowed = new Set([
    'agentPreset', 'allowedTools', 'budgetAmount', 'budgetId', 'deliveryBindingId', 'deliverySuppressExact', 'maxOutputTokens',
    'maxRetries', 'maxToolCalls', 'misfire', 'model', 'name', 'overlap', 'principal', 'prompt', 'provider',
    'retrySafety', 'schedule', 'timeoutMs', 'workspace',
  ])
  if (Object.keys(input).some(key => !allowed.has(key))) {
    throw new AutomationStoreError('invalid-definition', 'automation definition contains an unknown field')
  }
  if (!isAbsolute(input['workspace'] as string)) {
    throw new AutomationStoreError('invalid-definition', 'automation workspace must be absolute')
  }
  if (!Array.isArray(input['allowedTools']) || input['allowedTools'].length > maxAllowedTools) {
    throw new AutomationStoreError('invalid-definition', 'allowedTools must be a bounded array')
  }
  const allowedTools = input['allowedTools'].map(value => text(value, 'allowedTools item', 200))
  if (new Set(allowedTools).size !== allowedTools.length) {
    throw new AutomationStoreError('invalid-definition', 'allowedTools contains a duplicate')
  }
  const overlap = input['overlap']
  if (overlap !== 'skip' && overlap !== 'queue-one' && overlap !== 'cancel-previous') {
    throw new AutomationStoreError('invalid-definition', 'invalid overlap policy')
  }
  const retrySafety = input['retrySafety']
  if (retrySafety !== 'never' && retrySafety !== 'idempotent') {
    throw new AutomationStoreError('invalid-definition', 'invalid retrySafety')
  }
  const budgetId = input['budgetId'] === undefined ? undefined : text(input['budgetId'], 'budgetId', 200)
  const budgetAmount = input['budgetAmount'] === undefined
    ? undefined
    : safeInteger(input['budgetAmount'], 'budgetAmount', 1, 10_000_000)
  if ((budgetId === undefined) !== (budgetAmount === undefined)) {
    throw new AutomationStoreError('invalid-definition', 'budgetId and budgetAmount must be supplied together')
  }
  const deliverySuppressExact = input['deliverySuppressExact'] === undefined
    ? undefined
    : (() => {
        if (!Array.isArray(input['deliverySuppressExact']) || input['deliverySuppressExact'].length > 20) {
          throw new AutomationStoreError('invalid-definition', 'deliverySuppressExact must be a bounded array')
        }
        const values = input['deliverySuppressExact'].map(value => text(value, 'deliverySuppressExact item', 1_024))
        if (new Set(values).size !== values.length) {
          throw new AutomationStoreError('invalid-definition', 'deliverySuppressExact contains a duplicate')
        }
        return Object.freeze(values)
      })()
  if (deliverySuppressExact !== undefined && input['deliveryBindingId'] === undefined) {
    throw new AutomationStoreError('invalid-definition', 'deliverySuppressExact requires deliveryBindingId')
  }
  return Object.freeze({
    name: text(input['name'], 'name', 500),
    prompt: text(input['prompt'], 'prompt', maxPromptBytes),
    schedule: validateSchedule(input['schedule']),
    workspace: text(input['workspace'], 'workspace', 4_096),
    agentPreset: text(input['agentPreset'], 'agentPreset', 200),
    provider: text(input['provider'], 'provider', 200),
    model: text(input['model'], 'model', 500),
    allowedTools: Object.freeze(allowedTools),
    timeoutMs: safeInteger(input['timeoutMs'], 'timeoutMs', 1_000, 86_400_000),
    maxOutputTokens: safeInteger(input['maxOutputTokens'], 'maxOutputTokens', 1, 1_000_000),
    maxToolCalls: safeInteger(input['maxToolCalls'], 'maxToolCalls', 0, 10_000),
    misfire: misfire(input['misfire']),
    overlap: overlap as OverlapPolicy,
    retrySafety: retrySafety as RetrySafety,
    maxRetries: safeInteger(input['maxRetries'], 'maxRetries', 0, 10),
    principal: text(input['principal'], 'principal', 500),
    ...(budgetId === undefined ? {} : { budgetId, budgetAmount: budgetAmount! }),
    ...(input['deliveryBindingId'] === undefined
      ? {}
      : { deliveryBindingId: text(input['deliveryBindingId'], 'deliveryBindingId', 500) }),
    ...(deliverySuppressExact === undefined ? {} : { deliverySuppressExact }),
  })
}

function freezeAutomationSnapshot(value: unknown, expectedId?: string): AutomationRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AutomationStoreError('invalid-state', 'automation execution snapshot must be an object')
  }
  const input = value as Record<string, unknown>
  if (typeof input['id'] !== 'string' || (expectedId !== undefined && input['id'] !== expectedId)) {
    throw new AutomationStoreError('invalid-state', 'automation execution snapshot id does not match its task')
  }
  if (input['status'] !== 'active' || !Number.isSafeInteger(input['version']) || (input['version'] as number) < 1
    || !Number.isSafeInteger(input['createdAt']) || !Number.isSafeInteger(input['updatedAt'])) {
    throw new AutomationStoreError('invalid-state', 'automation execution snapshot metadata is invalid')
  }
  const nextRunAt = input['nextRunAt']
  if (nextRunAt !== undefined && !Number.isSafeInteger(nextRunAt)) {
    throw new AutomationStoreError('invalid-state', 'automation execution snapshot nextRunAt is invalid')
  }
  const owner = input['owner']
  if (owner !== undefined && typeof owner !== 'string') {
    throw new AutomationStoreError('invalid-state', 'automation execution snapshot owner is invalid')
  }
  const definition = normalizeAutomationDefinition(input['definition'], 16 * 1024 * 1024, 10_000)
  return Object.freeze({
    id: input['id'],
    ...(owner === undefined ? {} : { owner }),
    definition,
    status: 'active',
    nextRunAt: nextRunAt as number | undefined,
    createdAt: input['createdAt'] as number,
    updatedAt: input['updatedAt'] as number,
    version: input['version'] as number,
  })
}

function encodeAutomationSnapshot(value: AutomationRecord): { hash: string; json: string } {
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json, 'utf8') > 16 * 1024 * 1024) {
    throw new AutomationStoreError('invalid-definition', 'automation execution snapshot exceeds 16777216 bytes')
  }
  return { hash: hashText(json), json }
}

function decodeAutomationSnapshot(
  snapshotHash: string | null,
  snapshotJson: string | null,
  expectedId?: string,
): AutomationRecord | undefined {
  if (snapshotHash === null || snapshotJson === null) return undefined
  if (Buffer.byteLength(snapshotJson, 'utf8') > 16 * 1024 * 1024
    || hashText(snapshotJson) !== snapshotHash) {
    throw new AutomationStoreError('invalid-state', 'automation execution snapshot integrity check failed')
  }
  try {
    return freezeAutomationSnapshot(JSON.parse(snapshotJson), expectedId)
  } catch (error) {
    if (error instanceof AutomationStoreError) throw error
    throw new AutomationStoreError('invalid-state', 'automation execution snapshot contains invalid JSON')
  }
}

function automationSnapshot(row: AttemptRow, expectedId?: string): AutomationRecord | undefined {
  return decodeAutomationSnapshot(row.automation_snapshot_hash, row.automation_snapshot_json, expectedId)
}

function executionScopeMatches(
  snapshot: AutomationRecord,
  scope: { workspace: string; agentPreset: string },
): boolean {
  return resolve(snapshot.definition.workspace.normalize('NFC')) === resolve(scope.workspace.normalize('NFC'))
    && snapshot.definition.agentPreset.normalize('NFC').trim() === scope.agentPreset.normalize('NFC').trim()
}

function record(row: DefinitionRow): AutomationRecord {
  return Object.freeze({
    id: row.id,
    ...(row.system_owner === null ? {} : { owner: row.system_owner }),
    definition: Object.freeze(JSON.parse(row.definition_json) as AutomationDefinition),
    status: row.status,
    nextRunAt: row.next_run_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  })
}

function deliveryStatus(value: string | null): AutomationDeliveryStatus | undefined {
  if (value === null) return undefined
  if (value === 'pending' || value === 'enqueued' || value === 'suppressed') return value
  throw new AutomationStoreError('invalid-state', 'automation run has an invalid delivery status')
}

function evidenceStatus(value: string): AutomationEvidenceStatus {
  if (value === 'pending' || value === 'recorded' || value === 'suppressed') return value
  throw new AutomationStoreError('invalid-state', 'automation run has an invalid evidence status')
}

function parseEvidence(row: RunRow): AutomationOutcomeEvidence | undefined {
  const status = evidenceStatus(row.evidence_status)
  if (status === 'suppressed') {
    if (row.evidence_json !== null) {
      throw new AutomationStoreError('invalid-state', 'suppressed automation evidence must not carry a payload')
    }
    return undefined
  }
  if (row.evidence_json === null || Buffer.byteLength(row.evidence_json, 'utf8') > 16_384) {
    throw new AutomationStoreError('invalid-state', 'pending automation evidence must be bounded JSON')
  }
  const value = JSON.parse(row.evidence_json) as AutomationOutcomeEvidence
  return Object.freeze(value)
}

function occurrence(row: OccurrenceRow): AutomationOccurrence {
  return Object.freeze({
    id: row.id,
    automationId: row.automation_id,
    triggerKind: row.trigger_kind,
    triggerKey: row.trigger_key,
    scheduledAt: row.scheduled_at,
    status: row.status,
    ...(row.reason === null ? {} : { reason: row.reason }),
    dryRun: row.dry_run === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

function task(row: TaskRow): AutomationTask {
  return Object.freeze({
    id: row.id,
    occurrenceId: row.occurrence_id,
    automationId: row.automation_id,
    status: row.status,
    cancelRequested: row.cancel_requested === 1,
    ...(row.claimed_by === null ? {} : { claimedBy: row.claimed_by }),
    ...(row.fencing_token === null ? {} : { fencingToken: row.fencing_token }),
    ...(row.lease_until === null ? {} : { leaseUntil: row.lease_until }),
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

function run(row: RunRow): AutomationRun {
  const status = deliveryStatus(row.delivery_status)
  const evidence = parseEvidence(row)
  return Object.freeze({
    id: row.id,
    occurrenceId: row.occurrence_id,
    automationId: row.automation_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    status: row.status,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.artifact_ref === null ? {} : { artifactRef: row.artifact_ref }),
    outputPreview: row.output_preview,
    usage: Object.freeze(JSON.parse(row.usage_json) as Record<string, unknown>),
    ...(status === undefined ? {} : { deliveryStatus: status }),
    ...(row.delivery_ref === null ? {} : { deliveryRef: row.delivery_ref }),
    evidenceStatus: evidenceStatus(row.evidence_status),
    ...(evidence === undefined ? {} : { evidence }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

function deepFreezeJson<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child)
  return Object.freeze(value)
}

function evaluationOutboxEntry(row: EvaluationOutboxRow): AutomationEvaluationOutboxEntry {
  if (row.observation_kind !== 'terminal'
    || (row.status !== 'pending' && row.status !== 'recorded' && row.status !== 'dead-letter')
    || !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0
    || !Number.isSafeInteger(row.next_attempt_at)) {
    throw new AutomationStoreError('invalid-state', 'automation evaluation outbox row has an invalid state')
  }
  if (Buffer.byteLength(row.payload_json, 'utf8') > 32_768) {
    throw new AutomationStoreError('invalid-state', 'automation evaluation payload exceeds 32768 bytes')
  }
  let payload: AutomationEvaluationOutcome
  try {
    payload = deepFreezeJson(JSON.parse(row.payload_json) as AutomationEvaluationOutcome)
  } catch {
    throw new AutomationStoreError('invalid-state', 'automation evaluation payload contains invalid JSON')
  }
  return Object.freeze({
    id: row.id,
    runId: row.run_id,
    kind: row.observation_kind,
    status: row.status,
    payload,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    ...(row.last_failure_at === null ? {} : { lastFailureAt: row.last_failure_at }),
    ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

function duty(row: DutyRow, acquired: boolean): DutyLease {
  return Object.freeze({
    acquired,
    ownerId: row.owner_id,
    fencingToken: row.fencing_token,
    leaseUntil: row.lease_until,
  })
}

function normalizeEvidenceAttribution(
  value: AutomationEvidenceAttribution | undefined,
): AutomationEvidenceAttribution {
  if (value === undefined) return Object.freeze({})
  const sessionId = value.sessionId === undefined ? undefined : text(value.sessionId, 'evidence.sessionId', 500)
  const ruleId = value.ruleId === undefined ? undefined : text(value.ruleId, 'evidence.ruleId', 200)
  const guidanceVersion = value.guidanceVersion === undefined
    ? undefined
    : safeInteger(value.guidanceVersion, 'evidence.guidanceVersion', 1, 1_000_000_000)
  if ((ruleId === undefined) !== (guidanceVersion === undefined)) {
    throw new AutomationStoreError(
      'invalid-definition',
      'evidence ruleId and guidanceVersion must be supplied together',
    )
  }
  return Object.freeze({
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(ruleId === undefined ? {} : { ruleId, guidanceVersion: guidanceVersion! }),
  })
}

function buildOutcomeEvidence(input: {
  automation: AutomationRecord
  runId: string
  outcome: AutomationRunStatus
  occurredAt: number
  attribution: AutomationEvidenceAttribution
}): { status: AutomationEvidenceStatus; json: string | null } {
  if (input.outcome === 'cancelled' || input.outcome === 'unknown') {
    return { status: 'suppressed', json: null }
  }
  const evidence: AutomationOutcomeEvidence = {
    situation: `automation:${input.automation.id}`,
    outcome: input.outcome === 'succeeded' ? 'succeeded' : 'failed',
    detail: `automation "${input.automation.definition.name}": run ${input.outcome}`,
    idempotencyKey: `automation-run:${input.runId}`,
    occurredAt: input.occurredAt,
    workspace: input.automation.definition.workspace,
    agentPreset: input.automation.definition.agentPreset,
    automationId: input.automation.id,
    runId: input.runId,
    ...input.attribution,
  }
  const json = JSON.stringify(evidence)
  if (Buffer.byteLength(json, 'utf8') > 16_384) {
    throw new AutomationStoreError('invalid-definition', 'automation evidence exceeds 16384 bytes')
  }
  return { status: 'pending', json }
}

function evaluationExecutionStatus(
  status: AutomationRunStatus,
): AutomationEvaluationOutcome['executionStatus'] {
  return status === 'timed_out' ? 'timed-out' : status
}

function nonNegativeUsageMetric(usage: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = usage[key]
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined
}

function buildTerminalEvaluation(input: {
  automation: AutomationRecord
  runId: string
  outcome: AutomationRunStatus
  occurredAt: number
  usage: Readonly<Record<string, unknown>>
  startedAt: number | null
  attemptNumber: number
  deliveryStatus: AutomationEvaluationOutcome['deliveryStatus']
}): AutomationEvaluationOutcome {
  const inputTokens = nonNegativeUsageMetric(input.usage, 'inputTokens')
  const outputTokens = nonNegativeUsageMetric(input.usage, 'outputTokens')
  const toolCalls = nonNegativeUsageMetric(input.usage, 'toolCalls')
  const latencyMs = input.startedAt === null ? undefined : Math.max(0, input.occurredAt - input.startedAt)
  const retries = Math.max(0, input.attemptNumber - 1)
  const metrics = Object.freeze({
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(latencyMs === undefined ? {} : { latencyMs }),
    ...(retries === 0 ? {} : { retries }),
  })
  const rawSituation = `automation:${input.automation.id}`
  const situation = Buffer.byteLength(rawSituation, 'utf8') <= 200
    ? rawSituation
    : `automation:${createHash('sha256').update(input.automation.id).digest('hex')}`
  return Object.freeze({
    scope: Object.freeze({
      workspace: input.automation.definition.workspace,
      preset: input.automation.definition.agentPreset,
    }),
    situation,
    executionStatus: evaluationExecutionStatus(input.outcome),
    objectiveStatus: 'unknown',
    deliveryStatus: input.deliveryStatus,
    source: Object.freeze({ kind: 'automation', id: 'assistant-automations' }),
    trust: 'trusted',
    evidence: Object.freeze([{ kind: 'automation-run', ref: input.runId }]),
    metrics,
    occurredAt: input.occurredAt,
    idempotencyKey: `assistant-automations:terminal:${input.runId}:v1`,
    evaluator: Object.freeze({ id: 'assistant-automations', version: 'terminal-v1' }),
  })
}

export function stableOccurrenceId(
  automationId: string,
  triggerKind: OccurrenceTriggerKind,
  triggerKey: string,
): string {
  return `occ-${createHash('sha256').update(`${automationId}\0${triggerKind}\0${triggerKey}`).digest('hex')}`
}

function initialNext(schedule: AutomationSchedule, now: number): number | undefined {
  if (schedule.kind === 'at') return Date.parse(schedule.at)
  return nextOccurrence(schedule, now - 1)
}

export class AutomationStore {
  private readonly database: DatabaseSync
  private readonly now: () => number
  private readonly maxPromptBytes: number
  private readonly maxAllowedTools: number
  private closed = false

  constructor(options: { path: string; now?: () => number; maxPromptBytes?: number; maxAllowedTools?: number }) {
    this.now = options.now ?? Date.now
    this.maxPromptBytes = options.maxPromptBytes ?? 16_384
    this.maxAllowedTools = options.maxAllowedTools ?? 100
    try {
      this.database = openAutomationDatabase(options.path)
    } catch (error) {
      if (error instanceof AutomationDatabaseError) throw new AutomationStoreError(error.code, error.message)
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const value = operation()
      this.database.exec('COMMIT')
      return value
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  createApproved(input: { automationId: string; idempotencyKey: string; definition: unknown }): AutomationRecord {
    const id = text(input.automationId, 'automationId', 500)
    const idempotencyKey = text(input.idempotencyKey, 'idempotencyKey', 500)
    const definition = normalizeAutomationDefinition(input.definition, this.maxPromptBytes, this.maxAllowedTools)
    const definitionHash = hash(definition)
    return this.transaction(() => {
      const byKey = this.database.prepare(
        'SELECT * FROM automation_definitions WHERE create_idempotency_key = ?',
      ).get(idempotencyKey) as DefinitionRow | undefined
      if (byKey !== undefined) {
        if (byKey.id !== id || byKey.definition_hash !== definitionHash) {
          throw new AutomationStoreError('idempotency-conflict', 'automation create key was reused with different input')
        }
        return record(byKey)
      }
      if (this.get(id) !== undefined) {
        throw new AutomationStoreError('idempotency-conflict', 'automation id is already in use')
      }
      const now = this.now()
      const next = initialNext(definition.schedule, now)
      this.database.prepare(`
        INSERT INTO automation_definitions(
          id, create_idempotency_key, definition_hash, definition_json, status,
          next_run_at, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, 1)
      `).run(id, idempotencyKey, definitionHash, JSON.stringify(definition), next ?? null, now, now)
      return this.get(id)!
    })
  }

  reconcileSystemOwned(input: {
    owner: string
    automationId: string
    idempotencyKey: string
    desiredStatus?: 'active' | 'paused'
    definition: unknown
  }): AutomationRecord {
    const owner = text(input.owner, 'owner', 200)
    const id = text(input.automationId, 'automationId', 500)
    const idempotencyKey = text(input.idempotencyKey, 'idempotencyKey', 500)
    const definition = normalizeAutomationDefinition(input.definition, this.maxPromptBytes, this.maxAllowedTools)
    const desiredStatus = input.desiredStatus ?? 'active'
    const inputHash = hash({ owner, automationId: id, desiredStatus, definition })
    const definitionHash = hash(definition)
    return this.transaction(() => {
      const prior = this.database.prepare(`
        SELECT input_hash, result_json FROM automation_system_reconciles WHERE idempotency_key = ?
      `).get(idempotencyKey) as { input_hash: string; result_json: string } | undefined
      if (prior !== undefined) {
        if (prior.input_hash !== inputHash) {
          throw new AutomationStoreError(
            'idempotency-conflict',
            'system reconciliation key was reused with different input',
          )
        }
        return Object.freeze(JSON.parse(prior.result_json) as AutomationRecord)
      }

      const current = this.get(id)
      if (current !== undefined && current.owner !== owner) {
        throw new AutomationStoreError('invalid-state', 'automation row is not owned by this system plugin')
      }
      const now = this.now()
      if (current === undefined) {
        this.database.prepare(`
          INSERT INTO automation_definitions(
            id, create_idempotency_key, system_owner, definition_hash, definition_json, status,
            next_run_at, created_at, updated_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `).run(
          id, `system:${owner}:${idempotencyKey}`, owner, definitionHash, JSON.stringify(definition), desiredStatus,
          desiredStatus === 'active' ? initialNext(definition.schedule, now) ?? null : null, now, now,
        )
      } else {
        const currentHash = hash(current.definition)
        if (currentHash !== definitionHash || current.status !== desiredStatus) {
          this.database.prepare(`
            UPDATE automation_definitions
            SET definition_hash = ?, definition_json = ?, status = ?, next_run_at = ?,
                updated_at = ?, version = version + 1
            WHERE id = ? AND system_owner = ? AND version = ?
          `).run(
            definitionHash, JSON.stringify(definition), desiredStatus,
            desiredStatus === 'active' ? initialNext(definition.schedule, now) ?? null : null,
            now, id, owner, current.version,
          )
        }
      }
      const result = this.get(id)!
      this.database.prepare(`
        INSERT INTO automation_system_reconciles(
          idempotency_key, system_owner, automation_id, input_hash, result_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(idempotencyKey, owner, id, inputHash, JSON.stringify(result), now)
      return result
    })
  }

  get(id: string): AutomationRecord | undefined {
    const row = this.database.prepare('SELECT * FROM automation_definitions WHERE id = ?').get(id) as DefinitionRow | undefined
    return row === undefined ? undefined : record(row)
  }

  list(): AutomationRecord[] {
    return (this.database.prepare('SELECT * FROM automation_definitions ORDER BY created_at, id').all() as unknown as DefinitionRow[])
      .map(record)
  }

  health(): {
    activeAutomations: number
    pausedAutomations: number
    pendingTasks: number
    runningTasks: number
    failedRuns: number
    unknownRuns: number
    pendingEvaluations: number
    retryingEvaluations: number
    failedEvaluationAttempts: number
    deadLetterEvaluations: number
    oldestPendingEvaluationAt: number
  } {
    const scalar = (sql: string) => (this.database.prepare(sql).get() as { count: number }).count
    return {
      activeAutomations: scalar("SELECT COUNT(*) AS count FROM automation_definitions WHERE status = 'active'"),
      pausedAutomations: scalar("SELECT COUNT(*) AS count FROM automation_definitions WHERE status = 'paused'"),
      pendingTasks: scalar("SELECT COUNT(*) AS count FROM automation_tasks WHERE status IN ('scheduled', 'claimed')"),
      runningTasks: scalar("SELECT COUNT(*) AS count FROM automation_tasks WHERE status = 'running'"),
      failedRuns: scalar("SELECT COUNT(*) AS count FROM automation_runs WHERE status IN ('failed', 'timed_out', 'cancelled')"),
      unknownRuns: scalar("SELECT COUNT(*) AS count FROM automation_runs WHERE status = 'unknown'"),
      pendingEvaluations: scalar("SELECT COUNT(*) AS count FROM automation_evaluation_outbox WHERE status = 'pending'"),
      retryingEvaluations: scalar(
        "SELECT COUNT(*) AS count FROM automation_evaluation_outbox WHERE status = 'pending' AND attempt_count > 0",
      ),
      // This is an append-only lifetime counter. It supports rate/delta
      // monitoring but does not by itself describe current health.
      failedEvaluationAttempts: scalar(
        'SELECT COALESCE(SUM(attempt_count), 0) AS count FROM automation_evaluation_outbox',
      ),
      deadLetterEvaluations: scalar(
        "SELECT COUNT(*) AS count FROM automation_evaluation_outbox WHERE status = 'dead-letter'",
      ),
      oldestPendingEvaluationAt: scalar(
        "SELECT COALESCE(MIN(created_at), 0) AS count FROM automation_evaluation_outbox WHERE status = 'pending'",
      ),
    }
  }

  changeApproved(input: {
    automationId: string
    operation: 'delete' | 'pause' | 'resume'
    expectedVersion: number
    idempotencyKey: string
  }): AutomationRecord {
    const inputHash = hash(input)
    return this.transaction(() => {
      const prior = this.database.prepare(
        'SELECT input_hash, result_json FROM automation_changes WHERE idempotency_key = ?',
      ).get(input.idempotencyKey) as { input_hash: string; result_json: string } | undefined
      if (prior !== undefined) {
        if (prior.input_hash !== inputHash) {
          throw new AutomationStoreError('idempotency-conflict', 'automation change key was reused with different input')
        }
        return Object.freeze(JSON.parse(prior.result_json) as AutomationRecord)
      }
      const current = this.get(input.automationId)
      if (current === undefined) throw new AutomationStoreError('not-found', 'automation was not found')
      if (current.version !== input.expectedVersion) {
        throw new AutomationStoreError('version-conflict', 'automation version changed')
      }
      if (current.status === 'deleted') throw new AutomationStoreError('invalid-state', 'automation is deleted')
      if (input.operation === 'pause' && current.status !== 'active') {
        throw new AutomationStoreError('invalid-state', 'only an active automation can be paused')
      }
      if (input.operation === 'resume' && current.status !== 'paused') {
        throw new AutomationStoreError('invalid-state', 'only a paused automation can be resumed')
      }
      const status: AutomationStatus = input.operation === 'delete'
        ? 'deleted'
        : input.operation === 'pause' ? 'paused' : 'active'
      const now = this.now()
      const next = status === 'active' ? initialNext(current.definition.schedule, now) : undefined
      this.database.prepare(`
        UPDATE automation_definitions
        SET status = ?, next_run_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND version = ?
      `).run(status, next ?? null, now, current.id, current.version)
      const result = this.get(current.id)!
      this.database.prepare(`
        INSERT INTO automation_changes(
          idempotency_key, automation_id, operation, expected_version, input_hash, result_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.idempotencyKey, input.automationId, input.operation, input.expectedVersion,
        inputHash, JSON.stringify(result), now,
      )
      return result
    })
  }

  materializeDue(input: { now: number; misfireGraceMs: number; maxCatchUp: number }): AutomationOccurrence[] {
    if (!Number.isSafeInteger(input.now) || !Number.isSafeInteger(input.misfireGraceMs)
      || input.misfireGraceMs < 0 || !Number.isSafeInteger(input.maxCatchUp)
      || input.maxCatchUp <= 0 || input.maxCatchUp > 1_000) {
      throw new AutomationStoreError('invalid-definition', 'materialization bounds are invalid')
    }
    return this.transaction(() => {
      const due = this.database.prepare(`
        SELECT * FROM automation_definitions
        WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at, id
      `).all(input.now) as unknown as DefinitionRow[]
      const created: AutomationOccurrence[] = []
      for (const row of due) {
        const automation = record(row)
        const firstDue = automation.nextRunAt!
        const cutoff = input.now - input.misfireGraceMs
        const current = dueOccurrences(
          automation.definition.schedule,
          Math.max(firstDue - 1, cutoff),
          input.now,
          input.maxCatchUp,
        )
        const latestMissed = previousOccurrence(automation.definition.schedule, cutoff)
        const missed: number[] = []
        if (latestMissed !== undefined && latestMissed >= firstDue) {
          if (automation.definition.misfire.kind === 'latest') {
            missed.push(latestMissed)
          } else if (automation.definition.misfire.kind === 'bounded-replay') {
            let cursor: number | undefined = latestMissed
            while (cursor !== undefined && cursor >= firstDue
              && missed.length < Math.min(automation.definition.misfire.limit, input.maxCatchUp)) {
              missed.push(cursor)
              cursor = previousOccurrence(automation.definition.schedule, cursor - 1)
            }
            missed.reverse()
          }
        }
        const selected = [...new Set([...missed, ...current])].sort((left, right) => left - right)
          .slice(-input.maxCatchUp)
        if (selected.length === 0 && latestMissed !== undefined && latestMissed >= firstDue) {
          const skipped = this.insertOccurrence({
            automationId: automation.id,
            triggerKind: 'scheduled',
            triggerKey: String(latestMissed),
            scheduledAt: latestMissed,
            status: 'skipped',
            reason: 'misfire-skip',
            dryRun: false,
          })
          if (skipped.created) created.push(skipped.value)
        }
        for (const scheduledAt of selected) {
          const inserted = this.insertOccurrence({
            automationId: automation.id,
            triggerKind: 'scheduled',
            triggerKey: String(scheduledAt),
            scheduledAt,
            status: 'pending',
            dryRun: false,
          })
          if (inserted.created) created.push(inserted.value)
        }
        const next = nextOccurrence(automation.definition.schedule, input.now)
        this.database.prepare(`
          UPDATE automation_definitions SET next_run_at = ?, updated_at = ? WHERE id = ?
        `).run(next ?? null, input.now, automation.id)
      }
      return created
    })
  }

  ingestExternal(input: { automationId: string; externalEventId: string; occurredAt: number }): AutomationOccurrence {
    const eventId = text(input.externalEventId, 'externalEventId', 1_000)
    if (!Number.isSafeInteger(input.occurredAt)) {
      throw new AutomationStoreError('invalid-definition', 'occurredAt must be a safe integer')
    }
    return this.transaction(() => {
      const automation = this.get(input.automationId)
      if (automation === undefined) throw new AutomationStoreError('not-found', 'automation was not found')
      if (automation.status !== 'active') throw new AutomationStoreError('invalid-state', 'automation is not active')
      const inserted = this.insertOccurrence({
        automationId: automation.id,
        triggerKind: 'external',
        triggerKey: eventId,
        scheduledAt: input.occurredAt,
        status: 'pending',
        dryRun: false,
      })
      if (!inserted.created && inserted.value.scheduledAt !== input.occurredAt) {
        throw new AutomationStoreError('idempotency-conflict', 'external event id was reused with another timestamp')
      }
      return inserted.value
    })
  }

  createManual(input: { automationId: string; requestId: string; dryRun: boolean }): AutomationOccurrence {
    const requestId = text(input.requestId, 'requestId', 1_000)
    return this.transaction(() => {
      const automation = this.get(input.automationId)
      if (automation === undefined) throw new AutomationStoreError('not-found', 'automation was not found')
      if (automation.status !== 'active') throw new AutomationStoreError('invalid-state', 'automation is not active')
      const occurrenceId = stableOccurrenceId(automation.id, 'manual', requestId)
      const existing = this.database.prepare('SELECT * FROM automation_occurrences WHERE id = ?')
        .get(occurrenceId) as OccurrenceRow | undefined
      if (existing !== undefined) return occurrence(existing)
      return this.insertOccurrence({
        automationId: automation.id,
        triggerKind: 'manual',
        triggerKey: requestId,
        scheduledAt: this.now(),
        status: 'pending',
        dryRun: input.dryRun,
      }).value
    })
  }

  listOccurrences(input: { automationId?: string; limit: number }): AutomationOccurrence[] {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > 1_000) {
      throw new AutomationStoreError('invalid-definition', 'occurrence limit must be between 1 and 1000')
    }
    const rows = input.automationId === undefined
      ? this.database.prepare(`
          SELECT * FROM automation_occurrences ORDER BY scheduled_at, id LIMIT ?
        `).all(input.limit)
      : this.database.prepare(`
          SELECT * FROM automation_occurrences WHERE automation_id = ? ORDER BY scheduled_at, id LIMIT ?
        `).all(input.automationId, input.limit)
    return (rows as unknown as OccurrenceRow[]).map(occurrence)
  }

  getOccurrence(id: string): AutomationOccurrence | undefined {
    const row = this.database.prepare('SELECT * FROM automation_occurrences WHERE id = ?').get(id) as OccurrenceRow | undefined
    return row === undefined ? undefined : occurrence(row)
  }

  listTasks(input: { automationId?: string; limit: number }): AutomationTask[] {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > 1_000) {
      throw new AutomationStoreError('invalid-definition', 'task limit must be between 1 and 1000')
    }
    const rows = input.automationId === undefined
      ? this.database.prepare('SELECT * FROM automation_tasks ORDER BY created_at, id LIMIT ?').all(input.limit)
      : this.database.prepare(`
          SELECT * FROM automation_tasks WHERE automation_id = ? ORDER BY created_at, id LIMIT ?
        `).all(input.automationId, input.limit)
    return (rows as unknown as TaskRow[]).map(task)
  }

  getTaskRecord(id: string): AutomationTask | undefined {
    return this.getTask(id)
  }

  /** Immutable definition captured by the winning claim, never the mutable current row. */
  getTaskExecutionSnapshot(taskId: string): AutomationRecord | undefined {
    const taskRow = this.database.prepare('SELECT * FROM automation_tasks WHERE id = ?').get(taskId) as TaskRow | undefined
    if (taskRow === undefined || taskRow.attempt_count < 1) return undefined
    const attempt = this.database.prepare(`
      SELECT * FROM automation_attempts WHERE task_id = ? AND attempt_number = ?
    `).get(taskId, taskRow.attempt_count) as AttemptRow | undefined
    return attempt === undefined ? undefined : automationSnapshot(attempt, taskRow.automation_id)
  }

  /** Immutable definition associated with a durable terminal run. */
  getRunExecutionSnapshot(runId: string): AutomationRecord | undefined {
    const row = this.database.prepare(`
      SELECT attempt.*, run.automation_id AS expected_automation_id
      FROM automation_runs AS run
      JOIN automation_attempts AS attempt ON attempt.id = run.attempt_id
      WHERE run.id = ?
    `).get(runId) as (AttemptRow & { expected_automation_id: string }) | undefined
    return row === undefined ? undefined : automationSnapshot(row, row.expected_automation_id)
  }

  getRun(runId: string): AutomationRun | undefined {
    const row = this.database.prepare('SELECT * FROM automation_runs WHERE id = ?').get(runId) as RunRow | undefined
    return row === undefined ? undefined : run(row)
  }

  acquireDuty(input: { ownerId: string; now: number; leaseMs: number }): DutyLease {
    const ownerId = text(input.ownerId, 'ownerId', 500)
    this.validateLease(input.now, input.leaseMs)
    return this.transaction(() => {
      const current = this.database.prepare('SELECT * FROM duty_lease WHERE singleton = 1').get() as DutyRow | undefined
      if (current === undefined) {
        this.database.prepare(`
          INSERT INTO duty_lease(singleton, owner_id, fencing_token, lease_until, updated_at)
          VALUES (1, ?, 1, ?, ?)
        `).run(ownerId, input.now + input.leaseMs, input.now)
        return duty({ owner_id: ownerId, fencing_token: 1, lease_until: input.now + input.leaseMs }, true)
      }
      if (current.owner_id !== ownerId && current.lease_until > input.now) return duty(current, false)
      const fencingToken = current.owner_id === ownerId && current.lease_until > input.now
        ? current.fencing_token
        : current.fencing_token + 1
      const leaseUntil = input.now + input.leaseMs
      this.database.prepare(`
        UPDATE duty_lease SET owner_id = ?, fencing_token = ?, lease_until = ?, updated_at = ? WHERE singleton = 1
      `).run(ownerId, fencingToken, leaseUntil, input.now)
      return duty({ owner_id: ownerId, fencing_token: fencingToken, lease_until: leaseUntil }, true)
    })
  }

  renewDuty(input: { ownerId: string; fencingToken: number; now: number; leaseMs: number }): DutyLease {
    const ownerId = text(input.ownerId, 'ownerId', 500)
    this.validateLease(input.now, input.leaseMs)
    return this.transaction(() => {
      const current = this.requireDuty(ownerId, input.fencingToken, input.now)
      const leaseUntil = input.now + input.leaseMs
      this.database.prepare('UPDATE duty_lease SET lease_until = ?, updated_at = ? WHERE singleton = 1')
        .run(leaseUntil, input.now)
      return duty({ ...current, lease_until: leaseUntil }, true)
    })
  }

  claimNextTask(input: { ownerId: string; fencingToken: number; now: number; leaseMs: number }): AutomationTask | undefined {
    this.validateLease(input.now, input.leaseMs)
    return this.transaction(() => {
      this.requireDuty(input.ownerId, input.fencingToken, input.now)
      const candidates = this.database.prepare(`
        SELECT task.* FROM automation_tasks task
        JOIN automation_definitions definition ON definition.id = task.automation_id
        WHERE task.status = 'scheduled' AND definition.status = 'active'
        ORDER BY task.created_at, task.id LIMIT 100
      `).all() as unknown as TaskRow[]
      for (const candidate of candidates) {
        const result = this.claimTaskInTransaction(candidate, input)
        if (result !== undefined) return result
      }
      return undefined
    })
  }

  claimTask(input: {
    taskId: string
    ownerId: string
    fencingToken: number
    now: number
    leaseMs: number
  }): AutomationTask | undefined {
    this.validateLease(input.now, input.leaseMs)
    return this.transaction(() => {
      this.requireDuty(input.ownerId, input.fencingToken, input.now)
      const row = this.database.prepare('SELECT * FROM automation_tasks WHERE id = ?').get(input.taskId) as TaskRow | undefined
      if (row === undefined) throw new AutomationStoreError('not-found', 'automation task was not found')
      if (row.status !== 'scheduled') throw new AutomationStoreError('invalid-state', 'only scheduled tasks can be claimed')
      return this.claimTaskInTransaction(row, input)
    })
  }

  startTask(input: {
    taskId: string
    ownerId: string
    fencingToken: number
    now: number
    leaseMs: number
    sessionId: string
  }): AutomationTask {
    const sessionId = text(input.sessionId, 'sessionId', 1_000)
    this.validateLease(input.now, input.leaseMs)
    return this.transaction(() => {
      const row = this.requireMutableTask(input, ['claimed'])
      const leaseUntil = input.now + input.leaseMs
      this.database.prepare(`
        UPDATE automation_tasks SET status = 'running', lease_until = ?, updated_at = ? WHERE id = ?
      `).run(leaseUntil, input.now, row.id)
      this.database.prepare(`
        UPDATE automation_attempts SET status = 'running', session_id = ?, started_at = ?, updated_at = ?
        WHERE task_id = ? AND attempt_number = ? AND fencing_token = ?
      `).run(sessionId, input.now, input.now, row.id, row.attempt_count, input.fencingToken)
      return this.getTask(row.id)!
    })
  }

  heartbeatTask(input: {
    taskId: string
    ownerId: string
    fencingToken: number
    now: number
    leaseMs: number
  }): AutomationTask {
    this.validateLease(input.now, input.leaseMs)
    return this.transaction(() => {
      const row = this.requireMutableTask(input, ['claimed', 'running'])
      this.database.prepare('UPDATE automation_tasks SET lease_until = ?, updated_at = ? WHERE id = ?')
        .run(input.now + input.leaseMs, input.now, row.id)
      return this.getTask(row.id)!
    })
  }

  requestCancellation(input: { taskId: string; now: number }): AutomationTask {
    if (!Number.isSafeInteger(input.now)) throw new AutomationStoreError('invalid-definition', 'now must be a safe integer')
    return this.transaction(() => {
      const row = this.database.prepare('SELECT * FROM automation_tasks WHERE id = ?').get(input.taskId) as TaskRow | undefined
      if (row === undefined) throw new AutomationStoreError('not-found', 'automation task was not found')
      if (!['claimed', 'running', 'scheduled'].includes(row.status)) {
        throw new AutomationStoreError('invalid-state', 'terminal task cannot be cancelled')
      }
      if (row.status === 'scheduled') {
        this.database.prepare(`UPDATE automation_tasks SET status = 'cancelled', cancel_requested = 1, updated_at = ? WHERE id = ?`)
          .run(input.now, row.id)
        this.database.prepare(`UPDATE automation_occurrences SET status = 'cancelled', reason = 'cancelled-before-claim', updated_at = ? WHERE id = ?`)
          .run(input.now, row.occurrence_id)
      } else {
        this.database.prepare('UPDATE automation_tasks SET cancel_requested = 1, updated_at = ? WHERE id = ?')
          .run(input.now, row.id)
      }
      return this.getTask(row.id)!
    })
  }

  completeTask(input: {
    taskId: string
    ownerId: string
    fencingToken: number
    now: number
    outcome: AutomationRunStatus
    sessionId?: string
    artifactRef?: string
    outputPreview: string
    usage: Readonly<Record<string, unknown>>
    evidenceAttribution?: AutomationEvidenceAttribution
  }): AutomationRun {
    if (!Number.isSafeInteger(input.now)) throw new AutomationStoreError('invalid-definition', 'now must be a safe integer')
    const preview = typeof input.outputPreview === 'string' && Buffer.byteLength(input.outputPreview, 'utf8') <= 8_192
      ? input.outputPreview
      : (() => { throw new AutomationStoreError('invalid-definition', 'outputPreview exceeds 8192 bytes') })()
    const usageJson = JSON.stringify(input.usage)
    if (usageJson === undefined || Buffer.byteLength(usageJson, 'utf8') > 16_384) {
      throw new AutomationStoreError('invalid-definition', 'usage must be bounded JSON')
    }
    const evidenceAttribution = normalizeEvidenceAttribution(input.evidenceAttribution)
    return this.transaction(() => {
      const existing = this.database.prepare('SELECT * FROM automation_runs WHERE task_id = ?').get(input.taskId) as RunRow | undefined
      if (existing !== undefined) {
        const taskRow = this.database.prepare('SELECT * FROM automation_tasks WHERE id = ?').get(input.taskId) as TaskRow | undefined
        if (taskRow?.claimed_by !== input.ownerId || taskRow.fencing_token !== input.fencingToken) {
          throw new AutomationStoreError('stale-fence', 'task completion belongs to another fence')
        }
        const exact = existing.status === input.outcome
          && existing.session_id === (input.sessionId ?? null)
          && existing.artifact_ref === (input.artifactRef ?? null)
          && existing.output_preview === preview
          && existing.usage_json === usageJson
        if (!exact) throw new AutomationStoreError('idempotency-conflict', 'task completion was replayed with different output')
        return run(existing)
      }
      const row = this.requireMutableTask(input, ['claimed', 'running'])
      const attempt = this.database.prepare(`
        SELECT * FROM automation_attempts WHERE task_id = ? AND attempt_number = ? AND fencing_token = ?
      `).get(row.id, row.attempt_count, input.fencingToken) as AttemptRow | undefined
      if (attempt === undefined) throw new AutomationStoreError('stale-fence', 'winning attempt was not found')
      const runId = `run-${row.id}`
      const automation = automationSnapshot(attempt, row.automation_id)
      if (automation === undefined) {
        throw new AutomationStoreError('invalid-state', 'winning attempt has no immutable automation snapshot')
      }
      const evidence = buildOutcomeEvidence({
        automation,
        runId,
        outcome: input.outcome,
        occurredAt: input.now,
        attribution: evidenceAttribution,
      })
      const normalizedOutput = preview.normalize('NFC').trim()
      const runDeliveryStatus = input.outcome === 'succeeded'
        && automation.definition.deliveryBindingId !== undefined
        ? normalizedOutput === '' || automation.definition.deliverySuppressExact?.includes(normalizedOutput) === true
          ? 'suppressed'
          : 'pending'
        : null
      const evaluation = buildTerminalEvaluation({
        automation,
        runId,
        outcome: input.outcome,
        occurredAt: input.now,
        usage: input.usage,
        startedAt: attempt.started_at,
        attemptNumber: attempt.attempt_number,
        deliveryStatus: runDeliveryStatus === 'pending' ? 'unknown' : 'not-required',
      })
      const evaluationJson = JSON.stringify(evaluation)
      if (Buffer.byteLength(evaluationJson, 'utf8') > 32_768) {
        throw new AutomationStoreError('invalid-definition', 'automation evaluation payload exceeds 32768 bytes')
      }
      this.database.prepare(`
        INSERT INTO automation_runs(
          id, occurrence_id, automation_id, task_id, attempt_id, status, session_id, artifact_ref,
          output_preview, usage_json, delivery_status, delivery_ref, evidence_status, evidence_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
      `).run(
        runId, row.occurrence_id, row.automation_id, row.id, attempt.id, input.outcome,
        input.sessionId ?? null, input.artifactRef ?? null, preview, usageJson, runDeliveryStatus,
        evidence.status, evidence.json, input.now, input.now,
      )
      this.database.prepare(`
        INSERT INTO automation_evaluation_outbox(
          id, run_id, observation_kind, status, payload_json, attempt_count,
          next_attempt_at, last_failure_at, last_error_code, created_at, updated_at
        ) VALUES (?, ?, 'terminal', 'pending', ?, 0, ?, NULL, NULL, ?, ?)
      `).run(`evaluation-terminal:${runId}`, runId, evaluationJson, input.now, input.now, input.now)
      this.database.prepare(`
        UPDATE automation_attempts
        SET status = ?, failure_code = ?, finished_at = ?, updated_at = ? WHERE id = ?
      `).run(input.outcome, input.outcome === 'succeeded' ? null : input.outcome, input.now, input.now, attempt.id)
      this.database.prepare(`
        UPDATE automation_tasks SET status = ?, lease_until = NULL, updated_at = ? WHERE id = ?
      `).run(input.outcome, input.now, row.id)
      this.database.prepare(`
        UPDATE automation_occurrences SET status = ?, reason = ?, updated_at = ? WHERE id = ?
      `).run(input.outcome, input.outcome === 'succeeded' ? null : input.outcome, input.now, row.occurrence_id)
      return run(this.database.prepare('SELECT * FROM automation_runs WHERE id = ?').get(runId) as unknown as RunRow)
    })
  }

  listPendingEvidence(limit: number): AutomationRun[] {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new AutomationStoreError('invalid-definition', 'evidence limit must be between 1 and 1000')
    }
    return (this.database.prepare(`
      SELECT * FROM automation_runs WHERE evidence_status = 'pending' ORDER BY updated_at, id LIMIT ?
    `).all(limit) as unknown as RunRow[]).map(run)
  }

  deferRunEvidence(input: { runId: string; expectedStatus: 'pending'; now: number }): AutomationRun {
    if (!Number.isSafeInteger(input.now)) throw new AutomationStoreError('invalid-definition', 'now must be a safe integer')
    const changed = this.database.prepare(`
      UPDATE automation_runs SET updated_at = MAX(updated_at + 1, ?)
      WHERE id = ? AND evidence_status = ?
    `).run(input.now, input.runId, input.expectedStatus)
    if (changed.changes !== 1) {
      const current = this.database.prepare('SELECT * FROM automation_runs WHERE id = ?').get(input.runId) as RunRow | undefined
      if (current?.evidence_status === 'recorded') return run(current)
      throw new AutomationStoreError('version-conflict', 'run evidence state changed before deferral')
    }
    return run(this.database.prepare('SELECT * FROM automation_runs WHERE id = ?').get(input.runId) as unknown as RunRow)
  }

  completeRunEvidence(input: {
    runId: string
    expectedStatus: 'pending'
    now: number
  }): AutomationRun {
    if (!Number.isSafeInteger(input.now)) throw new AutomationStoreError('invalid-definition', 'now must be a safe integer')
    const changed = this.database.prepare(`
      UPDATE automation_runs SET evidence_status = 'recorded', updated_at = ?
      WHERE id = ? AND evidence_status = ?
    `).run(input.now, input.runId, input.expectedStatus)
    if (changed.changes !== 1) {
      const current = this.database.prepare('SELECT * FROM automation_runs WHERE id = ?').get(input.runId) as RunRow | undefined
      if (current?.evidence_status === 'recorded') return run(current)
      throw new AutomationStoreError('version-conflict', 'run evidence state changed before completion')
    }
    return run(this.database.prepare('SELECT * FROM automation_runs WHERE id = ?').get(input.runId) as unknown as RunRow)
  }

  listPendingEvaluations(limit: number, now = Number.MAX_SAFE_INTEGER): AutomationEvaluationOutboxEntry[] {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new AutomationStoreError('invalid-definition', 'evaluation limit must be between 1 and 1000')
    }
    if (!Number.isSafeInteger(now)) throw new AutomationStoreError('invalid-definition', 'now must be a safe integer')
    const rows = this.database.prepare(`
      SELECT * FROM automation_evaluation_outbox
      WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT ?
    `).all(now, limit) as unknown as EvaluationOutboxRow[]
    const output: AutomationEvaluationOutboxEntry[] = []
    for (const row of rows) {
      try {
        output.push(evaluationOutboxEntry(row))
      } catch {
        // A repaired or legacy poison row must not abort scheduler recovery or
        // starve valid observations behind it. Quarantine it without exposing
        // payload contents or exception text.
        this.database.prepare(`
          UPDATE automation_evaluation_outbox
          SET status = 'dead-letter', attempt_count = attempt_count + 1,
              last_failure_at = ?, last_error_code = 'invalid-outbox-payload', updated_at = ?
          WHERE id = ? AND status = 'pending'
        `).run(now, now, row.id)
      }
    }
    return output
  }

  getPendingEvaluationForRun(runId: string, now = Number.MAX_SAFE_INTEGER): AutomationEvaluationOutboxEntry | undefined {
    if (!Number.isSafeInteger(now)) throw new AutomationStoreError('invalid-definition', 'now must be a safe integer')
    const row = this.database.prepare(`
      SELECT * FROM automation_evaluation_outbox
      WHERE run_id = ? AND observation_kind = 'terminal' AND status = 'pending' AND next_attempt_at <= ?
      ORDER BY id LIMIT 1
    `).get(runId, now) as EvaluationOutboxRow | undefined
    if (row === undefined) return undefined
    try {
      return evaluationOutboxEntry(row)
    } catch {
      this.database.prepare(`
        UPDATE automation_evaluation_outbox
        SET status = 'dead-letter', attempt_count = attempt_count + 1,
            last_failure_at = ?, last_error_code = 'invalid-outbox-payload', updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(now, now, row.id)
      return undefined
    }
  }

  deferEvaluation(input: {
    id: string
    expectedStatus: 'pending'
    now: number
    retryAt: number
    maxAttempts: number
    errorCode: string
  }): AutomationEvaluationOutboxEntry {
    if (!Number.isSafeInteger(input.now)) throw new AutomationStoreError('invalid-definition', 'now must be a safe integer')
    if (!Number.isSafeInteger(input.retryAt) || input.retryAt < input.now
      || !Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 100) {
      throw new AutomationStoreError('invalid-definition', 'evaluation retry bounds are invalid')
    }
    const errorCode = text(input.errorCode, 'evaluation errorCode', 64)
    const changed = this.database.prepare(`
      UPDATE automation_evaluation_outbox
      SET attempt_count = attempt_count + 1,
          status = CASE WHEN attempt_count + 1 >= ? THEN 'dead-letter' ELSE 'pending' END,
          next_attempt_at = CASE WHEN attempt_count + 1 >= ? THEN next_attempt_at ELSE ? END,
          last_failure_at = ?, last_error_code = ?, updated_at = ?
      WHERE id = ? AND status = ?
    `).run(
      input.maxAttempts, input.maxAttempts, input.retryAt, input.now, errorCode,
      input.now, input.id, input.expectedStatus,
    )
    if (changed.changes !== 1) {
      const current = this.database.prepare('SELECT * FROM automation_evaluation_outbox WHERE id = ?')
        .get(input.id) as EvaluationOutboxRow | undefined
      if (current?.status === 'recorded') return evaluationOutboxEntry(current)
      throw new AutomationStoreError('version-conflict', 'evaluation outbox state changed before deferral')
    }
    return evaluationOutboxEntry(this.database.prepare('SELECT * FROM automation_evaluation_outbox WHERE id = ?')
      .get(input.id) as unknown as EvaluationOutboxRow)
  }

  completeEvaluation(input: {
    id: string
    expectedStatus: 'pending'
    now: number
  }): AutomationEvaluationOutboxEntry {
    if (!Number.isSafeInteger(input.now)) throw new AutomationStoreError('invalid-definition', 'now must be a safe integer')
    const changed = this.database.prepare(`
      UPDATE automation_evaluation_outbox SET status = 'recorded', updated_at = ?
      WHERE id = ? AND status = ?
    `).run(input.now, input.id, input.expectedStatus)
    if (changed.changes !== 1) {
      const current = this.database.prepare('SELECT * FROM automation_evaluation_outbox WHERE id = ?')
        .get(input.id) as EvaluationOutboxRow | undefined
      if (current?.status === 'recorded') return evaluationOutboxEntry(current)
      throw new AutomationStoreError('version-conflict', 'evaluation outbox state changed before completion')
    }
    return evaluationOutboxEntry(this.database.prepare('SELECT * FROM automation_evaluation_outbox WHERE id = ?')
      .get(input.id) as unknown as EvaluationOutboxRow)
  }

  listPendingDeliveries(limit: number): AutomationRun[] {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new AutomationStoreError('invalid-definition', 'delivery limit must be between 1 and 1000')
    }
    return (this.database.prepare(`
      SELECT * FROM automation_runs WHERE delivery_status = 'pending' ORDER BY created_at, id LIMIT ?
    `).all(limit) as unknown as RunRow[]).map(run)
  }

  completeRunDelivery(input: {
    runId: string
    expectedStatus: 'pending'
    deliveryRef: string
    now: number
  }): AutomationRun {
    if (!Number.isSafeInteger(input.now)) throw new AutomationStoreError('invalid-definition', 'now must be a safe integer')
    const deliveryRef = text(input.deliveryRef, 'deliveryRef', 500)
    const changed = this.database.prepare(`
      UPDATE automation_runs SET delivery_status = 'enqueued', delivery_ref = ?, updated_at = ?
      WHERE id = ? AND delivery_status = ?
    `).run(deliveryRef, input.now, input.runId, input.expectedStatus)
    if (changed.changes !== 1) {
      const current = this.database.prepare('SELECT * FROM automation_runs WHERE id = ?').get(input.runId) as RunRow | undefined
      if (current?.delivery_status === 'enqueued' && current.delivery_ref === deliveryRef) return run(current)
      throw new AutomationStoreError('version-conflict', 'run delivery state changed before completion')
    }
    return run(this.database.prepare('SELECT * FROM automation_runs WHERE id = ?').get(input.runId) as unknown as RunRow)
  }

  suppressRunDelivery(input: {
    runId: string
    expectedStatus: 'pending'
    now: number
  }): AutomationRun {
    if (!Number.isSafeInteger(input.now)) throw new AutomationStoreError('invalid-definition', 'now must be a safe integer')
    const changed = this.database.prepare(`
      UPDATE automation_runs SET delivery_status = 'suppressed', delivery_ref = NULL, updated_at = ?
      WHERE id = ? AND delivery_status = ?
    `).run(input.now, input.runId, input.expectedStatus)
    if (changed.changes !== 1) {
      const current = this.database.prepare('SELECT * FROM automation_runs WHERE id = ?').get(input.runId) as RunRow | undefined
      if (current?.delivery_status === 'suppressed' && current.delivery_ref === null) return run(current)
      throw new AutomationStoreError('version-conflict', 'run delivery state changed before suppression')
    }
    return run(this.database.prepare('SELECT * FROM automation_runs WHERE id = ?').get(input.runId) as unknown as RunRow)
  }

  listRuns(input: { automationId?: string; limit: number }): AutomationRun[] {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > 1_000) {
      throw new AutomationStoreError('invalid-definition', 'run limit must be between 1 and 1000')
    }
    const rows = input.automationId === undefined
      ? this.database.prepare('SELECT * FROM automation_runs ORDER BY created_at, id LIMIT ?').all(input.limit)
      : this.database.prepare(`SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY created_at, id LIMIT ?`)
        .all(input.automationId, input.limit)
    return (rows as unknown as RunRow[]).map(run)
  }

  /**
   * Newest-first terminal history whose immutable claim snapshot belongs to one
   * exact Agent scope.  Legacy rows without a verifiable snapshot are omitted;
   * the current mutable definition is never used to guess historical scope.
   */
  listRunsForExecutionScope(input: {
    workspace: string
    agentPreset: string
    automationId?: string
    limit: number
  }): AutomationRun[] {
    if (!isAbsolute(input.workspace) || input.agentPreset.normalize('NFC').trim() === '') {
      throw new AutomationStoreError('invalid-definition', 'run history requires an absolute workspace and preset')
    }
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > 1_000) {
      throw new AutomationStoreError('invalid-definition', 'run limit must be between 1 and 1000')
    }
    const output: AutomationRun[] = []
    let cursor: { createdAt: number; id: string } | undefined
    while (output.length < input.limit) {
      const pageSize = Math.min(1_000, Math.max(100, (input.limit - output.length) * 4))
      const automationClause = input.automationId === undefined ? '' : 'AND run.automation_id = ?'
      const cursorClause = cursor === undefined
        ? ''
        : 'AND (run.created_at < ? OR (run.created_at = ? AND run.id < ?))'
      const parameters: Array<string | number> = []
      if (input.automationId !== undefined) parameters.push(input.automationId)
      if (cursor !== undefined) parameters.push(cursor.createdAt, cursor.createdAt, cursor.id)
      parameters.push(pageSize)
      const rows = this.database.prepare(`
        SELECT run.*,
          attempt.automation_snapshot_hash AS scope_snapshot_hash,
          attempt.automation_snapshot_json AS scope_snapshot_json
        FROM automation_runs AS run
        JOIN automation_attempts AS attempt ON attempt.id = run.attempt_id
        WHERE 1 = 1 ${automationClause} ${cursorClause}
        ORDER BY run.created_at DESC, run.id DESC
        LIMIT ?
      `).all(...parameters) as unknown as ScopedRunRow[]
      for (const row of rows) {
        const snapshot = decodeAutomationSnapshot(
          row.scope_snapshot_hash,
          row.scope_snapshot_json,
          row.automation_id,
        )
        if (snapshot !== undefined && executionScopeMatches(snapshot, input)) output.push(run(row))
        if (output.length === input.limit) break
      }
      const last = rows.at(-1)
      if (last === undefined || rows.length < pageSize) break
      cursor = { createdAt: last.created_at, id: last.id }
    }
    return Object.freeze(output) as AutomationRun[]
  }

  recoverExpiredTasks(input: { now: number; limit?: number }): AutomationTask[] {
    if (!Number.isSafeInteger(input.now)) throw new AutomationStoreError('invalid-definition', 'now must be a safe integer')
    const limit = input.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new AutomationStoreError('invalid-definition', 'recovery limit must be between 1 and 1000')
    }
    return this.transaction(() => {
      const rows = this.database.prepare(`
        SELECT * FROM automation_tasks
        WHERE status IN ('claimed', 'running') AND lease_until IS NOT NULL AND lease_until <= ?
        ORDER BY lease_until, id LIMIT ?
      `).all(input.now, limit) as unknown as TaskRow[]
      const recovered: AutomationTask[] = []
      for (const row of rows) {
        const attempt = this.database.prepare(`
          SELECT * FROM automation_attempts
          WHERE task_id = ? AND attempt_number = ? AND fencing_token = ?
        `).get(row.id, row.attempt_count, row.fencing_token) as AttemptRow | undefined
        if (attempt === undefined) {
          throw new AutomationStoreError('invalid-state', 'expired task has no matching execution attempt')
        }
        const snapshot = automationSnapshot(attempt, row.automation_id)
        const retry = row.status === 'running'
          && snapshot?.definition.retrySafety === 'idempotent'
          && row.attempt_count <= snapshot.definition.maxRetries
        const target: AutomationTaskStatus = row.status === 'claimed' || retry ? 'scheduled' : 'unknown'
        const attemptStatus: AutomationTaskStatus = row.status === 'claimed' ? 'lost' : 'unknown'
        this.database.prepare(`
          UPDATE automation_attempts
          SET status = ?, failure_code = ?, finished_at = ?, updated_at = ?
          WHERE task_id = ? AND attempt_number = ? AND fencing_token = ?
        `).run(
          attemptStatus, row.status === 'claimed' ? 'claim-lease-expired' : 'runner-lease-expired',
          input.now, input.now, row.id, row.attempt_count, row.fencing_token,
        )
        this.database.prepare(`
          UPDATE automation_tasks
          SET status = ?, claimed_by = NULL, fencing_token = NULL, lease_until = NULL, updated_at = ?
          WHERE id = ?
        `).run(target, input.now, row.id)
        if (target === 'unknown') {
          if (snapshot !== undefined) {
            const runId = `run-${row.id}`
            const evaluation = buildTerminalEvaluation({
              automation: snapshot,
              runId,
              outcome: 'unknown',
              occurredAt: input.now,
              usage: {},
              startedAt: attempt.started_at,
              attemptNumber: attempt.attempt_number,
              deliveryStatus: 'not-required',
            })
            const evaluationJson = JSON.stringify(evaluation)
            if (Buffer.byteLength(evaluationJson, 'utf8') > 32_768) {
              throw new AutomationStoreError('invalid-state', 'recovered automation evaluation payload is oversized')
            }
            this.database.prepare(`
              INSERT INTO automation_runs(
                id, occurrence_id, automation_id, task_id, attempt_id, status, session_id, artifact_ref,
                output_preview, usage_json, delivery_status, delivery_ref, evidence_status, evidence_json,
                created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, 'unknown', ?, NULL, ?, '{}', NULL, NULL, 'suppressed', NULL, ?, ?)
            `).run(
              runId, row.occurrence_id, row.automation_id, row.id, attempt.id, attempt.session_id,
              'runner lease expired before terminal receipt', input.now, input.now,
            )
            this.database.prepare(`
              INSERT INTO automation_evaluation_outbox(
                id, run_id, observation_kind, status, payload_json, attempt_count,
                next_attempt_at, last_failure_at, last_error_code, created_at, updated_at
              ) VALUES (?, ?, 'terminal', 'pending', ?, 0, ?, NULL, NULL, ?, ?)
            `).run(`evaluation-terminal:${runId}`, runId, evaluationJson, input.now, input.now, input.now)
          }
          this.database.prepare(`
            UPDATE automation_occurrences SET status = 'unknown', reason = 'runner-lease-expired', updated_at = ? WHERE id = ?
          `).run(input.now, row.occurrence_id)
        }
        recovered.push(this.getTask(row.id)!)
      }
      return recovered
    })
  }

  private validateLease(now: number, leaseMs: number): void {
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > 86_400_000
      || !Number.isSafeInteger(now + leaseMs)) {
      throw new AutomationStoreError('invalid-definition', 'lease bounds are invalid')
    }
  }

  private requireDuty(ownerId: string, fencingToken: number, now: number): DutyRow {
    const row = this.database.prepare('SELECT * FROM duty_lease WHERE singleton = 1').get() as DutyRow | undefined
    if (row === undefined || row.owner_id !== ownerId || row.fencing_token !== fencingToken || row.lease_until <= now) {
      throw new AutomationStoreError('stale-fence', 'duty ownership is missing, expired, or fenced')
    }
    return row
  }

  private getTask(id: string): AutomationTask | undefined {
    const row = this.database.prepare('SELECT * FROM automation_tasks WHERE id = ?').get(id) as TaskRow | undefined
    return row === undefined ? undefined : task(row)
  }

  private requireMutableTask(
    input: { taskId: string; ownerId: string; fencingToken: number; now: number },
    statuses: AutomationTaskStatus[],
  ): TaskRow {
    this.requireDuty(input.ownerId, input.fencingToken, input.now)
    const row = this.database.prepare('SELECT * FROM automation_tasks WHERE id = ?').get(input.taskId) as TaskRow | undefined
    if (row === undefined) throw new AutomationStoreError('not-found', 'automation task was not found')
    if (row.claimed_by !== input.ownerId || row.fencing_token !== input.fencingToken || row.lease_until === null
      || row.lease_until <= input.now) {
      throw new AutomationStoreError('stale-fence', 'task ownership is missing, expired, or fenced')
    }
    if (!statuses.includes(row.status)) throw new AutomationStoreError('invalid-state', 'task state does not allow this transition')
    return row
  }

  private claimTaskInTransaction(
    row: TaskRow,
    input: { ownerId: string; fencingToken: number; now: number; leaseMs: number },
  ): AutomationTask | undefined {
    const automation = this.get(row.automation_id)
    if (automation === undefined || automation.status !== 'active') return undefined
    const active = this.database.prepare(`
      SELECT * FROM automation_tasks
      WHERE automation_id = ? AND id != ? AND status IN ('claimed', 'running')
      ORDER BY created_at, id
    `).all(row.automation_id, row.id) as unknown as TaskRow[]
    if (active.length > 0 && automation.definition.overlap === 'queue-one') return undefined
    if (active.length > 0 && automation.definition.overlap === 'skip') {
      this.database.prepare(`
        UPDATE automation_tasks SET status = 'cancelled', cancel_requested = 1, updated_at = ? WHERE id = ?
      `).run(input.now, row.id)
      this.database.prepare(`
        UPDATE automation_occurrences SET status = 'skipped', reason = 'overlap-skip', updated_at = ? WHERE id = ?
      `).run(input.now, row.occurrence_id)
      return this.getTask(row.id)
    }
    if (active.length > 0 && automation.definition.overlap === 'cancel-previous') {
      this.database.prepare(`
        UPDATE automation_tasks SET cancel_requested = 1, updated_at = ?
        WHERE automation_id = ? AND id != ? AND status IN ('claimed', 'running')
      `).run(input.now, row.automation_id, row.id)
    }
    const attemptNumber = row.attempt_count + 1
    const attemptId = `attempt-${row.id}-${attemptNumber}`
    const snapshot = encodeAutomationSnapshot(automation)
    const leaseUntil = input.now + input.leaseMs
    this.database.prepare(`
      UPDATE automation_tasks
      SET status = 'claimed', claimed_by = ?, fencing_token = ?, lease_until = ?,
          attempt_count = ?, updated_at = ? WHERE id = ? AND status = 'scheduled'
    `).run(input.ownerId, input.fencingToken, leaseUntil, attemptNumber, input.now, row.id)
    this.database.prepare(`
      INSERT INTO automation_attempts(
        id, task_id, attempt_number, owner_id, fencing_token, status, session_id,
        failure_code, started_at, finished_at, automation_snapshot_hash,
        automation_snapshot_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'claimed', NULL, NULL, NULL, NULL, ?, ?, ?, ?)
    `).run(
      attemptId, row.id, attemptNumber, input.ownerId, input.fencingToken,
      snapshot.hash, snapshot.json, input.now, input.now,
    )
    return this.getTask(row.id)
  }

  private insertOccurrence(input: {
    automationId: string
    triggerKind: OccurrenceTriggerKind
    triggerKey: string
    scheduledAt: number
    status: 'pending' | 'skipped'
    reason?: string
    dryRun: boolean
  }): { value: AutomationOccurrence; created: boolean } {
    const id = stableOccurrenceId(input.automationId, input.triggerKind, input.triggerKey)
    const existing = this.database.prepare('SELECT * FROM automation_occurrences WHERE id = ?').get(id) as OccurrenceRow | undefined
    if (existing !== undefined) return { value: occurrence(existing), created: false }
    const now = this.now()
    this.database.prepare(`
      INSERT INTO automation_occurrences(
        id, automation_id, trigger_kind, trigger_key, scheduled_at, status, reason, dry_run, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.automationId, input.triggerKind, input.triggerKey, input.scheduledAt,
      input.status, input.reason ?? null, input.dryRun ? 1 : 0, now, now,
    )
    if (input.status === 'pending') {
      this.database.prepare(`
        INSERT INTO automation_tasks(
          id, occurrence_id, automation_id, status, cancel_requested, claimed_by,
          fencing_token, lease_until, attempt_count, created_at, updated_at
        ) VALUES (?, ?, ?, 'scheduled', 0, NULL, NULL, NULL, 0, ?, ?)
      `).run(`task-${id}`, id, input.automationId, now, now)
    }
    return {
      value: occurrence(this.database.prepare('SELECT * FROM automation_occurrences WHERE id = ?').get(id) as unknown as OccurrenceRow),
      created: true,
    }
  }
}
