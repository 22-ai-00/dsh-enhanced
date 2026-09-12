import { createRequire } from 'node:module'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

const pinnedHostVersion = '0.1.2-rc.1'

async function hostRequire(dshExecutable) {
  const executable = await realpath(dshExecutable)
  const entryFor = async manifestPath => {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const bin = typeof manifest?.bin === 'string' ? manifest.bin : manifest?.bin?.dsh
    const packageRoot = await realpath(dirname(manifestPath))
    if (manifest?.name !== '@deepseek-ai/dsh' || manifest.version !== pinnedHostVersion || typeof bin !== 'string' || bin.length === 0 || isAbsolute(bin)) return undefined
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
