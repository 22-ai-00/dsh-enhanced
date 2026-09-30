import { generateKeyPairSync } from 'node:crypto'
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import * as release from '../src/release.ts'
import { controlPlaneSchemaVersion, openControlPlaneDatabaseReadOnly } from '../src/sqlite.ts'
import { signSourceMaintenanceRecord, sourceMaintenanceDigest } from '../src/source-maintenance.ts'
import { ControlPlaneStore } from '../src/store.ts'
import { cleanupRuntimeEpochFixtures, createRuntimeEpochFixture } from './helpers/runtime-epoch.ts'
import { sourceBaselineRelease } from './helpers/source-baseline.ts'
import { fixture as releaseFixture } from './helpers/source-release-runner.ts'

vi.mock('../src/release.ts', async original => ({ ...await original<typeof release>(), invokeSourceReleaseAdapter: vi.fn() }))
const roots: string[] = []
afterEach(async () => {
  await cleanupRuntimeEpochFixtures()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function emptyLedger(name = 'control.sqlite') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-preflight-readonly-')))
  roots.push(root)
  const path = join(root, name), store = new ControlPlaneStore({ path })
  store.close()
  return { root, path }
}
async function ledgerBytes(path: string) {
  const names = (await readdir(dirname(path))).filter(name => name.startsWith(basename(path))).sort()
  return Promise.all(names.map(async name => {
    const file = join(dirname(path), name), stat = await lstat(file)
    return { name, bytes: await readFile(file), inode: stat.ino, mode: stat.mode, mtime: stat.mtimeMs }
  }))
}
async function readStopped<T>(path: string, read: (store: ControlPlaneStore) => T): Promise<T> {
  const before = await ledgerBytes(path)
  const store = new ControlPlaneStore({ path, readOnly: true })
  try { return read(store) }
  finally { store.close(); expect(await ledgerBytes(path)).toEqual(before) }
}
function mutate(path: string, update: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(path)
  try { update(db) } finally { db.close() }
}

test('reads a checkpointed WAL ledger with URI characters without creating sidecars or allowing writes', async () => {
  const { root, path } = await emptyLedger('control ?#%&.sqlite')
  await readStopped(path, store => {
    expect(store.readSourceMaintenanceState(root)).toEqual({ history: [], records: [] })
    expect(store.readSourceMaintenanceActivationState(root)).toEqual({ kind: 'none' })
    expect(() => store.recordGap({ idempotencyKey: 'read-only-write', capability: 'test', context: 'test',
      expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 0 })).toThrow(/readonly/iu)
  })
  expect(await readdir(root)).toEqual([basename(path)])
})

test('rejects missing paths without creating a directory or database', async () => {
  const { root } = await emptyLedger()
  const before = await readdir(root)
  expect(() => new ControlPlaneStore({ path: join(root, 'missing', 'control.sqlite'), readOnly: true }))
    .toThrow(expect.objectContaining({ code: 'missing' }))
  expect(() => openControlPlaneDatabaseReadOnly('control.sqlite')).toThrow(expect.objectContaining({ code: 'invalid-path' }))
  expect(await readdir(root)).toEqual(before)
})

test.each([0, 27, 28, 29, controlPlaneSchemaVersion + 1])('rejects schema %i without migrating, replacing rows or changing journal mode', async version => {
  const { path } = await emptyLedger()
  mutate(path, db => db.exec(`DROP TABLE source_maintenance; PRAGMA user_version=${version}`))
  const before = await ledgerBytes(path)
  expect(() => new ControlPlaneStore({ path, readOnly: true }))
    .toThrow(expect.objectContaining({ code: version > controlPlaneSchemaVersion ? 'schema-too-new' : 'schema-version' }))
  expect(await ledgerBytes(path)).toEqual(before)
})

test.each(['-wal', '-journal'])('rejects a nonempty %s before opening without changing any ledger bytes', async suffix => {
  const { path } = await emptyLedger()
  await writeFile(`${path}${suffix}`, 'uncheckpointed journal', { mode: 0o600 })
  const before = await ledgerBytes(path)
  expect(() => openControlPlaneDatabaseReadOnly(path)).toThrow(expect.objectContaining({ code: 'unsettled-journal' }))
  expect(await ledgerBytes(path)).toEqual(before)
})

test('rejects a real uncheckpointed WAL instead of reading its stale main database', async () => {
  const { path } = await emptyLedger()
  const writer = new DatabaseSync(path)
  try {
    writer.exec('PRAGMA user_version=27')
    await chmod(`${path}-wal`, 0o600); await chmod(`${path}-shm`, 0o600)
    const before = await ledgerBytes(path)
    expect(() => openControlPlaneDatabaseReadOnly(path)).toThrow(expect.objectContaining({ code: 'unsettled-journal' }))
    expect(await ledgerBytes(path)).toEqual(before)
  } finally { writer.close() }
})

test('rejects unsafe database and sidecar files without changing them', async () => {
  const { root, path } = await emptyLedger()
  await chmod(path, 0o644)
  expect(() => openControlPlaneDatabaseReadOnly(path)).toThrow(expect.objectContaining({ code: 'unsafe-file' }))
  await chmod(path, 0o600)
  const alias = join(root, 'alias.sqlite')
  await symlink(path, alias)
  expect(() => openControlPlaneDatabaseReadOnly(alias)).toThrow(expect.objectContaining({ code: 'unsafe-file' }))
  await symlink(path, `${path}-wal`)
  expect(() => openControlPlaneDatabaseReadOnly(path)).toThrow(expect.objectContaining({ code: 'unsafe-file' }))
  expect(await readFile(path)).toEqual(await readFile(alias))
})

test('reads completed release and signed maintenance rows together from a stopped ledger', async () => {
  const { root } = await emptyLedger()
  const repository = join(root, 'source'), f = await sourceBaselineRelease({ repository,
    baseCommit: '1'.repeat(40), mergeCommit: '2'.repeat(40) })
  const keys = generateKeyPairSync('ed25519')
  const record = signSourceMaintenanceRecord({ schemaVersion: 1, kind: 'dsh-source-maintenance', transactionId: 'readonly-history',
    installationId: f.trust.installationId, ledger: f.trust.ledger, repository,
    baseline: { ref: 'refs/dsh-source/repairs', remote: join(root, 'remote.git'), targetBranch: 'repairs', initialCommit: '1'.repeat(40) },
    sequence: 1, previousDigest: null, previousTip: '2'.repeat(40), candidateTip: '3'.repeat(40), upstreamCommit: '3'.repeat(40),
    sourceTree: '4'.repeat(40), preparationReceiptDigest: '5'.repeat(64), originalBootstrapDigest: '6'.repeat(64),
    before: { sourceCommit: '2'.repeat(40), version: '0.1.1', cohortDigest: '7'.repeat(64) },
    after: { sourceCommit: '3'.repeat(40), version: '0.1.2', cohortDigest: '8'.repeat(64) }, host: null,
    issuedAt: Date.now(), authority: 'host', keyId: 'host' }, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
  const expectedHistory = f.store.getSourceBaselineHistory(repository)
  f.close()
  mutate(f.trust.ledger.path, db => db.prepare('INSERT INTO source_maintenance VALUES (?,?,?,?,?,?)')
    .run(repository, 1, record.transactionId, null, JSON.stringify(record), sourceMaintenanceDigest(record)))
  await readStopped(f.trust.ledger.path, store => {
    expect(store.readSourceMaintenanceState(repository)).toEqual({ history: expectedHistory, records: [record] })
    expect(store.readSourceMaintenanceActivationState(f.root)).toEqual({ kind: 'none' })
  })
  // Exercise snapshot isolation through a real competing SQLite writer. This
  // uses the writable Store: immutable preflight readers forbid concurrent writers.
  const reader = new ControlPlaneStore({ path: f.trust.ledger.path })
  const writer = new DatabaseSync(f.trust.ledger.path), prepare = DatabaseSync.prototype.prepare
  const { signature: _signature, publicKeyPem: _publicKeyPem, ...unsigned } = record
  const second = signSourceMaintenanceRecord({ ...unsigned, transactionId: 'concurrent-history', sequence: 2,
    previousDigest: sourceMaintenanceDigest(record), previousTip: record.candidateTip, candidateTip: '9'.repeat(40),
    before: record.after, after: { ...record.after, sourceCommit: '9'.repeat(40), version: '0.1.3' } },
  keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
  let advanced = false
  const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql) {
    if (!advanced && sql.startsWith('SELECT sequence,host_plan_id')) {
      advanced = true
      prepare.call(writer, 'INSERT INTO source_maintenance VALUES (?,?,?,?,?,?)')
        .run(repository, 2, second.transactionId, null, JSON.stringify(second), sourceMaintenanceDigest(second))
    }
    return prepare.call(this, sql)
  })
  try {
    expect(reader.readSourceMaintenanceState(repository)).toEqual({ history: expectedHistory, records: [record] })
    expect(advanced).toBe(true)
    expect(reader.getSourceMaintenanceRecords(repository)).toEqual([record, second])
  } finally { spy.mockRestore(); writer.close(); reader.close() }
  mutate(f.trust.ledger.path, db => db.prepare('UPDATE source_maintenance SET record_digest=?').run('0'.repeat(64)))
  await readStopped(f.trust.ledger.path, store => {
    expect(() => store.readSourceMaintenanceState(repository)).toThrow(/stored record changed/u)
  })
})

test('rejects a completed release that lost its identity instead of treating its repository as empty', async () => {
  const { root } = await emptyLedger()
  const repository = join(root, 'source'), f = await sourceBaselineRelease({ repository,
    baseCommit: '1'.repeat(40), mergeCommit: '2'.repeat(40) })
  f.close()
  mutate(f.trust.ledger.path, db => db.exec('UPDATE source_plans SET release_id=NULL, release_fence=0'))
  await readStopped(f.trust.ledger.path, store => {
    expect(() => store.readSourceMaintenanceState(repository)).toThrow(/release state is incomplete/u)
  })
})

test.each(['awaiting-publish', 'publish-ambiguous', 'pending-approval', 'approved', 'release-failed'])
('rejects unsettled source status %s including failed releases with applied remote merges', async status => {
  const { root } = await emptyLedger()
  const repository = join(root, 'source'), f = await sourceBaselineRelease({ repository,
    baseCommit: '1'.repeat(40), mergeCommit: '2'.repeat(40) })
  f.close()
  mutate(f.trust.ledger.path, db => db.prepare('UPDATE source_plans SET status=?, release_id=CASE WHEN ? IN (\'pending-approval\',\'approved\') THEN NULL ELSE release_id END')
    .run(status, status))
  await readStopped(f.trust.ledger.path, store => {
    expect(() => store.readSourceMaintenanceState(repository)).toThrow(/unsettled source work|unresolved applied remote merge/u)
    expect(store.readSourceMaintenanceState(join(root, 'other-source'))).toEqual({ history: [], records: [] })
  })
})

test.each(['queued', 'running', 'unknown'])('rejects unsettled source job %s before release history exists', async status => {
  const { root, path } = await emptyLedger()
  const repository = join(root, 'source')
  mutate(path, db => {
    db.prepare('INSERT INTO source_job_authorities VALUES (?,?,?,?,?)').run('authority', 'a'.repeat(64), Date.now() + 600_000, 1, 0)
    db.prepare(`INSERT INTO source_jobs (id,automation_id,authority_id,idempotency_key,intent_json,intent_digest,status,
      revision,created_at,expires_at,definition_hash,occurrence_id,failure_code,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?,?)`)
      .run('job', 'automation', 'authority', 'job-key', JSON.stringify({ repository }), 'b'.repeat(64), status, Date.now(),
        Date.now() + 600_000, status === 'queued' ? null : 'c'.repeat(64), status === 'queued' ? null : 'occurrence',
        status === 'unknown' ? 'unknown' : null, Date.now())
  })
  await readStopped(path, store => {
    expect(() => store.readSourceMaintenanceState(repository)).toThrow(/unsettled source work/u)
  })
})

test.each(['unchanged', 'missing-watch', 'closed-watch', 'pending-plan', 'watching-rolled-back', 'extra-activated', 'extra-watched',
  'extra-pending', 'wrong-activation', 'wrong-fence', 'wrong-package', 'wrong-version', 'wrong-integrity', 'corrupt-watch-closure'])
('classifies %s activation state without degrading conflicting or corrupt watches to none', async state => {
  const source = await releaseFixture(true)
  const f = await createRuntimeEpochFixture({ releaseFixture: source })
  f.coordinator.close(); source.close()
  const path = f.plan.ledger.path
  mutate(path, db => {
    if (state === 'missing-watch') db.prepare('DELETE FROM activation_watch WHERE plan_id=?').run(f.plan.id)
    if (state === 'closed-watch') db.prepare(`UPDATE activation_watch SET state='closed-retracted',close_disposition='retracted',
      close_at=?,close_evidence_id='owner-retraction',close_signature_digest=? WHERE plan_id=?`).run(Date.now(), 'a'.repeat(64), f.plan.id)
    if (state === 'pending-plan' || state === 'watching-rolled-back') db.prepare('UPDATE activation_plans SET status=? WHERE id=?')
      .run(state === 'pending-plan' ? 'pending-approval' : 'rolled-back', f.plan.id)
    if (state.startsWith('extra-')) {
      const original = db.prepare('SELECT * FROM activation_plans WHERE id=?').get(f.plan.id) as Record<string, string | number | null>
      const extra = { ...original, id: 'extra-plan', plan_digest: '9'.repeat(64),
        status: state === 'extra-pending' ? 'pending-approval' : 'activated' }
      const columns = Object.keys(extra)
      db.prepare(`INSERT INTO activation_plans (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
        .run(...columns.map(column => extra[column as keyof typeof extra]))
      if (state === 'extra-watched') {
        const watch = db.prepare('SELECT * FROM activation_watch WHERE plan_id=?').get(f.plan.id) as Record<string, string | number | null>
        const duplicate = { ...watch, plan_id: extra.id }, fields = Object.keys(duplicate)
        db.prepare(`INSERT INTO activation_watch (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`)
          .run(...fields.map(field => duplicate[field as keyof typeof duplicate]))
      }
    }
    if (state === 'wrong-activation') db.prepare('UPDATE activation_watch SET activation_id=? WHERE plan_id=?').run('changed', f.plan.id)
    if (state === 'wrong-fence') db.prepare('UPDATE activation_watch SET fence=fence+1 WHERE plan_id=?').run(f.plan.id)
    if (state === 'wrong-package') db.prepare('UPDATE activation_watch SET package_name=? WHERE plan_id=?').run('@dsh-enhanced/other', f.plan.id)
    if (state === 'wrong-version') db.prepare('UPDATE activation_watch SET package_version=? WHERE plan_id=?').run('0.1.999', f.plan.id)
    if (state === 'wrong-integrity') db.prepare('UPDATE activation_watch SET package_integrity=? WHERE plan_id=?').run('changed', f.plan.id)
    if (state === 'corrupt-watch-closure') {
      db.exec('PRAGMA ignore_check_constraints=ON')
      db.prepare('UPDATE activation_watch SET close_at=? WHERE plan_id=?').run(Date.now(), f.plan.id)
    }
  })
  await readStopped(path, store => {
    if (state === 'unchanged') {
      expect(store.readSourceMaintenanceActivationState(f.trust.dshHome)).toEqual({ kind: 'watched', planId: f.plan.id })
    } else if (state.startsWith('wrong-')) {
      expect(() => store.readSourceMaintenanceActivationState(f.trust.dshHome)).toThrow(/watch binding is corrupt/u)
    } else if (state === 'corrupt-watch-closure') {
      expect(() => store.readSourceMaintenanceActivationState(f.trust.dshHome)).toThrow(/watch closure is corrupt/u)
    } else expect(store.readSourceMaintenanceActivationState(f.trust.dshHome)).toEqual({ kind: 'unsettled' })
    expect(store.readSourceMaintenanceActivationState(join(source.root, 'other-home'))).toEqual({ kind: 'none' })
  })
})
