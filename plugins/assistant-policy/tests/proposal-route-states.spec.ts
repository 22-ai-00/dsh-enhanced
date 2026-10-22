import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { PolicyLedger, PolicyLedgerError, type ApprovalDispatchRouteV2 } from '../src/ledger.ts'
import { AssistantPolicyService } from '../src/service.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'policy-route-states-'))
  roots.push(root)
  const path = join(root, 'policy.sqlite')
  let now = 1_000
  const ledger = new PolicyLedger({ path, now: () => now })
  const route: ApprovalDispatchRouteV2 = {
    routeVersion: 2, sourceId: 'lark', bindingId: 'binding', bindingVersion: 2,
    bindingGeneration: 3, workspace: '/work/current', principal: 'owner:current',
    principalRecordId: 'record-current', principalVersion: 4,
  }
  let sequence = 0
  const propose = (changes: Partial<ApprovalDispatchRouteV2> = {}, ttlMs = 1_000) => {
    const id = ++sequence
    return ledger.propose({
      idempotencyKey: `key-${id}`, requester: 'agent:primary',
      principal: changes.principal ?? route.principal, action: 'memory.add',
      resource: { kind: 'memory', id: `fact-${id}` },
      diff: `+ fact-${id}`, summary: `fact-${id}`, ttlMs,
      dispatch: { ...route, ...changes },
    })
  }
  return { path, ledger, route, propose, setNow(value: number) { now = value } }
}

test('shows pending, rejected, approved and read-only expired facts with no content', async () => {
  const { path, ledger, route, propose, setNow } = await fixture()
  const pending = propose()
  const rejected = propose()
  ledger.decideProposal({ proposalId: rejected.proposalId, principal: route.principal,
    expectedVersion: 1, decision: 'rejected', reason: 'private rejection' })
  const approved = propose()
  ledger.decideProposal({ proposalId: approved.proposalId, principal: route.principal,
    expectedVersion: 1, decision: 'approved', reason: 'private approval' })
  const expiring = propose({}, 1)
  setNow(1_001)
  const database = new DatabaseSync(path)
  const before = database.prepare('SELECT status, version, decided_at FROM approval_proposals WHERE id = ?')
    .get(expiring.proposalId)
  const result = ledger.listProposalStatesForRoute(route)
  const expired = result.proposals.find(item => item.proposalId === expiring.proposalId)
  expect(expired).toEqual({ proposalId: expiring.proposalId,
    resource: { kind: 'memory', id: 'fact-4' }, action: 'memory.add', status: 'expired',
    version: 1, createdAt: 1_000, expiresAt: 1_001 })
  expect(result.proposals.find(item => item.proposalId === pending.proposalId)?.status).toBe('pending')
  expect(result.proposals.find(item => item.proposalId === rejected.proposalId)).toMatchObject({ status: 'rejected', version: 2, decidedAt: 1_000 })
  expect(result.proposals.find(item => item.proposalId === approved.proposalId)).toMatchObject({ status: 'approved', version: 2, decidedAt: 1_000 })
  expect(Object.keys(expired!)).toEqual(['proposalId', 'resource', 'action', 'status', 'version', 'createdAt', 'expiresAt'])
  expect(database.prepare('SELECT status, version, decided_at FROM approval_proposals WHERE id = ?')
    .get(expiring.proposalId)).toEqual(before)
  database.close()
  ledger.close()
})

test('filters every v2 route component, both principals and legacy v1', async () => {
  const { path, ledger, route, propose } = await fixture()
  const own = propose()
  for (const changes of [
    { sourceId: 'other' }, { bindingId: 'other' }, { bindingVersion: 5 },
    { bindingGeneration: 5 }, { workspace: '/work/other' },
    { principal: 'owner:other' }, { principalRecordId: 'record-other' },
    { principalVersion: 5 },
  ]) propose(changes)
  const altered = propose()
  const legacy = propose()
  const db = new DatabaseSync(path)
  db.prepare('UPDATE approval_proposals SET principal = ? WHERE id = ?')
    .run('owner:other', altered.proposalId)
  db.prepare(`UPDATE approval_dispatches SET route_version = 1, state = 'quarantined', binding_version = NULL,
    binding_generation = NULL, principal_record_id = NULL, principal_version = NULL WHERE proposal_id = ?`)
    .run(legacy.proposalId)
  expect(ledger.listProposalStatesForRoute(route).proposals.map(item => item.proposalId)).toEqual([own.proposalId])
  db.close()
  ledger.close()
})

test('orders newest createdAt then id, bounds result and rejects malformed route or limit', async () => {
  const { path, ledger, route, propose } = await fixture()
  const ids = [propose().proposalId, propose().proposalId, propose().proposalId]
  const db = new DatabaseSync(path)
  db.prepare('UPDATE approval_proposals SET created_at = 2_000 WHERE id = ?').run(ids[2]!)
  const ordered = [ids[2]!, ...ids.slice(0, 2).sort().reverse()]
  expect(ledger.listProposalStatesForRoute(route, 2)).toMatchObject({
    proposals: [{ proposalId: ordered[0] }, { proposalId: ordered[1] }], truncated: true,
  })
  expect(ledger.listProposalStatesForRoute(route, 3)).toMatchObject({ truncated: false })
  for (const limit of [0, 21, 1.5, Number.NaN]) {
    expect(() => ledger.listProposalStatesForRoute(route, limit))
      .toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'invalid-input' }))
  }
  for (const invalid of [
    { ...route, routeVersion: 1 }, { ...route, bindingVersion: 0 },
    { ...route, principalRecordId: ' other ' }, { ...route, workspace: 'relative' },
  ]) expect(() => ledger.listProposalStatesForRoute(invalid as ApprovalDispatchRouteV2))
    .toThrowError(PolicyLedgerError)
  db.close()
  ledger.close()
})

test('Host service forwards the bounded facts and rejects reads after disposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'policy-route-service-'))
  roots.push(root)
  const ctx = new Context()
  const fiber = ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'), rules: [], proposalMaintenanceIntervalMs: 0,
  })
  await fiber
  const service = ctx.assistantPolicy
  const route: ApprovalDispatchRouteV2 = {
    routeVersion: 2, sourceId: 'lark', bindingId: 'binding', bindingVersion: 1,
    bindingGeneration: 1, workspace: '/work/current', principal: 'owner:current',
    principalRecordId: 'record-current', principalVersion: 1,
  }
  const proposal = service.propose({ idempotencyKey: 'service-key', requester: 'agent:primary',
    principal: route.principal, action: 'wiki.create', resource: { kind: 'wiki', id: 'page' },
    summary: 'Page', diff: '+ page', ttlMs: 1_000, dispatch: route })
  expect(service.listProposalStatesForRoute(route)).toMatchObject({
    proposals: [{ proposalId: proposal.proposalId, status: 'pending' }], truncated: false,
  })
  await fiber.dispose()
  expect(() => service.listProposalStatesForRoute(route)).toThrow('disposed')
  await ctx.fiber.restart()
})
