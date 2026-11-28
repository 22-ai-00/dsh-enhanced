import { createHash } from 'node:crypto'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import { resolveOverviewScope } from './autonomy-readers.js'
import type { LoaderService } from './settings.js'
import type {
  GrowthDataState,
  OwnerConsoleGrowthReport,
  OwnerConsoleGrowthSupplier,
} from './typert.js'

const DAY_MS = 86_400_000
const ATTENTION_HOLDOUT_PROTOCOL = 'assistant-evaluation/attention-holdout/v1'
const DEFAULT_LOOSENING_MIN_HOLDOUT = 20

const rec = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const arr = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : []
const int0 = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0

function ppm(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null
  return Math.min(1_000_000, Math.max(0, Math.round((numerator * 1_000_000) / denominator)))
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]!
}

function isHoldoutMember(id: string): boolean {
  const hex = createHash('sha256').update(`${ATTENTION_HOLDOUT_PROTOCOL}\n${id}`).digest('hex')
  return Number.parseInt(hex.slice(0, 8), 16) % 4 === 0
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

function findLoaderConfig(host: Context, moduleName: string): Record<string, unknown> | undefined {
  const found = findLoaderEntryConfigs(host, moduleName)
  if (!found) return undefined
  return Object.keys(found.effective).length > 0 ? { ...found.raw, ...found.effective } : found.raw
}

interface SqlitePathBoundary {
  readonly dshHome: string
  readonly canonicalDshHome: string
  readonly rayHome?: string
  readonly canonicalRayHome?: string
  readonly explicitHome: boolean
}

function cleanAbsoluteDir(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.includes('\0') || !isAbsolute(trimmed)) return undefined
  return resolve(trimmed)
}

function tryRealpath(dirPath: string): string {
  if (!existsSync(dirPath)) return dirPath
  try {
    return realpathSync(dirPath)
  } catch {
    return dirPath
  }
}

function resolveSqliteBoundary(host: Context): SqlitePathBoundary {
  const profile = host.get('profileContext' as never) as { dir?: unknown; home?: unknown } | undefined
  const settings = host.get('settings' as never) as { documentPath?: unknown } | undefined
  let hostHome = cleanAbsoluteDir(profile?.home)
  if (!hostHome) {
    const profileDir = cleanAbsoluteDir(profile?.dir)
    if (profileDir && basename(dirname(profileDir)) === 'profiles') {
      hostHome = dirname(dirname(profileDir))
    }
  }
  if (!hostHome) {
    const docPath = cleanAbsoluteDir(settings?.documentPath)
    if (docPath) hostHome = dirname(docPath)
  }
  const envHome = cleanAbsoluteDir(process.env['DSH_HOME'])
  const dshHome = hostHome ?? envHome ?? resolve(homedir(), '.dsh')
  const policyRayHome = cleanAbsoluteDir((host.get('assistantPolicy') as { rayHomeDir?: () => unknown } | undefined)?.rayHomeDir?.())
  const envRayHome = cleanAbsoluteDir(process.env['RAY_HOME'])
  const rayHome = policyRayHome ?? envRayHome
  return {
    dshHome,
    canonicalDshHome: tryRealpath(dshHome),
    ...(rayHome === undefined ? {} : { rayHome, canonicalRayHome: tryRealpath(rayHome) }),
    explicitHome: Boolean(hostHome || envHome || rayHome),
  }
}

const DSH_HOME_EXPR_RE = /^(?:!!js\s+)?dshHomePath\(\s*(['"])([^'"\r\n]+)\1\s*\)$/u

function resolvePathCandidate(rawValue: unknown, dshHome: string): string | undefined {
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
  if (exprSource.includes('\0') || isAbsolute(exprSource) || exprSource.split('/').some(seg => seg === '..' || seg === '.')) {
    return undefined
  }
  return resolve(dshHome, exprSource)
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

function findLoaderDbPath(
  host: Context,
  boundary: SqlitePathBoundary,
  moduleName: string,
  nestedKey?: string,
): string | undefined {
  return findLoaderPathProp(host, boundary, moduleName, 'databasePath', nestedKey)
}

function findControlPlaneDbPaths(
  host: Context,
  boundary: SqlitePathBoundary,
  profileName: string | undefined,
  serviceMounted: boolean,
): string[] {
  const candidates = new Set<string>()
  const directDb = findLoaderDbPath(host, boundary, '@dsh-ray/plugin-control-plane')
  if (directDb) candidates.add(directDb)
  const stateDir = findLoaderPathProp(host, boundary, '@dsh-ray/plugin-control-plane', 'statePath')
  if (stateDir) {
    candidates.add(join(stateDir, 'control.sqlite'))
    candidates.add(join(stateDir, 'creation-adoptions.sqlite'))
    candidates.add(join(stateDir, 'revision-adoptions.sqlite'))
  }
  const hasCpConfig = findLoaderConfig(host, '@dsh-ray/plugin-control-plane') !== undefined
  if (boundary.explicitHome && (serviceMounted || hasCpConfig)) {
    const hostHome = boundary.dshHome
    candidates.add(join(hostHome, 'plugin-control-plane', 'state.sqlite'))
    candidates.add(join(hostHome, 'plugin-control-plane', 'control.sqlite'))
    if (profileName) {
      candidates.add(join(hostHome, 'plugin-control-plane', `${profileName}.sqlite`))
      candidates.add(join(hostHome, 'plugin-control-plane', `${profileName}-creation-adoptions.sqlite`))
      candidates.add(join(hostHome, 'plugin-control-plane', `${profileName}-revision-adoptions.sqlite`))
      candidates.add(join(hostHome, 'rsi-authorities', profileName, 'state', 'control-plane', 'control.sqlite'))
      candidates.add(join(hostHome, 'rsi-authorities', profileName, 'state', 'control-plane', 'creation-adoptions.sqlite'))
      candidates.add(join(hostHome, 'rsi-authorities', profileName, 'state', 'control-plane', 'revision-adoptions.sqlite'))
    }
  }
  return [...candidates]
}

function withReadOnlySqlite<T>(
  dbPath: string | undefined,
  boundary: SqlitePathBoundary,
  fn: (db: DatabaseSync, realTarget: string) => T,
): T | undefined {
  if (!dbPath || !existsSync(dbPath)) return undefined
  const target = resolve(dbPath)
  let realTarget: string
  try {
    const st = lstatSync(target)
    if (!st.isFile() || st.isSymbolicLink()) return undefined
    realTarget = realpathSync(target)
    const logicallyWithin = target.startsWith(`${boundary.dshHome}${sep}`)
      || target.startsWith(`${boundary.canonicalDshHome}${sep}`)
    const physicallyWithin = realTarget.startsWith(`${boundary.canonicalDshHome}${sep}`)
    const withinRayHome = boundary.rayHome !== undefined && boundary.canonicalRayHome !== undefined
      && (target.startsWith(`${boundary.rayHome}${sep}`) || target.startsWith(`${boundary.canonicalRayHome}${sep}`))
      && realTarget.startsWith(`${boundary.canonicalRayHome}${sep}`)
    if (!(logicallyWithin && physicallyWithin) && !withinRayHome) {
      return undefined
    }
  } catch {
    return undefined
  }
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(realTarget, { readOnly: true })
    const check = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined
    if (!check || Object.values(check)[0] !== 'ok') return undefined
    return fn(db, realTarget)
  } catch {
    return undefined
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name) !== undefined
}

function hasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>
  return cols.some(col => col.name === columnName)
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

function inWindowOrUntimestamped(at: unknown, fromAt: number, toAt: number): boolean {
  if (typeof at !== 'number' || !Number.isFinite(at)) return true
  return at >= fromAt && at <= toAt
}

function skillComparisonPassed(comparisonJson: string): boolean {
  const c = parseJsonObject(comparisonJson)
  const res = c['result'] && typeof c['result'] === 'object' && !Array.isArray(c['result'])
    ? c['result'] as Record<string, unknown>
    : undefined
  if (res) {
    if (res['qualified'] === true || res['passed'] === true || res['verdict'] === 'passed' || res['accepted'] === true || res['winner'] === 'candidate') {
      return true
    }
    if (typeof res['admissionDigest'] === 'string' && res['admissionDigest'].length === 64 && res['promotionAuthorized'] !== false) {
      return true
    }
    const report = rec(res['report'])
    const receipt = rec(res['receipt'])
    if (report['passed'] === true || receipt['passed'] === true || receipt['qualified'] === true) return true
    return false
  }
  return c['passed'] === true || c['verdict'] === 'passed' || c['accepted'] === true || c['qualified'] === true
}

function resolveProfileName(host: Context): string | undefined {
  const profile = host.get('profileContext' as never) as { dir?: unknown; name?: unknown } | undefined
  if (typeof profile?.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(profile.name)) return profile.name
  if (typeof profile?.dir === 'string' && profile.dir !== '') {
    const base = basename(profile.dir)
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(base)) return base
  }
  return undefined
}

function resolveGrowthScope(
  host: Context,
  requestedWorkspace: string,
  requestedPreset: string,
): Readonly<{ workspace: string; preset: string }> | undefined {
  const direct = resolveOverviewScope(host, requestedWorkspace, requestedPreset)
  if (direct) return direct

  const larkCfg = findLoaderConfig(host, '@dsh-ray/lark-channel')
  if (larkCfg) {
    const ws = typeof larkCfg['ownerWorkspace'] === 'string' ? larkCfg['ownerWorkspace'].trim() : ''
    const pr = typeof larkCfg['defaultAgentPreset'] === 'string' ? larkCfg['defaultAgentPreset'].trim() : ''
    if (ws !== '' && pr !== '') return Object.freeze({ workspace: ws, preset: pr })
  }

  const deliveryCfg = findLoaderConfig(host, '@dsh-ray/assistant-delivery')
  if (deliveryCfg) {
    for (const route of arr(deliveryCfg['ownerRoutes'])) {
      const r = rec(route)
      const ws = typeof r['workspace'] === 'string' ? r['workspace'].trim() : ''
      const pr = typeof r['agentPreset'] === 'string' ? r['agentPreset'].trim() : ''
      if (ws !== '' && pr !== '') return Object.freeze({ workspace: ws, preset: pr })
    }
  }
  return undefined
}

function extractSupplier(outcome: Record<string, unknown>): string {
  const metrics = rec(outcome['metrics'])
  const supplier = rec(metrics['supplier'])
  const provider = typeof supplier['provider'] === 'string'
    ? supplier['provider'].trim()
    : typeof metrics['provider'] === 'string' ? metrics['provider'].trim() : ''
  const model = typeof supplier['model'] === 'string'
    ? supplier['model'].trim()
    : typeof metrics['model'] === 'string' ? metrics['model'].trim() : ''
  if (provider && model) return `${provider}/${model}`.slice(0, 256)
  if (provider) return provider.slice(0, 256)
  if (model) return model.slice(0, 256)
  for (const item of arr(outcome['evidence'])) {
    const ref = rec(item)
    if ((ref['kind'] === 'supplier' || ref['kind'] === 'model-route') && typeof ref['ref'] === 'string' && ref['ref'].trim() !== '') {
      return ref['ref'].trim().slice(0, 256)
    }
  }
  const evaluator = rec(outcome['evaluator'])
  if (typeof evaluator['id'] === 'string' && evaluator['id'].trim() !== '') return evaluator['id'].trim().slice(0, 256)
  return 'unknown-supplier'
}

function extractSupplierFromColumns(metricsJson: string, evidenceJson: string, evaluatorId: string): string {
  return extractSupplier({
    metrics: parseJsonObject(metricsJson),
    evidence: parseJsonArray(evidenceJson),
    evaluator: { id: evaluatorId },
  })
}

const SUBJECT_EVIDENCE_KINDS = new Set([
  'automation-run',
  'foreground-turn',
  'goal-step',
  'goal-outcome',
  'work-item',
])

function inferSubjectKeyFromStoredOutcome(out: Record<string, unknown>, outcomeSubjectById: ReadonlyMap<string, string>): string {
  if (typeof out['taskSubjectKey'] === 'string' && out['taskSubjectKey'] !== '') return out['taskSubjectKey']
  const proj = rec(out['projection'])
  if (typeof proj['subjectKind'] === 'string' && typeof proj['subjectRef'] === 'string' && proj['subjectRef'] !== '') {
    return `${proj['subjectKind']}:${proj['subjectRef']}`
  }
  const task = rec(out['task'])
  if (typeof task['subjectKey'] === 'string' && task['subjectKey'] !== '') return task['subjectKey']

  for (const item of arr(out['evidence'])) {
    const ref = rec(item)
    const kind = typeof ref['kind'] === 'string' ? ref['kind'] : ''
    const val = typeof ref['ref'] === 'string' ? ref['ref'].trim() : ''
    if (val === '') continue
    if (SUBJECT_EVIDENCE_KINDS.has(kind)) return `${kind}:${val}`
    if (kind === 'evaluation-outcome' || kind === 'target-outcome' || kind === 'outcome') {
      const mapped = outcomeSubjectById.get(val)
      if (mapped) return mapped
    }
  }
  const id = typeof out['id'] === 'string' ? out['id'] : ''
  return id !== '' ? `outcome:${id}` : ''
}

export function readOwnerConsoleGrowthReport(
  host: Context,
  workspace: string,
  preset: string,
  sinceDaysInput: number,
  nowMs = Date.now(),
): OwnerConsoleGrowthReport {
  const sinceDays = Math.min(365, Math.max(1, Math.trunc(Number.isFinite(sinceDaysInput) ? sinceDaysInput : 7)))
  const windowMs = sinceDays * DAY_MS
  const toAt = Math.max(0, Math.trunc(nowMs))
  const fromAt = Math.max(0, toAt - windowMs)
  const prevFromAt = Math.max(0, fromAt - windowMs)
  const midAt = Math.floor((fromAt + toAt) / 2)

  const explicitScopeRequested = workspace.trim() !== '' && preset.trim() !== ''
  let scope = resolveGrowthScope(host, workspace, preset)
  const profileName = resolveProfileName(host)
  const sqliteBoundary = resolveSqliteBoundary(host)
  const cliCommand = `dsh-ray growth-report${profileName ? ` --profile ${profileName}` : ''} --since ${sinceDays}d`

  // 1. Evaluation: Tasks, Owner Revisions, Suppliers, Notifications & Agreement
  const evaluation = host.get('assistantEvaluation' as never) as Record<string, unknown> | undefined
  const evalDbPath = findLoaderDbPath(host, sqliteBoundary, '@dsh-ray/assistant-evaluation')
    ?? (sqliteBoundary.explicitHome && evaluation ? join(sqliteBoundary.dshHome, 'assistant-evaluation', 'evaluation.sqlite') : undefined)
  let tasksState: GrowthDataState = 'no-data'
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

  let suppliersState: GrowthDataState = 'no-data'
  const supplierMap = new Map<string, {
    runs: number
    costUsdMicros: number
    inputTokens: number
    outputTokens: number
    toolCalls: number
    latencies: number[]
  }>()

  let notificationsState: GrowthDataState = 'no-data'
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

  // Prefer exact, untruncated read-only SQLite aggregation when file-backed.
  const evalFromSqlite = withReadOnlySqlite(evalDbPath, sqliteBoundary, db => {
    if (!hasTable(db, 'evaluation_outcomes')) return undefined
    if (scope === undefined && !explicitScopeRequested && hasColumn(db, 'evaluation_outcomes', 'workspace') && hasColumn(db, 'evaluation_outcomes', 'preset')) {
      const distinctScopes = db.prepare('SELECT DISTINCT workspace, preset FROM evaluation_outcomes LIMIT 2')
        .all() as Array<{ workspace: string; preset: string }>
      if (distinctScopes.length === 1 && distinctScopes[0]!.workspace && distinctScopes[0]!.preset) {
        scope = Object.freeze({ workspace: distinctScopes[0]!.workspace, preset: distinctScopes[0]!.preset })
      }
    }

    const filterScope = explicitScopeRequested && scope !== undefined
    const scopeWhereO = filterScope ? 'AND o.workspace = ? AND o.preset = ?' : ''
    const scopeParams = filterScope ? [scope!.workspace, scope!.preset] : []

    if (hasTable(db, 'evaluation_task_projections')) {
      const hasSplitRefs = hasColumn(db, 'evaluation_task_projections', 'objective_outcome_id')
        && hasColumn(db, 'evaluation_task_projections', 'execution_outcome_id')
      const hasObjConflicted = hasColumn(db, 'evaluation_task_projections', 'objective_conflicted')
      const conflictedExpr = hasObjConflicted ? 'p.objective_conflicted' : '0'
      const taskRows = (hasSplitRefs
        ? db.prepare(`
            SELECT p.subject_key, ${conflictedExpr} AS objective_conflicted, p.updated_at,
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
              ${filterScope ? 'AND COALESCE(o.workspace, exec_o.workspace, obj.workspace) = ? AND COALESCE(o.preset, exec_o.preset, obj.preset) = ?' : ''}
          `).all(prevFromAt, toAt, ...scopeParams)
        : db.prepare(`
            SELECT p.subject_key, ${conflictedExpr} AS objective_conflicted, p.updated_at,
                   COALESCE(o.objective_status, 'unknown') AS objective_status,
                   COALESCE(o.metrics_json, '{}') AS metrics_json,
                   COALESCE(o.occurred_at, p.updated_at) AS occurred_at
            FROM evaluation_task_projections p
            LEFT JOIN evaluation_outcomes o ON o.id = p.primary_outcome_id
            WHERE COALESCE(o.occurred_at, p.updated_at) >= ?
              AND COALESCE(o.occurred_at, p.updated_at) <= ?
              ${scopeWhereO}
          `).all(prevFromAt, toAt, ...scopeParams)) as Array<{
        subject_key: string
        objective_conflicted: number
        updated_at: number
        objective_status: string
        metrics_json: string
        occurred_at: number
      }>

      const correctedCur = new Set<string>()
      const correctedPrev = new Set<string>()
      const correctedFirst = new Set<string>()
      const correctedSecond = new Set<string>()
      const withdrawnCur = new Set<string>()
      const revisionIds = new Set<string>()

      if (hasTable(db, 'evaluation_owner_revisions')) {
        for (const r of db.prepare('SELECT outcome_id FROM evaluation_owner_revisions').all() as Array<{ outcome_id: string }>) {
          revisionIds.add(r.outcome_id)
        }
        const hasLineageVersion = hasColumn(db, 'evaluation_owner_revisions', 'lineage')
          && hasColumn(db, 'evaluation_owner_revisions', 'version')
        const revRows = (hasLineageVersion
          ? db.prepare(`
              SELECT r.subject_key, r.action, o.occurred_at
              FROM evaluation_owner_revisions r
              JOIN evaluation_outcomes o ON o.id = r.outcome_id
              WHERE o.occurred_at >= ? AND o.occurred_at <= ? ${scopeWhereO}
                AND NOT EXISTS (
                  SELECT 1 FROM evaluation_owner_revisions r2
                  JOIN evaluation_outcomes o2 ON o2.id = r2.outcome_id
                  WHERE r2.subject_key = r.subject_key AND r2.lineage = r.lineage
                    AND o2.occurred_at <= ? AND r2.version > r.version
                )
            `).all(prevFromAt, toAt, ...scopeParams, toAt)
          : db.prepare(`
              SELECT r.subject_key, r.action, o.occurred_at
              FROM evaluation_owner_revisions r
              JOIN evaluation_outcomes o ON o.id = r.outcome_id
              WHERE o.occurred_at >= ? AND o.occurred_at <= ? ${scopeWhereO}
            `).all(prevFromAt, toAt, ...scopeParams)) as Array<{ subject_key: string; action: string; occurred_at: number }>
        for (const rev of revRows) {
          if (rev.occurred_at >= fromAt) {
            if (rev.action === 'correct') {
              correctedCur.add(rev.subject_key)
              if (rev.occurred_at < midAt) correctedFirst.add(rev.subject_key)
              else correctedSecond.add(rev.subject_key)
            } else if (rev.action === 'withdraw') {
              withdrawnCur.add(rev.subject_key)
            }
          } else if (rev.action === 'correct') {
            correctedPrev.add(rev.subject_key)
          }
        }
      }

      const hasTrustCol = hasColumn(db, 'evaluation_outcomes', 'trust')
      const hasTaskSubjectKeyCol = hasColumn(db, 'evaluation_outcomes', 'task_subject_key')
      const fbRows = db.prepare(`
        SELECT o.id, ${hasTaskSubjectKeyCol ? 'COALESCE(o.task_subject_key, o.id)' : 'o.id'} AS skey, o.objective_status, o.occurred_at
        FROM evaluation_outcomes o
        WHERE o.source_kind = 'user-feedback'
          ${hasTrustCol ? "AND o.trust = 'trusted'" : ''}
          AND o.occurred_at >= ? AND o.occurred_at <= ? ${scopeWhereO}
      `).all(prevFromAt, toAt, ...scopeParams) as Array<{ id: string; skey: string; objective_status: string; occurred_at: number }>
      for (const fb of fbRows) {
        if (revisionIds.has(fb.id)) continue
        if (fb.objective_status === 'not-achieved' || fb.objective_status === 'partial') {
          if (fb.occurred_at >= fromAt) {
            if (!withdrawnCur.has(fb.skey)) {
              correctedCur.add(fb.skey)
              if (fb.occurred_at < midAt) correctedFirst.add(fb.skey)
              else correctedSecond.add(fb.skey)
            }
          } else {
            correctedPrev.add(fb.skey)
          }
        } else if (fb.objective_status === 'unknown' && fb.occurred_at >= fromAt) {
          withdrawnCur.add(fb.skey)
          correctedCur.delete(fb.skey)
          correctedFirst.delete(fb.skey)
          correctedSecond.delete(fb.skey)
        }
      }

      const multiAttemptSubjects = hasTaskSubjectKeyCol
        ? new Set(
            (db.prepare(`
              SELECT o.task_subject_key FROM evaluation_outcomes o
              WHERE o.task_subject_key IS NOT NULL AND o.occurred_at >= ? AND o.occurred_at <= ? ${scopeWhereO}
              GROUP BY o.task_subject_key
              HAVING COUNT(*) > 1 AND SUM(o.execution_status = 'failed' OR o.objective_status = 'not-achieved') > 0
            `).all(fromAt, toAt, ...scopeParams) as Array<{ task_subject_key: string }>).map(r => r.task_subject_key),
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
        } else if (!withdrawnCur.has(row.subject_key)) {
          if (row.objective_status === 'achieved') achieved += 1
          else if (row.objective_status === 'partial') partial += 1
          else if (row.objective_status === 'not-achieved') notAchieved += 1
        }
        const m = parseJsonObject(row.metrics_json)
        if (int0(m['retries']) > 0 || multiAttemptSubjects.has(row.subject_key)) reworkTasks += 1
      }

      ownerCorrections = correctedCur.size
      ownerWithdrawals = withdrawnCur.size
      prevCorrections = correctedPrev.size
      firstHalfCorrections = correctedFirst.size
      secondHalfCorrections = correctedSecond.size
    }

    const outRows = db.prepare(`
      SELECT o.evaluator_id, o.metrics_json, o.evidence_json, o.cost_usd_micros, o.latency_ms, o.input_tokens, o.output_tokens, o.tool_calls
      FROM evaluation_outcomes o
      WHERE o.occurred_at >= ? AND o.occurred_at <= ? AND o.source_kind != 'user-feedback' ${scopeWhereO}
    `).all(fromAt, toAt, ...scopeParams) as Array<{
      evaluator_id: string
      metrics_json: string
      evidence_json: string
      cost_usd_micros: number | null
      latency_ms: number | null
      input_tokens: number | null
      output_tokens: number | null
      tool_calls: number | null
    }>
    for (const out of outRows) {
      const sup = extractSupplierFromColumns(out.metrics_json, out.evidence_json, out.evaluator_id)
      let b = supplierMap.get(sup)
      if (!b) {
        b = { runs: 0, costUsdMicros: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, latencies: [] }
        supplierMap.set(sup, b)
      }
      const m = parseJsonObject(out.metrics_json)
      b.runs += 1
      b.costUsdMicros += int0(out.cost_usd_micros ?? m['costUsdMicros'])
      b.inputTokens += int0(out.input_tokens ?? m['inputTokens'])
      b.outputTokens += int0(out.output_tokens ?? m['outputTokens'])
      b.toolCalls += int0(out.tool_calls ?? m['toolCalls'])
      const lat = out.latency_ms ?? m['latencyMs']
      if (typeof lat === 'number' && Number.isFinite(lat) && lat >= 0) b.latencies.push(Math.trunc(lat))
    }

    let sawNotif = false
    if (hasTable(db, 'evaluation_notification_outcome_heads')) {
      sawNotif = true
      const nRows = db.prepare(`
        SELECT notification_id, outcome FROM evaluation_notification_outcome_heads
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
        if (decided && isHoldoutMember(n.notification_id)) holdoutDecidedSamples += 1
      }
    }
    if (hasTable(db, 'evaluation_intake_evaluation_heads')) {
      sawNotif = true
      const ieRows = db.prepare(`
        SELECT eval_id, would_accept, outcome_kind FROM evaluation_intake_evaluation_heads
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
    return { sawNotif }
  })

  if (evalFromSqlite !== undefined) {
    tasksState = totalTasks > 0 || ownerCorrections > 0 || ownerWithdrawals > 0 ? 'data' : 'zero'
    suppliersState = supplierMap.size > 0 ? 'data' : 'zero'
    notificationsState = !evalFromSqlite.sawNotif
      ? (evaluation ? 'zero' : 'no-data')
      : notifTotal > 0 || wouldAcceptTotal > 0 || agreementDecided > 0 ? 'data' : 'zero'
  } else if (evaluation !== undefined && evaluation !== null) {
    tasksState = 'zero'
    suppliersState = 'zero'
    notificationsState = 'zero'

    if (scope !== undefined) {
      let queryMaxLimit = 100
      try {
        if (typeof evaluation['health'] === 'function') {
          const eh = rec((evaluation['health'] as () => unknown)())
          const configuredMax = int0(rec(eh['limits'])['maxQueryLimit'])
          if (configuredMax > 0) queryMaxLimit = Math.min(500, configuredMax)
        }
      } catch { /* keep safe default 100 */ }

      try {
        const queryTasksFn = evaluation['queryTasks'] as ((q: unknown) => unknown) | undefined
        const queryFn = evaluation['query'] as ((q: unknown) => unknown) | undefined

        // Query current and previous windows separately within maxQueryLimit (default 100)
        // so neither throws `invalid-input` nor starves the previous-window baseline.
        const projectedCur = typeof queryTasksFn === 'function'
          ? arr(queryTasksFn.call(evaluation, { scope, fromOccurredAt: fromAt, toOccurredAt: toAt, limit: queryMaxLimit }))
          : []
        const projectedPrev = typeof queryTasksFn === 'function' && fromAt > prevFromAt
          ? arr(queryTasksFn.call(evaluation, { scope, fromOccurredAt: prevFromAt, toOccurredAt: fromAt - 1, limit: queryMaxLimit }))
          : []
        const rawCur = typeof queryFn === 'function'
          ? arr(queryFn.call(evaluation, { scope, fromOccurredAt: fromAt, toOccurredAt: toAt, limit: queryMaxLimit }))
          : []
        const rawPrev = typeof queryFn === 'function' && fromAt > prevFromAt
          ? arr(queryFn.call(evaluation, { scope, fromOccurredAt: prevFromAt, toOccurredAt: fromAt - 1, limit: queryMaxLimit }))
          : []

        const projectedAll = [...projectedPrev, ...projectedCur]
        const rawOutcomesAll = [...rawPrev, ...rawCur]

        // Map outcome IDs -> canonical task subject keys from projected tasks and non-feedback outcomes first.
        const outcomeSubjectById = new Map<string, string>()
        for (const item of projectedAll) {
          const proj = rec(item)
          const skey = inferSubjectKeyFromStoredOutcome(proj, outcomeSubjectById)
          const id = typeof proj['id'] === 'string' ? proj['id'] : ''
          const projMeta = rec(proj['projection'])
          if (id !== '' && skey !== '') outcomeSubjectById.set(id, skey)
          for (const keyName of ['primaryOutcomeId', 'executionOutcomeId', 'objectiveOutcomeId', 'deliveryOutcomeId']) {
            const refId = projMeta[keyName]
            if (typeof refId === 'string' && refId !== '' && skey !== '') outcomeSubjectById.set(refId, skey)
          }
        }
        for (const item of rawOutcomesAll) {
          const out = rec(item)
          if (rec(out['source'])['kind'] === 'user-feedback') continue
          const id = typeof out['id'] === 'string' ? out['id'] : ''
          const skey = inferSubjectKeyFromStoredOutcome(out, outcomeSubjectById)
          if (id !== '' && skey !== '') outcomeSubjectById.set(id, skey)
        }

        const correctedCur = new Set<string>()
        const correctedPrev = new Set<string>()
        const correctedFirst = new Set<string>()
        const correctedSecond = new Set<string>()
        const withdrawnCur = new Set<string>()
        const subjectOutcomeCounts = new Map<string, { total: number; hadFailure: boolean }>()

        // Process oldest -> newest so a later withdrawal supersedes an earlier correction.
        const sortedRaw = [...rawOutcomesAll]
          .map(item => rec(item))
          .sort((a, b) => int0(a['occurredAt']) - int0(b['occurredAt']))

        for (const out of sortedRaw) {
          const occ = int0(out['occurredAt'])
          const skey = inferSubjectKeyFromStoredOutcome(out, outcomeSubjectById)
          const src = rec(out['source'])
          const objStatus = typeof out['objectiveStatus'] === 'string' ? out['objectiveStatus'] : ''
          const execStatus = typeof out['executionStatus'] === 'string' ? out['executionStatus'] : ''

          if (occ >= fromAt && skey !== '') {
            const stat = subjectOutcomeCounts.get(skey) ?? { total: 0, hadFailure: false }
            stat.total += 1
            if (execStatus === 'failed' || objStatus === 'not-achieved') stat.hadFailure = true
            subjectOutcomeCounts.set(skey, stat)
          }

          if (src['kind'] === 'user-feedback' && out['trust'] !== 'self-reported' && skey !== '') {
            if (objStatus === 'unknown') {
              if (occ >= fromAt) {
                withdrawnCur.add(skey)
                correctedCur.delete(skey)
                correctedFirst.delete(skey)
                correctedSecond.delete(skey)
              } else {
                correctedPrev.delete(skey)
              }
            } else if (objStatus === 'not-achieved' || objStatus === 'partial') {
              if (occ >= fromAt) {
                withdrawnCur.delete(skey)
                correctedCur.add(skey)
                if (occ < midAt) correctedFirst.add(skey)
                else correctedSecond.add(skey)
              } else {
                correctedPrev.add(skey)
              }
            }
          }

          if (occ >= fromAt && src['kind'] !== 'user-feedback') {
            const sup = extractSupplier(out)
            let b = supplierMap.get(sup)
            if (!b) {
              b = { runs: 0, costUsdMicros: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, latencies: [] }
              supplierMap.set(sup, b)
            }
            const m = rec(out['metrics'])
            b.runs += 1
            b.costUsdMicros += int0(m['costUsdMicros'])
            b.inputTokens += int0(m['inputTokens'])
            b.outputTokens += int0(m['outputTokens'])
            b.toolCalls += int0(m['toolCalls'])
            if (typeof m['latencyMs'] === 'number' && Number.isFinite(m['latencyMs']) && m['latencyMs'] >= 0) {
              b.latencies.push(Math.trunc(m['latencyMs']))
            }
          }
        }

        const seenProjectedKeys = new Set<string>()
        for (const item of projectedAll) {
          const proj = rec(item)
          const occ = int0(proj['occurredAt'])
          const skey = inferSubjectKeyFromStoredOutcome(proj, outcomeSubjectById)
          if (skey !== '') {
            if (seenProjectedKeys.has(skey)) continue
            seenProjectedKeys.add(skey)
          }
          if (occ < fromAt) {
            prevTotalTasks += 1
            continue
          }
          totalTasks += 1
          if (occ < midAt) firstHalfTasks += 1
          else secondHalfTasks += 1

          const projMeta = rec(proj['projection'])
          const taskInfo = rec(proj['task'])
          const isConflicted = projMeta['status'] === 'objective-conflict'
            || projMeta['objectiveConflicted'] === true
            || taskInfo['objectiveConflicted'] === true
            || proj['objectiveConflicted'] === true
          const obj = proj['objectiveStatus']
          if (isConflicted) {
            conflicted += 1
          } else if (skey === '' || !withdrawnCur.has(skey)) {
            if (obj === 'achieved') achieved += 1
            else if (obj === 'partial') partial += 1
            else if (obj === 'not-achieved') notAchieved += 1
          }
          const m = rec(proj['metrics'])
          const multi = skey !== '' ? subjectOutcomeCounts.get(skey) : undefined
          if (int0(m['retries']) > 0 || (multi !== undefined && multi.total > 1 && multi.hadFailure)) {
            reworkTasks += 1
          }
        }

        ownerCorrections = correctedCur.size
        ownerWithdrawals = withdrawnCur.size
        prevCorrections = correctedPrev.size
        firstHalfCorrections = correctedFirst.size
        secondHalfCorrections = correctedSecond.size
      } catch {
        // Keep zero fallback on unexpected scope error
      }

      // Notifications summary & holdout samples via read-only notificationOutcomeSummary & notificationOutcomeFeed
      try {
        const notifSumFn = evaluation['notificationOutcomeSummary'] as ((q: unknown) => unknown) | undefined
        if (typeof notifSumFn === 'function') {
          const ns = rec(notifSumFn.call(evaluation, { scope, fromNotifiedAt: fromAt, toNotifiedAt: toAt }))
          const outcomes = rec(ns['outcomes'])
          notifTotal = int0(ns['total'])
          notifAccepted = int0(outcomes['accepted'])
          notifReacted = int0(outcomes['reacted'])
          notifRejected = int0(outcomes['rejected'])
          notifIgnored = int0(outcomes['expired-unhandled'])
          notifFailed = int0(outcomes['failed'])
          notifDelivered = int0(outcomes['delivered']) + notifAccepted + notifReacted + notifRejected + notifIgnored
        }
        const notifFeedFn = evaluation['notificationOutcomeFeed'] as ((q: unknown) => unknown) | undefined
        if (typeof notifFeedFn === 'function') {
          let after: { scopeKey: string; watermark: number } | undefined
          for (let pageIdx = 0; pageIdx < 20; pageIdx += 1) {
            const page = rec(notifFeedFn.call(evaluation, {
              scope,
              ...(after === undefined ? {} : { after }),
              limit: 100,
            }))
            const feedItems = Array.isArray(page['items']) ? page['items'] : arr(page['entries'])
            for (const entry of feedItems) {
              const row = rec(entry)
              const recordBody = rec(row['record'])
              const at = int0(recordBody['notifiedAt'] ?? row['notifiedAt'] ?? row['occurredAt'] ?? row['recordedAt'])
              const out = recordBody['outcome'] ?? row['outcome']
              const nid = typeof row['notificationId'] === 'string' ? row['notificationId'] : ''
              const decided = out === 'accepted' || out === 'reacted' || out === 'rejected' || out === 'expired-unhandled'
              if (nid !== '' && at >= fromAt && at <= toAt && decided && isHoldoutMember(nid)) {
                holdoutDecidedSamples += 1
              }
            }
            const nextCursor = rec(page['nextCursor'])
            if (page['hasMore'] === true && typeof nextCursor['scopeKey'] === 'string' && typeof nextCursor['watermark'] === 'number') {
              after = { scopeKey: nextCursor['scopeKey'], watermark: nextCursor['watermark'] }
            } else {
              break
            }
          }
        }
      } catch {
        // Optional notification outcomes disabled
      }

      // Intake evaluation agreement summary & holdout samples
      try {
        const ieSumFn = evaluation['intakeEvaluationAgreementSummary'] as ((q: unknown) => unknown) | undefined
        if (typeof ieSumFn === 'function') {
          const ies = rec(ieSumFn.call(evaluation, { scope, fromEvaluatedAt: fromAt, toEvaluatedAt: toAt }))
          const tp = int0(ies['truePositive'])
          const fp = int0(ies['falsePositive'])
          wouldAcceptTotal = tp + fp
          agreementDecided = int0(ies['decided'])
          agreementAgreed = int0(ies['agreed'])
          agreementDisagreed = int0(ies['disagreed'])
        }
        const listIeFn = evaluation['listIntakeEvaluationAgreements'] as ((q: unknown) => unknown) | undefined
        if (typeof listIeFn === 'function') {
          let pendingWouldAccept = 0
          let cursor: { afterEvaluatedAt: number; afterEvalId: string } | undefined =
            fromAt > 0 ? { afterEvaluatedAt: fromAt - 1, afterEvalId: '' } : undefined
          for (let pageIdx = 0; pageIdx < 20; pageIdx += 1) {
            const res = listIeFn.call(evaluation, {
              scope,
              ...(cursor ? { afterEvaluatedAt: cursor.afterEvaluatedAt, afterEvalId: cursor.afterEvalId } : {}),
              limit: 100,
            })
            const pageObj = rec(res)
            const rows = Array.isArray(res) ? res : arr(pageObj['items'])
            let passedUpperBound = false
            for (const item of rows) {
              const row = rec(item)
              const evAt = typeof row['evaluatedAt'] === 'number' ? row['evaluatedAt'] : fromAt
              if (evAt < fromAt) continue
              if (evAt > toAt) {
                passedUpperBound = true
                break
              }
              const evalId = typeof row['evalId'] === 'string' ? row['evalId'] : ''
              const kind = row['outcomeKind']
              if (kind === 'pending' && row['wouldAccept'] === true) pendingWouldAccept += 1
              if (evalId !== '' && (kind === 'agreed' || kind === 'disagreed') && isHoldoutMember(evalId)) {
                holdoutDecidedSamples += 1
              }
            }
            const next = rec(pageObj['nextCursor'])
            if (!passedUpperBound && pageObj['hasMore'] === true && typeof next['afterEvaluatedAt'] === 'number' && typeof next['afterEvalId'] === 'string') {
              cursor = { afterEvaluatedAt: next['afterEvaluatedAt'], afterEvalId: next['afterEvalId'] }
            } else {
              break
            }
          }
          wouldAcceptTotal += pendingWouldAccept
        }
      } catch {
        // Optional intake evaluation agreement disabled
      }
    }

    if (totalTasks > 0 || ownerCorrections > 0 || ownerWithdrawals > 0) tasksState = 'data'
    if (supplierMap.size > 0) suppliersState = 'data'
    if (notifTotal > 0 || wouldAcceptTotal > 0 || agreementDecided > 0) notificationsState = 'data'
  }

  // Also check workItems intake evaluation ledger if Evaluation agreement table had 0 rows
  if (wouldAcceptTotal === 0) {
    const wiCount = withReadOnlySqlite(findLoaderDbPath(host, sqliteBoundary, '@dsh-ray/assistant-work-items'), sqliteBoundary, db => {
      if (!hasTable(db, 'work_item_intake_evaluation')) return undefined
      const row = db.prepare(`
        SELECT COUNT(*) AS n FROM work_item_intake_evaluation
        WHERE recorded_at >= ? AND recorded_at <= ? AND evaluation_level <> 'ignore'
      `).get(fromAt, toAt) as { n?: number } | undefined
      return row?.n ?? 0
    })
    if (wiCount !== undefined) {
      if (notificationsState === 'no-data') notificationsState = 'zero'
      wouldAcceptTotal += wiCount
      if (wouldAcceptTotal > 0) notificationsState = 'data'
    }
  }

  // 2. Memory & Prompt Exposure (personalMemory + assistantPreferenceLearning + assistantMemoryLearning)
  const personalMemory = host.get('personalMemory' as never) as Record<string, unknown> | undefined
  const prefLearning = host.get('assistantPreferenceLearning' as never) as Record<string, unknown> | undefined
  const memLearning = host.get('assistantMemoryLearning' as never) as Record<string, unknown> | undefined
  const memDbPath = findLoaderDbPath(host, sqliteBoundary, '@dsh-ray/personal-memory')
    ?? findLoaderDbPath(host, sqliteBoundary, '@dsh-ray/personal-assistant', 'personalMemory')
    ?? (sqliteBoundary.explicitHome && personalMemory ? join(sqliteBoundary.dshHome, 'personal-memory', 'memory.sqlite') : undefined)
  const prefDbPath = findLoaderDbPath(host, sqliteBoundary, '@dsh-ray/preference-learning')
    ?? (sqliteBoundary.explicitHome && prefLearning ? join(sqliteBoundary.dshHome, 'preference-learning', 'preferences.sqlite') : undefined)

  let memoryState: GrowthDataState = 'no-data'
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

  if (personalMemory || prefLearning || memLearning || memDbPath || prefDbPath) {
    let sawReadableMemOrPref = Boolean(personalMemory || prefLearning || memLearning)
    let fallbackAdoptedMemories = 0
    try {
      if (personalMemory && typeof personalMemory['health'] === 'function') {
        const mh = rec((personalMemory['health'] as () => unknown)())
        activeMemoriesTotal = int0(mh['activeRecords'])
      }
    } catch { /* ignore */ }
    try {
      if (memLearning && typeof memLearning['health'] === 'function') {
        const mlh = rec((memLearning['health'] as () => unknown)())
        const counts = rec(mlh['counts'])
        fallbackAdoptedMemories = int0(counts['adopted'])
      }
    } catch { /* ignore */ }
    try {
      if (prefLearning && typeof prefLearning['health'] === 'function') {
        const ph = rec((prefLearning['health'] as () => unknown)())
        activePreferenceOverlays = int0(ph['active'])
      }
    } catch { /* ignore */ }

    const memSqlite = withReadOnlySqlite(memDbPath, sqliteBoundary, db => {
      if (!hasTable(db, 'memory_records')) return undefined
      const active = (db.prepare("SELECT COUNT(*) AS n FROM memory_records WHERE status = 'active'").get() as { n: number }).n
      const created = db.prepare('SELECT status, provenance_json FROM memory_records WHERE created_at >= ? AND created_at <= ?')
        .all(fromAt, toAt) as Array<{ status: string; provenance_json: string }>
      let createdCount = 0
      let sourcedCount = 0
      for (const r of created) {
        createdCount += 1
        const p = r.provenance_json.trim()
        if (r.status === 'active' && p !== '' && p !== '{}' && p !== '[]' && p !== 'null') sourcedCount += 1
      }
      let removed = (db.prepare("SELECT COUNT(*) AS n FROM memory_records WHERE status = 'removed' AND updated_at >= ? AND updated_at <= ?")
        .get(fromAt, toAt) as { n: number }).n
      if (hasTable(db, 'memory_promotion_compensations')) {
        removed += (db.prepare('SELECT COUNT(*) AS n FROM memory_promotion_compensations WHERE compensated_at >= ? AND compensated_at <= ?')
          .get(fromAt, toAt) as { n: number }).n
      }
      return { active, createdCount, sourcedCount, removed }
    })
    if (memSqlite !== undefined) {
      sawReadableMemOrPref = true
      activeMemoriesTotal = memSqlite.active
      newMemories = memSqlite.createdCount
      sourcedMemories = memSqlite.sourcedCount
      withdrawnOrRemovedMemories = memSqlite.removed
    } else if (fallbackAdoptedMemories > 0) {
      sourcedMemories = fallbackAdoptedMemories
      newMemories = fallbackAdoptedMemories
    }

    const prefSqlite = withReadOnlySqlite(prefDbPath, sqliteBoundary, db => {
      if (hasTable(db, 'preference_hypotheses')) {
        activePreferenceOverlays = (db.prepare("SELECT COUNT(*) AS n FROM preference_hypotheses WHERE effect_state = 'active'").get() as { n: number }).n
      }
      const exp = hasTable(db, 'preference_exposures')
        ? (db.prepare("SELECT COUNT(*) AS n FROM preference_exposures WHERE state = 'bound' AND exposed_at >= ? AND exposed_at <= ?")
          .get(fromAt, toAt) as { n: number }).n
        : 0
      const hasExpCorr = hasTable(db, 'preference_exposure_corrections')
      const postCorr = hasExpCorr
        ? (db.prepare('SELECT COUNT(*) AS n FROM preference_exposure_corrections WHERE occurred_at >= ? AND occurred_at <= ?')
          .get(fromAt, toAt) as { n: number }).n
        : 0
      let preContra = 0
      let firstHalf = 0
      let secondHalf = 0
      if (hasTable(db, 'preference_signals')) {
        const postIds = hasExpCorr
          ? new Set((db.prepare('SELECT signal_id FROM preference_exposure_corrections').all() as Array<{ signal_id: string }>).map(r => r.signal_id))
          : new Set<string>()
        const sigs = db.prepare("SELECT id, occurred_at FROM preference_signals WHERE stance = 'contradict' AND actor_trust = 'owner-authenticated' AND occurred_at >= ? AND occurred_at <= ?")
          .all(fromAt, toAt) as Array<{ id: string; occurred_at: number }>
        for (const s of sigs) {
          if (s.occurred_at < midAt) firstHalf += 1
          else secondHalf += 1
          if (!postIds.has(s.id)) preContra += 1
        }
      }
      return { exp, postCorr, preContra, firstHalf, secondHalf }
    })
    if (prefSqlite !== undefined) {
      sawReadableMemOrPref = true
      promptExposures = prefSqlite.exp
      postExposureSameClassCorrections = prefSqlite.postCorr
      preExposureContradictions = prefSqlite.preContra
      firstHalfPrefContradictions = prefSqlite.firstHalf
      secondHalfPrefContradictions = prefSqlite.secondHalf
    }

    if (sawReadableMemOrPref) {
      memoryState = (newMemories > 0 || sourcedMemories > 0 || withdrawnOrRemovedMemories > 0 || promptExposures > 0 || postExposureSameClassCorrections > 0 || preExposureContradictions > 0 || activePreferenceOverlays > 0)
        ? 'data'
        : 'zero'
    }
  }

  // 3. Candidates, Verification & Adoption (prefer windowed read-only SQLite per lane, fallback to service health)
  const growthDriver = host.get('assistantGrowthDriver' as never) as Record<string, unknown> | undefined
  const controlPlane = host.get('pluginControlPlane' as never) as Record<string, unknown> | undefined
  const skills = host.get('assistantSkills' as never) as Record<string, unknown> | undefined
  const evolution = host.get('assistantEvolution' as never) as Record<string, unknown> | undefined
  const growthExperiments = host.get('assistantGrowthExperiments' as never) as Record<string, unknown> | undefined
  const cpDbPaths = findControlPlaneDbPaths(host, sqliteBoundary, profileName, controlPlane !== undefined)

  let candidatesState: GrowthDataState = 'no-data'
  let candGenerated = 0
  let candPassed = 0
  let candFailed = 0
  let candAdopted = 0
  let candRolledBack = 0

  if (memLearning || growthDriver || controlPlane || cpDbPaths.length > 0 || skills || prefLearning || evolution || growthExperiments) {
    let sawCandidateSource = Boolean(memLearning || growthDriver || controlPlane || skills || prefLearning || evolution || growthExperiments)

    // 3a. Memory Learning
    const mlSqlite = withReadOnlySqlite(findLoaderDbPath(host, sqliteBoundary, '@dsh-ray/assistant-memory-learning'), sqliteBoundary, db => {
      if (!hasTable(db, 'jobs')) return undefined
      const rows = (hasColumn(db, 'jobs', 'intent_json')
        ? db.prepare('SELECT state, intent_json FROM jobs').all()
        : db.prepare('SELECT state FROM jobs').all()) as Array<{ state: string; intent_json?: string }>
      let gen = 0, pass = 0, fail = 0, adopt = 0
      for (const r of rows) {
        const intent = parseJsonObject(r.intent_json)
        if (!inWindowOrUntimestamped(intent['createdAt'], fromAt, toAt)) continue
        gen += 1
        if (r.state === 'adopted') { pass += 1; adopt += 1 }
        else if (r.state === 'rejected' || r.state === 'failed') fail += 1
      }
      return { gen, pass, fail, adopt }
    })
    if (mlSqlite !== undefined) {
      sawCandidateSource = true
      candGenerated += mlSqlite.gen
      candPassed += mlSqlite.pass
      candFailed += mlSqlite.fail
      candAdopted += mlSqlite.adopt
    } else {
      try {
        if (memLearning && typeof memLearning['health'] === 'function') {
          const counts = rec(rec((memLearning['health'] as () => unknown)())['counts'])
          const adopted = int0(counts['adopted'])
          const rejected = int0(counts['rejected']) + int0(counts['failed'])
          const pending = int0(counts['pending']) + int0(counts['queued']) + int0(counts['running'])
          candGenerated += adopted + rejected + pending
          candPassed += adopted
          candAdopted += adopted
          candFailed += rejected
        }
      } catch { /* ignore */ }
    }

    // 3b. Growth Driver usage_jobs (valid states: queued, running, reviewed, failed, unknown, superseded)
    const gdSqlite = withReadOnlySqlite(findLoaderDbPath(host, sqliteBoundary, '@dsh-ray/assistant-growth-driver', 'usageLearning'), sqliteBoundary, db => {
      if (!hasTable(db, 'usage_jobs')) return undefined
      const rows = (hasColumn(db, 'usage_jobs', 'intent_json')
        ? db.prepare('SELECT state, intent_json FROM usage_jobs').all()
        : db.prepare('SELECT state FROM usage_jobs').all()) as Array<{ state: string; intent_json?: string }>
      let gen = 0, pass = 0, fail = 0
      for (const r of rows) {
        const intent = parseJsonObject(r.intent_json)
        if (!inWindowOrUntimestamped(intent['occurredAt'] ?? intent['createdAt'], fromAt, toAt)) continue
        gen += 1
        if (r.state === 'reviewed') pass += 1
        else if (r.state === 'failed') fail += 1
      }
      return { gen, pass, fail }
    })
    if (gdSqlite !== undefined) {
      sawCandidateSource = true
      candGenerated += gdSqlite.gen
      candPassed += gdSqlite.pass
      candFailed += gdSqlite.fail
    } else {
      try {
        if (growthDriver && typeof growthDriver['usageHealth'] === 'function') {
          const counts = rec(rec((growthDriver['usageHealth'] as () => unknown)())['counts'])
          const reviewed = int0(counts['reviewed'])
          const failed = int0(counts['failed'])
          const active = int0(counts['queued']) + int0(counts['running'])
          candGenerated += reviewed + failed + active
          candPassed += reviewed
          candFailed += failed
        }
      } catch { /* ignore */ }
    }

    // 3c. Plugin Control Plane (all control-plane ledgers: control.sqlite, creation-adoptions.sqlite, revision-adoptions.sqlite)
    const seenCpRealPaths = new Set<string>()
    let cpSqliteSaw = false
    for (const cpCandidate of cpDbPaths) {
      const res = withReadOnlySqlite(cpCandidate, sqliteBoundary, (db, realTarget) => {
        if (seenCpRealPaths.has(realTarget)) return undefined
        seenCpRealPaths.add(realTarget)
        let saw = false, gen = 0, pass = 0, fail = 0, adopt = 0, rb = 0
        if (hasTable(db, 'source_plans')) {
          saw = true
          const rows = db.prepare('SELECT status, checked_tree_digest FROM source_plans WHERE updated_at >= ? AND updated_at <= ?')
            .all(fromAt, toAt) as Array<{ status: string; checked_tree_digest: string | null }>
          for (const r of rows) {
            gen += 1
            if (r.status === 'local-checks-failed' || r.status === 'release-failed') fail += 1
            else if (r.checked_tree_digest !== null || r.status === 'release-complete' || r.status === 'ready-for-human-review') pass += 1
            if (r.status === 'release-complete') adopt += 1
          }
        }
        if (hasTable(db, 'activation_plans')) {
          saw = true
          const rows = db.prepare('SELECT status FROM activation_plans WHERE updated_at >= ? AND updated_at <= ?')
            .all(fromAt, toAt) as Array<{ status: string }>
          for (const r of rows) {
            gen += 1
            if (r.status === 'activated') { pass += 1; adopt += 1 }
            else if (r.status === 'rolled-back' || r.status === 'rollback-pending') rb += 1
          }
        }
        const hasRollbacksTable = hasTable(db, 'rollbacks')
        if (hasRollbacksTable && hasColumn(db, 'rollbacks', 'at')) {
          saw = true
          const rbRow = db.prepare('SELECT COUNT(*) AS n FROM rollbacks WHERE at >= ? AND at <= ?')
            .get(fromAt, toAt) as { n: number }
          rb += rbRow.n
        }
        if (hasTable(db, 'adoptions')) {
          saw = true
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
            const at = r.at ?? (typeof receipt['adoptedAt'] === 'number' ? receipt['adoptedAt'] : receipt['issuedAt'])
            if (!inWindowOrUntimestamped(at, fromAt, toAt)) continue
            if (r.status === 'active') adopt += 1
            else if (r.status === 'rejected') fail += 1
            else if (r.status === 'closed' && !hasRollbacksTable) rb += 1
          }
        }
        return saw ? { gen, pass, fail, adopt, rb } : undefined
      })
      if (res !== undefined) {
        cpSqliteSaw = true
        sawCandidateSource = true
        candGenerated += res.gen
        candPassed += res.pass
        candFailed += res.fail
        candAdopted += res.adopt
        candRolledBack += res.rb
      }
    }
    if (!cpSqliteSaw) {
      try {
        if (controlPlane && typeof controlPlane['health'] === 'function') {
          const cph = rec((controlPlane['health'] as () => unknown)())
          const ready = int0(cph['readyPlans'])
          const active = int0(cph['activeActivations']) + int0(cph['watchingActivations'])
          const failed = int0(cph['failed'])
          const regressed = int0(cph['closedRegressed']) + int0(cph['closedRetracted']) + int0(cph['rollbackPending'])
          candGenerated += ready + active + failed + regressed
          candPassed += ready + active
          candAdopted += active
          candFailed += failed
          candRolledBack += regressed
        }
      } catch { /* ignore */ }
    }

    // 3d. Skills
    const skSqlite = withReadOnlySqlite(findLoaderDbPath(host, sqliteBoundary, '@dsh-ray/assistant-skills'), sqliteBoundary, db => {
      let saw = false, gen = 0, pass = 0, fail = 0, adopt = 0, rb = 0
      if (hasTable(db, 'skill_candidates')) {
        saw = true
        if (hasColumn(db, 'skill_candidates', 'candidate_json')) {
          for (const r of db.prepare('SELECT candidate_json FROM skill_candidates').all() as Array<{ candidate_json: string }>) {
            const c = parseJsonObject(r.candidate_json)
            if (!inWindowOrUntimestamped(c['updatedAt'] ?? c['createdAt'], fromAt, toAt)) continue
            gen += 1
            if (c['state'] === 'rejected') fail += 1
          }
        } else {
          gen += (db.prepare('SELECT COUNT(*) AS n FROM skill_candidates').get() as { n: number }).n
        }
      }
      if (hasTable(db, 'skill_comparisons')) {
        saw = true
        for (const r of db.prepare('SELECT state, comparison_json FROM skill_comparisons').all() as Array<{ state: string; comparison_json: string }>) {
          if (r.state !== 'complete') continue
          const c = parseJsonObject(r.comparison_json)
          if (!inWindowOrUntimestamped(c['updatedAt'] ?? c['createdAt'], fromAt, toAt)) continue
          if (skillComparisonPassed(r.comparison_json)) pass += 1
          else fail += 1
        }
      }
      if (hasTable(db, 'skill_deployments')) {
        saw = true
        const rows = (hasColumn(db, 'skill_deployments', 'deployment_json')
          ? db.prepare('SELECT state, deployment_json FROM skill_deployments').all()
          : db.prepare('SELECT state FROM skill_deployments').all()) as Array<{ state: string; deployment_json?: string }>
        for (const r of rows) {
          const d = parseJsonObject(r.deployment_json)
          if (!inWindowOrUntimestamped(d['updatedAt'] ?? d['createdAt'], fromAt, toAt)) continue
          if (r.state === 'canary' || r.state === 'promoted') adopt += 1
          else if (r.state === 'rolled-back' || r.state === 'revoked') rb += 1
          else if (r.state === 'blocked') fail += 1
        }
      }
      return saw ? { gen, pass, fail, adopt, rb } : undefined
    })
    if (skSqlite !== undefined) {
      sawCandidateSource = true
      candGenerated += skSqlite.gen
      candPassed += skSqlite.pass
      candFailed += skSqlite.fail
      candAdopted += skSqlite.adopt
      candRolledBack += skSqlite.rb
    } else {
      try {
        if (skills && scope !== undefined) {
          const candsFn = skills['inspectOwnerSkillCandidates'] as ((s: unknown) => unknown) | undefined
          const activeFn = skills['inspectOwnerActiveSkills'] as ((s: unknown) => unknown) | undefined
          if (typeof candsFn === 'function') candGenerated += arr(candsFn.call(skills, scope)).length
          if (typeof activeFn === 'function') {
            const activeCount = arr(activeFn.call(skills, scope)).length
            candPassed += activeCount
            candAdopted += activeCount
          }
        }
      } catch { /* ignore */ }
    }

    // 3e. Preference transitions
    const prefTransSqlite = withReadOnlySqlite(prefDbPath, sqliteBoundary, db => {
      if (!hasTable(db, 'preference_transitions')) return undefined
      const rows = db.prepare('SELECT reason FROM preference_transitions WHERE occurred_at >= ? AND occurred_at <= ?')
        .all(fromAt, toAt) as Array<{ reason: string }>
      let gen = 0, pass = 0, fail = 0, adopt = 0, rb = 0
      for (const r of rows) {
        if (r.reason === 'created') gen += 1
        else if (r.reason === 'activated') { pass += 1; adopt += 1 }
        else if (r.reason === 'owner-rejected' || r.reason === 'contradicted') fail += 1
        else if (r.reason === 'regression' || r.reason === 'operator-request') rb += 1
      }
      return { gen, pass, fail, adopt, rb }
    })
    if (prefTransSqlite !== undefined) {
      sawCandidateSource = true
      candGenerated += prefTransSqlite.gen
      candPassed += prefTransSqlite.pass
      candFailed += prefTransSqlite.fail
      candAdopted += prefTransSqlite.adopt
      candRolledBack += prefTransSqlite.rb
    } else {
      try {
        if (prefLearning && typeof prefLearning['health'] === 'function') {
          const ph = rec((prefLearning['health'] as () => unknown)())
          candGenerated += int0(ph['hypotheses'])
          candAdopted += int0(ph['active'])
          candPassed += int0(ph['active'])
          candRolledBack += int0(ph['rolledBack'])
        }
      } catch { /* ignore */ }
    }

    // 3f. Evolution & Growth Experiments
    withReadOnlySqlite(findLoaderDbPath(host, sqliteBoundary, '@dsh-ray/assistant-evolution'), sqliteBoundary, db => {
      if (hasTable(db, 'evolution_proposals')) {
        sawCandidateSource = true
        for (const r of db.prepare('SELECT status FROM evolution_proposals WHERE updated_at >= ? AND updated_at <= ?')
          .all(fromAt, toAt) as Array<{ status: string }>) {
          candGenerated += 1
          if (r.status === 'approved') candPassed += 1
          else if (r.status === 'rejected') candFailed += 1
        }
      }
      if (hasTable(db, 'evolution_rules')) {
        sawCandidateSource = true
        candAdopted += (db.prepare('SELECT COUNT(*) AS n FROM evolution_rules WHERE adopted_at >= ? AND adopted_at <= ?')
          .get(fromAt, toAt) as { n: number }).n
      }
      if (hasTable(db, 'evolution_autonomous_rollbacks')) {
        sawCandidateSource = true
        candRolledBack += (db.prepare('SELECT COUNT(*) AS n FROM evolution_autonomous_rollbacks WHERE occurred_at >= ? AND occurred_at <= ?')
          .get(fromAt, toAt) as { n: number }).n
      }
    })
    withReadOnlySqlite(findLoaderDbPath(host, sqliteBoundary, '@dsh-ray/assistant-growth-experiments'), sqliteBoundary, db => {
      if (hasTable(db, 'workflow_candidates')) {
        sawCandidateSource = true
        for (const r of db.prepare('SELECT state FROM workflow_candidates WHERE updated_at >= ? AND updated_at <= ?')
          .all(fromAt, toAt) as Array<{ state: string }>) {
          candGenerated += 1
          if (r.state === 'ready' || r.state === 'promoted') candPassed += 1
          if (r.state === 'promoted') candAdopted += 1
          else if (r.state === 'rejected') candFailed += 1
          else if (r.state === 'rolled-back') candRolledBack += 1
        }
      }
    })

    if (sawCandidateSource) {
      candidatesState = (candGenerated > 0 || candPassed > 0 || candFailed > 0 || candAdopted > 0 || candRolledBack > 0)
        ? 'data'
        : 'zero'
    }
  }

  // Compute rates & trends
  const correctionRatePpm = ppm(ownerCorrections, totalTasks)
  const reworkRatePpm = ppm(reworkTasks, totalTasks)
  const withdrawalRatePpm = ppm(ownerWithdrawals, totalTasks)
  const previousCorrectionRatePpm = ppm(prevCorrections, prevTotalTasks)
  const firstHalfRate = ppm(firstHalfCorrections, firstHalfTasks)
  const secondHalfRate = ppm(secondHalfCorrections, secondHalfTasks)
  const baseRate = previousCorrectionRatePpm ?? firstHalfRate
  const curRate = previousCorrectionRatePpm !== null ? correctionRatePpm : secondHalfRate
  const correctionRateDeltaPpm = baseRate !== null && curRate !== null ? curRate - baseRate : null
  const trend: OwnerConsoleGrowthReport['tasks']['trend'] = correctionRateDeltaPpm === null
    ? 'insufficient-data'
    : correctionRateDeltaPpm < 0 ? 'improving' : correctionRateDeltaPpm > 0 ? 'regressing' : 'flat'

  const postExposureCorrectionRatePpm = ppm(postExposureSameClassCorrections, promptExposures)
  let sameClassCorrectionTrend: OwnerConsoleGrowthReport['memory']['sameClassCorrectionTrend'] = 'insufficient-data'
  if (promptExposures > 0 && (preExposureContradictions > 0 || postExposureSameClassCorrections > 0)) {
    if (preExposureContradictions === 0 && postExposureSameClassCorrections > 0) {
      sameClassCorrectionTrend = 'increased'
    } else if (postExposureSameClassCorrections === 0 && preExposureContradictions > 0) {
      sameClassCorrectionTrend = 'reduced'
    } else if (postExposureSameClassCorrections >= promptExposures) {
      sameClassCorrectionTrend = postExposureSameClassCorrections > preExposureContradictions ? 'increased' : 'unchanged'
    } else if (postExposureSameClassCorrections < preExposureContradictions) {
      sameClassCorrectionTrend = 'reduced'
    } else if (postExposureSameClassCorrections === preExposureContradictions) {
      sameClassCorrectionTrend = 'unchanged'
    } else {
      sameClassCorrectionTrend = 'increased'
    }
  } else if (firstHalfPrefContradictions + secondHalfPrefContradictions >= 2) {
    sameClassCorrectionTrend = secondHalfPrefContradictions < firstHalfPrefContradictions
      ? 'reduced'
      : secondHalfPrefContradictions === firstHalfPrefContradictions ? 'unchanged' : 'increased'
  }

  const suppliers: OwnerConsoleGrowthSupplier[] = [...supplierMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 32)
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
      })
    })
  const totalRuns = suppliers.reduce((acc, s) => acc + s.runs, 0)
  const totalCostUsdMicros = suppliers.reduce((acc, s) => acc + s.costUsdMicros, 0)

  const states = [tasksState, memoryState, candidatesState, notificationsState, suppliersState]
  const overallState: GrowthDataState = states.includes('data')
    ? 'data'
    : states.includes('zero') ? 'zero' : 'no-data'

  const authenticatedCorrections = ownerCorrections + preExposureContradictions + postExposureSameClassCorrections
  const windowSatisfied = sinceDays >= 14
  const correctionRateDropped = trend === 'improving' || sameClassCorrectionTrend === 'reduced'
  const gateStatus: OwnerConsoleGrowthReport['memoryLaneGate']['status'] = overallState === 'no-data'
    ? 'no-data'
    : conflicted > 0
      ? 'attention-needed'
      : windowSatisfied
        && authenticatedCorrections >= 10
        && sourcedMemories >= 5
        && promptExposures >= 5
        && correctionRateDropped
        ? 'passed'
        : 'collecting'

  return Object.freeze({
    protocol: 'owner-console/growth-report/v1',
    sinceDays,
    fromAt,
    toAt,
    ...(scope === undefined ? {} : { resolvedScope: scope }),
    overallState,
    cliCommand,
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
      agreementPpm: ppm(agreementAgreed, agreementDecided),
      holdoutDecidedSamples,
      looseningMinHoldoutSamples: DEFAULT_LOOSENING_MIN_HOLDOUT,
      looseningGateStatus: holdoutDecidedSamples >= DEFAULT_LOOSENING_MIN_HOLDOUT ? 'ready-for-review' : 'insufficient-samples',
    }),
    suppliers: Object.freeze({
      state: suppliersState,
      totalRuns,
      totalCostUsdMicros,
      suppliers: Object.freeze(suppliers),
    }),
    memoryLaneGate: Object.freeze({
      targetWindowDays: 14,
      windowSatisfied,
      authenticatedCorrections,
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
