import { spawn } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

function fail(reason) { throw new Error(`local source cache copy: ${reason}`) }
function uid() { const value = process.getuid?.(); if (!Number.isInteger(value)) fail('cannot verify uid'); return value }
function identity(entry) { return { dev: entry.dev, ino: entry.ino, uid: entry.uid, mode: entry.mode } }
function matches(entry, expected) { return entry.dev === expected.dev && entry.ino === expected.ino && entry.uid === expected.uid && entry.mode === expected.mode }
function inside(root, path) { const rel = relative(root, path); return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) }
function pathString(path) { if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || path.includes('\0')) fail('path must be absolute and canonical') }
async function directory(path, privateMode = false) {
  pathString(path)
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== uid() || entry.mode & 0o022 || privateMode && (entry.mode & 0o7777) !== 0o700
    || await realpath(path) !== path) fail('unsafe directory identity or permissions')
  return identity(entry)
}
async function unchangedDirectory(path, expected) {
  const actual = await directory(path)
  if (!matches(actual, expected)) fail('directory identity changed')
}
async function safeIndex(path) {
  pathString(path)
  const entry = await lstat(path)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== uid() || entry.mode & 0o022 || await realpath(path) !== path) fail('unsafe SQLite index')
  return identity(entry)
}
async function exists(path) { try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
async function scanTree(root, kind, deadline, copied = false) {
  const directories = new Map(), budget = { entries: 0 }
  async function walk(path, rel) {
    if (Date.now() > deadline || ++budget.entries > 1000000) fail('cache scan exceeded its bound')
    const entry = await lstat(path)
    if (entry.uid !== uid()) fail('cache tree has an unsafe owner')
    if (entry.isSymbolicLink()) {
      if (!inside(root, await realpath(path))) fail('cache symlink escapes its boundary')
      return
    }
    if (entry.mode & 0o022 || !entry.isDirectory() && (!entry.isFile() || copied && entry.nlink !== 1)) fail('cache tree has an unsafe entry')
    if (!entry.isDirectory()) return
    directories.set(path, identity(entry))
    for (const name of await readdir(path)) {
      const childRel = rel ? `${rel}/${name}` : name
      if (kind === 'store' && /^(?:v[0-9]+\/)?projects$/u.test(childRel) || kind === 'cache' && childRel === 'dlx') continue
      await walk(join(path, name), childRel)
    }
  }
  await walk(root, '')
  return directories
}
async function assertDirectories(directories) { for (const [path, expected] of directories) await unchangedDirectory(path, expected) }
function boundedChild(command, args, timeoutMs) {
  return new Promise((resolveChild, reject) => {
    let child, timer, killTimer, reason, output = ''
    const terminate = message => {
      if (reason) return
      reason = message
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
      killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ } }, 1000)
      killTimer.unref()
    }
    try { child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } }) }
    catch (error) { reject(error); return }
    timer = setTimeout(() => terminate('subprocess deadline exceeded'), timeoutMs)
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      if (Buffer.byteLength(output) + chunk.length > 65536) terminate('subprocess output exceeded bound')
      else output += chunk.toString()
    })
    child.on('error', error => { clearTimeout(timer); clearTimeout(killTimer); reject(error) })
    child.on('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer)
      if (reason || code !== 0) reject(new Error(`local source cache copy: ${reason ?? `subprocess failed (${code ?? signal})`}${output ? `: ${output.trim()}` : ''}`))
      else resolveChild()
    })
  })
}
async function backupIndex(indexPath, target) {
  await directory(dirname(target), true)
  if (await exists(target) || inside(dirname(indexPath), target)) fail('unsafe SQLite backup target')
  const before = await safeIndex(indexPath), { DatabaseSync, backup } = await import('node:sqlite')
  const database = new DatabaseSync(indexPath, { readOnly: true, timeout: 5000 }), deadline = Date.now() + 60000
  try {
    await backup(database, target, { rate: 1024, progress: () => { if (Date.now() > deadline) fail('SQLite snapshot deadline exceeded') } })
    if (!matches(await safeIndex(indexPath), before)) fail('SQLite index identity changed during backup')
  } finally { database.close() }
}
/** Independently exported for real SQLite/WAL tests on macOS. The source is opened
 * read-only; SQLite owns its native locking protocol. A child gives backup a hard 60s bound. */
export async function snapshotLocalSourceCacheIndex({ indexPath, copyDirectory }) {
  pathString(indexPath)
  if (indexPath !== join(dirname(indexPath), 'index.db')) fail('expected index.db')
  const sourceDirectory = dirname(indexPath), sourceIdentity = await directory(sourceDirectory), destinationIdentity = await directory(copyDirectory)
  if (inside(copyDirectory, indexPath) || inside(sourceDirectory, copyDirectory)) fail('SQLite source and destination overlap')
  const before = await safeIndex(indexPath), sidecars = new Map()
  for (const suffix of ['-wal', '-shm', '-journal']) if (await exists(indexPath + suffix)) sidecars.set(indexPath + suffix, await safeIndex(indexPath + suffix))
  const staging = await mkdtemp(join(copyDirectory, '.dsh-index-backup-'))
  const stagingIdentity = await directory(staging, true), target = join(staging, 'index.db')
  try {
    await boundedChild(process.execPath, [fileURLToPath(import.meta.url), '--snapshot-index', indexPath, target], 60000)
    await unchangedDirectory(sourceDirectory, sourceIdentity); await unchangedDirectory(copyDirectory, destinationIdentity)
    await unchangedDirectory(staging, stagingIdentity)
    if (!matches(await safeIndex(indexPath), before)) fail('SQLite index identity changed during backup')
    for (const [path, expected] of sidecars) if (!matches(await safeIndex(path), expected)) fail('SQLite sidecar identity changed during backup')
    await safeIndex(target); await chmod(target, 0o600)
    for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(join(copyDirectory, `index.db${suffix}`), { force: true })
    await rename(target, join(copyDirectory, 'index.db'))
    await unchangedDirectory(sourceDirectory, sourceIdentity); await unchangedDirectory(copyDirectory, destinationIdentity)
  } finally { await unchangedDirectory(staging, stagingIdentity); await rm(staging, { recursive: true }) }
}
/** Linux GNU cp is deliberate. Caller owns this empty private root and disposes it;
 * failures leave the partial copy for diagnosis. Registry metadata/marker digests
 * and source content stability are independently checked by the lifecycle caller. */
export async function copyLocalSourcePackageCache({ storePath, cachePath, rootPath }) {
  const rootIdentity = await directory(rootPath, true)
  if ((await readdir(rootPath)).length) fail('destination root must be empty')
  const storeIdentity = await directory(storePath), cacheIdentity = await directory(cachePath)
  for (const [a, b] of [[rootPath, storePath], [rootPath, cachePath], [storePath, cachePath]]) if (inside(a, b) || inside(b, a)) fail('cache paths overlap')
  const deadline = Date.now() + 720000
  const storeDirectories = await scanTree(storePath, 'store', deadline), cacheDirectories = await scanTree(cachePath, 'cache', deadline)
  const versions = (await readdir(storePath)).filter(name => /^v[0-9]+$/u.test(name))
  if (versions.length > 64) fail('too many store version directories')
  const indexes = new Map()
  for (const name of ['', ...versions]) {
    const source = join(storePath, name); await directory(source)
    const index = join(source, 'index.db'); if (await exists(index)) indexes.set(index, await safeIndex(index))
  }
  if (process.platform !== 'linux') fail('GNU cache copying requires Linux; SQLite snapshot can be tested separately')
  const store = join(rootPath, 'store'), cache = join(rootPath, 'cache'), destinations = new Map()
  for (const [source, destination] of [[storePath, store], [cachePath, cache]]) {
    await unchangedDirectory(rootPath, rootIdentity); await mkdir(destination, { mode: 0o700 })
    destinations.set(destination, await directory(destination, true))
    const remaining = deadline - Date.now(); if (remaining <= 0) fail('cache copy total deadline exceeded')
    await boundedChild('/bin/cp', ['-a', '--no-preserve=links', '--reflink=auto', '--', `${source}${sep}.`, destination], Math.min(300000, remaining))
    await chmod(destination, 0o700); await unchangedDirectory(destination, destinations.get(destination))
  }
  await assertDirectories(destinations)
  for (const name of ['', ...versions]) {
    const path = join(store, name), expected = await directory(path)
    await rm(join(path, 'projects'), { recursive: true, force: true }); await unchangedDirectory(path, expected)
  }
  await rm(join(cache, 'dlx'), { recursive: true, force: true }); await assertDirectories(destinations)
  for (const [index, expected] of indexes) {
    if (!matches(await safeIndex(index), expected)) fail('SQLite index identity changed after copy')
    if (Date.now() > deadline) fail('cache copy total deadline exceeded')
    await snapshotLocalSourceCacheIndex({ indexPath: index, copyDirectory: join(store, relative(storePath, dirname(index))) })
  }
  await scanTree(store, 'store', deadline, true); await scanTree(cache, 'cache', deadline, true)
  await assertDirectories(storeDirectories); await assertDirectories(cacheDirectories)
  if ((await scanTree(storePath, 'store', deadline)).size !== storeDirectories.size || (await scanTree(cachePath, 'cache', deadline)).size !== cacheDirectories.size) fail('source cache directory set changed')
  if (JSON.stringify((await readdir(storePath)).filter(name => /^v[0-9]+$/u.test(name)).sort()) !== JSON.stringify([...versions].sort())) fail('source store version set changed')
  for (const name of ['', ...versions]) { const index = join(storePath, name, 'index.db'); if (await exists(index) !== indexes.has(index)) fail('source SQLite index set changed') }
  await unchangedDirectory(storePath, storeIdentity); await unchangedDirectory(cachePath, cacheIdentity); await unchangedDirectory(rootPath, rootIdentity)
  for (const [index, expected] of indexes) if (!matches(await safeIndex(index), expected)) fail('SQLite index identity changed at completion')
  return Object.freeze({ storePath: store, cachePath: cache })
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5 || process.argv[2] !== '--snapshot-index') fail('invalid private backup invocation')
  await backupIndex(process.argv[3], process.argv[4])
}
