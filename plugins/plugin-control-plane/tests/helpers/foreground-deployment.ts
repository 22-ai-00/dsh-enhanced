import { rm } from 'node:fs/promises'
import { generateKeyPairSync, sign } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ForegroundExecution, ForegroundTaskIdentity } from '@dsh-enhanced/assistant-delivery'
import { advanceSourceRelease } from '../../src/source-release-runner.ts'
import { loadCatalogWithMetadata } from '../../src/catalog.ts'
import { controlPlaneDigest } from '../../src/store.ts'
import { approvalSigningPayload, Ed25519ApprovalAuthority } from '../../src/approval.ts'
import { createForegroundDeploymentObserver } from '../../src/foreground-deployment-runtime.ts'
import { createReadinessFixture } from './deployment-readiness.ts'
import { cleanupReleaseFixtures, fixture as releaseFixture } from './source-release-runner.ts'

const roots: string[] = []
export async function cleanupForegroundDeploymentFixtures() { await cleanupReleaseFixtures(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) }

export async function foregroundDeploymentFixture() {
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
