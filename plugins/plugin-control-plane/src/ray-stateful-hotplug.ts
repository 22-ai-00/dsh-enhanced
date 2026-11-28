import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, posix, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  commandReferencesRayKernel,
  type RayCapabilityProvenance,
  type RayHomeCapabilityEntry,
} from '@dsh-ray/assistant-growth-contract'
import type { AssistantPolicyService, RayHomeRuntime } from '@dsh-ray/assistant-policy'

const FIBER_FAILED = 3
const FIBER_DISPOSED = 4

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{1,62}$/u
const SEMVER_OR_REV_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const CREDENTIAL_CONTENT_RE = /credentials-keychain|\.key\b|\.pem\b/iu
const PROTECTED_ENERGY_RE = /(?:^|[/\\])energy(?:[/\\]energy\.sqlite)?\b|\benergy\.sqlite\b/iu

/** Spine & kernel packages that must never be self-authored or hot-replaced in live Ray Hosts. */
export const RAY_SPINE_AND_KERNEL_PLUGIN_DENYLIST: readonly string[] = Object.freeze([
  '@dsh-ray/plugin-control-plane',
  '@dsh-ray/assistant-delivery',
  '@dsh-ray/assistant-policy',
  '@dsh-ray/assistant-verifier',
  'dsh-ray-plugin-control-plane',
  'dsh-ray-assistant-delivery',
  'dsh-ray-assistant-policy',
  'dsh-ray-assistant-verifier',
  'plugin-control-plane',
  'assistant-delivery',
  'assistant-policy',
  'assistant-verifier',
])

const DENIED_SET = new Set(RAY_SPINE_AND_KERNEL_PLUGIN_DENYLIST)

export type RayStatefulPluginKind = 'service' | 'channel' | 'ui' | 'tool'

export type RayStatefulPluginStatus =
  | 'staged'
  | 'trial_verified'
  | 'observing'
  | 'active'
  | 'rolled_back'
  | 'rejected'

export interface RayHotplugPluginFile {
  readonly path: string
  readonly content: string
}

export interface RayHotplugPrecondition {
  readonly requiredServices?: readonly string[]
  readonly iffNote?: string
}

export interface RayHotplugStageInput {
  readonly slug: string
  readonly version: string
  readonly kind: RayStatefulPluginKind
  readonly entryFile?: string
  readonly files: readonly RayHotplugPluginFile[]
  readonly config?: Readonly<Record<string, unknown>>
  readonly precondition?: RayHotplugPrecondition
  readonly reason?: string
  readonly trialSetup?: (trialCtx: Context) => void | Promise<void>
  readonly independentVerify?: (
    trialCtx: Context,
    info: Readonly<{ mod: Record<string, unknown>; registeredTools: readonly string[] }>,
  ) => boolean | { ok: boolean; reason?: string } | Promise<boolean | { ok: boolean; reason?: string }>
}

export interface RayHotplugRevisionRecord {
  readonly revisionId: string
  readonly slug: string
  readonly version: string
  readonly kind: RayStatefulPluginKind
  readonly entryFile: string
  readonly sourceDir: string
  readonly artifactDir: string
  readonly artifactDigest: string
  readonly verificationDigest?: string
  readonly status: RayStatefulPluginStatus
  readonly config: Readonly<Record<string, unknown>>
  readonly precondition: RayHotplugPrecondition
  readonly rollbackReason?: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface RayHotplugPluginSummary {
  readonly slug: string
  readonly kind: RayStatefulPluginKind
  readonly activeVersion?: string
  readonly activeArtifactDigest?: string
  readonly previousVersion?: string
  readonly previousArtifactDigest?: string
  readonly status: RayStatefulPluginStatus
  readonly provenance?: Readonly<RayCapabilityProvenance>
  readonly precondition: RayHotplugPrecondition
  readonly liveMounted: boolean
  readonly updatedAt: number
}

export interface RayHotplugStageResult {
  readonly ok: boolean
  readonly reason?: string
  readonly revision?: RayHotplugRevisionRecord
  readonly registeredTrialTools: readonly string[]
  readonly trialFiberDisposed: boolean
}

export interface RayHotplugPromoteInput {
  readonly slug: string
  readonly version?: string
  readonly reason?: string
  readonly provenance?: Readonly<RayCapabilityProvenance>
  readonly observationProbe?: (hostCtx: Context) => boolean | { ok: boolean; reason?: string } | Promise<boolean | { ok: boolean; reason?: string }>
}

export interface RayHotplugPromoteResult {
  readonly ok: boolean
  readonly promoted: boolean
  readonly rolledBack?: boolean
  readonly restoredVersion?: string
  readonly reason?: string
  readonly revision?: RayHotplugRevisionRecord
}

export interface RayHotplugRollbackResult {
  readonly ok: boolean
  readonly slug: string
  readonly disposedVersion?: string
  readonly restoredVersion?: string
  readonly liveFiberDisposed: boolean
  readonly reason: string
}

interface LiveMountHandle {
  readonly revisionId: string
  readonly slug: string
  readonly version: string
  readonly kind: RayStatefulPluginKind
  readonly entryFile: string
  readonly artifactDir: string
  readonly artifactDigest: string
  readonly config: Readonly<Record<string, unknown>>
  readonly fiber: { state: number; dispose: () => Promise<void>; inertia?: Promise<void> }
}

interface RevisionRow {
  revision_id: string
  slug: string
  version: string
  kind: RayStatefulPluginKind
  entry_file: string
  source_dir: string
  artifact_dir: string
  artifact_digest: string
  verification_digest: string | null
  status: RayStatefulPluginStatus
  config_json: string
  precondition_json: string
  rollback_reason: string | null
  created_at: number
  updated_at: number
}

interface PluginRow {
  slug: string
  kind: RayStatefulPluginKind
  active_version: string | null
  active_artifact_digest: string | null
  previous_version: string | null
  previous_artifact_digest: string | null
  status: RayStatefulPluginStatus
  provenance_json: string | null
  precondition_json: string
  updated_at: number
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function ensurePrivateDir(dirPath: string): void {
  if (existsSync(dirPath)) {
    const stat = lstatSync(dirPath)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`plugin-control-plane: unsafe Ray plugin directory: ${dirPath}`)
    }
    return
  }
  mkdirSync(dirPath, { recursive: true, mode: 0o700 })
  chmodSync(dirPath, 0o700)
}

function atomicWritePrivateText(filePath: string, content: string): void {
  const dir = dirname(filePath)
  ensurePrivateDir(dir)
  if (existsSync(filePath)) {
    const stat = lstatSync(filePath)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`plugin-control-plane: unsafe Ray plugin file: ${filePath}`)
    }
  }
  const tmpPath = join(dir, `.tmp.${process.pid}.${randomUUID()}`)
  writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  chmodSync(tmpPath, 0o600)
  try {
    renameSync(tmpPath, filePath)
  } catch (error) {
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
    throw error
  }
}

function normalizeRelativeFilePath(raw: string): string {
  const cleaned = raw.replaceAll('\\', '/').trim()
  if (
    cleaned === ''
    || cleaned.startsWith('/')
    || cleaned.includes('\0')
    || cleaned.includes('\r')
    || cleaned.includes('\n')
    || isAbsolute(cleaned)
  ) {
    throw new Error(`plugin-control-plane: unsafe relative plugin path: ${raw}`)
  }
  const norm = posix.normalize(cleaned)
  if (norm === '.' || norm === '..' || norm.startsWith('../') || norm.includes('/../')) {
    throw new Error(`plugin-control-plane: plugin path escapes package root: ${raw}`)
  }
  return norm
}

function inspectPluginSourceSafety(
  slug: string,
  rayHome: string,
  files: readonly RayHotplugPluginFile[],
): string | undefined {
  const lowerSlug = slug.trim().toLowerCase()
  if (DENIED_SET.has(lowerSlug) || DENIED_SET.has(`@dsh-ray/${lowerSlug}`) || lowerSlug.includes('body-kernel')) {
    return `RAY_HOTPLUG_DENIED: ${slug} 属于身体内核或脊髓核心插件（${RAY_SPINE_AND_KERNEL_PLUGIN_DENYLIST.join(', ')}），禁止自创作或活进程热替换。`
  }

  const kernelRoot = join(rayHome, 'kernel').replaceAll('\\', '/')
  const energyRoot = join(rayHome, 'energy').replaceAll('\\', '/')
  for (const file of files) {
    const text = file.content
    if (commandReferencesRayKernel(text, rayHome)) {
      return `RAY_KERNEL_WRITE_DENIED: 插件文件 ${file.path} 引用了受保护身体内核路径，拒绝装载。`
    }
    if (text.replaceAll('\\', '/').includes(kernelRoot) || /\bkernel\.json\b/iu.test(text)) {
      return `RAY_KERNEL_WRITE_DENIED: 插件文件 ${file.path} 试图访问 kernel.json，拒绝装载。`
    }
    if (text.replaceAll('\\', '/').includes(energyRoot) || PROTECTED_ENERGY_RE.test(text)) {
      return `RAY_KERNEL_WRITE_DENIED: 插件文件 ${file.path} 试图直接读写受保护精力账本，拒绝装载。`
    }
    if (CREDENTIAL_CONTENT_RE.test(text)) {
      return `RAY_HOTPLUG_DENIED: 插件文件 ${file.path} 包含凭据钥匙串访问特征，拒绝自创插件读取凭据。`
    }
    try {
      const pkg = file.path === 'package.json' ? JSON.parse(text) as { name?: unknown } : undefined
      if (typeof pkg?.name === 'string' && DENIED_SET.has(pkg.name)) {
        return `RAY_HOTPLUG_DENIED: 包名 ${pkg.name} 属于脊髓/内核受保护包，拒绝仿冒。`
      }
    } catch {
      // Malformed package.json will be rejected at module stage anyway.
    }
  }
  return undefined
}

async function settleFiber(fiber: { inertia?: Promise<void> }): Promise<void> {
  if (fiber.inertia !== undefined) {
    await fiber.inertia
  }
  await Promise.resolve(fiber as unknown as PromiseLike<unknown>).catch(() => undefined)
}

function rowToRevision(row: RevisionRow): RayHotplugRevisionRecord {
  return {
    revisionId: row.revision_id,
    slug: row.slug,
    version: row.version,
    kind: row.kind,
    entryFile: row.entry_file,
    sourceDir: row.source_dir,
    artifactDir: row.artifact_dir,
    artifactDigest: row.artifact_digest,
    ...(row.verification_digest === null ? {} : { verificationDigest: row.verification_digest }),
    status: row.status,
    config: JSON.parse(row.config_json) as Record<string, unknown>,
    precondition: JSON.parse(row.precondition_json) as RayHotplugPrecondition,
    ...(row.rollback_reason === null ? {} : { rollbackReason: row.rollback_reason }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function computeDirectoryFilesDigest(dirPath: string, fileNames: readonly string[]): string {
  const parts: Array<{ path: string; sha256: string }> = []
  for (const rel of [...fileNames].sort()) {
    const full = resolve(dirPath, rel)
    if (!existsSync(full)) {
      throw new Error(`plugin-control-plane: missing staged artifact file ${rel}`)
    }
    const stat = lstatSync(full)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`plugin-control-plane: unsafe staged artifact file ${rel}`)
    }
    parts.push({ path: rel, sha256: sha256Text(readFileSync(full, 'utf8')) })
  }
  return sha256Text(canonicalJson(parts))
}

function isPlausibleCordisPlugin(value: unknown): boolean {
  return typeof value === 'function'
    || (value !== null && typeof value === 'object' && typeof (value as { apply?: unknown }).apply === 'function')
}

function normalizeProbeOutcome(outcome: unknown): { ok: boolean; reason?: string } {
  if (outcome === undefined || outcome === true) return { ok: true }
  if (outcome === false) return { ok: false, reason: 'probe-returned-false' }
  if (outcome !== null && typeof outcome === 'object') {
    const rec = outcome as { ok?: unknown; reason?: unknown }
    if (rec.ok === false) {
      return {
        ok: false,
        reason: typeof rec.reason === 'string' && rec.reason.trim() !== '' ? rec.reason : 'probe-returned-failed',
      }
    }
    return { ok: true }
  }
  return { ok: Boolean(outcome) }
}

/**
 * Three-stage hot-pluggable lifecycle for Ray self-authored stateful plugins:
 *   Stage 1: Isolated child/trial Cordis Context verification -> dispose trial Fiber.
 *   Stage 2: Precondition check + digest verification + live Cordis Host hot-load (no restart).
 *   Stage 3: Live observation probe, automatic Fiber disposal rollback to prior immutable artifact,
 *            and 1-turn owner `/veto` teardown handler.
 */
export class RayStatefulHotplugRuntime {
  readonly dbPath: string
  readonly sourcesRoot: string
  readonly artifactsRoot: string
  private readonly hostCtx: Context
  private readonly callerCtx: Context
  private readonly policy: AssistantPolicyService
  private readonly raySelf: RayHomeRuntime
  private db: DatabaseSync | undefined
  private readonly liveFibers = new Map<string, LiveMountHandle>()
  private readonly disposers: Array<() => void> = []
  private closed = false

  constructor(options: Readonly<{
    hostCtx: Context
    callerCtx?: Context
    policy: AssistantPolicyService
    raySelf: RayHomeRuntime
  }>) {
    this.hostCtx = options.hostCtx
    this.callerCtx = options.callerCtx ?? options.hostCtx
    this.policy = options.policy
    this.raySelf = options.raySelf
    const pluginsDir = join(this.raySelf.rayHome, 'plugins')
    this.sourcesRoot = join(pluginsDir, 'sources')
    this.artifactsRoot = join(pluginsDir, 'artifacts')
    this.dbPath = join(pluginsDir, 'hotplug.sqlite')
    ensurePrivateDir(pluginsDir)
    ensurePrivateDir(this.sourcesRoot)
    ensurePrivateDir(this.artifactsRoot)
    this.openDatabase()
    this.raySelf.registerDatabase('plugin-control-plane:hotplug', this.dbPath)
    this.disposers.push(this.raySelf.registerVetoHandler(async (input) => this.handleOwnerVeto(input)))
    if (typeof (this.raySelf as unknown as { setPluginVerifier?: unknown }).setPluginVerifier === 'function') {
      const clearVerifier = (this.raySelf as unknown as {
        setPluginVerifier: (fn: (spec: unknown) => Promise<{ ok: boolean; verificationDigest?: string; reason?: string }>) => () => void
      }).setPluginVerifier(async (spec) => this.verifyTaughtPluginArtifact(spec))
      this.disposers.push(clearVerifier)
    }
    this.installTools()
  }

  private openDatabase(): void {
    const db = new DatabaseSync(this.dbPath)
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA synchronous = NORMAL;')
    db.exec(`
      CREATE TABLE IF NOT EXISTS ray_hotplug_plugins (
        slug TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        active_version TEXT,
        active_artifact_digest TEXT,
        previous_version TEXT,
        previous_artifact_digest TEXT,
        status TEXT NOT NULL,
        provenance_json TEXT,
        precondition_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ray_hotplug_revisions (
        revision_id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        version TEXT NOT NULL,
        kind TEXT NOT NULL,
        entry_file TEXT NOT NULL,
        source_dir TEXT NOT NULL,
        artifact_dir TEXT NOT NULL,
        artifact_digest TEXT NOT NULL,
        verification_digest TEXT,
        status TEXT NOT NULL,
        config_json TEXT NOT NULL,
        precondition_json TEXT NOT NULL,
        rollback_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ray_hotplug_rev_slug ON ray_hotplug_revisions (slug, created_at DESC);
    `)
    this.db = db
    try { chmodSync(this.dbPath, 0o600) } catch { /* ignore */ }
  }

  private assertOpen(): DatabaseSync {
    if (this.closed || this.db === undefined) {
      throw new Error('plugin-control-plane: RayStatefulHotplugRuntime is closed')
    }
    return this.db
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const live of this.liveFibers.values()) {
      try { await live.fiber.dispose() } catch { /* ignore */ }
    }
    this.liveFibers.clear()
    for (const dispose of this.disposers.splice(0).reverse()) {
      try { dispose() } catch { /* ignore */ }
    }
    try { this.db?.close() } catch { /* ignore */ }
    this.db = undefined
  }

  listPlugins(): RayHotplugPluginSummary[] {
    const db = this.assertOpen()
    const rows = db.prepare(`
      SELECT * FROM ray_hotplug_plugins ORDER BY updated_at DESC, slug ASC
    `).all() as unknown as PluginRow[]
    return rows.map(row => ({
      slug: row.slug,
      kind: row.kind,
      ...(row.active_version === null ? {} : { activeVersion: row.active_version }),
      ...(row.active_artifact_digest === null ? {} : { activeArtifactDigest: row.active_artifact_digest }),
      ...(row.previous_version === null ? {} : { previousVersion: row.previous_version }),
      ...(row.previous_artifact_digest === null ? {} : { previousArtifactDigest: row.previous_artifact_digest }),
      status: row.status,
      ...(row.provenance_json === null ? {} : { provenance: JSON.parse(row.provenance_json) as RayCapabilityProvenance }),
      precondition: JSON.parse(row.precondition_json) as RayHotplugPrecondition,
      liveMounted: this.liveFibers.has(row.slug),
      updatedAt: row.updated_at,
    }))
  }

  getRevisions(slug: string): RayHotplugRevisionRecord[] {
    const db = this.assertOpen()
    const rows = db.prepare(`
      SELECT * FROM ray_hotplug_revisions WHERE slug = ? ORDER BY created_at DESC, rowid DESC
    `).all(slug) as unknown as RevisionRow[]
    return rows.map(rowToRevision)
  }

  /** Stage 1: Write source + immutable artifact and verify inside a disposable isolated child Cordis Context. */
  async stageAndTrialPlugin(input: RayHotplugStageInput): Promise<RayHotplugStageResult> {
    const db = this.assertOpen()
    const slug = input.slug.trim()
    const version = input.version.trim()
    if (!SLUG_RE.test(slug)) {
      return { ok: false, reason: `非法插件标识：${input.slug}`, registeredTrialTools: [], trialFiberDisposed: false }
    }
    if (!SEMVER_OR_REV_RE.test(version)) {
      return { ok: false, reason: `非法插件版本号：${input.version}`, registeredTrialTools: [], trialFiberDisposed: false }
    }
    if (input.files.length === 0) {
      return { ok: false, reason: '插件源码文件列表不能为空', registeredTrialTools: [], trialFiberDisposed: false }
    }

    const normalizedFiles = input.files.map(file => ({
      path: normalizeRelativeFilePath(file.path),
      content: file.content,
    }))
    const entryFile = normalizeRelativeFilePath(input.entryFile ?? 'index.mjs')
    if (!normalizedFiles.some(f => f.path === entryFile)) {
      return { ok: false, reason: `缺少入口文件：${entryFile}`, registeredTrialTools: [], trialFiberDisposed: false }
    }

    const safetyError = inspectPluginSourceSafety(slug, this.raySelf.rayHome, normalizedFiles)
    if (safetyError !== undefined) {
      return { ok: false, reason: safetyError, registeredTrialTools: [], trialFiberDisposed: false }
    }

    const precondition: RayHotplugPrecondition = {
      ...(Array.isArray(input.precondition?.requiredServices)
        ? { requiredServices: input.precondition!.requiredServices.map(s => s.trim()).filter(Boolean) }
        : {}),
      ...(typeof input.precondition?.iffNote === 'string' && input.precondition.iffNote.trim() !== ''
        ? { iffNote: input.precondition.iffNote.trim() }
        : {}),
    }
    const config = input.config ? { ...input.config } : {}

    const allArtifactFiles = new Map<string, string>()
    for (const file of normalizedFiles) {
      allArtifactFiles.set(file.path, file.content)
    }
    if (!allArtifactFiles.has('package.json')) {
      allArtifactFiles.set('package.json', `${JSON.stringify({
        name: `@ray-self/${slug}`,
        version,
        type: 'module',
        main: `./${entryFile}`,
      }, null, 2)}\n`)
    }
    allArtifactFiles.set('.precondition.json', `${JSON.stringify(precondition)}\n`)

    const artifactEntries = [...allArtifactFiles.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, content]) => ({ path, sha256: sha256Text(content) }))
    const artifactDigest = sha256Text(canonicalJson(artifactEntries))

    const sourceDir = join(this.sourcesRoot, slug)
    ensurePrivateDir(sourceDir)
    for (const file of normalizedFiles) {
      atomicWritePrivateText(join(sourceDir, file.path), file.content)
    }

    const slugArtifactsDir = join(this.artifactsRoot, slug)
    ensurePrivateDir(slugArtifactsDir)
    const artifactDir = join(slugArtifactsDir, `${version}-${artifactDigest.slice(0, 16)}`)
    ensurePrivateDir(artifactDir)
    for (const [relPath, content] of allArtifactFiles.entries()) {
      atomicWritePrivateText(join(artifactDir, relPath), content)
    }
    const verifiedDiskDigest = computeDirectoryFilesDigest(artifactDir, [...allArtifactFiles.keys()])
    if (verifiedDiskDigest !== artifactDigest) {
      throw new Error(`plugin-control-plane: artifact digest verification failed on write for ${slug}`)
    }

    const now = Date.now()
    const revisionId = `hotrev-${randomUUID()}`
    db.prepare(`
      INSERT INTO ray_hotplug_revisions (
        revision_id, slug, version, kind, entry_file, source_dir, artifact_dir,
        artifact_digest, verification_digest, status, config_json, precondition_json,
        rollback_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'staged', ?, ?, NULL, ?, ?)
    `).run(
      revisionId,
      slug,
      version,
      input.kind,
      entryFile,
      sourceDir,
      artifactDir,
      artifactDigest,
      JSON.stringify(config),
      JSON.stringify(precondition),
      now,
      now,
    )

    // Boot isolated child/trial Context — never mutates live hostCtx during Stage 1.
    const trialCtx = new Context()
    trialCtx.baseUrl = pathToFileURL(`${artifactDir}/`).href
    const registeredTrialTools: string[] = []
    trialCtx.provide('tools' as never, {
      register: (def: { name?: unknown }) => {
        const toolName = typeof def?.name === 'string' ? def.name : 'unknown'
        registeredTrialTools.push(toolName)
        return () => {
          const idx = registeredTrialTools.indexOf(toolName)
          if (idx >= 0) registeredTrialTools.splice(idx, 1)
        }
      },
    } as never)
    if (typeof input.trialSetup === 'function') {
      await input.trialSetup(trialCtx)
    }

    let trialFiber: { state: number; dispose: () => Promise<void>; inertia?: Promise<void> } | undefined
    let trialFiberDisposed = false
    try {
      const moduleUrl = `${pathToFileURL(join(artifactDir, entryFile)).href}?trial=${encodeURIComponent(revisionId)}`
      const mod = await import(moduleUrl) as Record<string, unknown>
      const pluginExport = mod.default ?? mod
      if (!isPlausibleCordisPlugin(pluginExport)) {
        throw new Error(`入口 ${entryFile} 未导出有效的 Cordis 插件（函数 / Service 类 / { apply } 对象）`)
      }

      trialFiber = trialCtx.plugin(pluginExport as never, config as never) as unknown as {
        state: number
        dispose: () => Promise<void>
        inertia?: Promise<void>
      }
      await settleFiber(trialFiber)
      if (trialFiber.state === FIBER_FAILED) {
        throw new Error(`插件 ${slug}@${version} 在隔离 Trial 上下文启动失败`)
      }

      if (typeof mod.verifyTrial === 'function') {
        const res = normalizeProbeOutcome(await (mod.verifyTrial as (c: Context) => unknown)(trialCtx))
        if (!res.ok) {
          throw new Error(`插件自检 verifyTrial 未通过：${res.reason ?? 'failed'}`)
        }
      }
      if (typeof input.independentVerify === 'function') {
        const res = normalizeProbeOutcome(
          await input.independentVerify(trialCtx, { mod, registeredTools: [...registeredTrialTools] }),
        )
        if (!res.ok) {
          throw new Error(`独立验收未通过：${res.reason ?? 'failed'}`)
        }
      }

      const verifiedToolsSnapshot = [...registeredTrialTools]
      await trialFiber.dispose()
      await trialCtx.fiber.dispose()
      trialFiberDisposed = trialFiber.state === FIBER_DISPOSED

      const verificationDigest = sha256Text(canonicalJson({
        slug,
        version,
        kind: input.kind,
        artifactDigest,
        precondition,
        verifiedTools: verifiedToolsSnapshot,
        verifiedAtStage: 'stage-1-trial',
      }))

      const settledAt = Date.now()
      db.prepare(`
        UPDATE ray_hotplug_revisions
        SET verification_digest = ?, status = 'trial_verified', updated_at = ?
        WHERE revision_id = ?
      `).run(verificationDigest, settledAt, revisionId)

      const existingPlugin = db.prepare('SELECT * FROM ray_hotplug_plugins WHERE slug = ?').get(slug) as unknown as PluginRow | undefined
      if (existingPlugin === undefined) {
        db.prepare(`
          INSERT INTO ray_hotplug_plugins (
            slug, kind, active_version, active_artifact_digest, previous_version, previous_artifact_digest,
            status, provenance_json, precondition_json, updated_at
          ) VALUES (?, ?, NULL, NULL, NULL, NULL, 'trial_verified', NULL, ?, ?)
        `).run(slug, input.kind, JSON.stringify(precondition), settledAt)
      }

      const updated = rowToRevision(
        db.prepare('SELECT * FROM ray_hotplug_revisions WHERE revision_id = ?').get(revisionId) as unknown as RevisionRow,
      )
      return {
        ok: true,
        revision: updated,
        registeredTrialTools: verifiedToolsSnapshot,
        trialFiberDisposed,
      }
    } catch (error) {
      if (trialFiber !== undefined) {
        try { await trialFiber.dispose() } catch { /* ignore */ }
        trialFiberDisposed = trialFiber.state === FIBER_DISPOSED
      }
      try { await trialCtx.fiber.dispose() } catch { /* ignore */ }
      const errMsg = error instanceof Error ? error.message : String(error)
      db.prepare(`
        UPDATE ray_hotplug_revisions
        SET status = 'rejected', rollback_reason = ?, updated_at = ?
        WHERE revision_id = ?
      `).run(errMsg, Date.now(), revisionId)
      return {
        ok: false,
        reason: errMsg,
        registeredTrialTools: [...registeredTrialTools],
        trialFiberDisposed,
      }
    }
  }

  /**
   * GUARD-inspired `[iff]` precondition refinement: tightens when a self-authored plugin may be active
   * and requires re-running Stage 1 trial verification before promotion.
   */
  async revisePrecondition(
    slug: string,
    input: Readonly<{ requiredServices?: readonly string[]; iffNote?: string; reason: string }>,
  ): Promise<RayHotplugStageResult> {
    const db = this.assertOpen()
    const latest = db.prepare(`
      SELECT * FROM ray_hotplug_revisions WHERE slug = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(slug) as unknown as RevisionRow | undefined
    if (latest === undefined) {
      return { ok: false, reason: `未找到插件 ${slug} 的源码修订`, registeredTrialTools: [], trialFiberDisposed: false }
    }
    const files: RayHotplugPluginFile[] = []
    this.collectFilesRelative(latest.source_dir, '', files)
    return this.stageAndTrialPlugin({
      slug: latest.slug,
      version: latest.version,
      kind: latest.kind,
      entryFile: latest.entry_file,
      files,
      config: JSON.parse(latest.config_json) as Record<string, unknown>,
      precondition: {
        ...(input.requiredServices === undefined ? {} : { requiredServices: input.requiredServices }),
        ...(input.iffNote === undefined ? {} : { iffNote: input.iffNote }),
      },
      reason: input.reason,
    })
  }

  private collectFilesRelative(root: string, relPrefix: string, out: RayHotplugPluginFile[]): void {
    const entries = readdirSync(join(root, relPrefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const rel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`
      if (entry.isDirectory()) {
        this.collectFilesRelative(root, rel, out)
      } else if (entry.isFile()) {
        out.push({ path: rel, content: readFileSync(join(root, rel), 'utf8') })
      }
    }
  }

  /** Stage 2: Check precondition & verification digest, then hot-load into the live Host Context without restarting. */
  async promotePluginLive(input: RayHotplugPromoteInput): Promise<RayHotplugPromoteResult> {
    const db = this.assertOpen()
    const slug = input.slug.trim()
    if (DENIED_SET.has(slug)) {
      return { ok: false, promoted: false, reason: `RAY_HOTPLUG_DENIED: ${slug} 属于受保护脊髓/内核插件` }
    }

    const row = (input.version
      ? db.prepare(`
          SELECT * FROM ray_hotplug_revisions
          WHERE slug = ? AND version = ? AND status IN ('trial_verified', 'active', 'observing')
          ORDER BY created_at DESC, rowid DESC LIMIT 1
        `).get(slug, input.version)
      : db.prepare(`
          SELECT * FROM ray_hotplug_revisions
          WHERE slug = ? AND status = 'trial_verified'
          ORDER BY created_at DESC, rowid DESC LIMIT 1
        `).get(slug)) as unknown as RevisionRow | undefined

    if (row === undefined) {
      return { ok: false, promoted: false, reason: `插件 ${slug}${input.version ? `@${input.version}` : ''} 尚未通过 Stage 1 隔离试用验证` }
    }
    if (!row.verification_digest) {
      return { ok: false, promoted: false, reason: `插件 ${slug}@${row.version} 缺少独立验签摘要 verificationDigest` }
    }

    const manifestFiles = existsSync(row.artifact_dir)
      ? readdirSync(row.artifact_dir).filter(name => !name.startsWith('.tmp.'))
      : []
    const actualDigest = computeDirectoryFilesDigest(row.artifact_dir, manifestFiles)
    if (actualDigest !== row.artifact_digest) {
      return { ok: false, promoted: false, reason: `插件制品目录摘要校验失败（疑遭篡改）：${slug}@${row.version}` }
    }

    const precondition = JSON.parse(row.precondition_json) as RayHotplugPrecondition
    for (const svc of precondition.requiredServices ?? []) {
      const dep = this.hostCtx.get(svc as never, false)
      if (dep === undefined) {
        return {
          ok: false,
          promoted: false,
          reason: `precondition-unmet: 缺少前置服务 ${svc}（[iff] ${precondition.iffNote ?? svc}）`,
        }
      }
    }

    const previousLive = this.liveFibers.get(slug)
    const pluginRow = db.prepare('SELECT * FROM ray_hotplug_plugins WHERE slug = ?').get(slug) as unknown as PluginRow | undefined
    const previousVersionForDb = previousLive?.version ?? pluginRow?.active_version ?? null
    const previousDigestForDb = previousLive?.artifactDigest ?? pluginRow?.active_artifact_digest ?? null

    if (previousLive !== undefined) {
      await previousLive.fiber.dispose()
      this.liveFibers.delete(slug)
    }

    const entryPath = join(row.artifact_dir, row.entry_file)
    const config = JSON.parse(row.config_json) as Record<string, unknown>
    let liveFiber: { state: number; dispose: () => Promise<void>; inertia?: Promise<void> } | undefined
    let mod: Record<string, unknown> | undefined

    try {
      const liveUrl = `${pathToFileURL(entryPath).href}?live=${encodeURIComponent(`${row.version}-${row.artifact_digest.slice(0, 12)}`)}`
      mod = await import(liveUrl) as Record<string, unknown>
      const pluginExport = mod.default ?? mod
      if (!isPlausibleCordisPlugin(pluginExport)) {
        throw new Error(`入口 ${row.entry_file} 未导出有效插件`)
      }

      liveFiber = this.hostCtx.plugin(pluginExport as never, config as never) as unknown as {
        state: number
        dispose: () => Promise<void>
        inertia?: Promise<void>
      }
      await settleFiber(liveFiber)
      if (liveFiber.state === FIBER_FAILED) {
        throw new Error(`活进程加载插件 ${slug}@${row.version} 失败（Fiber state=FAILED）`)
      }

      this.liveFibers.set(slug, {
        revisionId: row.revision_id,
        slug,
        version: row.version,
        kind: row.kind,
        entryFile: row.entry_file,
        artifactDir: row.artifact_dir,
        artifactDigest: row.artifact_digest,
        config,
        fiber: liveFiber,
      })

      if (typeof mod.verifyLive === 'function') {
        const res = normalizeProbeOutcome(await (mod.verifyLive as (c: Context) => unknown)(this.hostCtx))
        if (!res.ok) {
          throw new Error(`活进程观察探针未通过：${res.reason ?? 'verifyLive-failed'}`)
        }
      }
      if (typeof input.observationProbe === 'function') {
        const res = normalizeProbeOutcome(await input.observationProbe(this.hostCtx))
        if (!res.ok) {
          throw new Error(`观察期健康检查未通过：${res.reason ?? 'observation-probe-failed'}`)
        }
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      // Record failed attempt before rolling back live Fiber cleanly.
      const rollback = await this.rollbackRevisionToPrevious({
        slug,
        failedRevisionId: row.revision_id,
        failedVersion: row.version,
        previousVersion: previousVersionForDb,
        previousArtifactDigest: previousDigestForDb,
        reason: `观察期退化自动无重启回滚：${errMsg}`,
      })
      return {
        ok: false,
        promoted: false,
        rolledBack: true,
        ...(rollback.restoredVersion === undefined ? {} : { restoredVersion: rollback.restoredVersion }),
        reason: errMsg,
      }
    }

    const now = Date.now()
    const provenance: RayCapabilityProvenance = input.provenance ?? {
      origin: 'self',
      verificationDigest: row.verification_digest,
    }
    db.prepare(`
      UPDATE ray_hotplug_revisions SET status = 'observing', updated_at = ? WHERE revision_id = ?
    `).run(now, row.revision_id)
    if (previousVersionForDb !== null) {
      db.prepare(`
        UPDATE ray_hotplug_revisions
        SET status = 'active'
        WHERE slug = ? AND version = ? AND revision_id != ? AND status = 'observing'
      `).run(slug, previousVersionForDb, row.revision_id)
    }

    db.prepare(`
      INSERT INTO ray_hotplug_plugins (
        slug, kind, active_version, active_artifact_digest, previous_version, previous_artifact_digest,
        status, provenance_json, precondition_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'observing', ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        kind = excluded.kind,
        active_version = excluded.active_version,
        active_artifact_digest = excluded.active_artifact_digest,
        previous_version = excluded.previous_version,
        previous_artifact_digest = excluded.previous_artifact_digest,
        status = 'observing',
        provenance_json = excluded.provenance_json,
        precondition_json = excluded.precondition_json,
        updated_at = excluded.updated_at
    `).run(
      slug,
      row.kind,
      row.version,
      row.artifact_digest,
      previousVersionForDb,
      previousDigestForDb,
      JSON.stringify(provenance),
      row.precondition_json,
      now,
    )

    const capEntry: RayHomeCapabilityEntry = {
      kind: 'plugin',
      version: row.version,
      active: true,
      provenance,
    }
    this.raySelf.registerCapability(`plugin:${slug}`, capEntry)
    this.raySelf.recordAutobiography({
      kind: 'plugin-adopted',
      summary: `通过隔离 Trial 验证并热加载自创有状态插件 plugin:${slug}@${row.version}（零重启晋升观察期）。`,
      reason: input.reason?.trim() || `Stage 1 与活进程检查均通过（digest=${row.verification_digest.slice(0, 12)}）。`,
      targetRef: `plugin:${slug}`,
    })

    const updated = rowToRevision(
      db.prepare('SELECT * FROM ray_hotplug_revisions WHERE revision_id = ?').get(row.revision_id) as unknown as RevisionRow,
    )
    return { ok: true, promoted: true, revision: updated }
  }

  confirmObservedPlugin(slug: string): boolean {
    const db = this.assertOpen()
    const live = this.liveFibers.get(slug)
    if (live === undefined) return false
    const now = Date.now()
    db.prepare(`UPDATE ray_hotplug_revisions SET status = 'active', updated_at = ? WHERE revision_id = ?`).run(now, live.revisionId)
    db.prepare(`UPDATE ray_hotplug_plugins SET status = 'active', updated_at = ? WHERE slug = ?`).run(now, slug)
    return true
  }

  /** Stage 3: Live Cordis Fiber disposal rollback without Host restart, restoring prior immutable artifact when present. */
  async rollbackPluginLive(slug: string, reason = 'owner 或内核要求无重启回滚插件'): Promise<RayHotplugRollbackResult> {
    const db = this.assertOpen()
    const pluginRow = db.prepare('SELECT * FROM ray_hotplug_plugins WHERE slug = ?').get(slug) as unknown as PluginRow | undefined
    const live = this.liveFibers.get(slug)
    const activeVersion = live?.version ?? pluginRow?.active_version ?? undefined
    const activeRev = activeVersion
      ? db.prepare(`
          SELECT * FROM ray_hotplug_revisions
          WHERE slug = ? AND version = ? AND status IN ('observing', 'active')
          ORDER BY created_at DESC, rowid DESC LIMIT 1
        `).get(slug, activeVersion) as unknown as RevisionRow | undefined
      : undefined

    const res = await this.rollbackRevisionToPrevious({
      slug,
      ...(activeRev === undefined ? {} : { failedRevisionId: activeRev.revision_id }),
      ...(activeVersion === undefined ? {} : { failedVersion: activeVersion }),
      previousVersion: pluginRow?.previous_version ?? null,
      previousArtifactDigest: pluginRow?.previous_artifact_digest ?? null,
      reason,
    })
    return res
  }

  private async rollbackRevisionToPrevious(input: Readonly<{
    slug: string
    failedRevisionId?: string
    failedVersion?: string
    previousVersion: string | null
    previousArtifactDigest: string | null
    reason: string
  }>): Promise<RayHotplugRollbackResult> {
    const db = this.assertOpen()
    const now = Date.now()
    let disposed = false
    const currentLive = this.liveFibers.get(input.slug)
    if (currentLive !== undefined) {
      await currentLive.fiber.dispose()
      disposed = currentLive.fiber.state === FIBER_DISPOSED
      this.liveFibers.delete(input.slug)
    }

    if (input.failedRevisionId !== undefined) {
      db.prepare(`
        UPDATE ray_hotplug_revisions
        SET status = 'rolled_back', rollback_reason = ?, updated_at = ?
        WHERE revision_id = ?
      `).run(input.reason, now, input.failedRevisionId)
    }

    let restoredVersion: string | undefined
    if (input.previousVersion !== null && input.previousArtifactDigest !== null) {
      const prevRev = db.prepare(`
        SELECT * FROM ray_hotplug_revisions
        WHERE slug = ? AND version = ? AND artifact_digest = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      `).get(input.slug, input.previousVersion, input.previousArtifactDigest) as unknown as RevisionRow | undefined

      if (prevRev !== undefined) {
        const entryPath = join(prevRev.artifact_dir, prevRev.entry_file)
        const config = JSON.parse(prevRev.config_json) as Record<string, unknown>
        const restoreUrl = `${pathToFileURL(entryPath).href}?restore=${encodeURIComponent(`${prevRev.version}-${randomUUID()}`)}`
        const mod = await import(restoreUrl) as Record<string, unknown>
        const pluginExport = mod.default ?? mod
        const restoredFiber = this.hostCtx.plugin(pluginExport as never, config as never) as unknown as {
          state: number
          dispose: () => Promise<void>
          inertia?: Promise<void>
        }
        await settleFiber(restoredFiber)
        this.liveFibers.set(input.slug, {
          revisionId: prevRev.revision_id,
          slug: prevRev.slug,
          version: prevRev.version,
          kind: prevRev.kind,
          entryFile: prevRev.entry_file,
          artifactDir: prevRev.artifact_dir,
          artifactDigest: prevRev.artifact_digest,
          config,
          fiber: restoredFiber,
        })
        restoredVersion = prevRev.version
        db.prepare(`UPDATE ray_hotplug_revisions SET status = 'active', updated_at = ? WHERE revision_id = ?`).run(now, prevRev.revision_id)
        db.prepare(`
          UPDATE ray_hotplug_plugins
          SET active_version = ?, active_artifact_digest = ?, previous_version = NULL, previous_artifact_digest = NULL,
              status = 'active', updated_at = ?
          WHERE slug = ?
        `).run(prevRev.version, prevRev.artifact_digest, now, input.slug)
        this.raySelf.registerCapability(`plugin:${input.slug}`, {
          kind: 'plugin',
          version: prevRev.version,
          active: true,
          provenance: { origin: 'self', ...(prevRev.verification_digest ? { verificationDigest: prevRev.verification_digest } : {}) },
        })
      }
    }

    if (restoredVersion === undefined) {
      db.prepare(`
        UPDATE ray_hotplug_plugins
        SET active_version = NULL, active_artifact_digest = NULL, status = 'rolled_back', updated_at = ?
        WHERE slug = ?
      `).run(now, input.slug)
      const prevCap = this.raySelf.snapshot(0).manifest.capabilities[`plugin:${input.slug}`]
      this.raySelf.registerCapability(`plugin:${input.slug}`, {
        kind: 'plugin',
        version: input.failedVersion ?? prevCap?.version ?? '0.0.0',
        active: false,
        provenance: prevCap?.provenance ?? { origin: 'self' },
      })
    }

    this.raySelf.recordAutobiography({
      kind: 'rollback',
      summary: restoredVersion !== undefined
        ? `无重启释放 plugin:${input.slug}@${input.failedVersion ?? '?'} 作用域并回退至稳定版 ${restoredVersion}。`
        : `无重启释放 plugin:${input.slug}@${input.failedVersion ?? '?'} 作用域并停用该自创插件。`,
      reason: input.reason,
      targetRef: `plugin:${input.slug}`,
    })

    const proactive = this.hostCtx.get('assistantProactive' as never, false) as {
      rayRecordCandidateOutcome?: (entry: {
        candidateId: string
        kind: 'skill' | 'plugin' | 'tool' | 'repair'
        rootCause: string
        predictedImpact: string
        observedOutcome: string
        supplier: string
        disposition: 'adopted' | 'vetoed' | 'rolled_back' | 'rejected'
      }) => void
    } | undefined
    try {
      proactive?.rayRecordCandidateOutcome?.({
        candidateId: input.failedRevisionId ?? `plugin:${input.slug}@${input.failedVersion ?? 'unknown'}`,
        kind: 'plugin',
        rootCause: input.reason,
        predictedImpact: `热加载 plugin:${input.slug}@${input.failedVersion ?? 'unknown'}`,
        observedOutcome: restoredVersion ? `已无重启回退至 ${restoredVersion}` : '已无重启卸载停用',
        supplier: 'self-hotplug',
        disposition: 'rolled_back',
      })
    } catch { /* ignore */ }

    return {
      ok: true,
      slug: input.slug,
      ...(input.failedVersion === undefined ? {} : { disposedVersion: input.failedVersion }),
      ...(restoredVersion === undefined ? {} : { restoredVersion }),
      liveFiberDisposed: disposed,
      reason: input.reason,
    }
  }

  private async handleOwnerVeto(input: Readonly<{
    targetEntryId?: string
    targetCapabilityId?: string
    reason: string
  }>): Promise<boolean> {
    const cap = input.targetCapabilityId
    if (typeof cap !== 'string' || !cap.startsWith('plugin:')) return false
    const slug = cap.slice('plugin:'.length).trim()
    if (!slug) return false
    if (!this.liveFibers.has(slug) && this.getRevisions(slug).length === 0) return false
    const res = await this.rollbackPluginLive(slug, `Owner 一轮否决：${input.reason}`)
    return res.ok
  }

  private async verifyTaughtPluginArtifact(spec: unknown): Promise<{
    ok: boolean
    verificationDigest?: string
    reason?: string
  }> {
    if (spec === null || typeof spec !== 'object') {
      return { ok: false, reason: 'invalid-taught-plugin-spec' }
    }
    const rec = spec as {
      slug?: string
      version?: string
      kind?: RayStatefulPluginKind
      entryFile?: string
      files?: readonly RayHotplugPluginFile[]
      config?: Record<string, unknown>
    }
    if (typeof rec.slug !== 'string' || typeof rec.version !== 'string' || !Array.isArray(rec.files)) {
      return { ok: false, reason: 'incomplete-taught-plugin-spec' }
    }
    const trial = await this.stageAndTrialPlugin({
      slug: rec.slug,
      version: rec.version,
      kind: rec.kind ?? 'service',
      ...(rec.entryFile === undefined ? {} : { entryFile: rec.entryFile }),
      files: rec.files,
      ...(rec.config === undefined ? {} : { config: rec.config }),
      reason: '传授包对端 Stage 1 独立重验证',
    })
    return {
      ok: trial.ok,
      ...(trial.revision?.verificationDigest === undefined ? {} : { verificationDigest: trial.revision.verificationDigest }),
      ...(trial.reason === undefined ? {} : { reason: trial.reason }),
    }
  }

  private installTools(): void {
    try {
      const handle = this.hostCtx.inject(['tools'], (toolsCtx) => {
        const stageTrialTool = defineTool({
          name: 'ray_plugin_stage_trial',
          description: 'Stage a self-authored stateful plugin under <rayHome>/plugins and run isolated Stage 1 Cordis trial verification without modifying the live Host.',
          parameters: {
            slug: { type: 'string', required: true },
            version: { type: 'string', required: true },
            kind: { type: 'string', enum: ['service', 'channel', 'ui', 'tool'], required: true },
            entry_file: { type: 'string' },
            files_json: { type: 'string', required: true },
            required_services_json: { type: 'string' },
            reason: { type: 'string' },
          },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: {} },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: async (args, exec) => {
            if (!this.raySelf.isRayOwnedSession(exec.agent)) {
              throw new Error('ray_plugin_stage_trial requires an active non-subagent Ray session')
            }
            const parsedFiles = JSON.parse(args.files_json) as RayHotplugPluginFile[]
            const requiredServices = args.required_services_json
              ? JSON.parse(args.required_services_json) as string[]
              : undefined
            const res = await this.stageAndTrialPlugin({
              slug: args.slug,
              version: args.version,
              kind: args.kind as RayStatefulPluginKind,
              ...(args.entry_file === undefined ? {} : { entryFile: args.entry_file }),
              files: parsedFiles,
              ...(requiredServices === undefined ? {} : { precondition: { requiredServices } }),
              ...(args.reason === undefined ? {} : { reason: args.reason }),
            })
            return JSON.parse(JSON.stringify(res)) as Record<string, never>
          },
        })

        const promoteTool = defineTool({
          name: 'ray_plugin_promote',
          description: 'Hot-load a Stage 1 trial-verified self-authored plugin into the live Cordis Host without restart, automatically rolling back via Fiber disposal if live observation fails.',
          parameters: {
            slug: { type: 'string', required: true },
            version: { type: 'string' },
            reason: { type: 'string' },
          },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: {} },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: async (args, exec) => {
            if (!this.raySelf.isRayOwnedSession(exec.agent)) {
              throw new Error('ray_plugin_promote requires an active non-subagent Ray session')
            }
            const res = await this.promotePluginLive({
              slug: args.slug,
              ...(args.version === undefined ? {} : { version: args.version }),
              ...(args.reason === undefined ? {} : { reason: args.reason }),
            })
            return JSON.parse(JSON.stringify(res)) as Record<string, never>
          },
        })

        const rollbackTool = defineTool({
          name: 'ray_plugin_rollback',
          description: 'Dispose a live self-authored plugin Cordis Fiber without Host restart and restore the previous verified immutable version.',
          parameters: {
            slug: { type: 'string', required: true },
            reason: { type: 'string' },
          },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: {} },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: async (args, exec) => {
            if (!this.raySelf.isRayOwnedSession(exec.agent)) {
              throw new Error('ray_plugin_rollback requires an active non-subagent Ray session')
            }
            const res = await this.rollbackPluginLive(args.slug, args.reason)
            return JSON.parse(JSON.stringify(res)) as Record<string, never>
          },
        })

        const listTool = defineTool({
          name: 'ray_plugin_list',
          description: 'List staged, observing, active, and rolled-back self-authored Ray hot-pluggable plugins.',
          parameters: {
            slug: { type: 'string' },
          },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: {} },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: async (args, exec) => {
            if (!this.raySelf.isRayOwnedSession(exec.agent)) {
              throw new Error('ray_plugin_list requires an active non-subagent Ray session')
            }
            return JSON.parse(JSON.stringify({
              plugins: this.listPlugins(),
              ...(args.slug ? { revisions: this.getRevisions(args.slug) } : {}),
            })) as Record<string, never>
          },
        })

        const when = (activation: { agent?: unknown }) => this.raySelf.isRayOwnedSession(activation.agent)
        const authorize = (exec: ToolExecution) => this.raySelf.isRayOwnedSession(exec.agent)
        const registered: Array<() => void> = []
        for (const def of [stageTrialTool, promoteTool, rollbackTool, listTool]) {
          registered.push(toolsCtx.tools.register(def, { when }))
          registered.push(this.policy.registerPreauthorizedTool(
            this.callerCtx,
            def as unknown as ReturnType<typeof defineTool>,
            authorize,
            { denialReason: 'plugin-control-plane: Ray hotplug tool requires an active non-subagent Ray session' },
          ))
        }
        const cleanup = () => {
          for (const d of registered.splice(0).reverse()) {
            try { d() } catch { /* ignore */ }
          }
        }
        toolsCtx.effect?.(() => cleanup)
        return cleanup
      })
      if (typeof (handle as { dispose?: unknown })?.dispose === 'function') {
        this.disposers.push(() => { void (handle as { dispose: () => unknown }).dispose() })
      }
    } catch {
      // Ignore when Host context lacks tools service.
    }
  }
}

/** Lightweight Cordis service wrapper so Ray Hosts without full control-plane trust.json still enable P5 staged hotplug. */
export class RayStatefulHotplugService extends Service {
  static inject = ['assistantPolicy']
  private runtime: RayStatefulHotplugRuntime | undefined
  private readonly readyPromise: Promise<void>

  constructor(ctx: Context) {
    super(ctx, 'rayHotplug' as never)
    const policy = ctx.get('assistantPolicy' as never) as AssistantPolicyService | undefined
    const raySelf = policy?.raySelf
    if (policy !== undefined && raySelf !== undefined) {
      let stopped = false
      const init = async () => {
        await raySelf.whenReady()
        if (stopped) return
        this.runtime = new RayStatefulHotplugRuntime({
          hostCtx: ctx,
          callerCtx: this.ctx,
          policy,
          raySelf,
        })
      }
      this.readyPromise = init()
      ctx.effect(() => {
        return async () => {
          stopped = true
          await this.runtime?.close()
          this.runtime = undefined
        }
      }, 'dsh-ray-stateful-hotplug.runtime')
    } else {
      this.readyPromise = Promise.resolve()
    }
  }

  whenReady(): Promise<void> {
    return this.readyPromise
  }

  getRuntime(): RayStatefulHotplugRuntime | undefined {
    return this.runtime
  }
}
