import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { vi } from 'vitest'
import { approvalSigningPayload, Ed25519ApprovalAuthority } from '../../src/approval.ts'
import { catalogAdmissionId } from '../../src/catalog.ts'
import * as release from '../../src/release.ts'
import type { advanceSourceRelease } from '../../src/source-release-runner.ts'
import { ControlPlaneStore, MODIFY_GENERATOR_DIGEST } from '../../src/store.ts'
import type { PluginControlTrustConfig } from '../../src/trust.ts'
import type { SourceReleaseAuthorization, SourceReleaseRequest, SourceReleaseReceipt, SourceReleaseSuccessEvidence } from '../../src/types.ts'

// Real SQLite and Ed25519 phase verification; only external adapter execution is scripted.
const cleanup: Array<() => Promise<void>> = []
export async function cleanupReleaseFixtures() { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.resetAllMocks() }
export const phases = ['pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission'] as const
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export async function fixture(ownerBound = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'source-release-runner-'))); await chmod(root, 0o700)
  const db = join(root, 'control.sqlite'), store = new ControlPlaneStore({ path: db })
  cleanup.push(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  const catalog = { schemaVersion: 1 as const, entries: [] }, catalogPath = join(root, 'catalog.json')
  await writeFile(catalogPath, JSON.stringify(catalog), { mode: 0o600 })
  const reviewDecisionRoot = join(root, 'review'); await mkdir(reviewDecisionRoot, { mode: 0o700 })
  const keys = Object.fromEntries(['owner', ...phases].map(phase => [phase, generateKeyPairSync('ed25519')]))
  const policy = { targetBranch: 'repairs', candidateId: 'health-helper', packageName: '@dsh-enhanced/health-helper', packageVersion: '0.1.1',
    packagePath: 'plugins/health-helper', dshBaseline: '0.1.5', capabilities: ['health'], authorities: ['filesystem'], requires: [],
    registryId: 'local', registryLocator: pathToFileURL(join(root, 'registry')).href, registryReference: pathToFileURL(join(root, 'registry', 'packages', encodeURIComponent('@dsh-enhanced/health-helper'), '0.1.1', 'package.tgz')).href,
    catalogId: 'catalog', catalogPath, minimumReproducibleBuilds: 2 }
  const owner = { receiptVersion: 2 as const, authorityId: 'owner-route', authorityHash: 'a'.repeat(64), principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'primary', bindingVersion: 1, generation: 1 }
  const gap = ownerBound ? store.recordOwnerTaskFailureGap({ schemaVersion: 1, owner, outcomeId: 'outcome', projection: { subjectKind: 'foreground-turn', subjectRef: 'task', version: 1, digest: 'b'.repeat(64), disposition: 'upsert' }, sourceDigest: 'c'.repeat(64) }) : store.recordGap({ idempotencyKey: 'gap', capability: 'health', context: 'repair', expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 0 })
  let sourceCurrent = true
  const withSourceFence = <T>(callback: () => T): T => { if (!sourceCurrent) throw new Error('owner source changed'); return ownerBound ? store.withOwnerTaskFailureGapAdmission(gap.id, callback) : callback() }
  let plan = withSourceFence(() => store.createSourcePlan({ gapId: gap.id, name: 'health-helper', repository: root, worktree: join(root, 'worktree'), baseCommit: 'a'.repeat(40),
    generatorDigest: ownerBound ? MODIFY_GENERATOR_DIGEST : 'b'.repeat(64), scope: ownerBound ? ['plugins/health-helper'] : ['plugins/README.md', 'plugins/health-helper'], ttlMs: 600_000, idempotencyKey: 'plan',
    ...(ownerBound ? { mode: 'modify' as const, prepared: { treeDigest: 'c'.repeat(64), patchDigest: 'd'.repeat(64), checkedAt: Date.now(), evidence: { schemaVersion: 1 as const, kind: 'dsh-source-prepared-evidence' as const, environment: { npmConfigIgnoreScripts: true as const, frozenLockfile: true as const, offline: true as const, nodeVersion: 'fixture', pnpmVersion: 'fixture' }, commands: [{ command: 'pnpm', args: ['check'], exitCode: 0 as const, durationMs: 1, logDigest: 'e'.repeat(64) }], pack: { name: 'health-helper', version: '0.1.1', sizeBytes: 7, sha256: 'f'.repeat(64) }, preparedAt: Date.now() } } } : {}) }).result)
  const unsigned = { schemaVersion: 1 as const, approvalId: 'approval', authority: 'owner', keyId: 'owner', planId: plan.id, planDigest: plan.digest,
    decision: 'approved' as const, principal: 'owner', decidedAt: Date.now(), expiresAt: plan.expiresAt }
  const receipt = { ...unsigned, signature: sign(null, Buffer.from(approvalSigningPayload(unsigned)), keys.owner!.privateKey).toString('base64') }
  plan = (await store.approveSource({ planId: plan.id, expectedRevision: plan.revision, receipt, idempotencyKey: 'approval', withSourceFence,
    resolveAuthority: () => new Ed25519ApprovalAuthority(keys.owner!.publicKey.export({ format: 'pem', type: 'spki' }), 'owner', 'owner') })).result
  if (ownerBound) plan = store.verifyPreparedSourcePlan({ planId: plan.id, expectedRevision: plan.revision, recheckedTreeDigest: plan.sourceCheck!.treeDigest, recheckedPatchDigest: plan.sourceCheck!.patchDigest, withSourceFence }).result
  else {
  plan = store.beginSourceChecks({ planId: plan.id, expectedRevision: plan.revision })
  plan = store.finishSourceChecks({ planId: plan.id, expectedRevision: plan.revision, succeeded: true, checkedTreeDigest: 'c'.repeat(64), checkedPatchDigest: 'd'.repeat(64) })
  }
  const authorizationInput: Omit<SourceReleaseAuthorization, 'signature'> = { schemaVersion: 1, kind: 'dsh-source-release-authorization', authorizationId: 'auth',
    authority: 'owner', keyId: 'owner', planId: plan.id, planDigest: plan.digest, baseCommit: plan.baseCommit, scope: plan.scope,
    checkedTreeDigest: plan.sourceCheck!.treeDigest, checkedPatchDigest: plan.sourceCheck!.patchDigest, releasePolicy: policy, authorizedAt: Date.now(), expiresAt: plan.expiresAt }
  const authorization = { ...authorizationInput, signature: sign(null, Buffer.from(release.sourceReleaseAuthorizationSigningPayload(authorizationInput)), keys.owner!.privateKey).toString('base64') }
  plan = (await store.startSourceRelease({ planId: plan.id, expectedRevision: plan.revision, authorization, idempotencyKey: 'start', withSourceFence,
    resolveAuthority: () => new release.Ed25519SourceReleaseAuthorizationAuthority(keys.owner!.publicKey.export({ format: 'pem', type: 'spki' }), 'owner', 'owner') })).result
  const trust = { schemaVersion: 4, installationId: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00',
    ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01', path: db }, catalog: { id: 'catalog', path: catalogPath },
    releaseRegistry: { id: 'local', locator: policy.registryLocator }, releaseReceiptTtlMs: 60_000,
    releaseAuthorizationKeys: [{ authority: 'owner', keyId: 'owner', publicKeyPem: keys.owner!.publicKey.export({ format: 'pem', type: 'spki' }) }],
    releaseKeys: phases.map(phase => ({ authority: phase, keyId: phase, publicKeyPem: keys[phase]!.publicKey.export({ format: 'pem', type: 'spki' }) })),
    releaseAdapters: Object.fromEntries(phases.map(phase => [phase, { id: phase, version: '1', path: join(root, phase), sha256: 'e'.repeat(64),
      interpreter: null, authority: phase, keyId: phase, timeoutMs: 1000, environmentAllowlist: [] }])) } as unknown as PluginControlTrustConfig
  const controller = new AbortController(), assertCurrent = vi.fn(async () => { controller.signal.throwIfAborted(); withSourceFence(() => {}) })
  const options: Parameters<typeof advanceSourceRelease>[0] = { store, planId: plan.id, trust, config: { reviewDecisionRoot, timeoutMs: 30_000 }, signal: controller.signal,
    assertCurrent, withSourceFence: <T>(callback: () => T): T => { controller.signal.throwIfAborted(); return withSourceFence(callback) } }
  let artifactSignature = ''
  const evidence = async (request: SourceReleaseRequest): Promise<SourceReleaseSuccessEvidence> => {
    const input = request.input
    if (request.phase === 'pr') return { kind: 'pr', prId: `pr-${request.operationId}`, baseCommit: request.input.baseCommit, headCommit: '2'.repeat(40),
      treeDigest: request.input.expectedTreeDigest, patchDigest: request.input.expectedPatchDigest, repositoryDigest: '3'.repeat(64) }
    if (request.phase === 'review') return { kind: 'review', prId: request.input.prId, headCommit: request.input.headCommit, reviewId: 'review-1',
      decision: 'approved', reviewerPrincipalDigest: hash('independent-reviewer'), prEvidenceDigest: request.input.prEvidenceDigest }
    if (request.phase === 'merge') return { kind: 'merge', prId: request.input.prId, reviewedHeadCommit: request.input.headCommit, reviewId: request.input.reviewId,
      reviewEvidenceDigest: request.input.reviewEvidenceDigest, mergeCommit: '5'.repeat(40), targetBranch: request.input.targetBranch }
    if (request.phase === 'build') {
      const tarballPath = join(root, 'package.tgz'), sbomPath = join(root, 'sbom.json'), provenancePath = join(root, 'provenance.json')
      for (const path of [tarballPath, sbomPath, provenancePath]) await writeFile(path, 'fixture', { mode: 0o600 })
      return { kind: 'build', isolated: true, reproducibleBuilds: 2, firstBuildSha256: hash('fixture'), secondBuildSha256: hash('fixture'),
        mergeEvidenceDigest: request.input.mergeEvidenceDigest, candidateId: request.input.expectedCandidateId, sourceName: request.input.name,
        packagePath: request.input.expectedPackagePath, packageName: request.input.expectedPackageName, packageVersion: request.input.expectedPackageVersion,
        tarballPath, tarballBytes: 7, tarballSha256: hash('fixture'), tarballIntegrity: `sha512-${createHash('sha512').update('fixture').digest('base64')}`,
        sbomPath, sbomSha256: hash('fixture'), provenancePath, provenanceSha256: hash('fixture'), mergedCommit: request.input.mergeCommit,
        dshBaseline: request.input.expectedDshBaseline, capabilities: request.input.expectedCapabilities, authorities: request.input.expectedAuthorities, requires: request.input.expectedRequires }
    }
    if (request.phase === 'sign') {
      artifactSignature = sign(null, Buffer.from(release.sourceArtifactSigningPayload(request.input.artifact)), keys.sign!.privateKey).toString('base64')
      return { kind: 'sign', artifactStatementDigest: release.sourceArtifactStatementDigest(request.input.artifact), artifactSignature,
        artifactSignatureDigest: hash(Buffer.from(artifactSignature, 'base64')), buildEvidenceDigest: request.input.buildEvidenceDigest }
    }
    const artifactSignatureDigest = hash(Buffer.from(artifactSignature, 'base64'))
    if (request.phase === 'publish') return { kind: 'publish', registryId: request.registry.id, registryReference: policy.registryReference,
      packageName: request.input.artifact.packageName, packageVersion: request.input.artifact.packageVersion, tarballSha256: request.input.artifact.tarballSha256,
      tarballIntegrity: request.input.artifact.tarballIntegrity, artifactStatementDigest: request.input.artifactStatementDigest,
      artifactSignatureDigest, signEvidenceDigest: request.input.signEvidenceDigest, immutable: true }
    if (request.phase === 'registry-verify') return { kind: 'registry-verify', registryId: request.registry.id, registryReference: request.input.registryReference,
      independentlyDownloaded: true, downloadedBytes: request.input.artifact.tarballBytes, downloadedSha256: request.input.artifact.tarballSha256,
      downloadedIntegrity: request.input.artifact.tarballIntegrity, artifactStatementDigest: request.input.artifactStatementDigest,
      artifactSignatureDigest, publishEvidenceDigest: request.input.publishEvidenceDigest }
    if (request.phase !== 'catalog-admission') throw new Error(`unexpected ${input}`)
    const admissionId = catalogAdmissionId({ ...request, expectedBeforeCatalogDigest: request.input.expectedBeforeCatalogDigest,
      expectedAfterCatalogDigest: request.input.expectedAfterCatalogDigest, registryReference: request.input.registryReference,
      artifactStatementDigest: request.input.artifactStatementDigest, artifactSignature: request.input.artifactSignature,
      verificationEvidenceDigest: request.input.verificationEvidenceDigest, candidate: request.input.candidate })
    await writeFile(catalogPath, JSON.stringify({ schemaVersion: 1, entries: [request.input.candidate] }))
    return { kind: 'catalog-admission', admissionId, catalogId: request.catalog.id, beforeCatalogDigest: request.input.expectedBeforeCatalogDigest,
      afterCatalogDigest: request.input.expectedAfterCatalogDigest, registryReference: request.input.registryReference,
      artifactStatementDigest: request.input.artifactStatementDigest, artifactSignatureDigest, verificationEvidenceDigest: request.input.verificationEvidenceDigest,
      candidate: request.input.candidate }
  }
  const execute = async (request: SourceReleaseRequest): Promise<SourceReleaseReceipt> => {
    const e = await evidence(request)
    const value = { schemaVersion: 1 as const, receiptId: `receipt-${request.operationId}`, authority: request.adapter.authority, keyId: request.adapter.keyId,
      installationId: request.installationId, planId: request.plan.id, planDigest: request.plan.digest, releaseId: request.release.id,
      fence: request.release.fence, operationId: request.operationId, requestDigest: release.sourceReleaseRequestDigest(request), phase: request.phase,
      outcome: 'passed' as const, evidence: e, evidenceDigest: release.sourceReleaseEvidenceDigest(e), observedAt: Date.now(), expiresAt: request.requestedAt + request.receiptTtlMs }
    return { ...value, signature: sign(null, Buffer.from(release.sourceReleaseSigningPayload(value)), keys[request.phase]!.privateKey).toString('base64') }
  }
  vi.mocked(release.invokeSourceReleaseAdapter).mockImplementation((_trust, request) => execute(request))
  const decide = async (overrides = {}) => {
    const operation = store.findSourceReleaseOperation(plan.id, 'review', plan.release!.fence)!
    if (operation.request.phase !== 'review') throw new Error('review expected')
    await writeFile(join(reviewDecisionRoot, `${operation.request.input.prId}.json`), JSON.stringify({ schemaVersion: 1, kind: 'dsh-local-review-decision',
      ...operation.request.input, decision: 'approved', reviewerPrincipal: 'independent-reviewer', ...overrides }), { mode: 0o600 })
    // request input contains exactly prId/head/base/prEvidenceDigest.
  }
  return { root, store, plan, options, controller, decide, execute, setSourceCurrent: (value: boolean) => { sourceCurrent = value } }
}

