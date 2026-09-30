import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import * as sourceBuild from '../src/rsi-build.js'
import * as releaseBuild from '../src/rsi-release-build.js'
import { prepareRsiLocalCohort, verifyRsiLocalInstalledPackages } from '../src/rsi-local-cohort.js'
import { prepareRsiLocalUpdate, readRsiLocalUpdate } from '../src/rsi-local-update.js'
import { parseRsiSetupArgs } from '../src/rsi-setup.js'
import { prepareRsiAuthorityResources } from '../src/rsi-authority-resources.js'
import { prepareRsiSourceWorkspace } from '../src/rsi-source.js'
import { localCohortFixture, installFixture } from './fixtures/rsi-local-cohort.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
function git(cwd: string, ...args: string[]): string {
  return execFileSync('/usr/bin/git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
    { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
}
async function fixture(memory = false) {
  const f = await localCohortFixture(); roots.push(f.root)
  const bundles = ['target']
  const addBundle = async (slug: string, patch = '[]\n') => {
    const directory = join(f.sourceRepository, 'plugins', slug)
    await mkdir(join(directory, 'lib'), { recursive: true })
    const manifest = JSON.parse(await readFile(join(f.sourceRepository, 'plugins/assistant-policy/package.json'), 'utf8'))
    manifest.name = `@dsh-enhanced/${slug}`
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    await writeFile(join(directory, 'lib/index.js'), `export const identity = '${slug}'\n`)
    await writeFile(join(directory, 'README.md'), `# ${slug}\n`)
    await writeFile(join(directory, 'LICENSE'), 'MIT\n')
    await writeFile(join(directory, 'cordis.patch.yml'), patch)
  }
  let source = f.source
  if (memory) {
    for (const slug of ['personal-assistant', 'assistant-delivery', 'assistant-evaluation', 'assistant-verifier']) {
      await addBundle(slug); bundles.push(slug)
    }
    git(f.sourceRepository, 'add', '.'); git(f.sourceRepository, 'commit', '-m', 'initial providers')
    // Construct a fresh legacy installation from its committed provider set.
    await rm(join(f.home, 'rsi-sources'), { recursive: true })
    source = await prepareRsiSourceWorkspace({ dshHome: f.home, profile: f.profile,
      version: f.version, sourceRepository: f.sourceRepository })
  }
  const original = await prepareRsiLocalCohort({ dshHome: f.home, profile: f.profile, source, bundles }, f.ports)
  const installed = await installFixture(f, original)
  await mkdir(join(f.home, 'profiles'), { mode: 0o700 })
  const profilePath = join(f.home, 'profiles', f.profile)
  await rename(installed, profilePath)
  await writeFile(join(profilePath, 'cordis.patch.yml'), '# user patch retained\n')
  if (memory) {
    await writeFile(join(profilePath, 'cordis.patch.yml'), '[]\n')
    await prepareRsiAuthorityResources({ dshHome: f.home, profile: f.profile })
  }
  const args = { dshHome: f.home, profile: f.profile, sourceRepository: f.sourceRepository }
  const next = async () => {
    await writeFile(join(f.sourceRepository, 'plugins/target/lib/index.js'), "export const identity = 'updated'\n")
    git(f.sourceRepository, 'add', '.'); git(f.sourceRepository, 'commit', '-m', 'upstream update')
    return git(f.sourceRepository, 'rev-parse', 'HEAD')
  }
  return { ...f, source, args, original, profilePath, next, addBundle, get builds() { return f.builds } }
}

test('prepares and reuses exact candidate tarballs outside Home while preserving installed files and source', async () => {
  const f = await fixture(), upstream = await f.next()
  const bootstrapPath = join(f.home, 'rsi-sources', f.profile, 'bootstrap.json')
  const bootstrap = await readFile(bootstrapPath), cohortReceipt = await readFile(join(f.original.root, 'receipt.json'))
  await writeFile(join(f.sourceRepository, 'plugins/target/lib/index.js'), 'uncommitted upstream change\n')
  let builds = 0
  const ports = { build: async (...args: Parameters<typeof f.ports.build>) => { builds++; await f.ports.build(...args) } }
  const result = await prepareRsiLocalUpdate(f.args, ports)
  expect(result.mode).toBe('prepared')
  expect(result.root.startsWith(f.home + '/')).toBe(false)
  expect(result.source.upstreamCommit).toBe(upstream)
  expect(result.cohort.sourceCommit).toBe(result.source.sourceCommit)
  expect(result.originalCohortDigest).toBe(f.original.receiptDigest)
  expect(result.cohort.packages.find(item => item.name === '@dsh-enhanced/target')?.sha256)
    .not.toBe(f.original.packages.find(item => item.name === '@dsh-enhanced/target')?.sha256)
  expect(await prepareRsiLocalUpdate(f.args, ports)).toEqual(result)
  expect(builds).toBe(1)
  expect(await readFile(bootstrapPath)).toEqual(bootstrap)
  expect(await readFile(join(f.original.root, 'receipt.json'))).toEqual(cohortReceipt)
  expect(git(f.source.repository, 'rev-parse', 'HEAD')).toBe(f.source.sourceCommit)
  expect(git(f.source.repository, 'rev-parse', f.source.baseline.ref)).toBe(f.source.sourceCommit)
  expect(await readFile(join(f.profilePath, 'cordis.patch.yml'), 'utf8')).toBe('# user patch retained\n')
  await verifyRsiLocalInstalledPackages({ cohort: f.original, profilePath: f.profilePath })
  const path = join(result.root, 'receipt.json')
  await writeFile(path, (await readFile(path, 'utf8')).replace(result.originalCohortDigest, '0'.repeat(64)))
  await expect(prepareRsiLocalUpdate(f.args, ports)).rejects.toThrow('prepared update receipt differs')
}, 60_000)

test('refuses publishing a preparation when upstream advances during the build', async () => {
  const f = await fixture(); await f.next()
  await expect(prepareRsiLocalUpdate(f.args, { build: async (...args) => {
    await f.ports.build(...args)
    await writeFile(join(f.sourceRepository, 'later.txt'), 'later upstream\n')
    git(f.sourceRepository, 'add', '.'); git(f.sourceRepository, 'commit', '-m', 'later')
  } })).rejects.toThrow()
  const parent = (await readdir(dirname(f.home))).find(name => name.startsWith('.dsh-rsi-local-updates-'))!
  const prepared = join(dirname(f.home), parent)
  for (const entry of await readdir(prepared)) await expect(readFile(join(prepared, entry, 'receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await verifyRsiLocalInstalledPackages({ cohort: f.original, profilePath: f.profilePath })
}, 60_000)

test('prepares a newer package version while retaining the installed release', async () => {
  const f = await fixture()
  const manifests = ['package.json', ...f.original.packages.map(item => `${item.path}/package.json`)]
  for (const path of manifests) {
    const file = join(f.sourceRepository, path)
    const value = JSON.parse(await readFile(file, 'utf8'))
    value.version = '0.1.49'
    await writeFile(file, JSON.stringify(value, null, 2) + '\n')
  }
  git(f.sourceRepository, 'add', '.'); git(f.sourceRepository, 'commit', '-m', 'next release')
  const result = await prepareRsiLocalUpdate(f.args, f.ports)
  expect(result.source.version).toBe('0.1.49')
  expect(result.cohort.version).toBe('0.1.49')
  expect(f.original.version).toBe('0.1.48')
  await verifyRsiLocalInstalledPackages({ cohort: f.original, profilePath: f.profilePath })
}, 60_000)

test('a failed candidate build can retry without replacing the original frozen cohort', async () => {
  const f = await fixture(); await f.next()
  await expect(prepareRsiLocalUpdate(f.args, { build: async () => { throw new Error('builder failed') } })).rejects.toThrow('builder failed')
  await verifyRsiLocalInstalledPackages({ cohort: f.original, profilePath: f.profilePath })
  const result = await prepareRsiLocalUpdate(f.args, f.ports)
  expect(result.mode).toBe('prepared')
  expect(result.originalCohortDigest).toBe(f.original.receiptDigest)
}, 60_000)

test('default preparation refuses missing isolated build inputs without running an ambient build script', async () => {
  const f = await fixture()
  const marker = join(f.root, 'ambient-build-ran'), manifest = join(f.sourceRepository, 'package.json')
  const value = JSON.parse(await readFile(manifest, 'utf8'))
  value.scripts = { build: `node -e 'require("node:fs").writeFileSync(${JSON.stringify(marker)},"ran")'` }
  await writeFile(manifest, JSON.stringify(value, null, 2) + '\n')
  git(f.sourceRepository, 'add', '.'); git(f.sourceRepository, 'commit', '-m', 'build requires isolation')
  // This minimal fixture has no digest-pinned Docker builder inputs.
  await expect(prepareRsiLocalUpdate(f.args)).rejects.toThrow()
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  await verifyRsiLocalInstalledPackages({ cohort: f.original, profilePath: f.profilePath })
}, 60_000)

test('reading an update never recreates an absent candidate or accepts a preparation without isolated build evidence', async () => {
  const f = await fixture(); await f.next()
  const result = await prepareRsiLocalUpdate(f.args, f.ports)
  const args = { dshHome: f.home, profile: f.profile, root: result.root }
  await expect(readRsiLocalUpdate(args)).rejects.toThrow('receipt binding differs')
  await rm(join(result.root, 'receipt.json'))
  await expect(readRsiLocalUpdate(args)).rejects.toThrow()
  await expect(readFile(join(result.root, 'receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await rm(result.root, { recursive: true })
  await expect(readRsiLocalUpdate(args)).rejects.toThrow()
  await expect(readdir(result.root)).rejects.toMatchObject({ code: 'ENOENT' })
  await verifyRsiLocalInstalledPackages({ cohort: f.original, profilePath: f.profilePath })
}, 60_000)

test('CLI preparation derives the existing source and cannot be combined with activation or fresh installation', () => {
  const base = ['--prepare-local-update', '--profile', 'owner', '--dsh-home', '/private/home']
  expect(parseRsiSetupArgs(base)).toMatchObject({ prepareLocalUpdate: true, profile: 'owner' })
  for (const flags of [['--apply'], ['--start'], ['--install-owner'], ['--install-local-cohort'], ['--prepare-source'],
    ['--prepare-build'], ['--bundle', 'target'], ['--manifest', '/private/manifest.json']]) {
    expect(() => parseRsiSetupArgs([...base, ...flags])).toThrow('cannot be combined')
  }
  expect(() => parseRsiSetupArgs(['--prepare-local-update'])).toThrow('requires --profile')
  expect(parseRsiSetupArgs([...base, '--add-memory-learning'])).toMatchObject({ addMemoryLearning: true })
  for (const flags of [[], ['--install-owner'], ['--install-local-cohort'], ['--apply']]) {
    expect(() => parseRsiSetupArgs([...flags, '--add-memory-learning'])).toThrow('requires --prepare-local-update')
  }
})

test('explicit pre-owner extension freezes exactly one disabled bundle without changing the installed Home', async () => {
  const f = await fixture(true)
  const patch = await readFile(new URL('../../assistant-memory-learning/cordis.patch.yml', import.meta.url), 'utf8')
  await f.addBundle('assistant-memory-learning', patch)
  git(f.sourceRepository, 'add', '.'); git(f.sourceRepository, 'commit', '-m', 'add learner upstream')
  const bootstrapPath = join(f.home, 'rsi-sources', f.profile, 'bootstrap.json')
  const originalBootstrap = await readFile(bootstrapPath)
  const originalReceipt = await readFile(join(f.original.root, 'receipt.json'))
  const ordinary = await prepareRsiLocalUpdate(f.args, f.ports)
  expect(ordinary.schemaVersion).toBe(1)
  expect(ordinary).not.toHaveProperty('extension')
  expect(ordinary.cohort.bundles).toEqual(f.original.bundles)
  const args = { ...f.args, rootExtension: 'memory-learning' as const }
  const extended = await prepareRsiLocalUpdate(args, f.ports)
  expect(extended).toMatchObject({ schemaVersion: 2, extension: 'memory-learning', mode: 'prepared',
    originalCohortDigest: f.original.receiptDigest })
  expect(extended.root).not.toBe(ordinary.root)
  expect(extended.cohort.bundles).toEqual([...f.original.bundles, 'assistant-memory-learning'].sort())
  expect(extended.cohort.packages.find(item => item.name === '@dsh-enhanced/assistant-memory-learning')).toBeDefined()
  const builds = f.builds
  expect(await prepareRsiLocalUpdate(args, f.ports)).toEqual(extended)
  expect(f.builds).toBe(builds)
  expect(await readFile(bootstrapPath)).toEqual(originalBootstrap)
  expect(await readFile(join(f.original.root, 'receipt.json'))).toEqual(originalReceipt)
  expect(await readFile(join(f.profilePath, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
  await verifyRsiLocalInstalledPackages({ cohort: f.original, profilePath: f.profilePath })
  expect((await readdir(join(f.home, 'rsi-authorities', f.profile, 'state')))).toEqual([])
  // A prepared candidate must not bypass an owner authority installed later.
  await writeFile(join(f.home, 'rsi-authorities', f.profile, 'config/owner.json'), '{}', { mode: 0o600 })
  await expect(prepareRsiLocalUpdate(args, f.ports)).rejects.toThrow('pre-owner config is not empty')
  expect(f.builds).toBe(builds)
}, 60_000)

test('owner authority appearing during an extension build prevents a completed receipt', async () => {
  const f = await fixture(true)
  await f.addBundle('assistant-memory-learning')
  git(f.sourceRepository, 'add', '.'); git(f.sourceRepository, 'commit', '-m', 'add learner')
  const args = { ...f.args, rootExtension: 'memory-learning' as const }
  await expect(prepareRsiLocalUpdate(args, { build: async (...input) => {
    await f.ports.build(...input)
    await writeFile(join(f.home, 'rsi-authorities', f.profile, 'state/owner.json'), '{}', { mode: 0o600 })
  } })).rejects.toThrow('pre-owner state is not empty')
  const parent = (await readdir(dirname(f.home))).find(name => name.startsWith('.dsh-rsi-local-updates-'))!
  for (const name of await readdir(join(dirname(f.home), parent))) {
    await expect(readFile(join(dirname(f.home), parent, name, 'receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  }
  await verifyRsiLocalInstalledPackages({ cohort: f.original, profilePath: f.profilePath })
}, 60_000)

test('schema 2 reader rechecks roots, build identity, current cohort and owner after candidate preparation', async () => {
  const f = await fixture(true)
  await f.addBundle('assistant-memory-learning')
  git(f.sourceRepository, 'add', '.'); git(f.sourceRepository, 'commit', '-m', 'add learner')
  const prepared = await prepareRsiLocalUpdate({ ...f.args, rootExtension: 'memory-learning' }, f.ports)
  // Only the independently tested external build readers are ports here. Git,
  // source/cohort receipts, actual tarball inventory and pre-owner checks are real.
  const build = {
    sourceBuild: { proof: 'controlled source-build identity' } as unknown as Awaited<ReturnType<typeof sourceBuild.readRsiBuildEnvironment>>,
    releaseBuild: { proof: 'controlled release-build identity' } as unknown as Awaited<ReturnType<typeof releaseBuild.readRsiReleaseBuildEnvironment>>,
  }
  vi.spyOn(sourceBuild, 'readRsiBuildEnvironment').mockResolvedValue(build.sourceBuild)
  vi.spyOn(releaseBuild, 'readRsiReleaseBuildEnvironment').mockResolvedValue(build.releaseBuild)
  const candidate = { ...prepared, build }
  const encode = (value: object) => {
    const { receiptDigest: _digest, ...body } = value as Record<string, unknown>
    return JSON.stringify({ ...body, receiptDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex') })
  }
  const path = join(prepared.root, 'receipt.json')
  const saved = encode(candidate)
  await writeFile(path, saved, { mode: 0o600 })
  const input = { dshHome: f.home, profile: f.profile, root: prepared.root }
  expect(await readRsiLocalUpdate(input)).toEqual(JSON.parse(saved))
  await writeFile(path, encode({ ...candidate, cohort: { ...candidate.cohort,
    bundles: [...candidate.cohort.bundles, 'extra-root'] } }), { mode: 0o600 })
  await expect(readRsiLocalUpdate(input)).rejects.toThrow('prepared bundle selection differs')
  await writeFile(path, encode({ ...candidate, build: { ...build, sourceBuild: { proof: 'different build' } } }), { mode: 0o600 })
  await expect(readRsiLocalUpdate(input)).rejects.toThrow('prepared build or cohort differs')
  await writeFile(path, encode({ ...candidate, schemaVersion: 1 }), { mode: 0o600 })
  await expect(readRsiLocalUpdate(input)).rejects.toThrow('receipt is invalid')
  await writeFile(path, saved, { mode: 0o600 })
  const originalReceipt = await readFile(join(f.original.root, 'receipt.json'))
  await writeFile(join(f.original.root, 'receipt.json'), encode({ ...f.original,
    allowBuilds: Object.fromEntries(Object.entries({ ...f.original.allowBuilds, 'extra-blocked': false })
      .sort(([left], [right]) => left.localeCompare(right))) }), { mode: 0o600 })
  await expect(readRsiLocalUpdate(input)).rejects.toThrow('no longer matches installed cohort')
  await writeFile(join(f.original.root, 'receipt.json'), originalReceipt, { mode: 0o600 })
  await writeFile(join(f.home, 'rsi-authorities', f.profile, 'registry/owner.json'), '{}', { mode: 0o600 })
  await expect(readRsiLocalUpdate(input)).rejects.toThrow('pre-owner registry is not empty')
}, 60_000)
