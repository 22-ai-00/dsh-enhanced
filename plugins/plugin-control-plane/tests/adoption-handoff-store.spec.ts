import { generateKeyPairSync, sign } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { approvalSigningPayload, Ed25519ApprovalAuthority } from '../src/approval.ts'
import { loadCatalogWithMetadata } from '../src/catalog.ts'
import * as release from '../src/release.ts'
import { advanceSourceRelease } from '../src/source-release-runner.ts'
import { ControlPlaneStore } from '../src/store.ts'
import { cleanupReleaseFixtures, fixture } from './helpers/source-release-runner.ts'

vi.mock('../src/release.ts', async original => ({ ...await original<typeof release>(), invokeSourceReleaseAdapter: vi.fn() }))
afterEach(cleanupReleaseFixtures)

const handoff = { schemaVersion: 1 as const, coordinatorId: 'handoff-host', maximumWindowMs: 60_000, commit: 'target-host' as const }

async function approvedHandoff() {
  const value = await fixture(true)
  await advanceSourceRelease(value.options); await value.decide(); await advanceSourceRelease(value.options)
  const source = value.store.getSourcePlan(value.plan.id), candidate = value.store.sourceReleaseCandidate(source.id)
  const catalog = await loadCatalogWithMetadata(value.options.trust.catalog.path)
  const created = value.options.withSourceFence!(() => value.store.createPlan({ sourcePlanId: source.id, gapId: source.gapId, candidate,
    catalog: { digest: catalog.digest, provenance: catalog.provenance }, matchedCapabilities: candidate.capabilities, profile: 'web',
    target: { dshHome: value.root, profile: 'web', profilePath: join(value.root, 'profiles', 'web') }, installationId: value.options.trust.installationId,
    ledger: value.options.trust.ledger, executor: { id: 'dsh', version: '1', path: join(value.root, 'dsh'), sha256: 'c'.repeat(64) },
    ttlMs: 60_000, idempotencyKey: 'handoff-owner', handoff })).result
  const keys = generateKeyPairSync('ed25519'), body = { schemaVersion: 1 as const, approvalId: 'handoff-approval', authority: 'owner', keyId: 'key',
    planId: created.id, planDigest: created.digest, decision: 'approved' as const, principal: 'owner', decidedAt: Date.now(), expiresAt: created.expiresAt }
  const receipt = { ...body, signature: sign(null, Buffer.from(approvalSigningPayload(body)), keys.privateKey).toString('base64') }
  const authority = new Ed25519ApprovalAuthority(keys.publicKey.export({ type: 'spki', format: 'pem' }), 'owner', 'key')
  const approved = (await value.store.approve({ planId: created.id, expectedRevision: created.revision, receipt, resolveAuthority: () => authority,
    idempotencyKey: 'handoff-approval', withSourceFence: value.options.withSourceFence! })).result
  return { ...value, approved, authority }
}

test('creates one immutable, source-bound finite handoff and preserves it across reopen', async () => {
  const value = await approvedHandoff()
  const first = value.options.withSourceFence!(() => value.store.prepareAdoptionHandoff({ planId: value.approved.id, expectedRevision: value.approved.revision }))
  const second = value.options.withSourceFence!(() => value.store.prepareAdoptionHandoff({ planId: value.approved.id, expectedRevision: value.approved.revision }))
  expect(second).toEqual(first); expect(first).toMatchObject({ planId: value.approved.id, planDigest: value.approved.digest, coordinatorId: handoff.coordinatorId })
  const reopened = new ControlPlaneStore({ path: value.options.trust.ledger.path, adoptionCoordinatorId: handoff.coordinatorId })
  try { expect(reopened.getAdoptionHandoff(value.approved.id)).toEqual(first); reopened.assertAdoptionHandoff(value.approved.id) } finally { reopened.close() }
})

test('rejects wrong coordinators, expiry, revocation, and dossier-term tampering', async () => {
  const value = await approvedHandoff()
  const record = value.options.withSourceFence!(() => value.store.prepareAdoptionHandoff({ planId: value.approved.id, expectedRevision: value.approved.revision }))
  const wrong = new ControlPlaneStore({ path: value.options.trust.ledger.path, adoptionCoordinatorId: 'other-host' })
  try { expect(() => wrong.assertAdoptionHandoff(value.approved.id)).toThrow('binding') } finally { wrong.close() }
  let now = record.expiresAt + 1
  const expired = new ControlPlaneStore({ path: value.options.trust.ledger.path, adoptionCoordinatorId: handoff.coordinatorId, now: () => now })
  try { expect(() => expired.assertAdoptionHandoff(value.approved.id)).toThrow('inactive') } finally { expired.close() }
  value.store.revokeAdoptionHandoff(value.approved.id)
  expect(() => value.store.assertAdoptionHandoff(value.approved.id)).toThrow('inactive')
  const db = new DatabaseSync(value.options.trust.ledger.path)
  try {
    db.prepare("UPDATE activation_plans SET dossier_json = json_set(dossier_json, '$.handoff.coordinatorId', 'tampered') WHERE id = ?").run(value.approved.id)
  } finally { db.close() }
  expect(() => value.store.getPlan(value.approved.id)).toThrow('digest')
  now += 1
})

test('coordinator can stage the handed-off version but only a current target can commit it', async () => {
  const value = await approvedHandoff(), path = value.options.trust.ledger.path
  const coordinator = new ControlPlaneStore({ path, adoptionCoordinatorId: handoff.coordinatorId })
  let current = true
  const target = new ControlPlaneStore({ path, withOwnerActivationFence: (_gap, callback) => {
    if (!current) throw new Error('feedback withdrawn')
    return callback()
  } })
  try {
    await expect(coordinator.claimActivation({ planId: value.approved.id, expectedRevision: value.approved.revision,
      leaseMs: 5000, resolveApprovalAuthority: () => value.authority })).rejects.toThrow('binding')
    value.options.withSourceFence!(() => value.store.prepareAdoptionHandoff({ planId: value.approved.id, expectedRevision: value.approved.revision }))
    let plan = await coordinator.claimActivation({ planId: value.approved.id, expectedRevision: value.approved.revision,
      leaseMs: 5000, resolveApprovalAuthority: () => value.authority })
    expect(plan.status).toBe('staging')
    expect(() => coordinator.withOwnerTaskFailureGapAdmission(plan.gapId, () => {})).toThrow('cannot create or approve')
    expect(() => coordinator.revokeAdoptionHandoff(plan.id)).toThrow('cannot revoke')
    // Isolate the final authority boundary; Host phase signatures have separate integration coverage.
    const db = new DatabaseSync(path)
    try { db.prepare("UPDATE activation_plans SET status='commit-pending', activation_lease_until=NULL WHERE id=?").run(plan.id) } finally { db.close() }
    plan = target.getPlan(plan.id)
    await expect(coordinator.claimActivation({ planId: plan.id, expectedRevision: plan.revision, leaseMs: 5000,
      resolveApprovalAuthority: () => value.authority })).rejects.toThrow('cannot advance')
    current = false
    await expect(target.claimActivation({ planId: plan.id, expectedRevision: plan.revision, leaseMs: 5000,
      resolveApprovalAuthority: () => value.authority })).rejects.toThrow('feedback withdrawn')
    current = true
    plan = await target.claimActivation({ planId: plan.id, expectedRevision: plan.revision, leaseMs: 5000,
      resolveApprovalAuthority: () => value.authority })
    expect(target.advanceActivation({ planId: plan.id, expectedRevision: plan.revision, fence: plan.activation!.fence,
      from: 'commit-pending', to: 'activated' }).status).toBe('activated')
  } finally { coordinator.close(); target.close() }
})

test('revocation while acquiring the writer lock prevents a new Host operation', async () => {
  const value = await approvedHandoff(), path = value.options.trust.ledger.path
  value.options.withSourceFence!(() => value.store.prepareAdoptionHandoff({ planId: value.approved.id, expectedRevision: value.approved.revision }))
  const coordinator = new ControlPlaneStore({ path, adoptionCoordinatorId: handoff.coordinatorId })
  try {
    let plan = await coordinator.claimActivation({ planId: value.approved.id, expectedRevision: value.approved.revision,
      leaseMs: 5000, resolveApprovalAuthority: () => value.authority })
    plan = coordinator.advanceActivation({ planId: plan.id, expectedRevision: plan.revision, fence: plan.activation!.fence,
      from: 'staging', to: 'awaiting-reload' })
    const exec = DatabaseSync.prototype.exec
    let raced = false
    const intercepted = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (!raced && sql === 'BEGIN IMMEDIATE') { raced = true; value.store.revokeAdoptionHandoff(plan.id) }
      return exec.call(this, sql)
    })
    try {
      expect(() => coordinator.prepareHostAttestationOperation({ planId: plan.id, expectedRevision: plan.revision,
        expectedFence: plan.activation!.fence, issuer: { mode: 'owner-manual' }, requirements: { kind: 'reload', previousHostGeneration: 0 }, receiptTtlMs: 1000 })).toThrow('inactive')
      expect(raced).toBe(true)
    } finally { intercepted.mockRestore() }
  } finally { coordinator.close() }
})
