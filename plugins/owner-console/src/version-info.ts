import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { parseDocument } from 'yaml'
import { formatOwnerConsoleVersionSummary } from './nl-control.js'
import { isProjectPackage, type LoaderService, type PluginManagerService } from './settings.js'
import type { AssistantVersionPluginEntry, AssistantVersionReport } from './typert.js'
import { readBoundHostMetadata, readInstalledHostVersion } from './upgrade-probe.js'
import { version as PACKAGE_VERSION } from './version.js'

export { formatOwnerConsoleVersionSummary }

export interface CollectOwnerConsoleVersionOptions {
  readonly dshHome?: string
  readonly profileName?: string
  readonly now?: number
}

interface SqlitePathBoundary {
  readonly dshHome: string
  readonly canonicalDshHome: string
}

const VALID_PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const MAX_JSONL_BYTES = 4 * 1024 * 1024

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

const rec = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

const nonNegInt = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null

function addCounter(current: number | null, delta: number): number {
  const safeDelta = Number.isFinite(delta) && delta >= 0 ? Math.trunc(delta) : 0
  return current === null ? safeDelta : current + safeDelta
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

function cleanAbsoluteDir(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.includes('\0') || !isAbsolute(trimmed)) return undefined
  return resolve(trimmed)
}

function resolveDshHomeAndProfile(
  host: Context,
  options: CollectOwnerConsoleVersionOptions,
): Readonly<{ dshHome: string | null; profileName: string | null; profileDir: string | null }> {
  const profile = host.get('profileContext' as never) as { dir?: unknown; home?: unknown; name?: unknown } | undefined
  const settings = host.get('settings' as never) as { documentPath?: unknown } | undefined
  const docPath = cleanAbsoluteDir(settings?.documentPath)
  const rawProfileDir = cleanAbsoluteDir(profile?.dir) ?? (docPath ? dirname(docPath) : undefined)

  let dshHome = cleanAbsoluteDir(options.dshHome) ?? cleanAbsoluteDir(profile?.home)
  if (!dshHome && rawProfileDir && basename(dirname(rawProfileDir)) === 'profiles') {
    dshHome = dirname(dirname(rawProfileDir))
  }
  if (!dshHome && docPath) {
    const docDir = dirname(docPath)
    dshHome = basename(dirname(docDir)) === 'profiles' ? dirname(dirname(docDir)) : docDir
  }
  if (!dshHome) {
    dshHome = cleanAbsoluteDir(process.env['DSH_HOME'])
  }

  let profileName: string | null = null
  const candidateNames = [options.profileName, profile?.name, rawProfileDir ? basename(rawProfileDir) : undefined]
  for (const cand of candidateNames) {
    if (typeof cand === 'string' && VALID_PROFILE_NAME_RE.test(cand.trim())) {
      profileName = cand.trim()
      break
    }
  }

  return {
    dshHome: dshHome ?? null,
    profileName,
    profileDir: rawProfileDir ?? (dshHome && profileName ? join(dshHome, 'profiles', profileName) : null),
  }
}

function resolveSqliteBoundary(dshHome: string | null, diagnostics: string[]): SqlitePathBoundary | null {
  if (!dshHome) return null
  try {
    if (!existsSync(dshHome)) return null
    const st = lstatSync(dshHome)
    if (st.isSymbolicLink() || !st.isDirectory()) {
      diagnostics.push(`skipped non-directory or symlink DSH_HOME: ${dshHome}`)
      return null
    }
    const canonicalDshHome = realpathSync(dshHome)
    return { dshHome: resolve(dshHome), canonicalDshHome }
  } catch (error) {
    diagnostics.push(`failed to inspect DSH_HOME (${dshHome}): ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function isWithinBoundary(targetPath: string, realTargetPath: string, boundary: SqlitePathBoundary): boolean {
  const logicallyWithin = targetPath.startsWith(`${boundary.dshHome}${sep}`)
    || targetPath.startsWith(`${boundary.canonicalDshHome}${sep}`)
  const physicallyWithin = realTargetPath.startsWith(`${boundary.canonicalDshHome}${sep}`)
  return logicallyWithin && physicallyWithin
}

function isLoaderEntryDisabled(entry: { readonly disabled?: unknown; readonly options: { readonly disabled?: unknown } }): boolean {
  return entry.disabled === true || entry.options.disabled === true
}

function findLoaderEntryConfigs(
  host: Context,
  moduleName: string,
): Readonly<{ effective: Record<string, unknown>; raw: Record<string, unknown> }> | undefined {
  const loader = host.get('loader' as never) as Partial<LoaderService> | undefined
  if (typeof loader?.entries !== 'function') return undefined
  try {
    for (const entry of loader.entries()) {
      if (entry.options.name === moduleName && !isLoaderEntryDisabled(entry as { disabled?: unknown; options: { disabled?: unknown } })) {
        const fiberCfg = rec((entry.fiber as { config?: unknown } | undefined)?.config)
        return { effective: fiberCfg, raw: rec(entry.options.config) }
      }
    }
  } catch {
    return undefined
  }
  return undefined
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

function resolvePathCandidate(
  rawValue: unknown,
  dshHome: string,
  canonicalHome?: string,
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
    const canon = canonicalHome ?? dshHome
    const within = resolved === dshHome
      || resolved.startsWith(`${dshHome}${sep}`)
      || resolved === canon
      || resolved.startsWith(`${canon}${sep}`)
    if (!within) {
      diagnostics?.push(`skipped out-of-bounds dshHomePath ledger path: ${trimmed}`)
      return undefined
    }
    return resolved
  }
  if (isAbsolute(trimmed)) {
    const resolved = resolve(trimmed)
    const canon = canonicalHome ?? dshHome
    const within = resolved === dshHome
      || resolved.startsWith(`${dshHome}${sep}`)
      || resolved === canon
      || resolved.startsWith(`${canon}${sep}`)
    if (!within) {
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
  if (name.startsWith('@dsh-enhanced/')) return name
  if (id.startsWith('dsh-enhanced-')) return `@dsh-enhanced/${id.slice('dsh-enhanced-'.length)}`
  return undefined
}

function collectPatchDbPaths(
  patchPath: string,
  boundary: SqlitePathBoundary,
  into: PatchDbMap,
  patchStates: Map<string, PatchPluginState> | undefined,
  diagnostics: string[],
): void {
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
  let realPatch: string
  try {
    realPatch = realpathSync(patchPath)
  } catch {
    diagnostics.push(`skipped unresolvable config: ${patchPath}`)
    return
  }
  if (!isWithinBoundary(resolve(patchPath), realPatch, boundary)) {
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
  const doc = parseDocument(source, {
    customTags: [
      { tag: '!js', resolve: (val: string) => val },
      { tag: 'tag:yaml.org,2002:js', resolve: (val: string) => val },
    ],
  })
  if (doc.errors.length > 0) {
    diagnostics.push(`YAML parse warning in ${patchPath}: ${doc.errors[0]!.message}`)
    return
  }
  const root = doc.toJS()
  const walkRows = (items: unknown) => {
    if (!Array.isArray(items)) return
    for (const entry of items) {
      if (!entry || typeof entry !== 'object') continue
      const row = entry as Record<string, unknown>
      const id = typeof row['id'] === 'string' ? row['id'] : ''
      const name = typeof row['name'] === 'string' ? row['name'] : ''
      const cfg = rec(row['config'])

      const pkgName = normalizePluginPackageName(id, name)
      if (pkgName && patchStates) {
        patchStates.set(pkgName, {
          disabled: row['disabled'] === true,
          configEnabled: typeof cfg['enabled'] === 'boolean' ? cfg['enabled'] : undefined,
        })
      }

      const fam = classifyPluginFamily(id) ?? classifyPluginFamily(name)
      if (fam) {
        if (fam === 'growthDriver') {
          const usagePath = resolvePathCandidate(rec(cfg['usageLearning'])['databasePath'], boundary.dshHome, boundary.canonicalDshHome, diagnostics)
          if (usagePath) into.growthDriver.add(usagePath)
          const dbPath = resolvePathCandidate(cfg['databasePath'], boundary.dshHome, boundary.canonicalDshHome, diagnostics)
          if (dbPath) into.growthDriver.add(dbPath)
        } else if (fam === 'controlPlane') {
          const dbPath = resolvePathCandidate(cfg['databasePath'], boundary.dshHome, boundary.canonicalDshHome, diagnostics)
          if (dbPath) into.controlPlane.add(dbPath)
          const stateDir = resolvePathCandidate(cfg['statePath'], boundary.dshHome, boundary.canonicalDshHome, diagnostics)
          if (stateDir) {
            into.controlPlane.add(join(stateDir, 'control.sqlite'))
            into.controlPlane.add(join(stateDir, 'creation-adoptions.sqlite'))
            into.controlPlane.add(join(stateDir, 'revision-adoptions.sqlite'))
          }
        } else if (fam === 'goals') {
          const dbPath = resolvePathCandidate(cfg['databasePath'], boundary.dshHome, boundary.canonicalDshHome, diagnostics)
          if (dbPath) {
            into.goals.add(`${dbPath}.strategies`)
            into.goals.add(dbPath)
          }
        } else if (fam === 'verifier') {
          const dbPath = resolvePathCandidate(cfg['databasePath'], boundary.dshHome, boundary.canonicalDshHome, diagnostics)
          if (dbPath) addVerifierVariants(into.verifier, dbPath)
        } else {
          const dbPath = resolvePathCandidate(cfg['databasePath'], boundary.dshHome, boundary.canonicalDshHome, diagnostics)
          if (dbPath) into[fam].add(dbPath)
        }
      }
      if (id.includes('personal-assistant') || name.endsWith('/personal-assistant')) {
        const pmPath = resolvePathCandidate(rec(cfg['personalMemory'])['databasePath'], boundary.dshHome, boundary.canonicalDshHome, diagnostics)
        if (pmPath) into.memory.add(pmPath)
      }
      if (Array.isArray(row['insert'])) walkRows(row['insert'])
      if (Array.isArray(row['config'])) walkRows(row['config'])
      if (Array.isArray(row['plugins'])) walkRows(row['plugins'])
    }
  }
  if (Array.isArray(root)) {
    walkRows(root)
  } else if (root && typeof root === 'object' && Array.isArray((root as Record<string, unknown>)['plugins'])) {
    walkRows((root as Record<string, unknown>)['plugins'])
  }
}

function findLoaderPathProp(
  host: Context,
  boundary: SqlitePathBoundary,
  moduleName: string,
  prop: string,
  nestedKey?: string,
): string | undefined {
  const configs = findLoaderEntryConfigs(host, moduleName)
  if (!configs) return undefined
  for (const cfg of [configs.effective, configs.raw]) {
    const target = nestedKey ? rec(cfg[nestedKey])[prop] : cfg[prop]
    const resolved = resolvePathCandidate(target, boundary.dshHome)
    if (resolved) return resolved
  }
  return undefined
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
  let handle: DatabaseSync | undefined
  try {
    handle = new DatabaseSync(openTarget, { readOnly: true })
    const check = handle.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined
    if (!check || Object.values(check)[0] !== 'ok') {
      handle.close()
      return { ok: false, integrityFailed: true }
    }
    return { ok: true, db: handle }
  } catch (error) {
    if (handle) {
      try { handle.close() } catch { /* ignore */ }
    }
    return { ok: false, integrityFailed: false, error }
  }
}

function withReadOnlySqlite<T>(
  dbPath: string | undefined,
  boundary: SqlitePathBoundary,
  seenGroupPaths: Set<string>,
  inspectedLedgers: Set<string>,
  diagnostics: string[],
  fn: (db: DatabaseSync, realTarget: string) => T,
): T | undefined {
  if (!dbPath) return undefined
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
    if (st.isSymbolicLink()) {
      diagnostics.push(`skipped symlink ledger: ${target}`)
      return undefined
    }
    if (!st.isFile()) return undefined
    if (st.nlink !== 1) {
      diagnostics.push(`skipped hardlink ledger: ${target}`)
      return undefined
    }
    realTarget = realpathSync(target)
    if (!isWithinBoundary(target, realTarget, boundary)) {
      diagnostics.push(`skipped out-of-bounds ledger: ${target}`)
      return undefined
    }
  } catch (error) {
    diagnostics.push(`failed to stat ledger (${target}): ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }

  if (seenGroupPaths.has(realTarget)) return undefined
  seenGroupPaths.add(realTarget)

  if (!isAbsentOrRegularFile(`${realTarget}-wal`) || !isAbsentOrRegularFile(`${realTarget}-shm`)) {
    diagnostics.push(`skipped unsafe sqlite sidecar: ${target}`)
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
      diagnostics.push(`sqlite quick_check failed (${realTarget})`)
      return undefined
    } else {
      const plainRes = tryOpenReadOnlySqlite(realTarget)
      if (plainRes.ok) {
        db = plainRes.db
      } else if (plainRes.integrityFailed) {
        diagnostics.push(`sqlite quick_check failed (${realTarget})`)
        return undefined
      } else {
        const err = plainRes.error ?? immutableRes.error
        diagnostics.push(`failed to open ledger (${realTarget}): ${err instanceof Error ? err.message : String(err)}`)
        return undefined
      }
    }
  } else {
    const primaryRes = tryOpenReadOnlySqlite(realTarget)
    if (primaryRes.ok) {
      db = primaryRes.db
    } else if (primaryRes.integrityFailed) {
      diagnostics.push(`sqlite quick_check failed (${realTarget})`)
      return undefined
    } else if (canFallbackImmutable(realTarget)) {
      const immutableRes = tryOpenReadOnlySqlite(immutableUri.href)
      if (immutableRes.ok) {
        db = immutableRes.db
      } else if (immutableRes.integrityFailed) {
        diagnostics.push(`sqlite quick_check failed (${realTarget})`)
        return undefined
      } else {
        const err = immutableRes.error ?? primaryRes.error
        diagnostics.push(`failed to open ledger (${realTarget}): ${err instanceof Error ? err.message : String(err)}`)
        return undefined
      }
    } else {
      diagnostics.push(
        `failed to open ledger (${realTarget}): ${primaryRes.error instanceof Error ? primaryRes.error.message : String(primaryRes.error)}`,
      )
      return undefined
    }
  }

  try {
    inspectedLedgers.add(realTarget)
    return fn(db, realTarget)
  } catch (error) {
    diagnostics.push(`failed to inspect ledger (${realTarget}): ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name) !== undefined
}

function hasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>
  return cols.some(col => col.name === columnName)
}

function queryCount(
  db: DatabaseSync,
  realTarget: string,
  countedTables: Set<string>,
  tableName: string,
  sql: string,
  requiredColumns: readonly string[] = [],
  claimKey?: string,
): number | undefined {
  if (!hasTable(db, tableName)) return undefined
  for (const col of requiredColumns) {
    if (!hasColumn(db, tableName, col)) return undefined
  }
  const dedupKey = `${realTarget}::${claimKey ?? tableName}`
  if (countedTables.has(dedupKey)) return undefined
  countedTables.add(dedupKey)
  const row = db.prepare(sql).get() as { c?: unknown } | undefined
  return nonNegInt(row?.c) ?? 0
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function readOptionalCliVersion(): string | undefined {
  try {
    const req = createRequire(import.meta.url)
    const resolved = req.resolve('@dsh-enhanced/dsh-rsi-cli/package.json')
    const parsed = JSON.parse(readFileSync(resolved, 'utf8')) as { version?: unknown }
    return boundNonEmptyString(parsed.version, 128)
  } catch {
    // Optional sibling package metadata.
  }
  return undefined
}

function listProfiles(boundary: SqlitePathBoundary | null): readonly string[] | undefined {
  if (!boundary) return undefined
  const profilesRoot = join(boundary.canonicalDshHome, 'profiles')
  try {
    if (!existsSync(profilesRoot)) return undefined
    const rootStat = lstatSync(profilesRoot)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return undefined
    const entries = readdirSync(profilesRoot, { withFileTypes: true })
    const names = entries
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && VALID_PROFILE_NAME_RE.test(entry.name))
      .map(entry => entry.name)
      .sort()
      .slice(0, 64)
    return names
  } catch {
    return undefined
  }
}

function inspectUpgradeHistoryAndBackups(
  boundary: SqlitePathBoundary | null,
  diagnostics: string[],
): Readonly<{
  selfUpgrades: number | null
  backupSnapshotsCount: number | null
  latestUpgrade?: Record<string, unknown>
}> {
  if (!boundary) return { selfUpgrades: null, backupSnapshotsCount: null }

  let selfUpgrades: number | null = null
  let latestUpgrade: Record<string, unknown> | undefined
  const historyPath = join(boundary.canonicalDshHome, '.dsh-enhanced', 'upgrade-history.jsonl')
  if (existsSync(historyPath)) {
    try {
      const st = lstatSync(historyPath)
      if (st.isSymbolicLink() || st.nlink !== 1) {
        diagnostics.push(`skipped symlink or hardlink upgrade history: ${historyPath}`)
      } else if (st.isFile()) {
        const realHistory = realpathSync(historyPath)
        if (!isWithinBoundary(historyPath, realHistory, boundary)) {
          diagnostics.push(`skipped out-of-bounds upgrade history: ${historyPath}`)
        } else if (st.size <= MAX_JSONL_BYTES) {
          const lines = readFileSync(realHistory, 'utf8')
            .split(/\r?\n/u)
            .map(line => line.trim())
            .filter(line => line !== '')
          let validCount = 0
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line) as unknown
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                validCount += 1
                latestUpgrade = parsed as Record<string, unknown>
              }
            } catch {
              diagnostics.push('ignored malformed JSONL line in upgrade-history.jsonl')
            }
          }
          selfUpgrades = validCount
        } else {
          diagnostics.push(`upgrade-history.jsonl exceeds ${MAX_JSONL_BYTES} bytes limit`)
        }
      }
    } catch (error) {
      diagnostics.push(`failed to read upgrade-history.jsonl: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  let backupSnapshotsCount: number | null = null
  const backupsRoot = join(boundary.canonicalDshHome, '.dsh-rsi-upgrade-backups')
  if (existsSync(backupsRoot)) {
    try {
      const st = lstatSync(backupsRoot)
      if (st.isSymbolicLink()) {
        diagnostics.push(`skipped symlink backup directory: ${backupsRoot}`)
      } else if (st.isDirectory()) {
        const realBackups = realpathSync(backupsRoot)
        if (isWithinBoundary(backupsRoot, realBackups, boundary)) {
          const children = readdirSync(realBackups, { withFileTypes: true })
          backupSnapshotsCount = children.filter(
            entry => !entry.name.startsWith('.') && entry.isDirectory() && !entry.isSymbolicLink(),
          ).length
        }
      }
    } catch (error) {
      diagnostics.push(`failed to inspect .dsh-rsi-upgrade-backups: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    selfUpgrades,
    backupSnapshotsCount,
    ...(latestUpgrade === undefined ? {} : { latestUpgrade }),
  }
}

function normalizePluginKey(name: string): string {
  const trimmed = name.trim()
  return trimmed.startsWith('@dsh-enhanced/') ? trimmed.slice('@dsh-enhanced/'.length) : trimmed
}

function inspectProfileInstallKind(
  profileDir: string | null,
  boundary: SqlitePathBoundary | null,
  packageName: string,
): 'npm' | 'local' | undefined {
  if (!profileDir || !boundary || !packageName.startsWith('@dsh-enhanced/')) return undefined
  const slug = packageName.slice('@dsh-enhanced/'.length)
  if (!VALID_PROFILE_NAME_RE.test(slug)) return undefined
  const modPath = join(profileDir, 'node_modules', '@dsh-enhanced', slug)
  const pnpmStoreRoot = resolve(profileDir, 'node_modules', '.pnpm')
  try {
    if (!existsSync(modPath)) return undefined
    const st = lstatSync(modPath)
    if (!st.isSymbolicLink()) return 'npm'
    const resolvedTarget = realpathSync(modPath)
    return (resolvedTarget === pnpmStoreRoot || resolvedTarget.startsWith(`${pnpmStoreRoot}${sep}`))
      ? 'npm'
      : 'local'
  } catch {
    return undefined
  }
}

function candidateDbPaths(
  host: Context,
  boundary: SqlitePathBoundary,
  targetProfiles: readonly string[],
  patchPaths: ReadonlySet<string>,
  moduleName: string,
  subDirName: string,
  defaultBasenames: readonly string[],
  extraConfigKey?: string,
  includeRootNames: readonly string[] = [],
): string[] {
  const out = new Set<string>()
  const fromLoader = findLoaderPathProp(host, boundary, moduleName, 'databasePath', extraConfigKey)
    ?? (extraConfigKey ? findLoaderPathProp(host, boundary, moduleName, 'databasePath') : undefined)
  if (fromLoader) out.add(fromLoader)

  for (const p of patchPaths) {
    out.add(p)
  }

  for (const base of defaultBasenames) {
    out.add(join(boundary.canonicalDshHome, subDirName, base))
    if (boundary.dshHome !== boundary.canonicalDshHome) {
      out.add(join(boundary.dshHome, subDirName, base))
    }
  }
  for (const prof of targetProfiles) {
    out.add(join(boundary.canonicalDshHome, subDirName, `${prof}.sqlite`))
  }
  for (const rootFile of includeRootNames) {
    out.add(join(boundary.canonicalDshHome, rootFile))
  }
  return [...out]
}

function safeCallHealth(host: Context, serviceName: string, methodName = 'health'): Record<string, unknown> | undefined {
  try {
    const svc = host.get(serviceName as never) as Record<string, unknown> | undefined
    if (!svc || typeof svc[methodName] !== 'function') return undefined
    const res = (svc[methodName] as () => unknown)()
    return res && typeof res === 'object' && !Array.isArray(res) ? res as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/**
 * Collect read-only `dsh-rsi/version/v1` version, plugin inventory, and self-iteration statistics.
 * Never constructs plugin SQLite store classes and never mutates any SQLite schema or file.
 */
export async function collectOwnerConsoleVersionInfo(
  host: Context,
  options: CollectOwnerConsoleVersionOptions = {},
): Promise<AssistantVersionReport> {
  const generatedAt = typeof options.now === 'number' && Number.isFinite(options.now) && options.now >= 0
    ? Math.trunc(options.now)
    : Date.now()
  const diagnostics: string[] = []
  const inspectedLedgersSet = new Set<string>()
  const countedTables = new Set<string>()

  const resolved = resolveDshHomeAndProfile(host, options)
  const boundary = resolveSqliteBoundary(resolved.dshHome, diagnostics)
  const profiles = listProfiles(boundary)
  const targetProfiles = resolved.profileName !== null
    ? [resolved.profileName]
    : (profiles && profiles.length > 0 ? profiles : ['web', 'lark', 'supervised'])
  const hostMeta = readBoundHostMetadata(boundary ? boundary.canonicalDshHome : resolved.dshHome)
  const runningHostVersion = readInstalledHostVersion()
  const cliVersion = readOptionalCliVersion()

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

  if (boundary) {
    if (resolved.profileName === null) {
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

  // Track evolved plugins & control-plane plan IDs to guarantee zero double-counting.
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
      if (trimmed.startsWith('@dsh-enhanced/') && !existing.name.startsWith('@dsh-enhanced/')) {
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

  const extensions: Record<string, unknown> = {}

  let sawControlPlaneDb = false

  if (boundary) {
    // 1. plugin-control-plane (control.sqlite, creation-adoptions.sqlite, revision-adoptions.sqlite)
    const cpPaths = new Set<string>(patchDbMap.controlPlane)
    const cpDirect = findLoaderPathProp(host, boundary, '@dsh-enhanced/plugin-control-plane', 'databasePath')
    if (cpDirect) cpPaths.add(cpDirect)
    const cpStateDir = findLoaderPathProp(host, boundary, '@dsh-enhanced/plugin-control-plane', 'statePath')
    if (cpStateDir) {
      cpPaths.add(join(cpStateDir, 'control.sqlite'))
      cpPaths.add(join(cpStateDir, 'creation-adoptions.sqlite'))
      cpPaths.add(join(cpStateDir, 'revision-adoptions.sqlite'))
    }
    for (const base of ['control.sqlite', 'state.sqlite', 'creation-adoptions.sqlite', 'revision-adoptions.sqlite']) {
      cpPaths.add(join(boundary.canonicalDshHome, 'plugin-control-plane', base))
    }
    for (const prof of targetProfiles) {
      cpPaths.add(join(boundary.canonicalDshHome, 'plugin-control-plane', `${prof}.sqlite`))
      cpPaths.add(join(boundary.canonicalDshHome, 'plugin-control-plane', `${prof}-creation-adoptions.sqlite`))
      cpPaths.add(join(boundary.canonicalDshHome, 'plugin-control-plane', `${prof}-revision-adoptions.sqlite`))
      cpPaths.add(join(boundary.canonicalDshHome, `${prof}-creation-adoptions.sqlite`))
      cpPaths.add(join(boundary.canonicalDshHome, `${prof}-revision-adoptions.sqlite`))
      cpPaths.add(join(boundary.canonicalDshHome, 'rsi-authorities', prof, 'state', 'control-plane', 'control.sqlite'))
      cpPaths.add(join(boundary.canonicalDshHome, 'rsi-authorities', prof, 'state', 'control-plane', 'creation-adoptions.sqlite'))
      cpPaths.add(join(boundary.canonicalDshHome, 'rsi-authorities', prof, 'state', 'control-plane', 'revision-adoptions.sqlite'))
    }

    const cpSeen = new Set<string>()
    const createdPlanIds = new Set<string>()
    const revisedPlanIds = new Set<string>()
    const controlAdoptedPlanIds = new Set<string>()
    let sawCreatedSource = false
    let sawRevisedSource = false
    let sawControlAdoptionSource = false

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

    for (const p of cpPaths) {
      withReadOnlySqlite(p, boundary, cpSeen, inspectedLedgersSet, diagnostics, (db, realTarget) => {
        sawControlPlaneDb = true

        if (
          hasTable(db, 'source_adoptions')
          && hasColumn(db, 'source_adoptions', 'source_plan_id')
          && hasColumn(db, 'source_adoptions', 'activation_plan_id')
        ) {
          const saKey = `${realTarget}::source_adoptions`
          if (!countedTables.has(saKey)) {
            countedTables.add(saKey)
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
        }

        if (hasTable(db, 'source_plans') && hasColumn(db, 'source_plans', 'id')) {
          const spKey = `${realTarget}::source_plans`
          if (!countedTables.has(spKey)) {
            countedTables.add(spKey)
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
            candidatesGenerated = addCounter(candidatesGenerated, rows.length)
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
        }

        if (hasTable(db, 'activation_watch')) {
          const watchKey = `${realTarget}::activation_watch`
          if (!countedTables.has(watchKey)) {
            countedTables.add(watchKey)
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
        }

        if (hasTable(db, 'activation_plans') && hasColumn(db, 'activation_plans', 'id') && hasColumn(db, 'activation_plans', 'status')) {
          const apKey = `${realTarget}::activation_plans`
          if (!countedTables.has(apKey)) {
            countedTables.add(apKey)
            sawControlAdoptionSource = true
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
              if (resolved.profileName !== null && hasProfileCol && typeof row.profile === 'string' && row.profile !== resolved.profileName) {
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
        }

        const isRevisionJournal = hasTable(db, 'entries') || hasTable(db, 'versions') || hasTable(db, 'rollbacks')

        if (!isRevisionJournal && hasTable(db, 'adoptions') && !hasColumn(db, 'adoptions', 'parent_plan_id') && hasColumn(db, 'adoptions', 'plan_id') && hasColumn(db, 'adoptions', 'status')) {
          const creationKey = `${realTarget}::creation_adoptions`
          if (!countedTables.has(creationKey)) {
            countedTables.add(creationKey)
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
        }

        if (isRevisionJournal) {
          const revRollbacks = queryCount(db, realTarget, countedTables, 'rollbacks', 'SELECT COUNT(*) AS c FROM rollbacks')
          if (revRollbacks !== undefined) rollbacks = addCounter(rollbacks, revRollbacks)

          const adoptionStatusByPlan = new Map<string, string>()
          if (hasTable(db, 'adoptions') && hasColumn(db, 'adoptions', 'plan_id') && hasColumn(db, 'adoptions', 'status')) {
            const revAdoptionsKey = `${realTarget}::revision_adoptions`
            if (!countedTables.has(revAdoptionsKey)) {
              countedTables.add(revAdoptionsKey)
              sawRevisedSource = true
              sawControlAdoptionSource = true
              const aRows = db.prepare('SELECT plan_id, status FROM adoptions').all() as Array<{ plan_id?: unknown; status?: unknown }>
              for (const ar of aRows) {
                if (typeof ar.plan_id === 'string' && typeof ar.status === 'string') {
                  adoptionStatusByPlan.set(ar.plan_id, ar.status)
                  if (ar.status === 'active') {
                    const canonicalId = sourceIdToActivationId.get(ar.plan_id) ?? ar.plan_id
                    revisedPlanIds.add(canonicalId)
                    controlAdoptedPlanIds.add(canonicalId)
                  }
                }
              }
            }
          } else if (hasTable(db, 'versions') && hasColumn(db, 'versions', 'plan_id') && hasColumn(db, 'versions', 'role')) {
            const revVersionsKey = `${realTarget}::revision_versions`
            if (!countedTables.has(revVersionsKey)) {
              countedTables.add(revVersionsKey)
              sawRevisedSource = true
              sawControlAdoptionSource = true
              const vRows = db.prepare("SELECT plan_id FROM versions WHERE role = 'revision'").all() as Array<{ plan_id?: unknown }>
              for (const vr of vRows) {
                if (typeof vr.plan_id === 'string' && vr.plan_id !== '') {
                  const canonicalId = sourceIdToActivationId.get(vr.plan_id) ?? vr.plan_id
                  revisedPlanIds.add(canonicalId)
                  controlAdoptedPlanIds.add(canonicalId)
                }
              }
            }
          }

          if (hasTable(db, 'entries')) {
            const revEntriesKey = `${realTarget}::revision_entries`
            if (!countedTables.has(revEntriesKey)) {
              countedTables.add(revEntriesKey)
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
        }
      })
    }

    const normalizePlanId = (id: string): string => sourceIdToActivationId.get(id) ?? id

    // Re-normalize any revision-adoptions IDs collected before source_adoptions was read
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
      const cert = parseJsonObject(row.certificateJson)
      const plan = rec(cert['plan'])
      const receipt = parseJsonObject(row.receiptJson)
      const capName = (typeof plan['name'] === 'string' && plan['name'].trim() !== '' ? plan['name'].trim() : undefined)
        ?? (typeof cert['packageName'] === 'string' && cert['packageName'].trim() !== '' ? cert['packageName'].trim() : undefined)
        ?? (typeof cert['pluginName'] === 'string' && cert['pluginName'].trim() !== '' ? cert['pluginName'].trim() : undefined)
        ?? (typeof cert['name'] === 'string' && cert['name'].trim() !== '' ? cert['name'].trim() : row.planId)
      const capVer = typeof receipt['version'] === 'string' && receipt['version'].trim() !== ''
        ? receipt['version'].trim()
        : typeof plan['version'] === 'string' && plan['version'].trim() !== ''
          ? plan['version'].trim()
          : typeof cert['version'] === 'string' && cert['version'].trim() !== ''
            ? cert['version'].trim()
            : typeof cert['pluginVersion'] === 'string' && cert['pluginVersion'].trim() !== ''
              ? cert['pluginVersion'].trim()
              : null
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
          const rawName = (er.name && er.name.trim() !== '' ? er.name.trim() : undefined)
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
          if (sp.pluginName && sp.pluginName.trim() !== '') {
            upsertEvolved(sp.pluginName, {
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
      const candidate = parseJsonObject(act.candidateJson)
      const pkgName = typeof candidate['package'] === 'string' && candidate['package'].trim() !== ''
        ? candidate['package'].trim()
        : (typeof candidate['name'] === 'string' && candidate['name'].trim() !== '' ? candidate['name'].trim() : undefined)
      if (pkgName === undefined) continue
      const pkgVer = typeof candidate['version'] === 'string' && candidate['version'].trim() !== ''
        ? (boundNonEmptyString(candidate['version'].trim(), 128) ?? null)
        : null
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
    let sawActivationPlansTable = false
    for (const k of countedTables) {
      if (k.endsWith('::activation_plans')) {
        sawActivationPlansTable = true
        break
      }
    }
    if (sawActivationPlansTable) {
      candidatesGenerated = addCounter(candidatesGenerated, unlinkedApCount)
      rollbacks = addCounter(rollbacks, rollbackApCount)
    }

    if (sawCreatedSource) pluginsCreated = createdPlanIds.size
    if (sawRevisedSource) pluginsRevised = revisedPlanIds.size
    if (sawControlAdoptionSource) {
      candidatesAdopted = addCounter(candidatesAdopted, controlAdoptedPlanIds.size)
    }

    // 2. assistant-evolution
    const evoSeen = new Set<string>()
    for (const p of candidateDbPaths(host, boundary, targetProfiles, patchDbMap.evolution, '@dsh-enhanced/assistant-evolution', 'assistant-evolution', ['evolution.sqlite', 'state.sqlite'])) {
      withReadOnlySqlite(p, boundary, evoSeen, inspectedLedgersSet, diagnostics, (db, realTarget) => {
        const props = queryCount(db, realTarget, countedTables, 'evolution_proposals', 'SELECT COUNT(*) AS c FROM evolution_proposals')
        if (props !== undefined) candidatesGenerated = addCounter(candidatesGenerated, props)
        const rules = queryCount(db, realTarget, countedTables, 'evolution_rules', 'SELECT COUNT(*) AS c FROM evolution_rules')
        if (rules !== undefined) {
          evolutionRulesAdopted = addCounter(evolutionRulesAdopted, rules)
          candidatesAdopted = addCounter(candidatesAdopted, rules)
        }
        const autoRb = queryCount(db, realTarget, countedTables, 'evolution_autonomous_rollbacks', 'SELECT COUNT(*) AS c FROM evolution_autonomous_rollbacks')
        if (autoRb !== undefined) rollbacks = addCounter(rollbacks, autoRb)
      })
    }

    // 3. assistant-association
    const assocSeen = new Set<string>()
    for (const p of candidateDbPaths(
      host,
      boundary,
      targetProfiles,
      patchDbMap.association,
      '@dsh-enhanced/assistant-association',
      'assistant-association',
      ['association.sqlite', 'state.sqlite'],
      undefined,
      ['association.sqlite', 'assistant-association.sqlite'],
    )) {
      withReadOnlySqlite(p, boundary, assocSeen, inspectedLedgersSet, diagnostics, (db, realTarget) => {
        if (hasTable(db, 'assoc_param_profile_heads') && hasColumn(db, 'assoc_param_profile_heads', 'active_version')) {
          const headKey = `${realTarget}::assoc_param_profile_heads`
          if (!countedTables.has(headKey)) {
            countedTables.add(headKey)
            const row = db.prepare('SELECT MAX(active_version) AS max_v FROM assoc_param_profile_heads').get() as { max_v?: unknown } | undefined
            const v = nonNegInt(row?.max_v) ?? 0
            associationParamVersion = associationParamVersion === null ? v : Math.max(associationParamVersion, v)
          }
        }
        const adoptions = queryCount(
          db, realTarget, countedTables, 'assoc_param_profile_events',
          "SELECT COUNT(*) AS c FROM assoc_param_profile_events WHERE kind = 'adopted'",
          ['kind'], 'assoc_param_profile_events:adopted',
        )
        if (adoptions !== undefined) associationProfileAdoptions = addCounter(associationProfileAdoptions, adoptions)

        const assocRb = queryCount(
          db, realTarget, countedTables, 'assoc_param_profile_events',
          "SELECT COUNT(*) AS c FROM assoc_param_profile_events WHERE kind = 'rolled-back'",
          ['kind'], 'assoc_param_profile_events:rollback',
        )
        if (assocRb !== undefined) rollbacks = addCounter(rollbacks, assocRb)

        const relaxProps = queryCount(db, realTarget, countedTables, 'assoc_param_relax_proposals', 'SELECT COUNT(*) AS c FROM assoc_param_relax_proposals')
        if (relaxProps !== undefined) candidatesGenerated = addCounter(candidatesGenerated, relaxProps)

        const skillCands = queryCount(db, realTarget, countedTables, 'assoc_skill_candidates', 'SELECT COUNT(*) AS c FROM assoc_skill_candidates')
        if (skillCands !== undefined) candidatesGenerated = addCounter(candidatesGenerated, skillCands)

        const nodes = queryCount(db, realTarget, countedTables, 'assoc_nodes', 'SELECT COUNT(*) AS c FROM assoc_nodes')
        const edges = queryCount(db, realTarget, countedTables, 'assoc_edges', 'SELECT COUNT(*) AS c FROM assoc_edges')
        if (nodes !== undefined || edges !== undefined) {
          extensions['associationGraph'] = {
            ...(nodes === undefined ? {} : { nodes }),
            ...(edges === undefined ? {} : { edges }),
          }
        }
      })
    }

    // 4. assistant-evaluation
    const evalSeen = new Set<string>()
    for (const p of candidateDbPaths(host, boundary, targetProfiles, patchDbMap.evaluation, '@dsh-enhanced/assistant-evaluation', 'assistant-evaluation', ['evaluation.sqlite', 'state.sqlite'])) {
      withReadOnlySqlite(p, boundary, evalSeen, inspectedLedgersSet, diagnostics, (db, realTarget) => {
        const tuned = queryCount(
          db, realTarget, countedTables, 'evaluation_attention_tuning_events',
          "SELECT COUNT(*) AS c FROM evaluation_attention_tuning_events WHERE kind = 'adopted'",
          ['kind'], 'evaluation_attention_tuning_events:adopted',
        )
        if (tuned !== undefined) evaluationAttentionTuningAdoptions = addCounter(evaluationAttentionTuningAdoptions, tuned)

        const evalRb = queryCount(
          db, realTarget, countedTables, 'evaluation_attention_tuning_events',
          "SELECT COUNT(*) AS c FROM evaluation_attention_tuning_events WHERE kind = 'rolled-back'",
          ['kind'], 'evaluation_attention_tuning_events:rollback',
        )
        if (evalRb !== undefined) rollbacks = addCounter(rollbacks, evalRb)

        const looseProps = queryCount(db, realTarget, countedTables, 'evaluation_attention_loosening_proposals', 'SELECT COUNT(*) AS c FROM evaluation_attention_loosening_proposals')
        if (looseProps !== undefined) candidatesGenerated = addCounter(candidatesGenerated, looseProps)

        const looseAdopted = queryCount(
          db, realTarget, countedTables, 'evaluation_attention_loosening_decisions',
          "SELECT COUNT(*) AS c FROM evaluation_attention_loosening_decisions WHERE decision = 'adopted'",
          ['decision'], 'evaluation_attention_loosening_decisions:adopted',
        )
        if (looseAdopted !== undefined) evaluationLooseningDecisionsAdopted = addCounter(evaluationLooseningDecisionsAdopted, looseAdopted)
      })
    }

    // 5. assistant-work-items
    const wiSeen = new Set<string>()
    for (const p of candidateDbPaths(host, boundary, targetProfiles, patchDbMap.workItems, '@dsh-enhanced/assistant-work-items', 'assistant-work-items', ['state.sqlite'])) {
      withReadOnlySqlite(p, boundary, wiSeen, inspectedLedgersSet, diagnostics, (db, realTarget) => {
        const total = queryCount(db, realTarget, countedTables, 'work_item', 'SELECT COUNT(*) AS c FROM work_item')
        if (total !== undefined) workItemsTotal = addCounter(workItemsTotal, total)
        const settled = queryCount(
          db, realTarget, countedTables, 'work_item_outcome',
          'SELECT COUNT(DISTINCT item_id) AS c FROM work_item_outcome',
          ['item_id'],
        )
        if (settled !== undefined) {
          workItemsSettled = addCounter(workItemsSettled, settled)
        } else {
          const fallbackSettled = queryCount(
            db, realTarget, countedTables, 'work_item',
            "SELECT COUNT(*) AS c FROM work_item WHERE state IN ('ready', 'blocked', 'failed', 'dropped')",
            ['state'], 'work_item:settled_fallback',
          )
          if (fallbackSettled !== undefined) workItemsSettled = addCounter(workItemsSettled, fallbackSettled)
        }
      })
    }

    // 6. assistant-growth-driver
    const gdSeen = new Set<string>()
    const gdPaths = new Set<string>(
      candidateDbPaths(host, boundary, targetProfiles, patchDbMap.growthDriver, '@dsh-enhanced/assistant-growth-driver', 'assistant-growth-driver', ['usage.sqlite', 'state.sqlite'], 'usageLearning'),
    )
    for (const prof of targetProfiles) {
      gdPaths.add(join(boundary.canonicalDshHome, 'assistant-growth-driver', `${prof}-usage.sqlite`))
    }
    for (const p of gdPaths) {
      withReadOnlySqlite(p, boundary, gdSeen, inspectedLedgersSet, diagnostics, (db, realTarget) => {
        const jobs = queryCount(db, realTarget, countedTables, 'usage_jobs', 'SELECT COUNT(*) AS c FROM usage_jobs')
        if (jobs !== undefined) {
          growthUsageJobsTotal = addCounter(growthUsageJobsTotal, jobs)
          candidatesGenerated = addCounter(candidatesGenerated, jobs)
        }
      })
    }

    // 7. assistant-dreaming
    const dreamSeen = new Set<string>()
    for (const p of candidateDbPaths(host, boundary, targetProfiles, patchDbMap.dreaming, '@dsh-enhanced/assistant-dreaming', 'assistant-dreaming', ['state.sqlite', 'dreaming.sqlite'])) {
      withReadOnlySqlite(p, boundary, dreamSeen, inspectedLedgersSet, diagnostics, (db, realTarget) => {
        const runs = queryCount(db, realTarget, countedTables, 'dream_runs', 'SELECT COUNT(*) AS c FROM dream_runs')
        if (runs !== undefined) dreamingRuns = addCounter(dreamingRuns, runs)
      })
    }

    // 8. assistant-recovery
    const recSeen = new Set<string>()
    for (const p of candidateDbPaths(host, boundary, targetProfiles, patchDbMap.recovery, '@dsh-enhanced/assistant-recovery', 'assistant-recovery', ['state.sqlite', 'recovery.sqlite'])) {
      withReadOnlySqlite(p, boundary, recSeen, inspectedLedgersSet, diagnostics, (db, realTarget) => {
        const runs = queryCount(db, realTarget, countedTables, 'recovery_runs', 'SELECT COUNT(*) AS c FROM recovery_runs')
        if (runs !== undefined) recoveryRuns = addCounter(recoveryRuns, runs)
      })
    }

    // 9. assistant-goals (+ `${databasePath}.strategies` + strategies.sqlite + strategy.sqlite)
    const goalsSeen = new Set<string>()
    const baseGoalsPaths = candidateDbPaths(
      host,
      boundary,
      targetProfiles,
      patchDbMap.goals,
      '@dsh-enhanced/assistant-goals',
      'assistant-goals',
      ['state.sqlite', 'goals.sqlite'],
      undefined,
      ['assistant-goals.sqlite'],
    )
    const goalsAndStrategiesPaths = new Set<string>()
    for (const gp of baseGoalsPaths) {
      goalsAndStrategiesPaths.add(`${gp}.strategies`)
      goalsAndStrategiesPaths.add(gp)
    }
    goalsAndStrategiesPaths.add(join(boundary.canonicalDshHome, 'assistant-goals', 'strategies.sqlite'))
    goalsAndStrategiesPaths.add(join(boundary.canonicalDshHome, 'assistant-goals', 'strategy.sqlite'))
    for (const p of goalsAndStrategiesPaths) {
      withReadOnlySqlite(p, boundary, goalsSeen, inspectedLedgersSet, diagnostics, (db, realTarget) => {
        const runs = queryCount(db, realTarget, countedTables, 'goal_strategy_records', 'SELECT COUNT(*) AS c FROM goal_strategy_records')
        if (runs !== undefined) goalStrategyRuns = addCounter(goalStrategyRuns, runs)
      })
    }

    // 10. assistant-verifier (+ all 6 sidecar review DBs)
    const verSeen = new Set<string>()
    const baseVerPaths = candidateDbPaths(host, boundary, targetProfiles, patchDbMap.verifier, '@dsh-enhanced/assistant-verifier', 'assistant-verifier', ['verification.sqlite', 'state.sqlite'])
    const verifierPaths = new Set<string>()
    for (const vp of baseVerPaths) {
      addVerifierVariants(verifierPaths, vp)
    }
    let creationCertificates = 0
    let sourceApproved = 0
    let revisionCertificates = 0
    let revisionRegressions = 0
    let sawVerifierReviews = false

    for (const p of verifierPaths) {
      withReadOnlySqlite(p, boundary, verSeen, inspectedLedgersSet, diagnostics, (db, realTarget) => {
        const done = queryCount(
          db, realTarget, countedTables, 'acceptance_jobs',
          "SELECT COUNT(*) AS c FROM acceptance_jobs WHERE state = 'done'",
          ['state'], 'acceptance_jobs:done',
        )
        if (done !== undefined) taskVerificationsDone = addCounter(taskVerificationsDone, done)

        if (hasTable(db, 'verifications') && hasColumn(db, 'verifications', 'state')) {
          const certs = queryCount(
            db, realTarget, countedTables, 'verifications',
            "SELECT COUNT(*) AS c FROM verifications WHERE state = 'certificate'",
            ['state'], 'verifications:certificate',
          )
          if (certs !== undefined) {
            sawVerifierReviews = true
            if (realTarget.endsWith('.revision-reviews')) revisionCertificates += certs
            else if (realTarget.endsWith('.revision-regressions')) revisionRegressions += certs
            else creationCertificates += certs
          }
        }
        if (hasTable(db, 'reviews') && hasColumn(db, 'reviews', 'state')) {
          const approved = queryCount(
            db, realTarget, countedTables, 'reviews',
            "SELECT COUNT(*) AS c FROM reviews WHERE state = 'approved'",
            ['state'], 'reviews:approved',
          )
          if (approved !== undefined) {
            sawVerifierReviews = true
            sourceApproved += approved
          }
        }
      })
    }
    if (sawVerifierReviews) {
      extensions['verifierReviews'] = {
        creationCertificates,
        sourceApproved,
        revisionCertificates,
        revisionRegressions,
      }
    }

    // 11. assistant-memory-learning
    const mlSeen = new Set<string>()
    for (const p of candidateDbPaths(host, boundary, targetProfiles, patchDbMap.memoryLearning, '@dsh-enhanced/assistant-memory-learning', 'assistant-memory-learning', ['learning.sqlite', 'state.sqlite'])) {
      withReadOnlySqlite(p, boundary, mlSeen, inspectedLedgersSet, diagnostics, (db, realTarget) => {
        const totalJobs = queryCount(db, realTarget, countedTables, 'jobs', 'SELECT COUNT(*) AS c FROM jobs')
        if (totalJobs !== undefined) candidatesGenerated = addCounter(candidatesGenerated, totalJobs)
        const adoptedJobs = queryCount(
          db, realTarget, countedTables, 'jobs',
          "SELECT COUNT(*) AS c FROM jobs WHERE state = 'adopted'",
          ['state'], 'jobs:adopted',
        )
        if (adoptedJobs !== undefined) candidatesAdopted = addCounter(candidatesAdopted, adoptedJobs)
      })
    }

    // 12. personal-memory (also check personal-assistant personalMemory.databasePath)
    const pmSeen = new Set<string>()
    const pmPaths = new Set<string>(candidateDbPaths(host, boundary, targetProfiles, patchDbMap.memory, '@dsh-enhanced/personal-memory', 'personal-memory', ['memory.sqlite', 'state.sqlite']))
    const paPmPath = findLoaderPathProp(host, boundary, '@dsh-enhanced/personal-assistant', 'databasePath', 'personalMemory')
    if (paPmPath) pmPaths.add(paPmPath)
    for (const p of pmPaths) {
      withReadOnlySqlite(p, boundary, pmSeen, inspectedLedgersSet, diagnostics, (db, realTarget) => {
        const active = queryCount(
          db, realTarget, countedTables, 'memory_records',
          "SELECT COUNT(*) AS c FROM memory_records WHERE status = 'active'",
          ['status'], 'memory_records:active',
        )
        if (active !== undefined) activeMemories = addCounter(activeMemories, active)
      })
    }

    // 13. preference-learning
    const plSeen = new Set<string>()
    for (const p of candidateDbPaths(host, boundary, targetProfiles, patchDbMap.preference, '@dsh-enhanced/preference-learning', 'preference-learning', ['preferences.sqlite', 'state.sqlite'])) {
      withReadOnlySqlite(p, boundary, plSeen, inspectedLedgersSet, diagnostics, (db, realTarget) => {
        const hyps = queryCount(db, realTarget, countedTables, 'preference_hypotheses', 'SELECT COUNT(*) AS c FROM preference_hypotheses')
        if (hyps !== undefined) candidatesGenerated = addCounter(candidatesGenerated, hyps)
        else {
          const transCreated = queryCount(
            db, realTarget, countedTables, 'preference_transitions',
            "SELECT COUNT(*) AS c FROM preference_transitions WHERE reason = 'created'",
            ['reason'], 'preference_transitions:created',
          )
          if (transCreated !== undefined) candidatesGenerated = addCounter(candidatesGenerated, transCreated)
        }

        const activePref = queryCount(
          db, realTarget, countedTables, 'preference_hypotheses',
          "SELECT COUNT(*) AS c FROM preference_hypotheses WHERE effect_state = 'active'",
          ['effect_state'], 'preference_hypotheses:active',
        )
        if (activePref !== undefined) activePreferenceOverlays = addCounter(activePreferenceOverlays, activePref)

        const prefActivated = queryCount(
          db, realTarget, countedTables, 'preference_transitions',
          "SELECT COUNT(*) AS c FROM preference_transitions WHERE reason = 'activated'",
          ['reason'], 'preference_transitions:activated',
        )
        if (prefActivated !== undefined) {
          candidatesAdopted = addCounter(candidatesAdopted, prefActivated)
        } else if (activePref !== undefined) {
          candidatesAdopted = addCounter(candidatesAdopted, activePref)
        }

        const prefRb = queryCount(
          db, realTarget, countedTables, 'preference_transitions',
          "SELECT COUNT(*) AS c FROM preference_transitions WHERE reason IN ('regression', 'operator-request')",
          ['reason'], 'preference_transitions:rollback',
        )
        if (prefRb !== undefined) {
          rollbacks = addCounter(rollbacks, prefRb)
        } else {
          const hypRb = queryCount(
            db, realTarget, countedTables, 'preference_hypotheses',
            "SELECT COUNT(*) AS c FROM preference_hypotheses WHERE effect_state = 'rolled-back'",
            ['effect_state'], 'preference_hypotheses:rolled-back',
          )
          if (hypRb !== undefined) rollbacks = addCounter(rollbacks, hypRb)
        }
      })
    }

    // 14. assistant-growth-experiments
    const geSeen = new Set<string>()
    for (const p of candidateDbPaths(host, boundary, targetProfiles, patchDbMap.growthExperiments, '@dsh-enhanced/assistant-growth-experiments', 'assistant-growth-experiments', ['growth.sqlite', 'state.sqlite'])) {
      withReadOnlySqlite(p, boundary, geSeen, inspectedLedgersSet, diagnostics, (db, realTarget) => {
        const wTotal = queryCount(db, realTarget, countedTables, 'workflow_candidates', 'SELECT COUNT(*) AS c FROM workflow_candidates')
        if (wTotal !== undefined) candidatesGenerated = addCounter(candidatesGenerated, wTotal)

        const promoted = queryCount(
          db, realTarget, countedTables, 'workflow_candidates',
          "SELECT COUNT(*) AS c FROM workflow_candidates WHERE state = 'promoted'",
          ['state'], 'workflow_candidates:promoted',
        )
        if (promoted !== undefined) {
          workflowCandidatesPromoted = addCounter(workflowCandidatesPromoted, promoted)
          candidatesAdopted = addCounter(candidatesAdopted, promoted)
        }

        const geRb = queryCount(
          db, realTarget, countedTables, 'workflow_candidates',
          "SELECT COUNT(*) AS c FROM workflow_candidates WHERE state = 'rolled-back'",
          ['state'], 'workflow_candidates:rolled-back',
        )
        if (geRb !== undefined) rollbacks = addCounter(rollbacks, geRb)
      })
    }

    // 15. assistant-skills
    const skSeen = new Set<string>()
    for (const p of candidateDbPaths(
      host, boundary, targetProfiles, patchDbMap.skills, '@dsh-enhanced/assistant-skills', 'assistant-skills',
      ['skills.sqlite', 'state.sqlite'], undefined, ['assistant-skills.sqlite'],
    )) {
      withReadOnlySqlite(p, boundary, skSeen, inspectedLedgersSet, diagnostics, (db, realTarget) => {
        const cands = queryCount(db, realTarget, countedTables, 'skill_candidates', 'SELECT COUNT(*) AS c FROM skill_candidates')
        if (cands !== undefined) candidatesGenerated = addCounter(candidatesGenerated, cands)

        const deps = queryCount(
          db, realTarget, countedTables, 'skill_deployments',
          "SELECT COUNT(*) AS c FROM skill_deployments WHERE state IN ('canary', 'promoted')",
          ['state'], 'skill_deployments:active',
        )
        if (deps !== undefined) {
          skillDeployments = addCounter(skillDeployments, deps)
          candidatesAdopted = addCounter(candidatesAdopted, deps)
        }

        const skRb = queryCount(
          db, realTarget, countedTables, 'skill_deployments',
          "SELECT COUNT(*) AS c FROM skill_deployments WHERE state IN ('rolled-back', 'revoked')",
          ['state'], 'skill_deployments:rollback',
        )
        if (skRb !== undefined) rollbacks = addCounter(rollbacks, skRb)
      })
    }
  }

  // Optional Cordis health() fallbacks when SQLite ledgers are :memory: or absent on disk
  const wiHealth = safeCallHealth(host, 'assistantWorkItems')
  if (wiHealth && workItemsTotal === null) {
    const openItems = nonNegInt(wiHealth['openItems'])
    if (openItems !== null) {
      workItemsTotal = openItems
      if (workItemsSettled === null) workItemsSettled = 0
    }
  }

  const gdHealth = safeCallHealth(host, 'assistantGrowthDriver', 'usageHealth')
  if (gdHealth && growthUsageJobsTotal === null) {
    const counts = rec(gdHealth['counts'])
    let sum = 0
    let sawNumeric = false
    for (const val of Object.values(counts)) {
      const n = nonNegInt(val)
      if (n !== null) {
        sum += n
        sawNumeric = true
      }
    }
    if (sawNumeric || gdHealth['connected'] === true || gdHealth['enabled'] === true) {
      growthUsageJobsTotal = sum
    }
  }

  const dreamHealth = safeCallHealth(host, 'assistantDreaming')
  if (dreamHealth && dreamingRuns === null) {
    const runs = nonNegInt(rec(dreamHealth['counts'])['runs'])
    if (runs !== null) dreamingRuns = runs
  }

  const recHealth = safeCallHealth(host, 'assistantRecovery')
  if (recHealth && recoveryRuns === null) {
    const running = nonNegInt(recHealth['runningRuns'])
    const failed = nonNegInt(recHealth['failedRuns'])
    const unknown = nonNegInt(recHealth['unknownRuns'])
    if (running !== null || failed !== null || unknown !== null) {
      recoveryRuns = (running ?? 0) + (failed ?? 0) + (unknown ?? 0)
    }
  }

  const cpHealth = safeCallHealth(host, 'pluginControlPlane')
  if (cpHealth) {
    const cpReady = nonNegInt(cpHealth['readyPlans'])
    const cpActive = nonNegInt(cpHealth['activeActivations'])
    const cpFailed = nonNegInt(cpHealth['failed'])
    if (candidatesGenerated === null && (cpReady !== null || cpActive !== null || cpFailed !== null)) {
      candidatesGenerated = (cpReady ?? 0) + (cpActive ?? 0) + (cpFailed ?? 0)
    }
    if (candidatesAdopted === null && cpActive !== null) {
      candidatesAdopted = cpActive
    }
    const closedRegressed = nonNegInt(cpHealth['closedRegressed'])
    const closedRetracted = nonNegInt(cpHealth['closedRetracted'])
    const rbPending = nonNegInt(cpHealth['rollbackPending'])
    if (rollbacks === null && (closedRegressed !== null || closedRetracted !== null || rbPending !== null)) {
      rollbacks = (closedRegressed ?? 0) + (closedRetracted ?? 0) + (rbPending ?? 0)
    }
  }

  const evoHealth = safeCallHealth(host, 'assistantEvolution')
  if (evoHealth) {
    const activeRules = nonNegInt(evoHealth['activeRules'])
    const retiredRules = nonNegInt(evoHealth['retiredRules'])
    const pendingProps = nonNegInt(evoHealth['pendingProposals'])
    const conflictedProps = nonNegInt(evoHealth['conflictedProposals'])
    const autoRb = nonNegInt(evoHealth['autonomousRollbacks'])
    if (evolutionRulesAdopted === null && (activeRules !== null || retiredRules !== null)) {
      evolutionRulesAdopted = (activeRules ?? 0) + (retiredRules ?? 0)
      candidatesAdopted = addCounter(candidatesAdopted, evolutionRulesAdopted)
    }
    if (pendingProps !== null || conflictedProps !== null) {
      if (candidatesGenerated === null) candidatesGenerated = (pendingProps ?? 0) + (conflictedProps ?? 0)
    }
    if (rollbacks === null && autoRb !== null) {
      rollbacks = autoRb
    }
  }

  const mlHealth = safeCallHealth(host, 'assistantMemoryLearning')
  if (mlHealth) {
    const counts = rec(mlHealth['counts'])
    const adopted = nonNegInt(counts['adopted'])
    if (adopted !== null && candidatesAdopted === null) {
      candidatesAdopted = adopted
    }
    let total = 0
    let hasCount = false
    for (const v of Object.values(counts)) {
      const n = nonNegInt(v)
      if (n !== null) {
        total += n
        hasCount = true
      }
    }
    if (hasCount && candidatesGenerated === null) {
      candidatesGenerated = total
    }
  }

  const pmHealth = safeCallHealth(host, 'personalMemory')
  if (pmHealth && activeMemories === null) {
    const active = nonNegInt(pmHealth['activeRecords'])
    if (active !== null) activeMemories = active
  }

  const prefHealth = safeCallHealth(host, 'assistantPreferenceLearning')
  if (prefHealth) {
    const active = nonNegInt(prefHealth['active'])
    const hyps = nonNegInt(prefHealth['hypotheses'])
    const rb = nonNegInt(prefHealth['rolledBack'])
    if (activePreferenceOverlays === null && active !== null) activePreferenceOverlays = active
    if (candidatesGenerated === null && hyps !== null) candidatesGenerated = hyps
    if (candidatesAdopted === null && active !== null) candidatesAdopted = active
    if (rollbacks === null && rb !== null) rollbacks = rb
  }

  const geHealth = safeCallHealth(host, 'assistantGrowthExperiments')
  if (geHealth) {
    const promoted = nonNegInt(geHealth['promoted'])
    const cands = nonNegInt(geHealth['candidates'])
    if (workflowCandidatesPromoted === null && promoted !== null) workflowCandidatesPromoted = promoted
    if (candidatesGenerated === null && cands !== null) candidatesGenerated = cands
    if (candidatesAdopted === null && promoted !== null) candidatesAdopted = promoted
  }

  // Upgrade history & backup snapshots
  const fsHistory = inspectUpgradeHistoryAndBackups(boundary, diagnostics)
  const selfUpgrades = fsHistory.selfUpgrades
  const backupSnapshotsCount = fsHistory.backupSnapshotsCount
  if (fsHistory.latestUpgrade !== undefined) {
    extensions['latestUpgrade'] = fsHistory.latestUpgrade
  }

  // Plugins inventory: core vs evolved (never double-counted)
  interface CorePluginAcc {
    name: string
    version: string | null
    installKind?: 'npm' | 'local'
    enabledStates: Array<boolean | undefined>
  }
  const coreByKey = new Map<string, CorePluginAcc>()
  let pluginSourceAvailable = false

  const readDiskPackageVersion = (profileDir: string | null, pkgName: string): string | null => {
    if (!profileDir || !pkgName.startsWith('@dsh-enhanced/')) return null
    const slug = pkgName.slice('@dsh-enhanced/'.length)
    if (!VALID_PROFILE_NAME_RE.test(slug)) return null
    const pkgJsonPath = join(profileDir, 'node_modules', '@dsh-enhanced', slug, 'package.json')
    try {
      const st = lstatSync(pkgJsonPath)
      if (!st.isFile() || st.isSymbolicLink()) return null
      const parsed = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { version?: unknown }
      return boundNonEmptyString(parsed.version, 128) ?? null
    } catch {
      return null
    }
  }

  const manager = host.get('pluginManager' as never) as Partial<PluginManagerService> | undefined
  if (manager && typeof manager.listBundles === 'function') {
    try {
      const bundles = await manager.listBundles()
      pluginSourceAvailable = true
      for (const bundle of bundles) {
        if (!isProjectPackage(bundle.name) || bundle.error?.code === 'not-bundle' || bundle.installed !== true) continue
        const boundedBundleName = boundNonEmptyString(bundle.name, 200)
        if (!boundedBundleName) continue
        const boundedBundleVer = boundNonEmptyString(bundle.version, 128) ?? null
        const key = normalizePluginKey(bundle.name)
        const existingEvolved = evolvedMap.get(key)
        if (existingEvolved) {
          existingEvolved.name = boundedBundleName
          if (boundedBundleVer !== null && (existingEvolved.version === null || /^v\d+$/u.test(existingEvolved.version))) {
            existingEvolved.version = boundedBundleVer
            existingEvolved.versionTier = 3
          }
          existingEvolved.enabled = bundle.enabled
          continue
        }
        if (coreByKey.has(key)) continue
        const installKind = inspectProfileInstallKind(resolved.profileDir, boundary, bundle.name)
        coreByKey.set(key, {
          name: boundedBundleName,
          version: boundedBundleVer,
          ...(installKind === undefined ? {} : { installKind }),
          enabledStates: [bundle.enabled],
        })
      }
    } catch (error) {
      diagnostics.push(`pluginManager.listBundles() failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (!pluginSourceAvailable) {
    const loader = host.get('loader' as never) as Partial<LoaderService> | undefined
    if (loader && typeof loader.entries === 'function') {
      try {
        const entries = [...loader.entries()]
        pluginSourceAvailable = true
        for (const entry of entries) {
          const modName = entry.options?.name
          if (typeof modName !== 'string' || !isProjectPackage(modName)) continue
          const boundedModName = boundNonEmptyString(modName, 200)
          if (!boundedModName) continue
          const key = normalizePluginKey(modName)
          const enabled = !isLoaderEntryDisabled(entry as { disabled?: unknown; options: { disabled?: unknown } })
          const diskVer = readDiskPackageVersion(resolved.profileDir, modName)
          const existingEvolved = evolvedMap.get(key)
          if (existingEvolved) {
            existingEvolved.name = boundedModName
            if (diskVer !== null && (existingEvolved.version === null || /^v\d+$/u.test(existingEvolved.version))) {
              existingEvolved.version = diskVer
              existingEvolved.versionTier = 3
            }
            existingEvolved.enabled = enabled
            continue
          }
          if (coreByKey.has(key)) continue
          const installKind = inspectProfileInstallKind(resolved.profileDir, boundary, modName)
          coreByKey.set(key, {
            name: boundedModName,
            version: diskVer,
            ...(installKind === undefined ? {} : { installKind }),
            enabledStates: [enabled],
          })
        }
      } catch (error) {
        diagnostics.push(`loader.entries() failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  if (!pluginSourceAvailable && boundary) {
    const scanDirs: Array<{ profDir: string; profName: string | null }> = []
    const seenProfDirs = new Set<string>()
    for (const prof of targetProfiles) {
      const pDir = join(boundary.canonicalDshHome, 'profiles', prof)
      seenProfDirs.add(pDir)
      scanDirs.push({ profDir: pDir, profName: prof })
    }
    if (resolved.profileDir && !seenProfDirs.has(resolve(resolved.profileDir))) {
      scanDirs.push({ profDir: resolve(resolved.profileDir), profName: resolved.profileName })
    }
    for (const { profDir, profName } of scanDirs) {
      const scopeDir = join(profDir, 'node_modules', '@dsh-enhanced')
      const pnpmStoreRoot = resolve(profDir, 'node_modules', '.pnpm')
      try {
        if (!existsSync(scopeDir) || lstatSync(scopeDir).isSymbolicLink()) continue
        const profPatchStates = profName ? patchStatesByProfile.get(profName) : undefined
        const entries = readdirSync(scopeDir, { withFileTypes: true })
        pluginSourceAvailable = true
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name.startsWith('@')) continue
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
          const entryPath = join(scopeDir, entry.name)
          let installKind: 'npm' | 'local' = 'npm'
          if (entry.isSymbolicLink()) {
            try {
              const realPkgDir = realpathSync(entryPath)
              installKind = (realPkgDir === pnpmStoreRoot || realPkgDir.startsWith(`${pnpmStoreRoot}${sep}`))
                ? 'npm'
                : 'local'
            } catch {
              continue
            }
          }
          const pkgJsonPath = join(entryPath, 'package.json')
          try {
            if (!existsSync(pkgJsonPath)) continue
            const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name?: unknown; version?: unknown }
            if (typeof pkgJson.name !== 'string' || !isProjectPackage(pkgJson.name)) continue
            const boundedPkgName = boundNonEmptyString(pkgJson.name, 200)
            if (!boundedPkgName) continue
            const key = normalizePluginKey(pkgJson.name)
            const pkgVer = boundNonEmptyString(pkgJson.version, 128) ?? null
            const existingEvolved = evolvedMap.get(key)
            if (existingEvolved) {
              existingEvolved.name = boundedPkgName
              if (pkgVer !== null && (existingEvolved.version === null || /^v\d+$/u.test(existingEvolved.version))) {
                existingEvolved.version = pkgVer
                existingEvolved.versionTier = 3
              }
              continue
            }
            const ps = profPatchStates?.get(pkgJson.name)
            const enabledVal = ps !== undefined
              ? !(ps.disabled || ps.configEnabled === false)
              : undefined
            const existingCore = coreByKey.get(key)
            if (!existingCore) {
              coreByKey.set(key, {
                name: boundedPkgName,
                version: pkgVer,
                installKind,
                enabledStates: [enabledVal],
              })
            } else {
              if (existingCore.version === null && pkgVer !== null) existingCore.version = pkgVer
              if (installKind === 'local') existingCore.installKind = 'local'
              existingCore.enabledStates.push(enabledVal)
            }
          } catch {
            // Skip unreadable package.json
          }
        }
      } catch {
        // Ignore profile node_modules scan error
      }
    }
  }

  const corePlugins: AssistantVersionPluginEntry[] = [...coreByKey.values()]
    .map(entry => {
      const defined = entry.enabledStates.filter((v): v is boolean => v !== undefined)
      const enabled = defined.length > 0 ? defined.some(Boolean) : undefined
      return Object.freeze({
        name: entry.name,
        version: entry.version,
        kind: 'core' as const,
        ...(entry.installKind === undefined ? {} : { installKind: entry.installKind }),
        ...(enabled === undefined ? {} : { enabled }),
      })
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  const evolvedPlugins: AssistantVersionPluginEntry[] = [...evolvedMap.values()]
    .map(entry => {
      const rawVer = entry.version === null && entry.fromAdoptionJournal ? 'v1' : entry.version
      return Object.freeze({
        name: truncateText(entry.name, 200),
        version: rawVer === null ? null : boundNonEmptyString(rawVer, 128) ?? null,
        kind: 'evolved' as const,
        ...(entry.installKind === undefined ? {} : { installKind: entry.installKind }),
        ...(entry.enabled === undefined ? {} : { enabled: entry.enabled }),
      })
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  const pluginsState = corePlugins.length > 0 || evolvedPlugins.length > 0
    ? 'ok'
    : (pluginSourceAvailable || (profiles !== undefined && profiles.length > 0) || sawControlPlaneDb)
      ? 'zero'
      : 'unavailable'

  const allCounters = [
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
  const hasAnySource = allCounters.some(v => v !== null)
  const hasNonZero = allCounters.some(v => typeof v === 'number' && v > 0)
  const dataState = !hasAnySource ? 'no-data' : hasNonZero ? 'data' : 'zero'

  let totalIterations: number | null = null
  if (dataState !== 'no-data') {
    const engineSum = (workItemsTotal ?? 0)
      + (growthUsageJobsTotal ?? 0)
      + (dreamingRuns ?? 0)
      + (recoveryRuns ?? 0)
      + (goalStrategyRuns ?? 0)
      + (evolutionRulesAdopted ?? 0)
      + (associationProfileAdoptions ?? 0)
      + (evaluationAttentionTuningAdoptions ?? 0)
      + (evaluationLooseningDecisionsAdopted ?? 0)
      + (selfUpgrades ?? 0)
    if (engineSum > 0) {
      totalIterations = engineSum
    } else if (dataState === 'data') {
      totalIterations = Math.max(
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
    } else {
      totalIterations = 0
    }
  }

  const inspectedLedgers = [...inspectedLedgersSet]
    .sort()
    .map(entry => boundNonEmptyString(entry, 4_096))
    .filter((entry): entry is string => entry !== undefined)
    .slice(0, 256)
  const boundedDiagnostics = diagnostics
    .map(entry => boundNonEmptyString(entry, 1_024))
    .filter((entry): entry is string => entry !== undefined)
    .slice(0, 128)
  const rawDshHome = boundary ? boundary.canonicalDshHome : resolved.dshHome
  const boundedDshHome = rawDshHome === null ? null : truncateText(rawDshHome, 4_096)
  const boundedAssistantVersion = boundNonEmptyString(PACKAGE_VERSION, 128) ?? '0.0.0'
  const boundedBoundVersion = boundNonEmptyString(hostMeta.version, 128) ?? null
  const boundedBoundStatus = boundNonEmptyString(hostMeta.status, 64) ?? 'unknown'
  const boundedRunningVersion = boundNonEmptyString(runningHostVersion, 128) ?? null
  const boundedProfile = boundNonEmptyString(resolved.profileName, 128) ?? null
  const boundedProfiles = profiles
    ?.map(p => boundNonEmptyString(p, 128))
    .filter((p): p is string => p !== undefined)
    .slice(0, 64)

  return Object.freeze({
    schemaVersion: 1 as const,
    protocol: 'dsh-rsi/version/v1' as const,
    generatedAt,
    dshHome: boundedDshHome,
    assistant: Object.freeze({
      name: 'dsh-enhanced' as const,
      version: boundedAssistantVersion,
      ...(cliVersion === undefined ? {} : { cliVersion }),
    }),
    host: Object.freeze({
      packageName: '@deepseek-ai/dsh' as const,
      boundVersion: boundedBoundVersion,
      boundStatus: boundedBoundStatus,
      runningVersion: boundedRunningVersion,
    }),
    profile: boundedProfile,
    ...(boundedProfiles === undefined ? {} : { profiles: Object.freeze(boundedProfiles) }),
    plugins: Object.freeze({
      state: pluginsState,
      coreCount: corePlugins.length,
      evolvedCount: evolvedPlugins.length,
      activeEvolvedCount: evolvedPlugins.filter(entry => entry.enabled === true).length,
      core: Object.freeze(corePlugins.slice(0, 256)),
      evolved: Object.freeze(evolvedPlugins.slice(0, 256)),
    }),
    selfIteration: Object.freeze({
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
    }),
    ...(Object.keys(extensions).length === 0 ? {} : { extensions: Object.freeze(extensions) }),
    ...(inspectedLedgers.length === 0 ? {} : { inspectedLedgers: Object.freeze(inspectedLedgers) }),
    ...(boundedDiagnostics.length === 0 ? {} : { diagnostics: Object.freeze(boundedDiagnostics) }),
  })
}
