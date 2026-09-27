import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { isMap, isScalar, parseDocument } from 'yaml'
import { rsiBuildResources as io } from './rsi-build.js'
import type { RsiSourceWorkspace } from './rsi-source.js'

const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const HASH = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const INTERNAL = '@dsh-enhanced/'
const COORDINATOR = ['assistant-policy', 'assistant-automations', 'plugin-control-plane'] as const
const MAX_ARCHIVE = 268_435_456
const MAX_PACKAGE_FILES = 10_000
const MAX_PACKAGES = 128

export interface RsiLocalCohortPackage {
  name: string
  path: string
  bundle: boolean
  runtimeDependencies: string[]
  tarball: string
  sha256: string
  files: { path: string; sha256: string; mode: number }[]
}
export interface RsiLocalCohort {
  schemaVersion: 1
  root: string
  sourceCommit: string
  version: string
  sourceRepository: string
  allowBuilds: Record<string, boolean>
  bundles: string[]
  packages: RsiLocalCohortPackage[]
  receiptDigest: string
}
export interface RsiLocalCohortPorts {
  /** The output contains one slug directory per package, each with one .tgz. */
  build(workspace: string, output: string, packagePaths: readonly string[], signal: AbortSignal): Promise<void>
}

function fail(message: string): never { throw new Error(`rsi local cohort: ${message}`) }
function digest(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex') }
function exact(path: string): boolean { return isAbsolute(path) && resolve(path) === path && !path.includes('\0') }
function inside(root: string, path: string): boolean { const rel = relative(root, path); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) }
function same<T>(left: T, right: T): boolean { return JSON.stringify(left) === JSON.stringify(right) }
function slugOf(name: string): string {
  if (!name.startsWith(INTERNAL) || !SLUG.test(name.slice(INTERNAL.length))) fail(`invalid internal package name: ${name}`)
  return name.slice(INTERNAL.length)
}
function validateInput(home: string, profile: string): void {
  if (!exact(home) || !PROFILE.test(profile)) fail('invalid home or profile')
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
async function stableFile(path: string, limit: number, ownerPrivate = false): Promise<Buffer> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await fd.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > limit || before.size < 0
      || ownerPrivate && (before.mode & 0o077) !== 0
      || process.getuid && before.uid !== process.getuid()) fail(`unsafe file: ${path}`)
    const bytes = await fd.readFile(), after = await fd.stat(), entry = await lstat(path)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size
      || entry.dev !== before.dev || entry.ino !== before.ino || entry.isSymbolicLink()) fail(`file changed during read: ${path}`)
    return bytes
  } finally { await fd.close() }
}
async function privateDirectory(path: string): Promise<void> { await io.directory(path) }
async function sourceManifest(root: string, path: string, version: string): Promise<Record<string, unknown>> {
  const manifest = JSON.parse((await stableFile(join(root, path, 'package.json'), 1_048_576)).toString('utf8')) as Record<string, unknown>
  if (manifest.name !== `${INTERNAL}${path.split('/')[1]}` || manifest.version !== version) fail(`package identity differs: ${path}`)
  return manifest
}
function runtimeDependencies(manifest: Record<string, unknown>): string[] {
  const names = new Set<string>()
  for (const field of ['dependencies', 'optionalDependencies']) {
    const map = manifest[field]
    if (map === undefined) continue
    if (!map || typeof map !== 'object' || Array.isArray(map)) fail(`invalid ${field}`)
    for (const [name, value] of Object.entries(map)) {
      if (typeof value !== 'string') fail(`invalid ${field} entry`)
      if (name.startsWith(INTERNAL)) { slugOf(name); names.add(name) }
    }
  }
  return [...names].sort()
}
async function approvedBuilds(workspace: string): Promise<Record<string, boolean>> {
  const document = parseDocument((await stableFile(join(workspace, 'pnpm-workspace.yaml'), 1_048_576)).toString('utf8'),
    { uniqueKeys: true })
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) fail('source workspace configuration is invalid')
  const mapping = document.get('allowBuilds', true)
  if (!isMap(mapping) || mapping.items.length > 128) fail('source allowBuilds must be a bounded mapping')
  const entries: [string, boolean][] = []
  for (const item of mapping.items) {
    if (!isScalar(item.key) || typeof item.key.value !== 'string'
      || !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(item.key.value)
      || !isScalar(item.value) || typeof item.value.value !== 'boolean') fail('source allowBuilds must contain package names and booleans')
    entries.push([item.key.value, item.value.value])
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
}
async function closure(workspace: string, version: string, bundles: readonly string[]): Promise<{ path: string; name: string; bundle: boolean; runtimeDependencies: string[] }[]> {
  const selected = new Set(bundles.map(slug => `${INTERNAL}${slug}`))
  const pending = [...new Set([...bundles, ...COORDINATOR].map(slug => `${INTERNAL}${slug}`))]
  const visited = new Map<string, { path: string; name: string; bundle: boolean; runtimeDependencies: string[] }>()
  while (pending.length) {
    if (visited.size >= MAX_PACKAGES) fail('package closure exceeds bound')
    const name = pending.shift()!
    if (visited.has(name)) continue
    const slug = slugOf(name)
    let path: string | undefined
    for (const base of ['plugins', 'packages']) {
      const candidate = `${base}/${slug}`
      if (await exists(join(workspace, candidate, 'package.json'))) {
        if (path) fail(`ambiguous package path: ${name}`)
        path = candidate
      }
    }
    if (!path) fail(`internal runtime dependency unavailable: ${name}`)
    const packageRoot = join(workspace, path)
    if (await realpath(packageRoot) !== packageRoot) fail(`package path escapes clean workspace: ${name}`)
    const manifest = await sourceManifest(workspace, path, version)
    const dependencies = runtimeDependencies(manifest)
    const bundle = path.startsWith('plugins/')
    if (selected.has(name) && !bundle) fail(`selected bundle is a library: ${name}`)
    visited.set(name, { path, name, bundle, runtimeDependencies: dependencies })
    pending.push(...dependencies)
  }
  return [...visited.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

function tarNumber(header: Buffer, start: number, length: number): number {
  const bytes = header.subarray(start, start + length)
  if (bytes.some(byte => byte !== 0 && byte !== 32 && (byte < 48 || byte > 55))) fail('unsupported tar number')
  const value = bytes.toString('ascii').replaceAll('\0', ' ').trim()
  if (!/^[0-7]+$/u.test(value)) fail('invalid tar number')
  const number = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(number)) fail('tar number exceeds bound')
  return number
}
function tarString(header: Buffer, start: number, length: number): string {
  const bytes = header.subarray(start, start + length), end = bytes.indexOf(0)
  if (end !== -1 && bytes.subarray(end).some(byte => byte !== 0)) fail('invalid tar string padding')
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString('utf8')
}
function archiveEntries(packed: Buffer): { path: string; sha256: string; mode: number }[] {
  let tar: Buffer
  try { tar = gunzipSync(packed, { maxOutputLength: MAX_ARCHIVE }) } catch { fail('invalid or oversized gzip tarball') }
  if (tar.length < 1536 || tar.length % 512) fail('invalid tar layout')
  const files: { path: string; sha256: string; mode: number }[] = [], seen = new Set<string>()
  let offset = 0, ended = false
  while (offset < tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) {
      if (tar.length - offset < 1024 || tar.subarray(offset).some(byte => byte !== 0)) fail('invalid tar terminator')
      ended = true; break
    }
    let checksum = 0
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]!
    if (checksum !== tarNumber(header, 148, 8)) fail('tar checksum differs')
    const type = header[156], size = tarNumber(header, 124, 12), mode = tarNumber(header, 100, 8) & 0o777
    if (type !== 0 && type !== 48 && type !== 53 || type === 53 && size !== 0) fail('tar links or special entries are forbidden')
    const name = tarString(header, 0, 100), prefix = tarString(header, 345, 155)
    const archivePath = prefix ? `${prefix}/${name}` : name
    const canonical = type === 53 && archivePath.endsWith('/') ? archivePath.slice(0, -1) : archivePath
    if (canonical !== 'package' && !canonical.startsWith('package/') || canonical.includes('//')
      || canonical.split('/').some(part => part === '' || part === '.' || part === '..')) fail('unsafe tar path')
    if (seen.has(canonical)) fail('duplicate tar path')
    seen.add(canonical)
    const next = offset + 512 + Math.ceil(size / 512) * 512
    if (next > tar.length) fail('truncated tar entry')
    if (type !== 53) {
      if (canonical === 'package') fail('package root is a file')
      files.push({ path: canonical.slice('package/'.length), sha256: digest(tar.subarray(offset + 512, offset + 512 + size)), mode })
      if (files.length > MAX_PACKAGE_FILES) fail('package file count exceeds bound')
    }
    offset = next
  }
  if (!ended || !files.some(item => item.path === 'package.json')) fail('archive has no package manifest')
  const filePaths = new Set(files.map(file => file.path))
  for (const file of files) {
    const parts = file.path.split('/')
    for (let i = 1; i < parts.length; i++) if (filePaths.has(parts.slice(0, i).join('/'))) fail('tar file is an ancestor')
  }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}
async function adapterNormalize(bytes: Buffer): Promise<Buffer> {
  const require = createRequire(import.meta.url)
  const root = dirname(require.resolve('@dsh-enhanced/plugin-control-plane/package.json'))
  const adapter = await import(pathToFileURL(join(root, 'bin', 'dsh-local-release-adapter.js')).href) as { normalizePackedDependencyOrder?: (bytes: Buffer) => Buffer }
  if (typeof adapter.normalizePackedDependencyOrder !== 'function') fail('installed Control Plane lacks archive validation')
  return adapter.normalizePackedDependencyOrder(bytes)
}
async function unpackAndCheck(tarball: string, files: RsiLocalCohortPackage['files'], stage: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const unpack = await mkdtemp(join(stage, 'unpack-'))
  try {
    await io.command('/usr/bin/tar', ['--no-same-owner', '--no-same-permissions', '-xzf', tarball, '-C', unpack],
      { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: stage }, signal, 60_000)
    const root = join(unpack, 'package')
    const actual: RsiLocalCohortPackage['files'] = []
    const walk = async (directory: string): Promise<void> => {
      for (const name of await readdir(directory)) {
        const path = join(directory, name), metadata = await lstat(path)
        if (metadata.isSymbolicLink() || !inside(root, path) || await realpath(path) !== path) fail('unsafe extracted file')
        if (metadata.isDirectory()) await walk(path)
        else if (metadata.isFile()) actual.push({ path: relative(root, path).split(sep).join('/'),
          sha256: digest(await stableFile(path, MAX_ARCHIVE)), mode: metadata.mode & 0o777 })
        else fail('nonregular extracted entry')
      }
    }
    await walk(root)
    actual.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    if (actual.length !== files.length || actual.some((item, index) => item.path !== files[index]?.path
      || item.sha256 !== files[index]?.sha256 || (item.mode & 0o100) !== (files[index]!.mode & 0o100)
      || (item.mode & 0o022) !== 0)) fail('extracted inventory differs from tar headers')
    return JSON.parse((await stableFile(join(root, 'package.json'), 1_048_576)).toString('utf8')) as Record<string, unknown>
  } finally { await rm(unpack, { recursive: true, force: true }) }
}
function validatePackedManifest(manifest: Record<string, unknown>, source: Record<string, unknown>, item: { name: string; bundle: boolean; runtimeDependencies: string[] }, version: string): void {
  if (manifest.name !== item.name || manifest.version !== version || manifest.main !== source.main
    || !same(manifest.exports, source.exports) || !same(manifest.dsh, source.dsh)
    || item.bundle !== Boolean((manifest.dsh as { bundle?: unknown } | undefined)?.bundle)
    || !same(runtimeDependencies(manifest), item.runtimeDependencies)) fail(`packed package manifest differs: ${item.name}`)
  for (const dependency of item.runtimeDependencies) {
    const value = (manifest.dependencies as Record<string, unknown> | undefined)?.[dependency]
      ?? (manifest.optionalDependencies as Record<string, unknown> | undefined)?.[dependency]
    if (typeof value !== 'string' || value.startsWith('workspace:') || value.startsWith('catalog:')) fail(`packed runtime dependency is unresolved: ${item.name} -> ${dependency}`)
  }
}
function expectedRoot(home: string, profile: string): string { return join(home, 'rsi-local-cohorts', profile) }
function validateReceipt(value: RsiLocalCohort, home: string, profile: string): void {
  if (!value || value.schemaVersion !== 1 || value.root !== expectedRoot(home, profile)
    || !COMMIT.test(value.sourceCommit) || typeof value.version !== 'string'
    || typeof value.sourceRepository !== 'string'
    || !exact(value.sourceRepository) && value.sourceRepository !== 'https://github.com/22-ai-00/dsh-enhanced.git'
    || !value.allowBuilds || typeof value.allowBuilds !== 'object' || Array.isArray(value.allowBuilds)
    || !Array.isArray(value.bundles) || !Array.isArray(value.packages) || !HASH.test(value.receiptDigest)) fail('invalid cohort receipt')
  const { receiptDigest, ...content } = value
  if (digest(JSON.stringify(content)) !== receiptDigest) fail('cohort receipt digest differs')
  const approved = Object.entries(value.allowBuilds)
  if (approved.length > 128 || !same(approved.map(([name]) => name), approved.map(([name]) => name).sort())
    || approved.some(([name, enabled]) => !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(name) || typeof enabled !== 'boolean')) fail('invalid approved build scripts')
  if (!same(value.bundles, [...new Set(value.bundles)].sort()) || value.bundles.some(slug => !SLUG.test(slug))) fail('invalid selected bundles')
  if (!same(value.packages.map(item => item.name), [...new Set(value.packages.map(item => item.name))].sort())) fail('invalid package order')
  for (const item of value.packages) {
    const slug = slugOf(item.name)
    if (item.path !== `plugins/${slug}` && item.path !== `packages/${slug}`
      || item.bundle !== item.path.startsWith('plugins/')
      || item.tarball !== join(value.root, 'artifacts', `${slug}.tgz`) || !HASH.test(item.sha256)
      || !Array.isArray(item.runtimeDependencies) || !same(item.runtimeDependencies, [...new Set(item.runtimeDependencies)].sort())
      || item.runtimeDependencies.some(name => !name.startsWith(INTERNAL)) || !Array.isArray(item.files)
      || !same(item.files.map(file => file.path), [...new Set(item.files.map(file => file.path))].sort())) fail('invalid package receipt')
    for (const file of item.files) if (typeof file.path !== 'string' || file.path.startsWith('/')
      || file.path.split('/').some(part => !part || part === '.' || part === '..') || !HASH.test(file.sha256)
      || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) fail('invalid inventory receipt')
  }
  if (value.packages.length > MAX_PACKAGES || value.packages.some(item => item.runtimeDependencies.some(name => !value.packages.some(other => other.name === name)))) fail('incomplete runtime closure')
  if (value.bundles.some(slug => !value.packages.some(item => item.name === `${INTERNAL}${slug}` && item.bundle))) fail('selected bundle missing')
  if (COORDINATOR.some(slug => !value.packages.some(item => item.name === `${INTERNAL}${slug}` && item.bundle))) fail('coordinator bundle missing')
}
async function readExisting(home: string, profile: string, source?: RsiSourceWorkspace): Promise<RsiLocalCohort> {
  const root = expectedRoot(home, profile)
  await privateDirectory(join(home, 'rsi-local-cohorts')); await privateDirectory(root)
  if (!same((await readdir(root)).sort(), ['artifacts', 'receipt.json'])) fail('cohort directory is incomplete')
  await privateDirectory(join(root, 'artifacts'))
  const value = JSON.parse((await stableFile(join(root, 'receipt.json'), 16_777_216, true)).toString('utf8')) as RsiLocalCohort
  validateReceipt(value, home, profile)
  if (source && (source.sourceCommit !== value.sourceCommit || source.version !== value.version
    || source.origin.locator !== value.sourceRepository)) fail('cohort source differs')
  const expectedNames = value.packages.map(item => `${slugOf(item.name)}.tgz`).sort()
  if (!same((await readdir(join(root, 'artifacts'))).sort(), expectedNames)) fail('cohort artifacts differ')
  for (const item of value.packages) {
    const packed = await stableFile(item.tarball, MAX_ARCHIVE, true)
    if (digest(packed) !== item.sha256 || !same(archiveEntries(packed), item.files)) fail(`cohort tarball differs: ${item.name}`)
  }
  return value
}
export async function readRsiLocalCohort(input: { dshHome: string; profile: string; source?: RsiSourceWorkspace }): Promise<RsiLocalCohort> {
  validateInput(input.dshHome, input.profile)
  await io.directory(input.dshHome, false)
  return readExisting(input.dshHome, input.profile, input.source)
}

async function defaultBuild(workspace: string, output: string, paths: readonly string[], signal: AbortSignal): Promise<void> {
  const pnpm = process.env.COREPACK_PNPM_PATH ?? 'pnpm'
  const environment = { ...process.env, COREPACK_ENABLE_AUTO_PIN: '0', npm_config_ignore_scripts: 'true' }
  const version = await io.command(pnpm, ['--version'], environment, signal, 15_000)
  if (version !== '11.7.0') fail('pnpm 11.7.0 is required')
  // This is owner-authorized bootstrap, not a candidate release build. Reuse
  // pnpm's normal cache while the frozen lock verifies downloaded packages.
  const configuredStore = await io.command(pnpm, ['store', 'path'], environment, signal, 15_000)
  if (!exact(configuredStore)) fail('pnpm store path is invalid')
  const store = await realpath(configuredStore).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return configuredStore
    throw error
  })
  await io.command(pnpm, ['--dir', workspace, 'install', '--frozen-lockfile', '--ignore-scripts', '--package-import-method=copy', `--store-dir=${store}`], environment, signal, 600_000, 2_097_152)
  await io.command(pnpm, ['--dir', workspace, '--workspace-root', '--if-present', 'run', 'build'], environment, signal, 600_000, 2_097_152)
  for (const path of paths) {
    signal.throwIfAborted()
    const destination = join(output, path.split('/')[1]!)
    await mkdir(destination, { mode: 0o700 })
    await io.command(pnpm, ['--dir', join(workspace, path), 'pack', '--pack-destination', destination], environment, signal, 180_000, 2_097_152)
  }
}
export const rsiLocalCohortPorts: RsiLocalCohortPorts = { build: defaultBuild }

/** The caller holds the DSH_HOME lifecycle lock. A claimed receipt is immutable. */
export async function prepareRsiLocalCohort(input: { dshHome: string; profile: string; source: RsiSourceWorkspace;
  bundles: string[]; signal?: AbortSignal }, ports: RsiLocalCohortPorts = rsiLocalCohortPorts): Promise<RsiLocalCohort> {
  validateInput(input.dshHome, input.profile)
  await io.directory(input.dshHome, false)
  if (input.source.schemaVersion !== 1 || !COMMIT.test(input.source.sourceCommit)
    || !exact(input.source.repository)
    || input.source.repository !== join(input.dshHome, 'rsi-sources', input.profile, 'checkout')
    || !exact(input.source.origin.locator) && input.source.origin.locator !== 'https://github.com/22-ai-00/dsh-enhanced.git'
    || !Array.isArray(input.bundles) || input.bundles.some(slug => !SLUG.test(slug))) fail('invalid source or bundle selection')
  const bundles = [...new Set(input.bundles)].sort()
  const parent = join(input.dshHome, 'rsi-local-cohorts')
  try { await mkdir(parent, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  await privateDirectory(parent)
  const final = expectedRoot(input.dshHome, input.profile)
  if (await exists(final)) {
    const value = await readExisting(input.dshHome, input.profile, input.source)
    if (!same(value.bundles, bundles)) fail('cohort bundle selection differs')
    return value
  }
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(1_800_000)])
  const stage = await mkdtemp(join(parent, `.${input.profile}-stage-`))
  await chmod(stage, 0o700)
  let claimed: { dev: number; ino: number } | undefined
  try {
    const workspace = join(stage, 'workspace'), output = join(stage, 'output')
    await mkdir(workspace, { mode: 0o700 }); await mkdir(output, { mode: 0o700 })
    const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: stage,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' }
    const git = (args: string[]) => io.command('/usr/bin/git', args, env, signal, 60_000)
    await git(['-C', workspace, 'init', '--object-format=sha1', '.'])
    await git(['-C', workspace, 'fetch', '--no-tags', '--no-recurse-submodules', input.source.repository,
      `+${input.source.sourceCommit}:refs/dsh-local-cohort/source`])
    await git(['-C', workspace, 'checkout', '--detach', input.source.sourceCommit])
    if (await git(['-C', workspace, 'rev-parse', 'HEAD']) !== input.source.sourceCommit
      || await git(['-C', workspace, 'status', '--porcelain=v1', '--untracked-files=all']) !== '') fail('build workspace is not exact clean commit')
    const rootManifest = JSON.parse((await stableFile(join(workspace, 'package.json'), 1_048_576)).toString('utf8')) as Record<string, unknown>
    if (rootManifest.name !== 'dsh-enhanced' || rootManifest.version !== input.source.version) fail('source root version differs')
    const allowBuilds = await approvedBuilds(workspace)
    const packages = await closure(workspace, input.source.version, bundles)
    const sourceManifests = new Map<string, Record<string, unknown>>()
    for (const item of packages) sourceManifests.set(item.name, await sourceManifest(workspace, item.path, input.source.version))
    await ports.build(workspace, output, packages.map(item => item.path), signal)
    signal.throwIfAborted()
    if (await git(['-C', workspace, 'rev-parse', 'HEAD']) !== input.source.sourceCommit
      || await git(['-C', workspace, 'diff', '--name-only']) !== ''
      || await git(['-C', workspace, 'diff', '--cached', '--name-only']) !== '') fail('tracked build input changed')
    await mkdir(final, { mode: 0o700 })
    const identity = await stat(final); claimed = { dev: identity.dev, ino: identity.ino }
    const artifacts = join(final, 'artifacts')
    await mkdir(artifacts, { mode: 0o700 })
    const entries: RsiLocalCohortPackage[] = []
    for (const item of packages) {
      const slug = slugOf(item.name), directory = join(output, slug), names = await readdir(directory)
      if (names.length !== 1 || !names[0]!.endsWith('.tgz')) fail(`pack output is ambiguous: ${item.name}`)
      const inputTar = join(directory, names[0]!)
      const bytes = await adapterNormalize(await stableFile(inputTar, MAX_ARCHIVE))
      const files = archiveEntries(bytes)
      const normalized = join(stage, `${slug}.tgz`)
      await io.writeExclusive(normalized, bytes)
      const packedManifest = await unpackAndCheck(normalized, files, stage, signal)
      validatePackedManifest(packedManifest, sourceManifests.get(item.name)!, item, input.source.version)
      const tarball = join(artifacts, `${slug}.tgz`)
      await rename(normalized, tarball)
      entries.push({ ...item, tarball, sha256: digest(bytes), files })
    }
    const content = { schemaVersion: 1 as const, root: final, sourceCommit: input.source.sourceCommit,
      version: input.source.version, sourceRepository: input.source.origin.locator, allowBuilds, bundles, packages: entries }
    const value: RsiLocalCohort = { ...content, receiptDigest: digest(JSON.stringify(content)) }
    validateReceipt(value, input.dshHome, input.profile)
    await io.syncDirectory(artifacts)
    await io.writeExclusive(join(final, 'receipt.json'), JSON.stringify(value))
    await io.syncDirectory(final); await io.syncDirectory(parent)
    return value
  } catch (error) {
    if (claimed) {
      const current = await lstat(final).catch(() => undefined)
      if (current?.isDirectory() && current.dev === claimed.dev && current.ino === claimed.ino
        && !await exists(join(final, 'receipt.json'))) await rm(final, { recursive: true, force: true })
    }
    throw error
  } finally { await rm(stage, { recursive: true, force: true }); await io.syncDirectory(parent) }
}

/** Validate the exact installed files for selected bundles and their own runtime closure. */
export async function verifyRsiLocalInstalledPackages(input: { cohort: RsiLocalCohort; profilePath: string; bundles?: string[] }): Promise<void> {
  const { cohort } = input
  if (!exact(input.profilePath) || !exact(cohort.root)) fail('invalid installed profile path')
  const home = dirname(dirname(cohort.root))
  validateReceipt(cohort, home, cohort.root.split(sep).at(-1)!)
  await readExisting(home, cohort.root.split(sep).at(-1)!)
  const root = await realpath(input.profilePath)
  if (root !== input.profilePath) fail('profile path is a link')
  const selected = input.bundles ?? cohort.bundles
  const packages = new Map(cohort.packages.map(item => [item.name, item]))
  if (!Array.isArray(selected) || selected.some(slug => !SLUG.test(slug)
    || !packages.get(`${INTERNAL}${slug}`)?.bundle)) fail('bundle is outside cohort')
  const pending = [...new Set(selected.map(slug => `${INTERNAL}${slug}`))]
    .map(name => ({ name, from: join(root, 'package.json') }))
  const visited = new Set<string>()
  while (pending.length) {
    const { name, from } = pending.shift()!
    const item = packages.get(name)
    if (!item) fail(`installed closure missing: ${name}`)
    const manifestPath = createRequire(from).resolve(`${name}/package.json`)
    const packageRoot = dirname(manifestPath), physical = await realpath(packageRoot)
    if (!inside(root, physical)) fail(`installed package escapes profile: ${name}`)
    const visitKey = `${name}\0${physical}`
    if (visited.has(visitKey)) continue
    visited.add(visitKey)
    const manifest = JSON.parse((await stableFile(manifestPath, 1_048_576)).toString('utf8')) as Record<string, unknown>
    if (manifest.name !== name || manifest.version !== cohort.version || !same(runtimeDependencies(manifest), item.runtimeDependencies)) fail(`installed package identity differs: ${name}`)
    for (const file of item.files) {
      const path = join(packageRoot, file.path), physicalFile = await realpath(path)
      if (!inside(physical, physicalFile)) fail(`installed package file escapes: ${name}/${file.path}`)
      const metadata = await lstat(path)
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o100) !== (file.mode & 0o100)
        || (metadata.mode & 0o022) !== 0
        || digest(await stableFile(path, MAX_ARCHIVE)) !== file.sha256) fail(`installed package file differs: ${name}/${file.path}`)
    }
    const actualFiles: string[] = []
    const walk = async (directory: string): Promise<void> => {
      for (const child of await readdir(directory)) {
        if (directory === packageRoot && child === 'node_modules') continue
        const path = join(directory, child), metadata = await lstat(path)
        if (metadata.isDirectory()) await walk(path)
        else if (metadata.isFile()) actualFiles.push(relative(packageRoot, path).split(sep).join('/'))
        else fail(`installed package has unsafe entry: ${name}`)
      }
    }
    await walk(packageRoot)
    if (!same(actualFiles.sort(), item.files.map(file => file.path))) fail(`installed package inventory differs: ${name}`)
    for (const dependency of item.runtimeDependencies) {
      // Resolve relative to this package so pnpm's nested layout cannot silently
      // route a runtime edge to a global or otherwise unrelated installation.
      const localRequire = createRequire(manifestPath)
      const dependencyPath = localRequire.resolve(`${dependency}/package.json`)
      if (!inside(root, await realpath(dependencyPath))) fail(`runtime dependency escapes profile: ${name} -> ${dependency}`)
      pending.push({ name: dependency, from: manifestPath })
    }
  }
}
