import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import {
  discoverPublishablePackages,
  parseCliArgs,
  resolveTargetVersion,
  verifyNpmRelease,
  verifyPackageOnRegistry,
} from '../scripts/verify-npm-release.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const verifyScriptPath = join(repoRoot, 'scripts', 'verify-npm-release.mjs')

const temporaryDirs: string[] = []
const activeServers: Server[] = []

async function createTempDir(prefix = 'dsh-verify-npm-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirs.push(dir)
  return dir
}

async function writeJson(filePath: string, value: unknown) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function startMockRegistry(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; server: Server }> {
  const server = createServer(handler)
  activeServers.push(server)
  await new Promise<void>((resolveReady, rejectReady) => {
    server.once('error', rejectReady)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', rejectReady)
      resolveReady()
    })
  })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    server,
  }
}

function makePackument(
  baseUrl: string,
  packageName: string,
  versions: string[],
  latestVersion: string,
  overrides?: {
    packumentName?: string
    versionOverride?: string
    tarballUrl?: string
  },
) {
  const versionEntries: Record<string, unknown> = {}
  for (const version of versions) {
    versionEntries[version] = {
      name: overrides?.packumentName ?? packageName,
      version: overrides?.versionOverride ?? version,
      dist: {
        tarball: overrides?.tarballUrl ?? `${baseUrl}/tarballs/${encodeURIComponent(packageName)}-${version}.tgz`,
      },
    }
  }
  return {
    name: overrides?.packumentName ?? packageName,
    'dist-tags': {
      latest: latestVersion,
    },
    versions: versionEntries,
  }
}

function extractRequestedPackage(urlPath: string): string | null {
  const trimmed = urlPath.split('?')[0]?.replace(/^\/+/, '') ?? ''
  if (trimmed.length === 0 || trimmed.startsWith('tarballs/')) {
    return null
  }
  return decodeURIComponent(trimmed)
}

afterEach(async () => {
  while (activeServers.length > 0) {
    const server = activeServers.pop()
    if (!server) continue
    server.closeAllConnections?.()
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose())
    })
  }
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop()
    if (!dir) continue
    await rm(dir, { recursive: true, force: true })
  }
})

describe('verify-npm-release', () => {
  test('discovers all 40 publishable workspace packages and rejects invalid/private/duplicate manifests', async () => {
    const packages = await discoverPublishablePackages(repoRoot)
    const pluginCount = packages.filter((pkg: { directory: string }) => pkg.directory === 'plugins').length
    const packageCount = packages.filter((pkg: { directory: string }) => pkg.directory === 'packages').length

    expect(packages).toHaveLength(40)
    expect(pluginCount).toBe(36)
    expect(packageCount).toBe(4)
    expect(packages.some((pkg: { name: string }) => pkg.name === '@dsh-ray/assistant-association')).toBe(true)

    const fixtureRoot = await createTempDir()
    await mkdir(join(fixtureRoot, 'plugins', 'public-one'), { recursive: true })
    await mkdir(join(fixtureRoot, 'plugins', 'private-one'), { recursive: true })
    await mkdir(join(fixtureRoot, 'packages', 'shared-lib'), { recursive: true })
    await writeJson(join(fixtureRoot, 'plugins', 'public-one', 'package.json'), {
      name: '@fixture/public-one',
      version: '0.1.84',
    })
    await writeJson(join(fixtureRoot, 'plugins', 'private-one', 'package.json'), {
      name: '@fixture/private-one',
      version: '0.1.84',
      private: true,
    })
    await writeJson(join(fixtureRoot, 'packages', 'shared-lib', 'package.json'), {
      name: '@fixture/shared-lib',
      version: '0.1.84',
    })

    const discovered = await discoverPublishablePackages(fixtureRoot)
    expect(discovered.map((pkg: { name: string }) => pkg.name)).toEqual([
      '@fixture/shared-lib',
      '@fixture/public-one',
    ])

    await writeJson(join(fixtureRoot, 'plugins', 'private-one', 'package.json'), {
      name: '@fixture/shared-lib',
      version: '0.1.84',
    })
    await expect(discoverPublishablePackages(fixtureRoot)).rejects.toThrow(/Duplicate publishable package name/i)

    await writeJson(join(fixtureRoot, 'plugins', 'private-one', 'package.json'), {
      version: '0.1.84',
    })
    await expect(discoverPublishablePackages(fixtureRoot)).rejects.toThrow(/Missing package name in/i)

    await writeFile(join(fixtureRoot, 'plugins', 'private-one', 'package.json'), '{not valid json', 'utf8')
    await expect(discoverPublishablePackages(fixtureRoot)).rejects.toThrow(/Invalid JSON in/i)

    const emptyRoot = await createTempDir()
    await expect(discoverPublishablePackages(emptyRoot)).rejects.toThrow(/No publishable packages found/i)
  })

  test('resolves target version according to strict precedence and validates semver', async () => {
    const fixtureRoot = await createTempDir()
    await writeJson(join(fixtureRoot, 'package.json'), {
      name: 'fixture-root',
      version: '0.1.80',
      private: true,
    })

    expect(await resolveTargetVersion({ root: fixtureRoot, env: {} })).toBe('0.1.80')

    await writeJson(join(fixtureRoot, 'release-manifest.json'), {
      schemaVersion: 1,
      current: { version: '0.1.81' },
      pending: null,
    })
    expect(await resolveTargetVersion({ root: fixtureRoot, env: {} })).toBe('0.1.81')

    await writeJson(join(fixtureRoot, 'release-manifest.json'), {
      schemaVersion: 1,
      current: { version: '0.1.81' },
      pending: { version: '0.1.82' },
    })
    expect(await resolveTargetVersion({ root: fixtureRoot, env: {} })).toBe('0.1.82')
    expect(await resolveTargetVersion({
      root: fixtureRoot,
      env: { RELEASE_TAG: 'v0.1.83' },
    })).toBe('0.1.83')
    expect(await resolveTargetVersion({
      root: fixtureRoot,
      tag: 'v0.1.84',
      env: { RELEASE_TAG: 'v0.1.83' },
    })).toBe('0.1.84')
    expect(await resolveTargetVersion({
      root: fixtureRoot,
      version: '0.1.85',
      tag: 'v0.1.84',
      env: { RELEASE_TAG: 'v0.1.83' },
    })).toBe('0.1.85')

    await expect(resolveTargetVersion({ root: fixtureRoot, version: 'not-semver', env: {} }))
      .rejects.toThrow(/valid semantic version/i)
  })

  test('verifies 40/40 packages including tarball probes and Range GET fallback on 405', async () => {
    const seenHeaders: Record<string, string | string[] | undefined>[] = []
    let head405Used = false
    let rangeGetUsed = false

    const { url } = await startMockRegistry((req, res) => {
      const reqUrl = req.url ?? '/'
      if (reqUrl.startsWith('/tarballs/')) {
        if (req.method === 'HEAD' && reqUrl.includes('assistant-association')) {
          head405Used = true
          res.statusCode = 405
          res.end()
          return
        }
        if (req.method === 'GET' && req.headers.range === 'bytes=0-0') {
          rangeGetUsed = true
          res.statusCode = 206
          res.end('x')
          return
        }
        res.statusCode = req.method === 'HEAD' ? 200 : 404
        res.end()
        return
      }

      const packageName = extractRequestedPackage(reqUrl)
      if (!packageName) {
        res.statusCode = 404
        res.end()
        return
      }
      seenHeaders.push(req.headers)
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(makePackument(url, packageName, ['0.1.83', '0.1.84'], '0.1.84')))
    })

    const report = await verifyNpmRelease({
      root: repoRoot,
      version: '0.1.84',
      registry: url,
      verifyTarball: true,
      retries: 1,
      retryDelayMs: 5,
      maxRetryDelayMs: 20,
    })

    expect(report.ok).toBe(true)
    expect(report.version).toBe('0.1.84')
    expect(report.total).toBe(40)
    expect(report.passed).toBe(40)
    expect(report.failed).toEqual([])
    expect(head405Used).toBe(true)
    expect(rangeGetUsed).toBe(true)
    expect(seenHeaders[0]?.accept).toContain('application/vnd.npm.install-v1+json')
    expect(seenHeaders[0]?.['cache-control']).toBe('no-cache')
  })

  test('fails 39/40 without short-circuiting when @dsh-ray/assistant-association returns 404', async () => {
    const queriedPackages = new Set<string>()
    const { url } = await startMockRegistry((req, res) => {
      const packageName = extractRequestedPackage(req.url ?? '/')
      if (!packageName) {
        res.statusCode = 404
        res.end()
        return
      }
      queriedPackages.add(packageName)
      if (packageName === '@dsh-ray/assistant-association') {
        res.statusCode = 404
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: 'Not found' }))
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(makePackument(url, packageName, ['0.1.84'], '0.1.84')))
    })

    const report = await verifyNpmRelease({
      root: repoRoot,
      version: '0.1.84',
      registry: url,
      retries: 1,
      retryDelayMs: 5,
      maxRetryDelayMs: 20,
    })

    expect(queriedPackages.size).toBe(40)
    expect(report.ok).toBe(false)
    expect(report.total).toBe(40)
    expect(report.passed).toBe(39)
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]).toMatchObject({
      ok: false,
      name: '@dsh-ray/assistant-association',
      status: 404,
      attempts: 2,
    })
  })

  test('retries transient 5xx, 404, and stale-200 packuments until propagation succeeds', async () => {
    const counts = new Map<string, number>()
    const { url } = await startMockRegistry((req, res) => {
      const packageName = extractRequestedPackage(req.url ?? '/')
      if (!packageName) {
        res.statusCode = 404
        res.end()
        return
      }
      const attempt = (counts.get(packageName) ?? 0) + 1
      counts.set(packageName, attempt)

      if (packageName === '@dsh-ray/assistant-association' && attempt <= 2) {
        res.statusCode = 404
        res.end('Not found yet')
        return
      }
      if (packageName === '@dsh-ray/acp' && attempt <= 2) {
        res.statusCode = 503
        res.setHeader('retry-after', '0')
        res.end('Unavailable')
        return
      }
      if (packageName === 'dsh-ray' && attempt === 1) {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(makePackument(url, packageName, ['0.1.83'], '0.1.83')))
        return
      }
      if (packageName === '@dsh-ray/assistant-actions' && attempt === 1) {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(makePackument(url, packageName, ['0.1.83', '0.1.84'], '0.1.83')))
        return
      }

      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(makePackument(url, packageName, ['0.1.83', '0.1.84'], '0.1.84')))
    })

    const report = await verifyNpmRelease({
      root: repoRoot,
      version: '0.1.84',
      registry: url,
      retries: 3,
      retryDelayMs: 5,
      maxRetryDelayMs: 20,
    })

    expect(report.ok).toBe(true)
    expect(report.passed).toBe(40)
    expect(counts.get('@dsh-ray/assistant-association')).toBe(3)
    expect(counts.get('@dsh-ray/acp')).toBe(3)
    expect(counts.get('dsh-ray')).toBe(2)
    expect(counts.get('@dsh-ray/assistant-actions')).toBe(2)
  })

  test('fails on exhausted retries, non-retryable 4xx/mismatches, dist-tag mismatch, and missing tarball', async () => {
    const requestCounts = new Map<string, number>()
    const { url } = await startMockRegistry((req, res) => {
      const reqUrl = req.url ?? '/'
      if (reqUrl.startsWith('/tarballs/')) {
        res.statusCode = reqUrl.includes('tarball-404') ? 404 : 200
        res.end()
        return
      }
      const packageName = extractRequestedPackage(reqUrl)
      if (!packageName) {
        res.statusCode = 404
        res.end()
        return
      }
      requestCounts.set(packageName, (requestCounts.get(packageName) ?? 0) + 1)

      if (packageName === '@fixture/persistent-500') {
        res.statusCode = 500
        res.end('boom')
        return
      }
      if (packageName === '@fixture/forbidden-403') {
        res.statusCode = 403
        res.end('forbidden')
        return
      }
      if (packageName === '@fixture/name-mismatch') {
        res.statusCode = 200
        res.end(JSON.stringify(makePackument(url, packageName, ['0.1.84'], '0.1.84', {
          packumentName: '@fixture/other',
        })))
        return
      }
      if (packageName === '@fixture/version-mismatch') {
        res.statusCode = 200
        res.end(JSON.stringify(makePackument(url, packageName, ['0.1.84'], '0.1.84', {
          versionOverride: '0.1.83',
        })))
        return
      }
      if (packageName === '@fixture/dist-tag-mismatch') {
        res.statusCode = 200
        res.end(JSON.stringify(makePackument(url, packageName, ['0.1.83', '0.1.84'], '0.1.83')))
        return
      }
      if (packageName === '@fixture/bad-tarball-url') {
        res.statusCode = 200
        res.end(JSON.stringify(makePackument(url, packageName, ['0.1.84'], '0.1.84', {
          tarballUrl: 'ftp://invalid.example/pkg.tgz',
        })))
        return
      }
      if (packageName === '@fixture/tarball-404') {
        res.statusCode = 200
        res.end(JSON.stringify(makePackument(url, packageName, ['0.1.84'], '0.1.84', {
          tarballUrl: `${url}/tarballs/tarball-404.tgz`,
        })))
        return
      }

      res.statusCode = 200
      res.end(JSON.stringify(makePackument(url, packageName, ['0.1.83'], '0.1.83')))
    })

    const opts = { version: '0.1.84', registry: url, retries: 2, retryDelayMs: 5, maxRetryDelayMs: 10 }

    const persistent500 = await verifyPackageOnRegistry({ name: '@fixture/persistent-500' }, opts)
    expect(persistent500.ok).toBe(false)
    expect(persistent500.status).toBe(500)
    expect(persistent500.attempts).toBe(3)

    const forbidden403 = await verifyPackageOnRegistry({ name: '@fixture/forbidden-403' }, opts)
    expect(forbidden403.ok).toBe(false)
    expect(forbidden403.status).toBe(403)
    expect(forbidden403.attempts).toBe(1)

    const nameMismatch = await verifyPackageOnRegistry({ name: '@fixture/name-mismatch' }, opts)
    expect(nameMismatch.ok).toBe(false)
    expect(nameMismatch.reason).toContain('name mismatch')
    expect(requestCounts.get('@fixture/name-mismatch')).toBe(1)

    const versionMismatch = await verifyPackageOnRegistry({ name: '@fixture/version-mismatch' }, opts)
    expect(versionMismatch.ok).toBe(false)
    expect(versionMismatch.reason).toContain('Version metadata mismatch')
    expect(requestCounts.get('@fixture/version-mismatch')).toBe(1)

    const distTagMismatch = await verifyPackageOnRegistry({ name: '@fixture/dist-tag-mismatch' }, opts)
    expect(distTagMismatch.ok).toBe(false)
    expect(distTagMismatch.reason).toContain('dist-tags.latest')

    const distTagSkipped = await verifyPackageOnRegistry({ name: '@fixture/dist-tag-mismatch' }, {
      ...opts,
      distTag: null,
    })
    expect(distTagSkipped.ok).toBe(true)

    const badTarball = await verifyPackageOnRegistry({ name: '@fixture/bad-tarball-url' }, opts)
    expect(badTarball.ok).toBe(false)
    expect(badTarball.reason).toContain('dist.tarball')

    const missingTarball = await verifyPackageOnRegistry({ name: '@fixture/tarball-404' }, {
      ...opts,
      verifyTarball: true,
    })
    expect(missingTarball.ok).toBe(false)
    expect(missingTarball.status).toBe(404)

    const missingVersion = await verifyPackageOnRegistry({ name: '@fixture/only-0-1-83' }, opts)
    expect(missingVersion.ok).toBe(false)
    expect(missingVersion.reason).toContain('0.1.84 missing')
  })

  test('validates pending.packages in release-manifest.json against discovered workspace packages', async () => {
    const fixtureRoot = await createTempDir()
    await mkdir(join(fixtureRoot, 'plugins', 'alpha'), { recursive: true })
    await writeJson(join(fixtureRoot, 'plugins', 'alpha', 'package.json'), {
      name: '@fixture/alpha',
      version: '0.1.84',
    })
    await writeJson(join(fixtureRoot, 'release-manifest.json'), {
      schemaVersion: 1,
      pending: {
        version: '0.1.84',
        packages: {
          '@fixture/alpha': '0.1.84',
          '@fixture/extra': '0.1.84',
        },
      },
    })

    await expect(verifyNpmRelease({
      root: fixtureRoot,
      version: '0.1.84',
      registry: 'http://127.0.0.1:1',
    })).rejects.toThrow(/pending\.packages mismatch/i)
  })

  test('executes via CLI with --tag / RELEASE_TAG / --json / invalid args', async () => {
    const runVerifyCli = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
      new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveResult, rejectResult) => {
        const child = spawn(process.execPath, [verifyScriptPath, ...args], {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk
        })
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk
        })
        child.once('error', rejectResult)
        child.once('close', (status) => {
          resolveResult({ status, stdout, stderr })
        })
      })

    let failAssociation = false
    const { url } = await startMockRegistry((req, res) => {
      const reqUrl = req.url ?? '/'
      if (reqUrl.startsWith('/tarballs/')) {
        res.statusCode = 200
        res.end()
        return
      }
      const packageName = extractRequestedPackage(reqUrl)
      if (!packageName) {
        res.statusCode = 404
        res.end()
        return
      }
      if (failAssociation && packageName === '@dsh-ray/assistant-association') {
        res.statusCode = 404
        res.end('not found')
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(makePackument(url, packageName, ['0.1.84'], '0.1.84')))
    })

    const passRun = await runVerifyCli([
      '--root',
      repoRoot,
      '--registry',
      url,
      '--tag',
      'v0.1.84',
      '--verify-tarball',
      '--retries',
      '0',
    ])
    expect(passRun.status, passRun.stderr).toBe(0)
    expect(passRun.stdout).toContain('Verified 40/40 packages at 0.1.84')

    failAssociation = true
    const failRun = await runVerifyCli(
      [
        '--root',
        repoRoot,
        '--registry',
        url,
        '--retries',
        '0',
        '--retry-delay-ms',
        '5',
      ],
      { ...process.env, RELEASE_TAG: 'v0.1.84' },
    )
    expect(failRun.status).toBe(1)
    expect(failRun.stdout).toContain('Verified 39/40 packages at 0.1.84')
    expect(failRun.stderr).toContain('@dsh-ray/assistant-association')
    expect(failRun.stderr).toContain('HTTP 404')

    const jsonFailRun = await runVerifyCli([
      '--root',
      repoRoot,
      '--registry',
      url,
      '--version',
      '0.1.84',
      '--retries',
      '0',
      '--json',
    ])
    expect(jsonFailRun.status).toBe(1)
    const parsedJson = JSON.parse(jsonFailRun.stdout) as { ok: boolean; passed: number; total: number; failed: Array<{ name: string }> }
    expect(parsedJson.ok).toBe(false)
    expect(parsedJson.total).toBe(40)
    expect(parsedJson.passed).toBe(39)
    expect(parsedJson.failed[0]?.name).toBe('@dsh-ray/assistant-association')

    const badArgRun = await runVerifyCli(['--unknown-flag'])
    expect(badArgRun.status).toBe(1)
    expect(badArgRun.stderr).toContain('Unknown CLI argument')
    expect(() => parseCliArgs(['--retries', '-1'])).toThrow(/integer >= 0/)
  })
})
