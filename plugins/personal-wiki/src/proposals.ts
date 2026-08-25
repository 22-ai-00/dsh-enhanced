import { createHash } from 'node:crypto'
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
  request_hash: string
  write_hash: string
  write_json: string
  status: WikiProposalStatus
  expires_at: number
  result_page_id: string | null
  version: number
  ttl_ms: number | null
  dispatch_json: string | null
  created_at: number
}

const RECONCILE_CURSOR_START = -9_007_199_254_740_991

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function proposalId(idempotencyKey: string): string {
  return `wiki-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`
}

function permanentPolicyRecoveryFailure(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error)) return false
  return ['idempotency-conflict', 'invalid-input', 'invalid-path', 'unauthorized']
    .includes(String(error.code))
}

function storedDispatch(value: string): Readonly<ApprovalDispatchRoute> {
  const parsed = JSON.parse(value) as Partial<ApprovalDispatchRoute>
  if (parsed === null || typeof parsed !== 'object'
    || typeof parsed.sourceId !== 'string'
    || typeof parsed.bindingId !== 'string'
    || typeof parsed.workspace !== 'string'
    || typeof parsed.principal !== 'string') {
    throw new WikiProposalStoreError('invalid-state', 'stored wiki approval route is invalid')
  }
  return Object.freeze({
    sourceId: parsed.sourceId,
    bindingId: parsed.bindingId,
    workspace: parsed.workspace,
    principal: parsed.principal,
  })
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
    ...(row.ttl_ms === null ? {} : { ttlMs: row.ttl_ms }),
    ...(row.dispatch_json === null ? {} : { dispatch: storedDispatch(row.dispatch_json) }),
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

  /**
   * Return one page from a durable high-water cycle. Newer rows are held for the
   * next cycle, so a continuous arrival stream cannot prevent the cursor from
   * wrapping to an older proposal that became terminal after its first scan.
   */
  listPending(limit: number): StoredWikiProposal[] {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new WikiProposalStoreError('invalid-input', 'pending proposal limit must be between 1 and 1000')
    }
    this.database.exec('BEGIN IMMEDIATE')
    try {
      let cursor = this.database.prepare(`
        SELECT created_at, proposal_id, boundary_created_at, boundary_proposal_id
        FROM wiki_reconcile_cursor WHERE singleton = 1
      `).get() as {
        created_at: number
        proposal_id: string
        boundary_created_at: number
        boundary_proposal_id: string
      }
      if (cursor.boundary_created_at === RECONCILE_CURSOR_START
        && cursor.boundary_proposal_id === '') {
        const boundary = this.database.prepare(`
          SELECT created_at, id FROM wiki_proposals WHERE status = 'pending'
          ORDER BY created_at DESC, id DESC LIMIT 1
        `).get() as { created_at: number; id: string } | undefined
        if (boundary === undefined) {
          this.database.exec('COMMIT')
          return []
        }
        cursor = {
          created_at: RECONCILE_CURSOR_START,
          proposal_id: '',
          boundary_created_at: boundary.created_at,
          boundary_proposal_id: boundary.id,
        }
      }
      const rows = this.database.prepare(`
        SELECT * FROM wiki_proposals
        WHERE status = 'pending'
          AND (created_at > ? OR (created_at = ? AND id > ?))
          AND (created_at < ? OR (created_at = ? AND id <= ?))
        ORDER BY created_at, id LIMIT ?
      `).all(
        cursor.created_at,
        cursor.created_at,
        cursor.proposal_id,
        cursor.boundary_created_at,
        cursor.boundary_created_at,
        cursor.boundary_proposal_id,
        limit,
      ) as unknown as ProposalRow[]
      const last = rows.at(-1)
      const completed = last === undefined
        || rows.length < limit
        || (last.created_at === cursor.boundary_created_at && last.id === cursor.boundary_proposal_id)
      if (completed) {
        this.database.prepare(`
          UPDATE wiki_reconcile_cursor
          SET created_at = ?, proposal_id = '', boundary_created_at = ?, boundary_proposal_id = ''
          WHERE singleton = 1
        `).run(RECONCILE_CURSOR_START, RECONCILE_CURSOR_START)
      } else if (last !== undefined) {
        this.database.prepare(`
          UPDATE wiki_reconcile_cursor
          SET created_at = ?, proposal_id = ?, boundary_created_at = ?, boundary_proposal_id = ?
          WHERE singleton = 1
        `).run(
          last.created_at,
          last.id,
          cursor.boundary_created_at,
          cursor.boundary_proposal_id,
        )
      }
      const proposals = rows.map(row => stored(row))
      this.database.exec('COMMIT')
      return proposals
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  prepare(input: {
    proposalId: string
    idempotencyKey: string
    requester: string
    principal: string
    requestHash: string
    write: PreparedWikiWrite
    expiresAt: number
    ttlMs: number
    dispatch?: Readonly<ApprovalDispatchRoute>
  }): { proposal: StoredWikiProposal; replayed: boolean } {
    const existing = this.get(input.proposalId)
    if (existing !== undefined) {
      if (existing.idempotencyKey !== input.idempotencyKey
        || existing.requester !== input.requester
        || existing.principal !== input.principal
        || existing.requestHash !== input.requestHash) {
        throw new WikiProposalStoreError('idempotency-conflict', 'wiki proposal idempotency key was reused with different input')
      }
      if (existing.ttlMs === undefined) {
        this.database.prepare(`
          UPDATE wiki_proposals SET ttl_ms = ?, dispatch_json = ?, updated_at = ? WHERE id = ?
        `).run(
          input.ttlMs,
          input.dispatch === undefined ? null : JSON.stringify(input.dispatch),
          this.now(),
          input.proposalId,
        )
        return { proposal: this.get(input.proposalId)!, replayed: true }
      }
      return { proposal: existing, replayed: true }
    }
    const writeHash = hashJson(input.write)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const now = this.now()
      const latest = this.database.prepare(`
        SELECT created_at FROM wiki_proposals ORDER BY created_at DESC LIMIT 1
      `).get() as { created_at: number } | undefined
      const createdAt = latest === undefined ? now : Math.max(now, latest.created_at + 1)
      if (!Number.isSafeInteger(createdAt)) {
        throw new WikiProposalStoreError('invalid-state', 'wiki proposal ordering key cannot advance safely')
      }
      this.database.prepare(`
        INSERT INTO wiki_proposals(
          id, policy_proposal_id, idempotency_key, requester, principal, request_hash,
          write_hash, write_json, status, expires_at, result_page_id, created_at, updated_at, version,
          ttl_ms, dispatch_json
        ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?, 1, ?, ?)
      `).run(
        input.proposalId, input.idempotencyKey, input.requester, input.principal, input.requestHash,
        writeHash, JSON.stringify(input.write), input.expiresAt, createdAt, now, input.ttlMs,
        input.dispatch === undefined ? null : JSON.stringify(input.dispatch),
      )
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
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

function policyProposalRecoveryInput(proposal: StoredWikiProposal): ApprovalProposalRecoveryInput {
  return {
    idempotencyKey: `personal-wiki:${proposal.idempotencyKey}`,
    requester: proposal.requester,
    principal: proposal.principal,
    action: `wiki.${proposal.write.op}`,
    resource: { kind: 'wiki', id: proposal.write.pageId },
    diff: diff(proposal.write),
    summary: summary(proposal.write),
    notAfter: proposal.expiresAt,
    ...(proposal.dispatch === undefined ? {} : { dispatch: proposal.dispatch }),
  }
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
      dispatch: input.dispatch,
    })
    const existing = this.store.get(id)
    let saved: { proposal: StoredWikiProposal; replayed: boolean }
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) {
        throw new WikiProposalStoreError('idempotency-conflict', 'wiki proposal idempotency key was reused with different input')
      }
      saved = this.store.prepare({
        proposalId: id,
        idempotencyKey: input.idempotencyKey,
        requester: input.requester,
        principal: input.principal,
        requestHash,
        write: existing.write,
        expiresAt: existing.expiresAt,
        ttlMs: input.ttlMs,
        ...(input.dispatch === undefined ? {} : { dispatch: input.dispatch }),
      })
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
        ttlMs: input.ttlMs,
        ...(input.dispatch === undefined ? {} : { dispatch: input.dispatch }),
      })
    }
    let recovery: ApprovalProposalRecoveryResult
    try {
      recovery = this.policy.recoverOrCreateProposal(policyProposalRecoveryInput(saved.proposal))
    } catch (error) {
      if (!permanentPolicyRecoveryFailure(error) || saved.proposal.status !== 'pending') throw error
      return this.settleSecurityConflict(saved.proposal, saved.replayed)
    }
    if (recovery.kind === 'abandoned') {
      return saved.proposal.status === 'pending'
        ? this.settleSecurityConflict(saved.proposal, saved.replayed || recovery.replayed)
        : result(saved.proposal, true)
    }
    const policyProposal = recovery.proposal
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
    const snapshot = this.policy.getProposal(proposal.policyProposalId)
    if (snapshot === undefined) return this.settleSecurityConflict(proposal, decision.replayed)
    return this.settleSnapshot(proposal, snapshot, input.expectedVersion, decision.replayed)
  }

  /**
   * Commit locally pending proposals whose policy decision already settled
   * elsewhere, for example on an approval card minutes after the turn ended.
   *
   * Approval is never inferred: the terminal status is read back from the policy
   * ledger and applied through the same settle path `decide()` uses, so repeated
   * reconciles are idempotent.
   */
  reconcile(limit: number): WikiProposalResult[] {
    const settled: WikiProposalResult[] = []
    for (const pending of this.store.listPending(limit)) {
      let current = pending
      if (current.policyProposalId === undefined) {
        let recovery: ApprovalProposalRecoveryResult
        try {
          recovery = this.policy.recoverOrCreateProposal(policyProposalRecoveryInput(current))
        } catch (error) {
          if (permanentPolicyRecoveryFailure(error)) {
            settled.push(this.settleSecurityConflict(current, false))
            continue
          }
          continue
        }
        if (recovery.kind === 'abandoned') {
          settled.push(this.settleSecurityConflict(current, recovery.replayed))
          continue
        }
        current = this.store.attachPolicy(
          current.proposalId,
          recovery.proposal.proposalId,
          recovery.proposal.expiresAt,
        )
      }
      const policyProposalId = current.policyProposalId
      if (policyProposalId === undefined) {
        settled.push(this.settleSecurityConflict(current, false))
        continue
      }
      const decision = this.policy.getProposal(policyProposalId)
      if (decision?.status === 'pending') continue
      settled.push(decision === undefined
        ? this.settleSecurityConflict(current, false)
        : this.settleSnapshot(current, decision, current.version, false))
    }
    return settled
  }

  /**
   * Apply one already-terminal policy status to a pending wiki proposal. A vault
   * conflict downgrades the proposal to `conflicted` instead of losing the
   * decision, matching the durability rule that a decision is never re-asked.
   */
  private settleDecided(
    proposal: StoredWikiProposal,
    policyStatus: Exclude<WikiProposalStatus, 'conflicted' | 'pending'>,
    policyVersion: number,
    replayed: boolean,
  ): WikiProposalResult {
    let status: Exclude<WikiProposalStatus, 'pending'> = policyStatus
    let page: WikiPage | undefined
    if (policyStatus === 'approved') {
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
      version: policyVersion,
      ...(page === undefined ? {} : { resultPageId: page.metadata.id }),
    })
    const resultPage = page ?? (settled.proposal.resultPageId === undefined
      ? undefined
      : this.vault.get(settled.proposal.resultPageId))
    return result(settled.proposal, replayed || settled.replayed, resultPage)
  }

  private settleSnapshot(
    proposal: StoredWikiProposal,
    snapshot: ApprovalProposalSnapshot,
    expectedVersion: number,
    replayed: boolean,
  ): WikiProposalResult {
    if (proposal.policyProposalId === undefined) {
      throw new WikiProposalStoreError('invalid-state', 'wiki proposal is not attached to policy')
    }
    try {
      const validated = validateApprovalSettlement(snapshot, {
        proposalId: proposal.policyProposalId,
        requester: proposal.requester,
        principal: proposal.principal,
        action: `wiki.${proposal.write.op}`,
        resource: { kind: 'wiki', id: proposal.write.pageId },
        summary: summary(proposal.write),
        diff: diff(proposal.write),
        expiresAt: proposal.expiresAt,
        expectedVersion,
      })
      // Policy decisions are replayable, but a local settlement is terminal. Re-read
      // after the Policy call so a replay (or another local worker) can never enter
      // the vault write path after this proposal became conflicted or otherwise
      // settled. Matching successful settlements are safe read-only replays.
      const current = this.store.get(proposal.proposalId)
      if (current === undefined) throw new WikiProposalStoreError('not-found', 'wiki proposal was not found')
      if (current.status !== 'pending') {
        if (current.status === 'conflicted'
          || current.status !== validated.status
          || current.version !== validated.version) {
          throw new WikiProposalStoreError('invalid-state', 'wiki proposal is already settled differently')
        }
        const page = current.resultPageId === undefined ? undefined : this.vault.get(current.resultPageId)
        if (current.status === 'approved' && page === undefined) {
          throw new WikiProposalStoreError('invalid-state', 'approved wiki proposal result is missing')
        }
        return result(current, true, page)
      }
      return this.settleDecided(current, validated.status, validated.version, replayed)
    } catch (error) {
      if (!(error instanceof ApprovalSettlementConflict)) throw error
      return this.settleSecurityConflict(proposal, replayed)
    }
  }

  private settleSecurityConflict(proposal: StoredWikiProposal, replayed: boolean): WikiProposalResult {
    if (proposal.status !== 'pending') {
      throw new WikiProposalStoreError('invalid-state', 'settled wiki proposal failed immutable policy validation')
    }
    if (proposal.version >= Number.MAX_SAFE_INTEGER) {
      throw new WikiProposalStoreError('invalid-state', 'wiki proposal version cannot advance safely')
    }
    const settled = this.store.settle({
      proposalId: proposal.proposalId,
      status: 'conflicted',
      version: proposal.version + 1,
    })
    return result(settled.proposal, replayed || settled.replayed)
  }

  getProposal(id: string): WikiProposalResult | undefined {
    const proposal = this.store.get(id)
    if (proposal === undefined) return undefined
    const page = proposal.resultPageId === undefined ? undefined : this.vault.get(proposal.resultPageId)
    return result(proposal, true, page)
  }
}
