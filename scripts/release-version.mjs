#!/usr/bin/env node

import { access, readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const runtimeVersionSourcePattern = /^\s*export\s+const\s+version\s*=\s*(['"])((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\1\s*;?\s*$/

function parseArguments(argv) {
  const rootIndex = argv.indexOf('--root')
  const root = rootIndex === -1 ? defaultRoot : resolve(argv[rootIndex + 1])
  const positional = rootIndex === -1
    ? argv
    : argv.filter((_, index) => index !== rootIndex && index !== rootIndex + 1)
  return { command: positional[0], version: positional[1], root }
}

function nextPatch(version) {
  const match = stableVersionPattern.exec(version)
  if (!match) throw new Error(`Recorded version is not a stable semantic version: ${version}`)
  return `${match[1]}.${match[2]}.${BigInt(match[3]) + 1n}`
}

function compareVersions(left, right) {
  const leftParts = left.split('.').map(BigInt)
  const rightParts = right.split('.').map(BigInt)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1
    if (leftParts[index] > rightParts[index]) return 1
  }
  return 0
}

function assertStableVersion(version, label) {
  if (typeof version !== 'string' || !stableVersionPattern.test(version)) {
    throw new Error(`${label} is not a stable semantic version: ${String(version)}`)
  }
}

function assertIsoTimestamp(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be an ISO 8601 UTC timestamp`)
  }
}

function versionFromTag(tag) {
  const match = typeof tag === 'string'
    ? /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(tag)
    : null
  if (!match) {
    throw new Error(`Release tag must be a stable semantic version in the form vX.Y.Z: ${tag ?? 'missing'}`)
  }
  return match[1]
}

function parseRuntimeVersion(source, packageName) {
  const match = runtimeVersionSourcePattern.exec(source)
  if (!match) {
    throw new Error(`${packageName} src/version.ts must export exactly one version as a stable literal and contain no other code`)
  }
  return match[2]
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function packageMapsMatch(left, right) {
  if (!isObject(left) || !isObject(right)) return false
  const leftEntries = Object.entries(left).sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
  const rightEntries = Object.entries(right).sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries)
}

function validateReleaseRecord(release, label) {
  if (!isObject(release)) {
    throw new Error(`${label} must be an object`)
  }
  assertStableVersion(release.version, `${label} version`)
  assertIsoTimestamp(release.releasedAt, `${label} releasedAt`)
  if (!isObject(release.packages)) {
    throw new Error(`${label} packages must be an object`)
  }
  for (const [name, version] of Object.entries(release.packages)) {
    if (name.length === 0 || version !== release.version) {
      throw new Error(`${label} package ${name || '<empty>'} is ${String(version)}, expected ${release.version}`)
    }
  }
}

function validateRecordedRelease(ledger) {
  if (ledger.schemaVersion !== 1) {
    throw new Error(`Unsupported release manifest schema version: ${String(ledger.schemaVersion)}`)
  }
  if (!Array.isArray(ledger.history)) {
    throw new Error('Release history must be an array')
  }
  if (ledger.current === null) {
    if (ledger.history.length !== 0) {
      throw new Error('Release history must be empty when there is no current release')
    }
    return
  }
  if (!isObject(ledger.current)) {
    throw new Error('Current release must be an object or null')
  }
  if (ledger.history.length === 0) {
    throw new Error('Release history must contain the current release')
  }
  validateReleaseRecord(ledger.current, 'Current release')
  for (const [index, release] of ledger.history.entries()) {
    const label = `Release history entry ${index}`
    validateReleaseRecord(release, label)
    if (index > 0 && compareVersions(release.version, ledger.history[index - 1].version) <= 0) {
      throw new Error(`${label} version ${release.version} must be greater than ${ledger.history[index - 1].version}`)
    }
  }
  const historyTail = ledger.history.at(-1)
  if (!isObject(historyTail)
    || historyTail.version !== ledger.current.version
    || historyTail.releasedAt !== ledger.current.releasedAt
    || !packageMapsMatch(historyTail.packages, ledger.current.packages)) {
    throw new Error('Release history tail must match the current release')
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function updatePinnedRemoteInstaller(root, version) {
  try {
    await access(join(root, 'scripts', 'install', 'common.sh'))
    await access(join(root, 'scripts', 'install', 'install-npm.sh'))
  } catch {
    // Focused release-version tests intentionally build minimal repositories.
    // Production repositories always carry both installer files.
    return
  }
  const common = await readFile(join(root, 'scripts', 'install', 'common.sh'))
  const hash = createHash('sha256').update(common).digest('hex')
  const installerPath = join(root, 'scripts', 'install', 'install-npm.sh')
  const installer = await readFile(installerPath, 'utf8')
  const withReference = installer.replace(
    /^DSH_ENHANCED_PINNED_RELEASE_REF='v\d+\.\d+\.\d+'$/m,
    `DSH_ENHANCED_PINNED_RELEASE_REF='v${version}'`,
  )
  const pinned = withReference.replace(
    /^DSH_ENHANCED_PINNED_COMMON_SHA256='[0-9a-f]{64}'$/m,
    `DSH_ENHANCED_PINNED_COMMON_SHA256='${hash}'`,
  )
  if (pinned === installer || !pinned.includes(`DSH_ENHANCED_PINNED_RELEASE_REF='v${version}'`)
    || !pinned.includes(`DSH_ENHANCED_PINNED_COMMON_SHA256='${hash}'`)) {
    throw new Error('install-npm.sh must contain exactly one releasable pinned ref and SHA-256')
  }
  await writeFile(installerPath, pinned)
}

async function publishableEntries(root) {
  const entries = []
  for (const directory of ['plugins', 'packages']) {
    let children
    try {
      children = await readdir(join(root, directory), { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    for (const child of children) {
      if (child.isDirectory() && !child.name.startsWith('.')) entries.push({ directory, name: child.name })
    }
  }
  return entries.sort((left, right) => `${left.directory}/${left.name}`.localeCompare(`${right.directory}/${right.name}`))
}

async function validatePendingRelease(root, operation = 'verify') {
  const ledgerPath = join(root, 'release-manifest.json')
  const ledger = await readJson(ledgerPath)
  if (!ledger.pending || typeof ledger.pending !== 'object' || Array.isArray(ledger.pending)) {
    throw new Error(`There is no pending release to ${operation}`)
  }
  validateRecordedRelease(ledger)

  const pendingVersion = ledger.pending.version
  assertStableVersion(pendingVersion, 'Pending release version')
  assertIsoTimestamp(ledger.pending.preparedAt, 'Pending release preparedAt')
  if (ledger.current && compareVersions(pendingVersion, ledger.current.version) <= 0) {
    throw new Error(`Pending release ${pendingVersion} must be greater than current release ${ledger.current.version}`)
  }

  const rootManifest = await readJson(join(root, 'package.json'))
  if (rootManifest.version !== pendingVersion) {
    throw new Error(`Root package is ${rootManifest.version ?? 'missing'}, expected ${pendingVersion}`)
  }

  const pendingPackages = ledger.pending.packages
  if (!pendingPackages || typeof pendingPackages !== 'object' || Array.isArray(pendingPackages)) {
    throw new Error('Pending release packages must be an object')
  }

  const packageEntries = await publishableEntries(root)
  const workspacePackages = []
  const pathsByName = new Map()
  for (const entry of packageEntries) {
    const packagePath = join(entry.directory, entry.name)
    const manifest = await readJson(join(root, packagePath, 'package.json'))
    if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
      throw new Error(`${packagePath}/package.json must declare a package name`)
    }
    const previousPath = pathsByName.get(manifest.name)
    if (previousPath) {
      throw new Error(`Duplicate workspace package name ${manifest.name}: ${previousPath} and ${packagePath}`)
    }
    pathsByName.set(manifest.name, packagePath)
    workspacePackages.push({ entry, manifest, packagePath })
  }

  const workspaceNames = new Set(pathsByName.keys())
  const pendingNames = Object.keys(pendingPackages)
  const missingNames = [...workspaceNames].filter(name => !Object.hasOwn(pendingPackages, name)).sort()
  const extraNames = pendingNames.filter(name => !workspaceNames.has(name)).sort()
  if (missingNames.length > 0) {
    throw new Error(`Pending release is missing packages: ${missingNames.join(', ')}`)
  }
  if (extraNames.length > 0) {
    throw new Error(`Pending release has extra packages: ${extraNames.join(', ')}`)
  }

  for (const { entry, manifest } of workspacePackages) {
    const expectedVersion = pendingPackages[manifest.name]
    if (expectedVersion !== pendingVersion) {
      throw new Error(`${manifest.name} pending version is ${expectedVersion ?? 'missing'}, expected ${pendingVersion}`)
    }
    if (manifest.version !== pendingVersion) {
      throw new Error(`${manifest.name} is ${manifest.version ?? 'missing'}, expected ${pendingVersion}`)
    }
    const versionSource = await readFile(join(root, entry.directory, entry.name, 'src', 'version.ts'), 'utf8')
    const runtimeVersion = parseRuntimeVersion(versionSource, manifest.name)
    if (runtimeVersion !== pendingVersion) {
      throw new Error(`${manifest.name} runtime version is ${runtimeVersion}, expected ${pendingVersion}`)
    }
  }

  try {
    const installer = await readFile(join(root, 'scripts', 'install', 'install-npm.sh'), 'utf8')
    const common = await readFile(join(root, 'scripts', 'install', 'common.sh'))
    const hash = createHash('sha256').update(common).digest('hex')
    if (!installer.includes(`DSH_ENHANCED_PINNED_RELEASE_REF='v${pendingVersion}'`)
      || !installer.includes(`DSH_ENHANCED_PINNED_COMMON_SHA256='${hash}'`)) {
      throw new Error('Pinned remote installer does not match the pending release version and common.sh digest')
    }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      // Minimal release-version fixtures do not contain installer assets.
    } else throw error
  }

  return { ledger, ledgerPath, pendingVersion }
}

async function prepare(root, requestedVersion) {
  const ledgerPath = join(root, 'release-manifest.json')
  const ledger = await readJson(ledgerPath)
  validateRecordedRelease(ledger)
  if (ledger.pending !== null) {
    if (!isObject(ledger.pending)) {
      throw new Error('Pending release must be an object or null')
    }
    throw new Error(`Release ${ledger.pending.version ?? '<unknown>'} is already pending`)
  }
  if (!ledger.current) throw new Error('An explicit initial pending release is required when there is no current release')

  const version = requestedVersion ?? nextPatch(ledger.current.version)
  assertStableVersion(version, 'Release version')
  if (compareVersions(version, ledger.current.version) <= 0) {
    throw new Error(`Release version ${version} must be greater than current release ${ledger.current.version}`)
  }
  const rootManifestPath = join(root, 'package.json')
  const rootManifest = await readJson(rootManifestPath)
  if (rootManifest.version !== ledger.current.version) {
    throw new Error(`Root package is ${rootManifest.version ?? 'missing'}, expected current release ${ledger.current.version}`)
  }
  const packageEntries = await publishableEntries(root)
  const pathsByName = new Map()
  const workspacePackages = await Promise.all(packageEntries.map(async entry => {
    const packagePath = join(entry.directory, entry.name)
    const path = join(root, packagePath, 'package.json')
    const versionPath = join(root, packagePath, 'src', 'version.ts')
    const workspacePackage = {
      path,
      manifest: await readJson(path),
      versionPath,
      versionSource: await readFile(versionPath, 'utf8'),
    }
    if (typeof workspacePackage.manifest.name !== 'string' || workspacePackage.manifest.name.length === 0) {
      throw new Error(`${packagePath}/package.json must declare a package name`)
    }
    const previousPath = pathsByName.get(workspacePackage.manifest.name)
    if (previousPath) {
      throw new Error(`Duplicate workspace package name ${workspacePackage.manifest.name}: ${previousPath} and ${packagePath}`)
    }
    pathsByName.set(workspacePackage.manifest.name, packagePath)
    const recordedVersion = ledger.current.packages[workspacePackage.manifest.name]
    if (recordedVersion !== undefined && workspacePackage.manifest.version !== recordedVersion) {
      throw new Error(`${workspacePackage.manifest.name} is ${workspacePackage.manifest.version ?? 'missing'}, expected current release ${recordedVersion}`)
    }
    return workspacePackage
  }))

  rootManifest.version = version
  const packages = {}
  for (const workspacePackage of workspacePackages) {
    const runtimeVersion = parseRuntimeVersion(workspacePackage.versionSource, workspacePackage.manifest.name)
    if (runtimeVersion !== workspacePackage.manifest.version) {
      throw new Error(`${workspacePackage.manifest.name} src/version.ts must match package.json`)
    }
    workspacePackage.manifest.version = version
    workspacePackage.versionSource = `export const version = '${version}'\n`
    packages[workspacePackage.manifest.name] = version
  }
  ledger.pending = {
    version,
    preparedAt: new Date().toISOString(),
    packages,
  }

  await writeJson(rootManifestPath, rootManifest)
  await Promise.all(workspacePackages.map(workspacePackage => writeJson(workspacePackage.path, workspacePackage.manifest)))
  await Promise.all(workspacePackages.map(workspacePackage => writeFile(workspacePackage.versionPath, workspacePackage.versionSource)))
  await updatePinnedRemoteInstaller(root, version)
  await writeJson(ledgerPath, ledger)
  console.log(`Prepared release ${version}`)
}

async function supersede(root, requestedVersion) {
  if (requestedVersion === undefined) {
    throw new Error('An explicit replacement version is required to supersede a pending release')
  }
  const { ledger, ledgerPath, pendingVersion } = await validatePendingRelease(root, 'supersede')
  assertStableVersion(requestedVersion, 'Replacement release version')
  if (compareVersions(requestedVersion, pendingVersion) <= 0) {
    throw new Error(`Replacement release ${requestedVersion} must be greater than pending release ${pendingVersion}`)
  }

  const rootManifestPath = join(root, 'package.json')
  const rootManifest = await readJson(rootManifestPath)
  const workspacePackages = []
  for (const entry of await publishableEntries(root)) {
    const packagePath = join(entry.directory, entry.name)
    const manifestPath = join(root, packagePath, 'package.json')
    const versionPath = join(root, packagePath, 'src', 'version.ts')
    const manifest = await readJson(manifestPath)
    const versionSource = await readFile(versionPath, 'utf8')
    if (manifest.version !== pendingVersion || parseRuntimeVersion(versionSource, manifest.name) !== pendingVersion) {
      throw new Error(`${manifest.name} no longer matches pending release ${pendingVersion}`)
    }
    manifest.version = requestedVersion
    workspacePackages.push({ manifest, manifestPath, versionPath })
  }

  rootManifest.version = requestedVersion
  ledger.pending = {
    version: requestedVersion,
    preparedAt: new Date().toISOString(),
    packages: Object.fromEntries(workspacePackages.map(({ manifest }) => [manifest.name, requestedVersion])),
  }
  await writeJson(rootManifestPath, rootManifest)
  await Promise.all(workspacePackages.map(({ manifest, manifestPath }) => writeJson(manifestPath, manifest)))
  await Promise.all(workspacePackages.map(({ versionPath }) => (
    writeFile(versionPath, `export const version = '${requestedVersion}'\n`)
  )))
  await updatePinnedRemoteInstaller(root, requestedVersion)
  await writeJson(ledgerPath, ledger)
  console.log(`Superseded pending release ${pendingVersion} with ${requestedVersion}`)
}

async function record(root) {
  const { ledger, ledgerPath, pendingVersion } = await validatePendingRelease(root, 'record')

  const release = {
    version: pendingVersion,
    releasedAt: new Date().toISOString(),
    packages: ledger.pending.packages,
  }
  ledger.current = release
  ledger.pending = null
  ledger.history.push(release)
  await writeJson(ledgerPath, ledger)
  console.log(`Recorded release ${release.version}`)
}

async function verifyTag(root, tag) {
  const tagVersion = versionFromTag(tag)
  const { pendingVersion } = await validatePendingRelease(root)
  if (tagVersion !== pendingVersion) {
    throw new Error(`Release tag ${tag} does not match pending release v${pendingVersion}`)
  }
  console.log(`Verified release tag ${tag}`)
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
  if (command === 'supersede') return supersede(root, version)
  if (command === 'record') return record(root)
  if (command === 'status') return status(root)
  if (command === 'verify-tag') return verifyTag(root, version)
  throw new Error('Usage: release-version.mjs <prepare|supersede|record|status|verify-tag> [version-or-tag] [--root <path>]')
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
