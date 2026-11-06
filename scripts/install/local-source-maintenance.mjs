/** Explicit pre-owner source maintenance. The caller owns the existing Home
 * lifecycle lock and service transaction; this module never starts services or
 * creates a control ledger. Trusted installer code and frozen candidate code
 * have separate identities. */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { buildLocalSourcePreviewOverlay, assertLocalSourcePreviewDerivation } from './local-source-preview.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
const digest = value => hash(canonical(value))
const inside = (root, path) => path === root || path.startsWith(root + sep)
const exactPath = path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path && !path.includes('\0')
const fail = message => { throw new Error(`Local source maintenance: ${message}`) }
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const modules = ['rsi-local-update', 'rsi-local-update-build', 'rsi-local-resources', 'rsi-source-maintenance',
  'rsi-local-activation', 'rsi-local-pair-install', 'rsi-local-install', 'rsi-local-cohort', 'rsi-authority-runtime',
  'rsi-linux-native-resources', 'rsi-plugin-revision', 'supervised-growth-profile']
/** Modules whose absence only fails closed on the path that needs them. The
 * backend-agnostic candidate-build reader and the linux-native resource staging
 * may postdate an older installer's packaged lib tree; the Docker path never
 * reads either, so only their own absence is tolerated. */
const optionalModules = new Set(['rsi-local-update-build', 'rsi-linux-native-resources',
  'rsi-plugin-revision'])
const ownerModules = ['rsi-source', 'rsi-build', 'rsi-authority-resources', 'rsi-setup', 'rsi-profile']

/** One wording for the transition window in which an installer can recognise a
 * linux-native receipt but cannot yet complete that transaction. Kept here so
 * the program-update and source-repair layers cannot drift apart. */
export const nativeCandidateRefusal = capability =>
  `a linux-native candidate build was found but the ${capability} for linux-native candidates is not available in this installer yet`
export const nativeOriginalRefusal = capability =>
  `a linux-native installation was found but the ${capability} for linux-native installations is not available in this installer yet`

/** Backend of a prepared candidate Home build receipt. Schema 3 is the native
 * linux runtime; schema 1 is the legacy Docker image build. */
export const localCandidateBuildBackend = build => build?.schemaVersion === 3 && build.backend === 'linux-native'
  ? 'linux-native' : build?.schemaVersion === 1 ? 'docker' : 'unknown'

/** Read a prepared candidate Home build through the backend-agnostic reader.
 * Installers whose packaged lib tree predates that reader keep their historical
 * Docker-only read; callers that cannot update the resulting backend refuse
 * explicitly instead of continuing with the other backend's receipts. */
export function readLocalCandidateSourceBuild(api, input) {
  return typeof api.readRsiLocalUpdateSourceBuild === 'function'
    ? api.readRsiLocalUpdateSourceBuild(input)
    : api.readRsiBuildEnvironment(input)
}
const resourceKinds = ['rsi-sources', 'rsi-local-cohorts', 'rsi-builds', 'rsi-release-builds', 'rsi-authorities', 'rsi-authority-runtimes']
const nativeProtocol = 'dsh-enhanced/pre-owner-source-maintenance/v3'
export const localSourceResourceKinds = backend => {
  if (!['docker', 'linux-native'].includes(backend)) fail('unknown source resource backend')
  return resourceKinds.map(kind => backend === 'linux-native' && kind === 'rsi-builds' ? 'rsi-linux-runtimes' : kind)
}

/** Layout discrimination is not runtime authentication. Callers selecting a
 * real native Home must additionally inspect its recorded runtime identity. */
export async function localSourceResourceBackend({ homePath, profile }) {
  if (!exactPath(homePath) || !PROFILE.test(profile)) fail('invalid source resource Home')
  await trustedDirectory(homePath)
  const native = await optional(join(homePath, 'rsi-linux-runtimes', profile))
  const docker = await optional(join(homePath, 'rsi-builds', profile))
  if (!!native === !!docker) fail('source resources must contain exactly one build backend')
  if (native) {
    for (const kind of ['rsi-creation-builds', 'rsi-linux-repository-runtimes', 'rsi-linux-creation-builds']) {
      if (await optional(join(homePath, kind, profile))) fail('pre-owner native resources contain an owner build family')
    }
  }
  return native ? 'linux-native' : 'docker'
}
const ownerFields = new Set(['sourceJobs', 'sourceApprovals', 'sourceReleases', 'sourceReleaseExecution',
  'sourceAdoptions', 'sourceBuild', 'runtimeObserver', 'foregroundDeployments', 'taskObservations', 'adoptionCoordinator',
  'memoryReviews', 'automaticLearning'])
const learnerId = 'dsh-enhanced-assistant-memory-learning'
const learnerName = '@dsh-enhanced/assistant-memory-learning'

async function trustedDirectory(path) {
  if (!exactPath(path) || await realpath(path) !== path) fail(`non-canonical trusted path: ${path}`)
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.uid !== process.getuid() || (entry.mode & 0o022)) fail(`unsafe directory: ${path}`)
  return entry
}
async function bytes(path, maximum = 268_435_456) {
  const before = await lstat(path)
  if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 0o022)
    || before.size > maximum) fail(`unsafe file: ${path}`)
  const source = await readFile(path)
  const after = await lstat(path)
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeMs !== after.ctimeMs || source.length !== before.size) fail(`file changed: ${path}`)
  return source
}
async function optional(path) {
  try { return await lstat(path) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}

/** Bind executable bytes, package metadata and the complete installed module
 * trees, including pnpm links. Links may only resolve inside the reviewed root;
 * cache output is not executable input to these reviewed modules. */
export async function bindLocalSourceInstaller(root) {
  const entry = await trustedDirectory(root)
  const entries = []
  const visited = new Set()
  let size = 0
  const visit = async path => {
    if (entries.length > 250_000) fail('installer module tree exceeds entry bound')
    const item = await lstat(path)
    if (item.uid !== process.getuid()) fail(`unsafe installer module entry: ${path}`)
    // A umask 002 checkout is common on Linux; name the one-line repair.
    if (!item.isSymbolicLink() && (item.mode & 0o022)) {
      fail(`unsafe installer module entry: ${path} is group/other-writable; run: chmod -R go-w ${root}`)
    }
    const locator = relative(root, path)
    if (item.isSymbolicLink()) {
      const text = await readlink(path)
      let target
      try { target = await realpath(path) } catch (error) {
        if (error.code !== 'ENOENT' || !path.includes(`${sep}node_modules${sep}`)) throw error
        target = resolve(dirname(path), text)
        if (!inside(root, target)) fail(`absent optional module link escapes reviewed root: ${path}`)
        entries.push([locator, 'absent-link', text, relative(root, target)])
        return
      }
      if (!inside(root, target)) fail(`installer module link escapes reviewed root: ${path}`)
      entries.push([locator, 'link', text, relative(root, target)])
      if (!visited.has(target)) await visit(target)
      return
    }
    if (visited.has(path)) return
    visited.add(path)
    if (item.isDirectory()) {
      entries.push([locator, 'directory', item.mode & 0o777])
      for (const name of (await readdir(path)).sort()) {
        if (['.cache', '.vite', '.tmp'].includes(name)) continue
        await visit(join(path, name))
      }
    } else if (item.isFile()) {
      size += item.size
      if (size > 8_589_934_592) fail('installer module tree exceeds byte bound')
      entries.push([locator, 'file', item.mode & 0o777, hash(await bytes(path))])
    } else fail(`special installer module entry: ${path}`)
  }
  for (const parent of ['plugins', 'packages']) {
    const directory = join(root, parent)
    await trustedDirectory(directory)
    for (const name of (await readdir(directory)).sort()) {
      const packageRoot = join(directory, name)
      const packageEntry = await lstat(packageRoot)
      if (packageEntry.isSymbolicLink()) fail(`linked installer package root is unsupported: ${packageRoot}`)
      if (!packageEntry.isDirectory()) continue
      if (await optional(join(packageRoot, 'package.json'))) await visit(join(packageRoot, 'package.json'))
      if (await optional(join(packageRoot, 'lib'))) await visit(join(packageRoot, 'lib'))
      if (await optional(join(packageRoot, 'node_modules'))) await visit(join(packageRoot, 'node_modules'))
    }
  }
  await visit(join(root, 'node_modules'))
  await visit(join(root, 'scripts', 'install'))
  await visit(join(root, 'package.json'))
  await visit(join(root, 'pnpm-lock.yaml'))
  entries.sort((a, b) => a[0].localeCompare(b[0]))
  return { root, dev: String(entry.dev), ino: String(entry.ino), digest: digest(entries), entries: entries.length }
}
export async function assertLocalSourceInstaller(binding) {
  if (!isDeepStrictEqual(await bindLocalSourceInstaller(binding.root), binding)) fail('reviewed installer module bytes or ownership changed')
}
async function load(binding, { ownerRepair = false } = {}) {
  await assertLocalSourceInstaller(binding)
  const root = join(binding.root, 'plugins', 'lark-channel', 'lib')
  const require = createRequire(join(binding.root, 'package.json'))
  const yamlPath = await realpath(require.resolve('yaml/package.json'))
  if (!inside(binding.root, yamlPath)) fail('YAML parser is outside the reviewed installer root')
  const moduleRequire = createRequire(join(root, 'supervised-growth-profile.js'))
  if (!inside(binding.root, await realpath(moduleRequire.resolve('yaml/package.json')))) fail('YAML parser is outside the reviewed installer root')
  const selectedModules = ownerRepair ? [...modules, ...ownerModules] : modules
  const imported = await Promise.all(selectedModules.map(async name => {
    const path = join(root, `${name}.js`)
    // The backend-agnostic candidate-build reader and the linux-native resource
    // staging may postdate an older installer's packaged lib tree; only their own
    // absence is tolerated. Any other module missing from the reviewed tree stays
    // fatal, and the Docker path never reads the optional ones.
    if (optionalModules.has(name) && !(await optional(path))) return {}
    return import(pathToFileURL(path).href)
  }))
  const result = Object.assign({}, ...imported)
  result.yaml = require('yaml')
  return result
}

export { load as loadLocalSourceInstaller }
async function memoryLearnerInitialRow(binding) {
  await assertLocalSourceInstaller(binding)
  const source = join(binding.root, 'plugins', 'lark-channel', 'lib', 'rsi-local-roots-extension.js')
  const { rsiMemoryLearningInitialRow } = await import(pathToFileURL(source).href)
  if (!rsiMemoryLearningInitialRow || typeof rsiMemoryLearningInitialRow !== 'object') fail('reviewed memory learner row is unavailable')
  return rsiMemoryLearningInitialRow
}

/** pnpm compares store spellings in .modules.yaml, even for the same inode. */
export async function readLocalSourcePnpmStoreAlias({ profilePath, storePath, installer }) {
  const { yaml } = await load(installer)
  const path = join(profilePath, 'node_modules', '.modules.yaml')
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size > 16 * 1024 * 1024
    || before.mode & 0o022 || before.uid !== process.getuid()) fail('pnpm installed store metadata is unsafe')
  const source = await readFile(path, 'utf8')
  const after = await lstat(path)
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('pnpm installed store metadata changed')
  const document = yaml.parseDocument(source, { uniqueKeys: true })
  const alias = document.get('storeDir')
  if (document.errors.length || document.warnings.length || !exactPath(alias)
    || await realpath(alias) !== storePath) fail('pnpm installed store alias does not match the verified store')
  const canonical = await lstat(storePath), selected = await lstat(await realpath(alias))
  if (!canonical.isDirectory() || canonical.dev !== selected.dev || canonical.ino !== selected.ino) fail('pnpm installed store alias identity changed')
  return { path: alias, metadataDigest: hash(source) }
}

/** The proof covers each effective profile, not merely the target patch. A
 * mounted Recovery or Control Plane with no work/owner grants is ordinary base
 * functionality. Delivery scheduling is deliberately distinct from Automations. */
export function assertPreOwnerEffectiveConfigs(configs, logicalHome, targetProfile, yaml) {
  if (!configs || typeof configs !== 'object' || !Object.hasOwn(configs, targetProfile)) fail('target effective configuration is absent')
  const result = {}
  const inspect = (node, context = '') => {
    if (Array.isArray(node)) { for (const value of node) inspect(value, context); return }
    if (!node || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      if (ownerFields.has(key) && value !== undefined && value !== null && value !== false) fail(`owner/source authority configuration is present: ${key}`)
      if (typeof value === 'string' && value.includes(join(logicalHome, 'rsi-authorities'))
        && value.includes(`${sep}config`)) fail('owner authority configuration reference is present')
      if (key === 'schedulerEnabled' && /automations/iu.test(context) && value !== false) fail('Automations scheduler must be explicitly disabled')
      if (key === 'jobs' && /recovery/iu.test(context) && (!Array.isArray(value) || value.length)) fail('Recovery jobs require the supervised owner maintenance path')
      if (key === 'ownerRoutes' && /control.plane/iu.test(context) && (!Array.isArray(value) || value.length)) fail('Control Plane owner routes are present')
      inspect(value, `${context}/${key}`)
    }
  }
  for (const [profile, source] of Object.entries(configs)) {
    if (!PROFILE.test(profile) || typeof source !== 'string') fail('invalid effective profile inventory')
    const document = preOwnerDocument(source, yaml)
    if (!yaml.isSeq(document.contents)) fail('effective configuration is not supported YAML')
    for (const row of document.contents.items) {
      if (!yaml.isMap(row)) fail('dynamic effective row is unsupported')
      for (const key of ['id', 'name']) {
        const identity = row.get(key, true)
        if (!yaml.isScalar(identity) || identity.tag === 'tag:yaml.org,2002:js') fail('dynamic effective row identity is unsupported')
      }
      const config = row.get('config', true), name = row.get('name')
      if (yaml.isScalar(config) && config.tag === 'tag:yaml.org,2002:js' && typeof name === 'string'
        && ['plugin-control-plane', 'assistant-recovery', 'assistant-automations', 'personal-assistant'].some(suffix => name.endsWith(suffix))) fail('dynamic owner-sensitive config is unsupported')
    }
    const rows = document.toJSON()
    for (const row of rows) {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string' || typeof row.name !== 'string') fail('effective row identity is invalid')
      inspect(row, `${row.id}/${row.name}`)
      if (row.id === learnerId || row.name === learnerName) {
        if (row.id !== learnerId || row.name !== learnerName || row.disabled !== true || Object.hasOwn(row, 'config')) {
          fail('pre-owner memory learner row must be disabled and unconfigured')
        }
      }
      if (row.disabled === true) continue
      if (row.name.endsWith('assistant-automations') && row.config?.schedulerEnabled !== false) fail('active Automations scheduler is not explicitly disabled')
      if (row.name.endsWith('personal-assistant') && row.config?.assistantAutomations?.schedulerEnabled !== false) fail('personal-assistant Automations scheduler is not explicitly disabled')
      if (row.name.endsWith('assistant-recovery') && (!Array.isArray(row.config?.jobs) || row.config.jobs.length)) fail('active Recovery jobs are not proven empty')
    }
    result[profile] = hash(source)
  }
  return result
}

function preOwnerDocument(source, yaml) {
  const document = yaml.parseDocument(source, { uniqueKeys: true,
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] })
  if (document.errors.length || document.warnings.length) fail('configuration is not supported YAML')
  const inspect = node => {
    if (yaml.isAlias(node)) fail('configuration aliases are unsupported')
    if (yaml.isScalar(node) && node.tag === 'tag:yaml.org,2002:js') {
      if (typeof node.value !== 'string' || [...ownerFields].some(field => new RegExp(`\\b${field}\\b`, 'u').test(node.value))
        || node.value.includes('rsi-authorities')) fail('dynamic owner/source configuration is unsupported')
    } else if (yaml.isMap(node)) {
      for (const pair of node.items) {
        const key = yaml.isScalar(pair.key) ? pair.key.value : undefined
        if (typeof key === 'string' && (ownerFields.has(key) || key === 'includeLoader')) {
          const value = yaml.isScalar(pair.value) ? pair.value.value : pair.value
          if (value !== null && value !== false && value !== undefined) fail('owner/source configuration is present')
        }
        inspect(pair.key); inspect(pair.value)
      }
    } else if (yaml.isSeq(node)) for (const item of node.items) inspect(item)
  }
  inspect(document.contents)
  return document
}

function configSignature(node, yaml) {
  if (node === null) return null
  if (yaml.isScalar(node)) return ['scalar', node.tag ?? null, node.value]
  if (yaml.isSeq(node)) return ['sequence', node.tag ?? null, node.items.map(item => configSignature(item, yaml))]
  if (yaml.isMap(node)) return ['map', node.tag ?? null, node.items.map(pair => {
    if (!yaml.isScalar(pair.key) || pair.key.tag || typeof pair.key.value !== 'string') fail('dynamic configuration mapping key')
    return [pair.key.value, configSignature(pair.value, yaml)]
  }).sort(([left], [right]) => left.localeCompare(right))]
  fail('unsupported configuration node')
}

function learnerRows(source, yaml, initialRow) {
  const document = preOwnerDocument(source, yaml)
  if (!yaml.isSeq(document.contents)) fail('effective configuration is not a sequence')
  const seen = new Set()
  const rows = []
  for (const row of document.contents.items) {
    if (!yaml.isMap(row)) fail('effective configuration row is not a mapping')
    const id = row.get('id', true), name = row.get('name', true)
    if (!yaml.isScalar(id) || id.tag || typeof id.value !== 'string' || seen.has(id.value)
      || !yaml.isScalar(name) || name.tag || typeof name.value !== 'string') fail('missing or duplicate effective row identity')
    seen.add(id.value)
    rows.push({ id: id.value, name: name.value, signature: configSignature(row, yaml) })
  }
  const learner = rows.filter(row => row.id === initialRow.id || row.name === initialRow.name)
  return { rows, learner }
}

function fixedLearnerSignature(yaml, initialRow) {
  const source = yaml.stringify([initialRow])
  return learnerRows(source, yaml, { id: '', name: '' }).rows[0].signature
}

/** The digest is over YAML ASTs, including !!js tags. Row position may vary,
 * but deleting the one fixed learner row must recover the old row sequence. */
export function expectedMemoryLearningSemanticDigest(source, yaml, initialRow) {
  const { rows, learner } = learnerRows(source, yaml, initialRow)
  if (learner.length) fail('memory learner row is already present before preparation')
  return digest({ existing: rows.map(row => row.signature), learner: fixedLearnerSignature(yaml, initialRow) })
}

export function assertMemoryLearningCandidateConfigs({ configs, original, targetProfile, expectedCandidateSemanticDigest }, yaml, initialRow) {
  if (typeof expectedCandidateSemanticDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedCandidateSemanticDigest)
    || !configs || typeof configs !== 'object' || !Object.hasOwn(configs, targetProfile)
    || !isDeepStrictEqual(Object.keys(configs).sort(), Object.keys(original.configDigests).sort())) fail('memory learner configuration inventory differs')
  for (const [profile, source] of Object.entries(configs)) {
    if (profile !== targetProfile && hash(source) !== original.configDigests[profile]) fail('other effective profile changed during memory learner installation')
  }
  const { rows, learner } = learnerRows(configs[targetProfile], yaml, initialRow)
  const fixed = fixedLearnerSignature(yaml, initialRow)
  if (learner.length !== 1 || !isDeepStrictEqual(learner[0].signature, fixed)) fail('memory learner row differs from its fixed disabled bundle row')
  const existing = rows.filter(row => row !== learner[0]).map(row => row.signature)
  if (digest({ existing, learner: fixed }) !== expectedCandidateSemanticDigest) fail('memory learner changed pre-existing effective rows')
}

/** No native CLI before this proof: prepareProfile writes cordis.yml even for
 * --dump-config. All persistent layers are checked before snapshot composition. */
export async function assertLocalSourceRawPreflight(input) {
  const api = await load(input.installer)
  const physicalHome = await realpath(input.physicalHome ?? input.homePath)
  if (!input.configurationOnly) await api.assertRsiPreOwnerInstallation({ logicalHome: input.homePath, physicalHome, profile: input.profile })
  await assertHomeOwnerAbsence(physicalHome, input.profile)
  const files = {}
  const profiles = (await readdir(join(physicalHome, 'profiles'))).filter(name => name !== 'node_modules').sort()
  if (!profiles.includes(input.profile)) fail('target profile is absent')
  for (const profile of profiles) {
    if (!PROFILE.test(profile)) fail('unexpected profile directory')
    await trustedDirectory(join(physicalHome, 'profiles', profile))
  }
  for (const root of [physicalHome, ...profiles.map(profile => join(physicalHome, 'profiles', profile))]) {
    for (const name of ['cordis.yaml', 'cordis.patch.yaml', 'cordis.json', 'cordis.patch.json']) {
      if (await optional(join(root, name))) fail('alternate persistent configuration is unsupported')
    }
    for (const name of ['cordis.yml', 'cordis.patch.yml']) {
      const path = join(root, name), locator = relative(physicalHome, path)
      if (!await optional(path)) { files[locator] = null; continue }
      const source = await bytes(path, 2_097_152)
      const document = preOwnerDocument(source.toString('utf8'), api.yaml)
      if (!api.yaml.isSeq(document.contents)) fail('persistent configuration must contain static rows')
      for (const row of document.contents.items) {
        if (!api.yaml.isMap(row)) fail('dynamic persistent row is unsupported')
        const nameNode = row.get('name', true), config = row.get('config', true)
        const idNode = row.get('id', true)
        if (api.yaml.isScalar(idNode) && idNode.tag === 'tag:yaml.org,2002:js') fail('dynamic persistent row identity is unsupported')
        if (api.yaml.isScalar(nameNode) && nameNode.tag === 'tag:yaml.org,2002:js') fail('dynamic persistent row identity is unsupported')
        if (api.yaml.isScalar(config) && config.tag === 'tag:yaml.org,2002:js'
          && (nameNode === undefined || typeof nameNode?.value === 'string' && /(?:plugin-control-plane|assistant-recovery|assistant-automations|personal-assistant)$/u.test(nameNode.value))) fail('dynamic owner-sensitive persistent config is unsupported')
      }
      files[locator] = hash(source)
    }
  }
  return { profiles, files }
}
export async function composeLocalSourceConfigs(input) {
  const installer = input.installer ?? input.proof.installer
  const before = await assertLocalSourceRawPreflight({ ...input, installer })
  const configs = await effectiveConfigs(input.homePath, input.dshPath)
  const after = await assertLocalSourceRawPreflight({ ...input, installer })
  if (!isDeepStrictEqual(before, after)) fail('native composition changed persistent configuration bytes')
  const api = await load(installer)
  const cohort = await api.readRsiLocalCohort({ dshHome: input.homePath, profile: input.profile })
  await api.verifyRsiLocalInstalledPackages({ cohort, profilePath: join(input.homePath, 'profiles', input.profile), bundles: cohort.bundles })
  assertPreOwnerEffectiveConfigs(configs, input.homePath, input.profile, api.yaml)
  return { configs, rawConfiguration: before }
}

async function effectiveConfigs(home, dshPath) {
  const result = {}
  for (const profile of (await readdir(join(home, 'profiles'))).sort()) {
    // Native DSH stores shared dependencies here; it is not a profile.
    if (profile === 'node_modules') continue
    if (!PROFILE.test(profile)) fail('unexpected profile directory')
    await trustedDirectory(join(home, 'profiles', profile))
    const dumped = spawnSync(dshPath, ['--profile', profile, '--dump-config'], {
      env: { ...process.env, DSH_HOME: home, NODE_OPTIONS: undefined, NODE_PATH: undefined },
      encoding: 'utf8', maxBuffer: 16_777_216, timeout: 60_000,
    })
    if (dumped.status !== 0) fail(`DSH rejected effective configuration for ${profile}`)
    result[profile] = dumped.stdout
  }
  return result
}
async function treeDigest(root, linkRoots = []) {
  const entries = []
  let size = 0
  const visit = async path => {
    const item = await lstat(path)
    if (entries.length > 200_000 || item.uid !== process.getuid()
      || !item.isSymbolicLink() && (item.mode & 0o022)) fail(`unsafe bound source resource: ${path}`)
    if (item.isDirectory()) {
      entries.push([relative(root, path), 'directory', item.mode & 0o777])
      for (const name of (await readdir(path)).sort()) await visit(join(path, name))
    } else if (item.isFile() && item.nlink === 1) {
      size += item.size
      if (size > 4_294_967_296) fail('bound source resource exceeds size limit')
      entries.push([relative(root, path), 'file', item.mode & 0o777, hash(await bytes(path))])
    } else if (item.isSymbolicLink() && item.nlink === 1) {
      const linkRoot = linkRoots.find(allowed => inside(allowed, path))
      const target = await readlink(path)
      if (!linkRoot || isAbsolute(target) || !inside(linkRoot, resolve(dirname(path), target))
        || !inside(linkRoot, await realpath(path))) fail(`unsafe native resource link: ${path}`)
      const after = await lstat(path)
      if (!after.isSymbolicLink() || !isDeepStrictEqual(
        [item.dev, item.ino, item.uid, item.mode, item.nlink, item.size, item.mtimeMs, item.ctimeMs],
        [after.dev, after.ino, after.uid, after.mode, after.nlink, after.size, after.mtimeMs, after.ctimeMs])) fail(`native resource link changed: ${path}`)
      entries.push([relative(root, path), 'link', target])
    } else fail(`bound source resource is not a physical file/directory: ${path}`)
  }
  await visit(root)
  return digest(entries)
}

/** Authenticate a real Home, including a renamed backup or staged candidate.
 * This never accepts a copied runtime's new inode. Configuration-composition
 * copies use a separate content-only operation and cannot produce this proof. */
export async function assertLocalSourceNativeResources(input) {
  const { homePath, profile, proof, selection: selected } = input
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(600_000)])
  signal.throwIfAborted()
  const physicalHome = input.physicalHome ?? homePath
  const backend = await localSourceResourceBackend({ homePath: physicalHome, profile })
  const expected = selected === undefined ? undefined : proof?.[selected]
  if (proof?.protocol === nativeProtocol && expected && backend !== expected.backend) fail('selected source resource backend changed')
  if (backend !== 'linux-native') return { backend }
  const api = await load(proof?.installer ?? input.installer)
  if (typeof api.inspectLinuxRsiNativeBaseAt !== 'function' || typeof api.freezeLinuxRuntimeSource !== 'function') {
    fail('reviewed installer cannot authenticate pre-owner native resources')
  }
  await assertHomeOwnerAbsence(physicalHome, profile)
  const sourceInput = { logicalHome: homePath, physicalHome, profile, signal }
  // After the original rename, the live pathname is absent. Only the journal's
  // original backup may authenticate against its already frozen source digest;
  // ordinary stage reads still compare to the live installation's Host anchor.
  const recoveringOriginal = proof?.protocol === nativeProtocol && selected === 'original' && expected
    && physicalHome === join(`${homePath}.dsh-enhanced-transaction`, 'original-home') && !await optional(homePath)
  if (recoveringOriginal && typeof api.readRsiSourceMaintenanceSnapshot !== 'function') {
    fail('reviewed installer cannot authenticate the frozen original source snapshot')
  }
  const live = recoveringOriginal
    ? await api.readRsiSourceMaintenanceSnapshot({ ...sourceInput, expectedStateDigest: expected.sourceDigest })
    : await api.readRsiSourceMaintenance(sourceInput)
  await assertPreOwnerAuthorityState(physicalHome, profile, live.records)
  const family = await api.inspectLinuxRsiNativeBaseAt({ logicalHome: homePath, physicalHome, profile, signal })
  const source = await api.freezeLinuxRuntimeSource({ kind: 'git-object',
    repository: join(physicalHome, 'rsi-sources', profile, 'checkout'),
    commit: live.workspace.sourceCommit, version: live.workspace.version, signal })
  const receipt = JSON.parse((await bytes(join(physicalHome, 'rsi-linux-runtimes', profile, 'bootstrap.json'), 4_194_304)).toString('utf8'))
  const manifests = Object.fromEntries(source.manifests.map(item => [item.path, hash(item.bytes)]))
  if (family.runtime.sourceCommit !== live.workspace.sourceCommit || family.release.sourceCommit !== live.workspace.sourceCommit
    || family.runtime.lockSha256 !== manifests['pnpm-lock.yaml'] || !isDeepStrictEqual(receipt.manifestHashes, manifests)) {
    fail('native runtime resources do not match the authenticated source')
  }
  if (proof?.protocol === nativeProtocol && selected === 'candidate') {
    if (!proof.nativeResources || typeof api.verifyLinuxRsiPreOwnerNativeResources !== 'function') fail('native candidate lacks its staged resource proof')
    if (proof.nativeResources.logicalHome !== homePath || proof.nativeResources.profile !== profile
      || proof.nativeResources.preparationDigest !== proof.preparationDigest
      || proof.nativeResources.originalBackend !== proof.original.backend) fail('native candidate resource proof binding changed')
    await api.verifyLinuxRsiPreOwnerNativeResources({ proof: proof.nativeResources, physicalHome, signal })
  }
  signal.throwIfAborted()
  return { backend, family }
}
async function assertHomeOwnerAbsence(home, profile) {
  for (const kind of ['rsi-authorities', 'rsi-coordinators']) {
    const path = join(home, kind)
    if (!await optional(path)) continue
    const names = await readdir(path)
    if (kind === 'rsi-coordinators' && names.length
      || kind === 'rsi-authorities' && names.some(name => name !== profile)) fail('other Home owner/coordinator authority is present')
  }
  for (const name of await readdir(home)) if (name.startsWith('.rsi-coordinator-') || name === '.rsi-setup-journal.json') fail('coordinator/owner setup residue is present')
}
export async function assertPreOwnerAuthorityState(physicalHome, profile, records) {
  const authority = join(physicalHome, 'rsi-authorities', profile)
  await trustedDirectory(authority)
  if (!isDeepStrictEqual((await readdir(authority)).sort(),
    ['bootstrap.json', 'catalog.json', 'config', 'identities', 'registry', 'state'])) fail('pre-owner authority layout changed')
  for (const name of ['config', 'state', 'registry']) {
    const directory = join(authority, name)
    await trustedDirectory(directory)
    if ((await readdir(directory)).length) fail(`pre-owner ${name} is not empty`)
  }
  const catalog = JSON.parse((await bytes(join(authority, 'catalog.json'), 2_097_152)).toString('utf8'))
  if (!isDeepStrictEqual(catalog, { schemaVersion: 1, entries: [] })) fail('pre-owner catalog is not empty')
  if (!Array.isArray(records) || records.some(record => record?.host !== null)) fail('pre-owner maintenance contains Host activation evidence')
}
async function selection(input, api, verifyPackages = true) {
  const { logicalHome, physicalHome = logicalHome, profile, dshPath } = input
  await assertHomeOwnerAbsence(physicalHome, profile)
  const live = await api.readRsiSourceMaintenance({ logicalHome, physicalHome, profile })
  await assertPreOwnerAuthorityState(physicalHome, profile, live.records)
  const backend = input.native === true ? await localSourceResourceBackend({ homePath: physicalHome, profile }) : 'docker'
  const resources = {}
  for (const kind of localSourceResourceKinds(backend)) {
    const root = join(physicalHome, kind, profile)
    const linkRoots = backend !== 'linux-native' ? [] : kind === 'rsi-linux-runtimes' ? [join(root, 'runtime')]
      : kind === 'rsi-release-builds' ? ['toolchain', 'store', 'cache'].map(name => join(root, name)) : []
    resources[kind] = await treeDigest(root, linkRoots)
  }
  const metadata = {}
  for (const name of ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
    metadata[name] = hash(await bytes(join(physicalHome, 'profiles', profile, name), 16_777_216))
  }
  const rawConfiguration = await assertLocalSourceRawPreflight({ homePath: logicalHome, physicalHome, profile, installer: input.installer, configurationOnly: true })
  const configs = input.configs ?? (await composeLocalSourceConfigs({ homePath: logicalHome, profile, dshPath, installer: input.installer })).configs
  const configDigests = assertPreOwnerEffectiveConfigs(configs, logicalHome, profile, api.yaml)
  if (verifyPackages) {
    if (physicalHome !== logicalHome) fail('package verification requires the lifecycle logical Home mapping')
    await api.assertRsiPreOwnerInstallation({ logicalHome, physicalHome, profile })
    const cohort = await api.readRsiLocalCohort({ dshHome: logicalHome, profile })
    await api.verifyRsiLocalInstalledPackages({ cohort, profilePath: join(logicalHome, 'profiles', profile), bundles: cohort.bundles })
  }
  return { mode: 'pre-owner', ...(input.native === true ? { backend } : {}), sourceDigest: digest({ anchor: live.anchor, records: live.records,
    workspace: live.workspace, originalBootstrapDigest: live.originalBootstrapDigest }), resources, metadata, configDigests, rawConfiguration }
}

export async function preflightLocalSourceMaintenance(input) {
  const installer = input.installer ?? await bindLocalSourceInstaller(input.installerRoot)
  const api = await load(installer)
  const configs = input.configs ?? (await composeLocalSourceConfigs({ ...input, installer })).configs
  const preparation = await api.readRsiLocalUpdateLocked({ dshHome: input.homePath, profile: input.profile, root: input.preparationRoot })
  const backend = localCandidateBuildBackend(preparation.build?.sourceBuild)
  if (backend === 'unknown') fail('prepared candidate has no supported build backend')
  const originalBackend = await localSourceResourceBackend(input)
  if (originalBackend === 'linux-native' && backend !== 'linux-native') fail('native pre-owner resources cannot downgrade to Docker')
  const native = backend === 'linux-native'
  if (native) await assertLocalSourceNativeResources({ ...input, installer })
  const original = await selection({ ...input, configs, logicalHome: input.homePath, installer, native }, api)
  const extension = preparation.extension
  if (extension !== undefined && extension !== 'memory-learning') fail('unsupported prepared root extension')
  const initialRow = extension ? await memoryLearnerInitialRow(installer) : undefined
  return { protocol: native ? nativeProtocol : extension ? 'dsh-enhanced/pre-owner-source-maintenance/v2' : 'dsh-enhanced/pre-owner-source-maintenance/v1',
    ...(native ? { candidateBackend: 'linux-native', nativeResources: null } : {}),
    ...(extension ? { extension, expectedCandidateSemanticDigest: expectedMemoryLearningSemanticDigest(
      configs[input.profile], api.yaml, initialRow) } : {}),
    installer, preparationRoot: input.preparationRoot, preparationDigest: preparation.receiptDigest, original, candidate: null }
}
async function preparedCandidate(input) {
  const api = await load(input.proof.installer)
  const preparation = await api.readRsiLocalUpdateLocked({ dshHome: input.homePath, profile: input.profile, root: input.proof.preparationRoot })
  if (preparation.receiptDigest !== input.proof.preparationDigest
    || preparation.extension !== input.proof.extension) fail('prepared candidate changed')
  if (input.proof.protocol === nativeProtocol && localCandidateBuildBackend(preparation.build?.sourceBuild) !== 'linux-native') {
    fail('prepared native candidate backend changed')
  }
  await assertLocalSourceInstaller(input.proof.installer)
  return { api, preparation }
}

/** Revalidate the external preparation immediately before the caller's stop
 * boundary. The reviewed reader checks its complete source/archive identities;
 * this adds no authority and does not stage or install anything. */
export async function assertLocalSourcePreparedCandidate(input) {
  return (await preparedCandidate(input)).preparation
}

export async function prepareLocalSourceStage(input) {
  const { api, preparation } = await preparedCandidate(input)
  const live = await api.readRsiSourceMaintenance({ logicalHome: input.homePath, physicalHome: input.homePath, profile: input.profile })
  const originalCohort = await api.readRsiLocalCohort({ dshHome: input.homePath, profile: input.profile })
  const native = input.proof.protocol === nativeProtocol
  const stage = native ? api.stageLinuxRsiPreOwnerNativeResources : api.stageRsiLocalUpdateResources
  if (typeof stage !== 'function') fail('reviewed installer cannot stage the selected pre-owner backend')
  const resource = await stage({ logicalHome: input.homePath, stagePhysicalHome: input.stageHome,
    profile: input.profile, preparationRoot: input.proof.preparationRoot })
  if (native && resource.proof.originalBackend !== input.proof.original.backend) fail('original native transition backend changed')
  const record = await api.produceRsiLocalSourceMaintenance({ logicalHome: input.homePath, profile: input.profile,
    preparation, stagePhysicalHome: input.stageHome, live, nextCohort: resource.cohort, maintenanceMode: 'pre-owner' })
  await api.applyRsiSourceMaintenanceInStage({ logicalHome: input.homePath, physicalHome: input.stageHome, profile: input.profile,
    sourceRepository: originalCohort.sourceRepository, candidateRoot: preparation.source.root, records: [...live.records, record] })
  return { originalCohort, record, resources: resource.proof }
}
export async function replaceLocalSourceAuthority(input) {
  const api = await load(input.proof.installer)
  const require = createRequire(join(input.stageHome, 'profiles', input.profile, 'package.json'))
  const packageRoot = dirname(require.resolve('@dsh-enhanced/plugin-control-plane/package.json'))
  await api.replaceRsiAuthorityRuntimeInStage({ logicalHome: input.homePath, physicalHome: input.stageHome, profile: input.profile },
    { packageRoot: await realpath(packageRoot), nodePath: await realpath(process.execPath) })
}
export async function verifyLocalSourceSelection(input) {
  const api = await load(input.proof.installer)
  if (input.proof.protocol === nativeProtocol) await assertLocalSourceNativeResources(input)
  return verifySelectionContent(input, api)
}
async function verifySelectionContent(input, api) {
  const configs = input.configs ?? (await composeLocalSourceConfigs(input)).configs
  const selected = await selection({ logicalHome: input.homePath, physicalHome: input.physicalHome, profile: input.profile,
    dshPath: input.dshPath, installer: input.proof.installer, configs, native: input.proof.protocol === nativeProtocol }, api, input.physicalHome === undefined)
  const expected = input.proof[input.selection]
  if (expected && !isDeepStrictEqual(selected, expected)) fail(`${input.selection} source/resource/config identity changed`)
  if (input.selection === 'candidate' && selected.resources['rsi-authorities'] !== input.proof.original.resources['rsi-authorities']) {
    fail('pre-owner authority resources changed during local source update')
  }
  if (input.proof.extension === 'memory-learning' && input.selection === 'candidate') {
    assertMemoryLearningCandidateConfigs({ configs, original: input.proof.original, targetProfile: input.profile,
      expectedCandidateSemanticDigest: input.proof.expectedCandidateSemanticDigest }, api.yaml,
    await memoryLearnerInitialRow(input.proof.installer))
  }
  return selected
}

/** A configuration-composition copy is not a runtime identity proof. It may
 * only compare to an already frozen selection; it never returns a selection
 * that the transaction could adopt as its candidate. */
export async function verifyLocalSourceComposition(input) {
  if (input.proof?.protocol !== nativeProtocol || !['original', 'candidate'].includes(input.selection)
    || !input.proof[input.selection]) fail('composition requires a frozen native maintenance selection')
  const api = await load(input.proof.installer)
  await verifySelectionContent(input, api)
  return { verified: true }
}
export async function localSourcePreviewOverlay(input) {
  const api = await load(input.proof.installer)
  const { configs } = await composeLocalSourceConfigs(input)
  assertPreOwnerEffectiveConfigs(configs, input.homePath, input.profile, api.yaml)
  return buildLocalSourcePreviewOverlay(configs[input.profile], api.yaml)
}
export async function assertLocalSourcePreview(input) {
  const api = await load(input.proof.installer)
  const dumped = spawnSync(input.dshPath, ['--profile', input.profile, '--patch', input.overlayPath, '--dump-config'], {
    env: { ...process.env, DSH_HOME: input.homePath }, encoding: 'utf8', maxBuffer: 16_777_216, timeout: 60_000,
  })
  if (dumped.status !== 0) fail('DSH rejected local source preview overlay')
  const { configs } = await composeLocalSourceConfigs(input)
  assertLocalSourcePreviewDerivation({ persistedConfig: configs[input.profile], previewConfig: dumped.stdout }, api.yaml)
  return { persistedConfigDigest: hash(configs[input.profile]), previewConfigDigest: hash(dumped.stdout) }
}

export async function healLocalSourceProfileModuleFallback({ homePath, profile, dsh }) {
  if (!exactPath(homePath) || !PROFILE.test(profile) || !exactPath(dsh?.path)
    || dsh.pin?.path !== dsh.path || dsh.pin?.sha256 !== hash(await bytes(dsh.path))) {
    fail('pinned DSH executable changed before module fallback healing')
  }
  if (await realpath(homePath) !== homePath || await realpath(dsh.path) !== dsh.path
    || inside(homePath, dsh.path)) fail('pinned DSH executable is inside the stopped Home')
  const hostRequire = createRequire(dsh.path)
  const dshManifestPath = await realpath(hostRequire.resolve('@deepseek-ai/dsh/package.json'))
  const dshManifest = JSON.parse((await bytes(dshManifestPath, 1_048_576)).toString('utf8'))
  const dshRoot = dirname(dshManifestPath)
  if (inside(homePath, dshRoot)) fail('pinned DSH package is inside the stopped Home')
  const bin = dshManifest.bin?.dsh
  if (dshManifest.name !== '@deepseek-ai/dsh' || typeof dshManifest.version !== 'string'
    || typeof bin !== 'string' || !/^(?:\.\/)?[A-Za-z0-9._/-]+$/u.test(bin)
    || bin.replace(/^\.\//u, '').split('/').some(part => !part || part === '.' || part === '..')
    || !inside(dshRoot, resolve(dshRoot, bin))
    || (await realpath(join(dshRoot, bin))) !== dsh.path) fail('pinned DSH package does not own its executable')
  const packageRequire = createRequire(dshManifestPath)
  const bootManifestPath = await realpath(packageRequire.resolve('@deepseek-ai/dsh-app-boot/package.json'))
  const bootManifest = JSON.parse((await bytes(bootManifestPath, 1_048_576)).toString('utf8'))
  const bootPath = await realpath(packageRequire.resolve('@deepseek-ai/dsh-app-boot'))
  if (inside(homePath, dirname(bootManifestPath)) || inside(homePath, bootPath)) {
    fail('pinned DSH boot module is inside the stopped Home')
  }
  if (bootManifest.name !== '@deepseek-ai/dsh-app-boot' || bootManifest.version !== dshManifest.version
    || !inside(dirname(bootManifestPath), bootPath)) fail('pinned DSH boot module identity differs')
  const { loadProfileDirectory, healProfilesModuleFallback, createRuntimeResolution } = await import(pathToFileURL(bootPath).href)
  if (typeof loadProfileDirectory !== 'function') {
    fail(['0.2.0-rc.2', '0.2.1-rc.2'].includes(dshManifest.version) ? 'pinned DSH boot module lacks native profile loading API'
      : 'pinned DSH boot module lacks native fallback healing APIs')
  }
  const loaded = loadProfileDirectory('dsh', join(homePath, 'profiles', profile), dshManifestPath)
  if (['0.2.0-rc.2', '0.2.1-rc.2'].includes(dshManifest.version)) {
    if (typeof createRuntimeResolution !== 'function' || loaded.skippedBundles?.length) {
      fail('pinned DSH boot module cannot resolve the complete profile')
    }
    const resolution = await createRuntimeResolution({ installAnchor: dshManifestPath, profile: loaded, home: homePath })
    if (!resolution.entries?.some(entry => entry.name === '@deepseek-ai/cordis' && entry.scope === 'installation')) {
      fail('pinned DSH boot module did not resolve Host Cordis')
    }
    return
  }
  if (typeof healProfilesModuleFallback !== 'function') fail('pinned DSH boot module lacks native fallback healing APIs')
  await healProfilesModuleFallback({ installAnchor: dshManifestPath, profile: loaded, home: homePath })
}

async function candidateContext(input) {
  if (!exactPath(input.homePath) || !PROFILE.test(input.profile)) fail('invalid candidate profile identity')
  await trustedDirectory(input.homePath)
  const profilePath = join(input.homePath, 'profiles', input.profile)
  await trustedDirectory(profilePath)
  const installer = input.proof?.installer ?? input.installer
  const api = await load(installer)
  const projection = await import(pathToFileURL(join(installer.root, 'plugins/lark-channel/lib/rsi-local-profile-update.js')).href)
  const cohort = await api.readRsiLocalCohort({ dshHome: input.homePath, profile: input.profile })
  const workspacePath = join(profilePath, 'pnpm-workspace.yaml')
  if (await realpath(workspacePath) !== workspacePath) fail('candidate workspace is not physical')
  const workspace = (await bytes(workspacePath, 2_097_152)).toString('utf8')
  return { installer, api, projection, cohort, profilePath, workspace }
}

/** Read-only plan using the old installed manifests inside the caller's mapped
 * disposable preview. Does not grant permission to stop or mutate a live Home. */
export async function planLocalSourceCandidatePackages(input) {
  const { installer, api, projection, cohort, profilePath, workspace } = await candidateContext(input)
  const manifestPath = join(profilePath, 'package.json')
  if (await realpath(manifestPath) !== manifestPath) fail('candidate profile manifest is not physical')
  const manifest = await bytes(manifestPath, 2_097_152)
  // Stage uses original cohort roots, not the Host's external base bundle. The
  // shared assertion checks native dsh.profile.bundles and dependency locators.
  const bundles = [...input.originalCohort.bundles]
  projection.assertRsiLocalProfileRoots({ source: manifest.toString('utf8'), cohort: input.originalCohort, bundles })
  const plan = await api.planRsiLocalProfilePackages({ source: workspace, original: input.originalCohort,
    candidate: cohort, bundles, originalProfilePath: profilePath,
    ...(input.proof?.extension !== undefined ? { rootExtension: input.proof.extension } : {}) })
  if (!isDeepStrictEqual(await api.readRsiLocalCohort({ dshHome: input.homePath, profile: input.profile }), cohort)
    || !(await bytes(manifestPath, 2_097_152)).equals(manifest)
    || (await bytes(join(profilePath, 'pnpm-workspace.yaml'), 2_097_152)).toString('utf8') !== workspace) fail('candidate planning input changed')
  await assertLocalSourceInstaller(installer)
  return { ...plan, cohort }
}

function candidateYaml(source, yaml) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 2_097_152) fail('invalid candidate YAML source')
  const document = yaml.parseDocument(source, { uniqueKeys: true })
  if (document.errors.length || document.warnings.length || !yaml.isMap(document.contents)) fail('candidate YAML must be a strict mapping')
  yaml.visit(document, {
    Alias() { fail('candidate YAML aliases are forbidden') },
    Map(_key, node) {
      for (const pair of node.items) if (!yaml.isScalar(pair.key) || typeof pair.key.value !== 'string') fail('candidate YAML keys must be strings')
    },
  })
  const result = document.toJS({ maxAliasCount: 0 })
  const check = value => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean'
      || typeof value === 'number' && Number.isFinite(value)) return
    if (Array.isArray(value)) { for (const item of value) check(item); return }
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail('candidate YAML is not plain JSON data')
    for (const [key, item] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') fail('candidate YAML contains unsafe keys')
      check(item)
    }
  }
  check(result)
  return result
}

/** Uses only the parser from the already byte-bound installer. */
export async function parseLocalSourceCandidateYaml({ installer, source }) {
  const api = await load(installer)
  const result = candidateYaml(source, api.yaml)
  await assertLocalSourceInstaller(installer)
  return result
}

/** Native package-only installation into a fresh disposable profile. The caller
 * owns its namespace, network/cache policy and lifecycle lock. No Host starts. */
export async function installLocalSourceCandidatePackages(input) {
  const { installer, api, projection, cohort, profilePath, workspace } = await candidateContext(input)
  const plan = input.plan
  if (!plan || !isDeepStrictEqual(Object.keys(plan).sort(), ['bundles', 'cohort', 'tarballs', 'workspace'])
    || !isDeepStrictEqual(plan.cohort, cohort) || plan.workspace !== workspace
    || !Array.isArray(plan.bundles) || !plan.bundles.length || new Set(plan.bundles).size !== plan.bundles.length
    || !isDeepStrictEqual(plan.bundles, cohort.bundles)) fail('candidate package plan changed')
  const tarballs = plan.bundles.map(slug => {
    const item = cohort.packages.find(pkg => pkg.name === `@dsh-enhanced/${slug}` && pkg.bundle)
    if (!item) fail('candidate bundle is outside cohort')
    return item.tarball
  })
  if (!isDeepStrictEqual(plan.tarballs, tarballs)) fail('candidate tarball plan changed')
  const parsed = candidateYaml(workspace, api.yaml)
  const peers = await api.rsiLocalPeerOverrides({ cohort, bundles: plan.bundles })
  const expected = { ...api.rsiLocalDependencyOverrides(cohort, plan.bundles), ...peers }
  if (parsed.nodeLinker !== 'isolated'
    || !parsed.overrides || typeof parsed.overrides !== 'object' || Array.isArray(parsed.overrides)) fail('candidate workspace policy changed')
  for (const [key, value] of Object.entries(expected)) if (parsed.overrides[key] !== value) fail('candidate workspace override changed')
  for (const key of Object.keys(parsed.overrides)) if (key.includes('@dsh-enhanced/') && !Object.hasOwn(expected, key)) fail('candidate workspace has unexpected internal override')
  if (api.mergeRsiLocalOverrides(workspace, expected, cohort.allowBuilds) !== workspace) fail('candidate workspace projection changed')
  const manifestPath = join(profilePath, 'package.json')
  if (await realpath(manifestPath) !== manifestPath) fail('candidate profile manifest is not physical')
  const manifest = await bytes(manifestPath, 2_097_152)
  let validationSource = manifest.toString('utf8')
  const warm = JSON.parse(validationSource)
  const mounted = warm?.dsh?.profile?.bundles
  if (input.proof?.extension === 'memory-learning' && plan.bundles.includes('assistant-memory-learning')
    && Array.isArray(mounted) && !mounted.includes(learnerName)) {
    // Validation-only detached view: pnpm warmup has added the dependency, but
    // only the real DSH plugin add may write the new mounted bundle metadata.
    // The shared full-root check still verifies every locator and other root.
    mounted.push(learnerName)
    validationSource = JSON.stringify(warm)
  }
  projection.assertRsiLocalProfileRoots({ source: validationSource, cohort, bundles: plan.bundles })
  const modulesPath = join(profilePath, 'node_modules')
  if (await optional(modulesPath)) fail('candidate profile already has node_modules')
  await assertLocalSourceInstaller(installer)
  input.signal?.throwIfAborted()
  // Recheck immediately before the native installer, after the asynchronous
  // binding validation. Its own inventory/pin/workspace checks remain intact.
  if (await optional(modulesPath) || (await bytes(join(profilePath, 'pnpm-workspace.yaml'), 2_097_152)).toString('utf8') !== workspace
    || !isDeepStrictEqual(await api.readRsiLocalCohort({ dshHome: input.homePath, profile: input.profile }), cohort)
    || !(await bytes(manifestPath, 2_097_152)).equals(manifest)) fail('candidate install input changed')
  await api.installRsiLocalProfile({ dshHome: input.homePath, profile: input.profile, cohort,
    bundles: [...plan.bundles], dsh: input.dsh, signal: input.signal ?? AbortSignal.timeout(600_000), initializeFromManifest: true })
  if (await realpath(manifestPath) !== manifestPath) fail('candidate profile manifest is not physical')
  // Never use the warmup view as completion evidence. The real CLI must have
  // persisted the complete candidate mount list itself.
  projection.assertRsiLocalProfileRoots({ source: (await bytes(manifestPath, 2_097_152)).toString('utf8'), cohort, bundles: plan.bundles })
  await assertLocalSourceInstaller(installer)
  return { cohortDigest: cohort.receiptDigest, bundles: [...plan.bundles], tarballs }
}

async function main() {
  const [action, inputPath] = process.argv.slice(2)
  const input = JSON.parse((await bytes(inputPath, 20_971_520)).toString('utf8'))
  let result
  if (action === 'packages') {
    const api = await load(input.proof.installer)
    result = await api.stageRsiLocalSinglePackages({ dshHome: input.homePath, profile: input.profile,
      originalCohort: input.originalCohort, dsh: input.dsh, rootExtension: input.proof.extension,
      signal: AbortSignal.timeout(600_000) })
    await healLocalSourceProfileModuleFallback(input)
  } else if (action === 'candidate-plan') result = await planLocalSourceCandidatePackages(input)
  else if (action === 'candidate-install') result = await installLocalSourceCandidatePackages(input)
  else if (action === 'configs') result = await composeLocalSourceConfigs(input)
  else if (action === 'verify') result = await verifyLocalSourceSelection(input)
  else if (action === 'verify-composition') result = await verifyLocalSourceComposition(input)
  else if (action === 'preview-overlay') result = await localSourcePreviewOverlay(input)
  else if (action === 'assert-preview') result = await assertLocalSourcePreview(input)
  else fail('unknown sandbox operation')
  process.stdout.write(JSON.stringify(result))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
