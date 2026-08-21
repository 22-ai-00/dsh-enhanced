import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  ApprovalDecisionInput,
  ApprovalProposalInput,
  ApprovalProposalResult,
} from '@dsh-enhanced/assistant-policy'
import { openWikiDatabase, WikiDatabaseError } from './sqlite.js'
import type {
  PreparedWikiWrite,
  StoredWikiProposal,
  WikiPage,
  WikiProposalDecisionInput,
  WikiProposalInput,
  WikiProposalResult,
  WikiProposalStatus,
} from './types.js'
import { WikiVault, WikiVaultError } from './vault.js'

export type WikiProposalStoreErrorCode =
  | 'idempotency-conflict'
  | 'invalid-input'
  | 'invalid-path'
  | 'invalid-state'
  | 'not-found'
  | 'schema-too-new'

export class WikiProposalStoreError extends Error {
  constructor(readonly code: WikiProposalStoreErrorCode, message: string) {
    super(message)
    this.name = 'WikiProposalStoreError'
  }
}

export interface WikiApprovalPolicy {
  propose(input: ApprovalProposalInput): ApprovalProposalResult
  decideProposal(input: ApprovalDecisionInput): ApprovalProposalResult
}

interface ProposalRow {
  id: string
  policy_proposal_id: string | null
  idempotency_key: string
  requester: string
  principal: string
  request_hash: string
  write_hash: string
  write_json: string
  status: WikiProposalStatus
  expires_at: number
  result_page_id: string | null
  version: number
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function proposalId(idempotencyKey: string): string {
  return `wiki-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`
}

function stored(row: ProposalRow): StoredWikiProposal {
  return Object.freeze({
    proposalId: row.id,
    ...(row.policy_proposal_id === null ? {} : { policyProposalId: row.policy_proposal_id }),
    idempotencyKey: row.idempotency_key,
    requester: row.requester,
    principal: row.principal,
    requestHash: row.request_hash,
    writeHash: row.write_hash,
    write: Object.freeze(JSON.parse(row.write_json) as PreparedWikiWrite),
    status: row.status,
    expiresAt: row.expires_at,
    version: row.version,
    ...(row.result_page_id === null ? {} : { resultPageId: row.result_page_id }),
  })
}

export class WikiProposalStore {
  private readonly database: DatabaseSync
  private readonly now: () => number
  private closed = false

  constructor(options: { path: string; now?: () => number }) {
    this.now = options.now ?? Date.now
    try {
      this.database = openWikiDatabase(options.path)
    } catch (error) {
      if (error instanceof WikiDatabaseError) throw new WikiProposalStoreError(error.code, error.message)
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }

  get(id: string): StoredWikiProposal | undefined {
    const row = this.database.prepare('SELECT * FROM wiki_proposals WHERE id = ?').get(id) as ProposalRow | undefined
    return row === undefined ? undefined : stored(row)
  }

  health(): { pendingProposals: number } {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM wiki_proposals WHERE status = 'pending'")
      .get() as { count: number }
    return { pendingProposals: row.count }
  }

  prepare(input: {
    proposalId: string
    idempotencyKey: string
    requester: string
    principal: string
    requestHash: string
    write: PreparedWikiWrite
    expiresAt: number
  }): { proposal: StoredWikiProposal; replayed: boolean } {
    const existing = this.get(input.proposalId)
    if (existing !== undefined) {
      if (existing.idempotencyKey !== input.idempotencyKey
        || existing.requester !== input.requester
        || existing.principal !== input.principal
        || existing.requestHash !== input.requestHash) {
        throw new WikiProposalStoreError('idempotency-conflict', 'wiki proposal idempotency key was reused with different input')
      }
      return { proposal: existing, replayed: true }
    }
    const now = this.now()
    const writeHash = hashJson(input.write)
    this.database.prepare(`
      INSERT INTO wiki_proposals(
        id, policy_proposal_id, idempotency_key, requester, principal, request_hash,
        write_hash, write_json, status, expires_at, result_page_id, created_at, updated_at, version
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?, 1)
    `).run(
      input.proposalId, input.idempotencyKey, input.requester, input.principal, input.requestHash,
      writeHash, JSON.stringify(input.write), input.expiresAt, now, now,
    )
    return { proposal: this.get(input.proposalId)!, replayed: false }
  }

  attachPolicy(id: string, policyProposalId: string, expiresAt: number): StoredWikiProposal {
    const proposal = this.get(id)
    if (proposal === undefined) throw new WikiProposalStoreError('not-found', 'wiki proposal was not found')
    if (proposal.policyProposalId !== undefined && proposal.policyProposalId !== policyProposalId) {
      throw new WikiProposalStoreError('idempotency-conflict', 'wiki proposal is attached to another policy proposal')
    }
    if (proposal.policyProposalId !== undefined && proposal.expiresAt !== expiresAt) {
      throw new WikiProposalStoreError('idempotency-conflict', 'wiki proposal expiry differs from policy proposal')
    }
    this.database.prepare(`
      UPDATE wiki_proposals SET policy_proposal_id = ?, expires_at = ?, updated_at = ? WHERE id = ?
    `).run(policyProposalId, expiresAt, this.now(), id)
    return this.get(id)!
  }

  settle(input: {
    proposalId: string
    status: Exclude<WikiProposalStatus, 'pending'>
    version: number
    resultPageId?: string
  }): { proposal: StoredWikiProposal; replayed: boolean } {
    const current = this.get(input.proposalId)
    if (current === undefined) throw new WikiProposalStoreError('not-found', 'wiki proposal was not found')
    if (current.status !== 'pending') {
      if (current.status !== input.status || current.version !== input.version
        || current.resultPageId !== input.resultPageId) {
        throw new WikiProposalStoreError('invalid-state', 'wiki proposal is already settled differently')
      }
      return { proposal: current, replayed: true }
    }
    const now = this.now()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare(`
        UPDATE wiki_proposals
        SET status = ?, result_page_id = ?, updated_at = ?, version = ?
        WHERE id = ? AND status = 'pending'
      `).run(input.status, input.resultPageId ?? null, now, input.version, input.proposalId)
      this.database.prepare(`
        INSERT INTO wiki_audit(proposal_id, write_hash, status, result_page_id, occurred_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.proposalId, current.writeHash, input.status, input.resultPageId ?? null, now)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return { proposal: this.get(input.proposalId)!, replayed: false }
  }
}

function diff(write: PreparedWikiWrite): string {
  return JSON.stringify(write, null, 2)
}

function summary(write: PreparedWikiWrite): string {
  return `${write.op} wiki page ${write.pageId}`
}

function result(proposal: StoredWikiProposal, replayed: boolean, page?: WikiPage): WikiProposalResult {
  return Object.freeze({
    proposalId: proposal.proposalId,
    ...(proposal.policyProposalId === undefined ? {} : { policyProposalId: proposal.policyProposalId }),
    status: proposal.status,
    version: proposal.version,
    expiresAt: proposal.expiresAt,
    write: proposal.write,
    diff: diff(proposal.write),
    summary: summary(proposal.write),
    replayed,
    ...(page === undefined ? {} : { page }),
  })
}

export class WikiProposalManager {
  constructor(
    private readonly vault: WikiVault,
    private readonly store: WikiProposalStore,
    private readonly policy: WikiApprovalPolicy,
    private readonly now: () => number = Date.now,
  ) {}

  propose(input: WikiProposalInput): WikiProposalResult {
    if (input.idempotencyKey.trim() === '' || input.requester.trim() === '' || input.principal.trim() === '') {
      throw new WikiProposalStoreError('invalid-input', 'wiki proposal identity fields must not be empty')
    }
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
      throw new WikiProposalStoreError('invalid-input', 'wiki proposal ttlMs must be a positive safe integer')
    }
    const id = proposalId(input.idempotencyKey)
    const requestHash = hashJson({
      idempotencyKey: input.idempotencyKey,
      requester: input.requester,
      principal: input.principal,
      ttlMs: input.ttlMs,
      mutation: input.mutation,
    })
    const existing = this.store.get(id)
    let saved: { proposal: StoredWikiProposal; replayed: boolean }
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) {
        throw new WikiProposalStoreError('idempotency-conflict', 'wiki proposal idempotency key was reused with different input')
      }
      saved = { proposal: existing, replayed: true }
    } else {
      const write = this.vault.prepareWrite(input.mutation)
      const expiresAt = this.now() + input.ttlMs
      if (!Number.isSafeInteger(expiresAt)) throw new WikiProposalStoreError('invalid-input', 'wiki proposal expiry is invalid')
      saved = this.store.prepare({
        proposalId: id,
        idempotencyKey: input.idempotencyKey,
        requester: input.requester,
        principal: input.principal,
        requestHash,
        write,
        expiresAt,
      })
    }
    const policyProposal = this.policy.propose({
      idempotencyKey: `personal-wiki:${input.idempotencyKey}`,
      requester: input.requester,
      principal: input.principal,
      action: `wiki.${saved.proposal.write.op}`,
      resource: { kind: 'wiki', id: saved.proposal.write.pageId },
      diff: diff(saved.proposal.write),
      summary: summary(saved.proposal.write),
      ttlMs: input.ttlMs,
    })
    const attached = this.store.attachPolicy(id, policyProposal.proposalId, policyProposal.expiresAt)
    return result(attached, saved.replayed || policyProposal.replayed)
  }

  decide(input: WikiProposalDecisionInput): WikiProposalResult {
    const proposal = this.store.get(input.proposalId)
    if (proposal === undefined) throw new WikiProposalStoreError('not-found', 'wiki proposal was not found')
    if (proposal.policyProposalId === undefined) {
      throw new WikiProposalStoreError('invalid-state', 'wiki proposal is not attached to policy')
    }
    const decision = this.policy.decideProposal({
      proposalId: proposal.policyProposalId,
      principal: input.principal,
      expectedVersion: input.expectedVersion,
      decision: input.decision,
      reason: input.reason,
    })
    if (decision.status === 'pending') throw new WikiProposalStoreError('invalid-state', 'policy returned a pending decision')
    let status: Exclude<WikiProposalStatus, 'pending'> = decision.status
    let page: WikiPage | undefined
    if (decision.status === 'approved') {
      try {
        page = this.vault.applyPreparedWrite(proposal.write)
      } catch (error) {
        if (error instanceof WikiVaultError && error.code !== 'busy') {
          status = 'conflicted'
        } else {
          throw error
        }
      }
    }
    const settled = this.store.settle({
      proposalId: proposal.proposalId,
      status,
      version: decision.version,
      ...(page === undefined ? {} : { resultPageId: page.metadata.id }),
    })
    const resultPage = page ?? (settled.proposal.resultPageId === undefined
      ? undefined
      : this.vault.get(settled.proposal.resultPageId))
    return result(settled.proposal, decision.replayed || settled.replayed, resultPage)
  }

  getProposal(id: string): WikiProposalResult | undefined {
    const proposal = this.store.get(id)
    if (proposal === undefined) return undefined
    const page = proposal.resultPageId === undefined ? undefined : this.vault.get(proposal.resultPageId)
    return result(proposal, true, page)
  }
}
