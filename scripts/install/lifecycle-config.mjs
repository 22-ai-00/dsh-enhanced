import { createRequire } from 'node:module'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
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

async function yamlModule(dshExecutable) {
  let resolved
  try {
    resolved = repositoryRequire.resolve('yaml')
  } catch {
    try {
      const executable = await realpath(dshExecutable)
      resolved = createRequire(executable).resolve('yaml')
    } catch {
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
    const id = item.get('id')
    if (typeof id !== 'string' || item.get('disabled') === true) continue
    const name = item.get('name')
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
    const disabled = item.get('disabled')
    if (disabled !== undefined && typeof disabled !== 'boolean') {
      throw new Error('lifecycle scenario row disabled field must be boolean')
    }
    if (disabled === true) continue
    const id = item.get('id')
    const name = item.get('name')
    if (typeof id !== 'string' || typeof name !== 'string') {
      throw new Error('active lifecycle scenario rows must have string id and name fields')
    }
    const idKind = lifecycleMarkers.get(id)
    const nameKind = lifecycleMarkers.get(name)
    if (idKind !== undefined && nameKind !== undefined && idKind !== nameKind) {
      throw new Error('lifecycle scenario row has conflicting id and name markers')
    }
    const kind = idKind ?? nameKind
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
