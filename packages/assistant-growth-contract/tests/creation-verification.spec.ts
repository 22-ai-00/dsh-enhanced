import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { pluginCreationVerificationSigningPayload, validateCreationAcceptanceAuthorityRef,
  validatePluginCreationVerificationCertificate, verifyPluginCreationVerificationCertificate,
  type PluginCreationVerificationCertificate } from '../src/creation-verification.js'

const hash = 'a'.repeat(64)
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
function fixture(): PluginCreationVerificationCertificate {
  const body: Omit<PluginCreationVerificationCertificate, 'signature'> = {
    protocol: 'assistant-growth/creation-verification/v1', verificationId: 'verify-1',
    authority: { protocol: 'assistant-growth/creation-acceptance-authority/v1', authorityId: 'review-1', keyId: 'key-1',
      authorityDigest: hash, namePrefix: 'owner-', expiresAt: 100_000 },
    plan: { id: 'plan-1', digest: hash, name: 'owner-tool', sourceTreeDigest: hash, sourcePatchDigest: hash,
      artifactSha256: hash, artifactBytes: 1024, generatorDigest: hash },
    source: { referenceDigest: hash, ownerDigest: hash, growthRunDigest: hash }, contractDigest: hash, schemaDigest: hash,
    environment: { node: 'v22.23.2', cordis: '4.0.2', tools: '0.1.5-rc.3', systemPrompt: '0.1.5-rc.3' },
    model: { provider: 'supplier', model: 'model/vendor+revision', reasoningEffort: 'high' },
    budget: { modelCalls: 2, maxOutputTokens: 2048, maxDurationMs: 30_000, maxCases: 3 },
    sessions: { contract: 'creation-contract-1', sourceReview: 'creation-review-1' },
    observations: ['case-1', 'case-2', 'case-3'].map((caseId, index) => ({ caseId, jobId: `job-${index}`,
      operationDigest: hash, observationDigest: hash })),
    reviewDigest: hash, verifiedAt: 10_000, expiresAt: 50_000,
  }
  return { ...body, signature: sign(null, Buffer.from(pluginCreationVerificationSigningPayload(body)), privateKey).toString('base64url') }
}

describe('task-derived creation verification certificate', () => {
  test('verifies a bounded certificate with a real Ed25519 signature and frozen authority', () => {
    const certificate = fixture()
    expect(() => validatePluginCreationVerificationCertificate(certificate)).not.toThrow()
    expect(verifyPluginCreationVerificationCertificate(certificate, certificate.authority, pem, 20_000)).toBe(true)
    expect(verifyPluginCreationVerificationCertificate(JSON.parse(JSON.stringify(certificate)), certificate.authority, pem, 20_000)).toBe(true)
  })

  test.each(['artifact', 'source', 'model', 'observations', 'budget', 'contract', 'policy'])(
    'rejects a changed %s binding', changed => {
      const certificate = fixture(), value = structuredClone(certificate)
      if (changed === 'artifact') value.plan.artifactSha256 = 'b'.repeat(64)
      if (changed === 'source') value.source.growthRunDigest = 'b'.repeat(64)
      if (changed === 'model') value.model.model = 'another/model'
      if (changed === 'observations') value.observations = value.observations.map((row, index) => index === 0 ? { ...row, jobId: 'another-job' } : row)
      if (changed === 'budget') value.budget.maxOutputTokens++
      if (changed === 'contract') value.contractDigest = 'b'.repeat(64)
      if (changed === 'policy') value.authority.authorityDigest = 'b'.repeat(64)
      expect(verifyPluginCreationVerificationCertificate(value, certificate.authority, pem, 20_000)).toBe(false)
    })

  test('rejects an unpinned authority, another key, expired or future evidence', () => {
    const certificate = fixture(), otherKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
    expect(verifyPluginCreationVerificationCertificate(certificate, { ...certificate.authority, keyId: 'another-key' }, pem, 20_000)).toBe(false)
    expect(verifyPluginCreationVerificationCertificate(certificate, certificate.authority, otherKey, 20_000)).toBe(false)
    expect(verifyPluginCreationVerificationCertificate(certificate, certificate.authority, pem, 50_000)).toBe(false)
    expect(verifyPluginCreationVerificationCertificate(certificate, certificate.authority, pem, 9999)).toBe(false)
  })

  test('rejects unsupported signing key types', () => {
    const certificate = fixture(), other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const { signature: _signature, ...body } = certificate
    const signed = { ...body, signature: sign(null, Buffer.from(pluginCreationVerificationSigningPayload(body)), other.privateKey).toString('base64url') }
    expect(verifyPluginCreationVerificationCertificate(signed, certificate.authority,
      other.publicKey.export({ type: 'spki', format: 'pem' }).toString(), 20_000)).toBe(false)
  })

  test('rejects certificates that exceed policy scope, use repeated case/session identities or add self-ratings', () => {
    const certificate = fixture()
    expect(() => validatePluginCreationVerificationCertificate({ ...certificate, plan: { ...certificate.plan, name: 'foreign-tool' } })).toThrow()
    expect(() => validatePluginCreationVerificationCertificate({ ...certificate, expiresAt: certificate.authority.expiresAt + 1 })).toThrow()
    expect(() => validatePluginCreationVerificationCertificate({ ...certificate, sessions: { ...certificate.sessions, sourceReview: certificate.sessions.contract } })).toThrow()
    expect(() => validatePluginCreationVerificationCertificate({ ...certificate, observations: [certificate.observations[0], certificate.observations[0]] })).toThrow()
    expect(() => validatePluginCreationVerificationCertificate({ ...certificate,
      observations: certificate.observations.map(row => ({ ...row, jobId: 'reused-child-job' })) })).toThrow()
    expect(() => validatePluginCreationVerificationCertificate({ ...certificate, achieved: true })).toThrow()
    expect(() => validateCreationAcceptanceAuthorityRef({ ...certificate.authority, maxCreates: 1000 })).toThrow()
  })

  test('rejects accessor and sparse data without evaluating an observation getter', () => {
    const certificate = fixture(), rows = [...certificate.observations]
    let read = false
    Object.defineProperty(rows, '0', { enumerable: true, get: () => { read = true; throw new Error('getter executed') } })
    expect(() => validatePluginCreationVerificationCertificate({ ...certificate, observations: rows })).toThrow()
    expect(read).toBe(false)
    const sparse: unknown[] = []
    sparse.length = 3
    expect(() => validatePluginCreationVerificationCertificate({ ...certificate, observations: sparse })).toThrow()
  })
})
