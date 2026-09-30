import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import type { SourceGrowthRunBinding } from '@dsh-enhanced/assistant-growth-contract'
import { ControlPlaneCliError } from './errors.js'
import { awaitSourceSignal, type SourceInspection } from './source-context.js'
import { changedSourcePaths, linkedWorktrees, runLocalBuffer, runLocalCommand, writeCreatedPluginFiles,
  validateScopedPluginFiles, type ScopedPluginFile } from './source-workspace.js'

const NAME = /^(?=.{1,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const GRANT_ID = /^(?=.{1,128}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const DIGEST = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const MAX_FILE_BYTES = 65_536
const MAX_TOTAL_BYTES = 262_144
const MAX_OUTPUT_BYTES = 8_192
const CREATE_SCOPE = (name: string): readonly string[] => Object.freeze([`plugins/${name}`, 'plugins/README.md', 'pnpm-lock.yaml'])
const HOST_INPUTS = ['scripts/create-plugin.mjs', 'LICENSE', 'plugins/README.md', 'package.json',
  'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.base.json'] as const
const RESERVED_OUTPUTS = ['package.json', 'cordis.patch.yml', 'LICENSE', 'tsconfig.json',
  'tsconfig.build.json', 'src/version.ts'] as const

export interface SourceCreationGrant {
  id: string
  expiresAt: number
  maxCreates: number
  namePrefix: string
}

export interface SourceCreationBinding {
  grant: SourceCreationGrant
  generatorDigest: string
  /** Host-frozen ordinary-use run; absent on historical and manual creations. */
  growthRun?: SourceGrowthRunBinding
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

/** Shape validation remains valid for historical, already-expired grants. */
export function validateSourceCreationGrant(value: unknown): asserts value is SourceCreationGrant {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'expiresAt,id,maxCreates,namePrefix'
    || typeof value.id !== 'string' || !GRANT_ID.test(value.id) || value.id.normalize('NFC') !== value.id
    || typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0
    || typeof value.maxCreates !== 'number' || !Number.isSafeInteger(value.maxCreates) || value.maxCreates < 1 || value.maxCreates > 1_000
    || typeof value.namePrefix !== 'string' || value.namePrefix.length < 2 || value.namePrefix.length > 48
    || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-$/u.test(value.namePrefix)) {
    throw new ControlPlaneCliError('INVALID_ARGUMENT', 'source creation grant is invalid')
  }
}

/** Candidate authority is limited to runtime source, documentation, and tests. */
export function validateSourceCreationFiles(files: readonly ScopedPluginFile[]): void {
  validateScopedPluginFiles(files)
  for (const file of files) {
    if (file.path !== file.path.normalize('NFC')
      || !(file.path === 'README.md' || /^(?:src|tests)\/(?:[a-zA-Z0-9][a-zA-Z0-9._-]*\/)*[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(file.path))
      || file.path === 'src/version.ts' || file.path.endsWith('/package.json')
      || file.path.endsWith('/cordis.patch.yml') || file.path.endsWith('/LICENSE')
      || file.path.endsWith('/tsconfig.json') || file.path.endsWith('/tsconfig.build.json')) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', `source creation file is outside candidate authority: ${JSON.stringify(file.path)}`)
    }
  }
}

function creationName(name: string, grant: SourceCreationGrant): void {
  validateSourceCreationGrant(grant)
  if (name.normalize('NFC') !== name || !NAME.test(name) || !name.startsWith(grant.namePrefix)
    || name.length <= grant.namePrefix.length) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'new plugin name is outside the owner creation namespace')
  }
}

interface BaseBlob { path: string; hash: string; mode: string; bytes: number }
interface BaseAssets { repository: string; baseCommit: string; generatorDigest: string; blobs: ReadonlyMap<string, BaseBlob> }

async function checked<T>(signal: AbortSignal, assertCurrent: () => void | Promise<void>, operation: () => T | Promise<T>): Promise<T> {
  signal.throwIfAborted(); await awaitSourceSignal(signal, assertCurrent)
  const result = await operation(); signal.throwIfAborted(); await awaitSourceSignal(signal, assertCurrent)
  return result
}

async function canonicalGitRoot(path: string, environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
  const repository = await realpath(path)
  if (repository !== resolve(path)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source repository must be canonical')
  const top = (await runLocalCommand('git', ['rev-parse', '--show-toplevel'], repository, environment,
    { capture: true, maximumOutput: 4_096, timeoutMs: 15_000, signal })).trim()
  if (top !== repository) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source repository must be a Git top-level')
  return repository
}

async function baseAssets(input: { repository: string; baseCommit?: string; baselineCommit?: string;
  environment: NodeJS.ProcessEnv; signal: AbortSignal; assertCurrent: () => void | Promise<void> }): Promise<BaseAssets> {
  const repository = await checked(input.signal, input.assertCurrent,
    () => canonicalGitRoot(input.repository, input.environment, input.signal))
  if (input.baseCommit !== undefined && !COMMIT.test(input.baseCommit)
    || input.baselineCommit !== undefined && !COMMIT.test(input.baselineCommit)) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation base commit is invalid')
  }
  const baseCommit = (await checked(input.signal, input.assertCurrent,
    () => runLocalCommand('git', ['rev-parse', '--verify', `${input.baselineCommit ?? 'HEAD'}^{commit}`], repository,
      input.environment, { capture: true, maximumOutput: 4_096, timeoutMs: 15_000, signal: input.signal }))).trim()
  if (!COMMIT.test(baseCommit) || input.baseCommit !== undefined && input.baseCommit !== baseCommit
    || input.baselineCommit !== undefined && input.baselineCommit !== baseCommit) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation base commit changed')
  }
  const listed = await checked(input.signal, input.assertCurrent,
    () => runLocalCommand('git', ['--literal-pathspecs', 'ls-tree', '-r', '-l', '-z', baseCommit, '--',
      ...HOST_INPUTS, 'templates/plugin'], repository, input.environment,
    { capture: true, maximumOutput: 65_536, timeoutMs: 15_000, signal: input.signal }))
  const blobs = new Map<string, BaseBlob>()
  for (const entry of listed.split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40}) +([0-9]+)\t(.+)$/u.exec(entry)
    if (match === null || blobs.has(match[4]!) || Number(match[3]) > 8_388_608
      || !(HOST_INPUTS as readonly string[]).includes(match[4]!) && !match[4]!.startsWith('templates/plugin/')) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation base inputs are unsafe')
    }
    blobs.set(match[4]!, { path: match[4]!, hash: match[2]!, mode: match[1]!, bytes: Number(match[3]) })
  }
  if (HOST_INPUTS.some(path => !blobs.has(path)) || ![...blobs.keys()].some(path => path.startsWith('templates/plugin/'))
    || [...blobs.keys()].some(path => path.startsWith('templates/plugin/') && !path.endsWith('.tpl'))) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation template or Host inputs are missing')
  }
  const manifest = JSON.parse((await gitBlob(repository, blobs.get('package.json')!, input.environment, input.signal)).toString('utf8')) as { scripts?: Record<string, unknown> }
  if (manifest.scripts?.['create:plugin'] !== 'node ./scripts/create-plugin.mjs') {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base public generator command changed')
  }
  const digest = createHash('sha256').update('dsh-prepared-create-generator-v1\0')
  for (const blob of [...blobs.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    digest.update(blob.path).update('\0').update(blob.mode).update('\0').update(blob.hash).update('\0')
  }
  return { repository, baseCommit, generatorDigest: digest.digest('hex'), blobs }
}

async function gitBlob(repository: string, blob: BaseBlob, environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<Buffer> {
  const bytes = await runLocalBuffer('git', ['cat-file', 'blob', blob.hash], repository, environment,
    { maximumOutput: blob.bytes + 1, timeoutMs: 15_000, signal })
  if (bytes.length !== blob.bytes) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation base blob changed')
  return bytes
}

async function safeBytes(path: string, maxBytes: number): Promise<Buffer> {
  const expected = resolve(path)
  if (await realpath(expected) !== expected) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file is not canonical')
  const before = await lstat(expected)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file is not a bounded regular file')
  }
  const handle = await open(expected, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const bytes = await handle.readFile(); const after = await lstat(expected)
    if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file changed while read')
    }
    return bytes
  } finally { await handle.close() }
}

async function assertBaseFiles(worktree: string, assets: BaseAssets, environment: NodeJS.ProcessEnv, signal: AbortSignal,
  generated = false): Promise<void> {
  for (const blob of assets.blobs.values()) {
    if (generated && (blob.path === 'plugins/README.md' || blob.path === 'pnpm-lock.yaml')) continue
    signal.throwIfAborted()
    const path = resolve(worktree, blob.path)
    if (!path.startsWith(`${worktree}/`) || dirname(path) === worktree && blob.path.includes('..')) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation base file escapes worktree')
    }
    const current = await safeBytes(path, blob.bytes)
    const baseline = await gitBlob(assets.repository, blob, environment, signal)
    if (!current.equals(baseline)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', `source creation base input changed: ${blob.path}`)
  }
}

async function assertCleanBase(worktree: string, assets: BaseAssets, environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  const root = await canonicalGitRoot(worktree, environment, signal)
  if (root !== worktree || (await runLocalCommand('git', ['rev-parse', 'HEAD'], worktree, environment,
    { capture: true, maximumOutput: 4_096, timeoutMs: 15_000, signal })).trim() !== assets.baseCommit
    || (await changedSourcePaths(worktree, assets.baseCommit, environment, signal)).length !== 0) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation worktree is not clean at the exact base')
  }
  await assertBaseFiles(worktree, assets, environment, signal)
}

async function assertFreshName(assets: BaseAssets, name: string, environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  const listed = await runLocalCommand('git', ['--literal-pathspecs', 'ls-tree', '-r', '-l', '-z', assets.baseCommit,
    '--', `plugins/${name}`, `packages/${name}`], assets.repository, environment,
  { capture: true, maximumOutput: 4_096, timeoutMs: 15_000, signal })
  if (listed !== '') throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'new plugin name already exists at base')
  const catalog = (await gitBlob(assets.repository, assets.blobs.get('plugins/README.md')!, environment, signal)).toString('utf8')
  if (catalog.includes(`@dsh-enhanced/${name}`) || catalog.includes(`](${name})`)) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'new plugin identity collides with catalog')
  }
  // A published package can retain its identity after its directory is renamed.
  // Check the pinned tree rather than relying on the directory or catalog alone.
  const tree = await runLocalCommand('git', ['--literal-pathspecs', 'ls-tree', '-r', '-l', '-z', assets.baseCommit,
    '--', 'plugins', 'packages'], assets.repository, environment,
  { capture: true, maximumOutput: 1_048_576, timeoutMs: 15_000, signal })
  for (const entry of tree.split('\0').filter(Boolean)) {
    const separator = entry.indexOf('\t')
    const path = entry.slice(separator + 1)
    if (!/^(?:plugins|packages)\/[^/]+\/package\.json$/u.test(path)) continue
    const match = /^(100644|100755) blob ([a-f0-9]{40}) +([0-9]+)$/u.exec(entry.slice(0, separator))
    if (separator < 0 || match === null || Number(match[3]) > 65_536) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base package manifest is unsafe')
    }
    const manifest = JSON.parse((await gitBlob(assets.repository,
      { path, mode: match[1]!, hash: match[2]!, bytes: Number(match[3]) }, environment, signal)).toString('utf8')) as { name?: unknown }
    if (manifest?.name === `@dsh-enhanced/${name}`) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'new plugin package identity already exists at base')
    }
  }
}

async function runPublicGenerator(worktree: string, name: string, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    signal.throwIfAborted()
    const child = spawn(process.execPath, ['./scripts/create-plugin.mjs', name], {
      cwd: worktree, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', HOME: worktree, NODE_OPTIONS: '' },
    })
    let bytes = 0; let tail = ''; let limited = false; let timedOut = false
    const collect = (chunk: Buffer): void => {
      bytes += chunk.length; tail = `${tail}${chunk.toString('utf8')}`.slice(-1_024)
      if (bytes > MAX_OUTPUT_BYTES) { limited = true; child.kill('SIGKILL') }
    }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 15_000)
    const abort = (): void => { child.kill('SIGKILL') }
    signal.addEventListener('abort', abort, { once: true })
    child.once('error', error => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(error) })
    child.once('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (signal.aborted) reject(signal.reason)
      else if (code !== 0 || timedOut || limited) reject(new ControlPlaneCliError('EXECUTOR_FAILED',
        `fixed public generator failed (${timedOut ? 'timeout' : limited ? 'output limit' : `exit ${code}`}): ${tail}`))
      else resolvePromise()
    })
  })
}

async function generatedFiles(worktree: string, name: string,
  bounds: { files: number; bytes: number } = { files: 64, bytes: MAX_TOTAL_BYTES }): Promise<readonly { path: string; bytes: number; content: string }[]> {
  const root = resolve(worktree, 'plugins', name)
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(root) !== root) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'generated plugin root is unsafe')
  const output: { path: string; bytes: number; content: string }[] = []
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await visit(join(directory, entry.name), path)
      else if (entry.isFile()) {
        const bytes = await safeBytes(join(directory, entry.name), MAX_FILE_BYTES)
        if (bytes.includes(0)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'generated plugin contains binary data')
        output.push({ path, bytes: bytes.length, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) })
      } else throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'generated plugin contains non-regular entry')
      if (output.length > bounds.files) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'generated plugin exceeds file bound')
    }
  }
  await visit(root, '')
  if (RESERVED_OUTPUTS.some(path => !output.some(file => file.path === path))
    || !output.some(file => file.path === 'README.md') || !output.some(file => file.path === 'tests/index.spec.ts')
    || output.reduce((total, file) => total + file.bytes, 0) > bounds.bytes) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'public generator output is incomplete or exceeds bounds')
  }
  return Object.freeze(output.sort((a, b) => a.path.localeCompare(b.path)))
}

async function generateChecked(worktree: string, name: string, assets: BaseAssets,
  environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<readonly { path: string; bytes: number; content: string }[]> {
  await assertCleanBase(worktree, assets, environment, signal)
  const target = resolve(worktree, 'plugins', name)
  if (await lstat(target).then(() => true, (error: NodeJS.ErrnoException) => error.code !== 'ENOENT')) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'new plugin root already exists')
  }
  await runPublicGenerator(worktree, name, signal)
  const changed = await changedSourcePaths(worktree, assets.baseCommit, environment, signal)
  if (changed.length < 2 || changed.some(path => path !== 'plugins/README.md' && !path.startsWith(`plugins/${name}/`))) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'public generator changed files outside new plugin and catalog')
  }
  return generatedFiles(worktree, name)
}

async function isolatedGenerator<T>(assets: BaseAssets, name: string, environment: NodeJS.ProcessEnv,
  signal: AbortSignal, action: (worktree: string, files: readonly { path: string; bytes: number; content: string }[]) => Promise<T>): Promise<T> {
  // The public generator runs against only approved Git blobs in a disposable
  // capsule. Inspect never changes the source repository or its worktree list.
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-create-inspect-'))
  try {
    for (const blob of assets.blobs.values()) {
      signal.throwIfAborted()
      const target = resolve(stateRoot, blob.path)
      if (!target.startsWith(`${stateRoot}/`)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'generator capsule input escapes')
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, await gitBlob(assets.repository, blob, environment, signal), { flag: 'wx', mode: 0o600 })
    }
    await mkdir(join(stateRoot, 'plugins'), { recursive: true })
    await runPublicGenerator(stateRoot, name, signal)
    const files = await generatedFiles(stateRoot, name)
    return await action(stateRoot, files)
  } finally { await rm(stateRoot, { recursive: true, force: true }) }
}

export async function inspectSourceCreationContext(input: {
  repository: string; name: string; paths: readonly string[]; baseCommit?: string; baselineCommit?: string
  environment: NodeJS.ProcessEnv; signal: AbortSignal; assertCurrent: () => void | Promise<void>; grant: SourceCreationGrant
}): Promise<SourceInspection & { generatorDigest: string }> {
  creationName(input.name, input.grant)
  if (input.grant.expiresAt <= Date.now()) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation grant expired')
  if (!Array.isArray(input.paths) || input.paths.length > 64 || input.paths.length !== new Set(input.paths).size) {
    throw new ControlPlaneCliError('INVALID_ARGUMENT', 'source creation context paths are invalid')
  }
  for (const path of input.paths) {
    if (typeof path !== 'string' || path !== path.normalize('NFC') || path === '' || isAbsolute(path)
      || path.includes('\\') || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation context path is invalid')
    }
  }
  const assets = await baseAssets(input)
  await assertFreshName(assets, input.name, input.environment, input.signal)
  return checked(input.signal, input.assertCurrent, async () => isolatedGenerator(assets, input.name, input.environment,
    input.signal, async (_worktree, generated) => {
      const selected = input.paths.map(path => {
        const file = generated.find(item => item.path === path)
        if (!file) throw new ControlPlaneCliError('SOURCE_BOUNDARY', `new plugin context path is unavailable: ${JSON.stringify(path)}`)
        return Object.freeze({ path, content: file.content })
      })
      if (selected.reduce((total, file) => total + Buffer.byteLength(file.content), 0) > MAX_TOTAL_BYTES) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'new plugin context exceeds content bound')
      }
      return Object.freeze({ name: input.name, baseCommit: assets.baseCommit, generatorDigest: assets.generatorDigest,
        files: Object.freeze(generated.map(file => Object.freeze({ path: file.path, bytes: file.bytes }))),
        contents: Object.freeze(selected) })
    }))
}

function lockImporter(base: string, manifest: Record<string, unknown>, name: string): string {
  if (Buffer.byteLength(base) > 8_388_608 || base.includes('\t') || base.includes('\r')
    || !base.startsWith("lockfileVersion: '9.0'\n")) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base lockfile has unsupported format')
  }
  const start = base.indexOf('\nimporters:\n')
  const end = base.indexOf('\npackages:\n')
  if (start < 0 || end <= start || base.indexOf('\nimporters:\n', start + 1) !== -1) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base lockfile importer section is ambiguous')
  }
  const importers = base.slice(start + '\nimporters:\n'.length, end)
  const newImporter = `plugins/${name}`
  const needed = new Map<string, { group: string; specifier: string }>()
  for (const group of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    const dependencies = manifest[group]
    if (dependencies === undefined) continue
    if (!record(dependencies)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'generated manifest dependencies are invalid')
    for (const [packageName, specifier] of Object.entries(dependencies)) {
      if (needed.has(packageName) || typeof specifier !== 'string' || specifier !== 'catalog:') {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'new plugin dependency is not a fixed catalog selection')
      }
      needed.set(packageName, { group, specifier })
    }
  }
  const scalar = (raw: string): string => {
    if (raw.startsWith("'")) {
      if (!/^'(?:[^']|'')*'$/u.test(raw)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base lock scalar is ambiguous')
      return raw.slice(1, -1).replaceAll("''", "'")
    }
    if (raw.startsWith('"')) {
      let value: unknown
      try { value = JSON.parse(raw) } catch { throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base lock scalar is ambiguous') }
      if (typeof value !== 'string') throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base lock scalar is ambiguous')
      return value
    }
    if (!/^[a-zA-Z0-9@._/+()-]+$/u.test(raw)
      && !/^(?:workspace:(?:\*|\^)|link:[a-zA-Z0-9./_-]+|[~^][0-9][0-9.]+)$/u.test(raw)) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base lock scalar is ambiguous')
    }
    return raw
  }
  const candidate = new Map<string, Set<string>>()
  const importersSeen = new Set<string>()
  const groupsSeen = new Set<string>()
  const dependenciesSeen = new Set<string>()
  let importer = ''; let group = ''; let dependency = ''
  let specifier: string | undefined; let version: string | undefined
  const finishDependency = (): void => {
    if (dependency !== '' && needed.has(dependency) && specifier === needed.get(dependency)!.specifier) {
      if (version === undefined || !/^[a-zA-Z0-9][a-zA-Z0-9@.+()/_-]*$/u.test(version)) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', `base lock resolution for ${dependency} is incomplete or unsafe`)
      }
      const selected = candidate.get(dependency) ?? new Set<string>()
      selected.add(version); candidate.set(dependency, selected)
    }
    dependency = ''; specifier = undefined; version = undefined
  }
  for (const line of importers.split('\n')) {
    if (line === '') continue
    const importerMatch = /^  ([^ ].*):$/u.exec(line)
    if (importerMatch) {
      finishDependency()
      importer = scalar(importerMatch[1]!); group = ''; groupsSeen.clear(); dependenciesSeen.clear()
      if (importersSeen.has(importer) || importer === newImporter) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base lock importer is duplicate or already exists')
      }
      importersSeen.add(importer)
      continue
    }
    const groupMatch = /^    ([^ ].*):$/u.exec(line)
    if (groupMatch) {
      finishDependency()
      group = scalar(groupMatch[1]!); dependenciesSeen.clear()
      if (importer === '' || groupsSeen.has(group)
        || !['dependencies', 'devDependencies', 'optionalDependencies'].includes(group)) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base lock importer group is unsupported or duplicate')
      }
      groupsSeen.add(group)
      continue
    }
    const dependencyMatch = /^      ([^ ].*):$/u.exec(line)
    if (dependencyMatch) {
      finishDependency()
      dependency = scalar(dependencyMatch[1]!)
      if (group === '' || dependenciesSeen.has(dependency)) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base lock importer dependency is duplicate or misplaced')
      }
      dependenciesSeen.add(dependency)
      continue
    }
    const fieldMatch = /^        (specifier|version): (.+)$/u.exec(line)
    if (!fieldMatch || dependency === '') throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base lock importer syntax is unsupported')
    if (fieldMatch[1] === 'specifier') {
      if (specifier !== undefined) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base lock importer repeats specifier')
      specifier = scalar(fieldMatch[2]!)
    } else {
      if (version !== undefined) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base lock importer repeats version')
      version = scalar(fieldMatch[2]!)
    }
  }
  finishDependency()
  for (const key of needed.keys()) {
    if (candidate.get(key)?.size !== 1) throw new ControlPlaneCliError('SOURCE_BOUNDARY', `base lock resolution for ${key} is absent or ambiguous`)
  }
  let block = `  ${newImporter}:\n`
  for (const selectedGroup of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    const entries = [...needed].filter(([, item]) => item.group === selectedGroup).sort(([a], [b]) => a.localeCompare(b))
    if (entries.length === 0) continue
    block += `    ${selectedGroup}:\n`
    for (const [key, value] of entries) {
      block += `      '${key.replaceAll("'", "''")}':\n        specifier: '${value.specifier}'\n        version: ${JSON.stringify([...candidate.get(key)!][0]!)}\n`
    }
  }
  const result = `${base.slice(0, end)}\n${block}${base.slice(end)}`
  if (result.replace(`\n${block}`, '') !== base) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'new lock importer projection changed existing lock data')
  return result
}

async function assertOnlyCreationChanges(worktree: string, baseCommit: string, name: string,
  environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  const changed = await changedSourcePaths(worktree, baseCommit, environment, signal)
  if (changed.some(path => path !== 'plugins/README.md' && path !== 'pnpm-lock.yaml' && !path.startsWith(`plugins/${name}/`))) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation changed outside exact scope')
  }
}

/** Reconstruct Host-owned output with the same base generator in a disposable
 * capsule, then compare bytes. This is also called after Docker checks so a
 * candidate cannot change its manifest, patch, catalog, lock or scaffold
 * config between preflight and durable plan creation. */
export async function verifyCreatedPluginWorkspace(input: {
  worktree: string; baseCommit: string; name: string; environment: NodeJS.ProcessEnv
  signal: AbortSignal; assertCurrent: () => void | Promise<void>; creation: SourceCreationBinding
  files?: readonly ScopedPluginFile[]
}): Promise<{ scope: readonly string[]; generatorDigest: string }> {
  creationName(input.name, input.creation.grant)
  if (!DIGEST.test(input.creation.generatorDigest)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation generator digest is invalid')
  if (input.files !== undefined) validateSourceCreationFiles(input.files)
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(120_000)])
  const assets = await baseAssets({ repository: input.worktree, baseCommit: input.baseCommit,
    environment: input.environment, signal, assertCurrent: input.assertCurrent })
  if (assets.generatorDigest !== input.creation.generatorDigest) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation generator inputs changed')
  const worktree = assets.repository
  await checked(signal, input.assertCurrent, () => assertBaseFiles(worktree, assets, input.environment, signal, true))
  await assertOnlyCreationChanges(worktree, assets.baseCommit, input.name, input.environment, signal)
  const expected = await isolatedGenerator(assets, input.name, input.environment, signal, async (capsule, generated) => ({
    files: generated, catalog: await safeBytes(join(capsule, 'plugins', 'README.md'), MAX_FILE_BYTES),
  }))
  // The generated scaffold counts against the same final candidate budget.
  const observed = await generatedFiles(worktree, input.name)
  const existing = new Map(observed.map(file => [file.path, file]))
  const initial = new Map(expected.files.map(file => [file.path, file]))
  for (const path of RESERVED_OUTPUTS) {
    if (existing.get(path)?.content !== initial.get(path)?.content) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', `Host-owned generated file changed: ${path}`)
    }
  }
  const catalog = await safeBytes(join(worktree, 'plugins', 'README.md'), MAX_FILE_BYTES)
  if (!catalog.equals(expected.catalog)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'generated catalog changed')
  const manifest = JSON.parse(initial.get('package.json')!.content) as Record<string, unknown>
  const baseLock = (await gitBlob(worktree, assets.blobs.get('pnpm-lock.yaml')!, input.environment, signal)).toString('utf8')
  const expectedLock = lockImporter(baseLock, manifest, input.name)
  if (!(await safeBytes(join(worktree, 'pnpm-lock.yaml'), 8_388_608)).equals(Buffer.from(expectedLock))) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'Host-owned new lock importer changed')
  }
  for (const file of observed) {
    if (!initial.has(file.path) && !creationCandidatePath(file.path)) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', `new plugin contains unauthorized file: ${file.path}`)
    }
  }
  if (input.files !== undefined) {
    for (const file of input.files) {
      if (existing.get(file.path)?.content !== file.content) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', `source creation proposed file changed: ${file.path}`)
      }
    }
  }
  const changed = await changedSourcePaths(worktree, assets.baseCommit, input.environment, signal)
  for (const path of changed) {
    if (path === 'plugins/README.md' || path === 'pnpm-lock.yaml') continue
    const prefix = `plugins/${input.name}/`
    if (!path.startsWith(prefix)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation changed outside exact scope')
    const within = path.slice(prefix.length)
    if (!initial.has(within) && !creationCandidatePath(within)
      || initial.has(within) && !creationCandidatePath(within) && existing.get(within)?.content !== initial.get(within)?.content) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', `source creation changed protected file: ${within}`)
    }
  }
  await checked(signal, input.assertCurrent, () => Promise.resolve())
  return Object.freeze({ scope: CREATE_SCOPE(input.name), generatorDigest: assets.generatorDigest })
}

function creationCandidatePath(path: string): boolean {
  try { validateSourceCreationFiles([{ path, content: '' }]); return true } catch { return false }
}

export async function prepareCreatedPluginWorkspace(input: {
  worktree: string; baseCommit: string; name: string; files: readonly ScopedPluginFile[]
  environment: NodeJS.ProcessEnv; signal: AbortSignal; assertCurrent: () => void | Promise<void>; creation: SourceCreationBinding
}): Promise<{ scope: readonly string[]; generatorDigest: string }> {
  creationName(input.name, input.creation.grant)
  validateSourceCreationFiles(input.files)
  if (!DIGEST.test(input.creation.generatorDigest) || input.creation.grant.expiresAt <= Date.now()) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation binding expired or has invalid generator digest')
  }
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(120_000)])
  const assets = await baseAssets({ repository: input.worktree, baseCommit: input.baseCommit,
    environment: input.environment, signal, assertCurrent: input.assertCurrent })
  if (assets.generatorDigest !== input.creation.generatorDigest) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation generator inputs changed')
  const worktree = assets.repository
  const linked = await linkedWorktrees(worktree, input.environment)
  const privateParent = await lstat(dirname(worktree))
  if (linked.length < 2 || linked[0] === worktree || !linked.includes(worktree)
    || !privateParent.isDirectory() || privateParent.isSymbolicLink() || (privateParent.mode & 0o022) !== 0) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation requires a private linked non-primary worktree')
  }
  await assertFreshName(assets, input.name, input.environment, signal)
  await checked(signal, input.assertCurrent, () => assertCleanBase(worktree, assets, input.environment, signal))
  const generated = await checked(signal, input.assertCurrent,
    () => generateChecked(worktree, input.name, assets, input.environment, signal))
  const manifest = JSON.parse(generated.find(file => file.path === 'package.json')!.content) as Record<string, unknown>
  if (manifest.name !== `@dsh-enhanced/${input.name}` || typeof manifest.version !== 'string'
    || !record(manifest.dsh) || !record(manifest.dsh.bundle) || manifest.dsh.bundle.patch !== './cordis.patch.yml') {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'public generator emitted invalid plugin identity')
  }
  const lockBase = (await gitBlob(worktree, assets.blobs.get('pnpm-lock.yaml')!, input.environment, signal)).toString('utf8')
  const lock = lockImporter(lockBase, manifest, input.name)
  await checked(signal, input.assertCurrent, () => writeFile(join(worktree, 'pnpm-lock.yaml'), lock, { flag: 'w' }))
  await checked(signal, input.assertCurrent, () => assertOnlyCreationChanges(worktree, assets.baseCommit, input.name, input.environment, signal))
  await checked(signal, input.assertCurrent, () => writeCreatedPluginFiles({ worktree, name: input.name, files: input.files }))
  return verifyCreatedPluginWorkspace({ ...input, worktree, signal })
}
