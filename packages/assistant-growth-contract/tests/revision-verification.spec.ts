import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { canonicalGrowthJson } from '../src/canonical.js'
import { pluginRevisionVerificationSigningPayload, validatePluginRevisionParentBinding,
  validatePluginRevisionVerificationCertificate, validateRevisionAcceptanceAuthorityRef,
  verifyPluginRevisionVerificationCertificate, type PluginRevisionVerificationCertificate } from '../src/revision-verification.js'
import { sourceGrowthRunDigest, validateSourceGrowthRunBinding, type SourceGrowthRunBinding } from '../src/source-run.js'

const hash = 'a'.repeat(64)
const otherHash = 'b'.repeat(64)
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

function certificate(): PluginRevisionVerificationCertificate {
  const body: Omit<PluginRevisionVerificationCertificate, 'signature'> = {
    protocol: 'assistant-growth/revision-verification/v1', verificationId: 'revision-check-1',
    authority: { protocol: 'assistant-growth/revision-acceptance-authority/v1', authorityId: 'revision-policy-1',
      keyId: 'owner-key-1', authorityDigest: hash, namePrefix: 'owner-', expiresAt: 100_000 },
    plan: { id: 'revision-plan-1', digest: hash, name: 'owner-tool', sourceTreeDigest: hash,
      sourcePatchDigest: hash, artifactSha256: hash, artifactBytes: 1024, generatorDigest: hash },
    parent: { planId: 'adopted-plan-1', certificateDigest: hash, artifactSha256: hash,
      sourceArchiveDigest: hash, sourceDigest: hash },
    source: { referenceDigest: hash, ownerDigest: hash, growthRunDigest: hash },
    contractDigest: hash, schemaDigest: hash,
    environment: { node: 'v22.23.2', cordis: '4.0.2', tools: '0.1.5-rc.3', systemPrompt: '0.1.5-rc.3' },
    model: { provider: 'supplier', model: 'model/vendor+revision', reasoningEffort: 'high' },
    budget: { modelCalls: 2, maxOutputTokens: 2048, maxDurationMs: 30_000, maxCases: 3 },
    sessions: { contract: 'revision-contract-1', sourceReview: 'revision-review-1' },
    observations: ['case-1', 'case-2'].map((caseId, index) => ({ caseId, jobId: `job-${index}`,
      operationDigest: hash, observationDigest: hash })),
    reviewDigest: hash, verifiedAt: 10_000, expiresAt: 50_000,
  }
  return { ...body, signature: sign(null, Buffer.from(pluginRevisionVerificationSigningPayload(body)), privateKey).toString('base64url') }
}

function sourceRun(): SourceGrowthRunBinding {
  return {
    protocol: 'assistant-growth/source-run/v1', runId: 'run-1', intentDigest: hash, configDigest: hash, ownerDigest: hash,
    source: { outcomeId: 'outcome-1', projection: { subjectKind: 'foreground-turn', subjectRef: 'inbox-1',
      version: 1, digest: hash, disposition: 'upsert' }, sourceDigest: hash },
    model: { provider: 'supplier', model: 'model' }, modelOrigin: 'inherited-owner-task',
    budget: { budgetId: 'budget-1', amount: 1, maxModelCalls: 4, maxToolCalls: 16,
      maxOutputTokens: 2048, maxDurationMs: 30_000, maxPlansPerWake: 1 },
    native: { owner: 'assistant-growth-usage', automationId: 'run-1', definitionHash: hash, occurrenceId: 'wake-1' },
    sessionId: 'session-1', toolContractDigest: hash, executionContractDigest: hash,
    createdAt: 1000, generationDeadlineAt: 30_000, expiresAt: 60_000,
  }
}

describe('independent adopted-tool revision verification', () => {
  test('accepts a real Ed25519 revision signature with the frozen authority', () => {
    const signed = certificate()
    expect(() => validatePluginRevisionVerificationCertificate(signed)).not.toThrow()
    expect(verifyPluginRevisionVerificationCertificate(signed, signed.authority, pem, 20_000)).toBe(true)
    expect(verifyPluginRevisionVerificationCertificate(JSON.parse(JSON.stringify(signed)), signed.authority, pem, 20_000)).toBe(true)
  })

  test('keeps the creation protocol and signing domain separate', () => {
    const signed = certificate()
    const { signature: _signature, ...body } = signed
    const creationDomainSignature = sign(null, Buffer.from(canonicalGrowthJson(body)), privateKey).toString('base64url')
    expect(verifyPluginRevisionVerificationCertificate({ ...signed, signature: creationDomainSignature }, signed.authority, pem, 20_000)).toBe(false)
    expect(() => validatePluginRevisionVerificationCertificate({ ...signed, protocol: 'assistant-growth/creation-verification/v1' })).toThrow()
    expect(() => validateRevisionAcceptanceAuthorityRef({ ...signed.authority,
      protocol: 'assistant-growth/creation-acceptance-authority/v1' })).toThrow()
  })

  test.each(['certificateDigest', 'artifactSha256', 'sourceArchiveDigest', 'sourceDigest', 'planId'] as const)(
    'binds parent %s to the signature', field => {
      const signed = certificate()
      const changed = { ...signed, parent: { ...signed.parent, [field]: field === 'planId' ? 'another-plan' : otherHash } }
      expect(verifyPluginRevisionVerificationCertificate(changed, signed.authority, pem, 20_000)).toBe(false)
    })

  test('rejects a policy exchange and expired or future evidence', () => {
    const signed = certificate()
    expect(verifyPluginRevisionVerificationCertificate(signed,
      { ...signed.authority, authorityDigest: otherHash }, pem, 20_000)).toBe(false)
    expect(verifyPluginRevisionVerificationCertificate({ ...signed,
      authority: { ...signed.authority, authorityDigest: otherHash } }, signed.authority, pem, 20_000)).toBe(false)
    expect(verifyPluginRevisionVerificationCertificate(signed, signed.authority, pem, 9999)).toBe(false)
    expect(verifyPluginRevisionVerificationCertificate(signed, signed.authority, pem, 50_000)).toBe(false)
    expect(() => validatePluginRevisionVerificationCertificate({ ...signed, expiresAt: 100_001 })).toThrow()
  })

  test('rejects malformed parent, authority, unknown keys and accessors without reading them', () => {
    const signed = certificate()
    expect(() => validatePluginRevisionParentBinding({ ...signed.parent, sourceDigest: 'A'.repeat(64) })).toThrow()
    expect(() => validatePluginRevisionParentBinding({ ...signed.parent, extra: true })).toThrow()
    expect(() => validatePluginRevisionParentBinding({ ...signed.parent, [Symbol('hidden')]: true })).toThrow()
    expect(() => validateRevisionAcceptanceAuthorityRef({ ...signed.authority, maxRevisions: 10 })).toThrow()
    expect(() => validatePluginRevisionVerificationCertificate({ ...signed, selfRating: 1 })).toThrow()
    const { signature: _signature, ...body } = signed
    expect(() => pluginRevisionVerificationSigningPayload({ ...body, selfRating: 1 } as typeof body)).toThrow()
    expect(() => validatePluginRevisionVerificationCertificate({ ...signed,
      observations: [signed.observations[0], signed.observations[0]] })).toThrow()
    const parent = { ...signed.parent }
    let read = false
    Object.defineProperty(parent, 'sourceDigest', { enumerable: true, get: () => { read = true; throw Error('read') } })
    expect(() => validatePluginRevisionVerificationCertificate({ ...signed, parent })).toThrow()
    expect(read).toBe(false)
    const rows: unknown[] = []
    rows.length = 2
    expect(() => validatePluginRevisionVerificationCertificate({ ...signed, observations: rows })).toThrow()
  })

  test('freezes optional revision policy in source-run provenance while preserving historical shape', () => {
    const historical = sourceRun()
    expect(() => validateSourceGrowthRunBinding(historical)).not.toThrow()
    const signed = certificate()
    const withRevision = { ...historical, revisionAcceptance: signed.authority }
    const withBoth = { ...withRevision, creationAcceptance: {
      protocol: 'assistant-growth/creation-acceptance-authority/v1' as const, authorityId: 'creation-policy-1',
      keyId: 'owner-key-1', authorityDigest: hash, namePrefix: 'owner-', expiresAt: 100_000,
    } }
    expect(() => validateSourceGrowthRunBinding(withBoth)).not.toThrow()
    expect(sourceGrowthRunDigest(withRevision)).not.toBe(sourceGrowthRunDigest(historical))
    expect(sourceGrowthRunDigest(withBoth)).not.toBe(sourceGrowthRunDigest(withRevision))
    expect(sourceGrowthRunDigest(JSON.parse(JSON.stringify(withBoth)))).toBe(sourceGrowthRunDigest(withBoth))
    expect(() => validateSourceGrowthRunBinding({ ...withBoth, revisionAcceptance: undefined })).toThrow()
    expect(() => validateSourceGrowthRunBinding({ ...withBoth, revisionAcceptance: {
      ...signed.authority, protocol: 'assistant-growth/creation-acceptance-authority/v1' } })).toThrow()
    expect(() => validateSourceGrowthRunBinding({ ...withBoth, revisionAcceptance: {
      ...signed.authority, expiresAt: historical.createdAt - 1 } })).toThrow(/expiry/)
    const accessor = { ...withBoth }
    let read = false
    Object.defineProperty(accessor, 'revisionAcceptance', {
      enumerable: true, get: () => { read = true; throw Error('read') },
    })
    expect(() => validateSourceGrowthRunBinding(accessor)).toThrow()
    expect(read).toBe(false)
  })
})
