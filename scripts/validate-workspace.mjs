#!/usr/bin/env node

import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginsRoot = join(repoRoot, 'plugins')
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

  const expectedSuffix = `/${entry.name}`
  if (typeof manifest.name !== 'string' || !manifest.name.endsWith(expectedSuffix)) {
    report(manifestPath, `package name must end with ${expectedSuffix}`)
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

  const idMatch = patch.match(/- id:\s*['"]?([a-z0-9-]+)['"]?\s*$/m)
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

if (errors.length > 0) {
  console.error(`Workspace validation failed with ${errors.length} error(s):`)
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log(`Validated ${entries.length} plugin package(s).`)
