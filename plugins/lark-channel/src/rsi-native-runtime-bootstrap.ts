import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { request } from 'node:https'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { hashNativeMacRuntimeTree, verifyNativeMacRuntime, type NativeMacRuntime } from '@dsh-enhanced/assistant-isolation'
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
async function frozenManifests(source: RsiSourceWorkspace): Promise<Map<string, Buffer>> {
  const listed = git(source.repository, ['ls-tree', '-r', '--name-only', '-z', source.sourceCommit]).toString('utf8').split('\0')
  const names = listed.filter(name => ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(name)
    || /^(?:plugins|packages)\/[a-z0-9-]+\/package\.json$/u.test(name)).sort()
  if (names.length < 3 || names.length > MAX_MANIFESTS
    || !['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].every(name => names.includes(name))) fail('frozen manifest inventory is incomplete')
  const files = new Map<string, Buffer>()
  let total = 0
  for (const name of names) {
    const bytes = git(source.repository, ['show', `${source.sourceCommit}:${name}`])
    if ((total += bytes.length) > MAX_MANIFEST_BYTES || bytes.length > MAX_GIT_OUTPUT) fail('frozen manifests exceed bound')
    files.set(name, bytes)
  }
  let manifest: { name?: string; version?: string; packageManager?: string }
  try { manifest = JSON.parse(files.get('package.json')!.toString('utf8')) }
  catch { return fail('frozen root manifest is invalid') }
  if (manifest.name !== 'dsh-enhanced' || manifest.version !== source.version
    || manifest.packageManager !== `pnpm@${PNPM_VERSION}`) fail('frozen root manifest identity differs')
  const lock = files.get('pnpm-lock.yaml')!.toString('utf8')
  if (!lock.startsWith("lockfileVersion: '9.0'\n")
    || /(?:https?:\/\/(?!registry\.npmjs\.org\/)|git\+|\b(?:git|tarball):|(?:^|[\s'"])(?:file:))/imu.test(lock)) {
    fail('frozen lockfile contains an unsupported resolution')
  }
  let parsed: { importers?: Record<string, Record<string, Record<string, { specifier?: string; version?: string }>>> }
  try { parsed = parseYaml(lock) as typeof parsed } catch { return fail('frozen lockfile is invalid') }
  if (!parsed.importers || typeof parsed.importers !== 'object') fail('frozen lockfile has no importers')
  const workspaces = new Set(names.filter(name => name.endsWith('/package.json')).map(name => dirname(name)))
  for (const [importer, groups] of Object.entries(parsed.importers)) {
    if (importer !== '.' && !workspaces.has(importer)) fail('frozen lockfile importer is outside manifests')
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const value of Object.values(groups[group] ?? {})) {
        if (typeof value?.specifier !== 'string' || typeof value.version !== 'string') fail('frozen dependency is invalid')
        if (/^(?:file:|git\+|github:|https?:)/iu.test(value.specifier)) fail('frozen dependency uses an unsupported source')
        if (value.version.startsWith('link:')) {
          const target = resolve('/frozen', importer === '.' ? '' : importer, value.version.slice(5))
          if (!target.startsWith('/frozen/') || !workspaces.has(target.slice('/frozen/'.length))) {
            fail('frozen workspace link escapes manifests')
          }
        }
      }
    }
  }
  return files
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
