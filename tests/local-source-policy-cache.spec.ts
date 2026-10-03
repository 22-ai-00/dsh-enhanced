import { createHash } from 'node:crypto'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { lifecycleProfileTest } from '../scripts/install/lifecycle-profile.mjs'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(mode = '') {
  const root = await mkdtemp(join(tmpdir(), 'local-source-policy-'))
  roots.push(root)
  const homePath = join(root, 'home'), profilesPath = join(homePath, 'profiles')
  const profilePath = join(profilesPath, 'web'), cohortPath = join(homePath, 'rsi-local-cohorts', 'web')
  await mkdir(profilePath, { recursive: true, mode: 0o700 })
  await mkdir(cohortPath, { recursive: true, mode: 0o700 })
  await writeFile(join(cohortPath, 'old.tgz'), 'old package bytes', { mode: 0o600 })
  for (const [name, source] of Object.entries({
    'package.json': '{"name":"fixture","dependencies":{"old":"1.0.0"}}\n',
    'pnpm-workspace.yaml': 'packages: []\n',
    'pnpm-lock.yaml': 'lockfileVersion: "9.0"\n',
  })) await writeFile(join(profilePath, name), source, { mode: 0o600 })
  const pnpmPath = join(root, 'pnpm')
  await writeFile(join(root, 'scenario'), mode, { mode: 0o600 })
  await writeFile(pnpmPath, `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const mode = fs.readFileSync(path.join(__dirname, 'scenario'), 'utf8')
if (args.join(' ') === 'store path') {
  const store = path.join(process.env.pnpm_config_store_dir, 'v11')
  fs.mkdirSync(store, { recursive: true, mode: 0o700 })
  process.stdout.write(store + '\\n')
  process.exit(0)
}
const replaceLock = lock => {
  const temporary = lock + '.next'
  fs.writeFileSync(temporary, fs.readFileSync(lock), { mode: 0o600 })
  fs.renameSync(temporary, lock)
}
const receiptFor = lock => {
  const source = fs.readFileSync(lock)
  const entry = fs.statSync(lock, { bigint: true })
  return { lockfile: { path: lock, hash: Buffer.alloc(32).toString('base64'), size: source.length,
    inode: mode === 'bad-inode' ? '0' : String(entry.ino), mtimeNs: String(entry.mtimeNs) },
    policy: { tarballUrlBinding: true, resolutionShapeCheck: true, dependencyAliasCheck: true } }
}
if (args.join(' ') === 'config list --json') {
  const privateRun = process.env.HOME.includes('verified-cache')
  process.stdout.write(JSON.stringify({ registry: privateRun && mode === 'config-drift' ? 'https://drift.invalid/' : 'https://registry.npmjs.org/',
    minimumReleaseAge: privateRun && mode === 'age-drift' ? 10 : 20,
    ...(mode === 'source-auth' && !privateRun ? { '//registry.npmjs.org/:_authToken': '(protected)' } : {}),
    ignoreScripts: mode === 'weak-policy' && privateRun ? false : true,
    ignorePnpmfile: true, trustLockfile: false }))
  process.exit(0)
}
const lock = path.join(process.cwd(), 'pnpm-lock.yaml')
if (args.join(' ') === 'install --lockfile-only --frozen-lockfile') {
  if (mode !== 'missing-marker') {
    if (mode === 'atomic-lock-rewrite') replaceLock(lock)
    fs.writeFileSync(path.join(process.env.pnpm_config_cache_dir, 'lockfile-verified.jsonl'), JSON.stringify(receiptFor(lock)) + '\\n', { mode: 0o600 })
    if (mode === 'post-verify-rewrite') replaceLock(lock)
  }
  process.exit(0)
}
if (args.join(' ') === 'fetch --frozen-lockfile') {
  if (mode === 'mutate-lockfile') fs.appendFileSync(lock, 'changed\\n')
  if (mode === 'same-size-lock-mutate') {
    const old = fs.readFileSync(lock, 'utf8')
    fs.writeFileSync(lock, 'x' + old.slice(1))
  }
  if (mode === 'atomic-lock-rewrite') {
    replaceLock(lock)
    fs.appendFileSync(path.join(process.env.pnpm_config_cache_dir, 'lockfile-verified.jsonl'), JSON.stringify(receiptFor(lock)) + '\\n')
  }
  if (mode === 'append-marker') fs.appendFileSync(path.join(process.env.pnpm_config_cache_dir, 'lockfile-verified.jsonl'),
    JSON.stringify({ fetched: true }) + '\\n')
  if (mode === 'rewrite-hash') {
    const marker = path.join(process.env.pnpm_config_cache_dir, 'lockfile-verified.jsonl')
    const receipt = JSON.parse(fs.readFileSync(marker, 'utf8'))
    receipt.lockfile.hash = Buffer.alloc(32, 1).toString('base64')
    fs.writeFileSync(marker, JSON.stringify(receipt) + '\\n')
  }
  process.exit(0)
}
process.stderr.write('unexpected pnpm invocation: ' + args.join(' '))
process.exit(2)
`, { mode: 0o700 })
  await chmod(pnpmPath, 0o700)
  const current = { profilesPath, profilesStat: await lstat(profilesPath), profilePath, profileStat: await lstat(profilePath) }
  const originalResources = { 'rsi-local-cohorts': await lifecycleProfileTest.profileTreeDigest(cohortPath, '', 256 * 1024 * 1024) }
  return { homePath, profilePath, pnpmPath, current, originalResources }
}

describe('pre-stop local source offline policy cache', () => {
  test('binds old metadata and a fresh verified marker, then rejects marker or pnpm replacement', async () => {
    const f = await fixture()
    const preparation = await lifecycleProfileTest.prepareLocalSourceOfflineCache({ ...f, profile: 'web' })
    try {
      await expect(lifecycleProfileTest.assertLocalSourcePreparation(preparation, f.profilePath)).resolves.toBeUndefined()
      expect((await readFile(join(preparation.cachePath, 'lockfile-verified.jsonl'), 'utf8'))).toContain('tarballUrlBinding')
      await writeFile(join(preparation.cachePath, 'lockfile-verified.jsonl'), '{}\n')
      await expect(lifecycleProfileTest.assertLocalSourcePreparation(preparation, f.profilePath)).rejects.toThrow('marker changed')
      await writeFile(join(preparation.cachePath, 'lockfile-verified.jsonl'), preparation.marker.source)
      await writeFile(f.pnpmPath, (await readFile(f.pnpmPath, 'utf8')) + '\n')
      await expect(lifecycleProfileTest.assertLocalSourcePreparation(preparation, f.profilePath)).rejects.toThrow('pinned pnpm executable changed')
    } finally { await preparation.dispose() }
  })

  test.each([
    ['missing-marker', 'lockfile-verified.jsonl'],
    ['weak-policy', 'verification policy changed'],
    ['config-drift', 'effective configuration changed'],
    ['age-drift', 'effective configuration changed'],
    ['mutate-lockfile', 'metadata changed'],
    ['same-size-lock-mutate', 'metadata changed'],
    ['bad-inode', 'marker does not bind'],
    ['rewrite-hash', 'verification record changed'],
  ])('rejects %s before any transaction is created', async (mode, failure) => {
    const f = await fixture(mode)
    const before = createHash('sha256').update(await readFile(join(f.profilePath, 'pnpm-lock.yaml'))).digest('hex')
    await expect(lifecycleProfileTest.prepareLocalSourceOfflineCache({ ...f, profile: 'web' })).rejects.toThrow(failure)
    expect(createHash('sha256').update(await readFile(join(f.profilePath, 'pnpm-lock.yaml'))).digest('hex')).toBe(before)
  })

  test('keeps standard global registry authentication out of the private snapshot', async () => {
    const f = await fixture('source-auth')
    const preparation = await lifecycleProfileTest.prepareLocalSourceOfflineCache({ ...f, profile: 'web' })
    try {
      expect(JSON.stringify({ sourceConfig: preparation.sourceConfig, environment: preparation.environment,
        configFiles: preparation.configFiles, marker: preparation.marker })).not.toContain('_authToken')
      expect(await readFile(join(preparation.cachePath, 'config/pnpm/config.yaml'), 'utf8')).not.toContain('_authToken')
      await expect(lifecycleProfileTest.assertLocalSourcePreparation(preparation, f.profilePath)).resolves.toBeUndefined()
    } finally { await preparation.dispose() }
  })

  test('copies the verified private cache for offline stage rather than the old global cache', async () => {
    const f = await fixture()
    const preparation = await lifecycleProfileTest.prepareLocalSourceOfflineCache({ ...f, profile: 'web' })
    try {
      const root = join(f.homePath, '..')
      const globalStore = join(root, 'global-store'), globalCache = join(root, 'global-cache')
      const alias = join(root, 'store-alias'), transaction = join(root, 'transaction')
      const stageProfile = join(root, 'staged-profile')
      for (const path of [globalStore, globalCache, transaction, stageProfile]) await mkdir(path, { mode: 0o700 })
      await symlink(globalStore, alias)
      await writeFile(join(globalStore, 'unverified-global-content'), 'old', { mode: 0o600 })
      await writeFile(join(globalCache, 'unverified-global-marker'), 'old', { mode: 0o600 })
      await mkdir(join(preparation.storePath, 'projects'), { mode: 0o700 })
      await symlink(root, join(preparation.storePath, 'projects', 'registered-project'))
      const privateIndex = new DatabaseSync(join(preparation.storePath, 'index.db'))
      try {
        privateIndex.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE packages(key TEXT); INSERT INTO packages VALUES ('verified')")
      } finally { privateIndex.close() }
      for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
        await cp(join(f.profilePath, name), join(stageProfile, name))
      }
      const binding = async (path: string) => {
        const entry = await lstat(path)
        return { dev: String(entry.dev), ino: String(entry.ino), uid: entry.uid, mode: entry.mode }
      }
      const caches = await lifecycleProfileTest.prepareLocalSourcePackageCaches(transaction, {
        storePath: globalStore, identity: await binding(globalStore),
        localSource: { alias: { path: alias }, cachePath: globalCache, cacheIdentity: await binding(globalCache) },
      }, preparation, stageProfile)
      try {
        await expect(readFile(join(caches.roots[0].sourcePath, 'unverified-global-content'))).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(readFile(join(caches.roots.at(-1)!.sourcePath, 'unverified-global-marker'))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await readFile(join(caches.roots.at(-1)!.sourcePath, 'lockfile-verified.jsonl'), 'utf8')).toBe(preparation.marker.source)
        await expect(readFile(join(caches.roots[0].sourcePath, 'projects', 'registered-project'))).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(readFile(join(caches.roots[0].sourcePath, 'v11', 'index.db'))).rejects.toMatchObject({ code: 'ENOENT' })
        const copiedIndex = new DatabaseSync(join(caches.roots[0].sourcePath, 'index.db'), { readOnly: true })
        try { expect(copiedIndex.prepare('SELECT key FROM packages').all()).toEqual([{ key: 'verified' }]) }
        finally { copiedIndex.close() }
      } finally { await caches.dispose() }
    } finally { await preparation.dispose() }
  })

  test('accepts a pnpm fetch append while retaining the original verified record', async () => {
    const f = await fixture('append-marker')
    const preparation = await lifecycleProfileTest.prepareLocalSourceOfflineCache({ ...f, profile: 'web' })
    try {
      expect(preparation.marker.source).toContain('"fetched":true')
      await expect(lifecycleProfileTest.assertLocalSourcePreparation(preparation, f.profilePath)).resolves.toBeUndefined()
    } finally { await preparation.dispose() }
  })

  test('accepts atomic lockfile replacement only with unchanged bytes and refreshed marker stat', async () => {
    const f = await fixture('atomic-lock-rewrite')
    const preparation = await lifecycleProfileTest.prepareLocalSourceOfflineCache({ ...f, profile: 'web' })
    try {
      expect(preparation.marker.source.trim().split('\n')).toHaveLength(2)
      await expect(lifecycleProfileTest.assertLocalSourcePreparation(preparation, f.profilePath)).resolves.toBeUndefined()
    } finally { await preparation.dispose() }
  })

  test('binds a verification stat captured before pnpm rewrites unchanged lock bytes', async () => {
    const f = await fixture('post-verify-rewrite')
    const preparation = await lifecycleProfileTest.prepareLocalSourceOfflineCache({ ...f, profile: 'web' })
    try {
      expect(preparation.lockStats[0].inode).not.toBe(preparation.lockStats[1].inode)
      await expect(lifecycleProfileTest.assertLocalSourcePreparation(preparation, f.profilePath)).resolves.toBeUndefined()
    } finally { await preparation.dispose() }
  })
})
