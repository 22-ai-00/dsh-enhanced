import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { prepareRsiSourceWorkspace } from '../src/rsi-source.js'
import {
  prepareNativeRsiRuntime,
  readNativeRsiRuntime,
  validateFrozenNativeManifests,
  type FrozenNativeManifestSource,
} from '../src/rsi-native-runtime-bootstrap.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

const nodeArchivePath = process.env.DSH_TEST_NATIVE_NODE_ARCHIVE
const pnpmArchivePath = process.env.DSH_TEST_NATIVE_PNPM_ARCHIVE

test.runIf(process.platform === 'darwin' && nodeArchivePath && pnpmArchivePath)(
  'installs frozen manifests with official Node and pnpm, replays exactly and rejects runtime drift', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-native-runtime-')))
    roots.push(root)
    const dshHome = join(root, 'home'), profile = 'runtime-test'
    await mkdir(dshHome, { mode: 0o700 })
    const repository = resolve(import.meta.dirname, '../../..')
    const version = JSON.parse(execFileSync('/usr/bin/git', ['show', 'HEAD:package.json'], { cwd: repository, encoding: 'utf8' })).version as string
    const source = await prepareRsiSourceWorkspace({ dshHome, profile, version, sourceRepository: repository })
    const originalBlob = execFileSync('/usr/bin/git', ['rev-parse', `${source.sourceCommit}:package.json`],
      { cwd: source.repository, encoding: 'utf8' }).trim()
    const originalManifest = JSON.parse(execFileSync('/usr/bin/git', ['show', `${source.sourceCommit}:package.json`],
      { cwd: source.repository, encoding: 'utf8' })) as Record<string, unknown>
    const replacement = JSON.stringify({ ...originalManifest, packageManager: 'pnpm@0.0.0' })
    const replacementBlob = execFileSync('/usr/bin/git', ['hash-object', '-w', '--stdin'],
      { cwd: source.repository, input: replacement, encoding: 'utf8' }).trim()
    execFileSync('/usr/bin/git', ['update-ref', `refs/replace/${originalBlob}`, replacementBlob], { cwd: source.repository })
    const replacementEnvironment = { ...process.env }
    delete replacementEnvironment.GIT_NO_REPLACE_OBJECTS
    expect(execFileSync('/usr/bin/git', ['show', `${source.sourceCommit}:package.json`],
      { cwd: source.repository, encoding: 'utf8', env: replacementEnvironment }))
      .toContain('pnpm@0.0.0')
    const input = { dshHome, profile, source, nodeArchivePath: nodeArchivePath!, pnpmArchivePath: pnpmArchivePath! }
    const badArchive = join(root, 'bad-node.tgz')
    await writeFile(badArchive, 'not an official archive', { mode: 0o600 })
    await expect(prepareNativeRsiRuntime({ ...input, nodeArchivePath: badArchive }))
      .rejects.toThrow('official bootstrap archive digest differs')
    const first = await prepareNativeRsiRuntime(input)
    expect(first).toMatchObject({ schemaVersion: 2, sourceCommit: source.sourceCommit,
      sourceBuild: { backend: 'macos-seatbelt', timeoutMs: 60_000, outputBytes: 1_048_576 } })
    const runtimeRoot = join(dshHome, 'rsi-native-runtimes', profile, 'runtime')
    await expect(lstat(join(runtimeRoot, 'plugins', 'lark-channel', 'src'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(runtimeRoot, '.npmrc'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(dshHome, 'rsi-native-runtimes', profile, 'cache'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await prepareNativeRsiRuntime(input)).toEqual(first)
    expect(await readNativeRsiRuntime(input)).toEqual(first)
    const receiptPath = join(dshHome, 'rsi-native-runtimes', profile, 'bootstrap.json')
    await chmod(receiptPath, 0o644)
    await expect(readNativeRsiRuntime(input)).rejects.toThrow('native bootstrap receipt is unsafe')
    await chmod(receiptPath, 0o600)
    expect(await readNativeRsiRuntime(input)).toEqual(first)
    const manifestPath = join(dshHome, 'rsi-native-runtimes', profile, 'runtime', 'package.json')
    const original = await readFile(manifestPath)
    await writeFile(manifestPath, Buffer.concat([original, Buffer.from('changed')]))
    await expect(readNativeRsiRuntime(input)).rejects.toThrow()
    await writeFile(manifestPath, original); await chmod(manifestPath, 0o600)
    expect(await readNativeRsiRuntime(input)).toEqual(first)
    await rm(manifestPath)
    await expect(prepareNativeRsiRuntime(input)).rejects.toThrow()
  }, 240_000)

const manifestVersion = '0.1.83'
function baseManifests(): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name: 'dsh-ray', version: manifestVersion, packageManager: 'pnpm@11.7.0' }),
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    'packages/fixture/package.json': JSON.stringify({ name: '@fixture/one', version: manifestVersion }),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '@fixture/one':\n        specifier: workspace:*\n        version: link:packages/fixture\n  packages/fixture: {}\n",
  }
}
const manifestSource = (files = baseManifests()): FrozenNativeManifestSource => ({
  version: manifestVersion,
  manifests: Object.entries(files).map(([path, bytes]) => ({ path, bytes: Buffer.from(bytes) })),
})

test('validateFrozenNativeManifests accepts tldts-core plain-string deprecated URL advisory and enableGlobalVirtualStore: false', async () => {
  const files = baseManifests()
  const baseLock = files['pnpm-lock.yaml']!
  const withDeprecated = `${baseLock}packages:\n  tldts-core@7.4.20:\n    resolution: {integrity: sha512-C630TWXZCZmLq0F2bW4QqwnaaxCQ/svpAqvJwnC4JvgEM5ohhBnGsEzTLSOXcN+xjz+kEaHS5uoWIw2klnqd0A==}\n    deprecated: Partial release, see https://github.com/remusao/tldts/issues/2735. Use >=7.4.22.\n  good@1.0.0:\n    resolution: {tarball: https://registry.npmjs.org/good/-/good-1.0.0.tgz}\n`
  files['pnpm-lock.yaml'] = withDeprecated
  files['pnpm-workspace.yaml'] = 'packages:\n  - packages/*\nenableGlobalVirtualStore: false\nallowBuilds:\n  esbuild: true\n'
  const validated = validateFrozenNativeManifests(manifestSource(files))
  expect(validated.get('pnpm-lock.yaml')).toEqual(Buffer.from(withDeprecated))
  expect(validated.get('pnpm-workspace.yaml')).toEqual(Buffer.from(files['pnpm-workspace.yaml']))

  const repoRoot = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)))
  if (existsSync(join(repoRoot, 'pnpm-workspace.yaml'))) {
    const repoWs = await readFile(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
    const withRepoWs = validateFrozenNativeManifests(manifestSource({ ...files, 'pnpm-workspace.yaml': repoWs }))
    expect(withRepoWs.get('pnpm-workspace.yaml')).toEqual(Buffer.from(repoWs))
  }
})

test('validateFrozenNativeManifests rejects smuggling, non-string deprecated, YAML aliases, duplicate keys, traversal, and link escapes', () => {
  const files = baseManifests()
  const baseLock = files['pnpm-lock.yaml']!

  for (const badLock of [
    // Non-string deprecated or deprecated outside packages
    `${baseLock}packages:\n  evil@1.0.0:\n    resolution: {integrity: sha512-abc}\n    deprecated: {url: https://evil.invalid/a}\n`,
    `${baseLock}packages:\n  evil@1.0.0:\n    resolution: {integrity: sha512-abc}\n    deprecated: [https://evil.invalid/a]\n`,
    `${baseLock}packages:\n  evil@1.0.0:\n    resolution: {integrity: sha512-abc}\n    deprecated: null\n`,
    `${baseLock}snapshots:\n  evil@1.0.0:\n    deprecated: https://evil.invalid/a\n`,
    // Protocol & URL smuggling
    `${baseLock}packages:\n  evil@1.0.0:\n    resolution: {tarball: http://registry.npmjs.org/evil/-/evil-1.0.0.tgz}\n`,
    `${baseLock}packages:\n  evil@1.0.0:\n    resolution: {tarball: ssh://git@evil.com/repo.git}\n`,
    `${baseLock}packages:\n  evil@1.0.0:\n    resolution: {tarball: ftp://evil.com/pkg.tgz}\n`,
    `${baseLock}packages:\n  evil@1.0.0:\n    resolution: {tarball: github:evil/repo}\n`,
    `${baseLock}packages:\n  evil@1.0.0:\n    resolution: {tarball: gitlab:evil/repo}\n`,
    `${baseLock}packages:\n  evil@1.0.0:\n    resolution: {tarball: bitbucket:evil/repo}\n`,
    `${baseLock}packages:\n  evil@1.0.0:\n    resolution: {tarball: 'x:file:../evil.tgz'}\n`,
    `${baseLock}packages:\n  evil@1.0.0:\n    resolution: {tarball: 'https://registry.npmjs.org/@evil/pkg/../../evil'}\n`,
    `${baseLock}packages:\n  evil@1.0.0:\n    resolution: {tarball: 'https://registry.npmjs.org/@evil/pkg/%2e%2e/evil'}\n`,
    `${baseLock}packages:\n  evil@1.0.0:\n    resolution: {tarball: 'https://registry.npmjs.org/evil.tgz?next=https://evil.com'}\n`,
    `${baseLock}packages:\n  evil@1.0.0:\n    resolution: {tarball: 'https://registry.npmjs.org/evil.tgz#frag'}\n`,
    `${baseLock}packages:\n  evil@1.0.0:\n    resolution: {tarball: 'https://user:pass@registry.npmjs.org/evil.tgz'}\n`,
    `${baseLock}packages:\n  evil@1.0.0:\n    resolution: {tarball: 'https://registry.npmjs.org:443/evil.tgz'}\n`,
    // YAML aliases and duplicate keys
    `${baseLock}packages:\n  a@1.0.0: &anchor\n    resolution: {integrity: sha512-abc}\n  b@1.0.0: *anchor\n`,
    `${baseLock}packages:\n  a@1.0.0:\n    resolution: {integrity: sha512-abc}\n  a@1.0.0:\n    resolution: {integrity: sha512-def}\n`,
    // link: escape
    baseLock.replace('link:packages/fixture', 'link:../../outside'),
  ]) {
    expect(() => validateFrozenNativeManifests(manifestSource({ ...files, 'pnpm-lock.yaml': badLock })))
      .toThrow(/^rsi native bootstrap: /u)
  }

  // Workspace configuration & package configuration rejections
  expect(() => validateFrozenNativeManifests(manifestSource({
    ...files,
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\nenableGlobalVirtualStore: true\n',
  }))).toThrow('rsi native bootstrap: frozen workspace configuration virtual store invalid')

  expect(() => validateFrozenNativeManifests(manifestSource({
    ...files,
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\npackages:\n  - plugins/*\n',
  }))).toThrow('rsi native bootstrap: frozen workspace inventory is invalid')

  expect(() => validateFrozenNativeManifests(manifestSource({
    ...files,
    'package.json': JSON.stringify({ name: 'dsh-ray', version: manifestVersion, packageManager: 'pnpm@11.7.0', pnpm: { pnpmfile: '/tmp/evil.cjs' } }),
  }))).toThrow('rsi native bootstrap: frozen package configuration unsupported')
})
