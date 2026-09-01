import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, test } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseScript = join(repoRoot, 'scripts', 'release-version.mjs')
const temporaryRoots: string[] = []

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function readJson(path: string) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function createRepository(currentVersion = '0.1.0', withLibrary = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-enhanced-release-'))
  temporaryRoots.push(root)
  await mkdir(join(root, 'plugins', 'example', 'src'), { recursive: true })
  await writeJson(join(root, 'package.json'), {
    name: 'release-fixture',
    version: currentVersion,
    private: true,
  })
  await writeJson(join(root, 'plugins', 'example', 'package.json'), {
    name: '@fixture/example',
    version: currentVersion,
  })
  await writeFile(
    join(root, 'plugins', 'example', 'src', 'version.ts'),
    `export const version = '${currentVersion}'\n`,
  )
  if (withLibrary) {
    await mkdir(join(root, 'packages', 'shared', 'src'), { recursive: true })
    await writeJson(join(root, 'packages', 'shared', 'package.json'), {
      name: '@fixture/shared',
      version: currentVersion,
    })
    await writeFile(
      join(root, 'packages', 'shared', 'src', 'version.ts'),
      `export const version = '${currentVersion}'\n`,
    )
  }
  const current = {
    version: currentVersion,
    releasedAt: '2026-08-18T00:00:00.000Z',
    packages: {
      '@fixture/example': currentVersion,
      ...(withLibrary ? { '@fixture/shared': currentVersion } : {}),
    },
  }
  await writeJson(join(root, 'release-manifest.json'), {
    schemaVersion: 1,
    current,
    pending: null,
    history: [current],
  })
  return root
}

function runRelease(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [releaseScript, ...args, '--root', root], {
    encoding: 'utf8',
  })
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('release version workflow', () => {
  test('commands use the repository root when --root is omitted', () => {
    const result = spawnSync(process.execPath, [releaseScript, 'status'], { encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Next default:')
  })

  test('prepare defaults to incrementing the recorded patch version', async () => {
    const root = await createRepository('0.1.0')

    const result = runRelease(root, 'prepare')

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Prepared release 0.1.1')
    expect((await readJson(join(root, 'package.json'))).version).toBe('0.1.1')
    expect((await readJson(join(root, 'plugins', 'example', 'package.json'))).version).toBe('0.1.1')
    expect(await readFile(join(root, 'plugins', 'example', 'src', 'version.ts'), 'utf8'))
      .toBe("export const version = '0.1.1'\n")
    const ledger = await readJson(join(root, 'release-manifest.json'))
    expect(ledger.current.version).toBe('0.1.0')
    expect(ledger.pending.version).toBe('0.1.1')
    expect(ledger.pending.packages).toEqual({ '@fixture/example': '0.1.1' })
  })

  test('record promotes the pending release and appends immutable history', async () => {
    const root = await createRepository('0.1.0')
    expect(runRelease(root, 'prepare').status).toBe(0)

    const result = runRelease(root, 'record')

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Recorded release 0.1.1')
    const ledger = await readJson(join(root, 'release-manifest.json'))
    expect(ledger.pending).toBeNull()
    expect(ledger.current.version).toBe('0.1.1')
    expect(ledger.current.releasedAt).toEqual(expect.any(String))
    expect(ledger.current.packages).toEqual({ '@fixture/example': '0.1.1' })
    expect(ledger.history.map((release: { version: string }) => release.version)).toEqual([
      '0.1.0',
      '0.1.1',
    ])
  })

  test('prepare accepts an explicit version override', async () => {
    const root = await createRepository('0.1.0')

    const result = runRelease(root, 'prepare', '1.0.0')

    expect(result.status, result.stderr).toBe(0)
    const ledger = await readJson(join(root, 'release-manifest.json'))
    expect(ledger.pending.version).toBe('1.0.0')
    expect((await readJson(join(root, 'plugins', 'example', 'package.json'))).version).toBe('1.0.0')
  })

  test('supersede advances a failed pending release without recording it as successful', async () => {
    const root = await createRepository('0.1.0', true)
    expect(runRelease(root, 'prepare').status).toBe(0)

    const result = runRelease(root, 'supersede', '0.1.2')

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Superseded pending release 0.1.1 with 0.1.2')
    expect((await readJson(join(root, 'package.json'))).version).toBe('0.1.2')
    expect((await readJson(join(root, 'plugins', 'example', 'package.json'))).version).toBe('0.1.2')
    expect((await readJson(join(root, 'packages', 'shared', 'package.json'))).version).toBe('0.1.2')
    expect(await readFile(join(root, 'plugins', 'example', 'src', 'version.ts'), 'utf8'))
      .toBe("export const version = '0.1.2'\n")
    const ledger = await readJson(join(root, 'release-manifest.json'))
    expect(ledger.current.version).toBe('0.1.0')
    expect(ledger.history.map((release: { version: string }) => release.version)).toEqual(['0.1.0'])
    expect(ledger.pending.version).toBe('0.1.2')
    expect(ledger.pending.packages).toEqual({
      '@fixture/example': '0.1.2',
      '@fixture/shared': '0.1.2',
    })
  })

  test('supersede requires an explicit version greater than the pending release', async () => {
    const root = await createRepository('0.1.0')
    expect(runRelease(root, 'prepare').status).toBe(0)

    let result = runRelease(root, 'supersede')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('An explicit replacement version is required')

    result = runRelease(root, 'supersede', '0.1.1')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('must be greater than pending release 0.1.1')
    expect((await readJson(join(root, 'package.json'))).version).toBe('0.1.1')
  })

  test('versions ordinary publishable packages together with plugins', async () => {
    const root = await createRepository('0.1.0', true)

    const result = runRelease(root, 'prepare')

    expect(result.status, result.stderr).toBe(0)
    expect((await readJson(join(root, 'packages', 'shared', 'package.json'))).version).toBe('0.1.1')
    expect(await readFile(join(root, 'packages', 'shared', 'src', 'version.ts'), 'utf8'))
      .toBe("export const version = '0.1.1'\n")
    const ledger = await readJson(join(root, 'release-manifest.json'))
    expect(ledger.pending.packages).toMatchObject({
      '@fixture/example': '0.1.1',
      '@fixture/shared': '0.1.1',
    })
  })

  test('verify-tag accepts a stable tag matching the complete pending release', async () => {
    const root = await createRepository('0.1.0', true)
    expect(runRelease(root, 'prepare').status).toBe(0)

    const result = runRelease(root, 'verify-tag', 'v0.1.1')

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Verified release tag v0.1.1')
    const ledger = await readJson(join(root, 'release-manifest.json'))
    expect(ledger.current.version).toBe('0.1.0')
    expect(ledger.pending.version).toBe('0.1.1')
  })

  test.each([
    '0.1.1',
    'v0.1',
    'v0.1.1-beta.1',
    'v0.1.1+build.1',
    'v00.1.1',
    'v0.1.1suffix',
  ])('verify-tag rejects non-stable release tag %s', async tag => {
    const root = await createRepository('0.1.0')
    expect(runRelease(root, 'prepare').status).toBe(0)

    const result = runRelease(root, 'verify-tag', tag)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Release tag must be a stable semantic version in the form vX.Y.Z')
  })

  test('verify-tag requires a tag argument', async () => {
    const root = await createRepository('0.1.0')
    expect(runRelease(root, 'prepare').status).toBe(0)

    const result = runRelease(root, 'verify-tag')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Release tag must be a stable semantic version in the form vX.Y.Z: missing')
  })

  test('verify-tag rejects a stable tag that differs from pending', async () => {
    const root = await createRepository('0.1.0')
    expect(runRelease(root, 'prepare').status).toBe(0)

    const result = runRelease(root, 'verify-tag', 'v0.2.0')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Release tag v0.2.0 does not match pending release v0.1.1')
  })

  test('verify-tag requires a pending release', async () => {
    const root = await createRepository('0.1.0')

    const result = runRelease(root, 'verify-tag', 'v0.1.0')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('There is no pending release to verify')
  })

  test('verify-tag rejects a non-stable pending version', async () => {
    const root = await createRepository('0.1.0')
    const ledgerPath = join(root, 'release-manifest.json')
    const ledger = await readJson(ledgerPath)
    ledger.pending = {
      version: '0.1.1-beta.1',
      preparedAt: '2026-08-27T00:00:00.000Z',
      packages: { '@fixture/example': '0.1.1-beta.1' },
    }
    await writeJson(ledgerPath, ledger)

    const result = runRelease(root, 'verify-tag', 'v0.1.1')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Pending release version is not a stable semantic version')
  })

  test('verify-tag requires the root version to match pending', async () => {
    const root = await createRepository('0.1.0')
    expect(runRelease(root, 'prepare').status).toBe(0)
    const rootManifestPath = join(root, 'package.json')
    const rootManifest = await readJson(rootManifestPath)
    rootManifest.version = '0.2.0'
    await writeJson(rootManifestPath, rootManifest)

    const result = runRelease(root, 'verify-tag', 'v0.1.1')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Root package is 0.2.0, expected 0.1.1')
  })

  test('verify-tag rejects packages missing from the pending set', async () => {
    const root = await createRepository('0.1.0', true)
    expect(runRelease(root, 'prepare').status).toBe(0)
    const ledgerPath = join(root, 'release-manifest.json')
    const ledger = await readJson(ledgerPath)
    delete ledger.pending.packages['@fixture/shared']
    await writeJson(ledgerPath, ledger)

    const result = runRelease(root, 'verify-tag', 'v0.1.1')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Pending release is missing packages: @fixture/shared')
  })

  test('verify-tag rejects packages that are extra in the pending set', async () => {
    const root = await createRepository('0.1.0')
    expect(runRelease(root, 'prepare').status).toBe(0)
    const ledgerPath = join(root, 'release-manifest.json')
    const ledger = await readJson(ledgerPath)
    ledger.pending.packages['@fixture/removed'] = '0.1.1'
    await writeJson(ledgerPath, ledger)

    const result = runRelease(root, 'verify-tag', 'v0.1.1')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Pending release has extra packages: @fixture/removed')
  })

  test('verify-tag rejects duplicate workspace package names', async () => {
    const root = await createRepository('0.1.0')
    expect(runRelease(root, 'prepare').status).toBe(0)
    await mkdir(join(root, 'packages', 'duplicate', 'src'), { recursive: true })
    await writeJson(join(root, 'packages', 'duplicate', 'package.json'), {
      name: '@fixture/example',
      version: '0.1.1',
    })
    await writeFile(
      join(root, 'packages', 'duplicate', 'src', 'version.ts'),
      "export const version = '0.1.1'\n",
    )

    const result = runRelease(root, 'verify-tag', 'v0.1.1')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Duplicate workspace package name @fixture/example')
    expect(result.stderr).toContain('plugins/example')
    expect(result.stderr).toContain('packages/duplicate')
  })

  test('verify-tag requires every pending package version to equal pending', async () => {
    const root = await createRepository('0.1.0')
    expect(runRelease(root, 'prepare').status).toBe(0)
    const ledgerPath = join(root, 'release-manifest.json')
    const ledger = await readJson(ledgerPath)
    ledger.pending.packages['@fixture/example'] = '0.1.0'
    await writeJson(ledgerPath, ledger)

    const result = runRelease(root, 'verify-tag', 'v0.1.1')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('@fixture/example pending version is 0.1.0, expected 0.1.1')
  })

  test('verify-tag rejects a package manifest version that differs from pending', async () => {
    const root = await createRepository('0.1.0')
    expect(runRelease(root, 'prepare').status).toBe(0)
    const pluginPath = join(root, 'plugins', 'example', 'package.json')
    const pluginManifest = await readJson(pluginPath)
    pluginManifest.version = '9.9.9'
    await writeJson(pluginPath, pluginManifest)

    const result = runRelease(root, 'verify-tag', 'v0.1.1')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('@fixture/example is 9.9.9, expected 0.1.1')
  })

  test('verify-tag rejects a missing runtime version export', async () => {
    const root = await createRepository('0.1.0')
    expect(runRelease(root, 'prepare').status).toBe(0)
    await writeFile(join(root, 'plugins', 'example', 'src', 'version.ts'), 'export {}\n')

    const result = runRelease(root, 'verify-tag', 'v0.1.1')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('@fixture/example src/version.ts must export exactly one version')
  })

  test('verify-tag rejects a runtime version that differs from pending', async () => {
    const root = await createRepository('0.1.0')
    expect(runRelease(root, 'prepare').status).toBe(0)
    await writeFile(
      join(root, 'plugins', 'example', 'src', 'version.ts'),
      "export const version = '9.9.9'\n",
    )

    const result = runRelease(root, 'verify-tag', 'v0.1.1')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('@fixture/example runtime version is 9.9.9, expected 0.1.1')
  })

  test('verify-tag rejects duplicate runtime version exports', async () => {
    const root = await createRepository('0.1.0')
    expect(runRelease(root, 'prepare').status).toBe(0)
    await writeFile(
      join(root, 'plugins', 'example', 'src', 'version.ts'),
      "export const version = '0.1.1'\nexport const version = '0.1.1'\n",
    )

    const result = runRelease(root, 'verify-tag', 'v0.1.1')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('@fixture/example src/version.ts must export exactly one version')
  })

  test.each([
    [
      'comment bait',
      "// export const version = '0.1.1'\nexport const version = process.env.RUNTIME_VERSION\n",
    ],
    [
      'string bait',
      "const bait = \"export const version = '0.1.1'\"\nexport const version = process.env.RUNTIME_VERSION\n",
    ],
    [
      'extra statement',
      "export const version = '0.1.1'\nexport const extra = true\n",
    ],
    [
      'dynamic expression',
      'export const version = process.env.RUNTIME_VERSION\n',
    ],
  ])('verify-tag rejects runtime %s', async (_description, source) => {
    const root = await createRepository('0.1.0')
    expect(runRelease(root, 'prepare').status).toBe(0)
    await writeFile(join(root, 'plugins', 'example', 'src', 'version.ts'), source)

    const result = runRelease(root, 'verify-tag', 'v0.1.1')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('must export exactly one version as a stable literal and contain no other code')
  })

  test('prepare rejects comment bait through the shared runtime parser without writing versions', async () => {
    const root = await createRepository('0.1.0')
    const versionPath = join(root, 'plugins', 'example', 'src', 'version.ts')
    const bait = "// export const version = '0.1.0'\nexport const version = process.env.RUNTIME_VERSION\n"
    await writeFile(versionPath, bait)

    const result = runRelease(root, 'prepare')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('must export exactly one version as a stable literal and contain no other code')
    expect((await readJson(join(root, 'package.json'))).version).toBe('0.1.0')
    expect((await readJson(join(root, 'plugins', 'example', 'package.json'))).version).toBe('0.1.0')
    expect(await readFile(versionPath, 'utf8')).toBe(bait)
    expect((await readJson(join(root, 'release-manifest.json'))).pending).toBeNull()
  })

  test('prepare accepts reasonable whitespace and rewrites a canonical runtime export', async () => {
    const root = await createRepository('0.1.0')
    const versionPath = join(root, 'plugins', 'example', 'src', 'version.ts')
    await writeFile(versionPath, '  export const version = "0.1.0" ;  \n')

    const result = runRelease(root, 'prepare')

    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(versionPath, 'utf8')).toBe("export const version = '0.1.1'\n")
  })

  test('verify-tag rejects an unstable current release version', async () => {
    const root = await createRepository('0.1.0')
    expect(runRelease(root, 'prepare').status).toBe(0)
    const ledgerPath = join(root, 'release-manifest.json')
    const ledger = await readJson(ledgerPath)
    ledger.current.version = '0.1.0-beta.1'
    ledger.history[0].version = '0.1.0-beta.1'
    await writeJson(ledgerPath, ledger)

    const result = runRelease(root, 'verify-tag', 'v0.1.1')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Current release version is not a stable semantic version')
  })

  test('verify-tag rejects an unsupported release manifest schema', async () => {
    const root = await createRepository('0.1.0')
    expect(runRelease(root, 'prepare').status).toBe(0)
    const ledgerPath = join(root, 'release-manifest.json')
    const ledger = await readJson(ledgerPath)
    ledger.schemaVersion = 2
    await writeJson(ledgerPath, ledger)

    const result = runRelease(root, 'verify-tag', 'v0.1.1')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Unsupported release manifest schema version: 2')
  })

  test('verify-tag rejects an empty history when current exists', async () => {
    const root = await createRepository('0.1.0')
    expect(runRelease(root, 'prepare').status).toBe(0)
    const ledgerPath = join(root, 'release-manifest.json')
    const ledger = await readJson(ledgerPath)
    ledger.history = []
    await writeJson(ledgerPath, ledger)

    const result = runRelease(root, 'verify-tag', 'v0.1.1')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Release history must contain the current release')
  })

  test('verify-tag rejects a history tail that differs from current', async () => {
    const root = await createRepository('0.1.0')
    expect(runRelease(root, 'prepare').status).toBe(0)
    const ledgerPath = join(root, 'release-manifest.json')
    const ledger = await readJson(ledgerPath)
    ledger.history[0].releasedAt = '2026-08-19T00:00:00.000Z'
    await writeJson(ledgerPath, ledger)

    const result = runRelease(root, 'verify-tag', 'v0.1.1')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Release history tail must match the current release')
  })

  test('verify-tag rejects a malformed earlier history entry', async () => {
    const root = await createRepository('0.1.0')
    expect(runRelease(root, 'prepare').status).toBe(0)
    const ledgerPath = join(root, 'release-manifest.json')
    const ledger = await readJson(ledgerPath)
    ledger.history.unshift({ version: 'garbage' })
    await writeJson(ledgerPath, ledger)

    const result = runRelease(root, 'verify-tag', 'v0.1.1')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Release history entry 0 version is not a stable semantic version')
  })

  test('verify-tag rejects non-increasing release history', async () => {
    const root = await createRepository('0.1.0')
    expect(runRelease(root, 'prepare').status).toBe(0)
    const ledgerPath = join(root, 'release-manifest.json')
    const ledger = await readJson(ledgerPath)
    ledger.history.unshift({
      ...ledger.current,
      releasedAt: '2026-08-17T00:00:00.000Z',
    })
    await writeJson(ledgerPath, ledger)

    const result = runRelease(root, 'verify-tag', 'v0.1.1')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Release history entry 1 version 0.1.0 must be greater than 0.1.0')
  })

  test('verify-tag rejects a recorded package version that differs from its release', async () => {
    const root = await createRepository('0.1.0')
    expect(runRelease(root, 'prepare').status).toBe(0)
    const ledgerPath = join(root, 'release-manifest.json')
    const ledger = await readJson(ledgerPath)
    ledger.current.packages['@fixture/example'] = '9.9.9'
    ledger.history[0].packages['@fixture/example'] = '9.9.9'
    await writeJson(ledgerPath, ledger)

    const result = runRelease(root, 'verify-tag', 'v0.1.1')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Current release package @fixture/example is 9.9.9, expected 0.1.0')
  })

  test('prepare validates the existing ledger before changing version files', async () => {
    const root = await createRepository('0.1.0')
    const ledgerPath = join(root, 'release-manifest.json')
    const ledger = await readJson(ledgerPath)
    ledger.schemaVersion = 2
    await writeJson(ledgerPath, ledger)

    const result = runRelease(root, 'prepare')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Unsupported release manifest schema version: 2')
    expect((await readJson(join(root, 'package.json'))).version).toBe('0.1.0')
    expect((await readJson(join(root, 'plugins', 'example', 'package.json'))).version).toBe('0.1.0')
    expect(await readFile(join(root, 'plugins', 'example', 'src', 'version.ts'), 'utf8'))
      .toBe("export const version = '0.1.0'\n")
    expect((await readJson(ledgerPath)).pending).toBeNull()
  })

  test('prepare rejects a root version that drifted from current without writing', async () => {
    const root = await createRepository('0.1.0')
    const rootManifestPath = join(root, 'package.json')
    const rootManifest = await readJson(rootManifestPath)
    rootManifest.version = '9.9.9'
    await writeJson(rootManifestPath, rootManifest)

    const result = runRelease(root, 'prepare')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Root package is 9.9.9, expected current release 0.1.0')
    expect((await readJson(join(root, 'plugins', 'example', 'package.json'))).version).toBe('0.1.0')
    expect((await readJson(join(root, 'release-manifest.json'))).pending).toBeNull()
  })

  test.each([false, 0, ''])('prepare rejects malformed falsy pending value %j without writing', async pending => {
    const root = await createRepository('0.1.0')
    const ledgerPath = join(root, 'release-manifest.json')
    const ledger = await readJson(ledgerPath)
    ledger.pending = pending
    await writeJson(ledgerPath, ledger)

    const result = runRelease(root, 'prepare')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Pending release must be an object or null')
    expect((await readJson(join(root, 'package.json'))).version).toBe('0.1.0')
    expect((await readJson(join(root, 'plugins', 'example', 'package.json'))).version).toBe('0.1.0')
    expect((await readJson(ledgerPath)).pending).toBe(pending)
  })

  test('prepare rejects an existing package version drift without writing', async () => {
    const root = await createRepository('0.1.0')
    const packageManifestPath = join(root, 'plugins', 'example', 'package.json')
    const packageManifest = await readJson(packageManifestPath)
    packageManifest.version = '9.9.9'
    await writeJson(packageManifestPath, packageManifest)
    await writeFile(join(root, 'plugins', 'example', 'src', 'version.ts'), "export const version = '9.9.9'\n")

    const result = runRelease(root, 'prepare')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('@fixture/example is 9.9.9, expected current release 0.1.0')
    expect((await readJson(join(root, 'package.json'))).version).toBe('0.1.0')
    expect((await readJson(join(root, 'release-manifest.json'))).pending).toBeNull()
  })

  test('prepare rejects duplicate package names without writing', async () => {
    const root = await createRepository('0.1.0')
    await mkdir(join(root, 'packages', 'duplicate', 'src'), { recursive: true })
    await writeJson(join(root, 'packages', 'duplicate', 'package.json'), {
      name: '@fixture/example',
      version: '0.1.0',
    })
    await writeFile(join(root, 'packages', 'duplicate', 'src', 'version.ts'), "export const version = '0.1.0'\n")

    const result = runRelease(root, 'prepare')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Duplicate workspace package name @fixture/example')
    expect((await readJson(join(root, 'package.json'))).version).toBe('0.1.0')
    expect((await readJson(join(root, 'release-manifest.json'))).pending).toBeNull()
  })

  test('verify-tag rejects invalid recorded and pending timestamps', async () => {
    const root = await createRepository('0.1.0')
    expect(runRelease(root, 'prepare').status).toBe(0)
    const ledgerPath = join(root, 'release-manifest.json')
    const ledger = await readJson(ledgerPath)
    ledger.current.releasedAt = 'not-a-timestamp'
    ledger.history[0].releasedAt = 'not-a-timestamp'
    await writeJson(ledgerPath, ledger)

    let result = runRelease(root, 'verify-tag', 'v0.1.1')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Current release releasedAt must be an ISO 8601 UTC timestamp')

    ledger.current.releasedAt = '2026-08-18T00:00:00.000Z'
    ledger.history[0].releasedAt = '2026-08-18T00:00:00.000Z'
    ledger.pending.preparedAt = 'not-a-timestamp'
    await writeJson(ledgerPath, ledger)
    result = runRelease(root, 'verify-tag', 'v0.1.1')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Pending release preparedAt must be an ISO 8601 UTC timestamp')
  })

  test.each(['0.1.0', '0.0.9'])('verify-tag rejects pending version %s that does not advance current', async pendingVersion => {
    const root = await createRepository('0.1.0')
    const ledgerPath = join(root, 'release-manifest.json')
    const ledger = await readJson(ledgerPath)
    ledger.pending = {
      version: pendingVersion,
      preparedAt: '2026-08-27T00:00:00.000Z',
      packages: { '@fixture/example': pendingVersion },
    }
    await writeJson(ledgerPath, ledger)

    const result = runRelease(root, 'verify-tag', `v${pendingVersion}`)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`Pending release ${pendingVersion} must be greater than current release 0.1.0`)
  })

  test('verify-tag accepts an initial pending release with null current and empty history', async () => {
    const root = await createRepository('0.1.0')
    const ledgerPath = join(root, 'release-manifest.json')
    await writeJson(ledgerPath, {
      schemaVersion: 1,
      current: null,
      pending: {
        version: '0.1.0',
        preparedAt: '2026-08-27T00:00:00.000Z',
        packages: { '@fixture/example': '0.1.0' },
      },
      history: [],
    })

    const result = runRelease(root, 'verify-tag', 'v0.1.0')

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Verified release tag v0.1.0')
  })

  test('root release commands include packages and bootstrap cyclic peer builds', async () => {
    const manifest = await readJson(join(repoRoot, 'package.json'))

    expect(manifest.scripts['pack:check']).toContain("--filter './packages/*'")
    expect(manifest.scripts['release:publish']).toContain("--filter './packages/*'")
    expect(manifest.scripts['release:supersede']).toContain('release-version.mjs supersede')
    expect(manifest.scripts.build).toMatch(/^pnpm run build:bootstrap &&/)
    expect(manifest.scripts['build:bootstrap']).toBe(
      'pnpm run build:packages'
      + ' && pnpm --filter @dsh-enhanced/assistant-policy run build'
      + ' && pnpm --filter @dsh-enhanced/assistant-evaluation run build'
      + ' && pnpm --filter @dsh-enhanced/assistant-delivery run build',
    )
    expect(manifest.scripts.test).toMatch(/^pnpm run build &&/)
    expect(manifest.scripts.typecheck).toMatch(/^pnpm run build &&/)
  })

  test('status shows the recorded version and next default patch', async () => {
    const root = await createRepository('0.1.0')

    const result = runRelease(root, 'status')

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Current release: 0.1.0')
    expect(result.stdout).toContain('Pending release: none')
    expect(result.stdout).toContain('Next default: 0.1.1')
  })

  test('prepare rejects an explicit version that does not advance the record', async () => {
    const root = await createRepository('1.2.3')

    const result = runRelease(root, 'prepare', '1.2.3')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('must be greater than current release 1.2.3')
    expect((await readJson(join(root, 'package.json'))).version).toBe('1.2.3')
    expect((await readJson(join(root, 'release-manifest.json'))).pending).toBeNull()
  })

  test('record refuses a pending release when a package version drifted', async () => {
    const root = await createRepository('0.1.0')
    expect(runRelease(root, 'prepare').status).toBe(0)
    const pluginPath = join(root, 'plugins', 'example', 'package.json')
    const pluginManifest = await readJson(pluginPath)
    pluginManifest.version = '9.9.9'
    await writeJson(pluginPath, pluginManifest)

    const result = runRelease(root, 'record')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('@fixture/example is 9.9.9, expected 0.1.1')
    const ledger = await readJson(join(root, 'release-manifest.json'))
    expect(ledger.current.version).toBe('0.1.0')
    expect(ledger.pending.version).toBe('0.1.1')
  })

  test('record reports a record-specific error when no release is pending', async () => {
    const root = await createRepository('0.1.0')

    const result = runRelease(root, 'record')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('There is no pending release to record')
  })

  test('record accepts an initial pending release with null current and empty history', async () => {
    const root = await createRepository('0.1.0')
    const ledgerPath = join(root, 'release-manifest.json')
    await writeJson(ledgerPath, {
      schemaVersion: 1,
      current: null,
      pending: {
        version: '0.1.0',
        preparedAt: '2026-08-27T00:00:00.000Z',
        packages: { '@fixture/example': '0.1.0' },
      },
      history: [],
    })

    const result = runRelease(root, 'record')

    expect(result.status, result.stderr).toBe(0)
    const ledger = await readJson(ledgerPath)
    expect(ledger.current.version).toBe('0.1.0')
    expect(ledger.pending).toBeNull()
    expect(ledger.history).toEqual([ledger.current])
  })

  test('status supports an initial pending release before any version is recorded', async () => {
    const root = await createRepository('0.1.0')
    const ledgerPath = join(root, 'release-manifest.json')
    await writeJson(ledgerPath, {
      schemaVersion: 1,
      current: null,
      pending: {
        version: '0.1.0',
        preparedAt: '2026-08-18T00:00:00.000Z',
        packages: { '@fixture/example': '0.1.0' },
      },
      history: [],
    })

    const result = runRelease(root, 'status')

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Current release: none')
    expect(result.stdout).toContain('Pending release: 0.1.0')
    expect(result.stdout).toContain('Next default: 0.1.1')
  })

  test('record refuses a pending release when the runtime version drifted', async () => {
    const root = await createRepository('0.1.0')
    expect(runRelease(root, 'prepare').status).toBe(0)
    await writeFile(
      join(root, 'plugins', 'example', 'src', 'version.ts'),
      "export const version = '0.1.0'\n",
    )

    const result = runRelease(root, 'record')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('@fixture/example runtime version is 0.1.0, expected 0.1.1')
  })
})
