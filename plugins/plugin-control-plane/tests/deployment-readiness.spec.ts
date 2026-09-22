import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmod, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { hostAttestationEvidenceDigest, hostAttestationRequestDigest, hostAttestationSigningPayload } from '../src/attestation.js'
import { captureRetainedDeploymentReadiness } from '../src/deployment-readiness.js'
import type { HostAttestationOperation, HostAttestationReceipt, HostAttestationRequest, PluginActivationPlan } from '../src/types.js'
import type { PluginControlTrustConfig } from '../src/trust.js'
import type { RuntimeObservation } from '../src/runtime-observer-protocol.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'dsh-readiness-')); roots.push(root); await chmod(root, 0o700)
  const journalPath = join(root, 'reload.sqlite'), now = Date.now()
  const runtime: RuntimeObservation = {
    schemaVersion: 1, kind: 'dsh-runtime-observation', observerId: '123e4567-e89b-42d3-a456-426614174000',
    observerConfigDigest: 'a'.repeat(64), challenge: 'b'.repeat(64), processId: 42, invocationId: 'c'.repeat(32),
    profilePath: '/tmp/dsh-profile', observedAt: now,
    entries: [{ entryId: 'plugin', module: '@scope/plugin', configDigest: 'd'.repeat(64), active: true, instance: { uid: 7, epoch: 2 },
      dependencies: [{ name: 'loader', instance: { uid: 8, epoch: 1 } }], services: [{ name: 'example', instance: { uid: 9, epoch: 4 } }] }],
  }
  const plan = { id: 'plan-1', digest: 'e'.repeat(64), installationId: '123e4567-e89b-42d3-a456-426614174001', createdAt: now - 2_000,
    ledger: { id: '123e4567-e89b-42d3-a456-426614174002', path: '/tmp/ledger' }, target: { profilePath: runtime.profilePath },
    activation: { id: 'activation-1', fence: 3 }, candidate: { package: '@scope/plugin', version: '1.2.3', integrity: 'sha512-test' } } as PluginActivationPlan
  const request: HostAttestationRequest = {
    schemaVersion: 2, kind: 'dsh-host-attestation-request', operationId: 'readiness-1', requestedAt: now - 1_500, receiptTtlMs: 1_000,
    installationId: plan.installationId, ledger: { id: '123e4567-e89b-42d3-a456-426614174002', path: '/tmp/ledger' }, plan: { id: plan.id, digest: plan.digest },
    activation: { id: plan.activation!.id, fence: plan.activation!.fence }, profile: { name: 'default', path: runtime.profilePath },
    issuer: { mode: 'configured-executable', id: 'attestor', version: '1', path: '/tmp/attestor', sha256: 'f'.repeat(64), interpreter: null, authority: 'host', keyId: 'key-1' },
    phase: 'readiness', requirements: { kind: 'readiness', minimumChecks: 1 },
    predecessor: { operationId: 'reload-1', receiptId: 'receipt:reload-1', phase: 'reload', receiptDigest: '0'.repeat(64), hostGeneration: 5 },
  }
  const { challenge: _challenge, observedAt: _observedAt, ...stable } = runtime
  const observation = { schemaVersion: 1, requestDigest: hostAttestationRequestDigest(request), configDigest: '1'.repeat(64), reload: { operationId: 'reload-1' },
    channelDigest: '2'.repeat(64), runtime: stable, samples: [{ ok: true }], stableWindowMs: 1, observedAt: now - 1_000 }
  const keys = generateKeyPairSync('ed25519')
  const unsigned = { schemaVersion: 2 as const, receiptId: 'receipt:readiness-1', authority: 'host', keyId: 'key-1', installationId: plan.installationId,
    planId: plan.id, planDigest: plan.digest, activationId: plan.activation!.id, fence: plan.activation!.fence, operationId: request.operationId,
    requestDigest: hostAttestationRequestDigest(request), phase: 'readiness' as const, outcome: 'passed' as const, hostGeneration: 5,
    evidence: { kind: 'readiness' as const, checks: 1, failures: 0, probeDigest: digest(observation) }, evidenceDigest: '', observedAt: now - 900, expiresAt: now - 100 }
  unsigned.evidenceDigest = hostAttestationEvidenceDigest(unsigned.evidence)
  const receipt: HostAttestationReceipt = { ...unsigned, signature: sign(null, Buffer.from(hostAttestationSigningPayload(unsigned)), keys.privateKey).toString('base64') }
  const operation: HostAttestationOperation = { planId: plan.id, phase: 'readiness', operationId: request.operationId, bindingDigest: '3'.repeat(64),
    requestDigest: request.plan.digest, request, status: 'applied', receipt, createdAt: now - 1_500, appliedAt: now - 800 }
  operation.requestDigest = hostAttestationRequestDigest(request)
  const trust = { schemaVersion: 1, installationId: plan.installationId, ledger: plan.ledger, hostAttestationKeys: [{ authority: 'host', keyId: 'key-1', publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] } as unknown as PluginControlTrustConfig
  const db = new DatabaseSync(journalPath)
  db.exec('CREATE TABLE readiness (operation_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, config_digest TEXT NOT NULL, reload_id TEXT NOT NULL, observation TEXT, receipt TEXT)')
  db.prepare('INSERT INTO readiness VALUES (?, ?, ?, ?, ?, ?)').run(request.operationId, receipt.requestDigest, '4'.repeat(64), 'reload-1', JSON.stringify(observation), JSON.stringify(receipt)); db.close()
  await chmod(journalPath, 0o600)
  return { journalPath, plan, operation, receipt, trust, runtime, observation }
}

describe('captureRetainedDeploymentReadiness', () => {
  it('binds a historically valid, currently expired signed readiness receipt', async () => {
    const f = await fixture()
    const before = await readdir(f.journalPath.slice(0, f.journalPath.lastIndexOf('/')))
    expect(captureRetainedDeploymentReadiness(f)).toMatchObject({ planId: f.plan.id, profilePath: f.runtime.profilePath,
      exact: { package: '@scope/plugin', version: '1.2.3', integrity: 'sha512-test' } })
    expect(await readdir(f.journalPath.slice(0, f.journalPath.lastIndexOf('/')))).toEqual(before)
  })

  it.each(['signature', 'digest', 'plan', 'request-profile', 'runtime', 'trust', 'oversized'] as const)('rejects %s drift', async kind => {
    const f = await fixture()
    if (kind === 'signature') f.receipt.signature = f.receipt.signature.slice(0, -2) + 'aa'
    if (kind === 'digest') { const db = new DatabaseSync(f.journalPath); db.prepare('UPDATE readiness SET observation = ?').run(JSON.stringify({ ...f.observation, samples: [] })); db.close() }
    if (kind === 'plan') f.plan.digest = '9'.repeat(64)
    if (kind === 'request-profile') (f.operation.request as HostAttestationRequest).profile.path = '/tmp/other-profile'
    if (kind === 'runtime') f.runtime.entries[0]!.instance!.epoch++
    if (kind === 'trust') (f.trust.ledger as { id: string }).id = '123e4567-e89b-42d3-a456-426614174099'
    if (kind === 'oversized') { const db = new DatabaseSync(f.journalPath); db.prepare('UPDATE readiness SET observation = ?').run(`{${' '.repeat(1024 * 1024)}}`); db.close() }
    expect(() => captureRetainedDeploymentReadiness(f)).toThrow('deployment readiness')
  })
})
