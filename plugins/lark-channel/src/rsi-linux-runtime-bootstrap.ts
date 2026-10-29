import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import { hashLinuxRuntimeTree, verifyLinuxRuntime, type LinuxRuntime } from '@dsh-enhanced/assistant-isolation'
import { parse as parseYaml } from 'yaml'
import { readRsiSourceWorkspace, type RsiSourceWorkspace } from './rsi-source.js'

export const NODE_VERSION = 'v22.23.2'
const PNPM_VERSION = '11.7.0'
// nodejs.org/dist/v22.23.2/SHASUMS256.txt and the exact npm package tarballs.
export const NODE_ARCHIVES = {
  x64: 'b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a',
  arm64: '013b59cfd2819703a6f4a14ab891fc46fc2a4e3f5bcd92de3fb4929b43e35b30',
} as const
const PNPM_ARCHIVE_SHA = 'deafa7ec98a1218b6a047289b92fbe2395c1e22d3495bb711653013218ee15ee'
const PNPM_EXE_ARCHIVE_SHA = '0424127c10888e17ebbb3cfc0be685b2a87079ca7bc372bec0036313e3f1b4d5'
const PNPM_NATIVE_ARCHIVES = {
  x64: '90a6f44ad45f9ceb815ce63c55568bd14b370247c394b97f6767ef59036aca0e',
  arm64: 'b196d44af42ae26308b5ca145091ed2febd569e6590e906fe54a223222e1c348',
} as const
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const MAX_GIT_OUTPUT = 4_194_304
const MAX_MANIFESTS = 256
const MAX_MANIFEST_BYTES = 8_388_608
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const canonical = (path: string) => typeof path === 'string' && isAbsolute(path) && resolve(path) === path
  && !path.includes('\r') && !path.includes('\n') && !path.includes('\0')
const within = (path: string, root: string): boolean => path === root || path.startsWith(root + sep)
function fail(message: string): never { throw new Error(`rsi Linux runtime: ${message}`) }

/** Environmental prerequisites are missing (platform, binaries, namespace or
 * tmpfs support). Integrity/identity failures stay hard errors via fail(). */
export class LinuxRsiRuntimeUnavailableError extends Error {
  constructor(message: string) { super(`rsi Linux runtime unavailable: ${message}`) }
}

export interface LinuxRsiBuildEnvironment {
  schemaVersion: 3
  backend: 'linux-native'
  sourceCommit: string
  lockSha256: string
  runtime: LinuxRuntime
}
export interface LinuxRsiBootstrapInput {
  dshHome: string
  profile: string
  source: RsiSourceWorkspace
  signal?: AbortSignal
  /** Exact cached official archives, still checked against fixed digest. */
  nodeArchivePath?: string
  pnpmArchivePath?: string
  pnpmExeArchivePath?: string
  pnpmNativeArchivePath?: string
}
interface Receipt extends LinuxRsiBuildEnvironment {
  dshHome: string
  profile: string
  manifestHashes: Record<string, string>
  archives: { node: string; pnpm: string; pnpmExe: string; pnpmNative: string }
  receiptDigest: string
}

async function privateDirectory(path: string): Promise<void> {
  if (!canonical(path) || await realpath(path) !== path) fail('noncanonical private directory')
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()
    || info.mode & 0o077) fail('unsafe private directory')
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
  if (result.status !== 0 || result.error) fail('frozen Git object unavailable')
  return result.stdout
}
async function sourceIdentity(input: LinuxRsiBootstrapInput): Promise<void> {
  const source = await readRsiSourceWorkspace({ dshHome: input.dshHome, profile: input.profile,
    version: input.source.version, ...(input.source.origin.kind === 'local-head'
      ? { sourceRepository: input.source.origin.locator } : {}),
    ...(input.signal ? { signal: input.signal } : {}) })
  if (!isDeepStrictEqual(source, input.source)) fail('frozen source receipt changed')
}
async function frozenManifests(source: RsiSourceWorkspace): Promise<Map<string, Buffer>> {
  const listed = git(source.repository, ['ls-tree', '-r', '--name-only', '-z', source.sourceCommit]).toString('utf8').split('\0')
  const names = listed.filter(name => ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(name)
    || /^(?:plugins|packages)\/[a-z0-9-]+\/package\.json$/u.test(name)).sort()
  if (names.length < 3 || names.length > MAX_MANIFESTS
    || !['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].every(name => names.includes(name))) {
    fail('frozen manifest inventory incomplete')
  }
  const files = new Map<string, Buffer>()
  let total = 0
  for (const name of names) {
    const bytes = git(source.repository, ['show', `${source.sourceCommit}:${name}`])
    total += bytes.length
    if (total > MAX_MANIFEST_BYTES || bytes.length > MAX_GIT_OUTPUT) fail('frozen manifest bytes exceed bound')
    files.set(name, bytes)
  }
  let root: { name?: string; version?: string; packageManager?: string }
  try { root = JSON.parse(files.get('package.json')!.toString('utf8')) }
  catch { return fail('frozen root manifest invalid') }
  if (root.name !== 'dsh-enhanced' || root.version !== source.version
    || root.packageManager !== `pnpm@${PNPM_VERSION}`) fail('frozen root manifest identity differs')
  const lock = files.get('pnpm-lock.yaml')!.toString('utf8')
  if (!lock.startsWith("lockfileVersion: '9.0'\n")
    || /(?:https?:\/\/(?!registry\.npmjs\.org\/)|git\+|\b(?:git|tarball):|(?:^|[\s'"])(?:file:))/imu.test(lock)) {
    fail('frozen lockfile unsupported resolution')
  }
  let parsed: { importers?: Record<string, Record<string, Record<string, { specifier?: string; version?: string }>>> }
  try { parsed = parseYaml(lock) as typeof parsed } catch { return fail('frozen lockfile invalid') }
  if (!parsed.importers || typeof parsed.importers !== 'object') fail('frozen lockfile importers missing')
  const workspaces = new Set(names.filter(name => name.endsWith('/package.json')).map(name => dirname(name)))
  for (const [importer, groups] of Object.entries(parsed.importers)) {
    if (importer !== '.' && !workspaces.has(importer)) fail('frozen importer outside manifest inventory')
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const value of Object.values(groups[group] ?? {})) {
        if (typeof value?.specifier !== 'string' || typeof value.version !== 'string') fail('frozen dependency invalid')
        if (/^(?:file:|git\+|github:|https?:)/iu.test(value.specifier)) fail('frozen dependency source unsupported')
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

async function run(file: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv,
  signal: AbortSignal, timeoutMs: number, maximumOutput = 4_194_304): Promise<Buffer> {
  signal.throwIfAborted()
  return new Promise<Buffer>((resolveOutput, reject) => {
    const child = spawn(file, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    const chunks: Buffer[] = []; let size = 0, stderr = '', finished = false
    const stop = (): void => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
    const timer = setTimeout(stop, timeoutMs)
    const abort = (): void => stop()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maximumOutput) stop(); else chunks.push(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2048) })
    child.once('error', error => { finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort); reject(error) })
    child.once('close', code => {
      if (finished) return
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (signal.aborted || code !== 0 || size > maximumOutput) reject(new Error(`Linux runtime command failed: ${stderr.slice(-200)}`))
      else resolveOutput(Buffer.concat(chunks))
    })
  })
}
export async function officialArchive(path: string | undefined, url: string, expected: string, maximum: number,
  stage: string, signal: AbortSignal): Promise<string> {
  const destination = join(stage, `archive-${expected.slice(0, 16)}.tgz`)
  if (path === undefined) {
    const networkEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: stage, LANG: 'C', LC_ALL: 'C' }
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy',
      'SSL_CERT_FILE', 'SSL_CERT_DIR']) if (process.env[key] !== undefined) networkEnv[key] = process.env[key]
    const bytes = await run('/usr/bin/curl', ['--disable', '--fail', '--silent', '--show-error', '--proto', '=https',
      '--max-redirs', '0', '--connect-timeout', '15', '--max-time', '180', '--url', url], stage,
    networkEnv, signal, 190_000, maximum)
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 })
  } else {
    if (!canonical(path) || await realpath(path) !== path) fail('cached archive path is noncanonical')
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maximum) fail('cached archive unsafe')
    const data = await readFile(path)
    if (data.length !== info.size) fail('cached archive changed')
    await writeFile(destination, data, { flag: 'wx', mode: 0o600 })
  }
  const archive = await readFile(destination)
  if (archive.length < 1 || archive.length > maximum || sha(archive) !== expected) fail('official archive digest differs')
  return destination
}
export async function extractExact(archive: string, member: string, cwd: string, signal: AbortSignal,
  maximum: number): Promise<Buffer> {
  return run('/usr/bin/tar', ['-xOzf', archive, member], cwd,
    { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C', COPYFILE_DISABLE: '1' }, signal, 120_000, maximum)
}

async function doctor(): Promise<void> {
  const unavailable = (message: string): never => { throw new LinuxRsiRuntimeUnavailableError(message) }
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) unavailable('Linux x64/arm64 required')
  const env = { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C' }
  for (const command of ['/usr/bin/git', '/usr/bin/curl', '/usr/bin/tar', '/usr/bin/bwrap',
    '/usr/bin/unshare', '/usr/bin/mount', '/usr/bin/bash', '/usr/bin/python3']) {
    const result = spawnSync(command, ['--version'], { env, timeout: 5_000, maxBuffer: 4096 })
    if (result.error || result.status !== 0) unavailable(`required Linux prerequisite unavailable: ${command}`)
  }
  const bwrap = spawnSync('/usr/bin/bwrap', ['--unshare-all', '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/lib', '/lib', ...(process.arch === 'x64' ? ['--ro-bind', '/lib64', '/lib64'] : []),
    '--proc', '/proc', '--dev', '/dev', '--dir', '/tmp', '/usr/bin/true'],
  { env, timeout: 5_000, maxBuffer: 4096 })
  if (bwrap.error || bwrap.status !== 0) unavailable('Linux namespace sandbox unavailable')
  const probe = await mkdtemp(join(tmpdir(), 'dsh-linux-runtime-doctor-'))
  try {
    const mounted = spawnSync('/usr/bin/unshare', ['--user', '--map-root-user', '--mount', '--pid', '--fork',
      '--kill-child=SIGKILL', '/usr/bin/bash', '-c',
      'set -eu; mount -t tmpfs -o size=1048576,nr_inodes=16 tmpfs "$1"; test "$(stat -f -c %T "$1")" = tmpfs',
      'dsh-linux-doctor', probe], { env, timeout: 5_000, maxBuffer: 4096 })
    if (mounted.error || mounted.status !== 0) unavailable('bounded Linux tmpfs unavailable')
  } finally { await rm(probe, { recursive: true, force: true }) }
}

async function readExisting(final: string, input: LinuxRsiBootstrapInput,
  manifests: Map<string, Buffer>): Promise<LinuxRsiBuildEnvironment> {
  await privateDirectory(final)
  if (JSON.stringify((await readdir(final)).sort()) !== JSON.stringify(['bootstrap.json', 'runtime'])) {
    fail('Linux runtime incomplete')
  }
  const receiptPath = join(final, 'bootstrap.json')
  const info = await lstat(receiptPath)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4_194_304
    || info.mode & 0o077 || info.uid !== process.getuid?.()) fail('Linux runtime receipt unsafe')
  const fd = await open(receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  let receipt: Receipt
  try {
    const opened = await fd.stat()
    if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) fail('Linux receipt changed')
    receipt = JSON.parse(await fd.readFile({ encoding: 'utf8' })) as Receipt
  } finally { await fd.close() }
  const { receiptDigest, ...content } = receipt
  const hashes = Object.fromEntries([...manifests].map(([name, bytes]) => [name, sha(bytes)]))
  const archives = { node: NODE_ARCHIVES[process.arch as 'x64' | 'arm64'], pnpm: PNPM_ARCHIVE_SHA,
    pnpmExe: PNPM_EXE_ARCHIVE_SHA, pnpmNative: PNPM_NATIVE_ARCHIVES[process.arch as 'x64' | 'arm64'] }
  if (receiptDigest !== sha(JSON.stringify(content)) || receipt.schemaVersion !== 3
    || receipt.backend !== 'linux-native' || receipt.dshHome !== input.dshHome || receipt.profile !== input.profile
    || receipt.sourceCommit !== input.source.sourceCommit || receipt.lockSha256 !== hashes['pnpm-lock.yaml']
    || !isDeepStrictEqual(receipt.manifestHashes, hashes) || !isDeepStrictEqual(receipt.archives, archives)
    || receipt.runtime.root.path !== join(final, 'runtime')
    || receipt.runtime.sourceCommit !== receipt.sourceCommit || receipt.runtime.lockSha256 !== receipt.lockSha256) {
    fail('Linux runtime receipt differs')
  }
  await verifyLinuxRuntime(receipt.runtime)
  return { schemaVersion: 3, backend: 'linux-native', sourceCommit: receipt.sourceCommit,
    lockSha256: receipt.lockSha256, runtime: receipt.runtime }
}

/** Build only the approved manifest and lock dependency closure; candidate code is never present. */
export async function prepareLinuxRsiRuntime(input: LinuxRsiBootstrapInput): Promise<LinuxRsiBuildEnvironment> {
  input.signal?.throwIfAborted()
  await doctor()
  if (!canonical(input.dshHome) || !PROFILE.test(input.profile) || input.source.schemaVersion !== 1) fail('invalid bootstrap identity')
  await privateDirectory(input.dshHome)
  await sourceIdentity(input)
  const manifests = await frozenManifests(input.source)
  const parent = join(input.dshHome, 'rsi-linux-runtimes')
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
    const root = join(stage, 'runtime'), cache = join(root, 'cache'), store = join(root, 'store')
    for (const directory of [root, cache, store]) await mkdir(directory, { mode: 0o700 })
    const arch = process.arch as 'x64' | 'arm64'
    const archives = { node: NODE_ARCHIVES[arch], pnpm: PNPM_ARCHIVE_SHA,
      pnpmExe: PNPM_EXE_ARCHIVE_SHA, pnpmNative: PNPM_NATIVE_ARCHIVES[arch] }
    const nodeArchive = await officialArchive(input.nodeArchivePath,
      `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${arch}.tar.gz`, archives.node, 100_000_000, stage, signal)
    const pnpmArchive = await officialArchive(input.pnpmArchivePath,
      `https://registry.npmjs.org/pnpm/-/pnpm-${PNPM_VERSION}.tgz`, archives.pnpm, 20_000_000, stage, signal)
    const exeArchive = await officialArchive(input.pnpmExeArchivePath,
      `https://registry.npmjs.org/@pnpm/exe/-/exe-${PNPM_VERSION}.tgz`, archives.pnpmExe, 60_000_000, stage, signal)
    const nativeArchive = await officialArchive(input.pnpmNativeArchivePath,
      `https://registry.npmjs.org/@pnpm/linux-${arch}/-/linux-${arch}-${PNPM_VERSION}.tgz`,
      archives.pnpmNative, 100_000_000, stage, signal)
    const bin = join(root, 'bin'), pnpmRoot = join(root, 'pnpm'), nativeRoot = join(root, 'pnpm-native')
    for (const directory of [bin, pnpmRoot, nativeRoot]) await mkdir(directory, { mode: 0o700 })
    const node = await extractExact(nodeArchive, `node-${NODE_VERSION}-linux-${arch}/bin/node`, stage, signal, 150_000_000)
    const nodePath = join(bin, 'node')
    await writeFile(nodePath, node, { mode: 0o500 })
    await chmod(nodePath, 0o500)
    await run('/usr/bin/tar', ['-xzf', pnpmArchive, '--strip-components=1', '-C', pnpmRoot], stage,
      { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C' }, signal, 120_000)
    await run('/usr/bin/tar', ['-xzf', exeArchive, '--strip-components=1', '-C', nativeRoot], stage,
      { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C' }, signal, 120_000)
    const native = await extractExact(nativeArchive, 'package/pnpm', stage, signal, 150_000_000)
    const nativePnpmPath = join(nativeRoot, 'pnpm')
    await writeFile(nativePnpmPath, native, { mode: 0o500 })
    await chmod(nativePnpmPath, 0o500)
    // The existing release adapter binds the whole native pnpm package root
    // and requires its exact Node and pnpm entrypoints in that same directory.
    // Keep a separate regular copy so both the package root and the standalone
    // Node entrypoint remain pinned without external links or shared inodes.
    await writeFile(join(nativeRoot, 'node'), node, { flag: 'wx', mode: 0o500 })
    for (const [name, bytes] of manifests) {
      const path = join(root, name)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(path, bytes, { mode: 0o600 })
    }
    const pnpmPath = join(pnpmRoot, 'bin', 'pnpm.mjs')
    const env: NodeJS.ProcessEnv = { PATH: `${bin}:/usr/bin:/bin`, HOME: stage, LANG: 'C', LC_ALL: 'C', CI: 'true',
      npm_config_userconfig: '/dev/null', npm_config_globalconfig: '/dev/null',
      npm_config_registry: 'https://registry.npmjs.org/', npm_config_store_dir: store,
      npm_config_cache_dir: cache, pnpm_config_cache_dir: cache, COREPACK_ENABLE_PROJECT_SPEC: '0' }
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy',
      'SSL_CERT_FILE', 'SSL_CERT_DIR']) if (process.env[key] !== undefined) env[key] = process.env[key]
    await run(nodePath, [pnpmPath, 'fetch', '--workspace-root', '--frozen-lockfile', '--ignore-scripts',
      '--store-dir', store, '--cache-dir', cache,
      '--config.package-import-method=copy', '--reporter=append-only'], root, env, signal, 600_000)
    await run(nodePath, [pnpmPath, 'install', '--offline', '--frozen-lockfile', '--ignore-scripts',
      '--store-dir', store, '--cache-dir', cache,
      '--config.package-import-method=copy', '--reporter=append-only'], root, env, signal, 600_000)
    await sourceIdentity(input)
    const fresh = await frozenManifests(input.source)
    if (!isDeepStrictEqual([...fresh], [...manifests])) fail('frozen manifest changed during prepare')
    const modulesPath = join(root, 'node_modules')
    for (const name of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt']) {
      const link = join(modulesPath, name)
      if (await lstat(link).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })) continue
      const candidates = ['plugins/assistant-verifier', 'plugins/assistant-isolation',
        'plugins/plugin-control-plane', 'plugins/lark-channel'].map(workspace => join(root, workspace, 'node_modules', name))
      let target: string | undefined
      for (const candidate of candidates) {
        const actual = await realpath(candidate).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
        if (actual && within(actual, root)) { target = actual; break }
      }
      if (!target) fail(`Linux runtime package missing: ${name}`)
      await mkdir(dirname(link), { recursive: true, mode: 0o700 })
      await symlink(relative(dirname(link), target), link)
    }
    const versions = { node: NODE_VERSION, pnpm: PNPM_VERSION, typescript: '', cordis: '',
      tools: '', systemPrompt: '' }
    for (const [key, name] of [['typescript', 'typescript'], ['cordis', '@deepseek-ai/cordis'],
      ['tools', '@deepseek-ai/dsh-tools'], ['systemPrompt', '@deepseek-ai/dsh-system-prompt']] as const) {
      const actual = await realpath(join(modulesPath, name, 'package.json'))
      if (!within(actual, root)) fail(`Linux runtime package escaped root: ${name}`)
      const manifest = JSON.parse(await readFile(actual, 'utf8')) as { version?: string }
      if (!manifest.version) fail(`Linux runtime package missing: ${name}`)
      versions[key] = manifest.version
    }
    const treeSha = await hashLinuxRuntimeTree(root)
    const info = await stat(root)
    const runtime: LinuxRuntime = { schemaVersion: 1, backend: 'linux-native',
      platform: `linux-${arch}`, sourceCommit: input.source.sourceCommit,
      lockSha256: sha(manifests.get('pnpm-lock.yaml')!),
      root: { path: join(final, 'runtime'), dev: info.dev, ino: info.ino, sha256: treeSha },
      nodePath: join(final, 'runtime', 'bin', 'node'), nodeSha256: sha(node),
      pnpmPath: join(final, 'runtime', 'pnpm', 'bin', 'pnpm.mjs'),
      nativePnpmRoot: join(final, 'runtime', 'pnpm-native'),
      nativePnpmPath: join(final, 'runtime', 'pnpm-native', 'pnpm'),
      modulesPath: join(final, 'runtime', 'node_modules'),
      storePath: join(final, 'runtime', 'store'), cachePath: join(final, 'runtime', 'cache'),
      versions: { ...versions, node: NODE_VERSION, pnpm: PNPM_VERSION } }
    const hashes = Object.fromEntries([...manifests].map(([name, bytes]) => [name, sha(bytes)]))
    const content = { schemaVersion: 3 as const, backend: 'linux-native' as const,
      sourceCommit: input.source.sourceCommit, lockSha256: runtime.lockSha256,
      runtime, dshHome: input.dshHome, profile: input.profile, manifestHashes: hashes, archives }
    await writeFile(join(stage, 'bootstrap.json'), JSON.stringify({ ...content,
      receiptDigest: sha(JSON.stringify(content)) }), { mode: 0o600 })
    // pnpm may put diagnostics or transient state under its private HOME.
    // Only the pinned runtime and receipt become durable authority inputs.
    for (const name of await readdir(stage)) {
      if (name !== 'runtime' && name !== 'bootstrap.json') await rm(join(stage, name), { recursive: true, force: true })
    }
    await syncDirectory(root); await syncDirectory(stage)
    await rename(stage, final); await syncDirectory(parent)
    return readExisting(final, input, manifests)
  } finally { await rm(stage, { recursive: true, force: true }) }
}

export async function readLinuxRsiRuntime(input: LinuxRsiBootstrapInput): Promise<LinuxRsiBuildEnvironment> {
  input.signal?.throwIfAborted()
  await doctor()
  if (!canonical(input.dshHome) || !PROFILE.test(input.profile) || input.source.schemaVersion !== 1) fail('invalid bootstrap identity')
  await privateDirectory(input.dshHome)
  await sourceIdentity(input)
  return readExisting(join(input.dshHome, 'rsi-linux-runtimes', input.profile), input, await frozenManifests(input.source))
}
