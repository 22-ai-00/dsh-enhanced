import { constants as fsConstants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { ControlPlaneCliError } from './errors.js'
import { assertPluginModificationAllowed, runLocalBuffer, runLocalCommand, validateScopedPluginFiles, type ScopedPluginFile } from './source-workspace.js'

const NAME = /^(?=.{1,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const COMMIT = /^[a-f0-9]{40}$/u
const STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u
const MAX_FILE_BYTES = 65_536

export interface ManagedPatchVersionInput {
  worktree: string
  baseCommit: string
  name: string
  environment: NodeJS.ProcessEnv
  signal?: AbortSignal
  assertCurrent?: () => void | Promise<void>
}

export interface ManagedPatchVersionFiles {
  baseVersion: string
  version: string
  files: readonly ScopedPluginFile[]
}

function inputName(name: string): string {
  const normalized = name.normalize('NFC').trim()
  if (normalized !== name || !NAME.test(name)) throw new ControlPlaneCliError('INVALID_ARGUMENT', 'managed version plugin name is invalid')
  assertPluginModificationAllowed(name)
  return name
}

function nextStablePatch(version: string): string {
  const match = STABLE_VERSION.exec(version)
  if (match === null) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'managed version base must be a stable x.y.z version')
  const major = Number(match[1]); const minor = Number(match[2]); const patch = Number(match[3])
  if (![major, minor, patch].every(Number.isSafeInteger) || patch >= Number.MAX_SAFE_INTEGER) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'managed version base patch is outside the safe increment range')
  }
  return `${major}.${minor}.${patch + 1}`
}

function parseManifest(bytes: Buffer, label: string): Record<string, unknown> {
  if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES || bytes.includes(0)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', `${label} exceeds the managed version read bound`)
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new ControlPlaneCliError('SOURCE_BOUNDARY', `${label} is not strict UTF-8`) }
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new ControlPlaneCliError('SOURCE_BOUNDARY', `${label} is not valid JSON`) }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', `${label} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function assertBaseManifest(manifest: Record<string, unknown>, name: string): string {
  if (manifest.name !== `@dsh-enhanced/${name}` || manifest.version === undefined || typeof manifest.version !== 'string'
    || !('dsh' in manifest) || (manifest.dsh === null || typeof manifest.dsh !== 'object' || Array.isArray(manifest.dsh))
    || (manifest.dsh as { bundle?: unknown }).bundle === null || typeof (manifest.dsh as { bundle?: unknown }).bundle !== 'object'
    || Array.isArray((manifest.dsh as { bundle?: unknown }).bundle)
    || ((manifest.dsh as { bundle: { patch?: unknown } }).bundle.patch !== './cordis.patch.yml')) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'managed version base manifest identity or bundle patch is invalid')
  }
  nextStablePatch(manifest.version)
  return manifest.version
}

function manifestWithVersion(manifest: Record<string, unknown>, version: string): string {
  return `${JSON.stringify({ ...manifest, version }, null, 2)}\n`
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`
}

function equalExceptVersion(base: Record<string, unknown>, current: Record<string, unknown>, version: string): boolean {
  if (current.version !== version) return false
  const { version: _baseVersion, ...baseRest } = base
  const { version: _currentVersion, ...currentRest } = current
  return canonicalJson(baseRest) === canonicalJson(currentRest)
}

async function readCurrentRegularFile(worktree: string, path: string): Promise<Buffer> {
  const expected = resolve(worktree, path)
  const root = resolve(worktree)
  if (relative(root, expected).startsWith('..') || !isAbsolute(expected)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'managed version path escapes its worktree')
  const canonical = await realpath(expected)
  if (canonical !== expected) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'managed version current file must be canonical')
  const parent = await lstat(dirname(canonical)); const before = await lstat(canonical); const uid = process.getuid?.()
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0
    || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_FILE_BYTES || (before.mode & 0o022) !== 0
    || (uid !== undefined && before.uid !== 0 && before.uid !== uid)) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'managed version current file is not an owner-safe bounded regular file')
  }
  const handle = await open(canonical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const descriptor = await handle.stat(); const bytes = await handle.readFile(); const after = await lstat(canonical)
    if (!descriptor.isFile() || descriptor.nlink !== 1 || descriptor.dev !== before.dev || descriptor.ino !== before.ino
      || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || bytes.length !== before.size) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'managed version current file changed while being read')
    }
    return bytes
  } finally { await handle.close() }
}

async function readBaseFiles(input: ManagedPatchVersionInput): Promise<{ baseManifest: Record<string, unknown>; baseVersion: string; versionSource: string }> {
  const name = inputName(input.name)
  if (!COMMIT.test(input.baseCommit)) throw new ControlPlaneCliError('INVALID_ARGUMENT', 'managed version base commit is invalid')
  const signal = input.signal ?? new AbortController().signal
  const check = async (): Promise<void> => { signal.throwIfAborted(); await input.assertCurrent?.(); signal.throwIfAborted() }
  await check()
  const worktree = await realpath(input.worktree)
  if (worktree !== resolve(input.worktree)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'managed version worktree must be canonical')
  await check()
  const root = (await runLocalCommand('git', ['rev-parse', '--show-toplevel'], worktree, input.environment,
    { capture: true, maximumOutput: 4_096, timeoutMs: 15_000, signal })).trim()
  if (root !== worktree) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'managed version worktree must be the Git top-level')
  const verified = (await runLocalCommand('git', ['rev-parse', '--verify', `${input.baseCommit}^{commit}`], worktree, input.environment,
    { capture: true, maximumOutput: 4_096, timeoutMs: 15_000, signal })).trim()
  if (verified !== input.baseCommit) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'managed version base commit did not resolve exactly')
  const paths = [`plugins/${name}/package.json`, `plugins/${name}/src/version.ts`]
  await check()
  const listed = await runLocalCommand('git', ['--literal-pathspecs', 'ls-tree', '-l', '-z', input.baseCommit, '--', ...paths], worktree,
    input.environment, { capture: true, maximumOutput: 8_192, timeoutMs: 15_000, signal })
  const entries = new Map<string, { hash: string; bytes: number }>()
  for (const record of listed.split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40}) +(\d+)\t(.+)$/u.exec(record)
    if (match === null || !paths.includes(match[4]!) || Number(match[3]) > MAX_FILE_BYTES || entries.has(match[4]!)) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'managed version base file is unavailable, unsafe, or too large')
    }
    entries.set(match[4]!, { hash: match[2]!, bytes: Number(match[3]) })
  }
  if (entries.size !== paths.length) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'managed version base files must be tracked regular blobs')
  const read = async (path: string): Promise<Buffer> => {
    const entry = entries.get(path)!
    await check()
    const bytes = await runLocalBuffer('git', ['cat-file', 'blob', entry.hash], worktree, input.environment,
      { maximumOutput: MAX_FILE_BYTES, timeoutMs: 15_000, signal })
    if (bytes.length !== entry.bytes) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'managed version base blob changed while being read')
    return bytes
  }
  const manifest = parseManifest(await read(paths[0]!), 'managed version base manifest')
  const baseVersion = assertBaseManifest(manifest, name)
  const source = await read(paths[1]!)
  let versionSource: string
  try { versionSource = new TextDecoder('utf-8', { fatal: true }).decode(source) } catch { throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'managed version base runtime version is not strict UTF-8') }
  if (versionSource !== `export const version = '${baseVersion}'\n`) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'managed version base runtime version must be the canonical constant')
  }
  await check()
  return { baseManifest: manifest, baseVersion, versionSource }
}

/** Derive, but never write, the Host-reserved patch-version file contents. */
export async function managedPatchVersionFiles(input: ManagedPatchVersionInput): Promise<ManagedPatchVersionFiles> {
  const { baseManifest, baseVersion } = await readBaseFiles(input)
  const version = nextStablePatch(baseVersion)
  return Object.freeze({ baseVersion, version, files: Object.freeze([
    Object.freeze({ path: 'package.json', content: manifestWithVersion(baseManifest, version) }),
    Object.freeze({ path: 'src/version.ts', content: `export const version = '${version}'\n` }),
  ]) })
}

/** Re-read current files and prove that only the Host-reserved version fields changed. */
export async function verifyManagedPatchVersion(input: ManagedPatchVersionInput): Promise<{ baseVersion: string; version: string }> {
  const { baseManifest, baseVersion } = await readBaseFiles(input)
  const version = nextStablePatch(baseVersion)
  const signal = input.signal ?? new AbortController().signal
  const check = async (): Promise<void> => { signal.throwIfAborted(); await input.assertCurrent?.(); signal.throwIfAborted() }
  await check()
  const worktree = await realpath(input.worktree)
  await check()
  const manifest = parseManifest(await readCurrentRegularFile(worktree, `plugins/${input.name}/package.json`), 'managed version current manifest')
  await check()
  const source = await readCurrentRegularFile(worktree, `plugins/${input.name}/src/version.ts`)
  let versionSource: string
  try { versionSource = new TextDecoder('utf-8', { fatal: true }).decode(source) } catch { throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'managed version current runtime version is not strict UTF-8') }
  if (!equalExceptVersion(baseManifest, manifest, version) || versionSource !== `export const version = '${version}'\n`) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'managed version current files differ from the base except for the reserved patch version')
  }
  await check()
  return Object.freeze({ baseVersion, version })
}

/** Candidate source files may never replace Host-reserved version fields. */
export function assertManagedVersionPaths(files: readonly ScopedPluginFile[]): void {
  if (!Array.isArray(files)) throw new ControlPlaneCliError('INVALID_ARGUMENT', 'managed version files must be an array')
  for (const file of files) {
    if (file === null || typeof file !== 'object' || typeof file.path !== 'string' || file.path !== file.path.normalize('NFC')) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'managed version file path is not canonical')
    }
  }
  validateScopedPluginFiles(files)
  if (files.some(file => file.path === 'package.json' || file.path === 'src/version.ts')) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'candidate source files cannot replace Host-managed version fields')
  }
}
