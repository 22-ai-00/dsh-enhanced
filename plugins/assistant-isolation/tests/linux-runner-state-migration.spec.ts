import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { defaultLimits } from '../src/config.js'
import { inspectIsolationGrant } from '../src/diagnostics.js'
import { grantDigest, IsolationLedger } from '../src/ledger.js'
import { migrateLinuxVerifierRunnerState, prepareLinuxRepositoryHandoverState } from '../src/linux-runner-state-migration.js'
import { inspectLinuxRunnerState } from '../src/linux-runner-state.js'
import { LinuxRepositoryRunner } from '../src/linux-repository-runner.js'
import type { LinuxRuntime } from '../src/linux-runtime.js'
import { LinuxVerifierRunner } from '../src/linux-verifier-runner.js'
import type { CreationWitness } from '../src/runtime-witness.js'
import type { IsolationGrant } from '../src/types.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const oldDigest = 'a'.repeat(64), newDigest = 'b'.repeat(64)
// Far-future fixed instant: historical settlement timestamps stay deterministic
// while the rewritten grant is genuinely live under the runner's real clock.
const expiresAt = 4_000_000_000_000
const requestFor = (key: string): string => createHash('sha256').update(key).digest('hex')
const boot = '11111111-1111-1111-1111-111111111111'
const witness: CreationWitness = {
  daemon: { process: { bootId: boot, pid: 4242, startTicks: '100' }, engineId: 'engine:1',
    dockerPath: '/usr/bin/docker', socketPath: '/run/docker.sock', pidFile: '/run/docker.pid' },
  supervisor: { bootId: boot, pid: 4343, startTicks: '200' },
}

function tree(name = 'creation-review-runner') {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-handover-')); roots.push(parent)
  chmodSync(parent, 0o700)
  const liveHome = join(parent, 'live-home'), stageHome = join(parent, 'stage-home'), backupHome = join(parent, 'original-home')
  const liveState = join(liveHome, 'state'), stageState = join(stageHome, 'state')
  const liveRunner = join(liveState, name), stageRunner = join(stageState, name)
  const liveSeal = join(liveState, 'native-runner-states', `${name}.json`)
  const stageSeal = join(stageState, 'native-runner-states', `${name}.json`)
  mkdirSync(liveRunner, { recursive: true, mode: 0o700 }); chmodSync(liveRunner, 0o700); chmodSync(liveState, 0o700); chmodSync(liveHome, 0o700)
  return { parent, liveHome, stageHome, backupHome, liveState, stageState, liveRunner, stageRunner, liveSeal, stageSeal,
    ledgerPath: join(liveRunner, 'ledger.sqlite') }
}
function snapshot(path: string): unknown[] {
  const rows: unknown[] = []
  const visit = (path: string): void => {
    const info = lstatSync(path, { bigint: true })
    rows.push([path, String(info.dev), String(info.ino), String(info.mode), String(info.size), String(info.mtimeNs), String(info.ctimeNs), info.isFile() ? readFileSync(path) : undefined])
    if (info.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name))
  }
  visit(path); return rows
}
/** Ledger bytes and inode only: opening a WAL database churns parent directory
 * metadata even when every transaction rolls back. */
function ledgerFingerprint(path: string): { ino: number; bytes: Buffer } {
  const info = lstatSync(path)
  return { ino: info.ino, bytes: readFileSync(path) }
}
/** A live read-only WAL reader. immutable=1 never sees committed -wal frames,
 * which hides the runner's controller claim while it is running. */
function readonlyDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA query_only=ON')
  return db
}

/** Copy the live tree into staging and force the whole private chain (cpSync
 * creates intermediate directories with environment-derived modes). */
function stageCopy(t: ReturnType<typeof tree>): void {
  cpSync(t.liveState, t.stageState, { recursive: true, preserveTimestamps: true })
  chmodSync(t.stageHome, 0o700); chmodSync(t.stageState, 0o700); chmodSync(t.stageRunner, 0o700)
  chmodSync(join(t.stageRunner, 'ledger.sqlite'), 0o600)
}

/** Job ids by role; indexed access is unchecked, so the fixture names every
 * row it creates instead of returning a loose record. */
type JobIds = { prepared: string; dispatched: string; running: string; succeeded: string; failed: string; unknown: string; macos: string }

/** A docker-era verifier ledger: mixed docker/macOS history including stranded
 * prepared/running work and a witness-bearing dispatched unknown row. */
function dockerLedger(path: string, workspace: string): { ids: JobIds } {
  const ledger = new IsolationLedger(path, { now: () => 10_000 })
  const identity = { principalDigest: oldDigest, principalRecordId: `verification:${oldDigest}`,
    principalVersion: 1, workspace, agentPreset: 'verification' as const }
  const ids: Record<string, string> = {}
  try {
    ledger.syncGrants([{ ...identity, id: 'verification', revision: 1, expiresAt: 100_000, maxRuns: 8, maxTotalDurationMs: 10_000 }])
    const authority = ledger.claimController('old-host-process', 1_000)
    const prepare = (key: string, durationMs: number, backend: 'docker' | 'macos-seatbelt' = 'docker') =>
      ledger.prepare({ identity, sessionId: `authority:${oldDigest}`, grantId: 'verification', idempotencyKey: key,
        requestDigest: requestFor(key), durationMs, backend }).job
    ids.prepared = prepare('prepared-key', 500).id
    const dispatched = prepare('dispatched-key', 600)
    ledger.markDispatched(dispatched.id, dispatched.version, authority)
    ledger.settle(dispatched.id, dispatched.version + 1,
      { jobId: dispatched.id, status: 'unknown', quiescent: false, stdout: '', stderr: '', artifacts: [] }, authority, witness)
    ids.dispatched = dispatched.id
    const running = prepare('running-key', 700)
    ledger.start(running.id, running.version)
    ids.running = running.id
    const succeeded = prepare('succeeded-key', 800)
    ledger.start(succeeded.id, succeeded.version)
    ledger.settle(succeeded.id, succeeded.version + 1,
      { jobId: succeeded.id, status: 'succeeded', quiescent: true, exitCode: 0, stdout: '', stderr: '', artifacts: [] })
    ids.succeeded = succeeded.id
    const failed = prepare('failed-key', 400)
    ledger.start(failed.id, failed.version)
    ledger.settle(failed.id, failed.version + 1,
      { jobId: failed.id, status: 'failed', quiescent: true, exitCode: 1, stdout: '', stderr: '', artifacts: [] })
    ids.failed = failed.id
    const unknown = prepare('unknown-key', 500)
    ledger.settle(unknown.id, unknown.version,
      { jobId: unknown.id, status: 'unknown', quiescent: false, stdout: '', stderr: '', artifacts: [], reason: 'docker-creation-unconfirmed' })
    ids.unknown = unknown.id
    const macos = prepare('macos-key', 500, 'macos-seatbelt')
    ledger.settle(macos.id, macos.version,
      { jobId: macos.id, status: 'unknown', quiescent: false, stdout: '', stderr: '', artifacts: [] })
    ids.macos = macos.id
    return { ids: ids as JobIds }
  } finally { ledger.close() }
}

function runtime(parent: string): LinuxRuntime {
  const root = join(parent, 'runtime')
  return { schemaVersion: 1, backend: 'linux-native', platform: `linux-${process.arch}` as LinuxRuntime['platform'],
    sourceCommit: 'a'.repeat(40), lockSha256: 'b'.repeat(64), root: { path: root, dev: 1, ino: 2, sha256: 'c'.repeat(64) },
    nodePath: join(root, 'bin/node'), nodeSha256: 'd'.repeat(64), pnpmPath: join(root, 'pnpm/bin/pnpm.mjs'),
    nativePnpmPath: join(root, 'pnpm-native/pnpm'), nativePnpmRoot: join(root, 'pnpm-native'),
    modulesPath: join(root, 'node_modules'), storePath: join(root, 'store'), cachePath: join(root, 'cache'),
    versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '1', cordis: '1', tools: '1', systemPrompt: '1' } }
}
function cgroups() {
  const leaf = (controller: string): string => `/sys/fs/cgroup/${controller}/dsh-native/uid-${process.getuid!()}`
  return { mode: 'v1' as const, cpu: leaf('cpu,cpuacct'), memory: leaf('memory'), pids: leaf('pids'), freezer: leaf('freezer') }
}
/** Ready proof that does not call run(): the runner's fake runtime cannot pass
 * full verification, but claiming the stale docker lease (fence + 1) proves it
 * passed every seal, grant and recovery gate. */
async function waitForLeaseSeizure(path: string): Promise<void> {
  await vi.waitFor(() => {
    const db = readonlyDb(path)
    try {
      const row = db.prepare('SELECT owner_id, fence, expires_at FROM isolation_controller').get() as
        { owner_id: string; fence: number; expires_at: number } | undefined
      expect(row).toBeTruthy()
      expect(row!.owner_id).not.toBe('old-host-process')
      expect(row!.fence).toBe(2)
      expect(row!.expires_at).toBeGreaterThan(1_000_000_000_000)
    } finally { db.close() }
  }, { timeout: 10_000, interval: 25 })
}
async function waitForControllerClaim(path: string): Promise<void> {
  await vi.waitFor(() => {
    const db = readonlyDb(path)
    try {
      const row = db.prepare('SELECT expires_at FROM isolation_controller').get() as { expires_at: number } | undefined
      expect(row?.expires_at).toBeGreaterThan(1_000_000_000_000)
    } finally { db.close() }
  }, { timeout: 10_000, interval: 25 })
}
const handoverInput = (t: ReturnType<typeof tree>) => ({
  name: 'creation-review-runner', stageStateRoot: t.stageRunner, stageSealPath: t.stageSeal,
  liveStateRoot: t.liveRunner, liveSealPath: t.liveSeal,
  oldAuthorityDigest: oldDigest, newAuthorityDigest: newDigest,
  expiresAt, maxRuns: 16, maxTotalDurationMs: 20_000, now: 20_000,
})
const nextGrant = (t: ReturnType<typeof tree>): IsolationGrant => ({
  principalDigest: newDigest, principalRecordId: `verification:${newDigest}`, principalVersion: 1,
  workspace: t.liveRunner, agentPreset: 'verification', id: 'verification', revision: 1,
  expiresAt, maxRuns: 16, maxTotalDurationMs: 20_000,
})

describe.runIf(process.platform === 'linux' && (process.getuid?.() ?? 0) > 0)('authorized docker->linux runner ledger handover', () => {
  test('migrates identities, accounting and unresolved work, reseals the staging copy, and survives the atomic cutover', async () => {
    const t = tree(), { ids } = dockerLedger(t.ledgerPath, t.liveRunner)
    stageCopy(t)
    const stageLedgerBefore = snapshot(t.stageRunner)
    const stageLedgerInode = lstatSync(join(t.stageRunner, 'ledger.sqlite')).ino

    const result = migrateLinuxVerifierRunnerState(handoverInput(t))
    expect(result.jobsMigrated).toBe(7)
    expect(result.activeSettled).toBe(2)
    expect(result.seal).toEqual({ path: t.liveSeal, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    // The new seal binds logical live paths; inspecting at physical staging paths fails.
    expect(() => inspectLinuxRunnerState({ stateRoot: t.stageRunner, stateSeal: result.seal, kind: 'verification' })).toThrow()
    expect(readdirSync(t.stageRunner).sort()).toEqual(['ledger.sqlite'])
    expect(snapshot(t.stageRunner)).not.toEqual(stageLedgerBefore)

    const staged = readonlyDb(join(t.stageRunner, 'ledger.sqlite'))
    try {
      expect(staged.prepare('PRAGMA user_version').get()?.user_version).toBe(9)
      expect(staged.prepare("SELECT value FROM schema_meta WHERE key='schema-version'").get()?.value).toBe('9')
      const grant = staged.prepare('SELECT * FROM isolation_grants WHERE id=?').get('verification') as Record<string, unknown>
      expect(grant).toMatchObject({ digest: grantDigest(nextGrant(t)), revision: 1, expires_at: expiresAt,
        max_runs: 16, max_total_duration_ms: 20_000, revoked: 0, revoke_reason: null,
        principal_digest: newDigest, principal_record_id: `verification:${newDigest}`,
        principal_version: 1, workspace: t.liveRunner, agent_preset: 'verification' })
      const rows = staged.prepare('SELECT id, backend_kind, status, migrated, principal_digest, dispatch_attempted, creation_witness_json, version, updated_at, result_json FROM isolation_jobs ORDER BY id').all() as Array<Record<string, unknown>>
      expect(rows).toHaveLength(7)
      expect(rows.every(row => row.migrated === 1 && row.principal_digest === oldDigest)).toBe(true)
      const byId = (id: string) => rows.find(row => row.id === id)!
      const noReplay = { status: 'unknown', quiescent: false, stdout: '', stderr: '', artifacts: [], reason: 'verification-recovery-no-replay' }
      // Never dispatched: version 1 -> 2.
      expect(byId(ids.prepared)).toMatchObject({ status: 'unknown', dispatch_attempted: 0, creation_witness_json: null, version: 2, updated_at: 20_000 })
      expect(JSON.parse(String(byId(ids.prepared).result_json))).toEqual({ jobId: ids.prepared, ...noReplay })
      // start() already moved version 1 -> 2 and set dispatch_attempted=1; settlement takes it to 3.
      expect(byId(ids.running)).toMatchObject({ status: 'unknown', dispatch_attempted: 1, creation_witness_json: null, version: 3, updated_at: 20_000 })
      expect(JSON.parse(String(byId(ids.running).result_json))).toEqual({ jobId: ids.running, ...noReplay })
      // Terminal rows are byte-preserved, witness included on the dispatched unknown row (version 3).
      const dispatched = byId(ids.dispatched)
      expect(dispatched).toMatchObject({ status: 'unknown', dispatch_attempted: 1, version: 3 })
      expect(JSON.parse(String(dispatched.creation_witness_json))).toEqual(witness)
      expect(byId(ids.succeeded)).toMatchObject({ status: 'succeeded' })
      expect(byId(ids.failed)).toMatchObject({ status: 'failed' })
      const audit = staged.prepare('SELECT action, COUNT(*) AS n FROM isolation_audit GROUP BY action ORDER BY action').all() as Array<{ action: string; n: number }>
      expect(audit).toEqual(expect.arrayContaining([
        { action: 'backend-handover', n: 1 },
        { action: 'backend-handover-controller-retired', n: 1 },
        { action: 'backend-handover-witness-retired', n: 2 },
      ]))
      // The Docker-era lease is expired in place, so the native owner's first
      // claim fences forward without waiting out the old wall-clock TTL.
      expect(staged.prepare('SELECT owner_id, expires_at FROM isolation_controller WHERE singleton=1').get())
        .toEqual({ owner_id: 'old-host-process', expires_at: 20_000 })
      expect(JSON.parse(String(staged.prepare("SELECT detail FROM isolation_audit WHERE action='backend-handover-controller-retired'").get()?.detail)))
        .toEqual({ leasesRetired: 1 })
      const summary = JSON.parse(String(staged.prepare("SELECT detail FROM isolation_audit WHERE action='backend-handover'").get()?.detail))
      expect(summary).toMatchObject({ name: 'creation-review-runner', from: ['docker', 'macos-seatbelt'], to: 'linux-native',
        jobs: 7, active: 2, fromAuthority: oldDigest, toAuthority: newDigest })
      const retired = staged.prepare("SELECT detail FROM isolation_audit WHERE action='backend-handover-witness-retired'").all() as Array<{ detail: string }>
      expect(retired).toHaveLength(2)
      expect(retired.map(item => JSON.parse(item.detail))).toEqual(expect.arrayContaining([
        expect.objectContaining({ backend: 'docker', dispatchAttempted: 0, witnessSha256: null }),
        expect.objectContaining({ backend: 'docker', dispatchAttempted: 1, witnessSha256: null }),
      ]))
    } finally { staged.close() }

    // Same-filesystem cutover (live aside, stage into place) preserves inodes.
    mkdirSync(t.backupHome, { mode: 0o700 })
    renameSync(t.liveHome, join(t.backupHome, 'home'))
    renameSync(t.stageHome, t.liveHome)
    expect(lstatSync(join(t.liveRunner, 'ledger.sqlite')).ino).toBe(stageLedgerInode)
    inspectLinuxRunnerState({ stateRoot: t.liveRunner, stateSeal: result.seal, kind: 'verification' })

    // The native runner seizes the stale docker lease, syncs its literal grant
    // as a no-op and recovers nothing from the migrated history.
    const common = { backend: 'linux-native' as const, stateRoot: t.liveRunner, stateSeal: result.seal,
      authorityDigest: newDigest, expiresAt, maxRuns: 16, maxTotalDurationMs: 20_000,
      runtime: runtime(t.parent), cgroupRoots: cgroups() }
    const runner = new LinuxVerifierRunner({ ...common, command: '/bin/true', maxDurationMs: 5_000, maxOutputBytes: 4_096 })
    try {
      await waitForLeaseSeizure(join(t.liveRunner, 'ledger.sqlite'))
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
    } finally { await runner.close() }
    const db = readonlyDb(join(t.liveRunner, 'ledger.sqlite'))
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM isolation_jobs WHERE migrated=0').get()?.n).toBe(0)
      expect(db.prepare('SELECT digest FROM isolation_grants WHERE id=?').get('verification')?.digest).toBe(grantDigest(nextGrant(t)))
      // One grant sync from the docker fixture; the runner's sync was a byte no-op.
      expect(db.prepare("SELECT COUNT(*) AS n FROM isolation_audit WHERE action='grant-synced'").get()?.n).toBe(1)
      // Five API settlements in the fixture; the handover settled active rows via raw SQL.
      expect(db.prepare("SELECT COUNT(*) AS n FROM isolation_audit WHERE action='job-settled'").get()?.n).toBe(5)
      // Recovery wrote nothing against the migrated rows.
      expect(db.prepare("SELECT COUNT(*) AS n FROM isolation_audit WHERE action LIKE 'backend-handover%'").get()?.n).toBe(4)
      expect(db.prepare("SELECT detail FROM isolation_audit WHERE action='controller-claimed' ORDER BY detail").all())
        .toEqual([{ detail: 'fence:1' }, { detail: 'fence:2' }])
    } finally { db.close() }

    // Accounting continuity: migrated runs still spend the grant; old identity
    // rows are read back idempotently but never replayed.
    const ledger = new IsolationLedger(join(t.liveRunner, 'ledger.sqlite'), { now: () => 30_000 })
    try {
      expect(ledger.recoverable()).toEqual([])
      ledger.syncGrants([nextGrant(t)])
      const diagnostic = inspectIsolationGrant({ stateRoot: t.liveRunner, grant: nextGrant(t), now: 30_000 })
      expect(diagnostic).toMatchObject({ status: 'available', runsUsed: 7, durationReservedMs: 4_000,
        unknownJobs: 5, activeJobs: 5, remainingRuns: 9, remainingDurationMs: 16_000 })
      const newIdentity = { principalDigest: newDigest, principalRecordId: `verification:${newDigest}`,
        principalVersion: 1, workspace: t.liveRunner, agentPreset: 'verification' as const }
      const oldIdentity = { principalDigest: oldDigest, principalRecordId: `verification:${oldDigest}`,
        principalVersion: 1, workspace: t.liveRunner, agentPreset: 'verification' as const }
      const first = ledger.prepare({ identity: newIdentity, sessionId: `authority:${newDigest}`, grantId: 'verification',
        idempotencyKey: 'prepared-key', requestDigest: requestFor('native-request-1'), durationMs: 500 })
      expect(first.created).toBe(true)
      expect(ledger.prepare({ identity: newIdentity, sessionId: `authority:${newDigest}`, grantId: 'verification',
        idempotencyKey: 'prepared-key', requestDigest: requestFor('native-request-1'), durationMs: 500 }).created).toBe(false)
      // Same eight-tuple + request as the stranded docker row: read back, no
      // grant lookup, no replay, no error even though the old grant is rewritten.
      const replayed = ledger.prepare({ identity: oldIdentity, sessionId: `authority:${oldDigest}`, grantId: 'verification',
        idempotencyKey: 'prepared-key', requestDigest: requestFor('prepared-key'), durationMs: 500 })
      expect(replayed.created).toBe(false)
      expect(replayed.job).toMatchObject({ id: ids.prepared, status: 'unknown', backend: 'docker' })
    } finally { ledger.close() }

    // Rollback evidence: the untouched live ledger remains under the backup home.
    const backup = readonlyDb(join(t.backupHome, 'home', 'state', 'creation-review-runner', 'ledger.sqlite'))
    try {
      expect(backup.prepare('SELECT COUNT(*) AS n FROM isolation_jobs WHERE migrated=1').get()?.n).toBe(0)
      expect(backup.prepare('SELECT principal_digest FROM isolation_grants WHERE id=?').get('verification')?.principal_digest).toBe(oldDigest)
    } finally { backup.close() }
  }, 30_000)

  test('refuses wrong live authority and a ledger that already ran natively without touching the staged bytes', () => {
    const t = tree(); dockerLedger(t.ledgerPath, t.liveRunner)
    stageCopy(t)
    const before = ledgerFingerprint(join(t.stageRunner, 'ledger.sqlite'))
    expect(() => migrateLinuxVerifierRunnerState({ ...handoverInput(t), oldAuthorityDigest: 'c'.repeat(64) })).toThrow(/live authority/u)
    expect(ledgerFingerprint(join(t.stageRunner, 'ledger.sqlite'))).toEqual(before)
    expect(existsSync(t.stageSeal)).toBe(false)
    expect(existsSync(join(t.stageState, 'native-runner-states'))).toBe(false)

    // A pre-existing linux-native row makes the handover ambiguous; nothing is published.
    const nativeDb = new DatabaseSync(join(t.stageRunner, 'ledger.sqlite'))
    nativeDb.prepare("INSERT INTO isolation_jobs(id,grant_id,grant_revision,principal_digest,principal_record_id,principal_version,workspace,agent_preset,session_id,idempotency_key,request_digest,container_name,backend_kind,native_resource_id,native_nonce,deadline,reserved_duration_ms,reserved_memory_mib,reserved_workspace_inodes,reserved_storage_bytes,linux_contract_json,status,version,created_at,updated_at) VALUES ('native-job','verification',1,?,?,1,?,'verification',?,?,?,NULL,'linux-native',?,?,50_000,500,128,512,1024,'{}','prepared',1,10_000,10_000)")
      .run(oldDigest, `verification:${oldDigest}`, t.liveRunner, `authority:${oldDigest}`, 'native-key',
        'd'.repeat(64), 'linux-native-job', '0'.repeat(32))
    nativeDb.close(); chmodSync(join(t.stageRunner, 'ledger.sqlite'), 0o600)
    expect(() => migrateLinuxVerifierRunnerState(handoverInput(t))).toThrow(/already contains linux-native/u)
    expect(existsSync(t.stageSeal)).toBe(false)
  })

  test('rejects a repeated or partially applied handover', () => {
    const t = tree(); dockerLedger(t.ledgerPath, t.liveRunner)
    stageCopy(t)
    const first = migrateLinuxVerifierRunnerState(handoverInput(t))
    expect(() => migrateLinuxVerifierRunnerState(handoverInput(t))).toThrow(/already handed over/u)
    // Even with the published seal removed and knowledge of the rewritten grant,
    // the all-migrated job set cannot be handed over twice.
    rmSync(t.stageSeal, { force: true })
    expect(() => migrateLinuxVerifierRunnerState({ ...handoverInput(t),
      oldAuthorityDigest: newDigest, newAuthorityDigest: 'c'.repeat(64) })).toThrow(/already handed over/u)
    expect(first.seal.path).toBe(t.liveSeal)
  })

  test('fails closed on a missing staged ledger or equal authority digests', () => {
    const t = tree(); dockerLedger(t.ledgerPath, t.liveRunner)
    stageCopy(t)
    rmSync(join(t.stageRunner, 'ledger.sqlite'))
    expect(() => migrateLinuxVerifierRunnerState(handoverInput(t))).toThrow(/ledger is missing/u)
    expect(() => migrateLinuxVerifierRunnerState({ ...handoverInput(t), newAuthorityDigest: oldDigest })).toThrow(/invalid handover input/u)
  })

  test('repository handover is brand-new empty sealed state that the native repository runner can own after cutover', async () => {
    const t = tree('linux-source-build-runner')
    rmSync(t.liveRunner, { recursive: true, force: true })
    mkdirSync(join(t.stageHome, 'state'), { recursive: true, mode: 0o700 }); chmodSync(join(t.stageHome, 'state'), 0o700); chmodSync(t.stageHome, 0o700)
    const seal = prepareLinuxRepositoryHandoverState({ stageStateRoot: t.stageRunner, stageSealPath: t.stageSeal,
      liveStateRoot: t.liveRunner, liveSealPath: t.liveSeal })
    expect(seal).toEqual({ path: t.liveSeal, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(readdirSync(t.stageRunner).sort()).toEqual(['ledger.sqlite'])
    const db = readonlyDb(join(t.stageRunner, 'ledger.sqlite'))
    try {
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(9)
      for (const table of ['isolation_grants', 'isolation_jobs', 'isolation_controller', 'isolation_audit'])
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0)
    } finally { db.close() }

    mkdirSync(t.backupHome, { mode: 0o700 })
    renameSync(t.liveState, join(t.backupHome, 'state'))
    renameSync(t.stageState, t.liveState)
    inspectLinuxRunnerState({ stateRoot: t.liveRunner, stateSeal: seal, kind: 'repository' })
    const common = { backend: 'linux-native' as const, stateRoot: t.liveRunner, stateSeal: seal,
      authorityDigest: newDigest, expiresAt, maxRuns: 16, maxTotalDurationMs: 20_000,
      runtime: runtime(t.parent), cgroupRoots: cgroups() }
    const runner = new LinuxRepositoryRunner({ ...common, limits: { ...defaultLimits, maxDurationMs: 5_000,
      tmpMiB: 32, tmpInodes: 256, inputMiB: 65, inputInodes: 16 } })
    try {
      await waitForControllerClaim(join(t.liveRunner, 'ledger.sqlite'))
      await new Promise(resolve => setImmediate(resolve))
    } finally { await runner.close() }
  }, 30_000)
})
