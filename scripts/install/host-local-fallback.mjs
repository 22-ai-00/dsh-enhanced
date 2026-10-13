import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, readlink, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = message => { throw new Error(`Host local shared fallback: ${message}`) }
const inside = (root, path) => path === root || path.startsWith(`${root}${sep}`)
const slug = /^[a-z0-9][a-z0-9._-]*$/u
const scope = /^@[a-z0-9][a-z0-9._-]*$/u
const profileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const missing = error => error?.code === 'ENOENT' ? undefined : Promise.reject(error)

async function safeDirectory(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path
    || await realpath(path) !== path) fail(`directory is not canonical: ${path}`)
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid()
    || entry.mode & 0o022) fail(`unsafe directory: ${path}`)
}

async function globalManifest(root) {
  if (root === undefined) return null
  await safeDirectory(root)
  if (!root.endsWith(`${sep}node_modules${sep}@deepseek-ai${sep}dsh`)) fail('global DSH root shape differs')
  const path = join(root, 'package.json'), before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid()
    || before.mode & 0o022 || before.size > 1_048_576) fail('unsafe global DSH manifest')
  const bytes = await readFile(path), after = await lstat(path)
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('global DSH manifest changed')
  const manifest = JSON.parse(bytes.toString('utf8'))
  if (manifest.name !== '@deepseek-ai/dsh' || typeof manifest.version !== 'string'
    || !/^(?:0\.1\.[0-9]+(?:-rc\.[0-9]+)?|0\.2\.0-rc\.2)$/u.test(manifest.version)) {
    fail('unsupported global DSH identity')
  }
  return { root, version: manifest.version, digest: hash(bytes) }
}

async function linkInventory(path, roots, profileModules) {
  const root = await lstat(path).catch(missing)
  if (root === undefined) return null
  await safeDirectory(path)
  const entries = []
  const visit = async (directory, prefix) => {
    for (const name of (await readdir(directory)).sort()) {
      if (entries.length >= 4096) fail('shared fallback entry limit exceeded')
      const child = join(directory, name), key = prefix ? `${prefix}/${name}` : name
      const entry = await lstat(child)
      if (entry.uid !== process.getuid()) fail(`shared fallback owner differs: ${key}`)
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (prefix || !scope.test(name)) fail(`unexpected shared fallback directory: ${key}`)
        await safeDirectory(child)
        entries.push([key, 'directory', entry.mode & 0o777])
        await visit(child, key)
        continue
      }
      const packageName = prefix ? `${prefix}/${name}` : name
      if ((!prefix && !slug.test(name) || prefix && !scope.test(prefix) || !slug.test(name))
        || !entry.isSymbolicLink()) fail(`unexpected shared fallback entry: ${key}`)
      const target = await readlink(child)
      const profileTarget = profileModules && inside(join(profileModules, '.pnpm'), target)
      if (!isAbsolute(target) || resolve(target) !== target
        || !target.endsWith(`${sep}node_modules${sep}${packageName.split('/').join(sep)}`)
        || !profileTarget && ![roots.oldHostRoot, roots.candidateHostRoot, roots.globalDshRoot]
          .some(root => root && inside(root, target))) {
        fail(`untrusted shared fallback target: ${key}`)
      }
      entries.push([key, 'link', target])
    }
  }
  await visit(path, '')
  return entries
}

async function sharedInventory(home, roots) {
  return linkInventory(join(home, 'profiles', 'node_modules'), roots)
}

async function projectionInventory(home, logicalHome, profile) {
  const modules = join(home, 'profiles', profile, 'node_modules')
  const root = await lstat(modules).catch(missing)
  if (root === undefined) return []
  await safeDirectory(modules)
  const wrapper = join(logicalHome, 'profiles', profile, '.dsh-module-fallback', 'node_modules')
  const entries = []
  const visit = async (directory, prefix) => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), key = prefix ? `${prefix}/${name}` : name
      const entry = await lstat(path)
      if (entry.isDirectory() && !entry.isSymbolicLink() && !prefix && scope.test(name)) {
        await visit(path, name)
      } else if (entry.isSymbolicLink()) {
        const target = await readlink(path)
        if (!inside(wrapper, resolve(directory, target))) continue
        const expected = join(wrapper, key)
        if (target !== expected || entry.uid !== process.getuid()) fail(`unexpected profile projection: ${profile}/${key}`)
        entries.push([key, target])
      }
    }
  }
  await visit(modules, '')
  return entries
}

async function profileInventory(home, logicalHome, profile, roots) {
  const wrapper = join(home, 'profiles', profile, '.dsh-module-fallback')
  const entry = await lstat(wrapper).catch(missing)
  let links = null
  if (entry !== undefined) {
    await safeDirectory(wrapper)
    if (!isDeepStrictEqual(await readdir(wrapper), ['node_modules'])) fail(`unexpected profile fallback wrapper: ${profile}`)
    links = await linkInventory(join(wrapper, 'node_modules'), roots,
      join(logicalHome, 'profiles', profile, 'node_modules'))
  }
  const projections = await projectionInventory(home, logicalHome, profile)
  if (links === null && projections.length) fail(`orphan profile projections: ${profile}`)
  return { links, projections }
}

export async function prepareHostLocalSharedFallback({ originalHome, oldHostRoot, candidateHostRoot, globalDshRoot,
  profiles }) {
  await safeDirectory(originalHome)
  await safeDirectory(oldHostRoot)
  await safeDirectory(candidateHostRoot)
  const globalDsh = await globalManifest(globalDshRoot)
  const roots = { oldHostRoot, candidateHostRoot, globalDshRoot: globalDsh?.root }
  if (!Array.isArray(profiles) || new Set(profiles).size !== profiles.length
    || profiles.some(name => !profileName.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name))) {
    fail('invalid profile inventory')
  }
  const entries = await sharedInventory(originalHome, roots)
  const profileCaches = {}
  for (const name of profiles) profileCaches[name] = await profileInventory(originalHome, originalHome, name, roots)
  return { schemaVersion: 1, originalHome, oldHostRoot, candidateHostRoot, globalDsh,
    entries, profileCaches, digest: hash(JSON.stringify([entries, profileCaches])) }
}

async function verifyOriginal(proof, originalPhysicalHome) {
  await safeDirectory(originalPhysicalHome)
  const globalDsh = await globalManifest(proof.globalDsh?.root)
  if (!isDeepStrictEqual(globalDsh, proof.globalDsh)) fail('global DSH identity changed')
  const roots = { oldHostRoot: proof.oldHostRoot,
    candidateHostRoot: proof.candidateHostRoot, globalDshRoot: globalDsh?.root }
  const entries = await sharedInventory(originalPhysicalHome, roots)
  const profileCaches = {}
  for (const name of Object.keys(proof.profileCaches)) {
    profileCaches[name] = await profileInventory(originalPhysicalHome, proof.originalHome, name, roots)
  }
  if (hash(JSON.stringify([entries, profileCaches])) !== proof.digest
    || !isDeepStrictEqual(entries, proof.entries) || !isDeepStrictEqual(profileCaches, proof.profileCaches)) {
    fail('original shared fallback changed')
  }
}

export async function retireHostLocalSharedFallback({ proof, stagedHome, originalPhysicalHome = proof.originalHome }) {
  await safeDirectory(stagedHome)
  if (stagedHome === originalPhysicalHome || inside(stagedHome, originalPhysicalHome)
    || inside(originalPhysicalHome, stagedHome)) fail('stage overlaps original Home')
  await verifyOriginal(proof, originalPhysicalHome)
  const roots = { oldHostRoot: proof.oldHostRoot,
    candidateHostRoot: proof.candidateHostRoot, globalDshRoot: proof.globalDsh?.root }
  const entries = await sharedInventory(stagedHome, roots)
  if (!isDeepStrictEqual(entries, proof.entries)) fail('staged shared fallback changed')
  for (const [name, expected] of Object.entries(proof.profileCaches)) {
    const actual = await profileInventory(stagedHome, proof.originalHome, name, roots)
    if (!isDeepStrictEqual(actual, expected)) fail(`staged profile fallback changed: ${name}`)
  }
  if (entries !== null) await rm(join(stagedHome, 'profiles', 'node_modules'), { recursive: true })
  for (const [name, cache] of Object.entries(proof.profileCaches)) {
    for (const [key] of cache.projections) await rm(join(stagedHome, 'profiles', name, 'node_modules', key))
    if (cache.links !== null) await rm(join(stagedHome, 'profiles', name, '.dsh-module-fallback'), { recursive: true })
  }
}

export async function verifyRetiredHostLocalSharedFallback({ proof, stagedHome, originalPhysicalHome = proof.originalHome }) {
  await verifyOriginal(proof, originalPhysicalHome)
  if (await lstat(join(stagedHome, 'profiles', 'node_modules')).catch(missing) !== undefined) {
    fail('candidate recreated retired shared fallback')
  }
  for (const name of Object.keys(proof.profileCaches)) {
    const cache = await profileInventory(stagedHome, proof.originalHome, name, { oldHostRoot: proof.oldHostRoot,
      candidateHostRoot: proof.candidateHostRoot, globalDshRoot: proof.globalDsh?.root })
    if (cache.links !== null || cache.projections.length) fail(`candidate retained profile fallback: ${name}`)
  }
}
