import { spawn } from 'node:child_process'
import { constants, createReadStream, type Stats } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readlink, realpath, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { hashLinuxRuntimeTree, linuxRuntimeDigest, validateLinuxRuntime, verifyLinuxRuntime, type LinuxRuntime } from '@dsh-enhanced/assistant-isolation'
import { behaviorSha256 as sha, LINUX_BEHAVIOR_COMPILE_FLAGS, loadLinuxBehaviorAssets, readBehaviorFile } from './linux-behavior-assets.js'
export { LINUX_BEHAVIOR_COMMAND } from './linux-behavior-assets.js'

export interface LinuxPluginBehaviorRuntime {
  schemaVersion: 1
  runtime: LinuxRuntime
  observer: { schemaVersion: 1; sourceSha256: string; workerSha256: string; candidateSha256: string;
    launcherSha256: string; parentProtectSha256: string; childProtectSha256: string }
}
interface Receipt {
  schemaVersion: 1
  descriptor: LinuxPluginBehaviorRuntime
  baseRuntimeDigest: string
  compilerSha256: string
  receiptDigest: string
}
const MAX_BYTES = 8 * 1024 * 1024 * 1024
const MAX_ENTRIES = 500_000
const HEX = /^[a-f0-9]{64}$/u
const env = { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C', SOURCE_DATE_EPOCH: '0' }
const within = (path: string, root: string): boolean => path === root || path.startsWith(root + '/')
const canonical = (path: unknown): path is string => typeof path === 'string' && isAbsolute(path)
  && path !== '/' && resolve(path) === path && ![...path].some(value => value.charCodeAt(0) < 32)
const stamp = (info: Stats): string => JSON.stringify([info.dev, info.ino, info.uid, info.mode, info.size, info.mtimeMs, info.ctimeMs])
function fail(message: string): never { throw new Error(`Linux behavior runtime: ${message}`) }
function plain(value: unknown, keys: string): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).sort().join() !== keys) return false
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(item => Object.hasOwn(item, 'value') && item.enumerable)
}
function plainData(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (!value || typeof value !== 'object' || seen.has(value) || Object.getPrototypeOf(value) !== Object.prototype) return false
  seen.add(value)
  const valid = Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return typeof key === 'string' && descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value') && plainData(descriptor.value, seen)
  })
  seen.delete(value)
  return valid
}

/** Shape-only validation. No file reads, subprocesses or authority are acquired. */
export function validateLinuxPluginBehaviorRuntime(value: unknown): LinuxPluginBehaviorRuntime {
  if (!plainData(value) || !plain(value, 'observer,runtime,schemaVersion') || value.schemaVersion !== 1
    || !plain(value.observer, 'candidateSha256,childProtectSha256,launcherSha256,parentProtectSha256,schemaVersion,sourceSha256,workerSha256')
    || value.observer.schemaVersion !== 1
    || Object.entries(value.observer).some(([key, item]) => key !== 'schemaVersion' && (typeof item !== 'string' || !HEX.test(item)))) fail('invalid descriptor')
  const runtime = validateLinuxRuntime(value.runtime)
  return Object.freeze({ schemaVersion: 1, runtime, observer: Object.freeze({ ...value.observer }) }) as LinuxPluginBehaviorRuntime
}
export function linuxPluginBehaviorRuntimeDigest(value: LinuxPluginBehaviorRuntime): string {
  return sha(JSON.stringify(validateLinuxPluginBehaviorRuntime(value)))
}

async function privateDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!canonical(path) || await realpath(path) !== path || !info.isDirectory() || info.uid !== process.getuid?.()
    || info.mode & 0o077) fail('unsafe private directory')
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
async function sync(path: string): Promise<void> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await fd.sync() } finally { await fd.close() }
}

/** Never follow a copy link or share an inode with the base toolchain. */
async function cloneRuntime(source: string, target: string, signal: AbortSignal): Promise<void> {
  let bytes = 0, entries = 0
  const visit = async (path: string): Promise<void> => {
    signal.throwIfAborted()
    if (++entries > MAX_ENTRIES) fail('clone entry bound exceeded')
    const before = await lstat(path), destination = join(target, relative(source, path))
    if (before.uid !== process.getuid?.() || !before.isSymbolicLink() && before.mode & 0o022) fail('unsafe base entry')
    if (before.isSymbolicLink()) {
      const link = await readlink(path)
      if (isAbsolute(link) || !within(await realpath(path), source)
        || !within(resolve(dirname(path), link), source)) fail('base link escaped')
      await symlink(link, destination)
    } else if (before.isDirectory()) {
      await mkdir(destination, { mode: 0o700 })
      await chmod(destination, 0o700)
      for (const name of (await readdir(path)).sort()) await visit(join(path, name))
    } else if (before.isFile() && before.nlink === 1) {
      if ((bytes += before.size) > MAX_BYTES) fail('clone byte bound exceeded')
      const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        if (stamp(await input.stat()) !== stamp(before) || await realpath(`/proc/self/fd/${input.fd}`) !== path) fail('base descriptor changed')
        const output = await open(destination, 'wx', 0o600)
        try {
          let copied = 0
          for await (const raw of createReadStream(path, { fd: input.fd, autoClose: false, highWaterMark: 65536 })) {
            signal.throwIfAborted()
            const chunk = raw as Buffer
            if ((copied += chunk.length) > before.size) fail('base file grew')
            let written = 0
            while (written < chunk.length) {
              const result = await output.write(chunk, written, chunk.length - written)
              if (!result.bytesWritten) fail('clone write stalled')
              written += result.bytesWritten
            }
          }
          if (copied !== before.size || stamp(await input.stat()) !== stamp(before)) fail('base file changed')
        } finally { await output.close() }
      } finally { await input.close() }
      await chmod(destination, before.mode & 0o111 ? 0o555 : 0o444)
    } else fail('base special or hardlinked entry')
    if (stamp(await lstat(path)) !== stamp(before)) fail('base changed during clone')
  }
  await visit(source)
}

/** Fixed compiler only, bounded streams, private process group, abort and deadline. */
async function compileCommand(args: string[], cwd: string, signal: AbortSignal, input = ''): Promise<string> {
  signal.throwIfAborted()
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn('/usr/bin/cc', args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let size = 0, failure: Error | undefined
    const kill = (error: Error): void => {
      failure ??= error
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* Already exited. */ } }
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
    }
    const abort = (): void => kill(new Error('compiler cancelled'))
    const timer = setTimeout(() => kill(new Error('compiler deadline exceeded')), 30_000)
    signal.addEventListener('abort', abort, { once: true })
    const collect = (chunk: Buffer): void => {
      if ((size += chunk.length) > 1024 * 1024) kill(new Error('compiler output bound exceeded'))
      else chunks.push(chunk)
    }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') kill(error) })
    child.once('error', error => { failure ??= error })
    child.once('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (failure || code !== 0) reject(failure ?? new Error(`compiler exit ${code}: ${Buffer.concat(chunks).toString('utf8')}`))
      else resolvePromise(Buffer.concat(chunks).toString('utf8'))
    })
    child.stdin.end(input)
    if (signal.aborted) abort()
  })
}

/** Check each symlink and ancestor, as well as the actual root-owned compiler/helper. */
async function systemFile(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path || !['/usr/', '/lib/', '/lib64/', '/bin/', '/etc/alternatives/'].some(root => path.startsWith(root))) fail('compiler path escaped system')
  const inspect = async (name: string): Promise<void> => {
    for (let current = name; ; current = dirname(current)) {
      const item = await lstat(current)
      if (item.uid !== 0 || !item.isSymbolicLink() && item.mode & 0o022) fail('unsafe compiler chain')
      if (current === '/') break
    }
  }
  await inspect(path)
  const resolved = await realpath(path)
  await inspect(resolved)
  const info = await lstat(resolved)
  if (!info.isFile() || info.nlink !== 1 || info.size > 128 * 1024 * 1024) fail('unsafe compiler helper')
  return sha(JSON.stringify([path, resolved, sha(await readBehaviorFile(resolved, 128 * 1024 * 1024))]))
}

async function compilerIdentity(source: string, cwd: string, signal: AbortSignal): Promise<string> {
  const files = new Set<string>(['/usr/bin/cc'])
  // Validate the driver before asking it to resolve any helpers.
  await systemFile('/usr/bin/cc')
  for (const name of ['cc1', 'collect2', 'as', 'ld']) {
    const path = (await compileCommand([`-print-prog-name=${name}`], cwd, signal)).trim()
    const resolved = isAbsolute(path) ? resolve(path) : join('/usr/bin', path)
    // No preprocessing/compilation runs before its executable chain is checked.
    await systemFile(resolved)
    files.add(resolved)
  }
  for (const name of ['crti.o', 'crtn.o', 'crtbegin.o', 'crtend.o', 'crtbeginS.o', 'crtendS.o', 'Scrt1.o', 'libc.so', 'libgcc.a', 'libgcc_s.so', 'liblto_plugin.so']) {
    const path = (await compileCommand([`-print-file-name=${name}`], cwd, signal)).trim()
    if (!isAbsolute(path)) fail('compiler dependency unavailable')
    files.add(resolve(path))
  }
  const includes = await compileCommand([...LINUX_BEHAVIOR_COMPILE_FLAGS, '-M', '-x', 'c', '-'], cwd, signal, source)
  for (const path of includes.replaceAll('\\\n', ' ').split(/\s+/u).slice(1).filter(Boolean)) files.add(resolve(path))
  const identity: string[] = []
  for (const path of [...files].sort()) { signal.throwIfAborted(); identity.push(await systemFile(path)) }
  return sha(JSON.stringify(identity))
}

async function relocate(base: LinuxRuntime, root: string, signal: AbortSignal): Promise<LinuxRuntime> {
  const info = await lstat(root)
  const path = (value: string): string => join(root, relative(base.root.path, value))
  return { ...base, root: { path: root, dev: info.dev, ino: info.ino, sha256: await hashLinuxRuntimeTree(root, signal) },
    nodePath: path(base.nodePath), pnpmPath: path(base.pnpmPath), nativePnpmPath: path(base.nativePnpmPath),
    nativePnpmRoot: path(base.nativePnpmRoot), modulesPath: path(base.modulesPath), storePath: path(base.storePath), cachePath: path(base.cachePath) }
}

/** Full tree and fixed-source checks precede every candidate use. Tree hashing
 * and fixed Node probes use the underlying runtime's bounded, cancellable checks. */
export async function verifyLinuxPluginBehaviorRuntime(value: LinuxPluginBehaviorRuntime, signal?: AbortSignal): Promise<LinuxPluginBehaviorRuntime> {
  signal?.throwIfAborted()
  const descriptor = validateLinuxPluginBehaviorRuntime(value)
  await verifyLinuxRuntime(descriptor.runtime, signal)
  signal?.throwIfAborted()
  const assets = await loadLinuxBehaviorAssets(), root = join(descriptor.runtime.root.path, 'dsh-plugin-verifier')
  await privateDirectory(root)
  if ((await readdir(root)).sort().join() !== 'candidate-launcher,candidate.mjs,child-protect.so,node_modules,parent-protect.so,plugins,worker.mjs') fail('observer inventory differs')
  if (descriptor.observer.sourceSha256 !== assets.sourceSha256) fail('observer fixed source differs')
  for (const [name, key, content] of [
    ['worker.mjs', 'workerSha256', assets.worker], ['candidate.mjs', 'candidateSha256', assets.candidate],
    ['candidate-launcher', 'launcherSha256', undefined], ['parent-protect.so', 'parentProtectSha256', undefined],
    ['child-protect.so', 'childProtectSha256', undefined],
  ] as const) {
    signal?.throwIfAborted()
    const bytes = await readBehaviorFile(join(root, name), 4 * 1024 * 1024)
    if (sha(bytes) !== descriptor.observer[key] || content !== undefined && !bytes.equals(Buffer.from(content))) fail('observer asset differs')
    const mode = (await lstat(join(root, name))).mode & 0o777
    if (mode !== (name.endsWith('.mjs') ? 0o444 : 0o555)) fail('observer asset mode differs')
  }
  for (const [path, target] of [['node_modules', '../node_modules'], ['plugins/assistant-verifier/node_modules', '../../../node_modules']] as const) {
    const name = join(root, path), info = await lstat(name)
    if (!info.isSymbolicLink() || await readlink(name) !== target
      || await realpath(name) !== await realpath(descriptor.runtime.modulesPath)) fail('observer modules differ')
  }
  signal?.throwIfAborted()
  return descriptor
}

/** Adoption rechecks the retained clone, not the expired build authority. The
 * independently signed preparation digest binds the original compiler/base
 * provenance; it does not assert that either is still installed. */
export async function verifyLinuxPluginBehaviorAdoptionRuntime(input: {
  runtime: LinuxPluginBehaviorRuntime; buildRuntimeDigest: string; preparationDigest: string; signal: AbortSignal
}): Promise<void> {
  input.signal.throwIfAborted()
  const expected = validateLinuxPluginBehaviorRuntime(input.runtime)
  const expectedDigest = linuxPluginBehaviorRuntimeDigest(expected)
  const { buildRuntimeDigest, preparationDigest } = input
  if (typeof buildRuntimeDigest !== 'string' || !HEX.test(buildRuntimeDigest)
    || typeof preparationDigest !== 'string' || !HEX.test(preparationDigest)) fail('invalid signed preparation identity')
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(120_000)])
  const root = dirname(expected.runtime.root.path)
  await privateDirectory(root)
  if ((await readdir(root)).sort().join() !== 'behavior.json,runtime') fail('receipt inventory differs')
  const receiptPath = join(root, 'behavior.json'), before = await lstat(receiptPath)
  if (before.uid !== process.getuid?.()) fail('unsafe preparation receipt')
  const raw = await readBehaviorFile(receiptPath, 1024 * 1024)
  const receipt = JSON.parse(raw.toString('utf8')) as Receipt
  if (!plain(receipt, 'baseRuntimeDigest,compilerSha256,descriptor,receiptDigest,schemaVersion') || receipt.schemaVersion !== 1
    || typeof receipt.compilerSha256 !== 'string' || !HEX.test(receipt.compilerSha256)
    || typeof receipt.baseRuntimeDigest !== 'string' || !HEX.test(receipt.baseRuntimeDigest)
    || typeof receipt.receiptDigest !== 'string' || !HEX.test(receipt.receiptDigest)) fail('invalid receipt')
  const { receiptDigest, ...content } = receipt
  const descriptor = validateLinuxPluginBehaviorRuntime(receipt.descriptor)
  if (receiptDigest !== sha(JSON.stringify(content)) || receiptDigest !== preparationDigest
    || receipt.baseRuntimeDigest !== buildRuntimeDigest
    || descriptor.runtime.root.path !== join(root, 'runtime')
    || linuxPluginBehaviorRuntimeDigest(descriptor) !== expectedDigest) fail('receipt identity differs')
  signal.throwIfAborted()
  await verifyLinuxPluginBehaviorRuntime(descriptor, signal)
  signal.throwIfAborted()
  if (!(await readBehaviorFile(receiptPath, 1024 * 1024)).equals(raw)
    || stamp(await lstat(receiptPath)) !== stamp(before)) fail('preparation receipt changed during verification')
  signal.throwIfAborted()
}

/** Read-only reopen for retained deployment observers whose build-time base
 * runtime is no longer installed. Receipt self-consistency, the live
 * descriptor identity and the observer tree checks still bind preparation;
 * the returned digests must be anchored to a freshly signed certificate. */
export async function readLinuxPluginBehaviorDeploymentPreparation(input: {
  runtime: LinuxPluginBehaviorRuntime; signal?: AbortSignal
}): Promise<{ descriptor: LinuxPluginBehaviorRuntime; baseRuntimeDigest: string; preparationDigest: string }> {
  input.signal?.throwIfAborted()
  const expected = validateLinuxPluginBehaviorRuntime(input.runtime)
  const expectedDigest = linuxPluginBehaviorRuntimeDigest(expected)
  const root = dirname(expected.runtime.root.path)
  await privateDirectory(root)
  if ((await readdir(root)).sort().join() !== 'behavior.json,runtime') fail('receipt inventory differs')
  const receiptPath = join(root, 'behavior.json'), before = await lstat(receiptPath)
  if (before.uid !== process.getuid?.()) fail('unsafe preparation receipt')
  const raw = await readBehaviorFile(receiptPath, 1024 * 1024)
  const receipt = JSON.parse(raw.toString('utf8')) as Receipt
  if (!plain(receipt, 'baseRuntimeDigest,compilerSha256,descriptor,receiptDigest,schemaVersion') || receipt.schemaVersion !== 1
    || typeof receipt.compilerSha256 !== 'string' || !HEX.test(receipt.compilerSha256)
    || typeof receipt.baseRuntimeDigest !== 'string' || !HEX.test(receipt.baseRuntimeDigest)
    || typeof receipt.receiptDigest !== 'string' || !HEX.test(receipt.receiptDigest)) fail('invalid receipt')
  const { receiptDigest, ...content } = receipt
  if (receiptDigest !== sha(JSON.stringify(content))) fail('receipt digest differs')
  const descriptor = validateLinuxPluginBehaviorRuntime(receipt.descriptor)
  if (descriptor.runtime.root.path !== join(root, 'runtime')
    || linuxPluginBehaviorRuntimeDigest(descriptor) !== expectedDigest) fail('receipt identity differs')
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(120_000)])
  await verifyLinuxPluginBehaviorRuntime(descriptor, signal)
  signal.throwIfAborted()
  if (!(await readBehaviorFile(receiptPath, 1024 * 1024)).equals(raw)
    || stamp(await lstat(receiptPath)) !== stamp(before)) fail('preparation receipt changed during verification')
  return { descriptor, baseRuntimeDigest: receipt.baseRuntimeDigest, preparationDigest: receipt.receiptDigest }
}

/** Read-only reopen; compiler, base and fixed-source drift invalidate reuse. */
export async function readLinuxPluginBehaviorPreparation(input: { runtime: LinuxRuntime; root: string; signal?: AbortSignal }): Promise<{
  descriptor: LinuxPluginBehaviorRuntime; baseRuntimeDigest: string; preparationDigest: string
}> {
  input.signal?.throwIfAborted()
  if (!plainData(input.runtime)) fail('invalid base runtime')
  const base = await verifyLinuxRuntime(input.runtime, input.signal)
  await privateDirectory(input.root)
  if ((await readdir(input.root)).sort().join() !== 'behavior.json,runtime') fail('receipt inventory differs')
  const receiptPath = join(input.root, 'behavior.json'), before = await lstat(receiptPath)
  if (before.uid !== process.getuid?.()) fail('unsafe preparation receipt')
  const raw = await readBehaviorFile(receiptPath, 1024 * 1024)
  const receipt = JSON.parse(raw.toString('utf8')) as Receipt
  if (!plain(receipt, 'baseRuntimeDigest,compilerSha256,descriptor,receiptDigest,schemaVersion') || receipt.schemaVersion !== 1) fail('invalid receipt')
  const { receiptDigest, ...content } = receipt
  if (receiptDigest !== sha(JSON.stringify(content)) || receipt.baseRuntimeDigest !== linuxRuntimeDigest(base)
    || receipt.descriptor.runtime.root.path !== join(input.root, 'runtime')) fail('receipt identity differs')
  const assets = await loadLinuxBehaviorAssets()
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(120_000)])
  if (receipt.compilerSha256 !== await compilerIdentity(assets.launcher, input.root, signal)) fail('compiler identity differs')
  const descriptor = await verifyLinuxPluginBehaviorRuntime(receipt.descriptor, signal)
  signal.throwIfAborted()
  if (!(await readBehaviorFile(receiptPath, 1024 * 1024)).equals(raw)
    || stamp(await lstat(receiptPath)) !== stamp(before)) fail('preparation receipt changed during verification')
  return { descriptor, baseRuntimeDigest: receipt.baseRuntimeDigest, preparationDigest: receipt.receiptDigest }
}

/** Descriptor-only compatibility wrapper over the same validated preparation. */
export async function readLinuxPluginBehaviorRuntime(input: { runtime: LinuxRuntime; root: string; signal?: AbortSignal }): Promise<LinuxPluginBehaviorRuntime> {
  return (await readLinuxPluginBehaviorPreparation(input)).descriptor
}

/** A separate private capability. Never rewrites base receipts, owner or budgets. */
async function prepareUnlocked(input: { runtime: LinuxRuntime; root: string; signal?: AbortSignal }): Promise<LinuxPluginBehaviorRuntime> {
  input.signal?.throwIfAborted()
  if (!canonical(input.root)) fail('invalid root')
  if (!plainData(input.runtime)) fail('invalid base runtime')
  const base = validateLinuxRuntime(input.runtime)
  if (within(input.root, base.root.path) || within(base.root.path, input.root)) fail('root overlaps base')
  await privateDirectory(dirname(input.root))
  if (await exists(input.root)) return await readLinuxPluginBehaviorRuntime(input)
  await verifyLinuxRuntime(base, input.signal)
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(1_200_000)])
  const stage = await mkdtemp(join(dirname(input.root), '.linux-behavior-stage-')), stageInfo = await lstat(stage)
  await chmod(stage, 0o700)
  let published = false
  try {
    const assets = await loadLinuxBehaviorAssets()
    const compilerSha256 = await compilerIdentity(assets.launcher, stage, signal)
    const root = join(stage, 'runtime')
    await cloneRuntime(base.root.path, root, signal)
    const observerRoot = join(root, 'dsh-plugin-verifier')
    await mkdir(observerRoot, { mode: 0o700 })
    await writeFile(join(observerRoot, 'worker.mjs'), assets.worker, { flag: 'wx', mode: 0o444 })
    await writeFile(join(observerRoot, 'candidate.mjs'), assets.candidate, { flag: 'wx', mode: 0o444 })
    await symlink('../node_modules', join(observerRoot, 'node_modules'))
    await mkdir(join(observerRoot, 'plugins'), { mode: 0o700 })
    await mkdir(join(observerRoot, 'plugins', 'assistant-verifier'), { mode: 0o700 })
    await symlink('../../../node_modules', join(observerRoot, 'plugins', 'assistant-verifier', 'node_modules'))
    const hashes: string[] = []
    for (const [name, flags] of [['candidate-launcher', []], ['parent-protect.so', ['-fPIC', '-shared', '-DDSH_PARENT_PRELOAD']],
      ['child-protect.so', ['-fPIC', '-shared', '-DDSH_CHILD_PRELOAD']]] as const) {
      const path = join(observerRoot, name)
      await compileCommand([...LINUX_BEHAVIOR_COMPILE_FLAGS, ...flags, '-x', 'c', '-', '-o', path], stage, signal, assets.launcher)
      await chmod(path, 0o555)
      hashes.push(sha(await readBehaviorFile(path, 4 * 1024 * 1024)))
    }
    if (compilerSha256 !== await compilerIdentity(assets.launcher, stage, signal)) fail('compiler changed during preparation')
    if (linuxRuntimeDigest(await verifyLinuxRuntime(base, signal)) !== linuxRuntimeDigest(base)) fail('base changed')
    const runtime = await relocate(base, root, signal)
    const finalRoot = join(input.root, 'runtime')
    const rewrite = (path: string): string => join(finalRoot, relative(root, path))
    const finalRuntime: LinuxRuntime = { ...runtime, root: { ...runtime.root, path: finalRoot },
      nodePath: rewrite(runtime.nodePath), pnpmPath: rewrite(runtime.pnpmPath), nativePnpmPath: rewrite(runtime.nativePnpmPath),
      nativePnpmRoot: rewrite(runtime.nativePnpmRoot), modulesPath: rewrite(runtime.modulesPath),
      storePath: rewrite(runtime.storePath), cachePath: rewrite(runtime.cachePath) }
    const descriptor: LinuxPluginBehaviorRuntime = { schemaVersion: 1, runtime: finalRuntime, observer: { schemaVersion: 1,
      sourceSha256: assets.sourceSha256, workerSha256: sha(assets.worker), candidateSha256: sha(assets.candidate),
      launcherSha256: hashes[0]!, parentProtectSha256: hashes[1]!, childProtectSha256: hashes[2]! } }
    const content = { schemaVersion: 1 as const, descriptor, baseRuntimeDigest: linuxRuntimeDigest(base), compilerSha256 }
    await writeFile(join(stage, 'behavior.json'), JSON.stringify({ ...content, receiptDigest: sha(JSON.stringify(content)) }) + '\n', { flag: 'wx', mode: 0o444 })
    await sync(join(stage, 'behavior.json')); await sync(root); await sync(stage)
    signal.throwIfAborted()
    if (await exists(input.root)) fail('root appeared during preparation')
    await rename(stage, input.root); published = true; await sync(dirname(input.root))
    return await readLinuxPluginBehaviorRuntime(input)
  } catch (error) {
    if (published) {
      const current = await lstat(input.root)
      if (current.dev !== stageInfo.dev || current.ino !== stageInfo.ino || current.uid !== process.getuid?.()) fail('published root replaced; cleanup refused')
      await rm(input.root, { recursive: true, force: true })
    }
    throw error
  } finally {
    if (await exists(stage)) {
      const current = await lstat(stage)
      if (current.dev !== stageInfo.dev || current.ino !== stageInfo.ino || current.uid !== process.getuid?.()) fail('stage replaced; cleanup refused')
      await rm(stage, { recursive: true, force: true })
    }
  }
}

/** A private sibling lock excludes concurrent preparations through this API.
 * A crash leaves the lock closed for owner inspection. Like the base bootstrap,
 * this does not isolate a hostile Host running under the same OS user. */
export async function prepareLinuxPluginBehaviorRuntime(input: { runtime: LinuxRuntime; root: string; signal?: AbortSignal }): Promise<LinuxPluginBehaviorRuntime> {
  input.signal?.throwIfAborted()
  if (!canonical(input.root)) fail('invalid root')
  await privateDirectory(dirname(input.root))
  const lock = join(dirname(input.root), `.${basename(input.root)}.linux-behavior-lock`)
  await mkdir(lock, { mode: 0o700 })
  const identity = await lstat(lock)
  try {
    await privateDirectory(lock)
    return await prepareUnlocked(input)
  } finally {
    const current = await lstat(lock)
    if (current.dev !== identity.dev || current.ino !== identity.ino || current.uid !== process.getuid?.()) fail('lock replaced; cleanup refused')
    await rmdir(lock)
  }
}
