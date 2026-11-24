import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ensureCompensationSchema, openRecoveryDatabase } from './sqlite.js'
import {
  RecoveryCompensationError,
  type CompensationAuditEntry,
  type CompensationAuditEvent,
  type CompensationCategory,
  type CompensationQueryFilter,
  type CompensationRecordInput,
  type CompensationScope,
  type CompensationStatus,
  type CompensationTerminalStatus,
  type PublicCompensationStatus,
  type StoredCompensationRecord,
} from './compensation-types.js'

const MAX_TARGET_BYTES = 262_144
const MAX_METADATA_BYTES = 65_536
const MAX_PREIMAGE_BYTES = 1_048_576
const MAX_RECEIPT_BYTES = 262_144
const MAX_DETAIL_BYTES = 16_384
const KIND_PATTERN = /^[a-z][a-z0-9.:_-]{0,127}$/u
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u
const RESULT_CODE_PATTERN = /^[a-z0-9][a-z0-9.:_-]{0,63}$/u
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const SECRET_KEY_PATTERN = /token|secret|password|passphrase|authorization|credential|api[_-]?key|bearer|private[_-]?key/iu

const CATEGORIES = new Set<CompensationCategory>([
  'revert',
  'delete',
  'cancel',
  'notify-undo',
  'rollback-state',
  'custom',
])

const STATUSES = new Set<CompensationStatus>([
  'capturing',
  'prepared',
  'dispatched',
  'succeeded',
  'failed',
  'unknown',
])

const AUDIT_EVENTS = new Set<CompensationAuditEvent>([
  'capturing',
  'prepared',
  'dispatched',
  'settled',
  'discarded',
  'abandoned',
  'recovered',
  'replayed',
])

interface CompensationRow {
  id: string
  idempotency_key: string
  idempotency_digest: string
  forward_action_id: string | null
  kind: string
  category: CompensationCategory
  scope_digest: string | null
  source_plugin: string | null
  run_id: string | null
  step_id: string | null
  target_json: string
  metadata_json: string | null
  request_digest: string
  envelope_digest: string | null
  preimage_json: string | null
  preimage_digest: string | null
  status: CompensationStatus
  result_code: string | null
  receipt_json: string | null
  receipt_digest: string | null
  reason: string | null
  expires_at: number
  created_at: number
  updated_at: number
  settled_at: number | null
  version: number
}

interface AuditRow {
  sequence: number
  compensation_id: string
  event: CompensationAuditEvent
  status: CompensationStatus
  version: number
  result_code: string | null
  detail_json: string | null
  detail_digest: string | null
  recorded_at: number
}

export interface NormalizedCompensationRequest {
  readonly idempotencyKey: string
  readonly idempotencyDigest: string
  readonly kind: string
  readonly category: CompensationCategory
  readonly target: Readonly<Record<string, unknown>>
  readonly targetJson: string
  readonly forwardActionId?: string
  readonly scopeDigest?: string
  readonly sourcePlugin?: string
  readonly runId?: string
  readonly stepId?: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly metadataJson?: string
  readonly initialPreimage?: Readonly<Record<string, unknown>>
  readonly requestDigest: string
  readonly expiresAt: number
}

export type CompensationLedgerOptions =
  | { readonly path: string; readonly now?: () => number }
  | { readonly database: DatabaseSync; readonly now?: () => number }

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0)!
    return point <= 0x1f || point === 0x7f
  })
}

function boundedText(value: unknown, field: string, maximumBytes = 500): string {
  if (typeof value !== 'string') {
    throw new RecoveryCompensationError('invalid-input', `${field} must be a string`)
  }
  const normalized = value.normalize('NFC').trim()
  if (normalized === '' || Buffer.byteLength(normalized, 'utf8') > maximumBytes || hasControlCharacter(normalized)) {
    throw new RecoveryCompensationError('invalid-input', `${field} must contain bounded printable text`)
  }
  return normalized
}

function normalizedResultCode(value: unknown, fallback = 'unknown'): string {
  if (typeof value !== 'string') return fallback
  const normalized = value.normalize('NFC').trim().toLowerCase()
  if (!RESULT_CODE_PATTERN.test(normalized)) {
    throw new RecoveryCompensationError('invalid-input', 'resultCode must be a stable low-cardinality code')
  }
  return normalized
}

function safeTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RecoveryCompensationError('invalid-input', `${field} must be a non-negative safe integer`)
  }
  return value
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function digestsEqual(left: string, right: string): boolean {
  if (!DIGEST_PATTERN.test(left) || !DIGEST_PATTERN.test(right)) return false
  const leftBytes = Buffer.from(left, 'hex')
  const rightBytes = Buffer.from(right, 'hex')
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function normalizeJsonValue(value: unknown, path: string, depth = 0): unknown {
  if (depth > 32) {
    throw new RecoveryCompensationError('invalid-input', `${path} exceeds maximum nesting depth`)
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RecoveryCompensationError('invalid-input', `${path} contains a non-finite number`)
    }
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw new RecoveryCompensationError('invalid-input', `${path} contains symbol properties`)
    }
    const items: unknown[] = []
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !('value' in descriptor) || descriptor.value === undefined) {
        throw new RecoveryCompensationError('invalid-input', `${path}[${index}] must be a defined JSON value`)
      }
      items.push(normalizeJsonValue(descriptor.value, `${path}[${index}]`, depth + 1))
    }
    return Object.freeze(items)
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new RecoveryCompensationError('invalid-input', `${path} must be a plain JSON object`)
  }
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new RecoveryCompensationError('invalid-input', `${path}.${key} uses a forbidden key`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new RecoveryCompensationError('invalid-input', `${path}.${key} cannot use accessors`)
    }
    if (descriptor.value === undefined) continue
    output[key] = normalizeJsonValue(descriptor.value, `${path}.${key}`, depth + 1)
  }
  return Object.freeze(output)
}

function normalizePlainRecord(
  value: unknown,
  field: string,
  maxBytes: number,
): { readonly value: Readonly<Record<string, unknown>>; readonly json: string; readonly digest: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RecoveryCompensationError('invalid-input', `${field} must be a plain object`)
  }
  const normalized = normalizeJsonValue(value, field) as Readonly<Record<string, unknown>>
  const json = canonicalJson(normalized)
  if (Buffer.byteLength(json, 'utf8') > maxBytes) {
    throw new RecoveryCompensationError('invalid-input', `${field} exceeds ${maxBytes} bytes`)
  }
  return {
    value: normalized,
    json,
    digest: sha256Hex(json),
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().filter(key => record[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function computeEnvelopeDigest(input: {
  readonly id: string
  readonly idempotencyDigest: string
  readonly forwardActionId: string | null
  readonly kind: string
  readonly category: CompensationCategory
  readonly scopeDigest: string | null
  readonly sourcePlugin: string | null
  readonly runId: string | null
  readonly stepId: string | null
  readonly target: Readonly<Record<string, unknown>>
  readonly metadata: Readonly<Record<string, unknown>> | null
  readonly requestDigest: string
  readonly expiresAt: number
  readonly createdAt: number
}): string {
  return sha256Hex(canonicalJson({
    id: input.id,
    idempotencyDigest: input.idempotencyDigest,
    forwardActionId: input.forwardActionId,
    kind: input.kind,
    category: input.category,
    scopeDigest: input.scopeDigest,
    sourcePlugin: input.sourcePlugin,
    runId: input.runId,
    stepId: input.stepId,
    target: input.target,
    metadata: input.metadata,
    requestDigest: input.requestDigest,
    expiresAt: input.expiresAt,
    createdAt: input.createdAt,
  }))
}

function computeScopeDigest(scope: CompensationScope): string {
  if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) {
    throw new RecoveryCompensationError('invalid-input', 'scope must be an object')
  }
  const principalId = boundedText(scope.principalId, 'scope.principalId', 256)
  const workspaceRaw = boundedText(scope.workspace, 'scope.workspace', 4096)
  if (!isAbsolute(workspaceRaw)) {
    throw new RecoveryCompensationError('invalid-input', 'scope.workspace must be absolute')
  }
  const workspace = resolve(workspaceRaw)
  const preset = boundedText(scope.preset, 'scope.preset', 256)
  const principalRecordId = scope.principalRecordId === undefined
    ? undefined
    : boundedText(scope.principalRecordId, 'scope.principalRecordId', 500)
  const principalVersion = scope.principalVersion === undefined
    ? undefined
    : (() => {
        if (!Number.isSafeInteger(scope.principalVersion) || scope.principalVersion < 1) {
          throw new RecoveryCompensationError('invalid-input', 'scope.principalVersion must be a positive safe integer')
        }
        return scope.principalVersion
      })()
  return sha256Hex(canonicalJson({
    principalId,
    workspace,
    preset,
    ...(principalRecordId === undefined ? {} : { principalRecordId }),
    ...(principalVersion === undefined ? {} : { principalVersion }),
  }))
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 32) return '[REDACTED]'
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return Object.freeze(value.map(item => redactValue(item, depth + 1)))
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    output[key] = SECRET_KEY_PATTERN.test(key)
      ? '[REDACTED]'
      : redactValue((value as Record<string, unknown>)[key], depth + 1)
  }
  return Object.freeze(output)
}

export function normalizeCompensationRequest(
  input: CompensationRecordInput,
  category: CompensationCategory,
  defaultExpiresAt: number,
): NormalizedCompensationRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new RecoveryCompensationError('invalid-input', 'compensation record must be an object')
  }
  if (!CATEGORIES.has(category)) {
    throw new RecoveryCompensationError('invalid-input', `invalid compensation category ${String(category)}`)
  }
  const idempotencyKey = boundedText(input.idempotencyKey, 'idempotencyKey', 512)
  const kind = boundedText(input.kind, 'kind', 128)
  if (!KIND_PATTERN.test(kind)) {
    throw new RecoveryCompensationError('invalid-input', 'kind must match /^[a-z][a-z0-9.:_-]{0,127}$/')
  }
  const target = normalizePlainRecord(input.target, 'target', MAX_TARGET_BYTES)
  const forwardActionId = input.forwardActionId === undefined
    ? undefined
    : boundedText(input.forwardActionId, 'forwardActionId', 512)
  const scopeDigest = input.scope === undefined ? undefined : computeScopeDigest(input.scope)
  const sourcePlugin = input.sourcePlugin === undefined
    ? undefined
    : boundedText(input.sourcePlugin, 'sourcePlugin', 256)
  const runId = input.runId === undefined ? undefined : boundedText(input.runId, 'runId', 256)
  const stepId = input.stepId === undefined ? undefined : boundedText(input.stepId, 'stepId', 256)
  const metadata = input.metadata === undefined
    ? undefined
    : normalizePlainRecord(input.metadata, 'metadata', MAX_METADATA_BYTES)
  const initialPreimage = input.preimage === undefined
    ? undefined
    : normalizePlainRecord(input.preimage, 'preimage', MAX_PREIMAGE_BYTES)
  const expiresAt = input.expiresAt === undefined
    ? safeTimestamp(defaultExpiresAt, 'expiresAt')
    : safeTimestamp(input.expiresAt, 'expiresAt')

  const canonicalPayload = canonicalJson({
    kind,
    target: target.value,
    ...(forwardActionId === undefined ? {} : { forwardActionId }),
    ...(scopeDigest === undefined ? {} : { scopeDigest }),
    ...(sourcePlugin === undefined ? {} : { sourcePlugin }),
    ...(runId === undefined ? {} : { runId }),
    ...(stepId === undefined ? {} : { stepId }),
    ...(metadata === undefined ? {} : { metadata: metadata.value }),
    ...(initialPreimage === undefined ? {} : { preimageDigest: initialPreimage.digest }),
  })

  return Object.freeze({
    idempotencyKey,
    idempotencyDigest: sha256Hex(idempotencyKey),
    kind,
    category,
    target: target.value,
    targetJson: target.json,
    ...(forwardActionId === undefined ? {} : { forwardActionId }),
    ...(scopeDigest === undefined ? {} : { scopeDigest }),
    ...(sourcePlugin === undefined ? {} : { sourcePlugin }),
    ...(runId === undefined ? {} : { runId }),
    ...(stepId === undefined ? {} : { stepId }),
    ...(metadata === undefined ? {} : { metadata: metadata.value, metadataJson: metadata.json }),
    ...(initialPreimage === undefined ? {} : { initialPreimage: initialPreimage.value }),
    requestDigest: sha256Hex(canonicalPayload),
    expiresAt,
  })
}

export function toPublicCompensationStatus(record: StoredCompensationRecord): PublicCompensationStatus {
  const redactedTarget = redactValue(record.target) as Readonly<Record<string, unknown>>
  return Object.freeze({
    id: record.id,
    idempotencyKey: record.idempotencyKey,
    ...(record.forwardActionId === undefined ? {} : { forwardActionId: record.forwardActionId }),
    kind: record.kind,
    category: record.category,
    ...(record.scopeDigest === undefined ? {} : { scopeDigest: record.scopeDigest }),
    ...(record.sourcePlugin === undefined ? {} : { sourcePlugin: record.sourcePlugin }),
    ...(record.runId === undefined ? {} : { runId: record.runId }),
    ...(record.stepId === undefined ? {} : { stepId: record.stepId }),
    target: redactedTarget,
    targetDigest: sha256Hex(canonicalJson(record.target)),
    requestDigest: record.requestDigest,
    ...(record.preimageDigest === undefined ? {} : { preimageDigest: record.preimageDigest }),
    status: record.status,
    ...(record.resultCode === undefined ? {} : { resultCode: record.resultCode }),
    ...(record.receipt === undefined ? {} : { receipt: redactValue(record.receipt) as Readonly<Record<string, unknown>> }),
    ...(record.receiptDigest === undefined ? {} : { receiptDigest: record.receiptDigest }),
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.settledAt === undefined ? {} : { settledAt: record.settledAt }),
    version: record.version,
  })
}

export class CompensationLedger {
  readonly #database: DatabaseSync
  readonly #ownsDatabase: boolean
  readonly #now: () => number

  constructor(options: CompensationLedgerOptions) {
    this.#now = options.now ?? Date.now
    if ('database' in options) {
      this.#database = options.database
      this.#ownsDatabase = false
      ensureCompensationSchema(this.#database)
    } else if (options.path === ':memory:') {
      this.#database = new DatabaseSync(':memory:')
      this.#database.exec('PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;')
      ensureCompensationSchema(this.#database)
      this.#ownsDatabase = true
    } else {
      this.#database = openRecoveryDatabase(options.path)
      this.#ownsDatabase = true
    }
  }

  prepareCapturing(input: NormalizedCompensationRequest): {
    readonly record: StoredCompensationRecord
    readonly created: boolean
  } {
    const now = this.#currentTime()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.#database
        .prepare('SELECT * FROM recovery_compensations WHERE idempotency_digest = ?')
        .get(input.idempotencyDigest) as CompensationRow | undefined
      if (existing !== undefined) {
        const stored = this.#parseRow(existing)
        if (!digestsEqual(stored.requestDigest, input.requestDigest) || stored.kind !== input.kind) {
          throw new RecoveryCompensationError(
            'idempotency-conflict',
            `compensation idempotencyKey ${input.idempotencyKey} conflicts with an existing request`,
          )
        }
        this.#database.exec('COMMIT')
        return { record: stored, created: false }
      }

      if (input.forwardActionId !== undefined) {
        const forwardRow = this.#database
          .prepare('SELECT id FROM recovery_compensations WHERE forward_action_id = ?')
          .get(input.forwardActionId) as { id: string } | undefined
        if (forwardRow !== undefined) {
          throw new RecoveryCompensationError(
            'conflict',
            `forwardActionId ${input.forwardActionId} already has an active or settled compensation`,
          )
        }
      }

      const id = `comp-${randomUUID()}`
      const envelopeDigest = computeEnvelopeDigest({
        id,
        idempotencyDigest: input.idempotencyDigest,
        forwardActionId: input.forwardActionId ?? null,
        kind: input.kind,
        category: input.category,
        scopeDigest: input.scopeDigest ?? null,
        sourcePlugin: input.sourcePlugin ?? null,
        runId: input.runId ?? null,
        stepId: input.stepId ?? null,
        target: input.target,
        metadata: input.metadata ?? null,
        requestDigest: input.requestDigest,
        expiresAt: input.expiresAt,
        createdAt: now,
      })
      this.#database.prepare(`
        INSERT INTO recovery_compensations (
          id, idempotency_key, idempotency_digest, forward_action_id, kind, category,
          scope_digest, source_plugin, run_id, step_id, target_json, metadata_json,
          request_digest, envelope_digest, preimage_json, preimage_digest, status, result_code,
          receipt_json, receipt_digest, reason, expires_at, created_at, updated_at,
          settled_at, version
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, NULL, NULL, 'capturing', NULL,
          NULL, NULL, NULL, ?, ?, ?,
          NULL, 1
        )
      `).run(
        id,
        input.idempotencyKey,
        input.idempotencyDigest,
        input.forwardActionId ?? null,
        input.kind,
        input.category,
        input.scopeDigest ?? null,
        input.sourcePlugin ?? null,
        input.runId ?? null,
        input.stepId ?? null,
        input.targetJson,
        input.metadataJson ?? null,
        input.requestDigest,
        envelopeDigest,
        input.expiresAt,
        now,
        now,
      )
      this.#appendAudit(id, 'capturing', 'capturing', 1, null, null, null, now)
      const inserted = this.#database
        .prepare('SELECT * FROM recovery_compensations WHERE id = ?')
        .get(id) as unknown as CompensationRow
      const record = this.#parseRow(inserted)
      this.#database.exec('COMMIT')
      return { record, created: true }
    } catch (error) {
      try { this.#database.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  sealPrepared(
    id: string,
    expectedVersion: number,
    preimage: Readonly<Record<string, unknown>>,
  ): StoredCompensationRecord {
    const normalizedPreimage = normalizePlainRecord(preimage, 'preimage', MAX_PREIMAGE_BYTES)
    const now = this.#currentTime()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const changed = this.#database.prepare(`
        UPDATE recovery_compensations
        SET status = 'prepared',
            preimage_json = ?,
            preimage_digest = ?,
            updated_at = ?,
            version = version + 1
        WHERE id = ? AND status = 'capturing' AND version = ?
      `).run(normalizedPreimage.json, normalizedPreimage.digest, now, id, expectedVersion)
      if (changed.changes !== 1) {
        throw new RecoveryCompensationError('invalid-state', `compensation ${id} is not in capturing state`)
      }
      this.#appendAudit(
        id,
        'prepared',
        'prepared',
        expectedVersion + 1,
        null,
        canonicalJson({ preimageDigest: normalizedPreimage.digest }),
        normalizedPreimage.digest,
        now,
      )
      const row = this.#database
        .prepare('SELECT * FROM recovery_compensations WHERE id = ?')
        .get(id) as unknown as CompensationRow
      const record = this.#parseRow(row)
      this.#database.exec('COMMIT')
      return record
    } catch (error) {
      try { this.#database.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  discardCapturing(id: string, expectedVersion: number, reasonCode = 'capture-discarded'): boolean {
    const code = normalizedResultCode(reasonCode, 'capture-discarded')
    const now = this.#currentTime()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const changed = this.#database.prepare(`
        DELETE FROM recovery_compensations
        WHERE id = ? AND status = 'capturing' AND version = ?
      `).run(id, expectedVersion)
      if (changed.changes === 1) {
        this.#appendAudit(id, 'discarded', 'capturing', expectedVersion, code, null, null, now)
      }
      this.#database.exec('COMMIT')
      return changed.changes === 1
    } catch (error) {
      try { this.#database.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  abandonPrepared(
    id: string,
    expectedVersion: number,
    reason: string,
    resultCode = 'authorization-ended-before-dispatch',
  ): StoredCompensationRecord | undefined {
    const code = normalizedResultCode(resultCode, 'authorization-ended-before-dispatch')
    const normalizedReason = boundedText(reason, 'reason', 512)
    const now = this.#currentTime()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.#database
        .prepare('SELECT * FROM recovery_compensations WHERE id = ?')
        .get(id) as CompensationRow | undefined
      if (existing === undefined) {
        this.#database.exec('COMMIT')
        return undefined
      }
      const parsed = this.#parseRow(existing)
      if (parsed.status !== 'prepared' || parsed.version !== expectedVersion) {
        this.#database.exec('COMMIT')
        return undefined
      }
      const changed = this.#database.prepare(`
        UPDATE recovery_compensations
        SET status = 'unknown',
            result_code = ?,
            reason = ?,
            updated_at = ?,
            settled_at = ?,
            version = version + 1
        WHERE id = ? AND status = 'prepared' AND version = ?
      `).run(code, normalizedReason, now, now, id, expectedVersion)
      if (changed.changes !== 1) {
        this.#database.exec('COMMIT')
        return undefined
      }
      this.#appendAudit(
        id,
        'abandoned',
        'unknown',
        expectedVersion + 1,
        code,
        canonicalJson({ reason: normalizedReason }),
        sha256Hex(normalizedReason),
        now,
      )
      const updated = this.#database
        .prepare('SELECT * FROM recovery_compensations WHERE id = ?')
        .get(id) as unknown as CompensationRow
      const record = this.#parseRow(updated)
      this.#database.exec('COMMIT')
      return record
    } catch (error) {
      try { this.#database.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  markDispatched(id: string, expectedVersion: number): StoredCompensationRecord {
    const now = this.#currentTime()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const changed = this.#database.prepare(`
        UPDATE recovery_compensations
        SET status = 'dispatched',
            updated_at = ?,
            version = version + 1
        WHERE id = ? AND status = 'prepared' AND version = ?
      `).run(now, id, expectedVersion)
      if (changed.changes !== 1) {
        throw new RecoveryCompensationError('invalid-state', `compensation ${id} is not in prepared state`)
      }
      this.#appendAudit(id, 'dispatched', 'dispatched', expectedVersion + 1, null, null, null, now)
      const updated = this.#database
        .prepare('SELECT * FROM recovery_compensations WHERE id = ?')
        .get(id) as unknown as CompensationRow
      const record = this.#parseRow(updated)
      this.#database.exec('COMMIT')
      return record
    } catch (error) {
      try { this.#database.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  settle(
    id: string,
    expectedVersion: number,
    outcome: {
      readonly status: CompensationTerminalStatus
      readonly resultCode: string
      readonly receipt?: Readonly<Record<string, unknown>>
      readonly reason?: string
    },
  ): StoredCompensationRecord {
    if (outcome.status !== 'succeeded' && outcome.status !== 'failed' && outcome.status !== 'unknown') {
      throw new RecoveryCompensationError('invalid-input', `invalid terminal status ${String(outcome.status)}`)
    }
    const code = normalizedResultCode(outcome.resultCode)
    const receipt = outcome.receipt === undefined
      ? undefined
      : normalizePlainRecord(outcome.receipt, 'receipt', MAX_RECEIPT_BYTES)
    const reason = outcome.reason === undefined
      ? undefined
      : boundedText(outcome.reason, 'reason', 512)
    const now = this.#currentTime()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const changed = this.#database.prepare(`
        UPDATE recovery_compensations
        SET status = ?,
            result_code = ?,
            receipt_json = ?,
            receipt_digest = ?,
            reason = ?,
            updated_at = ?,
            settled_at = ?,
            version = version + 1
        WHERE id = ? AND status = 'dispatched' AND version = ?
      `).run(
        outcome.status,
        code,
        receipt?.json ?? null,
        receipt?.digest ?? null,
        reason ?? null,
        now,
        now,
        id,
        expectedVersion,
      )
      if (changed.changes !== 1) {
        throw new RecoveryCompensationError('invalid-state', `compensation ${id} is not in dispatched state`)
      }
      const detail = receipt
        ? canonicalJson({ resultCode: code, receiptDigest: receipt.digest })
        : canonicalJson({ resultCode: code })
      this.#appendAudit(
        id,
        'settled',
        outcome.status,
        expectedVersion + 1,
        code,
        detail,
        receipt?.digest ?? sha256Hex(detail),
        now,
      )
      const updated = this.#database
        .prepare('SELECT * FROM recovery_compensations WHERE id = ?')
        .get(id) as unknown as CompensationRow
      const record = this.#parseRow(updated)
      this.#database.exec('COMMIT')
      return record
    } catch (error) {
      try { this.#database.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  recordReplayAudit(record: StoredCompensationRecord): void {
    const now = this.#currentTime()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#appendAudit(
        record.id,
        'replayed',
        record.status,
        record.version,
        record.resultCode ?? null,
        null,
        null,
        now,
      )
      this.#database.exec('COMMIT')
    } catch (error) {
      try { this.#database.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  recoverIncomplete(): { readonly discardedCapturing: number; readonly terminalizedUnknown: number } {
    const now = this.#currentTime()
    let discardedCapturing = 0
    let terminalizedUnknown = 0
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const rows = this.#database
        .prepare("SELECT * FROM recovery_compensations WHERE status IN ('capturing', 'prepared', 'dispatched')")
        .all() as unknown as CompensationRow[]
      for (const row of rows) {
        const parsed = this.#parseRow(row)
        if (parsed.status === 'capturing') {
          const deleted = this.#database
            .prepare("DELETE FROM recovery_compensations WHERE id = ? AND status = 'capturing' AND version = ?")
            .run(parsed.id, parsed.version)
          if (deleted.changes === 1) {
            discardedCapturing += 1
            this.#appendAudit(
              parsed.id,
              'discarded',
              'capturing',
              parsed.version,
              'recovery-discarded-capturing',
              null,
              null,
              now,
            )
          }
        } else {
          const updated = this.#database.prepare(`
            UPDATE recovery_compensations
            SET status = 'unknown',
                result_code = 'recovery-crash-no-replay',
                reason = 'process-restarted-before-settlement',
                updated_at = ?,
                settled_at = ?,
                version = version + 1
            WHERE id = ? AND status IN ('prepared', 'dispatched') AND version = ?
          `).run(now, now, parsed.id, parsed.version)
          if (updated.changes === 1) {
            terminalizedUnknown += 1
            this.#appendAudit(
              parsed.id,
              'recovered',
              'unknown',
              parsed.version + 1,
              'recovery-crash-no-replay',
              canonicalJson({ priorStatus: parsed.status }),
              sha256Hex(parsed.status),
              now,
            )
          }
        }
      }
      this.#database.exec('COMMIT')
      return Object.freeze({ discardedCapturing, terminalizedUnknown })
    } catch (error) {
      try { this.#database.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  getStoredById(id: string): StoredCompensationRecord | undefined {
    const normalizedId = boundedText(id, 'id', 256)
    const row = this.#database
      .prepare('SELECT * FROM recovery_compensations WHERE id = ?')
      .get(normalizedId) as CompensationRow | undefined
    return row === undefined ? undefined : this.#parseRow(row)
  }

  getStoredByIdempotencyKey(idempotencyKey: string): StoredCompensationRecord | undefined {
    const normalizedKey = boundedText(idempotencyKey, 'idempotencyKey', 512)
    const keyDigest = sha256Hex(normalizedKey)
    const row = this.#database
      .prepare('SELECT * FROM recovery_compensations WHERE idempotency_digest = ?')
      .get(keyDigest) as CompensationRow | undefined
    return row === undefined ? undefined : this.#parseRow(row)
  }

  getById(id: string): PublicCompensationStatus | undefined {
    const stored = this.getStoredById(id)
    return stored === undefined ? undefined : toPublicCompensationStatus(stored)
  }

  getByIdempotencyKey(idempotencyKey: string): PublicCompensationStatus | undefined {
    const stored = this.getStoredByIdempotencyKey(idempotencyKey)
    return stored === undefined ? undefined : toPublicCompensationStatus(stored)
  }

  list(filter: CompensationQueryFilter = {}): readonly PublicCompensationStatus[] {
    const clauses: string[] = []
    const params: (string | number)[] = []
    if (filter.kind !== undefined) {
      clauses.push('kind = ?')
      params.push(boundedText(filter.kind, 'filter.kind', 128))
    }
    if (filter.status !== undefined) {
      if (!STATUSES.has(filter.status)) {
        throw new RecoveryCompensationError('invalid-input', `invalid status filter ${String(filter.status)}`)
      }
      clauses.push('status = ?')
      params.push(filter.status)
    }
    if (filter.runId !== undefined) {
      clauses.push('run_id = ?')
      params.push(boundedText(filter.runId, 'filter.runId', 256))
    }
    if (filter.sourcePlugin !== undefined) {
      clauses.push('source_plugin = ?')
      params.push(boundedText(filter.sourcePlugin, 'filter.sourcePlugin', 256))
    }
    const rawLimit = filter.limit ?? 100
    if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 1_000) {
      throw new RecoveryCompensationError('invalid-input', 'filter.limit must be an integer between 1 and 1000')
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    params.push(rawLimit)
    const rows = this.#database
      .prepare(`SELECT * FROM recovery_compensations ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params) as unknown as CompensationRow[]
    return Object.freeze(rows.map(row => toPublicCompensationStatus(this.#parseRow(row))))
  }

  listAudit(compensationId: string): readonly CompensationAuditEntry[] {
    const id = boundedText(compensationId, 'compensationId', 256)
    const rows = this.#database.prepare(`
      SELECT sequence, compensation_id, event, status, version, result_code,
             detail_json, detail_digest, recorded_at
      FROM recovery_compensation_audit
      WHERE compensation_id = ?
      ORDER BY sequence ASC
    `).all(id) as unknown as AuditRow[]
    return Object.freeze(rows.map((row) => {
      if (!AUDIT_EVENTS.has(row.event) || !STATUSES.has(row.status)) {
        throw new RecoveryCompensationError('invalid-state', 'stored compensation audit entry is corrupt')
      }
      const detail = row.detail_json === null
        ? undefined
        : normalizePlainRecord(JSON.parse(row.detail_json) as unknown, 'detail_json', MAX_DETAIL_BYTES).value
      return Object.freeze({
        sequence: row.sequence,
        compensationId: row.compensation_id,
        event: row.event,
        status: row.status,
        version: row.version,
        ...(row.result_code === null ? {} : { resultCode: row.result_code }),
        ...(detail === undefined ? {} : { detail }),
        ...(row.detail_digest === null ? {} : { detailDigest: row.detail_digest }),
        recordedAt: row.recorded_at,
      })
    }))
  }

  close(): void {
    if (this.#ownsDatabase) {
      this.#database.close()
    }
  }

  #currentTime(): number {
    const now = this.#now()
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RecoveryCompensationError('invalid-state', 'compensation ledger clock is invalid')
    }
    return now
  }

  #appendAudit(
    compensationId: string,
    event: CompensationAuditEvent,
    status: CompensationStatus,
    version: number,
    resultCode: string | null,
    detailJson: string | null,
    detailDigest: string | null,
    recordedAt: number,
  ): void {
    this.#database.prepare(`
      INSERT INTO recovery_compensation_audit (
        compensation_id, event, status, version, result_code, detail_json, detail_digest, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(compensationId, event, status, version, resultCode, detailJson, detailDigest, recordedAt)
  }

  #parseRow(row: CompensationRow): StoredCompensationRecord {
    try {
      if (!CATEGORIES.has(row.category) || !STATUSES.has(row.status)) {
        throw new RecoveryCompensationError('invalid-state', 'stored compensation status or category is corrupt')
      }
      const id = boundedText(row.id, 'id', 256)
      if (id !== row.id) {
        throw new RecoveryCompensationError('invalid-state', 'stored compensation id is corrupt')
      }
      const idempotencyKey = boundedText(row.idempotency_key, 'idempotency_key', 512)
      if (idempotencyKey !== row.idempotency_key || !digestsEqual(sha256Hex(row.idempotency_key), row.idempotency_digest)) {
        throw new RecoveryCompensationError('invalid-state', 'stored idempotency digest mismatch')
      }
      const forwardActionId = row.forward_action_id === null ? undefined : boundedText(row.forward_action_id, 'forward_action_id', 512)
      if (forwardActionId !== undefined && forwardActionId !== row.forward_action_id) {
        throw new RecoveryCompensationError('invalid-state', 'stored forward_action_id is corrupt')
      }
      const kind = boundedText(row.kind, 'kind', 128)
      if (kind !== row.kind || !KIND_PATTERN.test(kind)) {
        throw new RecoveryCompensationError('invalid-state', 'stored kind is corrupt')
      }
      if (row.scope_digest !== null && (typeof row.scope_digest !== 'string' || !DIGEST_PATTERN.test(row.scope_digest))) {
        throw new RecoveryCompensationError('invalid-state', 'stored scope digest is corrupt')
      }
      const scopeDigest = row.scope_digest ?? undefined
      const sourcePlugin = row.source_plugin === null ? undefined : boundedText(row.source_plugin, 'source_plugin', 256)
      if (sourcePlugin !== undefined && sourcePlugin !== row.source_plugin) {
        throw new RecoveryCompensationError('invalid-state', 'stored source_plugin is corrupt')
      }
      const runId = row.run_id === null ? undefined : boundedText(row.run_id, 'run_id', 256)
      if (runId !== undefined && runId !== row.run_id) {
        throw new RecoveryCompensationError('invalid-state', 'stored run_id is corrupt')
      }
      const stepId = row.step_id === null ? undefined : boundedText(row.step_id, 'step_id', 256)
      if (stepId !== undefined && stepId !== row.step_id) {
        throw new RecoveryCompensationError('invalid-state', 'stored step_id is corrupt')
      }
      const target = normalizePlainRecord(JSON.parse(row.target_json) as unknown, 'target_json', MAX_TARGET_BYTES)
      const metadata = row.metadata_json === null
        ? undefined
        : normalizePlainRecord(JSON.parse(row.metadata_json) as unknown, 'metadata_json', MAX_METADATA_BYTES)
      const expiresAt = safeTimestamp(row.expires_at, 'expires_at')
      const createdAt = safeTimestamp(row.created_at, 'created_at')
      const updatedAt = safeTimestamp(row.updated_at, 'updated_at')
      if (typeof row.version !== 'number' || !Number.isSafeInteger(row.version) || row.version < 1) {
        throw new RecoveryCompensationError('invalid-state', 'stored version is corrupt')
      }
      if (typeof row.request_digest !== 'string' || !DIGEST_PATTERN.test(row.request_digest)) {
        throw new RecoveryCompensationError('invalid-state', 'stored request digest is corrupt')
      }
      if (typeof row.envelope_digest !== 'string' || !DIGEST_PATTERN.test(row.envelope_digest)) {
        throw new RecoveryCompensationError('invalid-state', 'stored envelope digest is corrupt')
      }
      const expectedEnvelopeDigest = computeEnvelopeDigest({
        id,
        idempotencyDigest: row.idempotency_digest,
        forwardActionId: forwardActionId ?? null,
        kind,
        category: row.category,
        scopeDigest: scopeDigest ?? null,
        sourcePlugin: sourcePlugin ?? null,
        runId: runId ?? null,
        stepId: stepId ?? null,
        target: target.value,
        metadata: metadata?.value ?? null,
        requestDigest: row.request_digest,
        expiresAt,
        createdAt,
      })
      if (!digestsEqual(expectedEnvelopeDigest, row.envelope_digest)) {
        throw new RecoveryCompensationError('invalid-state', 'stored compensation envelope digest mismatch')
      }

      let preimage: Readonly<Record<string, unknown>> | undefined
      let preimageDigest: string | undefined
      if (row.status === 'capturing') {
        if (row.preimage_json !== null || row.preimage_digest !== null) {
          throw new RecoveryCompensationError('invalid-state', 'capturing row must not hold preimage')
        }
      } else {
        if (row.preimage_json === null || row.preimage_digest === null) {
          throw new RecoveryCompensationError('invalid-state', 'sealed compensation row is missing preimage')
        }
        const parsedPreimage = normalizePlainRecord(
          JSON.parse(row.preimage_json) as unknown,
          'preimage_json',
          MAX_PREIMAGE_BYTES,
        )
        if (!digestsEqual(parsedPreimage.digest, row.preimage_digest)) {
          throw new RecoveryCompensationError('invalid-state', 'stored preimage digest mismatch')
        }
        preimage = parsedPreimage.value
        preimageDigest = row.preimage_digest
      }

      const isTerminal = row.status === 'succeeded' || row.status === 'failed' || row.status === 'unknown'
      let settledAt: number | undefined
      let resultCode: string | undefined
      if (isTerminal) {
        if (typeof row.result_code !== 'string' || !RESULT_CODE_PATTERN.test(row.result_code)) {
          throw new RecoveryCompensationError('invalid-state', 'terminal compensation row is missing valid result_code')
        }
        if (row.settled_at === null) {
          throw new RecoveryCompensationError('invalid-state', 'terminal compensation row is missing settled_at')
        }
        resultCode = row.result_code
        settledAt = safeTimestamp(row.settled_at, 'settled_at')
      } else {
        if (row.result_code !== null || row.settled_at !== null || row.receipt_json !== null || row.receipt_digest !== null) {
          throw new RecoveryCompensationError('invalid-state', 'non-terminal compensation row has terminal fields')
        }
      }

      let receipt: Readonly<Record<string, unknown>> | undefined
      let receiptDigest: string | undefined
      if (row.receipt_json !== null) {
        if (row.receipt_digest === null) {
          throw new RecoveryCompensationError('invalid-state', 'stored receipt digest missing')
        }
        const parsedReceipt = normalizePlainRecord(
          JSON.parse(row.receipt_json) as unknown,
          'receipt_json',
          MAX_RECEIPT_BYTES,
        )
        if (!digestsEqual(parsedReceipt.digest, row.receipt_digest)) {
          throw new RecoveryCompensationError('invalid-state', 'stored receipt digest mismatch')
        }
        receipt = parsedReceipt.value
        receiptDigest = row.receipt_digest
      } else if (row.receipt_digest !== null) {
        throw new RecoveryCompensationError('invalid-state', 'stored receipt_json missing for receipt_digest')
      }

      const reason = row.reason === null ? undefined : boundedText(row.reason, 'reason', 512)

      return Object.freeze({
        id,
        idempotencyKey,
        idempotencyDigest: row.idempotency_digest,
        ...(forwardActionId === undefined ? {} : { forwardActionId }),
        kind,
        category: row.category,
        ...(scopeDigest === undefined ? {} : { scopeDigest }),
        ...(sourcePlugin === undefined ? {} : { sourcePlugin }),
        ...(runId === undefined ? {} : { runId }),
        ...(stepId === undefined ? {} : { stepId }),
        target: target.value,
        ...(metadata === undefined ? {} : { metadata: metadata.value }),
        requestDigest: row.request_digest,
        ...(preimage === undefined ? {} : { preimage }),
        ...(preimageDigest === undefined ? {} : { preimageDigest }),
        status: row.status,
        ...(resultCode === undefined ? {} : { resultCode }),
        ...(receipt === undefined ? {} : { receipt }),
        ...(receiptDigest === undefined ? {} : { receiptDigest }),
        ...(reason === undefined ? {} : { reason }),
        expiresAt,
        createdAt,
        updatedAt,
        ...(settledAt === undefined ? {} : { settledAt }),
        version: row.version,
      })
    } catch (error) {
      if (error instanceof RecoveryCompensationError && error.code === 'invalid-state') throw error
      throw new RecoveryCompensationError('invalid-state', 'stored compensation row is corrupt')
    }
  }
}
