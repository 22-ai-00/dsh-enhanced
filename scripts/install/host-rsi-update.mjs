/** Offline RSI authority rebasing for a copied, stopped DSH_HOME. This module
 * deliberately imports the migration-aware frozen cohort from that Home. */
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => `${JSON.stringify(value, null, 2)}\n`
const profileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const unitFields = ['FragmentPath', 'DropInPaths', 'ExecStart', 'Environment', 'WorkingDirectory', 'User', 'Group', 'Type', 'KillMode']
const fail = message => { throw new Error(`Host RSI update: ${message}`) }
const inside = (root, path) => path === root || path.startsWith(root + sep)

async function privateBytes(path, maximum = 2_097_152) {
  const entry = await lstat(path)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.uid !== process.getuid()
    || (entry.mode & 0o077) !== 0 || entry.size < 1 || entry.size > maximum) fail(`unsafe private file: ${path}`)
  return readFile(path)
}
async function boundBytes(path, maximum = 268_435_456) {
  const entry = await lstat(path)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.uid !== process.getuid()
    || (entry.mode & 0o022) !== 0 || entry.size < 1 || entry.size > maximum) fail(`unsafe bound file: ${path}`)
  return readFile(path)
}
async function sqliteFiles(path) {
  await privateBytes(path, 268_435_456)
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = `${path}${suffix}`
    const entry = await optional(sidecar)
    if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.uid !== process.getuid()
      || (entry.mode & 0o077) !== 0 || entry.size > 268_435_456)) fail(`unsafe SQLite sidecar: ${sidecar}`)
  }
}
async function optional(path) {
  try { return await lstat(path) } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error }
}
function physical(logicalHome, physicalHome, path) {
  if (!isAbsolute(path) || resolve(path) !== path || !inside(logicalHome, path)) fail(`path is outside the bound Home: ${path}`)
  return join(physicalHome, relative(logicalHome, path))
}
async function sourceAt(logicalHome, physicalHome, path, maximum) {
  return (await privateBytes(physical(logicalHome, physicalHome, path), maximum)).toString('utf8')
}
async function boundSourceAt(logicalHome, physicalHome, path, maximum) {
  return (await boundBytes(physical(logicalHome, physicalHome, path), maximum)).toString('utf8')
}
async function readJson(logicalHome, physicalHome, path, maximum) {
  return JSON.parse(await sourceAt(logicalHome, physicalHome, path, maximum))
}
async function saveJson(logicalHome, physicalHome, path, value) {
  await writeFile(physical(logicalHome, physicalHome, path), json(value), { mode: 0o600 })
}
function receiptBody(receipt, digestName) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || !/^[a-f0-9]{64}$/u.test(receipt[digestName] || '')) fail('receipt is invalid')
  const { [digestName]: digest, ...body } = receipt
  if (hash(JSON.stringify(body)) !== digest) fail('receipt digest differs')
  return body
}
async function installations(homePath, physicalHome = homePath) {
  const parent = join(physicalHome, 'rsi-authorities')
  if (await optional(parent) === undefined) return []
  const result = []
  for (const targetProfile of (await readdir(parent)).sort()) {
    if (!profileName.test(targetProfile)) fail(`unknown RSI authority entry: ${targetProfile}`)
    const root = join(homePath, 'rsi-authorities', targetProfile)
    const resourcesReceipt = await readJson(homePath, physicalHome, join(root, 'bootstrap.json'), 65_536)
    receiptBody(resourcesReceipt, 'receiptDigest')
    if (resourcesReceipt.schemaVersion !== 1 || resourcesReceipt.dshHome !== homePath
      || resourcesReceipt.profile !== targetProfile || resourcesReceipt.resources?.root !== root) fail('authority resource binding differs')
    const coordinatorPath = join(homePath, `.rsi-coordinator-${hash(targetProfile).slice(0, 16)}.json`)
    const coordinator = await readJson(homePath, physicalHome, coordinatorPath, 65_536)
    if (coordinator.schemaVersion !== 1 || coordinator.targetProfile !== targetProfile
      || !profileName.test(coordinator.coordinatorProfile) || coordinator.coordinatorProfile === targetProfile) fail('coordinator binding differs')
    const configRoot = join(root, 'config'), manifestPath = join(configRoot, 'manifest.json')
    const manifest = await readJson(homePath, physicalHome, manifestPath, 2_097_152)
    if (manifest.schemaVersion !== 1 || manifest.targetProfile !== targetProfile
      || manifest.coordinatorProfile !== coordinator.coordinatorProfile || manifest.controlPlane?.statePath === undefined) fail('owner manifest differs')
    const ledgerPath = join(manifest.controlPlane.statePath, 'control.sqlite')
    result.push({ targetProfile, coordinatorProfile: coordinator.coordinatorProfile, root, configRoot,
      resources: resourcesReceipt.resources, manifestPath, manifest, ledgerPath })
  }
  return result
}

async function installedMigrationModules(homePath, profile) {
  const canonicalHome = await realpath(homePath)
  const root = join(canonicalHome, 'profiles', profile, 'node_modules', '@dsh-enhanced')
  const cp = await realpath(join(root, 'plugin-control-plane'))
  const lark = await realpath(join(root, 'lark-channel'))
  if (!inside(canonicalHome, cp) || !inside(canonicalHome, lark)) fail('migration code is not materialized inside Home')
  const load = async (packageRoot, filename) => import(pathToFileURL(join(packageRoot, 'lib', filename)).href)
  const [store, sqlite, maintenance, trust, authorityRuntime, authorityResources, hostUpdate] = await Promise.all([
    load(cp, 'store.js'), load(cp, 'sqlite.js'), load(cp, 'host-maintenance.js'), load(cp, 'trust.js'),
    load(lark, 'rsi-authority-runtime.js'), load(lark, 'rsi-authority-resources.js'), load(lark, 'rsi-host-update.js'),
  ])
  for (const [module, name] of [[store, 'readHostMaintenanceContext'], [store, 'appendHostMaintenance'],
    [sqlite, 'openControlPlaneDatabase'], [maintenance, 'signHostMaintenanceRecord'],
    [maintenance, 'hostMaintenanceDigest'], [authorityRuntime, 'replaceRsiAuthorityRuntimeInStage'],
    [trust, 'loadTrustConfig'],
    [authorityResources, 'prepareRsiAuthorityResources'],
    [hostUpdate, 'rebaseRsiHostActivePatch'], [hostUpdate, 'rebaseRsiHostManifest'], [hostUpdate, 'rebaseRsiHostValue'],
    [hostUpdate, 'readRsiHostUpdateOverlayChain'], [hostUpdate, 'signRsiHostUpdateOverlay'],
    [store, 'readCurrentRuntimeEpochDeployment']]) {
    if (typeof module[name] !== 'function') fail(`installed cohort lacks migration API: ${name}`)
  }
  return { store, sqlite, maintenance, trust, authorityRuntime, authorityResources, hostUpdate }
}

async function watchedPlans(installation, homePath, physicalHome, modules) {
  const databasePath = physical(homePath, physicalHome, installation.ledgerPath)
  await sqliteFiles(databasePath)
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    db.exec('PRAGMA query_only=ON')
    const { plan } = modules.store.readCurrentRuntimeEpochDeployment(db,
      join(homePath, 'profiles', installation.targetProfile))
    const suffix = String(plan.activation?.id || '').replace(/[^A-Za-z0-9-]/gu, '').slice(-36)
    if (!suffix) fail('current activation has no backup suffix')
    const backup = plan.activation.targetOriginallyExisted
      ? `.${installation.targetProfile}.plugin-backup-${suffix}` : undefined
    if (backup && !(await optional(join(physicalHome, 'profiles', backup)))?.isDirectory()) fail(`current backup is missing: ${backup}`)
    return [{ id: plan.id, activationId: plan.activation.id, backup }]
  } finally { db.close() }
}

// Changing grant configuration invalidates replay under the old configuration.
// Keep every unfinished operation on its original runtime until reconciled.
async function assertSettledWork(installation, homePath, physicalHome) {
  const databasePath = physical(homePath, physicalHome, installation.ledgerPath)
  await sqliteFiles(databasePath)
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    db.exec('PRAGMA query_only=ON; BEGIN')
    const settled = {
      source_jobs: ['prepared', 'failed'],
      source_plans: ['expired', 'local-checks-failed', 'release-complete', 'release-failed'],
      activation_plans: ['activated', 'rolled-back'],
      source_release_operations: ['applied'],
      source_publish_reconciliations: ['applied'],
      host_attestation_operations: ['applied'],
      source_release_dispatches: ['completed'],
      host_attestation_dispatches: ['completed'],
      deployment_runtime_epochs: ['applied', 'stale'],
    }
    for (const [table, statuses] of Object.entries(settled)) {
      const row = db.prepare(`SELECT status FROM ${table} WHERE status IS NULL OR status NOT IN (${statuses.map(() => '?').join(',')}) LIMIT 1`).get(...statuses)
      if (row) fail(`unsettled ${table} (${row.status}); reconcile on the current Host before updating`)
    }
    for (const table of ['task_observation_batches', 'live_qualification_batches']) {
      if (db.prepare(`SELECT 1 FROM ${table} WHERE state IS NULL OR state NOT IN ('applied','stale') LIMIT 1`).get()) {
        fail(`unsettled ${table}; reconcile on the current Host before updating`)
      }
    }
    db.exec('COMMIT')
  } finally { db.close() }
}

/** Only backups anchored by an activated, watched original Control Plane plan
 * are admitted to the separate profile dependency migration. */
export async function discoverRsiHostUpdateBackups({ homePath }) {
  const approved = new Set()
  for (const installation of await installations(homePath)) {
    await assertSettledWork(installation, homePath, homePath)
    const modules = await installedMigrationModules(homePath, installation.targetProfile)
    for (const plan of await watchedPlans(installation, homePath, homePath, modules)) if (plan.backup) approved.add(plan.backup)
  }
  return { approvedBackupNames: [...approved].sort() }
}

function collectPins(value, oldHostRoot, result = new Map()) {
  if (Array.isArray(value)) { for (const item of value) collectPins(item, oldHostRoot, result); return result }
  if (!value || typeof value !== 'object') return result
  if (typeof value.path === 'string' && typeof value.sha256 === 'string' && inside(oldHostRoot, value.path)) result.set(value.path, value.sha256)
  for (const item of Object.values(value)) collectPins(item, oldHostRoot, result)
  return result
}
function runtimePinMap(oldRuntime, replacement) {
  const result = {}
  const visit = (oldValue, newValue) => {
    if (!oldValue || !newValue || typeof oldValue !== 'object' || typeof newValue !== 'object') return
    if (typeof oldValue.path === 'string' && typeof oldValue.sha256 === 'string') {
      if (typeof newValue.path !== 'string' || typeof newValue.sha256 !== 'string') fail('runtime pin shape changed')
      result[oldValue.path] = { path: newValue.path, sha256: newValue.sha256 }
      return
    }
    for (const [key, value] of Object.entries(oldValue)) visit(value, newValue[key])
  }
  visit(oldRuntime, replacement)
  return result
}

function assertUnitProperties(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...unitFields].sort())
    || Object.values(value).some(item => typeof item !== 'string')) fail('candidate unit properties are incomplete')
}

async function ownerConfiguration(installation, homePath, physicalHome, modules) {
  const receiptPath = join(installation.configRoot, 'bootstrap.json')
  const bootstrapSource = await sourceAt(homePath, physicalHome, receiptPath, 2_097_152)
  const receipt = JSON.parse(bootstrapSource)
  if (receipt.schemaVersion !== 1 || !receipt.files || receipt.result?.manifestPath !== installation.manifestPath
    || receipt.result?.targetProfile !== installation.targetProfile || receipt.result?.coordinatorProfile !== installation.coordinatorProfile) fail('owner bootstrap receipt differs')
  const overlayPath = join(installation.configRoot, 'host-update-overlays.json')
  const overlaySource = await optional(physical(homePath, physicalHome, overlayPath))
    ? await sourceAt(homePath, physicalHome, overlayPath, 2_097_152) : undefined
  const overlay = modules.hostUpdate.readRsiHostUpdateOverlayChain({ source: overlaySource,
    resources: installation.resources, dshHome: homePath, profile: installation.targetProfile, bootstrapSource })
  const effective = overlay.latest ?? receipt
  const sources = {}
  for (const [path, digest] of Object.entries(effective.files)) {
    if (!inside(installation.configRoot, path) || [receiptPath, overlayPath].includes(path) || !/^[a-f0-9]{64}$/u.test(digest)) fail('owner config file pin is invalid')
    const source = await sourceAt(homePath, physicalHome, path, 2_097_152)
    if (hash(source) !== digest) fail(`owner config changed: ${path}`)
    sources[path] = source
  }
  const patches = { targetPatch: await boundSourceAt(homePath, physicalHome, join(homePath, 'profiles', installation.targetProfile, 'cordis.patch.yml'), 2_097_152),
    coordinatorPatch: await boundSourceAt(homePath, physicalHome, join(homePath, 'profiles', installation.coordinatorProfile, 'cordis.patch.yml'), 2_097_152) }
  if (effective.result.manifestDigest !== hash(sources[installation.manifestPath])) fail('owner manifest changed')
  if (overlay.latest) {
    const current = await watchedPlans(installation, homePath, physicalHome, modules)
    if (hash(json({ files: effective.files, patches: overlay.latest.patches })) !== effective.planDigest) fail('owner overlay plan changed')
    if (current[0]?.id === overlay.latest.currentPlanId) {
      for (const [profile, digest] of Object.entries(overlay.latest.patches)) {
        if (!profileName.test(profile) && !/^\.[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.plugin-backup-[A-Za-z0-9-]{1,36}$/u.test(profile)) fail('owner patch overlay profile differs')
        const source = await boundSourceAt(homePath, physicalHome, join(homePath, 'profiles', profile, 'cordis.patch.yml'), 2_097_152)
        if (hash(source) !== digest) fail('owner patch overlay changed')
      }
      if (overlay.latest.patches[installation.targetProfile] !== hash(patches.targetPatch)
        || overlay.latest.patches[installation.coordinatorProfile] !== hash(patches.coordinatorPatch)) fail('current owner patch overlay changed')
    }
  }
  return { receiptPath, receipt, bootstrapSource, overlayPath, overlay, effective, sources, patches }
}

function originalSnapshot(context, unitProperties) {
  const prior = context.records.at(-1)
  if (prior) return prior.after
  const { plan, witness } = context
  if (!witness || !plan.activation) fail('watched deployment has no original witness')
  return { executor: plan.executor, profileFiles: witness.profileFiles,
    baselineFiles: plan.activation.targetBaselineFiles, deploymentFiles: witness.deploymentFiles,
    baselineDeploymentFiles: witness.baselineDeploymentFiles, unitProperties }
}
async function repinSnapshot(before, candidate, homePath, stageHome, backup) {
  const pin = async (item, baseline) => {
    const activeRoot = join(homePath, 'profiles', candidate.profile)
    if (baseline && backup && !inside(activeRoot, item.path)) fail('baseline pin is outside target profile')
    const path = baseline && backup
      ? join(stageHome, 'profiles', backup, relative(activeRoot, item.path))
      : physical(homePath, stageHome, item.path)
    if (!inside(stageHome, path)) fail('maintenance pin escaped stage')
    if (baseline && item.sha256 === null && await optional(path) === undefined) return item
    const value = await boundBytes(path, 268_435_456)
    return { ...item, sha256: hash(value) }
  }
  return { executor: candidate.executor,
    profileFiles: await Promise.all(before.profileFiles.map(item => pin(item, false))),
    baselineFiles: await Promise.all(before.baselineFiles.map(item => pin(item, true))),
    deploymentFiles: await Promise.all(before.deploymentFiles.map(item => pin(item, false))),
    baselineDeploymentFiles: await Promise.all(before.baselineDeploymentFiles.map(item => pin(item, true))),
    unitProperties: candidate.unitProperties }
}
async function verifyOriginalSnapshot(before, homePath, profile, backup) {
  const activeRoot = join(homePath, 'profiles', profile)
  const check = async (item, baseline) => {
    if (!item || typeof item.path !== 'string' || !inside(activeRoot, item.path)) fail('original maintenance pin escaped profile')
    const path = baseline && backup ? join(homePath, 'profiles', backup, relative(activeRoot, item.path)) : item.path
    if (baseline && item.sha256 === null) {
      if (await optional(path)) fail('absent baseline file appeared')
      return
    }
    if (hash(await boundBytes(path)) !== item.sha256) fail(`original deployment pin changed: ${item.path}`)
  }
  for (const item of before.profileFiles) await check(item, false)
  for (const item of before.deploymentFiles) await check(item, false)
  for (const item of before.baselineFiles) await check(item, true)
  for (const item of before.baselineDeploymentFiles) await check(item, true)
}

function transitionFor(installation, transitions) {
  const target = transitions.find(item => item.profile === installation.targetProfile)
  const coordinator = transitions.find(item => item.profile === installation.coordinatorProfile)
  if (!target || !coordinator || target.unit !== `dsh-profile-${target.profile}.service`
    || coordinator.unit !== `dsh-profile-${coordinator.profile}.service`) fail('RSI pair unit transitions are incomplete')
  assertUnitProperties(target.unitProperties); assertUnitProperties(coordinator.unitProperties)
  return target
}

async function authorityStateCas({ config, oldConfig, oldTrustDigest, newTrustDigest, homePath, stageHome, controlPlaneDigest }) {
  const statePath = physical(homePath, stageHome, config.statePath)
  if (await optional(statePath) === undefined) return
  await sqliteFiles(statePath)
  const db = new DatabaseSync(statePath)
  const table = config.grant?.maxApprovals !== undefined ? 'source_approval_grants'
    : config.grant?.maxReleases !== undefined ? 'source_release_grants'
      : config.grant?.maxAdoptions !== undefined ? 'source_adoption_grants'
        : config.grant?.maxQualifications !== undefined ? 'live_qualification_grants'
          : config.grant?.policy?.maximumObservations !== undefined ? 'task_observation_grants'
            : config.grant?.maximumReloads !== undefined ? 'systemd_host_grants' : undefined
  if (!table) { db.close(); fail('authority state has unknown grant kind') }
  const id = table === 'task_observation_grants' ? config.grant.policy.id : config.grant.id
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return
    const row = db.prepare(`SELECT * FROM ${table} WHERE grant_id=?`).get(id)
    if (!row) return
    const oldDigest = controlPlaneDigest(oldConfig), newDigest = controlPlaneDigest(config)
    if (row.config_digest !== oldDigest) fail(`authority grant CAS failed: ${table}`)
    db.exec('BEGIN IMMEDIATE')
    try {
      if (table === 'systemd_host_grants') {
        const oldGrant = controlPlaneDigest(oldConfig.grant)
        if (row.grant_digest !== oldGrant || row.trust_digest !== oldTrustDigest) fail('Host grant digest differs')
        const changed = db.prepare(`UPDATE systemd_host_grants SET grant_digest=?,config_digest=?,trust_digest=?
          WHERE grant_id=? AND grant_digest=? AND config_digest=? AND trust_digest=?`)
          .run(controlPlaneDigest(config.grant), newDigest, newTrustDigest, id,
            row.grant_digest, row.config_digest, row.trust_digest)
        if (changed.changes !== 1) fail('Host grant changed during stage migration')
      } else {
        const changed = db.prepare(`UPDATE ${table} SET config_digest=? WHERE grant_id=? AND config_digest=?`)
          .run(newDigest, id, oldDigest)
        if (changed.changes !== 1) fail(`authority grant changed during stage migration: ${table}`)
      }
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
  } finally { db.close() }
}

async function verifyRuntimeReceiptPhysical(homePath, physicalHome, profile) {
  const logicalRoot = join(homePath, 'rsi-authority-runtimes', profile)
  const root = physical(homePath, physicalHome, logicalRoot)
  const source = await privateBytes(join(root, 'receipt.json'), 65_536)
  const receipt = JSON.parse(source.toString('utf8'))
  receiptBody(receipt, 'digest')
  if (receipt.schemaVersion !== 1 || receipt.root !== logicalRoot || !Array.isArray(receipt.entries)
    || receipt.entries.length > 512) fail('runtime receipt shape differs')
  for (const entry of receipt.entries) {
    if (!entry || typeof entry.path !== 'string' || entry.path.split('/').some(part => !part || part === '.' || part === '..')
      || !/^[a-f0-9]{64}$/u.test(entry.sha256)) fail('runtime receipt entry is invalid')
    const file = await privateBytes(join(root, entry.path), 160_000_000)
    if (file.length !== entry.size || hash(file) !== entry.sha256) fail(`runtime entry differs: ${entry.path}`)
  }
  return { runtime: Object.fromEntries(Object.entries(receipt).filter(([key]) => !['entries', 'digest'].includes(key))),
    receiptDigest: hash(source) }
}

/** Rebase finite RSI configuration and append a signed CP maintenance proof in
 * the copied Home. No original Home file or live service is changed. */
export async function prepareRsiHostUpdate({ homePath, stageHome, hostPlan, unitTransitions, transactionId, systemctlExecutable }) {
  if (!isAbsolute(homePath) || resolve(homePath) !== homePath || !isAbsolute(stageHome) || resolve(stageHome) !== stageHome
    || homePath === stageHome || typeof transactionId !== 'string' || !transactionId
    || !Array.isArray(unitTransitions) || !isAbsolute(systemctlExecutable)) fail('invalid transaction binding')
  const found = await installations(homePath)
  if (!found.length) return { schemaVersion: 1, mode: 'empty', hostPlanDigest: hash(JSON.stringify(hostPlan)),
    authorizedPatchDigests: {}, installations: [] }
  const proof = { schemaVersion: 1, mode: 'prepared', hostPlanDigest: hash(JSON.stringify(hostPlan)),
    authorizedPatchDigests: {}, installations: [] }
  // Check all installations before mutating any staged runtime or authority.
  for (const installation of found) {
    await assertSettledWork(installation, homePath, homePath)
    await assertSettledWork(installation, homePath, stageHome)
  }
  for (const installation of found) {
    const transition = transitionFor(installation, unitTransitions)
    const oldModules = await installedMigrationModules(homePath, installation.targetProfile)
    const newModules = await installedMigrationModules(stageHome, installation.targetProfile)
    const originalResources = await oldModules.authorityResources.prepareRsiAuthorityResources({
      dshHome: homePath, profile: installation.targetProfile, existingOnly: true })
    if (hash(JSON.stringify(originalResources)) !== hash(JSON.stringify(installation.resources))) fail('original Host signing resources changed')
    const oldOwner = await ownerConfiguration(installation, homePath, homePath, oldModules)
    const stageOwner = await ownerConfiguration(installation, homePath, stageHome, newModules)
    if (hash(JSON.stringify(oldOwner)) !== hash(JSON.stringify(stageOwner))) fail('copied owner configuration changed before migration')
    const previousRuntime = await oldModules.authorityRuntime.readRsiAuthorityRuntimeReceipt({
      logicalHome: homePath, physicalHome: homePath, profile: installation.targetProfile })
    if (oldOwner.overlay.latest && oldOwner.overlay.latest.runtimeReceiptDigest !== previousRuntime.receiptDigest) fail('original authority runtime overlay differs')
    const stageRuntime = await newModules.authorityRuntime.readRsiAuthorityRuntimeReceipt({
      logicalHome: homePath, physicalHome: stageHome, profile: installation.targetProfile })
    if (previousRuntime.receiptDigest !== stageRuntime.receiptDigest) fail('copied authority runtime differs')
    const replacementRuntime = await newModules.authorityRuntime.replaceRsiAuthorityRuntimeInStage({
      logicalHome: homePath, physicalHome: stageHome, profile: installation.targetProfile })
    const pins = runtimePinMap(previousRuntime.runtime, replacementRuntime)
    const oldHostRoot = hostPlan.originalRuntime.root, newHostRoot = hostPlan.candidateRuntime.root
    const allValues = Object.values(oldOwner.sources).filter(source => source.trimStart().startsWith('{')).map(source => JSON.parse(source))
    for (const [path, expected] of collectPins(allValues, oldHostRoot)) {
      if (hash(await readFile(path)) !== expected) fail(`old Host pin differs: ${path}`)
      const candidate = join(newHostRoot, relative(oldHostRoot, path))
      if (!inside(newHostRoot, candidate)) fail('candidate Host pin escaped root')
      pins[path] = { path: candidate, sha256: hash(await readFile(candidate)) }
    }
    const oldManifest = installation.manifest
    const rebase = { oldHostRoot, oldHostVersion: hostPlan.originalRuntime.version,
      candidateHostVersion: hostPlan.candidateRuntime.version, pins }
    const manifest = newModules.hostUpdate.rebaseRsiHostManifest(oldManifest, rebase)
    const targetPatch = newModules.hostUpdate.rebaseRsiHostActivePatch({ patch: oldOwner.patches.targetPatch, rebase })
    if (oldOwner.patches.coordinatorPatch.includes(oldHostRoot)) fail('coordinator patch has unmapped old Host path')
    const coordinatorPatch = oldOwner.patches.coordinatorPatch
    const trustPath = oldManifest.controlPlane.trustPath
    const wrapperPath = oldManifest.serviceEnvironment?.target?.DSH_SYSTEMD_HOST_ATTESTOR_CONFIG
    const resolverPath = join(installation.configRoot, 'host-authority.json')
    if (!inside(installation.configRoot, trustPath) || !inside(installation.configRoot, wrapperPath)
      || !oldOwner.sources[trustPath] || !oldOwner.sources[wrapperPath] || !oldOwner.sources[resolverPath]) fail('Host authority files are not pinned')
    const oldTrust = JSON.parse(oldOwner.sources[trustPath]), oldHost = JSON.parse(oldOwner.sources[resolverPath])
    const oldWrapper = JSON.parse(oldOwner.sources[wrapperPath])
    if (oldWrapper.schemaVersion !== 4 || !['dsh-systemd-host-attestor-7', 'dsh-systemd-host-attestor-8'].includes(oldTrust.hostAttestor?.version)
      || oldWrapper.resolver.configSha256 !== hash(oldOwner.sources[resolverPath])
      || JSON.stringify(oldWrapper.template) !== JSON.stringify(oldHost.template)) fail('standing Host authority differs')
    const newValues = {}
    for (const [path, source] of Object.entries(oldOwner.sources)) {
      if (!source.trimStart().startsWith('{') || path.endsWith('.pem')) { newValues[path] = source; continue }
      const value = JSON.parse(source)
      if (path === resolverPath || path === wrapperPath) {
        if (JSON.stringify(value.template?.unitProperties) !== JSON.stringify(oldHost.template.unitProperties)) fail('standing Host unit properties changed')
        value.template.unitProperties = transition.unitProperties
      }
      newValues[path] = newModules.hostUpdate.rebaseRsiHostValue(value, rebase)
    }
    newValues[installation.manifestPath] = manifest
    const newTrust = newValues[trustPath], newHost = newValues[resolverPath], newWrapper = newValues[wrapperPath]
    newTrust.hostAttestor.version = 'dsh-systemd-host-attestor-8'
    newHost.template.unitProperties = transition.unitProperties
    for (const key of ['readiness', 'recoveryReadiness']) newHost.template[key].observer = manifest.controlPlane.runtimeObserver
    // Standing grants keep schema 4; the resolver selects flat epoch schema 5/6.
    newWrapper.schemaVersion = 4
    newWrapper.template = structuredClone(newHost.template)
    newWrapper.resolver.configSha256 = hash(json(newHost))
    const newFiles = Object.fromEntries(Object.entries(newValues).map(([path, value]) => [path, typeof value === 'string' ? value : json(value)]))
    const newDigests = Object.fromEntries(Object.entries(newFiles).map(([path, source]) => [path, hash(source)]))
    const newPatches = { targetPatch, coordinatorPatch }
    const currentDeployment = await watchedPlans(installation, homePath, stageHome, newModules)
    {
      const oldDatabasePath = physical(homePath, homePath, installation.ledgerPath)
      await sqliteFiles(oldDatabasePath)
      const originalDb = new DatabaseSync(oldDatabasePath, { readOnly: true })
      try {
        const context = oldModules.store.readHostMaintenanceContext(originalDb, currentDeployment[0].id)
        await verifyOriginalSnapshot(originalSnapshot(context, oldHost.template.unitProperties), homePath,
          installation.targetProfile, currentDeployment[0].backup)
      } finally { originalDb.close() }
    }
    const backupPatches = {}
    for (const watched of currentDeployment) if (watched.backup) {
      const path = join(homePath, 'profiles', watched.backup, 'cordis.patch.yml')
      const original = await boundSourceAt(homePath, homePath, path, 2_097_152)
      if (await boundSourceAt(homePath, stageHome, path, 2_097_152) !== original) fail('copied rollback patch differs')
      backupPatches[watched.backup] = newModules.hostUpdate.rebaseRsiHostActivePatch({ patch: original, rebase })
    }
    for (const [path, source] of Object.entries(newFiles)) await writeFile(physical(homePath, stageHome, path), source, { mode: 0o600 })
    await writeFile(physical(homePath, stageHome, join(homePath, 'profiles', installation.targetProfile, 'cordis.patch.yml')), newPatches.targetPatch, { mode: 0o600 })
    await writeFile(physical(homePath, stageHome, join(homePath, 'profiles', installation.coordinatorProfile, 'cordis.patch.yml')), newPatches.coordinatorPatch, { mode: 0o600 })
    for (const [backup, source] of Object.entries(backupPatches)) await writeFile(
      physical(homePath, stageHome, join(homePath, 'profiles', backup, 'cordis.patch.yml')), source, { mode: 0o600 })
    const controlled = [resolverPath, ...Object.keys(newValues).filter(path => path.endsWith('.json') && ![resolverPath, trustPath, installation.manifestPath, wrapperPath].includes(path))]
    const normalizedOldTrust = await oldModules.trust.loadTrustConfig(trustPath)
    const normalizedNewTrust = newModules.hostUpdate.rebaseRsiHostValue(normalizedOldTrust, rebase)
    normalizedNewTrust.hostAttestor.version = 'dsh-systemd-host-attestor-8'
    const oldTrustDigest = oldModules.store.controlPlaneDigest(normalizedOldTrust)
    const newTrustDigest = newModules.store.controlPlaneDigest(normalizedNewTrust)
    for (const path of controlled) {
      const before = JSON.parse(oldOwner.sources[path]), after = newValues[path]
      if (before?.grant && before?.statePath) await authorityStateCas({ config: after, oldConfig: before,
        oldTrustDigest, newTrustDigest, homePath, stageHome, controlPlaneDigest: newModules.store.controlPlaneDigest })
    }
    const db = newModules.sqlite.openControlPlaneDatabase(physical(homePath, stageHome, installation.ledgerPath))
    const maintenance = []
    try {
      for (const watched of currentDeployment) {
        const context = newModules.store.readHostMaintenanceContext(db, watched.id)
        if (!context.readiness || !context.witness || context.plan.status !== 'activated') fail('watched plan lacks original readiness')
        const before = originalSnapshot(context, oldHost.template.unitProperties)
        const candidate = { profile: installation.targetProfile, unitProperties: transition.unitProperties,
          executor: { id: before.executor.id, version: hostPlan.candidateRuntime.version,
            path: hostPlan.candidateRuntime.dshPath, sha256: hash(await readFile(hostPlan.candidateRuntime.dshPath)) } }
        const after = await repinSnapshot(before, candidate, homePath, stageHome, watched.backup)
        const last = context.records.at(-1)
        const unsigned = { schemaVersion: 1, kind: 'dsh-host-maintenance', transactionId,
          installationId: context.plan.installationId, ledger: context.plan.ledger,
          profile: { name: context.plan.profile, path: context.plan.target.profilePath },
          plan: { id: context.plan.id, digest: context.plan.digest },
          activation: { id: context.plan.activation.id, fence: context.plan.activation.fence },
          predecessor: { operationId: context.readiness.operationId,
            receiptDigest: newModules.maintenance.hostMaintenanceDigest(context.readiness),
            hostGeneration: context.readiness.hostGeneration }, sequence: (last?.sequence ?? 0) + 1,
          previousDigest: last ? newModules.maintenance.hostMaintenanceDigest(last) : null,
          before, after, issuedAt: Math.max(Date.now(), context.readiness.observedAt, last?.issuedAt ?? 0),
          authority: context.readiness.authority, keyId: context.readiness.keyId }
        const hostKey = await sourceAt(homePath, stageHome, installation.resources.identities.host.keyPath, 16_384)
        const record = newModules.maintenance.signHostMaintenanceRecord(unsigned, hostKey)
        newModules.store.appendHostMaintenance(db, record)
        maintenance.push({ planId: context.plan.id, recordDigest: newModules.maintenance.hostMaintenanceDigest(record) })
      }
    } finally { db.close() }
    const profileDigests = Object.fromEntries([[installation.targetProfile, hash(newPatches.targetPatch)],
      [installation.coordinatorProfile, hash(newPatches.coordinatorPatch)],
      ...Object.entries(backupPatches).map(([profile, source]) => [profile, hash(source)])])
    const runtimeReceiptDigest = (await verifyRuntimeReceiptPhysical(homePath, stageHome, installation.targetProfile)).receiptDigest
    const previous = oldOwner.overlay.records
    const hostKey = await sourceAt(homePath, stageHome, installation.resources.identities.host.keyPath, 16_384)
    const overlayRecord = newModules.hostUpdate.signRsiHostUpdateOverlay({
      schemaVersion: 1, kind: 'rsi-host-update-overlay', transactionId, dshHome: homePath,
      targetProfile: installation.targetProfile, installationId: installation.resources.installationId,
      currentPlanId: currentDeployment[0].id, activationId: currentDeployment[0].activationId,
      sequence: previous.length + 1, previousDigest: previous.length
        ? newModules.hostUpdate.rsiHostUpdateOverlayDigest(previous.at(-1)) : null,
      bootstrapDigest: hash(oldOwner.bootstrapSource), files: newDigests, patches: profileDigests,
      runtimeReceiptDigest, planDigest: hash(json({ files: newDigests, patches: profileDigests })),
      result: { ...oldOwner.effective.result, manifestDigest: newDigests[installation.manifestPath] },
      issuedAt: Math.max(Date.now(), previous.at(-1)?.issuedAt ?? 0),
      authority: installation.resources.identities.host.authority, keyId: installation.resources.identities.host.keyId,
    }, hostKey, installation.resources, oldOwner.bootstrapSource, previous)
    await saveJson(homePath, stageHome, oldOwner.overlayPath, { schemaVersion: 1,
      kind: 'rsi-host-update-overlays', records: [...previous, overlayRecord] })
    Object.assign(proof.authorizedPatchDigests, profileDigests)
    proof.installations.push({ targetProfile: installation.targetProfile, coordinatorProfile: installation.coordinatorProfile,
      files: newDigests, patches: profileDigests, bootstrapDigest: hash(oldOwner.bootstrapSource),
      overlayDigest: newModules.hostUpdate.rsiHostUpdateOverlayDigest(overlayRecord), runtimeReceiptDigest,
      maintenance, transactionId })
  }
  return proof
}

/** Re-read the post-swap Home through the transaction's pinned descriptor. */
export async function verifyRsiHostUpdate({ homePath, physicalHome, hostPlan, proof }) {
  if (proof?.schemaVersion !== 1 || proof.hostPlanDigest !== hash(JSON.stringify(hostPlan))
    || !isAbsolute(physicalHome) || resolve(physicalHome) !== physicalHome) fail('RSI update proof binding differs')
  const found = await installations(homePath, physicalHome)
  if (proof.mode === 'empty') {
    if (found.length || proof.installations?.length || Object.keys(proof.authorizedPatchDigests || {}).length) fail('RSI appeared after empty preflight')
    return proof
  }
  if (proof.mode !== 'prepared' || found.length !== proof.installations?.length) fail('RSI installation inventory changed')
  for (const item of proof.installations) {
    const installation = found.find(value => value.targetProfile === item.targetProfile && value.coordinatorProfile === item.coordinatorProfile)
    if (!installation) fail('RSI pair identity changed')
    const modules = await installedMigrationModules(physicalHome, installation.targetProfile)
    const effective = await ownerConfiguration(installation, homePath, physicalHome, modules)
    if (!effective.overlay.latest || modules.hostUpdate.rsiHostUpdateOverlayDigest(effective.overlay.latest) !== item.overlayDigest
      || hash(effective.bootstrapSource) !== item.bootstrapDigest
      || hash(JSON.stringify(effective.effective.files)) !== hash(JSON.stringify(item.files))
      || hash(JSON.stringify(effective.overlay.latest.patches)) !== hash(JSON.stringify(item.patches))) fail('signed owner overlay changed')
    for (const [path, digest] of Object.entries(item.files)) if (hash(await sourceAt(homePath, physicalHome, path, 2_097_152)) !== digest) fail(`migrated config changed: ${path}`)
    for (const [profile, digest] of Object.entries(item.patches)) {
      const source = await boundSourceAt(homePath, physicalHome, join(homePath, 'profiles', profile, 'cordis.patch.yml'), 2_097_152)
      if (hash(source) !== digest || proof.authorizedPatchDigests[profile] !== digest) fail(`migrated patch changed: ${profile}`)
    }
    if (hash(await sourceAt(homePath, physicalHome, join(installation.configRoot, 'bootstrap.json'), 2_097_152)) !== item.bootstrapDigest) fail('bootstrap receipt changed')
    if ((await verifyRuntimeReceiptPhysical(homePath, physicalHome, installation.targetProfile)).receiptDigest !== item.runtimeReceiptDigest) fail('authority runtime changed')
    const databasePath = physical(homePath, physicalHome, installation.ledgerPath)
    await sqliteFiles(databasePath)
    const db = new DatabaseSync(databasePath, { readOnly: true })
    try {
      for (const expected of item.maintenance) {
        const context = modules.store.readHostMaintenanceContext(db, expected.planId)
        const record = context.records.at(-1)
        if (!record || record.transactionId !== item.transactionId
          || modules.maintenance.hostMaintenanceDigest(record) !== expected.recordDigest) fail('maintenance chain changed')
      }
    } finally { db.close() }
  }
  return proof
}
