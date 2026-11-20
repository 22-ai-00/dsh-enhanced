import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  AssociationNodeStatus,
  AssociationOwnerScope,
  AssociationSensitivity,
  NodeKind,
} from './types.js'

const INTAKE_SOURCE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/u
const HOUR_MS = 3_600_000

export interface AssociationIntakeSignalConfig {
  readonly enabled?: boolean
  readonly minScore?: number
  readonly maxSignalsPerHour?: number
  readonly cooldownMs?: number
  readonly maxSummaryBytes?: number
  readonly sourceId?: string
  readonly budgetId?: string
  readonly budgetAmount?: number
}

export interface AssociationIntakeSignalNormalizedConfig {
  readonly enabled: boolean
  readonly minScore: number
  readonly maxSignalsPerHour: number
  readonly cooldownMs: number
  readonly maxSummaryBytes: number
  readonly sourceId: string
  readonly budgetId?: string
  readonly budgetAmount?: number
}

export const DEFAULT_ASSOCIATION_INTAKE_SIGNAL_CONFIG: AssociationIntakeSignalNormalizedConfig =
  Object.freeze({
    enabled: false,
    minScore: 0.75,
    maxSignalsPerHour: 10,
    cooldownMs: 3_600_000,
    maxSummaryBytes: 1024,
    sourceId: 'assistant-association',
  })

export function normalizeAssociationIntakeSignalConfig(
  raw?: AssociationIntakeSignalConfig,
): AssociationIntakeSignalNormalizedConfig {
  const minScore =
    typeof raw?.minScore === 'number' && Number.isFinite(raw.minScore) && raw.minScore >= 0
      ? raw.minScore
      : DEFAULT_ASSOCIATION_INTAKE_SIGNAL_CONFIG.minScore
  const maxSignalsPerHour =
    typeof raw?.maxSignalsPerHour === 'number' &&
    Number.isFinite(raw.maxSignalsPerHour) &&
    raw.maxSignalsPerHour >= 0
      ? Math.floor(raw.maxSignalsPerHour)
      : DEFAULT_ASSOCIATION_INTAKE_SIGNAL_CONFIG.maxSignalsPerHour
  const cooldownMs =
    typeof raw?.cooldownMs === 'number' && Number.isFinite(raw.cooldownMs) && raw.cooldownMs >= 0
      ? Math.floor(raw.cooldownMs)
      : DEFAULT_ASSOCIATION_INTAKE_SIGNAL_CONFIG.cooldownMs
  const maxSummaryBytes =
    typeof raw?.maxSummaryBytes === 'number' &&
    Number.isFinite(raw.maxSummaryBytes) &&
    raw.maxSummaryBytes >= 64
      ? Math.min(65_536, Math.floor(raw.maxSummaryBytes))
      : DEFAULT_ASSOCIATION_INTAKE_SIGNAL_CONFIG.maxSummaryBytes
  const sourceId =
    typeof raw?.sourceId === 'string' && INTAKE_SOURCE_ID_RE.test(raw.sourceId)
      ? raw.sourceId
      : DEFAULT_ASSOCIATION_INTAKE_SIGNAL_CONFIG.sourceId

  return Object.freeze({
    enabled: raw?.enabled === true,
    minScore,
    maxSignalsPerHour,
    cooldownMs,
    maxSummaryBytes,
    sourceId,
    ...(typeof raw?.budgetId === 'string' && raw.budgetId.length > 0
      ? { budgetId: raw.budgetId }
      : {}),
    ...(typeof raw?.budgetAmount === 'number' &&
    Number.isFinite(raw.budgetAmount) &&
    raw.budgetAmount > 0
      ? { budgetAmount: raw.budgetAmount }
      : {}),
  })
}

export interface IntakeSignalPolicyRequest {
  readonly subject: {
    readonly kind: 'background'
    readonly id: 'assistant-association'
    readonly workspace: string
    readonly principal: string
  }
  readonly action: 'intake-observe'
  readonly resource: {
    readonly kind: 'automation'
    readonly id: 'assistant-association:intake-signal'
  }
  readonly context: {
    readonly initiator: 'background'
  }
}

export interface IntakeSignalPolicyDecision {
  readonly effect: 'allow' | 'deny'
  readonly reasonCode?: string
  readonly ruleId?: string | undefined
}

export interface IntakeSignalPolicyPeer {
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
  readonly authorize?: (
    request: IntakeSignalPolicyRequest,
    options?: { readonly idempotencyKey?: string; readonly auditDetails?: unknown },
  ) => IntakeSignalPolicyDecision
  readonly evaluate?: (request: IntakeSignalPolicyRequest) => IntakeSignalPolicyDecision
}

/**
 * Exact closed 10-key subset of `WorkItemIntakeInput` permitted for
 * association observe-only signals. Never carries `groupMessage`,
 * `objective`, `objectiveDigest`, or `acceptance`.
 */
export interface AssociationWorkItemIntakeInput {
  readonly source: string
  readonly sourceEventId: string
  readonly kind: 'event'
  readonly senderAllowlisted: true
  readonly addressed: false
  readonly threadFollowUp: false
  readonly senderIsBot: true
  readonly subscribed: true
  readonly contentDigest: string
  readonly occurredAt: number
}

export interface IntakeSignalWorkItemsPeer {
  readonly recordIntake: (
    input: AssociationWorkItemIntakeInput,
    sourceText?: string,
  ) => {
    readonly record: {
      readonly source: string
      readonly sourceEventId: string
      readonly kind: 'message' | 'event'
      readonly decision: 'stored' | 'duplicate' | 'filtered'
      readonly strength: 'explicit' | 'inferred' | 'ignore'
      readonly strengthReason: string
      readonly contentDigest: string | null
    }
    readonly replayed: boolean
  }
}

export interface IntakeSignalNodeRef {
  readonly id: string
  readonly kind: NodeKind
  readonly ownerScopeKey: string
  readonly sensitivity: AssociationSensitivity
  readonly status: AssociationNodeStatus
  readonly title: string
  readonly expiresAt?: number | null
}

export type AssociationIntakeSignalOutcome =
  | 'disabled'
  | 'holdout-blocked'
  | 'ineligible-node'
  | 'score-below-threshold'
  | 'emergency-stop'
  | 'policy-unavailable'
  | 'policy-denied'
  | 'budget-unavailable'
  | 'cooldown-active'
  | 'hourly-cap-exceeded'
  | 'work-items-unavailable'
  | 'work-items-disabled'
  | 'work-items-error'
  | 'recorded'
  | 'duplicate'
  | 'filtered'

export interface EmitAssociationIntakeSignalInput {
  readonly db: DatabaseSync
  readonly scope: AssociationOwnerScope
  readonly config: AssociationIntakeSignalNormalizedConfig
  readonly goalNode: IntakeSignalNodeRef
  readonly targetNode: IntakeSignalNodeRef
  readonly score: number
  readonly reason?: string
  readonly inHoldout: boolean
  readonly policy?: IntakeSignalPolicyPeer
  readonly assistantWorkItems?: IntakeSignalWorkItemsPeer
  readonly budgetId?: string
  readonly budgetAmount?: number
  readonly nowMs?: number
}

export interface EmitAssociationIntakeSignalResult {
  readonly emitted: boolean
  readonly outcome: AssociationIntakeSignalOutcome
  readonly signalId: string | null
  readonly sourceEventId: string | null
  readonly intakeInput: AssociationWorkItemIntakeInput | null
  readonly sourceText: string | null
  readonly policyReasonCode?: string
  readonly errorMessage?: string
}

export interface StoredIntakeSignalRow {
  readonly signalId: string
  readonly ownerScopeKey: string
  readonly goalNodeId: string
  readonly targetNodeId: string
  readonly sourceEventId: string
  readonly score: number
  readonly outcome: string
  readonly createdAt: number
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function ensureIntakeSignalSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assoc_intake_signals (
      signal_id TEXT PRIMARY KEY,
      owner_scope_key TEXT NOT NULL,
      goal_node_id TEXT NOT NULL,
      target_node_id TEXT NOT NULL,
      source_event_id TEXT NOT NULL UNIQUE,
      score REAL NOT NULL,
      outcome TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS assoc_intake_signals_scope_time
      ON assoc_intake_signals(owner_scope_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS assoc_intake_signals_cooldown
      ON assoc_intake_signals(owner_scope_key, goal_node_id, target_node_id, created_at DESC);
  `)
}

function hasTable(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { ok: number } | undefined
  return row !== undefined
}

function stripControlsAndRedact(raw: string): string {
  let cleaned = ''
  for (const ch of raw.normalize('NFKC')) {
    const code = ch.codePointAt(0)!
    if (code === 0x00 || (code < 0x20 && code !== 0x20) || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      cleaned += ' '
    } else {
      cleaned += ch
    }
  }
  return cleaned
    .replace(/\b(?:sk|pk|tok|token|secret|Bearer)[_-]?[A-Za-z0-9._-]{12,}\b/gu, '[redacted]')
    .replace(/\s+/gu, ' ')
    .trim()
}

function truncateUtf8(text: string, maxBytes: number): string {
  const safe = text.toWellFormed()
  if (Buffer.byteLength(safe, 'utf8') <= maxBytes) return safe
  let out = ''
  let used = 0
  for (const ch of safe) {
    const bytes = Buffer.byteLength(ch, 'utf8')
    if (used + bytes > maxBytes) break
    out += ch
    used += bytes
  }
  return out.trimEnd()
}

export function buildAssociationIntakeSummary(input: {
  readonly goalNode: Pick<IntakeSignalNodeRef, 'id' | 'title'>
  readonly targetNode: Pick<IntakeSignalNodeRef, 'id' | 'kind' | 'title'>
  readonly score: number
  readonly reason?: string
  readonly maxSummaryBytes: number
}): { readonly sourceText: string; readonly contentDigest: string } {
  const goalTitle = stripControlsAndRedact(input.goalNode.title) || input.goalNode.id
  const targetTitle = stripControlsAndRedact(input.targetNode.title) || input.targetNode.id
  const reasonPart =
    input.reason !== undefined && input.reason.length > 0
      ? ` via ${stripControlsAndRedact(input.reason)}`
      : ''
  const rawSummary = `Association observe signal (score=${input.score.toFixed(3)}${reasonPart}): goal="${goalTitle}" matched ${input.targetNode.kind} "${targetTitle}"`
  const bounded = truncateUtf8(rawSummary, Math.max(64, input.maxSummaryBytes))
  const sourceText = bounded.length > 0 ? bounded : 'Association observe signal'
  const contentDigest = sha256Hex(sourceText)
  return { sourceText, contentDigest }
}

export function buildAssociationWorkItemIntakeInput(input: {
  readonly sourceId: string
  readonly sourceEventId: string
  readonly contentDigest: string
  readonly occurredAt: number
}): AssociationWorkItemIntakeInput {
  return Object.freeze({
    source: input.sourceId,
    sourceEventId: input.sourceEventId,
    kind: 'event' as const,
    senderAllowlisted: true as const,
    addressed: false as const,
    threadFollowUp: false as const,
    senderIsBot: true as const,
    subscribed: true as const,
    contentDigest: input.contentDigest,
    occurredAt: input.occurredAt,
  })
}

function buildPolicyRequest(scope: AssociationOwnerScope): IntakeSignalPolicyRequest {
  return {
    subject: {
      kind: 'background',
      id: 'assistant-association',
      workspace: scope.workspace,
      principal: scope.principalId,
    },
    action: 'intake-observe',
    resource: {
      kind: 'automation',
      id: 'assistant-association:intake-signal',
    },
    context: {
      initiator: 'background',
    },
  }
}

function isNodeActiveAndPrivate(
  node: IntakeSignalNodeRef,
  ownerScopeKey: string,
  nowMs: number,
): boolean {
  if (node.ownerScopeKey !== ownerScopeKey) return false
  if (node.status !== 'active') return false
  if (node.sensitivity !== 'private') return false
  if (node.expiresAt !== undefined && node.expiresAt !== null && node.expiresAt <= nowMs) {
    return false
  }
  return true
}

function failResult(
  outcome: AssociationIntakeSignalOutcome,
  extra?: {
    readonly signalId?: string | null
    readonly sourceEventId?: string | null
    readonly intakeInput?: AssociationWorkItemIntakeInput | null
    readonly sourceText?: string | null
    readonly policyReasonCode?: string
    readonly errorMessage?: string
  },
): EmitAssociationIntakeSignalResult {
  return {
    emitted: false,
    outcome,
    signalId: extra?.signalId ?? null,
    sourceEventId: extra?.sourceEventId ?? null,
    intakeInput: extra?.intakeInput ?? null,
    sourceText: extra?.sourceText ?? null,
    ...(extra?.policyReasonCode !== undefined
      ? { policyReasonCode: extra.policyReasonCode }
      : {}),
    ...(extra?.errorMessage !== undefined ? { errorMessage: extra.errorMessage } : {}),
  }
}

function isWorkItemsDisabledError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'disabled'
  )
}

export function emitAssociationIntakeSignal(
  input: EmitAssociationIntakeSignalInput,
): EmitAssociationIntakeSignalResult {
  const nowMs = input.nowMs ?? Date.now()

  // Gate 1: explicit opt-in toggle
  if (!input.config.enabled) {
    return failResult('disabled')
  }

  // Gate 2: sealed holdout tasks NEVER trigger intake signals
  if (input.inHoldout) {
    return failResult('holdout-blocked')
  }

  // Gate 3: goal + private sensitivity + minimum score
  if (
    input.goalNode.kind !== 'goal' ||
    input.goalNode.id === input.targetNode.id ||
    !isNodeActiveAndPrivate(input.goalNode, input.scope.ownerScopeKey, nowMs) ||
    !isNodeActiveAndPrivate(input.targetNode, input.scope.ownerScopeKey, nowMs)
  ) {
    return failResult('ineligible-node')
  }

  if (!Number.isFinite(input.score) || input.score < input.config.minScore) {
    return failResult('score-below-threshold')
  }

  // Gate 4: Policy (fail closed)
  if (input.policy === undefined) {
    return failResult('policy-unavailable')
  }
  if (input.policy.getEmergencyStop?.()?.enabled === true) {
    return failResult('emergency-stop')
  }

  const budgetId = input.budgetId ?? input.config.budgetId
  const budgetAmount = input.budgetAmount ?? input.config.budgetAmount ?? 1
  if (budgetId !== undefined) {
    if (typeof input.policy.getBudgetConfig !== 'function') {
      return failResult('budget-unavailable')
    }
    const budget = input.policy.getBudgetConfig(budgetId)
    if (budget === undefined || !Number.isFinite(budget.limit) || budget.limit < budgetAmount) {
      return failResult('budget-unavailable')
    }
  }

  ensureIntakeSignalSchema(input.db)

  // Gate 5: Per-(ownerScopeKey, goalNode.id, targetNode.id) cooldown and hourly cap
  if (input.config.cooldownMs > 0) {
    const lastPairRow = input.db
      .prepare(`
        SELECT MAX(created_at) AS last_at
        FROM assoc_intake_signals
        WHERE owner_scope_key = ?
          AND goal_node_id = ?
          AND target_node_id = ?
          AND outcome IN ('recorded', 'duplicate', 'filtered')
      `)
      .get(input.scope.ownerScopeKey, input.goalNode.id, input.targetNode.id) as
      | { last_at: number | null }
      | undefined
    if (
      typeof lastPairRow?.last_at === 'number' &&
      Number.isFinite(lastPairRow.last_at) &&
      nowMs - lastPairRow.last_at < input.config.cooldownMs
    ) {
      return failResult('cooldown-active')
    }
  }

  if (input.config.maxSignalsPerHour <= 0) {
    return failResult('hourly-cap-exceeded')
  }

  const hourRow = input.db
    .prepare(`
      SELECT COUNT(*) AS cnt
      FROM assoc_intake_signals
      WHERE owner_scope_key = ?
        AND created_at >= ?
        AND outcome IN ('recorded', 'duplicate', 'filtered')
    `)
    .get(input.scope.ownerScopeKey, nowMs - HOUR_MS) as { cnt: number } | undefined
  if ((hourRow?.cnt ?? 0) >= input.config.maxSignalsPerHour) {
    return failResult('hourly-cap-exceeded')
  }

  const pairCountRow = input.db
    .prepare(`
      SELECT COUNT(*) AS cnt
      FROM assoc_intake_signals
      WHERE owner_scope_key = ? AND goal_node_id = ? AND target_node_id = ?
    `)
    .get(input.scope.ownerScopeKey, input.goalNode.id, input.targetNode.id) as
    | { cnt: number }
    | undefined
  const attemptOrdinal = pairCountRow?.cnt ?? 0

  const sourceEventId = `assoc-${sha256Hex(
    `${input.scope.ownerScopeKey}\0${input.goalNode.id}\0${input.targetNode.id}\0${nowMs}\0${attemptOrdinal}`,
  ).slice(0, 48)}`
  const signalId = `sig-${sha256Hex(`${sourceEventId}\0signal`).slice(0, 24)}`

  const policyRequest = buildPolicyRequest(input.scope)
  let policyDecision: IntakeSignalPolicyDecision | undefined
  if (typeof input.policy.authorize === 'function') {
    policyDecision = input.policy.authorize(policyRequest, { idempotencyKey: signalId })
  } else if (typeof input.policy.evaluate === 'function') {
    policyDecision = input.policy.evaluate(policyRequest)
  }

  if (policyDecision === undefined) {
    return failResult('policy-unavailable')
  }
  if (policyDecision.effect !== 'allow') {
    return failResult(
      'policy-denied',
      policyDecision.reasonCode === undefined
        ? undefined
        : { policyReasonCode: policyDecision.reasonCode },
    )
  }

  if (input.assistantWorkItems === undefined || typeof input.assistantWorkItems.recordIntake !== 'function') {
    return failResult('work-items-unavailable')
  }

  const { sourceText, contentDigest } = buildAssociationIntakeSummary({
    goalNode: input.goalNode,
    targetNode: input.targetNode,
    score: input.score,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    maxSummaryBytes: input.config.maxSummaryBytes,
  })

  const intakeInput = buildAssociationWorkItemIntakeInput({
    sourceId: input.config.sourceId,
    sourceEventId,
    contentDigest,
    occurredAt: nowMs,
  })

  let outcome: AssociationIntakeSignalOutcome
  let emitted = false
  let errorMessage: string | undefined

  try {
    const result = input.assistantWorkItems.recordIntake(intakeInput, sourceText)
    if (result.record.decision === 'filtered') {
      outcome = 'filtered'
    } else if (result.replayed || result.record.decision === 'duplicate') {
      outcome = 'duplicate'
      emitted = true
    } else {
      outcome = 'recorded'
      emitted = true
    }
  } catch (error) {
    if (isWorkItemsDisabledError(error)) {
      outcome = 'work-items-disabled'
      errorMessage = error instanceof Error ? error.message : String(error)
    } else {
      outcome = 'work-items-error'
      errorMessage = error instanceof Error ? error.message : String(error)
    }
  }

  input.db
    .prepare(`
      INSERT INTO assoc_intake_signals (
        signal_id, owner_scope_key, goal_node_id, target_node_id,
        source_event_id, score, outcome, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      signalId,
      input.scope.ownerScopeKey,
      input.goalNode.id,
      input.targetNode.id,
      sourceEventId,
      input.score,
      outcome,
      nowMs,
    )

  return {
    emitted,
    outcome,
    signalId,
    sourceEventId,
    intakeInput,
    sourceText,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  }
}

export function listIntakeSignals(
  db: DatabaseSync,
  ownerScopeKey: string,
  limit = 50,
): readonly StoredIntakeSignalRow[] {
  if (!hasTable(db, 'assoc_intake_signals')) return []
  const rows = db
    .prepare(`
      SELECT signal_id, owner_scope_key, goal_node_id, target_node_id,
             source_event_id, score, outcome, created_at
      FROM assoc_intake_signals
      WHERE owner_scope_key = ?
      ORDER BY created_at DESC, signal_id ASC
      LIMIT ?
    `)
    .all(ownerScopeKey, Math.max(1, Math.min(500, limit))) as Array<{
    signal_id: string
    owner_scope_key: string
    goal_node_id: string
    target_node_id: string
    source_event_id: string
    score: number
    outcome: string
    created_at: number
  }>

  return rows.map((row) => ({
    signalId: row.signal_id,
    ownerScopeKey: row.owner_scope_key,
    goalNodeId: row.goal_node_id,
    targetNodeId: row.target_node_id,
    sourceEventId: row.source_event_id,
    score: row.score,
    outcome: row.outcome,
    createdAt: row.created_at,
  }))
}
