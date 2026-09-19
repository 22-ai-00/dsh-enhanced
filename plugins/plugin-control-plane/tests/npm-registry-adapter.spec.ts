import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:https'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { startLocalHttpsRegistry } from '../src/registry-fetch.ts'
import { loadCatalogWithMetadata, previewCatalogAdmission } from '../src/catalog.ts'
import { Ed25519SourcePublishReconciliationAuthority, Ed25519SourceReleaseAuthority,
  invokeSourcePublishReconciliationAdapter, invokeSourceReleaseAdapter, parseSourcePublishReconciliationRequest,
  parseSourceReleaseRequest, sourceArtifactSigningPayload, sourceArtifactStatementDigest,
  sourceReleaseAuthorizationSigningPayload } from '../src/release.ts'
import type { PluginControlTrustConfig } from '../src/trust.ts'
import type { PluginSourcePlan, SourceReleaseArtifact } from '../src/types.ts'

const roots: string[] = []; const closes: (() => Promise<void>)[] = []
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const sri = (value: Buffer) => `sha512-${createHash('sha512').update(value).digest('base64')}`
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(closes.splice(0).map(close => close())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(mode: 'match' | 'conflict' | 'missing' | 'slow' = 'match') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'npm-release-verifier-'))); roots.push(root); await chmod(root, 0o700)
  const native = await realpath(process.execPath); const node = join(root, 'node'); await copyFile(native, node); await chmod(node, 0o700)
  const interpreter = { path: node, sha256: sha(await readFile(node)) }
  const adapterPath = join(root, 'adapter.js'); await copyFile(new URL('../bin/dsh-npm-registry-adapter.js', import.meta.url), adapterPath); await chmod(adapterPath, 0o700)
  const helper = join(root, 'registry-fetch.mjs'); await copyFile(new URL('../lib/registry-fetch.js', import.meta.url), helper); await chmod(helper, 0o600)
  const identity = async (name: string) => {
    const pair = generateKeyPairSync('ed25519'); const publicKeyPath = join(root, `${name}.pub`); const privateKeyPath = join(root, `${name}.key`)
    await writeFile(publicKeyPath, pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 })
    await writeFile(privateKeyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    return { ...pair, privateKeyPath, public: { authority: name, keyId: `${name}-key`, publicKeyPath } }
  }
  const owner = await identity('owner'); const signer = await identity('artifact-signer'); const verifier = await identity('npm-verifier')
  const key = join(root, 'tls.key'); const cert = join(root, 'tls.pem'); const openssl = join(root, 'openssl.cnf')
  await writeFile(openssl, '[req]\nprompt=no\ndistinguished_name=subject\n[subject]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\n')
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-config', openssl, '-extensions', 'ext'], { stdio: 'ignore' })
  const bytes = Buffer.from('owner-signed-tarball'); const served = mode === 'conflict' ? Buffer.from('conflicting-npm-version') : bytes
  const seen: string[] = []
  const slow = { opened: false, closed: false }
  const tls = { key: await readFile(key, 'utf8'), cert: await readFile(cert, 'utf8') }
  const server: { origin: string; close: () => Promise<void> } = mode === 'slow' ? await (async () => {
    const nodeServer = createServer(tls, (request, response) => {
      seen.push(request.url!); slow.opened = true
      response.on('close', () => { slow.closed = true })
      response.writeHead(200, { 'content-type': 'application/json' }); response.flushHeaders()
    })
    await new Promise<void>(resolve => nodeServer.listen(0, '127.0.0.1', resolve))
    const address = nodeServer.address(); if (address === null || typeof address === 'string') throw new Error('missing test server address')
    return { origin: `https://127.0.0.1:${address.port}`, close: async () => {
      nodeServer.closeAllConnections(); await new Promise<void>(resolve => nodeServer.close(() => resolve()))
    } }
  })() : await startLocalHttpsRegistry({ ...tls, handle(request) {
    seen.push(request.path)
    if (mode === 'missing') return { status: 404 }
    if (request.path === '/%40dsh-enhanced%2Fhealth-helper/1.2.3') return { status: 200, bytes: Buffer.from(JSON.stringify({ name: '@dsh-enhanced/health-helper', version: '1.2.3',
      dist: { integrity: sri(served), tarball: `${server.origin}/package.tgz` } })) }
    if (request.path === '/package.tgz') return { status: 200, bytes: served }
    return { status: 404 }
  } }); closes.push(server.close)
  const stateRoot = join(root, 'state'); await mkdir(stateRoot, { mode: 0o700 })
  const config = { schemaVersion: 1, id: 'npm-verifier', phase: 'registry-verify', executablePath: adapterPath,
    authority: verifier.public.authority, keyId: verifier.public.keyId, privateKeyPath: verifier.privateKeyPath,
    authorizationAuthority: owner.public, stateRoot, registry: { protocol: 'npm', id: 'npm', locator: `${server.origin}/`,
      signer: signer.public, helper: { path: helper, sha256: sha(await readFile(helper)) },
      caPins: [await readFile(cert, 'utf8')], timeoutMs: 5_000 } }
  const configPath = join(root, 'config.json'); const saveConfig = () => writeFile(configPath, JSON.stringify(config), { mode: 0o600 }); await saveConfig()
  vi.stubEnv('DSH_RELEASE_REGISTRY_VERIFY_CONFIG', configPath)
  const artifact: SourceReleaseArtifact = { sourceName: 'health-helper', candidateId: 'health-helper', packagePath: 'plugins/health-helper',
    packageName: '@dsh-enhanced/health-helper', packageVersion: '1.2.3', tarballPath: join(root, 'package.tgz'), tarballBytes: bytes.length,
    tarballSha256: sha(bytes), tarballIntegrity: sri(bytes), sbomPath: join(root, 'sbom.json'), sbomSha256: sha('{}'),
    provenancePath: join(root, 'provenance.json'), provenanceSha256: sha('{"build":1}'), mergedCommit: 'a'.repeat(40),
    dshBaseline: '0.1.0', capabilities: ['health'], authorities: ['read-only: health'], requires: [] }
  await writeFile(artifact.tarballPath, bytes, { mode: 0o600 }); await writeFile(artifact.sbomPath, '{}', { mode: 0o600 }); await writeFile(artifact.provenancePath, '{"build":1}', { mode: 0o600 })
  const catalogDirectory = join(root, 'catalog'); await mkdir(catalogDirectory, { mode: 0o700 })
  const now = Date.now()
  const authorizationUnsigned = { schemaVersion: 1 as const, kind: 'dsh-source-release-authorization' as const, authorizationId: 'authorization-1',
    authority: owner.public.authority, keyId: owner.public.keyId, planId: 'plan-1', planDigest: 'b'.repeat(64), baseCommit: 'a'.repeat(40),
    checkedTreeDigest: 'c'.repeat(64), checkedPatchDigest: 'd'.repeat(64), scope: ['plugins/health-helper'],
    releasePolicy: { targetBranch: 'dev', candidateId: artifact.candidateId, packageName: artifact.packageName, packageVersion: artifact.packageVersion,
      packagePath: artifact.packagePath, dshBaseline: artifact.dshBaseline, capabilities: artifact.capabilities, authorities: artifact.authorities,
      requires: [], registryId: 'npm', registryLocator: config.registry.locator, registryReference: `${server.origin}/package.tgz`,
      catalogId: 'catalog-1', catalogPath: join(catalogDirectory, 'catalog.json'), minimumReproducibleBuilds: 2 }, authorizedAt: now - 1_000, expiresAt: now + 60_000 }
  const authorizationSignature = sign(null, Buffer.from(sourceReleaseAuthorizationSigningPayload(authorizationUnsigned)), owner.privateKey).toString('base64')
  const authorization = { ...authorizationUnsigned, signature: authorizationSignature, signatureDigest: sha(Buffer.from(authorizationSignature, 'base64')) }
  const adapter = { id: config.id, version: 'dsh-npm-registry-adapter-1', path: adapterPath, sha256: sha(await readFile(adapterPath)), interpreter,
    authority: config.authority, keyId: config.keyId }
  const trust = { releaseAdapters: { 'registry-verify': { ...adapter, timeoutMs: 15_000,
    environmentAllowlist: ['DSH_RELEASE_REGISTRY_VERIFY_CONFIG'] } } } as unknown as PluginControlTrustConfig
  const common = { schemaVersion: 1 as const, operationId: 'registry-operation-1', attempt: 1, requestedAt: now, receiptTtlMs: 30_000,
    installationId: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00', ledger: { id: 'ledger-1', path: join(root, 'ledger.sqlite') },
    plan: { id: 'plan-1', digest: authorization.planDigest, revision: 7 }, release: { id: 'release-1', fence: 1 }, authorization,
    adapter, registry: { id: 'npm', locator: config.registry.locator } }
  const signature = sign(null, Buffer.from(sourceArtifactSigningPayload(artifact)), signer.privateKey).toString('base64')
  const release = parseSourceReleaseRequest({ ...common, kind: 'dsh-source-release-request', phase: 'registry-verify',
    catalog: { id: 'catalog-1', path: authorization.releasePolicy.catalogPath }, input: { artifact, artifactStatementDigest: sourceArtifactStatementDigest(artifact),
      artifactSignature: signature, registryReference: authorization.releasePolicy.registryReference, publishEvidenceDigest: 'e'.repeat(64) } })
  const reconcile = parseSourcePublishReconciliationRequest({ ...common, kind: 'dsh-source-publish-reconciliation-request',
    ambiguousPublish: { operationId: 'publish-1', receiptId: 'publish-receipt-1', receiptDigest: '1'.repeat(64), evidenceDigest: '2'.repeat(64) },
    artifact: { packageName: artifact.packageName, packageVersion: artifact.packageVersion, tarballSha256: artifact.tarballSha256, tarballIntegrity: artifact.tarballIntegrity },
    expectedArtifactStatementDigest: sourceArtifactStatementDigest(artifact), expectedArtifactSignatureDigest: sha(Buffer.from(signature, 'base64')),
    expectedRegistryReference: authorization.releasePolicy.registryReference })
  const plan: PluginSourcePlan = { schemaVersion: 1, kind: 'source', id: 'plan-1', gapId: 'gap-1',
    gapSnapshot: { revision: 1, inputDigest: '3'.repeat(64), roi: 1, capability: 'health' }, status: 'publish-ambiguous', mode: 'create',
    digest: authorization.planDigest, revision: 7, releaseAuthorization: authorization, createdAt: now - 2_000, expiresAt: now + 60_000,
    repository: root, worktree: root, baseCommit: authorization.baseCommit, name: artifact.sourceName, generatorDigest: '4'.repeat(64),
    scope: authorization.scope, release: { id: 'release-1', fence: 1, updatedAt: now } }
  const publicPem = verifier.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  return { root, config, saveConfig, trust, release, reconcile, plan, publicPem, verifier, owner, signer, seen, artifact, authorization, slow }
}

async function catalogFixture() {
  const f = await fixture(); const verification = await invokeSourceReleaseAdapter(f.trust, f.release)
  if (f.release.phase !== 'registry-verify') throw new Error('missing verifier request')
  const root = join(f.root, 'catalog-role'); await mkdir(root, { mode: 0o700 })
  const key = generateKeyPairSync('ed25519'); const privateKeyPath = join(root, 'catalog.key')
  await writeFile(privateKeyPath, key.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const executablePath = join(root, 'adapter.js'); await copyFile(new URL('../bin/dsh-local-release-adapter.js', import.meta.url), executablePath); await chmod(executablePath, 0o700)
  const pin = async (name: string) => {
    const path = join(root, name); await copyFile(new URL(`../lib/${name}`, import.meta.url), path); await chmod(path, 0o600)
    return { path, sha256: sha(await readFile(path)) }
  }
  const catalogPath = f.release.catalog.path; await writeFile(catalogPath, '{"schemaVersion":1,"entries":[]}', { mode: 0o600 })
  const stateRoot = join(root, 'state'); await mkdir(stateRoot, { mode: 0o700 })
  const config = { schemaVersion: 1, id: 'npm-catalog', phase: 'catalog-admission', executablePath,
    authority: 'catalog-authority', keyId: 'catalog-key', privateKeyPath, authorizationAuthority: f.owner.public,
    registryVerifier: f.verifier.public, stateRoot,
    registry: { protocol: 'npm', id: f.release.registry.id, locator: f.release.registry.locator, signer: f.signer.public },
    catalog: { id: f.release.catalog.id, path: catalogPath, helper: await pin('catalog.js'), interpreterModule: await pin('catalog-interpreter.js') } }
  const configPath = join(root, 'config.json'); const save = () => writeFile(configPath, JSON.stringify(config), { mode: 0o600 }); await save()
  vi.stubEnv('DSH_RELEASE_CATALOG_ADMISSION_CONFIG', configPath)
  const adapter = { id: config.id, version: 'dsh-local-release-adapter-1', path: executablePath, sha256: sha(await readFile(executablePath)),
    interpreter: f.release.adapter.interpreter, authority: config.authority, keyId: config.keyId }
  const a = f.artifact; const candidate = { id: a.candidateId, package: a.packageName, version: a.packageVersion, integrity: a.tarballIntegrity,
    registry: { ...f.release.registry, reference: f.release.input.registryReference }, requires: a.requires, dshBaseline: a.dshBaseline,
    capabilities: a.capabilities, authorities: a.authorities }
  const preview = previewCatalogAdmission({ schemaVersion: 1, entries: [] }, candidate)
  const request = parseSourceReleaseRequest({ ...f.release, phase: 'catalog-admission', operationId: 'catalog-operation', requestedAt: Date.now(),
    plan: { ...f.release.plan, revision: f.release.plan.revision + 1 }, adapter, input: { artifact: a,
      artifactStatementDigest: f.release.input.artifactStatementDigest, artifactSignature: f.release.input.artifactSignature,
      registryReference: f.release.input.registryReference, registryVerificationRequest: f.release, registryVerificationReceipt: verification,
      verificationEvidenceDigest: verification.evidenceDigest, expectedBeforeCatalogDigest: preview.beforeCatalogDigest,
      expectedAfterCatalogDigest: preview.afterCatalogDigest, candidate } })
  const trust = { ...f.trust, releaseAdapters: { ...f.trust.releaseAdapters, 'catalog-admission': { ...adapter,
    timeoutMs: 15_000, environmentAllowlist: ['DSH_RELEASE_CATALOG_ADMISSION_CONFIG'] } } } as PluginControlTrustConfig
  return { ...f, catalogConfig: config, saveCatalogConfig: save, catalogPath, catalogRequest: request, catalogTrust: trust,
    catalogPublicKey: key.publicKey.export({ type: 'spki', format: 'pem' }).toString(), candidate, preview }
}

describe.skipIf(process.platform !== 'linux')('pinned npm registry verifier adapter', () => {
  test('admits the actual npm verifier receipt into the owner catalog and replays without rewriting', async () => {
    const f = await catalogFixture(); const receipt = await invokeSourceReleaseAdapter(f.catalogTrust, f.catalogRequest)
    const plan = { ...f.plan, revision: f.catalogRequest.plan.revision }
    await expect(new Ed25519SourceReleaseAuthority(f.catalogPublicKey, 'catalog-authority', 'catalog-key', Date.now,
      (authority, keyId) => authority === f.config.authority && keyId === f.config.keyId ? f.publicPem : undefined)
      .verify(receipt, plan, f.catalogRequest)).resolves.toMatchObject({ outcome: 'passed', phase: 'catalog-admission' })
    const loaded = await loadCatalogWithMetadata(f.catalogPath)
    expect(loaded.digest).toBe(f.preview.afterCatalogDigest); expect(loaded.catalog.entries).toEqual([f.candidate])
    const inode = (await stat(f.catalogPath)).ino
    expect(await invokeSourceReleaseAdapter(f.catalogTrust, f.catalogRequest)).toEqual(receipt)
    expect((await stat(f.catalogPath)).ino).toBe(inode); expect(f.seen).toHaveLength(2)
  })
  test('refuses a forged npm verification receipt before catalog mutation', async () => {
    const f = await catalogFixture(); if (f.catalogRequest.phase !== 'catalog-admission') throw new Error('missing catalog request')
    const before = await readFile(f.catalogPath); const receipt = f.catalogRequest.input.registryVerificationReceipt
    const request = { ...f.catalogRequest, input: { ...f.catalogRequest.input,
      registryVerificationReceipt: { ...receipt, signature: Buffer.alloc(64, 1).toString('base64') } } }
    await expect(invokeSourceReleaseAdapter(f.catalogTrust, request)).rejects.toThrow(/catalog-admission:FAILED/)
    expect(await readFile(f.catalogPath)).toEqual(before); expect(f.seen).toHaveLength(2)
  })
  test('pins the catalog helper dependency before admitting a remote artifact', async () => {
    const f = await catalogFixture(); const before = await readFile(f.catalogPath)
    await writeFile(f.catalogConfig.catalog.interpreterModule.path, 'throw new Error("changed dependency")')
    await expect(invokeSourceReleaseAdapter(f.catalogTrust, f.catalogRequest)).rejects.toThrow(/catalog-admission:FAILED/)
    expect(await readFile(f.catalogPath)).toEqual(before)
  })
  test('rejects npm catalog key reuse by the artifact signer', async () => {
    const f = await catalogFixture(); const before = await readFile(f.catalogPath)
    f.catalogConfig.privateKeyPath = f.signer.privateKeyPath; await f.saveCatalogConfig()
    await expect(invokeSourceReleaseAdapter(f.catalogTrust, f.catalogRequest)).rejects.toThrow(/catalog-admission:FAILED/)
    expect(await readFile(f.catalogPath)).toEqual(before)
  })
  test('verifies signed artifact FDs against a real TLS npm download and reuses its exact receipt', async () => {
    const f = await fixture(); const receipt = await invokeSourceReleaseAdapter(f.trust, f.release)
    expect(receipt.outcome).toBe('passed'); expect(receipt.evidence).toMatchObject({ kind: 'registry-verify', downloadedSha256: f.artifact.tarballSha256 })
    await expect(new Ed25519SourceReleaseAuthority(f.publicPem, f.config.authority, f.config.keyId).verify(receipt, f.plan, f.release)).resolves.toMatchObject({ outcome: 'passed' })
    expect(await invokeSourceReleaseAdapter(f.trust, f.release)).toEqual(receipt); expect(f.seen).toHaveLength(2)
  })
  test.each(['match', 'conflict', 'missing'] as const)('reconciles %s without inventing npm owner observations', async mode => {
    const f = await fixture(mode); const receipt = await invokeSourcePublishReconciliationAdapter(f.trust, f.reconcile)
    const outcome = mode === 'match' ? 'exists-match' : mode === 'conflict' ? 'digest-conflict' : 'unknown'
    expect(receipt.schemaVersion).toBe(2); expect(receipt.evidence).toMatchObject({ kind: 'npm-publish-reconciliation', outcome })
    expect(receipt.evidence).not.toHaveProperty('observedArtifactStatementDigest'); expect(receipt.evidence).not.toHaveProperty('observedArtifactSignatureDigest')
    await expect(new Ed25519SourcePublishReconciliationAuthority(f.publicPem, f.config.authority, f.config.keyId).verify(receipt, f.plan, f.reconcile)).resolves.toMatchObject({ schemaVersion: 2 })
    expect(await invokeSourcePublishReconciliationAdapter(f.trust, f.reconcile)).toEqual(receipt)
    expect(f.seen).toHaveLength(mode === 'missing' ? 1 : 2)
  })
  test('rejects a corrupted owner artifact signature before network access', async () => {
    const f = await fixture(); if (f.release.phase !== 'registry-verify') throw new Error('wrong fixture phase')
    const request = { ...f.release, input: { ...f.release.input, artifactSignature: Buffer.alloc(64, 7).toString('base64') } }
    await expect(invokeSourceReleaseAdapter(f.trust, request)).rejects.toThrow(/registry-verify:FAILED/); expect(f.seen).toEqual([])
  })
  test('rejects a wrong helper pin before network access', async () => {
    const f = await fixture(); f.config.registry.helper.sha256 = 'f'.repeat(64); await f.saveConfig()
    await expect(invokeSourcePublishReconciliationAdapter(f.trust, f.reconcile)).rejects.toThrow(/registry-verify:FAILED/); expect(f.seen).toEqual([])
  })
  test('rejects verifier key reuse by the owner authorizer', async () => {
    const f = await fixture(); f.config.privateKeyPath = f.owner.privateKeyPath; await f.saveConfig()
    await expect(invokeSourcePublishReconciliationAdapter(f.trust, f.reconcile)).rejects.toThrow(/registry-verify:FAILED/); expect(f.seen).toEqual([])
  })
  test('rejects an invalid owner authorization signature before network access', async () => {
    const f = await fixture(); const signature = Buffer.alloc(64, 9).toString('base64')
    const authorization = { ...f.authorization, signature, signatureDigest: sha(Buffer.from(signature, 'base64')) }
    await expect(invokeSourcePublishReconciliationAdapter(f.trust, { ...f.reconcile, authorization })).rejects.toThrow(/registry-verify:FAILED/); expect(f.seen).toEqual([])
  })
  test('refuses a different request under a completed operation identity', async () => {
    const f = await fixture(); await invokeSourcePublishReconciliationAdapter(f.trust, f.reconcile)
    await expect(invokeSourcePublishReconciliationAdapter(f.trust, { ...f.reconcile, attempt: 2 })).rejects.toThrow(/registry-verify:FAILED/); expect(f.seen).toHaveLength(2)
  })
  test('releases the operation lock when setup fails after acquiring it', async () => {
    const f = await fixture(); const directory = join(f.config.stateRoot, 'reconciliations', sha(f.reconcile.operationId))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(join(directory, 'binding.json'), 'invalid-json', { mode: 0o600 })
    await expect(invokeSourcePublishReconciliationAdapter(f.trust, f.reconcile)).rejects.toThrow(/registry-verify:FAILED/)
    await expect(lstat(join(directory, 'execution.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.seen).toEqual([])
    await rm(join(directory, 'binding.json'))
    await expect(invokeSourcePublishReconciliationAdapter(f.trust, f.reconcile)).resolves.toMatchObject({ evidence: { outcome: 'exists-match' } })
  })
  test('rejects reusing a cached operation after owner configuration changes', async () => {
    const f = await fixture(); await invokeSourcePublishReconciliationAdapter(f.trust, f.reconcile)
    f.config.registry.timeoutMs = 4_000; await f.saveConfig()
    await expect(invokeSourcePublishReconciliationAdapter(f.trust, f.reconcile)).rejects.toThrow(/registry-verify:FAILED/)
    expect(f.seen).toHaveLength(2)
  })
  test('Host deadline closes the active registry socket with no helper subprocess', async () => {
    const f = await fixture('slow'); f.trust.releaseAdapters!['registry-verify']!.timeoutMs = 1_500
    await expect(invokeSourcePublishReconciliationAdapter(f.trust, f.reconcile)).rejects.toThrow(/TIMED_OUT|TIMEOUT/)
    expect(f.slow.opened).toBe(true)
    await vi.waitFor(() => expect(f.slow.closed).toBe(true), { timeout: 1_000 })
    expect(f.seen).toHaveLength(1)
  })
})
