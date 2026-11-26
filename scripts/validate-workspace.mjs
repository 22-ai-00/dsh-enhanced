#!/usr/bin/env node

import { access, readFile, readdir } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginsRoot = join(repoRoot, 'plugins')
const packagesRoot = join(repoRoot, 'packages')
const errors = []
const packageNames = new Set()
const rowIds = new Set()

function report(path, message) {
  errors.push(`${relative(repoRoot, path)}: ${message}`)
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function includesFile(files, expected) {
  return Array.isArray(files) && files.some(value => value === expected || value === `./${expected}`)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const builtinSpecifiers = new Set(
  builtinModules.flatMap(name => (name.startsWith('node:') ? [name] : [name, `node:${name}`])),
)
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'])
const regexBeforeKeywords = new Set([
  'return', 'throw', 'case', 'default', 'else', 'do', 'yield', 'await',
  'typeof', 'void', 'delete', 'in', 'instanceof', 'new', 'of', 'export', 'extends',
])

async function collectSourceFiles(directory) {
  if (!await exists(directory)) return []
  const files = []
  const dirEntries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const dirEntry of dirEntries) {
    const fullPath = join(directory, dirEntry.name)
    if (dirEntry.isDirectory()) {
      files.push(...await collectSourceFiles(fullPath))
      continue
    }
    if (!dirEntry.isFile()) continue
    if (dirEntry.name.endsWith('.d.ts') || dirEntry.name.endsWith('.d.mts') || dirEntry.name.endsWith('.d.cts')) {
      continue
    }
    const dotIndex = dirEntry.name.lastIndexOf('.')
    const ext = dotIndex >= 0 ? dirEntry.name.slice(dotIndex) : ''
    if (sourceExtensions.has(ext)) files.push(fullPath)
  }
  return files
}

function scanQuotedLiteral(source, startIndex) {
  const quote = source[startIndex]
  let index = startIndex + 1
  let value = ''
  while (index < source.length) {
    const ch = source[index]
    if (ch === '\\') {
      if (index + 1 < source.length) value += source[index + 1]
      index += 2
      continue
    }
    if (ch === quote) {
      return { raw: source.slice(startIndex, index + 1), value, nextIndex: index + 1 }
    }
    value += ch
    index += 1
  }
  return { raw: source.slice(startIndex), value, nextIndex: source.length }
}

function scanRegexLiteral(source, startIndex) {
  let index = startIndex + 1
  let inClass = false
  while (index < source.length) {
    const ch = source[index]
    if (ch === '\\') {
      index += 2
      continue
    }
    if (ch === '[') {
      inClass = true
      index += 1
      continue
    }
    if (ch === ']') {
      inClass = false
      index += 1
      continue
    }
    if (ch === '/' && !inClass) {
      index += 1
      while (index < source.length && /[a-z]/i.test(source[index])) index += 1
      break
    }
    if (ch === '\n' || ch === '\r') break
    index += 1
  }
  return { raw: source.slice(startIndex, index), nextIndex: index }
}

function isIdentStart(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$'
}

function isIdentPart(ch) {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9')
}

function stripComments(source) {
  const chunks = []
  let index = 0
  if (source.startsWith('#!')) {
    while (index < source.length && source[index] !== '\n') index += 1
  }

  function scanTemplate(startIndex) {
    chunks.push('`')
    let cursor = startIndex + 1
    while (cursor < source.length) {
      const ch = source[cursor]
      if (ch === '\\') {
        chunks.push(source.slice(cursor, cursor + 2))
        cursor += 2
        continue
      }
      if (ch === '`') {
        chunks.push('`')
        return cursor + 1
      }
      if (ch === '$' && source[cursor + 1] === '{') {
        chunks.push('${')
        cursor = scanNormal(cursor + 2, true)
        if (cursor < source.length && source[cursor] === '}') {
          chunks.push('}')
          cursor += 1
        }
        continue
      }
      chunks.push(ch)
      cursor += 1
    }
    return cursor
  }

  function scanNormal(startIndex, stopAtBrace) {
    let cursor = startIndex
    let canStartRegex = true
    let braceDepth = 0
    while (cursor < source.length) {
      const ch = source[cursor]
      if (stopAtBrace && ch === '}' && braceDepth === 0) return cursor
      if (ch === '/' && source[cursor + 1] === '/') {
        cursor += 2
        while (cursor < source.length && source[cursor] !== '\n') cursor += 1
        chunks.push(' ')
        continue
      }
      if (ch === '/' && source[cursor + 1] === '*') {
        cursor += 2
        let hadNewline = false
        while (cursor < source.length && !(source[cursor] === '*' && source[cursor + 1] === '/')) {
          if (source[cursor] === '\n') {
            chunks.push('\n')
            hadNewline = true
          }
          cursor += 1
        }
        if (cursor < source.length) cursor += 2
        if (!hadNewline) chunks.push(' ')
        continue
      }
      if (ch === '/' && canStartRegex) {
        const regex = scanRegexLiteral(source, cursor)
        chunks.push(regex.raw)
        cursor = regex.nextIndex
        canStartRegex = false
        continue
      }
      if (ch === '\'' || ch === '"') {
        const quoted = scanQuotedLiteral(source, cursor)
        chunks.push(quoted.raw)
        cursor = quoted.nextIndex
        canStartRegex = false
        continue
      }
      if (ch === '`') {
        cursor = scanTemplate(cursor)
        canStartRegex = false
        continue
      }
      if (isIdentStart(ch)) {
        const start = cursor
        cursor += 1
        while (cursor < source.length && isIdentPart(source[cursor])) cursor += 1
        const word = source.slice(start, cursor)
        chunks.push(word)
        canStartRegex = regexBeforeKeywords.has(word)
        continue
      }
      if (ch >= '0' && ch <= '9') {
        const start = cursor
        cursor += 1
        while (cursor < source.length && (isIdentPart(source[cursor]) || source[cursor] === '.')) cursor += 1
        chunks.push(source.slice(start, cursor))
        canStartRegex = false
        continue
      }
      if (/\s/.test(ch)) {
        chunks.push(ch)
        cursor += 1
        continue
      }
      if (ch === '{') braceDepth += 1
      else if (ch === '}' && braceDepth > 0) braceDepth -= 1
      if ((ch === '+' || ch === '-') && source[cursor + 1] === ch) {
        chunks.push(ch + ch)
        cursor += 2
        canStartRegex = false
        continue
      }
      chunks.push(ch)
      cursor += 1
      canStartRegex = ch !== ')' && ch !== ']'
    }
    return cursor
  }

  scanNormal(index, false)
  return chunks.join('')
}

function tokenizeModule(source) {
  const tokens = []

  function scanTemplateTokens(startIndex) {
    let cursor = startIndex + 1
    let staticValue = ''
    let hasInterpolation = false
    while (cursor < source.length) {
      const ch = source[cursor]
      if (ch === '\\') {
        if (cursor + 1 < source.length) staticValue += source[cursor + 1]
        cursor += 2
        continue
      }
      if (ch === '`') {
        if (!hasInterpolation) tokens.push({ type: 'str', value: staticValue })
        else tokens.push({ type: 'tpl-end', value: '`' })
        return cursor + 1
      }
      if (ch === '$' && source[cursor + 1] === '{') {
        if (!hasInterpolation) {
          hasInterpolation = true
          tokens.push({ type: 'tpl-start', value: '`' })
        }
        cursor = scanNormalTokens(cursor + 2, true)
        if (cursor < source.length && source[cursor] === '}') cursor += 1
        continue
      }
      staticValue += ch
      cursor += 1
    }
    return cursor
  }

  function scanNormalTokens(startIndex, stopAtBrace) {
    let cursor = startIndex
    let canStartRegex = true
    let braceDepth = 0
    while (cursor < source.length) {
      const ch = source[cursor]
      if (stopAtBrace && ch === '}' && braceDepth === 0) return cursor
      if (/\s/.test(ch)) {
        cursor += 1
        continue
      }
      if (ch === '/' && canStartRegex) {
        const regex = scanRegexLiteral(source, cursor)
        tokens.push({ type: 'regex', value: regex.raw })
        cursor = regex.nextIndex
        canStartRegex = false
        continue
      }
      if (ch === '\'' || ch === '"') {
        const quoted = scanQuotedLiteral(source, cursor)
        tokens.push({ type: 'str', value: quoted.value })
        cursor = quoted.nextIndex
        canStartRegex = false
        continue
      }
      if (ch === '`') {
        cursor = scanTemplateTokens(cursor)
        canStartRegex = false
        continue
      }
      if (isIdentStart(ch)) {
        const start = cursor
        cursor += 1
        while (cursor < source.length && isIdentPart(source[cursor])) cursor += 1
        const word = source.slice(start, cursor)
        tokens.push({ type: 'id', value: word })
        canStartRegex = regexBeforeKeywords.has(word)
        continue
      }
      if (ch >= '0' && ch <= '9') {
        const start = cursor
        cursor += 1
        while (cursor < source.length && (isIdentPart(source[cursor]) || source[cursor] === '.')) cursor += 1
        tokens.push({ type: 'num', value: source.slice(start, cursor) })
        canStartRegex = false
        continue
      }
      if (ch === '?' && source[cursor + 1] === '.') {
        tokens.push({ type: 'punct', value: '?.' })
        cursor += 2
        canStartRegex = true
        continue
      }
      if (ch === '.' && source[cursor + 1] === '.' && source[cursor + 2] === '.') {
        tokens.push({ type: 'punct', value: '...' })
        cursor += 3
        canStartRegex = true
        continue
      }
      if (ch === '{') braceDepth += 1
      else if (ch === '}' && braceDepth > 0) braceDepth -= 1
      if ((ch === '+' || ch === '-') && source[cursor + 1] === ch) {
        tokens.push({ type: 'punct', value: ch + ch })
        cursor += 2
        canStartRegex = false
        continue
      }
      tokens.push({ type: 'punct', value: ch })
      cursor += 1
      canStartRegex = ch !== ')' && ch !== ']'
    }
    return cursor
  }

  scanNormalTokens(0, false)
  return tokens
}

function findMatchingBrace(tokens, openIndex) {
  let depth = 0
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index].type === 'punct' && tokens[index].value === '{') depth += 1
    else if (tokens[index].type === 'punct' && tokens[index].value === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function hasRuntimeNamedSpecifier(tokens, start, end) {
  let itemStart = start
  let itemCount = 0
  for (let index = start; index <= end; index += 1) {
    const isEnd = index === end || (tokens[index].type === 'punct' && tokens[index].value === ',')
    if (!isEnd) continue
    if (index > itemStart) {
      itemCount += 1
      const first = tokens[itemStart]
      const second = itemStart + 1 < index ? tokens[itemStart + 1] : undefined
      const isTypeOnlyItem = first.type === 'id'
        && first.value === 'type'
        && second !== undefined
        && !(second.type === 'id' && second.value === 'as')
      if (!isTypeOnlyItem) return true
    }
    itemStart = index + 1
  }
  return itemCount === 0
}

function extractRuntimeImportSpecifiers(source) {
  const tokens = tokenizeModule(stripComments(source))
  const specifiers = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    const prev = index > 0 ? tokens[index - 1] : undefined
    const isMemberAccess = prev?.type === 'punct' && (prev.value === '.' || prev.value === '?.')
    if (isMemberAccess || token.type !== 'id') continue

    if (token.value === 'import') {
      const next = tokens[index + 1]
      if (next?.type === 'punct' && next.value === '(') {
        const arg = tokens[index + 2]
        const afterArg = tokens[index + 3]
        if (arg?.type === 'str' && afterArg?.type === 'punct' && (afterArg.value === ')' || afterArg.value === ',')) {
          specifiers.push(arg.value)
          index += 2
        }
        continue
      }
      if (next?.type === 'str') {
        specifiers.push(next.value)
        index += 1
        continue
      }
      let cursor = index + 1
      const afterType = tokens[cursor + 1]
      const isLeadingTypeOnly = next?.type === 'id'
        && next.value === 'type'
        && afterType !== undefined
        && (
          afterType.value === '{'
          || afterType.value === '*'
          || (afterType.type === 'id' && afterType.value !== 'from')
        )
      if (isLeadingTypeOnly) continue

      let hasRuntimeBinding = false
      let namedRange = null
      if (tokens[cursor]?.type === 'id' && tokens[cursor].value !== 'from') {
        hasRuntimeBinding = true
        cursor += 1
        if (tokens[cursor]?.type === 'punct' && tokens[cursor].value === ',') cursor += 1
      }
      if (tokens[cursor]?.type === 'punct' && tokens[cursor].value === '*') {
        if (tokens[cursor + 1]?.type === 'id' && tokens[cursor + 1].value === 'as' && tokens[cursor + 2]?.type === 'id') {
          hasRuntimeBinding = true
          cursor += 3
        }
      } else if (tokens[cursor]?.type === 'punct' && tokens[cursor].value === '{') {
        const closeBrace = findMatchingBrace(tokens, cursor)
        if (closeBrace < 0) continue
        namedRange = [cursor + 1, closeBrace]
        cursor = closeBrace + 1
      }
      if (tokens[cursor]?.type === 'id' && tokens[cursor].value === 'from' && tokens[cursor + 1]?.type === 'str') {
        const isRuntime = hasRuntimeBinding
          || (namedRange !== null && hasRuntimeNamedSpecifier(tokens, namedRange[0], namedRange[1]))
        if (isRuntime) specifiers.push(tokens[cursor + 1].value)
        index = cursor + 1
      }
      continue
    }

    if (token.value === 'export') {
      const next = tokens[index + 1]
      if (next?.type === 'id' && next.value === 'type') continue
      if (next?.type === 'punct' && next.value === '*') {
        let cursor = index + 2
        if (tokens[cursor]?.type === 'id' && tokens[cursor].value === 'as' && tokens[cursor + 1]?.type === 'id') {
          cursor += 2
        }
        if (tokens[cursor]?.type === 'id' && tokens[cursor].value === 'from' && tokens[cursor + 1]?.type === 'str') {
          specifiers.push(tokens[cursor + 1].value)
          index = cursor + 1
        }
        continue
      }
      if (next?.type === 'punct' && next.value === '{') {
        const closeBrace = findMatchingBrace(tokens, index + 1)
        if (closeBrace < 0) continue
        if (tokens[closeBrace + 1]?.type === 'id' && tokens[closeBrace + 1].value === 'from' && tokens[closeBrace + 2]?.type === 'str') {
          if (hasRuntimeNamedSpecifier(tokens, index + 2, closeBrace)) {
            specifiers.push(tokens[closeBrace + 2].value)
          }
          index = closeBrace + 2
        }
      }
    }
  }
  return specifiers
}

function resolvePackageName(specifier) {
  if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')) {
    return null
  }
  if (builtinSpecifiers.has(specifier)) {
    return null
  }
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier
  }
  return parts[0]
}

const catalogPath = join(pluginsRoot, 'README.md')
const catalog = await readFile(catalogPath, 'utf8')
const entries = (await readdir(pluginsRoot, { withFileTypes: true }))
  .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
  .sort((left, right) => left.name.localeCompare(right.name))

if (entries.length === 0) report(pluginsRoot, 'at least one contract example plugin is required')

for (const entry of entries) {
  const pluginRoot = join(pluginsRoot, entry.name)
  const manifestPath = join(pluginRoot, 'package.json')
  if (!await exists(manifestPath)) {
    report(pluginRoot, 'missing package.json')
    continue
  }

  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    report(manifestPath, `invalid JSON: ${error.message}`)
    continue
  }

  const expectedName = `@dsh-ray/${entry.name}`
  if (typeof manifest.name !== 'string' || manifest.name !== expectedName) {
    report(manifestPath, `package name must equal ${expectedName}`)
  } else if (packageNames.has(manifest.name)) {
    report(manifestPath, `duplicate package name ${manifest.name}`)
  } else {
    packageNames.add(manifest.name)
  }

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? '')) {
    report(manifestPath, 'version must be valid semver without build metadata')
  }
  if (manifest.type !== 'module') report(manifestPath, 'type must be module')
  if (manifest.private === true) report(manifestPath, 'plugins must be publishable, not private')

  const patchRef = manifest.dsh?.bundle?.patch
  if (patchRef !== './cordis.patch.yml') {
    report(manifestPath, 'dsh.bundle.patch must equal ./cordis.patch.yml')
  }

  const requiredFiles = ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE']
  for (const required of requiredFiles) {
    if (!includesFile(manifest.files, required)) report(manifestPath, `files must include ${required}`)
  }
  if (manifest.exports?.['./cordis.patch.yml'] !== './cordis.patch.yml') {
    report(manifestPath, 'exports must expose ./cordis.patch.yml')
  }
  for (const script of ['build', 'test', 'typecheck']) {
    if (typeof manifest.scripts?.[script] !== 'string') report(manifestPath, `missing ${script} script`)
  }
  if (manifest.scripts?.prepublishOnly !== 'node ../../scripts/require-pnpm-publish.mjs') {
    report(manifestPath, 'prepublishOnly must reject publishing catalog dependencies with npm')
  }
  for (const peerName of Object.keys(manifest.peerDependencies ?? {})) {
    if (manifest.peerDependenciesMeta?.[peerName]?.optional !== true) {
      report(manifestPath, `peerDependenciesMeta.${peerName}.optional must be true so DSH supplies the host peer without pnpm duplicating it`)
    }
  }

  const requiredPaths = [
    'src/index.ts',
    'src/version.ts',
    'tests/index.spec.ts',
    'cordis.patch.yml',
    'tsconfig.json',
    'tsconfig.build.json',
    'README.md',
    'LICENSE',
  ]
  for (const required of requiredPaths) {
    if (!await exists(join(pluginRoot, required))) report(pluginRoot, `missing ${required}`)
  }

  const versionPath = join(pluginRoot, 'src', 'version.ts')
  if (await exists(versionPath)) {
    const versionSource = await readFile(versionPath, 'utf8')
    const runtimeVersion = versionSource.match(/export const version = ['"]([^'"]+)['"]/)?.[1]
    if (runtimeVersion !== manifest.version) report(versionPath, `runtime version must equal ${manifest.version}`)
  }

  const patchPath = normalize(join(pluginRoot, patchRef ?? ''))
  if (!patchPath.startsWith(`${pluginRoot}${sep}`) || !await exists(patchPath)) continue
  const patch = await readFile(patchPath, 'utf8')
  const packagePattern = new RegExp(`name:\\s*['"]?${escapeRegExp(manifest.name)}['"]?(?:\\s|$)`)
  if (!packagePattern.test(patch)) report(patchPath, `patch must mount ${manifest.name}`)

  // A bundle may patch existing Host rows before mounting its own package.
  // Bind the stable plugin id to the row whose name is this manifest, rather
  // than assuming the first `- id` in the patch is always the mounted row.
  const mountedRowPattern = new RegExp(
    `- id:\\s*['"]?([a-z0-9-]+)['"]?\\s*\\n\\s+name:\\s*['"]?${escapeRegExp(manifest.name)}['"]?\\s*$`,
    'm',
  )
  const idMatch = patch.match(mountedRowPattern)
  if (!idMatch) {
    report(patchPath, 'patch must declare a stable kebab-case row id')
  } else if (rowIds.has(idMatch[1])) {
    report(patchPath, `duplicate Cordis row id ${idMatch[1]}`)
  } else {
    rowIds.add(idMatch[1])
    const sourcePath = join(pluginRoot, 'src', 'index.ts')
    if (await exists(sourcePath)) {
      const source = await readFile(sourcePath, 'utf8')
      const sourceName = source.match(/export const name\s*=\s*['"]([^'"]+)['"]/)?.[1]
      if (sourceName !== idMatch[1]) report(sourcePath, `exported name must equal patch row id ${idMatch[1]}`)
      if (source.includes('{{')) report(sourcePath, 'contains unresolved template token')
    }
  }

  if (!catalog.includes(`[${entry.name}](${entry.name})`) || !catalog.includes(`\`${manifest.name}\``)) {
    report(catalogPath, `missing catalog row for ${manifest.name}`)
  }
  if (await exists(join(pluginRoot, '.dsh-plugin'))) {
    report(pluginRoot, 'legacy .dsh-plugin metadata is not supported')
  }
}

const packageEntries = (await readdir(packagesRoot, { withFileTypes: true }))
  .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
  .sort((left, right) => left.name.localeCompare(right.name))

for (const entry of packageEntries) {
  const packageRoot = join(packagesRoot, entry.name)
  const manifestPath = join(packageRoot, 'package.json')
  if (!await exists(manifestPath)) {
    report(packageRoot, 'missing package.json')
    continue
  }

  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    report(manifestPath, `invalid JSON: ${error.message}`)
    continue
  }

  const expectedName = entry.name === 'dsh-ray' ? 'dsh-ray' : `@dsh-ray/${entry.name}`
  if (typeof manifest.name !== 'string' || manifest.name !== expectedName) {
    report(manifestPath, `package name must equal ${expectedName}`)
  } else if (packageNames.has(manifest.name)) {
    report(manifestPath, `duplicate package name ${manifest.name}`)
  } else {
    packageNames.add(manifest.name)
  }

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? '')) {
    report(manifestPath, 'version must be valid semver without build metadata')
  }
  if (manifest.type !== 'module') report(manifestPath, 'type must be module')
  if (manifest.private === true) report(manifestPath, 'shared packages must be publishable, not private')
  if (manifest.dsh?.bundle !== undefined) {
    report(manifestPath, 'ordinary shared packages must not declare dsh.bundle')
  }

  for (const required of ['lib', 'README.md', 'LICENSE']) {
    if (!includesFile(manifest.files, required)) report(manifestPath, `files must include ${required}`)
  }
  for (const script of ['build', 'test', 'typecheck']) {
    if (typeof manifest.scripts?.[script] !== 'string') report(manifestPath, `missing ${script} script`)
  }
  if (manifest.scripts?.prepublishOnly !== 'node ../../scripts/require-pnpm-publish.mjs') {
    report(manifestPath, 'prepublishOnly must reject publishing catalog dependencies with npm')
  }

  for (const required of [
    'src/index.ts',
    'src/version.ts',
    'tests/index.spec.ts',
    'tsconfig.json',
    'tsconfig.build.json',
    'README.md',
    'LICENSE',
  ]) {
    if (!await exists(join(packageRoot, required))) report(packageRoot, `missing ${required}`)
  }

  const versionPath = join(packageRoot, 'src', 'version.ts')
  if (await exists(versionPath)) {
    const versionSource = await readFile(versionPath, 'utf8')
    const runtimeVersion = versionSource.match(/export const version = ['"]([^'"]+)['"]/)?.[1]
    if (runtimeVersion !== manifest.version) report(versionPath, `runtime version must equal ${manifest.version}`)
  }

  const declaredPackages = new Set([
    ...(typeof manifest.name === 'string' ? [manifest.name] : []),
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ])
  for (const subdir of ['src', 'bin']) {
    const sourceFiles = await collectSourceFiles(join(packageRoot, subdir))
    for (const filePath of sourceFiles) {
      const source = await readFile(filePath, 'utf8')
      for (const specifier of extractRuntimeImportSpecifiers(source)) {
        const importedPkg = resolvePackageName(specifier)
        if (importedPkg === null) continue
        if (!declaredPackages.has(importedPkg)) {
          report(
            filePath,
            `runtime import "${specifier}" resolves to package "${importedPkg}", which is missing from dependencies or peerDependencies`,
          )
        }
      }
    }
  }
}

const templateRequired = [
  'package.json.tpl',
  'cordis.patch.yml.tpl',
  'src/index.ts.tpl',
  'tests/index.spec.ts.tpl',
  'tsconfig.json.tpl',
  'tsconfig.build.json.tpl',
  'README.md.tpl',
  'src/version.ts.tpl',
]
for (const required of templateRequired) {
  const path = join(repoRoot, 'templates', 'plugin', required)
  if (!await exists(path)) report(path, 'missing template file')
}

// Protection floors: the runtime single source of truth lives in the inert
// plugin-protection module of @dsh-ray/assistant-growth-contract (inside
// the sealed RSI bootstrap closure). This build-time check parses that source
// and pins the declarative `dsh.protection.floor` manifest field to it, so a
// floor can only rise and a protected plugin cannot silently drop its marker.
const protectionSourcePath = join(packagesRoot, 'assistant-growth-contract', 'src', 'plugin-protection.ts')
const protectionSource = await exists(protectionSourcePath) ? await readFile(protectionSourcePath, 'utf8') : undefined
if (protectionSource === undefined) {
  report(protectionSourcePath, 'missing plugin protection source')
} else {
  const extractSet = (name) => {
    const start = protectionSource.indexOf(`export const ${name}`)
    if (start < 0) { report(protectionSourcePath, `missing ${name}`); return [] }
    const open = protectionSource.indexOf('new Set([', start)
    const close = protectionSource.indexOf('])', open)
    if (open < 0 || close < 0) { report(protectionSourcePath, `${name} must be a Set literal`); return [] }
    return [...protectionSource.slice(open, close).matchAll(/'([a-z][a-z0-9-]*)'/g)]
      .map(match => match[1])
  }
  const modelProposal = new Set(extractSet('MODEL_PROPOSAL_PROTECTED_PLUGINS'))
  const ownerRepair = new Set(extractSet('OWNER_REPAIR_PROTECTED_PLUGINS'))
  for (const name of ownerRepair) {
    if (!modelProposal.has(name)) report(protectionSourcePath, `owner-repair protection ${name} must also be model-proposal protected`)
    if (!entries.some(entry => entry.name === name)) report(protectionSourcePath, `protected plugin ${name} has no plugin directory`)
  }
  const declared = new Map()
  for (const entry of entries) {
    const manifestPath = join(pluginsRoot, entry.name, 'package.json')
    let manifest
    try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) } catch { continue }
    const floor = manifest.dsh?.protection?.floor
    if (floor === undefined) continue
    if (floor !== 'model-proposal' && floor !== 'immutable') {
      report(manifestPath, `dsh.protection.floor must be "model-proposal" or "immutable"`)
      continue
    }
    const declaresModelProposal = modelProposal.has(entry.name)
    const declaresImmutable = ownerRepair.has(entry.name)
    if (!declaresModelProposal) report(manifestPath, `dsh.protection.floor is declared but ${entry.name} is not a protected plugin`)
    else if (floor === 'immutable' && !declaresImmutable) report(manifestPath, `only owner-repair safety roots may declare the immutable floor`)
    else if (floor === 'model-proposal' && declaresImmutable) report(manifestPath, `immutable safety roots must declare the immutable floor, never a lower one`)
    declared.set(entry.name, floor)
  }
  for (const name of ownerRepair) {
    if (!declared.has(name)) report(join(pluginsRoot, name, 'package.json'), 'immutable safety roots must declare dsh.protection.floor "immutable"')
  }
}

if (errors.length > 0) {
  console.error(`Workspace validation failed with ${errors.length} error(s):`)
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log(`Validated ${entries.length} plugin package(s) and ${packageEntries.length} shared package(s).`)
