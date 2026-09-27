import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { lstat, mkdir, readFile, readdir, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { assertLifecycleNpmMetadataSafe } from './lifecycle-config.mjs'

let yaml
let semver
function loadYaml(dshPath) {
  try { return createRequire(dshPath)('yaml') }
  catch { fail('verified candidate Host has no YAML parser') }
}
function loadSemver(dshPath) {
  try { return createRequire(dshPath)('semver') }
  catch { return undefined }
}
const profileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const backupName = /^\.([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.plugin-backup-([A-Za-z0-9-]{1,36})$/u
const nativeName = /^@deepseek-ai\/[a-z0-9][a-z0-9._-]*$/u
const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/u
const metadataNames = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml']
const hash = data => createHash('sha256').update(data).digest('hex')
const inside = (root, path) => path === root || path.startsWith(root + sep)
const fail = message => { throw new Error(`Host profile update: ${message}`) }
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)

async function canonicalDirectory(path) {
  if (!isAbsolute(path) || resolve(path) !== path) fail('path must be absolute')
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink()) fail(`not a plain directory: ${path}`)
  return realpath(path)
}

async function privateDirectory(path) {
  const canonical = await canonicalDirectory(path)
  const entry = await stat(canonical)
  if (entry.uid !== process.getuid() || (entry.mode & 0o077) !== 0) fail(`directory must be owner-private: ${path}`)
  return canonical
}

async function privateFile(path) {
  const entry = await lstat(path)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.uid !== process.getuid() || (entry.mode & 0o022) !== 0 || entry.size > 32 * 1024 * 1024) fail(`unsafe file: ${path}`)
  return readFile(path)
}

function parseYaml(source, label) {
  const document = yaml.parseDocument(source, { uniqueKeys: true, strict: true })
  if (document.errors.length || document.warnings.length || /(^|\s)[&*][a-z0-9_-]+/iu.test(source)) fail(`invalid ${label}`)
  return document.toJS({ maxAliasCount: 0 })
}

function normalizePreparedCohortLock(source, preparedPath, logicalProfilePath, originalHome) {
  const lock = parseYaml(source, 'resolved lockfile')
  const cohortRoot = join(originalHome, 'rsi-local-cohorts')
  const visit = value => {
    if (typeof value === 'string') return value.replace(/file:(?!\/)(\.\.?\/[^()>\s]+)/gu, (_whole, locator) => {
      const target = resolve(preparedPath, locator)
      if (!inside(cohortRoot, target)) {
        if (inside(cohortRoot, resolve(logicalProfilePath, locator))) return `file:${locator}`
        fail(`resolved file locator escaped frozen cohort: ${locator}`)
      }
      return `file:${relative(logicalProfilePath, target).split(sep).join('/')}`
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
  return yaml.stringify(visit(lock))
}

async function nativeAuthority(candidateDshPath) {
  const entry = await realpath(candidateDshPath)
  let root = dirname(entry)
  while (root !== dirname(root) && basename(root) !== 'node_modules') root = dirname(root)
  if (basename(root) !== 'node_modules') fail('candidate DSH is not in a managed Host')
  root = dirname(root)
  const lock = JSON.parse(await privateFile(join(root, 'package-lock.json')))
  if (lock.lockfileVersion !== 3 || !plain(lock.packages)) fail('candidate Host lockfile invalid')
  const packages = {}
  for (const [path, record] of Object.entries(lock.packages)) {
    if (!path.startsWith('node_modules/@deepseek-ai/')) continue
    if (path.slice('node_modules/@deepseek-ai/'.length).includes('/node_modules/')) continue
    if (!/^node_modules\/@deepseek-ai\/[a-z0-9][a-z0-9._-]*$/u.test(path) || !plain(record)
      || typeof record.version !== 'string' || !/^sha512-[A-Za-z0-9+/]+=*$/u.test(record.integrity || '')) fail('candidate native graph has unsupported package')
    const name = path.slice('node_modules/'.length)
    const manifestPath = join(root, path, 'package.json')
    const present = await lstat(manifestPath).catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
    const incompatibleOptional = record.optional === true && (Array.isArray(record.os) && !record.os.includes(process.platform)
      || Array.isArray(record.cpu) && !record.cpu.includes(process.arch))
    if (!present && !incompatibleOptional) fail(`candidate native package is missing: ${name}`)
    const manifest = present ? JSON.parse(await privateFile(manifestPath))
      : { name, version: record.version, dependencies: record.dependencies || {} }
    if (manifest.name !== name || manifest.version !== record.version) fail(`candidate native package differs from lock: ${name}`)
    packages[name] = { version: record.version, integrity: record.integrity,
      dependencies: Object.fromEntries(Object.entries(manifest.dependencies || {}).filter(([dep]) => nativeName.test(dep))) }
  }
  if (!packages['@deepseek-ai/dsh'] || !packages['@deepseek-ai/dsh-base']) fail('candidate Host lacks core native packages')
  return { root, packages }
}

function snapshotName(key) {
  const match = /^(@[^/]+\/[^@]+|[^@]+)@(.+)$/u.exec(key)
  return match?.[1]
}
function snapshotSelector(key) {
  const selector = key.split('(', 1)[0]
  if (!/^(?:@[^/]+\/[^@]+|[^@]+)@[^()]+$/u.test(selector)
    || key.includes('(') && !key.endsWith(')')) fail(`unsupported snapshot selector: ${key}`)
  return selector
}
function referenceBase(value) {
  if (typeof value !== 'string' || !value) fail('invalid pnpm dependency reference')
  const index = value.indexOf('(')
  if (index < 0) return value
  if (!value.endsWith(')') || index === 0) fail(`invalid pnpm peer context: ${value}`)
  return value.slice(0, index)
}
function assertPeerBindings(value, authority) {
  if (typeof value !== 'string') fail('invalid pnpm peer reference')
  for (const match of value.matchAll(/@deepseek-ai\/([a-z0-9._-]+)@([A-Za-z0-9._+-]+)/gu)) {
    if (authority[`@deepseek-ai/${match[1]}`]?.version !== match[2]) fail(`native peer context differs from Host: ${value}`)
  }
}
function normalizedPeerReference(value, authority) {
  assertPeerBindings(value, authority)
  const base = referenceBase(value)
  return base + value.slice(base.length)
    .replace(/@deepseek-ai\/([a-z0-9._-]+)@([A-Za-z0-9._+-]+)/gu, '@deepseek-ai/$1@<native>')
    .replace(/\([a-f0-9]{6,}\)/gu, '(<peer-hash>)')
}

function oldManagedNativeEdges(metadata, oldAuthority) {
  if (metadata['pnpm-lock.yaml'] === undefined) return new Map()
  const lock = parseYaml(metadata['pnpm-lock.yaml'], 'original lockfile')
  const edges = new Map()
  for (const [key, snapshot] of Object.entries(lock.snapshots || {})) {
    const parent = snapshotName(key)
    if (!packageName.test(parent || '')) fail(`unsupported snapshot: ${key}`)
    assertPeerBindings(key, oldAuthority)
    for (const field of ['dependencies', 'optionalDependencies']) for (const [dep, reference] of Object.entries(snapshot?.[field] || {})) if (nativeName.test(dep)) {
      const version = oldAuthority[dep]?.version
      assertPeerBindings(reference, oldAuthority)
      if (!version || referenceBase(reference) !== version) fail(`old native edge is outside original Host: ${key}>${dep}`)
      edges.set(`${snapshotSelector(key)}>${dep}`, { dependency: dep, version })
    }
  }
  return edges
}

function assertMetadataDelta(original, prepared, authority, oldAuthority) {
  if (original['cordis.patch.yml'] !== prepared['cordis.patch.yml']) fail('Cordis patch changed')
  const before = JSON.parse(original['package.json']), after = JSON.parse(prepared['package.json'])
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (['dependencies', 'devDependencies', 'optionalDependencies'].includes(field)) {
      const left = before[field] || {}, right = after[field] || {}
      for (const name of new Set([...Object.keys(left), ...Object.keys(right)])) {
        if (nativeName.test(name)) {
          if (right[name] !== undefined && right[name] !== authority[name]?.version) fail(`native manifest version differs from candidate: ${name}`)
        } else if (JSON.stringify(left[name]) !== JSON.stringify(right[name])) fail(`non-native manifest dependency changed: ${name}`)
      }
    } else if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) fail(`manifest field changed: ${field}`)
  }
  const oldWorkspace = parseYaml(original['pnpm-workspace.yaml'], 'original workspace')
  const newWorkspace = parseYaml(prepared['pnpm-workspace.yaml'], 'prepared workspace')
  for (const field of new Set([...Object.keys(oldWorkspace), ...Object.keys(newWorkspace)])) {
    if (field !== 'overrides' && JSON.stringify(oldWorkspace[field]) !== JSON.stringify(newWorkspace[field])) fail(`workspace field changed: ${field}`)
  }
  const oldOverrides = oldWorkspace.overrides || {}, newOverrides = newWorkspace.overrides || {}
  const packageMetadataEqual = (key, before, after) => {
    if (JSON.stringify(before) === JSON.stringify(after)) return true
    if (!plain(before) || !plain(after)) return false
    for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (field !== 'peerDependencies') {
        if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) return false
        continue
      }
      const oldPeers = before[field] || {}, newPeers = after[field] || {}
      for (const name of new Set([...Object.keys(oldPeers), ...Object.keys(newPeers)])) {
        if (oldPeers[name] === newPeers[name]) continue
        const target = authority[name]?.version
        if (!nativeName.test(name) || newPeers[name] !== target
          || newOverrides[`${snapshotSelector(key)}>${name}`] !== target
          || !semver?.satisfies(target, oldPeers[name], { includePrerelease: true })) return false
      }
    }
    return true
  }
  const oldEdges = oldManagedNativeEdges(original, oldAuthority)
  for (const [key, value] of Object.entries(oldOverrides)) if (newOverrides[key] !== value) {
    const edge = oldEdges.get(key)
    if (!edge || value !== edge.version || newOverrides[key] !== authority[edge.dependency]?.version) fail(`existing override changed: ${key}`)
  }
  for (const [key, value] of Object.entries(newOverrides)) {
    if (key in oldOverrides) continue
    const edge = /^(?:@[^/]+\/[^@]+|[^@]+)@[^>]+>(@deepseek-ai\/[a-z0-9][a-z0-9._-]*)$/u.exec(key)
    if (!edge || authority[edge[1]]?.version !== value) fail(`unsupported override: ${key}`)
  }
  if (original['pnpm-lock.yaml'] === undefined || prepared['pnpm-lock.yaml'] === undefined) {
    if (original['pnpm-lock.yaml'] !== prepared['pnpm-lock.yaml']) fail('lockfile appeared or disappeared')
    return { oldLock: undefined, newLock: undefined }
  }
  const oldLock = parseYaml(original['pnpm-lock.yaml'], 'original lockfile')
  const newLock = parseYaml(prepared['pnpm-lock.yaml'], 'prepared lockfile')
  if (oldLock.lockfileVersion !== newLock.lockfileVersion) fail('lockfile version changed')
  for (const field of new Set([...Object.keys(oldLock), ...Object.keys(newLock)])) {
    if (['importers', 'packages', 'snapshots', 'overrides'].includes(field)) continue
    if (JSON.stringify(oldLock[field]) !== JSON.stringify(newLock[field])) fail(`lockfile field changed: ${field}`)
  }
  const oldImporters = oldLock.importers || {}, newImporters = newLock.importers || {}
  if (JSON.stringify(Object.keys(oldImporters).sort()) !== JSON.stringify(Object.keys(newImporters).sort())) fail('lockfile importers changed')
  for (const key of Object.keys(oldImporters)) {
    const oldImporter = oldImporters[key], newImporter = newImporters[key]
    for (const field of new Set([...Object.keys(oldImporter), ...Object.keys(newImporter)])) {
      if (!['dependencies', 'devDependencies', 'optionalDependencies'].includes(field)) {
        if (JSON.stringify(oldImporter[field]) !== JSON.stringify(newImporter[field])) fail(`importer field changed: ${field}`)
        continue
      }
      const left = oldImporter[field] || {}, right = newImporter[field] || {}
      for (const name of new Set([...Object.keys(left), ...Object.keys(right)])) {
        if (left[name]?.version !== undefined) assertPeerBindings(left[name].version, oldAuthority)
        if (right[name]?.version !== undefined) assertPeerBindings(right[name].version, authority)
        if (nativeName.test(name)) {
          if (right[name] !== undefined && referenceBase(right[name]?.version) !== authority[name]?.version) fail(`native importer differs from candidate: ${name}`)
        } else if (JSON.stringify(left[name]) !== JSON.stringify(right[name])) {
          if (!plain(left[name]) || !plain(right[name])
            || left[name].specifier !== right[name].specifier
            || normalizedPeerReference(left[name].version, oldAuthority)
              !== normalizedPeerReference(right[name].version, authority)
            || JSON.stringify(Object.fromEntries(Object.entries(left[name]).filter(([key]) => key !== 'version')))
              !== JSON.stringify(Object.fromEntries(Object.entries(right[name]).filter(([key]) => key !== 'version')))) fail(`non-native importer changed: ${name}`)
        }
      }
    }
  }
  for (const field of ['packages', 'snapshots']) {
    const left = oldLock[field] || {}, right = newLock[field] || {}
    if (field === 'snapshots') {
      const project = (items, baseline) => {
        const groups = {}
        for (const [key, snapshot] of Object.entries(items)) {
          assertPeerBindings(key, baseline)
          const name = snapshotName(key)
          if (nativeName.test(name || '')) {
            if (baseline[name]?.version !== referenceBase(snapshotSelector(key).slice(name.length + 1))) fail(`native snapshot differs from Host: ${key}`)
            for (const map of [snapshot?.dependencies || {}, snapshot?.optionalDependencies || {}]) {
              for (const [dep, version] of Object.entries(map)) {
                assertPeerBindings(version, baseline)
                if (nativeName.test(dep) && referenceBase(version) !== baseline[dep]?.version) fail(`native snapshot edge differs from Host: ${key}>${dep}`)
              }
            }
            continue
          }
          if (!plain(snapshot)) fail(`invalid non-native snapshot: ${key}`)
          const selector = normalizedPeerReference(key, baseline)
          const projected = {}
          for (const [subfield, value] of Object.entries(snapshot)) {
            if (['dependencies', 'optionalDependencies'].includes(subfield)) {
              const dependencies = {}
              for (const [dep, version] of Object.entries(value || {})) {
                assertPeerBindings(version, baseline)
                if (nativeName.test(dep)) {
                  if (referenceBase(version) !== baseline[dep]?.version) fail(`non-native snapshot native edge differs: ${key}>${dep}`)
                  dependencies[dep] = '<native>'
                } else dependencies[dep] = normalizedPeerReference(version, baseline)
              }
              projected[subfield] = dependencies
            } else projected[subfield] = value
          }
          ;(groups[selector] ??= []).push(JSON.stringify(projected))
        }
        return Object.fromEntries(Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))
          .map(([key, values]) => [key, values.sort()]))
      }
      if (JSON.stringify(project(left, oldAuthority)) !== JSON.stringify(project(right, authority))) fail('non-native snapshot graph changed')
    }
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const name = snapshotName(key)
      if (nativeName.test(name || '')) {
        if (right[key] === undefined) continue
        if (field === 'packages' && (right[key]?.resolution?.integrity !== authority[name]?.integrity || snapshotSelector(key) !== `${name}@${authority[name]?.version}`)) fail(`native package differs from candidate: ${name}`)
        if (field === 'snapshots') {
          for (const map of [right[key]?.dependencies || {}, right[key]?.optionalDependencies || {}]) for (const [dep, version] of Object.entries(map)) if (nativeName.test(dep) && referenceBase(version) !== authority[dep]?.version) fail(`native snapshot edge differs from candidate: ${name}>${dep}`)
        }
      } else if (field === 'packages' && !packageMetadataEqual(key, left[key], right[key])) fail(`non-native lock entry changed: ${key}`)
    }
  }
  return { oldLock, newLock }
}

async function readMetadata(path) {
  const result = {}
  for (const name of metadataNames) {
    try { result[name] = (await privateFile(join(path, name))).toString('utf8') }
    catch (error) {
      if (name !== 'pnpm-lock.yaml' || error?.code !== 'ENOENT') throw error
      result[name] = undefined
    }
  }
  return result
}

const sourceDigest = source => source === undefined ? null : hash(source)

function pnpmEnvironment(preparationRoot, more = {}, trustVerifiedLockfile = false) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:p?npm_config_|PNPM_HOME$|NODE_OPTIONS$|NODE_PATH$|XDG_)/iu.test(key)))
  return { ...inherited, ...more, HOME: join(preparationRoot, 'home'), XDG_CONFIG_HOME: join(preparationRoot, 'config'),
    pnpm_config_userconfig: join(preparationRoot, 'home', '.npmrc'), pnpm_config_store_dir: join(preparationRoot, 'store'),
    pnpm_config_cache_dir: join(preparationRoot, 'cache'), pnpm_config_ignore_scripts: 'true', pnpm_config_ignore_pnpmfile: 'true',
    pnpm_config_trust_lockfile: trustVerifiedLockfile ? 'true' : 'false' }
}

async function inventory(home, approvedBackupNames = []) {
  const profiles = join(home, 'profiles')
  if (await canonicalDirectory(profiles) !== profiles) fail('profiles directory is not canonical')
  const result = [], approved = new Set(approvedBackupNames)
  if (approved.size !== approvedBackupNames.length) fail('duplicate approved backup name')
  for (const entry of await readdir(profiles, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const backup = backupName.exec(entry.name)
    if (!(profileName.test(entry.name) || backup !== null && approved.has(entry.name)) || !entry.isDirectory() || entry.isSymbolicLink()) fail(`unsupported profile entry: ${entry.name}`)
    const path = join(profiles, entry.name)
    if (await canonicalDirectory(path) !== path) fail(`profile path is not canonical: ${entry.name}`)
    result.push({ name: entry.name, path, backupOf: backup?.[1], metadata: await readMetadata(path) })
  }
  for (const name of approved) if (!result.some(profile => profile.name === name && profile.backupOf !== undefined && result.some(parent => parent.name === profile.backupOf))) fail(`approved backup is missing or has no profile: ${name}`)
  if (result.length === 0) fail('no profiles to migrate')
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

function nativeOverrides(metadata, authority, oldAuthority) {
  const lock = parseYaml(metadata['pnpm-lock.yaml'], 'profile lockfile')
  const workspace = parseYaml(metadata['pnpm-workspace.yaml'], 'workspace')
  if (!plain(workspace) || !plain(lock) || !plain(lock.importers) || !plain(lock.packages)) fail('unsupported pnpm metadata')
  const overrides = { ...workspace.overrides }
  const oldEdges = oldManagedNativeEdges(metadata, oldAuthority)
  const edges = []
  for (const [key, snapshot] of Object.entries(lock.snapshots || {})) {
    const parent = snapshotName(key)
    if (!packageName.test(parent || '')) fail(`unsupported snapshot: ${key}`)
    for (const field of ['dependencies', 'optionalDependencies']) for (const dep of Object.keys(snapshot?.[field] || {})) {
      if (nativeName.test(dep)) edges.push([`${snapshotSelector(key)}>${dep}`, dep])
    }
  }
  for (const [name, info] of Object.entries(authority)) for (const dep of Object.keys(info.dependencies)) edges.push([`${name}@${info.version}>${dep}`, dep])
  for (const [edge, dep] of edges) {
    if (overrides[edge] !== undefined && overrides[edge] !== authority[dep]?.version) {
      const prior = oldEdges.get(edge)
      if (!prior || prior.dependency !== dep || overrides[edge] !== prior.version) fail(`existing native override conflicts with candidate: ${edge}`)
    }
    overrides[edge] = authority[dep]?.version ?? fail(`candidate lacks native dependency: ${dep}`)
  }
  workspace.overrides = overrides
  return yaml.stringify(workspace)
}

async function digestPackageTree(root) {
  const parts = []
  async function walk(path, suffix) {
    for (const name of (await readdir(path)).sort()) {
      if (name === 'node_modules') continue
      const child = join(path, name), location = suffix ? `${suffix}/${name}` : name
      const entry = await lstat(child)
      if (entry.isDirectory()) await walk(child, location)
      else if (entry.isFile()) parts.push([location, hash(await readFile(child))])
      else if (entry.isSymbolicLink()) parts.push([location, `link:${await readlink(child)}`])
      else fail(`unsupported package entry: ${child}`)
    }
  }
  await walk(root, '')
  return hash(JSON.stringify(parts))
}

async function nonNativePackages(profilePath) {
  const store = join(profilePath, 'node_modules', '.pnpm')
  const result = {}
  for (const folder of await readdir(store).catch(error => error?.code === 'ENOENT' ? [] : Promise.reject(error))) {
    if (!(await lstat(join(store, folder))).isDirectory()) continue
    const modules = join(store, folder, 'node_modules')
    for (const entry of await readdir(modules, { withFileTypes: true }).catch(error => error?.code === 'ENOENT' ? [] : Promise.reject(error))) {
      const names = entry.name.startsWith('@')
        ? (await readdir(join(modules, entry.name))).map(name => `${entry.name}/${name}`) : [entry.name]
      for (const name of names) {
        if (!packageName.test(name) || nativeName.test(name)) continue
        const path = join(modules, name), identity = await lstat(path)
        if (!identity.isDirectory() || identity.isSymbolicLink()) continue
        const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))
        if (manifest.name !== name || typeof manifest.version !== 'string') fail(`invalid installed package: ${path}`)
        const key = `${name}@${manifest.version}`, digest = await digestPackageTree(path)
        ;(result[key] ??= new Set()).add(digest)
      }
    }
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, digests]) => [key, [...digests].sort()]))
}

async function localCohortPins(home, profile) {
  const root = join(home, 'rsi-local-cohorts', profile)
  const entry = await lstat(root).catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
  if (entry === undefined) return null
  if (!entry.isDirectory() || entry.isSymbolicLink()) fail(`unsafe local cohort: ${profile}`)
  const files = []
  async function walk(path, suffix) {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name), rel = suffix ? `${suffix}/${name}` : name, item = await lstat(child)
      if (item.isDirectory() && !item.isSymbolicLink()) await walk(child, rel)
      else if (item.isFile() && !item.isSymbolicLink() && item.nlink === 1 && item.uid === process.getuid()
        && (item.mode & 0o022) === 0 && item.size <= 268_435_456) files.push([rel, hash(await readFile(child))])
      else fail(`unsafe local cohort file: ${profile}/${rel}`)
    }
  }
  await walk(root, '')
  if (!files.some(([name]) => name === 'receipt.json') || !files.some(([name]) => name.startsWith('artifacts/'))) fail(`incomplete local cohort: ${profile}`)
  return files
}

async function oldHostLinks(path, oldHostRoot, candidateHostRoot, remove) {
  const entry = await lstat(path).catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
  if (entry === undefined) return
  if (entry.isSymbolicLink()) {
    const target = resolve(dirname(path), await readlink(path))
    const resolved = await realpath(path).catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
    if (resolved === undefined) fail(`unresolved installed link: ${path}`)
    if ((inside(oldHostRoot, target) || inside(oldHostRoot, resolved))
      && !inside(candidateHostRoot, resolved)) {
      if (!remove) fail(`old Host link remains: ${path}`)
      await rm(path)
    }
  } else if (entry.isDirectory()) for (const name of await readdir(path)) await oldHostLinks(join(path, name), oldHostRoot, candidateHostRoot, remove)
}

async function defaultRunPnpm(args, options) {
  const executable = options.pnpmPath || 'pnpm'
  await new Promise((accept, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: 'ignore', signal: options.signal })
    child.once('error', reject)
    child.once('close', code => code === 0 ? accept() : reject(new Error(`pnpm ${options.phase} exited ${code}`)))
  })
}

async function writeMetadata(path, metadata) {
  for (const name of metadataNames) if (metadata[name] !== undefined) await writeFile(join(path, name), metadata[name], { mode: 0o600 })
}

/** Pre-resolve every existing profile against the verified candidate Host without writing DSH_HOME. */
export async function prepareHostProfileUpdate({ originalHome, originalDshPath, candidateDshPath, preparationRoot, approvedBackupNames = [], pnpmPath = 'pnpm', signal, runPnpm = defaultRunPnpm }) {
  yaml = loadYaml(candidateDshPath)
  semver = loadSemver(candidateDshPath)
  const home = await canonicalDirectory(originalHome)
  if (home !== originalHome) fail('original Home must be canonical')
  const root = await privateDirectory(preparationRoot)
  if (inside(home, root) || inside(root, home)) fail('preparation root must be separate from Home')
  const oldHost = await nativeAuthority(originalDshPath), candidate = await nativeAuthority(candidateDshPath)
  const profiles = await inventory(home, approvedBackupNames)
  await rm(join(root, 'cache'), { recursive: true, force: true })
  for (const name of ['home', 'config', 'store', 'cache']) {
    await mkdir(join(root, name), { recursive: true, mode: 0o700 })
    await privateDirectory(join(root, name))
  }
  await writeFile(join(root, 'home', '.npmrc'), '', { mode: 0o600 })
  const outputs = []
  for (const profile of profiles) {
    if ((await lstat(join(profile.path, '.npmrc')).catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))) !== undefined) fail(`profile .npmrc is unsupported: ${profile.name}`)
    await assertLifecycleNpmMetadataSafe({ metadata: { packageJson: profile.metadata['package.json'], workspace: profile.metadata['pnpm-workspace.yaml'], lockfile: profile.metadata['pnpm-lock.yaml'] }, dshExecutable: originalDshPath })
    const path = join(root, profile.name)
    await mkdir(path, { mode: 0o700 })
    const initial = { ...profile.metadata, 'pnpm-workspace.yaml': profile.metadata['pnpm-lock.yaml'] === undefined
      ? profile.metadata['pnpm-workspace.yaml'] : nativeOverrides(profile.metadata, candidate.packages, oldHost.packages) }
    const manifest = JSON.parse(initial['package.json'])
    if (profile.metadata['pnpm-lock.yaml'] === undefined
      && ['dependencies', 'devDependencies', 'optionalDependencies'].some(field => Object.keys(manifest[field] || {}).length > 0)) fail(`unlocked profile has dependencies: ${profile.name}`)
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) for (const name of Object.keys(manifest[field] || {})) {
      if (nativeName.test(name)) manifest[field][name] = candidate.packages[name]?.version ?? fail(`candidate dropped directly installed native package: ${name}`)
    }
    initial['package.json'] = `${JSON.stringify(manifest, null, 2)}\n`
    await writeMetadata(path, initial)
    const env = pnpmEnvironment(root)
    if (profile.metadata['pnpm-lock.yaml'] !== undefined) await runPnpm(['install', '--lockfile-only', '--ignore-scripts'], { cwd: path, env, signal, phase: 'resolve', pnpmPath })
    const resolved = await readMetadata(path)
    const prepared = profile.metadata['pnpm-lock.yaml'] === undefined ? resolved
      : { ...resolved, 'pnpm-lock.yaml': normalizePreparedCohortLock(resolved['pnpm-lock.yaml'], path, profile.path, home) }
    assertMetadataDelta(profile.metadata, prepared, candidate.packages, oldHost.packages)
    if (profile.metadata['pnpm-lock.yaml'] !== undefined) {
      await runPnpm(['fetch', '--frozen-lockfile', '--ignore-scripts'], { cwd: path, env, signal, phase: 'fetch', pnpmPath })
      if (JSON.stringify(await readMetadata(path)) !== JSON.stringify(resolved)) fail(`fetch changed profile metadata: ${profile.name}`)
      await writeFile(join(path, 'pnpm-lock.yaml'), prepared['pnpm-lock.yaml'], { mode: 0o600 })
    }
    outputs.push({ name: profile.name, backupOf: profile.backupOf, fallbackOnly: profile.metadata['pnpm-lock.yaml'] === undefined,
      localCohortPins: await localCohortPins(home, profile.backupOf || profile.name),
      nonNativePackages: await nonNativePackages(profile.path), originalDigests: Object.fromEntries(Object.entries(profile.metadata).map(([k,v]) => [k, sourceDigest(v)])),
      preparedDigests: Object.fromEntries(Object.entries(prepared).map(([k,v]) => [k, sourceDigest(v)])) })
  }
  if (JSON.stringify((await inventory(home, approvedBackupNames)).map(x => [x.name, ...metadataNames.map(n => sourceDigest(x.metadata[n]))]))
    !== JSON.stringify(profiles.map(x => [x.name, ...metadataNames.map(n => sourceDigest(x.metadata[n]))]))) fail('original Home changed during preparation')
  return { schemaVersion: 1, originalHome: home, preparationRoot: root, storePath: join(root, 'store'), cachePath: join(root, 'cache'), oldHostRoot: oldHost.root, candidateHostRoot: candidate.root,
    candidateDshPath, candidateNative: candidate.packages, oldNative: oldHost.packages, approvedBackupNames, profiles: outputs }
}

/** Check staged metadata and package graph after offline materialization. */
export async function validateHostProfileUpdate({ preparation, stagedHome, authorizedPatchDigests = {} }) {
  yaml = loadYaml(preparation.candidateDshPath)
  semver = loadSemver(preparation.candidateDshPath)
  const stage = await canonicalDirectory(stagedHome)
  if (stage === preparation.originalHome || inside(preparation.originalHome, stage)) fail('stage overlaps original Home')
  const actual = await inventory(stage, preparation.approvedBackupNames)
  if (JSON.stringify(actual.map(x => x.name)) !== JSON.stringify(preparation.profiles.map(x => x.name))) fail('profile inventory changed')
  for (const profile of actual) {
    const expected = preparation.profiles.find(x => x.name === profile.name)
    const allowedPatch = authorizedPatchDigests[profile.name]
    if (allowedPatch !== undefined && (!/^[a-f0-9]{64}$/u.test(allowedPatch)
      || allowedPatch === expected.preparedDigests['cordis.patch.yml'])) fail(`authorized patch digest is invalid: ${profile.name}`)
    const cohort = profile.backupOf || profile.name
    if (JSON.stringify(await localCohortPins(preparation.originalHome, cohort)) !== JSON.stringify(expected.localCohortPins)
      || JSON.stringify(await localCohortPins(stage, cohort)) !== JSON.stringify(expected.localCohortPins)) fail(`local cohort bytes changed: ${profile.name}`)
    for (const name of metadataNames) if (sourceDigest(profile.metadata[name]) !== (name === 'cordis.patch.yml' && allowedPatch !== undefined
      ? allowedPatch : expected.preparedDigests[name])) fail(`staged metadata changed: ${profile.name}/${name}`)
    const original = await readMetadata(join(preparation.originalHome, 'profiles', profile.name))
    for (const name of metadataNames) if (sourceDigest(original[name]) !== expected.originalDigests[name]) fail(`original metadata changed: ${profile.name}/${name}`)
    assertMetadataDelta(original, { ...profile.metadata, 'cordis.patch.yml': original['cordis.patch.yml'] }, preparation.candidateNative, preparation.oldNative)
    await oldHostLinks(join(profile.path, 'node_modules'), preparation.oldHostRoot, preparation.candidateHostRoot, false)
    await oldHostLinks(join(profile.path, '.dsh-module-fallback', 'node_modules'), preparation.oldHostRoot, preparation.candidateHostRoot, false)
    if (expected.fallbackOnly) continue
    const modules = join(profile.path, 'node_modules', '.pnpm')
    if ((await stat(modules).catch(() => undefined))?.isDirectory() !== true) fail(`profile was not materialized: ${profile.name}`)
    if (JSON.stringify(await nonNativePackages(profile.path)) !== JSON.stringify(expected.nonNativePackages)) fail(`non-native package bytes changed: ${profile.name}`)
    for (const entry of await readdir(modules)) if (entry.startsWith('@deepseek-ai+')) {
      const match = /^@deepseek-ai\+([^@]+)@([^_(]+)/u.exec(entry)
      if (!match || preparation.candidateNative[`@deepseek-ai/${match[1]}`]?.version !== match[2]) fail(`stale native pnpm package: ${profile.name}/${entry}`)
    }
  }
  for (const name of Object.keys(authorizedPatchDigests)) if (!actual.some(profile => profile.name === name)) fail(`authorized patch profile is unknown: ${name}`)
  await oldHostLinks(join(stage, 'profiles', 'node_modules'), preparation.oldHostRoot, preparation.candidateHostRoot, false)
  return { schemaVersion: 1, profileNames: actual.map(x => x.name), metadataDigest: hash(JSON.stringify(preparation.profiles)),
    profiles: preparation.profiles.map(profile => ({ name: profile.name, backupOf: profile.backupOf,
      originalDigests: profile.originalDigests, preparedDigests: profile.preparedDigests,
      nonNativePackageDigest: hash(JSON.stringify(profile.nonNativePackages)),
      localCohortDigest: profile.localCohortPins === null ? null : hash(JSON.stringify(profile.localCohortPins)) })) }
}

/** Apply prepared metadata to a copied Home and materialize only in that stage. */
export async function materializeHostProfileUpdate({ preparation, stagedHome, logicalHome, signal, pnpmPath = 'pnpm', runPnpm, runCandidateDsh }) {
  yaml = loadYaml(preparation.candidateDshPath)
  if (typeof runPnpm !== 'function' || typeof runCandidateDsh !== 'function') fail('staged sandbox runners are required')
  const stage = await canonicalDirectory(stagedHome)
  if (!isAbsolute(logicalHome) || resolve(logicalHome) !== logicalHome || logicalHome !== preparation.originalHome) fail('logical Home differs from original')
  if (stage === logicalHome || inside(logicalHome, stage)) fail('stage overlaps original Home')
  const originals = await inventory(logicalHome, preparation.approvedBackupNames), staged = await inventory(stage, preparation.approvedBackupNames)
  if (JSON.stringify(originals.map(x => x.name)) !== JSON.stringify(preparation.profiles.map(x => x.name))
    || JSON.stringify(staged.map(x => x.name)) !== JSON.stringify(preparation.profiles.map(x => x.name))) fail('profile inventory changed')
  for (const profile of preparation.profiles) {
    const source = originals.find(x => x.name === profile.name), dest = staged.find(x => x.name === profile.name)
    for (const name of metadataNames) {
      if (sourceDigest(source.metadata[name]) !== profile.originalDigests[name] || sourceDigest(dest.metadata[name]) !== profile.originalDigests[name]) fail(`profile changed before stage installation: ${profile.name}/${name}`)
    }
    const prepared = await readMetadata(join(preparation.preparationRoot, profile.name))
    for (const name of metadataNames) if (sourceDigest(prepared[name]) !== profile.preparedDigests[name]) fail(`preparation changed: ${profile.name}/${name}`)
    await writeMetadata(dest.path, prepared)
    if (profile.fallbackOnly) continue
    await rm(join(dest.path, 'node_modules'), { recursive: true, force: true })
    const env = pnpmEnvironment(preparation.preparationRoot, { DSH_HOME: logicalHome, pnpm_config_offline: 'true',
      pnpm_config_frozen_lockfile: 'true', pnpm_config_package_import_method: 'copy' }, true)
    await runPnpm(['install', '--offline', '--frozen-lockfile', '--ignore-scripts'], { cwd: join(logicalHome, 'profiles', profile.name), env, signal, phase: 'materialize', pnpmPath })
  }
  await oldHostLinks(join(stage, 'profiles', 'node_modules'), preparation.oldHostRoot, preparation.candidateHostRoot, true)
  for (const profile of preparation.profiles) {
    const path = join(stage, 'profiles', profile.name)
    await oldHostLinks(join(path, 'node_modules'), preparation.oldHostRoot, preparation.candidateHostRoot, true)
    await oldHostLinks(join(path, '.dsh-module-fallback', 'node_modules'), preparation.oldHostRoot, preparation.candidateHostRoot, true)
  }
  for (const profile of preparation.profiles) if (profile.backupOf === undefined) {
    await runCandidateDsh(['--profile', profile.name, '--dump-config'], { env: { ...process.env, DSH_HOME: logicalHome }, signal, phase: 'fallback', profile: profile.name })
  }
  return validateHostProfileUpdate({ preparation, stagedHome: stage })
}
