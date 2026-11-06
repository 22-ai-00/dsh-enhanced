import type { DatabaseSync } from 'node:sqlite'
import { ControlPlaneStoreError, controlPlaneDigest } from './store.js'
import type { CreationCapabilityOrdinaryUseModel, CreationCapabilityOrdinaryUseTrend,
  CreationCapabilityTrendFlag } from './creation-capability-types.js'

/** Upper bounds keep a sealed row and one listing page finite. */
export const TREND_SNAPSHOT_MAX_BYTES = 1_048_576
export const TREND_SNAPSHOT_DEFAULT_PAGE = 20
export const TREND_SNAPSHOT_MAX_PAGE = 100

const PLAN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const DIGEST = /^[a-f0-9]{64}$/u
const fail = (message: string): never => { throw new ControlPlaneStoreError('invalid-state', message) }

/**
 * Immutable, content-addressed seal of one ordinary-use trend result. Every derived field is recomputed from the
 * embedded trend on read, so the seal adds no claim beyond the trend itself: it stays observational (`causal: false`)
 * and is never adoption, promotion or revocation evidence. The digest excludes the seal time so the same trend
 * always maps to the same snapshot.
 */
export interface CreationCapabilityTrendSnapshot {
  protocol: 'dsh-created-capability-ordinary-use-trend-snapshot/v1'
  causal: false
  planId: string
  receiptDigest: string
  /** Digest of the exact fenced inputs the trend was computed from (rows, watermark, receipt and parameters). */
  inputsDigest: string
  /** Digest of the full embedded trend result. */
  trendDigest: string
  window: { windowMs: number; preWindows: number; postWindows: number
    startExclusive: number; endInclusive: number; complete: boolean }
  /** Frozen task-model strata in trend order; strata are never merged. */
  models: readonly CreationCapabilityOrdinaryUseModel[]
  flags: readonly CreationCapabilityTrendFlag[]
  trend: CreationCapabilityOrdinaryUseTrend
  digest: string
}

export interface CreationCapabilityTrendSnapshotRecord {
  /** Append order in this ledger; strictly increasing, never reused. */
  sequence: number
  sealedAt: number
  snapshot: CreationCapabilityTrendSnapshot
}

export interface CreationCapabilityTrendSnapshotPage {
  protocol: 'dsh-created-capability-ordinary-use-trend-snapshot-list/v1'
  causal: false
  /** Newest first. */
  items: readonly CreationCapabilityTrendSnapshotRecord[]
  /** Pass as `beforeSequence` for the next older page; absent on the last page. */
  nextBeforeSequence?: number
}

export interface CreationCapabilityTrendSnapshotQuery {
  planId?: string
  beforeSequence?: number
  limit?: number
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

/** Build the canonical snapshot of one trend result; pure and deterministic. */
export function createCreationCapabilityTrendSnapshot(trend: CreationCapabilityOrdinaryUseTrend): CreationCapabilityTrendSnapshot {
  if (!trend || trend.protocol !== 'dsh-created-capability-ordinary-use-trend/v1' || trend.causal !== false
    || typeof trend.planId !== 'string' || !PLAN.test(trend.planId) || !DIGEST.test(trend.receiptDigest)
    || !DIGEST.test(trend.rowsDigest) || !Array.isArray(trend.windows) || trend.windows.length === 0
    || !Array.isArray(trend.strata) || !Array.isArray(trend.flags)) {
    throw new ControlPlaneStoreError('invalid-input', 'created capability trend snapshot input is invalid')
  }
  // Round-trip once so the seal covers exactly what JSON storage can represent.
  const copy = JSON.parse(JSON.stringify(trend)) as CreationCapabilityOrdinaryUseTrend
  const windows = copy.windows
  const inputsDigest = controlPlaneDigest({ receiptDigest: copy.receiptDigest, artifactSha256: copy.artifactSha256,
    schemaDigest: copy.schemaDigest, scopeWatermark: copy.scopeWatermark, rowsDigest: copy.rowsDigest,
    windowMs: copy.windowMs, minimumSamples: copy.minimumSamples, parallelTrendThreshold: copy.parallelTrendThreshold,
    windows })
  const unsigned = { protocol: 'dsh-created-capability-ordinary-use-trend-snapshot/v1' as const, causal: false as const,
    planId: copy.planId, receiptDigest: copy.receiptDigest, inputsDigest, trendDigest: controlPlaneDigest(copy),
    window: { windowMs: copy.windowMs, preWindows: windows.filter(window => window.index < 0).length,
      postWindows: windows.filter(window => window.index >= 0).length,
      startExclusive: windows[0]!.startExclusive, endInclusive: windows[windows.length - 1]!.endInclusive,
      complete: windows.every(window => window.complete) },
    models: copy.strata.map(stratum => stratum.model), flags: [...copy.flags], trend: copy }
  return deepFreeze({ ...unsigned, digest: controlPlaneDigest(unsigned) })
}

/** Throws unless the stored value is exactly the canonical snapshot of its own embedded trend. */
export function assertCreationCapabilityTrendSnapshot(value: unknown): asserts value is CreationCapabilityTrendSnapshot {
  const snapshot = value as CreationCapabilityTrendSnapshot
  if (!snapshot || typeof snapshot !== 'object' || snapshot.protocol !== 'dsh-created-capability-ordinary-use-trend-snapshot/v1'
    || snapshot.causal !== false || !DIGEST.test(snapshot.digest)) fail('created capability trend snapshot is invalid')
  let expected: CreationCapabilityTrendSnapshot
  try { expected = createCreationCapabilityTrendSnapshot(snapshot.trend) } catch { return fail('created capability trend snapshot is invalid') }
  if (controlPlaneDigest(snapshot) !== controlPlaneDigest(expected) || snapshot.digest !== expected.digest) {
    fail('created capability trend snapshot changed')
  }
}

interface Row { sequence: number; snapshot_digest: string; plan_id: string; snapshot_json: string; sealed_at: number }

function recordFromRow(row: Row): CreationCapabilityTrendSnapshotRecord {
  if (!Number.isSafeInteger(row.sequence) || row.sequence < 1 || !Number.isSafeInteger(row.sealed_at) || row.sealed_at < 1
    || Buffer.byteLength(row.snapshot_json) > TREND_SNAPSHOT_MAX_BYTES) fail('stored created capability trend snapshot is invalid')
  let parsed: unknown
  try { parsed = JSON.parse(row.snapshot_json) } catch { return fail('stored created capability trend snapshot is invalid') }
  assertCreationCapabilityTrendSnapshot(parsed)
  if (parsed.digest !== row.snapshot_digest || parsed.planId !== row.plan_id) fail('stored created capability trend snapshot changed')
  return deepFreeze({ sequence: row.sequence, sealedAt: row.sealed_at, snapshot: parsed })
}

const COLUMNS = 'sequence,snapshot_digest,plan_id,snapshot_json,sealed_at'

/**
 * Append the snapshot unless the same digest is already sealed; an existing row is re-verified and returned unchanged.
 * Rows are never rewritten: the table rejects UPDATE and DELETE, and a stored row that no longer verifies fails closed.
 * The caller owns the surrounding writer transaction.
 */
export function sealCreationCapabilityTrendSnapshot(db: DatabaseSync, snapshot: CreationCapabilityTrendSnapshot,
  sealedAt: number): { created: boolean; record: CreationCapabilityTrendSnapshotRecord } {
  assertCreationCapabilityTrendSnapshot(snapshot)
  if (!Number.isSafeInteger(sealedAt) || sealedAt < 1) throw new ControlPlaneStoreError('invalid-input', 'trend snapshot seal time is invalid')
  const encoded = JSON.stringify(snapshot)
  if (Buffer.byteLength(encoded) > TREND_SNAPSHOT_MAX_BYTES) {
    throw new ControlPlaneStoreError('invalid-input', 'created capability trend snapshot exceeds its bound')
  }
  const prior = db.prepare(`SELECT ${COLUMNS} FROM created_capability_trend_snapshots WHERE snapshot_digest=?`)
    .get(snapshot.digest) as Row | undefined
  if (prior) return { created: false, record: recordFromRow(prior) }
  const latest = db.prepare('SELECT max(sealed_at) AS at FROM created_capability_trend_snapshots').get() as { at: number | null }
  // Seal time is not covered by the digest; keep it monotone with append order so it cannot be backdated.
  const at = Math.max(sealedAt, latest.at ?? 0)
  const inserted = db.prepare(`INSERT INTO created_capability_trend_snapshots (snapshot_digest,plan_id,snapshot_json,sealed_at)
    VALUES (?,?,?,?) RETURNING ${COLUMNS}`).get(snapshot.digest, snapshot.planId, encoded, at) as unknown as Row
  return { created: true, record: recordFromRow(inserted) }
}

/** Bounded newest-first page; every returned row is re-verified, and any tampered row in the page fails closed. */
export function listCreationCapabilityTrendSnapshots(db: DatabaseSync, query: CreationCapabilityTrendSnapshotQuery = {}):
CreationCapabilityTrendSnapshotPage {
  const limit = query.limit ?? TREND_SNAPSHOT_DEFAULT_PAGE
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TREND_SNAPSHOT_MAX_PAGE
    || (query.beforeSequence !== undefined && (!Number.isSafeInteger(query.beforeSequence) || query.beforeSequence < 1))
    || (query.planId !== undefined && (typeof query.planId !== 'string' || !PLAN.test(query.planId)))) {
    throw new ControlPlaneStoreError('invalid-input', 'created capability trend snapshot query is invalid')
  }
  const before = query.beforeSequence ?? Number.MAX_SAFE_INTEGER
  const rows = (query.planId === undefined
    ? db.prepare(`SELECT ${COLUMNS} FROM created_capability_trend_snapshots WHERE sequence<?
        ORDER BY sequence DESC LIMIT ?`).all(before, limit + 1)
    : db.prepare(`SELECT ${COLUMNS} FROM created_capability_trend_snapshots WHERE plan_id=? AND sequence<?
        ORDER BY sequence DESC LIMIT ?`).all(query.planId, before, limit + 1)) as unknown as Row[]
  const items = rows.slice(0, limit).map(recordFromRow)
  return deepFreeze({ protocol: 'dsh-created-capability-ordinary-use-trend-snapshot-list/v1' as const, causal: false as const,
    items, ...(rows.length > limit ? { nextBeforeSequence: items[items.length - 1]!.sequence } : {}) })
}
