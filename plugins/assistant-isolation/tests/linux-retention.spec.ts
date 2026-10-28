import { createHash } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { IsolationLedger } from '../src/ledger.ts'
import { linuxExecutionReceiptBinding, prepareLinuxExecutionIntent, retainLinuxExecutionResult, runLinuxExecution } from '../src/linux-execution.ts'
import type { LinuxExecutionContract } from '../src/linux-execution-contract.ts'
import { defaultStoragePolicy } from '../src/storage-policy.ts'
import { maintainIsolationStorage } from '../src/storage.ts'

const interruption = vi.hoisted(() => ({ path: '', remaining: 0 }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: async (from: string, to: string) => {
    if (to === interruption.path && interruption.remaining > 0
      && JSON.parse(await actual.readFile(from, 'utf8')).kind === 'result-pruned') {
      interruption.remaining--
      throw Object.assign(new Error('injected retention rename EIO'), { code: 'EIO' })
    }
    return actual.rename(from, to)
  } }
})

const uid = process.getuid?.() ?? 0
const real = process.env.DSH_NATIVE_CGROUP_REAL === '1' && process.platform === 'linux' && uid > 0
const roots: string[] = [], ledgers: IsolationLedger[] = []
afterEach(async () => {
  interruption.path = ''; interruption.remaining = 0
  vi.restoreAllMocks()
  for (const ledger of ledgers.splice(0)) ledger.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const identity = { principalDigest: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: '/project', agentPreset: 'default' }
async function fixture(status: 'succeeded' | 'unknown' = 'succeeded') {
  const root = await mkdtemp(join(tmpdir(), 'linux-retention-')); roots.push(root)
  const stateRoot = join(root, 'linux-executions'); await mkdir(stateRoot, { mode: 0o700 })
  let now = Date.now()
  const ledger = new IsolationLedger(join(root, 'ledger.sqlite'), { now: () => now }); ledgers.push(ledger)
  const authority = ledger.claimController('host', 60_000)
  ledger.syncGrants([{ ...identity, id: 'grant', revision: 1, expiresAt: now + 60_000, maxRuns: 10, maxTotalDurationMs: 50_000 }], authority)
  const contract: LinuxExecutionContract = { schemaVersion: 1, backend: 'linux-native', runtimeDigest: 'a'.repeat(64), profile: 'ordinary',
    limits: { maxDurationMs: 5000, maxInputBytes: 4096, maxOutputBytes: 8192, maxArtifactBytes: 8192, maxFiles: 8,
      memoryMiB: 128, workspaceMiB: 4, workspaceInodes: 256, pidsLimit: 32, cpus: 0.5 },
    keeperLimits: { memoryMiB: 128, pidsLimit: 48, cpus: 0.5 },
    cgroupRoots: { mode: 'v1', cpu: `/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-${uid}`,
      memory: `/sys/fs/cgroup/memory/dsh-native/uid-${uid}`, pids: `/sys/fs/cgroup/pids/dsh-native/uid-${uid}`,
      freezer: `/sys/fs/cgroup/freezer/dsh-native/uid-${uid}` } }
  const request = { identity, sessionId: 'session', grantId: 'grant', idempotencyKey: 'key', requestDigest: 'b'.repeat(64), durationMs: 5000,
    backend: 'linux-native' as const, linuxContract: contract, authority,
    resourceReservation: { memoryMiB: 260, workspaceInodes: 256, maxMemoryMiB: 520, maxWorkspaceInodes: 512 },
    storageBudget: { maxStateBytes: 100_000_000, maxJobRecords: 100, reservedBytes: 100_000, observation: { bytes: 0, observedAt: now } } }
  let job = ledger.prepare(request).job
  const intent = await prepareLinuxExecutionIntent({ stateRoot, contract, job: { ...job, nativeResourceId: job.nativeResourceId!, nativeNonce: job.nativeNonce! } })
  job = ledger.markLinuxCreateIntent(job.id, job.version, intent, authority)
  job = ledger.markDispatched(job.id, job.version, authority)
  const stdout = 'real stdout 中文 '.repeat(100), artifact = 'real artifact 中文 '.repeat(100)
  const outcome = await runLinuxExecution({ stateRoot, contract, intent,
    argv: ['/bin/sh', '-c', `printf '%s' '${stdout}'; printf '%s' '${artifact}' > report`], files: [], artifacts: ['report'],
    signal: new AbortController().signal,
    recordResources: async resources => { job = ledger.recordLinuxResources(job.id, job.version, resources, authority) },
    authorizeStart: () => { job = ledger.start(job.id, job.version, authority); return true } })
  expect(outcome.result).toMatchObject({ status: 'succeeded', quiescent: true, stdout, artifacts: [{ path: 'report', content: artifact }] })
  expect(outcome.receipt).toBeDefined()
  // An unknown ledger outcome must retain even proven-quiescent original evidence.
  job = ledger.settleLinuxReceipt(job.id, job.version, linuxExecutionReceiptBinding(outcome.receipt!), { ...outcome.result, status }, authority)
  now += 2
  const name = `${job.id}-${job.nativeNonce}.json`
  return { root, stateRoot, contract, intent, ledger, authority, request, job, outcome,
    journal: join(stateRoot, 'jobs', name), receipt: join(stateRoot, 'receipts', name) }
}
const policy = { ...defaultStoragePolicy, resultRetentionMs: 1 }
const read = async (path: string) => JSON.parse(await readFile(path, 'utf8'))

describe.skipIf(!real)('Linux private result retention with real execution', () => {
  test('default zero policy keeps both real stdout/artifact copies; opt-in retains identity and idempotency', async () => {
    const f = await fixture()
    const before = await Promise.all([readFile(f.journal, 'utf8'), readFile(f.receipt, 'utf8')])
    expect((await maintainIsolationStorage(f.ledger, f.authority, f.root, defaultStoragePolicy)).pruned).toBe(0)
    expect(await Promise.all([readFile(f.journal, 'utf8'), readFile(f.receipt, 'utf8')])).toEqual(before)
    expect((await maintainIsolationStorage(f.ledger, f.authority, f.root, { ...policy, resultRetentionMs: 60_000 })).pruned).toBe(0)
    expect(await Promise.all([readFile(f.journal, 'utf8'), readFile(f.receipt, 'utf8')])).toEqual(before)
    const report = await maintainIsolationStorage(f.ledger, f.authority, f.root, policy)
    expect(report.pruned).toBe(1); expect(report.retained).toBe(0)
    const kept = f.ledger.get(f.job.id)!
    expect(kept.result?.retention?.original.sha256).toMatch(/^[a-f0-9]{64}$/u)
    for (const path of [f.journal, f.receipt]) {
      const value = await read(path)
      expect(value).toMatchObject({ kind: 'result-pruned', result: kept.result })
      expect(value.result.stdout).toBe(''); expect(value.result.artifacts).toEqual([])
      expect(await readFile(path, 'utf8')).not.toContain('real artifact')
    }
    expect(kept).toMatchObject({ id: f.job.id, reservedDurationMs: f.job.reservedDurationMs,
      reservedMemoryMiB: f.job.reservedMemoryMiB, reservedStorageBytes: f.job.reservedStorageBytes })
    expect(f.ledger.prepare(f.request)).toEqual({ created: false, job: kept })
    expect((await maintainIsolationStorage(f.ledger, f.authority, f.root, policy)).pruned).toBe(0)
    expect(f.ledger.retentionCandidates(Date.now(), '', 16)).toEqual([])
    expect(f.ledger.retentionCandidates(0, '', 16, true)).toEqual([{ id: kept.id, version: kept.version }])
  })

  test('preserves every unknown result copy even when quiescent', async () => {
    const f = await fixture('unknown')
    const before = await Promise.all([readFile(f.journal, 'utf8'), readFile(f.receipt, 'utf8')])
    expect((await maintainIsolationStorage(f.ledger, f.authority, f.root, policy)).checked).toBe(0)
    expect(await Promise.all([readFile(f.journal, 'utf8'), readFile(f.receipt, 'utf8')])).toEqual(before)
    expect(f.ledger.get(f.job.id)?.result?.retention).toBeUndefined()
  })

  test.each(['binding', 'permissions', 'symlink', 'hardlink'] as const)('refuses %s tampering before ledger compaction or either evidence replacement', async kind => {
    const f = await fixture(), original = await readFile(f.receipt, 'utf8'), journal = await readFile(f.journal, 'utf8')
    if (kind === 'binding') { const value = JSON.parse(original); value.intent.requestDigest = 'f'.repeat(64); await writeFile(f.receipt, JSON.stringify(value), { mode: 0o600 }) }
    if (kind === 'permissions') await chmod(f.receipt, 0o644)
    if (kind === 'symlink' || kind === 'hardlink') {
      const other = join(f.root, 'outside'); await writeFile(other, original, { mode: 0o600 }); await rm(f.receipt)
      if (kind === 'symlink') await symlink(other, f.receipt)
      else await link(other, f.receipt)
    }
    const report = await maintainIsolationStorage(f.ledger, f.authority, f.root, policy)
    expect(report).toMatchObject({ pruned: 0, retained: 1 })
    expect(f.ledger.get(f.job.id)?.result?.retention).toBeUndefined()
    expect(await readFile(f.journal, 'utf8')).toBe(journal)
  })

  test('does not replace evidence with stale controller/version or mismatched result', async () => {
    const f = await fixture(), journal = await readFile(f.journal, 'utf8')
    const compact = vi.fn(() => undefined)
    await expect(retainLinuxExecutionResult({ ...f, resources: f.outcome.resources!, result: f.job.result!, fenced: () => false, compact })).rejects.toThrow('authority')
    expect(compact).not.toHaveBeenCalled()
    await expect(retainLinuxExecutionResult({ ...f, resources: f.outcome.resources!, result: { ...f.job.result!, stdout: 'wrong' }, fenced: () => true, compact })).rejects.toThrow('result differs')
    expect(compact).not.toHaveBeenCalled()
    f.ledger.releaseController(f.authority)
    await expect(maintainIsolationStorage(f.ledger, f.authority, f.root, policy)).rejects.toThrow('controller unavailable')
    expect(await readFile(f.journal, 'utf8')).toBe(journal)
  })

  test('retains evidence while the exact namespace is still present', async () => {
    const f = await fixture(), journal = await readFile(f.journal, 'utf8'), receipt = await readFile(f.receipt, 'utf8')
    await mkdir(f.intent.namespacePath, { mode: 0o700 })
    expect(await maintainIsolationStorage(f.ledger, f.authority, f.root, policy)).toMatchObject({ pruned: 0, retained: 1 })
    expect(f.ledger.get(f.job.id)?.result?.retention).toBeUndefined()
    expect(await readFile(f.journal, 'utf8')).toBe(journal)
    expect(await readFile(f.receipt, 'utf8')).toBe(receipt)
  })

  test.each(['version', 'controller'] as const)('fences %s changes after compaction and resumes only under the current row authority', async kind => {
    const f = await fixture(), before = await Promise.all([readFile(f.journal, 'utf8'), readFile(f.receipt, 'utf8')])
    let expectedVersion = f.job.version
    const fenced = () => f.ledger.hasController(f.authority) && f.ledger.get(f.job.id)?.version === expectedVersion
    await expect(retainLinuxExecutionResult({ ...f, resources: f.outcome.resources!, result: f.job.result!, fenced, compact: () => {
      f.ledger.compactResult(f.job.id, f.job.version, Date.now() + 1000, f.authority)
      if (kind === 'controller') {
        expectedVersion = f.ledger.get(f.job.id)!.version
        f.ledger.releaseController(f.authority)
      }
      return f.ledger.get(f.job.id)!.result
    } })).rejects.toThrow('evidence changed')
    expect(await Promise.all([readFile(f.journal, 'utf8'), readFile(f.receipt, 'utf8')])).toEqual(before)
    const current = kind === 'controller' ? f.ledger.claimController('current-host', 60_000) : f.authority
    expect(await maintainIsolationStorage(f.ledger, current, f.root, policy)).toMatchObject({ pruned: 0, retained: 0 })
    expect((await read(f.receipt)).kind).toBe('result-pruned')
  })

  test('retries after compaction when the first tombstone could not be renamed', async () => {
    const f = await fixture(), before = await Promise.all([readFile(f.journal, 'utf8'), readFile(f.receipt, 'utf8')])
    interruption.path = f.journal; interruption.remaining = 1
    expect(await maintainIsolationStorage(f.ledger, f.authority, f.root, policy)).toMatchObject({ pruned: 1, retained: 1 })
    expect(await Promise.all([readFile(f.journal, 'utf8'), readFile(f.receipt, 'utf8')])).toEqual(before)
    interruption.path = ''
    expect(await maintainIsolationStorage(f.ledger, f.authority, f.root, policy)).toMatchObject({ pruned: 0, retained: 0 })
    expect((await read(f.journal)).kind).toBe('result-pruned')
    expect((await read(f.receipt)).kind).toBe('result-pruned')
  })

  test('retries a mixed pair after the ledger marker and first tombstone have persisted', async () => {
    const f = await fixture(), originalReceipt = await readFile(f.receipt, 'utf8')
    interruption.path = f.receipt; interruption.remaining = 1
    expect(await maintainIsolationStorage(f.ledger, f.authority, f.root, policy)).toMatchObject({ pruned: 1, retained: 1 })
    expect((await read(f.journal)).kind).toBe('result-pruned')
    expect(await readFile(f.receipt, 'utf8')).toBe(originalReceipt)
    const kept = f.ledger.get(f.job.id)!
    expect(kept.result?.retention?.kind).toBe('pruned')
    interruption.path = ''
    expect(await maintainIsolationStorage(f.ledger, f.authority, f.root, policy)).toMatchObject({ pruned: 0, retained: 0 })
    expect((await read(f.receipt)).kind).toBe('result-pruned')
    expect(f.ledger.get(f.job.id)).toEqual(kept)
    expect(f.ledger.prepare(f.request)).toEqual({ created: false, job: kept })
  })

  test('rejects tampered tombstones on retry without discarding the other original copy', async () => {
    const f = await fixture(), originalReceipt = await readFile(f.receipt, 'utf8')
    interruption.path = f.receipt; interruption.remaining = 1
    await maintainIsolationStorage(f.ledger, f.authority, f.root, policy)
    interruption.path = ''
    const tombstone = await read(f.journal)
    tombstone.result.retention.original.sha256 = createHash('sha256').update('wrong').digest('hex')
    await writeFile(f.journal, JSON.stringify(tombstone), { mode: 0o600 })
    expect(await maintainIsolationStorage(f.ledger, f.authority, f.root, policy)).toMatchObject({ pruned: 0, retained: 1 })
    expect(await readFile(f.receipt, 'utf8')).toBe(originalReceipt)
  })
})
