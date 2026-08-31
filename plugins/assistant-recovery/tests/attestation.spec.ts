import { describe, expect, it } from 'vitest'
import {
  canonicalRecoveryBootstrapAttestationSet,
  EMPTY_BOOTSTRAP_ATTESTATION_SET_DIGEST,
  RecoveryBootstrapAttestationError,
  recoveryBootstrapAttestationSetDigest,
} from '../src/attestation.ts'
import type { RecoveryBootstrapAttestation } from '../src/types.ts'

const fixture = [
  {
    automationId: ' recovery:zeta ',
    activationState: 'paused',
    activationNonce: ' nonce-zeta ',
    activationPlanDigest: 'B'.repeat(64),
  },
  {
    automationId: 'recovery:alpha',
    activationState: 'preview',
    activationNonce: 'nonce-alpha',
    activationPlanDigest: 'a'.repeat(64),
  },
] as const satisfies readonly RecoveryBootstrapAttestation[]

describe('Recovery bootstrap attestation public contract', () => {
  it('normalizes, orders, freezes, and digests the schema-v4 JSON bytes exactly', () => {
    const canonical = canonicalRecoveryBootstrapAttestationSet(fixture)

    expect(canonical).toEqual([
      {
        automationId: 'recovery:alpha',
        activationState: 'preview',
        activationNonce: 'nonce-alpha',
        activationPlanDigest: 'a'.repeat(64),
      },
      {
        automationId: 'recovery:zeta',
        activationState: 'paused',
        activationNonce: 'nonce-zeta',
        activationPlanDigest: 'b'.repeat(64),
      },
    ])
    expect(JSON.stringify(canonical)).toBe(
      '[{"automationId":"recovery:alpha","activationState":"preview","activationNonce":"nonce-alpha","activationPlanDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},{"automationId":"recovery:zeta","activationState":"paused","activationNonce":"nonce-zeta","activationPlanDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]',
    )
    expect(recoveryBootstrapAttestationSetDigest(fixture))
      .toBe('3c6264e38ad702be6b1db070694eb772473a26e97721bf1b031cbafcca9c0448')
    expect(Object.isFrozen(canonical)).toBe(true)
    expect(canonical.every(Object.isFrozen)).toBe(true)
    expect(fixture[0].automationId).toBe(' recovery:zeta ')
  })

  it('binds the empty set to the durable schema constant', () => {
    expect(recoveryBootstrapAttestationSetDigest([]))
      .toBe(EMPTY_BOOTSTRAP_ATTESTATION_SET_DIGEST)
  })

  it('rejects duplicate normalized identities and malformed runtime values', () => {
    expect(() => canonicalRecoveryBootstrapAttestationSet([
      fixture[1],
      { ...fixture[1], automationId: ' recovery:alpha ' },
    ])).toThrow(/must be unique/u)
    expect(() => canonicalRecoveryBootstrapAttestationSet([
      { ...fixture[1], activationState: 'enabled' },
    ] as unknown as RecoveryBootstrapAttestation[])).toThrow(RecoveryBootstrapAttestationError)
  })
})
