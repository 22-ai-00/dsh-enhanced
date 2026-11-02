import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { freezeLinuxRuntimeSource, prepareLinuxRuntime, readLinuxRuntime, LinuxRsiRuntimeUnavailableError,
  type FrozenLinuxRuntimeSource } from '../src/native-resources.js'
import { copyLinuxRuntimeManifests } from '../src/linux-runtime-source.js'

const roots: string[] = []
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { force: true, recursive: true }) })
const version = '0.1.65'
function manifests(): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name: 'dsh-enhanced', version, packageManager: 'pnpm@11.7.0', scripts: { install: 'touch FORBIDDEN' } }),
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    'packages/fixture/package.json': JSON.stringify({ name: '@fixture/one', version }),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '@fixture/one':\n        specifier: workspace:*\n        version: link:packages/fixture\n  packages/fixture: {}\n",
  }
}
async function repository() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'native-resources-')); roots.push(root)
  const files = manifests()
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), bytes)
  }
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim()
  git('init', '--initial-branch=main'); git('add', '.'); git('commit', '-m', 'fixture')
  return { root, files, commit: git('rev-parse', 'HEAD'), git }
}
const sourceOf = (files = manifests()): FrozenLinuxRuntimeSource => ({ version, sourceCommit: 'a'.repeat(40),
  manifests: Object.entries(files).map(([path, bytes]) => ({ path, bytes: Buffer.from(bytes) })) })

test('public subentry imports independently without loading the activating package index', async () => {
  const module = await import('@dsh-enhanced/assistant-isolation/native-resources')
  expect(module.freezeLinuxRuntimeSource).toBeTypeOf('function')
  expect(module.probeLinuxIsolationRuntime).toBeTypeOf('function')
  expect(module).not.toHaveProperty('default')
  expect(module).not.toHaveProperty('AssistantIsolationService')
  const entry = await readFile(new URL('../src/native-resources.ts', import.meta.url), 'utf8')
  expect(entry).not.toContain("from './index")
})

test('fixed Git objects and dirty local HEAD freeze the same exact blobs without RSI preparation or scripts', async () => {
  const fixture = await repository()
  await writeFile(join(fixture.root, 'package.json'), '{dirty working tree}')
  const exact = await freezeLinuxRuntimeSource({ kind: 'git-object', repository: fixture.root, commit: fixture.commit, version })
  const head = await freezeLinuxRuntimeSource({ kind: 'local-head', repository: fixture.root, version })
  expect(head).toEqual(exact)
  expect(Object.fromEntries(exact.manifests.map(entry => [entry.path, Buffer.from(entry.bytes).toString()]))).toEqual(fixture.files)
  expect(await readFile(join(fixture.root, 'package.json'), 'utf8')).toBe('{dirty working tree}')
  await expect(readFile(join(fixture.root, 'FORBIDDEN'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(fixture.root, 'rsi-sources'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('a bare object repository is sufficient, without repairs branches or a checkout', async () => {
  const fixture = await repository(), bare = join(fixture.root, 'bare.git')
  fixture.git('clone', '--bare', '.', bare)
  const frozen = await freezeLinuxRuntimeSource({ kind: 'git-object', repository: bare, commit: fixture.commit, version })
  expect(frozen.sourceCommit).toBe(fixture.commit)
  expect(frozen.manifests).toHaveLength(4)
})

test('selection version, exact commit and cancellation reject without preparing resources', async () => {
  const fixture = await repository()
  await expect(freezeLinuxRuntimeSource({ kind: 'git-object', repository: fixture.root, commit: 'HEAD', version })).rejects.toThrow('SHA-1')
  await expect(freezeLinuxRuntimeSource({ kind: 'local-head', repository: fixture.root, version: '0.1.66' })).rejects.toThrow('identity differs')
  await expect(freezeLinuxRuntimeSource({ kind: 'official-tag', version: '../main' })).rejects.toThrow('version')
  const controller = new AbortController(); controller.abort(new Error('cancelled'))
  await expect(freezeLinuxRuntimeSource({ kind: 'local-head', repository: fixture.root, version, signal: controller.signal })).rejects.toThrow('cancelled')
})

test('copied manifests cannot drift through caller buffers and inventory cannot omit or duplicate paths', () => {
  const source = sourceOf(), copy = copyLinuxRuntimeManifests(source)
  source.manifests[0]!.bytes.fill(0)
  expect(JSON.parse(copy.get('package.json')!.toString()).name).toBe('dsh-enhanced')
  const original = sourceOf()
  expect(() => copyLinuxRuntimeManifests({ ...original, manifests: [...original.manifests, original.manifests[0]!] })).toThrow('inventory')
  expect(() => copyLinuxRuntimeManifests({ ...original, manifests: original.manifests.filter(entry => entry.path !== 'packages/fixture/package.json') })).toThrow(/inventory|link escapes/u)
  expect(() => copyLinuxRuntimeManifests({ ...original, manifests: [...original.manifests, { path: '../package.json', bytes: Buffer.from('{}') }] })).toThrow('inventory')
})

test('lockfile links, workspace versions and nonregistry resolutions are independently validated', () => {
  const files = manifests()
  expect(() => copyLinuxRuntimeManifests(sourceOf({ ...files, 'pnpm-lock.yaml': files['pnpm-lock.yaml']!.replace('link:packages/fixture', 'link:../../outside') }))).toThrow('link escapes')
  expect(() => copyLinuxRuntimeManifests(sourceOf({ ...files, 'packages/fixture/package.json': '{"name":"@fixture/one","version":"9.0.0"}' }))).toThrow('workspace manifest')
  expect(() => copyLinuxRuntimeManifests(sourceOf({ ...files, 'pnpm-lock.yaml': files['pnpm-lock.yaml']! + 'url: https://evil.invalid/a\n' }))).toThrow('resolution')
  expect(() => copyLinuxRuntimeManifests(sourceOf({ ...files, 'pnpm-workspace.yaml': 'packages: ["../*"]\n' }))).toThrow('inventory')
})

test.runIf(process.platform !== 'linux')('ordinary resources reject a real Mac platform without creating a Home or needing RSI', async () => {
  for (const operation of [prepareLinuxRuntime, readLinuxRuntime]) {
    await expect(operation({ dshHome: '/definitely-not-created-native-home', profile: 'ordinary', source: sourceOf() }))
      .rejects.toBeInstanceOf(LinuxRsiRuntimeUnavailableError)
  }
})

// Bounded freezing selects and copies bytes despite async caller changes.
test('source selection and returned bytes are detached across asynchronous Git reads', async () => {
  const fixture = await repository()
  const input = { kind: 'git-object' as const, repository: fixture.root, commit: fixture.commit, version }
  const pending = freezeLinuxRuntimeSource(input)
  input.commit = 'b'.repeat(40); input.version = '99.0.0'; input.repository = '/missing'
  const source = await pending
  expect(source.sourceCommit).toBe(fixture.commit)
  source.manifests[0]!.bytes.fill(0)
  const fresh = await freezeLinuxRuntimeSource({ kind: 'git-object', repository: fixture.root, commit: fixture.commit, version })
  expect(fresh.manifests[0]!.bytes.some(byte => byte !== 0)).toBe(true)
})

const executionSettings = [
  ['pnpmfile', '/private/tmp/forbidden.cjs'], ['globalPnpmfile', '/private/tmp/forbidden.cjs'],
  ['configDependencies', { '@fixture/hook': '1.0.0' }], ['modulesDir', '/private/tmp/outside-modules'],
  ['virtualStoreDir', '/private/tmp/outside-store'], ['storeDir', '/private/tmp/outside-store'],
  ['pacquet', '/private/tmp/forbidden'], ['managePackageManagerVersions', true],
] as const

test.each(executionSettings)('rejects workspace execution/directory setting %s before resource construction', (key, value) => {
  const files = manifests()
  const workspace = 'packages: ["packages/*"]\n' + `${key}: ${JSON.stringify(value)}\n`
  expect(() => copyLinuxRuntimeManifests(sourceOf({ ...files, 'pnpm-workspace.yaml': workspace })))
    .toThrow(/workspace configuration/u)
})

const packageConfigurations = [
  ['pnpm', { pnpm: { pnpmfile: '/private/tmp/forbidden.cjs' } }],
  ['devEngines.packageManager', { devEngines: { packageManager: { name: 'pnpm', version: '99.0.0', onFail: 'download' } } }],
  ['devEngines.runtime', { devEngines: { runtime: { name: 'node', version: '99.0.0', onFail: 'download' } } }],
  ['engines.runtime', { engines: { runtime: 'node@99.0.0' } }],
] as const
const packageCases = ['package.json', 'packages/fixture/package.json'].flatMap(path =>
  packageConfigurations.map(([setting, extra]) => ({ path, setting, extra })))
test.each(packageCases)('rejects $setting in $path before pnpm can select runtime/configuration', ({ path, extra }) => {
  const files = manifests()
  files[path] = JSON.stringify({ ...JSON.parse(files[path]!), ...extra })
  expect(() => copyLinuxRuntimeManifests(sourceOf(files))).toThrow(/configuration/u)
})

test.each([
  ['root', "lockfileVersion: '9.0'\nconfigDependencies:\n  '@fixture/hook': 1.0.0\nimporters:\n  .: {}\n  packages/fixture: {}\n"],
  ['importer', "lockfileVersion: '9.0'\nimporters:\n  .:\n    configDependencies:\n      '@fixture/hook':\n        specifier: 1.0.0\n        version: 1.0.0\n  packages/fixture: {}\n"],
])('rejects config dependencies hidden in lockfile %s', (_where, lock) => {
  expect(() => copyLinuxRuntimeManifests(sourceOf({ ...manifests(), 'pnpm-lock.yaml': lock })))
    .toThrow(/configuration/u)
})

test('reviewed declarative workspace settings and normal Node engine constraints retain exact receipt bytes', () => {
  const files = manifests()
  files['pnpm-workspace.yaml'] = 'packages: ["packages/*"]\ncatalog:\n  typescript: 6.0.3\nlinkWorkspacePackages: true\nallowBuilds:\n  esbuild: true\n  protobufjs: false\nminimumReleaseAgeExclude:\n  - "@deepseek-ai/dsh-agent@0.2.1-rc.2"\n'
  files['package.json'] = JSON.stringify({ ...JSON.parse(files['package.json']!), engines: { node: '^22.19.0 || >=24.0.0' } })
  const copied = copyLinuxRuntimeManifests(sourceOf(files))
  for (const [path, bytes] of Object.entries(files)) expect(copied.get(path)).toEqual(Buffer.from(bytes))
  for (const workspace of [
    'packages: ["packages/*"]\ncatalog: {typescript: "file:/outside"}\n',
    'packages: ["packages/*"]\nallowBuilds: {esbuild: "yes"}\n',
    'packages: ["packages/*"]\nlinkWorkspacePackages: "/outside"\n',
    'packages: ["packages/*"]\nminimumReleaseAgeExclude: ["../outside"]\n',
  ]) expect(() => copyLinuxRuntimeManifests(sourceOf({ ...files, 'pnpm-workspace.yaml': workspace })))
    .toThrow('workspace configuration')
})
