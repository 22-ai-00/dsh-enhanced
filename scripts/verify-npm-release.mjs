#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const DEFAULT_DIST_TAG = 'latest'
const DEFAULT_RETRIES = 5
const DEFAULT_RETRY_DELAY_MS = 2000
const DEFAULT_MAX_RETRY_DELAY_MS = 15000
const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_CONCURRENCY = 8

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertValidSemver(value, label) {
  if (typeof value !== 'string' || !SEMVER_PATTERN.test(value)) {
    throw new Error(`${label} must be a valid semantic version (got: ${String(value)})`)
  }
  return value
}

function stripLeadingV(tag) {
  return tag.startsWith('v') ? tag.slice(1) : tag
}

function normalizeRegistry(registry = DEFAULT_REGISTRY) {
  if (typeof registry !== 'string' || registry.trim().length === 0) {
    throw new Error('Registry URL must be a non-empty string')
  }
  const trimmed = registry.trim().replace(/\/+$/, '')
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`Invalid registry URL: ${registry}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Registry URL must use http: or https: (got: ${registry})`)
  }
  return trimmed
}

function parseIntegerOption(rawValue, flagName, minValue) {
  if (typeof rawValue !== 'string' || !/^\d+$/.test(rawValue)) {
    throw new Error(`${flagName} must be an integer >= ${minValue} (got: ${String(rawValue)})`)
  }
  const parsed = Number.parseInt(rawValue, 10)
  if (!Number.isSafeInteger(parsed) || parsed < minValue) {
    throw new Error(`${flagName} must be an integer >= ${minValue} (got: ${rawValue})`)
  }
  return parsed
}

async function readJsonFile(filePath, { optional = false } = {}) {
  let raw
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    if (optional && error?.code === 'ENOENT') {
      return null
    }
    throw new Error(`Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function discoverPublishablePackages(root = process.cwd()) {
  const resolvedRoot = resolve(root)
  const candidates = []

  for (const directory of ['plugins', 'packages']) {
    let entries
    try {
      entries = await readdir(join(resolvedRoot, directory), { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        candidates.push({ directory, dirName: entry.name })
      }
    }
  }

  candidates.sort((left, right) =>
    `${left.directory}/${left.dirName}`.localeCompare(`${right.directory}/${right.dirName}`),
  )

  const seenNames = new Set()
  const packages = []

  for (const entry of candidates) {
    const packageJsonPath = join(resolvedRoot, entry.directory, entry.dirName, 'package.json')
    const manifest = await readJsonFile(packageJsonPath)
    if (!isPlainObject(manifest)) {
      throw new Error(`Invalid package manifest object in ${packageJsonPath}`)
    }
    if (manifest.private === true) {
      continue
    }
    if (typeof manifest.name !== 'string' || manifest.name.trim().length === 0) {
      throw new Error(`Missing package name in ${packageJsonPath}`)
    }
    if (seenNames.has(manifest.name)) {
      throw new Error(`Duplicate publishable package name "${manifest.name}" at ${packageJsonPath}`)
    }
    seenNames.add(manifest.name)
    packages.push({
      name: manifest.name,
      version: typeof manifest.version === 'string' ? manifest.version : undefined,
      directory: entry.directory,
      dirName: entry.dirName,
      packageJsonPath,
    })
  }

  if (packages.length === 0) {
    throw new Error(`No publishable packages found under ${resolvedRoot}`)
  }

  return packages
}

export async function resolveTargetVersion({ root = process.cwd(), version, tag, env = process.env } = {}) {
  if (version !== undefined && version !== null && String(version).trim() !== '') {
    return assertValidSemver(String(version).trim(), 'Target version (--version)')
  }

  if (tag !== undefined && tag !== null && String(tag).trim() !== '') {
    return assertValidSemver(stripLeadingV(String(tag).trim()), 'Release tag (--tag)')
  }

  const envReleaseTag = env?.RELEASE_TAG
  if (typeof envReleaseTag === 'string' && envReleaseTag.trim().length > 0) {
    return assertValidSemver(stripLeadingV(envReleaseTag.trim()), 'RELEASE_TAG')
  }

  const resolvedRoot = resolve(root)
  const releaseManifest = await readJsonFile(join(resolvedRoot, 'release-manifest.json'), { optional: true })
  if (releaseManifest !== null) {
    if (!isPlainObject(releaseManifest)) {
      throw new Error('release-manifest.json must contain a JSON object')
    }
    const manifestVersion = releaseManifest.pending?.version ?? releaseManifest.current?.version
    if (manifestVersion !== undefined && manifestVersion !== null) {
      return assertValidSemver(manifestVersion, 'release-manifest.json version')
    }
  }

  const rootManifest = await readJsonFile(join(resolvedRoot, 'package.json'), { optional: true })
  if (rootManifest !== null) {
    if (!isPlainObject(rootManifest)) {
      throw new Error('package.json must contain a JSON object')
    }
    if (rootManifest.version !== undefined && rootManifest.version !== null) {
      return assertValidSemver(rootManifest.version, 'Root package.json version')
    }
  }

  throw new Error('Unable to resolve target release version from --version, --tag, RELEASE_TAG, release-manifest.json, or package.json')
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const options = {
    root: process.cwd(),
    registry: DEFAULT_REGISTRY,
    distTag: DEFAULT_DIST_TAG,
    verifyTarball: false,
    retries: DEFAULT_RETRIES,
    retryDelayMs: DEFAULT_RETRY_DELAY_MS,
    maxRetryDelayMs: DEFAULT_MAX_RETRY_DELAY_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    concurrency: DEFAULT_CONCURRENCY,
    json: false,
  }

  const readValue = (args, index, flagName, inlineValue) => {
    if (inlineValue !== undefined) {
      if (inlineValue.length === 0) {
        throw new Error(`Missing value for ${flagName}`)
      }
      return { value: inlineValue, nextIndex: index }
    }
    const next = args[index + 1]
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`Missing value for ${flagName}`)
    }
    return { value: next, nextIndex: index + 1 }
  }

  for (let index = 0; index < argv.length; index += 1) {
    const rawArg = argv[index]
    if (typeof rawArg !== 'string') continue

    const eqPos = rawArg.indexOf('=')
    const flag = eqPos >= 0 ? rawArg.slice(0, eqPos) : rawArg
    const inlineValue = eqPos >= 0 ? rawArg.slice(eqPos + 1) : undefined

    switch (flag) {
      case '--version': {
        const { value, nextIndex } = readValue(argv, index, flag, inlineValue)
        options.version = value
        index = nextIndex
        break
      }
      case '--tag': {
        const { value, nextIndex } = readValue(argv, index, flag, inlineValue)
        options.tag = value
        index = nextIndex
        break
      }
      case '--root': {
        const { value, nextIndex } = readValue(argv, index, flag, inlineValue)
        options.root = resolve(value)
        index = nextIndex
        break
      }
      case '--registry': {
        const { value, nextIndex } = readValue(argv, index, flag, inlineValue)
        options.registry = value
        index = nextIndex
        break
      }
      case '--dist-tag': {
        const { value, nextIndex } = readValue(argv, index, flag, inlineValue)
        options.distTag = value
        index = nextIndex
        break
      }
      case '--no-dist-tag': {
        if (inlineValue !== undefined) {
          throw new Error(`${flag} does not accept a value`)
        }
        options.distTag = null
        break
      }
      case '--verify-tarball': {
        if (inlineValue !== undefined) {
          throw new Error(`${flag} does not accept a value`)
        }
        options.verifyTarball = true
        break
      }
      case '--retries': {
        const { value, nextIndex } = readValue(argv, index, flag, inlineValue)
        options.retries = parseIntegerOption(value, flag, 0)
        index = nextIndex
        break
      }
      case '--retry-delay-ms': {
        const { value, nextIndex } = readValue(argv, index, flag, inlineValue)
        options.retryDelayMs = parseIntegerOption(value, flag, 0)
        index = nextIndex
        break
      }
      case '--max-retry-delay-ms': {
        const { value, nextIndex } = readValue(argv, index, flag, inlineValue)
        options.maxRetryDelayMs = parseIntegerOption(value, flag, 0)
        index = nextIndex
        break
      }
      case '--timeout-ms': {
        const { value, nextIndex } = readValue(argv, index, flag, inlineValue)
        options.timeoutMs = parseIntegerOption(value, flag, 1)
        index = nextIndex
        break
      }
      case '--concurrency': {
        const { value, nextIndex } = readValue(argv, index, flag, inlineValue)
        options.concurrency = parseIntegerOption(value, flag, 1)
        index = nextIndex
        break
      }
      case '--json': {
        if (inlineValue !== undefined) {
          throw new Error(`${flag} does not accept a value`)
        }
        options.json = true
        break
      }
      default:
        throw new Error(`Unknown CLI argument: ${rawArg}`)
    }
  }

  options.registry = normalizeRegistry(options.registry)
  return options
}

function parseRetryAfterMs(response) {
  const raw = response?.headers?.get?.('retry-after')
  if (!raw) return null
  const trimmed = raw.trim()
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1000
  }
  const timestamp = Date.parse(trimmed)
  if (Number.isFinite(timestamp)) {
    return Math.max(0, timestamp - Date.now())
  }
  return null
}

function computeRetryDelayMs(attemptIndex, response, retryDelayMs, maxRetryDelayMs) {
  const retryAfterMs = parseRetryAfterMs(response)
  const rawDelay = retryAfterMs !== null ? retryAfterMs : retryDelayMs * (2 ** attemptIndex)
  return Math.min(maxRetryDelayMs, Math.max(0, rawDelay))
}

function isRetryableHttpStatus(status) {
  return status === 404 || status === 408 || status === 429 || (status >= 500 && status <= 599)
}

async function drainBody(response) {
  try {
    await response?.body?.cancel?.()
  } catch {
    // Ignore cancellation failures when cleaning up unused HTTP bodies.
  }
}

function validateHttpUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null
  }
  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString()
    }
    return null
  } catch {
    return null
  }
}

async function probeTarballUrl(tarballUrl, {
  retries,
  retryDelayMs,
  maxRetryDelayMs,
  timeoutMs,
  fetchImpl,
  sleepImpl,
}) {
  const maxAttempts = retries + 1
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response
    try {
      response = await fetchImpl(tarballUrl, {
        method: 'HEAD',
        headers: {
          'cache-control': 'no-cache',
          pragma: 'no-cache',
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.status === 405) {
        await drainBody(response)
        response = await fetchImpl(tarballUrl, {
          method: 'GET',
          headers: {
            range: 'bytes=0-0',
            'cache-control': 'no-cache',
            pragma: 'no-cache',
          },
          signal: AbortSignal.timeout(timeoutMs),
        })
      }
    } catch (error) {
      const reason = `Tarball probe error: ${error instanceof Error ? error.message : String(error)}`
      if (attempt + 1 < maxAttempts) {
        await sleepImpl(computeRetryDelayMs(attempt, null, retryDelayMs, maxRetryDelayMs))
        continue
      }
      return { ok: false, status: null, attempts: attempt + 1, reason }
    }

    const { status } = response
    await drainBody(response)

    if (response.ok) {
      return { ok: true, status, attempts: attempt + 1 }
    }

    const reason = `Tarball probe returned HTTP ${status}`
    if (isRetryableHttpStatus(status) && attempt + 1 < maxAttempts) {
      await sleepImpl(computeRetryDelayMs(attempt, response, retryDelayMs, maxRetryDelayMs))
      continue
    }
    return { ok: false, status, attempts: attempt + 1, reason }
  }

  return { ok: false, status: null, attempts: maxAttempts, reason: 'Tarball probe exhausted retries' }
}

export async function verifyPackageOnRegistry(pkg, options = {}) {
  if (!pkg || typeof pkg.name !== 'string' || pkg.name.trim().length === 0) {
    throw new Error('Package descriptor must include a non-empty name')
  }

  const targetVersion = assertValidSemver(
    options.version ?? options.targetVersion ?? pkg.version,
    `Target version for ${pkg.name}`,
  )
  const registry = normalizeRegistry(options.registry ?? DEFAULT_REGISTRY)
  const distTag = options.distTag === undefined ? DEFAULT_DIST_TAG : options.distTag
  const verifyTarball = options.verifyTarball === true
  const retries = options.retries ?? DEFAULT_RETRIES
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const sleepImpl = options.sleepImpl ?? delay

  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation is not available')
  }

  const packumentUrl = `${registry}/${encodeURIComponent(pkg.name)}`
  const maxAttempts = retries + 1

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response
    try {
      response = await fetchImpl(packumentUrl, {
        method: 'GET',
        headers: {
          accept: 'application/vnd.npm.install-v1+json, application/json;q=0.9',
          'cache-control': 'no-cache',
          pragma: 'no-cache',
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const reason = `Network/timeout error querying ${packumentUrl}: ${error instanceof Error ? error.message : String(error)}`
      if (attempt + 1 < maxAttempts) {
        await sleepImpl(computeRetryDelayMs(attempt, null, retryDelayMs, maxRetryDelayMs))
        continue
      }
      return {
        ok: false,
        name: pkg.name,
        expectedVersion: targetVersion,
        distTag,
        status: null,
        attempts: attempt + 1,
        reason,
      }
    }

    const { status } = response

    if (!response.ok) {
      await drainBody(response)
      const reason = `Registry returned HTTP ${status} for ${pkg.name}`
      if (isRetryableHttpStatus(status) && attempt + 1 < maxAttempts) {
        await sleepImpl(computeRetryDelayMs(attempt, response, retryDelayMs, maxRetryDelayMs))
        continue
      }
      return {
        ok: false,
        name: pkg.name,
        expectedVersion: targetVersion,
        distTag,
        status,
        attempts: attempt + 1,
        reason,
      }
    }

    let payload
    try {
      payload = await response.json()
    } catch (error) {
      const reason = `Invalid JSON packument for ${pkg.name}: ${error instanceof Error ? error.message : String(error)}`
      if (attempt + 1 < maxAttempts) {
        await sleepImpl(computeRetryDelayMs(attempt, response, retryDelayMs, maxRetryDelayMs))
        continue
      }
      return {
        ok: false,
        name: pkg.name,
        expectedVersion: targetVersion,
        distTag,
        status,
        attempts: attempt + 1,
        reason,
      }
    }

    if (!isPlainObject(payload)) {
      return {
        ok: false,
        name: pkg.name,
        expectedVersion: targetVersion,
        distTag,
        status,
        attempts: attempt + 1,
        reason: `Registry returned non-object packument for ${pkg.name}`,
      }
    }

    if (payload.name !== undefined && payload.name !== pkg.name) {
      return {
        ok: false,
        name: pkg.name,
        expectedVersion: targetVersion,
        distTag,
        status,
        attempts: attempt + 1,
        reason: `Package name mismatch: expected ${pkg.name}, got ${String(payload.name)}`,
      }
    }

    const versions = isPlainObject(payload.versions) ? payload.versions : null
    const hasTargetVersion = versions !== null && Object.hasOwn(versions, targetVersion)
    if (!hasTargetVersion) {
      const available = versions ? Object.keys(versions).join(', ') || '<none>' : '<missing versions>'
      const reason = `Version ${targetVersion} missing in packument for ${pkg.name} (available: ${available})`
      if (attempt + 1 < maxAttempts) {
        await sleepImpl(computeRetryDelayMs(attempt, response, retryDelayMs, maxRetryDelayMs))
        continue
      }
      return {
        ok: false,
        name: pkg.name,
        expectedVersion: targetVersion,
        distTag,
        status,
        attempts: attempt + 1,
        reason,
      }
    }

    const versionMeta = versions[targetVersion]
    if (!isPlainObject(versionMeta)) {
      return {
        ok: false,
        name: pkg.name,
        expectedVersion: targetVersion,
        distTag,
        status,
        attempts: attempt + 1,
        reason: `Version entry ${targetVersion} for ${pkg.name} is not an object`,
      }
    }

    if (versionMeta.version !== undefined && versionMeta.version !== targetVersion) {
      return {
        ok: false,
        name: pkg.name,
        expectedVersion: targetVersion,
        distTag,
        status,
        attempts: attempt + 1,
        reason: `Version metadata mismatch for ${pkg.name}: expected ${targetVersion}, got ${String(versionMeta.version)}`,
      }
    }

    if (distTag !== null) {
      const distTags = isPlainObject(payload['dist-tags']) ? payload['dist-tags'] : null
      const actualDistTagVersion = distTags ? distTags[distTag] : undefined
      if (actualDistTagVersion !== targetVersion) {
        const reason = `dist-tags.${distTag} for ${pkg.name} is ${String(actualDistTagVersion)}, expected ${targetVersion}`
        if (attempt + 1 < maxAttempts) {
          await sleepImpl(computeRetryDelayMs(attempt, response, retryDelayMs, maxRetryDelayMs))
          continue
        }
        return {
          ok: false,
          name: pkg.name,
          expectedVersion: targetVersion,
          distTag,
          status,
          attempts: attempt + 1,
          reason,
        }
      }
    }

    const tarballUrl = validateHttpUrl(versionMeta.dist?.tarball)
    if (tarballUrl === null) {
      return {
        ok: false,
        name: pkg.name,
        expectedVersion: targetVersion,
        distTag,
        status,
        attempts: attempt + 1,
        reason: `Missing or invalid dist.tarball URL for ${pkg.name}@${targetVersion}: ${String(versionMeta.dist?.tarball)}`,
      }
    }

    let tarballStatus = null
    if (verifyTarball) {
      const tarballProbe = await probeTarballUrl(tarballUrl, {
        retries,
        retryDelayMs,
        maxRetryDelayMs,
        timeoutMs,
        fetchImpl,
        sleepImpl,
      })
      if (!tarballProbe.ok) {
        return {
          ok: false,
          name: pkg.name,
          expectedVersion: targetVersion,
          distTag,
          tarball: tarballUrl,
          status: tarballProbe.status ?? status,
          attempts: attempt + 1,
          reason: `${tarballProbe.reason} (${tarballUrl})`,
        }
      }
      tarballStatus = tarballProbe.status
    }

    return {
      ok: true,
      name: pkg.name,
      version: targetVersion,
      distTag,
      tarball: tarballUrl,
      status,
      tarballStatus,
      attempts: attempt + 1,
    }
  }

  return {
    ok: false,
    name: pkg.name,
    expectedVersion: targetVersion,
    distTag,
    status: null,
    attempts: maxAttempts,
    reason: `Exhausted retries verifying ${pkg.name}@${targetVersion}`,
  }
}

function assertPendingManifestMatchesDiscovered(releaseManifest, targetVersion, packages) {
  if (!isPlainObject(releaseManifest) || releaseManifest.pending?.version !== targetVersion) {
    return
  }
  const pendingPackages = releaseManifest.pending.packages
  if (!isPlainObject(pendingPackages)) {
    throw new Error(`release-manifest.json pending.packages must be an object for ${targetVersion}`)
  }
  const discoveredNames = new Set(packages.map((pkg) => pkg.name))
  const pendingNames = new Set(Object.keys(pendingPackages))

  const missingFromManifest = [...discoveredNames].filter((name) => !pendingNames.has(name))
  const extraInManifest = [...pendingNames].filter((name) => !discoveredNames.has(name))
  if (missingFromManifest.length > 0 || extraInManifest.length > 0) {
    throw new Error(
      `release-manifest.json pending.packages mismatch for ${targetVersion}: `
      + `missing=[${missingFromManifest.join(', ')}], extra=[${extraInManifest.join(', ')}]`,
    )
  }
}

export async function verifyNpmRelease(options = {}) {
  const root = resolve(options.root ?? process.cwd())
  const registry = normalizeRegistry(options.registry ?? DEFAULT_REGISTRY)
  const distTag = options.distTag === undefined ? DEFAULT_DIST_TAG : options.distTag
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error(`concurrency must be a positive integer (got: ${String(concurrency)})`)
  }

  const targetVersion = await resolveTargetVersion({
    root,
    version: options.version,
    tag: options.tag,
    env: options.env ?? process.env,
  })
  const packages = await discoverPublishablePackages(root)

  const releaseManifest = await readJsonFile(join(root, 'release-manifest.json'), { optional: true })
  assertPendingManifestMatchesDiscovered(releaseManifest, targetVersion, packages)

  const results = Array.from({ length: packages.length })
  let nextIndex = 0
  const workerCount = Math.min(concurrency, packages.length)

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex
        nextIndex += 1
        if (currentIndex >= packages.length) {
          return
        }
        const pkg = packages[currentIndex]
        results[currentIndex] = await verifyPackageOnRegistry(pkg, {
          ...options,
          version: targetVersion,
          registry,
          distTag,
        })
      }
    }),
  )

  const failed = results.filter((result) => !result.ok)
  const passed = results.length - failed.length

  return {
    ok: failed.length === 0,
    version: targetVersion,
    registry,
    distTag,
    total: results.length,
    passed,
    failed,
    results,
  }
}

export async function main(argv = process.argv.slice(2)) {
  let parsed
  try {
    parsed = parseCliArgs(argv)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
    return
  }

  let report
  try {
    report = await verifyNpmRelease({
      ...parsed,
      env: process.env,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`)
    } else {
      process.stderr.write(`${message}\n`)
    }
    process.exitCode = 1
    return
  }

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (!report.ok) {
      process.exitCode = 1
    }
    return
  }

  const tagSummary = report.distTag === null ? 'none' : report.distTag
  process.stdout.write(
    `Verified ${report.passed}/${report.total} packages at ${report.version} `
    + `(registry=${report.registry}, dist-tag=${tagSummary})\n`,
  )

  if (!report.ok) {
    for (const failure of report.failed) {
      const statusText = failure.status === null ? 'network-error' : `HTTP ${failure.status}`
      process.stderr.write(
        `FAIL ${failure.name}@${report.version} [${statusText}, attempts=${failure.attempts}]: ${failure.reason}\n`,
      )
    }
    process.exitCode = 1
  }
}

const isDirectExecution = typeof process.argv[1] === 'string'
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectExecution) {
  await main()
}
