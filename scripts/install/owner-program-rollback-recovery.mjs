import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual as same } from 'node:util'
import { assertLocalSourceInstaller, bindLocalSourceInstaller } from './local-source-maintenance.mjs'

const protocol = 'dsh-enhanced/owner-program-rollback-readiness-recovery/v1'
const reviewedRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const digest = value => createHash('sha256').update(value).digest('hex')
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && same(Object.keys(value).sort(), [...expected].sort())
const exact = path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path
  && !path.includes('\0') && !/[\r\n]/u.test(path)
const inside = (parent, child) => child === parent || child.startsWith(`${parent}${sep}`)
const identity = entry => ({ dev: String(entry.dev), ino: String(entry.ino), uid: entry.uid, mode: entry.mode })
const fail = message => { throw new Error(`Owner program rollback readiness recovery: ${message}`) }

export function rollbackRecoveryIntentPath(homePath, profile) {
  return `${homePath}.dsh-enhanced-rollback-readiness-${profile}.intent.json`
}

function transactionPath(homePath, profile, transactionId, kind) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(profile)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(transactionId)) {
    fail('invalid transaction evidence scope')
  }
  return `${homePath}.dsh-enhanced-rollback-readiness-${profile}-${transactionId}.${kind}.json`
}

export function rollbackRecoveryTransactionIntentPath(homePath, profile, transactionId) {
  return transactionPath(homePath, profile, transactionId, 'intent')
}

export function rollbackRecoveryReceiptPath(homePath, profile, transactionId) {
  return transactionPath(homePath, profile, transactionId, 'receipt')
}

export function rollbackRecoveryArchivePath(homePath, profile, permit) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(profile)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(permit?.transactionId)
    || !/^[a-f0-9]{64}$/u.test(permit?.baseManifestDigest)) fail('invalid deterministic archive scope')
  return `${homePath}.dsh-enhanced-rollback-recovered-${profile}-${permit.transactionId}`
    + `-${permit.baseManifestDigest.slice(0, 16)}-${digest(canonical(permit)).slice(0, 16)}`
}

async function privateBytes(path, maximum = 2_097_152) {
  if (!exact(path) || await realpath(path) !== path) fail(`noncanonical private path: ${path}`)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true }), named = await lstat(path, { bigint: true })
    if (!before.isFile() || before.uid !== BigInt(process.getuid()) || before.nlink !== 1n
      || before.mode & 0o077n || before.size < 1n || before.size > BigInt(maximum)
      || before.dev !== named.dev || before.ino !== named.ino) fail(`unsafe private file: ${path}`)
    const source = await handle.readFile(), after = await handle.stat({ bigint: true })
    if (BigInt(source.length) !== before.size || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail(`private file changed: ${path}`)
    return source
  } finally { await handle.close() }
}

async function privateJson(path, maximum) {
  let value
  try { value = JSON.parse((await privateBytes(path, maximum)).toString('utf8')) } catch (error) {
    if (error?.code === 'ENOENT') throw error
    fail(`invalid private JSON: ${path}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`invalid private JSON: ${path}`)
  return value
}

function scope(manifest, homePath, profile) {
  const migration = manifest?.hostMigration, proof = migration?.localSource, owner = proof?.ownerUpdate
  const coordinator = `rsi-${profile.slice(0, 43)}-${digest(profile).slice(0, 12)}`
  if (manifest?.version !== 4 || manifest.operation !== 'host-update' || manifest.state !== 'preparing'
    || manifest.homePath !== homePath || manifest.canonicalHome !== homePath || manifest.profile !== profile
    || manifest.transactionPath !== `${homePath}.dsh-enhanced-transaction`
    || migration?.phase !== 'prepared' || migration.candidateEverStarted !== false
    || migration.plan?.schemaVersion !== 1 || migration.plan.status !== 'current'
    || !same(migration.plan.originalRuntime, migration.plan.candidateRuntime)
    || migration.programReadinessRecovery !== undefined || migration.nativeSettingsImport !== undefined
    || manifest.serviceAcceptance !== undefined
    || proof?.protocol !== 'dsh-enhanced/host-owner-program-update/v1'
    || owner?.homePath !== homePath || owner.profile !== profile || owner.coordinatorProfile !== coordinator
    || !same(owner.hostPlan, migration.plan) || owner.hostPlanDigest !== digest(JSON.stringify(migration.plan))
    || !same(proof.installer, owner.installer) || proof.ownerUpdateNext !== undefined
    || !owner.original?.resources || !owner.original?.manifest?.sourceReviews
    || !Array.isArray(manifest.services) || manifest.services.length !== 2
    || !same(manifest.services.map(item => item.profile).sort(), [profile, coordinator].sort())
    || manifest.services.some(item => item.wasActive !== true || item.unit !== `dsh-profile-${item.profile}.service`)
    || !Array.isArray(manifest.serviceMasks) || manifest.serviceMasks.length !== 2
    || !Array.isArray(manifest.serviceStartBarriers) || manifest.serviceStartBarriers.length !== 2
    || manifest.containmentMasks?.length !== 0 || manifest.containmentMaskIntents?.length !== 0
    || manifest.containmentStartBarriers?.length !== 0
    || !Array.isArray(migration.units) || migration.units.length !== 2
    || migration.units.some(item => !manifest.services.some(service => service.unit === item.unit
      && service.profile === item.profile) || digest(item.before) !== item.beforeDigest)
    || !exact(proof.installer?.root) || !exact(migration.plan.originalRuntime?.root)) {
    fail('prepared original owner program scope differs')
  }
  return { migration, proof, owner, resources: owner.original.resources }
}

async function hostKey(manifest, homePath, profile) {
  const { resources } = scope(manifest, homePath, profile)
  const host = resources.identities?.host
  if (resources.root !== join(homePath, 'rsi-authorities', profile)
    || !host || host.keyPath !== join(resources.root, 'identities', 'host.pem')
    || host.authority !== `host-${resources.installationId}`
    || host.keyId !== `${host.authority}-key`) fail('original Host identity differs')
  const receipt = await privateJson(join(resources.root, 'bootstrap.json'), 65_536)
  const { receiptDigest, ...body } = receipt
  if (receipt.schemaVersion !== 1 || receipt.dshHome !== homePath || receipt.profile !== profile
    || !same(receipt.resources, resources) || receiptDigest !== digest(JSON.stringify(body))) {
    fail('original authority receipt differs')
  }
  const source = await privateBytes(host.keyPath, 16_384)
  const key = createPrivateKey(source)
  if (key.asymmetricKeyType !== 'ed25519' || receipt.keyDigests?.host !== digest(source)
    || !createPublicKey(key).export({ format: 'der', type: 'spki' })
      .equals(createPublicKey(host.publicKeyPem).export({ format: 'der', type: 'spki' }))) {
    fail('original Host key differs')
  }
  return { key, host }
}

function signBody(body, key, host) {
  const unsigned = { ...body, authority: host.authority, keyId: host.keyId }
  return { ...unsigned, signature: sign(null, Buffer.from(canonical(unsigned)), key).toString('base64') }
}

function verifySigned(value, host) {
  if (value?.authority !== host.authority || value.keyId !== host.keyId
    || typeof value.signature !== 'string' || value.signature.length > 256) fail('signed Host identity differs')
  const { signature, ...unsigned } = value
  if (!verify(null, Buffer.from(canonical(unsigned)), host.publicKeyPem, Buffer.from(signature, 'base64'))) {
    fail('Host signature differs')
  }
}

function immutableManifestDigest(manifest) {
  const stable = structuredClone(manifest)
  for (const field of ['bindingDigest', 'updatedAt']) delete stable[field]
  delete stable.hostMigration.rollbackReadinessRecovery
  return digest(canonical(stable))
}

function permitBody(manifest, installer, activeServices) {
  const { proof, owner, migration } = scope(manifest, manifest.homePath, manifest.profile)
  return { protocol, schemaVersion: 1, homePath: manifest.homePath, profile: manifest.profile,
    transactionId: manifest.id, baseManifestDigest: manifest.bindingDigest,
    immutableManifestDigest: immutableManifestDigest(manifest), originalIdentity: manifest.originalIdentity,
    unitBeforeDigests: migration.units.map(unit => ({ unit: unit.unit, path: unit.path, digest: unit.beforeDigest })),
    activeServices,
    sourceProofDigest: digest(canonical(proof)), hostPlanDigest: digest(canonical(migration.plan)),
    ownerGrantDigest: digest(canonical(owner.original.manifest.sourceReviews)),
    oldInstaller: proof.installer, readinessInstaller: installer, issuedAt: Date.now() }
}

export function assertRollbackRecoveryEnvelope(manifest, envelope, homePath, profile, installerRoot,
  allowHistoricalInstaller = false) {
  const { proof, resources } = scope(manifest, homePath, profile)
  if (!keys(envelope, ['permit']) || !keys(envelope.permit,
    ['protocol', 'schemaVersion', 'homePath', 'profile', 'transactionId', 'baseManifestDigest',
      'immutableManifestDigest', 'originalIdentity', 'unitBeforeDigests', 'activeServices', 'sourceProofDigest',
      'hostPlanDigest', 'ownerGrantDigest', 'oldInstaller', 'readinessInstaller', 'issuedAt',
      'authority', 'keyId', 'signature'])) fail('recovery envelope shape differs')
  const permit = envelope.permit, expected = permitBody(manifest, permit.readinessInstaller, permit.activeServices)
  if (permit.protocol !== protocol || permit.schemaVersion !== 1 || permit.homePath !== homePath
    || permit.profile !== profile || permit.transactionId !== manifest.id
    || !Number.isSafeInteger(permit.issuedAt) || permit.issuedAt < 1
    || !same(permit.originalIdentity, manifest.originalIdentity)
    || !same(permit.unitBeforeDigests, expected.unitBeforeDigests)
    || !Array.isArray(permit.activeServices) || permit.activeServices.length !== 2
    || !same(permit.activeServices.map(item => item.unit).sort(), manifest.services.map(item => item.unit).sort())
    || permit.activeServices.some(item => !keys(item,
      ['unit', 'mainPid', 'invocationId', 'nRestarts', 'startTimestamp', 'startedAt'])
      || !Number.isSafeInteger(item.mainPid) || item.mainPid <= 0
      || !/^[a-f0-9]{32}$/u.test(item.invocationId)
      || !Number.isSafeInteger(item.nRestarts) || item.nRestarts < 0
      || typeof item.startTimestamp !== 'string' || !Number.isSafeInteger(item.startedAt)
      || item.startedAt <= Date.parse(manifest.createdAt)
      || item.invocationId === manifest.services.find(service => service.unit === item.unit)?.invocationId)
    || permit.immutableManifestDigest !== expected.immutableManifestDigest
    || permit.sourceProofDigest !== expected.sourceProofDigest
    || permit.hostPlanDigest !== expected.hostPlanDigest || permit.ownerGrantDigest !== expected.ownerGrantDigest
    || !same(permit.oldInstaller, proof.installer)
    || !exact(permit.readinessInstaller?.root) || permit.readinessInstaller.root !== installerRoot
    || !allowHistoricalInstaller && permit.readinessInstaller.root !== reviewedRoot
    || permit.readinessInstaller.root === proof.installer.root
    || !/^[a-f0-9]{64}$/u.test(permit.baseManifestDigest)
    || !/^[a-f0-9]{64}$/u.test(permit.readinessInstaller.digest)
    || permit.authority !== resources.identities.host.authority
    || permit.keyId !== resources.identities.host.keyId) fail('recovery permit scope differs')
  return permit
}

export async function verifyRollbackRecoveryEnvelope({ manifest, envelope, homePath, profile, installerRoot,
  historical = false }) {
  const permit = assertRollbackRecoveryEnvelope(manifest, envelope, homePath, profile,
    historical ? envelope?.permit?.readinessInstaller?.root : installerRoot, historical)
  const { host } = historical ? { host: scope(manifest, homePath, profile).resources.identities.host }
    : await hostKey(manifest, homePath, profile)
  verifySigned(permit, host)
  if (!historical) {
    await assertLocalSourceInstaller(permit.oldInstaller)
    await assertLocalSourceInstaller(permit.readinessInstaller)
  }
  return permit
}

export async function admitOwnerProgramRollbackRecovery({ manifest, homePath, profile, installerRoot, activeServices }) {
  scope(manifest, homePath, profile)
  if (installerRoot !== reviewedRoot || await realpath(installerRoot) !== installerRoot
    || inside(homePath, installerRoot) || inside(manifest.transactionPath, installerRoot)) {
    fail('readiness installer must be this separate canonical reviewed root')
  }
  if (!same(identity(await lstat(homePath)), manifest.originalIdentity)) fail('original Home inode differs')
  await assertLocalSourceInstaller(manifest.hostMigration.localSource.installer)
  if (manifest.hostMigration.rollbackReadinessRecovery !== undefined) {
    const envelope = manifest.hostMigration.rollbackReadinessRecovery
    await verifyRollbackRecoveryEnvelope({ manifest, envelope, homePath, profile, installerRoot })
    if (!same(envelope.permit.activeServices, activeServices)) fail('original service invocation changed since permit')
    return { envelope, created: false }
  }
  if (!/^[a-f0-9]{64}$/u.test(manifest.bindingDigest)) fail('initial manifest binding differs')
  const installer = await bindLocalSourceInstaller(installerRoot)
  const { key, host } = await hostKey(manifest, homePath, profile)
  const envelope = { permit: signBody(permitBody(manifest, installer, activeServices), key, host) }
  await verifyRollbackRecoveryEnvelope({ manifest, envelope, homePath, profile, installerRoot })
  return { envelope, created: true }
}

export async function createRollbackRecoveryIntent({ manifest, envelope, homePath, profile }) {
  const permit = await verifyRollbackRecoveryEnvelope({ manifest, envelope, homePath, profile,
    installerRoot: reviewedRoot })
  const { key, host } = await hostKey(manifest, homePath, profile)
  return signBody({ protocol, schemaVersion: 1, kind: 'rollback-readiness-recovery-intent',
    transactionId: manifest.id, homePath, profile, permitDigest: digest(canonical(permit)),
    markerManifestDigest: manifest.bindingDigest,
    archivePath: rollbackRecoveryArchivePath(homePath, profile, permit), issuedAt: Date.now() }, key, host)
}

export async function readRollbackRecoveryIntentSource(homePath, profile, transactionId) {
  const path = transactionId === undefined ? rollbackRecoveryIntentPath(homePath, profile)
    : rollbackRecoveryTransactionIntentPath(homePath, profile, transactionId)
  try { return await privateJson(path, 65_536) }
  catch (error) { if (error?.code === 'ENOENT') return undefined; throw error }
}

export async function publishRollbackRecoveryLocator(homePath, profile, intent, verifyPrevious) {
  const path = rollbackRecoveryIntentPath(homePath, profile)
  const prior = await readRollbackRecoveryIntentSource(homePath, profile)
  const syncParent = async () => {
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await directory.sync() } finally { await directory.close() }
  }
  if (same(prior, intent)) { await syncParent(); return false }
  if (prior !== undefined) await verifyPrevious(prior)
  const temporary = `${path}.pending-${randomUUID()}`
  let renamed = false
  try {
    const handle = await open(temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try { await handle.writeFile(`${JSON.stringify(intent)}\n`); await handle.sync() } finally { await handle.close() }
    const reread = await readRollbackRecoveryIntentSource(homePath, profile)
    if (!same(reread, prior)) fail('rollback locator changed during publication')
    await rename(temporary, path)
    renamed = true
    await syncParent()
  } finally {
    if (!renamed) await unlink(temporary).catch(error => { if (error?.code !== 'ENOENT') throw error })
  }
  return true
}

export async function verifyRollbackRecoveryIntent({ manifest, envelope, intent, homePath, profile,
  historical = false }) {
  const permit = await verifyRollbackRecoveryEnvelope({ manifest, envelope, homePath, profile,
    installerRoot: reviewedRoot, historical })
  const { host } = historical ? { host: scope(manifest, homePath, profile).resources.identities.host }
    : await hostKey(manifest, homePath, profile)
  if (!keys(intent, ['protocol', 'schemaVersion', 'kind', 'transactionId', 'homePath', 'profile',
    'permitDigest', 'markerManifestDigest', 'archivePath', 'issuedAt', 'authority', 'keyId', 'signature'])
    || intent.protocol !== protocol || intent.schemaVersion !== 1
    || intent.kind !== 'rollback-readiness-recovery-intent' || intent.transactionId !== manifest.id
    || intent.homePath !== homePath || intent.profile !== profile
    || intent.permitDigest !== digest(canonical(permit)) || intent.markerManifestDigest !== manifest.bindingDigest
    || intent.archivePath !== rollbackRecoveryArchivePath(homePath, profile, permit)
    || !Number.isSafeInteger(intent.issuedAt) || intent.issuedAt < permit.issuedAt) {
    fail('rollback recovery intent scope differs')
  }
  verifySigned(intent, host)
  return intent
}

export async function createRollbackRecoveryReceipt({ manifest, envelope, intent, homePath, profile, accepted }) {
  const permit = await verifyRollbackRecoveryEnvelope({ manifest, envelope, homePath, profile, installerRoot: reviewedRoot })
  await verifyRollbackRecoveryIntent({ manifest, envelope, intent, homePath, profile })
  const expectedUnits = new Set(permit.activeServices.map(service => service.unit))
  if (!Array.isArray(accepted) || accepted.length !== expectedUnits.size
    || accepted.some(item => !expectedUnits.delete(item.unit)
      || !permit.activeServices.some(service => service.unit === item.unit && service.mainPid === item.mainPid
        && service.invocationId === item.invocationId && service.nRestarts === item.nRestarts))) {
    fail('original service readiness acceptance differs')
  }
  const { key, host } = await hostKey(manifest, homePath, profile)
  return signBody({ protocol, schemaVersion: 1, kind: 'rollback-readiness-recovery-receipt',
    transactionId: manifest.id, homePath, profile, permitDigest: digest(canonical(permit)),
    intentDigest: digest(canonical(intent)), archivePath: intent.archivePath,
    originalIdentity: manifest.originalIdentity,
    accepted: accepted.map(item => ({ unit: item.unit, mainPid: item.mainPid, invocationId: item.invocationId })),
    verifiedAt: Date.now() }, key, host)
}

export async function readRollbackRecoveryReceipt({ manifest, envelope, intent, homePath, profile,
  historical = false }) {
  let receipt
  try { receipt = await privateJson(rollbackRecoveryReceiptPath(homePath, profile, manifest.id), 65_536) }
  catch (error) { if (error?.code === 'ENOENT') return undefined; throw error }
  const permit = await verifyRollbackRecoveryEnvelope({ manifest, envelope, homePath, profile,
    installerRoot: reviewedRoot, historical })
  await verifyRollbackRecoveryIntent({ manifest, envelope, intent, homePath, profile, historical })
  const { host } = historical ? { host: scope(manifest, homePath, profile).resources.identities.host }
    : await hostKey(manifest, homePath, profile)
  if (!keys(receipt, ['protocol', 'schemaVersion', 'kind', 'transactionId', 'homePath', 'profile',
    'permitDigest', 'intentDigest', 'archivePath', 'originalIdentity', 'accepted', 'verifiedAt',
    'authority', 'keyId', 'signature'])
    || receipt.protocol !== protocol || receipt.schemaVersion !== 1
    || receipt.kind !== 'rollback-readiness-recovery-receipt' || receipt.transactionId !== manifest.id
    || receipt.homePath !== homePath || receipt.profile !== profile
    || receipt.permitDigest !== digest(canonical(permit))
    || receipt.intentDigest !== digest(canonical(intent)) || receipt.archivePath !== intent.archivePath
    || !same(receipt.originalIdentity, manifest.originalIdentity)
    || !Number.isSafeInteger(receipt.verifiedAt) || receipt.verifiedAt < permit.issuedAt
    || !Array.isArray(receipt.accepted) || receipt.accepted.length !== 2
    || !same(receipt.accepted.map(item => item.unit).sort(), manifest.services.map(item => item.unit).sort())) {
    fail('rollback readiness receipt scope differs')
  }
  verifySigned(receipt, host)
  return receipt
}

export const ownerProgramRollbackRecoveryTest = Object.freeze({
  canonical, signBody, verifySigned, permitBody, scope, immutableManifestDigest,
})
