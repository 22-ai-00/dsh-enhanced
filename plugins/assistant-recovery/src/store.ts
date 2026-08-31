import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { RECOVERY_CATALOG_DIGEST, recoveryStepIndex } from './catalog.js'
import {
  canonicalRecoveryBootstrapAttestationSet,
  EMPTY_BOOTSTRAP_ATTESTATION_SET_DIGEST,
  RecoveryBootstrapAttestationError,
  recoveryBootstrapAttestationSetDigest,
} from './attestation.js'
import { openRecoveryDatabase } from './sqlite.js'
import {
  RECOVERY_RUNBOOK_VERSION,
  type BeginRecoveryStepInput,
  type CompleteRecoveryStepInput,
  type RecoveryBootstrapAttestation,
  type RecoveryBootstrapState,
  type RecoveryHealth,
  type RecoveryRunInput,
  type RecoveryRunStatus,
  type RecoveryStepAction,
  type RecoveryStepStatus,
  type StoredRecoveryRun,
  type StoredRecoveryStep,
} from './types.js'

export type RecoveryStoreErrorCode =
  | 'deadline-expired'
  | 'idempotency-conflict'
  | 'invalid-input'
  | 'invalid-state'
  | 'not-found'
  | 'version-conflict'

export class RecoveryStoreError extends Error {
  constructor(readonly code: RecoveryStoreErrorCode, message: string) {
    super(message)
    this.name = 'RecoveryStoreError'
  }
}

export interface RecoveryStoreOptions {
  path: string
  now?: () => number
  maxStepDurationMs?: number
  deadlineGraceMs?: number
}

export const RECOVERY_DEADLINE_GRACE_MS = 10_000

interface RunRow {
  id: string
  occurrence_id: string
  automation_id: string
  definition_hash: string
  execution_mode: 'preview' | 'production'
  target_workspace: string
  target_preset: string
  principal: string
  owner_route_id: string
  activation_nonce: string
  activation_plan_digest: string
  catalog_digest: string
  status: RecoveryRunStatus
  result_code: string | null
  started_at: number
  deadline_at: number
  finished_at: number | null
  version: number
}

interface StepRow {
  run_id: string
  step_id: StoredRecoveryStep['stepId']
  idempotency_key: string
  action_json: string
  action_digest: string
  status: RecoveryStepStatus
  before_digest: string
  after_digest: string | null
  result_code: string | null
  started_at: number
  deadline_at: number
  finished_at: number | null
  version: number
}

interface BootstrapRow {
  bootstrap_status: RecoveryHealth['bootstrapStatus']
  bootstrap_failure_code: string | null
  bootstrap_generation: number
  bootstrap_attestation_valid: number
  bootstrap_attestations_json: string
  bootstrap_attestation_set_digest: string
  updated_at: number
}

export interface BeginRecoveryBootstrapInput {
  attestationValid: boolean
  attestations: readonly RecoveryBootstrapAttestation[]
}

export interface AttestRecoveryBootstrapInput {
  expectedGeneration: number
  attestations: readonly RecoveryBootstrapAttestation[]
}

export interface CompleteRecoveryBootstrapInput {
  expectedGeneration: number
  status: 'failed' | 'succeeded'
  failureCode?: string
}

const DIGEST = /^[a-f\d]{64}$/u
const CODE = /^[a-z\d][a-z\d.-]{0,63}$/u

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0)!
    return point <= 0x1f || point === 0x7f
  })
}

function boundedText(value: string, field: string, maximumBytes = 500): string {
  if (typeof value !== 'string') throw new RecoveryStoreError('invalid-input', `${field} must be a string`)
  const normalized = value.normalize('NFC').trim()
  if (normalized === '' || Buffer.byteLength(normalized, 'utf8') > maximumBytes || hasControlCharacter(normalized)) {
    throw new RecoveryStoreError('invalid-input', `${field} must contain bounded printable text`)
  }
  return normalized
}

function digestText(value: string, field: string): string {
  const normalized = boundedText(value, field, 64).toLowerCase()
  if (!DIGEST.test(normalized)) throw new RecoveryStoreError('invalid-input', `${field} must be a SHA-256 digest`)
  return normalized
}

function resultCode(value: string): string {
  const normalized = boundedText(value, 'resultCode', 64).toLowerCase()
  if (!CODE.test(normalized)) throw new RecoveryStoreError('invalid-input', 'resultCode must be a stable low-cardinality code')
  return normalized
}

function safeVersion(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RecoveryStoreError('invalid-input', `${field} must be a positive safe integer`)
  }
  return value
}

function safeGeneration(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RecoveryStoreError('invalid-input', `${field} must be a positive safe integer`)
  }
  return value
}

function ownerLineage(value: unknown): Readonly<{
  principalRecordId: string
  principalVersion: number
}> {
  if (typeof value !== 'object' || value === null) {
    throw new RecoveryStoreError('invalid-input', 'action.principalLineage must be an object')
  }
  const raw = value as { principalRecordId?: unknown; principalVersion?: unknown }
  if (typeof raw.principalRecordId !== 'string' || typeof raw.principalVersion !== 'number') {
    throw new RecoveryStoreError('invalid-input', 'action.principalLineage is invalid')
  }
  return Object.freeze({
    principalRecordId: boundedText(
      raw.principalRecordId,
      'action.principalLineage.principalRecordId',
      500,
    ),
    principalVersion: safeVersion(
      raw.principalVersion,
      'action.principalLineage.principalVersion',
    ),
  })
}

function normalizeBootstrapAttestations(
  raw: readonly RecoveryBootstrapAttestation[],
  stored = false,
): {
    attestations: readonly RecoveryBootstrapAttestation[]
    json: string
    digest: string
  } {
  try {
    const attestations = canonicalRecoveryBootstrapAttestationSet(raw)
    const json = JSON.stringify(attestations)
    return {
      attestations,
      json,
      digest: recoveryBootstrapAttestationSetDigest(attestations),
    }
  } catch (error) {
    if (!stored) {
      if (error instanceof RecoveryBootstrapAttestationError) {
        throw new RecoveryStoreError('invalid-input', error.message)
      }
      throw error
    }
    if (error instanceof RecoveryStoreError && error.code === 'invalid-state') throw error
    throw new RecoveryStoreError('invalid-state', 'stored bootstrap attestation is corrupt')
  }
}

function storedBootstrapState(row: BootstrapRow): RecoveryBootstrapState {
  try {
    if (!Number.isSafeInteger(row.bootstrap_generation) || row.bootstrap_generation < 0
      || !Number.isSafeInteger(row.updated_at) || row.updated_at < 0
      || ![0, 1].includes(row.bootstrap_attestation_valid)) {
      throw new RecoveryStoreError('invalid-state', 'stored bootstrap state is invalid')
    }
    if (row.bootstrap_status !== 'idle' && row.bootstrap_generation < 1) {
      throw new RecoveryStoreError('invalid-state', 'stored bootstrap generation is invalid')
    }
    const raw = JSON.parse(row.bootstrap_attestations_json) as unknown
    const normalized = normalizeBootstrapAttestations(
      raw as readonly RecoveryBootstrapAttestation[],
      true,
    )
    const persistedDigest = digestText(
      row.bootstrap_attestation_set_digest,
      'bootstrapAttestationSetDigest',
    )
    if (normalized.json !== row.bootstrap_attestations_json
      || !timingSafeEqual(Buffer.from(normalized.digest), Buffer.from(persistedDigest))) {
      throw new RecoveryStoreError('invalid-state', 'stored bootstrap attestation digest is corrupt')
    }
    const attestationValid = row.bootstrap_attestation_valid === 1
    if ((!attestationValid && normalized.attestations.length !== 0)
      || (row.bootstrap_status === 'succeeded' && !attestationValid)
      || ((row.bootstrap_status === 'failed') !== (row.bootstrap_failure_code !== null))) {
      throw new RecoveryStoreError('invalid-state', 'stored bootstrap attestation state is inconsistent')
    }
    const failureCode = row.bootstrap_failure_code === null
      ? undefined
      : resultCode(row.bootstrap_failure_code)
    return Object.freeze({
      status: row.bootstrap_status,
      ...(failureCode === undefined ? {} : { failureCode }),
      generation: row.bootstrap_generation,
      attestationValid,
      attestationSetDigest: persistedDigest,
      attestations: normalized.attestations,
      updatedAt: row.updated_at,
    })
  } catch (error) {
    if (error instanceof RecoveryStoreError && error.code === 'invalid-state') throw error
    throw new RecoveryStoreError('invalid-state', 'stored bootstrap state is corrupt')
  }
}

function safeDuration(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RecoveryStoreError('invalid-input', `${field} is outside its safe bound`)
  }
  return value
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function normalizedAction(
  raw: RecoveryStepAction,
  allowLegacyMaintenance = false,
): { action: RecoveryStepAction; json: string; digest: string } {
  if (typeof raw !== 'object' || raw === null || typeof raw.kind !== 'string') {
    throw new RecoveryStoreError('invalid-input', 'step action must be a fixed catalog action')
  }
  let action: RecoveryStepAction
  switch (raw.kind) {
    case 'verify-authority':
    case 'verify-health':
      action = Object.freeze({ kind: raw.kind })
      break
    case 'project-evaluation':
      action = Object.freeze({
        kind: raw.kind,
        evaluationId: boundedText(raw.evaluationId, 'action.evaluationId', 200),
      })
      break
    case 'maintain-preferences':
      if (raw.limit !== 1) throw new RecoveryStoreError('invalid-input', 'preference maintenance is fixed to one item')
      if (raw.ownerGeneration === undefined && raw.principalLineage === undefined) {
        if (!allowLegacyMaintenance) {
          throw new RecoveryStoreError(
            'invalid-input',
            'preference maintenance requires an exact durable owner fence',
          )
        }
        action = Object.freeze({ kind: raw.kind, limit: 1 })
        break
      }
      if (raw.ownerGeneration === undefined || raw.principalLineage === undefined) {
        throw new RecoveryStoreError('invalid-input', 'preference maintenance owner fence is incomplete')
      }
      action = Object.freeze({
        kind: raw.kind,
        limit: 1,
        ownerGeneration: safeGeneration(raw.ownerGeneration, 'action.ownerGeneration'),
        principalLineage: ownerLineage(raw.principalLineage),
      })
      break
    case 'activate-preference':
      action = Object.freeze({
        kind: raw.kind,
        hypothesisId: boundedText(raw.hypothesisId, 'action.hypothesisId', 200),
        expectedVersion: safeVersion(raw.expectedVersion, 'action.expectedVersion'),
        ownerGeneration: safeGeneration(raw.ownerGeneration, 'action.ownerGeneration'),
        principalLineage: ownerLineage(raw.principalLineage),
      })
      break
    case 'rollback-evolution':
      action = Object.freeze({
        kind: raw.kind,
        ruleId: boundedText(raw.ruleId, 'action.ruleId', 200),
        expectedVersion: safeVersion(raw.expectedVersion, 'action.expectedVersion'),
      })
      break
    case 'probe-automation-circuit':
      action = Object.freeze({
        kind: raw.kind,
        automationId: boundedText(raw.automationId, 'action.automationId', 200),
        definitionHash: digestText(raw.definitionHash, 'action.definitionHash'),
        expectedVersion: safeVersion(raw.expectedVersion, 'action.expectedVersion'),
      })
      break
    case 'noop':
      action = Object.freeze({ kind: raw.kind, reasonCode: resultCode(raw.reasonCode) })
      break
    default:
      throw new RecoveryStoreError('invalid-input', 'step action is not in the fixed catalog')
  }
  const json = canonicalJson(action)
  if (Buffer.byteLength(json, 'utf8') > 2_048) {
    throw new RecoveryStoreError('invalid-input', 'step action exceeds the durable byte limit')
  }
  return { action, json, digest: createHash('sha256').update(json).digest('hex') }
}

function storedAction(value: string, expectedDigest: string): RecoveryStepAction {
  try {
    if (!DIGEST.test(expectedDigest)) {
      throw new RecoveryStoreError('invalid-state', 'stored step action digest is malformed')
    }
    const normalized = normalizedAction(JSON.parse(value) as RecoveryStepAction, true)
    const actual = Buffer.from(normalized.digest, 'hex')
    const expected = Buffer.from(expectedDigest, 'hex')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new RecoveryStoreError('invalid-state', 'stored step action digest does not match its canonical action')
    }
    return normalized.action
  } catch (error) {
    if (error instanceof RecoveryStoreError && error.code === 'invalid-state') throw error
    throw new RecoveryStoreError('invalid-state', 'stored step action is corrupt')
  }
}

function assertActionMatchesStep(stepId: StoredRecoveryStep['stepId'], action: RecoveryStepAction): void {
  const expected: Record<StoredRecoveryStep['stepId'], readonly RecoveryStepAction['kind'][]> = {
    'authority-admission': ['verify-authority', 'noop'],
    'ledger-reconcile': ['project-evaluation', 'noop'],
    'retention-maintenance': ['maintain-preferences', 'noop'],
    't1-effects': ['activate-preference', 'noop'],
    'regression-rollback': ['rollback-evolution', 'noop'],
    'incident-review': ['probe-automation-circuit', 'noop'],
    verification: ['verify-health', 'noop'],
  }
  if (!expected[stepId].includes(action.kind)) {
    throw new RecoveryStoreError('invalid-input', `${action.kind} is not valid for ${stepId}`)
  }
}

function scopeKey(workspace: string, preset: string): string {
  return createHash('sha256').update(JSON.stringify([workspace, preset])).digest('hex')
}

function storedRun(row: RunRow): StoredRecoveryRun {
  return Object.freeze({
    id: row.id,
    occurrenceId: row.occurrence_id,
    automationId: row.automation_id,
    definitionHash: row.definition_hash,
    executionMode: row.execution_mode,
    targetScope: Object.freeze({ workspace: row.target_workspace, preset: row.target_preset }),
    principal: row.principal,
    ownerRouteId: row.owner_route_id,
    activationNonce: row.activation_nonce,
    activationPlanDigest: row.activation_plan_digest,
    catalogDigest: row.catalog_digest,
    status: row.status,
    startedAt: row.started_at,
    deadlineAt: row.deadline_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    ...(row.result_code === null ? {} : { resultCode: row.result_code }),
    version: row.version,
  })
}

function storedStep(row: StepRow): StoredRecoveryStep {
  const action = storedAction(row.action_json, row.action_digest)
  assertActionMatchesStep(row.step_id, action)
  return Object.freeze({
    runId: row.run_id,
    stepId: row.step_id,
    idempotencyKey: row.idempotency_key,
    action,
    actionDigest: row.action_digest,
    status: row.status,
    beforeDigest: row.before_digest,
    ...(row.after_digest === null ? {} : { afterDigest: row.after_digest }),
    ...(row.result_code === null ? {} : { resultCode: row.result_code }),
    startedAt: row.started_at,
    deadlineAt: row.deadline_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    version: row.version,
  })
}

function sameRun(row: RunRow, input: RecoveryRunInput): boolean {
  return row.automation_id === input.automationId
    && row.definition_hash === input.definitionHash
    && row.execution_mode === input.executionMode
    && row.target_workspace === input.targetScope.workspace
    && row.target_preset === input.targetScope.preset
    && row.principal === input.principal
    && row.owner_route_id === input.ownerRouteId
    && row.activation_nonce === input.activationNonce
    && row.activation_plan_digest === input.activationPlanDigest
    && row.catalog_digest === input.catalogDigest
}

export class RecoveryStore {
  private readonly database: DatabaseSync
  private readonly now: () => number
  private readonly maxStepDurationMs: number
  private readonly deadlineGraceMs: number

  constructor(options: RecoveryStoreOptions) {
    this.database = openRecoveryDatabase(options.path)
    this.now = options.now ?? Date.now
    this.maxStepDurationMs = safeDuration(
      options.maxStepDurationMs ?? 10_000,
      'maxStepDurationMs',
      100,
      60_000,
    )
    this.deadlineGraceMs = safeDuration(
      options.deadlineGraceMs ?? RECOVERY_DEADLINE_GRACE_MS,
      'deadlineGraceMs',
      0,
      60_000,
    )
  }

  beginRun(raw: RecoveryRunInput): { run: StoredRecoveryRun; replayed: boolean } {
    const workspace = boundedText(raw.targetScope.workspace, 'targetScope.workspace', 4_096)
    if (!isAbsolute(workspace)) {
      throw new RecoveryStoreError('invalid-input', 'targetScope.workspace must be absolute')
    }
    const input: RecoveryRunInput = {
      occurrenceId: boundedText(raw.occurrenceId, 'occurrenceId', 200),
      automationId: boundedText(raw.automationId, 'automationId', 200),
      definitionHash: digestText(raw.definitionHash, 'definitionHash'),
      executionMode: raw.executionMode,
      targetScope: {
        workspace: resolve(workspace),
        preset: boundedText(raw.targetScope.preset, 'targetScope.preset', 200),
      },
      principal: boundedText(raw.principal, 'principal', 500),
      ownerRouteId: boundedText(raw.ownerRouteId, 'ownerRouteId', 200),
      activationNonce: boundedText(raw.activationNonce, 'activationNonce', 200),
      activationPlanDigest: digestText(raw.activationPlanDigest, 'activationPlanDigest'),
      catalogDigest: digestText(raw.catalogDigest, 'catalogDigest'),
    }
    if (input.catalogDigest !== RECOVERY_CATALOG_DIGEST) {
      throw new RecoveryStoreError('invalid-input', 'catalogDigest does not match the compiled runbook')
    }
    if (input.executionMode !== 'preview' && input.executionMode !== 'production') {
      throw new RecoveryStoreError('invalid-input', 'executionMode must be preview or production')
    }
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.database.prepare(
        'SELECT * FROM recovery_runs WHERE occurrence_id = ?',
      ).get(input.occurrenceId) as RunRow | undefined
      if (existing !== undefined) {
        if (!sameRun(existing, input)) {
          throw new RecoveryStoreError('idempotency-conflict', 'occurrenceId was already used with different immutable input')
        }
        this.database.exec('COMMIT')
        return { run: storedRun(existing), replayed: true }
      }
      const id = randomUUID()
      const now = this.now()
      const deadlineAt = now + this.maxStepDurationMs * 14 + this.deadlineGraceMs
      if (!Number.isSafeInteger(deadlineAt)) {
        throw new RecoveryStoreError('invalid-state', 'recovery run deadline overflowed')
      }
      this.database.prepare(`
        INSERT INTO recovery_runs (
          id, occurrence_id, automation_id, definition_hash, execution_mode,
          target_workspace, target_preset, principal, owner_route_id, activation_nonce,
          activation_plan_digest, catalog_digest, status, started_at, deadline_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, 1)
      `).run(
        id,
        input.occurrenceId,
        input.automationId,
        input.definitionHash,
        input.executionMode,
        input.targetScope.workspace,
        input.targetScope.preset,
        input.principal,
        input.ownerRouteId,
        input.activationNonce,
        input.activationPlanDigest,
        input.catalogDigest,
        now,
        deadlineAt,
      )
      const row = this.database.prepare('SELECT * FROM recovery_runs WHERE id = ?').get(id) as unknown as RunRow
      this.database.exec('COMMIT')
      return { run: storedRun(row), replayed: false }
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  beginStep(raw: BeginRecoveryStepInput): { step: StoredRecoveryStep; replayed: boolean } {
    const runId = boundedText(raw.runId, 'runId', 200)
    const { action, json: actionJson, digest: actionDigest } = normalizedAction(raw.action)
    assertActionMatchesStep(raw.stepId, action)
    const beforeDigest = digestText(raw.beforeDigest, 'beforeDigest')
    const index = recoveryStepIndex(raw.stepId)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const run = this.database.prepare('SELECT * FROM recovery_runs WHERE id = ?').get(runId) as RunRow | undefined
      if (run === undefined) throw new RecoveryStoreError('not-found', 'recovery run was not found')
      if (run.status !== 'running') throw new RecoveryStoreError('invalid-state', 'recovery run is already terminal')
      const existing = this.database.prepare(
        'SELECT * FROM recovery_steps WHERE run_id = ? AND step_id = ?',
      ).get(runId, raw.stepId) as StepRow | undefined
      if (existing !== undefined) {
        const persisted = storedStep(existing)
        if (existing.action_digest !== actionDigest) {
          throw new RecoveryStoreError('idempotency-conflict', 'step was already started with a different action digest')
        }
        if (existing.before_digest !== beforeDigest) {
          throw new RecoveryStoreError('idempotency-conflict', 'step was already started from a different state digest')
        }
        this.database.exec('COMMIT')
        return { step: persisted, replayed: true }
      }
      const now = this.now()
      if (run.deadline_at <= now) {
        throw new RecoveryStoreError('deadline-expired', 'the persisted recovery run deadline has expired')
      }
      const blocking = this.database.prepare(`
        SELECT step_id FROM recovery_steps
        WHERE run_id = ? AND (step_index >= ? OR status IN ('started', 'failed', 'unknown'))
        LIMIT 1
      `).get(runId, index) as { step_id: string } | undefined
      if (blocking !== undefined) {
        throw new RecoveryStoreError('invalid-state', 'catalog steps must start once and in order')
      }
      const priorCount = (this.database.prepare(
        'SELECT count(*) AS count FROM recovery_steps WHERE run_id = ? AND step_index < ?',
      ).get(runId, index) as { count: number }).count
      if (priorCount !== index) {
        throw new RecoveryStoreError('invalid-state', 'a prior catalog step has not been durably completed')
      }
      const deadlineAt = Math.min(
        run.deadline_at,
        now + this.maxStepDurationMs + this.deadlineGraceMs,
      )
      if (!Number.isSafeInteger(deadlineAt)) {
        throw new RecoveryStoreError('invalid-state', 'recovery step deadline overflowed')
      }
      const idempotencyKey = `recovery:${RECOVERY_RUNBOOK_VERSION}:${run.occurrence_id}:${raw.stepId}`
      this.database.prepare(`
        INSERT INTO recovery_steps (
          run_id, step_id, step_index, idempotency_key, action_json, action_digest,
          status, before_digest, started_at, deadline_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, 'started', ?, ?, ?, 1)
      `).run(runId, raw.stepId, index, idempotencyKey, actionJson, actionDigest, beforeDigest, now, deadlineAt)
      const row = this.database.prepare(
        'SELECT * FROM recovery_steps WHERE run_id = ? AND step_id = ?',
      ).get(runId, raw.stepId) as unknown as StepRow
      this.database.exec('COMMIT')
      return { step: storedStep(row), replayed: false }
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  completeStep(raw: CompleteRecoveryStepInput): StoredRecoveryStep {
    const runId = boundedText(raw.runId, 'runId', 200)
    const beforeDigest = digestText(raw.beforeDigest, 'beforeDigest')
    const afterDigest = digestText(raw.afterDigest, 'afterDigest')
    const code = resultCode(raw.resultCode)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const current = this.database.prepare(
        'SELECT * FROM recovery_steps WHERE run_id = ? AND step_id = ?',
      ).get(runId, raw.stepId) as StepRow | undefined
      if (current === undefined) throw new RecoveryStoreError('not-found', 'recovery step was not found')
      const persisted = storedStep(current)
      if (current.status !== 'started') {
        const replayed = current.status === raw.status
          && current.before_digest === beforeDigest
          && current.after_digest === afterDigest
          && current.result_code === code
        if (!replayed) throw new RecoveryStoreError('idempotency-conflict', 'step already has a different terminal receipt')
        this.database.exec('COMMIT')
        return persisted
      }
      if (current.version !== raw.expectedVersion) {
        throw new RecoveryStoreError('version-conflict', 'recovery step version changed')
      }
      if (current.before_digest !== beforeDigest) {
        throw new RecoveryStoreError('idempotency-conflict', 'terminal receipt does not match the durable before digest')
      }
      const result = this.database.prepare(`
        UPDATE recovery_steps
        SET status = ?, after_digest = ?, result_code = ?,
            finished_at = ?, version = version + 1
        WHERE run_id = ? AND step_id = ? AND status = 'started' AND version = ?
      `).run(raw.status, afterDigest, code, this.now(), runId, raw.stepId, raw.expectedVersion)
      if (result.changes !== 1) throw new RecoveryStoreError('version-conflict', 'recovery step changed concurrently')
      const row = this.database.prepare(
        'SELECT * FROM recovery_steps WHERE run_id = ? AND step_id = ?',
      ).get(runId, raw.stepId) as unknown as StepRow
      this.database.exec('COMMIT')
      return storedStep(row)
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  completeRun(input: {
    runId: string
    expectedVersion: number
    status: Exclude<RecoveryRunStatus, 'running'>
    resultCode: string
  }): StoredRecoveryRun {
    const runId = boundedText(input.runId, 'runId', 200)
    const code = resultCode(input.resultCode)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const current = this.database.prepare('SELECT * FROM recovery_runs WHERE id = ?').get(runId) as RunRow | undefined
      if (current === undefined) throw new RecoveryStoreError('not-found', 'recovery run was not found')
      if (current.status !== 'running') {
        if (current.status !== input.status || current.result_code !== code) {
          throw new RecoveryStoreError('idempotency-conflict', 'run already has a different terminal receipt')
        }
        this.database.exec('COMMIT')
        return storedRun(current)
      }
      if (current.version !== input.expectedVersion) {
        throw new RecoveryStoreError('version-conflict', 'recovery run version changed')
      }
      const started = (this.database.prepare(
        "SELECT count(*) AS count FROM recovery_steps WHERE run_id = ? AND status = 'started'",
      ).get(runId) as { count: number }).count
      if (started !== 0) throw new RecoveryStoreError('invalid-state', 'a started step has no terminal receipt')
      if (input.status === 'succeeded') {
        const rows = this.database.prepare(`
          SELECT run_id, step_id, idempotency_key, action_json, action_digest, status,
                 before_digest, after_digest, result_code, started_at, deadline_at, finished_at, version
          FROM recovery_steps WHERE run_id = ? ORDER BY step_index
        `).all(runId) as unknown as StepRow[]
        if (rows.length !== 7
          || rows.some(row => !['noop', 'succeeded'].includes(row.status))) {
          throw new RecoveryStoreError('invalid-state', 'a successful run requires every catalog step to be complete')
        }
        const first = storedStep(rows[0]!)
        const last = storedStep(rows[rows.length - 1]!)
        if (first.status !== 'succeeded' || first.action.kind !== 'verify-authority'
          || last.status !== 'succeeded' || last.action.kind !== 'verify-health') {
          throw new RecoveryStoreError('invalid-state', 'a successful run requires exact authority and health verification')
        }
      }
      const result = this.database.prepare(`
        UPDATE recovery_runs
        SET status = ?, result_code = ?, finished_at = ?, version = version + 1
        WHERE id = ? AND status = 'running' AND version = ?
      `).run(input.status, code, this.now(), runId, input.expectedVersion)
      if (result.changes !== 1) throw new RecoveryStoreError('version-conflict', 'recovery run changed concurrently')
      const row = this.database.prepare('SELECT * FROM recovery_runs WHERE id = ?').get(runId) as unknown as RunRow
      this.database.exec('COMMIT')
      return storedRun(row)
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  getRunByOccurrence(occurrenceId: string): StoredRecoveryRun | undefined {
    const row = this.database.prepare('SELECT * FROM recovery_runs WHERE occurrence_id = ?').get(
      boundedText(occurrenceId, 'occurrenceId', 200),
    ) as RunRow | undefined
    return row === undefined ? undefined : storedRun(row)
  }

  /**
   * Exact activation attestation used before a production schedule is enabled.
   * The preview definition hash may differ only because its schedule is pinned
   * to a far-future one-shot; all authority-bearing fields must match exactly.
   */
  findSuccessfulPreview(input: {
    automationId: string
    targetScope: RecoveryRunInput['targetScope']
    principal: string
    ownerRouteId: string
    activationNonce: string
    activationPlanDigest: string
    catalogDigest: string
  }): StoredRecoveryRun | undefined {
    const workspace = boundedText(input.targetScope.workspace, 'targetScope.workspace', 4_096)
    if (!isAbsolute(workspace)) {
      throw new RecoveryStoreError('invalid-input', 'targetScope.workspace must be absolute')
    }
    const row = this.database.prepare(`
      SELECT * FROM recovery_runs
      WHERE automation_id = ?
        AND execution_mode = 'preview'
        AND status = 'succeeded'
        AND result_code = 'preview-verified'
        AND target_workspace = ?
        AND target_preset = ?
        AND principal = ?
        AND owner_route_id = ?
        AND activation_nonce = ?
        AND activation_plan_digest = ?
        AND catalog_digest = ?
      ORDER BY finished_at DESC, id DESC LIMIT 1
    `).get(
      boundedText(input.automationId, 'automationId', 200),
      resolve(workspace),
      boundedText(input.targetScope.preset, 'targetScope.preset', 200),
      boundedText(input.principal, 'principal', 500),
      boundedText(input.ownerRouteId, 'ownerRouteId', 200),
      boundedText(input.activationNonce, 'activationNonce', 200),
      digestText(input.activationPlanDigest, 'activationPlanDigest'),
      digestText(input.catalogDigest, 'catalogDigest'),
    ) as RunRow | undefined
    return row === undefined ? undefined : storedRun(row)
  }

  getStep(runId: string, stepId: StoredRecoveryStep['stepId']): StoredRecoveryStep | undefined {
    const row = this.database.prepare(`
      SELECT run_id, step_id, idempotency_key, action_json, action_digest, status,
             before_digest, after_digest, result_code, started_at, deadline_at, finished_at, version
      FROM recovery_steps WHERE run_id = ? AND step_id = ?
    `).get(
      boundedText(runId, 'runId', 200),
      stepId,
    ) as unknown as StepRow | undefined
    return row === undefined ? undefined : storedStep(row)
  }

  listSteps(runId: string): StoredRecoveryStep[] {
    const rows = this.database.prepare(`
      SELECT run_id, step_id, idempotency_key, action_json, action_digest, status,
             before_digest, after_digest, result_code, started_at, deadline_at, finished_at, version
      FROM recovery_steps WHERE run_id = ? ORDER BY step_index
    `).all(boundedText(runId, 'runId', 200)) as unknown as StepRow[]
    return rows.map(storedStep)
  }

  /** Remaining time from the Store clock to an immutable persisted deadline. */
  deadlineRemainingMs(deadlineAt: number): number {
    if (!Number.isSafeInteger(deadlineAt) || deadlineAt < 0) {
      throw new RecoveryStoreError('invalid-state', 'persisted recovery deadline is invalid')
    }
    const now = this.now()
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RecoveryStoreError('invalid-state', 'recovery Store clock is invalid')
    }
    return deadlineAt - now
  }

  /** Start a new durable bootstrap generation and invalidate all prior proof. */
  beginBootstrap(input: BeginRecoveryBootstrapInput): RecoveryBootstrapState {
    if (typeof input.attestationValid !== 'boolean') {
      throw new RecoveryStoreError('invalid-input', 'bootstrap attestation validity is invalid')
    }
    const normalized = normalizeBootstrapAttestations(input.attestations)
    if (!input.attestationValid && normalized.attestations.length !== 0) {
      throw new RecoveryStoreError('invalid-input', 'an invalid bootstrap attestation must be explicitly empty')
    }
    if (!input.attestationValid && normalized.digest !== EMPTY_BOOTSTRAP_ATTESTATION_SET_DIGEST) {
      throw new RecoveryStoreError('invalid-state', 'empty bootstrap attestation digest is inconsistent')
    }
    const now = this.bootstrapNow()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const current = this.readBootstrapState()
      if (!Number.isSafeInteger(current.generation + 1)) {
        throw new RecoveryStoreError('invalid-state', 'bootstrap generation overflowed')
      }
      const generation = current.generation + 1
      const changed = this.database.prepare(`
        UPDATE recovery_runtime_state
        SET bootstrap_status = 'running', bootstrap_failure_code = NULL,
            bootstrap_generation = ?, bootstrap_attestation_valid = ?,
            bootstrap_attestations_json = ?, bootstrap_attestation_set_digest = ?,
            updated_at = ?
        WHERE singleton = 1 AND bootstrap_generation = ?
      `).run(
        generation,
        input.attestationValid ? 1 : 0,
        normalized.json,
        normalized.digest,
        now,
        current.generation,
      )
      if (changed.changes !== 1) {
        throw new RecoveryStoreError('version-conflict', 'bootstrap generation changed concurrently')
      }
      const state = this.readBootstrapState()
      this.database.exec('COMMIT')
      return state
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  /** Bind the exact plan set to the still-running bootstrap generation. */
  attestBootstrap(input: AttestRecoveryBootstrapInput): RecoveryBootstrapState {
    const expectedGeneration = safeGeneration(input.expectedGeneration, 'expectedGeneration')
    const normalized = normalizeBootstrapAttestations(input.attestations)
    const now = this.bootstrapNow()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const current = this.readBootstrapState()
      if (current.generation !== expectedGeneration) {
        throw new RecoveryStoreError('version-conflict', 'bootstrap generation changed concurrently')
      }
      if (current.status !== 'running') {
        if (current.attestationValid
          && current.attestationSetDigest === normalized.digest) {
          this.database.exec('COMMIT')
          return current
        }
        throw new RecoveryStoreError('invalid-state', 'bootstrap generation is already terminal')
      }
      const changed = this.database.prepare(`
        UPDATE recovery_runtime_state
        SET bootstrap_attestation_valid = 1, bootstrap_attestations_json = ?,
            bootstrap_attestation_set_digest = ?, updated_at = ?
        WHERE singleton = 1 AND bootstrap_generation = ? AND bootstrap_status = 'running'
      `).run(normalized.json, normalized.digest, now, expectedGeneration)
      if (changed.changes !== 1) {
        throw new RecoveryStoreError('version-conflict', 'bootstrap generation changed concurrently')
      }
      const state = this.readBootstrapState()
      this.database.exec('COMMIT')
      return state
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  /** Complete exactly one generation; stale async completions fail closed. */
  completeBootstrap(input: CompleteRecoveryBootstrapInput): RecoveryBootstrapState {
    const expectedGeneration = safeGeneration(input.expectedGeneration, 'expectedGeneration')
    if (input.status !== 'failed' && input.status !== 'succeeded') {
      throw new RecoveryStoreError('invalid-input', 'bootstrap terminal status is invalid')
    }
    if (input.status !== 'failed' && input.failureCode !== undefined) {
      throw new RecoveryStoreError('invalid-input', 'only failed bootstrap may carry a failure code')
    }
    const failureCode = input.status === 'failed'
      ? resultCode(input.failureCode ?? 'bootstrap-failed')
      : undefined
    const now = this.bootstrapNow()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const current = this.readBootstrapState()
      if (current.generation !== expectedGeneration) {
        throw new RecoveryStoreError('version-conflict', 'bootstrap generation changed concurrently')
      }
      if (current.status !== 'running') {
        const replayed = current.status === input.status
          && current.failureCode === failureCode
        if (!replayed) {
          throw new RecoveryStoreError('idempotency-conflict', 'bootstrap already has a different terminal receipt')
        }
        this.database.exec('COMMIT')
        return current
      }
      if (input.status === 'succeeded' && !current.attestationValid) {
        throw new RecoveryStoreError('invalid-state', 'bootstrap success requires an exact attestation set')
      }
      const changed = this.database.prepare(`
        UPDATE recovery_runtime_state
        SET bootstrap_status = ?, bootstrap_failure_code = ?, updated_at = ?
        WHERE singleton = 1 AND bootstrap_generation = ? AND bootstrap_status = 'running'
      `).run(input.status, failureCode ?? null, now, expectedGeneration)
      if (changed.changes !== 1) {
        throw new RecoveryStoreError('version-conflict', 'bootstrap generation changed concurrently')
      }
      const state = this.readBootstrapState()
      this.database.exec('COMMIT')
      return state
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  health(): RecoveryHealth {
    const now = this.now()
    const counts = this.database.prepare(`
      SELECT
        sum(status = 'running') AS running_runs,
        sum(status = 'running' AND deadline_at <= ?) AS stale_runs,
        sum(status = 'failed') AS failed_runs,
        sum(status = 'unknown') AS unknown_runs,
        coalesce(max(CASE WHEN status = 'succeeded' THEN finished_at ELSE 0 END), 0) AS last_succeeded_at,
        coalesce(max(CASE WHEN status IN ('failed', 'unknown') THEN finished_at ELSE 0 END), 0) AS last_failed_at
      FROM recovery_runs
    `).get(now) as {
      running_runs: number | null
      stale_runs: number | null
      failed_runs: number | null
      unknown_runs: number | null
      last_succeeded_at: number
      last_failed_at: number
    }
    const steps = this.database.prepare(`
      SELECT count(*) AS incomplete_steps,
             sum(status = 'started' AND deadline_at <= ?) AS stale_steps
      FROM recovery_steps WHERE status = 'started'
    `).get(now) as { incomplete_steps: number; stale_steps: number | null }
    const production = this.database.prepare(`
      SELECT status, started_at FROM recovery_runs
      WHERE execution_mode = 'production'
      ORDER BY started_at DESC, rowid DESC LIMIT 1
    `).get() as { status: RecoveryRunStatus; started_at: number } | undefined
    const productionStatuses = this.database.prepare(`
      SELECT status FROM recovery_runs
      WHERE execution_mode = 'production'
      ORDER BY started_at DESC, rowid DESC
    `).all() as unknown as Array<{ status: RecoveryRunStatus }>
    let consecutiveProductionFailures = 0
    for (const row of productionStatuses) {
      if (row.status !== 'failed' && row.status !== 'unknown') break
      consecutiveProductionFailures += 1
    }
    const bootstrap = this.readBootstrapState()
    return Object.freeze({
      runningRuns: counts.running_runs ?? 0,
      failedRuns: counts.failed_runs ?? 0,
      unknownRuns: counts.unknown_runs ?? 0,
      incompleteSteps: steps.incomplete_steps,
      staleRuns: counts.stale_runs ?? 0,
      staleSteps: steps.stale_steps ?? 0,
      lastSucceededAt: counts.last_succeeded_at,
      lastFailedAt: counts.last_failed_at,
      latestProductionStatus: production?.status ?? 'none',
      consecutiveProductionFailures,
      lastProductionRunAt: production?.started_at ?? 0,
      bootstrapStatus: bootstrap.status,
      ...(bootstrap.failureCode === undefined
        ? {}
        : { bootstrapFailureCode: bootstrap.failureCode }),
      bootstrapGeneration: bootstrap.generation,
      bootstrapAttestationValid: bootstrap.attestationValid,
      bootstrapAttestationSetDigest: bootstrap.attestationSetDigest,
      bootstrapAttestations: bootstrap.attestations,
      bootstrapUpdatedAt: bootstrap.updatedAt,
    })
  }

  private bootstrapNow(): number {
    const now = this.now()
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RecoveryStoreError('invalid-state', 'recovery Store clock is invalid')
    }
    return now
  }

  private readBootstrapState(): RecoveryBootstrapState {
    const row = this.database.prepare(`
      SELECT bootstrap_status, bootstrap_failure_code, bootstrap_generation,
             bootstrap_attestation_valid, bootstrap_attestations_json,
             bootstrap_attestation_set_digest, updated_at
      FROM recovery_runtime_state WHERE singleton = 1
    `).get() as BootstrapRow | undefined
    if (row === undefined) {
      throw new RecoveryStoreError('invalid-state', 'bootstrap state singleton is missing')
    }
    return storedBootstrapState(row)
  }

  targetScopeDigest(scope: RecoveryRunInput['targetScope']): string {
    const workspace = boundedText(scope.workspace, 'targetScope.workspace', 4_096)
    if (!isAbsolute(workspace)) {
      throw new RecoveryStoreError('invalid-input', 'targetScope.workspace must be absolute')
    }
    return scopeKey(
      resolve(workspace),
      boundedText(scope.preset, 'targetScope.preset', 200),
    )
  }

  close(): void {
    this.database.close()
  }
}
