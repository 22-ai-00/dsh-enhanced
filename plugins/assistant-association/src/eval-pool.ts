import type { DatabaseSync } from 'node:sqlite'
import type {
  EvaluationEvidenceRef,
  TrustedTaskLearningProjectionReceipt,
} from '@dsh-enhanced/assistant-evaluation'
import { extractEntities } from './entities.js'
import { DEFAULT_HOLDOUT_RATE_BPS, evaluateHoldout } from './holdout.js'

const HEX_64_RE = /^[0-9a-f]{64}$/iu

export type EvalPoolKind = 'replay' | 'holdout'
export type EvalPoolStatus = 'active' | 'retracted'

export type EvalPoolErrorCode = 'missing-holdout-seed' | 'invalid-input'

export class EvalPoolError extends Error {
  constructor(
    readonly code: EvalPoolErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'EvalPoolError'
  }
}

export interface EvalPoolVerifierAcceptedTask {
  readonly contract: {
    readonly id: string
    readonly digest: string
    readonly scope: {
      readonly workspace: string
      readonly preset: string
    }
  }
  readonly state: 'awaiting-execution' | 'pending' | 'verifying' | 'done' | 'needs-attention'
  readonly receipt: {
    readonly id: string
    readonly contractId?: string
    readonly contractDigest?: string
    readonly digest: string
    readonly scope?: {
      readonly workspace: string
      readonly preset: string
    }
  } | null
}

export interface EvalPoolVerifierPeer {
  inspectAcceptedTask(contractId: string): EvalPoolVerifierAcceptedTask | null
}

export interface EvalPoolEntry {
  readonly taskId: string
  readonly ownerScopeKey: string
  readonly subjectKind: string
  readonly subjectRef: string
  readonly poolKind: EvalPoolKind
  readonly inHoldout: boolean
  readonly objectiveStatus: string | null
  readonly contractRef: string
  readonly contractDigest: string
  readonly receiptRef: string
  readonly receiptDigest: string
  readonly projectionVersion: number
  readonly projectionDigest: string
  readonly entities: readonly string[]
  readonly toolNames: readonly string[]
  readonly status: EvalPoolStatus
  readonly occurredAt: number
  readonly updatedAt: number
}

export type EvalPoolIneligibleReason =
  | 'projection-retracted'
  | 'missing-acceptance-contract'
  | 'missing-verification-receipt'
  | 'missing-verifier-provenance'
  | 'verifier-mismatch'
  | 'verifier-not-found'
  | 'stale-version'

export type EvalPoolEligibilityResult =
  | {
      readonly eligible: true
      readonly contractRef: string
      readonly contractDigest: string
      readonly receiptRef: string
      readonly receiptDigest: string
    }
  | {
      readonly eligible: false
      readonly reason: EvalPoolIneligibleReason
    }

export function ensureEvalPoolSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assoc_eval_pool (
      task_id TEXT PRIMARY KEY,
      owner_scope_key TEXT NOT NULL,
      subject_kind TEXT NOT NULL,
      subject_ref TEXT NOT NULL,
      pool_kind TEXT NOT NULL CHECK (pool_kind IN ('replay', 'holdout')),
      in_holdout INTEGER NOT NULL CHECK (in_holdout IN (0, 1)),
      objective_status TEXT,
      contract_ref TEXT NOT NULL,
      contract_digest TEXT NOT NULL,
      receipt_ref TEXT NOT NULL,
      receipt_digest TEXT NOT NULL,
      projection_version INTEGER NOT NULL,
      projection_digest TEXT NOT NULL,
      entities_json TEXT NOT NULL,
      tool_names_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'retracted')),
      occurred_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS assoc_eval_pool_scope_status_pool
      ON assoc_eval_pool(owner_scope_key, status, pool_kind, occurred_at DESC);
  `)
}

function hasTable(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { ok: number } | undefined
  return row !== undefined
}

function findValidEvidence(
  evidenceList: readonly EvaluationEvidenceRef[],
  kind: 'acceptance-contract' | 'verification-receipt',
): { readonly ref: string; readonly digest: string } | null {
  for (const item of evidenceList) {
    if (item.kind !== kind) continue
    if (typeof item.ref !== 'string' || item.ref.trim().length === 0) continue
    if (typeof item.digest !== 'string' || !HEX_64_RE.test(item.digest)) continue
    return {
      ref: item.ref.trim(),
      digest: item.digest.toLowerCase(),
    }
  }
  return null
}

function collectReceiptEvidence(
  receipt: TrustedTaskLearningProjectionReceipt,
): EvaluationEvidenceRef[] {
  const combined: EvaluationEvidenceRef[] = []
  if (Array.isArray(receipt.objective?.evidence)) {
    combined.push(...receipt.objective.evidence)
  }
  if (Array.isArray(receipt.execution?.evidence)) {
    combined.push(...receipt.execution.evidence)
  }
  return combined
}

export function evaluateEvalPoolEligibility(
  receipt: TrustedTaskLearningProjectionReceipt,
  options?: {
    readonly assistantVerifier?: EvalPoolVerifierPeer
    readonly requireVerifierInspection?: boolean
  },
): EvalPoolEligibilityResult {
  if (receipt.projection.disposition !== 'upsert') {
    return Object.freeze({ eligible: false, reason: 'projection-retracted' })
  }

  const evidence = collectReceiptEvidence(receipt)
  const contract = findValidEvidence(evidence, 'acceptance-contract')
  if (contract === null) {
    return Object.freeze({ eligible: false, reason: 'missing-acceptance-contract' })
  }

  const verification = findValidEvidence(evidence, 'verification-receipt')
  if (verification === null) {
    return Object.freeze({ eligible: false, reason: 'missing-verification-receipt' })
  }

  const hasVerifierSource =
    receipt.objective?.source?.id === 'assistant-verifier' ||
    receipt.execution?.source?.id === 'assistant-verifier'

  const verifier = options?.assistantVerifier
  if (verifier !== undefined && typeof verifier.inspectAcceptedTask === 'function') {
    let inspected: EvalPoolVerifierAcceptedTask | null = null
    try {
      inspected = verifier.inspectAcceptedTask(contract.ref)
    } catch {
      inspected = null
    }

    if (inspected !== null) {
      const scopeMatches =
        inspected.contract.scope.workspace === receipt.scope.workspace &&
        inspected.contract.scope.preset === receipt.scope.preset
      const contractMatches =
        inspected.contract.id === contract.ref &&
        inspected.contract.digest.toLowerCase() === contract.digest
      const receiptMatches =
        inspected.receipt !== null &&
        inspected.receipt.id === verification.ref &&
        inspected.receipt.digest.toLowerCase() === verification.digest &&
        (inspected.receipt.contractDigest === undefined ||
          inspected.receipt.contractDigest.toLowerCase() === contract.digest)

      if (!scopeMatches || !contractMatches || !receiptMatches) {
        return Object.freeze({ eligible: false, reason: 'verifier-mismatch' })
      }
      return Object.freeze({
        eligible: true,
        contractRef: contract.ref,
        contractDigest: contract.digest,
        receiptRef: verification.ref,
        receiptDigest: verification.digest,
      })
    }

    if (!hasVerifierSource || options?.requireVerifierInspection === true) {
      return Object.freeze({ eligible: false, reason: 'verifier-not-found' })
    }
  } else if (!hasVerifierSource) {
    return Object.freeze({ eligible: false, reason: 'missing-verifier-provenance' })
  }

  return Object.freeze({
    eligible: true,
    contractRef: contract.ref,
    contractDigest: contract.digest,
    receiptRef: verification.ref,
    receiptDigest: verification.digest,
  })
}

export interface UpsertEvalPoolInput {
  readonly ownerScopeKey: string
  readonly receipt: TrustedTaskLearningProjectionReceipt
  readonly holdoutSeedKey: Buffer | null
  readonly holdoutRateBps?: number
  readonly taskId?: string
  readonly entities?: readonly string[]
  readonly toolNames?: readonly string[]
  readonly assistantVerifier?: EvalPoolVerifierPeer
  readonly requireVerifierInspection?: boolean
  readonly nowMs?: number
}

export type UpsertEvalPoolResult =
  | {
      readonly eligible: true
      readonly action: 'upserted'
      readonly entry: EvalPoolEntry
    }
  | {
      readonly eligible: false
      readonly action: 'retracted' | 'skipped'
      readonly reason: EvalPoolIneligibleReason
      readonly taskId: string
    }

function resolveTaskMetadataFromNodes(
  db: DatabaseSync,
  ownerScopeKey: string,
  taskId: string,
): { readonly entities: readonly string[]; readonly toolNames: readonly string[] } {
  if (!hasTable(db, 'assoc_nodes')) {
    return { entities: [], toolNames: [] }
  }
  const row = db
    .prepare(
      `SELECT entities_json, metadata_json
       FROM assoc_nodes
       WHERE owner_scope_key = ? AND kind = 'episode' AND source_ref = ? AND status = 'active'
       LIMIT 1`,
    )
    .get(ownerScopeKey, taskId) as
    | { entities_json: string; metadata_json: string }
    | undefined
  if (row === undefined) {
    return { entities: [], toolNames: [] }
  }
  let entities: string[] = []
  let toolNames: string[] = []
  try {
    const parsed = JSON.parse(row.entities_json) as unknown
    if (Array.isArray(parsed)) {
      entities = parsed.filter((v): v is string => typeof v === 'string')
    }
  } catch {
    entities = []
  }
  try {
    const meta = JSON.parse(row.metadata_json) as { toolNames?: unknown }
    if (Array.isArray(meta?.toolNames)) {
      toolNames = meta.toolNames.filter((v): v is string => typeof v === 'string')
    }
  } catch {
    toolNames = []
  }
  return { entities, toolNames }
}

function mergeUniqueStrings(
  primary: readonly string[],
  secondary: readonly string[],
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of [...primary, ...secondary]) {
    const trimmed = item.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

export function upsertEvalPoolFromReceipt(
  db: DatabaseSync,
  input: UpsertEvalPoolInput,
): UpsertEvalPoolResult {
  if (
    input.holdoutSeedKey === null ||
    !Buffer.isBuffer(input.holdoutSeedKey) ||
    input.holdoutSeedKey.length === 0
  ) {
    throw new EvalPoolError(
      'missing-holdout-seed',
      'eval pool: holdoutSeedKey is required to partition replay vs holdout',
    )
  }
  if (input.ownerScopeKey.trim().length === 0) {
    throw new EvalPoolError('invalid-input', 'eval pool: ownerScopeKey must be non-empty')
  }

  ensureEvalPoolSchema(db)

  const { subjectKind, subjectRef, version, digest, disposition } =
    input.receipt.projection
  const taskId = input.taskId ?? `${subjectKind}:${subjectRef}`
  const nowMs = input.nowMs ?? Date.now()

  if (disposition === 'retract') {
    retractEvalPoolTask(db, input.ownerScopeKey, taskId, {
      updatedAt: nowMs,
      projectionVersion: version,
      projectionDigest: digest,
    })
    return Object.freeze({
      eligible: false,
      action: 'retracted',
      reason: 'projection-retracted',
      taskId,
    })
  }

  const eligibility = evaluateEvalPoolEligibility(input.receipt, {
    ...(input.assistantVerifier === undefined
      ? {}
      : { assistantVerifier: input.assistantVerifier }),
    ...(input.requireVerifierInspection === undefined
      ? {}
      : { requireVerifierInspection: input.requireVerifierInspection }),
  })
  if (!eligibility.eligible) {
    return Object.freeze({
      eligible: false,
      action: 'skipped',
      reason: eligibility.reason,
      taskId,
    })
  }

  const existing = db
    .prepare(
      'SELECT projection_version FROM assoc_eval_pool WHERE task_id = ? AND owner_scope_key = ?',
    )
    .get(taskId, input.ownerScopeKey) as { projection_version: number } | undefined
  if (existing !== undefined && existing.projection_version > version) {
    return Object.freeze({
      eligible: false,
      action: 'skipped',
      reason: 'stale-version',
      taskId,
    })
  }

  const rateBps = input.holdoutRateBps ?? DEFAULT_HOLDOUT_RATE_BPS
  const holdout = evaluateHoldout(input.holdoutSeedKey, taskId, rateBps)
  const poolKind: EvalPoolKind = holdout.inHoldout ? 'holdout' : 'replay'
  const inHoldoutInt = holdout.inHoldout ? 1 : 0

  const nodeMeta = resolveTaskMetadataFromNodes(db, input.ownerScopeKey, taskId)
  const entities = mergeUniqueStrings(
    input.entities ?? [],
    mergeUniqueStrings(extractEntities(input.receipt.situation), nodeMeta.entities),
  )
  const toolNames = (
    input.toolNames !== undefined && input.toolNames.length > 0
      ? input.toolNames
      : nodeMeta.toolNames
  )
    .map((t) => t.trim())
    .filter((t) => t.length > 0)

  const objectiveStatus = input.receipt.objective?.status ?? null
  const occurredAt =
    input.receipt.objective?.occurredAt ??
    input.receipt.execution?.occurredAt ??
    nowMs

  db.prepare(`
    INSERT INTO assoc_eval_pool (
      task_id, owner_scope_key, subject_kind, subject_ref,
      pool_kind, in_holdout, objective_status,
      contract_ref, contract_digest, receipt_ref, receipt_digest,
      projection_version, projection_digest,
      entities_json, tool_names_json, status, occurred_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      owner_scope_key = excluded.owner_scope_key,
      subject_kind = excluded.subject_kind,
      subject_ref = excluded.subject_ref,
      pool_kind = excluded.pool_kind,
      in_holdout = excluded.in_holdout,
      objective_status = excluded.objective_status,
      contract_ref = excluded.contract_ref,
      contract_digest = excluded.contract_digest,
      receipt_ref = excluded.receipt_ref,
      receipt_digest = excluded.receipt_digest,
      projection_version = excluded.projection_version,
      projection_digest = excluded.projection_digest,
      entities_json = excluded.entities_json,
      tool_names_json = excluded.tool_names_json,
      status = 'active',
      occurred_at = excluded.occurred_at,
      updated_at = excluded.updated_at
  `).run(
    taskId,
    input.ownerScopeKey,
    subjectKind,
    subjectRef,
    poolKind,
    inHoldoutInt,
    objectiveStatus,
    eligibility.contractRef,
    eligibility.contractDigest,
    eligibility.receiptRef,
    eligibility.receiptDigest,
    version,
    digest,
    JSON.stringify(entities),
    JSON.stringify(toolNames),
    occurredAt,
    nowMs,
  )

  const entry: EvalPoolEntry = Object.freeze({
    taskId,
    ownerScopeKey: input.ownerScopeKey,
    subjectKind,
    subjectRef,
    poolKind,
    inHoldout: holdout.inHoldout,
    objectiveStatus,
    contractRef: eligibility.contractRef,
    contractDigest: eligibility.contractDigest,
    receiptRef: eligibility.receiptRef,
    receiptDigest: eligibility.receiptDigest,
    projectionVersion: version,
    projectionDigest: digest,
    entities: Object.freeze(entities),
    toolNames: Object.freeze(toolNames),
    status: 'active',
    occurredAt,
    updatedAt: nowMs,
  })

  return Object.freeze({
    eligible: true,
    action: 'upserted',
    entry,
  })
}

export function retractEvalPoolTask(
  db: DatabaseSync,
  ownerScopeKey: string,
  taskId: string,
  options?: {
    readonly updatedAt?: number
    readonly projectionVersion?: number
    readonly projectionDigest?: string
  },
): boolean {
  if (!hasTable(db, 'assoc_eval_pool')) return false
  const updatedAt = options?.updatedAt ?? Date.now()
  if (
    options?.projectionVersion !== undefined &&
    options?.projectionDigest !== undefined
  ) {
    const res = db
      .prepare(
        `UPDATE assoc_eval_pool
         SET status = 'retracted',
             projection_version = CASE WHEN ? >= projection_version THEN ? ELSE projection_version END,
             projection_digest = CASE WHEN ? >= projection_version THEN ? ELSE projection_digest END,
             updated_at = ?
         WHERE task_id = ? AND owner_scope_key = ?`,
      )
      .run(
        options.projectionVersion,
        options.projectionVersion,
        options.projectionVersion,
        options.projectionDigest,
        updatedAt,
        taskId,
        ownerScopeKey,
      )
    return res.changes > 0
  }

  const res = db
    .prepare(
      `UPDATE assoc_eval_pool
       SET status = 'retracted', updated_at = ?
       WHERE task_id = ? AND owner_scope_key = ?`,
    )
    .run(updatedAt, taskId, ownerScopeKey)
  return res.changes > 0
}

export function withdrawEvalPoolTask(
  db: DatabaseSync,
  ownerScopeKey: string,
  taskId: string,
  options?: {
    readonly hardDelete?: boolean
    readonly updatedAt?: number
  },
): boolean {
  if (!hasTable(db, 'assoc_eval_pool')) return false
  if (options?.hardDelete === true) {
    const res = db
      .prepare('DELETE FROM assoc_eval_pool WHERE task_id = ? AND owner_scope_key = ?')
      .run(taskId, ownerScopeKey)
    return res.changes > 0
  }
  return retractEvalPoolTask(
    db,
    ownerScopeKey,
    taskId,
    options?.updatedAt === undefined ? undefined : { updatedAt: options.updatedAt },
  )
}

interface RawEvalPoolRow {
  readonly task_id: string
  readonly owner_scope_key: string
  readonly subject_kind: string
  readonly subject_ref: string
  readonly pool_kind: EvalPoolKind
  readonly in_holdout: number
  readonly objective_status: string | null
  readonly contract_ref: string
  readonly contract_digest: string
  readonly receipt_ref: string
  readonly receipt_digest: string
  readonly projection_version: number
  readonly projection_digest: string
  readonly entities_json: string
  readonly tool_names_json: string
  readonly status: EvalPoolStatus
  readonly occurred_at: number
  readonly updated_at: number
}

function mapRawEvalPoolRow(row: RawEvalPoolRow): EvalPoolEntry {
  return Object.freeze({
    taskId: row.task_id,
    ownerScopeKey: row.owner_scope_key,
    subjectKind: row.subject_kind,
    subjectRef: row.subject_ref,
    poolKind: row.pool_kind,
    inHoldout: row.in_holdout === 1,
    objectiveStatus: row.objective_status,
    contractRef: row.contract_ref,
    contractDigest: row.contract_digest,
    receiptRef: row.receipt_ref,
    receiptDigest: row.receipt_digest,
    projectionVersion: row.projection_version,
    projectionDigest: row.projection_digest,
    entities: Object.freeze(JSON.parse(row.entities_json) as string[]),
    toolNames: Object.freeze(JSON.parse(row.tool_names_json) as string[]),
    status: row.status,
    occurredAt: row.occurred_at,
    updatedAt: row.updated_at,
  })
}

export function listEvalPool(
  db: DatabaseSync,
  ownerScopeKey: string,
  options?: {
    readonly poolKind?: EvalPoolKind
    readonly status?: EvalPoolStatus
    readonly includeRetracted?: boolean
    readonly limit?: number
  },
): EvalPoolEntry[] {
  if (!hasTable(db, 'assoc_eval_pool')) return []
  const limit = Math.max(1, Math.min(5_000, Math.trunc(options?.limit ?? 500)))
  const clauses = ['owner_scope_key = ?']
  const params: Array<string | number> = [ownerScopeKey]

  if (options?.status !== undefined) {
    clauses.push('status = ?')
    params.push(options.status)
  } else if (options?.includeRetracted !== true) {
    clauses.push("status = 'active'")
  }

  if (options?.poolKind !== undefined) {
    clauses.push('pool_kind = ?')
    params.push(options.poolKind)
  }

  params.push(limit)
  const rows = db
    .prepare(
      `SELECT * FROM assoc_eval_pool
       WHERE ${clauses.join(' AND ')}
       ORDER BY occurred_at DESC, task_id ASC
       LIMIT ?`,
    )
    .all(...params) as unknown as RawEvalPoolRow[]
  return rows.map(mapRawEvalPoolRow)
}

export function getEvalPoolTask(
  db: DatabaseSync,
  ownerScopeKey: string,
  taskId: string,
  options?: { readonly includeRetracted?: boolean },
): EvalPoolEntry | null {
  if (!hasTable(db, 'assoc_eval_pool')) return null
  const row = (
    options?.includeRetracted === true
      ? db
          .prepare(
            'SELECT * FROM assoc_eval_pool WHERE task_id = ? AND owner_scope_key = ?',
          )
          .get(taskId, ownerScopeKey)
      : db
          .prepare(
            "SELECT * FROM assoc_eval_pool WHERE task_id = ? AND owner_scope_key = ? AND status = 'active'",
          )
          .get(taskId, ownerScopeKey)
  ) as RawEvalPoolRow | undefined

  return row === undefined ? null : mapRawEvalPoolRow(row)
}
