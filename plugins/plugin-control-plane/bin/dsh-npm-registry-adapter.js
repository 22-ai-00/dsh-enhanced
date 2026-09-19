#!/usr/bin/node
/** Owner-configured npm publish or independent verification. No installation authority. */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { closeSync, constants as fsConstants, existsSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const NPM_REGISTRY_ADAPTER_VERSION = 'dsh-npm-registry-adapter-1'
const PHASES = new Set(['registry-verify', 'publish'])
const DIGEST = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const PACKAGE = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u
const MAX_ARTIFACT_BYTES = 268_435_456
const ARTIFACT_FDS = Object.freeze({ tarball: ['DSH_RELEASE_TARBALL_FD', 3, MAX_ARTIFACT_BYTES],
  sbom: ['DSH_RELEASE_SBOM_FD', 4, 16_777_216], provenance: ['DSH_RELEASE_PROVENANCE_FD', 5, 16_777_216] })

export function canonicalReleaseValue(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalReleaseValue).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalReleaseValue(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}
function sha256Bytes(value) { return createHash('sha256').update(value).digest('hex') }
function sha512Integrity(value) { return `sha512-${createHash('sha512').update(value).digest('base64')}` }
function digest(value) { return sha256Bytes(canonicalReleaseValue(value)) }
function fail(message) { throw new Error(`npm registry adapter: ${message}`) }
function object(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} must be an object`)
  return value
}
function text(value, label, pattern = /^.+$/u, maximum = 2_000) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maximum || value.includes('\0')
    || value.includes('\r') || value.includes('\n') || !pattern.test(value)) fail(`${label} is invalid`)
  return value
}
function exactKeys(value, expected, label) {
  if (Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) fail(`${label} has unknown or missing fields`)
}
function canonicalPath(value, label) {
  const path = text(value, label)
  if (!isAbsolute(path) || path === '/' || realpathSync(path) !== resolve(path)) fail(`${label} must be an existing canonical absolute path`)
  return path
}
function privateDirectory(path, label) {
  const metadata = lstatSync(path); const uid = process.getuid?.()
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0
    || (uid !== undefined && metadata.uid !== uid) || realpathSync(path) !== resolve(path)) fail(`${label} must be an owner-private canonical directory`)
}
function ensurePrivateSubdirectory(root, components, label) {
  let current = root; privateDirectory(current, `${label} root`)
  for (const component of components) {
    if (!/^[A-Za-z0-9%._-]+$/u.test(component) || component === '.' || component === '..') fail(`${label} component is invalid`)
    current = join(current, component)
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 })
    privateDirectory(current, label)
    // Persist every ancestor directory entry before an irreversible dispatch.
    // Also sync existing entries: a previous attempt may have stopped at mkdir.
    fsyncDirectory(dirname(current))
  }
  return current
}
function fsyncDirectory(path) { const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY); try { fsyncSync(descriptor) } finally { closeSync(descriptor) } }
function privateFile(path, label, maximum = 65_536) {
  const canonical = canonicalPath(path, label); const metadata = lstatSync(canonical); const uid = process.getuid?.()
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size < 1 || metadata.size > maximum
    || (metadata.mode & 0o077) !== 0 || (uid !== undefined && metadata.uid !== uid)) fail(`${label} must be an owner-private regular file`)
  privateDirectory(dirname(canonical), `${label} directory`)
  return canonical
}
function safeRegularFile(path, label, maximum = MAX_ARTIFACT_BYTES) {
  const canonical = canonicalPath(path, label); const metadata = lstatSync(canonical); const uid = process.getuid?.()
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size < 1 || metadata.size > maximum
    || (metadata.mode & 0o022) !== 0 || (uid !== undefined && metadata.uid !== uid && metadata.uid !== 0)) fail(`${label} is unsafe`)
  return canonical
}
function stableBytes(path, label, maximum = MAX_ARTIFACT_BYTES) {
  const canonical = safeRegularFile(path, label, maximum)
  const descriptor = openSync(canonical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  let bytes; let before; let after
  try { before = fstatSync(descriptor, { bigint: true }); bytes = inheritedDescriptorBytes(descriptor, label, maximum); after = fstatSync(descriptor, { bigint: true }) }
  finally { closeSync(descriptor) }
  const pathAfter = lstatSync(canonical, { bigint: true })
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino
    || BigInt(bytes.length) !== before.size) fail(`${label} changed during read`)
  return bytes
}
function openPinnedFile(spec, label, maximum = MAX_ARTIFACT_BYTES, executable = false) {
  const item = object(spec, label); exactKeys(item, ['path', 'sha256'], label)
  const path = canonicalPath(item.path, `${label}.path`); const expected = text(item.sha256, `${label}.sha256`, DIGEST)
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); const uid = process.getuid?.()
  try {
    const before = fstatSync(descriptor, { bigint: true }); const pathBefore = lstatSync(path, { bigint: true })
    const expectedUid = uid === undefined ? undefined : BigInt(uid)
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximum)
      || (before.mode & 0o022n) !== 0n || (executable && (before.mode & 0o111n) === 0n)
      || (expectedUid !== undefined && before.uid !== expectedUid && before.uid !== 0n)
      || pathBefore.isSymbolicLink() || pathBefore.dev !== before.dev || pathBefore.ino !== before.ino) fail(`${label} is unsafe`)
    const bytes = inheritedDescriptorBytes(descriptor, label, maximum); const after = fstatSync(descriptor, { bigint: true })
    if (sha256Bytes(bytes) !== expected || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) fail(`${label} digest or identity changed`)
    return { path, sha256: expected, descriptor, device: before.dev, inode: before.ino }
  } catch (error) { closeSync(descriptor); throw error }
}
function verifyPinnedFile(value, label, maximum = MAX_ARTIFACT_BYTES) {
  const metadata = fstatSync(value.descriptor, { bigint: true })
  if (metadata.dev !== value.device || metadata.ino !== value.inode
    || sha256Bytes(inheritedDescriptorBytes(value.descriptor, label, maximum)) !== value.sha256) fail(`${label} changed during use`)
}
function closePinnedFile(value) { if (value?.descriptor !== undefined) closeSync(value.descriptor) }
function readBounded(path, label, maximum = MAX_ARTIFACT_BYTES) { return stableBytes(path, label, maximum) }
function inheritedArtifactBytes(kind) {
  const [environmentName, expectedFd, maximum] = ARTIFACT_FDS[kind]
  if (process.env[environmentName] !== String(expectedFd)) fail(`${environmentName} must bind inherited fd ${expectedFd}`)
  return inheritedDescriptorBytes(expectedFd, `inherited ${kind}`, maximum)
}
function inheritedDescriptorBytes(descriptor, label, maximum) {
  const before = fstatSync(descriptor, { bigint: true }); const uid = process.getuid?.(); const expectedUid = uid === undefined ? undefined : BigInt(uid)
  if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximum) || (before.mode & 0o022n) !== 0n
    || (expectedUid !== undefined && before.uid !== expectedUid && before.uid !== 0n)) fail(`${label} fd is unsafe`)
  const bytes = Buffer.alloc(Number(before.size)); let offset = 0
  while (offset < bytes.length) { const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset); if (count === 0) fail(`${label} ended early`); offset += count }
  const after = fstatSync(descriptor, { bigint: true })
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs
    || after.ctimeNs !== before.ctimeNs) fail(`${label} changed during read`)
  return bytes
}
function runningAdapterDigest() {
  const argument = process.argv[1]
  if (typeof argument !== 'string') fail('adapter executable argument is missing')
  const descriptor = argument.match(/^\/proc\/self\/fd\/(\d+)$/u)
  return descriptor === null ? sha256Bytes(stableBytes(argument, 'running adapter executable', MAX_ARTIFACT_BYTES))
    : sha256Bytes(inheritedDescriptorBytes(Number(descriptor[1]), 'running adapter executable', MAX_ARTIFACT_BYTES))
}
function runningInterpreterDigest() {
  const descriptor = process.execPath.match(/^\/proc\/self\/fd\/(\d+)$/u)
  return descriptor === null ? sha256Bytes(stableBytes(process.execPath, 'running adapter interpreter', MAX_ARTIFACT_BYTES))
    : sha256Bytes(inheritedDescriptorBytes(Number(descriptor[1]), 'running adapter interpreter', MAX_ARTIFACT_BYTES))
}
function relativePath(value, label) {
  const path = text(value, label, /^[A-Za-z0-9._/@+-]+$/u)
  if (isAbsolute(path) || path === '.' || path.split('/').some(part => part === '' || part === '.' || part === '..')) fail(`${label} is not a safe relative path`)
  return path
}
function readOwnerJson(path, label) {
  const source = readBounded(path, label, 65_536).toString('utf8')
  try { return object(JSON.parse(source), label) } catch (error) { if (error instanceof SyntaxError) fail(`${label} is not valid JSON`); throw error }
}
function loadPublicIdentity(value, label) {
  const item = object(value, label); exactKeys(item, ['authority', 'keyId', 'publicKeyPath'], label)
  const authority = text(item.authority, `${label}.authority`, ID); const keyId = text(item.keyId, `${label}.keyId`, ID)
  const publicKeyPath = privateFile(item.publicKeyPath, `${label}.public key`, 16_384)
  const publicKey = createPublicKey(readBounded(publicKeyPath, `${label}.public key`, 16_384))
  if (publicKey.asymmetricKeyType !== 'ed25519') fail(`${label} public key must be Ed25519`)
  return { authority, keyId, publicKeyPath, publicKey }
}
function safeScope(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) fail('source scope is invalid')
  const scope = [...new Set(value.map((entry, index) => relativePath(entry.normalize('NFC').trim(), `scope[${index}]`)))].sort()
  return scope
}
function validateAuthorization(request) {
  const authorization = object(request.authorization, 'source authorization')
  exactKeys(authorization, ['schemaVersion', 'kind', 'authorizationId', 'authority', 'keyId', 'planId', 'planDigest', 'baseCommit',
    'checkedTreeDigest', 'checkedPatchDigest', 'scope', 'releasePolicy', 'authorizedAt', 'expiresAt', 'signature', 'signatureDigest'], 'source authorization')
  const policy = object(authorization.releasePolicy, 'source release policy')
  exactKeys(policy, ['targetBranch', 'candidateId', 'packageName', 'packageVersion', 'packagePath', 'dshBaseline', 'capabilities',
    'authorities', 'requires', 'registryId', 'registryLocator', 'registryReference', 'catalogId', 'catalogPath',
    'minimumReproducibleBuilds'], 'source release policy')
  text(authorization.signatureDigest, 'authorization signature digest', DIGEST)
  const authorizationSignature = text(authorization.signature, 'authorization signature', /^[A-Za-z0-9+/]+={0,2}$/u, 16_384)
  const authorizationSignatureBytes = Buffer.from(authorizationSignature, 'base64')
  if (authorization.schemaVersion !== 1 || authorization.kind !== 'dsh-source-release-authorization'
    || !ID.test(authorization.authorizationId) || !ID.test(authorization.authority) || !ID.test(authorization.keyId)
    || authorization.planId !== request.plan.id || authorization.planDigest !== request.plan.digest
    || authorization.baseCommit === undefined || !COMMIT.test(authorization.baseCommit)
    || !DIGEST.test(authorization.checkedTreeDigest) || !DIGEST.test(authorization.checkedPatchDigest)
    || digest(authorization.scope) !== digest(safeScope(authorization.scope))
    || !Number.isSafeInteger(authorization.authorizedAt) || !Number.isSafeInteger(authorization.expiresAt)
    || authorization.authorizedAt > request.requestedAt || request.requestedAt > authorization.expiresAt
    || text(policy.targetBranch, 'authorized target branch') === '' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(policy.candidateId)
    || !PACKAGE.test(policy.packageName) || !VERSION.test(policy.packageVersion)
    || relativePath(policy.packagePath, 'authorized package path') !== policy.packagePath
    || !VERSION.test(policy.dshBaseline) || !Number.isSafeInteger(policy.minimumReproducibleBuilds) || policy.minimumReproducibleBuilds < 2
    || policy.minimumReproducibleBuilds > 16
    || authorizationSignatureBytes.length !== 64 || authorizationSignatureBytes.toString('base64') !== authorizationSignature
    || sha256Bytes(authorizationSignatureBytes) !== authorization.signatureDigest
    || policy.registryId !== request.registry.id || policy.registryLocator !== request.registry.locator
    || ('catalog' in request && (policy.catalogId !== request.catalog.id || policy.catalogPath !== request.catalog.path))
    || typeof policy.registryReference !== 'string' || policy.registryReference === '') fail('source authorization is not bound to this request')
  const normalizeStrings = (value, label) => {
    if (!Array.isArray(value) || value.length === 0 || value.some(entry => typeof entry !== 'string' || entry.normalize('NFC').trim() === '')) fail(`${label} is invalid`)
    const normalized = [...new Set(value.map(entry => entry.normalize('NFC').trim()))].sort()
    if (digest(value) !== digest(normalized)) fail(`${label} is not canonical`)
    return normalized
  }
  normalizeStrings(policy.capabilities, 'authorized capabilities'); normalizeStrings(policy.authorities, 'authorized authorities')
  if (!Array.isArray(policy.requires)) fail('authorized requirements are invalid')
  for (const requirement of policy.requires) {
    const item = object(requirement, 'authorized requirement'); exactKeys(item, ['package', 'version', 'integrity'], 'authorized requirement')
    text(item.package, 'authorized required package', PACKAGE); text(item.version, 'authorized required version', VERSION)
    text(item.integrity, 'authorized required integrity', /^sha512-[A-Za-z0-9+/]+={0,2}$/u)
  }
  return authorization
}
function verifyAuthorizationSignature(authorization, config) {
  if (authorization.authority !== config.authorizationAuthority.authority || authorization.keyId !== config.authorizationAuthority.keyId) {
    fail('source authorization uses an untrusted authority')
  }
  const { signature, signatureDigest: _signatureDigest, ...unsigned } = authorization
  if (!verify(null, Buffer.from(canonicalReleaseValue(unsigned)), config.authorizationAuthority.publicKey, Buffer.from(signature, 'base64'))) {
    fail('source authorization signature is invalid')
  }
}
function validateRequest(request, config) {
  exactKeys(object(request, 'release request'), ['schemaVersion', 'kind', 'operationId', 'attempt', 'requestedAt', 'receiptTtlMs',
    'installationId', 'ledger', 'plan', 'release', 'authorization', 'adapter', 'registry', 'catalog', 'phase', 'input'], 'release request')
  if (request.schemaVersion !== 1 || request.kind !== 'dsh-source-release-request' || request.phase !== config.phase
    || !PHASES.has(request.phase) || !ID.test(request.operationId) || !Number.isSafeInteger(request.requestedAt)
    || !Number.isSafeInteger(request.attempt) || request.attempt < 1 || !Number.isSafeInteger(request.receiptTtlMs)
    || request.receiptTtlMs < 1_000 || request.receiptTtlMs > 300_000) fail('release request envelope is invalid')
  const ledger = object(request.ledger, 'release ledger'); exactKeys(ledger, ['id', 'path'], 'release ledger')
  const plan = object(request.plan, 'release plan'); exactKeys(plan, ['id', 'digest', 'revision'], 'release plan')
  const release = object(request.release, 'release fence'); exactKeys(release, ['id', 'fence'], 'release fence')
  const registry = object(request.registry, 'release registry'); exactKeys(registry, ['id', 'locator'], 'release registry')
  const catalog = object(request.catalog, 'release catalog'); exactKeys(catalog, ['id', 'path'], 'release catalog')
  const adapter = object(request.adapter, 'adapter identity'); exactKeys(adapter, ['id', 'version', 'path', 'sha256', 'interpreter', 'authority', 'keyId'], 'adapter identity')
  const interpreter = object(adapter.interpreter, 'adapter interpreter'); exactKeys(interpreter, ['path', 'sha256'], 'adapter interpreter')
  if (!ID.test(plan.id) || !DIGEST.test(plan.digest) || !Number.isSafeInteger(plan.revision) || plan.revision < 1
    || !ID.test(release.id) || !Number.isSafeInteger(release.fence) || release.fence < 1
    || adapter.id !== config.id || adapter.version !== NPM_REGISTRY_ADAPTER_VERSION || adapter.authority !== config.authority || adapter.keyId !== config.keyId
    || adapter.path !== config.executablePath || runningAdapterDigest() !== adapter.sha256
    || runningInterpreterDigest() !== interpreter.sha256) {
    fail('release request is not bound to this adapter')
  }
  const authorization = validateAuthorization(request)
  verifyAuthorizationSignature(authorization, config)
  const input = object(request.input, `${request.phase} input`)
  exactKeys(input, request.phase === 'publish' ? ['artifact', 'artifactStatementDigest', 'artifactSignature', 'signEvidenceDigest']
    : ['artifact', 'artifactStatementDigest', 'artifactSignature', 'registryReference', 'publishEvidenceDigest'], 'registry phase input')
  return { authorization }
}
function verifierContext(request, config, reconcile) {
  const requestDigest = digest(request); const operationKey = sha256Bytes(request.operationId)
  const namespace = reconcile ? 'reconciliations' : 'operations'
  const directory = ensurePrivateSubdirectory(config.stateRoot, [namespace, operationKey], 'verifier operation directory')
  const releaseLock = acquireProcessLock(join(directory, 'execution.lock'), 'registry verifier')
  try {
    const bindingPath = join(directory, 'binding.json')
    const binding = { operationId: request.operationId, requestDigest, configurationDigest: config.configurationDigest }
    if (!existsSync(bindingPath)) immutableJson(bindingPath, binding, 0o600)
    if (digest(readOwnerJson(bindingPath, 'operation binding')) !== digest(binding)) fail('operation id was reused with a different request or configuration')
    const receiptPath = join(directory, 'receipt.json')
    if (existsSync(receiptPath)) {
      const cached = readOwnerJson(receiptPath, 'cached receipt')
      const receipt = object(cached.receipt, 'cached signed receipt')
      const { signature, ...unsigned } = receipt
      if (cached.requestDigest !== requestDigest || receipt.requestDigest !== requestDigest
        || receipt.operationId !== request.operationId || receipt.evidenceDigest !== digest(receipt.evidence)
        || !verify(null, Buffer.from(canonicalReleaseValue(unsigned)), createPublicKey(config.privateKey), Buffer.from(signature, 'base64'))) fail('cached receipt no longer verifies')
      releaseLock(); return { directory, requestDigest, receiptPath, cached: receipt }
    }
    return { directory, requestDigest, receiptPath, releaseLock }
  } catch (error) { releaseLock(); throw error }
}
function acquireProcessLock(path, label, retried = false) {
  try {
    writeSynced(path, Buffer.from(`${JSON.stringify({ pid: process.pid })}\n`), 0o600)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    let owner
    try { owner = readOwnerJson(path, `${label} execution lock`) } catch { fail(`${label} execution lock is invalid`) }
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) fail(`${label} execution lock is invalid`)
    try { process.kill(owner.pid, 0); fail(`${label} is already executing`) } catch (probe) {
      if (probe?.code !== 'ESRCH') throw probe
    }
    if (retried) fail(`${label} stale execution lock raced`)
    unlinkSync(path); return acquireProcessLock(path, label, true)
  }
  let released = false
  return () => {
    if (released) return
    const owner = readOwnerJson(path, `${label} execution lock`)
    if (owner.pid !== process.pid) fail(`${label} execution lock ownership changed`)
    unlinkSync(path); released = true
  }
}
function writeSynced(path, bytes, mode = 0o600) {
  const descriptor = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, mode)
  try { writeFileSync(descriptor, bytes); fsyncSync(descriptor) } finally { closeSync(descriptor) }
}
function immutableJson(path, value, mode = 0o600) {
  const bytes = Buffer.from(`${canonicalReleaseValue(value)}\n`)
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  writeSynced(temporary, bytes, mode)
  try { linkSync(temporary, path); fsyncDirectory(dirname(path)) } catch (error) { if (error?.code !== 'EEXIST') throw error } finally { unlinkSync(temporary); fsyncDirectory(dirname(path)) }
}
function assertUnexpired(request, label) { if (Date.now() > request.authorization.expiresAt) fail(`${label} crossed the authorization expiry`) }
function artifactSigningPayload(artifact) { return canonicalReleaseValue({ schemaVersion: 1, kind: 'dsh-release-artifact', artifact }) }
function verifyArtifactFiles(artifact) {
  const tarball = inheritedArtifactBytes('tarball'); const sbom = inheritedArtifactBytes('sbom'); const provenance = inheritedArtifactBytes('provenance')
  if (tarball.length !== artifact.tarballBytes || sha256Bytes(tarball) !== artifact.tarballSha256 || sha512Integrity(tarball) !== artifact.tarballIntegrity
    || sha256Bytes(sbom) !== artifact.sbomSha256 || sha256Bytes(provenance) !== artifact.provenanceSha256) fail('inherited artifact files do not match build evidence')
  return tarball
}
function verifySignedArtifact(input, registry, verifyFiles = true) {
  if (registry.signer === undefined) fail('artifact signer is not configured')
  const artifact = object(input.artifact, 'release artifact'); const statementDigest = text(input.artifactStatementDigest, 'artifact statement digest', DIGEST)
  const signature = text(input.artifactSignature, 'artifact signature', /^[A-Za-z0-9+/]+={0,2}$/u, 16_384)
  if (statementDigest !== digest(artifact)
    || !verify(null, Buffer.from(artifactSigningPayload(artifact)), registry.signer.publicKey, Buffer.from(signature, 'base64'))) fail('artifact signature is invalid')
  return { artifact, statementDigest, signature, signatureDigest: sha256Bytes(Buffer.from(signature, 'base64')),
    ...(verifyFiles ? { tarball: verifyArtifactFiles(artifact) } : {}) }
}
function signedReceipt(request, config, requestDigest, evidence, outcome = 'passed') {
  const observedAt = Date.now()
  if (Date.now() < observedAt || Date.now() > request.authorization.expiresAt) fail('request is outside its authorization interval')
  const expiresAt = Math.min(observedAt + request.receiptTtlMs, request.authorization.expiresAt)
  if (expiresAt <= observedAt) fail('source release authorization expired before receipt issuance')
  const unsigned = { schemaVersion: 1, receiptId: `receipt-${sha256Bytes(request.operationId).slice(0, 32)}`,
    authority: config.authority, keyId: config.keyId, installationId: request.installationId, planId: request.plan.id,
    planDigest: request.plan.digest, releaseId: request.release.id, fence: request.release.fence, operationId: request.operationId,
    requestDigest, phase: request.phase, outcome, evidence, evidenceDigest: digest(evidence), observedAt, expiresAt }
  return { ...unsigned, signature: sign(null, Buffer.from(canonicalReleaseValue(unsigned)), config.privateKey).toString('base64') }
}
function signedReconciliationReceipt(request, config, requestDigest, evidence) {
  const observedAt = Date.now()
  if (Date.now() < observedAt || Date.now() > request.authorization.expiresAt) fail('reconciliation request is outside its authorization interval')
  const expiresAt = Math.min(observedAt + request.receiptTtlMs, request.authorization.expiresAt)
  if (expiresAt <= observedAt) fail('source release authorization expired before reconciliation receipt issuance')
  const unsigned = { schemaVersion: 2, kind: 'dsh-source-publish-reconciliation-receipt',
    receiptId: `reconciliation-${sha256Bytes(request.operationId).slice(0, 32)}`, authority: config.authority, keyId: config.keyId,
    installationId: request.installationId, planId: request.plan.id, planDigest: request.plan.digest, releaseId: request.release.id,
    fence: request.release.fence, operationId: request.operationId, requestDigest, evidence, evidenceDigest: digest(evidence),
    observedAt, expiresAt }
  return { ...unsigned, signature: sign(null, Buffer.from(canonicalReleaseValue(unsigned)), config.privateKey).toString('base64') }
}
function validateReconciliationRequest(request, config) {
  const expected = ['schemaVersion', 'kind', 'operationId', 'attempt', 'requestedAt', 'receiptTtlMs', 'installationId', 'ledger', 'plan',
    'release', 'authorization', 'adapter', 'registry', 'ambiguousPublish', 'artifact', 'expectedRegistryReference',
    'expectedArtifactStatementDigest', 'expectedArtifactSignatureDigest']
  exactKeys(object(request, 'reconciliation request'), expected, 'reconciliation request')
  if (request.schemaVersion !== 1 || request.kind !== 'dsh-source-publish-reconciliation-request' || !ID.test(request.operationId)
    || !Number.isSafeInteger(request.attempt) || request.attempt < 1
    || !Number.isSafeInteger(request.requestedAt) || !Number.isSafeInteger(request.receiptTtlMs) || request.receiptTtlMs < 1_000
    || request.receiptTtlMs > 300_000) fail('reconciliation request envelope is invalid')
  const authorization = validateAuthorization(request); const adapter = object(request.adapter, 'adapter identity')
  const ledger = object(request.ledger, 'reconciliation ledger'); exactKeys(ledger, ['id', 'path'], 'reconciliation ledger')
  const plan = object(request.plan, 'reconciliation plan'); exactKeys(plan, ['id', 'digest', 'revision'], 'reconciliation plan')
  const release = object(request.release, 'reconciliation release'); exactKeys(release, ['id', 'fence'], 'reconciliation release')
  const registryInput = object(request.registry, 'reconciliation registry'); exactKeys(registryInput, ['id', 'locator'], 'reconciliation registry')
  exactKeys(adapter, ['id', 'version', 'path', 'sha256', 'interpreter', 'authority', 'keyId'], 'adapter identity')
  const interpreter = object(adapter.interpreter, 'adapter interpreter')
  exactKeys(interpreter, ['path', 'sha256'], 'adapter interpreter')
  if (config.phase !== 'registry-verify' || adapter.id !== config.id || adapter.version !== NPM_REGISTRY_ADAPTER_VERSION
    || adapter.authority !== config.authority || adapter.keyId !== config.keyId || adapter.path !== config.executablePath
    || runningAdapterDigest() !== adapter.sha256 || runningInterpreterDigest() !== interpreter.sha256) {
    fail('reconciliation request is not bound to this verifier')
  }
  const registry = registryConfig(config.registry)
  if (registry.id !== request.registry.id || registry.locator !== request.registry.locator
    || request.expectedRegistryReference !== authorization.releasePolicy.registryReference) fail('reconciliation request targets a different registry')
  const ambiguous = object(request.ambiguousPublish, 'ambiguous publish'); exactKeys(ambiguous, ['operationId', 'receiptId', 'receiptDigest', 'evidenceDigest'], 'ambiguous publish')
  const artifact = object(request.artifact, 'reconciliation artifact'); exactKeys(artifact, ['packageName', 'packageVersion', 'tarballSha256', 'tarballIntegrity'], 'reconciliation artifact')
  for (const value of [ambiguous.receiptDigest, ambiguous.evidenceDigest, artifact.tarballSha256]) text(value, 'reconciliation digest', DIGEST)
  text(request.expectedArtifactStatementDigest, 'expected artifact statement digest', DIGEST)
  text(request.expectedArtifactSignatureDigest, 'expected artifact signature digest', DIGEST)
  text(artifact.packageName, 'reconciliation package', PACKAGE); text(artifact.packageVersion, 'reconciliation version', VERSION)
  text(artifact.tarballIntegrity, 'reconciliation integrity', /^sha512-[A-Za-z0-9+/]+={0,2}$/u)
  if (artifact.packageName !== authorization.releasePolicy.packageName || artifact.packageVersion !== authorization.releasePolicy.packageVersion) {
    fail('reconciliation artifact is not owner-authorized')
  }
  verifyAuthorizationSignature(authorization, config)
  return { authorization, registry }
}

function httpsBase(value, label) {
  const raw = text(value, label)
  if (/[\\?#\s]/u.test(raw) || [...raw].some(c => c.charCodeAt(0) <= 0x20 || c.charCodeAt(0) === 0x7f) || /%(?:2e|2f|5c|25)|%(?![a-f0-9]{2})/iu.test(raw)) fail(`${label} is ambiguous`)
  let url
  try { url = new URL(raw) } catch { fail(`${label} is invalid`) }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.href !== raw) fail(`${label} must be canonical bare HTTPS`)
  return url
}
function registryConfig(value, phase = 'registry-verify') {
  const item = object(value, 'npm registry config')
  exactKeys(item, ['protocol', 'id', 'locator', 'signer', 'helper', 'caPins', 'timeoutMs',
    ...(phase === 'publish' ? ['tokenPath', 'tag'] : [])], 'npm registry config')
  if (item.protocol !== 'npm') fail('registry protocol must be explicit npm')
  text(item.id, 'registry id', ID); httpsBase(item.locator, 'registry locator')
  if (!Number.isSafeInteger(item.timeoutMs) || item.timeoutMs < 1 || item.timeoutMs > 120_000) fail('registry timeout is invalid')
  if (!Array.isArray(item.caPins) || item.caPins.length > 16 || item.caPins.some(pin => typeof pin !== 'string' || pin.length > 16_384 || !pin.includes('BEGIN CERTIFICATE'))) fail('registry CA pins are invalid')
  const signer = loadPublicIdentity(item.signer, 'artifact signer')
  if (phase === 'publish') {
    text(item.tokenPath, 'publisher token path')
    if (!isAbsolute(item.tokenPath)) fail('publisher token path must be absolute')
    text(item.tag, 'owner publish tag', /^[a-z][a-z0-9-]{0,63}$/u)
  }
  const opened = openPinnedFile(item.helper, 'registry helper', 1_048_576); closePinnedFile(opened)
  return { ...item, signer }
}
function loadConfig(environment, phase) {
  const path = privateFile(phase === 'publish' ? environment.DSH_RELEASE_PUBLISH_CONFIG : environment.DSH_RELEASE_REGISTRY_VERIFY_CONFIG, 'registry adapter config')
  const config = readOwnerJson(path, 'registry verifier config')
  exactKeys(config, ['schemaVersion', 'id', 'phase', 'executablePath', 'authority', 'keyId', 'privateKeyPath', 'authorizationAuthority', 'stateRoot', 'registry'], 'registry verifier config')
  if (config.schemaVersion !== 1 || config.phase !== phase || !PHASES.has(phase)) fail('unsupported registry adapter configuration')
  for (const key of ['id', 'authority', 'keyId']) text(config[key], key, ID)
  canonicalPath(config.executablePath, 'adapter executable')
  const stateRoot = canonicalPath(config.stateRoot, 'state root'); privateDirectory(stateRoot, 'state root')
  const privateKeyPath = privateFile(config.privateKeyPath, 'verifier signing key', 16_384)
  const privateKey = createPrivateKey(readBounded(privateKeyPath, 'verifier signing key', 16_384))
  if (privateKey.asymmetricKeyType !== 'ed25519') fail('verifier signing key must be Ed25519')
  const authorizationAuthority = loadPublicIdentity(config.authorizationAuthority, 'release authorization authority')
  const registry = registryConfig(config.registry, phase)
  const publicKey = createPublicKey(privateKey)
  if (publicKey.equals(authorizationAuthority.publicKey) || publicKey.equals(registry.signer.publicKey)
    || (config.authority === registry.signer.authority && config.keyId === registry.signer.keyId)
    || (config.authority === authorizationAuthority.authority && config.keyId === authorizationAuthority.keyId)) fail('verifier must be independent of artifact signer and owner authorizer')
  return { ...config, privateKey, authorizationAuthority, registryValue: registry, configurationDigest: digest({ ...config,
    ownerPublicKey: authorizationAuthority.publicKey.export({ type: 'spki', format: 'pem' }),
    signerPublicKey: registry.signer.publicKey.export({ type: 'spki', format: 'pem' }),
    verifierPublicKey: publicKey.export({ type: 'spki', format: 'pem' }) }) }
}
function validateBindings(request, config, reconcile) {
  const now = Date.now(); const authorization = request.authorization; const registry = config.registryValue
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(request.installationId)
    || !ID.test(request.ledger.id) || !isAbsolute(request.ledger.path) || request.ledger.path === '/'
    || !ID.test(request.plan.id) || !DIGEST.test(request.plan.digest) || !Number.isSafeInteger(request.plan.revision) || request.plan.revision < 1
    || !ID.test(request.release.id) || !Number.isSafeInteger(request.release.fence) || request.release.fence < 1
    || request.requestedAt > now || authorization.authorizedAt > now || authorization.expiresAt <= now
    || authorization.expiresAt <= authorization.authorizedAt || authorization.expiresAt - authorization.authorizedAt > 86_400_000
    || request.registry.id !== registry.id || request.registry.locator !== registry.locator) fail('request binding or validity interval is invalid')
  const interpreter = request.adapter.interpreter
  if (realpathSync(interpreter.path) !== realpathSync(process.execPath) || interpreter.sha256 !== runningInterpreterDigest()) fail('request interpreter path differs from running interpreter')
  const reference = reconcile ? request.expectedRegistryReference : request.phase === 'publish'
    ? authorization.releasePolicy.registryReference : request.input.registryReference
  const target = httpsBase(reference, 'registry reference'); const base = httpsBase(registry.locator, 'registry locator')
  if (target.origin !== base.origin || !target.pathname.startsWith(`${base.pathname.replace(/\/+$/u, '')}/`)
    || reference !== authorization.releasePolicy.registryReference) fail('registry reference escapes the authorized registry')
  if (reconcile) {
    text(request.ambiguousPublish.operationId, 'ambiguous operation', ID); text(request.ambiguousPublish.receiptId, 'ambiguous receipt', ID)
    canonicalIntegrity(request.artifact.tarballIntegrity)
  } else {
    const artifact = request.input.artifact; const policy = authorization.releasePolicy
    if (artifact.packageName !== policy.packageName || artifact.packageVersion !== policy.packageVersion
      || artifact.packagePath !== policy.packagePath || artifact.candidateId !== policy.candidateId
      || artifact.dshBaseline !== policy.dshBaseline || digest(artifact.capabilities) !== digest(policy.capabilities)
      || digest(artifact.authorities) !== digest(policy.authorities) || digest(artifact.requires) !== digest(policy.requires)) fail('artifact differs from owner-authorized release policy')
    if (!Number.isSafeInteger(artifact.tarballBytes) || artifact.tarballBytes < 1 || artifact.tarballBytes > MAX_ARTIFACT_BYTES) fail('artifact byte count is invalid')
    canonicalIntegrity(artifact.tarballIntegrity); text(artifact.tarballSha256, 'artifact digest', DIGEST)
    if (request.phase === 'publish') text(request.input.signEvidenceDigest, 'sign evidence digest', DIGEST)
    else text(request.input.publishEvidenceDigest, 'publish evidence digest', DIGEST)
  }
}
function canonicalIntegrity(value) {
  if (typeof value !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(value)) fail('artifact integrity must be canonical SHA-512')
  const encoded = value.slice(7); const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length !== 64 || bytes.toString('base64') !== encoded) fail('artifact integrity must be canonical SHA-512')
  return value
}
async function observation(request, config) {
  const registry = config.registryValue
  const artifact = request.kind === 'dsh-source-publish-reconciliation-request' ? request.artifact : request.input.artifact
  const timeoutMs = Math.min(registry.timeoutMs, request.authorization.expiresAt - Date.now())
  if (timeoutMs < 1) fail('authorization expired before registry observation')
  const input = { registry: { id: registry.id, protocol: 'npm', locator: registry.locator, caPins: registry.caPins, tokenEnvironment: null },
    packageName: artifact.packageName, version: artifact.packageVersion, timeoutMs }
  const pinned = openPinnedFile(registry.helper, 'registry helper', 1_048_576)
  let value
  try {
    const bytes = inheritedDescriptorBytes(pinned.descriptor, 'registry helper', 1_048_576)
    if (sha256Bytes(bytes) !== pinned.sha256) fail('registry helper changed before import')
    // Import the checked bytes themselves: importing a filesystem URL could
    // resolve a pathname again after its descriptor was pinned.
    const helper = await import(`data:text/javascript;base64,${bytes.toString('base64')}`)
    if (typeof helper.observeNpmRegistryArtifact !== 'function') fail('npm observer helper is unavailable')
    let observed
    try { observed = await helper.observeNpmRegistryArtifact(input, {}) } catch { return null }
    if (!Buffer.isBuffer(observed.bytes) || observed.bytes.length < 1 || observed.bytes.length > MAX_ARTIFACT_BYTES) fail('registry observer returned invalid bytes')
    value = { ok: true, registryReference: observed.reference, metadataReference: observed.metadataReference,
      metadataIntegrity: observed.metadataIntegrity, downloadedBytes: observed.bytes.length,
      observedTarballSha256: sha256Bytes(observed.bytes), observedTarballIntegrity: sha512Integrity(observed.bytes) }
  } finally { try { verifyPinnedFile(pinned, 'registry helper', 1_048_576) } finally { closePinnedFile(pinned) } }
  assertUnexpired(request, 'registry observation')
  exactKeys(value, ['ok', 'registryReference', 'metadataReference', 'metadataIntegrity', 'downloadedBytes', 'observedTarballSha256', 'observedTarballIntegrity'], 'registry observation')
  if (value.ok !== true || !Number.isSafeInteger(value.downloadedBytes) || value.downloadedBytes < 1 || value.downloadedBytes > MAX_ARTIFACT_BYTES) fail('registry observation byte count is invalid')
  text(value.observedTarballSha256, 'observed digest', DIGEST); canonicalIntegrity(value.observedTarballIntegrity)
  if (value.metadataIntegrity !== value.observedTarballIntegrity) fail('registry metadata and downloaded integrity differ')
  const base = httpsBase(registry.locator, 'registry locator')
  const metadata = new URL(base); metadata.pathname = `${base.pathname.replace(/\/+$/u, '')}/${encodeURIComponent(artifact.packageName)}/${artifact.packageVersion}`
  const expectedReference = request.kind === 'dsh-source-publish-reconciliation-request' ? request.expectedRegistryReference : request.input.registryReference
  if (value.metadataReference !== metadata.href || value.registryReference !== expectedReference) fail('registry observation reference differs from exact owner binding')
  return value
}
function reconciliationEvidence(request, observed) {
  const artifact = request.artifact
  const outcome = observed === null ? 'unknown' : observed.observedTarballSha256 === artifact.tarballSha256
    && observed.observedTarballIntegrity === artifact.tarballIntegrity ? 'exists-match' : 'digest-conflict'
  const evidence = { kind: 'npm-publish-reconciliation', outcome, registryId: request.registry.id,
    registryReference: observed?.registryReference ?? null, packageName: artifact.packageName, packageVersion: artifact.packageVersion,
    expectedTarballSha256: artifact.tarballSha256, expectedTarballIntegrity: artifact.tarballIntegrity,
    expectedArtifactStatementDigest: request.expectedArtifactStatementDigest, expectedArtifactSignatureDigest: request.expectedArtifactSignatureDigest,
    observedTarballSha256: observed?.observedTarballSha256 ?? null, observedTarballIntegrity: observed?.observedTarballIntegrity ?? null,
    metadataReference: observed?.metadataReference ?? null, metadataIntegrity: observed?.metadataIntegrity ?? null,
    downloadedBytes: observed?.downloadedBytes ?? null, ambiguousPublishOperationId: request.ambiguousPublish.operationId,
    ambiguousPublishReceiptDigest: request.ambiguousPublish.receiptDigest }
  return { ...evidence, detailDigest: digest(evidence) }
}
async function publishReceipt(request, config, context, signed) {
  const artifact = signed.artifact; const registry = config.registryValue
  const reference = request.authorization.releasePolicy.registryReference
  const ambiguous = reason => signedReceipt(request, config, context.requestDigest, {
    kind: 'publish-ambiguity', registryId: registry.id, packageName: artifact.packageName, packageVersion: artifact.packageVersion,
    tarballSha256: artifact.tarballSha256, detailDigest: digest({ reason }),
  }, 'ambiguous')
  const markerPath = join(context.directory, 'publish-dispatched.json')
  if (existsSync(markerPath)) {
    const marker = readOwnerJson(markerPath, 'publication dispatch marker')
    if (marker.schemaVersion !== 1 || marker.operationId !== request.operationId || marker.requestDigest !== context.requestDigest
      || marker.registryReference !== reference || !DIGEST.test(marker.bodySha256)) fail('publication dispatch marker is not bound to the request')
    return ambiguous('previous-dispatch-requires-independent-reconciliation')
  }
  const pinned = openPinnedFile(registry.helper, 'npm publication helper', 1_048_576)
  try {
    const bytes = inheritedDescriptorBytes(pinned.descriptor, 'npm publication helper', 1_048_576)
    if (sha256Bytes(bytes) !== pinned.sha256) fail('publication helper changed before import')
    const helper = await import(`data:text/javascript;base64,${bytes.toString('base64')}`)
    if (typeof helper.prepareNpmPublish !== 'function' || typeof helper.sendNpmPublish !== 'function') fail('npm publication helper contract is unavailable')
    const prepared = await helper.prepareNpmPublish({ locator: registry.locator, packageName: artifact.packageName,
      version: artifact.packageVersion, tarball: signed.tarball, tag: registry.tag, expectedRegistryReference: reference })
    if (!Buffer.isBuffer(prepared.body) || prepared.body.length < 1 || prepared.body.length > 402_653_184) fail('publication payload exceeds its bound')
    const base = httpsBase(registry.locator, 'registry locator'); const target = new URL(base)
    target.pathname = `${base.pathname.replace(/\/+$/u, '')}/${artifact.packageName.replace('/', '%2f')}`
    if (prepared.url !== target.href) fail('publication helper selected an unauthorized endpoint')
    const tokenPath = privateFile(registry.tokenPath, 'npm publisher token', 16_384)
    const token = new TextDecoder('utf-8', { fatal: true }).decode(readBounded(tokenPath, 'npm publisher token', 16_384)).trim()
    if (!token || /[^\x21-\x7e]/u.test(token)) fail('npm publisher token is invalid')
    assertUnexpired(request, 'npm publish preparation')
    immutableJson(markerPath, { schemaVersion: 1, operationId: request.operationId, requestDigest: context.requestDigest,
      registryReference: reference, bodySha256: sha256Bytes(prepared.body), dispatchedAt: Date.now() }, 0o600)
    let result
    try {
      const timeoutMs = Math.min(registry.timeoutMs, request.authorization.expiresAt - Date.now())
      if (timeoutMs < 1) return ambiguous('authorization-expired-after-dispatch-mark')
      result = await helper.sendNpmPublish({ url: prepared.url, body: prepared.body, token, caPins: registry.caPins, timeoutMs })
    } catch { return ambiguous('publication-transport-did-not-confirm') }
    if (result?.outcome !== 'accepted' || !DIGEST.test(result.detailDigest)) return ambiguous('publication-acknowledgment-is-unknown')
    return signedReceipt(request, config, context.requestDigest, { kind: 'publish', registryId: registry.id,
      registryReference: reference, packageName: artifact.packageName, packageVersion: artifact.packageVersion,
      tarballSha256: artifact.tarballSha256, tarballIntegrity: artifact.tarballIntegrity,
      artifactStatementDigest: signed.statementDigest, artifactSignatureDigest: signed.signatureDigest,
      signEvidenceDigest: request.input.signEvidenceDigest, immutable: true })
  } finally { try { verifyPinnedFile(pinned, 'npm publication helper') } finally { closePinnedFile(pinned) } }
}
function readRequest() {
  const chunks = []; let total = 0
  while (true) {
    const chunk = Buffer.alloc(16_384); const count = readSync(0, chunk, 0, chunk.length, null)
    if (count === 0) break
    total += count; if (total > 1_048_576) fail('request exceeds input limit')
    chunks.push(chunk.subarray(0, count))
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
}
export async function runNpmRegistryAdapter(argv = process.argv.slice(2), environment = process.env) {
  if (argv.length === 1 && argv[0] === '--version') { process.stdout.write(`${NPM_REGISTRY_ADAPTER_VERSION}\n`); return }
  if (argv.length === 1 && argv[0] === '--capabilities') { process.stdout.write('{"schemaVersion":1,"artifactInput":"inherited-fd-v1"}\n'); return }
  if (argv.length !== 1 || !['release', 'reconcile'].includes(argv[0])) fail('usage: dsh-npm-registry-adapter <--version|--capabilities|release|reconcile>')
  const request = readRequest(); const reconcile = argv[0] === 'reconcile'
  const phase = reconcile ? 'registry-verify' : request.phase
  if (!PHASES.has(phase)) fail('unsupported npm registry phase')
  const config = loadConfig(environment, phase)
  if (reconcile) validateReconciliationRequest(request, config)
  else validateRequest(request, config)
  validateBindings(request, config, reconcile)
  const signed = reconcile ? undefined : verifySignedArtifact(request.input, config.registryValue)
  const context = verifierContext(request, config, reconcile)
  if (context.cached !== undefined) {
    if (context.cached.expiresAt <= Date.now()) fail('cached observation receipt expired')
    process.stdout.write(`${JSON.stringify(context.cached)}\n`); return
  }
  try {
    let receipt
    if (!reconcile && request.phase === 'publish') receipt = await publishReceipt(request, config, context, signed)
    else {
      const observed = await observation(request, config)
      if (reconcile) receipt = signedReconciliationReceipt(request, config, context.requestDigest, reconciliationEvidence(request, observed))
      else {
        if (observed === null || observed.observedTarballSha256 !== signed.artifact.tarballSha256
          || observed.observedTarballIntegrity !== signed.artifact.tarballIntegrity || observed.downloadedBytes !== signed.artifact.tarballBytes) fail('npm download does not match the exact signed artifact')
        receipt = signedReceipt(request, config, context.requestDigest, { kind: 'registry-verify', registryId: request.registry.id,
          registryReference: observed.registryReference, independentlyDownloaded: true, downloadedBytes: observed.downloadedBytes,
          downloadedSha256: observed.observedTarballSha256, downloadedIntegrity: observed.observedTarballIntegrity,
          artifactStatementDigest: signed.statementDigest, artifactSignatureDigest: signed.signatureDigest, publishEvidenceDigest: request.input.publishEvidenceDigest })
      }
    }
    immutableJson(context.receiptPath, { requestDigest: context.requestDigest, receipt }, 0o600)
    const persisted = readOwnerJson(context.receiptPath, 'persisted verifier receipt')
    if (persisted.requestDigest !== context.requestDigest || digest(persisted.receipt) !== digest(receipt)) fail('receipt persistence raced')
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
  } finally { context.releaseLock?.() }
}
const invokedDirectly = process.argv[1] !== undefined
  && (/^\/proc\/self\/fd\/\d+$/u.test(process.argv[1]) || realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
if (invokedDirectly) void runNpmRegistryAdapter().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'npm registry adapter failed'}\n`)
  process.exitCode = 1
})
