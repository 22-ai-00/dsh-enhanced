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
const unknown = (jobId: string, quiescent = false): IsolationResult => ({ jobId, status: 'unknown', quiescent, stdout: '', stderr: '', artifacts: [] })
function path(): string { const root = mkdtempSync(join(tmpdir(), 'isolation-ledger-')); roots.push(root); chmodSync(root, 0o700); return join(root, 'ledger.sqlite') }
function error(fn: () => unknown): IsolationLedgerError { try { fn() } catch (caught) { expect(caught).toBeInstanceOf(IsolationLedgerError); return caught as IsolationLedgerError }; throw new Error('expected ledger error') }

describe('IsolationLedger', () => {
  it('creates a private WAL/FULL durable schema', () => {
    const file = path(); const ledger = new IsolationLedger(file, { now: clock }); ledger.close()
    const database = new DatabaseSync(file)
    expect((database.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
    expect((statSync(file).mode & 0o777)).toBe(0o600)
    expect((statSync(join(file, '..')).mode & 0o777)).toBe(0o700)
    expect((database.prepare("SELECT value FROM schema_meta WHERE key='schema-version'").get() as { value: string }).value).toBe('1')
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
    const cleaned = ledger.settle(stranded.id, stranded.version, unknown(stranded.id, true), old)
    expect(cleaned.result?.quiescent).toBe(true)
    expect(ledger.get(stranded.id)?.result).toMatchObject({ status: 'unknown', quiescent: true })
    expect(ledger.recoverable()).toHaveLength(0)
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

})
