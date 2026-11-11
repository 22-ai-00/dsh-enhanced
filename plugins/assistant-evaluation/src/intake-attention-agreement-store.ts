import type { DatabaseSync } from 'node:sqlite'
import type {
  IntakeAttentionAgreementCell,
  IntakeAttentionAgreementSnapshot,
  IntakeAttentionAgreementSnapshotContent,
} from './intake-attention-agreement.js'
import {
  INTAKE_ATTENTION_AGREEMENT_SNAPSHOT_PROTOCOL,
  INTAKE_ATTENTION_AGREEMENT_SNAPSHOT_VERSION,
  intakeAttentionAgreementSnapshotDigest,
} from './intake-attention-agreement.js'
import { canonicalEvaluationScope, EvaluationStoreError } from './store.js'
import type { EvaluationScope } from './types.js'
import { notificationOutcomes } from './types.js'

/**
 * WP22 E1 durable side of the intake/attention agreement.
 *
 * Append-only and read-only for consumers: a row is one immutable observation
 * of one scope/bucket. The same digest inside one window replays the existing
 * row; a changed digest (late owner outcome revision) appends a new row. This
 * ledger never sends, adopts parameters, authorizes intake/auto or changes any
 * existing read model. Schema and triggers live in `sqlite.ts` (schema 18).
 */

export interface StoredIntakeAttentionAgreementSnapshot extends IntakeAttentionAgreementSnapshot {
  /** Monotone append order; newest snapshots have the largest sequence. */
  readonly sequence: number
}

export interface IntakeAttentionAgreementRecordResult {
  readonly record: StoredIntakeAttentionAgreementSnapshot
  /** True when the exact same window/digest already existed and nothing was written. */
  readonly replayed: boolean
}

interface Row {
  sequence: number
  scope_key: string
  workspace: string
  preset: string
  from_notified_at: number
  to_notified_at: number
  computed_at: number
  window_ms: number
  scan_limit: number
  truncated: number
  provenance_available: number
  not_intake: number
  unresolved: number
  foreign_count: number
  intake_json: string
  by_level_json: string
  snapshot_json: string
  digest: string
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[key])
    Object.freeze(value)
  }
  return value
}

/**
 * Structural and arithmetic validation for one count cell. Stored rows and the
 * write path use the same predicate so a hand-built or corrupted `byLevel`
 * cell cannot enter the append-only ledger as a poison row.
 */
function isCell(value: unknown): value is IntakeAttentionAgreementCell {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const cell = value as Record<string, unknown>
  const outcomes = cell['outcomes']
  if (outcomes === null || typeof outcomes !== 'object' || Array.isArray(outcomes)) return false
  const keys = Object.keys(outcomes)
  if (keys.length !== notificationOutcomes.length || notificationOutcomes.some(outcome => !keys.includes(outcome))) return false
  const count = (key: string): number | undefined => {
    const candidate = (outcomes as Record<string, unknown>)[key]
    return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : undefined
  }
  const counts = notificationOutcomes.map(outcome => count(outcome))
  if (counts.some(value => value === undefined)) return false
  const notifications = cell['notifications'], items = cell['items'], agreed = cell['agreed'], disagreed = cell['disagreed']
  const ppm = cell['agreementPpm']
  const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  if (!integer(notifications) || !integer(items) || !integer(agreed) || !integer(disagreed)
    || (ppm !== null && !(integer(ppm) && ppm <= 1_000_000))) return false
  const total = (counts as number[]).reduce((sum, value) => sum + value, 0)
  const decided = agreed + disagreed
  return total === notifications && items <= notifications
    && agreed === count('accepted')! + count('reacted')!
    && disagreed === count('rejected')! + count('expired-unhandled')!
    && ppm === (decided === 0 ? null : Math.round(agreed * 1_000_000 / decided))
}

function content(row: Row): IntakeAttentionAgreementSnapshotContent {
  let parsed: unknown
  try { parsed = JSON.parse(row.snapshot_json) } catch {
    throw new EvaluationStoreError('invalid-input', 'stored intake attention agreement snapshot is invalid')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EvaluationStoreError('invalid-input', 'stored intake attention agreement snapshot is invalid')
  }
  const snapshot = parsed as Record<string, unknown>
  const scope = snapshot['scope'] as Record<string, unknown> | undefined
  const intake = snapshot['intake']
  const byLevel = snapshot['byLevel']
  if (snapshot['protocol'] !== INTAKE_ATTENTION_AGREEMENT_SNAPSHOT_PROTOCOL
    || snapshot['snapshotVersion'] !== INTAKE_ATTENTION_AGREEMENT_SNAPSHOT_VERSION
    || snapshot['causal'] !== false
    || scope === undefined || typeof scope['workspace'] !== 'string' || typeof scope['preset'] !== 'string'
    || scope['workspace'] !== row.workspace || scope['preset'] !== row.preset
    || row.scope_key !== JSON.stringify([row.workspace, row.preset])
    || snapshot['fromNotifiedAt'] !== row.from_notified_at || snapshot['toNotifiedAt'] !== row.to_notified_at
    || snapshot['windowMs'] !== row.window_ms || snapshot['scanLimit'] !== row.scan_limit
    || snapshot['truncated'] !== (row.truncated === 1) || snapshot['provenanceAvailable'] !== (row.provenance_available === 1)
    || snapshot['notIntake'] !== row.not_intake || snapshot['unresolved'] !== row.unresolved || snapshot['foreign'] !== row.foreign_count
    || !isCell(intake)
    || byLevel === null || typeof byLevel !== 'object' || Array.isArray(byLevel)
    || Object.entries(byLevel as Record<string, unknown>).some(([level, cell]) => !['ignore', 'digest', 'notify', 'accept'].includes(level) || !isCell(cell))) {
    throw new EvaluationStoreError('invalid-input', 'stored intake attention agreement snapshot is invalid')
  }
  const { computedAt: _computedAt, digest: _storedDigest, ...validated } = snapshot as unknown as IntakeAttentionAgreementSnapshot
  if (intakeAttentionAgreementSnapshotDigest(validated as IntakeAttentionAgreementSnapshotContent) !== row.digest) {
    throw new EvaluationStoreError('invalid-input', 'stored intake attention agreement digest does not match its content')
  }
  return validated as IntakeAttentionAgreementSnapshotContent
}

function stored(row: Row): StoredIntakeAttentionAgreementSnapshot {
  return deepFreeze({ ...content(row), computedAt: row.computed_at, digest: row.digest, sequence: row.sequence })
}

export class IntakeAttentionAgreementLedger {
  readonly #database: DatabaseSync

  constructor(database: DatabaseSync) {
    this.#database = database
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

  /**
   * Append one snapshot unless the exact (scope, window, digest) already
   * exists. A replay returns the first stored row and writes nothing.
   */
  record(scopeInput: EvaluationScope, snapshot: IntakeAttentionAgreementSnapshot): IntakeAttentionAgreementRecordResult {
    const { scope, scopeKey } = canonicalEvaluationScope(scopeInput)
    if (snapshot.protocol !== INTAKE_ATTENTION_AGREEMENT_SNAPSHOT_PROTOCOL
      || snapshot.snapshotVersion !== INTAKE_ATTENTION_AGREEMENT_SNAPSHOT_VERSION || snapshot.causal !== false
      || snapshot.scope.workspace !== scope.workspace || snapshot.scope.preset !== scope.preset
      || !Number.isSafeInteger(snapshot.fromNotifiedAt) || snapshot.fromNotifiedAt < 0
      || !Number.isSafeInteger(snapshot.toNotifiedAt) || snapshot.toNotifiedAt <= snapshot.fromNotifiedAt
      || !Number.isSafeInteger(snapshot.computedAt) || snapshot.computedAt < 0
      || !Number.isSafeInteger(snapshot.windowMs) || snapshot.windowMs < 60_000
      || !Number.isSafeInteger(snapshot.scanLimit) || snapshot.scanLimit < 1
      || typeof snapshot.truncated !== 'boolean' || typeof snapshot.provenanceAvailable !== 'boolean'
      || !Number.isSafeInteger(snapshot.notIntake) || snapshot.notIntake < 0
      || !Number.isSafeInteger(snapshot.unresolved) || snapshot.unresolved < 0
      || !Number.isSafeInteger(snapshot.foreign) || snapshot.foreign < 0
      || !isCell(snapshot.intake) || !/^[a-f0-9]{64}$/u.test(snapshot.digest)
      || snapshot.byLevel === null || typeof snapshot.byLevel !== 'object' || Array.isArray(snapshot.byLevel)) {
      throw new EvaluationStoreError('invalid-input', 'intake attention agreement snapshot is invalid')
    }
    const byLevelEntries = Object.entries(snapshot.byLevel as Record<string, unknown>)
    if (byLevelEntries.some(([level, cell]) => !['ignore', 'digest', 'notify', 'accept'].includes(level) || !isCell(cell))
      || byLevelEntries.reduce((sum: number, [, cell]) => sum + (isCell(cell) ? cell.notifications : 0), 0) !== snapshot.intake.notifications) {
      throw new EvaluationStoreError('invalid-input', 'intake attention agreement snapshot is invalid')
    }
    const { computedAt: _computedAt, digest: _digest, ...rest } = snapshot
    const contentValue = rest as IntakeAttentionAgreementSnapshotContent
    if (intakeAttentionAgreementSnapshotDigest(contentValue) !== snapshot.digest) {
      throw new EvaluationStoreError('invalid-input', 'intake attention agreement snapshot digest does not match its content')
    }
    return this.#transaction(() => {
      const existing = this.#database.prepare(`SELECT * FROM evaluation_intake_attention_agreement
        WHERE scope_key=? AND from_notified_at=? AND to_notified_at=? AND digest=?`)
        .get(scopeKey, snapshot.fromNotifiedAt, snapshot.toNotifiedAt, snapshot.digest) as unknown as Row | undefined
      if (existing !== undefined) return { record: stored(existing), replayed: true }
      const intakeJson = JSON.stringify(snapshot.intake), byLevelJson = JSON.stringify(snapshot.byLevel)
      this.#database.prepare(`INSERT INTO evaluation_intake_attention_agreement(
        scope_key, workspace, preset, from_notified_at, to_notified_at, computed_at, window_ms, scan_limit,
        truncated, provenance_available, not_intake, unresolved, foreign_count, intake_json, by_level_json, snapshot_json, digest)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        scopeKey, scope.workspace, scope.preset, snapshot.fromNotifiedAt, snapshot.toNotifiedAt, snapshot.computedAt,
        snapshot.windowMs, snapshot.scanLimit, snapshot.truncated ? 1 : 0, snapshot.provenanceAvailable ? 1 : 0,
        snapshot.notIntake, snapshot.unresolved, snapshot.foreign, intakeJson, byLevelJson, JSON.stringify(snapshot), snapshot.digest)
      const inserted = this.#database.prepare('SELECT * FROM evaluation_intake_attention_agreement WHERE rowid = last_insert_rowid()')
        .get() as unknown as Row
      return { record: stored(inserted), replayed: false }
    })
  }

  /** Newest-first immutable snapshots for one scope. */
  list(scopeInput: EvaluationScope, limit: number): readonly StoredIntakeAttentionAgreementSnapshot[] {
    const { scopeKey } = canonicalEvaluationScope(scopeInput)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new EvaluationStoreError('invalid-input', 'intake attention agreement history limit must be between 1 and 100')
    }
    const rows = this.#database.prepare(`SELECT * FROM evaluation_intake_attention_agreement
      WHERE scope_key=? ORDER BY sequence DESC LIMIT ?`).all(scopeKey, limit) as unknown as Row[]
    return Object.freeze(rows.map(stored))
  }

}
