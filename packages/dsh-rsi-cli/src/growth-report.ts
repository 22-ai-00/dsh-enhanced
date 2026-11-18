import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseDocument } from 'yaml'
import { listProfilePlugins, listProfiles } from './paths.ts'
import { PurgeError } from './purge.ts'

export type GrowthDataState = 'no-data' | 'zero' | 'data'
export type GrowthTrendDirection = 'improving' | 'regressing' | 'flat' | 'insufficient-data'
export type GrowthExposureTrend = 'reduced' | 'unchanged' | 'increased' | 'insufficient-data'

export interface GrowthTasksSummary {
  readonly state: GrowthDataState
  readonly totalTasks: number
  readonly achieved: number
  readonly partial: number
  readonly notAchieved: number
  readonly conflicted: number
  readonly ownerCorrections: number
  readonly ownerWithdrawals: number
  readonly reworkTasks: number
  readonly correctionRatePpm: number | null
  readonly reworkRatePpm: number | null
  readonly withdrawalRatePpm: number | null
  readonly previousTotalTasks: number
  readonly previousCorrectionRatePpm: number | null
  readonly firstHalfCorrectionRatePpm: number | null
  readonly secondHalfCorrectionRatePpm: number | null
  readonly correctionRateDeltaPpm: number | null
  readonly trend: GrowthTrendDirection
}

export interface GrowthMemorySummary {
  readonly state: GrowthDataState
  readonly activeMemoriesTotal: number
  readonly newMemories: number
  readonly sourcedMemories: number
  readonly withdrawnOrRemovedMemories: number
  readonly activePreferenceOverlays: number
  readonly promptExposures: number
  readonly postExposureSameClassCorrections: number
  readonly preExposureContradictions: number
  readonly postExposureCorrectionRatePpm: number | null
  readonly sameClassCorrectionTrend: GrowthExposureTrend
}

export interface GrowthCandidatesSummary {
  readonly state: GrowthDataState
  readonly generated: number
  readonly verificationPassed: number
  readonly verificationFailed: number
  readonly adopted: number
  readonly rolledBack: number
}

export interface GrowthNotificationsSummary {
  readonly state: GrowthDataState
  readonly total: number
  readonly delivered: number
  readonly reacted: number
  readonly accepted: number
  readonly rejected: number
  readonly ignoredOrExpired: number
  readonly failed: number
  readonly wouldAcceptTotal: number
  readonly agreementDecided: number
  readonly agreementAgreed: number
  readonly agreementDisagreed: number
  readonly agreementPpm: number | null
  readonly holdoutDecidedSamples: number
  readonly looseningMinHoldoutSamples: number
  readonly looseningGateStatus: 'insufficient-samples' | 'ready-for-review'
}

export interface GrowthSupplierDistribution {
  readonly supplier: string
  readonly runs: number
  readonly costUsdMicros: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly toolCalls: number
  readonly latencySamples: number
  readonly avgLatencyMs: number | null
  readonly p50LatencyMs: number | null
  readonly p95LatencyMs: number | null
  readonly maxLatencyMs: number | null
}

export interface GrowthSuppliersSummary {
  readonly state: GrowthDataState
  readonly totalRuns: number
  readonly totalCostUsdMicros: number
  readonly suppliers: readonly GrowthSupplierDistribution[]
}

export interface GrowthMemoryLaneGate {
  readonly targetWindowDays: number
  readonly windowSatisfied: boolean
  readonly authenticatedCorrections: number
  readonly minAuthenticatedCorrections: number
  readonly sourcedMemories: number
  readonly minSourcedMemories: number
  readonly promptExposures: number
  readonly minPromptExposures: number
  readonly correctionRateDropped: boolean
  readonly conflictedTasks: number
  readonly status: 'no-data' | 'collecting' | 'passed' | 'attention-needed'
}

export interface GrowthReport {
  readonly protocol: 'dsh-rsi/growth-report/v1'
  readonly dshHome: string
  readonly homeExists: boolean
  readonly profile: string | null
  readonly profiles: readonly string[]
  readonly sinceSpec: string
  readonly windowMs: number
  readonly fromAt: number
  readonly toAt: number
  readonly overallState: GrowthDataState
  readonly inspectedLedgers: readonly string[]
  readonly diagnostics: readonly string[]
  readonly tasks: GrowthTasksSummary
  readonly memory: GrowthMemorySummary
  readonly candidates: GrowthCandidatesSummary
  readonly notifications: GrowthNotificationsSummary
  readonly suppliers: GrowthSuppliersSummary
  readonly memoryLaneGate: GrowthMemoryLaneGate
}

export interface GrowthReportOptions {
  readonly dshHome: string
  readonly profile?: string
  readonly since?: string
  readonly now?: number
}

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const MAX_WINDOW_MS = 365 * DAY_MS
const ATTENTION_HOLDOUT_PROTOCOL = 'assistant-evaluation/attention-holdout/v1'
const DEFAULT_LOOSENING_MIN_HOLDOUT = 20

export function parseGrowthSince(spec = '7d'): { spec: string; windowMs: number } {
  const trimmed = spec.trim()
  const match = /^([1-9][0-9]{0,3})(h|d|w)$/iu.exec(trimmed)
  if (!match) {
    throw new PurgeError(`--since 格式无效（收到 "${spec}"；支持如 24h、7d、14d、30d、2w）`)
  }
  const amount = Number.parseInt(match[1]!, 10)
  const unit = match[2]!.toLowerCase()
  const unitMs = unit === 'h' ? HOUR_MS : unit === 'd' ? DAY_MS : 7 * DAY_MS
  const windowMs = amount * unitMs
  if (!Number.isSafeInteger(windowMs) || windowMs < HOUR_MS || windowMs > MAX_WINDOW_MS) {
    throw new PurgeError(`--since 超出允许范围（1h..365d，收到 "${spec}"）`)
  }
  return { spec: `${amount}${unit}`, windowMs }
}

export function parseGrowthNow(raw: string): number {
  const trimmed = raw.trim()
  if (/^[1-9][0-9]{9,15}$/u.test(trimmed)) {
    const epoch = Number.parseInt(trimmed, 10)
    if (Number.isSafeInteger(epoch) && epoch > 0) return epoch
  }
  const parsed = Date.parse(trimmed)
  if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed)
  throw new PurgeError(`--now 格式无效（收到 "${raw}"；支持毫秒时间戳或 ISO-8601 时间）`)
}

function isHoldoutMember(id: string): boolean {
  const hex = createHash('sha256').update(`${ATTENTION_HOLDOUT_PROTOCOL}\n${id}`).digest('hex')
  return Number.parseInt(hex.slice(0, 8), 16) % 4 === 0
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]!
}

function ppm(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null
  return Math.min(1_000_000, Math.max(0, Math.round((numerator * 1_000_000) / denominator)))
}

function formatPct(ratePpm: number | null): string {
  if (ratePpm === null) return '—'
  return `${(ratePpm / 10_000).toFixed(1)}%`
}

function formatStateLabel(state: GrowthDataState): string {
  if (state === 'no-data') return '无数据（未启用/无账本）'
  if (state === 'zero') return '0（账本就绪，窗口内无记录）'
  return '有数据'
}

type LedgerFamily =
  | 'evaluation'
  | 'memory'
  | 'preference'
  | 'memoryLearning'
  | 'growthDriver'
  | 'controlPlane'
  | 'skills'
  | 'workItems'
  | 'evolution'
  | 'growthExperiments'

type PatchDbMap = Record<LedgerFamily, Set<string>>

function isWithinHome(target: string, dshHome: string, canonicalHome: string): boolean {
  return target === dshHome
    || target.startsWith(`${dshHome}${sep}`)
    || target === canonicalHome
    || target.startsWith(`${canonicalHome}${sep}`)
}

function resolveConfiguredPath(raw: unknown, dshHome: string, canonicalHome: string, diagnostics?: string[]): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === ':memory:' || trimmed.includes('\0')) return undefined
  const jsMatch = /^(?:!!js\s+)?dshHomePath\(\s*['"]([^'"\r\n]+)['"]\s*\)$/u.exec(trimmed)
  if (jsMatch?.[1]) {
    const resolved = resolve(dshHome, jsMatch[1])
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
  if (idOrName.includes('assistant-evaluation') || idOrName.endsWith('/assistant-evaluation')) return 'evaluation'
  if (idOrName.includes('personal-memory') || idOrName.endsWith('/personal-memory')) return 'memory'
  if (idOrName.includes('preference-learning') || idOrName.endsWith('/preference-learning')) return 'preference'
  if (idOrName.includes('assistant-memory-learning') || idOrName.endsWith('/assistant-memory-learning')) return 'memoryLearning'
  if (idOrName.includes('plugin-control-plane') || idOrName.endsWith('/plugin-control-plane')) return 'controlPlane'
  if (idOrName.includes('assistant-skills') || idOrName.endsWith('/assistant-skills')) return 'skills'
  if (idOrName.includes('assistant-work-items') || idOrName.endsWith('/assistant-work-items')) return 'workItems'
  if (idOrName.includes('assistant-evolution') || idOrName.endsWith('/assistant-evolution')) return 'evolution'
  if (idOrName.includes('assistant-growth-experiments') || idOrName.endsWith('/assistant-growth-experiments')) return 'growthExperiments'
  if (idOrName.includes('assistant-growth-driver') || idOrName.endsWith('/assistant-growth-driver')) return 'growthDriver'
  return undefined
}

async function collectPatchDbPaths(
  patchPath: string,
  dshHome: string,
  canonicalHome: string,
  into: PatchDbMap,
  enabledFamilies: Set<LedgerFamily>,
  diagnostics: string[],
): Promise<void> {
  if (!existsSync(patchPath)) return
  let source: string
  try {
    source = await readFile(patchPath, 'utf8')
  } catch (error) {
    diagnostics.push(`无法读取配置 ${patchPath}：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const doc = parseDocument(source, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (val: string) => `dshHomePath(${val.replace(/^dshHomePath\(/u, '').replace(/\)$/u, '')})` }],
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
      if (row.disabled === true) continue
      const id = typeof row.id === 'string' ? row.id : ''
      const name = typeof row.name === 'string' ? row.name : ''
      const cfg = row.config && typeof row.config === 'object' && !Array.isArray(row.config)
        ? row.config as Record<string, unknown>
        : {}
      const fam = classifyPluginFamily(id) ?? classifyPluginFamily(name)
      if (fam) {
        enabledFamilies.add(fam)
        if (fam === 'growthDriver') {
          const usage = cfg.usageLearning && typeof cfg.usageLearning === 'object' ? cfg.usageLearning as Record<string, unknown> : undefined
          const usagePath = resolveConfiguredPath(usage?.databasePath, dshHome, canonicalHome, diagnostics)
          if (usagePath) into.growthDriver.add(usagePath)
        } else if (fam === 'controlPlane') {
          const dbPath = resolveConfiguredPath(cfg.databasePath, dshHome, canonicalHome, diagnostics)
          if (dbPath) into.controlPlane.add(dbPath)
          const stateDir = resolveConfiguredPath(cfg.statePath, dshHome, canonicalHome, diagnostics)
          if (stateDir) {
            into.controlPlane.add(join(stateDir, 'control.sqlite'))
            into.controlPlane.add(join(stateDir, 'creation-adoptions.sqlite'))
            into.controlPlane.add(join(stateDir, 'revision-adoptions.sqlite'))
          }
        } else {
          const dbPath = resolveConfiguredPath(cfg.databasePath, dshHome, canonicalHome, diagnostics)
          if (dbPath) into[fam].add(dbPath)
        }
      }
      if (id.includes('personal-assistant') || name.endsWith('/personal-assistant')) {
        enabledFamilies.add('memory')
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
    if (!isWithinHome(target, dshHome, canonicalHome) || !realTarget.startsWith(`${canonicalHome}${sep}`)) {
      diagnostics.push(`跳过符号链接越界账本文件：${target}`)
      continue
    }
    if (seenRealPaths.has(realTarget)) continue
    seenRealPaths.add(realTarget)
    try {
      const db = new DatabaseSync(realTarget, { readOnly: true })
      const check = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined
      if (!check || Object.values(check)[0] !== 'ok') {
        db.close()
        diagnostics.push(`账本完整性检查未通过：${target}`)
        continue
      }
      inspected.add(realTarget)
      opened.push(db)
    } catch (error) {
      diagnostics.push(`只读打开账本失败 ${target}：${error instanceof Error ? error.message : String(error)}`)
    }
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

function parseJsonArray(raw: unknown): unknown[] {
  if (typeof raw !== 'string' || raw === '') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function extractSupplierName(metricsJson: string, evidenceJson: string, evaluatorId: string): string {
  const metrics = parseJsonObject(metricsJson)
  const supplierObj = metrics.supplier && typeof metrics.supplier === 'object' && !Array.isArray(metrics.supplier)
    ? metrics.supplier as Record<string, unknown>
    : undefined
  const provider = typeof supplierObj?.provider === 'string'
    ? supplierObj.provider
    : typeof metrics.provider === 'string' ? metrics.provider : undefined
  const model = typeof supplierObj?.model === 'string'
    ? supplierObj.model
    : typeof metrics.model === 'string' ? metrics.model : undefined
  if (provider && model) return `${provider}/${model}`
  if (provider) return provider
  if (model) return model
  for (const item of parseJsonArray(evidenceJson)) {
    if (!item || typeof item !== 'object') continue
    const ref = item as Record<string, unknown>
    if ((ref.kind === 'supplier' || ref.kind === 'model-route') && typeof ref.ref === 'string' && ref.ref.trim() !== '') {
      return ref.ref.trim()
    }
  }
  return evaluatorId || 'unknown-supplier'
}

function inWindowOrUntimestamped(at: unknown, fromAt: number, toAt: number): boolean {
  if (typeof at !== 'number' || !Number.isFinite(at)) return true
  return at >= fromAt && at <= toAt
}

function skillComparisonPassed(comparisonJson: string): boolean {
  const c = parseJsonObject(comparisonJson)
  const res = c.result && typeof c.result === 'object' && !Array.isArray(c.result)
    ? c.result as Record<string, unknown>
    : undefined
  if (res) {
    if (res.qualified === true || res.passed === true || res.verdict === 'passed' || res.accepted === true || res.winner === 'candidate') {
      return true
    }
    if (typeof res.admissionDigest === 'string' && res.admissionDigest.length === 64 && res.promotionAuthorized !== false) {
      return true
    }
    const report = res.report && typeof res.report === 'object' ? res.report as Record<string, unknown> : undefined
    const receipt = res.receipt && typeof res.receipt === 'object' ? res.receipt as Record<string, unknown> : undefined
    if (report?.passed === true || receipt?.passed === true || receipt?.qualified === true) return true
    return false
  }
  return c.passed === true || c.verdict === 'passed' || c.accepted === true || c.qualified === true
}

export async function collectGrowthReport(options: GrowthReportOptions): Promise<GrowthReport> {
  const { spec: sinceSpec, windowMs } = parseGrowthSince(options.since ?? '7d')
  const toAt = options.now ?? Date.now()
  if (!Number.isSafeInteger(toAt) || toAt <= 0) {
    throw new PurgeError('当前参考时间无效')
  }
  const fromAt = Math.max(0, toAt - windowMs)
  const prevFromAt = Math.max(0, fromAt - windowMs)
  const midAt = Math.floor((fromAt + toAt) / 2)

  const dshHome = resolve(options.dshHome)
  const homeExists = existsSync(dshHome)
  const canonicalHome = homeExists ? await realpath(dshHome).catch(() => dshHome) : dshHome
  const discoveredProfiles = homeExists ? await listProfiles(dshHome) : []
  if (options.profile !== undefined) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(options.profile)) {
      throw new PurgeError(`--profile 名称格式无效：${options.profile}`)
    }
    const explicitDir = join(dshHome, 'profiles', options.profile)
    if (homeExists && !discoveredProfiles.includes(options.profile) && !existsSync(explicitDir)) {
      throw new PurgeError(`未找到 profile "${options.profile}"（当前可用：${discoveredProfiles.join(', ') || '无'}）`)
    }
  }
  const activeProfile = options.profile ?? (discoveredProfiles.length === 1 ? discoveredProfiles[0]! : null)
  const targetProfiles = options.profile !== undefined ? [options.profile] : discoveredProfiles

  const diagnostics: string[] = []
  const inspected = new Set<string>()
  const dbMap: PatchDbMap = {
    evaluation: new Set(),
    memory: new Set(),
    preference: new Set(),
    memoryLearning: new Set(),
    growthDriver: new Set(),
    controlPlane: new Set(),
    skills: new Set(),
    workItems: new Set(),
    evolution: new Set(),
    growthExperiments: new Set(),
  }

  if (homeExists) {
    const enabledFamilies = new Set<LedgerFamily>()
    if (options.profile === undefined) {
      await collectPatchDbPaths(join(dshHome, 'cordis.yml'), dshHome, canonicalHome, dbMap, enabledFamilies, diagnostics)
      await collectPatchDbPaths(join(dshHome, 'cordis.patch.yml'), dshHome, canonicalHome, dbMap, enabledFamilies, diagnostics)
    }
    for (const prof of targetProfiles) {
      await collectPatchDbPaths(join(dshHome, 'profiles', prof, 'cordis.yml'), dshHome, canonicalHome, dbMap, enabledFamilies, diagnostics)
      await collectPatchDbPaths(join(dshHome, 'profiles', prof, 'cordis.patch.yml'), dshHome, canonicalHome, dbMap, enabledFamilies, diagnostics)
      const installed = await listProfilePlugins(dshHome, prof).catch(() => [])
      for (const pkg of installed) {
        const fam = classifyPluginFamily(pkg.name)
        if (fam) enabledFamilies.add(fam)
        if (pkg.name === '@dsh-enhanced/personal-assistant') enabledFamilies.add('memory')
      }
    }

    // When `--profile <name>` targets a real DSH profile (anchored by package.json),
    // restrict shared home-level fallback paths to plugin families actually installed
    // or configured in that profile so unrelated profiles do not leak across reports.
    const filterByProfile = options.profile !== undefined && discoveredProfiles.includes(options.profile)
    const allowFamily = (fam: LedgerFamily): boolean => !filterByProfile || enabledFamilies.has(fam)

    const profNames = targetProfiles.length > 0 ? targetProfiles : ['web', 'lark', 'supervised']
    if (allowFamily('evaluation')) {
      dbMap.evaluation.add(join(dshHome, 'assistant-evaluation', 'evaluation.sqlite'))
      dbMap.evaluation.add(join(dshHome, 'assistant-evaluation', 'state.sqlite'))
    }
    if (allowFamily('memory')) {
      dbMap.memory.add(join(dshHome, 'personal-memory', 'memory.sqlite'))
      dbMap.memory.add(join(dshHome, 'personal-memory', 'state.sqlite'))
    }
    if (allowFamily('preference')) {
      dbMap.preference.add(join(dshHome, 'preference-learning', 'preferences.sqlite'))
      dbMap.preference.add(join(dshHome, 'preference-learning', 'state.sqlite'))
    }
    if (allowFamily('memoryLearning')) {
      dbMap.memoryLearning.add(join(dshHome, 'assistant-memory-learning', 'state.sqlite'))
      dbMap.memoryLearning.add(join(dshHome, 'assistant-memory-learning', 'learning.sqlite'))
    }
    if (allowFamily('growthDriver')) {
      dbMap.growthDriver.add(join(dshHome, 'assistant-growth-driver', 'usage.sqlite'))
      dbMap.growthDriver.add(join(dshHome, 'assistant-growth-driver', 'state.sqlite'))
    }
    if (allowFamily('controlPlane')) {
      dbMap.controlPlane.add(join(dshHome, 'plugin-control-plane', 'state.sqlite'))
    }
    if (allowFamily('skills')) {
      dbMap.skills.add(join(dshHome, 'assistant-skills', 'skills.sqlite'))
      dbMap.skills.add(join(dshHome, 'assistant-skills', 'state.sqlite'))
    }
    if (allowFamily('workItems')) {
      dbMap.workItems.add(join(dshHome, 'assistant-work-items', 'state.sqlite'))
    }
    if (allowFamily('evolution')) {
      dbMap.evolution.add(join(dshHome, 'assistant-evolution', 'evolution.sqlite'))
      dbMap.evolution.add(join(dshHome, 'assistant-evolution', 'state.sqlite'))
    }
    if (allowFamily('growthExperiments')) {
      dbMap.growthExperiments.add(join(dshHome, 'assistant-growth-experiments', 'growth.sqlite'))
      dbMap.growthExperiments.add(join(dshHome, 'assistant-growth-experiments', 'state.sqlite'))
    }
    for (const prof of profNames) {
      if (allowFamily('evaluation')) dbMap.evaluation.add(join(dshHome, 'assistant-evaluation', `${prof}.sqlite`))
      if (allowFamily('memory')) dbMap.memory.add(join(dshHome, 'personal-memory', `${prof}.sqlite`))
      if (allowFamily('preference')) dbMap.preference.add(join(dshHome, 'preference-learning', `${prof}.sqlite`))
      if (allowFamily('memoryLearning')) dbMap.memoryLearning.add(join(dshHome, 'assistant-memory-learning', `${prof}.sqlite`))
      if (allowFamily('growthDriver')) dbMap.growthDriver.add(join(dshHome, 'assistant-growth-driver', `${prof}-usage.sqlite`))
      if (allowFamily('controlPlane')) {
        dbMap.controlPlane.add(join(dshHome, 'plugin-control-plane', 'control.sqlite'))
        dbMap.controlPlane.add(join(dshHome, 'plugin-control-plane', `${prof}.sqlite`))
        dbMap.controlPlane.add(join(dshHome, 'plugin-control-plane', `${prof}-creation-adoptions.sqlite`))
        dbMap.controlPlane.add(join(dshHome, 'plugin-control-plane', `${prof}-revision-adoptions.sqlite`))
        dbMap.controlPlane.add(join(dshHome, 'rsi-authorities', prof, 'state', 'control-plane', 'control.sqlite'))
        dbMap.controlPlane.add(join(dshHome, 'rsi-authorities', prof, 'state', 'control-plane', 'creation-adoptions.sqlite'))
        dbMap.controlPlane.add(join(dshHome, 'rsi-authorities', prof, 'state', 'control-plane', 'revision-adoptions.sqlite'))
      }
      if (allowFamily('skills')) dbMap.skills.add(join(dshHome, 'assistant-skills', `${prof}.sqlite`))
      if (allowFamily('workItems')) dbMap.workItems.add(join(dshHome, 'assistant-work-items', `${prof}.sqlite`))
      if (allowFamily('evolution')) dbMap.evolution.add(join(dshHome, 'assistant-evolution', `${prof}.sqlite`))
      if (allowFamily('growthExperiments')) dbMap.growthExperiments.add(join(dshHome, 'assistant-growth-experiments', `${prof}.sqlite`))
    }
  }

  // 1. Evaluation DBs -> Tasks, Suppliers, Notifications
  const evalDbs = await openReadOnlyDbs(dbMap.evaluation, dshHome, canonicalHome, diagnostics, inspected)
  let sawEvalOutcomesTable = false
  let totalTasks = 0
  let achieved = 0
  let partial = 0
  let notAchieved = 0
  let conflicted = 0
  let ownerCorrections = 0
  let ownerWithdrawals = 0
  let reworkTasks = 0
  let prevTotalTasks = 0
  let prevCorrections = 0
  let firstHalfTasks = 0
  let firstHalfCorrections = 0
  let secondHalfTasks = 0
  let secondHalfCorrections = 0

  const supplierBuckets = new Map<string, {
    runs: number
    costUsdMicros: number
    inputTokens: number
    outputTokens: number
    toolCalls: number
    latencies: number[]
  }>()

  let sawNotificationsTable = false
  let notifTotal = 0
  let notifDelivered = 0
  let notifReacted = 0
  let notifAccepted = 0
  let notifRejected = 0
  let notifIgnored = 0
  let notifFailed = 0
  let wouldAcceptTotal = 0
  let agreementDecided = 0
  let agreementAgreed = 0
  let agreementDisagreed = 0
  let holdoutDecidedSamples = 0

  try {
    for (const db of evalDbs) {
      if (hasTable(db, 'evaluation_outcomes')) {
        sawEvalOutcomesTable = true
        const hasProjections = hasTable(db, 'evaluation_task_projections')
        const hasOwnerRev = hasTable(db, 'evaluation_owner_revisions')

        if (hasProjections) {
          const hasSplitRefs = hasColumn(db, 'evaluation_task_projections', 'objective_outcome_id')
            && hasColumn(db, 'evaluation_task_projections', 'execution_outcome_id')
          const hasObjConflicted = hasColumn(db, 'evaluation_task_projections', 'objective_conflicted')
          const conflictedExpr = hasObjConflicted ? 'p.objective_conflicted' : '0'
          const taskRows = (hasSplitRefs
            ? db.prepare(`
                SELECT p.subject_key, ${conflictedExpr} AS objective_conflicted, p.updated_at,
                       o.id AS outcome_id,
                       CASE WHEN ${conflictedExpr} = 1 THEN 'unknown'
                            ELSE COALESCE(obj.objective_status, o.objective_status, 'unknown')
                       END AS objective_status,
                       COALESCE(exec_o.metrics_json, o.metrics_json, '{}') AS metrics_json,
                       COALESCE(exec_o.occurred_at, o.occurred_at, p.updated_at) AS occurred_at
                FROM evaluation_task_projections p
                LEFT JOIN evaluation_outcomes o ON o.id = p.primary_outcome_id
                LEFT JOIN evaluation_outcomes obj ON obj.id = p.objective_outcome_id
                LEFT JOIN evaluation_outcomes exec_o ON exec_o.id = p.execution_outcome_id
                WHERE COALESCE(exec_o.occurred_at, o.occurred_at, p.updated_at) >= ?
                  AND COALESCE(exec_o.occurred_at, o.occurred_at, p.updated_at) <= ?
              `).all(prevFromAt, toAt)
            : db.prepare(`
                SELECT p.subject_key, ${conflictedExpr} AS objective_conflicted, p.updated_at,
                       o.id AS outcome_id, COALESCE(o.objective_status, 'unknown') AS objective_status,
                       COALESCE(o.metrics_json, '{}') AS metrics_json,
                       COALESCE(o.occurred_at, p.updated_at) AS occurred_at
                FROM evaluation_task_projections p
                LEFT JOIN evaluation_outcomes o ON o.id = p.primary_outcome_id
                WHERE COALESCE(o.occurred_at, p.updated_at) >= ? AND COALESCE(o.occurred_at, p.updated_at) <= ?
              `).all(prevFromAt, toAt)) as Array<{
            subject_key: string
            objective_conflicted: number
            updated_at: number
            outcome_id: string | null
            objective_status: string
            metrics_json: string
            occurred_at: number
          }>

          const correctedSubjectsInWindow = new Set<string>()
          const correctedSubjectsPrev = new Set<string>()
          const correctedSubjectsFirstHalf = new Set<string>()
          const correctedSubjectsSecondHalf = new Set<string>()
          const withdrawnSubjectsInWindow = new Set<string>()
          const revisionOutcomeIds = new Set<string>()

          if (hasOwnerRev) {
            const hasLineageVersion = hasColumn(db, 'evaluation_owner_revisions', 'lineage')
              && hasColumn(db, 'evaluation_owner_revisions', 'version')
            const allRevIds = db.prepare('SELECT outcome_id FROM evaluation_owner_revisions').all() as Array<{ outcome_id: string }>
            for (const item of allRevIds) revisionOutcomeIds.add(item.outcome_id)

            const revRows = (hasLineageVersion
              ? db.prepare(`
                  SELECT r.subject_key, r.action, o.occurred_at
                  FROM evaluation_owner_revisions r
                  JOIN evaluation_outcomes o ON o.id = r.outcome_id
                  WHERE o.occurred_at >= ? AND o.occurred_at <= ?
                    AND NOT EXISTS (
                      SELECT 1 FROM evaluation_owner_revisions r2
                      JOIN evaluation_outcomes o2 ON o2.id = r2.outcome_id
                      WHERE r2.subject_key = r.subject_key AND r2.lineage = r.lineage
                        AND o2.occurred_at <= ? AND r2.version > r.version
                    )
                `).all(prevFromAt, toAt, toAt)
              : db.prepare(`
                  SELECT r.subject_key, r.action, o.occurred_at
                  FROM evaluation_owner_revisions r
                  JOIN evaluation_outcomes o ON o.id = r.outcome_id
                  WHERE o.occurred_at >= ? AND o.occurred_at <= ?
                `).all(prevFromAt, toAt)) as Array<{ subject_key: string; action: string; occurred_at: number }>
            for (const rev of revRows) {
              if (rev.occurred_at >= fromAt) {
                if (rev.action === 'correct') {
                  correctedSubjectsInWindow.add(rev.subject_key)
                  if (rev.occurred_at < midAt) correctedSubjectsFirstHalf.add(rev.subject_key)
                  else correctedSubjectsSecondHalf.add(rev.subject_key)
                } else if (rev.action === 'withdraw') {
                  withdrawnSubjectsInWindow.add(rev.subject_key)
                }
              } else if (rev.action === 'correct') {
                correctedSubjectsPrev.add(rev.subject_key)
              }
            }
          }

          const hasTrustCol = hasColumn(db, 'evaluation_outcomes', 'trust')
          const hasTaskSubjectKeyCol = hasColumn(db, 'evaluation_outcomes', 'task_subject_key')
          const fbRows = db.prepare(`
            SELECT id, ${hasTaskSubjectKeyCol ? 'COALESCE(task_subject_key, id)' : 'id'} AS skey, objective_status, occurred_at
            FROM evaluation_outcomes
            WHERE source_kind = 'user-feedback'
              ${hasTrustCol ? "AND trust = 'trusted'" : ''}
              AND occurred_at >= ? AND occurred_at <= ?
          `).all(prevFromAt, toAt) as Array<{ id: string; skey: string; objective_status: string; occurred_at: number }>
          for (const fb of fbRows) {
            if (revisionOutcomeIds.has(fb.id)) continue
            if (fb.objective_status === 'not-achieved' || fb.objective_status === 'partial') {
              if (fb.occurred_at >= fromAt) {
                if (!withdrawnSubjectsInWindow.has(fb.skey)) {
                  correctedSubjectsInWindow.add(fb.skey)
                  if (fb.occurred_at < midAt) correctedSubjectsFirstHalf.add(fb.skey)
                  else correctedSubjectsSecondHalf.add(fb.skey)
                }
              } else {
                correctedSubjectsPrev.add(fb.skey)
              }
            } else if (fb.objective_status === 'unknown' && fb.occurred_at >= fromAt) {
              withdrawnSubjectsInWindow.add(fb.skey)
              correctedSubjectsInWindow.delete(fb.skey)
              correctedSubjectsFirstHalf.delete(fb.skey)
              correctedSubjectsSecondHalf.delete(fb.skey)
            }
          }

          const multiAttemptSubjects = hasTaskSubjectKeyCol
            ? new Set(
                (db.prepare(`
                  SELECT task_subject_key FROM evaluation_outcomes
                  WHERE task_subject_key IS NOT NULL AND occurred_at >= ? AND occurred_at <= ?
                  GROUP BY task_subject_key
                  HAVING COUNT(*) > 1 AND SUM(execution_status = 'failed' OR objective_status = 'not-achieved') > 0
                `).all(fromAt, toAt) as Array<{ task_subject_key: string }>).map(r => r.task_subject_key),
              )
            : new Set<string>()

          for (const row of taskRows) {
            if (row.occurred_at < fromAt) {
              prevTotalTasks += 1
              continue
            }
            totalTasks += 1
            if (row.occurred_at < midAt) firstHalfTasks += 1
            else secondHalfTasks += 1

            if (row.objective_conflicted === 1) {
              conflicted += 1
            } else if (!withdrawnSubjectsInWindow.has(row.subject_key)) {
              if (row.objective_status === 'achieved') {
                achieved += 1
              } else if (row.objective_status === 'partial') {
                partial += 1
              } else if (row.objective_status === 'not-achieved') {
                notAchieved += 1
              }
            }

            const m = parseJsonObject(row.metrics_json)
            const retries = typeof m.retries === 'number' ? m.retries : 0
            if (retries > 0 || multiAttemptSubjects.has(row.subject_key)) reworkTasks += 1
          }

          ownerCorrections += correctedSubjectsInWindow.size
          ownerWithdrawals += withdrawnSubjectsInWindow.size
          prevCorrections += correctedSubjectsPrev.size
          firstHalfCorrections += correctedSubjectsFirstHalf.size
          secondHalfCorrections += correctedSubjectsSecondHalf.size
        }

        // Supplier cost & latency distribution across in-window outcomes
        const outcomeRows = db.prepare(`
          SELECT evaluator_id, metrics_json, evidence_json, cost_usd_micros, latency_ms, input_tokens, output_tokens, tool_calls
          FROM evaluation_outcomes
          WHERE occurred_at >= ? AND occurred_at <= ? AND source_kind != 'user-feedback'
        `).all(fromAt, toAt) as Array<{
          evaluator_id: string
          metrics_json: string
          evidence_json: string
          cost_usd_micros: number | null
          latency_ms: number | null
          input_tokens: number | null
          output_tokens: number | null
          tool_calls: number | null
        }>
        for (const out of outcomeRows) {
          const supplier = extractSupplierName(out.metrics_json, out.evidence_json, out.evaluator_id)
          let bucket = supplierBuckets.get(supplier)
          if (!bucket) {
            bucket = { runs: 0, costUsdMicros: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, latencies: [] }
            supplierBuckets.set(supplier, bucket)
          }
          const m = parseJsonObject(out.metrics_json)
          const cost = out.cost_usd_micros ?? (typeof m.costUsdMicros === 'number' ? m.costUsdMicros : 0)
          const latency = out.latency_ms ?? (typeof m.latencyMs === 'number' ? m.latencyMs : null)
          const inTok = out.input_tokens ?? (typeof m.inputTokens === 'number' ? m.inputTokens : 0)
          const outTok = out.output_tokens ?? (typeof m.outputTokens === 'number' ? m.outputTokens : 0)
          const tools = out.tool_calls ?? (typeof m.toolCalls === 'number' ? m.toolCalls : 0)
          bucket.runs += 1
          bucket.costUsdMicros += Math.max(0, Math.trunc(cost))
          bucket.inputTokens += Math.max(0, Math.trunc(inTok))
          bucket.outputTokens += Math.max(0, Math.trunc(outTok))
          bucket.toolCalls += Math.max(0, Math.trunc(tools))
          if (typeof latency === 'number' && Number.isFinite(latency) && latency >= 0) {
            bucket.latencies.push(Math.trunc(latency))
          }
        }
      }

      if (hasTable(db, 'evaluation_notification_outcome_heads')) {
        sawNotificationsTable = true
        const nRows = db.prepare(`
          SELECT notification_id, outcome
          FROM evaluation_notification_outcome_heads
          WHERE occurred_at >= ? AND occurred_at <= ?
        `).all(fromAt, toAt) as Array<{ notification_id: string; outcome: string }>
        for (const n of nRows) {
          notifTotal += 1
          if (n.outcome === 'delivered') notifDelivered += 1
          else if (n.outcome === 'reacted') { notifDelivered += 1; notifReacted += 1 }
          else if (n.outcome === 'accepted') { notifDelivered += 1; notifAccepted += 1 }
          else if (n.outcome === 'rejected') { notifDelivered += 1; notifRejected += 1 }
          else if (n.outcome === 'expired-unhandled') { notifDelivered += 1; notifIgnored += 1 }
          else if (n.outcome === 'failed') notifFailed += 1
          const decided = n.outcome === 'reacted' || n.outcome === 'accepted' || n.outcome === 'rejected' || n.outcome === 'expired-unhandled'
          if (decided && isHoldoutMember(n.notification_id)) {
            holdoutDecidedSamples += 1
          }
        }
      }

      if (hasTable(db, 'evaluation_intake_evaluation_heads')) {
        sawNotificationsTable = true
        const ieRows = db.prepare(`
          SELECT eval_id, would_accept, outcome_kind
          FROM evaluation_intake_evaluation_heads
          WHERE evaluated_at >= ? AND evaluated_at <= ?
        `).all(fromAt, toAt) as Array<{ eval_id: string; would_accept: number; outcome_kind: string }>
        for (const ie of ieRows) {
          if (ie.would_accept === 1) wouldAcceptTotal += 1
          if (ie.outcome_kind === 'agreed') {
            agreementDecided += 1
            agreementAgreed += 1
            if (isHoldoutMember(ie.eval_id)) holdoutDecidedSamples += 1
          } else if (ie.outcome_kind === 'disagreed') {
            agreementDecided += 1
            agreementDisagreed += 1
            if (isHoldoutMember(ie.eval_id)) holdoutDecidedSamples += 1
          }
        }
      }
    }
  } finally {
    closeAll(evalDbs)
  }

  // Also check workItems intake evaluation ledger if Evaluation agreement table had 0 rows
  const workItemDbs = await openReadOnlyDbs(dbMap.workItems, dshHome, canonicalHome, diagnostics, inspected)
  try {
    for (const db of workItemDbs) {
      if (hasTable(db, 'work_item_intake_evaluation')) {
        sawNotificationsTable = true
        if (wouldAcceptTotal === 0) {
          const row = db.prepare(`
            SELECT COUNT(*) AS n FROM work_item_intake_evaluation
            WHERE recorded_at >= ? AND recorded_at <= ? AND evaluation_level <> 'ignore'
          `).get(fromAt, toAt) as { n?: number } | undefined
          wouldAcceptTotal += row?.n ?? 0
        }
      }
    }
  } catch {
    // Optional table format difference; never fail report
  } finally {
    closeAll(workItemDbs)
  }

  // 2. Memory + Preference DBs -> Memory & Prompt Exposure
  const memDbs = await openReadOnlyDbs(dbMap.memory, dshHome, canonicalHome, diagnostics, inspected)
  const prefDbs = await openReadOnlyDbs(dbMap.preference, dshHome, canonicalHome, diagnostics, inspected)
  let sawMemoryOrPrefTable = false
  let activeMemoriesTotal = 0
  let newMemories = 0
  let sourcedMemories = 0
  let withdrawnOrRemovedMemories = 0
  let activePreferenceOverlays = 0
  let promptExposures = 0
  let postExposureSameClassCorrections = 0
  let preExposureContradictions = 0
  let firstHalfPrefContradictions = 0
  let secondHalfPrefContradictions = 0

  try {
    for (const db of memDbs) {
      if (hasTable(db, 'memory_records')) {
        sawMemoryOrPrefTable = true
        const activeRow = db.prepare("SELECT COUNT(*) AS n FROM memory_records WHERE status = 'active'").get() as { n: number }
        activeMemoriesTotal += activeRow.n
        const createdRows = db.prepare(`
          SELECT status, provenance_json FROM memory_records
          WHERE created_at >= ? AND created_at <= ?
        `).all(fromAt, toAt) as Array<{ status: string; provenance_json: string }>
        for (const r of createdRows) {
          newMemories += 1
          const prov = r.provenance_json.trim()
          if (r.status === 'active' && prov !== '' && prov !== '{}' && prov !== '[]' && prov !== 'null') {
            sourcedMemories += 1
          }
        }
        const removedRow = db.prepare(`
          SELECT COUNT(*) AS n FROM memory_records
          WHERE status = 'removed' AND updated_at >= ? AND updated_at <= ?
        `).get(fromAt, toAt) as { n: number }
        withdrawnOrRemovedMemories += removedRow.n
      }
      if (hasTable(db, 'memory_promotion_compensations')) {
        const compRow = db.prepare(`
          SELECT COUNT(*) AS n FROM memory_promotion_compensations
          WHERE compensated_at >= ? AND compensated_at <= ?
        `).get(fromAt, toAt) as { n: number }
        withdrawnOrRemovedMemories += compRow.n
      }
    }
    for (const db of prefDbs) {
      if (hasTable(db, 'preference_hypotheses')) {
        sawMemoryOrPrefTable = true
        const activeRow = db.prepare("SELECT COUNT(*) AS n FROM preference_hypotheses WHERE effect_state = 'active'").get() as { n: number }
        activePreferenceOverlays += activeRow.n
      }
      if (hasTable(db, 'preference_exposures')) {
        sawMemoryOrPrefTable = true
        const expRow = db.prepare(`
          SELECT COUNT(*) AS n FROM preference_exposures
          WHERE state = 'bound' AND exposed_at >= ? AND exposed_at <= ?
        `).get(fromAt, toAt) as { n: number }
        promptExposures += expRow.n
      }
      const hasExpCorr = hasTable(db, 'preference_exposure_corrections')
      if (hasExpCorr) {
        const corrRow = db.prepare(`
          SELECT COUNT(*) AS n FROM preference_exposure_corrections
          WHERE occurred_at >= ? AND occurred_at <= ?
        `).get(fromAt, toAt) as { n: number }
        postExposureSameClassCorrections += corrRow.n
      }
      if (hasTable(db, 'preference_signals')) {
        sawMemoryOrPrefTable = true
        // Exclude signal_ids that are post-exposure corrections so pre-exposure
        // contradictions are not inflated by post-exposure failures.
        const sigRows = db.prepare(`
          SELECT id, occurred_at FROM preference_signals
          WHERE stance = 'contradict' AND actor_trust = 'owner-authenticated'
            AND occurred_at >= ? AND occurred_at <= ?
        `).all(fromAt, toAt) as Array<{ id: string; occurred_at: number }>
        const postCorrIds = hasExpCorr
          ? new Set((db.prepare('SELECT signal_id FROM preference_exposure_corrections').all() as Array<{ signal_id: string }>).map(r => r.signal_id))
          : new Set<string>()
        for (const s of sigRows) {
          if (s.occurred_at < midAt) firstHalfPrefContradictions += 1
          else secondHalfPrefContradictions += 1
          if (!postCorrIds.has(s.id)) preExposureContradictions += 1
        }
      }
    }
  } finally {
    closeAll(memDbs)
    closeAll(prefDbs)
  }

  // 3. Candidates, Verification & Adoption across all RSI lanes (window-filtered)
  const mlDbs = await openReadOnlyDbs(dbMap.memoryLearning, dshHome, canonicalHome, diagnostics, inspected)
  const cpDbs = await openReadOnlyDbs(dbMap.controlPlane, dshHome, canonicalHome, diagnostics, inspected)
  const skillDbs = await openReadOnlyDbs(dbMap.skills, dshHome, canonicalHome, diagnostics, inspected)
  const gdDbs = await openReadOnlyDbs(dbMap.growthDriver, dshHome, canonicalHome, diagnostics, inspected)
  const prefCandDbs = await openReadOnlyDbs(dbMap.preference, dshHome, canonicalHome, diagnostics, inspected)
  const evoDbs = await openReadOnlyDbs(dbMap.evolution, dshHome, canonicalHome, diagnostics, inspected)
  const geDbs = await openReadOnlyDbs(dbMap.growthExperiments, dshHome, canonicalHome, diagnostics, inspected)

  let sawCandidatesTable = false
  let candGenerated = 0
  let candPassed = 0
  let candFailed = 0
  let candAdopted = 0
  let candRolledBack = 0

  try {
    for (const db of mlDbs) {
      if (hasTable(db, 'jobs')) {
        sawCandidatesTable = true
        const hasIntentJson = hasColumn(db, 'jobs', 'intent_json')
        const rows = (hasIntentJson
          ? db.prepare('SELECT state, intent_json FROM jobs').all()
          : db.prepare('SELECT state FROM jobs').all()) as Array<{ state: string; intent_json?: string }>
        for (const r of rows) {
          const intent = parseJsonObject(r.intent_json)
          if (!inWindowOrUntimestamped(intent.createdAt, fromAt, toAt)) continue
          candGenerated += 1
          if (r.state === 'adopted') { candPassed += 1; candAdopted += 1 }
          else if (r.state === 'rejected' || r.state === 'failed') candFailed += 1
        }
      }
    }
    for (const db of cpDbs) {
      if (hasTable(db, 'source_plans')) {
        sawCandidatesTable = true
        const rows = db.prepare('SELECT status, checked_tree_digest FROM source_plans WHERE updated_at >= ? AND updated_at <= ?')
          .all(fromAt, toAt) as Array<{ status: string; checked_tree_digest: string | null }>
        for (const r of rows) {
          candGenerated += 1
          if (r.status === 'local-checks-failed' || r.status === 'release-failed') candFailed += 1
          else if (r.checked_tree_digest !== null || r.status === 'release-complete' || r.status === 'ready-for-human-review') candPassed += 1
          if (r.status === 'release-complete') candAdopted += 1
        }
      }
      if (hasTable(db, 'activation_plans')) {
        sawCandidatesTable = true
        const rows = db.prepare('SELECT status FROM activation_plans WHERE updated_at >= ? AND updated_at <= ?')
          .all(fromAt, toAt) as Array<{ status: string }>
        for (const r of rows) {
          candGenerated += 1
          if (r.status === 'activated') { candPassed += 1; candAdopted += 1 }
          else if (r.status === 'rolled-back' || r.status === 'rollback-pending') candRolledBack += 1
        }
      }
      const hasRollbacksTable = hasTable(db, 'rollbacks')
      if (hasRollbacksTable && hasColumn(db, 'rollbacks', 'at')) {
        sawCandidatesTable = true
        const rbRow = db.prepare('SELECT COUNT(*) AS n FROM rollbacks WHERE at >= ? AND at <= ?').get(fromAt, toAt) as { n: number }
        candRolledBack += rbRow.n
      }
      if (hasTable(db, 'adoptions')) {
        sawCandidatesTable = true
        const hasClaimedAt = hasColumn(db, 'adoptions', 'claimed_at')
        const hasSettledAt = hasColumn(db, 'adoptions', 'settled_at')
        const hasReceiptJson = hasColumn(db, 'adoptions', 'receipt_json')
        const rows = (hasClaimedAt && hasSettledAt
          ? db.prepare('SELECT status, COALESCE(settled_at, claimed_at) AS at FROM adoptions').all()
          : hasReceiptJson
            ? db.prepare('SELECT status, receipt_json FROM adoptions').all()
            : db.prepare('SELECT status FROM adoptions').all()) as Array<{ status: string; at?: number; receipt_json?: string | null }>
        for (const r of rows) {
          const receipt = parseJsonObject(r.receipt_json)
          const at = r.at ?? (typeof receipt.adoptedAt === 'number' ? receipt.adoptedAt : receipt.issuedAt)
          if (!inWindowOrUntimestamped(at, fromAt, toAt)) continue
          if (r.status === 'active') candAdopted += 1
          else if (r.status === 'rejected') candFailed += 1
          else if (r.status === 'closed' && !hasRollbacksTable) candRolledBack += 1
        }
      }
    }
    for (const db of skillDbs) {
      if (hasTable(db, 'skill_candidates')) {
        sawCandidatesTable = true
        const hasCandJson = hasColumn(db, 'skill_candidates', 'candidate_json')
        if (hasCandJson) {
          const rows = db.prepare('SELECT candidate_json FROM skill_candidates').all() as Array<{ candidate_json: string }>
          for (const r of rows) {
            const c = parseJsonObject(r.candidate_json)
            if (!inWindowOrUntimestamped(c.updatedAt ?? c.createdAt, fromAt, toAt)) continue
            candGenerated += 1
            if (c.state === 'rejected') candFailed += 1
          }
        } else {
          const row = db.prepare('SELECT COUNT(*) AS n FROM skill_candidates').get() as { n: number }
          candGenerated += row.n
        }
      }
      if (hasTable(db, 'skill_comparisons')) {
        sawCandidatesTable = true
        const rows = db.prepare('SELECT state, comparison_json FROM skill_comparisons').all() as Array<{ state: string; comparison_json: string }>
        for (const r of rows) {
          if (r.state !== 'complete') continue
          const c = parseJsonObject(r.comparison_json)
          if (!inWindowOrUntimestamped(c.updatedAt ?? c.createdAt, fromAt, toAt)) continue
          if (skillComparisonPassed(r.comparison_json)) candPassed += 1
          else candFailed += 1
        }
      }
      if (hasTable(db, 'skill_deployments')) {
        sawCandidatesTable = true
        const hasDepJson = hasColumn(db, 'skill_deployments', 'deployment_json')
        const rows = (hasDepJson
          ? db.prepare('SELECT state, deployment_json FROM skill_deployments').all()
          : db.prepare('SELECT state FROM skill_deployments').all()) as Array<{ state: string; deployment_json?: string }>
        for (const r of rows) {
          const d = parseJsonObject(r.deployment_json)
          if (!inWindowOrUntimestamped(d.updatedAt ?? d.createdAt, fromAt, toAt)) continue
          if (r.state === 'canary' || r.state === 'promoted') candAdopted += 1
          else if (r.state === 'rolled-back' || r.state === 'revoked') candRolledBack += 1
          else if (r.state === 'blocked') candFailed += 1
        }
      }
    }
    for (const db of gdDbs) {
      if (hasTable(db, 'usage_jobs')) {
        sawCandidatesTable = true
        const hasIntentJson = hasColumn(db, 'usage_jobs', 'intent_json')
        const rows = (hasIntentJson
          ? db.prepare('SELECT state, intent_json FROM usage_jobs').all()
          : db.prepare('SELECT state FROM usage_jobs').all()) as Array<{ state: string; intent_json?: string }>
        for (const r of rows) {
          const intent = parseJsonObject(r.intent_json)
          if (!inWindowOrUntimestamped(intent.occurredAt ?? intent.createdAt, fromAt, toAt)) continue
          candGenerated += 1
          if (r.state === 'reviewed') candPassed += 1
          else if (r.state === 'failed') candFailed += 1
        }
      }
    }
    for (const db of prefCandDbs) {
      if (hasTable(db, 'preference_transitions')) {
        sawCandidatesTable = true
        const rows = db.prepare('SELECT reason FROM preference_transitions WHERE occurred_at >= ? AND occurred_at <= ?')
          .all(fromAt, toAt) as Array<{ reason: string }>
        for (const r of rows) {
          if (r.reason === 'created') candGenerated += 1
          else if (r.reason === 'activated') { candPassed += 1; candAdopted += 1 }
          else if (r.reason === 'owner-rejected' || r.reason === 'contradicted') candFailed += 1
          else if (r.reason === 'regression' || r.reason === 'operator-request') candRolledBack += 1
        }
      }
    }
    for (const db of evoDbs) {
      if (hasTable(db, 'evolution_proposals')) {
        sawCandidatesTable = true
        const rows = db.prepare('SELECT status FROM evolution_proposals WHERE updated_at >= ? AND updated_at <= ?')
          .all(fromAt, toAt) as Array<{ status: string }>
        for (const r of rows) {
          candGenerated += 1
          if (r.status === 'approved') candPassed += 1
          else if (r.status === 'rejected') candFailed += 1
        }
      }
      if (hasTable(db, 'evolution_rules')) {
        sawCandidatesTable = true
        const row = db.prepare('SELECT COUNT(*) AS n FROM evolution_rules WHERE adopted_at >= ? AND adopted_at <= ?')
          .get(fromAt, toAt) as { n: number }
        candAdopted += row.n
      }
      if (hasTable(db, 'evolution_autonomous_rollbacks')) {
        sawCandidatesTable = true
        const row = db.prepare('SELECT COUNT(*) AS n FROM evolution_autonomous_rollbacks WHERE occurred_at >= ? AND occurred_at <= ?')
          .get(fromAt, toAt) as { n: number }
        candRolledBack += row.n
      }
    }
    for (const db of geDbs) {
      if (hasTable(db, 'workflow_candidates')) {
        sawCandidatesTable = true
        const rows = db.prepare('SELECT state FROM workflow_candidates WHERE updated_at >= ? AND updated_at <= ?')
          .all(fromAt, toAt) as Array<{ state: string }>
        for (const r of rows) {
          candGenerated += 1
          if (r.state === 'ready' || r.state === 'promoted') candPassed += 1
          if (r.state === 'promoted') candAdopted += 1
          else if (r.state === 'rejected') candFailed += 1
          else if (r.state === 'rolled-back') candRolledBack += 1
        }
      }
    }
  } finally {
    closeAll(mlDbs)
    closeAll(cpDbs)
    closeAll(skillDbs)
    closeAll(gdDbs)
    closeAll(prefCandDbs)
    closeAll(evoDbs)
    closeAll(geDbs)
  }

  // Finalize Tasks section
  const correctionRatePpm = ppm(ownerCorrections, totalTasks)
  const reworkRatePpm = ppm(reworkTasks, totalTasks)
  const withdrawalRatePpm = ppm(ownerWithdrawals, totalTasks)
  const previousCorrectionRatePpm = ppm(prevCorrections, prevTotalTasks)
  const firstHalfCorrectionRatePpm = ppm(firstHalfCorrections, firstHalfTasks)
  const secondHalfCorrectionRatePpm = ppm(secondHalfCorrections, secondHalfTasks)

  const baselineRate = previousCorrectionRatePpm ?? firstHalfCorrectionRatePpm
  const targetRate = previousCorrectionRatePpm !== null ? correctionRatePpm : secondHalfCorrectionRatePpm
  const correctionRateDeltaPpm = baselineRate !== null && targetRate !== null ? targetRate - baselineRate : null
  const trend: GrowthTrendDirection = correctionRateDeltaPpm === null
    ? 'insufficient-data'
    : correctionRateDeltaPpm < 0 ? 'improving' : correctionRateDeltaPpm > 0 ? 'regressing' : 'flat'

  const tasksState: GrowthDataState = !sawEvalOutcomesTable
    ? 'no-data'
    : totalTasks === 0 && ownerCorrections === 0 && ownerWithdrawals === 0 ? 'zero' : 'data'

  // Finalize Memory section
  const postExposureCorrectionRatePpm = ppm(postExposureSameClassCorrections, promptExposures)
  let sameClassCorrectionTrend: GrowthExposureTrend = 'insufficient-data'
  if (promptExposures > 0 && (preExposureContradictions > 0 || postExposureSameClassCorrections > 0)) {
    if (preExposureContradictions === 0 && postExposureSameClassCorrections > 0) {
      sameClassCorrectionTrend = 'increased'
    } else if (postExposureSameClassCorrections === 0 && preExposureContradictions > 0) {
      sameClassCorrectionTrend = 'reduced'
    } else if (postExposureSameClassCorrections >= promptExposures) {
      // 100% of prompt exposures were contradicted; never classify as reduced.
      sameClassCorrectionTrend = postExposureSameClassCorrections > preExposureContradictions ? 'increased' : 'unchanged'
    } else if (postExposureSameClassCorrections < preExposureContradictions) {
      sameClassCorrectionTrend = 'reduced'
    } else if (postExposureSameClassCorrections === preExposureContradictions) {
      sameClassCorrectionTrend = 'unchanged'
    } else {
      sameClassCorrectionTrend = 'increased'
    }
  } else if (firstHalfPrefContradictions + secondHalfPrefContradictions >= 2) {
    if (secondHalfPrefContradictions < firstHalfPrefContradictions) sameClassCorrectionTrend = 'reduced'
    else if (secondHalfPrefContradictions === firstHalfPrefContradictions) sameClassCorrectionTrend = 'unchanged'
    else sameClassCorrectionTrend = 'increased'
  }

  const memoryState: GrowthDataState = !sawMemoryOrPrefTable
    ? 'no-data'
    : newMemories === 0
      && sourcedMemories === 0
      && withdrawnOrRemovedMemories === 0
      && promptExposures === 0
      && postExposureSameClassCorrections === 0
      && preExposureContradictions === 0
      && activePreferenceOverlays === 0
      ? 'zero'
      : 'data'

  // Finalize Candidates section
  const candidatesState: GrowthDataState = !sawCandidatesTable
    ? 'no-data'
    : candGenerated === 0 && candPassed === 0 && candFailed === 0 && candAdopted === 0 && candRolledBack === 0
      ? 'zero'
      : 'data'

  // Finalize Notifications section
  const agreementPpm = ppm(agreementAgreed, agreementDecided)
  const notificationsState: GrowthDataState = !sawNotificationsTable
    ? 'no-data'
    : notifTotal === 0 && wouldAcceptTotal === 0 && agreementDecided === 0 ? 'zero' : 'data'

  // Finalize Suppliers section
  const suppliersList: GrowthSupplierDistribution[] = [...supplierBuckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([supplier, b]) => {
      const sorted = [...b.latencies].sort((x, y) => x - y)
      const sumLat = sorted.reduce((acc, v) => acc + v, 0)
      return Object.freeze({
        supplier,
        runs: b.runs,
        costUsdMicros: b.costUsdMicros,
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        toolCalls: b.toolCalls,
        latencySamples: sorted.length,
        avgLatencyMs: sorted.length > 0 ? Math.round(sumLat / sorted.length) : null,
        p50LatencyMs: percentile(sorted, 50),
        p95LatencyMs: percentile(sorted, 95),
        maxLatencyMs: sorted.length > 0 ? sorted[sorted.length - 1]! : null,
      })
    })
  const totalRuns = suppliersList.reduce((acc, s) => acc + s.runs, 0)
  const totalCostUsdMicros = suppliersList.reduce((acc, s) => acc + s.costUsdMicros, 0)
  const suppliersState: GrowthDataState = !sawEvalOutcomesTable
    ? 'no-data'
    : totalRuns === 0 ? 'zero' : 'data'

  const allStates = [tasksState, memoryState, candidatesState, notificationsState, suppliersState]
  const overallState: GrowthDataState = allStates.includes('data')
    ? 'data'
    : allStates.includes('zero') ? 'zero' : 'no-data'

  // Pre-registered Dogfood Memory Lane Acceptance Gate (14d target)
  const totalAuthCorrections = ownerCorrections + preExposureContradictions + postExposureSameClassCorrections
  const windowSatisfied = windowMs >= 14 * DAY_MS
  const correctionRateDropped = trend === 'improving' || sameClassCorrectionTrend === 'reduced'
  const gateStatus: GrowthMemoryLaneGate['status'] = overallState === 'no-data'
    ? 'no-data'
    : conflicted > 0
      ? 'attention-needed'
      : windowSatisfied
        && totalAuthCorrections >= 10
        && sourcedMemories >= 5
        && promptExposures >= 5
        && correctionRateDropped
        ? 'passed'
        : 'collecting'

  return Object.freeze({
    protocol: 'dsh-rsi/growth-report/v1',
    dshHome,
    homeExists,
    profile: activeProfile,
    profiles: Object.freeze([...discoveredProfiles]),
    sinceSpec,
    windowMs,
    fromAt,
    toAt,
    overallState,
    inspectedLedgers: Object.freeze([...inspected].sort()),
    diagnostics: Object.freeze(diagnostics),
    tasks: Object.freeze({
      state: tasksState,
      totalTasks,
      achieved,
      partial,
      notAchieved,
      conflicted,
      ownerCorrections,
      ownerWithdrawals,
      reworkTasks,
      correctionRatePpm,
      reworkRatePpm,
      withdrawalRatePpm,
      previousTotalTasks: prevTotalTasks,
      previousCorrectionRatePpm,
      firstHalfCorrectionRatePpm,
      secondHalfCorrectionRatePpm,
      correctionRateDeltaPpm,
      trend,
    }),
    memory: Object.freeze({
      state: memoryState,
      activeMemoriesTotal,
      newMemories,
      sourcedMemories,
      withdrawnOrRemovedMemories,
      activePreferenceOverlays,
      promptExposures,
      postExposureSameClassCorrections,
      preExposureContradictions,
      postExposureCorrectionRatePpm,
      sameClassCorrectionTrend,
    }),
    candidates: Object.freeze({
      state: candidatesState,
      generated: candGenerated,
      verificationPassed: candPassed,
      verificationFailed: candFailed,
      adopted: candAdopted,
      rolledBack: candRolledBack,
    }),
    notifications: Object.freeze({
      state: notificationsState,
      total: notifTotal,
      delivered: notifDelivered,
      reacted: notifReacted,
      accepted: notifAccepted,
      rejected: notifRejected,
      ignoredOrExpired: notifIgnored,
      failed: notifFailed,
      wouldAcceptTotal,
      agreementDecided,
      agreementAgreed,
      agreementDisagreed,
      agreementPpm,
      holdoutDecidedSamples,
      looseningMinHoldoutSamples: DEFAULT_LOOSENING_MIN_HOLDOUT,
      looseningGateStatus: holdoutDecidedSamples >= DEFAULT_LOOSENING_MIN_HOLDOUT ? 'ready-for-review' : 'insufficient-samples',
    }),
    suppliers: Object.freeze({
      state: suppliersState,
      totalRuns,
      totalCostUsdMicros,
      suppliers: Object.freeze(suppliersList),
    }),
    memoryLaneGate: Object.freeze({
      targetWindowDays: 14,
      windowSatisfied,
      authenticatedCorrections: totalAuthCorrections,
      minAuthenticatedCorrections: 10,
      sourcedMemories,
      minSourcedMemories: 5,
      promptExposures,
      minPromptExposures: 5,
      correctionRateDropped,
      conflictedTasks: conflicted,
      status: gateStatus,
    }),
  })
}

export function formatGrowthReport(report: GrowthReport): string {
  const lines: string[] = []
  const fromIso = new Date(report.fromAt).toISOString()
  const toIso = new Date(report.toAt).toISOString()
  lines.push(`成长计分卡（只读） — 窗口：最近 ${report.sinceSpec}（${fromIso} .. ${toIso}）`)
  lines.push(`DSH home：${report.dshHome}（${report.homeExists ? '存在' : '不存在'}） · profile：${report.profile ?? (report.profiles.join(', ') || '无')}`)
  lines.push(`总体数据状态：${formatStateLabel(report.overallState)}（已只读检查 ${report.inspectedLedgers.length} 个 SQLite 账本）`)
  lines.push('')

  // 1. Tasks
  const t = report.tasks
  lines.push(`1. 任务与主人反馈 [${formatStateLabel(t.state)}]`)
  if (t.state !== 'no-data') {
    const trendLabel = t.trend === 'improving' ? '下降/改善' : t.trend === 'regressing' ? '上升/退化' : t.trend === 'flat' ? '持平' : '样本不足'
    lines.push(`   任务总数：${t.totalTasks}（达成 ${t.achieved} / 部分 ${t.partial} / 未达成 ${t.notAchieved} / 冲突 ${t.conflicted}）`)
    lines.push(`   纠正率：${formatPct(t.correctionRatePpm)}（${t.ownerCorrections} 次） · 重做率：${formatPct(t.reworkRatePpm)}（${t.reworkTasks} 次） · 撤回率：${formatPct(t.withdrawalRatePpm)}（${t.ownerWithdrawals} 次）`)
    lines.push(`   趋势：${trendLabel}${t.correctionRateDeltaPpm !== null ? `（Δ ${(t.correctionRateDeltaPpm / 10_000).toFixed(1)}pp）` : ''}`)
  }

  // 2. Memory
  const m = report.memory
  lines.push(`2. 记忆与提示词暴露 [${formatStateLabel(m.state)}]`)
  if (m.state !== 'no-data') {
    const expTrend = m.sameClassCorrectionTrend === 'reduced' ? '已减少'
      : m.sameClassCorrectionTrend === 'unchanged' ? '持平'
        : m.sameClassCorrectionTrend === 'increased' ? '上升' : '样本不足'
    lines.push(`   新增记忆：${m.newMemories}（有来源 ${m.sourcedMemories} / 撤回或移除 ${m.withdrawnOrRemovedMemories} / 当前活跃总计 ${m.activeMemoriesTotal}）`)
    lines.push(`   活跃偏好 Overlay：${m.activePreferenceOverlays} · 实际暴露到提示词：${m.promptExposures} 次`)
    lines.push(`   暴露后同类纠正：${m.postExposureSameClassCorrections} 次（比率 ${formatPct(m.postExposureCorrectionRatePpm)}，同类纠正趋势：${expTrend}）`)
  }

  // 3. Candidates
  const c = report.candidates
  lines.push(`3. 改进候选与采用 [${formatStateLabel(c.state)}]`)
  if (c.state !== 'no-data') {
    lines.push(`   候选生成：${c.generated} · 验收通过：${c.verificationPassed} · 验收失败：${c.verificationFailed} · 已采用：${c.adopted} · 已回滚：${c.rolledBack}`)
  }

  // 4. Notifications
  const n = report.notifications
  lines.push(`4. 通知反馈与主动通道吻合度 [${formatStateLabel(n.state)}]`)
  if (n.state !== 'no-data') {
    lines.push(`   通知总计：${n.total}（送达 ${n.delivered} / 采纳 ${n.accepted} / 反应 ${n.reacted} / 拒绝 ${n.rejected} / 忽略过期 ${n.ignoredOrExpired} / 失败 ${n.failed}）`)
    lines.push(`   would-accept 候选：${n.wouldAcceptTotal} · 吻合度已决样本：${n.agreementDecided}（吻合 ${n.agreementAgreed} / 分歧 ${n.agreementDisagreed} / 吻合率 ${formatPct(n.agreementPpm)}）`)
    lines.push(`   密封留出（1/4 holdout）已决样本：${n.holdoutDecidedSamples}/${n.looseningMinHoldoutSamples}（放宽门控：${n.looseningGateStatus === 'ready-for-review' ? '样本达标，可评估放宽' : '样本不足，继续保持 observe'}）`)
  }

  // 5. Suppliers
  const s = report.suppliers
  lines.push(`5. 成本与延迟分布（按冻结 Supplier） [${formatStateLabel(s.state)}]`)
  if (s.state === 'zero') {
    lines.push('   窗口内无模型/评估运行记录（0 次，$0.000000）')
  } else if (s.state === 'data') {
    lines.push(`   总运行：${s.totalRuns} 次 · 总成本：$${(s.totalCostUsdMicros / 1_000_000).toFixed(6)}`)
    for (const sup of s.suppliers) {
      const latText = sup.latencySamples > 0
        ? `avg=${sup.avgLatencyMs}ms p50=${sup.p50LatencyMs}ms p95=${sup.p95LatencyMs}ms`
        : '延迟无记录'
      lines.push(`   - ${sup.supplier}：${sup.runs} 次 · $${(sup.costUsdMicros / 1_000_000).toFixed(6)} · in=${sup.inputTokens} out=${sup.outputTokens} tools=${sup.toolCalls} · ${latText}`)
    }
  }

  // 6. Pre-registered Dogfood Gate
  const g = report.memoryLaneGate
  const gateLabel = g.status === 'passed' ? '已满足预登记口径'
    : g.status === 'attention-needed' ? '存在冲突待排查'
      : g.status === 'collecting' ? '观察采集中' : '尚无账本数据'
  lines.push('')
  lines.push(`记忆通道预登记验收门控（14d 口径）：${gateLabel} [窗口≥14d=${g.windowSatisfied ? '是' : '否'}，认证纠正=${g.authenticatedCorrections}/${g.minAuthenticatedCorrections}，有来源记忆=${g.sourcedMemories}/${g.minSourcedMemories}，提示词暴露=${g.promptExposures}/${g.minPromptExposures}，纠正率下降=${g.correctionRateDropped ? '是' : '否'}，冲突=${g.conflictedTasks}]`)

  if (report.diagnostics.length > 0) {
    lines.push('')
    lines.push('诊断提示：')
    for (const diag of report.diagnostics) lines.push(`  ! ${diag}`)
  }
  return lines.join('\n')
}
