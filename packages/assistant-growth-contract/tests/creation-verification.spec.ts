import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, expectTypeOf, test } from 'vitest'
import { pluginCreationVerificationSigningPayload, validateCreationAcceptanceAuthorityRef,
  validatePluginCreationVerificationCertificate, verifyPluginCreationVerificationCertificate,
  type PluginCreationVerificationCertificate, type PluginCreationVerificationCertificateV2,
  type PluginCreationVerificationCertificateV3 } from '../src/creation-verification.js'

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

function linuxFixture(): PluginCreationVerificationCertificateV3 {
  const { signature: _signature, ...legacyBody } = fixture()
  const body: Omit<PluginCreationVerificationCertificateV3, 'signature'> = {
    ...legacyBody, protocol: 'assistant-growth/creation-verification/v3',
    execution: { boundary: 'linux-native-process-seccomp-v1', runtimeDigest: 'b'.repeat(64),
      buildRuntimeDigest: 'c'.repeat(64), buildEvidenceDigest: 'd'.repeat(64), observerPreparationDigest: 'e'.repeat(64) },
  }
  return { ...body, signature: sign(null, Buffer.from(pluginCreationVerificationSigningPayload(body)), privateKey).toString('base64url') }
}

describe('task-derived creation verification certificate', () => {
  test('native v2 signs the actual boundary, runtime and build evidence while v1 stays byte compatible', () => {
    const old = fixture()
    expect(Object.hasOwn(old, 'execution')).toBe(false)
    const { signature: _signature, ...legacyBody } = old
    const body: Omit<PluginCreationVerificationCertificateV2, 'signature'> = {
      ...legacyBody, protocol: 'assistant-growth/creation-verification/v2',
      execution: { boundary: 'macos-seatbelt-single-process-v1', runtimeDigest: 'b'.repeat(64), buildEvidenceDigest: 'c'.repeat(64) },
    }
    const certificate: PluginCreationVerificationCertificateV2 = { ...body,
      signature: sign(null, Buffer.from(pluginCreationVerificationSigningPayload(body)), privateKey).toString('base64url') }
    expectTypeOf<PluginCreationVerificationCertificateV2['execution']['boundary']>().toEqualTypeOf<'macos-seatbelt-single-process-v1'>()
    expect(createHash('sha256').update(pluginCreationVerificationSigningPayload(legacyBody)).digest('hex'))
      .toBe('4292d80d47d8384e25fee474f82738288a98f39327d440c3bd0fb413b092ecf8')
    expect(createHash('sha256').update(pluginCreationVerificationSigningPayload(body)).digest('hex'))
      .toBe('61e01df9c131a0d6d27d44318c3cfc13a462f042157f43b60a89936630c0af98')
    expect(Object.keys(body.execution).sort()).toEqual(['boundary', 'buildEvidenceDigest', 'runtimeDigest'])
    expect(verifyPluginCreationVerificationCertificate(certificate, certificate.authority, pem, 20_000)).toBe(true)
    for (const execution of [{ ...body.execution, runtimeDigest: 'd'.repeat(64) },
      { ...body.execution, buildEvidenceDigest: 'e'.repeat(64) },
      { ...body.execution, boundary: 'process-seccomp-v1' }]) {
      expect(verifyPluginCreationVerificationCertificate({ ...certificate, execution } as unknown,
        certificate.authority, pem, 20_000)).toBe(false)
    }
    expect(() => validatePluginCreationVerificationCertificate({ ...old, execution: body.execution })).toThrow()
    expect(() => validatePluginCreationVerificationCertificate({ ...certificate, execution: undefined })).toThrow()
    for (const key of ['buildRuntimeDigest', 'observerPreparationDigest']) {
      expect(() => validatePluginCreationVerificationCertificate({ ...certificate, execution: { ...certificate.execution, [key]: hash } })).toThrow()
    }
  })

  test('Linux v3 signs all execution bindings with a real Ed25519 key', () => {
    const certificate = linuxFixture()
    expectTypeOf<PluginCreationVerificationCertificateV3['execution']['boundary']>().toEqualTypeOf<'linux-native-process-seccomp-v1'>()
    expect(Object.keys(certificate.execution).sort()).toEqual([
      'boundary', 'buildEvidenceDigest', 'buildRuntimeDigest', 'observerPreparationDigest', 'runtimeDigest',
    ])
    expect(() => validatePluginCreationVerificationCertificate(certificate)).not.toThrow()
    expect(verifyPluginCreationVerificationCertificate(certificate, certificate.authority, pem, 20_000)).toBe(true)
    expect(verifyPluginCreationVerificationCertificate(JSON.parse(JSON.stringify(certificate)), certificate.authority, pem, 20_000)).toBe(true)
  })

  test.each(['runtimeDigest', 'buildRuntimeDigest', 'buildEvidenceDigest', 'observerPreparationDigest'] as const)(
    'Linux v3 rejects tampering, omission and invalid digest encoding for %s', key => {
      const certificate = linuxFixture()
      const tampered = { ...certificate, execution: { ...certificate.execution, [key]: 'f'.repeat(64) } }
      expect(() => validatePluginCreationVerificationCertificate(tampered)).not.toThrow()
      expect(verifyPluginCreationVerificationCertificate(tampered, certificate.authority, pem, 20_000)).toBe(false)
      const { [key]: _omitted, ...missing } = certificate.execution
      expect(() => validatePluginCreationVerificationCertificate({ ...certificate, execution: missing })).toThrow()
      for (const invalid of [undefined, null, 1, 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)]) {
        expect(() => validatePluginCreationVerificationCertificate({ ...certificate,
          execution: { ...certificate.execution, [key]: invalid } })).toThrow()
      }
    })

  test('Linux v3 rejects missing, extra and cross-protocol execution fields without converting legacy certificates', () => {
    const certificate = linuxFixture()
    const { execution, ...missing } = certificate
    expect(() => validatePluginCreationVerificationCertificate(missing)).toThrow()
    expect(() => validatePluginCreationVerificationCertificate({ ...certificate, execution: undefined })).toThrow()
    expect(() => validatePluginCreationVerificationCertificate({ ...certificate, execution: { ...execution, extra: hash } })).toThrow()
    expect(() => validatePluginCreationVerificationCertificate({ ...certificate, extra: hash })).toThrow()
    const { boundary: _boundary, ...missingBoundary } = execution
    expect(() => validatePluginCreationVerificationCertificate({ ...certificate, execution: missingBoundary })).toThrow()
    for (const boundary of ['macos-seatbelt-single-process-v1', 'process-seccomp-v1', 'docker', undefined]) {
      const mixed = { ...certificate, execution: { ...execution, boundary } }
      expect(() => validatePluginCreationVerificationCertificate(mixed)).toThrow()
      expect(verifyPluginCreationVerificationCertificate(mixed, certificate.authority, pem, 20_000)).toBe(false)
    }
    for (const protocol of ['assistant-growth/creation-verification/v1', 'assistant-growth/creation-verification/v2',
      'assistant-growth/creation-verification/v4']) {
      expect(() => validatePluginCreationVerificationCertificate({ ...certificate, protocol })).toThrow()
    }
    const macosExecution: PluginCreationVerificationCertificateV2['execution'] = {
      boundary: 'macos-seatbelt-single-process-v1', runtimeDigest: hash, buildEvidenceDigest: hash,
    }
    expect(() => validatePluginCreationVerificationCertificate({ ...certificate, execution: macosExecution })).toThrow()
    expect(() => validatePluginCreationVerificationCertificate({ ...certificate,
      execution: { ...macosExecution, boundary: execution.boundary } })).toThrow()
    expect(() => validatePluginCreationVerificationCertificate({ ...fixture(), protocol: certificate.protocol })).toThrow()
    expect(() => validatePluginCreationVerificationCertificate({ ...fixture(), execution })).toThrow()
    const old: PluginCreationVerificationCertificateV2 = {
      ...certificate, protocol: 'assistant-growth/creation-verification/v2', execution: macosExecution,
    }
    const { signature: _signature, ...oldBody } = old
    const signedOld = { ...old, signature: sign(null,
      Buffer.from(pluginCreationVerificationSigningPayload(oldBody)), privateKey).toString('base64url') }
    expect(verifyPluginCreationVerificationCertificate(signedOld, certificate.authority, pem, 20_000)).toBe(true)
    expect(verifyPluginCreationVerificationCertificate({ ...signedOld, protocol: certificate.protocol, execution },
      certificate.authority, pem, 20_000)).toBe(false)
  })

  test('Linux v3 retains artifact, owner, model, budget and expiry constraints', () => {
    const certificate = linuxFixture()
    expect(() => validatePluginCreationVerificationCertificate({ ...certificate,
      plan: { ...certificate.plan, artifactBytes: 512 * 1024 } })).not.toThrow()
    for (const invalid of [
      { plan: { ...certificate.plan, artifactBytes: 512 * 1024 + 1 } },
      { plan: { ...certificate.plan, name: 'foreign-tool' } },
      { source: { ...certificate.source, ownerDigest: '' } },
      { model: { ...certificate.model, model: '' } },
      { budget: { ...certificate.budget, modelCalls: 3 } },
      { budget: { ...certificate.budget, maxOutputTokens: 32_769 } },
      { budget: { ...certificate.budget, maxDurationMs: 1_800_001 } },
      { budget: { ...certificate.budget, maxCases: 9 } },
      { expiresAt: certificate.authority.expiresAt + 1 },
      { expiresAt: certificate.verifiedAt },
    ]) expect(() => validatePluginCreationVerificationCertificate({ ...certificate, ...invalid })).toThrow()
    expect(verifyPluginCreationVerificationCertificate(certificate, { ...certificate.authority, authorityDigest: hash.replace(/^a/u, 'b') }, pem, 20_000)).toBe(false)
    expect(verifyPluginCreationVerificationCertificate(certificate, certificate.authority, pem, certificate.expiresAt)).toBe(false)
    expect(verifyPluginCreationVerificationCertificate(certificate, certificate.authority, pem, certificate.verifiedAt - 1)).toBe(false)
  })

  test('Linux v3 rejects protocol and execution accessors without evaluating them', () => {
    for (const target of ['protocol', 'execution', 'runtimeDigest']) {
      const certificate = linuxFixture()
      let read = false
      Object.defineProperty(target === 'runtimeDigest' ? certificate.execution : certificate, target,
        { enumerable: true, get: () => { read = true; throw new Error('getter executed') } })
      expect(() => validatePluginCreationVerificationCertificate(certificate)).toThrow()
      expect(read).toBe(false)
    }
  })
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
