import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmod, mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { hostAttestationEvidenceDigest, hostAttestationRequestDigest, hostAttestationSigningPayload } from '../../src/attestation.js'
import type { RuntimeObservation } from '../../src/runtime-observer-protocol.js'
import type { PluginControlTrustConfig } from '../../src/trust.js'
import type { HostAttestationOperation, HostAttestationReceipt, HostAttestationRequest, PluginActivationPlan } from '../../src/types.js'

function canonical(value: unknown): string { return Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value !== null && typeof value === 'object' ? `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value) }
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }

/** Creates a private retained systemd readiness row for integration tests. Caller removes root. */
export async function createReadinessFixture(inputPlan?: PluginActivationPlan) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'dsh-readiness-')); await chmod(root, 0o700)
  const journalPath = join(root, 'reload.sqlite'), now = Date.now(), profilePath = inputPlan?.target.profilePath ?? '/tmp/dsh-profile'
  const plan = inputPlan ?? { id: 'plan-1', digest: 'e'.repeat(64), installationId: '123e4567-e89b-42d3-a456-426614174001', createdAt: now - 2_000, ledger: { id: '123e4567-e89b-42d3-a456-426614174002', path: '/tmp/ledger' }, target: { profilePath }, profile: 'default', activation: { id: 'activation-1', fence: 3 }, candidate: { package: '@scope/plugin', version: '1.2.3', integrity: 'sha512-test' } } as PluginActivationPlan
  const runtime: RuntimeObservation = { schemaVersion: 1, kind: 'dsh-runtime-observation', observerId: '123e4567-e89b-42d3-a456-426614174000', observerConfigDigest: 'a'.repeat(64), challenge: 'b'.repeat(64), processId: 42, invocationId: 'c'.repeat(32), profilePath, observedAt: now, entries: [{ entryId: 'plugin', module: plan.candidate.package, configDigest: 'd'.repeat(64), active: true, instance: { uid: 7, epoch: 2 }, dependencies: [{ name: 'loader', instance: { uid: 8, epoch: 1 } }], services: [{ name: 'example', instance: { uid: 9, epoch: 4 } }] }] }
  if (!plan.activation) throw new Error('fixture requires an activated plan')
  const observedAt = inputPlan ? Math.max(now - 1, plan.createdAt) : now - 900
  const request: HostAttestationRequest = { schemaVersion: 2, kind: 'dsh-host-attestation-request', operationId: 'readiness-1', requestedAt: observedAt - 100, receiptTtlMs: 1_000, installationId: plan.installationId, ledger: plan.ledger, plan: { id: plan.id, digest: plan.digest }, activation: { id: plan.activation.id, fence: plan.activation.fence }, profile: { name: plan.profile, path: runtime.profilePath }, issuer: { mode: 'configured-executable', id: 'attestor', version: '1', path: '/tmp/attestor', sha256: 'f'.repeat(64), interpreter: null, authority: 'host', keyId: 'key-1' }, phase: 'readiness', requirements: { kind: 'readiness', minimumChecks: 1 }, predecessor: { operationId: 'reload-1', receiptId: 'receipt:reload-1', phase: 'reload', receiptDigest: '0'.repeat(64), hostGeneration: 5 } }
  const { challenge: _challenge, observedAt: _observedAt, ...stable } = runtime
  const observation = { schemaVersion: 1, requestDigest: hostAttestationRequestDigest(request), configDigest: '1'.repeat(64), reload: { operationId: 'reload-1' }, channelDigest: '2'.repeat(64), runtime: stable, samples: [{ ok: true }], stableWindowMs: 1, observedAt: now - 1_000 }
  const keys = generateKeyPairSync('ed25519'), evidence = { kind: 'readiness' as const, checks: 1, failures: 0, probeDigest: digest(observation) }
  const unsigned = { schemaVersion: 2 as const, receiptId: 'receipt:readiness-1', authority: 'host', keyId: 'key-1', installationId: plan.installationId, planId: plan.id, planDigest: plan.digest, activationId: plan.activation.id, fence: plan.activation.fence, operationId: request.operationId, requestDigest: hostAttestationRequestDigest(request), phase: 'readiness' as const, outcome: 'passed' as const, hostGeneration: 5, evidence, evidenceDigest: hostAttestationEvidenceDigest(evidence), observedAt, expiresAt: inputPlan ? observedAt + 800 : now - 100 }
  const receipt: HostAttestationReceipt = { ...unsigned, signature: sign(null, Buffer.from(hostAttestationSigningPayload(unsigned)), keys.privateKey).toString('base64') }
  const operation: HostAttestationOperation = { planId: plan.id, phase: 'readiness', operationId: request.operationId, bindingDigest: '3'.repeat(64), requestDigest: receipt.requestDigest, request, status: 'applied', receipt, createdAt: request.requestedAt, appliedAt: observedAt }
  const trust = { schemaVersion: 1, installationId: plan.installationId, ledger: plan.ledger, hostAttestationKeys: [{ authority: 'host', keyId: 'key-1', publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] } as unknown as PluginControlTrustConfig
  const db = new DatabaseSync(journalPath); db.exec('CREATE TABLE readiness (operation_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, config_digest TEXT NOT NULL, reload_id TEXT NOT NULL, observation TEXT, receipt TEXT)'); db.prepare('INSERT INTO readiness VALUES (?, ?, ?, ?, ?, ?)').run(request.operationId, receipt.requestDigest, '4'.repeat(64), 'reload-1', JSON.stringify(observation), JSON.stringify(receipt)); db.close(); await chmod(journalPath, 0o600)
  return { root, journalPath, plan, operation, receipt, trust, runtime, observation }
}
