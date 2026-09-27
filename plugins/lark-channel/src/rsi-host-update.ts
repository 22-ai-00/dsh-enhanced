import { isDeepStrictEqual } from 'node:util'
import { createHash, createPublicKey, sign, verify } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { isMap, isSeq, parseDocument, type YAMLMap } from 'yaml'
import { runtimeConfigDigest } from '@dsh-enhanced/plugin-control-plane'
import type { RsiSetupManifest } from './rsi-profile.js'
import type { RsiAuthorityResources } from './rsi-authority-resources.js'

export interface RsiHostPinReplacement { path: string; sha256: string }
export interface RsiHostRebase {
  oldHostRoot: string
  oldHostVersion: string
  candidateHostVersion: string
  pins: Readonly<Record<string, RsiHostPinReplacement>>
}

function fail(message: string): never { throw new Error(`rsi host update: ${message}`) }
const sha256 = (source: string | Buffer): string => createHash('sha256').update(source).digest('hex')
const hex = /^[a-f0-9]{64}$/u
const profileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const backupName = /^\.([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.plugin-backup-([A-Za-z0-9-]{1,36})$/u
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (record(value)) return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
export interface RsiHostUpdateOverlay {
  schemaVersion: 1; kind: 'rsi-host-update-overlay'; transactionId: string; dshHome: string; targetProfile: string
  installationId: string; currentPlanId: string; activationId: string
  sequence: number; previousDigest: string | null; bootstrapDigest: string
  files: Record<string, string>; patches: Record<string, string>; runtimeReceiptDigest: string; planDigest: string
  result: { schemaVersion: 1; manifestPath: string; manifestDigest: string; targetProfile: string; coordinatorProfile: string }
  issuedAt: number; authority: string; keyId: string; signature: string
}
export function rsiHostUpdateOverlayDigest(value: RsiHostUpdateOverlay): string { return sha256(canonical(value)) }
function overlayShape(value: unknown, resources: RsiAuthorityResources, home: string, profile: string,
  bootstrapDigest: string, sequence: number, previousDigest: string | null): asserts value is RsiHostUpdateOverlay {
  if (!record(value) || !isDeepStrictEqual(Object.keys(value).sort(), ['schemaVersion', 'kind', 'transactionId', 'dshHome',
    'targetProfile', 'installationId', 'currentPlanId', 'activationId', 'sequence', 'previousDigest', 'bootstrapDigest', 'files', 'patches',
    'runtimeReceiptDigest', 'planDigest', 'result', 'issuedAt', 'authority', 'keyId', 'signature'].sort())
    || value.schemaVersion !== 1 || value.kind !== 'rsi-host-update-overlay'
    || value.dshHome !== home || value.targetProfile !== profile || value.installationId !== resources.installationId
    || typeof value.currentPlanId !== 'string' || !value.currentPlanId || typeof value.activationId !== 'string' || !value.activationId
    || value.sequence !== sequence || value.previousDigest !== previousDigest || value.bootstrapDigest !== bootstrapDigest
    || value.authority !== resources.identities.host.authority || value.keyId !== resources.identities.host.keyId
    || typeof value.transactionId !== 'string' || !value.transactionId || !Number.isSafeInteger(value.issuedAt)
    || !hex.test(String(value.runtimeReceiptDigest)) || !hex.test(String(value.planDigest))
    || !record(value.files) || !record(value.patches) || Object.keys(value.files).length > 64
    || Object.keys(value.patches).length < 2 || Object.keys(value.patches).length > 8
    || Object.entries(value.files).some(([path, digest]) => !isAbsolute(path) || resolve(path) !== path
      || !path.startsWith(`${resources.configRoot}/`) || !hex.test(String(digest)))
    || !hex.test(String(value.patches[profile]))
    || !profileName.test(String(record(value.result) ? value.result.coordinatorProfile : undefined))
    || !hex.test(String(value.patches[String(record(value.result) ? value.result.coordinatorProfile : undefined)]))
    || Object.entries(value.patches).some(([name, digest]) => !(profileName.test(name)
      || backupName.exec(name)?.[1] === profile) || !hex.test(String(digest)))
    || !record(value.result) || value.result.targetProfile !== profile || value.result.coordinatorProfile === profile
    || value.result.manifestPath !== `${resources.configRoot}/manifest.json`
    || value.result.manifestDigest !== value.files[value.result.manifestPath]
    || typeof value.signature !== 'string' || value.signature.length > 256) fail('overlay shape or scope differs')
  const { signature, ...unsigned } = value
  const key = createPublicKey(resources.identities.host.publicKeyPem)
  if (key.asymmetricKeyType !== 'ed25519'
    || !verify(null, Buffer.from(canonical(unsigned)), key, Buffer.from(signature, 'base64'))) fail('overlay signature differs')
}
export function readRsiHostUpdateOverlayChain(input: {
  source: string | undefined; resources: RsiAuthorityResources; dshHome: string; profile: string; bootstrapSource: string
}): { records: RsiHostUpdateOverlay[]; latest?: RsiHostUpdateOverlay } {
  if (input.source === undefined) return { records: [] }
  let parsed: unknown
  try { parsed = JSON.parse(input.source) } catch { fail('overlay JSON is invalid') }
  if (!record(parsed) || parsed.schemaVersion !== 1 || parsed.kind !== 'rsi-host-update-overlays'
    || !Array.isArray(parsed.records) || parsed.records.length < 1 || parsed.records.length > 64) fail('overlay chain is invalid')
  const records: RsiHostUpdateOverlay[] = []
  const bootstrapDigest = sha256(input.bootstrapSource)
  for (const value of parsed.records) {
    overlayShape(value, input.resources, input.dshHome, input.profile, bootstrapDigest,
      records.length + 1, records.length ? rsiHostUpdateOverlayDigest(records.at(-1)!) : null)
    if (records.length && value.issuedAt < records.at(-1)!.issuedAt) fail('overlay time moved backwards')
    records.push(value)
  }
  return { records, latest: records.at(-1)! }
}
export function signRsiHostUpdateOverlay(input: Omit<RsiHostUpdateOverlay, 'signature'>,
  privateKeyPem: string, resources: RsiAuthorityResources, bootstrapSource: string,
  previous: readonly RsiHostUpdateOverlay[]): RsiHostUpdateOverlay {
  const record = { ...input, signature: sign(null, Buffer.from(canonical(input)), privateKeyPem).toString('base64') }
  overlayShape(record, resources, input.dshHome, input.targetProfile, sha256(bootstrapSource),
    previous.length + 1, previous.length ? rsiHostUpdateOverlayDigest(previous.at(-1)!) : null)
  return record
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Replace only exact pinned assets and the installed DSH baseline version.
 * Arbitrary old-Host path strings are rejected instead of guessed. */
export function rebaseRsiHostValue<T>(value: T, rebase: RsiHostRebase): T {
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') {
      if (item === rebase.oldHostRoot || item.startsWith(`${rebase.oldHostRoot}/`)) fail(`unmapped Host path: ${item}`)
      return item
    }
    if (Array.isArray(item)) return item.map(visit)
    if (!record(item)) return item
    const oldPath = typeof item.path === 'string' ? item.path : undefined
    const pin = oldPath === undefined ? undefined : rebase.pins[oldPath]
    if (pin !== undefined && oldPath !== undefined) {
      if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)) fail('pinned asset is malformed')
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key,
        key === 'path' ? pin.path : key === 'sha256' ? pin.sha256
          : key === 'version' && child === rebase.oldHostVersion && oldPath.startsWith(`${rebase.oldHostRoot}/`)
            ? rebase.candidateHostVersion : visit(child)]))
    }
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [key,
      key === 'dshBaseline' && child === rebase.oldHostVersion ? rebase.candidateHostVersion : visit(child)]))
  }
  return visit(value) as T
}

function document(source: string, label: string) {
  const value = parseDocument(source, { uniqueKeys: true, strict: true })
  if (value.errors.length || value.warnings.length || !isSeq(value.contents)) fail(`${label} is not a bounded patch`)
  return value
}
function row(document: ReturnType<typeof parseDocument>, id: string): YAMLMap {
  let found: YAMLMap | undefined
  const operations = document.contents
  if (!isSeq(operations)) fail('patch operations are invalid')
  for (const operation of operations.items) {
    if (!isMap(operation)) fail('patch operation is not a map')
    if (operation.get('id') === id) {
      if (found) fail(`duplicate patch row: ${id}`)
      found = operation
    }
    for (const kind of ['insert', 'update']) {
      const entries = operation.get(kind, true)
      if (entries === undefined) continue
      if (!isSeq(entries)) fail('patch rows are not a sequence')
      for (const candidate of entries.items) {
        if (!isMap(candidate)) fail('patch row is not a map')
        if (candidate.get('id') === id) {
          if (found) fail(`duplicate patch row: ${id}`)
          found = candidate
        }
      }
    }
  }
  if (!found) fail(`patch row is missing: ${id}`)
  return found
}
function config(value: YAMLMap): Record<string, unknown> {
  const node = value.get('config', true)
  if (!isMap(node)) fail('patch row config is not a map')
  const result = node.toJSON()
  if (!record(result)) fail('patch row config is invalid')
  return result
}
function targetDigest(manifest: RsiSetupManifest, id: string, patch: ReturnType<typeof parseDocument>): string {
  const source = config(row(patch, id))
  return runtimeConfigDigest(id === 'dsh-enhanced-assistant-verifier'
    ? { ...source, sourceReviews: manifest.sourceReviews } : source)
}

/** Preserve unrelated patch rows and original observer identities. */
export function rebaseRsiHostProfiles(input: {
  manifest: RsiSetupManifest
  targetPatch: string
  coordinatorPatch: string
  rebase: RsiHostRebase
}): { manifest: RsiSetupManifest; targetPatch: string; coordinatorPatch: string } {
  const oldTarget = document(input.targetPatch, 'target patch')
  const coordinator = document(input.coordinatorPatch, 'coordinator patch')
  const changed = rebaseRsiHostValue(input.manifest, input.rebase)
  const target = document(input.targetPatch, 'target patch')
  const replacements = new Map<string, unknown>([
    ['dsh-enhanced-plugin-control-plane', changed.controlPlane],
    ['dsh-enhanced-assistant-growth-driver', changed.growthDriver],
  ])
  for (const [id, value] of replacements) {
    const current = config(row(oldTarget, id))
    const original = id === 'dsh-enhanced-plugin-control-plane' ? input.manifest.controlPlane : input.manifest.growthDriver
    if (!isDeepStrictEqual(current, original)) fail(`${id} patch differs from the owner manifest`)
    row(target, id).set('config', target.createNode(value))
  }
  const verifier = row(target, 'dsh-enhanced-assistant-verifier')
  const verifierConfig = config(verifier)
  if (!isDeepStrictEqual(verifierConfig.sourceReviews, input.manifest.sourceReviews)) fail('verifier patch differs from the owner manifest')
  verifier.set('config', target.createNode({ ...verifierConfig, sourceReviews: changed.sourceReviews }))
  const targets = changed.controlPlane.runtimeObserver?.targets
  if (!targets) fail('runtime observer targets are missing')
  for (const targetEntry of targets) {
    if (!replacements.has(targetEntry.entryId) && targetEntry.entryId !== 'dsh-enhanced-assistant-verifier') continue
    const oldDigest = targetDigest(input.manifest, targetEntry.entryId, oldTarget)
    if (targetEntry.configDigest !== oldDigest) fail(`observer digest differs: ${targetEntry.entryId}`)
    targetEntry.configDigest = targetDigest(changed, targetEntry.entryId, target)
  }
  // A coordinator patch may contain only its declared standalone scope. It
  // must not carry any old Host path that this rebase cannot account for.
  if (input.coordinatorPatch.includes(input.rebase.oldHostRoot)) fail('coordinator patch has an unmapped Host path')
  return { manifest: changed, targetPatch: target.toString({ lineWidth: 0 }), coordinatorPatch: coordinator.toString({ lineWidth: 0 }) }
}

/** Rebase the deployed patch itself. An adoption may have replaced the original
 * bootstrap rows, so the historical manifest cannot be used as their source. */
export function rebaseRsiHostActivePatch(input: { patch: string; rebase: RsiHostRebase }): string {
  const documentBefore = document(input.patch, 'active patch')
  const documentAfter = document(input.patch, 'active patch')
  const ids = ['dsh-enhanced-plugin-control-plane', 'dsh-enhanced-assistant-growth-driver',
    'dsh-enhanced-assistant-verifier']
  for (const id of ids) {
    const current = config(row(documentBefore, id))
    row(documentAfter, id).set('config', documentAfter.createNode(rebaseRsiHostValue(current, input.rebase)))
  }
  const cp = config(row(documentAfter, ids[0]!))
  const observer = cp.runtimeObserver
  if (!record(observer) || !Array.isArray(observer.targets)) fail('active runtime observer is missing')
  for (const entry of observer.targets) {
    if (!record(entry) || typeof entry.entryId !== 'string' || typeof entry.configDigest !== 'string') fail('active observer entry differs')
    if (!ids.includes(entry.entryId)) continue
    const oldConfig = config(row(documentBefore, entry.entryId))
    const newConfig = config(row(documentAfter, entry.entryId))
    const oldDigest = runtimeConfigDigest(oldConfig)
    if (entry.configDigest !== oldDigest) fail(`active observer digest differs: ${entry.entryId}`)
    entry.configDigest = runtimeConfigDigest(newConfig)
  }
  row(documentAfter, ids[0]!).set('config', documentAfter.createNode(cp))
  if (JSON.stringify(documentAfter.toJSON()).includes(input.rebase.oldHostRoot)) fail('active patch retains an unmapped Host path')
  return documentAfter.toString({ lineWidth: 0 })
}

/** The owner manifest is historical bootstrap authority; rebase only its
 * verified baseline pins and observer digests, independently of live adoption. */
export function rebaseRsiHostManifest(manifest: RsiSetupManifest, rebase: RsiHostRebase): RsiSetupManifest {
  const changed = rebaseRsiHostValue(manifest, rebase)
  const oldTargets = manifest.controlPlane.runtimeObserver?.targets
  const newTargets = changed.controlPlane.runtimeObserver?.targets
  if (!oldTargets || !newTargets || oldTargets.length !== newTargets.length) fail('owner observer targets differ')
  const configFor = (source: RsiSetupManifest, id: string): unknown => id === 'dsh-enhanced-plugin-control-plane'
    ? source.controlPlane : id === 'dsh-enhanced-assistant-growth-driver' ? source.growthDriver
      : id === 'dsh-enhanced-assistant-verifier' ? { sourceReviews: source.sourceReviews } : undefined
  for (let index = 0; index < oldTargets.length; index++) {
    const oldTarget = oldTargets[index]!, nextTarget = newTargets[index]!
    if (oldTarget.entryId !== nextTarget.entryId) fail('owner observer entry changed')
    const before = configFor(manifest, oldTarget.entryId)
    const after = configFor(changed, nextTarget.entryId)
    if (before === undefined || after === undefined) continue
    if (oldTarget.entryId === 'dsh-enhanced-assistant-verifier') continue // Its full patch config is not stored in the manifest.
    if (oldTarget.configDigest !== runtimeConfigDigest(before)) fail('owner observer digest differs')
    nextTarget.configDigest = runtimeConfigDigest(after)
  }
  return changed
}
