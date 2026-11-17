import { existsSync } from 'node:fs'
import { chmod, cp, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseDocument } from 'yaml'
import { collectLiveDoctorReport, type LiveDoctorReport } from './doctor-live.ts'
import { withDshHomeLifecycleLock } from './home-lifecycle-lock.ts'
import { inspectBoundHostRuntime, prepareHostUpdatePlan, type BoundHostInspection, type InstallHostPorts } from './install-host.ts'
import { inspectLaunchdDefinition, inspectLoadedLaunchd } from './launchd-service.ts'
import { listProfilePlugins, listProfiles, profilesDirectory } from './paths.ts'
import { scanRunningProfiles } from './process-guard.ts'
import { detectFrozenOwner, runFrozenOwnerUpdate, type FrozenOwner, type ProgramUpdatePorts } from './program-update.ts'
import { defaultRunner, type CommandRunner } from './run.ts'
import {
  controlManagedService,
  inspectManagedService,
  managedServiceProcessIds,
  type ManagedServicePresence,
  type ServiceActionOutcome,
} from './services.ts'
import { version as CLI_VERSION } from './version.ts'

export type UpgradeAction = 'check' | 'dry-run' | 'apply'
export type UpgradeMode = 'frozen-linux-systemd' | 'macos-launchd' | 'standard-local'
export type LedgerStatus = 'absent' | 'empty' | 'non-empty' | 'corrupt'
export type BoundHostStatus = 'ready' | 'missing' | 'corrupt' | 'stale' | 'unreadable'

export interface ProfilePackageSummary {
  readonly profile: string
  readonly installedVersions: Record<string, string>
  readonly minVersion?: string
  readonly maxVersion?: string
  readonly installKinds: readonly ('npm' | 'local')[]
}

export interface ProfileLedgerReadiness {
  readonly profile: string
  readonly ledgerReady: boolean
  readonly creationLedgerStatus: LedgerStatus
  readonly revisionLedgerStatus: LedgerStatus
  readonly issues: readonly string[]
}

export interface UpgradeReport {
  readonly schemaVersion: 1
  readonly command: 'upgrade'
  readonly action: UpgradeAction
  readonly ok: boolean
  readonly ready: boolean
  readonly dshHome: string
  readonly selectedProfile?: string
  readonly mode: UpgradeMode
  readonly frozenSystemd: {
    readonly detected: boolean
    readonly profiles: readonly string[]
    readonly reason?: string
    readonly targetDshVersion?: string
  }
  readonly packages: {
    readonly cliPackageVersion: string
    readonly installedEnhancedVersion?: string
    readonly targetEnhancedVersion?: string
    readonly upgradeAvailable: boolean
    readonly boundHost: {
      readonly status: BoundHostStatus
      readonly installedVersion?: string
      readonly targetVersion?: string
      readonly dshPath?: string
      readonly upgradeAvailable: boolean
      readonly error?: string
    }
    readonly profiles: readonly ProfilePackageSummary[]
  }
  readonly registry: {
    readonly url: string
    readonly checked: boolean
    readonly status: 'ok' | 'unavailable' | 'skipped'
    readonly latestEnhancedVersion?: string
    readonly latestDshHostVersion?: string
    readonly error?: string
  }
  readonly readiness: {
    readonly ok: boolean
    readonly bindingOk: boolean
    readonly ledgersOk: boolean
    readonly profiles: readonly ProfileLedgerReadiness[]
    readonly blockedReasons: readonly string[]
  }
  readonly plan: {
    readonly canExecute: boolean
    readonly steps: readonly string[]
    readonly rollbackSupported: boolean
    readonly backupFiles: readonly string[]
  }
  readonly execution?: {
    readonly executed: boolean
    readonly dryRun: boolean
    readonly backupDir?: string
    readonly delegatedScript?: string
    readonly healthCheckPassed?: boolean
    readonly rolledBack: boolean
    readonly rollbackSucceeded?: boolean
    readonly error?: string
  }
}

export interface UpgradeOptions {
  readonly dshHome: string
  readonly profile?: string
  readonly action: UpgradeAction
  readonly registryUrl?: string
  readonly dshVersion?: string
  readonly targetVersion?: string
  readonly confirmDshHomeStopped?: boolean
  readonly platform?: NodeJS.Platform
  readonly osHome?: string
  readonly env?: NodeJS.ProcessEnv
}

export interface UpgradeHealthResult {
  readonly ok: boolean
  readonly error?: string
  readonly report?: LiveDoctorReport
}

export interface UpgradeDeps {
  readonly fetch?: typeof globalThis.fetch
  readonly fetchTimeoutMs?: number
  readonly runner?: CommandRunner
  readonly detectFrozenOwner?: (dshHome: string) => Promise<FrozenOwner | undefined>
  readonly runFrozenOwnerUpdate?: (owner: FrozenOwner, options: { dryRun: boolean; dshVersion?: string }, ports?: ProgramUpdatePorts) => Promise<number>
  readonly programUpdatePorts?: ProgramUpdatePorts
  readonly inspectBoundHost?: (dshHome: string, ports?: InstallHostPorts) => Promise<BoundHostInspection>
  readonly prepareHostUpdatePlan?: typeof prepareHostUpdatePlan
  readonly installHostPorts?: InstallHostPorts
  readonly upgradeHost?: (input: { dshHome: string; targetVersion: string }) => Promise<void>
  readonly upgradeProfilePackages?: (input: {
    dshHome: string
    profile: string
    targetVersion: string
    registryUrl: string
    npmPlugins: readonly string[]
    runner: CommandRunner
  }) => Promise<void> | void
  readonly verifyHealth?: (input: {
    dshHome: string
    profile?: string
    profiles: readonly string[]
    runner: CommandRunner
    platform: NodeJS.Platform
    osHome: string
    env: NodeJS.ProcessEnv
  }) => Promise<UpgradeHealthResult>
  readonly controlService?: (
    platform: NodeJS.Platform,
    home: string,
    profile: string,
    action: 'start' | 'stop' | 'restart',
    runner: CommandRunner,
    dryRun: boolean,
    dshHome: string,
  ) => Promise<ServiceActionOutcome>
  readonly inspectService?: (
    platform: NodeJS.Platform,
    home: string,
    profile: string,
    dshHome?: string,
    runner?: CommandRunner,
  ) => Promise<ManagedServicePresence>
  readonly isServiceRunning?: (
    platform: NodeJS.Platform,
    osHome: string,
    dshHome: string,
    profile: string,
    runner: CommandRunner,
  ) => Promise<boolean>
  readonly scanProcesses?: typeof scanRunningProfiles
}

const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org'
const REGISTRY_TIMEOUT_MS = 4_000
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u
const FROZEN_DSH_SELECTOR = '0.2.2-rc.3'

const CREATION_ROW_TABLES = [
  'source_creation_verifications',
  'source_prepared_artifacts',
  'source_adoptions',
  'adoptions',
  'calls',
  'source_archives',
  'verifications',
  'source_plans',
  'source_jobs',
] as const

const REVISION_ROW_TABLES = [
  'source_revision_verifications',
  'source_revision_sources',
  'source_revision_regressions',
  'source_revision_benefit_outcomes',
  'source_release_dispatches',
  'source_release_receipts',
  'reviews',
] as const

export function validateRegistryUrl(rawUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error(`无效的 registry URL：${rawUrl}`)
  }
  if (parsed.username || parsed.password) {
    throw new Error('registry URL 不允许包含内嵌凭据')
  }
  const host = parsed.hostname.toLowerCase()
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw new Error(`registry URL 必须使用 https（或本机回环 http）：${rawUrl}`)
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/u, '')
}

export function compareSemver(left: string, right: string): number | undefined {
  const a = SEMVER_RE.exec(left.trim())
  const b = SEMVER_RE.exec(right.trim())
  if (!a || !b) return undefined
  for (let index = 1; index <= 3; index++) {
    const diff = Number(a[index]) - Number(b[index])
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  const preA = a[4]
  const preB = b[4]
  if (preA === undefined && preB === undefined) return 0
  if (preA === undefined) return 1
  if (preB === undefined) return -1
  const partsA = preA.split('.')
  const partsB = preB.split('.')
  const maxLen = Math.max(partsA.length, partsB.length)
  for (let idx = 0; idx < maxLen; idx++) {
    const pA = partsA[idx]
    const pB = partsB[idx]
    if (pA === undefined) return -1
    if (pB === undefined) return 1
    const numA = /^[0-9]+$/u.test(pA) ? Number(pA) : undefined
    const numB = /^[0-9]+$/u.test(pB) ? Number(pB) : undefined
    if (numA !== undefined && numB !== undefined) {
      if (numA !== numB) return numA > numB ? 1 : -1
    } else if (numA !== undefined) {
      return -1
    } else if (numB !== undefined) {
      return 1
    } else if (pA !== pB) {
      return pA > pB ? 1 : -1
    }
  }
  return 0
}

function semverIsNewer(candidate: string | undefined, current: string | undefined): boolean {
  if (!candidate || !current) return false
  const cmp = compareSemver(candidate, current)
  return cmp !== undefined && cmp > 0
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

async function readProfilePatchText(dshHome: string, profile: string): Promise<{ exists: boolean; text?: string; error?: string }> {
  const patchPath = join(profilesDirectory(dshHome), profile, 'cordis.patch.yml')
  try {
    const st = await lstat(patchPath)
    if (!st.isFile() || st.isSymbolicLink()) {
      return { exists: true, error: `cordis.patch.yml 非普通文件：${patchPath}` }
    }
    return { exists: true, text: await readFile(patchPath, 'utf8') }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false }
    return { exists: true, error: `读取 cordis.patch.yml 失败：${String(error)}` }
  }
}

function extractConfiguredDbPaths(patchText: string): string[] {
  const doc = parseDocument(patchText, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
  })
  if (doc.errors.length > 0) {
    throw new Error(`cordis.patch.yml YAML 语法错误：${doc.errors[0]!.message}`)
  }
  const value = doc.toJS()
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) throw new Error('cordis.patch.yml 根结构必须为序列')
  const paths = new Set<string>()
  const collect = (node: unknown, depth: number) => {
    if (depth > 6 || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) collect(item, depth + 1)
      return
    }
    const obj = node as Record<string, unknown>
    if (typeof obj.databasePath === 'string' && !obj.databasePath.includes('dshHomePath(')) {
      paths.add(obj.databasePath)
    }
    for (const child of Object.values(obj)) collect(child, depth + 1)
  }
  for (const row of value) {
    const obj = asObject(row)
    if (!obj) continue
    if (obj.id === 'dsh-enhanced-plugin-control-plane' || obj.id === 'dsh-enhanced-assistant-verifier') {
      collect(obj.config, 0)
    }
  }
  return [...paths]
}

function candidateLedgerPaths(dshHome: string, profile: string, configuredPaths: readonly string[]): string[] {
  const paths = new Set<string>(configuredPaths)
  const defaults = [
    join(dshHome, 'plugin-control-plane', `${profile}.sqlite`),
    join(dshHome, 'plugin-control-plane', 'state.sqlite'),
    join(dshHome, 'plugin-control-plane', `${profile}-creation-adoptions.sqlite`),
    join(dshHome, 'plugin-control-plane', `${profile}-revision-adoptions.sqlite`),
    join(dshHome, 'assistant-verifier', `${profile}.sqlite`),
    join(dshHome, 'assistant-verifier', 'verification.sqlite'),
    join(dshHome, 'assistant-verifier', 'verification.sqlite.creation-reviews'),
    join(dshHome, 'assistant-verifier', `${profile}.sqlite.creation-reviews`),
    join(dshHome, 'assistant-verifier', `${profile}-creation-reviews.sqlite`),
    join(dshHome, 'assistant-verifier', 'source-reviews.sqlite'),
    join(dshHome, 'assistant-verifier', `${profile}-source-reviews.sqlite`),
  ]
  for (const candidate of defaults) {
    paths.add(candidate)
    paths.add(`${candidate}.creation-reviews`)
    paths.add(`${candidate}.source-reviews`)
  }
  return [...paths]
}

function tableCount(db: DatabaseSync, tableName: string, whereClause = ''): number | undefined {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(tableName)
  if (!exists) return undefined
  const sql = whereClause ? `SELECT COUNT(*) AS n FROM "${tableName}" WHERE ${whereClause}` : `SELECT COUNT(*) AS n FROM "${tableName}"`
  const row = db.prepare(sql).get() as { n?: unknown } | undefined
  return typeof row?.n === 'number' ? row.n : 0
}

function mergeLedgerStatus(current: LedgerStatus, next: LedgerStatus): LedgerStatus {
  const rank: Record<LedgerStatus, number> = { absent: 0, empty: 1, 'non-empty': 2, corrupt: 3 }
  return rank[next] > rank[current] ? next : current
}

async function inspectProfileLedgerReadiness(dshHome: string, profile: string): Promise<ProfileLedgerReadiness> {
  const issues: string[] = []
  let creationLedgerStatus: LedgerStatus = 'absent'
  let revisionLedgerStatus: LedgerStatus = 'absent'

  const patch = await readProfilePatchText(dshHome, profile)
  let configuredDbPaths: string[] = []
  if (patch.error) {
    issues.push(patch.error)
  } else if (patch.text !== undefined) {
    try {
      configuredDbPaths = extractConfiguredDbPaths(patch.text)
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error))
    }
  }

  for (const dbPath of candidateLedgerPaths(dshHome, profile, configuredDbPaths)) {
    let st
    try {
      st = await lstat(dbPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      issues.push(`无法访问账本 ${dbPath}：${String(error)}`)
      creationLedgerStatus = mergeLedgerStatus(creationLedgerStatus, 'corrupt')
      continue
    }
    if (!st.isFile() || st.isSymbolicLink()) {
      issues.push(`账本路径非普通文件：${dbPath}`)
      creationLedgerStatus = mergeLedgerStatus(creationLedgerStatus, 'corrupt')
      continue
    }
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(dbPath, { readOnly: true })
      const integrity = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined
      if (!integrity || Object.values(integrity)[0] !== 'ok') {
        throw new Error('PRAGMA quick_check failed')
      }

      let sawCreationTable = false
      let hasCreationRows = false
      for (const table of CREATION_ROW_TABLES) {
        const count = tableCount(db, table)
        if (count !== undefined) {
          sawCreationTable = true
          if (count > 0) hasCreationRows = true
        }
      }
      const creationGrantCount = tableCount(db, 'grants')
      if (creationGrantCount !== undefined && tableCount(db, 'verifications') !== undefined) {
        sawCreationTable = true
        if (creationGrantCount > 0) hasCreationRows = true
      }
      if (sawCreationTable) {
        creationLedgerStatus = mergeLedgerStatus(creationLedgerStatus, hasCreationRows ? 'non-empty' : 'empty')
        if (hasCreationRows) {
          issues.push(`检测到非空 creation 账本（暂不支持自动迁移）：${dbPath}`)
        }
      }

      let sawRevisionTable = false
      let hasRevisionRows = false
      for (const table of REVISION_ROW_TABLES) {
        const count = tableCount(db, table)
        if (count !== undefined) {
          sawRevisionTable = true
          if (count > 0) hasRevisionRows = true
        }
      }
      const revGrantsUsed = tableCount(db, 'source_revision_grants', 'revisions > 0')
      if (revGrantsUsed !== undefined) {
        sawRevisionTable = true
        if (revGrantsUsed > 0) hasRevisionRows = true
      }
      const srcGrantUsed = tableCount(db, 'grants', 'used > 0')
      if (srcGrantUsed !== undefined && tableCount(db, 'reviews') !== undefined) {
        sawRevisionTable = true
        if (srcGrantUsed > 0) hasRevisionRows = true
      }
      if (sawRevisionTable) {
        revisionLedgerStatus = mergeLedgerStatus(revisionLedgerStatus, hasRevisionRows ? 'non-empty' : 'empty')
        if (hasRevisionRows) {
          issues.push(`检测到非空 revision 账本（暂不支持自动迁移）：${dbPath}`)
        }
      }
    } catch (error) {
      issues.push(`账本数据库损坏或不可读（${dbPath}）：${error instanceof Error ? error.message : String(error)}`)
      creationLedgerStatus = mergeLedgerStatus(creationLedgerStatus, 'corrupt')
      revisionLedgerStatus = mergeLedgerStatus(revisionLedgerStatus, 'corrupt')
    } finally {
      try { db?.close() } catch { /* ignore close errors */ }
    }
  }

  const ledgerReady = issues.length === 0
    && creationLedgerStatus !== 'non-empty'
    && creationLedgerStatus !== 'corrupt'
    && revisionLedgerStatus !== 'non-empty'
    && revisionLedgerStatus !== 'corrupt'

  return {
    profile,
    ledgerReady,
    creationLedgerStatus,
    revisionLedgerStatus,
    issues,
  }
}

async function inspectProfilePackages(dshHome: string, profile: string): Promise<ProfilePackageSummary> {
  const plugins = await listProfilePlugins(dshHome, profile)
  const installedVersions: Record<string, string> = {}
  const kinds = new Set<'npm' | 'local'>()
  const scopeDir = join(profilesDirectory(dshHome), profile, 'node_modules', '@dsh-enhanced')
  for (const plugin of plugins) {
    kinds.add(plugin.kind)
    const slug = plugin.name.replace('@dsh-enhanced/', '')
    try {
      const pkgText = await readFile(join(scopeDir, slug, 'package.json'), 'utf8')
      const pkg = JSON.parse(pkgText) as { version?: unknown }
      if (typeof pkg.version === 'string' && pkg.version.trim().length > 0) {
        installedVersions[plugin.name] = pkg.version.trim()
      }
    } catch {
      // Unreadable package manifest leaves version absent for that plugin.
    }
  }
  const versions = Object.values(installedVersions).sort((a, b) => compareSemver(a, b) ?? a.localeCompare(b))
  return {
    profile,
    installedVersions,
    ...(versions.length > 0 ? { minVersion: versions[0], maxVersion: versions[versions.length - 1] } : {}),
    installKinds: [...kinds].sort(),
  }
}

async function checkBoundHostFileIntegrity(dshHome: string): Promise<{ status: BoundHostStatus; error?: string }> {
  const bindingPath = join(dshHome, '.dsh-rsi-host.json')
  try {
    const meta = await lstat(bindingPath)
    if (!meta.isFile() || meta.isSymbolicLink()) {
      return { status: 'corrupt', error: 'Host 绑定文件不是普通文件' }
    }
    const raw = await readFile(bindingPath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
      || parsed.schemaVersion !== 1
      || typeof parsed.version !== 'string' || parsed.version.trim().length === 0
      || typeof parsed.cacheRoot !== 'string' || parsed.cacheRoot.trim().length === 0
      || typeof parsed.receiptDigest !== 'string' || parsed.receiptDigest.trim().length === 0) {
      return { status: 'corrupt', error: 'Host 绑定文件结构缺失或字段非法' }
    }
    return { status: 'ready' }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { status: 'missing' }
    if (error instanceof SyntaxError) return { status: 'corrupt', error: `Host 绑定 JSON 损坏：${error.message}` }
    return { status: 'unreadable', error: `无法读取 Host 绑定：${error instanceof Error ? error.message : String(error)}` }
  }
}

async function fetchNpmLatestVersion(
  fetchImpl: typeof globalThis.fetch,
  registryUrl: string,
  packageName: string,
  timeoutMs: number,
): Promise<{ ok: true; latest?: string } | { ok: false; error: string }> {
  const slug = packageName.startsWith('@')
    ? `@${encodeURIComponent(packageName.slice(1)).replace('%2F', '/')}`
    : encodeURIComponent(packageName)
  const url = `${registryUrl}/${slug}`
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/vnd.npm.install-v1+json, application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status} (${packageName})` }
    }
    const payload = await response.json() as { 'dist-tags'?: { latest?: unknown } }
    const latest = payload?.['dist-tags']?.latest
    if (typeof latest !== 'string' || !SEMVER_RE.test(latest.trim())) {
      return { ok: false, error: `registry 返回的 ${packageName} latest 版本无效` }
    }
    return { ok: true, latest: latest.trim() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function defaultUpgradeProfilePackages(input: {
  dshHome: string
  profile: string
  targetVersion: string
  registryUrl: string
  npmPlugins: readonly string[]
  runner: CommandRunner
}): Promise<void> {
  if (input.npmPlugins.length === 0) return
  const profileDir = join(profilesDirectory(input.dshHome), input.profile)
  const specs = input.npmPlugins.map(pkg => `${pkg}@${input.targetVersion}`)
  const res = input.runner('npm', [
    'install',
    '--prefix', profileDir,
    '--no-audit',
    '--no-fund',
    '--ignore-scripts',
    '--registry', input.registryUrl,
    ...specs,
  ])
  if (res.status !== 0) {
    throw new Error(`profile ${input.profile} npm 升级失败（退出码 ${res.status}）：${res.stderr.trim() || res.stdout.trim()}`)
  }
}

async function defaultUpgradeHost(input: {
  dshHome: string
  targetVersion: string
}, ports?: InstallHostPorts): Promise<void> {
  const plan = await prepareHostUpdatePlan({ dshHome: input.dshHome, selector: input.targetVersion }, ports)
  if (plan.status === 'current') return
  const tempPath = `${plan.bindingPath}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(tempPath, plan.candidateBindingSource, { encoding: 'utf8', mode: 0o600 })
    await rename(tempPath, plan.bindingPath)
  } catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }
}

async function defaultVerifyHealth(input: {
  dshHome: string
  profile?: string
  profiles: readonly string[]
  runner: CommandRunner
  platform: NodeJS.Platform
  osHome: string
  env: NodeJS.ProcessEnv
}): Promise<UpgradeHealthResult> {
  const report = await collectLiveDoctorReport({
    dshHome: input.dshHome,
    ...(input.profile ? { profile: input.profile } : {}),
    platform: input.platform,
    home: input.osHome,
    env: input.env,
    runner: input.runner,
  })
  if (!report.ok) {
    const fails = report.checks.filter(c => c.status === 'fail').map(c => `${c.id}: ${c.summary}`).join('；')
    return { ok: false, error: fails || 'dsh-rsi doctor 检查未通过', report }
  }
  for (const prof of report.profiles) {
    if (!prof.configDumpOk) {
      return { ok: false, error: `profile ${prof.profile} 配置转储失败：${prof.configDumpError ?? 'unknown'}`, report }
    }
    if (prof.autonomyReadiness?.checked && !prof.autonomyReadiness.ok) {
      return { ok: false, error: `profile ${prof.profile} autonomy readiness 未就绪：${prof.autonomyReadiness.summary}`, report }
    }
  }
  return { ok: true, report }
}

interface ProfileBackupRecord {
  readonly profile: string
  readonly profileDir: string
  readonly backupDir: string
  readonly files: readonly string[]
  readonly hasEnhancedModules: boolean
}

async function copyIfRegularFile(src: string, dst: string): Promise<boolean> {
  try {
    const meta = await lstat(src)
    if (!meta.isFile() || meta.isSymbolicLink()) return false
    await cp(src, dst, { force: true })
    await chmod(dst, meta.mode & 0o777)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function createUpgradeBackup(dshHome: string, profiles: readonly string[]): Promise<{
  backupDir: string
  hadHostBinding: boolean
  profileBackups: ProfileBackupRecord[]
  backupFiles: string[]
}> {
  const stamp = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}`
  const backupDir = join(dshHome, '.dsh-rsi-upgrade-backups', stamp)
  await mkdir(backupDir, { recursive: true, mode: 0o700 })

  const backupFiles: string[] = []
  const hostBindingSrc = join(dshHome, '.dsh-rsi-host.json')
  const hostBindingDst = join(backupDir, '.dsh-rsi-host.json')
  const hadHostBinding = await copyIfRegularFile(hostBindingSrc, hostBindingDst)
  if (hadHostBinding) backupFiles.push(hostBindingSrc)

  const profileBackups: ProfileBackupRecord[] = []
  for (const profile of profiles) {
    const profileDir = join(profilesDirectory(dshHome), profile)
    const profBackupDir = join(backupDir, 'profiles', profile)
    await mkdir(profBackupDir, { recursive: true, mode: 0o700 })
    const backedFiles: string[] = []
    for (const fileName of ['cordis.patch.yml', 'package.json', 'pnpm-lock.yaml', 'package-lock.json']) {
      const src = join(profileDir, fileName)
      const dst = join(profBackupDir, fileName)
      if (await copyIfRegularFile(src, dst)) {
        backedFiles.push(fileName)
        backupFiles.push(src)
      }
    }
    const enhancedDir = join(profileDir, 'node_modules', '@dsh-enhanced')
    let hasEnhancedModules = false
    try {
      const meta = await lstat(enhancedDir)
      if (meta.isDirectory()) {
        await cp(enhancedDir, join(profBackupDir, '@dsh-enhanced'), {
          recursive: true,
          force: true,
          verbatimSymlinks: true,
        })
        hasEnhancedModules = true
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    profileBackups.push({ profile, profileDir, backupDir: profBackupDir, files: backedFiles, hasEnhancedModules })
  }

  return { backupDir, hadHostBinding, profileBackups, backupFiles }
}

async function restoreUpgradeBackup(
  dshHome: string,
  backup: Awaited<ReturnType<typeof createUpgradeBackup>>,
): Promise<boolean> {
  try {
    const hostBindingDst = join(dshHome, '.dsh-rsi-host.json')
    if (backup.hadHostBinding) {
      const raw = await readFile(join(backup.backupDir, '.dsh-rsi-host.json'))
      const tmp = `${hostBindingDst}.rollback-${process.pid}`
      await writeFile(tmp, raw, { mode: 0o600 })
      await rename(tmp, hostBindingDst)
    } else {
      await rm(hostBindingDst, { force: true })
    }

    for (const item of backup.profileBackups) {
      for (const fileName of ['cordis.patch.yml', 'package.json', 'pnpm-lock.yaml', 'package-lock.json']) {
        const src = join(item.backupDir, fileName)
        const dst = join(item.profileDir, fileName)
        if (item.files.includes(fileName)) {
          await cp(src, dst, { force: true })
        } else {
          await rm(dst, { force: true })
        }
      }
      const enhancedDst = join(item.profileDir, 'node_modules', '@dsh-enhanced')
      await rm(enhancedDst, { recursive: true, force: true })
      if (item.hasEnhancedModules) {
        await mkdir(join(item.profileDir, 'node_modules'), { recursive: true })
        await cp(join(item.backupDir, '@dsh-enhanced'), enhancedDst, {
          recursive: true,
          force: true,
          verbatimSymlinks: true,
        })
      }
    }
    return true
  } catch {
    return false
  }
}

/**
 * Inspect upgrade readiness, compare installed & registry versions, and execute
 * frozen-systemd or transactional local/launchd upgrades with automatic rollback.
 */
export async function runUpgrade(
  options: UpgradeOptions,
  deps: UpgradeDeps = {},
): Promise<{ report: UpgradeReport; exitCode: number }> {
  const platform = options.platform ?? process.platform
  const osHome = options.osHome ?? homedir()
  const env = options.env ?? process.env
  const runner = deps.runner ?? defaultRunner
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const timeoutMs = deps.fetchTimeoutMs ?? REGISTRY_TIMEOUT_MS
  const detectFrozen = deps.detectFrozenOwner ?? detectFrozenOwner
  const runFrozen = deps.runFrozenOwnerUpdate ?? runFrozenOwnerUpdate
  const inspectHost = deps.inspectBoundHost ?? inspectBoundHostRuntime
  const upgradeHostFn = deps.upgradeHost
    ?? ((input: { dshHome: string; targetVersion: string }) => defaultUpgradeHost(input, deps.installHostPorts))
  const upgradeProfileFn = deps.upgradeProfilePackages ?? defaultUpgradeProfilePackages
  const verifyHealthFn = deps.verifyHealth ?? defaultVerifyHealth
  const controlServiceFn = deps.controlService ?? controlManagedService
  const inspectServiceFn = deps.inspectService ?? inspectManagedService
  const scanProcessesFn = deps.scanProcesses ?? scanRunningProfiles

  let canonicalHome = options.dshHome
  if (existsSync(options.dshHome)) {
    try {
      canonicalHome = await realpath(options.dshHome)
    } catch {
      canonicalHome = options.dshHome
    }
  }

  const registryUrl = validateRegistryUrl(options.registryUrl ?? env.npm_config_registry ?? DEFAULT_REGISTRY_URL)
  const blockedReasons: string[] = []

  // 1. Detect frozen Linux systemd owner mode cleanly.
  let frozenOwner: FrozenOwner | undefined
  let frozenError: string | undefined
  try {
    frozenOwner = await detectFrozen(canonicalHome)
  } catch (error) {
    frozenError = error instanceof Error ? error.message : String(error)
    blockedReasons.push(frozenError)
  }

  const discoveredProfiles = await listProfiles(canonicalHome)
  let targetProfiles = discoveredProfiles
  if (options.profile !== undefined) {
    if (!discoveredProfiles.includes(options.profile)) {
      blockedReasons.push(`指定 profile 不存在：${options.profile}`)
      targetProfiles = []
    } else {
      targetProfiles = [options.profile]
    }
  }
  if (frozenOwner && options.profile !== undefined && options.profile !== frozenOwner.profile) {
    blockedReasons.push(`frozen systemd profile 固定为 ${frozenOwner.profile}，不可选择 ${options.profile}`)
  }

  let mode: UpgradeMode = 'standard-local'
  if (frozenOwner) {
    mode = 'frozen-linux-systemd'
  } else if (platform === 'darwin') {
    for (const profile of targetProfiles) {
      const launchdDef = await inspectLaunchdDefinition(osHome, canonicalHome, profile, runner)
      if (launchdDef.exists) {
        mode = 'macos-launchd'
        break
      }
    }
  }

  // 2. Inspect .dsh-rsi-host.json binding integrity.
  const fileIntegrity = await checkBoundHostFileIntegrity(canonicalHome)
  let boundHostStatus: BoundHostStatus = fileIntegrity.status
  let boundHostVersion: string | undefined
  let boundHostPath: string | undefined
  let boundHostError: string | undefined = fileIntegrity.error

  if (fileIntegrity.status === 'ready') {
    try {
      const inspected = await inspectHost(canonicalHome, deps.installHostPorts)
      if (inspected.status === 'ready') {
        boundHostStatus = 'ready'
        boundHostVersion = inspected.version
        boundHostPath = inspected.dshPath
      } else if (inspected.status === 'missing') {
        boundHostStatus = 'missing'
      } else {
        boundHostStatus = 'corrupt'
        boundHostError = inspected.error || inspected.issues.join('；') || 'Host 绑定验证失败'
      }
    } catch (error) {
      boundHostStatus = 'corrupt'
      boundHostError = error instanceof Error ? error.message : String(error)
    }
  }
  const bindingOk = boundHostStatus === 'ready' || boundHostStatus === 'missing'
  if (!bindingOk) {
    blockedReasons.push(`私有 Host 绑定不可用（${boundHostStatus}）：${boundHostError ?? 'unknown'}`)
  }

  // 3. Inspect installed @dsh-enhanced/* packages per profile.
  const profileSummaries: ProfilePackageSummary[] = []
  for (const profile of targetProfiles) {
    profileSummaries.push(await inspectProfilePackages(canonicalHome, profile))
  }
  const allInstalledVersions = profileSummaries
    .map(p => p.minVersion)
    .filter((v): v is string => v !== undefined)
    .sort((a, b) => compareSemver(a, b) ?? a.localeCompare(b))
  const installedEnhancedVersion = allInstalledVersions[0] ?? CLI_VERSION

  // 4. Inspect profile & creation/revision ledger readiness.
  const profileReadiness: ProfileLedgerReadiness[] = []
  for (const profile of targetProfiles) {
    const ledger = await inspectProfileLedgerReadiness(canonicalHome, profile)
    profileReadiness.push(ledger)
    if (!ledger.ledgerReady) {
      blockedReasons.push(...ledger.issues.map(issue => `[${profile}] ${issue}`))
    }
  }
  const ledgersOk = profileReadiness.every(p => p.ledgerReady)

  // 5. Query npm registry with bounded timeout (offline-safe).
  let registryStatus: 'ok' | 'unavailable' | 'skipped' = 'skipped'
  let latestEnhancedVersion: string | undefined
  let latestDshHostVersion: string | undefined
  let registryError: string | undefined

  if (options.targetVersion && !SEMVER_RE.test(options.targetVersion.trim())) {
    blockedReasons.push(`无效的目标版本号：${options.targetVersion}`)
  }
  if (options.dshVersion && !SEMVER_RE.test(options.dshVersion.trim())) {
    blockedReasons.push(`无效的 Host 目标版本号：${options.dshVersion}`)
  }

  const shouldCheckRegistry = typeof fetchImpl === 'function'
  if (shouldCheckRegistry) {
    const cliQuery = await fetchNpmLatestVersion(fetchImpl, registryUrl, '@dsh-enhanced/dsh-rsi-cli', timeoutMs)
    const dshQuery = mode === 'frozen-linux-systemd'
      ? { ok: true as const, latest: FROZEN_DSH_SELECTOR }
      : await fetchNpmLatestVersion(fetchImpl, registryUrl, '@deepseek-ai/dsh', timeoutMs)
    if (cliQuery.ok || dshQuery.ok) {
      registryStatus = 'ok'
      if (cliQuery.ok) latestEnhancedVersion = cliQuery.latest
      if (dshQuery.ok) latestDshHostVersion = dshQuery.latest
      if (!cliQuery.ok) registryError = cliQuery.error
      if (!dshQuery.ok) registryError = registryError ? `${registryError}; ${dshQuery.error}` : dshQuery.error
    } else {
      registryStatus = 'unavailable'
      registryError = cliQuery.error
    }
  }

  const targetEnhancedVersion = options.targetVersion?.trim() ?? latestEnhancedVersion
  const targetDshVersion = mode === 'frozen-linux-systemd'
    ? (options.dshVersion?.trim() ?? FROZEN_DSH_SELECTOR)
    : (options.dshVersion?.trim() ?? latestDshHostVersion)

  const enhancedUpgradeAvailable = semverIsNewer(targetEnhancedVersion, installedEnhancedVersion)
  const hostUpgradeAvailable = boundHostStatus === 'ready'
    ? semverIsNewer(targetDshVersion, boundHostVersion)
    : Boolean(targetDshVersion && boundHostStatus === 'missing')

  const readinessOk = blockedReasons.length === 0 && bindingOk && ledgersOk

  // Compute concrete plan steps & backup manifest.
  const backupFiles: string[] = []
  if (boundHostStatus === 'ready') backupFiles.push(join(canonicalHome, '.dsh-rsi-host.json'))
  for (const profile of targetProfiles) {
    for (const fileName of ['cordis.patch.yml', 'package.json', 'pnpm-lock.yaml', 'package-lock.json']) {
      const candidate = join(profilesDirectory(canonicalHome), profile, fileName)
      if (existsSync(candidate)) backupFiles.push(candidate)
    }
  }

  const steps: string[] = []
  if (mode === 'frozen-linux-systemd') {
    steps.push(`委托 scripts/install/upgrade-program.mjs 升级 frozen systemd profile（目标 Host ${targetDshVersion ?? FROZEN_DSH_SELECTOR}）`)
  } else {
    if (backupFiles.length > 0) steps.push(`备份 ${backupFiles.length} 个配置与锁定文件`)
    if (hostUpgradeAvailable && targetDshVersion) {
      steps.push(`升级私有 Host（@deepseek-ai/dsh: ${boundHostVersion ?? '未绑定'} -> ${targetDshVersion}）`)
    }
    for (const prof of profileSummaries) {
      const npmCount = Object.keys(prof.installedVersions).length
      if (npmCount > 0 && targetEnhancedVersion && (enhancedUpgradeAvailable || options.targetVersion)) {
        steps.push(`升级 profile ${prof.profile} @dsh-enhanced/*（${prof.minVersion ?? installedEnhancedVersion} -> ${targetEnhancedVersion}）`)
      }
    }
    steps.push('运行 dsh-rsi doctor 就绪检查，失败时自动回滚备份')
  }

  const hasExplicitOrRegistryTarget = mode === 'frozen-linux-systemd'
    || Boolean(targetEnhancedVersion || targetDshVersion)
  const canExecute = readinessOk && hasExplicitOrRegistryTarget

  const baseReport: Omit<UpgradeReport, 'ok' | 'ready' | 'execution'> = {
    schemaVersion: 1,
    command: 'upgrade',
    action: options.action,
    dshHome: canonicalHome,
    ...(options.profile !== undefined ? { selectedProfile: options.profile } : {}),
    mode,
    frozenSystemd: {
      detected: mode === 'frozen-linux-systemd',
      profiles: frozenOwner ? [frozenOwner.profile] : [],
      ...(frozenError ? { reason: frozenError } : {}),
      ...(mode === 'frozen-linux-systemd' ? { targetDshVersion: targetDshVersion ?? FROZEN_DSH_SELECTOR } : {}),
    },
    packages: {
      cliPackageVersion: CLI_VERSION,
      installedEnhancedVersion,
      ...(targetEnhancedVersion ? { targetEnhancedVersion } : {}),
      upgradeAvailable: enhancedUpgradeAvailable || hostUpgradeAvailable,
      boundHost: {
        status: boundHostStatus,
        ...(boundHostVersion ? { installedVersion: boundHostVersion } : {}),
        ...(targetDshVersion ? { targetVersion: targetDshVersion } : {}),
        ...(boundHostPath ? { dshPath: boundHostPath } : {}),
        upgradeAvailable: hostUpgradeAvailable,
        ...(boundHostError ? { error: boundHostError } : {}),
      },
      profiles: profileSummaries,
    },
    registry: {
      url: registryUrl,
      checked: shouldCheckRegistry,
      status: registryStatus,
      ...(latestEnhancedVersion ? { latestEnhancedVersion } : {}),
      ...(latestDshHostVersion ? { latestDshHostVersion } : {}),
      ...(registryError ? { error: registryError } : {}),
    },
    readiness: {
      ok: readinessOk,
      bindingOk,
      ledgersOk,
      profiles: profileReadiness,
      blockedReasons,
    },
    plan: {
      canExecute,
      steps,
      rollbackSupported: mode !== 'frozen-linux-systemd',
      backupFiles,
    },
  }

  // Read-only `--check`: never mutates disk.
  if (options.action === 'check') {
    const ok = readinessOk
    return {
      report: { ...baseReport, ok, ready: readinessOk },
      exitCode: ok ? 0 : 1,
    }
  }

  // `--dry-run`: fail closed on readiness issues, delegate safely for frozen systemd, never mutate local home.
  if (options.action === 'dry-run') {
    if (!readinessOk) {
      const firstReason = blockedReasons[0]
      return {
        report: {
          ...baseReport,
          ok: false,
          ready: false,
          execution: { executed: false, dryRun: true, rolledBack: false, ...(firstReason ? { error: firstReason } : {}) },
        },
        exitCode: 1,
      }
    }
    if (mode === 'frozen-linux-systemd' && frozenOwner) {
      const status = await runFrozen(frozenOwner, {
        dryRun: true,
        ...(options.dshVersion ? { dshVersion: options.dshVersion } : {}),
      }, deps.programUpdatePorts)
      return {
        report: {
          ...baseReport,
          ok: status === 0,
          ready: status === 0,
          execution: {
            executed: false,
            dryRun: true,
            delegatedScript: 'scripts/install/upgrade-program.mjs',
            rolledBack: false,
            ...(status !== 0 ? { error: `frozen dry-run 失败（退出码 ${status}）` } : {}),
          },
        },
        exitCode: status === 0 ? 0 : 1,
      }
    }
    return {
      report: {
        ...baseReport,
        ok: true,
        ready: true,
        execution: { executed: false, dryRun: true, rolledBack: false },
      },
      exitCode: 0,
    }
  }

  // `--yes` execution path.
  if (!readinessOk) {
    return {
      report: {
        ...baseReport,
        ok: false,
        ready: false,
        execution: { executed: false, dryRun: false, rolledBack: false, error: blockedReasons[0] ?? '升级前置条件未就绪' },
      },
      exitCode: 1,
    }
  }

  if (mode === 'frozen-linux-systemd' && frozenOwner) {
    const status = await runFrozen(frozenOwner, {
      dryRun: false,
      ...(options.dshVersion ? { dshVersion: options.dshVersion } : {}),
    }, deps.programUpdatePorts)
    return {
      report: {
        ...baseReport,
        ok: status === 0,
        ready: status === 0,
        execution: {
          executed: true,
          dryRun: false,
          delegatedScript: 'scripts/install/upgrade-program.mjs',
          healthCheckPassed: status === 0,
          rolledBack: false,
          ...(status !== 0 ? { error: `frozen systemd 升级失败（退出码 ${status}）` } : {}),
        },
      },
      exitCode: status === 0 ? 0 : 1,
    }
  }

  if (!hasExplicitOrRegistryTarget) {
    const offlineMsg = `无法解析目标版本（registry 状态：${registryStatus}${registryError ? `：${registryError}` : ''}），请联网或显式传入 --version / --dsh-version`
    return {
      report: {
        ...baseReport,
        ok: false,
        ready: readinessOk,
        execution: { executed: false, dryRun: false, rolledBack: false, error: offlineMsg },
      },
      exitCode: 1,
    }
  }

  // Nothing newer to install unless explicit version override was passed.
  const hostNeedsWork = Boolean(targetDshVersion && (hostUpgradeAvailable || options.dshVersion))
    && targetDshVersion !== boundHostVersion
  const profilesNeedingWork = profileSummaries.filter((summary) => {
    const hasNpm = Object.keys(summary.installedVersions).length > 0 && summary.installKinds.includes('npm')
    if (!hasNpm || !targetEnhancedVersion) return false
    return semverIsNewer(targetEnhancedVersion, summary.minVersion) || (options.targetVersion !== undefined && targetEnhancedVersion !== summary.minVersion)
  })

  if (!hostNeedsWork && profilesNeedingWork.length === 0) {
    const health = await verifyHealthFn({
      dshHome: canonicalHome,
      ...(options.profile ? { profile: options.profile } : {}),
      profiles: targetProfiles,
      runner,
      platform,
      osHome,
      env,
    })
    return {
      report: {
        ...baseReport,
        ok: health.ok,
        ready: health.ok,
        execution: {
          executed: false,
          dryRun: false,
          healthCheckPassed: health.ok,
          rolledBack: false,
          ...(health.error ? { error: health.error } : {}),
        },
      },
      exitCode: health.ok ? 0 : 1,
    }
  }

  const checkRunningFn = deps.isServiceRunning ?? (async (
    targetPlatform: NodeJS.Platform,
    homeDir: string,
    homePath: string,
    profile: string,
    cmdRunner: CommandRunner,
  ) => {
    if (targetPlatform === 'darwin') {
      const checked = await inspectLaunchdDefinition(homeDir, homePath, profile, cmdRunner)
      if (!checked.definition) return false
      return inspectLoadedLaunchd(checked.definition, homePath, cmdRunner).running
    }
    const found = await managedServiceProcessIds(targetPlatform, homeDir, [profile], cmdRunner)
    return found.pids.length > 0
  })

  return withDshHomeLifecycleLock(canonicalHome, async () => {
    // 1. Check / stop managed services & verify no foreign live host processes are active.
    const previouslyRunning: string[] = []
    if (!options.confirmDshHomeStopped) {
      for (const profile of targetProfiles) {
        const presence = await inspectServiceFn(platform, osHome, profile, canonicalHome, runner)
        if (presence.foreign) {
          return {
            report: {
              ...baseReport,
              ok: false,
              ready: readinessOk,
              execution: { executed: false, dryRun: false, rolledBack: false, error: `服务定义非本工具受管：${presence.definitionPath}` },
            },
            exitCode: 1,
          }
        }
        if (presence.managed && await checkRunningFn(platform, osHome, canonicalHome, profile, runner)) {
          previouslyRunning.push(profile)
          const stopped = await controlServiceFn(platform, osHome, profile, 'stop', runner, false, canonicalHome)
          if (stopped.errors.length > 0) {
            return {
              report: {
                ...baseReport,
                ok: false,
                ready: readinessOk,
                execution: { executed: false, dryRun: false, rolledBack: false, error: `无法停止服务 ${profile}：${stopped.errors.join('；')}` },
              },
              exitCode: 1,
            }
          }
        }
      }
      if (targetProfiles.length > 0) {
        const scan = await scanProcessesFn(canonicalHome, targetProfiles, runner, platform)
        if (scan.error || scan.processes.length > 0) {
          const desc = scan.error ?? `检测到仍在运行的 profile 进程（PID ${scan.processes.map(p => p.pid).join(', ')}），请先停止或传入 --confirm-dsh-home-stopped`
          return {
            report: {
              ...baseReport,
              ok: false,
              ready: readinessOk,
              execution: { executed: false, dryRun: false, rolledBack: false, error: desc },
            },
            exitCode: 1,
          }
        }
      }
    }

    // 2. Create transactional backup before any mutation.
    const backup = await createUpgradeBackup(canonicalHome, targetProfiles)
    let servicesRestarted = false

    try {
      if (hostNeedsWork && targetDshVersion) {
        await upgradeHostFn({ dshHome: canonicalHome, targetVersion: targetDshVersion })
      }
      for (const prof of profilesNeedingWork) {
        const plugins = await listProfilePlugins(canonicalHome, prof.profile)
        const npmPlugins = plugins.filter(p => p.kind === 'npm').map(p => p.name)
        if (npmPlugins.length > 0 && targetEnhancedVersion) {
          await upgradeProfileFn({
            dshHome: canonicalHome,
            profile: prof.profile,
            targetVersion: targetEnhancedVersion,
            registryUrl,
            npmPlugins,
            runner,
          })
        }
      }

      // 3. Post-upgrade verification via doctor readiness + binding integrity.
      const postIntegrity = await checkBoundHostFileIntegrity(canonicalHome)
      if (postIntegrity.status !== 'ready' && postIntegrity.status !== 'missing') {
        throw new Error(`升级后 Host 绑定损坏：${postIntegrity.error ?? postIntegrity.status}`)
      }
      const health = await verifyHealthFn({
        dshHome: canonicalHome,
        ...(options.profile ? { profile: options.profile } : {}),
        profiles: targetProfiles,
        runner,
        platform,
        osHome,
        env,
      })
      if (!health.ok) {
        throw new Error(`升级后就绪诊断失败：${health.error ?? 'unknown'}`)
      }

      if (previouslyRunning.length > 0) {
        servicesRestarted = true
        for (const profile of previouslyRunning) {
          const restarted = await controlServiceFn(platform, osHome, profile, 'start', runner, false, canonicalHome)
          if (restarted.errors.length > 0) {
            throw new Error(`升级后重启服务 ${profile} 失败：${restarted.errors.join('；')}`)
          }
        }
      }

      return {
        report: {
          ...baseReport,
          ok: true,
          ready: true,
          execution: {
            executed: true,
            dryRun: false,
            backupDir: backup.backupDir,
            healthCheckPassed: true,
            rolledBack: false,
          },
        },
        exitCode: 0,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (servicesRestarted) {
        for (const profile of previouslyRunning) {
          try { await controlServiceFn(platform, osHome, profile, 'stop', runner, false, canonicalHome) } catch { /* ignore */ }
        }
      }
      const rollbackSucceeded = await restoreUpgradeBackup(canonicalHome, backup)
      if (rollbackSucceeded) {
        for (const profile of previouslyRunning) {
          try { await controlServiceFn(platform, osHome, profile, 'start', runner, false, canonicalHome) } catch { /* ignore */ }
        }
      }
      return {
        report: {
          ...baseReport,
          ok: false,
          ready: false,
          execution: {
            executed: true,
            dryRun: false,
            backupDir: backup.backupDir,
            healthCheckPassed: false,
            rolledBack: true,
            rollbackSucceeded,
            error: message,
          },
        },
        exitCode: 1,
      }
    }
  })
}

export function formatUpgradeReport(report: UpgradeReport): string {
  const lines: string[] = []
  lines.push(`=== dsh-rsi upgrade (${report.action}) ===`)
  lines.push(`DSH_HOME：${report.dshHome}`)
  lines.push(`部署模式：${report.mode}${report.frozenSystemd.detected ? `（profiles: ${report.frozenSystemd.profiles.join(', ')}）` : ''}`)
  lines.push(`CLI 版本：${report.packages.cliPackageVersion}；已安装 @dsh-enhanced/*：${report.packages.installedEnhancedVersion ?? '未检测到'}${report.packages.targetEnhancedVersion ? ` -> 目标：${report.packages.targetEnhancedVersion}` : ''}`)
  lines.push(`私有 Host（.dsh-rsi-host.json）：${report.packages.boundHost.status}${report.packages.boundHost.installedVersion ? ` ${report.packages.boundHost.installedVersion}` : ''}${report.packages.boundHost.targetVersion ? ` -> ${report.packages.boundHost.targetVersion}` : ''}`)
  lines.push(`Registry（${report.registry.url}）：${report.registry.status}${report.registry.error ? `（${report.registry.error}）` : ''}`)
  lines.push(`迁移就绪：${report.readiness.ok ? '就绪' : '阻断'}（bindingOk=${report.readiness.bindingOk}, ledgersOk=${report.readiness.ledgersOk}）`)
  for (const prof of report.readiness.profiles) {
    lines.push(`  - ${prof.profile}：ledgerReady=${prof.ledgerReady} creation=${prof.creationLedgerStatus} revision=${prof.revisionLedgerStatus}`)
  }
  for (const reason of report.readiness.blockedReasons) {
    lines.push(`  [BLOCKED] ${reason}`)
  }
  if (report.plan.steps.length > 0) {
    lines.push('升级计划：')
    for (const step of report.plan.steps) lines.push(`  - ${step}`)
  }
  if (report.execution) {
    const exec = report.execution
    lines.push(`执行结果：executed=${exec.executed} dryRun=${exec.dryRun} rolledBack=${exec.rolledBack}${exec.error ? ` error=${exec.error}` : ''}`)
  }
  return `${lines.join('\n')}\n`
}
