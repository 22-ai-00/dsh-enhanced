import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { request } from 'node:https'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual, TextDecoder } from 'node:util'
import { hashNativeMacRuntimeTree, verifyNativeMacRuntime, type NativeMacRuntime } from '@dsh-ray/assistant-isolation'
import { parse as parseYaml } from 'yaml'
import { readRsiSourceWorkspace, type RsiSourceWorkspace } from './rsi-source.js'

const NODE_VERSION = 'v24.22.0'
const PNPM_VERSION = '11.7.0'
const NODE_ARCHIVES = {
  arm64: '6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5',
  x64: '495e3f273c645f3c4677d438304cdfc701729ea5dec5728f5c8e76a2dece4b91',
} as const
const ARM64_NODE_SHA = 'b468fb9c67427c9d3aec07ee1105e63020923a631a9a2a00beb71a7ba3768bfd'
const PNPM_ARCHIVE_SHA = 'deafa7ec98a1218b6a047289b92fbe2395c1e22d3495bb711653013218ee15ee'
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const MAX_NODE_ARCHIVE = 100_000_000
const MAX_PNPM_ARCHIVE = 10_000_000
const MAX_GIT_OUTPUT = 4_194_304
const MAX_MANIFESTS = 256
const MAX_MANIFEST_BYTES = 8_388_608
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u
const ROOTS = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
const MANIFEST = /^(?:plugins|packages)\/[a-z0-9-]+\/package\.json$/u
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u
const DISALLOWED_LOCK_VALUE = /(?:git\+|\b(?:https?|ssh|ftp|git|tarball|github|gitlab|bitbucket|file):)/iu

export interface FrozenNativeManifestSource {
  version: string
  manifests: readonly { path: string; bytes: Uint8Array }[]
}

export interface NativeRsiBuildEnvironment {
  schemaVersion: 2
  sourceCommit: string
  lockSha256: string
  runtime: NativeMacRuntime
  sourceBuild: { backend: 'macos-seatbelt'; runtime: NativeMacRuntime; timeoutMs: 60_000;
    outputBytes: 1_048_576; versioning: 'patch' }
}
export interface NativeRsiCreationBuildEnvironment {
  schemaVersion: 2
  backend: 'macos-seatbelt'
  sourceCommit: string
  runtime: NativeMacRuntime
}
export function nativeRsiCreationBuild(build: NativeRsiBuildEnvironment): NativeRsiCreationBuildEnvironment {
  return { schemaVersion: 2, backend: 'macos-seatbelt', sourceCommit: build.sourceCommit, runtime: build.runtime }
}
interface Receipt extends NativeRsiBuildEnvironment {
  dshHome: string
  profile: string
  manifestHashes: Record<string, string>
  nodeArchiveSha256: string
  pnpmArchiveSha256: string
  receiptDigest: string
}
export interface NativeRsiBootstrapInput {
  dshHome: string; profile: string; source: RsiSourceWorkspace; signal?: AbortSignal
  /** Exact predownloaded official bytes; only intended for an isolated installer cache or test. */
  nodeArchivePath?: string; pnpmArchivePath?: string
}

function fail(message: string): never { throw new Error(`rsi native bootstrap: ${message}`) }
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const canonical = (path: string) => typeof path === 'string' && isAbsolute(path) && resolve(path) === path
  && !path.includes('\0') && !/[\r\n]/u.test(path)
async function privateDirectory(path: string): Promise<void> {
  if (!canonical(path) || await realpath(path) !== path) fail('noncanonical private directory')
  const item = await lstat(path)
  if (!item.isDirectory() || item.isSymbolicLink() || (item.mode & 0o077) !== 0
    || typeof process.getuid === 'function' && item.uid !== process.getuid()) fail('unsafe private directory')
}
async function syncDirectory(path: string): Promise<void> {
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await fd.sync() } finally { await fd.close() }
}
function git(repository: string, args: string[]): Buffer {
  const result = spawnSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    cwd: repository, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_ALLOW_PROTOCOL: 'file' },
    maxBuffer: MAX_GIT_OUTPUT, timeout: 30_000,
  })
  if (result.status !== 0 || result.error) fail('frozen Git object is unavailable')
  return result.stdout
}
const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

function packageConfiguration(value: unknown): void {
  if (!record(value) || Object.hasOwn(value, 'pnpm') || Object.hasOwn(value, 'devEngines')
    || value.engines !== undefined && (!record(value.engines) || Object.hasOwn(value.engines, 'runtime'))) {
    fail('frozen package configuration unsupported')
  }
}

function workspaceConfiguration(value: unknown): void {
  const allowed = new Set(['packages', 'catalog', 'linkWorkspacePackages', 'enableGlobalVirtualStore', 'allowBuilds', 'minimumReleaseAgeExclude'])
  if (!record(value) || Object.keys(value).some(key => !allowed.has(key))) fail('frozen workspace configuration unsupported')
  if (value.catalog !== undefined && (!record(value.catalog) || Object.entries(value.catalog).some(([name, version]) =>
    !PACKAGE.test(name) || typeof version !== 'string' || !EXACT_VERSION.test(version)))) fail('frozen workspace configuration catalog invalid')
  if (value.linkWorkspacePackages !== undefined && typeof value.linkWorkspacePackages !== 'boolean') fail('frozen workspace configuration links invalid')
  if (value.enableGlobalVirtualStore !== undefined && value.enableGlobalVirtualStore !== false) fail('frozen workspace configuration virtual store invalid')
  if (value.allowBuilds !== undefined && (!record(value.allowBuilds) || Object.entries(value.allowBuilds).some(([name, enabled]) =>
    !PACKAGE.test(name) || typeof enabled !== 'boolean'))) fail('frozen workspace configuration builds invalid')
  if (value.minimumReleaseAgeExclude !== undefined && (!Array.isArray(value.minimumReleaseAgeExclude)
    || value.minimumReleaseAgeExclude.some(entry => {
      if (typeof entry !== 'string') return true
      const split = entry.lastIndexOf('@')
      return split < 1 || !PACKAGE.test(entry.slice(0, split)) || !EXACT_VERSION.test(entry.slice(split + 1))
    }))) fail('frozen workspace configuration release exclusions invalid')
}

function hasControlOrWhitespace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x20 || code === 0x7f) return true
  }
  return /\s/u.test(value)
}

function isRegistryNpmjsTarballUrl(tarball: string): boolean {
  if (!tarball.startsWith('https://registry.npmjs.org/') || tarball.includes('\\')
    || tarball.includes('?') || tarball.includes('#') || hasControlOrWhitespace(tarball)) {
    return false
  }
  let url: URL
  try {
    url = new URL(tarball)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.port !== ''
    || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.pathname.length <= 1) {
    return false
  }
  const rawSegments = tarball.slice('https://registry.npmjs.org/'.length).split('/')
  if (rawSegments.length === 0 || rawSegments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    return false
  }
  for (const segment of rawSegments) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return false
    }
    if (decoded === '' || decoded === '.' || decoded === '..' || decoded.includes('/')
      || decoded.includes('\\') || hasControlOrWhitespace(decoded)) {
      return false
    }
  }
  const parsedSegments = url.pathname.slice(1).split('/')
  return !parsedSegments.includes('..') && !parsedSegments.includes('.')
}

function validateLockfileNode(value: unknown, allowPackageEntryFields = false): void {
  if (typeof value === 'string') {
    if (DISALLOWED_LOCK_VALUE.test(value)) fail('frozen lockfile contains an unsupported resolution')
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) validateLockfileNode(item)
    return
  }
  if (record(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (DISALLOWED_LOCK_VALUE.test(key)) fail('frozen lockfile contains an unsupported resolution')
      if (allowPackageEntryFields && key === 'deprecated') {
        if (typeof entry !== 'string') fail('frozen lockfile contains an unsupported resolution')
        continue
      }
      if (allowPackageEntryFields && key === 'resolution' && record(entry)) {
        for (const [resKey, resValue] of Object.entries(entry)) {
          if (DISALLOWED_LOCK_VALUE.test(resKey)) fail('frozen lockfile contains an unsupported resolution')
          if (resKey === 'tarball') continue
          validateLockfileNode(resValue)
        }
        continue
      }
      validateLockfileNode(entry)
    }
  }
}

function validateLockfileResolutions(parsed: Record<string, unknown>): void {
  for (const [key, entry] of Object.entries(parsed)) {
    if (DISALLOWED_LOCK_VALUE.test(key)) fail('frozen lockfile contains an unsupported resolution')
    if (key !== 'packages') {
      validateLockfileNode(entry)
      continue
    }
    if (entry === undefined) continue
    if (!record(entry)) fail('frozen lockfile contains an unsupported resolution')
    for (const [pkgKey, pkgEntry] of Object.entries(entry)) {
      if (DISALLOWED_LOCK_VALUE.test(pkgKey)) fail('frozen lockfile contains an unsupported resolution')
      if (record(pkgEntry)) {
        if (Object.hasOwn(pkgEntry, 'resolution')) {
          const resolution = pkgEntry.resolution
          if (!record(resolution) || Object.hasOwn(resolution, 'directory')
            || Object.hasOwn(resolution, 'repo') || Object.hasOwn(resolution, 'commit')) {
            fail('frozen lockfile contains an unsupported resolution')
          }
          if (Object.hasOwn(resolution, 'type') && resolution.type !== 'tarball') {
            fail('frozen lockfile contains an unsupported resolution')
          }
          if (Object.hasOwn(resolution, 'tarball')) {
            if (typeof resolution.tarball !== 'string' || !isRegistryNpmjsTarballUrl(resolution.tarball)) {
              fail('frozen lockfile contains an unsupported resolution')
            }
          } else if (Object.hasOwn(resolution, 'type')) {
            fail('frozen lockfile contains an unsupported resolution')
          }
        }
        validateLockfileNode(pkgEntry, true)
      } else {
        validateLockfileNode(pkgEntry)
      }
    }
  }
}

/** Validate and copy frozen manifests using strict YAML/lockfile structural checks. */
export function validateFrozenNativeManifests(source: FrozenNativeManifestSource): Map<string, Buffer> {
  if (!source || !VERSION.test(source.version)
    || !Array.isArray(source.manifests) || source.manifests.length < 3 || source.manifests.length > MAX_MANIFESTS) {
    fail('frozen manifest inventory is incomplete')
  }
  const files = new Map<string, Buffer>()
  let total = 0
  for (const entry of source.manifests) {
    if (!entry || typeof entry.path !== 'string' || (!ROOTS.includes(entry.path) && !MANIFEST.test(entry.path))
      || files.has(entry.path) || !(entry.bytes instanceof Uint8Array) || entry.bytes.byteLength > MAX_GIT_OUTPUT) {
      fail('frozen manifest inventory is invalid')
    }
    const bytes = Buffer.from(entry.bytes)
    total += bytes.length
    if (total > MAX_MANIFEST_BYTES) fail('frozen manifests exceed bound')
    files.set(entry.path, bytes)
  }
  if (!ROOTS.every(name => files.has(name))) fail('frozen manifest inventory is incomplete')
  const sorted = new Map([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  let manifest: { name?: string; version?: string; packageManager?: string }
  try { manifest = JSON.parse(decode(sorted.get('package.json')!)) }
  catch { return fail('frozen root manifest is invalid') }
  if (manifest?.name !== 'dsh-ray' || manifest.version !== source.version
    || manifest.packageManager !== `pnpm@${PNPM_VERSION}`) fail('frozen root manifest identity differs')
  packageConfiguration(manifest)
  const workspaces = new Set([...sorted.keys()].filter(name => MANIFEST.test(name)).map(dirname))
  const packageNames = new Set<string>()
  for (const name of workspaces) {
    try {
      const workspaceManifest = JSON.parse(decode(sorted.get(`${name}/package.json`)!))
      if (!workspaceManifest || typeof workspaceManifest.name !== 'string' || !workspaceManifest.name || packageNames.has(workspaceManifest.name)
        || workspaceManifest.version !== source.version
        || workspaceManifest.packageManager !== undefined && workspaceManifest.packageManager !== `pnpm@${PNPM_VERSION}`) {
        fail('frozen workspace manifest identity differs')
      }
      packageConfiguration(workspaceManifest)
      packageNames.add(workspaceManifest.name)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('rsi native bootstrap: ')) throw error
      fail('frozen workspace manifest is invalid')
    }
  }
  let workspace: { packages?: unknown }
  try { workspace = parseYaml(decode(sorted.get('pnpm-workspace.yaml')!), { maxAliasCount: 0, uniqueKeys: true }) }
  catch { return fail('frozen workspace inventory is invalid') }
  workspaceConfiguration(workspace)
  if (!workspace || !Array.isArray(workspace.packages)
    || workspace.packages.some((pattern: unknown) => !['plugins/*', 'packages/*'].includes(pattern as string))
    || new Set(workspace.packages).size !== workspace.packages.length
    || [...workspaces].some(name => !(workspace.packages as unknown[]).includes(name.split('/')[0] + '/*'))) {
    fail('frozen workspace inventory is invalid')
  }
  let lock: string
  try { lock = decode(sorted.get('pnpm-lock.yaml')!) }
  catch { return fail('frozen lockfile is invalid') }
  if (!lock.startsWith("lockfileVersion: '9.0'\n")) fail('frozen lockfile contains an unsupported resolution')
  let parsed: { settings?: unknown; importers?: Record<string, Record<string, Record<string, { specifier?: string; version?: string }>>> }
  try { parsed = parseYaml(lock, { maxAliasCount: 0, uniqueKeys: true }) as typeof parsed }
  catch { return fail('frozen lockfile is invalid') }
  if (!record(parsed)) fail('frozen lockfile is invalid')
  validateLockfileResolutions(parsed)
  if (Object.keys(parsed).some(key => !['lockfileVersion', 'settings', 'catalogs', 'importers', 'packages', 'snapshots'].includes(key))) {
    fail('frozen lockfile configuration unsupported')
  }
  if (parsed.settings !== undefined && (!record(parsed.settings)
    || Object.entries(parsed.settings).some(([key, value]) => !['autoInstallPeers', 'excludeLinksFromLockfile'].includes(key) || typeof value !== 'boolean'))) {
    fail('frozen lockfile configuration settings unsupported')
  }
  if (!parsed.importers || typeof parsed.importers !== 'object' || !Object.hasOwn(parsed.importers, '.')) {
    fail('frozen lockfile has no importers')
  }
  if ([...workspaces].some(name => !Object.hasOwn(parsed.importers!, name))) {
    fail('frozen lockfile importers missing')
  }
  for (const [importer, groups] of Object.entries(parsed.importers)) {
    if (importer !== '.' && !workspaces.has(importer)) fail('frozen lockfile importer is outside manifests')
    if (!record(groups) || Object.keys(groups).some(key => !['dependencies', 'devDependencies', 'optionalDependencies'].includes(key))) {
      fail('frozen importer configuration unsupported')
    }
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const value of Object.values(groups[group] ?? {})) {
        if (!record(value) || typeof value.specifier !== 'string' || typeof value.version !== 'string') fail('frozen dependency is invalid')
        if (DISALLOWED_LOCK_VALUE.test(value.specifier) || DISALLOWED_LOCK_VALUE.test(value.version)) fail('frozen dependency uses an unsupported source')
        if (value.specifier.startsWith('link:') && value.specifier !== value.version) fail('frozen dependency uses an unsupported source')
        if (value.version.startsWith('link:')) {
          const target = resolve('/frozen', importer === '.' ? '' : importer, value.version.slice(5))
          if (!target.startsWith('/frozen/') || !workspaces.has(target.slice('/frozen/'.length))) {
            fail('frozen workspace link escapes manifests')
          }
        }
      }
    }
  }
  return sorted
}

async function frozenManifests(source: RsiSourceWorkspace): Promise<Map<string, Buffer>> {
  const listed = git(source.repository, ['ls-tree', '-r', '--name-only', '-z', source.sourceCommit]).toString('utf8').split('\0')
  const names = listed.filter(name => ROOTS.includes(name) || MANIFEST.test(name)).sort()
  if (names.length < 3 || names.length > MAX_MANIFESTS
    || !ROOTS.every(name => names.includes(name))) fail('frozen manifest inventory is incomplete')
  const manifests: { path: string; bytes: Uint8Array }[] = []
  let total = 0
  for (const name of names) {
    const bytes = git(source.repository, ['show', `${source.sourceCommit}:${name}`])
    if ((total += bytes.length) > MAX_MANIFEST_BYTES || bytes.length > MAX_GIT_OUTPUT) fail('frozen manifests exceed bound')
    manifests.push({ path: name, bytes })
  }
  return validateFrozenNativeManifests({ version: source.version, manifests })
}
async function download(url: string, maximum: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted()
  return new Promise<Buffer>((resolveBytes, reject) => {
    const chunks: Buffer[] = []; let size = 0
    let settled = false
    const finish = (error?: Error, bytes?: Buffer) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolveBytes(bytes!)
    }
    const req = request(url, { method: 'GET', timeout: 120_000, headers: { 'User-Agent': 'dsh-native-bootstrap/1' } }, res => {
      if (res.statusCode !== 200 || res.headers.location || Number(res.headers['content-length'] ?? 0) > maximum) {
        const error = new Error('official bootstrap download refused')
        req.destroy(error); finish(error); return
      }
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maximum) {
          const error = new Error('official bootstrap archive exceeds bound')
          req.destroy(error); finish(error)
        }
        else chunks.push(chunk)
      })
      res.once('end', () => finish(undefined, Buffer.concat(chunks)))
      res.once('error', error => finish(error))
    })
    const abort = () => req.destroy(signal.reason)
    req.once('error', error => finish(error))
    req.once('timeout', () => req.destroy(new Error('official bootstrap download timed out')))
    signal.addEventListener('abort', abort, { once: true })
    req.end()
  })
}
async function officialArchive(path: string | undefined, url: string, expected: string, maximum: number, signal: AbortSignal): Promise<Buffer> {
  let bytes: Buffer
  if (path === undefined) bytes = await download(url, maximum, signal)
  else {
    if (!canonical(path) || await realpath(path) !== path) fail('bootstrap archive path is not canonical')
    const item = await lstat(path)
    if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1 || item.size > maximum) fail('bootstrap archive is unsafe')
    bytes = await readFile(path)
  }
  if (bytes.length < 1 || bytes.length > maximum || sha(bytes) !== expected) fail('official bootstrap archive digest differs')
  return bytes
}
async function run(file: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv,
  signal: AbortSignal, timeoutMs: number, maximumOutput = 4_194_304): Promise<Buffer> {
  signal.throwIfAborted()
  return new Promise<Buffer>((resolveOutput, reject) => {
    const child = spawn(file, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    const chunks: Buffer[] = []; let size = 0; let stderr = ''; let settled = false
    const stop = () => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
    const timer = setTimeout(stop, timeoutMs)
    const abort = () => stop()
    signal.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maximumOutput) stop(); else chunks.push(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2048) })
    child.once('error', error => { settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); reject(error) })
    child.once('close', code => {
      if (settled) return
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (signal.aborted || code !== 0 || size > maximumOutput) reject(new Error(`native bootstrap command failed: ${stderr.slice(-200)}`))
      else resolveOutput(Buffer.concat(chunks))
    })
  })
}
async function extractExact(archive: string, member: string, cwd: string, signal: AbortSignal): Promise<Buffer> {
  return run('/usr/bin/tar', ['-xOzf', archive, member], cwd,
    { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', COPYFILE_DISABLE: '1' }, signal, 120_000, 150_000_000)
}
async function sourceIdentity(input: NativeRsiBootstrapInput): Promise<void> {
  const current = await readRsiSourceWorkspace({ dshHome: input.dshHome, profile: input.profile,
    version: input.source.version, ...(input.source.origin.kind === 'local-head' ? { sourceRepository: input.source.origin.locator } : {}),
    ...(input.signal ? { signal: input.signal } : {}) })
  if (!isDeepStrictEqual(current, input.source)) fail('frozen source receipt changed')
}
function asEnvironment(receipt: Receipt): NativeRsiBuildEnvironment {
  return { schemaVersion: 2, sourceCommit: receipt.sourceCommit, lockSha256: receipt.lockSha256,
    runtime: receipt.runtime, sourceBuild: receipt.sourceBuild }
}
async function readExisting(final: string, input: NativeRsiBootstrapInput, manifests: Map<string, Buffer>): Promise<NativeRsiBuildEnvironment> {
  await privateDirectory(final)
  if (JSON.stringify((await readdir(final)).sort()) !== JSON.stringify(['bootstrap.json', 'runtime'])) fail('native runtime is incomplete')
  const receiptPath = join(final, 'bootstrap.json'), receiptInfo = await lstat(receiptPath)
  if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink() || receiptInfo.nlink !== 1 || receiptInfo.size > 4_194_304
    || (receiptInfo.mode & 0o077) !== 0 || typeof process.getuid === 'function' && receiptInfo.uid !== process.getuid()
    || await realpath(receiptPath) !== receiptPath) fail('native bootstrap receipt is unsafe')
  const descriptor = await open(receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  let receipt: Receipt
  try {
    const checked = await descriptor.stat()
    if (checked.dev !== receiptInfo.dev || checked.ino !== receiptInfo.ino || checked.size !== receiptInfo.size) fail('native bootstrap receipt changed')
    receipt = JSON.parse(await descriptor.readFile({ encoding: 'utf8' })) as Receipt
  } finally { await descriptor.close() }
  const { receiptDigest, ...content } = receipt
  const hashes = Object.fromEntries([...manifests].map(([name, bytes]) => [name, sha(bytes)]))
  if (receiptDigest !== sha(JSON.stringify(content)) || receipt.schemaVersion !== 2
    || receipt.dshHome !== input.dshHome || receipt.profile !== input.profile
    || receipt.sourceCommit !== input.source.sourceCommit || receipt.lockSha256 !== hashes['pnpm-lock.yaml']
    || !isDeepStrictEqual(receipt.manifestHashes, hashes)
    || receipt.nodeArchiveSha256 !== NODE_ARCHIVES[process.arch as 'arm64' | 'x64']
    || receipt.pnpmArchiveSha256 !== PNPM_ARCHIVE_SHA
    || receipt.runtime.nodePath !== join(final, 'runtime', 'bin', 'node')
    || receipt.runtime.modulesPath !== join(final, 'runtime', 'node_modules')
    || receipt.runtime.roots.length !== 1 || receipt.runtime.roots[0]?.path !== join(final, 'runtime')
    || !isDeepStrictEqual(receipt.sourceBuild, { backend: 'macos-seatbelt', runtime: receipt.runtime,
      timeoutMs: 60_000, outputBytes: 1_048_576, versioning: 'patch' })) fail('native bootstrap receipt differs')
  await verifyNativeMacRuntime(receipt.runtime)
  return asEnvironment(receipt)
}

/** Install only committed manifests and their frozen dependencies into a private native runtime. */
export async function prepareNativeRsiRuntime(input: NativeRsiBootstrapInput): Promise<NativeRsiBuildEnvironment> {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) fail('native runtime requires macOS')
  if (!canonical(input.dshHome) || !PROFILE.test(input.profile) || input.source.schemaVersion !== 1) fail('invalid bootstrap identity')
  await privateDirectory(input.dshHome)
  await sourceIdentity(input)
  const manifests = await frozenManifests(input.source)
  const parent = join(input.dshHome, 'rsi-native-runtimes')
  await mkdir(parent, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  await privateDirectory(parent)
  const final = join(parent, input.profile)
  if (await lstat(final).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })) {
    return readExisting(final, input, manifests)
  }
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(1_200_000)])
  const stage = await mkdtemp(join(parent, `.${input.profile}-stage-`))
  await chmod(stage, 0o700)
  try {
    const root = join(stage, 'runtime'), tool = join(stage, 'tool'), cache = join(stage, 'cache')
    for (const directory of [root, tool, cache]) await mkdir(directory, { mode: 0o700 })
    const nodeArchive = await officialArchive(input.nodeArchivePath,
      `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-darwin-${process.arch}.tar.gz`,
      NODE_ARCHIVES[process.arch as 'arm64' | 'x64'], MAX_NODE_ARCHIVE, signal)
    const pnpmArchive = await officialArchive(input.pnpmArchivePath,
      `https://registry.npmjs.org/pnpm/-/pnpm-${PNPM_VERSION}.tgz`, PNPM_ARCHIVE_SHA, MAX_PNPM_ARCHIVE, signal)
    const nodeArchiveFile = join(stage, 'node.tgz'), pnpmArchiveFile = join(stage, 'pnpm.tgz')
    await writeFile(nodeArchiveFile, nodeArchive, { mode: 0o600 })
    await writeFile(pnpmArchiveFile, pnpmArchive, { mode: 0o600 })
    const bin = join(root, 'bin'); await mkdir(bin, { mode: 0o700 })
    const nodePath = join(bin, 'node')
    const node = await extractExact(nodeArchiveFile, `node-${NODE_VERSION}-darwin-${process.arch}/bin/node`, stage, signal)
    if (process.arch === 'arm64' && sha(node) !== ARM64_NODE_SHA) fail('official Node binary digest differs')
    await writeFile(nodePath, node, { mode: 0o500 })
    await chmod(nodePath, 0o500)
    await run('/usr/bin/tar', ['-xzf', pnpmArchiveFile, '-C', tool], stage,
      { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', COPYFILE_DISABLE: '1' }, signal, 120_000)
    for (const [name, bytes] of manifests) {
      const path = join(root, name)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(path, bytes, { mode: 0o600 })
    }
    const env: NodeJS.ProcessEnv = { PATH: `${bin}:/usr/bin:/bin`, HOME: cache, LANG: 'C', LC_ALL: 'C', CI: 'true',
      npm_config_userconfig: '/dev/null', npm_config_globalconfig: '/dev/null',
      npm_config_registry: 'https://registry.npmjs.org/', npm_config_store_dir: join(stage, 'store'),
      COREPACK_ENABLE_PROJECT_SPEC: '0' }
    await run(nodePath, [join(tool, 'package', 'bin', 'pnpm.mjs'), 'install', '--frozen-lockfile',
      '--ignore-scripts', '--config.package-import-method=copy', '--reporter=append-only'], root, env, signal, 900_000)
    await sourceIdentity(input)
    const fresh = await frozenManifests(input.source)
    if (!isDeepStrictEqual([...fresh], [...manifests])) fail('frozen manifest changed during install')
    const modulesPath = join(root, 'node_modules')
    // pnpm links dependencies into the workspace that declares them. Expose the
    // fixed compiler closure at one runtime-local module root for the runner.
    for (const name of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt']) {
      const link = join(modulesPath, name)
      if (await lstat(link).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })) continue
      const candidates = ['plugins/assistant-verifier', 'plugins/assistant-isolation',
        'plugins/plugin-control-plane', 'plugins/lark-channel'].map(workspace => join(root, workspace, 'node_modules', name))
      let target: string | undefined
      for (const candidate of candidates) {
        const actual = await realpath(candidate).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
        if (actual && actual.startsWith(`${root}${sep}`)) { target = actual; break }
      }
      if (!target) fail(`native runtime package missing: ${name}`)
      await mkdir(dirname(link), { recursive: true, mode: 0o700 })
      await symlink(relative(dirname(link), target), link)
    }
    const versions = { node: NODE_VERSION, typescript: '', cordis: '', tools: '', systemPrompt: '' }
    for (const [key, name] of [['typescript', 'typescript'], ['cordis', '@deepseek-ai/cordis'],
      ['tools', '@deepseek-ai/dsh-tools'], ['systemPrompt', '@deepseek-ai/dsh-system-prompt']] as const) {
      const manifest = JSON.parse(await readFile(join(modulesPath, name, 'package.json'), 'utf8')) as { version?: string }
      if (!manifest.version) fail(`native runtime package missing: ${name}`)
      versions[key] = manifest.version
    }
    const treeSha = await hashNativeMacRuntimeTree(root)
    const identity = await stat(root)
    const runtime: NativeMacRuntime = { schemaVersion: 1, platform: `darwin-${process.arch}` as NativeMacRuntime['platform'],
      nodePath: join(final, 'runtime', 'bin', 'node'), nodeSha256: sha(node),
      roots: [{ path: join(final, 'runtime'), dev: identity.dev, ino: identity.ino, sha256: treeSha }],
      modulesPath: join(final, 'runtime', 'node_modules'), versions }
    const manifestHashes = Object.fromEntries([...manifests].map(([name, bytes]) => [name, sha(bytes)]))
    const content = { schemaVersion: 2 as const, sourceCommit: input.source.sourceCommit,
      lockSha256: manifestHashes['pnpm-lock.yaml']!, runtime,
      sourceBuild: { backend: 'macos-seatbelt' as const, runtime, timeoutMs: 60_000 as const,
        outputBytes: 1_048_576 as const, versioning: 'patch' as const },
      dshHome: input.dshHome, profile: input.profile, manifestHashes,
      nodeArchiveSha256: NODE_ARCHIVES[process.arch as 'arm64' | 'x64'], pnpmArchiveSha256: PNPM_ARCHIVE_SHA }
    await writeFile(join(stage, 'bootstrap.json'), JSON.stringify({ ...content, receiptDigest: sha(JSON.stringify(content)) }), { mode: 0o600 })
    for (const name of ['tool', 'cache', 'store', 'node.tgz', 'pnpm.tgz']) await rm(join(stage, name), { recursive: true, force: true })
    await syncDirectory(root); await syncDirectory(stage)
    await rename(stage, final); await syncDirectory(parent)
    return readExisting(final, input, manifests)
  } finally { await rm(stage, { recursive: true, force: true }) }
}

export async function readNativeRsiRuntime(input: NativeRsiBootstrapInput): Promise<NativeRsiBuildEnvironment> {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) fail('native runtime requires macOS')
  await privateDirectory(input.dshHome)
  await sourceIdentity(input)
  return readExisting(join(input.dshHome, 'rsi-native-runtimes', input.profile), input, await frozenManifests(input.source))
}
