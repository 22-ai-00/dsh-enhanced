import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
  readonly protocol: 'dsh-rsi/version/v1'
  readonly generatedAt: number
  readonly dshHome?: string | null
  readonly assistant: {
    readonly name: 'dsh-enhanced'
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
const MAX_UPGRADE_HISTORY_BYTES = 2 * 1024 * 1024
const MAX_PATCH_SCAN_BYTES = 256 * 1024
const DSH_HOME_EXPR_RE = /^(?:!!js\s+)?dshHomePath\(\s*(['"])([^'"\r\n]+)\1\s*\)$/u

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
  const filePath = join(boundary.canonicalDshHome, '.dsh-rsi-host.json')
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
    diagnostics.push(`skipped unsafe sqlite sidecar: ${relative(boundary.canonicalDshHome, realTarget)}`)
    return undefined
  }

  const immutableUri = pathToFileURL(realTarget)
  immutableUri.search = 'mode=ro&immutable=1'
  const ledgerRel = relative(boundary.canonicalDshHome, realTarget)

  let db: DatabaseSync | undefined
  if (canPreferImmutable(realTarget)) {
    const immutableRes = tryOpenReadOnlySqlite(immutableUri.href)
    if (immutableRes.ok) {
      db = immutableRes.db
    } else if (immutableRes.integrityFailed) {
      diagnostics.push(`sqlite quick_check failed: ${ledgerRel}`)
      return undefined
    } else {
      const plainRes = tryOpenReadOnlySqlite(realTarget)
      if (plainRes.ok) {
        db = plainRes.db
      } else if (plainRes.integrityFailed) {
        diagnostics.push(`sqlite quick_check failed: ${ledgerRel}`)
        return undefined
      } else {
        const err = plainRes.error ?? immutableRes.error
        diagnostics.push(
          `sqlite read failed (${ledgerRel}): ${err instanceof Error ? err.message : String(err)}`,
        )
        return undefined
      }
    }
  } else {
    const primaryRes = tryOpenReadOnlySqlite(realTarget)
    if (primaryRes.ok) {
      db = primaryRes.db
    } else if (primaryRes.integrityFailed) {
      diagnostics.push(`sqlite quick_check failed: ${ledgerRel}`)
      return undefined
    } else if (canFallbackImmutable(realTarget)) {
      const immutableRes = tryOpenReadOnlySqlite(immutableUri.href)
      if (immutableRes.ok) {
        db = immutableRes.db
      } else if (immutableRes.integrityFailed) {
        diagnostics.push(`sqlite quick_check failed: ${ledgerRel}`)
        return undefined
      } else {
        const err = immutableRes.error ?? primaryRes.error
        diagnostics.push(
          `sqlite read failed (${ledgerRel}): ${err instanceof Error ? err.message : String(err)}`,
        )
        return undefined
      }
    } else {
      diagnostics.push(
        `sqlite read failed (${ledgerRel}): ${primaryRes.error instanceof Error ? primaryRes.error.message : String(primaryRes.error)}`,
      )
      return undefined
    }
  }

  try {
    inspectedLedgers.push(ledgerRel)
    return fn(db, realTarget)
  } catch (error) {
    diagnostics.push(
      `sqlite read failed (${ledgerRel}): `
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

function resolvePathExpr(rawValue: unknown, dshHome: string): string | undefined {
  let exprSource: string | undefined
  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim()
    if (trimmed === '' || trimmed.includes('\0') || trimmed === ':memory:') return undefined
    const match = DSH_HOME_EXPR_RE.exec(trimmed)
    if (match?.[2]) {
      exprSource = match[2]
    } else if (isAbsolute(trimmed)) {
      return resolve(trimmed)
    } else {
      return undefined
    }
  } else if (typeof rawValue === 'object' && rawValue !== null && '__jsExpr' in rawValue) {
    const rawExpr = (rawValue as { __jsExpr?: unknown }).__jsExpr
    if (typeof rawExpr !== 'string') return undefined
    const match = DSH_HOME_EXPR_RE.exec(rawExpr.trim())
    if (!match?.[2]) return undefined
    exprSource = match[2]
  } else {
    return undefined
  }
  if (
    exprSource.includes('\0')
    || isAbsolute(exprSource)
    || exprSource.split('/').some(seg => seg === '..' || seg === '.')
  ) {
    return undefined
  }
  return resolve(dshHome, exprSource)
}

function collectSqliteDirs(dir: string, boundary: ResolvedBoundary): string[] {
  if (!boundary.dshHome || !boundary.canonicalDshHome || boundary.homeUnsafe) return []
  if (!existsSync(dir)) return []
  try {
    const st = lstatSync(dir)
    if (!st.isDirectory() || st.isSymbolicLink()) return []
    const realDir = realpathSync(dir)
    if (!realDir.startsWith(`${boundary.canonicalDshHome}${sep}`)) return []
    const results: string[] = []
    for (const entry of readdirSync(realDir, { withFileTypes: true })) {
      if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.sqlite')) {
        results.push(join(realDir, entry.name))
      }
    }
    return results
  } catch {
    return []
  }
}

function discoverCandidateSqlitePaths(ctx: Context, boundary: ResolvedBoundary): string[] {
  const candidates = new Set<string>()
  const addPath = (value: string | undefined): void => {
    if (value && value.endsWith('.sqlite')) candidates.add(value)
  }

  if (boundary.dshHome) {
    const loader = ctx.get('loader' as never) as LoaderLike | undefined
    if (typeof loader?.entries === 'function') {
      try {
        for (const entry of loader.entries()) {
          const rawCfg = rec(entry.options?.config)
          const effCfg = rec(entry.fiber?.config)
          for (const cfg of [effCfg, rawCfg]) {
            addPath(resolvePathExpr(cfg['databasePath'], boundary.dshHome))
            addPath(resolvePathExpr(rec(cfg['usageLearning'])['databasePath'], boundary.dshHome))
            addPath(resolvePathExpr(rec(cfg['personalMemory'])['databasePath'], boundary.dshHome))
            const stateDir = resolvePathExpr(cfg['statePath'], boundary.dshHome)
            if (stateDir) {
              for (const db of collectSqliteDirs(stateDir, boundary)) addPath(db)
            }
          }
        }
      } catch {
        // Best-effort loader inspection.
      }
    }

    const pluginDirs = [
      'assistant-work-items',
      'assistant-growth-driver',
      'assistant-dreaming',
      'assistant-recovery',
      'assistant-goals',
      'plugin-control-plane',
      'assistant-verifier',
      'assistant-evolution',
      'assistant-association',
      'assistant-evaluation',
      'personal-memory',
      'preference-learning',
      'assistant-memory-learning',
      'assistant-growth-experiments',
      'assistant-skills',
    ]
    for (const dirName of pluginDirs) {
      for (const db of collectSqliteDirs(join(boundary.dshHome, dirName), boundary)) {
        addPath(db)
      }
      if (boundary.profile) {
        for (const db of collectSqliteDirs(join(boundary.dshHome, 'profiles', boundary.profile, dirName), boundary)) {
          addPath(db)
        }
      }
    }

    addPath(join(boundary.dshHome, 'association.sqlite'))
    if (boundary.profile) {
      addPath(join(boundary.dshHome, `${boundary.profile}-creation-adoptions.sqlite`))
      addPath(join(boundary.dshHome, `${boundary.profile}-revision-adoptions.sqlite`))
      for (const db of collectSqliteDirs(
        join(boundary.dshHome, 'rsi-authorities', boundary.profile, 'state', 'control-plane'),
        boundary,
      )) {
        addPath(db)
      }
    }
    for (const db of collectSqliteDirs(boundary.dshHome, boundary)) {
      if (basename(db) !== 'state.sqlite') addPath(db)
    }
  }

  return [...candidates]
}

function scanProfileYamlPackageNames(boundary: ResolvedBoundary): Set<string> {
  const names = new Set<string>()
  if (!boundary.dshHome || !boundary.profile) return names
  const candidateFiles = [
    join(boundary.dshHome, 'profiles', `${boundary.profile}.yml`),
    join(boundary.dshHome, 'profiles', `${boundary.profile}.yaml`),
    join(boundary.dshHome, 'profiles', boundary.profile, 'cordis.yml'),
    join(boundary.dshHome, 'profiles', boundary.profile, 'cordis.patch.yml'),
  ]
  for (const file of candidateFiles) {
    const raw = readBoundedRegularFile(file, boundary, MAX_PATCH_SCAN_BYTES)
    if (raw === undefined) continue
    for (const line of raw.split(/\r?\n/u)) {
      const match = /(?:^|[\s:'"-])(@dsh-enhanced\/[a-z0-9-]+)(?:$|[\s:'",])/u.exec(line)
      if (match?.[1]) names.add(match[1])
    }
  }
  return names
}

function readNodeModulesPackages(
  dir: string,
  boundary: ResolvedBoundary,
): Map<string, { version: string | null; installKind: 'npm' | 'local' }> {
  const found = new Map<string, { version: string | null; installKind: 'npm' | 'local' }>()
  if (!boundary.dshHome || !boundary.canonicalDshHome || boundary.homeUnsafe) return found
  const scopeDir = join(dir, '@dsh-enhanced')
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
        if (pkgName !== null && pkgName.startsWith('@dsh-enhanced/')) {
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

  // Plugin inventory tracking
  const pluginMap = new Map<string, {
    name: string
    version: string | null
    kind: 'core' | 'evolved'
    installKind?: 'npm' | 'local' | 'adopted'
    enabled?: boolean
  }>()
  const evolvedNames = new Set<string>()
  let pluginSourceAvailable = false

  const pluginManager = ctx.get('pluginManager' as never) as PluginManagerLike | undefined
  if (typeof pluginManager?.listBundles === 'function') {
    try {
      const bundles = await pluginManager.listBundles()
      pluginSourceAvailable = true
      for (const bundle of bundles) {
        const pkgName = textOrNull(bundle.name)
        if (!pkgName || !pkgName.startsWith('@dsh-enhanced/')) continue
        if (bundle.error?.code === 'not-bundle') continue
        pluginMap.set(pkgName, {
          name: pkgName,
          version: textOrNull(bundle.version),
          kind: 'core',
          installKind: 'npm',
          enabled: Boolean(bundle.enabled),
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
      for (const entry of loader.entries()) {
        const pkgName = textOrNull(entry.options?.name)
        if (!pkgName || !pkgName.startsWith('@dsh-enhanced/')) continue
        const enabled = !(entry.disabled === true || entry.options?.disabled === true)
        const existing = pluginMap.get(pkgName)
        if (existing) {
          pluginMap.set(pkgName, { ...existing, enabled })
        } else {
          pluginMap.set(pkgName, {
            name: pkgName,
            version: null,
            kind: 'core',
            installKind: 'local',
            enabled,
          })
        }
      }
    } catch {
      diagnostics.push('loader.entries failed')
    }
  }

  if (boundary.dshHome) {
    const searchNodeModules = [
      join(boundary.dshHome, 'node_modules'),
      ...(boundary.profile ? [join(boundary.dshHome, 'profiles', boundary.profile, 'node_modules')] : []),
    ]
    for (const nmDir of searchNodeModules) {
      const found = readNodeModulesPackages(nmDir, boundary)
      if (found.size > 0) pluginSourceAvailable = true
      for (const [pkgName, info] of found) {
        const existing = pluginMap.get(pkgName)
        if (existing) {
          pluginMap.set(pkgName, { ...existing, version: existing.version ?? info.version })
        } else {
          pluginMap.set(pkgName, {
            name: pkgName,
            version: info.version,
            kind: 'core',
            installKind: info.installKind,
          })
        }
      }
    }
    const yamlNames = scanProfileYamlPackageNames(boundary)
    if (yamlNames.size > 0) pluginSourceAvailable = true
    for (const pkgName of yamlNames) {
      if (!pluginMap.has(pkgName)) {
        pluginMap.set(pkgName, {
          name: pkgName,
          version: null,
          kind: 'core',
          installKind: 'local',
        })
      }
    }
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

  const createdPlanIds = new Set<string>()
  const revisedPlanIds = new Set<string>()
  let hasCpActivationDb = false
  let hasEvoProposalsDb = false
  let hasEvoRulesDb = false
  let hasEvoRollbacksDb = false
  let hasPrefDb = false
  let hasMemoryLearningDb = false

  const dbPaths = discoverCandidateSqlitePaths(ctx, boundary)
  for (const dbPath of dbPaths) {
    withReadOnlySqlite(dbPath, boundary, seenRealPaths, inspectedLedgers, diagnostics, db => {
      // Work items
      if (hasTable(db, 'work_item') && hasColumn(db, 'work_item', 'state')) {
        workItemsTotal = addMetric(workItemsTotal, countQuery(db, 'SELECT COUNT(*) AS n FROM work_item'))
        workItemsSettled = addMetric(
          workItemsSettled,
          countQuery(db, "SELECT COUNT(*) AS n FROM work_item WHERE state IN ('ready','blocked','failed','dropped')"),
        )
      } else if (hasTable(db, 'work_item_outcome') && hasColumn(db, 'work_item_outcome', 'item_id')) {
        workItemsSettled = addMetric(
          workItemsSettled,
          countQuery(db, 'SELECT COUNT(DISTINCT item_id) AS n FROM work_item_outcome'),
        )
      }

      // Growth driver usage jobs
      if (hasTable(db, 'usage_jobs')) {
        growthUsageJobsTotal = addMetric(growthUsageJobsTotal, countQuery(db, 'SELECT COUNT(*) AS n FROM usage_jobs'))
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
      } else if (hasTable(db, 'goal_execution_runs')) {
        goalStrategyRuns = addMetric(goalStrategyRuns, countQuery(db, 'SELECT COUNT(*) AS n FROM goal_execution_runs'))
      }

      // Plugin control plane: source_plans
      if (hasTable(db, 'source_plans') && hasColumn(db, 'source_plans', 'mode') && hasColumn(db, 'source_plans', 'status')) {
        candidatesGenerated = addMetric(candidatesGenerated, countQuery(db, 'SELECT COUNT(*) AS n FROM source_plans'))
        pluginsCreated = pluginsCreated ?? 0
        pluginsRevised = pluginsRevised ?? 0
        const createdRows = db.prepare(
          "SELECT id, plugin_name FROM source_plans WHERE (mode IS NULL OR mode = 'create') AND status = 'release-complete'",
        ).all() as Array<{ id?: unknown; plugin_name?: unknown }>
        for (const row of createdRows) {
          const id = textOrNull(row.id)
          if (id) createdPlanIds.add(id)
          const pluginName = textOrNull(row.plugin_name)
          if (pluginName) {
            evolvedNames.add(pluginName)
            pluginSourceAvailable = true
            const existing = pluginMap.get(pluginName)
            pluginMap.set(pluginName, {
              name: pluginName,
              version: existing?.version ?? null,
              kind: 'evolved',
              installKind: 'adopted',
              ...(existing?.enabled === undefined ? {} : { enabled: existing.enabled }),
            })
          }
        }
        const revisedRows = db.prepare(
          "SELECT id FROM source_plans WHERE mode IN ('modify', 'prepared-revise') AND status = 'release-complete'",
        ).all() as Array<{ id?: unknown }>
        for (const row of revisedRows) {
          const id = textOrNull(row.id)
          if (id) revisedPlanIds.add(id)
        }
      }

      // Plugin control plane: activation_plans
      if (hasTable(db, 'activation_plans') && hasColumn(db, 'activation_plans', 'status')) {
        hasCpActivationDb = true
        candidatesAdopted = addMetric(
          candidatesAdopted,
          countQuery(db, "SELECT COUNT(*) AS n FROM activation_plans WHERE status = 'activated'"),
        )
        rollbacks = addMetric(
          rollbacks,
          countQuery(db, "SELECT COUNT(*) AS n FROM activation_plans WHERE status IN ('rolled-back', 'rollback-pending')"),
        )
      }

      // Creation capability journal: adoptions (plan_id, status, certificate_json, receipt_json)
      if (hasTable(db, 'adoptions') && hasColumn(db, 'adoptions', 'status') && hasColumn(db, 'adoptions', 'certificate_json')) {
        pluginsCreated = pluginsCreated ?? 0
        const hasReceipt = hasColumn(db, 'adoptions', 'receipt_json')
        const rows = db.prepare(
          `SELECT plan_id, status, certificate_json${hasReceipt ? ', receipt_json' : ''} FROM adoptions WHERE status IN ('authorized', 'active')`,
        ).all() as Array<{ plan_id?: unknown; status?: unknown; certificate_json?: unknown; receipt_json?: unknown }>
        for (const row of rows) {
          const planId = textOrNull(row.plan_id)
          if (planId) createdPlanIds.add(planId)
          if (typeof row.certificate_json === 'string') {
            try {
              const cert = rec(JSON.parse(row.certificate_json))
              const planObj = rec(cert['plan'])
              let receiptObj: Record<string, unknown> = {}
              if (typeof row.receipt_json === 'string') {
                try {
                  receiptObj = rec(JSON.parse(row.receipt_json))
                } catch {
                  receiptObj = {}
                }
              }
              const pluginName = textOrNull(planObj['name'])
                ?? textOrNull(cert['packageName'])
                ?? textOrNull(cert['pluginName'])
                ?? textOrNull(cert['name'])
              const ver = textOrNull(receiptObj['version'])
                ?? textOrNull(planObj['version'])
                ?? textOrNull(cert['version'])
                ?? textOrNull(cert['pluginVersion'])
              if (pluginName) {
                evolvedNames.add(pluginName)
                pluginSourceAvailable = true
                const existing = pluginMap.get(pluginName)
                pluginMap.set(pluginName, {
                  name: pluginName,
                  version: existing?.version ?? ver,
                  kind: 'evolved',
                  installKind: 'adopted',
                  enabled: row.status === 'active' || row.status === 'authorized',
                })
              }
            } catch {
              // Ignore malformed certificate JSON.
            }
          }
        }
      }

      // Revision capability journal: entries + versions + rollbacks
      if (hasTable(db, 'versions') && hasColumn(db, 'versions', 'role') && hasColumn(db, 'versions', 'plan_id')) {
        pluginsRevised = pluginsRevised ?? 0
        const rows = db.prepare("SELECT plan_id FROM versions WHERE role = 'revision'").all() as Array<{ plan_id?: unknown }>
        for (const row of rows) {
          const planId = textOrNull(row.plan_id)
          if (planId) revisedPlanIds.add(planId)
        }
      }
      if (hasTable(db, 'entries') && hasColumn(db, 'entries', 'name') && hasColumn(db, 'entries', 'revision')) {
        const entryRows = db.prepare('SELECT name, revision FROM entries').all() as Array<{ name?: unknown; revision?: unknown }>
        for (const row of entryRows) {
          const pluginName = textOrNull(row.name)
          const revNum = nonNegIntOrNull(row.revision)
          if (pluginName) {
            evolvedNames.add(pluginName)
            pluginSourceAvailable = true
            const existing = pluginMap.get(pluginName)
            pluginMap.set(pluginName, {
              name: pluginName,
              version: existing?.version ?? (revNum !== null ? `v${revNum}` : null),
              kind: 'evolved',
              installKind: 'adopted',
              ...(existing?.enabled === undefined ? {} : { enabled: existing.enabled }),
            })
          }
        }
      }
      if (hasTable(db, 'rollbacks') && hasColumn(db, 'rollbacks', 'rollback_id')) {
        rollbacks = addMetric(rollbacks, countQuery(db, 'SELECT COUNT(*) AS n FROM rollbacks'))
      }

      // Verifier
      if (hasTable(db, 'acceptance_jobs') && hasColumn(db, 'acceptance_jobs', 'state')) {
        taskVerificationsDone = addMetric(
          taskVerificationsDone,
          countQuery(db, "SELECT COUNT(*) AS n FROM acceptance_jobs WHERE state = 'done'"),
        )
      }

      // Evolution
      if (hasTable(db, 'evolution_proposals') && hasColumn(db, 'evolution_proposals', 'status')) {
        hasEvoProposalsDb = true
        candidatesGenerated = addMetric(candidatesGenerated, countQuery(db, 'SELECT COUNT(*) AS n FROM evolution_proposals'))
        candidatesAdopted = addMetric(
          candidatesAdopted,
          countQuery(db, "SELECT COUNT(*) AS n FROM evolution_proposals WHERE status = 'approved'"),
        )
      }
      if (hasTable(db, 'evolution_rules')) {
        hasEvoRulesDb = true
        evolutionRulesAdopted = addMetric(evolutionRulesAdopted, countQuery(db, 'SELECT COUNT(*) AS n FROM evolution_rules'))
      }
      if (hasTable(db, 'evolution_autonomous_rollbacks')) {
        hasEvoRollbacksDb = true
        rollbacks = addMetric(rollbacks, countQuery(db, 'SELECT COUNT(*) AS n FROM evolution_autonomous_rollbacks'))
      }

      // Association
      if (hasTable(db, 'assoc_param_profile_heads') && hasColumn(db, 'assoc_param_profile_heads', 'active_version')) {
        const row = db.prepare('SELECT MAX(active_version) AS v FROM assoc_param_profile_heads').get() as { v?: unknown } | undefined
        const ver = nonNegIntOrNull(row?.v)
        if (ver !== null) {
          associationParamVersion = maxMetric(associationParamVersion, ver)
        } else {
          associationParamVersion = associationParamVersion ?? 0
        }
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
      if (hasTable(db, 'assoc_param_relax_decisions') && hasColumn(db, 'assoc_param_relax_decisions', 'status')) {
        candidatesAdopted = addMetric(
          candidatesAdopted,
          countQuery(db, "SELECT COUNT(*) AS n FROM assoc_param_relax_decisions WHERE status = 'adopted'"),
        )
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
        candidatesAdopted = addMetric(candidatesAdopted, adopted)
      }

      // Personal memory
      if (hasTable(db, 'memory_records') && hasColumn(db, 'memory_records', 'status')) {
        activeMemories = addMetric(
          activeMemories,
          countQuery(db, "SELECT COUNT(*) AS n FROM memory_records WHERE status = 'active'"),
        )
      }

      // Preference learning
      if (hasTable(db, 'preference_hypotheses') && hasColumn(db, 'preference_hypotheses', 'effect_state')) {
        hasPrefDb = true
        candidatesGenerated = addMetric(candidatesGenerated, countQuery(db, 'SELECT COUNT(*) AS n FROM preference_hypotheses'))
        const activeCount = countQuery(
          db,
          "SELECT COUNT(*) AS n FROM preference_hypotheses WHERE effect_state = 'active'",
        )
        activePreferenceOverlays = addMetric(activePreferenceOverlays, activeCount)
        candidatesAdopted = addMetric(candidatesAdopted, activeCount)
        rollbacks = addMetric(
          rollbacks,
          countQuery(db, "SELECT COUNT(*) AS n FROM preference_hypotheses WHERE effect_state = 'rolled-back'"),
        )
      }

      // Memory learning jobs
      if (hasTable(db, 'jobs') && hasColumn(db, 'jobs', 'state') && hasTable(db, 'grant_record')) {
        hasMemoryLearningDb = true
        candidatesGenerated = addMetric(candidatesGenerated, countQuery(db, 'SELECT COUNT(*) AS n FROM jobs'))
        candidatesAdopted = addMetric(
          candidatesAdopted,
          countQuery(db, "SELECT COUNT(*) AS n FROM jobs WHERE state = 'adopted'"),
        )
      }

      // Growth experiments / workflows
      if (hasTable(db, 'workflow_candidates') && hasColumn(db, 'workflow_candidates', 'state')) {
        candidatesGenerated = addMetric(candidatesGenerated, countQuery(db, 'SELECT COUNT(*) AS n FROM workflow_candidates'))
        const promoted = countQuery(db, "SELECT COUNT(*) AS n FROM workflow_candidates WHERE state = 'promoted'")
        workflowCandidatesPromoted = addMetric(workflowCandidatesPromoted, promoted)
        candidatesAdopted = addMetric(candidatesAdopted, promoted)
        rollbacks = addMetric(
          rollbacks,
          countQuery(db, "SELECT COUNT(*) AS n FROM workflow_candidates WHERE state = 'rolled-back'"),
        )
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
          countQuery(db, "SELECT COUNT(*) AS n FROM skill_deployments WHERE state = 'rolled-back'"),
        )
      }
    })
  }

  if (pluginsCreated !== null || createdPlanIds.size > 0) {
    pluginsCreated = createdPlanIds.size
  }
  if (pluginsRevised !== null || revisedPlanIds.size > 0) {
    pluginsRevised = revisedPlanIds.size
  }

  // Upgrade history & backup snapshots
  if (boundary.dshHome && boundary.canonicalDshHome && !boundary.homeUnsafe) {
    const upgradeHistoryPath = join(boundary.dshHome, '.dsh-enhanced', 'upgrade-history.jsonl')
    const historyText = readBoundedRegularFile(upgradeHistoryPath, boundary, MAX_UPGRADE_HISTORY_BYTES)
    if (historyText !== undefined) {
      let upgradeCount = 0
      for (const line of historyText.split(/\r?\n/u)) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          const parsed = JSON.parse(trimmed) as unknown
          if (typeof parsed === 'object' && parsed !== null) upgradeCount += 1
        } catch {
          // Ignore trailing/corrupt line in JSONL without crashing.
        }
      }
      selfUpgrades = upgradeCount
      inspectedLedgers.push(relative(boundary.canonicalDshHome, realpathSync(upgradeHistoryPath)))
    }

    const backupDir = join(boundary.dshHome, '.dsh-rsi-upgrade-backups')
    if (existsSync(backupDir)) {
      try {
        const st = lstatSync(backupDir)
        if (st.isDirectory() && !st.isSymbolicLink()) {
          const realBackupDir = realpathSync(backupDir)
          if (realBackupDir.startsWith(`${boundary.canonicalDshHome}${sep}`)) {
            let count = 0
            for (const entry of readdirSync(realBackupDir, { withFileTypes: true })) {
              if (entry.isDirectory() && !entry.isSymbolicLink()) count += 1
            }
            backupSnapshotsCount = count
            inspectedLedgers.push(relative(boundary.canonicalDshHome, realBackupDir))
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
        evolutionRulesAdopted = addMetric(evolutionRulesAdopted, (activeRules ?? 0) + (retiredRules ?? 0))
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

  // Finalize plugin partition
  const corePlugins: AssistantVersionPluginEntry[] = []
  const evolvedPlugins: AssistantVersionPluginEntry[] = []
  for (const entry of pluginMap.values()) {
    const boundedName = boundNonEmptyString(entry.name, 200)
    if (boundedName === undefined) continue
    const boundedVer = entry.version === null ? null : boundNonEmptyString(entry.version, 128) ?? null
    const isEvolved = entry.kind === 'evolved' || evolvedNames.has(entry.name)
    const finalized: AssistantVersionPluginEntry = {
      name: boundedName,
      version: boundedVer,
      kind: isEvolved ? 'evolved' : 'core',
      ...(entry.installKind === undefined ? {} : { installKind: isEvolved ? 'adopted' : entry.installKind }),
      ...(entry.enabled === undefined ? {} : { enabled: entry.enabled }),
    }
    if (isEvolved) evolvedPlugins.push(finalized)
    else corePlugins.push(finalized)
  }
  corePlugins.sort((a, b) => a.name.localeCompare(b.name))
  evolvedPlugins.sort((a, b) => a.name.localeCompare(b.name))
  const activeEvolvedCount = evolvedPlugins.filter(entry => entry.enabled === true).length
  const pluginsState: 'ok' | 'zero' | 'unavailable' = !pluginSourceAvailable
    ? 'unavailable'
    : (corePlugins.length + evolvedPlugins.length === 0 ? 'zero' : 'ok')

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
  const boundedInspectedLedgers = inspectedLedgers
    .map(entry => boundNonEmptyString(entry, 4_096))
    .filter((entry): entry is string => entry !== undefined)
    .slice(0, 256)
  const boundedDiagnostics = diagnostics
    .map(entry => boundNonEmptyString(entry, 1_024))
    .filter((entry): entry is string => entry !== undefined)
    .slice(0, 128)

  return {
    schemaVersion: 1,
    protocol: 'dsh-rsi/version/v1',
    generatedAt,
    ...(boundedDshHome === undefined ? {} : { dshHome: boundedDshHome }),
    assistant: {
      name: 'dsh-enhanced',
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
