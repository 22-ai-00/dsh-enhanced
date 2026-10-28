import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants, createReadStream, type Stats } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import { hashLinuxRuntimeTree, prepareLinuxSystemSnapshot, readLinuxUserNamespaceMapping, verifyLinuxRuntime,
  verifyLinuxSystemSnapshotRuntimeDependencies, verifyLinuxUserNamespaceMapping, type LinuxRuntime, type LinuxSystemSnapshot,
  type LinuxUserNamespaceMapping } from '@dsh-enhanced/assistant-isolation'
import { NODE_ARCHIVES, NODE_VERSION, officialArchive, prepareLinuxRsiRuntime, readLinuxRsiRuntime,
  type LinuxRsiBootstrapInput } from './rsi-linux-runtime-bootstrap.js'

export interface LinuxRsiRepositoryBuildEnvironment {
  schemaVersion: 4
  backend: 'linux-native'
  sourceCommit: string
  lockSha256: string
  runtime: LinuxRuntime
  systemSnapshot: LinuxSystemSnapshot
  userNamespace: LinuxUserNamespaceMapping
}
interface Receipt extends LinuxRsiRepositoryBuildEnvironment {
  dshHome: string
  profile: string
  ownerUid: number
  ownerGid: number
  sourceDigest: string
  baseRuntimeDigest: string
  runtimeDigest: string
  systemSnapshotDigest: string
  userNamespaceDigest: string
  nodeArchiveDigest: string
  npmVersion: string
  receiptDigest: string
}
const MAX_BYTES = 8 * 1024 * 1024 * 1024
const MAX_ENTRIES = 500_000
const MAX_NPM_BYTES = 64 * 1024 * 1024
const MAX_NPM_ENTRIES = 8192
const exec = promisify(execFile)
const sha = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')
const digest = (value: unknown): string => sha(JSON.stringify(value))
const canonical = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value)
  && resolve(value) === value && ![...value].some(character => character.charCodeAt(0) < 32)
const within = (path: string, root: string): boolean => path === root || path.startsWith(root + '/')
const stamp = (value: Stats): string => JSON.stringify([value.dev, value.ino, value.uid, value.mode, value.size, value.mtimeMs, value.ctimeMs])
const env = { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C', COPYFILE_DISABLE: '1' }
function fail(message: string): never { throw new Error(`rsi Linux repository runtime: ${message}`) }

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

/** Copy bytes rather than hardlinks; preserve only links that remain inside the clone. */
async function cloneRuntime(source: string, target: string, signal: AbortSignal): Promise<void> {
  let bytes = 0, entries = 0
  const visit = async (path: string): Promise<void> => {
    signal.throwIfAborted()
    if (++entries > MAX_ENTRIES) fail('runtime entry bound exceeded')
    const before = await lstat(path), destination = join(target, relative(source, path))
    if (before.uid !== process.getuid?.() || !before.isSymbolicLink() && before.mode & 0o022) fail('unsafe base runtime entry')
    if (before.isSymbolicLink()) {
      const link = await readlink(path)
      const resolved = await realpath(path)
      if (isAbsolute(link) || !within(resolved, source) || !within(resolve(dirname(path), link), source)) fail('base runtime link escaped')
      await symlink(link, destination)
    } else if (before.isDirectory()) {
      await mkdir(destination, { mode: 0o755 })
      await chmod(destination, 0o755)
      for (const name of (await readdir(path)).sort()) await visit(join(path, name))
    } else if (before.isFile() && before.nlink === 1) {
      if ((bytes += before.size) > MAX_BYTES) fail('runtime byte bound exceeded')
      const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        if (stamp(await fd.stat()) !== stamp(before) || await realpath(`/proc/self/fd/${fd.fd}`) !== path) fail('base runtime descriptor changed')
        const output = await open(destination, 'wx', 0o600)
        try {
          let copied = 0
          for await (const raw of createReadStream(path, { fd: fd.fd, autoClose: false, highWaterMark: 65536 })) {
            signal.throwIfAborted()
            const chunk = raw as Buffer
            if ((copied += chunk.length) > before.size) fail('base runtime file grew')
            let written = 0
            while (written < chunk.length) {
              const result = await output.write(chunk, written, chunk.length - written)
              if (!result.bytesWritten) fail('runtime copy stalled')
              written += result.bytesWritten
            }
          }
          if (copied !== before.size || stamp(await fd.stat()) !== stamp(before)) fail('base runtime file changed')
        } finally { await output.close() }
      } finally { await fd.close() }
      await chmod(destination, before.mode & 0o111 ? 0o555 : 0o444)
    } else fail('special or hardlinked base runtime entry')
    if (stamp(await lstat(path)) !== stamp(before)) fail('base runtime changed during clone')
  }
  await visit(source)
}

async function npmArchive(root: string, archive: string, stage: string, signal: AbortSignal): Promise<string> {
  const prefix = `node-${NODE_VERSION}-linux-${process.arch}/lib/node_modules/npm`
  const listing = await exec('/usr/bin/tar', ['-tzvf', archive, '--numeric-owner', prefix], {
    cwd: stage, env, signal, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  })
  let bytes = 0, entries = 0
  for (const line of listing.stdout.trimEnd().split('\n')) {
    const entry = /^([dl-])[rwxstST-]{9}\s+[0-9]+\/[0-9]+\s+([0-9]+)\s+[0-9-]+\s+[0-9:]+\s+(.+)$/u.exec(line)
    if (!entry || ++entries > MAX_NPM_ENTRIES || (bytes += Number(entry[2])) > MAX_NPM_BYTES) fail('npm archive inventory exceeds bound')
    const name = entry[3]!.split(' -> ')[0]!.replace(/\/$/u, '')
    if (!name.startsWith(prefix) || name !== prefix && !name.startsWith(prefix + '/')
      || name.split('/').some(part => !part || part === '.' || part === '..')) fail('npm archive path escaped')
    if (entry[1] === 'l') {
      const link = entry[3]!.split(' -> ')[1]
      if (!link || isAbsolute(link) || !within(resolve('/', dirname(name), link), '/' + prefix)) fail('npm archive link escaped')
    }
  }
  if (!entries || !bytes) fail('npm archive empty')
  // The full archive is digest-checked before listing or extracting; only this
  // fixed official subtree is selected, with ownership and permissions stripped.
  await exec('/usr/bin/tar', ['-xzf', archive, '--no-same-owner', '--no-same-permissions', '--strip-components=1', '-C', root, prefix],
    { cwd: stage, env, signal, timeout: 120_000, maxBuffer: 1024 * 1024 })
  const npmRoot = join(root, 'lib', 'node_modules', 'npm')
  let actualBytes = 0, actualEntries = 0
  const normalize = async (path: string): Promise<void> => {
    signal.throwIfAborted()
    const info = await lstat(path)
    if (++actualEntries > MAX_NPM_ENTRIES || info.uid !== process.getuid?.()) fail('npm extraction inventory differs')
    if (info.isDirectory()) {
      for (const child of (await readdir(path)).sort()) await normalize(join(path, child))
      await chmod(path, 0o755)
    } else if (info.isFile() && info.nlink === 1) {
      if ((actualBytes += info.size) > MAX_NPM_BYTES) fail('npm extraction byte bound exceeded')
      await chmod(path, info.mode & 0o111 ? 0o555 : 0o444)
    } else if (info.isSymbolicLink()) {
      if (isAbsolute(await readlink(path)) || !within(await realpath(path), npmRoot)) fail('npm extraction link escaped')
    } else fail('npm extraction special or linked file')
  }
  await normalize(npmRoot)
  for (const path of [join(root, 'lib'), join(root, 'lib', 'node_modules')]) await chmod(path, 0o755)
  if (actualBytes !== bytes || actualEntries !== entries) fail('npm extraction inventory differs')
  for (const name of ['npm', 'npx']) await symlink(`../lib/node_modules/npm/bin/${name}-cli.js`, join(root, 'bin', name))
  const manifest = JSON.parse(await readFile(join(npmRoot, 'package.json'), 'utf8')) as { name: string; version: string }
  if (manifest.name !== 'npm' || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(manifest.version)) fail('npm manifest differs')
  for (const name of ['npm', 'npx']) {
    const result = await exec(join(root, 'bin', 'node'), [join(npmRoot, 'bin', `${name}-cli.js`), '--version'],
      { cwd: stage, env, signal, timeout: 5000, maxBuffer: 4096 })
    if (result.stdout.trim() !== manifest.version) fail('npm executable version differs')
  }
  return manifest.version
}

async function relocate(runtime: LinuxRuntime, path: string): Promise<LinuxRuntime> {
  const info = await lstat(path)
  const rewrite = (value: string): string => {
    if (!within(value, runtime.root.path)) fail('base runtime path escaped')
    return join(path, relative(runtime.root.path, value))
  }
  return { ...runtime, root: { path, dev: info.dev, ino: info.ino, sha256: await hashLinuxRuntimeTree(path) },
    nodePath: rewrite(runtime.nodePath), pnpmPath: rewrite(runtime.pnpmPath), nativePnpmRoot: rewrite(runtime.nativePnpmRoot),
    nativePnpmPath: rewrite(runtime.nativePnpmPath), modulesPath: rewrite(runtime.modulesPath),
    storePath: rewrite(runtime.storePath), cachePath: rewrite(runtime.cachePath) }
}
function environment(receipt: Receipt): LinuxRsiRepositoryBuildEnvironment {
  return { schemaVersion: 4, backend: 'linux-native', sourceCommit: receipt.sourceCommit, lockSha256: receipt.lockSha256,
    runtime: receipt.runtime, systemSnapshot: receipt.systemSnapshot, userNamespace: receipt.userNamespace }
}

async function readExisting(final: string, input: LinuxRsiBootstrapInput, base: LinuxRuntime,
  mapping: LinuxUserNamespaceMapping): Promise<LinuxRsiRepositoryBuildEnvironment> {
  await privateDirectory(final)
  if ((await readdir(final)).sort().join() !== 'bootstrap.json,runtime,system') fail('repository runtime inventory differs')
  const path = join(final, 'bootstrap.json'), info = await lstat(path)
  if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > 1024 * 1024) fail('unsafe repository receipt')
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let receipt: Receipt
  try {
    if (stamp(await fd.stat()) !== stamp(info)) fail('repository receipt changed')
    receipt = JSON.parse(await fd.readFile({ encoding: 'utf8' })) as Receipt
    if (stamp(await fd.stat()) !== stamp(info) || stamp(await lstat(path)) !== stamp(info)) fail('repository receipt changed')
  } finally { await fd.close() }
  const { receiptDigest, ...content } = receipt
  if (Object.keys(receipt).sort().join() !== 'backend,baseRuntimeDigest,dshHome,lockSha256,nodeArchiveDigest,npmVersion,ownerGid,ownerUid,profile,receiptDigest,runtime,runtimeDigest,schemaVersion,sourceCommit,sourceDigest,systemSnapshot,systemSnapshotDigest,userNamespace,userNamespaceDigest'
    || receiptDigest !== digest(content) || receipt.schemaVersion !== 4 || receipt.backend !== 'linux-native'
    || receipt.dshHome !== input.dshHome || receipt.profile !== input.profile || receipt.ownerUid !== process.getuid?.()
    || receipt.ownerGid !== process.getgid?.() || receipt.sourceDigest !== digest(input.source)
    || receipt.sourceCommit !== input.source.sourceCommit || receipt.lockSha256 !== base.lockSha256
    || receipt.baseRuntimeDigest !== digest(base) || receipt.runtimeDigest !== digest(receipt.runtime)
    || receipt.systemSnapshotDigest !== digest(receipt.systemSnapshot) || receipt.userNamespaceDigest !== digest(receipt.userNamespace)
    || receipt.nodeArchiveDigest !== NODE_ARCHIVES[process.arch as 'x64' | 'arm64']
    || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(receipt.npmVersion) || !isDeepStrictEqual(receipt.userNamespace, mapping)
    || receipt.runtime.root.path !== join(final, 'runtime') || receipt.systemSnapshot.root.path !== join(final, 'system')
    || receipt.runtime.sourceCommit !== receipt.sourceCommit || receipt.runtime.lockSha256 !== receipt.lockSha256) fail('repository receipt differs')
  await verifyLinuxSystemSnapshotRuntimeDependencies(receipt.systemSnapshot, receipt.runtime, input.signal)
  await verifyLinuxUserNamespaceMapping(receipt.userNamespace)
  const npm = JSON.parse(await readFile(join(receipt.runtime.root.path, 'lib', 'node_modules', 'npm', 'package.json'), 'utf8')) as { version: string }
  if (npm.version !== receipt.npmVersion) fail('npm receipt version differs')
  input.signal?.throwIfAborted()
  return environment(receipt)
}

/** Separate schema4 capability; no schema3 runtime, owner, ledger or grant is rewritten. */
export async function prepareLinuxRsiRepositoryRuntime(input: LinuxRsiBootstrapInput): Promise<LinuxRsiRepositoryBuildEnvironment> {
  input.signal?.throwIfAborted()
  if (!canonical(input.dshHome) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.profile)
    || input.source.schemaVersion !== 1) fail('invalid bootstrap identity')
  await privateDirectory(input.dshHome)
  const mapping = await readLinuxUserNamespaceMapping()
  const parent = join(input.dshHome, 'rsi-linux-repository-runtimes')
  await mkdir(parent, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  await privateDirectory(parent)
  const final = join(parent, input.profile)
  if (await exists(final)) {
    const base = await readLinuxRsiRuntime(input)
    return await readExisting(final, input, base.runtime, mapping)
  }
  const base = await prepareLinuxRsiRuntime(input)
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(1_200_000)])
  const stage = await mkdtemp(join(parent, `.${input.profile}-stage-`)), stageInfo = await lstat(stage)
  await chmod(stage, 0o700)
  try {
    const root = join(stage, 'runtime')
    await verifyLinuxRuntime(base.runtime)
    await cloneRuntime(base.runtime.root.path, root, signal)
    const archiveDigest = NODE_ARCHIVES[process.arch as 'x64' | 'arm64']
    const archive = await officialArchive(input.nodeArchivePath,
      `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${process.arch}.tar.gz`, archiveDigest, 100_000_000, stage, signal)
    const npmVersion = await npmArchive(root, archive, stage, signal)
    await rm(archive)
    const stagedRuntime = await relocate(base.runtime, root)
    const snapshot = await prepareLinuxSystemSnapshot(join(stage, 'system'), signal, stagedRuntime)
    await verifyLinuxSystemSnapshotRuntimeDependencies(snapshot, stagedRuntime, signal)
    await verifyLinuxUserNamespaceMapping(mapping)
    const latest = await readLinuxRsiRuntime(input)
    if (!isDeepStrictEqual(latest, base)) fail('base runtime changed before commit')
    signal.throwIfAborted()
    const runtimePath = join(final, 'runtime')
    const runtime: LinuxRuntime = { ...stagedRuntime, root: { ...stagedRuntime.root, path: runtimePath },
      nodePath: join(runtimePath, 'bin', 'node'), pnpmPath: join(runtimePath, 'pnpm', 'bin', 'pnpm.mjs'),
      nativePnpmRoot: join(runtimePath, 'pnpm-native'), nativePnpmPath: join(runtimePath, 'pnpm-native', 'pnpm'),
      modulesPath: join(runtimePath, 'node_modules'), storePath: join(runtimePath, 'store'), cachePath: join(runtimePath, 'cache') }
    const systemSnapshot: LinuxSystemSnapshot = { ...snapshot, root: { ...snapshot.root, path: join(final, 'system') } }
    const content: Omit<Receipt, 'receiptDigest'> = { schemaVersion: 4, backend: 'linux-native', sourceCommit: base.sourceCommit,
      lockSha256: base.lockSha256, runtime, systemSnapshot, userNamespace: mapping, dshHome: input.dshHome, profile: input.profile,
      ownerUid: process.getuid!(), ownerGid: process.getgid!(), sourceDigest: digest(input.source), baseRuntimeDigest: digest(base.runtime),
      runtimeDigest: digest(runtime), systemSnapshotDigest: digest(systemSnapshot), userNamespaceDigest: digest(mapping),
      nodeArchiveDigest: archiveDigest, npmVersion }
    await writeFile(join(stage, 'bootstrap.json'), JSON.stringify({ ...content, receiptDigest: digest(content) }) + '\n', { flag: 'wx', mode: 0o600 })
    await sync(join(stage, 'bootstrap.json')); await sync(root); await sync(stage)
    signal.throwIfAborted()
    if (await exists(final)) fail('repository runtime appeared during preparation')
    await rename(stage, final); await sync(parent)
    return await readExisting(final, input, base.runtime, mapping)
  } finally {
    if (await exists(stage)) {
      const current = await lstat(stage)
      if (current.dev !== stageInfo.dev || current.ino !== stageInfo.ino || current.uid !== process.getuid?.()) fail('stage replaced; cleanup refused')
      await rm(stage, { recursive: true, force: true })
    }
  }
}
