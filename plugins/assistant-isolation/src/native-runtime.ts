import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

export interface NativeMacRuntime {
  schemaVersion: 1
  platform: 'darwin-arm64' | 'darwin-x64'
  nodePath: string
  nodeSha256: string
  roots: Array<{ path: string; dev: number; ino: number; sha256: string }>
  modulesPath: string
  versions: { node: string; typescript: string; cordis: string; tools: string; systemPrompt: string }
}

const hex = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const canonical = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value) && resolve(value) === value
  && !value.includes('\0') && !value.includes('\r') && !value.includes('\n')
const within = (path: string, root: string): boolean => path === root || path.startsWith(root + sep)
const MAX_ENTRIES = 200_000
const MAX_BYTES = 2 * 1024 * 1024 * 1024
const execFileAsync = promisify(execFile)

/** Pure, synchronous shape check; no filesystem state is trusted by this check. */
export function validateNativeMacRuntime(value: unknown): NativeMacRuntime {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid native runtime')
  const runtime = value as NativeMacRuntime
  if (Object.keys(runtime).sort().join() !== 'modulesPath,nodePath,nodeSha256,platform,roots,schemaVersion,versions'
    || runtime.schemaVersion !== 1 || runtime.platform !== `darwin-${process.arch}` || !canonical(runtime.nodePath)
    || !hex(runtime.nodeSha256) || !canonical(runtime.modulesPath) || !Array.isArray(runtime.roots)
    || runtime.roots.length < 1 || runtime.roots.length > 32 || !runtime.versions || typeof runtime.versions !== 'object'
    || Object.keys(runtime.versions).sort().join() !== 'cordis,node,systemPrompt,tools,typescript'
    || Object.values(runtime.versions).some(version => typeof version !== 'string' || version.length < 1 || version.length > 128)
    || runtime.roots.some(root => !root || Object.keys(root).sort().join() !== 'dev,ino,path,sha256'
      || !canonical(root.path) || root.path === '/' || !Number.isSafeInteger(root.dev) || root.dev < 0
      || !Number.isSafeInteger(root.ino) || root.ino < 0 || !hex(root.sha256))
    || new Set(runtime.roots.map(root => root.path)).size !== runtime.roots.length
    || !runtime.roots.some(root => within(runtime.nodePath, root.path) && runtime.nodePath !== root.path)
    || !runtime.roots.some(root => within(runtime.modulesPath, root.path))) throw new Error('invalid native runtime')
  return Object.freeze({ ...runtime, roots: runtime.roots.map(root => Object.freeze({ ...root })), versions: Object.freeze({ ...runtime.versions }) })
}

/** Hash sorted path/type/mode/content records. Internal symlinks are recorded, not followed. */
export async function hashNativeMacRuntimeTree(root: string): Promise<string> {
  if (!canonical(root) || await realpath(root) !== root) throw new Error('noncanonical native runtime root')
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory()) throw new Error('invalid native runtime root')
  let entries = 0; let bytes = 0
  const hash = createHash('sha256')
  const visit = async (path: string): Promise<void> => {
    if (++entries > MAX_ENTRIES) throw new Error('native runtime entry limit')
    const info = await lstat(path)
    if (info.uid !== process.getuid?.()) throw new Error('native runtime entry owner mismatch')
    const name = relative(root, path).split(sep).join('/')
    if (info.isSymbolicLink()) {
      const target = await realpath(path)
      if (!within(target, root)) throw new Error('native runtime external symlink')
      hash.update(JSON.stringify(['link', name, relative(root, target).split(sep).join('/')]) + '\n')
    } else if (info.isDirectory()) {
      if ((info.mode & 0o022) !== 0) throw new Error('writable native runtime entry')
      hash.update(JSON.stringify(['dir', name, info.mode & 0o777]) + '\n')
      for (const child of (await readdir(path)).sort()) await visit(join(path, child))
    } else if (info.isFile() && info.nlink === 1) {
      if ((info.mode & 0o022) !== 0) throw new Error('writable native runtime entry')
      bytes += info.size
      if (bytes > MAX_BYTES) throw new Error('native runtime byte limit')
      const file = createHash('sha256')
      for await (const chunk of createReadStream(path)) file.update(chunk as Buffer)
      hash.update(JSON.stringify(['file', name, info.mode & 0o777, info.size, file.digest('hex')]) + '\n')
    } else throw new Error('native runtime special or linked file')
  }
  await visit(root)
  return hash.digest('hex')
}

export function nativeMacRuntimeDigest(value: NativeMacRuntime): string {
  const runtime = validateNativeMacRuntime(value)
  return createHash('sha256').update(JSON.stringify(runtime)).digest('hex')
}

/** Recheck each approved root, executable and package version before dispatch. */
export async function verifyNativeMacRuntime(value: NativeMacRuntime): Promise<NativeMacRuntime> {
  const runtime = validateNativeMacRuntime(value)
  if (process.platform !== 'darwin') throw new Error('native runtime requires macOS')
  for (const root of runtime.roots) {
    if (await realpath(root.path) !== root.path) throw new Error('native runtime root moved')
    const info = await lstat(root.path)
    if (!info.isDirectory() || info.uid !== process.getuid?.() || info.dev !== root.dev || info.ino !== root.ino
      || await hashNativeMacRuntimeTree(root.path) !== root.sha256) throw new Error('native runtime root mismatch')
  }
  const nodeInfo = await lstat(runtime.nodePath)
  if (!nodeInfo.isFile() || nodeInfo.nlink !== 1 || (nodeInfo.mode & 0o022) !== 0
    || await realpath(runtime.nodePath) !== runtime.nodePath
    || createHash('sha256').update(await readFile(runtime.nodePath)).digest('hex') !== runtime.nodeSha256) throw new Error('native runtime Node mismatch')
  if (await realpath(runtime.modulesPath) !== runtime.modulesPath || !(await lstat(runtime.modulesPath)).isDirectory()) throw new Error('native runtime modules mismatch')
  const packages = { typescript: 'typescript', cordis: '@deepseek-ai/cordis', tools: '@deepseek-ai/dsh-tools', systemPrompt: '@deepseek-ai/dsh-system-prompt' }
  for (const [name, packageName] of Object.entries(packages)) {
    const file = join(runtime.modulesPath, packageName, 'package.json')
    if (!within(await realpath(file), runtime.roots.find(root => within(runtime.modulesPath, root.path))!.path)) throw new Error('native runtime package escaped root')
    const manifest = JSON.parse(await readFile(file, 'utf8')) as { version?: string }
    if (manifest.version !== runtime.versions[name as keyof typeof packages]) throw new Error('native runtime package version mismatch')
  }
  const observedNode = await execFileAsync(runtime.nodePath, ['--version'], {
    timeout: 5_000, maxBuffer: 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, windowsHide: true,
  })
  if (observedNode.stdout.trim() !== runtime.versions.node) throw new Error('native Node version mismatch')
  return runtime
}
