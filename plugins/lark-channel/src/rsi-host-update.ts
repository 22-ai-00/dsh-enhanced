import { isDeepStrictEqual } from 'node:util'
import { createHash, createPublicKey, sign, verify } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { isAlias, isMap, isScalar, isSeq, parseDocument, type Node, type YAMLMap } from 'yaml'
import { runtimeConfigDigest } from '@dsh-enhanced/plugin-control-plane'
import type { RsiSetupManifest } from './rsi-profile.js'
import type { RsiAuthorityResources } from './rsi-authority-resources.js'
import { rawLoaderConfig } from './rsi-bootstrap-manifest.js'

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
export interface RsiOwnerRepairOverlay {
  schemaVersion: 1; kind: 'rsi-owner-repair-overlay'; transactionId: string; dshHome: string; targetProfile: string
  installationId: string; sequence: number; previousDigest: string | null; bootstrapDigest: string
  files: Record<string, string>; patches: Record<string, string>; runtimeReceiptDigest: string; planDigest: string
  result: RsiHostUpdateOverlay['result']
  repair: {
    sourceMaintenanceDigest: string
    before: { files: Record<string, string>; patches: Record<string, string>; runtimeReceiptDigest: string
      creationReceiptDigest: string; journalDigest: string }
    after: { creationReceiptDigest: string; journalDigest: string }
    permissionPreset: 'workspace-write' | 'danger-full-access'
  }
  issuedAt: number; authority: string; keyId: string; signature: string
}
export interface RsiOwnerProgramUpdateOverlay extends Omit<RsiOwnerRepairOverlay, 'kind' | 'repair'> {
  kind: 'rsi-owner-program-update-overlay'
  update: {
    sourceMaintenanceDigest: string
    // Caller attests unchanged owner/grants/deadlines/budgets/config; this reader validates only digest shape.
    authorityDigest: string
    hostPlanDigest: string
    before: RsiOwnerRepairOverlay['repair']['before']
    after: RsiOwnerRepairOverlay['repair']['after']
  }
}
export type RsiOwnerOverlay = RsiHostUpdateOverlay | RsiOwnerRepairOverlay | RsiOwnerProgramUpdateOverlay
export function rsiHostUpdateOverlayDigest(value: RsiOwnerOverlay): string { return sha256(canonical(value)) }
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
function repairOverlayShape(value: unknown, resources: RsiAuthorityResources, home: string, profile: string,
  bootstrapDigest: string, sequence: number, previousDigest: string | null): asserts value is RsiOwnerRepairOverlay {
  if (!record(value) || !isDeepStrictEqual(Object.keys(value).sort(), ['schemaVersion', 'kind', 'transactionId', 'dshHome',
    'targetProfile', 'installationId', 'sequence', 'previousDigest', 'bootstrapDigest', 'files', 'patches',
    'runtimeReceiptDigest', 'planDigest', 'result', 'repair', 'issuedAt', 'authority', 'keyId', 'signature'].sort())
    || value.schemaVersion !== 1 || value.kind !== 'rsi-owner-repair-overlay'
    || value.dshHome !== home || value.targetProfile !== profile || value.installationId !== resources.installationId
    || value.sequence !== sequence || value.previousDigest !== previousDigest || value.bootstrapDigest !== bootstrapDigest
    || value.authority !== resources.identities.host.authority || value.keyId !== resources.identities.host.keyId
    || typeof value.transactionId !== 'string' || !value.transactionId || !Number.isSafeInteger(value.issuedAt)
    || !hex.test(String(value.runtimeReceiptDigest)) || !hex.test(String(value.planDigest))
    || !record(value.files) || !record(value.patches) || Object.keys(value.files).length > 64
    || Object.entries(value.files).some(([path, digest]) => !isAbsolute(path) || resolve(path) !== path
      || !path.startsWith(`${resources.configRoot}/`) || !hex.test(String(digest)))
    || !record(value.result) || !isDeepStrictEqual(Object.keys(value.result).sort(),
      ['schemaVersion', 'manifestPath', 'manifestDigest', 'targetProfile', 'coordinatorProfile'].sort())
    || value.result.schemaVersion !== 1 || value.result.targetProfile !== profile
    || !profileName.test(String(value.result.coordinatorProfile)) || value.result.coordinatorProfile === profile
    || value.result.manifestPath !== `${resources.configRoot}/manifest.json`
    || value.result.manifestDigest !== value.files[value.result.manifestPath]
    || !isDeepStrictEqual(Object.keys(value.patches).sort(), [profile, value.result.coordinatorProfile].sort())
    || Object.values(value.patches).some(digest => !hex.test(String(digest)))
    || !record(value.repair) || !isDeepStrictEqual(Object.keys(value.repair).sort(),
      ['sourceMaintenanceDigest', 'before', 'after', 'permissionPreset'].sort())
    || !hex.test(String(value.repair.sourceMaintenanceDigest))
    || !['workspace-write', 'danger-full-access'].includes(String(value.repair.permissionPreset))
    || !record(value.repair.before) || !isDeepStrictEqual(Object.keys(value.repair.before).sort(),
      ['files', 'patches', 'runtimeReceiptDigest', 'creationReceiptDigest', 'journalDigest'].sort())
    || !record(value.repair.before.files) || !record(value.repair.before.patches)
    || !isDeepStrictEqual(Object.keys(value.repair.before.files).sort(), Object.keys(value.files).sort())
    || !isDeepStrictEqual(Object.keys(value.repair.before.patches).sort(), Object.keys(value.patches).sort())
    || Object.values(value.repair.before.files).some(digest => !hex.test(String(digest)))
    || Object.values(value.repair.before.patches).some(digest => !hex.test(String(digest)))
    || !hex.test(String(value.repair.before.runtimeReceiptDigest))
    || !hex.test(String(value.repair.before.creationReceiptDigest))
    || !hex.test(String(value.repair.before.journalDigest))
    || !record(value.repair.after) || !isDeepStrictEqual(Object.keys(value.repair.after).sort(),
      ['creationReceiptDigest', 'journalDigest'].sort())
    || !hex.test(String(value.repair.after.creationReceiptDigest)) || !hex.test(String(value.repair.after.journalDigest))
    || typeof value.signature !== 'string' || value.signature.length > 256) fail('repair overlay shape or scope differs')
  const { signature, ...unsigned } = value
  const key = createPublicKey(resources.identities.host.publicKeyPem)
  if (key.asymmetricKeyType !== 'ed25519'
    || !verify(null, Buffer.from(canonical(unsigned)), key, Buffer.from(signature, 'base64'))) fail('repair overlay signature differs')
}
function programUpdateOverlayShape(value: unknown, resources: RsiAuthorityResources, home: string, profile: string,
  bootstrapDigest: string, sequence: number, previousDigest: string | null): asserts value is RsiOwnerProgramUpdateOverlay {
  if (!record(value) || !isDeepStrictEqual(Object.keys(value).sort(), ['schemaVersion', 'kind', 'transactionId', 'dshHome',
    'targetProfile', 'installationId', 'sequence', 'previousDigest', 'bootstrapDigest', 'files', 'patches',
    'runtimeReceiptDigest', 'planDigest', 'result', 'update', 'issuedAt', 'authority', 'keyId', 'signature'].sort())
    || value.schemaVersion !== 1 || value.kind !== 'rsi-owner-program-update-overlay'
    || value.dshHome !== home || value.targetProfile !== profile || value.installationId !== resources.installationId
    || value.sequence !== sequence || value.previousDigest !== previousDigest || value.bootstrapDigest !== bootstrapDigest
    || value.authority !== resources.identities.host.authority || value.keyId !== resources.identities.host.keyId
    || typeof value.transactionId !== 'string' || !value.transactionId || !Number.isSafeInteger(value.issuedAt)
    || !hex.test(String(value.runtimeReceiptDigest)) || !hex.test(String(value.planDigest))
    || !record(value.files) || !record(value.patches) || Object.keys(value.files).length > 64
    || Object.entries(value.files).some(([path, digest]) => !isAbsolute(path) || resolve(path) !== path
      || !path.startsWith(`${resources.configRoot}/`) || !hex.test(String(digest)))
    || !record(value.result) || !isDeepStrictEqual(Object.keys(value.result).sort(),
      ['schemaVersion', 'manifestPath', 'manifestDigest', 'targetProfile', 'coordinatorProfile'].sort())
    || value.result.schemaVersion !== 1 || value.result.targetProfile !== profile
    || !profileName.test(String(value.result.coordinatorProfile)) || value.result.coordinatorProfile === profile
    || value.result.manifestPath !== `${resources.configRoot}/manifest.json`
    || value.result.manifestDigest !== value.files[value.result.manifestPath]
    || !isDeepStrictEqual(Object.keys(value.patches).sort(), [profile, value.result.coordinatorProfile].sort())
    || Object.values(value.patches).some(digest => !hex.test(String(digest)))
    || !record(value.update) || !isDeepStrictEqual(Object.keys(value.update).sort(),
      ['sourceMaintenanceDigest', 'authorityDigest', 'hostPlanDigest', 'before', 'after'].sort())
    || !hex.test(String(value.update.sourceMaintenanceDigest))
    || !hex.test(String(value.update.authorityDigest))
    || !hex.test(String(value.update.hostPlanDigest))
    || !record(value.update.before) || !isDeepStrictEqual(Object.keys(value.update.before).sort(),
      ['files', 'patches', 'runtimeReceiptDigest', 'creationReceiptDigest', 'journalDigest'].sort())
    || !record(value.update.before.files) || !record(value.update.before.patches)
    || !isDeepStrictEqual(Object.keys(value.update.before.files).sort(), Object.keys(value.files).sort())
    || !isDeepStrictEqual(Object.keys(value.update.before.patches).sort(), Object.keys(value.patches).sort())
    || Object.values(value.update.before.files).some(digest => !hex.test(String(digest)))
    || Object.values(value.update.before.patches).some(digest => !hex.test(String(digest)))
    || !hex.test(String(value.update.before.runtimeReceiptDigest))
    || !hex.test(String(value.update.before.creationReceiptDigest))
    || !hex.test(String(value.update.before.journalDigest))
    || !record(value.update.after) || !isDeepStrictEqual(Object.keys(value.update.after).sort(),
      ['creationReceiptDigest', 'journalDigest'].sort())
    || !hex.test(String(value.update.after.creationReceiptDigest)) || !hex.test(String(value.update.after.journalDigest))
    || typeof value.signature !== 'string' || value.signature.length > 256) fail('program update overlay shape or scope differs')
  const { signature, ...unsigned } = value
  const key = createPublicKey(resources.identities.host.publicKeyPem)
  if (key.asymmetricKeyType !== 'ed25519'
    || !verify(null, Buffer.from(canonical(unsigned)), key, Buffer.from(signature, 'base64'))) fail('program update overlay signature differs')
}
export function readRsiHostUpdateOverlayChain(input: {
  source: string | undefined; resources: RsiAuthorityResources; dshHome: string; profile: string; bootstrapSource: string
}): { records: RsiOwnerOverlay[]; latest?: RsiOwnerOverlay } {
  if (input.source === undefined) return { records: [] }
  let parsed: unknown
  try { parsed = JSON.parse(input.source) } catch { fail('overlay JSON is invalid') }
  if (!record(parsed) || parsed.schemaVersion !== 1 || parsed.kind !== 'rsi-host-update-overlays'
    || !Array.isArray(parsed.records) || parsed.records.length < 1 || parsed.records.length > 64) fail('overlay chain is invalid')
  const records: RsiOwnerOverlay[] = []
  const bootstrapDigest = sha256(input.bootstrapSource)
  for (const value of parsed.records) {
    const sequence = records.length + 1
    const previousDigest = records.length ? rsiHostUpdateOverlayDigest(records.at(-1)!) : null
    if (record(value) && value.kind === 'rsi-owner-repair-overlay') {
      repairOverlayShape(value, input.resources, input.dshHome, input.profile, bootstrapDigest, sequence, previousDigest)
    } else if (record(value) && value.kind === 'rsi-owner-program-update-overlay') {
      programUpdateOverlayShape(value, input.resources, input.dshHome, input.profile, bootstrapDigest, sequence, previousDigest)
    } else {
      overlayShape(value, input.resources, input.dshHome, input.profile, bootstrapDigest, sequence, previousDigest)
    }
    if (records.length && value.issuedAt < records.at(-1)!.issuedAt) fail('overlay time moved backwards')
    records.push(value)
  }
  return { records, latest: records.at(-1)! }
}
export function signRsiHostUpdateOverlay(input: Omit<RsiHostUpdateOverlay, 'signature'>,
  privateKeyPem: string, resources: RsiAuthorityResources, bootstrapSource: string,
  previous: readonly RsiOwnerOverlay[]): RsiHostUpdateOverlay {
  const record = { ...input, signature: sign(null, Buffer.from(canonical(input)), privateKeyPem).toString('base64') }
  overlayShape(record, resources, input.dshHome, input.targetProfile, sha256(bootstrapSource),
    previous.length + 1, previous.length ? rsiHostUpdateOverlayDigest(previous.at(-1)!) : null)
  return record
}
export function signRsiOwnerRepairOverlay(input: Omit<RsiOwnerRepairOverlay, 'signature'>,
  privateKeyPem: string, resources: RsiAuthorityResources, bootstrapSource: string,
  previous: readonly RsiOwnerOverlay[]): RsiOwnerRepairOverlay {
  const record = { ...input, signature: sign(null, Buffer.from(canonical(input)), privateKeyPem).toString('base64') }
  repairOverlayShape(record, resources, input.dshHome, input.targetProfile, sha256(bootstrapSource),
    previous.length + 1, previous.length ? rsiHostUpdateOverlayDigest(previous.at(-1)!) : null)
  return record
}
export function signRsiOwnerProgramUpdateOverlay(input: Omit<RsiOwnerProgramUpdateOverlay, 'signature'>,
  privateKeyPem: string, resources: RsiAuthorityResources, bootstrapSource: string,
  previous: readonly RsiOwnerOverlay[]): RsiOwnerProgramUpdateOverlay {
  const record = { ...input, signature: sign(null, Buffer.from(canonical(input)), privateKeyPem).toString('base64') }
  programUpdateOverlayShape(record, resources, input.dshHome, input.targetProfile, sha256(bootstrapSource),
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
  // Include's !!js is an inert Loader expression at this stage. Resolve only
  // that scalar tag; rawLoaderConfig below rejects every other tagged node.
  const value = parseDocument(source, { uniqueKeys: true, strict: true,
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (source: string) => source }] })
  if (value.errors.length || value.warnings.length || !isSeq(value.contents)) fail(`${label} is not a bounded patch`)
  // Existing Loader patches may share an object using YAML anchors. Expand
  // those references as YAML nodes, before applying the strict raw projection;
  // this never evaluates a !!js expression or turns it into a plain map.
  let nodes = 0
  let aliases = 0
  const expand = (node: Node, ancestors: ReadonlySet<Node>, depth: number): Node => {
    if (++nodes > 100_000 || depth > 128) fail(`${label} exceeds YAML expansion bounds`)
    if (isAlias(node)) {
      if (++aliases > 256) fail(`${label} exceeds YAML alias bounds`)
      const resolved = node.resolve(value)
      if (!resolved || ancestors.has(resolved)) fail(`${label} has an unresolved or cyclic YAML alias`)
      return expand(resolved.clone() as Node, new Set([...ancestors, resolved]), depth + 1)
    }
    if (isMap(node)) {
      if (node.items.some(pair => (isScalar(pair.key) ? pair.key.value : pair.key) === '__jsExpr')) {
        fail(`${label} contains an untagged Loader expression marker`)
      }
      for (const pair of node.items) {
        if (pair.value) pair.value = expand(pair.value as Node, new Set([...ancestors, node]), depth + 1)
      }
    } else if (isSeq(node)) {
      for (let index = 0; index < node.items.length; index++) {
        const child = node.items[index]
        if (child) node.items[index] = expand(child as Node, new Set([...ancestors, node]), depth + 1)
      }
    }
    return node
  }
  value.contents = expand(value.contents, new Set(), 0) as typeof value.contents
  const clearAnchors = (node: Node): void => {
    if (isAlias(node)) fail(`${label} has an unexpanded YAML alias`)
    delete node.anchor
    if (isMap(node)) for (const pair of node.items) if (pair.value) clearAnchors(pair.value as Node)
    if (isSeq(node)) for (const item of node.items) if (item) clearAnchors(item as Node)
  }
  clearAnchors(value.contents)
  rawLoaderConfig(value.contents, label)
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
  const result = JSON.parse(JSON.stringify(rawLoaderConfig(node, 'patch row config'))) as unknown
  if (!record(result)) fail('patch row config is invalid')
  return result
}
function hasJsTag(node: Node | null | undefined): boolean {
  if (!node) return false
  if (isScalar(node)) return node.tag === 'tag:yaml.org,2002:js'
  if (isSeq(node)) return node.items.some(item => hasJsTag(item as Node | null))
  if (isMap(node)) return node.items.some(pair => hasJsTag(pair.value as Node | null))
  return false
}
function hasRawExpression(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasRawExpression)
  return record(value) && (Object.hasOwn(value, '__jsExpr') || Object.values(value).some(hasRawExpression))
}
function updateConfigNode(patch: ReturnType<typeof parseDocument>, node: Node, replacement: unknown): Node {
  const before = JSON.parse(JSON.stringify(rawLoaderConfig(node, 'patch config'))) as unknown
  if (isDeepStrictEqual(before, replacement)) return node
  if (isScalar(node) && node.tag === 'tag:yaml.org,2002:js') fail('tagged Loader expression changed')
  if (isMap(node) && record(replacement) && hasJsTag(node)) {
    const remove: string[] = []
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? pair.key.value : pair.key
      if (typeof key !== 'string') fail('patch config key is invalid')
      if (!Object.hasOwn(replacement, key)) {
        if (hasJsTag(pair.value as Node | null)) fail('tagged Loader expression removed')
        remove.push(key)
      } else {
        const child = pair.value as Node | null
        if (!child) fail('patch config value is invalid')
        pair.value = updateConfigNode(patch, child, replacement[key])
      }
    }
    for (const key of remove) node.delete(key)
    for (const [key, value] of Object.entries(replacement)) {
      if (!node.has(key)) {
        if (hasRawExpression(value)) fail('tagged Loader expression inserted')
        node.set(key, patch.createNode(value))
      }
    }
    return node
  }
  if (isSeq(node) && Array.isArray(replacement) && hasJsTag(node)) {
    if (node.items.length !== replacement.length) fail('tagged Loader expression sequence changed')
    for (let index = 0; index < replacement.length; index++) {
      const child = node.items[index] as Node | null
      if (!child) fail('patch config value is invalid')
      node.items[index] = updateConfigNode(patch, child, replacement[index])
    }
    return node
  }
  if (hasJsTag(node) || hasRawExpression(replacement)) fail('tagged Loader expression changed')
  return patch.createNode(replacement)
}
function setConfig(patch: ReturnType<typeof parseDocument>, id: string, replacement: unknown): void {
  const target = row(patch, id)
  const node = target.get('config', true)
  if (!isMap(node)) fail('patch row config is not a map')
  target.set('config', updateConfigNode(patch, node, replacement))
}
/** Read the same inert Loader values used by the runtime observer. */
export function readRsiHostPatchConfig(source: string, id: string): Record<string, unknown> {
  return config(row(document(source, 'owner patch'), id))
}
/** Change a bounded row without rebuilding unrelated !!js expression nodes. */
export function replaceRsiHostPatchConfig(source: string, id: string, expected: Record<string, unknown>,
  replacement: Record<string, unknown>): string {
  const patch = document(source, 'owner patch')
  if (!isDeepStrictEqual(config(row(patch, id)), expected)) fail(`owner patch row changed: ${id}`)
  setConfig(patch, id, replacement)
  return patch.toString({ lineWidth: 0 })
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
    setConfig(target, id, value)
  }
  const verifier = row(target, 'dsh-enhanced-assistant-verifier')
  const verifierConfig = config(verifier)
  if (!isDeepStrictEqual(verifierConfig.sourceReviews, input.manifest.sourceReviews)) fail('verifier patch differs from the owner manifest')
  setConfig(target, 'dsh-enhanced-assistant-verifier', { ...verifierConfig, sourceReviews: changed.sourceReviews })
  const targets = changed.controlPlane.runtimeObserver?.targets
  if (!targets) fail('runtime observer targets are missing')
  for (const targetEntry of targets) {
    if (!replacements.has(targetEntry.entryId) && targetEntry.entryId !== 'dsh-enhanced-assistant-verifier') continue
    const oldDigest = targetDigest(input.manifest, targetEntry.entryId, oldTarget)
    if (targetEntry.configDigest !== oldDigest) fail(`observer digest differs: ${targetEntry.entryId}`)
    targetEntry.configDigest = targetDigest(changed, targetEntry.entryId, target)
  }
  setConfig(target, 'dsh-enhanced-plugin-control-plane', changed.controlPlane)
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
    setConfig(documentAfter, id, rebaseRsiHostValue(current, input.rebase))
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
  setConfig(documentAfter, ids[0]!, cp)
  if (JSON.stringify(rawLoaderConfig(documentAfter.contents, 'active patch')).includes(input.rebase.oldHostRoot)) {
    fail('active patch retains an unmapped Host path')
  }
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
