import { generateKeyPairSync, sign } from 'node:crypto'
import { expect, test } from 'vitest'
import { hostAttestationRequestDigest } from '../src/attestation.ts'
import { validateReplayCases } from '../src/effect-blocked-replay.ts'
import { replayGrantSigningPayload, verifyReplayGrant, type ReplayGrant, type ReplaySignedAuthority } from '../src/replay-grant.ts'
import { runtimeConfigDigest } from '../src/runtime-observer.ts'

const now = 1_800_000_000_000
const endpointDigest = runtimeConfigDigest({ endpoint: 'replay' })
const cases = [
  { id: 'tool-1', kind: 'tool' as const, name: 'search', arguments: { q: 'bounded' } },
  { id: 'delivery-1', kind: 'delivery' as const, text: 'blocked delivery' },
]

function fixture(configuredIssuer = false) {
  const key = generateKeyPairSync('ed25519')
  const request = {
    schemaVersion: 2 as const, kind: 'dsh-host-attestation-request' as const, operationId: 'replay-operation', requestedAt: now,
    receiptTtlMs: 30_000, installationId: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00',
    ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01', path: '/var/lib/dsh/control.sqlite' },
    plan: { id: 'plan-1', digest: 'a'.repeat(64) }, activation: { id: 'activation-1', fence: 2 },
    profile: { name: 'web', path: '/var/lib/dsh/profiles/web' }, issuer: configuredIssuer
      ? { mode: 'configured-executable' as const, id: 'host-attestor', version: '1.0.0', path: '/usr/local/bin/host-attestor', sha256: 'c'.repeat(64),
        interpreter: { path: '/usr/bin/node', sha256: 'd'.repeat(64) }, authority: 'host', keyId: 'host-key' }
      : { mode: 'owner-manual' as const },
    phase: 'effect-blocked-replay' as const,
    requirements: { kind: 'effect-blocked-replay' as const, minimumDeliveryAttempts: 1, minimumToolExecutionAttempts: 1, maximumExternalEffects: 0 as const },
    predecessor: { operationId: 'readiness-operation', receiptId: 'receipt-1', phase: 'readiness' as const, receiptDigest: 'b'.repeat(64), hostGeneration: 2 },
  }
  const authority: ReplaySignedAuthority = {
    mode: 'signed', authority: 'owner', keyId: 'owner-ed25519-1', publicKeyPem: key.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    scope: { installationId: request.installationId, ledger: request.ledger, plan: request.plan, activation: request.activation, profile: request.profile },
    notBefore: now, expiresAt: now + 60_000, maximumGrantMs: 10_000, cases,
  }
  const unsigned: Omit<ReplayGrant, 'signature'> = { schemaVersion: 1, kind: 'dsh-effect-replay-grant', authority: authority.authority,
    keyId: authority.keyId, request, endpointDigest, caseDigest: validateReplayCases(cases).caseDigest,
    processId: 999, invocationId: null, notBefore: now + 1, expiresAt: now + 5_000 }
  const grant: ReplayGrant = { ...unsigned, signature: sign(null, Buffer.from(replayGrantSigningPayload(unsigned)), key.privateKey).toString('base64') }
  const binding = { endpointDigest, caseDigest: grant.caseDigest, profilePath: request.profile.path, operationId: request.operationId,
    requestDigest: hostAttestationRequestDigest(request) }
  return { key, authority, grant, binding }
}

test('verifies a signed grant tied to its scope and host request', () => {
  const f = fixture()
  const verified = verifyReplayGrant(f.grant, f.authority, f.binding, now + 2)
  expect(verified).toEqual({ scopeDigest: runtimeConfigDigest(f.authority.scope), grantDigest: expect.any(String), expiresAt: f.grant.expiresAt })
  expect(verified.grantDigest).toHaveLength(64)
})

test('accepts the exact configured-executable issuer shape', () => {
  const f = fixture(true)
  expect(verifyReplayGrant(f.grant, f.authority, f.binding, now + 2).expiresAt).toBe(f.grant.expiresAt)
})

test.each(['endpointDigest', 'caseDigest', 'profilePath', 'operationId', 'requestDigest'] as const)('rejects a changed %s binding', key => {
  const f = fixture(); const binding = { ...f.binding, [key]: key === 'profilePath' ? '/var/lib/dsh/profiles/other' : 'c'.repeat(64) }
  expect(() => verifyReplayGrant(f.grant, f.authority, binding, now + 2)).toThrow(/bound|invalid/u)
})

test('rejects forgery, non-Ed25519/private encodings, malformed input and accessors', () => {
  const f = fixture()
  expect(() => verifyReplayGrant({ ...f.grant, signature: 'A'.repeat(88) }, f.authority, f.binding, now + 2)).toThrow(/signature/u)
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
  expect(() => verifyReplayGrant(f.grant, { ...f.authority, publicKeyPem: rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString() }, f.binding, now + 2)).toThrow(/publicKeyPem/u)
  expect(() => verifyReplayGrant(f.grant, { ...f.authority, publicKeyPem: f.key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }, f.binding, now + 2)).toThrow(/publicKeyPem/u)
  expect(() => verifyReplayGrant({ ...f.grant, extra: true } as unknown as ReplayGrant, f.authority, f.binding, now + 2)).toThrow()
  let invoked = false
  const accessor = { ...f.grant, get authority() { invoked = true; return f.grant.authority } }
  expect(() => verifyReplayGrant(accessor, f.authority, f.binding, now + 2)).toThrow()
  expect(invoked).toBe(false)
})

test('requires the schema-2 readiness predecessor and bounded windows and case minimums', () => {
  const f = fixture()
  for (const request of [
    { ...f.grant.request, schemaVersion: 1 },
    { ...f.grant.request, predecessor: { ...f.grant.request.predecessor!, phase: 'shadow' } },
    { ...f.grant.request, predecessor: { ...f.grant.request.predecessor!, hostGeneration: 0 } },
  ]) expect(() => verifyReplayGrant({ ...f.grant, request } as ReplayGrant, f.authority, f.binding, now + 2)).toThrow()
  expect(() => verifyReplayGrant({ ...f.grant, expiresAt: f.grant.notBefore + 10_001 }, f.authority, f.binding, now + 2)).toThrow()
  expect(() => verifyReplayGrant(f.grant, { ...f.authority, maximumGrantMs: 99 }, f.binding, now + 2)).toThrow()
  expect(() => verifyReplayGrant(f.grant, f.authority, f.binding, f.grant.expiresAt + 1)).toThrow(/validity/u)
  const request = { ...f.grant.request, requirements: { ...f.grant.request.requirements, minimumToolExecutionAttempts: 2 } }
  const unsigned = { ...f.grant, request }; delete (unsigned as Partial<ReplayGrant>).signature
  const grant = { ...unsigned, signature: sign(null, Buffer.from(replayGrantSigningPayload(unsigned as Omit<ReplayGrant, 'signature'>)), f.key.privateKey).toString('base64') } as ReplayGrant
  const binding = { ...f.binding, requestDigest: hostAttestationRequestDigest(request) }
  expect(() => verifyReplayGrant(grant, f.authority, binding, now + 2)).toThrow(/minimums/u)
})
