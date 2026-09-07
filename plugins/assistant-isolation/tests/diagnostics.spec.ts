import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectIsolationGrant } from '../src/diagnostics.ts'
import { IsolationLedger } from '../src/ledger.ts'
import type { IsolationGrant, IsolationIdentity } from '../src/types.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const now = () => 10_000
const identity: IsolationIdentity = { principalDigest: 'a'.repeat(64), principalRecordId: 'record-1', principalVersion: 1, workspace: '/work', agentPreset: 'primary' }
const grant = (changes: Partial<IsolationGrant> = {}): IsolationGrant => ({ ...identity, id: 'grant-1', revision: 1, expiresAt: 100_000, maxRuns: 2, maxTotalDurationMs: 1_000, ...changes })
function root(): string { const value = mkdtempSync(join(tmpdir(), 'isolation-diagnostics-')); roots.push(value); return value }
function prepare(ledger: IsolationLedger, key = 'key') {
  return ledger.prepare({ identity, sessionId: 'session-1', grantId: 'grant-1', idempotencyKey: key, requestDigest: `digest-${key}`, durationMs: 500 }).job
}

describe('read-only isolation grant diagnostics', () => {
  it('reports durable cumulative usage and unresolved unknown jobs without consuming more authority', () => {
    const stateRoot = root(); const ledger = new IsolationLedger(join(stateRoot, 'ledger.sqlite'), { now }); const configured = grant()
    ledger.syncGrants([configured]); const job = prepare(ledger); ledger.settle(job.id, job.version, { jobId: job.id, status: 'unknown', quiescent: false, stdout: '', stderr: '', artifacts: [] })
    const before = readFileSync(join(stateRoot, 'ledger.sqlite'))
    const durable = new DatabaseSync(join(stateRoot, 'ledger.sqlite'), { readOnly: true })
    const beforeRows = durable.prepare('SELECT (SELECT COUNT(*) FROM isolation_grants) AS grants, (SELECT COUNT(*) FROM isolation_jobs) AS jobs, (SELECT COUNT(*) FROM isolation_audit) AS audit, (SELECT COUNT(*) FROM isolation_controller) AS controller').get()
    durable.close()
    const wal = join(stateRoot, 'ledger.sqlite-wal'); const beforeWal = existsSync(wal) ? readFileSync(wal) : undefined
    const diagnostic = inspectIsolationGrant({ stateRoot, grant: configured, now: 10_000 })
    const after = readFileSync(join(stateRoot, 'ledger.sqlite'))
    const afterDatabase = new DatabaseSync(join(stateRoot, 'ledger.sqlite'), { readOnly: true })
    const afterRows = afterDatabase.prepare('SELECT (SELECT COUNT(*) FROM isolation_grants) AS grants, (SELECT COUNT(*) FROM isolation_jobs) AS jobs, (SELECT COUNT(*) FROM isolation_audit) AS audit, (SELECT COUNT(*) FROM isolation_controller) AS controller').get()
    afterDatabase.close()
    const afterWal = existsSync(wal) ? readFileSync(wal) : undefined
    expect(diagnostic).toEqual(expect.objectContaining({ status: 'available', runsUsed: 1, durationReservedMs: 500, remainingRuns: 1, remainingDurationMs: 500, activeJobs: 1, unknownJobs: 1 }))
    expect(after).toEqual(before)
    expect(afterRows).toEqual(beforeRows)
    expect(afterWal).toEqual(beforeWal)
    ledger.close()
  })

  it('classifies revocation, expiry, and exhausted historical budgets without refunding unknown work', () => {
    const stateRoot = root(); const configured = grant({ maxRuns: 1, maxTotalDurationMs: 500 }); const ledger = new IsolationLedger(join(stateRoot, 'ledger.sqlite'), { now })
    ledger.syncGrants([configured]); const job = prepare(ledger); ledger.settle(job.id, job.version, { jobId: job.id, status: 'unknown', quiescent: false, stdout: '', stderr: '', artifacts: [] }); ledger.revoke(configured.id, configured.revision, 'operator')
    const revoked = inspectIsolationGrant({ stateRoot, grant: configured, now: 10_000 })
    expect(revoked).toMatchObject({ status: 'ineligible', runsUsed: 1, durationReservedMs: 500, remainingRuns: 0, remainingDurationMs: 0 })
    expect(revoked.reasons).toEqual(expect.arrayContaining(['grant-revoked', 'max-runs-exhausted', 'duration-budget-exhausted']))
    expect(inspectIsolationGrant({ stateRoot, grant: configured, now: configured.expiresAt }).reasons).toContain('grant-expired')
    ledger.close()
  })

  it('fails closed for a missing database, unsupported schema, and configured grant drift without creating state', () => {
    const missing = join(root(), 'absent-state')
    expect(inspectIsolationGrant({ stateRoot: missing, grant: grant(), now: 10_000 })).toMatchObject({ status: 'unavailable', reasons: ['database-missing'] })
    expect(existsSync(missing)).toBe(false)
    const stateRoot = root(); const file = join(stateRoot, 'ledger.sqlite'); const database = new DatabaseSync(file)
    database.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; PRAGMA user_version=5;'); database.close()
    expect(inspectIsolationGrant({ stateRoot, grant: grant(), now: 10_000 })).toMatchObject({ status: 'unavailable', reasons: ['schema-unsupported'] })
    const configuredRoot = root(); const ledger = new IsolationLedger(join(configuredRoot, 'ledger.sqlite'), { now }); const configured = grant(); ledger.syncGrants([configured])
    expect(inspectIsolationGrant({ stateRoot: configuredRoot, grant: { ...configured, revision: 2 }, now: 10_000 })).toMatchObject({ status: 'ineligible', reasons: ['grant-config-mismatch'] })
    ledger.close()
  })

  it('counts all historical grant revisions, rejects invalid inputs, corrupt files, and symlinked databases', () => {
    const stateRoot = root(); const ledger = new IsolationLedger(join(stateRoot, 'ledger.sqlite'), { now }); const first = grant({ revision: 1, maxRuns: 3, maxTotalDurationMs: 2_000 })
    ledger.syncGrants([first]); const job = prepare(ledger); ledger.settle(job.id, job.version, { jobId: job.id, status: 'succeeded', quiescent: true, exitCode: 0, stdout: '', stderr: '', artifacts: [] })
    const current = { ...first, revision: 2, maxRuns: 4, maxTotalDurationMs: 3_000 }
    ledger.syncGrants([current])
    expect(inspectIsolationGrant({ stateRoot, grant: current, now: 10_000 })).toMatchObject({ runsUsed: 1, durationReservedMs: 500, remainingRuns: 3, remainingDurationMs: 2_500, unknownJobs: 0 })
    expect(() => inspectIsolationGrant({ stateRoot: 'relative', grant: current, now: 10_000 })).toThrow(/invalid/i)
    expect(() => inspectIsolationGrant({ stateRoot, grant: { ...current, principalDigest: 'bad' }, now: 10_000 })).toThrow(/invalid/i)
    ledger.close()

    const corruptRoot = root(); writeFileSync(join(corruptRoot, 'ledger.sqlite'), 'not a sqlite database')
    expect(inspectIsolationGrant({ stateRoot: corruptRoot, grant: current, now: 10_000 })).toMatchObject({ status: 'unavailable', reasons: ['database-corrupt'] })
    const linkRoot = root(); symlinkSync(join(stateRoot, 'ledger.sqlite'), join(linkRoot, 'ledger.sqlite'))
    expect(inspectIsolationGrant({ stateRoot: linkRoot, grant: current, now: 10_000 })).toMatchObject({ status: 'unavailable', reasons: ['database-unavailable'] })
  })

  it('rejects state-root symlinks, symlinked parents, non-directories, and broad permissions without repairing them', () => {
    const configured = grant(); const actualParent = root(); const actualState = join(actualParent, 'state')
    const ledger = new IsolationLedger(join(actualState, 'ledger.sqlite'), { now }); ledger.syncGrants([configured]); ledger.close()
    const directLink = root(); rmSync(directLink, { recursive: true, force: true }); symlinkSync(actualState, directLink)
    expect(inspectIsolationGrant({ stateRoot: directLink, grant: configured, now: 10_000 })).toMatchObject({ status: 'unavailable', reasons: ['database-unavailable'] })
    const parentLink = root(); rmSync(parentLink, { recursive: true, force: true }); symlinkSync(actualParent, parentLink)
    expect(inspectIsolationGrant({ stateRoot: join(parentLink, 'state'), grant: configured, now: 10_000 })).toMatchObject({ status: 'unavailable', reasons: ['database-unavailable'] })
    const notDirectory = join(root(), 'not-a-directory'); writeFileSync(notDirectory, '')
    expect(inspectIsolationGrant({ stateRoot: notDirectory, grant: configured, now: 10_000 })).toMatchObject({ status: 'unavailable', reasons: ['database-unavailable'] })
    chmodSync(actualState, 0o755)
    expect(inspectIsolationGrant({ stateRoot: actualState, grant: configured, now: 10_000 })).toMatchObject({ status: 'unavailable', reasons: ['database-unavailable'] })
    expect((statSync(actualState).mode & 0o777)).toBe(0o755)
  })
})
