import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { assertLocalSourceInstaller } from './local-source-maintenance.mjs'

const protocol = 'dsh-enhanced/host-owner-source-repair/v1'
const hash = value => createHash('sha256').update(value).digest('hex')
const json = value => `${JSON.stringify(value, null, 2)}\n`
const same = isDeepStrictEqual
const hex = /^[a-f0-9]{64}$/u
const profileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const fail = message => { throw new Error(`Owner source repair: ${message}`) }
const exact = path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path
  && !path.includes('\0') && !/[\r\n]/u.test(path)
const inside = (root, path) => path === root || path.startsWith(`${root}${sep}`)

async function privateDirectory(path, strict = false) {
  if (!exact(path) || await realpath(path) !== path) fail(`noncanonical directory: ${path}`)
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid()
    || (entry.mode & (strict ? 0o077 : 0o022))) fail(`unsafe private directory: ${path}`)
}

async function stable(path, maximum = 2_097_152, privateMode = true) {
  if (!exact(path) || await realpath(path) !== path) fail(`noncanonical file: ${path}`)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat({ bigint: true })
    const named = await lstat(path, { bigint: true })
    if (!before.isFile() || privateMode && before.nlink !== 1n
      || before.uid !== BigInt(process.getuid())
      || before.size < 1n || before.size > BigInt(maximum)
      || (before.mode & BigInt(privateMode ? 0o077 : 0o022)) !== 0n
      || before.dev !== named.dev || before.ino !== named.ino) fail(`unsafe file: ${path}`)
    const bytes = await file.readFile()
    const after = await file.stat({ bigint: true })
    if (BigInt(bytes.length) !== before.size || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      fail(`file changed: ${path}`)
    }
    return bytes
  } finally { await file.close() }
}

async function optional(path, maximum, privateMode = true) {
  try { return (await stable(path, maximum, privateMode)).toString('utf8') }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error
    try { await lstat(path) } catch (linked) { if (linked?.code === 'ENOENT') return null; throw linked }
    fail(`dangling file: ${path}`)
  }
}

function parsed(source, label) {
  let value
  try { value = JSON.parse(source) } catch { fail(`invalid ${label}`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`invalid ${label}`)
  return value
}

async function load(installer) {
  await assertLocalSourceInstaller(installer)
  const root = join(installer.root, 'plugins', 'lark-channel', 'lib')
  const names = ['rsi-authority-resources', 'rsi-authority-runtime', 'rsi-source-maintenance',
    'rsi-bootstrap-manifest', 'rsi-authority-config', 'rsi-profile', 'rsi-creation-build',
    'rsi-host-update', 'rsi-build', 'rsi-release-build', 'rsi-setup', 'rsi-service-environment',
    'systemd', 'rsi-owner-profile', 'rsi-source', 'rsi-install', 'rsi-local-cohort',
    'rsi-install-inputs']
  const api = Object.assign({}, ...await Promise.all(names.map(name => import(pathToFileURL(join(root, `${name}.js`)).href))))
  const require = createRequire(join(installer.root, 'package.json'))
  const larkRequire = createRequire(join(installer.root, 'plugins', 'lark-channel', 'package.json'))
  const controlPath = await realpath(larkRequire.resolve('@dsh-enhanced/plugin-control-plane'))
  if (!inside(installer.root, controlPath)) fail('Control Plane implementation escapes installer')
  if (!inside(installer.root, await realpath(require.resolve('yaml/package.json')))) {
    fail('YAML parser escapes reviewed installer')
  }
  return { ...api, control: await import(pathToFileURL(controlPath).href), yaml: require('yaml') }
}

async function hostBoot(dshPath, homePath) {
  if (!exact(dshPath) || await realpath(dshPath) !== dshPath || inside(homePath, dshPath)) fail('DSH Host path is untrusted')
  const require = createRequire(dshPath)
  let manifestPath
  try { manifestPath = await realpath(require.resolve('@deepseek-ai/dsh/package.json')) } catch {
    for (let directory = dirname(dshPath);;) {
      const candidate = join(directory, 'package.json')
      try {
        if (parsed(await readFile(candidate, 'utf8'), 'DSH Host package').name === '@deepseek-ai/dsh') {
          manifestPath = await realpath(candidate); break
        }
      } catch {}
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  if (!manifestPath || inside(homePath, manifestPath)) fail('DSH Host manifest is absent')
  const manifest = parsed((await stable(manifestPath, 65_536, false)).toString('utf8'), 'DSH Host package')
  if (manifest.name !== '@deepseek-ai/dsh' || typeof manifest.bin?.dsh !== 'string'
    || await realpath(join(dirname(manifestPath), manifest.bin.dsh)) !== dshPath) fail('DSH Host executable differs')
  const hostRequire = createRequire(manifestPath)
  const bootPath = await realpath(hostRequire.resolve('@deepseek-ai/dsh-app-boot'))
  const bootManifestPath = await realpath(hostRequire.resolve('@deepseek-ai/dsh-app-boot/package.json'))
  const bootManifest = parsed((await stable(bootManifestPath, 65_536, false)).toString('utf8'), 'DSH boot package')
  if (!inside(dirname(bootManifestPath), bootPath) || inside(homePath, bootPath)
    || bootManifest.name !== '@deepseek-ai/dsh-app-boot' || bootManifest.version !== manifest.version) {
    fail('DSH native boot differs from selected Host')
  }
  const boot = await import(pathToFileURL(bootPath).href)
  if (typeof boot.loadProfileDirectory !== 'function' || typeof boot.loadOptionalPatches !== 'function'
    || typeof boot.renderConfigDump !== 'function' || typeof boot.createRuntimeResolution !== 'function'
    || typeof boot.PluginPackages !== 'function') fail('DSH Host has no read-only composer')
  const installRoot = dirname(dirname(dirname(manifestPath)))
  if (dirname(installRoot) === installRoot || !inside(installRoot, manifestPath)) fail('DSH Host installation root differs')
  const bootRequire = createRequire(bootPath)
  const cordisManifestPath = await realpath(bootRequire.resolve('@deepseek-ai/cordis/package.json'))
  const cordisPath = await realpath(bootRequire.resolve('@deepseek-ai/cordis'))
  if (!inside(installRoot, cordisManifestPath) || !inside(dirname(cordisManifestPath), cordisPath)
    || parsed((await stable(cordisManifestPath, 65_536, false)).toString('utf8'), 'DSH Cordis package').name
      !== '@deepseek-ai/cordis') fail('DSH native Cordis escapes selected Host')
  const includeManifestPath = await realpath(bootRequire.resolve('@deepseek-ai/cordis-plugin-include/package.json'))
  const includePath = await realpath(bootRequire.resolve('@deepseek-ai/cordis-plugin-include'))
  if (!inside(installRoot, includeManifestPath) || !inside(dirname(includeManifestPath), includePath)
    || parsed((await stable(includeManifestPath, 65_536, false)).toString('utf8'), 'DSH Include package').name
      !== '@deepseek-ai/cordis-plugin-include') fail('DSH native Include escapes selected Host')
  const includeRequire = createRequire(includePath)
  const yamlPath = await realpath(includeRequire.resolve('js-yaml'))
  if (!inside(installRoot, yamlPath)) fail('DSH native YAML parser escapes selected Host')
  const include = await import(pathToFileURL(includePath).href)
  if (!include.entryListSchema) fail('DSH native Include has no entry-list schema')
  const cordis = await import(pathToFileURL(cordisPath).href)
  if (typeof cordis.Context !== 'function') fail('DSH native Cordis Context is missing')
  return { boot, yaml: includeRequire('js-yaml'), entryListSchema: include.entryListSchema,
    Context: cordis.Context, cordisPackageRoot: dirname(cordisManifestPath),
    manifestPath, version: manifest.version,
    dshDigest: hash(await stable(dshPath, 268_435_456, false)) }
}

function originalPatchList(host, source, patchPath) {
  const parsed = host.yaml.load(source, { schema: host.entryListSchema })
  if (!Array.isArray(parsed) || parsed.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
    fail('original profile patch is not a native patch list')
  }
  const base = dirname(patchPath)
  const anchor = entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('invalid original inserted entry')
    if (typeof entry.name === 'string' && (isAbsolute(entry.name)
      || entry.name.startsWith('./') || entry.name.startsWith('../'))) {
      entry.name = pathToFileURL(resolve(base, entry.name)).href
    }
    if (entry.group && Array.isArray(entry.config)) entry.config.forEach(anchor)
  }
  for (const patch of parsed) patch.insert?.forEach(anchor)
  return parsed
}

export async function composeOwnerRepairProfiles({ homePath, physicalHome = homePath, profile,
  coordinatorProfile, dshPath, patchOverrides }) {
  await privateDirectory(physicalHome)
  if (!exact(homePath) || !profileName.test(profile) || !profileName.test(coordinatorProfile)
    || profile === coordinatorProfile) fail('invalid profile composition input')
  const host = await hostBoot(dshPath, homePath)
  if (patchOverrides && (!same(Object.keys(patchOverrides).sort(), [profile, coordinatorProfile].sort())
    || Object.values(patchOverrides).some(source => typeof source !== 'string'))) {
    fail('invalid original profile patch overrides')
  }
  const homePatch = host.boot.loadOptionalPatches('dsh', join(physicalHome, 'cordis.patch.yml'))
  const effective = {}
  for (const name of [profile, coordinatorProfile]) {
    const loaded = host.boot.loadProfileDirectory('dsh', join(physicalHome, 'profiles', name),
      host.manifestPath, patchOverrides ? { userLayer: false } : {})
    if (loaded.skippedBundles.length) fail(`unresolved native bundles: ${name}`)
    const layers = loaded.layers.map(layer => ({ label: layer.packageName, patches: layer.patches }))
    layers.push({ label: loaded.patchPath, patches: patchOverrides
      ? originalPatchList(host, patchOverrides[name], join(homePath, 'profiles', name, 'cordis.patch.yml'))
      : loaded.patches })
    if (homePatch) layers.push({ label: join(physicalHome, 'cordis.patch.yml'), patches: homePatch })
    effective[name] = host.boot.renderConfigDump('dsh', join(loaded.dir, 'cordis.yml'), layers)
  }
  return { targetEffective: effective[profile], coordinatorEffective: effective[coordinatorProfile],
    dshDigest: host.dshDigest, dshVersion: host.version }
}

function assertJournal(journal, manifest, manifestDigest) {
  const pair = [manifest.targetProfile, manifest.coordinatorProfile]
  if (journal.schemaVersion !== 2 || journal.stage !== 'applied' || journal.manifestDigest !== manifestDigest) fail('owner setup journal is not applied to this manifest')
  for (const key of ['entries', 'environments', 'units']) {
    if (!Array.isArray(journal[key]) || journal[key].length !== 2
      || journal[key].some((item, index) => item?.profile !== pair[index]
        || item.before !== null && typeof item.before !== 'string'
        || item.after !== null && typeof item.after !== 'string')) fail(`owner setup ${key} differs`)
  }
  if (journal.entries.some(item => typeof item.before !== 'string' || typeof item.after !== 'string')) fail('owner setup patch entries differ')
}

function originalInputs(original) {
  const { resources, runtime, source, releaseBuild, manifest, files } = original
  const host = parsed(files[join(resources.configRoot, 'host-authority.json')], 'Host authority')
  const release = parsed(files[join(resources.configRoot, 'release.json')], 'release authority')
  const trust = parsed(files[join(resources.configRoot, 'trust.json')], 'owner trust')
  if (!Number.isSafeInteger(host.grant?.notBefore) || host.grant.notBefore < 1
    || host.grant.expiresAt !== manifest.sourceReviews.expiresAt
    || !same(host.grant.owner, manifest.sourceReviews.owner)
    || !same(host.template?.unitProperties, original.unitProperties)
    || !same(trust.executor, original.executor)) fail('frozen Host grant differs')
  if (!Array.isArray(release.grant?.policies) || !same(release.grant.policies, original.policies)) fail('frozen release policies differ')
  return { resources, runtime: runtime.runtime, source: source.workspace, releaseBuild: releaseBuild.releaseBuild,
    executor: trust.executor, systemctl: host.template.systemctl, unitProperties: host.template.unitProperties,
    policies: release.grant.policies, now: host.grant.notBefore }
}

function compiledFiles(api, original) {
  const compiled = api.compileRsiAuthorityConfigs({ manifest: original.manifest, ...originalInputs(original) })
  const files = { ...compiled.files, [join(original.resources.configRoot, 'manifest.json')]: json(original.manifest) }
  if (!same(Object.keys(files).sort(), Object.keys(original.receipt.files).sort())) fail('old owner config inventory cannot be reproduced')
  for (const [path, source] of Object.entries(files)) {
    if (source !== original.files[path] || hash(source) !== original.receipt.files[path]) fail('old owner config cannot be reproduced')
  }
  return compiled
}

async function originalCompiledPlan(api, { homePath, profile, coordinatorProfile, source,
  resources, runtime, files, dshPath, dshEnvironment, manifest, journal, receipt, owner }) {
  const cohort = await api.readRsiLocalCohort({ dshHome: homePath, profile, source: source.workspace })
  const profilePath = join(homePath, 'profiles', profile)
  await api.verifyRsiLocalInstalledPackagesFresh({ cohort, profilePath, bundles: ['lark-channel'] })
  const profileRequire = createRequire(join(profilePath, 'package.json'))
  const packageManifestPath = await realpath(profileRequire.resolve('@dsh-enhanced/lark-channel/package.json'))
  const packageRoot = dirname(packageManifestPath)
  if (!inside(profilePath, packageRoot)) fail('original profile compiler escapes verified cohort')
  const compilerPath = join(packageRoot, 'lib', 'rsi-profile.js')
  const compilerDigest = hash(await stable(compilerPath, 2_097_152, false))
  const host = await hostBoot(dshPath, homePath)
  const loaded = host.boot.loadProfileDirectory('dsh', profilePath, host.manifestPath)
  if (loaded.skippedBundles.length) fail('original compiler profile has unresolved bundles')
  const resolution = await host.boot.createRuntimeResolution({ installAnchor: host.manifestPath,
    profile: loaded, home: homePath })
  const larkName = '@dsh-enhanced/lark-channel'
  const direct = resolution.localPackageNames.includes(larkName)
  const installedLark = resolution.entries.find(item => item.name === larkName && item.scope === 'profile')
  const larkLayer = loaded.layers.find(item => item.packageName === larkName)
  const installedCordis = resolution.entries.find(item => item.name === '@deepseek-ai/cordis'
    && item.scope === 'installation')
  if (!larkLayer || await realpath(larkLayer.packageDir) !== packageRoot
    || direct && await realpath(join(profilePath, 'node_modules', larkName)) !== packageRoot
    || !direct && (!installedLark || await realpath(installedLark.packageDir) !== packageRoot)
    || !installedCordis || await realpath(installedCordis.packageDir) !== host.cordisPackageRoot) {
    fail('original compiler differs from native Host resolution')
  }
  const beforePatches = { [profile]: journal.entries[0].before,
    [coordinatorProfile]: journal.entries[1].before }
  const originalEffective = await composeOwnerRepairProfiles({ homePath, profile,
    coordinatorProfile, dshPath, patchOverrides: beforePatches })
  const selectedDsh = await api.resolveInstalledRsiDsh(dshEnvironment)
  if (selectedDsh.path !== dshPath || selectedDsh.pin.sha256 !== originalEffective.dshDigest) {
    fail('original installed base selects a different DSH Host')
  }
  const coordinatorBase = await api.readRsiInstalledBase(coordinatorProfile, homePath, dshEnvironment)
  const context = new host.Context()
  const fiber = context.plugin(host.boot.PluginPackages, { resolution })
  let patches
  try {
    await fiber.await()
    const installed = await import(pathToFileURL(compilerPath).href)
    const originalFactory = await import(pathToFileURL(join(packageRoot, 'lib', 'rsi-bootstrap-manifest.js')).href)
    if (typeof installed.compileRsiProfiles !== 'function'
      || typeof originalFactory.createRsiBootstrapManifest !== 'function'
      || typeof originalFactory.rawLoaderConfig !== 'function') fail('original owner compiler is missing')
    const build = await api.readRsiBuildEnvironment({ dshHome: homePath, profile, source: source.workspace })
    const creationBuild = await api.readRsiCreationBuildEnvironment({ dshHome: homePath,
      profile, source: source.workspace, build })
    const hostAuthority = parsed(files[join(resources.configRoot, 'host-authority.json')], 'original Host grant')
    const observerIds = new Set(['dsh-enhanced-assistant-growth-driver', 'dsh-enhanced-assistant-verifier',
      'dsh-enhanced-personal-assistant', 'dsh-enhanced-assistant-memory-learning'])
    const originalRows = yamlRows(api, originalEffective.targetEffective, 'pre-owner target effective').contents.items
    const observerTargets = manifest.controlPlane.runtimeObserver.targets.filter(item => !observerIds.has(item.entryId))
      .map(item => {
        const row = originalRows.find(row => api.yaml.isMap(row) && row.get('id') === item.entryId)
        if (!row) fail('pre-owner observer row is missing')
        return { ...item, configDigest: api.control.runtimeConfigDigest(
          originalFactory.rawLoaderConfig(row.get('config', true), item.entryId)) }
      })
    const inMemory = originalFactory.createRsiBootstrapManifest({ dshHome: homePath,
      targetProfile: profile, coordinatorProfile, targetEffective: originalEffective.targetEffective,
      owner, resources, runtime: runtime.runtime, source: source.workspace,
      sourceBuild: build.sourceBuild, creationBuild, git: manifest.sourceReviews.git,
      now: hostAuthority.grant.notBefore, expiresAt: manifest.sourceReviews.expiresAt,
      plugins: manifest.sourceReviews.plugins, observerTargets,
      hostDeploymentInputs: manifest.controlPlane.sourceAdoptions.hostDeploymentInputs })
    if (json(inMemory) !== json(manifest)) fail('original in-memory owner manifest differs')
    const compilerInput = { manifest: inMemory, dshHome: homePath,
      targetPatch: beforePatches[profile], coordinatorPatch: beforePatches[coordinatorProfile],
      targetEffective: originalEffective.targetEffective,
      coordinatorEffective: originalEffective.coordinatorEffective, coordinatorBase, owner }
    patches = await installed.compileRsiProfiles(compilerInput)
  } finally { await fiber.dispose() }
  const actualPlanDigest = hash(json({ files: receipt.files, patches }))
  if (receipt.planDigest !== actualPlanDigest
    || !ownerRepairPatchEquivalent({ yaml: api.yaml, planned: patches.targetPatch,
      applied: journal.entries[0].after })
    || !ownerRepairPatchEquivalent({ yaml: api.yaml, planned: patches.coordinatorPatch,
      applied: journal.entries[1].after })) {
    fail('original compiled owner plan differs from applied journal')
  }
  return { compilerPath, compilerDigest, cohortDigest: cohort.receiptDigest }
}

export async function assertIssuerStateAbsent({ resources, files, homePath, physicalHome }) {
  const names = ['approval', 'release', 'adoption', 'observation', 'qualification', 'host-authority']
  const stateRoot = resources.stateRoot
  const physicalRoot = join(physicalHome, relative(homePath, stateRoot))
  await privateDirectory(physicalRoot, true)
  const paths = new Set()
  for (const name of names) {
    const config = parsed(files[join(resources.configRoot, `${name}.json`)], `${name} authority`)
    const statePath = config.statePath
    if (!exact(statePath) || !inside(stateRoot, statePath) || statePath === stateRoot
      || paths.has(statePath)) fail(`invalid ${name} issuer state path`)
    paths.add(statePath)
    const physicalPath = join(physicalRoot, relative(stateRoot, statePath))
    if (await realpath(dirname(physicalPath)) !== dirname(physicalPath)) {
      fail(`noncanonical ${name} issuer state directory`)
    }
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      if (await optional(`${physicalPath}${suffix}`, 2_097_152) !== null) {
        fail('an issuer grant state was used; first repair is unavailable')
      }
    }
  }
}

function manifestInputs(original, targetEffective, creationBuild, source, runtime, sourceBuild) {
  const immutable = new Set(['dsh-enhanced-assistant-growth-driver', 'dsh-enhanced-assistant-verifier',
    'dsh-enhanced-personal-assistant', 'dsh-enhanced-assistant-memory-learning'])
  return { dshHome: original.resources.root.slice(0, -`/rsi-authorities/${original.manifest.targetProfile}`.length),
    targetProfile: original.manifest.targetProfile, coordinatorProfile: original.manifest.coordinatorProfile,
    targetEffective, owner: original.owner, resources: original.resources, runtime, source,
    sourceBuild, creationBuild, git: original.manifest.sourceReviews.git,
    now: original.now, expiresAt: original.manifest.sourceReviews.expiresAt,
    plugins: original.manifest.sourceReviews.plugins,
    observerTargets: original.manifest.controlPlane.runtimeObserver.targets.filter(item => !immutable.has(item.entryId)),
    hostDeploymentInputs: original.manifest.controlPlane.sourceAdoptions.hostDeploymentInputs }
}

export async function ownerLedger(api, path, repository, homePath, expectedRecords) {
  const ledger = new api.control.ControlPlaneStore({ path, readOnly: true })
  try {
    const state = ledger.readSourceMaintenanceState(repository)
    if (ledger.readSourceMaintenanceActivationState(homePath).kind !== 'none'
      || !same(state.records, expectedRecords)) fail('owner ledger has activation or source history drift')
    return state
  } finally { ledger.close() }
}

function yamlRows(api, source, label) {
  const document = api.yaml.parseDocument(source, { uniqueKeys: true })
  if (document.errors.length || !api.yaml.isSeq(document.contents)) fail(`invalid ${label} YAML`)
  return document
}

function yamlValue(api, node, document, ancestors = new Set()) {
  if (api.yaml.isAlias(node)) {
    if (!document) fail('unresolved owner YAML alias')
    const resolved = node.resolve(document)
    if (!resolved || ancestors.has(resolved)) fail('cyclic or unresolved owner YAML alias')
    const nextAncestors = new Set(ancestors).add(resolved)
    return yamlValue(api, resolved, document, nextAncestors)
  }
  if (api.yaml.isScalar(node)) return ['scalar', node.tag ?? null, node.value]
  if (api.yaml.isSeq(node)) return ['sequence', node.tag ?? null,
    node.items.map(item => yamlValue(api, item, document, ancestors))]
  if (api.yaml.isMap(node)) return ['map', node.tag ?? null, node.items.map(item =>
    [yamlValue(api, item.key, document, ancestors), yamlValue(api, item.value, document, ancestors)])
    .sort((left, right) => JSON.stringify(left[0]).localeCompare(JSON.stringify(right[0])))]
  return node
}

function yamlDocumentValue(api, source, label) {
  const document = yamlRows(api, source, label)
  return yamlValue(api, document.contents, document)
}

export function ownerRepairPatchEquivalent({ yaml, planned, applied }) {
  const api = { yaml }
  return same(yamlDocumentValue(api, planned, 'original planned patch'),
    yamlDocumentValue(api, applied, 'applied patch'))
}

function assertNonOwnerRows(api, originalEffective, stagedEffective) {
  const original = yamlRows(api, originalEffective, 'original target effective')
  const staged = yamlRows(api, stagedEffective, 'staged target effective')
  const first = new Map(), second = new Map()
  for (const [rows, result] of [[original.contents.items, first], [staged.contents.items, second]]) {
    for (const row of rows) {
      const id = api.yaml.isMap(row) ? row.get('id') : undefined
      if (typeof id !== 'string' || result.has(id)) fail('target effective row identity changed')
      result.set(id, row)
    }
  }
  if (!same([...first.keys()], [...second.keys()])) fail('target effective row inventory changed')
  const ownerRows = new Set(['dsh-enhanced-personal-assistant', 'dsh-enhanced-assistant-delivery',
    'dsh-enhanced-assistant-verifier', 'dsh-enhanced-assistant-growth-driver',
    'dsh-enhanced-assistant-memory-learning', 'dsh-enhanced-plugin-control-plane'])
  for (const [id, row] of first) {
    if (ownerRows.has(id)) continue
    if (!same(yamlValue(api, row, original), yamlValue(api, second.get(id), staged))) {
      fail(`non-owner effective row changed: ${id}`)
    }
  }
}

function permissionSelection(api, source, preset, label) {
  const document = yamlRows(api, source, label)
  const rows = document.contents.items.filter(item => api.yaml.isMap(item) && item.get('id') === 'permission')
  if (rows.length !== 1 || rows[0].get('name') !== '@deepseek-ai/dsh-permission-presets'
    || !api.yaml.isMap(rows[0].get('config', true))) fail('installed permission row differs')
  const config = rows[0].get('config', true)
  if (config.get('defaultPreset') !== 'auto') fail('permission default is not the original unsupported auto preset')
  const presets = config.get('presets', true)
  if (api.yaml.isMap(presets) && !presets.has(preset)) fail('selected permission preset is not configured')
  config.set('defaultPreset', document.createNode(preset))
  return { document, row: rows[0], source: String(document) }
}

function patchPermission(api, patch, selected) {
  const document = yamlRows(api, patch, 'target patch')
  const rows = document.contents.items.filter(item => api.yaml.isMap(item) && item.get('id') === 'permission')
  if (rows.length > 1) fail('permission patch is ambiguous')
  const entry = rows[0] ?? document.createNode({ id: 'permission' })
  if (!rows.length) document.contents.add(entry)
  entry.set('config', selected.row.get('config', true).clone())
  return String(document)
}

export function selectOwnerRepairPermission({ targetEffective, targetPatch, permissionPreset, yaml }) {
  if (!['workspace-write', 'danger-full-access'].includes(permissionPreset)
    || typeof targetEffective !== 'string' || typeof targetPatch !== 'string'
    || !yaml?.parseDocument) fail('invalid explicit permission selection')
  const selected = permissionSelection({ yaml }, targetEffective, permissionPreset, 'target effective')
  return { targetEffective: selected.source, targetPatch: patchPermission({ yaml }, targetPatch, selected) }
}

async function atomicReplace(path, source) {
  const temporary = `${path}.owner-repair-${randomUUID()}`
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(source); await handle.sync() } finally { await handle.close() }
  try { await rename(temporary, path) } finally { await rm(temporary, { force: true }) }
}

async function exclusive(path, source) {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(source); await handle.sync() } finally { await handle.close() }
}

async function auditOriginal(stageHome, ownerRepair, transactionId) {
  if (!/^[a-f0-9-]{36}$/u.test(transactionId)) fail('invalid owner repair transaction id')
  const directory = join(stageHome, 'rsi-authorities', ownerRepair.profile, 'state', 'owner-repair-audit')
  try { await mkdir(directory, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  await privateDirectory(directory, true)
  const path = join(directory, `${transactionId}.json`)
  const { original } = ownerRepair
  const content = json({ schemaVersion: 1, transactionId, homePath: ownerRepair.homePath,
    files: original.files, bootstrapReceipt: original.receiptSource,
    journal: original.journalSource, creationReceipt: original.creationSource,
    patches: original.patches, environments: original.environments, units: original.units,
    runtimeReceiptDigest: original.runtimeReceiptDigest })
  const current = await optional(path, 4_194_304)
  if (current === null) await exclusive(path, content)
  else if (current !== content) fail('owner repair audit differs on retry')
  return { path: join(ownerRepair.homePath, relative(stageHome, path)), digest: hash(content) }
}

export async function stageOwnerSourceRepair({ ownerRepair, homePath, stageHome, record, resources, runtime,
  source, sourceBuild, releaseBuild, candidateCreation, stageNativeEffective, coordinatorBase,
  unitProperties, installer = ownerRepair?.installer, transactionId }) {
  if (ownerRepair?.protocol !== protocol || ownerRepair.homePath !== homePath
    || !exact(stageHome) || stageHome === homePath || !same(resources, ownerRepair.original.resources)
    || !same(installer, ownerRepair.installer)
    || !same(unitProperties, ownerRepair.original.unitProperties)
    || !stageNativeEffective || typeof stageNativeEffective.targetEffective !== 'string'
    || typeof stageNativeEffective.coordinatorEffective !== 'string'
    || typeof coordinatorBase !== 'string' || !candidateCreation
    || candidateCreation.creationBuild?.sourceCommit !== source?.sourceCommit
    || sourceBuild?.sourceCommit !== source?.sourceCommit
    || releaseBuild?.sourceCommit !== source?.sourceCommit) fail('owner repair stage inputs differ')
  const api = await load(installer)
  const original = ownerRepair.original
  await privateDirectory(stageHome)
  const host = await hostBoot(ownerRepair.dshPath, homePath)
  if (host.dshDigest !== ownerRepair.host.dshDigest || host.version !== ownerRepair.host.version) {
    fail('selected DSH Host changed since repair capture')
  }
  await verifyOwnerSourceRepair({ ownerRepair, homePath, physicalHome: stageHome,
    installer, phase: 'before-finalize', record })
  compiledFiles(api, original)
  assertNonOwnerRows(api, original.effective.targetEffective, stageNativeEffective.targetEffective)
  const ownerSnapshot = await api.rsiSetupPorts.snapshot(stageNativeEffective.targetEffective, homePath)
  if (!same(ownerSnapshot, original.ownerSnapshot)) fail('owner binding changed before repair')
  const selected = selectOwnerRepairPermission({ targetEffective: stageNativeEffective.targetEffective,
    targetPatch: original.patches[ownerRepair.profile], permissionPreset: ownerRepair.permissionPreset,
    yaml: api.yaml })
  const stageRuntime = await api.readRsiAuthorityRuntimeReceipt({ logicalHome: homePath,
    physicalHome: stageHome, profile: ownerRepair.profile })
  if (!same(stageRuntime.runtime, runtime)) fail('new staged authority runtime differs')
  const sourceState = await api.readRsiSourceMaintenance({ logicalHome: homePath,
    physicalHome: stageHome, profile: ownerRepair.profile })
  if (!same(sourceState.workspace, source) || !same(sourceState.records,
    [...original.source.records, record])) fail('new staged source differs')
  const build = sourceBuild.sourceBuild ? sourceBuild : { schemaVersion: 1,
    sourceCommit: source.sourceCommit, sourceBuild }
  const release = releaseBuild.releaseBuild ? releaseBuild.releaseBuild : releaseBuild
  const creation = await api.materializeRsiCreationBuildInStage({ candidateHome: candidateCreation.candidateHome,
    stagePhysicalHome: stageHome, logicalHome: homePath, profile: ownerRepair.profile,
    candidateSource: candidateCreation.candidateSource, candidateBuild: candidateCreation.candidateBuild,
    stagedSource: source, stagedBuild: build })
  if (creation.candidateReceiptSha256 !== candidateCreation.receiptSha256
    || !same(creation.creationBuild, candidateCreation.creationBuild)) fail('new creation receipt differs from candidate')
  const manifest = api.createRsiBootstrapManifest(manifestInputs(original, selected.targetEffective,
    creation.creationBuild, source, runtime, build.sourceBuild))
  if (manifest.sourceReviews.expiresAt !== original.manifest.sourceReviews.expiresAt
    || !same(manifest.serviceEnvironment, original.manifest.serviceEnvironment)
    || !same(manifest.sourceReviews.owner, original.manifest.sourceReviews.owner)
    || !same(manifest.growthDriver.provider, original.manifest.growthDriver.provider)
    || !same(manifest.growthDriver.model, original.manifest.growthDriver.model)
    || !same(manifest.growthDriver.reasoningEffort, original.manifest.growthDriver.reasoningEffort)) {
    fail('owner identity, finite grant, or model selection changed')
  }
  const compiled = api.compileRsiAuthorityConfigs({ manifest, resources, runtime, source,
    releaseBuild: release, executor: original.executor, systemctl: originalInputs(original).systemctl,
    unitProperties, policies: original.policies, now: original.now })
  const manifestPath = join(resources.configRoot, 'manifest.json')
  const files = { ...compiled.files, [manifestPath]: json(manifest) }
  if (!same(Object.keys(files).sort(), Object.keys(original.receipt.files).sort())) fail('new grant file inventory changed')
  const patches = await api.compileRsiProfiles({ manifest, dshHome: homePath,
    targetPatch: selected.targetPatch, targetEffective: selected.targetEffective,
    coordinatorPatch: original.patches[ownerRepair.coordinatorProfile],
    coordinatorEffective: stageNativeEffective.coordinatorEffective, coordinatorBase,
    owner: original.owner })
  const patchMap = { [ownerRepair.profile]: patches.targetPatch,
    [ownerRepair.coordinatorProfile]: patches.coordinatorPatch }
  const journal = structuredClone(original.journal)
  journal.manifestDigest = hash(files[manifestPath])
  journal.entries[0].after = patches.targetPatch
  journal.entries[1].after = patches.coordinatorPatch
  const journalSource = JSON.stringify(journal)
  const audit = await auditOriginal(stageHome, ownerRepair, transactionId)
  for (const [path, value] of Object.entries(files)) {
    const physical = join(stageHome, relative(homePath, path))
    if (!inside(join(stageHome, 'rsi-authorities', ownerRepair.profile, 'config'), physical)) fail('generated owner config escaped stage')
    await atomicReplace(physical, value)
  }
  for (const [profile, value] of Object.entries(patchMap)) {
    await atomicReplace(join(stageHome, 'profiles', profile, 'cordis.patch.yml'), value)
  }
  await atomicReplace(join(stageHome, '.rsi-setup-journal.json'), journalSource)
  const fileDigests = Object.fromEntries(Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right)).map(([path, value]) => [path, hash(value)]))
  const patchDigests = Object.fromEntries(Object.entries(patchMap).map(([profile, value]) => [profile, hash(value)]))
  const overlay = api.signRsiOwnerRepairOverlay({ schemaVersion: 1, kind: 'rsi-owner-repair-overlay',
    transactionId, dshHome: homePath, targetProfile: ownerRepair.profile,
    installationId: resources.installationId, sequence: 1, previousDigest: null,
    bootstrapDigest: hash(original.receiptSource), files: fileDigests, patches: patchDigests,
    runtimeReceiptDigest: stageRuntime.receiptDigest,
    planDigest: hash(json({ files: fileDigests, patches: patchDigests })),
    result: { schemaVersion: 1, manifestPath, manifestDigest: fileDigests[manifestPath],
      targetProfile: ownerRepair.profile, coordinatorProfile: ownerRepair.coordinatorProfile },
    repair: { sourceMaintenanceDigest: api.control.sourceMaintenanceDigest(record),
      before: { files: original.receipt.files,
        patches: Object.fromEntries(Object.entries(original.patches).map(([name, value]) => [name, hash(value)])),
        runtimeReceiptDigest: original.runtimeReceiptDigest,
        creationReceiptDigest: original.creationDigest, journalDigest: hash(original.journalSource) },
      after: { creationReceiptDigest: creation.receiptSha256, journalDigest: hash(journalSource) },
      permissionPreset: ownerRepair.permissionPreset },
    issuedAt: Date.now(), authority: resources.identities.host.authority,
    keyId: resources.identities.host.keyId },
  (await stable(join(stageHome, relative(homePath, resources.identities.host.keyPath)), 16_384)).toString('utf8'),
  resources, original.receiptSource, [])
  const overlayPath = join(stageHome, relative(homePath, resources.configRoot), 'host-update-overlays.json')
  await exclusive(overlayPath, json({ schemaVersion: 1, kind: 'rsi-host-update-overlays', records: [overlay] }))
  const next = { schemaVersion: 1, transactionId, manifestPath, manifestDigest: fileDigests[manifestPath],
    files: fileDigests, patches: patchDigests, overlay, overlayDigest: api.rsiHostUpdateOverlayDigest(overlay),
    audit, creationReceiptSha256: creation.receiptSha256, candidateReceiptSha256: creation.candidateReceiptSha256,
    journalDigest: hash(journalSource), recordDigest: api.control.sourceMaintenanceDigest(record) }
  await verifyOwnerSourceRepair({ ownerRepair, ownerRepairNext: next, homePath,
    physicalHome: stageHome, installer, phase: 'after-finalize', record, checkLedger: true })
  return next
}

export async function captureOwnerSourceRepair({ homePath, profile, installer, permissionPreset,
  dshPath, dshEnvironment = process.env }) {
  await privateDirectory(homePath)
  if (!profileName.test(profile) || !['workspace-write', 'danger-full-access'].includes(permissionPreset)) fail('explicit permission preset is required')
  const api = await load(installer)
  const resources = await api.prepareRsiAuthorityResources({ dshHome: homePath, profile, existingOnly: true })
  const runtime = await api.readRsiAuthorityRuntimeReceipt({ logicalHome: homePath, physicalHome: homePath, profile })
  const source = await api.readRsiSourceMaintenance({ logicalHome: homePath, physicalHome: homePath, profile })
  const config = resources.configRoot
  const receiptSource = (await stable(join(config, 'bootstrap.json'))).toString('utf8')
  const receipt = parsed(receiptSource, 'owner bootstrap receipt')
  const manifestSource = (await stable(join(config, 'manifest.json'))).toString('utf8')
  const manifest = parsed(manifestSource, 'owner manifest')
  if (manifest.targetProfile !== profile || !profileName.test(manifest.coordinatorProfile)
    || manifest.coordinatorProfile === profile || !manifest.pluginCreation
    || receipt.schemaVersion !== 1 || receipt.result?.manifestDigest !== hash(manifestSource)
    || receipt.result.manifestPath !== join(config, 'manifest.json')
    || receipt.result.targetProfile !== profile || receipt.result.coordinatorProfile !== manifest.coordinatorProfile
    || receipt.files?.[join(config, 'manifest.json')] !== hash(manifestSource)) fail('first owner bootstrap binding differs')
  const overlayPath = join(config, 'host-update-overlays.json')
  if (await optional(overlayPath, 2_097_152) !== null) fail('prior Host overlay requires a separate repair contract')
  if (!receipt.files || typeof receipt.files !== 'object' || Array.isArray(receipt.files)
    || Object.keys(receipt.files).length < 1 || Object.keys(receipt.files).length > 64) fail('owner configuration inventory differs')
  const files = {}
  for (const [path, digest] of Object.entries(receipt.files)) {
    if (!inside(config, path) || path === config || !hex.test(digest)) fail('owner configuration path or digest differs')
    const content = (await stable(path)).toString('utf8')
    if (hash(content) !== digest) fail('owner configuration bytes drifted')
    files[path] = content
  }
  const journalSource = (await stable(join(homePath, '.rsi-setup-journal.json'))).toString('utf8')
  const journal = parsed(journalSource, 'owner journal')
  assertJournal(journal, manifest, hash(manifestSource))
  const patches = {}, environments = {}, units = {}
  for (const [index, name] of [profile, manifest.coordinatorProfile].entries()) {
    const patch = (await stable(join(homePath, 'profiles', name, 'cordis.patch.yml'), 2_097_152, false)).toString('utf8')
    const environment = await optional(api.rsiServiceEnvironmentPath(homePath, name), 2_097_152)
    const unit = await optional(api.systemdServicePaths({ dshHome: homePath, profile: name,
      home: realpathSync(homedir()) }).unitPath, 2_097_152, false)
    if (patch !== journal.entries[index].after || environment !== journal.environments[index].after
      || unit !== journal.units[index].after) fail('owner applied journal differs from installed resources')
    patches[name] = patch; environments[name] = environment; units[name] = unit
  }
  const observerKey = await stable(manifest.controlPlane.runtimeObserver.keyPath, 32)
  if (observerKey.length !== 32 || hash(observerKey) !== receipt.observerKeyDigest) fail('observer key differs')
  const sourceState = await ownerLedger(api, join(manifest.controlPlane.statePath, 'control.sqlite'),
    source.workspace.repository, homePath, source.records)
  const composed = await composeOwnerRepairProfiles({ homePath, profile,
    coordinatorProfile: manifest.coordinatorProfile, dshPath })
  const ownerSnapshot = await api.rsiSetupPorts.snapshot(composed.targetEffective, homePath)
  if (ownerSnapshot.bindings.length !== 1) fail('exactly one active owner DM binding is required')
  const owner = ownerSnapshot.bindings[0]
  const effectiveRows = yamlRows(api, composed.targetEffective, 'owner effective').contents.items
  const delivery = effectiveRows.filter(item => api.yaml.isMap(item)
    && item.get('id') === 'dsh-enhanced-assistant-delivery')
  if (delivery.length !== 1 || !api.yaml.isMap(delivery[0].get('config', true))) {
    fail('owner Delivery row differs')
  }
  const route = api.resolveRsiOwnerRoute(delivery[0].get('config', true).toJSON(),
    owner, homePath, manifest.sourceReviews.owner.authorityId)
  if (!same(manifest.sourceReviews.owner, {
    authorityId: route.route.id,
    authorityHash: route.route.authorityHash,
    principalId: route.principal,
    principalRecordId: owner.owner.id, principalVersion: owner.owner.version,
    workspace: owner.workspace, agentPreset: owner.agentPreset })) fail('owner binding differs')
  const originalPlan = await originalCompiledPlan(api, { homePath, profile,
    coordinatorProfile: manifest.coordinatorProfile, source, resources, runtime, files,
    dshPath, dshEnvironment, manifest, journal, receipt, owner })
  await assertIssuerStateAbsent({ resources, files, homePath, physicalHome: homePath })
  const creationPath = join(homePath, 'rsi-creation-builds', profile, 'bootstrap.json')
  const creationSource = (await stable(creationPath, 65_536)).toString('utf8')
  const build = await api.readRsiBuildEnvironment({ dshHome: homePath, profile, source: source.workspace })
  const releaseBuild = await api.readRsiReleaseBuildEnvironment({ dshHome: homePath, profile, build })
  const creationBuild = await api.readRsiCreationBuildEnvironment({ dshHome: homePath, profile,
    source: source.workspace, build })
  const hostAuthority = parsed(files[join(config, 'host-authority.json')], 'Host authority')
  const releaseAuthority = parsed(files[join(config, 'release.json')], 'release authority')
  const trust = parsed(files[join(config, 'trust.json')], 'owner trust')
  const runtimeReceiptPath = join(homePath, 'rsi-authority-runtimes', profile, 'receipt.json')
  const runtimeReceiptDigest = hash(await stable(runtimeReceiptPath, 65_536))
  const sourceDigest = hash(json(sourceState))
  const original = { resources, runtime, source, sourceDigest, sourceState, owner, ownerSnapshot,
    manifest, manifestSource, receipt, receiptSource, journal, journalSource, files, patches,
    environments, units, creationSource, creationDigest: hash(creationSource), creationBuild,
    runtimeReceiptDigest, build, releaseBuild, now: hostAuthority.grant?.notBefore,
    executor: trust.executor, policies: releaseAuthority.grant?.policies,
    unitProperties: hostAuthority.template?.unitProperties, originalPlan,
    effective: { targetEffective: composed.targetEffective, coordinatorEffective: composed.coordinatorEffective } }
  compiledFiles(api, original)
  const reconstructed = api.createRsiBootstrapManifest(manifestInputs(original, composed.targetEffective,
    creationBuild, source.workspace, runtime.runtime, build.sourceBuild))
  if (json(reconstructed) !== manifestSource) fail('old owner manifest cannot be reproduced')
  const result = { protocol, homePath, profile, coordinatorProfile: manifest.coordinatorProfile,
    permissionPreset, installer, dshPath, host: { dshDigest: composed.dshDigest, version: composed.dshVersion },
    original }
  await verifyOwnerSourceRepair({ ownerRepair: result, homePath, physicalHome: homePath, installer, phase: 'original' })
  return result
}

export async function readOwnerRepairCandidateSource({ api, candidateHome, profile, source, signal }) {
  if (!['local-head', 'official-tag'].includes(source?.origin?.kind)) fail('candidate source provenance is invalid')
  const actualSource = await api.readRsiSourceWorkspace({ dshHome: candidateHome, profile,
    ...(source.origin.kind === 'local-head' ? { sourceRepository: source.origin.locator } : {}),
    ...(signal ? { signal } : {}) })
  if (!same(actualSource, source)) fail('candidate source or build differs from the prepared maintenance')
  return actualSource
}

export async function prepareOwnerRepairCreation({ ownerRepair, candidateHome, source, sourceBuild,
  installer = ownerRepair?.installer, signal }) {
  if (ownerRepair?.protocol !== protocol || !exact(candidateHome) || candidateHome === ownerRepair.homePath
    || inside(ownerRepair.homePath, candidateHome) || inside(candidateHome, ownerRepair.homePath)
    || !same(installer, ownerRepair.installer)) {
    fail('candidate creation Home is not distinct from the original')
  }
  const api = await load(installer)
  await privateDirectory(candidateHome)
  const profile = ownerRepair.profile
  const actualSource = await readOwnerRepairCandidateSource({ api, candidateHome, profile, source, signal })
  const actualBuild = await api.readRsiBuildEnvironment({ dshHome: candidateHome, profile,
    source: actualSource, ...(signal ? { signal } : {}) })
  if (!same(actualBuild, sourceBuild)
    || actualSource.sourceCommit === ownerRepair.original.source.workspace.sourceCommit) {
    fail('candidate source or build differs from the prepared maintenance')
  }
  const creationBuild = await api.prepareRsiCreationBuildEnvironment({ dshHome: candidateHome,
    profile, source: actualSource, build: actualBuild, ...(signal ? { signal } : {}) })
  const path = join(candidateHome, 'rsi-creation-builds', profile, 'bootstrap.json')
  const receiptSha256 = hash(await stable(path, 65_536))
  if (!same(await api.readRsiCreationBuildEnvironment({ dshHome: candidateHome, profile,
    source: actualSource, build: actualBuild, ...(signal ? { signal } : {}) }), creationBuild)) {
    fail('candidate creation build did not replay')
  }
  return { schemaVersion: 1, candidateHome, candidateSource: actualSource,
    candidateBuild: actualBuild, creationBuild, receiptSha256 }
}

export async function appendOwnerSourceRepairMaintenance({ ownerRepair, homePath, stageHome, record,
  installer = ownerRepair?.installer }) {
  if (ownerRepair?.protocol !== protocol || ownerRepair.homePath !== homePath
    || !exact(stageHome) || stageHome === homePath || record?.host !== null
    || !same(installer, ownerRepair.installer)) fail('owner repair source record is not unanchored')
  const api = await load(installer)
  await privateDirectory(stageHome)
  const original = ownerRepair.original
  const digest = api.control.sourceMaintenanceDigest(api.control.parseSourceMaintenanceRecord(record))
  const stageSource = await api.readRsiSourceMaintenance({ logicalHome: homePath, physicalHome: stageHome,
    profile: ownerRepair.profile })
  if (!same(stageSource.records, [...original.source.records, record])
    || !same(stageSource.anchor, original.source.anchor)
    || stageSource.workspace.sourceCommit !== record.after.sourceCommit) fail('staged signed source chain differs')
  const stageLedgerPath = join(stageHome, 'rsi-authorities', ownerRepair.profile, 'state',
    'control-plane', 'control.sqlite')
  const before = await ownerLedger(api, stageLedgerPath, original.source.workspace.repository,
    homePath, original.source.records)
  if (!same(before, original.sourceState)) fail('staged ledger history differs from captured original')
  const trustPath = join(stageHome, 'rsi-authorities', ownerRepair.profile, 'config', 'trust.json')
  const trust = await api.control.loadTrustConfig(trustPath)
  if (trust.installationId !== original.resources.installationId
    || trust.ledger.id !== original.resources.ledgerId || trust.dshHome !== homePath
    || hash(await stable(trustPath)) !== original.receipt.files[join(original.resources.configRoot, 'trust.json')]) {
    fail('staged old owner trust differs')
  }
  const ledger = new api.control.ControlPlaneStore({ path: stageLedgerPath })
  try { await ledger.appendSourceMaintenance(record, { trust, baseline: original.source.workspace.baseline,
    physicalHome: stageHome }) } finally { ledger.close() }
  const after = await ownerLedger(api, stageLedgerPath, original.source.workspace.repository,
    homePath, [...original.source.records, record])
  if (!same(after.history, original.sourceState.history)) fail('source release history changed during append')
  return { recordDigest: digest, ledgerDigest: hash(json(after)) }
}

export async function verifyOwnerSourceRepair({ ownerRepair, ownerRepairNext, homePath,
  physicalHome = homePath, installer = ownerRepair?.installer, phase = 'original', record, checkLedger = false }) {
  if (ownerRepair?.protocol !== protocol || ownerRepair.homePath !== homePath
    || !same(installer, ownerRepair.installer)
    || !['original', 'before-finalize', 'after-finalize'].includes(phase)
    || phase === 'before-finalize' && !record
    || phase === 'after-finalize' && !ownerRepairNext) fail('invalid owner repair proof')
  const api = await load(installer)
  await privateDirectory(physicalHome)
  const original = ownerRepair.original
  const config = join(physicalHome, 'rsi-authorities', ownerRepair.profile, 'config')
  const paths = phase === 'after-finalize' ? ownerRepairNext?.files : original.receipt.files
  if (!paths || Object.keys(paths).length !== Object.keys(original.receipt.files).length) fail('owner repair file inventory is incomplete')
  for (const [logicalPath, digest] of Object.entries(paths)) {
    if (!inside(original.resources.configRoot, logicalPath) || !hex.test(digest)) fail('owner repair config scope differs')
    const path = join(config, relative(original.resources.configRoot, logicalPath))
    if (hash(await stable(path)) !== digest) fail('owner repair configuration changed')
  }
  if (phase === 'original' || phase === 'before-finalize') {
    await assertIssuerStateAbsent({ resources: original.resources, files: original.files,
      homePath, physicalHome })
    if ((await stable(join(config, 'bootstrap.json'))).toString('utf8') !== original.receiptSource
      || (await stable(join(physicalHome, '.rsi-setup-journal.json'))).toString('utf8') !== original.journalSource
      || hash(await stable(join(physicalHome, 'rsi-creation-builds', ownerRepair.profile, 'bootstrap.json'), 65_536)) !== original.creationDigest) {
      fail('original owner bootstrap or journal changed')
    }
    for (const [name, source] of Object.entries(original.patches)) {
      if ((await stable(join(physicalHome, 'profiles', name, 'cordis.patch.yml'), 2_097_152, false)).toString('utf8') !== source) fail('original owner profile changed')
    }
    for (const [name, source] of Object.entries(original.environments)) {
      if (await optional(join(physicalHome, relative(homePath, api.rsiServiceEnvironmentPath(homePath, name))),
        2_097_152) !== source) fail('original owner service environment changed')
    }
    for (const [name, source] of Object.entries(original.units)) {
      if (await optional(api.systemdServicePaths({ dshHome: homePath, profile: name,
        home: realpathSync(homedir()) }).unitPath, 2_097_152, false) !== source) {
        fail('original owner service unit changed')
      }
    }
    if (phase === 'original') {
      const runtime = await api.readRsiAuthorityRuntimeReceipt({ logicalHome: homePath,
        physicalHome, profile: ownerRepair.profile })
      if (!same(runtime, original.runtime)) fail('original authority runtime changed')
      const composed = await composeOwnerRepairProfiles({ homePath, profile: ownerRepair.profile,
        coordinatorProfile: ownerRepair.coordinatorProfile, dshPath: ownerRepair.dshPath })
      if (!same({ dshDigest: composed.dshDigest, version: composed.dshVersion }, ownerRepair.host)
        || !same({ targetEffective: composed.targetEffective,
          coordinatorEffective: composed.coordinatorEffective }, original.effective)
        || !same(await api.rsiSetupPorts.snapshot(composed.targetEffective, homePath),
          original.ownerSnapshot)) fail('original native composition or owner binding changed')
    }
  }
  if (phase === 'after-finalize') {
    if ((await stable(join(config, 'bootstrap.json'))).toString('utf8') !== original.receiptSource) {
      fail('original bootstrap receipt was rewritten')
    }
    const overlaySource = (await stable(join(config, 'host-update-overlays.json'))).toString('utf8')
    const chain = api.readRsiHostUpdateOverlayChain({ source: overlaySource, resources: original.resources,
      dshHome: homePath, profile: ownerRepair.profile, bootstrapSource: original.receiptSource })
    const overlay = chain.latest
    if (chain.records.length !== 1 || overlay?.kind !== 'rsi-owner-repair-overlay'
      || !same(overlay, ownerRepairNext?.overlay)
      || api.rsiHostUpdateOverlayDigest(overlay) !== ownerRepairNext.overlayDigest
      || !same(overlay.files, paths) || !same(overlay.patches, ownerRepairNext.patches)
      || overlay.result.manifestDigest !== ownerRepairNext.manifestDigest
      || overlay.repair.permissionPreset !== ownerRepair.permissionPreset
      || hash(await stable(join(physicalHome, '.rsi-setup-journal.json'))) !== overlay.repair.after.journalDigest
      || hash(await stable(join(physicalHome, 'rsi-creation-builds', ownerRepair.profile,
        'bootstrap.json'), 65_536)) !== overlay.repair.after.creationReceiptDigest
      || hash(await stable(join(physicalHome, 'rsi-authority-runtimes', ownerRepair.profile,
        'receipt.json'), 65_536)) !== overlay.runtimeReceiptDigest) fail('signed owner repair successor differs')
    for (const [name, digest] of Object.entries(overlay.patches)) {
      if (hash(await stable(join(physicalHome, 'profiles', name, 'cordis.patch.yml'),
        2_097_152, false)) !== digest) fail('signed repaired patch changed')
    }
    for (const [name, source] of Object.entries(original.environments)) {
      if (await optional(join(physicalHome, relative(homePath, api.rsiServiceEnvironmentPath(homePath, name))),
        2_097_152) !== source) fail('owner service environment changed outside repair')
    }
    for (const [name, source] of Object.entries(original.units)) {
      if (await optional(api.systemdServicePaths({ dshHome: homePath, profile: name,
        home: realpathSync(homedir()) }).unitPath, 2_097_152, false) !== source) {
        fail('owner service unit changed outside repair')
      }
    }
    const auditPath = join(physicalHome, relative(homePath, ownerRepairNext.audit.path))
    const auditSource = (await stable(auditPath, 4_194_304)).toString('utf8')
    const audit = parsed(auditSource, 'owner repair audit')
    if (hash(auditSource) !== ownerRepairNext.audit.digest
      || !same(audit.files, original.files) || audit.bootstrapReceipt !== original.receiptSource
      || audit.journal !== original.journalSource || audit.creationReceipt !== original.creationSource
      || !same(audit.patches, original.patches)
      || overlay.repair.sourceMaintenanceDigest !== ownerRepairNext.recordDigest
      || !same(overlay.repair.before, { files: original.receipt.files,
        patches: Object.fromEntries(Object.entries(original.patches).map(([name, value]) => [name, hash(value)])),
        runtimeReceiptDigest: original.runtimeReceiptDigest,
        creationReceiptDigest: original.creationDigest, journalDigest: hash(original.journalSource) })) {
      fail('signed repair predecessor or audit differs')
    }
    const source = await api.readRsiSourceMaintenance({ logicalHome: homePath,
      physicalHome, profile: ownerRepair.profile })
    const maintenance = source.records.find(item => api.control.sourceMaintenanceDigest(item)
      === overlay.repair.sourceMaintenanceDigest)
    if (!maintenance || maintenance.host !== null
      || !same(source.records.slice(0, original.source.records.length), original.source.records)) {
      fail('signed source repair record differs')
    }
  }
  if (phase === 'after-finalize' && !checkLedger) return { phase, overlayDigest: ownerRepairNext.overlayDigest }
  const ledgerPath = join(physicalHome, 'rsi-authorities', ownerRepair.profile, 'state', 'control-plane', 'control.sqlite')
  const ledger = await ownerLedger(api, ledgerPath, original.source.workspace.repository,
    homePath, phase === 'original' ? original.source.records : [...original.source.records, record])
  if (!same(ledger.history, original.sourceState.history)) fail('source release history changed')
  if (phase === 'original' && !same(ledger, original.sourceState)) fail('original source ledger changed')
  return { phase, ledgerDigest: hash(json(ledger)) }
}

export async function awaitOwnerSourceRepairReady({ ownerRepair, ownerRepairNext, homePath,
  installer = ownerRepair?.installer, startedAt, signal }) {
  if (!Number.isSafeInteger(startedAt) || startedAt <= 0 || startedAt > Date.now()
    || ownerRepair?.protocol !== protocol || ownerRepair.homePath !== homePath
    || !same(installer, ownerRepair.installer)) {
    fail('invalid repair readiness input')
  }
  const api = await load(installer)
  await verifyOwnerSourceRepair({ ownerRepair, ownerRepairNext, homePath,
    installer, phase: 'after-finalize' })
  const manifest = parsed((await stable(join(homePath, relative(homePath,
    ownerRepairNext.manifestPath)))).toString('utf8'), 'repaired owner manifest')
  const hostPath = join(homePath, 'rsi-authorities', ownerRepair.profile, 'config', 'host-authority.json')
  const host = parsed((await stable(hostPath)).toString('utf8'), 'repaired Host grant')
  if (host.grant?.notBefore !== ownerRepair.original.now
    || host.grant?.expiresAt !== ownerRepair.original.manifest.sourceReviews.expiresAt
    || !same(host.template?.systemctl, originalInputs(ownerRepair.original).systemctl)) {
    fail('repaired Host readiness grant differs')
  }
  await api.rsiInstallPorts.ready(manifest, host.template.systemctl,
    signal ?? new AbortController().signal, startedAt)
  return { mode: 'ready', manifestDigest: ownerRepairNext.manifestDigest,
    overlayDigest: ownerRepairNext.overlayDigest }
}
