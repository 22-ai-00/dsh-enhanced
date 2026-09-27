import { generateKeyPairSync, sign } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { runtimeEpochRequestDigest, runtimeEpochSigningPayload, type RuntimeEpochReceipt, type RuntimeEpochRequest } from '../../src/runtime-epoch.js'
import { controlPlaneDigest } from '../../src/store.js'
import type { RuntimeObservation } from '../../src/runtime-observer-protocol.js'
import type { PluginControlTrustConfig } from '../../src/trust.js'
import { createReadinessFixture } from './deployment-readiness.js'
import { hostAuthorizationPlan } from './host-authorization.js'
import { cleanupReleaseFixtures } from './source-release-runner.js'

const roots: string[] = []
export async function cleanupRuntimeEpochFixtures() {
  await cleanupReleaseFixtures()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
}

/** Real released owner source, activated checkpoint, signed original readiness, and a distinct epoch key. */
export async function createRuntimeEpochFixture() {
  const keys = generateKeyPairSync('ed25519')
  const issuer: RuntimeEpochRequest['issuer'] = { mode: 'configured-executable', id: 'epoch-attestor', version: '1',
    path: '/tmp/epoch-attestor', sha256: 'e'.repeat(64), interpreter: null, authority: 'epoch-authority', keyId: 'epoch-key' }
  const original = await hostAuthorizationPlan({ issuer })
  let plan = original.coordinator.recordActivationHostInputWitness(original.witnessInput)
  // Keep the signed approval before the historical readiness request's creation time.
  await new Promise(resolve => setTimeout(resolve, 120))
  const signed = await createReadinessFixture(plan); roots.push(signed.root)
  const db = new DatabaseSync(plan.ledger.path)
  try {
    const now = Date.now()
    db.exec('BEGIN IMMEDIATE')
    db.prepare("UPDATE activation_plans SET status='activated',activation_lease_until=NULL WHERE id=?").run(plan.id)
    db.prepare(`INSERT INTO activation_watch (plan_id,package_name,package_version,package_integrity,activation_id,fence,state,
      revision,last_host_generation,healthy_observations,started_at,updated_at)
      VALUES (?,?,?,?,?,?,'watching',1,?,0,?,?)`).run(plan.id, plan.candidate.package, plan.candidate.version,
      plan.candidate.integrity, plan.activation!.id, plan.activation!.fence, signed.receipt.hostGeneration, now, now)
    db.prepare('INSERT INTO activation_deployment_checkpoints VALUES (?,?,1,1,?,?)').run(plan.id, '[]', now, now)
    const operation = signed.operation
    const { operationId: _operationId, requestedAt: _requestedAt, ...binding } = operation.request
    db.prepare(`INSERT INTO host_attestation_operations (plan_id,phase,operation_id,binding_digest,request_digest,
      request_json,status,receipt_digest,receipt_json,created_at,completed_at,applied_at)
      VALUES (?,'readiness',?,?,?,?, 'applied',?,?,?,?,?)`).run(plan.id, operation.operationId, controlPlaneDigest(binding),
      controlPlaneDigest(operation.request), JSON.stringify(operation.request), controlPlaneDigest(signed.receipt),
      JSON.stringify(signed.receipt), operation.createdAt, operation.appliedAt!, operation.appliedAt!)
    db.prepare('INSERT INTO host_attestations VALUES (?,?,?,?,?,?,?)').run(plan.id, 'readiness', signed.receipt.receiptId,
      controlPlaneDigest(signed.receipt), JSON.stringify(signed.receipt), signed.receipt.hostGeneration, signed.receipt.observedAt)
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
  finally { db.close() }
  plan = original.f.store.getPlan(plan.id)
  const trust: PluginControlTrustConfig = { ...original.f.options.trust,
    hostAttestor: { ...issuer, timeoutMs: 10_000, environmentAllowlist: ['DSH_SYSTEMD_HOST_ATTESTOR_CONFIG'] },
    hostAttestationKeys: [...original.f.options.trust.hostAttestationKeys, ...signed.trust.hostAttestationKeys,
      { authority: issuer.authority, keyId: issuer.keyId, publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] }
  const signEpoch = (request: RuntimeEpochRequest, overrides: Partial<Omit<RuntimeEpochReceipt, 'signature'>> = {}): RuntimeEpochReceipt => {
    const observedAt = Date.now()
    const unsigned: Omit<RuntimeEpochReceipt, 'signature'> = { schemaVersion: 1, kind: 'dsh-runtime-epoch-receipt',
      receiptId: `receipt:${request.operationId}`, operationId: request.operationId,
      requestDigest: runtimeEpochRequestDigest(request), installationId: request.installationId,
      planId: request.plan.id, planDigest: request.plan.digest, activationId: request.activation.id, fence: request.activation.fence,
      hostGeneration: request.predecessor.hostGeneration, sequence: request.sequence,
      runtimeIdentityDigest: request.runtimeIdentityDigest, authority: issuer.authority, keyId: issuer.keyId,
      outcome: 'passed', observedAt, expiresAt: observedAt + request.receiptTtlMs,
      evidence: { checks: 2, failures: 0, probeDigest: 'f'.repeat(64) }, ...overrides }
    return { ...unsigned, signature: sign(null, Buffer.from(runtimeEpochSigningPayload(unsigned)), keys.privateKey).toString('base64') }
  }
  const runtime = (invocationId = signed.runtime.invocationId): RuntimeObservation => ({ ...structuredClone(signed.runtime),
    invocationId, challenge: 'a'.repeat(64), observedAt: Date.now() })
  return { ...original, plan, signed, issuer, trust, runtime, signEpoch }
}
