import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import { reconcileIsolation, revokeIsolationGrant } from '../src/cli.js'
import { defaultLimits } from '../src/config.js'
import { IsolationLedger } from '../src/ledger.js'
import { linuxJobResourceReservation, type LinuxExecutionContract } from '../src/linux-execution-contract.js'
import { prepareLinuxExecutionIntent, runLinuxExecution } from '../src/linux-execution.js'
import { LinuxVerifierRunner } from '../src/linux-verifier-runner.js'
import { probeLinuxIsolationRuntime } from '../src/probe.js'
import { linuxRuntimeFixture } from './helpers/linux-runtime-fixture.js'

const real = process.env.DSH_NATIVE_CGROUP_REAL === '1' && process.platform === 'linux' && (process.getuid?.() ?? 0) > 0
const roots: string[] = [], ledgers: IsolationLedger[] = []
afterEach(async () => {
  for (const ledger of ledgers.splice(0)) ledger.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function root(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'dsh-linux-cli-')); roots.push(path); return path }
async function prepared() {
  const stateRoot = await root(), ledger = new IsolationLedger(join(stateRoot, 'ledger.sqlite')); ledgers.push(ledger)
  const authority = ledger.claimController('predecessor', 30_000)
  const uid = process.getuid?.() || 1
  const contract: LinuxExecutionContract = { schemaVersion: 1, backend: 'linux-native', runtimeDigest: 'a'.repeat(64), profile: 'ordinary',
    limits: { ...defaultLimits, memoryMiB: 128, workspaceMiB: 4, workspaceInodes: 256, maxDurationMs: 5000 },
    keeperLimits: { memoryMiB: 128, pidsLimit: 64, cpus: 0.5 }, cgroupRoots: { mode: 'v1',
      cpu: `/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-${uid}`, memory: `/sys/fs/cgroup/memory/dsh-native/uid-${uid}`,
      pids: `/sys/fs/cgroup/pids/dsh-native/uid-${uid}`, freezer: `/sys/fs/cgroup/freezer/dsh-native/uid-${uid}` } }
  const identity = { principalDigest: 'b'.repeat(64), principalRecordId: 'owner', principalVersion: 1, workspace: stateRoot, agentPreset: 'test' }
  ledger.syncGrants([{ ...identity, id: 'grant', revision: 1, expiresAt: Date.now() + 60_000, maxRuns: 1, maxTotalDurationMs: 5000 }], authority)
  const reservation = linuxJobResourceReservation(contract)
  const input = { identity, sessionId: 'session', grantId: 'grant', idempotencyKey: 'once', requestDigest: 'c'.repeat(64), durationMs: 5000,
    authority, backend: 'linux-native' as const, linuxContract: contract,
    resourceReservation: { memoryMiB: reservation.memoryMiB, workspaceInodes: reservation.workspaceInodes, maxMemoryMiB: 2048, maxWorkspaceInodes: 32768 },
    storageBudget: { maxStateBytes: 268435456, maxJobRecords: 10000, reservedBytes: reservation.storageBytes, observation: { bytes: 0, observedAt: Date.now() } } }
  const job = ledger.prepare(input).job
  return { stateRoot, ledger, authority, job, contract, input }
}

test.skipIf(process.platform !== 'linux')('native reconcile ignores unavailable Docker configuration and never resets the consumed budget', async () => {
  const ctx = await prepared(); ctx.ledger.releaseController(ctx.authority)
  expect(await reconcileIsolation(ctx.stateRoot, 'no-docker', new AbortController().signal, 'not-a-socket')).toEqual({ checked: 1, released: 1, retained: 0 })
  expect(ctx.ledger.get(ctx.job.id)?.result).toMatchObject({ status: 'unknown', quiescent: true })
  const authority = ctx.ledger.claimController('inspect', 30_000)
  expect(() => ctx.ledger.prepare({ ...ctx.input, authority, idempotencyKey: 'second' })).toThrow('budget exhausted')
  ctx.ledger.releaseController(authority)
})

test.skipIf(process.platform !== 'linux')('external native revoke is durable without taking a live controller or interpreting an empty Docker container name', async () => {
  const ctx = await prepared()
  expect(await revokeIsolationGrant(ctx.stateRoot, 'grant', 1, 'no-docker', 'not-a-socket')).toEqual({
    revoked: true, containersRemoved: true, nativeResourcesQuiescent: false, nativeRetained: 1 })
  expect(ctx.ledger.hasController(ctx.authority)).toBe(true)
  expect(ctx.ledger.usable(ctx.job.id)).toBe(false)
  expect(ctx.ledger.get(ctx.job.id)).toEqual(ctx.job)
  await expect(reconcileIsolation(ctx.stateRoot, 'no-docker')).rejects.toThrow('another host')
  ctx.ledger.releaseController(ctx.authority)
  expect(await revokeIsolationGrant(ctx.stateRoot, 'grant', 1, 'no-docker', 'not-a-socket')).toEqual({
    revoked: true, containersRemoved: true, nativeResourcesQuiescent: true, nativeRetained: 0 })
})

describe.skipIf(!real)('native operator interfaces with real Linux execution', () => {
  test('reconciles a private receipt while retaining historical unknown output and reservations', async () => {
    const ctx = await prepared(), executionRoot = join(ctx.stateRoot, 'linux-executions'); await mkdir(executionRoot, { mode: 0o700 })
    const intent = await prepareLinuxExecutionIntent({ stateRoot: executionRoot, contract: ctx.contract, job: {
      id: ctx.job.id, requestDigest: ctx.job.requestDigest, nativeResourceId: ctx.job.nativeResourceId!, nativeNonce: ctx.job.nativeNonce!, deadline: ctx.job.deadline } })
    let job = ctx.ledger.markLinuxCreateIntent(ctx.job.id, ctx.job.version, intent, ctx.authority)
    job = ctx.ledger.markDispatched(job.id, job.version, ctx.authority)
    const result = await runLinuxExecution({ stateRoot: executionRoot, contract: ctx.contract, intent, argv: ['/bin/sh', '-c', 'printf once'], files: [],
      signal: new AbortController().signal,
      recordResources: async resources => { job = ctx.ledger.recordLinuxResources(job.id, job.version, resources, ctx.authority) },
      authorizeStart: () => { job = ctx.ledger.start(job.id, job.version, ctx.authority); return true } })
    expect(result.receipt?.result.stdout).toBe('once')
    const unknown = { jobId: job.id, status: 'unknown' as const, quiescent: false, stdout: 'keep original', stderr: '', artifacts: [], reason: 'lost settlement' }
    ctx.ledger.settle(job.id, job.version, unknown, ctx.authority); ctx.ledger.releaseController(ctx.authority)
    expect(await reconcileIsolation(ctx.stateRoot, 'no-docker', new AbortController().signal, 'not-a-socket')).toEqual({ checked: 1, released: 1, retained: 0 })
    expect(ctx.ledger.get(job.id)?.result).toEqual({ ...unknown, quiescent: true })
    expect(ctx.ledger.get(job.id)?.reservedDurationMs).toBe(5000)
  })

  test('external revocation makes the active native owner stop without stealing its controller', async () => {
    const base = await root(); await chmod(base, 0o755)
    const native = await linuxRuntimeFixture(base), stateRoot = join(base, 'state')
    const runner = new LinuxVerifierRunner({ backend: 'linux-native', ...native, stateRoot, authorityDigest: 'a'.repeat(64),
      command: '/bin/sh /workspace/artifact', expiresAt: Date.now() + 60_000, maxRuns: 1, maxTotalDurationMs: 10_000,
      maxDurationMs: 10_000, maxOutputBytes: 4096, limits: { memoryMiB: 128, workspaceMiB: 4, workspaceInodes: 256 } })
    try {
      const pending = runner.run('running', 'sleep 30\n', '', new AbortController().signal)
      const database = new DatabaseSync(join(stateRoot, 'ledger.sqlite'), { readOnly: true })
      try {
        await expect.poll(() => database.prepare('SELECT status FROM isolation_jobs').get()?.status, { timeout: 8000 }).toBe('running')
        const controller = database.prepare('SELECT owner_id, fence FROM isolation_controller').get()
        const revoked = await revokeIsolationGrant(stateRoot, 'verification', 1, 'no-docker', 'not-a-socket')
        expect(revoked.revoked).toBe(true)
        expect(database.prepare('SELECT owner_id, fence FROM isolation_controller').get()).toEqual(controller)
        const result = await pending
        expect(result).toMatchObject({ status: 'cancelled', quiescent: true })
        expect(JSON.parse(String(database.prepare('SELECT result_json FROM isolation_jobs').get()?.result_json))).toEqual(result)
      } finally { database.close() }
    } finally { await runner.close() }
  })

  test('native readiness checks the pinned executable and canary artifact through API and packaged CLI', async () => {
    const base = await root(); await chmod(base, 0o755)
    const native = await linuxRuntimeFixture(base)
    expect(await probeLinuxIsolationRuntime(native)).toEqual({ ready: true })
    const path = join(base, 'probe.json'); await writeFile(path, JSON.stringify(native), { mode: 0o600 })
    const { stdout } = await promisify(execFile)(process.execPath,
      [fileURLToPath(new URL('../lib/cli.js', import.meta.url)), 'probe-native', path],
      { timeout: 30_000, maxBuffer: 32_768, env: { PATH: '/nonexistent', LANG: 'C' } })
    expect(JSON.parse(stdout)).toEqual({ ready: true })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(native)
  }, 40_000)
})
