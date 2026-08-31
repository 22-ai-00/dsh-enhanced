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
import { Ed25519SourcePublishReconciliationAuthority, Ed25519SourceReleaseAuthorizationAuthority,
  sourcePublishReconciliationEvidenceDigest, sourcePublishReconciliationRequestDigest, sourcePublishReconciliationSigningPayload,
  sourceReleaseAuthorizationSigningPayload } from '../src/release.ts'
import { controlPlaneOperationReceiptDigest, controlPlaneSchemaVersion, openControlPlaneDatabase } from '../src/sqlite.ts'
import { controlPlaneDigest, ControlPlaneStore, type CreateActivationPlanInput } from '../src/store.ts'
import type { ApprovalAuthority, ApprovalReceipt, HostAttestationReceipt, PluginActivationPlan, PluginSourcePlan, SourceReleaseAuthority,
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

function releaseAuthorization(plan: PluginSourcePlan, now: number, root: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const unsigned: Omit<SourceReleaseAuthorization, 'signature'> = { schemaVersion: 1, kind: 'dsh-source-release-authorization',
    authorizationId: `release-auth-${plan.id.slice(-12)}`, authority: 'release-owner', keyId: 'release-owner-key',
    planId: plan.id, planDigest: plan.digest, baseCommit: plan.baseCommit, checkedTreeDigest: plan.sourceCheck!.treeDigest,
    checkedPatchDigest: plan.sourceCheck!.patchDigest, scope: plan.scope, releasePolicy: { targetBranch: 'main',
      candidateId: plan.name, packageName: '@dsh-enhanced/health-helper', packageVersion: '0.1.0', packagePath: 'plugins/health-helper',
      dshBaseline: '0.1.0', capabilities: ['health'], authorities: ['read-only: health'], requires: [], registryId: 'npm',
      registryLocator: 'https://registry.example.test', registryReference: '@dsh-enhanced/health-helper@0.1.0',
      catalogId: 'owner-catalog', catalogPath: join(root, 'catalog.json'), minimumReproducibleBuilds: 2 },
    authorizedAt: now, expiresAt: now + 30_000 }
  const authorization: SourceReleaseAuthorization = { ...unsigned,
    signature: sign(null, Buffer.from(sourceReleaseAuthorizationSigningPayload(unsigned)), privateKey).toString('base64') }
  return { authorization, authority: new Ed25519SourceReleaseAuthorizationAuthority(
    publicKey.export({ format: 'pem', type: 'spki' }), 'release-owner', 'release-owner-key', () => now) }
}

async function startedSource(target: Awaited<ReturnType<typeof fixture>>, suffix: string): Promise<PluginSourcePlan> {
  const reviewed = await reviewedSource(target, suffix); const signed = releaseAuthorization(reviewed, target.now(), target.root)
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
  outcome: SourcePublishReconciliationEvidence['outcome'], idempotencyKey: string): Promise<PluginSourcePlan> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const authorizationAuthority = acceptingAuthorizationAuthority
  const operation = await target.store.prepareSourcePublishReconciliation({ planId: plan.id, expectedRevision: plan.revision,
    expectedFence: plan.release!.fence, installationId, ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01', path: join(target.root, 'control.sqlite') },
    registry: { id: 'npm', locator: 'https://registry.example.test' }, adapter: { id: 'registry-reconciler', version: '1.0.0',
      path: join(target.root, 'registry-reconciler'), sha256: '8'.repeat(64), interpreter: null, authority: 'registry-verifier', keyId: 'registry-key' },
    receiptTtlMs: 10_000, resolveAuthorizationAuthority: () => authorizationAuthority })
  const request = operation.request; const evidence: SourcePublishReconciliationEvidence = { kind: 'publish-reconciliation', outcome,
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
  const unsigned: Omit<SourcePublishReconciliationReceipt, 'signature'> = { schemaVersion: 1,
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
    expect(target.store.health()).toEqual({ gaps: 1, readyPlans: 0, activeActivations: 0, failed: 0, rollbackPending: 0 })
    expect(Object.keys(target.store.health()).sort()).toEqual(['activeActivations', 'failed', 'gaps', 'readyPlans', 'rollbackPending'].sort())
  })
})
