import { createRequire } from 'node:module'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRequire = createRequire(import.meta.url)
const storageFields = new Set(['databasePath', 'statePath', 'stateRoot', 'vaultRoot', 'spoolPath', 'runsPath', 'catalogPath', 'trustPath', 'scratchPath'])
const trustedBundleName = /^@(?:deepseek-ai|dsh-enhanced)\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u

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

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sourcePath, dshHome, dshExecutable] = process.argv.slice(2)
  if (sourcePath === undefined || dshHome === undefined || dshExecutable === undefined) {
    process.stderr.write('usage: lifecycle-config.mjs <dump-config.yml> <dsh-home> <dsh-executable>\n')
    process.exitCode = 2
  } else {
    validateLifecycleConfig(await readFile(sourcePath, 'utf8'), { dshHome, dshExecutable }).catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : 'lifecycle configuration validation failed'}\n`)
      process.exitCode = 1
    })
  }
}
