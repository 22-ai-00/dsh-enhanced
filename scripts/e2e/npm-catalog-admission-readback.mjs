// Anonymous npm verification followed by admission into a disposable owner catalog. Never publishes or activates.
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchRegistryArtifact } from '../../plugins/plugin-control-plane/lib/registry-fetch.js'
import { previewCatalogAdmission, loadCatalogWithMetadata } from '../../plugins/plugin-control-plane/lib/catalog.js'
import { Ed25519SourceReleaseAuthority, invokeSourceReleaseAdapter, parseSourceReleaseRequest,
  sourceArtifactSigningPayload, sourceArtifactStatementDigest, sourceReleaseAuthorizationSigningPayload } from '../../plugins/plugin-control-plane/lib/release.js'

if (process.env.DSH_NPM_CATALOG_LIVE !== '1') throw new Error('Set DSH_NPM_CATALOG_LIVE=1 for anonymous read-only npm verification')
const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: npm-catalog-admission-readback.mjs --output <new evidence.json>')
const repository = fileURLToPath(new URL('../../', import.meta.url)); const output = resolve(args[1])
const sha = value => createHash('sha256').update(value).digest('hex')
const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
const baselinePath = 'scripts/e2e/fixtures/npm-release-0.1.32.json'
const baselineBytes = execFileSync('git', ['show', `${baseCommit}:${baselinePath}`], { cwd: repository })
const baseline = JSON.parse(baselineBytes)
const approved = baseline.registry.results.find(item => item.name === '@dsh-enhanced/plugin-control-plane' && item.version === '0.1.32' && item.ok)
if (!approved) throw new Error('Committed approved npm artifact is missing')
const paths = ['plugins/plugin-control-plane/src/registry-fetch.ts', 'plugins/plugin-control-plane/lib/registry-fetch.js',
  'plugins/plugin-control-plane/src/release.ts', 'plugins/plugin-control-plane/lib/release.js',
  'plugins/plugin-control-plane/bin/dsh-npm-registry-adapter.js', 'scripts/e2e/npm-catalog-admission-readback.mjs',
  'plugins/plugin-control-plane/bin/dsh-local-release-adapter.js', 'plugins/plugin-control-plane/src/catalog.ts',
  'plugins/plugin-control-plane/lib/catalog.js', 'plugins/plugin-control-plane/src/catalog-interpreter.ts',
  'plugins/plugin-control-plane/lib/catalog-interpreter.js']
const runtimeDigests = Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(resolve(repository, path)))])))
const evidence = { schemaVersion: 1, kind: 'npm-catalog-admission-readback', baseCommit, startedAt: new Date().toISOString(), runtimeDigests,
  baseline: { path: baselinePath, sha256: sha(baselineBytes), packageName: approved.name, version: approved.version, integrity: approved.integrity },
  authority: 'anonymous HTTPS reads and temporary local catalog writes with disposable owner/signer/verifier/catalog identities', passed: false,
  limits: ['The authorization, signed artifact statement, SBOM and provenance are readback fixtures; they do not prove a real approved build or publication.',
    'Only registry metadata/tarball bytes are real external observations. The local catalog and authorization are disposable; expected integrity is historical committed evidence.',
    'No publish, install, production key use, Host activation, rollback, or WP16/WP18 completion is claimed.'] }
const root = await realpath(await mkdtemp(join(tmpdir(), 'npm-verifier-live-'))); await chmod(root, 0o700)
const prior = process.env.DSH_RELEASE_REGISTRY_VERIFY_CONFIG
const priorCatalog = process.env.DSH_RELEASE_CATALOG_ADMISSION_CONFIG
try {
  const registry = { id: 'npm-public', protocol: 'npm', locator: 'https://registry.npmjs.org/', caPins: [], tokenEnvironment: null }
  // Bootstrap expected artifact descriptors, independently checked against the historical SRI.
  const fetched = await fetchRegistryArtifact({ registry, packageName: approved.name, version: approved.version, expectedIntegrity: approved.integrity, timeoutMs: 30_000 }, {})
  const node = join(root, 'node'); await copyFile(await realpath(process.execPath), node); await chmod(node, 0o700)
  const interpreter = { path: node, sha256: sha(await readFile(node)) }
  const adapterPath = join(root, 'adapter.js'); await copyFile(resolve(repository, paths[4]), adapterPath); await chmod(adapterPath, 0o700)
  const helper = join(root, 'registry-fetch.js'); await copyFile(resolve(repository, paths[1]), helper); await chmod(helper, 0o600)
  const identity = async name => {
    const pair = generateKeyPairSync('ed25519'); const privateKeyPath = join(root, `${name}.key`); const publicKeyPath = join(root, `${name}.pub`)
    await writeFile(privateKeyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    await writeFile(publicKeyPath, pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 })
    return { ...pair, privateKeyPath, public: { authority: name, keyId: `${name}-key`, publicKeyPath } }
  }
  const owner = await identity('readback-owner'); const signer = await identity('readback-signer'); const verifier = await identity('readback-verifier')
  const stateRoot = join(root, 'state'); await mkdir(stateRoot, { mode: 0o700 })
  const config = { schemaVersion: 1, id: 'readback-verifier', phase: 'registry-verify', executablePath: adapterPath,
    authority: verifier.public.authority, keyId: verifier.public.keyId, privateKeyPath: verifier.privateKeyPath,
    authorizationAuthority: owner.public, stateRoot, registry: { protocol: 'npm', id: registry.id, locator: registry.locator,
      signer: signer.public, helper: { path: helper, sha256: sha(await readFile(helper)) }, caPins: [], timeoutMs: 30_000 } }
  const configPath = join(root, 'config.json'); await writeFile(configPath, JSON.stringify(config), { mode: 0o600 }); process.env.DSH_RELEASE_REGISTRY_VERIFY_CONFIG = configPath
  const auxiliary = Buffer.from('{"kind":"readback-fixture-not-build-provenance"}')
  const artifact = { sourceName: 'plugin-control-plane', candidateId: 'plugin-control-plane', packagePath: 'plugins/plugin-control-plane',
    packageName: approved.name, packageVersion: approved.version, tarballPath: join(root, 'package.tgz'), tarballBytes: fetched.bytes.length,
    tarballSha256: sha(fetched.bytes), tarballIntegrity: approved.integrity, sbomPath: join(root, 'sbom.json'), sbomSha256: sha(auxiliary),
    provenancePath: join(root, 'provenance.json'), provenanceSha256: sha(auxiliary), mergedCommit: baseline.sourceCommit,
    dshBaseline: '0.1.0', capabilities: ['readback'], authorities: ['anonymous-registry-read'], requires: [] }
  await writeFile(artifact.tarballPath, fetched.bytes, { mode: 0o600 }); await writeFile(artifact.sbomPath, auxiliary, { mode: 0o600 }); await writeFile(artifact.provenancePath, auxiliary, { mode: 0o600 })
  const catalogDirectory = join(root, 'catalog'); await mkdir(catalogDirectory, { mode: 0o700 })
  const now = Date.now(); const planId = 'readback-plan'; const planDigest = sha('disposable-readback-plan')
  const unsigned = { schemaVersion: 1, kind: 'dsh-source-release-authorization', authorizationId: 'readback-authorization',
    authority: owner.public.authority, keyId: owner.public.keyId, planId, planDigest, baseCommit: baseline.sourceCommit,
    checkedTreeDigest: sha('readback-tree-fixture'), checkedPatchDigest: sha('readback-patch-fixture'), scope: ['plugins/plugin-control-plane'],
    releasePolicy: { targetBranch: 'dev', candidateId: artifact.candidateId, packageName: artifact.packageName, packageVersion: artifact.packageVersion,
      packagePath: artifact.packagePath, dshBaseline: artifact.dshBaseline, capabilities: artifact.capabilities, authorities: artifact.authorities,
      requires: [], registryId: registry.id, registryLocator: registry.locator, registryReference: fetched.reference,
      catalogId: 'readback-catalog', catalogPath: join(catalogDirectory, 'catalog.json'), minimumReproducibleBuilds: 2 }, authorizedAt: now - 1_000, expiresAt: now + 120_000 }
  const signature = sign(null, Buffer.from(sourceReleaseAuthorizationSigningPayload(unsigned)), owner.privateKey).toString('base64')
  const authorization = { ...unsigned, signature, signatureDigest: sha(Buffer.from(signature, 'base64')) }
  const adapter = { id: config.id, version: 'dsh-npm-registry-adapter-1', path: adapterPath, sha256: sha(await readFile(adapterPath)), interpreter, authority: config.authority, keyId: config.keyId }
  const trust = { releaseAdapters: { 'registry-verify': { ...adapter, timeoutMs: 45_000, environmentAllowlist: ['DSH_RELEASE_REGISTRY_VERIFY_CONFIG'] } } }
  const common = { schemaVersion: 1, operationId: 'live-registry-verification', attempt: 1, requestedAt: now, receiptTtlMs: 60_000,
    installationId: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00', ledger: { id: 'readback-ledger', path: join(root, 'ledger.sqlite') },
    plan: { id: planId, digest: planDigest, revision: 7 }, release: { id: 'readback-release', fence: 1 }, authorization, adapter,
    registry: { id: registry.id, locator: registry.locator } }
  const artifactSignature = sign(null, Buffer.from(sourceArtifactSigningPayload(artifact)), signer.privateKey).toString('base64')
  const request = parseSourceReleaseRequest({ ...common, kind: 'dsh-source-release-request', phase: 'registry-verify',
    catalog: { id: unsigned.releasePolicy.catalogId, path: unsigned.releasePolicy.catalogPath }, input: { artifact,
      artifactStatementDigest: sourceArtifactStatementDigest(artifact), artifactSignature, registryReference: fetched.reference, publishEvidenceDigest: sha('publish-receipt-fixture') } })
  const plan = { ...common.plan, releaseAuthorization: authorization, release: common.release }
  const publicKey = verifier.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const receipt = await invokeSourceReleaseAdapter(trust, request)
  await new Ed25519SourceReleaseAuthority(publicKey, config.authority, config.keyId).verify(receipt, plan, request)
  if (receipt.outcome !== 'passed') throw new Error('Npm verification did not pass')
  const catalogRoot = join(root, 'catalog-role'); await mkdir(catalogRoot, { mode: 0o700 })
  const catalogIdentity = await identity('readback-catalog')
  const catalogExecutable = join(catalogRoot, 'adapter.js'); await copyFile(resolve(repository, paths[6]), catalogExecutable); await chmod(catalogExecutable, 0o700)
  const pin = async name => {
    const path = join(catalogRoot, name); await copyFile(resolve(repository, 'plugins/plugin-control-plane/lib', name), path); await chmod(path, 0o600)
    return { path, sha256: sha(await readFile(path)) }
  }
  const catalogPath = request.catalog.path; await writeFile(catalogPath, '{"schemaVersion":1,"entries":[]}', { mode: 0o600 })
  const catalogState = join(catalogRoot, 'state'); await mkdir(catalogState, { mode: 0o700 })
  const catalogConfig = { schemaVersion: 1, id: 'readback-catalog', phase: 'catalog-admission', executablePath: catalogExecutable,
    authority: catalogIdentity.public.authority, keyId: catalogIdentity.public.keyId, privateKeyPath: catalogIdentity.privateKeyPath,
    authorizationAuthority: owner.public, registryVerifier: verifier.public, stateRoot: catalogState,
    registry: { protocol: 'npm', id: registry.id, locator: registry.locator, signer: signer.public },
    catalog: { ...request.catalog, helper: await pin('catalog.js'), interpreterModule: await pin('catalog-interpreter.js') } }
  const catalogConfigPath = join(catalogRoot, 'config.json'); await writeFile(catalogConfigPath, JSON.stringify(catalogConfig), { mode: 0o600 })
  process.env.DSH_RELEASE_CATALOG_ADMISSION_CONFIG = catalogConfigPath
  const catalogAdapter = { id: catalogConfig.id, version: 'dsh-local-release-adapter-1', path: catalogExecutable,
    sha256: sha(await readFile(catalogExecutable)), interpreter, authority: catalogConfig.authority, keyId: catalogConfig.keyId }
  const candidate = { id: artifact.candidateId, package: artifact.packageName, version: artifact.packageVersion, integrity: artifact.tarballIntegrity,
    registry: { id: registry.id, locator: registry.locator, reference: fetched.reference }, requires: artifact.requires, dshBaseline: artifact.dshBaseline,
    capabilities: artifact.capabilities, authorities: artifact.authorities }
  const preview = previewCatalogAdmission({ schemaVersion: 1, entries: [] }, candidate)
  const catalogRequest = parseSourceReleaseRequest({ ...request, operationId: 'live-catalog-admission', phase: 'catalog-admission', requestedAt: Date.now(),
    plan: { ...request.plan, revision: request.plan.revision + 1 }, adapter: catalogAdapter, input: { artifact,
      artifactStatementDigest: request.input.artifactStatementDigest, artifactSignature, registryReference: fetched.reference,
      registryVerificationRequest: request, registryVerificationReceipt: receipt, verificationEvidenceDigest: receipt.evidenceDigest,
      expectedBeforeCatalogDigest: preview.beforeCatalogDigest, expectedAfterCatalogDigest: preview.afterCatalogDigest, candidate } })
  const catalogTrust = { releaseAdapters: { 'catalog-admission': { ...catalogAdapter, timeoutMs: 30_000, environmentAllowlist: ['DSH_RELEASE_CATALOG_ADMISSION_CONFIG'] } } }
  const catalogReceipt = await invokeSourceReleaseAdapter(catalogTrust, catalogRequest)
  const catalogPublicKey = catalogIdentity.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  await new Ed25519SourceReleaseAuthority(catalogPublicKey, catalogConfig.authority, catalogConfig.keyId, Date.now,
    (authority, keyId) => authority === config.authority && keyId === config.keyId ? publicKey : undefined)
    .verify(catalogReceipt, { ...plan, revision: catalogRequest.plan.revision }, catalogRequest)
  const admitted = await loadCatalogWithMetadata(catalogPath)
  if (catalogReceipt.outcome !== 'passed' || admitted.digest !== preview.afterCatalogDigest
    || JSON.stringify(admitted.catalog.entries) !== JSON.stringify(preview.catalog.entries)) throw new Error('Catalog readback differs from admitted artifact')
  const replay = await invokeSourceReleaseAdapter(catalogTrust, catalogRequest)
  if (JSON.stringify(replay) !== JSON.stringify(catalogReceipt)) throw new Error('Catalog replay differs from signed receipt')
  evidence.verifierPublicKey = publicKey; evidence.ownerPublicKey = owner.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  evidence.artifactSignerPublicKey = signer.publicKey.export({ type: 'spki', format: 'pem' }).toString(); evidence.catalogPublicKey = catalogPublicKey
  evidence.release = { request, receipt }; evidence.catalogAdmission = { request: catalogRequest, receipt: catalogReceipt,
    observedCatalog: admitted.catalog, observedDigest: admitted.digest, replayedSameReceipt: true }
  for (const path of paths) if (sha(await readFile(resolve(repository, path))) !== runtimeDigests[path]) throw new Error('Verifier code changed during readback')
  evidence.passed = true
} catch (error) { evidence.error = error instanceof Error ? error.message : 'readback failed'; process.exitCode = 1 }
finally {
  if (prior === undefined) delete process.env.DSH_RELEASE_REGISTRY_VERIFY_CONFIG; else process.env.DSH_RELEASE_REGISTRY_VERIFY_CONFIG = prior
  if (priorCatalog === undefined) delete process.env.DSH_RELEASE_CATALOG_ADMISSION_CONFIG; else process.env.DSH_RELEASE_CATALOG_ADMISSION_CONFIG = priorCatalog
  await rm(root, { recursive: true, force: true }); evidence.disposablePrivateStateRemoved = true
  evidence.finishedAt = new Date().toISOString(); await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  process.stdout.write(JSON.stringify({ passed: evidence.passed, output }) + '\n')
}
