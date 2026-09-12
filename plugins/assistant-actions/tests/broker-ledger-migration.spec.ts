import { generateKeyPairSync } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createBrokerClientRequest, createBrokerServerHello, type BrokerOperation, type BrokerRequestIntent } from '../src/broker-protocol.ts'
import { ExternalBrokerLedger, brokerPayloadBytes, withBrokerGrantDigest, type ExternalGitHubGrantUnsigned } from '../src/broker-ledger.ts'

const roots: string[] = []
const keys = generateKeyPairSync('ed25519')
let now = 1_000_000

async function database(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'external-broker-v1-migration-')); roots.push(root)
  return join(root, name)
}
afterEach(async () => { now = 1_000_000; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function grant(changes: Partial<ExternalGitHubGrantUnsigned> = {}) {
  return withBrokerGrantDigest({
    protocol: 'assistant-actions/external-github-grant/v1', id: 'grant', revision: 1, clientKeyId: 'client-key',
    owner: { principalDigest: 'a'.repeat(64), principalRecordId: 'record', principalVersion: 1, workspace: '/workspace', preset: 'primary', bindingId: 'binding', bindingVersion: 1, bindingGeneration: 1 },
    sessionId: 'session', destination: { classification: 'github-repository', repository: 'owner/repository', branch: 'main', paths: ['a.txt'] }, credentialId: 'github',
    expiresAt: now + 60_000, maxActions: 2, maxTotalBytes: 1_000_000, maxCostUnits: 2, allowedOperations: ['commit', 'inspect'], allowedInspectKinds: ['repository', 'branch', 'file'],
    client: { kind: 'assistant-actions-host', instanceId: 'host', generation: 1 }, source: { classification: 'internal', provenanceDigest: 'b'.repeat(64) }, policyEpoch: 4, emergencyEpoch: 0, ...changes,
  })
}
function request(generation: number, value = grant(), changes: Partial<BrokerRequestIntent> = {}) {
  const operation = (changes.operation ?? 'commit') as BrokerOperation
  const payload = operation === 'commit' ? { expectedHeadOid: 'c'.repeat(40), headline: 'change', files: [{ path: 'a.txt', content: 'hello' }] }
    : operation === 'pull-request' ? { expectedHeadOid: 'c'.repeat(40), title: 'Change', body: 'Bounded change' } : { kind: 'repository' as const }
  const partial = { actionId: 'legacy-action', grantId: value.id, grantRevision: value.revision, grantDigest: value.digest, owner: value.owner, sessionId: value.sessionId,
    agentId: 'agent', rootCallId: 'root-call', callId: 'call', operation, source: value.source,
    destination: { classification: 'github-repository' as const, repository: value.destination.repository, branch: value.destination.branch, ...(value.destination.baseBranch === undefined ? {} : { baseBranch: value.destination.baseBranch }) }, payload,
    deadline: now + 30_000, budget: { reservationId: 'legacy-reservation', actions: 1, bytes: 0, costMetric: 'github-api-units' as const, maxCostUnits: 1 }, ...changes }
  const hello = createBrokerServerHello({ instanceId: 'broker', generation, policyEpoch: value.policyEpoch, emergencyEpoch: value.emergencyEpoch, expiresAt: now + 30_000 }, keys.privateKey)
  const requestId = 'request-' + partial.actionId
  const first = createBrokerClientRequest(partial, hello, value.client, value.clientKeyId, keys.privateKey, requestId)
  return createBrokerClientRequest({ ...partial, budget: { ...partial.budget, bytes: brokerPayloadBytes(first) } }, hello, value.client, value.clientKeyId, keys.privateKey, requestId)
}

// This is the exact v1 layout from 7a36512, intentionally excluding v2's PR
// operation, PR credential lease purpose, and PR occupancy index.
const V1_DDL = [
  'CREATE TABLE meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), instance_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>=0), controller_fence INTEGER NOT NULL CHECK(controller_fence>=0), control_version INTEGER NOT NULL CHECK(control_version>=0), policy_epoch INTEGER NOT NULL CHECK(policy_epoch>=0), emergency_epoch INTEGER NOT NULL CHECK(emergency_epoch>=0), stopped INTEGER NOT NULL CHECK(stopped IN (0,1)), draining INTEGER NOT NULL CHECK(draining IN (0,1))) STRICT',
  'CREATE TABLE controller (singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner_id TEXT NOT NULL, fence INTEGER NOT NULL CHECK(fence>=1), generation INTEGER NOT NULL CHECK(generation>=1), expires_at INTEGER NOT NULL CHECK(expires_at>=0)) STRICT',
  'CREATE TABLE grants (id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1), digest TEXT NOT NULL, grant_json TEXT NOT NULL, revoked INTEGER NOT NULL CHECK(revoked IN (0,1)), created_at INTEGER NOT NULL CHECK(created_at>=0), PRIMARY KEY(id,revision), UNIQUE(digest)) STRICT, WITHOUT ROWID',
  'CREATE TABLE grant_heads (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, revoked INTEGER NOT NULL CHECK(revoked IN (0,1)), FOREIGN KEY(id,revision) REFERENCES grants(id,revision)) STRICT',
  "CREATE TABLE requests (action_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, client_key_id TEXT NOT NULL, owner_json TEXT NOT NULL, session_id TEXT NOT NULL, agent_id TEXT NOT NULL, root_call_id TEXT NOT NULL, call_id TEXT NOT NULL, grant_id TEXT NOT NULL, grant_revision INTEGER NOT NULL, grant_digest TEXT NOT NULL, request_digest TEXT NOT NULL, operation TEXT NOT NULL CHECK(operation IN ('commit','inspect')), repository TEXT NOT NULL, branch TEXT NOT NULL, expected_head_oid TEXT, payload_digest TEXT NOT NULL, budget_reservation_id TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>=0), cost_units INTEGER NOT NULL CHECK(cost_units>=0), deadline INTEGER NOT NULL CHECK(deadline>=1), policy_epoch INTEGER NOT NULL CHECK(policy_epoch>=0), emergency_epoch INTEGER NOT NULL CHECK(emergency_epoch>=0), generation INTEGER NOT NULL CHECK(generation>=1), status TEXT NOT NULL CHECK(status IN ('prepared','dispatched','succeeded','failed','unknown')), version INTEGER NOT NULL CHECK(version>=1), dispatched_at INTEGER, result_json TEXT, UNIQUE(client_key_id,request_id), UNIQUE(client_key_id,action_id), UNIQUE(client_key_id,budget_reservation_id), FOREIGN KEY(grant_id,grant_revision) REFERENCES grants(id,revision), CHECK((status IN ('prepared','dispatched') AND result_json IS NULL) OR (status IN ('succeeded','failed','unknown') AND result_json IS NOT NULL)), CHECK((status='prepared' AND dispatched_at IS NULL) OR status!='prepared')) STRICT",
  "CREATE TABLE credential_leases (action_id TEXT PRIMARY KEY, credential_id TEXT NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('github.commit','github.inspect')), status TEXT NOT NULL CHECK(status IN ('active','completed','failed','revoked')), issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, settled_at INTEGER, version INTEGER NOT NULL, FOREIGN KEY(action_id) REFERENCES requests(action_id), CHECK((status='active' AND settled_at IS NULL) OR (status!='active' AND settled_at IS NOT NULL))) STRICT",
  'CREATE TABLE admin_nonces (admin_key_id TEXT NOT NULL, nonce_digest TEXT NOT NULL, request_digest TEXT NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>=1), PRIMARY KEY(admin_key_id,nonce_digest)) STRICT, WITHOUT ROWID',
  'CREATE TABLE audit (sequence INTEGER PRIMARY KEY, kind TEXT NOT NULL, subject_id TEXT NOT NULL, revision INTEGER, recorded_at INTEGER NOT NULL, previous_digest TEXT NOT NULL, digest TEXT NOT NULL UNIQUE) STRICT',
  'CREATE INDEX requests_grant_budget ON requests(grant_id,dispatched_at,status)', 'CREATE INDEX requests_status ON requests(status)',
]
const TABLES = ['meta', 'controller', 'grants', 'grant_heads', 'requests', 'credential_leases', 'admin_nonces', 'audit']
function makeV1(targetPath: string, sourcePath?: string): void {
  const target = new DatabaseSync(targetPath, { enableForeignKeyConstraints: true })
  target.exec(`PRAGMA foreign_keys=ON; ${V1_DDL.join(';')}; PRAGMA user_version=1`)
  if (sourcePath) {
    const source = new DatabaseSync(sourcePath)
    try {
      for (const table of TABLES) {
        const rows = source.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>
        if (!rows.length) continue
        const columns = Object.keys(rows[0]!)
        const insert = target.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
        for (const row of rows) (insert as unknown as { run(...values: unknown[]): void }).run(...columns.map(column => row[column]))
      }
    } finally { source.close() }
  }
  target.close(); chmodSync(targetPath, 0o600)
}

describe('ExternalBrokerLedger v1 migration', () => {
  it('migrates a real v1 database without replaying unknown history or clearing its budget, then admits one bounded PR', async () => {
    const sourcePath = await database('source.sqlite'), v1Path = await database('v1.sqlite')
    const source = new ExternalBrokerLedger(sourcePath, 'broker', { now: () => now }), sourceAuthority = source.claimController('source'), legacyGrant = grant()
    source.syncGrants([legacyGrant], 4, sourceAuthority)
    let legacy = source.prepare(request(sourceAuthority.generation, legacyGrant), sourceAuthority).record
    legacy = source.dispatch(legacy.actionId, legacy.version, legacy.requestDigest, 'github', now + 10_000, sourceAuthority)
    legacy = source.settle(legacy.actionId, legacy.version, legacy.requestDigest, { status: 'unknown', dispatched: true, result: null, error: { code: 'ack-lost' }, completedAt: now }, sourceAuthority)
    source.releaseController(sourceAuthority); source.close()
    makeV1(v1Path, sourcePath)

    const migrated = new ExternalBrokerLedger(v1Path, 'broker', { now: () => now }), authority = migrated.claimController('migrated')
    expect(migrated.status(legacy.clientKeyId, legacy.actionId, legacy.requestDigest)).toMatchObject({ status: 'unknown', outcome: { status: 'unknown', dispatched: true, error: { code: 'ack-lost' } } })
    expect(() => migrated.dispatch(legacy.actionId, legacy.version, legacy.requestDigest, 'github', now + 10_000, authority)).toThrow(/state/)
    const prGrant = grant({ revision: 2, destination: { classification: 'github-repository', repository: 'owner/repository', branch: 'main', baseBranch: 'release', paths: ['a.txt'] }, allowedOperations: ['commit', 'pull-request'], allowedInspectKinds: [] })
    migrated.syncGrants([prGrant], 4, authority)
    const pr = migrated.prepare(request(authority.generation, prGrant, { actionId: 'migrated-pr', callId: 'migrated-pr', operation: 'pull-request', budget: { reservationId: 'migrated-pr', actions: 1, bytes: 0, costMetric: 'github-api-units', maxCostUnits: 1 } }), authority).record
    expect(pr.operation).toBe('pull-request')
    expect(() => migrated.prepare(request(authority.generation, prGrant, { actionId: 'over-budget', callId: 'over-budget', operation: 'commit', payload: { expectedHeadOid: 'd'.repeat(40), headline: 'next', files: [{ path: 'a.txt', content: 'next' }] }, budget: { reservationId: 'over-budget', actions: 1, bytes: 0, costMetric: 'github-api-units', maxCostUnits: 1 } }), authority)).toThrow(/limit/)
    migrated.releaseController(authority); migrated.close()

    const reopened = new ExternalBrokerLedger(v1Path, 'broker', { now: () => now })
    expect(reopened.status(legacy.clientKeyId, legacy.actionId, legacy.requestDigest)?.outcome?.status).toBe('unknown')
    expect(reopened.grant('grant')?.revision).toBe(2)
    reopened.close()
    const inspect = new DatabaseSync(v1Path)
    expect((inspect.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
    expect((inspect.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name='requests_pr_occupancy'").get() as { name?: string } | undefined)?.name).toBe('requests_pr_occupancy')
    inspect.close()
  })

  it('fails closed for an incomplete v1 schema', async () => {
    const path = await database('broken-v1.sqlite')
    const db = new DatabaseSync(path); db.exec('CREATE TABLE meta (singleton INTEGER PRIMARY KEY) STRICT; PRAGMA user_version=1'); db.close(); chmodSync(path, 0o600)
    expect(() => new ExternalBrokerLedger(path, 'broker', { now: () => now })).toThrow(/schema/)
  })
})
