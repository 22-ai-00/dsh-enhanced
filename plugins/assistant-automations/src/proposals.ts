import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  ApprovalDecisionInput,
  ApprovalProposalInput,
  ApprovalProposalResult,
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

export class AutomationProposalStoreError extends Error {
  constructor(readonly code: AutomationProposalStoreErrorCode, message: string) {
    super(message)
    this.name = 'AutomationProposalStoreError'
  }
}

export interface AutomationApprovalPolicy {
  propose(input: ApprovalProposalInput): ApprovalProposalResult
  decideProposal(input: ApprovalDecisionInput): ApprovalProposalResult
}

interface ProposalRow {
  id: string
  policy_proposal_id: string | null
  idempotency_key: string
  requester: string
  principal: string
  change_hash: string
  change_json: string
  status: AutomationProposalStatus
  expires_at: number
  result_automation_id: string | null
  created_at: number
  version: number
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function id(idempotencyKey: string): string {
  return `automation-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`
}

function stored(row: ProposalRow): StoredAutomationProposal {
  return Object.freeze({
    proposalId: row.id,
    ...(row.policy_proposal_id === null ? {} : { policyProposalId: row.policy_proposal_id }),
    idempotencyKey: row.idempotency_key,
    requester: row.requester,
    principal: row.principal,
    requestHash: row.change_hash,
    changeHash: hash(JSON.parse(row.change_json)),
    mutation: Object.freeze(JSON.parse(row.change_json) as AutomationMutation),
    status: row.status,
    expiresAt: row.expires_at,
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

  prepare(input: {
    proposalId: string
    idempotencyKey: string
    requester: string
    principal: string
    requestHash: string
    mutation: AutomationMutation
    expiresAt: number
  }): { proposal: StoredAutomationProposal; replayed: boolean } {
    const existingRow = this.database.prepare('SELECT * FROM automation_proposals WHERE id = ?').get(input.proposalId) as ProposalRow | undefined
    if (existingRow !== undefined) {
      const existing = stored(existingRow)
      if (existing.idempotencyKey !== input.idempotencyKey || existing.requester !== input.requester
        || existing.principal !== input.principal || existing.requestHash !== input.requestHash
        || existing.expiresAt - existingRow.created_at !== input.expiresAt - this.now()) {
        throw new AutomationProposalStoreError('idempotency-conflict', 'automation proposal key was reused with different input')
      }
      return { proposal: existing, replayed: true }
    }
    const now = this.now()
    this.database.prepare(`
      INSERT INTO automation_proposals(
        id, policy_proposal_id, idempotency_key, requester, principal, change_hash, change_json,
        status, expires_at, result_automation_id, created_at, updated_at, version
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?, 1)
    `).run(
      input.proposalId, input.idempotencyKey, input.requester, input.principal, input.requestHash,
      JSON.stringify(input.mutation), input.expiresAt, now, now,
    )
    return { proposal: this.get(input.proposalId)!, replayed: false }
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
          requestHash,
          mutation,
          expiresAt: this.now() + input.ttlMs,
        })
    }
    const policyProposal = this.policy.propose({
      idempotencyKey: `assistant-automations:${input.idempotencyKey}`,
      requester: input.requester,
      principal: input.principal,
      action: `automation.${mutation.op}`,
      resource: { kind: 'automation', id: mutation.automationId },
      diff: diff(mutation),
      summary: summary(mutation),
      ttlMs: input.ttlMs,
    })
    const attached = this.proposals.attachPolicy(proposalId, policyProposal.proposalId, policyProposal.expiresAt)
    return result(attached, saved.replayed || policyProposal.replayed, this.automations)
  }

  decide(input: AutomationProposalDecisionInput): AutomationProposalResult {
    const proposal = this.proposals.get(input.proposalId)
    if (proposal === undefined) throw new AutomationProposalStoreError('not-found', 'automation proposal was not found')
    if (proposal.policyProposalId === undefined) {
      throw new AutomationProposalStoreError('invalid-state', 'automation proposal is not attached to policy')
    }
    const decision = this.policy.decideProposal({
      proposalId: proposal.policyProposalId,
      principal: input.principal,
      expectedVersion: input.expectedVersion,
      decision: input.decision,
      reason: input.reason,
    })
    if (decision.status === 'pending') throw new AutomationProposalStoreError('invalid-state', 'policy returned pending')
    let status: Exclude<AutomationProposalStatus, 'pending'> = decision.status
    let automationId: string | undefined
    if (decision.status === 'approved') {
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
      version: decision.version,
      ...(automationId === undefined ? {} : { resultAutomationId: automationId }),
    })
    return result(settled.proposal, decision.replayed || settled.replayed, this.automations)
  }

  get(proposalId: string): AutomationProposalResult | undefined {
    const proposal = this.proposals.get(proposalId)
    return proposal === undefined ? undefined : result(proposal, true, this.automations)
  }
}
