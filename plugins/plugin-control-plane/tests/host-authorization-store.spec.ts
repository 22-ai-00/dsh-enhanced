import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import * as release from '../src/release.ts'
import { controlPlaneSchemaVersion, openControlPlaneDatabase } from '../src/sqlite.ts'
import { ControlPlaneStore, readOwnerHostAttestationContext, validateHostDeploymentInputs } from '../src/store.ts'
import { cleanupReleaseFixtures } from './helpers/source-release-runner.ts'
import { hostAuthorizationPlan } from './helpers/host-authorization.ts'

vi.mock('../src/release.ts', async original => ({ ...await original<typeof release>(), invokeSourceReleaseAdapter: vi.fn() }))
afterEach(cleanupReleaseFixtures)

test('signed Host deployment inputs reject traversal, duplicates, and non-normal paths', () => {
  for (const invalid of [[], ['../secret'], ['/etc/passwd'], ['C:secret'], ['a//b'], ['a/./b'], ['a/../b'], ['a\\b'],
    ['a', 'a'], ['\u0000'], Array.from({ length: 129 }, (_, index) => `file-${index}`)]) {
    expect(() => validateHostDeploymentInputs(invalid)).toThrow()
  }
  expect(() => validateHostDeploymentInputs(['node_modules/.pnpm/host-entry/index.js'])).not.toThrow()
})

test('schema-24 migration preserves signed owner plan and witness is immutable before exposure', async () => {
  const value = await hostAuthorizationPlan()
  const { coordinator, plan, witnessInput } = value
  expect(() => coordinator.markActivationHostExposure({ planId: plan.id, expectedRevision: plan.revision,
    fence: plan.activation!.fence })).toThrow(/witness/u)
  const before = coordinator.getPlan(plan.id)
  expect(before.digest).toBe(plan.digest)
  const witnessPlan = coordinator.recordActivationHostInputWitness(witnessInput)
  const witness = coordinator.getActivationHostInputWitness(plan.id)
  expect(witness?.inputs).toEqual(plan.dossier.hostDeploymentInputs)
  expect(witness?.profileFiles).toEqual(witnessInput.profileFiles)
  expect(coordinator.recordActivationHostInputWitness(witnessInput)).toEqual(witnessPlan)
  expect(() => coordinator.recordActivationHostInputWitness({ ...witnessInput,
    deploymentFiles: witnessInput.deploymentFiles.map(file => ({ ...file, sha256: 'f'.repeat(64) })) })).toThrow(/immutable/u)
  expect(() => coordinator.recordActivationHostInputWitness({ ...witnessInput, fence: witnessInput.fence + 1 })).toThrow()
  const db = new DatabaseSync(plan.ledger.path)
  const original = db.prepare('SELECT approval_receipt_json, plan_digest FROM activation_plans WHERE id=?').get(plan.id) as
    {approval_receipt_json:string;plan_digest:string}
  db.exec('DROP TABLE activation_host_input_witnesses; PRAGMA user_version = 24')
  db.close()
  const migrated = openControlPlaneDatabase(plan.ledger.path)
  expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: controlPlaneSchemaVersion })
  expect(migrated.prepare('SELECT approval_receipt_json, plan_digest FROM activation_plans WHERE id=?').get(plan.id)).toEqual(original)
  expect(migrated.prepare('SELECT count(*) AS n FROM activation_host_input_witnesses').get()).toEqual({ n: 0 })
  migrated.close()
  const reopened = new ControlPlaneStore({ path: plan.ledger.path, adoptionCoordinatorId: value.handoff.coordinatorId })
  expect(reopened.getPlan(plan.id).digest).toBe(plan.digest)
  expect(() => reopened.markActivationHostExposure({ planId: plan.id, expectedRevision: plan.revision,
    fence: plan.activation!.fence })).toThrow(/witness/u)
  reopened.close()
})

test('read-only authority context requires a real claimed schema-2 operation and current owner witness', async () => {
  const value = await hostAuthorizationPlan()
  const { coordinator, plan } = value
  const beforeDb = new DatabaseSync(plan.ledger.path, { readOnly: true })
  expect(() => readOwnerHostAttestationContext(beforeDb, 'forged-operation')).toThrow()
  beforeDb.close()
  const active = await value.exposeAndClaimReload()
  try {
    const db = new DatabaseSync(plan.ledger.path, { readOnly: true })
    try {
      const context = readOwnerHostAttestationContext(db, active.operation.operationId)
      expect(context.plan.id).toBe(plan.id)
      expect(context.sourcePlan.id).toBe(value.f.plan.id)
      expect(context.operation.request.schemaVersion).toBe(2)
      expect(context.dispatch.status).toBe('claimed')
      expect(context.witness.digest).toBe(coordinator.getActivationHostInputWitness(plan.id)?.digest)
    } finally { db.close() }
    const forged = new DatabaseSync(plan.ledger.path)
    forged.prepare('UPDATE host_attestation_dispatches SET status=?,completed_at=? WHERE operation_id=?')
      .run('completed', Date.now(), active.operation.operationId)
    forged.close()
    const rejected = new DatabaseSync(plan.ledger.path, { readOnly: true })
    try { expect(() => readOwnerHostAttestationContext(rejected, active.operation.operationId)).toThrow(/claimed/u) }
    finally { rejected.close() }
  } finally { await active.stop() }
})

test('historical witness authorizes exact physical rollback after handoff revocation, but not a stale forward fence', async () => {
  const value = await hostAuthorizationPlan()
  const { coordinator } = value
  let plan = coordinator.recordActivationHostInputWitness(value.witnessInput)
  plan = coordinator.markActivationHostExposure({ planId: plan.id, expectedRevision: plan.revision, fence: plan.activation!.fence })
  plan = coordinator.advanceActivation({ planId: plan.id, expectedRevision: plan.revision,
    fence: plan.activation!.fence, from: 'staging', to: 'awaiting-reload' })
  const oldFence = plan.activation!.fence
  plan = coordinator.requestActivationRollback({ planId: plan.id, expectedRevision: plan.revision,
    fence: oldFence, failureCode: 'fixture-failure' })
  plan = await coordinator.claimActivation({ planId: plan.id, expectedRevision: plan.revision,
    leaseMs: 60_000, resolveApprovalAuthority: () => value.approvalAuthority })
  expect(plan.activation!.fence).toBeGreaterThan(oldFence)
  expect(coordinator.getActivationHostInputWitness(plan.id)?.fence).toBe(oldFence)
  plan = coordinator.markRollbackProfileRestored({ planId: plan.id, expectedRevision: plan.revision, fence: plan.activation!.fence })
  const operation = coordinator.prepareHostAttestationOperation({ planId: plan.id, expectedRevision: plan.revision,
    expectedFence: plan.activation!.fence, issuer: { mode: 'owner-manual' }, receiptTtlMs: 10_000,
    requirements: { kind: 'rollback', previousHostGeneration: 0, action: 'stop', baselineFiles: [], minimumChecks: 1 } })
  const DB = new DatabaseSync(plan.ledger.path)
  DB.prepare('UPDATE adoption_handoffs SET revoked_at=? WHERE plan_id=?').run(Date.now(), plan.id)
  DB.close()
  let rejectExecution!: (reason?: unknown) => void
  const pending = new Promise<never>((_resolve, reject) => { rejectExecution = reject })
  const running = coordinator.runHostAttestationOperation({ operationId: operation.operationId,
    expectedRevision: plan.revision, expectedFence: plan.activation!.fence,
    execute: async () => pending, resolveAuthority: () => { throw new Error('not settled') } })
  try {
    const readonly = new DatabaseSync(plan.ledger.path, { readOnly: true })
    try {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(plan.expiresAt + 1)
      try {
        const context = readOwnerHostAttestationContext(readonly, operation.operationId)
        expect(context.operation.request.phase).toBe('rollback')
        expect(context.witness.fence).toBe(oldFence)
        expect(context.handoff.revokedAt).toBeDefined()
        expect(Date.now()).toBeGreaterThan(context.approvalReceipt.expiresAt)
      } finally { clock.mockRestore() }
    } finally { readonly.close() }
  } finally { rejectExecution(new Error('test stopped')); await running.catch(() => {}) }
})

test('a new staging claim cannot reuse a prior-fence witness after an interrupted attempt', async () => {
  const value = await hostAuthorizationPlan()
  const { coordinator } = value
  coordinator.recordActivationHostInputWitness(value.witnessInput)
  const db = new DatabaseSync(value.plan.ledger.path)
  db.prepare('UPDATE activation_plans SET activation_lease_until=1 WHERE id=?').run(value.plan.id)
  db.close()
  const retried = await coordinator.claimActivation({ planId: value.plan.id, expectedRevision: value.plan.revision,
    leaseMs: 60_000, resolveApprovalAuthority: () => value.approvalAuthority })
  expect(retried.activation!.fence).toBeGreaterThan(value.plan.activation!.fence)
  expect(() => coordinator.recordActivationHostInputWitness({ ...value.witnessInput,
    expectedRevision: retried.revision, fence: retried.activation!.fence })).toThrow()
  expect(() => coordinator.markActivationHostExposure({ planId: retried.id, expectedRevision: retried.revision,
    fence: retried.activation!.fence })).toThrow()
  expect(coordinator.getPlan(retried.id).activation?.hostRecoveryRequired).toBeUndefined()
})

test('a prepared but unclaimed operation cannot obtain the read-only signer context', async () => {
  const value = await hostAuthorizationPlan()
  const { coordinator } = value
  let plan = coordinator.recordActivationHostInputWitness(value.witnessInput)
  plan = coordinator.markActivationHostExposure({ planId: plan.id, expectedRevision: plan.revision, fence: plan.activation!.fence })
  plan = coordinator.advanceActivation({ planId: plan.id, expectedRevision: plan.revision,
    fence: plan.activation!.fence, from: 'staging', to: 'awaiting-reload' })
  const operation = coordinator.prepareHostAttestationOperation({ planId: plan.id, expectedRevision: plan.revision,
    expectedFence: plan.activation!.fence, issuer: { mode: 'owner-manual' },
    requirements: { kind: 'reload', previousHostGeneration: 0 }, receiptTtlMs: 10_000 })
  const readonly = new DatabaseSync(plan.ledger.path, { readOnly: true })
  try { expect(() => readOwnerHostAttestationContext(readonly, operation.operationId)).toThrow(/claimed/u) }
  finally { readonly.close() }
})
