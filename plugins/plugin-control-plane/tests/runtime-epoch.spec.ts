import { generateKeyPairSync, sign } from 'node:crypto'
import { expect, test } from 'vitest'
import { parseRuntimeEpochRequest, parseRuntimeEpochReceipt, runtimeEpochIdentityDigest,
  runtimeEpochRequestDigest, runtimeEpochSigningPayload, verifyRuntimeEpochReceipt,
  type RuntimeEpochRequest, type RuntimeEpochReceipt } from '../src/runtime-epoch.ts'

const keys = generateKeyPairSync('ed25519')
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const installationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const digest = 'a'.repeat(64)
const request: RuntimeEpochRequest = {
  schemaVersion: 1, kind: 'dsh-runtime-epoch-request', operationId: 'epoch-1', requestedAt: 1_000,
  receiptTtlMs: 30_000, installationId, ledger: { id: 'ledger', path: '/private/ledger.sqlite' },
  plan: { id: 'plan', digest }, activation: { id: 'activation', fence: 2 },
  profile: { name: 'owner', path: '/private/profiles/owner' },
  issuer: { mode: 'configured-executable', id: 'systemd-reload', version: 'dsh-systemd-host-attestor-7',
    path: '/private/attestor', sha256: digest, interpreter: { path: '/usr/bin/node', sha256: digest },
    authority: 'systemd-owner', keyId: 'key-1' },
  predecessor: { operationId: 'readiness-1', receiptDigest: digest, hostGeneration: 3 },
  sequence: 1, runtimeIdentityDigest: 'b'.repeat(64),
}
const trust = { installationId, hostAttestationKeys: [{ authority: 'systemd-owner', keyId: 'key-1', publicKeyPem }] }
function signedReceipt(input: RuntimeEpochRequest = request, changes: Partial<RuntimeEpochReceipt> = {}): RuntimeEpochReceipt {
  const unsigned: Omit<RuntimeEpochReceipt, 'signature'> = {
    schemaVersion: 1, kind: 'dsh-runtime-epoch-receipt', receiptId: `receipt:${input.operationId}`,
    operationId: input.operationId, requestDigest: runtimeEpochRequestDigest(input), installationId: input.installationId,
    planId: input.plan.id, planDigest: input.plan.digest, activationId: input.activation.id, fence: input.activation.fence,
    hostGeneration: input.predecessor.hostGeneration, sequence: input.sequence,
    runtimeIdentityDigest: input.runtimeIdentityDigest, authority: input.issuer.authority, keyId: input.issuer.keyId,
    outcome: 'passed', observedAt: 2_000, expiresAt: 32_000,
    evidence: { checks: 2, failures: 0, probeDigest: digest }, ...changes,
  }
  return { ...unsigned, signature: sign(null, Buffer.from(runtimeEpochSigningPayload(unsigned)), keys.privateKey).toString('base64') }
}

test('runtime identity digest excludes only challenge and observedAt', () => {
  const base = { processId: 23, invocationId: 'c'.repeat(32), entries: [{ entryId: 'owner', active: true }] }
  expect(runtimeEpochIdentityDigest({ ...base, challenge: 'one', observedAt: 1 }))
    .toBe(runtimeEpochIdentityDigest({ ...base, challenge: 'two', observedAt: 2 }))
  expect(runtimeEpochIdentityDigest({ ...base, processId: 24, challenge: 'two', observedAt: 2 }))
    .not.toBe(runtimeEpochIdentityDigest({ ...base, challenge: 'one', observedAt: 1 }))
})

test('parses and verifies an exact signed epoch without changing Host generation', () => {
  const parsed = parseRuntimeEpochRequest(request)
  expect(parsed).toEqual(request)
  const receipt = signedReceipt()
  expect(parseRuntimeEpochReceipt(receipt)).toEqual(receipt)
  expect(verifyRuntimeEpochReceipt(receipt, request, trust, 2_001)).toEqual(receipt)
  expect(() => verifyRuntimeEpochReceipt(receipt, request, trust, 32_001)).toThrow('validity interval')
  expect(verifyRuntimeEpochReceipt(receipt, request, trust, receipt.observedAt)).toEqual(receipt)
})

test('rejects unknown fields, malformed lineage and invalid signed evidence', () => {
  expect(() => parseRuntimeEpochRequest({ ...request, extra: true })).toThrow('fields')
  expect(() => parseRuntimeEpochRequest({ ...request, sequence: 0 })).toThrow('sequence')
  expect(() => parseRuntimeEpochRequest({ ...request, predecessor: { ...request.predecessor, operationId: request.operationId } })).toThrow('lineage')
  expect(() => parseRuntimeEpochReceipt({ ...signedReceipt(), evidence: { checks: 2, failures: 1, probeDigest: digest } })).toThrow('evidence')
  expect(() => verifyRuntimeEpochReceipt({ ...signedReceipt(), sequence: 2 }, request, trust, 2_001)).toThrow('exact request')
  expect(() => verifyRuntimeEpochReceipt({ ...signedReceipt(), signature: Buffer.alloc(64).toString('base64') }, request, trust, 2_001)).toThrow('signature')
  expect(() => verifyRuntimeEpochReceipt(signedReceipt(), { ...request, runtimeIdentityDigest: 'c'.repeat(64) }, trust, 2_001)).toThrow('exact request')
})
