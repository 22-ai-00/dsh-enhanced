import { generateKeyPairSync, sign } from 'node:crypto'
import { pluginRevisionVerificationSigningPayload, pluginRevisionRegressionSigningPayload, type PluginRevisionVerificationCertificate, type PluginRevisionRegressionCertificate } from '@dsh-enhanced/assistant-growth-contract'
const hash = 'a'.repeat(64), otherHash = 'b'.repeat(64), now = Date.now()
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
export const lanePublicKey = publicKey.export({ type: 'spki', format: 'pem' }).toString()

export function revisionFixture(authorityDigest = hash, planId = 'revision-plan-1'): PluginRevisionVerificationCertificate {
  const body: Omit<PluginRevisionVerificationCertificate, 'signature'> = {
    protocol: 'assistant-growth/revision-verification/v1', verificationId: 'revision-check-1',
    authority: { protocol: 'assistant-growth/revision-acceptance-authority/v1', authorityId: 'revision-policy-1',
      keyId: 'owner-key-1', authorityDigest, namePrefix: 'owner-', expiresAt: now + 120_000 },
    plan: { id: planId, digest: hash, name: 'owner-tool', sourceTreeDigest: hash,
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
    reviewDigest: hash, verifiedAt: now - 1000, expiresAt: now + 60_000,
  }
  return { ...body, signature: sign(null, Buffer.from(pluginRevisionVerificationSigningPayload(body)), privateKey).toString('base64url') }
}

export function regressionFixture(authorityDigest = hash, planId = 'revision-plan-1'): PluginRevisionRegressionCertificate {
  const body: Omit<PluginRevisionRegressionCertificate, 'signature'> = {
    protocol: 'assistant-growth/revision-regression/v1', verificationId: 'regression-check-1',
    authority: { protocol: 'assistant-growth/revision-regression-acceptance-authority/v1',
      authorityId: 'regression-policy-1', keyId: 'owner-key-1', authorityDigest,
      namePrefix: 'owner-', expiresAt: now + 120_000 },
    plan: { id: planId, digest: hash, name: 'owner-tool', sourceTreeDigest: hash,
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
    verifiedAt: now - 1000, expiresAt: now + 60_000,
  }
  return { ...body, signature: sign(null, Buffer.from(pluginRevisionRegressionSigningPayload(body)), privateKey).toString('base64url') }
}
