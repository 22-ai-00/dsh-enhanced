import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'
import { assertLifecycleNpmMetadataSafe } from './lifecycle-config.mjs'
import { loadLocalSourceInstaller } from './local-source-maintenance.mjs'
import { prepareHostLocalSharedFallback, retireHostLocalSharedFallback,
  verifyRetiredHostLocalSharedFallback } from './host-local-fallback.mjs'
import { verifyHostLegacySettingsImport } from './host-legacy-settings.mjs'
import { nativeAuthority, inventory, readMetadata, writeMetadata, pnpmEnvironment, oldHostLinks,
  localCohortPins, sourceDigest, metadataNames, nativeName, snapshotName, assertPeerBindings } from './host-profile-update.mjs'

const enhancedName = /^@dsh-enhanced\/[a-z0-9][a-z0-9._-]*$/u
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const inside = (root, path) => path === root || path.startsWith(root + sep)
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = message => { throw new Error(`Joint Host profile update: ${message}`) }
const same = isDeepStrictEqual

function parser(dshPath) {
  try { return createRequire(dshPath)('yaml') } catch { fail('candidate Host has no YAML parser') }
}
function parse(yaml, source, label) {
  if (typeof source !== 'string') fail(`missing ${label}`)
  const document = yaml.parseDocument(source, { uniqueKeys: true, strict: true })
  if (document.errors.length || document.warnings.length || /(^|\s)[&*][a-z0-9_-]+/iu.test(source)) fail(`invalid ${label}`)
  return document.toJS({ maxAliasCount: 0 })
}
function normalizeLock(yaml, source, preparedPath, logicalProfilePath, home) {
  const cohortRoot = join(home, 'rsi-local-cohorts')
  const visit = value => {
    if (typeof value === 'string') return value.replace(/file:(?!\/)(\.\.?\/[^()>\s]+)/gu, (_whole, locator) => {
      const target = resolve(preparedPath, locator)
      if (inside(cohortRoot, target)) return `file:${relative(logicalProfilePath, target).split(sep).join('/')}`
      if (inside(cohortRoot, resolve(logicalProfilePath, locator))) return `file:${locator}`
      fail(`resolved file locator escaped candidate cohort: ${locator}`)
    })
    if (Array.isArray(value)) return value.map(visit)
    if (!plain(value)) return value
    const result = {}
    for (const [key, item] of Object.entries(value)) {
      const rewritten = visit(key)
      if (Object.hasOwn(result, rewritten)) fail(`resolved lockfile locator collided: ${rewritten}`)
      result[rewritten] = visit(item)
    }
    return result
  }
  return yaml.stringify(visit(parse(yaml, source, 'resolved lockfile')))
}
async function directory(path, privateMode = false) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) fail(`non-canonical directory: ${path}`)
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink() || privateMode && (entry.uid !== process.getuid() || entry.mode & 0o077)) fail(`unsafe directory: ${path}`)
  return path
}
async function pinnedFile(path, maximum = 268_435_456) {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid()
    || before.mode & 0o022 || before.size > maximum) fail(`unsafe artifact: ${path}`)
  const bytes = await readFile(path), after = await lstat(path)
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) fail(`artifact changed: ${path}`)
  return bytes
}
function roots(metadata) {
  const manifest = JSON.parse(metadata['package.json'])
  const dependencies = {}
  for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
    if (manifest[field] !== undefined && !plain(manifest[field])) fail(`invalid manifest ${field}`)
    for (const [name, value] of Object.entries(manifest[field] || {})) {
      if ((!nativeName.test(name) && !enhancedName.test(name)) || typeof value !== 'string') fail(`unapproved root dependency: ${name}`)
      if (dependencies[name] !== undefined) fail(`duplicate root dependency: ${name}`)
      dependencies[name] = value
    }
  }
  return { manifest, dependencies }
}
function projectPnpmPackageManager(metadata) {
  const manifest = JSON.parse(metadata['package.json'])
  if (!plain(manifest)) fail('invalid profile manifest')
  if (!Object.hasOwn(manifest, 'packageManager')) return metadata
  if (manifest.packageManager !== 'pnpm@11.7.0') fail('unsupported package manager selector')
  delete manifest.packageManager
  return { ...metadata, 'package.json': `${JSON.stringify(manifest, null, 2)}\n` }
}
function assertFallbackDelta(original, prepared) {
  const expected = projectPnpmPackageManager(original)
  for (const name of metadataNames) if (prepared[name] !== expected[name]) {
    fail(`unexpected dependency-free prepared metadata: ${name}`)
  }
}
function assertEmptyLockGraph(metadata, yaml) {
  const lock = parse(yaml, metadata['pnpm-lock.yaml'], 'dependency-free lockfile')
  if (!plain(lock) || !plain(lock.importers) || !same(Object.keys(lock.importers), ['.'])
    || !plain(lock.importers['.']) || Object.values(lock.importers['.']).some(value => !plain(value) || Object.keys(value).length)
    || lock.packages !== undefined && (!plain(lock.packages) || Object.keys(lock.packages).length)
    || lock.snapshots !== undefined && (!plain(lock.snapshots) || Object.keys(lock.snapshots).length)) {
    fail('dependency-free profile has a nonempty lock graph')
  }
}
async function assertEmptyInstalledGraph(profilePath, logicalProfilePath, profileName, yaml) {
  const modules = join(profilePath, 'node_modules')
  const root = await lstat(modules).catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
  if (root === undefined) return
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid() || root.mode & 0o022
    || await realpath(modules) !== modules) fail('dependency-free profile has an unsafe installed graph')
  for (const name of await readdir(modules)) {
    const path = join(modules, name), entry = await lstat(path)
    if (name === '.pnpm' || name === '.bin') {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid() || entry.mode & 0o022
        || await realpath(path) !== path || (await readdir(path)).length) fail('dependency-free profile has an installed graph')
    } else if (name === '.modules.yaml') {
      const state = parse(yaml, (await pinnedFile(path, 1_048_576)).toString('utf8'), 'dependency-free modules metadata')
      if (!plain(state) || ['hoistedDependencies', 'hoistedLocations', 'injectedDeps', 'pendingBuilds', 'skipped', 'ignoredBuilds']
        .some(field => state[field] !== undefined && (!plain(state[field]) && !Array.isArray(state[field])
          || Object.keys(state[field]).length))) fail('dependency-free profile has an installed graph')
    } else if (name === '.pnpm-workspace-state-v1.json') {
      const state = JSON.parse((await pinnedFile(path, 1_048_576)).toString('utf8'))
      const projects = state?.projects
      if (!plain(state) || !same(Object.keys(state).sort(), ['filteredInstall', 'lastValidatedTimestamp',
        'pnpmfiles', 'projects', 'settings'].sort()) || state.filteredInstall !== false
        || !Number.isSafeInteger(state.lastValidatedTimestamp) || state.lastValidatedTimestamp < 0
        || !same(state.pnpmfiles, []) || !plain(projects)
        || !same(Object.keys(projects).sort(), [logicalProfilePath])
        || !same(projects[logicalProfilePath], { name: profileName }) || !plain(state.settings)
        || !same(state.settings.catalogs, {}) || !same(state.settings.workspacePackagePatterns, ['.'])
        || state.settings.linkWorkspacePackages !== false) fail('dependency-free profile has an installed graph')
    } else fail('dependency-free profile has an installed graph')
  }
}
function artifactLocator(home, name, artifact) {
  const slug = name.slice('@dsh-enhanced/'.length)
  if (typeof artifact?.tarball !== 'string' || !/^rsi-local-cohorts\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/artifacts\/[a-z0-9][a-z0-9._-]*\.tgz$/u.test(relative(home, artifact.tarball).split(sep).join('/'))
    || !isAbsolute(artifact.tarball) || resolve(artifact.tarball) !== artifact.tarball
    || !inside(join(home, 'rsi-local-cohorts'), artifact.tarball)
    || !artifact.tarball.endsWith(`/artifacts/${slug}.tgz`)) fail(`invalid artifact destination: ${name}`)
  return `file:${artifact.tarball}`
}
async function artifacts(input, home, candidateHome) {
  if (!plain(input) || !Object.keys(input).length) fail('verified candidate artifacts are required')
  const result = {}
  for (const [name, value] of Object.entries(input)) {
    if (!enhancedName.test(name) || !plain(value) || !/^[a-f0-9]{64}$/u.test(value.sha256 || '')
      || typeof value.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(value.version)
      || !Array.isArray(value.files) || !value.files.length || !Array.isArray(value.runtimeDependencies)
      || value.runtimeDependencies.some(dep => !enhancedName.test(dep))) fail(`invalid verified artifact record: ${name}`)
    artifactLocator(home, name, value)
    const expectedSource = join(candidateHome, relative(home, value.tarball))
    if (value.sourcePath !== expectedSource || !inside(candidateHome, expectedSource)
      || await realpath(expectedSource) !== expectedSource
      || digest(await pinnedFile(expectedSource)) !== value.sha256) fail(`candidate artifact bytes differ: ${name}`)
    const files = new Set()
    for (const file of value.files) {
      if (!plain(file) || typeof file.path !== 'string' || !file.path || file.path.startsWith('/')
        || file.path.split('/').some(part => !part || part === '.' || part === '..') || files.has(file.path)
        || !/^[a-f0-9]{64}$/u.test(file.sha256 || '') || !Number.isInteger(file.mode)
        || file.mode < 0 || file.mode > 0o777) fail(`invalid artifact file inventory: ${name}`)
      files.add(file.path)
    }
    if (!files.has('package.json')) fail(`artifact manifest is absent: ${name}`)
    result[name] = { ...value }
  }
  return result
}
async function selectedPeers(metadata, candidateArtifacts, readArtifactManifest) {
  const selected = Object.keys(roots(metadata).dependencies).filter(name => enhancedName.test(name))
  const pending = [...selected], closure = new Map()
  while (pending.length) {
    const name = pending.shift()
    if (closure.has(name)) continue
    const artifact = candidateArtifacts[name]
    if (!artifact) fail(`candidate artifact missing for runtime closure: ${name}`)
    closure.set(name, artifact)
    pending.push(...artifact.runtimeDependencies)
    if (closure.size > 128) fail('profile runtime closure exceeds bound')
  }
  const overrides = {}, peerProviders = {}
  for (const [parent, artifact] of closure) {
    const manifest = await readArtifactManifest({ name: parent, version: artifact.version,
      tarball: artifact.sourcePath, sha256: artifact.sha256, files: artifact.files,
      runtimeDependencies: artifact.runtimeDependencies })
    if (!plain(manifest) || !plain(manifest.peerDependencies)) fail(`invalid verified peer manifest: ${parent}`)
    peerProviders[parent] = []
    for (const name of Object.keys(manifest.peerDependencies)) {
      if (!enhancedName.test(name) || !closure.has(name)) continue
      peerProviders[parent].push(name)
      overrides[`${parent}@${artifact.version}>${name}`] = `file:${closure.get(name).tarball}`
    }
  }
  return { names: [...closure.keys()].sort(), overrides, peerProviders }
}
function derive(metadata, home, native, candidateArtifacts, yaml, peerOverrides = {}) {
  const normalized = projectPnpmPackageManager(metadata)
  const original = roots(normalized), manifest = structuredClone(original.manifest)
  if (Object.keys(original.dependencies).length === 0) return { ...normalized }
  for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
    for (const name of Object.keys(manifest[field] || {})) {
      if (nativeName.test(name)) manifest[field][name] = native[name]?.version ?? fail(`candidate Host lacks root: ${name}`)
      else manifest[field][name] = artifactLocator(home, name, candidateArtifacts[name] ?? fail(`candidate artifact missing for root: ${name}`))
    }
  }
  const workspace = parse(yaml, normalized['pnpm-workspace.yaml'], 'workspace')
  if (!plain(workspace) || !plain(workspace.overrides || {})
    || ![undefined, 'hoisted', 'isolated'].includes(workspace.nodeLinker)) fail('unsupported workspace layout')
  const overrides = {}
  for (const [key, value] of Object.entries(workspace.overrides || {})) {
    const match = /^(@[^/]+\/[^@]+|[^@]+)@[^>]+>(@[^/]+\/[a-z0-9._-]+)$/.exec(key)
    if (!match || typeof value !== 'string') fail(`unsupported override: ${key}`)
    const parent = match[1], dependency = match[2]
    if (!enhancedName.test(parent) && !nativeName.test(parent)) fail(`unapproved override parent: ${key}`)
    const target = enhancedName.test(dependency)
      ? artifactLocator(home, dependency, candidateArtifacts[dependency] ?? fail(`candidate artifact missing for override: ${dependency}`))
      : native[dependency]?.version ?? fail(`candidate Host lacks override: ${dependency}`)
    const parentVersion = enhancedName.test(parent)
      ? candidateArtifacts[parent]?.version ?? fail(`candidate artifact missing for override parent: ${parent}`)
      : native[parent]?.version ?? fail(`candidate Host lacks override parent: ${parent}`)
    overrides[`${parent}@${parentVersion}>${dependency}`] = target
  }
  for (const [parent, artifact] of Object.entries(candidateArtifacts)) for (const dependency of artifact.runtimeDependencies) {
    overrides[`${parent}@${artifact.version}>${dependency}`] = artifactLocator(home, dependency,
      candidateArtifacts[dependency] ?? fail(`candidate artifact missing for runtime edge: ${dependency}`))
  }
  Object.assign(overrides, peerOverrides)
  for (const [parent, info] of Object.entries(native)) for (const dependency of Object.keys(info.dependencies)) {
    overrides[`${parent}@${info.version}>${dependency}`] = native[dependency]?.version ?? fail(`candidate Host lacks native edge: ${dependency}`)
  }
  workspace.overrides = overrides
  workspace.nodeLinker = 'isolated'
  return { ...normalized, 'package.json': `${JSON.stringify(manifest, null, 2)}\n`, 'pnpm-workspace.yaml': yaml.stringify(workspace) }
}
function assertDelta(original, prepared, native, candidateArtifacts, home, yaml, peerScope) {
  const eligible = new Set(peerScope.names)
  const assertArtifactReference = (name, reference, label) => {
    if (!eligible.has(name)) fail(`enhanced package outside selected closure: ${label}`)
    const path = /^file:([^()\s]+)/u.exec(reference)?.[1]
    if (!path || resolve(join(home, 'profiles', '__profile__'), path) !== candidateArtifacts[name]?.tarball) fail(`enhanced artifact reference differs: ${label}`)
  }
  const assertCandidatePeers = (reference, label) => {
    assertPeerBindings(reference, native)
    for (const match of reference.matchAll(/@dsh-enhanced\/([a-z0-9._-]+)@([0-9][A-Za-z0-9._+-]*)/gu)) {
      const name = `@dsh-enhanced/${match[1]}`
      if (!eligible.has(name) || candidateArtifacts[name]?.version !== match[2]) fail(`enhanced peer context differs: ${label}`)
    }
  }
  if (original['cordis.patch.yml'] !== prepared['cordis.patch.yml']) fail('raw Cordis patch changed')
  const expected = derive(original, home, native, candidateArtifacts, yaml, peerScope.overrides)
  for (const name of ['package.json', 'pnpm-workspace.yaml']) {
    const before = name === 'package.json' ? JSON.parse(expected[name]) : parse(yaml, expected[name], name)
    const after = name === 'package.json' ? JSON.parse(prepared[name]) : parse(yaml, prepared[name], name)
    if (!same(before, after)) fail(`unexpected prepared ${name}`)
  }
  const oldLock = parse(yaml, original['pnpm-lock.yaml'], 'original lockfile')
  const lock = parse(yaml, prepared['pnpm-lock.yaml'], 'prepared lockfile')
  if (!plain(lock) || lock.lockfileVersion !== oldLock.lockfileVersion || !plain(lock.importers)
    || !same(Object.keys(lock.importers).sort(), Object.keys(oldLock.importers).sort())
    || !same(lock.settings, oldLock.settings) || !same(lock.overrides || {}, parse(yaml, expected['pnpm-workspace.yaml'], 'workspace').overrides)) fail('prepared lockfile structure differs')
  for (const key of Object.keys(lock)) if (!['lockfileVersion', 'settings', 'overrides', 'importers', 'packages', 'snapshots'].includes(key)
    && !same(lock[key], oldLock[key])) fail(`lockfile field changed: ${key}`)
  const manifest = JSON.parse(expected['package.json'])
  const declared = Object.assign({}, manifest.dependencies, manifest.optionalDependencies, manifest.devDependencies)
  for (const [name, record] of Object.entries(lock.importers)) {
    if (name !== '.' && !same(record, oldLock.importers[name])) fail(`secondary importer changed: ${name}`)
    if (name !== '.') continue
    for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
      const actual = record[field] || {}, before = oldLock.importers['.'][field] || {}, expectedRoots = manifest[field] || {}
      if (!same(Object.keys(actual).sort(), Object.keys(before).sort())) fail(`importer root inventory changed: ${field}`)
      for (const [root, ref] of Object.entries(actual)) {
        if (!plain(ref) || ref.specifier !== expectedRoots[root] || typeof ref.version !== 'string') fail(`importer root changed: ${root}`)
        assertCandidatePeers(ref.version, root)
        if (nativeName.test(root) && ref.version !== native[root]?.version
          && !ref.version.startsWith(`${native[root]?.version}(`)) fail(`native importer differs: ${root}`)
        if (enhancedName.test(root)) assertArtifactReference(root, ref.version, root)
      }
    }
    for (const field of Object.keys(record)) if (!['dependencies', 'optionalDependencies', 'devDependencies'].includes(field)
      && !same(record[field], oldLock.importers['.'][field])) fail(`importer field changed: ${field}`)
  }
  const allowedFile = new Set([...eligible].map(name => artifactLocator(home, name, candidateArtifacts[name]).slice(5)))
  const inspectReference = (value, label) => {
    if (typeof value !== 'string') fail(`invalid dependency reference: ${label}`)
    assertCandidatePeers(value, label)
    for (const match of value.matchAll(/file:([^()\s]+)/gu)) {
      const candidate = match[1].startsWith('/') ? match[1] : resolve(join(home, 'profiles', '__profile__'), match[1])
      if (!allowedFile.has(candidate)) fail(`unapproved file locator: ${label}`)
    }
    if (/\b(?:link:|git\+|git:|https?:)/u.test(value)) fail(`unapproved dependency locator: ${label}`)
  }
  for (const [key, record] of Object.entries(lock.packages || {})) {
    const name = snapshotName(key)
    if (!plain(record)) fail(`invalid lock package: ${key}`)
    if (nativeName.test(name || '')) {
      const info = native[name]
      if (!info || key !== `${name}@${info.version}` || record.resolution?.integrity !== info.integrity) fail(`native package differs from Host: ${key}`)
    } else if (enhancedName.test(name || '')) {
      if (!eligible.has(name)) fail(`enhanced package outside selected closure: ${key}`)
      const artifact = candidateArtifacts[name]
      if (!artifact || !key.includes(`file:`)) fail(`enhanced package differs from verified artifact: ${key}`)
      inspectReference(key, key)
      assertArtifactReference(name, key.slice(name.length + 1), key)
    } else if (typeof record.resolution?.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+=*$/u.test(record.resolution.integrity)) fail(`unverified transitive package: ${key}`)
  }
  for (const [key, snapshot] of Object.entries(lock.snapshots || {})) {
    const name = snapshotName(key)
    if (!plain(snapshot)) fail(`invalid lock snapshot: ${key}`)
    if (nativeName.test(name || '') && key !== `${name}@${native[name]?.version}` && !key.startsWith(`${name}@${native[name]?.version}(`)) fail(`stale native snapshot: ${key}`)
    if (enhancedName.test(name || '')) {
      if (!eligible.has(name)) fail(`enhanced package outside selected closure: ${key}`)
      if (!candidateArtifacts[name] || !key.includes('file:')) fail(`stale enhanced snapshot: ${key}`)
      inspectReference(key, key)
      assertArtifactReference(name, key.slice(name.length + 1), key)
    }
    for (const field of ['dependencies', 'optionalDependencies']) for (const [dependency, reference] of Object.entries(snapshot[field] || {})) {
      inspectReference(reference, `${key}>${dependency}`)
      if (nativeName.test(dependency) && reference !== native[dependency]?.version
        && !reference.startsWith(`${native[dependency]?.version}(`)) fail(`stale native edge: ${key}>${dependency}`)
      if (enhancedName.test(dependency)) assertArtifactReference(dependency, reference, `${key}>${dependency}`)
    }
  }
  for (const name of Object.keys(declared)) if (!nativeName.test(name) && !candidateArtifacts[name]) fail(`unapproved root: ${name}`)
  if (Object.keys(declared).length === 0 && (Object.keys(lock.packages || {}).length || Object.keys(lock.snapshots || {}).length)) {
    fail('dependency-free profile has an installed graph')
  }
}

async function verifyArtifacts(preparation, home, originalPhysicalHome = preparation.originalHome) {
  const cohortRoot = join(home, 'rsi-local-cohorts')
  if (await realpath(cohortRoot) !== cohortRoot) fail('cohort parent is not canonical')
  for (const [cohort, pins] of Object.entries(preparation.candidateCohorts)) {
    if (await realpath(join(cohortRoot, cohort)) !== join(cohortRoot, cohort)) fail(`cohort is not canonical: ${cohort}`)
    if (!same(await localCohortPins(preparation.candidateHome, cohort), pins)
      || !same(await localCohortPins(home, cohort), pins)) fail(`candidate cohort resources changed: ${cohort}`)
    if (home !== preparation.candidateHome && !same(await localCohortPins(originalPhysicalHome, cohort), preparation.originalCohorts[cohort])) {
      fail(`original cohort resources changed: ${cohort}`)
    }
  }
  for (const [name, artifact] of Object.entries(preparation.candidateArtifacts)) {
    const path = join(home, relative(preparation.originalHome, artifact.tarball))
    if (await realpath(path) !== path || await realpath(artifact.sourcePath) !== artifact.sourcePath
      || digest(await pinnedFile(path)) !== artifact.sha256 || digest(await pinnedFile(artifact.sourcePath)) !== artifact.sha256) fail(`artifact changed: ${name}`)
  }
}
async function verifyProviderBindingsFresh(edges) {
  if (!edges.length) return
  const helperPath = fileURLToPath(import.meta.url)
  if (await realpath(helperPath) !== helperPath) fail('provider verifier source is not canonical')
  const sourceHash = digest(await pinnedFile(helperPath, 2_097_152))
  const payload = JSON.stringify({ helperPath, sourceHash, edges })
  if (Buffer.byteLength(payload) > 1_048_576) fail('provider verification input exceeds bound')
  const script = `
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
let size = 0
const chunks = []
try {
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > 1_048_576) throw new Error('input exceeds bound')
    chunks.push(chunk)
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const source = await readFile(input.helperPath)
  if (createHash('sha256').update(source).digest('hex') !== input.sourceHash) throw new Error('verifier source changed')
  let failedIndex = -1
  for (let index = 0; index < input.edges.length; index++) {
    const edge = input.edges[index]
    let resolved
    try { resolved = await realpath(createRequire(edge.from).resolve(edge.provider + '/package.json')) }
    catch { failedIndex = index; break }
    if (resolved !== edge.expected) { failedIndex = index; break }
  }
  process.stdout.write(JSON.stringify(failedIndex === -1 ? { ok: true } : { ok: false, index: failedIndex }))
} catch {
  process.stdout.write(JSON.stringify({ ok: false }))
}
`
  const deadline = AbortSignal.timeout(30_000)
  const output = await new Promise((accept, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined },
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
    })
    const chunks = []
    let outputBytes = 0, stderrBytes = 0, failed = false
    const stop = () => {
      if (!child.pid) return
      try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL') }
      catch (error) { if (error?.code !== 'ESRCH') child.kill('SIGKILL') }
    }
    deadline.addEventListener('abort', stop, { once: true })
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length
      if (outputBytes > 8_192) { failed = true; stop() }
      else chunks.push(chunk)
    })
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length
      if (stderrBytes > 8_192) { failed = true; stop() }
    })
    child.stdin.on('error', () => { failed = true; stop() })
    child.once('error', () => { failed = true; stop() })
    child.once('close', (code, signal) => {
      deadline.removeEventListener('abort', stop)
      if (failed || deadline.aborted || code !== 0 || signal !== null) reject(new Error('provider verifier process failed'))
      else accept(Buffer.concat(chunks).toString('utf8'))
    })
    child.stdin.end(payload)
  })
  let result
  try { result = JSON.parse(output) } catch { fail('provider verifier returned invalid result') }
  if (result?.ok === true && Object.keys(result).length === 1) return
  if (result?.ok === false && Number.isInteger(result.index) && Object.keys(result).length === 2
    && edges[result.index]) fail(`installed provider binding differs: ${edges[result.index].label}`)
  fail('provider verifier returned invalid result')
}

async function verifyInstalled(profilePath, candidateArtifacts, peerScope, yaml) {
  const store = join(profilePath, 'node_modules', '.pnpm')
  const storeEntry = await lstat(store).catch(() => undefined)
  if (!storeEntry?.isDirectory() || storeEntry.isSymbolicLink() || await realpath(store) !== store) fail(`profile not materialized: ${profilePath}`)
  const found = new Set(), owned = new Map(), links = []
  for (const folder of await readdir(store)) {
    const packagePath = join(store, folder), packageEntry = await lstat(packagePath)
    if (folder === 'lock.yaml') {
      if (!packageEntry.isFile() || packageEntry.isSymbolicLink()
        || !same(parse(yaml, (await pinnedFile(packagePath, 16_777_216)).toString('utf8'), 'installed pnpm lockfile'),
          parse(yaml, (await pinnedFile(join(profilePath, 'pnpm-lock.yaml'), 16_777_216)).toString('utf8'), 'profile lockfile'))) {
        fail('installed pnpm lockfile differs from profile')
      }
      continue
    }
    if (!packageEntry.isDirectory() || packageEntry.isSymbolicLink() || packageEntry.uid !== process.getuid()
      || packageEntry.mode & 0o022 || await realpath(packagePath) !== packagePath
      || folder !== 'node_modules' && !/^(?:@[a-z0-9._-]+\+)?[a-z0-9._-]+@[^/]+$/u.test(folder)) {
      fail(`unexpected pnpm store entry: ${folder}`)
    }
    if (folder === 'node_modules') continue
    const scope = join(store, folder, 'node_modules', '@dsh-enhanced')
    const scopeEntry = await lstat(scope).catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
    if (scopeEntry === undefined) continue
    if (!scopeEntry.isDirectory() || scopeEntry.isSymbolicLink() || await realpath(scope) !== scope) fail(`unsafe installed package scope: ${scope}`)
    for (const slug of await readdir(scope)) {
      const name = `@dsh-enhanced/${slug}`, artifact = candidateArtifacts[name]
      if (!peerScope.names.includes(name)) fail(`installed enhanced package outside selected closure: ${name}`)
      if (!artifact) fail(`unapproved installed enhanced package: ${name}`)
      const root = join(scope, slug), entry = await lstat(root)
      if (entry.isSymbolicLink()) {
        const target = await realpath(root).catch(() => undefined)
        if (!target || !inside(store, target)) fail(`installed dependency link escapes profile: ${name}`)
        links.push({ name, target })
        continue
      }
      if (!entry.isDirectory() || await realpath(root) !== root) fail(`unsafe installed package: ${name}`)
      const files = []
      const visit = async (path, suffix) => {
        for (const child of await readdir(path)) {
          if (!suffix && child === 'node_modules') continue
          const item = join(path, child), relativePath = suffix ? `${suffix}/${child}` : child, info = await lstat(item)
          if (info.isDirectory() && !info.isSymbolicLink()) await visit(item, relativePath)
          else if (info.isFile() && !info.isSymbolicLink()) files.push({ path: relativePath,
            sha256: digest(await pinnedFile(item)), executable: Boolean(info.mode & 0o100) })
          else fail(`unsafe installed package entry: ${name}/${relativePath}`)
        }
      }
      await visit(root, '')
      files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
      if (!same(files, artifact.files.map(file => ({ path: file.path, sha256: file.sha256,
        executable: Boolean(file.mode & 0o100) })))) fail(`installed package differs from artifact: ${name}`)
      const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
      if (manifest.name !== name || manifest.version !== artifact.version) fail(`installed identity differs: ${name}`)
      if (!owned.has(name)) owned.set(name, new Set())
      owned.get(name).add(root)
      found.add(name)
    }
  }
  for (const { name, target } of links) if (!owned.get(name)?.has(target)) fail(`installed dependency link differs from owned package: ${name}`)
  const edges = []
  for (const name of peerScope.names) {
    const roots = owned.get(name)
    if (roots?.size !== 1) fail(`installed package identity split or absent: ${name}`)
    const parent = [...roots][0]
    const providers = new Set([...candidateArtifacts[name].runtimeDependencies, ...peerScope.peerProviders[name]])
    for (const provider of providers) {
      const expected = owned.get(provider)
      if (expected?.size !== 1) fail(`installed provider identity split or absent: ${name}>${provider}`)
      edges.push({ from: join(parent, 'package.json'), provider,
        expected: join([...expected][0], 'package.json'), label: `${name}>${provider}` })
    }
  }
  await verifyProviderBindingsFresh(edges)
  return { found, owned }
}

export async function prepareHostLocalProfileUpdate({ originalHome, originalDshPath, candidateDshPath,
  preparationRoot, candidateHome, candidateArtifacts, installer, globalDshRoot,
  approvedBackupNames = [], pnpmPath = 'pnpm', signal,
  runPnpm }) {
  if (typeof runPnpm !== 'function') fail('sandboxed pnpm runner is required')
  await directory(originalHome)
  if (await lstat(join(originalHome, 'settings.yaml')).then(() => true, error => {
    if (error?.code === 'ENOENT') return false
    throw error
  })) fail('pending native legacy settings import requires a separate migration')
  await directory(preparationRoot, true)
  await directory(candidateHome, true)
  if (inside(originalHome, preparationRoot) || inside(preparationRoot, originalHome)
    || !inside(preparationRoot, candidateHome)) fail('candidate and preparation roots must be private and outside Home')
  const yaml = parser(candidateDshPath), oldHost = await nativeAuthority(originalDshPath), candidate = await nativeAuthority(candidateDshPath)
  const verifiedArtifacts = await artifacts(candidateArtifacts, originalHome, candidateHome)
  const { readRsiLocalArtifactManifest } = await loadLocalSourceInstaller(installer)
  if (typeof readRsiLocalArtifactManifest !== 'function') fail('reviewed artifact manifest reader is absent')
  const candidateCohorts = {}, originalCohorts = {}
  for (const artifact of Object.values(verifiedArtifacts)) {
    const cohort = relative(join(originalHome, 'rsi-local-cohorts'), dirname(dirname(artifact.tarball)))
    const pins = await localCohortPins(candidateHome, cohort)
    if (pins === null) fail(`candidate cohort receipt is absent: ${cohort}`)
    const candidateReceipt = JSON.parse(await pinnedFile(join(candidateHome, 'rsi-local-cohorts', cohort, 'receipt.json'), 16_777_216))
    const { receiptDigest, ...body } = candidateReceipt
    if (receiptDigest !== digest(JSON.stringify(body)) || body.root !== join(originalHome, 'rsi-local-cohorts', cohort)
      || !Array.isArray(body.packages) || body.packages.some(item => item.tarball !== join(body.root, 'artifacts', `${item.name?.split('/')[1]}.tgz`))) fail(`candidate cohort receipt differs: ${cohort}`)
    candidateCohorts[cohort] = pins
    originalCohorts[cohort] = await localCohortPins(originalHome, cohort)
  }
  const profiles = await inventory(originalHome, approvedBackupNames)
  const sharedFallback = await prepareHostLocalSharedFallback({ originalHome, oldHostRoot: oldHost.root,
    candidateHostRoot: candidate.root, globalDshRoot, profiles: profiles.map(item => item.name) })
  const used = new Set()
  for (const profile of profiles) for (const name of Object.keys(roots(profile.metadata).dependencies)) if (enhancedName.test(name)) used.add(name)
  for (const name of used) if (!verifiedArtifacts[name]) fail(`candidate artifact missing for root: ${name}`)
  for (const name of ['home', 'config', 'store', 'cache']) await mkdir(join(preparationRoot, name), { recursive: true, mode: 0o700 })
  await writeFile(join(preparationRoot, 'home', '.npmrc'), '', { mode: 0o600 })
  const output = []
  for (const profile of profiles) {
    if ((await lstat(join(profile.path, '.npmrc')).catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))) !== undefined) fail(`unsupported profile .npmrc: ${profile.name}`)
    const projected = projectPnpmPackageManager(profile.metadata)
    await assertLifecycleNpmMetadataSafe({ metadata: { packageJson: projected['package.json'], workspace: projected['pnpm-workspace.yaml'], lockfile: projected['pnpm-lock.yaml'] }, dshExecutable: originalDshPath })
    const needsInstall = Object.keys(roots(profile.metadata).dependencies).length > 0
    if (profile.metadata['pnpm-lock.yaml'] === undefined && needsInstall) fail(`unlocked dependent profile: ${profile.name}`)
    if (!needsInstall) {
      assertEmptyLockGraph(profile.metadata, yaml)
      await assertEmptyInstalledGraph(profile.path, profile.path, roots(profile.metadata).manifest.name, yaml)
    }
    const path = join(preparationRoot, profile.name)
    await mkdir(path, { mode: 0o700 })
    const peerScope = await selectedPeers(profile.metadata, verifiedArtifacts, readRsiLocalArtifactManifest)
    const initial = derive(profile.metadata, originalHome, candidate.packages, verifiedArtifacts, yaml, peerScope.overrides)
    await writeMetadata(path, initial)
    const env = { ...pnpmEnvironment(preparationRoot), PNPM_CONFIG_USERCONFIG: join(preparationRoot, 'home', '.npmrc'),
      PNPM_CONFIG_STORE_DIR: join(preparationRoot, 'store'), PNPM_CONFIG_CACHE_DIR: join(preparationRoot, 'cache'),
      PNPM_CONFIG_IGNORE_SCRIPTS: 'true', PNPM_CONFIG_IGNORE_PNPMFILE: 'true', PNPM_CONFIG_TRUST_LOCKFILE: 'false',
      PNPM_CONFIG_NODE_LINKER: 'isolated' }
    if (needsInstall) {
      await runPnpm(['install', '--lockfile-only', '--ignore-scripts'], { cwd: path, env, signal, phase: 'resolve', pnpmPath,
        logicalHome: originalHome, candidateHome })
      const resolved = await readMetadata(path)
      const prepared = { ...resolved, 'pnpm-lock.yaml': normalizeLock(yaml,
        resolved['pnpm-lock.yaml'], path, profile.path, originalHome) }
      assertDelta(profile.metadata, prepared, candidate.packages, verifiedArtifacts, originalHome, yaml, peerScope)
      await runPnpm(['fetch', '--frozen-lockfile', '--ignore-scripts'], { cwd: path, env, signal, phase: 'fetch', pnpmPath,
        logicalHome: originalHome, candidateHome })
      if (!same(await readMetadata(path), resolved)) fail(`fetch changed metadata: ${profile.name}`)
      await writeFile(join(path, 'pnpm-lock.yaml'), prepared['pnpm-lock.yaml'], { mode: 0o600 })
    }
    const prepared = await readMetadata(path)
    if (needsInstall) assertDelta(profile.metadata, prepared, candidate.packages, verifiedArtifacts, originalHome, yaml, peerScope)
    else assertFallbackDelta(profile.metadata, prepared)
    output.push({ name: profile.name, backupOf: profile.backupOf, fallbackOnly: !needsInstall,
      peerScope,
      originalDigests: Object.fromEntries(metadataNames.map(name => [name, sourceDigest(profile.metadata[name])])),
      preparedDigests: Object.fromEntries(metadataNames.map(name => [name, sourceDigest(prepared[name])])) })
  }
  const live = await inventory(originalHome, approvedBackupNames)
  if (!same(live.map(item => [item.name, ...metadataNames.map(name => sourceDigest(item.metadata[name]))]),
    profiles.map(item => [item.name, ...metadataNames.map(name => sourceDigest(item.metadata[name]))]))) fail('original Home changed during preparation')
  await verifyArtifacts({ originalHome, candidateHome, candidateArtifacts: verifiedArtifacts,
    candidateCohorts, originalCohorts }, candidateHome)
  return { schemaVersion: 1, originalHome, preparationRoot, candidateHome, candidateDshPath, installer,
    sharedFallback,
    oldHostRoot: oldHost.root, candidateHostRoot: candidate.root, candidateNative: candidate.packages,
    candidateArtifacts: verifiedArtifacts, candidateCohorts, originalCohorts,
    approvedBackupNames, profiles: output }
}

export async function validateHostLocalProfileUpdate({ preparation, stagedHome,
  originalPhysicalHome = preparation.originalHome, legacySettingsImport, ownerSourceRepair }) {
  const stage = await directory(stagedHome)
  const original = await directory(originalPhysicalHome)
  if (stage === original || inside(original, stage) || inside(stage, original)
    || stage !== preparation.originalHome && inside(preparation.originalHome, stage)) fail('stage overlaps original Home')
  const yaml = parser(preparation.candidateDshPath)
  await verifyRetiredHostLocalSharedFallback({ proof: preparation.sharedFallback, stagedHome: stage,
    originalPhysicalHome: original })
  const { readRsiLocalArtifactManifest } = await loadLocalSourceInstaller(preparation.installer)
  if (typeof readRsiLocalArtifactManifest !== 'function') fail('reviewed artifact manifest reader is absent')
  await verifyArtifacts(preparation, stage, original)
  const actual = await inventory(stage, preparation.approvedBackupNames)
  if (!same(actual.map(item => item.name), preparation.profiles.map(item => item.name))) fail('profile inventory changed')
  const normalizedPatch = legacySettingsImport === undefined ? undefined : await verifyHostLegacySettingsImport({
    ...legacySettingsImport, preparation, stagedHome: stage, originalPhysicalHome: original,
  })
  let repairPatches
  if (ownerSourceRepair !== undefined) {
    const proof = ownerSourceRepair.sourceProof
    const programUpdate = proof?.protocol === 'dsh-enhanced/host-owner-program-update/v1'
    const owner = programUpdate ? proof.ownerUpdate : proof?.ownerRepair
    const next = programUpdate ? proof.ownerUpdateNext : proof?.ownerRepairNext
    if (legacySettingsImport !== undefined || ownerSourceRepair.homePath !== preparation.originalHome
      || !programUpdate && proof?.protocol !== 'dsh-enhanced/host-owner-source-repair/v1'
      || proof.homePath !== preparation.originalHome || !next) fail('owner profile update binding differs')
    const verification = { record: proof.record, homePath: preparation.originalHome, physicalHome: stage,
      installer: proof.installer, phase: 'after-finalize' }
    if (programUpdate) {
      const { verifyOwnerProgramUpdate } = await import('./owner-program-update.mjs')
      await verifyOwnerProgramUpdate({ ownerUpdate: owner, ownerUpdateNext: next, ...verification })
    } else {
      const { verifyOwnerSourceRepair } = await import('./owner-source-repair.mjs')
      await verifyOwnerSourceRepair({ ownerRepair: owner, ownerRepairNext: next, ...verification })
    }
    repairPatches = next.patches
    if (!plain(repairPatches) || !same(Object.keys(repairPatches).sort(),
      [proof.profile, owner.coordinatorProfile].sort())) fail('owner update patch scope differs')
  }
  for (const profile of actual) {
    const expected = preparation.profiles.find(item => item.name === profile.name)
    let metadata = normalizedPatch !== undefined && profile.name === legacySettingsImport.permit.profile
      ? { ...profile.metadata, 'cordis.patch.yml': normalizedPatch } : profile.metadata
    const originalMetadata = await readMetadata(join(original, 'profiles', profile.name))
    if (repairPatches && Object.hasOwn(repairPatches, profile.name)) {
      if (sourceDigest(profile.metadata['cordis.patch.yml']) !== repairPatches[profile.name]) fail('signed repaired patch changed')
      metadata = { ...metadata, 'cordis.patch.yml': originalMetadata['cordis.patch.yml'] }
    }
    const peerScope = await selectedPeers(originalMetadata, preparation.candidateArtifacts, readRsiLocalArtifactManifest)
    if (!same(peerScope, expected.peerScope)) fail(`verified peer scope changed: ${profile.name}`)
    for (const name of metadataNames) {
      if (sourceDigest(originalMetadata[name]) !== expected.originalDigests[name]) fail(`original metadata drift: ${profile.name}/${name}`)
      if (sourceDigest(metadata[name]) !== expected.preparedDigests[name]) fail(`staged metadata drift: ${profile.name}/${name}`)
    }
    if (!expected.fallbackOnly) assertDelta(originalMetadata, metadata, preparation.candidateNative,
      preparation.candidateArtifacts, preparation.originalHome, yaml, peerScope)
    else assertFallbackDelta(originalMetadata, metadata)
    await oldHostLinks(join(profile.path, 'node_modules'), preparation.oldHostRoot, preparation.candidateHostRoot, false)
    await oldHostLinks(join(profile.path, '.dsh-module-fallback', 'node_modules'), preparation.oldHostRoot, preparation.candidateHostRoot, false)
    if (expected.fallbackOnly) {
      assertEmptyLockGraph(profile.metadata, yaml)
      await assertEmptyInstalledGraph(profile.path, join(preparation.originalHome, 'profiles', profile.name),
        roots(profile.metadata).manifest.name, yaml)
      continue
    }
    const declared = roots(profile.metadata).dependencies
    const installed = Object.keys(declared).length ? await verifyInstalled(profile.path, preparation.candidateArtifacts, peerScope, yaml)
      : { found: new Set(), owned: new Map() }
    for (const name of Object.keys(declared)) if (enhancedName.test(name)) {
      if (!installed.found.has(name)) fail(`enhanced root was not installed: ${profile.name}/${name}`)
      const selected = await realpath(join(profile.path, 'node_modules', name)).catch(() => undefined)
      if (!selected || !installed.owned.get(name)?.has(selected)) fail(`enhanced root binding is outside profile: ${profile.name}/${name}`)
      const manifest = JSON.parse(await pinnedFile(join(selected, 'package.json'), 1_048_576))
      if (manifest.name !== name || manifest.version !== preparation.candidateArtifacts[name].version) fail(`enhanced root binding differs: ${profile.name}/${name}`)
    }
    for (const folder of await readdir(join(profile.path, 'node_modules', '.pnpm')).catch(error => error?.code === 'ENOENT' && !Object.keys(declared).length ? [] : Promise.reject(error))) if (folder.startsWith('@deepseek-ai+')) {
      const match = /^@deepseek-ai\+([^@]+)@([^_(]+)/u.exec(folder)
      if (!match || preparation.candidateNative[`@deepseek-ai/${match[1]}`]?.version !== match[2]) fail(`stale native pnpm package: ${profile.name}/${folder}`)
    }
  }
  await oldHostLinks(join(stage, 'profiles', 'node_modules'), preparation.oldHostRoot, preparation.candidateHostRoot, false)
  return { schemaVersion: 1, profileNames: actual.map(item => item.name), metadataDigest: digest(JSON.stringify(preparation.profiles)),
    artifactDigest: digest(JSON.stringify(preparation.candidateArtifacts)) }
}

export async function materializeHostLocalProfileUpdate({ preparation, stagedHome, logicalHome, signal,
  pnpmPath = 'pnpm', runPnpm, runCandidateDsh }) {
  if (typeof runPnpm !== 'function' || typeof runCandidateDsh !== 'function' || logicalHome !== preparation.originalHome) fail('staged sandbox runners or logical Home are invalid')
  const stage = await directory(stagedHome)
  if (stage === logicalHome || inside(logicalHome, stage)) fail('stage overlaps original Home')
  const yaml = parser(preparation.candidateDshPath)
  const originals = await inventory(logicalHome, preparation.approvedBackupNames)
  const staged = await inventory(stage, preparation.approvedBackupNames)
  if (!same(originals.map(item => item.name), preparation.profiles.map(item => item.name))
    || !same(staged.map(item => item.name), preparation.profiles.map(item => item.name))) fail('profile inventory changed')
  await verifyArtifacts(preparation, stage)
  await retireHostLocalSharedFallback({ proof: preparation.sharedFallback, stagedHome: stage })
  for (const profile of preparation.profiles) {
    const source = originals.find(item => item.name === profile.name), dest = staged.find(item => item.name === profile.name)
    const prepared = await readMetadata(join(preparation.preparationRoot, profile.name))
    for (const name of metadataNames) if (sourceDigest(source.metadata[name]) !== profile.originalDigests[name]
      || sourceDigest(dest.metadata[name]) !== profile.originalDigests[name]
      || sourceDigest(prepared[name]) !== profile.preparedDigests[name]) fail(`profile changed before stage installation: ${profile.name}/${name}`)
    if (profile.fallbackOnly) {
      assertFallbackDelta(source.metadata, prepared)
      assertEmptyLockGraph(source.metadata, yaml)
      const logicalProfilePath = join(logicalHome, 'profiles', profile.name)
      const profileName = roots(source.metadata).manifest.name
      await assertEmptyInstalledGraph(source.path, logicalProfilePath, profileName, yaml)
      await assertEmptyInstalledGraph(dest.path, logicalProfilePath, profileName, yaml)
    }
    await writeMetadata(dest.path, prepared)
    if (profile.fallbackOnly) continue
    await rm(join(dest.path, 'node_modules'), { recursive: true, force: true })
    const env = { ...pnpmEnvironment(preparation.preparationRoot, { DSH_HOME: logicalHome }),
      PNPM_CONFIG_OFFLINE: 'true', PNPM_CONFIG_FROZEN_LOCKFILE: 'true', PNPM_CONFIG_IGNORE_SCRIPTS: 'true',
      PNPM_CONFIG_TRUST_LOCKFILE: 'true', PNPM_CONFIG_PACKAGE_IMPORT_METHOD: 'copy',
      PNPM_CONFIG_NODE_LINKER: 'isolated' }
    await runPnpm(['install', '--offline', '--frozen-lockfile', '--ignore-scripts'], {
      cwd: join(logicalHome, 'profiles', profile.name), env, signal, phase: 'materialize', pnpmPath,
      logicalHome, stagedHome: stage })
  }
  await oldHostLinks(join(stage, 'profiles', 'node_modules'), preparation.oldHostRoot, preparation.candidateHostRoot, true)
  for (const profile of preparation.profiles) {
    await oldHostLinks(join(stage, 'profiles', profile.name, 'node_modules'), preparation.oldHostRoot, preparation.candidateHostRoot, true)
    await oldHostLinks(join(stage, 'profiles', profile.name, '.dsh-module-fallback', 'node_modules'), preparation.oldHostRoot, preparation.candidateHostRoot, true)
  }
  for (const profile of preparation.profiles) if (profile.backupOf === undefined) await runCandidateDsh(
    ['--profile', profile.name, '--dump-config'], { env: { ...process.env, DSH_HOME: logicalHome }, signal, phase: 'fallback', profile: profile.name })
  return validateHostLocalProfileUpdate({ preparation, stagedHome: stage })
}
