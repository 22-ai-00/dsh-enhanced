import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import * as release from '../src/release.ts'
import { resolveSourceBaseline } from '../src/source-baseline.ts'
import { signSourceMaintenanceRecord, sourceMaintenanceDigest, sourceBaselineChain,
  type SourceMaintenanceRecord } from '../src/source-maintenance.ts'
import { ControlPlaneStore, controlPlaneDigest } from '../src/store.ts'
import { hostMaintenanceDigest } from '../src/host-maintenance.ts'
import { Ed25519PostActivationObservationAuthority, postActivationEvidenceDigest,
  postActivationObservationSigningPayload } from '../src/post-activation.ts'
import type { PostActivationObservationReceipt } from '../src/types.ts'
import type { PluginControlTrustConfig } from '../src/trust.ts'
import { sourceBaselineRelease } from './helpers/source-baseline.ts'
import { cleanupRuntimeEpochFixtures, createRuntimeEpochFixture } from './helpers/runtime-epoch.ts'
import { fixture as releaseFixture } from './helpers/source-release-runner.ts'

vi.mock('../src/release.ts', async original => ({ ...await original<typeof release>(), invokeSourceReleaseAdapter: vi.fn() }))
const roots: string[] = []
afterEach(async () => { await cleanupRuntimeEpochFixtures(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8',
  env: { LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()

test('preserves signed releases across two Host-signed maintenance edges, restart, CAS and rejected writes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-source-maintenance-'))); roots.push(root)
  const repository = join(root, 'source'), remote = join(root, 'remote.git')
  git(root, 'init', '-q', '-b', 'main', repository)
  git(repository, 'config', 'user.email', 'fixture@example.invalid'); git(repository, 'config', 'user.name', 'Fixture')
  await mkdir(join(repository, 'plugins/health-helper/src'), { recursive: true })
  const commits: string[] = []
  for (let index = 0; index < 6; index++) {
    await writeFile(join(repository, 'plugins/health-helper/src/index.ts'), `export const version=${index}\n`)
    git(repository, 'add', '.'); git(repository, 'commit', '-qm', `version ${index}`)
    commits.push(git(repository, 'rev-parse', 'HEAD'))
  }
  const [initial, releaseOne, maintenanceOne, releaseTwo, maintenanceTwo, maintenanceThree] = commits as [string,string,string,string,string,string]
  git(root, 'init', '-q', '--bare', remote); await chmod(remote, 0o700)
  git(repository, 'push', '-q', remote, `HEAD:refs/heads/archive`)
  git(remote, 'update-ref', 'refs/heads/repairs', releaseOne)
  const fixture = await sourceBaselineRelease({ repository, baseCommit: initial, mergeCommit: releaseOne })
  const keys = generateKeyPairSync('ed25519')
  const hostIdentity = { authority: 'source-maintenance-host', keyId: 'host-1',
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }
  const trust = { ...fixture.trust, dshHome: root, hostAttestationKeys: [hostIdentity] } as PluginControlTrustConfig
  const baseline = { ref: 'refs/dsh-source/repairs', remote, targetBranch: 'repairs', initialCommit: initial }
  const options = { trust, baseline }
  const make = (sequence: number, beforeTip: string, afterTip: string,
    before: SourceMaintenanceRecord['before'], previousDigest: string | null): SourceMaintenanceRecord =>
    signSourceMaintenanceRecord({ schemaVersion: 1, kind: 'dsh-source-maintenance', transactionId: `transaction-${sequence}`,
      installationId: trust.installationId, ledger: trust.ledger, repository, baseline, sequence, previousDigest,
      previousTip: beforeTip, candidateTip: afterTip, upstreamCommit: afterTip,
      sourceTree: git(repository, 'rev-parse', `${afterTip}^{tree}`), preparationReceiptDigest: sha(`prep-${sequence}`),
      originalBootstrapDigest: sha('original-bootstrap'), before,
      after: { sourceCommit: afterTip, version: `0.1.${sequence}`, cohortDigest: sha(`cohort-${sequence}`) },
      host: null, issuedAt: Date.now(), authority: hostIdentity.authority, keyId: hostIdentity.keyId },
    keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
  const first = make(1, releaseOne, maintenanceOne,
    { sourceCommit: initial, version: '0.1.0', cohortDigest: sha('cohort-0') }, null)
  git(remote, 'update-ref', 'refs/heads/repairs', maintenanceOne, releaseOne)
  git(repository, 'update-ref', baseline.ref, maintenanceOne)
  await expect(fixture.store.appendSourceMaintenance(first, { trust: { ...trust, hostAttestationKeys: [] }, baseline }))
    .rejects.toThrow()
  expect(fixture.store.getSourceMaintenanceRecords(repository)).toEqual([])
  await fixture.store.appendSourceMaintenance(first, options)
  expect(fixture.store.getSourceMaintenanceRecords(repository)).toEqual([first])
  await fixture.store.appendSourceMaintenance(first, options)
  expect(fixture.store.getSourceMaintenanceRecords(repository)).toHaveLength(1)
  await fixture.completeNext({ baseCommit: maintenanceOne, mergeCommit: releaseTwo,
    managed: true, baseline, trustOverride: trust })
  git(remote, 'update-ref', 'refs/heads/repairs', releaseTwo, maintenanceOne)
  expect(sourceBaselineChain(baseline, fixture.store.getSourceBaselineHistory(repository),
    fixture.store.getSourceMaintenanceRecords(repository)).at(-1)).toBe(releaseTwo)
  const second = make(2, releaseTwo, maintenanceTwo, first.after, sourceMaintenanceDigest(first))
  git(remote, 'update-ref', 'refs/heads/repairs', maintenanceTwo, releaseTwo)
  git(repository, 'update-ref', baseline.ref, maintenanceTwo, maintenanceOne)
  await fixture.store.appendSourceMaintenance(second, options)
  const reopened = new ControlPlaneStore({ path: trust.ledger.path })
  try {
    const input = { repository, config: baseline, environment: process.env, signal: new AbortController().signal,
      assertCurrent: () => {}, trust, readHistory: () => reopened.getSourceBaselineHistory(repository),
      readMaintenance: () => reopened.getSourceMaintenanceRecords(repository) }
    expect(await resolveSourceBaseline(input)).toBe(maintenanceTwo)
    expect(reopened.getSourceMaintenanceRecords(repository)).toEqual([first, second])
    await expect(reopened.appendSourceMaintenance({ ...second, transactionId: 'forged' }, options)).rejects.toThrow()
    await expect(reopened.appendSourceMaintenance({ ...second, previousTip: initial }, options)).rejects.toThrow()
    expect(reopened.getSourceMaintenanceRecords(repository)).toHaveLength(2)
    git(repository, 'update-ref', baseline.ref, initial, maintenanceTwo)
    expect(await resolveSourceBaseline(input)).toBe(maintenanceTwo)
    expect(git(repository, 'rev-parse', baseline.ref)).toBe(maintenanceTwo)
    const database = new DatabaseSync(trust.ledger.path)
    try {
      const row = database.prepare(`SELECT operation_id,receipt_json FROM source_release_operations
        WHERE phase='merge' AND status='applied' ORDER BY created_at LIMIT 1`).get() as
        { operation_id: string; receipt_json: string }
      const receipt = JSON.parse(row.receipt_json) as Record<string, unknown>
      receipt.signature = Buffer.alloc(64).toString('base64')
      database.prepare('UPDATE source_release_operations SET receipt_json=?,receipt_digest=? WHERE operation_id=?')
        .run(JSON.stringify(receipt), controlPlaneDigest(receipt), row.operation_id)
      git(remote, 'update-ref', 'refs/heads/repairs', maintenanceThree, maintenanceTwo)
      git(repository, 'update-ref', baseline.ref, maintenanceThree, maintenanceTwo)
      const third = make(3, maintenanceTwo, maintenanceThree, second.after, sourceMaintenanceDigest(second))
      await expect(reopened.appendSourceMaintenance(third, options)).rejects.toThrow(/signature/u)
      expect(reopened.getSourceMaintenanceRecords(repository)).toHaveLength(2)
    } finally { database.close() }
  } finally { reopened.close() }
}, 60_000)

test('schema 27 upgrades to 28 without replacing historical rows', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-source-schema27-'))); roots.push(root)
  const path = join(root, 'control.sqlite')
  const store = new ControlPlaneStore({ path })
  const gap = store.recordGap({ idempotencyKey: 'historical', capability: 'history', context: 'retained row',
    expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 0 })
  store.close()
  const database = new DatabaseSync(path)
  try { database.exec('DROP TABLE source_maintenance; PRAGMA user_version=27') } finally { database.close() }
  const reopened = new ControlPlaneStore({ path })
  try {
    const check = new DatabaseSync(path, { readOnly: true })
    try {
      expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: 28 })
      expect(check.prepare('SELECT COUNT(*) AS count FROM source_maintenance').get()).toEqual({ count: 0 })
      expect(check.prepare('SELECT id FROM capability_gaps WHERE id=?').get(gap.id)).toEqual({ id: gap.id })
    } finally { check.close() }
  } finally { reopened.close() }
})

test('imports only a complete pre-adoption signed sidecar and replays exact rows', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-source-import-'))); roots.push(root)
  const repository = join(root, 'source'), remote = join(root, 'remote.git'), path = join(root, 'control.sqlite')
  git(root, 'init', '-q', '-b', 'main', repository)
  git(repository, 'config', 'user.email', 'fixture@example.invalid'); git(repository, 'config', 'user.name', 'Fixture')
  const commits: string[] = []
  for (let index = 0; index < 3; index++) {
    await writeFile(join(repository, 'source.txt'), `source ${index}\n`)
    git(repository, 'add', '.'); git(repository, 'commit', '-qm', `source ${index}`)
    commits.push(git(repository, 'rev-parse', 'HEAD'))
  }
  const [initial, firstTip, finalTip] = commits as [string,string,string]
  git(root, 'init', '-q', '--bare', remote); await chmod(remote, 0o700)
  git(repository, 'push', '-q', remote, `HEAD:refs/heads/repairs`)
  const baseline = { ref: 'refs/dsh-source/repairs', remote, targetBranch: 'repairs', initialCommit: initial }
  git(repository, 'update-ref', baseline.ref, finalTip)
  const keys = generateKeyPairSync('ed25519')
  const identity = { authority: 'host', keyId: 'host', publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }
  const trust = { installationId: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00', dshHome: root,
    ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01', path }, hostAttestationKeys: [identity] } as unknown as PluginControlTrustConfig
  const signRecord = (sequence: number, beforeTip: string, afterTip: string,
    before: SourceMaintenanceRecord['before'], previousDigest: string | null) => signSourceMaintenanceRecord({
    schemaVersion: 1, kind: 'dsh-source-maintenance', transactionId: `preowner-${sequence}`,
    installationId: trust.installationId, ledger: trust.ledger, repository, baseline, sequence, previousDigest,
    previousTip: beforeTip, candidateTip: afterTip, upstreamCommit: afterTip,
    sourceTree: git(repository, 'rev-parse', `${afterTip}^{tree}`), preparationReceiptDigest: sha(`prep-${sequence}`),
    originalBootstrapDigest: sha('bootstrap'), before,
    after: { sourceCommit: afterTip, version: `0.1.${sequence}`, cohortDigest: sha(`cohort-${sequence}`) },
    host: null, issuedAt: Date.now(), authority: identity.authority, keyId: identity.keyId },
  keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
  const first = signRecord(1, initial, firstTip, { sourceCommit: initial, version: '0.1.0', cohortDigest: sha('cohort-0') }, null)
  const second = signRecord(2, firstTip, finalTip, first.after, sourceMaintenanceDigest(first))
  const store = new ControlPlaneStore({ path })
  try {
    await store.importSourceMaintenanceRecords([first, second], { trust, baseline })
    await store.importSourceMaintenanceRecords([first, second], { trust, baseline })
    expect(store.getSourceMaintenanceRecords(repository)).toEqual([first, second])
    await expect(store.importSourceMaintenanceRecords([first, { ...second, transactionId: 'changed' }], { trust, baseline }))
      .rejects.toThrow()
    expect(store.getSourceMaintenanceRecords(repository)).toHaveLength(2)
  } finally { store.close() }
})

test('watched owner requires its original readiness key and rejects pending or closed deployment', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-source-watched-'))); roots.push(root)
  const repository = join(root, 'source'), remote = join(root, 'remote.git')
  git(root, 'init', '-q', '-b', 'main', repository)
  git(repository, 'config', 'user.email', 'fixture@example.invalid'); git(repository, 'config', 'user.name', 'Fixture')
  const commits: string[] = []
  for (let index = 0; index < 4; index++) {
    await writeFile(join(repository, 'source.txt'), `source ${index}\n`)
    git(repository, 'add', '.'); git(repository, 'commit', '-qm', `source ${index}`)
    commits.push(git(repository, 'rev-parse', 'HEAD'))
  }
  const [initial, released, firstTip, secondTip] = commits as [string,string,string,string]
  git(root, 'init', '-q', '--bare', remote); await chmod(remote, 0o700)
  git(repository, 'push', '-q', remote, 'HEAD:refs/heads/archive')
  git(remote, 'update-ref', 'refs/heads/repairs', released)
  const source = await releaseFixture(true, { root, repository, baseCommit: initial, mergeCommit: released })
  const f = await createRuntimeEpochFixture({ releaseFixture: source }), store = f.f.store
  const baseline = { ref: 'refs/dsh-source/repairs', remote, targetBranch: 'repairs', initialCommit: initial }
  const readiness = f.signed.receipt, host = { planId: f.plan.id, planDigest: f.plan.digest,
    readinessOperationId: readiness.operationId, readinessReceiptDigest: hostMaintenanceDigest(readiness) }
  const make = (sequence: number, previousTip: string, candidateTip: string,
    before: SourceMaintenanceRecord['before'], previousDigest: string | null): SourceMaintenanceRecord =>
    signSourceMaintenanceRecord({ schemaVersion: 1, kind: 'dsh-source-maintenance', transactionId: `watched-${sequence}`,
      installationId: f.trust.installationId, ledger: f.trust.ledger, repository, baseline, sequence, previousDigest,
      previousTip, candidateTip, upstreamCommit: candidateTip,
      sourceTree: git(repository, 'rev-parse', `${candidateTip}^{tree}`), preparationReceiptDigest: sha(`prep-watched-${sequence}`),
      originalBootstrapDigest: sha('watched-bootstrap'), before,
      after: { sourceCommit: candidateTip, version: `0.1.${sequence}`, cohortDigest: sha(`watched-cohort-${sequence}`) },
      host, issuedAt: Date.now(), authority: readiness.authority, keyId: readiness.keyId }, f.signed.privateKeyPem)
  const first = make(1, released, firstTip,
    { sourceCommit: initial, version: '0.1.0', cohortDigest: sha('watched-cohort-0') }, null)
  git(remote, 'update-ref', 'refs/heads/repairs', firstTip, released)
  git(repository, 'update-ref', baseline.ref, firstTip)
  const { signature: _signature, publicKeyPem: _publicKeyPem, ...firstUnsigned } = first
  const unanchored = signSourceMaintenanceRecord({ ...firstUnsigned, host: null }, f.signed.privateKeyPem)
  await expect(store.appendSourceMaintenance(unanchored, { trust: f.trust, baseline })).rejects.toThrow(/watched Host anchor/u)
  expect(store.getSourceMaintenanceRecords(repository)).toEqual([])
  await store.appendSourceMaintenance(first, { trust: f.trust, baseline })
  expect(store.getSourceMaintenanceRecords(repository)).toEqual([first])
  const second = make(2, firstTip, secondTip, first.after, sourceMaintenanceDigest(first))
  git(remote, 'update-ref', 'refs/heads/repairs', secondTip, firstTip)
  git(repository, 'update-ref', baseline.ref, secondTip, firstTip)
  const db = new DatabaseSync(f.plan.ledger.path)
  try {
    const original = db.prepare('SELECT * FROM activation_plans WHERE id=?').get(f.plan.id) as Record<string, unknown>
    const pending: Record<string, unknown> = { ...original, id: 'pending-source-maintenance',
      plan_digest: '9'.repeat(64), status: 'pending-approval' }
    const columns = Object.keys(pending)
    db.prepare(`INSERT INTO activation_plans (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
      .run(...columns.map(column => pending[column] as string | number | null))
    await expect(store.appendSourceMaintenance(second, { trust: f.trust, baseline })).rejects.toThrow(/activation is unsettled/u)
    expect(store.getSourceMaintenanceRecords(repository)).toEqual([first])
    db.prepare('DELETE FROM activation_plans WHERE id=?').run(String(pending.id))
    db.prepare(`UPDATE activation_watch SET state='closed-retracted',close_disposition='retracted',
      close_at=?,close_evidence_id='owner-retraction',close_signature_digest=? WHERE plan_id=?`)
      .run(Date.now(), 'a'.repeat(64), f.plan.id)
    await expect(store.appendSourceMaintenance(second, { trust: f.trust, baseline })).rejects.toThrow(/activation is unsettled/u)
    expect(store.getSourceMaintenanceRecords(repository)).toEqual([first])
  } finally { db.close(); f.coordinator.close() }
}, 60_000)

test('maintains a successor deployment while retaining a superseded activated plan with its closed watch and older success', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-source-successor-'))); roots.push(root)
  const repository = join(root, 'source'), remote = join(root, 'remote.git')
  git(root, 'init', '-q', '-b', 'main', repository)
  git(repository, 'config', 'user.email', 'fixture@example.invalid'); git(repository, 'config', 'user.name', 'Fixture')
  const commits: string[] = []
  for (let index = 0; index < 4; index++) {
    await writeFile(join(repository, 'source.txt'), `source ${index}\n`)
    git(repository, 'add', '.'); git(repository, 'commit', '-qm', `source ${index}`)
    commits.push(git(repository, 'rev-parse', 'HEAD'))
  }
  const [initial, released, successorTip, maintained] = commits as [string,string,string,string]
  git(root, 'init', '-q', '--bare', remote); await chmod(remote, 0o700)
  git(repository, 'push', '-q', remote, 'HEAD:refs/heads/repairs')
  const source = await releaseFixture(true, { root, repository, baseCommit: initial, mergeCommit: released })
  const old = await createRuntimeEpochFixture({ releaseFixture: source })
  const keys = generateKeyPairSync('ed25519'), now = Date.now()
  const evidence = { kind: 'post-activation-health' as const, checks: 1, failures: 1, probeDigest: sha('regression') }
  const unsigned: Omit<PostActivationObservationReceipt, 'signature'> = {
    schemaVersion: 1, observationId: 'superseded-regression', authority: 'host-observer', keyId: 'host-observer',
    installationId: old.plan.installationId, planId: old.plan.id, planDigest: old.plan.digest,
    activationId: old.plan.activation!.id, fence: old.plan.activation!.fence,
    package: old.plan.candidate.package, version: old.plan.candidate.version, integrity: old.plan.candidate.integrity,
    disposition: 'regressed', evidence, evidenceDigest: postActivationEvidenceDigest(evidence),
    hostGeneration: old.signed.receipt.hostGeneration, observedAt: now, expiresAt: now + 30_000,
  }
  await source.store.recordPostActivationObservation({ idempotencyKey: 'superseded-regression',
    receipt: { ...unsigned, signature: sign(null, Buffer.from(postActivationObservationSigningPayload(unsigned)), keys.privateKey).toString('base64') },
    resolveAuthority: () => new Ed25519PostActivationObservationAuthority(
      keys.publicKey.export({ type: 'spki', format: 'pem' }), 'host-observer', 'host-observer') })
  expect(source.store.getPlan(old.plan.id).status).toBe('activated')
  expect(source.store.getActivationWatch(old.plan.id).state).toBe('closed-regressed')
  old.coordinator.close()
  const next = await source.next({ baseCommit: released, mergeCommit: successorTip })
  const current = await createRuntimeEpochFixture({ releaseFixture: next })
  expect(current.plan.target.profilePath).toBe(old.plan.target.profilePath)
  expect(source.store.listRetiredActivationBackups(current.plan.id).map(plan => plan.id)).toEqual([old.plan.id])
  expect(() => source.store.beginPostActivationRollback({ planId: old.plan.id, expectedRevision: old.plan.revision })).toThrow(/superseded/u)
  expect(source.store.readSourceMaintenanceActivationState(root)).toEqual({ kind: 'watched', planId: current.plan.id })
  const baseline = { ref: 'refs/dsh-source/repairs', remote, targetBranch: 'repairs', initialCommit: initial }
  git(repository, 'update-ref', baseline.ref, maintained)
  const readiness = current.signed.receipt
  const record = signSourceMaintenanceRecord({ schemaVersion: 1, kind: 'dsh-source-maintenance', transactionId: 'successor-maintenance',
    installationId: current.trust.installationId, ledger: current.trust.ledger, repository, baseline,
    sequence: 1, previousDigest: null, previousTip: successorTip, candidateTip: maintained, upstreamCommit: maintained,
    sourceTree: git(repository, 'rev-parse', `${maintained}^{tree}`), preparationReceiptDigest: sha('successor-prep'),
    originalBootstrapDigest: sha('successor-bootstrap'),
    before: { sourceCommit: initial, version: '0.1.0', cohortDigest: sha('successor-before') },
    after: { sourceCommit: maintained, version: '0.1.3', cohortDigest: sha('successor-after') },
    host: { planId: current.plan.id, planDigest: current.plan.digest,
      readinessOperationId: readiness.operationId, readinessReceiptDigest: hostMaintenanceDigest(readiness) },
    issuedAt: Date.now(), authority: readiness.authority, keyId: readiness.keyId }, current.signed.privateKeyPem)
  await source.store.appendSourceMaintenance(record, { trust: current.trust, baseline })
  expect(source.store.getSourceMaintenanceRecords(repository)).toEqual([record])
  current.coordinator.close(); source.close()
  const readonly = new ControlPlaneStore({ path: current.plan.ledger.path, readOnly: true })
  try {
    expect(readonly.readSourceMaintenanceActivationState(root)).toEqual({ kind: 'watched', planId: current.plan.id })
    expect(readonly.readSourceMaintenanceState(repository).records).toEqual([record])
  } finally { readonly.close() }
  const db = new DatabaseSync(current.plan.ledger.path)
  try { db.prepare('UPDATE activation_deployment_checkpoints SET successful_order=NULL WHERE plan_id=?').run(old.plan.id) }
  finally { db.close() }
  const unproved = new ControlPlaneStore({ path: current.plan.ledger.path, readOnly: true })
  try { expect(unproved.readSourceMaintenanceActivationState(root)).toEqual({ kind: 'unsettled' }) }
  finally { unproved.close() }
}, 60_000)
