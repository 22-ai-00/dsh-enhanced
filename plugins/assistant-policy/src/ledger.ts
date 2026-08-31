import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { redactAuditValue } from './redaction.js'
import { legacyApprovalIntentHash, openPolicyDatabase, PolicyDatabaseError } from './sqlite.js'

export type PolicyLedgerErrorCode =
  | 'budget-exhausted'
  | 'idempotency-conflict'
  | 'invalid-input'
  | 'invalid-path'
  | 'invalid-state'
  | 'legacy-unverifiable'
  | 'not-found'
  | 'schema-too-new'
  | 'unauthorized'
  | 'version-conflict'

export class PolicyLedgerError extends Error {
  constructor(readonly code: PolicyLedgerErrorCode, message: string) {
    super(message)
    this.name = 'PolicyLedgerError'
  }
}

export interface PolicyLedgerOptions {
  path: string
  now?: () => number
}

/** Shared byte contract for Policy, Delivery, and channel approval rendering. */
export const APPROVAL_DISPLAY_BUDGET = Object.freeze({
  maxTextBytes: 64 * 1_024,
  maxSummaryBytes: 120,
  renderingReserveBytes: 4 * 1_024,
  maxDiffBytes: 60 * 1_024,
})

export interface BudgetReservationInput {
  scope: string
  metric: string
  limit: number
  amount: number
  periodMs: number
  idempotencyKey: string
}

export interface BudgetReservationResult {
  reservationId: string
  status: 'finalized' | 'released' | 'reserved'
  periodStart: number
  remaining: number
  replayed: boolean
}

export interface EmergencyStopState {
  enabled: boolean
  reason: string | undefined
  actor: string | undefined
  updatedAt: number | undefined
  version: number
}

export interface ApprovalProposalInput {
  idempotencyKey: string
  requester: string
  principal: string
  action: string
  resource: { kind: string; id: string }
  diff: string
  summary: string
  ttlMs: number
  dispatch?: Readonly<ApprovalDispatchRouteV2>
}

/**
 * Durable-domain creation input with an absolute deadline. Unlike `ttlMs`, the
 * deadline cannot move forward when a process restarts or loses a cross-database
 * commit acknowledgement.
 */
export interface ApprovalProposalRecoveryInput {
  idempotencyKey: string
  requester: string
  principal: string
  action: string
  resource: { kind: string; id: string }
  diff: string
  summary: string
  notAfter: number
  dispatch?: Readonly<ApprovalDispatchRouteV2>
}

export interface ApprovalDispatchRouteV1 {
  /** Omitted by pre-v2 callers and persisted explicitly as route version 1. */
  routeVersion?: 1
  sourceId: string
  bindingId: string
  workspace: string
  principal: string
}

export interface ApprovalDispatchRouteV2 {
  routeVersion: 2
  sourceId: string
  bindingId: string
  bindingVersion: number
  bindingGeneration: number
  workspace: string
  principal: string
  principalRecordId: string
  principalVersion: number
}

export type ApprovalDispatchRoute = ApprovalDispatchRouteV1 | ApprovalDispatchRouteV2

export type ApprovalProposalStatus = 'approved' | 'expired' | 'pending' | 'rejected'

export interface ApprovalProposalResult {
  proposalId: string
  status: ApprovalProposalStatus
  diffHash: string
  expiresAt: number
  version: number
  replayed: boolean
}

export type ApprovalProposalRecoveryResult =
  | Readonly<{ kind: 'proposal'; proposal: ApprovalProposalResult }>
  | Readonly<{
      kind: 'abandoned'
      idempotencyKey: string
      notAfter: number
      abandonedAt: number
      replayed: boolean
    }>

export interface ApprovalDecisionInput {
  proposalId: string
  principal: string
  expectedVersion: number
  decision: 'approved' | 'rejected'
  reason: string
}

/**
 * Terminal-decision snapshot of one proposal, exposed so the domain that owns the
 * pending operation can discover the decision and commit it through its own gate.
 * Policy never calls back into a domain, so this read seam is the only supported
 * way to close that loop.
 */
export interface ApprovalProposalSnapshot {
  proposalId: string
  requester: string
  principal: string
  action: string
  resource: { kind: string; id: string }
  summary: string
  status: ApprovalProposalStatus
  diffHash: string
  expiresAt: number
  version: number
  decidedBy: string | undefined
  decisionReason: string | undefined
}

/**
 * Exact, authority-scoped identity used by a domain to recover a proposal whose
 * Policy commit may have succeeded before the domain persisted its proposal ID.
 * This lookup is deliberately read-only and does not accept proposal content or
 * TTL, so it can never create, replay, or extend a proposal.
 */
export interface ApprovalProposalLookupInput {
  idempotencyKey: string
  requester: string
  principal: string
  action: string
  resource: { kind: string; id: string }
}

export type ApprovalDispatchState = 'enqueued' | 'pending' | 'quarantined'

/** Stable high-water mark for a pending-dispatch scan. */
export interface ApprovalDispatchCursor {
  createdAt: number
  proposalId: string
}

/**
 * Immutable, policy-derived payload and route for one durable approval delivery.
 * Callers can choose when to enqueue it, but cannot substitute display content.
 */
interface ApprovalDispatchSnapshotBase {
  proposalId: string
  requester: string
  action: string
  resource: { kind: string; id: string }
  summary: string
  diff: string
  diffHash: string
  payloadHash: string
  expiresAt: number
  proposalVersion: number
  state: ApprovalDispatchState
  createdAt: number
  enqueuedAt: number | undefined
  version: number
}

export type ApprovalDispatchSnapshot = Readonly<ApprovalDispatchSnapshotBase & (
  | (ApprovalDispatchRouteV1 & { routeVersion: 1 })
  | ApprovalDispatchRouteV2
)>

export interface ApprovalDispatchResult {
  proposalId: string
  state: 'enqueued'
  payloadHash: string
  enqueuedAt: number
  version: number
  replayed: boolean
}

export interface AuditInput {
  actor: string
  action: string
  resource: { kind: string; id: string }
  outcome: string
  reasonCode: string
  details: unknown
}

export interface AuditEvent {
  sequence: number
  eventId: string
  occurredAt: number
  actor: string
  action: string
  resourceKind: string
  resourceHash: string
  outcome: string
  reasonCode: string
  details: unknown
}

interface ReservationRow {
  id: string
  idempotency_key: string
  scope: string
  metric: string
  period_start: number
  period_ms: number
  amount: number
  actual_amount: number | null
  status: BudgetReservationResult['status']
}

interface PeriodRow {
  limit_amount: number
  reserved_amount: number
  spent_amount: number
}

interface ProposalRow {
  id: string
  idempotency_key: string
  requester: string
  principal: string
  action: string
  resource_kind: string
  resource_id: string
  diff_hash: string
  diff_text: string | null
  summary: string
  status: ApprovalProposalStatus
  created_at: number
  expires_at: number
  decided_by: string | null
  decision_reason: string | null
  version: number
}

interface DispatchRouteRow {
  route_version: number
  source_id: string
  binding_id: string
  binding_version: number | null
  binding_generation: number | null
  workspace: string
  dispatch_principal: string
  principal_record_id: string | null
  principal_version: number | null
}

interface DispatchRow extends DispatchRouteRow {
  proposal_id: string
  state: ApprovalDispatchState
  payload_hash: string
  dispatch_created_at: number
  enqueued_at: number | null
  dispatch_version: number
  proposal_version: number
  requester: string
  proposal_principal: string
  action: string
  resource_kind: string
  resource_id: string
  diff_hash: string
  diff_text: string | null
  summary: string
  status: ApprovalProposalStatus
  expires_at: number
  current_proposal_version: number
}

const textLimits = Object.freeze({
  id: 512,
  action: 256,
  resourceId: 4_096,
  workspace: 4_096,
  principalRecordId: 500,
  summary: APPROVAL_DISPLAY_BUDGET.maxSummaryBytes,
  diff: APPROVAL_DISPLAY_BUDGET.maxDiffBytes,
  reason: 2_048,
})

function requireText(value: string, field: string): void {
  if (value.trim() === '') throw new PolicyLedgerError('invalid-input', `${field} must not be empty`)
}

function requireBoundedText(
  value: string,
  field: string,
  maxBytes: number,
  options: { allowEmpty?: boolean } = {},
): void {
  if (!options.allowEmpty) requireText(value, field)
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new PolicyLedgerError('invalid-input', `${field} must not exceed ${maxBytes} UTF-8 bytes`)
  }
}

function requirePositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PolicyLedgerError('invalid-input', `${field} must be a positive safe integer`)
  }
}

type StoredApprovalDispatchRoute =
  | (ApprovalDispatchRouteV1 & { routeVersion: 1 })
  | ApprovalDispatchRouteV2

function approvalDispatchRouteVersion(route: ApprovalDispatchRoute): 1 | 2 {
  return route.routeVersion ?? 1
}

function storedApprovalDispatchRoute(row: DispatchRouteRow): StoredApprovalDispatchRoute {
  const common = {
    sourceId: row.source_id,
    bindingId: row.binding_id,
    workspace: row.workspace,
    principal: row.dispatch_principal,
  }
  if (row.route_version === 1) {
    if (row.binding_version !== null || row.binding_generation !== null
      || row.principal_record_id !== null || row.principal_version !== null) {
      throw new PolicyLedgerError('invalid-state', 'legacy approval dispatch contains v2 authority fields')
    }
    return Object.freeze({ routeVersion: 1 as const, ...common })
  }
  const bindingVersion = row.binding_version
  const bindingGeneration = row.binding_generation
  const principalRecordId = row.principal_record_id
  const principalVersion = row.principal_version
  if (row.route_version !== 2
    || !Number.isSafeInteger(bindingVersion) || bindingVersion === null || bindingVersion <= 0
    || !Number.isSafeInteger(bindingGeneration) || bindingGeneration === null || bindingGeneration <= 0
    || typeof principalRecordId !== 'string'
    || principalRecordId.trim() === ''
    || Buffer.byteLength(principalRecordId, 'utf8') > textLimits.principalRecordId
    || !Number.isSafeInteger(principalVersion) || principalVersion === null || principalVersion <= 0) {
    throw new PolicyLedgerError('invalid-state', 'approval dispatch v2 authority fields are invalid')
  }
  return Object.freeze({
    routeVersion: 2 as const,
    ...common,
    bindingVersion,
    bindingGeneration,
    principalRecordId,
    principalVersion,
  })
}

function sameApprovalDispatchRoute(
  stored: StoredApprovalDispatchRoute,
  input: ApprovalDispatchRoute,
): boolean {
  const routeVersion = approvalDispatchRouteVersion(input)
  if (stored.routeVersion !== routeVersion
    || stored.sourceId !== input.sourceId
    || stored.bindingId !== input.bindingId
    || stored.workspace !== input.workspace
    || stored.principal !== input.principal) return false
  return routeVersion === 1 || (stored.routeVersion === 2 && input.routeVersion === 2
    && stored.bindingVersion === input.bindingVersion
    && stored.bindingGeneration === input.bindingGeneration
    && stored.principalRecordId === input.principalRecordId
    && stored.principalVersion === input.principalVersion)
}

function dispatchPayloadHash(input: {
  proposalId: string
  route: ApprovalDispatchRoute
  requester: string
  action: string
  resourceKind: string
  resourceId: string
  summary: string
  diff: string
  diffHash: string
  expiresAt: number
  proposalVersion: number
}): string {
  const canonicalPayload = JSON.stringify(input.route.routeVersion === 2
    ? [
        'approval-dispatch-payload-v2',
        input.proposalId,
        input.route.sourceId,
        input.route.bindingId,
        input.route.bindingVersion,
        input.route.bindingGeneration,
        input.route.workspace,
        input.route.principal,
        input.route.principalRecordId,
        input.route.principalVersion,
        input.requester,
        input.action,
        input.resourceKind,
        input.resourceId,
        input.summary,
        input.diff,
        input.diffHash,
        input.expiresAt,
        input.proposalVersion,
      ]
    : [
        input.proposalId,
        input.route.sourceId,
        input.route.bindingId,
        input.route.workspace,
        input.route.principal,
        input.requester,
        input.action,
        input.resourceKind,
        input.resourceId,
        input.summary,
        input.diff,
        input.diffHash,
        input.expiresAt,
        input.proposalVersion,
      ])
  return createHash('sha256').update(canonicalPayload).digest('hex')
}

/**
 * Canonical identity of an abandoned recovery attempt. The raw diff participates
 * in the digest but is never persisted in a tombstone.
 */
function approvalRecoveryIntentHash(input: ApprovalProposalRecoveryInput): string {
  const dispatch = input.dispatch
  const canonicalIntent = JSON.stringify(dispatch?.routeVersion === 2
    ? [
        'approval-recovery-intent-v2',
        input.idempotencyKey,
        input.notAfter,
        input.requester,
        input.principal,
        input.action,
        input.resource.kind,
        input.resource.id,
        input.diff,
        input.summary,
        1,
        dispatch.sourceId,
        dispatch.bindingId,
        dispatch.bindingVersion,
        dispatch.bindingGeneration,
        dispatch.workspace,
        dispatch.principal,
        dispatch.principalRecordId,
        dispatch.principalVersion,
      ]
    : [
        'approval-recovery-intent-v1',
        input.idempotencyKey,
        input.notAfter,
        input.requester,
        input.principal,
        input.action,
        input.resource.kind,
        input.resource.id,
        input.diff,
        input.summary,
        dispatch === undefined ? 0 : 1,
        dispatch?.sourceId ?? null,
        dispatch?.bindingId ?? null,
        dispatch?.workspace ?? null,
        dispatch?.principal ?? null,
      ])
  return createHash('sha256').update(canonicalIntent).digest('hex')
}

function requirePositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new PolicyLedgerError('invalid-input', `${field} must be a positive finite number`)
  }
}

function requirePeriod(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PolicyLedgerError('invalid-input', 'periodMs must be a positive safe integer')
  }
}

export class PolicyLedger {
  readonly #database: DatabaseSync
  readonly #now: () => number
  #closed = false

  constructor(options: PolicyLedgerOptions) {
    this.#now = options.now ?? Date.now
    try {
      this.#database = openPolicyDatabase(options.path)
    } catch (error) {
      if (error instanceof PolicyDatabaseError) {
        throw new PolicyLedgerError(error.code, error.message)
      }
      throw error
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#database.close()
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const value = operation()
      this.#database.exec('COMMIT')
      return value
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  #period(row: ReservationRow): PeriodRow {
    const period = this.#database.prepare(`
      SELECT limit_amount, reserved_amount, spent_amount
      FROM budget_periods
      WHERE scope = ? AND metric = ? AND period_start = ? AND period_ms = ?
    `).get(row.scope, row.metric, row.period_start, row.period_ms) as PeriodRow | undefined
    if (period === undefined) throw new PolicyLedgerError('invalid-state', 'reservation budget period is missing')
    return period
  }

  #result(row: ReservationRow, replayed: boolean): BudgetReservationResult {
    const period = this.#period(row)
    return {
      reservationId: row.id,
      status: row.status,
      periodStart: row.period_start,
      remaining: period.limit_amount - period.reserved_amount - period.spent_amount,
      replayed,
    }
  }

  reserve(input: BudgetReservationInput): BudgetReservationResult {
    requireText(input.scope, 'scope')
    requireText(input.metric, 'metric')
    requireText(input.idempotencyKey, 'idempotencyKey')
    requirePositive(input.limit, 'limit')
    requirePositive(input.amount, 'amount')
    requirePeriod(input.periodMs)
    const now = this.#now()
    const periodStart = Math.floor(now / input.periodMs) * input.periodMs

    return this.#transaction(() => {
      const existing = this.#database.prepare(`
        SELECT id, idempotency_key, scope, metric, period_start, period_ms,
               amount, actual_amount, status
        FROM budget_reservations WHERE idempotency_key = ?
      `).get(input.idempotencyKey) as ReservationRow | undefined
      if (existing !== undefined) {
        const sameInput = existing.scope === input.scope
          && existing.metric === input.metric
          && existing.period_ms === input.periodMs
          && existing.amount === input.amount
        if (!sameInput) {
          throw new PolicyLedgerError('idempotency-conflict', 'idempotency key was used for another reservation')
        }
        return this.#result(existing, true)
      }

      this.#database.prepare(`
        INSERT INTO budget_periods(
          scope, metric, period_start, period_ms, limit_amount, reserved_amount, spent_amount
        ) VALUES (?, ?, ?, ?, ?, 0, 0)
        ON CONFLICT(scope, metric, period_start, period_ms) DO NOTHING
      `).run(input.scope, input.metric, periodStart, input.periodMs, input.limit)

      const period = this.#database.prepare(`
        SELECT limit_amount, reserved_amount, spent_amount
        FROM budget_periods
        WHERE scope = ? AND metric = ? AND period_start = ? AND period_ms = ?
      `).get(input.scope, input.metric, periodStart, input.periodMs) as unknown as PeriodRow
      if (period.limit_amount !== input.limit) {
        throw new PolicyLedgerError('idempotency-conflict', 'budget limit changed within an active period')
      }
      if (period.reserved_amount + period.spent_amount + input.amount > period.limit_amount) {
        throw new PolicyLedgerError('budget-exhausted', 'hard budget is exhausted')
      }

      const id = randomUUID()
      this.#database.prepare(`
        INSERT INTO budget_reservations(
          id, idempotency_key, scope, metric, period_start, period_ms,
          amount, actual_amount, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'reserved', ?, ?)
      `).run(
        id,
        input.idempotencyKey,
        input.scope,
        input.metric,
        periodStart,
        input.periodMs,
        input.amount,
        now,
        now,
      )
      this.#database.prepare(`
        UPDATE budget_periods
        SET reserved_amount = reserved_amount + ?, version = version + 1
        WHERE scope = ? AND metric = ? AND period_start = ? AND period_ms = ?
      `).run(input.amount, input.scope, input.metric, periodStart, input.periodMs)

      return this.#result({
        id,
        idempotency_key: input.idempotencyKey,
        scope: input.scope,
        metric: input.metric,
        period_start: periodStart,
        period_ms: input.periodMs,
        amount: input.amount,
        actual_amount: null,
        status: 'reserved',
      }, false)
    })
  }

  finalize(reservationId: string, actualAmount: number): BudgetReservationResult {
    requireText(reservationId, 'reservationId')
    if (!Number.isFinite(actualAmount) || actualAmount < 0) {
      throw new PolicyLedgerError('invalid-input', 'actualAmount must be a non-negative finite number')
    }

    return this.#transaction(() => {
      const row = this.#reservation(reservationId)
      if (row.status === 'finalized') {
        if (row.actual_amount !== actualAmount) {
          throw new PolicyLedgerError('idempotency-conflict', 'reservation was finalized with another amount')
        }
        return this.#result(row, true)
      }
      if (row.status !== 'reserved') {
        throw new PolicyLedgerError('invalid-state', `cannot finalize a ${row.status} reservation`)
      }
      if (actualAmount > row.amount) {
        throw new PolicyLedgerError('invalid-input', 'actualAmount cannot exceed the reserved amount')
      }

      this.#database.prepare(`
        UPDATE budget_periods
        SET reserved_amount = reserved_amount - ?, spent_amount = spent_amount + ?, version = version + 1
        WHERE scope = ? AND metric = ? AND period_start = ? AND period_ms = ?
      `).run(row.amount, actualAmount, row.scope, row.metric, row.period_start, row.period_ms)
      this.#database.prepare(`
        UPDATE budget_reservations
        SET status = 'finalized', actual_amount = ?, updated_at = ?, version = version + 1
        WHERE id = ?
      `).run(actualAmount, this.#now(), row.id)
      return this.#result({ ...row, status: 'finalized', actual_amount: actualAmount }, false)
    })
  }

  release(reservationId: string): BudgetReservationResult {
    requireText(reservationId, 'reservationId')
    return this.#transaction(() => {
      const row = this.#reservation(reservationId)
      if (row.status === 'released') return this.#result(row, true)
      if (row.status !== 'reserved') {
        throw new PolicyLedgerError('invalid-state', `cannot release a ${row.status} reservation`)
      }

      this.#database.prepare(`
        UPDATE budget_periods
        SET reserved_amount = reserved_amount - ?, version = version + 1
        WHERE scope = ? AND metric = ? AND period_start = ? AND period_ms = ?
      `).run(row.amount, row.scope, row.metric, row.period_start, row.period_ms)
      this.#database.prepare(`
        UPDATE budget_reservations
        SET status = 'released', updated_at = ?, version = version + 1
        WHERE id = ?
      `).run(this.#now(), row.id)
      return this.#result({ ...row, status: 'released' }, false)
    })
  }

  #reservation(id: string): ReservationRow {
    const row = this.#database.prepare(`
      SELECT id, idempotency_key, scope, metric, period_start, period_ms,
             amount, actual_amount, status
      FROM budget_reservations WHERE id = ?
    `).get(id) as ReservationRow | undefined
    if (row === undefined) throw new PolicyLedgerError('not-found', 'budget reservation was not found')
    return row
  }

  getEmergencyStop(): EmergencyStopState {
    const row = this.#database.prepare(`
      SELECT enabled, reason, actor, updated_at, version FROM emergency_state WHERE singleton = 1
    `).get() as {
      enabled: number
      reason: string
      actor: string
      updated_at: number
      version: number
    } | undefined
    if (row === undefined) {
      return { enabled: false, reason: undefined, actor: undefined, updatedAt: undefined, version: 0 }
    }
    return {
      enabled: row.enabled === 1,
      reason: row.reason,
      actor: row.actor,
      updatedAt: row.updated_at,
      version: row.version,
    }
  }

  setEmergencyStop(input: { enabled: boolean; actor: string; reason: string }): EmergencyStopState {
    requireText(input.actor, 'actor')
    requireText(input.reason, 'reason')
    const now = this.#now()
    this.#transaction(() => {
      this.#database.prepare(`
        INSERT INTO emergency_state(singleton, enabled, reason, actor, updated_at, version)
        VALUES (1, ?, ?, ?, ?, 1)
        ON CONFLICT(singleton) DO UPDATE SET
          enabled = excluded.enabled,
          reason = excluded.reason,
          actor = excluded.actor,
          updated_at = excluded.updated_at,
          version = emergency_state.version + 1
      `).run(input.enabled ? 1 : 0, input.reason, input.actor, now)
    })
    return this.getEmergencyStop()
  }

  #validateProposalContent(
    input: Omit<ApprovalProposalInput, 'ttlMs'> | Omit<ApprovalProposalRecoveryInput, 'notAfter'>,
  ): string {
    requireBoundedText(input.idempotencyKey, 'idempotencyKey', textLimits.id)
    requireBoundedText(input.requester, 'requester', textLimits.id)
    requireBoundedText(input.principal, 'principal', textLimits.id)
    requireBoundedText(input.action, 'action', textLimits.action)
    requireBoundedText(input.resource.kind, 'resource.kind', textLimits.action)
    requireBoundedText(input.resource.id, 'resource.id', textLimits.resourceId)
    requireBoundedText(input.summary, 'summary', textLimits.summary)
    requireBoundedText(input.diff, 'diff', textLimits.diff, { allowEmpty: true })
    if (input.dispatch !== undefined) {
      const routeVersion = (input.dispatch as { routeVersion?: unknown }).routeVersion
      if (routeVersion !== 2) {
        throw new PolicyLedgerError('invalid-input', 'new approval dispatch routes must use routeVersion 2')
      }
      requireBoundedText(input.dispatch.sourceId, 'dispatch.sourceId', textLimits.id)
      requireBoundedText(input.dispatch.bindingId, 'dispatch.bindingId', textLimits.id)
      requireBoundedText(input.dispatch.workspace, 'dispatch.workspace', textLimits.workspace)
      requireBoundedText(input.dispatch.principal, 'dispatch.principal', textLimits.id)
      const route = input.dispatch as ApprovalDispatchRouteV2
      requirePositiveSafeInteger(route.bindingVersion, 'dispatch.bindingVersion')
      requirePositiveSafeInteger(route.bindingGeneration, 'dispatch.bindingGeneration')
      if (typeof route.principalRecordId !== 'string') {
        throw new PolicyLedgerError('invalid-input', 'dispatch.principalRecordId must be text')
      }
      requireBoundedText(
        route.principalRecordId,
        'dispatch.principalRecordId',
        textLimits.principalRecordId,
      )
      if (route.principalRecordId.normalize('NFC').trim() !== route.principalRecordId) {
        throw new PolicyLedgerError(
          'invalid-input',
          'dispatch.principalRecordId must be normalized and trimmed',
        )
      }
      requirePositiveSafeInteger(route.principalVersion, 'dispatch.principalVersion')
      if (!isAbsolute(input.dispatch.workspace)) {
        throw new PolicyLedgerError('invalid-path', 'dispatch.workspace must be absolute')
      }
      if (input.dispatch.principal !== input.principal) {
        throw new PolicyLedgerError('unauthorized', 'dispatch route is bound to another principal')
      }
    }
    return createHash('sha256').update(input.diff).digest('hex')
  }

  #proposalByIdempotencyKey(idempotencyKey: string): ProposalRow | undefined {
    return this.#database.prepare(`
      SELECT id, idempotency_key, requester, principal, action, resource_kind,
             resource_id, diff_hash, diff_text, summary, status, created_at, expires_at, decided_by,
             decision_reason, version
      FROM approval_proposals WHERE idempotency_key = ?
    `).get(idempotencyKey) as unknown as ProposalRow | undefined
  }

  #assertExistingProposalMatches(
    existing: ProposalRow,
    input: Omit<ApprovalProposalInput, 'ttlMs'> | Omit<ApprovalProposalRecoveryInput, 'notAfter'>,
    diffHash: string,
    expiryMatches: boolean,
  ): void {
    const existingDispatch = this.#database.prepare(`
      SELECT route_version, source_id, binding_id, binding_version, binding_generation,
             workspace, principal AS dispatch_principal, principal_record_id, principal_version,
             state, payload_hash, proposal_version
      FROM approval_dispatches WHERE proposal_id = ?
    `).get(existing.id) as (DispatchRouteRow & {
      state: ApprovalDispatchState
      payload_hash: string
      proposal_version: number
    }) | undefined
    const storedRoute = existingDispatch === undefined
      ? undefined
      : storedApprovalDispatchRoute(existingDispatch)
    const sameDispatch = input.dispatch === undefined
      ? existingDispatch === undefined
      : storedRoute !== undefined && sameApprovalDispatchRoute(storedRoute, input.dispatch)
    const sameDiff = input.dispatch === undefined
      ? existingDispatch === undefined && existing.diff_hash === diffHash
      : existingDispatch !== undefined
        && existing.diff_hash === diffHash
        && (existing.diff_text === null || existing.diff_text === input.diff)
        && existingDispatch.payload_hash === dispatchPayloadHash({
          proposalId: existing.id,
          route: input.dispatch,
          requester: input.requester,
          action: input.action,
          resourceKind: input.resource.kind,
          resourceId: input.resource.id,
          summary: input.summary,
          diff: input.diff,
          diffHash,
          expiresAt: existing.expires_at,
          proposalVersion: existingDispatch.proposal_version,
        })
    const sameInput = existing.requester === input.requester
      && existing.principal === input.principal
      && existing.action === input.action
      && existing.resource_kind === input.resource.kind
      && existing.resource_id === input.resource.id
      && sameDiff
      && existing.summary === input.summary
      && expiryMatches
      && sameDispatch
    if (!sameInput) {
      throw new PolicyLedgerError('idempotency-conflict', 'idempotency key was used for another proposal')
    }
  }

  #insertProposal(
    input: Omit<ApprovalProposalInput, 'ttlMs'> | Omit<ApprovalProposalRecoveryInput, 'notAfter'>,
    diffHash: string,
    createdAt: number,
    expiresAt: number,
  ): ApprovalProposalResult {
    const id = randomUUID()
    this.#database.prepare(`
      INSERT INTO approval_proposals(
        id, idempotency_key, requester, principal, action, resource_kind,
        resource_id, diff_hash, diff_text, summary, status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      id,
      input.idempotencyKey,
      input.requester,
      input.principal,
      input.action,
      input.resource.kind,
      input.resource.id,
      diffHash,
      input.dispatch === undefined ? null : input.diff,
      input.summary,
      createdAt,
      expiresAt,
    )
    if (input.dispatch !== undefined) {
      const payloadHash = dispatchPayloadHash({
        proposalId: id,
        route: input.dispatch,
        requester: input.requester,
        action: input.action,
        resourceKind: input.resource.kind,
        resourceId: input.resource.id,
        summary: input.summary,
        diff: input.diff,
        diffHash,
        expiresAt,
        proposalVersion: 1,
      })
      this.#database.prepare(`
        INSERT INTO approval_dispatches(
          proposal_id, route_version, source_id, binding_id, binding_version,
          binding_generation, workspace, principal, principal_record_id, principal_version,
          state, payload_hash, created_at, proposal_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 1)
      `).run(
        id,
        approvalDispatchRouteVersion(input.dispatch),
        input.dispatch.sourceId,
        input.dispatch.bindingId,
        input.dispatch.routeVersion === 2 ? input.dispatch.bindingVersion : null,
        input.dispatch.routeVersion === 2 ? input.dispatch.bindingGeneration : null,
        input.dispatch.workspace,
        input.dispatch.principal,
        input.dispatch.routeVersion === 2 ? input.dispatch.principalRecordId : null,
        input.dispatch.routeVersion === 2 ? input.dispatch.principalVersion : null,
        payloadHash,
        createdAt,
      )
    }
    return {
      proposalId: id,
      status: 'pending',
      diffHash,
      expiresAt,
      version: 1,
      replayed: false,
    }
  }

  propose(input: ApprovalProposalInput): ApprovalProposalResult {
    const diffHash = this.#validateProposalContent(input)
    requirePeriod(input.ttlMs)
    const now = this.#now()
    const expiresAt = now + input.ttlMs
    if (!Number.isSafeInteger(expiresAt)) {
      throw new PolicyLedgerError('invalid-input', 'proposal expiry exceeds the safe timestamp range')
    }

    return this.#transaction(() => {
      const tombstone = this.#database.prepare(`
        SELECT idempotency_key FROM approval_idempotency_tombstones WHERE idempotency_key = ?
      `).get(input.idempotencyKey) as { idempotency_key: string } | undefined
      if (tombstone !== undefined) {
        throw new PolicyLedgerError('idempotency-conflict', 'proposal idempotency key was permanently abandoned')
      }
      const existing = this.#proposalByIdempotencyKey(input.idempotencyKey)
      if (existing !== undefined) {
        this.#assertExistingProposalMatches(
          existing,
          input,
          diffHash,
          existing.expires_at - existing.created_at === input.ttlMs,
        )
        return this.#proposalResult(existing, true)
      }
      return this.#insertProposal(input, diffHash, now, expiresAt)
    })
  }

  /**
   * Atomically recover an existing exact proposal, create it under an immutable
   * absolute deadline, or permanently abandon the idempotency key after that
   * deadline. `BEGIN IMMEDIATE` serializes this decision across Policy processes,
   * closing the lookup-then-create orphan-card race.
   */
  recoverOrCreateProposal(input: ApprovalProposalRecoveryInput): ApprovalProposalRecoveryResult {
    const diffHash = this.#validateProposalContent(input)
    if (!Number.isSafeInteger(input.notAfter) || input.notAfter < 0) {
      throw new PolicyLedgerError('invalid-input', 'proposal notAfter must be a non-negative safe integer')
    }
    const intentHash = approvalRecoveryIntentHash(input)
    return this.#transaction(() => {
      const existing = this.#proposalByIdempotencyKey(input.idempotencyKey)
      if (existing !== undefined) {
        this.#assertExistingProposalMatches(existing, input, diffHash, existing.expires_at === input.notAfter)
        return Object.freeze({
          kind: 'proposal' as const,
          proposal: this.#proposalResult(existing, true),
        })
      }
      const tombstone = this.#database.prepare(`
        SELECT idempotency_key, not_after, abandoned_at, intent_hash
        FROM approval_idempotency_tombstones WHERE idempotency_key = ?
      `).get(input.idempotencyKey) as {
        idempotency_key: string
        not_after: number
        abandoned_at: number
        intent_hash: string
      } | undefined
      if (tombstone !== undefined) {
        if (tombstone.intent_hash === legacyApprovalIntentHash || tombstone.intent_hash !== intentHash) {
          throw new PolicyLedgerError(
            'idempotency-conflict',
            'idempotency key was abandoned for another or unverifiable proposal intent',
          )
        }
        return Object.freeze({
          kind: 'abandoned' as const,
          idempotencyKey: tombstone.idempotency_key,
          notAfter: tombstone.not_after,
          abandonedAt: tombstone.abandoned_at,
          replayed: true,
        })
      }
      // Sample only after BEGIN IMMEDIATE has acquired the write lock. A value
      // read before lock acquisition could become stale while another Policy
      // process holds the transaction across the absolute deadline.
      const now = this.#now()
      if (now >= input.notAfter) {
        this.#database.prepare(`
          INSERT INTO approval_idempotency_tombstones(
            idempotency_key, not_after, abandoned_at, intent_hash
          ) VALUES (?, ?, ?, ?)
        `).run(input.idempotencyKey, input.notAfter, now, intentHash)
        return Object.freeze({
          kind: 'abandoned' as const,
          idempotencyKey: input.idempotencyKey,
          notAfter: input.notAfter,
          abandonedAt: now,
          replayed: false,
        })
      }
      return Object.freeze({
        kind: 'proposal' as const,
        proposal: this.#insertProposal(input, diffHash, now, input.notAfter),
      })
    })
  }

  decideProposal(input: ApprovalDecisionInput): ApprovalProposalResult {
    requireBoundedText(input.proposalId, 'proposalId', textLimits.id)
    requireBoundedText(input.principal, 'principal', textLimits.id)
    requireBoundedText(input.reason, 'reason', textLimits.reason)
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion <= 0) {
      throw new PolicyLedgerError('invalid-input', 'expectedVersion must be a positive safe integer')
    }

    return this.#transaction(() => {
      const proposal = this.#proposal(input.proposalId)
      if (proposal.principal !== input.principal) {
        throw new PolicyLedgerError('unauthorized', 'proposal is bound to another principal')
      }
      if (proposal.status === input.decision) {
        if (proposal.decided_by !== input.principal || proposal.decision_reason !== input.reason) {
          throw new PolicyLedgerError('idempotency-conflict', 'proposal already has a different decision')
        }
        return this.#proposalResult(proposal, true)
      }
      if (proposal.version !== input.expectedVersion) {
        throw new PolicyLedgerError('version-conflict', 'proposal version changed')
      }
      if (proposal.status !== 'pending') {
        throw new PolicyLedgerError('invalid-state', `proposal is already ${proposal.status}`)
      }

      const now = this.#now()
      const status: ApprovalProposalStatus = now >= proposal.expires_at ? 'expired' : input.decision
      const decidedBy = status === 'expired' ? 'system:expiry' : input.principal
      const decisionReason = status === 'expired' ? 'expired' : input.reason
      this.#database.prepare(`
        UPDATE approval_proposals
        SET status = ?, decided_at = ?, decided_by = ?, decision_reason = ?,
            diff_text = NULL, version = version + 1
        WHERE id = ? AND version = ?
      `).run(status, now, decidedBy, decisionReason, proposal.id, proposal.version)
      return this.#proposalResult({
        ...proposal,
        status,
        decided_by: decidedBy,
        decision_reason: decisionReason,
        version: proposal.version + 1,
      }, false)
    })
  }

  /**
   * Read one proposal's current status without deciding it. A domain reconciler
   * uses this to learn that its own pending operation was already approved or
   * rejected elsewhere, then commits that outcome itself.
   */
  getProposal(proposalId: string): ApprovalProposalSnapshot | undefined {
    requireBoundedText(proposalId, 'proposalId', textLimits.id)
    const row = this.#database.prepare(`
      SELECT id, idempotency_key, requester, principal, action, resource_kind,
             resource_id, diff_hash, diff_text, summary, status, created_at, expires_at, decided_by,
             decision_reason, version
      FROM approval_proposals WHERE id = ?
    `).get(proposalId) as unknown as ProposalRow | undefined
    if (row === undefined) return undefined
    return Object.freeze({
      proposalId: row.id,
      requester: row.requester,
      principal: row.principal,
      action: row.action,
      resource: Object.freeze({ kind: row.resource_kind, id: row.resource_id }),
      summary: row.summary,
      status: row.status,
      diffHash: row.diff_hash,
      expiresAt: row.expires_at,
      version: row.version,
      decidedBy: row.decided_by ?? undefined,
      decisionReason: row.decision_reason ?? undefined,
    })
  }

  /**
   * Recover an existing proposal by its immutable scoped idempotency identity.
   * A mismatch is indistinguishable from absence; callers may subsequently try
   * `propose`, whose normal idempotency conflict check remains fail-closed.
   */
  getProposalByIdempotencyKey(input: ApprovalProposalLookupInput): ApprovalProposalSnapshot | undefined {
    requireBoundedText(input.idempotencyKey, 'idempotencyKey', textLimits.id)
    requireBoundedText(input.requester, 'requester', textLimits.id)
    requireBoundedText(input.principal, 'principal', textLimits.id)
    requireBoundedText(input.action, 'action', textLimits.action)
    requireBoundedText(input.resource.kind, 'resource.kind', textLimits.action)
    requireBoundedText(input.resource.id, 'resource.id', textLimits.resourceId)
    const row = this.#database.prepare(`
      SELECT id, idempotency_key, requester, principal, action, resource_kind,
             resource_id, diff_hash, diff_text, summary, status, created_at, expires_at, decided_by,
             decision_reason, version
      FROM approval_proposals
      WHERE idempotency_key = ? AND requester = ? AND principal = ? AND action = ?
        AND resource_kind = ? AND resource_id = ?
    `).get(
      input.idempotencyKey,
      input.requester,
      input.principal,
      input.action,
      input.resource.kind,
      input.resource.id,
    ) as unknown as ProposalRow | undefined
    if (row === undefined) return undefined
    return Object.freeze({
      proposalId: row.id,
      requester: row.requester,
      principal: row.principal,
      action: row.action,
      resource: Object.freeze({ kind: row.resource_kind, id: row.resource_id }),
      summary: row.summary,
      status: row.status,
      diffHash: row.diff_hash,
      expiresAt: row.expires_at,
      version: row.version,
      decidedBy: row.decided_by ?? undefined,
      decisionReason: row.decision_reason ?? undefined,
    })
  }

  listPendingApprovalDispatches(limit = 100, after?: Readonly<ApprovalDispatchCursor>): ApprovalDispatchSnapshot[] {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new PolicyLedgerError('invalid-input', 'approval dispatch limit must be between 1 and 100')
    }
    if (after !== undefined) {
      if (after === null || typeof after !== 'object' || Array.isArray(after)
        || Object.keys(after).length !== 2
        || !Object.hasOwn(after, 'createdAt') || !Object.hasOwn(after, 'proposalId')
        || !Number.isSafeInteger(after.createdAt) || after.createdAt < 0
        || typeof after.proposalId !== 'string') {
        throw new PolicyLedgerError('invalid-input', 'approval dispatch cursor is invalid')
      }
      requireBoundedText(after.proposalId, 'approval dispatch cursor proposalId', textLimits.id)
    }
    const cursorCreatedAt = after?.createdAt ?? null
    const cursorProposalId = after?.proposalId ?? ''
    const rows = this.#database.prepare(`
      SELECT d.proposal_id, d.route_version, d.source_id, d.binding_id,
             d.binding_version, d.binding_generation, d.workspace,
             d.principal AS dispatch_principal, d.principal_record_id,
             d.principal_version, d.state, d.payload_hash,
             d.created_at AS dispatch_created_at, d.enqueued_at,
             d.version AS dispatch_version, d.proposal_version, p.requester,
             p.principal AS proposal_principal, p.action, p.resource_kind,
             p.resource_id, p.diff_hash, p.diff_text, p.summary, p.status,
             p.expires_at, p.version AS current_proposal_version
      FROM approval_dispatches d
      JOIN approval_proposals p ON p.id = d.proposal_id
      WHERE d.state = 'pending' AND d.route_version = 2
        AND p.status = 'pending' AND p.expires_at > ?
        AND (? IS NULL OR d.created_at > ? OR (d.created_at = ? AND d.proposal_id > ?))
      ORDER BY d.created_at ASC, d.proposal_id ASC
      LIMIT ?
    `).all(this.#now(), cursorCreatedAt, cursorCreatedAt, cursorCreatedAt, cursorProposalId, limit) as unknown as DispatchRow[]
    return rows.map(row => this.#dispatchSnapshot(row))
  }

  markApprovalDispatchEnqueued(
    proposalId: string,
    expectedVersion: number,
  ): ApprovalDispatchResult {
    requireBoundedText(proposalId, 'proposalId', textLimits.id)
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion <= 0) {
      throw new PolicyLedgerError('invalid-input', 'expectedVersion must be a positive safe integer')
    }
    return this.#transaction(() => {
      const dispatch = this.#dispatch(proposalId)
      const route = storedApprovalDispatchRoute(dispatch)
      if (route.routeVersion !== 2) {
        throw new PolicyLedgerError(
          'legacy-unverifiable',
          'legacy approval dispatch cannot be enqueued or replayed',
        )
      }
      if (dispatch.state === 'enqueued') {
        return this.#dispatchResult(dispatch, true)
      }
      if (dispatch.dispatch_version !== expectedVersion) {
        throw new PolicyLedgerError('version-conflict', 'approval dispatch version changed')
      }
      const now = this.#now()
      if (dispatch.status !== 'pending' || dispatch.expires_at <= now) {
        throw new PolicyLedgerError('invalid-state', 'approval proposal is no longer pending')
      }
      this.#dispatchSnapshot(dispatch)
      const result = this.#database.prepare(`
        UPDATE approval_dispatches
        SET state = 'enqueued', enqueued_at = ?, version = version + 1
        WHERE proposal_id = ? AND state = 'pending' AND version = ?
      `).run(now, proposalId, expectedVersion)
      if (Number(result.changes) !== 1) {
        throw new PolicyLedgerError('version-conflict', 'approval dispatch version changed')
      }
      const cleared = this.#database.prepare(`
        UPDATE approval_proposals SET diff_text = NULL
        WHERE id = ? AND status = 'pending' AND version = ? AND diff_text IS NOT NULL
      `).run(proposalId, dispatch.proposal_version)
      if (Number(cleared.changes) !== 1) {
        throw new PolicyLedgerError('invalid-state', 'approval dispatch diff could not be cleared')
      }
      return this.#dispatchResult({
        ...dispatch,
        state: 'enqueued',
        enqueued_at: now,
        dispatch_version: dispatch.dispatch_version + 1,
        diff_text: null,
      }, false)
    })
  }

  expireProposals(limit = 100): number {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new PolicyLedgerError('invalid-input', 'proposal expiry limit must be between 1 and 1000')
    }
    const now = this.#now()
    return this.#transaction(() => {
      const rows = this.#database.prepare(`
        SELECT id FROM approval_proposals
        WHERE status = 'pending' AND expires_at <= ?
        ORDER BY expires_at ASC, id ASC
        LIMIT ?
      `).all(now, limit) as unknown as Array<{ id: string }>
      const expire = this.#database.prepare(`
        UPDATE approval_proposals
        SET status = 'expired', decided_at = ?, decided_by = 'system:expiry',
            decision_reason = 'expired', diff_text = NULL, version = version + 1
        WHERE id = ? AND status = 'pending'
      `)
      let changed = 0
      for (const row of rows) changed += Number(expire.run(now, row.id).changes)
      return changed
    })
  }

  #proposal(id: string): ProposalRow {
    const proposal = this.#database.prepare(`
      SELECT id, idempotency_key, requester, principal, action, resource_kind,
             resource_id, diff_hash, diff_text, summary, status, created_at, expires_at, decided_by,
             decision_reason, version
      FROM approval_proposals WHERE id = ?
    `).get(id) as unknown as ProposalRow | undefined
    if (proposal === undefined) throw new PolicyLedgerError('not-found', 'approval proposal was not found')
    return proposal
  }

  #dispatch(proposalId: string): DispatchRow {
    const dispatch = this.#database.prepare(`
      SELECT d.proposal_id, d.route_version, d.source_id, d.binding_id,
             d.binding_version, d.binding_generation, d.workspace,
             d.principal AS dispatch_principal, d.principal_record_id,
             d.principal_version, d.state, d.payload_hash,
             d.created_at AS dispatch_created_at, d.enqueued_at,
             d.version AS dispatch_version, d.proposal_version, p.requester,
             p.principal AS proposal_principal, p.action, p.resource_kind,
             p.resource_id, p.diff_hash, p.diff_text, p.summary, p.status,
             p.expires_at, p.version AS current_proposal_version
      FROM approval_dispatches d
      JOIN approval_proposals p ON p.id = d.proposal_id
      WHERE d.proposal_id = ?
    `).get(proposalId) as unknown as DispatchRow | undefined
    if (dispatch === undefined) {
      throw new PolicyLedgerError('not-found', 'approval dispatch was not found')
    }
    return dispatch
  }

  #dispatchSnapshot(row: DispatchRow): ApprovalDispatchSnapshot {
    if (row.diff_text === null) {
      throw new PolicyLedgerError('invalid-state', 'approval dispatch is missing its immutable diff')
    }
    if (row.dispatch_principal !== row.proposal_principal) {
      throw new PolicyLedgerError('invalid-state', 'approval dispatch principal does not match proposal')
    }
    if (row.current_proposal_version !== row.proposal_version) {
      throw new PolicyLedgerError('invalid-state', 'approval dispatch proposal version changed')
    }
    const route = storedApprovalDispatchRoute(row)
    const expectedPayloadHash = dispatchPayloadHash({
      proposalId: row.proposal_id,
      route,
      requester: row.requester,
      action: row.action,
      resourceKind: row.resource_kind,
      resourceId: row.resource_id,
      summary: row.summary,
      diff: row.diff_text,
      diffHash: row.diff_hash,
      expiresAt: row.expires_at,
      proposalVersion: row.proposal_version,
    })
    if (row.payload_hash !== expectedPayloadHash) {
      throw new PolicyLedgerError('invalid-state', 'approval dispatch payload hash does not match proposal')
    }
    return Object.freeze({
      proposalId: row.proposal_id,
      ...route,
      principal: row.proposal_principal,
      requester: row.requester,
      action: row.action,
      resource: Object.freeze({ kind: row.resource_kind, id: row.resource_id }),
      summary: row.summary,
      diff: row.diff_text,
      diffHash: row.diff_hash,
      payloadHash: row.payload_hash,
      expiresAt: row.expires_at,
      proposalVersion: row.proposal_version,
      state: row.state,
      createdAt: row.dispatch_created_at,
      enqueuedAt: row.enqueued_at ?? undefined,
      version: row.dispatch_version,
    })
  }

  #dispatchResult(row: DispatchRow, replayed: boolean): ApprovalDispatchResult {
    if (row.state !== 'enqueued' || row.enqueued_at === null) {
      throw new PolicyLedgerError('invalid-state', 'approval dispatch is not enqueued')
    }
    return Object.freeze({
      proposalId: row.proposal_id,
      state: 'enqueued',
      payloadHash: row.payload_hash,
      enqueuedAt: row.enqueued_at,
      version: row.dispatch_version,
      replayed,
    })
  }

  #proposalResult(proposal: ProposalRow, replayed: boolean): ApprovalProposalResult {
    return {
      proposalId: proposal.id,
      status: proposal.status,
      diffHash: proposal.diff_hash,
      expiresAt: proposal.expires_at,
      version: proposal.version,
      replayed,
    }
  }

  appendAudit(input: AuditInput): AuditEvent {
    requireText(input.actor, 'actor')
    requireText(input.action, 'action')
    requireText(input.resource.kind, 'resource.kind')
    requireText(input.resource.id, 'resource.id')
    requireText(input.outcome, 'outcome')
    requireText(input.reasonCode, 'reasonCode')
    const resourceHash = createHash('sha256').update(input.resource.id).digest('hex')
    const details = redactAuditValue(input.details)
    let detailsJson: string
    try {
      detailsJson = JSON.stringify(details)
    } catch {
      throw new PolicyLedgerError('invalid-input', 'audit details must be JSON serializable')
    }
    const eventId = randomUUID()
    const occurredAt = this.#now()
    const result = this.#database.prepare(`
      INSERT INTO audit_events(
        event_id, occurred_at, actor, action, resource_kind, resource_hash,
        outcome, reason_code, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      occurredAt,
      input.actor,
      input.action,
      input.resource.kind,
      resourceHash,
      input.outcome,
      input.reasonCode,
      detailsJson,
    )
    return {
      sequence: Number(result.lastInsertRowid),
      eventId,
      occurredAt,
      actor: input.actor,
      action: input.action,
      resourceKind: input.resource.kind,
      resourceHash,
      outcome: input.outcome,
      reasonCode: input.reasonCode,
      details,
    }
  }

  queryAudit(options: { afterSequence?: number; limit?: number } = {}): AuditEvent[] {
    const afterSequence = options.afterSequence ?? 0
    const limit = options.limit ?? 50
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new PolicyLedgerError('invalid-input', 'afterSequence must be a non-negative safe integer')
    }
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new PolicyLedgerError('invalid-input', 'audit limit must be between 1 and 100')
    }
    const rows = this.#database.prepare(`
      SELECT sequence, event_id, occurred_at, actor, action, resource_kind,
             resource_hash, outcome, reason_code, details_json
      FROM audit_events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?
    `).all(afterSequence, limit) as unknown as Array<{
      sequence: number
      event_id: string
      occurred_at: number
      actor: string
      action: string
      resource_kind: string
      resource_hash: string
      outcome: string
      reason_code: string
      details_json: string
    }>
    return rows.map(row => ({
      sequence: row.sequence,
      eventId: row.event_id,
      occurredAt: row.occurred_at,
      actor: row.actor,
      action: row.action,
      resourceKind: row.resource_kind,
      resourceHash: row.resource_hash,
      outcome: row.outcome,
      reasonCode: row.reason_code,
      details: JSON.parse(row.details_json) as unknown,
    }))
  }

  health(): { lastAuditSequence: number } {
    const row = this.#database.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM audit_events')
      .get() as { sequence: number }
    return { lastAuditSequence: row.sequence }
  }
}
