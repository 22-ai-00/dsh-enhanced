import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const repositoryRequire = createRequire(import.meta.url)
const storageFields = new Set(['databasePath', 'statePath', 'stateRoot', 'vaultRoot', 'spoolPath', 'runsPath', 'catalogPath', 'trustPath', 'scratchPath'])
const trustedBundleName = /^@(?:deepseek-ai|dsh-enhanced)\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u
const lifecycleMarkers = new Map([
  ['dsh-enhanced-assistant-web-owner', 'web'],
  ['@dsh-enhanced/assistant-web-owner', 'web'],
  ['dsh-enhanced-assistant-isolation', 'isolation'],
  ['@dsh-enhanced/assistant-isolation', 'isolation'],
  ['dsh-enhanced-lark-channel', 'lark'],
  ['@dsh-enhanced/lark-channel', 'lark'],
  ['dsh-enhanced-assistant-recovery', 'supervised'],
  ['@dsh-enhanced/assistant-recovery', 'supervised'],
  ['dsh-enhanced-assistant-automations', 'supervised'],
  ['@dsh-enhanced/assistant-automations', 'supervised'],
  ['dsh-enhanced-assistant-evolution', 'supervised'],
  ['@dsh-enhanced/assistant-evolution', 'supervised'],
])

const prereleaseIdentifiers = value => {
  if (value === undefined) return undefined
  const identifiers = value.split('.')
  if (identifiers.some(identifier => identifier.length === 0 || !/^[0-9A-Za-z-]+$/u.test(identifier)
    || (/^\d+$/u.test(identifier) && !/^(0|[1-9]\d*)$/u.test(identifier)))) return undefined
  return identifiers
}

const comparePrerelease = (left, right) => {
  if (left === undefined) return right === undefined ? 0 : 1
  if (right === undefined) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index], b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const aNumeric = /^\d+$/u.test(a), bNumeric = /^\d+$/u.test(b)
    if (aNumeric && bNumeric) return BigInt(a) < BigInt(b) ? -1 : 1
    if (aNumeric) return -1
    if (bNumeric) return 1
    return a < b ? -1 : 1
  }
  return 0
}

const compatibleHostVersion = value => {
  if (typeof value !== 'string') return false
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(value)
  if (match === null) return false
  const [, major, minor, patch, prerelease] = match
  const patchNumber = Number(patch)
  if (Number(major) !== 0 || Number(minor) !== 1 || patchNumber < 2) return false
  const identifiers = prereleaseIdentifiers(prerelease)
  if (prerelease !== undefined && identifiers === undefined) return false
  // Match common.sh's SemVer range behavior exactly: the floor's same-core
  // comparator admits any later-precedence prerelease of 0.1.2, while later
  // patches remain restricted to the verified rc channel.
  if (prerelease === undefined) return true
  if (patchNumber === 2) return comparePrerelease(identifiers, ['rc', '1']) >= 0
  return identifiers[0] === 'rc'
}

async function hostRequire(dshExecutable) {
  const executable = await realpath(dshExecutable)
  const entryFor = async manifestPath => {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const bin = typeof manifest?.bin === 'string' ? manifest.bin : manifest?.bin?.dsh
    const packageRoot = await realpath(dirname(manifestPath))
    if (manifest?.name !== '@deepseek-ai/dsh' || !compatibleHostVersion(manifest.version) || typeof bin !== 'string' || bin.length === 0 || isAbsolute(bin)) return undefined
    const entry = resolve(packageRoot, bin)
    if (!inside(packageRoot, entry)) return undefined
    const canonicalEntry = await realpath(entry)
    return inside(packageRoot, canonicalEntry) ? canonicalEntry : undefined
  }
  const acceptCanonicalEntry = async candidate => {
    try {
      const manifestPath = await realpath(candidate), entry = await entryFor(manifestPath)
      return entry === executable ? createRequire(manifestPath) : undefined
    } catch { return undefined }
  }
  try {
    const resolved = createRequire(executable).resolve('@deepseek-ai/dsh/package.json')
    const accepted = await acceptCanonicalEntry(resolved)
    if (accepted !== undefined) return accepted
  } catch {}
  // An npm bin symlink can canonicalize directly to lib/bin.js while exports
  // hides package.json. Only its immediate package manifest is considered.
  const nearby = await acceptCanonicalEntry(join(dirname(dirname(executable)), 'package.json'))
  if (nearby !== undefined) return nearby
  // pnpm installs a shell wrapper in node_modules/.bin. Its static dsh entry
  // must be the canonical entry from the exact sibling Host package.
  if (basename(dirname(executable)) === '.bin') {
    try {
      const manifestPath = await realpath(join(dirname(dirname(executable)), '@deepseek-ai', 'dsh', 'package.json'))
      const entry = await entryFor(manifestPath)
      const source = await readFile(executable, 'utf8')
      const targets = [...source.matchAll(/exec\s+(?:node|"\$basedir\/node")\s+"\$basedir\/([^"\r\n]+)"\s+"\$@"/gu)]
        .map(match => resolve(dirname(executable), match[1]))
      if (entry !== undefined && targets.length === 2 && (await Promise.all(targets.map(target => realpath(target).catch(() => '')))).every(target => target === entry)) return createRequire(manifestPath)
    } catch {}
  }
  throw new Error('lifecycle configuration validation requires the yaml parser from this repository or the canonical DSH executable')
}

async function yamlModule(dshExecutable) {
  let resolved
  try {
    resolved = repositoryRequire.resolve('yaml')
  } catch {
    try { resolved = (await hostRequire(dshExecutable)).resolve('yaml') } catch {
      throw new Error('lifecycle configuration validation requires the yaml parser from this repository or the canonical DSH executable')
    }
  }
  try {
    return await import(pathToFileURL(resolved).href)
  } catch {
    throw new Error('lifecycle configuration validation could not load a structural YAML parser')
  }
}

async function canonicalPath(value) {
  let cursor = resolve(value)
  const suffix = []
  for (;;) {
    let stat
    try {
      stat = await lstat(cursor)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw new Error('path has no existing ancestor')
      suffix.unshift(basename(cursor))
      cursor = parent
      continue
    }
    if (stat.isSymbolicLink()) cursor = await realpath(cursor)
    else cursor = await realpath(cursor)
    return resolve(cursor, ...suffix)
  }
}

function inside(home, target) {
  return target === home || target.startsWith(home + sep)
}

function expressionRelative(value) {
  const matched = /^dshHomePath\((['"])([^'"\\]*)\1\)$/u.exec(value)
  if (matched === null) return undefined
  const relative = matched[2]
  if (relative === '' || isAbsolute(relative) || relative.split(/[\\/]/u).some(part => part === '' || part === '.' || part === '..')) return undefined
  return relative
}

function fail(row, field, problem) {
  throw new Error(`lifecycle configuration rejects ${row}.${field}: ${problem}`)
}

async function validatePath(node, row, field, home, yaml) {
  const taggedJs = node?.tag === 'tag:yaml.org,2002:js' || node?.tag === '!!js'
  const value = yaml.isScalar(node) ? node.value : undefined
  let target
  if (taggedJs) {
    const relative = typeof value === 'string' ? expressionRelative(value) : undefined
    if (relative === undefined) fail(row, field, 'only a non-empty relative dshHomePath expression is allowed')
    target = resolve(home, relative)
  } else {
    if ((field.endsWith('databasePath') || row === 'session-query-sqlite' && field === 'path') && value === ':memory:') return
    if (typeof value !== 'string' || !isAbsolute(value)) fail(row, field, 'must be an absolute path inside DSH_HOME or an approved dshHomePath expression')
    target = value
  }
  let canonical
  try {
    canonical = await canonicalPath(target)
  } catch {
    fail(row, field, 'contains an unresolved or broken filesystem path')
  }
  if (!inside(home, canonical)) fail(row, field, 'resolves outside canonical DSH_HOME')
}

function relevantField(row, field) {
  return storageFields.has(field) || (row === 'session-persistence-jsonl' || row === 'storage-json') && field === 'root' || row === 'session-query-sqlite' && field === 'path'
}

async function walk(node, row, prefix, home, yaml) {
  if (yaml.isAlias(node)) fail(row, prefix === '' ? 'config' : prefix, 'must not use YAML aliases')
  if (yaml.isMap(node)) {
    for (const pair of node.items) {
      const key = yaml.isScalar(pair.key) ? pair.key.value : undefined
      if (typeof key !== 'string') continue
      const field = prefix === '' ? key : `${prefix}.${key}`
      if (relevantField(row, key)) await validatePath(pair.value, row, field, home, yaml)
      await walk(pair.value, row, field, home, yaml)
    }
  } else if (yaml.isSeq(node)) {
    for (const item of node.items) await walk(item, row, prefix, home, yaml)
  }
}

export async function lifecycleWorkspacePaths(source, { dshExecutable } = {}) {
  const yaml = await yamlModule(dshExecutable)
  const document = yaml.parseDocument(source, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }],
    uniqueKeys: true,
  })
  if (document.errors.length > 0 || document.warnings.length > 0 || !yaml.isSeq(document.contents) || containsAlias(yaml, document.contents)) {
    throw new Error('lifecycle workspace paths require structurally valid YAML')
  }
  const paths = new Set()
  for (const item of document.contents.items) {
    if (!yaml.isMap(item)) throw new Error('lifecycle workspace paths require mapping rows')
    const id = item.get('id'), name = item.get('name'), disabled = item.get('disabled')
    const idKind = lifecycleMarkers.get(id), nameKind = lifecycleMarkers.get(name)
    if (idKind !== undefined && nameKind !== undefined && idKind !== nameKind) {
      throw new Error('lifecycle workspace paths reject conflicting id and name markers')
    }
    if ((idKind ?? nameKind) !== 'web' || disabled === true) continue
    if (disabled !== undefined && typeof disabled !== 'boolean') {
      throw new Error('lifecycle workspace paths require boolean disabled fields for web owner rows')
    }
    const config = item.get('config')
    if (config === undefined) continue
    if (!yaml.isMap(config)) throw new Error('lifecycle workspace paths require web owner config mappings')
    const workspace = config.get('workspace', true)
    if (workspace === undefined) continue
    if (yaml.isAlias(workspace) || workspace?.tag === 'tag:yaml.org,2002:js' || workspace?.tag === '!!js'
      || !yaml.isScalar(workspace) || typeof workspace.value !== 'string' || !isAbsolute(workspace.value)) {
      throw new Error('lifecycle workspace paths require ordinary absolute web owner workspace paths')
    }
    paths.add(workspace.value)
  }
  return [...paths].sort()
}

export async function validateLifecycleConfig(source, { dshHome, dshExecutable } = {}) {
  const yaml = await yamlModule(dshExecutable)
  let home
  try {
    home = await canonicalPath(dshHome)
  } catch {
    throw new Error('lifecycle configuration validation requires an existing DSH_HOME')
  }
  const document = yaml.parseDocument(source, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }],
    uniqueKeys: true,
  })
  if (document.errors.length > 0 || document.warnings.length > 0 || !yaml.isSeq(document.contents)) {
    throw new Error('lifecycle configuration is not structurally valid YAML')
  }
  for (const item of document.contents.items) {
    if (!yaml.isMap(item)) throw new Error('lifecycle configuration rows must be mappings and must not use YAML aliases')
    const id = item.get('id'), name = item.get('name'), disabled = item.get('disabled')
    const idKind = lifecycleMarkers.get(id), nameKind = lifecycleMarkers.get(name)
    if ((idKind !== undefined || nameKind !== undefined) && disabled !== undefined && typeof disabled !== 'boolean') {
      throw new Error('lifecycle scenario row disabled field must be boolean')
    }
    if (disabled === true) continue
    if (typeof id !== 'string') throw new Error('lifecycle configuration rows must have string id fields')
    if (typeof name !== 'string' || !trustedBundleName.test(name)) {
      throw new Error(`lifecycle configuration rejects enabled non-first-party row ${id}`)
    }
    const config = item.get('config')
    if (config !== undefined) await walk(config, id, '', home, yaml)
  }
}

export async function classifyLifecycleScenario(source, { dshExecutable } = {}) {
  const yaml = await yamlModule(dshExecutable)
  const document = yaml.parseDocument(source, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }],
    uniqueKeys: true,
  })
  if (document.errors.length > 0 || document.warnings.length > 0 || !yaml.isSeq(document.contents)) {
    throw new Error('lifecycle configuration is not structurally valid YAML')
  }
  const active = { web: new Set(), isolation: new Set(), lark: new Set(), supervised: new Set() }
  let larkRowCount = 0
  for (const item of document.contents.items) {
    if (!yaml.isMap(item)) throw new Error('lifecycle scenario configuration rows must be mappings')
    const id = item.get('id'), name = item.get('name'), disabled = item.get('disabled')
    const idKind = lifecycleMarkers.get(id), nameKind = lifecycleMarkers.get(name)
    if (idKind !== undefined && nameKind !== undefined && idKind !== nameKind) {
      throw new Error('lifecycle scenario row has conflicting id and name markers')
    }
    const kind = idKind ?? nameKind
    if (kind !== undefined && disabled !== undefined && typeof disabled !== 'boolean') {
      throw new Error('lifecycle scenario row disabled field must be boolean')
    }
    if (disabled === true) continue
    if (typeof id !== 'string' || typeof name !== 'string') {
      throw new Error('active lifecycle scenario rows must have string id and name fields')
    }
    if (kind === undefined) continue
    const marker = `${id}\0${name}`
    if (active[kind].has(marker)) throw new Error(`lifecycle scenario contains a duplicate active ${kind} row`)
    if (kind === 'lark') {
      larkRowCount += 1
      if (larkRowCount > 1) throw new Error('lifecycle scenario contains ambiguous Lark rows')
      const config = item.get('config')
      if (!yaml.isMap(config) || typeof config.get('enabled') !== 'boolean') {
        throw new Error('active Lark lifecycle row must have a structural boolean config.enabled field')
      }
      if (config.get('enabled') === false) continue
    }
    active[kind].add(marker)
  }
  if (active.web.size > 1 || active.isolation.size > 1 || active.lark.size > 1) {
    throw new Error('lifecycle scenario contains duplicate active scenario rows')
  }
  const web = active.web.size === 1
  const isolation = active.isolation.size === 1
  const lark = active.lark.size === 1
  if (lark && (web || isolation)) throw new Error('lifecycle scenario mixes active Lark and web/isolation rows')
  if (isolation && !web) throw new Error('lifecycle autonomy scenario requires an active web owner row')
  if (active.supervised.size > 0) return 'supervised'
  if (lark) return 'lark'
  if (isolation) return 'autonomy'
  if (web) return 'web'
  return 'unsupported'
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const classify = args[0] === 'classify'
  const [sourcePath, dshHome, dshExecutable] = classify ? [args[1], undefined, args[2]] : args
  if (sourcePath === undefined || dshExecutable === undefined || (!classify && dshHome === undefined)) {
    process.stderr.write('usage: lifecycle-config.mjs [classify] <dump-config.yml> [<dsh-home>] <dsh-executable>\n')
    process.exitCode = 2
  } else if (classify) {
    classifyLifecycleScenario(await readFile(sourcePath, 'utf8'), { dshExecutable }).then(scenario => {
      process.stdout.write(`${scenario}\n`)
    }).catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : 'lifecycle scenario classification failed'}\n`)
      process.exitCode = 1
    })
  } else {
    validateLifecycleConfig(await readFile(sourcePath, 'utf8'), { dshHome, dshExecutable }).catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : 'lifecycle configuration validation failed'}\n`)
      process.exitCode = 1
    })
  }
}

const exactSemver = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
const enhancedPackage = /^@dsh-enhanced\/[a-z0-9][a-z0-9._-]*$/u

function metadataError(message) {
  throw new Error(`lifecycle npm metadata rejects ${message}`)
}

function plainRecord(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) metadataError(`${field} must be an object`)
  return value
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function exactPackageVersion(value, field) {
  if (typeof value !== 'string') metadataError(`${field} must be an exact @dsh-enhanced package version`)
  const split = value.indexOf('@', 1)
  if (split === -1) metadataError(`${field} must be an exact @dsh-enhanced package version`)
  const name = value.slice(0, split), version = value.slice(split + 1)
  if (!enhancedPackage.test(name) || !exactSemver.test(version)) metadataError(`${field} must be an exact @dsh-enhanced package version`)
  return { name, version }
}

function packageTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0) metadataError('targets must be a non-empty list')
  const byName = new Map()
  for (const target of targets) {
    const parsed = exactPackageVersion(target, 'target')
    const existing = byName.get(parsed.name)
    if (existing !== undefined && existing !== parsed.version) metadataError(`targets conflict for ${parsed.name}`)
    byName.set(parsed.name, parsed.version)
  }
  return byName
}

function parseMetadataJson(source, field) {
  if (typeof source !== 'string') metadataError(`${field} must be text`)
  try { return plainRecord(JSON.parse(source), field) } catch { metadataError(`${field} is not valid JSON`) }
}

function manifestWithoutDependencies(manifest) {
  const { dependencies: _dependencies, ...rest } = manifest
  return rest
}

function assertPreparedManifest(originalSource, preparedSource, targets) {
  const original = parseMetadataJson(originalSource, 'original package.json')
  const prepared = parseMetadataJson(preparedSource, 'prepared package.json')
  if (!sameJson(manifestWithoutDependencies(original), manifestWithoutDependencies(prepared))) {
    metadataError('prepared package.json changes fields outside dependencies')
  }
  const originalDependencies = original.dependencies === undefined ? {} : plainRecord(original.dependencies, 'original package.json dependencies')
  const preparedDependencies = prepared.dependencies === undefined ? {} : plainRecord(prepared.dependencies, 'prepared package.json dependencies')
  for (const [name, version] of targets) {
    if (!(name in originalDependencies)) metadataError(`original package.json does not contain authorized target ${name}`)
    if (preparedDependencies[name] !== version) metadataError(`prepared package.json does not pin ${name} to its authorized target`)
  }
  for (const name of new Set([...Object.keys(originalDependencies), ...Object.keys(preparedDependencies)])) {
    if (!targets.has(name) && !sameJson(originalDependencies[name], preparedDependencies[name])) {
      metadataError(`prepared package.json changes unmanaged dependency ${name}`)
    }
  }
  return { original, prepared }
}

function containsAlias(yaml, node) {
  if (yaml.isAlias(node)) return true
  if (yaml.isMap(node)) return node.items.some(pair => containsAlias(yaml, pair.key) || containsAlias(yaml, pair.value))
  if (yaml.isSeq(node)) return node.items.some(item => containsAlias(yaml, item))
  return false
}

const rsiProfilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const rsiCoordinatorBundles = new Map([
  ['dsh-enhanced-assistant-policy', '@dsh-enhanced/assistant-policy'],
  ['dsh-enhanced-assistant-automations', '@dsh-enhanced/assistant-automations'],
  ['dsh-enhanced-plugin-control-plane', '@dsh-enhanced/plugin-control-plane'],
])

function rsiPairError(message) {
  throw new Error(`lifecycle RSI coordinator rejects ${message}`)
}

function rsiProfile(value, field) {
  if (typeof value !== 'string' || !rsiProfilePattern.test(value)) rsiPairError(`invalid ${field}`)
  return value
}

function rsiRecord(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) rsiPairError(`${field} must be a mapping`)
  return value
}

function rsiFinite(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) rsiPairError(`${field} must be a finite positive integer`)
}

/** The installer writes this private, per-target receipt before creating its coordinator. */
export async function readRsiCoordinatorReceipt({ homePath, profile }) {
  rsiProfile(profile, 'target profile')
  if (typeof homePath !== 'string' || !isAbsolute(homePath) || resolve(homePath) !== homePath) rsiPairError('invalid DSH_HOME')
  const relativePath = `.rsi-coordinator-${createHash('sha256').update(profile).digest('hex').slice(0, 16)}.json`
  const path = join(homePath, relativePath)
  let descriptor
  try { descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) {
    if (error?.code === 'ENOENT') return undefined
    rsiPairError(`unsafe receipt ${relativePath}`)
  }
  let source
  try {
    const before = await descriptor.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 65_536 || before.mode & 0o077
      || typeof process.getuid === 'function' && before.uid !== process.getuid()) rsiPairError('unsafe receipt file')
    const bytes = await descriptor.readFile()
    const after = await descriptor.stat(), named = await lstat(path)
    if (bytes.length !== before.size || !after.isFile() || after.nlink !== 1 || named.nlink !== 1 || named.isSymbolicLink()
      || after.mode & 0o077 || typeof process.getuid === 'function' && after.uid !== process.getuid()
      || before.dev !== after.dev || before.ino !== after.ino || before.dev !== named.dev || before.ino !== named.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      rsiPairError('receipt changed during read')
    }
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { rsiPairError('receipt is not UTF-8') }
  } finally { await descriptor.close() }
  let receipt
  try { receipt = JSON.parse(source) } catch { rsiPairError('malformed receipt JSON') }
  rsiRecord(receipt, 'receipt')
  if (!isDeepStrictEqual(Object.keys(receipt).sort(), ['coordinatorProfile', 'schemaVersion', 'sourceRepository', 'targetProfile', 'version'])) {
    rsiPairError('receipt fields differ from installer schema')
  }
  if (receipt.schemaVersion !== 1 || receipt.targetProfile !== profile) rsiPairError('receipt schema or target profile mismatch')
  const coordinatorProfile = rsiProfile(receipt.coordinatorProfile, 'coordinator profile')
  if (coordinatorProfile === profile) rsiPairError('coordinator profile equals target')
  const prerelease = typeof receipt.version === 'string' ? receipt.version.split('+', 1)[0].split('-', 2)[1] : undefined
  if (typeof receipt.version !== 'string' || !exactSemver.test(receipt.version)
    || prerelease !== undefined && prereleaseIdentifiers(prerelease) === undefined) {
    rsiPairError('receipt version must be exact SemVer')
  }
  if (receipt.sourceRepository !== null && (typeof receipt.sourceRepository !== 'string'
    || !isAbsolute(receipt.sourceRepository) || resolve(receipt.sourceRepository) !== receipt.sourceRepository
    || await canonicalPath(receipt.sourceRepository) !== receipt.sourceRepository)) rsiPairError('sourceRepository must be canonical absolute or null')
  return { relativePath, source, coordinatorProfile, version: receipt.version, sourceRepository: receipt.sourceRepository }
}

function rsiYamlRows(yaml, source, field, base = false) {
  if (typeof source !== 'string') rsiPairError(`${field} must be YAML text`)
  const document = yaml.parseDocument(source, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }], uniqueKeys: true,
  })
  if (document.errors.length || document.warnings.length || !yaml.isSeq(document.contents) || containsAlias(yaml, document.contents)) {
    rsiPairError(`${field} is not structurally valid YAML`)
  }
  const rows = new Map()
  const insert = operation => {
    if (!yaml.isMap(operation) || operation.items.length !== 1 || !operation.has('insert')) rsiPairError(`${field} has unsupported base operation`)
    const inserted = operation.get('insert', true)
    if (!yaml.isSeq(inserted)) rsiPairError(`${field} insert must be a sequence`)
    return inserted.items
  }
  for (const item of document.contents.items.flatMap(operation => base ? insert(operation) : [operation])) {
    if (!yaml.isMap(item)) rsiPairError(`${field} contains a non-mapping row`)
    const id = item.get('id'), name = item.get('name'), disabled = item.get('disabled'), disabledNode = item.get('disabled', true)
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !name || rows.has(id)) rsiPairError(`${field} contains invalid or duplicate rows`)
    const expressionDisabled = yaml.isScalar(disabledNode) && disabledNode.tag === 'tag:yaml.org,2002:js' && typeof disabled === 'string'
    if (disabled !== undefined && typeof disabled !== 'boolean' && !expressionDisabled) rsiPairError(`${field}.${id} has invalid disabled status`)
    rows.set(id, { name, disabled, config: item.toJSON().config, configNode: item.get('config', true) })
  }
  if (rows.size === 0) rsiPairError(`${field} has no rows`)
  return rows
}

function rsiNoNestedPlugins(value, field) {
  if (value === null || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'plugins' && (Array.isArray(nested) ? nested.length > 0 : nested !== undefined && nested !== null)) rsiPairError(`${field} has nested plugins`)
    rsiNoNestedPlugins(nested, `${field}.${key}`)
  }
}

/** Read-only cross-profile check before the caller changes either Host. */
export async function validateRsiCoordinatorPair(targetSource, coordinatorSource, { dshHome, targetProfile, coordinatorProfile, coordinatorBaseSource, dshExecutable }) {
  rsiProfile(targetProfile, 'target profile')
  rsiProfile(coordinatorProfile, 'coordinator profile')
  if (targetProfile === coordinatorProfile) rsiPairError('target and coordinator profiles must differ')
  if (typeof dshHome !== 'string' || !isAbsolute(dshHome) || resolve(dshHome) !== dshHome) rsiPairError('invalid DSH_HOME')
  const yaml = await yamlModule(dshExecutable)
  const base = rsiYamlRows(yaml, coordinatorBaseSource, 'coordinator base', true)
  const target = rsiYamlRows(yaml, targetSource, 'target profile')
  const coordinator = rsiYamlRows(yaml, coordinatorSource, 'coordinator profile')
  for (const [id, { name, disabled, config }] of coordinator) {
    const expected = rsiCoordinatorBundles.get(id) ?? base.get(id)?.name
    if (name !== expected || /lark/iu.test(id) || /lark/iu.test(name)) rsiPairError(`coordinator contains forbidden row ${id}`)
    if (rsiCoordinatorBundles.has(id) && disabled !== undefined && disabled !== false) rsiPairError(`coordinator enhanced row ${id} is disabled`)
    rsiNoNestedPlugins(config, `coordinator.${id}`)
    if (rsiCoordinatorBundles.has(id) && config?.enabled === false) rsiPairError(`coordinator.${id} is disabled`)
    if (id === 'agent-loop' && (!Array.isArray(rsiRecord(config, 'agent-loop config').agents) || config.agents.length)) {
      rsiPairError('coordinator agent-loop.agents must be empty')
    }
  }
  for (const id of rsiCoordinatorBundles.keys()) {
    if (!coordinator.has(id)) rsiPairError(`coordinator lacks required row ${id}`)
  }
  const targetControlPlane = target.get('dsh-enhanced-plugin-control-plane')
  if (targetControlPlane?.name !== '@dsh-enhanced/plugin-control-plane'
    || targetControlPlane.disabled !== undefined && targetControlPlane.disabled !== false) {
    rsiPairError('target control plane is missing, renamed or disabled')
  }
  const targetCp = rsiRecord(target.get('dsh-enhanced-plugin-control-plane')?.config, 'target control plane')
  const coordinatorCp = rsiRecord(coordinator.get('dsh-enhanced-plugin-control-plane')?.config, 'coordinator control plane')
  const adoptions = rsiRecord(targetCp.sourceAdoptions, 'target sourceAdoptions')
  const jobs = rsiRecord(targetCp.sourceJobs, 'target sourceJobs')
  const adoption = rsiRecord(coordinatorCp.adoptionCoordinator, 'coordinator adoptionCoordinator')
  const scope = rsiRecord(adoption.scope, 'coordinator adoption scope')
  if (targetCp.adoptionCoordinator !== undefined && targetCp.adoptionCoordinator !== null) rsiPairError('target control plane enables adoptionCoordinator')
  if (adoptions.profile !== targetProfile || typeof adoptions.handoff?.coordinatorId !== 'string' || !adoptions.handoff.coordinatorId
    || adoptions.handoff.coordinatorId !== adoption.coordinatorId) rsiPairError('target handoff and coordinator adoption disagree')
  rsiFinite(jobs.budgetAmount, 'target sourceJobs.budgetAmount')
  if (!isDeepStrictEqual(scope, { ownerRouteId: jobs.ownerRouteId, principalId: jobs.principalId, workspace: jobs.workspace, preset: jobs.preset })
    || Object.values(scope).some(value => typeof value !== 'string' || !value)) rsiPairError('coordinator owner scope differs from target source jobs')
  if (typeof targetCp.catalogPath !== 'string' || typeof targetCp.trustPath !== 'string'
    || coordinatorCp.catalogPath !== targetCp.catalogPath || coordinatorCp.trustPath !== targetCp.trustPath) rsiPairError('coordinator catalog or trust path differs from target')
  const root = join(dshHome, 'rsi-coordinators', coordinatorProfile)
  if (coordinatorCp.statePath !== root) rsiPairError('coordinator statePath differs from dedicated root')
  const policy = rsiRecord(coordinator.get('dsh-enhanced-assistant-policy')?.config, 'coordinator Policy config')
  const automations = rsiRecord(coordinator.get('dsh-enhanced-assistant-automations')?.config, 'coordinator Automations config')
  if (policy.databasePath !== join(root, 'policy.sqlite') || automations.databasePath !== join(root, 'automations.sqlite')
    || automations.runsPath !== join(root, 'runs')) rsiPairError('coordinator storage differs from dedicated root')
  if (automations.schedulerEnabled !== true || automations.allowUnbudgetedExecution === true) rsiPairError('coordinator scheduler or budget admission is unsafe')
  for (const field of ['sourceJobs', 'sourceBuild', 'sourceApprovals', 'sourceReleases', 'sourceReleaseExecution', 'sourceAdoptions',
    'runtimeObserver', 'foregroundDeployments', 'taskObservations', 'liveQualification', 'replayEndpoint']) {
    if (coordinatorCp[field] !== undefined && coordinatorCp[field] !== null) rsiPairError(`coordinator control plane enables ${field}`)
  }
  rsiFinite(adoption.timeoutMs, 'coordinator timeoutMs')
  rsiFinite(adoption.budgetAmount, 'coordinator budgetAmount')
  if (typeof adoption.budgetId !== 'string' || !adoption.budgetId) rsiPairError('coordinator budgetId is invalid')
  const matchingBudgets = Array.isArray(policy.budgets) ? policy.budgets.filter(entry => entry?.id === adoption.budgetId) : []
  if (matchingBudgets.length !== 1 || matchingBudgets[0].metric !== 'automation-runs' || matchingBudgets[0].scope !== 'subject'
    || !Number.isSafeInteger(matchingBudgets[0].limit) || matchingBudgets[0].limit < adoption.budgetAmount
    || !Number.isSafeInteger(matchingBudgets[0].periodMs) || matchingBudgets[0].periodMs < 1_000) {
    rsiPairError('coordinator Policy lacks a unique finite automation budget')
  }
  const preview = yaml.parseDocument('- id: dsh-enhanced-assistant-automations\n')
  const previewConfig = coordinator.get('dsh-enhanced-assistant-automations').configNode.clone()
  previewConfig.set('schedulerEnabled', false)
  preview.contents.items[0].set('config', previewConfig)
  return { scope, coordinatorId: adoption.coordinatorId, previewPatch: preview.toString({ lineWidth: 0 }) }
}

function parseYamlDocument(yaml, source, field) {
  if (typeof source !== 'string') metadataError(`${field} must be text`)
  const document = yaml.parseDocument(source, { uniqueKeys: true })
  if (document.errors.length > 0 || document.warnings.length > 0 || !yaml.isMap(document.contents) || containsAlias(yaml, document.contents)) {
    metadataError(`${field} is not structurally valid YAML`)
  }
  return document
}

function yamlObject(document, field) {
  try { return plainRecord(document.toJS({ maxAliasCount: 0 }), field) } catch { metadataError(`${field} is not structurally valid YAML`) }
}

function dependencyReference(value) {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && typeof value.version === 'string') return value.version
  return undefined
}

function lockKey(name, reference) {
  return `${name}@${reference}`
}

function parseLockKey(value) {
  if (typeof value !== 'string') return undefined
  const split = value.startsWith('@') ? value.indexOf('@', value.indexOf('/') + 1) : value.indexOf('@')
  if (split <= 0) return undefined
  const name = value.slice(0, split)
  const version = /^(?<version>[^()]+)(?:\(|$)/u.exec(value.slice(split + 1))?.groups?.version
  if (version === undefined || !exactSemver.test(version)) return undefined
  return { name, version }
}

function lockDependencies(node) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return []
  return ['dependencies', 'optionalDependencies'].flatMap(field => {
    const dependencies = node[field]
    return dependencies !== null && typeof dependencies === 'object' && !Array.isArray(dependencies)
      ? Object.entries(dependencies).flatMap(([name, reference]) => {
        const version = dependencyReference(reference)
        return version === undefined ? [] : [[name, version]]
      })
      : []
  })
}

function lockClosure(lockfile) {
  const packages = plainRecord(lockfile.packages ?? {}, 'prepared lockfile packages')
  const snapshots = plainRecord(lockfile.snapshots ?? {}, 'prepared lockfile snapshots')
  const nodes = new Map([...Object.entries(packages), ...Object.entries(snapshots)])
  const importers = plainRecord(lockfile.importers ?? {}, 'prepared lockfile importers')
  const queue = []
  for (const importer of Object.values(importers)) {
    if (importer === null || typeof importer !== 'object' || Array.isArray(importer)) metadataError('prepared lockfile importer must be an object')
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const dependencies = importer[field]
      if (dependencies === undefined) continue
      if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) metadataError(`prepared lockfile importer ${field} must be an object`)
      for (const [name, value] of Object.entries(dependencies)) {
        const version = dependencyReference(value)
        if (version !== undefined) queue.push(lockKey(name, version))
      }
    }
  }
  const visited = new Set()
  const closure = new Map()
  while (queue.length > 0) {
    const key = queue.pop()
    if (key === undefined || visited.has(key)) continue
    visited.add(key)
    const node = nodes.get(key)
    if (node === undefined) continue
    const parsed = parseLockKey(key)
    if (parsed !== undefined) closure.set(`${parsed.name}@${parsed.version}`, parsed)
    for (const [name, reference] of lockDependencies(node)) queue.push(lockKey(name, reference))
  }
  return closure
}

function importerDependencies(lockfile, field) {
  const importers = plainRecord(lockfile.importers ?? {}, field)
  const entries = []
  for (const [importerName, importer] of Object.entries(importers)) {
    if (importer === null || typeof importer !== 'object' || Array.isArray(importer)) metadataError(`${field} importer must be an object`)
    for (const dependencyField of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const dependencies = importer[dependencyField]
      if (dependencies === undefined) continue
      if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) metadataError(`${field} importer dependencies must be an object`)
      for (const [name, value] of Object.entries(dependencies)) entries.push({ importerName, dependencyField, name, value })
    }
  }
  return entries
}

function assertUnmanagedImportersUnchanged(original, prepared, targets) {
  const keyOf = entry => `${entry.importerName}\0${entry.dependencyField}\0${entry.name}`
  const originalEntries = new Map(importerDependencies(original, 'original lockfile').map(entry => [keyOf(entry), entry]))
  const preparedEntries = new Map(importerDependencies(prepared, 'prepared lockfile').map(entry => [keyOf(entry), entry]))
  for (const key of new Set([...originalEntries.keys(), ...preparedEntries.keys()])) {
    const before = originalEntries.get(key), after = preparedEntries.get(key)
    const candidate = after ?? before
    const targetDelta = candidate?.importerName === '.' && candidate.dependencyField === 'dependencies' && targets.has(candidate.name)
    if (targetDelta) continue
    if (!sameJson(before?.value, after?.value)) {
      const name = after?.name ?? before?.name ?? 'unknown'
      metadataError(`prepared lockfile changes unmanaged importer dependency ${name}`)
    }
  }
}

function assertImporterGraphFromManifest(preparedLock, originalManifest, preparedManifest, targets) {
  const importers = plainRecord(preparedLock.importers ?? {}, 'prepared lockfile importers')
  if (JSON.stringify(Object.keys(importers).sort()) !== JSON.stringify(['.'])) {
    metadataError('prepared lockfile adds an importer without an original lockfile')
  }
  const importer = plainRecord(importers['.'], 'prepared lockfile root importer')
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const source = originalManifest[field] === undefined ? {} : plainRecord(originalManifest[field], `original package.json ${field}`)
    const preparedSource = preparedManifest[field] === undefined ? {} : plainRecord(preparedManifest[field], `prepared package.json ${field}`)
    const entries = importer[field] === undefined ? {} : plainRecord(importer[field], `prepared lockfile root ${field}`)
    const expectedNames = Object.keys(source).sort()
    if (JSON.stringify(Object.keys(entries).sort()) !== JSON.stringify(expectedNames)) {
      metadataError(`prepared lockfile root ${field} does not match original package.json`)
    }
    for (const name of expectedNames) {
      const reference = dependencyReference(entries[name])
      const specifier = entries[name] !== null && typeof entries[name] === 'object' && !Array.isArray(entries[name]) ? entries[name].specifier : reference
      const expected = targets.has(name) && field === 'dependencies' ? targets.get(name) : preparedSource[name]
      if (specifier !== expected) metadataError(`prepared lockfile root ${field} does not retain ${name}`)
    }
  }
}

function assertTargetRootImporter(prepared, targets) {
  const importer = plainRecord(prepared.importers ?? {}, 'prepared lockfile importers')['.']
  if (importer === null || typeof importer !== 'object' || Array.isArray(importer)) metadataError('prepared lockfile requires a root importer')
  const dependencies = plainRecord(importer.dependencies ?? {}, 'prepared lockfile root dependencies')
  for (const [name, version] of targets) {
    const entry = dependencies[name]
    const reference = dependencyReference(entry)
    const specifier = entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry.specifier : version
    if (specifier !== version || reference === undefined || (reference !== version && !reference.startsWith(`${version}(`))) {
      metadataError(`prepared lockfile root importer does not pin ${name} to its authorized target`)
    }
  }
}

function exactPolicyRule(value) {
  if (typeof value !== 'string') return undefined
  const split = value.indexOf('@', 1)
  if (split === -1) return undefined
  const name = value.slice(0, split)
  const parts = value.slice(split + 1).split('||').map(part => part.trim())
  if (name === '' || parts.length === 0 || parts.some(part => !exactSemver.test(part))) return undefined
  return { name, versions: parts }
}

function exactAuthorizedAddition(value, authorizedClosure, cohortVersions) {
  const rule = exactPolicyRule(value)
  return rule !== undefined && rule.versions.length === 1 && authorizedClosure.has(rule.name) && cohortVersions.has(rule.versions[0])
}

function assertWorkspaceExclusionDelta(originalWorkspace, preparedWorkspace, authorizedClosure, cohortVersions) {
  const originalExcludes = originalWorkspace?.minimumReleaseAgeExclude ?? []
  const preparedExcludes = preparedWorkspace.minimumReleaseAgeExclude ?? []
  if (!Array.isArray(originalExcludes) || originalExcludes.some(value => typeof value !== 'string')) {
    metadataError('original workspace minimumReleaseAgeExclude must be a string list')
  }
  if (!Array.isArray(preparedExcludes) || preparedExcludes.some(value => typeof value !== 'string')) {
    metadataError('prepared workspace minimumReleaseAgeExclude must be a string list')
  }
  if (preparedExcludes.length < originalExcludes.length || originalExcludes.some((value, index) => preparedExcludes[index] !== value)) {
    metadataError('prepared workspace must retain original minimumReleaseAgeExclude entries as an ordered prefix')
  }
  const additions = preparedExcludes.slice(originalExcludes.length)
  if (preparedWorkspace.minimumReleaseAgeStrict === true && additions.length > 0) {
    metadataError('strict minimum release age forbids adding age exceptions')
  }
  for (const value of additions) {
    if (!exactAuthorizedAddition(value, authorizedClosure, cohortVersions)) {
      metadataError(`prepared workspace adds unauthorized age exclusion ${value}`)
    }
  }
}

function normalizeAgeExcludes(document, workspace, authorizedClosure, cohortVersions) {
  const excludes = workspace.minimumReleaseAgeExclude
  if (excludes === undefined) return undefined
  const grouped = new Map()
  for (const [index, value] of excludes.entries()) {
    const parsed = exactPolicyRule(value)
    const name = typeof value === 'string' ? value.slice(0, value.indexOf('@', 1)) : ''
    if (authorizedClosure.has(name) && parsed === undefined) metadataError(`prepared workspace has unsupported age exclusion for ${name}`)
    if (parsed !== undefined && authorizedClosure.has(parsed.name)) {
      const group = grouped.get(parsed.name) ?? []
      group.push({ index, ...parsed })
      grouped.set(parsed.name, group)
    }
  }
  const normalized = [...excludes]
  let changed = false
  for (const [name, rules] of grouped) {
    const currentVersions = new Set([...cohortVersions].filter(version => rules.some(rule => rule.versions.includes(version))))
    if (currentVersions.size === 0) continue
    const first = rules[0]
    const versions = [...new Set([...first.versions, ...currentVersions])]
    if (versions.length === first.versions.length) continue
    if (workspace.minimumReleaseAgeStrict === true) metadataError(`strict minimum release age forbids normalizing ${name}`)
    normalized[first.index] = `${name}@${versions.join(' || ')}`
    changed = true
  }
  if (!changed) return undefined
  document.set('minimumReleaseAgeExclude', normalized)
  return document.toString()
}

export async function prepareLifecycleNpmMetadata({ original, prepared, targets, dshExecutable }) {
  if (original === null || typeof original !== 'object' || prepared === null || typeof prepared !== 'object') {
    metadataError('original and prepared metadata must be objects')
  }
  if (typeof prepared.lockfile !== 'string' || typeof prepared.workspace !== 'string') {
    metadataError('prepared metadata requires lockfile and workspace')
  }
  const targetVersions = packageTargets(targets)
  const manifests = assertPreparedManifest(original.packageJson, prepared.packageJson, targetVersions)
  const yaml = await yamlModule(dshExecutable)
  const preparedLock = yamlObject(parseYamlDocument(yaml, prepared.lockfile, 'prepared lockfile'), 'prepared lockfile')
  if (typeof original.lockfile === 'string') {
    const originalLock = yamlObject(parseYamlDocument(yaml, original.lockfile, 'original lockfile'), 'original lockfile')
    assertUnmanagedImportersUnchanged(originalLock, preparedLock, targetVersions)
  } else {
    assertImporterGraphFromManifest(preparedLock, manifests.original, manifests.prepared, targetVersions)
  }
  assertTargetRootImporter(preparedLock, targetVersions)
  const closure = lockClosure(preparedLock)
  const cohortVersions = new Set(targetVersions.values())
  const authorizedClosure = new Set()
  for (const { name, version } of closure.values()) {
    if (enhancedPackage.test(name) && cohortVersions.has(version)) authorizedClosure.add(name)
  }
  for (const [name, version] of targetVersions) {
    if (!closure.has(`${name}@${version}`)) metadataError(`prepared lockfile does not close authorized target ${name}@${version}`)
  }
  const originalWorkspaceDocument = original.workspace === undefined ? undefined : parseYamlDocument(yaml, original.workspace, 'original workspace')
  const preparedWorkspaceDocument = parseYamlDocument(yaml, prepared.workspace, 'prepared workspace')
  const preparedWorkspace = yamlObject(preparedWorkspaceDocument, 'prepared workspace')
  const originalWorkspace = originalWorkspaceDocument === undefined ? undefined : yamlObject(originalWorkspaceDocument, 'original workspace')
  if (originalWorkspace !== undefined) {
    const { minimumReleaseAgeExclude: _originalExcludes, ...originalRest } = originalWorkspace
    const { minimumReleaseAgeExclude: _preparedExcludes, ...preparedRest } = preparedWorkspace
    if (!sameJson(originalRest, preparedRest)) metadataError('prepared workspace changes fields outside minimumReleaseAgeExclude')
  }
  assertWorkspaceExclusionDelta(originalWorkspace, preparedWorkspace, authorizedClosure, cohortVersions)
  const workspace = normalizeAgeExcludes(preparedWorkspaceDocument, preparedWorkspace, authorizedClosure, cohortVersions)
  return { packageJson: prepared.packageJson, lockfile: prepared.lockfile, workspace: workspace ?? prepared.workspace }
}


function unsafeRuntimeConfig(value, field) {
  if (value !== undefined) metadataError(`${field} is not supported before lifecycle pnpm execution`)
}

function assertNoConfigDependencies(value, field) {
  if (value !== undefined) metadataError(`${field} is not supported before lifecycle pnpm execution`)
}

function assertNoConfigDependencyEnvironment() {
  for (const [key, value] of Object.entries(process.env)) {
    const normalized = key.toLowerCase().replaceAll('-', '_')
    if ((normalized.startsWith('pnpm_config_') || normalized.startsWith('npm_config_'))
      && (normalized.endsWith('config_dependencies') || normalized.endsWith('configdependencies'))
      && value !== undefined && value !== '') {
      metadataError('configDependencies environment is not supported before lifecycle pnpm execution')
    }
    if ((normalized.startsWith('pnpm_config_') || normalized.startsWith('npm_config_'))
      && (normalized.endsWith('global_pnpmfile') || normalized.endsWith('globalpnpmfile'))
      && value !== undefined && value !== '') {
      metadataError('globalPnpmfile environment is not supported before lifecycle pnpm execution')
    }
  }
}

export async function assertLifecycleNpmMetadataSafe({ metadata, dshExecutable }) {
  if (metadata === null || typeof metadata !== 'object') metadataError('metadata must be an object')
  const yaml = await yamlModule(dshExecutable)
  const manifest = parseMetadataJson(metadata.packageJson, 'package.json')
  const workspace = yamlObject(parseYamlDocument(yaml, metadata.workspace, 'workspace'), 'workspace')
  assertNoConfigDependencies(manifest.configDependencies, 'package.json configDependencies')
  assertNoConfigDependencies(manifest.pnpm?.configDependencies, 'package.json pnpm.configDependencies')
  unsafeRuntimeConfig(manifest.packageManager, 'package.json packageManager')
  unsafeRuntimeConfig(manifest.engines?.runtime, 'package.json engines.runtime')
  unsafeRuntimeConfig(manifest.devEngines?.runtime, 'package.json devEngines.runtime')
  unsafeRuntimeConfig(manifest.devEngines?.packageManager, 'package.json devEngines.packageManager')
  unsafeRuntimeConfig(manifest.pnpm?.globalPnpmfile, 'package.json pnpm.globalPnpmfile')
  unsafeRuntimeConfig(workspace.configDependencies, 'workspace configDependencies')
  unsafeRuntimeConfig(workspace.pnpm?.configDependencies, 'workspace pnpm.configDependencies')
  unsafeRuntimeConfig(workspace.globalPnpmfile, 'workspace globalPnpmfile')
  unsafeRuntimeConfig(workspace.pnpm?.globalPnpmfile, 'workspace pnpm.globalPnpmfile')
  unsafeRuntimeConfig(workspace.executionEnv, 'workspace executionEnv')
  unsafeRuntimeConfig(workspace.pnpm?.executionEnv, 'workspace pnpm.executionEnv')
  if (metadata.lockfile !== undefined) {
    const lockfile = yamlObject(parseYamlDocument(yaml, metadata.lockfile, 'lockfile'), 'lockfile')
    const rootImporter = plainRecord(lockfile.importers ?? {}, 'lockfile importers')['.']
    if (rootImporter !== undefined) assertNoConfigDependencies(rootImporter.configDependencies, 'lockfile root configDependencies')
  }
  assertNoConfigDependencyEnvironment()
}
