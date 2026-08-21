import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { redactAuditValue } from './redaction.js'
import { openPolicyDatabase, PolicyDatabaseError } from './sqlite.js'

export type PolicyLedgerErrorCode =
  | 'budget-exhausted'
  | 'idempotency-conflict'
  | 'invalid-input'
  | 'invalid-path'
  | 'invalid-state'
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
}

export type ApprovalProposalStatus = 'approved' | 'expired' | 'pending' | 'rejected'

export interface ApprovalProposalResult {
  proposalId: string
  status: ApprovalProposalStatus
  diffHash: string
  expiresAt: number
  version: number
  replayed: boolean
}

export interface ApprovalDecisionInput {
  proposalId: string
  principal: string
  expectedVersion: number
  decision: 'approved' | 'rejected'
  reason: string
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
  summary: string
  status: ApprovalProposalStatus
  created_at: number
  expires_at: number
  decided_by: string | null
  decision_reason: string | null
  version: number
}

function requireText(value: string, field: string): void {
  if (value.trim() === '') throw new PolicyLedgerError('invalid-input', `${field} must not be empty`)
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
          && existing.period_start === periodStart
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

  propose(input: ApprovalProposalInput): ApprovalProposalResult {
    requireText(input.idempotencyKey, 'idempotencyKey')
    requireText(input.requester, 'requester')
    requireText(input.principal, 'principal')
    requireText(input.action, 'action')
    requireText(input.resource.kind, 'resource.kind')
    requireText(input.resource.id, 'resource.id')
    requireText(input.summary, 'summary')
    requirePeriod(input.ttlMs)
    const diffHash = createHash('sha256').update(input.diff).digest('hex')
    const now = this.#now()
    const expiresAt = now + input.ttlMs
    if (!Number.isSafeInteger(expiresAt)) {
      throw new PolicyLedgerError('invalid-input', 'proposal expiry exceeds the safe timestamp range')
    }

    return this.#transaction(() => {
      const existing = this.#database.prepare(`
        SELECT id, idempotency_key, requester, principal, action, resource_kind,
               resource_id, diff_hash, summary, status, created_at, expires_at, decided_by,
               decision_reason, version
        FROM approval_proposals WHERE idempotency_key = ?
      `).get(input.idempotencyKey) as unknown as ProposalRow | undefined
      if (existing !== undefined) {
        const sameInput = existing.requester === input.requester
          && existing.principal === input.principal
          && existing.action === input.action
          && existing.resource_kind === input.resource.kind
          && existing.resource_id === input.resource.id
          && existing.diff_hash === diffHash
          && existing.summary === input.summary
          && existing.expires_at - existing.created_at === input.ttlMs
        if (!sameInput) {
          throw new PolicyLedgerError('idempotency-conflict', 'idempotency key was used for another proposal')
        }
        return this.#proposalResult(existing, true)
      }

      const id = randomUUID()
      this.#database.prepare(`
        INSERT INTO approval_proposals(
          id, idempotency_key, requester, principal, action, resource_kind,
          resource_id, diff_hash, summary, status, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        id,
        input.idempotencyKey,
        input.requester,
        input.principal,
        input.action,
        input.resource.kind,
        input.resource.id,
        diffHash,
        input.summary,
        now,
        expiresAt,
      )
      return {
        proposalId: id,
        status: 'pending',
        diffHash,
        expiresAt,
        version: 1,
        replayed: false,
      }
    })
  }

  decideProposal(input: ApprovalDecisionInput): ApprovalProposalResult {
    requireText(input.proposalId, 'proposalId')
    requireText(input.principal, 'principal')
    requireText(input.reason, 'reason')
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
      this.#database.prepare(`
        UPDATE approval_proposals
        SET status = ?, decided_at = ?, decided_by = ?, decision_reason = ?, version = version + 1
        WHERE id = ? AND version = ?
      `).run(status, now, input.principal, input.reason, proposal.id, proposal.version)
      return this.#proposalResult({
        ...proposal,
        status,
        decided_by: input.principal,
        decision_reason: input.reason,
        version: proposal.version + 1,
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
            decision_reason = 'expired', version = version + 1
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
             resource_id, diff_hash, summary, status, created_at, expires_at, decided_by,
             decision_reason, version
      FROM approval_proposals WHERE id = ?
    `).get(id) as unknown as ProposalRow | undefined
    if (proposal === undefined) throw new PolicyLedgerError('not-found', 'approval proposal was not found')
    return proposal
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
