import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { IsolationLedger, type IsolationControllerAuthority } from '../src/ledger.ts'
import { inspectIsolationGrant } from '../src/diagnostics.ts'
import { linuxExecutionContractDigest, linuxExecutionIntentDigest, linuxExecutionResourcesDigest, validateLinuxExecutionContract, validateLinuxExecutionIntent, validateLinuxExecutionResources, type LinuxExecutionContract, type LinuxExecutionIntent, type LinuxExecutionResources, type LinuxReceiptBinding } from '../src/linux-execution-contract.ts'
import type { IsolationGrant, IsolationJob, IsolationResult } from '../src/types.ts'
import { linuxExecutionPartialCleanupProofDigest, linuxJobResourceReservation, type LinuxExecutionPartialCleanupProof, type LinuxRepositoryExecutionContract } from '../src/linux-execution-contract.ts'

const directories: string[] = []
const ledgers: IsolationLedger[] = []
afterEach(() => { for (const ledger of ledgers.splice(0)) ledger.close(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
const identity = { principalDigest: 'a'.repeat(64), principalRecordId: 'owner', principalVersion: 1, workspace: '/work', agentPreset: 'default' }
const grant: IsolationGrant = { ...identity, id: 'grant', revision: 1, expiresAt: 100_000, maxRuns: 10, maxTotalDurationMs: 10_000 }
const contract: LinuxExecutionContract = {
  schemaVersion: 1, backend: 'linux-native', runtimeDigest: 'b'.repeat(64), profile: 'ordinary',
  limits: { maxDurationMs: 1000, maxInputBytes: 1024, maxOutputBytes: 1024, maxArtifactBytes: 1024, maxFiles: 8, memoryMiB: 64, workspaceMiB: 16, workspaceInodes: 128, pidsLimit: 16, cpus: 1 },
  keeperLimits: { memoryMiB: 32, pidsLimit: 8, cpus: 0.1 },
  cgroupRoots: { mode: 'v1', cpu: '/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-1000', memory: '/sys/fs/cgroup/memory/dsh-native/uid-1000', pids: '/sys/fs/cgroup/pids/dsh-native/uid-1000', freezer: '/sys/fs/cgroup/freezer/dsh-native/uid-1000' },
}
const request = (key = 'key') => ({ identity, sessionId: 'session', grantId: 'grant', idempotencyKey: key, requestDigest: 'c'.repeat(64), durationMs: 500, backend: 'linux-native' as const, linuxContract: contract,
  resourceReservation: { memoryMiB: 112, workspaceInodes: 128, maxMemoryMiB: 224, maxWorkspaceInodes: 256 },
  storageBudget: { maxStateBytes: 1_000_000, maxJobRecords: 100, reservedBytes: 4096, observation: { bytes: 0, observedAt: 10_000 } } })
function root(): string { const path = mkdtempSync(join(tmpdir(), 'linux-ledger-')); chmodSync(path, 0o700); directories.push(path); return path }
function setup(file = ':memory:', now = () => 10_000): { ledger: IsolationLedger; authority: IsolationControllerAuthority } {
  const ledger = new IsolationLedger(file, { now }); ledgers.push(ledger)
  const authority = ledger.claimController('host', 1000); ledger.syncGrants([grant], authority)
  return { ledger, authority }
}
function intent(job: IsolationJob): LinuxExecutionIntent {
  const roots = Object.fromEntries(Object.entries(contract.cgroupRoots).filter(([key]) => key !== 'mode').map(([key, path], index) => [key, { path, dev: index + 1, ino: 10 + index }]))
  return { schemaVersion: 1, jobId: job.id, requestDigest: job.requestDigest, nativeResourceId: job.nativeResourceId!, nativeNonce: job.nativeNonce!, contractDigest: linuxExecutionContractDigest(contract), bootId: '00000000-0000-0000-0000-000000000001', uid: 1000, deadline: job.deadline, namespacePath: `/tmp/private/${job.id}`, workerNonce: 'd'.repeat(32), keeperNonce: 'e'.repeat(32), roots }
}
function resources(value: LinuxExecutionIntent): LinuxExecutionResources {
  const snapshot = (nonce: string, keeper: boolean) => ({ schemaVersion: 1 as const, mode: 'v1' as const, bootId: value.bootId, jobId: value.jobId, nonce, uid: value.uid, deadline: value.deadline,
    limits: keeper ? contract.keeperLimits : { memoryMiB: contract.limits.memoryMiB, pidsLimit: contract.limits.pidsLimit, cpus: contract.limits.cpus },
    directories: Object.fromEntries(Object.entries(value.roots).map(([key, entry]) => [key, { path: `${entry.path}/job-${value.jobId}-${nonce}`, dev: entry.dev, ino: entry.ino + (keeper ? 200 : 100) }])) })
  return { schemaVersion: 1, intentDigest: linuxExecutionIntentDigest(value), worker: snapshot(value.workerNonce, false), keeper: snapshot(value.keeperNonce, true) }
}
function ready(ledger: IsolationLedger, authority: IsolationControllerAuthority, key = 'key'): IsolationJob {
  let job = ledger.prepare({ ...request(key), authority }).job
  job = ledger.markLinuxCreateIntent(job.id, job.version, intent(job), authority)
  job = ledger.markDispatched(job.id, job.version, authority)
  return ledger.recordLinuxResources(job.id, job.version, resources(job.linuxIntent!), authority)
}
function binding(job: IsolationJob): LinuxReceiptBinding {
  return { requestDigest: job.requestDigest, nativeNonce: job.nativeNonce!, nativeResourceId: job.nativeResourceId!, intentDigest: linuxExecutionIntentDigest(job.linuxIntent!), resourcesDigest: linuxExecutionResourcesDigest(job.linuxResources!), receiptDigest: 'f'.repeat(64) }
}
function partialProof(job: IsolationJob, overrides: Partial<Omit<LinuxExecutionPartialCleanupProof, 'proofDigest'>> = {}): LinuxExecutionPartialCleanupProof {
  const body = { schemaVersion: 1 as const, jobId: job.id, requestDigest: job.requestDigest,
    nativeNonce: job.nativeNonce!, nativeResourceId: job.nativeResourceId!, intentDigest: linuxExecutionIntentDigest(job.linuxIntent!),
    observedAt: 10_000, workerAbsent: true as const, keeperAbsent: true as const, namespaceAbsent: true as const, ...overrides }
  return { ...body, proofDigest: linuxExecutionPartialCleanupProofDigest(body) }
}
const outcome = (job: IsolationJob, status: IsolationResult['status'] = 'succeeded', quiescent = true): IsolationResult => ({ jobId: job.id, status, quiescent, stdout: 'original output', stderr: 'original error', artifacts: [{ path: 'out', content: 'original artifact' }], reason: 'original reason' })

describe('Linux durable execution values', () => {
  it('strictly validates, freezes and canonically hashes contracts and linked snapshots', () => {
    const { ledger, authority } = setup(); const job = ledger.prepare({ ...request(), authority }).job
    const value = intent(job); const groups = resources(value)
    expect(Object.isFrozen(validateLinuxExecutionContract(contract).limits)).toBe(true)
    expect(Object.isFrozen(validateLinuxExecutionResources(groups, value, contract).worker.directories)).toBe(true)
    expect(linuxExecutionContractDigest({ ...contract, keeperLimits: { cpus: 0.1, memoryMiB: 32, pidsLimit: 8 } })).toBe(linuxExecutionContractDigest(contract))
    expect(() => linuxExecutionIntentDigest({ ...value, requestDigest: 'bad' })).toThrow()
    expect(() => linuxExecutionResourcesDigest({ ...groups, intentDigest: 'bad' })).toThrow()
    expect(() => validateLinuxExecutionContract({ ...contract, unexpected: true })).toThrow()
    expect(() => validateLinuxExecutionContract({ ...contract, limits: { ...contract.limits, cpus: Number.NaN } })).toThrow()
    expect(() => validateLinuxExecutionContract({ ...contract, cgroupRoots: { ...contract.cgroupRoots, cpu: '/sys/fs/cgroup/cpu/../cpu/dsh-native/uid-1000' } })).toThrow()
    for (const mutation of [{ uid: 0 }, { uid: 1001 }, { deadline: 0 }, { workerNonce: value.keeperNonce }, { contractDigest: '0'.repeat(64) }, { namespacePath: '/tmp/../private' }, { requestDigest: 'bad' }, { jobId: 'bad' }, { bootId: 'bad' }, { roots: { ...value.roots, extra: value.roots.cpu } }]) {
      expect(() => validateLinuxExecutionIntent({ ...value, ...mutation }, contract)).toThrow()
    }
    expect(() => validateLinuxExecutionResources({ ...groups, intentDigest: '0'.repeat(64) }, value, contract)).toThrow()
    for (const kind of ['worker', 'keeper'] as const) {
      for (const mutation of [{ bootId: '00000000-0000-0000-0000-000000000002' }, { uid: 1001 }, { deadline: value.deadline + 1 }, { jobId: '00000000-0000-0000-0000-000000000002' }, { nonce: '0'.repeat(32) }, { mode: 'v2' }, { limits: contract.keeperLimits }, { directories: {} }]) {
        if (kind === 'keeper' && 'limits' in mutation) continue
        expect(() => validateLinuxExecutionResources({ ...groups, [kind]: { ...groups[kind], ...mutation } }, value, contract)).toThrow()
      }
      const changed = { ...groups[kind].directories, cpu: { ...groups[kind].directories.cpu!, path: `${value.roots.cpu!.path}/foreign` } }
      expect(() => validateLinuxExecutionResources({ ...groups, [kind]: { ...groups[kind], directories: changed } }, value, contract)).toThrow()
      for (const identity of [{ dev: 999 }, { ino: value.roots.cpu!.ino }]) {
        const changedIdentity = { ...groups[kind].directories, cpu: { ...groups[kind].directories.cpu!, ...identity } }
        expect(() => validateLinuxExecutionResources({ ...groups, [kind]: { ...groups[kind], directories: changedIdentity } }, value, contract)).toThrow()
      }
    }
  })
})

describe('Linux IsolationLedger', () => {
  it('reserves all repository mounts and durable binary spool before admitting a job', () => {
    const { ledger, authority } = setup()
    const repository: LinuxRepositoryExecutionContract = { ...contract, schemaVersion: 2, profile: 'repository',
      limits: { ...contract.limits, maxInputBytes: 64 * 1024 ** 2, maxArtifactBytes: 32 * 1024 ** 2,
        tmpMiB: 32, tmpInodes: 128, inputMiB: 65, inputInodes: 16 },
      keeperLimits: { memoryMiB: 256, pidsLimit: 64, cpus: 0.5 } }
    const minimum = linuxJobResourceReservation(repository)
    const resources = { memoryMiB: minimum.memoryMiB, workspaceInodes: minimum.workspaceInodes,
      maxMemoryMiB: minimum.memoryMiB, maxWorkspaceInodes: minimum.workspaceInodes }
    const storage = { ...request().storageBudget, reservedBytes: minimum.storageBytes, maxStateBytes: 4 * minimum.storageBytes }
    const input = { ...request(), authority, linuxContract: repository, resourceReservation: resources, storageBudget: storage }
    for (const mutation of [
      { resourceReservation: { ...resources, memoryMiB: minimum.memoryMiB - 1 } },
      { resourceReservation: { ...resources, workspaceInodes: minimum.workspaceInodes - 1 } },
      { storageBudget: { ...storage, reservedBytes: minimum.storageBytes - 1 } },
    ]) expect(() => ledger.prepare({ ...input, ...mutation })).toThrow(/repository resources must be reserved/u)
    expect(ledger.findJobByKey(identity, 'session', 'grant', 'key')).toBeUndefined()
    const job = ledger.prepare(input).job
    const bound = ledger.markLinuxCreateIntent(job.id, job.version, {
      ...intent(job), schemaVersion: 2, contractDigest: linuxExecutionContractDigest(repository),
      repository: { archive: { bytes: 1024, sha256: 'a'.repeat(64) }, artifacts: ['package.tgz'], executionDigest: 'b'.repeat(64) },
    }, authority)
    expect(bound).toMatchObject({ reservedMemoryMiB: minimum.memoryMiB, reservedWorkspaceInodes: minimum.workspaceInodes,
      reservedStorageBytes: 108 * 1024 ** 2, linuxIntent: { schemaVersion: 2 } })
    expect(ledger.prepare(input)).toEqual({ created: false, job: bound })
    expect(() => ledger.prepare({ ...input, idempotencyKey: 'second' })).toThrow(/resource pool exhausted/u)
  })

  it('requires finite resource/storage reservation and a frozen contract, keeps random job identities and owner-scoped keys', () => {
    const { ledger, authority } = setup()
    for (const mutation of [{ linuxContract: undefined }, { resourceReservation: undefined }, { storageBudget: undefined }, { durationMs: 1001 }, { requestDigest: 'bad' }, { resourceReservation: { ...request().resourceReservation, memoryMiB: 111 } }, { resourceReservation: { ...request().resourceReservation, workspaceInodes: 127 } }]) {
      expect(() => ledger.prepare({ ...request(), ...mutation, authority } as unknown as Parameters<IsolationLedger['prepare']>[0])).toThrow()
    }
    expect(() => ledger.prepare(request())).toThrow(/controller authority/u)
    const first = ledger.prepare({ ...request(), authority }).job
    const second = ledger.prepare({ ...request('second'), authority }).job
    expect(first).toMatchObject({ backend: 'linux-native', nativeResourceId: `linux-${first.id}`, reservedMemoryMiB: 112, reservedWorkspaceInodes: 128, reservedStorageBytes: 4096, linuxContract: contract })
    expect(first.nativeNonce).toMatch(/^[0-9a-f]{32}$/u); expect(first.nativeNonce).not.toBe(second.nativeNonce)
    expect(first.containerName).toBe('')
    expect(ledger.findJobByKey(identity, 'session', 'grant', 'key')).toEqual(first)
    for (const mutation of [{ principalDigest: 'other' }, { principalRecordId: 'other' }, { principalVersion: 2 }, { workspace: '/other' }, { agentPreset: 'other' }]) expect(ledger.findJobByKey({ ...identity, ...mutation }, 'session', 'grant', 'key')).toBeUndefined()
    expect(ledger.findJobByKey(identity, 'other', 'grant', 'key')).toBeUndefined()
    expect(ledger.findJobByKey(identity, 'session', 'other', 'key')).toBeUndefined()
    expect(ledger.prepare({ ...request(), authority })).toEqual({ job: first, created: false })
    expect(() => ledger.prepare({ ...request(), linuxContract: { ...contract, runtimeDigest: '0'.repeat(64) }, authority })).toThrow(/different request or backend/u)
  })

  it('enforces intent → dispatch → complete snapshots → start with one-shot CAS and controller fencing', () => {
    const { ledger, authority } = setup()
    let job = ledger.prepare({ ...request(), authority }).job
    expect(() => ledger.markDispatched(job.id, job.version, authority)).toThrow()
    expect(() => ledger.start(job.id, job.version, authority)).toThrow()
    expect(() => ledger.recordLinuxResources(job.id, job.version, resources(intent(job)), authority)).toThrow()
    for (const mutation of [{ requestDigest: '0'.repeat(64) }, { nativeNonce: '0'.repeat(32) }, { deadline: job.deadline + 1 }]) expect(() => ledger.markLinuxCreateIntent(job.id, job.version, { ...intent(job), ...mutation }, authority)).toThrow()
    job = ledger.markLinuxCreateIntent(job.id, job.version, intent(job), authority)
    expect(() => ledger.markLinuxCreateIntent(job.id, job.version, intent(job), authority)).toThrow()
    job = ledger.markDispatched(job.id, job.version, authority)
    expect(() => ledger.start(job.id, job.version, authority)).toThrow()
    const beforeResources = job
    job = ledger.recordLinuxResources(job.id, job.version, resources(job.linuxIntent!), authority)
    expect(() => ledger.recordLinuxResources(job.id, beforeResources.version, job.linuxResources!, authority)).toThrow(/conflict/u)
    expect(() => ledger.recordLinuxResources(job.id, job.version, job.linuxResources!, authority)).toThrow()
    ledger.releaseController(authority); const current = ledger.claimController('fresh-host', 1000)
    expect(() => ledger.start(job.id, job.version, authority)).toThrow(/fenced/u)
    job = ledger.start(job.id, job.version, current)
    expect(job.status).toBe('running')
    expect(ledger.prepare({ ...request(), authority: current })).toEqual({ job, created: false })
    expect(() => ledger.markDispatched(job.id, job.version, current)).toThrow()
  })

  it('accepts only bound receipts and never lets ordinary settle release a dispatched Linux job', () => {
    const { ledger, authority } = setup(); let job = ready(ledger, authority)
    job = ledger.start(job.id, job.version, authority)
    expect(() => ledger.settle(job.id, job.version, outcome(job), authority)).toThrow(/durable receipt/u)
    expect(() => ledger.settle(job.id, job.version, outcome(job, 'unknown'), authority)).toThrow(/independent quiescence/u)
    expect(() => ledger.settleNativeReceipt(job.id, job.version, { requestDigest: job.requestDigest, nonce: job.nativeNonce!, nativeResourceId: job.nativeResourceId! }, outcome(job), authority)).toThrow()
    const proof = binding(job)
    for (const key of ['requestDigest', 'nativeNonce', 'nativeResourceId', 'intentDigest', 'resourcesDigest', 'receiptDigest'] as const) {
      const changed = { ...proof, [key]: key === 'nativeResourceId' ? `linux-00000000-0000-0000-0000-000000000000` : key === 'nativeNonce' ? '0'.repeat(32) : '0'.repeat(key === 'receiptDigest' ? 63 : 64) }
      expect(() => ledger.settleLinuxReceipt(job.id, job.version, changed, outcome(job), authority)).toThrow()
    }
    expect(() => ledger.settleLinuxReceipt(job.id, job.version, proof, outcome(job, 'unknown', false), authority)).toThrow()
    expect(() => ledger.settleLinuxReceipt(job.id, job.version, proof, outcome(job), { ...authority, fence: authority.fence + 1 })).toThrow(/fenced/u)
    job = ledger.settleLinuxReceipt(job.id, job.version, proof, outcome(job), authority)
    expect(job.status).toBe('succeeded'); expect(job.result?.quiescent).toBe(true)
    expect(ledger.recoverable()).toHaveLength(0)
    expect(() => ledger.settleLinuxReceipt(job.id, job.version, proof, outcome(job), authority)).toThrow()
  })

  it('permits independently proven unknown termination and preserves an earlier unknown body/status/budgets when reconciled', () => {
    const stateRoot = root(); const { ledger, authority } = setup(join(stateRoot, 'ledger.sqlite'))
    const first = ready(ledger, authority)
    const terminated = ledger.settleLinuxReceipt(first.id, first.version, binding(first), outcome(first, 'unknown'), authority)
    expect(terminated).toMatchObject({ status: 'unknown', result: { quiescent: true } })
    let job = ready(ledger, authority, 'unknown')
    const proof = binding(job); job = ledger.settle(job.id, job.version, outcome(job, 'unknown', false), authority)
    const original = job
    expect(() => ledger.settleLinuxReceipt(job.id, job.version, proof, outcome(job), authority)).toThrow(/reconciliation/u)
    expect(() => ledger.settle(job.id, job.version, outcome(job, 'unknown'), authority)).toThrow()
    expect(ledger.storageStats().activeReservedBytes).toBe(4096)
    job = ledger.settleLinuxReconciledUnknown(job.id, job.version, proof, authority)
    expect(job).toEqual({ ...original, result: { ...original.result!, quiescent: true }, version: original.version + 1 })
    expect(ledger.storageStats().activeReservedBytes).toBe(0)
    expect(inspectIsolationGrant({ stateRoot, grant, now: 10_000 })).toMatchObject({ runsUsed: 2, durationReservedMs: 1000, unknownJobs: 2, activeJobs: 0 })
    expect(ledger.prepare({ ...request('unknown'), authority })).toEqual({ job, created: false })
    expect(() => ledger.settleLinuxReconciledUnknown(job.id, job.version, proof, authority)).toThrow()
  })

  it('retains partial creation capacity until bound absence proof, then releases it without resetting the outcome or grant', () => {
    const { ledger, authority } = setup()
    ledger.syncGrants([{ ...grant, revision: 2, maxRuns: 1, maxTotalDurationMs: 500 }], authority)
    let job = ledger.prepare({ ...request(), authority }).job
    job = ledger.markLinuxCreateIntent(job.id, job.version, intent(job), authority); job = ledger.markDispatched(job.id, job.version, authority)
    job = ledger.settle(job.id, job.version, outcome(job, 'unknown', false), authority)
    expect(job.linuxResources).toBeUndefined()
    expect(ledger.storageStats().activeReservedBytes).toBe(4096)
    expect(ledger.recoverable()).toMatchObject([{ id: job.id }])
    expect(() => ledger.settleLinuxReconciledUnknown(job.id, job.version, { requestDigest: job.requestDigest, nativeNonce: job.nativeNonce!, nativeResourceId: job.nativeResourceId!, intentDigest: linuxExecutionIntentDigest(job.linuxIntent!), resourcesDigest: '0'.repeat(64), receiptDigest: 'f'.repeat(64) }, authority)).toThrow()
    expect(ledger.prepare({ ...request(), authority })).toEqual({ job, created: false })
    const original = job
    for (const mutation of [{ requestDigest: '0'.repeat(64) }, { nativeNonce: '0'.repeat(32) },
      { intentDigest: '0'.repeat(64) }, { observedAt: 9_999 }, { observedAt: 10_001 }]) {
      expect(() => ledger.settleLinuxPrestartCleanup(job.id, job.version, partialProof(job, mutation), authority)).toThrow()
    }
    expect(() => ledger.settleLinuxPrestartCleanup(job.id, job.version, { ...partialProof(job), proofDigest: '0'.repeat(64) }, authority)).toThrow()
    expect(() => ledger.settleLinuxPrestartCleanup(job.id, job.version, partialProof(job), { ownerId: 'other', fence: authority.fence })).toThrow()
    expect(ledger.get(job.id)).toEqual(original)
    job = ledger.settleLinuxPrestartCleanup(job.id, job.version, partialProof(job), authority)
    expect(job).toEqual({ ...original, version: original.version + 1, result: { ...original.result!, quiescent: true } })
    expect(ledger.storageStats().activeReservedBytes).toBe(0)
    expect(ledger.recoverable()).toEqual([])
    expect(ledger.prepare({ ...request(), authority })).toEqual({ job, created: false })
    expect(() => ledger.prepare({ ...request('second'), authority })).toThrow(/budget exhausted/u)
    expect(() => ledger.start(job.id, job.version, authority)).toThrow()
    expect(() => ledger.settleLinuxPrestartCleanup(job.id, job.version, partialProof(job), authority)).toThrow()
  })

  it('records recovered snapshots for an unknown lost acknowledgement without reopening execution', () => {
    const { ledger, authority } = setup()
    let job = ledger.prepare({ ...request(), authority }).job
    job = ledger.markLinuxCreateIntent(job.id, job.version, intent(job), authority)
    job = ledger.markDispatched(job.id, job.version, authority)
    const groups = resources(job.linuxIntent!)
    expect(() => ledger.recordLinuxRecoveredResources(job.id, job.version, groups, authority)).toThrow()
    job = ledger.settle(job.id, job.version, outcome(job, 'unknown', false), authority)
    const original = job
    expect(() => ledger.recordLinuxResources(job.id, job.version, groups, authority)).toThrow()
    expect(() => ledger.recordLinuxRecoveredResources(job.id, job.version, { ...groups, intentDigest: '0'.repeat(64) }, authority)).toThrow()
    job = ledger.recordLinuxRecoveredResources(job.id, job.version, groups, authority)
    expect(job.result).toEqual(original.result)
    expect(job.status).toBe('unknown')
    expect(() => ledger.start(job.id, job.version, authority)).toThrow()
    expect(() => ledger.recordLinuxRecoveredResources(job.id, job.version, groups, authority)).toThrow()
    expect(() => ledger.settleLinuxPrestartCleanup(job.id, job.version, partialProof(job), authority)).toThrow()
    job = ledger.settleLinuxReconciledUnknown(job.id, job.version, binding(job), authority)
    expect(job.result).toEqual({ ...original.result!, quiescent: true })
    expect(ledger.storageStats().activeReservedBytes).toBe(0)
  })

  it('settles pre-start absence directly from prepared but never for full or undispatched resources', () => {
    const { ledger, authority } = setup()
    let job = ledger.prepare({ ...request(), authority }).job
    job = ledger.markLinuxCreateIntent(job.id, job.version, intent(job), authority)
    expect(() => ledger.settleLinuxPrestartCleanup(job.id, job.version, partialProof(job), authority)).toThrow()
    job = ledger.markDispatched(job.id, job.version, authority)
    job = ledger.settleLinuxPrestartCleanup(job.id, job.version, partialProof(job), authority)
    expect(job).toMatchObject({ status: 'unknown', result: { quiescent: true, stdout: '', artifacts: [] } })
    const full = ready(ledger, authority, 'full')
    expect(() => ledger.settleLinuxPrestartCleanup(full.id, full.version, partialProof(full), authority)).toThrow()
  })

  it('settles a pre-dispatch failure without create evidence and can reopen complete Linux state', () => {
    const file = join(root(), 'ledger.sqlite'); const { ledger, authority } = setup(file)
    const prepared = ledger.prepare({ ...request('failed-before-dispatch'), authority }).job
    expect(ledger.settle(prepared.id, prepared.version, outcome(prepared, 'failed'), authority).status).toBe('failed')
    const job = ready(ledger, authority)
    const reopened = new IsolationLedger(file, { now: () => 10_000 }); ledgers.push(reopened)
    expect(reopened.get(job.id)).toEqual(job)
    expect(reopened.prepare({ ...request(), authority })).toEqual({ job, created: false })
  })
})


describe('real schema 7 migration', () => {
  it('preserves Docker/macOS unknowns, grant budgets, controller/audit history and SQL checks', () => {
    const stateRoot = root(); const file = join(stateRoot, 'ledger.sqlite')
    const { ledger, authority } = setup(file)
    const limited = { ...grant, maxRuns: 2, maxTotalDurationMs: 1000, revision: 2 }; ledger.syncGrants([limited], authority)
    let docker = ledger.prepare({ identity, sessionId: 'session', grantId: 'grant', idempotencyKey: 'old-docker', requestDigest: 'legacy-docker', durationMs: 500, resourceReservation: request().resourceReservation, authority }).job
    docker = ledger.markDispatched(docker.id, docker.version, authority); docker = ledger.settle(docker.id, docker.version, outcome(docker, 'unknown', false), authority)
    let mac = ledger.prepare({ identity, sessionId: 'session', grantId: 'grant', idempotencyKey: 'old-mac', requestDigest: 'legacy-mac', durationMs: 500, backend: 'macos-seatbelt', authority }).job
    mac = ledger.markDispatched(mac.id, mac.version, authority); mac = ledger.settle(mac.id, mac.version, outcome(mac, 'unknown', false), authority)
    ledger.close(); ledgers.splice(ledgers.indexOf(ledger), 1)
    const database = new DatabaseSync(file)
    const columns = (database.prepare('PRAGMA table_info(isolation_jobs)').all() as Array<{ name: string }>).map(row => row.name).filter(name => !name.startsWith('linux_')).join(',')
    database.exec(`DROP INDEX isolation_artifact_contract; ALTER TABLE isolation_jobs RENAME TO saved_v8;
      CREATE TABLE isolation_jobs (id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, grant_revision INTEGER NOT NULL, principal_digest TEXT NOT NULL, principal_record_id TEXT NOT NULL, principal_version INTEGER NOT NULL, workspace TEXT NOT NULL, agent_preset TEXT NOT NULL, session_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL, container_name TEXT UNIQUE, backend_kind TEXT NOT NULL CHECK(backend_kind IN ('docker','macos-seatbelt')), native_resource_id TEXT UNIQUE, native_nonce TEXT, deadline INTEGER NOT NULL, reserved_duration_ms INTEGER NOT NULL, reserved_memory_mib INTEGER NOT NULL DEFAULT 0, reserved_workspace_inodes INTEGER NOT NULL DEFAULT 0, reserved_storage_bytes INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK(status IN ('prepared','running','succeeded','failed','cancelled','timed-out','unknown')), version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, result_json TEXT, dispatch_attempted INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_attempted IN (0,1)), creation_witness_json TEXT, artifact_binding_json TEXT, CHECK((backend_kind='docker' AND container_name IS NOT NULL AND native_resource_id IS NULL AND native_nonce IS NULL) OR (backend_kind='macos-seatbelt' AND container_name IS NULL AND native_resource_id IS NOT NULL AND native_nonce IS NOT NULL AND reserved_memory_mib=0 AND reserved_workspace_inodes=0)), UNIQUE(principal_digest, principal_record_id, principal_version, workspace, agent_preset, session_id, grant_id, idempotency_key)) STRICT;
      INSERT INTO isolation_jobs (${columns}) SELECT ${columns} FROM saved_v8;
      DROP TABLE saved_v8; CREATE INDEX isolation_jobs_grant ON isolation_jobs(grant_id); CREATE INDEX isolation_jobs_recoverable ON isolation_jobs(status,updated_at);
      PRAGMA user_version=7; UPDATE schema_meta SET value='7' WHERE key='schema-version';`)
    const beforeJobs = database.prepare('SELECT * FROM isolation_jobs ORDER BY id').all()
    const beforeGrants = database.prepare('SELECT * FROM isolation_grants').all()
    const beforeAudit = database.prepare('SELECT * FROM isolation_audit').all()
    const beforeController = database.prepare('SELECT * FROM isolation_controller').all()
    database.close()
    expect(inspectIsolationGrant({ stateRoot, grant: limited, now: 10_000 })).toMatchObject({ runsUsed: 2, durationReservedMs: 1000, activeJobs: 2, unknownJobs: 2 })
    const migrated = new IsolationLedger(file, { now: () => 10_000 }); ledgers.push(migrated)
    expect(migrated.get(docker.id)).toEqual(docker); expect(migrated.get(mac.id)).toEqual(mac)
    expect(migrated.hasController(authority)).toBe(true)
    expect(migrated.recoverable()).toHaveLength(2)
    expect(() => migrated.prepare({ ...request('new-linux'), authority })).toThrow(/budget exhausted/u)
    expect(migrated.findJobByKey(identity, 'session', 'grant', 'old-mac')).toEqual(mac)
    const after = new DatabaseSync(file)
    expect((after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(8)
    const afterJobs = after.prepare('SELECT * FROM isolation_jobs ORDER BY id').all().map(row => { const { linux_contract_json, linux_intent_json, linux_resources_json, ...legacy } = row; expect([linux_contract_json, linux_intent_json, linux_resources_json]).toEqual([null, null, null]); return legacy })
    expect(afterJobs).toEqual(beforeJobs)
    expect(after.prepare('SELECT * FROM isolation_grants').all()).toEqual(beforeGrants)
    expect(after.prepare('SELECT * FROM isolation_audit').all()).toEqual(beforeAudit)
    expect(after.prepare('SELECT * FROM isolation_controller').all()).toEqual(beforeController)
    expect(() => after.prepare('UPDATE isolation_jobs SET reserved_memory_mib=1 WHERE id=?').run(mac.id)).toThrow(/CHECK/u)
    expect(() => after.prepare('UPDATE isolation_jobs SET native_resource_id=? WHERE id=?').run('invalid-native', docker.id)).toThrow(/CHECK/u)
    expect(() => after.prepare('UPDATE isolation_jobs SET status=? WHERE id=?').run('invalid-status', docker.id)).toThrow(/CHECK/u)
    expect(() => after.prepare('UPDATE isolation_jobs SET dispatch_attempted=2 WHERE id=?').run(docker.id)).toThrow(/CHECK/u)
    after.close()
  })
})
