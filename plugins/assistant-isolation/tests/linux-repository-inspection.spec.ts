// Real SQLite ownership/budget/lifecycle tests with a controlled receipt reader.
// These do not claim kernel execution or real artifact-spool verification.
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { IsolationLedger } from '../src/ledger.js'
import { linuxExecutionContractDigest, linuxExecutionIntentDigest, linuxJobResourceReservation,
  type LinuxExecutionResources, type LinuxRepositoryExecutionContract, type LinuxRepositoryExecutionIntent } from '../src/linux-execution-contract.js'
import { linuxExecutionReceiptBinding, readLinuxRepositoryReceipt, type LinuxRepositoryExecutionReceipt } from '../src/linux-execution.js'
import { reconcileLinuxJob } from '../src/linux-job-recovery.js'
import { LinuxRepositoryRunner, type LinuxRepositoryRunnerConfig } from '../src/linux-repository-runner.js'
import { linuxRuntimeFixture } from './helpers/linux-runtime-fixture.js'

vi.mock('../src/linux-execution.js', async original => ({ ...await original<typeof import('../src/linux-execution.js')>(), readLinuxRepositoryReceipt: vi.fn() }))
vi.mock('../src/linux-job-recovery.js', () => ({ reconcileLinuxJob: vi.fn(async () => { throw new Error('inspection must not recover') }) }))
const roots: string[] = [], runners: LinuxRepositoryRunner[] = []
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks(); vi.clearAllMocks()
})
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
    : JSON.stringify(value)
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'linux-repository-inspection-')); roots.push(root)
  const { runtime, cgroupRoots } = await linuxRuntimeFixture(root)
  const input: LinuxRepositoryRunnerConfig = { backend: 'linux-native', runtime, cgroupRoots, stateRoot: join(root, 'state'),
    authorityDigest: 'a'.repeat(64), expiresAt: Date.now() + 60000, maxRuns: 1, maxTotalDurationMs: 5000,
    limits: { maxDurationMs: 5000, maxInputBytes: 64 * 1024 ** 2, maxOutputBytes: 4096, maxArtifactBytes: 4096, maxFiles: 8,
      memoryMiB: 128, workspaceMiB: 4, workspaceInodes: 256, tmpMiB: 4, tmpInodes: 128,
      inputMiB: 65, inputInodes: 16, pidsLimit: 32, cpus: 0.5 } }
  const runner = new LinuxRepositoryRunner(input); runners.push(runner)
  await runner.inspectSuccessfulExecution('ready')
  const contract: LinuxRepositoryExecutionContract = { schemaVersion: 2, backend: 'linux-native', profile: 'repository',
    runtimeDigest: runner.runtimeDigest, limits: input.limits, cgroupRoots, keeperLimits: { memoryMiB: 256, pidsLimit: 64, cpus: 0.5 } }
  const snapshot = () => {
    const db = new DatabaseSync(join(input.stateRoot, 'ledger.sqlite'), { readOnly: true })
    try { return { jobs: db.prepare('SELECT * FROM isolation_jobs').all(), grants: db.prepare('SELECT * FROM isolation_grants').all(),
      audit: db.prepare('SELECT * FROM isolation_audit').all() } } finally { db.close() }
  }
  const seed = (status: 'succeeded' | 'unknown' | 'running' | 'prepared' | 'failed' = 'succeeded') => {
    const db = new DatabaseSync(join(input.stateRoot, 'ledger.sqlite'))
    const row = db.prepare('SELECT owner_id,fence FROM isolation_controller').get()!; db.close()
    const authority = { ownerId: String(row.owner_id), fence: Number(row.fence) }, ledger = new IsolationLedger(join(input.stateRoot, 'ledger.sqlite'))
    try {
      const reservation = linuxJobResourceReservation(contract)
      let job = ledger.prepare({ identity: { principalDigest: input.authorityDigest, principalRecordId: `repository:${input.authorityDigest}`,
        principalVersion: 1, workspace: input.stateRoot, agentPreset: 'repository' }, sessionId: `authority:${input.authorityDigest}`,
        grantId: 'repository', idempotencyKey: 'source', requestDigest: 'b'.repeat(64), durationMs: 5000, authority,
        backend: 'linux-native', linuxContract: contract, resourceReservation: { memoryMiB: reservation.memoryMiB,
          workspaceInodes: reservation.workspaceInodes, maxMemoryMiB: 32768, maxWorkspaceInodes: 3000000 },
        storageBudget: { reservedBytes: reservation.storageBytes, maxStateBytes: 1024 ** 3, maxJobRecords: 10000,
          observation: { bytes: 0, observedAt: Date.now() } } }).job
      if (status === 'prepared') return { job }
      const intent: LinuxRepositoryExecutionIntent = { schemaVersion: 2, jobId: job.id, requestDigest: job.requestDigest,
        nativeResourceId: job.nativeResourceId!, nativeNonce: job.nativeNonce!, contractDigest: linuxExecutionContractDigest(contract),
        bootId: '00000000-0000-0000-0000-000000000001', uid: process.getuid!(), deadline: job.deadline,
        namespacePath: join(input.stateRoot, 'linux-executions/namespaces', `namespace-${job.id}-${job.nativeNonce}`),
        workerNonce: 'd'.repeat(32), keeperNonce: 'e'.repeat(32),
        roots: Object.fromEntries(Object.entries(cgroupRoots).filter(([key]) => key !== 'mode').map(([key, path], index) => [key, { path, dev: index + 1, ino: index + 10 }])),
        repository: { archive: { bytes: 1, sha256: sha('x') }, artifacts: ['package.tgz'], executionDigest: 'c'.repeat(64) } }
      const group = (keeper: boolean) => {
        const nonce = keeper ? intent.keeperNonce : intent.workerNonce
        return { schemaVersion: 1 as const, mode: 'v1' as const, bootId: intent.bootId, jobId: job.id, nonce, uid: intent.uid, deadline: intent.deadline,
          limits: keeper ? contract.keeperLimits : { memoryMiB: input.limits.memoryMiB, pidsLimit: input.limits.pidsLimit, cpus: input.limits.cpus },
          directories: Object.fromEntries(Object.entries(intent.roots).map(([key, value]) => [key, { ...value,
            path: `${value.path}/job-${job.id}-${nonce}`, ino: value.ino + (keeper ? 200 : 100) }])) }
      }
      const resources: LinuxExecutionResources = { schemaVersion: 1, intentDigest: linuxExecutionIntentDigest(intent), worker: group(false), keeper: group(true) }
      job = ledger.markLinuxCreateIntent(job.id, job.version, intent, authority)
      job = ledger.markDispatched(job.id, job.version, authority)
      job = ledger.recordLinuxResources(job.id, job.version, resources, authority)
      if (status === 'running') return { job: ledger.start(job.id, job.version, authority) }
      const bytes = Buffer.from([0, 255, 128, 1]), artifacts = [{ path: 'package.tgz', bytes, sha256: sha(bytes) }]
      const body = { schemaVersion: 2 as const, intent, resources, completedAt: Date.now(),
        result: { jobId: job.id, status, quiescent: true, stdout: 'original', stderr: '', artifacts: [] },
        repositoryArtifacts: status === 'succeeded' ? [{ path: 'package.tgz', bytes: bytes.length, sha256: sha(bytes) }] : [] }
      const receipt: LinuxRepositoryExecutionReceipt = { ...body, receiptDigest: sha(canonical(body)) }
      job = ledger.settleLinuxReceipt(job.id, job.version, linuxExecutionReceiptBinding(receipt), receipt.result, authority)
      vi.mocked(readLinuxRepositoryReceipt).mockResolvedValue({ receipt, artifacts })
      return { job, receipt, artifacts }
    } finally { ledger.close() }
  }
  const change = (sql: string, ...params: Array<string | number>) => {
    const db = new DatabaseSync(join(input.stateRoot, 'ledger.sqlite'))
    try { db.prepare(sql).run(...params) } finally { db.close() }
  }
  return { input, runner, contract, snapshot, seed, change }
}

describe.runIf(process.platform === 'linux' && !!process.getuid?.())('read-only successful Linux execution inspection', () => {
  test('missing keys never admit jobs or call run, recovery or a receipt reader', async () => {
    const f = await fixture(), before = f.snapshot(), run = vi.spyOn(f.runner, 'run')
    expect(await f.runner.inspectSuccessfulExecution('missing')).toBeUndefined()
    expect(f.snapshot()).toEqual(before)
    expect(run).not.toHaveBeenCalled(); expect(reconcileLinuxJob).not.toHaveBeenCalled(); expect(readLinuxRepositoryReceipt).not.toHaveBeenCalled()
    await expect(f.runner.inspectSuccessfulExecution('')).rejects.toThrow('invalid')
  })

  test('returns the original receipt and binary bytes without changing spent budget or ledger', async () => {
    const f = await fixture(), { job, receipt, artifacts } = f.seed(), before = f.snapshot()
    for (let index = 0; index < 2; index++) {
      expect(await f.runner.inspectSuccessfulExecution('source')).toEqual({ result: job.result, artifacts,
        receiptBinding: linuxExecutionReceiptBinding(receipt!), contractDigest: f.runner.contractDigest, runtimeDigest: f.runner.runtimeDigest })
    }
    expect(readLinuxRepositoryReceipt).toHaveBeenCalledTimes(2)
    expect(f.snapshot()).toEqual(before); expect(reconcileLinuxJob).not.toHaveBeenCalled()
    expect(before.jobs).toHaveLength(1); expect(before.jobs[0]?.reserved_duration_ms).toBe(5000)
  })

  test.each(['prepared', 'running', 'unknown', 'failed'] as const)('%s jobs remain unavailable without recovery or replay', async status => {
    const f = await fixture(); f.seed(status); vi.mocked(readLinuxRepositoryReceipt).mockClear()
    const before = f.snapshot()
    expect(await f.runner.inspectSuccessfulExecution('source')).toBeUndefined()
    expect(f.snapshot()).toEqual(before); expect(readLinuxRepositoryReceipt).not.toHaveBeenCalled(); expect(reconcileLinuxJob).not.toHaveBeenCalled()
  })

  test('reopening the same owner with a changed valid contract cannot inspect the original job', async () => {
    const f = await fixture(); f.seed(); await f.runner.close()
    const changed = new LinuxRepositoryRunner({ ...f.input, limits: { ...f.input.limits, cpus: 0.6 } }); runners.push(changed)
    const before = f.snapshot()
    expect(await changed.inspectSuccessfulExecution('source')).toBeUndefined()
    expect(f.snapshot().jobs).toEqual(before.jobs)
    expect(readLinuxRepositoryReceipt).not.toHaveBeenCalled()
  })

  test.each(['contract', 'owner', 'session', 'receipt-result', 'receipt-resources', 'missing-receipt', 'pack-drift', 'during-read'] as const)('rejects %s evidence drift', async mode => {
    const f = await fixture(), { receipt, artifacts } = f.seed()
    if (mode === 'contract') {
      // A replaced runtime contract cannot reuse this runner's exact authority.
      const changed = { ...f.contract, runtimeDigest: 'f'.repeat(64) }
      f.change('UPDATE isolation_jobs SET linux_contract_json=?', JSON.stringify(changed))
    }
    if (mode === 'owner') f.change('UPDATE isolation_jobs SET principal_digest=?', 'foreign')
    if (mode === 'session') f.change('UPDATE isolation_jobs SET session_id=?', 'foreign')
    if (mode === 'receipt-result') vi.mocked(readLinuxRepositoryReceipt).mockResolvedValue({ receipt: { ...receipt!, result: { ...receipt!.result, stdout: 'forged' } }, artifacts: artifacts! })
    if (mode === 'receipt-resources') vi.mocked(readLinuxRepositoryReceipt).mockResolvedValue({ receipt: { ...receipt!, resources: { ...receipt!.resources, intentDigest: 'f'.repeat(64) } }, artifacts: artifacts! })
    if (mode === 'missing-receipt') vi.mocked(readLinuxRepositoryReceipt).mockResolvedValue(undefined)
    if (mode === 'pack-drift') vi.mocked(readLinuxRepositoryReceipt).mockRejectedValue(new Error('repository spool digest differs'))
    if (mode === 'during-read') vi.mocked(readLinuxRepositoryReceipt).mockImplementation(async () => {
      f.change('UPDATE isolation_jobs SET version=version+1'); return { receipt: receipt!, artifacts: artifacts! }
    })
    expect(await f.runner.inspectSuccessfulExecution('source')).toBeUndefined()
    expect(reconcileLinuxJob).not.toHaveBeenCalled()
  })

  test.each(['cancelled', 'closed', 'expired', 'revoked', 'fenced'] as const)('suppresses a late receipt when %s and drains it before close', async mode => {
    const f = await fixture(), { receipt, artifacts } = f.seed(), caller = new AbortController()
    let release!: () => void
    vi.mocked(readLinuxRepositoryReceipt).mockImplementation(() => new Promise(resolve => { release = () => resolve({ receipt: receipt!, artifacts: artifacts! }) }))
    const reading = f.runner.inspectSuccessfulExecution('source', caller.signal), rejected = expect(reading).rejects.toThrow('unavailable')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    let closed = false, closing: Promise<void> | undefined
    if (mode === 'cancelled') caller.abort()
    if (mode === 'closed') { closing = f.runner.close().then(() => { closed = true }); await Promise.resolve(); expect(closed).toBe(false) }
    if (mode === 'expired') vi.spyOn(Date, 'now').mockReturnValue(f.input.expiresAt)
    if (mode === 'revoked') f.change('UPDATE isolation_grants SET revoked=1')
    if (mode === 'fenced') f.change('UPDATE isolation_controller SET fence=fence+1')
    release(); await rejected; await closing
    if (mode === 'closed') {
      expect(closed).toBe(true)
      await expect(f.runner.inspectSuccessfulExecution('source')).rejects.toThrow('unavailable')
    }
  })

  test('a pre-cancelled caller never reads evidence', async () => {
    const f = await fixture(); f.seed(); const caller = AbortSignal.abort()
    await expect(f.runner.inspectSuccessfulExecution('source', caller)).rejects.toThrow('unavailable')
    expect(readLinuxRepositoryReceipt).not.toHaveBeenCalled()
  })
})
