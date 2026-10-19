/** Offline upgrade of an already paired owner. This module never creates an
 * installation, a grant, an owner binding, or a new bootstrap receipt. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, lstat, realpath, rename, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual as same } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { assertLocalSourceInstaller } from './local-source-maintenance.mjs'
import { composeOwnerRepairProfiles, ownerRepairPatchEquivalent,
  ownerRepairSuccessorSnapshotEquivalent } from './owner-source-repair.mjs'

const protocol = 'dsh-enhanced/host-owner-program-update/v1'
const hash = value => createHash('sha256').update(value).digest('hex')
const json = value => `${JSON.stringify(value, null, 2)}\n`
const hex = /^[a-f0-9]{64}$/u
const profileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const fail = message => { throw new Error(`Owner program update: ${message}`) }
const exact = path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path
  && !path.includes('\0') && !/[\r\n]/u.test(path)
const inside = (root, path) => path === root || path.startsWith(`${root}${sep}`)
const physical = (home, stage, path) => {
  if (!exact(path) || !inside(home, path)) fail(`unbound Home path: ${path}`)
  return join(stage, relative(home, path))
}
const parse = (source, label) => {
  let value
  try { value = JSON.parse(source) } catch { fail(`invalid ${label}`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`invalid ${label}`)
  return value
}
async function privateDirectory(path) {
  if (!exact(path) || await realpath(path) !== path) fail(`noncanonical directory: ${path}`)
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid()
    || entry.mode & 0o022) fail(`unsafe directory: ${path}`)
}
async function bytes(path, maximum = 2_097_152, privateMode = true) {
  if (!exact(path) || await realpath(path) !== path) fail(`noncanonical file: ${path}`)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat({ bigint: true }), named = await lstat(path, { bigint: true })
    if (!before.isFile() || privateMode && before.nlink !== 1n || before.uid !== BigInt(process.getuid())
      || before.size < 1n || before.size > BigInt(maximum)
      || before.mode & BigInt(privateMode ? 0o077 : 0o022)
      || before.dev !== named.dev || before.ino !== named.ino) fail(`unsafe file: ${path}`)
    const result = await file.readFile(), after = await file.stat({ bigint: true })
    if (BigInt(result.length) !== before.size || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      fail(`file changed: ${path}`)
    }
    return result
  } finally { await file.close() }
}
async function optional(path, maximum, privateMode = true) {
  try { return (await bytes(path, maximum, privateMode)).toString('utf8') }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error }
}
async function write(path, source) {
  const temporary = `${path}.program-update-${process.pid}-${Date.now()}`
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await file.writeFile(source); await file.sync() } finally { await file.close() }
  await rename(temporary, path)
}
async function apiFor(installer) {
  await assertLocalSourceInstaller(installer)
  const root = join(installer.root, 'plugins', 'lark-channel', 'lib')
  const names = ['rsi-authority-resources', 'rsi-authority-runtime', 'rsi-source-maintenance',
    'rsi-creation-build', 'rsi-source', 'rsi-build', 'rsi-release-build', 'rsi-profile',
    'rsi-host-update', 'rsi-plugin-creation', 'rsi-install', 'rsi-service-environment', 'systemd',
    'rsi-authority-config', 'rsi-bootstrap-manifest', 'rsi-setup', 'rsi-install-inputs',
    'rsi-local-cohort']
  const api = Object.assign({}, ...await Promise.all(names.map(name => import(pathToFileURL(join(root, `${name}.js`)).href))))
  const req = createRequire(join(installer.root, 'package.json'))
  const controlPath = await realpath(createRequire(join(installer.root, 'plugins', 'lark-channel', 'package.json'))
    .resolve('@dsh-enhanced/plugin-control-plane'))
  if (!inside(installer.root, controlPath) || !inside(installer.root,
    await realpath(req.resolve('yaml/package.json')))) fail('reviewed installer dependency escaped')
  return { ...api, control: await import(pathToFileURL(controlPath).href), yaml: req('yaml') }
}
async function ledger(api, home, physicalHome, profile, repository, records) {
  const path = join(physicalHome, 'rsi-authorities', profile, 'state', 'control-plane', 'control.sqlite')
  await bytes(path, 268_435_456)
  const store = new api.control.ControlPlaneStore({ path, readOnly: true })
  try {
    const state = store.readSourceMaintenanceState(repository)
    if (!same(state.records, records) || store.readSourceMaintenanceActivationState(home).kind !== 'none') {
      fail('existing source adoption or unsettled activation requires a different upgrade contract')
    }
    return state
  } finally { store.close() }
}
function overlayChain(api, owner, source) {
  return api.readRsiHostUpdateOverlayChain({ source: source ?? undefined,
    resources: owner.original.resources, dshHome: owner.homePath, profile: owner.profile,
    bootstrapSource: owner.original.receiptSource })
}
function grantProjection(value, configPath) {
  if (value === null || value === undefined) return value
  const result = structuredClone(value)
  // Only the Host's exact program inventory and the release policies' Host
  // baseline can change. Identically named fields in other grants remain exact.
  if (configPath.endsWith('/host-authority.json')) {
    delete result.packages
    delete result.hostDeploymentInputs
  } else if (configPath.endsWith('/release.json')) {
    if (!Array.isArray(result.policies)) fail('release policy inventory differs')
    result.policies = result.policies.map(policy => {
      const item = { ...policy }
      delete item.dshBaseline
      return item
    })
  }
  return result
}
export function assertOwnerProgramAuthorityPreserved(before, after) {
  if (!before || !after || !same(Object.keys(before).sort(), Object.keys(after).sort())) fail('authority file inventory changed')
  for (const path of Object.keys(before)) {
    if (!path.endsWith('.json')) {
      if (before[path] !== after[path]) fail(`authority key changed: ${path}`)
      continue
    }
    const oldValue = parse(before[path], `old authority ${path}`)
    const newValue = parse(after[path], `new authority ${path}`)
    if (oldValue.grant || newValue.grant) {
      if (!oldValue.grant || !newValue.grant
        || !same(grantProjection(oldValue.grant, path), grantProjection(newValue.grant, path))) {
        fail(`finite authorization changed: ${path}`)
      }
    }
  }
}
export function assertOwnerProgramManifestPreserved(rebasedBefore, after) {
  const expected = structuredClone(rebasedBefore)
  expected.controlPlane.sourceBuild = structuredClone(after.controlPlane.sourceBuild)
  expected.pluginCreation.reviews.runner = structuredClone(after.pluginCreation.reviews.runner)
  expected.pluginCreation.capabilities.runner = structuredClone(after.pluginCreation.capabilities.runner)
  expected.pluginCreation.verifications.authority = structuredClone(after.pluginCreation.verifications.authority)
  expected.controlPlane.creationVerifications = structuredClone(after.controlPlane.creationVerifications)
  expected.controlPlane.creationCapabilities = structuredClone(after.controlPlane.creationCapabilities)
  if (!same(after.controlPlane.creationVerifications, after.pluginCreation.verifications)
    || !same(after.controlPlane.creationCapabilities, after.pluginCreation.capabilities)) {
    fail('creation authority mirror differs')
  }
  const beforeTargets = expected.controlPlane.runtimeObserver.targets
  const afterTargets = after.controlPlane.runtimeObserver.targets
  if (!same(beforeTargets.map(target => target.entryId), afterTargets.map(target => target.entryId))) {
    fail('runtime observer identity changed')
  }
  for (let index = 0; index < beforeTargets.length; index++) {
    if (beforeTargets[index].entryId === 'dsh-enhanced-assistant-verifier') {
      if (!hex.test(afterTargets[index].configDigest)) fail('new verifier observer digest is invalid')
      beforeTargets[index].configDigest = afterTargets[index].configDigest
    }
  }
  if (!same(expected, after)) fail('owner manifest changed outside exact program fields')
}
function authoritySemanticDigest(files) {
  return hash(json(Object.fromEntries(Object.entries(files)
    .filter(([path]) => path.endsWith('.json')).map(([path, value]) => [path,
      grantProjection(parse(value, `authority ${path}`).grant ?? null, path)]))))
}
export function assertOwnerProgramWindow(manifest, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 1
    || !Number.isSafeInteger(manifest?.sourceReviews?.expiresAt)
    || manifest.sourceReviews.expiresAt <= now
    || manifest.controlPlane?.sourceJobs?.expiresAt <= now
    || manifest.pluginCreation?.creation?.expiresAt <= now) {
    fail('standing owner grant has expired before offline upgrade; no renewal is permitted')
  }
}

async function verifyOriginalInstalledPlan(api, input) {
  const { homePath, profile, coordinatorProfile, source, manifest, journal, owner,
    dshPath, dshEnvironment, receipt } = input
  const cohort = await api.readRsiLocalCohort({ dshHome: homePath, profile, source: source.workspace })
  const profilePath = join(homePath, 'profiles', profile)
  await api.verifyRsiLocalInstalledPackagesFresh({ cohort, profilePath, bundles: ['lark-channel'] })
  const profileRequire = createRequire(join(profilePath, 'package.json'))
  const packageManifestPath = await realpath(profileRequire.resolve('@dsh-enhanced/lark-channel/package.json'))
  const packageRoot = dirname(packageManifestPath)
  if (!inside(profilePath, packageRoot)) fail('original owner compiler escaped verified cohort')
  const compilerPath = join(packageRoot, 'lib', 'rsi-profile.js')
  const compilerDigest = hash(await bytes(compilerPath, 2_097_152, false))
  const installed = await import(pathToFileURL(compilerPath).href)
  if (typeof installed.compileRsiProfiles !== 'function') fail('installed original compiler is missing')
  const beforePatches = { [profile]: journal.entries[0].before,
    [coordinatorProfile]: journal.entries[1].before }
  const originalEffective = await composeOwnerRepairProfiles({ homePath, profile,
    coordinatorProfile, dshPath, patchOverrides: beforePatches })
  const selected = await api.resolveInstalledRsiDsh(dshEnvironment)
  if (selected.path !== dshPath || selected.pin.sha256 !== originalEffective.dshDigest) {
    fail('original Host executable changed')
  }
  const coordinatorBase = await api.readRsiInstalledBase(coordinatorProfile, homePath, dshEnvironment)
  const patches = await installed.compileRsiProfiles({ manifest, dshHome: homePath,
    targetPatch: beforePatches[profile], coordinatorPatch: beforePatches[coordinatorProfile],
    targetEffective: originalEffective.targetEffective,
    coordinatorEffective: originalEffective.coordinatorEffective, coordinatorBase, owner })
  if (receipt.planDigest !== hash(json({ files: receipt.files, patches }))
    || !ownerRepairPatchEquivalent({ yaml: api.yaml,
      planned: patches.targetPatch, applied: journal.entries[0].after })
    || !ownerRepairPatchEquivalent({ yaml: api.yaml,
      planned: patches.coordinatorPatch, applied: journal.entries[1].after })) {
    fail('installed original compiler disagrees with applied owner journal')
  }
  return { compilerPath, compilerDigest, cohortDigest: cohort.receiptDigest }
}
async function verifyRepairAudits(homePath, profile, records, receiptSource) {
  for (const record of records) {
    if (record.kind !== 'rsi-owner-repair-overlay') continue
    if (!/^[a-f0-9-]{36}$/u.test(record.transactionId)) fail('prior repair audit ID is invalid')
    const source = (await bytes(join(homePath, 'rsi-authorities', profile, 'state',
      'owner-repair-audit', `${record.transactionId}.json`), 4_194_304)).toString('utf8')
    const audit = parse(source, 'prior owner repair audit')
    if (audit.schemaVersion !== 1 || audit.transactionId !== record.transactionId
      || audit.homePath !== homePath || audit.bootstrapReceipt !== receiptSource
      || !same(Object.fromEntries(Object.entries(audit.files ?? {}).map(([path, value]) => [path, hash(value)])),
        record.repair.before.files)
      || !same(Object.fromEntries(Object.entries(audit.patches ?? {}).map(([name, value]) => [name, hash(value)])),
        record.repair.before.patches)
      || audit.runtimeReceiptDigest !== record.repair.before.runtimeReceiptDigest
      || hash(audit.creationReceipt) !== record.repair.before.creationReceiptDigest
      || hash(audit.journal) !== record.repair.before.journalDigest) {
      fail('signed prior repair lacks its immutable original audit')
    }
  }
}
async function currentFiles(home, physicalHome, digests) {
  const result = {}
  for (const [path, digest] of Object.entries(digests)) {
    if (!hex.test(digest)) fail('invalid authority digest')
    const source = (await bytes(physical(home, physicalHome, path))).toString('utf8')
    if (hash(source) !== digest) fail(`authority file changed: ${path}`)
    result[path] = source
  }
  return result
}
async function currentPatches(home, physicalHome, patches) {
  const result = {}
  for (const [name, digest] of Object.entries(patches)) {
    if (!profileName.test(name) || !hex.test(digest)) fail('invalid profile digest')
    const source = (await bytes(join(physicalHome, 'profiles', name, 'cordis.patch.yml'), 2_097_152, false)).toString('utf8')
    if (hash(source) !== digest) fail(`profile patch changed: ${name}`)
    result[name] = source
  }
  return result
}
async function dataInventory(root) {
  const found = {}
  const visit = async (path, name) => {
    const entry = await lstat(path)
    if (entry.isSymbolicLink() || entry.uid !== process.getuid() || entry.mode & 0o022) fail(`unsafe owner data: ${path}`)
    if (entry.isDirectory()) {
      for (const child of (await readdir(path)).sort()) await visit(join(path, child), join(name, child))
    } else if (entry.isFile()) {
      if (entry.size > 268_435_456) fail(`owner data exceeds comparison bound: ${path}`)
      found[name] = hash(await readFile(path))
    } else fail(`unexpected owner data entry: ${path}`)
  }
  for (const sub of ['state', 'identities']) {
    const path = join(root, sub)
    try { await visit(path, sub) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
  return found
}
async function standingData(home, physicalHome, profile, { ledgerChanged = false } = {}) {
  const original = await dataInventory(join(home, 'rsi-authorities', profile))
  const staged = await dataInventory(join(physicalHome, 'rsi-authorities', profile))
  if (ledgerChanged) {
    for (const key of Object.keys(original)) if (key.startsWith('state/control-plane/control.sqlite')) {
      delete original[key]; delete staged[key]
    }
  }
  if (!same(original, staged)) fail('owner credential or unmodified authority data was lost')
}

export async function assertOwnerProgramBusinessDataCopied(api, owner, stage) {
  const paths = new Set()
  const scan = value => {
    if (Array.isArray(value)) { value.forEach(scan); return }
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (key === 'databasePath' && typeof child === 'string') {
        if (!exact(child) || !inside(owner.homePath, child)) fail('owner database escaped Home')
        paths.add(child)
      } else scan(child)
    }
  }
  for (const source of Object.values(owner.original.effective)) {
    const document = api.yaml.parseDocument(source, { uniqueKeys: true })
    if (document.errors.length) fail('original effective profile is invalid')
    const ownerRows = new Set(['dsh-enhanced-assistant-delivery', 'dsh-enhanced-personal-assistant',
      'dsh-enhanced-assistant-verifier', 'dsh-enhanced-assistant-growth-driver',
      'dsh-enhanced-assistant-memory-learning', 'dsh-enhanced-assistant-policy',
      'dsh-enhanced-assistant-automations', 'dsh-enhanced-plugin-control-plane'])
    for (const row of document.toJSON()) if (ownerRows.has(row?.id)) scan(row.config)
  }
  const digest = async path => {
    try {
      const entry = await lstat(path)
      if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid()
        || entry.mode & 0o077 || entry.size > 268_435_456) fail(`unsafe owner database: ${path}`)
      return hash(await readFile(path))
    } catch (error) { if (error?.code === 'ENOENT') return null; throw error }
  }
  for (const path of paths) for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const original = await digest(path + suffix)
    if (original !== await digest(physical(owner.homePath, stage, path) + suffix)) {
      fail(`staged owner/automation/budget database differs: ${path}${suffix}`)
    }
  }
}

function assertOwner(ownerUpdate, homePath, installer, hostPlan = ownerUpdate?.hostPlan) {
  if (ownerUpdate?.protocol !== protocol || ownerUpdate.homePath !== homePath
    || !same(installer, ownerUpdate.installer) || !same(hostPlan, ownerUpdate.hostPlan)
    || ownerUpdate.hostPlanDigest !== hash(JSON.stringify(hostPlan))) fail('owner program proof binding differs')
}

export async function captureOwnerProgramUpdate({ homePath, profile, installer, dshPath,
  dshEnvironment = process.env, hostPlan }) {
  if (!exact(homePath) || !profileName.test(profile) || !exact(dshPath)
    || !hostPlan?.originalRuntime || !hostPlan?.candidateRuntime
    || !exact(hostPlan.originalRuntime.root) || !exact(hostPlan.candidateRuntime.root)
    || !exact(hostPlan.candidateRuntime.dshPath)) fail('invalid owner or Host plan')
  const canonicalDsh = await realpath(dshPath)
  if (await realpath(hostPlan.originalRuntime.dshPath) !== canonicalDsh
    || !inside(hostPlan.originalRuntime.root, canonicalDsh) || inside(homePath, canonicalDsh)) {
    fail('owner Host executable differs from its bound runtime')
  }
  dshPath = canonicalDsh
  await privateDirectory(homePath)
  const api = await apiFor(installer)
  const resources = await api.prepareRsiAuthorityResources({ dshHome: homePath, profile, existingOnly: true })
  const runtime = await api.readRsiAuthorityRuntimeReceipt({ logicalHome: homePath,
    physicalHome: homePath, profile })
  const source = await api.readRsiSourceMaintenance({ logicalHome: homePath,
    physicalHome: homePath, profile })
  const config = resources.configRoot, manifestPath = join(config, 'manifest.json')
  const receiptSource = (await bytes(join(config, 'bootstrap.json'))).toString('utf8')
  const receipt = parse(receiptSource, 'owner bootstrap receipt')
  const overlaySource = await optional(join(config, 'host-update-overlays.json'), 2_097_152)
  const chain = api.readRsiHostUpdateOverlayChain({ source: overlaySource ?? undefined,
    resources, dshHome: homePath, profile, bootstrapSource: receiptSource })
  await verifyRepairAudits(homePath, profile, chain.records, receiptSource)
  const latest = chain.latest ?? receipt
  const fileDigests = latest.files, patchDigests = chain.latest?.patches
  if (receipt.schemaVersion !== 1 || !fileDigests || !fileDigests[manifestPath]
    || !same(Object.keys(fileDigests).sort(), Object.keys(receipt.files ?? {}).sort())) {
    fail('owner authority inventory differs from signed bootstrap')
  }
  const files = await currentFiles(homePath, homePath, fileDigests)
  const manifestSource = files[manifestPath], manifest = parse(manifestSource, 'owner manifest')
  assertOwnerProgramWindow(manifest)
  if (manifest.targetProfile !== profile || !profileName.test(manifest.coordinatorProfile)
    || manifest.coordinatorProfile === profile || !manifest.pluginCreation
    || latest.result?.manifestDigest !== hash(manifestSource)
    || latest.result.manifestPath !== manifestPath
    || latest.result.targetProfile !== profile
    || latest.result.coordinatorProfile !== manifest.coordinatorProfile
    || runtime.receiptDigest !== (chain.latest?.runtimeReceiptDigest ?? runtime.receiptDigest)) {
    fail('current signed owner configuration differs')
  }
  const patches = {}
  for (const name of [profile, manifest.coordinatorProfile]) {
    patches[name] = (await bytes(join(homePath, 'profiles', name, 'cordis.patch.yml'),
      2_097_152, false)).toString('utf8')
  }
  const actualPatchDigests = Object.fromEntries(Object.entries(patches).map(([name, value]) => [name, hash(value)]))
  if (chain.latest && !same(actualPatchDigests, patchDigests)) fail('current signed profile patches differ')
  if (chain.latest) {
    if (chain.latest.planDigest !== hash(json({ files: fileDigests, patches: patchDigests }))) {
      fail('signed owner overlay plan differs')
    }
  }
  const journalSource = (await bytes(join(homePath, '.rsi-setup-journal.json'))).toString('utf8')
  const journal = parse(journalSource, 'owner setup journal')
  if (journal.schemaVersion !== 2 || journal.stage !== 'applied'
    || journal.manifestDigest !== hash(manifestSource)
    || !same(journal.entries?.map(item => [item.profile, item.after]),
      [profile, manifest.coordinatorProfile].map(name => [name, patches[name]]))) {
    fail('applied owner setup journal differs')
  }
  const creationSource = (await bytes(join(homePath, 'rsi-creation-builds', profile, 'bootstrap.json'), 65_536)).toString('utf8')
  const observerKey = await bytes(manifest.controlPlane.runtimeObserver.keyPath, 32)
  if (observerKey.length !== 32 || hash(observerKey) !== receipt.observerKeyDigest) {
    fail('owner observer credential differs')
  }
  if (chain.latest?.kind === 'rsi-owner-repair-overlay' || chain.latest?.kind === 'rsi-owner-program-update-overlay') {
    const last = chain.latest.repair ?? chain.latest.update
    if (hash(creationSource) !== last.after.creationReceiptDigest
      || hash(journalSource) !== last.after.journalDigest) fail('latest owner creation or journal receipt differs')
  }
  const composed = await composeOwnerRepairProfiles({ homePath, profile,
    coordinatorProfile: manifest.coordinatorProfile, dshPath })
  const selected = await api.resolveInstalledRsiDsh(dshEnvironment)
  if (selected.path !== dshPath || selected.pin.sha256 !== composed.dshDigest
    || hostPlan.originalRuntime.version !== composed.dshVersion) fail('installed Host differs from selected plan')
  const ownerSnapshot = await api.rsiSetupPorts.snapshot(composed.targetEffective, homePath)
  if (ownerSnapshot.bindings?.length !== 1
    || !same(manifest.sourceReviews.owner.principalRecordId, ownerSnapshot.bindings[0].owner.id)) {
    fail('single active owner binding differs')
  }
  const sourceState = await ledger(api, homePath, homePath, profile,
    source.workspace.repository, source.records)
  const hostAuthority = parse(files[join(config, 'host-authority.json')], 'Host authority')
  const trust = parse(files[join(config, 'trust.json')], 'owner trust')
  const release = parse(files[join(config, 'release.json')], 'release authority')
  const build = await api.readRsiBuildEnvironment({ dshHome: homePath, profile, source: source.workspace })
  const releaseBuild = await api.readRsiReleaseBuildEnvironment({ dshHome: homePath, profile, build })
  const creationBuild = await api.readRsiCreationBuildEnvironment({ dshHome: homePath, profile,
    source: source.workspace, build })
  const environments = {}, units = {}
  for (const [index, name] of [profile, manifest.coordinatorProfile].entries()) {
    const environment = await optional(api.rsiServiceEnvironmentPath(homePath, name), 2_097_152)
    const unit = await optional(api.systemdServicePaths({ dshHome: homePath, profile: name,
      home: realpathSync(homedir()) }).unitPath, 2_097_152, false)
    if (environment !== journal.environments?.[index]?.after || unit !== journal.units?.[index]?.after) {
      fail('owner service binding differs')
    }
    environments[name] = environment; units[name] = unit
  }
  const original = { resources, runtime, source, sourceState, ownerSnapshot, owner: ownerSnapshot.bindings[0],
    manifest, manifestSource, receipt, receiptSource, journal, journalSource, files, patches,
    fileDigests, patchDigests: actualPatchDigests, overlay: { records: chain.records, latest: chain.latest },
    creationSource, creationDigest: hash(creationSource), creationBuild, build, releaseBuild,
    runtimeReceiptDigest: runtime.receiptDigest, environments, units,
    now: hostAuthority.grant?.notBefore, executor: trust.executor,
    policies: release.grant?.policies, unitProperties: hostAuthority.template?.unitProperties,
    effective: { targetEffective: composed.targetEffective, coordinatorEffective: composed.coordinatorEffective } }
  if (!Number.isSafeInteger(original.now) || !Array.isArray(original.policies)
    || !same(hostAuthority.grant?.owner, manifest.sourceReviews.owner)) fail('frozen owner grant differs')
  const compiled = api.compileRsiAuthorityConfigs({ manifest, resources, runtime: runtime.runtime,
    source: source.workspace, releaseBuild: releaseBuild.releaseBuild,
    executor: original.executor, systemctl: hostAuthority.template.systemctl,
    unitProperties: original.unitProperties, policies: original.policies, now: original.now })
  const reproduced = { ...compiled.files, [manifestPath]: json(manifest) }
  if (!same(reproduced, files)) fail('standing owner configuration cannot be independently reproduced')
  original.originalPlan = chain.records.length ? null : await verifyOriginalInstalledPlan(api, {
    homePath, profile, coordinatorProfile: manifest.coordinatorProfile, source, manifest,
    journal, owner: original.owner, dshPath, dshEnvironment, receipt })
  const result = { protocol, homePath, profile, coordinatorProfile: manifest.coordinatorProfile,
    installer, dshPath, host: { dshDigest: composed.dshDigest, version: composed.dshVersion },
    hostPlan, hostPlanDigest: hash(JSON.stringify(hostPlan)), original }
  await verifyOwnerProgramUpdate({ ownerUpdate: result, homePath, installer, phase: 'original' })
  return result
}

export async function prepareOwnerProgramCreation({ ownerUpdate, candidateHome, source, sourceBuild,
  installer = ownerUpdate?.installer, signal }) {
  assertOwner(ownerUpdate, ownerUpdate?.homePath, installer)
  if (!exact(candidateHome) || inside(ownerUpdate.homePath, candidateHome)
    || inside(candidateHome, ownerUpdate.homePath)) fail('candidate creation Home is not separate')
  await privateDirectory(candidateHome)
  const api = await apiFor(installer)
  const profile = ownerUpdate.profile
  const actualSource = await api.readRsiSourceWorkspace({ dshHome: candidateHome, profile,
    ...(source?.origin?.kind === 'local-head' ? { sourceRepository: source.origin.locator } : {}),
    ...(signal ? { signal } : {}) })
  const actualBuild = await api.readRsiBuildEnvironment({ dshHome: candidateHome,
    profile, source: actualSource, ...(signal ? { signal } : {}) })
  if (!same(actualSource, source) || !same(actualBuild, sourceBuild)
    || actualSource.sourceCommit === ownerUpdate.original.source.workspace.sourceCommit) {
    fail('candidate source or build differs')
  }
  const creationBuild = await api.prepareRsiCreationBuildEnvironment({ dshHome: candidateHome,
    profile, source: actualSource, build: actualBuild, ...(signal ? { signal } : {}) })
  const receiptSha256 = hash(await bytes(join(candidateHome, 'rsi-creation-builds', profile,
    'bootstrap.json'), 65_536))
  return { schemaVersion: 1, candidateHome, candidateSource: actualSource,
    candidateBuild: actualBuild, creationBuild, receiptSha256 }
}

export async function appendOwnerProgramSourceMaintenance({ ownerUpdate, homePath, stageHome, record,
  installer = ownerUpdate?.installer }) {
  assertOwner(ownerUpdate, homePath, installer)
  if (!exact(stageHome) || stageHome === homePath || inside(homePath, stageHome)
    || record?.host !== null) fail('owner source maintenance must be unanchored and staged')
  const api = await apiFor(installer)
  await privateDirectory(stageHome)
  await standingData(homePath, stageHome, ownerUpdate.profile)
  await assertOwnerProgramBusinessDataCopied(api, ownerUpdate, stageHome)
  const original = ownerUpdate.original
  const stageSource = await api.readRsiSourceMaintenance({ logicalHome: homePath,
    physicalHome: stageHome, profile: ownerUpdate.profile })
  if (!same(stageSource.records, [...original.source.records, record])
    || !same(stageSource.anchor, original.source.anchor)
    || stageSource.workspace.sourceCommit !== record.after.sourceCommit) fail('staged source chain differs')
  const before = await ledger(api, homePath, stageHome, ownerUpdate.profile,
    original.source.workspace.repository, original.source.records)
  // The stop/copy boundary may be later than capture; compare the actual
  // original ledger after quiescence, not an obsolete capture-time counter.
  const stopped = await ledger(api, homePath, homePath, ownerUpdate.profile,
    original.source.workspace.repository, original.source.records)
  if (!same(before, stopped)) fail('copied Control Plane history or budget state differs')
  const trustPath = join(stageHome, 'rsi-authorities', ownerUpdate.profile, 'config', 'trust.json')
  const trust = await api.control.loadTrustConfig(trustPath)
  if (trust.installationId !== original.resources.installationId
    || trust.ledger.id !== original.resources.ledgerId || trust.dshHome !== homePath) {
    fail('staged owner trust identity differs')
  }
  const store = new api.control.ControlPlaneStore({ path: join(stageHome, 'rsi-authorities', ownerUpdate.profile,
    'state', 'control-plane', 'control.sqlite') })
  try { await store.appendSourceMaintenance(record, { trust,
    baseline: original.source.workspace.baseline, physicalHome: stageHome }) } finally { store.close() }
  const after = await ledger(api, homePath, stageHome, ownerUpdate.profile,
    original.source.workspace.repository, [...original.source.records, record])
  if (!same(after.history, stopped.history)) fail('prior source history changed')
  return { recordDigest: api.control.sourceMaintenanceDigest(record), ledgerDigest: hash(json(after)) }
}

function pinMap(oldRuntime, newRuntime) {
  const pins = {}
  const walk = (before, after) => {
    if (before && after && typeof before === 'object' && typeof after === 'object') {
      if (typeof before.path === 'string' && typeof before.sha256 === 'string') {
        if (typeof after.path !== 'string' || !hex.test(after.sha256)) fail('new runtime pin differs')
        pins[before.path] = { path: after.path, sha256: after.sha256 }
        return
      }
      if (!same(Object.keys(before).sort(), Object.keys(after).sort())) fail('authority runtime layout changed')
      for (const key of Object.keys(before)) walk(before[key], after[key])
    } else if (!same(before, after)) fail('authority runtime metadata changed unexpectedly')
  }
  walk({ ...oldRuntime, root: null, packageVersion: null },
    { ...newRuntime, root: null, packageVersion: null })
  return pins
}
async function rebaseFor(owner, api, runtime) {
  const plan = owner.hostPlan, oldRoot = plan.originalRuntime.root, newRoot = plan.candidateRuntime.root
  const pins = pinMap(owner.original.runtime.runtime, runtime)
  const visit = async value => {
    if (Array.isArray(value)) { for (const child of value) await visit(child); return }
    if (!value || typeof value !== 'object') return
    if (typeof value.path === 'string' && inside(oldRoot, value.path) && hex.test(value.sha256)) {
      const oldPath = value.path, newPath = join(newRoot, relative(oldRoot, oldPath))
      if (!inside(newRoot, newPath) || hash(await bytes(oldPath, 268_435_456, false)) !== value.sha256) {
        fail('old Host pin differs')
      }
      pins[oldPath] = { path: newPath, sha256: hash(await bytes(newPath, 268_435_456, false)) }
    }
    for (const child of Object.values(value)) await visit(child)
  }
  for (const source of Object.values(owner.original.files)) {
    if (source.trimStart().startsWith('{')) await visit(parse(source, 'owner authority'))
  }
  await visit(owner.original.manifest)
  const oldExecutable = await realpath(plan.originalRuntime.dshPath)
  const newExecutable = await realpath(plan.candidateRuntime.dshPath)
  if (!inside(oldRoot, oldExecutable) || !inside(newRoot, newExecutable)) fail('Host executable escaped its bound runtime')
  const executablePin = { path: newExecutable, sha256: hash(await bytes(newExecutable, 268_435_456, false)) }
  pins[oldExecutable] = executablePin
  pins[plan.originalRuntime.dshPath] = executablePin
  return { oldHostRoot: oldRoot, oldHostVersion: plan.originalRuntime.version,
    candidateHostVersion: plan.candidateRuntime.version, pins }
}

function programCreation(before, candidate) {
  const strip = value => {
    const copy = structuredClone(value)
    delete copy.reviews.runner; delete copy.capabilities.runner
    delete copy.verifications.authority
    return copy
  }
  if (!same(strip(before), strip(candidate))) fail('creation finite grant or review authority changed')
  const result = structuredClone(before)
  result.reviews.runner = candidate.reviews.runner
  result.capabilities.runner = candidate.capabilities.runner
  result.verifications.authority = candidate.verifications.authority
  return result
}

function patchConfig(api, source, id) {
  const document = api.yaml.parseDocument(source, { uniqueKeys: true, strict: true })
  if (document.errors.length || document.warnings.length || !api.yaml.isSeq(document.contents)) fail('invalid owner patch')
  const matches = []
  for (const op of document.contents.items) {
    if (!api.yaml.isMap(op)) fail('invalid owner patch operation')
    if (op.get('id') === id) matches.push(op)
    for (const kind of ['insert', 'update']) {
      const rows = op.get(kind, true)
      if (!rows) continue
      if (!api.yaml.isSeq(rows)) fail('invalid owner patch rows')
      for (const row of rows.items) if (api.yaml.isMap(row) && row.get('id') === id) matches.push(row)
    }
  }
  if (matches.length !== 1 || !api.yaml.isMap(matches[0].get('config', true))) {
    fail(`owner patch row differs: ${id}`)
  }
  return api.rawLoaderConfig(matches[0].get('config', true), id)
}

function replacePatchConfig(api, source, id, expected, replacement) {
  const document = api.yaml.parseDocument(source, { uniqueKeys: true, strict: true })
  if (document.errors.length || document.warnings.length || !api.yaml.isSeq(document.contents)) {
    fail('invalid owner patch')
  }
  const matches = []
  for (const operation of document.contents.items) {
    if (!api.yaml.isMap(operation)) fail('invalid owner patch operation')
    if (operation.get('id') === id) matches.push(operation)
    for (const kind of ['insert', 'update']) {
      const rows = operation.get(kind, true)
      if (!rows) continue
      if (!api.yaml.isSeq(rows)) fail('invalid owner patch rows')
      for (const row of rows.items) if (api.yaml.isMap(row) && row.get('id') === id) matches.push(row)
    }
  }
  if (matches.length !== 1 || !same(matches[0].get('config', true)?.toJSON(), expected)) {
    fail(`owner patch program row changed: ${id}`)
  }
  matches[0].set('config', document.createNode(replacement))
  return document.toString({ lineWidth: 0 })
}

export async function applyOwnerProgramAuthorityCas(api, home, stage, before, after, oldTrustDigest, newTrustDigest) {
  if (!before?.statePath || !before?.grant || !after?.statePath || !after?.grant
    || before.statePath !== after.statePath) return
  const path = physical(home, stage, before.statePath)
  try { await lstat(path) } catch (error) { if (error?.code === 'ENOENT') return; throw error }
  await bytes(path, 268_435_456)
  const kind = before.grant.maxApprovals !== undefined ? 'source_approval_grants'
    : before.grant.maxReleases !== undefined ? 'source_release_grants'
      : before.grant.maxAdoptions !== undefined ? 'source_adoption_grants'
        : before.grant.maxQualifications !== undefined ? 'live_qualification_grants'
          : before.grant.policy?.maximumObservations !== undefined ? 'task_observation_grants'
            : before.grant.maximumReloads !== undefined ? 'systemd_host_grants' : null
  if (!kind) fail('unknown finite authority state')
  const id = kind === 'task_observation_grants' ? before.grant.policy.id : before.grant.id
  const db = new DatabaseSync(path)
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(kind)) return
    const row = db.prepare(`SELECT * FROM ${kind} WHERE grant_id=?`).get(id)
    if (!row) return
    const digest = api.control.controlPlaneDigest
    if (row.config_digest !== digest(before)) fail(`authority CAS failed: ${kind}`)
    db.exec('BEGIN IMMEDIATE')
    try {
      let result
      if (kind === 'systemd_host_grants') {
        if (row.grant_digest !== digest(before.grant) || row.trust_digest !== oldTrustDigest) {
          fail('Host grant CAS failed')
        }
        result = db.prepare(`UPDATE systemd_host_grants SET grant_digest=?,config_digest=?,trust_digest=?
          WHERE grant_id=? AND grant_digest=? AND config_digest=? AND trust_digest=?`)
          .run(digest(after.grant), digest(after), newTrustDigest, id,
            row.grant_digest, row.config_digest, row.trust_digest)
      } else {
        result = db.prepare(`UPDATE ${kind} SET config_digest=? WHERE grant_id=? AND config_digest=?`)
          .run(digest(after), id, row.config_digest)
      }
      if (result.changes !== 1) fail(`authority CAS changed concurrently: ${kind}`)
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
  } finally { db.close() }
}

export function updateOwnerProgramJournal(original, patches, manifestDigest, unitTransitions) {
  const journal = structuredClone(original)
  const profiles = Object.keys(patches)
  if (!Array.isArray(unitTransitions) || unitTransitions.length !== profiles.length
    || new Set(unitTransitions.map(item => item.profile)).size !== profiles.length
    || journal.units?.length !== profiles.length || journal.entries?.length !== profiles.length) {
    fail('owner service transition inventory differs')
  }
  journal.manifestDigest = manifestDigest
  for (const profile of profiles) {
    const transition = unitTransitions.find(item => item.profile === profile)
    const unit = journal.units.find(item => item.profile === profile)
    const entry = journal.entries.find(item => item.profile === profile)
    if (!transition || !unit || !entry || transition.oldSource !== unit.after
      || typeof transition.newSource !== 'string' || !transition.newSource) {
      fail('owner service journal changed before upgrade')
    }
    unit.after = transition.newSource
    entry.after = patches[profile]
  }
  return journal
}

export async function stageOwnerProgramUpdate({ ownerUpdate, homePath, stageHome, record, resources, runtime,
  source, sourceBuild, releaseBuild, candidateCreation, stageNativeEffective, coordinatorBase,
  unitProperties, unitTransitions, installer = ownerUpdate?.installer, transactionId, hostPlan = ownerUpdate?.hostPlan }) {
  assertOwner(ownerUpdate, homePath, installer, hostPlan)
  const original = ownerUpdate.original, profile = ownerUpdate.profile, coordinator = ownerUpdate.coordinatorProfile
  if (!exact(stageHome) || stageHome === homePath || inside(homePath, stageHome)
    || !same(resources, original.resources) || !candidateCreation || !record || record.host !== null
    || typeof transactionId !== 'string' || !transactionId
    || !unitProperties
    || typeof stageNativeEffective?.targetEffective !== 'string'
    || typeof stageNativeEffective?.coordinatorEffective !== 'string'
    || typeof coordinatorBase !== 'string') fail('invalid staged owner program input')
  await privateDirectory(stageHome)
  const api = await apiFor(installer)
  const before = await verifyOwnerProgramUpdate({ ownerUpdate, homePath, physicalHome: stageHome,
    installer, phase: 'before-finalize', record })
  const stageRuntime = await api.readRsiAuthorityRuntimeReceipt({ logicalHome: homePath,
    physicalHome: stageHome, profile })
  if (!same(stageRuntime.runtime, runtime)) fail('staged authority runtime differs')
  const sourceState = await api.readRsiSourceMaintenance({ logicalHome: homePath,
    physicalHome: stageHome, profile })
  if (!same(sourceState.workspace, source) || !same(sourceState.records,
    [...original.source.records, record])) fail('staged owner source differs')
  const stoppedOwner = await api.rsiSetupPorts.snapshot(stageNativeEffective.targetEffective, homePath)
  if (!same(stoppedOwner.bindings, original.ownerSnapshot.bindings)
    || !same(stoppedOwner.scope, original.ownerSnapshot.scope)) {
    fail('owner binding changed before program update')
  }
  await assertOwnerProgramBusinessDataCopied(api, ownerUpdate, stageHome)
  const build = sourceBuild.sourceBuild ? sourceBuild : { schemaVersion: 1,
    sourceCommit: source.sourceCommit, sourceBuild }
  const release = releaseBuild.releaseBuild ?? releaseBuild
  if (build.sourceCommit !== source.sourceCommit || releaseBuild.sourceCommit !== source.sourceCommit
    || candidateCreation.creationBuild?.sourceCommit !== source.sourceCommit) {
    fail('new program source/build binding differs')
  }
  const creation = await api.materializeRsiCreationBuildInStage({
    candidateHome: candidateCreation.candidateHome, stagePhysicalHome: stageHome,
    logicalHome: homePath, profile, candidateSource: candidateCreation.candidateSource,
    candidateBuild: candidateCreation.candidateBuild, stagedSource: source, stagedBuild: build })
  if (creation.candidateReceiptSha256 !== candidateCreation.receiptSha256
    || !same(creation.creationBuild, candidateCreation.creationBuild)) {
    fail('materialized creation build differs')
  }
  const rebase = await rebaseFor(ownerUpdate, api, runtime)
  const hostProfiles = api.rebaseRsiHostProfiles({ manifest: original.manifest,
    targetPatch: original.patches[profile], coordinatorPatch: original.patches[coordinator], rebase })
  const manifest = hostProfiles.manifest
  const rebasedManifest = structuredClone(manifest)
  const oldControlPlane = structuredClone(manifest.controlPlane)
  manifest.controlPlane.sourceBuild = structuredClone(build.sourceBuild)
  const freshCreation = api.createRsiPluginCreationSetup({ resources, build: creation.creationBuild,
    owner: original.manifest.sourceReviews.owner,
    now: original.now, expiresAt: original.manifest.sourceReviews.expiresAt })
  manifest.pluginCreation = programCreation(manifest.pluginCreation, freshCreation)
  if (!same(manifest.controlPlane.sourceJobs.creation, original.manifest.controlPlane.sourceJobs.creation)) {
    fail('source creation grant changed')
  }
  manifest.controlPlane.creationVerifications = manifest.pluginCreation.verifications
  manifest.controlPlane.creationCapabilities = manifest.pluginCreation.capabilities
  if (!same(manifest.sourceReviews.owner, original.manifest.sourceReviews.owner)
    || !same(manifest.growthDriver, original.manifest.growthDriver)
    || !same(manifest.memoryLearning, original.manifest.memoryLearning)
    || !same(manifest.coordinator, original.manifest.coordinator)
    || !same(manifest.limits, original.manifest.limits)
    || !same(manifest.serviceEnvironment, original.manifest.serviceEnvironment)) {
    fail('owner model, memory, budget, or service scope changed')
  }
  const preDigestControlPlane = structuredClone(manifest.controlPlane)
  let targetPatch = replacePatchConfig(api, hostProfiles.targetPatch,
    'dsh-enhanced-plugin-control-plane', oldControlPlane, manifest.controlPlane)
  const oldVerifier = patchConfig(api, targetPatch, 'dsh-enhanced-assistant-verifier')
  if (!same(oldVerifier.sourceReviews, manifest.sourceReviews)
    || !same(oldVerifier.creationReviews, original.manifest.pluginCreation.reviews)) {
    fail('existing verifier review contract differs')
  }
  targetPatch = replacePatchConfig(api, targetPatch, 'dsh-enhanced-assistant-verifier', oldVerifier,
    { ...oldVerifier, creationReviews: manifest.pluginCreation.reviews })
  for (const target of manifest.controlPlane.runtimeObserver.targets) {
    if (target.entryId === 'dsh-enhanced-assistant-verifier') target.configDigest =
      api.control.runtimeConfigDigest(patchConfig(api, targetPatch, target.entryId))
  }
  assertOwnerProgramManifestPreserved(rebasedManifest, manifest)
  targetPatch = replacePatchConfig(api, targetPatch, 'dsh-enhanced-plugin-control-plane',
    preDigestControlPlane, manifest.controlPlane)
  if (rebase.oldHostRoot !== hostPlan.candidateRuntime.root && targetPatch.includes(rebase.oldHostRoot)) fail('owner patch retains an old Host path')
  const patchMap = { [profile]: targetPatch, [coordinator]: hostProfiles.coordinatorPatch }
  const hostConfig = parse(original.files[join(resources.configRoot, 'host-authority.json')], 'old Host authority')
  const trustConfig = parse(original.files[join(resources.configRoot, 'trust.json')], 'old trust')
  const releaseConfig = parse(original.files[join(resources.configRoot, 'release.json')], 'old release grant')
  const compiled = api.compileRsiAuthorityConfigs({ manifest, resources, runtime, source,
    releaseBuild: release, executor: api.rebaseRsiHostValue(trustConfig.executor, rebase),
    systemctl: api.rebaseRsiHostValue(hostConfig.template.systemctl, rebase),
    unitProperties, policies: api.rebaseRsiHostValue(releaseConfig.grant.policies, rebase),
    now: original.now })
  const manifestPath = join(resources.configRoot, 'manifest.json')
  const files = { ...compiled.files, [manifestPath]: json(manifest) }
  if (!same(Object.keys(files).sort(), Object.keys(original.fileDigests).sort())) {
    fail('owner authority inventory changed')
  }
  assertOwnerProgramAuthorityPreserved(original.files, files)
  const oldTrustDigest = api.control.controlPlaneDigest(await api.control.loadTrustConfig(
    physical(homePath, stageHome, join(resources.configRoot, 'trust.json'))))
  const newTrustDigest = api.control.controlPlaneDigest(compiled.trust)
  for (const path of Object.keys(files)) {
    const oldValue = parseMaybe(original.files[path]), newValue = parseMaybe(files[path])
    if (oldValue?.grant && newValue?.grant && oldValue.statePath) {
      await applyOwnerProgramAuthorityCas(api, homePath, stageHome, oldValue, newValue,
        oldTrustDigest, newTrustDigest)
    }
  }
  const journal = updateOwnerProgramJournal(original.journal, patchMap, hash(files[manifestPath]), unitTransitions)
  const journalSource = JSON.stringify(journal)
  for (const [path, sourceText] of Object.entries(files)) {
    const target = physical(homePath, stageHome, path)
    if (!inside(join(stageHome, 'rsi-authorities', profile, 'config'), target)) fail('authority escaped stage')
    await write(target, sourceText)
  }
  for (const [name, sourceText] of Object.entries(patchMap)) {
    await write(join(stageHome, 'profiles', name, 'cordis.patch.yml'), sourceText)
  }
  await write(join(stageHome, '.rsi-setup-journal.json'), journalSource)
  const fileDigests = Object.fromEntries(Object.entries(files).map(([path, value]) => [path, hash(value)]))
  const patchDigests = Object.fromEntries(Object.entries(patchMap).map(([name, value]) => [name, hash(value)]))
  const authorityDigest = authoritySemanticDigest(files)
  const previous = original.overlay.records
  const overlay = api.signRsiOwnerProgramUpdateOverlay({ schemaVersion: 1,
    kind: 'rsi-owner-program-update-overlay', transactionId, dshHome: homePath,
    targetProfile: profile, installationId: resources.installationId,
    sequence: previous.length + 1, previousDigest: previous.length
      ? api.rsiHostUpdateOverlayDigest(previous.at(-1)) : null,
    bootstrapDigest: hash(original.receiptSource), files: fileDigests, patches: patchDigests,
    runtimeReceiptDigest: stageRuntime.receiptDigest,
    planDigest: hash(json({ files: fileDigests, patches: patchDigests })),
    result: { schemaVersion: 1, manifestPath, manifestDigest: fileDigests[manifestPath],
      targetProfile: profile, coordinatorProfile: coordinator },
    update: { sourceMaintenanceDigest: api.control.sourceMaintenanceDigest(record),
      authorityDigest, hostPlanDigest: ownerUpdate.hostPlanDigest,
      before: { files: original.fileDigests, patches: original.patchDigests,
        runtimeReceiptDigest: original.runtimeReceiptDigest,
        creationReceiptDigest: original.creationDigest, journalDigest: hash(original.journalSource) },
      after: { creationReceiptDigest: creation.receiptSha256,
        journalDigest: hash(journalSource) } },
    issuedAt: Math.max(Date.now(), previous.at(-1)?.issuedAt ?? 0),
    authority: resources.identities.host.authority, keyId: resources.identities.host.keyId },
  (await bytes(physical(homePath, stageHome, resources.identities.host.keyPath), 16_384)).toString('utf8'),
  resources, original.receiptSource, previous)
  const overlayPath = physical(homePath, stageHome, join(resources.configRoot, 'host-update-overlays.json'))
  await write(overlayPath, json({ schemaVersion: 1, kind: 'rsi-host-update-overlays',
    records: [...previous, overlay] }))
  const next = { schemaVersion: 1, transactionId, manifestPath, manifestDigest: fileDigests[manifestPath],
    files: fileDigests, patches: patchDigests, overlay,
    overlayDigest: api.rsiHostUpdateOverlayDigest(overlay), creationReceiptSha256: creation.receiptSha256,
    candidateReceiptSha256: creation.candidateReceiptSha256, journalDigest: hash(journalSource),
    recordDigest: api.control.sourceMaintenanceDigest(record), authorityDigest,
    hostPlanDigest: ownerUpdate.hostPlanDigest, sourceHistoryDigest: before.sourceHistoryDigest }
  await verifyOwnerProgramUpdate({ ownerUpdate, ownerUpdateNext: next, homePath,
    physicalHome: stageHome, installer, phase: 'after-finalize', record, checkLedger: true })
  return next
}

function parseMaybe(source) {
  if (typeof source !== 'string' || !source.trimStart().startsWith('{')) return null
  return parse(source, 'authority configuration')
}

export async function verifyOwnerProgramUpdate({ ownerUpdate, ownerUpdateNext, homePath,
  physicalHome = homePath, installer = ownerUpdate?.installer, phase = 'original',
  record, checkLedger = false }) {
  assertOwner(ownerUpdate, homePath, installer)
  if (!['original', 'before-finalize', 'after-finalize'].includes(phase)
    || phase === 'before-finalize' && !record
    || phase === 'after-finalize' && !ownerUpdateNext
    || !exact(physicalHome)) fail('invalid owner verification phase')
  await privateDirectory(physicalHome)
  const api = await apiFor(installer), original = ownerUpdate.original
  const selectedDigests = phase === 'after-finalize' ? ownerUpdateNext.files : original.fileDigests
  if (!same(Object.keys(selectedDigests).sort(), Object.keys(original.fileDigests).sort())) {
    fail('owner file inventory changed')
  }
  const files = await currentFiles(homePath, physicalHome, selectedDigests)
  const patchDigests = phase === 'after-finalize' ? ownerUpdateNext.patches : original.patchDigests
  if (!same(Object.keys(patchDigests).sort(), Object.keys(original.patchDigests).sort())) {
    fail('owner patch inventory changed')
  }
  const patches = await currentPatches(homePath, physicalHome, patchDigests)
  const manifestPath = join(original.resources.configRoot, 'manifest.json')
  const manifest = parse(files[manifestPath], 'verified owner manifest')
  if (manifest.targetProfile !== ownerUpdate.profile || manifest.coordinatorProfile !== ownerUpdate.coordinatorProfile
    || !same(manifest.sourceReviews.owner, original.manifest.sourceReviews.owner)
    || !same(manifest.growthDriver, original.manifest.growthDriver)
    || !same(manifest.memoryLearning, original.manifest.memoryLearning)
    || !same(manifest.coordinator, original.manifest.coordinator)
    || !same(manifest.limits, original.manifest.limits)) fail('owner identity, model, or budget contract changed')
  if ((await bytes(physical(homePath, physicalHome, join(original.resources.configRoot,
    'bootstrap.json')))).toString('utf8') !== original.receiptSource) {
    fail('original owner bootstrap receipt was replaced')
  }
  const journalSource = (await bytes(join(physicalHome, '.rsi-setup-journal.json'))).toString('utf8')
  const journal = parse(journalSource, 'owner setup journal')
  if (journal.manifestDigest !== hash(files[manifestPath])
    || !same(journal.entries?.map(item => [item.profile, item.after]),
      [ownerUpdate.profile, ownerUpdate.coordinatorProfile].map(name => [name, patches[name]]))) {
    fail('owner journal or profile patch differs')
  }
  const creationSource = (await bytes(join(physicalHome, 'rsi-creation-builds', ownerUpdate.profile,
    'bootstrap.json'), 65_536)).toString('utf8')
  const overlaySource = await optional(join(physicalHome, 'rsi-authorities', ownerUpdate.profile,
    'config', 'host-update-overlays.json'), 2_097_152)
  const chain = overlayChain(api, ownerUpdate, overlaySource)
  if (phase === 'after-finalize') {
    if (chain.records.length !== original.overlay.records.length + 1
      || !same(chain.records.slice(0, -1), original.overlay.records)
      || chain.latest?.kind !== 'rsi-owner-program-update-overlay'
      || !same(chain.latest, ownerUpdateNext.overlay)
      || api.rsiHostUpdateOverlayDigest(chain.latest) !== ownerUpdateNext.overlayDigest
      || !same(chain.latest.files, selectedDigests) || !same(chain.latest.patches, patchDigests)
      || chain.latest.update.hostPlanDigest !== ownerUpdate.hostPlanDigest
      || chain.latest.update.sourceMaintenanceDigest !== ownerUpdateNext.recordDigest
      || chain.latest.update.authorityDigest !== ownerUpdateNext.authorityDigest
      || chain.latest.update.authorityDigest !== authoritySemanticDigest(files)
      || !same(chain.latest.update.before, { files: original.fileDigests,
        patches: original.patchDigests, runtimeReceiptDigest: original.runtimeReceiptDigest,
        creationReceiptDigest: original.creationDigest, journalDigest: hash(original.journalSource) })
      || chain.latest.update.after.creationReceiptDigest !== hash(creationSource)
      || chain.latest.update.after.journalDigest !== hash(journalSource)
      || ownerUpdateNext.manifestDigest !== hash(files[manifestPath])) {
      fail('signed owner program update differs')
    }
    assertOwnerProgramAuthorityPreserved(original.files, files)
  } else if (!same(chain.records, original.overlay.records)
    || journalSource !== original.journalSource || creationSource !== original.creationSource
    || !same(files, original.files) || !same(patches, original.patches)) {
    fail('original owner proof changed')
  }
  const runtime = await api.readRsiAuthorityRuntimeReceipt({ logicalHome: homePath,
    physicalHome, profile: ownerUpdate.profile })
  if (phase === 'original' && !same(runtime, original.runtime)
    || phase === 'after-finalize' && runtime.receiptDigest !== chain.latest.runtimeReceiptDigest) {
    fail('authority runtime receipt differs')
  }
  if (phase === 'before-finalize') {
    await standingData(homePath, physicalHome, ownerUpdate.profile, { ledgerChanged: true })
  }
  const source = await api.readRsiSourceMaintenance({ logicalHome: homePath,
    physicalHome, profile: ownerUpdate.profile })
  const expectedPrefix = phase === 'original' ? original.source.records
    : [...original.source.records, record ?? source.records[original.source.records.length]]
  if (phase === 'after-finalize' && !checkLedger
    ? !same(source.records.slice(0, expectedPrefix.length), expectedPrefix)
    : !same(source.records, expectedPrefix)) {
    fail('source maintenance history was rewritten')
  }
  if (phase !== 'original' && api.control.sourceMaintenanceDigest(
    source.records[original.source.records.length])
    !== (phase === 'after-finalize' ? ownerUpdateNext.recordDigest : api.control.sourceMaintenanceDigest(record))) {
    fail('source maintenance update differs')
  }
  let sourceHistoryDigest
  if (phase !== 'after-finalize' || checkLedger) {
    const state = await ledger(api, homePath, physicalHome, ownerUpdate.profile,
      original.source.workspace.repository, source.records)
    sourceHistoryDigest = hash(json(state.history))
    if (phase === 'before-finalize') {
      const stopped = await ledger(api, homePath, homePath, ownerUpdate.profile,
        original.source.workspace.repository, original.source.records)
      if (sourceHistoryDigest !== hash(json(stopped.history))) {
        fail('staged source history differs from stopped original')
      }
    } else if (phase === 'after-finalize'
      && sourceHistoryDigest !== ownerUpdateNext.sourceHistoryDigest) {
      fail('prior source history changed after staging')
    }
  }
  if (phase === 'original') {
    const composed = await composeOwnerRepairProfiles({ homePath, profile: ownerUpdate.profile,
      coordinatorProfile: ownerUpdate.coordinatorProfile, dshPath: ownerUpdate.dshPath })
    if (composed.dshDigest !== ownerUpdate.host.dshDigest
      || !same({ targetEffective: composed.targetEffective,
        coordinatorEffective: composed.coordinatorEffective }, original.effective)
      || !ownerRepairSuccessorSnapshotEquivalent(await api.rsiSetupPorts.snapshot(
        composed.targetEffective, homePath), original.ownerSnapshot)) {
      fail('original Host composition or owner binding changed')
    }
  }
  return { phase, manifestDigest: hash(files[manifestPath]),
    ...(sourceHistoryDigest ? { sourceHistoryDigest } : {}),
    ...(phase === 'after-finalize' ? { overlayDigest: ownerUpdateNext.overlayDigest } : {}) }
}

export async function awaitOwnerProgramReady({ ownerUpdate, ownerUpdateNext, homePath,
  installer = ownerUpdate?.installer, startedAt, signal }) {
  assertOwner(ownerUpdate, homePath, installer)
  if (!Number.isSafeInteger(startedAt) || startedAt <= 0 || startedAt > Date.now()) {
    fail('invalid readiness start time')
  }
  await verifyOwnerProgramUpdate({ ownerUpdate, ownerUpdateNext, homePath,
    installer, phase: 'after-finalize' })
  const api = await apiFor(installer)
  const manifest = parse((await bytes(ownerUpdateNext.manifestPath)).toString('utf8'), 'updated owner manifest')
  const host = parse((await bytes(join(ownerUpdate.original.resources.configRoot,
    'host-authority.json'))).toString('utf8'), 'updated Host authority')
  if (!same(host.grant?.owner, ownerUpdate.original.manifest.sourceReviews.owner)
    || host.grant?.notBefore !== ownerUpdate.original.now
    || host.grant?.expiresAt !== ownerUpdate.original.manifest.sourceReviews.expiresAt) {
    fail('standing finite Host grant changed')
  }
  await api.rsiInstallPorts.ready(manifest, host.template.systemctl,
    signal ?? new AbortController().signal, startedAt)
  return { mode: 'ready', manifestDigest: ownerUpdateNext.manifestDigest,
    overlayDigest: ownerUpdateNext.overlayDigest }
}
