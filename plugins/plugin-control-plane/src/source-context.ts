import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ControlPlaneCliError } from './errors.js'
import { assertPluginModificationAllowed, PROTECTED_PLUGIN_DENYLIST, runLocalBuffer, runLocalCommand } from './source-workspace.js'

const NAME = /^(?=.{1,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const TEXT = /(?:\.(?:ts|tsx|jsx|js|mjs|cjs|json|ya?ml|md|txt|css|html|sh)|^LICENSE)$/u
const OMIT = /(?:^|\/)(?:node_modules|lib|dist|coverage)(?:\/|$)|(?:^|\/)\./u
const MAX_FILES = 1024; const MAX_READ_FILES = 64; const MAX_FILE_BYTES = 65_536; const MAX_TOTAL_BYTES = 262_144
const MAX_TARGETS = 128; const MAX_TARGET_MANIFEST_BYTES = 16_384; const MAX_TARGET_MANIFEST_TOTAL_BYTES = 524_288
const MAX_TARGET_DESCRIPTION_BYTES = 512; const MAX_TARGET_TREE_BYTES = 1_048_576

export interface SourceInspection { name: string; baseCommit: string; files: readonly { path: string; bytes: number }[]; contents: readonly { path: string; content: string }[] }
export interface SourceTargetsInspection { baseCommit: string; plugins: readonly { name: string; description?: string }[] }

/** Bound caller-supplied async fences; cancellation suppresses every late result. */
export function awaitSourceSignal<T>(signal: AbortSignal, operation: () => T | Promise<T>): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolvePromise, reject) => {
    const cancel = (): void => { reject(signal.reason) }
    signal.addEventListener('abort', cancel, { once: true })
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation() }).then(
      value => { signal.removeEventListener('abort', cancel); if (signal.aborted) reject(signal.reason); else resolvePromise(value) },
      error => { signal.removeEventListener('abort', cancel); reject(error) },
    )
  })
}

function assertPath(path: string): void {
  if (path === '' || path.length > 512 || [...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || path.includes('\\') || path.startsWith('/') || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source context path escapes the plugin tree')
  }
}

function parseTree(value: string, root: string): Map<string, { mode: string; type: string; hash: string; bytes: number }> {
  const entries = new Map<string, { mode: string; type: string; hash: string; bytes: number }>()
  for (const record of value.split('\0').filter(Boolean)) {
    const match = /^(\d+) ([a-z]+) ([a-f0-9]{40}) +([0-9]+|-)\t(.+)$/u.exec(record)
    if (!match || !match[5]!.startsWith(`${root}/`)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'Git tree entry is invalid')
    const path = match[5]!.slice(root.length + 1); assertPath(path)
    if (!OMIT.test(path)) entries.set(path, { mode: match[1]!, type: match[2]!, hash: match[3]!, bytes: match[4] === '-' ? 0 : Number(match[4]) })
  }
  return entries
}

async function resolveSourceCommit(input: {
  repository: string; baseCommit?: string; baselineCommit?: string; environment: NodeJS.ProcessEnv; signal: AbortSignal
}): Promise<{ repository: string; head: string }> {
  const repository = await realpath(resolve(input.repository))
  if (repository !== resolve(input.repository)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'repository path must be canonical')
  const top = (await runLocalCommand('git', ['rev-parse', '--show-toplevel'], repository, input.environment, { capture: true, timeoutMs: 15_000, signal: input.signal })).trim()
  if (top !== repository) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'repository must be the canonical Git top-level')
  if (input.baselineCommit !== undefined && !/^[a-f0-9]{40}$/u.test(input.baselineCommit)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'managed source baseline is invalid')
  const head = (await runLocalCommand('git', ['rev-parse', '--verify', `${input.baselineCommit ?? 'HEAD'}^{commit}`], repository, input.environment, { capture: true, timeoutMs: 15_000, signal: input.signal })).trim()
  if (input.baselineCommit !== undefined && head !== input.baselineCommit) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'managed source baseline changed')
  if (!/^[a-f0-9]{40}$/u.test(head) || (input.baseCommit !== undefined && input.baseCommit !== head)) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source context base commit is stale or invalid')
  }
  return { repository, head }
}

/** List only committed, regular plugin manifests at the Host-resolved source baseline. */
export async function inspectSourceTargetsContext(input: {
  repository: string; baseCommit?: string; baselineCommit?: string; environment: NodeJS.ProcessEnv
  signal: AbortSignal; assertCurrent: () => Promise<void>
}): Promise<SourceTargetsInspection> {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(15_000)])
  const check = async (): Promise<void> => { signal.throwIfAborted(); await awaitSourceSignal(signal, input.assertCurrent); signal.throwIfAborted() }
  await check()
  const { repository, head } = await resolveSourceCommit({ ...input, signal })
  await check()
  const listed = await runLocalCommand('git', ['--literal-pathspecs', 'ls-tree', '-r', '-l', '-z', head, '--', 'plugins'], repository, input.environment,
    { capture: true, maximumOutput: MAX_TARGET_TREE_BYTES, timeoutMs: 15_000, signal })
  const manifests = new Map<string, { hash: string; bytes: number }>()
  for (const record of listed.split('\0').filter(Boolean)) {
    const match = /^(\d+) ([a-z]+) ([a-f0-9]{40}) +([0-9]+|-)\t([\s\S]+)$/u.exec(record)
    if (!match || !match[5]!.startsWith('plugins/')) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'plugin target Git tree entry is invalid')
    const parts = match[5]!.split('/')
    if (parts.length !== 3 || parts[2] !== 'package.json' || !NAME.test(parts[1]!) || PROTECTED_PLUGIN_DENYLIST.has(parts[1]!)) continue
    if (match[1] !== '100644' && match[1] !== '100755') continue
    if (match[2] !== 'blob') continue
    const name = parts[1]!
    if (manifests.has(name)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'duplicate plugin target manifest')
    const bytes = Number(match[4])
    if (!Number.isSafeInteger(bytes) || bytes > MAX_TARGET_MANIFEST_BYTES) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'plugin target manifest exceeds its bound')
    manifests.set(name, { hash: match[3]!, bytes })
    if (manifests.size > MAX_TARGETS) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'plugin target count exceeds its bound')
  }
  let total = 0
  const plugins: { name: string; description?: string }[] = []
  for (const [name, manifest] of [...manifests].sort(([a], [b]) => a.localeCompare(b))) {
    if ((total += manifest.bytes) > MAX_TARGET_MANIFEST_TOTAL_BYTES) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'plugin target manifests exceed their aggregate bound')
    await check()
    const raw = await runLocalBuffer('git', ['cat-file', 'blob', manifest.hash], repository, input.environment,
      { maximumOutput: MAX_TARGET_MANIFEST_BYTES, timeoutMs: 15_000, signal })
    if (raw.length !== manifest.bytes || raw.includes(0)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'plugin target manifest bytes are invalid')
    let parsed: unknown
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) }
    catch { throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'plugin target manifest is not strict JSON and UTF-8') }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
      || (parsed as Record<string, unknown>).name !== `@dsh-enhanced/${name}`) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'plugin target manifest identity is invalid')
    }
    const description = (parsed as Record<string, unknown>).description
    if (description !== undefined && (typeof description !== 'string'
      || Buffer.byteLength(description, 'utf8') > MAX_TARGET_DESCRIPTION_BYTES
      || [...description].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'plugin target description is invalid or exceeds its bound')
    }
    plugins.push(Object.freeze(description === undefined ? { name } : { name, description: description as string }))
  }
  await check()
  return Object.freeze({ baseCommit: head, plugins: Object.freeze(plugins) })
}

export async function inspectSourceContext(input: {
  repository: string; name: string; paths: readonly string[]; baseCommit?: string; environment: NodeJS.ProcessEnv
  /** Resolved from owner-configured, signed release history by the Host. */
  baselineCommit?: string
  signal: AbortSignal; assertCurrent: () => Promise<void>
}): Promise<SourceInspection> {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(15_000)])
  const check = async (): Promise<void> => { signal.throwIfAborted(); await awaitSourceSignal(signal, input.assertCurrent); signal.throwIfAborted() }
  await check()
  const name = input.name.normalize('NFC').trim()
  if (!NAME.test(name)) throw new ControlPlaneCliError('INVALID_ARGUMENT', 'plugin name is invalid')
  assertPluginModificationAllowed(name)
  if (input.paths.length > MAX_READ_FILES || input.paths.length !== new Set(input.paths).size) throw new ControlPlaneCliError('INVALID_ARGUMENT', 'too many or duplicate source context paths')
  for (const path of input.paths) assertPath(path)
  const { repository, head } = await resolveSourceCommit({ ...input, signal })
  await check()
  const root = `plugins/${name}`
  const listed = await runLocalCommand('git', ['--literal-pathspecs', 'ls-tree', '-r', '-l', '-z', head, '--', root], repository, input.environment,
    { capture: true, maximumOutput: 1_048_576, timeoutMs: 15_000, signal })
  const tree = parseTree(listed, root)
  if (tree.size === 0 || tree.size > MAX_FILES) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'plugin source manifest is unavailable or exceeds its bound')
  const files = [...tree.entries()].filter(([path, entry]) => entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755') && TEXT.test(path))
    .map(([path, entry]) => ({ path, bytes: entry.bytes, hash: entry.hash })).sort((a, b) => a.path.localeCompare(b.path))
  const requested = input.paths.length === 0 ? [] : input.paths
  let total = 0; const contents: { path: string; content: string }[] = []
  for (const path of requested) {
    const entry = tree.get(path)
    if (!entry || entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755') || !TEXT.test(path)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', `requested source path is unavailable: ${JSON.stringify(path)}`)
    if (entry.bytes > MAX_FILE_BYTES || total + entry.bytes > MAX_TOTAL_BYTES) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'requested source content exceeds its bound')
    await check()
    const raw = await runLocalBuffer('git', ['cat-file', 'blob', entry.hash], repository, input.environment,
      { maximumOutput: MAX_FILE_BYTES, timeoutMs: 15_000, signal })
    let content: string
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(raw) }
    catch { throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'requested source content is not strict UTF-8') }
    const bytes = raw.length
    if (bytes > MAX_FILE_BYTES || raw.includes(0) || (total += bytes) > MAX_TOTAL_BYTES) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'requested source content is binary or exceeds its bound')
    }
    contents.push(Object.freeze({ path, content }))
  }
  await check()
  return Object.freeze({ name, baseCommit: head, files: Object.freeze(files.map(({ path, bytes }) => Object.freeze({ path, bytes }))), contents: Object.freeze(contents) })
}
