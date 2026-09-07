import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { IsolationLedger, IsolationLedgerError } from '../src/ledger.ts'
import type { IsolationGrant, IsolationIdentity, IsolationResult, IsolationStorageBudget } from '../src/types.ts'

const roots: string[] = []
let now = 10_000
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); now = 10_000 })
const clock = () => now
const identity: IsolationIdentity = { principalDigest: 'principal', principalRecordId: 'record', principalVersion: 1, workspace: '/work', agentPreset: 'default' }
const grant: IsolationGrant = { ...identity, id: 'grant', revision: 1, expiresAt: 100_000, maxRuns: 20, maxTotalDurationMs: 20_000 }
const input = (key: string) => ({ identity, sessionId: 'session', grantId: 'grant', idempotencyKey: key, requestDigest: `digest-${key}`, durationMs: 500 })
const budget = (reservedBytes = 128, maxJobRecords = 20, maxStateBytes = 1_000_000): IsolationStorageBudget => ({ maxStateBytes, maxJobRecords, reservedBytes, observation: { bytes: 0, observedAt: now } })
const completed = (jobId: string, body = 'retained-body'.repeat(256)): IsolationResult => ({ jobId, status: 'succeeded', quiescent: true, stdout: body, stderr: body, artifacts: [{ path: 'out.txt', content: body }] })
function path(): string { const root = mkdtempSync(join(tmpdir(), 'isolation-storage-')); roots.push(root); chmodSync(root, 0o700); return join(root, 'ledger.sqlite') }
function error(operation: () => unknown): IsolationLedgerError { try { operation() } catch (caught) { expect(caught).toBeInstanceOf(IsolationLedgerError); return caught as IsolationLedgerError }; throw new Error('expected ledger error') }

describe('ledger storage reservation and retention', () => {
  it('does not double-charge an idempotency replay and rejects a distinct reservation over budget', () => {
    const file = path(); const first = new IsolationLedger(file, { now: clock }); const second = new IsolationLedger(file, { now: clock })
    first.syncGrants([grant])
    const prepared = first.prepare({ ...input('first'), storageBudget: budget(600, 10, 1_000) })
    expect(prepared.job.reservedStorageBytes).toBe(600)
    expect(second.prepare({ ...input('first'), storageBudget: budget(600, 10, 1_000) })).toMatchObject({ created: false, job: { id: prepared.job.id } })
    expect(error(() => second.prepare({ ...input('other'), storageBudget: budget(500, 10, 1_000) })).code).toBe('unauthorized')
    expect(first.storageStats()).toMatchObject({ jobRecords: 1, activeReservedBytes: 600, legacyActiveJobs: 0 })
    first.close(); second.close()
  })

  it('fails closed for active legacy work and never lets a stale observation allocate', () => {
    const ledger = new IsolationLedger(':memory:', { now: clock }); ledger.syncGrants([grant])
    const legacy = ledger.prepare(input('legacy')).job
    expect(error(() => ledger.prepare({ ...input('blocked'), storageBudget: budget() })).code).toBe('unauthorized')
    ledger.settle(legacy.id, legacy.version, { jobId: legacy.id, status: 'unknown', quiescent: true, stdout: '', stderr: '', artifacts: [] })
    const stale = budget()
    now += 5_001
    expect(error(() => ledger.prepare({ ...input('stale'), storageBudget: stale })).code).toBe('invalid-input')
    ledger.close()
  })

  it('keeps a hash-bearing pruned result across reopen and fences stale compaction', () => {
    const file = path(); const ledger = new IsolationLedger(file, { now: clock }); const authority = ledger.claimController('host', 1_000)
    ledger.syncGrants([grant], authority)
    const job = ledger.prepare({ ...input('retention'), authority, storageBudget: budget() }).job
    const settled = ledger.settle(job.id, job.version, completed(job.id), authority)
    expect(ledger.retentionCandidates(now)).toEqual([{ id: settled.id, version: settled.version }])
    expect(error(() => ledger.compactResult(settled.id, settled.version + 1, now, authority)).code).toBe('conflict')
    const compacted = ledger.compactResult(settled.id, settled.version, now, authority)
    expect(compacted).toMatchObject({ changed: true })
    expect(compacted.removedBytes).toBeGreaterThan(0)
    const retained = ledger.get(job.id)!
    expect(retained.result).toMatchObject({ stdout: '', stderr: '', artifacts: [], retention: { kind: 'pruned', version: 1, original: { bytes: expect.any(Number), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) } } })
    expect(ledger.retentionCandidates(now)).toEqual([])
    ledger.close()
    const reopened = new IsolationLedger(file, { now: clock })
    expect(reopened.get(job.id)?.result?.retention).toEqual(retained.result?.retention)
    expect(statSync(file).size).toBeGreaterThan(0)
    reopened.close()
  })

  it('does not append controller-renewal audits and reports incremental maintenance', () => {
    const file = path(); const ledger = new IsolationLedger(file, { now: clock }); const authority = ledger.claimController('host', 1_000)
    expect(ledger.renewController(authority, 1_000)).toBe(true)
    expect(ledger.renewController(authority, 1_000)).toBe(true)
    const database = new DatabaseSync(file)
    expect((database.prepare("SELECT COUNT(*) AS count FROM isolation_audit WHERE action='controller-renewed'").get() as { count: number }).count).toBe(0)
    database.close()
    expect(ledger.maintainStorage(authority)).toEqual({ checkpoint: 'complete', reclaimMode: 'incremental' })
    ledger.close()
  })

  it('does not truncate WAL while a reader pins its snapshot, then completes after release', () => {
    const file = path(); const ledger = new IsolationLedger(file, { now: clock }); const authority = ledger.claimController('host', 1_000)
    ledger.syncGrants([grant], authority)
    const reader = new DatabaseSync(file)
    reader.exec('BEGIN')
    expect((reader.prepare('SELECT COUNT(*) AS count FROM isolation_grants').get() as { count: number }).count).toBe(1)
    ledger.prepare({ ...input('wal-write'), authority, storageBudget: budget() })
    expect(ledger.maintainStorage(authority)).toEqual({ checkpoint: 'busy', reclaimMode: 'incremental' })
    expect((reader.prepare('SELECT COUNT(*) AS count FROM isolation_grants').get() as { count: number }).count).toBe(1)
    reader.exec('COMMIT'); reader.close()
    expect(ledger.maintainStorage(authority)).toEqual({ checkpoint: 'complete', reclaimMode: 'incremental' })
    ledger.close()
  })

  it('rejects forged retention in ordinary settlement and fences expired or wrong compact controllers', () => {
    const ledger = new IsolationLedger(':memory:', { now: clock }); const authority = ledger.claimController('host', 1)
    ledger.syncGrants([grant], authority)
    const job = ledger.prepare({ ...input('controller'), authority, storageBudget: budget() }).job
    const forged: IsolationResult = { jobId: job.id, status: 'succeeded', quiescent: true, stdout: '', stderr: '', artifacts: [], retention: {
      kind: 'pruned', version: 1, prunedAt: now, original: { sha256: 'a'.repeat(64), bytes: 0 }, stdout: { sha256: 'b'.repeat(64), bytes: 0 }, stderr: { sha256: 'c'.repeat(64), bytes: 0 }, artifacts: [],
    } }
    expect(error(() => ledger.settle(job.id, job.version, forged, authority)).code).toBe('invalid-input')
    const settled = ledger.settle(job.id, job.version, completed(job.id), authority)
    expect(error(() => ledger.compactResult(job.id, settled.version, now, { ownerId: 'host', fence: authority.fence + 1 })).code).toBe('unauthorized')
    now += 2
    expect(error(() => ledger.compactResult(job.id, settled.version, now, authority)).code).toBe('unauthorized')
    ledger.close()
  })

  it('rejects record and high-water growth but permits an existing key without a fresh observation', () => {
    const records = new IsolationLedger(':memory:', { now: clock }); records.syncGrants([grant])
    const first = records.prepare({ ...input('records'), storageBudget: budget(128, 1) })
    expect(records.prepare(input('records'))).toMatchObject({ created: false, job: { id: first.job.id } })
    expect(error(() => records.prepare({ ...input('records-next'), storageBudget: budget(128, 1) })).code).toBe('unauthorized')
    records.close()

    const highWater = new IsolationLedger(':memory:', { now: clock }); highWater.syncGrants([grant])
    const retained = highWater.prepare({ ...input('high-water'), storageBudget: budget(128, 10, 1_000) })
    expect(highWater.prepare(input('high-water'))).toMatchObject({ created: false, job: { id: retained.job.id } })
    expect(error(() => highWater.prepare({ ...input('high-water-next'), storageBudget: { ...budget(128, 10, 1_000), observation: { bytes: 1_000, observedAt: now } } })).code).toBe('unauthorized')
    highWater.close()
  })

  it('does not refund the grant budget after a known result is pruned, and never prunes unknown results', () => {
    const ledger = new IsolationLedger(':memory:', { now: clock }); const authority = ledger.claimController('host', 1_000)
    ledger.syncGrants([{ ...grant, maxRuns: 1 }], authority)
    const known = ledger.prepare({ ...input('known'), authority, storageBudget: budget() }).job
    const settled = ledger.settle(known.id, known.version, completed(known.id), authority)
    expect(ledger.compactResult(known.id, settled.version, now, authority)).toMatchObject({ changed: true })
    expect(error(() => ledger.prepare({ ...input('budget-not-refunded'), authority, storageBudget: budget() })).code).toBe('unauthorized')

    ledger.close()

    const unknownLedger = new IsolationLedger(':memory:', { now: clock }); const unknownAuthority = unknownLedger.claimController('unknown-host', 1_000)
    unknownLedger.syncGrants([grant], unknownAuthority)
    const unknown = unknownLedger.prepare({ ...input('unknown'), authority: unknownAuthority, storageBudget: budget() }).job
    const terminalUnknown = unknownLedger.settle(unknown.id, unknown.version, { jobId: unknown.id, status: 'unknown', quiescent: true, stdout: 'body', stderr: '', artifacts: [] }, unknownAuthority)
    expect(unknownLedger.retentionCandidates(now)).toEqual([])
    expect(unknownLedger.compactResult(unknown.id, terminalUnknown.version, now, unknownAuthority)).toEqual({ changed: false, removedBytes: 0 })
    expect(unknownLedger.get(unknown.id)?.result).toMatchObject({ status: 'unknown', stdout: 'body' })
    unknownLedger.close()
  })

  it('never offsets a near-full observed state by SQLite freelist pages, and requires an observation for new keys', () => {
    const file = path(); const ledger = new IsolationLedger(file, { now: clock }); const authority = ledger.claimController('host', 1_000)
    ledger.syncGrants([grant], authority)
    const source = ledger.prepare({ ...input('large-result'), authority, storageBudget: budget(128, 10, 2_000_000) }).job
    const settled = ledger.settle(source.id, source.version, completed(source.id, 'x'.repeat(512 * 1024)), authority)
    expect(ledger.compactResult(source.id, settled.version, now, authority)).toMatchObject({ changed: true })
    expect(ledger.storageStats().reusableBytes).toBeGreaterThan(128 * 1024)

    expect(error(() => ledger.prepare({ ...input('missing-observation'), authority, storageBudget: { maxStateBytes: 1_000_000, maxJobRecords: 10, reservedBytes: 128 } })).code).toBe('unauthorized')
    expect(error(() => ledger.prepare({ ...input('freelist-must-not-offset'), authority, storageBudget: { maxStateBytes: 1_000_000, maxJobRecords: 10, reservedBytes: 100_000, observation: { bytes: 950_000, observedAt: now } } })).code).toBe('unauthorized')
    ledger.close()
  })
})
