import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { prepareRsiLocalCohort, verifyRsiLocalInstalledPackages } from '../src/rsi-local-cohort.js'
import { prepareRsiLocalUpdate } from '../src/rsi-local-update.js'
import { parseRsiSetupArgs } from '../src/rsi-setup.js'
import { localCohortFixture, installFixture } from './fixtures/rsi-local-cohort.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
function git(cwd: string, ...args: string[]): string {
  return execFileSync('/usr/bin/git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
    { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
}
async function fixture() {
  const f = await localCohortFixture(); roots.push(f.root)
  const original = await prepareRsiLocalCohort({ dshHome: f.home, profile: f.profile, source: f.source, bundles: ['target'] }, f.ports)
  const installed = await installFixture(f, original)
  await mkdir(join(f.home, 'profiles'), { mode: 0o700 })
  const profilePath = join(f.home, 'profiles', f.profile)
  await rename(installed, profilePath)
  await writeFile(join(profilePath, 'cordis.patch.yml'), '# user patch retained\n')
  const args = { dshHome: f.home, profile: f.profile, sourceRepository: f.sourceRepository }
  const next = async () => {
    await writeFile(join(f.sourceRepository, 'plugins/target/lib/index.js'), "export const identity = 'updated'\n")
    git(f.sourceRepository, 'add', '.'); git(f.sourceRepository, 'commit', '-m', 'upstream update')
    return git(f.sourceRepository, 'rev-parse', 'HEAD')
  }
  return { ...f, args, original, profilePath, next }
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

test('CLI preparation derives the existing source and cannot be combined with activation or fresh installation', () => {
  const base = ['--prepare-local-update', '--profile', 'owner', '--dsh-home', '/private/home']
  expect(parseRsiSetupArgs(base)).toMatchObject({ prepareLocalUpdate: true, profile: 'owner' })
  for (const flags of [['--apply'], ['--start'], ['--install-owner'], ['--install-local-cohort'], ['--prepare-source'],
    ['--prepare-build'], ['--bundle', 'target'], ['--manifest', '/private/manifest.json']]) {
    expect(() => parseRsiSetupArgs([...base, ...flags])).toThrow('cannot be combined')
  }
  expect(() => parseRsiSetupArgs(['--prepare-local-update'])).toThrow('requires --profile')
})
