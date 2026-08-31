import { createHash, randomUUID } from 'node:crypto'
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
import { isHostAutomationDefinition, legacyAutomationExecutionDiagnostic } from './types.js'
import type {
  AutomationIncident,
  AutomationIncidentNotificationTarget,
  AutomationDeliveryEvidenceReceipt,
  AutomationQualityEvidenceReceipt,
  AutomationDefinition,
  AutomationCircuit,
  AutomationCircuitCanaryReceipt,
  AutomationCircuitProbeReceipt,
  AutomationCircuitExecutionDecision,
  AutomationDeliveryStatus,
  AutomationExecutionDiagnostic,
  AutomationExecutionMode,
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
  SystemOwnedAutomationHealthProjection,
  SystemOwnedAutomationIdentityProjection,
  SystemOwnedAutomationPauseReceipt,
  HostExecutionRequirement,
  HostExecutorAvailabilityDecision,
  HostExecutorAvailabilityStage,
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
  execution_mode: AutomationExecutionMode | 'unknown'
  definition_hash: string | null
  diagnostic_json: string
  delivery_status: string | null
  delivery_ref: string | null
  evidence_status: AutomationEvidenceStatus
  evidence_json: string | null
  created_at: number
  updated_at: number
}

interface CircuitRow {
  automation_id: string
  definition_hash: string
  state: 'closed' | 'half-open' | 'open' | 'probing'
  failure_class: 'budget' | 'configuration' | 'policy'
  failure_phase: string
  failure_code: string
  opened_at: number
  updated_at: number
  probe_token: string | null
  probe_lease_until: number | null
  probe_task_id: string | null
  version: number
}

interface CircuitOperationRow {
  input_hash: string
  result_json: string
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

interface IncidentRow {
  id: string
  automation_id: string
  definition_hash: string
  stage: AutomationIncident['stage']
  state: AutomationIncident['state']
  failure_class: Exclude<AutomationExecutionDiagnostic['failureClass'], 'none'>
  failure_phase: string
  failure_code: string
  side_effect_state: AutomationExecutionDiagnostic['sideEffectState']
  retryability: AutomationExecutionDiagnostic['retryability']
  notification_route_id: string
  lifecycle_generation: number
  presentation_revision: number
  alert_status: AutomationIncident['alertStatus']
  alert_ref: string | null
  run_id: string | null
  opened_at: number
  updated_at: number
  resolved_at: number | null
  version: number
}

interface ScopedRunRow extends RunRow {
  scope_snapshot_hash: string | null
  scope_snapshot_json: string | null
}

// Growth's owner is deliberately spelled out at the Store admission boundary
// instead of treating every paused system-owned definition as runnable.  Keep
// this coupled to GrowthAutomationStore.createExecutionTask(), which is the
// only writer of the task/occurrence/operation tuple below.
const growthAutomationOwner = 'assistant-growth-experiments'

/**
 * SQL-only admission proof for the one paused-definition exception.
 *
 * A queued task is eligible only when it is the exact task created for a
 * pending Growth shadow or canary operation.  The artifact must still bind to
 * the current definition revision, and the immutable occurrence key must name
 * the same operation.  This intentionally cannot match ordinary paused work.
 */
function pausedGrowthTaskAdmission(taskAlias: string, definitionAlias: string): string {
  return `
    EXISTS (
      SELECT 1
      FROM automation_growth_artifacts artifact
      JOIN automation_occurrences occurrence
        ON occurrence.id = ${taskAlias}.occurrence_id
       AND occurrence.automation_id = artifact.automation_id
      JOIN automation_growth_operations operation
        ON occurrence.trigger_key = CASE operation.operation_kind
          WHEN 'shadow' THEN 'growth-shadow:' || operation.operation_id
          WHEN 'canary' THEN 'growth-canary:' || operation.operation_id
          ELSE ''
        END
      WHERE artifact.automation_id = ${definitionAlias}.id
        AND artifact.definition_hash = ${definitionAlias}.definition_hash
        AND artifact.definition_version = ${definitionAlias}.version
        AND occurrence.trigger_kind = 'manual'
        AND operation.status = 'pending'
        AND (
          (
            artifact.shadow_task_id = ${taskAlias}.id
            AND artifact.state = 'paused'
            AND occurrence.dry_run = 1
            AND operation.operation_kind = 'shadow'
          )
          OR (
            artifact.canary_task_id = ${taskAlias}.id
            AND artifact.state = 'canary-pending'
            AND occurrence.dry_run = 0
            AND operation.operation_kind = 'canary'
          )
        )
    )
  `
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
  const host = typeof input['execution'] === 'object' && input['execution'] !== null
    && !Array.isArray(input['execution'])
    && (input['execution'] as Record<string, unknown>)['kind'] === 'host'
  const commonAllowed = [
    'agentPreset', 'budgetAmount', 'budgetId', 'maxRetries', 'misfire', 'name', 'overlap',
    'principal', 'retrySafety', 'schedule', 'timeoutMs', 'workspace',
  ]
  const allowed = new Set(host
    ? [...commonAllowed, 'execution']
    : [
        ...commonAllowed, 'allowedTools', 'approvalBindingId', 'deliveryBindingId', 'deliverySuppressExact',
        'maxOutputTokens', 'maxToolCalls', 'model', 'prompt', 'provider',
      ])
  if (Object.keys(input).some(key => !allowed.has(key))) {
    throw new AutomationStoreError('invalid-definition', 'automation definition contains an unknown field')
  }
  const workspace = text(input['workspace'], 'workspace', 4_096)
  const agentPreset = text(input['agentPreset'], 'agentPreset', 200)
  if (!isAbsolute(workspace)) {
    throw new AutomationStoreError('invalid-definition', 'automation workspace must be absolute')
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
  const control = {
    name: text(input['name'], 'name', 500),
    schedule: validateSchedule(input['schedule']),
    workspace,
    agentPreset,
    timeoutMs: safeInteger(input['timeoutMs'], 'timeoutMs', 1_000, 86_400_000),
    misfire: misfire(input['misfire']),
    overlap: overlap as OverlapPolicy,
    retrySafety: retrySafety as RetrySafety,
    maxRetries: safeInteger(input['maxRetries'], 'maxRetries', 0, 10),
    principal: text(input['principal'], 'principal', 500),
    ...(budgetId === undefined ? {} : { budgetId, budgetAmount: budgetAmount! }),
  }
  if (host) {
    const rawExecution = input['execution'] as Record<string, unknown>
    const executionAllowed = new Set([
      'activationNonce', 'catalogDigest', 'executorContractVersion', 'executorId', 'kind',
      'ownerRouteId', 'runbookId', 'runbookVersion', 'scopeDigest', 'targetScope',
    ])
    if (Object.keys(rawExecution).some(key => !executionAllowed.has(key))) {
      throw new AutomationStoreError('invalid-definition', 'Host execution spec contains an unknown field')
    }
    const rawTarget = rawExecution['targetScope']
    if (typeof rawTarget !== 'object' || rawTarget === null || Array.isArray(rawTarget)
      || Object.keys(rawTarget).some(key => key !== 'workspace' && key !== 'preset')) {
      throw new AutomationStoreError('invalid-definition', 'Host targetScope must be an exact object')
    }
    const target = rawTarget as Record<string, unknown>
    const targetWorkspace = text(target['workspace'], 'execution.targetScope.workspace', 4_096)
    const targetPreset = text(target['preset'], 'execution.targetScope.preset', 200)
    if (targetWorkspace !== workspace || targetPreset !== agentPreset) {
      throw new AutomationStoreError(
        'invalid-definition',
        'Host execution targetScope must exactly match automation workspace and agentPreset',
      )
    }
    const catalogDigest = text(rawExecution['catalogDigest'], 'execution.catalogDigest', 64).toLowerCase()
    if (!/^[a-f0-9]{64}$/u.test(catalogDigest)) {
      throw new AutomationStoreError('invalid-definition', 'Host execution catalogDigest must be a SHA-256 digest')
    }
    const execution = Object.freeze({
      kind: 'host' as const,
      executorId: text(rawExecution['executorId'], 'execution.executorId', 200),
      executorContractVersion: safeInteger(
        rawExecution['executorContractVersion'], 'execution.executorContractVersion', 1, 1_000_000,
      ),
      runbookId: text(rawExecution['runbookId'], 'execution.runbookId', 200),
      runbookVersion: safeInteger(rawExecution['runbookVersion'], 'execution.runbookVersion', 1, 1_000_000),
      catalogDigest,
      targetScope: Object.freeze({ workspace: targetWorkspace, preset: targetPreset }),
      // Never trust a caller-provided digest. Recompute the canonical tuple
      // that is actually stored in the immutable definition.
      scopeDigest: hash([targetWorkspace, targetPreset]),
      ownerRouteId: text(rawExecution['ownerRouteId'], 'execution.ownerRouteId', 500),
      activationNonce: text(rawExecution['activationNonce'], 'execution.activationNonce', 500),
    })
    return Object.freeze({ ...control, execution })
  }
  if (!Array.isArray(input['allowedTools']) || input['allowedTools'].length > maxAllowedTools) {
    throw new AutomationStoreError('invalid-definition', 'allowedTools must be a bounded array')
  }
  const allowedTools = input['allowedTools'].map(value => text(value, 'allowedTools item', 200))
  if (new Set(allowedTools).size !== allowedTools.length) {
    throw new AutomationStoreError('invalid-definition', 'allowedTools contains a duplicate')
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
    name: control.name,
    prompt: text(input['prompt'], 'prompt', maxPromptBytes),
    schedule: control.schedule,
    workspace: control.workspace,
    agentPreset: control.agentPreset,
    provider: text(input['provider'], 'provider', 200),
    model: text(input['model'], 'model', 500),
    allowedTools: Object.freeze(allowedTools),
    timeoutMs: control.timeoutMs,
    maxOutputTokens: safeInteger(input['maxOutputTokens'], 'maxOutputTokens', 1, 1_000_000),
    maxToolCalls: safeInteger(input['maxToolCalls'], 'maxToolCalls', 0, 10_000),
    misfire: control.misfire,
    overlap: control.overlap,
    retrySafety: control.retrySafety,
    maxRetries: control.maxRetries,
    principal: control.principal,
    ...(budgetId === undefined ? {} : { budgetId, budgetAmount: budgetAmount! }),
    ...(input['approvalBindingId'] === undefined
      ? {}
      : { approvalBindingId: text(input['approvalBindingId'], 'approvalBindingId', 500) }),
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

function incidentNotificationRoute(
  definition: AutomationDefinition,
): { id: string; target: AutomationIncidentNotificationTarget } | undefined {
  if (isHostAutomationDefinition(definition)) {
    return {
      id: definition.execution.ownerRouteId,
      target: Object.freeze({ kind: 'owner-route', authorityId: definition.execution.ownerRouteId }),
    }
  }
  // Approval delegation is the narrow owner-facing route for a background
  // Agent. deliveryBindingId is retained only for legacy definitions that
  // predate the separate approval route.
  const bindingId = definition.approvalBindingId ?? definition.deliveryBindingId
  return bindingId === undefined
    ? undefined
    : {
        id: bindingId,
        target: Object.freeze({ kind: 'binding', bindingId, workspace: definition.workspace }),
      }
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

const failureClasses = new Set<AutomationExecutionDiagnostic['failureClass']>([
  'none', 'budget', 'cancelled', 'configuration', 'execution', 'infrastructure',
  'policy', 'provider', 'timeout', 'unknown',
])
const failurePhases = new Set<AutomationExecutionDiagnostic['failurePhase']>([
  'none', 'artifact-write', 'agent-creation', 'agent-disposal', 'agent-setup', 'budget-reservation', 'budget-settlement',
  'executor-availability', 'host-execution', 'model-execution', 'preflight', 'preset-resolution', 'prompt-submission', 'recovery',
  'session-flush', 'terminal-commit', 'unknown',
])
const promptStates = new Set<AutomationExecutionDiagnostic['promptSubmissionState']>([
  'not-applicable', 'not-submitted', 'submitted', 'unknown',
])
const sideEffectStates = new Set<AutomationExecutionDiagnostic['sideEffectState']>([
  'none', 'possible', 'unknown',
])
const retryabilities = new Set<AutomationExecutionDiagnostic['retryability']>([
  'safe', 'unsafe', 'after-intervention', 'unknown',
])
const budgetSettlementStates = new Set<AutomationExecutionDiagnostic['budgetSettlementState']>([
  'not-required', 'not-reserved', 'reserved', 'released', 'finalized', 'unknown',
])

function executionDiagnostic(
  value: unknown,
  errorCode: 'invalid-definition' | 'invalid-state',
): AutomationExecutionDiagnostic {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AutomationStoreError(errorCode, 'automation execution diagnostic must be an object')
  }
  const input = value as Record<string, unknown>
  const expected = new Set([
    'schemaVersion', 'failureClass', 'failurePhase', 'failureCode', 'promptSubmissionState',
    'sideEffectState', 'retryability', 'budgetSettlementState',
  ])
  if (Object.keys(input).some(key => !expected.has(key))
    || input['schemaVersion'] !== 1
    || !failureClasses.has(input['failureClass'] as AutomationExecutionDiagnostic['failureClass'])
    || !failurePhases.has(input['failurePhase'] as AutomationExecutionDiagnostic['failurePhase'])
    || typeof input['failureCode'] !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(input['failureCode'])
    || !promptStates.has(input['promptSubmissionState'] as AutomationExecutionDiagnostic['promptSubmissionState'])
    || !sideEffectStates.has(input['sideEffectState'] as AutomationExecutionDiagnostic['sideEffectState'])
    || !retryabilities.has(input['retryability'] as AutomationExecutionDiagnostic['retryability'])
    || !budgetSettlementStates.has(input['budgetSettlementState'] as AutomationExecutionDiagnostic['budgetSettlementState'])) {
    throw new AutomationStoreError(errorCode, 'automation execution diagnostic is invalid')
  }
  return Object.freeze({
    schemaVersion: 1,
    failureClass: input['failureClass'] as AutomationExecutionDiagnostic['failureClass'],
    failurePhase: input['failurePhase'] as AutomationExecutionDiagnostic['failurePhase'],
    failureCode: input['failureCode'],
    promptSubmissionState: input['promptSubmissionState'] as AutomationExecutionDiagnostic['promptSubmissionState'],
    sideEffectState: input['sideEffectState'] as AutomationExecutionDiagnostic['sideEffectState'],
    retryability: input['retryability'] as AutomationExecutionDiagnostic['retryability'],
    budgetSettlementState: input['budgetSettlementState'] as AutomationExecutionDiagnostic['budgetSettlementState'],
  })
}

function assertDiagnosticOutcome(
  outcome: AutomationRunStatus,
  value: AutomationExecutionDiagnostic,
  definition: AutomationDefinition,
): void {
  const noneTuple = value.failureClass === 'none'
    && value.failurePhase === 'none'
    && value.failureCode === 'none'
  const hasPartialNoneTuple = value.failureClass === 'none'
    || value.failurePhase === 'none'
    || value.failureCode === 'none'
  const host = isHostAutomationDefinition(definition)
  const hasBudget = definition.budgetId !== undefined
  const effectfulSettlement = value.budgetSettlementState === 'reserved'
    || value.budgetSettlementState === 'finalized'
    || value.budgetSettlementState === 'unknown'
  const postPromptPhase = value.failurePhase === 'prompt-submission'
    || value.failurePhase === 'model-execution'
    || value.failurePhase === 'session-flush'
    || value.failurePhase === 'agent-disposal'
  if ((!noneTuple && hasPartialNoneTuple)
    || (outcome === 'succeeded' && !noneTuple)
    || (outcome !== 'succeeded' && noneTuple)
    || (value.retryability === 'safe' && value.sideEffectState !== 'none')
    || (noneTuple && (value.retryability === 'after-intervention' || value.retryability === 'unknown'))
    || (host && value.promptSubmissionState !== 'not-applicable')
    || (!host && value.promptSubmissionState === 'not-applicable')
    || (host && (value.failurePhase === 'agent-creation' || value.failurePhase === 'agent-setup'
      || value.failurePhase === 'prompt-submission' || value.failurePhase === 'model-execution'
      || value.failurePhase === 'session-flush' || value.failurePhase === 'agent-disposal'))
    || (!host && (value.failurePhase === 'executor-availability' || value.failurePhase === 'host-execution'))
    || (!host && value.promptSubmissionState === 'submitted' && value.sideEffectState === 'none')
    || (!host && value.promptSubmissionState === 'submitted' && value.retryability !== 'unsafe')
    || (!host && postPromptPhase && value.promptSubmissionState === 'not-submitted')
    || (!hasBudget && value.budgetSettlementState !== 'not-required')
    || (hasBudget && value.budgetSettlementState === 'not-required')
    || (effectfulSettlement && value.sideEffectState === 'none')
    || (effectfulSettlement && value.retryability !== 'unsafe')) {
    throw new AutomationStoreError(
      'invalid-definition',
      'fresh execution diagnostic contradicts the terminal outcome',
    )
  }
}

function isLegacyExecutionDiagnostic(value: AutomationExecutionDiagnostic): boolean {
  return value.failureClass === legacyAutomationExecutionDiagnostic.failureClass
    && value.failurePhase === legacyAutomationExecutionDiagnostic.failurePhase
    && value.failureCode === legacyAutomationExecutionDiagnostic.failureCode
    && value.promptSubmissionState === legacyAutomationExecutionDiagnostic.promptSubmissionState
    && value.sideEffectState === legacyAutomationExecutionDiagnostic.sideEffectState
    && value.retryability === legacyAutomationExecutionDiagnostic.retryability
    && value.budgetSettlementState === legacyAutomationExecutionDiagnostic.budgetSettlementState
}

function parseExecutionDiagnostic(row: RunRow): AutomationExecutionDiagnostic {
  if (Buffer.byteLength(row.diagnostic_json, 'utf8') > 4_096) {
    throw new AutomationStoreError('invalid-state', 'automation execution diagnostic exceeds 4096 bytes')
  }
  try {
    return executionDiagnostic(JSON.parse(row.diagnostic_json), 'invalid-state')
  } catch (error) {
    if (error instanceof AutomationStoreError) throw error
    throw new AutomationStoreError('invalid-state', 'automation execution diagnostic contains invalid JSON')
  }
}

function incident(row: IncidentRow): AutomationIncident {
  if (!/^[a-f0-9]{64}$/u.test(row.definition_hash)
    || (row.stage !== 'materialize' && row.stage !== 'claim' && row.stage !== 'terminal')
    || (row.state !== 'open' && row.state !== 'recovering' && row.state !== 'resolved')
    || !failureClasses.has(row.failure_class)
    || !failurePhases.has(row.failure_phase as AutomationExecutionDiagnostic['failurePhase'])
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(row.failure_code)
    || !sideEffectStates.has(row.side_effect_state)
    || !retryabilities.has(row.retryability)
    || (row.alert_status !== 'pending' && row.alert_status !== 'enqueued' && row.alert_status !== 'suppressed')
    || !Number.isSafeInteger(row.lifecycle_generation) || row.lifecycle_generation < 1
    || !Number.isSafeInteger(row.presentation_revision) || row.presentation_revision < 1
    || !Number.isSafeInteger(row.opened_at) || !Number.isSafeInteger(row.updated_at)
    || !Number.isSafeInteger(row.version) || row.version < 1
    || (row.state === 'resolved') !== (row.resolved_at !== null)
    || (row.alert_status === 'enqueued' && row.alert_ref === null)) {
    throw new AutomationStoreError('invalid-state', 'automation incident row is invalid')
  }
  return Object.freeze({
    id: row.id,
    automationId: row.automation_id,
    definitionHash: row.definition_hash,
    stage: row.stage,
    state: row.state,
    failureClass: row.failure_class,
    failurePhase: row.failure_phase as AutomationExecutionDiagnostic['failurePhase'],
    failureCode: row.failure_code,
    sideEffectState: row.side_effect_state,
    retryability: row.retryability,
    notificationRouteId: row.notification_route_id,
    lifecycleGeneration: row.lifecycle_generation,
    presentationRevision: row.presentation_revision,
    alertStatus: row.alert_status,
    ...(row.alert_ref === null ? {} : { alertRef: row.alert_ref }),
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
    version: row.version,
  })
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
  let value: unknown
  try {
    value = JSON.parse(row.evidence_json)
  } catch {
    throw new AutomationStoreError('invalid-state', 'automation evidence contains invalid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AutomationStoreError('invalid-state', 'automation evidence must be an object')
  }
  const input = value as Record<string, unknown>
  const allowed = new Set([
    'situation', 'outcome', 'detail', 'idempotencyKey', 'occurredAt', 'workspace',
    'agentPreset', 'automationId', 'runId', 'sessionId', 'ruleId', 'guidanceVersion',
  ])
  const stringWithin = (field: string, maximum: number) => typeof input[field] === 'string'
    && (input[field] as string).normalize('NFC').trim() !== ''
    && Buffer.byteLength(input[field] as string, 'utf8') <= maximum
  if (Object.keys(input).some(key => !allowed.has(key))
    || !stringWithin('situation', 200)
    || (input['outcome'] !== 'succeeded' && input['outcome'] !== 'failed')
    || !stringWithin('detail', 2_000)
    || !stringWithin('idempotencyKey', 500)
    || !Number.isSafeInteger(input['occurredAt'])
    || !stringWithin('workspace', 4_096) || !isAbsolute(input['workspace'] as string)
    || !stringWithin('agentPreset', 200)
    || !stringWithin('automationId', 500)
    || !stringWithin('runId', 500)
    || (input['sessionId'] !== undefined && !stringWithin('sessionId', 500))
    || (input['ruleId'] !== undefined && !stringWithin('ruleId', 200))
    || (input['guidanceVersion'] !== undefined
      && (!Number.isSafeInteger(input['guidanceVersion'])
        || (input['guidanceVersion'] as number) < 1
        || (input['guidanceVersion'] as number) > 1_000_000_000))
    || ((input['ruleId'] === undefined) !== (input['guidanceVersion'] === undefined))) {
    throw new AutomationStoreError('invalid-state', 'automation evidence payload is invalid')
  }
  return Object.freeze(value as AutomationOutcomeEvidence)
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
    executionMode: row.execution_mode,
    ...(row.definition_hash === null ? {} : { definitionHash: row.definition_hash }),
    diagnostic: parseExecutionDiagnostic(row),
    ...(status === undefined ? {} : { deliveryStatus: status }),
    ...(row.delivery_ref === null ? {} : { deliveryRef: row.delivery_ref }),
    evidenceStatus: evidenceStatus(row.evidence_status),
    ...(evidence === undefined ? {} : { evidence }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

function circuit(row: CircuitRow): AutomationCircuit {
  const durableProbe = row.state === 'half-open' || row.state === 'probing'
  const probeTupleValid = durableProbe
    ? typeof row.probe_token === 'string'
      && /^probe-[a-f0-9-]{36}$/u.test(row.probe_token)
      && Number.isSafeInteger(row.probe_lease_until)
      && (row.state === 'probing'
        ? typeof row.probe_task_id === 'string' && row.probe_task_id !== ''
        : row.probe_task_id === null)
    : row.probe_token === null && row.probe_lease_until === null && row.probe_task_id === null
  if (!Number.isSafeInteger(row.opened_at) || !Number.isSafeInteger(row.updated_at)
    || !Number.isSafeInteger(row.version) || row.version < 1
    || !/^[a-f0-9]{64}$/u.test(row.definition_hash)
    || !['closed', 'half-open', 'open', 'probing'].includes(row.state)
    || !['budget', 'configuration', 'policy'].includes(row.failure_class)
    || !probeTupleValid
    || !failurePhases.has(row.failure_phase as AutomationExecutionDiagnostic['failurePhase'])
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(row.failure_code)) {
    throw new AutomationStoreError('invalid-state', 'automation circuit row is invalid')
  }
  return Object.freeze({
    automationId: row.automation_id,
    definitionHash: row.definition_hash,
    state: row.state,
    failureClass: row.failure_class,
    failurePhase: row.failure_phase as AutomationExecutionDiagnostic['failurePhase'],
    failureCode: row.failure_code,
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
    ...(row.probe_token === null ? {} : { probeToken: row.probe_token }),
    ...(row.probe_lease_until === null ? {} : { probeLeaseUntil: row.probe_lease_until }),
    ...(row.probe_task_id === null ? {} : { probeTaskId: row.probe_task_id }),
    version: row.version,
  })
}

function parseCircuitResult(json: string): AutomationCircuit {
  if (Buffer.byteLength(json, 'utf8') > 4_096) {
    throw new AutomationStoreError('invalid-state', 'circuit operation result exceeds its bound')
  }
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    throw new AutomationStoreError('invalid-state', 'circuit operation result is invalid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AutomationStoreError('invalid-state', 'circuit operation result is invalid')
  }
  const input = value as Record<string, unknown>
  return circuit({
    automation_id: input['automationId'] as string,
    definition_hash: input['definitionHash'] as string,
    state: input['state'] as CircuitRow['state'],
    failure_class: input['failureClass'] as CircuitRow['failure_class'],
    failure_phase: input['failurePhase'] as string,
    failure_code: input['failureCode'] as string,
    opened_at: input['openedAt'] as number,
    updated_at: input['updatedAt'] as number,
    probe_token: (input['probeToken'] ?? null) as string | null,
    probe_lease_until: (input['probeLeaseUntil'] ?? null) as number | null,
    probe_task_id: (input['probeTaskId'] ?? null) as string | null,
    version: input['version'] as number,
  })
}

function parseCircuitCanaryResult(json: string): Readonly<{
  circuit: AutomationCircuit
  occurrenceId: string
  taskId: string
  executionMode: 'production'
}> {
  if (Buffer.byteLength(json, 'utf8') > 8_192) {
    throw new AutomationStoreError('invalid-state', 'circuit canary operation result exceeds its bound')
  }
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    throw new AutomationStoreError('invalid-state', 'circuit canary operation result is invalid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'circuit,executionMode,occurrenceId,taskId') {
    throw new AutomationStoreError('invalid-state', 'circuit canary operation result is invalid')
  }
  const input = value as Record<string, unknown>
  const occurrenceId = input['occurrenceId']
  const taskId = input['taskId']
  if (typeof occurrenceId !== 'string' || !/^occ-[a-f0-9]{64}$/u.test(occurrenceId)
    || typeof taskId !== 'string' || taskId !== `task-${occurrenceId}`
    || input['executionMode'] !== 'production') {
    throw new AutomationStoreError('invalid-state', 'circuit canary operation result tuple is invalid')
  }
  return Object.freeze({
    circuit: parseCircuitResult(JSON.stringify(input['circuit'])),
    occurrenceId,
    taskId,
    executionMode: 'production' as const,
  })
}

function parseSystemPauseResult(json: string): Omit<SystemOwnedAutomationPauseReceipt, 'operationId' | 'replayed'> {
  if (Buffer.byteLength(json, 'utf8') > 4_096) {
    throw new AutomationStoreError('invalid-state', 'system pause operation result exceeds its bound')
  }
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    throw new AutomationStoreError('invalid-state', 'system pause operation result is invalid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).sort().join(',')
      !== 'automationId,automationStatus,definitionHash,definitionVersion,expectedVersion,owner') {
    throw new AutomationStoreError('invalid-state', 'system pause operation result is invalid')
  }
  const input = value as Record<string, unknown>
  const owner = input['owner']
  const automationId = input['automationId']
  const expectedVersion = input['expectedVersion']
  const definitionVersion = input['definitionVersion']
  if (typeof owner !== 'string' || owner.normalize('NFC').trim() !== owner
    || owner === '' || Buffer.byteLength(owner, 'utf8') > 200
    || typeof automationId !== 'string' || automationId.normalize('NFC').trim() !== automationId
    || automationId === '' || Buffer.byteLength(automationId, 'utf8') > 500
    || typeof input['definitionHash'] !== 'string' || !/^[a-f0-9]{64}$/u.test(input['definitionHash'])
    || !Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 1
    || !Number.isSafeInteger(definitionVersion) || definitionVersion !== (expectedVersion as number) + 1
    || input['automationStatus'] !== 'paused') {
    throw new AutomationStoreError('invalid-state', 'system pause operation result tuple is invalid')
  }
  return Object.freeze({
    owner,
    automationId,
    definitionHash: input['definitionHash'],
    expectedVersion: expectedVersion as number,
    definitionVersion: definitionVersion as number,
    automationStatus: 'paused' as const,
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

function automationSituation(automationId: string): string {
  const raw = `automation:${automationId}`
  return Buffer.byteLength(raw, 'utf8') <= 200
    ? raw
    : `automation:${createHash('sha256').update(automationId).digest('hex')}`
}

function buildOutcomeEvidence(input: {
  automation: AutomationRecord
  runId: string
  outcome: AutomationRunStatus
  executionMode: AutomationExecutionMode
  occurredAt: number
  attribution: AutomationEvidenceAttribution
}): { status: AutomationEvidenceStatus; json: string | null } {
  // Preview is an operator inspection mode, not a production exposure. Feeding
  // it into Evolution would let a side-effect-free rehearsal change live
  // guidance even though the production behaviour was never exercised.
  if (input.executionMode !== 'production'
    || input.outcome === 'cancelled'
    || input.outcome === 'unknown') {
    return { status: 'suppressed', json: null }
  }
  const evidence: AutomationOutcomeEvidence = {
    situation: automationSituation(input.automation.id),
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
  executionMode: AutomationExecutionMode | 'unknown'
  occurredAt: number
  usage: Readonly<Record<string, unknown>>
  startedAt: number | null
  attemptNumber: number
  deliveryStatus: AutomationEvaluationOutcome['deliveryStatus']
}): AutomationEvaluationOutcome | undefined {
  // Preview is validation evidence for its owning Host workflow, never a
  // production outcome. Keeping it out of this durable trusted outbox avoids
  // silently turning a dry-run into learning truth when Evaluation is added
  // later or after a restart.
  if (input.executionMode !== 'production') return undefined
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
  const situation = automationSituation(input.automation.id)
  const fixedHostObjective = input.executionMode === 'production'
    && isHostAutomationDefinition(input.automation.definition)
    && (input.outcome === 'succeeded' || input.outcome === 'failed' || input.outcome === 'timed_out')
  const objectiveStatus: AutomationEvaluationOutcome['objectiveStatus'] = !fixedHostObjective
    ? 'unknown'
    : input.outcome === 'succeeded' ? 'achieved' : 'not-achieved'
  return Object.freeze({
    executionMode: 'production',
    scope: Object.freeze({
      workspace: input.automation.definition.workspace,
      preset: input.automation.definition.agentPreset,
    }),
    situation,
    executionStatus: evaluationExecutionStatus(input.outcome),
    objectiveStatus,
    deliveryStatus: input.deliveryStatus,
    source: Object.freeze({ kind: 'automation', id: 'assistant-automations' }),
    trust: 'trusted',
    evidence: Object.freeze([{ kind: 'automation-run', ref: input.runId }]),
    metrics,
    occurredAt: input.occurredAt,
    idempotencyKey: `assistant-automations:terminal:${input.runId}:v1`,
    evaluator: Object.freeze({
      id: 'assistant-automations',
      version: fixedHostObjective ? 'host-runbook-v1' : 'terminal-v1',
    }),
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

  getDefinitionHash(automationId: string): string | undefined {
    const row = this.database.prepare('SELECT definition_hash FROM automation_definitions WHERE id = ?')
      .get(automationId) as Pick<DefinitionRow, 'definition_hash'> | undefined
    return row?.definition_hash
  }

  getCircuit(automationId: string, definitionHash: string): AutomationCircuit | undefined {
    if (!/^[a-f0-9]{64}$/u.test(definitionHash)) {
      throw new AutomationStoreError('invalid-definition', 'circuit definition hash is invalid')
    }
    const row = this.database.prepare(`
      SELECT * FROM automation_circuits WHERE automation_id = ? AND definition_hash = ?
    `).get(automationId, definitionHash) as CircuitRow | undefined
    return row === undefined ? undefined : circuit(row)
  }

  /** Read-only compatibility view; execution admission uses the transactional seam below. */
  getOpenCircuitForTask(taskId: string): AutomationCircuit | undefined {
    const taskRow = this.database.prepare('SELECT * FROM automation_tasks WHERE id = ?').get(taskId) as TaskRow | undefined
    if (taskRow === undefined || taskRow.attempt_count < 1) return undefined
    const occurrenceRow = this.database.prepare('SELECT dry_run FROM automation_occurrences WHERE id = ?')
      .get(taskRow.occurrence_id) as Pick<OccurrenceRow, 'dry_run'> | undefined
    // Preview is an observation-only execution lane. It may exercise the
    // runner, but it can neither observe nor mutate the production circuit.
    if (occurrenceRow?.dry_run !== 0) return undefined
    const attempt = this.database.prepare(`
      SELECT * FROM automation_attempts WHERE task_id = ? AND attempt_number = ?
    `).get(taskId, taskRow.attempt_count) as AttemptRow | undefined
    if (attempt === undefined) return undefined
    const snapshot = automationSnapshot(attempt, taskRow.automation_id)
    if (snapshot === undefined) return undefined
    const definitionHash = hash(snapshot.definition)
    const value = this.getCircuit(taskRow.automation_id, definitionHash)
    return value !== undefined && value.state !== 'closed' ? value : undefined
  }

  /**
   * Host-only exact CAS. Arming never closes the circuit: it creates one
   * durable, expiring half-open capability that a task must atomically acquire.
   */
  armCircuitProbe(input: {
    owner: string
    operationId: string
    automationId: string
    definitionHash: string
    expectedVersion: number
    now: number
    leaseMs: number
  }): AutomationCircuitProbeReceipt {
    const owner = text(input.owner, 'owner', 500)
    const operationId = text(input.operationId, 'operationId', 500)
    const automationId = text(input.automationId, 'automationId', 500)
    this.validateLease(input.now, input.leaseMs)
    if (!/^[a-f0-9]{64}$/u.test(input.definitionHash)
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new AutomationStoreError('invalid-definition', 'circuit probe tuple is invalid')
    }
    const inputHash = hash({
      owner,
      automationId,
      definitionHash: input.definitionHash,
      expectedVersion: input.expectedVersion,
      leaseMs: input.leaseMs,
    })
    return this.transaction(() => {
      const prior = this.database.prepare(`
        SELECT input_hash, result_json FROM automation_circuit_operations WHERE operation_id = ?
      `).get(operationId) as CircuitOperationRow | undefined
      if (prior !== undefined) {
        if (prior.input_hash !== inputHash) {
          throw new AutomationStoreError(
            'idempotency-conflict',
            'circuit probe operation id was reused with different input',
          )
        }
        return Object.freeze({
          operationId,
          circuit: parseCircuitResult(prior.result_json),
          replayed: true,
        })
      }
      const definition = this.database.prepare(`
        SELECT system_owner, definition_hash FROM automation_definitions WHERE id = ?
      `).get(automationId) as Pick<DefinitionRow, 'system_owner' | 'definition_hash'> | undefined
      if (definition === undefined || definition.system_owner !== owner
        || definition.definition_hash !== input.definitionHash) {
        throw new AutomationStoreError('not-found', 'exact system-owned automation definition was not found')
      }
      const probeToken = `probe-${randomUUID()}`
      const changed = this.database.prepare(`
        UPDATE automation_circuits
        SET state = 'half-open', probe_token = ?, probe_lease_until = ?, probe_task_id = NULL,
            updated_at = ?, version = version + 1
        WHERE automation_id = ? AND definition_hash = ? AND state = 'open' AND version = ?
      `).run(
        probeToken, input.now + input.leaseMs, input.now,
        automationId, input.definitionHash, input.expectedVersion,
      )
      const row = this.database.prepare(`
        SELECT * FROM automation_circuits WHERE automation_id = ? AND definition_hash = ?
      `).get(automationId, input.definitionHash) as CircuitRow | undefined
      if (row === undefined) throw new AutomationStoreError('not-found', 'automation circuit was not found')
      const current = circuit(row)
      if (changed.changes !== 1) {
        throw new AutomationStoreError('version-conflict', 'automation circuit changed before exact probe arm')
      }
      this.markIncidentRecoveringInTransaction(automationId, input.definitionHash, input.now)
      this.database.prepare(`
        INSERT INTO automation_circuit_operations(
          operation_id, system_owner, automation_id, definition_hash,
          expected_circuit_version, lease_ms, input_hash, result_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        operationId, owner, automationId, input.definitionHash,
        input.expectedVersion, input.leaseMs, inputHash, JSON.stringify(current), input.now,
      )
      return Object.freeze({ operationId, circuit: current, replayed: false })
    })
  }

  /**
   * Atomically arms one exact production probe and schedules the only task that
   * may consume it. The operation ledger, circuit transition, occurrence and
   * task commit or roll back together.
   */
  probeCircuitAndScheduleCanary(input: {
    owner: string
    operationId: string
    automationId: string
    definitionHash: string
    expectedVersion: number
    now: number
    leaseMs: number
  }): AutomationCircuitCanaryReceipt {
    const owner = text(input.owner, 'owner', 500)
    const operationId = text(input.operationId, 'operationId', 500)
    const automationId = text(input.automationId, 'automationId', 500)
    this.validateLease(input.now, input.leaseMs)
    if (!/^[a-f0-9]{64}$/u.test(input.definitionHash)
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new AutomationStoreError('invalid-definition', 'circuit canary tuple is invalid')
    }
    const inputHash = hash({
      lane: 'probe-and-schedule-canary-v1',
      owner,
      automationId,
      definitionHash: input.definitionHash,
      expectedVersion: input.expectedVersion,
      leaseMs: input.leaseMs,
    })
    return this.transaction(() => {
      const prior = this.database.prepare(`
        SELECT input_hash, result_json FROM automation_circuit_operations WHERE operation_id = ?
      `).get(operationId) as CircuitOperationRow | undefined
      if (prior !== undefined) {
        if (prior.input_hash !== inputHash) {
          throw new AutomationStoreError(
            'idempotency-conflict',
            'circuit canary operation id was reused with different input',
          )
        }
        const replay = parseCircuitCanaryResult(prior.result_json)
        return Object.freeze({ operationId, ...replay, replayed: true })
      }
      const definition = this.database.prepare(`
        SELECT system_owner, definition_hash, status
        FROM automation_definitions WHERE id = ?
      `).get(automationId) as Pick<DefinitionRow, 'system_owner' | 'definition_hash' | 'status'> | undefined
      if (definition === undefined || definition.system_owner !== owner
        || definition.definition_hash !== input.definitionHash) {
        throw new AutomationStoreError('not-found', 'exact system-owned automation definition was not found')
      }
      if (definition.status !== 'active') {
        throw new AutomationStoreError('invalid-state', 'circuit canary automation is not active')
      }
      const probeToken = `probe-${randomUUID()}`
      const changed = this.database.prepare(`
        UPDATE automation_circuits
        SET state = 'half-open', probe_token = ?, probe_lease_until = ?, probe_task_id = NULL,
            updated_at = ?, version = version + 1
        WHERE automation_id = ? AND definition_hash = ? AND state = 'open' AND version = ?
      `).run(
        probeToken, input.now + input.leaseMs, input.now,
        automationId, input.definitionHash, input.expectedVersion,
      )
      const row = this.database.prepare(`
        SELECT * FROM automation_circuits WHERE automation_id = ? AND definition_hash = ?
      `).get(automationId, input.definitionHash) as CircuitRow | undefined
      if (row === undefined) throw new AutomationStoreError('not-found', 'automation circuit was not found')
      const current = circuit(row)
      if (changed.changes !== 1) {
        throw new AutomationStoreError('version-conflict', 'automation circuit changed before exact canary arm')
      }
      this.markIncidentRecoveringInTransaction(automationId, input.definitionHash, input.now)
      const inserted = this.insertOccurrence({
        automationId,
        triggerKind: 'manual',
        triggerKey: `circuit-canary:${operationId}`,
        scheduledAt: input.now,
        status: 'pending',
        dryRun: false,
      })
      if (!inserted.created || inserted.value.dryRun || inserted.value.status !== 'pending') {
        throw new AutomationStoreError(
          'idempotency-conflict',
          'circuit canary occurrence already exists outside the atomic operation',
        )
      }
      const occurrenceId = inserted.value.id
      const taskId = `task-${occurrenceId}`
      const taskRow = this.database.prepare('SELECT * FROM automation_tasks WHERE id = ?')
        .get(taskId) as TaskRow | undefined
      if (taskRow === undefined || taskRow.occurrence_id !== occurrenceId
        || taskRow.automation_id !== automationId || taskRow.status !== 'scheduled'
        || taskRow.attempt_count !== 0) {
        throw new AutomationStoreError('invalid-state', 'atomic circuit canary task was not created')
      }
      const stored = Object.freeze({
        circuit: current,
        occurrenceId,
        taskId,
        executionMode: 'production' as const,
      })
      this.database.prepare(`
        INSERT INTO automation_circuit_operations(
          operation_id, system_owner, automation_id, definition_hash,
          expected_circuit_version, lease_ms, input_hash, result_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        operationId, owner, automationId, input.definitionHash,
        input.expectedVersion, input.leaseMs, inputHash, JSON.stringify(stored), input.now,
      )
      return Object.freeze({ operationId, ...stored, replayed: false })
    })
  }

  /**
   * Atomically admits an ordinary execution or consumes the one half-open
   * capability. A probing row is idempotent only for its exact task id.
   */
  acquireCircuitExecutionForTask(input: {
    taskId: string
    now: number
    leaseMs: number
  }): AutomationCircuitExecutionDecision {
    const taskId = text(input.taskId, 'taskId', 1_000)
    this.validateLease(input.now, input.leaseMs)
    return this.transaction(() => {
      const taskRow = this.database.prepare('SELECT * FROM automation_tasks WHERE id = ?').get(taskId) as TaskRow | undefined
      if (taskRow === undefined) throw new AutomationStoreError('not-found', 'automation task was not found')
      if (taskRow.status !== 'running' || taskRow.attempt_count < 1) {
        throw new AutomationStoreError('invalid-state', 'only a running task may acquire circuit execution')
      }
      const occurrenceRow = this.database.prepare('SELECT dry_run FROM automation_occurrences WHERE id = ?')
        .get(taskRow.occurrence_id) as Pick<OccurrenceRow, 'dry_run'> | undefined
      if (occurrenceRow === undefined || (occurrenceRow.dry_run !== 0 && occurrenceRow.dry_run !== 1)) {
        throw new AutomationStoreError('invalid-state', 'running task has no valid occurrence execution mode')
      }
      // A preview never consumes a production probe and is never blocked by a
      // production circuit. Its terminal receipt is still persisted normally.
      if (occurrenceRow.dry_run === 1) return { kind: 'normal' }
      const attempt = this.database.prepare(`
        SELECT * FROM automation_attempts WHERE task_id = ? AND attempt_number = ?
      `).get(taskId, taskRow.attempt_count) as AttemptRow | undefined
      if (attempt === undefined) throw new AutomationStoreError('invalid-state', 'running task has no immutable attempt')
      const snapshot = automationSnapshot(attempt, taskRow.automation_id)
      if (snapshot === undefined) throw new AutomationStoreError('invalid-state', 'running task has no immutable snapshot')
      const definitionHash = hash(snapshot.definition)
      const selected = this.database.prepare(`
        SELECT * FROM automation_circuits WHERE automation_id = ? AND definition_hash = ?
      `).get(taskRow.automation_id, definitionHash) as CircuitRow | undefined
      if (selected === undefined || selected.state === 'closed') return { kind: 'normal' }

      if ((selected.state === 'half-open' || selected.state === 'probing')
        && selected.probe_lease_until !== null && selected.probe_lease_until <= input.now) {
        this.database.prepare(`
          UPDATE automation_circuits
          SET state = 'open', probe_token = NULL, probe_lease_until = NULL, probe_task_id = NULL,
              updated_at = ?, version = version + 1
          WHERE automation_id = ? AND definition_hash = ? AND version = ?
        `).run(input.now, taskRow.automation_id, definitionHash, selected.version)
        const expired = this.database.prepare(`
          SELECT * FROM automation_circuits WHERE automation_id = ? AND definition_hash = ?
        `).get(taskRow.automation_id, definitionHash) as unknown as CircuitRow
        return { kind: 'blocked', circuit: circuit(expired) }
      }
      if (selected.state === 'open') return { kind: 'blocked', circuit: circuit(selected) }
      if (selected.state === 'probing') {
        return selected.probe_task_id === taskId
          ? { kind: 'probe', circuit: circuit(selected) }
          : { kind: 'blocked', circuit: circuit(selected) }
      }

      // The atomic canary lane binds a half-open transition to one durable
      // task. Legacy armCircuitProbe rows have no taskId and retain their
      // existing first-claim-wins behaviour.
      const designated = this.database.prepare(`
        SELECT json_extract(result_json, '$.taskId') AS task_id
        FROM automation_circuit_operations
        WHERE automation_id = ? AND definition_hash = ?
          AND expected_circuit_version = ?
          AND json_extract(result_json, '$.taskId') IS NOT NULL
        ORDER BY created_at DESC, operation_id DESC LIMIT 1
      `).get(
        taskRow.automation_id, definitionHash, selected.version - 1,
      ) as { task_id: string } | undefined
      if (designated !== undefined && designated.task_id !== taskId) {
        return { kind: 'blocked', circuit: circuit(selected) }
      }

      const probeLeaseUntil = Math.min(selected.probe_lease_until!, input.now + input.leaseMs)
      const changed = this.database.prepare(`
        UPDATE automation_circuits
        SET state = 'probing', probe_task_id = ?, probe_lease_until = ?,
            updated_at = ?, version = version + 1
        WHERE automation_id = ? AND definition_hash = ?
          AND state = 'half-open' AND version = ? AND probe_token = ?
      `).run(
        taskId, probeLeaseUntil, input.now, taskRow.automation_id, definitionHash,
        selected.version, selected.probe_token,
      )
      const acquired = this.database.prepare(`
        SELECT * FROM automation_circuits WHERE automation_id = ? AND definition_hash = ?
      `).get(taskRow.automation_id, definitionHash) as unknown as CircuitRow
      if (changed.changes !== 1) return { kind: 'blocked', circuit: circuit(acquired) }
      return { kind: 'probe', circuit: circuit(acquired) }
    })
  }

  recoverExpiredCircuitProbes(input: { now: number }): number {
    if (!Number.isSafeInteger(input.now)) {
      throw new AutomationStoreError('invalid-definition', 'now must be a safe integer')
    }
    return this.transaction(() => {
      const expired = this.database.prepare(`
        SELECT automation_id, definition_hash FROM automation_circuits
        WHERE state IN ('half-open', 'probing') AND probe_lease_until <= ?
      `).all(input.now) as unknown as Array<Pick<CircuitRow, 'automation_id' | 'definition_hash'>>
      const changed = Number(this.database.prepare(`
        UPDATE automation_circuits
        SET state = 'open', probe_token = NULL, probe_lease_until = NULL, probe_task_id = NULL,
            updated_at = ?, version = version + 1
        WHERE state IN ('half-open', 'probing') AND probe_lease_until <= ?
      `).run(input.now, input.now).changes)
      for (const row of expired) {
        this.markRecoveringIncidentOpenInTransaction(row.automation_id, row.definition_hash, input.now)
      }
      return changed
    })
  }

  /** Content-free bounded inventory for one exact system owner. */
  listSystemOwned(input: {
    owner: string
    limit?: number
  }): readonly SystemOwnedAutomationIdentityProjection[] {
    const owner = text(input.owner, 'owner', 500)
    const limit = input.limit ?? 1_000
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new AutomationStoreError('invalid-definition', 'system-owned inventory limit must be between 1 and 1000')
    }
    return this.transaction(() => Object.freeze((this.database.prepare(`
      SELECT id, system_owner, definition_hash, status, version
      FROM automation_definitions
      WHERE system_owner = ?
      ORDER BY id
      LIMIT ?
    `).all(owner, limit) as Array<Pick<DefinitionRow,
      'id' | 'system_owner' | 'definition_hash' | 'status' | 'version'>>).map(row => Object.freeze({
      owner,
      automationId: row.id,
      automationStatus: row.status,
      definitionHash: row.definition_hash,
      definitionVersion: row.version,
    }))))
  }

  /**
   * Pauses one exact system-owned row without accepting or rewriting a
   * definition. The lifecycle CAS and durable receipt share one transaction.
   */
  pauseSystemOwned(input: {
    owner: string
    operationId: string
    automationId: string
    definitionHash: string
    expectedVersion: number
  }): SystemOwnedAutomationPauseReceipt {
    const owner = text(input.owner, 'owner', 200)
    const operationId = text(input.operationId, 'operationId', 500)
    const automationId = text(input.automationId, 'automationId', 500)
    if (!/^[a-f0-9]{64}$/u.test(input.definitionHash)
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new AutomationStoreError('invalid-definition', 'system pause tuple is invalid')
    }
    const inputHash = hash({
      lane: 'pause-system-owned-v1',
      owner,
      automationId,
      definitionHash: input.definitionHash,
      expectedVersion: input.expectedVersion,
    })
    return this.transaction(() => {
      const prior = this.database.prepare(`
        SELECT input_hash, result_json
        FROM automation_system_reconciles WHERE idempotency_key = ?
      `).get(operationId) as { input_hash: string; result_json: string } | undefined
      if (prior !== undefined) {
        if (prior.input_hash !== inputHash) {
          throw new AutomationStoreError(
            'idempotency-conflict',
            'system pause operation id was reused with different input',
          )
        }
        const replay = parseSystemPauseResult(prior.result_json)
        if (replay.owner !== owner || replay.automationId !== automationId
          || replay.definitionHash !== input.definitionHash
          || replay.expectedVersion !== input.expectedVersion) {
          throw new AutomationStoreError('invalid-state', 'system pause receipt does not match its operation')
        }
        return Object.freeze({ operationId, ...replay, replayed: true })
      }

      const current = this.database.prepare(`
        SELECT * FROM automation_definitions WHERE id = ?
      `).get(automationId) as DefinitionRow | undefined
      if (current === undefined || current.system_owner !== owner
        || current.definition_hash !== input.definitionHash) {
        throw new AutomationStoreError('not-found', 'exact system-owned automation definition was not found')
      }
      if (current.version !== input.expectedVersion) {
        throw new AutomationStoreError('version-conflict', 'system-owned automation version changed before pause')
      }
      if (current.status !== 'active') {
        throw new AutomationStoreError('invalid-state', 'only an active system-owned automation can be paused')
      }
      const now = this.now()
      const changed = this.database.prepare(`
        UPDATE automation_definitions
        SET status = 'paused', next_run_at = NULL, updated_at = ?, version = version + 1
        WHERE id = ? AND system_owner = ? AND definition_hash = ?
          AND version = ? AND status = 'active'
      `).run(now, automationId, owner, input.definitionHash, input.expectedVersion)
      if (changed.changes !== 1) {
        throw new AutomationStoreError('version-conflict', 'system-owned automation changed before pause commit')
      }
      const stored = Object.freeze({
        owner,
        automationId,
        definitionHash: input.definitionHash,
        expectedVersion: input.expectedVersion,
        definitionVersion: input.expectedVersion + 1,
        automationStatus: 'paused' as const,
      })
      this.database.prepare(`
        INSERT INTO automation_system_reconciles(
          idempotency_key, system_owner, automation_id, input_hash, result_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(operationId, owner, automationId, inputHash, JSON.stringify(stored), now)
      return Object.freeze({ operationId, ...stored, replayed: false })
    })
  }

  inspectSystemOwned(input: {
    owner: string
    automationId: string
  }): SystemOwnedAutomationHealthProjection {
    const owner = text(input.owner, 'owner', 500)
    const automationId = text(input.automationId, 'automationId', 500)
    return this.transaction(() => {
      const definitionRow = this.database.prepare('SELECT * FROM automation_definitions WHERE id = ?')
        .get(automationId) as DefinitionRow | undefined
      if (definitionRow === undefined || definitionRow.system_owner !== owner) {
        throw new AutomationStoreError('not-found', 'system-owned automation was not found for exact owner')
      }
      const automation = record(definitionRow)
      const projectRun = (
        executionMode: AutomationExecutionMode,
      ): SystemOwnedAutomationHealthProjection['latestTerminalRun'] => {
        const latestRow = this.database.prepare(`
          SELECT * FROM automation_runs WHERE automation_id = ? AND execution_mode = ?
          ORDER BY created_at DESC, id DESC LIMIT 1
        `).get(automationId, executionMode) as RunRow | undefined
        if (latestRow === undefined) return undefined
        const latest = run(latestRow)
        let snapshot: AutomationRecord | undefined
        try {
          snapshot = this.getRunExecutionSnapshot(latest.id)
        } catch {
          snapshot = undefined
        }
        const immutableContext = snapshot !== undefined
          && latest.definitionHash !== undefined
          && hash(snapshot.definition) === latest.definitionHash
          ? Object.freeze({
              state: 'verified' as const,
              definitionHash: latest.definitionHash,
              definitionVersion: snapshot.version,
              scope: Object.freeze({
                workspace: snapshot.definition.workspace,
                agentPreset: snapshot.definition.agentPreset,
              }),
            })
          : Object.freeze({ state: 'unknown' as const })
        return Object.freeze({
          runId: latest.id,
          status: latest.status,
          executionMode,
          diagnostic: latest.diagnostic,
          createdAt: latest.createdAt,
          immutableContext,
        })
      }
      const latestProductionRun = projectRun('production')
      const latestPreviewRun = projectRun('preview')
      const latestTerminalRuns = Object.freeze({
        ...(latestProductionRun === undefined ? {} : { production: latestProductionRun }),
        ...(latestPreviewRun === undefined ? {} : { preview: latestPreviewRun }),
      })
      const current = this.getCircuit(automationId, definitionRow.definition_hash)
      const currentCircuit = current === undefined
        ? undefined
        : Object.freeze({
            definitionHash: current.definitionHash,
            state: current.state,
            failureClass: current.failureClass,
            failurePhase: current.failurePhase,
            failureCode: current.failureCode,
            openedAt: current.openedAt,
            updatedAt: current.updatedAt,
            ...(current.probeLeaseUntil === undefined ? {} : { probeLeaseUntil: current.probeLeaseUntil }),
            version: current.version,
          })
      const activeIncident = this.getCurrentIncident(automationId, definitionRow.definition_hash)
      const currentIncident = activeIncident === undefined
        ? undefined
        : Object.freeze({
            definitionHash: activeIncident.definitionHash,
            stage: activeIncident.stage,
            failureClass: activeIncident.failureClass,
            failurePhase: activeIncident.failurePhase,
            failureCode: activeIncident.failureCode,
            state: activeIncident.state,
            lifecycleGeneration: activeIncident.lifecycleGeneration,
            presentationRevision: activeIncident.presentationRevision,
            alertStatus: activeIncident.alertStatus,
            openedAt: activeIncident.openedAt,
            updatedAt: activeIncident.updatedAt,
            version: activeIncident.version,
          })
      return Object.freeze({
        owner,
        automationId,
        automationStatus: automation.status,
        definitionHash: definitionRow.definition_hash,
        definitionVersion: automation.version,
        ...(latestProductionRun === undefined ? {} : { latestTerminalRun: latestProductionRun }),
        latestTerminalRuns,
        ...(currentCircuit === undefined ? {} : { currentCircuit }),
        ...(currentIncident === undefined ? {} : { currentIncident }),
      })
    })
  }

  listIncidents(input: { automationId?: string; limit: number }): AutomationIncident[] {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new AutomationStoreError('invalid-definition', 'incident limit must be between 1 and 1000')
    }
    const rows = input.automationId === undefined
      ? this.database.prepare(`
          SELECT * FROM automation_incidents ORDER BY opened_at DESC, id DESC LIMIT ?
        `).all(input.limit)
      : this.database.prepare(`
          SELECT * FROM automation_incidents WHERE automation_id = ?
          ORDER BY opened_at DESC, id DESC LIMIT ?
        `).all(input.automationId, input.limit)
    return (rows as unknown as IncidentRow[]).map(incident)
  }

  listPendingIncidentAlerts(limit: number): AutomationIncident[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new AutomationStoreError('invalid-definition', 'incident alert limit must be between 1 and 1000')
    }
    const output: AutomationIncident[] = []
    const rows = this.database.prepare(`
      SELECT * FROM automation_incidents
      WHERE alert_status = 'pending'
      ORDER BY updated_at, id LIMIT 1000
    `).all() as unknown as IncidentRow[]
    for (const row of rows) {
      if (output.length === limit) break
      try {
        output.push(incident(row))
      } catch {
        // A malformed poison row is terminally suppressed so it cannot starve
        // later incident alerts or leak unvalidated content into Delivery.
        this.database.prepare(`
          UPDATE automation_incidents
          SET alert_status = 'suppressed',
              updated_at = ?, version = version + 1
          WHERE id = ? AND alert_status = 'pending'
        `).run(this.now(), row.id)
      }
    }
    return output
  }

  completeIncidentAlert(input: {
    incidentId: string
    expectedStatus: 'pending'
    expectedLifecycleGeneration: number
    expectedPresentationRevision: number
    expectedVersion: number
    alertRef: string
    now: number
  }): AutomationIncident {
    if (!Number.isSafeInteger(input.now)
      || !Number.isSafeInteger(input.expectedLifecycleGeneration) || input.expectedLifecycleGeneration < 1
      || !Number.isSafeInteger(input.expectedPresentationRevision) || input.expectedPresentationRevision < 1
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new AutomationStoreError('invalid-definition', 'incident alert time is invalid')
    }
    const alertRef = text(input.alertRef, 'alertRef', 500)
    const changed = this.database.prepare(`
      UPDATE automation_incidents
      SET alert_status = 'enqueued', alert_ref = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND alert_status = ? AND lifecycle_generation = ?
        AND presentation_revision = ? AND version = ?
    `).run(
      alertRef, input.now, input.incidentId, input.expectedStatus,
      input.expectedLifecycleGeneration, input.expectedPresentationRevision, input.expectedVersion,
    )
    const row = this.database.prepare('SELECT * FROM automation_incidents WHERE id = ?')
      .get(input.incidentId) as IncidentRow | undefined
    if (row === undefined || (changed.changes !== 1
      && !(row.alert_status === 'enqueued' && row.alert_ref === alertRef
        && row.lifecycle_generation === input.expectedLifecycleGeneration
        && row.presentation_revision === input.expectedPresentationRevision))) {
      throw new AutomationStoreError('version-conflict', 'incident alert state changed before completion')
    }
    return incident(row)
  }

  getCurrentIncident(automationId: string, definitionHash: string): AutomationIncident | undefined {
    const row = this.database.prepare(`
      SELECT * FROM automation_incidents
      WHERE automation_id = ? AND definition_hash = ? AND state <> 'resolved'
      ORDER BY updated_at DESC, id DESC LIMIT 1
    `).get(automationId, definitionHash) as IncidentRow | undefined
    return row === undefined ? undefined : incident(row)
  }

  /**
   * Re-prove the exact transport target before an incident leaves this store.
   * Terminal targets come from the winning claim snapshot rather than the
   * mutable current definition, so an edit/restart cannot redirect an alert.
   */
  getIncidentNotificationTarget(incidentId: string): AutomationIncidentNotificationTarget | undefined {
    const id = text(incidentId, 'incidentId', 1_000)
    const row = this.database.prepare('SELECT * FROM automation_incidents WHERE id = ?')
      .get(id) as IncidentRow | undefined
    if (row === undefined) return undefined
    const value = incident(row)
    if (value.stage !== 'terminal') {
      // Availability incidents can only be opened for a Host definition. The
      // route itself was copied into the incident in the opening transaction.
      return Object.freeze({ kind: 'owner-route', authorityId: value.notificationRouteId })
    }
    if (value.runId === undefined) return undefined
    const proof = this.getProvenProductionRun(value.runId)
    if (proof === undefined || proof.run.automationId !== value.automationId
      || proof.run.definitionHash !== value.definitionHash) return undefined
    const route = incidentNotificationRoute(proof.automation.definition)
    if (route === undefined || route.id !== value.notificationRouteId) return undefined
    return route.target
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
    openCircuits: number
    openIncidents: number
    pendingIncidentAlerts: number
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
      openCircuits: scalar("SELECT COUNT(*) AS count FROM automation_circuits WHERE state <> 'closed'"),
      openIncidents: scalar("SELECT COUNT(*) AS count FROM automation_incidents WHERE state <> 'resolved'"),
      pendingIncidentAlerts: scalar(
        "SELECT COUNT(*) AS count FROM automation_incidents WHERE alert_status = 'pending'",
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

  listDueHostExecutionRequirements(input: { now: number; limit?: number }): HostExecutionRequirement[] {
    if (!Number.isSafeInteger(input.now)) {
      throw new AutomationStoreError('invalid-definition', 'Host requirement time is invalid')
    }
    const limit = input.limit ?? 1_000
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new AutomationStoreError('invalid-definition', 'Host requirement limit is invalid')
    }
    const rows = this.database.prepare(`
      SELECT * FROM automation_definitions
      WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at, id LIMIT ?
    `).all(input.now, limit) as unknown as DefinitionRow[]
    return rows.flatMap(row => {
      const automation = record(row)
      return isHostAutomationDefinition(automation.definition)
        ? [Object.freeze({
            automationId: automation.id,
            definitionHash: row.definition_hash,
            execution: automation.definition.execution,
          })]
        : []
    })
  }

  listClaimableHostExecutionRequirements(limit = 100): HostExecutionRequirement[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new AutomationStoreError('invalid-definition', 'Host requirement limit is invalid')
    }
    const rows = this.database.prepare(`
      SELECT DISTINCT definition.* FROM automation_tasks AS task
      JOIN automation_definitions AS definition ON definition.id = task.automation_id
      WHERE task.status = 'scheduled' AND (
        definition.status = 'active'
        OR (
          definition.status = 'paused'
          AND definition.system_owner = ?
          AND ${pausedGrowthTaskAdmission('task', 'definition')}
        )
      )
      ORDER BY task.created_at, task.id LIMIT ?
    `).all(growthAutomationOwner, limit) as unknown as DefinitionRow[]
    return rows.flatMap(row => {
      const automation = record(row)
      return isHostAutomationDefinition(automation.definition)
        ? [Object.freeze({
            automationId: automation.id,
            definitionHash: row.definition_hash,
            execution: automation.definition.execution,
          })]
        : []
    })
  }

  materializeDue(input: {
    now: number
    misfireGraceMs: number
    maxCatchUp: number
    hostAvailability?: readonly HostExecutorAvailabilityDecision[]
  }): AutomationOccurrence[] {
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
        if (isHostAutomationDefinition(automation.definition)) {
          const availability = this.exactHostAvailability(
            input.hostAvailability, automation.id, row.definition_hash, 'materialize',
          )
          if (availability?.available !== true) {
            this.upsertAvailabilityIncidentInTransaction({
              automation,
              definitionHash: row.definition_hash,
              stage: 'materialize',
              failureCode: availability?.reasonCode ?? 'host-executor-proof-missing',
              now: input.now,
            })
            continue
          }
          this.resolveIncidentInTransaction(automation.id, row.definition_hash, 'materialize', input.now)
        }
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

  /** Host-derived occurrence mode associated with a durable terminal run. */
  getRunExecutionMode(runId: string): AutomationExecutionMode | 'unknown' | undefined {
    const row = this.database.prepare(`SELECT execution_mode FROM automation_runs WHERE id = ?`)
      .get(runId) as Pick<RunRow, 'execution_mode'> | undefined
    if (row === undefined) return undefined
    if (row.execution_mode === 'production' || row.execution_mode === 'preview' || row.execution_mode === 'unknown') {
      return row.execution_mode
    }
    throw new AutomationStoreError('invalid-state', 'automation run has an invalid execution mode')
  }

  /**
   * Re-prove the exact production tuple immediately before an effect sink.
   * Legacy rows, mutable current definitions, and a mode flag alone are never
   * sufficient. Corrupt snapshots throw so dispatchers can quarantine the row.
   */
  getProvenProductionRun(runId: string): { run: AutomationRun; automation: AutomationRecord } | undefined {
    const row = this.database.prepare('SELECT * FROM automation_runs WHERE id = ?').get(runId) as RunRow | undefined
    if (row === undefined || row.execution_mode !== 'production' || row.definition_hash === null) return undefined
    // Parse all bounded run fields before treating the row as effect-capable.
    const value = run(row)
    const occurrenceRow = this.database.prepare('SELECT * FROM automation_occurrences WHERE id = ?')
      .get(row.occurrence_id) as OccurrenceRow | undefined
    if (occurrenceRow === undefined || occurrenceRow.dry_run !== 0) return undefined
    const attempt = this.database.prepare('SELECT * FROM automation_attempts WHERE id = ?')
      .get(row.attempt_id) as AttemptRow | undefined
    if (attempt === undefined) return undefined
    const snapshot = automationSnapshot(attempt, row.automation_id)
    if (snapshot === undefined || hash(snapshot.definition) !== row.definition_hash) return undefined
    const evidence = value.evidence
    if (evidence !== undefined) {
      const expectedOutcome = row.status === 'succeeded' ? 'succeeded' : 'failed'
      if (evidence.situation !== automationSituation(snapshot.id)
        || evidence.outcome !== expectedOutcome
        || evidence.detail !== `automation "${snapshot.definition.name}": run ${row.status}`
        || evidence.idempotencyKey !== `automation-run:${row.id}`
        || evidence.occurredAt !== row.created_at
        || evidence.workspace !== snapshot.definition.workspace
        || evidence.agentPreset !== snapshot.definition.agentPreset
        || evidence.automationId !== snapshot.id
        || evidence.runId !== row.id) {
        throw new AutomationStoreError('invalid-state', 'automation evidence does not match its immutable run')
      }
    }
    return Object.freeze({ run: value, automation: snapshot })
  }

  /**
   * Resolve an Evaluation automation-run reference into a content-minimal,
   * exactly re-provable production receipt. Callers must supply the Evaluation
   * tuple; this method never guesses scope or situation from mutable state.
   */
  resolveQualityEvidence(input: {
    automationId: string
    runId: string
    expectedScope: { workspace: string; preset: string }
    expectedSituation: string
    expectedOccurredAt: number
    evidenceRef: { kind: 'automation-run'; ref: string }
    owner?: string
  }): AutomationQualityEvidenceReceipt | undefined {
    const automationId = text(input.automationId, 'automationId', 500)
    const runId = text(input.runId, 'runId', 1_000)
    const workspace = text(input.expectedScope.workspace, 'expectedScope.workspace', 4_096)
    const preset = text(input.expectedScope.preset, 'expectedScope.preset', 200)
    const situation = text(input.expectedSituation, 'expectedSituation', 1_000)
    if (!Number.isSafeInteger(input.expectedOccurredAt)
      || input.evidenceRef.kind !== 'automation-run' || input.evidenceRef.ref !== runId) {
      throw new AutomationStoreError('invalid-definition', 'quality evidence expectation is invalid')
    }
    const owner = input.owner === undefined ? undefined : text(input.owner, 'owner', 500)
    const proof = this.getProvenProductionRun(runId)
    if (proof === undefined || proof.run.automationId !== automationId
      || (proof.run.status !== 'succeeded'
        && proof.run.status !== 'failed' && proof.run.status !== 'timed_out')
      || proof.run.definitionHash === undefined
      || proof.run.evidence === undefined
      || (proof.run.evidenceStatus !== 'pending' && proof.run.evidenceStatus !== 'recorded')
      || proof.automation.definition.workspace !== workspace
      || proof.automation.definition.agentPreset !== preset
      || proof.run.evidence.situation !== situation
      || proof.run.evidence.occurredAt !== input.expectedOccurredAt
      || proof.run.evidence.runId !== runId
      || proof.run.evidence.automationId !== automationId
      || (owner !== undefined && proof.automation.owner !== owner)) return undefined
    const base = {
      schemaVersion: 1 as const,
      source: 'assistant-automations' as const,
      executionKind: isHostAutomationDefinition(proof.automation.definition) ? 'host' as const : 'agent' as const,
      automationId,
      runId,
      definitionHash: proof.run.definitionHash,
      status: proof.run.status,
      scope: Object.freeze({ workspace, preset }),
      situation,
      occurredAt: input.expectedOccurredAt,
      evidenceRef: Object.freeze({ kind: 'automation-run' as const, ref: runId }),
      ...(proof.run.evidence.sessionId === undefined ? {} : { sessionId: proof.run.evidence.sessionId }),
      ...(proof.run.evidence.ruleId === undefined ? {} : { ruleId: proof.run.evidence.ruleId }),
      ...(proof.run.evidence.guidanceVersion === undefined
        ? {}
        : { guidanceVersion: proof.run.evidence.guidanceVersion }),
    }
    return Object.freeze({ ...base, proofDigest: hash(base) })
  }

  /**
   * Prove that one exact owner-bound output is the immutable output of an
   * Agent production run. This is narrower than quality evidence and is used
   * only by Delivery's reserved learning-metadata lane.
   */
  resolveDeliveryEvidence(input: {
    automationId: string
    runId: string
    expectedWorkspace: string
    expectedBindingId: string
    expectedOutputDigest: string
  }): AutomationDeliveryEvidenceReceipt | undefined {
    const automationId = text(input.automationId, 'automationId', 500)
    const runId = text(input.runId, 'runId', 1_000)
    const workspace = text(input.expectedWorkspace, 'expectedWorkspace', 4_096)
    const bindingId = text(input.expectedBindingId, 'expectedBindingId', 1_000)
    if (!/^[a-f0-9]{64}$/u.test(input.expectedOutputDigest)) {
      throw new AutomationStoreError('invalid-definition', 'delivery output digest is invalid')
    }
    const proof = this.getProvenProductionRun(runId)
    if (proof === undefined || proof.run.automationId !== automationId
      || proof.run.status !== 'succeeded'
      || (proof.run.deliveryStatus !== 'pending' && proof.run.deliveryStatus !== 'enqueued')
      || proof.run.evidence === undefined
      || (proof.run.evidenceStatus !== 'pending' && proof.run.evidenceStatus !== 'recorded')
      || isHostAutomationDefinition(proof.automation.definition)
      || proof.automation.definition.workspace !== workspace
      || proof.automation.definition.deliveryBindingId !== bindingId
      || proof.run.evidence.automationId !== automationId
      || proof.run.evidence.runId !== runId
      || proof.run.evidence.situation !== `automation:${automationId}`
      || hashText(proof.run.outputPreview) !== input.expectedOutputDigest) return undefined
    const base = {
      schemaVersion: 1 as const,
      source: 'assistant-automations' as const,
      executionKind: 'agent' as const,
      automationId,
      runId,
      occurrenceId: proof.run.occurrenceId,
      workspace,
      agentPreset: proof.automation.definition.agentPreset,
      bindingId,
      situation: proof.run.evidence.situation,
      occurredAt: proof.run.evidence.occurredAt,
      executionStatus: 'succeeded' as const,
      outputDigest: input.expectedOutputDigest,
    }
    return Object.freeze({ ...base, proofDigest: hash(base) })
  }

  validateQualityEvidence(receipt: AutomationQualityEvidenceReceipt): boolean {
    try {
      if (receipt.schemaVersion !== 1 || receipt.source !== 'assistant-automations') return false
      const resolved = this.resolveQualityEvidence({
        automationId: receipt.automationId,
        runId: receipt.runId,
        expectedScope: receipt.scope,
        expectedSituation: receipt.situation,
        expectedOccurredAt: receipt.occurredAt,
        evidenceRef: receipt.evidenceRef,
      })
      return resolved !== undefined && JSON.stringify(resolved) === JSON.stringify(receipt)
    } catch {
      return false
    }
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

  /**
   * Relinquish a live coordinator lease without weakening its fencing token.
   *
   * A cleanly stopped process may expire only the exact lease it owns.  The
   * row is deliberately retained so the next owner must advance the fencing
   * token; a late/stale owner can therefore never release its successor.
   */
  releaseDuty(input: { ownerId: string; fencingToken: number; now: number }): DutyLease {
    const ownerId = text(input.ownerId, 'ownerId', 500)
    if (!Number.isSafeInteger(input.now)) {
      throw new AutomationStoreError('invalid-definition', 'release time is invalid')
    }
    return this.transaction(() => {
      const current = this.database.prepare('SELECT * FROM duty_lease WHERE singleton = 1').get() as DutyRow | undefined
      if (current === undefined || current.owner_id !== ownerId || current.fencing_token !== input.fencingToken) {
        throw new AutomationStoreError('stale-fence', 'duty ownership is missing or fenced')
      }
      const leaseUntil = Math.min(current.lease_until, input.now)
      const changed = this.database.prepare(`
        UPDATE duty_lease SET lease_until = ?, updated_at = ?
        WHERE singleton = 1 AND owner_id = ? AND fencing_token = ?
      `).run(leaseUntil, input.now, ownerId, input.fencingToken)
      if (changed.changes !== 1) {
        throw new AutomationStoreError('stale-fence', 'duty ownership changed while releasing')
      }
      return duty({ ...current, lease_until: leaseUntil }, false)
    })
  }

  claimNextTask(input: {
    ownerId: string
    fencingToken: number
    now: number
    leaseMs: number
    hostAvailability?: readonly HostExecutorAvailabilityDecision[]
  }): AutomationTask | undefined {
    this.validateLease(input.now, input.leaseMs)
    return this.transaction(() => {
      this.requireDuty(input.ownerId, input.fencingToken, input.now)
      const candidates = this.database.prepare(`
        SELECT task.* FROM automation_tasks task
        JOIN automation_definitions definition ON definition.id = task.automation_id
        WHERE task.status = 'scheduled' AND (
          definition.status = 'active'
          OR (
            definition.status = 'paused'
            AND definition.system_owner = ?
            AND ${pausedGrowthTaskAdmission('task', 'definition')}
          )
        )
        ORDER BY task.created_at, task.id LIMIT 100
      `).all(growthAutomationOwner) as unknown as TaskRow[]
      for (const candidate of candidates) {
        const result = this.claimTaskInTransaction(candidate, input, input.hostAvailability)
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
    hostAvailability?: readonly HostExecutorAvailabilityDecision[]
  }): AutomationTask | undefined {
    this.validateLease(input.now, input.leaseMs)
    return this.transaction(() => {
      this.requireDuty(input.ownerId, input.fencingToken, input.now)
      const row = this.database.prepare('SELECT * FROM automation_tasks WHERE id = ?').get(input.taskId) as TaskRow | undefined
      if (row === undefined) throw new AutomationStoreError('not-found', 'automation task was not found')
      if (row.status !== 'scheduled') throw new AutomationStoreError('invalid-state', 'only scheduled tasks can be claimed')
      return this.claimTaskInTransaction(row, input, input.hostAvailability)
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
      const occurrence = this.database.prepare('SELECT dry_run FROM automation_occurrences WHERE id = ?')
        .get(row.occurrence_id) as Pick<OccurrenceRow, 'dry_run'> | undefined
      const attempt = this.database.prepare(`
        SELECT * FROM automation_attempts
        WHERE task_id = ? AND attempt_number = ? AND fencing_token = ?
      `).get(row.id, row.attempt_count, input.fencingToken) as AttemptRow | undefined
      let snapshot: AutomationRecord | undefined
      try {
        snapshot = attempt === undefined ? undefined : automationSnapshot(attempt, row.automation_id)
      } catch {
        // The coordinator's quarantine path owns malformed snapshots. Starting
        // the task must still commit so that path can write its terminal receipt.
      }
      // Host recovery is explicitly armed by its circuit probe. A routed Agent
      // has no separate Host probe, so a later production attempt itself is
      // the durable transition from open to recovering.
      if (occurrence?.dry_run === 0 && snapshot !== undefined
        && !isHostAutomationDefinition(snapshot.definition)
        && incidentNotificationRoute(snapshot.definition) !== undefined) {
        this.markIncidentRecoveringInTransaction(
          snapshot.id,
          hash(snapshot.definition),
          input.now,
        )
      }
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

  /**
   * Terminally quarantine a started task whose immutable execution snapshot
   * cannot be decoded. No run/evaluation is invented because historical scope
   * is unavailable; the occurrence and attempt still become durably unknown.
   */
  quarantineInvalidExecutionSnapshot(input: {
    taskId: string
    ownerId: string
    fencingToken: number
    now: number
  }): AutomationTask {
    if (!Number.isSafeInteger(input.now)) {
      throw new AutomationStoreError('invalid-definition', 'now must be a safe integer')
    }
    return this.transaction(() => {
      const row = this.requireMutableTask(input, ['running'])
      const attempt = this.database.prepare(`
        SELECT * FROM automation_attempts
        WHERE task_id = ? AND attempt_number = ? AND fencing_token = ?
      `).get(row.id, row.attempt_count, input.fencingToken) as AttemptRow | undefined
      const occurrence = this.database.prepare('SELECT * FROM automation_occurrences WHERE id = ?')
        .get(row.occurrence_id) as OccurrenceRow | undefined
      if (attempt === undefined || occurrence === undefined) {
        throw new AutomationStoreError('invalid-state', 'invalid snapshot task has no exact attempt or occurrence')
      }
      const executionMode: AutomationExecutionMode | 'unknown' = occurrence.dry_run === 0
        ? 'production'
        : occurrence.dry_run === 1 ? 'preview' : 'unknown'
      const diagnostic: AutomationExecutionDiagnostic = Object.freeze({
        schemaVersion: 1,
        failureClass: 'infrastructure',
        failurePhase: 'recovery',
        failureCode: 'execution-snapshot-invalid',
        promptSubmissionState: 'not-submitted',
        sideEffectState: 'none',
        retryability: 'after-intervention',
        budgetSettlementState: 'unknown',
      })
      this.database.prepare(`
        INSERT INTO automation_runs(
          id, occurrence_id, automation_id, task_id, attempt_id, status, session_id, artifact_ref,
          output_preview, usage_json, execution_mode, definition_hash, diagnostic_json,
          delivery_status, delivery_ref, evidence_status, evidence_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'unknown', ?, NULL, ?, '{}', ?, NULL, ?, NULL, NULL, 'suppressed', NULL, ?, ?)
      `).run(
        `run-${row.id}`, row.occurrence_id, row.automation_id, row.id, attempt.id, attempt.session_id,
        'immutable execution snapshot is invalid', executionMode, JSON.stringify(diagnostic), input.now, input.now,
      )
      this.database.prepare(`
        UPDATE automation_attempts
        SET status = 'unknown', failure_code = 'execution-snapshot-invalid',
            finished_at = ?, updated_at = ?
        WHERE task_id = ? AND attempt_number = ? AND fencing_token = ?
      `).run(input.now, input.now, row.id, row.attempt_count, input.fencingToken)
      this.database.prepare(`
        UPDATE automation_tasks SET status = 'unknown', lease_until = NULL, updated_at = ? WHERE id = ?
      `).run(input.now, row.id)
      this.database.prepare(`
        UPDATE automation_occurrences
        SET status = 'unknown', reason = 'execution-snapshot-invalid', updated_at = ? WHERE id = ?
      `).run(input.now, row.occurrence_id)
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
    diagnostic?: AutomationExecutionDiagnostic
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
    const diagnostic = executionDiagnostic(
      input.diagnostic ?? legacyAutomationExecutionDiagnostic,
      'invalid-definition',
    )
    if (input.diagnostic !== undefined && !isLegacyExecutionDiagnostic(diagnostic)) {
      assertDiagnosticOutcome(input.outcome, diagnostic, (() => {
        const row = this.database.prepare('SELECT * FROM automation_tasks WHERE id = ?')
          .get(input.taskId) as TaskRow | undefined
        if (row === undefined || row.attempt_count < 1) {
          throw new AutomationStoreError('not-found', 'automation task was not found')
        }
        const attempt = this.database.prepare(`
          SELECT * FROM automation_attempts WHERE task_id = ? AND attempt_number = ?
        `).get(row.id, row.attempt_count) as AttemptRow | undefined
        const snapshot = attempt === undefined ? undefined : automationSnapshot(attempt, row.automation_id)
        if (snapshot === undefined) {
          throw new AutomationStoreError('invalid-state', 'fresh diagnostic has no immutable definition')
        }
        return snapshot.definition
      })())
    }
    const diagnosticJson = JSON.stringify(diagnostic)
    if (Buffer.byteLength(diagnosticJson, 'utf8') > 4_096) {
      throw new AutomationStoreError('invalid-definition', 'execution diagnostic exceeds 4096 bytes')
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
          && existing.diagnostic_json === diagnosticJson
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
      const occurrenceRow = this.database.prepare('SELECT * FROM automation_occurrences WHERE id = ?')
        .get(row.occurrence_id) as OccurrenceRow | undefined
      if (occurrenceRow === undefined || (occurrenceRow.dry_run !== 0 && occurrenceRow.dry_run !== 1)) {
        throw new AutomationStoreError('invalid-state', 'winning task has no valid occurrence execution mode')
      }
      // `dryRun` remains the public compatibility field, while terminal sinks
      // reason about an explicit mode. Future evaluation/shadow modes must stay
      // non-production here unless they deliberately earn sink capabilities.
      const executionMode = occurrenceRow.dry_run === 1 ? 'preview' : 'production'
      const definitionHash = hash(automation.definition)
      const evidence = buildOutcomeEvidence({
        automation,
        runId,
        outcome: input.outcome,
        executionMode,
        occurredAt: input.now,
        attribution: evidenceAttribution,
      })
      const normalizedOutput = preview.normalize('NFC').trim()
      const runDeliveryStatus = input.outcome === 'succeeded'
        && executionMode === 'production'
        && automation.definition.deliveryBindingId !== undefined
        ? normalizedOutput === '' || automation.definition.deliverySuppressExact?.includes(normalizedOutput) === true
          ? 'suppressed'
          : 'pending'
        : null
      const evaluation = buildTerminalEvaluation({
        automation,
        runId,
        outcome: input.outcome,
        executionMode,
        occurredAt: input.now,
        usage: input.usage,
        startedAt: attempt.started_at,
        attemptNumber: attempt.attempt_number,
        deliveryStatus: runDeliveryStatus === 'pending' ? 'unknown' : 'not-required',
      })
      const evaluationJson = evaluation === undefined ? undefined : JSON.stringify(evaluation)
      if (evaluationJson !== undefined && Buffer.byteLength(evaluationJson, 'utf8') > 32_768) {
        throw new AutomationStoreError('invalid-definition', 'automation evaluation payload exceeds 32768 bytes')
      }
      this.database.prepare(`
        INSERT INTO automation_runs(
          id, occurrence_id, automation_id, task_id, attempt_id, status, session_id, artifact_ref,
          output_preview, usage_json, execution_mode, definition_hash, diagnostic_json,
          delivery_status, delivery_ref, evidence_status, evidence_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
      `).run(
        runId, row.occurrence_id, row.automation_id, row.id, attempt.id, input.outcome,
        input.sessionId ?? null, input.artifactRef ?? null, preview, usageJson,
        executionMode, definitionHash, diagnosticJson, runDeliveryStatus,
        evidence.status, evidence.json, input.now, input.now,
      )
      if (evaluationJson !== undefined) {
        this.database.prepare(`
          INSERT INTO automation_evaluation_outbox(
            id, run_id, observation_kind, status, payload_json, attempt_count,
            next_attempt_at, last_failure_at, last_error_code, created_at, updated_at
          ) VALUES (?, ?, 'terminal', 'pending', ?, 0, ?, NULL, NULL, ?, ?)
        `).run(`evaluation-terminal:${runId}`, runId, evaluationJson, input.now, input.now, input.now)
      }
      this.database.prepare(`
        UPDATE automation_attempts
        SET status = ?, failure_code = ?, finished_at = ?, updated_at = ? WHERE id = ?
      `).run(
        input.outcome,
        diagnostic.failureClass === 'none' ? null : diagnostic.failureCode,
        input.now,
        input.now,
        attempt.id,
      )
      this.database.prepare(`
        UPDATE automation_tasks SET status = ?, lease_until = NULL, updated_at = ? WHERE id = ?
      `).run(input.outcome, input.now, row.id)
      this.database.prepare(`
        UPDATE automation_occurrences SET status = ?, reason = ?, updated_at = ? WHERE id = ?
      `).run(
        input.outcome,
        diagnostic.failureClass === 'none' ? null : diagnostic.failureCode,
        input.now,
        row.occurrence_id,
      )
      const circuitRow = this.database.prepare(`
        SELECT * FROM automation_circuits WHERE automation_id = ? AND definition_hash = ?
      `).get(automation.id, definitionHash) as CircuitRow | undefined
      const atomicCanary = occurrenceRow.trigger_kind === 'manual'
        && occurrenceRow.trigger_key.startsWith('circuit-canary:')
      let terminalSuccessResolvesIncident = input.outcome === 'succeeded' && !atomicCanary
      if (executionMode === 'production'
        && circuitRow?.state === 'probing' && circuitRow.probe_task_id === row.id) {
        const probePassed = input.outcome === 'succeeded'
          && diagnostic.failureClass === 'none'
          && circuitRow.probe_lease_until !== null
          && circuitRow.probe_lease_until > input.now
        const classifiedProbeFailure = diagnostic.failureClass === 'configuration'
          || diagnostic.failureClass === 'policy'
          || diagnostic.failureClass === 'budget'
        this.database.prepare(`
          UPDATE automation_circuits
          SET state = ?, failure_class = ?, failure_phase = ?, failure_code = ?,
              opened_at = ?, updated_at = ?, probe_token = NULL,
              probe_lease_until = NULL, probe_task_id = NULL, version = version + 1
          WHERE automation_id = ? AND definition_hash = ? AND state = 'probing'
            AND probe_task_id = ? AND version = ?
        `).run(
          probePassed ? 'closed' : 'open',
          classifiedProbeFailure ? diagnostic.failureClass : circuitRow.failure_class,
          classifiedProbeFailure ? diagnostic.failurePhase : circuitRow.failure_phase,
          classifiedProbeFailure ? diagnostic.failureCode : circuitRow.failure_code,
          probePassed ? circuitRow.opened_at : input.now,
          input.now, automation.id, definitionHash, row.id, circuitRow.version,
        )
        terminalSuccessResolvesIncident = probePassed
      }
      if (executionMode === 'production'
        && diagnostic.failureCode !== 'circuit-open'
        && (diagnostic.failureClass === 'configuration'
          || diagnostic.failureClass === 'policy'
          || diagnostic.failureClass === 'budget')) {
        this.database.prepare(`
          INSERT INTO automation_circuits(
            automation_id, definition_hash, state, failure_class, failure_phase,
            failure_code, opened_at, updated_at, version
          ) VALUES (?, ?, 'open', ?, ?, ?, ?, ?, 1)
          ON CONFLICT(automation_id, definition_hash) DO UPDATE SET
            state = 'open', failure_class = excluded.failure_class,
            failure_phase = excluded.failure_phase, failure_code = excluded.failure_code,
            opened_at = excluded.opened_at, updated_at = excluded.updated_at,
            version = automation_circuits.version + 1
          WHERE automation_circuits.state = 'closed'
        `).run(
          automation.id,
          definitionHash,
          diagnostic.failureClass,
          diagnostic.failurePhase,
          diagnostic.failureCode,
          input.now,
          input.now,
        )
      }
      const notificationRoute = incidentNotificationRoute(automation.definition)
      if (executionMode === 'production' && notificationRoute !== undefined) {
        if (terminalSuccessResolvesIncident) {
          this.resolveIncidentInTransaction(automation.id, definitionHash, 'terminal', input.now)
        } else if (input.outcome === 'succeeded' && diagnostic.failureClass === 'none') {
          // A canary that completed after its exact probe lease is evidence of
          // execution, not evidence that the open circuit recovered.
          this.markRecoveringIncidentOpenInTransaction(automation.id, definitionHash, input.now)
        } else if (!isHostAutomationDefinition(automation.definition) && input.outcome === 'cancelled') {
          // Expected coordinator stop/cancel-previous is not an owner incident.
          // If it interrupted an Agent recovery attempt, retain the prior open
          // incident rather than leaving its lifecycle stuck at recovering.
          this.markRecoveringIncidentOpenInTransaction(automation.id, definitionHash, input.now)
        } else {
          this.upsertTerminalIncidentInTransaction({
            automation,
            definitionHash,
            runId,
            diagnostic,
            now: input.now,
          })
        }
      }
      return run(this.database.prepare('SELECT * FROM automation_runs WHERE id = ?').get(runId) as unknown as RunRow)
    })
  }

  listPendingEvidence(limit: number): AutomationRun[] {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new AutomationStoreError('invalid-definition', 'evidence limit must be between 1 and 1000')
    }
    const output: AutomationRun[] = []
    const rows = this.database.prepare(`
      SELECT * FROM automation_runs
      WHERE evidence_status = 'pending' ORDER BY updated_at, id LIMIT 1000
    `).all() as unknown as RunRow[]
    for (const row of rows) {
      if (output.length === limit) break
      try {
        const proof = this.getProvenProductionRun(row.id)
        if (proof === undefined
          || (proof.run.status !== 'succeeded' && proof.run.status !== 'failed' && proof.run.status !== 'timed_out')
          || proof.run.evidenceStatus !== 'pending' || proof.run.evidence === undefined) {
          try {
            this.suppressRunEvidence({ runId: row.id, expectedStatus: 'pending', now: this.now() })
          } catch {
            // Concurrent settlement already removed it from this lane.
          }
          continue
        }
        output.push(proof.run)
      } catch {
        // A poison row is monotonically quarantined so it cannot occupy the
        // head of a bounded batch forever or block independent peers.
        try {
          this.suppressRunEvidence({ runId: row.id, expectedStatus: 'pending', now: this.now() })
        } catch {
          // Concurrent settlement already removed it from this lane.
        }
      }
    }
    return output
  }

  suppressRunEvidence(input: { runId: string; expectedStatus: 'pending'; now: number }): AutomationRun | undefined {
    if (!Number.isSafeInteger(input.now)) throw new AutomationStoreError('invalid-definition', 'now must be a safe integer')
    const changed = this.database.prepare(`
      UPDATE automation_runs
      SET evidence_status = 'suppressed', evidence_json = NULL, updated_at = ?
      WHERE id = ? AND evidence_status = ?
    `).run(input.now, input.runId, input.expectedStatus)
    if (changed.changes !== 1) {
      const current = this.database.prepare('SELECT * FROM automation_runs WHERE id = ?').get(input.runId) as RunRow | undefined
      if (current === undefined) return undefined
      if (current.evidence_status !== 'suppressed') {
        throw new AutomationStoreError('version-conflict', 'run evidence state changed before suppression')
      }
    }
    const current = this.database.prepare('SELECT * FROM automation_runs WHERE id = ?').get(input.runId) as RunRow | undefined
    if (current === undefined) return undefined
    try {
      return run(current)
    } catch {
      // The effect intent is already terminal even if unrelated legacy fields
      // remain corrupt; callers do not need a public projection to stay safe.
      return undefined
    }
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
    const output: AutomationRun[] = []
    const rows = this.database.prepare(`
      SELECT * FROM automation_runs WHERE delivery_status = 'pending' ORDER BY created_at, id LIMIT 1000
    `).all() as unknown as RunRow[]
    for (const row of rows) {
      if (output.length === limit) break
      try {
        const proof = this.getProvenProductionRun(row.id)
        if (proof === undefined || proof.run.status !== 'succeeded'
          || proof.automation.definition.deliveryBindingId === undefined) {
          this.suppressRunDelivery({ runId: row.id, expectedStatus: 'pending', now: this.now() })
          continue
        }
        output.push(proof.run)
      } catch {
        try {
          this.suppressRunDelivery({ runId: row.id, expectedStatus: 'pending', now: this.now() })
        } catch {
          // A concurrent terminal settlement owns this row.
        }
      }
    }
    return output
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
            const recoveredOccurrence = this.database.prepare('SELECT * FROM automation_occurrences WHERE id = ?')
              .get(row.occurrence_id) as OccurrenceRow | undefined
            const recoveredMode: AutomationExecutionMode | 'unknown' = recoveredOccurrence?.dry_run === 0
              ? 'production'
              : recoveredOccurrence?.dry_run === 1 ? 'preview' : 'unknown'
            const recoveredDiagnostic: AutomationExecutionDiagnostic = Object.freeze({
              schemaVersion: 1,
              failureClass: 'infrastructure',
              failurePhase: 'recovery',
              failureCode: 'runner-lease-expired',
              promptSubmissionState: 'unknown',
              sideEffectState: 'unknown',
              retryability: 'unsafe',
              budgetSettlementState: 'unknown',
            })
            const evaluation = buildTerminalEvaluation({
              automation: snapshot,
              runId,
              outcome: 'unknown',
              executionMode: recoveredMode,
              occurredAt: input.now,
              usage: {},
              startedAt: attempt.started_at,
              attemptNumber: attempt.attempt_number,
              deliveryStatus: 'not-required',
            })
            const evaluationJson = evaluation === undefined ? undefined : JSON.stringify(evaluation)
            if (evaluationJson !== undefined && Buffer.byteLength(evaluationJson, 'utf8') > 32_768) {
              throw new AutomationStoreError('invalid-state', 'recovered automation evaluation payload is oversized')
            }
            this.database.prepare(`
              INSERT INTO automation_runs(
                id, occurrence_id, automation_id, task_id, attempt_id, status, session_id, artifact_ref,
                output_preview, usage_json, execution_mode, definition_hash, diagnostic_json,
                delivery_status, delivery_ref, evidence_status, evidence_json,
                created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, 'unknown', ?, NULL, ?, '{}', ?, ?, ?, NULL, NULL, 'suppressed', NULL, ?, ?)
            `).run(
              runId, row.occurrence_id, row.automation_id, row.id, attempt.id, attempt.session_id,
              'runner lease expired before terminal receipt', recoveredMode, hash(snapshot.definition),
              JSON.stringify(recoveredDiagnostic), input.now, input.now,
            )
            if (evaluationJson !== undefined) {
              this.database.prepare(`
                INSERT INTO automation_evaluation_outbox(
                  id, run_id, observation_kind, status, payload_json, attempt_count,
                  next_attempt_at, last_failure_at, last_error_code, created_at, updated_at
                ) VALUES (?, ?, 'terminal', 'pending', ?, 0, ?, NULL, NULL, ?, ?)
              `).run(`evaluation-terminal:${runId}`, runId, evaluationJson, input.now, input.now, input.now)
            }
            if (recoveredMode === 'production') {
              this.upsertTerminalIncidentInTransaction({
                automation: snapshot,
                definitionHash: hash(snapshot.definition),
                runId,
                diagnostic: recoveredDiagnostic,
                now: input.now,
              })
            }
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
    hostAvailability?: readonly HostExecutorAvailabilityDecision[],
  ): AutomationTask | undefined {
    const storedAutomation = this.get(row.automation_id)
    if (storedAutomation === undefined) return undefined
    // claimTask() bypasses claimNextTask()'s candidate scan, so retain the
    // same exact paused-Growth proof here as an independent admission fence.
    const designatedGrowthTask = storedAutomation.status === 'paused'
      && this.database.prepare(`
        SELECT 1 AS present
        FROM automation_tasks task
        JOIN automation_definitions definition ON definition.id = task.automation_id
        WHERE task.id = ?
          AND definition.status = 'paused'
          AND definition.system_owner = ?
          AND ${pausedGrowthTaskAdmission('task', 'definition')}
      `).get(row.id, growthAutomationOwner) !== undefined
    if (storedAutomation.status !== 'active' && !designatedGrowthTask) return undefined
    // A Growth rehearsal/exposure never activates the mutable definition. Its
    // one designated task receives an immutable active execution snapshot,
    // while every scheduler/materialization query still sees the artifact as
    // paused and therefore cannot create a second exposure.
    const automation: AutomationRecord = designatedGrowthTask
      ? Object.freeze({ ...storedAutomation, status: 'active' as const, nextRunAt: undefined })
      : storedAutomation
    if (isHostAutomationDefinition(automation.definition)) {
      const occurrence = this.database.prepare('SELECT dry_run FROM automation_occurrences WHERE id = ?')
        .get(row.occurrence_id) as Pick<OccurrenceRow, 'dry_run'> | undefined
      if (occurrence === undefined || (occurrence.dry_run !== 0 && occurrence.dry_run !== 1)) {
        throw new AutomationStoreError('invalid-state', 'Host task has no exact execution mode')
      }
      const preview = occurrence.dry_run === 1
      const definitionHash = hash(automation.definition)
      const availability = this.exactHostAvailability(
        hostAvailability, automation.id, definitionHash, 'claim',
      )
      if (availability?.available !== true) {
        if (!preview) {
          this.upsertAvailabilityIncidentInTransaction({
            automation,
            definitionHash,
            stage: 'claim',
            failureCode: availability?.reasonCode ?? 'host-executor-proof-missing',
            now: input.now,
          })
        }
        return undefined
      }
      if (!preview) this.resolveIncidentInTransaction(automation.id, definitionHash, 'claim', input.now)
    }
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

  private exactHostAvailability(
    decisions: readonly HostExecutorAvailabilityDecision[] | undefined,
    automationId: string,
    definitionHash: string,
    stage: HostExecutorAvailabilityStage,
  ): HostExecutorAvailabilityDecision | undefined {
    const exact = decisions?.filter(decision => decision.automationId === automationId
      && decision.definitionHash === definitionHash && decision.stage === stage) ?? []
    if (exact.length !== 1) return undefined
    const decision = exact[0]!
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(decision.reasonCode)) return undefined
    return decision
  }

  private upsertAvailabilityIncidentInTransaction(input: {
    automation: AutomationRecord
    definitionHash: string
    stage: HostExecutorAvailabilityStage
    failureCode: string
    now: number
  }): void {
    if (!isHostAutomationDefinition(input.automation.definition)) return
    const code = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(input.failureCode)
      ? input.failureCode
      : 'host-executor-unavailable'
    const id = `incident-${hash([
      input.automation.id, input.definitionHash, input.stage,
    ])}`
    this.database.prepare(`
      INSERT INTO automation_incidents(
        id, automation_id, definition_hash, stage, state, failure_class,
        failure_phase, failure_code, side_effect_state, retryability,
        notification_route_id, lifecycle_generation, presentation_revision,
        alert_status, alert_ref, run_id,
        opened_at, updated_at, resolved_at, version
      ) VALUES (?, ?, ?, ?, 'open', 'configuration', 'executor-availability', ?,
        'none', 'after-intervention', ?, 1, 1, 'pending', NULL, NULL, ?, ?, NULL, 1)
      ON CONFLICT(automation_id, definition_hash, stage) DO UPDATE SET
        state = 'open', failure_class = 'configuration',
        failure_phase = 'executor-availability', failure_code = excluded.failure_code,
        side_effect_state = 'none', retryability = 'after-intervention',
        notification_route_id = excluded.notification_route_id,
        lifecycle_generation = CASE
          WHEN automation_incidents.state = 'resolved'
            THEN automation_incidents.lifecycle_generation + 1
          ELSE automation_incidents.lifecycle_generation
        END,
        presentation_revision = automation_incidents.presentation_revision + 1,
        alert_status = 'pending',
        alert_ref = CASE
          WHEN automation_incidents.state = 'resolved' THEN NULL
          ELSE automation_incidents.alert_ref
        END,
        opened_at = CASE
          WHEN automation_incidents.state = 'resolved' THEN excluded.opened_at
          ELSE automation_incidents.opened_at
        END,
        updated_at = excluded.updated_at, resolved_at = NULL,
        version = automation_incidents.version + 1
    `).run(
      id, input.automation.id, input.definitionHash, input.stage, code,
      input.automation.definition.execution.ownerRouteId, input.now, input.now,
    )
  }

  private resolveIncidentInTransaction(
    automationId: string,
    definitionHash: string,
    stage: AutomationIncident['stage'],
    now: number,
  ): void {
    this.database.prepare(`
      UPDATE automation_incidents
      SET state = 'resolved', resolved_at = ?, updated_at = ?,
          presentation_revision = presentation_revision + 1,
          alert_status = 'pending',
          version = version + 1
      WHERE automation_id = ? AND definition_hash = ? AND stage = ?
        AND state IN ('open', 'recovering')
    `).run(now, now, automationId, definitionHash, stage)
  }

  private markIncidentRecoveringInTransaction(
    automationId: string,
    definitionHash: string,
    now: number,
  ): void {
    this.database.prepare(`
      UPDATE automation_incidents
      SET state = 'recovering', resolved_at = NULL, updated_at = ?,
          presentation_revision = presentation_revision + 1,
          alert_status = 'pending', version = version + 1
      WHERE automation_id = ? AND definition_hash = ? AND stage = 'terminal' AND state = 'open'
    `).run(now, automationId, definitionHash)
  }

  private markRecoveringIncidentOpenInTransaction(
    automationId: string,
    definitionHash: string,
    now: number,
  ): void {
    this.database.prepare(`
      UPDATE automation_incidents
      SET state = 'open', updated_at = ?, presentation_revision = presentation_revision + 1,
          alert_status = 'pending', version = version + 1
      WHERE automation_id = ? AND definition_hash = ? AND stage = 'terminal' AND state = 'recovering'
    `).run(now, automationId, definitionHash)
  }

  private upsertTerminalIncidentInTransaction(input: {
    automation: AutomationRecord
    definitionHash: string
    runId: string
    diagnostic: AutomationExecutionDiagnostic
    now: number
  }): void {
    const route = incidentNotificationRoute(input.automation.definition)
    if (route === undefined || input.diagnostic.failureClass === 'none') return
    const id = `incident-${hash([input.automation.id, input.definitionHash, 'terminal'])}`
    this.database.prepare(`
      INSERT INTO automation_incidents(
        id, automation_id, definition_hash, stage, state, failure_class,
        failure_phase, failure_code, side_effect_state, retryability,
        notification_route_id, lifecycle_generation, presentation_revision,
        alert_status, alert_ref, run_id,
        opened_at, updated_at, resolved_at, version
      ) VALUES (?, ?, ?, 'terminal', 'open', ?, ?, ?, ?, ?, ?,
        1, 1, 'pending', NULL, ?, ?, ?, NULL, 1)
      ON CONFLICT(automation_id, definition_hash, stage) DO UPDATE SET
        state = 'open', failure_class = excluded.failure_class,
        failure_phase = excluded.failure_phase, failure_code = excluded.failure_code,
        side_effect_state = excluded.side_effect_state,
        retryability = excluded.retryability,
        notification_route_id = excluded.notification_route_id,
        run_id = excluded.run_id,
        lifecycle_generation = CASE
          WHEN automation_incidents.state = 'resolved'
            THEN automation_incidents.lifecycle_generation + 1
          ELSE automation_incidents.lifecycle_generation
        END,
        presentation_revision = automation_incidents.presentation_revision + 1,
        alert_status = 'pending',
        alert_ref = CASE
          WHEN automation_incidents.state = 'resolved' THEN NULL
          ELSE automation_incidents.alert_ref
        END,
        opened_at = CASE
          WHEN automation_incidents.state = 'resolved' THEN excluded.opened_at
          ELSE automation_incidents.opened_at
        END,
        updated_at = excluded.updated_at, resolved_at = NULL,
        version = automation_incidents.version + 1
    `).run(
      id, input.automation.id, input.definitionHash,
      input.diagnostic.failureClass, input.diagnostic.failurePhase,
      input.diagnostic.failureCode, input.diagnostic.sideEffectState,
      input.diagnostic.retryability, route.id,
      input.runId, input.now, input.now,
    )
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
