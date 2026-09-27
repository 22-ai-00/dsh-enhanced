import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import * as release from '../src/release.js'
vi.mock('../src/release.js', async original => ({ ...await original<typeof release>(), invokeSourceReleaseAdapter: vi.fn() }))
import { appendHostMaintenance, readHostMaintenanceContext, ControlPlaneStore } from '../src/store.js'
import { hostMaintenanceDigest, signHostMaintenanceRecord, type HostMaintenanceRecord } from '../src/host-maintenance.js'
import { cleanupRuntimeEpochFixtures, createRuntimeEpochFixture } from './helpers/runtime-epoch.js'
import { rollbackPluginWatch } from '../src/cli.js'

afterEach(cleanupRuntimeEpochFixtures)
function history(db: DatabaseSync) {
  return ['activation_plans', 'activation_watch', 'activation_host_input_witnesses', 'host_attestation_operations',
    'host_attestations', 'activation_deployment_checkpoints', 'source_adoptions'].map(table => db.prepare(`SELECT * FROM ${table}`).all())
}
async function fixture() {
  const f = await createRuntimeEpochFixture({ originallyExisted: true }), db = new DatabaseSync(f.plan.ledger.path)
  const original = readHostMaintenanceContext(db, f.plan.id), { plan, witness, readiness } = original
  if (!witness || !readiness) throw new Error('fixture lacks readiness')
  const before = { executor: plan.executor, profileFiles: witness.profileFiles, baselineFiles: plan.activation!.targetBaselineFiles ?? [],
    deploymentFiles: witness.deploymentFiles, baselineDeploymentFiles: witness.baselineDeploymentFiles,
    unitProperties: { FragmentPath: '/units/target.service', DropInPaths: '', ExecStart: '/old/dsh', Environment: 'PATH=/old',
      WorkingDirectory: plan.target.dshHome, User: '', Group: '', Type: 'exec', KillMode: 'control-group' } }
  const after = { ...structuredClone(before), executor: { ...plan.executor, version: '0.1.5-rc.4', path: '/candidate/dsh', sha256: 'a'.repeat(64) },
    profileFiles: before.profileFiles.map(pin => ({ ...pin, sha256: 'b'.repeat(64) })),
    baselineFiles: before.baselineFiles.map(pin => ({ ...pin, sha256: 'c'.repeat(64) })),
    unitProperties: { ...before.unitProperties, ExecStart: '/candidate/dsh', Environment: 'PATH=/candidate' } }
  const unsigned: Omit<HostMaintenanceRecord, 'signature' | 'publicKeyPem'> = { schemaVersion: 1, kind: 'dsh-host-maintenance',
    transactionId: 'host-update-1', installationId: plan.installationId, ledger: plan.ledger,
    profile: { name: plan.profile, path: plan.target.profilePath }, plan: { id: plan.id, digest: plan.digest },
    activation: { id: plan.activation!.id, fence: plan.activation!.fence },
    predecessor: { operationId: readiness.operationId, receiptDigest: hostMaintenanceDigest(readiness), hostGeneration: readiness.hostGeneration },
    sequence: 1, previousDigest: null, before, after, issuedAt: Date.now(), authority: readiness.authority, keyId: readiness.keyId }
  return { ...f, db, original, unsigned, record: signHostMaintenanceRecord(unsigned, f.signed.privateKeyPem) }
}

test('two offline Host migrations retain original evidence and rebase current witness and rollback baseline', async () => {
  const f = await fixture()
  try {
    const before = history(f.db)
    appendHostMaintenance(f.db, f.record)
    appendHostMaintenance(f.db, f.record)
    expect(readHostMaintenanceContext(f.db, f.plan.id).records).toHaveLength(1)
    expect(f.coordinator.getPlan(f.plan.id).executor).toEqual(f.plan.executor)
    expect(f.coordinator.currentPlanExecutor(f.plan.id)).toEqual(f.record.after.executor)
    expect(f.coordinator.getPlan(f.plan.id).activation!.targetBaselineFiles).toEqual(f.record.after.baselineFiles)
    const pending = f.f.options.withSourceFence!(() => f.f.store.prepareRuntimeEpoch({ runtime: f.runtime(), issuer: f.issuer, receiptTtlMs: 30000 }))
    const claimed = f.coordinator.claimRuntimeEpoch(pending.request.operationId, f.handoff.coordinatorId)
    expect(f.coordinator.applyRuntimeEpoch(f.signEpoch(claimed.request), f.trust).status).toBe('applied')
    expect(f.coordinator.currentRuntimeEpochDeployment(f.plan.target.profilePath).witness.profileFiles).toEqual(f.record.after.profileFiles)
    const second = signHostMaintenanceRecord({ ...f.unsigned, transactionId: 'host-update-2', sequence: 2,
      previousDigest: hostMaintenanceDigest(f.record), before: f.record.after,
      after: { ...f.record.after, executor: { ...f.record.after.executor, version: '0.1.5-rc.5' } } }, f.signed.privateKeyPem)
    appendHostMaintenance(f.db, second)
    expect(readHostMaintenanceContext(f.db, f.plan.id).records).toHaveLength(2)
    expect(history(f.db)).toEqual(before)
    expect(f.coordinator.currentPlanExecutor(f.plan.id).version).toBe('0.1.5-rc.5')
  } finally { f.db.close(); f.coordinator.close() }
})

test('maintenance rejects a different signing key, changed predecessor and rewrites of an existing transaction', async () => {
  const f = await fixture()
  try {
    const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    expect(() => appendHostMaintenance(f.db, signHostMaintenanceRecord(f.unsigned, key))).toThrow()
    expect(() => appendHostMaintenance(f.db, signHostMaintenanceRecord({ ...f.unsigned,
      before: { ...f.unsigned.before, profileFiles: f.unsigned.before.profileFiles.map(pin => ({ ...pin, sha256: pin.sha256 === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64) })) } }, f.signed.privateKeyPem))).toThrow()
    appendHostMaintenance(f.db, f.record)
    expect(() => appendHostMaintenance(f.db, signHostMaintenanceRecord({ ...f.unsigned, issuedAt: f.unsigned.issuedAt + 1 }, f.signed.privateKeyPem))).toThrow()
    f.db.prepare('UPDATE deployment_host_maintenance SET record_digest=?').run('0'.repeat(64))
    expect(() => f.coordinator.getPlan(f.plan.id)).toThrow()
  } finally { f.db.close(); f.coordinator.close() }
})

test('a maintenance signature cannot reopen a closed watch', async () => {
  const f = await fixture()
  try {
    f.db.prepare("UPDATE activation_watch SET state='closed-retracted',close_disposition='retracted',close_at=?,close_evidence_id='withdrawn',close_signature_digest=?")
      .run(Date.now(), 'f'.repeat(64))
    expect(() => appendHostMaintenance(f.db, f.record)).toThrow()
    expect(readHostMaintenanceContext(f.db, f.plan.id).records).toHaveLength(0)
  } finally { f.db.close(); f.coordinator.close() }
})

test.each(['superseded', 'inflight'] as const)('maintenance refuses an old watching deployment when a successor is %s', async state => {
  const f = await fixture()
  try {
    const row = f.db.prepare('SELECT * FROM activation_plans WHERE id=?').get(f.plan.id)!
    const successor = { ...row, id: 'successor', plan_digest: '9'.repeat(64), status: state === 'inflight' ? 'staging' : 'activated' }
    const columns = Object.keys(successor)
    f.db.prepare(`INSERT INTO activation_plans (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
      .run(...Object.values(successor))
    if (state === 'superseded') f.db.prepare('INSERT INTO activation_deployment_checkpoints VALUES (?,?,2,2,?,?)')
      .run('successor', JSON.stringify(f.record.before.profileFiles), Date.now(), Date.now())
    expect(() => appendHostMaintenance(f.db, f.record)).toThrow()
    expect(readHostMaintenanceContext(f.db, f.plan.id).records).toHaveLength(0)
  } finally { f.db.close(); f.coordinator.close() }
})

test('physical rollback restores the rebased backup using the current Host executor without rewriting the original baseline', async () => {
  const f = await fixture()
  try {
    const profile = f.plan.target.profilePath
    const suffix = f.plan.activation!.id.replace(/[^A-Za-z0-9-]/gu, '').slice(-36)
    const backup = join(f.plan.target.dshHome, 'profiles', `.${f.plan.profile}.plugin-backup-${suffix}`)
    await mkdir(profile, { recursive: true }); await mkdir(backup, { recursive: true })
    const candidate = '{"fixture":"updated candidate"}\n', baseline = '{"fixture":"rebased backup"}\n'
    for (const pin of f.record.after.profileFiles) {
      await writeFile(pin.path, candidate, { mode: 0o600 })
      await writeFile(join(backup, basename(pin.path)), baseline, { mode: 0o600 })
    }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    const record = signHostMaintenanceRecord({ ...f.unsigned, after: { ...f.unsigned.after,
      profileFiles: f.unsigned.after.profileFiles.map(pin => ({ ...pin, sha256: sha(candidate) })),
      baselineFiles: f.unsigned.after.baselineFiles.map(pin => ({ ...pin, sha256: sha(baseline) })) } }, f.signed.privateKeyPem)
    appendHostMaintenance(f.db, record)
    // Seed the already authenticated watch-close checkpoint; this test exercises
    // real filesystem recovery, not the separate signed quality-feedback path.
    f.db.prepare("UPDATE activation_watch SET state='closed-retracted',close_disposition='retracted',close_at=?,close_evidence_id='withdrawn',close_signature_digest=?")
      .run(Date.now(), 'f'.repeat(64))
    const { hostAttestor: _hostAttestor, ...trust } = f.trust
    const result = await rollbackPluginWatch({ store: f.coordinator, planId: f.plan.id,
      trust: { ...trust, executor: { ...trust.executor, ...record.after.executor },
        approvalKeys: [...trust.approvalKeys, { authority: 'owner', keyId: 'key', publicKeyPem: f.approvalPublicKeyPem.toString() }] } })
    expect(result).toMatchObject({ status: 'rollback-pending', activation: { rollbackProfileRestored: true } })
    expect(await readFile(join(profile, 'pnpm-lock.yaml'), 'utf8')).toBe(baseline)
    expect(readHostMaintenanceContext(f.db, f.plan.id).plan.activation!.targetBaselineFiles).toEqual(f.unsigned.before.baselineFiles)
  } finally { f.db.close(); f.coordinator.close() }
})

test('schema 26 migration adds an empty maintenance journal and retains original signed rows', async () => {
  const f = await fixture()
  try {
    const before = history(f.db)
    f.db.exec('DROP TABLE deployment_host_maintenance; PRAGMA user_version=26')
    const reopened = new ControlPlaneStore({ path: f.plan.ledger.path })
    try {
      expect(f.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 27 })
      expect(readHostMaintenanceContext(f.db, f.plan.id).records).toEqual([])
      expect(history(f.db)).toEqual(before)
    } finally { reopened.close() }
  } finally { f.db.close(); f.coordinator.close() }
})
