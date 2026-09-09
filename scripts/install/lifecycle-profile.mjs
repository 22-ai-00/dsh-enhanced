#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs'
import { chmod, lstat, mkdir, open, opendir, readFile, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const VALIDATOR_PATH = join(dirname(SCRIPT_PATH), 'lifecycle-config.mjs')
const SANDBOX_VALIDATOR_PATH = '/run/dsh-enhanced-lifecycle-config.mjs'
const MANIFEST_VERSION = 1
const TRANSACTION_SUFFIX = '.dsh-enhanced-transaction'
const READY_MARKER = 'dsh web: http://127.0.0.1:'
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const MANAGED_PACKAGE = /^@dsh-enhanced\/[a-z0-9-]+$/u
const SEMVER_PRERELEASE_IDENTIFIER = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)'
const SEMVER_SOURCE = `(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-${SEMVER_PRERELEASE_IDENTIFIER}(?:\\.${SEMVER_PRERELEASE_IDENTIFIER})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?`
const MANAGED_EXACT_SPEC = new RegExp(`^(@dsh-enhanced/[a-z0-9-]+)@(${SEMVER_SOURCE})$`, 'u')
const EXACT_SEMVER = new RegExp(`^${SEMVER_SOURCE}$`, 'u')
const NARROW_DIST_TAG = /^[A-Za-z][A-Za-z0-9._-]*$/u
const NPM_COHORT_ANCHOR = '@dsh-enhanced/personal-assistant'
const ANCESTOR_CHAIN_ENV = 'DSH_ENHANCED_LIFECYCLE_ANCESTORS'
const LOCK_PARENT_FD_PATH = '/proc/self/fd/3'
const ALLOWED_WEB_BUNDLES = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])

class LifecycleError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

function fail(message, exitCode = 1) {
  throw new LifecycleError(message, exitCode)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function bindingFor(manifest) {
  return {
    version: manifest.version,
    id: manifest.id,
    homePath: manifest.homePath,
    canonicalHome: manifest.canonicalHome,
    transactionPath: manifest.transactionPath,
    profile: manifest.profile,
    operation: manifest.operation,
    originalIdentity: manifest.originalIdentity,
    originalProfileDigest: manifest.originalProfileDigest,
    stagedIdentity: manifest.stagedIdentity,
    stagedProfileDigest: manifest.stagedProfileDigest,
    createdAt: manifest.createdAt,
    state: manifest.state,
  }
}

function withBindingDigest(manifest) {
  return { ...manifest, bindingDigest: sha256(JSON.stringify(bindingFor(manifest))) }
}

function sameIdentity(actual, expected) {
  return expected !== undefined && actual.isDirectory()
    && String(actual.dev) === expected.dev
    && String(actual.ino) === expected.ino
    && (expected.uid === undefined || actual.uid === expected.uid)
    && (expected.mode === undefined || actual.mode === expected.mode)
}

function identity(entry) {
  return { dev: String(entry.dev), ino: String(entry.ino), uid: entry.uid, mode: entry.mode }
}

function currentUid() {
  const uid = process.getuid?.()
  if (!Number.isInteger(uid)) fail('当前平台无法验证生命周期文件 owner。')
  return uid
}

function isGroupOrOtherWritable(entry) {
  return (entry.mode & 0o022) !== 0
}

function isRootOwnedStickyPublicDirectory(entry) {
  return entry.uid === 0 && (entry.mode & 0o7777) === 0o1777
}

function assertSafeAncestorEntry(entry, path) {
  if (!entry.isDirectory() || entry.isSymbolicLink()
    || (isGroupOrOtherWritable(entry) && !isRootOwnedStickyPublicDirectory(entry))) {
    fail(`生命周期祖先目录可被不受信任地替换或权限不安全：${path}`)
  }
}

function captureAncestorChain(parentPath) {
  const chain = []
  let cursor = parentPath
  for (;;) {
    const entry = lstatSync(cursor)
    assertSafeAncestorEntry(entry, cursor)
    chain.push({ path: cursor, ...identity(entry) })
    const next = dirname(cursor)
    if (next === cursor) break
    cursor = next
  }
  return chain
}

function parseAncestorChain(homePath) {
  let chain
  try { chain = JSON.parse(process.env[ANCESTOR_CHAIN_ENV] ?? '') }
  catch { fail('生命周期执行器缺少有效的祖先目录绑定。') }
  const expectedPaths = []
  let cursor = dirname(homePath)
  for (;;) {
    expectedPaths.push(cursor)
    const next = dirname(cursor)
    if (next === cursor) break
    cursor = next
  }
  if (!Array.isArray(chain) || chain.length !== expectedPaths.length) fail('生命周期祖先目录绑定不完整。')
  for (let index = 0; index < expectedPaths.length; index += 1) {
    const expected = chain[index]
    if (expected === null || typeof expected !== 'object' || expected.path !== expectedPaths[index]
      || typeof expected.dev !== 'string' || typeof expected.ino !== 'string'
      || !Number.isInteger(expected.uid) || !Number.isInteger(expected.mode)) {
      fail('生命周期祖先目录绑定格式无效。')
    }
  }
  return chain
}

function assertAncestorChainStable(homePath) {
  const chain = parseAncestorChain(homePath)
  for (const expected of chain) {
    let actual
    try { actual = lstatSync(expected.path) }
    catch { fail(`生命周期祖先目录在操作期间不可访问：${expected.path}`) }
    assertSafeAncestorEntry(actual, expected.path)
    if (String(actual.dev) !== expected.dev || String(actual.ino) !== expected.ino
      || actual.uid !== expected.uid || actual.mode !== expected.mode) {
      fail(`生命周期祖先目录身份或权限在操作期间发生变化：${expected.path}`)
    }
  }
  const openedParent = fstatSync(3)
  const expectedParent = chain[0]
  if (String(openedParent.dev) !== expectedParent.dev || String(openedParent.ino) !== expectedParent.ino
    || openedParent.uid !== expectedParent.uid || openedParent.mode !== expectedParent.mode) {
    fail('生命周期锁父目录 fd 与祖先目录绑定不匹配。')
  }
  return chain
}

function anchoredSibling(path) {
  return join(LOCK_PARENT_FD_PATH, basename(path))
}

function lifecyclePaths(homePath) {
  const transactionPath = `${homePath}${TRANSACTION_SUFFIX}`
  return {
    homePath,
    transactionPath,
    physicalHomePath: anchoredSibling(homePath),
    physicalTransactionRoot: anchoredSibling(transactionPath),
  }
}

function rendezvousLockPath(homePath) {
  return `/tmp/.dsh-enhanced-lifecycle-${currentUid()}-${sha256(homePath)}.lock`
}

function assertOwnedPrivateEntry(entry, path, kind) {
  const kindMatches = kind === 'directory' ? entry.isDirectory() : entry.isFile()
  if (!kindMatches || entry.isSymbolicLink() || entry.uid !== currentUid() || isGroupOrOtherWritable(entry)) {
    fail(`生命周期路径必须由当前用户拥有、不是符号链接且 group/other 不可写：${path}`)
  }
}

async function assertOwnedPrivateDirectory(path) {
  const entry = await lstat(path).catch(() => undefined)
  if (entry === undefined) fail(`生命周期目录不存在：${path}`)
  assertOwnedPrivateEntry(entry, path, 'directory')
  return entry
}

function assertExpectedDirectoryMetadata(actual, expected, path) {
  assertOwnedPrivateEntry(actual, path, 'directory')
  if (String(actual.dev) !== String(expected.dev) || String(actual.ino) !== String(expected.ino)
    || (expected.uid !== undefined && actual.uid !== expected.uid)
    || (expected.mode !== undefined && actual.mode !== expected.mode)) {
    fail(`生命周期关键目录身份或权限在使用前发生变化：${path}`)
  }
}

function sameSymlinkTarget(actual, expected) {
  return actual.target === expected.target
    && actual.targetIdentity?.dev === expected.targetIdentity?.dev
    && actual.targetIdentity?.ino === expected.targetIdentity?.ino
}

async function existingIdentity(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function canonicalMissingAllowed(path) {
  let cursor = resolve(path)
  const suffix = []
  for (;;) {
    try {
      const canonical = await realpath(cursor)
      return resolve(canonical, ...suffix)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw error
      suffix.unshift(basename(cursor))
      cursor = parent
    }
  }
}

function inside(root, target) {
  return target === root || target.startsWith(root + sep)
}

async function fsyncPath(path, directory = false) {
  let handle
  try {
    handle = await open(path, directory ? constants.O_RDONLY : constants.O_RDWR)
    await handle.sync()
  } finally {
    await handle?.close()
  }
}

async function withLifecycleLock(homePath, invocation) {
  const lockPath = `${homePath}.dsh-enhanced-lifecycle.lock`
  const parent = dirname(lockPath)
  const rendezvousPath = rendezvousLockPath(homePath)
  let parentDescriptor
  let lockDescriptor
  let rendezvousDescriptor
  try {
    const ancestorChain = captureAncestorChain(parent)
    parentDescriptor = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const openedParent = fstatSync(parentDescriptor)
    const linkedParent = lstatSync(parent)
    if (!openedParent.isDirectory() || openedParent.uid !== currentUid() || isGroupOrOtherWritable(openedParent)
      || !linkedParent.isDirectory() || linkedParent.isSymbolicLink()
      || linkedParent.uid !== currentUid() || isGroupOrOtherWritable(linkedParent)
      || linkedParent.dev !== openedParent.dev || linkedParent.ino !== openedParent.ino) {
      fail(`生命周期锁父目录身份不稳定或权限不安全：${parent}`)
    }
    const expectedParent = ancestorChain[0]
    if (String(openedParent.dev) !== expectedParent.dev || String(openedParent.ino) !== expectedParent.ino
      || openedParent.uid !== expectedParent.uid || openedParent.mode !== expectedParent.mode) {
      fail(`生命周期锁父目录与祖先目录绑定不匹配：${parent}`)
    }
    lockDescriptor = openSync(join(`/proc/self/fd/${parentDescriptor}`, basename(lockPath)), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    const locked = fstatSync(lockDescriptor)
    const linked = lstatSync(join(`/proc/self/fd/${parentDescriptor}`, basename(lockPath)))
    if (!locked.isFile() || locked.uid !== currentUid() || locked.nlink !== 1 || (locked.mode & 0o077) !== 0
      || !linked.isFile() || linked.isSymbolicLink() || linked.dev !== locked.dev || linked.ino !== locked.ino) {
      fail(`生命周期锁身份不稳定或权限不安全：${lockPath}`)
    }
    const temporaryDirectory = lstatSync('/tmp')
    if (!isRootOwnedStickyPublicDirectory(temporaryDirectory) || !temporaryDirectory.isDirectory() || temporaryDirectory.isSymbolicLink()) {
      fail('生命周期全局协调锁要求安全的 root-owned sticky /tmp。')
    }
    rendezvousDescriptor = openSync(rendezvousPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    const rendezvous = fstatSync(rendezvousDescriptor)
    const linkedRendezvous = lstatSync(rendezvousPath)
    if (!rendezvous.isFile() || rendezvous.uid !== currentUid() || rendezvous.nlink !== 1 || (rendezvous.mode & 0o077) !== 0
      || !linkedRendezvous.isFile() || linkedRendezvous.isSymbolicLink()
      || linkedRendezvous.dev !== rendezvous.dev || linkedRendezvous.ino !== rendezvous.ino) {
      fail(`生命周期全局协调锁身份不稳定或权限不安全：${rendezvousPath}`)
    }
    const flockExecutable = process.env.DSH_ENHANCED_LIFECYCLE_FLOCK ?? '/usr/bin/flock'
    try {
      await run('/bin/bash', [
        '-c', 'flock_command="$1"; shift; "$flock_command" -n -E 75 3 || exit $?; "$flock_command" -n -E 75 4 || exit $?; "$flock_command" -n -E 75 5 || exit $?; exec "$@"',
        'dsh-enhanced-lifecycle-lock', flockExecutable,
        process.execPath, SCRIPT_PATH, ...invocation, '--lock-held',
      ], {
        env: { ...process.env, [ANCESTOR_CHAIN_ENV]: JSON.stringify(ancestorChain) },
        passFds: [parentDescriptor, lockDescriptor, rendezvousDescriptor],
      })
    }
    catch (error) {
      if (error instanceof LifecycleError && error.exitCode === 75) fail(`DSH_HOME 生命周期锁正在占用，拒绝并发操作：${lockPath}`)
      throw error
    }
  } finally {
    if (rendezvousDescriptor !== undefined) closeSync(rendezvousDescriptor)
    if (lockDescriptor !== undefined) closeSync(lockDescriptor)
    if (parentDescriptor !== undefined) closeSync(parentDescriptor)
  }
}

async function assertLifecycleLocksHeld(homePath) {
  const lockPath = `${homePath}.dsh-enhanced-lifecycle.lock`
  const parent = dirname(lockPath)
  assertAncestorChainStable(homePath)
  const checks = [
    { descriptor: 3, path: parent, kind: 'directory' },
    { descriptor: 4, path: anchoredSibling(lockPath), kind: 'file' },
    { descriptor: 5, path: rendezvousLockPath(homePath), kind: 'file' },
  ]
  for (const check of checks) {
    let opened
    let linked
    try { opened = fstatSync(check.descriptor); linked = lstatSync(check.path) }
    catch { fail('生命周期执行器缺少可验证的内核锁。') }
    const kindMatches = check.kind === 'directory' ? opened.isDirectory() && linked.isDirectory() : opened.isFile() && linked.isFile()
    if (!kindMatches || linked.isSymbolicLink() || opened.uid !== currentUid() || linked.uid !== currentUid()
      || isGroupOrOtherWritable(opened) || isGroupOrOtherWritable(linked)
      || opened.dev !== linked.dev || opened.ino !== linked.ino
      || check.kind === 'file' && (opened.nlink !== 1 || (opened.mode & 0o077) !== 0)
      ) {
      fail('生命周期内核锁的路径身份已变化，拒绝继续。')
    }
    try {
      // Re-lock the inherited open-file-description itself. util-linux flock
      // starts its command in a distinct process and re-locking through a new
      // flock invocation can conflict with its parent, so use the kernel call
      // directly in a tiny interpreter. The inherited fd remains the same
      // open-file-description across exec.
      await run('/usr/bin/perl', [
        '-MFcntl=:flock', '-e', `open(F, "<&", ${check.descriptor}) or exit 74; flock(F, LOCK_EX|LOCK_NB) or exit 75;`,
      ], {
        env: { PATH: '/usr/bin:/bin' },
        passFds: [3, 4, 5],
      })
    } catch (error) {
      if (error instanceof LifecycleError && error.exitCode === 75) fail('生命周期执行器继承的 fd 未持有要求的内核排他锁。')
      throw error
    }
  }
}

async function resolveSymlinkTarget(path, logicalPath, linkText, physicalRoot, logicalRoot) {
  let candidate
  if (isAbsolute(linkText)) {
    const absoluteTarget = resolve(linkText)
    candidate = inside(logicalRoot, absoluteTarget)
      ? resolve(physicalRoot, absoluteTarget.slice(logicalRoot.length + 1))
      : absoluteTarget
  } else {
    const physicalTarget = resolve(dirname(path), linkText)
    // A relative pnpm link can lexically leave staged-home only because the
    // snapshot lives below the transaction directory. Resolve those links as
    // they will behave after the staged tree is renamed back to logicalHome.
    // Links whose lexical target remains in staged-home must resolve there: a
    // fallback to the original tree would hide a target deleted by a package
    // script and incorrectly commit a newly dangling link.
    candidate = inside(physicalRoot, physicalTarget)
      ? physicalTarget
      : resolve(dirname(logicalPath), linkText)
  }
  try {
    const target = await realpath(candidate)
    return { target, targetIdentity: identity(await lstat(target)) }
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
  }
  return { target: undefined, targetIdentity: undefined }
}

async function assertSnapshotTreeSafe(homePath, logicalHome = homePath, allowPackageHardlinks = false, packageSymlinkWhitelist) {
  const canonicalHome = await realpath(homePath)
  const homeStat = await assertOwnedPrivateDirectory(homePath)
  const hardlinks = new Map()
  const observedPackageSymlinks = new Map()
  const visit = async directory => {
    const entries = await opendir(directory)
    for await (const entry of entries) {
      const path = join(directory, entry.name)
      const relative = path.slice(homePath.length + 1)
      if (entry.isSymbolicLink()) {
        const linkText = await readlink(path)
        let resolvedTarget
        try {
          resolvedTarget = await resolveSymlinkTarget(path, join(logicalHome, relative), linkText, canonicalHome, logicalHome)
        }
        catch { fail(`DSH_HOME 包含不可安全解析的符号链接，拒绝快照：${relative}`) }
        const packageLink = relative.split(sep).includes('node_modules')
        const description = { linkText, ...resolvedTarget }
        if (packageLink) observedPackageSymlinks.set(relative, description)
        if (resolvedTarget.target !== undefined && inside(canonicalHome, resolvedTarget.target)) continue
        if (!packageLink) {
          const kind = resolvedTarget.target === undefined ? '悬空或不可解析' : '指向外部'
          fail(`DSH_HOME 包含${kind}的符号链接，拒绝快照：${relative} -> ${linkText}`)
        }
        // pnpm projects linked packages through node_modules. Only links that
        // existed in the original snapshot, with the same link text and the
        // same resolved target identity, may retain an external/dangling shape
        // after package scripts and isolated activation have run.
        if (packageSymlinkWhitelist !== undefined) {
          const expected = packageSymlinkWhitelist.get(relative)
          if (expected === undefined || linkText !== expected.linkText || !sameSymlinkTarget(description, expected)) {
            fail(`staged DSH_HOME 包含新增或已改变的 node_modules 外链/悬空链接，拒绝提交：${relative} -> ${linkText}`)
          }
        }
        continue
      }
      if (entry.isDirectory()) {
        const directoryStat = await lstat(path)
        assertOwnedPrivateEntry(directoryStat, path, 'directory')
        if (String(directoryStat.dev) !== String(homeStat.dev)) fail(`DSH_HOME 包含其它文件系统的挂载点，拒绝快照：${relative}`)
        await visit(path)
      } else if (entry.isFile()) {
        const fileStat = await lstat(path)
        assertOwnedPrivateEntry(fileStat, path, 'file')
        if (fileStat.nlink > 1 && !(allowPackageHardlinks && relative.split(sep).includes('node_modules'))) {
          const key = `${fileStat.dev}:${fileStat.ino}`
          const observed = hardlinks.get(key) ?? { count: 0, expected: fileStat.nlink, first: relative }
          observed.count += 1
          hardlinks.set(key, observed)
        }
      } else fail(`DSH_HOME 包含无法安全快照的特殊文件：${relative}`)
    }
  }
  await visit(homePath)
  for (const value of hardlinks.values()) {
    if (value.count !== value.expected) fail(`DSH_HOME 包含可能连接到快照外部的硬链接，拒绝快照：${value.first}`)
  }
  return observedPackageSymlinks
}

async function assertNoMounts(root) {
  let source
  try { source = await readFile('/proc/self/mountinfo', 'utf8') }
  catch { fail('无法读取 /proc/self/mountinfo；不能证明 DSH_HOME 不含挂载点。') }
  const canonicalRoot = await canonicalMissingAllowed(root)
  for (const line of source.split('\n')) {
    if (line === '') continue
    const fields = line.split(' ')
    if (fields.length < 5) fail('无法解析 /proc/self/mountinfo；拒绝生命周期操作。')
    const mount = fields[4].replace(/\\([0-7]{3})/gu, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)))
    if (inside(canonicalRoot, resolve(mount))) fail(`DSH_HOME 包含挂载点，拒绝生命周期操作：${mount}`)
  }
}

async function atomicWriteJson(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await fsyncPath(temporary)
  await rename(temporary, path)
  await fsyncPath(dirname(path), true)
}

async function writeManifest(transactionRoot, manifest, state, details = {}) {
  const next = withBindingDigest({ ...manifest, ...details, state, updatedAt: new Date().toISOString() })
  await atomicWriteJson(join(transactionRoot, 'manifest.json'), next)
  return next
}

async function loadManifest(physicalTransactionRoot, expected) {
  const rootStat = await lstat(physicalTransactionRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid?.() || (rootStat.mode & 0o077) !== 0) fail(`拒绝未绑定或未知的生命周期事务目录：${expected.transactionPath}`)
  const manifestPath = join(physicalTransactionRoot, 'manifest.json')
  let manifest
  try {
    const manifestStat = await lstat(manifestPath)
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.uid !== process.getuid?.()
      || manifestStat.nlink !== 1 || (manifestStat.mode & 0o077) !== 0 || manifestStat.size > 64 * 1024) throw new Error('unsafe manifest')
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    fail(`拒绝未绑定或未知的生命周期事务；缺少有效 manifest：${expected.transactionPath}`)
  }
  if (manifest?.version !== MANIFEST_VERSION
    || typeof manifest.id !== 'string'
    || manifest.homePath !== expected.homePath
    || manifest.transactionPath !== expected.transactionPath
    || manifest.profile !== expected.profile
    || !['upgrade', 'uninstall'].includes(manifest.operation)
    || !['preparing', 'prepared', 'validated', 'original-renamed', 'swapped', 'committed', 'cleanup-started', 'failed'].includes(manifest.state)
    || manifest.bindingDigest !== sha256(JSON.stringify(bindingFor(manifest)))) {
    fail(`拒绝未绑定或校验失败的生命周期事务 manifest：${expected.transactionPath}`)
  }
  if (expected.homePath !== manifest.canonicalHome) fail(`生命周期事务 manifest 与当前 DSH_HOME 未绑定：${expected.transactionPath}`)
  return manifest
}

function diagnosticPath(transactionRoot, profile) {
  const stamp = new Date().toISOString().replaceAll(/[-:.]/gu, '').replace('Z', 'Z')
  return `${transactionRoot}.failed-${profile}-${stamp}-${process.pid}`
}

async function moveTransactionAside(physicalTransactionRoot, transactionPath, profile) {
  const target = diagnosticPath(transactionPath, profile)
  await rename(physicalTransactionRoot, anchoredSibling(target))
  return target
}

function assertLockParentStable(homePath) {
  assertAncestorChainStable(homePath)
  const parentPath = dirname(homePath)
  let opened
  let linked
  try { opened = fstatSync(3); linked = lstatSync(parentPath) }
  catch { fail('生命周期锁父目录在关键 rename 前无法复核。') }
  assertOwnedPrivateEntry(opened, parentPath, 'directory')
  assertOwnedPrivateEntry(linked, parentPath, 'directory')
  if (opened.dev !== linked.dev || opened.ino !== linked.ino || opened.mode !== linked.mode) {
    fail(`生命周期锁父目录在关键 rename 前身份或权限已变化：${parentPath}`)
  }
}

async function assertCriticalDirectory(path, expected) {
  const actual = await lstat(path).catch(() => undefined)
  if (actual === undefined) fail(`生命周期关键目录不存在：${path}`)
  assertExpectedDirectoryMetadata(actual, expected, path)
  return actual
}

async function assertProfileDigest(home, profile, expected) {
  const pieces = [home, join(home, 'profiles'), join(home, 'profiles', profile)]
  for (const path of pieces) {
    const entry = await lstat(path)
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== currentUid() || isGroupOrOtherWritable(entry)) {
      fail('生命周期事务中的 profile 路径身份不安全；拒绝自动恢复。')
    }
  }
  const path = join(home, 'profiles', profile, 'package.json')
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const entry = fstatSync(descriptor)
    if (!entry.isFile() || entry.uid !== currentUid() || isGroupOrOtherWritable(entry)
      || entry.nlink !== 1 || entry.size > 4 * 1024 * 1024) {
      fail('生命周期事务中的 profile manifest 身份不安全；拒绝自动恢复。')
    }
    const source = await readFile(`/proc/self/fd/${descriptor}`)
    if (sha256(source) !== expected) fail('生命周期事务中的原 profile manifest 摘要不匹配；拒绝自动恢复。')
  } finally { closeSync(descriptor) }
}

async function recoverBoundTransaction({ homePath, physicalHomePath, profile, transactionRoot, physicalTransactionRoot }) {
  assertAncestorChainStable(homePath)
  let manifest
  try {
    await lstat(physicalTransactionRoot)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  manifest = await loadManifest(physicalTransactionRoot, { homePath, profile, transactionPath: transactionRoot })
  const backupHome = join(physicalTransactionRoot, 'original-home')
  const failedHome = join(physicalTransactionRoot, 'failed-home')
  const homeStat = await existingIdentity(physicalHomePath)
  const backupStat = await existingIdentity(backupHome)
  const homeIsOriginal = homeStat !== undefined && sameIdentity(homeStat, manifest.originalIdentity)
  const homeIsStaged = homeStat !== undefined && sameIdentity(homeStat, manifest.stagedIdentity)
  const backupIsOriginal = backupStat !== undefined && sameIdentity(backupStat, manifest.originalIdentity)

  if (manifest.state === 'committed' || manifest.state === 'cleanup-started') {
    if (!homeIsStaged || (backupStat !== undefined && !backupIsOriginal)) {
      fail(`已提交事务的 home/backup 身份不匹配；拒绝清理：${transactionRoot}`)
    }
    await assertProfileDigest(physicalHomePath, profile, manifest.stagedProfileDigest)
    if (manifest.state === 'committed') {
      if (!backupIsOriginal) fail(`已提交事务缺少完整且绑定的原始备份；拒绝开始清理：${transactionRoot}`)
      await assertProfileDigest(backupHome, profile, manifest.originalProfileDigest)
      manifest = await writeManifest(physicalTransactionRoot, manifest, 'cleanup-started')
    }
    if (backupIsOriginal) {
      assertLockParentStable(homePath)
      await assertNoMounts(physicalTransactionRoot)
      await rm(backupHome, { recursive: true })
      await fsyncPath(physicalTransactionRoot, true)
    }
    const cleanup = `${transactionRoot}.committed-${manifest.id}`
    assertLockParentStable(homePath)
    const physicalCleanup = anchoredSibling(cleanup)
    await rename(physicalTransactionRoot, physicalCleanup)
    assertLockParentStable(homePath)
    await assertNoMounts(physicalCleanup)
    await rm(physicalCleanup, { recursive: true }).catch(error => {
      process.stderr.write(`已提交事务的旧元数据清理未完成，可稍后手动删除 ${cleanup}：${error instanceof Error ? error.message : String(error)}\n`)
    })
    process.stdout.write('profile 生命周期恢复：已完成上次提交后的绑定清理。\n')
    return 'committed'
  }

  if (homeIsOriginal && backupStat === undefined) {
    await assertProfileDigest(physicalHomePath, profile, manifest.originalProfileDigest)
    await assertCriticalDirectory(physicalHomePath, manifest.originalIdentity)
    assertLockParentStable(homePath)
    const evidence = await moveTransactionAside(physicalTransactionRoot, transactionRoot, profile)
    assertLockParentStable(homePath)
    await fsyncPath(LOCK_PARENT_FD_PATH, true)
    process.stderr.write(`profile 生命周期恢复：原 DSH_HOME 未修改；旧事务证据保留在 ${evidence}\n`)
    return 'original-intact'
  }

  if (homeStat === undefined && backupIsOriginal) {
    await assertProfileDigest(backupHome, profile, manifest.originalProfileDigest)
    await assertCriticalDirectory(backupHome, manifest.originalIdentity)
    assertLockParentStable(homePath)
    if (await existingIdentity(physicalHomePath) !== undefined) fail('DSH_HOME 在恢复 rename 前重新出现；拒绝覆盖。')
    await rename(backupHome, physicalHomePath)
    assertLockParentStable(homePath)
    await fsyncPath(physicalTransactionRoot, true)
    await fsyncPath(LOCK_PARENT_FD_PATH, true)
    const evidence = await moveTransactionAside(physicalTransactionRoot, transactionRoot, profile)
    assertLockParentStable(homePath)
    await fsyncPath(LOCK_PARENT_FD_PATH, true)
    process.stderr.write(`profile 生命周期恢复：已恢复原 DSH_HOME；失败事务证据保留在 ${evidence}\n`)
    return 'restored'
  }

  if (homeIsStaged && backupIsOriginal) {
    await assertProfileDigest(backupHome, profile, manifest.originalProfileDigest)
    if (await existingIdentity(failedHome) !== undefined) fail(`事务失败副本路径已存在；拒绝覆盖：${failedHome}`)
    await assertCriticalDirectory(physicalHomePath, manifest.stagedIdentity)
    await assertCriticalDirectory(backupHome, manifest.originalIdentity)
    assertLockParentStable(homePath)
    await rename(physicalHomePath, failedHome)
    assertLockParentStable(homePath)
    await fsyncPath(physicalTransactionRoot, true)
    await fsyncPath(LOCK_PARENT_FD_PATH, true)
    await assertCriticalDirectory(backupHome, manifest.originalIdentity)
    assertLockParentStable(homePath)
    if (await existingIdentity(physicalHomePath) !== undefined) fail('DSH_HOME 在恢复 rename 前重新出现；拒绝覆盖。')
    await rename(backupHome, physicalHomePath)
    assertLockParentStable(homePath)
    await fsyncPath(physicalTransactionRoot, true)
    await fsyncPath(LOCK_PARENT_FD_PATH, true)
    const evidence = await moveTransactionAside(physicalTransactionRoot, transactionRoot, profile)
    assertLockParentStable(homePath)
    await fsyncPath(LOCK_PARENT_FD_PATH, true)
    process.stderr.write(`profile 生命周期恢复：原 DSH_HOME 已恢复；失败副本保留在 ${evidence}\n`)
    return 'restored'
  }

  fail(`生命周期事务 home/backup 身份未知；拒绝重命名或删除任何目录：${transactionRoot}`)
}

function run(executable, args, { env = process.env, capture = false, passFds = [] } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      env,
      stdio: capture
        ? ['ignore', 'pipe', 'pipe', ...passFds]
        : passFds.length === 0 ? 'inherit' : ['inherit', 'inherit', 'inherit', ...passFds],
    })
    let stdout = ''
    let stderr = ''
    if (capture) {
      child.stdout.on('data', chunk => {
        if (stdout.length < 16 * 1024 * 1024) stdout += String(chunk)
      })
      child.stderr.on('data', chunk => {
        if (stderr.length < 4 * 1024 * 1024) stderr += String(chunk)
      })
    }
    child.once('error', rejectRun)
    child.once('close', (code, signal) => {
      if (code === 0) resolveRun({ stdout, stderr })
      else rejectRun(new LifecycleError(
        `${basename(executable)} failed${signal === null ? ` with exit ${code ?? 1}` : ` from signal ${signal}`}${stderr === '' ? '' : `: ${stderr.trim()}`}`,
        code ?? 1,
      ))
    })
  })
}

function sandboxArgs({ bwrapExecutable, homePath, validatorPath, command, extraEnvironment = {} }) {
  const args = [
    '--unshare-all', '--die-with-parent', '--new-session',
    '--ro-bind', '/', '/',
    '--tmpfs', '/tmp', '--tmpfs', '/run',
    '--dir', homePath,
    '--bind-fd', '3', homePath,
    '--perms', '0400', '--ro-bind-data', '4', validatorPath,
    '--proc', '/proc', '--dev', '/dev',
    '--chdir', process.cwd(),
    '--clearenv',
    '--setenv', 'PATH', process.env.PATH ?? '/usr/bin:/bin',
    '--setenv', 'HOME', process.env.HOME ?? dirname(homePath),
    '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'DSH_HOME', homePath,
  ]
  for (const [name, value] of Object.entries(extraEnvironment)) args.push('--setenv', name, value)
  args.push('--', ...command)
  return { executable: bwrapExecutable, args }
}

async function openSandboxResources(context) {
  const stage = await open(context.stageHome, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  let validator
  try {
    validator = await open(VALIDATOR_PATH, constants.O_RDONLY | constants.O_NOFOLLOW)
    const validatorStat = await validator.stat()
    if (!validatorStat.isFile() || validatorStat.uid !== currentUid() || validatorStat.nlink !== 1
      || isGroupOrOtherWritable(validatorStat) || validatorStat.size > 4 * 1024 * 1024) {
      fail(`生命周期 validator 身份或权限不安全：${VALIDATOR_PATH}`)
    }
    return { stage, validator }
  } catch (error) {
    await stage.close()
    await validator?.close()
    throw error
  }
}

async function sandboxRun(context, command, options = {}) {
  const resources = await openSandboxResources(context)
  const invocation = sandboxArgs({
    ...context, validatorPath: SANDBOX_VALIDATOR_PATH, command, extraEnvironment: options.extraEnvironment,
  })
  try {
    return await run(invocation.executable, invocation.args, {
      capture: options.capture,
      passFds: [resources.stage.fd, resources.validator.fd],
    })
  } finally {
    await resources.validator.close()
    await resources.stage.close()
  }
}

async function validateComposedConfig(context, label) {
  const dumped = await sandboxRun(context, [context.dshExecutable, '--profile', context.profile, '--dump-config'], { capture: true })
  const physicalPath = join(context.stageHome, `.dsh-enhanced-${label}-${context.transactionId}.yml`)
  const logicalPath = join(context.homePath, basename(physicalPath))
  await writeFile(physicalPath, dumped.stdout, { mode: 0o600, flag: 'wx' })
  try {
    const validationProgram = [
      "import { readFile } from 'node:fs/promises'",
      "import { pathToFileURL } from 'node:url'",
      'const [validatorPath, sourcePath, dshHome, dshExecutable] = process.argv.slice(1)',
      'const { validateLifecycleConfig } = await import(pathToFileURL(validatorPath).href)',
      'await validateLifecycleConfig(await readFile(sourcePath, "utf8"), { dshHome, dshExecutable })',
    ].join(';')
    await sandboxRun(context, [
      process.execPath, '--input-type=module', '--eval', validationProgram,
      SANDBOX_VALIDATOR_PATH, logicalPath, context.homePath, context.dshExecutable,
    ])
  } finally {
    await rm(physicalPath, { force: true })
  }
}

async function activateInSandbox(context) {
  const resources = await openSandboxResources(context)
  const invocation = sandboxArgs({
    ...context,
    validatorPath: SANDBOX_VALIDATOR_PATH,
    command: [context.dshExecutable, '--profile', context.profile, '--host', '127.0.0.1', '--no-open', '--port', '0'],
  })
  try { await new Promise((resolveActivation, rejectActivation) => {
    const child = spawn(invocation.executable, invocation.args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe', resources.stage.fd, resources.validator.fd],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let ready = false
    let timedOut = false
    let forceTimer
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (forceTimer !== undefined) clearTimeout(forceTimer)
      if (error === undefined) resolveActivation()
      else rejectActivation(error)
    }
    const stopAfterReady = () => {
      if (settled || ready) return
      ready = true
      child.kill('SIGTERM')
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 2_000)
      forceTimer.unref()
    }
    child.stdout.on('data', chunk => {
      if (stdout.length < 1024 * 1024) stdout += String(chunk)
      if (stdout.includes(READY_MARKER)) stopAfterReady()
    })
    child.stderr.on('data', chunk => { if (stderr.length < 1024 * 1024) stderr += String(chunk) })
    child.once('error', error => finish(error))
    child.once('close', code => {
      if (ready || stdout.includes(READY_MARKER)) finish()
      else if (timedOut) finish(new LifecycleError('隔离 Host 激活在 30 秒内未就绪。'))
      else finish(new LifecycleError(`隔离 Host 激活失败（exit ${code ?? 1}）${stderr === '' ? '' : `：${stderr.trim()}`}`))
    })
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 2_000)
      forceTimer.unref()
    }, 30_000)
  }) } finally {
    await resources.validator.close()
    await resources.stage.close()
  }
}

async function readProfile(homePath, profile) {
  const homeStat = await assertOwnedPrivateDirectory(homePath)
  const profilesPath = join(homePath, 'profiles')
  const profilesStat = await assertOwnedPrivateDirectory(profilesPath)
  const profilePath = join(homePath, 'profiles', profile)
  const profileStat = await lstat(profilePath).catch(() => undefined)
  if (profileStat === undefined) {
    fail(`生命周期操作需要已存在的真实 profile 目录：${profilePath}`)
  }
  assertOwnedPrivateEntry(profileStat, profilePath, 'directory')
  const manifestPath = join(profilePath, 'package.json')
  const manifestStat = await lstat(manifestPath).catch(() => undefined)
  if (manifestStat === undefined) fail(`profile manifest 必须是普通文件：${manifestPath}`)
  assertOwnedPrivateEntry(manifestStat, manifestPath, 'file')
  if (manifestStat.nlink !== 1 || manifestStat.size > 4 * 1024 * 1024) fail(`profile manifest 身份或大小不安全：${manifestPath}`)
  const source = await readFile(manifestPath)
  let manifest
  try { manifest = JSON.parse(source) } catch { fail(`profile manifest 不是有效 JSON：${manifestPath}`) }
  return { homeStat, profilesPath, profilesStat, profilePath, profileStat, manifestPath, source, manifest }
}

async function assertProfileTreeIdentity(current) {
  await assertCriticalDirectory(current.profilesPath, identity(current.profilesStat))
  await assertCriticalDirectory(current.profilePath, identity(current.profileStat))
}

function managedNames(profileManifest) {
  return Object.keys(profileManifest.dependencies ?? {}).filter(name => MANAGED_PACKAGE.test(name)).sort()
}

function thirdPartyBundles(profileManifest) {
  const bundles = profileManifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) fail('profile manifest 缺少有效的 dsh.profile.bundles。')
  return bundles.filter(name => typeof name !== 'string' || (!ALLOWED_WEB_BUNDLES.has(name) && !MANAGED_PACKAGE.test(name)))
}

async function validateUpgradeTargets(targets, expectedNames) {
  const actualNames = []
  for (const target of targets) {
    if (isAbsolute(target)) {
      let targetManifest
      try { targetManifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')) }
      catch { fail(`无法读取升级目标 manifest：${target}`) }
      if (typeof targetManifest.name !== 'string' || !MANAGED_PACKAGE.test(targetManifest.name)) fail(`升级目标不是 @dsh-enhanced/* bundle：${target}`)
      actualNames.push(targetManifest.name)
      continue
    }
    const match = MANAGED_EXACT_SPEC.exec(target)
    if (match === null) fail(`升级目标必须是本地绝对路径或精确版本的 @dsh-enhanced/* 包：${target}`)
    actualNames.push(match[1])
  }
  const actual = [...new Set(actualNames)].sort()
  if (actual.length !== actualNames.length || JSON.stringify(actual) !== JSON.stringify(expectedNames)) {
    fail(`升级目标必须精确匹配当前已安装的受管顶层依赖；expected=${expectedNames.join(',')} actual=${actual.join(',')}`)
  }
}

function parseSingleExactNpmVersion(source, packageSpec) {
  let parsed
  try { parsed = JSON.parse(source) }
  catch { fail(`npm 为 ${packageSpec} 返回了无效的版本数据。`) }
  if (typeof parsed !== 'string' || !EXACT_SEMVER.test(parsed)) {
    fail(`npm 为 ${packageSpec} 返回了非单一精确 SemVer。`)
  }
  return parsed
}

async function resolveNpmUpgradeCohort({ npmExecutable, selector, expectedNames }) {
  if (!EXACT_SEMVER.test(selector) && !NARROW_DIST_TAG.test(selector)) {
    fail('插件版本必须是精确 SemVer 或 npm dist-tag；不支持 range。', 2)
  }
  const anchorSpec = `${NPM_COHORT_ANCHOR}@${selector}`
  let anchorResult
  try { anchorResult = await run(npmExecutable, ['view', anchorSpec, 'version', '--json'], { capture: true }) }
  catch { fail(`无法从 npm 解析 ${anchorSpec} 的版本。`) }
  const version = parseSingleExactNpmVersion(anchorResult.stdout, anchorSpec)
  process.stdout.write(`npm cohort：${anchorSpec} 解析为精确版本 ${version}。\n`)
  const targets = []
  for (const name of expectedNames) {
    const packageSpec = `${name}@${version}`
    let result
    try { result = await run(npmExecutable, ['view', packageSpec, 'version', '--json'], { capture: true }) }
    catch { fail(`npm 未发布所需 cohort bundle：${packageSpec}。尚未修改 profile。`) }
    if (parseSingleExactNpmVersion(result.stdout, packageSpec) !== version) {
      fail(`npm 未发布所需 cohort bundle：${packageSpec}。尚未修改 profile。`)
    }
    targets.push(packageSpec)
  }
  process.stdout.write(`npm cohort：已核验 ${targets.length} 个 bundle 均为 ${version}。\n`)
  return targets
}

async function performNpmUpgrade({ profile, homePath, dshExecutable, bwrapExecutable, npmExecutable, pnpmExecutable, selector }) {
  if (!PROFILE_NAME.test(profile) || !isAbsolute(homePath) || resolve(homePath) !== homePath) fail('invalid npm lifecycle invocation', 2)
  const { transactionPath: transactionRoot, physicalHomePath, physicalTransactionRoot } = lifecyclePaths(homePath)
  const recovery = await recoverBoundTransaction({ homePath, physicalHomePath, profile, transactionRoot, physicalTransactionRoot })
  if (recovery !== undefined) {
    fail('已恢复或隔离上次生命周期事务；本次未访问 npm registry。请确认 DSH_HOME 仍已停止后重试 upgrade。')
  }
  const current = await readProfile(physicalHomePath, profile)
  const expectedManaged = managedNames(current.manifest)
  if (expectedManaged.length === 0) fail('当前 profile 没有可升级的 @dsh-enhanced/* 顶层依赖。')
  const thirdParty = thirdPartyBundles(current.manifest)
  if (thirdParty.length > 0) fail(`检测到无法证明状态路径的第三方顶层 bundle，拒绝 upgrade：${thirdParty.join(', ')}`)
  const npmPath = await realpath(npmExecutable).catch(() => fail('npm executable must exist'))
  const pnpmPath = await realpath(pnpmExecutable).catch(() => fail('pnpm executable must exist'))
  const targets = await resolveNpmUpgradeCohort({ npmExecutable: npmPath, selector, expectedNames: expectedManaged })
  process.stdout.write(`npm cohort：正在生命周期锁内预取精确版本；DSH_HOME 尚未修改。\n`)
  try {
    await run(pnpmPath, ['store', 'add', ...targets], { env: { ...process.env, npm_config_ignore_scripts: 'true' } })
  } catch {
    fail('npm cohort 预取失败；尚未创建事务或修改 DSH_HOME。')
  }
  await performLifecycle({
    operation: 'upgrade', profile, homePath, dshExecutable, bwrapExecutable, targets,
    skipRecovery: true, transactionPrechecked: true,
  })
}

async function copyHome(homePath, stageHome) {
  await mkdir(stageHome, { mode: 0o700 })
  await run('/bin/cp', ['-a', '--no-preserve=links', '--reflink=auto', '--', `${homePath}${sep}.`, stageHome], { passFds: [3, 4, 5] })
}

async function initializeCleanWebProfile(stageHome, profile) {
  const profilePath = join(stageHome, 'profiles', profile)
  await mkdir(profilePath, { recursive: true, mode: 0o700 })
  const manifest = {
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...ALLOWED_WEB_BUNDLES], patchReload: 'live' } },
  }
  await writeFile(join(profilePath, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(profilePath, 'cordis.yml'), '[]\n')
  await writeFile(join(profilePath, 'cordis.patch.yml'), '[]\n')
  await writeFile(join(profilePath, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
}

async function performLifecycle({ operation, profile, homePath, dshExecutable, bwrapExecutable, targets, skipRecovery = false, transactionPrechecked = false }) {
  if (!['upgrade', 'uninstall'].includes(operation) || !PROFILE_NAME.test(profile) || !isAbsolute(homePath) || resolve(homePath) !== homePath) fail('invalid lifecycle invocation', 2)
  const { transactionPath: transactionRoot, physicalHomePath, physicalTransactionRoot } = lifecyclePaths(homePath)
  if (skipRecovery) {
    if (!transactionPrechecked) fail('lifecycle recovery may only be skipped after a locked transaction precheck')
    assertLockParentStable(homePath)
    if (await existingIdentity(physicalTransactionRoot) !== undefined) fail('生命周期事务在预检后出现；拒绝继续。')
  } else {
    await recoverBoundTransaction({ homePath, physicalHomePath, profile, transactionRoot, physicalTransactionRoot })
  }
  const homeLstat = await lstat(physicalHomePath).catch(() => undefined)
  if (homeLstat === undefined || !homeLstat.isDirectory() || homeLstat.isSymbolicLink() || resolve(homePath) === sep) {
    fail('DSH_HOME 必须是已存在的真实非根目录。')
  }
  const canonicalHome = homePath
  await assertNoMounts(physicalHomePath)
  const packageSymlinkWhitelist = await assertSnapshotTreeSafe(physicalHomePath, homePath, true)

  const current = await readProfile(physicalHomePath, profile)
  const expectedManaged = managedNames(current.manifest)
  const thirdParty = thirdPartyBundles(current.manifest)
  if (thirdParty.length > 0) fail(`检测到无法证明状态路径的第三方顶层 bundle，拒绝 ${operation}：${thirdParty.join(', ')}`)
  if (operation === 'upgrade') {
    if (expectedManaged.length === 0) fail('当前 profile 没有可升级的 @dsh-enhanced/* 顶层依赖。')
    await validateUpgradeTargets(targets, expectedManaged)
  } else {
    if (expectedManaged.length === 0) {
      process.stdout.write('profile 生命周期事务：uninstall 已完成；当前 profile 没有 @dsh-enhanced/* 顶层依赖。\n')
      return
    }
  }

  assertLockParentStable(homePath)
  const parentStat = fstatSync(3)
  const originalStat = await assertOwnedPrivateDirectory(physicalHomePath)
  if (String(parentStat.dev) !== String(originalStat.dev)) fail('DSH_HOME 与事务目录不在同一文件系统，无法保证原子切换。')
  await mkdir(physicalTransactionRoot, { mode: 0o700 })
  assertLockParentStable(homePath)
  await chmod(physicalTransactionRoot, 0o700)
  const stageHome = join(physicalTransactionRoot, 'staged-home')
  const backupHome = join(physicalTransactionRoot, 'original-home')
  let manifest = {
    version: MANIFEST_VERSION,
    id: randomUUID(),
    homePath,
    canonicalHome,
    transactionPath: transactionRoot,
    profile,
    operation,
    originalIdentity: identity(originalStat),
    originalProfileDigest: sha256(current.source),
    stagedIdentity: undefined,
    stagedProfileDigest: undefined,
    createdAt: new Date().toISOString(),
  }
  manifest = await writeManifest(physicalTransactionRoot, manifest, 'preparing')

  let swapped = false
  let commitUncertain = false
  try {
    await copyHome(physicalHomePath, stageHome)
    const stagedStat = await stat(stageHome)
    manifest = await writeManifest(physicalTransactionRoot, { ...manifest, stagedIdentity: identity(stagedStat) }, 'prepared')
    const stagedProfile = await readProfile(stageHome, profile)
    const stagedCanonical = await realpath(stagedProfile.profilePath)
    if (!inside(await realpath(stageHome), stagedCanonical)) fail('staged profile 通过符号链接逃逸 DSH_HOME；拒绝继续。')

    const sandbox = { bwrapExecutable, stageHome, homePath, dshExecutable, profile, transactionId: manifest.id }
    await validateComposedConfig(sandbox, 'before')
    if (operation === 'upgrade') {
      await sandboxRun(sandbox, [dshExecutable, 'plugin', '--profile', profile, 'add', ...targets], {
        extraEnvironment: { npm_config_offline: 'true', npm_config_package_import_method: 'copy' },
      })
    } else {
      const archiveRoot = join(stageHome, 'uninstalled-profiles')
      await mkdir(archiveRoot, { recursive: true, mode: 0o700 })
      const archiveName = `${profile}-${new Date().toISOString().replaceAll(/[-:.]/gu, '')}-${manifest.id}`
      await rename(join(stageHome, 'profiles', profile), join(archiveRoot, archiveName))
      await initializeCleanWebProfile(stageHome, profile)
    }
    await validateComposedConfig(sandbox, 'after-package')
    await activateInSandbox(sandbox)
    await validateComposedConfig(sandbox, 'after-activation')
    await assertSnapshotTreeSafe(stageHome, homePath, false, packageSymlinkWhitelist)
    await run('/bin/sync', ['-f', stageHome], { passFds: [3, 4, 5] })
    await fsyncPath(stageHome, true)
    const validatedProfile = await readProfile(stageHome, profile)
    manifest = await writeManifest(physicalTransactionRoot, { ...manifest, stagedProfileDigest: sha256(validatedProfile.source) }, 'validated')

    assertLockParentStable(homePath)
    assertExpectedDirectoryMetadata(await lstat(physicalHomePath), originalStat, homePath)
    await assertProfileTreeIdentity(current)
    await assertCriticalDirectory(stageHome, manifest.stagedIdentity)
    if (operation === 'upgrade') await assertProfileTreeIdentity(validatedProfile)
    else await readProfile(stageHome, profile)
    await rename(physicalHomePath, backupHome)
    assertLockParentStable(homePath)
    await fsyncPath(physicalTransactionRoot, true)
    await fsyncPath(LOCK_PARENT_FD_PATH, true)
    manifest = await writeManifest(physicalTransactionRoot, manifest, 'original-renamed')
    assertLockParentStable(homePath)
    if (await existingIdentity(physicalHomePath) !== undefined) fail('DSH_HOME 在原目录移走后重新出现；拒绝覆盖。')
    await assertCriticalDirectory(stageHome, manifest.stagedIdentity)
    if (operation === 'upgrade') await assertProfileTreeIdentity(validatedProfile)
    else await readProfile(stageHome, profile)
    await rename(stageHome, physicalHomePath)
    assertLockParentStable(homePath)
    await fsyncPath(physicalTransactionRoot, true)
    await fsyncPath(LOCK_PARENT_FD_PATH, true)
    swapped = true
    manifest = await writeManifest(physicalTransactionRoot, manifest, 'swapped')
    await assertProfileDigest(backupHome, profile, manifest.originalProfileDigest)
    commitUncertain = true
    manifest = await writeManifest(physicalTransactionRoot, manifest, 'committed')
    commitUncertain = false
    try {
      await assertProfileDigest(physicalHomePath, profile, manifest.stagedProfileDigest)
      await assertProfileDigest(backupHome, profile, manifest.originalProfileDigest)
      manifest = await writeManifest(physicalTransactionRoot, manifest, 'cleanup-started')
      assertLockParentStable(homePath)
      await assertNoMounts(physicalTransactionRoot)
      await rm(backupHome, { recursive: true })
      assertLockParentStable(homePath)
      await fsyncPath(physicalTransactionRoot, true)
      const cleanup = `${transactionRoot}.committed-${manifest.id}`
      const physicalCleanup = anchoredSibling(cleanup)
      assertLockParentStable(homePath)
      await rename(physicalTransactionRoot, physicalCleanup)
      assertLockParentStable(homePath)
      await fsyncPath(LOCK_PARENT_FD_PATH, true)
      await assertNoMounts(physicalCleanup)
      await rm(physicalCleanup, { recursive: true })
      assertLockParentStable(homePath)
      await fsyncPath(LOCK_PARENT_FD_PATH, true)
    } catch (cleanupError) {
      process.stderr.write(`profile 生命周期事务已提交，但旧备份清理未完成；下次持锁操作会继续清理：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`)
    }
    process.stdout.write(`profile 生命周期事务完成：${operation}；配置、凭据、Session 与任务状态均从离线副本保留。\n`)
  } catch (error) {
    const persisted = await loadManifest(physicalTransactionRoot, { homePath, profile, transactionPath: transactionRoot }).catch(() => undefined)
    if (commitUncertain && persisted?.state === 'committed') {
      process.stderr.write(`profile 生命周期已提交但收尾状态无法确认；保留当前 home 与原始备份，请重新执行同一命令持锁恢复：${transactionRoot}\n`)
    } else if (swapped || await existingIdentity(backupHome) !== undefined) {
      try {
        await recoverBoundTransaction({ homePath, physicalHomePath, profile, transactionRoot, physicalTransactionRoot })
        process.stderr.write('profile 生命周期事务失败：原 DSH_HOME 已恢复。\n')
      } catch (recoveryError) {
        process.stderr.write(`profile 生命周期事务失败且自动恢复未完成：${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}\n`)
      }
    } else {
      try { await writeManifest(physicalTransactionRoot, manifest, 'failed', { failure: error instanceof Error ? error.message : String(error) }) } catch {}
      process.stderr.write(`profile 生命周期事务失败：原 DSH_HOME 未修改；失败副本保留在 ${transactionRoot}\n`)
    }
    throw error
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const lockHeld = argv.at(-1) === '--lock-held'
  if (lockHeld) argv.pop()
  const [operation, profile, suppliedHomePath, suppliedDshExecutable, suppliedBwrapExecutable, ...targets] = argv
  if (operation === undefined || profile === undefined || suppliedHomePath === undefined || suppliedDshExecutable === undefined || suppliedBwrapExecutable === undefined) {
    fail('usage: lifecycle-profile.mjs <upgrade|npm-upgrade|uninstall|recover> <profile> <dsh-home> <dsh-executable> <bwrap-executable> [operation-arguments...]', 2)
  }
  if (!isAbsolute(suppliedHomePath) || resolve(suppliedHomePath) !== suppliedHomePath) fail('invalid lifecycle DSH_HOME', 2)
  const homePath = await canonicalMissingAllowed(suppliedHomePath)
  const dshExecutable = operation === 'recover' ? suppliedDshExecutable : await realpath(suppliedDshExecutable).catch(() => fail('DSH executable must exist'))
  const bwrapExecutable = operation === 'recover' ? suppliedBwrapExecutable : await realpath(suppliedBwrapExecutable).catch(() => fail('bwrap executable must exist'))
  if (!lockHeld) {
    await withLifecycleLock(homePath, [operation, profile, homePath, dshExecutable, bwrapExecutable, ...targets])
    return
  }
  await assertLifecycleLocksHeld(homePath)
  if (operation === 'recover') {
    if (!PROFILE_NAME.test(profile) || !isAbsolute(homePath) || resolve(homePath) !== homePath) fail('invalid lifecycle recovery invocation', 2)
    const { transactionPath: transactionRoot, physicalHomePath, physicalTransactionRoot } = lifecyclePaths(homePath)
    await recoverBoundTransaction({ homePath, physicalHomePath, profile, transactionRoot, physicalTransactionRoot })
    return
  }
  if (operation === 'npm-upgrade') {
    if (targets.length !== 3) fail('npm-upgrade requires npm executable, pnpm executable, and one selector', 2)
    const [npmExecutable, pnpmExecutable, selector] = targets
    await performNpmUpgrade({ profile, homePath, dshExecutable, bwrapExecutable, npmExecutable, pnpmExecutable, selector })
    return
  }
  await performLifecycle({ operation, profile, homePath, dshExecutable, bwrapExecutable, targets })
}

main().catch(error => {
  process.stderr.write(`dsh-enhanced lifecycle: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = error instanceof LifecycleError ? error.exitCode : 1
})
