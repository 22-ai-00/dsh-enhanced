import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual as same } from 'node:util'
import { assertLocalSourceInstaller, bindLocalSourceInstaller } from './local-source-maintenance.mjs'

const protocol = 'dsh-enhanced/owner-program-readiness-recovery/v1'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
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
const fail = message => { throw new Error(`Owner program readiness recovery: ${message}`) }
const identity = entry => ({ dev: String(entry.dev), ino: String(entry.ino), uid: entry.uid, mode: entry.mode })

export function recoveryReceiptPath(homePath, transactionId) {
  return `${homePath}.dsh-enhanced-readiness-recovery-${transactionId}.json`
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
  let parsed
  try { parsed = JSON.parse((await privateBytes(path, maximum)).toString('utf8')) } catch (error) {
    if (error?.code === 'ENOENT') throw error
    fail(`invalid private JSON: ${path}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(`invalid private JSON: ${path}`)
  return parsed
}

function scope(manifest, homePath, profile, initial) {
  const migration = manifest?.hostMigration, proof = migration?.localSource, owner = proof?.ownerUpdate
  const expectedPair = `rsi-${profile.slice(0, 43)}-${digest(profile).slice(0, 12)}`
  if (manifest?.version !== 4 || manifest.operation !== 'host-update'
    || !['swapped', 'failed', 'committed', 'cleanup-started'].includes(manifest.state)
    || manifest.homePath !== homePath || manifest.canonicalHome !== homePath || manifest.profile !== profile
    || manifest.transactionPath !== `${homePath}.dsh-enhanced-transaction`
    || migration?.candidateEverStarted !== true || proof?.protocol !== 'dsh-enhanced/host-owner-program-update/v1'
    || migration.nativeSettingsImport !== undefined || !owner?.original?.resources
    || owner.homePath !== homePath || owner.profile !== profile || owner.coordinatorProfile !== expectedPair
    || !same(owner.hostPlan, migration.plan) || owner.hostPlanDigest !== digest(JSON.stringify(migration.plan))
    || !same(proof.installer, owner.installer) || !proof.ownerUpdateNext
    || proof.ownerUpdateNext.transactionId !== manifest.id
    || proof.ownerUpdateNext.overlay?.transactionId !== manifest.id
    || proof.ownerUpdateNext.overlay?.kind !== 'rsi-owner-program-update-overlay'
    || proof.ownerUpdateNext.overlay?.dshHome !== homePath
    || proof.ownerUpdateNext.overlay?.targetProfile !== profile
    || !Array.isArray(manifest.services) || manifest.services.length !== 2
    || !same(manifest.services.map(item => item.profile).sort(), [profile, expectedPair].sort())
    || manifest.services.some(item => item.wasActive !== true || item.unit !== `dsh-profile-${item.profile}.service`)
    || !Array.isArray(manifest.serviceMasks) || manifest.serviceMasks.length !== 2
    || !Array.isArray(manifest.serviceStartBarriers) || manifest.serviceStartBarriers.length !== 2
    || manifest.containmentMasks?.length !== 0 || manifest.containmentMaskIntents?.length !== 0
    || manifest.containmentStartBarriers?.length !== 0 || !Array.isArray(manifest.unitUniverse)
    || !manifest.services.every(item => manifest.unitUniverse.includes(item.unit))
    || !exact(proof.installer.root) || !exact(migration.plan.candidateRuntime?.root)) {
    fail('started owner program candidate scope differs')
  }
  if (initial && (!['swapped', 'failed'].includes(manifest.state)
    || !['starting', 'failed'].includes(migration.phase)
    || manifest.serviceAcceptance !== undefined || migration.programReadinessRecovery !== undefined)) {
    fail('initial permit requires started unaccepted readiness failure')
  }
  if (!initial && !['starting', 'failed', 'accepted', 'committed', 'cleanup-started'].includes(migration.phase)) {
    fail('recovery phase differs')
  }
  return { migration, proof, owner, resources: owner.original.resources }
}

async function hostKey(manifest, homePath, profile) {
  const { resources, proof } = scope(manifest, homePath, profile, false)
  const host = resources.identities?.host
  if (resources.root !== join(homePath, 'rsi-authorities', profile)
    || !host || host.keyPath !== join(resources.root, 'identities', 'host.pem')
    || host.authority !== `${'host'}-${resources.installationId}`
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
      .equals(createPublicKey(host.publicKeyPem).export({ format: 'der', type: 'spki' }))) fail('original Host key differs')
  const overlay = proof.ownerUpdateNext.overlay
  const { signature, ...unsigned } = overlay
  if (overlay.authority !== host.authority || overlay.keyId !== host.keyId
    || overlay.installationId !== resources.installationId || typeof signature !== 'string'
    || !verify(null, Buffer.from(canonical(unsigned)), host.publicKeyPem, Buffer.from(signature, 'base64'))) {
    fail('owner program overlay signature differs')
  }
  return { key, host }
}

function signBody(body, key, host) {
  const unsigned = { ...body, authority: host.authority, keyId: host.keyId }
  return { ...unsigned, signature: sign(null, Buffer.from(canonical(unsigned)), key).toString('base64') }
}

function immutableManifestDigest(manifest) {
  const stable = structuredClone(manifest)
  for (const field of ['state', 'bindingDigest', 'updatedAt', 'serviceAcceptance', 'cleanup']) delete stable[field]
  for (const field of ['phase', 'ownerRepairStartedAt', 'programReadinessRecovery']) {
    delete stable.hostMigration[field]
  }
  return digest(canonical(stable))
}

function verifySigned(value, host) {
  if (value?.authority !== host.authority || value.keyId !== host.keyId
    || typeof value.signature !== 'string' || value.signature.length > 256) fail('signed Host identity differs')
  const { signature, ...unsigned } = value
  if (!verify(null, Buffer.from(canonical(unsigned)), host.publicKeyPem, Buffer.from(signature, 'base64'))) {
    fail('Host signature differs')
  }
}

function permitBody(manifest, installer) {
  const proof = manifest.hostMigration.localSource
  return { protocol, schemaVersion: 1, homePath: manifest.homePath, profile: manifest.profile,
    transactionId: manifest.id, baseManifestDigest: manifest.bindingDigest,
    immutableManifestDigest: immutableManifestDigest(manifest),
    candidateIdentity: manifest.stagedIdentity, originalIdentity: manifest.originalIdentity,
    sourceProofDigest: digest(canonical(proof)), hostPlanDigest: digest(canonical(manifest.hostMigration.plan)),
    sourceCohortDigest: digest(canonical(proof.candidate)),
    ownerGrantDigest: digest(canonical(proof.ownerUpdate.original.manifest.sourceReviews)),
    oldInstaller: proof.installer, readinessInstaller: installer, issuedAt: Date.now() }
}

export function assertRecoveryEnvelope(manifest, envelope, homePath, profile, installerRoot) {
  const { proof, resources } = scope(manifest, homePath, profile, false)
  if (!keys(envelope, ['permit']) || !keys(envelope.permit,
    ['protocol', 'schemaVersion', 'homePath', 'profile', 'transactionId', 'baseManifestDigest',
      'immutableManifestDigest',
      'candidateIdentity', 'originalIdentity', 'sourceProofDigest', 'hostPlanDigest', 'sourceCohortDigest',
      'ownerGrantDigest', 'oldInstaller', 'readinessInstaller', 'issuedAt', 'authority', 'keyId', 'signature'])) {
    fail('recovery envelope shape differs')
  }
  const permit = envelope.permit, expected = permitBody(manifest, permit.readinessInstaller)
  if (permit.protocol !== protocol || permit.schemaVersion !== 1 || permit.homePath !== homePath
    || permit.profile !== profile || permit.transactionId !== manifest.id
    || !Number.isSafeInteger(permit.issuedAt) || permit.issuedAt < 1
    || !same(permit.candidateIdentity, manifest.stagedIdentity)
    || !same(permit.originalIdentity, manifest.originalIdentity)
    || !same(permit.oldInstaller, proof.installer)
    || permit.sourceProofDigest !== expected.sourceProofDigest
    || permit.immutableManifestDigest !== expected.immutableManifestDigest
    || permit.hostPlanDigest !== expected.hostPlanDigest
    || permit.sourceCohortDigest !== expected.sourceCohortDigest
    || permit.ownerGrantDigest !== expected.ownerGrantDigest
    || permit.authority !== resources.identities.host.authority
    || permit.keyId !== resources.identities.host.keyId
    || !exact(permit.readinessInstaller?.root) || permit.readinessInstaller.root !== installerRoot
    || permit.readinessInstaller.root !== root || permit.readinessInstaller.root === proof.installer.root
    || !/^[a-f0-9]{64}$/u.test(permit.baseManifestDigest)
    || !/^[a-f0-9]{64}$/u.test(permit.readinessInstaller.digest)) fail('recovery permit scope differs')
  return permit
}

export async function verifyRecoveryEnvelope({ manifest, envelope, homePath, profile, installerRoot }) {
  const permit = assertRecoveryEnvelope(manifest, envelope, homePath, profile, installerRoot)
  const { host } = await hostKey(manifest, homePath, profile)
  verifySigned(permit, host)
  await assertLocalSourceInstaller(permit.oldInstaller)
  await assertLocalSourceInstaller(permit.readinessInstaller)
  return permit
}

export async function admitOwnerProgramReadinessRecovery({ manifest, homePath, profile, installerRoot }) {
  const initial = manifest.hostMigration?.programReadinessRecovery === undefined
  scope(manifest, homePath, profile, initial)
  if (installerRoot !== root || await realpath(installerRoot) !== installerRoot
    || inside(homePath, installerRoot) || inside(manifest.transactionPath, installerRoot)) {
    fail('readiness installer must be this separate canonical reviewed root')
  }
  const live = identity(await lstat(homePath))
  let backup
  try { backup = identity(await lstat(join(manifest.transactionPath, 'original-home'))) }
  catch (error) { if (error?.code !== 'ENOENT') throw error }
  if (!same(live, manifest.stagedIdentity)
    || (initial || manifest.state !== 'cleanup-started') && !same(backup, manifest.originalIdentity)) {
    fail('candidate or original backup inode differs')
  }
  if (!initial) {
    const envelope = manifest.hostMigration.programReadinessRecovery
    await verifyRecoveryEnvelope({ manifest, envelope, homePath, profile, installerRoot })
    return { envelope, created: false }
  }
  if (!/^[a-f0-9]{64}$/u.test(manifest.bindingDigest)) fail('initial manifest binding differs')
  await assertLocalSourceInstaller(manifest.hostMigration.localSource.installer)
  const installer = await bindLocalSourceInstaller(installerRoot)
  const { key, host } = await hostKey(manifest, homePath, profile)
  const envelope = { permit: signBody(permitBody(manifest, installer), key, host) }
  await verifyRecoveryEnvelope({ manifest, envelope, homePath, profile, installerRoot })
  return { envelope, created: true }
}

export async function awaitOwnerProgramRecoveryReady({ manifest, envelope, homePath, profile, startedAt }) {
  const permit = await verifyRecoveryEnvelope({ manifest, envelope, homePath, profile, installerRoot: root })
  const proof = manifest.hostMigration.localSource
  const oldHelper = join(permit.oldInstaller.root, 'scripts', 'install', 'owner-program-update.mjs')
  if (!inside(permit.oldInstaller.root, await realpath(oldHelper))) fail('old proof helper escaped installer')
  const { verifyOwnerProgramUpdate } = await import(pathToFileURL(oldHelper).href)
  await verifyOwnerProgramUpdate({ ownerUpdate: proof.ownerUpdate, ownerUpdateNext: proof.ownerUpdateNext,
    homePath, installer: permit.oldInstaller, phase: 'after-finalize' })
  const manifestPath = proof.ownerUpdateNext.manifestPath
  const ownerManifest = await privateJson(manifestPath)
  const hostAuthority = await privateJson(join(proof.ownerUpdate.original.resources.configRoot, 'host-authority.json'))
  const original = proof.ownerUpdate.original
  if (digest(await privateBytes(manifestPath)) !== proof.ownerUpdateNext.manifestDigest
    || !same(hostAuthority.grant?.owner, original.manifest.sourceReviews.owner)
    || hostAuthority.grant?.notBefore !== original.now
    || hostAuthority.grant?.expiresAt !== original.manifest.sourceReviews.expiresAt) {
    fail('standing finite Host grant changed')
  }
  if (!Number.isSafeInteger(startedAt) || startedAt < 1 || startedAt > Date.now()) fail('invalid readiness start time')
  const readyPath = join(permit.readinessInstaller.root, 'plugins', 'lark-channel', 'lib', 'rsi-install.js')
  if (!inside(permit.readinessInstaller.root, await realpath(readyPath))) fail('readiness API escaped installer')
  const { rsiInstallPorts } = await import(pathToFileURL(readyPath).href)
  if (typeof rsiInstallPorts?.ready !== 'function') fail('reviewed readiness API is absent')
  await rsiInstallPorts.ready(ownerManifest, hostAuthority.template.systemctl, new AbortController().signal, startedAt)
  await assertLocalSourceInstaller(permit.oldInstaller)
  await assertLocalSourceInstaller(permit.readinessInstaller)
  return { mode: 'ready', manifestDigest: proof.ownerUpdateNext.manifestDigest,
    overlayDigest: proof.ownerUpdateNext.overlayDigest, permitDigest: digest(canonical(permit)) }
}

export async function createRecoveryReceipt({ manifest, envelope, homePath, profile, readiness }) {
  const permit = await verifyRecoveryEnvelope({ manifest, envelope, homePath, profile, installerRoot: root })
  if (readiness?.mode !== 'ready' || readiness.permitDigest !== digest(canonical(permit))) {
    fail('readiness result does not match signed permit')
  }
  const { key, host } = await hostKey(manifest, homePath, profile)
  return signBody({ protocol, schemaVersion: 1, kind: 'readiness-recovery-receipt',
    transactionId: manifest.id, homePath, profile, permitDigest: readiness.permitDigest,
    oldInstallerDigest: permit.oldInstaller.digest, readinessInstallerDigest: permit.readinessInstaller.digest,
    manifestDigest: readiness.manifestDigest, overlayDigest: readiness.overlayDigest,
    verifiedAt: Date.now() }, key, host)
}

export async function verifyRecoveryReceipt({ manifest, envelope, receipt, homePath, profile }) {
  const permit = await verifyRecoveryEnvelope({ manifest, envelope, homePath, profile, installerRoot: root })
  const { host } = await hostKey(manifest, homePath, profile)
  if (!keys(receipt, ['protocol', 'schemaVersion', 'kind', 'transactionId', 'homePath', 'profile',
    'permitDigest', 'oldInstallerDigest', 'readinessInstallerDigest', 'manifestDigest', 'overlayDigest',
    'verifiedAt', 'authority', 'keyId', 'signature']) || receipt.protocol !== protocol
    || receipt.schemaVersion !== 1 || receipt.kind !== 'readiness-recovery-receipt'
    || receipt.transactionId !== manifest.id || receipt.homePath !== homePath || receipt.profile !== profile
    || receipt.permitDigest !== digest(canonical(permit)) || receipt.oldInstallerDigest !== permit.oldInstaller.digest
    || receipt.readinessInstallerDigest !== permit.readinessInstaller.digest
    || receipt.manifestDigest !== manifest.hostMigration.localSource.ownerUpdateNext.manifestDigest
    || receipt.overlayDigest !== manifest.hostMigration.localSource.ownerUpdateNext.overlayDigest
    || !Number.isSafeInteger(receipt.verifiedAt) || receipt.verifiedAt < permit.issuedAt) {
    fail('readiness receipt scope differs')
  }
  verifySigned(receipt, host)
}

export async function readRecoveryReceipt({ manifest, envelope, homePath, profile }) {
  const path = recoveryReceiptPath(homePath, manifest.id)
  let receipt
  try { receipt = await privateJson(path, 65_536) } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  await verifyRecoveryReceipt({ manifest, envelope, receipt, homePath, profile })
  return receipt
}

export const ownerProgramReadinessRecoveryTest = Object.freeze({
  canonical, signBody, verifySigned, permitBody, scope, immutableManifestDigest,
})
