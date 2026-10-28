import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { defaultLimits } from '../src/config.js'
import { IsolationLedger } from '../src/ledger.js'
import { linuxJobResourceReservation, type LinuxExecutionContract } from '../src/linux-execution-contract.js'
import { prepareLinuxExecutionIntent, runLinuxExecution } from '../src/linux-execution.js'
import { reconcileLinuxJob } from '../src/linux-job-recovery.js'
import type { IsolationResult } from '../src/types.js'

const evidenceRead = vi.hoisted(() => ({ hook: undefined as (() => void) | undefined, changedBoot: false }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    evidenceRead.hook?.()
    if (evidenceRead.changedBoot && args[0] === '/proc/sys/kernel/random/boot_id') return '00000000-0000-4000-8000-000000000000\n'
    return await actual.readFile(...args)
  } }
})
const uid = process.getuid?.() || 1
const real = process.env.DSH_NATIVE_CGROUP_REAL === '1' && process.platform === 'linux' && (process.getuid?.() ?? 0) > 0
const ledgers: IsolationLedger[] = [], roots: string[] = []
afterEach(async () => {
  evidenceRead.hook = undefined; evidenceRead.changedBoot = false
  for (const ledger of ledgers.splice(0)) ledger.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
function fixture() {
  const ledger = new IsolationLedger(':memory:'); ledgers.push(ledger)
  const authority = ledger.claimController('recovery-owner', 30_000)
  const identity = { principalDigest: 'a'.repeat(64), principalRecordId: 'owner', principalVersion: 1, workspace: '/workspace', agentPreset: 'default' }
  const grant = { ...identity, id: 'finite', revision: 1, expiresAt: Date.now() + 60_000, maxRuns: 1, maxTotalDurationMs: 5000 }
  ledger.syncGrants([grant], authority)
  const contract: LinuxExecutionContract = { schemaVersion: 1, backend: 'linux-native', runtimeDigest: 'b'.repeat(64), profile: 'ordinary',
    limits: { ...defaultLimits, maxDurationMs: 5000, memoryMiB: 128, workspaceMiB: 4, workspaceInodes: 256 },
    keeperLimits: { memoryMiB: 128, pidsLimit: 64, cpus: 0.5 }, cgroupRoots: { mode: 'v1',
      cpu: `/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-${uid}`, memory: `/sys/fs/cgroup/memory/dsh-native/uid-${uid}`,
      pids: `/sys/fs/cgroup/pids/dsh-native/uid-${uid}`, freezer: `/sys/fs/cgroup/freezer/dsh-native/uid-${uid}` } }
  const reservation = linuxJobResourceReservation(contract)
  const input = { identity, sessionId: 'session', grantId: grant.id, idempotencyKey: 'once', requestDigest: 'c'.repeat(64),
    durationMs: 5000, authority, backend: 'linux-native' as const, linuxContract: contract,
    resourceReservation: { memoryMiB: reservation.memoryMiB, workspaceInodes: reservation.workspaceInodes, maxMemoryMiB: 2048, maxWorkspaceInodes: 32768 },
    storageBudget: { maxStateBytes: 268435456, maxJobRecords: 10000, reservedBytes: reservation.storageBytes,
      observation: { bytes: 0, observedAt: Date.now() } } }
  const job = ledger.prepare(input).job
  return { ledger, authority, input, contract, job }
}
async function dispatched() {
  const base = fixture(), stateRoot = await mkdtemp(join(tmpdir(), 'dsh-linux-job-recovery-')); roots.push(stateRoot)
  const intent = await prepareLinuxExecutionIntent({ stateRoot, contract: base.contract, job: {
    id: base.job.id, requestDigest: base.job.requestDigest, nativeResourceId: base.job.nativeResourceId!,
    nativeNonce: base.job.nativeNonce!, deadline: base.job.deadline } })
  let job = base.ledger.markLinuxCreateIntent(base.job.id, base.job.version, intent, base.authority)
  job = base.ledger.markDispatched(job.id, job.version, base.authority)
  return { ...base, stateRoot, job, intent }
}
function historical(jobId: string): IsolationResult {
  return { jobId, status: 'unknown', quiescent: false, stdout: 'original output', stderr: 'original error',
    artifacts: [{ path: 'original', content: 'evidence' }], reason: 'historical uncertainty' }
}

test('undispatched native job becomes quiescent unknown without touching execution state or restoring budget', async () => {
  const { ledger, authority, job, input } = fixture()
  expect(await reconcileLinuxJob(ledger, authority, job, '/unavailable/native-executions')).toBe(true)
  expect(ledger.get(job.id)).toMatchObject({ status: 'unknown', dispatchAttempted: false, result: { status: 'unknown', quiescent: true },
    reservedDurationMs: job.reservedDurationMs, reservedMemoryMiB: job.reservedMemoryMiB, reservedStorageBytes: job.reservedStorageBytes })
  expect(() => ledger.prepare({ ...input, idempotencyKey: 'second' })).toThrow('budget exhausted')
})

test('undispatched historical unknown changes only quiescence', async () => {
  const { ledger, authority, job } = fixture(), result = historical(job.id)
  const unknown = ledger.settle(job.id, job.version, result, authority)
  expect(await reconcileLinuxJob(ledger, authority, unknown, '/unavailable')).toBe(true)
  expect(ledger.get(job.id)?.result).toEqual({ ...result, quiescent: true })
})

test('requires the existing live controller and honors an already aborted signal without writes', async () => {
  const { ledger, authority, job } = fixture(), aborted = new AbortController(); aborted.abort()
  await expect(reconcileLinuxJob(ledger, authority, job, '/unavailable', aborted.signal)).rejects.toThrow()
  ledger.releaseController(authority)
  await expect(reconcileLinuxJob(ledger, authority, job, '/unavailable')).rejects.toThrow('controller unavailable')
  expect(ledger.get(job.id)).toEqual(job)
  expect(ledger.hasController(authority)).toBe(false)
})

test('does not settle historical Docker rows', async () => {
  const { ledger, authority, input } = fixture()
  // Use the existing native job's identity with a separate finite Docker grant.
  ledger.syncGrants([{ ...input.identity, id: 'docker', revision: 1, expiresAt: Date.now() + 60_000, maxRuns: 1, maxTotalDurationMs: 5000 }], authority)
  const { linuxContract: _contract, resourceReservation: _reservation, storageBudget: _storage, ...dockerInput } = input
  const job = ledger.prepare({ ...dockerInput, backend: 'docker', grantId: 'docker' }).job
  expect(await reconcileLinuxJob(ledger, authority, job, '/unavailable')).toBe(false)
  expect(ledger.get(job.id)).toEqual(job)
})

describe.skipIf(!real)('single-job recovery with actual Linux kernel receipts', () => {
  test.each(['partial', 'complete', 'lost-resource-ack'] as const)('reconciles %s proof and preserves finite grant budget', async mode => {
    const ctx = await dispatched(); let job = ctx.job
    const abort = new AbortController(); if (mode === 'partial') abort.abort()
    const outcome = await runLinuxExecution({ stateRoot: ctx.stateRoot, contract: ctx.contract, intent: ctx.intent,
      argv: ['/bin/sh', '-c', 'printf once'], files: [], signal: abort.signal,
      recordResources: async resources => {
        if (mode !== 'lost-resource-ack') job = ctx.ledger.recordLinuxResources(job.id, job.version, resources, ctx.authority)
      }, authorizeStart: () => {
        if (mode === 'lost-resource-ack') return false
        job = ctx.ledger.start(job.id, job.version, ctx.authority); return true
      } })
    expect(outcome.result.quiescent).toBe(true)
    expect(mode === 'partial' ? outcome.partialProof : outcome.receipt).toBeDefined()
    expect(await reconcileLinuxJob(ctx.ledger, ctx.authority, job, ctx.stateRoot)).toBe(true)
    expect(ctx.ledger.get(job.id)?.result).toEqual(mode === 'partial'
      ? expect.objectContaining({ status: 'unknown', quiescent: true }) : outcome.receipt!.result)
    expect(() => ctx.ledger.prepare({ ...ctx.input, idempotencyKey: 'second' })).toThrow('budget exhausted')
    const settled = ctx.ledger.get(job.id)
    expect(await reconcileLinuxJob(ctx.ledger, ctx.authority, job, ctx.stateRoot)).toBe(true)
    expect(ctx.ledger.get(job.id)).toEqual(settled)
  })

  test.each(['partial', 'complete'] as const)('preserves historical unknown body while reconciling %s evidence and lost ACK', async mode => {
    const ctx = await dispatched(), abort = new AbortController(); if (mode === 'partial') abort.abort()
    await runLinuxExecution({ stateRoot: ctx.stateRoot, contract: ctx.contract, intent: ctx.intent, argv: ['/usr/bin/true'],
      files: [], signal: abort.signal, recordResources: async () => {}, authorizeStart: () => false })
    const result = historical(ctx.job.id), unknown = ctx.ledger.settle(ctx.job.id, ctx.job.version, result, ctx.authority)
    expect(await reconcileLinuxJob(ctx.ledger, ctx.authority, unknown, ctx.stateRoot)).toBe(true)
    expect(ctx.ledger.get(unknown.id)?.result).toEqual({ ...result, quiescent: true })
    expect(ctx.ledger.get(unknown.id)).toMatchObject({ reservedDurationMs: unknown.reservedDurationMs,
      reservedMemoryMiB: unknown.reservedMemoryMiB, reservedWorkspaceInodes: unknown.reservedWorkspaceInodes,
      reservedStorageBytes: unknown.reservedStorageBytes })
  })

  test.each(['abort', 'fence'] as const)('stops ledger writes after %s during private evidence reads', async mode => {
    const ctx = await dispatched(), abort = new AbortController()
    await runLinuxExecution({ stateRoot: ctx.stateRoot, contract: ctx.contract, intent: ctx.intent, argv: ['/usr/bin/true'],
      files: [], signal: AbortSignal.abort(), recordResources: async () => {}, authorizeStart: () => false })
    evidenceRead.hook = () => {
      evidenceRead.hook = undefined
      if (mode === 'abort') abort.abort()
      else ctx.ledger.releaseController(ctx.authority)
    }
    await expect(reconcileLinuxJob(ctx.ledger, ctx.authority, ctx.job, ctx.stateRoot, abort.signal)).rejects.toThrow()
    expect(ctx.ledger.get(ctx.job.id)).toEqual(ctx.job)
  })

  test('boot mismatch or missing journal keeps unknown outcome and occupied capacity', async () => {
    const ctx = await dispatched()
    evidenceRead.changedBoot = true
    expect(await reconcileLinuxJob(ctx.ledger, ctx.authority, ctx.job, ctx.stateRoot)).toBe(false)
    expect(ctx.ledger.get(ctx.job.id)?.result).toMatchObject({ status: 'unknown', quiescent: false })
    evidenceRead.changedBoot = false
    const unknown = ctx.ledger.get(ctx.job.id)!
    await rm(join(ctx.stateRoot, 'jobs', `${ctx.intent.jobId}-${ctx.intent.nativeNonce}.json`))
    expect(await reconcileLinuxJob(ctx.ledger, ctx.authority, unknown, ctx.stateRoot)).toBe(false)
    expect(ctx.ledger.get(ctx.job.id)).toEqual(unknown)
    expect(ctx.ledger.recoverable().map(job => job.id)).toContain(ctx.job.id)
  })

  test('live creator retains capacity until its actual run drains, without replay', async () => {
    const ctx = await dispatched(); let job = ctx.job
    let release!: () => void, admitted!: () => void
    const waiting = new Promise<void>(resolve => { admitted = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const run = runLinuxExecution({ stateRoot: ctx.stateRoot, contract: ctx.contract, intent: ctx.intent,
      argv: ['/bin/sh', '-c', 'printf must-not-start'], files: [], signal: new AbortController().signal,
      recordResources: async resources => { job = ctx.ledger.recordLinuxResources(job.id, job.version, resources, ctx.authority) },
      authorizeStart: async () => { admitted(); await gate; return false } })
    try {
      await waiting
      expect(await reconcileLinuxJob(ctx.ledger, ctx.authority, job, ctx.stateRoot)).toBe(false)
      expect(ctx.ledger.get(job.id)?.result).toMatchObject({ status: 'unknown', quiescent: false })
    } finally { release(); await run }
    expect(await reconcileLinuxJob(ctx.ledger, ctx.authority, ctx.ledger.get(job.id)!, ctx.stateRoot)).toBe(true)
    expect(ctx.ledger.get(job.id)?.result).toMatchObject({ status: 'unknown', quiescent: true, stdout: '' })
    expect(await readFile(join(ctx.stateRoot, 'jobs', `${ctx.intent.jobId}-${ctx.intent.nativeNonce}.json`), 'utf8')).not.toContain('must-not-start')
  })
})
