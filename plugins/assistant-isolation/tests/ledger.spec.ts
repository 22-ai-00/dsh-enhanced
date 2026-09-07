import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { IsolationLedger, IsolationLedgerError } from '../src/ledger.ts'
import type { IsolationGrant, IsolationIdentity, IsolationResult } from '../src/types.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const clock = () => 10_000
const identity: IsolationIdentity = { principalDigest: 'principal', principalRecordId: 'record', principalVersion: 1, workspace: '/work', agentPreset: 'default' }
const grant = (revision = 1): IsolationGrant => ({ ...identity, id: 'grant', revision, expiresAt: 100_000, maxRuns: 2, maxTotalDurationMs: 2_000 })
const input = (key = 'key') => ({ identity, sessionId: 'session', grantId: 'grant', idempotencyKey: key, requestDigest: `digest-${key}`, durationMs: 500 })
const reservation = (memoryMiB = 64, workspaceInodes = 100) => ({ memoryMiB, workspaceInodes, maxMemoryMiB: 100, maxWorkspaceInodes: 200 })
const unknown = (jobId: string, quiescent = false): IsolationResult => ({ jobId, status: 'unknown', quiescent, stdout: '', stderr: '', artifacts: [] })
const binding = (paths: readonly string[]) => ({ admission: { protocol: 'goal-artifact-admission/v1' as const, contractId: 'contract-1', contractDigest: 'a'.repeat(64), runId: 'run-1', turn: 1 }, paths })
function path(): string { const root = mkdtempSync(join(tmpdir(), 'isolation-ledger-')); roots.push(root); chmodSync(root, 0o700); return join(root, 'ledger.sqlite') }
function error(fn: () => unknown): IsolationLedgerError { try { fn() } catch (caught) { expect(caught).toBeInstanceOf(IsolationLedgerError); return caught as IsolationLedgerError }; throw new Error('expected ledger error') }

describe('IsolationLedger', () => {
  it('creates a private WAL/FULL durable schema', () => {
    const file = path(); const ledger = new IsolationLedger(file, { now: clock }); ledger.close()
    const database = new DatabaseSync(file)
    expect((database.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
    expect((statSync(file).mode & 0o777)).toBe(0o600)
    expect((statSync(join(file, '..')).mode & 0o777)).toBe(0o700)
    expect((database.prepare("SELECT value FROM schema_meta WHERE key='schema-version'").get() as { value: string }).value).toBe('6')
    expect((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(6)
    expect((database.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum).toBe(2)
    database.close()
  })

  it('accepts a grant whose expiry uses the real Unix-millisecond clock', () => {
    const ledger = new IsolationLedger(':memory:')
    ledger.syncGrants([{ ...grant(), expiresAt: Date.now() + 60_000 }])
    expect(ledger.prepare(input()).created).toBe(true)
    ledger.close()
  })

  it('atomically bounds two database connections and replays an idempotent prepare', () => {
    const file = path(); const first = new IsolationLedger(file, { now: clock }); const second = new IsolationLedger(file, { now: clock }); first.syncGrants([grant()])
    const prepared = first.prepare({ ...input(), maxActiveJobs: 1 }); expect(prepared.created).toBe(true)
    expect(second.prepare({ ...input(), maxActiveJobs: 1 })).toEqual({ job: prepared.job, created: false })
    expect(error(() => second.prepare({ ...input('next'), maxActiveJobs: 1 })).code).toBe('unauthorized')
    expect(error(() => second.prepare({ ...input(), requestDigest: 'other' })).code).toBe('conflict')
    first.close(); second.close()
  })

  it('does not revive a revoked grant on same-revision reload, and fences old jobs on a newer revision', () => {
    const ledger = new IsolationLedger(':memory:', { now: clock }); ledger.syncGrants([grant()]); const job = ledger.prepare(input()).job
    ledger.revoke('grant', 1, 'operator')
    ledger.syncGrants([grant()])
    expect(ledger.usable(job.id)).toBe(false)
    expect(error(() => ledger.start(job.id, job.version)).code).toBe('unauthorized')
    ledger.syncGrants([grant(2)])
    expect(error(() => ledger.start(job.id, job.version)).code).toBe('unauthorized')
    expect(error(() => ledger.syncGrants([grant(1)])).code).toBe('conflict')
    ledger.close()
  })

  it('binds every identity field and never replays a recoverable job as a fresh run', () => {
    const file = path(); const ledger = new IsolationLedger(file, { now: clock }); ledger.syncGrants([grant()]); const job = ledger.prepare(input()).job; ledger.close()
    const reopened = new IsolationLedger(file, { now: clock })
    expect(reopened.prepare(input())).toMatchObject({ created: false, job: { id: job.id, status: 'prepared' } })
    expect(error(() => reopened.prepare({ ...input(), identity: { ...identity, agentPreset: 'other' } })).code).toBe('unauthorized')
    expect(reopened.recoverable()).toMatchObject([{ id: job.id, status: 'prepared' }])
    reopened.close()
  })

  it('uses a fenced controller lease for Host writes and permits only unknown quiescence cleanup', () => {
    const ledger = new IsolationLedger(':memory:', { now: clock }); const old = ledger.claimController('first-host', 100)
    ledger.syncGrants([grant()], old); const job = ledger.prepare({ ...input(), authority: old }).job
    expect(error(() => ledger.start(job.id, job.version, { ownerId: 'first-host', fence: old.fence + 1 })).code).toBe('unauthorized')
    const running = ledger.start(job.id, job.version, old); const stranded = ledger.settle(running.id, running.version, unknown(running.id), old)
    expect(error(() => ledger.settle(stranded.id, stranded.version, unknown(stranded.id, true), old)).code).toBe('invalid-state')
    expect(ledger.get(stranded.id)?.result).toMatchObject({ status: 'unknown', quiescent: false })
    expect(ledger.recoverable()).toHaveLength(1)
    ledger.releaseController(old); const fresh = ledger.claimController('second-host', 100)
    expect(error(() => ledger.prepare({ ...input('later'), authority: old })).code).toBe('unauthorized')
    expect(ledger.hasController(fresh)).toBe(true)
    ledger.close()
  })
  it('paginates every unresolved job without starving records after the first 1000', () => {
    const ledger = new IsolationLedger(':memory:', { now: clock })
    ledger.syncGrants([{ ...grant(), maxRuns: 1001, maxTotalDurationMs: 1_000_000 }])
    for (let n = 0; n < 1001; n++) ledger.prepare(input(`page-${n}`))
    const first = ledger.recoverable()
    expect(first).toHaveLength(1000)
    const second = ledger.recoverable(first.at(-1)!.id)
    expect(second).toHaveLength(1)
    expect(new Set([...first, ...second].map(job => job.id)).size).toBe(1001)
    expect(ledger.recoverable(second[0]!.id)).toHaveLength(0)
    ledger.close()
  })

  it('atomically reserves global memory and inode pools without double-charging idempotency', () => {
    const file = path(); const first = new IsolationLedger(file, { now: clock }); const second = new IsolationLedger(file, { now: clock })
    first.syncGrants([{ ...grant(), maxRuns: 10, maxTotalDurationMs: 10_000 }])
    const prepared = first.prepare({ ...input('pool-a'), resourceReservation: reservation(60, 80) })
    expect(prepared.job).toMatchObject({ reservedMemoryMiB: 60, reservedWorkspaceInodes: 80 })
    expect(second.prepare({ ...input('pool-a'), resourceReservation: reservation(60, 80) })).toMatchObject({ created: false, job: { id: prepared.job.id } })
    expect(error(() => second.prepare({ ...input('pool-memory'), resourceReservation: reservation(41, 10) })).code).toBe('unauthorized')
    expect(error(() => second.prepare({ ...input('pool-inodes'), resourceReservation: reservation(40, 121) })).code).toBe('unauthorized')
    const auditDatabase = new DatabaseSync(file)
    const audit = auditDatabase.prepare("SELECT detail FROM isolation_audit WHERE action='job-prepared' ORDER BY sequence DESC LIMIT 1").get() as { detail: string }
    expect(audit.detail).toContain('reservation:memoryMiB:60,workspaceInodes:80')
    auditDatabase.close()
    first.close(); second.close()
  })

  it('holds reservations for every non-quiescent result and releases only after cleanup', () => {
    const ledger = new IsolationLedger(':memory:', { now: clock }); ledger.syncGrants([{ ...grant(), maxRuns: 10, maxTotalDurationMs: 10_000 }])
    const stranded = ledger.prepare({ ...input('stranded'), resourceReservation: reservation(60, 100) }).job
    const settled = ledger.settle(stranded.id, stranded.version, unknown(stranded.id))
    expect(error(() => ledger.prepare({ ...input('blocked'), resourceReservation: reservation(41, 100) })).code).toBe('unauthorized')
    const cleaned = ledger.settle(settled.id, settled.version, unknown(settled.id, true))
    expect(ledger.prepare({ ...input('released'), resourceReservation: reservation(41, 100) }).created).toBe(true)
    expect(error(() => ledger.settle(cleaned.id, cleaned.version, { ...unknown(cleaned.id), status: 'succeeded', quiescent: false })).code).toBe('invalid-input')
    ledger.close()
  })

  it('migrates a v1 database, retains legacy records, and fails closed until cleanup', () => {
    const file = path(); const database = new DatabaseSync(file)
    database.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO schema_meta(key, value) VALUES ('schema-version', '1');
      CREATE TABLE isolation_grants (id TEXT PRIMARY KEY, digest TEXT NOT NULL, revision INTEGER NOT NULL, expires_at INTEGER NOT NULL, max_runs INTEGER NOT NULL, max_total_duration_ms INTEGER NOT NULL, revoked INTEGER NOT NULL CHECK(revoked IN (0,1)), revoke_reason TEXT, principal_digest TEXT NOT NULL, principal_record_id TEXT NOT NULL, principal_version INTEGER NOT NULL, workspace TEXT NOT NULL, agent_preset TEXT NOT NULL) STRICT;
      CREATE TABLE isolation_jobs (id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, grant_revision INTEGER NOT NULL, principal_digest TEXT NOT NULL, principal_record_id TEXT NOT NULL, principal_version INTEGER NOT NULL, workspace TEXT NOT NULL, agent_preset TEXT NOT NULL, session_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL, container_name TEXT NOT NULL UNIQUE, deadline INTEGER NOT NULL, reserved_duration_ms INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('prepared','running','succeeded','failed','cancelled','timed-out','unknown')), version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, result_json TEXT, UNIQUE(principal_digest, principal_record_id, principal_version, workspace, agent_preset, session_id, grant_id, idempotency_key)) STRICT;
      CREATE INDEX isolation_jobs_grant ON isolation_jobs(grant_id);
      CREATE INDEX isolation_jobs_recoverable ON isolation_jobs(status, updated_at);
      CREATE TABLE isolation_audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at INTEGER NOT NULL, action TEXT NOT NULL, job_id TEXT, grant_id TEXT, detail TEXT NOT NULL) STRICT;
      CREATE TABLE isolation_controller (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), owner_id TEXT NOT NULL, fence INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT;
      PRAGMA user_version = 1;`)
    database.prepare('INSERT INTO isolation_grants(id,digest,revision,expires_at,max_runs,max_total_duration_ms,revoked,principal_digest,principal_record_id,principal_version,workspace,agent_preset) VALUES (?,?,?,?,?,?,0,?,?,?,?,?)').run('grant', JSON.stringify(grant()), 1, 100_000, 10, 10_000, identity.principalDigest, identity.principalRecordId, identity.principalVersion, identity.workspace, identity.agentPreset)
    database.prepare("INSERT INTO isolation_jobs(id,grant_id,grant_revision,principal_digest,principal_record_id,principal_version,workspace,agent_preset,session_id,idempotency_key,request_digest,container_name,deadline,reserved_duration_ms,status,version,created_at,updated_at) VALUES ('legacy','grant',1,?,?,?,?,?,?,?,?,?,100000,500,'prepared',1,10000,10000)").run(identity.principalDigest, identity.principalRecordId, identity.principalVersion, identity.workspace, identity.agentPreset, 'session', 'legacy-key', 'legacy-digest', 'dsh-isolation-legacy')
    database.close()
    const ledger = new IsolationLedger(file, { now: clock })
    expect(ledger.get('legacy')).toMatchObject({ reservedMemoryMiB: 0, reservedWorkspaceInodes: 0, reservedStorageBytes: 0, status: 'prepared' })
    expect(error(() => ledger.prepare({ ...input('new'), resourceReservation: reservation() })).code).toBe('unauthorized')
    const legacy = ledger.get('legacy')!
    expect(legacy.dispatchAttempted).toBe(true)
    expect(error(() => ledger.settle(legacy.id, legacy.version, unknown(legacy.id, true))).code).toBe('invalid-state')
    ledger.settle(legacy.id, legacy.version, unknown(legacy.id))
    expect(error(() => ledger.prepare({ ...input('new'), resourceReservation: reservation() })).code).toBe('unauthorized')
    ledger.close()
    const reopened = new DatabaseSync(file)
    expect((reopened.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(6)
    expect((reopened.prepare("SELECT value FROM schema_meta WHERE key='schema-version'").get() as { value: string }).value).toBe('6')
    expect((reopened.prepare("SELECT COUNT(*) AS count FROM isolation_jobs WHERE id='legacy'").get() as { count: number }).count).toBe(1)
    reopened.close()
  })

  it('persists spawn intent before start, fences stale intent, and holds every ambiguous outcome', () => {
    const file = path()
    const ledger = new IsolationLedger(file, { now: clock })
    const authority = ledger.claimController('host', 100)
    ledger.syncGrants([grant()], authority)
    const prepared = ledger.prepare({ ...input(), resourceReservation: reservation(), authority }).job
    expect(prepared.dispatchAttempted).toBe(false)
    expect(error(() => ledger.markDispatched(prepared.id, prepared.version, { ...authority, fence: authority.fence + 1 })).code).toBe('unauthorized')
    const dispatched = ledger.markDispatched(prepared.id, prepared.version, authority)
    expect(dispatched).toMatchObject({ status: 'prepared', dispatchAttempted: true, version: prepared.version + 1 })
    expect(error(() => ledger.markDispatched(prepared.id, prepared.version, authority)).code).toBe('conflict')
    expect(error(() => ledger.markDispatched(dispatched.id, dispatched.version, authority)).code).toBe('invalid-state')
    ledger.close()
    const reopened = new IsolationLedger(file, { now: clock })
    try {
      expect(reopened.get(prepared.id)?.dispatchAttempted).toBe(true)
      const failed = reopened.settle(dispatched.id, dispatched.version, { ...unknown(dispatched.id), reason: 'supervisor-exited:1' }, authority)
      expect(error(() => reopened.settle(failed.id, failed.version, { ...failed.result!, quiescent: true }, authority)).code).toBe('invalid-state')
      expect(error(() => reopened.prepare({ ...input('blocked'), resourceReservation: reservation() })).code).toBe('unauthorized')
      const db = new DatabaseSync(file)
      try { expect(db.prepare("SELECT action FROM isolation_audit WHERE job_id=? ORDER BY sequence").all(prepared.id).map(row => row.action)).toEqual(['job-prepared', 'supervisor-spawn-intent', 'job-settled']) }
      finally { db.close() }
    } finally { reopened.close() }
  })

  it('migrates v2 jobs conservatively and preserves private evidence outside the public result', () => {
    const file = path()
    let ledger = new IsolationLedger(file, { now: clock })
    ledger.syncGrants([grant()])
    const legacy = ledger.prepare({ ...input('v2'), resourceReservation: reservation() }).job
    ledger.close()
    const db = new DatabaseSync(file)
    db.exec("DROP INDEX isolation_artifact_contract; ALTER TABLE isolation_jobs DROP COLUMN artifact_binding_json; ALTER TABLE isolation_jobs DROP COLUMN creation_witness_json; ALTER TABLE isolation_jobs DROP COLUMN dispatch_attempted; ALTER TABLE isolation_jobs DROP COLUMN reserved_storage_bytes; PRAGMA user_version=2; UPDATE schema_meta SET value='2' WHERE key='schema-version';")
    db.close()
    ledger = new IsolationLedger(file, { now: clock })
    try {
      expect(ledger.get(legacy.id)).toMatchObject({ dispatchAttempted: true, reservedMemoryMiB: 64, reservedWorkspaceInodes: 100, reservedStorageBytes: 0 })
      const process = { bootId: '00000000-0000-0000-0000-000000000000', pid: 1, startTicks: '1' }
      const witness = { daemon: { process, engineId: 'engine', dockerPath: '/usr/bin/docker', socketPath: '/run/docker.sock', pidFile: '/run/docker.pid' }, supervisor: { ...process, pid: 2 } }
      const settled = ledger.settle(legacy.id, legacy.version, unknown(legacy.id), undefined, witness)
      expect(settled.creationWitness).toEqual(witness)
      expect(settled.result).not.toHaveProperty('creationWitness')
      expect(error(() => ledger.settle(settled.id, settled.version, unknown(settled.id, true))).code).toBe('invalid-state')
      ledger.close()
      ledger = new IsolationLedger(file, { now: clock })
      expect(ledger.get(legacy.id)?.creationWitness).toEqual(witness)
    } finally { ledger.close() }
  })

  it('migrates v5 binding storage as null and never lets a same-key replay attach a binding', () => {
    const file = path(); let ledger = new IsolationLedger(file, { now: clock }); ledger.syncGrants([grant()])
    const legacy = ledger.prepare(input('legacy-v5')).job; ledger.close()
    const database = new DatabaseSync(file)
    database.exec("DROP INDEX isolation_artifact_contract; ALTER TABLE isolation_jobs DROP COLUMN artifact_binding_json; PRAGMA user_version=5; UPDATE schema_meta SET value='5' WHERE key='schema-version';")
    database.close()
    ledger = new IsolationLedger(file, { now: clock })
    try {
      expect(ledger.get(legacy.id)?.artifactBinding).toBeUndefined()
      const replay = ledger.prepare({ ...input('legacy-v5'), artifactBinding: binding(['report.txt']) })
      expect(replay).toMatchObject({ created: false, job: { id: legacy.id } })
      expect(replay.job.artifactBinding).toBeUndefined()
    } finally { ledger.close() }
  })

  it('uses the latest declared artifact attempt even when it failed or remains unknown', () => {
    const ledger = new IsolationLedger(':memory:', { now: clock }); ledger.syncGrants([{ ...grant(), maxRuns: 10, maxTotalDurationMs: 10_000 }])
    const success = ledger.prepare({ ...input('artifact-success'), artifactBinding: binding(['report.txt']) }).job
    const succeeded = ledger.settle(success.id, success.version, { jobId: success.id, status: 'succeeded', quiescent: true, exitCode: 0, stdout: '', stderr: '', artifacts: [] })
    const other = ledger.prepare({ ...input('artifact-other'), artifactBinding: binding(['other.txt']) }).job
    ledger.settle(other.id, other.version, { jobId: other.id, status: 'succeeded', quiescent: true, exitCode: 0, stdout: '', stderr: '', artifacts: [] })
    const failed = ledger.prepare({ ...input('artifact-failed'), artifactBinding: binding(['report.txt']) }).job
    const failedResult = ledger.settle(failed.id, failed.version, { jobId: failed.id, status: 'failed', quiescent: true, stdout: '', stderr: '', artifacts: [], reason: 'expected-failure' })
    expect(ledger.acceptedArtifactJob('contract-1', 'a'.repeat(64), 'report.txt')?.id).toBe(failedResult.id)
    expect(ledger.acceptedArtifactJob('contract-1', 'a'.repeat(64), 'other.txt')?.id).toBe(other.id)
    const latestUnknown = ledger.prepare({ ...input('artifact-unknown'), artifactBinding: binding(['report.txt']) }).job
    const unknownResult = ledger.settle(latestUnknown.id, latestUnknown.version, unknown(latestUnknown.id))
    expect(ledger.acceptedArtifactJob('contract-1', 'a'.repeat(64), 'report.txt')?.id).toBe(unknownResult.id)
    expect(succeeded.status).toBe('succeeded')
    ledger.close()
  })

})
