import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { copyLocalSourcePackageCache, snapshotLocalSourceCacheIndex } from '../scripts/install/local-source-cache-copy.mjs'

const roots: string[] = [], databases: DatabaseSync[] = []
afterEach(async () => { for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cache-copy-unit-'))); roots.push(root)
  const storePath = join(root, 'source-store'), cachePath = join(root, 'source-cache'), rootPath = join(root, 'copy')
  for (const dir of [storePath, cachePath, rootPath]) await mkdir(dir, { mode: 0o700 })
  return { root, storePath, cachePath, rootPath }
}
function walDatabase(path: string) {
  const db = new DatabaseSync(path); databases.push(db)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE data (value TEXT); INSERT INTO data VALUES (\'uncheckpointed\')')
  return db
}
async function sourceBytes(path: string) {
  return Promise.all(['', '-wal'].map(async suffix => createHash('sha256').update(await readFile(path + suffix)).digest('hex')))
}
function rows(path: string) {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return db.prepare('SELECT value FROM data').all() } finally { db.close() }
}

describe('real read-only SQLite package-cache snapshot', () => {
  test('online backup includes uncheckpointed WAL omitted by a plain main-file copy, without changing source DB/WAL bytes', async () => {
    const f = await fixture(), indexPath = join(f.storePath, 'index.db'); walDatabase(indexPath)
    const before = await sourceBytes(indexPath), beforeIdentity = await lstat(indexPath)
    await copyFile(indexPath, join(f.rootPath, 'index.db'))
    expect(() => rows(join(f.rootPath, 'index.db'))).toThrow('no such table')
    for (const suffix of ['-wal', '-shm', '-journal']) await writeFile(join(f.rootPath, `index.db${suffix}`), 'stale sidecar', { mode: 0o600 })
    await snapshotLocalSourceCacheIndex({ indexPath, copyDirectory: f.rootPath })
    expect((await readdir(f.rootPath)).filter(name => name !== 'index.db')).toEqual([])
    expect(rows(join(f.rootPath, 'index.db'))).toEqual([{ value: 'uncheckpointed' }])
    expect(await sourceBytes(indexPath)).toEqual(before)
    const afterIdentity = await lstat(indexPath)
    expect([afterIdentity.dev, afterIdentity.ino, afterIdentity.uid, afterIdentity.mode]).toEqual([beforeIdentity.dev, beforeIdentity.ino, beforeIdentity.uid, beforeIdentity.mode])
  })
  test('rejects a symlink SQLite index before opening it', async () => {
    const f = await fixture(); walDatabase(join(f.storePath, 'real.db')); await symlink('real.db', join(f.storePath, 'index.db'))
    await expect(snapshotLocalSourceCacheIndex({ indexPath: join(f.storePath, 'index.db'), copyDirectory: f.rootPath })).rejects.toThrow('unsafe SQLite index')
    expect(await readdir(f.rootPath)).toEqual([])
  })
  test('rejects an unsafe SQLite sidecar before starting a child', async () => {
    const f = await fixture(), indexPath = join(f.storePath, 'index.db'); const db = new DatabaseSync(indexPath); db.exec('CREATE TABLE data (value TEXT)'); db.close()
    await writeFile(join(f.storePath, 'other'), 'untouched', { mode: 0o600 }); await symlink('other', indexPath + '-wal')
    await expect(snapshotLocalSourceCacheIndex({ indexPath, copyDirectory: f.rootPath })).rejects.toThrow('unsafe SQLite index')
    expect(await readFile(join(f.storePath, 'other'), 'utf8')).toBe('untouched'); expect(await readdir(f.rootPath)).toEqual([])
  })
  test('rejects source/destination overlap', async () => {
    const f = await fixture(); walDatabase(join(f.storePath, 'index.db'))
    await expect(snapshotLocalSourceCacheIndex({ indexPath: join(f.storePath, 'index.db'), copyDirectory: f.storePath })).rejects.toThrow('overlap')
  })
  test('preserves an existing copy on invalid source failure', async () => {
    const f = await fixture(); await writeFile(join(f.storePath, 'index.db'), 'not sqlite', { mode: 0o600 })
    await writeFile(join(f.rootPath, 'index.db'), 'old copy', { mode: 0o600 })
    await expect(snapshotLocalSourceCacheIndex({ indexPath: join(f.storePath, 'index.db'), copyDirectory: f.rootPath })).rejects.toThrow('subprocess failed')
    expect(await readFile(join(f.rootPath, 'index.db'), 'utf8')).toBe('old copy')
    expect(await readdir(f.rootPath)).toEqual(['index.db'])
  })
})

describe('package-cache input boundaries and Linux GNU copy', () => {
  test('requires an empty uid-owned canonical 0700 destination', async () => {
    const f = await fixture(); await writeFile(join(f.rootPath, 'existing'), 'keep', { mode: 0o600 })
    await expect(copyLocalSourcePackageCache(f)).rejects.toThrow('must be empty')
    await rm(join(f.rootPath, 'existing')); await chmod(f.rootPath, 0o750)
    await expect(copyLocalSourcePackageCache(f)).rejects.toThrow('unsafe directory')
  })
  test('rejects writable or symlink source directories', async () => {
    const f = await fixture(); await chmod(f.cachePath, 0o770)
    await expect(copyLocalSourcePackageCache(f)).rejects.toThrow('unsafe directory')
    await chmod(f.cachePath, 0o700); const alias = join(f.root, 'alias'); await symlink(f.storePath, alias)
    await expect(copyLocalSourcePackageCache({ ...f, storePath: alias })).rejects.toThrow('unsafe directory')
    expect(await readdir(f.rootPath)).toEqual([])
  })
  test('rejects escaping nested source symlinks and overlapping cache roots', async () => {
    const f = await fixture(); await writeFile(join(f.root, 'outside'), 'keep', { mode: 0o600 }); await symlink('../outside', join(f.cachePath, 'escape'))
    await expect(copyLocalSourcePackageCache(f)).rejects.toThrow('symlink escapes')
    await rm(join(f.cachePath, 'escape')); await expect(copyLocalSourcePackageCache({ ...f, cachePath: f.storePath })).rejects.toThrow('overlap')
    expect(await readFile(join(f.root, 'outside'), 'utf8')).toBe('keep')
  })
  test.skipIf(process.platform !== 'linux')('copies real root/versioned WAL indexes, detaches hardlinks, strips projects/dlx, and keeps bounded relative symlinks', async () => {
    const f = await fixture(), version = join(f.storePath, 'v11'); await mkdir(version, { mode: 0o700 })
    walDatabase(join(f.storePath, 'index.db')); walDatabase(join(version, 'index.db'))
    const beforeRoot = await sourceBytes(join(f.storePath, 'index.db')), beforeVersion = await sourceBytes(join(version, 'index.db'))
    await writeFile(join(f.cachePath, 'metadata.json'), 'registry metadata', { mode: 0o600 }); await link(join(f.cachePath, 'metadata.json'), join(f.cachePath, 'metadata-hardlink.json')); await symlink('metadata.json', join(f.cachePath, 'metadata.alias'))
    const external = join(f.root, 'external'); await mkdir(external, { mode: 0o700 }); await writeFile(join(external, 'keep'), 'untouched', { mode: 0o600 })
    await symlink(external, join(f.storePath, 'projects')); await symlink(external, join(version, 'projects')); await symlink(external, join(f.cachePath, 'dlx'))
    const copied = await copyLocalSourcePackageCache(f)
    expect(copied).toEqual({ storePath: join(f.rootPath, 'store'), cachePath: join(f.rootPath, 'cache') })
    for (const dir of ['', 'v11']) {
      expect(rows(join(copied.storePath, dir, 'index.db'))).toEqual([{ value: 'uncheckpointed' }])
      expect(await readdir(join(copied.storePath, dir))).not.toContain('projects')
    }
    expect((await lstat(join(copied.cachePath, 'metadata.json'))).nlink).toBe(1); expect((await lstat(join(copied.cachePath, 'metadata-hardlink.json'))).nlink).toBe(1)
    expect(await readdir(copied.cachePath)).not.toContain('dlx'); expect(await readFile(join(copied.cachePath, 'metadata.alias'), 'utf8')).toBe('registry metadata')
    expect(await sourceBytes(join(f.storePath, 'index.db'))).toEqual(beforeRoot); expect(await sourceBytes(join(version, 'index.db'))).toEqual(beforeVersion)
    expect(await readFile(join(external, 'keep'), 'utf8')).toBe('untouched')
  })
  test.skipIf(process.platform !== 'linux')('rejects copied absolute symlinks pointing back into the old source cache', async () => {
    const f = await fixture(); await writeFile(join(f.cachePath, 'metadata'), 'keep', { mode: 0o600 }); await symlink(join(f.cachePath, 'metadata'), join(f.cachePath, 'absolute'))
    await expect(copyLocalSourcePackageCache(f)).rejects.toThrow('symlink escapes')
    expect(await readFile(join(f.cachePath, 'metadata'), 'utf8')).toBe('keep')
  })
})
