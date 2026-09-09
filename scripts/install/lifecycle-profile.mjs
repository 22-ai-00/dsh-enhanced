#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs'
import { chmod, lstat, mkdir, open, opendir, readFile, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const VALIDATOR_PATH = join(dirname(SCRIPT_PATH), 'lifecycle-config.mjs')
const MANIFEST_VERSION = 1
const TRANSACTION_SUFFIX = '.dsh-enhanced-transaction'
const READY_MARKER = 'dsh web: http://127.0.0.1:'
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const MANAGED_PACKAGE = /^@dsh-enhanced\/[a-z0-9-]+$/u
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
}

function identity(entry) {
  return { dev: String(entry.dev), ino: String(entry.ino) }
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
  let parentDescriptor
  let lockDescriptor
  try {
    parentDescriptor = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const openedParent = fstatSync(parentDescriptor)
    const linkedParent = lstatSync(parent)
    if (!openedParent.isDirectory() || openedParent.uid !== process.getuid?.()
      || !linkedParent.isDirectory() || linkedParent.isSymbolicLink()
      || linkedParent.dev !== openedParent.dev || linkedParent.ino !== openedParent.ino) {
      fail(`生命周期锁父目录身份不稳定或权限不安全：${parent}`)
    }
    lockDescriptor = openSync(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    const locked = fstatSync(lockDescriptor)
    const linked = lstatSync(lockPath)
    if (!locked.isFile() || locked.uid !== process.getuid?.() || locked.nlink !== 1 || (locked.mode & 0o077) !== 0
      || !linked.isFile() || linked.isSymbolicLink() || linked.dev !== locked.dev || linked.ino !== locked.ino) {
      fail(`生命周期锁身份不稳定或权限不安全：${lockPath}`)
    }
    const flockExecutable = process.env.DSH_ENHANCED_LIFECYCLE_FLOCK ?? '/usr/bin/flock'
    try {
      await run('/bin/bash', [
        '-c', 'flock_command="$1"; shift; "$flock_command" -n -E 75 3 || exit $?; "$flock_command" -n -E 75 4 || exit $?; exec "$@"',
        'dsh-enhanced-lifecycle-lock', flockExecutable,
        process.execPath, SCRIPT_PATH, ...invocation, '--lock-held',
      ], { passFds: [parentDescriptor, lockDescriptor] })
    }
    catch (error) {
      if (error instanceof LifecycleError && error.exitCode === 75) fail(`DSH_HOME 生命周期锁正在占用，拒绝并发操作：${lockPath}`)
      throw error
    }
  } finally {
    if (lockDescriptor !== undefined) closeSync(lockDescriptor)
    if (parentDescriptor !== undefined) closeSync(parentDescriptor)
  }
}

async function assertLifecycleLocksHeld(homePath) {
  const lockPath = `${homePath}.dsh-enhanced-lifecycle.lock`
  const parent = dirname(lockPath)
  const checks = [
    { descriptor: 3, path: parent, kind: 'directory' },
    { descriptor: 4, path: lockPath, kind: 'file' },
  ]
  for (const check of checks) {
    let opened
    let linked
    try { opened = fstatSync(check.descriptor); linked = lstatSync(check.path) }
    catch { fail('生命周期执行器缺少可验证的内核锁。') }
    const kindMatches = check.kind === 'directory' ? opened.isDirectory() && linked.isDirectory() : opened.isFile() && linked.isFile()
    if (!kindMatches || linked.isSymbolicLink() || opened.uid !== process.getuid?.()
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
        passFds: [3, 4],
      })
    } catch (error) {
      if (error instanceof LifecycleError && error.exitCode === 75) fail('生命周期执行器继承的 fd 未持有要求的内核排他锁。')
      throw error
    }
  }
}

async function assertSnapshotTreeSafe(homePath, logicalHome = homePath, allowPackageHardlinks = false) {
  const canonicalHome = await realpath(homePath)
  const homeStat = await stat(homePath)
  const hardlinks = new Map()
  const visit = async directory => {
    const entries = await opendir(directory)
    for await (const entry of entries) {
      const path = join(directory, entry.name)
      const relative = path.slice(homePath.length + 1)
      if (entry.isSymbolicLink()) {
        let target
        try { target = await realpath(path) } catch {
          const packageLink = relative.split(sep).includes('node_modules')
          if (!packageLink) fail(`DSH_HOME 包含悬空或不可解析的符号链接，拒绝快照：${relative}`)
          const logicalLink = join(logicalHome, relative)
          try { target = await realpath(resolve(dirname(logicalLink), await readlink(path))) }
          catch { continue }
        }
        // pnpm intentionally projects linked packages through node_modules.
        // The sandbox mounts the host root read-only, so those package links
        // remain readable but cannot mutate their external targets. All other
        // external links are state/profile escape paths and fail closed.
        const packageLink = relative.split(sep).includes('node_modules')
        if (!inside(canonicalHome, target) && !packageLink) {
          fail(`DSH_HOME 包含指向外部的符号链接，拒绝快照：${relative} -> ${await readlink(path)}`)
        }
        continue
      }
      if (entry.isDirectory()) {
        const directoryStat = await lstat(path)
        if (String(directoryStat.dev) !== String(homeStat.dev)) fail(`DSH_HOME 包含其它文件系统的挂载点，拒绝快照：${relative}`)
        await visit(path)
      } else if (entry.isFile()) {
        const fileStat = await lstat(path)
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

async function loadManifest(transactionRoot, expected) {
  const rootStat = await lstat(transactionRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid?.() || (rootStat.mode & 0o077) !== 0) fail(`拒绝未绑定或未知的生命周期事务目录：${transactionRoot}`)
  const manifestPath = join(transactionRoot, 'manifest.json')
  let manifest
  try {
    const manifestStat = await lstat(manifestPath)
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.uid !== process.getuid?.()
      || manifestStat.nlink !== 1 || (manifestStat.mode & 0o077) !== 0 || manifestStat.size > 64 * 1024) throw new Error('unsafe manifest')
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    fail(`拒绝未绑定或未知的生命周期事务；缺少有效 manifest：${transactionRoot}`)
  }
  if (manifest?.version !== MANIFEST_VERSION
    || typeof manifest.id !== 'string'
    || manifest.homePath !== expected.homePath
    || manifest.transactionPath !== transactionRoot
    || manifest.profile !== expected.profile
    || !['upgrade', 'uninstall'].includes(manifest.operation)
    || !['preparing', 'prepared', 'validated', 'original-renamed', 'swapped', 'committed', 'cleanup-started', 'failed'].includes(manifest.state)
    || manifest.bindingDigest !== sha256(JSON.stringify(bindingFor(manifest)))) {
    fail(`拒绝未绑定或校验失败的生命周期事务 manifest：${transactionRoot}`)
  }
  const canonicalHome = await canonicalMissingAllowed(expected.homePath)
  if (canonicalHome !== manifest.canonicalHome) fail(`生命周期事务 manifest 与当前 DSH_HOME 未绑定：${transactionRoot}`)
  return manifest
}

function diagnosticPath(transactionRoot, profile) {
  const stamp = new Date().toISOString().replaceAll(/[-:.]/gu, '').replace('Z', 'Z')
  return `${transactionRoot}.failed-${profile}-${stamp}-${process.pid}`
}

async function moveTransactionAside(transactionRoot, profile) {
  const target = diagnosticPath(transactionRoot, profile)
  await rename(transactionRoot, target)
  return target
}

async function assertProfileDigest(home, profile, expected) {
  const pieces = [home, join(home, 'profiles'), join(home, 'profiles', profile)]
  for (const path of pieces) {
    const entry = await lstat(path)
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid?.()) {
      fail('生命周期事务中的 profile 路径身份不安全；拒绝自动恢复。')
    }
  }
  const path = join(home, 'profiles', profile, 'package.json')
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const entry = fstatSync(descriptor)
    if (!entry.isFile() || entry.uid !== process.getuid?.() || entry.nlink !== 1 || entry.size > 4 * 1024 * 1024) {
      fail('生命周期事务中的 profile manifest 身份不安全；拒绝自动恢复。')
    }
    const source = await readFile(`/proc/self/fd/${descriptor}`)
    if (sha256(source) !== expected) fail('生命周期事务中的原 profile manifest 摘要不匹配；拒绝自动恢复。')
  } finally { closeSync(descriptor) }
}

async function recoverBoundTransaction({ homePath, profile, transactionRoot }) {
  let manifest
  try {
    await lstat(transactionRoot)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  manifest = await loadManifest(transactionRoot, { homePath, profile })
  const backupHome = join(transactionRoot, 'original-home')
  const failedHome = join(transactionRoot, 'failed-home')
  const homeStat = await existingIdentity(homePath)
  const backupStat = await existingIdentity(backupHome)
  const homeIsOriginal = homeStat !== undefined && sameIdentity(homeStat, manifest.originalIdentity)
  const homeIsStaged = homeStat !== undefined && sameIdentity(homeStat, manifest.stagedIdentity)
  const backupIsOriginal = backupStat !== undefined && sameIdentity(backupStat, manifest.originalIdentity)

  if (manifest.state === 'committed' || manifest.state === 'cleanup-started') {
    if (!homeIsStaged || (backupStat !== undefined && !backupIsOriginal)) {
      fail(`已提交事务的 home/backup 身份不匹配；拒绝清理：${transactionRoot}`)
    }
    await assertProfileDigest(homePath, profile, manifest.stagedProfileDigest)
    if (manifest.state === 'committed') {
      if (!backupIsOriginal) fail(`已提交事务缺少完整且绑定的原始备份；拒绝开始清理：${transactionRoot}`)
      await assertProfileDigest(backupHome, profile, manifest.originalProfileDigest)
      manifest = await writeManifest(transactionRoot, manifest, 'cleanup-started')
    }
    if (backupIsOriginal) {
      await assertNoMounts(transactionRoot)
      await rm(backupHome, { recursive: true })
      await fsyncPath(transactionRoot, true)
    }
    const cleanup = `${transactionRoot}.committed-${manifest.id}`
    await rename(transactionRoot, cleanup)
    await assertNoMounts(cleanup)
    await rm(cleanup, { recursive: true }).catch(error => {
      process.stderr.write(`已提交事务的旧元数据清理未完成，可稍后手动删除 ${cleanup}：${error instanceof Error ? error.message : String(error)}\n`)
    })
    process.stdout.write('profile 生命周期恢复：已完成上次提交后的绑定清理。\n')
    return 'committed'
  }

  if (homeIsOriginal && backupStat === undefined) {
    await assertProfileDigest(homePath, profile, manifest.originalProfileDigest)
    const evidence = await moveTransactionAside(transactionRoot, profile)
    await fsyncPath(dirname(transactionRoot), true)
    process.stderr.write(`profile 生命周期恢复：原 DSH_HOME 未修改；旧事务证据保留在 ${evidence}\n`)
    return 'original-intact'
  }

  if (homeStat === undefined && backupIsOriginal) {
    await assertProfileDigest(backupHome, profile, manifest.originalProfileDigest)
    await rename(backupHome, homePath)
    await fsyncPath(transactionRoot, true)
    await fsyncPath(dirname(homePath), true)
    const evidence = await moveTransactionAside(transactionRoot, profile)
    await fsyncPath(dirname(transactionRoot), true)
    process.stderr.write(`profile 生命周期恢复：已恢复原 DSH_HOME；失败事务证据保留在 ${evidence}\n`)
    return 'restored'
  }

  if (homeIsStaged && backupIsOriginal) {
    await assertProfileDigest(backupHome, profile, manifest.originalProfileDigest)
    if (await existingIdentity(failedHome) !== undefined) fail(`事务失败副本路径已存在；拒绝覆盖：${failedHome}`)
    await rename(homePath, failedHome)
    await fsyncPath(transactionRoot, true)
    await fsyncPath(dirname(homePath), true)
    await rename(backupHome, homePath)
    await fsyncPath(transactionRoot, true)
    await fsyncPath(dirname(homePath), true)
    const evidence = await moveTransactionAside(transactionRoot, profile)
    await fsyncPath(dirname(transactionRoot), true)
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

function sandboxArgs({ bwrapExecutable, homePath, command, extraEnvironment = {} }) {
  const args = [
    '--unshare-all', '--die-with-parent', '--new-session',
    '--ro-bind', '/', '/',
    '--tmpfs', '/tmp', '--tmpfs', '/run',
    '--dir', homePath,
    '--bind-fd', '3', homePath,
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

async function sandboxRun(context, command, options = {}) {
  const invocation = sandboxArgs({ ...context, command, extraEnvironment: options.extraEnvironment })
  const stage = await open(context.stageHome, constants.O_RDONLY)
  try { return await run(invocation.executable, invocation.args, { capture: options.capture, passFds: [stage.fd] }) }
  finally { await stage.close() }
}

async function validateComposedConfig(context, label) {
  const dumped = await sandboxRun(context, [context.dshExecutable, '--profile', context.profile, '--dump-config'], { capture: true })
  const physicalPath = join(context.stageHome, `.dsh-enhanced-${label}-${context.transactionId}.yml`)
  const logicalPath = join(context.homePath, basename(physicalPath))
  await writeFile(physicalPath, dumped.stdout, { mode: 0o600, flag: 'wx' })
  try {
    await sandboxRun(context, [process.execPath, VALIDATOR_PATH, logicalPath, context.homePath, context.dshExecutable])
  } finally {
    await rm(physicalPath, { force: true })
  }
}

async function activateInSandbox(context) {
  const invocation = sandboxArgs({
    ...context,
    command: [context.dshExecutable, '--profile', context.profile, '--host', '127.0.0.1', '--no-open', '--port', '0'],
  })
  const stage = await open(context.stageHome, constants.O_RDONLY)
  try { await new Promise((resolveActivation, rejectActivation) => {
    const child = spawn(invocation.executable, invocation.args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe', stage.fd] })
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
  }) } finally { await stage.close() }
}

async function readProfile(homePath, profile) {
  const profilePath = join(homePath, 'profiles', profile)
  const profileStat = await lstat(profilePath).catch(() => undefined)
  if (profileStat === undefined || !profileStat.isDirectory() || profileStat.isSymbolicLink()) {
    fail(`生命周期操作需要已存在的真实 profile 目录：${profilePath}`)
  }
  const manifestPath = join(profilePath, 'package.json')
  const manifestStat = await lstat(manifestPath).catch(() => undefined)
  if (manifestStat === undefined || !manifestStat.isFile() || manifestStat.isSymbolicLink()) fail(`profile manifest 必须是普通文件：${manifestPath}`)
  const source = await readFile(manifestPath)
  let manifest
  try { manifest = JSON.parse(source) } catch { fail(`profile manifest 不是有效 JSON：${manifestPath}`) }
  return { profilePath, manifestPath, source, manifest }
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
    if (!isAbsolute(target)) fail(`升级目标必须是本地绝对路径：${target}`)
    let targetManifest
    try { targetManifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')) }
    catch { fail(`无法读取升级目标 manifest：${target}`) }
    if (typeof targetManifest.name !== 'string' || !MANAGED_PACKAGE.test(targetManifest.name)) fail(`升级目标不是 @dsh-enhanced/* bundle：${target}`)
    actualNames.push(targetManifest.name)
  }
  const actual = [...new Set(actualNames)].sort()
  if (actual.length !== actualNames.length || JSON.stringify(actual) !== JSON.stringify(expectedNames)) {
    fail(`升级目标必须精确匹配当前已安装的受管顶层依赖；expected=${expectedNames.join(',')} actual=${actual.join(',')}`)
  }
}

async function copyHome(homePath, stageHome) {
  await mkdir(stageHome, { mode: 0o700 })
  await run('/bin/cp', ['-a', '--no-preserve=links', '--reflink=auto', '--', `${homePath}${sep}.`, stageHome])
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

async function performLifecycle({ operation, profile, homePath, dshExecutable, bwrapExecutable, targets }) {
  if (!['upgrade', 'uninstall'].includes(operation) || !PROFILE_NAME.test(profile) || !isAbsolute(homePath) || resolve(homePath) !== homePath) fail('invalid lifecycle invocation', 2)
  const transactionRoot = `${homePath}${TRANSACTION_SUFFIX}`
  await recoverBoundTransaction({ homePath, profile, transactionRoot })
  const homeLstat = await lstat(homePath).catch(() => undefined)
  if (homeLstat === undefined || !homeLstat.isDirectory() || homeLstat.isSymbolicLink() || resolve(homePath) === sep) {
    fail('DSH_HOME 必须是已存在的真实非根目录。')
  }
  const canonicalHome = await realpath(homePath)
  await assertNoMounts(homePath)
  await assertSnapshotTreeSafe(homePath, homePath, true)

  const current = await readProfile(homePath, profile)
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

  const parentStat = await stat(dirname(homePath))
  const originalStat = await stat(homePath)
  if (String(parentStat.dev) !== String(originalStat.dev)) fail('DSH_HOME 与事务目录不在同一文件系统，无法保证原子切换。')
  await mkdir(transactionRoot, { mode: 0o700 })
  await chmod(transactionRoot, 0o700)
  const stageHome = join(transactionRoot, 'staged-home')
  const backupHome = join(transactionRoot, 'original-home')
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
  manifest = await writeManifest(transactionRoot, manifest, 'preparing')

  let swapped = false
  let commitUncertain = false
  try {
    await copyHome(homePath, stageHome)
    const stagedStat = await stat(stageHome)
    manifest = await writeManifest(transactionRoot, { ...manifest, stagedIdentity: identity(stagedStat) }, 'prepared')
    const stagedProfile = await readProfile(stageHome, profile)
    const stagedCanonical = await realpath(stagedProfile.profilePath)
    if (!inside(await realpath(stageHome), stagedCanonical)) fail('staged profile 通过符号链接逃逸 DSH_HOME；拒绝继续。')

    const sandbox = { bwrapExecutable, stageHome, homePath, dshExecutable, profile, transactionId: manifest.id }
    await validateComposedConfig(sandbox, 'before')
    if (operation === 'upgrade') {
      await sandboxRun(sandbox, [dshExecutable, 'plugin', '--profile', profile, 'add', ...targets], {
        extraEnvironment: { npm_config_package_import_method: 'copy' },
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
    await assertSnapshotTreeSafe(stageHome, homePath)
    await run('/bin/sync', ['-f', stageHome])
    const validatedProfile = await readProfile(stageHome, profile)
    manifest = await writeManifest(transactionRoot, { ...manifest, stagedProfileDigest: sha256(validatedProfile.source) }, 'validated')

    await rename(homePath, backupHome)
    await fsyncPath(transactionRoot, true)
    await fsyncPath(dirname(homePath), true)
    manifest = await writeManifest(transactionRoot, manifest, 'original-renamed')
    await rename(stageHome, homePath)
    await fsyncPath(transactionRoot, true)
    await fsyncPath(dirname(homePath), true)
    swapped = true
    manifest = await writeManifest(transactionRoot, manifest, 'swapped')
    await assertProfileDigest(backupHome, profile, manifest.originalProfileDigest)
    commitUncertain = true
    manifest = await writeManifest(transactionRoot, manifest, 'committed')
    commitUncertain = false
    try {
      await assertProfileDigest(homePath, profile, manifest.stagedProfileDigest)
      await assertProfileDigest(backupHome, profile, manifest.originalProfileDigest)
      manifest = await writeManifest(transactionRoot, manifest, 'cleanup-started')
      await assertNoMounts(transactionRoot)
      await rm(backupHome, { recursive: true })
      await fsyncPath(transactionRoot, true)
      const cleanup = `${transactionRoot}.committed-${manifest.id}`
      await rename(transactionRoot, cleanup)
      await fsyncPath(dirname(transactionRoot), true)
      await assertNoMounts(cleanup)
      await rm(cleanup, { recursive: true })
      await fsyncPath(dirname(transactionRoot), true)
    } catch (cleanupError) {
      process.stderr.write(`profile 生命周期事务已提交，但旧备份清理未完成；下次持锁操作会继续清理：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`)
    }
    process.stdout.write(`profile 生命周期事务完成：${operation}；配置、凭据、Session 与任务状态均从离线副本保留。\n`)
  } catch (error) {
    const persisted = await loadManifest(transactionRoot, { homePath, profile }).catch(() => undefined)
    if (commitUncertain && persisted?.state === 'committed') {
      process.stderr.write(`profile 生命周期已提交但收尾状态无法确认；保留当前 home 与原始备份，请重新执行同一命令持锁恢复：${transactionRoot}\n`)
    } else if (swapped || await existingIdentity(backupHome) !== undefined) {
      try {
        await recoverBoundTransaction({ homePath, profile, transactionRoot })
        process.stderr.write('profile 生命周期事务失败：原 DSH_HOME 已恢复。\n')
      } catch (recoveryError) {
        process.stderr.write(`profile 生命周期事务失败且自动恢复未完成：${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}\n`)
      }
    } else {
      try { await writeManifest(transactionRoot, manifest, 'failed', { failure: error instanceof Error ? error.message : String(error) }) } catch {}
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
    fail('usage: lifecycle-profile.mjs <upgrade|uninstall|recover> <profile> <dsh-home> <dsh-executable> <bwrap-executable> [upgrade-targets...]', 2)
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
    await recoverBoundTransaction({ homePath, profile, transactionRoot: `${homePath}${TRANSACTION_SUFFIX}` })
    return
  }
  await performLifecycle({ operation, profile, homePath, dshExecutable, bwrapExecutable, targets })
}

main().catch(error => {
  process.stderr.write(`dsh-enhanced lifecycle: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = error instanceof LifecycleError ? error.exitCode : 1
})
