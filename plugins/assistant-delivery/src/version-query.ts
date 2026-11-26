import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { version as assistantVersion } from './version.js'

export interface AssistantVersionPluginEntry {
  readonly name: string
  readonly version: string | null
  readonly kind: 'core' | 'evolved'
  readonly installKind?: 'npm' | 'local' | 'adopted'
  readonly enabled?: boolean
}

export interface AssistantVersionReport {
  readonly schemaVersion: 1
  readonly protocol: 'dsh-ray/version/v1'
  readonly generatedAt: number
  readonly dshHome?: string | null
  readonly assistant: {
    readonly name: 'dsh-ray'
    readonly version: string
    readonly cliVersion?: string
  }
  readonly host: {
    readonly packageName: '@deepseek-ai/dsh'
    readonly boundVersion: string | null
    readonly boundStatus: string
    readonly runningVersion: string | null
  }
  readonly profile?: string | null
  readonly profiles?: readonly string[]
  readonly plugins: {
    readonly state: 'ok' | 'zero' | 'unavailable'
    readonly coreCount: number
    readonly evolvedCount: number
    readonly activeEvolvedCount: number
    readonly core: readonly AssistantVersionPluginEntry[]
    readonly evolved: readonly AssistantVersionPluginEntry[]
  }
  readonly selfIteration: {
    readonly dataState: 'no-data' | 'zero' | 'data'
    readonly totalIterations: number | null
    readonly workItemsTotal: number | null
    readonly workItemsSettled: number | null
    readonly growthUsageJobsTotal: number | null
    readonly dreamingRuns: number | null
    readonly recoveryRuns: number | null
    readonly goalStrategyRuns: number | null
    readonly candidatesGenerated: number | null
    readonly candidatesAdopted: number | null
    readonly pluginsCreated: number | null
    readonly pluginsRevised: number | null
    readonly taskVerificationsDone: number | null
    readonly rollbacks: number | null
    readonly evolutionRulesAdopted: number | null
    readonly associationParamVersion: number | null
    readonly associationProfileAdoptions: number | null
    readonly evaluationAttentionTuningAdoptions: number | null
    readonly evaluationLooseningDecisionsAdopted: number | null
    readonly activeMemories: number | null
    readonly activePreferenceOverlays: number | null
    readonly workflowCandidatesPromoted: number | null
    readonly skillDeployments: number | null
    readonly selfUpgrades: number | null
    readonly backupSnapshotsCount: number | null
  }
  readonly extensions?: Readonly<Record<string, unknown>>
  readonly inspectedLedgers?: readonly string[]
  readonly diagnostics?: readonly string[]
}

export interface CollectDeliveryVersionReportOptions {
  readonly ctx: Context
  readonly dshHome?: string
  readonly profile?: string
  readonly configDatabasePath?: string
  readonly inProcessProfilePath?: string
  readonly now?: number
  readonly extraDiagnostics?: readonly string[]
}

interface ResolvedBoundary {
  readonly dshHome: string | null
  readonly canonicalDshHome: string | null
  readonly homeUnsafe: boolean
  readonly profile: string | null
  readonly profiles: readonly string[]
}

interface LoaderEntryLike {
  readonly id?: unknown
  readonly disabled?: unknown
  readonly options?: {
    readonly id?: unknown
    readonly name?: unknown
    readonly config?: unknown
    readonly disabled?: unknown
    readonly path?: unknown
  }
  readonly fiber?: {
    readonly config?: unknown
  }
  readonly subtree?: {
    readonly filename?: unknown
  }
}

interface LoaderLike {
  entries?(): Iterable<LoaderEntryLike>
  resolve?(name: string): unknown
}

interface BundleInfoLike {
  readonly name?: unknown
  readonly version?: unknown
  readonly enabled?: unknown
  readonly error?: { readonly code?: unknown }
}

interface PluginManagerLike {
  listBundles?(): Promise<readonly BundleInfoLike[]>
}

const MAX_HOST_METADATA_BYTES = 16 * 1024
const MAX_PACKAGE_JSON_BYTES = 64 * 1024
const MAX_UPGRADE_HISTORY_BYTES = 4 * 1024 * 1024
const MAX_PATCH_SCAN_BYTES = 512 * 1024

type LedgerFamily =
  | 'workItems'
  | 'growthDriver'
  | 'dreaming'
  | 'recovery'
  | 'goals'
  | 'memoryLearning'
  | 'memory'
  | 'preference'
  | 'evolution'
  | 'skills'
  | 'growthExperiments'
  | 'association'
  | 'evaluation'
  | 'verifier'
  | 'controlPlane'

type PatchDbMap = Record<LedgerFamily, Set<string>>

interface PatchPluginState {
  disabled: boolean
  configEnabled: boolean | undefined
}

function normalizePluginKey(name: string): string {
  const trimmed = name.trim()
  return trimmed.startsWith('@dsh-ray/') ? trimmed.slice('@dsh-ray/'.length) : trimmed
}

function rec(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function nonNegIntOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.trunc(value)
}

function truncateText(raw: string, maxLen: number): string {
  if (raw.length <= maxLen) return raw
  if (maxLen <= 1) return raw.slice(0, maxLen)
  let cut = maxLen - 1
  const lastCode = raw.charCodeAt(cut - 1)
  if (lastCode >= 0xd800 && lastCode <= 0xdbff && cut > 1) {
    cut -= 1
  }
  return `${raw.slice(0, cut)}…`
}

function boundNonEmptyString(raw: unknown, maxLen: number): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  return truncateText(trimmed, maxLen)
}

function cleanAbsolutePath(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.includes('\0') || !isAbsolute(trimmed)) return undefined
  return resolve(trimmed)
}

function filePathFromUriOrPath(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.includes('\0')) return undefined
  if (trimmed.startsWith('file://')) {
    try {
      return cleanAbsolutePath(new URL(trimmed).pathname)
    } catch {
      return undefined
    }
  }
  return cleanAbsolutePath(trimmed)
}

function extractHomeAndProfileFromProfileFile(profileFile: string): {
  home?: string
  profile?: string
} {
  const parent = dirname(profileFile)
  const grandParent = dirname(parent)
  if (basename(parent) === 'profiles') {
    const stem = basename(profileFile, extname(profileFile))
    return {
      home: grandParent,
      ...(stem === '' ? {} : { profile: stem }),
    }
  }
  if (basename(grandParent) === 'profiles') {
    const profileName = basename(parent)
    return {
      home: dirname(grandParent),
      ...(profileName === '' ? {} : { profile: profileName }),
    }
  }
  return {}
}

function resolveIncludeProfilePath(loader: LoaderLike | undefined): string | undefined {
  if (typeof loader?.resolve !== 'function') return undefined
  try {
    const includeEntry = loader.resolve('include') as LoaderEntryLike | undefined
    if (!includeEntry || typeof includeEntry !== 'object') return undefined
    const treePath = filePathFromUriOrPath(includeEntry.subtree?.filename)
    if (treePath) return treePath
    const cfgPath = filePathFromUriOrPath(rec(includeEntry.options?.config)['path'])
    if (cfgPath) return cfgPath
  } catch {
    return undefined
  }
  return undefined
}

function safeListProfiles(dshHome: string, canonicalDshHome: string): string[] {
  const profilesDir = join(dshHome, 'profiles')
  if (!existsSync(profilesDir)) return []
  try {
    const st = lstatSync(profilesDir)
    if (!st.isDirectory() || st.isSymbolicLink()) return []
    const realDir = realpathSync(profilesDir)
    if (realDir !== canonicalDshHome && !realDir.startsWith(`${canonicalDshHome}${sep}`)) return []
    const names = new Set<string>()
    for (const entry of readdirSync(realDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        names.add(entry.name)
      } else if (entry.isFile() && (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml'))) {
        const stem = basename(entry.name, extname(entry.name))
        if (stem !== '') names.add(stem)
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

function resolveBoundary(
  ctx: Context,
  options: Omit<CollectDeliveryVersionReportOptions, 'ctx'>,
  diagnostics: string[],
): ResolvedBoundary {
  const profileContext = ctx.get('profileContext' as never) as
    | { readonly home?: unknown; readonly dir?: unknown; readonly name?: unknown }
    | undefined
  const settings = ctx.get('settings' as never) as { readonly documentPath?: unknown } | undefined
  const loader = ctx.get('loader' as never) as LoaderLike | undefined

  const includeProfileFile = resolveIncludeProfilePath(loader)
  const includeDerived = includeProfileFile ? extractHomeAndProfileFromProfileFile(includeProfileFile) : {}
  const inProcessProfile = cleanAbsolutePath(options.inProcessProfilePath)
  const inProcessDerived = inProcessProfile ? extractHomeAndProfileFromProfileFile(inProcessProfile) : {}

  let dshHome = cleanAbsolutePath(options.dshHome)
    ?? cleanAbsolutePath(profileContext?.home)

  if (!dshHome) {
    const profileDir = cleanAbsolutePath(profileContext?.dir)
    if (profileDir && basename(dirname(profileDir)) === 'profiles') {
      dshHome = dirname(dirname(profileDir))
    }
  }
  if (!dshHome) {
    const docPath = cleanAbsolutePath(settings?.documentPath)
    if (docPath) {
      if (basename(dirname(docPath)) === 'profiles') {
        dshHome = dirname(dirname(docPath))
      } else if (basename(dirname(dirname(docPath))) === 'profiles') {
        dshHome = dirname(dirname(dirname(docPath)))
      } else {
        dshHome = dirname(docPath)
      }
    }
  }
  if (!dshHome && includeDerived.home) {
    dshHome = includeDerived.home
  }
  if (!dshHome && inProcessDerived.home) {
    dshHome = inProcessDerived.home
  }
  if (!dshHome) {
    const dbPath = cleanAbsolutePath(options.configDatabasePath)
    if (dbPath && basename(dirname(dbPath)) === 'assistant-delivery') {
      dshHome = dirname(dirname(dbPath))
    }
  }
  if (!dshHome) {
    dshHome = cleanAbsolutePath(process.env['DSH_HOME'])
  }

  let profile = textOrNull(options.profile)
    ?? textOrNull(profileContext?.name)
    ?? null
  if (!profile) {
    const profileDir = cleanAbsolutePath(profileContext?.dir)
    if (profileDir && basename(dirname(profileDir)) === 'profiles') {
      profile = basename(profileDir)
    }
  }
  if (!profile && includeDerived.profile) {
    profile = includeDerived.profile
  }
  if (!profile && inProcessDerived.profile) {
    profile = inProcessDerived.profile
  }
  if (!profile) {
    profile = textOrNull(process.env['DSH_PROFILE'])
  }

  if (!dshHome) {
    return {
      dshHome: null,
      canonicalDshHome: null,
      homeUnsafe: false,
      profile,
      profiles: [],
    }
  }

  let canonicalDshHome: string | null = null
  let homeUnsafe = false
  if (existsSync(dshHome)) {
    try {
      const st = lstatSync(dshHome)
      if (!st.isDirectory() || st.isSymbolicLink()) {
        homeUnsafe = true
        diagnostics.push('dshHome is not a regular directory')
      } else {
        canonicalDshHome = realpathSync(dshHome)
      }
    } catch (error) {
      homeUnsafe = true
      diagnostics.push(`dshHome inspection failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const profiles = canonicalDshHome && !homeUnsafe
    ? safeListProfiles(dshHome, canonicalDshHome)
    : []

  return {
    dshHome,
    canonicalDshHome,
    homeUnsafe,
    profile,
    profiles,
  }
}

function readBoundedRegularFile(
  filePath: string,
  boundary: ResolvedBoundary,
  maxBytes: number,
): string | undefined {
  if (!boundary.dshHome || !boundary.canonicalDshHome || boundary.homeUnsafe) return undefined
  if (!existsSync(filePath)) return undefined
  const target = resolve(filePath)
  try {
    const st = lstatSync(target)
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) return undefined
    if (st.size < 0 || st.size > maxBytes) return undefined
    const realTarget = realpathSync(target)
    const logicallyWithin = target.startsWith(`${boundary.dshHome}${sep}`)
      || target.startsWith(`${boundary.canonicalDshHome}${sep}`)
    if (!logicallyWithin || !realTarget.startsWith(`${boundary.canonicalDshHome}${sep}`)) {
      return undefined
    }
    return readFileSync(realTarget, 'utf8')
  } catch {
    return undefined
  }
}

function readBoundHostMetadata(
  boundary: ResolvedBoundary,
): { boundVersion: string | null; boundStatus: string } {
  if (!boundary.dshHome || !boundary.canonicalDshHome || boundary.homeUnsafe) {
    return { boundVersion: null, boundStatus: boundary.homeUnsafe ? 'unreadable' : 'missing' }
  }
  const filePath = join(boundary.canonicalDshHome, '.dsh-ray-host.json')
  if (!existsSync(filePath)) return { boundVersion: null, boundStatus: 'missing' }
  try {
    const st = lstatSync(filePath)
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) {
      return { boundVersion: null, boundStatus: 'corrupt' }
    }
    if (st.size <= 0 || st.size > MAX_HOST_METADATA_BYTES) {
      return { boundVersion: null, boundStatus: 'corrupt' }
    }
    const realTarget = realpathSync(filePath)
    if (!realTarget.startsWith(`${boundary.canonicalDshHome}${sep}`)) {
      return { boundVersion: null, boundStatus: 'corrupt' }
    }
    const parsed = JSON.parse(readFileSync(realTarget, 'utf8')) as unknown
    const obj = rec(parsed)
    if (obj['schemaVersion'] !== 1) {
      return { boundVersion: null, boundStatus: 'corrupt' }
    }
    const version = textOrNull(obj['version'])
    if (version === null) {
      return { boundVersion: null, boundStatus: 'corrupt' }
    }
    return { boundVersion: version, boundStatus: 'ready' }
  } catch (error) {
    if (error instanceof SyntaxError) return { boundVersion: null, boundStatus: 'corrupt' }
    return { boundVersion: null, boundStatus: 'unreadable' }
  }
}

function readRunningHostVersion(): string | null {
  try {
    const req = createRequire(import.meta.url)
    for (const candidate of ['@deepseek-ai/dsh/package.json', '@deepseek-ai/dsh-app-boot/package.json']) {
      try {
        const resolved = req.resolve(candidate)
        const parsed = JSON.parse(readFileSync(resolved, 'utf8')) as { name?: unknown; version?: unknown }
        if (parsed.name === '@deepseek-ai/dsh') {
          const ver = textOrNull(parsed.version)
          if (ver !== null) return ver
        }
      } catch {
        // Optional runtime layout lookup.
      }
    }
  } catch {
    // Fallback below.
  }
  const entry = process.argv[1]
  if (typeof entry === 'string' && entry.trim() !== '') {
    let dir = dirname(resolve(entry))
    for (let i = 0; i < 6; i++) {
      const pkgPath = join(dir, 'package.json')
      try {
        if (existsSync(pkgPath)) {
          const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown; version?: unknown }
          if (parsed.name === '@deepseek-ai/dsh') {
            const ver = textOrNull(parsed.version)
            if (ver !== null) return ver
          }
        }
      } catch {
        // Continue walk-up.
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return null
}

function hasTable(db: DatabaseSync, tableName: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(tableName) !== undefined
}

function hasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  if (!hasTable(db, tableName)) return false
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>
  return cols.some(col => col.name === columnName)
}

function countQuery(db: DatabaseSync, sql: string, ...params: Array<string | number>): number {
  const row = db.prepare(sql).get(...params) as { n?: unknown } | undefined
  return nonNegIntOrNull(row?.n) ?? 0
}

function isAbsentOrZeroRegularFile(sidecarPath: string): boolean {
  try {
    const st = lstatSync(sidecarPath)
    return st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size === 0
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

function isAbsentFile(sidecarPath: string): boolean {
  try {
    lstatSync(sidecarPath)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

function isAbsentOrRegularFile(sidecarPath: string): boolean {
  try {
    const st = lstatSync(sidecarPath)
    return st.isFile() && !st.isSymbolicLink() && st.nlink === 1
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

function canPreferImmutable(realTarget: string): boolean {
  return isAbsentOrZeroRegularFile(`${realTarget}-wal`) && isAbsentFile(`${realTarget}-shm`)
}

function canFallbackImmutable(realTarget: string): boolean {
  return isAbsentOrZeroRegularFile(`${realTarget}-wal`) && isAbsentOrRegularFile(`${realTarget}-shm`)
}

function tryOpenReadOnlySqlite(
  openTarget: string,
): { ok: true; db: DatabaseSync } | { ok: false; integrityFailed: boolean; error?: unknown } {
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(openTarget, { readOnly: true })
    const check = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined
    if (!check || Object.values(check)[0] !== 'ok') {
      db.close()
      return { ok: false, integrityFailed: true }
    }
    return { ok: true, db }
  } catch (error) {
    if (db) {
      try { db.close() } catch { /* ignore */ }
    }
    return { ok: false, integrityFailed: false, error }
  }
}

function withReadOnlySqlite<T>(
  dbPath: string,
  boundary: ResolvedBoundary,
  seenRealPaths: Set<string>,
  inspectedLedgers: string[],
  diagnostics: string[],
  fn: (db: DatabaseSync, realPath: string) => T,
): T | undefined {
  if (!boundary.dshHome || !boundary.canonicalDshHome || boundary.homeUnsafe) return undefined
  const target = resolve(dbPath)
  let realTarget: string
  try {
    let st
    try {
      st = lstatSync(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (!st.isFile() || st.isSymbolicLink()) {
      diagnostics.push(`skipped non-regular or symlink sqlite ledger: ${basename(target)}`)
      return undefined
    }
    if (st.nlink !== 1) {
      diagnostics.push(`skipped hardlink sqlite ledger: ${basename(target)}`)
      return undefined
    }
    realTarget = realpathSync(target)
    const logicallyWithin = target.startsWith(`${boundary.dshHome}${sep}`)
      || target.startsWith(`${boundary.canonicalDshHome}${sep}`)
    if (!logicallyWithin || !realTarget.startsWith(`${boundary.canonicalDshHome}${sep}`)) {
      diagnostics.push(`skipped out-of-boundary sqlite ledger: ${basename(target)}`)
      return undefined
    }
  } catch {
    return undefined
  }
  if (seenRealPaths.has(realTarget)) return undefined
  seenRealPaths.add(realTarget)

  if (!isAbsentOrRegularFile(`${realTarget}-wal`) || !isAbsentOrRegularFile(`${realTarget}-shm`)) {
    diagnostics.push(`skipped unsafe sqlite sidecar: ${realTarget}`)
    return undefined
  }

  const immutableUri = pathToFileURL(realTarget)
  immutableUri.search = 'mode=ro&immutable=1'

  let db: DatabaseSync | undefined
  if (canPreferImmutable(realTarget)) {
    const immutableRes = tryOpenReadOnlySqlite(immutableUri.href)
    if (immutableRes.ok) {
      db = immutableRes.db
    } else if (immutableRes.integrityFailed) {
      diagnostics.push(`sqlite quick_check failed: ${realTarget}`)
      return undefined
    } else {
      const plainRes = tryOpenReadOnlySqlite(realTarget)
      if (plainRes.ok) {
        db = plainRes.db
      } else if (plainRes.integrityFailed) {
        diagnostics.push(`sqlite quick_check failed: ${realTarget}`)
        return undefined
      } else {
        const err = plainRes.error ?? immutableRes.error
        diagnostics.push(
          `sqlite read failed (${realTarget}): ${err instanceof Error ? err.message : String(err)}`,
        )
        return undefined
      }
    }
  } else {
    const primaryRes = tryOpenReadOnlySqlite(realTarget)
    if (primaryRes.ok) {
      db = primaryRes.db
    } else if (primaryRes.integrityFailed) {
      diagnostics.push(`sqlite quick_check failed: ${realTarget}`)
      return undefined
    } else if (canFallbackImmutable(realTarget)) {
      const immutableRes = tryOpenReadOnlySqlite(immutableUri.href)
      if (immutableRes.ok) {
        db = immutableRes.db
      } else if (immutableRes.integrityFailed) {
        diagnostics.push(`sqlite quick_check failed: ${realTarget}`)
        return undefined
      } else {
        const err = immutableRes.error ?? primaryRes.error
        diagnostics.push(
          `sqlite read failed (${realTarget}): ${err instanceof Error ? err.message : String(err)}`,
        )
        return undefined
      }
    } else {
      diagnostics.push(
        `sqlite read failed (${realTarget}): ${primaryRes.error instanceof Error ? primaryRes.error.message : String(primaryRes.error)}`,
      )
      return undefined
    }
  }

  try {
    inspectedLedgers.push(realTarget)
    return fn(db, realTarget)
  } catch (error) {
    diagnostics.push(
      `sqlite read failed (${realTarget}): `
      + (error instanceof Error ? error.message : String(error)),
    )
    return undefined
  } finally {
    try {
      db.close()
    } catch {
      // Ignore close failures on read-only handles.
    }
  }
}

function parseDshHomePathArgs(rawArgs: string): string[] | undefined {
  const segments: string[] = []
  let remainder = rawArgs.trim()
  while (remainder.length > 0) {
    const match = /^(?:'([^'\r\n]+)'|"([^"\r\n]+)")\s*(?:,\s*(.*))?$/u.exec(remainder)
    if (!match) return undefined
    const seg = match[1] ?? match[2]
    if (!seg || seg.includes('\0')) return undefined
    segments.push(seg)
    remainder = (match[3] ?? '').trim()
  }
  return segments.length > 0 ? segments : undefined
}

function isWithinDshHome(resolvedPath: string, dshHome: string, canonicalHome: string | null): boolean {
  const canon = canonicalHome ?? dshHome
  return resolvedPath === dshHome
    || resolvedPath.startsWith(`${dshHome}${sep}`)
    || resolvedPath === canon
    || resolvedPath.startsWith(`${canon}${sep}`)
}

function resolvePathExpr(
  rawValue: unknown,
  dshHome: string,
  canonicalHome: string | null = null,
  diagnostics?: string[],
): string | undefined {
  let trimmed: string | undefined
  if (typeof rawValue === 'string') {
    trimmed = rawValue.trim()
  } else if (typeof rawValue === 'object' && rawValue !== null && '__jsExpr' in rawValue) {
    const rawExpr = (rawValue as { __jsExpr?: unknown }).__jsExpr
    if (typeof rawExpr !== 'string') return undefined
    trimmed = rawExpr.trim()
  } else {
    return undefined
  }
  if (!trimmed || trimmed === ':memory:' || trimmed.includes('\0')) return undefined
  const jsMatch = /^(?:(?:!!js|!js)\s+)?dshHomePath\(\s*([\s\S]+?)\s*\)$/u.exec(trimmed)
  if (jsMatch?.[1] !== undefined) {
    const args = parseDshHomePathArgs(jsMatch[1])
    if (!args) {
      diagnostics?.push(`skipped unparseable dshHomePath ledger path: ${trimmed}`)
      return undefined
    }
    const resolved = resolve(dshHome, ...args)
    if (!isWithinDshHome(resolved, dshHome, canonicalHome)) {
      diagnostics?.push(`skipped out-of-bounds dshHomePath ledger path: ${trimmed}`)
      return undefined
    }
    return resolved
  }
  if (isAbsolute(trimmed)) {
    const resolved = resolve(trimmed)
    if (!isWithinDshHome(resolved, dshHome, canonicalHome)) {
      diagnostics?.push(`skipped out-of-bounds ledger path: ${trimmed}`)
      return undefined
    }
    return resolved
  }
  return undefined
}

function classifyPluginFamily(idOrName: string): LedgerFamily | undefined {
  if (idOrName.includes('assistant-work-items') || idOrName.endsWith('/assistant-work-items')) return 'workItems'
  if (idOrName.includes('assistant-growth-driver') || idOrName.endsWith('/assistant-growth-driver')) return 'growthDriver'
  if (idOrName.includes('assistant-dreaming') || idOrName.endsWith('/assistant-dreaming')) return 'dreaming'
  if (idOrName.includes('assistant-recovery') || idOrName.endsWith('/assistant-recovery')) return 'recovery'
  if (idOrName.includes('assistant-goals') || idOrName.endsWith('/assistant-goals')) return 'goals'
  if (idOrName.includes('assistant-memory-learning') || idOrName.endsWith('/assistant-memory-learning')) return 'memoryLearning'
  if (idOrName.includes('personal-memory') || idOrName.endsWith('/personal-memory')) return 'memory'
  if (idOrName.includes('preference-learning') || idOrName.endsWith('/preference-learning')) return 'preference'
  if (idOrName.includes('assistant-evolution') || idOrName.endsWith('/assistant-evolution')) return 'evolution'
  if (idOrName.includes('assistant-skills') || idOrName.endsWith('/assistant-skills')) return 'skills'
  if (idOrName.includes('assistant-growth-experiments') || idOrName.endsWith('/assistant-growth-experiments')) return 'growthExperiments'
  if (idOrName.includes('assistant-association') || idOrName.endsWith('/assistant-association')) return 'association'
  if (idOrName.includes('assistant-evaluation') || idOrName.endsWith('/assistant-evaluation')) return 'evaluation'
  if (idOrName.includes('assistant-verifier') || idOrName.endsWith('/assistant-verifier')) return 'verifier'
  if (idOrName.includes('plugin-control-plane') || idOrName.endsWith('/plugin-control-plane')) return 'controlPlane'
  return undefined
}

function addVerifierVariants(set: Set<string>, basePath: string): void {
  set.add(basePath)
  set.add(`${basePath}.creation-reviews`)
  set.add(`${basePath}.source-reviews`)
  set.add(`${basePath}.memory-reviews`)
  set.add(`${basePath}.revision-reviews`)
  set.add(`${basePath}.revision-regressions`)
}

function normalizePluginPackageName(id: string, name: string): string | undefined {
  if (name.startsWith('@dsh-ray/')) return name
  if (id.startsWith('dsh-ray-')) return `@dsh-ray/${id.slice('dsh-ray-'.length)}`
  return undefined
}

function stripYamlCommentAndQuotes(raw: string): string {
  let out = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!
    if (quote !== null) {
      if (ch === '\\' && quote === '"' && i + 1 < raw.length) {
        out += raw[i + 1]!
        i += 1
        continue
      }
      if (ch === quote) {
        quote = null
      }
      out += ch
    } else {
      if (ch === '"' || ch === "'") {
        quote = ch
        out += ch
      } else if (ch === '#' && (i === 0 || /\s/u.test(raw[i - 1]!))) {
        break
      } else {
        out += ch
      }
    }
  }
  const trimmed = out.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)
    || (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function collectPatchDbPaths(
  patchPath: string,
  boundary: ResolvedBoundary,
  into: PatchDbMap,
  patchStates: Map<string, PatchPluginState> | undefined,
  diagnostics: string[],
): void {
  if (!boundary.dshHome || !boundary.canonicalDshHome || boundary.homeUnsafe) return
  let st
  try {
    st = lstatSync(patchPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    diagnostics.push(`failed to stat config ${patchPath}: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) {
    diagnostics.push(`skipped non-regular, symlink, or hardlink config: ${patchPath}`)
    return
  }
  if (st.size < 0 || st.size > MAX_PATCH_SCAN_BYTES) return
  let realPatch: string
  try {
    realPatch = realpathSync(patchPath)
  } catch {
    diagnostics.push(`skipped unresolvable config: ${patchPath}`)
    return
  }
  const resolvedPatch = resolve(patchPath)
  const logicallyWithin = resolvedPatch.startsWith(`${boundary.dshHome}${sep}`)
    || resolvedPatch.startsWith(`${boundary.canonicalDshHome}${sep}`)
  if (!logicallyWithin || !realPatch.startsWith(`${boundary.canonicalDshHome}${sep}`)) {
    diagnostics.push(`skipped out-of-bounds config: ${patchPath}`)
    return
  }
  let source: string
  try {
    source = readFileSync(realPatch, 'utf8')
  } catch (error) {
    diagnostics.push(`failed to read config ${patchPath}: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  interface ParsedRow {
    id: string
    name: string
    disabled: boolean
    configEnabled: boolean | undefined
    databasePath?: string
    statePath?: string
    usageDatabasePath?: string
    personalMemoryDatabasePath?: string
  }

  let current: ParsedRow | undefined
  let itemIndent = -1
  let section: 'item' | 'config' | 'usageLearning' | 'personalMemory' = 'item'
  let configIndent = -1
  let subIndent = -1

  const flush = () => {
    if (!current) return
    const row = current
    current = undefined
    const pkgName = normalizePluginPackageName(row.id, row.name)
    if (pkgName && patchStates) {
      patchStates.set(pkgName, {
        disabled: row.disabled,
        configEnabled: row.configEnabled,
      })
    }
    const fam = classifyPluginFamily(row.id) ?? classifyPluginFamily(row.name)
    if (fam) {
      if (fam === 'growthDriver') {
        const usagePath = resolvePathExpr(row.usageDatabasePath, boundary.dshHome!, boundary.canonicalDshHome, diagnostics)
        if (usagePath) into.growthDriver.add(usagePath)
        const dbPath = resolvePathExpr(row.databasePath, boundary.dshHome!, boundary.canonicalDshHome, diagnostics)
        if (dbPath) into.growthDriver.add(dbPath)
      } else if (fam === 'controlPlane') {
        const dbPath = resolvePathExpr(row.databasePath, boundary.dshHome!, boundary.canonicalDshHome, diagnostics)
        if (dbPath) into.controlPlane.add(dbPath)
        const stateDir = resolvePathExpr(row.statePath, boundary.dshHome!, boundary.canonicalDshHome, diagnostics)
        if (stateDir) {
          into.controlPlane.add(join(stateDir, 'control.sqlite'))
          into.controlPlane.add(join(stateDir, 'creation-adoptions.sqlite'))
          into.controlPlane.add(join(stateDir, 'revision-adoptions.sqlite'))
        }
      } else if (fam === 'goals') {
        const dbPath = resolvePathExpr(row.databasePath, boundary.dshHome!, boundary.canonicalDshHome, diagnostics)
        if (dbPath) {
          into.goals.add(`${dbPath}.strategies`)
          into.goals.add(dbPath)
        }
      } else if (fam === 'verifier') {
        const dbPath = resolvePathExpr(row.databasePath, boundary.dshHome!, boundary.canonicalDshHome, diagnostics)
        if (dbPath) addVerifierVariants(into.verifier, dbPath)
      } else {
        const dbPath = resolvePathExpr(row.databasePath, boundary.dshHome!, boundary.canonicalDshHome, diagnostics)
        if (dbPath) into[fam].add(dbPath)
      }
    }
    if (row.id.includes('personal-assistant') || row.name.endsWith('/personal-assistant')) {
      const pmPath = resolvePathExpr(row.personalMemoryDatabasePath, boundary.dshHome!, boundary.canonicalDshHome, diagnostics)
      if (pmPath) into.memory.add(pmPath)
    }
  }

  for (const rawLine of source.split(/\r?\n/u)) {
    const trimmedRight = rawLine.trimEnd()
    if (trimmedRight.trim() === '' || trimmedRight.trim().startsWith('#')) continue
    const indent = rawLine.length - rawLine.trimStart().length
    const stripped = rawLine.trimStart()
    const listMatch = /^-\s+(.*)$/u.exec(stripped)
    if (listMatch) {
      flush()
      current = { id: '', name: '', disabled: false, configEnabled: undefined }
      itemIndent = indent
      section = 'item'
      configIndent = -1
      subIndent = -1
      const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/u.exec(listMatch[1]!)
      if (kv) {
        const k = kv[1]!
        const v = stripYamlCommentAndQuotes(kv[2]!)
        if (k === 'id') current.id = v
        else if (k === 'name') current.name = v
        else if (k === 'disabled') current.disabled = v === 'true'
      }
      continue
    }
    if (!current) continue
    if (indent <= itemIndent) {
      flush()
      continue
    }
    if (section === 'usageLearning' || section === 'personalMemory') {
      if (indent <= subIndent) section = 'config'
    }
    if (section === 'config' && indent <= configIndent) {
      section = 'item'
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/u.exec(stripped)
    if (!kv) continue
    const key = kv[1]!
    const val = stripYamlCommentAndQuotes(kv[2]!)
    if (section === 'item') {
      if (key === 'id') current.id = val
      else if (key === 'name') current.name = val
      else if (key === 'disabled') current.disabled = val === 'true'
      else if (key === 'config' && val === '') {
        section = 'config'
        configIndent = indent
      }
    } else if (section === 'config') {
      if (key === 'enabled') current.configEnabled = val === 'true' ? true : val === 'false' ? false : undefined
      else if (key === 'databasePath') current.databasePath = val
      else if (key === 'statePath') current.statePath = val
      else if (key === 'usageLearning' && val === '') {
        section = 'usageLearning'
        subIndent = indent
      } else if (key === 'personalMemory' && val === '') {
        section = 'personalMemory'
        subIndent = indent
      }
    } else if (section === 'usageLearning') {
      if (key === 'databasePath') current.usageDatabasePath = val
    } else if (section === 'personalMemory') {
      if (key === 'databasePath') current.personalMemoryDatabasePath = val
    }
  }
  flush()
}

function discoverCandidateSqlitePaths(
  ctx: Context,
  boundary: ResolvedBoundary,
  targetProfiles: readonly string[],
  patchDbMap: PatchDbMap,
): string[] {
  const candidates = new Set<string>()
  const addPath = (value: string | undefined): void => {
    if (value) candidates.add(value)
  }

  if (boundary.dshHome) {
    const loader = ctx.get('loader' as never) as LoaderLike | undefined
    if (typeof loader?.entries === 'function') {
      try {
        for (const entry of loader.entries()) {
          const modName = typeof entry.options?.name === 'string' ? entry.options.name : ''
          const rawCfg = rec(entry.options?.config)
          const effCfg = rec(entry.fiber?.config)
          for (const cfg of [effCfg, rawCfg]) {
            const dbPath = resolvePathExpr(cfg['databasePath'], boundary.dshHome, boundary.canonicalDshHome)
            if (dbPath) {
              if (modName.includes('assistant-goals')) {
                addPath(`${dbPath}.strategies`)
                addPath(dbPath)
              } else if (modName.includes('assistant-verifier')) {
                addVerifierVariants(candidates, dbPath)
              } else {
                addPath(dbPath)
              }
            }
            addPath(resolvePathExpr(rec(cfg['usageLearning'])['databasePath'], boundary.dshHome, boundary.canonicalDshHome))
            addPath(resolvePathExpr(rec(cfg['personalMemory'])['databasePath'], boundary.dshHome, boundary.canonicalDshHome))
            const stateDir = resolvePathExpr(cfg['statePath'], boundary.dshHome, boundary.canonicalDshHome)
            if (stateDir) {
              addPath(join(stateDir, 'control.sqlite'))
              addPath(join(stateDir, 'creation-adoptions.sqlite'))
              addPath(join(stateDir, 'revision-adoptions.sqlite'))
            }
          }
        }
      } catch {
        // Best-effort loader inspection.
      }
    }

    for (const set of Object.values(patchDbMap)) {
      for (const p of set) addPath(p)
    }

    const dshHome = boundary.dshHome
    // Canonical default $DSH_HOME paths across all 15 families
    addPath(join(dshHome, 'assistant-work-items', 'state.sqlite'))
    addPath(join(dshHome, 'assistant-growth-driver', 'usage.sqlite'))
    addPath(join(dshHome, 'assistant-growth-driver', 'state.sqlite'))
    addPath(join(dshHome, 'assistant-dreaming', 'state.sqlite'))
    addPath(join(dshHome, 'assistant-dreaming', 'dreaming.sqlite'))
    addPath(join(dshHome, 'assistant-recovery', 'state.sqlite'))
    addPath(join(dshHome, 'assistant-recovery', 'recovery.sqlite'))

    for (const b of [
      join(dshHome, 'assistant-goals.sqlite'),
      join(dshHome, 'assistant-goals', 'state.sqlite'),
      join(dshHome, 'assistant-goals', 'goals.sqlite'),
    ]) {
      addPath(`${b}.strategies`)
      addPath(b)
    }
    addPath(join(dshHome, 'assistant-goals', 'strategies.sqlite'))
    addPath(join(dshHome, 'assistant-goals', 'strategy.sqlite'))

    addPath(join(dshHome, 'assistant-memory-learning', 'learning.sqlite'))
    addPath(join(dshHome, 'assistant-memory-learning', 'state.sqlite'))
    addPath(join(dshHome, 'personal-memory', 'memory.sqlite'))
    addPath(join(dshHome, 'personal-memory', 'state.sqlite'))
    addPath(join(dshHome, 'preference-learning', 'preferences.sqlite'))
    addPath(join(dshHome, 'preference-learning', 'state.sqlite'))
    addPath(join(dshHome, 'assistant-evolution', 'evolution.sqlite'))
    addPath(join(dshHome, 'assistant-evolution', 'state.sqlite'))
    addPath(join(dshHome, 'assistant-skills', 'skills.sqlite'))
    addPath(join(dshHome, 'assistant-skills', 'state.sqlite'))
    addPath(join(dshHome, 'assistant-skills.sqlite'))
    addPath(join(dshHome, 'assistant-growth-experiments', 'growth.sqlite'))
    addPath(join(dshHome, 'assistant-growth-experiments', 'state.sqlite'))
    addPath(join(dshHome, 'assistant-association', 'association.sqlite'))
    addPath(join(dshHome, 'assistant-association', 'state.sqlite'))
    addPath(join(dshHome, 'association.sqlite'))
    addPath(join(dshHome, 'assistant-association.sqlite'))
    addPath(join(dshHome, 'assistant-evaluation', 'evaluation.sqlite'))
    addPath(join(dshHome, 'assistant-evaluation', 'state.sqlite'))
    addVerifierVariants(candidates, join(dshHome, 'assistant-verifier', 'verification.sqlite'))
    addVerifierVariants(candidates, join(dshHome, 'assistant-verifier', 'state.sqlite'))
    addPath(join(dshHome, 'plugin-control-plane', 'control.sqlite'))
    addPath(join(dshHome, 'plugin-control-plane', 'state.sqlite'))
    addPath(join(dshHome, 'plugin-control-plane', 'creation-adoptions.sqlite'))
    addPath(join(dshHome, 'plugin-control-plane', 'revision-adoptions.sqlite'))

    // Profile-scoped candidate paths (strictly isolated to targetProfiles)
    for (const prof of targetProfiles) {
      addPath(join(dshHome, 'assistant-work-items', `${prof}.sqlite`))
      addPath(join(dshHome, 'assistant-growth-driver', `${prof}-usage.sqlite`))
      addPath(join(dshHome, 'assistant-growth-driver', `${prof}.sqlite`))
      addPath(join(dshHome, 'assistant-dreaming', `${prof}.sqlite`))
      addPath(join(dshHome, 'assistant-recovery', `${prof}.sqlite`))
      addPath(join(dshHome, 'assistant-goals', `${prof}.sqlite.strategies`))
      addPath(join(dshHome, 'assistant-goals', `${prof}.sqlite`))
      addPath(join(dshHome, 'assistant-memory-learning', `${prof}.sqlite`))
      addPath(join(dshHome, 'personal-memory', `${prof}.sqlite`))
      addPath(join(dshHome, 'preference-learning', `${prof}.sqlite`))
      addPath(join(dshHome, 'assistant-evolution', `${prof}.sqlite`))
      addPath(join(dshHome, 'assistant-skills', `${prof}.sqlite`))
      addPath(join(dshHome, 'assistant-growth-experiments', `${prof}.sqlite`))
      addPath(join(dshHome, 'assistant-association', `${prof}.sqlite`))
      addPath(join(dshHome, 'assistant-evaluation', `${prof}.sqlite`))
      addVerifierVariants(candidates, join(dshHome, 'assistant-verifier', `${prof}.sqlite`))
      addPath(join(dshHome, 'plugin-control-plane', `${prof}.sqlite`))
      addPath(join(dshHome, 'plugin-control-plane', `${prof}-creation-adoptions.sqlite`))
      addPath(join(dshHome, 'plugin-control-plane', `${prof}-revision-adoptions.sqlite`))
      addPath(join(dshHome, `${prof}-creation-adoptions.sqlite`))
      addPath(join(dshHome, `${prof}-revision-adoptions.sqlite`))
      addPath(join(dshHome, 'rsi-authorities', prof, 'state', 'control-plane', 'control.sqlite'))
      addPath(join(dshHome, 'rsi-authorities', prof, 'state', 'control-plane', 'creation-adoptions.sqlite'))
      addPath(join(dshHome, 'rsi-authorities', prof, 'state', 'control-plane', 'revision-adoptions.sqlite'))
    }
  }

  return [...candidates]
}

function readNodeModulesPackages(
  dir: string,
  boundary: ResolvedBoundary,
): Map<string, { version: string | null; installKind: 'npm' | 'local' }> {
  const found = new Map<string, { version: string | null; installKind: 'npm' | 'local' }>()
  if (!boundary.dshHome || !boundary.canonicalDshHome || boundary.homeUnsafe) return found
  const scopeDir = join(dir, '@dsh-ray')
  if (!existsSync(scopeDir)) return found
  const pnpmStoreRoot = resolve(dir, '.pnpm')
  try {
    const st = lstatSync(scopeDir)
    if (!st.isDirectory() || st.isSymbolicLink()) return found
    const realScope = realpathSync(scopeDir)
    if (!realScope.startsWith(`${boundary.canonicalDshHome}${sep}`)) return found
    for (const entry of readdirSync(realScope, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name.startsWith('@')) continue
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const entryPath = join(realScope, entry.name)
      let pkgDir = entryPath
      let installKind: 'npm' | 'local' = 'npm'
      if (entry.isSymbolicLink()) {
        try {
          pkgDir = realpathSync(entryPath)
          const dirStat = lstatSync(pkgDir)
          if (!dirStat.isDirectory()) continue
          installKind = (pkgDir === pnpmStoreRoot || pkgDir.startsWith(`${pnpmStoreRoot}${sep}`))
            ? 'npm'
            : 'local'
        } catch {
          continue
        }
      }
      const pkgJsonPath = join(pkgDir, 'package.json')
      try {
        const pkgStat = lstatSync(pkgJsonPath)
        if (!pkgStat.isFile() || pkgStat.isSymbolicLink()) continue
        if (pkgStat.size < 0 || pkgStat.size > MAX_PACKAGE_JSON_BYTES) continue
        const parsed = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name?: unknown; version?: unknown }
        const pkgName = textOrNull(parsed.name)
        if (pkgName !== null && pkgName.startsWith('@dsh-ray/')) {
          found.set(pkgName, { version: textOrNull(parsed.version), installKind })
        }
      } catch {
        // Ignore unreadable or malformed package.json.
      }
    }
  } catch {
    // Ignore unreadable directory.
  }
  return found
}

function addMetric(current: number | null, delta: number): number {
  return (current ?? 0) + delta
}

function maxMetric(current: number | null, candidate: number): number {
  return current === null ? candidate : Math.max(current, candidate)
}

function callHealthSyncOrAsync(service: unknown): Promise<Record<string, unknown> | undefined> {
  const healthFn = rec(service)['health']
  if (typeof healthFn !== 'function') return Promise.resolve(undefined)
  return Promise.resolve()
    .then(() => (healthFn as () => unknown).call(service))
    .then(res => (typeof res === 'object' && res !== null && !Array.isArray(res)
      ? (res as Record<string, unknown>)
      : undefined))
    .catch(() => undefined)
}

export async function collectDeliveryVersionReport(
  input: Context | CollectDeliveryVersionReportOptions,
  extraOptions?: Omit<CollectDeliveryVersionReportOptions, 'ctx'>,
): Promise<AssistantVersionReport> {
  const options: CollectDeliveryVersionReportOptions = 'ctx' in input
    ? input
    : { ctx: input, ...extraOptions }
  const ctx = options.ctx
  const diagnostics: string[] = [...(options.extraDiagnostics ?? [])]
  const inspectedLedgers: string[] = []
  const seenRealPaths = new Set<string>()
  const boundary = resolveBoundary(ctx, options, diagnostics)
  const generatedAt = typeof options.now === 'number' && Number.isFinite(options.now) && options.now >= 0
    ? Math.trunc(options.now)
    : Date.now()

  const hostMeta = readBoundHostMetadata(boundary)
  const runningVersion = readRunningHostVersion()
  const targetProfiles = boundary.profile !== null
    ? [boundary.profile]
    : (boundary.profiles.length > 0 ? boundary.profiles : ['web', 'lark', 'supervised'])

  const patchDbMap: PatchDbMap = {
    workItems: new Set(),
    growthDriver: new Set(),
    dreaming: new Set(),
    recovery: new Set(),
    goals: new Set(),
    memoryLearning: new Set(),
    memory: new Set(),
    preference: new Set(),
    evolution: new Set(),
    skills: new Set(),
    growthExperiments: new Set(),
    association: new Set(),
    evaluation: new Set(),
    verifier: new Set(),
    controlPlane: new Set(),
  }
  const patchStatesByProfile = new Map<string, Map<string, PatchPluginState>>()
  const homePatchStates = new Map<string, PatchPluginState>()

  if (boundary.dshHome && !boundary.homeUnsafe) {
    if (boundary.profile === null) {
      collectPatchDbPaths(join(boundary.dshHome, 'cordis.yml'), boundary, patchDbMap, homePatchStates, diagnostics)
      collectPatchDbPaths(join(boundary.dshHome, 'cordis.patch.yml'), boundary, patchDbMap, homePatchStates, diagnostics)
    }
    for (const prof of targetProfiles) {
      const profStates = new Map<string, PatchPluginState>(homePatchStates)
      collectPatchDbPaths(join(boundary.dshHome, 'profiles', prof, 'cordis.yml'), boundary, patchDbMap, profStates, diagnostics)
      collectPatchDbPaths(join(boundary.dshHome, 'profiles', prof, 'cordis.patch.yml'), boundary, patchDbMap, profStates, diagnostics)
      patchStatesByProfile.set(prof, profStates)
    }
  }

  // Plugin inventory tracking
  interface MutablePluginEntry {
    name: string
    version: string | null
    versionTier: 0 | 1 | 2 | 3 | 4
    fromAdoptionJournal: boolean
    kind: 'core' | 'evolved'
    installKind?: 'npm' | 'local' | 'adopted'
    enabled?: boolean
  }
  const evolvedByPlanId = new Map<string, MutablePluginEntry>()
  const evolvedMap = new Map<string, MutablePluginEntry>()
  const coreByKey = new Map<string, {
    name: string
    version: string | null
    installKind?: 'npm' | 'local'
    enabledStates: Array<boolean | undefined>
  }>()
  let pluginSourceAvailable = false

  const upsertEvolved = (
    rawName: string,
    patch: { version?: string | null; versionTier?: 0 | 1 | 2 | 3 | 4; fromAdoptionJournal?: boolean; enabled?: boolean },
  ): MutablePluginEntry | undefined => {
    const trimmed = rawName.trim()
    if (trimmed === '') return undefined
    const key = normalizePluginKey(trimmed)
    const boundedName = truncateText(trimmed, 200)
    const boundedVersion = boundNonEmptyString(patch.version, 128) ?? null
    const nextTier: 0 | 1 | 2 | 3 | 4 = boundedVersion !== null ? (patch.versionTier ?? 1) : 0
    const existing = evolvedMap.get(key)
    if (existing) {
      if (trimmed.startsWith('@dsh-ray/') && !existing.name.startsWith('@dsh-ray/')) {
        existing.name = boundedName
      }
      if (patch.fromAdoptionJournal) existing.fromAdoptionJournal = true
      if (boundedVersion !== null && (existing.version === null || nextTier <= existing.versionTier)) {
        existing.version = boundedVersion
        existing.versionTier = nextTier
      }
      if (patch.enabled !== undefined) {
        existing.enabled = existing.enabled === true || patch.enabled
      }
      return existing
    }
    const created: MutablePluginEntry = {
      name: boundedName,
      version: boundedVersion,
      versionTier: nextTier,
      fromAdoptionJournal: patch.fromAdoptionJournal === true,
      kind: 'evolved',
      installKind: 'adopted',
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    }
    evolvedMap.set(key, created)
    return created
  }

  // Self-iteration counters (null = no ledger/service present; 0 = present with 0 rows)
  let workItemsTotal: number | null = null
  let workItemsSettled: number | null = null
  let growthUsageJobsTotal: number | null = null
  let dreamingRuns: number | null = null
  let recoveryRuns: number | null = null
  let goalStrategyRuns: number | null = null
  let candidatesGenerated: number | null = null
  let candidatesAdopted: number | null = null
  let pluginsCreated: number | null = null
  let pluginsRevised: number | null = null
  let taskVerificationsDone: number | null = null
  let rollbacks: number | null = null
  let evolutionRulesAdopted: number | null = null
  let associationParamVersion: number | null = null
  let associationProfileAdoptions: number | null = null
  let evaluationAttentionTuningAdoptions: number | null = null
  let evaluationLooseningDecisionsAdopted: number | null = null
  let activeMemories: number | null = null
  let activePreferenceOverlays: number | null = null
  let workflowCandidatesPromoted: number | null = null
  let skillDeployments: number | null = null
  let selfUpgrades: number | null = null
  let backupSnapshotsCount: number | null = null

  let sawControlPlaneDb = false
  let sawCreatedSource = false
  let sawRevisedSource = false
  let sawControlAdoptionSource = false
  let sawActivationPlansTable = false
  const createdPlanIds = new Set<string>()
  const revisedPlanIds = new Set<string>()
  const controlAdoptedPlanIds = new Set<string>()
  const sourceIdToActivationId = new Map<string, string>()
  const linkedActivationIds = new Set<string>()
  const sourcePlanIds = new Set<string>()
  const sourceModeById = new Map<string, string | null>()
  const watchClosedByPlan = new Set<string>()
  const activatedActIds = new Set<string>()

  interface BufferedCreationRow {
    planId: string
    status: string
    certificateJson?: string
    receiptJson?: string
  }
  interface BufferedRevisionEntryRow {
    entryId?: string
    name?: string
    parentPlanId?: string
    currentPlanId?: string
    revision?: number
  }
  interface BufferedRevisionDb {
    adoptionStatusByPlan: Map<string, string>
    entries: BufferedRevisionEntryRow[]
  }
  interface BufferedWatchRow {
    packageName: string
    packageVersion: string | null
    state: string
  }
  interface BufferedSourcePlanRow {
    id: string
    pluginName?: string
    mode: string | null
    status?: string
  }
  interface BufferedActivationPlanRow {
    id: string
    profile?: string
    candidateJson?: string
    status: string
  }

  const bufferedCreations: BufferedCreationRow[] = []
  const bufferedRevisions: BufferedRevisionDb[] = []
  const bufferedWatches: BufferedWatchRow[] = []
  const bufferedSourcePlans: BufferedSourcePlanRow[] = []
  const bufferedActivationPlans: BufferedActivationPlanRow[] = []

  let sawPrefHypotheses = false
  let prefHypothesesTotal = 0
  let prefHypothesesActiveFallback = 0
  let prefHypothesesRolledBackFallback = 0
  let sawPrefTransitions = false
  let prefTransitionsCreated = 0
  let prefTransitionsActivated = 0
  let prefTransitionsRolledBack = 0

  let hasCpActivationDb = false
  let hasEvoProposalsDb = false
  let hasEvoRulesDb = false
  let hasEvoRollbacksDb = false
  let hasPrefDb = false
  let hasMemoryLearningDb = false

  const dbPaths = discoverCandidateSqlitePaths(ctx, boundary, targetProfiles, patchDbMap)
  for (const dbPath of dbPaths) {
    withReadOnlySqlite(dbPath, boundary, seenRealPaths, inspectedLedgers, diagnostics, db => {
      // Work items
      if (hasTable(db, 'work_item')) {
        workItemsTotal = addMetric(workItemsTotal, countQuery(db, 'SELECT COUNT(*) AS n FROM work_item'))
      }
      if (hasTable(db, 'work_item_outcome') && hasColumn(db, 'work_item_outcome', 'item_id')) {
        workItemsSettled = addMetric(
          workItemsSettled,
          countQuery(db, 'SELECT COUNT(DISTINCT item_id) AS n FROM work_item_outcome'),
        )
      } else if (hasTable(db, 'work_item') && hasColumn(db, 'work_item', 'state')) {
        workItemsSettled = addMetric(
          workItemsSettled,
          countQuery(db, "SELECT COUNT(*) AS n FROM work_item WHERE state IN ('ready','blocked','failed','dropped')"),
        )
      }

      // Growth driver usage jobs
      if (hasTable(db, 'usage_jobs')) {
        const jobs = countQuery(db, 'SELECT COUNT(*) AS n FROM usage_jobs')
        growthUsageJobsTotal = addMetric(growthUsageJobsTotal, jobs)
        candidatesGenerated = addMetric(candidatesGenerated, jobs)
      }

      // Dreaming
      if (hasTable(db, 'dream_runs')) {
        dreamingRuns = addMetric(dreamingRuns, countQuery(db, 'SELECT COUNT(*) AS n FROM dream_runs'))
      }

      // Recovery
      if (hasTable(db, 'recovery_runs')) {
        recoveryRuns = addMetric(recoveryRuns, countQuery(db, 'SELECT COUNT(*) AS n FROM recovery_runs'))
      }

      // Goal strategy
      if (hasTable(db, 'goal_strategy_records')) {
        goalStrategyRuns = addMetric(goalStrategyRuns, countQuery(db, 'SELECT COUNT(*) AS n FROM goal_strategy_records'))
      }

      // Plugin control plane: source_adoptions, source_plans, activation_watch, activation_plans, creation-adoptions, revision-adoptions
      if (
        hasTable(db, 'source_adoptions')
        && hasColumn(db, 'source_adoptions', 'source_plan_id')
        && hasColumn(db, 'source_adoptions', 'activation_plan_id')
      ) {
        sawControlPlaneDb = true
        const links = db.prepare('SELECT source_plan_id, activation_plan_id FROM source_adoptions').all() as Array<{
          source_plan_id?: unknown
          activation_plan_id?: unknown
        }>
        for (const link of links) {
          if (typeof link.source_plan_id === 'string' && typeof link.activation_plan_id === 'string') {
            linkedActivationIds.add(link.activation_plan_id)
            sourceIdToActivationId.set(link.source_plan_id, link.activation_plan_id)
          }
        }
      }

      if (hasTable(db, 'source_plans') && hasColumn(db, 'source_plans', 'id')) {
        sawControlPlaneDb = true
        sawCreatedSource = true
        sawRevisedSource = true
        sawControlAdoptionSource = true
        const hasMode = hasColumn(db, 'source_plans', 'mode')
        const hasPluginName = hasColumn(db, 'source_plans', 'plugin_name')
        const hasStatus = hasColumn(db, 'source_plans', 'status')
        const cols = [
          'id',
          ...(hasPluginName ? ['plugin_name'] : []),
          ...(hasMode ? ['mode'] : []),
          ...(hasStatus ? ['status'] : []),
        ]
        const rows = db.prepare(`SELECT ${cols.join(', ')} FROM source_plans`).all() as Array<{
          id?: unknown
          plugin_name?: unknown
          mode?: unknown
          status?: unknown
        }>
        candidatesGenerated = addMetric(candidatesGenerated, rows.length)
        for (const row of rows) {
          if (typeof row.id !== 'string') continue
          const mode = hasMode && typeof row.mode === 'string' ? row.mode : null
          sourcePlanIds.add(row.id)
          sourceModeById.set(row.id, mode)
          bufferedSourcePlans.push({
            id: row.id,
            ...(typeof row.plugin_name === 'string' ? { pluginName: row.plugin_name } : {}),
            mode,
            ...(hasStatus && typeof row.status === 'string' ? { status: row.status } : {}),
          })
        }
      }

      if (hasTable(db, 'activation_watch')) {
        sawControlPlaneDb = true
        const hasPlanId = hasColumn(db, 'activation_watch', 'plan_id')
        const hasPkgName = hasColumn(db, 'activation_watch', 'package_name')
        const hasVer = hasColumn(db, 'activation_watch', 'package_version')
        const hasState = hasColumn(db, 'activation_watch', 'state')
        const cols = [
          ...(hasPlanId ? ['plan_id'] : []),
          ...(hasPkgName ? ['package_name'] : []),
          ...(hasVer ? ['package_version'] : []),
          ...(hasState ? ['state'] : []),
        ]
        if (cols.length > 0) {
          const rows = db.prepare(`SELECT ${cols.join(', ')} FROM activation_watch`).all() as Array<{
            plan_id?: unknown
            package_name?: unknown
            package_version?: unknown
            state?: unknown
          }>
          for (const row of rows) {
            const state = typeof row.state === 'string' ? row.state : ''
            if (typeof row.plan_id === 'string' && (state === 'closed-regressed' || state === 'closed-retracted')) {
              watchClosedByPlan.add(row.plan_id)
            }
            if (typeof row.package_name === 'string' && row.package_name.trim() !== '') {
              bufferedWatches.push({
                packageName: row.package_name.trim(),
                packageVersion: typeof row.package_version === 'string' && row.package_version.trim() !== ''
                  ? row.package_version.trim()
                  : null,
                state,
              })
            }
          }
        }
      }

      if (hasTable(db, 'activation_plans') && hasColumn(db, 'activation_plans', 'id') && hasColumn(db, 'activation_plans', 'status')) {
        sawControlPlaneDb = true
        hasCpActivationDb = true
        sawControlAdoptionSource = true
        sawActivationPlansTable = true
        const hasProfileCol = hasColumn(db, 'activation_plans', 'profile')
        const hasCandidateCol = hasColumn(db, 'activation_plans', 'candidate_json')
        const hasUpdatedCol = hasColumn(db, 'activation_plans', 'updated_at')
        const actRows = db.prepare(
          `SELECT id, ${hasProfileCol ? 'profile,' : ''} ${hasCandidateCol ? 'candidate_json,' : ''} status${hasUpdatedCol ? ', updated_at' : ''} FROM activation_plans${hasUpdatedCol ? ' ORDER BY updated_at ASC, rowid ASC' : ''}`,
        ).all() as Array<{
          id?: unknown
          profile?: unknown
          candidate_json?: unknown
          status?: unknown
        }>
        for (const row of actRows) {
          if (typeof row.id !== 'string' || typeof row.status !== 'string') continue
          if (boundary.profile !== null && hasProfileCol && typeof row.profile === 'string' && row.profile !== boundary.profile) {
            continue
          }
          if (row.status === 'activated') activatedActIds.add(row.id)
          bufferedActivationPlans.push({
            id: row.id,
            ...(typeof row.profile === 'string' ? { profile: row.profile } : {}),
            ...(typeof row.candidate_json === 'string' ? { candidateJson: row.candidate_json } : {}),
            status: row.status,
          })
        }
      }

      const isRevisionJournal = hasTable(db, 'entries') || hasTable(db, 'versions') || hasTable(db, 'rollbacks')

      if (!isRevisionJournal && hasTable(db, 'adoptions') && !hasColumn(db, 'adoptions', 'parent_plan_id') && hasColumn(db, 'adoptions', 'plan_id') && hasColumn(db, 'adoptions', 'status')) {
        sawControlPlaneDb = true
        sawCreatedSource = true
        sawControlAdoptionSource = true
        const hasCert = hasColumn(db, 'adoptions', 'certificate_json')
        const hasReceipt = hasColumn(db, 'adoptions', 'receipt_json')
        const rows = db.prepare(
          `SELECT plan_id, status${hasCert ? ', certificate_json' : ''}${hasReceipt ? ', receipt_json' : ''} FROM adoptions`,
        ).all() as Array<{ plan_id?: unknown; status?: unknown; certificate_json?: unknown; receipt_json?: unknown }>
        for (const row of rows) {
          if (typeof row.plan_id !== 'string' || typeof row.status !== 'string') continue
          bufferedCreations.push({
            planId: row.plan_id,
            status: row.status,
            ...(typeof row.certificate_json === 'string' ? { certificateJson: row.certificate_json } : {}),
            ...(typeof row.receipt_json === 'string' ? { receiptJson: row.receipt_json } : {}),
          })
        }
      }

      if (isRevisionJournal) {
        sawControlPlaneDb = true
        if (hasTable(db, 'rollbacks')) {
          rollbacks = addMetric(rollbacks, countQuery(db, 'SELECT COUNT(*) AS n FROM rollbacks'))
        }
        const adoptionStatusByPlan = new Map<string, string>()
        if (hasTable(db, 'adoptions') && hasColumn(db, 'adoptions', 'plan_id') && hasColumn(db, 'adoptions', 'status')) {
          sawRevisedSource = true
          sawControlAdoptionSource = true
          const aRows = db.prepare('SELECT plan_id, status FROM adoptions').all() as Array<{ plan_id?: unknown; status?: unknown }>
          for (const ar of aRows) {
            if (typeof ar.plan_id === 'string' && typeof ar.status === 'string') {
              adoptionStatusByPlan.set(ar.plan_id, ar.status)
              if (ar.status === 'active') {
                revisedPlanIds.add(ar.plan_id)
                controlAdoptedPlanIds.add(ar.plan_id)
              }
            }
          }
        } else if (hasTable(db, 'versions') && hasColumn(db, 'versions', 'plan_id') && hasColumn(db, 'versions', 'role')) {
          sawRevisedSource = true
          sawControlAdoptionSource = true
          const vRows = db.prepare("SELECT plan_id FROM versions WHERE role = 'revision'").all() as Array<{ plan_id?: unknown }>
          for (const vr of vRows) {
            if (typeof vr.plan_id === 'string' && vr.plan_id !== '') {
              revisedPlanIds.add(vr.plan_id)
              controlAdoptedPlanIds.add(vr.plan_id)
            }
          }
        }
        if (hasTable(db, 'entries')) {
          const hasEntryId = hasColumn(db, 'entries', 'entry_id')
          const hasName = hasColumn(db, 'entries', 'name')
          const hasParentPlan = hasColumn(db, 'entries', 'parent_plan_id')
          const hasCurrentPlan = hasColumn(db, 'entries', 'current_plan_id')
          const hasRev = hasColumn(db, 'entries', 'revision')
          const cols = [
            ...(hasEntryId ? ['entry_id'] : []),
            ...(hasName ? ['name'] : []),
            ...(hasParentPlan ? ['parent_plan_id'] : []),
            ...(hasCurrentPlan ? ['current_plan_id'] : []),
            ...(hasRev ? ['revision'] : []),
          ]
          const entryList: BufferedRevisionEntryRow[] = []
          if (cols.length > 0) {
            const eRows = db.prepare(`SELECT ${cols.join(', ')} FROM entries`).all() as Array<{
              entry_id?: unknown; name?: unknown; parent_plan_id?: unknown; current_plan_id?: unknown; revision?: unknown
            }>
            for (const er of eRows) {
              entryList.push({
                ...(typeof er.entry_id === 'string' ? { entryId: er.entry_id } : {}),
                ...(typeof er.name === 'string' ? { name: er.name } : {}),
                ...(typeof er.parent_plan_id === 'string' ? { parentPlanId: er.parent_plan_id } : {}),
                ...(typeof er.current_plan_id === 'string' ? { currentPlanId: er.current_plan_id } : {}),
                ...(typeof er.revision === 'number' && Number.isFinite(er.revision) ? { revision: Math.trunc(er.revision) } : {}),
              })
            }
          }
          bufferedRevisions.push({ adoptionStatusByPlan, entries: entryList })
        }
      }

      // Verifier
      if (hasTable(db, 'acceptance_jobs') && hasColumn(db, 'acceptance_jobs', 'state')) {
        taskVerificationsDone = addMetric(
          taskVerificationsDone,
          countQuery(db, "SELECT COUNT(*) AS n FROM acceptance_jobs WHERE state = 'done'"),
        )
      }

      // Evolution
      if (hasTable(db, 'evolution_proposals')) {
        hasEvoProposalsDb = true
        candidatesGenerated = addMetric(candidatesGenerated, countQuery(db, 'SELECT COUNT(*) AS n FROM evolution_proposals'))
      }
      if (hasTable(db, 'evolution_rules')) {
        hasEvoRulesDb = true
        const rules = countQuery(db, 'SELECT COUNT(*) AS n FROM evolution_rules')
        evolutionRulesAdopted = addMetric(evolutionRulesAdopted, rules)
        candidatesAdopted = addMetric(candidatesAdopted, rules)
      }
      if (hasTable(db, 'evolution_autonomous_rollbacks')) {
        hasEvoRollbacksDb = true
        rollbacks = addMetric(rollbacks, countQuery(db, 'SELECT COUNT(*) AS n FROM evolution_autonomous_rollbacks'))
      }

      // Association
      if (hasTable(db, 'assoc_param_profile_heads') && hasColumn(db, 'assoc_param_profile_heads', 'active_version')) {
        const row = db.prepare('SELECT MAX(active_version) AS v FROM assoc_param_profile_heads').get() as { v?: unknown } | undefined
        const ver = nonNegIntOrNull(row?.v) ?? 0
        associationParamVersion = maxMetric(associationParamVersion, ver)
      }
      if (hasTable(db, 'assoc_param_profile_events') && hasColumn(db, 'assoc_param_profile_events', 'kind')) {
        associationProfileAdoptions = addMetric(
          associationProfileAdoptions,
          countQuery(db, "SELECT COUNT(*) AS n FROM assoc_param_profile_events WHERE kind = 'adopted'"),
        )
        rollbacks = addMetric(
          rollbacks,
          countQuery(db, "SELECT COUNT(*) AS n FROM assoc_param_profile_events WHERE kind = 'rolled-back'"),
        )
      }
      if (hasTable(db, 'assoc_skill_candidates')) {
        candidatesGenerated = addMetric(candidatesGenerated, countQuery(db, 'SELECT COUNT(*) AS n FROM assoc_skill_candidates'))
      }
      if (hasTable(db, 'assoc_param_relax_proposals')) {
        candidatesGenerated = addMetric(candidatesGenerated, countQuery(db, 'SELECT COUNT(*) AS n FROM assoc_param_relax_proposals'))
      }

      // Evaluation
      if (hasTable(db, 'evaluation_attention_tuning_events') && hasColumn(db, 'evaluation_attention_tuning_events', 'kind')) {
        evaluationAttentionTuningAdoptions = addMetric(
          evaluationAttentionTuningAdoptions,
          countQuery(db, "SELECT COUNT(*) AS n FROM evaluation_attention_tuning_events WHERE kind = 'adopted'"),
        )
        rollbacks = addMetric(
          rollbacks,
          countQuery(db, "SELECT COUNT(*) AS n FROM evaluation_attention_tuning_events WHERE kind = 'rolled-back'"),
        )
      }
      if (hasTable(db, 'evaluation_attention_loosening_proposals')) {
        candidatesGenerated = addMetric(
          candidatesGenerated,
          countQuery(db, 'SELECT COUNT(*) AS n FROM evaluation_attention_loosening_proposals'),
        )
      }
      if (hasTable(db, 'evaluation_attention_loosening_decisions') && hasColumn(db, 'evaluation_attention_loosening_decisions', 'decision')) {
        const adopted = countQuery(
          db,
          "SELECT COUNT(*) AS n FROM evaluation_attention_loosening_decisions WHERE decision = 'adopted'",
        )
        evaluationLooseningDecisionsAdopted = addMetric(evaluationLooseningDecisionsAdopted, adopted)
      }

      // Personal memory
      if (hasTable(db, 'memory_records') && hasColumn(db, 'memory_records', 'status')) {
        activeMemories = addMetric(
          activeMemories,
          countQuery(db, "SELECT COUNT(*) AS n FROM memory_records WHERE status = 'active'"),
        )
      }

      // Preference learning
      if (hasTable(db, 'preference_hypotheses')) {
        hasPrefDb = true
        sawPrefHypotheses = true
        prefHypothesesTotal += countQuery(db, 'SELECT COUNT(*) AS n FROM preference_hypotheses')
        if (hasColumn(db, 'preference_hypotheses', 'effect_state')) {
          const activeCount = countQuery(
            db,
            "SELECT COUNT(*) AS n FROM preference_hypotheses WHERE effect_state = 'active'",
          )
          activePreferenceOverlays = addMetric(activePreferenceOverlays, activeCount)
          prefHypothesesActiveFallback += activeCount
          prefHypothesesRolledBackFallback += countQuery(
            db,
            "SELECT COUNT(*) AS n FROM preference_hypotheses WHERE effect_state = 'rolled-back'",
          )
        }
      }
      if (hasTable(db, 'preference_transitions') && hasColumn(db, 'preference_transitions', 'reason')) {
        hasPrefDb = true
        sawPrefTransitions = true
        prefTransitionsCreated += countQuery(db, "SELECT COUNT(*) AS n FROM preference_transitions WHERE reason = 'created'")
        prefTransitionsActivated += countQuery(db, "SELECT COUNT(*) AS n FROM preference_transitions WHERE reason = 'activated'")
        prefTransitionsRolledBack += countQuery(
          db,
          "SELECT COUNT(*) AS n FROM preference_transitions WHERE reason IN ('regression', 'operator-request')",
        )
      }

      // Memory learning jobs
      if (hasTable(db, 'jobs')) {
        hasMemoryLearningDb = true
        candidatesGenerated = addMetric(candidatesGenerated, countQuery(db, 'SELECT COUNT(*) AS n FROM jobs'))
        if (hasColumn(db, 'jobs', 'state')) {
          candidatesAdopted = addMetric(
            candidatesAdopted,
            countQuery(db, "SELECT COUNT(*) AS n FROM jobs WHERE state = 'adopted'"),
          )
        }
      }

      // Growth experiments / workflows
      if (hasTable(db, 'workflow_candidates')) {
        candidatesGenerated = addMetric(candidatesGenerated, countQuery(db, 'SELECT COUNT(*) AS n FROM workflow_candidates'))
        if (hasColumn(db, 'workflow_candidates', 'state')) {
          const promoted = countQuery(db, "SELECT COUNT(*) AS n FROM workflow_candidates WHERE state = 'promoted'")
          workflowCandidatesPromoted = addMetric(workflowCandidatesPromoted, promoted)
          candidatesAdopted = addMetric(candidatesAdopted, promoted)
          rollbacks = addMetric(
            rollbacks,
            countQuery(db, "SELECT COUNT(*) AS n FROM workflow_candidates WHERE state = 'rolled-back'"),
          )
        }
      }

      // Skills
      if (hasTable(db, 'skill_candidates')) {
        candidatesGenerated = addMetric(candidatesGenerated, countQuery(db, 'SELECT COUNT(*) AS n FROM skill_candidates'))
      }
      if (hasTable(db, 'skill_deployments') && hasColumn(db, 'skill_deployments', 'state')) {
        const deployed = countQuery(
          db,
          "SELECT COUNT(*) AS n FROM skill_deployments WHERE state IN ('canary', 'promoted')",
        )
        skillDeployments = addMetric(skillDeployments, deployed)
        candidatesAdopted = addMetric(candidatesAdopted, deployed)
        rollbacks = addMetric(
          rollbacks,
          countQuery(db, "SELECT COUNT(*) AS n FROM skill_deployments WHERE state IN ('rolled-back', 'revoked')"),
        )
      }
    })
  }

  // Finalize preference aggregates
  if (sawPrefHypotheses) {
    candidatesGenerated = addMetric(candidatesGenerated, prefHypothesesTotal)
  } else if (sawPrefTransitions) {
    candidatesGenerated = addMetric(candidatesGenerated, prefTransitionsCreated)
  }
  if (sawPrefTransitions) {
    candidatesAdopted = addMetric(candidatesAdopted, prefTransitionsActivated)
    rollbacks = addMetric(rollbacks, prefTransitionsRolledBack)
  } else if (sawPrefHypotheses) {
    candidatesAdopted = addMetric(candidatesAdopted, prefHypothesesActiveFallback)
    rollbacks = addMetric(rollbacks, prefHypothesesRolledBackFallback)
  }

  // Finalize control-plane Passes 0 -> A -> B -> C
  const normalizePlanId = (id: string): string => sourceIdToActivationId.get(id) ?? id

  if (revisedPlanIds.size > 0) {
    const normalizedRev = new Set<string>()
    for (const pid of revisedPlanIds) normalizedRev.add(normalizePlanId(pid))
    revisedPlanIds.clear()
    for (const pid of normalizedRev) revisedPlanIds.add(pid)
  }
  if (controlAdoptedPlanIds.size > 0) {
    const normalizedCtrl = new Set<string>()
    for (const pid of controlAdoptedPlanIds) normalizedCtrl.add(normalizePlanId(pid))
    controlAdoptedPlanIds.clear()
    for (const pid of normalizedCtrl) controlAdoptedPlanIds.add(pid)
  }

  // Pass A: creation-adoptions
  for (const row of bufferedCreations) {
    let cert: Record<string, unknown> = {}
    if (typeof row.certificateJson === 'string' && row.certificateJson !== '') {
      try { cert = rec(JSON.parse(row.certificateJson)) } catch { cert = {} }
    }
    const plan = rec(cert['plan'])
    let receipt: Record<string, unknown> = {}
    if (typeof row.receiptJson === 'string' && row.receiptJson !== '') {
      try { receipt = rec(JSON.parse(row.receiptJson)) } catch { receipt = {} }
    }
    const capName = textOrNull(plan['name'])
      ?? textOrNull(cert['packageName'])
      ?? textOrNull(cert['pluginName'])
      ?? textOrNull(cert['name'])
      ?? row.planId
    const capVer = textOrNull(receipt['version'])
      ?? textOrNull(plan['version'])
      ?? textOrNull(cert['version'])
      ?? textOrNull(cert['pluginVersion'])
    const entry = upsertEvolved(capName, {
      version: capVer,
      versionTier: capVer !== null ? 1 : 0,
      fromAdoptionJournal: true,
      enabled: row.status === 'active',
    })
    const canonicalId = normalizePlanId(row.planId)
    if (entry) {
      evolvedByPlanId.set(row.planId, entry)
      evolvedByPlanId.set(canonicalId, entry)
    }
    if (row.status === 'active' || row.status === 'authorized') {
      createdPlanIds.add(canonicalId)
      controlAdoptedPlanIds.add(canonicalId)
    }
  }

  // Pass B: revision-adoptions entries
  for (const revDb of bufferedRevisions) {
    for (const er of revDb.entries) {
      const currentStatus = er.currentPlanId ? revDb.adoptionStatusByPlan.get(er.currentPlanId) : undefined
      const revVersion = er.revision !== undefined ? `v${er.revision}` : null
      const parentEntry = er.parentPlanId
        ? (evolvedByPlanId.get(normalizePlanId(er.parentPlanId)) ?? evolvedByPlanId.get(er.parentPlanId))
        : undefined
      if (parentEntry) {
        upsertEvolved(parentEntry.name, {
          version: revVersion,
          versionTier: revVersion !== null ? 2 : 0,
          fromAdoptionJournal: true,
          enabled: currentStatus === 'active',
        })
      } else {
        const rawName = textOrNull(er.name)
          ?? er.parentPlanId
          ?? er.entryId
          ?? 'evolved-capability'
        upsertEvolved(rawName, {
          version: revVersion,
          versionTier: revVersion !== null ? 2 : 0,
          fromAdoptionJournal: true,
          enabled: currentStatus === 'active',
        })
      }
    }
  }

  // Pass C: control.sqlite (activation_watch -> source_plans -> activation_plans)
  for (const w of bufferedWatches) {
    if (w.state === '' || w.state === 'watching') {
      upsertEvolved(w.packageName, {
        version: w.packageVersion,
        versionTier: w.packageVersion !== null ? 1 : 0,
        enabled: w.state === 'watching',
      })
    }
  }

  for (const sp of bufferedSourcePlans) {
    if (sp.status === 'release-complete') {
      const canonicalId = normalizePlanId(sp.id)
      controlAdoptedPlanIds.add(canonicalId)
      if (sp.mode === 'modify' || sp.mode === 'prepared-revise') {
        revisedPlanIds.add(canonicalId)
      } else {
        createdPlanIds.add(canonicalId)
        const pkgName = textOrNull(sp.pluginName)
        if (pkgName) {
          upsertEvolved(pkgName, {
            version: null,
            versionTier: 0,
            enabled: activatedActIds.has(canonicalId),
          })
        }
      }
    }
  }

  const sourceModeByActivationId = new Map<string, string | null>()
  for (const [srcId, actId] of sourceIdToActivationId) {
    if (sourceModeById.has(srcId)) {
      sourceModeByActivationId.set(actId, sourceModeById.get(srcId) ?? null)
    }
  }

  let unlinkedApCount = 0
  let rollbackApCount = 0
  for (const act of bufferedActivationPlans) {
    if (!linkedActivationIds.has(act.id) && !sourcePlanIds.has(act.id)) {
      unlinkedApCount += 1
    }
    if (act.status === 'activated') {
      controlAdoptedPlanIds.add(act.id)
    }
    if (act.status === 'rolled-back' || act.status === 'rollback-pending') {
      rollbackApCount += 1
    }
    const linkedMode = sourceModeByActivationId.get(act.id)
    if (linkedMode === 'modify' || linkedMode === 'prepared-revise') {
      continue
    }
    let candidate: Record<string, unknown> = {}
    if (typeof act.candidateJson === 'string' && act.candidateJson !== '') {
      try { candidate = rec(JSON.parse(act.candidateJson)) } catch { candidate = {} }
    }
    const pkgName = textOrNull(candidate['package']) ?? textOrNull(candidate['name'])
    if (!pkgName) continue
    const pkgVer = textOrNull(candidate['version'])
    const patchDisabled = targetProfiles.length > 0
      && targetProfiles.every(p => {
        const ps = patchStatesByProfile.get(p)?.get(pkgName)
        return ps?.disabled === true || ps?.configEnabled === false
      })
    const enabled = act.status === 'activated' && !watchClosedByPlan.has(act.id) && !patchDisabled
    const boundedPkgName = boundNonEmptyString(pkgName, 200)
    if (!boundedPkgName) continue
    const key = normalizePluginKey(boundedPkgName)
    const existing = evolvedMap.get(key)
    evolvedMap.set(key, {
      name: boundedPkgName,
      version: pkgVer ?? existing?.version ?? null,
      versionTier: pkgVer !== null ? 1 : (existing?.versionTier ?? 0),
      fromAdoptionJournal: existing?.fromAdoptionJournal ?? false,
      kind: 'evolved',
      installKind: 'adopted',
      enabled,
    })
  }

  if (sawActivationPlansTable) {
    candidatesGenerated = addMetric(candidatesGenerated, unlinkedApCount)
    rollbacks = addMetric(rollbacks, rollbackApCount)
  }
  if (sawCreatedSource) pluginsCreated = createdPlanIds.size
  if (sawRevisedSource) pluginsRevised = revisedPlanIds.size
  if (sawControlAdoptionSource) {
    candidatesAdopted = addMetric(candidatesAdopted, controlAdoptedPlanIds.size)
  }

  // Upgrade history & backup snapshots
  if (boundary.dshHome && boundary.canonicalDshHome && !boundary.homeUnsafe) {
    const upgradeHistoryPath = join(boundary.dshHome, '.dsh-ray', 'upgrade-history.jsonl')
    const historyText = readBoundedRegularFile(upgradeHistoryPath, boundary, MAX_UPGRADE_HISTORY_BYTES)
    if (historyText !== undefined) {
      let upgradeCount = 0
      for (const line of historyText.split(/\r?\n/u)) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          const parsed = JSON.parse(trimmed) as unknown
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) upgradeCount += 1
        } catch {
          // Ignore trailing/corrupt line in JSONL without crashing.
        }
      }
      selfUpgrades = upgradeCount
    }

    const backupDir = join(boundary.dshHome, '.dsh-ray-upgrade-backups')
    if (existsSync(backupDir)) {
      try {
        const st = lstatSync(backupDir)
        if (st.isDirectory() && !st.isSymbolicLink()) {
          const realBackupDir = realpathSync(backupDir)
          if (realBackupDir.startsWith(`${boundary.canonicalDshHome}${sep}`)) {
            let count = 0
            for (const entry of readdirSync(realBackupDir, { withFileTypes: true })) {
              if (!entry.name.startsWith('.') && entry.isDirectory() && !entry.isSymbolicLink()) count += 1
            }
            backupSnapshotsCount = count
          }
        }
      } catch {
        // Ignore unreadable backup dir.
      }
    }
  }

  // Cordis health() fallbacks when SQLite ledgers are absent or :memory:
  const [
    workItemsHealth,
    growthDriverHealth,
    dreamingHealth,
    recoveryHealth,
    goalsHealth,
    controlPlaneHealth,
    verifierHealth,
    evolutionHealth,
    memoryHealth,
    prefHealth,
    memoryLearningHealth,
    growthExpHealth,
  ] = await Promise.all([
    workItemsTotal === null ? callHealthSyncOrAsync(ctx.get('assistantWorkItems' as never)) : Promise.resolve(undefined),
    growthUsageJobsTotal === null ? callHealthSyncOrAsync(ctx.get('assistantGrowthDriver' as never)) : Promise.resolve(undefined),
    dreamingRuns === null ? callHealthSyncOrAsync(ctx.get('assistantDreaming' as never)) : Promise.resolve(undefined),
    recoveryRuns === null ? callHealthSyncOrAsync(ctx.get('assistantRecovery' as never)) : Promise.resolve(undefined),
    goalStrategyRuns === null ? callHealthSyncOrAsync(ctx.get('assistantGoals' as never)) : Promise.resolve(undefined),
    (!hasCpActivationDb) ? callHealthSyncOrAsync(ctx.get('pluginControlPlane' as never)) : Promise.resolve(undefined),
    taskVerificationsDone === null ? callHealthSyncOrAsync(ctx.get('assistantVerifier' as never)) : Promise.resolve(undefined),
    (!hasEvoProposalsDb || !hasEvoRulesDb || !hasEvoRollbacksDb) ? callHealthSyncOrAsync(ctx.get('assistantEvolution' as never)) : Promise.resolve(undefined),
    activeMemories === null ? callHealthSyncOrAsync(ctx.get('personalMemory' as never)) : Promise.resolve(undefined),
    (!hasPrefDb) ? callHealthSyncOrAsync(ctx.get('assistantPreferenceLearning' as never)) : Promise.resolve(undefined),
    (!hasMemoryLearningDb) ? callHealthSyncOrAsync(ctx.get('assistantMemoryLearning' as never)) : Promise.resolve(undefined),
    workflowCandidatesPromoted === null ? callHealthSyncOrAsync(ctx.get('assistantGrowthExperiments' as never)) : Promise.resolve(undefined),
  ])

  if (workItemsTotal === null && workItemsHealth) {
    const open = nonNegIntOrNull(workItemsHealth['openItems'])
    if (open !== null) workItemsTotal = open
  }
  if (growthUsageJobsTotal === null && growthDriverHealth) {
    const pending = nonNegIntOrNull(growthDriverHealth['usagePending']) ?? 0
    const running = nonNegIntOrNull(growthDriverHealth['usageRunning']) ?? 0
    const failed = nonNegIntOrNull(growthDriverHealth['usageFailed']) ?? 0
    const unknown = nonNegIntOrNull(growthDriverHealth['usageUnknown']) ?? 0
    if ('usagePending' in growthDriverHealth || 'usageEnabled' in growthDriverHealth) {
      growthUsageJobsTotal = pending + running + failed + unknown
    }
  }
  if (dreamingRuns === null && dreamingHealth) {
    const runs = nonNegIntOrNull(dreamingHealth['runs'])
    if (runs !== null) dreamingRuns = runs
  }
  if (recoveryRuns === null && recoveryHealth) {
    const running = nonNegIntOrNull(recoveryHealth['runningRuns']) ?? 0
    const failed = nonNegIntOrNull(recoveryHealth['failedRuns']) ?? 0
    const unknown = nonNegIntOrNull(recoveryHealth['unknownRuns']) ?? 0
    if ('runningRuns' in recoveryHealth) recoveryRuns = running + failed + unknown
  }
  if (goalStrategyRuns === null && goalsHealth && goalsHealth['ready'] === true) {
    goalStrategyRuns = 0
  }
  if (controlPlaneHealth && !hasCpActivationDb) {
    const activeActivations = nonNegIntOrNull(controlPlaneHealth['activeActivations'])
    if (activeActivations !== null) candidatesAdopted = addMetric(candidatesAdopted, activeActivations)
    const rollbackPending = nonNegIntOrNull(controlPlaneHealth['rollbackPending'])
    if (rollbackPending !== null) rollbacks = addMetric(rollbacks, rollbackPending)
  }
  if (taskVerificationsDone === null && verifierHealth && verifierHealth['ready'] === true) {
    taskVerificationsDone = 0
  }
  if (evolutionHealth) {
    if (!hasEvoRulesDb) {
      const activeRules = nonNegIntOrNull(evolutionHealth['activeRules'])
      const retiredRules = nonNegIntOrNull(evolutionHealth['retiredRules'])
      if (activeRules !== null || retiredRules !== null) {
        const adoptedRules = (activeRules ?? 0) + (retiredRules ?? 0)
        evolutionRulesAdopted = addMetric(evolutionRulesAdopted, adoptedRules)
        candidatesAdopted = addMetric(candidatesAdopted, adoptedRules)
      }
    }
    if (!hasEvoProposalsDb) {
      const pendingProposals = nonNegIntOrNull(evolutionHealth['pendingProposals'])
      if (pendingProposals !== null) candidatesGenerated = addMetric(candidatesGenerated, pendingProposals)
    }
    if (!hasEvoRollbacksDb) {
      const autoRollbacks = nonNegIntOrNull(evolutionHealth['autonomousRollbacks'])
      if (autoRollbacks !== null) rollbacks = addMetric(rollbacks, autoRollbacks)
    }
  }
  if (activeMemories === null && memoryHealth) {
    const activeRecords = nonNegIntOrNull(memoryHealth['activeRecords'])
    if (activeRecords !== null) activeMemories = activeRecords
  }
  if (prefHealth && !hasPrefDb) {
    const active = nonNegIntOrNull(prefHealth['active'])
    if (active !== null) activePreferenceOverlays = addMetric(activePreferenceOverlays, active)
    const hypotheses = nonNegIntOrNull(prefHealth['hypotheses'])
    if (hypotheses !== null) candidatesGenerated = addMetric(candidatesGenerated, hypotheses)
    const rolledBack = nonNegIntOrNull(prefHealth['rolledBack'])
    if (rolledBack !== null) rollbacks = addMetric(rollbacks, rolledBack)
  }
  if (!hasMemoryLearningDb && memoryLearningHealth) {
    const adopted = nonNegIntOrNull(memoryLearningHealth['adopted'])
    if (adopted !== null) candidatesAdopted = addMetric(candidatesAdopted, adopted)
  }
  if (workflowCandidatesPromoted === null && growthExpHealth) {
    const promoted = nonNegIntOrNull(growthExpHealth['promoted'])
    if (promoted !== null) workflowCandidatesPromoted = promoted
  }

  // Plugin inventory: pluginManager.listBundles -> loader.entries -> node_modules (Tier 3 fallback)
  let runtimePluginSourceUsed = false
  const pluginManager = ctx.get('pluginManager' as never) as PluginManagerLike | undefined
  if (typeof pluginManager?.listBundles === 'function') {
    try {
      const bundles = await pluginManager.listBundles()
      pluginSourceAvailable = true
      runtimePluginSourceUsed = true
      for (const bundle of bundles) {
        const pkgName = textOrNull(bundle.name)
        if (!pkgName || !pkgName.startsWith('@dsh-ray/')) continue
        if (bundle.error?.code === 'not-bundle') continue
        const boundedName = boundNonEmptyString(pkgName, 200)
        if (!boundedName) continue
        const boundedVer = boundNonEmptyString(bundle.version, 128) ?? null
        const key = normalizePluginKey(boundedName)
        const existingEvolved = evolvedMap.get(key)
        if (existingEvolved) {
          existingEvolved.name = boundedName
          if (boundedVer !== null && (existingEvolved.version === null || /^v\d+$/u.test(existingEvolved.version))) {
            existingEvolved.version = boundedVer
            existingEvolved.versionTier = 3
          }
          existingEvolved.enabled = Boolean(bundle.enabled)
          continue
        }
        if (coreByKey.has(key)) continue
        coreByKey.set(key, {
          name: boundedName,
          version: boundedVer,
          installKind: 'npm',
          enabledStates: [Boolean(bundle.enabled)],
        })
      }
    } catch {
      diagnostics.push('pluginManager.listBundles failed')
    }
  }

  const loader = ctx.get('loader' as never) as LoaderLike | undefined
  if (typeof loader?.entries === 'function') {
    try {
      pluginSourceAvailable = true
      runtimePluginSourceUsed = true
      for (const entry of loader.entries()) {
        const pkgName = textOrNull(entry.options?.name)
        if (!pkgName || !pkgName.startsWith('@dsh-ray/')) continue
        const boundedName = boundNonEmptyString(pkgName, 200)
        if (!boundedName) continue
        const key = normalizePluginKey(boundedName)
        const enabled = !(entry.disabled === true || entry.options?.disabled === true)
        const existingEvolved = evolvedMap.get(key)
        if (existingEvolved) {
          existingEvolved.name = boundedName
          existingEvolved.enabled = enabled
          continue
        }
        const existingCore = coreByKey.get(key)
        if (existingCore) {
          existingCore.enabledStates = [enabled]
        } else {
          coreByKey.set(key, {
            name: boundedName,
            version: null,
            installKind: 'local',
            enabledStates: [enabled],
          })
        }
      }
    } catch {
      diagnostics.push('loader.entries failed')
    }
  }

  if (boundary.dshHome && !boundary.homeUnsafe) {
    const nmDirs: Array<{ dir: string; profName: string | null }> = [
      { dir: join(boundary.dshHome, 'node_modules'), profName: null },
      ...targetProfiles.map(prof => ({
        dir: join(boundary.dshHome!, 'profiles', prof, 'node_modules'),
        profName: prof,
      })),
    ]
    for (const { dir: nmDir, profName } of nmDirs) {
      const found = readNodeModulesPackages(nmDir, boundary)
      if (found.size > 0) pluginSourceAvailable = true
      const profPatchStates = profName ? patchStatesByProfile.get(profName) : undefined
      for (const [pkgName, info] of found) {
        const boundedName = boundNonEmptyString(pkgName, 200)
        if (!boundedName) continue
        const key = normalizePluginKey(boundedName)
        const diskVer = boundNonEmptyString(info.version, 128) ?? null
        const existingEvolved = evolvedMap.get(key)
        if (existingEvolved) {
          existingEvolved.name = boundedName
          if (diskVer !== null && (existingEvolved.version === null || /^v\d+$/u.test(existingEvolved.version))) {
            existingEvolved.version = diskVer
            existingEvolved.versionTier = 3
          }
          continue
        }
        const ps = profPatchStates?.get(pkgName)
        const yamlEnabledVal = ps !== undefined
          ? !(ps.disabled || ps.configEnabled === false)
          : undefined
        const existingCore = coreByKey.get(key)
        if (existingCore) {
          if (existingCore.version === null && diskVer !== null) existingCore.version = diskVer
          if (info.installKind === 'npm' && existingCore.installKind === 'local' && runtimePluginSourceUsed) {
            existingCore.installKind = 'npm'
          } else if (info.installKind === 'local') {
            existingCore.installKind = 'local'
          }
          if (!runtimePluginSourceUsed) existingCore.enabledStates.push(yamlEnabledVal)
        } else {
          coreByKey.set(key, {
            name: boundedName,
            version: diskVer,
            installKind: info.installKind,
            enabledStates: runtimePluginSourceUsed ? [] : [yamlEnabledVal],
          })
        }
      }
    }
  }

  // Finalize plugin partition
  const corePlugins: AssistantVersionPluginEntry[] = [...coreByKey.values()]
    .map((entry): AssistantVersionPluginEntry | undefined => {
      const boundedName = boundNonEmptyString(entry.name, 200)
      if (boundedName === undefined) return undefined
      const boundedVer = entry.version === null ? null : boundNonEmptyString(entry.version, 128) ?? null
      const defined = entry.enabledStates.filter((v): v is boolean => v !== undefined)
      const enabled = defined.length > 0 ? defined.some(Boolean) : undefined
      return {
        name: boundedName,
        version: boundedVer,
        kind: 'core',
        ...(entry.installKind === undefined ? {} : { installKind: entry.installKind }),
        ...(enabled === undefined ? {} : { enabled }),
      }
    })
    .filter((entry): entry is AssistantVersionPluginEntry => entry !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name))

  const evolvedPlugins: AssistantVersionPluginEntry[] = [...evolvedMap.values()]
    .map((entry): AssistantVersionPluginEntry | undefined => {
      const boundedName = boundNonEmptyString(entry.name, 200)
      if (boundedName === undefined) return undefined
      const rawVer = entry.version === null && entry.fromAdoptionJournal ? 'v1' : entry.version
      const boundedVer = rawVer === null ? null : boundNonEmptyString(rawVer, 128) ?? null
      return {
        name: boundedName,
        version: boundedVer,
        kind: 'evolved',
        installKind: 'adopted',
        ...(entry.enabled === undefined ? {} : { enabled: entry.enabled }),
      }
    })
    .filter((entry): entry is AssistantVersionPluginEntry => entry !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name))

  const activeEvolvedCount = evolvedPlugins.filter(entry => entry.enabled === true).length
  const pluginsState: 'ok' | 'zero' | 'unavailable' = corePlugins.length > 0 || evolvedPlugins.length > 0
    ? 'ok'
    : (pluginSourceAvailable || boundary.profiles.length > 0 || sawControlPlaneDb)
      ? 'zero'
      : 'unavailable'

  const numericMetrics: Array<number | null> = [
    workItemsTotal,
    workItemsSettled,
    growthUsageJobsTotal,
    dreamingRuns,
    recoveryRuns,
    goalStrategyRuns,
    candidatesGenerated,
    candidatesAdopted,
    pluginsCreated,
    pluginsRevised,
    taskVerificationsDone,
    rollbacks,
    evolutionRulesAdopted,
    associationParamVersion,
    associationProfileAdoptions,
    evaluationAttentionTuningAdoptions,
    evaluationLooseningDecisionsAdopted,
    activeMemories,
    activePreferenceOverlays,
    workflowCandidatesPromoted,
    skillDeployments,
    selfUpgrades,
    backupSnapshotsCount,
  ]
  const hasAnySource = numericMetrics.some(value => value !== null)
  const hasNonZero = numericMetrics.some(value => value !== null && value > 0)
  const dataState: 'no-data' | 'zero' | 'data' = !hasAnySource
    ? 'no-data'
    : (hasNonZero ? 'data' : 'zero')

  const iterationDriversSum =
    (workItemsTotal ?? 0)
    + (growthUsageJobsTotal ?? 0)
    + (dreamingRuns ?? 0)
    + (recoveryRuns ?? 0)
    + (goalStrategyRuns ?? 0)
    + (evolutionRulesAdopted ?? 0)
    + (associationProfileAdoptions ?? 0)
    + (evaluationAttentionTuningAdoptions ?? 0)
    + (evaluationLooseningDecisionsAdopted ?? 0)
    + (selfUpgrades ?? 0)
  const totalIterations: number | null = dataState === 'no-data'
    ? null
    : iterationDriversSum > 0
      ? iterationDriversSum
      : dataState === 'data'
        ? Math.max(
            candidatesGenerated ?? 0,
            candidatesAdopted ?? 0,
            pluginsCreated ?? 0,
            pluginsRevised ?? 0,
            activeMemories ?? 0,
            activePreferenceOverlays ?? 0,
            workflowCandidatesPromoted ?? 0,
            skillDeployments ?? 0,
            taskVerificationsDone ?? 0,
            1,
          )
        : 0

  const boundedDshHome = boundary.dshHome === null
    ? undefined
    : truncateText(boundary.canonicalDshHome ?? boundary.dshHome, 4_096)
  const boundedAssistantVersion = boundNonEmptyString(assistantVersion, 128) ?? '0.0.0'
  const boundedBoundVersion = boundNonEmptyString(hostMeta.boundVersion, 128) ?? null
  const boundedBoundStatus = boundNonEmptyString(hostMeta.boundStatus, 64) ?? 'unknown'
  const boundedRunningVersion = boundNonEmptyString(runningVersion, 128) ?? null
  const boundedProfile = boundNonEmptyString(boundary.profile, 128)
  const boundedProfiles = boundary.profiles
    .map(p => boundNonEmptyString(p, 128))
    .filter((p): p is string => p !== undefined)
    .slice(0, 64)
  const boundedInspectedLedgers = [...new Set(inspectedLedgers)]
    .sort()
    .map(entry => boundNonEmptyString(entry, 4_096))
    .filter((entry): entry is string => entry !== undefined)
    .slice(0, 256)
  const boundedDiagnostics = diagnostics
    .map(entry => boundNonEmptyString(entry, 1_024))
    .filter((entry): entry is string => entry !== undefined)
    .slice(0, 128)

  return {
    schemaVersion: 1,
    protocol: 'dsh-ray/version/v1',
    generatedAt,
    ...(boundedDshHome === undefined ? {} : { dshHome: boundedDshHome }),
    assistant: {
      name: 'dsh-ray',
      version: boundedAssistantVersion,
    },
    host: {
      packageName: '@deepseek-ai/dsh',
      boundVersion: boundedBoundVersion,
      boundStatus: boundedBoundStatus,
      runningVersion: boundedRunningVersion,
    },
    ...(boundedProfile === undefined ? {} : { profile: boundedProfile }),
    ...(boundedProfiles.length === 0 ? {} : { profiles: boundedProfiles }),
    plugins: {
      state: pluginsState,
      coreCount: corePlugins.length,
      evolvedCount: evolvedPlugins.length,
      activeEvolvedCount,
      core: corePlugins.slice(0, 256),
      evolved: evolvedPlugins.slice(0, 256),
    },
    selfIteration: {
      dataState,
      totalIterations,
      workItemsTotal,
      workItemsSettled,
      growthUsageJobsTotal,
      dreamingRuns,
      recoveryRuns,
      goalStrategyRuns,
      candidatesGenerated,
      candidatesAdopted,
      pluginsCreated,
      pluginsRevised,
      taskVerificationsDone,
      rollbacks,
      evolutionRulesAdopted,
      associationParamVersion,
      associationProfileAdoptions,
      evaluationAttentionTuningAdoptions,
      evaluationLooseningDecisionsAdopted,
      activeMemories,
      activePreferenceOverlays,
      workflowCandidatesPromoted,
      skillDeployments,
      selfUpgrades,
      backupSnapshotsCount,
    },
    ...(boundedInspectedLedgers.length === 0 ? {} : { inspectedLedgers: boundedInspectedLedgers }),
    ...(boundedDiagnostics.length === 0 ? {} : { diagnostics: boundedDiagnostics }),
  }
}

function fmtCount(value: number | null): string {
  return value === null ? '无数据' : String(value)
}

export function formatAssistantVersionSummary(report: Readonly<AssistantVersionReport>): string {
  const s = report.selfIteration
  const lines: string[] = [
    `助手版本：${report.assistant.name} v${report.assistant.version}`
    + (report.assistant.cliVersion ? `（CLI v${report.assistant.cliVersion}）` : ''),
    `Host（${report.host.packageName}）：运行 ${report.host.runningVersion ?? '未知'}；绑定 ${report.host.boundVersion ?? '未绑定'}（${report.host.boundStatus}）`,
  ]
  if (report.profile !== undefined && report.profile !== null) {
    lines.push(`当前 Profile：${report.profile}`
      + (report.profiles && report.profiles.length > 0 ? `（全部：${report.profiles.join(', ')}）` : ''))
  }
  if (report.plugins.state === 'unavailable') {
    lines.push('插件概览：暂无插件目录信息')
  } else {
    lines.push(
      `插件概览：核心插件 ${report.plugins.coreCount} 个；自演进插件 ${report.plugins.evolvedCount} 个（启用 ${report.plugins.activeEvolvedCount} 个）`,
    )
    if (report.plugins.evolved.length > 0) {
      const preview = report.plugins.evolved
        .slice(0, 8)
        .map(p => `${p.name}${p.version ? `@${p.version}` : ''}`)
        .join('、')
      lines.push(`自演进插件列表：${preview}${report.plugins.evolved.length > 8 ? ' 等' : ''}`)
    }
  }

  if (s.dataState === 'no-data') {
    lines.push('自迭代演进统计：无数据（未检测到已初始化的账本或运行记录）')
  } else {
    lines.push(
      `自迭代演进统计（${s.dataState === 'zero' ? '暂无记录' : '已采集'}）：`,
      `- 累计自迭代次数：${fmtCount(s.totalIterations)}`,
      `- 工作项（总计 / 已结算）：${fmtCount(s.workItemsTotal)} / ${fmtCount(s.workItemsSettled)}；用法学习任务：${fmtCount(s.growthUsageJobsTotal)}`,
      `- 做梦 / 修复 / 策略运行：${fmtCount(s.dreamingRuns)} / ${fmtCount(s.recoveryRuns)} / ${fmtCount(s.goalStrategyRuns)}`,
      `- 候选生成 / 独立采用：${fmtCount(s.candidatesGenerated)} / ${fmtCount(s.candidatesAdopted)}；独立验证完成：${fmtCount(s.taskVerificationsDone)}；回滚：${fmtCount(s.rollbacks)}`,
      `- 插件创建 / 插件修订：${fmtCount(s.pluginsCreated)} / ${fmtCount(s.pluginsRevised)}；演进规则采用：${fmtCount(s.evolutionRulesAdopted)}`,
      `- 联想参数版本 / 档位采用：${fmtCount(s.associationParamVersion)} / ${fmtCount(s.associationProfileAdoptions)}；评估调优 / 放宽采用：${fmtCount(s.evaluationAttentionTuningAdoptions)} / ${fmtCount(s.evaluationLooseningDecisionsAdopted)}`,
      `- 激活记忆 / 偏好叠加：${fmtCount(s.activeMemories)} / ${fmtCount(s.activePreferenceOverlays)}；工作流晋升 / 技能部署：${fmtCount(s.workflowCandidatesPromoted)} / ${fmtCount(s.skillDeployments)}`,
      `- 自我升级次数 / 备份快照：${fmtCount(s.selfUpgrades)} / ${fmtCount(s.backupSnapshotsCount)}`,
    )
  }

  return lines.join('\n')
}
