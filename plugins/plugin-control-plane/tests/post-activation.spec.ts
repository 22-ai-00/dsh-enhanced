import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
  activationRetractionSigningPayload,
  Ed25519ActivationRetractionAuthority,
  Ed25519PostActivationObservationAuthority,
  parseActivationRetraction,
  parsePostActivationObservation,
  postActivationEvidenceDigest,
  postActivationObservationSigningPayload,
} from '../src/post-activation.ts'
import type {
  ActivationRetractionReceipt,
  PluginActivationPlan,
  PostActivationObservationReceipt,
  WatchExactTarget,
} from '../src/types.ts'
import { ControlPlaneStoreError } from '../src/store.ts'

const installationId = '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00'
const now = 1_800_000_000_000

const exact: WatchExactTarget = {
  package: '@dsh-enhanced/assistant-health',
  version: '0.1.3',
  integrity: 'sha512-GcNqvjjSul+jrx52dFzxsKASPXUeMDi+ia40DXXI77rZQaqWc6O49iOPCXkrbo43pbsZmCY5cpjb1zLtWLkuQA==',
}

// Only the fields the receipt verifiers bind to; the watch lifecycle never accepts
// a receipt that is not pinned to this exact plan digest and activation fence.
const plan = {
  id: 'plan-0001',
  digest: 'a'.repeat(64),
  installationId,
  createdAt: now - 1_000,
  activation: { id: 'act-0001', fence: 7 },
} as unknown as PluginActivationPlan

function hostKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { privateKey, publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }) as string }
}

function ownerKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { privateKey, publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }) as string }
}

function observation(
  key: ReturnType<typeof hostKey>,
  overrides: Partial<PostActivationObservationReceipt> = {},
): PostActivationObservationReceipt {
  const disposition = overrides.disposition ?? 'healthy'
  const failures = overrides.evidence?.failures ?? (disposition === 'regressed' ? 1 : 0)
  const evidence = { kind: 'post-activation-health' as const, checks: 4, failures, probeDigest: 'b'.repeat(64) }
  const unsigned = {
    schemaVersion: 1 as const,
    observationId: 'obs-0001',
    authority: 'host-runtime',
    keyId: 'host-key-1',
    installationId,
    planId: plan.id,
    planDigest: plan.digest,
    activationId: 'act-0001',
    fence: 7,
    package: exact.package,
    version: exact.version,
    integrity: exact.integrity,
    disposition,
    evidence,
    evidenceDigest: postActivationEvidenceDigest(evidence),
    hostGeneration: 12,
    observedAt: now,
    expiresAt: now + 10_000,
    ...overrides,
  }
  return { ...unsigned, signature: sign(null, Buffer.from(postActivationObservationSigningPayload(unsigned)), key.privateKey).toString('base64') }
}

function retraction(
  key: ReturnType<typeof ownerKey>,
  overrides: Partial<ActivationRetractionReceipt> = {},
): ActivationRetractionReceipt {
  const unsigned = {
    schemaVersion: 1 as const,
    retractionId: 'retract-0001',
    authority: 'owner-policy',
    keyId: 'owner-key-1',
    installationId,
    planId: plan.id,
    planDigest: plan.digest,
    activationId: 'act-0001',
    fence: 7,
    package: exact.package,
    version: exact.version,
    integrity: exact.integrity,
    principal: 'owner@example.test',
    reason: 'post-canary regression accepted by owner',
    decidedAt: now,
    expiresAt: now + 600_000,
    ...overrides,
  }
  return { ...unsigned, signature: sign(null, Buffer.from(activationRetractionSigningPayload(unsigned)), key.privateKey).toString('base64') }
}

describe('post-activation observation receipt', () => {
  test('positive (healthy) evidence verifies and stays positive', async () => {
    const key = hostKey()
    const receipt = observation(key)
    const authority = new Ed25519PostActivationObservationAuthority(key.publicKeyPem, 'host-runtime', 'host-key-1', {}, () => now)
    const verified = await authority.verify(receipt, plan, exact)
    expect(verified.disposition).toBe('healthy')
    expect(verified.evidence.failures).toBe(0)
    expect(verified.signatureDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(() => parsePostActivationObservation(receipt)).not.toThrow()
  })

  test('regressed evidence verifies and reports at least one failure', async () => {
    const key = hostKey()
    const receipt = observation(key, { disposition: 'regressed' })
    const authority = new Ed25519PostActivationObservationAuthority(key.publicKeyPem, 'host-runtime', 'host-key-1', {}, () => now)
    const verified = await authority.verify(receipt, plan, exact)
    expect(verified.disposition).toBe('regressed')
    expect(verified.evidence.failures).toBeGreaterThan(0)
  })

  test('a healthy disposition with a failure counter is rejected at parse time', () => {
    const key = hostKey()
    const evidence = { kind: 'post-activation-health' as const, checks: 4, failures: 2, probeDigest: 'b'.repeat(64) }
    const receipt = observation(key, { disposition: 'healthy', evidence, evidenceDigest: postActivationEvidenceDigest(evidence) })
    expect(() => parsePostActivationObservation(receipt)).toThrow(ControlPlaneStoreError)
  })

  test('a regressed disposition with zero failures is rejected', () => {
    const key = hostKey()
    const evidence = { kind: 'post-activation-health' as const, checks: 4, failures: 0, probeDigest: 'b'.repeat(64) }
    const receipt = observation(key, { disposition: 'regressed', evidence, evidenceDigest: postActivationEvidenceDigest(evidence) })
    expect(() => parsePostActivationObservation(receipt)).toThrow(/disposition/u)
  })

  test('a forged evidence digest is rejected', () => {
    const key = hostKey()
    const receipt = observation(key, { evidenceDigest: 'c'.repeat(64) })
    expect(() => parsePostActivationObservation(receipt)).toThrow(/evidence digest/u)
  })

  test('failures above checks is rejected', () => {
    const key = hostKey()
    const evidence = { kind: 'post-activation-health' as const, checks: 1, failures: 2, probeDigest: 'b'.repeat(64) }
    const receipt = observation(key, { disposition: 'regressed', evidence, evidenceDigest: postActivationEvidenceDigest(evidence) })
    expect(() => parsePostActivationObservation(receipt)).toThrow(/failures exceed checks/u)
  })

  test('an observation pinned to a different exact package version conflicts', async () => {
    const key = hostKey()
    const receipt = observation(key, { version: '0.1.4' })
    const authority = new Ed25519PostActivationObservationAuthority(key.publicKeyPem, 'host-runtime', 'host-key-1', {}, () => now)
    await expect(authority.verify(receipt, plan, exact)).rejects.toThrow(/exact installation/u)
  })

  test('an observation for a different activation fence conflicts', async () => {
    const key = hostKey()
    const receipt = observation(key, { fence: 8 })
    const authority = new Ed25519PostActivationObservationAuthority(key.publicKeyPem, 'host-runtime', 'host-key-1', {}, () => now)
    await expect(authority.verify(receipt, plan, exact)).rejects.toThrow(/fence/u)
  })

  test('a receipt signed by the owner root is not a valid Host observation', async () => {
    const owner = ownerKey()
    // Signed by the owner key but claims the host authority: signature check must fail
    // because the configured Host authority pins a different public key.
    const receipt = observation(owner as unknown as ReturnType<typeof hostKey>)
    const host = hostKey()
    const authority = new Ed25519PostActivationObservationAuthority(host.publicKeyPem, 'host-runtime', 'host-key-1', {}, () => now)
    await expect(authority.verify(receipt, plan, exact)).rejects.toThrow(/signature is invalid/u)
  })

  test('a tampered signature is rejected', async () => {
    const key = hostKey()
    const receipt = observation(key)
    receipt.signature = Buffer.alloc(88, 'A').toString('base64')
    const authority = new Ed25519PostActivationObservationAuthority(key.publicKeyPem, 'host-runtime', 'host-key-1', {}, () => now)
    await expect(authority.verify(receipt, plan, exact)).rejects.toThrow(/signature is invalid/u)
  })

  test('an observation after its expiry is rejected', async () => {
    const key = hostKey()
    const receipt = observation(key)
    const authority = new Ed25519PostActivationObservationAuthority(key.publicKeyPem, 'host-runtime', 'host-key-1', {}, () => now + 11_000)
    await expect(authority.verify(receipt, plan, exact)).rejects.toThrow(/validity interval/u)
  })

  test('an observation whose validity window exceeds the TTL is rejected', async () => {
    const key = hostKey()
    const receipt = observation(key, { expiresAt: now + 120_000 })
    const authority = new Ed25519PostActivationObservationAuthority(key.publicKeyPem, 'host-runtime', 'host-key-1', { receiptTtlMs: 30_000 }, () => now)
    await expect(authority.verify(receipt, plan, exact)).rejects.toThrow(/validity interval/u)
  })

  test('unknown or missing fields are rejected', () => {
    const key = hostKey()
    const receipt = { ...observation(key), unexpected: 1 } as unknown
    expect(() => parsePostActivationObservation(receipt)).toThrow(/unknown or missing/u)
  })
})

describe('activation retraction receipt', () => {
  test('an owner-signed retraction verifies against the exact pinned package', async () => {
    const key = ownerKey()
    const receipt = retraction(key)
    const authority = new Ed25519ActivationRetractionAuthority(key.publicKeyPem, 'owner-policy', 'owner-key-1', {}, () => now)
    const verified = await authority.verify(receipt, plan, exact)
    expect(verified.reason).toContain('regression')
    expect(verified.signatureDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(() => parseActivationRetraction(retraction(key))).not.toThrow()
  })

  test('principal is NFC-normalized and trimmed', async () => {
    const key = ownerKey()
    const receipt = retraction(key, { principal: '   owner@example.test  ' })
    const authority = new Ed25519ActivationRetractionAuthority(key.publicKeyPem, 'owner-policy', 'owner-key-1', {}, () => now)
    const verified = await authority.verify(receipt, plan, exact)
    expect(verified.principal).toBe('owner@example.test')
  })

  test('a blank reason is rejected', () => {
    const key = ownerKey()
    expect(() => parseActivationRetraction(retraction(key, { reason: '   ' }))).toThrow(/values are invalid/u)
  })

  test('a retraction pinned to a different integrity conflicts', async () => {
    const key = ownerKey()
    const receipt = retraction(key, { integrity: 'sha512-' + 'Z'.repeat(86) })
    const authority = new Ed25519ActivationRetractionAuthority(key.publicKeyPem, 'owner-policy', 'owner-key-1', {}, () => now)
    await expect(authority.verify(receipt, plan, exact)).rejects.toThrow(/pinned package/u)
  })

  test('a retraction signed by the Host root is rejected by the owner authority', async () => {
    const host = hostKey()
    const receipt = retraction(host as unknown as ReturnType<typeof ownerKey>)
    const owner = ownerKey()
    const authority = new Ed25519ActivationRetractionAuthority(owner.publicKeyPem, 'owner-policy', 'owner-key-1', {}, () => now)
    await expect(authority.verify(receipt, plan, exact)).rejects.toThrow(/signature is invalid/u)
  })

  test('a tampered retraction signature is rejected', async () => {
    const key = ownerKey()
    const receipt = retraction(key)
    receipt.signature = Buffer.alloc(88, 'B').toString('base64')
    const authority = new Ed25519ActivationRetractionAuthority(key.publicKeyPem, 'owner-policy', 'owner-key-1', {}, () => now)
    await expect(authority.verify(receipt, plan, exact)).rejects.toThrow(/signature is invalid/u)
  })

  test('a retraction decided before plan creation is rejected', async () => {
    const key = ownerKey()
    const receipt = retraction(key, { decidedAt: plan.createdAt - 1 })
    const authority = new Ed25519ActivationRetractionAuthority(key.publicKeyPem, 'owner-policy', 'owner-key-1', {}, () => now)
    await expect(authority.verify(receipt, plan, exact)).rejects.toThrow(/validity interval/u)
  })
})
