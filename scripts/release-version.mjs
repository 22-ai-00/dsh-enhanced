#!/usr/bin/env node

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArguments(argv) {
  const rootIndex = argv.indexOf('--root')
  const root = rootIndex === -1 ? defaultRoot : resolve(argv[rootIndex + 1])
  const positional = rootIndex === -1
    ? argv
    : argv.filter((_, index) => index !== rootIndex && index !== rootIndex + 1)
  return { command: positional[0], version: positional[1], root }
}

function nextPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) throw new Error(`Recorded version is not a stable semantic version: ${version}`)
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}

function compareVersions(left, right) {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index]
  }
  return 0
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function prepare(root, requestedVersion) {
  const ledgerPath = join(root, 'release-manifest.json')
  const ledger = await readJson(ledgerPath)
  if (ledger.pending) throw new Error(`Release ${ledger.pending.version} is already pending`)

  const version = requestedVersion ?? nextPatch(ledger.current.version)
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Release version is not a stable semantic version: ${version}`)
  }
  if (compareVersions(version, ledger.current.version) <= 0) {
    throw new Error(`Release version ${version} must be greater than current release ${ledger.current.version}`)
  }
  const rootManifestPath = join(root, 'package.json')
  const rootManifest = await readJson(rootManifestPath)
  const pluginEntries = (await readdir(join(root, 'plugins'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((left, right) => left.name.localeCompare(right.name))
  const plugins = await Promise.all(pluginEntries.map(async entry => {
    const path = join(root, 'plugins', entry.name, 'package.json')
    const versionPath = join(root, 'plugins', entry.name, 'src', 'version.ts')
    return {
      path,
      manifest: await readJson(path),
      versionPath,
      versionSource: await readFile(versionPath, 'utf8'),
    }
  }))

  rootManifest.version = version
  const packages = {}
  for (const plugin of plugins) {
    const versionMatch = plugin.versionSource.match(/export const version = ['"]([^'"]+)['"]/)
    if (!versionMatch || versionMatch[1] !== plugin.manifest.version) {
      throw new Error(`${plugin.manifest.name} src/version.ts must match package.json`)
    }
    plugin.manifest.version = version
    plugin.versionSource = plugin.versionSource.replace(versionMatch[0], `export const version = '${version}'`)
    packages[plugin.manifest.name] = version
  }
  ledger.pending = {
    version,
    preparedAt: new Date().toISOString(),
    packages,
  }

  await writeJson(rootManifestPath, rootManifest)
  await Promise.all(plugins.map(plugin => writeJson(plugin.path, plugin.manifest)))
  await Promise.all(plugins.map(plugin => writeFile(plugin.versionPath, plugin.versionSource)))
  await writeJson(ledgerPath, ledger)
  console.log(`Prepared release ${version}`)
}

async function record(root) {
  const ledgerPath = join(root, 'release-manifest.json')
  const ledger = await readJson(ledgerPath)
  if (!ledger.pending) throw new Error('There is no pending release to record')

  const rootManifest = await readJson(join(root, 'package.json'))
  if (rootManifest.version !== ledger.pending.version) {
    throw new Error(`Root package is ${rootManifest.version}, expected ${ledger.pending.version}`)
  }
  const pluginEntries = (await readdir(join(root, 'plugins'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
  for (const entry of pluginEntries) {
    const manifest = await readJson(join(root, 'plugins', entry.name, 'package.json'))
    const expectedVersion = ledger.pending.packages[manifest.name]
    if (manifest.version !== expectedVersion) {
      throw new Error(`${manifest.name} is ${manifest.version}, expected ${expectedVersion}`)
    }
    const versionSource = await readFile(join(root, 'plugins', entry.name, 'src', 'version.ts'), 'utf8')
    const runtimeVersion = versionSource.match(/export const version = ['"]([^'"]+)['"]/)?.[1]
    if (runtimeVersion !== expectedVersion) {
      throw new Error(`${manifest.name} runtime version is ${runtimeVersion ?? 'missing'}, expected ${expectedVersion}`)
    }
  }

  const release = {
    version: ledger.pending.version,
    releasedAt: new Date().toISOString(),
    packages: ledger.pending.packages,
  }
  ledger.current = release
  ledger.pending = null
  ledger.history.push(release)
  await writeJson(ledgerPath, ledger)
  console.log(`Recorded release ${release.version}`)
}

async function status(root) {
  const ledger = await readJson(join(root, 'release-manifest.json'))
  const baseVersion = ledger.pending?.version ?? ledger.current?.version
  if (!baseVersion) throw new Error('Release manifest has neither a current nor a pending version')
  console.log(`Current release: ${ledger.current?.version ?? 'none'}`)
  console.log(`Pending release: ${ledger.pending?.version ?? 'none'}`)
  console.log(`Next default: ${nextPatch(baseVersion)}`)
}

async function main() {
  const { command, version, root } = parseArguments(process.argv.slice(2))
  if (command === 'prepare') return prepare(root, version)
  if (command === 'record') return record(root)
  if (command === 'status') return status(root)
  throw new Error('Usage: release-version.mjs <prepare|record|status> [version] [--root <path>]')
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
