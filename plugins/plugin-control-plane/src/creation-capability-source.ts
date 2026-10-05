import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { canonicalGrowthJson, type PluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import { ControlPlaneCliError } from './errors.js'
import { runLocalBuffer, runLocalCommand } from './source-workspace.js'

const PROTOCOL = 'dsh-created-capability-source/v1' as const
const DOMAIN = 'dsh-created-capability-source-v1\0'
const COMMIT = /^[a-f0-9]{40}$/u
const DIGEST = /^[a-f0-9]{64}$/u
const NAME = /^(?=.{1,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const MAX_FILES = 64
const MAX_FILE_BYTES = 65_536
const MAX_TOTAL_BYTES = 262_144
const MAX_INDEX_BYTES = 131_072
const MAX_PATCH_BYTES = 8_388_608
const MAX_JSON_BYTES = 2_097_152
const MAX_DIRECTORY_NODES = 256
const MAX_DIRECTORY_DEPTH = 32
const MAX_PATH_BYTES = 1_024

export interface CreationCapabilitySourceEntry {
  path: string
  mode: '100644' | '100755'
  oid: string
}

export interface CreationCapabilitySourceFile extends CreationCapabilitySourceEntry {
  bytes: number
  sha256: string
  content: string
}

/** Private exact staged-source data. Catalog and lock are bound by OID only. */
export interface CreationCapabilitySourceSnapshot {
  protocol: typeof PROTOCOL
  baseCommit: string
  scope: readonly string[]
  treeDigest: string
  patchDigest: string
  entries: readonly CreationCapabilitySourceEntry[]
  files: readonly CreationCapabilitySourceFile[]
  digest: string
}

function invalid(reason: string): never {
  throw new ControlPlaneCliError('SOURCE_BOUNDARY', `created capability source ${reason}`)
}

function sha256(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex') }

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) invalid(label)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const actual = Object.keys(descriptors).sort()
  if (actual.length !== keys.length || actual.some((key, index) => key !== [...keys].sort()[index])
    || actual.some(key => !descriptors[key]!.enumerable || !('value' in descriptors[key]!))) invalid(label)
  return value as Record<string, unknown>
}

function exactArray(value: unknown, max: number, label: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max
    || Object.getOwnPropertySymbols(value).length !== 0
    || Object.getOwnPropertyNames(value).length !== value.length + 1
    || !Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean)
    || Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key, descriptor]) => key !== 'length'
      && (!/^(0|[1-9][0-9]*)$/u.test(key) || !descriptor.enumerable || !('value' in descriptor)))) invalid(label)
  return value
}

function certificatePlan(certificate: PluginCreationVerificationCertificate): PluginCreationVerificationCertificate['plan'] {
  if (certificate === null || typeof certificate !== 'object' || Object.getPrototypeOf(certificate) !== Object.prototype) invalid('certificate')
  const descriptor = Object.getOwnPropertyDescriptor(certificate, 'plan')
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid('certificate plan')
  return exactRecord(descriptor.value, ['id', 'digest', 'name', 'sourceTreeDigest', 'sourcePatchDigest',
    'artifactSha256', 'artifactBytes', 'generatorDigest'], 'certificate plan') as unknown as PluginCreationVerificationCertificate['plan']
}

function checkedScope(name: string, scope: readonly string[]): readonly string[] {
  if (!NAME.test(name) || name.normalize('NFC') !== name) invalid('plugin name')
  const expected = [`plugins/${name}`, 'plugins/README.md', 'pnpm-lock.yaml'].sort()
  const actual = exactArray(scope, 3, 'scope')
  if (actual.length !== 3 || actual.some((value, index) => value !== expected[index])) invalid('scope')
  return expected
}

function safePluginPath(path: string, root: string): boolean {
  if (path.length > MAX_PATH_BYTES || !path.startsWith(`${root}/`)
    || path !== path.normalize('NFC') || Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES) return false
  const relative = path.slice(root.length + 1)
  const segments = relative.split('/')
  return segments.every(segment => SEGMENT.test(segment) && !['.git', '.gitattributes', '.gitmodules', 'node_modules', 'lib'].includes(segment))
    && !relative.includes('\\')
}

function strictUtf8(bytes: Buffer, label: string, allowNul = false): string {
  if (!allowNul && bytes.includes(0)) invalid(`${label} contains NUL`)
  let decoded: string
  try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { invalid(`${label} is not UTF-8`) }
  if (!Buffer.from(decoded, 'utf8').equals(bytes)) invalid(`${label} is not canonical UTF-8`)
  return decoded
}

export function creationCapabilitySourceDigest(payload: Omit<CreationCapabilitySourceSnapshot, 'digest'>): string {
  // Bound strings and aggregate worst-case JSON escaping before allocating encoded JSON.
  let nodes = 0, maximumEncodedBytes = 0
  const seen = new Set<object>()
  const bound = (value: unknown, depth: number): void => {
    if (++nodes > 8192 || depth > 16) invalid('JSON complexity')
    if (typeof value === 'string') {
      if (value.length > MAX_FILE_BYTES) invalid('JSON string exceeds bound')
      maximumEncodedBytes += 6 * Buffer.byteLength(value) + 2
    } else if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      maximumEncodedBytes += 24
    } else {
      if (!value || typeof value !== 'object' || seen.has(value)) invalid('JSON value')
      seen.add(value)
      if (Array.isArray(value)) {
        for (const item of exactArray(value, MAX_FILES + 2, 'JSON array')) bound(item, depth + 1)
        maximumEncodedBytes += value.length + 2
      } else {
        if (Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length > 16) invalid('JSON object')
        const descriptors = Object.getOwnPropertyDescriptors(value)
        for (const key of Reflect.ownKeys(value)) {
          if (typeof key !== 'string' || key.length > 256) invalid('JSON key')
          const descriptor = descriptors[key]!
          if (!descriptor.enumerable || !('value' in descriptor)) invalid('JSON descriptor')
          bound(key, depth + 1); bound(descriptor.value, depth + 1)
          maximumEncodedBytes += 2
        }
        maximumEncodedBytes += 2
      }
      seen.delete(value)
    }
    if (maximumEncodedBytes > MAX_JSON_BYTES) invalid('JSON exceeds bound')
  }
  bound(payload, 0)
  const encoded = canonicalGrowthJson(payload)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_JSON_BYTES) invalid('JSON exceeds bound')
  return sha256(`${DOMAIN}${encoded}`)
}

function indexText(entries: readonly CreationCapabilitySourceEntry[]): string {
  return entries.map(entry => `${entry.mode} ${entry.oid} 0\t${entry.path}\0`).join('')
}

function treeDigest(baseCommit: string, scope: readonly string[], text: string): string {
  return sha256(`dsh-source-tree-v2\0${baseCommit}\0${JSON.stringify(scope)}\0${text}`)
}

function patchDigest(baseCommit: string, scope: readonly string[], patch: Buffer): string {
  return createHash('sha256').update(`dsh-source-patch-v2\0${baseCommit}\0${JSON.stringify(scope)}\0`).update(patch).digest('hex')
}

function inspectEntry(value: unknown, root: string, plugin: boolean): CreationCapabilitySourceEntry {
  const entry = exactRecord(value, plugin ? ['path', 'mode', 'oid', 'bytes', 'sha256', 'content'] : ['path', 'mode', 'oid'], 'entry')
  if (typeof entry.path !== 'string' || typeof entry.mode !== 'string' || typeof entry.oid !== 'string'
    || !COMMIT.test(entry.oid) || !['100644', '100755'].includes(entry.mode)
    || !(safePluginPath(entry.path, root) || entry.path === 'plugins/README.md' || entry.path === 'pnpm-lock.yaml')) invalid('entry metadata')
  return entry as unknown as CreationCapabilitySourceEntry
}

/** Offline structural and byte verification; signature, owner and current authority belong to the journal. */
export function validateCreationCapabilitySource(snapshot: unknown,
  certificate: PluginCreationVerificationCertificate): asserts snapshot is CreationCapabilitySourceSnapshot {
  const plan = certificatePlan(certificate)
  const value = exactRecord(snapshot, ['protocol', 'baseCommit', 'scope', 'treeDigest', 'patchDigest', 'entries', 'files', 'digest'], 'snapshot')
  if (value.protocol !== PROTOCOL || typeof value.baseCommit !== 'string' || !COMMIT.test(value.baseCommit)
    || typeof value.treeDigest !== 'string' || !DIGEST.test(value.treeDigest)
    || typeof value.patchDigest !== 'string' || !DIGEST.test(value.patchDigest)
    || typeof value.digest !== 'string' || !DIGEST.test(value.digest)) invalid('header')
  const name = plan.name
  const scope = checkedScope(name, value.scope as readonly string[])
  const root = `plugins/${name}`
  const entries = exactArray(value.entries, MAX_FILES + 2, 'entries')
  const files = exactArray(value.files, MAX_FILES, 'files')
  if (entries.length < 3 || files.length < 1) invalid('empty source')
  const seen = new Set<string>()
  const expectedFiles: CreationCapabilitySourceEntry[] = []
  let previous = Buffer.alloc(0)
  for (const unknownEntry of entries) {
    const entry = inspectEntry(unknownEntry, root, false)
    const order = Buffer.from(entry.path, 'utf8')
    if (seen.has(entry.path) || previous.length && Buffer.compare(previous, order) >= 0) invalid('index order or duplicate')
    previous = order; seen.add(entry.path)
    if (entry.path.startsWith(`${root}/`)) expectedFiles.push(entry)
  }
  if (!seen.has('plugins/README.md') || !seen.has('pnpm-lock.yaml') || expectedFiles.length !== files.length) invalid('index scope')
  const text = indexText(entries as CreationCapabilitySourceEntry[])
  if (Buffer.byteLength(text, 'utf8') > MAX_INDEX_BYTES || treeDigest(value.baseCommit, scope, text) !== value.treeDigest) invalid('tree digest')
  let total = 0
  for (let index = 0; index < files.length; index++) {
    const file = exactRecord(files[index], ['path', 'mode', 'oid', 'bytes', 'sha256', 'content'], 'file')
    const expected = expectedFiles[index]!
    if (file.path !== expected.path || file.mode !== expected.mode || file.oid !== expected.oid
      || typeof file.content !== 'string' || file.content.length > MAX_FILE_BYTES
      || typeof file.sha256 !== 'string' || !DIGEST.test(file.sha256)
      || typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_FILE_BYTES) invalid('file metadata')
    const bytes = Buffer.from(file.content, 'utf8')
    if (bytes.length !== file.bytes || bytes.includes(0) || strictUtf8(bytes, String(file.path)) !== file.content
      || sha256(bytes) !== file.sha256
      || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== file.oid) invalid('file bytes')
    total += bytes.length
    if (total > MAX_TOTAL_BYTES) invalid('total bytes')
  }
  if (value.treeDigest !== plan.sourceTreeDigest || value.patchDigest !== plan.sourcePatchDigest) invalid('certificate digest')
  const payload = { protocol: PROTOCOL, baseCommit: value.baseCommit, scope: value.scope,
    treeDigest: value.treeDigest, patchDigest: value.patchDigest, entries: value.entries, files: value.files }
  if (creationCapabilitySourceDigest(payload as Omit<CreationCapabilitySourceSnapshot, 'digest'>) !== value.digest) invalid('source digest')
}

async function listedPluginPaths(worktree: string, root: string, signal?: AbortSignal): Promise<readonly string[]> {
  const target = resolve(worktree, root)
  const metadata = await lstat(target)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(target) !== target) invalid('plugin root')
  const paths: string[] = []
  let nodes = 0
  const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
    signal?.throwIfAborted()
    if (depth > MAX_DIRECTORY_DEPTH) invalid('directory depth')
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      signal?.throwIfAborted()
      if (++nodes > MAX_DIRECTORY_NODES) invalid('directory entries')
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const path = `${root}/${relative}`
      if (!safePluginPath(path, root)) invalid('plugin path')
      if (entry.isDirectory()) {
        const parent = join(directory, entry.name)
        const stat = await lstat(parent)
        if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(parent) !== parent) invalid('plugin directory')
        await visit(parent, relative, depth + 1)
      }
      else if (entry.isFile()) {
        const stat = await lstat(join(directory, entry.name))
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) invalid('non-regular or oversized file')
        paths.push(path)
      } else invalid('non-regular plugin entry')
      if (paths.length > MAX_FILES) invalid('file count')
    }
  }
  await visit(target, '', 0)
  return paths.sort()
}

/** Capture exactly the same temporary-index digest domain as checkedSourceSnapshot. */
export async function captureCreationCapabilitySource(input: {
  worktree: string; baseCommit: string; scope: readonly string[]
  certificate: PluginCreationVerificationCertificate; environment: NodeJS.ProcessEnv; signal?: AbortSignal
}): Promise<CreationCapabilitySourceSnapshot> {
  const plan = certificatePlan(input.certificate)
  const scope = checkedScope(plan.name, input.scope)
  if (!COMMIT.test(input.baseCommit)) invalid('base commit')
  const root = `plugins/${plan.name}`
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-created-source-index-'))
  try {
    const environment = { ...input.environment, GIT_INDEX_FILE: join(temporary, 'index') }
    const run = (args: readonly string[], maximumOutput: number) => runLocalBuffer('git', args, input.worktree, environment,
      { maximumOutput, ...(input.signal ? { signal: input.signal } : {}) })
    const head = (await run(['rev-parse', '--verify', 'HEAD^{commit}'], 128)).toString('utf8').trim()
    if (head !== input.baseCommit) invalid('worktree HEAD drift')
    const stage = async () => {
      await runLocalCommand('git', ['read-tree', input.baseCommit], input.worktree, environment,
        input.signal ? { signal: input.signal } : {})
      await runLocalCommand('git', ['--literal-pathspecs', 'add', '--all', '--', ...scope], input.worktree, environment,
        input.signal ? { signal: input.signal } : {})
      const index = await run(['--literal-pathspecs', '-c', 'core.quotepath=false', 'ls-files', '--stage', '-z', '--', ...scope], MAX_INDEX_BYTES)
      const patch = await run(['--literal-pathspecs', '-c', 'core.quotepath=false', 'diff', '--cached', '--binary',
        '--full-index', '--no-color', input.baseCommit, '--', ...scope], MAX_PATCH_BYTES)
      return { index, patch }
    }
    const first = await stage()
    const raw = strictUtf8(first.index, 'index', true)
    const rows = raw.split('\0')
    if (rows.pop() !== '' || rows.length < 3 || rows.length > MAX_FILES + 2) invalid('index size')
    const entries: CreationCapabilitySourceEntry[] = rows.map(row => {
      const match = /^(100644|100755) ([a-f0-9]{40}) 0\t(.+)$/u.exec(row)
      if (!match) invalid('index record')
      return { path: match[3]!, mode: match[1]! as CreationCapabilitySourceEntry['mode'], oid: match[2]! }
    })
    if (indexText(entries) !== raw) invalid('index roundtrip')
    const paths = await listedPluginPaths(input.worktree, root, input.signal)
    const indexPluginPaths = entries.filter(entry => entry.path.startsWith(`${root}/`)).map(entry => entry.path).sort()
    if (paths.length !== indexPluginPaths.length || paths.some((path, index) => path !== indexPluginPaths[index])) invalid('plugin file set')
    const files: CreationCapabilitySourceFile[] = []
    let total = 0
    for (const entry of entries) {
      if (!entry.path.startsWith(`${root}/`)) continue
      const bytes = await run(['cat-file', 'blob', entry.oid], MAX_FILE_BYTES)
      if (bytes.length > MAX_FILE_BYTES) invalid('file bytes')
      total += bytes.length
      if (total > MAX_TOTAL_BYTES) invalid('total bytes')
      const content = strictUtf8(bytes, entry.path)
      files.push({ ...entry, bytes: bytes.length, sha256: sha256(bytes), content })
    }
    const second = await stage()
    if (!second.index.equals(first.index) || !second.patch.equals(first.patch)
      || (await run(['rev-parse', '--verify', 'HEAD^{commit}'], 128)).toString('utf8').trim() !== input.baseCommit) invalid('worktree drift')
    const payload = { protocol: PROTOCOL, baseCommit: input.baseCommit, scope, treeDigest: treeDigest(input.baseCommit, scope, raw),
      patchDigest: patchDigest(input.baseCommit, scope, first.patch), entries, files }
    const snapshot = { ...payload, digest: creationCapabilitySourceDigest(payload) }
    validateCreationCapabilitySource(snapshot, input.certificate)
    for (const entry of entries) Object.freeze(entry)
    for (const file of files) Object.freeze(file)
    return Object.freeze({ ...snapshot, scope: Object.freeze(scope), entries: Object.freeze(entries), files: Object.freeze(files) })
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
