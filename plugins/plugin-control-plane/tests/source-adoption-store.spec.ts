import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmod, copyFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import { approvalSigningPayload, Ed25519ApprovalAuthority, parseApprovalReceipt } from '../src/approval.ts'
import { loadCatalogWithMetadata } from '../src/catalog.ts'
import * as release from '../src/release.ts'
import { advanceSourceRelease } from '../src/source-release-runner.ts'
import { requestSourceAuthorityReceipt } from '../src/source-approval-client.ts'
import { authorizeSourceAdoption, type SourceAdoptionAuthorityConfig } from '../src/source-adoption-authority.ts'
import { controlPlaneDigest } from '../src/store.ts'
import { controlPlaneSchemaVersion, openControlPlaneDatabase } from '../src/sqlite.ts'
import { ControlPlaneStore, readOwnerSourceAdoptionPlan } from '../src/store.ts'
import { cleanupReleaseFixtures, fixture } from './helpers/source-release-runner.ts'
vi.mock('../src/release.ts', async original => ({ ...await original<typeof release>(), invokeSourceReleaseAdapter: vi.fn() }))
afterEach(cleanupReleaseFixtures)

async function released() {
  const f = await fixture(true)
  await advanceSourceRelease(f.options); await f.decide(); await advanceSourceRelease(f.options)
  const source = f.store.getSourcePlan(f.plan.id), candidate = f.store.sourceReleaseCandidate(source.id)
  const catalog = await loadCatalogWithMetadata(f.options.trust.catalog.path)
  const input = { sourcePlanId: source.id, gapId: source.gapId, candidate, catalog: { digest: catalog.digest, provenance: catalog.provenance },
    matchedCapabilities: candidate.capabilities, profile: 'web', target: { dshHome: f.root, profile: 'web', profilePath: join(f.root, 'profiles', 'web') },
    installationId: f.options.trust.installationId, ledger: f.options.trust.ledger,
    executor: { id: 'dsh', version: '1', path: join(f.root, 'dsh'), sha256: 'c'.repeat(64) }, ttlMs: 60_000, idempotencyKey: 'owner-adoption' }
  const plan = f.options.withSourceFence!(() => f.store.createPlan(input)).result
  return { ...f, input, activation: plan }
}

function approval(plan: Awaited<ReturnType<typeof released>>['activation']) {
  const keys = generateKeyPairSync('ed25519')
  const body = { schemaVersion: 1 as const, approvalId: 'adoption-approval', authority: 'adoption-owner', keyId: 'adoption-key', planId: plan.id,
    planDigest: plan.digest, decision: 'approved' as const, principal: 'owner', decidedAt: Date.now(), expiresAt: plan.expiresAt }
  const receipt = { ...body, signature: sign(null, Buffer.from(approvalSigningPayload(body)), keys.privateKey).toString('base64') }
  const authority = new Ed25519ApprovalAuthority(keys.publicKey.export({ type: 'spki', format: 'pem' }), body.authority, body.keyId)
  return { receipt, resolveAuthority: () => authority, authority }
}

test('completed signed owner release links exactly one immutable activation, survives restart, rejects damaged binding', async () => {
  const f = await released()
  expect(f.store.findSourceAdoption(f.plan.id)).toEqual(f.activation)
  expect(f.options.withSourceFence!(() => f.store.createPlan(f.input)).result).toEqual(f.activation)
  const reopened = new ControlPlaneStore({ path: f.options.trust.ledger.path })
  try { expect(reopened.findSourceAdoption(f.plan.id)).toEqual(f.activation) } finally { reopened.close() }
  const db = new DatabaseSync(f.options.trust.ledger.path)
  try {
    expect(readOwnerSourceAdoptionPlan(db, f.activation.id).released).toEqual(f.activation.candidate)
    db.prepare("UPDATE source_adoptions SET binding_digest = ?").run('f'.repeat(64))
    expect(() => f.store.findSourceAdoption(f.plan.id)).toThrow('binding changed')
    expect(() => f.options.withSourceFence!(() => f.store.createPlan(f.input))).toThrow('binding changed')
  } finally { db.close() }
})

test('owner approval and claim require live admission including after signature await', async () => {
  const f = await released(), auth = approval(f.activation)
  await expect(f.store.approve({ planId: f.activation.id, expectedRevision: 1, idempotencyKey: 'adoption-approve', ...auth })).rejects.toThrow('admission')
  let current = true
  const store = new ControlPlaneStore({ path: f.options.trust.ledger.path, withOwnerActivationFence: (_gap, callback) => {
    if (!current) throw new Error('withdrawn'); return callback()
  } })
  try {
    const plan = (await store.approve({ planId: f.activation.id, expectedRevision: 1, idempotencyKey: 'adoption-approve', ...auth })).result
    await expect(store.claimActivation({ planId: plan.id, expectedRevision: plan.revision, leaseMs: 60_000,
      resolveApprovalAuthority: () => ({ verify: async (receipt, candidate) => { const value = await auth.authority.verify(receipt, candidate); current = false; return value } }) })).rejects.toThrow('withdrawn')
    expect(store.getPlan(plan.id).status).toBe('approved')
    await expect(store.approve({ planId: plan.id, expectedRevision: 1, idempotencyKey: 'adoption-approve', ...auth })).rejects.toThrow('withdrawn')
  } finally { store.close() }
})

test('withdrawal after filesystem work blocks forward settlement but permits physical recovery state changes', async () => {
  const f = await released(), auth = approval(f.activation)
  let current = true
  const store = new ControlPlaneStore({ path: f.options.trust.ledger.path, withOwnerActivationFence: (_gap, callback) => {
    if (!current) throw new Error('withdrawn'); return callback()
  } })
  try {
    let plan = (await store.approve({ planId: f.activation.id, expectedRevision: 1, idempotencyKey: 'adoption-approve', ...auth })).result
    plan = await store.claimActivation({ planId: plan.id, expectedRevision: plan.revision, leaseMs: 60_000, resolveApprovalAuthority: auth.resolveAuthority })
    const fence = { planId: plan.id, expectedRevision: plan.revision, fence: plan.activation!.fence }
    await expect(store.withActivationFileSystemGuard({ ...fence, status: 'staging', leaseMs: 60_000 }, async () => { current = false })).rejects.toThrow('withdrawn')
    expect(() => store.markActivationHostExposure(fence)).toThrow('withdrawn')
    expect(() => store.advanceActivation({ ...fence, from: 'staging', to: 'awaiting-reload' })).toThrow('withdrawn')
    plan = store.advanceActivation({ ...fence, from: 'staging', to: 'rollback-pending' })
    expect(store.advanceActivation({ planId: plan.id, expectedRevision: plan.revision, fence: plan.activation!.fence, from: 'rollback-pending', to: 'rolled-back' }).status).toBe('rolled-back')
  } finally { store.close() }
})

test('migrates a genuine v18 ledger without changing existing owner release or FK integrity', async () => {
  const f = await fixture(true), path = f.options.trust.ledger.path
  const db = new DatabaseSync(path)
  try { db.exec('DROP TABLE source_adoptions; PRAGMA user_version = 18;') } finally { db.close() }
  const migrated = openControlPlaneDatabase(path)
  try {
    expect(migrated.prepare('PRAGMA user_version').get()?.user_version).toBe(controlPlaneSchemaVersion)
    expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(migrated.prepare('SELECT id FROM source_plans WHERE id = ?').get(f.plan.id)?.id).toBe(f.plan.id)
    expect(migrated.prepare('SELECT COUNT(*) AS n FROM source_adoptions').get()?.n).toBe(0)
  } finally { migrated.close() }
})


test('independent finite signer reads the real completed release binding and its receipt authorizes the exact plan', async () => {
  const f = await released(), keys = generateKeyPairSync('ed25519')
  const keyPath = join(f.root, 'adoption.pem')
  await writeFile(keyPath, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
  const ref = f.store.getOwnerTaskFailureReference(f.activation.gapId)!, owner = ref.owner, candidate = f.activation.candidate
  const config: SourceAdoptionAuthorityConfig = { schemaVersion: 1, authority: 'owner-adoption', keyId: 'adoption-key', keyPath,
    statePath: join(f.root, 'authority.sqlite'), controlDatabasePath: f.options.trust.ledger.path,
    grant: { id: 'finite-adoptions', expiresAt: Date.now() + 60_000, maxAdoptions: 1,
      owner: { authorityId: owner.authorityId, authorityHash: owner.authorityHash, principalId: owner.principalId,
        principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion, workspace: owner.workspace, agentPreset: owner.agentPreset },
      installationId: f.activation.installationId, ledger: f.activation.ledger, target: f.activation.target,
      executor: f.activation.executor, catalogPath: f.options.trust.catalog.path, receiptTtlMs: 60_000,
      policies: [{ candidateId: candidate.id, packageName: candidate.package, dshBaseline: candidate.dshBaseline,
        capabilities: candidate.capabilities, authorities: candidate.authorities, requires: candidate.requires,
        registryId: candidate.registry!.id, registryLocator: candidate.registry!.locator }] } }
  const request = { protocol: 'dsh-source-adoption/v1' as const, planId: f.activation.id,
    planDigest: f.activation.digest, sourceReferenceDigest: controlPlaneDigest(ref) }
  const receipt = await authorizeSourceAdoption(config, request)
  expect(await authorizeSourceAdoption(config, request)).toEqual(receipt)
  if (process.platform === 'linux') {
    const configPath = join(f.root, 'adoption.json'), node = join(f.root, 'node')
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
    await copyFile(process.execPath, node); await chmod(node, 0o700)
    const wrapper = join(process.cwd(), 'bin/dsh-source-adoption-authority.js')
    const digest = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex')
    expect(await requestSourceAuthorityReceipt({ executable: { path: wrapper, sha256: await digest(wrapper) },
      interpreter: { path: node, sha256: await digest(node) }, configPath, timeoutMs: 10_000 }, request, parseApprovalReceipt)).toEqual(receipt)
  }
  const result = await f.store.approve({ planId: f.activation.id, expectedRevision: f.activation.revision, receipt,
    idempotencyKey: 'signed-adoption', withSourceFence: f.options.withSourceFence!,
    resolveAuthority: () => new Ed25519ApprovalAuthority(keys.publicKey.export({ type: 'spki', format: 'pem' }), config.authority, config.keyId) })
  expect(result.result.status).toBe('approved')
})

test('recovery cannot steal a live installer lease but can stop an expired installer after source withdrawal', async () => {
  const f = await released(), auth = approval(f.activation)
  let current = true, now = Date.now()
  const store = new ControlPlaneStore({ path: f.options.trust.ledger.path, now: () => now, withOwnerActivationFence: (_gap, callback) => {
    if (!current) throw new Error('withdrawn'); return callback()
  } })
  try {
    let plan = (await store.approve({ planId: f.activation.id, expectedRevision: 1, idempotencyKey: 'adoption-approve', ...auth })).result
    plan = await store.claimActivation({ planId: plan.id, expectedRevision: plan.revision, leaseMs: 60_000, resolveApprovalAuthority: auth.resolveAuthority })
    const request = { planId: plan.id, expectedRevision: plan.revision, fence: plan.activation!.fence, failureCode: 'source-withdrawn' }
    current = false
    expect(() => store.requestActivationRollback(request)).toThrow('fence')
    // Host attestation may already have entered commit-pending with no installer lease.
    const db = new DatabaseSync(f.options.trust.ledger.path)
    try { db.prepare("UPDATE activation_plans SET status = 'commit-pending', activation_lease_until = NULL WHERE id = ?").run(plan.id) } finally { db.close() }
    now += 60_001
    const rollback = store.requestActivationRollback(request)
    expect(rollback.status).toBe('rollback-pending')
    expect(() => store.requestActivationRollback(request)).toThrow('fence')
  } finally { store.close() }
})
