import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmod, copyFile, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test, vi } from 'vitest'
import { loadCatalogWithMetadata } from '../src/catalog.ts'
import { authorizeLiveQualification, type LiveQualificationAuthorityConfig } from '../src/live-qualification-authority.ts'
import { requestLiveQualification } from '../src/live-qualification-client.ts'
import * as release from '../src/release.ts'
import { advanceSourceRelease } from '../src/source-release-runner.ts'
import { controlPlaneDigest, ControlPlaneStore, readLiveQualificationContext } from '../src/store.ts'
import { controlPlaneSchemaVersion, openControlPlaneDatabase } from '../src/sqlite.ts'
import { cleanupLiveQualificationReadinessFixtures, livePlan, liveQualificationBatch,
  liveTerms, persistedVote } from './helpers/live-qualification.ts'
import { cleanupReleaseFixtures, fixture } from './helpers/source-release-runner.ts'

vi.mock('../src/release.ts', async original => ({ ...await original<typeof release>(), invokeSourceReleaseAdapter: vi.fn() }))
afterEach(async () => { await cleanupLiveQualificationReadinessFixtures(); await cleanupReleaseFixtures() })

const terms = liveTerms
const batch = liveQualificationBatch

test('real owner source, signed Host phases and SQLite witness qualify through independent signer', async () => {
  const value = await livePlan()
  try {
    const witness = await persistedVote(value), frozen = batch(value, witness)
    value.f.store.putLiveQualification(frozen)
    const db = new DatabaseSync(value.plan.ledger.path, { readOnly: true })
    try { expect(readLiveQualificationContext(db, frozen.id).record.batch).toEqual(frozen) }
    finally { db.close() }
    const keys = generateKeyPairSync('ed25519'), keyPath = join(value.f.root, 'live-key.pem')
    await writeFile(keyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    await chmod(keyPath, 0o600)
    const config: LiveQualificationAuthorityConfig = { schemaVersion: 1, authority: terms.authority,
      keyId: terms.keyId, keyPath, statePath: join(value.f.root, 'live-authority.sqlite'),
      controlDatabasePath: value.plan.ledger.path,
      grant: { id: 'live-grant', expiresAt: value.window.deadlineAt, maxQualifications: 1,
        owner: witness.owner, installationId: value.plan.installationId, ledger: value.plan.ledger,
        profilePath: value.plan.target.profilePath, packages: [value.plan.candidate.package],
        terms, receiptTtlMs: 10_000 } }
    const request = { protocol: 'dsh-live-qualification/v1' as const, batchId: frozen.id, batchDigest: frozen.digest }
    const receipt = await authorizeLiveQualification(config, request)
    expect(receipt.disposition).toBe('qualified')
    expect(await authorizeLiveQualification(config, request)).toEqual(receipt)
    if (process.platform === 'linux') {
      const configPath = join(value.f.root, 'live-authority.json'), nodePath = join(value.f.root, 'node')
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
      await copyFile(await realpath(process.execPath), nodePath); await chmod(nodePath, 0o700)
      const wrapper = await realpath(fileURLToPath(new URL('../bin/dsh-live-qualification-authority.js', import.meta.url)))
      const sha = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex')
      expect(await requestLiveQualification({ configPath, timeoutMs: 10_000,
        executable: { path: wrapper, sha256: await sha(wrapper) },
        interpreter: { path: nodePath, sha256: await sha(nodePath) } }, request)).toEqual(receipt)
    }
    const applied = await value.f.store.applyLiveQualification({ receipt,
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      withSourceFence: value.f.options.withSourceFence! })
    expect(applied.status).toBe('commit-pending')
    expect(value.f.store.getLiveQualification(frozen.id)?.state).toBe('applied')
    const missingLiveFence = new ControlPlaneStore({ path: applied.ledger.path,
      withOwnerActivationFence: (_gap, callback) => value.f.options.withSourceFence!(callback) })
    try {
      await expect(missingLiveFence.claimActivation({ planId: applied.id, expectedRevision: applied.revision,
        leaseMs: 5_000, resolveApprovalAuthority: () => value.approvalAuthority })).rejects.toThrow('fence')
    } finally { missingLiveFence.close() }
    const invalidated = value.f.store.invalidateLiveQualification({ planId: applied.id,
      batchId: frozen.id, reason: 'owner-revised-the-outcome' })
    expect(invalidated.status).toBe('rollback-pending')
    expect(invalidated.revision).toBeGreaterThan(applied.revision)
    const stale = new ControlPlaneStore({ path: applied.ledger.path,
      withOwnerActivationFence: (_gap, callback) => value.f.options.withSourceFence!(callback) })
    try {
      await expect(stale.claimActivation({ planId: applied.id, expectedRevision: applied.revision,
        leaseMs: 5_000, resolveApprovalAuthority: () => value.approvalAuthority })).rejects.toThrow('revision conflict')
      expect(() => stale.advanceActivation({ planId: applied.id, expectedRevision: applied.revision,
        fence: applied.activation!.fence, from: 'commit-pending', to: 'activated' })).toThrow()
      expect(stale.getPlan(applied.id).status).toBe('rollback-pending')
    } finally { stale.close() }
  } finally { value.coordinator.close() }
}, 30_000)

test('one positive task cannot bypass a two-task contract, and deadline rejects a late batch', async () => {
  const value = await livePlan({ ...terms, minimumTasks: 2 })
  try {
    const witness = await persistedVote(value), insufficient = batch(value, witness)
    expect(() => value.f.store.putLiveQualification(insufficient)).toThrow('required task')
    expect(value.f.store.getLiveQualification(insufficient.id)).toBeUndefined()
  } finally { value.coordinator.close() }

  const late = await livePlan()
  try {
    const witness = await persistedVote(late), frozen = batch(late, witness)
    const expired = new ControlPlaneStore({ path: late.plan.ledger.path, now: () => late.window.deadlineAt })
    try {
      expect(() => expired.putLiveQualification(frozen)).toThrow('admission ended')
      expect(expired.getLiveQualification(frozen.id)).toBeUndefined()
    } finally { expired.close() }
  } finally { late.coordinator.close() }
}, 30_000)

test('one supported negative task signs failed early and routes the exact plan to rollback', async () => {
  const value = await livePlan({ ...terms, minimumTasks: 2 })
  try {
    const witness = await persistedVote(value, 'not-achieved'), frozen = batch(value, witness)
    value.f.store.putLiveQualification(frozen)
    const keys = generateKeyPairSync('ed25519'), keyPath = join(value.f.root, 'negative-live-key.pem')
    await writeFile(keyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    const config: LiveQualificationAuthorityConfig = { schemaVersion: 1, authority: terms.authority,
      keyId: terms.keyId, keyPath, statePath: join(value.f.root, 'negative-live-authority.sqlite'),
      controlDatabasePath: value.plan.ledger.path,
      grant: { id: 'negative-live-grant', expiresAt: value.window.deadlineAt, maxQualifications: 1,
        owner: witness.owner, installationId: value.plan.installationId, ledger: value.plan.ledger,
        profilePath: value.plan.target.profilePath, packages: [value.plan.candidate.package],
        terms: value.plan.dossier.liveQualification!, receiptTtlMs: 10_000 } }
    const receipt = await authorizeLiveQualification(config, { protocol: 'dsh-live-qualification/v1',
      batchId: frozen.id, batchDigest: frozen.digest })
    expect(receipt.disposition).toBe('failed')
    expect((await value.f.store.applyLiveQualification({ receipt,
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      withSourceFence: value.f.options.withSourceFence! })).status).toBe('rollback-pending')
  } finally { value.coordinator.close() }
}, 30_000)

test('read-only signer context rejects a persisted witness rebound to another owner', async () => {
  const value = await livePlan()
  try {
    const witness = await persistedVote(value), frozen = batch(value, witness)
    value.f.store.putLiveQualification(frozen)
    const db = new DatabaseSync(value.plan.ledger.path)
    try {
      const rebound = value.f.store.getForegroundDeployment(witness.vote.inboxId)!
      rebound.task.owner.principalRecordId = 'different-owner'
      db.prepare('UPDATE foreground_deployments SET record_json=?,record_digest=? WHERE inbox_id=?')
        .run(JSON.stringify(rebound), controlPlaneDigest(rebound), witness.vote.inboxId)
      expect(() => readLiveQualificationContext(db, frozen.id)).toThrow()
    } finally { db.close() }
  } finally { value.coordinator.close() }
}, 30_000)

test('v23 to v24 rebuild keeps the signed source release and strict activation bytes unchanged', async () => {
  const f = await fixture(true)
  await advanceSourceRelease(f.options); await f.decide(); await advanceSourceRelease(f.options)
  const source = f.store.getSourcePlan(f.plan.id), candidate = f.store.sourceReleaseCandidate(source.id)
  const catalog = await loadCatalogWithMetadata(f.options.trust.catalog.path)
  const original = f.options.withSourceFence!(() => f.store.createPlan({ sourcePlanId: source.id,
    gapId: source.gapId, candidate, catalog: { digest: catalog.digest, provenance: catalog.provenance },
    matchedCapabilities: candidate.capabilities, profile: 'web',
    target: { dshHome: f.root, profile: 'web', profilePath: join(f.root, 'profiles', 'web') },
    installationId: f.options.trust.installationId, ledger: f.options.trust.ledger,
    executor: { id: 'dsh', version: '1', path: join(f.root, 'dsh'), sha256: 'c'.repeat(64) },
    ttlMs: 60_000, idempotencyKey: 'strict-v23' })).result
  const path = f.options.trust.ledger.path
  const db = new DatabaseSync(path)
  let signedBefore: unknown[]
  try {
    signedBefore = db.prepare('SELECT receipt_json,receipt_digest FROM source_release_operations WHERE receipt_json IS NOT NULL ORDER BY operation_id').all()
    expect(signedBefore.length).toBeGreaterThan(0)
    const table = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='activation_plans'").get() as { sql: string }
    const index = db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name='activation_plans' AND sql IS NOT NULL").all() as Array<{sql:string}>
    const columns = (db.prepare('PRAGMA table_info(activation_plans)').all() as Array<{name:string}>)
      .map(row => `"${row.name}"`).join(',')
    const oldSchema = table.sql.replace(/^CREATE TABLE\s+"?activation_plans"?/u, 'CREATE TABLE activation_plans_v23')
      .replaceAll("'awaiting-health','awaiting-live-tasks'", "'awaiting-health'")
    if (!oldSchema.includes('activation_plans_v23') || oldSchema.includes('awaiting-live-tasks')) throw new Error('not a v23 reconstruction')
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE')
    try {
      db.exec(`DROP TABLE live_qualification_invalidations; DROP TABLE live_qualification_batches;
        DROP TABLE live_qualification_windows; ${oldSchema};
        INSERT INTO activation_plans_v23 (${columns}) SELECT ${columns} FROM activation_plans;
        DROP TABLE activation_plans; ALTER TABLE activation_plans_v23 RENAME TO activation_plans;`)
      for (const entry of index) db.exec(entry.sql.replaceAll("'awaiting-health','awaiting-live-tasks'", "'awaiting-health'"))
      db.exec('PRAGMA user_version=23; COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    finally { db.exec('PRAGMA foreign_keys=ON') }
  } finally { db.close() }
  const migrated = openControlPlaneDatabase(path)
  try {
    expect(migrated.prepare('PRAGMA user_version').get()?.user_version).toBe(controlPlaneSchemaVersion)
    expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(migrated.prepare('SELECT receipt_json,receipt_digest FROM source_release_operations WHERE receipt_json IS NOT NULL ORDER BY operation_id').all())
      .toEqual(signedBefore)
    expect(f.store.getPlan(original.id)).toEqual(original)
  } finally { migrated.close() }
}, 30_000)

test('live mode requires exact owner handoff while a plan without terms stays on the strict chain', async () => {
  const f = await fixture(true)
  await advanceSourceRelease(f.options); await f.decide(); await advanceSourceRelease(f.options)
  const source = f.store.getSourcePlan(f.plan.id), candidate = f.store.sourceReleaseCandidate(source.id)
  const catalog = await loadCatalogWithMetadata(f.options.trust.catalog.path)
  const input = { sourcePlanId: source.id, gapId: source.gapId, candidate,
    catalog: { digest: catalog.digest, provenance: catalog.provenance },
    matchedCapabilities: candidate.capabilities, profile: 'web',
    target: { dshHome: f.root, profile: 'web', profilePath: join(f.root, 'profiles', 'web') },
    installationId: f.options.trust.installationId, ledger: f.options.trust.ledger,
    executor: { id: 'dsh', version: '1', path: join(f.root, 'dsh'), sha256: 'c'.repeat(64) },
    ttlMs: 60_000, idempotencyKey: 'mode-test' }
  expect(() => f.options.withSourceFence!(() => f.store.createPlan({ ...input, liveQualification: terms }))).toThrow()
  const strict = f.options.withSourceFence!(() => f.store.createPlan(input)).result
  expect(strict.dossier.liveQualification).toBeUndefined()
  expect(strict.status).toBe('pending-approval')
}, 30_000)
