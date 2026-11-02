/** Internal stopped-owner installer seam. Source/config authenticity and copy
 * validation belong to owner-program-update; this module never creates grants. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual as same } from 'node:util'
import { join, relative, sep } from 'node:path'

const protocol = 'dsh-owner-empty-adoption-handoff/v1'
const SHA = /^[a-f0-9]{64}$/u
const fail = message => { throw new Error(`owner empty adoption handoff: ${message}`) }
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !item.enumerable || !('value' in item))) fail('invalid public evidence')
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex')
export function assertOwnerEmptyAdoptionMaintenanceApi(api) {
  for (const name of ['planEmptyAdoptionHandoff', 'applyEmptyAdoptionHandoff', 'verifyEmptyAdoptionHandoff']) {
    if (typeof api?.control?.[name] !== 'function') fail(`reviewed maintenance API unavailable: ${name}`)
  }
}
function checkHistory(owner, history, physicalHome, stopped = false) {
  if (history?.protocol !== 'dsh-owner-empty-creation-history/v1' || history.status !== 'empty'
    || history.logicalHome !== owner.homePath || history.physicalHome !== physicalHome
    || history.installationId !== owner.original.resources.installationId || history.profile !== owner.profile
    || history.adoption?.status !== 'empty' || !SHA.test(history.digest)
    || history.adoption.logicalPath !== join(owner.original.resources.stateRoot, 'control-plane', 'creation-adoptions.sqlite')
    || history.adoption.physicalPath !== join(physicalHome, relative(owner.homePath, history.adoption.logicalPath))
    || !same(history.adoption.counts, { authority: 1, adoptions: 0, calls: 0, sourceArchives: 0 })
    || stopped && (history.adoption.sidecars?.wal !== null || history.adoption.sidecars?.shm !== null)) fail('stopped empty history is not bound')
}
export async function stageOwnerEmptyAdoptionHandoff({ ownerUpdate, stageHome, transactionId, manifest,
  candidateCreation, stageHistory, source, sourceBuild, api }) {
  assertOwnerEmptyAdoptionMaintenanceApi(api)
  if (ownerUpdate.original.build?.backend === 'linux-native' || sourceBuild?.backend !== 'linux-native'
    || candidateCreation?.backendTransition !== 'docker->linux-native') fail('unsupported backend transition')
  checkHistory(ownerUpdate, candidateCreation.emptyCreationHistory, ownerUpdate.homePath)
  checkHistory(ownerUpdate, stageHistory, stageHome, true)
  if (candidateCreation.emptyCreationHistory.adoption.authorityDigest !== stageHistory.adoption.authorityDigest
    || !same(candidateCreation.emptyCreationHistory.reviews.map(item => [item.lane, item.status, item.logicalPath]),
      stageHistory.reviews.map(item => [item.lane, item.status, item.logicalPath]))) fail('source history scope changed')
  const original = ownerUpdate.original
  const oldConfig = original.manifest.controlPlane.creationCapabilities
  const nextConfig = manifest.controlPlane.creationCapabilities
  if (!same(oldConfig, original.manifest.pluginCreation.capabilities)
    || !same(nextConfig, manifest.pluginCreation.capabilities)) fail('capability mirrors differ')
  const now = Date.now()
  const expiresAt = Math.min(now + 300_000, oldConfig.expiresAt, nextConfig.expiresAt,
    oldConfig.runner.expiresAt, nextConfig.runner.expiresAt)
  const hostAnchor = digest({ protocol: `${protocol}:host-anchor`, transactionId,
    installationId: original.resources.installationId, profile: ownerUpdate.profile, logicalHome: ownerUpdate.homePath,
    bootstrapDigest: createHash('sha256').update(original.receiptSource).digest('hex'),
    originalFiles: original.fileDigests, originalPatches: original.patchDigests,
    hostPlanDigest: ownerUpdate.hostPlanDigest, originalHistoryDigest: candidateCreation.emptyCreationHistory.digest,
    stageHistoryDigest: stageHistory.digest, source, sourceBuild,
    candidateCreationReceiptDigest: candidateCreation.receiptSha256, nextConfigDigest: digest(nextConfig) })
  const plan = await api.control.planEmptyAdoptionHandoff({ physicalPath: stageHistory.adoption.physicalPath,
    logicalPath: stageHistory.adoption.logicalPath, transactionId, hostAnchor, oldConfig, nextConfig, now, expiresAt })
  if (plan.oldIdentity.authorityDigest !== stageHistory.adoption.authorityDigest) fail('planned old authority differs')
  const expectedPlanDigest = plan.digest
  const proof = await api.control.applyEmptyAdoptionHandoff(plan, { now: Date.now(), expectedPlanDigest, expectedHostAnchor: hostAnchor })
  const metadata = { protocol, transactionId, logicalPath: plan.oldIdentity.logicalPath,
    planDigest: expectedPlanDigest, proofDigest: proof.digest, hostAnchor, fileIdentity: proof.fileIdentity }
  return { metadata, plan }
}

/** Metadata is signed; the full plan is carried by the durable transaction, never inferred from the DB. */
export async function verifyOwnerEmptyAdoptionHandoff({ ownerUpdate, ownerUpdateNext, manifest,
  metadata, physicalHome, stoppedEmptyAdoption, api }) {
  const carried = ownerUpdateNext?.emptyAdoptionHandoff
  if (!metadata && !carried) {
    if (stoppedEmptyAdoption && manifest.controlPlane?.sourceBuild?.backend === 'linux-native') fail('signed empty handoff missing')
    return
  }
  if (!metadata || !carried || !same(metadata, carried.metadata) || metadata.protocol !== protocol
    || metadata.transactionId !== ownerUpdateNext.transactionId
    || metadata.logicalPath !== join(ownerUpdate.original.resources.stateRoot, 'control-plane', 'creation-adoptions.sqlite')
    || metadata.logicalPath !== carried.plan?.oldIdentity?.logicalPath
    || metadata.planDigest !== carried.plan?.digest || metadata.hostAnchor !== carried.plan?.hostAnchor
    || !same(metadata.fileIdentity, carried.plan?.snapshot?.identity)
    || !same(carried.plan.oldIdentity.config, ownerUpdate.original.manifest.controlPlane.creationCapabilities)
    || !same(carried.plan.nextIdentity.config, manifest.controlPlane.creationCapabilities)) fail('signed handoff or current authority differs')
  const { digest: planDigest, ...body } = carried.plan
  if (!SHA.test(metadata.proofDigest) || digest(body) !== planDigest) fail('carried plan digest differs')
  if (!stoppedEmptyAdoption) return // normal readiness/future original checks must permit new business
  assertOwnerEmptyAdoptionMaintenanceApi(api)
  const tail = relative(ownerUpdate.homePath, metadata.logicalPath)
  if (tail.startsWith(`..${sep}`) || tail === '..') fail('logical journal escaped Home')
  await api.control.verifyEmptyAdoptionHandoff({ physicalPath: join(physicalHome, tail), plan: carried.plan,
    expectedProofDigest: metadata.proofDigest })
}
