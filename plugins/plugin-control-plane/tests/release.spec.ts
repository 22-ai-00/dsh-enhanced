import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, test } from 'vitest'
import { catalogAdmissionId, previewCatalogAdmission } from '../src/catalog.ts'
import {
  Ed25519SourcePublishReconciliationAuthority,
  Ed25519SourceReleaseAuthorizationAuthority,
  Ed25519SourceReleaseAuthority,
  invokeSourceReleaseAdapter,
  parseSourcePublishReconciliationReceipt,
  parseSourcePublishReconciliationRequest,
  parseSourceReleaseReceipt,
  parseSourceReleaseRequest,
  sourcePublishReconciliationEvidenceDigest,
  sourcePublishReconciliationRequestDigest,
  sourcePublishReconciliationSigningPayload,
  sourceArtifactSigningPayload,
  sourceArtifactStatementDigest,
  sourceReleaseAuthorizationSigningPayload,
  sourceReleaseEvidenceDigest,
  sourceReleaseRequestDigest,
  sourceReleaseSigningPayload,
} from '../src/release.ts'
import { defaultHostAttestationPolicy, loadTrustConfig, resolveTrustKey, type PluginControlTrustConfig } from '../src/trust.ts'
import type {
  PluginSourcePlan,
  SourcePublishReconciliationEvidence,
  SourcePublishReconciliationReceipt,
  SourcePublishReconciliationRequest,
  SourceReleaseArtifact,
  SourceReleaseAuthorization,
  SourceReleasePolicy,
  SourceReleaseReceipt,
  SourceReleaseRequest,
  SourceReleaseSuccessEvidence,
  VerifiedSourceReleaseAuthorization,
} from '../src/types.ts'

const now = 1_800_000_000_000
const installationId = '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00'
const roots: string[] = []
const digest = (character: string): string => character.repeat(64)
const commit = (character: string): string => character.repeat(40)
const publicKeyPem = (key: KeyObject): string => key.export({ type: 'spki', format: 'pem' }).toString()
const signatureDigest = (signature: string): string => createHash('sha256').update(Buffer.from(signature, 'base64')).digest('hex')
let cachedInterpreter: { path: string; sha256: string } | undefined
let cachedInterpreterRoot: string | undefined

async function fixtureInterpreter(): Promise<{ path: string; sha256: string }> {
  if (cachedInterpreter !== undefined) return cachedInterpreter
  const sourcePath = await realpath(process.execPath)
  const root = await mkdtemp(join(tmpdir(), 'plugin-release-node-')); await chmod(root, 0o700)
  const path = join(root, 'node')
  await copyFile(sourcePath, path); await chmod(path, 0o700)
  cachedInterpreterRoot = root
  cachedInterpreter = { path: await realpath(path), sha256: createHash('sha256').update(await readFile(path)).digest('hex') }
  return cachedInterpreter
}

const releasePolicy: SourceReleasePolicy = Object.freeze({
  targetBranch: 'main',
  candidateId: 'health-helper',
  packageName: '@dsh-enhanced/health-helper',
  packageVersion: '1.2.3',
  packagePath: 'plugins/health-helper',
  dshBaseline: '0.1.0',
  capabilities: ['health'],
  authorities: ['read-only: health'],
  requires: [],
  registryId: 'npm',
  registryLocator: 'https://registry.example.test',
  registryReference: '@dsh-enhanced/health-helper@1.2.3',
  catalogId: 'owner-catalog',
  catalogPath: '/private/catalog.json',
  minimumReproducibleBuilds: 2,
})

function sourcePlan(overrides: Partial<PluginSourcePlan> = {}): PluginSourcePlan {
  return {
    schemaVersion: 1,
    kind: 'source',
    id: 'source-plan-1',
    gapId: 'gap-1',
    gapSnapshot: { revision: 1, inputDigest: digest('1'), roi: 2, capability: 'health' },
    status: 'ready-for-human-review',
    revision: 4,
    createdAt: now - 10_000,
    expiresAt: now + 60_000,
    digest: digest('2'),
    repository: '/source/repository',
    worktree: '/source/worktree',
    baseCommit: commit('a'),
    name: releasePolicy.candidateId,
    generatorDigest: digest('3'),
    scope: ['plugins/health-helper'],
    sourceCheck: { treeDigest: digest('4'), patchDigest: digest('5'), checkedAt: now - 2_000 },
    ...overrides,
  }
}

function signedAuthorization(
  plan: PluginSourcePlan,
  privateKey: KeyObject,
  overrides: Partial<Omit<SourceReleaseAuthorization, 'signature'>> = {},
): SourceReleaseAuthorization {
  if (plan.sourceCheck === undefined) throw new Error('fixture plan requires source check evidence')
  const unsigned: Omit<SourceReleaseAuthorization, 'signature'> = {
    schemaVersion: 1,
    kind: 'dsh-source-release-authorization',
    authorizationId: 'release-authorization-1',
    authority: 'release-owner',
    keyId: 'release-owner-key',
    planId: plan.id,
    planDigest: plan.digest,
    baseCommit: plan.baseCommit,
    checkedTreeDigest: plan.sourceCheck.treeDigest,
    checkedPatchDigest: plan.sourceCheck.patchDigest,
    scope: plan.scope,
    releasePolicy,
    authorizedAt: now - 1_000,
    expiresAt: now + 30_000,
    ...overrides,
  }
  return { ...unsigned, signature: sign(null, Buffer.from(sourceReleaseAuthorizationSigningPayload(unsigned)), privateKey).toString('base64') }
}

async function verifiedAuthorizationFixture(): Promise<{
  plan: PluginSourcePlan
  authorization: VerifiedSourceReleaseAuthorization
  privateKey: KeyObject
}> {
  const plan = sourcePlan()
  const keys = generateKeyPairSync('ed25519')
  const authority = new Ed25519SourceReleaseAuthorizationAuthority(
    publicKeyPem(keys.publicKey), 'release-owner', 'release-owner-key', () => now,
  )
  const authorization = await authority.verify(signedAuthorization(plan, keys.privateKey), plan)
  return { plan: { ...plan, releaseAuthorization: authorization, release: { id: 'release-1', fence: 1, updatedAt: now } },
    authorization, privateKey: keys.privateKey }
}

function requestBase(plan: PluginSourcePlan, authorization: VerifiedSourceReleaseAuthorization) {
  return {
    schemaVersion: 1 as const,
    kind: 'dsh-source-release-request' as const,
    operationId: 'release-operation-1',
    attempt: 1,
    requestedAt: now,
    receiptTtlMs: 10_000,
    installationId,
    ledger: { id: 'ledger-1', path: '/private/control.sqlite' },
    plan: { id: plan.id, digest: plan.digest, revision: plan.revision },
    release: { id: 'release-1', fence: 1 },
    authorization,
    adapter: {
      id: 'release-adapter',
      version: '1.0.0',
      path: '/private/release-adapter',
      sha256: digest('6'),
      interpreter: null,
      authority: 'release-adapter',
      keyId: 'release-adapter-key',
    },
    registry: { id: releasePolicy.registryId, locator: 'https://registry.example.test' },
    catalog: { id: releasePolicy.catalogId, path: '/private/catalog.json' },
  }
}

function prRequest(plan: PluginSourcePlan, authorization: VerifiedSourceReleaseAuthorization): Extract<SourceReleaseRequest, { phase: 'pr' }> {
  return parseSourceReleaseRequest({
    ...requestBase(plan, authorization),
    phase: 'pr',
    input: {
      repository: plan.repository,
      worktree: plan.worktree,
      baseCommit: authorization.baseCommit,
      name: releasePolicy.candidateId,
      scope: authorization.scope,
      expectedTreeDigest: authorization.checkedTreeDigest,
      expectedPatchDigest: authorization.checkedPatchDigest,
    },
  }) as Extract<SourceReleaseRequest, { phase: 'pr' }>
}

function mergeRequest(plan: PluginSourcePlan, authorization: VerifiedSourceReleaseAuthorization): Extract<SourceReleaseRequest, { phase: 'merge' }> {
  return parseSourceReleaseRequest({
    ...requestBase(plan, authorization),
    phase: 'merge',
    input: {
      prId: 'pr-17',
      headCommit: commit('b'),
      reviewId: 'review-23',
      reviewEvidenceDigest: digest('7'),
      targetBranch: releasePolicy.targetBranch,
    },
  }) as Extract<SourceReleaseRequest, { phase: 'merge' }>
}

function buildRequest(plan: PluginSourcePlan, authorization: VerifiedSourceReleaseAuthorization): Extract<SourceReleaseRequest, { phase: 'build' }> {
  return parseSourceReleaseRequest({
    ...requestBase(plan, authorization),
    phase: 'build',
    input: {
      repository: plan.repository,
      mergeCommit: commit('c'),
      mergeEvidenceDigest: digest('8'),
      name: releasePolicy.candidateId,
      expectedCandidateId: releasePolicy.candidateId,
      expectedPackageName: releasePolicy.packageName,
      expectedPackageVersion: releasePolicy.packageVersion,
      expectedPackagePath: releasePolicy.packagePath,
      expectedDshBaseline: releasePolicy.dshBaseline,
      expectedCapabilities: releasePolicy.capabilities,
      expectedAuthorities: releasePolicy.authorities,
      expectedRequires: releasePolicy.requires,
    },
  }) as Extract<SourceReleaseRequest, { phase: 'build' }>
}

function signedReceipt(
  request: SourceReleaseRequest,
  evidence: SourceReleaseReceipt['evidence'],
  privateKey: KeyObject,
): SourceReleaseReceipt {
  const unsigned: Omit<SourceReleaseReceipt, 'signature'> = {
    schemaVersion: 1,
    receiptId: `receipt-${request.phase}`,
    authority: request.adapter.authority,
    keyId: request.adapter.keyId,
    installationId: request.installationId,
    planId: request.plan.id,
    planDigest: request.plan.digest,
    releaseId: request.release.id,
    fence: request.release.fence,
    operationId: request.operationId,
    requestDigest: sourceReleaseRequestDigest(request),
    phase: request.phase,
    outcome: 'passed',
    evidence,
    evidenceDigest: sourceReleaseEvidenceDigest(evidence),
    observedAt: now,
    expiresAt: now + 5_000,
  }
  return { ...unsigned, signature: sign(null, Buffer.from(sourceReleaseSigningPayload(unsigned)), privateKey).toString('base64') }
}

function resignReceipt(
  receipt: SourceReleaseReceipt,
  privateKey: KeyObject,
  overrides: Partial<Omit<SourceReleaseReceipt, 'signature'>> = {},
): SourceReleaseReceipt {
  const { signature: _signature, ...fields } = receipt
  const unsigned: Omit<SourceReleaseReceipt, 'signature'> = { ...fields, ...overrides }
  return { ...unsigned, signature: sign(null, Buffer.from(sourceReleaseSigningPayload(unsigned)), privateKey).toString('base64') }
}

function releaseAuthority(keys: ReturnType<typeof generateKeyPairSync>): Ed25519SourceReleaseAuthority {
  return new Ed25519SourceReleaseAuthority(
    publicKeyPem(keys.publicKey), 'release-adapter', 'release-adapter-key', () => now + 100,
  )
}

function reconciliationRequest(
  plan: PluginSourcePlan,
  authorization: VerifiedSourceReleaseAuthorization,
): SourcePublishReconciliationRequest {
  return parseSourcePublishReconciliationRequest({
    schemaVersion: 1,
    kind: 'dsh-source-publish-reconciliation-request',
    operationId: 'publish-reconciliation-1',
    attempt: 1,
    requestedAt: now,
    receiptTtlMs: 10_000,
    installationId,
    ledger: { id: 'ledger-1', path: '/private/control.sqlite' },
    plan: { id: plan.id, digest: plan.digest, revision: plan.revision },
    release: { id: 'release-1', fence: 1 },
    authorization,
    adapter: {
      id: 'registry-reconciler',
      version: '1.0.0',
      path: '/private/registry-reconciler',
      sha256: digest('6'),
      interpreter: null,
      authority: 'registry-verifier',
      keyId: 'registry-key',
    },
    registry: { id: releasePolicy.registryId, locator: 'https://registry.example.test' },
    ambiguousPublish: {
      operationId: 'publish-operation-1',
      receiptId: 'ambiguous-publish-receipt-1',
      receiptDigest: digest('7'),
      evidenceDigest: digest('8'),
    },
    artifact: {
      packageName: releasePolicy.packageName,
      packageVersion: releasePolicy.packageVersion,
      tarballSha256: digest('9'),
      tarballIntegrity: `sha512-${Buffer.alloc(64, 9).toString('base64')}`,
    },
    expectedArtifactStatementDigest: digest('a'),
    expectedArtifactSignatureDigest: digest('b'),
    expectedRegistryReference: releasePolicy.registryReference,
  })
}

function matchingReconciliationEvidence(
  request: SourcePublishReconciliationRequest,
  overrides: Partial<SourcePublishReconciliationEvidence> = {},
): SourcePublishReconciliationEvidence {
  return {
    kind: 'publish-reconciliation',
    outcome: 'exists-match',
    registryId: request.registry.id,
    registryReference: request.expectedRegistryReference,
    packageName: request.artifact.packageName,
    packageVersion: request.artifact.packageVersion,
    expectedTarballSha256: request.artifact.tarballSha256,
    expectedTarballIntegrity: request.artifact.tarballIntegrity,
    expectedArtifactStatementDigest: request.expectedArtifactStatementDigest,
    expectedArtifactSignatureDigest: request.expectedArtifactSignatureDigest,
    observedTarballSha256: request.artifact.tarballSha256,
    observedTarballIntegrity: request.artifact.tarballIntegrity,
    observedArtifactStatementDigest: request.expectedArtifactStatementDigest,
    observedArtifactSignatureDigest: request.expectedArtifactSignatureDigest,
    ambiguousPublishOperationId: request.ambiguousPublish.operationId,
    ambiguousPublishReceiptDigest: request.ambiguousPublish.receiptDigest,
    detailDigest: digest('a'),
    ...overrides,
  }
}

function signedReconciliationReceipt(
  request: SourcePublishReconciliationRequest,
  evidence: SourcePublishReconciliationEvidence,
  privateKey: KeyObject,
): SourcePublishReconciliationReceipt {
  const unsigned: Omit<SourcePublishReconciliationReceipt, 'signature'> = {
    schemaVersion: 1,
    kind: 'dsh-source-publish-reconciliation-receipt',
    receiptId: 'publish-reconciliation-receipt-1',
    authority: request.adapter.authority,
    keyId: request.adapter.keyId,
    installationId: request.installationId,
    planId: request.plan.id,
    planDigest: request.plan.digest,
    releaseId: request.release.id,
    fence: request.release.fence,
    operationId: request.operationId,
    requestDigest: sourcePublishReconciliationRequestDigest(request),
    evidence,
    evidenceDigest: sourcePublishReconciliationEvidenceDigest(evidence),
    observedAt: now,
    expiresAt: now + 5_000,
  }
  return { ...unsigned,
    signature: sign(null, Buffer.from(sourcePublishReconciliationSigningPayload(unsigned)), privateKey).toString('base64') }
}

async function artifactFixture(): Promise<SourceReleaseArtifact> {
  const root = await mkdtemp(join(tmpdir(), 'plugin-release-artifacts-')); roots.push(root)
  await chmod(root, 0o700)
  const tarballPath = join(root, 'health-helper.tgz')
  const sbomPath = join(root, 'sbom.json')
  const provenancePath = join(root, 'provenance.json')
  const tarball = Buffer.from('deterministic plugin tarball')
  const sbom = Buffer.from('{"bomFormat":"CycloneDX"}')
  const provenance = Buffer.from('{"predicateType":"https://slsa.dev/provenance/v1"}')
  await writeFile(tarballPath, tarball, { mode: 0o600 })
  await writeFile(sbomPath, sbom, { mode: 0o600 })
  await writeFile(provenancePath, provenance, { mode: 0o600 })
  return {
    candidateId: releasePolicy.candidateId,
    sourceName: releasePolicy.candidateId,
    packagePath: releasePolicy.packagePath,
    packageName: releasePolicy.packageName,
    packageVersion: releasePolicy.packageVersion,
    tarballPath,
    tarballBytes: tarball.length,
    tarballSha256: createHash('sha256').update(tarball).digest('hex'),
    tarballIntegrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
    sbomPath,
    sbomSha256: createHash('sha256').update(sbom).digest('hex'),
    provenancePath,
    provenanceSha256: createHash('sha256').update(provenance).digest('hex'),
    mergedCommit: commit('c'),
    dshBaseline: releasePolicy.dshBaseline,
    capabilities: releasePolicy.capabilities,
    authorities: releasePolicy.authorities,
    requires: releasePolicy.requires,
  }
}

async function catalogAdmissionFixture() {
  const root = await mkdtemp(join(tmpdir(), 'plugin-release-catalog-receipt-')); roots.push(root); await chmod(root, 0o700)
  const catalogPath = join(root, 'catalog.json')
  const policy: SourceReleasePolicy = { ...releasePolicy, catalogPath }
  const uncheckedPlan = sourcePlan({ status: 'awaiting-catalog-admission' })
  const ownerKeys = generateKeyPairSync('ed25519')
  const authorizationAuthority = new Ed25519SourceReleaseAuthorizationAuthority(
    publicKeyPem(ownerKeys.publicKey), 'release-owner', 'release-owner-key', () => now,
  )
  const authorization = await authorizationAuthority.verify(
    signedAuthorization(uncheckedPlan, ownerKeys.privateKey, { releasePolicy: policy }), uncheckedPlan,
  )
  const plan: PluginSourcePlan = { ...uncheckedPlan, releaseAuthorization: authorization,
    release: { id: 'release-1', fence: 1, updatedAt: now } }
  const artifact = await artifactFixture()
  const artifactSignerKeys = generateKeyPairSync('ed25519')
  const artifactStatementDigest = sourceArtifactStatementDigest(artifact)
  const artifactSignature = sign(null, Buffer.from(sourceArtifactSigningPayload(artifact)), artifactSignerKeys.privateKey).toString('base64')
  const registryKeys = generateKeyPairSync('ed25519')
  const registryRequest = parseSourceReleaseRequest({
    ...requestBase(plan, authorization),
    operationId: 'registry-verification-operation-1',
    plan: { id: plan.id, digest: plan.digest, revision: plan.revision - 1 },
    adapter: { id: 'registry-verifier', version: '1.0.0', path: '/private/registry-verifier', sha256: digest('7'),
      interpreter: null, authority: 'registry-verifier', keyId: 'registry-verifier-key' },
    catalog: { id: policy.catalogId, path: catalogPath },
    phase: 'registry-verify',
    input: { artifact, artifactStatementDigest, artifactSignature, registryReference: policy.registryReference,
      publishEvidenceDigest: digest('8') },
  }) as Extract<SourceReleaseRequest, { phase: 'registry-verify' }>
  const registryEvidence: Extract<SourceReleaseSuccessEvidence, { kind: 'registry-verify' }> = {
    kind: 'registry-verify',
    registryId: registryRequest.registry.id,
    registryReference: registryRequest.input.registryReference,
    independentlyDownloaded: true,
    downloadedBytes: artifact.tarballBytes,
    downloadedSha256: artifact.tarballSha256,
    downloadedIntegrity: artifact.tarballIntegrity,
    artifactStatementDigest,
    artifactSignatureDigest: signatureDigest(artifactSignature),
    publishEvidenceDigest: registryRequest.input.publishEvidenceDigest,
  }
  const registryReceipt = signedReceipt(registryRequest, registryEvidence, registryKeys.privateKey)
  const candidate = { id: artifact.candidateId, package: artifact.packageName, version: artifact.packageVersion,
    integrity: artifact.tarballIntegrity, registry: { id: registryRequest.registry.id, locator: registryRequest.registry.locator,
      reference: registryRequest.input.registryReference }, requires: artifact.requires, dshBaseline: artifact.dshBaseline,
    capabilities: artifact.capabilities, authorities: artifact.authorities }
  const preview = previewCatalogAdmission({ schemaVersion: 1, entries: [] }, candidate)
  await writeFile(catalogPath, JSON.stringify(preview.catalog), { mode: 0o600 })
  const catalogKeys = generateKeyPairSync('ed25519')
  const request = parseSourceReleaseRequest({
    ...requestBase(plan, authorization),
    operationId: 'catalog-admission-operation-1',
    adapter: { id: 'catalog-admitter', version: '1.0.0', path: '/private/catalog-admitter', sha256: digest('9'),
      interpreter: null, authority: 'catalog-admitter', keyId: 'catalog-admitter-key' },
    catalog: { id: policy.catalogId, path: catalogPath },
    phase: 'catalog-admission',
    input: { artifact, artifactStatementDigest, artifactSignature, registryReference: policy.registryReference,
      registryVerificationRequest: registryRequest, registryVerificationReceipt: registryReceipt,
      verificationEvidenceDigest: registryReceipt.evidenceDigest,
      expectedBeforeCatalogDigest: preview.beforeCatalogDigest, expectedAfterCatalogDigest: preview.afterCatalogDigest,
      candidate: preview.candidate },
  }) as Extract<SourceReleaseRequest, { phase: 'catalog-admission' }>
  const evidence: Extract<SourceReleaseSuccessEvidence, { kind: 'catalog-admission' }> = {
    kind: 'catalog-admission',
    admissionId: catalogAdmissionId({ catalog: request.catalog, registry: request.registry, installationId: request.installationId,
      operationId: request.operationId, plan: request.plan, release: request.release,
      expectedBeforeCatalogDigest: request.input.expectedBeforeCatalogDigest,
      expectedAfterCatalogDigest: request.input.expectedAfterCatalogDigest, registryReference: request.input.registryReference,
      artifactStatementDigest: request.input.artifactStatementDigest, artifactSignature: request.input.artifactSignature,
      verificationEvidenceDigest: request.input.verificationEvidenceDigest, candidate: request.input.candidate }),
    catalogId: request.catalog.id,
    beforeCatalogDigest: request.input.expectedBeforeCatalogDigest,
    afterCatalogDigest: request.input.expectedAfterCatalogDigest,
    registryReference: request.input.registryReference,
    artifactStatementDigest: request.input.artifactStatementDigest,
    artifactSignatureDigest: signatureDigest(request.input.artifactSignature),
    verificationEvidenceDigest: request.input.verificationEvidenceDigest,
    candidate: request.input.candidate,
  }
  return { plan, request, evidence, registryKeys, catalogKeys, receipt: signedReceipt(request, evidence, catalogKeys.privateKey) }
}

async function realAdapterInvocationFixture(replaceDuringCapabilities = false): Promise<{
  trust: PluginControlTrustConfig
  request: Extract<SourceReleaseRequest, { phase: 'publish' }>
  receipt: SourceReleaseReceipt
  markerPath: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'plugin-release-invocation-')); roots.push(root); await chmod(root, 0o700)
  const dshHome = join(root, 'dsh-home'); await mkdir(dshHome, { mode: 0o700 })
  const catalogPath = join(root, 'catalog.json'); await writeFile(catalogPath, '{"schemaVersion":1,"entries":[]}', { mode: 0o600 })
  const artifact = await artifactFixture()
  const interpreter = await fixtureInterpreter(); const nodePath = interpreter.path; const nodeSha256 = interpreter.sha256
  const adapterPath = join(root, 'adapter.mjs'); const evilPath = join(root, 'evil.mjs')
  const retainedAdapterPath = join(root, 'adapter-retained.mjs')
  const markerPath = join(root, 'evil-marker'); const receiptPath = join(root, 'receipt.json')
  const expectedArtifactBytes = await Promise.all([artifact.tarballPath, artifact.sbomPath, artifact.provenancePath]
    .map(async path => (await readFile(path)).toString('base64')))
  const script = [
    '#!' + nodePath,
    "import { readFileSync, renameSync } from 'node:fs'",
    'const command = process.argv[2]',
    'const receiptPath = ' + JSON.stringify(receiptPath),
    "if (command === '--version') process.stdout.write('fixture-release-adapter-1\\n')",
    "else if (command === '--capabilities') {",
    ...(replaceDuringCapabilities ? [
      '  renameSync(' + JSON.stringify(adapterPath) + ', ' + JSON.stringify(retainedAdapterPath) + ')',
      '  renameSync(' + JSON.stringify(evilPath) + ', ' + JSON.stringify(adapterPath) + ')',
    ] : []),
    "  process.stdout.write('{\"schemaVersion\":1,\"artifactInput\":\"inherited-fd-v1\"}\\n')",
    "} else if (command === 'release') {",
    "  const names = ['DSH_RELEASE_TARBALL_FD', 'DSH_RELEASE_SBOM_FD', 'DSH_RELEASE_PROVENANCE_FD']",
    "  if (names.map(name => process.env[name]).join(',') !== '3,4,5') throw new Error('missing inherited artifact descriptors')",
    '  const expected = ' + JSON.stringify(expectedArtifactBytes),
    "  const actual = names.map(name => readFileSync(Number(process.env[name])).toString('base64'))",
    "  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('artifact descriptor bytes differ')",
    "  let input = ''",
    "  process.stdin.setEncoding('utf8')",
    "  process.stdin.on('data', chunk => { input += chunk })",
    "  process.stdin.on('end', () => { JSON.parse(input); process.stdout.write(readFileSync(receiptPath, 'utf8')) })",
    '} else process.exitCode = 2',
    '',
  ].join('\n')
  const evilScript = [
    '#!' + nodePath,
    "import { writeFileSync } from 'node:fs'",
    'writeFileSync(' + JSON.stringify(markerPath) + ", 'evil adapter executed\\n')",
    "process.stdout.write('evil adapter executed\\n')",
    '',
  ].join('\n')
  await writeFile(adapterPath, script, { mode: 0o700 }); await chmod(adapterPath, 0o700)
  await writeFile(evilPath, evilScript, { mode: 0o700 }); await chmod(evilPath, 0o700)
  const adapterSha256 = createHash('sha256').update(await readFile(adapterPath)).digest('hex')
  const adapterKeys = generateKeyPairSync('ed25519'); const ownerKeys = generateKeyPairSync('ed25519')
  const adapter = { id: 'fixture-publisher', version: 'fixture-release-adapter-1', path: adapterPath, sha256: adapterSha256,
    interpreter: { path: nodePath, sha256: nodeSha256 }, authority: 'release-publisher', keyId: 'publisher-key' }
  const policy: SourceReleasePolicy = { ...releasePolicy, registryLocator: 'https://registry.example.test', catalogPath }
  const uncheckedPlan = sourcePlan({ status: 'awaiting-publish' })
  const authorizationAuthority = new Ed25519SourceReleaseAuthorizationAuthority(
    publicKeyPem(ownerKeys.publicKey), 'release-owner', 'release-owner-key', () => now,
  )
  const authorization = await authorizationAuthority.verify(
    signedAuthorization(uncheckedPlan, ownerKeys.privateKey, { releasePolicy: policy }), uncheckedPlan,
  )
  const plan: PluginSourcePlan = { ...uncheckedPlan, releaseAuthorization: authorization,
    release: { id: 'release-1', fence: 1, updatedAt: now } }
  const artifactSignature = sign(null, Buffer.from(sourceArtifactSigningPayload(artifact)), adapterKeys.privateKey).toString('base64')
  const request = parseSourceReleaseRequest({
    schemaVersion: 1,
    kind: 'dsh-source-release-request',
    operationId: 'invoke-publish-operation-1',
    attempt: 1,
    requestedAt: now,
    receiptTtlMs: 10_000,
    installationId,
    ledger: { id: 'ledger-1', path: join(root, 'ledger.sqlite') },
    plan: { id: plan.id, digest: plan.digest, revision: plan.revision },
    release: { id: plan.release!.id, fence: plan.release!.fence },
    authorization,
    adapter,
    registry: { id: policy.registryId, locator: policy.registryLocator },
    catalog: { id: policy.catalogId, path: policy.catalogPath },
    phase: 'publish',
    input: { artifact, artifactStatementDigest: sourceArtifactStatementDigest(artifact), artifactSignature,
      signEvidenceDigest: digest('d') },
  }) as Extract<SourceReleaseRequest, { phase: 'publish' }>
  const evidence: Extract<SourceReleaseSuccessEvidence, { kind: 'publish' }> = {
    kind: 'publish',
    registryId: request.registry.id,
    registryReference: policy.registryReference,
    packageName: artifact.packageName,
    packageVersion: artifact.packageVersion,
    tarballSha256: artifact.tarballSha256,
    tarballIntegrity: artifact.tarballIntegrity,
    artifactStatementDigest: request.input.artifactStatementDigest,
    artifactSignatureDigest: signatureDigest(request.input.artifactSignature),
    signEvidenceDigest: request.input.signEvidenceDigest,
    immutable: true,
  }
  const receipt = signedReceipt(request, evidence, adapterKeys.privateKey)
  await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 })
  const distinctKey = (authority: string, keyId: string) => { const pair = generateKeyPairSync('ed25519'); return {
    authority, keyId, publicKeyPem: publicKeyPem(pair.publicKey),
  } }
  const trustPath = join(root, 'trust.json')
  const phases = ['pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission'] as const
  const rawTrust = {
    schemaVersion: 4,
    installationId,
    dshHome,
    ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01', path: join(root, 'ledger.sqlite') },
    executor: { id: 'node', version: '1.0.0', path: nodePath, sha256: nodeSha256, environmentAllowlist: [] },
    hostPolicy: defaultHostAttestationPolicy,
    hostAttestor: null,
    catalog: { id: policy.catalogId, path: catalogPath },
    releaseRegistry: { id: policy.registryId, locator: policy.registryLocator },
    releaseReceiptTtlMs: 10_000,
    releaseAdapters: Object.fromEntries(phases.map(phase => [phase, phase === 'publish'
      ? { ...adapter, environmentAllowlist: [], timeoutMs: 10_000 } : null])),
    approvalKeys: [distinctKey('owner-policy', 'approval-key')],
    hostAttestationKeys: [distinctKey('host-attestor', 'host-key')],
    releaseKeys: [{ authority: adapter.authority, keyId: adapter.keyId, publicKeyPem: publicKeyPem(adapterKeys.publicKey) }],
    releaseAuthorizationKeys: [{ authority: authorization.authority, keyId: authorization.keyId, publicKeyPem: publicKeyPem(ownerKeys.publicKey) }],
  }
  await writeFile(trustPath, JSON.stringify(rawTrust), { mode: 0o600 }); await chmod(trustPath, 0o600)
  return { trust: await loadTrustConfig(trustPath), request, receipt, markerPath }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
afterAll(async () => { if (cachedInterpreterRoot !== undefined) await rm(cachedInterpreterRoot, { recursive: true, force: true }) })

describe('descriptor-pinned release adapter invocation', () => {
  test.runIf(process.platform === 'linux')('executes an artifact phase through pinned script, interpreter, and inherited FDs', async () => {
    const fixture = await realAdapterInvocationFixture()

    await expect(invokeSourceReleaseAdapter(fixture.trust, fixture.request)).resolves.toEqual(fixture.receipt)
    await expect(readFile(fixture.markerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test.runIf(process.platform === 'linux')('rejects an adapter pathname swap without ever executing the evil inode', async () => {
    const fixture = await realAdapterInvocationFixture(true)

    await expect(invokeSourceReleaseAdapter(fixture.trust, fixture.request)).rejects.toMatchObject({
      name: 'ReleaseAdapterError',
      code: 'EXECUTABLE_CHANGED',
      phase: 'publish',
    })
    await expect(readFile(fixture.markerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('post-check source release authorization', () => {
  test('accepts a fresh Ed25519 owner authorization bound to exact checked bytes', async () => {
    const plan = sourcePlan(); const keys = generateKeyPairSync('ed25519')
    const input = signedAuthorization(plan, keys.privateKey)
    const authority = new Ed25519SourceReleaseAuthorizationAuthority(
      publicKeyPem(keys.publicKey), 'release-owner', 'release-owner-key', () => now,
    )

    const verified = await authority.verify(input, plan)

    expect(verified).toMatchObject({
      planId: plan.id,
      checkedTreeDigest: plan.sourceCheck?.treeDigest,
      checkedPatchDigest: plan.sourceCheck?.patchDigest,
      releasePolicy,
    })
    expect(verified.signatureDigest).toBe(signatureDigest(input.signature))
    expect(Object.isFrozen(verified)).toBe(true)
  })

  test('fails closed on changed tree, patch, scope, or candidate policy even when re-signed', async () => {
    const plan = sourcePlan(); const keys = generateKeyPairSync('ed25519')
    const authority = new Ed25519SourceReleaseAuthorizationAuthority(
      publicKeyPem(keys.publicKey), 'release-owner', 'release-owner-key', () => now,
    )
    const cases: readonly [string, Partial<Omit<SourceReleaseAuthorization, 'signature'>>][] = [
      ['tree', { checkedTreeDigest: digest('a') }],
      ['patch', { checkedPatchDigest: digest('b') }],
      ['scope', { scope: ['plugins/other-helper'] }],
      ['policy', { releasePolicy: { ...releasePolicy, candidateId: 'other-helper' } }],
    ]

    for (const [label, changed] of cases) {
      await expect(authority.verify(signedAuthorization(plan, keys.privateKey, changed), plan), label)
        .rejects.toThrow('not bound to the exact checked source plan and policy')
    }
  })

  test('rejects expired, wrong-key, and non-canonical signatures', async () => {
    const plan = sourcePlan(); const keys = generateKeyPairSync('ed25519'); const wrongKeys = generateKeyPairSync('ed25519')
    const authority = new Ed25519SourceReleaseAuthorizationAuthority(
      publicKeyPem(keys.publicKey), 'release-owner', 'release-owner-key', () => now,
    )
    await expect(authority.verify(signedAuthorization(plan, keys.privateKey, { expiresAt: now - 1 }), plan))
      .rejects.toThrow('outside its post-check validity interval')
    await expect(authority.verify(signedAuthorization(plan, wrongKeys.privateKey), plan))
      .rejects.toThrow('release authorization signature is invalid')

    const canonical = signedAuthorization(plan, keys.privateKey)
    const nonCanonical = { ...canonical, signature: canonical.signature.replace(/=+$/u, '') }
    await expect(authority.verify(nonCanonical, plan)).rejects.toThrow('canonical Ed25519 signature')
  })
})

describe('strict source release request parsing', () => {
  test('binds a PR to the authorized base, scope, tree, patch, and candidate', async () => {
    const fixture = await verifiedAuthorizationFixture(); const request = prRequest(fixture.plan, fixture.authorization)
    expect(parseSourceReleaseRequest(request)).toEqual(request)

    const changedInputs = [
      { ...request.input, baseCommit: commit('f') },
      { ...request.input, name: 'other-helper' },
      { ...request.input, scope: ['plugins/other-helper'] },
      { ...request.input, expectedTreeDigest: digest('a') },
      { ...request.input, expectedPatchDigest: digest('b') },
    ]
    for (const input of changedInputs) {
      expect(() => parseSourceReleaseRequest({ ...request, input })).toThrow('PR request does not bind the authorized checked source')
    }
  })

  test('rejects unknown fields at both request and phase-input boundaries', async () => {
    const fixture = await verifiedAuthorizationFixture(); const request = prRequest(fixture.plan, fixture.authorization)
    expect(() => parseSourceReleaseRequest({ ...request, unexpected: true })).toThrow('unknown or missing fields')
    expect(() => parseSourceReleaseRequest({ ...request, input: { ...request.input, unexpected: true } })).toThrow('unknown or missing fields')
  })

  test('strictly parses the nested registry verification receipt and evidence', async () => {
    const fixture = await catalogAdmissionFixture()
    expect(parseSourceReleaseRequest(fixture.request)).toEqual(fixture.request)
    expect(parseSourceReleaseReceipt(fixture.request.input.registryVerificationReceipt))
      .toEqual(fixture.request.input.registryVerificationReceipt)

    const nested = fixture.request.input.registryVerificationReceipt
    expect(() => parseSourceReleaseRequest({ ...fixture.request, input: { ...fixture.request.input,
      registryVerificationReceipt: { ...nested, unexpected: true },
    } })).toThrow('source release receipt has unknown or missing fields')
    expect(() => parseSourceReleaseRequest({ ...fixture.request, input: { ...fixture.request.input,
      registryVerificationReceipt: { ...nested, evidence: { ...nested.evidence, unexpected: true } },
    } })).toThrow('registry verification evidence has unknown or missing fields')

    const nestedRequest = fixture.request.input.registryVerificationRequest
    expect(() => parseSourceReleaseRequest({ ...fixture.request, input: { ...fixture.request.input,
      registryVerificationRequest: { ...nestedRequest, unexpected: true },
    } })).toThrow('source release request has unknown or missing fields')
    expect(() => parseSourceReleaseRequest({ ...fixture.request, input: { ...fixture.request.input,
      registryVerificationRequest: { ...nestedRequest, input: { ...nestedRequest.input, unexpected: true } },
    } })).toThrow('registry verification request input has unknown or missing fields')
  })

  test('binds the nested receipt request digest to the exact prior registry request', async () => {
    const fixture = await catalogAdmissionFixture()
    const originalRequest = fixture.request.input.registryVerificationRequest
    const originalReceipt = fixture.request.input.registryVerificationReceipt
    const expectRejected = (registryVerificationRequest: typeof originalRequest, registryVerificationReceipt = originalReceipt) =>
      expect(() => parseSourceReleaseRequest({ ...fixture.request, input: { ...fixture.request.input,
        registryVerificationRequest, registryVerificationReceipt,
      } })).toThrow('catalog admission registry verification receipt does not bind the exact request, release fence, and signed artifact')

    const changedPublishDigest = { ...originalRequest, input: { ...originalRequest.input, publishEvidenceDigest: digest('f') } }
    expectRejected(changedPublishDigest)

    const wrongRequestDigest = resignReceipt(originalReceipt, fixture.registryKeys.privateKey, { requestDigest: digest('0') })
    expectRejected(originalRequest, wrongRequestDigest)

    const skippedRevision = { ...originalRequest, plan: { ...originalRequest.plan, revision: originalRequest.plan.revision - 1 } }
    const reboundReceipt = resignReceipt(originalReceipt, fixture.registryKeys.privateKey, {
      requestDigest: sourceReleaseRequestDigest(skippedRevision),
    })
    expectRejected(skippedRevision, reboundReceipt)
  })

  test('binds the nested receipt phase, outcome, plan, release fence, and exact signed artifact', async () => {
    const fixture = await catalogAdmissionFixture()
    const original = fixture.request.input.registryVerificationReceipt
    const registryEvidence = original.evidence as Extract<SourceReleaseSuccessEvidence, { kind: 'registry-verify' }>
    const failedEvidence = { kind: 'failure' as const, phase: 'registry-verify' as const, code: 'registry-unavailable',
      remoteState: 'unchanged' as const, detailDigest: digest('a') }
    const receipt = (overrides: Partial<Omit<SourceReleaseReceipt, 'signature'>>): SourceReleaseReceipt =>
      resignReceipt(original, fixture.registryKeys.privateKey, overrides)
    const withEvidence = (overrides: Partial<typeof registryEvidence>): SourceReleaseReceipt => {
      const evidence = { ...registryEvidence, ...overrides }
      return receipt({ evidence, evidenceDigest: sourceReleaseEvidenceDigest(evidence) })
    }
    const cases: readonly [string, SourceReleaseReceipt][] = [
      ['phase', receipt({ phase: 'publish' })],
      ['outcome', receipt({ outcome: 'failed', evidence: failedEvidence, evidenceDigest: sourceReleaseEvidenceDigest(failedEvidence) })],
      ['plan id', receipt({ planId: 'different-source-plan' })],
      ['plan digest', receipt({ planDigest: digest('b') })],
      ['release id', receipt({ releaseId: 'different-release' })],
      ['release fence', receipt({ fence: original.fence + 1 })],
      ['artifact bytes', withEvidence({ downloadedBytes: registryEvidence.downloadedBytes + 1 })],
      ['artifact sha256', withEvidence({ downloadedSha256: digest('c') })],
      ['artifact integrity', withEvidence({ downloadedIntegrity: `sha512-${Buffer.alloc(64, 10).toString('base64')}` })],
      ['artifact statement', withEvidence({ artifactStatementDigest: digest('d') })],
      ['artifact signature', withEvidence({ artifactSignatureDigest: digest('e') })],
    ]

    for (const [label, nested] of cases) {
      expect(() => parseSourceReleaseRequest({ ...fixture.request, input: { ...fixture.request.input,
        registryVerificationReceipt: nested, verificationEvidenceDigest: nested.evidenceDigest,
      } }), label).toThrow('catalog admission registry verification receipt does not bind the exact request, release fence, and signed artifact')
    }
  })
})

describe('Ed25519 source release receipt authority', () => {
  test('accepts exact PR lineage and rejects changed checked tree or patch evidence', async () => {
    const fixture = await verifiedAuthorizationFixture(); const request = prRequest(fixture.plan, fixture.authorization)
    const keys = generateKeyPairSync('ed25519'); const authority = releaseAuthority(keys)
    const evidence: Extract<SourceReleaseSuccessEvidence, { kind: 'pr' }> = {
      kind: 'pr',
      prId: 'pr-17',
      baseCommit: request.input.baseCommit,
      headCommit: commit('b'),
      treeDigest: request.input.expectedTreeDigest,
      patchDigest: request.input.expectedPatchDigest,
      repositoryDigest: digest('9'),
    }
    const verified = await authority.verify(signedReceipt(request, evidence, keys.privateKey), fixture.plan, request)
    expect(verified.signatureDigest).toMatch(/^[a-f0-9]{64}$/u)

    for (const changed of [
      { ...evidence, treeDigest: digest('a') },
      { ...evidence, patchDigest: digest('b') },
    ]) {
      await expect(authority.verify(signedReceipt(request, changed, keys.privateKey), fixture.plan, request))
        .rejects.toThrow('PR evidence does not bind the exact checked source')
    }
  })

  test('binds merge evidence to the exact review digest and target branch', async () => {
    const fixture = await verifiedAuthorizationFixture(); const request = mergeRequest(fixture.plan, fixture.authorization)
    const keys = generateKeyPairSync('ed25519'); const authority = releaseAuthority(keys)
    const evidence: Extract<SourceReleaseSuccessEvidence, { kind: 'merge' }> = {
      kind: 'merge',
      prId: request.input.prId,
      reviewedHeadCommit: request.input.headCommit,
      reviewId: request.input.reviewId,
      reviewEvidenceDigest: request.input.reviewEvidenceDigest,
      mergeCommit: commit('c'),
      targetBranch: request.input.targetBranch,
    }
    await expect(authority.verify(signedReceipt(request, evidence, keys.privateKey), fixture.plan, request)).resolves.toMatchObject({ phase: 'merge' })

    for (const changed of [
      { ...evidence, reviewEvidenceDigest: digest('a') },
      { ...evidence, targetBranch: 'release' },
    ]) {
      await expect(authority.verify(signedReceipt(request, changed, keys.privateKey), fixture.plan, request))
        .rejects.toThrow('merge evidence does not bind the exact review, head, and target branch')
    }
  })

  test('verifies reproducible build metadata against owner-safe artifact file descriptors', async () => {
    const fixture = await verifiedAuthorizationFixture(); const request = buildRequest(fixture.plan, fixture.authorization)
    const keys = generateKeyPairSync('ed25519'); const authority = releaseAuthority(keys); const artifact = await artifactFixture()
    const evidence: Extract<SourceReleaseSuccessEvidence, { kind: 'build' }> = {
      kind: 'build',
      isolated: true,
      reproducibleBuilds: 2,
      firstBuildSha256: artifact.tarballSha256,
      secondBuildSha256: artifact.tarballSha256,
      mergeEvidenceDigest: request.input.mergeEvidenceDigest,
      ...artifact,
    }
    const receipt = signedReceipt(request, evidence, keys.privateKey)
    await expect(authority.verify(receipt, fixture.plan, request)).resolves.toMatchObject({ phase: 'build' })

    const wrongCandidate = { ...evidence, candidateId: 'other-helper' }
    await expect(authority.verify(signedReceipt(request, wrongCandidate, keys.privateKey), fixture.plan, request))
      .rejects.toThrow('build is not reproducible or merge/candidate-bound')

    await chmod(artifact.tarballPath, 0o620)
    await expect(authority.verify(receipt, fixture.plan, request)).rejects.toThrow('artifact evidence file is unsafe')
    await chmod(artifact.tarballPath, 0o600)
    await writeFile(artifact.tarballPath, 'tampered tarball')
    await expect(authority.verify(receipt, fixture.plan, request)).rejects.toThrow('do not match signed evidence')
  })

  test('rejects a forged nested registry signature even when the catalog receipt is validly re-signed', async () => {
    const fixture = await catalogAdmissionFixture()
    const authority = new Ed25519SourceReleaseAuthority(
      publicKeyPem(fixture.catalogKeys.publicKey), fixture.request.adapter.authority, fixture.request.adapter.keyId, () => now + 100,
      (authority, keyId) => {
        expect([authority, keyId]).toEqual(['registry-verifier', 'registry-verifier-key'])
        return publicKeyPem(fixture.registryKeys.publicKey)
      },
    )
    await expect(authority.verify(fixture.receipt, fixture.plan, fixture.request)).resolves.toMatchObject({ phase: 'catalog-admission' })

    const attackerKeys = generateKeyPairSync('ed25519')
    const forgedRegistryReceipt = resignReceipt(
      fixture.request.input.registryVerificationReceipt, attackerKeys.privateKey,
    )
    const forgedRequest = parseSourceReleaseRequest({ ...fixture.request, input: { ...fixture.request.input,
      registryVerificationReceipt: forgedRegistryReceipt,
    } }) as Extract<SourceReleaseRequest, { phase: 'catalog-admission' }>
    const forgedCatalogReceipt = signedReceipt(forgedRequest, fixture.evidence, fixture.catalogKeys.privateKey)

    await expect(authority.verify(forgedCatalogReceipt, fixture.plan, forgedRequest))
      .rejects.toThrow('catalog admission registry verification receipt signature is invalid')
  })

  test('accepts a historical registry receipt that expired after its valid interval but before catalog admission', async () => {
    const fixture = await catalogAdmissionFixture()
    const catalogRequestedAt = fixture.request.input.registryVerificationReceipt.expiresAt + 1_000
    const request = parseSourceReleaseRequest({ ...fixture.request, requestedAt: catalogRequestedAt }) as Extract<
      SourceReleaseRequest, { phase: 'catalog-admission' }
    >
    const receipt = resignReceipt(signedReceipt(request, fixture.evidence, fixture.catalogKeys.privateKey), fixture.catalogKeys.privateKey, {
      observedAt: catalogRequestedAt, expiresAt: catalogRequestedAt + 5_000,
    })
    const authority = new Ed25519SourceReleaseAuthority(
      publicKeyPem(fixture.catalogKeys.publicKey), request.adapter.authority, request.adapter.keyId, () => catalogRequestedAt + 100,
      () => publicKeyPem(fixture.registryKeys.publicKey),
    )

    expect(fixture.request.input.registryVerificationReceipt.expiresAt).toBeLessThan(catalogRequestedAt)
    await expect(authority.verify(receipt, fixture.plan, request)).resolves.toMatchObject({ phase: 'catalog-admission' })
  })

  test('rejects a forged nested registry signature even when the outer catalog receipt reports failure', async () => {
    const fixture = await catalogAdmissionFixture()
    const attackerKeys = generateKeyPairSync('ed25519')
    const forgedRegistryReceipt = resignReceipt(
      fixture.request.input.registryVerificationReceipt, attackerKeys.privateKey,
    )
    const forgedRequest = parseSourceReleaseRequest({ ...fixture.request, input: { ...fixture.request.input,
      registryVerificationReceipt: forgedRegistryReceipt,
    } }) as Extract<SourceReleaseRequest, { phase: 'catalog-admission' }>
    const failureEvidence = { kind: 'failure' as const, phase: 'catalog-admission' as const, code: 'catalog-write-failed',
      remoteState: 'unchanged' as const, detailDigest: digest('f') }
    const failedReceipt = resignReceipt(signedReceipt(forgedRequest, fixture.evidence, fixture.catalogKeys.privateKey),
      fixture.catalogKeys.privateKey, { outcome: 'failed', evidence: failureEvidence,
        evidenceDigest: sourceReleaseEvidenceDigest(failureEvidence) })
    const authority = new Ed25519SourceReleaseAuthority(
      publicKeyPem(fixture.catalogKeys.publicKey), forgedRequest.adapter.authority, forgedRequest.adapter.keyId, () => now + 100,
      () => publicKeyPem(fixture.registryKeys.publicKey),
    )

    await expect(authority.verify(failedReceipt, fixture.plan, forgedRequest))
      .rejects.toThrow('catalog admission registry verification receipt signature is invalid')
  })
})

describe('signed publish reconciliation protocol', () => {
  test('parses and verifies an exact exists-match observation', async () => {
    const fixture = await verifiedAuthorizationFixture()
    const request = reconciliationRequest(fixture.plan, fixture.authorization)
    const keys = generateKeyPairSync('ed25519')
    const authority = new Ed25519SourcePublishReconciliationAuthority(
      publicKeyPem(keys.publicKey), request.adapter.authority, request.adapter.keyId, () => now + 100,
    )
    const evidence = matchingReconciliationEvidence(request)
    const receipt = signedReconciliationReceipt(request, evidence, keys.privateKey)

    expect(parseSourcePublishReconciliationRequest(request)).toEqual(request)
    expect(parseSourcePublishReconciliationReceipt(receipt)).toEqual(receipt)
    await expect(authority.verify(receipt, fixture.plan, request)).resolves.toMatchObject({
      receiptId: receipt.receiptId,
      evidence: { outcome: 'exists-match', registryReference: request.expectedRegistryReference },
      signatureDigest: signatureDigest(receipt.signature),
    })
  })

  test('rejects tampered ambiguous-publish receipt and evidence digests', async () => {
    const fixture = await verifiedAuthorizationFixture()
    const request = reconciliationRequest(fixture.plan, fixture.authorization)
    const keys = generateKeyPairSync('ed25519')
    const authority = new Ed25519SourcePublishReconciliationAuthority(
      publicKeyPem(keys.publicKey), request.adapter.authority, request.adapter.keyId, () => now + 100,
    )
    const evidence = matchingReconciliationEvidence(request)
    const receipt = signedReconciliationReceipt(request, evidence, keys.privateKey)

    const changedReceiptDigest = parseSourcePublishReconciliationRequest({ ...request, ambiguousPublish: {
      ...request.ambiguousPublish, receiptDigest: digest('b'),
    } })
    await expect(authority.verify(receipt, fixture.plan, changedReceiptDigest))
      .rejects.toThrow('not bound to the exact ambiguous publish and artifact')

    const changedEvidenceDigest = parseSourcePublishReconciliationRequest({ ...request, ambiguousPublish: {
      ...request.ambiguousPublish, evidenceDigest: digest('c'),
    } })
    await expect(authority.verify(receipt, fixture.plan, changedEvidenceDigest))
      .rejects.toThrow('not bound to the exact ambiguous publish and artifact')

    const reboundEvidence = matchingReconciliationEvidence(request, { ambiguousPublishReceiptDigest: digest('d') })
    await expect(authority.verify(signedReconciliationReceipt(request, reboundEvidence, keys.privateKey), fixture.plan, request))
      .rejects.toThrow('not bound to the exact ambiguous publish and artifact')
  })

  test('rejects re-signed expected artifact digests and registry reference that diverge from the request', async () => {
    const fixture = await verifiedAuthorizationFixture()
    const request = reconciliationRequest(fixture.plan, fixture.authorization)
    const keys = generateKeyPairSync('ed25519')
    const authority = new Ed25519SourcePublishReconciliationAuthority(
      publicKeyPem(keys.publicKey), request.adapter.authority, request.adapter.keyId, () => now + 100,
    )
    const changedIntegrity = `sha512-${Buffer.alloc(64, 10).toString('base64')}`
    const cases: readonly SourcePublishReconciliationEvidence[] = [
      matchingReconciliationEvidence(request, { expectedTarballSha256: digest('b'), observedTarballSha256: digest('b') }),
      matchingReconciliationEvidence(request, { expectedTarballIntegrity: changedIntegrity, observedTarballIntegrity: changedIntegrity }),
      matchingReconciliationEvidence(request, { registryReference: '@dsh-enhanced/health-helper@9.9.9' }),
    ]

    for (const evidence of cases) {
      await expect(authority.verify(signedReconciliationReceipt(request, evidence, keys.privateKey), fixture.plan, request))
        .rejects.toThrow('not bound to the exact ambiguous publish and artifact')
    }
  })

  test('rejects contradictory outcome semantics before trusting the signature', async () => {
    const fixture = await verifiedAuthorizationFixture()
    const request = reconciliationRequest(fixture.plan, fixture.authorization)
    const keys = generateKeyPairSync('ed25519')
    const authority = new Ed25519SourcePublishReconciliationAuthority(
      publicKeyPem(keys.publicKey), request.adapter.authority, request.adapter.keyId, () => now + 100,
    )
    const cases: readonly [SourcePublishReconciliationEvidence, string][] = [
      [matchingReconciliationEvidence(request, { observedTarballSha256: digest('b') }),
        'exists-match reconciliation does not prove the exact artifact'],
      [matchingReconciliationEvidence(request, { outcome: 'absent', registryReference: null, observedTarballIntegrity: null,
        observedArtifactStatementDigest: null, observedArtifactSignatureDigest: null }),
        'absent reconciliation contains observed registry state'],
      [matchingReconciliationEvidence(request, { outcome: 'digest-conflict' }),
        'digest-conflict reconciliation does not prove a conflicting artifact'],
    ]

    for (const [evidence, message] of cases) {
      const receipt = signedReconciliationReceipt(request, evidence, keys.privateKey)
      expect(() => parseSourcePublishReconciliationReceipt(receipt)).toThrow(message)
      await expect(authority.verify(receipt, fixture.plan, request)).rejects.toThrow(message)
    }
  })

  test('rejects unknown request, receipt, and evidence fields', async () => {
    const fixture = await verifiedAuthorizationFixture()
    const request = reconciliationRequest(fixture.plan, fixture.authorization)
    const keys = generateKeyPairSync('ed25519')
    const receipt = signedReconciliationReceipt(request, matchingReconciliationEvidence(request), keys.privateKey)

    expect(() => parseSourcePublishReconciliationRequest({ ...request, unexpected: true }))
      .toThrow('source publish reconciliation request has unknown or missing fields')
    expect(() => parseSourcePublishReconciliationReceipt({ ...receipt, unexpected: true }))
      .toThrow('source publish reconciliation receipt has unknown or missing fields')
    expect(() => parseSourcePublishReconciliationReceipt({ ...receipt, evidence: { ...receipt.evidence, unexpected: true } }))
      .toThrow('source publish reconciliation evidence has unknown or missing fields')
  })
})

interface TrustKeyFixture {
  authority: string
  keyId: string
  publicKeyPem: string
}

async function trustFixture() {
  const root = await mkdtemp(join(tmpdir(), 'plugin-release-trust-')); roots.push(root); await chmod(root, 0o700)
  const dshHome = join(root, 'dsh-home'); await mkdir(dshHome, { mode: 0o700 })
  const executorPath = join(root, 'executor'); const executorBytes = Buffer.from('native executor fixture')
  await writeFile(executorPath, executorBytes, { mode: 0o700 }); await chmod(executorPath, 0o700)
  const catalogPath = join(root, 'catalog.json'); await writeFile(catalogPath, '{"schemaVersion":1,"entries":[]}', { mode: 0o600 })
  const trustPath = join(root, 'trust.json')
  const key = (authority: string, keyId: string): TrustKeyFixture => {
    const pair = generateKeyPairSync('ed25519')
    return { authority, keyId, publicKeyPem: publicKeyPem(pair.publicKey) }
  }
  const approvalKey = key('owner-policy', 'owner-key')
  const hostKey = key('host-attestor', 'host-key')
  const releaseKey = key('release-adapter', 'release-key')
  const authorizationKey = key('release-owner', 'authorization-key')
  const phases = ['pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission'] as const
  const config = {
    schemaVersion: 4,
    installationId,
    dshHome,
    ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01', path: join(root, 'ledger.sqlite') },
    executor: { id: 'fixture-executor', version: '1.0.0', path: executorPath,
      sha256: createHash('sha256').update(executorBytes).digest('hex'), environmentAllowlist: [] },
    hostPolicy: defaultHostAttestationPolicy,
    hostAttestor: null,
    catalog: { id: releasePolicy.catalogId, path: catalogPath },
    releaseRegistry: { id: releasePolicy.registryId, locator: 'https://registry.example.test' },
    releaseReceiptTtlMs: 30_000,
    releaseAdapters: Object.fromEntries(phases.map(phase => [phase, null])),
    approvalKeys: [approvalKey],
    hostAttestationKeys: [hostKey],
    releaseKeys: [releaseKey],
    releaseAuthorizationKeys: [authorizationKey],
  }
  const write = async (value: unknown): Promise<void> => {
    await writeFile(trustPath, `${JSON.stringify(value)}\n`, { mode: 0o600 }); await chmod(trustPath, 0o600)
  }
  await write(config)
  return { root, trustPath, config, approvalKey, releaseKey, authorizationKey, write }
}

async function adapterFixture(root: string, role: string) {
  const path = join(root, `adapter-${role}`); const bytes = Buffer.from(`native ${role} adapter`)
  await writeFile(path, bytes, { mode: 0o700 }); await chmod(path, 0o700)
  const pair = generateKeyPairSync('ed25519')
  const authority = `${role}-authority`; const keyId = `${role}-key`
  return {
    key: { authority, keyId, publicKeyPem: publicKeyPem(pair.publicKey) },
    adapter: { id: `adapter-${role}`, version: '1.0.0', path, sha256: createHash('sha256').update(bytes).digest('hex'),
      interpreter: null, environmentAllowlist: [], authority, keyId, timeoutMs: 10_000 },
  }
}

async function scriptAdapterFixture(root: string, role: string, interpreter: { path: string; sha256: string }) {
  const path = join(root, `script-adapter-${role}.mjs`)
  const source = await readFile(new URL('../bin/dsh-local-release-adapter.js', import.meta.url), 'utf8')
  const bytes = Buffer.from(source.replace(/^#![^\n]*/u, `#!${interpreter.path}`))
  await writeFile(path, bytes, { mode: 0o700 }); await chmod(path, 0o700)
  const pair = generateKeyPairSync('ed25519'); const authority = `${role}-authority`; const keyId = `${role}-key`
  return { key: { authority, keyId, publicKeyPem: publicKeyPem(pair.publicKey) }, adapter: { id: `adapter-${role}`, version: '1.0.0',
    path, sha256: createHash('sha256').update(bytes).digest('hex'), interpreter, environmentAllowlist: [], authority, keyId, timeoutMs: 10_000 } }
}

describe('schema 4 release trust separation', () => {
  test('keeps authorization keys distinct from approval and adapter-receipt keys by identity and fingerprint', async () => {
    const fixture = await trustFixture()
    const loaded = await loadTrustConfig(fixture.trustPath)
    expect(resolveTrustKey(loaded, 'release-authorization', fixture.authorizationKey.authority, fixture.authorizationKey.keyId))
      .toMatchObject({ authority: fixture.authorizationKey.authority, keyId: fixture.authorizationKey.keyId,
        publicKeyPem: fixture.authorizationKey.publicKeyPem.trim() })
    expect(() => resolveTrustKey(loaded, 'approval', fixture.authorizationKey.authority, fixture.authorizationKey.keyId))
      .toThrow('approval authority/key is not pre-registered')

    const distinctPair = generateKeyPairSync('ed25519')
    const failures: readonly [TrustKeyFixture, string][] = [
      [{ authority: fixture.approvalKey.authority, keyId: fixture.approvalKey.keyId, publicKeyPem: publicKeyPem(distinctPair.publicKey) },
        'release authorization and source approval keys'],
      [{ authority: 'aliased-approval', keyId: 'aliased-approval-key', publicKeyPem: fixture.approvalKey.publicKeyPem },
        'release authorization and source approval keys'],
      [{ authority: fixture.releaseKey.authority, keyId: fixture.releaseKey.keyId, publicKeyPem: publicKeyPem(distinctPair.publicKey) },
        'release authorization and adapter receipt keys'],
      [{ authority: 'aliased-release', keyId: 'aliased-release-key', publicKeyPem: fixture.releaseKey.publicKeyPem },
        'release authorization and adapter receipt keys'],
    ]
    for (const [releaseAuthorizationKey, message] of failures) {
      await fixture.write({ ...fixture.config, releaseAuthorizationKeys: [releaseAuthorizationKey] })
      await expect(loadTrustConfig(fixture.trustPath)).rejects.toThrow(message)
    }
  })

  test('requires signer, publisher, and catalog admission to use independent executable and signing roles', async () => {
    const fixture = await trustFixture()
    const signer = await adapterFixture(fixture.root, 'signer')
    const publisher = await adapterFixture(fixture.root, 'publisher')
    const catalog = await adapterFixture(fixture.root, 'catalog')
    const adapters = {
      ...fixture.config.releaseAdapters,
      sign: signer.adapter,
      publish: publisher.adapter,
      'catalog-admission': catalog.adapter,
    }
    const config = { ...fixture.config, releaseKeys: [signer.key, publisher.key, catalog.key], releaseAdapters: adapters }
    await fixture.write(config)
    await expect(loadTrustConfig(fixture.trustPath)).resolves.toMatchObject({
      releaseAdapters: {
        sign: { authority: signer.adapter.authority },
        publish: { authority: publisher.adapter.authority },
        'catalog-admission': { authority: catalog.adapter.authority },
      },
    })

    const failures = [
      [{ ...adapters, publish: signer.adapter }, 'sign and publish release adapters'],
      [{ ...adapters, 'catalog-admission': publisher.adapter }, 'publish and catalog-admission release adapters'],
      [{ ...adapters, 'catalog-admission': signer.adapter }, 'sign and catalog-admission release adapters'],
    ] as const
    for (const [releaseAdapters, message] of failures) {
      await fixture.write({ ...config, releaseAdapters })
      await expect(loadTrustConfig(fixture.trustPath)).rejects.toThrow(message)
    }
  })

  test('requires every configured release role pair to have independent executable and key identities', async () => {
    const fixture = await trustFixture()
    const phases = ['pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission'] as const
    const roles = await Promise.all(phases.map(phase => adapterFixture(fixture.root, `all-${phase}`)))
    const releaseAdapters = Object.fromEntries(phases.map((phase, index) => [phase, roles[index]!.adapter]))
    const config = { ...fixture.config, releaseAdapters, releaseKeys: roles.map(role => role.key) }
    await fixture.write(config)
    await expect(loadTrustConfig(fixture.trustPath)).resolves.toMatchObject({
      releaseAdapters: Object.fromEntries(phases.map((phase, index) => [phase, { authority: roles[index]!.adapter.authority }])),
    })

    let pairs = 0
    for (let left = 0; left < phases.length; left += 1) {
      for (let right = left + 1; right < phases.length; right += 1) {
        pairs += 1
        await fixture.write({ ...config, releaseAdapters: { ...releaseAdapters, [phases[right]!]: roles[left]!.adapter } })
        await expect(loadTrustConfig(fixture.trustPath)).rejects.toThrow(
          `${phases[left]} and ${phases[right]} release adapters must use independent executable and signing authority/key`,
        )
      }
    }
    expect(pairs).toBe(28)
  })

  test('loads eight real script adapter copies while sharing one pinned runtime interpreter', async () => {
    const fixture = await trustFixture(); const interpreter = await fixtureInterpreter()
    const phases = ['pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission'] as const
    const roles = await Promise.all(phases.map(phase => scriptAdapterFixture(fixture.root, `script-${phase}`, interpreter)))
    const config = { ...fixture.config, releaseAdapters: Object.fromEntries(phases.map((phase, index) => [phase, roles[index]!.adapter])),
      releaseKeys: roles.map(role => role.key) }
    await fixture.write(config)
    const loaded = await loadTrustConfig(fixture.trustPath)
    expect(Object.values(loaded.releaseAdapters ?? {})).toHaveLength(8)
    expect(new Set(Object.values(loaded.releaseAdapters ?? {}).map(adapter => adapter.interpreter?.path))).toEqual(new Set([interpreter.path]))
  })
})
