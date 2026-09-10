import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ActionLedger, ActionLedgerError } from '../src/ledger.ts'
import type { ActionGrant, ActionIdentity, CommitRequest, CompensationPreimage, CompensationResult } from '../src/types.ts'

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
  // A genuine v1 store has no kind column (v2), no actions.paths_json and no compensations table (both v3).
  legacy.exec('DROP TABLE compensations; ALTER TABLE actions DROP COLUMN paths_json; ALTER TABLE actions DROP COLUMN kind; PRAGMA user_version = 1;'); legacy.close()
  const reopened = new ActionLedger(path, { now: () => now })
  expect(reopened.get(prepared.id)).toMatchObject({ kind: 'commit', status: 'unknown' })
  expect(() => reopened.dispatch(prepared.id, 1, authority)).toThrow(/state/)
  reopened.close()
})

describe('ActionLedger compensations', () => {
  const rollbackGrant = (revision = 1, changes: Partial<ActionGrant> = {}): ActionGrant =>
    grant(revision, { rollback: { allowRollback: true as const, budgetId: 'rollback-budget', maxActions: 2, maxTotalBytes: 100_000 }, ...changes })

  async function rollbackLedger(revision = 1, changes: Partial<ActionGrant> = {}): Promise<{ ledger: ActionLedger; authority: { ownerId: string; fence: number } }> {
    const value = await ledger(); const authority = value.claimController('owner'); value.syncGrants([rollbackGrant(revision, changes)], authority)
    return { ledger: value, authority }
  }

  function succeedForward(value: ActionLedger, authority: { ownerId: string; fence: number }, key = 'key', commitOid = 'b'.repeat(40), expectedHeadOid = 'a'.repeat(40)) {
    const input = { ...request(key), expectedHeadOid }
    const prepared = value.prepare({ identity, sessionId: 'session', request: input, bytes: commitBytes(input), authority }).record
    const dispatched = value.dispatch(prepared.id, prepared.version, authority)
    return value.settle(prepared.id, dispatched.version, { actionId: prepared.id, status: 'succeeded', commitOid }, authority)
  }

  const receipt = (forward: { id: string; version: number; requestDigest: string; result?: { commitOid?: string } }, idempotencyKey = 'compensate') => ({
    grantId: 'grant', idempotencyKey, forwardActionId: forward.id, forwardActionVersion: forward.version,
    forwardRequestDigest: forward.requestDigest, forwardCommitOid: forward.result!.commitOid!,
  })

  const presentFile = (path = 'a.txt', content = 'previous') => ({ path, state: 'present' as const, blobOid: 'd'.repeat(40), content, size: Buffer.byteLength(content) })
  const preimageAt = (commitOid: string, files: CompensationPreimage['files']): CompensationPreimage => ({ repository: 'owner/repository', branch: 'main', commitOid, files })
  const outcome = (record: { id: string; forwardCommitOid: string }, status: CompensationResult['status'], extra: Partial<CompensationResult> = {}): CompensationResult =>
    ({ actionId: record.id, status, repository: 'owner/repository', branch: 'main', parentOid: record.forwardCommitOid, actionMarker: `dsh-compensation:${record.id}`, ...extra })

  it('drives capturing through prepared, dispatched and succeeded with version compare-and-swap', async () => {
    const { ledger: value, authority } = await rollbackLedger()
    const forward = succeedForward(value, authority)
    const { record: capturing, created } = value.prepareCompensation({ identity, sessionId: 'session', request: receipt(forward), authority })
    expect(created).toBe(true)
    expect(capturing).toMatchObject({ status: 'capturing', version: 1, parentOid: 'a'.repeat(40), forwardCommitOid: 'b'.repeat(40), paths: ['a.txt'] })
    expect(capturing.preimage).toBeUndefined()
    const preimage = preimageAt(capturing.parentOid, [presentFile()])
    const prepared = value.captureCompensation(capturing.id, capturing.version, preimage, authority)
    expect(prepared).toMatchObject({ status: 'prepared', version: 2, preimageDigest: expect.any(String) })
    expect(prepared.preimage).toEqual(preimage)
    const dispatched = value.dispatchCompensation(prepared.id, prepared.version, authority)
    expect(dispatched).toMatchObject({ status: 'dispatched', version: 3 })
    const succeeded = value.settleCompensation(dispatched.id, dispatched.version, outcome(dispatched, 'succeeded', { resultOid: 'c'.repeat(40) }), authority)
    expect(succeeded).toMatchObject({ status: 'succeeded', version: 4, result: { resultOid: 'c'.repeat(40) } })
    value.close()
  })

  it('returns the same record for the identical idempotency key and request', async () => {
    const { ledger: value, authority } = await rollbackLedger()
    const forward = succeedForward(value, authority)
    const first = value.prepareCompensation({ identity, sessionId: 'session', request: receipt(forward), authority })
    const second = value.prepareCompensation({ identity, sessionId: 'session', request: receipt(forward), authority })
    expect(second.created).toBe(false); expect(second.record.id).toBe(first.record.id)
    value.close()
  })

  it('allows at most one compensation per succeeded forward action even with a new idempotency key', async () => {
    const { ledger: value, authority } = await rollbackLedger()
    const forward = succeedForward(value, authority)
    value.prepareCompensation({ identity, sessionId: 'session', request: receipt(forward, 'one'), authority })
    expect(() => value.prepareCompensation({ identity, sessionId: 'session-2', request: receipt(forward, 'two'), authority })).toThrow(/conflict/)
    value.close()
  })

  it('requires an exact succeeded commit receipt and rejects identity, session, version, digest and OID mismatches', async () => {
    const { ledger: value, authority } = await rollbackLedger()
    const forward = succeedForward(value, authority)
    const valid = receipt(forward)
    expect(() => value.prepareCompensation({ identity: { ...identity, workspace: '/other' }, sessionId: 'session', request: valid, authority })).toThrow(/state/)
    expect(() => value.prepareCompensation({ identity, sessionId: 'other-session', request: valid, authority })).toThrow(/state/)
    expect(() => value.prepareCompensation({ identity, sessionId: 'session', request: { ...valid, forwardActionVersion: 99 }, authority })).toThrow(/state/)
    expect(() => value.prepareCompensation({ identity, sessionId: 'session', request: { ...valid, forwardCommitOid: 'c'.repeat(40) }, authority })).toThrow(/state/)
    expect(() => value.prepareCompensation({ identity, sessionId: 'session', request: { ...valid, forwardRequestDigest: 'e'.repeat(64) }, authority })).toThrow(/state/)
    value.close()
  })

  it('cannot prepare compensation against an unknown, failed, inspect or legacy path-less commit', async () => {
    const { ledger: value, authority } = await rollbackLedger()
    const input = request(); const prepared = value.prepare({ identity, sessionId: 'session', request: input, bytes: commitBytes(input), authority }).record
    value.dispatch(prepared.id, prepared.version, authority); value.recover(authority)
    const unknown = value.get(prepared.id)!
    const unknownReceipt = { ...receipt(unknown, 'x'), forwardActionVersion: unknown.version, forwardRequestDigest: unknown.requestDigest, forwardCommitOid: 'c'.repeat(40) }
    expect(() => value.prepareCompensation({ identity, sessionId: 'session', request: unknownReceipt, authority })).toThrow(/state/)
    const succeeded = succeedForward(value, authority, 'with-paths', 'c'.repeat(40), '9'.repeat(40))
    value.close()
    const database = new DatabaseSync(join(roots[0]!, 'ledger.sqlite'))
    database.prepare('UPDATE actions SET paths_json = NULL WHERE id = ?').run(succeeded.id); database.close()
    const reopened = new ActionLedger(join(roots[0]!, 'ledger.sqlite'), { now: () => now })
    expect(() => reopened.prepareCompensation({ identity, sessionId: 'session', request: receipt(reopened.get(succeeded.id)!, 'legacy'), authority })).toThrow(/state/)
    reopened.close()
  })

  it('requires the grant to opt into rollback', async () => {
    const plain = await ledger(); const authority = plain.claimController('owner'); plain.syncGrants([grant()], authority)
    const forward = succeedForward(plain, authority)
    expect(() => plain.prepareCompensation({ identity, sessionId: 'session', request: receipt(forward), authority })).toThrow(/grant/)
    plain.close()
  })

  it('enforces the independent rollback action budget across forwards', async () => {
    const { ledger: value, authority } = await rollbackLedger(1, { rollback: { allowRollback: true, budgetId: 'rollback-budget', maxActions: 1, maxTotalBytes: 100_000 } })
    const first = succeedForward(value, authority, 'one')
    const prepared = value.prepareCompensation({ identity, sessionId: 'session', request: receipt(first, 'c1'), authority }).record
    value.captureCompensation(prepared.id, prepared.version, preimageAt(prepared.parentOid, [presentFile()]), authority)
    const second = succeedForward(value, authority, 'two')
    expect(() => value.prepareCompensation({ identity, sessionId: 'session', request: receipt(second, 'c2'), authority })).toThrow(/limit/)
    value.close()
  })

  it('rejects a preimage that would exceed the rollback byte budget', async () => {
    const { ledger: value, authority } = await rollbackLedger(1, { rollback: { allowRollback: true, budgetId: 'rollback-budget', maxActions: 2, maxTotalBytes: 10 } })
    const forward = succeedForward(value, authority)
    const prepared = value.prepareCompensation({ identity, sessionId: 'session', request: receipt(forward), authority }).record
    expect(() => value.captureCompensation(prepared.id, prepared.version, preimageAt(prepared.parentOid, [presentFile()]), authority)).toThrow(/limit/)
    expect(value.getCompensation(prepared.id)?.status).toBe('capturing')
    value.close()
  })

  it('rebinds repository, branch, parent OID and exact path order at capture', async () => {
    const { ledger: value, authority } = await rollbackLedger()
    const forward = succeedForward(value, authority)
    const prepared = value.prepareCompensation({ identity, sessionId: 'session', request: receipt(forward), authority }).record
    const file = presentFile()
    expect(() => value.captureCompensation(prepared.id, prepared.version, { ...preimageAt(prepared.parentOid, [file]), repository: 'other/repository' }, authority)).toThrow(/state/)
    expect(() => value.captureCompensation(prepared.id, prepared.version, { ...preimageAt(prepared.parentOid, [file]), branch: 'other' }, authority)).toThrow(/state/)
    expect(() => value.captureCompensation(prepared.id, prepared.version, preimageAt('f'.repeat(40), [file]), authority)).toThrow(/state/)
    expect(() => value.captureCompensation(prepared.id, prepared.version, preimageAt(prepared.parentOid, [{ path: 'b.txt', state: 'absent' }]), authority)).toThrow(/state/)
    value.captureCompensation(prepared.id, prepared.version, preimageAt(prepared.parentOid, [file]), authority)
    value.close()
  })

  it('enforces the state machine and never settles outside the dispatched state', async () => {
    const { ledger: value, authority } = await rollbackLedger()
    const forward = succeedForward(value, authority)
    const prepared = value.prepareCompensation({ identity, sessionId: 'session', request: receipt(forward), authority }).record
    expect(() => value.dispatchCompensation(prepared.id, prepared.version, authority)).toThrow(/state/)
    const ready = value.captureCompensation(prepared.id, prepared.version, preimageAt(prepared.parentOid, [presentFile()]), authority)
    expect(() => value.settleCompensation(ready.id, ready.version, outcome(ready, 'succeeded', { resultOid: 'c'.repeat(40) }), authority)).toThrow(/state/)
    const dispatched = value.dispatchCompensation(ready.id, ready.version, authority)
    const wrong = outcome(dispatched, 'succeeded', { resultOid: 'c'.repeat(40) })
    expect(() => value.settleCompensation(dispatched.id, dispatched.version, { ...wrong, parentOid: 'f'.repeat(40) }, authority)).toThrow(/state/)
    value.settleCompensation(dispatched.id, dispatched.version, wrong, authority)
    expect(() => value.dispatchCompensation(ready.id, ready.version, authority)).toThrow(/state/)
    value.close()
  })

  it('pins the grant revision at preparation and rejects capture after a grant revision change', async () => {
    const { ledger: value, authority } = await rollbackLedger()
    const forward = succeedForward(value, authority)
    const prepared = value.prepareCompensation({ identity, sessionId: 'session', request: receipt(forward), authority }).record
    value.syncGrants([rollbackGrant(2)], authority)
    expect(() => value.captureCompensation(prepared.id, prepared.version, preimageAt(prepared.parentOid, [presentFile()]), authority)).toThrow(/grant/)
    value.close()
  })

  it('recovers dispatched compensations as unknown on restart and never replays them', async () => {
    const { ledger: value, authority } = await rollbackLedger()
    const path = join(roots[0]!, 'ledger.sqlite')
    const forward = succeedForward(value, authority)
    const prepared = value.prepareCompensation({ identity, sessionId: 'session', request: receipt(forward), authority }).record
    value.captureCompensation(prepared.id, prepared.version, preimageAt(prepared.parentOid, [presentFile()]), authority)
    value.dispatchCompensation(prepared.id, 2, authority); value.close()
    const reopened = new ActionLedger(path, { now: () => now })
    expect(reopened.recoverCompensations(authority)).toBe(1)
    const recovered = reopened.getCompensation(prepared.id)!
    expect(recovered).toMatchObject({ status: 'unknown', version: 4, result: { reason: 'controller-recovery-no-replay' } })
    expect(() => reopened.dispatchCompensation(prepared.id, 3, authority)).toThrow(/state/)
    expect(reopened.recoverCompensations(authority)).toBe(0)
    reopened.close()
  })

  it('recovers prepared compensations as unknown on restart and never replays them', async () => {
    const { ledger: value, authority } = await rollbackLedger()
    const path = join(roots[0]!, 'ledger.sqlite')
    const forward = succeedForward(value, authority)
    const prepared = value.prepareCompensation({ identity, sessionId: 'session', request: receipt(forward), authority }).record
    value.captureCompensation(prepared.id, prepared.version, preimageAt(prepared.parentOid, [presentFile()]), authority)
    value.close()
    const reopened = new ActionLedger(path, { now: () => now })
    // A prepared row already carries a sealed preimage: it must become unknown,
    // never silently dispatched after restart.
    expect(reopened.recoverCompensations(authority)).toBe(1)
    const recovered = reopened.getCompensation(prepared.id)!
    expect(recovered).toMatchObject({ status: 'unknown', version: 3, result: { reason: 'controller-recovery-no-replay' } })
    expect(() => reopened.dispatchCompensation(prepared.id, 2, authority)).toThrow(/state/)
    expect(reopened.recoverCompensations(authority)).toBe(0)
    reopened.close()
  })

  it('discards capturing placeholders on restart and frees the forward action and action budget', async () => {
    const { ledger: value, authority } = await rollbackLedger(1, { rollback: { allowRollback: true, budgetId: 'rollback-budget', maxActions: 1, maxTotalBytes: 100_000 } })
    const path = join(roots[0]!, 'ledger.sqlite')
    const forward = succeedForward(value, authority)
    const capturing = value.prepareCompensation({ identity, sessionId: 'session', request: receipt(forward), authority }).record
    expect(capturing.status).toBe('capturing'); value.close()
    const reopened = new ActionLedger(path, { now: () => now })
    expect(reopened.recoverCompensations(authority)).toBe(1)
    expect(reopened.getCompensation(capturing.id)).toBeUndefined()
    // The placeholder never sealed a preimage nor dispatched anything, so the
    // one-compensation-per-forward slot and the single rollback action free up.
    const retried = reopened.prepareCompensation({ identity, sessionId: 'session', request: { ...receipt(forward), idempotencyKey: 'retry' }, authority })
    expect(retried.created).toBe(true)
    expect(reopened.recoverCompensations(authority)).toBe(1)
    reopened.close()
  })

  it('recovers a mix of capturing, prepared and dispatched compensations in one pass', async () => {
    const { ledger: value, authority } = await rollbackLedger(1, { rollback: { allowRollback: true, budgetId: 'rollback-budget', maxActions: 4, maxTotalBytes: 100_000 } })
    const path = join(roots[0]!, 'ledger.sqlite')
    const capturingForward = succeedForward(value, authority, 'one')
    const capturing = value.prepareCompensation({ identity, sessionId: 'session', request: receipt(capturingForward, 'c1'), authority }).record
    const preparedForward = succeedForward(value, authority, 'two')
    const prepared = value.prepareCompensation({ identity, sessionId: 'session', request: receipt(preparedForward, 'c2'), authority }).record
    value.captureCompensation(prepared.id, prepared.version, preimageAt(prepared.parentOid, [presentFile()]), authority)
    const dispatchedForward = succeedForward(value, authority, 'three')
    const dispatched = value.prepareCompensation({ identity, sessionId: 'session', request: receipt(dispatchedForward, 'c3'), authority }).record
    value.captureCompensation(dispatched.id, dispatched.version, preimageAt(dispatched.parentOid, [presentFile()]), authority)
    value.dispatchCompensation(dispatched.id, 2, authority)
    value.close()
    const reopened = new ActionLedger(path, { now: () => now })
    expect(reopened.recoverCompensations(authority)).toBe(3)
    expect(reopened.getCompensation(capturing.id)).toBeUndefined()
    expect(reopened.getCompensation(prepared.id)).toMatchObject({ status: 'unknown', version: 3 })
    expect(reopened.getCompensation(dispatched.id)).toMatchObject({ status: 'unknown', version: 4 })
    expect(reopened.recoverCompensations(authority)).toBe(0)
    reopened.close()
  })

  it('discards a live capturing placeholder so the forward action can be compensated again', async () => {
    // Used by the service when a denial, abort or capture failure happens
    // before any preimage is sealed: the placeholder must not wedge the slot.
    const { ledger: value, authority } = await rollbackLedger()
    const forward = succeedForward(value, authority)
    const capturing = value.prepareCompensation({ identity, sessionId: 'session', request: receipt(forward), authority }).record
    expect(value.discardCompensation(capturing.id, capturing.version, authority)).toBe(true)
    expect(value.getCompensation(capturing.id)).toBeUndefined()
    // Only a capturing row may be discarded; a sealed prepared row stays put.
    const second = value.prepareCompensation({ identity, sessionId: 'session', request: { ...receipt(forward), idempotencyKey: 'again' }, authority }).record
    value.captureCompensation(second.id, second.version, preimageAt(second.parentOid, [presentFile()]), authority)
    expect(value.discardCompensation(second.id, 2, authority)).toBe(false)
    expect(value.getCompensation(second.id)?.status).toBe('prepared')
    value.close()
  })
})
