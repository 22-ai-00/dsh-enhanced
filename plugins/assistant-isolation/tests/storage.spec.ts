import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AssistantIsolationService } from '../src/service.ts'
import { IsolationLedger } from '../src/ledger.ts'
import { defaultStoragePolicy } from '../src/storage-policy.ts'
import { maintainIsolationStorage, observeStorage } from '../src/storage.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const identity = { principalDigest: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: '/project', agentPreset: 'default' }
const request = (key: string) => ({ identity, sessionId: 'session', grantId: 'grant', idempotencyKey: key, requestDigest: key, durationMs: 1000 })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'isolation-storage-')); roots.push(root)
  const ledger = new IsolationLedger(join(root, 'ledger.sqlite'))
  const authority = ledger.claimController('host', 30_000)
  ledger.syncGrants([{ ...identity, id: 'grant', revision: 1, expiresAt: Date.now() + 60_000, maxRuns: 10, maxTotalDurationMs: 10_000 }], authority)
  const job = ledger.prepare({ ...request('completed'), authority }).job
  ledger.settle(job.id, job.version, { jobId: job.id, status: 'succeeded', quiescent: true, stdout: '中文'.repeat(10_000), stderr: '', artifacts: [], exitCode: 0 }, authority)
  return { root, ledger, authority, job }
}

test('observes DB/WAL/staging and refuses symlinks without following them', async () => {
  const { root, ledger } = await fixture()
  try {
    await mkdir(join(root, 'workspaces'), { mode: 0o700 })
    await writeFile(join(root, 'workspaces', 'input'), Buffer.alloc(32_000))
    const observed = await observeStorage(root)
    const sizes = await Promise.all(['ledger.sqlite', 'ledger.sqlite-wal', 'ledger.sqlite-shm', 'workspaces/input'].map(async file => {
      const value = await stat(join(root, file)); return Math.max(value.size, value.blocks * 512)
    }))
    expect(observed?.bytes).toBeGreaterThanOrEqual(sizes.reduce((sum, size) => sum + size, 0))
    await symlink('/tmp', join(root, 'outside'))
    expect(await observeStorage(root)).toBeUndefined()
    await rm(join(root, 'outside'))
    expect(await observeStorage(root)).toBeDefined()
  } finally { ledger.close() }
})

test('default maintenance preserves bodies; opt-in retains unknown staging, identity and budgets', async () => {
  const { root, ledger, authority, job } = await fixture()
  try {
    const unknown = ledger.prepare({ ...request('unknown'), authority }).job
    ledger.settle(unknown.id, unknown.version, { jobId: unknown.id, status: 'unknown', quiescent: true, stdout: 'unknown evidence'.repeat(1000), stderr: '', artifacts: [] }, authority)
    for (const id of [job.id, unknown.id, 'orphan']) {
      await mkdir(join(root, 'workspaces', id), { recursive: true, mode: 0o700 })
      await writeFile(join(root, 'workspaces', id, 'input'), 'evidence')
    }
    const original = ledger.get(job.id)!
    const preserved = await maintainIsolationStorage(ledger, authority, root, defaultStoragePolicy)
    expect(preserved.pruned).toBe(0)
    expect(ledger.get(job.id)?.result).toEqual(original.result)
    await expect(stat(join(root, 'workspaces', job.id))).rejects.toMatchObject({ code: 'ENOENT' })
    const report = await maintainIsolationStorage(ledger, authority, root, { ...defaultStoragePolicy, resultRetentionMs: 1 })
    expect(report.pruned).toBe(1)
    expect(report.logicalBytesRemoved).toBeGreaterThan(50_000)
    const stored = ledger.get(job.id)!
    expect(stored).toMatchObject({ id: job.id, identity: original.identity, reservedDurationMs: original.reservedDurationMs,
      result: { status: 'succeeded', quiescent: true, stdout: '', artifacts: [], exitCode: 0, retention: { kind: 'pruned', version: 1 } } })
    expect(ledger.prepare({ ...request('completed'), authority, storageBudget: { maxStateBytes: 1, maxJobRecords: 1, reservedBytes: 1 } }).job.result).toEqual(stored.result)
    for (const id of [unknown.id, 'orphan']) expect(await readFile(join(root, 'workspaces', id, 'input'), 'utf8')).toBe('evidence')
    expect(ledger.get(unknown.id)?.result?.stdout).toContain('unknown evidence')
    expect((await maintainIsolationStorage(ledger, authority, root, { ...defaultStoragePolicy, resultRetentionMs: 1 })).pruned).toBe(0)
  } finally { ledger.close() }
})

test('operator CLI refuses a live Host and uses the same bounded opt-in maintenance after release', async () => {
  const { root, ledger, authority, job } = await fixture()
  const cli = fileURLToPath(new URL('../lib/cli.js', import.meta.url))
  const command = async (...args: string[]) => await promisify(execFile)(process.execPath, [cli, 'maintain', root, ...args], { timeout: 10_000 })
  try {
    await expect(command('1')).rejects.toThrow()
    expect(ledger.get(job.id)?.result?.retention).toBeUndefined()
    ledger.releaseController(authority)
    expect(JSON.parse((await command()).stdout).pruned).toBe(0)
    const result = JSON.parse((await command('1')).stdout)
    expect(result).toMatchObject({ pruned: 1, checkpoint: 'complete', reclaimMode: 'incremental' })
    expect(ledger.get(job.id)?.result?.retention?.kind).toBe('pruned')
    const database = new DatabaseSync(join(root, 'ledger.sqlite'))
    try {
      expect(database.prepare('SELECT COUNT(*) AS count, SUM(reserved_duration_ms) AS duration FROM isolation_jobs').get()).toMatchObject({ count: 1, duration: 1000 })
      expect(database.prepare("SELECT COUNT(*) AS count FROM isolation_audit WHERE action = 'job-result-pruned'").get()).toMatchObject({ count: 1 })
    } finally { database.close() }
  } finally { ledger.close() }
})

test('the live Host performs explicitly enabled maintenance through its real periodic sweep', async () => {
  const { root, ledger, authority, job } = await fixture()
  ledger.releaseController(authority); ledger.close()
  const ctx = new Context()
  try {
    await ctx.plugin(AssistantIsolationService, { stateRoot: root, storage: { resultRetentionMs: 1 } })
    const reader = new IsolationLedger(join(root, 'ledger.sqlite'))
    try {
      expect(reader.get(job.id)?.result?.retention).toBeUndefined()
      await expect.poll(() => reader.get(job.id)?.result?.retention?.kind, { timeout: 10_000, interval: 100 }).toBe('pruned')
      expect(reader.get(job.id)?.result).toMatchObject({ status: 'succeeded', quiescent: true, stdout: '' })
    } finally { reader.close() }
  } finally { await ctx.fiber.dispose() }
}, 15_000)
