import { spawn } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import { parse as parseYaml } from 'yaml'

const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u
const COMMIT = /^[a-f0-9]{40}$/u
const ROOTS = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
const MANIFEST = /^(?:plugins|packages)\/[a-z0-9-]+\/package\.json$/u
const MAX_OUTPUT = 4_194_304
const OFFICIAL = 'https://github.com/22-ai-00/dsh-enhanced.git'
export interface FrozenLinuxRuntimeSource {
  version: string
  sourceCommit: string
  manifests: readonly { path: string; bytes: Uint8Array }[]
}
export type LinuxRuntimeSourceInput =
  | { kind: 'git-object'; repository: string; commit: string; version: string }
  | { kind: 'local-head'; repository: string; version: string }
  | { kind: 'official-tag'; version: string }
function fail(reason: string): never { throw new Error(`rsi Linux runtime: ${reason}`) }
const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u
function packageConfiguration(value: unknown): void {
  if (!record(value) || Object.hasOwn(value, 'pnpm') || Object.hasOwn(value, 'devEngines')
    || value.engines !== undefined && (!record(value.engines) || Object.hasOwn(value.engines, 'runtime'))) {
    fail('frozen package configuration unsupported')
  }
}

/** Workspace YAML is executable pnpm configuration, even with ignore-scripts.
 * Accept only the reviewed declarative fields, leaving every original byte intact. */
function workspaceConfiguration(value: unknown): void {
  const allowed = new Set(['packages', 'catalog', 'linkWorkspacePackages', 'allowBuilds', 'minimumReleaseAgeExclude'])
  if (!record(value) || Object.keys(value).some(key => !allowed.has(key))) fail('frozen workspace configuration unsupported')
  if (value.catalog !== undefined && (!record(value.catalog) || Object.entries(value.catalog).some(([name, version]) =>
    !PACKAGE.test(name) || typeof version !== 'string' || !EXACT_VERSION.test(version)))) fail('frozen workspace configuration catalog invalid')
  if (value.linkWorkspacePackages !== undefined && typeof value.linkWorkspacePackages !== 'boolean') fail('frozen workspace configuration links invalid')
  if (value.allowBuilds !== undefined && (!record(value.allowBuilds) || Object.entries(value.allowBuilds).some(([name, enabled]) =>
    !PACKAGE.test(name) || typeof enabled !== 'boolean'))) fail('frozen workspace configuration builds invalid')
  if (value.minimumReleaseAgeExclude !== undefined && (!Array.isArray(value.minimumReleaseAgeExclude)
    || value.minimumReleaseAgeExclude.some(entry => {
      if (typeof entry !== 'string') return true
      const split = entry.lastIndexOf('@')
      return split < 1 || !PACKAGE.test(entry.slice(0, split)) || !EXACT_VERSION.test(entry.slice(split + 1))
    }))) fail('frozen workspace configuration release exclusions invalid')
}

/** Copy every caller-owned byte before any asynchronous boundary. No caller digest is trusted. */
export function copyLinuxRuntimeManifests(source: FrozenLinuxRuntimeSource): Map<string, Buffer> {
  if (!source || !VERSION.test(source.version) || !COMMIT.test(source.sourceCommit)
    || !Array.isArray(source.manifests) || source.manifests.length < 3 || source.manifests.length > 256) fail('frozen manifest inventory incomplete')
  const files = new Map<string, Buffer>(); let size = 0
  for (const entry of source.manifests) {
    if (!entry || typeof entry.path !== 'string' || (!ROOTS.includes(entry.path) && !MANIFEST.test(entry.path))
      || files.has(entry.path) || !(entry.bytes instanceof Uint8Array) || entry.bytes.byteLength > MAX_OUTPUT) fail('frozen manifest inventory invalid')
    const bytes = Buffer.from(entry.bytes); size += bytes.length
    if (size > 8_388_608) fail('frozen manifest bytes exceed bound')
    files.set(entry.path, bytes)
  }
  if (!ROOTS.every(name => files.has(name))) fail('frozen manifest inventory incomplete')
  const sorted = new Map([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  let root: { name?: string; version?: string; packageManager?: string }
  try { root = JSON.parse(decode(sorted.get('package.json')!)) } catch { return fail('frozen root manifest invalid') }
  if (root?.name !== 'dsh-enhanced' || root.version !== source.version || root.packageManager !== 'pnpm@11.7.0') fail('frozen root manifest identity differs')
  packageConfiguration(root)
  const workspaces = new Set([...sorted.keys()].filter(name => MANIFEST.test(name)).map(dirname))
  const packageNames = new Set<string>()
  for (const name of workspaces) {
    try {
      const manifest = JSON.parse(decode(sorted.get(`${name}/package.json`)!))
      if (!manifest || typeof manifest.name !== 'string' || !manifest.name || packageNames.has(manifest.name)
        || manifest.version !== source.version || manifest.packageManager !== undefined && manifest.packageManager !== 'pnpm@11.7.0') fail('frozen workspace manifest identity differs')
      packageConfiguration(manifest)
      packageNames.add(manifest.name)
    } catch (error) {
      if (error instanceof Error && error.message.includes('frozen package configuration')) throw error
      fail('frozen workspace manifest invalid')
    }
  }
  let workspace: { packages?: unknown }
  try { workspace = parseYaml(decode(sorted.get('pnpm-workspace.yaml')!)) } catch { return fail('frozen workspace inventory invalid') }
  workspaceConfiguration(workspace)
  if (!workspace || !Array.isArray(workspace.packages)
    || workspace.packages.some((pattern: unknown) => !['plugins/*', 'packages/*'].includes(pattern as string))
    || new Set(workspace.packages).size !== workspace.packages.length
    || [...workspaces].some(name => !(workspace.packages as unknown[]).includes(name.split('/')[0] + '/*'))) fail('frozen workspace inventory invalid')
  const lock = decode(sorted.get('pnpm-lock.yaml')!)
  if (!lock.startsWith("lockfileVersion: '9.0'\n") || /(?:https?:\/\/(?!registry\.npmjs\.org\/)|git\+|\b(?:git|tarball):|(?:^|[\s'"])(?:file:))/imu.test(lock)) fail('frozen lockfile unsupported resolution')
  let parsed: { settings?: unknown; importers?: Record<string, Record<string, Record<string, { specifier?: string; version?: string }>>> }
  try { parsed = parseYaml(lock) } catch { return fail('frozen lockfile invalid') }
  if (!record(parsed) || Object.keys(parsed).some(key => !['lockfileVersion', 'settings', 'catalogs', 'importers', 'packages', 'snapshots'].includes(key))) fail('frozen lockfile configuration unsupported')
  if (parsed.settings !== undefined && (!record(parsed.settings)
    || Object.entries(parsed.settings).some(([key, value]) => !['autoInstallPeers', 'excludeLinksFromLockfile'].includes(key) || typeof value !== 'boolean'))) fail('frozen lockfile configuration settings unsupported')
  if (!parsed?.importers || typeof parsed.importers !== 'object' || !Object.hasOwn(parsed.importers, '.')
    || [...workspaces].some(name => !Object.hasOwn(parsed.importers!, name))) fail('frozen lockfile importers missing')
  for (const [importer, groups] of Object.entries(parsed.importers)) {
    if (importer !== '.' && !workspaces.has(importer)) fail('frozen importer outside manifest inventory')
    if (!record(groups) || Object.keys(groups).some(key => !['dependencies', 'devDependencies', 'optionalDependencies'].includes(key))) fail('frozen importer configuration unsupported')
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const value of Object.values(groups[group] ?? {})) {
        if (typeof value?.specifier !== 'string' || typeof value.version !== 'string') fail('frozen dependency invalid')
        if (/^(?:file:|git\+|github:|https?:)/iu.test(value.specifier)) fail('frozen dependency source unsupported')
        if (value.version.startsWith('link:')) {
          const target = resolve('/frozen', importer === '.' ? '' : importer, value.version.slice(5))
          if (!target.startsWith('/frozen/') || !workspaces.has(target.slice(8))) fail('frozen workspace link escapes manifests')
        }
      }
    }
  }
  return sorted
}

async function git(repository: string, args: string[], signal?: AbortSignal, network = false): Promise<Buffer> {
  signal?.throwIfAborted()
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_COUNT: '0',
    GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_ALLOW_PROTOCOL: network ? 'https' : 'file' }
  if (network) for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE']) if (process.env[key] !== undefined) env[key] = process.env[key]
  const bounded = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(60_000)])
  return new Promise<Buffer>((resolveOutput, reject) => {
    const child = spawn('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'credential.helper=', '-c', 'gc.auto=0', ...args], { cwd: repository, env,
      stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    let size = 0, failed = false
    const chunks: Buffer[] = []
    const stop = (): void => {
      if (child.pid) try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }
    bounded.addEventListener('abort', stop, { once: true })
    if (bounded.aborted) stop()
    child.stdout.on('data', (data: Buffer) => { size += data.length; if (size > MAX_OUTPUT) stop(); else chunks.push(data) })
    child.stderr.on('data', (data: Buffer) => { size += data.length; if (size > MAX_OUTPUT) stop() })
    child.once('error', () => { failed = true })
    child.once('close', code => {
      bounded.removeEventListener('abort', stop)
      if (failed || code !== 0 || size > MAX_OUTPUT || bounded.aborted) reject(new Error('rsi Linux runtime: frozen Git object unavailable'))
      else resolveOutput(Buffer.concat(chunks))
    })
  })
}

/** Only fixed Git blobs are read. No checkout, package script, repair branch or RSI workspace is created. */
export async function freezeLinuxRuntimeSource(input: LinuxRuntimeSourceInput & { signal?: AbortSignal }): Promise<FrozenLinuxRuntimeSource> {
  input.signal?.throwIfAborted()
  if (!VERSION.test(input.version) || !['git-object', 'local-head', 'official-tag'].includes(input.kind)) fail('invalid source version or kind')
  // Snapshot selection before asynchronous work; caller mutation never changes the selected object.
  input = { ...input }
  let temporary: string | undefined
  try {
    let repository: string, commit: string
    if (input.kind === 'official-tag') {
      temporary = await mkdtemp(join(await realpath(tmpdir()), 'dsh-native-source-'))
      repository = temporary
      await git(repository, ['init', '--bare', '--object-format=sha1', '.'], input.signal)
      await git(repository, ['fetch', '--depth=1', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', OFFICIAL,
        `+refs/tags/v${input.version}:refs/dsh-native/source`], input.signal, true)
      commit = (await git(repository, ['rev-parse', 'refs/dsh-native/source^{commit}'], input.signal)).toString('utf8').trim()
    } else {
      repository = input.repository
      if (typeof repository !== 'string' || !isAbsolute(repository) || resolve(repository) !== repository
        || repository.includes('\r') || repository.includes('\n') || repository.includes('\0') || await realpath(repository) !== repository) fail('source repository noncanonical')
      commit = input.kind === 'local-head' ? (await git(repository, ['rev-parse', 'HEAD'], input.signal)).toString('utf8').trim() : input.commit
    }
    if (!COMMIT.test(commit) || (await git(repository, ['cat-file', '-t', commit], input.signal)).toString('utf8').trim() !== 'commit') fail('source is not a SHA-1 commit')
    const listing = decode(await git(repository, ['ls-tree', '-r', '--name-only', '-z', commit], input.signal)).split('\0')
    const names = listing.filter(path => ROOTS.includes(path) || MANIFEST.test(path))
    if (names.length < 3 || names.length > 256) fail('frozen manifest inventory incomplete')
    const manifests: { path: string; bytes: Uint8Array }[] = []
    let size = 0
    for (const path of names) {
      const bytes = await git(repository, ['show', `${commit}:${path}`], input.signal)
      size += bytes.length
      if (size > 8_388_608) fail('frozen manifest bytes exceed bound')
      manifests.push({ path, bytes })
    }
    const source = { version: input.version, sourceCommit: commit, manifests }
    const checked = copyLinuxRuntimeManifests(source)
    return { version: source.version, sourceCommit: commit, manifests: [...checked].map(([path, bytes]) => ({ path, bytes })) }
  } finally { if (temporary) await rm(temporary, { recursive: true, force: true }) }
}
