import { createHash } from 'node:crypto'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, test } from 'vitest'
import { PolicyLedger, PolicyLedgerError } from '../src/ledger.ts'

const temporaryRoots: string[] = []

async function createLedger(now: () => number = () => 100_000) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-policy-approval-'))
  temporaryRoots.push(root)
  const path = join(root, 'policy.sqlite')
  return { ledger: new PolicyLedger({ path, now }), path }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('approval proposals', () => {
  test('stores a complete diff hash and replays the same proposal idempotently', async () => {
    const { ledger, path } = await createLedger()
    const input = {
      idempotencyKey: 'memory:proposal:42',
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      action: 'memory.replace',
      resource: { kind: 'memory', id: 'preference:editor' },
      diff: '- vim\n+ helix\n',
      summary: 'Update the preferred editor',
      ttlMs: 60_000,
    }

    const created = ledger.propose(input)
    const replay = ledger.propose(input)

    expect(created).toMatchObject({
      status: 'pending',
      version: 1,
      expiresAt: 160_000,
      replayed: false,
      diffHash: createHash('sha256').update(input.diff).digest('hex'),
    })
    expect(replay).toEqual({ ...created, replayed: true })
    const database = new DatabaseSync(path)
    const stored = database.prepare('SELECT diff_text FROM approval_proposals WHERE id = ?')
      .get(created.proposalId) as { diff_text: string | null }
    database.close()
    expect(stored.diff_text).toBeNull()
    ledger.close()
  })

  test('rejects reuse of an idempotency key for different content', async () => {
    const { ledger } = await createLedger()
    const base = {
      idempotencyKey: 'proposal-key',
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      action: 'wiki.upsert',
      resource: { kind: 'wiki', id: 'page:alpha' },
      diff: '+ original',
      summary: 'Write page',
      ttlMs: 60_000,
    }
    ledger.propose(base)

    expect(() => ledger.propose({ ...base, diff: '+ changed' }))
      .toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'idempotency-conflict' }))
    expect(() => ledger.propose({ ...base, ttlMs: 120_000 }))
      .toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'idempotency-conflict' }))
    ledger.close()
  })

  test('requires the bound principal and expected version to decide', async () => {
    const { ledger } = await createLedger()
    const proposal = ledger.propose({
      idempotencyKey: 'proposal-auth',
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      action: 'automation.create',
      resource: { kind: 'automation', id: 'daily-review' },
      diff: '+ every day at 09:00',
      summary: 'Create daily review',
      ttlMs: 60_000,
    })

    expect(() => ledger.decideProposal({
      proposalId: proposal.proposalId,
      principal: 'owner:lark:attacker',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'looks fine',
    })).toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'unauthorized' }))
    expect(() => ledger.decideProposal({
      proposalId: proposal.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 2,
      decision: 'approved',
      reason: 'looks fine',
    })).toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'version-conflict' }))

    const decided = ledger.decideProposal({
      proposalId: proposal.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'looks fine',
    })
    expect(decided).toMatchObject({ status: 'approved', version: 2, replayed: false })
    expect(ledger.decideProposal({
      proposalId: proposal.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 2,
      decision: 'approved',
      reason: 'looks fine',
    })).toEqual({ ...decided, replayed: true })
    expect(ledger.decideProposal({
      proposalId: proposal.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'looks fine',
    })).toEqual({ ...decided, replayed: true })
    ledger.close()
  })

  test('expires a proposal before a late decision can authorize work', async () => {
    let now = 100_000
    const { ledger } = await createLedger(() => now)
    const proposal = ledger.propose({
      idempotencyKey: 'proposal-expiry',
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      action: 'credential.use',
      resource: { kind: 'credential', id: 'github-token' },
      diff: '+ lease credential',
      summary: 'Use GitHub credential',
      ttlMs: 1_000,
    })
    now = 101_000

    const expired = ledger.decideProposal({
      proposalId: proposal.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'late click',
    })

    expect(expired).toMatchObject({ status: 'expired', version: 2 })
    expect(ledger.getProposal(proposal.proposalId)).toMatchObject({
      status: 'expired',
      decidedBy: 'system:expiry',
      decisionReason: 'expired',
    })
    ledger.close()
  })

  test('expires pending proposals in bounded maintenance batches', async () => {
    let now = 100_000
    const { ledger } = await createLedger(() => now)
    const input = {
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      action: 'memory.add',
      resource: { kind: 'memory', id: 'fact' },
      diff: '+ fact',
      summary: 'Remember fact',
      ttlMs: 1_000,
    }
    const first = ledger.propose({ ...input, idempotencyKey: 'expiry-1' })
    ledger.propose({ ...input, idempotencyKey: 'expiry-2' })
    now = 101_000

    expect(ledger.expireProposals(1)).toBe(1)
    expect(ledger.expireProposals(10)).toBe(1)
    expect(() => ledger.expireProposals(0))
      .toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'invalid-input' }))
    expect(() => ledger.decideProposal({
      proposalId: first.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 2,
      decision: 'approved',
      reason: 'too late',
    })).toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'invalid-state' }))
    ledger.close()
  })
})

describe('durable approval dispatches', () => {
  const routedInput = {
    idempotencyKey: 'memory:proposal:routed',
    requester: 'agent:primary',
    principal: 'owner:lark:123',
    action: 'memory.replace',
    resource: { kind: 'memory', id: 'preference:editor' },
    diff: '- vim\n+ helix\n',
    summary: 'Update the preferred editor',
    ttlMs: 60_000,
    dispatch: {
      routeVersion: 2 as const,
      sourceId: 'lark-primary',
      bindingId: 'binding-owner',
      bindingVersion: 7,
      bindingGeneration: 3,
      workspace: '/work/alpha',
      principal: 'owner:lark:123',
      principalRecordId: 'principal-owner-row',
      principalVersion: 4,
    },
  }

  test('atomically persists an immutable route and exposes only policy-derived display data', async () => {
    const { ledger, path } = await createLedger()
    const proposal = ledger.propose(routedInput)

    const snapshots = ledger.listPendingApprovalDispatches()
    expect(snapshots).toEqual([
      expect.objectContaining({
        proposalId: proposal.proposalId,
        routeVersion: 2,
        sourceId: 'lark-primary',
        bindingId: 'binding-owner',
        bindingVersion: 7,
        bindingGeneration: 3,
        workspace: '/work/alpha',
        principal: 'owner:lark:123',
        principalRecordId: 'principal-owner-row',
        principalVersion: 4,
        requester: 'agent:primary',
        action: 'memory.replace',
        resource: { kind: 'memory', id: 'preference:editor' },
        summary: 'Update the preferred editor',
        diff: '- vim\n+ helix\n',
        diffHash: proposal.diffHash,
        expiresAt: 160_000,
        proposalVersion: 1,
        state: 'pending',
        version: 1,
      }),
    ])
    expect(ledger.getProposal(proposal.proposalId)).toMatchObject({
      summary: 'Update the preferred editor',
      diffHash: proposal.diffHash,
    })
    expect(ledger.getProposal(proposal.proposalId)).not.toHaveProperty('diff')
    ledger.close()

    const reopened = new PolicyLedger({ path, now: () => 100_000 })
    expect(reopened.listPendingApprovalDispatches()).toEqual(snapshots)
    reopened.close()
  })

  test('scans pending dispatches after a stable createdAt and proposalId cursor', async () => {
    const { ledger } = await createLedger()
    const proposals = Array.from({ length: 4 }, (_, index) => ledger.propose({
      ...routedInput,
      idempotencyKey: `memory:proposal:cursor:${index}`,
      resource: { kind: 'memory', id: `preference:cursor:${index}` },
    }))
    const ordered = ledger.listPendingApprovalDispatches(4)
    expect(ordered).toHaveLength(4)
    const after = { createdAt: ordered[1]!.createdAt, proposalId: ordered[1]!.proposalId }

    expect(ledger.listPendingApprovalDispatches(4, after).map(row => row.proposalId))
      .toEqual(ordered.slice(2).map(row => row.proposalId))
    expect(new Set(ordered.map(row => row.proposalId)))
      .toEqual(new Set(proposals.map(row => row.proposalId)))
    expect(() => ledger.listPendingApprovalDispatches(4, { createdAt: -1, proposalId: 'bad' }))
      .toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'invalid-input' }))
    ledger.close()
  })

  test('rolls back the proposal when its dispatch route is invalid', async () => {
    const { ledger } = await createLedger()

    expect(() => ledger.propose({
      ...routedInput,
      dispatch: { ...routedInput.dispatch, principal: 'owner:lark:attacker' },
    })).toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'unauthorized' }))

    expect(ledger.propose(routedInput)).toMatchObject({ replayed: false, status: 'pending' })
    expect(ledger.listPendingApprovalDispatches()).toHaveLength(1)
    ledger.close()
  })

  test('treats every raw diff and dispatch route field as part of the idempotent input', async () => {
    const { ledger } = await createLedger()
    ledger.propose(routedInput)
    const withoutDispatch = {
      idempotencyKey: routedInput.idempotencyKey,
      requester: routedInput.requester,
      principal: routedInput.principal,
      action: routedInput.action,
      resource: routedInput.resource,
      diff: routedInput.diff,
      summary: routedInput.summary,
      ttlMs: routedInput.ttlMs,
    }

    const conflicts = [
      { ...routedInput, diff: '+ another value' },
      withoutDispatch,
      { ...routedInput, dispatch: { ...routedInput.dispatch, sourceId: 'lark-secondary' } },
      { ...routedInput, dispatch: { ...routedInput.dispatch, bindingId: 'binding-other' } },
      { ...routedInput, dispatch: { ...routedInput.dispatch, bindingVersion: 8 } },
      { ...routedInput, dispatch: { ...routedInput.dispatch, bindingGeneration: 4 } },
      { ...routedInput, dispatch: { ...routedInput.dispatch, workspace: '/work/beta' } },
      { ...routedInput, dispatch: { ...routedInput.dispatch, principalRecordId: 'principal-other-row' } },
      { ...routedInput, dispatch: { ...routedInput.dispatch, principalVersion: 5 } },
    ]
    for (const conflict of conflicts) {
      expect(() => ledger.propose(conflict)).toThrowError(
        expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'idempotency-conflict' }),
      )
    }
    expect(ledger.propose(routedInput)).toMatchObject({ replayed: true })
    ledger.close()
  })

  test('never lists terminal or expired proposals for delivery', async () => {
    let now = 100_000
    const { ledger } = await createLedger(() => now)
    const approved = ledger.propose({ ...routedInput, idempotencyKey: 'dispatch-approved' })
    ledger.propose({ ...routedInput, idempotencyKey: 'dispatch-expired', ttlMs: 1_000 })
    ledger.decideProposal({
      proposalId: approved.proposalId,
      principal: routedInput.principal,
      expectedVersion: 1,
      decision: 'approved',
      reason: 'confirmed',
    })
    now = 101_000

    expect(ledger.listPendingApprovalDispatches()).toEqual([])
    ledger.close()
  })

  test('marks enqueue with CAS and makes the completed transition idempotent', async () => {
    const { ledger, path } = await createLedger()
    const proposal = ledger.propose(routedInput)

    expect(() => ledger.markApprovalDispatchEnqueued(proposal.proposalId, 2)).toThrowError(
      expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'version-conflict' }),
    )
    const marked = ledger.markApprovalDispatchEnqueued(proposal.proposalId, 1)
    expect(marked).toMatchObject({ state: 'enqueued', version: 2, replayed: false, enqueuedAt: 100_000 })
    expect(marked).not.toHaveProperty('diff')
    expect(ledger.markApprovalDispatchEnqueued(proposal.proposalId, 1))
      .toEqual({ ...marked, replayed: true })
    expect(ledger.propose(routedInput)).toMatchObject({ replayed: true })
    expect(ledger.listPendingApprovalDispatches()).toEqual([])
    const database = new DatabaseSync(path)
    const stored = database.prepare('SELECT diff_text FROM approval_proposals WHERE id = ?')
      .get(proposal.proposalId) as { diff_text: string | null }
    database.close()
    expect(stored.diff_text).toBeNull()
    ledger.close()
  })

  test('clears raw routed diffs after every terminal proposal transition', async () => {
    let now = 100_000
    const { ledger, path } = await createLedger(() => now)
    const approved = ledger.propose({ ...routedInput, idempotencyKey: 'raw-approved' })
    const rejected = ledger.propose({ ...routedInput, idempotencyKey: 'raw-rejected' })
    const expired = ledger.propose({ ...routedInput, idempotencyKey: 'raw-expired', ttlMs: 1_000 })
    ledger.decideProposal({
      proposalId: approved.proposalId,
      principal: routedInput.principal,
      expectedVersion: 1,
      decision: 'approved',
      reason: 'approved',
    })
    ledger.decideProposal({
      proposalId: rejected.proposalId,
      principal: routedInput.principal,
      expectedVersion: 1,
      decision: 'rejected',
      reason: 'rejected',
    })
    now = 101_000
    expect(ledger.expireProposals()).toBe(1)

    const database = new DatabaseSync(path)
    const rows = database.prepare(`
      SELECT id, diff_text FROM approval_proposals
      WHERE id IN (?, ?, ?) ORDER BY id
    `).all(approved.proposalId, rejected.proposalId, expired.proposalId) as Array<{
      id: string
      diff_text: string | null
    }>
    database.close()
    expect(rows).toHaveLength(3)
    expect(rows.every(row => row.diff_text === null)).toBe(true)
    ledger.close()
  })

  test.each([
    ['source_id', 'lark-secondary'],
    ['binding_id', 'binding-other'],
    ['binding_version', 8],
    ['binding_generation', 4],
    ['workspace', '/work/beta'],
    ['principal_record_id', 'principal-other-row'],
    ['principal_version', 5],
    ['payload_hash', '0'.repeat(64)],
  ] as const)('rejects a dispatch whose durable %s field was tampered', async (column, value) => {
    const { ledger, path } = await createLedger()
    const proposal = ledger.propose(routedInput)
    const database = new DatabaseSync(path)
    database.prepare(`UPDATE approval_dispatches SET ${column} = ? WHERE proposal_id = ?`)
      .run(value, proposal.proposalId)
    database.close()

    expect(() => ledger.listPendingApprovalDispatches()).toThrowError(
      expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'invalid-state' }),
    )
    expect(() => ledger.markApprovalDispatchEnqueued(proposal.proposalId, 1)).toThrowError(
      expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'invalid-state' }),
    )
    ledger.close()
  })

  test('prevents downgrading a route v2 dispatch to legacy v1 storage', async () => {
    const { ledger, path } = await createLedger()
    const proposal = ledger.propose(routedInput)
    const database = new DatabaseSync(path)
    expect(() => database.prepare(`
      UPDATE approval_dispatches
      SET route_version = 1, binding_version = NULL, binding_generation = NULL,
          principal_record_id = NULL, principal_version = NULL
      WHERE proposal_id = ?
    `).run(proposal.proposalId)).toThrow(/CHECK constraint failed/u)
    database.close()

    expect(ledger.listPendingApprovalDispatches()).toHaveLength(1)
    ledger.close()
  })

  test.each(['binding_version', 'binding_generation', 'principal_version'] as const)(
    'requires durable route v2 %s even for direct SQLite writes',
    async column => {
      const { ledger, path } = await createLedger()
      const proposal = ledger.propose({ ...routedInput, idempotencyKey: `required-${column}` })
      const database = new DatabaseSync(path)
      expect(() => database.prepare(`
        UPDATE approval_dispatches SET ${column} = NULL WHERE proposal_id = ?
      `).run(proposal.proposalId)).toThrow(/CHECK constraint failed/u)
      database.close()
      ledger.close()
    },
  )

  test('bounds persisted proposal and route text', async () => {
    const { ledger } = await createLedger()
    expect(ledger.propose({
      ...routedInput,
      idempotencyKey: 'summary-120-bytes',
      summary: '好'.repeat(40),
    })).toMatchObject({ status: 'pending' })
    expect(() => ledger.propose({
      ...routedInput,
      idempotencyKey: 'summary-123-bytes',
      summary: '好'.repeat(41),
    })).toThrowError(
      expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'invalid-input' }),
    )
    expect(ledger.propose({
      ...routedInput,
      idempotencyKey: 'diff-with-render-headroom',
      diff: 'd'.repeat(60 * 1_024),
    })).toMatchObject({ status: 'pending' })
    expect(() => ledger.propose({
      ...routedInput,
      idempotencyKey: 'diff-over-render-budget',
      diff: 'd'.repeat(60 * 1_024 + 1),
    })).toThrowError(
      expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'invalid-input' }),
    )
    expect(() => ledger.propose({
      ...routedInput,
      dispatch: { ...routedInput.dispatch, workspace: 'relative/workspace' },
    })).toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'invalid-path' }))
    for (const dispatch of [
      { ...routedInput.dispatch, bindingVersion: 0 },
      { ...routedInput.dispatch, bindingGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { ...routedInput.dispatch, principalRecordId: ' principal-owner-row' },
      { ...routedInput.dispatch, principalVersion: 0 },
    ]) {
      expect(() => ledger.propose({
        ...routedInput,
        idempotencyKey: `invalid-v2-route-${JSON.stringify(dispatch)}`,
        dispatch,
      })).toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'invalid-input' }))
    }
    ledger.close()
  })
})

describe('proposal read seam for domain reconcilers', () => {
  test('reports a terminal decision without deciding it again', async () => {
    const { ledger } = await createLedger()
    const created = ledger.propose({
      idempotencyKey: 'memory:proposal:read',
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      action: 'memory.add',
      resource: { kind: 'memory', id: 'fact:alpha' },
      diff: '+ alpha',
      summary: 'Add a fact',
      ttlMs: 60_000,
    })

    // Pending is reported as pending: a reconciler must never read silence as approval.
    expect(ledger.getProposal(created.proposalId)).toMatchObject({
      status: 'pending',
      version: 1,
      decidedBy: undefined,
      resource: { kind: 'memory', id: 'fact:alpha' },
    })

    ledger.decideProposal({
      proposalId: created.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'owner confirmed',
    })

    expect(ledger.getProposal(created.proposalId)).toMatchObject({
      status: 'approved',
      version: 2,
      decidedBy: 'owner:lark:123',
      decisionReason: 'owner confirmed',
    })
    ledger.close()
  })

  test('returns undefined for an unknown proposal and rejects an empty id', async () => {
    const { ledger } = await createLedger()
    expect(ledger.getProposal('missing-proposal')).toBeUndefined()
    expect(() => ledger.getProposal('  ')).toThrowError(
      expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'invalid-input' }),
    )
    ledger.close()
  })

  test('recovers every existing status by exact scoped idempotency identity without mutation', async () => {
    let now = 100_000
    const root = await mkdtemp(join(tmpdir(), 'assistant-policy-lookup-'))
    temporaryRoots.push(root)
    const path = join(root, 'policy.sqlite')
    const ledger = new PolicyLedger({ path, now: () => now })
    const base = {
      requester: 'agent:wiki',
      principal: 'owner:lark:123',
      action: 'wiki.upsert',
      resource: { kind: 'wiki', id: 'page:alpha' },
      diff: '+ alpha',
      summary: 'Write alpha',
      ttlMs: 1_000,
    }
    const pending = ledger.propose({ ...base, idempotencyKey: 'lookup:pending' })
    expect(ledger.getProposalByIdempotencyKey({
      idempotencyKey: 'lookup:pending',
      requester: base.requester,
      principal: base.principal,
      action: base.action,
      resource: base.resource,
    })).toMatchObject({ proposalId: pending.proposalId, status: 'pending', version: 1 })
    expect(ledger.getProposal(pending.proposalId)).toMatchObject({ status: 'pending', version: 1 })
    const approved = ledger.propose({ ...base, idempotencyKey: 'lookup:approved' })
    ledger.decideProposal({
      proposalId: approved.proposalId,
      principal: base.principal,
      expectedVersion: 1,
      decision: 'approved',
      reason: 'owner approved',
    })
    const rejected = ledger.propose({ ...base, idempotencyKey: 'lookup:rejected' })
    ledger.decideProposal({
      proposalId: rejected.proposalId,
      principal: base.principal,
      expectedVersion: 1,
      decision: 'rejected',
      reason: 'owner rejected',
    })
    const expired = ledger.propose({ ...base, idempotencyKey: 'lookup:expired' })
    now = 101_001
    expect(ledger.expireProposals(100)).toBe(2)
    ledger.close()

    const reopened = new PolicyLedger({ path, now: () => now })
    const lookup = (idempotencyKey: string) => reopened.getProposalByIdempotencyKey({
      idempotencyKey,
      requester: base.requester,
      principal: base.principal,
      action: base.action,
      resource: base.resource,
    })
    expect(lookup('lookup:pending')).toMatchObject({
      proposalId: pending.proposalId,
      status: 'expired',
      version: 2,
    })
    expect(lookup('lookup:approved')).toMatchObject({ status: 'approved', version: 2 })
    expect(lookup('lookup:rejected')).toMatchObject({ status: 'rejected', version: 2 })
    expect(lookup('lookup:expired')).toMatchObject({
      proposalId: expired.proposalId,
      status: 'expired',
      version: 2,
    })
    expect(lookup('lookup:missing')).toBeUndefined()
    expect(reopened.getProposalByIdempotencyKey({
      idempotencyKey: 'lookup:approved',
      requester: 'agent:other',
      principal: base.principal,
      action: base.action,
      resource: base.resource,
    })).toBeUndefined()
    expect(() => reopened.getProposalByIdempotencyKey({
      idempotencyKey: ' ',
      requester: base.requester,
      principal: base.principal,
      action: base.action,
      resource: base.resource,
    })).toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'invalid-input' }))
    reopened.close()
  })
})

describe('atomic proposal recovery deadline', () => {
  const recoveryInput = {
    idempotencyKey: 'wiki:atomic:alpha',
    requester: 'agent:wiki',
    principal: 'owner:lark:123',
    action: 'wiki.upsert',
    resource: { kind: 'wiki', id: 'page:alpha' },
    diff: '+ alpha',
    summary: 'Write alpha',
    notAfter: 160_000,
    dispatch: {
      routeVersion: 2 as const,
      sourceId: 'dsh-enhanced-personal-wiki',
      bindingId: 'binding-owner',
      bindingVersion: 5,
      bindingGeneration: 2,
      workspace: '/work/alpha',
      principal: 'owner:lark:123',
      principalRecordId: 'principal-owner-row',
      principalVersion: 3,
    },
  } as const

  test('rejects legacy dispatch routes at both public proposal creation seams', async () => {
    const legacyDispatch = {
      sourceId: recoveryInput.dispatch.sourceId,
      bindingId: recoveryInput.dispatch.bindingId,
      workspace: recoveryInput.dispatch.workspace,
      principal: recoveryInput.dispatch.principal,
    }
    const { ledger } = await createLedger(() => recoveryInput.notAfter - 1)
    expect(() => ledger.propose({
      ...recoveryInput,
      idempotencyKey: 'legacy-public-propose',
      ttlMs: 1_000,
      dispatch: legacyDispatch,
    } as never)).toThrowError(
      expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'invalid-input' }),
    )
    expect(() => ledger.recoverOrCreateProposal({
      ...recoveryInput,
      idempotencyKey: 'legacy-public-recovery',
      dispatch: { routeVersion: 1, ...legacyDispatch },
    } as never)).toThrowError(
      expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'invalid-input' }),
    )
    ledger.close()
  })

  test('creates once at the absolute deadline and recovers the exact terminal proposal across connections', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-policy-atomic-create-'))
    temporaryRoots.push(root)
    const path = join(root, 'policy.sqlite')
    const first = new PolicyLedger({ path, now: () => 100_000 })
    const second = new PolicyLedger({ path, now: () => 120_000 })

    const created = first.recoverOrCreateProposal(recoveryInput)
    expect(created).toMatchObject({
      kind: 'proposal',
      proposal: { status: 'pending', expiresAt: recoveryInput.notAfter, replayed: false },
    })
    if (created.kind !== 'proposal') throw new Error('expected proposal')
    expect(second.recoverOrCreateProposal(recoveryInput)).toEqual({
      kind: 'proposal',
      proposal: { ...created.proposal, replayed: true },
    })
    first.decideProposal({
      proposalId: created.proposal.proposalId,
      principal: recoveryInput.principal,
      expectedVersion: 1,
      decision: 'approved',
      reason: 'owner approved',
    })
    expect(second.recoverOrCreateProposal(recoveryInput)).toMatchObject({
      kind: 'proposal',
      proposal: {
        proposalId: created.proposal.proposalId,
        status: 'approved',
        expiresAt: recoveryInput.notAfter,
        version: 2,
        replayed: true,
      },
    })
    expect(first.listPendingApprovalDispatches()).toEqual([])
    first.close()
    second.close()
  })

  test('atomically abandons an elapsed key so another process cannot create an orphan dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-policy-atomic-abandon-'))
    temporaryRoots.push(root)
    const path = join(root, 'policy.sqlite')
    const first = new PolicyLedger({ path, now: () => 160_000 })
    const second = new PolicyLedger({ path, now: () => 160_001 })

    expect(first.recoverOrCreateProposal(recoveryInput)).toEqual({
      kind: 'abandoned',
      idempotencyKey: recoveryInput.idempotencyKey,
      notAfter: recoveryInput.notAfter,
      abandonedAt: 160_000,
      replayed: false,
    })
    expect(second.recoverOrCreateProposal(recoveryInput)).toEqual({
      kind: 'abandoned',
      idempotencyKey: recoveryInput.idempotencyKey,
      notAfter: recoveryInput.notAfter,
      abandonedAt: 160_000,
      replayed: true,
    })
    const database = new DatabaseSync(path)
    const tombstone = database.prepare(`
      SELECT idempotency_key, not_after, abandoned_at, intent_hash
      FROM approval_idempotency_tombstones
      WHERE idempotency_key = ?
    `).get(recoveryInput.idempotencyKey) as {
      idempotency_key: string
      not_after: number
      abandoned_at: number
      intent_hash: string
    }
    expect(tombstone).toMatchObject({
      idempotency_key: recoveryInput.idempotencyKey,
      not_after: recoveryInput.notAfter,
      abandoned_at: 160_000,
      intent_hash: '68112ed3f1e5c8e25809b75d86ae893b90f9a61b4660f3ff27815779816d5d96',
    })
    expect(JSON.stringify(tombstone)).not.toContain(recoveryInput.diff)
    expect(() => second.propose({
      ...recoveryInput,
      ttlMs: 60_000,
    })).toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'idempotency-conflict' }))
    expect(() => second.recoverOrCreateProposal({
      ...recoveryInput,
      notAfter: recoveryInput.notAfter + 1,
    })).toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'idempotency-conflict' }))

    const counts = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM approval_proposals) AS proposals,
        (SELECT COUNT(*) FROM approval_dispatches) AS dispatches,
        (SELECT COUNT(*) FROM approval_idempotency_tombstones) AS tombstones
    `).get() as { proposals: number; dispatches: number; tombstones: number }
    database.close()
    expect(counts).toEqual({ proposals: 0, dispatches: 0, tombstones: 1 })
    first.close()
    second.close()
  })

  test.each([
    ['requester', { ...recoveryInput, requester: 'agent:attacker' }],
    ['principal and route principal', {
      ...recoveryInput,
      principal: 'owner:lark:456',
      dispatch: { ...recoveryInput.dispatch, principal: 'owner:lark:456' },
    }],
    ['action', { ...recoveryInput, action: 'wiki.delete' }],
    ['resource kind', { ...recoveryInput, resource: { ...recoveryInput.resource, kind: 'memory' } }],
    ['resource id', { ...recoveryInput, resource: { ...recoveryInput.resource, id: 'page:beta' } }],
    ['diff', { ...recoveryInput, diff: '+ substituted' }],
    ['summary', { ...recoveryInput, summary: 'Misleading summary' }],
    ['deadline', { ...recoveryInput, notAfter: recoveryInput.notAfter + 1 }],
    ['dispatch presence', {
      idempotencyKey: recoveryInput.idempotencyKey,
      requester: recoveryInput.requester,
      principal: recoveryInput.principal,
      action: recoveryInput.action,
      resource: recoveryInput.resource,
      diff: recoveryInput.diff,
      summary: recoveryInput.summary,
      notAfter: recoveryInput.notAfter,
    }],
    ['dispatch source', {
      ...recoveryInput,
      dispatch: { ...recoveryInput.dispatch, sourceId: 'dsh-enhanced-personal-memory' },
    }],
    ['dispatch binding', {
      ...recoveryInput,
      dispatch: { ...recoveryInput.dispatch, bindingId: 'binding-attacker' },
    }],
    ['dispatch binding version', {
      ...recoveryInput,
      dispatch: { ...recoveryInput.dispatch, bindingVersion: 6 },
    }],
    ['dispatch binding generation', {
      ...recoveryInput,
      dispatch: { ...recoveryInput.dispatch, bindingGeneration: 3 },
    }],
    ['dispatch workspace', {
      ...recoveryInput,
      dispatch: { ...recoveryInput.dispatch, workspace: '/work/attacker' },
    }],
    ['dispatch principal record', {
      ...recoveryInput,
      dispatch: { ...recoveryInput.dispatch, principalRecordId: 'principal-attacker-row' },
    }],
    ['dispatch principal version', {
      ...recoveryInput,
      dispatch: { ...recoveryInput.dispatch, principalVersion: 4 },
    }],
  ])('binds an abandoned key to the exact %s field', async (_field, changedInput) => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-policy-atomic-intent-'))
    temporaryRoots.push(root)
    const path = join(root, 'policy.sqlite')
    const first = new PolicyLedger({ path, now: () => recoveryInput.notAfter })
    const second = new PolicyLedger({ path, now: () => recoveryInput.notAfter + 1 })
    first.recoverOrCreateProposal(recoveryInput)

    expect(() => second.recoverOrCreateProposal(changedInput))
      .toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'idempotency-conflict' }))
    expect(second.recoverOrCreateProposal(recoveryInput)).toMatchObject({
      kind: 'abandoned',
      replayed: true,
    })
    first.close()
    second.close()
  })

  test('samples the absolute deadline only after waiting for the cross-process write lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-policy-deadline-lock-'))
    temporaryRoots.push(root)
    const path = join(root, 'policy.sqlite')
    const clockBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    const clock = new Int32Array(clockBuffer)
    Atomics.store(clock, 0, recoveryInput.notAfter - 1)
    const ledger = new PolicyLedger({ path, now: () => Atomics.load(clock, 0) })
    const worker = new Worker(new URL('./fixtures/approval-deadline-lock-worker.mjs', import.meta.url), {
      workerData: { path, clockBuffer, deadline: recoveryInput.notAfter, holdMs: 100 },
    })
    const locked = new Promise<void>((resolve, reject) => {
      worker.once('error', reject)
      worker.on('message', (message: { type?: string }) => { if (message.type === 'locked') resolve() })
    })
    const released = new Promise<void>((resolve, reject) => {
      worker.once('error', reject)
      worker.on('message', (message: { type?: string }) => { if (message.type === 'released') resolve() })
    })
    await locked

    expect(ledger.recoverOrCreateProposal(recoveryInput)).toEqual({
      kind: 'abandoned',
      idempotencyKey: recoveryInput.idempotencyKey,
      notAfter: recoveryInput.notAfter,
      abandonedAt: recoveryInput.notAfter,
      replayed: false,
    })
    await released
    const database = new DatabaseSync(path)
    const counts = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM approval_proposals) AS proposals,
        (SELECT COUNT(*) FROM approval_dispatches) AS dispatches,
        (SELECT COUNT(*) FROM approval_idempotency_tombstones) AS tombstones
    `).get() as { proposals: number; dispatches: number; tombstones: number }
    database.close()
    expect(counts).toEqual({ proposals: 0, dispatches: 0, tombstones: 1 })
    ledger.close()
  })

  test('fails closed when exact content is changed during recovery', async () => {
    const { ledger } = await createLedger()
    ledger.recoverOrCreateProposal(recoveryInput)
    expect(() => ledger.recoverOrCreateProposal({
      ...recoveryInput,
      diff: '+ substituted',
    })).toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'idempotency-conflict' }))
    ledger.close()
  })
})

describe('sanitized audit', () => {
  test('redacts secret-bearing fields and hashes resource identity', async () => {
    const { ledger, path } = await createLedger()
    ledger.appendAudit({
      actor: 'agent:primary',
      action: 'credential.use',
      resource: { kind: 'credential', id: 'production/github/token' },
      outcome: 'denied',
      reasonCode: 'rule-deny',
      details: {
        command: 'curl -H "Authorization: Bearer ghp_supersecret" https://api.github.com',
        apiKey: 'sk-sensitive-value',
        nested: { password: 'hunter2', safe: 'retained' },
      },
    })

    const [event] = ledger.queryAudit({ limit: 10 })
    expect(event).toMatchObject({
      sequence: 1,
      actor: 'agent:primary',
      action: 'credential.use',
      resourceKind: 'credential',
      resourceHash: createHash('sha256').update('production/github/token').digest('hex'),
      outcome: 'denied',
      reasonCode: 'rule-deny',
      details: {
        command: '[REDACTED]',
        apiKey: '[REDACTED]',
        nested: { password: '[REDACTED]', safe: 'retained' },
      },
    })
    ledger.close()

    const databaseBytes = await readFile(path)
    expect(databaseBytes.includes(Buffer.from('ghp_supersecret'))).toBe(false)
    expect(databaseBytes.includes(Buffer.from('sk-sensitive-value'))).toBe(false)
    expect(databaseBytes.includes(Buffer.from('hunter2'))).toBe(false)
    expect(databaseBytes.includes(Buffer.from('production/github/token'))).toBe(false)
  })

  test('bounds audit queries and pages after a sequence', async () => {
    const { ledger } = await createLedger()
    for (let index = 0; index < 3; index += 1) {
      ledger.appendAudit({
        actor: 'system',
        action: `test.${index}`,
        resource: { kind: 'tool', id: `tool-${index}` },
        outcome: 'allowed',
        reasonCode: 'rule-allow',
        details: { index },
      })
    }

    expect(ledger.queryAudit({ afterSequence: 1, limit: 1 }).map(event => event.sequence)).toEqual([2])
    expect(() => ledger.queryAudit({ limit: 101 }))
      .toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'invalid-input' }))
    ledger.close()
  })
})
