import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { assertLocalSourceInstaller } from './local-source-maintenance.mjs'

const protocol = 'dsh-enhanced/owner-repair-successor-intent/v1'
const repairProtocol = 'dsh-enhanced/host-owner-source-repair/v1'
const hash = source => createHash('sha256').update(source).digest('hex')
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
const hex = /^[a-f0-9]{64}$/u
const commit = /^[a-f0-9]{40}$/u
const profileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const transactionId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const fail = message => { throw new Error(`Owner repair successor: ${message}`) }
const exact = path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path
  && !path.includes('\0') && !/[\r\n]/u.test(path)
const inside = (root, path) => path === root || path.startsWith(`${root}${sep}`)
const identity = entry => ({ dev: String(entry.dev), ino: String(entry.ino), uid: entry.uid, mode: entry.mode })
const keys = (value, expected) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort())

function pendingPath(homePath) { return `${homePath}.dsh-enhanced-owner-successor.json` }

async function directory(path, privateMode = false) {
  if (!exact(path) || await realpath(path) !== path) fail(`noncanonical directory: ${path}`)
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid()
    || entry.mode & (privateMode ? 0o077 : 0o022)) fail(`unsafe directory: ${path}`)
  return entry
}

async function stable(path, maximum = 4_194_304) {
  if (!exact(path) || await realpath(path) !== path) fail(`noncanonical file: ${path}`)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat({ bigint: true }), named = await lstat(path, { bigint: true })
    if (!before.isFile() || before.uid !== BigInt(process.getuid()) || before.nlink !== 1n
      || before.size < 1n || before.size > BigInt(maximum) || (before.mode & 0o077n) !== 0n
      || before.dev !== named.dev || before.ino !== named.ino) fail(`unsafe private file: ${path}`)
    const source = await file.readFile()
    const after = await file.stat({ bigint: true })
    if (BigInt(source.length) !== before.size || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      fail(`private file changed: ${path}`)
    }
    return source
  } finally { await file.close() }
}

async function maybeStable(path, maximum) {
  try { return await stable(path, maximum) }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error
    try { await lstat(path) } catch (missing) { if (missing?.code === 'ENOENT') return null; throw missing }
    fail(`dangling private file: ${path}`)
  }
}

function parsed(source, label) {
  let value
  try { value = JSON.parse(source) } catch { fail(`invalid ${label}`) }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`invalid ${label}`)
  return value
}

function manifestProof(source, homePath, profile) {
  if (typeof source !== 'string' || Buffer.byteLength(source) < 1 || Buffer.byteLength(source) > 2_097_152) {
    fail('invalid predecessor manifest bytes')
  }
  const manifest = parsed(source, 'predecessor manifest')
  const proof = manifest.hostMigration?.localSource
  const repair = proof?.ownerRepair
  const overlay = proof?.ownerRepairNext?.overlay
  const resources = repair?.original?.resources
  if (manifest.version !== 4 || manifest.operation !== 'host-update'
    || manifest.homePath !== homePath || manifest.canonicalHome !== homePath || manifest.profile !== profile
    || manifest.transactionPath !== `${homePath}.dsh-enhanced-transaction`
    || !validIdentity(manifest.transactionIdentity) || !validIdentity(manifest.originalIdentity)
    || !validIdentity(manifest.stagedIdentity)
    || !transactionId.test(manifest.id) || manifest.state !== 'swapped'
    || !manifest.hostMigration.candidateEverStarted
    || !['starting', 'failed'].includes(manifest.hostMigration.phase)
    || proof.protocol !== repairProtocol || proof.homePath !== homePath || proof.profile !== profile
    || repair.homePath !== homePath || repair.profile !== profile
    || !resources || resources.root !== join(homePath, 'rsi-authorities', profile)
    || overlay?.kind !== 'rsi-owner-repair-overlay' || overlay.transactionId !== manifest.id
    || overlay.dshHome !== homePath || overlay.targetProfile !== profile
    || !hex.test(proof.ownerRepairNext.overlayDigest)
    || hash(canonical(overlay)) !== proof.ownerRepairNext.overlayDigest
    || !hex.test(manifest.bindingDigest)) fail('predecessor owner repair binding differs')
  return { manifest, proof, overlay, resources }
}

async function originalHostKey(homePath, physicalHome, profile, resources) {
  const physicalRoot = join(physicalHome, relative(homePath, resources.root))
  await directory(physicalHome, true)
  await directory(join(physicalHome, 'rsi-authorities'), true)
  await directory(physicalRoot, true)
  await directory(join(physicalRoot, 'identities'), true)
  const receipt = parsed((await stable(join(physicalRoot, 'bootstrap.json'), 65_536)).toString('utf8'), 'resources receipt')
  const { receiptDigest, ...body } = receipt
  if (receipt.schemaVersion !== 1 || receipt.dshHome !== homePath || receipt.profile !== profile
    || !isDeepStrictEqual(receipt.resources, resources) || receiptDigest !== hash(JSON.stringify(body))
    || !keys(resources.identities, ['approval', 'release', 'adoption', 'observation', 'qualification', 'host',
      'pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission'])
    || !isDeepStrictEqual(Object.keys(receipt.keyDigests ?? {}).sort(), Object.keys(resources.identities).sort())) {
    fail('original authority resources changed')
  }
  let hostKey
  for (const [role, entry] of Object.entries(resources.identities)) {
    if (!keys(entry, ['authority', 'keyId', 'keyPath', 'publicKeyPem'])
      || entry.authority !== `${role}-${resources.installationId}`
      || entry.keyId !== `${entry.authority}-key`
      || entry.keyPath !== join(resources.root, 'identities', `${role}.pem`)) fail('original authority identity changed')
    const source = await stable(join(physicalHome, relative(homePath, entry.keyPath)), 16_384)
    const privateKey = createPrivateKey(source)
    if (privateKey.asymmetricKeyType !== 'ed25519' || hash(source) !== receipt.keyDigests[role]
      || !createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
        .equals(createPublicKey(entry.publicKeyPem).export({ format: 'der', type: 'spki' }))) {
      fail('original authority key changed')
    }
    if (role === 'host') hostKey = privateKey
  }
  return hostKey
}

async function predecessorBackup(manifest, archivePath, successorTransactionId) {
  const root = archivePath ?? manifest.transactionPath
  if (!validArchive(manifest.homePath, root, successorTransactionId)
    && root !== manifest.transactionPath) fail('predecessor backup root differs')
  const rootIdentity = identity(await directory(root, true))
  if (!isDeepStrictEqual(rootIdentity, manifest.transactionIdentity)) fail('predecessor transaction identity changed')
  const backup = join(root, 'original-home')
  const backupIdentity = identity(await directory(backup, true))
  if (!isDeepStrictEqual(backupIdentity, manifest.originalIdentity)) fail('predecessor original Home identity changed')
  return backup
}

function verifyPredecessorOverlay(overlay, resources) {
  if (overlay.authority !== resources.identities.host.authority
    || overlay.keyId !== resources.identities.host.keyId || overlay.installationId !== resources.installationId
    || typeof overlay.signature !== 'string') fail('predecessor Host overlay identity differs')
  const { signature, ...unsigned } = overlay
  if (!verify(null, Buffer.from(canonical(unsigned)), resources.identities.host.publicKeyPem,
    Buffer.from(signature, 'base64'))) fail('predecessor Host overlay signature differs')
}

function intentShape(intent, homePath, profile, oldManifestSource) {
  const { manifest, overlay, resources } = manifestProof(oldManifestSource, homePath, profile)
  if (!keys(intent, ['protocol', 'schemaVersion', 'homePath', 'profile', 'archivePath', 'oldTransactionId',
    'oldManifestDigest', 'oldBindingDigest', 'oldOverlayDigest', 'currentCandidateIdentity',
    'successorTransactionId', 'installer', 'preparationRoot', 'preparationDigest', 'candidateSourceCommit',
    'permissionPreset', 'auxiliaryRoot', 'planPath', 'planDigest', 'issuedAt', 'authority', 'keyId', 'signature'])
    || intent.protocol !== protocol || intent.schemaVersion !== 1 || intent.homePath !== homePath
    || intent.profile !== profile || !validArchive(homePath, intent.archivePath, intent.successorTransactionId)
    || intent.oldTransactionId !== manifest.id || intent.oldManifestDigest !== hash(oldManifestSource)
    || intent.oldBindingDigest !== manifest.bindingDigest
    || intent.oldOverlayDigest !== hash(canonical(overlay))
    || !validIdentity(intent.currentCandidateIdentity)
    || !isDeepStrictEqual(intent.currentCandidateIdentity, manifest.stagedIdentity)
    || !transactionId.test(intent.successorTransactionId)
    || intent.successorTransactionId === manifest.id
    || !exact(intent.preparationRoot) || !hex.test(intent.preparationDigest)
    || !commit.test(intent.candidateSourceCommit)
    || !['workspace-write', 'danger-full-access'].includes(intent.permissionPreset)
    || intent.auxiliaryRoot !== null && !exact(intent.auxiliaryRoot)
    || !exact(intent.planPath) || !hex.test(intent.planDigest)
    || !keys(intent.installer, ['root', 'dev', 'ino', 'digest', 'entries'])
    || !exact(intent.installer.root) || !hex.test(intent.installer.digest)
    || !Number.isSafeInteger(intent.installer.entries) || intent.installer.entries < 1
    || !Number.isSafeInteger(intent.issuedAt) || intent.issuedAt < 1
    || intent.authority !== resources.identities.host.authority
    || intent.keyId !== resources.identities.host.keyId
    || typeof intent.signature !== 'string' || intent.signature.length > 256) {
    fail('successor intent shape or scope differs')
  }
  verifyPredecessorOverlay(overlay, resources)
  const { signature, ...unsigned } = intent
  if (!verify(null, Buffer.from(canonical(unsigned)), resources.identities.host.publicKeyPem,
    Buffer.from(signature, 'base64'))) fail('successor intent signature differs')
  return { manifest, resources }
}

function validIdentity(value) {
  return keys(value, ['dev', 'ino', 'uid', 'mode']) && /^\d+$/u.test(value.dev)
    && /^\d+$/u.test(value.ino) && Number.isSafeInteger(value.uid)
    && Number.isSafeInteger(value.mode)
}

function validArchive(homePath, archivePath, successorTransactionId) {
  return exact(archivePath) && dirname(archivePath) === dirname(homePath)
    && archivePath !== homePath && archivePath !== pendingPath(homePath)
    && transactionId.test(successorTransactionId)
    && archivePath === `${homePath}.dsh-enhanced-transaction.owner-predecessor-${successorTransactionId}`
}

async function fsyncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

async function exclusive(path, source) {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(source); await handle.sync() } finally { await handle.close() }
  await fsyncDirectory(dirname(path))
}

async function archiveEntry(path, source) {
  try { await exclusive(path, source) }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error
    if (!(await stable(path, 4_194_304)).equals(Buffer.from(source))) fail(`archive evidence differs: ${path}`)
  }
}

async function auxiliaryDestination(path, excluded) {
  if (excluded.some(other => inside(other, path) || inside(path, other))) {
    fail('auxiliary preparation destination overlaps bound resources')
  }
  await directory(dirname(path))
  try { await directory(path, true) }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error
    try { await lstat(path); fail('auxiliary preparation destination is dangling') }
    catch (missing) { if (missing?.code !== 'ENOENT') throw missing }
  }
}

export async function peekOwnerRepairSuccessorIntent({ homePath }) {
  if (!exact(homePath)) fail('invalid Home path')
  await directory(dirname(homePath))
  const source = await maybeStable(pendingPath(homePath), 65_536)
  if (source === null) return undefined
  const intent = parsed(source.toString('utf8'), 'pending intent')
  if (intent.protocol !== protocol || intent.homePath !== homePath
    || !validArchive(homePath, intent.archivePath, intent.successorTransactionId)
    || !transactionId.test(intent.oldTransactionId)
    || !transactionId.test(intent.successorTransactionId)) fail('pending successor locator differs')
  return { archivePath: intent.archivePath, oldTransactionId: intent.oldTransactionId,
    successorTransactionId: intent.successorTransactionId }
}

export async function assertOwnerRepairSuccessorAbsent({ homePath }) {
  if (await peekOwnerRepairSuccessorIntent({ homePath }) !== undefined) fail('pending successor requires explicit recovery')
}

async function assertAcceptedSuccessor(acceptedManifestSource, intent, intentDigest, oldManifestSource, homePath, profile) {
  if (typeof acceptedManifestSource !== 'string' || Buffer.byteLength(acceptedManifestSource) > 2_097_152) {
    fail('invalid accepted successor manifest bytes')
  }
  const accepted = parsed(acceptedManifestSource, 'accepted successor manifest')
  const proof = accepted.hostMigration?.localSource
  const plan = parsed((await stable(intent.planPath, 131_072)).toString('utf8'), 'successor plan')
  if (accepted.version !== 4 || accepted.operation !== 'host-update' || accepted.id !== intent.successorTransactionId
    || accepted.homePath !== homePath || accepted.profile !== profile || accepted.state !== 'committed'
    || accepted.hostMigration?.phase !== 'committed' || accepted.hostMigration.candidateEverStarted !== true
    || proof?.protocol !== repairProtocol || proof.homePath !== homePath || proof.profile !== profile
    || proof.preparationRoot !== intent.preparationRoot || proof.preparationDigest !== intent.preparationDigest
    || proof.candidate?.sourceCommit !== intent.candidateSourceCommit
    || proof.ownerRepair?.permissionPreset !== intent.permissionPreset
    || !isDeepStrictEqual(accepted.hostMigration.plan, plan)
    || proof.ownerRepair?.predecessor?.sourceProofDigest
      !== hash(JSON.stringify(parsed(oldManifestSource, 'predecessor manifest').hostMigration.localSource))
    || !isDeepStrictEqual(proof.successorIntent, { digest: intentDigest,
      archivePath: intent.archivePath, transactionId: intent.successorTransactionId })
    || proof.auxiliary?.root !== intent.auxiliaryRoot && !(proof.auxiliary == null && intent.auxiliaryRoot === null)
    || !isDeepStrictEqual(proof.installer, intent.installer)) fail('accepted successor binding differs')
  return accepted
}

/** Verifies the signed intent against the predecessor backup; live Home state is the lifecycle caller's responsibility. */
export async function readOwnerRepairSuccessorIntent({ homePath, profile, oldManifestSource, archivePath }) {
  if (!exact(homePath) || !profileName.test(profile)) fail('invalid successor scope')
  await directory(dirname(homePath))
  if (archivePath !== undefined && !exact(archivePath)) fail('invalid successor archive locator')
  const pending = await maybeStable(pendingPath(homePath), 65_536)
  if (pending === null && archivePath === undefined) fail('pending successor intent is absent')
  if (pending === null) await directory(archivePath, true)
  const source = pending ?? await stable(join(archivePath, 'owner-successor-intent.json'), 65_536)
  const intent = parsed(source.toString('utf8'), 'pending intent')
  const { manifest, resources } = intentShape(intent, homePath, profile, oldManifestSource)
  if (archivePath !== undefined && intent.archivePath !== archivePath) fail('successor archive locator changed')
  const archived = await lstat(intent.archivePath).then(() => true, error => {
    if (error?.code === 'ENOENT') return false
    throw error
  })
  const backup = await predecessorBackup(manifest, archived ? intent.archivePath : undefined,
    intent.successorTransactionId)
  await originalHostKey(homePath, backup, profile, resources)
  await assertLocalSourceInstaller(intent.installer)
  if (hash(await stable(intent.planPath, 131_072)) !== intent.planDigest) {
    fail('successor plan file changed')
  }
  return { intent, source: source.toString('utf8'), digest: hash(source) }
}

export async function createOwnerRepairSuccessorIntent({ homePath, profile, oldManifestSource,
  currentCandidateIdentity, installer, preparationRoot, preparationDigest, candidateSourceCommit,
  permissionPreset, auxiliaryRoot = null, planPath, planDigest, archivePath, successorTransactionId }) {
  if (!exact(homePath) || !profileName.test(profile)
    || !validArchive(homePath, archivePath, successorTransactionId)) fail('invalid successor scope')
  await directory(dirname(homePath))
  const homeIdentity = identity(await directory(homePath, true))
  if (!validIdentity(currentCandidateIdentity) || !isDeepStrictEqual(homeIdentity, currentCandidateIdentity)) {
    fail('current candidate Home identity differs')
  }
  const { manifest, overlay, resources } = manifestProof(oldManifestSource, homePath, profile)
  if (!isDeepStrictEqual(currentCandidateIdentity, manifest.stagedIdentity)) fail('current candidate differs from predecessor transaction')
  verifyPredecessorOverlay(overlay, resources)
  const key = await originalHostKey(homePath, homePath, profile, resources)
  if (!exact(preparationRoot) || !hex.test(preparationDigest) || !commit.test(candidateSourceCommit)
    || !['workspace-write', 'danger-full-access'].includes(permissionPreset)
    || auxiliaryRoot !== null && !exact(auxiliaryRoot) || !exact(planPath) || !hex.test(planDigest)
    || !transactionId.test(successorTransactionId) || successorTransactionId === manifest.id) {
    fail('invalid candidate successor request')
  }
  await directory(preparationRoot, true)
  if (auxiliaryRoot !== null) await auxiliaryDestination(auxiliaryRoot,
    [homePath, installer.root, preparationRoot, archivePath, `${homePath}.dsh-enhanced-transaction`])
  await assertLocalSourceInstaller(installer)
  if (hash(await stable(planPath, 131_072)) !== planDigest) fail('successor plan file differs')
  const request = { protocol, schemaVersion: 1, homePath, profile, archivePath,
    oldTransactionId: manifest.id, oldManifestDigest: hash(oldManifestSource),
    oldBindingDigest: manifest.bindingDigest, oldOverlayDigest: hash(canonical(overlay)),
    currentCandidateIdentity: homeIdentity, successorTransactionId, installer, preparationRoot,
    preparationDigest, candidateSourceCommit, permissionPreset, auxiliaryRoot, planPath, planDigest,
    authority: resources.identities.host.authority, keyId: resources.identities.host.keyId }
  const existing = await maybeStable(pendingPath(homePath), 65_536)
  if (existing !== null) {
    const read = await readOwnerRepairSuccessorIntent({ homePath, profile, oldManifestSource })
    const { issuedAt: _issuedAt, signature: _signature, ...prior } = read.intent
    if (!isDeepStrictEqual(prior, request)) fail('pending successor request differs')
    return read
  }
  try { await lstat(archivePath); fail('successor archive path already exists') }
  catch (error) { if (error?.code !== 'ENOENT') throw error }
  const unsigned = { ...request, issuedAt: Date.now() }
  const intent = { ...unsigned, signature: sign(null, Buffer.from(canonical(unsigned)), key).toString('base64') }
  intentShape(intent, homePath, profile, oldManifestSource)
  const source = `${JSON.stringify(intent)}\n`
  if (Buffer.byteLength(source) > 65_536) fail('successor intent exceeds bound')
  try { await exclusive(pendingPath(homePath), source) }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const read = await readOwnerRepairSuccessorIntent({ homePath, profile, oldManifestSource })
    const { issuedAt: _issuedAt, signature: _signature, ...prior } = read.intent
    if (!isDeepStrictEqual(prior, request)) fail('pending successor request differs')
    return read
  }
  return readOwnerRepairSuccessorIntent({ homePath, profile, oldManifestSource })
}

export async function finalizeOwnerRepairSuccessorIntent({ homePath, profile, oldManifestSource,
  acceptedManifestSource, readinessVerified, archivePath, intentSource }) {
  if (readinessVerified !== true) fail('fresh successor readiness was not verified by lifecycle')
  const pending = await maybeStable(pendingPath(homePath), 65_536)
  const source = pending?.toString('utf8')
  const { intent, digest } = await readOwnerRepairSuccessorIntent({ homePath, profile, oldManifestSource,
    archivePath })
  if (intentSource !== undefined && intentSource !== (source
    ?? (await stable(join(intent.archivePath, 'owner-successor-intent.json'), 65_536)).toString('utf8'))) {
    fail('caller intent bytes changed')
  }
  await assertAcceptedSuccessor(acceptedManifestSource, intent, digest, oldManifestSource, homePath, profile)
  await directory(intent.archivePath, true)
  if (hash(await stable(join(intent.archivePath, 'manifest.json'), 2_097_152)) !== intent.oldManifestDigest) {
    fail('archived predecessor manifest changed')
  }
  const auditIntentPath = join(intent.archivePath, 'owner-successor-intent.json')
  const auditAcceptedPath = join(intent.archivePath, 'owner-successor-accepted-manifest.json')
  if (source === undefined) {
    const archivedIntent = await stable(auditIntentPath, 65_536)
    const archivedAccepted = await stable(auditAcceptedPath, 2_097_152)
    if (hash(archivedIntent) !== digest) fail('archived successor intent changed')
    await assertAcceptedSuccessor(archivedAccepted.toString('utf8'), intent, digest, oldManifestSource, homePath, profile)
    return { intentDigest: digest, acceptedManifestDigest: hash(archivedAccepted), archivePath: intent.archivePath }
  }
  await archiveEntry(auditIntentPath, source)
  const priorAccepted = await maybeStable(auditAcceptedPath, 2_097_152)
  if (priorAccepted === null) await exclusive(auditAcceptedPath, acceptedManifestSource)
  else await assertAcceptedSuccessor(priorAccepted.toString('utf8'), intent, digest, oldManifestSource, homePath, profile)
  await fsyncDirectory(intent.archivePath)
  const current = await stable(pendingPath(homePath), 65_536)
  if (hash(current) !== digest) fail('pending successor changed before finalization')
  await unlink(pendingPath(homePath))
  await fsyncDirectory(dirname(homePath))
  return { intentDigest: digest, acceptedManifestDigest: hash(priorAccepted ?? acceptedManifestSource),
    archivePath: intent.archivePath }
}
