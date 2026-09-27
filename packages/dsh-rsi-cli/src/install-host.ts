import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { prepareManagedHostRuntime, readManagedHostRuntime, type ManagedHostRuntime } from './host-runtime.ts'
import { PurgeError } from './purge.ts'

const BINDING = '.dsh-rsi-host.json'
type Runtime = Awaited<ReturnType<typeof prepareManagedHostRuntime>>
interface HostBinding { schemaVersion: 1; cacheRoot: string; version: string; receiptDigest: string }
export interface InstallHostPorts {
  prepare: typeof prepareManagedHostRuntime
  read: typeof readManagedHostRuntime
}
const ports: InstallHostPorts = { prepare: prepareManagedHostRuntime, read: readManagedHostRuntime }

export interface HostUpdatePlan {
  schemaVersion: 1
  status: 'current' | 'update'
  canonicalHome: string
  bindingPath: string
  originalBindingSource: string
  originalBindingDigest: string
  originalRuntime: ManagedHostRuntime
  candidateRuntime: ManagedHostRuntime
  candidateBindingSource: string
}

function supportedVersion(version: string): boolean {
  const match = /^0\.1\.5(?:-rc\.([0-9]{1,6}))?$/u.exec(version)
  return match !== null && (match[1] === undefined || Number(match[1]) >= 3)
}

function versionRank(version: string): number {
  return version === '0.1.5' ? Number.MAX_SAFE_INTEGER : Number(/^0\.1\.5-rc\.([0-9]{1,6})$/u.exec(version)![1])
}

function sameRuntime(left: ManagedHostRuntime, right: ManagedHostRuntime): boolean {
  return left.version === right.version && left.root === right.root && left.dshPath === right.dshPath
    && left.binDirectory === right.binDirectory && left.integrity === right.integrity
    && left.receiptDigest === right.receiptDigest
}

async function readUpdateBinding(home: string): Promise<{ binding: HostBinding; bytes: Buffer; source: string; dev: number; ino: number }> {
  const path = join(home, BINDING)
  let file
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new PurgeError('DSH_HOME 没有私有 Host 绑定，不能准备受管更新。')
    throw error
  }
  try {
    const metadata = await file.stat()
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size < 1 || metadata.size > 16_384
      || (metadata.mode & 0o077) || process.getuid && metadata.uid !== process.getuid()) {
      throw new PurgeError('私有 Host 绑定文件不安全。')
    }
    const bytes = await file.readFile()
    let source: string
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { throw new PurgeError('私有 Host 绑定文件无效。') }
    if (!Buffer.from(source, 'utf8').equals(bytes)) throw new PurgeError('私有 Host 绑定文件无效。')
    let value: unknown
    try { value = JSON.parse(source) }
    catch { throw new PurgeError('私有 Host 绑定文件无效。') }
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'cacheRoot,receiptDigest,schemaVersion,version') {
      throw new PurgeError('私有 Host 绑定文件无效。')
    }
    const binding = value as HostBinding
    if (binding.schemaVersion !== 1 || typeof binding.cacheRoot !== 'string' || !isAbsolute(binding.cacheRoot)
      || resolve(binding.cacheRoot) !== binding.cacheRoot || typeof binding.version !== 'string'
      || !supportedVersion(binding.version) || typeof binding.receiptDigest !== 'string'
      || !/^[a-f0-9]{64}$/u.test(binding.receiptDigest)) throw new PurgeError('私有 Host 绑定文件无效。')
    return { binding, bytes, source, dev: metadata.dev, ino: metadata.ino }
  } finally { await file.close() }
}

/** Prepare and verify a candidate without changing the bound Home or its service. */
export async function prepareHostUpdatePlan(input: { dshHome: string; selector?: string; signal?: AbortSignal },
  dependencies: InstallHostPorts = ports): Promise<HostUpdatePlan> {
  input.signal?.throwIfAborted()
  const requested = resolve(input.dshHome)
  const entry = await lstat(requested).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new PurgeError('DSH_HOME 不存在，不能准备受管 Host 更新。')
    throw error
  })
  if (!entry.isDirectory() && !entry.isSymbolicLink()) throw new PurgeError('DSH_HOME 必须是目录。')
  const canonicalHome = await realpath(requested)
  await assertOwnedHome(canonicalHome)
  const original = await readUpdateBinding(canonicalHome)
  const originalRuntime = await dependencies.read({ root: original.binding.cacheRoot, version: original.binding.version,
    ...(input.signal === undefined ? {} : { signal: input.signal }) })
  if (originalRuntime.version !== original.binding.version || originalRuntime.root !== join(original.binding.cacheRoot, original.binding.version)
    || originalRuntime.receiptDigest !== original.binding.receiptDigest) {
    throw new PurgeError('已绑定的私有 Host 制品发生变化。')
  }
  input.signal?.throwIfAborted()
  const selector = input.selector ?? 'latest'
  if (selector !== 'latest' && !supportedVersion(selector)) throw new PurgeError('请求的 Host 版本不兼容。')
  if (selector !== 'latest' && versionRank(selector) < versionRank(original.binding.version)) throw new PurgeError('受管 Host 更新不能降级。')
  const preparedRuntime = await dependencies.prepare({ root: original.binding.cacheRoot, selector,
    ...(input.signal === undefined ? {} : { signal: input.signal }) })
  if (!supportedVersion(preparedRuntime.version) || selector !== 'latest' && preparedRuntime.version !== selector
    || !/^[a-f0-9]{64}$/u.test(preparedRuntime.receiptDigest)) throw new PurgeError('候选 Host 版本或收据无效。')
  if (versionRank(preparedRuntime.version) < versionRank(original.binding.version)) throw new PurgeError('受管 Host 更新不能降级。')
  const candidateRuntime = await dependencies.read({ root: original.binding.cacheRoot, version: preparedRuntime.version,
    ...(input.signal === undefined ? {} : { signal: input.signal }) })
  if (!sameRuntime(candidateRuntime, preparedRuntime)
    || candidateRuntime.root !== join(original.binding.cacheRoot, candidateRuntime.version)) {
    throw new PurgeError('候选 Host 制品未通过原缓存根的独立收据验证。')
  }
  input.signal?.throwIfAborted()
  await assertOwnedHome(canonicalHome)
  const current = await readUpdateBinding(canonicalHome)
  if (current.dev !== original.dev || current.ino !== original.ino || !current.bytes.equals(original.bytes)) {
    throw new PurgeError('准备 Host 期间私有绑定发生变化；未切换 Host。')
  }
  const status = candidateRuntime.version === original.binding.version ? 'current' : 'update'
  if (status === 'current' && !sameRuntime(candidateRuntime, originalRuntime)) {
    throw new PurgeError('已绑定的私有 Host 制品发生变化。')
  }
  const candidateBindingSource = status === 'current' ? original.source : JSON.stringify({
    schemaVersion: 1, cacheRoot: original.binding.cacheRoot, version: candidateRuntime.version,
    receiptDigest: candidateRuntime.receiptDigest,
  }) + '\n'
  return { schemaVersion: 1, status, canonicalHome, bindingPath: join(canonicalHome, BINDING),
    originalBindingSource: original.source, originalBindingDigest: createHash('sha256').update(original.bytes).digest('hex'),
    originalRuntime, candidateRuntime, candidateBindingSource }
}

async function assertOwnedHome(home: string): Promise<void> {
  const metadata = await lstat(home)
  if (!metadata.isDirectory() || (metadata.mode & 0o022)
    || process.getuid && metadata.uid !== process.getuid()) {
    throw new PurgeError('Host 绑定目录必须由当前用户所有，且不可由其他用户写入。')
  }
}

async function readBinding(home: string): Promise<HostBinding | undefined> {
  let file
  try { file = await open(join(home,BINDING),constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  try {
    const metadata = await file.stat()
    if (!metadata.isFile() || metadata.size > 16_384 || (metadata.mode & 0o077)
      || process.getuid && metadata.uid !== process.getuid()) throw new PurgeError('私有 Host 绑定文件不安全。')
    const value = JSON.parse(await file.readFile('utf8')) as HostBinding
    if (value.schemaVersion !== 1 || typeof value.cacheRoot !== 'string' || !isAbsolute(value.cacheRoot)
      || typeof value.version !== 'string' || !/^[a-f0-9]{64}$/u.test(value.receiptDigest)) throw new PurgeError('私有 Host 绑定文件无效。')
    return value
  } finally { await file.close() }
}

/** Bind a fresh Home once. Existing unbound installations remain on their
 * current Host until the service-aware Host migration can update the whole Home. */
export async function prepareInstallHostEnvironment(input: {
  dshHome: string; selector?: string; cacheRoot?: string; environment?: NodeJS.ProcessEnv; prepareFresh?: boolean
}, dependencies: InstallHostPorts = ports): Promise<NodeJS.ProcessEnv> {
  const environment = { ...(input.environment ?? process.env) }
  // This marker belongs to the selected Home, never to an ambient parent shell.
  delete environment.DSH_ENHANCED_HOST_BIN
  const requested = resolve(input.dshHome)
  const entry = await lstat(requested).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (entry && !entry.isDirectory() && !entry.isSymbolicLink()) throw new PurgeError('DSH_HOME 必须是目录。')
  if (!entry && input.prepareFresh === false) return environment
  if (!entry) await mkdir(requested,{recursive:true,mode:0o700})
  const home = await realpath(requested)
  const selector = input.selector ?? 'latest'
  const use = async (binding: HostBinding): Promise<NodeJS.ProcessEnv> => {
    await assertOwnedHome(home)
    if (selector !== 'latest' && selector !== binding.version) throw new PurgeError('已有 Home 的 Host 版本已固定；更换版本必须经过受管 Host 更新事务。')
    const runtime = await dependencies.read({root:binding.cacheRoot,version:binding.version})
    if (runtime.receiptDigest !== binding.receiptDigest) throw new PurgeError('已绑定的私有 Host 制品发生变化。')
    return { ...environment,DSH_HOME:home,DSH_ENHANCED_HOST_BIN:runtime.binDirectory,PATH:[runtime.binDirectory,environment.PATH ?? ''].filter(Boolean).join(delimiter) }
  }
  const existing = await readBinding(home)
  if (existing) return use(existing)
  if (input.prepareFresh === false) return environment
  if ((await readdir(home)).length) return environment
  await assertOwnedHome(home)

  const cache = resolve(input.cacheRoot ?? join(homedir(),'.local','share','dsh-enhanced','hosts'))
  await mkdir(cache,{recursive:true,mode:0o700})
  const cacheRoot = await realpath(cache)
  const runtime: Runtime = await dependencies.prepare({root:cacheRoot,selector})
  const raced = await readBinding(home)
  if (raced) return use(raced)
  if ((await readdir(home)).length) throw new PurgeError('准备 Host 期间 DSH_HOME 已被其它安装修改；未切换 Host。')
  await assertOwnedHome(home)
  const binding: HostBinding = {schemaVersion:1,cacheRoot,version:runtime.version,receiptDigest:runtime.receiptDigest}
  const temporary = join(home,`.dsh-rsi-host-${randomUUID()}.tmp`)
  const file = await open(temporary,'wx',0o600)
  try {
    try { await file.writeFile(JSON.stringify(binding)+'\n'); await file.sync() }
    finally { await file.close() }
    try { await link(temporary,join(home,BINDING)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  } finally { await unlink(temporary) }
  const directory = await open(home,constants.O_RDONLY)
  try { await directory.sync() } finally { await directory.close() }
  const committed = await readBinding(home)
  if (!committed) throw new PurgeError('私有 Host 绑定未完成。')
  return use(committed)
}
