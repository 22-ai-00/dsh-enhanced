import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { constants } from 'node:fs'
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

/** A frozen, owner-private Linux toolchain. No Docker identity is part of this contract. */
export interface LinuxRuntime {
  schemaVersion: 1
  backend: 'linux-native'
  platform: 'linux-x64' | 'linux-arm64'
  sourceCommit: string
  lockSha256: string
  root: { path: string; dev: number; ino: number; sha256: string }
  nodePath: string
  nodeSha256: string
  pnpmPath: string
  nativePnpmPath: string
  nativePnpmRoot: string
  modulesPath: string
  storePath: string
  cachePath: string
  versions: { node: 'v22.23.2'; pnpm: '11.7.0'; typescript: string; cordis: string;
    tools: string; systemPrompt: string }
}

const HEX = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const MAX_ENTRIES = 500_000
const MAX_BYTES = 8 * 1024 * 1024 * 1024
const execFileAsync = promisify(execFile)
const canonical = (value: unknown): value is string => typeof value === 'string'
  && isAbsolute(value) && resolve(value) === value && !value.includes('\r')
  && !value.includes('\n') && !value.includes('\0')
const within = (path: string, root: string): boolean => path === root || path.startsWith(root + sep)
const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

export function validateLinuxRuntime(value: unknown): LinuxRuntime {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid Linux runtime')
  const item = value as LinuxRuntime
  if (Object.keys(item).sort().join() !== 'backend,cachePath,lockSha256,modulesPath,nativePnpmPath,nativePnpmRoot,nodePath,nodeSha256,platform,pnpmPath,root,schemaVersion,sourceCommit,storePath,versions'
    || item.schemaVersion !== 1 || item.backend !== 'linux-native'
    || item.platform !== `linux-${process.arch}` || !COMMIT.test(item.sourceCommit)
    || item.sourceCommit === '0'.repeat(40)
    || !HEX.test(item.lockSha256) || !HEX.test(item.nodeSha256)
    || !item.root || Object.keys(item.root).sort().join() !== 'dev,ino,path,sha256'
    || !canonical(item.root.path) || item.root.path === '/'
    || !Number.isSafeInteger(item.root.dev) || item.root.dev < 0
    || !Number.isSafeInteger(item.root.ino) || item.root.ino < 0 || !HEX.test(item.root.sha256)
    || [item.nodePath, item.pnpmPath, item.nativePnpmPath, item.nativePnpmRoot,
      item.modulesPath, item.storePath, item.cachePath]
      .some(path => !canonical(path) || !within(path, item.root.path) || path === item.root.path)
    || item.nodePath !== join(item.root.path, 'bin', 'node')
    || item.pnpmPath !== join(item.root.path, 'pnpm', 'bin', 'pnpm.mjs')
    || item.nativePnpmRoot !== join(item.root.path, 'pnpm-native')
    || item.nativePnpmPath !== join(item.nativePnpmRoot, 'pnpm')
    || item.modulesPath !== join(item.root.path, 'node_modules')
    || item.storePath !== join(item.root.path, 'store')
    || item.cachePath !== join(item.root.path, 'cache')
    || !item.versions || Object.keys(item.versions).sort().join() !== 'cordis,node,pnpm,systemPrompt,tools,typescript'
    || item.versions.node !== 'v22.23.2' || item.versions.pnpm !== '11.7.0'
    || ['typescript', 'cordis', 'tools', 'systemPrompt'].some(key => {
      const version = item.versions[key as 'typescript' | 'cordis' | 'tools' | 'systemPrompt']
      return typeof version !== 'string' || version.length < 1 || version.length > 128
    })) throw new Error('invalid Linux runtime')
  return Object.freeze({ ...item, root: Object.freeze({ ...item.root }), versions: Object.freeze({ ...item.versions }) })
}

/** Hash paths, metadata and bytes; links are recorded but never followed during traversal. */
export async function hashLinuxRuntimeTree(root: string): Promise<string> {
  if (!canonical(root) || await realpath(root) !== root) throw new Error('noncanonical Linux runtime root')
  const base = await lstat(root)
  if (!base.isDirectory() || base.isSymbolicLink() || base.uid !== process.getuid?.()) throw new Error('unsafe Linux runtime root')
  let count = 0, bytes = 0
  const hash = createHash('sha256')
  const visit = async (path: string): Promise<void> => {
    if (++count > MAX_ENTRIES) throw new Error('Linux runtime entry limit')
    const item = await lstat(path)
    if (item.uid !== process.getuid?.()) throw new Error('Linux runtime owner mismatch')
    const name = relative(root, path).split(sep).join('/')
    if (item.isSymbolicLink()) {
      const target = await realpath(path)
      if (!within(target, root)) throw new Error('Linux runtime link escaped root')
      hash.update(JSON.stringify(['link', name, relative(root, target).split(sep).join('/')]) + '\n')
    } else if (item.isDirectory()) {
      if (item.mode & 0o022) throw new Error('Linux runtime writable directory')
      hash.update(JSON.stringify(['dir', name, item.mode & 0o777]) + '\n')
      for (const child of (await readdir(path)).sort()) await visit(join(path, child))
      const after = await lstat(path)
      if (after.dev !== item.dev || after.ino !== item.ino || !after.isDirectory()) throw new Error('Linux runtime directory changed')
    } else if (item.isFile() && item.nlink === 1) {
      if (item.mode & 0o022 || (bytes += item.size) > MAX_BYTES) throw new Error('Linux runtime file bound')
      const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      let fileDigest: string
      try {
        const opened = await descriptor.stat()
        if (!opened.isFile() || opened.dev !== item.dev || opened.ino !== item.ino || opened.size !== item.size) throw new Error('Linux runtime file changed')
        const fileHash = createHash('sha256')
        for await (const chunk of createReadStream(path, { fd: descriptor.fd, autoClose: false })) fileHash.update(chunk as Buffer)
        const after = await descriptor.stat()
        if (after.dev !== item.dev || after.ino !== item.ino || after.size !== item.size || after.mtimeMs !== item.mtimeMs) throw new Error('Linux runtime file changed')
        fileDigest = fileHash.digest('hex')
      } finally { await descriptor.close() }
      const named = await lstat(path)
      if (named.dev !== item.dev || named.ino !== item.ino || !named.isFile()) throw new Error('Linux runtime path changed')
      hash.update(JSON.stringify(['file', name, item.mode & 0o777, item.size, fileDigest]) + '\n')
    } else throw new Error('Linux runtime special or linked file')
  }
  await visit(root)
  return hash.digest('hex')
}

export function linuxRuntimeDigest(value: LinuxRuntime): string {
  return digest(JSON.stringify(validateLinuxRuntime(value)))
}

/** Perform the full tree check before giving a candidate access to the toolchain. */
export async function verifyLinuxRuntime(value: LinuxRuntime): Promise<LinuxRuntime> {
  const runtime = validateLinuxRuntime(value)
  if (process.platform !== 'linux') throw new Error('Linux runtime requires Linux')
  if (await realpath(runtime.root.path) !== runtime.root.path) throw new Error('Linux runtime root moved')
  const root = await lstat(runtime.root.path)
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid?.()
    || root.dev !== runtime.root.dev || root.ino !== runtime.root.ino
    || await hashLinuxRuntimeTree(runtime.root.path) !== runtime.root.sha256) throw new Error('Linux runtime root differs')
  const node = await lstat(runtime.nodePath)
  if (!node.isFile() || node.isSymbolicLink() || node.nlink !== 1 || node.mode & 0o022
    || await realpath(runtime.nodePath) !== runtime.nodePath
    || digest(await readFile(runtime.nodePath)) !== runtime.nodeSha256) throw new Error('Linux runtime Node differs')
  for (const [key, name] of [['typescript', 'typescript'], ['cordis', '@deepseek-ai/cordis'],
    ['tools', '@deepseek-ai/dsh-tools'], ['systemPrompt', '@deepseek-ai/dsh-system-prompt']] as const) {
    const path = join(runtime.modulesPath, name, 'package.json')
    if (!within(await realpath(path), runtime.root.path)) throw new Error('Linux runtime package escaped root')
    const manifest = JSON.parse(await readFile(path, 'utf8')) as { version?: string }
    if (manifest.version !== runtime.versions[key]) throw new Error('Linux runtime package version differs')
  }
  const nativePnpm = await lstat(runtime.nativePnpmPath)
  if (!nativePnpm.isFile() || nativePnpm.isSymbolicLink() || nativePnpm.nlink !== 1
    || nativePnpm.mode & 0o022 || await realpath(runtime.nativePnpmPath) !== runtime.nativePnpmPath) {
    throw new Error('Linux runtime native pnpm differs')
  }
  const releaseNodePath = join(runtime.nativePnpmRoot, 'node')
  const releaseNode = await lstat(releaseNodePath)
  if (!releaseNode.isFile() || releaseNode.isSymbolicLink() || releaseNode.nlink !== 1
    || releaseNode.mode & 0o022 || await realpath(releaseNodePath) !== releaseNodePath
    || digest(await readFile(releaseNodePath)) !== runtime.nodeSha256) {
    throw new Error('Linux runtime release Node differs')
  }
  const nativeManifest = JSON.parse(await readFile(join(runtime.nativePnpmRoot, 'package.json'), 'utf8')) as {
    name?: string; version?: string }
  if (nativeManifest.name !== '@pnpm/exe' || nativeManifest.version !== runtime.versions.pnpm) {
    throw new Error('Linux runtime native pnpm package differs')
  }
  const lock = await readFile(join(runtime.root.path, 'pnpm-lock.yaml'))
  if (digest(lock) !== runtime.lockSha256) throw new Error('Linux runtime lock differs')
  const env = { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C' }
  const [observedNode, observedPnpm, observedNativePnpm, observedReleaseNode] = await Promise.all([
    execFileAsync(runtime.nodePath, ['--version'], { timeout: 5_000, maxBuffer: 1024, env }),
    execFileAsync(runtime.nodePath, [runtime.pnpmPath, '--version'], { timeout: 5_000, maxBuffer: 1024, env }),
    execFileAsync(runtime.nativePnpmPath, ['--version'], { timeout: 5_000, maxBuffer: 1024, env }),
    execFileAsync(releaseNodePath, ['--version'], { timeout: 5_000, maxBuffer: 1024, env }),
  ])
  if (observedNode.stdout.trim() !== runtime.versions.node
    || observedPnpm.stdout.trim() !== runtime.versions.pnpm
    || observedNativePnpm.stdout.trim() !== runtime.versions.pnpm
    || observedReleaseNode.stdout.trim() !== runtime.versions.node) {
    throw new Error('Linux runtime executable version differs')
  }
  return runtime
}
