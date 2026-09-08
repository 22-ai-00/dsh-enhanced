import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ActionLedger, ActionLedgerError } from '../src/ledger.ts'
import type { ActionGrant, ActionIdentity, CommitRequest } from '../src/types.ts'

let now = 1_000_000
const roots: string[] = []
const identity: ActionIdentity = { principalDigest: 'principal', principalRecordId: 'record', principalVersion: 1, workspace: '/workspace', agentPreset: 'default' }
const request = (key = 'key', content = 'hello'): CommitRequest => ({ grantId: 'grant', idempotencyKey: key, expectedHeadOid: 'a'.repeat(40), headline: 'change', files: [{ path: 'a.txt', content }] })
const grant = (revision = 1, changes: Partial<ActionGrant> = {}): ActionGrant => ({ ...identity, id: 'grant', revision, repository: 'owner/repository', branch: 'main', paths: ['a.txt'], credentialHandle: 'credential', expiresAt: now + 60_000, maxActions: 5, maxTotalBytes: 100, ...changes })
const commitBytes = (value: CommitRequest): number => Buffer.byteLength(value.headline, 'utf8') + value.files.reduce((total, file) => total + Buffer.byteLength(file.path, 'utf8') + Buffer.byteLength(file.content, 'utf8'), 0)

async function ledger(): Promise<ActionLedger> {
  const root = await mkdtemp(join(tmpdir(), 'action-ledger-')); roots.push(root)
  return new ActionLedger(join(root, 'ledger.sqlite'), { now: () => now })
}

async function authorised(): Promise<{ ledger: ActionLedger; authority: { ownerId: string; fence: number } }> {
  const value = await ledger(); const authority = value.claimController('owner'); value.syncGrants([grant()], authority)
  return { ledger: value, authority }
}

afterEach(async () => { now = 1_000_000; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('ActionLedger', () => {
  it('persists a prepared record across a reopen and returns it for the same idempotency key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'action-ledger-')); roots.push(root); const path = join(root, 'ledger.sqlite')
    const first = new ActionLedger(path, { now: () => now }); const authority = first.claimController('owner'); first.syncGrants([grant()], authority)
    const preparedRequest = request(); const prepared = first.prepare({ identity, sessionId: 'session', request: preparedRequest, bytes: commitBytes(preparedRequest), authority }); first.close()
    const reopened = new ActionLedger(path, { now: () => now })
    const repeated = request(); expect(reopened.prepare({ identity, sessionId: 'session', request: repeated, bytes: commitBytes(repeated), authority }).record).toMatchObject({ id: prepared.record.id, status: 'prepared' })
    reopened.close()
  })

  it('preserves explicit step acceptance across restart and requires a new grant revision to change it', async () => {
    const first = await ledger(), path = join(roots[0]!, 'ledger.sqlite'), authority = first.claimController('owner')
    const configured = grant(1, { verifiedDelivery: { ownerRouteId: 'route', budgetId: 'budget', acceptance: 'goal-step' } })
    first.syncGrants([configured], authority); first.close()
    const reopened = new ActionLedger(path, { now: () => now })
    try {
      expect(reopened.grant('grant')?.verifiedDelivery).toEqual(configured.verifiedDelivery)
      expect(() => reopened.syncGrants([grant(1, { verifiedDelivery: { ownerRouteId: 'route', budgetId: 'budget' } })], authority)).toThrow('conflict')
      expect(() => reopened.syncGrants([grant(2, { verifiedDelivery: { ownerRouteId: 'route', budgetId: 'budget', acceptance: 'model' as never } })], authority)).toThrow('invalid-input')
      reopened.syncGrants([grant(2, { verifiedDelivery: { ownerRouteId: 'route', budgetId: 'budget' } })], authority)
      expect(reopened.grant('grant')?.verifiedDelivery).toEqual({ ownerRouteId: 'route', budgetId: 'budget' })
    } finally { reopened.close() }
  })

  it('uses a version compare-and-swap and fences a second controller connection', async () => {
    const { ledger: first, authority } = await authorised(); const root = roots[0]!; const second = new ActionLedger(join(root, 'ledger.sqlite'), { now: () => now })
    const preparedRequest = request(); const prepared = first.prepare({ identity, sessionId: 'session', request: preparedRequest, bytes: commitBytes(preparedRequest), authority }).record
    expect(() => second.dispatch(prepared.id, prepared.version, authority)).not.toThrow()
    expect(() => first.dispatch(prepared.id, prepared.version, authority)).toThrow(ActionLedgerError)
    expect(() => second.claimController('other')).toThrow(ActionLedgerError)
    first.close(); second.close()
  })

  it('retains the controller fence after release so an old authority cannot reappear', async () => {
    const value = await ledger(); const first = value.claimController('owner')
    value.releaseController(first)
    const second = value.claimController('owner')
    expect(second.fence).toBe(first.fence + 1)
    expect(value.hasController(first)).toBe(false)
    value.close()
  })

  it('does not allow a reused key with a different normalized request', async () => {
    const { ledger, authority } = await authorised()
    const original = request('key', 'hello'); ledger.prepare({ identity, sessionId: 'session', request: original, bytes: commitBytes(original), authority })
    const changed = request('key', 'other'); expect(() => ledger.prepare({ identity, sessionId: 'session', request: changed, bytes: commitBytes(changed), authority })).toThrow(/conflict/)
    ledger.close()
  })

  it('makes revoked and expired grants unusable while preserving the old record', async () => {
    const { ledger, authority } = await authorised(); const preparedRequest = request(); const prepared = ledger.prepare({ identity, sessionId: 'session', request: preparedRequest, bytes: commitBytes(preparedRequest), authority }).record
    ledger.revoke('grant', 1)
    expect(ledger.get(prepared.id)).toMatchObject({ id: prepared.id })
    expect(ledger.usable(prepared.id)).toBe(false)
    expect(() => ledger.dispatch(prepared.id, prepared.version, authority)).toThrow(/grant/)
    ledger.close()
  })

  it('charges bytes cumulatively across grant revisions and never refunds terminal actions', async () => {
    const { ledger, authority } = await authorised(); const firstRequest = request('one', 'hello'); const prepared = ledger.prepare({ identity, sessionId: 'one', request: firstRequest, bytes: commitBytes(firstRequest), authority }).record
    const dispatched = ledger.dispatch(prepared.id, prepared.version, authority); ledger.settle(prepared.id, dispatched.version, { actionId: prepared.id, status: 'failed', reason: 'remote' }, authority)
    ledger.syncGrants([grant(2, { maxTotalBytes: 5 })], authority)
    const secondRequest = request('two', 'x'); expect(() => ledger.prepare({ identity, sessionId: 'two', request: secondRequest, bytes: commitBytes(secondRequest), authority })).toThrow(/limit/)
    ledger.close()
  })

  it('recovers in-flight records as unknown and never redispatches them', async () => {
    const { ledger, authority } = await authorised(); const preparedRequest = request(); const prepared = ledger.prepare({ identity, sessionId: 'session', request: preparedRequest, bytes: commitBytes(preparedRequest), authority }).record
    expect(ledger.recover(authority)).toBe(1)
    expect(ledger.get(prepared.id)).toMatchObject({ status: 'unknown', result: { reason: 'controller-recovery-no-replay' } })
    expect(() => ledger.dispatch(prepared.id, prepared.version, authority)).toThrow(/state/)
    ledger.close()
  })

  it('blocks a new key for an unknown destination head even after a grant revision', async () => {
    const { ledger, authority } = await authorised(); const original = request('original'); const prepared = ledger.prepare({ identity, sessionId: 'first', request: original, bytes: commitBytes(original), authority }).record
    ledger.dispatch(prepared.id, prepared.version, authority); ledger.recover(authority)
    ledger.syncGrants([grant(2)], authority)
    const retry = request('retry')
    expect(() => ledger.prepare({ identity, sessionId: 'second', request: retry, bytes: commitBytes(retry), authority })).toThrow(/state/)
    ledger.close()
  })

  it('keeps at most two prepared, dispatched, or unknown records occupied', async () => {
    const { ledger, authority } = await authorised()
    const succeededRequest = request('succeeded'); const succeeded = ledger.prepare({ identity, sessionId: 'one', request: succeededRequest, bytes: commitBytes(succeededRequest), authority }).record
    const dispatched = ledger.dispatch(succeeded.id, succeeded.version, authority); ledger.settle(succeeded.id, dispatched.version, { actionId: succeeded.id, status: 'succeeded', commitOid: 'b'.repeat(40) }, authority)
    const unknownRequest = { ...request('unknown'), expectedHeadOid: 'c'.repeat(40) }; const unknown = ledger.prepare({ identity, sessionId: 'two', request: unknownRequest, bytes: commitBytes(unknownRequest), authority }).record
    ledger.dispatch(unknown.id, unknown.version, authority); ledger.recover(authority)
    const pendingRequest = { ...request('pending'), expectedHeadOid: 'd'.repeat(40) }; ledger.prepare({ identity, sessionId: 'three', request: pendingRequest, bytes: commitBytes(pendingRequest), authority })
    const blockedRequest = { ...request('blocked'), expectedHeadOid: 'e'.repeat(40) }
    expect(() => ledger.prepare({ identity, sessionId: 'four', request: blockedRequest, bytes: commitBytes(blockedRequest), authority })).toThrow(/limit/)
    ledger.revoke('grant', 1)
    ledger.close()
  })

  it('enforces owner scope, exact file paths, duration, and record capacity', async () => {
    const { ledger, authority } = await authorised()
    const normal = request(); expect(() => ledger.prepare({ identity: { ...identity, workspace: '/other' }, sessionId: 'session', request: normal, bytes: commitBytes(normal), authority })).toThrow(/grant/)
    const wrongPath = { ...request(), files: [{ path: 'other.txt', content: 'hello' }] }; expect(() => ledger.prepare({ identity, sessionId: 'session', request: wrongPath, bytes: commitBytes(wrongPath), authority })).toThrow(/grant/)
    now += 60_000
    const fresh = ledger.claimController('next-host')
    const later = request('later'); expect(() => ledger.prepare({ identity, sessionId: 'later', request: later, bytes: commitBytes(later), authority: fresh })).toThrow(/grant/)
    ledger.close()
  })

  it('rejects a new action when the durable record cap is reached', async () => {
    const { ledger, authority } = await authorised(); const root = roots[0]!; const path = join(root, 'ledger.sqlite'); ledger.close()
    const database = new DatabaseSync(path)
    const insert = database.prepare("INSERT INTO actions(id, identity_json, session_id, grant_id, idempotency_digest, grant_revision, repository, branch, expected_head_oid, request_digest, bytes, expires_at, status, version, result_json) VALUES (?, ?, ?, 'grant', ?, 1, 'owner/repository', 'main', ?, ?, 0, ?, 'unknown', 1, ?)")
    const identityJson = JSON.stringify({ agentPreset: 'default', principalDigest: 'principal', principalRecordId: 'record', principalVersion: 1, workspace: '/workspace' })
    database.exec('BEGIN IMMEDIATE')
    for (let index = 0; index < 10_000; index++) {
      const id = `seed-${index}`
      insert.run(id, identityJson, `seed-${index}`, index.toString(16).padStart(64, '0'), index.toString(16).padStart(40, '0'), index.toString(16).padStart(64, '1'), now, JSON.stringify({ actionId: id, status: 'unknown', reason: 'seed' }))
    }
    database.exec('COMMIT'); database.close()
    const reopened = new ActionLedger(path, { now: () => now })
    const next = request('new'); expect(() => reopened.prepare({ identity, sessionId: 'new', request: next, bytes: commitBytes(next), authority })).toThrow(/limit/)
    reopened.close()
  })

  it('fails closed when malformed persisted action JSON is found during reopen', async () => {
    const { ledger, authority } = await authorised(); const root = roots[0]!; const path = join(root, 'ledger.sqlite'); const preparedRequest = request(); const prepared = ledger.prepare({ identity, sessionId: 'session', request: preparedRequest, bytes: commitBytes(preparedRequest), authority }).record; ledger.close()
    const database = new DatabaseSync(path); database.prepare("UPDATE actions SET identity_json = '{' WHERE id = ?").run(prepared.id); database.close()
    expect(() => new ActionLedger(path, { now: () => now })).toThrow(/schema/)
  })

  it('fails closed when a structurally valid action identity differs from its grant', async () => {
    const { ledger, authority } = await authorised(); const root = roots[0]!; const path = join(root, 'ledger.sqlite'); const preparedRequest = request(); const prepared = ledger.prepare({ identity, sessionId: 'session', request: preparedRequest, bytes: commitBytes(preparedRequest), authority }).record; ledger.close()
    const database = new DatabaseSync(path); database.prepare('UPDATE actions SET identity_json = ? WHERE id = ?').run(JSON.stringify({ ...identity, workspace: '/other' }), prepared.id); database.close()
    expect(() => new ActionLedger(path, { now: () => now })).toThrow(/schema/)
  })

  it('rejects inconsistent current grant revocation on live lookup and reopen', async () => {
    const { ledger } = await authorised(); const path = join(roots[0]!, 'ledger.sqlite')
    ledger.revoke('grant', 1)
    const database = new DatabaseSync(path)
    database.prepare('UPDATE grant_heads SET revoked = 0 WHERE id = ?').run('grant')
    database.close()
    expect(() => ledger.grant('grant')).toThrow(/schema/)
    ledger.close()
    expect(() => new ActionLedger(path, { now: () => now })).toThrow(/schema/)
  })

  it('fails closed when a terminal persisted action has no outcome', async () => {
    const { ledger, authority } = await authorised(); const root = roots[0]!; const path = join(root, 'ledger.sqlite'); const preparedRequest = request(); const prepared = ledger.prepare({ identity, sessionId: 'session', request: preparedRequest, bytes: commitBytes(preparedRequest), authority }).record; ledger.close()
    const database = new DatabaseSync(path); database.prepare("UPDATE actions SET status = 'unknown', result_json = NULL WHERE id = ?").run(prepared.id); database.close()
    expect(() => new ActionLedger(path, { now: () => now })).toThrow(/schema/)
  })
})

it('persists branch and PR results and allows bounded inspection of an uncertain mutation', async () => {
  const value = await ledger(), authority = value.claimController('owner')
  value.syncGrants([grant(1, { maxTotalBytes: 10_000, repoWorkflow: { baseBranch: 'base', allowBranchCreate: true, allowPullRequest: true } })], authority)
  const create = { grantId: 'grant', idempotencyKey: 'branch', baseHeadOid: 'a'.repeat(40) }
  const reserve = (request: import('../src/types.ts').WorkflowRequest) => value.prepare({ identity, sessionId: 'session', request, bytes: Buffer.byteLength(JSON.stringify(request)), authority })
  const branch = reserve(create).record
  const dispatched = value.dispatch(branch.id, branch.version, authority)
  value.settle(branch.id, dispatched.version, { actionId: branch.id, status: 'unknown' }, authority)
  expect(() => reserve({ ...create, idempotencyKey: 'different', baseHeadOid: 'b'.repeat(40) })).toThrow(/state/)
  const read = reserve({ grantId: 'grant', idempotencyKey: 'read', operation: 'inspect', kind: 'branch' }).record
  expect(read.kind).toBe('inspect')
  expect(() => reserve({ grantId: 'grant', idempotencyKey: 'outside', operation: 'inspect', kind: 'file', path: 'private.txt' })).toThrow(/grant/)
  value.close()
})

it('denies workflow writes without a workflow grant, and inspection budgets survive reopen', async () => {
  const { ledger: value, authority } = await authorised()
  const path = join(roots[0]!, 'ledger.sqlite')
  value.syncGrants([grant(2, { maxTotalBytes: 10_000, maxActions: 1 })], authority)
  const prepare = (ledger: ActionLedger, request: import('../src/types.ts').WorkflowRequest) => ledger.prepare({ identity, sessionId: 'session', request, bytes: Buffer.byteLength(JSON.stringify(request)), authority })
  expect(() => prepare(value, { grantId: 'grant', idempotencyKey: 'branch', baseHeadOid: 'a'.repeat(40) })).toThrow(/grant/)
  const input = { grantId: 'grant', idempotencyKey: 'read', operation: 'inspect' as const, kind: 'repository' as const }
  const read = prepare(value, input).record
  const dispatched = value.dispatch(read.id, read.version, authority)
  value.settle(read.id, dispatched.version, { actionId: read.id, status: 'succeeded' }, authority)
  value.close()
  const reopened = new ActionLedger(path, { now: () => now })
  expect(reopened.get(read.id)?.kind).toBe('inspect')
  expect(() => prepare(reopened, { ...input, idempotencyKey: 'read-again' })).toThrow(/limit/)
  reopened.close()
})

it('upgrades a v1 commit ledger without replaying its uncertain action', async () => {
  const { ledger: value, authority } = await authorised()
  const input = request(), prepared = value.prepare({ identity, sessionId: 'session', request: input, bytes: commitBytes(input), authority }).record
  value.dispatch(prepared.id, prepared.version, authority); value.recover(authority); value.close()
  const path = join(roots[0]!, 'ledger.sqlite'), legacy = new DatabaseSync(path)
  legacy.exec('ALTER TABLE actions DROP COLUMN kind; PRAGMA user_version = 1;'); legacy.close()
  const reopened = new ActionLedger(path, { now: () => now })
  expect(reopened.get(prepared.id)).toMatchObject({ kind: 'commit', status: 'unknown' })
  expect(() => reopened.dispatch(prepared.id, 1, authority)).toThrow(/state/)
  reopened.close()
})
