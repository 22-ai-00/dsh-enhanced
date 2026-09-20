import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { approvalSigningPayload, Ed25519ApprovalAuthority } from '../src/approval.ts'
import { exampleIntegrityPinnedCatalog } from '../src/catalog.ts'
import { hostAttestationEvidenceDigest, hostAttestationSigningPayload, Ed25519HostAttestationAuthority } from '../src/attestation.ts'
import { activationRetractionSigningPayload, Ed25519ActivationRetractionAuthority,
  Ed25519PostActivationObservationAuthority, postActivationEvidenceDigest, postActivationObservationSigningPayload } from '../src/post-activation.ts'
import { Ed25519SourcePublishReconciliationAuthority, Ed25519SourceReleaseAuthorizationAuthority,
  sourcePublishReconciliationEvidenceDigest, sourcePublishReconciliationRequestDigest, sourcePublishReconciliationSigningPayload,
  sourceReleaseAuthorizationSigningPayload } from '../src/release.ts'
import { controlPlaneOperationReceiptDigest, controlPlaneSchemaVersion, openControlPlaneDatabase } from '../src/sqlite.ts'
import { controlPlaneDigest, ControlPlaneStore, type CreateActivationPlanInput } from '../src/store.ts'
import type { ActivationRetractionReceipt, ApprovalAuthority, ApprovalReceipt, HostAttestationReceipt,
  HostAttestationRequirements, PluginActivationPlan, PluginSourcePlan, PostActivationObservationReceipt, SourceReleaseAuthority,
  SourcePublishReconciliationEvidence, SourcePublishReconciliationReceipt, SourceReleaseAuthorization,
  SourceReleaseAuthorizationAuthority, SourceReleaseReceipt, SourceReleaseRequest } from '../src/types.ts'

const roots: string[] = []
const candidate = exampleIntegrityPinnedCatalog.entries.find(item => item.id === 'assistant-health')!
const installationId = '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00'

async function fixture(now = 1_800_000_000_000) {
  const root = await mkdtemp(join(tmpdir(), 'control-plane-state-')); roots.push(root)
  let clock = now; const path = join(root, 'state.sqlite')
  const store = new ControlPlaneStore({ path, now: () => clock })
  return { root, path, store, now: () => clock, setNow: (value: number) => { clock = value } }
}

function gap(store: ControlPlaneStore, suffix: string, value = 100) {
  return store.recordGap({ idempotencyKey: `gap:health:${suffix}`, capability: 'health', context: `health gap ${suffix}`,
    expectedValue: value, frequency: 10, estimatedCost: 50, risk: 0.2 })
}

function activationInput(root: string, gapId: string, idempotencyKey: string): CreateActivationPlanInput {
  return { candidate, catalog: { digest: controlPlaneDigest(exampleIntegrityPinnedCatalog), provenance: 'owner-provided-integrity-pinned' },
    matchedCapabilities: candidate.capabilities, profile: 'web', target: { dshHome: root, profile: 'web', profilePath: join(root, 'profiles', 'web') },
    installationId, ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01', path: join(root, 'control.sqlite') },
    executor: { id: 'dsh', version: '0.1.0-rc.8', path: join(root, 'bin', 'dsh'), sha256: 'd'.repeat(64) },
    ttlMs: 60_000, gapId, idempotencyKey }
}

function approval(plan: PluginActivationPlan, now: number) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const unsigned: Omit<ApprovalReceipt, 'signature'> = { schemaVersion: 1, approvalId: `approval-${plan.id.slice(-12)}`,
    authority: 'owner-policy', keyId: 'owner-key-1', planId: plan.id, planDigest: plan.digest, decision: 'approved',
    principal: 'owner@example.test', decidedAt: now, expiresAt: now + 10_000 }
  const receipt: ApprovalReceipt = { ...unsigned, signature: sign(null, Buffer.from(approvalSigningPayload(unsigned)), privateKey).toString('base64') }
  const authority = new Ed25519ApprovalAuthority(publicKey.export({ format: 'pem', type: 'spki' }), 'owner-policy', 'owner-key-1', () => now)
  return { receipt, authority }
}

async function approved(target: Awaited<ReturnType<typeof fixture>>, suffix: string): Promise<PluginActivationPlan> {
  const plan = target.store.createPlan(activationInput(target.root, gap(target.store, suffix).id, `plan:${suffix}`)).result
  const signed = approval(plan, target.now() + 1)
  return (await target.store.approve({ planId: plan.id, expectedRevision: plan.revision, receipt: signed.receipt,
    resolveAuthority: () => signed.authority, idempotencyKey: `approval:${suffix}` })).result
}

const releaseSignature = Buffer.alloc(64, 7).toString('base64')
const releaseSignatureDigest = createHash('sha256').update(Buffer.from(releaseSignature, 'base64')).digest('hex')

// Host-signed post-activation keys are distinct from the per-test owner approval
// key: the two trust roots (hostAttestationKeys / approvalKeys) never overlap.
function hostTrustKey(now: () => number = () => 1_800_000_000_000) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }) as string
  return { privateKey, publicKeyPem,
    authority: new Ed25519HostAttestationAuthority(publicKeyPem, 'host-runtime', 'host-key-1', now),
    observationAuthority: new Ed25519PostActivationObservationAuthority(publicKeyPem, 'host-runtime', 'host-key-1', {}, now) }
}

function ownerRetractionTrustKey(now: () => number) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { privateKey, authority: new Ed25519ActivationRetractionAuthority(
    publicKey.export({ format: 'pem', type: 'spki' }) as string, 'owner-policy', 'owner-key-1', {}, now) }
}

const attestationPhases: ReadonlyArray<{ phase: HostAttestationRequirements['kind']; requirements: HostAttestationRequirements; evidence: HostAttestationReceipt['evidence'] }> = [
  { phase: 'reload', requirements: { kind: 'reload', previousHostGeneration: 0 },
    evidence: { kind: 'reload', reloaded: true, previousHostGeneration: 0, currentHostGeneration: 7, probeDigest: 'c'.repeat(64) } },
  { phase: 'readiness', requirements: { kind: 'readiness', minimumChecks: 1 },
    evidence: { kind: 'readiness', checks: 4, failures: 0, probeDigest: 'd'.repeat(64) } },
  { phase: 'effect-blocked-replay', requirements: { kind: 'effect-blocked-replay', minimumDeliveryAttempts: 1, minimumToolExecutionAttempts: 1, maximumExternalEffects: 0 },
    evidence: { kind: 'effect-blocked-replay', deliveryAttempts: 2, deliveryBlocked: 2, toolExecutionAttempts: 2, toolExecutionBlocked: 2, externalEffects: 0, replayDigest: 'e'.repeat(64) } },
  { phase: 'shadow', requirements: { kind: 'shadow', minimumSamples: 1, maximumMismatches: 0, maximumExternalEffects: 0 },
    evidence: { kind: 'shadow', samples: 4, mismatches: 0, externalEffects: 0, traceDigest: 'f'.repeat(64) } },
  { phase: 'canary', requirements: { kind: 'canary', maximumExposures: 1, minimumSamples: 1, maximumFailures: 0 },
    evidence: { kind: 'canary', exposureId: 'exposure-1', exposures: 1, samples: 4, failures: 0, traceDigest: 'a1'.repeat(32) } },
  { phase: 'soak', requirements: { kind: 'soak', minimumWindowMs: 1_000, minimumSamples: 1, maximumFailureRate: 0 },
    evidence: { kind: 'soak', windowStartedAt: 0, windowEndedAt: 0, samples: 4, failures: 0, traceDigest: 'a2'.repeat(32) } },
  { phase: 'health', requirements: { kind: 'health', minimumChecks: 1, maximumFailures: 0 },
    evidence: { kind: 'health', checks: 4, failures: 0, probeDigest: 'a3'.repeat(32) } },
]

// Drives an approved plan through claim + all seven signed Host attestation gates
// to `activated`, mirroring the real CLI activate/attest sequence without
// touching the filesystem or the pinned external dsh executable.
async function promoted(target: Awaited<ReturnType<typeof fixture>>, suffix: string, host = hostTrustKey(target.now)) {
  let plan = await approved(target, suffix)
  plan = await target.store.claimActivation(activationClaim(plan))
  plan = target.store.advanceActivation({ planId: plan.id, expectedRevision: plan.revision, fence: plan.activation!.fence, from: 'staging', to: 'awaiting-reload' })
  let generation = 0
  for (const [index, spec] of attestationPhases.entries()) {
    const requirements: HostAttestationRequirements = spec.phase === 'reload'
      ? { kind: 'reload', previousHostGeneration: target.store.latestHostGeneration(installationId) }
      : spec.requirements
    const operation = target.store.prepareHostAttestationOperation({ planId: plan.id, expectedRevision: plan.revision,
      expectedFence: plan.activation!.fence, issuer: { mode: 'owner-manual' }, requirements, receiptTtlMs: 10_000 })
    generation += 1
    let evidence = spec.evidence
    if (spec.phase === 'reload') {
      evidence = { kind: 'reload', reloaded: true, previousHostGeneration: (requirements as { previousHostGeneration: number }).previousHostGeneration,
        currentHostGeneration: generation, probeDigest: 'c'.repeat(64) }
    } else if (spec.phase === 'soak') {
      const windowStart = target.now(); target.setNow(windowStart + 2_000)
      evidence = { ...evidence, windowStartedAt: windowStart, windowEndedAt: target.now() } as HostAttestationReceipt['evidence']
    }
    const unsigned: Omit<HostAttestationReceipt, 'signature'> = { schemaVersion: 2, receiptId: `host-${suffix}-${spec.phase}`,
      authority: 'host-runtime', keyId: 'host-key-1', installationId, planId: plan.id, planDigest: plan.digest,
      activationId: plan.activation!.id, fence: plan.activation!.fence, operationId: operation.operationId,
      requestDigest: operation.requestDigest, phase: spec.phase as HostAttestationReceipt['phase'], outcome: 'passed',
      hostGeneration: generation, evidence, evidenceDigest: hostAttestationEvidenceDigest(evidence),
      observedAt: target.now(), expiresAt: target.now() + 10_000 }
    const receipt: HostAttestationReceipt = { ...unsigned,
      signature: sign(null, Buffer.from(hostAttestationSigningPayload(unsigned)), host.privateKey).toString('base64') }
    await target.store.runHostAttestationOperation({ operationId: operation.operationId, expectedRevision: plan.revision,
      expectedFence: plan.activation!.fence, execute: async () => receipt, resolveAuthority: () => host.authority })
    const applied = await target.store.applyHostAttestation({ planId: plan.id, expectedRevision: plan.revision,
      expectedFence: plan.activation!.fence, receipt, resolveAuthority: () => host.authority,
      idempotencyKey: `host:${suffix}:${index}` })
    plan = applied.result
  }
  expect(plan.status).toBe('commit-pending')
  plan = await target.store.claimActivation({ ...activationClaim(plan) })
  plan = target.store.advanceActivation({ planId: plan.id, expectedRevision: plan.revision, fence: plan.activation!.fence,
    from: 'commit-pending', to: 'activated' })
  expect(plan.status).toBe('activated')
  return { plan, host, generation }
}

function watchObservation(
  host: ReturnType<typeof hostTrustKey>,
  plan: PluginActivationPlan,
  options: { observationId: string; disposition?: 'healthy' | 'regressed'; hostGeneration: number; observedAt: number;
    checks?: number; failures?: number; overrides?: Record<string, unknown> },
): PostActivationObservationReceipt {
  const disposition = options.disposition ?? 'healthy'
  const failures = options.failures ?? (disposition === 'regressed' ? 1 : 0)
  const evidence = { kind: 'post-activation-health' as const, checks: options.checks ?? 4, failures, probeDigest: 'b'.repeat(64) }
  const unsigned = {
    schemaVersion: 1 as const, observationId: options.observationId, authority: 'host-runtime', keyId: 'host-key-1',
    installationId, planId: plan.id, planDigest: plan.digest, activationId: plan.activation!.id, fence: plan.activation!.fence,
    package: plan.candidate.package, version: plan.candidate.version, integrity: plan.candidate.integrity,
    disposition, evidence, evidenceDigest: postActivationEvidenceDigest(evidence),
    hostGeneration: options.hostGeneration, observedAt: options.observedAt, expiresAt: options.observedAt + 10_000,
    ...options.overrides,
  }
  return { ...unsigned, signature: sign(null, Buffer.from(postActivationObservationSigningPayload(unsigned)), host.privateKey).toString('base64') }
}

function watchRetraction(
  owner: ReturnType<typeof ownerRetractionTrustKey>,
  plan: PluginActivationPlan,
  options: { retractionId: string; decidedAt: number; overrides?: Record<string, unknown> },
): ActivationRetractionReceipt {
  const unsigned = {
    schemaVersion: 1 as const, retractionId: options.retractionId, authority: 'owner-policy', keyId: 'owner-key-1',
    installationId, planId: plan.id, planDigest: plan.digest, activationId: plan.activation!.id, fence: plan.activation!.fence,
    package: plan.candidate.package, version: plan.candidate.version, integrity: plan.candidate.integrity,
    principal: 'owner@example.test', reason: 'post-canary regression accepted by owner',
    decidedAt: options.decidedAt, expiresAt: options.decidedAt + 600_000,
    ...options.overrides,
  }
  return { ...unsigned, signature: sign(null, Buffer.from(activationRetractionSigningPayload(unsigned)), owner.privateKey).toString('base64') }
}

async function reviewedSource(target: Awaited<ReturnType<typeof fixture>>, suffix: string): Promise<PluginSourcePlan> {
  const created = target.store.createSourcePlan({ gapId: gap(target.store, `source-${suffix}`).id, repository: '/canonical/repository',
    worktree: '/canonical/worktree', baseCommit: 'a'.repeat(40), name: 'health-helper', generatorDigest: 'b'.repeat(64),
    scope: ['plugins/README.md', 'plugins/health-helper'], ttlMs: 60_000, idempotencyKey: `source:create:${suffix}` }).result
  const signed = approval(created as unknown as PluginActivationPlan, target.now() + 1)
  const approvedPlan = (await target.store.approveSource({ planId: created.id, expectedRevision: created.revision, receipt: signed.receipt,
    resolveAuthority: () => signed.authority, idempotencyKey: `source:approval:${suffix}` })).result
  const running = target.store.beginSourceChecks({ planId: created.id, expectedRevision: approvedPlan.revision })
  return target.store.finishSourceChecks({ planId: created.id, expectedRevision: running.revision, succeeded: true,
    checkedTreeDigest: 'c'.repeat(64), checkedPatchDigest: 'd'.repeat(64) })
}

function releaseAuthorization(plan: PluginSourcePlan, now: number, root: string, registryReference = '@dsh-enhanced/health-helper@0.1.0') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const unsigned: Omit<SourceReleaseAuthorization, 'signature'> = { schemaVersion: 1, kind: 'dsh-source-release-authorization',
    authorizationId: `release-auth-${plan.id.slice(-12)}`, authority: 'release-owner', keyId: 'release-owner-key',
    planId: plan.id, planDigest: plan.digest, baseCommit: plan.baseCommit, checkedTreeDigest: plan.sourceCheck!.treeDigest,
    checkedPatchDigest: plan.sourceCheck!.patchDigest, scope: plan.scope, releasePolicy: { targetBranch: 'main',
      candidateId: plan.name, packageName: '@dsh-enhanced/health-helper', packageVersion: '0.1.0', packagePath: 'plugins/health-helper',
      dshBaseline: '0.1.0', capabilities: ['health'], authorities: ['read-only: health'], requires: [], registryId: 'npm',
      registryLocator: 'https://registry.example.test', registryReference,
      catalogId: 'owner-catalog', catalogPath: join(root, 'catalog.json'), minimumReproducibleBuilds: 2 },
    authorizedAt: now, expiresAt: now + 30_000 }
  const authorization: SourceReleaseAuthorization = { ...unsigned,
    signature: sign(null, Buffer.from(sourceReleaseAuthorizationSigningPayload(unsigned)), privateKey).toString('base64') }
  return { authorization, authority: new Ed25519SourceReleaseAuthorizationAuthority(
    publicKey.export({ format: 'pem', type: 'spki' }), 'release-owner', 'release-owner-key', () => now) }
}

async function startedSource(target: Awaited<ReturnType<typeof fixture>>, suffix: string, registryReference?: string): Promise<PluginSourcePlan> {
  const reviewed = await reviewedSource(target, suffix); const signed = releaseAuthorization(reviewed, target.now(), target.root, registryReference)
  return (await target.store.startSourceRelease({ planId: reviewed.id, expectedRevision: reviewed.revision,
    authorization: signed.authorization, resolveAuthority: () => signed.authority, idempotencyKey: `release:start:${suffix}` })).result
}

function releaseEnvironment(root: string, plan: PluginSourcePlan, phase: SourceReleaseRequest['phase']) {
  return { planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.release!.fence, installationId,
    ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01', path: join(root, 'control.sqlite') },
    registry: { id: 'npm', locator: 'https://registry.example.test' },
    catalog: { id: 'owner-catalog', path: join(root, 'catalog.json'),
      ...(phase === 'catalog-admission' ? { expectedBeforeDigest: 'e'.repeat(64), expectedAfterDigest: 'f'.repeat(64) } : {}) },
    adapter: { id: `adapter-${phase}`, version: '1.0.0', path: join(root, `adapter-${phase}`), sha256: '8'.repeat(64),
      interpreter: null, authority: 'release-adapter', keyId: 'release-adapter-key' }, receiptTtlMs: 10_000,
    resolveAuthorizationAuthority: () => acceptingAuthorizationAuthority }
}

function successEvidence(request: SourceReleaseRequest): Extract<SourceReleaseReceipt['evidence'], { kind: typeof request.phase }> {
  if (request.phase === 'pr') return { kind: 'pr', prId: 'pr-1', baseCommit: request.input.baseCommit, headCommit: '2'.repeat(40),
    treeDigest: request.input.expectedTreeDigest, patchDigest: request.input.expectedPatchDigest, repositoryDigest: '3'.repeat(64) } as never
  if (request.phase === 'review') return { kind: 'review', prId: request.input.prId, headCommit: request.input.headCommit,
    reviewId: 'review-1', decision: 'approved', reviewerPrincipalDigest: '4'.repeat(64), prEvidenceDigest: request.input.prEvidenceDigest } as never
  if (request.phase === 'merge') return { kind: 'merge', prId: request.input.prId, reviewedHeadCommit: request.input.headCommit,
    reviewId: request.input.reviewId, reviewEvidenceDigest: request.input.reviewEvidenceDigest, mergeCommit: '5'.repeat(40),
    targetBranch: request.input.targetBranch } as never
  if (request.phase === 'build') {
    const tarballSha256 = '6'.repeat(64)
    return { kind: 'build', isolated: true, reproducibleBuilds: 2, firstBuildSha256: tarballSha256,
      secondBuildSha256: tarballSha256, mergeEvidenceDigest: request.input.mergeEvidenceDigest, candidateId: request.input.expectedCandidateId,
      sourceName: request.input.name, packagePath: request.input.expectedPackagePath, packageName: request.input.expectedPackageName,
      packageVersion: request.input.expectedPackageVersion, tarballPath: '/release/health-helper.tgz', tarballBytes: 123, tarballSha256,
      tarballIntegrity: `sha512-${Buffer.alloc(64, 6).toString('base64')}`, sbomPath: '/release/sbom.json', sbomSha256: '7'.repeat(64),
      provenancePath: '/release/provenance.json', provenanceSha256: '8'.repeat(64), mergedCommit: request.input.mergeCommit,
      dshBaseline: request.input.expectedDshBaseline, capabilities: request.input.expectedCapabilities,
      authorities: request.input.expectedAuthorities, requires: request.input.expectedRequires } as never
  }
  if (request.phase === 'sign') return { kind: 'sign', artifactStatementDigest: controlPlaneDigest(request.input.artifact),
    artifactSignature: releaseSignature, artifactSignatureDigest: releaseSignatureDigest, buildEvidenceDigest: request.input.buildEvidenceDigest } as never
  if (request.phase === 'publish') return { kind: 'publish', registryId: request.registry.id,
    registryReference: request.authorization.releasePolicy.registryReference, packageName: request.input.artifact.packageName,
    packageVersion: request.input.artifact.packageVersion, tarballSha256: request.input.artifact.tarballSha256,
    tarballIntegrity: request.input.artifact.tarballIntegrity, artifactStatementDigest: request.input.artifactStatementDigest,
    artifactSignatureDigest: releaseSignatureDigest, signEvidenceDigest: request.input.signEvidenceDigest, immutable: true } as never
  if (request.phase === 'registry-verify') return { kind: 'registry-verify', registryId: request.registry.id,
    registryReference: request.input.registryReference, independentlyDownloaded: true, downloadedBytes: request.input.artifact.tarballBytes,
    downloadedSha256: request.input.artifact.tarballSha256, downloadedIntegrity: request.input.artifact.tarballIntegrity,
    artifactStatementDigest: request.input.artifactStatementDigest, artifactSignatureDigest: releaseSignatureDigest,
    publishEvidenceDigest: request.input.publishEvidenceDigest } as never
  return { kind: 'catalog-admission', admissionId: 'admission-1', catalogId: request.catalog.id,
    beforeCatalogDigest: request.input.expectedBeforeCatalogDigest, afterCatalogDigest: request.input.expectedAfterCatalogDigest,
    registryReference: request.input.registryReference, artifactStatementDigest: request.input.artifactStatementDigest,
    artifactSignatureDigest: releaseSignatureDigest, verificationEvidenceDigest: request.input.verificationEvidenceDigest,
    candidate: request.input.candidate } as never
}

function releaseReceipt(request: SourceReleaseRequest, evidence: SourceReleaseReceipt['evidence'],
  outcome: SourceReleaseReceipt['outcome'] = 'passed'): SourceReleaseReceipt {
  return { schemaVersion: 1, receiptId: `receipt:${request.operationId}`, authority: request.adapter.authority, keyId: request.adapter.keyId,
    installationId: request.installationId, planId: request.plan.id, planDigest: request.plan.digest, releaseId: request.release.id,
    fence: request.release.fence, operationId: request.operationId, requestDigest: controlPlaneDigest(request), phase: request.phase, outcome, evidence,
    evidenceDigest: controlPlaneDigest(evidence), observedAt: request.requestedAt, expiresAt: request.requestedAt + request.receiptTtlMs, signature: releaseSignature }
}

function tamperOperationReceipt(path: string, idempotencyKey: string, mutate: (result: Record<string, unknown>) => void): void {
  const database = new DatabaseSync(path)
  const row = database.prepare(`SELECT operation, input_digest, result_json, created_at FROM operation_receipts
    WHERE idempotency_key = ?`).get(idempotencyKey) as { operation: string; input_digest: string; result_json: string; created_at: number }
  const result = JSON.parse(row.result_json) as Record<string, unknown>; mutate(result)
  const resultJson = JSON.stringify(result)
  database.prepare('UPDATE operation_receipts SET result_json = ?, result_digest = ? WHERE idempotency_key = ?').run(
    resultJson, controlPlaneOperationReceiptDigest(idempotencyKey, row.operation, row.input_digest, resultJson, row.created_at), idempotencyKey)
  database.close()
}

const acceptingReleaseAuthority: SourceReleaseAuthority = {
  async verify(receipt) { const { signature: _signature, ...verified } = receipt; return { ...verified, signatureDigest: releaseSignatureDigest } },
}
const acceptingAuthorizationAuthority: SourceReleaseAuthorizationAuthority = {
  async verify(authorization) { return { ...authorization,
    signatureDigest: createHash('sha256').update(Buffer.from(authorization.signature, 'base64')).digest('hex') } },
}
const acceptingApprovalAuthority: ApprovalAuthority = {
  async verify(receipt) {
    const { signature, ...fields } = receipt
    return { ...fields, principal: fields.principal.normalize('NFC').trim(),
      signatureDigest: createHash('sha256').update(Buffer.from(signature, 'base64')).digest('hex') }
  },
}
function activationClaim(plan: PluginActivationPlan, leaseMs = 5_000) {
  return { planId: plan.id, expectedRevision: plan.revision, leaseMs,
    resolveApprovalAuthority: () => acceptingApprovalAuthority }
}

async function applySuccessfulReleasePhase(target: Awaited<ReturnType<typeof fixture>>, plan: PluginSourcePlan) {
  const phase = plan.status.slice('awaiting-'.length) as SourceReleaseRequest['phase']
  const operation = await target.store.prepareSourceReleaseOperation(releaseEnvironment(target.root, plan, phase))
  const receipt = releaseReceipt(operation.request, successEvidence(operation.request))
  await target.store.runSourceReleaseOperation({ operationId: operation.operationId, expectedRevision: plan.revision,
    expectedFence: plan.release!.fence, execute: async () => receipt, resolveAuthority: () => acceptingReleaseAuthority,
    resolveAuthorizationAuthority: releaseEnvironment(target.root, plan, phase).resolveAuthorizationAuthority })
  const output = await target.store.applySourceRelease({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.release!.fence,
    receipt, resolveAuthority: () => acceptingReleaseAuthority, idempotencyKey: `release:apply:${operation.phase}:${operation.attempt}` })
  return { plan: output.result, operation, receipt, output }
}

async function advanceTo(target: Awaited<ReturnType<typeof fixture>>, plan: PluginSourcePlan, stop: SourceReleaseRequest['phase']) {
  const phases = ['pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission'] as const
  let current = plan
  for (const phase of phases) {
    if (phase === stop) return current
    current = (await applySuccessfulReleasePhase(target, current)).plan
  }
  throw new Error(`phase ${stop} was not reached`)
}

async function reconcile(target: Awaited<ReturnType<typeof fixture>>, plan: PluginSourcePlan,
  outcome: SourcePublishReconciliationEvidence['outcome'], idempotencyKey: string, npm = false): Promise<PluginSourcePlan> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const authorizationAuthority = acceptingAuthorizationAuthority
  const operation = await target.store.prepareSourcePublishReconciliation({ planId: plan.id, expectedRevision: plan.revision,
    expectedFence: plan.release!.fence, installationId, ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01', path: join(target.root, 'control.sqlite') },
    registry: { id: 'npm', locator: 'https://registry.example.test' }, adapter: { id: 'registry-reconciler', version: '1.0.0',
      path: join(target.root, 'registry-reconciler'), sha256: '8'.repeat(64), interpreter: null, authority: 'registry-verifier', keyId: 'registry-key' },
    receiptTtlMs: 10_000, resolveAuthorizationAuthority: () => authorizationAuthority })
  const request = operation.request; let evidence: SourcePublishReconciliationEvidence = { kind: 'publish-reconciliation', outcome,
    registryId: request.registry.id, registryReference: outcome === 'absent' || outcome === 'unknown' ? null : request.expectedRegistryReference,
    packageName: request.artifact.packageName, packageVersion: request.artifact.packageVersion,
    expectedTarballSha256: request.artifact.tarballSha256, expectedTarballIntegrity: request.artifact.tarballIntegrity,
    expectedArtifactStatementDigest: request.expectedArtifactStatementDigest,
    expectedArtifactSignatureDigest: request.expectedArtifactSignatureDigest,
    observedTarballSha256: outcome === 'exists-match' ? request.artifact.tarballSha256 : outcome === 'digest-conflict' ? 'd'.repeat(64) : null,
    observedTarballIntegrity: outcome === 'exists-match' ? request.artifact.tarballIntegrity
      : outcome === 'digest-conflict' ? `sha512-${Buffer.alloc(64, 9).toString('base64')}` : null,
    observedArtifactStatementDigest: outcome === 'exists-match' ? request.expectedArtifactStatementDigest
      : outcome === 'digest-conflict' ? 'f'.repeat(64) : null,
    observedArtifactSignatureDigest: outcome === 'exists-match' ? request.expectedArtifactSignatureDigest
      : outcome === 'digest-conflict' ? request.expectedArtifactSignatureDigest : null,
    ambiguousPublishOperationId: request.ambiguousPublish.operationId, ambiguousPublishReceiptDigest: request.ambiguousPublish.receiptDigest,
    detailDigest: 'e'.repeat(64) }
  if (npm) {
    if (outcome === 'absent') throw new Error('npm cannot prove absence')
    const { observedArtifactStatementDigest: _statement, observedArtifactSignatureDigest: _signature, ...common } = evidence
    evidence = { ...common, kind: 'npm-publish-reconciliation', outcome,
      metadataReference: outcome === 'unknown' ? null : `${request.registry.locator}/${encodeURIComponent(request.artifact.packageName)}/${request.artifact.packageVersion}`,
      metadataIntegrity: common.observedTarballIntegrity, downloadedBytes: outcome === 'unknown' ? null : 1 }
  }
  const unsigned: Omit<SourcePublishReconciliationReceipt, 'signature'> = { schemaVersion: npm ? 2 : 1,
    kind: 'dsh-source-publish-reconciliation-receipt', receiptId: `reconcile:${operation.operationId}`, authority: 'registry-verifier',
    keyId: 'registry-key', installationId: request.installationId, planId: request.plan.id, planDigest: request.plan.digest,
    releaseId: request.release.id, fence: request.release.fence, operationId: request.operationId,
    requestDigest: sourcePublishReconciliationRequestDigest(request), evidence, evidenceDigest: sourcePublishReconciliationEvidenceDigest(evidence),
    observedAt: request.requestedAt, expiresAt: request.requestedAt + request.receiptTtlMs }
  const receipt: SourcePublishReconciliationReceipt = { ...unsigned,
    signature: sign(null, Buffer.from(sourcePublishReconciliationSigningPayload(unsigned)), privateKey).toString('base64') }
  const authority = new Ed25519SourcePublishReconciliationAuthority(publicKey.export({ type: 'spki', format: 'pem' }),
    'registry-verifier', 'registry-key', target.now)
  await target.store.runSourcePublishReconciliation({ operationId: operation.operationId, expectedRevision: plan.revision,
    expectedFence: plan.release!.fence, execute: async () => receipt, resolveAuthority: () => authority,
    resolveAuthorizationAuthority: () => authorizationAuthority })
  return (await target.store.reconcileSourcePublish({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.release!.fence,
    receipt, resolveAuthority: () => authority, idempotencyKey })).result
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('bound durable control-plane state', () => {
  test('ranks bounded ROI, snapshots exact gap evidence and enforces one active plan per gap', async () => {
    const target = await fixture(); const low = gap(target.store, 'low', 10); const high = gap(target.store, 'high', 100)
    expect(target.store.listGaps().map(item => item.id)).toEqual([high.id, low.id])
    expect(high).toMatchObject({ revision: 1, inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u), roi: 16 })
    const input = activationInput(target.root, high.id, 'plan:ranked')
    const first = target.store.createPlan(input)
    expect(first.result).toMatchObject({ schemaVersion: 4, kind: 'activation', installationId,
      gapSnapshot: { revision: 1, inputDigest: high.inputDigest, roi: high.roi },
      dossier: { catalogProvenance: 'owner-provided-integrity-pinned' } })
    expect(target.store.createPlan(input)).toEqual(first)
    expect(() => target.store.createPlan({ ...input, idempotencyKey: 'plan:second' })).toThrow('only an open gap')
    expect(() => target.store.createSourcePlan({ gapId: high.id, repository: '/repo', worktree: '/worktree',
      baseCommit: 'a'.repeat(40), name: 'health-helper', generatorDigest: 'b'.repeat(64), scope: ['plugins/README.md', 'plugins/health-helper'],
      ttlMs: 60_000, idempotencyKey: 'source:same-gap' })).toThrow('only an unreserved open gap')
  })

  test('rejects candidates that do not match the exact gap capability', async () => {
    const target = await fixture(); const mismatch = target.store.recordGap({ idempotencyKey: 'gap:calendar', capability: 'calendar',
      context: 'calendar gap', expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 0 })
    expect(() => target.store.createPlan(activationInput(target.root, mismatch.id, 'plan:mismatch'))).toThrow('does not match')
  })

  test('looks up an exact durable approval replay before expiry or authority verification', async () => {
    const target = await fixture(); const plan = target.store.createPlan(activationInput(target.root, gap(target.store, 'replay').id, 'plan:replay')).result
    const signed = approval(plan, target.now() + 1)
    const first = await target.store.approve({ planId: plan.id, expectedRevision: 1, receipt: signed.receipt,
      resolveAuthority: () => signed.authority, idempotencyKey: 'approval:replay' })
    target.setNow(target.now() + 20_000)
    const replay = await target.store.approve({ planId: plan.id, expectedRevision: 1, receipt: signed.receipt,
      resolveAuthority: () => { throw new Error('must not resolve on exact replay') }, idempotencyKey: 'approval:replay' })
    expect(replay).toEqual(first)
    await expect(target.store.approve({ planId: plan.id, expectedRevision: 1, receipt: { ...signed.receipt, signature: `${signed.receipt.signature.slice(0, -2)}AA` },
      resolveAuthority: () => signed.authority, idempotencyKey: 'approval:replay' })).rejects.toThrow('reused with different input')
  })

  test('binds source plans to repository/base/worktree/name/generator/scope and CASes local terminal state', async () => {
    const target = await fixture(); const sourceGap = gap(target.store, 'source')
    const plan = target.store.createSourcePlan({ gapId: sourceGap.id, repository: '/canonical/repository', worktree: '/canonical/worktree',
      baseCommit: 'a'.repeat(40), name: 'health-helper', generatorDigest: 'b'.repeat(64), scope: ['plugins/README.md', 'plugins/health-helper'],
      ttlMs: 60_000, idempotencyKey: 'source:create' }).result
    expect(plan).toMatchObject({ kind: 'source', repository: '/canonical/repository', worktree: '/canonical/worktree',
      baseCommit: 'a'.repeat(40), name: 'health-helper', generatorDigest: 'b'.repeat(64), scope: ['plugins/README.md', 'plugins/health-helper'] })
    const signed = approval(plan as unknown as PluginActivationPlan, target.now() + 1)
    const approvedPlan = (await target.store.approveSource({ planId: plan.id, expectedRevision: 1, receipt: signed.receipt,
      resolveAuthority: () => signed.authority, idempotencyKey: 'source:approval' })).result
    const running = target.store.beginSourceChecks({ planId: plan.id, expectedRevision: approvedPlan.revision })
    expect(() => target.store.beginSourceChecks({ planId: plan.id, expectedRevision: approvedPlan.revision })).toThrow('changed')
    expect(target.store.finishSourceChecks({ planId: plan.id, expectedRevision: running.revision, succeeded: true,
      checkedTreeDigest: 'c'.repeat(64), checkedPatchDigest: 'd'.repeat(64) })).toMatchObject({ status: 'ready-for-human-review',
      sourceCheck: { treeDigest: 'c'.repeat(64), patchDigest: 'd'.repeat(64), checkedAt: target.now() } })
  })

  test('requires fresh post-check authorization and durably advances all eight release phases', async () => {
    const target = await fixture(); const reviewed = await reviewedSource(target, 'release-happy')
    const signed = releaseAuthorization(reviewed, target.now(), target.root)
    const started = await target.store.startSourceRelease({ planId: reviewed.id, expectedRevision: reviewed.revision,
      authorization: signed.authorization, resolveAuthority: () => signed.authority, idempotencyKey: 'release:start:happy' })
    expect(started.result).toMatchObject({ status: 'awaiting-pr', revision: reviewed.revision + 1,
      release: { fence: 1 }, releaseAuthorization: { authorizationId: signed.authorization.authorizationId } })
    target.setNow(target.now() + 40_000)
    expect(await target.store.startSourceRelease({ planId: reviewed.id, expectedRevision: reviewed.revision,
      authorization: signed.authorization, resolveAuthority: () => { throw new Error('must not verify exact replay') },
      idempotencyKey: 'release:start:happy' })).toEqual(started)
    let plan = started.result; target.setNow(plan.sourceCheck!.checkedAt)
    const phases = ['pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission'] as const
    let appliedRegistryVerificationRequest: Extract<SourceReleaseRequest, { phase: 'registry-verify' }> | undefined
    let appliedRegistryVerificationReceipt: SourceReleaseReceipt | undefined
    for (const phase of phases) {
      expect(plan.status).toBe(`awaiting-${phase}`)
      const beforeRevision = plan.revision
      const applied = await applySuccessfulReleasePhase(target, plan)
      expect(applied.operation).toMatchObject({ phase, status: 'pending', fence: 1, attempt: 1 })
      const durableOperation = target.store.getSourceReleaseOperation(applied.operation.operationId)
      expect(durableOperation.status).toBe('applied')
      if (phase === 'registry-verify') {
        if (durableOperation.request.phase !== 'registry-verify') throw new Error('durable operation is not registry verification')
        appliedRegistryVerificationRequest = durableOperation.request
        appliedRegistryVerificationReceipt = durableOperation.receipt
      }
      if (phase === 'catalog-admission') {
        if (applied.operation.request.phase !== 'catalog-admission' || appliedRegistryVerificationRequest === undefined
          || appliedRegistryVerificationReceipt === undefined) {
          throw new Error('catalog admission request is missing its applied registry verification receipt')
        }
        expect(applied.operation.request.input.registryVerificationRequest).toEqual(appliedRegistryVerificationRequest)
        expect(applied.operation.request.input.registryVerificationReceipt).toEqual(appliedRegistryVerificationReceipt)
        expect(applied.operation.request.input.verificationEvidenceDigest).toBe(appliedRegistryVerificationReceipt.evidenceDigest)
        expect(applied.operation.request.input.registryVerificationReceipt.evidenceDigest)
          .toBe(controlPlaneDigest(applied.operation.request.input.registryVerificationReceipt.evidence))
      }
      plan = applied.plan; expect(plan.revision).toBe(beforeRevision + 1)
    }
    expect(plan.status).toBe('release-complete')
    const releasedGap = target.store.getGap(plan.gapId)
    expect(releasedGap.status).toBe('open')
    const releasedCandidate = target.store.sourceReleaseCandidate(plan.id)
    expect(releasedGap.candidateId).toBe(releasedCandidate.id)
    expect(() => target.store.createPlan({ ...activationInput(target.root, plan.gapId, 'activation:wrong-released'),
      candidate, matchedCapabilities: candidate.capabilities })).toThrow('reserved for its exact admitted candidate')
    expect(() => target.store.createSourcePlan({ gapId: plan.gapId, repository: '/repo', worktree: '/worktree',
      baseCommit: 'a'.repeat(40), name: 'second', generatorDigest: 'b'.repeat(64), scope: ['plugins/README.md', 'plugins/second'],
      ttlMs: 60_000, idempotencyKey: 'source:released-race' })).toThrow('unreserved open gap')
    const activation = target.store.createPlan({ ...activationInput(target.root, plan.gapId, 'activation:released'),
      candidate: releasedCandidate, catalog: { digest: controlPlaneDigest({ schemaVersion: 1, entries: [releasedCandidate] }),
        provenance: 'owner-provided-integrity-pinned' }, matchedCapabilities: releasedCandidate.capabilities }).result
    expect(activation).toMatchObject({ kind: 'activation', gapId: plan.gapId, candidate: releasedCandidate, status: 'pending-approval' })
    expect(target.store.getGap(plan.gapId)).toMatchObject({ status: 'matched', candidateId: releasedCandidate.id })
    const database = new DatabaseSync(target.path)
    expect((database.prepare('SELECT count(*) AS count FROM source_release_operations WHERE plan_id = ? AND status = ?')
      .get(plan.id, 'applied') as { count: number }).count).toBe(8)
    database.close()
  })

  test('makes completed release operations crash-safe, single-flight and exact-binding idempotent', async () => {
    const target = await fixture(); const plan = await startedSource(target, 'release-crash')
    const input = releaseEnvironment(target.root, plan, 'pr')
    const prepared = await target.store.prepareSourceReleaseOperation(input)
    target.store.close()
    const recovered = new ControlPlaneStore({ path: target.path, now: target.now }); target.store = recovered
    expect(await recovered.prepareSourceReleaseOperation(input)).toEqual(prepared)
    await expect(recovered.prepareSourceReleaseOperation({ ...input, adapter: { ...input.adapter, id: 'changed-adapter' } })).rejects.toThrow('payload changed')
    let calls = 0
    const receipt = releaseReceipt(prepared.request, successEvidence(prepared.request))
    await recovered.runSourceReleaseOperation({ operationId: prepared.operationId, expectedRevision: plan.revision,
      expectedFence: plan.release!.fence, execute: async () => {
        calls += 1
        const probe = `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]);
db.exec('PRAGMA busy_timeout=100'); try { db.exec('BEGIN IMMEDIATE'); process.stdout.write('acquired'); db.exec('ROLLBACK') }
catch { process.stdout.write('busy') } finally { db.close() }`
        expect(execFileSync(process.execPath, ['-e', probe, target.path], { encoding: 'utf8' })).toBe('busy')
        return receipt
      }, resolveAuthority: () => acceptingReleaseAuthority, resolveAuthorizationAuthority: () => acceptingAuthorizationAuthority })
    recovered.close()
    const afterCompletion = new ControlPlaneStore({ path: target.path, now: target.now }); target.store = afterCompletion
    await afterCompletion.runSourceReleaseOperation({ operationId: prepared.operationId, expectedRevision: plan.revision,
      expectedFence: plan.release!.fence, execute: async () => { calls += 1; throw new Error('must not execute completed operation') },
      resolveAuthority: () => acceptingReleaseAuthority, resolveAuthorizationAuthority: () => acceptingAuthorizationAuthority })
    expect(calls).toBe(1)
    const applied = await afterCompletion.applySourceRelease({ planId: plan.id, expectedRevision: plan.revision,
      expectedFence: plan.release!.fence, receipt, resolveAuthority: () => acceptingReleaseAuthority, idempotencyKey: 'release:crash:apply' })
    target.setNow(target.now() + 20_000)
    expect(await afterCompletion.applySourceRelease({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.release!.fence,
      receipt, resolveAuthority: () => { throw new Error('must not verify exact replay') }, idempotencyKey: 'release:crash:apply' })).toEqual(applied)
    await expect(afterCompletion.applySourceRelease({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.release!.fence,
      receipt: { ...receipt, receiptId: 'changed' }, resolveAuthority: () => acceptingReleaseAuthority,
      idempotencyKey: 'release:crash:apply' })).rejects.toThrow('reused with different input')
  })

  test('makes failed release receipts terminal and rejects stale revisions and fences', async () => {
    const target = await fixture(); const plan = await startedSource(target, 'release-failed')
    const operation = await target.store.prepareSourceReleaseOperation(releaseEnvironment(target.root, plan, 'pr'))
    const evidence = { kind: 'failure' as const, phase: 'pr' as const, code: 'REMOTE_REJECTED',
      remoteState: 'unchanged' as const, detailDigest: '9'.repeat(64) }
    const receipt = releaseReceipt(operation.request, evidence, 'failed')
    await target.store.runSourceReleaseOperation({ operationId: operation.operationId, expectedRevision: plan.revision,
      expectedFence: plan.release!.fence, execute: async () => receipt, resolveAuthority: () => acceptingReleaseAuthority,
      resolveAuthorizationAuthority: () => acceptingAuthorizationAuthority })
    const failed = (await target.store.applySourceRelease({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.release!.fence,
      receipt, resolveAuthority: () => acceptingReleaseAuthority, idempotencyKey: 'release:failed:apply' })).result
    expect(failed).toMatchObject({ status: 'release-failed', release: { fence: 1, failurePhase: 'pr', failureCode: 'REMOTE_REJECTED' } })
    expect(target.store.getGap(plan.gapId).status).toBe('open')
    expect(target.store.health().failed).toBe(1)
    await expect(target.store.prepareSourceReleaseOperation(releaseEnvironment(target.root, plan, 'pr'))).rejects.toThrow()
    await expect(target.store.applySourceRelease({ planId: plan.id, expectedRevision: failed.revision, expectedFence: plan.release!.fence + 1,
      receipt, resolveAuthority: () => acceptingReleaseAuthority, idempotencyKey: 'release:failed:stale' })).rejects.toThrow()
  })

  test('does not export an activation candidate before the entire release is admitted', async () => {
    const target = await fixture(); let plan = await startedSource(target, 'early-candidate')
    plan = await advanceTo(target, plan, 'sign')
    expect(plan.status).toBe('awaiting-sign')
    expect(() => target.store.sourceReleaseCandidate(plan.id)).toThrow('not admitted until release completes')
  })

  test('re-verifies durable release authorization before any external phase execution', async () => {
    const target = await fixture(); const plan = await startedSource(target, 'run-expired-authorization')
    const operation = await target.store.prepareSourceReleaseOperation(releaseEnvironment(target.root, plan, 'pr'))
    target.setNow(plan.releaseAuthorization!.expiresAt + 1); let executions = 0
    const expiringAuthority: SourceReleaseAuthorizationAuthority = { async verify(authorization) {
      if (target.now() > authorization.expiresAt) throw new Error('release authorization expired')
      return authorization as PluginSourcePlan['releaseAuthorization'] & {}
    } }
    await expect(target.store.runSourceReleaseOperation({ operationId: operation.operationId, expectedRevision: plan.revision,
      expectedFence: plan.release!.fence, execute: async () => { executions += 1; throw new Error('must not execute') },
      resolveAuthority: () => acceptingReleaseAuthority, resolveAuthorizationAuthority: () => expiringAuthority })).rejects.toThrow()
    expect(executions).toBe(0)
    expect(target.store.getSourceReleaseOperation(operation.operationId).status).toBe('pending')
  })

  test('rejects coordinated authorization row and durable request tampering before execution', async () => {
    const target = await fixture(); const reviewed = await reviewedSource(target, 'run-authorization-tamper')
    const signed = releaseAuthorization(reviewed, target.now(), target.root)
    const plan = (await target.store.startSourceRelease({ planId: reviewed.id, expectedRevision: reviewed.revision,
      authorization: signed.authorization, resolveAuthority: () => signed.authority, idempotencyKey: 'release:start:run-auth-tamper' })).result
    const operation = await target.store.prepareSourceReleaseOperation({ ...releaseEnvironment(target.root, plan, 'pr'),
      resolveAuthorizationAuthority: () => signed.authority })
    target.store.close(); const database = new DatabaseSync(target.path)
    const authorization = JSON.parse((database.prepare('SELECT release_authorization_json AS value FROM source_plans WHERE id = ?')
      .get(plan.id) as { value: string }).value) as Record<string, unknown>
    authorization['releasePolicy'] = { ...(authorization['releasePolicy'] as Record<string, unknown>), targetBranch: 'attacker-branch' }
    database.prepare('UPDATE source_plans SET release_authorization_json = ?, release_authorization_digest = ? WHERE id = ?')
      .run(JSON.stringify(authorization), controlPlaneDigest(authorization), plan.id)
    const request = { ...operation.request, authorization } as unknown as SourceReleaseRequest
    const { operationId: _operationId, requestedAt: _requestedAt, ...binding } = request
    database.prepare(`UPDATE source_release_operations SET request_json = ?, request_digest = ?, binding_digest = ?
      WHERE operation_id = ?`).run(JSON.stringify(request), controlPlaneDigest(request), controlPlaneDigest(binding), operation.operationId)
    database.close(); const reopened = new ControlPlaneStore({ path: target.path, now: target.now }); target.store = reopened
    let executions = 0
    await expect(reopened.runSourceReleaseOperation({ operationId: operation.operationId, expectedRevision: plan.revision,
      expectedFence: plan.release!.fence, execute: async () => { executions += 1; throw new Error('must not execute') },
      resolveAuthority: () => acceptingReleaseAuthority, resolveAuthorizationAuthority: () => signed.authority })).rejects.toThrow()
    expect(executions).toBe(0)
    expect(reopened.getSourceReleaseOperation(operation.operationId).status).toBe('pending')
  })

  test('re-verifies release authorization before any publish reconciliation side effect', async () => {
    const target = await fixture(); let plan = await advanceTo(target, await startedSource(target, 'reconcile-expired-authorization'), 'publish')
    const publish = await target.store.prepareSourceReleaseOperation(releaseEnvironment(target.root, plan, 'publish'))
    const artifact = publish.request.phase === 'publish' ? publish.request.input.artifact : (() => { throw new Error('phase') })()
    const ambiguity = releaseReceipt(publish.request, { kind: 'publish-ambiguity', registryId: 'npm', packageName: artifact.packageName,
      packageVersion: artifact.packageVersion, tarballSha256: artifact.tarballSha256, detailDigest: 'a'.repeat(64) }, 'ambiguous')
    await target.store.runSourceReleaseOperation({ operationId: publish.operationId, expectedRevision: plan.revision,
      expectedFence: plan.release!.fence, execute: async () => ambiguity, resolveAuthority: () => acceptingReleaseAuthority,
      resolveAuthorizationAuthority: () => acceptingAuthorizationAuthority })
    plan = (await target.store.applySourceRelease({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.release!.fence,
      receipt: ambiguity, resolveAuthority: () => acceptingReleaseAuthority, idempotencyKey: 'release:reconcile-expired:apply' })).result
    const operation = await target.store.prepareSourcePublishReconciliation({ planId: plan.id, expectedRevision: plan.revision,
      expectedFence: plan.release!.fence, installationId, ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01', path: join(target.root, 'control.sqlite') },
      registry: { id: 'npm', locator: 'https://registry.example.test' }, adapter: { id: 'registry-reconciler', version: '1.0.0',
        path: join(target.root, 'registry-reconciler'), sha256: '8'.repeat(64), interpreter: null, authority: 'registry-verifier', keyId: 'registry-key' },
      receiptTtlMs: 10_000, resolveAuthorizationAuthority: () => acceptingAuthorizationAuthority })
    target.setNow(plan.releaseAuthorization!.expiresAt + 1); let executions = 0
    const expired: SourceReleaseAuthorizationAuthority = { async verify(authorization) {
      if (target.now() > authorization.expiresAt) throw new Error('release authorization expired')
      return authorization as PluginSourcePlan['releaseAuthorization'] & {}
    } }
    await expect(target.store.runSourcePublishReconciliation({ operationId: operation.operationId, expectedRevision: plan.revision,
      expectedFence: plan.release!.fence, execute: async () => { executions += 1; throw new Error('must not execute') },
      resolveAuthority: () => { throw new Error('must not resolve receipt') }, resolveAuthorizationAuthority: () => expired })).rejects.toThrow()
    expect(executions).toBe(0)
    expect(target.store.getSourcePublishReconciliationOperation(operation.operationId).status).toBe('pending')
  })

  test.each(['created-not-reverted', 'unknown'] as const)('retains the gap claim for %s remote failure state', async remoteState => {
    const target = await fixture(); const plan = await startedSource(target, `release-${remoteState}`)
    const operation = await target.store.prepareSourceReleaseOperation(releaseEnvironment(target.root, plan, 'pr'))
    const evidence = { kind: 'failure' as const, phase: 'pr' as const, code: 'REMOTE_FAILURE', remoteState, detailDigest: '9'.repeat(64) }
    const receipt = releaseReceipt(operation.request, evidence, 'failed')
    await target.store.runSourceReleaseOperation({ operationId: operation.operationId, expectedRevision: plan.revision,
      expectedFence: plan.release!.fence, execute: async () => receipt, resolveAuthority: () => acceptingReleaseAuthority,
      resolveAuthorizationAuthority: () => acceptingAuthorizationAuthority })
    const failed = (await target.store.applySourceRelease({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.release!.fence,
      receipt, resolveAuthority: () => acceptingReleaseAuthority, idempotencyKey: `release:${remoteState}:apply` })).result
    expect(failed).toMatchObject({ status: 'release-failed', release: { failureCode: `REMOTE_FAILURE:${remoteState}` } })
    expect(target.store.getGap(plan.gapId).status).toBe('matched')
    expect(() => target.store.createSourcePlan({ gapId: plan.gapId, repository: '/repo', worktree: '/worktree', baseCommit: 'a'.repeat(40),
      name: 'second', generatorDigest: 'b'.repeat(64), scope: ['plugins/README.md', 'plugins/second'], ttlMs: 60_000,
      idempotencyKey: `source:second:${remoteState}` })).toThrow('only an unreserved open gap')
  })

  test('preserves ambiguous publish evidence and reconciles absent, unknown, match and digest conflict safely', async () => {
    const target = await fixture(); let plan = await advanceTo(target, await startedSource(target, 'release-ambiguity'), 'publish')
    const operation = await target.store.prepareSourceReleaseOperation(releaseEnvironment(target.root, plan, 'publish'))
    const artifact = operation.request.phase === 'publish' ? operation.request.input.artifact : (() => { throw new Error('phase') })()
    const ambiguity = { kind: 'publish-ambiguity' as const, registryId: 'npm', packageName: artifact.packageName,
      packageVersion: artifact.packageVersion, tarballSha256: artifact.tarballSha256, detailDigest: 'a'.repeat(64) }
    const receipt = releaseReceipt(operation.request, ambiguity, 'ambiguous')
    await target.store.runSourceReleaseOperation({ operationId: operation.operationId, expectedRevision: plan.revision,
      expectedFence: plan.release!.fence, execute: async () => receipt, resolveAuthority: () => acceptingReleaseAuthority,
      resolveAuthorizationAuthority: () => acceptingAuthorizationAuthority })
    plan = (await target.store.applySourceRelease({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.release!.fence,
      receipt, resolveAuthority: () => acceptingReleaseAuthority, idempotencyKey: 'release:ambiguous:apply' })).result
    expect(plan.status).toBe('publish-ambiguous')
    const unknown = await reconcile(target, plan, 'unknown', 'release:reconcile:unknown')
    expect(unknown).toMatchObject({ status: 'publish-ambiguous', release: { fence: 1 } })
    const absent = await reconcile(target, unknown, 'absent', 'release:reconcile:absent')
    expect(absent).toMatchObject({ status: 'awaiting-publish', release: { fence: 2 } })
    await expect(target.store.runSourceReleaseOperation({ operationId: operation.operationId, expectedRevision: absent.revision, expectedFence: 2,
      execute: async () => receipt, resolveAuthority: () => acceptingReleaseAuthority,
      resolveAuthorizationAuthority: () => acceptingAuthorizationAuthority })).rejects.toThrow()
    const retry = await target.store.prepareSourceReleaseOperation(releaseEnvironment(target.root, absent, 'publish'))
    expect(retry).toMatchObject({ attempt: 2, fence: 2 }); expect(retry.operationId).not.toBe(operation.operationId)

    const other = await fixture(); let matched = await advanceTo(other, await startedSource(other, 'release-match'), 'publish')
    const ambiguousOperation = await other.store.prepareSourceReleaseOperation(releaseEnvironment(other.root, matched, 'publish'))
    const ambiguousArtifact = ambiguousOperation.request.phase === 'publish' ? ambiguousOperation.request.input.artifact : (() => { throw new Error('phase') })()
    const ambiguousReceipt = releaseReceipt(ambiguousOperation.request, { kind: 'publish-ambiguity', registryId: 'npm',
      packageName: ambiguousArtifact.packageName, packageVersion: ambiguousArtifact.packageVersion,
      tarballSha256: ambiguousArtifact.tarballSha256, detailDigest: 'b'.repeat(64) }, 'ambiguous')
    await other.store.runSourceReleaseOperation({ operationId: ambiguousOperation.operationId, expectedRevision: matched.revision,
      expectedFence: 1, execute: async () => ambiguousReceipt, resolveAuthority: () => acceptingReleaseAuthority,
      resolveAuthorizationAuthority: () => acceptingAuthorizationAuthority })
    matched = (await other.store.applySourceRelease({ planId: matched.id, expectedRevision: matched.revision, expectedFence: 1,
      receipt: ambiguousReceipt, resolveAuthority: () => acceptingReleaseAuthority, idempotencyKey: 'release:match:apply' })).result
    matched = await reconcile(other, matched, 'exists-match', 'release:reconcile:match')
    expect(matched.status).toBe('awaiting-registry-verify')
    expect((await other.store.prepareSourceReleaseOperation(releaseEnvironment(other.root, matched, 'registry-verify'))).phase).toBe('registry-verify')

    const conflictTarget = await fixture(); let conflict = await advanceTo(conflictTarget, await startedSource(conflictTarget, 'release-conflict'), 'publish')
    const conflictOperation = await conflictTarget.store.prepareSourceReleaseOperation(releaseEnvironment(conflictTarget.root, conflict, 'publish'))
    const conflictArtifact = conflictOperation.request.phase === 'publish' ? conflictOperation.request.input.artifact : (() => { throw new Error('phase') })()
    const conflictReceipt = releaseReceipt(conflictOperation.request, { kind: 'publish-ambiguity', registryId: 'npm',
      packageName: conflictArtifact.packageName, packageVersion: conflictArtifact.packageVersion, tarballSha256: conflictArtifact.tarballSha256,
      detailDigest: 'c'.repeat(64) }, 'ambiguous')
    await conflictTarget.store.runSourceReleaseOperation({ operationId: conflictOperation.operationId, expectedRevision: conflict.revision,
      expectedFence: 1, execute: async () => conflictReceipt, resolveAuthority: () => acceptingReleaseAuthority,
      resolveAuthorizationAuthority: () => acceptingAuthorizationAuthority })
    conflict = (await conflictTarget.store.applySourceRelease({ planId: conflict.id, expectedRevision: conflict.revision, expectedFence: 1,
      receipt: conflictReceipt, resolveAuthority: () => acceptingReleaseAuthority, idempotencyKey: 'release:conflict:apply' })).result
    const terminal = await reconcile(conflictTarget, conflict, 'digest-conflict', 'release:reconcile:conflict')
    expect(terminal).toMatchObject({ status: 'release-failed', release: { failureCode: 'publish-digest-conflict' } })
    expect(conflictTarget.store.getGap(terminal.gapId).status).toBe('matched')
  })

  test.each(['exists-match', 'unknown', 'digest-conflict'] as const)('persists npm v2 %s through the existing release state machine and restart', async outcome => {
    const target = await fixture()
    let plan = await advanceTo(target, await startedSource(target, `npm-${outcome}`, 'https://registry.example.test/package.tgz'), 'publish')
    const operation = await target.store.prepareSourceReleaseOperation(releaseEnvironment(target.root, plan, 'publish'))
    if (operation.request.phase !== 'publish') throw new Error('wrong fixture phase')
    const artifact = operation.request.input.artifact
    const receipt = releaseReceipt(operation.request, { kind: 'publish-ambiguity', registryId: 'npm', packageName: artifact.packageName,
      packageVersion: artifact.packageVersion, tarballSha256: artifact.tarballSha256, detailDigest: 'a'.repeat(64) }, 'ambiguous')
    await target.store.runSourceReleaseOperation({ operationId: operation.operationId, expectedRevision: plan.revision,
      expectedFence: 1, execute: async () => receipt, resolveAuthority: () => acceptingReleaseAuthority,
      resolveAuthorizationAuthority: () => acceptingAuthorizationAuthority })
    plan = (await target.store.applySourceRelease({ planId: plan.id, expectedRevision: plan.revision, expectedFence: 1,
      receipt, resolveAuthority: () => acceptingReleaseAuthority, idempotencyKey: 'npm:ambiguous' })).result
    const reconciled = await reconcile(target, plan, outcome, `npm:reconcile:${outcome}`, true)
    const status = outcome === 'exists-match' ? 'awaiting-registry-verify' : outcome === 'unknown' ? 'publish-ambiguous' : 'release-failed'
    expect(reconciled).toMatchObject({ status, revision: plan.revision + 1, release: { fence: 1 } })
    target.store.close()
    const reopened = new ControlPlaneStore({ path: target.path, now: target.now })
    try {
      expect(reopened.getSourcePlan(plan.id)).toEqual(reconciled)
      if (outcome === 'exists-match') {
        const next = await reopened.prepareSourceReleaseOperation(releaseEnvironment(target.root, reconciled, 'registry-verify'))
        expect(next.request).toMatchObject({ phase: 'registry-verify', input: { artifact } })
      } else {
        await expect(reopened.prepareSourceReleaseOperation(releaseEnvironment(target.root, reconciled, 'publish'))).rejects.toThrow()
      }
    } finally { reopened.close() }
  })

  test('fails closed when durable release requests, receipts, or row bindings are tampered', async () => {
    for (const column of ['request_json', 'receipt_digest'] as const) {
      const target = await fixture(); const plan = await startedSource(target, `tamper-${column}`)
      const operation = await target.store.prepareSourceReleaseOperation(releaseEnvironment(target.root, plan, 'pr'))
      const receipt = releaseReceipt(operation.request, successEvidence(operation.request))
      if (column === 'receipt_digest') {
        await target.store.runSourceReleaseOperation({ operationId: operation.operationId, expectedRevision: plan.revision,
          expectedFence: plan.release!.fence, execute: async () => receipt, resolveAuthority: () => acceptingReleaseAuthority,
          resolveAuthorizationAuthority: () => acceptingAuthorizationAuthority })
      }
      target.store.close()
      const database = new DatabaseSync(target.path)
      if (column === 'request_json') {
        const changed = { ...operation.request, attempt: operation.request.attempt + 1 }
        database.prepare('UPDATE source_release_operations SET request_json = ? WHERE operation_id = ?')
          .run(JSON.stringify(changed), operation.operationId)
      } else {
        database.prepare('UPDATE source_release_operations SET receipt_digest = ? WHERE operation_id = ?')
          .run('f'.repeat(64), operation.operationId)
      }
      database.close(); const reopened = new ControlPlaneStore({ path: target.path, now: target.now }); target.store = reopened
      expect(() => reopened.getSourceReleaseOperation(operation.operationId)).toThrow()
    }
  })

  test('rejects coordinated authorization and idempotency-result tampering', async () => {
    const target = await fixture(); const reviewed = await reviewedSource(target, 'tamper-authorization')
    const signed = releaseAuthorization(reviewed, target.now(), target.root)
    const started = await target.store.startSourceRelease({ planId: reviewed.id, expectedRevision: reviewed.revision,
      authorization: signed.authorization, resolveAuthority: () => signed.authority, idempotencyKey: 'release:start:tamper' })
    target.store.close(); const database = new DatabaseSync(target.path)
    const authorization = JSON.parse((database.prepare('SELECT release_authorization_json AS value FROM source_plans WHERE id = ?')
      .get(reviewed.id) as { value: string }).value) as Record<string, unknown>
    authorization.releasePolicy = { ...(authorization.releasePolicy as Record<string, unknown>), targetBranch: 'evil' }
    database.prepare('UPDATE source_plans SET release_authorization_json = ?, release_authorization_digest = ? WHERE id = ?')
      .run(JSON.stringify(authorization), controlPlaneDigest(authorization), reviewed.id)
    database.close(); const reopened = new ControlPlaneStore({ path: target.path, now: target.now }); target.store = reopened
    await expect(reopened.prepareSourceReleaseOperation({ ...releaseEnvironment(target.root, reopened.getSourcePlan(reviewed.id), 'pr'),
      resolveAuthorizationAuthority: () => signed.authority })).rejects.toThrow()
    reopened.close()

    const receiptDatabase = new DatabaseSync(target.path)
    receiptDatabase.prepare(`UPDATE operation_receipts SET result_json = json_set(result_json, '$.status', 'release-complete')
      WHERE idempotency_key = ?`).run('release:start:tamper')
    receiptDatabase.close(); const receiptStore = new ControlPlaneStore({ path: target.path, now: target.now }); target.store = receiptStore
    await expect(receiptStore.startSourceRelease({ planId: reviewed.id, expectedRevision: reviewed.revision, authorization: signed.authorization,
      resolveAuthority: () => signed.authority, idempotencyKey: 'release:start:tamper' })).rejects.toThrow('corrupt')
    expect(started.result.status).toBe('awaiting-pr')
  })

  test.each([
    ['approval principal', (result: Record<string, unknown>) => {
      const approval = result['approval'] as Record<string, unknown>; approval['principal'] = 'attacker@example.test'
    }],
    ['release updatedAt', (result: Record<string, unknown>) => {
      const release = result['release'] as Record<string, unknown>; release['updatedAt'] = Number(release['updatedAt']) + 1
    }],
    ['unknown top-level field', (result: Record<string, unknown>) => { result['unexpected'] = true }],
  ] as const)('rejects source release replay with coordinated %s tampering', async (_label, mutate) => {
    const suffix = _label.replaceAll(' ', '-')
    const target = await fixture(); const reviewed = await reviewedSource(target, `receipt-${suffix}`)
    const signed = releaseAuthorization(reviewed, target.now(), target.root)
    await target.store.startSourceRelease({ planId: reviewed.id, expectedRevision: reviewed.revision,
      authorization: signed.authorization, resolveAuthority: () => signed.authority, idempotencyKey: `release:start:${suffix}` })
    target.store.close(); tamperOperationReceipt(target.path, `release:start:${suffix}`, mutate)
    const reopened = new ControlPlaneStore({ path: target.path, now: target.now }); target.store = reopened
    await expect(reopened.startSourceRelease({ planId: reviewed.id, expectedRevision: reviewed.revision,
      authorization: signed.authorization, resolveAuthority: () => signed.authority,
      idempotencyKey: `release:start:${suffix}` })).rejects.toThrow()
  })

  test('rejects coordinated source approval replay tampering', async () => {
    const target = await fixture(); const created = target.store.createSourcePlan({ gapId: gap(target.store, 'approval-replay-tamper').id,
      repository: '/canonical/repository', worktree: '/canonical/worktree', baseCommit: 'a'.repeat(40), name: 'health-helper',
      generatorDigest: 'b'.repeat(64), scope: ['plugins/README.md', 'plugins/health-helper'], ttlMs: 60_000,
      idempotencyKey: 'source:create:approval-tamper' }).result
    const signed = approval(created as unknown as PluginActivationPlan, target.now() + 1)
    await target.store.approveSource({ planId: created.id, expectedRevision: created.revision, receipt: signed.receipt,
      resolveAuthority: () => signed.authority, idempotencyKey: 'source:approval:tamper' })
    target.store.close(); tamperOperationReceipt(target.path, 'source:approval:tamper', result => {
      const storedApproval = result['approval'] as Record<string, unknown>; storedApproval['principal'] = 'attacker@example.test'
    })
    const reopened = new ControlPlaneStore({ path: target.path, now: target.now }); target.store = reopened
    await expect(reopened.approveSource({ planId: created.id, expectedRevision: created.revision, receipt: signed.receipt,
      resolveAuthority: () => { throw new Error('must not verify corrupt replay') }, idempotencyKey: 'source:approval:tamper' })).rejects.toThrow()
  })

  test('rejects coordinated source creation replay tampering', async () => {
    const target = await fixture(); const sourceGap = gap(target.store, 'create-replay-tamper')
    const input = { gapId: sourceGap.id, repository: '/canonical/repository', worktree: '/canonical/worktree',
      baseCommit: 'a'.repeat(40), name: 'health-helper', generatorDigest: 'b'.repeat(64),
      scope: ['plugins/README.md', 'plugins/health-helper'], ttlMs: 60_000, idempotencyKey: 'source:create:tamper' }
    target.store.createSourcePlan(input); target.store.close()
    tamperOperationReceipt(target.path, input.idempotencyKey, result => { result['approval'] = { injected: true } })
    const reopened = new ControlPlaneStore({ path: target.path, now: target.now }); target.store = reopened
    expect(() => reopened.createSourcePlan(input)).toThrow()
  })

  test('rejects source creation replay when both authoritative row and receipt are changed away from the original request', async () => {
    const target = await fixture(); const sourceGap = gap(target.store, 'create-authoritative-tamper')
    const input = { gapId: sourceGap.id, repository: '/canonical/repository', worktree: '/canonical/worktree',
      baseCommit: 'a'.repeat(40), name: 'health-helper', generatorDigest: 'b'.repeat(64),
      scope: ['plugins/README.md', 'plugins/health-helper'], ttlMs: 60_000, idempotencyKey: 'source:create:authoritative-tamper' }
    const original = target.store.createSourcePlan(input).result; target.store.close()
    const database = new DatabaseSync(target.path)
    const resultRow = database.prepare('SELECT result_json FROM operation_receipts WHERE idempotency_key = ?')
      .get(input.idempotencyKey) as { result_json: string }
    const changed = JSON.parse(resultRow.result_json) as Record<string, unknown>; changed['repository'] = '/attacker/repository'
    const immutable = { schemaVersion: changed['schemaVersion'], kind: changed['kind'], id: changed['id'], gapId: changed['gapId'],
      gapSnapshot: changed['gapSnapshot'], repository: changed['repository'], worktree: changed['worktree'], baseCommit: changed['baseCommit'],
      name: changed['name'], generatorDigest: changed['generatorDigest'], scope: changed['scope'], createdAt: changed['createdAt'], expiresAt: changed['expiresAt'] }
    changed['digest'] = controlPlaneDigest(immutable)
    const resultJson = JSON.stringify(changed)
    const envelope = database.prepare(`SELECT operation, input_digest, created_at FROM operation_receipts WHERE idempotency_key = ?`)
      .get(input.idempotencyKey) as { operation: string; input_digest: string; created_at: number }
    database.prepare(`UPDATE operation_receipts SET result_json = ?, result_digest = ? WHERE idempotency_key = ?`).run(resultJson,
      controlPlaneOperationReceiptDigest(input.idempotencyKey, envelope.operation, envelope.input_digest, resultJson, envelope.created_at), input.idempotencyKey)
    database.prepare('UPDATE source_plans SET repository = ?, plan_digest = ? WHERE id = ?')
      .run('/attacker/repository', String(changed['digest']), original.id)
    database.close(); const reopened = new ControlPlaneStore({ path: target.path, now: target.now }); target.store = reopened
    expect(() => reopened.createSourcePlan(input)).toThrow()
  })

  test('rejects coordinated activation create and approval replay tampering', async () => {
    const createTarget = await fixture(); const createInput = activationInput(createTarget.root,
      gap(createTarget.store, 'activation-create-tamper').id, 'activation:create:tamper')
    createTarget.store.createPlan(createInput); createTarget.store.close()
    tamperOperationReceipt(createTarget.path, createInput.idempotencyKey, result => {
      const target = result['target'] as Record<string, unknown>; target['profilePath'] = '/attacker/profile'
    })
    const createReplay = new ControlPlaneStore({ path: createTarget.path, now: createTarget.now }); createTarget.store = createReplay
    expect(() => createReplay.createPlan(createInput)).toThrow()

    const approvalTarget = await fixture(); const plan = approvalTarget.store.createPlan(activationInput(approvalTarget.root,
      gap(approvalTarget.store, 'activation-approval-tamper').id, 'activation:approval:create')).result
    const signed = approval(plan, approvalTarget.now() + 1)
    await approvalTarget.store.approve({ planId: plan.id, expectedRevision: plan.revision, receipt: signed.receipt,
      resolveAuthority: () => signed.authority, idempotencyKey: 'activation:approval:tamper' })
    approvalTarget.store.close(); tamperOperationReceipt(approvalTarget.path, 'activation:approval:tamper', result => {
      const storedApproval = result['approval'] as Record<string, unknown>; storedApproval['principal'] = 'attacker@example.test'
    })
    const approvalReplay = new ControlPlaneStore({ path: approvalTarget.path, now: approvalTarget.now }); approvalTarget.store = approvalReplay
    await expect(approvalReplay.approve({ planId: plan.id, expectedRevision: plan.revision, receipt: signed.receipt,
      resolveAuthority: () => { throw new Error('must not verify corrupt activation replay') },
      idempotencyKey: 'activation:approval:tamper' })).rejects.toThrow()
  })

  test('rejects activation creation replay when authoritative row and receipt both diverge from original input', async () => {
    const target = await fixture(); const input = activationInput(target.root, gap(target.store, 'activation-authoritative-tamper').id,
      'activation:create:authoritative-tamper')
    const original = target.store.createPlan(input).result; target.store.close()
    const database = new DatabaseSync(target.path)
    const resultRow = database.prepare('SELECT result_json FROM operation_receipts WHERE idempotency_key = ?')
      .get(input.idempotencyKey) as { result_json: string }
    const changed = JSON.parse(resultRow.result_json) as Record<string, unknown>
    const targetBinding = changed['target'] as Record<string, unknown>; targetBinding['profilePath'] = join(target.root, 'profiles', 'attacker')
    const immutable = { schemaVersion: changed['schemaVersion'], kind: changed['kind'], id: changed['id'], gapId: changed['gapId'],
      gapSnapshot: changed['gapSnapshot'], profile: changed['profile'], candidate: changed['candidate'], dossier: changed['dossier'],
      installationId: changed['installationId'], ledger: changed['ledger'], target: changed['target'], executor: changed['executor'],
      createdAt: changed['createdAt'], expiresAt: changed['expiresAt'] }
    changed['digest'] = controlPlaneDigest(immutable); const resultJson = JSON.stringify(changed)
    const envelope = database.prepare(`SELECT operation, input_digest, created_at FROM operation_receipts WHERE idempotency_key = ?`)
      .get(input.idempotencyKey) as { operation: string; input_digest: string; created_at: number }
    database.prepare(`UPDATE operation_receipts SET result_json = ?, result_digest = ? WHERE idempotency_key = ?`).run(resultJson,
      controlPlaneOperationReceiptDigest(input.idempotencyKey, envelope.operation, envelope.input_digest, resultJson, envelope.created_at), input.idempotencyKey)
    database.prepare('UPDATE activation_plans SET target_path = ?, plan_digest = ? WHERE id = ?')
      .run(String(targetBinding['profilePath']), String(changed['digest']), original.id)
    database.close(); const reopened = new ControlPlaneStore({ path: target.path, now: target.now }); target.store = reopened
    expect(() => reopened.createPlan(input)).toThrow()
  })

  test('rejects coordinated source phase-apply replay tampering', async () => {
    const target = await fixture(); const plan = await startedSource(target, 'apply-replay-tamper')
    const applied = await applySuccessfulReleasePhase(target, plan)
    target.store.close(); tamperOperationReceipt(target.path, 'release:apply:pr:1', result => {
      const storedApproval = result['approval'] as Record<string, unknown>; storedApproval['principal'] = 'attacker@example.test'
    })
    const reopened = new ControlPlaneStore({ path: target.path, now: target.now }); target.store = reopened
    await expect(reopened.applySourceRelease({ planId: plan.id, expectedRevision: plan.revision,
      expectedFence: plan.release!.fence, receipt: applied.receipt, resolveAuthority: () => acceptingReleaseAuthority,
      idempotencyKey: 'release:apply:pr:1' })).rejects.toThrow()
  })

  test('quarantines schema-v9 operation receipts without a trustworthy envelope digest', async () => {
    const target = await fixture(); const reviewed = await reviewedSource(target, 'receipt-migration')
    const signed = releaseAuthorization(reviewed, target.now(), target.root)
    const started = await target.store.startSourceRelease({ planId: reviewed.id, expectedRevision: reviewed.revision,
      authorization: signed.authorization, resolveAuthority: () => signed.authority, idempotencyKey: 'release:start:migrated' })
    target.store.close(); const legacy = new DatabaseSync(target.path)
    legacy.exec('ALTER TABLE operation_receipts DROP COLUMN result_digest; PRAGMA user_version = 9;')
    legacy.close(); await chmod(target.path, 0o600)
    const database = new DatabaseSync(target.path)
    openControlPlaneDatabase(target.path).close()
    expect(database.prepare('SELECT result_digest FROM operation_receipts WHERE idempotency_key = ?')
      .get('release:start:migrated')).toBeUndefined()
    expect((database.prepare(`SELECT count(*) AS count FROM quarantined_legacy_plans
      WHERE source = ? AND reason = ?`).get('operation_receipts_v9:release:start:migrated',
      'operation-receipt-lacks-full-envelope-digest') as { count: number }).count).toBe(1)
    expect((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(controlPlaneSchemaVersion)
    database.close()
    expect(started.result.status).toBe('awaiting-pr')
  })

  test('rejects a schema-v9 database whose pre-existing receipt digest disagrees with its envelope', async () => {
    const target = await fixture(); gap(target.store, 'receipt-migration-corrupt'); target.store.close()
    const legacy = new DatabaseSync(target.path)
    legacy.prepare(`INSERT INTO operation_receipts (idempotency_key, operation, input_digest, result_json, result_digest, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run('legacy:corrupt', 'legacy-op', 'a'.repeat(64), '{}', 'b'.repeat(64), target.now())
    legacy.exec('PRAGMA user_version = 9'); legacy.close(); await chmod(target.path, 0o600)
    expect(() => openControlPlaneDatabase(target.path)).toThrow('operation receipt digest is corrupt')
  })

  test('rejects any operation receipt envelope tampering even when result JSON is unchanged', async () => {
    const target = await fixture(); const reviewed = await reviewedSource(target, 'receipt-envelope-tamper')
    const signed = releaseAuthorization(reviewed, target.now(), target.root)
    await target.store.startSourceRelease({ planId: reviewed.id, expectedRevision: reviewed.revision,
      authorization: signed.authorization, resolveAuthority: () => signed.authority, idempotencyKey: 'release:start:envelope-tamper' })
    target.store.close(); const database = new DatabaseSync(target.path)
    database.prepare('UPDATE operation_receipts SET created_at = created_at + 1 WHERE idempotency_key = ?')
      .run('release:start:envelope-tamper')
    database.close(); const reopened = new ControlPlaneStore({ path: target.path, now: target.now }); target.store = reopened
    await expect(reopened.startSourceRelease({ planId: reviewed.id, expectedRevision: reviewed.revision,
      authorization: signed.authorization, resolveAuthority: () => signed.authority,
      idempotencyKey: 'release:start:envelope-tamper' })).rejects.toThrow('corrupt')
  })

  test('heartbeats one worker, recovers past plan expiry only after lease expiry, and fences the old worker', async () => {
    const target = await fixture(); const approvedPlan = await approved(target, 'lease')
    const first = await target.store.claimActivation(activationClaim(approvedPlan))
    const other = new ControlPlaneStore({ path: target.path, now: target.now })
    await expect(other.claimActivation(activationClaim(first))).rejects.toThrow('cannot be claimed')
    target.setNow(target.now() + 4_000); target.store.heartbeatActivation({ planId: first.id, expectedRevision: first.revision, fence: first.activation!.fence, leaseMs: 5_000 })
    target.setNow(1_800_000_070_000) // The approval plan is expired, but a started activation remains recoverable.
    const recovered = await other.claimActivation(activationClaim(first))
    expect(recovered.activation).toMatchObject({ id: first.activation!.id, fence: first.activation!.fence + 1 })
    expect(() => target.store.heartbeatActivation({ planId: first.id, expectedRevision: first.revision, fence: first.activation!.fence, leaseMs: 5_000 })).toThrow('lost')
    other.close()
  })

  test('holds the cross-process SQLite filesystem mutex even after the visible lease deadline', async () => {
    const target = await fixture(); const approvedPlan = await approved(target, 'filesystem-mutex')
    const claimed = await target.store.claimActivation(activationClaim(approvedPlan))
    await target.store.withActivationFileSystemGuard({ planId: claimed.id, expectedRevision: claimed.revision,
      fence: claimed.activation!.fence, status: claimed.status, leaseMs: 5_000 }, async () => {
      target.setNow(target.now() + 10_000)
      const probe = `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]);
db.exec('PRAGMA busy_timeout=100'); try { db.exec('BEGIN IMMEDIATE'); process.stdout.write('acquired'); db.exec('ROLLBACK') }
catch { process.stdout.write('busy') } finally { db.close() }`
      expect(execFileSync(process.execPath, ['-e', probe, target.path], { encoding: 'utf8' })).toBe('busy')
    })
    expect(target.store.getPlan(claimed.id).activation?.fence).toBe(claimed.activation!.fence)
  })

  test('retains the live activation lease through rollback cleanup and clears it only at terminal state', async () => {
    const target = await fixture(); const approvedPlan = await approved(target, 'rollback-lease')
    const claimed = await target.store.claimActivation(activationClaim(approvedPlan))
    const rollback = target.store.advanceActivation({ planId: claimed.id, expectedRevision: claimed.revision,
      fence: claimed.activation!.fence, from: 'staging', to: 'rollback-pending', failureCode: 'staging-failed' })
    await expect(target.store.withActivationFileSystemGuard({ planId: rollback.id, expectedRevision: rollback.revision,
      fence: rollback.activation!.fence, status: 'rollback-pending', leaseMs: 5_000 }, async () => 'cleaned')).resolves.toBe('cleaned')
    const terminal = target.store.advanceActivation({ planId: rollback.id, expectedRevision: rollback.revision,
      fence: rollback.activation!.fence, from: 'rollback-pending', to: 'rolled-back' })
    expect(terminal).toMatchObject({ status: 'rolled-back', activation: { failureCode: 'staging-failed' } })
    const database = new DatabaseSync(target.path)
    expect((database.prepare('SELECT activation_lease_until AS lease FROM activation_plans WHERE id = ?')
      .get(terminal.id) as { lease: number | null }).lease).toBeNull()
    database.close()
  })

  test('migration marks an in-flight Host exposure for recovery without inventing mutable file pins', async () => {
    const target = await fixture(); const approvedPlan = await approved(target, 'rollback-migration')
    const claimed = await target.store.claimActivation(activationClaim(approvedPlan))
    const awaiting = target.store.advanceActivation({ planId: claimed.id, expectedRevision: claimed.revision,
      fence: claimed.activation!.fence, from: 'staging', to: 'awaiting-reload' })
    const prepared = target.store.prepareHostAttestationOperation({ planId: awaiting.id, expectedRevision: awaiting.revision,
      expectedFence: awaiting.activation!.fence, issuer: { mode: 'owner-manual' }, requirements: { kind: 'reload', previousHostGeneration: 0 }, receiptTtlMs: 10_000 })
    target.store.close()
    const raw = new DatabaseSync(target.path)
    raw.exec(`PRAGMA foreign_keys = OFF; ALTER TABLE activation_plans DROP COLUMN activation_target_baseline_json;
      ALTER TABLE activation_plans DROP COLUMN host_recovery_required; ALTER TABLE activation_plans DROP COLUMN rollback_profile_restored;
      ALTER TABLE host_attestations RENAME TO host_attestations_new;
      CREATE TABLE host_attestations (plan_id TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('reload', 'readiness', 'effect-blocked-replay', 'shadow', 'canary', 'soak', 'health')),
      receipt_id TEXT NOT NULL UNIQUE, receipt_digest TEXT NOT NULL, receipt_json TEXT NOT NULL, host_generation INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(plan_id, phase)) STRICT, WITHOUT ROWID;
      INSERT INTO host_attestations SELECT * FROM host_attestations_new; DROP TABLE host_attestations_new; ALTER TABLE host_attestation_operations RENAME TO host_attestation_operations_new;
      CREATE TABLE host_attestation_operations (plan_id TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('reload', 'readiness', 'effect-blocked-replay', 'shadow', 'canary', 'soak', 'health')),
      operation_id TEXT NOT NULL UNIQUE, binding_digest TEXT NOT NULL, request_digest TEXT NOT NULL, request_json TEXT NOT NULL, status TEXT NOT NULL,
      receipt_digest TEXT, receipt_json TEXT, created_at INTEGER NOT NULL, completed_at INTEGER, applied_at INTEGER, PRIMARY KEY(plan_id, phase)) STRICT, WITHOUT ROWID;
      INSERT INTO host_attestation_operations SELECT * FROM host_attestation_operations_new; DROP TABLE host_attestation_operations_new; PRAGMA user_version = 14; PRAGMA foreign_keys = ON`)
    raw.close()
    const reopened = new ControlPlaneStore({ path: target.path, now: target.now }); target.store = reopened
    expect(reopened.getPlan(awaiting.id).activation).toMatchObject({ hostRecoveryRequired: true })
    expect(reopened.getPlan(awaiting.id).activation?.targetBaselineFiles).toBeUndefined()
    const migrated = new DatabaseSync(target.path)
    expect((migrated.prepare("SELECT sql FROM sqlite_master WHERE name = 'host_attestations'").get() as { sql: string }).sql).toContain("'rollback'")
    expect(migrated.prepare('SELECT operation_id, status FROM host_attestation_operations WHERE operation_id = ?').get(prepared.operationId))
      .toEqual({ operation_id: prepared.operationId, status: 'pending' })
    migrated.close()
  })

  test('requires a marked, signed physical rollback and reopens the gap exactly once', async () => {
    const target = await fixture(); const host = hostTrustKey(target.now); const approvedPlan = await approved(target, 'physical-rollback')
    let plan = await target.store.claimActivation(activationClaim(approvedPlan))
    const baselineFiles = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'].map(name => ({ path: join(plan.target.profilePath, name), sha256: null }))
    plan = target.store.recordActivationTargetBaseline({ planId: plan.id, expectedRevision: plan.revision, fence: plan.activation!.fence, existed: true, baselineFiles })
    plan = target.store.advanceActivation({ planId: plan.id, expectedRevision: plan.revision, fence: plan.activation!.fence, from: 'staging', to: 'awaiting-reload' })
    const reload = target.store.prepareHostAttestationOperation({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.activation!.fence,
      issuer: { mode: 'owner-manual' }, requirements: { kind: 'reload', previousHostGeneration: 0 }, receiptTtlMs: 10_000 })
    const failedEvidence = { kind: 'reload' as const, reloaded: false, previousHostGeneration: 0, currentHostGeneration: 1, probeDigest: 'a'.repeat(64) }
    const failedUnsigned: Omit<HostAttestationReceipt, 'signature'> = { schemaVersion: 2, receiptId: 'rollback-failed-reload', authority: 'host-runtime', keyId: 'host-key-1', installationId,
      planId: plan.id, planDigest: plan.digest, activationId: plan.activation!.id, fence: plan.activation!.fence, operationId: reload.operationId, requestDigest: reload.requestDigest,
      phase: 'reload', outcome: 'failed', hostGeneration: 1, evidence: failedEvidence, evidenceDigest: hostAttestationEvidenceDigest(failedEvidence), observedAt: target.now(), expiresAt: target.now() + 10_000 }
    const failedReload: HostAttestationReceipt = { ...failedUnsigned, signature: sign(null, Buffer.from(hostAttestationSigningPayload(failedUnsigned)), host.privateKey).toString('base64') }
    await target.store.runHostAttestationOperation({ operationId: reload.operationId, expectedRevision: plan.revision, expectedFence: plan.activation!.fence, execute: async () => failedReload, resolveAuthority: () => host.authority })
    plan = (await target.store.applyHostAttestation({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.activation!.fence, receipt: failedReload, resolveAuthority: () => host.authority, idempotencyKey: 'rollback:failed-reload' })).result
    expect(plan).toMatchObject({ status: 'rollback-pending', activation: { hostRecoveryRequired: true, failureCode: 'host-attestation-failed' } })
    expect(() => target.store.advanceActivation({ planId: plan.id, expectedRevision: plan.revision, fence: plan.activation!.fence, from: 'rollback-pending', to: 'rolled-back' })).toThrow()
    expect(() => target.store.prepareHostAttestationOperation({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.activation!.fence, issuer: { mode: 'owner-manual' },
      requirements: { kind: 'rollback', previousHostGeneration: 1, action: 'restore', baselineFiles, minimumChecks: 1 }, receiptTtlMs: 10_000 })).toThrow('durably restored')
    plan = await target.store.claimActivation(activationClaim(plan))
    expect(() => target.store.markRollbackProfileRestored({ planId: plan.id, expectedRevision: plan.revision, fence: plan.activation!.fence + 1 })).toThrow()
    plan = target.store.markRollbackProfileRestored({ planId: plan.id, expectedRevision: plan.revision, fence: plan.activation!.fence })
    await expect(target.store.claimActivation(activationClaim(plan))).rejects.toThrow('physical Host rollback')
    expect(() => target.store.prepareHostAttestationOperation({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.activation!.fence, issuer: { mode: 'owner-manual' },
      requirements: { kind: 'rollback', previousHostGeneration: 1, action: 'stop', baselineFiles, minimumChecks: 1 }, receiptTtlMs: 10_000 })).toThrow('baseline')
    expect(() => target.store.prepareHostAttestationOperation({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.activation!.fence, issuer: { mode: 'owner-manual' },
      requirements: { kind: 'rollback', previousHostGeneration: 1, action: 'restore', baselineFiles: [...baselineFiles.slice(0, 2), { ...baselineFiles[2]!, sha256: 'c'.repeat(64) }], minimumChecks: 1 }, receiptTtlMs: 10_000 })).toThrow('baseline')
    const recovery = target.store.prepareHostAttestationOperation({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.activation!.fence, issuer: { mode: 'owner-manual' },
      requirements: { kind: 'rollback', previousHostGeneration: 1, action: 'restore', baselineFiles, minimumChecks: 1 }, receiptTtlMs: 10_000 })
    const evidence = { kind: 'rollback' as const, action: 'restore' as const, previousHostGeneration: 1, currentHostGeneration: 2, checks: 1, failures: 0, profileRestored: true, probeDigest: 'b'.repeat(64) }
    const unsigned: Omit<HostAttestationReceipt, 'signature'> = { schemaVersion: 2, receiptId: 'rollback-restored', authority: 'host-runtime', keyId: 'host-key-1', installationId,
      planId: plan.id, planDigest: plan.digest, activationId: plan.activation!.id, fence: plan.activation!.fence, operationId: recovery.operationId, requestDigest: recovery.requestDigest,
      phase: 'rollback', outcome: 'passed', hostGeneration: 2, evidence, evidenceDigest: hostAttestationEvidenceDigest(evidence), observedAt: target.now(), expiresAt: target.now() + 10_000 }
    const receipt: HostAttestationReceipt = { ...unsigned, signature: sign(null, Buffer.from(hostAttestationSigningPayload(unsigned)), host.privateKey).toString('base64') }
    const failedRecoveryUnsigned = { ...unsigned, receiptId: 'rollback-recovery-failed', outcome: 'failed' as const }
    const failedRecovery: HostAttestationReceipt = { ...failedRecoveryUnsigned, signature: sign(null, Buffer.from(hostAttestationSigningPayload(failedRecoveryUnsigned)), host.privateKey).toString('base64') }
    await expect(target.store.runHostAttestationOperation({ operationId: recovery.operationId, expectedRevision: plan.revision, expectedFence: plan.activation!.fence,
      execute: async () => failedRecovery, resolveAuthority: () => host.authority })).rejects.toThrow('cannot consume')
    expect(target.store.getHostAttestationOperation(recovery.operationId).status).toBe('pending')
    await target.store.runHostAttestationOperation({ operationId: recovery.operationId, expectedRevision: plan.revision, expectedFence: plan.activation!.fence, execute: async () => receipt, resolveAuthority: () => host.authority })
    const applied = await target.store.applyHostAttestation({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.activation!.fence, receipt, resolveAuthority: () => host.authority, idempotencyKey: 'rollback:restore' })
    expect(applied.result).toMatchObject({ status: 'rolled-back', activation: { failureCode: 'host-attestation-failed' } })
    expect(target.store.getGap(plan.gapId).status).toBe('open')
    target.store.close(); const reopened = new ControlPlaneStore({ path: target.path, now: target.now }); target.store = reopened
    await expect(reopened.applyHostAttestation({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.activation!.fence, receipt,
      resolveAuthority: () => { throw new Error('replay must not verify') }, idempotencyKey: 'rollback:restore' })).resolves.toEqual(applied)
  })

  test('accepts only a signed stop recovery for an originally absent profile', async () => {
    const target = await fixture(); const host = hostTrustKey(target.now); const approvedPlan = await approved(target, 'physical-stop')
    const claimed = await target.store.claimActivation(activationClaim(approvedPlan)); target.store.close()
    const raw = new DatabaseSync(target.path)
    raw.prepare(`UPDATE activation_plans SET status = 'rollback-pending', activation_target_existed = 0, activation_target_baseline_json = '[]', host_recovery_required = 1,
      activation_lease_until = ?, failure_code = 'host-attestation-failed' WHERE id = ?`).run(target.now() + 5_000, claimed.id); raw.close()
    const store = new ControlPlaneStore({ path: target.path, now: target.now }); target.store = store
    let plan = store.getPlan(claimed.id)
    target.setNow(target.now() + 5_001)
    expect(() => store.markRollbackProfileRestored({ planId: plan.id, expectedRevision: plan.revision, fence: plan.activation!.fence })).toThrow('lost')
    plan = await store.claimActivation(activationClaim(plan))
    plan = store.markRollbackProfileRestored({ planId: plan.id, expectedRevision: plan.revision, fence: plan.activation!.fence })
    const operation = store.prepareHostAttestationOperation({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.activation!.fence, issuer: { mode: 'owner-manual' },
      requirements: { kind: 'rollback', previousHostGeneration: 0, action: 'stop', baselineFiles: [], minimumChecks: 1 }, receiptTtlMs: 10_000 })
    const evidence = { kind: 'rollback' as const, action: 'stop' as const, previousHostGeneration: 0, currentHostGeneration: 1, checks: 1, failures: 0, profileRestored: true, probeDigest: 'd'.repeat(64) }
    const unsigned: Omit<HostAttestationReceipt, 'signature'> = { schemaVersion: 2, receiptId: 'rollback-stop', authority: 'host-runtime', keyId: 'host-key-1', installationId,
      planId: plan.id, planDigest: plan.digest, activationId: plan.activation!.id, fence: plan.activation!.fence, operationId: operation.operationId, requestDigest: operation.requestDigest,
      phase: 'rollback', outcome: 'passed', hostGeneration: 1, evidence, evidenceDigest: hostAttestationEvidenceDigest(evidence), observedAt: target.now(), expiresAt: target.now() + 10_000 }
    const receipt: HostAttestationReceipt = { ...unsigned, signature: sign(null, Buffer.from(hostAttestationSigningPayload(unsigned)), host.privateKey).toString('base64') }
    await store.runHostAttestationOperation({ operationId: operation.operationId, expectedRevision: plan.revision, expectedFence: plan.activation!.fence, execute: async () => receipt, resolveAuthority: () => host.authority })
    expect((await store.applyHostAttestation({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.activation!.fence, receipt,
      resolveAuthority: () => host.authority, idempotencyKey: 'rollback:stop' })).result.status).toBe('rolled-back')
  })

  test('rejects coordinated activation approval-row tampering before allocating an activation fence', async () => {
    const target = await fixture(); const approvedPlan = await approved(target, 'approval-row-tamper')
    target.store.close(); const database = new DatabaseSync(target.path)
    const row = database.prepare('SELECT approval_json FROM activation_plans WHERE id = ?').get(approvedPlan.id) as { approval_json: string }
    const approval = JSON.parse(row.approval_json) as Record<string, unknown>; approval['principal'] = 'attacker@example.test'
    database.prepare('UPDATE activation_plans SET approval_json = ? WHERE id = ?').run(JSON.stringify(approval), approvedPlan.id)
    database.close(); const reopened = new ControlPlaneStore({ path: target.path, now: target.now }); target.store = reopened
    await expect(reopened.claimActivation(activationClaim(approvedPlan))).rejects.toThrow()
    const raw = new DatabaseSync(target.path)
    expect(raw.prepare('SELECT activation_id, activation_fence FROM activation_plans WHERE id = ?').get(approvedPlan.id))
      .toEqual({ activation_id: null, activation_fence: 0 })
    raw.close()
  })

  test('rejects a tampered raw activation approval signature before allocating an activation fence', async () => {
    const target = await fixture(); const plan = target.store.createPlan(activationInput(target.root,
      gap(target.store, 'approval-signature-tamper').id, 'activation:approval-signature-tamper')).result
    const signed = approval(plan, target.now() + 1)
    const approvedPlan = (await target.store.approve({ planId: plan.id, expectedRevision: plan.revision, receipt: signed.receipt,
      resolveAuthority: () => signed.authority, idempotencyKey: 'activation:approval-signature' })).result
    target.store.close(); const database = new DatabaseSync(target.path)
    const row = database.prepare('SELECT approval_receipt_json FROM activation_plans WHERE id = ?')
      .get(approvedPlan.id) as { approval_receipt_json: string }
    const receipt = JSON.parse(row.approval_receipt_json) as ApprovalReceipt
    database.prepare('UPDATE activation_plans SET approval_receipt_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...receipt, signature: `${receipt.signature.slice(0, -4)}AAAA` }), approvedPlan.id)
    database.close(); const reopened = new ControlPlaneStore({ path: target.path, now: target.now }); target.store = reopened
    await expect(reopened.claimActivation({ ...activationClaim(approvedPlan), resolveApprovalAuthority: () => signed.authority })).rejects.toThrow()
    const raw = new DatabaseSync(target.path)
    expect(raw.prepare('SELECT activation_id, activation_fence FROM activation_plans WHERE id = ?').get(approvedPlan.id))
      .toEqual({ activation_id: null, activation_fence: 0 })
    raw.close()
  })

  test('accepts only exact signed typed Host phases and never treats configuration validation as activation', async () => {
    const target = await fixture(); const approvedPlan = await approved(target, 'attestation')
    let plan = await target.store.claimActivation(activationClaim(approvedPlan))
    plan = target.store.advanceActivation({ planId: plan.id, expectedRevision: plan.revision, fence: plan.activation!.fence, from: 'staging', to: 'awaiting-reload' })
    const operation = target.store.prepareHostAttestationOperation({ planId: plan.id, expectedRevision: plan.revision,
      expectedFence: plan.activation!.fence, issuer: { mode: 'owner-manual' }, requirements: { kind: 'reload', previousHostGeneration: 0 }, receiptTtlMs: 10_000 })
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const evidence = { kind: 'reload' as const, reloaded: true, previousHostGeneration: 0, currentHostGeneration: 7, probeDigest: 'c'.repeat(64) }
    const unsigned: Omit<HostAttestationReceipt, 'signature'> = { schemaVersion: 2, receiptId: 'host-reload-1', authority: 'host-runtime', keyId: 'host-key-1',
      installationId, planId: plan.id, planDigest: plan.digest, activationId: plan.activation!.id, fence: plan.activation!.fence,
      operationId: operation.operationId, requestDigest: operation.requestDigest, phase: 'reload', outcome: 'passed', hostGeneration: 7,
      evidence, evidenceDigest: hostAttestationEvidenceDigest(evidence), observedAt: target.now(), expiresAt: target.now() + 10_000 }
    const receipt: HostAttestationReceipt = { ...unsigned, signature: sign(null, Buffer.from(hostAttestationSigningPayload(unsigned)), privateKey).toString('base64') }
    const authority = new Ed25519HostAttestationAuthority(publicKey.export({ type: 'spki', format: 'pem' }), 'host-runtime', 'host-key-1', target.now)
    await target.store.runHostAttestationOperation({ operationId: operation.operationId, expectedRevision: plan.revision,
      expectedFence: plan.activation!.fence, execute: async () => receipt, resolveAuthority: () => authority })
    const result = await target.store.applyHostAttestation({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.activation!.fence,
      receipt, resolveAuthority: () => authority, idempotencyKey: 'host:reload' })
    expect(result.result.status).toBe('awaiting-readiness')
    expect(target.store.health().activeActivations).toBe(1)
    target.setNow(target.now() + 20_000)
    expect(await target.store.applyHostAttestation({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.activation!.fence,
      receipt, resolveAuthority: () => { throw new Error('must not resolve expired exact replay') }, idempotencyKey: 'host:reload' })).toEqual(result)
    await expect(target.store.applyHostAttestation({ planId: plan.id, expectedRevision: result.result.revision,
      expectedFence: plan.activation!.fence, receipt: { ...receipt, receiptId: 'wrong-phase', phase: 'health' },
      resolveAuthority: () => authority, idempotencyKey: 'host:wrong' })).rejects.toThrow()
  })

  test('quarantines schema-v3 plans that lack installation/target/executor/attestation bindings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'control-plane-v3-')); roots.push(root); const path = join(root, 'legacy.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE capability_gaps (id TEXT PRIMARY KEY);
      CREATE TABLE activation_plans (id TEXT PRIMARY KEY, arbitrary TEXT);
      INSERT INTO activation_plans VALUES ('old-plan', 'unbound');
      CREATE TABLE operation_receipts (idempotency_key TEXT PRIMARY KEY, operation TEXT, input_digest TEXT, result_json TEXT, created_at INTEGER);
      CREATE TABLE quarantined_legacy_plans (source TEXT PRIMARY KEY, reason TEXT NOT NULL, payload_json TEXT NOT NULL, quarantined_at INTEGER NOT NULL);
      PRAGMA user_version = 3;
    `)
    legacy.close(); await chmod(path, 0o600)
    const migrated = openControlPlaneDatabase(path)
    expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(controlPlaneSchemaVersion)
    expect((migrated.prepare('SELECT count(*) AS count FROM quarantined_legacy_plans').get() as { count: number }).count).toBe(1)
    expect((migrated.prepare('SELECT count(*) AS count FROM activation_plans').get() as { count: number }).count).toBe(0)
    migrated.close()
  })

  test('migrates schema-v6 ledgers by adding durable operation tables without changing existing rows', async () => {
    const target = await fixture(); const before = target.store.recordGap({ idempotencyKey: 'gap:migrate-v6', capability: 'health',
      context: 'migration evidence', expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 0 }); target.store.close()
    const legacy = new DatabaseSync(target.path)
    legacy.exec('DROP TABLE host_attestation_operations; DROP TABLE source_release_operations; PRAGMA user_version = 6;'); legacy.close(); await chmod(target.path, 0o600)
    const migrated = openControlPlaneDatabase(target.path)
    expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(controlPlaneSchemaVersion)
    expect((migrated.prepare('SELECT capability FROM capability_gaps WHERE id = ?').get(before.id) as { capability: string }).capability).toBe('health')
    expect((migrated.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'host_attestation_operations'").get() as { count: number }).count).toBe(1)
    expect((migrated.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'source_release_operations'").get() as { count: number }).count).toBe(1)
    migrated.close()
  })

  test('migrates schema-v8 source rows without inventing checks, authorization, release operations, or attempts', async () => {
    const target = await fixture(); const source = target.store.createSourcePlan({ gapId: gap(target.store, 'migrate-v8').id,
      repository: '/canonical/repository', worktree: '/canonical/worktree', baseCommit: 'a'.repeat(40), name: 'health-helper',
      generatorDigest: 'b'.repeat(64), scope: ['plugins/README.md', 'plugins/health-helper'], ttlMs: 60_000, idempotencyKey: 'source:migrate-v8' }).result
    target.store.close(); const legacy = new DatabaseSync(target.path)
    legacy.exec(`
      DROP TABLE source_publish_reconciliations;
      ALTER TABLE source_release_operations RENAME TO source_release_operations_v9;
      CREATE TABLE source_release_operations (
        plan_id TEXT NOT NULL, phase TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, binding_digest TEXT NOT NULL,
        request_digest TEXT NOT NULL, request_json TEXT NOT NULL, status TEXT NOT NULL, receipt_digest TEXT, receipt_json TEXT,
        created_at INTEGER NOT NULL, completed_at INTEGER, applied_at INTEGER, PRIMARY KEY(plan_id, phase)
      ) STRICT, WITHOUT ROWID;
      DROP TABLE source_release_operations_v9;
      PRAGMA user_version = 8;
    `)
    legacy.close(); await chmod(target.path, 0o600)
    const migrated = openControlPlaneDatabase(target.path)
    const row = migrated.prepare('SELECT * FROM source_plans WHERE id = ?').get(source.id) as Record<string, unknown>
    expect(row).toMatchObject({ id: source.id, plan_digest: source.digest, status: 'pending-approval', revision: 1,
      checked_tree_digest: null, checked_patch_digest: null, checked_at: null, release_authorization_json: null,
      release_id: null, release_fence: 0, release_failure_phase: null, release_failure_code: null })
    expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(controlPlaneSchemaVersion)
    const columns = migrated.prepare('PRAGMA table_info(source_release_operations)').all() as Array<{ name: string }>
    expect(columns.map(column => column.name)).toEqual(expect.arrayContaining(['release_id', 'release_fence', 'attempt']))
    migrated.close()
  })

  test('quarantines active schema-v8 releases as unverifiable without releasing their gap claims', async () => {
    const target = await fixture(); const source = target.store.createSourcePlan({ gapId: gap(target.store, 'migrate-v8-active').id,
      repository: '/canonical/repository', worktree: '/canonical/worktree', baseCommit: 'a'.repeat(40), name: 'health-helper',
      generatorDigest: 'b'.repeat(64), scope: ['plugins/README.md', 'plugins/health-helper'], ttlMs: 60_000, idempotencyKey: 'source:migrate-v8-active' }).result
    target.store.close(); const legacy = new DatabaseSync(target.path)
    legacy.prepare(`UPDATE source_plans SET status = 'awaiting-publish', revision = 7, release_id = ?, release_fence = 1 WHERE id = ?`)
      .run('release-legacy', source.id)
    legacy.exec(`
      DROP TABLE source_publish_reconciliations;
      ALTER TABLE source_release_operations RENAME TO source_release_operations_v9;
      CREATE TABLE source_release_operations (plan_id TEXT NOT NULL, phase TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,
        binding_digest TEXT NOT NULL, request_digest TEXT NOT NULL, request_json TEXT NOT NULL, status TEXT NOT NULL,
        receipt_digest TEXT, receipt_json TEXT, created_at INTEGER NOT NULL, completed_at INTEGER, applied_at INTEGER,
        PRIMARY KEY(plan_id, phase)) STRICT, WITHOUT ROWID;
      DROP TABLE source_release_operations_v9;
      PRAGMA user_version = 8;
    `)
    legacy.close(); await chmod(target.path, 0o600)
    const migrated = openControlPlaneDatabase(target.path)
    expect(migrated.prepare('SELECT status, release_failure_phase, release_failure_code, revision FROM source_plans WHERE id = ?')
      .get(source.id)).toEqual({ status: 'release-failed', release_failure_phase: 'publish',
        release_failure_code: 'legacy-unverifiable-release', revision: 8 })
    expect((migrated.prepare('SELECT count(*) AS count FROM gap_plan_claims WHERE plan_id = ?').get(source.id) as { count: number }).count).toBe(1)
    migrated.close()
  })

  test('health exposes only fixed aggregate counters', async () => {
    const target = await fixture(); gap(target.store, 'health-counter')
    expect(target.store.health()).toEqual({ gaps: 1, readyPlans: 0, activeActivations: 0, failed: 0, rollbackPending: 0,
      watchingActivations: 0, closedRegressed: 0, closedRetracted: 0 })
    expect(Object.keys(target.store.health()).sort()).toEqual(['activeActivations', 'closedRegressed', 'closedRetracted',
      'failed', 'gaps', 'readyPlans', 'rollbackPending', 'watchingActivations'].sort())
  })

  describe('post-activation deployment cohort watch', () => {
    test('promotion opens an exact-pinned watch without mutating the activation state machine', async () => {
      const target = await fixture(); const { plan } = await promoted(target, 'watch-open')
      const watch = target.store.getActivationWatch(plan.id)
      expect(watch).toMatchObject({ planId: plan.id, state: 'watching', revision: 1,
        lastHostGeneration: 0, healthyObservations: 0, activationId: plan.activation!.id, fence: plan.activation!.fence,
        exact: { package: candidate.package, version: candidate.version, integrity: candidate.integrity } })
      expect(watch.close).toBeUndefined()
      expect(target.store.listActivationWatches()).toHaveLength(1)
      expect(target.store.listActivationWatchEvidence(plan.id)).toEqual([])
      expect(target.store.getPlan(plan.id).status).toBe('activated')
      expect(target.store.health()).toMatchObject({ watchingActivations: 1, closedRegressed: 0, closedRetracted: 0 })
    })

    test('a signed regressed Host observation closes the exact pinned version and blocks later evidence', async () => {
      const target = await fixture(); const { plan, host } = await promoted(target, 'watch-regress')
      target.setNow(target.now() + 1_000)
      const regressed = watchObservation(host, plan, { observationId: 'obs-regress-1', disposition: 'regressed',
        hostGeneration: 8, observedAt: target.now() })
      const receipt = await target.store.recordPostActivationObservation({ idempotencyKey: 'watch:regress:1',
        receipt: regressed, resolveAuthority: () => host.observationAuthority })
      expect(receipt.result.state).toBe('closed-regressed')
      expect(receipt.result.revision).toBe(2)
      expect(receipt.result.close).toMatchObject({ disposition: 'regressed', evidenceId: 'obs-regress-1' })
      expect(receipt.result.close?.signatureDigest).toMatch(/^[a-f0-9]{64}$/u)
      const watch = target.store.getActivationWatch(plan.id)
      expect(watch.state).toBe('closed-regressed')
      expect(watch.lastHostGeneration).toBe(8)
      const evidence = target.store.listActivationWatchEvidence(plan.id)
      expect(evidence).toHaveLength(1)
      expect(evidence[0]).toMatchObject({ observationId: 'obs-regress-1', disposition: 'regressed',
        hostGeneration: 8, failures: 1, checks: 4 })
      // Closure is a control-plane terminal state, not a physical uninstall: the
      // activation plan itself stays in its no-exit `activated` state.
      expect(target.store.getPlan(plan.id).status).toBe('activated')
      expect(target.store.health()).toMatchObject({ watchingActivations: 0, closedRegressed: 1, closedRetracted: 0 })
      target.setNow(target.now() + 1_000)
      const healthy = watchObservation(host, plan, { observationId: 'obs-after-close',
        hostGeneration: 9, observedAt: target.now() })
      await expect(target.store.recordPostActivationObservation({ idempotencyKey: 'watch:after-close',
        receipt: healthy, resolveAuthority: () => host.observationAuthority })).rejects.toThrow(/already closed/u)
    })

    test('an owner retraction closes the watching deployment, reopens the gap, and deletes its plan claim', async () => {
      const target = await fixture(); const { plan } = await promoted(target, 'watch-retract')
      const gapBefore = target.store.getGap(plan.gapId); expect(gapBefore.status).toBe('closed')
      const owner = ownerRetractionTrustKey(target.now)
      target.setNow(target.now() + 1_000)
      const receipt = await target.store.retractActivation({ idempotencyKey: 'watch:retract:1',
        receipt: watchRetraction(owner, plan, { retractionId: 'retract-1', decidedAt: target.now() }),
        resolveAuthority: () => owner.authority })
      expect(receipt.result.state).toBe('closed-retracted')
      expect(receipt.result.close).toMatchObject({ disposition: 'retracted', evidenceId: 'retract-1' })
      const reopenedGap = target.store.getGap(plan.gapId)
      expect(reopenedGap.status).toBe('open')
      expect('candidateId' in reopenedGap).toBe(false)
      expect(reopenedGap.revision).toBe(gapBefore.revision + 1)
      const claims = (new DatabaseSync(target.path).prepare('SELECT count(*) AS count FROM gap_plan_claims WHERE gap_id = ? AND plan_id = ?')
        .get(plan.gapId, plan.id) as { count: number }).count
      expect(claims).toBe(0)
      const evidence = target.store.listActivationWatchEvidence(plan.id)
      expect(evidence).toHaveLength(1)
      expect(evidence[0]).toMatchObject({ observationId: 'retract-1', disposition: 'retracted', hostGeneration: 0 })
      expect(target.store.health()).toMatchObject({ watchingActivations: 0, closedRegressed: 0, closedRetracted: 1 })
      await expect(target.store.retractActivation({ idempotencyKey: 'watch:retract:2',
        receipt: watchRetraction(owner, plan, { retractionId: 'retract-2', decidedAt: target.now() }),
        resolveAuthority: () => owner.authority })).rejects.toThrow(/already retracted/u)
    })

    test('an owner retraction is still accepted after a regression closure', async () => {
      const target = await fixture(); const { plan, host } = await promoted(target, 'watch-regress-then-retract')
      target.setNow(target.now() + 1_000)
      await target.store.recordPostActivationObservation({ idempotencyKey: 'watch:regress:1',
        receipt: watchObservation(host, plan, { observationId: 'obs-regress-1', disposition: 'regressed',
          hostGeneration: 8, observedAt: target.now() }), resolveAuthority: () => host.observationAuthority })
      const owner = ownerRetractionTrustKey(target.now)
      const receipt = await target.store.retractActivation({ idempotencyKey: 'watch:retract:1',
        receipt: watchRetraction(owner, plan, { retractionId: 'retract-1', decidedAt: target.now() }),
        resolveAuthority: () => owner.authority })
      expect(receipt.result.state).toBe('closed-retracted')
      expect(receipt.result.close).toMatchObject({ disposition: 'retracted' })
      expect(target.store.getGap(plan.gapId).status).toBe('open')
    })

    test('positive healthy evidence accumulates but never closes the watch', async () => {
      const target = await fixture(); const { plan, host } = await promoted(target, 'watch-healthy')
      target.setNow(target.now() + 1_000)
      const first = await target.store.recordPostActivationObservation({ idempotencyKey: 'watch:healthy:1',
        receipt: watchObservation(host, plan, { observationId: 'obs-healthy-1', hostGeneration: 8, observedAt: target.now() }),
        resolveAuthority: () => host.observationAuthority })
      expect(first.result).toMatchObject({ state: 'watching', revision: 2, healthyObservations: 1, lastHostGeneration: 8 })
      target.setNow(target.now() + 1_000)
      const second = await target.store.recordPostActivationObservation({ idempotencyKey: 'watch:healthy:2',
        receipt: watchObservation(host, plan, { observationId: 'obs-healthy-2', hostGeneration: 9, observedAt: target.now() }),
        resolveAuthority: () => host.observationAuthority })
      expect(second.result).toMatchObject({ state: 'watching', revision: 3, healthyObservations: 2, lastHostGeneration: 9 })
      expect(second.result.close).toBeUndefined()
      const evidence = target.store.listActivationWatchEvidence(plan.id)
      expect(evidence.map(item => item.disposition)).toEqual(['healthy', 'healthy'])
      expect(target.store.health()).toMatchObject({ watchingActivations: 1, closedRegressed: 0, closedRetracted: 0 })
    })

    test('the watch survives store restart and later regression closure is durable', async () => {
      const target = await fixture(); const { plan, host } = await promoted(target, 'watch-restart')
      target.setNow(target.now() + 1_000)
      await target.store.recordPostActivationObservation({ idempotencyKey: 'watch:healthy:1',
        receipt: watchObservation(host, plan, { observationId: 'obs-healthy-1', hostGeneration: 8, observedAt: target.now() }),
        resolveAuthority: () => host.observationAuthority })
      target.store.close()
      const reopened = new ControlPlaneStore({ path: target.path, now: target.now }); target.store = reopened
      expect(reopened.getActivationWatch(plan.id)).toMatchObject({ state: 'watching', revision: 2,
        healthyObservations: 1, lastHostGeneration: 8 })
      target.setNow(target.now() + 1_000)
      await reopened.recordPostActivationObservation({ idempotencyKey: 'watch:regress:1',
        receipt: watchObservation(host, plan, { observationId: 'obs-regress-1', disposition: 'regressed',
          hostGeneration: 9, observedAt: target.now() }), resolveAuthority: () => host.observationAuthority })
      reopened.close()
      const afterRestart = new ControlPlaneStore({ path: target.path, now: target.now }); target.store = afterRestart
      expect(afterRestart.getActivationWatch(plan.id).state).toBe('closed-regressed')
      expect(afterRestart.listActivationWatchEvidence(plan.id)).toHaveLength(2)
    })

    test('rejects observations outside the exact binding, stale generations, foreign signatures, and stale revisions', async () => {
      const target = await fixture(); const { plan, host } = await promoted(target, 'watch-reject')
      target.setNow(target.now() + 1_000)
      const wrongVersion = watchObservation(host, plan, { observationId: 'obs-wrong-version',
        hostGeneration: 8, observedAt: target.now(), overrides: { version: '0.1.4' } })
      await expect(target.store.recordPostActivationObservation({ idempotencyKey: 'watch:wrong-version',
        receipt: wrongVersion, resolveAuthority: () => host.observationAuthority })).rejects.toThrow(/exact installation/u)
      const foreign = hostTrustKey(target.now)
      const forged = watchObservation(foreign, plan, { observationId: 'obs-forged',
        hostGeneration: 8, observedAt: target.now() })
      await expect(target.store.recordPostActivationObservation({ idempotencyKey: 'watch:forged',
        receipt: forged, resolveAuthority: () => host.observationAuthority })).rejects.toThrow(/signature is invalid/u)
      await target.store.recordPostActivationObservation({ idempotencyKey: 'watch:healthy:1',
        receipt: watchObservation(host, plan, { observationId: 'obs-healthy-1', hostGeneration: 8, observedAt: target.now() }),
        resolveAuthority: () => host.observationAuthority })
      target.setNow(target.now() + 1_000)
      const staleGeneration = watchObservation(host, plan, { observationId: 'obs-stale-generation',
        hostGeneration: 8, observedAt: target.now() })
      await expect(target.store.recordPostActivationObservation({ idempotencyKey: 'watch:stale-generation',
        receipt: staleGeneration, resolveAuthority: () => host.observationAuthority })).rejects.toThrow(/host generation must advance/u)
      const fresh = watchObservation(host, plan, { observationId: 'obs-stale-revision',
        hostGeneration: 9, observedAt: target.now() })
      await expect(target.store.recordPostActivationObservation({ idempotencyKey: 'watch:stale-revision',
        expectedRevision: 1, receipt: fresh, resolveAuthority: () => host.observationAuthority })).rejects.toThrow(/stale watch revision/u)
      expect(target.store.listActivationWatchEvidence(plan.id)).toHaveLength(1)
    })

    test('idempotent replay returns the original snapshot and never double-applies evidence', async () => {
      const target = await fixture(); const { plan, host } = await promoted(target, 'watch-replay')
      target.setNow(target.now() + 1_000)
      const receipt = watchObservation(host, plan, { observationId: 'obs-healthy-1', hostGeneration: 8, observedAt: target.now() })
      const first = await target.store.recordPostActivationObservation({ idempotencyKey: 'watch:healthy:1',
        receipt, resolveAuthority: () => host.observationAuthority })
      const replay = await target.store.recordPostActivationObservation({ idempotencyKey: 'watch:healthy:1',
        receipt, resolveAuthority: () => host.observationAuthority })
      expect(replay).toEqual(first)
      target.setNow(target.now() + 1_000)
      await target.store.recordPostActivationObservation({ idempotencyKey: 'watch:healthy:2',
        receipt: watchObservation(host, plan, { observationId: 'obs-healthy-2', hostGeneration: 9, observedAt: target.now() }),
        resolveAuthority: () => host.observationAuthority })
      // Even after the watch advanced, the historical replay keeps its original revision-2 snapshot.
      const laterReplay = await target.store.recordPostActivationObservation({ idempotencyKey: 'watch:healthy:1',
        receipt, resolveAuthority: () => host.observationAuthority })
      expect(laterReplay.result.revision).toBe(2)
      expect(target.store.listActivationWatchEvidence(plan.id)).toHaveLength(2)
      const mutated = { ...receipt, observationId: 'obs-reused-key' }
      await expect(target.store.recordPostActivationObservation({ idempotencyKey: 'watch:healthy:1',
        receipt: mutated, resolveAuthority: () => host.observationAuthority })).rejects.toThrow(/idempotency key was reused/u)
    })

    test('migration v11 to v12 backfills exact watches for historically activated plans', async () => {
      const target = await fixture(); const { plan, host } = await promoted(target, 'watch-migrate-v12')
      const activatedAt = plan.activation!.updatedAt
      target.store.close()
      const legacy = new DatabaseSync(target.path)
      legacy.exec('DROP TABLE IF EXISTS activation_watch_evidence; DROP TABLE IF EXISTS activation_watch; PRAGMA user_version = 11;')
      legacy.close(); await chmod(target.path, 0o600)
      const migrated = openControlPlaneDatabase(target.path)
      expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(controlPlaneSchemaVersion)
      expect(migrated.prepare('SELECT package_name, package_version, package_integrity, state, revision, last_host_generation, healthy_observations, started_at, updated_at FROM activation_watch WHERE plan_id = ?')
        .get(plan.id)).toEqual({ package_name: candidate.package, package_version: candidate.version,
        package_integrity: candidate.integrity, state: 'watching', revision: 1, last_host_generation: 0,
        healthy_observations: 0, started_at: activatedAt, updated_at: activatedAt })
      expect((migrated.prepare('SELECT count(*) AS count FROM activation_watch_evidence').get() as { count: number }).count).toBe(0)
      migrated.close()
      // A backfilled watch is a live watch: post-promotion monitoring continues after upgrade.
      const reopened = new ControlPlaneStore({ path: target.path, now: target.now }); target.store = reopened
      target.setNow(target.now() + 1_000)
      const receipt = await reopened.recordPostActivationObservation({ idempotencyKey: 'watch:post-migration:1',
        receipt: watchObservation(host, plan, { observationId: 'obs-post-migration', hostGeneration: 8, observedAt: target.now() }),
        resolveAuthority: () => host.observationAuthority })
      expect(receipt.result).toMatchObject({ state: 'watching', revision: 2, healthyObservations: 1 })
    })
  })
})
