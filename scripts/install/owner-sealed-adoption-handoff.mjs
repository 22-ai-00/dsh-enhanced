/** Internal stopped-owner installer seam for the sealed-history Docker→linux-native handoff.
 * Source/config authenticity and copy validation belong to owner-program-update; this module
 * never creates, refunds or extends grants. The old journal is archived read-only by the
 * control-plane maintenance API; the live journal starts empty and keeps counting the
 * inherited adoption and call usage. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual as same } from 'node:util'
import { join, relative, sep } from 'node:path'

const protocol = 'dsh-owner-sealed-adoption-handoff/v1'
const HISTORY = 'dsh-owner-creation-history/v2'
const SHA = /^[a-f0-9]{64}$/u
const fail = message => { throw new Error(`owner sealed adoption handoff: ${message}`) }
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !item.enumerable || !('value' in item))) fail('invalid public evidence')
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex')
const usage = value => value && typeof value === 'object' && same(Object.keys(value).sort(), ['adoptions', 'calls'])
  && [value.adoptions, value.calls].every(n => Number.isSafeInteger(n) && n >= 0)

export function assertOwnerSealedAdoptionMaintenanceApi(api) {
  for (const name of ['planSealedAdoptionHandoff', 'applySealedAdoptionHandoff', 'verifySealedAdoptionHandoff',
    'readSealedAdoptionHandoffDigest']) {
    if (typeof api?.control?.[name] !== 'function') fail(`reviewed maintenance API unavailable: ${name}`)
  }
}

/** Logical archive path: one per old authority, so a later archive can never be swapped in (ABA). */
export function ownerSealedArchiveLogicalPath(stateRoot, oldAuthorityDigest) {
  if (!SHA.test(oldAuthorityDigest)) fail('invalid old authority digest')
  return join(stateRoot, 'control-plane', 'creation-adoptions.sealed', `${oldAuthorityDigest}.sqlite`)
}

function checkHistory(owner, history, physicalHome, stopped = false) {
  if (history?.protocol !== HISTORY || history.status !== 'sealable'
    || history.logicalHome !== owner.homePath || history.physicalHome !== physicalHome
    || history.installationId !== owner.original.resources.installationId || history.profile !== owner.profile
    || history.adoption?.status !== 'sealable' || !SHA.test(history.digest) || !SHA.test(history.adoption.authorityDigest)
    || history.adoption.logicalPath !== join(owner.original.resources.stateRoot, 'control-plane', 'creation-adoptions.sqlite')
    || history.adoption.physicalPath !== join(physicalHome, relative(owner.homePath, history.adoption.logicalPath))
    || history.adoption.counts?.authority !== 1
    || stopped && (history.adoption.sidecars?.wal !== null || history.adoption.sidecars?.shm !== null)) fail('stopped sealable history is not bound')
}

export async function stageOwnerSealedAdoptionHandoff({ ownerUpdate, stageHome, transactionId, manifest,
  candidateCreation, stageHistory, source, sourceBuild, api }) {
  assertOwnerSealedAdoptionMaintenanceApi(api)
  if (ownerUpdate.original.build?.backend === 'linux-native' || sourceBuild?.backend !== 'linux-native'
    || candidateCreation?.backendTransition !== 'docker->linux-native') fail('unsupported backend transition')
  const live = candidateCreation.creationHistory
  checkHistory(ownerUpdate, live, ownerUpdate.homePath)
  checkHistory(ownerUpdate, stageHistory, stageHome, true)
  // The stopped stage must be the live history the owner saw, not a later or different one.
  if (live.adoption.authorityDigest !== stageHistory.adoption.authorityDigest
    || !same(live.adoption.counts, stageHistory.adoption.counts)
    || !same(live.adoption.byStatus, stageHistory.adoption.byStatus)
    || !same(live.adoption.callsByStatus, stageHistory.adoption.callsByStatus)
    || live.adoption.storageDigest !== stageHistory.adoption.storageDigest
    || !same(live.reviews.map(item => [item.lane, item.status, item.logicalPath]),
      stageHistory.reviews.map(item => [item.lane, item.status, item.logicalPath]))) fail('source history scope changed')
  const original = ownerUpdate.original
  const oldConfig = original.manifest.controlPlane.creationCapabilities
  const nextConfig = manifest.controlPlane.creationCapabilities
  if (!same(oldConfig, original.manifest.pluginCreation.capabilities)
    || !same(nextConfig, manifest.pluginCreation.capabilities)) fail('capability mirrors differ')
  const archiveLogicalPath = ownerSealedArchiveLogicalPath(original.resources.stateRoot, stageHistory.adoption.authorityDigest)
  const tail = relative(ownerUpdate.homePath, archiveLogicalPath)
  if (tail === '..' || tail.startsWith(`..${sep}`)) fail('archive escaped Home')
  const archivePhysicalPath = join(stageHome, tail)
  const now = Date.now()
  const expiresAt = Math.min(now + 300_000, oldConfig.expiresAt, nextConfig.expiresAt,
    oldConfig.runner.expiresAt, nextConfig.runner.expiresAt)
  const hostAnchor = digest({ protocol: `${protocol}:host-anchor`, transactionId,
    installationId: original.resources.installationId, profile: ownerUpdate.profile, logicalHome: ownerUpdate.homePath,
    bootstrapDigest: createHash('sha256').update(original.receiptSource).digest('hex'),
    originalFiles: original.fileDigests, originalPatches: original.patchDigests,
    hostPlanDigest: ownerUpdate.hostPlanDigest, originalHistoryDigest: live.digest,
    stageHistoryDigest: stageHistory.digest, archiveLogicalPath, source, sourceBuild,
    candidateCreationReceiptDigest: candidateCreation.receiptSha256, nextConfigDigest: digest(nextConfig) })
  const plan = await api.control.planSealedAdoptionHandoff({ physicalPath: stageHistory.adoption.physicalPath,
    logicalPath: stageHistory.adoption.logicalPath, archiveLogicalPath, archivePhysicalPath,
    transactionId, hostAnchor, oldConfig, nextConfig, now, expiresAt })
  if (plan.oldIdentity?.authorityDigest !== stageHistory.adoption.authorityDigest) fail('planned old authority differs')
  if (plan.history?.counts?.adoptions !== stageHistory.adoption.counts.adoptions
    || plan.history.counts.calls !== stageHistory.adoption.counts.calls) fail('planned history differs from inspected history')
  const expectedPlanDigest = plan.digest
  const proof = await api.control.applySealedAdoptionHandoff(plan, { now: Date.now(), expectedPlanDigest, expectedHostAnchor: hostAnchor })
  if (!usage(proof.inheritedUsage) || !same(proof.inheritedUsage, plan.inheritedUsage)
    || proof.archive?.logicalPath !== archiveLogicalPath || !SHA.test(proof.archive?.digest ?? '')) fail('sealed proof differs from plan')
  const metadata = { protocol, transactionId, logicalPath: plan.oldIdentity.logicalPath, archiveLogicalPath,
    planDigest: expectedPlanDigest, proofDigest: proof.digest, hostAnchor, archiveDigest: proof.archive.digest,
    pendingReverificationDigest: digest(plan.pendingReverification), fileIdentity: proof.fileIdentity,
    archiveFileIdentity: proof.archive.fileIdentity, inheritedUsage: proof.inheritedUsage }
  return { metadata, plan }
}

/** Metadata is signed; the full plan is carried by the durable transaction, never inferred from the DB. */
export async function verifyOwnerSealedAdoptionHandoff({ ownerUpdate, ownerUpdateNext, manifest,
  metadata, physicalHome, stoppedSealedAdoption, api }) {
  const carried = ownerUpdateNext?.sealedAdoptionHandoff
  if (!metadata && !carried) return
  const stateRoot = ownerUpdate.original.resources.stateRoot
  if (!metadata || !carried || !same(metadata, carried.metadata) || metadata.protocol !== protocol
    || metadata.transactionId !== ownerUpdateNext.transactionId
    || metadata.logicalPath !== join(stateRoot, 'control-plane', 'creation-adoptions.sqlite')
    || metadata.logicalPath !== carried.plan?.oldIdentity?.logicalPath
    || metadata.archiveLogicalPath !== ownerSealedArchiveLogicalPath(stateRoot, carried.plan.oldIdentity.authorityDigest)
    || metadata.planDigest !== carried.plan.digest || metadata.hostAnchor !== carried.plan.hostAnchor
    || !same(metadata.fileIdentity, carried.plan.snapshot?.identity)
    || !same(metadata.inheritedUsage, carried.plan.inheritedUsage)
    || metadata.pendingReverificationDigest !== digest(carried.plan.pendingReverification)
    || !same(carried.plan.oldIdentity.config, ownerUpdate.original.manifest.controlPlane.creationCapabilities)
    || !same(carried.plan.nextIdentity.config, manifest.controlPlane.creationCapabilities)) fail('signed handoff or current authority differs')
  const { digest: planDigest, ...body } = carried.plan
  if (!SHA.test(metadata.proofDigest) || !SHA.test(metadata.archiveDigest) || digest(body) !== planDigest) fail('carried plan digest differs')
  // The archive is the exact stopped snapshot bytes, so its signed digest is fixed by the plan.
  if (metadata.archiveDigest !== carried.plan.snapshot?.digest) fail('signed archive digest differs from the sealed snapshot')
  assertOwnerSealedAdoptionMaintenanceApi(api)
  const tails = [metadata.logicalPath, metadata.archiveLogicalPath].map(path => relative(ownerUpdate.homePath, path))
  if (tails.some(tail => tail === '..' || tail.startsWith(`..${sep}`))) fail('logical journal or archive escaped Home')
  if (!stoppedSealedAdoption) {
    // Normal readiness permits new business after cutover, but the live journal must still carry the
    // signed sealed audit: a wholly dropped audit would otherwise refund the inherited usage.
    const stored = await api.control.readSealedAdoptionHandoffDigest({ physicalPath: join(physicalHome, tails[0]) })
    if (stored !== metadata.proofDigest) fail('live journal lost or replaced the signed sealed audit')
    return
  }
  const proof = await api.control.verifySealedAdoptionHandoff({ physicalPath: join(physicalHome, tails[0]),
    archivePhysicalPath: join(physicalHome, tails[1]), plan: carried.plan, expectedProofDigest: metadata.proofDigest })
  // Bind every signed archive/live field to what the stopped files actually prove.
  if (proof?.digest !== metadata.proofDigest || proof.archive?.digest !== metadata.archiveDigest
    || !same(proof.archive?.fileIdentity, metadata.archiveFileIdentity) || !same(proof.fileIdentity, metadata.fileIdentity)
    || !same(proof.inheritedUsage, metadata.inheritedUsage)) fail('signed archive or live identity differs from the stopped proof')
}
