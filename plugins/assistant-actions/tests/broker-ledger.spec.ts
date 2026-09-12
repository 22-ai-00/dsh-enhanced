import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { renameSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBrokerClientRequest, createBrokerServerHello, type BrokerRequestIntent } from '../src/broker-protocol.ts'
import { BrokerLedgerError, ExternalBrokerLedger, brokerPayloadBytes, withBrokerGrantDigest, type ExternalGitHubGrantUnsigned } from '../src/broker-ledger.ts'

const roots: string[] = []
const keys = generateKeyPairSync('ed25519')
let now = 1_000_000

function grant(changes: Partial<ExternalGitHubGrantUnsigned> = {}) {
  return withBrokerGrantDigest({
    protocol: 'assistant-actions/external-github-grant/v1', id: 'grant', revision: 1, clientKeyId: 'client-key',
    owner: { principalDigest: 'a'.repeat(64), principalRecordId: 'record', principalVersion: 1, workspace: '/workspace', preset: 'primary', bindingId: 'binding', bindingVersion: 1, bindingGeneration: 1 },
    sessionId: 'session', destination: { classification: 'github-repository', repository: 'owner/repository', branch: 'main', paths: ['a.txt'] },
    credentialId: 'github', expiresAt: now + 60_000, maxActions: 4, maxTotalBytes: 1_000_000, maxCostUnits: 4,
    allowedOperations: ['commit', 'inspect'], allowedInspectKinds: ['repository', 'branch', 'file'], client: { kind: 'assistant-actions-host', instanceId: 'host', generation: 1 },
    source: { classification: 'internal', provenanceDigest: 'b'.repeat(64) }, policyEpoch: 4, emergencyEpoch: 0, ...changes,
  })
}

function request(generation: number, value = grant(), changes: Partial<BrokerRequestIntent> = {}) {
  const payload = { expectedHeadOid: 'c'.repeat(40), headline: 'change', files: [{ path: 'a.txt', content: 'hello' }] }
  const partial = { actionId: 'action', grantId: value.id, grantRevision: value.revision, grantDigest: value.digest, owner: value.owner, sessionId: value.sessionId, agentId: 'agent', rootCallId: 'root-call', callId: 'call', operation: 'commit' as const,
    source: value.source, destination: { classification: 'github-repository' as const, repository: value.destination.repository, branch: value.destination.branch }, payload, deadline: now + 30_000,
    budget: { reservationId: 'reservation', actions: 1, bytes: 0, costMetric: 'github-api-units' as const, maxCostUnits: 1 }, ...changes }
  const hello = createBrokerServerHello({ instanceId: 'broker', generation, policyEpoch: value.policyEpoch, emergencyEpoch: value.emergencyEpoch, expiresAt: now + 30_000 }, keys.privateKey)
  const requestId = 'request-' + partial.actionId
  const first = createBrokerClientRequest(partial, hello, value.client, value.clientKeyId, keys.privateKey, requestId)
  return createBrokerClientRequest({ ...partial, budget: { ...partial.budget, bytes: brokerPayloadBytes(first) } }, hello, value.client, value.clientKeyId, keys.privateKey, requestId)
}

async function path(): Promise<string> { const root = await mkdtemp(join(tmpdir(), 'external-broker-ledger-')); roots.push(root); return join(root, 'ledger.sqlite') }
afterEach(async () => { now = 1_000_000; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('ExternalBrokerLedger', () => {
  it('rejects a private direct parent below a writable non-sticky ancestor', async () => {
    const outer = await mkdtemp(join(tmpdir(), 'external-broker-unsafe-')); roots.push(outer); await chmod(outer, 0o777)
    const parent = join(outer, 'private'); await mkdir(parent, { mode: 0o700 })
    expect(() => new ExternalBrokerLedger(join(parent, 'ledger.sqlite'), 'broker', { now: () => now })).toThrow(/unsafe-file/)
    await chmod(outer, 0o700)
  })

  it('binds SQLite open to the pinned parent and rejects a directory replacement race', async () => {
    const outer = await mkdtemp(join(tmpdir(), 'external-broker-race-')); roots.push(outer)
    const parent = join(outer, 'state'), parked = join(outer, 'parked'), replacement = join(outer, 'replacement')
    await mkdir(parent, { mode: 0o700 }); await mkdir(replacement, { mode: 0o700 })
    const databasePath = join(parent, 'ledger.sqlite')
    expect(() => new ExternalBrokerLedger(databasePath, 'broker', { now: () => now, beforeDatabaseOpen: () => { renameSync(parent, parked); renameSync(replacement, parent) } })).toThrow(/unsafe-file/)
    await rename(parent, replacement); await rename(parked, parent)
  })

  it('rejects inspect kinds that require absent base-branch authority before creating a ledger', () => {
    expect(() => grant({ allowedInspectKinds: ['repository', 'pull-request'] })).toThrow(/invalid-input/)
  })

  it('accounts action, byte, and GitHub API unit budgets before dispatch', async () => {
    const ledger = new ExternalBrokerLedger(await path(), 'broker', { now: () => now }), authority = ledger.claimController('daemon')
    const limited = grant({ maxActions: 1, maxCostUnits: 1 }); ledger.syncGrants([limited], 4, authority)
    ledger.prepare(request(authority.generation, limited), authority)
    expect(() => ledger.prepare(request(authority.generation, limited, { actionId: 'other', callId: 'other', budget: { reservationId: 'other', actions: 1, bytes: 74, costMetric: 'github-api-units', maxCostUnits: 1 } }), authority)).toThrow(/limit/)
    ledger.close()
  })

  it('fences controllers, reserves exact budgets and makes replay semantic rather than challenge-bound', async () => {
    const database = await path(), ledger = new ExternalBrokerLedger(database, 'broker', { now: () => now })
    const authority = ledger.claimController('daemon'); const value = grant(); ledger.syncGrants([value], 4, authority)
    const first = request(authority.generation, value)
    const prepared = ledger.prepare(first, authority)
    expect(prepared.record).toMatchObject({ status: 'prepared', version: 1, bytes: first.budget.bytes })
    const replayHello = createBrokerServerHello({ instanceId: 'broker', generation: authority.generation, policyEpoch: 4, emergencyEpoch: 0, expiresAt: now + 30_000, challenge: randomBytes(32).toString('base64url') }, keys.privateKey)
    const replay = createBrokerClientRequest({ actionId: first.actionId, grantId: first.grantId, grantRevision: first.grantRevision, grantDigest: first.grantDigest, owner: first.owner, sessionId: first.sessionId, agentId: first.agentId, rootCallId: first.rootCallId, callId: first.callId, operation: first.operation, source: first.source, destination: first.destination, payload: first.payload, deadline: first.deadline, budget: first.budget }, replayHello, first.client, first.clientKeyId, keys.privateKey, 'another-request')
    expect(ledger.prepare(replay, authority)).toMatchObject({ created: false, record: { actionId: first.actionId } })
    expect(() => ledger.claimController('other')).toThrow(BrokerLedgerError)
    ledger.close()
  })

  it('recovers prepared as failed and dispatched as unknown without replay', async () => {
    const database = await path(), first = new ExternalBrokerLedger(database, 'broker', { now: () => now }), authority = first.claimController('first')
    const value = grant(); first.syncGrants([value], 4, authority)
    const preparedRequest = request(authority.generation, value, { actionId: 'prepared', callId: 'prepared', budget: { reservationId: 'prepared', actions: 1, bytes: 74, costMetric: 'github-api-units', maxCostUnits: 1 } })
    const prepared = first.prepare(preparedRequest, authority).record
    const dispatchedRequest = request(authority.generation, value, { actionId: 'dispatched', callId: 'dispatched', budget: { reservationId: 'dispatched', actions: 1, bytes: 74, costMetric: 'github-api-units', maxCostUnits: 1 } })
    let dispatched = first.prepare(dispatchedRequest, authority).record
    dispatched = first.dispatch(dispatched.actionId, dispatched.version, dispatched.requestDigest, 'github', now + 10_000, authority)
    now += 31_000; first.close()
    const second = new ExternalBrokerLedger(database, 'broker', { now: () => now }), next = second.claimController('second')
    expect(next.generation).toBe(2)
    expect(second.status('client-key', prepared.actionId, prepared.requestDigest)?.outcome).toMatchObject({ status: 'failed', dispatched: false, error: { code: 'restart-before-dispatch' } })
    expect(second.status('client-key', dispatched.actionId, dispatched.requestDigest)?.outcome).toMatchObject({ status: 'unknown', dispatched: true, error: { code: 'restart-after-dispatch' } })
    second.close()
  })

  it('bumps emergency epoch on stop and resume so stale requests never revive', async () => {
    const ledger = new ExternalBrokerLedger(await path(), 'broker', { now: () => now }), authority = ledger.claimController('daemon'), value = grant()
    ledger.syncGrants([value], 4, authority)
    const prepared = ledger.prepare(request(authority.generation, value), authority).record
    const stopped = ledger.stop(ledger.snapshot().controlVersion, 'security-response', authority)
    expect(stopped).toMatchObject({ stopped: true, emergencyEpoch: 1 })
    expect(ledger.status('client-key', prepared.actionId, prepared.requestDigest)?.outcome).toMatchObject({ status: 'failed', dispatched: false })
    const resumed = ledger.resume(stopped.controlVersion, 'operator-resume', authority)
    expect(resumed).toMatchObject({ stopped: false, emergencyEpoch: 2 })
    expect(() => ledger.prepare(request(authority.generation, value, { actionId: 'stale', callId: 'stale' }), authority)).toThrow(/grant/)
    ledger.close()
  })

  it('consumes the admin nonce atomically with a control mutation', async () => {
    const ledger = new ExternalBrokerLedger(await path(), 'broker', { now: () => now }), authority = ledger.claimController('daemon'), value = grant()
    ledger.syncGrants([value], 4, authority)
    const input = { adminKeyId: 'admin', nonce: 'nonce-value', requestDigest: 'e'.repeat(64), expiresAt: now + 10_000, mutation: { operation: 'stop' as const, expectedControlVersion: 1, reason: 'security-response' }, authority }
    expect(ledger.applyAdminMutation(input)).toMatchObject({ stopped: true, controlVersion: 2, emergencyEpoch: 1 })
    expect(() => ledger.applyAdminMutation({ ...input, mutation: { operation: 'resume', expectedControlVersion: 2, expectedGeneration: 1, reason: 'operator-resume' } })).toThrow(/conflict/)
    expect(ledger.snapshot()).toMatchObject({ stopped: true, controlVersion: 2, emergencyEpoch: 1 })
    ledger.close()
  })

  it('revokes the exact current grant and preserves the tombstone across reopen', async () => {
    const database = await path(), ledger = new ExternalBrokerLedger(database, 'broker', { now: () => now }), authority = ledger.claimController('daemon'), value = grant()
    ledger.syncGrants([value], 4, authority)
    const revoked = ledger.revoke(value.id, value.revision, ledger.snapshot().controlVersion, 'operator-request', authority)
    expect(revoked.controlVersion).toBe(2)
    expect(ledger.grant(value.id)).toBeUndefined()
    expect(() => ledger.syncGrants([value], 4, authority)).toThrow(/conflict/)
    now += 31_000; ledger.close()
    const reopened = new ExternalBrokerLedger(database, 'broker', { now: () => now }), next = reopened.claimController('next')
    expect(reopened.grant(value.id)).toBeUndefined()
    reopened.releaseController(next); reopened.close()
  })

  it('fails closed when a canonical stored grant is tampered', async () => {
    const databasePath = await path(), ledger = new ExternalBrokerLedger(databasePath, 'broker', { now: () => now }), authority = ledger.claimController('daemon'), value = grant()
    ledger.syncGrants([value], 4, authority); ledger.close()
    const { DatabaseSync } = await import('node:sqlite'); const database = new DatabaseSync(databasePath)
    database.prepare('UPDATE grants SET digest=? WHERE id=?').run('f'.repeat(64), value.id); database.close()
    expect(() => new ExternalBrokerLedger(databasePath, 'broker', { now: () => now })).toThrow(/schema/)
  })

  it('fails closed when schema constraints or a persisted credential lease are tampered', async () => {
    const databasePath = await path(), ledger = new ExternalBrokerLedger(databasePath, 'broker', { now: () => now }), authority = ledger.claimController('daemon'), value = grant()
    ledger.syncGrants([value], 4, authority); const requestValue = request(authority.generation, value), prepared = ledger.prepare(requestValue, authority).record
    ledger.dispatch(prepared.actionId, prepared.version, prepared.requestDigest, 'github', now + 10_000, authority); ledger.close()
    const { DatabaseSync } = await import('node:sqlite'); const database = new DatabaseSync(databasePath)
    database.prepare('UPDATE credential_leases SET credential_id=?').run('wrong'); database.close()
    expect(() => new ExternalBrokerLedger(databasePath, 'broker', { now: () => now })).toThrow(/schema/)
  })
})
