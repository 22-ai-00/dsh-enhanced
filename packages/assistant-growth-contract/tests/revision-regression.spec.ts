import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { canonicalGrowthJson } from '../src/canonical.js'
import { pluginRevisionRegressionSigningPayload, validatePluginRevisionRegressionCertificate,
  validatePluginRevisionRegressionRequest, validateRevisionRegressionAcceptanceAuthorityRef,
  verifyPluginRevisionRegressionCertificate, type PluginRevisionRegressionCertificate } from '../src/revision-regression.js'
import { sourceGrowthEvidenceDigest, sourceGrowthRunDigest, validateSourceGrowthRunBinding,
  type SourceGrowthRunBinding } from '../src/source-run.js'

const hash = 'a'.repeat(64)
const otherHash = 'b'.repeat(64)
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

function certificate(): PluginRevisionRegressionCertificate {
  const body: Omit<PluginRevisionRegressionCertificate, 'signature'> = {
    protocol: 'assistant-growth/revision-regression/v1', verificationId: 'regression-check-1',
    authority: { protocol: 'assistant-growth/revision-regression-acceptance-authority/v1',
      authorityId: 'regression-policy-1', keyId: 'owner-key-1', authorityDigest: hash,
      namePrefix: 'owner-', expiresAt: 100_000 },
    plan: { id: 'revision-plan-1', digest: hash, name: 'owner-tool', sourceTreeDigest: hash,
      sourcePatchDigest: hash, artifactSha256: hash, artifactBytes: 1024, generatorDigest: hash },
    parent: { planId: 'adopted-plan-1', certificateDigest: hash, artifactSha256: hash,
      sourceArchiveDigest: hash, sourceDigest: hash },
    source: { referenceDigest: hash, ownerDigest: hash, growthRunDigest: hash },
    contractDigest: hash, schemaDigest: hash,
    environment: { node: 'v22.23.2', cordis: '4.0.2', tools: '0.1.5-rc.3', systemPrompt: '0.1.5-rc.3' },
    model: { provider: 'supplier', model: 'model/vendor+revision', reasoningEffort: 'high' },
    candidateVerificationDigest: hash, sourceDigest: hash, schemaCompatibilityDigest: hash,
    budget: { maxCases: 3, maxDurationMs: 30_000, maxRuns: 8 },
    observations: ['case-1', 'case-2'].map((caseId, index) => ({ caseId,
      parent: { jobId: `parent-job-${index}`, operationDigest: hash, observationDigest: hash },
      candidate: { jobId: `candidate-job-${index}`, operationDigest: otherHash, observationDigest: otherHash },
    })),
    verifiedAt: 10_000, expiresAt: 50_000,
  }
  return { ...body, signature: sign(null, Buffer.from(pluginRevisionRegressionSigningPayload(body)), privateKey).toString('base64url') }
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

describe('independent retained-parent regression contract', () => {
  test('accepts a real signed certificate while retaining distinct parent and candidate raw hashes', () => {
    const signed = certificate()
    expect(signed.observations[0]!.parent.observationDigest).not.toBe(signed.observations[0]!.candidate.observationDigest)
    expect(() => validatePluginRevisionRegressionCertificate(signed)).not.toThrow()
    expect(verifyPluginRevisionRegressionCertificate(signed, signed.authority, pem, 20_000)).toBe(true)
    expect(verifyPluginRevisionRegressionCertificate(JSON.parse(JSON.stringify(signed)), signed.authority, pem, 20_000)).toBe(true)
  })

  test('keeps request, authority, certificate and signing domain independent of revision verification', () => {
    const signed = certificate()
    const { signature: _signature, ...body } = signed
    const oldDomain = sign(null, Buffer.from('assistant-growth/revision-verification/v1\0' + canonicalGrowthJson(body)), privateKey).toString('base64url')
    expect(verifyPluginRevisionRegressionCertificate({ ...signed, signature: oldDomain }, signed.authority, pem, 20_000)).toBe(false)
    expect(() => validatePluginRevisionRegressionCertificate({ ...signed,
      protocol: 'assistant-growth/revision-verification/v1' })).toThrow()
    expect(() => validateRevisionRegressionAcceptanceAuthorityRef({ ...signed.authority,
      protocol: 'assistant-growth/revision-acceptance-authority/v1' })).toThrow()
    expect(() => validatePluginRevisionRegressionRequest({ protocol: 'assistant-growth/revision-regression-request/v1', planId: 'revision-plan-1' })).not.toThrow()
    expect(() => validatePluginRevisionRegressionRequest({ protocol: 'assistant-growth/revision-verification-request/v1', planId: 'revision-plan-1' })).toThrow()
    expect(() => validatePluginRevisionRegressionRequest({ protocol: 'assistant-growth/revision-regression-request/v1', planId: 'revision-plan-1', selfRating: 1 })).toThrow()
  })

  test.each(['candidateVerificationDigest', 'sourceDigest', 'schemaCompatibilityDigest', 'contractDigest', 'schemaDigest'] as const)(
    'binds %s to the signature', field => {
      const signed = certificate()
      expect(verifyPluginRevisionRegressionCertificate({ ...signed, [field]: otherHash }, signed.authority, pem, 20_000)).toBe(false)
    })

  test('binds the parent, both observations and exact independent policy', () => {
    const signed = certificate()
    expect(verifyPluginRevisionRegressionCertificate({ ...signed,
      parent: { ...signed.parent, sourceArchiveDigest: otherHash } }, signed.authority, pem, 20_000)).toBe(false)
    expect(verifyPluginRevisionRegressionCertificate({ ...signed,
      observations: [{ ...signed.observations[0]!, candidate: {
        ...signed.observations[0]!.candidate, observationDigest: hash } }, signed.observations[1]!] }, signed.authority, pem, 20_000)).toBe(false)
    expect(verifyPluginRevisionRegressionCertificate(signed,
      { ...signed.authority, authorityDigest: otherHash }, pem, 20_000)).toBe(false)
    expect(verifyPluginRevisionRegressionCertificate(signed, signed.authority, pem, 9_999)).toBe(false)
    expect(verifyPluginRevisionRegressionCertificate(signed, signed.authority, pem, 50_000)).toBe(false)
  })

  test('rejects malformed keys, accessors, sparse or duplicate observations and nonfinite budgets', () => {
    const signed = certificate()
    expect(() => validatePluginRevisionRegressionCertificate({ ...signed, extra: true })).toThrow()
    expect(() => validatePluginRevisionRegressionCertificate({ ...signed,
      observations: [signed.observations[0], signed.observations[0]] })).toThrow()
    expect(() => validatePluginRevisionRegressionCertificate({ ...signed,
      observations: [{ ...signed.observations[0]!, candidate: { ...signed.observations[0]!.parent } }, signed.observations[1]] })).toThrow()
    const sparse: unknown[] = []
    sparse.length = 2
    expect(() => validatePluginRevisionRegressionCertificate({ ...signed, observations: sparse })).toThrow()
    expect(() => validatePluginRevisionRegressionCertificate({ ...signed, budget: { ...signed.budget, maxRuns: 7 } })).toThrow()
    expect(() => validatePluginRevisionRegressionCertificate({ ...signed, budget: { ...signed.budget, maxCases: 9 } })).toThrow()
    expect(() => validatePluginRevisionRegressionCertificate({ ...signed, expiresAt: 100_001 })).toThrow()
    const { signature: _signature, ...body } = signed
    expect(() => pluginRevisionRegressionSigningPayload({ ...body, extra: true } as typeof body)).toThrow()
    const parent = { ...signed.parent }
    let read = false
    Object.defineProperty(parent, 'sourceDigest', { enumerable: true, get: () => { read = true; throw Error('read') } })
    expect(() => validatePluginRevisionRegressionCertificate({ ...signed, parent })).toThrow()
    expect(read).toBe(false)
  })

  test('freezes an optional regression policy without changing historical source-run digests', () => {
    const historical = sourceRun()
    expect(() => validateSourceGrowthRunBinding(historical)).not.toThrow()
    const originalDigest = sourceGrowthRunDigest(historical)
    // Captured from the pre-regression v1 implementation, before this optional field existed.
    expect(originalDigest).toBe('53a22b4babf8f54eeaf40093926957fda093a4f2fc85aab3e52b91ee5df68ebe')
    expect(originalDigest).toBe(sourceGrowthEvidenceDigest(historical))
    expect(sourceGrowthRunDigest(JSON.parse(JSON.stringify(historical)))).toBe(originalDigest)
    expect(historical).not.toHaveProperty('revisionRegressionAcceptance')
    const withPolicy = { ...historical, revisionRegressionAcceptance: certificate().authority }
    expect(() => validateSourceGrowthRunBinding(withPolicy)).not.toThrow()
    expect(sourceGrowthRunDigest(withPolicy)).not.toBe(originalDigest)
    expect(sourceGrowthRunDigest(JSON.parse(JSON.stringify(withPolicy)))).toBe(sourceGrowthRunDigest(withPolicy))
    expect(() => validateSourceGrowthRunBinding({ ...withPolicy, revisionRegressionAcceptance: undefined })).toThrow()
    expect(() => validateSourceGrowthRunBinding({ ...withPolicy, revisionRegressionAcceptance: {
      ...withPolicy.revisionRegressionAcceptance, protocol: 'assistant-growth/revision-acceptance-authority/v1' } })).toThrow()
    expect(() => validateSourceGrowthRunBinding({ ...withPolicy, revisionRegressionAcceptance: {
      ...withPolicy.revisionRegressionAcceptance, expiresAt: historical.createdAt - 1 } })).toThrow(/expiry/)
    const accessor = { ...withPolicy }
    let read = false
    Object.defineProperty(accessor, 'revisionRegressionAcceptance', { enumerable: true,
      get: () => { read = true; throw Error('read') } })
    expect(() => validateSourceGrowthRunBinding(accessor)).toThrow()
    expect(read).toBe(false)
  })
})
