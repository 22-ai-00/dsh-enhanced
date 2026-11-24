import { existsSync } from 'node:fs'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { parseDocument } from 'yaml'
import { inspectBoundHostRuntime } from './install-host.ts'
import { listProfilePlugins, listProfiles, profilesDirectory, resolveDshHome } from './paths.ts'
import { PurgeError } from './purge.ts'
import { defaultRunner, type CommandRunner } from './run.ts'
import { version as VERSION } from './version.ts'

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

export interface CollectVersionReportOptions {
  readonly dshHome?: string
  readonly profile?: string
  readonly now?: number
  readonly runner?: CommandRunner
  readonly runningVersion?: string | null
  readonly inspectBoundHost?: typeof inspectBoundHostRuntime
}

const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const MAX_UPGRADE_HISTORY_BYTES = 4 * 1024 * 1024

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

function withTrailingSep(dirPath: string): string {
  return dirPath.endsWith(sep) ? dirPath : `${dirPath}${sep}`
}

function isWithinHome(target: string, dshHome: string, canonicalHome: string): boolean {
  return target === dshHome
    || target.startsWith(withTrailingSep(dshHome))
    || target === canonicalHome
    || target.startsWith(withTrailingSep(canonicalHome))
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

function resolveConfiguredPath(
  raw: unknown,
  dshHome: string,
  canonicalHome: string,
  diagnostics?: string[],
): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === ':memory:' || trimmed.includes('\0')) return undefined
  const jsMatch = /^(?:(?:!!js|!js)\s+)?dshHomePath\(\s*([\s\S]+?)\s*\)$/u.exec(trimmed)
  if (jsMatch?.[1] !== undefined) {
    const args = parseDshHomePathArgs(jsMatch[1])
    if (!args) {
      diagnostics?.push(`跳过无法解析的 dshHomePath 账本路径：${trimmed}`)
      return undefined
    }
    const resolved = resolve(dshHome, ...args)
    if (!isWithinHome(resolved, dshHome, canonicalHome)) {
      diagnostics?.push(`跳过越界 dshHomePath 账本路径：${trimmed}`)
      return undefined
    }
    return resolved
  }
  if (isAbsolute(trimmed)) {
    const resolved = resolve(trimmed)
    if (!isWithinHome(resolved, dshHome, canonicalHome)) {
      diagnostics?.push(`跳过越界账本路径：${trimmed}`)
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

async function collectPatchDbPaths(
  patchPath: string,
  dshHome: string,
  canonicalHome: string,
  into: PatchDbMap,
  configuredFamilies: Set<LedgerFamily>,
  patchStates: Map<string, PatchPluginState> | undefined,
  diagnostics: string[],
): Promise<void> {
  let st
  try {
    st = await lstat(patchPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    diagnostics.push(`无法访问配置 ${patchPath}：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (!st.isFile() || st.isSymbolicLink()) {
    diagnostics.push(`跳过非普通配置文件：${patchPath}`)
    return
  }
  const realPatch = await realpath(patchPath).catch(() => undefined)
  if (!realPatch || !isWithinHome(realPatch, dshHome, canonicalHome)) {
    diagnostics.push(`跳过越界配置文件：${patchPath}`)
    return
  }
  let source: string
  try {
    source = await readFile(realPatch, 'utf8')
  } catch (error) {
    diagnostics.push(`无法读取配置 ${patchPath}：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const doc = parseDocument(source, {
    customTags: [
      { tag: '!js', resolve: (val: string) => val },
      { tag: 'tag:yaml.org,2002:js', resolve: (val: string) => val },
    ],
  })
  if (doc.errors.length > 0) {
    diagnostics.push(`YAML 解析警告 ${patchPath}：${doc.errors[0]!.message}`)
    return
  }
  const root = doc.toJS()
  const walkRows = (items: unknown) => {
    if (!Array.isArray(items)) return
    for (const entry of items) {
      if (!entry || typeof entry !== 'object') continue
      const row = entry as Record<string, unknown>
      const id = typeof row.id === 'string' ? row.id : ''
      const name = typeof row.name === 'string' ? row.name : ''
      const cfg = row.config && typeof row.config === 'object' && !Array.isArray(row.config)
        ? row.config as Record<string, unknown>
        : {}

      const pkgName = normalizePluginPackageName(id, name)
      if (pkgName && patchStates) {
        patchStates.set(pkgName, {
          disabled: row.disabled === true,
          configEnabled: typeof cfg.enabled === 'boolean' ? cfg.enabled : undefined,
        })
      }

      // Note: intentionally inspect DB paths even when row.disabled === true
      // so historical self-iteration ledgers remain visible after `dsh-rsi disable`.
      const fam = classifyPluginFamily(id) ?? classifyPluginFamily(name)
      if (fam) {
        configuredFamilies.add(fam)
        if (fam === 'growthDriver') {
          const usage = cfg.usageLearning && typeof cfg.usageLearning === 'object'
            ? cfg.usageLearning as Record<string, unknown>
            : undefined
          const usagePath = resolveConfiguredPath(usage?.databasePath, dshHome, canonicalHome, diagnostics)
          if (usagePath) into.growthDriver.add(usagePath)
          const dbPath = resolveConfiguredPath(cfg.databasePath, dshHome, canonicalHome, diagnostics)
          if (dbPath) into.growthDriver.add(dbPath)
        } else if (fam === 'controlPlane') {
          const dbPath = resolveConfiguredPath(cfg.databasePath, dshHome, canonicalHome, diagnostics)
          if (dbPath) into.controlPlane.add(dbPath)
          const stateDir = resolveConfiguredPath(cfg.statePath, dshHome, canonicalHome, diagnostics)
          if (stateDir) {
            into.controlPlane.add(join(stateDir, 'control.sqlite'))
            into.controlPlane.add(join(stateDir, 'creation-adoptions.sqlite'))
            into.controlPlane.add(join(stateDir, 'revision-adoptions.sqlite'))
          }
        } else if (fam === 'goals') {
          const dbPath = resolveConfiguredPath(cfg.databasePath, dshHome, canonicalHome, diagnostics)
          if (dbPath) {
            into.goals.add(`${dbPath}.strategies`)
            into.goals.add(dbPath)
          }
        } else if (fam === 'verifier') {
          const dbPath = resolveConfiguredPath(cfg.databasePath, dshHome, canonicalHome, diagnostics)
          if (dbPath) addVerifierVariants(into.verifier, dbPath)
        } else {
          const dbPath = resolveConfiguredPath(cfg.databasePath, dshHome, canonicalHome, diagnostics)
          if (dbPath) into[fam].add(dbPath)
        }
      }
      if (id.includes('personal-assistant') || name.endsWith('/personal-assistant')) {
        configuredFamilies.add('memory')
        const pmCfg = cfg.personalMemory && typeof cfg.personalMemory === 'object' && !Array.isArray(cfg.personalMemory)
          ? cfg.personalMemory as Record<string, unknown>
          : undefined
        const pmPath = resolveConfiguredPath(pmCfg?.databasePath, dshHome, canonicalHome, diagnostics)
        if (pmPath) into.memory.add(pmPath)
      }
      if (Array.isArray(row.insert)) walkRows(row.insert)
      if (Array.isArray(row.config)) walkRows(row.config)
      if (Array.isArray(row.plugins)) walkRows(row.plugins)
    }
  }
  if (Array.isArray(root)) {
    walkRows(root)
  } else if (root && typeof root === 'object' && Array.isArray((root as Record<string, unknown>).plugins)) {
    walkRows((root as Record<string, unknown>).plugins)
  }
}

function hasTable(db: DatabaseSync, tableName: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(tableName) !== undefined
}

function hasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>
  return cols.some(col => col.name === columnName)
}

function queryCount(db: DatabaseSync, sql: string, ...params: Array<string | number>): number {
  const row = db.prepare(sql).get(...params) as { cnt?: unknown } | undefined
  const val = row?.cnt
  return typeof val === 'number' && Number.isFinite(val) ? val : 0
}

async function isAbsentOrZeroRegularFile(sidecarPath: string): Promise<boolean> {
  try {
    const st = await lstat(sidecarPath)
    return st.isFile() && !st.isSymbolicLink() && st.size === 0
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

async function isAbsentFile(sidecarPath: string): Promise<boolean> {
  try {
    await lstat(sidecarPath)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

async function isAbsentOrRegularFile(sidecarPath: string): Promise<boolean> {
  try {
    const st = await lstat(sidecarPath)
    return st.isFile() && !st.isSymbolicLink()
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

async function canPreferImmutable(realTarget: string): Promise<boolean> {
  return (await isAbsentOrZeroRegularFile(`${realTarget}-wal`))
    && (await isAbsentFile(`${realTarget}-shm`))
}

async function canFallbackImmutable(realTarget: string): Promise<boolean> {
  return (await isAbsentOrZeroRegularFile(`${realTarget}-wal`))
    && (await isAbsentOrRegularFile(`${realTarget}-shm`))
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
      try { db.close() } catch { /* ignore close error */ }
    }
    return { ok: false, integrityFailed: false, error }
  }
}

async function openReadOnlyDbs(
  candidates: Iterable<string>,
  dshHome: string,
  canonicalHome: string,
  diagnostics: string[],
  inspected: Set<string>,
): Promise<DatabaseSync[]> {
  const opened: DatabaseSync[] = []
  const seenTargets = new Set<string>()
  const seenRealPaths = new Set<string>()
  for (const raw of candidates) {
    const target = resolve(raw)
    if (seenTargets.has(target)) continue
    seenTargets.add(target)
    let st
    try {
      st = await lstat(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      diagnostics.push(`无法访问账本 ${target}：${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (!st.isFile() || st.isSymbolicLink()) {
      diagnostics.push(`跳过非普通账本文件：${target}`)
      continue
    }
    const realTarget = await realpath(target).catch(() => undefined)
    if (!realTarget) {
      diagnostics.push(`跳过无法解析真实路径的账本文件：${target}`)
      continue
    }
    if (
      !isWithinHome(target, dshHome, canonicalHome)
      || !isWithinHome(realTarget, dshHome, canonicalHome)
    ) {
      diagnostics.push(`跳过符号链接越界账本文件：${target}`)
      continue
    }
    if (seenRealPaths.has(realTarget)) continue
    seenRealPaths.add(realTarget)

    if (!(await isAbsentOrRegularFile(`${realTarget}-wal`)) || !(await isAbsentOrRegularFile(`${realTarget}-shm`))) {
      diagnostics.push(`跳过非普通或符号链接账本附属文件：${target}`)
      continue
    }

    const immutableUri = pathToFileURL(realTarget)
    immutableUri.search = 'mode=ro&immutable=1'

    if (await canPreferImmutable(realTarget)) {
      const immutableRes = tryOpenReadOnlySqlite(immutableUri.href)
      if (immutableRes.ok) {
        inspected.add(realTarget)
        opened.push(immutableRes.db)
        continue
      }
      if (immutableRes.integrityFailed) {
        diagnostics.push(`账本完整性检查未通过：${target}`)
        continue
      }
      const fallbackPlain = tryOpenReadOnlySqlite(realTarget)
      if (fallbackPlain.ok) {
        inspected.add(realTarget)
        opened.push(fallbackPlain.db)
        continue
      }
      if (fallbackPlain.integrityFailed) {
        diagnostics.push(`账本完整性检查未通过：${target}`)
        continue
      }
      const err = fallbackPlain.error ?? immutableRes.error
      diagnostics.push(`只读打开账本失败 ${target}：${err instanceof Error ? err.message : String(err)}`)
      continue
    }

    const primaryRes = tryOpenReadOnlySqlite(realTarget)
    if (primaryRes.ok) {
      inspected.add(realTarget)
      opened.push(primaryRes.db)
      continue
    }
    if (primaryRes.integrityFailed) {
      diagnostics.push(`账本完整性检查未通过：${target}`)
      continue
    }
    if (await canFallbackImmutable(realTarget)) {
      const immutableRes = tryOpenReadOnlySqlite(immutableUri.href)
      if (immutableRes.ok) {
        inspected.add(realTarget)
        opened.push(immutableRes.db)
        continue
      }
      if (immutableRes.integrityFailed) {
        diagnostics.push(`账本完整性检查未通过：${target}`)
        continue
      }
    }
    diagnostics.push(
      `只读打开账本失败 ${target}：${primaryRes.error instanceof Error ? primaryRes.error.message : String(primaryRes.error)}`,
    )
  }
  return opened
}

function closeAll(dbs: readonly DatabaseSync[]): void {
  for (const db of dbs) {
    try { db.close() } catch { /* ignore close error */ }
  }
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

async function readPackageVersionSafe(packageJsonPath: string): Promise<string | null> {
  try {
    const st = await lstat(packageJsonPath)
    if (!st.isFile() || st.isSymbolicLink()) return null
    const raw = await readFile(packageJsonPath, 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version.trim().length > 0
      ? parsed.version.trim()
      : null
  } catch {
    return null
  }
}

async function readUpgradeHistory(
  dshHome: string,
  canonicalHome: string,
  diagnostics: string[],
): Promise<{ count: number | null; latestEntry?: Record<string, unknown> }> {
  const historyPath = join(dshHome, '.dsh-enhanced', 'upgrade-history.jsonl')
  let st
  try {
    st = await lstat(historyPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { count: null }
    diagnostics.push(`无法访问升级历史文件 ${historyPath}：${error instanceof Error ? error.message : String(error)}`)
    return { count: null }
  }
  if (!st.isFile() || st.isSymbolicLink()) {
    diagnostics.push(`跳过非普通升级历史文件：${historyPath}`)
    return { count: null }
  }
  const realHistory = await realpath(historyPath).catch(() => undefined)
  if (!realHistory || !isWithinHome(realHistory, dshHome, canonicalHome)) {
    diagnostics.push(`跳过越界升级历史文件：${historyPath}`)
    return { count: null }
  }
  if (st.size > MAX_UPGRADE_HISTORY_BYTES) {
    diagnostics.push(`升级历史文件过大（>${MAX_UPGRADE_HISTORY_BYTES} 字节），已跳过：${historyPath}`)
    return { count: null }
  }
  let text: string
  try {
    text = await readFile(realHistory, 'utf8')
  } catch (error) {
    diagnostics.push(`读取升级历史失败 ${historyPath}：${error instanceof Error ? error.message : String(error)}`)
    return { count: null }
  }
  let count = 0
  let latestEntry: Record<string, unknown> | undefined
  let malformed = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        count += 1
        latestEntry = parsed as Record<string, unknown>
      } else {
        malformed += 1
      }
    } catch {
      malformed += 1
    }
  }
  if (malformed > 0) {
    diagnostics.push(`升级历史文件存在 ${malformed} 条格式无效记录：${historyPath}`)
  }
  return { count, ...(latestEntry !== undefined ? { latestEntry } : {}) }
}

async function countBackupSnapshots(
  dshHome: string,
  canonicalHome: string,
  diagnostics: string[],
): Promise<number | null> {
  const backupsDir = join(dshHome, '.dsh-rsi-upgrade-backups')
  let st
  try {
    st = await lstat(backupsDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    diagnostics.push(`无法访问升级备份目录 ${backupsDir}：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  if (!st.isDirectory() || st.isSymbolicLink()) {
    diagnostics.push(`跳过非普通升级备份目录：${backupsDir}`)
    return null
  }
  const realBackups = await realpath(backupsDir).catch(() => undefined)
  if (!realBackups || !isWithinHome(realBackups, dshHome, canonicalHome)) {
    diagnostics.push(`跳过越界升级备份目录：${backupsDir}`)
    return null
  }
  let entries: string[]
  try {
    entries = await readdir(realBackups)
  } catch (error) {
    diagnostics.push(`读取升级备份目录失败 ${backupsDir}：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  let count = 0
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const entryMeta = await lstat(join(realBackups, entry)).catch(() => undefined)
    if (entryMeta && entryMeta.isDirectory() && !entryMeta.isSymbolicLink()) {
      count += 1
    }
  }
  return count
}

async function readInstallIntentSafe(
  dshHome: string,
  canonicalHome: string,
): Promise<Record<string, unknown> | undefined> {
  const intentPath = join(dshHome, '.dsh-enhanced', 'install-intent.json')
  try {
    const st = await lstat(intentPath)
    if (!st.isFile() || st.isSymbolicLink() || st.size > 65_536) return undefined
    const realIntent = await realpath(intentPath)
    if (!isWithinHome(realIntent, dshHome, canonicalHome)) return undefined
    const parsed = JSON.parse(await readFile(realIntent, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const obj = parsed as Record<string, unknown>
    if (typeof obj.schemaVersion !== 'number' || typeof obj.scenario !== 'string') return undefined
    return obj
  } catch {
    return undefined
  }
}

export async function collectVersionReport(options?: CollectVersionReportOptions): Promise<AssistantVersionReport> {
  const generatedAt = options?.now ?? Date.now()
  const dshHome = resolve(options?.dshHome ?? resolveDshHome())
  if (options?.profile !== undefined && !PROFILE_NAME_RE.test(options.profile)) {
    throw new PurgeError(`--profile 名称格式无效：${options.profile}`)
  }

  const diagnostics: string[] = []
  let homeExists = false
  let canonicalHome = dshHome
  if (existsSync(dshHome)) {
    try {
      const homeStat = await lstat(dshHome)
      if (homeStat.isDirectory() || homeStat.isSymbolicLink()) {
        const resolvedReal = await realpath(dshHome).catch(() => undefined)
        if (resolvedReal) {
          const realStat = await lstat(resolvedReal).catch(() => undefined)
          if (realStat?.isDirectory()) {
            homeExists = true
            canonicalHome = resolvedReal
          } else {
            diagnostics.push(`DSH_HOME 不是目录：${dshHome}`)
          }
        }
      } else {
        diagnostics.push(`DSH_HOME 不是目录：${dshHome}`)
      }
    } catch (error) {
      diagnostics.push(`无法检查 DSH_HOME ${dshHome}：${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    diagnostics.push(`DSH_HOME 不存在：${dshHome}`)
  }

  const discoveredProfiles = homeExists ? await listProfiles(dshHome).catch(() => []) : []
  if (options?.profile !== undefined && homeExists && !discoveredProfiles.includes(options.profile)) {
    const explicitDir = join(dshHome, 'profiles', options.profile)
    if (!existsSync(explicitDir)) {
      diagnostics.push(`未找到 profile "${options.profile}"（当前可用：${discoveredProfiles.join(', ') || '无'}）`)
    }
  }
  const activeProfile = options?.profile ?? (discoveredProfiles.length === 1 ? discoveredProfiles[0]! : null)
  const targetProfiles = options?.profile !== undefined ? [options.profile] : discoveredProfiles

  const inspectBound = options?.inspectBoundHost ?? inspectBoundHostRuntime
  const boundHost = homeExists
    ? await inspectBound(dshHome).catch((error: unknown) => ({
        status: 'invalid' as const,
        bindingPath: join(dshHome, '.dsh-rsi-host.json'),
        issues: [] as string[],
        error: error instanceof Error ? error.message : String(error),
      }))
    : {
        status: 'missing' as const,
        bindingPath: join(dshHome, '.dsh-rsi-host.json'),
        issues: [] as string[],
      }

  const boundStatus = boundHost.status
  const boundVersion = 'version' in boundHost && typeof boundHost.version === 'string' ? boundHost.version : null
  if ('error' in boundHost && typeof boundHost.error === 'string' && boundHost.error.length > 0) {
    diagnostics.push(boundHost.error)
  }
  for (const issue of boundHost.issues) {
    diagnostics.push(issue)
  }

  let runningVersion: string | null = null
  if (options?.runningVersion !== undefined) {
    runningVersion = options.runningVersion
  } else {
    const runner = options?.runner ?? defaultRunner
    const boundDshPath = 'dshPath' in boundHost && typeof boundHost.dshPath === 'string' ? boundHost.dshPath : undefined
    if (boundStatus === 'ready' && boundDshPath) {
      const boundRun = runner(boundDshPath, ['--version'])
      if (boundRun.status === 0 && boundRun.stdout.trim().length > 0) {
        runningVersion = boundRun.stdout.trim()
      } else {
        const fallbackRun = runner('dsh', ['--version'])
        if (fallbackRun.status === 0 && fallbackRun.stdout.trim().length > 0) {
          runningVersion = fallbackRun.stdout.trim()
        } else {
          diagnostics.push(`无法通过已绑定 Host (${boundDshPath}) 读取运行中 dsh 版本`)
        }
      }
    } else {
      const hostRun = runner('dsh', ['--version'])
      if (hostRun.status === 0 && hostRun.stdout.trim().length > 0) {
        runningVersion = hostRun.stdout.trim()
      }
    }
  }

  const inspected = new Set<string>()
  const dbMap: PatchDbMap = {
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

  if (homeExists) {
    const configuredFamilies = new Set<LedgerFamily>()
    if (options?.profile === undefined) {
      await collectPatchDbPaths(join(dshHome, 'cordis.yml'), dshHome, canonicalHome, dbMap, configuredFamilies, homePatchStates, diagnostics)
      await collectPatchDbPaths(join(dshHome, 'cordis.patch.yml'), dshHome, canonicalHome, dbMap, configuredFamilies, homePatchStates, diagnostics)
    }
    for (const prof of targetProfiles) {
      const profPatchStates = new Map<string, PatchPluginState>(homePatchStates)
      await collectPatchDbPaths(join(dshHome, 'profiles', prof, 'cordis.yml'), dshHome, canonicalHome, dbMap, configuredFamilies, profPatchStates, diagnostics)
      await collectPatchDbPaths(join(dshHome, 'profiles', prof, 'cordis.patch.yml'), dshHome, canonicalHome, dbMap, configuredFamilies, profPatchStates, diagnostics)
      patchStatesByProfile.set(prof, profPatchStates)

      const installed = await listProfilePlugins(dshHome, prof).catch(() => [])
      for (const pkg of installed) {
        const fam = classifyPluginFamily(pkg.name)
        if (fam) configuredFamilies.add(fam)
        if (pkg.name === '@dsh-enhanced/personal-assistant') configuredFamilies.add('memory')
      }
    }

    const filterByProfile = options?.profile !== undefined
    const allowFamily = (fam: LedgerFamily): boolean => !filterByProfile || configuredFamilies.has(fam)

    const profNames = targetProfiles.length > 0 ? targetProfiles : (filterByProfile ? [options!.profile!] : ['web', 'lark', 'supervised'])

    if (!filterByProfile || configuredFamilies.has('workItems')) {
      dbMap.workItems.add(join(dshHome, 'assistant-work-items', 'state.sqlite'))
    }
    if (allowFamily('growthDriver')) {
      dbMap.growthDriver.add(join(dshHome, 'assistant-growth-driver', 'usage.sqlite'))
      dbMap.growthDriver.add(join(dshHome, 'assistant-growth-driver', 'state.sqlite'))
    }
    if (allowFamily('dreaming')) {
      dbMap.dreaming.add(join(dshHome, 'assistant-dreaming', 'state.sqlite'))
      dbMap.dreaming.add(join(dshHome, 'assistant-dreaming', 'dreaming.sqlite'))
    }
    if (allowFamily('recovery')) {
      dbMap.recovery.add(join(dshHome, 'assistant-recovery', 'state.sqlite'))
      dbMap.recovery.add(join(dshHome, 'assistant-recovery', 'recovery.sqlite'))
    }
    if (allowFamily('goals')) {
      dbMap.goals.add(join(dshHome, 'assistant-goals.sqlite.strategies'))
      dbMap.goals.add(join(dshHome, 'assistant-goals', 'state.sqlite.strategies'))
      dbMap.goals.add(join(dshHome, 'assistant-goals', 'strategies.sqlite'))
      dbMap.goals.add(join(dshHome, 'assistant-goals', 'strategy.sqlite'))
    }
    if (allowFamily('memoryLearning')) {
      dbMap.memoryLearning.add(join(dshHome, 'assistant-memory-learning', 'state.sqlite'))
      dbMap.memoryLearning.add(join(dshHome, 'assistant-memory-learning', 'learning.sqlite'))
    }
    if (allowFamily('memory')) {
      dbMap.memory.add(join(dshHome, 'personal-memory', 'memory.sqlite'))
      dbMap.memory.add(join(dshHome, 'personal-memory', 'state.sqlite'))
    }
    if (allowFamily('preference')) {
      dbMap.preference.add(join(dshHome, 'preference-learning', 'preferences.sqlite'))
      dbMap.preference.add(join(dshHome, 'preference-learning', 'state.sqlite'))
    }
    if (allowFamily('evolution')) {
      dbMap.evolution.add(join(dshHome, 'assistant-evolution', 'evolution.sqlite'))
      dbMap.evolution.add(join(dshHome, 'assistant-evolution', 'state.sqlite'))
    }
    if (allowFamily('skills')) {
      dbMap.skills.add(join(dshHome, 'assistant-skills', 'skills.sqlite'))
      dbMap.skills.add(join(dshHome, 'assistant-skills', 'state.sqlite'))
    }
    if (allowFamily('growthExperiments')) {
      dbMap.growthExperiments.add(join(dshHome, 'assistant-growth-experiments', 'growth.sqlite'))
      dbMap.growthExperiments.add(join(dshHome, 'assistant-growth-experiments', 'state.sqlite'))
    }
    if (allowFamily('association')) {
      dbMap.association.add(join(dshHome, 'assistant-association', 'state.sqlite'))
      dbMap.association.add(join(dshHome, 'assistant-association', 'association.sqlite'))
      dbMap.association.add(join(dshHome, 'association.sqlite'))
      dbMap.association.add(join(dshHome, 'assistant-association.sqlite'))
    }
    if (allowFamily('evaluation')) {
      dbMap.evaluation.add(join(dshHome, 'assistant-evaluation', 'evaluation.sqlite'))
      dbMap.evaluation.add(join(dshHome, 'assistant-evaluation', 'state.sqlite'))
    }
    if (allowFamily('verifier')) {
      addVerifierVariants(dbMap.verifier, join(dshHome, 'assistant-verifier', 'verification.sqlite'))
      addVerifierVariants(dbMap.verifier, join(dshHome, 'assistant-verifier', 'state.sqlite'))
    }
    if (allowFamily('controlPlane')) {
      dbMap.controlPlane.add(join(dshHome, 'plugin-control-plane', 'control.sqlite'))
      dbMap.controlPlane.add(join(dshHome, 'plugin-control-plane', 'state.sqlite'))
      dbMap.controlPlane.add(join(dshHome, 'plugin-control-plane', 'creation-adoptions.sqlite'))
      dbMap.controlPlane.add(join(dshHome, 'plugin-control-plane', 'revision-adoptions.sqlite'))
    }

    for (const prof of profNames) {
      if (allowFamily('workItems')) dbMap.workItems.add(join(dshHome, 'assistant-work-items', `${prof}.sqlite`))
      if (allowFamily('growthDriver')) {
        dbMap.growthDriver.add(join(dshHome, 'assistant-growth-driver', `${prof}-usage.sqlite`))
        dbMap.growthDriver.add(join(dshHome, 'assistant-growth-driver', `${prof}.sqlite`))
      }
      if (allowFamily('dreaming')) dbMap.dreaming.add(join(dshHome, 'assistant-dreaming', `${prof}.sqlite`))
      if (allowFamily('recovery')) dbMap.recovery.add(join(dshHome, 'assistant-recovery', `${prof}.sqlite`))
      if (allowFamily('goals')) {
        dbMap.goals.add(join(dshHome, 'assistant-goals', `${prof}.sqlite.strategies`))
        dbMap.goals.add(join(dshHome, 'assistant-goals', `${prof}.sqlite`))
      }
      if (allowFamily('memoryLearning')) dbMap.memoryLearning.add(join(dshHome, 'assistant-memory-learning', `${prof}.sqlite`))
      if (allowFamily('memory')) dbMap.memory.add(join(dshHome, 'personal-memory', `${prof}.sqlite`))
      if (allowFamily('preference')) dbMap.preference.add(join(dshHome, 'preference-learning', `${prof}.sqlite`))
      if (allowFamily('evolution')) dbMap.evolution.add(join(dshHome, 'assistant-evolution', `${prof}.sqlite`))
      if (allowFamily('skills')) dbMap.skills.add(join(dshHome, 'assistant-skills', `${prof}.sqlite`))
      if (allowFamily('growthExperiments')) dbMap.growthExperiments.add(join(dshHome, 'assistant-growth-experiments', `${prof}.sqlite`))
      if (allowFamily('association')) dbMap.association.add(join(dshHome, 'assistant-association', `${prof}.sqlite`))
      if (allowFamily('evaluation')) dbMap.evaluation.add(join(dshHome, 'assistant-evaluation', `${prof}.sqlite`))
      if (allowFamily('verifier')) {
        addVerifierVariants(dbMap.verifier, join(dshHome, 'assistant-verifier', `${prof}.sqlite`))
      }
      if (allowFamily('controlPlane')) {
        dbMap.controlPlane.add(join(dshHome, 'plugin-control-plane', `${prof}.sqlite`))
        dbMap.controlPlane.add(join(dshHome, 'plugin-control-plane', `${prof}-creation-adoptions.sqlite`))
        dbMap.controlPlane.add(join(dshHome, 'plugin-control-plane', `${prof}-revision-adoptions.sqlite`))
        dbMap.controlPlane.add(join(dshHome, 'rsi-authorities', prof, 'state', 'control-plane', 'control.sqlite'))
        dbMap.controlPlane.add(join(dshHome, 'rsi-authorities', prof, 'state', 'control-plane', 'creation-adoptions.sqlite'))
        dbMap.controlPlane.add(join(dshHome, 'rsi-authorities', prof, 'state', 'control-plane', 'revision-adoptions.sqlite'))
      }
    }
  }

  // Counters and saw-table flags
  let sawWorkItemsTotal = false
  let workItemsTotal = 0
  let sawWorkItemsSettled = false
  let workItemsSettled = 0

  let sawGrowthUsageJobs = false
  let growthUsageJobsTotal = 0

  let sawDreamingRuns = false
  let dreamingRuns = 0
  let sawDreamingIdeas = false
  let dreamingIdeasTotal = 0
  let dreamingIdeasValidated = 0
  let dreamingIdeasOwnerAck = 0

  let sawRecoveryRuns = false
  let recoveryRuns = 0

  let sawGoalStrategyRuns = false
  let goalStrategyRuns = 0

  let sawMemoryLearningJobs = false
  let memoryLearningJobsTotal = 0
  let memoryLearningJobsAdopted = 0

  let sawActiveMemories = false
  let activeMemories = 0

  let sawPreferenceHypotheses = false
  let preferenceHypothesesTotal = 0
  let activePreferenceOverlays = 0
  let preferenceHypothesesActivatedFallback = 0
  let sawPreferenceTransitions = false
  let preferenceTransitionsCreated = 0
  let preferenceTransitionsActivated = 0
  let preferenceTransitionsRolledBack = 0

  let sawEvolutionProposals = false
  let evolutionProposalsTotal = 0
  let sawEvolutionRules = false
  let evolutionRulesAdopted = 0
  let sawEvolutionRollbacks = false
  let evolutionRollbacks = 0

  let sawSkillCandidates = false
  let skillCandidatesTotal = 0
  let sawSkillDeployments = false
  let skillDeployments = 0
  let skillRollbacks = 0

  let sawWorkflowCandidates = false
  let workflowCandidatesTotal = 0
  let workflowCandidatesPromoted = 0
  let workflowRollbacks = 0

  let sawAssocParamHead = false
  let associationParamVersion: number | null = null
  let sawAssocParamEvents = false
  let associationProfileAdoptions = 0
  let associationProfileRollbacks = 0

  let sawEvalTuningEvents = false
  let evaluationAttentionTuningAdoptions = 0
  let evaluationAttentionTuningRollbacks = 0
  let sawEvalLoosening = false
  let evaluationLooseningDecisionsAdopted = 0

  let sawAcceptanceJobs = false
  let taskVerificationsDone = 0
  let sawVerifierReviews = false
  let verifierVerificationsTotal = 0
  let verifierReviewsTotal = 0
  let verifierReviewsApproved = 0

  // Control-plane & adoption tracking
  let sawControlPlaneDb = false
  let sawControlSourcePlans = false
  let sawControlActivationPlans = false
  let sawCreationAdoptions = false
  let sawRevisionAdoptions = false
  let sawRevisionRollbacks = false

  let controlSourcePlansTotal = 0
  let controlUnlinkedActivationPlans = 0
  let controlActivatedPlans = 0
  let controlUnlinkedCompletedSourcePlans = 0
  let controlRollbackPlans = 0
  let revisionRollbacksCount = 0

  const createdPlanIds = new Set<string>()
  const revisedPlanIds = new Set<string>()
  const createdAdoptionCandidates = new Set<string>()
  const revisedAdoptionCandidates = new Set<string>()

  interface MutableEvolvedEntry {
    name: string
    version: string | null
    enabled: boolean
    installKind: 'adopted'
  }
  const evolvedByPlanId = new Map<string, MutableEvolvedEntry>()
  const evolvedByName = new Map<string, MutableEvolvedEntry>()

  const upsertEvolvedByName = (name: string, next: MutableEvolvedEntry): void => {
    const existing = evolvedByName.get(name)
    if (!existing) {
      evolvedByName.set(name, { ...next })
      return
    }
    if (next.version !== null) existing.version = next.version
    existing.enabled = existing.enabled || next.enabled
  }

  // 1. Work Items
  if (homeExists) {
    const dbs = await openReadOnlyDbs(dbMap.workItems, dshHome, canonicalHome, diagnostics, inspected)
    try {
      for (const db of dbs) {
        if (hasTable(db, 'work_item')) {
          sawWorkItemsTotal = true
          workItemsTotal += queryCount(db, 'SELECT COUNT(*) AS cnt FROM work_item')
        }
        if (hasTable(db, 'work_item_outcome')) {
          sawWorkItemsSettled = true
          workItemsSettled += queryCount(db, 'SELECT COUNT(DISTINCT item_id) AS cnt FROM work_item_outcome')
        }
      }
    } finally {
      closeAll(dbs)
    }
  }

  // 2. Growth Driver
  if (homeExists) {
    const dbs = await openReadOnlyDbs(dbMap.growthDriver, dshHome, canonicalHome, diagnostics, inspected)
    try {
      for (const db of dbs) {
        if (hasTable(db, 'usage_jobs')) {
          sawGrowthUsageJobs = true
          growthUsageJobsTotal += queryCount(db, 'SELECT COUNT(*) AS cnt FROM usage_jobs')
        }
      }
    } finally {
      closeAll(dbs)
    }
  }

  // 3. Dreaming
  if (homeExists) {
    const dbs = await openReadOnlyDbs(dbMap.dreaming, dshHome, canonicalHome, diagnostics, inspected)
    try {
      for (const db of dbs) {
        if (hasTable(db, 'dream_runs')) {
          sawDreamingRuns = true
          dreamingRuns += queryCount(db, 'SELECT COUNT(*) AS cnt FROM dream_runs')
        }
        if (hasTable(db, 'dream_ideas')) {
          sawDreamingIdeas = true
          dreamingIdeasTotal += queryCount(db, 'SELECT COUNT(*) AS cnt FROM dream_ideas')
          dreamingIdeasValidated += queryCount(db, "SELECT COUNT(*) AS cnt FROM dream_ideas WHERE state = 'validated'")
          dreamingIdeasOwnerAck += queryCount(db, "SELECT COUNT(*) AS cnt FROM dream_ideas WHERE state = 'owner-acknowledged'")
        }
      }
    } finally {
      closeAll(dbs)
    }
  }

  // 4. Recovery
  if (homeExists) {
    const dbs = await openReadOnlyDbs(dbMap.recovery, dshHome, canonicalHome, diagnostics, inspected)
    try {
      for (const db of dbs) {
        if (hasTable(db, 'recovery_runs')) {
          sawRecoveryRuns = true
          recoveryRuns += queryCount(db, 'SELECT COUNT(*) AS cnt FROM recovery_runs')
        }
      }
    } finally {
      closeAll(dbs)
    }
  }

  // 5. Goal Strategy Runs
  if (homeExists) {
    const dbs = await openReadOnlyDbs(dbMap.goals, dshHome, canonicalHome, diagnostics, inspected)
    try {
      for (const db of dbs) {
        if (hasTable(db, 'goal_strategy_records')) {
          sawGoalStrategyRuns = true
          goalStrategyRuns += queryCount(db, 'SELECT COUNT(*) AS cnt FROM goal_strategy_records')
        }
      }
    } finally {
      closeAll(dbs)
    }
  }

  // 6. Memory Learning
  if (homeExists) {
    const dbs = await openReadOnlyDbs(dbMap.memoryLearning, dshHome, canonicalHome, diagnostics, inspected)
    try {
      for (const db of dbs) {
        if (hasTable(db, 'jobs')) {
          sawMemoryLearningJobs = true
          memoryLearningJobsTotal += queryCount(db, 'SELECT COUNT(*) AS cnt FROM jobs')
          memoryLearningJobsAdopted += queryCount(db, "SELECT COUNT(*) AS cnt FROM jobs WHERE state = 'adopted'")
        }
      }
    } finally {
      closeAll(dbs)
    }
  }

  // 7. Personal Memory
  if (homeExists) {
    const dbs = await openReadOnlyDbs(dbMap.memory, dshHome, canonicalHome, diagnostics, inspected)
    try {
      for (const db of dbs) {
        if (hasTable(db, 'memory_records')) {
          sawActiveMemories = true
          activeMemories += queryCount(db, "SELECT COUNT(*) AS cnt FROM memory_records WHERE status = 'active'")
        }
      }
    } finally {
      closeAll(dbs)
    }
  }

  // 8. Preference Learning
  if (homeExists) {
    const dbs = await openReadOnlyDbs(dbMap.preference, dshHome, canonicalHome, diagnostics, inspected)
    try {
      for (const db of dbs) {
        if (hasTable(db, 'preference_hypotheses')) {
          sawPreferenceHypotheses = true
          preferenceHypothesesTotal += queryCount(db, 'SELECT COUNT(*) AS cnt FROM preference_hypotheses')
          activePreferenceOverlays += queryCount(db, "SELECT COUNT(*) AS cnt FROM preference_hypotheses WHERE effect_state = 'active'")
          if (hasColumn(db, 'preference_hypotheses', 'activated_at')) {
            preferenceHypothesesActivatedFallback += queryCount(
              db,
              'SELECT COUNT(*) AS cnt FROM preference_hypotheses WHERE activated_at IS NOT NULL',
            )
          }
        }
        if (hasTable(db, 'preference_transitions')) {
          sawPreferenceTransitions = true
          preferenceTransitionsCreated += queryCount(db, "SELECT COUNT(*) AS cnt FROM preference_transitions WHERE reason = 'created'")
          preferenceTransitionsActivated += queryCount(db, "SELECT COUNT(*) AS cnt FROM preference_transitions WHERE reason = 'activated'")
          preferenceTransitionsRolledBack += queryCount(
            db,
            "SELECT COUNT(*) AS cnt FROM preference_transitions WHERE reason IN ('regression', 'operator-request')",
          )
        }
      }
    } finally {
      closeAll(dbs)
    }
  }

  // 9. Assistant Evolution
  if (homeExists) {
    const dbs = await openReadOnlyDbs(dbMap.evolution, dshHome, canonicalHome, diagnostics, inspected)
    try {
      for (const db of dbs) {
        if (hasTable(db, 'evolution_proposals')) {
          sawEvolutionProposals = true
          evolutionProposalsTotal += queryCount(db, 'SELECT COUNT(*) AS cnt FROM evolution_proposals')
        }
        if (hasTable(db, 'evolution_rules')) {
          sawEvolutionRules = true
          evolutionRulesAdopted += queryCount(db, 'SELECT COUNT(*) AS cnt FROM evolution_rules')
        }
        if (hasTable(db, 'evolution_autonomous_rollbacks')) {
          sawEvolutionRollbacks = true
          evolutionRollbacks += queryCount(db, 'SELECT COUNT(*) AS cnt FROM evolution_autonomous_rollbacks')
        }
      }
    } finally {
      closeAll(dbs)
    }
  }

  // 10. Assistant Skills
  if (homeExists) {
    const dbs = await openReadOnlyDbs(dbMap.skills, dshHome, canonicalHome, diagnostics, inspected)
    try {
      for (const db of dbs) {
        if (hasTable(db, 'skill_candidates')) {
          sawSkillCandidates = true
          skillCandidatesTotal += queryCount(db, 'SELECT COUNT(*) AS cnt FROM skill_candidates')
        }
        if (hasTable(db, 'skill_deployments')) {
          sawSkillDeployments = true
          skillDeployments += queryCount(db, "SELECT COUNT(*) AS cnt FROM skill_deployments WHERE state IN ('canary', 'promoted')")
          skillRollbacks += queryCount(db, "SELECT COUNT(*) AS cnt FROM skill_deployments WHERE state IN ('rolled-back', 'revoked')")
        }
      }
    } finally {
      closeAll(dbs)
    }
  }

  // 11. Assistant Growth Experiments
  if (homeExists) {
    const dbs = await openReadOnlyDbs(dbMap.growthExperiments, dshHome, canonicalHome, diagnostics, inspected)
    try {
      for (const db of dbs) {
        if (hasTable(db, 'workflow_candidates')) {
          sawWorkflowCandidates = true
          workflowCandidatesTotal += queryCount(db, 'SELECT COUNT(*) AS cnt FROM workflow_candidates')
          workflowCandidatesPromoted += queryCount(db, "SELECT COUNT(*) AS cnt FROM workflow_candidates WHERE state = 'promoted'")
          workflowRollbacks += queryCount(db, "SELECT COUNT(*) AS cnt FROM workflow_candidates WHERE state = 'rolled-back'")
        }
      }
    } finally {
      closeAll(dbs)
    }
  }

  // 12. Assistant Association
  if (homeExists) {
    const dbs = await openReadOnlyDbs(dbMap.association, dshHome, canonicalHome, diagnostics, inspected)
    try {
      for (const db of dbs) {
        if (hasTable(db, 'assoc_param_profile_heads')) {
          sawAssocParamHead = true
          const row = db.prepare('SELECT MAX(active_version) AS max_ver FROM assoc_param_profile_heads').get() as {
            max_ver?: unknown
          } | undefined
          const maxVer = typeof row?.max_ver === 'number' && Number.isFinite(row.max_ver) ? row.max_ver : 0
          associationParamVersion = associationParamVersion === null ? maxVer : Math.max(associationParamVersion, maxVer)
        }
        if (hasTable(db, 'assoc_param_profile_events')) {
          sawAssocParamEvents = true
          associationProfileAdoptions += queryCount(db, "SELECT COUNT(*) AS cnt FROM assoc_param_profile_events WHERE kind = 'adopted'")
          associationProfileRollbacks += queryCount(db, "SELECT COUNT(*) AS cnt FROM assoc_param_profile_events WHERE kind = 'rolled-back'")
        }
      }
    } finally {
      closeAll(dbs)
    }
  }

  // 13. Assistant Evaluation
  if (homeExists) {
    const dbs = await openReadOnlyDbs(dbMap.evaluation, dshHome, canonicalHome, diagnostics, inspected)
    try {
      for (const db of dbs) {
        if (hasTable(db, 'evaluation_attention_tuning_events')) {
          sawEvalTuningEvents = true
          evaluationAttentionTuningAdoptions += queryCount(
            db,
            "SELECT COUNT(*) AS cnt FROM evaluation_attention_tuning_events WHERE kind = 'adopted'",
          )
          evaluationAttentionTuningRollbacks += queryCount(
            db,
            "SELECT COUNT(*) AS cnt FROM evaluation_attention_tuning_events WHERE kind = 'rolled-back'",
          )
        }
        if (hasTable(db, 'evaluation_attention_loosening_decisions')) {
          sawEvalLoosening = true
          evaluationLooseningDecisionsAdopted += queryCount(
            db,
            "SELECT COUNT(*) AS cnt FROM evaluation_attention_loosening_decisions WHERE decision = 'adopted'",
          )
        }
      }
    } finally {
      closeAll(dbs)
    }
  }

  // 14. Assistant Verifier
  if (homeExists) {
    const dbs = await openReadOnlyDbs(dbMap.verifier, dshHome, canonicalHome, diagnostics, inspected)
    try {
      for (const db of dbs) {
        if (hasTable(db, 'acceptance_jobs')) {
          sawAcceptanceJobs = true
          taskVerificationsDone += queryCount(db, "SELECT COUNT(*) AS cnt FROM acceptance_jobs WHERE state = 'done'")
        }
        if (hasTable(db, 'verifications')) {
          sawVerifierReviews = true
          verifierVerificationsTotal += queryCount(db, 'SELECT COUNT(*) AS cnt FROM verifications')
        }
        if (hasTable(db, 'reviews')) {
          sawVerifierReviews = true
          verifierReviewsTotal += queryCount(db, 'SELECT COUNT(*) AS cnt FROM reviews')
          verifierReviewsApproved += queryCount(db, "SELECT COUNT(*) AS cnt FROM reviews WHERE state = 'approved'")
        }
      }
    } finally {
      closeAll(dbs)
    }
  }

  // 15. Plugin Control Plane (creation-adoptions -> revision-adoptions -> control.sqlite)
  if (homeExists) {
    const dbs = await openReadOnlyDbs(dbMap.controlPlane, dshHome, canonicalHome, diagnostics, inspected)
    if (dbs.length > 0) sawControlPlaneDb = true
    try {
      // Pass A: creation-adoptions.sqlite (`adoptions` without `parent_plan_id`)
      for (const db of dbs) {
        if (hasTable(db, 'adoptions') && !hasTable(db, 'entries') && !hasColumn(db, 'adoptions', 'parent_plan_id')) {
          sawCreationAdoptions = true
          const hasCertJson = hasColumn(db, 'adoptions', 'certificate_json')
          const rows = db.prepare(
            hasCertJson
              ? 'SELECT plan_id, status, certificate_json FROM adoptions'
              : 'SELECT plan_id, status FROM adoptions',
          ).all() as Array<{
            plan_id?: string
            status?: string
            certificate_json?: string
          }>
          for (const row of rows) {
            if (typeof row.plan_id !== 'string') continue
            const cert = parseJsonObject(row.certificate_json)
            const planObj = cert.plan && typeof cert.plan === 'object' && !Array.isArray(cert.plan)
              ? cert.plan as Record<string, unknown>
              : undefined
            const name = typeof planObj?.name === 'string' && planObj.name.trim().length > 0
              ? planObj.name.trim()
              : row.plan_id
            const ver = typeof planObj?.version === 'string' && planObj.version.trim().length > 0
              ? planObj.version.trim()
              : 'v1'
            const enabled = row.status === 'active'
            const entry: MutableEvolvedEntry = {
              name,
              version: ver,
              enabled,
              installKind: 'adopted',
            }
            evolvedByPlanId.set(row.plan_id, entry)
            upsertEvolvedByName(name, entry)
            if (row.status === 'active' || row.status === 'authorized') {
              createdPlanIds.add(row.plan_id)
              createdAdoptionCandidates.add(row.plan_id)
            }
          }
        }
      }

      // Pass B: revision-adoptions.sqlite (`entries`, `versions`, `adoptions`, `rollbacks`)
      for (const db of dbs) {
        if (!hasTable(db, 'entries')) continue
        const adoptionStatusByPlan = new Map<string, string>()
        if (hasTable(db, 'adoptions')) {
          sawRevisionAdoptions = true
          const adoptRows = db.prepare('SELECT plan_id, status FROM adoptions').all() as Array<{
            plan_id?: string
            status?: string
          }>
          for (const row of adoptRows) {
            if (typeof row.plan_id === 'string' && typeof row.status === 'string') {
              adoptionStatusByPlan.set(row.plan_id, row.status)
              if (row.status === 'active') {
                revisedPlanIds.add(row.plan_id)
                revisedAdoptionCandidates.add(row.plan_id)
              }
            }
          }
        } else if (hasTable(db, 'versions') && hasColumn(db, 'versions', 'role')) {
          sawRevisionAdoptions = true
          const revRows = db.prepare("SELECT plan_id FROM versions WHERE role = 'revision'").all() as Array<{
            plan_id?: string
          }>
          for (const row of revRows) {
            if (typeof row.plan_id === 'string') {
              revisedPlanIds.add(row.plan_id)
            }
          }
        }

        if (hasTable(db, 'rollbacks')) {
          sawRevisionRollbacks = true
          revisionRollbacksCount += queryCount(db, 'SELECT COUNT(*) AS cnt FROM rollbacks')
        }

        const hasEntryId = hasColumn(db, 'entries', 'entry_id')
        const hasEntryName = hasColumn(db, 'entries', 'name')
        const hasParentPlanId = hasColumn(db, 'entries', 'parent_plan_id')
        const hasCurrentPlanId = hasColumn(db, 'entries', 'current_plan_id')
        const hasRevision = hasColumn(db, 'entries', 'revision')
        const entryCols = [
          hasEntryId ? 'entry_id' : null,
          hasEntryName ? 'name' : null,
          hasParentPlanId ? 'parent_plan_id' : null,
          hasCurrentPlanId ? 'current_plan_id' : null,
          hasRevision ? 'revision' : null,
        ].filter((col): col is string => col !== null)
        const entryRows = entryCols.length > 0
          ? db.prepare(`SELECT ${entryCols.join(', ')} FROM entries`).all() as Array<{
              entry_id?: string
              name?: string
              parent_plan_id?: string
              current_plan_id?: string
              revision?: number
            }>
          : []
        for (const row of entryRows) {
          const parentPlanId = typeof row.parent_plan_id === 'string' ? row.parent_plan_id : undefined
          const currentPlanId = typeof row.current_plan_id === 'string' ? row.current_plan_id : undefined
          const currentStatus = currentPlanId ? adoptionStatusByPlan.get(currentPlanId) : undefined
          const revVersion = typeof row.revision === 'number' && Number.isFinite(row.revision)
            ? `v${row.revision}`
            : null
          const parentEntry = parentPlanId ? evolvedByPlanId.get(parentPlanId) : undefined
          if (parentEntry) {
            if (revVersion !== null) parentEntry.version = revVersion
            if (currentStatus === 'active') parentEntry.enabled = true
            upsertEvolvedByName(parentEntry.name, parentEntry)
          } else {
            const name = typeof row.name === 'string' && row.name.trim().length > 0
              ? row.name.trim()
              : (parentPlanId ?? row.entry_id ?? 'evolved-capability')
            upsertEvolvedByName(name, {
              name,
              version: revVersion ?? 'v1',
              enabled: currentStatus === 'active',
              installKind: 'adopted',
            })
          }
        }
      }

      // Pass C: control.sqlite (`source_plans`, `activation_plans`, `source_adoptions`, `activation_watch`)
      for (const db of dbs) {
        const hasSourcePlans = hasTable(db, 'source_plans')
        const hasActivationPlans = hasTable(db, 'activation_plans')
        const hasSourceAdoptions = hasTable(db, 'source_adoptions')
        const hasWatch = hasTable(db, 'activation_watch')
        if (!hasSourcePlans && !hasActivationPlans) continue

        const sourceModeById = new Map<string, string | null>()
        const linkedSourceIds = new Set<string>()
        const linkedActivationIds = new Set<string>()
        const sourceIdToActivationId = new Map<string, string>()

        if (hasSourceAdoptions) {
          const links = db.prepare('SELECT source_plan_id, activation_plan_id FROM source_adoptions').all() as Array<{
            source_plan_id?: string
            activation_plan_id?: string
          }>
          for (const link of links) {
            if (typeof link.source_plan_id === 'string' && typeof link.activation_plan_id === 'string') {
              linkedSourceIds.add(link.source_plan_id)
              linkedActivationIds.add(link.activation_plan_id)
              sourceIdToActivationId.set(link.source_plan_id, link.activation_plan_id)
            }
          }
        }

        const watchClosedByPlan = new Set<string>()
        if (hasWatch) {
          const watchRows = db.prepare('SELECT plan_id, state FROM activation_watch').all() as Array<{
            plan_id?: string
            state?: string
          }>
          for (const w of watchRows) {
            if (typeof w.plan_id === 'string' && (w.state === 'closed-regressed' || w.state === 'closed-retracted')) {
              watchClosedByPlan.add(w.plan_id)
            }
          }
        }

        if (hasSourcePlans) {
          sawControlSourcePlans = true
          const hasMode = hasColumn(db, 'source_plans', 'mode')
          const spRows = db.prepare(
            hasMode
              ? 'SELECT id, plugin_name, mode, status FROM source_plans'
              : 'SELECT id, plugin_name, status FROM source_plans',
          ).all() as Array<{
            id?: string
            plugin_name?: string
            mode?: string | null
            status?: string
          }>
          controlSourcePlansTotal += spRows.length
          for (const sp of spRows) {
            if (typeof sp.id !== 'string') continue
            const mode = hasMode && typeof sp.mode === 'string' ? sp.mode : null
            sourceModeById.set(sp.id, mode)
            if (sp.status === 'release-complete') {
              const linkedActId = sourceIdToActivationId.get(sp.id)
              if (mode === 'modify' || mode === 'prepared-revise') {
                if (!linkedActId || !revisedPlanIds.has(linkedActId)) {
                  revisedPlanIds.add(linkedActId ?? sp.id)
                }
              } else {
                if (!linkedActId || !createdPlanIds.has(linkedActId)) {
                  createdPlanIds.add(linkedActId ?? sp.id)
                }
              }
              if (!hasSourceAdoptions || !linkedSourceIds.has(sp.id)) {
                controlUnlinkedCompletedSourcePlans += 1
              }
            }
          }
        }

        if (hasActivationPlans) {
          sawControlActivationPlans = true
          const hasProfileCol = hasColumn(db, 'activation_plans', 'profile')
          const hasCandidateCol = hasColumn(db, 'activation_plans', 'candidate_json')
          const hasUpdatedCol = hasColumn(db, 'activation_plans', 'updated_at')
          const actRows = db.prepare(
            `SELECT id, ${hasProfileCol ? 'profile,' : ''} ${hasCandidateCol ? 'candidate_json,' : ''} status${hasUpdatedCol ? ', updated_at' : ''} FROM activation_plans${hasUpdatedCol ? ' ORDER BY updated_at ASC, rowid ASC' : ''}`,
          ).all() as Array<{
            id?: string
            profile?: string
            candidate_json?: string
            status?: string
          }>

          const sourceModeByActivationId = new Map<string, string | null>()
          if (hasSourceAdoptions) {
            for (const [srcId, actId] of sourceIdToActivationId) {
              if (sourceModeById.has(srcId)) {
                sourceModeByActivationId.set(actId, sourceModeById.get(srcId) ?? null)
              }
            }
          }

          for (const act of actRows) {
            if (typeof act.id !== 'string') continue
            if (options?.profile !== undefined && hasProfileCol && typeof act.profile === 'string' && act.profile !== options.profile) {
              continue
            }
            if (hasSourceAdoptions && !linkedActivationIds.has(act.id)) {
              controlUnlinkedActivationPlans += 1
            } else if (!hasSourceAdoptions && !hasSourcePlans) {
              controlUnlinkedActivationPlans += 1
            }
            if (act.status === 'activated') {
              controlActivatedPlans += 1
            }
            if (act.status === 'rolled-back' || act.status === 'rollback-pending') {
              controlRollbackPlans += 1
            }

            const linkedMode = sourceModeByActivationId.get(act.id)
            if (linkedMode === 'modify' || linkedMode === 'prepared-revise') {
              // In-place patch/revision on an existing core plugin; do not move out of core[].
              continue
            }
            const candidate = hasCandidateCol ? parseJsonObject(act.candidate_json) : {}
            const pkgName = typeof candidate.package === 'string' && candidate.package.trim().length > 0
              ? candidate.package.trim()
              : (typeof candidate.name === 'string' && candidate.name.trim().length > 0 ? candidate.name.trim() : undefined)
            if (pkgName === undefined) {
              continue
            }
            const pkgVer = typeof candidate.version === 'string' && candidate.version.trim().length > 0
              ? candidate.version.trim()
              : null
            const patchDisabled = targetProfiles.length > 0
              && targetProfiles.every(p => {
                const ps = patchStatesByProfile.get(p)?.get(pkgName)
                return ps?.disabled === true || ps?.configEnabled === false
              })
            const enabled = act.status === 'activated' && !watchClosedByPlan.has(act.id) && !patchDisabled
            // Latest row wins for the same package name
            evolvedByName.set(pkgName, {
              name: pkgName,
              version: pkgVer,
              enabled,
              installKind: 'adopted',
            })
          }
        }
      }
    } finally {
      closeAll(dbs)
    }
  }

  // Core plugin discovery from node_modules/@dsh-enhanced/*
  interface CorePluginAcc {
    name: string
    version: string | null
    installKind: 'npm' | 'local'
    enabledStates: Array<boolean | undefined>
  }
  const coreByName = new Map<string, CorePluginAcc>()

  if (homeExists) {
    for (const prof of targetProfiles) {
      const installed = await listProfilePlugins(dshHome, prof).catch(() => [])
      const scopeDir = join(profilesDirectory(dshHome), prof, 'node_modules', '@dsh-enhanced')
      const profPatchStates = patchStatesByProfile.get(prof)
      for (const pkg of installed) {
        const slug = pkg.name.replace('@dsh-enhanced/', '')
        const diskVer = await readPackageVersionSafe(join(scopeDir, slug, 'package.json'))
        const evolvedEntry = evolvedByName.get(pkg.name)
        if (evolvedEntry) {
          if (evolvedEntry.version === null && diskVer !== null) {
            evolvedEntry.version = diskVer
          }
          continue
        }
        const ps = profPatchStates?.get(pkg.name)
        const enabledVal = ps !== undefined
          ? !(ps.disabled || ps.configEnabled === false)
          : undefined
        const existing = coreByName.get(pkg.name)
        if (!existing) {
          coreByName.set(pkg.name, {
            name: pkg.name,
            version: diskVer,
            installKind: pkg.kind,
            enabledStates: [enabledVal],
          })
        } else {
          if (existing.version === null && diskVer !== null) existing.version = diskVer
          if (pkg.kind === 'local') existing.installKind = 'local'
          existing.enabledStates.push(enabledVal)
        }
      }
    }
  }

  const core: AssistantVersionPluginEntry[] = [...coreByName.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => {
      const defined = entry.enabledStates.filter((v): v is boolean => v !== undefined)
      const enabled = defined.length > 0 ? defined.some(Boolean) : undefined
      return Object.freeze({
        name: entry.name,
        version: entry.version,
        kind: 'core' as const,
        installKind: entry.installKind,
        ...(enabled !== undefined ? { enabled } : {}),
      })
    })

  const evolved: AssistantVersionPluginEntry[] = [...evolvedByName.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => Object.freeze({
      name: entry.name,
      version: entry.version,
      kind: 'evolved' as const,
      installKind: entry.installKind,
      enabled: entry.enabled,
    }))

  const coreCount = core.length
  const evolvedCount = evolved.length
  const activeEvolvedCount = evolved.filter(item => item.enabled === true).length

  const pluginsState: 'ok' | 'zero' | 'unavailable' = !homeExists
    || (discoveredProfiles.length === 0 && coreCount === 0 && evolvedCount === 0 && !sawControlPlaneDb)
    ? 'unavailable'
    : coreCount === 0 && evolvedCount === 0
      ? 'zero'
      : 'ok'

  // Optional upgrade-history.jsonl & .dsh-rsi-upgrade-backups/
  const upgradeHistory = homeExists
    ? await readUpgradeHistory(dshHome, canonicalHome, diagnostics)
    : { count: null }
  const backupSnapshotsCount = homeExists
    ? await countBackupSnapshots(dshHome, canonicalHome, diagnostics)
    : null

  // Self-iteration aggregate counters (`null` when unseen, `0` when seen & empty)
  const sawCandidatesGenerated = sawMemoryLearningJobs
    || sawControlSourcePlans
    || sawControlActivationPlans
    || sawSkillCandidates
    || sawGrowthUsageJobs
    || sawPreferenceHypotheses
    || sawPreferenceTransitions
    || sawEvolutionProposals
    || sawWorkflowCandidates
  const candidatesGeneratedVal = sawCandidatesGenerated
    ? memoryLearningJobsTotal
      + controlSourcePlansTotal
      + controlUnlinkedActivationPlans
      + skillCandidatesTotal
      + growthUsageJobsTotal
      + (sawPreferenceHypotheses ? preferenceHypothesesTotal : preferenceTransitionsCreated)
      + evolutionProposalsTotal
      + workflowCandidatesTotal
    : null

  const sawCandidatesAdopted = sawMemoryLearningJobs
    || sawCreationAdoptions
    || sawRevisionAdoptions
    || sawControlActivationPlans
    || sawControlSourcePlans
    || sawSkillDeployments
    || sawPreferenceTransitions
    || sawPreferenceHypotheses
    || sawEvolutionRules
    || sawWorkflowCandidates
  const candidatesAdoptedVal = sawCandidatesAdopted
    ? memoryLearningJobsAdopted
      + createdAdoptionCandidates.size
      + revisedAdoptionCandidates.size
      + controlActivatedPlans
      + controlUnlinkedCompletedSourcePlans
      + skillDeployments
      + (sawPreferenceTransitions ? preferenceTransitionsActivated : preferenceHypothesesActivatedFallback)
      + evolutionRulesAdopted
      + workflowCandidatesPromoted
    : null

  const sawPluginsCreated = sawCreationAdoptions || sawControlSourcePlans
  const pluginsCreatedVal = sawPluginsCreated ? createdPlanIds.size : null

  const sawPluginsRevised = sawRevisionAdoptions || sawControlSourcePlans
  const pluginsRevisedVal = sawPluginsRevised ? revisedPlanIds.size : null

  const sawRollbacks = sawControlActivationPlans
    || sawRevisionRollbacks
    || sawEvolutionRollbacks
    || sawSkillDeployments
    || sawWorkflowCandidates
    || sawPreferenceTransitions
    || sawAssocParamEvents
    || sawEvalTuningEvents
  const rollbacksVal = sawRollbacks
    ? controlRollbackPlans
      + revisionRollbacksCount
      + evolutionRollbacks
      + skillRollbacks
      + workflowRollbacks
      + preferenceTransitionsRolledBack
      + associationProfileRollbacks
      + evaluationAttentionTuningRollbacks
    : null

  const workItemsTotalVal = sawWorkItemsTotal ? workItemsTotal : null
  const workItemsSettledVal = sawWorkItemsSettled ? workItemsSettled : null
  const growthUsageJobsTotalVal = sawGrowthUsageJobs ? growthUsageJobsTotal : null
  const dreamingRunsVal = sawDreamingRuns ? dreamingRuns : null
  const recoveryRunsVal = sawRecoveryRuns ? recoveryRuns : null
  const goalStrategyRunsVal = sawGoalStrategyRuns ? goalStrategyRuns : null
  const taskVerificationsDoneVal = sawAcceptanceJobs ? taskVerificationsDone : null
  const evolutionRulesAdoptedVal = sawEvolutionRules ? evolutionRulesAdopted : null
  const associationParamVersionVal = sawAssocParamHead ? associationParamVersion : null
  const associationProfileAdoptionsVal = sawAssocParamEvents ? associationProfileAdoptions : null
  const evaluationAttentionTuningAdoptionsVal = sawEvalTuningEvents ? evaluationAttentionTuningAdoptions : null
  const evaluationLooseningDecisionsAdoptedVal = sawEvalLoosening ? evaluationLooseningDecisionsAdopted : null
  const activeMemoriesVal = sawActiveMemories ? activeMemories : null
  const activePreferenceOverlaysVal = sawPreferenceHypotheses ? activePreferenceOverlays : null
  const workflowCandidatesPromotedVal = sawWorkflowCandidates ? workflowCandidatesPromoted : null
  const skillDeploymentsVal = sawSkillDeployments ? skillDeployments : null
  const selfUpgradesVal = upgradeHistory.count
  const backupSnapshotsCountVal = backupSnapshotsCount

  const allMetricValues: Array<number | null> = [
    workItemsTotalVal,
    workItemsSettledVal,
    growthUsageJobsTotalVal,
    dreamingRunsVal,
    recoveryRunsVal,
    goalStrategyRunsVal,
    candidatesGeneratedVal,
    candidatesAdoptedVal,
    pluginsCreatedVal,
    pluginsRevisedVal,
    taskVerificationsDoneVal,
    rollbacksVal,
    evolutionRulesAdoptedVal,
    associationParamVersionVal,
    associationProfileAdoptionsVal,
    evaluationAttentionTuningAdoptionsVal,
    evaluationLooseningDecisionsAdoptedVal,
    activeMemoriesVal,
    activePreferenceOverlaysVal,
    workflowCandidatesPromotedVal,
    skillDeploymentsVal,
    selfUpgradesVal,
    backupSnapshotsCountVal,
  ]

  let dataState: 'no-data' | 'zero' | 'data'
  if (allMetricValues.every(v => v === null)) {
    dataState = 'no-data'
  } else if (allMetricValues.some(v => v !== null && v > 0)) {
    dataState = 'data'
  } else {
    dataState = 'zero'
  }

  const iterationDrivers: Array<number | null> = [
    workItemsTotalVal,
    growthUsageJobsTotalVal,
    dreamingRunsVal,
    recoveryRunsVal,
    goalStrategyRunsVal,
    evolutionRulesAdoptedVal,
    associationProfileAdoptionsVal,
    evaluationAttentionTuningAdoptionsVal,
    evaluationLooseningDecisionsAdoptedVal,
    selfUpgradesVal,
  ]
  const totalIterations = dataState === 'no-data'
    ? null
    : iterationDrivers.reduce<number>((sum, val) => sum + (val ?? 0), 0)

  const extensions: Record<string, unknown> = {}
  const installIntent = homeExists ? await readInstallIntentSafe(dshHome, canonicalHome) : undefined
  if (installIntent) extensions.installIntent = installIntent
  if (sawVerifierReviews) {
    extensions.verifierReviews = Object.freeze({
      verificationsTotal: verifierVerificationsTotal,
      reviewsTotal: verifierReviewsTotal,
      reviewsApproved: verifierReviewsApproved,
    })
  }
  if (sawDreamingIdeas) {
    extensions.dreamingIdeas = Object.freeze({
      total: dreamingIdeasTotal,
      validated: dreamingIdeasValidated,
      ownerAcknowledged: dreamingIdeasOwnerAck,
    })
  }
  if (upgradeHistory.latestEntry) {
    extensions.latestUpgrade = upgradeHistory.latestEntry
  }

  return Object.freeze({
    schemaVersion: 1,
    protocol: 'dsh-rsi/version/v1',
    generatedAt,
    dshHome,
    assistant: Object.freeze({
      name: 'dsh-enhanced' as const,
      version: VERSION,
      cliVersion: VERSION,
    }),
    host: Object.freeze({
      packageName: '@deepseek-ai/dsh' as const,
      boundVersion,
      boundStatus,
      runningVersion,
    }),
    profile: activeProfile,
    profiles: Object.freeze([...discoveredProfiles]),
    plugins: Object.freeze({
      state: pluginsState,
      coreCount,
      evolvedCount,
      activeEvolvedCount,
      core: Object.freeze(core),
      evolved: Object.freeze(evolved),
    }),
    selfIteration: Object.freeze({
      dataState,
      totalIterations,
      workItemsTotal: workItemsTotalVal,
      workItemsSettled: workItemsSettledVal,
      growthUsageJobsTotal: growthUsageJobsTotalVal,
      dreamingRuns: dreamingRunsVal,
      recoveryRuns: recoveryRunsVal,
      goalStrategyRuns: goalStrategyRunsVal,
      candidatesGenerated: candidatesGeneratedVal,
      candidatesAdopted: candidatesAdoptedVal,
      pluginsCreated: pluginsCreatedVal,
      pluginsRevised: pluginsRevisedVal,
      taskVerificationsDone: taskVerificationsDoneVal,
      rollbacks: rollbacksVal,
      evolutionRulesAdopted: evolutionRulesAdoptedVal,
      associationParamVersion: associationParamVersionVal,
      associationProfileAdoptions: associationProfileAdoptionsVal,
      evaluationAttentionTuningAdoptions: evaluationAttentionTuningAdoptionsVal,
      evaluationLooseningDecisionsAdopted: evaluationLooseningDecisionsAdoptedVal,
      activeMemories: activeMemoriesVal,
      activePreferenceOverlays: activePreferenceOverlaysVal,
      workflowCandidatesPromoted: workflowCandidatesPromotedVal,
      skillDeployments: skillDeploymentsVal,
      selfUpgrades: selfUpgradesVal,
      backupSnapshotsCount: backupSnapshotsCountVal,
    }),
    ...(Object.keys(extensions).length > 0 ? { extensions: Object.freeze(extensions) } : {}),
    inspectedLedgers: Object.freeze([...inspected].sort()),
    diagnostics: Object.freeze([...diagnostics]),
  })
}

function fmtCount(val: number | null): string {
  return val === null ? '—' : String(val)
}

function fmtDataState(state: AssistantVersionReport['selfIteration']['dataState']): string {
  if (state === 'no-data') return 'no-data（无账本/未初始化）'
  if (state === 'zero') return 'zero（账本就绪，暂无记录）'
  return 'data（已有自迭代记录）'
}

export function formatVersionReport(report: AssistantVersionReport): string {
  const lines: string[] = []
  lines.push(
    `${report.assistant.name} v${report.assistant.version}${report.assistant.cliVersion ? `（dsh-rsi v${report.assistant.cliVersion}）` : ''}`,
  )
  lines.push(
    `Host（${report.host.packageName}）：绑定=${report.host.boundVersion ?? '—'}（${report.host.boundStatus}）| 运行中=${report.host.runningVersion ?? '—'}`,
  )
  if (report.dshHome !== undefined) {
    lines.push(
      `DSH Home：${report.dshHome ?? '—'} | profile=${report.profile ?? '全部'}（已发现：${report.profiles && report.profiles.length > 0 ? report.profiles.join(', ') : '无'}）`,
    )
  }

  lines.push(
    `插件概览（${report.plugins.state}）：核心 ${report.plugins.coreCount} 个，自演进 ${report.plugins.evolvedCount} 个（启用 ${report.plugins.activeEvolvedCount} 个）`,
  )
  if (report.plugins.core.length > 0) {
    const coreSummary = report.plugins.core
      .map(p => `${p.name}@${p.version ?? '—'}${p.enabled === false ? '[disabled]' : ''}`)
      .join(', ')
    lines.push(`  核心插件：${coreSummary}`)
  }
  if (report.plugins.evolved.length > 0) {
    const evolvedSummary = report.plugins.evolved
      .map(p => `${p.name}@${p.version ?? '—'}${p.enabled === false ? '[inactive]' : '[active]'}`)
      .join(', ')
    lines.push(`  自演进插件：${evolvedSummary}`)
  }

  const si = report.selfIteration
  lines.push(`自迭代统计（${fmtDataState(si.dataState)}）：`)
  lines.push(
    `  累计迭代次数：${fmtCount(si.totalIterations)} | 工作项：${fmtCount(si.workItemsTotal)}（已结算 ${fmtCount(si.workItemsSettled)}）| 成长任务：${fmtCount(si.growthUsageJobsTotal)}`,
  )
  lines.push(
    `  Dreaming：${fmtCount(si.dreamingRuns)} | Recovery：${fmtCount(si.recoveryRuns)} | GoalStrategy：${fmtCount(si.goalStrategyRuns)} | 任务验收完成：${fmtCount(si.taskVerificationsDone)}`,
  )
  lines.push(
    `  候选生成：${fmtCount(si.candidatesGenerated)} | 候选采用：${fmtCount(si.candidatesAdopted)} | 插件创建：${fmtCount(si.pluginsCreated)} | 插件修订：${fmtCount(si.pluginsRevised)} | 回滚：${fmtCount(si.rollbacks)}`,
  )
  lines.push(
    `  演化规则：${fmtCount(si.evolutionRulesAdopted)} | 联想档案：v${fmtCount(si.associationParamVersion)}（采用 ${fmtCount(si.associationProfileAdoptions)}）| 评估调优采用：${fmtCount(si.evaluationAttentionTuningAdoptions)} | 放宽采用：${fmtCount(si.evaluationLooseningDecisionsAdopted)}`,
  )
  lines.push(
    `  活跃记忆：${fmtCount(si.activeMemories)} | 偏好叠加：${fmtCount(si.activePreferenceOverlays)} | 工作流晋升：${fmtCount(si.workflowCandidatesPromoted)} | 技能部署：${fmtCount(si.skillDeployments)} | 自我升级：${fmtCount(si.selfUpgrades)}（备份快照 ${fmtCount(si.backupSnapshotsCount)}）`,
  )

  if (report.diagnostics && report.diagnostics.length > 0) {
    lines.push(`诊断提示（${report.diagnostics.length}）：`)
    for (const diag of report.diagnostics) {
      lines.push(`  - ${diag}`)
    }
  }
  return lines.join('\n')
}
