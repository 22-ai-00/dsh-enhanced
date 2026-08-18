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

async function createRepository(currentVersion = '0.1.0') {
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
  const current = {
    version: currentVersion,
    releasedAt: '2026-08-18T00:00:00.000Z',
    packages: {
      '@fixture/example': currentVersion,
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
