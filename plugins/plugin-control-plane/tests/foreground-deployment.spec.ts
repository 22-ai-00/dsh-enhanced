import { rm } from 'node:fs/promises'
import { generateKeyPairSync, sign } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import type { ForegroundExecution, ForegroundTaskIdentity } from '@dsh-enhanced/assistant-delivery'
import * as release from '../src/release.ts'
import { advanceSourceRelease } from '../src/source-release-runner.ts'
import { loadCatalogWithMetadata } from '../src/catalog.ts'
import { ControlPlaneStore, controlPlaneDigest } from '../src/store.ts'
import { approvalSigningPayload, Ed25519ApprovalAuthority } from '../src/approval.ts'
import { createForegroundDeploymentObserver } from '../src/foreground-deployment-runtime.ts'
import { controlPlaneSchemaVersion, openControlPlaneDatabase } from '../src/sqlite.ts'
import { createReadinessFixture } from './helpers/deployment-readiness.ts'
import { cleanupReleaseFixtures, fixture as releaseFixture } from './helpers/source-release-runner.ts'

vi.mock('../src/release.ts', async original => ({ ...await original<typeof release>(), invokeSourceReleaseAdapter: vi.fn() }))
const roots: string[] = []
afterEach(async () => { await cleanupReleaseFixtures(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const f = await releaseFixture(true)
  await advanceSourceRelease(f.options); await f.decide(); await advanceSourceRelease(f.options)
  const source = f.store.getSourcePlan(f.plan.id), candidate = f.store.sourceReleaseCandidate(source.id)
  const catalog = await loadCatalogWithMetadata(f.options.trust.catalog.path)
  let plan = f.options.withSourceFence!(() => f.store.createPlan({ sourcePlanId: source.id, gapId: source.gapId, candidate,
    catalog: { digest: catalog.digest, provenance: catalog.provenance }, matchedCapabilities: candidate.capabilities,
    profile: 'web', target: { dshHome: f.root, profile: 'web', profilePath: join(f.root, 'profiles', 'web') },
    installationId: f.options.trust.installationId, ledger: f.options.trust.ledger,
    executor: { id: 'dsh', version: '1', path: join(f.root, 'dsh'), sha256: 'c'.repeat(64) }, ttlMs: 60_000, idempotencyKey: 'adoption' })).result
  // Seed an already deployed checkpoint. Activation itself is exercised by the
  // activation/adoption suites; this suite tests subsequent foreground usage.
  const keys = generateKeyPairSync('ed25519'), unsigned = { schemaVersion: 1 as const, approvalId: 'approval', authority: 'owner', keyId: 'key',
    planId: plan.id, planDigest: plan.digest, decision: 'approved' as const, principal: 'owner', decidedAt: Date.now(), expiresAt: plan.expiresAt }
  const approval = await new Ed25519ApprovalAuthority(keys.publicKey.export({ format: 'pem', type: 'spki' }), 'owner', 'key').verify({ ...unsigned,
    signature: sign(null, Buffer.from(approvalSigningPayload(unsigned)), keys.privateKey).toString('base64') }, plan)
  const db = new DatabaseSync(plan.ledger.path)
  try {
    db.prepare("UPDATE activation_plans SET status = 'activated', approval_json = ?, activation_id = 'activation', activation_fence = 1 WHERE id = ?")
      .run(JSON.stringify(approval), plan.id)
    plan = f.store.getPlan(plan.id)
    const started = Date.now() - 1
    db.prepare(`INSERT INTO activation_watch (plan_id, package_name, package_version, package_integrity, activation_id, fence, state,
      revision, last_host_generation, healthy_observations, started_at, updated_at) VALUES (?, ?, ?, ?, 'activation', 1, 'watching', 1, 5, 0, ?, ?)`)
      .run(plan.id, candidate.package, candidate.version, candidate.integrity, started, started)
    db.prepare('INSERT INTO activation_deployment_checkpoints VALUES (?, ?, 1, 1, ?, ?)').run(plan.id, '[]', started, started)
  } finally { db.close() }
  const signed = await createReadinessFixture(plan); roots.push(signed.root)
  const op = signed.operation, { operationId: _id, requestedAt: _time, ...binding } = op.request
  const ledger = new DatabaseSync(plan.ledger.path)
  try {
    ledger.prepare(`INSERT INTO host_attestation_operations (plan_id, phase, operation_id, binding_digest, request_digest,
      request_json, status, receipt_digest, receipt_json, created_at, completed_at, applied_at)
      VALUES (?, 'readiness', ?, ?, ?, ?, 'applied', ?, ?, ?, ?, ?)`).run(plan.id, op.operationId, controlPlaneDigest(binding),
      controlPlaneDigest(op.request), JSON.stringify(op.request), controlPlaneDigest(signed.receipt), JSON.stringify(signed.receipt), op.createdAt, op.appliedAt!, op.appliedAt!)
    ledger.prepare('INSERT INTO host_attestations VALUES (?, ?, ?, ?, ?, ?, ?)').run(plan.id, 'readiness', signed.receipt.receiptId,
      controlPlaneDigest(signed.receipt), JSON.stringify(signed.receipt), signed.receipt.hostGeneration, signed.receipt.observedAt)
  } finally { ledger.close() }
  const task: ForegroundTaskIdentity = { protocol: 'assistant-delivery/foreground-task/v1', inboxId: 'inbox', sessionId: 'session',
    scope: { workspace: f.root, preset: 'primary' }, owner: { principalRecordId: 'record', principalVersion: 1 },
    binding: { id: 'binding', version: 1, generation: 1 }, dispatchedAt: Date.now() }
  const execution = (): ForegroundExecution => ({ dispatchedAt: task.dispatchedAt, status: 'succeeded', quiescent: true,
    completedAt: Date.now(), executionRef: task.inboxId, modelSelectionState: 'frozen', modelSelection: { provider: 'user-provider', model: 'user-model' } })
  let current = true
  const observer = createForegroundDeploymentObserver({ config: { attestorJournalPath: signed.journalPath }, profilePath: plan.target.profilePath,
    store: f.store, trust: signed.trust, sample: challenge => ({ ...structuredClone(signed.runtime), challenge, observedAt: Date.now() }),
    assertCurrent: () => { if (!current) throw new Error('disposed') }, owner: { ownsForegroundTaskObservationRegistration: () => true } })
  return { ...f, plan, signed, task, execution, observer, dispose: () => { current = false } }
}

test('real signed readiness binds the current task and durable completion, without inventing quality', async () => {
  const f = await fixture(), handle = f.observer.begin(f.task)
  expect(f.store.getForegroundDeployment(f.task.inboxId)?.state).toBe('pending')
  f.observer.completed(handle, f.task, f.execution())
  const captured = f.store.getForegroundDeployment(f.task.inboxId)!
  expect(captured).toMatchObject({ state: 'observed', task: f.task, readiness: { planId: f.plan.id,
    exact: { package: f.plan.candidate.package, version: f.plan.candidate.version, integrity: f.plan.candidate.integrity } } })
  expect(f.store.getActivationWatch(f.plan.id)).toMatchObject({ state: 'watching', healthyObservations: 0 })
  const reopened = new ControlPlaneStore({ path: f.plan.ledger.path })
  try { expect(reopened.getForegroundDeployment(f.task.inboxId)).toEqual(captured) } finally { reopened.close() }
  expect(() => f.observer.begin(f.task)).toThrow()
})

test.each(['generation', 'unknown', 'superseded'] as const)('completion becomes unknown on %s', async mode => {
  const f = await fixture(), handle = f.observer.begin(f.task), execution = { ...f.execution() }
  if (mode === 'generation') f.signed.runtime.entries[0]!.instance!.epoch++
  if (mode === 'unknown') { execution.status = 'unknown'; execution.quiescent = false }
  if (mode === 'superseded') {
    const db = new DatabaseSync(f.plan.ledger.path)
    try { db.prepare('UPDATE activation_deployment_checkpoints SET successful_order = NULL WHERE plan_id = ?').run(f.plan.id) } finally { db.close() }
  }
  f.observer.completed(handle, f.task, execution)
  expect(f.store.getForegroundDeployment(f.task.inboxId)?.state).toBe('unknown')
})

test('rejects pre-deployment and cross-owner task attribution and suppresses late completion', async () => {
  const f = await fixture()
  expect(() => f.observer.begin({ ...f.task, owner: { ...f.task.owner, principalVersion: 2 } })).toThrow('owner')
  expect(() => f.observer.begin({ ...f.task, dispatchedAt: 1 })).toThrow('watched')
  const handle = f.observer.begin(f.task); f.dispose()
  expect(() => f.observer.completed(handle, f.task, f.execution())).toThrow('disposed')
  expect(f.store.getForegroundDeployment(f.task.inboxId)?.state).toBe('pending')
})

test('schema 19 migration preserves adoption and does not backfill historical tasks', async () => {
  const f = await fixture(), db = new DatabaseSync(f.plan.ledger.path)
  try { db.exec('DROP TABLE foreground_deployments; PRAGMA user_version = 19;') } finally { db.close() }
  const migrated = openControlPlaneDatabase(f.plan.ledger.path)
  try {
    expect(migrated.prepare('PRAGMA user_version').get()?.user_version).toBe(controlPlaneSchemaVersion)
    expect(migrated.prepare('SELECT count(*) AS n FROM foreground_deployments').get()?.n).toBe(0)
    expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(migrated.prepare('SELECT activation_plan_id FROM source_adoptions').get()?.activation_plan_id).toBe(f.plan.id)
  } finally { migrated.close() }
})
