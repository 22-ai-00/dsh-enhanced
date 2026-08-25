import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  ApprovalSettlementConflict,
  validateApprovalSettlement,
} from '@dsh-enhanced/assistant-policy'
import type {
  ApprovalDecisionInput,
  ApprovalDispatchRoute,
  ApprovalProposalRecoveryInput,
  ApprovalProposalRecoveryResult,
  ApprovalProposalResult,
  ApprovalProposalSnapshot,
} from '@dsh-enhanced/assistant-policy'
import { AutomationDatabaseError, openAutomationDatabase } from './sqlite.js'
import {
  AutomationStoreError,
  normalizeAutomationDefinition,
  type AutomationStore,
} from './store.js'
import type {
  AutomationMutation,
  AutomationProposalDecisionInput,
  AutomationProposalInput,
  AutomationProposalResult,
  AutomationProposalStatus,
  StoredAutomationProposal,
} from './types.js'

export type AutomationProposalStoreErrorCode =
  | 'idempotency-conflict'
  | 'invalid-input'
  | 'invalid-path'
  | 'invalid-state'
  | 'not-found'
  | 'schema-too-new'
  | 'unauthorized'

export class AutomationProposalStoreError extends Error {
  constructor(readonly code: AutomationProposalStoreErrorCode, message: string) {
    super(message)
    this.name = 'AutomationProposalStoreError'
  }
}

export interface AutomationApprovalPolicy {
  recoverOrCreateProposal(input: ApprovalProposalRecoveryInput): ApprovalProposalRecoveryResult
  decideProposal(input: ApprovalDecisionInput): ApprovalProposalResult
  getProposal(proposalId: string): ApprovalProposalSnapshot | undefined
}

interface ProposalRow {
  id: string
  policy_proposal_id: string | null
  idempotency_key: string
  requester: string
  principal: string
  dispatch_json: string | null
  change_hash: string
  change_json: string
  status: AutomationProposalStatus
  expires_at: number
  result_automation_id: string | null
  created_at: number
  ttl_ms: number | null
  version: number
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function id(idempotencyKey: string): string {
  return `automation-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`
}

function approvalDispatch(value: string | null): Readonly<ApprovalDispatchRoute> | undefined {
  if (value === null) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new AutomationProposalStoreError('invalid-state', 'automation proposal dispatch is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AutomationProposalStoreError('invalid-state', 'automation proposal dispatch is invalid')
  }
  const route = parsed as Record<string, unknown>
  if (Object.keys(route).sort().join(',') !== 'bindingId,principal,sourceId,workspace'
    || typeof route['sourceId'] !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(route['sourceId'])
    || typeof route['bindingId'] !== 'string' || route['bindingId'].trim() === ''
    || typeof route['workspace'] !== 'string' || !isAbsolute(route['workspace'])
    || typeof route['principal'] !== 'string' || route['principal'].trim() === '') {
    throw new AutomationProposalStoreError('invalid-state', 'automation proposal dispatch is invalid')
  }
  return Object.freeze({
    sourceId: route['sourceId'],
    bindingId: route['bindingId'],
    workspace: route['workspace'],
    principal: route['principal'],
  })
}

function stored(row: ProposalRow): StoredAutomationProposal {
  if (!Number.isSafeInteger(row.ttl_ms) || row.ttl_ms! <= 0) {
    throw new AutomationProposalStoreError('invalid-state', 'automation proposal TTL is invalid')
  }
  return Object.freeze({
    proposalId: row.id,
    ...(row.policy_proposal_id === null ? {} : { policyProposalId: row.policy_proposal_id }),
    idempotencyKey: row.idempotency_key,
    requester: row.requester,
    principal: row.principal,
    ...(row.dispatch_json === null ? {} : { dispatch: approvalDispatch(row.dispatch_json)! }),
    requestHash: row.change_hash,
    changeHash: hash(JSON.parse(row.change_json)),
    mutation: Object.freeze(JSON.parse(row.change_json) as AutomationMutation),
    status: row.status,
    expiresAt: row.expires_at,
    ttlMs: row.ttl_ms!,
    createdAt: row.created_at,
    version: row.version,
    ...(row.result_automation_id === null ? {} : { resultAutomationId: row.result_automation_id }),
  })
}

export class AutomationProposalStore {
  private readonly database: DatabaseSync
  private readonly now: () => number
  private closed = false

  constructor(options: { path: string; now?: () => number }) {
    this.now = options.now ?? Date.now
    try {
      this.database = openAutomationDatabase(options.path)
    } catch (error) {
      if (error instanceof AutomationDatabaseError) {
        throw new AutomationProposalStoreError(error.code, error.message)
      }
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }

  get(proposalId: string): StoredAutomationProposal | undefined {
    const row = this.database.prepare('SELECT * FROM automation_proposals WHERE id = ?').get(proposalId) as ProposalRow | undefined
    return row === undefined ? undefined : stored(row)
  }

  /**
   * List proposals still pending locally, oldest first, so a reconciler can pair
   * them with their policy decision.
   */
  listPending(limit: number): StoredAutomationProposal[] {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new AutomationProposalStoreError('invalid-input', 'pending proposal limit must be between 1 and 1000')
    }
    const rows = this.database.prepare(`
      SELECT * FROM automation_proposals WHERE status = 'pending'
      ORDER BY updated_at, id LIMIT ?
    `).all(limit) as unknown as ProposalRow[]
    return rows.map(row => stored(row))
  }

  prepare(input: {
    proposalId: string
    idempotencyKey: string
    requester: string
    principal: string
    dispatch?: Readonly<ApprovalDispatchRoute>
    requestHash: string
    mutation: AutomationMutation
    expiresAt: number
    ttlMs: number
  }): { proposal: StoredAutomationProposal; replayed: boolean } {
    const existingRow = this.database.prepare('SELECT * FROM automation_proposals WHERE id = ?').get(input.proposalId) as ProposalRow | undefined
    if (existingRow !== undefined) {
      const existing = stored(existingRow)
      if (existing.idempotencyKey !== input.idempotencyKey || existing.requester !== input.requester
        || existing.principal !== input.principal || existing.requestHash !== input.requestHash
        || existing.ttlMs !== input.ttlMs) {
        throw new AutomationProposalStoreError('idempotency-conflict', 'automation proposal key was reused with different input')
      }
      return { proposal: existing, replayed: true }
    }
    const now = this.now()
    this.database.prepare(`
      INSERT INTO automation_proposals(
        id, policy_proposal_id, idempotency_key, requester, principal, dispatch_json, change_hash, change_json,
        status, expires_at, ttl_ms, result_automation_id, created_at, updated_at, version
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, ?, ?, 1)
    `).run(
      input.proposalId, input.idempotencyKey, input.requester, input.principal,
      input.dispatch === undefined ? null : JSON.stringify(input.dispatch), input.requestHash,
      JSON.stringify(input.mutation), input.expiresAt, input.ttlMs, now, now,
    )
    return { proposal: this.get(input.proposalId)!, replayed: false }
  }

  /** Move an inspected, still-pending row behind older peers using a durable monotonic timestamp. */
  deferPending(proposalId: string): void {
    const now = this.now()
    this.database.prepare(`
      UPDATE automation_proposals
      SET updated_at = CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END
      WHERE id = ? AND status = 'pending'
    `).run(now, now, proposalId)
  }

  attachPolicy(proposalId: string, policyProposalId: string, expiresAt: number): StoredAutomationProposal {
    const proposal = this.get(proposalId)
    if (proposal === undefined) throw new AutomationProposalStoreError('not-found', 'automation proposal was not found')
    if (proposal.policyProposalId !== undefined && proposal.policyProposalId !== policyProposalId) {
      throw new AutomationProposalStoreError('idempotency-conflict', 'automation proposal is attached to another policy proposal')
    }
    if (proposal.policyProposalId !== undefined && proposal.expiresAt !== expiresAt) {
      throw new AutomationProposalStoreError('idempotency-conflict', 'automation proposal expiry differs from policy')
    }
    this.database.prepare(`
      UPDATE automation_proposals SET policy_proposal_id = ?, expires_at = ?, updated_at = ? WHERE id = ?
    `).run(policyProposalId, expiresAt, this.now(), proposalId)
    return this.get(proposalId)!
  }

  settle(input: {
    proposalId: string
    status: Exclude<AutomationProposalStatus, 'pending'>
    version: number
    resultAutomationId?: string
  }): { proposal: StoredAutomationProposal; replayed: boolean } {
    const current = this.get(input.proposalId)
    if (current === undefined) throw new AutomationProposalStoreError('not-found', 'automation proposal was not found')
    if (current.status !== 'pending') {
      if (current.status !== input.status || current.version !== input.version
        || current.resultAutomationId !== input.resultAutomationId) {
        throw new AutomationProposalStoreError('invalid-state', 'automation proposal is already settled differently')
      }
      return { proposal: current, replayed: true }
    }
    this.database.prepare(`
      UPDATE automation_proposals
      SET status = ?, result_automation_id = ?, updated_at = ?, version = ?
      WHERE id = ? AND status = 'pending'
    `).run(input.status, input.resultAutomationId ?? null, this.now(), input.version, input.proposalId)
    return { proposal: this.get(input.proposalId)!, replayed: false }
  }
}

function validateIdentity(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value, 'utf8') > 500) {
    throw new AutomationProposalStoreError('invalid-input', `${field} is invalid`)
  }
}

function diff(mutation: AutomationMutation): string {
  return JSON.stringify(mutation, null, 2)
}

function summary(mutation: AutomationMutation): string {
  return `${mutation.op} automation ${mutation.automationId}`
}

function result(
  proposal: StoredAutomationProposal,
  replayed: boolean,
  automations: AutomationStore,
): AutomationProposalResult {
  const automation = proposal.resultAutomationId === undefined ? undefined : automations.get(proposal.resultAutomationId)
  return Object.freeze({
    proposalId: proposal.proposalId,
    ...(proposal.policyProposalId === undefined ? {} : { policyProposalId: proposal.policyProposalId }),
    status: proposal.status,
    version: proposal.version,
    expiresAt: proposal.expiresAt,
    mutation: proposal.mutation,
    diff: diff(proposal.mutation),
    summary: summary(proposal.mutation),
    replayed,
    ...(automation === undefined ? {} : { automation }),
  })
}

export class AutomationProposalManager {
  constructor(
    private readonly automations: AutomationStore,
    private readonly proposals: AutomationProposalStore,
    private readonly policy: AutomationApprovalPolicy,
    private readonly now: () => number = Date.now,
  ) {}

  propose(input: AutomationProposalInput): AutomationProposalResult {
    validateIdentity(input.idempotencyKey, 'idempotencyKey')
    validateIdentity(input.requester, 'requester')
    validateIdentity(input.principal, 'principal')
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
      throw new AutomationProposalStoreError('invalid-input', 'proposal ttlMs must be positive')
    }
    const dispatch = input.dispatch === undefined
      ? undefined
      : approvalDispatch(JSON.stringify({
          sourceId: input.dispatch.sourceId,
          bindingId: input.dispatch.bindingId,
          workspace: input.dispatch.workspace,
          principal: input.dispatch.principal,
        }))
    if (dispatch !== undefined && dispatch.principal !== input.principal) {
      throw new AutomationProposalStoreError('invalid-input', 'approval dispatch belongs to another principal')
    }
    let mutation: AutomationMutation
    if (input.mutation.op === 'create') {
      validateIdentity(input.mutation.automationId, 'automationId')
      mutation = Object.freeze({
        op: 'create',
        automationId: input.mutation.automationId,
        definition: normalizeAutomationDefinition(input.mutation.definition),
      })
    } else {
      validateIdentity(input.mutation.automationId, 'automationId')
      if (!Number.isSafeInteger(input.mutation.expectedVersion) || input.mutation.expectedVersion <= 0) {
        throw new AutomationProposalStoreError('invalid-input', 'expectedVersion must be positive')
      }
      mutation = Object.freeze({
        op: input.mutation.op,
        automationId: input.mutation.automationId,
        expectedVersion: input.mutation.expectedVersion,
      })
    }
    const requestHash = hash({
      idempotencyKey: input.idempotencyKey,
      requester: input.requester,
      principal: input.principal,
      dispatch,
      ttlMs: input.ttlMs,
      mutation,
    })
    const proposalId = id(input.idempotencyKey)
    const existing = this.proposals.get(proposalId)
    let saved: { proposal: StoredAutomationProposal; replayed: boolean }
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) {
        throw new AutomationProposalStoreError('idempotency-conflict', 'automation proposal key was reused')
      }
      saved = { proposal: existing, replayed: true }
    } else {
      const current = this.automations.get(mutation.automationId)
      if (mutation.op === 'create') {
        if (current !== undefined) {
          throw new AutomationProposalStoreError('invalid-state', 'automation id already exists')
        }
      } else {
        if (current === undefined) throw new AutomationProposalStoreError('not-found', 'automation was not found')
        if (current.version !== mutation.expectedVersion) {
          throw new AutomationProposalStoreError('invalid-state', 'automation version changed before proposal')
        }
      }
      saved = this.proposals.prepare({
          proposalId,
          idempotencyKey: input.idempotencyKey,
          requester: input.requester,
          principal: input.principal,
          ...(dispatch === undefined ? {} : { dispatch }),
          requestHash,
          mutation,
          expiresAt: this.now() + input.ttlMs,
          ttlMs: input.ttlMs,
        })
    }
    if (saved.proposal.status !== 'pending' || saved.proposal.policyProposalId !== undefined) {
      return result(saved.proposal, true, this.automations)
    }
    const recovered = this.recoverOrCreatePolicyProposal(saved.proposal)
    if (recovered === undefined) return this.settleSecurityConflict(saved.proposal, saved.replayed)
    if (recovered.status !== 'pending') {
      return this.settleValidated(
        recovered.proposal,
        recovered.snapshot,
        saved.replayed || recovered.replayed,
      )
    }
    return result(recovered.proposal, saved.replayed || recovered.replayed, this.automations)
  }

  decide(input: AutomationProposalDecisionInput): AutomationProposalResult {
    let proposal = this.proposals.get(input.proposalId)
    if (proposal === undefined) throw new AutomationProposalStoreError('not-found', 'automation proposal was not found')
    if (proposal.principal !== input.principal) {
      throw new AutomationProposalStoreError('unauthorized', 'automation proposal belongs to another principal')
    }
    if (proposal.status !== 'pending') return result(proposal, true, this.automations)
    if (proposal.policyProposalId === undefined) {
      const recovered = this.recoverOrCreatePolicyProposal(proposal)
      if (recovered === undefined) return this.settleSecurityConflict(proposal, false)
      proposal = recovered.proposal
      if (recovered.status !== 'pending') {
        return this.settleValidated(proposal, recovered.snapshot, recovered.replayed)
      }
    }
    const decision = this.policy.decideProposal({
      proposalId: proposal.policyProposalId!,
      principal: input.principal,
      expectedVersion: input.expectedVersion,
      decision: input.decision,
      reason: input.reason,
    })
    if (decision.status === 'pending') throw new AutomationProposalStoreError('invalid-state', 'policy returned pending')
    const snapshot = this.policy.getProposal(proposal.policyProposalId!)
    return this.settleValidated(proposal, snapshot, decision.replayed)
  }

  /**
   * Commit locally pending proposals whose policy decision already settled
   * elsewhere, for example on an approval card minutes after the turn ended.
   *
   * Approval is never inferred: the terminal status is read back from the policy
   * ledger and applied through the same settle path `decide()` uses, so repeated
   * reconciles are idempotent.
   */
  reconcile(limit: number): AutomationProposalResult[] {
    const settled: AutomationProposalResult[] = []
    for (const candidate of this.proposals.listPending(limit)) {
      let pending = candidate
      let decision: ApprovalProposalSnapshot | undefined
      if (pending.policyProposalId === undefined) {
        try {
          const recovered = this.recoverOrCreatePolicyProposal(pending)
          if (recovered === undefined) {
            settled.push(this.settleSecurityConflict(pending, false))
            continue
          }
          pending = recovered.proposal
          decision = recovered.snapshot
        } catch {
          this.proposals.deferPending(pending.proposalId)
          continue
        }
      }
      if (decision === undefined) {
        try {
          decision = this.policy.getProposal(pending.policyProposalId!)
        } catch {
          this.proposals.deferPending(pending.proposalId)
          continue
        }
      }
      if (decision?.status === 'pending') {
        this.proposals.deferPending(pending.proposalId)
        continue
      }
      settled.push(this.settleValidated(pending, decision, false))
    }
    return settled
  }

  private policyIdentity(proposal: StoredAutomationProposal): Pick<
    ApprovalProposalRecoveryInput,
    'action' | 'idempotencyKey' | 'principal' | 'requester' | 'resource'
  > {
    return {
      idempotencyKey: `assistant-automations:${proposal.idempotencyKey}`,
      requester: proposal.requester,
      principal: proposal.principal,
      action: `automation.${proposal.mutation.op}`,
      resource: { kind: 'automation', id: proposal.mutation.automationId },
    }
  }

  /**
   * Atomically recover or create the Policy half under the locally frozen
   * deadline. An abandoned result is terminal and must never be resurrected.
   */
  private recoverOrCreatePolicyProposal(proposal: StoredAutomationProposal): {
    proposal: StoredAutomationProposal
    status: ApprovalProposalSnapshot['status']
    snapshot: ApprovalProposalSnapshot | undefined
    replayed: boolean
  } | undefined {
    const recovered = this.policy.recoverOrCreateProposal({
      ...this.policyIdentity(proposal),
      diff: diff(proposal.mutation),
      summary: summary(proposal.mutation),
      notAfter: proposal.expiresAt,
      ...(proposal.dispatch === undefined ? {} : { dispatch: proposal.dispatch }),
    })
    if (recovered.kind === 'abandoned') return undefined
    const policyProposal = recovered.proposal
    const attached = this.proposals.attachPolicy(
      proposal.proposalId,
      policyProposal.proposalId,
      policyProposal.expiresAt,
    )
    return {
      proposal: attached,
      status: policyProposal.status,
      snapshot: policyProposal.status === 'pending'
        ? undefined
        : this.policy.getProposal(policyProposal.proposalId),
      replayed: policyProposal.replayed,
    }
  }

  private settleValidated(
    proposal: StoredAutomationProposal,
    snapshot: ApprovalProposalSnapshot | undefined,
    replayed: boolean,
  ): AutomationProposalResult {
    if (proposal.policyProposalId === undefined) {
      throw new AutomationProposalStoreError('invalid-state', 'automation proposal is not attached to policy')
    }
    if (snapshot === undefined) return this.settleSecurityConflict(proposal, replayed)
    try {
      const terminal = validateApprovalSettlement(snapshot, {
        proposalId: proposal.policyProposalId,
        requester: proposal.requester,
        principal: proposal.principal,
        action: `automation.${proposal.mutation.op}`,
        resource: { kind: 'automation', id: proposal.mutation.automationId },
        summary: summary(proposal.mutation),
        diff: diff(proposal.mutation),
        expiresAt: proposal.expiresAt,
        expectedVersion: proposal.version,
      })
      return this.settleDecided(proposal, terminal.status, terminal.version, replayed)
    } catch (error) {
      if (!(error instanceof ApprovalSettlementConflict)) throw error
      return this.settleSecurityConflict(proposal, replayed)
    }
  }

  private settleSecurityConflict(
    proposal: StoredAutomationProposal,
    replayed: boolean,
  ): AutomationProposalResult {
    if (proposal.status !== 'pending' || proposal.version >= Number.MAX_SAFE_INTEGER) {
      throw new AutomationProposalStoreError(
        'invalid-state',
        'settled automation proposal failed immutable policy validation',
      )
    }
    const settled = this.proposals.settle({
      proposalId: proposal.proposalId,
      status: 'conflicted',
      version: proposal.version + 1,
    })
    return result(settled.proposal, replayed || settled.replayed, this.automations)
  }

  /**
   * Apply one already-terminal policy status to a pending automation proposal. A
   * store conflict downgrades the proposal to `conflicted` instead of losing the
   * decision, matching the rule that a decision is never re-asked.
   */
  private settleDecided(
    proposal: StoredAutomationProposal,
    policyStatus: Exclude<AutomationProposalStatus, 'conflicted' | 'pending'>,
    policyVersion: number,
    replayed: boolean,
  ): AutomationProposalResult {
    let status: Exclude<AutomationProposalStatus, 'pending'> = policyStatus
    let automationId: string | undefined
    if (policyStatus === 'approved') {
      try {
        if (proposal.mutation.op === 'create') {
          this.automations.createApproved({
            automationId: proposal.mutation.automationId,
            idempotencyKey: `proposal:${proposal.proposalId}`,
            definition: proposal.mutation.definition,
          })
        } else {
          this.automations.changeApproved({
            automationId: proposal.mutation.automationId,
            operation: proposal.mutation.op,
            expectedVersion: proposal.mutation.expectedVersion,
            idempotencyKey: `proposal:${proposal.proposalId}`,
          })
        }
        automationId = proposal.mutation.automationId
      } catch (error) {
        if (error instanceof AutomationStoreError
          && ['idempotency-conflict', 'invalid-state', 'not-found', 'version-conflict'].includes(error.code)) {
          status = 'conflicted'
        } else {
          throw error
        }
      }
    }
    const settled = this.proposals.settle({
      proposalId: proposal.proposalId,
      status,
      version: policyVersion,
      ...(automationId === undefined ? {} : { resultAutomationId: automationId }),
    })
    return result(settled.proposal, replayed || settled.replayed, this.automations)
  }

  get(proposalId: string): AutomationProposalResult | undefined {
    const proposal = this.proposals.get(proposalId)
    return proposal === undefined ? undefined : result(proposal, true, this.automations)
  }
}
