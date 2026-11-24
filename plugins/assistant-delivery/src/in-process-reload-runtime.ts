import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync,
  writeFileSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

/**
 * Host-side adapter for the control plane's in-process reload protocol.
 *
 * Supports two verified operating modes inside a running Host process:
 *
 * 1. **Config-only in-place reload** (default when `target.artifact` is omitted
 *    and `mode !== 'artifact-replace'`): updates profile config and restarts
 *    the existing fiber in place (`fibersDisposed: 0`, preserved `uid`, rebuilt
 *    `committed` store, unchanged `moduleNamespace`, unchanged Host generation).
 * 2. **Immutable digest-verified artifact replacement** (`mode: 'artifact-replace'`
 *    or `target.artifact` supplied): stages the candidate artifact under an
 *    immutable `<version>-<artifactDigest>` directory (avoiding ESM cache
 *    collisions across reload rounds), verifies SHA-256 `artifactDigest` and
 *    `patchDigest` before `tree.refresh()`, cleanly disposes the prior fiber
 *    (`state === DISPOSED`, `fibersDisposed >= 1`, clean disposers), mounts the
 *    new entry with rebuilt `committed` store and updated `moduleNamespace`,
 *    keeps non-target sibling plugins undisturbed, and automatically rolls back
 *    to the exact prior immutable artifact and profile patch if disposers,
 *    missing injections, startup, or post-reload probe assertions fail.
 */

// Cordis 4.1.0 exports `FiberState` as an ambient const enum that is unavailable
// at runtime, so the numeric values are used directly.
const PENDING = 0
const LOADING = 1
const ACTIVE = 2
const FAILED = 3
const DISPOSED = 4

const DIGEST = /^[a-f0-9]{64}$/u
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 120_000

/** Packages that must never be hot-reloaded in-process. */
export const IN_PROCESS_RELOAD_DENYLIST: readonly string[] = Object.freeze([
  '@dsh-enhanced/plugin-control-plane',
  '@dsh-enhanced/assistant-delivery',
])

const DENIED_PACKAGES = new Set(IN_PROCESS_RELOAD_DENYLIST)

export type InProcessReloadMode = 'config-only' | 'artifact-replace'

export interface InProcessReloadArtifactSpec {
  /** Directory containing the candidate plugin package (`package.json` + built entry/lib files). */
  sourceDir?: string
  /** Standalone `.js`/`.mjs`/`.cjs` entry module path when staging a single-file module. */
  entryPath?: string
  /** Optional relative entry specifier inside `sourceDir` (defaults to resolved `exports['.']` / `main` / `./lib/index.js`). */
  entrySpecifier?: string
  /** Optional entry config override written to the Cordis profile when loading this artifact. */
  config?: Record<string, unknown>
  /** Optional patch file path (`cordis.patch.yml` or YAML/JSON patch) whose SHA-256 must match `target.patchDigest`. */
  patchPath?: string
  /** Optional raw patch text whose SHA-256 must match `target.patchDigest`. */
  patchContent?: string
  /** Optional Cordis `inject` override object for the reloaded entry. */
  inject?: Record<string, unknown>
}

export interface StageInProcessArtifactResult {
  stagedDir: string
  entryFilePath: string
  artifactDigest: string
}

/** Structural mirror of the loader's `Fiber` surface used by the runtime & probe. */
interface RuntimeFiber {
  uid: number | null
  state: number
  committed?: object | null
  inertia?: Promise<unknown>
  dispose?: () => unknown
  await?: () => Promise<unknown>
  getEffects?: () => unknown[]
  ctx?: { fiber?: unknown }
}

interface RuntimeGroup {
  ctx?: { fiber?: unknown }
  tree: RuntimeTree
  data?: Array<Record<string, unknown>>
  remove?: (id: string, isDispose?: boolean) => void
  update?: (config: Array<Record<string, unknown>>) => Promise<void>
}

interface RuntimeEntry {
  options?: { id?: string; name?: string; config?: unknown; inject?: unknown }
  parent?: RuntimeGroup
  subtree?: RuntimeTree
  fiber?: RuntimeFiber
  ctx?: { fiber?: unknown }
  moduleNamespace?: unknown
  _initTask?: Promise<unknown>
}

interface RuntimeTree {
  ctx?: { baseUrl?: string; fiber?: { entry?: RuntimeEntry } }
  root?: RuntimeGroup
  filename?: string
  type?: 'application/yaml' | 'application/json'
  cache?: { content: string; data: unknown }
  persistenceError?: unknown
  store?: Record<string, RuntimeEntry | undefined>
  refresh?: () => Promise<void>
  await?: () => Promise<void>
  dump?: (data: unknown) => string
}

interface RuntimeLoader {
  root?: unknown
  resolve: (id: string) => unknown
}

export interface InProcessReloadRuntimeTarget {
  package: string
  version: string
  artifactDigest: string
  patchDigest: string
  changesProcessSubtree: boolean
  holdsUnprovenProcessAuthority: boolean
  entryId?: string
  artifact?: InProcessReloadArtifactSpec
}

export interface InProcessReloadRuntimeProbe {
  checks: number
  failures: number
  reloaded: boolean
  /** Fibers that reached DISPOSED. Config-only reload: 0; artifact replacement: >= 1. */
  fibersDisposed: number
  /** Local diagnostics for the failed assertion names; never part of the digest. */
  failedChecks: string[]
  probeDigest: string
  /** Set when an artifact reload failed and auto-rollback restored the prior serving fiber. */
  rolledBack?: boolean
  rollbackProbe?: InProcessReloadRuntimeProbe
}

export interface InProcessReloadRuntimeActivationInput {
  warrantDigest: string
  target: InProcessReloadRuntimeTarget
  previousHostGeneration: number
  previousInProcessGeneration: number
  mode?: InProcessReloadMode
}

export interface InProcessReloadRuntimeActivationResult {
  previousHostGeneration: number
  currentHostGeneration: number
  previousInProcessGeneration: number
  currentInProcessGeneration: number
  probe: InProcessReloadRuntimeProbe
}

export interface InProcessReloadRuntimeRollbackInput {
  warrantDigest: string
  target: InProcessReloadRuntimeTarget
  reloadedInProcessGeneration: number
}

export interface InProcessReloadRuntimeRollbackResult {
  hostGeneration: number
  inProcessGeneration: number
  restored: boolean
  profileRestored: boolean
  probe: InProcessReloadRuntimeProbe
}

export interface InProcessReloadRuntime {
  activate(input: InProcessReloadRuntimeActivationInput): Promise<InProcessReloadRuntimeActivationResult>
  rollback(input: InProcessReloadRuntimeRollbackInput): Promise<InProcessReloadRuntimeRollbackResult>
  snapshot(): { hostGeneration: number; inProcessGeneration: number }
}

export interface InProcessReloadRuntimeOptions {
  profilePath?: string
  entryId?: string
  package?: string
  stagingDir?: string
  hostGeneration: () => number
  isActive?: () => boolean
  apply?: () => Promise<void> | void
  restore?: () => Promise<void> | void
  timeoutMs?: number
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function digestOf(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }

function isInsideRoot(rootDir: string, candidatePath: string): boolean {
  const rel = relative(resolve(rootDir), resolve(candidatePath))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function sanitizeSlug(value: string): string {
  const cleaned = value.replace(/^@/u, '').replace(/[^a-zA-Z0-9._-]+/gu, '__').replace(/^\.+/u, '')
  if (!cleaned || cleaned === '.' || cleaned === '..') throw new Error(`in-process reload identifier is unsafe: ${value}`)
  return cleaned
}

function walkRegularFiles(rootDir: string): string[] {
  const rootStat = lstatSync(rootDir)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`in-process artifact source must be a non-symlink directory: ${rootDir}`)
  }
  const files: string[] = []
  const visit = (currentDir: string): void => {
    const entries = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name === 'node_modules') {
        throw new Error('in-process artifact must not bundle a node_modules dependency subtree')
      }
      const fullPath = join(currentDir, entry.name)
      const stat = lstatSync(fullPath)
      if (stat.isSymbolicLink()) {
        throw new Error(`in-process artifact must not contain symlinks: ${fullPath}`)
      }
      if (stat.isDirectory()) {
        visit(fullPath)
      } else if (stat.isFile()) {
        files.push(relative(rootDir, fullPath).split(sep).join('/'))
      } else {
        throw new Error(`in-process artifact contains non-regular file: ${fullPath}`)
      }
    }
  }
  visit(rootDir)
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return files
}

/**
 * Compute the canonical SHA-256 digest of a plugin directory or standalone entry file.
 * Rejects symlinks and nested `node_modules` dependency subtrees.
 */
export function computeInProcessArtifactDigest(source: { sourceDir?: string; entryPath?: string }): string {
  if (source.sourceDir !== undefined) {
    const files = walkRegularFiles(source.sourceDir)
    if (files.length === 0) throw new Error(`in-process artifact directory is empty: ${source.sourceDir}`)
    const hash = createHash('sha256').update('dsh-in-process-artifact-v1\0')
    for (const relPath of files) {
      const bytes = readFileSync(join(source.sourceDir, ...relPath.split('/')))
      hash.update(`${relPath}\0${bytes.length}\0`)
      hash.update(bytes)
      hash.update('\0')
    }
    return hash.digest('hex')
  }
  if (source.entryPath !== undefined) {
    const stat = lstatSync(source.entryPath)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`in-process artifact entry must be a regular non-symlink file: ${source.entryPath}`)
    }
    return createHash('sha256').update(readFileSync(source.entryPath)).digest('hex')
  }
  throw new Error('in-process artifact source requires sourceDir or entryPath')
}

/**
 * Compute the canonical SHA-256 digest for a profile patch text, buffer, or canonical patch object.
 */
export function computeInProcessPatchDigest(
  input: string | Buffer | { config?: Record<string, unknown> | undefined; inject?: Record<string, unknown> | undefined },
): string {
  if (typeof input === 'string') return createHash('sha256').update(Buffer.from(input, 'utf8')).digest('hex')
  if (Buffer.isBuffer(input)) return createHash('sha256').update(input).digest('hex')
  const normalized = canonical({ config: input.config ?? null, inject: input.inject ?? null })
  return createHash('sha256').update(Buffer.from(normalized, 'utf8')).digest('hex')
}

function pickManifestExport(manifest: Record<string, unknown>): string | undefined {
  const exportsField = manifest.exports
  if (typeof exportsField === 'string') return exportsField
  if (typeof exportsField === 'object' && exportsField !== null && !Array.isArray(exportsField)) {
    const rootExport = (exportsField as Record<string, unknown>)['.']
    if (typeof rootExport === 'string') return rootExport
    if (typeof rootExport === 'object' && rootExport !== null && !Array.isArray(rootExport)) {
      const record = rootExport as Record<string, unknown>
      for (const key of ['import', 'default', 'node']) {
        if (typeof record[key] === 'string') return record[key] as string
      }
    }
  }
  if (typeof manifest.module === 'string') return manifest.module
  if (typeof manifest.main === 'string') return manifest.main
  return undefined
}

function resolvePackageEntry(sourceDir: string, packageName: string, version: string, overrideSpecifier?: string): string {
  const pkgJsonPath = join(sourceDir, 'package.json')
  const pkgStat = lstatSync(pkgJsonPath, { throwIfNoEntry: false })
  if (!pkgStat || pkgStat.isSymbolicLink() || !pkgStat.isFile()) {
    throw new Error(`in-process artifact source is missing package.json: ${sourceDir}`)
  }
  const manifest = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as Record<string, unknown>
  if (manifest.name !== packageName) {
    throw new Error(`in-process artifact package name mismatch: expected ${packageName}, got ${String(manifest.name)}`)
  }
  if (manifest.version !== version) {
    throw new Error(`in-process artifact version mismatch: expected ${version}, got ${String(manifest.version)}`)
  }
  const entrySpec = overrideSpecifier ?? pickManifestExport(manifest) ?? './lib/index.js'
  const resolvedEntry = resolve(sourceDir, entrySpec)
  if (!isInsideRoot(sourceDir, resolvedEntry)) {
    throw new Error(`in-process artifact entry escapes package directory: ${entrySpec}`)
  }
  const entryStat = lstatSync(resolvedEntry, { throwIfNoEntry: false })
  if (!entryStat || entryStat.isSymbolicLink() || !entryStat.isFile()) {
    throw new Error(`in-process artifact entry does not exist as a regular file: ${entrySpec}`)
  }
  return resolvedEntry
}

function copyRegularTree(sourceDir: string, destDir: string, relFiles: readonly string[]): void {
  mkdirSync(destDir, { recursive: true })
  for (const relPath of relFiles) {
    const src = join(sourceDir, ...relPath.split('/'))
    const dst = join(destDir, ...relPath.split('/'))
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
    chmodSync(dst, lstatSync(src).mode & 0o777)
  }
}

/**
 * Verify SHA-256 `target.artifactDigest` and stage an immutable versioned/digest-addressed
 * copy under `stagingDir/<pkgSlug>/<version>-<artifactDigest>/` so repeated reloads and
 * rollbacks never collide in Node's ESM module cache or mutate an active directory.
 */
export function stageInProcessArtifact(options: {
  target: Pick<InProcessReloadRuntimeTarget, 'package' | 'version' | 'artifactDigest' | 'changesProcessSubtree' | 'holdsUnprovenProcessAuthority'>
  artifact: InProcessReloadArtifactSpec
  stagingDir: string
}): StageInProcessArtifactResult {
  const { target, artifact, stagingDir } = options
  if (DENIED_PACKAGES.has(target.package)) {
    throw new Error(`in-process reload target ${target.package} is denied and requires a process restart`)
  }
  if (target.holdsUnprovenProcessAuthority) {
    throw new Error(`in-process reload target ${target.package} requires a process restart`)
  }
  if (!DIGEST.test(target.artifactDigest)) {
    throw new Error('in-process reload target artifactDigest is invalid')
  }
  const computedDigest = computeInProcessArtifactDigest(artifact)
  if (computedDigest !== target.artifactDigest) {
    throw new Error(`in-process artifact digest mismatch: expected ${target.artifactDigest}, got ${computedDigest}`)
  }
  const destDir = resolve(stagingDir, sanitizeSlug(target.package), `${sanitizeSlug(target.version)}-${target.artifactDigest}`)
  if (!isInsideRoot(stagingDir, destDir)) {
    throw new Error('in-process artifact staging path escaped stagingDir')
  }
  mkdirSync(dirname(destDir), { recursive: true })

  if (artifact.sourceDir !== undefined) {
    resolvePackageEntry(artifact.sourceDir, target.package, target.version, artifact.entrySpecifier)
    if (existsSync(destDir)) {
      const existingDigest = computeInProcessArtifactDigest({ sourceDir: destDir })
      if (existingDigest !== target.artifactDigest) {
        throw new Error(`staged immutable artifact digest mismatch at ${destDir}`)
      }
    } else {
      const tmpDir = `${destDir}.tmp-${process.pid}-${randomUUID()}`
      const relFiles = walkRegularFiles(artifact.sourceDir)
      try {
        copyRegularTree(artifact.sourceDir, tmpDir, relFiles)
        if (computeInProcessArtifactDigest({ sourceDir: tmpDir }) !== target.artifactDigest) {
          throw new Error('staged artifact digest verification failed')
        }
        try {
          renameSync(tmpDir, destDir)
        } catch (error) {
          rmSync(tmpDir, { recursive: true, force: true })
          if (!existsSync(destDir) || computeInProcessArtifactDigest({ sourceDir: destDir }) !== target.artifactDigest) {
            throw error
          }
        }
      } catch (error) {
        rmSync(tmpDir, { recursive: true, force: true })
        throw error
      }
    }
    const entryFilePath = resolvePackageEntry(destDir, target.package, target.version, artifact.entrySpecifier)
    return { stagedDir: destDir, entryFilePath, artifactDigest: target.artifactDigest }
  }

  if (artifact.entryPath !== undefined) {
    const fileName = sanitizeSlug(basename(artifact.entryPath))
    const stagedEntryPath = join(destDir, fileName)
    if (existsSync(destDir)) {
      const existingDigest = computeInProcessArtifactDigest({ entryPath: stagedEntryPath })
      if (existingDigest !== target.artifactDigest) {
        throw new Error(`staged immutable entry digest mismatch at ${stagedEntryPath}`)
      }
    } else {
      const tmpDir = `${destDir}.tmp-${process.pid}-${randomUUID()}`
      const tmpEntry = join(tmpDir, fileName)
      try {
        mkdirSync(tmpDir, { recursive: true })
        copyFileSync(artifact.entryPath, tmpEntry)
        chmodSync(tmpEntry, lstatSync(artifact.entryPath).mode & 0o777)
        if (computeInProcessArtifactDigest({ entryPath: tmpEntry }) !== target.artifactDigest) {
          throw new Error('staged entry digest verification failed')
        }
        try {
          renameSync(tmpDir, destDir)
        } catch (error) {
          rmSync(tmpDir, { recursive: true, force: true })
          if (!existsSync(stagedEntryPath) || computeInProcessArtifactDigest({ entryPath: stagedEntryPath }) !== target.artifactDigest) {
            throw error
          }
        }
      } catch (error) {
        rmSync(tmpDir, { recursive: true, force: true })
        throw error
      }
    }
    return { stagedDir: destDir, entryFilePath: stagedEntryPath, artifactDigest: target.artifactDigest }
  }

  throw new Error('in-process artifact source requires sourceDir or entryPath')
}

function fiberOf(entry: RuntimeEntry | undefined): RuntimeFiber | undefined {
  const fiber = entry?.fiber
  return fiber && typeof fiber === 'object' ? fiber : undefined
}

function normalizeEntryId(entryId: string): string {
  const local = entryId.startsWith('include:') ? entryId.slice('include:'.length) : entryId
  if (!local || local.includes(':')) throw new Error(`in-process reload entry id is invalid: ${entryId}`)
  return local
}

function resolveProfileFilePath(profilePath: string): string {
  return /\.(ya?ml|json)$/iu.test(profilePath) ? profilePath : join(profilePath, 'cordis.yml')
}

function toRelativeImportSpecifier(fromDir: string, targetFile: string): string {
  const rel = relative(fromDir, targetFile).split(sep).join('/')
  return rel.startsWith('./') || rel.startsWith('../') || rel === '.' || rel === '..' ? rel : `./${rel}`
}

function writeTextAtomic(filePath: string, content: string): void {
  const tmpPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(tmpPath, content, 'utf8')
    renameSync(tmpPath, filePath)
  } catch (error) {
    rmSync(tmpPath, { force: true })
    throw error
  }
}

function findPackageRootForEntry(entryFilePath: string): { packageRoot: string; packageName: string } | undefined {
  let current = dirname(resolve(entryFilePath))
  for (let depth = 0; depth < 4; depth += 1) {
    const pkgPath = join(current, 'package.json')
    const stat = lstatSync(pkgPath, { throwIfNoEntry: false })
    if (stat && !stat.isSymbolicLink() && stat.isFile()) {
      const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown; private?: unknown }
      if (typeof parsed.name === 'string' && parsed.name !== 'dsh-enhanced-monorepo') {
        return { packageRoot: current, packageName: parsed.name }
      }
      return undefined
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

function readRegularFile(filePath: string, label: string): Buffer {
  const stat = lstatSync(filePath, { throwIfNoEntry: false })
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`in-process ${label} must be an existing regular non-symlink file: ${filePath}`)
  }
  return readFileSync(filePath)
}

function cloneEntryList(tree: RuntimeTree): Array<Record<string, unknown>> {
  const raw = tree.cache?.data
  if (!Array.isArray(raw)) throw new Error('the Cordis include tree cache is unavailable')
  return raw.map(item => (typeof item === 'object' && item !== null ? { ...(item as Record<string, unknown>) } : {}))
}

function serializeTreeData(tree: RuntimeTree, data: Array<Record<string, unknown>>): string {
  if (typeof tree.dump === 'function') return tree.dump(data)
  if (tree.type === 'application/json') return JSON.stringify(data, null, 2)
  throw new Error('the Cordis include tree does not expose dump() for profile serialization')
}

interface NonTargetSnapshot {
  id: string
  entry: RuntimeEntry
  fiber: RuntimeFiber | undefined
  uid: number | null | undefined
  state: number | undefined
  committed: object | null | undefined
}

function captureNonTargetEntries(tree: RuntimeTree, targetLocalId: string): NonTargetSnapshot[] {
  const result: NonTargetSnapshot[] = []
  for (const [id, entry] of Object.entries(tree.store ?? {})) {
    if (id === targetLocalId || !entry) continue
    result.push({
      id,
      entry,
      fiber: entry.fiber,
      uid: entry.fiber?.uid,
      state: entry.fiber?.state,
      committed: entry.fiber?.committed ?? null,
    })
  }
  return result
}

function verifyNonTargetEntries(tree: RuntimeTree, snapshots: readonly NonTargetSnapshot[]): boolean {
  const store = tree.store ?? {}
  for (const snap of snapshots) {
    const current = store[snap.id]
    if (!current || current !== snap.entry) return false
    if (current.fiber !== snap.fiber || current.fiber?.uid !== snap.uid) return false
    if (snap.state !== undefined && current.fiber?.state !== snap.state) return false
    if (snap.committed !== undefined && (current.fiber?.committed ?? null) !== snap.committed) return false
  }
  return true
}

interface ArtifactRollbackBaseline {
  warrantDigest: string
  localEntryId: string
  targetPackage: string
  beforeProfileContent: string
  beforeModuleNamespace: unknown
  beforeSpec: string
  backedUpSource?: {
    kind: 'dir' | 'file'
    backupPath: string
    beforeDigest: string
    targetName: string
  }
  autoRolledBack?: {
    inProcessGeneration: number
    restoredProfileDigest: string
    nonTargetSnapshots: readonly NonTargetSnapshot[]
  }
}

export function createInProcessReloadRuntime(ctx: Context, options: InProcessReloadRuntimeOptions): InProcessReloadRuntime {
  if (options.package !== undefined && DENIED_PACKAGES.has(options.package)) {
    throw new Error(`in-process reload target ${options.package} is denied and requires a process restart`)
  }
  const defaultEntryId = options.entryId !== undefined ? normalizeEntryId(options.entryId) : undefined
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS))
  const pid = process.pid
  const invocationId = /^[a-f0-9]{32}$/u.test(process.env.INVOCATION_ID ?? '') ? process.env.INVOCATION_ID! : null
  let inProcessGeneration = 1
  let lastBaseline: ArtifactRollbackBaseline | undefined

  function assertRuntimeActive(): void {
    if (options.isActive && !options.isActive()) {
      throw new Error('assistant-delivery inProcessReload runtime is disposed')
    }
  }

  function resolveIncludeRootEntry(activeLoader?: RuntimeLoader): RuntimeEntry {
    const active = activeLoader ?? loader()
    let root: unknown
    try { root = active.resolve('include') } catch { throw new Error('the Cordis include root is not mounted') }
    if (!root || typeof root !== 'object') throw new Error('the Cordis include root is not mounted')
    const rootEntry = root as RuntimeEntry
    const tree = rootEntry.subtree
    if (rootEntry.options?.id !== 'include' || rootEntry.options.name !== 'cordis:include'
      || rootEntry.parent !== active.root || !tree || tree.ctx?.fiber?.entry !== rootEntry) {
      throw new Error('the Cordis include root is not the profile include tree')
    }
    return rootEntry
  }

  function resolveProfileContext(activeLoader?: RuntimeLoader): {
    profileFile: string
    profileUrl: string
    stagingDir: string
  } {
    if (options.profilePath !== undefined) {
      const profileFile = resolveProfileFilePath(options.profilePath)
      return {
        profileFile,
        profileUrl: pathToFileURL(profileFile).href,
        stagingDir: options.stagingDir ?? join(dirname(profileFile), '.dsh-in-process-artifacts'),
      }
    }
    const rootEntry = resolveIncludeRootEntry(activeLoader)
    const tree = rootEntry.subtree
    const config = rootEntry.options?.config
    const configuredPath = config && typeof config === 'object' && !Array.isArray(config)
      ? (config as Record<string, unknown>).path : undefined
    let rawProfilePath: string | undefined
    if (typeof tree?.filename === 'string' && tree.filename.length > 0) {
      rawProfilePath = tree.filename.startsWith('file://') ? fileURLToPath(tree.filename) : tree.filename
    } else if (typeof configuredPath === 'string' && configuredPath.length > 0) {
      if (configuredPath.startsWith('file://')) {
        rawProfilePath = fileURLToPath(configuredPath)
      } else {
        const base = tree?.ctx?.baseUrl
        rawProfilePath = base ? fileURLToPath(new URL(configuredPath, base)) : configuredPath
      }
    }
    if (!rawProfilePath) {
      throw new Error('the Cordis include root does not expose a profile file path')
    }
    const profileFile = resolveProfileFilePath(rawProfilePath)
    return {
      profileFile,
      profileUrl: pathToFileURL(profileFile).href,
      stagingDir: options.stagingDir ?? join(dirname(profileFile), '.dsh-in-process-artifacts'),
    }
  }

  function withDeadline<T>(work: () => Promise<T>, label = 'operation'): Promise<T> {
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error(`in-process reload ${label} exceeded its ${timeoutMs}ms deadline`)), timeoutMs)
      void work().then(
        value => { clearTimeout(timer); resolvePromise(value) },
        error => { clearTimeout(timer); rejectPromise(error) },
      )
    })
  }

  function loader(): RuntimeLoader {
    const value = ctx.get('loader') as RuntimeLoader | undefined
    if (!value || typeof value.resolve !== 'function') throw new Error('the Cordis Loader service is not available')
    return value
  }

  function resolveEntryId(active: RuntimeLoader, target: InProcessReloadRuntimeTarget, profileFile: string, allowSearch: boolean): string {
    if (target.entryId !== undefined) return normalizeEntryId(target.entryId)
    if (defaultEntryId !== undefined) return defaultEntryId
    if (!allowSearch) throw new Error('in-process reload requires an entryId')
    const rootEntry = active.resolve('include') as RuntimeEntry | undefined
    const store = rootEntry?.subtree?.store ?? {}
    for (const [id, entry] of Object.entries(store)) {
      if (entry?.options?.name === target.package) return id
      if (typeof entry?.options?.name === 'string') {
        try {
          const baseUrl = rootEntry?.subtree?.ctx?.baseUrl ?? pathToFileURL(profileFile).href
          const resolved = fileURLToPath(new URL(entry.options.name, baseUrl))
          const pkgInfo = findPackageRootForEntry(resolved)
          if (pkgInfo?.packageName === target.package) return id
        } catch {}
      }
    }
    throw new Error(`unable to resolve a mounted include entry for ${target.package}`)
  }

  function resolveMount(
    target: InProcessReloadRuntimeTarget,
    optionsResolve?: { allowMissingTarget?: boolean; verifyPackageMatch?: boolean },
  ): {
    loader: RuntimeLoader
    root: RuntimeEntry
    tree: RuntimeTree
    target: RuntimeEntry | undefined
    localEntryId: string
    profileFile: string
    stagingDir: string
  } {
    const active = loader()
    const rootEntry = resolveIncludeRootEntry(active)
    const tree = rootEntry.subtree!
    const profile = resolveProfileContext(active)
    const config = rootEntry.options?.config
    const configuredPath = config && typeof config === 'object' && !Array.isArray(config)
      ? (config as Record<string, unknown>).path : undefined
    if (options.profilePath !== undefined && configuredPath !== profile.profileUrl && tree.filename !== profile.profileFile) {
      throw new Error('the Cordis include root is not bound to this profile')
    }
    const rootFiber = fiberOf(rootEntry)
    if (!rootFiber || rootFiber.state !== ACTIVE) throw new Error('the Cordis include root is not active')
    const localEntryId = resolveEntryId(active, target, profile.profileFile, true)
    let resolvedTarget: unknown
    try { resolvedTarget = active.resolve(`include:${localEntryId}`) } catch { resolvedTarget = undefined }
    if (!resolvedTarget || typeof resolvedTarget !== 'object') {
      if (optionsResolve?.allowMissingTarget) {
        return {
          loader: active,
          root: rootEntry,
          tree,
          target: undefined,
          localEntryId,
          profileFile: profile.profileFile,
          stagingDir: profile.stagingDir,
        }
      }
      throw new Error(`the target entry ${localEntryId} is not mounted`)
    }
    const targetEntry = resolvedTarget as RuntimeEntry
    if (targetEntry.options?.id !== localEntryId || targetEntry.parent !== tree.root) {
      throw new Error(`the target entry ${localEntryId} is not a child of the include root`)
    }
    if (optionsResolve?.verifyPackageMatch !== false) {
      const mountedName = targetEntry.options.name
      if (typeof mountedName !== 'string') {
        throw new Error(`the target entry ${localEntryId} is not mounted from ${target.package}`)
      }
      if (mountedName !== target.package) {
        // When mounted from a file/relative specifier (including an immutable staged directory),
        // confirm the nearest package.json manifest (when present) matches the target package name.
        const isPathSpec = mountedName.startsWith('.') || mountedName.startsWith('file://') || isAbsolute(mountedName)
        if (!isPathSpec) {
          throw new Error(`the target entry ${localEntryId} is not mounted from ${target.package}`)
        }
        const entryAbs = mountedName.startsWith('file://')
          ? fileURLToPath(mountedName)
          : tree.ctx?.baseUrl
            ? fileURLToPath(new URL(mountedName, tree.ctx.baseUrl))
            : resolve(dirname(profile.profileFile), mountedName)
        const pkgInfo = existsSync(entryAbs) ? findPackageRootForEntry(entryAbs) : undefined
        if (pkgInfo && pkgInfo.packageName !== target.package && (!options.package || pkgInfo.packageName !== options.package)) {
          throw new Error(`the target entry ${localEntryId} is not mounted from ${target.package}`)
        }
      }
    }
    return {
      loader: active,
      root: rootEntry,
      tree,
      target: targetEntry,
      localEntryId,
      profileFile: profile.profileFile,
      stagingDir: profile.stagingDir,
    }
  }

  async function profileDigest(profileFile: string): Promise<string> {
    return createHash('sha256').update(await readFile(profileFile)).digest('hex')
  }

  interface MountIdentity {
    fiber: RuntimeFiber
    uid: number | null
    committed: object | null
    state: number
    moduleNamespace: unknown
    profileDigest: string
    pid: number
    invocationId: string | null
    hostGeneration: number
    entry: RuntimeEntry
  }

  async function capture(target: InProcessReloadRuntimeTarget): Promise<{
    mount: {
      loader: RuntimeLoader
      root: RuntimeEntry
      tree: RuntimeTree
      target: RuntimeEntry
      localEntryId: string
      profileFile: string
      stagingDir: string
    }
    identity: MountIdentity
  }> {
    const resolved = resolveMount(target)
    const entry = resolved.target!
    const fiber = fiberOf(entry)
    if (!fiber) throw new Error(`the target entry ${resolved.localEntryId} has no running fiber`)
    return {
      mount: { ...resolved, target: entry },
      identity: {
        fiber,
        uid: fiber.uid,
        committed: fiber.committed ?? null,
        state: fiber.state,
        moduleNamespace: entry.moduleNamespace,
        profileDigest: await profileDigest(resolved.profileFile),
        pid,
        invocationId,
        hostGeneration: options.hostGeneration(),
        entry,
      },
    }
  }

  function makeProbeResult(
    checks: number,
    failures: number,
    reloaded: boolean,
    fibersDisposed: number,
    failedChecks: string[],
    observations: Record<string, unknown>,
    extra?: { rolledBack?: boolean; rollbackProbe?: InProcessReloadRuntimeProbe },
  ): InProcessReloadRuntimeProbe {
    observations.failedChecks = failedChecks
    observations.fibersDisposed = fibersDisposed
    observations.reloaded = reloaded
    return {
      checks,
      failures,
      reloaded,
      fibersDisposed,
      failedChecks,
      probeDigest: digestOf(observations),
      ...(extra?.rolledBack === undefined ? {} : { rolledBack: extra.rolledBack }),
      ...(extra?.rollbackProbe === undefined ? {} : { rollbackProbe: extra.rollbackProbe }),
    }
  }

  async function probeConfigOnly(
    target: InProcessReloadRuntimeTarget,
    before: MountIdentity,
    expectedHostGeneration: number,
  ): Promise<{ probe: InProcessReloadRuntimeProbe; after: MountIdentity | null }> {
    let checks = 0; let failures = 0
    const failedChecks: string[] = []
    const bad = (check: string): void => { checks += 1; failures += 1; failedChecks.push(check) }
    const good = (): void => { checks += 1 }
    const observations: Record<string, unknown> = {}
    let after: MountIdentity | null = null
    try {
      const mount = resolveMount(target)
      const entry = mount.target!
      const fiber = fiberOf(entry)
      const currentProfileDigest = await profileDigest(mount.profileFile)
      const hostGeneration = options.hostGeneration()
      after = {
        fiber: fiber ?? before.fiber,
        uid: fiber?.uid ?? null, committed: fiber?.committed ?? null, state: fiber?.state ?? -1,
        moduleNamespace: entry.moduleNamespace, profileDigest: currentProfileDigest,
        pid, invocationId, hostGeneration, entry,
      }
      if (currentProfileDigest !== before.profileDigest) good(); else bad('profile-changed')
      if (fiber !== undefined && fiber.state === ACTIVE) good(); else bad('fiber-active')
      if (fiber !== undefined && fiber.uid !== null && fiber.uid === before.uid) good(); else bad('fiber-preserved')
      if (fiber !== undefined && fiber.committed !== undefined && fiber.committed !== null && fiber.committed !== before.committed) good(); else bad('store-rebuilt')
      if (entry.moduleNamespace === before.moduleNamespace) good(); else bad('module-reused')
      if (hostGeneration === expectedHostGeneration && after.hostGeneration === expectedHostGeneration) good(); else bad('host-generation-unchanged')
      if (before.hostGeneration === expectedHostGeneration) good(); else bad('host-generation-before')
      if (pid === before.pid && invocationId === before.invocationId) good(); else bad('process-identity')
      if (before.fiber.state === ACTIVE && fiber === before.fiber) good(); else bad('same-fiber-live')
      observations.profileChanged = currentProfileDigest !== before.profileDigest
      observations.fiberPreserved = after.uid === before.uid
      observations.storeRebuilt = after.committed !== before.committed
      observations.moduleReused = entry.moduleNamespace === before.moduleNamespace
      observations.probe = { pid, invocationId, hostGeneration }
    } catch (error) {
      bad('mount-resolvable')
      observations.error = error instanceof Error ? error.message : String(error)
      observations.probe = { pid, invocationId, hostGeneration: options.hostGeneration() }
    }
    const fibersDisposed = 0
    const reloaded = after !== null && failures === 0
      && after.profileDigest !== before.profileDigest
      && after.committed !== before.committed && after.uid === before.uid && after.state === ACTIVE
    observations.before = { uid: before.uid, state: before.state, profileDigest: before.profileDigest }
    observations.after = after === null ? null : { uid: after.uid, state: after.state, profileDigest: after.profileDigest }
    return { probe: makeProbeResult(checks, failures, reloaded, fibersDisposed, failedChecks, observations), after }
  }

  async function refreshTree(tree: RuntimeTree): Promise<void> {
    if (typeof tree.refresh !== 'function') throw new Error('the Cordis include tree does not expose refresh()')
    await tree.refresh()
    if (tree.persistenceError !== undefined) {
      throw tree.persistenceError instanceof Error
        ? tree.persistenceError
        : new Error(String(tree.persistenceError))
    }
    if (typeof tree.await === 'function') await tree.await()
  }

  function assertTarget(target: InProcessReloadRuntimeTarget, optionsAssert?: { allowSubtreeChange?: boolean }): void {
    if (DENIED_PACKAGES.has(target.package)) {
      throw new Error(`in-process reload target ${target.package} is denied and requires a process restart`)
    }
    if (options.package !== undefined && target.package !== options.package) {
      throw new Error(`in-process reload target ${target.package} is not the mounted package ${options.package}`)
    }
    if (!DIGEST.test(target.artifactDigest) || !DIGEST.test(target.patchDigest)) {
      throw new Error('in-process reload target digests are invalid')
    }
    if ((!optionsAssert?.allowSubtreeChange && target.changesProcessSubtree) || target.holdsUnprovenProcessAuthority) {
      throw new Error(`in-process reload target ${target.package} requires a process restart`)
    }
  }

  function attachErrorCollector(): {
    errors: string[]
    detach: () => void
  } {
    const errors: string[] = []
    const rootLogger = (ctx.root as unknown as {
      logger?: { exporter?: (exporter: { levels: Record<string, number>; export: (msg: {
        type?: string
        level?: number
        args?: unknown[]
      }) => void }) => () => void }
    }).logger
    if (typeof rootLogger?.exporter !== 'function') {
      return { errors, detach: () => {} }
    }
    const detach = rootLogger.exporter({
      levels: { default: 3 },
      export(message) {
        if (message.type !== 'error' && message.level !== 0 && message.level !== 1) return
        const detail = (message.args ?? []).map(arg => (arg instanceof Error ? arg.message : String(arg))).join(' ')
        errors.push(detail || 'cordis error')
      },
    })
    return { errors, detach }
  }

  async function settleEntryAndFiber(entry: RuntimeEntry | undefined): Promise<string[]> {
    const errors: string[] = []
    if (!entry) return errors
    if (entry._initTask) {
      await entry._initTask.catch(error => {
        errors.push(error instanceof Error ? error.message : String(error))
      })
    }
    const fiber = fiberOf(entry)
    if (fiber && typeof fiber.await === 'function' && (fiber.state === LOADING || fiber.inertia)) {
      try {
        await fiber.await()
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }
    return errors
  }

  async function disposeTargetEntry(tree: RuntimeTree, localEntryId: string, entry: RuntimeEntry | undefined): Promise<{
    disposedCount: number
    oldFiberDisposed: boolean
    errors: string[]
  }> {
    if (!entry) return { disposedCount: 0, oldFiberDisposed: true, errors: [] }
    const oldFiber = fiberOf(entry)
    const collector = attachErrorCollector()
    try {
      const group = entry.parent ?? tree.root
      if (typeof group?.remove === 'function') {
        group.remove(localEntryId, true)
      } else {
        if (tree.store) delete tree.store[localEntryId]
        await oldFiber?.dispose?.()
      }
      if (oldFiber) {
        await withDeadline(async () => {
          while (oldFiber.inertia) await oldFiber.inertia
          if (entry._initTask) await entry._initTask.catch(() => {})
        }, 'dispose')
      }
      const oldFiberDisposed = oldFiber === undefined
        || (oldFiber.state === DISPOSED && oldFiber.uid === null
          && (typeof oldFiber.getEffects !== 'function' || oldFiber.getEffects().length === 0))
      return {
        disposedCount: oldFiber?.state === DISPOSED ? 1 : 0,
        oldFiberDisposed,
        errors: [...collector.errors],
      }
    } finally {
      collector.detach()
    }
  }

  function verifyCandidatePatchDigest(
    artifact: InProcessReloadArtifactSpec,
    target: InProcessReloadRuntimeTarget,
    stagedDir: string,
    candidateProfileText: string | undefined,
  ): void {
    if (artifact.patchContent !== undefined) {
      const actual = computeInProcessPatchDigest(artifact.patchContent)
      if (actual !== target.patchDigest) {
        throw new Error(`in-process patch digest mismatch: expected ${target.patchDigest}, got ${actual}`)
      }
      return
    }
    if (artifact.patchPath !== undefined) {
      const actual = computeInProcessPatchDigest(readRegularFile(artifact.patchPath, 'patch file'))
      if (actual !== target.patchDigest) {
        throw new Error(`in-process patch digest mismatch: expected ${target.patchDigest}, got ${actual}`)
      }
      return
    }
    const manifestPatch = join(stagedDir, 'cordis.patch.yml')
    const manifestStat = lstatSync(manifestPatch, { throwIfNoEntry: false })
    if (manifestStat && !manifestStat.isSymbolicLink() && manifestStat.isFile()
      && artifact.config === undefined && artifact.inject === undefined && candidateProfileText === undefined) {
      const actual = computeInProcessPatchDigest(readFileSync(manifestPatch))
      if (actual !== target.patchDigest) {
        throw new Error(`in-process patch digest mismatch: expected ${target.patchDigest}, got ${actual}`)
      }
      return
    }
    if (candidateProfileText !== undefined) {
      const profilePatch = computeInProcessPatchDigest(candidateProfileText)
      if (profilePatch === target.patchDigest) return
    }
    const canonicalPatch = computeInProcessPatchDigest({ config: artifact.config, inject: artifact.inject })
    if (canonicalPatch === target.patchDigest) return
    if (manifestStat && !manifestStat.isSymbolicLink() && manifestStat.isFile()) {
      const actual = computeInProcessPatchDigest(readFileSync(manifestPatch))
      if (actual === target.patchDigest) return
    }
    throw new Error(`in-process patch digest mismatch: expected ${target.patchDigest}`)
  }

  function buildNextProfileText(
    tree: RuntimeTree,
    localEntryId: string,
    nextSpecifier: string,
    artifact: InProcessReloadArtifactSpec,
  ): string {
    const entries = cloneEntryList(tree)
    const idx = entries.findIndex(item => item.id === localEntryId)
    if (idx === -1) throw new Error(`entry ${localEntryId} is missing from profile cache`)
    const updated: Record<string, unknown> = { ...entries[idx], name: nextSpecifier }
    if (artifact.config !== undefined) updated.config = artifact.config
    if (artifact.inject !== undefined) updated.inject = artifact.inject
    entries[idx] = updated
    return serializeTreeData(tree, entries)
  }

  function snapshotOriginalArtifactBackup(
    beforeSpec: string,
    tree: RuntimeTree,
    targetPackage: string,
    profileFile: string,
    stagingDir: string,
  ): ArtifactRollbackBaseline['backedUpSource'] | undefined {
    const isPathSpec = beforeSpec.startsWith('.') || beforeSpec.startsWith('file://') || isAbsolute(beforeSpec)
    if (!isPathSpec) return undefined
    const entryAbs = beforeSpec.startsWith('file://')
      ? fileURLToPath(beforeSpec)
      : tree.ctx?.baseUrl
        ? fileURLToPath(new URL(beforeSpec, tree.ctx.baseUrl))
        : resolve(dirname(profileFile), beforeSpec)
    if (!existsSync(entryAbs) || isInsideRoot(stagingDir, entryAbs)) return undefined
    const pkgRoot = findPackageRootForEntry(entryAbs)
    const backupRoot = join(stagingDir, '.baseline-backups', sanitizeSlug(targetPackage))
    mkdirSync(backupRoot, { recursive: true })
    if (pkgRoot && pkgRoot.packageName === targetPackage) {
      const beforeDigest = computeInProcessArtifactDigest({ sourceDir: pkgRoot.packageRoot })
      const dest = join(backupRoot, `${beforeDigest}`)
      if (!existsSync(dest)) {
        copyRegularTree(pkgRoot.packageRoot, dest, walkRegularFiles(pkgRoot.packageRoot))
      }
      const relEntry = relative(pkgRoot.packageRoot, entryAbs)
      return { kind: 'dir', backupPath: join(dest, relEntry), beforeDigest, targetName: beforeSpec }
    }
    const stat = lstatSync(entryAbs)
    if (!stat.isSymbolicLink() && stat.isFile()) {
      const beforeDigest = computeInProcessArtifactDigest({ entryPath: entryAbs })
      const destDir = join(backupRoot, `${beforeDigest}`)
      const dest = join(destDir, sanitizeSlug(basename(entryAbs)))
      if (!existsSync(dest)) {
        mkdirSync(destDir, { recursive: true })
        copyFileSync(entryAbs, dest)
      }
      return { kind: 'file', backupPath: dest, beforeDigest, targetName: beforeSpec }
    }
    return undefined
  }

  async function probeRestoredBaseline(
    baseline: ArtifactRollbackBaseline,
    target: InProcessReloadRuntimeTarget,
    expectedHostGeneration: number,
    nonTargetSnapshots: readonly NonTargetSnapshot[],
    profileFile: string,
  ): Promise<InProcessReloadRuntimeProbe> {
    let checks = 0; let failures = 0
    const failedChecks: string[] = []
    const bad = (check: string): void => { checks += 1; failures += 1; failedChecks.push(check) }
    const good = (): void => { checks += 1 }
    const observations: Record<string, unknown> = {}
    try {
      const mount = resolveMount(target, { verifyPackageMatch: false })
      const entry = mount.target
      const fiber = fiberOf(entry)
      const restoredContent = await readFile(profileFile, 'utf8')
      const hostGeneration = options.hostGeneration()
      if (restoredContent === baseline.beforeProfileContent
        || computeInProcessPatchDigest(restoredContent) === computeInProcessPatchDigest(baseline.beforeProfileContent)) {
        good()
      } else {
        bad('profile-restored')
      }
      if (fiber !== undefined && fiber.state === ACTIVE && fiber.uid !== null) good(); else bad('restored-fiber-active')
      if (fiber?.committed !== undefined && fiber.committed !== null) good(); else bad('restored-store-committed')
      if (entry?.moduleNamespace !== undefined && entry.moduleNamespace === baseline.beforeModuleNamespace) {
        good()
      } else {
        bad('restored-module-namespace')
      }
      if (verifyNonTargetEntries(mount.tree, nonTargetSnapshots)) good(); else bad('non-target-undisturbed')
      if (hostGeneration === expectedHostGeneration) good(); else bad('host-generation-unchanged')
      observations.hostGeneration = hostGeneration
      observations.restoredUid = fiber?.uid ?? null
      observations.restoredState = fiber?.state ?? -1
    } catch (error) {
      bad('restore-mount-resolvable')
      observations.error = error instanceof Error ? error.message : String(error)
    }
    return makeProbeResult(checks, failures, failures === 0, 1, failedChecks, observations)
  }

  async function executeArtifactRollback(
    baseline: ArtifactRollbackBaseline,
    tree: RuntimeTree,
    target: InProcessReloadRuntimeTarget,
    expectedHostGeneration: number,
    nonTargetSnapshots: readonly NonTargetSnapshot[],
    profileFile: string,
  ): Promise<{ restored: boolean; rollbackProbe: InProcessReloadRuntimeProbe }> {
    const existingCandidate = tree.store?.[baseline.localEntryId]
    if (existingCandidate) {
      await disposeTargetEntry(tree, baseline.localEntryId, existingCandidate)
    }
    let profileContentToRestore = baseline.beforeProfileContent
    // If the prior unstaged file vanished on disk, swap the baseline entry name to our backup copy.
    if (baseline.backedUpSource !== undefined) {
      const priorTarget = baseline.backedUpSource.targetName
      const resolvedPrior = priorTarget.startsWith('file://')
        ? fileURLToPath(priorTarget)
        : tree.ctx?.baseUrl
          ? fileURLToPath(new URL(priorTarget, tree.ctx.baseUrl))
          : resolve(dirname(profileFile), priorTarget)
      if (!existsSync(resolvedPrior)) {
        const entries = cloneEntryList(tree)
        const idx = entries.findIndex(item => item.id === baseline.localEntryId)
        if (idx !== -1) {
          entries[idx] = {
            ...entries[idx],
            name: toRelativeImportSpecifier(dirname(profileFile), baseline.backedUpSource.backupPath),
          }
          profileContentToRestore = serializeTreeData(tree, entries)
        }
      }
    }
    await withDeadline(async () => {
      writeTextAtomic(profileFile, profileContentToRestore)
      // Force Include._read() to apply restored entries even if profileFile was never mutated (e.g. disposer failure).
      if (tree.cache && tree.cache.content === profileContentToRestore) {
        tree.cache.content = ''
      }
      await refreshTree(tree)
      if (!tree.store?.[baseline.localEntryId] && typeof tree.root?.update === 'function') {
        await tree.root.update(cloneEntryList(tree))
        if (typeof tree.await === 'function') await tree.await()
      }
      const restoredEntry = tree.store?.[baseline.localEntryId]
      await settleEntryAndFiber(restoredEntry)
    }, 'rollback')
    const rollbackProbe = await probeRestoredBaseline(baseline, target, expectedHostGeneration, nonTargetSnapshots, profileFile)
    return { restored: rollbackProbe.failures === 0 && rollbackProbe.reloaded, rollbackProbe }
  }

  return {
    snapshot: () => ({ hostGeneration: options.hostGeneration(), inProcessGeneration }),

    async activate(input) {
      assertRuntimeActive()
      if (!DIGEST.test(input.warrantDigest)) throw new Error('in-process reload warrant digest is invalid')
      const artifactReplace = input.target.artifact !== undefined || input.mode === 'artifact-replace'
      assertTarget(input.target, { allowSubtreeChange: artifactReplace })
      const currentHostGeneration = options.hostGeneration()
      if (input.previousHostGeneration !== currentHostGeneration) {
        throw new Error('in-process reload warrant is bound to another Host generation')
      }

      if (input.mode === 'artifact-replace' && input.target.artifact === undefined) {
        throw new Error('in-process artifact replacement requires a target artifact descriptor')
      }

      const before = await capture(input.target)
      const observedGeneration = before.identity.hostGeneration
      if (observedGeneration !== input.previousHostGeneration) {
        throw new Error('in-process reload started across a Host generation change')
      }
      const { profileFile, stagingDir } = before.mount

      if (!artifactReplace) {
        try {
          await withDeadline(async () => {
            assertRuntimeActive()
            if (options.apply) await options.apply()
            await refreshTree(before.mount.tree)
          })
        } catch (error) {
          inProcessGeneration += 1
          throw error
        }
        inProcessGeneration += 1
        const { probe: result } = await probeConfigOnly(input.target, before.identity, input.previousHostGeneration)
        return {
          previousHostGeneration: before.identity.hostGeneration,
          currentHostGeneration: options.hostGeneration(),
          previousInProcessGeneration: input.previousInProcessGeneration,
          currentInProcessGeneration: inProcessGeneration,
          probe: result,
        }
      }

      // Immutable digest-verified artifact replacement path.
      const artifactSpec = input.target.artifact!
      const staged = stageInProcessArtifact({ target: input.target, artifact: artifactSpec, stagingDir })
      const beforeProfileContent = await readFile(profileFile, 'utf8')
      const nextRelativeSpecifier = toRelativeImportSpecifier(dirname(profileFile), staged.entryFilePath)

      const hasExplicitPatch = artifactSpec.patchContent !== undefined || artifactSpec.patchPath !== undefined
      if (hasExplicitPatch) {
        verifyCandidatePatchDigest(artifactSpec, input.target, staged.stagedDir, undefined)
      }

      let nextProfileText: string
      if (options.apply) {
        try {
          await withDeadline(async () => {
            assertRuntimeActive()
            await options.apply!()
          }, 'apply')
          nextProfileText = await readFile(profileFile, 'utf8')
          if (!hasExplicitPatch) {
            verifyCandidatePatchDigest(artifactSpec, input.target, staged.stagedDir, nextProfileText)
          }
        } catch (error) {
          writeTextAtomic(profileFile, beforeProfileContent)
          throw error
        }
      } else {
        nextProfileText = buildNextProfileText(before.mount.tree, before.mount.localEntryId, nextRelativeSpecifier, artifactSpec)
        if (!hasExplicitPatch) {
          verifyCandidatePatchDigest(artifactSpec, input.target, staged.stagedDir, nextProfileText)
        }
      }

      const backedUpSource = snapshotOriginalArtifactBackup(
        before.identity.entry.options?.name ?? '',
        before.mount.tree,
        input.target.package,
        profileFile,
        stagingDir,
      )
      const baseline: ArtifactRollbackBaseline = {
        warrantDigest: input.warrantDigest,
        localEntryId: before.mount.localEntryId,
        targetPackage: input.target.package,
        beforeProfileContent,
        beforeModuleNamespace: before.identity.moduleNamespace,
        beforeSpec: before.identity.entry.options?.name ?? '',
        ...(backedUpSource === undefined ? {} : { backedUpSource }),
      }
      const nonTargetSnapshots = captureNonTargetEntries(before.mount.tree, before.mount.localEntryId)

      let fibersDisposed = 0
      const failedChecks: string[] = []
      const startupErrors: string[] = []
      let afterEntry: RuntimeEntry | undefined
      let afterFiber: RuntimeFiber | undefined
      let disposeOutcome: { disposedCount: number; oldFiberDisposed: boolean; errors: string[] }

      // Phase 1: Dispose the existing fiber cleanly before updating the profile and refreshing the tree.
      disposeOutcome = await disposeTargetEntry(before.mount.tree, before.mount.localEntryId, before.identity.entry)
      fibersDisposed += disposeOutcome.disposedCount

      if (!disposeOutcome.oldFiberDisposed || disposeOutcome.errors.length > 0) {
        if (!disposeOutcome.oldFiberDisposed) failedChecks.push('old-fiber-disposed')
        if (disposeOutcome.errors.length > 0) failedChecks.push('disposer-clean')
      } else {
        // Phase 2: Persist verified profile update (if not already written by options.apply) & reload entry.
        const collector = attachErrorCollector()
        try {
          assertRuntimeActive()
          if (!options.apply) writeTextAtomic(profileFile, nextProfileText)
          await withDeadline(async () => {
            await refreshTree(before.mount.tree)
            afterEntry = before.mount.tree.store?.[before.mount.localEntryId]
            const settleErrors = await settleEntryAndFiber(afterEntry)
            startupErrors.push(...settleErrors)
          }, 'refresh')
          afterFiber = fiberOf(afterEntry)
        } catch (error) {
          startupErrors.push(error instanceof Error ? error.message : String(error))
        } finally {
          startupErrors.push(...collector.errors)
          collector.detach()
        }
      }

      // Phase 3: Run strict post-reload lifecycle assertions.
      let checks = 0; let failures = 0
      const failCheck = (name: string): void => { checks += 1; failures += 1; if (!failedChecks.includes(name)) failedChecks.push(name) }
      const passCheck = (): void => { checks += 1 }

      const afterHostGeneration = options.hostGeneration()
      if (afterHostGeneration === input.previousHostGeneration && observedGeneration === input.previousHostGeneration) passCheck(); else failCheck('host-generation-unchanged')
      if (pid === before.identity.pid && invocationId === before.identity.invocationId) passCheck(); else failCheck('process-identity')
      if (disposeOutcome.oldFiberDisposed && fibersDisposed >= 1) passCheck(); else failCheck('old-fiber-disposed')
      if (disposeOutcome.errors.length === 0) passCheck(); else failCheck('disposer-clean')
      if (startupErrors.length === 0) passCheck(); else failCheck('startup-clean')

      const afterProfileDigest = await profileDigest(profileFile)
      if (afterProfileDigest !== before.identity.profileDigest) passCheck(); else failCheck('profile-changed')
      if (afterEntry !== undefined && afterEntry !== before.identity.entry && afterFiber !== undefined) passCheck(); else failCheck('target-present')
      if (afterFiber !== undefined && afterFiber !== before.identity.fiber && afterFiber.uid !== null && afterFiber.uid !== before.identity.uid) passCheck(); else failCheck('new-fiber-replaced')
      if (afterFiber?.state === PENDING) {
        failCheck('injections-satisfied')
      } else if (afterFiber?.state === FAILED) {
        failCheck('fiber-failed')
      } else if (afterFiber?.state === ACTIVE) {
        passCheck()
      } else {
        failCheck('fiber-active')
      }
      if (afterFiber?.committed !== undefined && afterFiber.committed !== null && afterFiber.committed !== before.identity.committed) passCheck(); else failCheck('store-rebuilt')
      if (afterEntry?.moduleNamespace !== undefined && afterEntry.moduleNamespace !== before.identity.moduleNamespace) passCheck(); else failCheck('module-namespace-updated')
      if (verifyNonTargetEntries(before.mount.tree, nonTargetSnapshots)) passCheck(); else failCheck('non-target-undisturbed')

      inProcessGeneration += 1
      const observations: Record<string, unknown> = {
        mode: 'artifact-replace',
        stagedArtifactDigest: staged.artifactDigest,
        fibersDisposed,
        beforeUid: before.identity.uid,
        afterUid: afterFiber?.uid ?? null,
        afterState: afterFiber?.state ?? -1,
        beforeProfileDigest: before.identity.profileDigest,
        afterProfileDigest,
        pid,
        invocationId,
        hostGeneration: afterHostGeneration,
        startupErrors,
        disposerErrors: disposeOutcome.errors,
      }

      if (failures === 0) {
        lastBaseline = baseline
        return {
          previousHostGeneration: observedGeneration,
          currentHostGeneration: options.hostGeneration(),
          previousInProcessGeneration: input.previousInProcessGeneration,
          currentInProcessGeneration: inProcessGeneration,
          probe: makeProbeResult(checks, failures, true, fibersDisposed, failedChecks, observations),
        }
      }

      // Phase 4: Automatic rollback to the exact prior immutable artifact and profile patch.
      const rollbackResult = await executeArtifactRollback(
        baseline,
        before.mount.tree,
        input.target,
        input.previousHostGeneration,
        nonTargetSnapshots,
        profileFile,
      )
      if (rollbackResult.restored) {
        baseline.autoRolledBack = {
          inProcessGeneration,
          restoredProfileDigest: computeInProcessPatchDigest(baseline.beforeProfileContent),
          nonTargetSnapshots,
        }
        lastBaseline = baseline
      }
      return {
        previousHostGeneration: observedGeneration,
        currentHostGeneration: options.hostGeneration(),
        previousInProcessGeneration: input.previousInProcessGeneration,
        currentInProcessGeneration: inProcessGeneration,
        probe: makeProbeResult(checks, failures, false, fibersDisposed, failedChecks, observations, {
          rolledBack: rollbackResult.restored,
          rollbackProbe: rollbackResult.rollbackProbe,
        }),
      }
    },

    async rollback(input) {
      assertRuntimeActive()
      if (!DIGEST.test(input.warrantDigest)) throw new Error('in-process reload warrant digest is invalid')
      const allowSubtreeChange = input.target.artifact !== undefined
        || (lastBaseline !== undefined
          && lastBaseline.warrantDigest === input.warrantDigest
          && lastBaseline.targetPackage === input.target.package)
      assertTarget(input.target, { allowSubtreeChange })
      const currentHostGeneration = options.hostGeneration()
      const mountBefore = resolveMount(input.target, { allowMissingTarget: true, verifyPackageMatch: false })

      // If this runtime instance already auto-rolled back cleanly for this transition, confirm the live serving tree.
      if (lastBaseline !== undefined
        && lastBaseline.warrantDigest === input.warrantDigest
        && lastBaseline.targetPackage === input.target.package
        && !options.restore) {
        const baseline = lastBaseline
        if (baseline.autoRolledBack !== undefined
          && (baseline.autoRolledBack.inProcessGeneration === input.reloadedInProcessGeneration
            || baseline.autoRolledBack.inProcessGeneration === input.reloadedInProcessGeneration + 1)) {
          inProcessGeneration += 1
          const resultProbe = await probeRestoredBaseline(
            baseline,
            input.target,
            currentHostGeneration,
            baseline.autoRolledBack.nonTargetSnapshots,
            mountBefore.profileFile,
          )
          const profileRestored = resultProbe.failures === 0
          return {
            hostGeneration: options.hostGeneration(),
            inProcessGeneration,
            restored: profileRestored && resultProbe.reloaded,
            profileRestored,
            probe: resultProbe,
          }
        }
        // Explicit rollback after a previously succeeded artifact replacement (`status === 'reloaded'`).
        const nonTargetSnapshots = captureNonTargetEntries(mountBefore.tree, baseline.localEntryId)
        try {
          const outcome = await executeArtifactRollback(
            baseline,
            mountBefore.tree,
            input.target,
            currentHostGeneration,
            nonTargetSnapshots,
            mountBefore.profileFile,
          )
          inProcessGeneration += 1
          return {
            hostGeneration: options.hostGeneration(),
            inProcessGeneration,
            restored: outcome.restored,
            profileRestored: outcome.rollbackProbe.failures === 0,
            probe: outcome.rollbackProbe,
          }
        } catch (error) {
          inProcessGeneration += 1
          throw error
        }
      }

      // Legacy / config-only rollback path (including external caller-supplied `options.restore`).
      const before = await capture(input.target)
      if (before.identity.hostGeneration !== currentHostGeneration) {
        throw new Error('in-process rollback started across a Host generation change')
      }
      let profileRestored = false
      try {
        await withDeadline(async () => {
          assertRuntimeActive()
          if (options.restore) { await options.restore(); profileRestored = true }
          await refreshTree(before.mount.tree)
        })
      } catch (error) {
        inProcessGeneration += 1
        throw error
      }
      inProcessGeneration += 1
      const { probe: result } = await probeConfigOnly(input.target, before.identity, currentHostGeneration)
      return {
        hostGeneration: options.hostGeneration(),
        inProcessGeneration,
        restored: profileRestored && result.failures === 0 && result.reloaded,
        profileRestored,
        probe: result,
      }
    },
  }
}
