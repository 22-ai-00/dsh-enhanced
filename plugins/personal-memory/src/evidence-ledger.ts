import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  memoryOwnerNamespaceKey,
  normalizeMemoryOwnerNamespace,
} from './store.js'
import type { MemoryOwnerNamespace } from './types.js'

const SHA_256 = /^[0-9a-f]{64}$/u
const MAX_TEXT_BYTES = 512

export interface EvidenceScope {
  namespace: MemoryOwnerNamespace
  workspace: string
  agentPreset: string
  sessionId: string
}

export interface EvidenceAnchor {
  reference: string
  eventSeq: number
  toolName: string
  callId: string
  contentDigest: string
  sourcePath: string
  sourceTargetDigest: string
  observedAt: number
}

export class MemoryEvidenceLedgerError extends Error {
  constructor(readonly code: 'conflict' | 'invalid-anchor' | 'invalid-scope', message: string) {
    super(message)
    this.name = 'MemoryEvidenceLedgerError'
  }
}

interface ScopeColumns {
  namespaceMode: MemoryOwnerNamespace['mode']
  namespaceKey: string
  principalDigest: string
  principalRecordId: string | null
  principalVersion: number | null
  headlessLineageId: string | null
  headlessLineageVersion: number | null
  workspace: string
  agentPreset: string
  sessionId: string
}

interface EvidenceRow {
  reference: string
  event_seq: number
  tool_name: string
  call_id: string
  content_digest: string
  source_path: string
  source_target_digest: string
  observed_at: number
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, nested]) => [key, stableValue(nested)]))
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

function boundedText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '' || value.normalize('NFC').trim() !== value
    || Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) {
    throw new MemoryEvidenceLedgerError('invalid-scope', `${label} is invalid`)
  }
  return value
}

function boundedAnchorText(value: unknown, label: string): string {
  try {
    return boundedText(value, label)
  } catch {
    throw new MemoryEvidenceLedgerError('invalid-anchor', `${label} is invalid`)
  }
}

function assertNonnegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new MemoryEvidenceLedgerError('invalid-anchor', `${label} is invalid`)
  }
  return value
}

function normalizeScope(scope: EvidenceScope): ScopeColumns {
  if (typeof scope !== 'object' || scope === null || typeof scope.workspace !== 'string'
    || !isAbsolute(scope.workspace)) {
    throw new MemoryEvidenceLedgerError('invalid-scope', 'evidence scope workspace is invalid')
  }
  const namespace = normalizeMemoryOwnerNamespace(scope.namespace)
  return {
    namespaceMode: namespace.mode,
    namespaceKey: memoryOwnerNamespaceKey(namespace),
    principalDigest: namespace.principalDigest,
    principalRecordId: namespace.mode === 'delivery' ? namespace.principalRecordId : null,
    principalVersion: namespace.mode === 'delivery' ? namespace.principalVersion : null,
    headlessLineageId: namespace.mode === 'headless' ? namespace.lineageId : null,
    headlessLineageVersion: namespace.mode === 'headless' ? namespace.lineageVersion : null,
    workspace: boundedText(scope.workspace, 'evidence workspace'),
    agentPreset: boundedText(scope.agentPreset, 'evidence agent preset'),
    sessionId: boundedText(scope.sessionId, 'evidence session id'),
  }
}

function normalizeAnchor(input: Omit<EvidenceAnchor, 'reference'>): Omit<EvidenceAnchor, 'reference'> {
  if (typeof input !== 'object' || input === null || typeof input.contentDigest !== 'string' || !SHA_256.test(input.contentDigest)) {
    throw new MemoryEvidenceLedgerError('invalid-anchor', 'evidence anchor content digest is invalid')
  }
  if (typeof input.sourceTargetDigest !== 'string' || !SHA_256.test(input.sourceTargetDigest)
    || typeof input.sourcePath !== 'string' || !isAbsolute(input.sourcePath)) {
    throw new MemoryEvidenceLedgerError('invalid-anchor', 'evidence filesystem origin is invalid')
  }
  return Object.freeze({
    sourcePath: boundedAnchorText(input.sourcePath, 'evidence source path'),
    sourceTargetDigest: input.sourceTargetDigest,
    eventSeq: assertNonnegativeSafeInteger(input.eventSeq, 'evidence event sequence'),
    toolName: boundedAnchorText(input.toolName, 'evidence tool name'),
    callId: boundedAnchorText(input.callId, 'evidence call id'),
    contentDigest: input.contentDigest,
    observedAt: assertNonnegativeSafeInteger(input.observedAt, 'evidence observed time'),
  })
}

function referenceFor(scope: ScopeColumns, anchor: Omit<EvidenceAnchor, 'reference'>): string {
  const canonicalScope = {
    namespace: scope.namespaceMode === 'delivery'
      ? {
        mode: scope.namespaceMode,
        principalDigest: scope.principalDigest,
        principalRecordId: scope.principalRecordId,
        principalVersion: scope.principalVersion,
      }
      : {
        mode: scope.namespaceMode,
        principalDigest: scope.principalDigest,
        lineageId: scope.headlessLineageId,
        lineageVersion: scope.headlessLineageVersion,
      },
    workspace: scope.workspace,
    agentPreset: scope.agentPreset,
    sessionId: scope.sessionId,
  }
  return `dsh-evidence:v1:${createHash('sha256').update(stableJson({ anchor, scope: canonicalScope })).digest('hex')}`
}

function anchorFromRow(row: EvidenceRow): EvidenceAnchor {
  return Object.freeze({
    reference: row.reference,
    eventSeq: row.event_seq,
    toolName: row.tool_name,
    callId: row.call_id,
    contentDigest: row.content_digest,
    sourcePath: row.source_path,
    sourceTargetDigest: row.source_target_digest,
    observedAt: row.observed_at,
  })
}

export class MemoryEvidenceLedger {
  readonly #database: DatabaseSync
  readonly #maxRows: number

  constructor(database: DatabaseSync, options: Readonly<{ maxRows?: number }> = {}) {
    this.#database = database
    this.#maxRows = options.maxRows ?? 1_000
    if (!Number.isSafeInteger(this.#maxRows) || this.#maxRows <= 0) {
      throw new MemoryEvidenceLedgerError('invalid-anchor', 'evidence row limit is invalid')
    }
  }

  record(scope: EvidenceScope, input: Omit<EvidenceAnchor, 'reference'>): EvidenceAnchor {
    const normalizedScope = normalizeScope(scope)
    const anchor = normalizeAnchor(input)
    const reference = referenceFor(normalizedScope, anchor)
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const duplicate = this.get(scope, reference)
      if (duplicate !== undefined) {
        this.#database.exec('COMMIT')
        return duplicate
      }
      const conflict = this.#database.prepare(`
        SELECT reference FROM memory_evidence_anchors
        WHERE namespace_mode = ? AND namespace_key = ? AND principal_digest = ?
          AND principal_record_id IS ? AND principal_version IS ?
          AND headless_lineage_id IS ? AND headless_lineage_version IS ?
          AND workspace = ? AND agent_preset = ?
          AND session_id = ? AND event_seq = ?
      `).get(
        normalizedScope.namespaceMode, normalizedScope.namespaceKey, normalizedScope.principalDigest,
        normalizedScope.principalRecordId, normalizedScope.principalVersion,
        normalizedScope.headlessLineageId, normalizedScope.headlessLineageVersion,
        normalizedScope.workspace, normalizedScope.agentPreset, normalizedScope.sessionId, anchor.eventSeq,
      ) as { reference: string } | undefined
      if (conflict !== undefined) {
        throw new MemoryEvidenceLedgerError('conflict', 'evidence session event sequence conflicts with immutable metadata')
      }
      this.#database.prepare(`
        INSERT INTO memory_evidence_anchors(
          reference, namespace_mode, namespace_key, principal_digest, principal_record_id, principal_version,
          headless_lineage_id, headless_lineage_version, workspace, agent_preset, session_id, event_seq,
          tool_name, call_id, content_digest, source_path, source_target_digest, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        reference, normalizedScope.namespaceMode, normalizedScope.namespaceKey, normalizedScope.principalDigest,
        normalizedScope.principalRecordId, normalizedScope.principalVersion, normalizedScope.headlessLineageId,
        normalizedScope.headlessLineageVersion, normalizedScope.workspace, normalizedScope.agentPreset,
        normalizedScope.sessionId, anchor.eventSeq, anchor.toolName, anchor.callId, anchor.contentDigest,
        anchor.sourcePath, anchor.sourceTargetDigest, anchor.observedAt,
      )
      this.#database.prepare(`
        DELETE FROM memory_evidence_anchors
        WHERE reference IN (
          SELECT reference FROM memory_evidence_anchors
          WHERE namespace_key = ? AND workspace = ? AND agent_preset = ?
          ORDER BY observed_at ASC, reference ASC
          LIMIT CASE WHEN (SELECT count(*) FROM memory_evidence_anchors
            WHERE namespace_key = ? AND workspace = ? AND agent_preset = ?) > ?
            THEN (SELECT count(*) FROM memory_evidence_anchors
              WHERE namespace_key = ? AND workspace = ? AND agent_preset = ?) - ?
            ELSE 0 END
        )
      `).run(
        normalizedScope.namespaceKey, normalizedScope.workspace, normalizedScope.agentPreset,
        normalizedScope.namespaceKey, normalizedScope.workspace, normalizedScope.agentPreset, this.#maxRows,
        normalizedScope.namespaceKey, normalizedScope.workspace, normalizedScope.agentPreset, this.#maxRows,
      )
      this.#database.exec('COMMIT')
      return Object.freeze({ reference, ...anchor })
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  list(scope: EvidenceScope, limit: number): readonly EvidenceAnchor[] {
    const normalizedScope = normalizeScope(scope)
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > this.#maxRows) {
      throw new MemoryEvidenceLedgerError('invalid-anchor', 'evidence list limit is invalid')
    }
    const rows = this.#database.prepare(`
      SELECT reference, event_seq, tool_name, call_id, content_digest, source_path, source_target_digest, observed_at
      FROM memory_evidence_anchors
      WHERE namespace_mode = ? AND namespace_key = ? AND principal_digest = ?
        AND principal_record_id IS ? AND principal_version IS ?
        AND headless_lineage_id IS ? AND headless_lineage_version IS ?
        AND workspace = ? AND agent_preset = ? AND session_id = ?
      ORDER BY observed_at DESC, reference DESC
      LIMIT ?
    `).all(
      normalizedScope.namespaceMode, normalizedScope.namespaceKey, normalizedScope.principalDigest,
      normalizedScope.principalRecordId, normalizedScope.principalVersion,
      normalizedScope.headlessLineageId, normalizedScope.headlessLineageVersion,
      normalizedScope.workspace, normalizedScope.agentPreset, normalizedScope.sessionId, limit,
    ) as unknown as EvidenceRow[]
    return Object.freeze(rows.map(row => this.checkedRow(normalizedScope, row)))
  }

  get(scope: EvidenceScope, reference: string): EvidenceAnchor | undefined {
    const normalizedScope = normalizeScope(scope)
    if (typeof reference !== 'string' || !/^dsh-evidence:v1:[0-9a-f]{64}$/u.test(reference)) {
      throw new MemoryEvidenceLedgerError('invalid-anchor', 'evidence reference is invalid')
    }
    const row = this.#database.prepare(`
      SELECT reference, event_seq, tool_name, call_id, content_digest, source_path, source_target_digest, observed_at
      FROM memory_evidence_anchors
      WHERE reference = ? AND namespace_mode = ? AND namespace_key = ? AND principal_digest = ?
        AND principal_record_id IS ? AND principal_version IS ?
        AND headless_lineage_id IS ? AND headless_lineage_version IS ?
        AND workspace = ? AND agent_preset = ? AND session_id = ?
    `).get(
      reference, normalizedScope.namespaceMode, normalizedScope.namespaceKey, normalizedScope.principalDigest,
      normalizedScope.principalRecordId, normalizedScope.principalVersion,
      normalizedScope.headlessLineageId, normalizedScope.headlessLineageVersion,
      normalizedScope.workspace, normalizedScope.agentPreset, normalizedScope.sessionId,
    ) as EvidenceRow | undefined
    return row === undefined ? undefined : this.checkedRow(normalizedScope, row)
  }

  private checkedRow(scope: ScopeColumns, row: EvidenceRow): EvidenceAnchor {
    const value = anchorFromRow(row)
    const anchor = normalizeAnchor(value)
    if (referenceFor(scope, anchor) !== value.reference) throw new MemoryEvidenceLedgerError('invalid-anchor', 'stored evidence reference does not match immutable metadata')
    return value
  }
}
