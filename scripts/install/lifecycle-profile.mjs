#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs'
import { chmod, lstat, mkdir, open, opendir, readFile, readdir, readlink, realpath, rename, rm, rmdir, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyLifecycleScenario } from './lifecycle-config.mjs'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const VALIDATOR_PATH = join(dirname(SCRIPT_PATH), 'lifecycle-config.mjs')
const SANDBOX_VALIDATOR_PATH = '/run/dsh-enhanced-lifecycle-config.mjs'
const MANIFEST_VERSION = 1
const SERVICE_MANIFEST_VERSION = 2
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
const SYSTEMD_UNIT = /^dsh-profile-([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.service$/u
const SYSTEMD_SHOW_PROPERTIES = [
  'Id', 'LoadState', 'FragmentPath', 'DropInPaths', 'ActiveState', 'SubState', 'MainPID',
  'ControlPID', 'InvocationID', 'NRestarts', 'UnitFileState', 'WorkingDirectory', 'Environment', 'ExecStart',
]
const KEYRING_DROP_IN = '[Unit]\nRequires=gnome-keyring-daemon.service\nAfter=gnome-keyring-daemon.service\n'
const SERVICE_PHASES = new Set(['initializing', 'stopping', 'stopped', 'swapped', 'starting', 'service-accepted', 'service-failed'])
const LIFECYCLE_SCENARIOS = new Set(['web', 'autonomy', 'lark'])

class LifecycleError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

class ServiceMaskConflictError extends LifecycleError {}

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
    transactionIdentity: manifest.transactionIdentity,
    profile: manifest.profile,
    operation: manifest.operation,
    originalIdentity: manifest.originalIdentity,
    originalProfileDigest: manifest.originalProfileDigest,
    stagedIdentity: manifest.stagedIdentity,
    stagedProfileDigest: manifest.stagedProfileDigest,
    expectedScenario: manifest.expectedScenario,
    stagedScenario: manifest.stagedScenario,
    createdAt: manifest.createdAt,
    state: manifest.state,
    services: manifest.services,
    servicePhase: manifest.servicePhase,
    serviceFailure: manifest.serviceFailure,
    serviceAcceptance: manifest.serviceAcceptance,
    unitUniverse: manifest.unitUniverse,
    serviceMasks: manifest.serviceMasks,
    containmentMasks: manifest.containmentMasks,
    containmentMaskIntents: manifest.containmentMaskIntents,
    serviceStartBarriers: manifest.serviceStartBarriers,
    containmentStartBarriers: manifest.containmentStartBarriers,
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

function sameSymlinkIdentity(actual, expected) {
  return expected !== undefined && actual.isSymbolicLink()
    && String(actual.dev) === expected.dev
    && String(actual.ino) === expected.ino
    && actual.uid === expected.uid
    && actual.mode === expected.mode
    && actual.nlink === 1
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
  const initializingServiceManifest = manifest?.version === SERVICE_MANIFEST_VERSION
    && manifest.state === 'preparing' && manifest.servicePhase === 'initializing'
    && Array.isArray(manifest.services) && manifest.services.length > 0
    && Array.isArray(manifest.unitUniverse) && manifest.unitUniverse.length > 0
    && Array.isArray(manifest.serviceMasks) && manifest.serviceMasks.length === 0
    && Array.isArray(manifest.containmentMasks) && manifest.containmentMasks.length === 0
    && Array.isArray(manifest.containmentMaskIntents) && manifest.containmentMaskIntents.length === 0
    && Array.isArray(manifest.containmentStartBarriers) && manifest.containmentStartBarriers.length === 0
    && Array.isArray(manifest.serviceStartBarriers) && manifest.serviceStartBarriers.length === 0
  const validServiceManifest = manifest?.version !== SERVICE_MANIFEST_VERSION || initializingServiceManifest || (
    Array.isArray(manifest.services) && manifest.services.length > 0
    && Array.isArray(manifest.unitUniverse) && manifest.unitUniverse.length > 0
    && new Set(manifest.unitUniverse).size === manifest.unitUniverse.length
    && manifest.unitUniverse.every(unit => typeof unit === 'string' && SYSTEMD_UNIT.test(unit))
    && SERVICE_PHASES.has(manifest.servicePhase)
    && Array.isArray(manifest.serviceMasks) && manifest.serviceMasks.length === manifest.services.length
    && manifest.serviceMasks.every((mask, index) => validBoundMask(mask, manifest.services[index]?.unit, physicalTransactionRoot))
    && Array.isArray(manifest.containmentMasks)
    && manifest.containmentMasks.every(mask => validBoundMask(mask, mask?.unit, physicalTransactionRoot))
    && Array.isArray(manifest.containmentMaskIntents)
    && manifest.containmentMaskIntents.every(intent => validMaskIntent(intent, physicalTransactionRoot))
    && Array.isArray(manifest.containmentStartBarriers)
    && manifest.containmentStartBarriers.every(barrier => barrier !== null && typeof barrier === 'object'
      && typeof barrier.unit === 'string' && SYSTEMD_UNIT.test(barrier.unit)
      && ['enabled', 'disabled'].includes(barrier.originalUnitFileState)
      && typeof barrier.disableIntentAt === 'string' && validBoundEnablement(barrier, physicalTransactionRoot))
    && new Set([...manifest.serviceMasks, ...manifest.containmentMasks].map(mask => mask.unit)).size
      === manifest.serviceMasks.length + manifest.containmentMasks.length
    && Array.isArray(manifest.serviceStartBarriers)
    && manifest.serviceStartBarriers.length === manifest.services.length
    && manifest.serviceStartBarriers.every((barrier, index) => barrier !== null && typeof barrier === 'object'
      && typeof barrier.unit === 'string' && barrier.unit === manifest.services[index]?.unit
      && ['enabled', 'disabled'].includes(barrier.originalUnitFileState)
      && typeof barrier.disableIntentAt === 'string'
      && validBoundEnablement(barrier, physicalTransactionRoot))
    && manifest.services.every(service => service !== null && typeof service === 'object'
      && typeof service.unit === 'string' && SYSTEMD_UNIT.test(service.unit)
      && typeof service.profile === 'string' && PROFILE_NAME.test(service.profile)
      && service.unit === `dsh-profile-${service.profile}.service`
      && service.serviceHome === expected.homePath
      && typeof service.wasActive === 'boolean'
      && service.fragment !== null && typeof service.fragment === 'object'
      && typeof service.fragment.path === 'string' && typeof service.fragment.sha256 === 'string'
      && Array.isArray(service.dropIns))
  )
  const validExpectedScenario = manifest?.expectedScenario === undefined
    || LIFECYCLE_SCENARIOS.has(manifest.expectedScenario)
      && (manifest.version === SERVICE_MANIFEST_VERSION
        ? manifest.expectedScenario === 'lark'
        : manifest.expectedScenario !== 'lark')
  const validStagedScenario = manifest?.stagedScenario === undefined
    || (LIFECYCLE_SCENARIOS.has(manifest.stagedScenario) || manifest.stagedScenario === 'unsupported')
      && (manifest.operation === 'uninstall'
        ? manifest.stagedScenario === 'unsupported'
        : manifest.stagedScenario === manifest.expectedScenario)
      && (manifest.version !== SERVICE_MANIFEST_VERSION || manifest.stagedScenario === 'lark')
  if (![MANIFEST_VERSION, SERVICE_MANIFEST_VERSION].includes(manifest?.version)
    || typeof manifest.id !== 'string'
    || manifest.homePath !== expected.homePath
    || manifest.transactionPath !== expected.transactionPath
    || manifest.version === SERVICE_MANIFEST_VERSION && (manifest.transactionIdentity === undefined
      || typeof manifest.transactionIdentity.dev !== 'string' || typeof manifest.transactionIdentity.ino !== 'string')
    || manifest.profile !== expected.profile
    || !['upgrade', 'uninstall'].includes(manifest.operation)
    || !['preparing', 'prepared', 'validated', 'original-renamed', 'swapped', 'committed', 'cleanup-started', 'failed', 'service-accepted', 'service-failed'].includes(manifest.state)
    || !validServiceManifest
    || !validExpectedScenario
    || !validStagedScenario
    || manifest.bindingDigest !== sha256(JSON.stringify(bindingFor(manifest)))) {
    fail(`拒绝未绑定或校验失败的生命周期事务 manifest：${expected.transactionPath}`)
  }
  if (expected.homePath !== manifest.canonicalHome) fail(`生命周期事务 manifest 与当前 DSH_HOME 未绑定：${expected.transactionPath}`)
  return manifest
}

function validBoundMask(mask, expectedUnit, expectedTransactionRoot) {
  const expectedPath = join(process.env.HOME ?? '', '.config', 'systemd', 'user.control', expectedUnit ?? '')
  return mask !== null && typeof mask === 'object'
    && typeof mask.unit === 'string' && SYSTEMD_UNIT.test(mask.unit) && mask.unit === expectedUnit
    && mask.path === expectedPath && mask.target === '/dev/null'
    && mask.transactionRoot === expectedTransactionRoot && typeof mask.stagingPath === 'string'
    && inside(mask.transactionRoot, mask.stagingPath)
    && mask.identity !== null && typeof mask.identity === 'object'
    && typeof mask.identity.dev === 'string' && typeof mask.identity.ino === 'string'
    && mask.identity.uid === currentUid() && typeof mask.identity.mode === 'number'
}

function validMaskIntent(intent, expectedTransactionRoot) {
  return intent !== null && typeof intent === 'object'
    && typeof intent.unit === 'string' && SYSTEMD_UNIT.test(intent.unit)
    && intent.path === serviceMaskPath(intent.unit) && intent.target === '/dev/null'
    && intent.transactionRoot === expectedTransactionRoot && typeof intent.stagingPath === 'string'
    && inside(expectedTransactionRoot, intent.stagingPath)
    && intent.barrier !== null && typeof intent.barrier === 'object'
    && intent.barrier.unit === intent.unit && validBoundEnablement(intent.barrier, expectedTransactionRoot)
}

function validBoundEnablement(barrier, expectedTransactionRoot) {
  if (barrier.originalUnitFileState === 'disabled') return barrier.enablement === undefined
  const link = barrier.enablement
  const expectedPath = join(process.env.HOME ?? '', '.config', 'systemd', 'user', 'default.target.wants', barrier.unit)
  return link !== null && typeof link === 'object' && link.path === expectedPath
    && link.transactionRoot === expectedTransactionRoot && typeof link.stagingPath === 'string'
    && inside(expectedTransactionRoot, link.stagingPath) && typeof link.target === 'string'
    && link.identity !== null && typeof link.identity === 'object'
    && typeof link.identity.dev === 'string' && typeof link.identity.ino === 'string'
    && link.identity.uid === currentUid() && typeof link.identity.mode === 'number'
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

async function recoverBoundTransaction({
  homePath, physicalHomePath, profile, transactionRoot, physicalTransactionRoot, serviceContext, dshExecutable,
}) {
  assertAncestorChainStable(homePath)
  const transactionStat = await existingIdentity(physicalTransactionRoot)
  if (transactionStat === undefined) return undefined
  if (!transactionStat.isDirectory() || transactionStat.isSymbolicLink()
    || transactionStat.uid !== currentUid() || (transactionStat.mode & 0o077) !== 0) {
    fail(`拒绝未绑定或未知的生命周期事务目录：${transactionRoot}`)
  }
  const transactionEntries = await readdir(physicalTransactionRoot)
  if (!transactionEntries.includes('manifest.json')) {
    if (transactionEntries.length !== 0) {
      fail(`拒绝未绑定或未知的生命周期事务；缺少有效 manifest：${transactionRoot}`)
    }
    await assertNoMounts(physicalTransactionRoot)
    assertLockParentStable(homePath)
    const transactionBeforeRemove = await lstat(physicalTransactionRoot)
    if (!sameIdentity(transactionBeforeRemove, identity(transactionStat))) {
      fail(`空生命周期事务目录在删除前发生替换：${transactionRoot}`)
    }
    await rmdir(physicalTransactionRoot)
    await fsyncPath(LOCK_PARENT_FD_PATH, true)
    process.stderr.write(`生命周期恢复：已删除上次清理遗留的安全空事务目录：${transactionRoot}\n`)
    return 'empty-cleaned'
  }
  let manifest
  manifest = await loadManifest(physicalTransactionRoot, { homePath, profile, transactionPath: transactionRoot })
  if (serviceContext !== undefined && manifest.version !== SERVICE_MANIFEST_VERSION) {
    fail(`检测到旧版 stopped-home lifecycle residue；无法在受管 service 运行状态未知时安全恢复，拒绝修改 DSH_HOME：${transactionRoot}`)
  }
  const backupHome = join(physicalTransactionRoot, 'original-home')
  const failedHome = join(physicalTransactionRoot, 'failed-home')
  const homeStat = await existingIdentity(physicalHomePath)
  const backupStat = await existingIdentity(backupHome)
  const homeIsOriginal = homeStat !== undefined && sameIdentity(homeStat, manifest.originalIdentity)
  const homeIsStaged = homeStat !== undefined && sameIdentity(homeStat, manifest.stagedIdentity)
  const backupIsOriginal = backupStat !== undefined && sameIdentity(backupStat, manifest.originalIdentity)
  if (manifest.version === SERVICE_MANIFEST_VERSION) {
    if (serviceContext === undefined || dshExecutable === undefined) {
      fail(`service-aware 生命周期恢复需要以原 Lark upgrade 命令持锁执行；保留证据：${transactionRoot}`)
    }
    const scenarioHome = homeIsOriginal || homeIsStaged ? homePath
      : backupIsOriginal ? join(transactionRoot, 'original-home') : undefined
    if (scenarioHome === undefined) {
      fail(`service-aware 生命周期恢复无法绑定可验证的配置副本；保留证据：${transactionRoot}`)
    }
    await assertLockedLifecycleScenario({
      dshExecutable, profile, homePath: scenarioHome,
      expectedScenario: homeIsStaged ? manifest.stagedScenario ?? manifest.expectedScenario : manifest.expectedScenario,
      serviceAware: true,
    })
    if (manifest.servicePhase === 'initializing') {
      if (!homeIsOriginal || backupStat !== undefined) {
        fail(`service-aware initializing residue 身份未知；拒绝清理：${transactionRoot}`)
      }
      const evidence = await moveTransactionAside(physicalTransactionRoot, transactionRoot, profile)
      await fsyncPath(LOCK_PARENT_FD_PATH, true)
      process.stderr.write(`service-aware 生命周期恢复：初始化未修改 service/home；证据保留在 ${evidence}\n`)
      return 'service-original-restored'
    }
    return recoverServiceTransaction({
      manifest, homePath, physicalHomePath, profile, transactionRoot, physicalTransactionRoot, backupHome,
      homeStat, backupStat, homeIsOriginal, homeIsStaged, backupIsOriginal, serviceContext, dshExecutable,
    })
  }
  const scenarioHome = homeIsOriginal || homeIsStaged ? homePath
    : backupIsOriginal ? join(transactionRoot, 'original-home') : undefined
  if (scenarioHome !== undefined) {
    const recoveryScenario = homeIsStaged && manifest.operation === 'uninstall'
      ? manifest.stagedScenario ?? 'unsupported'
      : manifest.expectedScenario
    await assertLockedLifecycleScenario({
      dshExecutable, profile, homePath: scenarioHome,
      expectedScenario: recoveryScenario,
      serviceAware: false,
    })
  }

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
    await removeCommittedTransaction({ physicalTransactionRoot, transactionRoot, manifest, backupHome })
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

function run(executable, args, { env = process.env, capture = false, passFds = [], timeoutMs } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      env,
      stdio: capture
        ? ['ignore', 'pipe', 'pipe', ...passFds]
        : passFds.length === 0 ? 'inherit' : ['inherit', 'inherit', 'inherit', ...passFds],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timeout = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    timeout?.unref()
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
      if (timeout !== undefined) clearTimeout(timeout)
      if (code === 0) resolveRun({ stdout, stderr })
      else rejectRun(new LifecycleError(
        timedOut
          ? `${basename(executable)} timed out after ${timeoutMs}ms`
          : `${basename(executable)} failed${signal === null ? ` with exit ${code ?? 1}` : ` from signal ${signal}`}${stderr === '' ? '' : `: ${stderr.trim()}`}`,
        code ?? 1,
      ))
    })
  })
}

function serviceCommandEnvironment() {
  return {
    PATH: '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
    ...(process.env.DBUS_SESSION_BUS_ADDRESS === undefined ? {} : { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS }),
    ...(process.env.XDG_RUNTIME_DIR === undefined ? {} : { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }),
  }
}

async function runServiceCommand(executable, args) {
  return await run(executable, args, { env: serviceCommandEnvironment(), capture: true, timeoutMs: 30_000 })
}

async function withCrashStopGuardian(
  systemctlExecutable, units, completionToken, operation, startUnits = true, containmentHome,
) {
  const source = String.raw`
const { spawnSync } = require('node:child_process')
const { realpathSync } = require('node:fs')
const { isAbsolute, sep } = require('node:path')
const [systemctl, completionToken, startFlag, containmentHome, ...units] = process.argv.slice(1)
const unitPattern = /^dsh-profile-[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.service$/u
const knownUnits = [...new Set(units)]
let input = ''
let parentDisconnected = false
let containmentPromise
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { input += chunk })
const sleep = milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds))
const command = args => spawnSync(systemctl, args, { encoding: 'utf8', timeout: 30000 })
const successful = result => result.error === undefined && result.status === 0
const lines = source => {
  if (source === '') return []
  const values = source.endsWith('\n') ? source.slice(0, -1).split('\n') : source.split('\n')
  return values.length === 1 && values[0] === '' ? [] : values
}
const parseUnitList = (result, minimumColumns) => {
  if (!successful(result)) return undefined
  const parsed = []
  for (const line of lines(result.stdout)) {
    const normalized = line.trim()
    if (normalized === '') return undefined
    const fields = normalized.split(/\s+/u)
    if (fields.length < minimumColumns || !unitPattern.test(fields[0])) return undefined
    parsed.push(fields[0])
  }
  return new Set(parsed).size === parsed.length ? parsed : undefined
}
const parseProperties = (result, required) => {
  if (!successful(result)) return undefined
  const values = {}
  for (const line of lines(result.stdout)) {
    const index = line.indexOf('=')
    const key = index <= 0 ? '' : line.slice(0, index)
    if (!required.includes(key) || Object.hasOwn(values, key)) return undefined
    values[key] = line.slice(index + 1)
  }
  return required.every(key => Object.hasOwn(values, key)) ? values : undefined
}
const parseEnvironment = source => {
  const words = []
  let word = ''
  let quote = ''
  let active = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '\\') {
      const next = source[index + 1]
      if (next === undefined) return undefined
      if (next === 'x' && /^[0-9A-Fa-f]{2}$/u.test(source.slice(index + 2, index + 4))) {
        word += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 4), 16))
        index += 3
      } else {
        word += next
        index += 1
      }
      active = true
    } else if (quote !== '') {
      if (character === quote) quote = ''
      else word += character
      active = true
    } else if (character === '"' || character === "'") {
      quote = character
      active = true
    } else if (/\s/u.test(character)) {
      if (active) { words.push(word); word = ''; active = false }
    } else {
      word += character
      active = true
    }
  }
  if (quote !== '') return undefined
  if (active) words.push(word)
  return words.every(value => /^[^=]+=/u.test(value)) ? words : undefined
}
const canonical = value => {
  try { return realpathSync(value) } catch { return undefined }
}
const ownership = (unit) => {
  const result = command([
    '--user', 'show', unit, '--no-pager', '--property=Id', '--property=LoadState',
    '--property=Environment', '--property=WorkingDirectory',
  ])
  const values = parseProperties(result, ['Id', 'LoadState', 'Environment', 'WorkingDirectory'])
  if (values === undefined || values.Id !== unit || values.LoadState === '') return undefined
  const environment = parseEnvironment(values.Environment)
  if (environment === undefined) return undefined
  const configuredHomes = environment
    .filter(value => value.startsWith('DSH_HOME='))
    .map(value => value.slice('DSH_HOME='.length))
  if (configuredHomes.length > 1) return undefined
  const canonicalHome = configuredHomes.length === 1 && isAbsolute(configuredHomes[0])
    ? canonical(configuredHomes[0]) : undefined
  const homeMatches = canonicalHome === containmentHome
  const working = values.WorkingDirectory
  if (working !== '' && !isAbsolute(working)) return undefined
  const canonicalWorking = working === '' ? '' : canonical(working)
  const workingMatches = canonicalWorking !== undefined
    && (canonicalWorking === containmentHome || canonicalWorking.startsWith(containmentHome + sep))
  if (homeMatches || workingMatches) return 'same-home'
  const homeForeign = canonicalHome !== undefined && canonicalHome !== containmentHome
  const workingForeign = canonicalWorking !== undefined && canonicalWorking !== '' && !workingMatches
  return homeForeign || workingForeign ? 'foreign' : undefined
}
const state = unit => parseProperties(command([
  '--user', 'show', unit, '--no-pager', '--property=Id', '--property=ActiveState',
  '--property=SubState', '--property=MainPID', '--property=ControlPID',
] ), ['Id', 'ActiveState', 'SubState', 'MainPID', 'ControlPID'])
const inactive = (unit, values) => values !== undefined && values.Id === unit
  && values.ActiveState === 'inactive' && values.SubState === 'dead'
  && values.MainPID === '0' && values.ControlPID === '0'
const stop = targets => targets.length === 0 || successful(command(['--user', 'stop', ...targets]))
const verify = targets => targets.every(unit => inactive(unit, state(unit)))
const stopKnownUntilVerified = async () => {
  for (;;) {
    stop(knownUnits)
    if (verify(knownUnits)) return
    await sleep(1000)
  }
}
const stopAndVerify = async () => {
  stop(knownUnits)
  verify(knownUnits)
  let previousCensus
  let stableCensuses = 0
  for (;;) {
    const unitFiles = parseUnitList(command([
      '--user', 'list-unit-files', '--type=service', '--no-legend', '--no-pager', 'dsh-profile-*.service',
    ]), 2)
    const loadedUnits = parseUnitList(command([
      '--user', 'list-units', '--all', '--type=service', '--plain', '--no-legend', '--no-pager', 'dsh-profile-*.service',
    ]), 4)
    if (unitFiles === undefined || loadedUnits === undefined) {
      stableCensuses = 0
      previousCensus = undefined
      stop(knownUnits)
      verify(knownUnits)
      await sleep(1000)
      continue
    }
    const census = [...new Set([...unitFiles, ...loadedUnits])].sort()
    const classifications = []
    let complete = true
    for (const unit of census) {
      if (knownUnits.includes(unit)) {
        classifications.push([unit, 'known'])
        continue
      }
      const classification = containmentHome === '-' ? 'foreign' : ownership(unit)
      if (classification === undefined) { complete = false; break }
      classifications.push([unit, classification])
    }
    if (!complete) {
      stableCensuses = 0
      previousCensus = undefined
      stop(knownUnits)
      verify(knownUnits)
      await sleep(1000)
      continue
    }
    const targets = [...new Set([
      ...knownUnits,
      ...classifications.filter(([, classification]) => classification === 'same-home').map(([unit]) => unit),
    ])].sort()
    stop(targets)
    const quiescent = verify(targets)
    if (!quiescent) {
      stableCensuses = 0
      previousCensus = undefined
      await sleep(1000)
      continue
    }
    const signature = JSON.stringify(classifications)
    stableCensuses = signature === previousCensus ? stableCensuses + 1 : 1
    previousCensus = signature
    if (stableCensuses >= 2) return 1
    await sleep(1000)
  }
}
const beginContainment = () => {
  parentDisconnected = true
  if (containmentPromise === undefined) {
    containmentPromise = (async () => {
      for (;;) {
        try {
          const status = await stopAndVerify()
          process.exit(status || 1)
        } catch {}
        await sleep(1000)
      }
    })()
  }
}
for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.on(signal, beginContainment)
process.stdin.on('end', () => {
  if (input === completionToken + '\n' && !parentDisconnected) process.exit(0)
  else beginContainment()
})
process.stdin.on('error', beginContainment)
process.stdout.on('error', beginContainment)
;(async () => {
  const startStatus = startFlag === '1' && knownUnits.length > 0
    ? command(['--user', 'start', ...knownUnits]).status ?? 1
    : 0
  if (startStatus !== 0) {
    await stopKnownUntilVerified()
    process.stdout.write('STARTED ' + startStatus + ' 0\n')
    beginContainment()
    return
  }
  if (parentDisconnected) { beginContainment(); return }
  process.stdout.write('STARTED 0 0\n', error => { if (error) beginContainment() })
})().catch(beginContainment)
`
  const guardian = spawn(process.execPath, [
    '-e', source, systemctlExecutable, completionToken, startUnits ? '1' : '0', containmentHome ?? '-', ...units,
  ], {
    // Keep the parent directory plus both kernel lock descriptions alive if
    // the lifecycle process dies. The detached guardian must continue to
    // exclude recovery and setup until containment is conclusively finished.
    detached: true, env: serviceCommandEnvironment(), stdio: ['pipe', 'pipe', 'inherit', 3, 4, 5],
  })
  const completion = new Promise((resolveCompletion, rejectCompletion) => {
    guardian.once('error', rejectCompletion)
    guardian.once('close', (code, signal) => {
      if (code === 0) resolveCompletion()
      else rejectCompletion(new LifecycleError(`service crash guardian failed${signal === null ? ` with exit ${code ?? 1}` : ` from signal ${signal}`}`))
    })
  })
  try {
    await new Promise((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => rejectReady(new LifecycleError('service crash guardian 未就绪。')), 35_000)
      timeout.unref()
      guardian.stdout.once('data', chunk => {
        clearTimeout(timeout)
        const match = /^STARTED (\d+) (\d+)\n/u.exec(String(chunk))
        if (match?.[1] === '0' && match[2] === '0') resolveReady()
        else rejectReady(new LifecycleError(`service crash guardian 启动/收容失败：start=${match?.[1] ?? 'invalid'} containment=${match?.[2] ?? 'invalid'}`))
      })
      guardian.once('error', rejectReady)
    })
  } catch (error) {
    guardian.stdin.end()
    await completion.catch(() => {})
    throw error
  }
  try {
    const result = await operation()
    guardian.stdin.end(`${completionToken}\n`)
    await completion
    return result
  } catch (error) {
    guardian.stdin.end()
    await completion.catch(() => {})
    throw error
  }
}

async function trustedServiceExecutable(path, name) {
  const canonical = await realpath(path).catch(() => fail(`${name} executable must exist`))
  const entry = await lstat(canonical)
  if (!entry.isFile() || entry.isSymbolicLink() || isGroupOrOtherWritable(entry)
    || entry.uid !== 0 || !['/usr/bin', '/bin'].includes(dirname(canonical))) {
    fail(`${name} executable 的 owner、权限或系统路径不可信：${canonical}`)
  }
  return canonical
}

async function trustedSystemExecutable(path, name) {
  const canonical = await realpath(path).catch(() => fail(`${name} executable must exist`))
  const entry = await lstat(canonical)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== 0 || isGroupOrOtherWritable(entry)
    || !['/usr/bin', '/bin'].includes(dirname(canonical))) {
    fail(`${name} executable 的 owner、权限或系统路径不可信：${canonical}`)
  }
  return canonical
}

function parseBoundedMilliseconds(name, defaultValue, maximum) {
  const raw = process.env[name] ?? String(defaultValue)
  if (!/^(?:0|[1-9]\d*)$/u.test(raw)) fail(`${name} 必须是 0..${maximum} 的整数。`, 2)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value > maximum) fail(`${name} 必须是 0..${maximum} 的整数。`, 2)
  return value
}

function serviceTimeouts() {
  return {
    stop: parseBoundedMilliseconds('DSH_ENHANCED_SERVICE_STOP_TIMEOUT_MS', 30_000, 300_000),
    ready: parseBoundedMilliseconds('DSH_ENHANCED_SERVICE_READY_TIMEOUT_MS', 30_000, 300_000),
    stability: parseBoundedMilliseconds('DSH_ENHANCED_SERVICE_STABILITY_MS', 12_000, 60_000),
  }
}

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, Math.min(100, Math.max(1, milliseconds))))
}

function parseSystemdShow(source, unit) {
  const values = new Map()
  for (const line of source.trimEnd().split('\n')) {
    const separator = line.indexOf('=')
    if (separator <= 0) fail(`systemctl show 返回无法解析的字段：${unit}`)
    const key = line.slice(0, separator)
    if (!SYSTEMD_SHOW_PROPERTIES.includes(key) || values.has(key)) fail(`systemctl show 返回重复或未知字段：${unit}:${key}`)
    values.set(key, line.slice(separator + 1))
  }
  for (const property of SYSTEMD_SHOW_PROPERTIES) if (!values.has(property)) fail(`systemctl show 缺少字段：${unit}:${property}`)
  return Object.fromEntries(values)
}

function decodeUnitQuoted(value, label) {
  let output = ''
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\\') { output += value[index]; continue }
    index += 1
    if (index >= value.length || !['\\', '"'].includes(value[index])) fail(`systemd unit ${label} 包含 renderer 不会生成的转义。`)
    output += value[index]
  }
  return output.replaceAll('%%', '%')
}

function rendererUnitPattern(profile) {
  const escapedProfile = profile.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(
    '^\\[Unit\\]\\nDescription=DeepSeek Harness profile ' + escapedProfile
    + '\\nAfter=network-online\\.target\\nWants=network-online\\.target\\nStartLimitIntervalSec=0\\n\\n'
    + '\\[Service\\]\\nType=simple\\nWorkingDirectory=([^\\r\\n]+)\\n'
    + 'Environment="((?:\\\\.|[^"])*)"\\nEnvironment="((?:\\\\.|[^"])*)"\\n'
    + 'Environment="DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus"\\nEnvironment="XDG_RUNTIME_DIR=%t"\\n'
    + 'ExecStart="((?:\\\\.|[^"])*)" --disable-warning=ExperimentalWarning "((?:\\\\.|[^"])*)" --profile '
    + escapedProfile + ' --no-open\\n'
    + '# A deliberate systemctl user stop remains stopped, while every process\\n'
    + '# exit \\(including a clean but unintended Host exit\\) is restarted\\.  Disabling\\n'
    + "# systemd's start-rate limiter keeps a long-lived personal assistant from\\n"
    + '# becoming permanently inactive after a transient dependency outage\\.\\n'
    + 'Restart=always\\nRestartSec=5\\nTimeoutStopSec=30\\nKillSignal=SIGINT\\nUMask=0077\\n\\n'
    + '\\[Install\\]\\nWantedBy=default\\.target\\n$', 'u',
  )
}

async function snapshotServiceFile(path, expectedSource) {
  const lexicalParent = await lstat(dirname(path))
  if (!lexicalParent.isDirectory() || lexicalParent.isSymbolicLink() || lexicalParent.uid !== currentUid()
    || isGroupOrOtherWritable(lexicalParent)) fail(`systemd service 目录身份或权限不安全：${dirname(path)}`)
  const canonicalPath = await realpath(path)
  const parentPath = dirname(canonicalPath)
  const ancestorChain = captureAncestorChain(parentPath)
  const parentBefore = await lstat(parentPath)
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink() || parentBefore.uid !== currentUid()
    || isGroupOrOtherWritable(parentBefore)) fail(`systemd service 目录身份或权限不安全：${parentPath}`)
  const descriptor = openSync(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const entry = fstatSync(descriptor)
    const linked = await lstat(canonicalPath)
    const parentAfter = await lstat(parentPath)
    if (!entry.isFile() || entry.uid !== currentUid() || entry.nlink !== 1 || isGroupOrOtherWritable(entry) || entry.size > 1024 * 1024) {
      fail(`systemd service 文件身份或权限不安全：${path}`)
    }
    if (!sameServiceFileIdentity(linked, identity(entry))
      || !sameIdentity(parentAfter, identity(parentBefore))) fail(`systemd service 文件或目录身份不稳定：${path}`)
    const source = await readFile(`/proc/self/fd/${descriptor}`, 'utf8')
    if (expectedSource !== undefined && source !== expectedSource) fail(`systemd service drop-in 内容不受支持：${path}`)
    return {
      path: canonicalPath, identity: identity(entry), parentPath, parentIdentity: identity(parentBefore),
      ancestorChain, sha256: sha256(source), source,
    }
  } finally { closeSync(descriptor) }
}

async function inspectServiceUnit(systemctlExecutable, unit, dshExecutable) {
  const match = SYSTEMD_UNIT.exec(unit)
  if (match === null) fail(`非法 DSH systemd unit：${unit}`)
  const shown = parseSystemdShow((await runServiceCommand(systemctlExecutable, [
    '--user', 'show', unit, '--no-pager', ...SYSTEMD_SHOW_PROPERTIES.map(property => `--property=${property}`),
  ])).stdout, unit)
  if (shown.Id !== unit || shown.LoadState !== 'loaded' || shown.UnitFileState === '') fail(`systemd unit 未加载或身份不匹配：${unit}`)
  const fragment = await snapshotServiceFile(shown.FragmentPath)
  const expectedUnitDirectory = await canonicalMissingAllowed(join(process.env.HOME ?? '', '.config', 'systemd', 'user'))
  if (fragment.path !== join(expectedUnitDirectory, unit)) fail(`systemd unit fragment 不属于当前用户安装目录：${unit}`)
  const parsed = rendererUnitPattern(match[1]).exec(fragment.source)
  if (parsed === null) fail(`systemd unit 不是 installer renderer 的精确输出：${unit}`)
  const workingDirectory = parsed[1].replaceAll('%%', '%').replace(/\/$/u, '')
  const dshEnvironment = decodeUnitQuoted(parsed[2], 'DSH_HOME')
  const pathEnvironment = decodeUnitQuoted(parsed[3], 'PATH')
  const nodePath = decodeUnitQuoted(parsed[4], 'node path')
  const dshPath = decodeUnitQuoted(parsed[5], 'dsh path')
  if (!dshEnvironment.startsWith('DSH_HOME=') || !pathEnvironment.startsWith('PATH=')
    || !isAbsolute(nodePath) || !isAbsolute(dshPath)) fail(`systemd unit renderer 字段无效：${unit}`)
  if (pathEnvironment.slice('PATH='.length).split(':').some(path => !isAbsolute(path))
    || await realpath(dshPath).catch(() => '') !== dshExecutable
    || await realpath(nodePath).catch(() => '') === '') fail(`systemd unit executable/PATH 与当前运行时不匹配：${unit}`)
  const serviceHome = await canonicalMissingAllowed(dshEnvironment.slice('DSH_HOME='.length))
  const expectedWorkingDirectory = join(serviceHome, 'profiles', match[1])
  if (await canonicalMissingAllowed(workingDirectory) !== expectedWorkingDirectory || shown.WorkingDirectory !== workingDirectory) {
    fail(`systemd unit WorkingDirectory 与 profile 不匹配：${unit}`)
  }
  const shownEnvironment = shown.Environment.split(' ')
  if (shownEnvironment.length !== 4
    || shownEnvironment.filter(value => value.startsWith('DSH_HOME=')).length !== 1
    || shownEnvironment.filter(value => value.startsWith('PATH=')).length !== 1
    || !shownEnvironment.includes(`DSH_HOME=${dshEnvironment.slice('DSH_HOME='.length)}`)
    || !shownEnvironment.includes(pathEnvironment)
    || !shownEnvironment.includes('DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/' + currentUid() + '/bus')
    || !shownEnvironment.includes('XDG_RUNTIME_DIR=/run/user/' + currentUid())) {
    fail(`systemd unit Environment 与 fragment 不一致：${unit}`)
  }
  const expectedExecPrefix = `{ path=${nodePath} ; argv[]=${nodePath} --disable-warning=ExperimentalWarning ${dshPath} --profile ${match[1]} --no-open ; ignore_errors=no ;`
  if (!shown.ExecStart.startsWith(expectedExecPrefix) || !shown.ExecStart.endsWith(' }')
    || shown.ExecStart.split('{ path=').length !== 2) {
    fail(`systemd unit ExecStart 与 fragment 不一致：${unit}`)
  }
  const dropIns = []
  for (const path of shown.DropInPaths.split(' ').filter(Boolean)) {
    if (await realpath(path).catch(() => '') !== await realpath(`${shown.FragmentPath}.d/keyring.conf`).catch(() => '__missing__')) {
      fail(`systemd unit 包含未知 drop-in：${unit}:${path}`)
    }
    const snapshot = await snapshotServiceFile(path, KEYRING_DROP_IN)
    dropIns.push({
      path: snapshot.path, identity: snapshot.identity, parentPath: snapshot.parentPath,
      parentIdentity: snapshot.parentIdentity, ancestorChain: snapshot.ancestorChain, sha256: snapshot.sha256,
    })
  }
  const mainPid = Number(shown.MainPID)
  const controlPid = Number(shown.ControlPID)
  const nRestarts = Number(shown.NRestarts)
  if (!Number.isSafeInteger(mainPid) || mainPid < 0 || !Number.isSafeInteger(controlPid) || controlPid < 0
    || !Number.isSafeInteger(nRestarts) || nRestarts < 0) {
    fail(`systemd unit PID/restart 状态无效：${unit}`)
  }
  const stableActive = shown.ActiveState === 'active' && shown.SubState === 'running'
    && mainPid > 0 && controlPid === 0 && shown.InvocationID !== ''
  const stableInactive = shown.ActiveState === 'inactive' && shown.SubState === 'dead' && mainPid === 0 && controlPid === 0
  if (!stableActive && !stableInactive) fail(`systemd unit 不在稳定 active/running 或 inactive/dead 状态：${unit}`)
  if (!['enabled', 'disabled'].includes(shown.UnitFileState)) {
    fail(`systemd unit file state 不受支持：${unit}:${shown.UnitFileState}`)
  }
  return {
    unit, profile: match[1], serviceHome, fragment: {
      path: fragment.path, identity: fragment.identity, parentPath: fragment.parentPath,
      parentIdentity: fragment.parentIdentity, ancestorChain: fragment.ancestorChain, sha256: fragment.sha256,
    },
    dropIns, wasActive: shown.ActiveState === 'active', activeState: shown.ActiveState, subState: shown.SubState,
    mainPid, controlPid, invocationId: shown.InvocationID, nRestarts, unitFileState: shown.UnitFileState, nodePath, dshPath, pathEnvironment,
  }
}

async function readRawServiceState(systemctlExecutable, unit) {
  const shown = parseSystemdShow((await runServiceCommand(systemctlExecutable, [
    '--user', 'show', unit, '--no-pager', ...SYSTEMD_SHOW_PROPERTIES.map(property => `--property=${property}`),
  ])).stdout, unit)
  const mainPid = Number(shown.MainPID)
  const controlPid = Number(shown.ControlPID)
  const nRestarts = Number(shown.NRestarts)
  if (!Number.isSafeInteger(mainPid) || mainPid < 0 || !Number.isSafeInteger(controlPid) || controlPid < 0
    || !Number.isSafeInteger(nRestarts) || nRestarts < 0) {
    fail(`systemd unit PID 状态无效：${unit}`)
  }
  return {
    unit, loadState: shown.LoadState, unitFileState: shown.UnitFileState,
    activeState: shown.ActiveState, subState: shown.SubState, mainPid, controlPid,
    invocationId: shown.InvocationID, nRestarts, environment: shown.Environment, workingDirectory: shown.WorkingDirectory,
  }
}

async function listedServiceUnits(systemctlExecutable) {
  const commands = [
    ['--user', 'list-unit-files', '--type=service', '--no-legend', '--no-pager', 'dsh-profile-*.service'],
    ['--user', 'list-units', '--all', '--type=service', '--plain', '--no-legend', '--no-pager', 'dsh-profile-*.service'],
  ]
  const names = []
  for (const args of commands) {
    const listed = await runServiceCommand(systemctlExecutable, args)
    names.push(...listed.stdout.split('\n').map(line => line.trim().split(/\s+/u)[0]).filter(name => SYSTEMD_UNIT.test(name)))
  }
  return [...new Set(names)].sort()
}

async function assertUnitUniverseStable(systemctlExecutable, unitUniverse) {
  const current = await listedServiceUnits(systemctlExecutable)
  if (JSON.stringify(current) !== JSON.stringify(unitUniverse)) {
    fail('systemd DSH unit inventory 在事务期间发生变化。')
  }
}

async function captureServiceInventory(systemctlExecutable, homePath, targetProfile, dshExecutable) {
  await runServiceCommand(systemctlExecutable, ['--user', 'daemon-reload'])
  const names = await listedServiceUnits(systemctlExecutable)
  const services = []
  for (const unit of names) {
    const inspected = await inspectServiceUnit(systemctlExecutable, unit, dshExecutable)
    if (inspected.serviceHome === homePath) services.push(inspected)
  }
  const targetUnit = `dsh-profile-${targetProfile}.service`
  const target = services.find(service => service.unit === targetUnit)
  if (target === undefined) fail(`Lark upgrade 需要由 installer 管理的目标 unit：${targetUnit}`)
  return { services, unitUniverse: names }
}

function sameServiceFileIdentity(actual, expected) {
  return actual.isFile() && !actual.isSymbolicLink()
    && String(actual.dev) === expected.dev && String(actual.ino) === expected.ino
    && actual.uid === expected.uid && actual.mode === expected.mode && actual.nlink === 1
}

async function assertServiceFilesUnchanged(services) {
  for (const service of services) {
    for (const expected of [service.fragment, ...service.dropIns]) {
      const snapshot = await snapshotServiceFile(expected.path)
      const current = await lstat(expected.path)
      const parent = await lstat(expected.parentPath)
      if (snapshot.sha256 !== expected.sha256 || !sameServiceFileIdentity(current, expected.identity)
        || !sameIdentity(parent, expected.parentIdentity)) {
        fail(`systemd service 文件在操作期间发生变化：${expected.path}`)
      }
      if (JSON.stringify(snapshot.ancestorChain) !== JSON.stringify(expected.ancestorChain)) {
        fail(`systemd service 目录链在操作期间发生变化：${expected.path}`)
      }
    }
  }
}

async function readServiceStates(systemctlExecutable, services, homePath, dshExecutable) {
  const result = []
  for (const expected of services) {
    const current = await inspectServiceUnit(systemctlExecutable, expected.unit, dshExecutable)
    if (current.serviceHome === homePath) result.push(current)
  }
  return result
}

function serviceMaskPath(unit) {
  return join(process.env.HOME ?? '', '.config', 'systemd', 'user.control', unit)
}

async function prepareBoundMasks(transactionRoot, units, kind) {
  const root = join(transactionRoot, 'service-mask-staging', kind)
  await mkdir(root, { recursive: true, mode: 0o700 })
  await assertOwnedPrivateDirectory(root)
  const records = []
  for (const unit of units) {
    const stagingPath = join(root, unit)
    await symlink('/dev/null', stagingPath)
    const entry = await lstat(stagingPath)
    if (!entry.isSymbolicLink() || entry.uid !== currentUid() || entry.nlink !== 1
      || await readlink(stagingPath) !== '/dev/null') fail(`systemd lifecycle mask 身份不安全：${stagingPath}`)
    records.push({ unit, path: serviceMaskPath(unit), stagingPath, transactionRoot, target: '/dev/null', identity: identity(entry) })
  }
  await fsyncPath(root, true)
  return records
}

async function newBoundMaskIntent(transactionRoot, unit, kind, unitFileState) {
  const [barrier] = await prepareServiceStartBarriers(transactionRoot, [{ unit, unitFileState }])
  return {
    unit, path: serviceMaskPath(unit),
    stagingPath: join(transactionRoot, 'service-mask-staging', kind, unit),
    transactionRoot, target: '/dev/null', barrier,
  }
}

async function materializeMaskIntent(intent) {
  await mkdir(dirname(intent.stagingPath), { recursive: true, mode: 0o700 })
  await assertOwnedPrivateDirectory(dirname(intent.stagingPath))
  let entry = await lstat(intent.stagingPath).catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
  if (entry === undefined) {
    await symlink(intent.target, intent.stagingPath)
    entry = await lstat(intent.stagingPath)
  }
  if (!entry.isSymbolicLink() || entry.uid !== currentUid() || entry.nlink !== 1
    || await readlink(intent.stagingPath) !== intent.target) {
    throw new ServiceMaskConflictError(`systemd containment mask intent 身份不安全：${intent.stagingPath}`)
  }
  await fsyncPath(dirname(intent.stagingPath), true)
  return { ...intent, identity: identity(entry) }
}

async function boundMaskLocation(mask) {
  const destination = await lstat(mask.path).catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
  if (destination !== undefined) {
    if (!sameSymlinkIdentity(destination, mask.identity) || await readlink(mask.path) !== mask.target) {
      throw new ServiceMaskConflictError(`拒绝接管或移除身份不匹配的 systemd lifecycle mask：${mask.path}`)
    }
    return 'installed'
  }
  const staged = await lstat(mask.stagingPath).catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
  if (staged !== undefined) {
    if (!sameSymlinkIdentity(staged, mask.identity) || await readlink(mask.stagingPath) !== mask.target) {
      throw new ServiceMaskConflictError(`systemd lifecycle staging mask 身份不匹配：${mask.stagingPath}`)
    }
    return 'staged'
  }
  return 'missing'
}

async function moveBoundSymlinkNoReplace(source, destination, expectedIdentity, expectedTarget) {
  const before = await lstat(source).catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
  if (before === undefined || !sameSymlinkIdentity(before, expectedIdentity)
    || await readlink(source) !== expectedTarget) fail(`绑定 symlink 源身份不匹配：${source}`)
  const helper = [
    'import ctypes, os, stat, sys',
    'source, destination, expected_dev, expected_ino, expected_uid, expected_target = sys.argv[1:]',
    'source_parent, source_name = os.path.split(source)',
    'destination_parent, destination_name = os.path.split(destination)',
    'source_fd = os.open(source_parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)',
    'destination_fd = os.open(destination_parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)',
    'try:',
    '  entry = os.stat(source_name, dir_fd=source_fd, follow_symlinks=False)',
    '  if not stat.S_ISLNK(entry.st_mode) or (entry.st_dev, entry.st_ino, entry.st_uid) != (int(expected_dev), int(expected_ino), int(expected_uid)): raise RuntimeError("source identity changed")',
    '  if os.readlink(source_name, dir_fd=source_fd) != expected_target: raise RuntimeError("source target changed")',
    '  libc = ctypes.CDLL(None, use_errno=True)',
    '  renameat2 = getattr(libc, "renameat2", None)',
    '  if renameat2 is None: raise RuntimeError("renameat2 unavailable")',
    '  if renameat2(source_fd, source_name.encode(), destination_fd, destination_name.encode(), 1) != 0: raise RuntimeError("renameat2 noreplace errno=%d" % ctypes.get_errno())',
    '  moved = os.stat(destination_name, dir_fd=destination_fd, follow_symlinks=False)',
    '  if (moved.st_dev, moved.st_ino, moved.st_uid) != (int(expected_dev), int(expected_ino), int(expected_uid)): raise RuntimeError("destination identity changed")',
    '  os.fsync(destination_fd)',
    '  if source_fd != destination_fd: os.fsync(source_fd)',
    'finally:',
    '  os.close(source_fd)',
    '  if destination_fd != source_fd: os.close(destination_fd)',
  ].join('\n')
  try {
    await run('/usr/bin/python3', ['-I', '-S', '-c', helper, source, destination, expectedIdentity.dev, expectedIdentity.ino,
      String(expectedIdentity.uid), expectedTarget], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, capture: true, timeoutMs: 30_000, passFds: [3],
    })
  } catch (error) {
    throw new ServiceMaskConflictError(`无法无覆盖地移动 systemd 绑定 symlink ${source} -> ${destination}：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function installBoundMasks(systemctlExecutable, masks) {
  if (masks.length === 0) return
  const controlRoot = dirname(masks[0].path)
  await assertOwnedPrivateDirectory(dirname(controlRoot))
  if (await existingIdentity(controlRoot) === undefined) await mkdir(controlRoot, { mode: 0o700 })
  await assertOwnedPrivateDirectory(controlRoot)
  for (const mask of masks) {
    const location = await boundMaskLocation(mask)
    if (location === 'missing') fail(`绑定的 systemd lifecycle mask 已丢失：${mask.path}`)
    if (location === 'staged') await moveBoundSymlinkNoReplace(mask.stagingPath, mask.path, mask.identity, mask.target)
    const installed = await lstat(mask.path)
    if (!sameSymlinkIdentity(installed, mask.identity) || await readlink(mask.path) !== mask.target) {
      fail(`systemd lifecycle mask 安装后身份不匹配：${mask.path}`)
    }
  }
  await fsyncPath(controlRoot, true)
  await runServiceCommand(systemctlExecutable, ['--user', 'daemon-reload'])
}

async function stageBoundMasks(systemctlExecutable, masks) {
  if (masks.length === 0) return
  const controlRoot = dirname(masks[0].path)
  await assertOwnedPrivateDirectory(controlRoot)
  for (const mask of masks) {
    const location = await boundMaskLocation(mask)
    if (location === 'missing') fail(`绑定的 systemd lifecycle mask 已丢失：${mask.path}`)
    if (location === 'installed') {
      if (await existingIdentity(mask.stagingPath) !== undefined) fail(`systemd lifecycle staging path 已被占用：${mask.stagingPath}`)
      await moveBoundSymlinkNoReplace(mask.path, mask.stagingPath, mask.identity, mask.target)
    }
  }
  await fsyncPath(controlRoot, true)
  await fsyncPath(dirname(masks[0].stagingPath), true)
  await runServiceCommand(systemctlExecutable, ['--user', 'daemon-reload'])
}

async function prepareServiceStartBarriers(transactionRoot, services) {
  const root = join(transactionRoot, 'service-enablement')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const barriers = []
  for (const service of services) {
    let enablement
    if (service.unitFileState === 'enabled') {
      const path = join(process.env.HOME ?? '', '.config', 'systemd', 'user', 'default.target.wants', service.unit)
      const entry = await lstat(path).catch(() => undefined)
      if (entry === undefined || !entry.isSymbolicLink() || entry.uid !== currentUid() || entry.nlink !== 1) {
        fail(`enabled systemd unit 缺少受当前用户拥有的 enablement link：${service.unit}`)
      }
      enablement = {
        path, stagingPath: join(root, service.unit), transactionRoot, target: await readlink(path), identity: identity(entry),
      }
    }
    barriers.push({
      unit: service.unit, originalUnitFileState: service.unitFileState, disableIntentAt: new Date().toISOString(), enablement,
    })
  }
  return barriers
}

async function boundEnablementLocation(enablement) {
  for (const [label, path] of [['installed', enablement.path], ['staged', enablement.stagingPath]]) {
    const entry = await lstat(path).catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
    if (entry === undefined) continue
    if (!sameSymlinkIdentity(entry, enablement.identity) || await readlink(path) !== enablement.target) {
      throw new ServiceMaskConflictError(`systemd enablement link 身份不匹配：${path}`)
    }
    return label
  }
  return 'missing'
}

async function establishServiceStartBarriers(systemctlExecutable, barriers) {
  for (const barrier of barriers) {
    if (barrier.originalUnitFileState === 'enabled') {
      const location = await boundEnablementLocation(barrier.enablement)
      if (location === 'missing') fail(`绑定的 systemd enablement link 已丢失：${barrier.unit}`)
      if (location === 'installed') await moveBoundSymlinkNoReplace(
        barrier.enablement.path, barrier.enablement.stagingPath, barrier.enablement.identity, barrier.enablement.target,
      )
    } else if (barrier.originalUnitFileState !== 'disabled') {
      fail(`不支持为 ${barrier.originalUnitFileState} unit 建立 crash-safe start barrier：${barrier.unit}`)
    }
  }
  await runServiceCommand(systemctlExecutable, ['--user', 'daemon-reload'])
  for (const barrier of barriers) {
    const state = await readRawServiceState(systemctlExecutable, barrier.unit)
    if (barrier.originalUnitFileState === 'enabled') {
      if (await boundEnablementLocation(barrier.enablement) !== 'staged') {
        fail(`systemd service enablement link 未进入持久 start barrier：${barrier.unit}`)
      }
      if (!['disabled', 'masked'].includes(state.unitFileState) && state.loadState !== 'masked') {
        fail(`systemd service 未反映持久 start barrier 或 lifecycle mask：${barrier.unit}`)
      }
    } else if (state.unitFileState !== 'disabled' && state.loadState !== 'masked') {
      fail(`systemd disabled service 在 start barrier 后状态漂移：${barrier.unit}`)
    }
  }
}

async function ensureServiceStartBarriers(systemctlExecutable, barriers) {
  const toDisable = []
  for (const barrier of barriers) {
    if (barrier.originalUnitFileState === 'enabled') {
      const location = await boundEnablementLocation(barrier.enablement)
      if (location === 'staged') continue
      if (location === 'installed') { toDisable.push(barrier); continue }
      fail(`绑定的 systemd enablement link 已丢失：${barrier.unit}`)
    }
    const state = await readRawServiceState(systemctlExecutable, barrier.unit)
    if (barrier.originalUnitFileState === 'disabled' && ['disabled', 'masked'].includes(state.unitFileState)) continue
    if (state.unitFileState !== barrier.originalUnitFileState) {
      fail(`systemd service start barrier 状态不匹配：${barrier.unit}:${state.unitFileState}`)
    }
    toDisable.push(barrier)
  }
  if (toDisable.length > 0) await establishServiceStartBarriers(systemctlExecutable, toDisable)
}

async function restoreServiceEnablement(systemctlExecutable, barriers) {
  for (const barrier of barriers) {
    if (barrier.originalUnitFileState === 'enabled') {
      const location = await boundEnablementLocation(barrier.enablement)
      if (location === 'missing') fail(`绑定的 systemd enablement link 已丢失：${barrier.unit}`)
      if (location === 'staged') await moveBoundSymlinkNoReplace(
        barrier.enablement.stagingPath, barrier.enablement.path, barrier.enablement.identity, barrier.enablement.target,
      )
    } else {
      const current = await readRawServiceState(systemctlExecutable, barrier.unit)
      if (current.unitFileState !== 'disabled') fail(`systemd disabled service 状态在事务中漂移：${barrier.unit}`)
    }
  }
  await runServiceCommand(systemctlExecutable, ['--user', 'daemon-reload'])
  for (const barrier of barriers) {
    const state = await readRawServiceState(systemctlExecutable, barrier.unit)
    if (barrier.originalUnitFileState === 'enabled'
      && await boundEnablementLocation(barrier.enablement) !== 'installed') {
      fail(`systemd service enablement link 未恢复绑定：${barrier.unit}`)
    }
    if (state.unitFileState !== barrier.originalUnitFileState) {
      fail(`systemd service enablement 未恢复原状态：${barrier.unit}`)
    }
  }
}

async function assertMaskedAndQuiescent({
  systemctlExecutable, services, serviceMasks, homePath, unitUniverse, equivalentHomePaths = [],
}) {
  await assertServiceFilesUnchanged(services)
  await assertUnitUniverseStable(systemctlExecutable, unitUniverse)
  for (const service of services) {
    const mask = serviceMasks.find(candidate => candidate.unit === service.unit)
    if (mask === undefined || await boundMaskLocation(mask) !== 'installed') {
      fail(`systemd service 缺少已绑定 lifecycle mask：${service.unit}`)
    }
    const state = await readRawServiceState(systemctlExecutable, service.unit)
    if (state.loadState !== 'masked') {
      fail(`systemd service 未保持 runtime mask：${service.unit}`)
    }
    if (state.activeState !== 'inactive' || state.subState !== 'dead' || state.mainPid !== 0 || state.controlPid !== 0) {
      fail(`systemd service 未保持 inactive/dead/PID0：${service.unit}`)
    }
  }
  await assertNoUnmanagedHomeProcesses(homePath, equivalentHomePaths)
  assertLockParentStable(homePath)
}

async function stopServicesAndWait(
  systemctlExecutable, services, masks, homePath, dshExecutable, unitUniverse, timeoutMilliseconds,
) {
  const names = services.map(service => service.unit)
  await installBoundMasks(systemctlExecutable, masks)
  if (names.length > 0) {
    try { await runServiceCommand(systemctlExecutable, ['--user', 'stop', ...names]) }
    catch (error) {
      fail(`systemd service stop 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const deadline = Date.now() + timeoutMilliseconds
  for (;;) {
    await assertServiceFilesUnchanged(services)
    const states = await Promise.all(services.map(service => readRawServiceState(systemctlExecutable, service.unit)))
    if (states.every(service => service.activeState === 'inactive'
    && service.subState === 'dead' && service.mainPid === 0 && service.controlPid === 0)) {
      await assertMaskedAndQuiescent({ systemctlExecutable, services, serviceMasks: masks, homePath, dshExecutable, unitUniverse })
      return states
    }
    if (Date.now() >= deadline) fail('systemd services 未在超时内停止为 inactive/dead/MainPID=0。')
    await delay(deadline - Date.now())
  }
}

async function stopRelatedServices(
  systemctlExecutable, services, homePath, dshExecutable, unitUniverse, timeoutMilliseconds, transactionRoot, manifest,
) {
  for (const intent of manifest.containmentMaskIntents) {
    manifest = await withCrashStopGuardian(systemctlExecutable, [intent.unit], randomUUID(), async () => {
      const raw = await readRawServiceState(systemctlExecutable, intent.unit)
      const homes = (raw.environment ?? '').split(' ').filter(value => value.startsWith('DSH_HOME='))
      const candidate = homes.length === 1 ? homes[0].slice('DSH_HOME='.length) : undefined
      const environmentMatches = candidate !== undefined && isAbsolute(candidate)
        && await canonicalMissingAllowed(candidate) === homePath
      const workingMatches = isAbsolute(raw.workingDirectory ?? '')
        && inside(homePath, await canonicalMissingAllowed(raw.workingDirectory))
      if (!environmentMatches && !workingMatches) {
        fail(`已持久化 containment intent 的 unit 不再属于当前 DSH_HOME；拒绝修改：${intent.unit}`)
      }
      await ensureServiceStartBarriers(systemctlExecutable, [intent.barrier])
      const mask = await materializeMaskIntent(intent)
      manifest = await writeManifest(transactionRoot, {
        ...manifest, containmentMaskIntents: manifest.containmentMaskIntents.filter(candidate => candidate.unit !== intent.unit),
        containmentMasks: [...manifest.containmentMasks, mask],
        containmentStartBarriers: [...manifest.containmentStartBarriers, intent.barrier],
      }, manifest.state)
      await installBoundMasks(systemctlExecutable, [mask])
      await runServiceCommand(systemctlExecutable, ['--user', 'stop', intent.unit])
      return manifest
    }, false, homePath)
  }
  const combined = new Map(services.map(service => [service.unit, service]))
  const containedUnits = new Set(manifest.containmentMasks.map(mask => mask.unit))
  await installBoundMasks(systemctlExecutable, [...manifest.serviceMasks, ...manifest.containmentMasks])
  await ensureServiceStartBarriers(systemctlExecutable, manifest.serviceStartBarriers)
  const currentUniverse = await listedServiceUnits(systemctlExecutable)
  const additionalUnits = [...containedUnits].filter(unit => currentUniverse.includes(unit))
  if (services.length > 0) {
    await runServiceCommand(systemctlExecutable, ['--user', 'stop', ...services.map(service => service.unit)])
  }
  if (additionalUnits.length > 0) {
    await runServiceCommand(systemctlExecutable, ['--user', 'stop', ...additionalUnits])
  }
  for (const unit of currentUniverse) {
    if (combined.has(unit) || containedUnits.has(unit)) continue
    // This unit is only a candidate until the ownership query below proves it
    // belongs to this DSH_HOME.  Do not seed it into the guardian's trusted
    // set: if the parent dies during classification, the guardian must apply
    // its own fresh ownership census rather than stopping a foreign unit.
    const classified = await withCrashStopGuardian(systemctlExecutable, [], randomUUID(), async () => {
      const raw = await readRawServiceState(systemctlExecutable, unit)
      const homes = (raw.environment ?? '').split(' ').filter(value => value.startsWith('DSH_HOME='))
      const candidate = homes.length === 1 ? homes[0].slice('DSH_HOME='.length) : undefined
      const environmentMatches = candidate !== undefined && isAbsolute(candidate)
        && await canonicalMissingAllowed(candidate) === homePath
      const workingMatches = isAbsolute(raw.workingDirectory ?? '')
        && inside(homePath, await canonicalMissingAllowed(raw.workingDirectory))
      if (environmentMatches || workingMatches) {
        if (!manifest.containmentMasks.some(mask => mask.unit === unit)) {
          if (!['enabled', 'disabled'].includes(raw.unitFileState)) {
            fail(`新增同-home unit 的 enablement 状态不受支持：${unit}:${raw.unitFileState}`)
          }
          const intent = await newBoundMaskIntent(transactionRoot, unit, 'containment', raw.unitFileState)
          manifest = await writeManifest(transactionRoot, {
            ...manifest, containmentMaskIntents: [...manifest.containmentMaskIntents, intent],
          }, manifest.state)
          await establishServiceStartBarriers(systemctlExecutable, [intent.barrier])
          const mask = await materializeMaskIntent(intent)
          manifest = await writeManifest(transactionRoot, {
            ...manifest, containmentMaskIntents: manifest.containmentMaskIntents.filter(candidate => candidate.unit !== unit),
            containmentMasks: [...manifest.containmentMasks, mask],
            containmentStartBarriers: [...manifest.containmentStartBarriers, intent.barrier],
          }, manifest.state)
        }
        await installBoundMasks(systemctlExecutable, manifest.containmentMasks.filter(mask => mask.unit === unit))
        await runServiceCommand(systemctlExecutable, ['--user', 'stop', unit])
        return { matched: true, manifest }
      }
      return { matched: false, manifest }
    }, false, homePath)
    manifest = classified.manifest
    if (classified.matched) {
      additionalUnits.push(unit)
      containedUnits.add(unit)
    }
  }
  await stopServicesAndWait(
    systemctlExecutable, services, manifest.serviceMasks, homePath, dshExecutable, currentUniverse, timeoutMilliseconds,
  )
  const deadline = Date.now() + timeoutMilliseconds
  for (;;) {
    const states = await Promise.all(additionalUnits.map(unit => readRawServiceState(systemctlExecutable, unit)))
    if (states.every(service => service.activeState === 'inactive' && service.subState === 'dead'
      && service.mainPid === 0 && service.controlPid === 0
      && service.loadState === 'masked')) break
    if (Date.now() >= deadline) fail('新增同-home systemd services 未能可靠停止。')
    await delay(deadline - Date.now())
  }
  if (JSON.stringify(currentUniverse) !== JSON.stringify(unitUniverse)) {
    fail('systemd DSH unit inventory 在失败收容期间发生变化；已停止并继续 mask 可证明相关的 services。')
  }
  return manifest
}

async function journalHasReadyMarker(journalctlExecutable, service) {
  const result = await runServiceCommand(journalctlExecutable, [
    '--user', '--unit', service.unit, `_SYSTEMD_INVOCATION_ID=${service.invocationId}`, '--output=cat', '--no-pager',
  ])
  return result.stdout.split('\n').some(line => line.includes(READY_MARKER))
}

async function startAndAcceptServices({
  systemctlExecutable, journalctlExecutable, services, serviceMasks,
  homePath, targetProfile, unitUniverse, timeouts,
}) {
  const activeBefore = services.filter(service => service.wasActive)
  const activeMasks = activeBefore.map(service => {
    const mask = serviceMasks.find(candidate => candidate.unit === service.unit)
    if (mask === undefined) fail(`service start 缺少绑定 mask：${service.unit}`)
    return mask
  })
  await stageBoundMasks(systemctlExecutable, activeMasks)
  const unitNames = activeBefore.map(service => service.unit)
  let accepted
  const result = await withCrashStopGuardian(systemctlExecutable, unitNames, randomUUID(), async () => {
    const deadline = Date.now() + timeouts.ready
    for (;;) {
      await assertUnitUniverseStable(systemctlExecutable, unitUniverse)
      await assertServiceFilesUnchanged(services)
      const current = await Promise.all(activeBefore.map(async previous => ({
        ...previous, ...await readRawServiceState(systemctlExecutable, previous.unit),
      })))
      const byUnit = new Map(current.map(service => [service.unit, service]))
      const candidates = activeBefore.map(previous => ({ previous, current: byUnit.get(previous.unit) }))
      let inactiveReady = true
      for (const previous of services.filter(service => !service.wasActive)) {
        const service = await readRawServiceState(systemctlExecutable, previous.unit)
        inactiveReady &&= service.activeState === 'inactive' && service.subState === 'dead'
          && service.mainPid === 0 && service.controlPid === 0
          && service.loadState === 'masked'
      }
      const systemdReady = candidates.every(({ previous, current: service }) => service !== undefined
        && service.activeState === 'active' && service.subState === 'running' && service.mainPid > 0
        && service.controlPid === 0 && service.invocationId !== '' && service.invocationId !== previous.invocationId) && inactiveReady
      if (systemdReady) {
        let logsReady = true
        for (const candidate of candidates) {
          if (!await journalHasReadyMarker(journalctlExecutable, candidate.current)) { logsReady = false; break }
        }
        if (logsReady) { accepted = candidates.map(({ current }) => current); break }
      }
      if (Date.now() >= deadline) fail('systemd services 未在超时内产生 fresh InvocationID Host ready marker。')
      await delay(deadline - Date.now())
    }
    const targetBefore = services.find(service => service.profile === targetProfile)
    if (targetBefore === undefined || targetBefore.wasActive && !accepted.some(service => service.profile === targetProfile)) {
      fail('目标 Lark service 未通过 readiness。')
    }
    if (timeouts.stability > 0) await new Promise(resolveDelay => setTimeout(resolveDelay, timeouts.stability))
    await assertUnitUniverseStable(systemctlExecutable, unitUniverse)
    const stable = await Promise.all(activeBefore.map(async previous => ({
      ...previous, ...await readRawServiceState(systemctlExecutable, previous.unit),
    })))
    const stableByUnit = new Map(stable.map(service => [service.unit, service]))
    for (const acceptedService of accepted) {
      const service = stableByUnit.get(acceptedService.unit)
      if (service === undefined || service.activeState !== 'active' || service.subState !== 'running' || service.mainPid <= 0
        || service.invocationId !== acceptedService.invocationId || service.nRestarts !== acceptedService.nRestarts) {
        fail(`systemd service 未通过稳定性验证：${acceptedService.unit}`)
      }
    }
    for (const inactiveService of services.filter(service => !service.wasActive)) {
      const state = await readRawServiceState(systemctlExecutable, inactiveService.unit)
      if (state.activeState !== 'inactive' || state.subState !== 'dead' || state.mainPid !== 0 || state.controlPid !== 0) {
        fail(`原 inactive service 被意外启动：${inactiveService.unit}`)
      }
    }
    await installBoundMasks(systemctlExecutable, activeMasks)
    return accepted
  }, true, homePath)
  return result
}

async function finalizeAcceptedServices({
  systemctlExecutable, dshExecutable, services, serviceMasks, containmentMasks, serviceStartBarriers,
  containmentStartBarriers,
  homePath, unitUniverse, acceptance,
}) {
  await stageBoundMasks(systemctlExecutable, serviceMasks)
  await stageBoundMasks(systemctlExecutable, containmentMasks)
  await restoreServiceEnablement(systemctlExecutable, serviceStartBarriers)
  await restoreServiceEnablement(systemctlExecutable, containmentStartBarriers)
  await assertAcceptedServicesStillBound({
    systemctlExecutable, dshExecutable, services, homePath, unitUniverse, acceptance,
  })
}

async function assertAcceptedServicesStillBound({
  systemctlExecutable, dshExecutable, services, homePath, unitUniverse, acceptance,
}) {
  await assertUnitUniverseStable(systemctlExecutable, unitUniverse)
  await assertServiceFilesUnchanged(services)
  const current = await readServiceStates(systemctlExecutable, services, homePath, dshExecutable)
  const byUnit = new Map(current.map(service => [service.unit, service]))
  const accepted = new Map(acceptance.map(service => [service.unit, service]))
  for (const original of services) {
    const service = byUnit.get(original.unit)
    if (service === undefined) fail(`systemd service inventory 在 cleanup 前发生变化：${original.unit}`)
    if (!original.wasActive) {
      if (service.activeState !== 'inactive' || service.subState !== 'dead' || service.mainPid !== 0 || service.controlPid !== 0) {
        fail(`原 inactive service 在 cleanup 前被启动：${original.unit}`)
      }
      continue
    }
    const proof = accepted.get(original.unit)
    if (proof === undefined || service.activeState !== 'active' || service.subState !== 'running'
      || service.mainPid !== proof.mainPid || service.invocationId !== proof.invocationId
      || service.nRestarts !== proof.nRestarts) fail(`systemd service acceptance 在 cleanup 前失效：${original.unit}`)
  }
}

async function removeCommittedTransaction({ physicalTransactionRoot, transactionRoot, manifest, backupHome }) {
  const transactionIdentity = await lstat(physicalTransactionRoot)
  const expectedTransactionIdentity = manifest.transactionIdentity
    ?? (manifest.version === MANIFEST_VERSION ? identity(transactionIdentity) : undefined)
  if (!sameIdentity(transactionIdentity, expectedTransactionIdentity)) {
    fail(`service-aware transaction root 身份不安全；拒绝清理：${transactionRoot}`)
  }
  assertLockParentStable(manifest.homePath)
  const cleanupDescriptor = openSync(physicalTransactionRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const cleanupFdPath = `/proc/self/fd/${cleanupDescriptor}`
  try {
    const cleanupIdentity = fstatSync(cleanupDescriptor)
    if (!sameIdentity(cleanupIdentity, expectedTransactionIdentity)) {
      fail(`service-aware transaction root fd 身份不匹配：${transactionRoot}`)
    }
    const anchoredBackup = join(cleanupFdPath, basename(backupHome))
    const backupIdentity = await existingIdentity(anchoredBackup)
    if (backupIdentity !== undefined) {
      if (!sameIdentity(backupIdentity, manifest.originalIdentity)) {
        fail(`service-aware original-home 身份不匹配；拒绝清理：${backupHome}`)
      }
      await assertProfileDigest(anchoredBackup, manifest.profile, manifest.originalProfileDigest)
    }
    await assertNoMounts(cleanupFdPath)
    const entries = await readdir(cleanupFdPath)
    if (!entries.includes('manifest.json')) {
      fail(`service-aware transaction root 在清理前缺少 manifest：${transactionRoot}`)
    }
    for (const entry of entries) {
      if (entry === 'manifest.json') continue
      await rm(join(cleanupFdPath, entry), { recursive: true })
    }
    await fsyncPath(cleanupFdPath, true)
    const cleanupBeforeManifest = fstatSync(cleanupDescriptor)
    if (!sameIdentity(cleanupBeforeManifest, expectedTransactionIdentity)) {
      fail(`service-aware transaction root 在 manifest 删除前发生替换：${transactionRoot}`)
    }
    await rm(join(cleanupFdPath, 'manifest.json'))
    await fsyncPath(cleanupFdPath, true)
  } finally {
    closeSync(cleanupDescriptor)
  }
  assertLockParentStable(manifest.homePath)
  const transactionBeforeRemove = await lstat(physicalTransactionRoot)
  if (!sameIdentity(transactionBeforeRemove, expectedTransactionIdentity)) {
    fail(`service-aware transaction root 在最终删除前发生替换：${transactionRoot}`)
  }
  await rmdir(physicalTransactionRoot)
  await fsyncPath(LOCK_PARENT_FD_PATH, true)
}

async function recoverServiceTransaction({
  manifest, homePath, physicalHomePath, profile, transactionRoot, physicalTransactionRoot, backupHome,
  homeStat, backupStat, homeIsOriginal, homeIsStaged, backupIsOriginal, serviceContext, dshExecutable,
}) {
  const services = manifest.services
  const serviceMasks = manifest.serviceMasks
  const serviceStartBarriers = manifest.serviceStartBarriers
  const unitUniverse = manifest.unitUniverse
  const timeouts = serviceTimeouts()
  if (services.length === 0 || services.some(service => typeof service?.unit !== 'string'
    || SYSTEMD_UNIT.exec(service.unit) === null || typeof service.wasActive !== 'boolean'
    || service.serviceHome !== homePath)) fail(`service-aware manifest 中的 inventory 无效：${transactionRoot}`)
  if (!Array.isArray(unitUniverse) || unitUniverse.some(unit => typeof unit !== 'string' || !SYSTEMD_UNIT.test(unit))) {
    fail(`service-aware manifest 中的 unit universe 无效：${transactionRoot}`)
  }
  const target = services.find(service => service.profile === profile)
  if (target === undefined) fail(`service-aware manifest 缺少目标 unit：${transactionRoot}`)
  await assertServiceFilesUnchanged(services)

  if (homeIsOriginal && backupStat === undefined) {
    await assertProfileDigest(physicalHomePath, profile, manifest.originalProfileDigest)
    manifest = await stopRelatedServices(serviceContext.systemctlExecutable, services, homePath, dshExecutable, unitUniverse, timeouts.stop, physicalTransactionRoot, manifest)
    await restoreOriginalActiveSet({
      ...serviceContext, dshExecutable, services, serviceMasks, serviceStartBarriers,
      containmentMasks: manifest.containmentMasks, containmentStartBarriers: manifest.containmentStartBarriers,
      homePath, targetProfile: profile, unitUniverse, timeouts,
    })
    const evidence = await moveTransactionAside(physicalTransactionRoot, transactionRoot, profile)
    await fsyncPath(LOCK_PARENT_FD_PATH, true)
    process.stderr.write(`service-aware 生命周期恢复：原 home 与 active service set 已恢复；证据保留在 ${evidence}\n`)
    return 'service-original-restored'
  }

  if (homeStat === undefined && backupIsOriginal) {
    await assertProfileDigest(backupHome, profile, manifest.originalProfileDigest)
    manifest = await stopRelatedServices(serviceContext.systemctlExecutable, services, homePath, dshExecutable, unitUniverse, timeouts.stop, physicalTransactionRoot, manifest)
    assertLockParentStable(homePath)
    await rename(backupHome, physicalHomePath)
    await fsyncPath(physicalTransactionRoot, true)
    await fsyncPath(LOCK_PARENT_FD_PATH, true)
    await restoreOriginalActiveSet({
      ...serviceContext, dshExecutable, services, serviceMasks, serviceStartBarriers,
      containmentMasks: manifest.containmentMasks, containmentStartBarriers: manifest.containmentStartBarriers,
      homePath, targetProfile: profile, unitUniverse, timeouts,
    })
    const evidence = await moveTransactionAside(physicalTransactionRoot, transactionRoot, profile)
    await fsyncPath(LOCK_PARENT_FD_PATH, true)
    process.stderr.write(`service-aware 生命周期恢复：original-renamed 崩溃已恢复原 home 与 active service set；证据保留在 ${evidence}\n`)
    return 'service-original-restored'
  }

  const cleanupWithoutBackup = homeIsStaged && backupStat === undefined && manifest.state === 'cleanup-started'
  if (homeIsStaged && (backupIsOriginal || cleanupWithoutBackup)) {
    await assertProfileDigest(physicalHomePath, profile, manifest.stagedProfileDigest)
    if (backupIsOriginal && manifest.state !== 'cleanup-started') {
      await assertProfileDigest(backupHome, profile, manifest.originalProfileDigest)
    }
    manifest = await stopRelatedServices(serviceContext.systemctlExecutable, services, homePath, dshExecutable, unitUniverse, timeouts.stop, physicalTransactionRoot, manifest)
    manifest = await writeManifest(physicalTransactionRoot, { ...manifest, servicePhase: 'starting' },
      cleanupWithoutBackup ? 'cleanup-started' : 'swapped')
    let accepted
    try {
      accepted = await startAndAcceptServices({ ...serviceContext, dshExecutable, services, serviceMasks, homePath, targetProfile: profile, unitUniverse, timeouts })
    } catch (error) {
      try {
        manifest = await stopRelatedServices(
          serviceContext.systemctlExecutable, services, homePath, dshExecutable, unitUniverse, timeouts.stop,
          physicalTransactionRoot, manifest,
        )
      } catch {}
      await writeManifest(physicalTransactionRoot, {
        ...manifest, servicePhase: 'service-failed', serviceFailure: error instanceof Error ? error.message : String(error),
      }, 'service-failed').catch(() => {})
      throw error
    }
    const acceptance = accepted.map(service => ({
      unit: service.unit, invocationId: service.invocationId, mainPid: service.mainPid, nRestarts: service.nRestarts,
    }))
    manifest = await writeManifest(physicalTransactionRoot, {
      ...manifest, servicePhase: 'service-accepted', serviceAcceptance: acceptance, serviceFailure: undefined,
    }, cleanupWithoutBackup ? 'cleanup-started' : 'service-accepted')
    await finalizeAcceptedServices({
      ...serviceContext, dshExecutable, services, serviceMasks, containmentMasks: manifest.containmentMasks,
      containmentStartBarriers: manifest.containmentStartBarriers,
      serviceStartBarriers, homePath, unitUniverse, acceptance,
    })
    manifest = await writeManifest(physicalTransactionRoot, manifest, 'cleanup-started')
    await removeCommittedTransaction({ physicalTransactionRoot, transactionRoot, manifest, backupHome })
    process.stdout.write('service-aware 生命周期恢复：swapped home 已重新验收并完成绑定清理。\n')
    return 'service-committed'
  }

  fail(`service-aware 生命周期 home/backup 身份未知；保留证据：${transactionRoot}`)
}

async function processAncestorIds() {
  const identifiers = new Set([process.pid])
  let current = process.pid
  for (;;) {
    let status
    try { status = await readFile(`/proc/${current}/status`, 'utf8') }
    catch { break }
    const parent = Number(/^PPid:\s+(\d+)/mu.exec(status)?.[1])
    if (!Number.isSafeInteger(parent) || parent <= 0 || identifiers.has(parent)) break
    identifiers.add(parent)
    current = parent
  }
  return identifiers
}

async function assertNoUnmanagedHomeProcesses(homePath, equivalentHomePaths = []) {
  const roots = [homePath, ...equivalentHomePaths]
  const weakReferenceExempt = await processAncestorIds()
  const proc = await opendir('/proc')
  for await (const entry of proc) {
    if (!/^\d+$/u.test(entry.name) || Number(entry.name) === process.pid) continue
    const processPath = join('/proc', entry.name)
    let status
    try { status = await readFile(join(processPath, 'status'), 'utf8') }
    catch (error) { if (error?.code === 'ENOENT') continue; fail(`无法检查当前用户进程 ${entry.name} 的状态。`) }
    const uid = /^Uid:\s+(\d+)/mu.exec(status)?.[1]
    if (uid !== String(currentUid())) continue
    if (/^State:\s+Z\b/mu.test(status)) continue
    let referenced = false
    if (!weakReferenceExempt.has(Number(entry.name))) {
      try {
        const command = (await readFile(join(processPath, 'cmdline'))).toString().split('\0').filter(Boolean)
        for (const value of command) {
          if (!isAbsolute(value)) continue
          const canonical = await canonicalMissingAllowed(value).catch(() => resolve(value))
          referenced ||= roots.some(root => inside(root, canonical))
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') fail(`无法检查当前用户进程 ${entry.name} 的命令行。`)
      }
      try {
        const environment = await readFile(join(processPath, 'environ'))
        for (const value of environment.toString().split('\0')) {
          if (!value.startsWith('DSH_HOME=')) continue
          const configured = value.slice('DSH_HOME='.length)
          if (isAbsolute(configured)) {
            const canonical = await canonicalMissingAllowed(configured)
            referenced ||= roots.some(root => canonical === root)
          }
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') fail(`无法确认当前用户进程 ${entry.name} 的环境。`)
      }
    }
    for (const name of ['cwd', 'root']) {
      try {
        const canonical = await realpath(join(processPath, name))
        referenced ||= roots.some(root => inside(root, canonical))
      }
      catch (error) { if (error?.code !== 'ENOENT') fail(`无法确认当前用户进程 ${entry.name} 的 ${name}。`) }
    }
    for (const directory of ['fd']) {
      try {
        const handles = await opendir(join(processPath, directory))
        for await (const handle of handles) {
          try {
            const canonical = await realpath(join(processPath, directory, handle.name))
            referenced ||= roots.some(root => inside(root, canonical))
          }
          catch (error) { if (error?.code !== 'ENOENT') fail(`无法确认当前用户进程 ${entry.name} 的 ${directory} 引用。`) }
        }
      } catch (error) { if (error?.code !== 'ENOENT') fail(`无法枚举当前用户进程 ${entry.name} 的 ${directory}。`) }
    }
    try {
      const maps = await readFile(join(processPath, 'maps'), 'utf8')
      for (const line of maps.split('\n')) {
        const mapped = /\s(\/.*)$/u.exec(line)?.[1]?.replace(/ \(deleted\)$/u, '')
        if (mapped === undefined) continue
        const canonical = await canonicalMissingAllowed(mapped).catch(() => resolve(mapped))
        referenced ||= roots.some(root => inside(root, canonical))
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') fail(`无法确认当前用户进程 ${entry.name} 的内存映射。`)
    }
    if (referenced) fail(`检测到 systemd inventory 之外的当前用户进程仍引用 DSH_HOME；拒绝继续：PID ${entry.name}`)
  }
}

async function assertNotSupervisedProfile({ dshExecutable, profile, homePath }) {
  const { scenario } = await readLifecycleConfig({ dshExecutable, profile, homePath })
  if (scenario === 'supervised') {
    fail('检测到 active supervised/recovery/automation 配置；缺少只读 generation/attestation API，拒绝 service-aware upgrade。')
  }
}

async function readLifecycleConfig({ dshExecutable, profile, homePath }) {
  const dumped = await run(dshExecutable, ['--profile', profile, '--dump-config'], {
    capture: true, env: { ...process.env, DSH_HOME: homePath },
  })
  return {
    source: dumped.stdout,
    scenario: await classifyLifecycleScenario(dumped.stdout, { dshExecutable }),
  }
}

async function assertLockedLifecycleScenario({ dshExecutable, profile, homePath, expectedScenario, serviceAware }) {
  const { scenario } = await readLifecycleConfig({ dshExecutable, profile, homePath })
  if (scenario === 'supervised') {
    fail('检测到实际 effective/composed profile 含 active supervised/recovery/automation markers；拒绝在 npm registry/store 或 systemd mutation 前继续。')
  }
  if (scenario === 'unsupported' && expectedScenario !== 'unsupported') {
    fail('实际 effective/composed profile 无法安全归类为 web、autonomy 或已启用 Lark；拒绝 lifecycle 操作。')
  }
  if (expectedScenario !== undefined && scenario !== expectedScenario) {
    fail(`声明的 lifecycle scenario ${expectedScenario} 与实际 effective/composed profile 场景 ${scenario} 不一致；拒绝 lifecycle 操作。`, 2)
  }
  if (serviceAware && scenario !== 'lark') {
    fail('service-aware lifecycle 要求实际 effective/composed profile 含 active Lark channel。')
  }
  if (!serviceAware && scenario === 'lark') {
    fail('检测到实际 effective/composed profile 含 active Lark channel；必须使用 service-aware lifecycle。')
  }
  return scenario
}

async function restoreOriginalActiveSet({
  systemctlExecutable, journalctlExecutable, dshExecutable, services, serviceMasks, serviceStartBarriers,
  containmentMasks = [], containmentStartBarriers = [],
  homePath, targetProfile, unitUniverse, timeouts,
}) {
  await assertServiceFilesUnchanged(services)
  const accepted = await startAndAcceptServices({
    systemctlExecutable, journalctlExecutable, dshExecutable, services, serviceMasks,
    homePath, targetProfile, unitUniverse, timeouts,
  })
  await finalizeAcceptedServices({
    systemctlExecutable, dshExecutable, services, serviceMasks, serviceStartBarriers,
    containmentMasks, containmentStartBarriers, homePath, unitUniverse, acceptance: accepted,
  })
  return accepted
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
  const scenario = await classifyLifecycleScenario(dumped.stdout, { dshExecutable: context.dshExecutable })
  if (scenario !== context.expectedScenario) {
    fail(`隔离副本 ${label} 的 lifecycle scenario ${scenario} 与预期 ${context.expectedScenario} 不一致；拒绝提交。`)
  }
  return scenario
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

function assertExpectedScenario(expectedScenario, serviceAware, operation = 'upgrade') {
  const emptyUninstall = !serviceAware && operation === 'uninstall' && expectedScenario === 'unsupported'
  if (!LIFECYCLE_SCENARIOS.has(expectedScenario) && !emptyUninstall) {
    fail('lifecycle expected scenario must be web, autonomy, or lark', 2)
  }
  if (serviceAware !== (expectedScenario === 'lark')) {
    fail(serviceAware
      ? 'service-aware lifecycle expected scenario must be lark'
      : 'ordinary lifecycle expected scenario must be web or autonomy', 2)
  }
}

async function performNpmUpgrade({
  profile, homePath, dshExecutable, bwrapExecutable, expectedScenario, npmExecutable, pnpmExecutable, selector,
}) {
  if (!PROFILE_NAME.test(profile) || !isAbsolute(homePath) || resolve(homePath) !== homePath) fail('invalid npm lifecycle invocation', 2)
  assertExpectedScenario(expectedScenario, false)
  const { transactionPath: transactionRoot, physicalHomePath, physicalTransactionRoot } = lifecyclePaths(homePath)
  const recovery = await recoverBoundTransaction({
    homePath, physicalHomePath, profile, transactionRoot, physicalTransactionRoot, dshExecutable,
  })
  await assertLockedLifecycleScenario({ dshExecutable, profile, homePath, expectedScenario, serviceAware: false })
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
    operation: 'upgrade', profile, homePath, dshExecutable, bwrapExecutable, expectedScenario, targets,
    skipRecovery: true, transactionPrechecked: true,
  })
}

async function performNpmServiceUpgrade({
  profile, homePath, dshExecutable, bwrapExecutable, expectedScenario,
  systemctlExecutable, journalctlExecutable, npmExecutable, pnpmExecutable, selector,
}) {
  assertExpectedScenario(expectedScenario, true)
  const { transactionPath: transactionRoot, physicalHomePath, physicalTransactionRoot } = lifecyclePaths(homePath)
  const recovery = await recoverBoundTransaction({
    homePath, physicalHomePath, profile, transactionRoot, physicalTransactionRoot,
    serviceContext: { systemctlExecutable, journalctlExecutable }, dshExecutable,
  })
  await assertLockedLifecycleScenario({ dshExecutable, profile, homePath, expectedScenario, serviceAware: true })
  if (recovery !== undefined) fail('已恢复上次生命周期事务；本次未访问 npm registry，请重试 upgrade。')
  const current = await readProfile(physicalHomePath, profile)
  const expectedManaged = managedNames(current.manifest)
  if (expectedManaged.length === 0) fail('当前 profile 没有可升级的 @dsh-enhanced/* 顶层依赖。')
  const thirdParty = thirdPartyBundles(current.manifest)
  if (thirdParty.length > 0) fail(`检测到无法证明状态路径的第三方顶层 bundle，拒绝 upgrade：${thirdParty.join(', ')}`)
  const npmPath = await realpath(npmExecutable).catch(() => fail('npm executable must exist'))
  const pnpmPath = await realpath(pnpmExecutable).catch(() => fail('pnpm executable must exist'))
  const targets = await resolveNpmUpgradeCohort({ npmExecutable: npmPath, selector, expectedNames: expectedManaged })
  try { await run(pnpmPath, ['store', 'add', ...targets], { env: { ...process.env, npm_config_ignore_scripts: 'true' } }) }
  catch { fail('npm cohort 预取失败；尚未创建事务或修改 DSH_HOME。') }
  await performLifecycle({
    operation: 'upgrade', profile, homePath, dshExecutable, bwrapExecutable, expectedScenario, targets,
    skipRecovery: true, transactionPrechecked: true,
    serviceContext: { systemctlExecutable, journalctlExecutable },
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

async function performLifecycle({
  operation, profile, homePath, dshExecutable, bwrapExecutable, expectedScenario, targets,
  skipRecovery = false, transactionPrechecked = false, serviceContext,
}) {
  if (!['upgrade', 'uninstall'].includes(operation) || !PROFILE_NAME.test(profile) || !isAbsolute(homePath) || resolve(homePath) !== homePath) fail('invalid lifecycle invocation', 2)
  assertExpectedScenario(expectedScenario, serviceContext !== undefined, operation)
  const { transactionPath: transactionRoot, physicalHomePath, physicalTransactionRoot } = lifecyclePaths(homePath)
  if (skipRecovery) {
    if (!transactionPrechecked) fail('lifecycle recovery may only be skipped after a locked transaction precheck')
    assertLockParentStable(homePath)
    if (await existingIdentity(physicalTransactionRoot) !== undefined) fail('生命周期事务在预检后出现；拒绝继续。')
  } else {
    const recovery = await recoverBoundTransaction({
      homePath, physicalHomePath, profile, transactionRoot, physicalTransactionRoot, serviceContext, dshExecutable,
    })
    if (typeof recovery === 'string' && recovery.startsWith('service-')) {
      await assertLockedLifecycleScenario({
        dshExecutable, profile, homePath, expectedScenario, serviceAware: true,
      })
      return
    }
  }
  await assertLockedLifecycleScenario({
    dshExecutable, profile, homePath, expectedScenario, serviceAware: serviceContext !== undefined,
  })
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
  if (expectedScenario === 'unsupported' && expectedManaged.length > 0) {
    fail('无法归类的 profile 仍含受管顶层依赖；拒绝 uninstall。')
  }
  if (operation === 'upgrade') {
    if (expectedManaged.length === 0) fail('当前 profile 没有可升级的 @dsh-enhanced/* 顶层依赖。')
    await validateUpgradeTargets(targets, expectedManaged)
  } else {
    if (expectedManaged.length === 0) {
      process.stdout.write('profile 生命周期事务：uninstall 已完成；当前 profile 没有 @dsh-enhanced/* 顶层依赖。\n')
      return
    }
  }
  let services
  let unitUniverse
  let timeouts
  if (serviceContext !== undefined) {
    if (operation !== 'upgrade') fail('service-aware lifecycle only supports upgrade', 2)
    timeouts = serviceTimeouts()
    const inventory = await captureServiceInventory(serviceContext.systemctlExecutable, homePath, profile, dshExecutable)
    services = inventory.services
    unitUniverse = inventory.unitUniverse
    for (const service of services) {
      await assertNotSupervisedProfile({ dshExecutable, profile: service.profile, homePath })
      if (!['enabled', 'disabled'].includes(service.unitFileState)) {
        fail(`service-aware upgrade 仅支持 enabled/disabled units；${service.unit} 当前为 ${service.unitFileState}。`)
      }
      if (await existingIdentity(serviceMaskPath(service.unit)) !== undefined
        || await existingIdentity(`${serviceMaskPath(service.unit)}.d`) !== undefined) {
        throw new ServiceMaskConflictError(`拒绝接管既有 systemd mask/drop-in：${service.unit}`)
      }
    }
    const controlRootStat = await stat(join(process.env.HOME ?? '', '.config', 'systemd', 'user'))
    const homeParentStat = fstatSync(3)
    if (String(controlRootStat.dev) !== String(homeParentStat.dev)) {
      fail('service-aware upgrade 要求 DSH_HOME parent 与用户 systemd 配置位于同一文件系统，以保证 no-replace 原子屏障。')
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
  const transactionCreated = {
    version: serviceContext === undefined ? MANIFEST_VERSION : SERVICE_MANIFEST_VERSION,
    id: randomUUID(), homePath, canonicalHome, transactionPath: transactionRoot, profile, operation,
    transactionIdentity: identity(await lstat(physicalTransactionRoot)),
    originalIdentity: identity(originalStat), originalProfileDigest: sha256(current.source),
    stagedIdentity: undefined, stagedProfileDigest: undefined, createdAt: new Date().toISOString(),
    expectedScenario, stagedScenario: operation === 'uninstall' ? 'unsupported' : expectedScenario,
  }
  let serviceMasks
  let serviceStartBarriers
  try {
    if (serviceContext !== undefined) {
      await writeManifest(physicalTransactionRoot, {
        ...transactionCreated, services, unitUniverse, serviceMasks: [], containmentMasks: [], containmentMaskIntents: [],
        containmentStartBarriers: [],
        serviceStartBarriers: [], servicePhase: 'initializing', serviceFailure: undefined, serviceAcceptance: undefined,
      }, 'preparing')
      serviceMasks = await prepareBoundMasks(physicalTransactionRoot, services.map(service => service.unit), 'managed')
      serviceStartBarriers = await prepareServiceStartBarriers(physicalTransactionRoot, services)
    }
  } catch (error) {
    await rm(physicalTransactionRoot, { recursive: true, force: true }).catch(() => {})
    await fsyncPath(LOCK_PARENT_FD_PATH, true).catch(() => {})
    throw error
  }
  let manifest = {
    ...transactionCreated,
    ...(serviceContext === undefined ? {} : {
      services, unitUniverse, serviceMasks, containmentMasks: [], containmentMaskIntents: [],
      containmentStartBarriers: [], serviceStartBarriers,
      servicePhase: 'stopping', serviceFailure: undefined, serviceAcceptance: undefined,
    }),
  }
  if (serviceContext !== undefined) {
    manifest = await writeManifest(physicalTransactionRoot, manifest, 'preparing')
    try {
      await installBoundMasks(serviceContext.systemctlExecutable, serviceMasks)
      await establishServiceStartBarriers(serviceContext.systemctlExecutable, serviceStartBarriers)
      await stopServicesAndWait(serviceContext.systemctlExecutable, services, serviceMasks, homePath, dshExecutable, unitUniverse, timeouts.stop)
      await assertNoUnmanagedHomeProcesses(homePath)
      manifest = await writeManifest(physicalTransactionRoot, { ...manifest, servicePhase: 'stopped' }, 'preparing')
    } catch (error) {
      try {
        await restoreOriginalActiveSet({
          ...serviceContext, dshExecutable, services, serviceMasks, serviceStartBarriers,
          containmentMasks: manifest.containmentMasks, containmentStartBarriers: manifest.containmentStartBarriers,
          homePath, targetProfile: profile, unitUniverse, timeouts,
        })
        await rm(physicalTransactionRoot, { recursive: true, force: true })
      } catch (restoreError) {
        await stopRelatedServices(
          serviceContext.systemctlExecutable, services, homePath, dshExecutable, unitUniverse, timeouts.stop,
          physicalTransactionRoot, manifest,
        ).catch(() => {})
        await writeManifest(physicalTransactionRoot, {
          ...manifest, servicePhase: 'service-failed',
          serviceFailure: `${error instanceof Error ? error.message : String(error)}; restore: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
        }, 'service-failed').catch(() => {})
      }
      throw error
    }
  } else {
    manifest = await writeManifest(physicalTransactionRoot, manifest, 'preparing')
  }

  let swapped = false
  let commitUncertain = false
  let committedCleanup = false
  try {
    if (serviceContext !== undefined) {
      await assertMaskedAndQuiescent({
        ...serviceContext, services, serviceMasks, homePath, dshExecutable, unitUniverse,
      })
    }
    await copyHome(physicalHomePath, stageHome)
    const stagedStat = await stat(stageHome)
    manifest = await writeManifest(physicalTransactionRoot, { ...manifest, stagedIdentity: identity(stagedStat) }, 'prepared')
    const stagedProfile = await readProfile(stageHome, profile)
    const stagedCanonical = await realpath(stagedProfile.profilePath)
    if (!inside(await realpath(stageHome), stagedCanonical)) fail('staged profile 通过符号链接逃逸 DSH_HOME；拒绝继续。')

    const sandbox = {
      bwrapExecutable, stageHome, homePath, dshExecutable, profile, expectedScenario, transactionId: manifest.id,
    }
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
    const committedScenario = manifest.stagedScenario
    const packageScenario = await validateComposedConfig({ ...sandbox, expectedScenario: committedScenario }, 'after-package')
    await activateInSandbox(sandbox)
    await validateComposedConfig({ ...sandbox, expectedScenario: packageScenario }, 'after-activation')
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
    if (serviceContext !== undefined) {
      await assertMaskedAndQuiescent({
        ...serviceContext, services, serviceMasks, homePath, dshExecutable, unitUniverse,
      })
    }
    await rename(physicalHomePath, backupHome)
    assertLockParentStable(homePath)
    await fsyncPath(physicalTransactionRoot, true)
    await fsyncPath(LOCK_PARENT_FD_PATH, true)
    manifest = await writeManifest(physicalTransactionRoot, manifest, 'original-renamed')
    if (serviceContext !== undefined) {
      try {
        await assertNoUnmanagedHomeProcesses(homePath, [await realpath(backupHome)])
      } catch (error) {
        if (await existingIdentity(physicalHomePath) !== undefined) fail('DSH_HOME 在 post-rename quiescence 恢复前重新出现；拒绝覆盖。')
        await rename(backupHome, physicalHomePath)
        await fsyncPath(physicalTransactionRoot, true)
        await fsyncPath(LOCK_PARENT_FD_PATH, true)
        throw error
      }
    }
    assertLockParentStable(homePath)
    if (await existingIdentity(physicalHomePath) !== undefined) fail('DSH_HOME 在原目录移走后重新出现；拒绝覆盖。')
    await assertCriticalDirectory(stageHome, manifest.stagedIdentity)
    if (operation === 'upgrade') await assertProfileTreeIdentity(validatedProfile)
    else await readProfile(stageHome, profile)
    if (serviceContext !== undefined) {
      await assertMaskedAndQuiescent({
        ...serviceContext, services, serviceMasks, homePath, dshExecutable, unitUniverse,
        equivalentHomePaths: [await realpath(backupHome)],
      })
    }
    await rename(stageHome, physicalHomePath)
    assertLockParentStable(homePath)
    await fsyncPath(physicalTransactionRoot, true)
    await fsyncPath(LOCK_PARENT_FD_PATH, true)
    swapped = true
    manifest = await writeManifest(physicalTransactionRoot, {
      ...manifest, ...(serviceContext === undefined ? {} : { servicePhase: 'swapped' }),
    }, 'swapped')
    await assertProfileDigest(backupHome, profile, manifest.originalProfileDigest)
    if (serviceContext !== undefined) {
      manifest = await writeManifest(physicalTransactionRoot, { ...manifest, servicePhase: 'starting' }, 'swapped')
      try {
        const accepted = await startAndAcceptServices({
          ...serviceContext, dshExecutable, services, serviceMasks, homePath, targetProfile: profile, unitUniverse, timeouts,
        })
        manifest = await writeManifest(physicalTransactionRoot, {
          ...manifest, servicePhase: 'service-accepted',
          serviceAcceptance: accepted.map(service => ({
            unit: service.unit, invocationId: service.invocationId, mainPid: service.mainPid, nRestarts: service.nRestarts,
          })),
        }, 'service-accepted')
      } catch (serviceError) {
        let containmentFailure
        manifest = await loadManifest(physicalTransactionRoot, {
          homePath, profile, transactionPath: transactionRoot,
        }).catch(() => manifest)
        try {
          manifest = await stopRelatedServices(
            serviceContext.systemctlExecutable, services, homePath, dshExecutable, unitUniverse, timeouts.stop,
            physicalTransactionRoot, manifest,
          )
        } catch (containmentError) {
          containmentFailure = containmentError instanceof Error ? containmentError.message : String(containmentError)
          manifest = await loadManifest(physicalTransactionRoot, {
            homePath, profile, transactionPath: transactionRoot,
          }).catch(() => manifest)
        }
        await writeManifest(physicalTransactionRoot, {
          ...manifest, servicePhase: 'service-failed',
          serviceFailure: (serviceError instanceof Error ? serviceError.message : String(serviceError))
            + (containmentFailure === undefined ? '' : `; containment: ${containmentFailure}`),
        }, 'service-failed').catch(() => {})
        if (containmentFailure !== undefined) {
          process.stderr.write(`service-aware failure containment 未完成：${containmentFailure}\n`)
        }
        throw serviceError
      }
    }
    if (serviceContext !== undefined) {
      await finalizeAcceptedServices({
        ...serviceContext, dshExecutable, services, serviceMasks, containmentMasks: manifest.containmentMasks,
        containmentStartBarriers: manifest.containmentStartBarriers,
        serviceStartBarriers,
        homePath, unitUniverse, acceptance: manifest.serviceAcceptance,
      })
    }
    commitUncertain = true
    manifest = await writeManifest(physicalTransactionRoot, manifest, 'committed')
    commitUncertain = false
    await assertProfileDigest(physicalHomePath, profile, manifest.stagedProfileDigest)
    await assertProfileDigest(backupHome, profile, manifest.originalProfileDigest)
    if (serviceContext !== undefined) {
      await assertAcceptedServicesStillBound({
        ...serviceContext, dshExecutable, services, homePath, unitUniverse, acceptance: manifest.serviceAcceptance,
      })
    }
    manifest = await writeManifest(physicalTransactionRoot, manifest, 'cleanup-started')
    committedCleanup = true
    await removeCommittedTransaction({ physicalTransactionRoot, transactionRoot, manifest, backupHome })
    committedCleanup = false
    process.stdout.write(`profile 生命周期事务完成：${operation}；配置、凭据、Session 与任务状态均从离线副本保留。\n`)
  } catch (error) {
    const persisted = await loadManifest(physicalTransactionRoot, { homePath, profile, transactionPath: transactionRoot }).catch(() => undefined)
    const liveAfterFailure = await existingIdentity(physicalHomePath)
    const backupAfterFailure = await existingIdentity(backupHome)
    const crossedSwapBoundary = persisted?.version === SERVICE_MANIFEST_VERSION
      && sameIdentity(liveAfterFailure, persisted.stagedIdentity)
      && sameIdentity(backupAfterFailure, persisted.originalIdentity)
    if (committedCleanup) {
      process.stderr.write(`profile 生命周期已提交，但 canonical 事务清理失败；保留可恢复 residue，请重试同一命令：${transactionRoot}\n`)
    } else if (commitUncertain && persisted?.state === 'committed') {
      process.stderr.write(`profile 生命周期已提交但收尾状态无法确认；保留当前 home 与原始备份，请重新执行同一命令持锁恢复：${transactionRoot}\n`)
    } else if (serviceContext !== undefined && persisted?.state === 'cleanup-started'
      && sameIdentity(liveAfterFailure, persisted.stagedIdentity) && backupAfterFailure === undefined) {
      process.stderr.write(`service-aware 生命周期已验收且旧备份已删除，但事务元数据清理未完成；请重试同一命令：${transactionRoot}\n`)
    } else if (serviceContext !== undefined && (swapped || crossedSwapBoundary)) {
      try {
        manifest = await stopRelatedServices(
          serviceContext.systemctlExecutable, services, homePath, dshExecutable, unitUniverse, timeouts.stop,
          physicalTransactionRoot, persisted ?? manifest,
        )
        await writeManifest(physicalTransactionRoot, {
          ...manifest, servicePhase: 'service-failed',
          serviceFailure: error instanceof Error ? error.message : String(error),
        }, 'service-failed')
      } catch {}
      process.stderr.write(`service-aware 生命周期已切换 DSH_HOME；禁止自动回滚迁移状态，保留 current home、original-home 与事务证据：${transactionRoot}\n`)
    } else if (serviceContext !== undefined) {
      try {
        if (liveAfterFailure === undefined && sameIdentity(backupAfterFailure, manifest.originalIdentity)) {
          assertLockParentStable(homePath)
          await rename(backupHome, physicalHomePath)
          await fsyncPath(physicalTransactionRoot, true)
          await fsyncPath(LOCK_PARENT_FD_PATH, true)
        }
        manifest = await stopRelatedServices(
          serviceContext.systemctlExecutable, services, homePath, dshExecutable, unitUniverse, timeouts.stop,
          physicalTransactionRoot, persisted ?? manifest,
        )
        await restoreOriginalActiveSet({
          ...serviceContext, dshExecutable, services, serviceMasks, serviceStartBarriers,
          containmentMasks: (persisted ?? manifest).containmentMasks,
          containmentStartBarriers: (persisted ?? manifest).containmentStartBarriers,
          homePath, targetProfile: profile, unitUniverse, timeouts,
        })
        const evidence = await moveTransactionAside(physicalTransactionRoot, transactionRoot, profile)
        await fsyncPath(LOCK_PARENT_FD_PATH, true)
        process.stderr.write(`service-aware 生命周期在切换前失败；原 home 与 active service set 已恢复，证据保留在 ${evidence}\n`)
      } catch (restoreError) {
        await writeManifest(physicalTransactionRoot, {
          ...(persisted ?? manifest), servicePhase: 'service-failed',
          serviceFailure: `${error instanceof Error ? error.message : String(error)}; restore: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
        }, 'service-failed').catch(() => {})
        process.stderr.write(`service-aware 生命周期在切换前失败且服务恢复未完成：${restoreError instanceof Error ? restoreError.message : String(restoreError)}\n`)
      }
    } else if (swapped || await existingIdentity(backupHome) !== undefined) {
      try {
        await recoverBoundTransaction({
          homePath, physicalHomePath, profile, transactionRoot, physicalTransactionRoot, dshExecutable,
        })
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
  const recoveryOperation = operation === 'recover' || operation === 'service-recover'
  const dshExecutable = await realpath(suppliedDshExecutable).catch(() => fail('DSH executable must exist'))
  const bwrapExecutable = recoveryOperation ? suppliedBwrapExecutable
    : await trustedSystemExecutable(suppliedBwrapExecutable, 'bwrap')
  if (!lockHeld) {
    await withLifecycleLock(homePath, [operation, profile, homePath, dshExecutable, bwrapExecutable, ...targets])
    return
  }
  await assertLifecycleLocksHeld(homePath)
  if (operation === 'recover') {
    if (targets.length > 1) fail('recover accepts at most one ignored caller scenario', 2)
    if (!PROFILE_NAME.test(profile) || !isAbsolute(homePath) || resolve(homePath) !== homePath) fail('invalid lifecycle recovery invocation', 2)
    const { transactionPath: transactionRoot, physicalHomePath, physicalTransactionRoot } = lifecyclePaths(homePath)
    await recoverBoundTransaction({
      homePath, physicalHomePath, profile, transactionRoot, physicalTransactionRoot, dshExecutable,
    })
    return
  }
  if (operation === 'service-recover') {
    if (targets.length < 2 || targets.length > 3) {
      fail('service-recover requires systemctl and journalctl and accepts one ignored caller scenario', 2)
    }
    if (!PROFILE_NAME.test(profile) || !isAbsolute(homePath) || resolve(homePath) !== homePath) fail('invalid lifecycle recovery invocation', 2)
    const [suppliedSystemctl, suppliedJournalctl] = targets
    const systemctlExecutable = await trustedServiceExecutable(suppliedSystemctl, 'systemctl')
    const journalctlExecutable = await trustedServiceExecutable(suppliedJournalctl, 'journalctl')
    const { transactionPath: transactionRoot, physicalHomePath, physicalTransactionRoot } = lifecyclePaths(homePath)
    await recoverBoundTransaction({
      homePath, physicalHomePath, profile, transactionRoot, physicalTransactionRoot, dshExecutable,
      serviceContext: { systemctlExecutable, journalctlExecutable },
    })
    return
  }
  if (operation === 'npm-upgrade') {
    if (targets.length !== 4) fail('npm-upgrade requires npm, pnpm, expected scenario, and one selector', 2)
    const [npmExecutable, pnpmExecutable, expectedScenario, selector] = targets
    await performNpmUpgrade({
      profile, homePath, dshExecutable, bwrapExecutable, expectedScenario, npmExecutable, pnpmExecutable, selector,
    })
    return
  }
  if (operation === 'service-upgrade') {
    if (targets.length < 4) fail('service-upgrade requires systemctl, journalctl, expected scenario, and upgrade targets', 2)
    const [suppliedSystemctl, suppliedJournalctl, expectedScenario, ...serviceTargets] = targets
    const systemctlExecutable = await trustedServiceExecutable(suppliedSystemctl, 'systemctl')
    const journalctlExecutable = await trustedServiceExecutable(suppliedJournalctl, 'journalctl')
    await performLifecycle({
      operation: 'upgrade', profile, homePath, dshExecutable, bwrapExecutable, expectedScenario, targets: serviceTargets,
      serviceContext: { systemctlExecutable, journalctlExecutable },
    })
    return
  }
  if (operation === 'npm-service-upgrade') {
    if (targets.length !== 6) fail('npm-service-upgrade requires systemctl, journalctl, npm, pnpm, expected scenario, and selector', 2)
    const [suppliedSystemctl, suppliedJournalctl, npmExecutable, pnpmExecutable, expectedScenario, selector] = targets
    const systemctlExecutable = await trustedServiceExecutable(suppliedSystemctl, 'systemctl')
    const journalctlExecutable = await trustedServiceExecutable(suppliedJournalctl, 'journalctl')
    await performNpmServiceUpgrade({
      profile, homePath, dshExecutable, bwrapExecutable, expectedScenario,
      systemctlExecutable, journalctlExecutable, npmExecutable, pnpmExecutable, selector,
    })
    return
  }
  const [expectedScenario, ...lifecycleTargets] = targets
  await performLifecycle({
    operation, profile, homePath, dshExecutable, bwrapExecutable, expectedScenario, targets: lifecycleTargets,
  })
}

main().catch(error => {
  process.stderr.write(`dsh-enhanced lifecycle: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = error instanceof LifecycleError ? error.exitCode : 1
})
