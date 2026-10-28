// Admission/SQLite control-flow tests only. Runtime validation is a controlled
// seam; no candidate process or successful kernel isolation is simulated.
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { LinuxRepositoryRunner, type LinuxRepositoryRunnerConfig } from '../src/linux-repository-runner.js'
import { consumeLinuxRepositoryAdmissionRefusal } from '../src/linux-repository-admission.js'
import { IsolationLedger, type IsolationControllerAuthority } from '../src/ledger.js'
import { linuxJobResourceReservation, type LinuxRepositoryExecutionContract } from '../src/linux-execution-contract.js'
import { linuxRuntimeDigest } from '../src/linux-runtime.js'
import { linuxRuntimeFixture } from './helpers/linux-runtime-fixture.js'

const seam = vi.hoisted(() => ({ verify: async (): Promise<void> => { throw new Error('injected runtime admission rejection') }, full: false }))
vi.mock('../src/linux-runtime.js', async original => ({ ...await original<typeof import('../src/linux-runtime.js')>(), verifyLinuxRuntime: () => seam.verify() }))
vi.mock('../src/storage.js', async original => {
  const actual = await original<typeof import('../src/storage.js')>()
  return { ...actual, observeStorage: async (...args: Parameters<typeof actual.observeStorage>) => seam.full
    ? { bytes: 1024 ** 3, observedAt: Date.now() } : actual.observeStorage(...args) }
})
const roots: string[] = [], runners: LinuxRepositoryRunner[] = []
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  seam.verify = async () => { throw new Error('injected runtime admission rejection') }; seam.full = false; vi.restoreAllMocks()
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'linux-admission-')); roots.push(root)
  const { runtime, cgroupRoots } = await linuxRuntimeFixture(root)
  const input: LinuxRepositoryRunnerConfig = { backend: 'linux-native', runtime, cgroupRoots, stateRoot: join(root, 'state'),
    authorityDigest: 'a'.repeat(64), expiresAt: Date.now() + 60000, maxRuns: 1, maxTotalDurationMs: 5000,
    limits: { maxDurationMs: 5000, maxInputBytes: 64 * 1024 ** 2, maxOutputBytes: 4096, maxArtifactBytes: 4096, maxFiles: 8,
      memoryMiB: 128, workspaceMiB: 4, workspaceInodes: 256, tmpMiB: 4, tmpInodes: 128,
      inputMiB: 65, inputInodes: 16, pidsLimit: 32, cpus: 0.5 } }
  const runner = new LinuxRepositoryRunner(input); runners.push(runner)
  await runner.inspectQuiescence('ready')
  const request = { argv: ['/bin/true'], archive: { bytes: 1, sha256: createHash('sha256').update('x').digest('hex') }, artifacts: [] }
  const load = vi.fn(async () => Buffer.from('x'))
  const run = () => runner.run('key', request, load, new AbortController().signal)
  return { root, input, runner, request, load, run }
}
async function rejection(operation: Promise<unknown>): Promise<unknown> { try { await operation } catch (error) { return error }; throw new Error('expected refusal') }
function authority(input: LinuxRepositoryRunnerConfig): IsolationControllerAuthority {
  const db = new DatabaseSync(join(input.stateRoot, 'ledger.sqlite'))
  try { const row = db.prepare('SELECT owner_id,fence FROM isolation_controller').get()!; return { ownerId: String(row.owner_id), fence: Number(row.fence) } }
  finally { db.close() }
}

describe.runIf(process.platform === 'linux' && !!process.getuid?.())('Linux call-specific admission refusal', () => {
  test('binds one-use proof to its runner/request/key and leaves historical missing state unknown', async () => {
    const f = await fixture(), error = await rejection(f.run())
    expect(consumeLinuxRepositoryAdmissionRefusal(new Error('injected runtime admission rejection'), f.runner, 'key', f.request)).toBe(false)
    expect(consumeLinuxRepositoryAdmissionRefusal(error, {}, 'key', f.request)).toBe(false)
    expect(consumeLinuxRepositoryAdmissionRefusal(error, f.runner, 'other', f.request)).toBe(false)
    expect(consumeLinuxRepositoryAdmissionRefusal(error, f.runner, 'key', { ...f.request, argv: ['/bin/false'] })).toBe(false)
    expect(consumeLinuxRepositoryAdmissionRefusal(error, f.runner, 'key', f.request)).toBe(true)
    expect(consumeLinuxRepositoryAdmissionRefusal(error, f.runner, 'key', f.request)).toBe(false)
    expect(await f.runner.inspectQuiescence('key')).toBe('unknown')
    expect(f.load).not.toHaveBeenCalled()
  })

  test.each(['budget', 'storage'] as const)('a rolled-back %s refusal never calls the archive factory or consumes another run', async kind => {
    const f = await fixture(); seam.verify = async () => {}
    if (kind === 'storage') seam.full = true
    else {
      const ledger = new IsolationLedger(join(f.input.stateRoot, 'ledger.sqlite')), auth = authority(f.input)
      const contract: LinuxRepositoryExecutionContract = { schemaVersion: 2, backend: 'linux-native', profile: 'repository',
        runtimeDigest: linuxRuntimeDigest(f.input.runtime), limits: f.input.limits, cgroupRoots: f.input.cgroupRoots,
        keeperLimits: { memoryMiB: 256, pidsLimit: 64, cpus: 0.5 } }
      const reservation = linuxJobResourceReservation(contract)
      try {
        const job = ledger.prepare({ identity: { principalDigest: f.input.authorityDigest, principalRecordId: `repository:${f.input.authorityDigest}`,
          principalVersion: 1, workspace: f.input.stateRoot, agentPreset: 'repository' }, sessionId: `authority:${f.input.authorityDigest}`,
          grantId: 'repository', idempotencyKey: 'spent', requestDigest: 'b'.repeat(64), durationMs: 5000, authority: auth,
          backend: 'linux-native', linuxContract: contract, resourceReservation: { memoryMiB: reservation.memoryMiB, workspaceInodes: reservation.workspaceInodes,
            maxMemoryMiB: 32768, maxWorkspaceInodes: 3000000 }, storageBudget: { reservedBytes: reservation.storageBytes,
            maxStateBytes: 1024 ** 3, maxJobRecords: 10000, observation: { bytes: 0, observedAt: Date.now() } } }).job
        ledger.settle(job.id, job.version, { jobId: job.id, status: 'failed', quiescent: true, stdout: '', stderr: '', artifacts: [] }, auth)
      } finally { ledger.close() }
    }
    const error = await rejection(f.run())
    expect(consumeLinuxRepositoryAdmissionRefusal(error, f.runner, 'key', f.request)).toBe(true)
    expect(f.load).not.toHaveBeenCalled()
    const db = new DatabaseSync(join(f.input.stateRoot, 'ledger.sqlite'))
    try { expect(db.prepare('SELECT COUNT(*) AS n FROM isolation_jobs').get()?.n).toBe(kind === 'budget' ? 1 : 0) } finally { db.close() }
  })

  test('tracks same-key verification before admission and invalidates older call proofs', async () => {
    const f = await fixture(), releases: Array<() => void> = []
    seam.verify = () => new Promise<void>((_resolve, reject) => { releases.push(() => reject(new Error('held runtime rejected'))) })
    const first = rejection(f.run()), second = rejection(f.run())
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    expect(await f.runner.inspectQuiescence('key')).toBe('unknown')
    releases[0]!(); const older = await first
    expect(consumeLinuxRepositoryAdmissionRefusal(older, f.runner, 'key', f.request)).toBe(false)
    releases[1]!(); const latest = await second
    const again = rejection(f.run()); await vi.waitFor(() => expect(releases).toHaveLength(3)); releases[2]!(); const newest = await again
    expect(consumeLinuxRepositoryAdmissionRefusal(latest, f.runner, 'key', f.request)).toBe(false)
    expect(consumeLinuxRepositoryAdmissionRefusal(newest, f.runner, 'key', f.request)).toBe(true)
    expect(f.load).not.toHaveBeenCalled()
  })

  test.each(['root', 'database', 'fence'] as const)('%s replacement prevents minting or consuming a stale connection proof', async kind => {
    const f = await fixture()
    let release!: () => void
    seam.verify = () => new Promise<void>((_resolve, reject) => { release = () => reject(new Error('held runtime rejected')) })
    const operation = rejection(f.run()); await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const dbPath = join(f.input.stateRoot, 'ledger.sqlite')
    if (kind === 'root') { await rename(f.input.stateRoot, f.input.stateRoot + '.old'); await mkdir(f.input.stateRoot, { mode: 0o700 }) }
    if (kind === 'database') { await rename(dbPath, dbPath + '.old'); await writeFile(dbPath, '', { mode: 0o600 }) }
    if (kind === 'fence') {
      const db = new DatabaseSync(dbPath)
      try { db.prepare('UPDATE isolation_controller SET fence=fence+1').run() } finally { db.close() }
    }
    release(); const error = await operation
    expect(consumeLinuxRepositoryAdmissionRefusal(error, f.runner, 'key', f.request)).toBe(false)
    expect(f.load).not.toHaveBeenCalled()
    if (kind === 'root') { await rm(f.input.stateRoot, { recursive: true }); await rename(f.input.stateRoot + '.old', f.input.stateRoot) }
    if (kind === 'database') { await rm(dbPath); await rename(dbPath + '.old', dbPath) }
  })

  test('rechecks database identity and controller after the refusal was returned', async () => {
    const f = await fixture(), error = await rejection(f.run()), dbPath = join(f.input.stateRoot, 'ledger.sqlite')
    await rename(dbPath, dbPath + '.old'); await writeFile(dbPath, '', { mode: 0o600 })
    expect(consumeLinuxRepositoryAdmissionRefusal(error, f.runner, 'key', f.request)).toBe(false)
    await rm(dbPath); await rename(dbPath + '.old', dbPath)
    const db = new DatabaseSync(dbPath)
    try { db.prepare('UPDATE isolation_controller SET fence=fence+1').run() } finally { db.close() }
    expect(consumeLinuxRepositoryAdmissionRefusal(error, f.runner, 'key', f.request)).toBe(false)
  })
})
