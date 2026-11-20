import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { extractEntities } from './entities.js'
import { normalizeEntityKey, tokenizeAssociationText } from './tokenize.js'
import {
  computeDeterministicEdgeId,
  type AssociationNodeMetadata,
  type AssociationNodeStatus,
  type AssociationOwnerMode,
  type AssociationOwnerScope,
  type AssociationScopeMode,
  type AssociationSensitivity,
  type AssociationTrust,
  type DerivedRefInput,
  type EdgeType,
  type NodeKind,
  type UpsertEdgeInput,
  type UpsertNodeInput,
  type UpsertSynonymInput,
} from './types.js'

export interface AssociationDreamingConfig {
  readonly enabled?: boolean
  readonly intervalMs?: number
  readonly idleMinMs?: number
  readonly maxPairsPerRun?: number
  readonly maxAbstractionsPerRun?: number
  readonly maxSynonymsPerRun?: number
  readonly nodeTtlMs?: number
  readonly allowModelSynthesis?: boolean
  readonly budgetId?: string
  readonly budgetAmount?: number
}

export interface AssociationDreamingNormalizedConfig {
  readonly enabled: boolean
  readonly intervalMs: number
  readonly idleMinMs: number
  readonly maxPairsPerRun: number
  readonly maxAbstractionsPerRun: number
  readonly maxSynonymsPerRun: number
  readonly nodeTtlMs: number
  readonly allowModelSynthesis: boolean
  readonly budgetId?: string
  readonly budgetAmount?: number
}

export const DEFAULT_ASSOCIATION_DREAMING_CONFIG: AssociationDreamingNormalizedConfig = Object.freeze({
  enabled: false,
  intervalMs: 3_600_000,
  idleMinMs: 1_800_000,
  maxPairsPerRun: 16,
  maxAbstractionsPerRun: 4,
  maxSynonymsPerRun: 16,
  nodeTtlMs: 30 * 86_400_000,
  allowModelSynthesis: false,
})

export function normalizeAssociationDreamingConfig(
  raw?: AssociationDreamingConfig,
): AssociationDreamingNormalizedConfig {
  const intervalMs =
    typeof raw?.intervalMs === 'number' && Number.isFinite(raw.intervalMs) && raw.intervalMs >= 0
      ? Math.floor(raw.intervalMs)
      : DEFAULT_ASSOCIATION_DREAMING_CONFIG.intervalMs
  const idleMinMs =
    typeof raw?.idleMinMs === 'number' && Number.isFinite(raw.idleMinMs) && raw.idleMinMs >= 0
      ? Math.floor(raw.idleMinMs)
      : DEFAULT_ASSOCIATION_DREAMING_CONFIG.idleMinMs
  const maxPairsPerRun =
    typeof raw?.maxPairsPerRun === 'number' &&
    Number.isFinite(raw.maxPairsPerRun) &&
    raw.maxPairsPerRun >= 0
      ? Math.floor(raw.maxPairsPerRun)
      : DEFAULT_ASSOCIATION_DREAMING_CONFIG.maxPairsPerRun
  const maxAbstractionsPerRun =
    typeof raw?.maxAbstractionsPerRun === 'number' &&
    Number.isFinite(raw.maxAbstractionsPerRun) &&
    raw.maxAbstractionsPerRun >= 0
      ? Math.floor(raw.maxAbstractionsPerRun)
      : DEFAULT_ASSOCIATION_DREAMING_CONFIG.maxAbstractionsPerRun
  const maxSynonymsPerRun =
    typeof raw?.maxSynonymsPerRun === 'number' &&
    Number.isFinite(raw.maxSynonymsPerRun) &&
    raw.maxSynonymsPerRun >= 0
      ? Math.floor(raw.maxSynonymsPerRun)
      : DEFAULT_ASSOCIATION_DREAMING_CONFIG.maxSynonymsPerRun
  const nodeTtlMs =
    typeof raw?.nodeTtlMs === 'number' && Number.isFinite(raw.nodeTtlMs) && raw.nodeTtlMs >= 0
      ? Math.floor(raw.nodeTtlMs)
      : DEFAULT_ASSOCIATION_DREAMING_CONFIG.nodeTtlMs

  const normalized: AssociationDreamingNormalizedConfig = {
    enabled: raw?.enabled === true,
    intervalMs,
    idleMinMs,
    maxPairsPerRun,
    maxAbstractionsPerRun,
    maxSynonymsPerRun,
    nodeTtlMs,
    allowModelSynthesis: raw?.allowModelSynthesis === true,
    ...(typeof raw?.budgetId === 'string' && raw.budgetId.length > 0
      ? { budgetId: raw.budgetId }
      : {}),
    ...(typeof raw?.budgetAmount === 'number' &&
    Number.isFinite(raw.budgetAmount) &&
    raw.budgetAmount > 0
      ? { budgetAmount: raw.budgetAmount }
      : {}),
  }
  return Object.freeze(normalized)
}

export interface DreamingPolicyRequest {
  readonly subject: {
    readonly kind: 'background'
    readonly id: 'assistant-association:dreaming'
    readonly workspace: string
    readonly principal: string
  }
  readonly action: 'dream.build'
  readonly resource: {
    readonly kind: 'evolution'
    readonly id: 'assistant-association:dreaming'
  }
  readonly context: {
    readonly initiator: 'background'
  }
}

export interface DreamingPolicyDecision {
  readonly effect: 'allow' | 'deny'
  readonly reasonCode?: string
  readonly ruleId?: string | undefined
}

export interface DreamingPolicyPeer {
  readonly getEmergencyStop?: () => { readonly enabled: boolean }
  readonly getBudgetConfig?: (
    budgetId: string,
  ) =>
    | {
        readonly id: string
        readonly metric: string
        readonly limit: number
        readonly periodMs: number
        readonly scope: string
      }
    | undefined
  readonly evaluate?: (request: DreamingPolicyRequest) => DreamingPolicyDecision
  readonly authorize?: (
    request: DreamingPolicyRequest,
    options?: { readonly idempotencyKey?: string; readonly auditDetails?: unknown },
  ) => DreamingPolicyDecision
}

export interface DreamingDeliveryPeer {
  readonly validateOwnerRoute?: (input: {
    readonly authorityId: string
    readonly principalId: string
    readonly workspace: string
    readonly agentPreset: string
  }) => unknown
  readonly inspectOwnerRouteState?: (input: {
    readonly authorityId: string
    readonly principalId: string
    readonly workspace: string
    readonly agentPreset: string
  }) => { readonly status: string } | string
}

export type DreamIdeaState =
  | 'recorded'
  | 'withdrawn'
  | 'owner-acknowledged'
  | 'validated'
  | 'rejected'

export interface DreamIdeaRecord {
  readonly id: string
  readonly lane: string
  readonly runId: string
  readonly createdAt: number
  readonly dayKey: string
  readonly state: DreamIdeaState
  readonly summary: string
  readonly detail: string
  readonly evidenceRefs: readonly string[]
}

export type DreamingGateDenyReason =
  | 'disabled'
  | 'emergency-stop'
  | 'policy-unavailable'
  | 'policy-denied'
  | 'budget-unavailable'
  | 'route-invalid'
  | 'route-inactive'
  | 'interval-not-elapsed'
  | 'agent-active'
  | 'not-idle'

export interface DreamingGateDecision {
  readonly allowed: boolean
  readonly reason: DreamingGateDenyReason | 'ok'
  readonly policyReasonCode?: string
}

export interface CanRunDreamingInput {
  readonly db?: DatabaseSync
  readonly scope: AssociationOwnerScope
  readonly config: AssociationDreamingNormalizedConfig
  readonly policy?: DreamingPolicyPeer
  readonly delivery?: DreamingDeliveryPeer
  readonly hasRunningAgent?: boolean
  readonly lastActivityAt?: number | null
  readonly nowMs?: number
  readonly requirePolicy?: boolean
}

export interface SynthesizeDreamingOptions {
  readonly nowMs?: number
  readonly weightMin?: number
  readonly weightMax?: number
  readonly nodeLimit?: number
}

export interface SynthesizedDreamingArtifacts {
  readonly nodes: readonly UpsertNodeInput[]
  readonly edges: readonly UpsertEdgeInput[]
  readonly synonyms: readonly UpsertSynonymInput[]
  readonly derivedRefs: readonly DerivedRefInput[]
  readonly pairsCreated: number
  readonly abstractionsCreated: number
  readonly synonymsCreated: number
}

export interface ExpiredNodeCleanupTarget {
  readonly id: string
  readonly ownerScopeKey: string
  readonly sourcePlugin: string
  readonly sourceRef: string
  readonly kind: NodeKind
  readonly expiresAt: number
}

export interface DreamIdeaWithdrawalTarget {
  readonly ownerScopeKey: string
  readonly sourcePlugin: 'assistant-dreaming'
  readonly sourceRef: string
  readonly nodeId: string
}

export interface DreamIdeaProjectionResult {
  readonly upserts: readonly UpsertNodeInput[]
  readonly withdrawals: readonly DreamIdeaWithdrawalTarget[]
}

export interface DreamingWriter {
  readonly upsertBatch: (input: {
    readonly nodes: readonly UpsertNodeInput[]
    readonly edges: readonly UpsertEdgeInput[]
    readonly synonyms?: readonly UpsertSynonymInput[]
    readonly derivedRefs: readonly DerivedRefInput[]
  }) => unknown
  readonly withdrawSource?: (input: {
    readonly ownerScopeKey: string
    readonly sourcePlugin: string
    readonly sourceRef: string
    readonly hardDelete: boolean
    readonly nowMs?: number
  }) => unknown
}

export interface RunDreamingPassInput extends CanRunDreamingInput {
  readonly db: DatabaseSync
  readonly ideas?: readonly DreamIdeaRecord[]
  readonly weightMin?: number
  readonly weightMax?: number
  readonly nodeLimit?: number
  readonly writer?: DreamingWriter
}

export interface RunDreamingPassResult {
  readonly ran: boolean
  readonly runId: string | null
  readonly status: 'completed' | 'skipped'
  readonly reason: DreamingGateDenyReason | 'ok'
  readonly policyReasonCode?: string
  readonly edgesCreated: number
  readonly abstractionsCreated: number
  readonly synonymsCreated: number
  readonly expiredSwept: number
  readonly ideasProjected: number
  readonly ideasWithdrawn: number
  readonly artifacts: SynthesizedDreamingArtifacts
}

export interface StoredDreamRunRow {
  readonly runId: string
  readonly ownerScopeKey: string
  readonly status: string
  readonly edgesCreated: number
  readonly abstractionsCreated: number
  readonly synonymsCreated: number
  readonly ranAt: number
}

const TOKEN_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'your',
  'have',
  'will',
  'are',
  'was',
  'were',
  'not',
  'but',
  'can',
  'use',
  'used',
  'using',
  'when',
  'what',
  'which',
  'where',
  'how',
  'all',
  'any',
  'has',
  'had',
  'been',
  'true',
  'false',
  'null',
  'undefined',
  'about',
  'also',
  'than',
  'then',
  'them',
  'they',
  'their',
  'there',
  'here',
  'more',
  'some',
  'only',
  'other',
  'such',
  'each',
  'into',
  'over',
])

const CJK_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const PARENTHETICAL_ALIAS_RE =
  /([A-Za-z0-9\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}][A-Za-z0-9\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul} _./:-]{1,64}?)\s*[（(]\s*([A-Za-z0-9\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}][A-Za-z0-9\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul} _./:-]{1,48}?)\s*[)）]/gu
const CAMEL_CASE_RE = /\b([A-Za-z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+)\b/gu

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function computeDreamSynonymId(
  ownerScopeKey: string,
  surface: string,
  canonicalEntity: string,
): string {
  return `syn-${sha256Hex(`${ownerScopeKey}\0${surface}\0${canonicalEntity}`).slice(0, 24)}`
}

export function computeAbstractionNodeId(
  ownerScopeKey: string,
  memberNodeIds: readonly string[],
  sharedConcepts: readonly string[],
): string {
  const scope8 = ownerScopeKey.slice(0, 8)
  const sortedMembers = [...memberNodeIds].sort()
  const sortedConcepts = [...sharedConcepts].sort()
  const digest = sha256Hex(
    `abstraction\0${ownerScopeKey}\0${sortedMembers.join('\0')}\0${sortedConcepts.join('\0')}`,
  ).slice(0, 20)
  return `a:abs-${scope8}-${digest}`
}

function clampWeight(value: number, weightMin: number, weightMax: number): number {
  const lo = Math.max(0.0, Math.min(10.0, weightMin))
  const hi = Math.max(lo, Math.min(10.0, weightMax))
  if (!Number.isFinite(value)) return lo
  return Math.min(hi, Math.max(lo, value))
}

function compactText(raw: string, maxChars: number): string {
  const collapsed = raw.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  if (collapsed.length <= maxChars) return collapsed
  const chars = [...collapsed]
  if (chars.length <= maxChars) return collapsed
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…`
}

function hasTable(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { ok: number } | undefined
  return row !== undefined
}

export function ensureDreamingSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assoc_dream_runs (
      run_id TEXT PRIMARY KEY,
      owner_scope_key TEXT NOT NULL,
      status TEXT NOT NULL,
      edges_created INTEGER NOT NULL DEFAULT 0,
      abstractions_created INTEGER NOT NULL DEFAULT 0,
      synonyms_created INTEGER NOT NULL DEFAULT 0,
      ran_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS assoc_dream_runs_scope_time
      ON assoc_dream_runs(owner_scope_key, ran_at DESC);
  `)
}

function buildDreamingPolicyRequest(scope: AssociationOwnerScope): DreamingPolicyRequest {
  return {
    subject: {
      kind: 'background',
      id: 'assistant-association:dreaming',
      workspace: scope.workspace,
      principal: scope.principalId,
    },
    action: 'dream.build',
    resource: {
      kind: 'evolution',
      id: 'assistant-association:dreaming',
    },
    context: {
      initiator: 'background',
    },
  }
}

function inferLastScopeActivityAt(db: DatabaseSync, ownerScopeKey: string): number | null {
  let latest: number | null = null

  if (hasTable(db, 'assoc_step_metrics')) {
    const stepRow = db
      .prepare('SELECT MAX(occurred_at) AS ts FROM assoc_step_metrics WHERE owner_scope_key = ?')
      .get(ownerScopeKey) as { ts: number | null } | undefined
    if (typeof stepRow?.ts === 'number' && Number.isFinite(stepRow.ts)) {
      latest = stepRow.ts
    }
  }

  if (hasTable(db, 'assoc_nodes')) {
    const nodeRow = db
      .prepare(`
        SELECT MAX(updated_at) AS ts
        FROM assoc_nodes
        WHERE owner_scope_key = ?
          AND status = 'active'
          AND kind NOT IN ('dream', 'abstraction', 'web')
      `)
      .get(ownerScopeKey) as { ts: number | null } | undefined
    if (typeof nodeRow?.ts === 'number' && Number.isFinite(nodeRow.ts)) {
      latest = latest === null ? nodeRow.ts : Math.max(latest, nodeRow.ts)
    }
  }

  return latest
}

function evaluateDreamingGate(
  input: CanRunDreamingInput,
  mode: 'dry-check' | 'execute',
  idempotencyKey?: string | (() => string),
): DreamingGateDecision {
  const nowMs = input.nowMs ?? Date.now()
  if (!input.config.enabled) {
    return { allowed: false, reason: 'disabled' }
  }

  if (input.policy?.getEmergencyStop?.()?.enabled === true) {
    return { allowed: false, reason: 'emergency-stop' }
  }

  // Evaluate cheap, side-effect-free local readiness gates before calling
  // side-effecting policy.authorize() or delivery route checks.
  if (
    input.db !== undefined &&
    input.config.intervalMs > 0 &&
    hasTable(input.db, 'assoc_dream_runs')
  ) {
    const row = input.db
      .prepare(
        "SELECT MAX(ran_at) AS last_ran_at FROM assoc_dream_runs WHERE owner_scope_key = ? AND status = 'completed'",
      )
      .get(input.scope.ownerScopeKey) as { last_ran_at: number | null } | undefined
    if (
      typeof row?.last_ran_at === 'number' &&
      Number.isFinite(row.last_ran_at) &&
      nowMs - row.last_ran_at < input.config.intervalMs
    ) {
      return { allowed: false, reason: 'interval-not-elapsed' }
    }
  }

  if (input.hasRunningAgent === true) {
    return { allowed: false, reason: 'agent-active' }
  }

  const lastActivityAt =
    input.lastActivityAt !== undefined
      ? input.lastActivityAt
      : input.db !== undefined
        ? inferLastScopeActivityAt(input.db, input.scope.ownerScopeKey)
        : null

  if (
    lastActivityAt === null ||
    !Number.isFinite(lastActivityAt) ||
    nowMs - lastActivityAt < input.config.idleMinMs
  ) {
    return { allowed: false, reason: 'not-idle' }
  }

  const requirePolicy = input.requirePolicy ?? true
  if (requirePolicy && input.policy === undefined) {
    return { allowed: false, reason: 'policy-unavailable' }
  }

  if (input.config.budgetId !== undefined) {
    if (typeof input.policy?.getBudgetConfig !== 'function') {
      return { allowed: false, reason: 'budget-unavailable' }
    }
    const budget = input.policy.getBudgetConfig(input.config.budgetId)
    const requiredAmount = input.config.budgetAmount ?? 1
    if (budget === undefined || !Number.isFinite(budget.limit) || budget.limit < requiredAmount) {
      return { allowed: false, reason: 'budget-unavailable' }
    }
  }

  if (input.scope.mode === 'delivery' && input.delivery !== undefined) {
    const authorityId = input.scope.authorityId
    if (typeof input.delivery.validateOwnerRoute === 'function') {
      if (typeof authorityId !== 'string' || authorityId.length === 0) {
        return { allowed: false, reason: 'route-invalid' }
      }
      try {
        input.delivery.validateOwnerRoute({
          authorityId,
          principalId: input.scope.principalId,
          workspace: input.scope.workspace,
          agentPreset: input.scope.agentPreset,
        })
      } catch {
        return { allowed: false, reason: 'route-invalid' }
      }
    }
    if (typeof input.delivery.inspectOwnerRouteState === 'function') {
      if (typeof authorityId !== 'string' || authorityId.length === 0) {
        return { allowed: false, reason: 'route-invalid' }
      }
      try {
        const routeState = input.delivery.inspectOwnerRouteState({
          authorityId,
          principalId: input.scope.principalId,
          workspace: input.scope.workspace,
          agentPreset: input.scope.agentPreset,
        })
        const status = typeof routeState === 'string' ? routeState : routeState?.status
        if (status !== 'active') {
          return { allowed: false, reason: 'route-inactive' }
        }
      } catch {
        return { allowed: false, reason: 'route-invalid' }
      }
    }
  }

  if (input.policy !== undefined) {
    const request = buildDreamingPolicyRequest(input.scope)
    let decision: DreamingPolicyDecision | undefined
    if (mode === 'execute') {
      if (typeof input.policy.authorize === 'function') {
        const resolvedIdempotencyKey =
          typeof idempotencyKey === 'function' ? idempotencyKey() : idempotencyKey
        decision = input.policy.authorize(
          request,
          resolvedIdempotencyKey === undefined
            ? undefined
            : { idempotencyKey: resolvedIdempotencyKey },
        )
      } else if (typeof input.policy.evaluate === 'function') {
        decision = input.policy.evaluate(request)
      }
    } else {
      if (typeof input.policy.evaluate === 'function') {
        decision = input.policy.evaluate(request)
      } else if (typeof input.policy.authorize === 'function') {
        decision = input.policy.authorize(request)
      }
    }
    if (decision === undefined) {
      if (requirePolicy) {
        return { allowed: false, reason: 'policy-unavailable' }
      }
    } else if (decision.effect !== 'allow') {
      return {
        allowed: false,
        reason: 'policy-denied',
        ...(decision.reasonCode !== undefined ? { policyReasonCode: decision.reasonCode } : {}),
      }
    }
  }

  return { allowed: true, reason: 'ok' }
}

export function canRunDreaming(input: CanRunDreamingInput): DreamingGateDecision {
  return evaluateDreamingGate(input, 'dry-check')
}

interface CandidateNodeRow {
  readonly id: string
  readonly kind: NodeKind
  readonly sourcePlugin: string
  readonly sourceRef: string
  readonly sourceVersion: number
  readonly ownerScopeKey: string
  readonly ownerMode: AssociationOwnerMode
  readonly principalDigest: string | null
  readonly principalRecordId: string | null
  readonly principalVersion: number | null
  readonly scopeMode: AssociationScopeMode
  readonly workspace: string
  readonly agentPreset: string
  readonly trust: AssociationTrust
  readonly sensitivity: AssociationSensitivity
  readonly title: string
  readonly body: string
  readonly entities: readonly string[]
  readonly tokens: readonly string[]
  readonly metadata: AssociationNodeMetadata
  readonly status: AssociationNodeStatus
  readonly createdAt: number
  readonly updatedAt: number
}

function loadCandidateNodes(
  db: DatabaseSync,
  ownerScopeKey: string,
  nowMs: number,
  limit: number,
): CandidateNodeRow[] {
  const rows = db
    .prepare(`
      SELECT id, kind, source_plugin, source_ref, source_version,
             owner_scope_key, owner_mode, principal_digest, principal_record_id, principal_version,
             scope_mode, workspace, agent_preset, trust, sensitivity,
             title, body, entities_json, tokens_json, metadata_json,
             status, created_at, updated_at
      FROM assoc_nodes
      WHERE status = 'active'
        AND owner_scope_key = ?
        AND sensitivity = 'private'
        AND kind NOT IN ('dream', 'abstraction', 'web')
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY updated_at DESC, id ASC
      LIMIT ?
    `)
    .all(ownerScopeKey, nowMs, limit) as Array<{
    id: string
    kind: NodeKind
    source_plugin: string
    source_ref: string
    source_version: number
    owner_scope_key: string
    owner_mode: AssociationOwnerMode
    principal_digest: string | null
    principal_record_id: string | null
    principal_version: number | null
    scope_mode: AssociationScopeMode
    workspace: string
    agent_preset: string
    trust: AssociationTrust
    sensitivity: AssociationSensitivity
    title: string
    body: string
    entities_json: string
    tokens_json: string
    metadata_json: string
    status: AssociationNodeStatus
    created_at: number
    updated_at: number
  }>

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    sourcePlugin: row.source_plugin,
    sourceRef: row.source_ref,
    sourceVersion: row.source_version,
    ownerScopeKey: row.owner_scope_key,
    ownerMode: row.owner_mode,
    principalDigest: row.principal_digest,
    principalRecordId: row.principal_record_id,
    principalVersion: row.principal_version,
    scopeMode: row.scope_mode,
    workspace: row.workspace,
    agentPreset: row.agent_preset,
    trust: row.trust,
    sensitivity: row.sensitivity,
    title: row.title,
    body: row.body,
    entities: JSON.parse(row.entities_json) as string[],
    tokens: JSON.parse(row.tokens_json) as string[],
    metadata: JSON.parse(row.metadata_json) as AssociationNodeMetadata,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

function isSignificantToken(token: string): boolean {
  if (TOKEN_STOPWORDS.has(token)) return false
  if (CJK_CHAR_RE.test(token)) {
    return [...token].length >= 2
  }
  return token.length >= 3
}

function pairKey(aId: string, bId: string): string {
  return aId <= bId ? `${aId}\0${bId}` : `${bId}\0${aId}`
}

function loadExistingGraphNeighborhood(
  db: DatabaseSync,
  nodeIds: readonly string[],
): {
  readonly connectedPairs: Set<string>
  readonly neighborsByNode: Map<string, Set<string>>
} {
  const connectedPairs = new Set<string>()
  const neighborsByNode = new Map<string, Set<string>>()
  if (nodeIds.length === 0) {
    return { connectedPairs, neighborsByNode }
  }
  const nodeSet = new Set(nodeIds)
  const placeholders = nodeIds.map(() => '?').join(',')
  const edges = db
    .prepare(`
      SELECT e.a_id, e.b_id
      FROM assoc_edges e
      JOIN assoc_nodes a ON a.id = e.a_id AND a.status = 'active'
      JOIN assoc_nodes b ON b.id = e.b_id AND b.status = 'active'
      WHERE e.a_id IN (${placeholders}) OR e.b_id IN (${placeholders})
    `)
    .all(...nodeIds, ...nodeIds) as Array<{ a_id: string; b_id: string }>

  for (const edge of edges) {
    if (nodeSet.has(edge.a_id) && nodeSet.has(edge.b_id)) {
      connectedPairs.add(pairKey(edge.a_id, edge.b_id))
    }
    let aNeighbors = neighborsByNode.get(edge.a_id)
    if (aNeighbors === undefined) {
      aNeighbors = new Set<string>()
      neighborsByNode.set(edge.a_id, aNeighbors)
    }
    aNeighbors.add(edge.b_id)

    let bNeighbors = neighborsByNode.get(edge.b_id)
    if (bNeighbors === undefined) {
      bNeighbors = new Set<string>()
      neighborsByNode.set(edge.b_id, bNeighbors)
    }
    bNeighbors.add(edge.a_id)
  }

  return { connectedPairs, neighborsByNode }
}

function synthesizeLongRangeDreamEdges(
  nodes: readonly CandidateNodeRow[],
  connectedPairs: ReadonlySet<string>,
  neighborsByNode: ReadonlyMap<string, ReadonlySet<string>>,
  maxPairs: number,
  wMin: number,
  wMax: number,
  nowMs: number,
): {
  readonly edges: UpsertEdgeInput[]
  readonly derivedRefs: DerivedRefInput[]
} {
  if (maxPairs <= 0 || nodes.length < 2) {
    return { edges: [], derivedRefs: [] }
  }

  const df = new Map<string, number>()
  const sigTokenSets = nodes.map((node) => {
    const set = new Set<string>()
    for (const tok of node.tokens) {
      if (isSignificantToken(tok)) set.add(tok)
    }
    for (const tok of set) {
      df.set(tok, (df.get(tok) ?? 0) + 1)
    }
    return set
  })
  const entitySets = nodes.map((node) => new Set(node.entities))

  const idf = (tok: string): number => Math.log((nodes.length + 1) / ((df.get(tok) ?? 0) + 1)) + 1

  const candidates: Array<{
    readonly a: CandidateNodeRow
    readonly b: CandidateNodeRow
    readonly edgeId: string
    readonly rawScore: number
    readonly weight: number
    readonly basis: string
  }> = []

  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i]!
    const aTokens = sigTokenSets[i]!
    const aEntities = entitySets[i]!
    const aNeighbors = neighborsByNode.get(a.id)

    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j]!
      if (connectedPairs.has(pairKey(a.id, b.id))) continue

      const bTokens = sigTokenSets[j]!
      const bEntities = entitySets[j]!
      const bNeighbors = neighborsByNode.get(b.id)

      const sharedTokens: string[] = []
      let sharedIdfSum = 0
      let unionIdfSum = 0
      for (const tok of aTokens) {
        const w = idf(tok)
        unionIdfSum += w
        if (bTokens.has(tok)) {
          sharedTokens.push(tok)
          sharedIdfSum += w
        }
      }
      for (const tok of bTokens) {
        if (!aTokens.has(tok)) unionIdfSum += idf(tok)
      }
      const tokenSim = unionIdfSum > 0 ? sharedIdfSum / unionIdfSum : 0

      const sharedEntities: string[] = []
      for (const ent of aEntities) {
        if (bEntities.has(ent)) sharedEntities.push(ent)
      }

      let sharedBridges = 0
      if (aNeighbors !== undefined && bNeighbors !== undefined) {
        for (const neighbor of aNeighbors) {
          if (neighbor !== a.id && neighbor !== b.id && bNeighbors.has(neighbor)) {
            sharedBridges += 1
          }
        }
      }

      const qualifies =
        (sharedTokens.length >= 2 && tokenSim >= 0.12) ||
        (sharedEntities.length >= 1 && tokenSim >= 0.08) ||
        (sharedBridges >= 1 && (sharedTokens.length >= 1 || sharedEntities.length >= 1))

      if (!qualifies) continue

      const bridgeBoost = 0.18 * Math.min(2, sharedBridges)
      const entityBoost = 0.12 * Math.min(3, sharedEntities.length)
      const rawScore = Math.min(1.0, tokenSim + bridgeBoost + entityBoost)
      const mappedWeight = 0.30 + 0.35 * Math.min(1.0, rawScore)
      const weight = clampWeight(mappedWeight, wMin, wMax)

      const [left, right] = a.id <= b.id ? [a, b] : [b, a]
      const edgeId = computeDeterministicEdgeId(left.id, right.id, 'dream')
      const basisTokens = (sharedEntities.length > 0 ? sharedEntities : sharedTokens)
        .slice(0, 3)
        .join(',')
      const basis =
        sharedBridges > 0
          ? `bridge+${basisTokens || 'concept'}`
          : basisTokens || 'concept'

      candidates.push({
        a: left,
        b: right,
        edgeId,
        rawScore,
        weight,
        basis,
      })
    }
  }

  candidates.sort((x, y) => {
    if (y.rawScore !== x.rawScore) return y.rawScore - x.rawScore
    const xRecency = Math.max(x.a.updatedAt, x.b.updatedAt)
    const yRecency = Math.max(y.a.updatedAt, y.b.updatedAt)
    if (yRecency !== xRecency) return yRecency - xRecency
    return x.edgeId.localeCompare(y.edgeId)
  })

  const edges: UpsertEdgeInput[] = []
  const derivedRefs: DerivedRefInput[] = []
  const limit = Math.min(maxPairs, candidates.length)

  for (let i = 0; i < limit; i += 1) {
    const item = candidates[i]!
    edges.push({
      edgeId: item.edgeId,
      aId: item.a.id,
      bId: item.b.id,
      edgeType: 'dream',
      weight: item.weight,
      trust: 'low',
      reason: `dream:${item.basis}`.slice(0, 256),
      createdAt: nowMs,
      updatedAt: nowMs,
    })
    derivedRefs.push(
      {
        sourceNodeId: item.a.id,
        sourceVersion: item.a.sourceVersion,
        targetKind: 'edge',
        targetId: item.edgeId,
      },
      {
        sourceNodeId: item.b.id,
        sourceVersion: item.b.sourceVersion,
        targetKind: 'edge',
        targetId: item.edgeId,
      },
    )
  }

  return { edges, derivedRefs }
}

function synthesizeAbstractionClusters(
  db: DatabaseSync,
  scope: AssociationOwnerScope,
  nodes: readonly CandidateNodeRow[],
  maxAbstractions: number,
  nodeTtlMs: number,
  wMin: number,
  wMax: number,
  nowMs: number,
): {
  readonly nodes: UpsertNodeInput[]
  readonly edges: UpsertEdgeInput[]
  readonly derivedRefs: DerivedRefInput[]
} {
  if (maxAbstractions <= 0 || nodes.length < 2) {
    return { nodes: [], edges: [], derivedRefs: [] }
  }

  const conceptSets = nodes.map((node) => {
    const set = new Set<string>()
    for (const ent of node.entities) {
      const normalized = normalizeEntityKey(ent)
      if (normalized !== null && !TOKEN_STOPWORDS.has(normalized)) set.add(normalized)
    }
    for (const tok of node.tokens) {
      if (isSignificantToken(tok)) set.add(tok)
    }
    return set
  })

  const entitySets = nodes.map((node) => new Set(node.entities))

  interface ClusterCandidate {
    readonly members: CandidateNodeRow[]
    readonly sharedConcepts: string[]
    readonly score: number
  }

  const seedClusters: ClusterCandidate[] = []
  const seenSignatures = new Set<string>()

  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i]!
    const aConcepts = conceptSets[i]!
    const aEntities = entitySets[i]!

    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j]!
      const bConcepts = conceptSets[j]!
      const bEntities = entitySets[j]!

      const sharedEntities: string[] = []
      for (const ent of aEntities) {
        if (bEntities.has(ent)) sharedEntities.push(ent)
      }
      const sharedConcepts: string[] = []
      for (const c of aConcepts) {
        if (bConcepts.has(c)) sharedConcepts.push(c)
      }

      if (sharedConcepts.length < 2) continue

      const members: CandidateNodeRow[] = [a, b]
      const coreSet = new Set(sharedConcepts)
      for (let k = 0; k < nodes.length && members.length < 6; k += 1) {
        if (k === i || k === j) continue
        const c = nodes[k]!
        const cConcepts = conceptSets[k]!
        let overlap = 0
        for (const sc of coreSet) {
          if (cConcepts.has(sc)) overlap += 1
        }
        if (overlap >= 2) {
          members.push(c)
        }
      }

      const finalShared = [...coreSet]
        .filter((concept) =>
          members.every((_, idx) => {
            const nodeIdx = nodes.indexOf(members[idx]!)
            return nodeIdx >= 0 && conceptSets[nodeIdx]!.has(concept)
          }),
        )
        .sort()

      if (finalShared.length < 2) continue

      const sortedMemberIds = members.map((m) => m.id).sort()
      const signature = `${sortedMemberIds.join('\0')}|${finalShared.slice(0, 8).join('\0')}`
      if (seenSignatures.has(signature)) continue
      seenSignatures.add(signature)

      const score = finalShared.length + sharedEntities.length * 1.5 + members.length * 0.5
      seedClusters.push({
        members: [...members].sort((x, y) => x.id.localeCompare(y.id)),
        sharedConcepts: finalShared.slice(0, 8),
        score,
      })
    }
  }

  seedClusters.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score
    if (y.members.length !== x.members.length) return y.members.length - x.members.length
    return x.members[0]!.id.localeCompare(y.members[0]!.id)
  })

  const checkExistingNode = db.prepare(
    "SELECT 1 AS ok FROM assoc_nodes WHERE id = ? AND status = 'active'",
  )

  const absNodes: UpsertNodeInput[] = []
  const absEdges: UpsertEdgeInput[] = []
  const derivedRefs: DerivedRefInput[] = []
  const usedMemberPairs = new Set<string>()

  for (const cluster of seedClusters) {
    if (absNodes.length >= maxAbstractions) break

    const memberIds = cluster.members.map((m) => m.id)
    const primaryPair = pairKey(memberIds[0]!, memberIds[1]!)
    if (usedMemberPairs.has(primaryPair)) continue

    const absId = computeAbstractionNodeId(
      scope.ownerScopeKey,
      memberIds,
      cluster.sharedConcepts,
    )
    if (checkExistingNode.get(absId) !== undefined) continue

    usedMemberPairs.add(primaryPair)

    const labelConcepts = cluster.sharedConcepts.slice(0, 4).join(', ')
    const title = compactText(`Abstraction: ${labelConcepts}`, 160)
    const body = compactText(
      `Bridging abstraction across ${cluster.members.length} sources (${cluster.members.map((m) => m.title).slice(0, 4).join('; ')}) sharing concepts: ${cluster.sharedConcepts.join(', ')}.`,
      1024,
    )
    const tokens = tokenizeAssociationText(`${title} ${body}`)
    const expiresAt = nodeTtlMs > 0 ? nowMs + nodeTtlMs : null
    const sourceRefSuffix = absId.slice(`a:abs-${scope.ownerScopeKey.slice(0, 8)}-`.length)

    absNodes.push({
      id: absId,
      kind: 'abstraction',
      sourcePlugin: 'assistant-association',
      sourceRef: `abstraction:${sourceRefSuffix}`,
      sourceVersion: 1,
      ownerScopeKey: scope.ownerScopeKey,
      ownerMode: scope.mode,
      principalDigest: scope.principalDigest,
      principalRecordId: scope.principalRecordId,
      principalVersion: scope.principalVersion,
      scopeMode: 'workspace',
      workspace: scope.workspace,
      agentPreset: scope.agentPreset,
      trust: 'low',
      sensitivity: 'private',
      title,
      body,
      entities: cluster.sharedConcepts,
      tokens,
      metadata: {
        extra: {
          supportingNodeIds: memberIds,
          sharedConcepts: cluster.sharedConcepts,
        },
      },
      ttlMs: nodeTtlMs > 0 ? nodeTtlMs : null,
      expiresAt,
      status: 'active',
      createdAt: nowMs,
      updatedAt: nowMs,
    })

    const edgeWeight = clampWeight(
      0.45 + 0.05 * Math.min(4, cluster.sharedConcepts.length),
      wMin,
      wMax,
    )
    const reason = `abstraction:${cluster.sharedConcepts.slice(0, 3).join(',')}`.slice(0, 256)

    for (const member of cluster.members) {
      const [aId, bId] = member.id <= absId ? [member.id, absId] : [absId, member.id]
      const edgeId = computeDeterministicEdgeId(aId, bId, 'abstraction')
      absEdges.push({
        edgeId,
        aId,
        bId,
        edgeType: 'abstraction',
        weight: edgeWeight,
        trust: 'low',
        reason,
        createdAt: nowMs,
        updatedAt: nowMs,
      })

      derivedRefs.push(
        {
          sourceNodeId: member.id,
          sourceVersion: member.sourceVersion,
          targetKind: 'node',
          targetId: absId,
        },
        {
          sourceNodeId: member.id,
          sourceVersion: member.sourceVersion,
          targetKind: 'edge',
          targetId: edgeId,
        },
        {
          sourceNodeId: absId,
          sourceVersion: 1,
          targetKind: 'edge',
          targetId: edgeId,
        },
      )
    }
  }

  return { nodes: absNodes, edges: absEdges, derivedRefs }
}

function splitCamelCase(identifier: string): string | null {
  const spaced = identifier.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').toLowerCase().trim()
  if (!spaced.includes(' ')) return null
  return normalizeEntityKey(spaced)
}

function extractAliasesFromMetadata(metadata: AssociationNodeMetadata): string[] {
  const out: string[] = []
  const rawRecord = metadata as Record<string, unknown>
  const extraAliases = metadata.extra?.aliases
  const topAliases = rawRecord['aliases']
  for (const candidateList of [extraAliases, topAliases]) {
    if (!Array.isArray(candidateList)) continue
    for (const entry of candidateList) {
      if (typeof entry !== 'string') continue
      const normalized = normalizeEntityKey(entry)
      if (normalized !== null) out.push(normalized)
    }
  }
  return out
}

function synthesizeSynonyms(
  scope: AssociationOwnerScope,
  nodes: readonly CandidateNodeRow[],
  abstractionNodes: readonly UpsertNodeInput[],
  maxSynonyms: number,
  nowMs: number,
): {
  readonly synonyms: UpsertSynonymInput[]
  readonly derivedRefs: DerivedRefInput[]
} {
  if (maxSynonyms <= 0 || nodes.length === 0) {
    return { synonyms: [], derivedRefs: [] }
  }

  const canonicalGroundings = new Map<string, CandidateNodeRow[]>()
  for (const node of nodes) {
    for (const ent of node.entities) {
      const canonical = normalizeEntityKey(ent)
      if (canonical === null || TOKEN_STOPWORDS.has(canonical)) continue
      let list = canonicalGroundings.get(canonical)
      if (list === undefined) {
        list = []
        canonicalGroundings.set(canonical, list)
      }
      if (!list.some((existing) => existing.id === node.id)) {
        list.push(node)
      }
    }
  }

  const abstractionByConcept = new Map<string, UpsertNodeInput>()
  for (const absNode of abstractionNodes) {
    for (const ent of absNode.entities) {
      if (!abstractionByConcept.has(ent)) {
        abstractionByConcept.set(ent, absNode)
      }
    }
  }

  const seenSurfaceCanonical = new Set<string>()
  const synonyms: UpsertSynonymInput[] = []
  const derivedRefs: DerivedRefInput[] = []

  const addSynonym = (
    rawSurface: string,
    canonicalEntity: string,
    groundingNodes: readonly CandidateNodeRow[],
  ): void => {
    if (synonyms.length >= maxSynonyms) return
    const surface = normalizeEntityKey(rawSurface)
    if (
      surface === null ||
      surface === canonicalEntity ||
      surface.length > 256 ||
      canonicalEntity.length > 256 ||
      TOKEN_STOPWORDS.has(surface) ||
      groundingNodes.length === 0
    ) {
      return
    }
    const dedupKey = `${surface}\0${canonicalEntity}`
    if (seenSurfaceCanonical.has(dedupKey)) return
    seenSurfaceCanonical.add(dedupKey)

    const synId = computeDreamSynonymId(scope.ownerScopeKey, surface, canonicalEntity)
    const primaryNode = groundingNodes[0]!
    synonyms.push({
      id: synId,
      ownerScopeKey: scope.ownerScopeKey,
      surface,
      canonicalEntity,
      sourceNodeId: primaryNode.id,
      trust: 'low',
      createdAt: nowMs,
    })

    for (const grounding of groundingNodes) {
      derivedRefs.push({
        sourceNodeId: grounding.id,
        sourceVersion: grounding.sourceVersion,
        targetKind: 'synonym',
        targetId: synId,
      })
    }

    const bridge = abstractionByConcept.get(canonicalEntity)
    if (bridge !== undefined) {
      derivedRefs.push({
        sourceNodeId: bridge.id,
        sourceVersion: bridge.sourceVersion,
        targetKind: 'synonym',
        targetId: synId,
      })
    }
  }

  for (const node of nodes) {
    if (synonyms.length >= maxSynonyms) break
    const text = `${node.title}\n${node.body}`

    // 1. Metadata aliases (e.g., wiki/skill aliases)
    const metaAliases = extractAliasesFromMetadata(node.metadata)
    if (metaAliases.length > 0) {
      const titleCanonical = normalizeEntityKey(node.title)
      const fallbackCanonical = node.entities[0] ?? null
      const canonical =
        titleCanonical !== null && canonicalGroundings.has(titleCanonical)
          ? titleCanonical
          : fallbackCanonical !== null && canonicalGroundings.has(fallbackCanonical)
            ? fallbackCanonical
            : null
      if (canonical !== null) {
        const groundings = canonicalGroundings.get(canonical) ?? [node]
        const combinedGroundings = groundings.some((g) => g.id === node.id)
          ? groundings
          : [node, ...groundings]
        for (const alias of metaAliases) {
          addSynonym(alias, canonical, combinedGroundings)
        }
      }
    }

    // 2. Parenthetical aliases: `Canonical (Alias)` or `Alias (Canonical)`
    PARENTHETICAL_ALIAS_RE.lastIndex = 0
    let parenMatch: RegExpExecArray | null
    while ((parenMatch = PARENTHETICAL_ALIAS_RE.exec(text)) !== null) {
      if (synonyms.length >= maxSynonyms) break
      const left = normalizeEntityKey(parenMatch[1] ?? '')
      const right = normalizeEntityKey(parenMatch[2] ?? '')
      if (left === null || right === null || left === right) continue

      const leftWords = left.split(/\s+/u)
      const leftCandidates: string[] = []
      for (let start = 0; start < leftWords.length; start += 1) {
        const phrase = leftWords.slice(start).join(' ')
        if (phrase.length < 2) continue
        leftCandidates.push(phrase, phrase.replace(/\s+/gu, '-'), phrase.replace(/\s+/gu, '_'))
      }
      const leftCanonical = leftCandidates.find((v) => canonicalGroundings.has(v))
      const rightGroundings = canonicalGroundings.get(right)
      if (leftCanonical !== undefined) {
        const leftGroundings = canonicalGroundings.get(leftCanonical)!
        const groundings = leftGroundings.some((g) => g.id === node.id)
          ? leftGroundings
          : [node, ...leftGroundings]
        addSynonym(right, leftCanonical, groundings)
      } else if (rightGroundings !== undefined) {
        const groundings = rightGroundings.some((g) => g.id === node.id)
          ? rightGroundings
          : [node, ...rightGroundings]
        addSynonym(left, right, groundings)
      } else if (node.entities.length > 0) {
        // Check if left matches a multi-word form of a canonical entity in this node
        for (const ent of node.entities) {
          if (ent === left || ent === right) {
            const groundings = canonicalGroundings.get(ent) ?? [node]
            addSynonym(ent === left ? right : left, ent, groundings)
            break
          }
        }
      }
    }

    // 3. CamelCase variants in raw text matching canonical entities
    CAMEL_CASE_RE.lastIndex = 0
    let camelMatch: RegExpExecArray | null
    while ((camelMatch = CAMEL_CASE_RE.exec(text)) !== null) {
      if (synonyms.length >= maxSynonyms) break
      const rawCamel = camelMatch[1]
      if (rawCamel === undefined) continue
      const normalizedCamel = normalizeEntityKey(rawCamel)
      const spaced = splitCamelCase(rawCamel)
      if (normalizedCamel === null || spaced === null) continue
      const hyphenated = spaced.replace(/\s+/gu, '-')
      const underscored = spaced.replace(/\s+/gu, '_')
      for (const candidateCanonical of [normalizedCamel, hyphenated, underscored, spaced]) {
        const groundings = canonicalGroundings.get(candidateCanonical)
        if (groundings !== undefined) {
          const combined = groundings.some((g) => g.id === node.id)
            ? groundings
            : [node, ...groundings]
          if (spaced !== candidateCanonical) addSynonym(spaced, candidateCanonical, combined)
          if (normalizedCamel !== candidateCanonical) {
            addSynonym(normalizedCamel, candidateCanonical, combined)
          }
          break
        }
      }
    }
  }

  // 4. Hyphen / underscore / space variants for canonical entities in scope
  const sortedCanonicals = [...canonicalGroundings.keys()].sort()
  for (const canonical of sortedCanonicals) {
    if (synonyms.length >= maxSynonyms) break
    const groundings = canonicalGroundings.get(canonical)!
    if (canonical.includes('-')) {
      addSynonym(canonical.replace(/-/gu, ' '), canonical, groundings)
      addSynonym(canonical.replace(/-/gu, '_'), canonical, groundings)
    } else if (canonical.includes('_')) {
      addSynonym(canonical.replace(/_/gu, ' '), canonical, groundings)
      addSynonym(canonical.replace(/_/gu, '-'), canonical, groundings)
    }
  }

  return { synonyms, derivedRefs }
}

export function synthesizeDreamingArtifacts(
  db: DatabaseSync,
  scope: AssociationOwnerScope,
  config: AssociationDreamingNormalizedConfig,
  options?: SynthesizeDreamingOptions,
): SynthesizedDreamingArtifacts {
  const nowMs = options?.nowMs ?? Date.now()
  const wMin = options?.weightMin ?? 0.05
  const wMax = options?.weightMax ?? 3.0
  const nodeLimit = Math.max(2, Math.min(512, options?.nodeLimit ?? 128))

  const nodes = loadCandidateNodes(db, scope.ownerScopeKey, nowMs, nodeLimit)
  if (nodes.length === 0) {
    return {
      nodes: [],
      edges: [],
      synonyms: [],
      derivedRefs: [],
      pairsCreated: 0,
      abstractionsCreated: 0,
      synonymsCreated: 0,
    }
  }

  const { connectedPairs, neighborsByNode } = loadExistingGraphNeighborhood(
    db,
    nodes.map((n) => n.id),
  )

  const edgeSynth = synthesizeLongRangeDreamEdges(
    nodes,
    connectedPairs,
    neighborsByNode,
    config.maxPairsPerRun,
    wMin,
    wMax,
    nowMs,
  )

  const absSynth = synthesizeAbstractionClusters(
    db,
    scope,
    nodes,
    config.maxAbstractionsPerRun,
    config.nodeTtlMs,
    wMin,
    wMax,
    nowMs,
  )

  const synSynth = synthesizeSynonyms(
    scope,
    nodes,
    absSynth.nodes,
    config.maxSynonymsPerRun,
    nowMs,
  )

  return {
    nodes: absSynth.nodes,
    edges: [...edgeSynth.edges, ...absSynth.edges],
    synonyms: synSynth.synonyms,
    derivedRefs: [
      ...edgeSynth.derivedRefs,
      ...absSynth.derivedRefs,
      ...synSynth.derivedRefs,
    ],
    pairsCreated: edgeSynth.edges.length,
    abstractionsCreated: absSynth.nodes.length,
    synonymsCreated: synSynth.synonyms.length,
  }
}

export function projectDreamIdeasToAssociation(
  ideas: readonly DreamIdeaRecord[],
  scope: AssociationOwnerScope,
  config: AssociationDreamingNormalizedConfig,
  nowMs = Date.now(),
): DreamIdeaProjectionResult {
  const scope8 = scope.ownerScopeKey.slice(0, 8)
  const upserts: UpsertNodeInput[] = []
  const withdrawals: DreamIdeaWithdrawalTarget[] = []

  for (const idea of ideas) {
    const sourceRef = `dream-idea:${idea.id}`
    const nodeId = `a:dr-${scope8}-${sha256Hex(idea.id).slice(0, 20)}`

    if (idea.state === 'rejected' || idea.state === 'withdrawn') {
      withdrawals.push({
        ownerScopeKey: scope.ownerScopeKey,
        sourcePlugin: 'assistant-dreaming',
        sourceRef,
        nodeId,
      })
      continue
    }

    const title = compactText(idea.summary, 160)
    const body = compactText(idea.detail || idea.summary, 4_096)
    const combined = `${title}\n${body}`
    const entities = extractEntities(combined)
    const tokens = tokenizeAssociationText(combined)
    const expiresAt = config.nodeTtlMs > 0 ? nowMs + config.nodeTtlMs : null

    upserts.push({
      id: nodeId,
      kind: 'dream',
      sourcePlugin: 'assistant-dreaming',
      sourceRef,
      sourceVersion: 1,
      ownerScopeKey: scope.ownerScopeKey,
      ownerMode: scope.mode,
      principalDigest: scope.principalDigest,
      principalRecordId: scope.principalRecordId,
      principalVersion: scope.principalVersion,
      scopeMode: 'workspace',
      workspace: scope.workspace,
      agentPreset: scope.agentPreset,
      trust: 'low',
      sensitivity: 'private',
      title,
      body,
      entities,
      tokens,
      metadata: {
        extra: {
          dreamRunId: idea.runId,
          dreamLane: idea.lane,
          dreamState: idea.state,
          dayKey: idea.dayKey,
          evidenceRefs: [...idea.evidenceRefs],
        },
      },
      ttlMs: config.nodeTtlMs > 0 ? config.nodeTtlMs : null,
      expiresAt,
      status: 'active',
      createdAt: idea.createdAt,
      updatedAt: nowMs,
    })
  }

  return { upserts, withdrawals }
}

export function findExpiredAssociationNodes(
  db: DatabaseSync,
  options?: {
    readonly ownerScopeKey?: string
    readonly nowMs?: number
    readonly limit?: number
  },
): readonly ExpiredNodeCleanupTarget[] {
  const nowMs = options?.nowMs ?? Date.now()
  const limit = Math.max(1, Math.min(1_000, options?.limit ?? 200))

  const rows = (
    options?.ownerScopeKey !== undefined
      ? db
          .prepare(`
            SELECT id, owner_scope_key, source_plugin, source_ref, kind, expires_at
            FROM assoc_nodes
            WHERE owner_scope_key = ?
              AND expires_at IS NOT NULL
              AND expires_at <= ?
            ORDER BY expires_at ASC, id ASC
            LIMIT ?
          `)
          .all(options.ownerScopeKey, nowMs, limit)
      : db
          .prepare(`
            SELECT id, owner_scope_key, source_plugin, source_ref, kind, expires_at
            FROM assoc_nodes
            WHERE expires_at IS NOT NULL
              AND expires_at <= ?
            ORDER BY expires_at ASC, id ASC
            LIMIT ?
          `)
          .all(nowMs, limit)
  ) as Array<{
    id: string
    owner_scope_key: string
    source_plugin: string
    source_ref: string
    kind: NodeKind
    expires_at: number
  }>

  return rows.map((row) => ({
    id: row.id,
    ownerScopeKey: row.owner_scope_key,
    sourcePlugin: row.source_plugin,
    sourceRef: row.source_ref,
    kind: row.kind,
    expiresAt: row.expires_at,
  }))
}

function cascadeWithdrawNodeDirectly(
  db: DatabaseSync,
  ownerScopeKey: string,
  sourcePlugin: string,
  sourceRef: string,
): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    const matching = db
      .prepare(
        'SELECT id FROM assoc_nodes WHERE owner_scope_key = ? AND source_plugin = ? AND source_ref = ?',
      )
      .all(ownerScopeKey, sourcePlugin, sourceRef) as Array<{ id: string }>

    if (matching.length === 0) {
      db.exec('COMMIT')
      return
    }

    const selectDerived = db.prepare(
      'SELECT target_kind, target_id FROM assoc_derived_from WHERE source_node_id = ?',
    )
    const selectSynsByNode = db.prepare(
      'SELECT id FROM assoc_synonyms WHERE source_node_id = ?',
    )
    const deleteSyn = db.prepare('DELETE FROM assoc_synonyms WHERE id = ?')
    const deleteEdge = db.prepare('DELETE FROM assoc_edges WHERE edge_id = ?')
    const deleteIncidentEdges = db.prepare('DELETE FROM assoc_edges WHERE a_id = ? OR b_id = ?')
    const deleteNode = db.prepare('DELETE FROM assoc_nodes WHERE id = ?')
    const deleteDerivedBySource = db.prepare(
      'DELETE FROM assoc_derived_from WHERE source_node_id = ?',
    )
    const deleteDerivedByTarget = db.prepare(
      'DELETE FROM assoc_derived_from WHERE target_kind = ? AND target_id = ?',
    )

    const visitedNodes = new Set<string>()
    const deletedNodes = new Set<string>()
    const deletedEdges = new Set<string>()
    const deletedSyns = new Set<string>()
    const queue = matching.map((m) => m.id)

    for (const rootId of queue) {
      deletedNodes.add(rootId)
    }

    while (queue.length > 0) {
      const nodeId = queue.shift()!
      if (visitedNodes.has(nodeId)) continue
      visitedNodes.add(nodeId)

      const derived = selectDerived.all(nodeId) as Array<{
        target_kind: 'node' | 'edge' | 'synonym'
        target_id: string
      }>
      for (const row of derived) {
        if (row.target_kind === 'edge') {
          deletedEdges.add(row.target_id)
        } else if (row.target_kind === 'synonym') {
          deletedSyns.add(row.target_id)
        } else if (row.target_kind === 'node' && !deletedNodes.has(row.target_id)) {
          deletedNodes.add(row.target_id)
          queue.push(row.target_id)
        }
      }

      const attachedSyns = selectSynsByNode.all(nodeId) as Array<{ id: string }>
      for (const syn of attachedSyns) {
        deletedSyns.add(syn.id)
      }
    }

    for (const synId of deletedSyns) {
      deleteSyn.run(synId)
      deleteDerivedByTarget.run('synonym', synId)
    }
    for (const edgeId of deletedEdges) {
      deleteEdge.run(edgeId)
      deleteDerivedByTarget.run('edge', edgeId)
    }
    for (const nodeId of deletedNodes) {
      deleteIncidentEdges.run(nodeId, nodeId)
      deleteNode.run(nodeId)
      deleteDerivedByTarget.run('node', nodeId)
      deleteDerivedBySource.run(nodeId)
    }

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function sweepExpiredDreamingNodes(
  db: DatabaseSync,
  options?: {
    readonly ownerScopeKey?: string
    readonly nowMs?: number
    readonly limit?: number
    readonly withdrawSource?: DreamingWriter['withdrawSource']
  },
): readonly ExpiredNodeCleanupTarget[] {
  const nowMs = options?.nowMs ?? Date.now()
  const targets = findExpiredAssociationNodes(db, {
    ...(options?.ownerScopeKey === undefined ? {} : { ownerScopeKey: options.ownerScopeKey }),
    nowMs,
    ...(options?.limit === undefined ? {} : { limit: options.limit }),
  })

  for (const target of targets) {
    if (options?.withdrawSource !== undefined) {
      options.withdrawSource({
        ownerScopeKey: target.ownerScopeKey,
        sourcePlugin: target.sourcePlugin,
        sourceRef: target.sourceRef,
        hardDelete: true,
        nowMs,
      })
    } else {
      cascadeWithdrawNodeDirectly(
        db,
        target.ownerScopeKey,
        target.sourcePlugin,
        target.sourceRef,
      )
    }
  }

  return targets
}

function applyArtifactsDirectly(
  db: DatabaseSync,
  input: {
    readonly nodes: readonly UpsertNodeInput[]
    readonly edges: readonly UpsertEdgeInput[]
    readonly synonyms?: readonly UpsertSynonymInput[]
    readonly derivedRefs: readonly DerivedRefInput[]
  },
): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    const checkWithdrawn = db.prepare(
      'SELECT 1 AS ok FROM assoc_withdrawn_sources WHERE owner_scope_key = ? AND source_plugin = ? AND source_ref = ?',
    )
    const upsertNodeStmt = db.prepare(`
      INSERT INTO assoc_nodes (
        id, kind, source_plugin, source_ref, source_version,
        owner_scope_key, owner_mode, principal_digest, principal_record_id, principal_version,
        scope_mode, workspace, agent_preset, trust, sensitivity,
        title, body, entities_json, tokens_json, metadata_json,
        ttl_ms, expires_at, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        source_plugin = excluded.source_plugin,
        source_ref = excluded.source_ref,
        source_version = excluded.source_version,
        owner_scope_key = excluded.owner_scope_key,
        owner_mode = excluded.owner_mode,
        principal_digest = excluded.principal_digest,
        principal_record_id = excluded.principal_record_id,
        principal_version = excluded.principal_version,
        scope_mode = excluded.scope_mode,
        workspace = excluded.workspace,
        agent_preset = excluded.agent_preset,
        trust = excluded.trust,
        sensitivity = excluded.sensitivity,
        title = excluded.title,
        body = excluded.body,
        entities_json = excluded.entities_json,
        tokens_json = excluded.tokens_json,
        metadata_json = excluded.metadata_json,
        ttl_ms = excluded.ttl_ms,
        expires_at = excluded.expires_at,
        status = excluded.status,
        updated_at = excluded.updated_at
    `)

    const skippedNodeIds = new Set<string>()
    for (const node of input.nodes) {
      if (
        checkWithdrawn.get(node.ownerScopeKey, node.sourcePlugin, node.sourceRef) !== undefined
      ) {
        skippedNodeIds.add(node.id)
        continue
      }
      upsertNodeStmt.run(
        node.id,
        node.kind,
        node.sourcePlugin,
        node.sourceRef,
        node.sourceVersion,
        node.ownerScopeKey,
        node.ownerMode,
        node.principalDigest,
        node.principalRecordId,
        node.principalVersion,
        node.scopeMode,
        node.workspace,
        node.agentPreset,
        node.trust,
        node.sensitivity,
        node.title.slice(0, 512),
        node.body,
        JSON.stringify(node.entities),
        JSON.stringify(node.tokens),
        JSON.stringify(node.metadata ?? {}),
        node.ttlMs ?? null,
        node.expiresAt ?? null,
        node.status ?? 'active',
        node.createdAt,
        node.updatedAt,
      )
    }

    if (input.edges.length > 0) {
      const checkNode = db.prepare('SELECT 1 AS ok FROM assoc_nodes WHERE id = ?')
      const upsertEdgeStmt = db.prepare(`
        INSERT INTO assoc_edges (
          edge_id, a_id, b_id, edge_type, weight, trust, reason,
          use_count, last_used_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(a_id, b_id, edge_type) DO UPDATE SET
          weight = excluded.weight,
          trust = excluded.trust,
          reason = excluded.reason,
          updated_at = excluded.updated_at
      `)
      for (const edge of input.edges) {
        if (edge.aId === edge.bId) continue
        if (checkNode.get(edge.aId) === undefined || checkNode.get(edge.bId) === undefined) {
          continue
        }
        upsertEdgeStmt.run(
          edge.edgeId,
          edge.aId,
          edge.bId,
          edge.edgeType,
          Math.min(10.0, Math.max(0.0, edge.weight)),
          edge.trust,
          edge.reason.slice(0, 256),
          edge.useCount ?? 0,
          edge.lastUsedAt ?? null,
          edge.createdAt,
          edge.updatedAt,
        )
      }
    }

    if (input.synonyms && input.synonyms.length > 0) {
      const upsertSynStmt = db.prepare(`
        INSERT INTO assoc_synonyms (
          id, owner_scope_key, surface, canonical_entity, source_node_id, trust, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_scope_key, surface, canonical_entity) DO UPDATE SET
          source_node_id = excluded.source_node_id,
          trust = excluded.trust
      `)
      for (const syn of input.synonyms) {
        if (syn.sourceNodeId !== undefined && syn.sourceNodeId !== null && skippedNodeIds.has(syn.sourceNodeId)) {
          continue
        }
        upsertSynStmt.run(
          syn.id,
          syn.ownerScopeKey,
          syn.surface,
          syn.canonicalEntity,
          syn.sourceNodeId ?? null,
          syn.trust,
          syn.createdAt,
        )
      }
    }

    if (input.derivedRefs.length > 0) {
      const insertDerivedStmt = db.prepare(`
        INSERT OR IGNORE INTO assoc_derived_from (
          source_node_id, source_version, target_kind, target_id
        ) VALUES (?, ?, ?, ?)
      `)
      for (const ref of input.derivedRefs) {
        if (
          skippedNodeIds.has(ref.sourceNodeId) ||
          (ref.targetKind === 'node' && skippedNodeIds.has(ref.targetId))
        ) {
          continue
        }
        insertDerivedStmt.run(ref.sourceNodeId, ref.sourceVersion, ref.targetKind, ref.targetId)
      }
    }

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function runDreamingPass(input: RunDreamingPassInput): RunDreamingPassResult {
  ensureDreamingSchema(input.db)
  const nowMs = input.nowMs ?? Date.now()
  let computedRunId: string | null = null
  const getRunId = (): string => {
    if (computedRunId === null) {
      const runCountRow = input.db
        .prepare('SELECT COUNT(*) AS cnt FROM assoc_dream_runs WHERE owner_scope_key = ?')
        .get(input.scope.ownerScopeKey) as { cnt: number } | undefined
      const runOrdinal = runCountRow?.cnt ?? 0
      computedRunId = `dream-${sha256Hex(`${input.scope.ownerScopeKey}\0${nowMs}\0${runOrdinal}`).slice(0, 24)}`
    }
    return computedRunId
  }

  const gate = evaluateDreamingGate(input, 'execute', getRunId)
  if (!gate.allowed) {
    return {
      ran: false,
      runId: null,
      status: 'skipped',
      reason: gate.reason,
      ...(gate.policyReasonCode !== undefined
        ? { policyReasonCode: gate.policyReasonCode }
        : {}),
      edgesCreated: 0,
      abstractionsCreated: 0,
      synonymsCreated: 0,
      expiredSwept: 0,
      ideasProjected: 0,
      ideasWithdrawn: 0,
      artifacts: {
        nodes: [],
        edges: [],
        synonyms: [],
        derivedRefs: [],
        pairsCreated: 0,
        abstractionsCreated: 0,
        synonymsCreated: 0,
      },
    }
  }
  const runId = getRunId()

  const expiredTargets = sweepExpiredDreamingNodes(input.db, {
    ownerScopeKey: input.scope.ownerScopeKey,
    nowMs,
    ...(input.writer?.withdrawSource !== undefined
      ? { withdrawSource: input.writer.withdrawSource }
      : {}),
  })

  let ideasProjected = 0
  let ideasWithdrawn = 0
  let ideaNodes: readonly UpsertNodeInput[] = []
  if (input.ideas !== undefined && input.ideas.length > 0) {
    const projected = projectDreamIdeasToAssociation(
      input.ideas,
      input.scope,
      input.config,
      nowMs,
    )
    ideaNodes = projected.upserts
    ideasProjected = projected.upserts.length
    for (const w of projected.withdrawals) {
      if (input.writer?.withdrawSource !== undefined) {
        input.writer.withdrawSource({
          ownerScopeKey: w.ownerScopeKey,
          sourcePlugin: w.sourcePlugin,
          sourceRef: w.sourceRef,
          hardDelete: true,
          nowMs,
        })
      } else {
        cascadeWithdrawNodeDirectly(input.db, w.ownerScopeKey, w.sourcePlugin, w.sourceRef)
      }
      ideasWithdrawn += 1
    }
  }

  const artifacts = synthesizeDreamingArtifacts(input.db, input.scope, input.config, {
    nowMs,
    ...(input.weightMin !== undefined ? { weightMin: input.weightMin } : {}),
    ...(input.weightMax !== undefined ? { weightMax: input.weightMax } : {}),
    ...(input.nodeLimit !== undefined ? { nodeLimit: input.nodeLimit } : {}),
  })

  const allNodes = [...ideaNodes, ...artifacts.nodes]
  if (
    allNodes.length > 0 ||
    artifacts.edges.length > 0 ||
    artifacts.synonyms.length > 0 ||
    artifacts.derivedRefs.length > 0
  ) {
    const batch = {
      nodes: allNodes,
      edges: artifacts.edges,
      synonyms: artifacts.synonyms,
      derivedRefs: artifacts.derivedRefs,
    }
    if (input.writer !== undefined) {
      input.writer.upsertBatch(batch)
    } else {
      applyArtifactsDirectly(input.db, batch)
    }
  }

  input.db
    .prepare(`
      INSERT INTO assoc_dream_runs (
        run_id, owner_scope_key, status,
        edges_created, abstractions_created, synonyms_created, ran_at
      ) VALUES (?, ?, 'completed', ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        status = excluded.status,
        edges_created = excluded.edges_created,
        abstractions_created = excluded.abstractions_created,
        synonyms_created = excluded.synonyms_created,
        ran_at = excluded.ran_at
    `)
    .run(
      runId,
      input.scope.ownerScopeKey,
      artifacts.edges.length,
      artifacts.abstractionsCreated,
      artifacts.synonymsCreated,
      nowMs,
    )

  return {
    ran: true,
    runId,
    status: 'completed',
    reason: 'ok',
    edgesCreated: artifacts.edges.length,
    abstractionsCreated: artifacts.abstractionsCreated,
    synonymsCreated: artifacts.synonymsCreated,
    expiredSwept: expiredTargets.length,
    ideasProjected,
    ideasWithdrawn,
    artifacts,
  }
}

export function listDreamRuns(
  db: DatabaseSync,
  ownerScopeKey: string,
  limit = 20,
): readonly StoredDreamRunRow[] {
  if (!hasTable(db, 'assoc_dream_runs')) return []
  const rows = db
    .prepare(`
      SELECT run_id, owner_scope_key, status, edges_created, abstractions_created, synonyms_created, ran_at
      FROM assoc_dream_runs
      WHERE owner_scope_key = ?
      ORDER BY ran_at DESC, run_id ASC
      LIMIT ?
    `)
    .all(ownerScopeKey, Math.max(1, Math.min(200, limit))) as Array<{
    run_id: string
    owner_scope_key: string
    status: string
    edges_created: number
    abstractions_created: number
    synonyms_created: number
    ran_at: number
  }>

  return rows.map((row) => ({
    runId: row.run_id,
    ownerScopeKey: row.owner_scope_key,
    status: row.status,
    edgesCreated: row.edges_created,
    abstractionsCreated: row.abstractions_created,
    synonymsCreated: row.synonyms_created,
    ranAt: row.ran_at,
  }))
}

export type { EdgeType }
