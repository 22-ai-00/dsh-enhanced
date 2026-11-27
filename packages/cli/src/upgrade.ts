import { createHash } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { chmod, cp, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import { collectLiveDoctorReport, type LiveDoctorReport } from './doctor-live.ts'
import { withDshHomeLifecycleLock } from './home-lifecycle-lock.ts'
import { isSupportedCandidateVersion } from './host-runtime.ts'
import { inspectBoundHostRuntime, prepareHostUpdatePlan, type BoundHostInspection, type InstallHostPorts } from './install-host.ts'
import { inspectLaunchdDefinition, inspectLoadedLaunchd } from './launchd-service.ts'
import { listProfilePlugins, listProfiles, profilesDirectory } from './paths.ts'
import { buildPackageManagerEnv, checkRegularFileAccess, resolveFallbackBinary, resolveNodeRuntime } from './pm-env.ts'
import { scanRunningProfiles } from './process-guard.ts'
import { detectFrozenOwner, runFrozenOwnerUpdate, type FrozenOwner, type ProgramUpdatePorts } from './program-update.ts'
import { defaultDetailedRunner, defaultRunner, type CommandRunner, type DetailedCommandRunner } from './run.ts'
import {
  controlManagedService,
  inspectManagedServiceForDshHome,
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
  readonly toNpm?: boolean
  readonly allowNonEmptyHistoryMigration?: boolean
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
  readonly detailedRunner?: DetailedCommandRunner
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
    detailedRunner?: DetailedCommandRunner
    toNpm?: boolean
    platform?: NodeJS.Platform
    osHome?: string
    env?: NodeJS.ProcessEnv
  }) => Promise<void> | void
  readonly verifyHealth?: (input: {
    dshHome: string
    profile?: string
    profiles: readonly string[]
    runner: CommandRunner
    platform: NodeJS.Platform
    osHome: string
    env: NodeJS.ProcessEnv
    requireAutonomyReadinessProfiles?: readonly string[]
  }) => Promise<UpgradeHealthResult>
  readonly doctor?: (input: {
    dshHome: string
    profile?: string
    platform: NodeJS.Platform
    home: string
    env: NodeJS.ProcessEnv
    runner: CommandRunner
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
const REGISTRY_TIMEOUT_MS = 8_000
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u
const FROZEN_DSH_SELECTOR = '0.2.2-rc.5'
const PROFILE_BACKUP_FILES = [
  'cordis.patch.yml',
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'package-lock.json',
] as const
const LOCAL_SOURCE_SPEC_PREFIXES = ['file:', 'link:', 'workspace:'] as const
const NON_REGISTRY_SPEC_PREFIXES = [
  'file:',
  'link:',
  'workspace:',
  'portal:',
  'git+',
  'http:',
  'https:',
  'npm:',
] as const
const DSH_APP_PNPM_SCRIPT = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs'
const DSH_APP_PNPM_REL_FROM_CONTENTS = join('Resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')

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

function resolveDshHomePathExpression(expr: string, dshHome: string): string {
  const trimmed = expr.trim()
  const match = /^dshHomePath\(([\s\S]+)\)$/u.exec(trimmed)
  if (!match) {
    throw new Error(`无效的 dshHomePath 表达式：${expr}`)
  }
  let rest = match[1]!.trim()
  if (!rest) {
    throw new Error(`dshHomePath 表达式不能为空：${expr}`)
  }
  const segments: string[] = []
  while (rest.length > 0) {
    const argMatch = /^(?:'([^'\\]*)'|"([^"\\]*)")\s*(?:,\s*([\s\S]*))?$/u.exec(rest)
    if (!argMatch) {
      throw new Error(`dshHomePath 仅支持静态字面量路径参数：${expr}`)
    }
    const literal = argMatch[1] ?? argMatch[2] ?? ''
    if (!literal || literal.includes('\\') || literal.includes('\0') || /[\r\n]/u.test(literal) || literal.startsWith('/')) {
      throw new Error(`dshHomePath 包含非法路径片段：${expr}`)
    }
    for (const seg of literal.split('/')) {
      if (!seg || seg === '.' || seg === '..') {
        throw new Error(`dshHomePath 包含越界或空路径片段：${expr}`)
      }
      segments.push(seg)
    }
    if (argMatch[3] === undefined) break
    rest = argMatch[3].trim()
    if (!rest) {
      throw new Error(`dshHomePath 包含尾部多余逗号：${expr}`)
    }
  }
  const root = resolve(dshHome)
  const resolved = resolve(root, ...segments)
  if (!resolved.startsWith(root + sep)) {
    throw new Error(`dshHomePath 路径越界：${expr}`)
  }
  return resolved
}

function isLedgerPluginRow(obj: Record<string, unknown>): boolean {
  return obj.id === 'dsh-ray-plugin-control-plane'
    || obj.id === 'dsh-ray-assistant-verifier'
    || obj.name === '@dsh-ray/plugin-control-plane'
    || obj.name === '@dsh-ray/assistant-verifier'
}

function extractConfiguredDbPaths(patchText: string, dshHome: string): string[] {
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
    if (typeof obj.databasePath === 'string') {
      const dbSpec = obj.databasePath.trim()
      if (dbSpec.startsWith('dshHomePath(')) {
        paths.add(resolveDshHomePathExpression(dbSpec, dshHome))
      } else if (!dbSpec.includes('dshHomePath(')) {
        paths.add(obj.databasePath)
      } else {
        throw new Error(`无效的 dshHomePath 表达式：${obj.databasePath}`)
      }
    }
    for (const child of Object.values(obj)) collect(child, depth + 1)
  }
  const visitRow = (row: unknown) => {
    const obj = asObject(row)
    if (!obj) return
    if (isLedgerPluginRow(obj)) {
      collect(obj.config, 0)
    }
    if (Array.isArray(obj.insert)) {
      for (const nested of obj.insert) visitRow(nested)
    }
  }
  for (const row of value) visitRow(row)
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

async function inspectProfileLedgerReadiness(
  dshHome: string,
  profile: string,
  allowNonEmptyHistoryMigration = false,
): Promise<ProfileLedgerReadiness> {
  const issues: string[] = []
  let creationLedgerStatus: LedgerStatus = 'absent'
  let revisionLedgerStatus: LedgerStatus = 'absent'

  const patch = await readProfilePatchText(dshHome, profile)
  let configuredDbPaths: string[] = []
  if (patch.error) {
    issues.push(patch.error)
  } else if (patch.text !== undefined) {
    try {
      configuredDbPaths = extractConfiguredDbPaths(patch.text, dshHome)
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
        if (hasCreationRows && !allowNonEmptyHistoryMigration) {
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
        if (hasRevisionRows && !allowNonEmptyHistoryMigration) {
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

  const nonEmptyAllowed = allowNonEmptyHistoryMigration === true
  const ledgerReady = issues.length === 0
    && creationLedgerStatus !== 'corrupt'
    && revisionLedgerStatus !== 'corrupt'
    && (nonEmptyAllowed || (creationLedgerStatus !== 'non-empty' && revisionLedgerStatus !== 'non-empty'))

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
  const scopeDir = join(profilesDirectory(dshHome), profile, 'node_modules', '@dsh-ray')
  for (const plugin of plugins) {
    kinds.add(plugin.kind)
    const slug = plugin.name.replace('@dsh-ray/', '')
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
  const bindingPath = join(dshHome, '.dsh-ray-host.json')
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
): Promise<{ ok: true; latest: string } | { ok: false; error: string }> {
  // Preserve `@scope/name` slash so both registry.npmjs.org and test stubs match.
  const slug = packageName.startsWith('@')
    ? `@${encodeURIComponent(packageName.slice(1)).replace('%2F', '/')}`
    : encodeURIComponent(packageName)
  const headers = { Accept: 'application/vnd.npm.install-v1+json, application/json' }
  const latestUrl = `${registryUrl}/${slug}/latest`
  try {
    let response = await fetchImpl(latestUrl, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status === 404 || response.status === 405) {
      response = await fetchImpl(`${registryUrl}/${slug}`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      })
    }
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status} (${packageName})` }
    }
    const payload = await response.json() as { version?: unknown; 'dist-tags'?: { latest?: unknown } }
    const rawLatest = typeof payload?.version === 'string' && payload.version.trim().length > 0
      ? payload.version
      : payload?.['dist-tags']?.latest
    if (typeof rawLatest !== 'string' || !SEMVER_RE.test(rawLatest.trim())) {
      return { ok: false, error: `registry 返回的 ${packageName} latest 版本无效` }
    }
    return { ok: true, latest: rawLatest.trim() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function isNonRegistrySpec(value: unknown): boolean {
  if (typeof value !== 'string') return true
  const lower = value.trim().toLowerCase()
  return NON_REGISTRY_SPEC_PREFIXES.some(prefix => lower.startsWith(prefix))
}

function isLocalSourceSpec(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  const lower = trimmed.toLowerCase()
  return LOCAL_SOURCE_SPEC_PREFIXES.some(prefix => lower.startsWith(prefix)) || trimmed.includes('rsi-local-cohorts')
}

interface RsiCoordinatorPair {
  readonly markerPath: string
  readonly targetProfile: string
  readonly coordinatorProfile: string
  readonly version?: string
  readonly sourceRepository: string | null
  readonly mode: number
}

/**
 * Read a valid `.rsi-coordinator-<sha256>.json` marker for pairing target & coordinator profiles
 * during both source->npm migration and subsequent paired npm upgrades.
 */
async function readRsiCoordinatorPair(canonicalHome: string): Promise<RsiCoordinatorPair | undefined> {
  const entries = await readdir(canonicalHome).catch(() => [] as string[])
  const markers = entries.filter(name => /^\.rsi-coordinator-[a-f0-9]{16}\.json$/u.test(name))
  if (markers.length !== 1) return undefined
  const markerPath = join(canonicalHome, markers[0]!)
  try {
    const meta = await lstat(markerPath)
    const raw = await readCheckedRegularBytes(markerPath, 65_536, 'coordinator marker')
    const parsed = asObject(JSON.parse(raw.toString('utf8')))
    if (!parsed || parsed.schemaVersion !== 1
      || typeof parsed.targetProfile !== 'string' || !parsed.targetProfile
      || typeof parsed.coordinatorProfile !== 'string' || !parsed.coordinatorProfile
      || parsed.targetProfile === parsed.coordinatorProfile) {
      return undefined
    }
    const expectedName = `.rsi-coordinator-${createHash('sha256').update(parsed.targetProfile).digest('hex').slice(0, 16)}.json`
    if (markers[0] !== expectedName) return undefined
    const sourceRepository = parsed.sourceRepository === null
      ? null
      : typeof parsed.sourceRepository === 'string'
        ? parsed.sourceRepository
        : null
    return {
      markerPath,
      targetProfile: parsed.targetProfile,
      coordinatorProfile: parsed.coordinatorProfile,
      ...(typeof parsed.version === 'string' ? { version: parsed.version } : {}),
      sourceRepository,
      mode: meta.mode & 0o777,
    }
  } catch {
    return undefined
  }
}

async function inspectProfileHasLocalEnhancedSpecs(dshHome: string, profile: string): Promise<boolean> {
  const profileDir = join(profilesDirectory(dshHome), profile)
  const pkgPath = join(profileDir, 'package.json')
  try {
    const pkgStat = await lstat(pkgPath)
    if (pkgStat.isFile() && !pkgStat.isSymbolicLink()) {
      const parsed = asObject(JSON.parse(await readFile(pkgPath, 'utf8')))
      if (parsed) {
        for (const sectionName of ['dependencies', 'optionalDependencies', 'devDependencies'] as const) {
          const section = asObject(parsed[sectionName])
          if (!section) continue
          for (const [depName, depSpec] of Object.entries(section)) {
            if (depName.startsWith('@dsh-ray/') && isLocalSourceSpec(depSpec)) return true
          }
        }
      }
    }
  } catch {
    // ignore unreadable package.json here; ledger/profile checks handle corruption
  }
  const wsPath = join(profileDir, 'pnpm-workspace.yaml')
  try {
    const wsStat = await lstat(wsPath)
    if (wsStat.isFile() && !wsStat.isSymbolicLink()) {
      const doc = parseDocument(await readFile(wsPath, 'utf8'))
      const overrides = doc.get('overrides', true)
      if (isMap(overrides)) {
        for (const pair of overrides.items) {
          const keyVal = isScalar(pair.key) ? pair.key.value : pair.key
          const valNode = isScalar(pair.value) ? pair.value.value : pair.value
          if (typeof keyVal === 'string' && keyVal.includes('@dsh-ray/') && isLocalSourceSpec(valNode)) {
            return true
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return false
}

async function collectProfileLocalEnhancedNames(profileDir: string): Promise<string[]> {
  const pkgPath = join(profileDir, 'package.json')
  try {
    const meta = await lstat(pkgPath)
    if (!meta.isFile() || meta.isSymbolicLink()) return []
    const parsed = asObject(JSON.parse(await readFile(pkgPath, 'utf8')))
    if (!parsed) return []
    const names = new Set<string>()
    for (const sectionName of ['dependencies', 'optionalDependencies', 'devDependencies'] as const) {
      const section = asObject(parsed[sectionName])
      if (!section) continue
      for (const [depName, depSpec] of Object.entries(section)) {
        if (depName.startsWith('@dsh-ray/') && isLocalSourceSpec(depSpec)) {
          names.add(depName)
        }
      }
    }
    return [...names].sort()
  } catch {
    return []
  }
}

async function writeTextAtomically(targetPath: string, content: string, mode: number): Promise<void> {
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  try {
    await writeFile(tempPath, content, { encoding: 'utf8', mode })
    await chmod(tempPath, mode)
    await rename(tempPath, targetPath)
  } catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }
}

async function updatePnpmProfilePackageJson(
  profileDir: string,
  profile: string,
  targetVersion: string,
  npmPlugins: readonly string[],
  toNpm = false,
): Promise<void> {
  const pkgPath = join(profileDir, 'package.json')
  const pkgStat = await lstat(pkgPath)
  if (!pkgStat.isFile() || pkgStat.isSymbolicLink()) {
    throw new Error(`profile ${profile} package.json 非普通文件：${pkgPath}`)
  }
  const pkgMode = pkgStat.mode & 0o777
  const raw = await readFile(pkgPath, 'utf8')
  const parsed = asObject(JSON.parse(raw) as unknown)
  if (!parsed) {
    throw new Error(`profile ${profile} package.json 格式无效：根必须为 JSON 对象`)
  }

  let hasAnyEnhanced = false
  let changed = false
  for (const sectionName of ['dependencies', 'optionalDependencies', 'devDependencies'] as const) {
    const sectionVal = parsed[sectionName]
    if (sectionVal === undefined) continue
    const section = asObject(sectionVal)
    if (!section) {
      throw new Error(`profile ${profile} package.json 字段 ${sectionName} 必须为对象`)
    }
    for (const [depName, depSpec] of Object.entries(section)) {
      if (!depName.startsWith('@dsh-ray/')) continue
      hasAnyEnhanced = true
      const rewritable = !isNonRegistrySpec(depSpec) || (toNpm && isLocalSourceSpec(depSpec))
      if (rewritable && section[depName] !== targetVersion) {
        section[depName] = targetVersion
        changed = true
      }
    }
  }

  if (!hasAnyEnhanced) {
    const deps = asObject(parsed.dependencies) ?? {}
    for (const plugin of npmPlugins) {
      if (deps[plugin] !== targetVersion) {
        deps[plugin] = targetVersion
        changed = true
      }
    }
    parsed.dependencies = deps
  }

  if (changed) {
    const trailing = raw.endsWith('\n') ? '\n' : ''
    await writeTextAtomically(pkgPath, `${JSON.stringify(parsed, null, 2)}${trailing}`, pkgMode)
  }
}

export const KNOWN_ENHANCED_PACKAGES: readonly string[] = [
  '@dsh-ray/acp',
  '@dsh-ray/assistant-actions',
  '@dsh-ray/assistant-association',
  '@dsh-ray/assistant-automations',
  '@dsh-ray/assistant-deepseek-budget',
  '@dsh-ray/assistant-delivery',
  '@dsh-ray/assistant-dreaming',
  '@dsh-ray/assistant-evaluation',
  '@dsh-ray/assistant-evolution',
  '@dsh-ray/assistant-goals',
  '@dsh-ray/assistant-growth-contract',
  '@dsh-ray/assistant-growth-driver',
  '@dsh-ray/assistant-growth-experiments',
  '@dsh-ray/assistant-health',
  '@dsh-ray/assistant-heartbeat',
  '@dsh-ray/assistant-isolation',
  '@dsh-ray/assistant-memory-learning',
  '@dsh-ray/assistant-policy',
  '@dsh-ray/assistant-proactive',
  '@dsh-ray/assistant-recovery',
  '@dsh-ray/assistant-skills',
  '@dsh-ray/assistant-verifier',
  '@dsh-ray/assistant-web-owner',
  '@dsh-ray/assistant-work-items',
  '@dsh-ray/coding-subscription-provider',
  '@dsh-ray/credentials-keychain',
  '@dsh-ray/event-triggers',
  '@dsh-ray/hello',
  '@dsh-ray/lark-channel',
  '@dsh-ray/llm-route-capabilities',
  '@dsh-ray/memory-wiki-bridge',
  '@dsh-ray/owner-console',
  '@dsh-ray/personal-assistant',
  '@dsh-ray/personal-memory',
  '@dsh-ray/personal-wiki',
  '@dsh-ray/plugin-control-plane',
  '@dsh-ray/preference-learning',
  '@dsh-ray/task-acceptance-contract',
  '@dsh-ray/traex-acp-provider',
]

function parseEnhancedExcludeRule(
  entry: string,
): { readonly name: string; readonly versions: string[]; readonly unversioned: boolean } | undefined {
  if (!entry.startsWith('@dsh-ray/') || entry === '@dsh-ray/*') return undefined
  const atIndex = entry.indexOf('@', '@dsh-ray/'.length)
  const name = atIndex > 0 ? entry.slice(0, atIndex) : entry
  if (!/^@dsh-ray\/[a-z0-9][a-z0-9-]*$/u.test(name)) return undefined
  if (atIndex === -1) return { name, versions: [], unversioned: true }
  const versions = entry.slice(atIndex + 1).split('||').map(part => part.trim()).filter(Boolean)
  return { name, versions, unversioned: false }
}

async function readRegistryEnhancedDepsFromManifest(profileDir: string): Promise<string[]> {
  const pkgPath = join(profileDir, 'package.json')
  try {
    const meta = await lstat(pkgPath)
    if (!meta.isFile() || meta.isSymbolicLink()) return []
    const parsed = asObject(JSON.parse(await readFile(pkgPath, 'utf8')))
    if (!parsed) return []
    const names: string[] = []
    for (const sectionName of ['dependencies', 'optionalDependencies', 'devDependencies'] as const) {
      const section = asObject(parsed[sectionName])
      if (!section) continue
      for (const [depName, depSpec] of Object.entries(section)) {
        if (depName.startsWith('@dsh-ray/') && typeof depSpec === 'string' && !isNonRegistrySpec(depSpec)) {
          names.push(depName)
        }
      }
    }
    return names
  } catch {
    return []
  }
}

async function updatePnpmWorkspaceOverrides(
  profileDir: string,
  profile: string,
  targetVersion: string,
  npmPlugins: readonly string[] = [],
  toNpm = false,
): Promise<void> {
  const wsPath = join(profileDir, 'pnpm-workspace.yaml')
  let wsStat
  try {
    wsStat = await lstat(wsPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!wsStat.isFile() || wsStat.isSymbolicLink()) {
    throw new Error(`profile ${profile} pnpm-workspace.yaml 非普通文件：${wsPath}`)
  }
  const wsMode = wsStat.mode & 0o777
  const raw = await readFile(wsPath, 'utf8')
  const doc = parseDocument(raw)
  if (doc.errors.length > 0) {
    throw new Error(`profile ${profile} pnpm-workspace.yaml YAML 语法错误：${doc.errors[0]!.message}`)
  }

  let changed = false
  const overrides = doc.get('overrides', true)
  if (isMap(overrides)) {
    for (let idx = overrides.items.length - 1; idx >= 0; idx--) {
      const pair = overrides.items[idx]!
      const keyVal = isScalar(pair.key) ? pair.key.value : pair.key
      if (typeof keyVal !== 'string' || !keyVal.includes('@dsh-ray/')) continue
      if (!isScalar(pair.value) || typeof pair.value.value !== 'string') continue
      if (toNpm && isLocalSourceSpec(pair.value.value)) {
        if (keyVal.includes('>') || !keyVal.startsWith('@dsh-ray/')) {
          overrides.items.splice(idx, 1)
          changed = true
        } else if (pair.value.value !== targetVersion) {
          pair.value.value = targetVersion
          changed = true
        }
        continue
      }
      if (!keyVal.startsWith('@dsh-ray/') || keyVal.includes('>')) continue
      if (isNonRegistrySpec(pair.value.value)) continue
      if (pair.value.value !== targetVersion) {
        pair.value.value = targetVersion
        changed = true
      }
    }
    if (toNpm && overrides.items.length === 0) {
      doc.delete('overrides')
      changed = true
    }
  }

  const strictNode = doc.get('minimumReleaseAgeStrict', true)
  const isStrict = strictNode === true || (isScalar(strictNode) && strictNode.value === true)
  if (!isStrict) {
    const excludeNode = doc.get('minimumReleaseAgeExclude', true)
    const packageNames = new Set<string>([...KNOWN_ENHANCED_PACKAGES, ...npmPlugins])
    for (const depName of await readRegistryEnhancedDepsFromManifest(profileDir)) {
      packageNames.add(depName)
    }

    if (excludeNode === undefined || excludeNode === null) {
      const entries = [...packageNames].sort().map(pkg => `${pkg}@${targetVersion}`)
      doc.set('minimumReleaseAgeExclude', entries)
      changed = true
    } else if (!isSeq(excludeNode)) {
      throw new Error(`profile ${profile} pnpm-workspace.yaml minimumReleaseAgeExclude 必须为数组`)
    } else {
      // pnpm 11 evaluates only the first minimumReleaseAgeExclude rule per package,
      // so merge retained/duplicate versions onto that first rule with `||`.
      const grouped = new Map<string, { firstIndex: number; versions: string[]; unversioned: boolean }>()
      const duplicateIndices: number[] = []
      for (const [index, item] of excludeNode.items.entries()) {
        const val = isScalar(item) ? item.value : item
        if (typeof val !== 'string') continue
        const parsed = parseEnhancedExcludeRule(val)
        if (!parsed) continue
        packageNames.add(parsed.name)
        const existing = grouped.get(parsed.name)
        if (!existing) {
          grouped.set(parsed.name, {
            firstIndex: index,
            versions: [...parsed.versions],
            unversioned: parsed.unversioned,
          })
        } else {
          if (parsed.unversioned) existing.unversioned = true
          for (const version of parsed.versions) {
            if (!existing.versions.includes(version)) existing.versions.push(version)
          }
          duplicateIndices.push(index)
          changed = true
        }
      }
      for (const pkg of [...packageNames].sort()) {
        const group = grouped.get(pkg)
        if (!group) {
          excludeNode.add(`${pkg}@${targetVersion}`)
          changed = true
          continue
        }
        if (group.unversioned) continue
        if (!group.versions.includes(targetVersion)) {
          group.versions.push(targetVersion)
          changed = true
        }
        const expected = `${pkg}@${group.versions.join(' || ')}`
        const currentNode = excludeNode.items[group.firstIndex]
        const currentVal = isScalar(currentNode) ? currentNode.value : currentNode
        if (currentVal !== expected) {
          if (isScalar(currentNode)) currentNode.value = expected
          else excludeNode.set(group.firstIndex, expected)
          changed = true
        }
      }
      for (let i = duplicateIndices.length - 1; i >= 0; i--) {
        excludeNode.items.splice(duplicateIndices[i]!, 1)
      }
    }
  }

  if (changed) {
    await writeTextAtomically(wsPath, doc.toString(), wsMode)
  }
}

async function resolveDesktopAppPnpmScript(
  env: NodeJS.ProcessEnv,
  osHome: string,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  if (platform !== 'darwin') return undefined
  const candidates: string[] = []
  const desktopExec = env.DSH_DESKTOP_NODE_EXECUTABLE?.trim()
  if (desktopExec) {
    const marker = `.app${sep}Contents${sep}`
    const markerIdx = desktopExec.indexOf(marker)
    if (markerIdx !== -1) {
      const contentsDir = desktopExec.slice(0, markerIdx + `.app${sep}Contents`.length)
      candidates.push(join(contentsDir, DSH_APP_PNPM_REL_FROM_CONTENTS))
    }
  }
  candidates.push(
    DSH_APP_PNPM_SCRIPT,
    join(osHome, 'Applications', 'DeepSeek Harness.app', 'Contents', DSH_APP_PNPM_REL_FROM_CONTENTS),
  )
  for (const candidate of candidates) {
    if (await checkRegularFileAccess(candidate, constants.R_OK)) {
      return candidate
    }
  }
  return undefined
}

async function resolvePnpmCommand(
  env: NodeJS.ProcessEnv,
  osHome: string,
  platform: NodeJS.Platform,
): Promise<{
  command: string
  prefixArgs: readonly string[]
  envOverrides: NodeJS.ProcessEnv
  binDirs: readonly string[]
}> {
  const pathDirs = (env.PATH ?? '').split(delimiter).filter(Boolean)
  const extraDirs = platform === 'darwin' ? [join(osHome, 'Library', 'pnpm')] : []
  const fallbackBin = await resolveFallbackBinary('pnpm', env, osHome, platform, extraDirs)
  if (fallbackBin.binDir) {
    return { command: fallbackBin.command, prefixArgs: [], envOverrides: {}, binDirs: [fallbackBin.binDir] }
  }
  for (const dir of pathDirs) {
    const candidate = join(dir, 'pnpm')
    if (await checkRegularFileAccess(candidate, constants.X_OK)) {
      return { command: candidate, prefixArgs: [], envOverrides: {}, binDirs: [dir] }
    }
  }
  const bundledScript = await resolveDesktopAppPnpmScript(env, osHome, platform)
  if (bundledScript !== undefined) {
    const nodeRt = await resolveNodeRuntime(env, osHome, platform)
    return {
      command: nodeRt.command,
      prefixArgs: [bundledScript],
      envOverrides: nodeRt.envOverrides,
      binDirs: nodeRt.binDir ? [nodeRt.binDir] : [],
    }
  }
  return { command: 'pnpm', prefixArgs: [], envOverrides: {}, binDirs: [] }
}

/**
 * Upgrade a profile's `@dsh-ray/*` packages using pnpm (updating `package.json` and
 * `pnpm-workspace.yaml` overrides while optionally migrating local specs when `toNpm` is true)
 * or npm with `--legacy-peer-deps`.
 */
export async function defaultUpgradeProfilePackages(input: {
  dshHome: string
  profile: string
  targetVersion: string
  registryUrl: string
  npmPlugins: readonly string[]
  runner: CommandRunner
  detailedRunner?: DetailedCommandRunner
  toNpm?: boolean
  platform?: NodeJS.Platform
  osHome?: string
  env?: NodeJS.ProcessEnv
}): Promise<void> {
  const toNpm = Boolean(input.toNpm)
  if (input.npmPlugins.length === 0 && !toNpm) return
  const profileDir = join(profilesDirectory(input.dshHome), input.profile)
  const isPnpmProfile = existsSync(join(profileDir, 'pnpm-lock.yaml'))
    || existsSync(join(profileDir, 'pnpm-workspace.yaml'))
    || existsSync(join(profileDir, 'node_modules', '.pnpm'))
  const env = input.env ?? process.env
  const osHome = input.osHome ?? env.HOME ?? homedir()
  const platform = input.platform ?? process.platform

  const runPmCommand = async (
    command: string,
    args: readonly string[],
    extraBinDirs: readonly string[],
    envOverrides: NodeJS.ProcessEnv,
  ) => {
    const basePmEnv = await buildPackageManagerEnv(env, osHome, platform, extraBinDirs)
    const pmEnv: NodeJS.ProcessEnv = { ...basePmEnv, ...envOverrides }
    if (input.detailedRunner) return input.detailedRunner(command, args, { env: pmEnv })
    if (input.runner === defaultRunner) return defaultDetailedRunner(command, args, { env: pmEnv })
    return input.runner(command, args)
  }

  if (isPnpmProfile) {
    await updatePnpmProfilePackageJson(profileDir, input.profile, input.targetVersion, input.npmPlugins, toNpm)
    await updatePnpmWorkspaceOverrides(profileDir, input.profile, input.targetVersion, input.npmPlugins, toNpm)
    const pnpmCmd = await resolvePnpmCommand(env, osHome, platform)
    const res = await runPmCommand(
      pnpmCmd.command,
      [
        ...pnpmCmd.prefixArgs,
        'install',
        '--dir', profileDir,
        '--no-frozen-lockfile',
        '--ignore-scripts',
        '--config.confirmModulesPurge=false',
        '--registry', input.registryUrl,
      ],
      pnpmCmd.binDirs,
      pnpmCmd.envOverrides,
    )
    if (res.status !== 0) {
      const detail = res.stderr.trim() || res.stdout.trim()
      throw new Error(`profile ${input.profile} pnpm 升级失败（退出码 ${res.status}）：${detail}`)
    }
    return
  }

  const pluginSet = new Set(input.npmPlugins)
  if (toNpm) {
    for (const name of await collectProfileLocalEnhancedNames(profileDir)) pluginSet.add(name)
  }
  const specs = [...pluginSet].sort().map(pkg => `${pkg}@${input.targetVersion}`)
  if (specs.length === 0) return
  const npmCmd = await resolveFallbackBinary('npm', env, osHome, platform)
  const res = await runPmCommand(
    npmCmd.command,
    [
      'install',
      '--prefix', profileDir,
      '--legacy-peer-deps',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      '--registry', input.registryUrl,
      ...specs,
    ],
    npmCmd.binDir ? [npmCmd.binDir] : [],
    {},
  )
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
  await writeTextAtomically(plan.bindingPath, plan.candidateBindingSource, 0o600)
}

export async function defaultVerifyHealth(input: {
  dshHome: string
  profile?: string
  profiles: readonly string[]
  runner: CommandRunner
  platform: NodeJS.Platform
  osHome: string
  env: NodeJS.ProcessEnv
  requireAutonomyReadinessProfiles?: readonly string[]
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
    return { ok: false, error: fails || 'dsh-ray doctor 检查未通过', report }
  }
  const enforcedProfiles = new Set(input.requireAutonomyReadinessProfiles ?? [])
  for (const prof of report.profiles) {
    if (!prof.configDumpOk) {
      return { ok: false, error: `profile ${prof.profile} 配置转储失败：${prof.configDumpError ?? 'unknown'}`, report }
    }
    if (enforcedProfiles.has(prof.profile) && prof.autonomyReadiness?.checked && !prof.autonomyReadiness.ok) {
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
  readonly hasModulesYaml: boolean
  readonly pnpmDirExisted: boolean
  readonly backedPnpmPackages: readonly string[]
}

interface CoordinatorMarkerBackup {
  readonly src: string
  readonly dst: string
  readonly hadFile: boolean
}

interface CohortBackupRecord {
  readonly name: string
  readonly src: string
  readonly dst: string
  readonly dirMode: number
  readonly receiptMode?: number
}

interface SupervisorBackupRecord {
  readonly profile: string
  readonly configSrc: string
  readonly configDst: string
  readonly serviceSrc: string
  readonly serviceDst: string
  readonly hasService: boolean
}

interface LedgerBackupRecord {
  readonly src: string
  readonly dst: string
  readonly walSrc: string
  readonly walDst: string
  readonly hadWal: boolean
  readonly shmSrc: string
  readonly shmDst: string
  readonly hadShm: boolean
}

interface RestartSupervisorTarget {
  readonly profile: string
  readonly configPath: string
  readonly serviceName: string
  readonly timerName: string
  readonly servicePath: string
  readonly config: Record<string, unknown>
  readonly hasService: boolean
}

async function readCheckedRegularBytes(filePath: string, maxBytes: number, label: string): Promise<Buffer> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    const named = await lstat(filePath)
    if (!before.isFile() || !named.isFile() || named.isSymbolicLink()
      || before.uid !== process.getuid?.() || before.dev !== named.dev || before.ino !== named.ino
      || (before.mode & 0o022) !== 0 || before.size < 1 || before.size > maxBytes) {
      throw new Error(`${label}文件不安全：${filePath}`)
    }
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (bytes.length !== before.size || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`${label}读取期间变化：${filePath}`)
    }
    return bytes
  } finally {
    await handle.close()
  }
}

function sha256Buffer(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function resolveRestartSupervisorTarget(
  osHome: string,
  profile: string,
  canonicalHome: string,
): Promise<RestartSupervisorTarget | undefined> {
  const configPath = join(osHome, '.local', 'state', 'dsh-ray', 'restart-supervisor', profile, 'config.json')
  let configBytes: Buffer
  try {
    configBytes = await readCheckedRegularBytes(configPath, 2_000_000, 'restart-supervisor 配置')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(configBytes.toString('utf8'))
  } catch {
    return undefined
  }
  const config = asObject(parsed)
  if (!config || config.dshHome !== canonicalHome || config.profile !== profile) {
    return undefined
  }
  const serviceName = `dsh-restart-supervisor-${profile}.service`
  const timerName = `dsh-restart-supervisor-${profile}.timer`
  const servicePath = join(osHome, '.config', 'systemd', 'user', serviceName)
  const serviceMeta = await lstat(servicePath).catch(() => undefined)
  const hasService = Boolean(serviceMeta && serviceMeta.isFile() && !serviceMeta.isSymbolicLink())
  return { profile, configPath, serviceName, timerName, servicePath, config, hasService }
}

async function collectInstalledEnhancedPackageRoots(
  profileDir: string,
  canonicalHome: string,
  targetEnhancedVersion?: string,
): Promise<Map<string, string>> {
  const roots = new Map<string, string>()
  const homePrefix = canonicalHome.endsWith(sep) ? canonicalHome : `${canonicalHome}${sep}`
  const directDir = join(profileDir, 'node_modules', '@dsh-ray')
  const directEntries = await readdir(directDir).catch(() => [] as string[])
  for (const entry of [...directEntries].sort()) {
    const candidate = join(directDir, entry)
    const real = await realpath(candidate).catch(() => undefined)
    if (!real || !real.startsWith(homePrefix)) continue
    try {
      const manifestBytes = await readCheckedRegularBytes(join(real, 'package.json'), 2_000_000, 'package.json')
      const manifest = asObject(JSON.parse(manifestBytes.toString('utf8')))
      if (manifest && manifest.name === `@dsh-ray/${entry}`) {
        roots.set(manifest.name, real)
      }
    } catch {
      // Ignore unreadable package roots here; required roots are verified below.
    }
  }

  const pnpmDir = join(profileDir, 'node_modules', '.pnpm')
  const pnpmEntries = await readdir(pnpmDir).catch(() => [] as string[])
  const candidatesByPkg = new Map<string, Array<{ root: string; version: string | undefined }>>()
  for (const entry of [...pnpmEntries].sort()) {
    if (!entry.startsWith('@dsh-ray+')) continue
    const atIndex = entry.indexOf('@', '@dsh-ray+'.length)
    if (atIndex <= '@dsh-ray+'.length) continue
    const slug = entry.slice('@dsh-ray+'.length, atIndex)
    const pkgName = `@dsh-ray/${slug}`
    if (roots.has(pkgName)) continue
    const candidate = join(pnpmDir, entry, 'node_modules', '@dsh-ray', slug)
    const real = await realpath(candidate).catch(() => undefined)
    if (!real || !real.startsWith(homePrefix)) continue
    try {
      const manifestBytes = await readCheckedRegularBytes(join(real, 'package.json'), 2_000_000, 'package.json')
      const manifest = asObject(JSON.parse(manifestBytes.toString('utf8')))
      if (!manifest || manifest.name !== pkgName) continue
      const list = candidatesByPkg.get(pkgName) ?? []
      list.push({ root: real, version: typeof manifest.version === 'string' ? manifest.version : undefined })
      candidatesByPkg.set(pkgName, list)
    } catch {
      // Skip non-package entries
    }
  }

  for (const [pkgName, list] of candidatesByPkg) {
    const preferred = targetEnhancedVersion
      ? list.find(item => item.version === targetEnhancedVersion) ?? list[0]
      : list[0]
    if (preferred) roots.set(pkgName, preferred.root)
  }
  return roots
}

async function collectPackageTrustedFiles(
  packageRoot: string,
  canonicalHome: string,
): Promise<Array<{ path: string; digest: string }>> {
  const homePrefix = canonicalHome.endsWith(sep) ? canonicalHome : `${canonicalHome}${sep}`
  const collected: Array<{ path: string; digest: string }> = []
  const addFile = async (filePath: string): Promise<void> => {
    if (!filePath.startsWith(homePrefix)) {
      throw new Error(`trustedFile 越界 DSH_HOME：${filePath}`)
    }
    const bytes = await readCheckedRegularBytes(filePath, 2_000_000, 'trustedFile')
    collected.push({ path: filePath, digest: sha256Buffer(bytes) })
  }

  await addFile(join(packageRoot, 'package.json'))
  const patchPath = join(packageRoot, 'cordis.patch.yml')
  if (await lstat(patchPath).then(m => m.isFile() && !m.isSymbolicLink(), () => false)) {
    await addFile(patchPath)
  }

  const walkCodeDir = async (dirPath: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dirPath, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(dirPath, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await walkCodeDir(child)
      } else if (entry.isFile() && /\.(?:js|mjs|cjs)$/u.test(entry.name)) {
        await addFile(child)
      }
    }
  }

  await walkCodeDir(join(packageRoot, 'lib'))
  await walkCodeDir(join(packageRoot, 'bin'))
  return collected
}

async function refreshRestartSupervisorForProfile(input: {
  target: RestartSupervisorTarget
  canonicalHome: string
  osHome: string
  targetEnhancedVersion?: string
}): Promise<{ updatedService: boolean }> {
  const { target, canonicalHome, osHome, targetEnhancedVersion } = input
  const profileDir = join(profilesDirectory(canonicalHome), target.profile)
  const roots = await collectInstalledEnhancedPackageRoots(profileDir, canonicalHome, targetEnhancedVersion)
  if (roots.size === 0) {
    throw new Error(`profile ${target.profile} 未找到可钉死的 @dsh-ray/* 包目录`)
  }
  const deliveryRoot = roots.get('@dsh-ray/assistant-delivery')
  const policyRoot = roots.get('@dsh-ray/assistant-policy')
  if (!deliveryRoot || !policyRoot) {
    throw new Error(`profile ${target.profile} 缺少 assistant-delivery 或 assistant-policy 包目录，无法刷新 restart-supervisor`)
  }
  const helperPath = join(deliveryRoot, 'bin', 'dsh-restart-supervisor.js')
  const policyEvaluatorPath = join(policyRoot, 'lib', 'evaluator.js')
  await readCheckedRegularBytes(helperPath, 2_000_000, 'dsh-restart-supervisor helper')
  await readCheckedRegularBytes(policyEvaluatorPath, 2_000_000, 'policy evaluator')

  const trustedByPath = new Map<string, string>()
  for (const pkgName of [...roots.keys()].sort()) {
    const files = await collectPackageTrustedFiles(roots.get(pkgName)!, canonicalHome)
    for (const file of files) {
      trustedByPath.set(file.path, file.digest)
    }
  }
  const trustedFiles = [...trustedByPath.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, digest]) => ({ path, digest }))
  if (trustedFiles.length < 3 || trustedFiles.length > 4096 || !trustedByPath.has(policyEvaluatorPath)) {
    throw new Error(`profile ${target.profile} restart-supervisor trustedFiles 无效（count=${trustedFiles.length}）`)
  }

  const profilePatchDigest = sha256Buffer(
    await readCheckedRegularBytes(join(profileDir, 'cordis.patch.yml'), 2_000_000, 'profile cordis.patch.yml'),
  )

  let expectedUnitDigest = target.config.expectedUnitDigest
  if (typeof target.config.unit === 'string') {
    const unitFile = join(osHome, '.config', 'systemd', 'user', target.config.unit)
    const unitMeta = await lstat(unitFile).catch(() => undefined)
    if (unitMeta && unitMeta.isFile() && !unitMeta.isSymbolicLink()) {
      expectedUnitDigest = sha256Buffer(await readCheckedRegularBytes(unitFile, 2_000_000, 'profile systemd unit'))
    }
  }

  let hostBindingDigest = target.config.hostBindingDigest
  let hostReceiptPath = target.config.hostReceiptPath
  let hostReceiptSourceDigest = target.config.hostReceiptSourceDigest
  const bindingFile = join(canonicalHome, '.dsh-ray-host.json')
  const bindingMeta = await lstat(bindingFile).catch(() => undefined)
  if (bindingMeta && bindingMeta.isFile() && !bindingMeta.isSymbolicLink()) {
    const bindingBytes = await readCheckedRegularBytes(bindingFile, 16_384, '.dsh-ray-host.json')
    hostBindingDigest = sha256Buffer(bindingBytes)
    const bound = asObject(JSON.parse(bindingBytes.toString('utf8')))
    if (bound && typeof bound.cacheRoot === 'string' && typeof bound.version === 'string') {
      const nextReceiptPath = join(bound.cacheRoot, bound.version, 'receipt.json')
      const homePrefix = canonicalHome.endsWith(sep) ? canonicalHome : `${canonicalHome}${sep}`
      if (nextReceiptPath.startsWith(homePrefix)) {
        throw new Error(`hostReceiptPath 不得位于 DSH_HOME 内：${nextReceiptPath}`)
      }
      hostReceiptPath = nextReceiptPath
      hostReceiptSourceDigest = sha256Buffer(
        await readCheckedRegularBytes(nextReceiptPath, 33_554_432, 'host receipt.json'),
      )
    }
  }

  const refreshedConfig = {
    ...target.config,
    policyEvaluatorPath,
    trustedFiles,
    profilePatchDigest,
    expectedUnitDigest,
    hostBindingDigest,
    hostReceiptPath,
    hostReceiptSourceDigest,
  }
  await writeTextAtomically(target.configPath, `${JSON.stringify(refreshedConfig, null, 2)}\n`, 0o600)

  let updatedService = false
  if (target.hasService) {
    const serviceMeta = await lstat(target.servicePath)
    const serviceMode = serviceMeta.mode & 0o777
    const serviceRaw = (await readCheckedRegularBytes(target.servicePath, 262_144, 'restart-supervisor service')).toString('utf8')
    const execStartRe = /^ExecStart=(.+?\s+)("?)([^\s"]+\/bin\/dsh-restart-supervisor\.js)\2(\s+.*)$/mu
    if (!execStartRe.test(serviceRaw)) {
      throw new Error(`restart-supervisor service ExecStart 未匹配 helper 路径：${target.servicePath}`)
    }
    const nextService = serviceRaw.replace(execStartRe, (_m, prefix, quote, _oldHelper, suffix) =>
      `ExecStart=${String(prefix)}${String(quote)}${helperPath}${String(quote)}${String(suffix)}`,
    )
    if (nextService !== serviceRaw) {
      await writeTextAtomically(target.servicePath, nextService, serviceMode)
    }
    updatedService = true
  }
  return { updatedService }
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

async function restoreRegularFileFromBackup(src: string, dst: string): Promise<void> {
  const meta = await lstat(src)
  const tmp = `${dst}.rollback-${process.pid}-${Date.now()}`
  try {
    await cp(src, tmp, { force: true })
    await chmod(tmp, meta.mode & 0o777)
    await rename(tmp, dst)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

async function createUpgradeBackup(
  dshHome: string,
  profiles: readonly string[],
  supervisorTargets: readonly RestartSupervisorTarget[] = [],
  options: { coordinatorMarkerPath?: string; removeCohortNames?: readonly string[] } = {},
): Promise<{
  backupDir: string
  hadHostBinding: boolean
  coordinatorMarker?: CoordinatorMarkerBackup
  cohortsRootDir: string
  cohortsRootMode?: number
  cohortBackups: CohortBackupRecord[]
  profileBackups: ProfileBackupRecord[]
  ledgerBackups: LedgerBackupRecord[]
  supervisorBackups: SupervisorBackupRecord[]
  backupFiles: string[]
}> {
  const stamp = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}`
  const backupDir = join(dshHome, '.dsh-ray-upgrade-backups', stamp)
  await mkdir(backupDir, { recursive: true, mode: 0o700 })

  const backupFiles: string[] = []
  const hostBindingSrc = join(dshHome, '.dsh-ray-host.json')
  const hostBindingDst = join(backupDir, '.dsh-ray-host.json')
  const hadHostBinding = await copyIfRegularFile(hostBindingSrc, hostBindingDst)
  if (hadHostBinding) backupFiles.push(hostBindingSrc)

  let coordinatorMarker: CoordinatorMarkerBackup | undefined
  if (options.coordinatorMarkerPath) {
    const markerDst = join(backupDir, '.rsi-coordinator.json')
    const hadFile = await copyIfRegularFile(options.coordinatorMarkerPath, markerDst)
    if (hadFile) backupFiles.push(options.coordinatorMarkerPath)
    coordinatorMarker = { src: options.coordinatorMarkerPath, dst: markerDst, hadFile }
  }

  const cohortsRootDir = join(dshHome, 'rsi-local-cohorts')
  let cohortsRootMode: number | undefined
  const cohortBackups: CohortBackupRecord[] = []
  if (options.removeCohortNames && options.removeCohortNames.length > 0) {
    const rootMeta = await lstat(cohortsRootDir).catch(() => undefined)
    if (rootMeta && rootMeta.isDirectory() && !rootMeta.isSymbolicLink()) {
      cohortsRootMode = rootMeta.mode & 0o777
      await mkdir(join(backupDir, 'rsi-local-cohorts'), { recursive: true, mode: 0o700 })
      for (const name of options.removeCohortNames) {
        const src = join(cohortsRootDir, name)
        const meta = await lstat(src).catch(() => undefined)
        if (!meta || !meta.isDirectory() || meta.isSymbolicLink()) continue
        const dst = join(backupDir, 'rsi-local-cohorts', name)
        await cp(src, dst, { recursive: true, force: true, verbatimSymlinks: true })
        const receiptMeta = await lstat(join(src, 'receipt.json')).catch(() => undefined)
        const receiptMode = receiptMeta && receiptMeta.isFile() && !receiptMeta.isSymbolicLink()
          ? receiptMeta.mode & 0o777
          : undefined
        cohortBackups.push({
          name,
          src,
          dst,
          dirMode: meta.mode & 0o777,
          ...(receiptMode !== undefined ? { receiptMode } : {}),
        })
      }
    }
  }

  const ledgerBackupDir = join(backupDir, 'ledgers')
  let createdLedgerBackupDir = false
  const seenLedgerPaths = new Set<string>()
  const ledgerBackups: LedgerBackupRecord[] = []
  let ledgerIndex = 0

  const profileBackups: ProfileBackupRecord[] = []
  for (const profile of profiles) {
    const profileDir = join(profilesDirectory(dshHome), profile)
    const profBackupDir = join(backupDir, 'profiles', profile)
    await mkdir(profBackupDir, { recursive: true, mode: 0o700 })
    const backedFiles: string[] = []
    for (const fileName of PROFILE_BACKUP_FILES) {
      const src = join(profileDir, fileName)
      const dst = join(profBackupDir, fileName)
      if (await copyIfRegularFile(src, dst)) {
        backedFiles.push(fileName)
        backupFiles.push(src)
      }
    }
    const enhancedDir = join(profileDir, 'node_modules', '@dsh-ray')
    let hasEnhancedModules = false
    try {
      const meta = await lstat(enhancedDir)
      if (meta.isDirectory()) {
        await cp(enhancedDir, join(profBackupDir, '@dsh-ray'), {
          recursive: true,
          force: true,
          verbatimSymlinks: true,
        })
        hasEnhancedModules = true
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const modulesYamlSrc = join(profileDir, 'node_modules', '.modules.yaml')
    const modulesYamlDst = join(profBackupDir, '.modules.yaml')
    const hasModulesYaml = await copyIfRegularFile(modulesYamlSrc, modulesYamlDst)
    if (hasModulesYaml) backupFiles.push(modulesYamlSrc)

    const pnpmDir = join(profileDir, 'node_modules', '.pnpm')
    let pnpmDirExisted = false
    const backedPnpmPackages: string[] = []
    const pnpmMeta = await lstat(pnpmDir).catch(() => undefined)
    if (pnpmMeta && pnpmMeta.isDirectory() && !pnpmMeta.isSymbolicLink()) {
      pnpmDirExisted = true
      const pnpmEntries = await readdir(pnpmDir).catch(() => [] as string[])
      const enhancedStoreEntries = pnpmEntries.filter(entry => entry.startsWith('@dsh-ray+'))
      if (enhancedStoreEntries.length > 0) {
        const storeBackupDir = join(profBackupDir, '.pnpm-enhanced')
        await mkdir(storeBackupDir, { recursive: true, mode: 0o700 })
        for (const entry of enhancedStoreEntries) {
          const entrySrc = join(pnpmDir, entry)
          const entryMeta = await lstat(entrySrc).catch(() => undefined)
          if (!entryMeta || !entryMeta.isDirectory() || entryMeta.isSymbolicLink()) continue
          await cp(entrySrc, join(storeBackupDir, entry), {
            recursive: true,
            force: true,
            verbatimSymlinks: true,
          })
          backedPnpmPackages.push(entry)
        }
      }
    }

    profileBackups.push({
      profile,
      profileDir,
      backupDir: profBackupDir,
      files: backedFiles,
      hasEnhancedModules,
      hasModulesYaml,
      pnpmDirExisted,
      backedPnpmPackages,
    })

    let configuredDbPaths: string[] = []
    const patch = await readProfilePatchText(dshHome, profile)
    if (patch.text !== undefined) {
      try {
        configuredDbPaths = extractConfiguredDbPaths(patch.text, dshHome)
      } catch {
        configuredDbPaths = []
      }
    }
    for (const dbPath of candidateLedgerPaths(dshHome, profile, configuredDbPaths)) {
      if (seenLedgerPaths.has(dbPath)) continue
      seenLedgerPaths.add(dbPath)
      const ledgerMeta = await lstat(dbPath).catch(() => undefined)
      if (!ledgerMeta || !ledgerMeta.isFile() || ledgerMeta.isSymbolicLink()) continue
      if (!createdLedgerBackupDir) {
        await mkdir(ledgerBackupDir, { recursive: true, mode: 0o700 })
        createdLedgerBackupDir = true
      }
      const id = ledgerIndex++
      const dst = join(ledgerBackupDir, `ledger-${id}.sqlite`)
      if (!(await copyIfRegularFile(dbPath, dst))) continue
      backupFiles.push(dbPath)
      const walSrc = `${dbPath}-wal`
      const walDst = `${dst}-wal`
      const hadWal = await copyIfRegularFile(walSrc, walDst)
      if (hadWal) backupFiles.push(walSrc)
      const shmSrc = `${dbPath}-shm`
      const shmDst = `${dst}-shm`
      const hadShm = await copyIfRegularFile(shmSrc, shmDst)
      if (hadShm) backupFiles.push(shmSrc)
      ledgerBackups.push({ src: dbPath, dst, walSrc, walDst, hadWal, shmSrc, shmDst, hadShm })
    }
  }

  const supervisorBackups: SupervisorBackupRecord[] = []
  for (const target of supervisorTargets) {
    const supBackupDir = join(backupDir, 'restart-supervisor', target.profile)
    await mkdir(supBackupDir, { recursive: true, mode: 0o700 })
    const configDst = join(supBackupDir, 'config.json')
    if (await copyIfRegularFile(target.configPath, configDst)) {
      backupFiles.push(target.configPath)
      const serviceDst = join(supBackupDir, target.serviceName)
      const hasService = target.hasService && await copyIfRegularFile(target.servicePath, serviceDst)
      if (hasService) backupFiles.push(target.servicePath)
      supervisorBackups.push({
        profile: target.profile,
        configSrc: target.configPath,
        configDst,
        serviceSrc: target.servicePath,
        serviceDst,
        hasService,
      })
    }
  }

  return {
    backupDir,
    hadHostBinding,
    ...(coordinatorMarker ? { coordinatorMarker } : {}),
    cohortsRootDir,
    ...(cohortsRootMode !== undefined ? { cohortsRootMode } : {}),
    cohortBackups,
    profileBackups,
    ledgerBackups,
    supervisorBackups,
    backupFiles,
  }
}

async function restoreUpgradeBackup(
  dshHome: string,
  backup: Awaited<ReturnType<typeof createUpgradeBackup>>,
): Promise<boolean> {
  try {
    const hostBindingDst = join(dshHome, '.dsh-ray-host.json')
    if (backup.hadHostBinding) {
      const raw = await readFile(join(backup.backupDir, '.dsh-ray-host.json'))
      const tmp = `${hostBindingDst}.rollback-${process.pid}`
      await writeFile(tmp, raw, { mode: 0o600 })
      await rename(tmp, hostBindingDst)
    } else {
      await rm(hostBindingDst, { force: true })
    }

    if (backup.coordinatorMarker) {
      if (backup.coordinatorMarker.hadFile) {
        await restoreRegularFileFromBackup(backup.coordinatorMarker.dst, backup.coordinatorMarker.src)
      } else {
        await rm(backup.coordinatorMarker.src, { force: true })
      }
    }

    if (backup.cohortBackups.length > 0) {
      const rootMode = backup.cohortsRootMode ?? 0o700
      await mkdir(backup.cohortsRootDir, { recursive: true, mode: rootMode })
      await chmod(backup.cohortsRootDir, rootMode)
      for (const item of backup.cohortBackups) {
        await rm(item.src, { recursive: true, force: true })
        await cp(item.dst, item.src, { recursive: true, force: true, verbatimSymlinks: true })
        await chmod(item.src, item.dirMode)
        if (item.receiptMode !== undefined) {
          const receiptPath = join(item.src, 'receipt.json')
          if (existsSync(receiptPath)) await chmod(receiptPath, item.receiptMode)
        }
      }
    }

    for (const item of backup.profileBackups) {
      for (const fileName of PROFILE_BACKUP_FILES) {
        const src = join(item.backupDir, fileName)
        const dst = join(item.profileDir, fileName)
        if (item.files.includes(fileName)) {
          await restoreRegularFileFromBackup(src, dst)
        } else {
          await rm(dst, { force: true })
        }
      }
      const modulesYamlDst = join(item.profileDir, 'node_modules', '.modules.yaml')
      if (item.hasModulesYaml) {
        await mkdir(join(item.profileDir, 'node_modules'), { recursive: true })
        await restoreRegularFileFromBackup(join(item.backupDir, '.modules.yaml'), modulesYamlDst)
      } else if (item.pnpmDirExisted) {
        await rm(modulesYamlDst, { force: true })
      }
      if (item.pnpmDirExisted) {
        const pnpmDir = join(item.profileDir, 'node_modules', '.pnpm')
        await mkdir(pnpmDir, { recursive: true })
        const currentEntries = await readdir(pnpmDir).catch(() => [] as string[])
        for (const entry of currentEntries) {
          if (entry.startsWith('@dsh-ray+')) {
            await rm(join(pnpmDir, entry), { recursive: true, force: true })
          }
        }
        for (const entry of item.backedPnpmPackages) {
          await cp(join(item.backupDir, '.pnpm-enhanced', entry), join(pnpmDir, entry), {
            recursive: true,
            force: true,
            verbatimSymlinks: true,
          })
        }
      }
      const enhancedDst = join(item.profileDir, 'node_modules', '@dsh-ray')
      await rm(enhancedDst, { recursive: true, force: true })
      if (item.hasEnhancedModules) {
        await mkdir(join(item.profileDir, 'node_modules'), { recursive: true })
        await cp(join(item.backupDir, '@dsh-ray'), enhancedDst, {
          recursive: true,
          force: true,
          verbatimSymlinks: true,
        })
      }
    }

    for (const ledger of backup.ledgerBackups) {
      await restoreRegularFileFromBackup(ledger.dst, ledger.src)
      if (ledger.hadWal) {
        await restoreRegularFileFromBackup(ledger.walDst, ledger.walSrc)
      } else {
        await rm(ledger.walSrc, { force: true })
      }
      if (ledger.hadShm) {
        await restoreRegularFileFromBackup(ledger.shmDst, ledger.shmSrc)
      } else {
        await rm(ledger.shmSrc, { force: true })
      }
    }

    for (const sup of backup.supervisorBackups) {
      await restoreRegularFileFromBackup(sup.configDst, sup.configSrc)
      if (sup.hasService) {
        await restoreRegularFileFromBackup(sup.serviceDst, sup.serviceSrc)
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
  const inspectServiceFn = deps.inspectService ?? inspectManagedServiceForDshHome
  const scanProcessesFn = deps.scanProcesses ?? scanRunningProfiles

  const blockedReasons: string[] = []
  const homeIsAbsolute = isAbsolute(options.dshHome)
  let homeUsable = homeIsAbsolute
  let canonicalHome = options.dshHome
  if (!homeIsAbsolute) {
    blockedReasons.push(`DSH_HOME 必须是绝对路径：${options.dshHome}`)
  } else {
    try {
      const homeMeta = await lstat(options.dshHome)
      if (homeMeta.isSymbolicLink()) {
        homeUsable = false
        blockedReasons.push(`dshHome must not be a symlink：${options.dshHome}`)
      } else if (!homeMeta.isDirectory()) {
        homeUsable = false
        blockedReasons.push(`DSH_HOME 非普通目录：${options.dshHome}`)
      } else {
        canonicalHome = await realpath(options.dshHome)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        homeUsable = false
        blockedReasons.push(`无法检查 DSH_HOME：${options.dshHome}`)
      }
    }
  }

  const registryUrl = validateRegistryUrl(options.registryUrl ?? env.npm_config_registry ?? DEFAULT_REGISTRY_URL)

  // 1. Detect frozen Linux systemd owner mode cleanly (Linux-only; avoid POSIX uid/mode checks on Windows/macOS).
  const toNpm = Boolean(options.toNpm)
  let frozenOwner: FrozenOwner | undefined
  let frozenError: string | undefined
  if (platform === 'linux' && homeUsable) {
    try {
      frozenOwner = await detectFrozen(canonicalHome)
    } catch (error) {
      frozenError = error instanceof Error ? error.message : String(error)
      blockedReasons.push(frozenError)
    }
  }

  const coordinatorPair = homeUsable ? await readRsiCoordinatorPair(canonicalHome) : undefined
  const discoveredProfiles = homeUsable ? await listProfiles(canonicalHome) : []
  let targetProfiles = discoveredProfiles
  if (options.profile !== undefined && homeUsable) {
    if (!discoveredProfiles.includes(options.profile)) {
      blockedReasons.push(`指定 profile 不存在：${options.profile}`)
      targetProfiles = []
    } else if (
      coordinatorPair
      && (!frozenOwner || toNpm)
      && (options.profile === coordinatorPair.targetProfile || options.profile === coordinatorPair.coordinatorProfile)
      && discoveredProfiles.includes(coordinatorPair.targetProfile)
      && discoveredProfiles.includes(coordinatorPair.coordinatorProfile)
    ) {
      targetProfiles = [coordinatorPair.targetProfile, coordinatorPair.coordinatorProfile]
    } else {
      targetProfiles = [options.profile]
    }
  }
  if (frozenOwner && options.profile !== undefined && options.profile !== frozenOwner.profile) {
    const allowedCoordinator = toNpm && coordinatorPair !== undefined && options.profile === coordinatorPair.coordinatorProfile
    if (!allowedCoordinator) {
      blockedReasons.push(`frozen systemd profile 固定为 ${frozenOwner.profile}，不可选择 ${options.profile}`)
    }
  }

  let mode: UpgradeMode = 'standard-local'
  if (frozenOwner && !toNpm) {
    mode = 'frozen-linux-systemd'
  } else if (platform === 'darwin' && homeUsable) {
    for (const profile of targetProfiles) {
      const launchdDef = await inspectLaunchdDefinition(osHome, canonicalHome, profile, runner)
      if (launchdDef.exists) {
        mode = 'macos-launchd'
        break
      }
    }
  }

  // 2. Inspect .dsh-ray-host.json binding integrity.
  const fileIntegrity = homeUsable
    ? await checkBoundHostFileIntegrity(canonicalHome)
    : { status: 'missing' as BoundHostStatus }
  let boundHostStatus: BoundHostStatus = fileIntegrity.status
  let boundHostVersion: string | undefined
  let boundHostPath: string | undefined
  let boundHostError: string | undefined = fileIntegrity.error

  if (homeUsable && fileIntegrity.status === 'ready') {
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

  // 3. Inspect installed @dsh-ray/* packages per profile.
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
  const allowNonEmptyHistoryMigration = Boolean(options.allowNonEmptyHistoryMigration)
  const profileReadiness: ProfileLedgerReadiness[] = []
  for (const profile of targetProfiles) {
    const ledger = await inspectProfileLedgerReadiness(canonicalHome, profile, allowNonEmptyHistoryMigration)
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

  const explicitTargetVersion = options.targetVersion?.trim()
  if (options.targetVersion !== undefined && (!explicitTargetVersion || !SEMVER_RE.test(explicitTargetVersion))) {
    blockedReasons.push(`无效的目标版本号：${options.targetVersion}`)
  }
  const explicitDshVersion = options.dshVersion?.trim()
  if (options.dshVersion !== undefined && (!explicitDshVersion || !SEMVER_RE.test(explicitDshVersion))) {
    blockedReasons.push(`无效的 Host 目标版本号：${options.dshVersion}`)
  } else if (explicitDshVersion && !isSupportedCandidateVersion(explicitDshVersion) && !deps.upgradeHost) {
    blockedReasons.push(`不支持的 Host 目标版本 ${explicitDshVersion}：当前仅支持已验证基线 ${FROZEN_DSH_SELECTOR}`)
  }
  if (explicitDshVersion && boundHostStatus === 'missing' && !deps.upgradeHost) {
    blockedReasons.push('现有 Home 没有私有 Host 绑定；不能用 --dsh-version 修改全局 Host。')
  }

  const shouldCheckRegistry = typeof fetchImpl === 'function'
  if (shouldCheckRegistry) {
    const [cliQuery, dshQuery] = await Promise.all([
      fetchNpmLatestVersion(fetchImpl, registryUrl, '@dsh-ray/cli', timeoutMs),
      mode === 'frozen-linux-systemd'
        ? Promise.resolve({ ok: true as const, latest: FROZEN_DSH_SELECTOR })
        : fetchNpmLatestVersion(fetchImpl, registryUrl, '@deepseek-ai/dsh', timeoutMs),
    ])
    if (cliQuery.ok || dshQuery.ok) {
      registryStatus = 'ok'
      if (cliQuery.ok) latestEnhancedVersion = cliQuery.latest
      if (dshQuery.ok) latestDshHostVersion = dshQuery.latest
      if (!cliQuery.ok) registryError = cliQuery.error
      if (!dshQuery.ok) registryError = registryError ? `${registryError}; ${dshQuery.error}` : dshQuery.error
    } else {
      registryStatus = 'unavailable'
      registryError = cliQuery.error === dshQuery.error ? cliQuery.error : `${cliQuery.error}; ${dshQuery.error}`
    }
  }

  const targetEnhancedVersion = explicitTargetVersion || latestEnhancedVersion
  // Clamp automatic Host target to the validated baseline when upstream publishes a newer untested rc/version.
  const targetDshVersion = mode === 'frozen-linux-systemd'
    ? (explicitDshVersion || FROZEN_DSH_SELECTOR)
    : (explicitDshVersion || (
      latestDshHostVersion && !isSupportedCandidateVersion(latestDshHostVersion) && semverIsNewer(latestDshHostVersion, FROZEN_DSH_SELECTOR)
        ? FROZEN_DSH_SELECTOR
        : latestDshHostVersion
    ))

  const enhancedUpgradeAvailable = semverIsNewer(targetEnhancedVersion, installedEnhancedVersion)
  const hostUpgradeAvailable = boundHostStatus === 'ready'
    ? semverIsNewer(targetDshVersion, boundHostVersion)
    : false
  const profileLocalSpecs = new Map<string, boolean>()
  if (toNpm && homeUsable) {
    for (const profile of targetProfiles) {
      profileLocalSpecs.set(profile, await inspectProfileHasLocalEnhancedSpecs(canonicalHome, profile))
    }
  }
  const cohortsToClean: string[] = []
  if (toNpm && homeUsable && mode !== 'frozen-linux-systemd') {
    const cohortsRoot = join(canonicalHome, 'rsi-local-cohorts')
    const cohortEntries = await readdir(cohortsRoot).catch(() => [] as string[])
    const pairTargeted = coordinatorPair !== undefined
      && (targetProfiles.includes(coordinatorPair.targetProfile) || targetProfiles.includes(coordinatorPair.coordinatorProfile))
    for (const entry of cohortEntries.sort()) {
      const matchesTarget = targetProfiles.includes(entry)
        || (pairTargeted && (entry === coordinatorPair!.targetProfile || /^host-migration-[a-f0-9]{20}$/u.test(entry)))
      if (!matchesTarget) continue
      const meta = await lstat(join(cohortsRoot, entry)).catch(() => undefined)
      if (meta && meta.isDirectory() && !meta.isSymbolicLink()) cohortsToClean.push(entry)
    }
  }
  const coordinatorPairTargeted = Boolean(
    coordinatorPair
    && mode !== 'frozen-linux-systemd'
    && (targetProfiles.includes(coordinatorPair.targetProfile) || targetProfiles.includes(coordinatorPair.coordinatorProfile)),
  )
  const coordinatorNeedsSync = Boolean(
    coordinatorPairTargeted
    && coordinatorPair
    && targetEnhancedVersion
    && ((toNpm && coordinatorPair.sourceRepository !== null) || coordinatorPair.version !== targetEnhancedVersion),
  )

  const readinessOk = blockedReasons.length === 0 && bindingOk && ledgersOk

  // Compute concrete plan steps & backup manifest.
  const supervisorTargets: RestartSupervisorTarget[] = []
  if (platform === 'linux' && homeUsable && mode !== 'frozen-linux-systemd') {
    for (const profile of targetProfiles) {
      const target = await resolveRestartSupervisorTarget(osHome, profile, canonicalHome)
      if (target) supervisorTargets.push(target)
    }
  }

  const backupFiles: string[] = []
  if (boundHostStatus === 'ready') backupFiles.push(join(canonicalHome, '.dsh-ray-host.json'))
  if (coordinatorPair && (coordinatorNeedsSync || cohortsToClean.length > 0)) {
    backupFiles.push(coordinatorPair.markerPath)
  }
  for (const cohortName of cohortsToClean) {
    const receiptCandidate = join(canonicalHome, 'rsi-local-cohorts', cohortName, 'receipt.json')
    if (existsSync(receiptCandidate)) backupFiles.push(receiptCandidate)
  }
  for (const profile of targetProfiles) {
    for (const fileName of PROFILE_BACKUP_FILES) {
      const candidate = join(profilesDirectory(canonicalHome), profile, fileName)
      if (existsSync(candidate)) backupFiles.push(candidate)
    }
  }
  for (const sup of supervisorTargets) {
    backupFiles.push(sup.configPath)
    if (sup.hasService) backupFiles.push(sup.servicePath)
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
      const hasLocalSpecs = profileLocalSpecs.get(prof.profile) === true
      if (hasLocalSpecs && targetEnhancedVersion) {
        steps.push(`切换并升级 profile ${prof.profile} @dsh-ray/* 为 npm（${prof.minVersion ?? installedEnhancedVersion} -> ${targetEnhancedVersion}）`)
      } else if (npmCount > 0 && targetEnhancedVersion && (enhancedUpgradeAvailable || options.targetVersion)) {
        steps.push(`升级 profile ${prof.profile} @dsh-ray/*（${prof.minVersion ?? installedEnhancedVersion} -> ${targetEnhancedVersion}）`)
      }
    }
    if (coordinatorNeedsSync || cohortsToClean.length > 0) {
      steps.push(toNpm
        ? `同步 .rsi-coordinator-*.json 为 npm 模式并清理 rsi-local-cohorts（保留 rsi-authorities 与凭据）`
        : `同步更新 .rsi-coordinator-*.json 版本为 ${targetEnhancedVersion}`)
    }
    if (supervisorTargets.length > 0) {
      steps.push(`同步刷新 ${supervisorTargets.map(s => s.serviceName).join(', ')} 配置与 ExecStart`)
    }
    steps.push('运行 dsh-ray doctor 就绪检查，失败时自动回滚备份')
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
      upgradeAvailable: enhancedUpgradeAvailable || hostUpgradeAvailable || [...profileLocalSpecs.values()].some(Boolean),
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
  const hostNeedsWork = (boundHostStatus === 'ready' || Boolean(deps.upgradeHost && options.dshVersion))
    && Boolean(targetDshVersion && (hostUpgradeAvailable || options.dshVersion))
    && targetDshVersion !== boundHostVersion
  const profilesNeedingWork = profileSummaries.filter((summary) => {
    const hasLocalSpecs = profileLocalSpecs.get(summary.profile) === true
    const hasNpm = (Object.keys(summary.installedVersions).length > 0 && summary.installKinds.includes('npm')) || hasLocalSpecs
    if (!hasNpm || !targetEnhancedVersion) return false
    return hasLocalSpecs
      || semverIsNewer(targetEnhancedVersion, summary.minVersion)
      || (options.targetVersion !== undefined && targetEnhancedVersion !== summary.minVersion)
  })

  if (!hostNeedsWork && profilesNeedingWork.length === 0 && !coordinatorNeedsSync && cohortsToClean.length === 0) {
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

    // 1b. Stop active dsh-restart-supervisor-<profile> timers/services before mutating .pnpm store.
    const stoppedSupervisorTimers: string[] = []
    for (const sup of supervisorTargets) {
      const timerActive = runner('systemctl', ['--user', 'is-active', sup.timerName]).status === 0
      const serviceActive = runner('systemctl', ['--user', 'is-active', sup.serviceName]).status === 0
      if (timerActive || serviceActive) {
        const stopRes = runner('systemctl', ['--user', 'stop', sup.timerName, sup.serviceName])
        if (stopRes.status !== 0) {
          const detail = stopRes.stderr.trim() || stopRes.stdout.trim() || `exit ${stopRes.status}`
          return {
            report: {
              ...baseReport,
              ok: false,
              ready: readinessOk,
              execution: {
                executed: false,
                dryRun: false,
                rolledBack: false,
                error: `无法停止 ${sup.timerName}/${sup.serviceName}：${detail}`,
              },
            },
            exitCode: 1,
          }
        }
        if (timerActive) stoppedSupervisorTimers.push(sup.timerName)
      }
    }

    // 2. Create transactional backup before any mutation.
    const backup = await createUpgradeBackup(canonicalHome, targetProfiles, supervisorTargets, {
      ...(coordinatorPair && (coordinatorNeedsSync || cohortsToClean.length > 0 || profilesNeedingWork.some(p => p.profile === coordinatorPair.targetProfile || p.profile === coordinatorPair.coordinatorProfile))
        ? { coordinatorMarkerPath: coordinatorPair.markerPath }
        : {}),
      ...(cohortsToClean.length > 0 ? { removeCohortNames: cohortsToClean } : {}),
    })
    let servicesRestarted = false

    try {
      if (hostNeedsWork && targetDshVersion) {
        await upgradeHostFn({ dshHome: canonicalHome, targetVersion: targetDshVersion })
      }
      for (const prof of profilesNeedingWork) {
        const plugins = await listProfilePlugins(canonicalHome, prof.profile)
        const hasLocalSpecs = profileLocalSpecs.get(prof.profile) === true
        const npmPlugins = toNpm
          ? [...new Set([
              ...plugins.map(p => p.name),
              ...(await collectProfileLocalEnhancedNames(join(profilesDirectory(canonicalHome), prof.profile))),
            ])].sort()
          : plugins.filter(p => p.kind === 'npm').map(p => p.name)
        if ((npmPlugins.length > 0 || hasLocalSpecs) && targetEnhancedVersion) {
          await upgradeProfileFn({
            dshHome: canonicalHome,
            profile: prof.profile,
            targetVersion: targetEnhancedVersion,
            registryUrl,
            npmPlugins,
            runner,
            ...(deps.detailedRunner ? { detailedRunner: deps.detailedRunner } : {}),
            ...(toNpm ? { toNpm: true } : {}),
            platform,
            osHome,
            env,
          })
        }
      }

      if (coordinatorPair && targetEnhancedVersion && (
        coordinatorNeedsSync
        || profilesNeedingWork.some(p => p.profile === coordinatorPair.targetProfile || p.profile === coordinatorPair.coordinatorProfile)
      )) {
        const nextSourceRepository = toNpm ? null : coordinatorPair.sourceRepository
        const updatedReceipt = {
          schemaVersion: 1,
          targetProfile: coordinatorPair.targetProfile,
          coordinatorProfile: coordinatorPair.coordinatorProfile,
          version: targetEnhancedVersion,
          sourceRepository: nextSourceRepository,
        }
        await writeTextAtomically(
          coordinatorPair.markerPath,
          `${JSON.stringify(updatedReceipt, null, 2)}\n`,
          coordinatorPair.mode || 0o600,
        )
      }

      if (toNpm && cohortsToClean.length > 0) {
        const cohortsRoot = join(canonicalHome, 'rsi-local-cohorts')
        for (const cohortName of cohortsToClean) {
          await rm(join(cohortsRoot, cohortName), { recursive: true, force: true })
        }
        const remaining = await readdir(cohortsRoot).catch(() => ['__keep__'])
        if (remaining.length === 0) {
          await rm(cohortsRoot, { recursive: true, force: true })
        }
      }

      // 2b. Refresh matching Linux restart-supervisor configs & systemd service ExecStart paths.
      let needDaemonReload = false
      const profilesSet = new Set(profilesNeedingWork.map(p => p.profile))
      for (const sup of supervisorTargets) {
        if (!hostNeedsWork && !profilesSet.has(sup.profile)) continue
        const refreshed = await refreshRestartSupervisorForProfile({
          target: sup,
          canonicalHome,
          osHome,
          ...(targetEnhancedVersion ? { targetEnhancedVersion } : {}),
        })
        if (refreshed.updatedService) needDaemonReload = true
      }
      if (needDaemonReload) {
        const reloadRes = runner('systemctl', ['--user', 'daemon-reload'])
        if (reloadRes.status !== 0) {
          const detail = reloadRes.stderr.trim() || reloadRes.stdout.trim() || `exit ${reloadRes.status}`
          throw new Error(`刷新 restart-supervisor 后 systemctl --user daemon-reload 失败：${detail}`)
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

      for (const timerName of stoppedSupervisorTimers) {
        const startTimerRes = runner('systemctl', ['--user', 'start', timerName])
        if (startTimerRes.status !== 0) {
          const detail = startTimerRes.stderr.trim() || startTimerRes.stdout.trim() || `exit ${startTimerRes.status}`
          throw new Error(`升级后重启 ${timerName} 失败：${detail}`)
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
        if (backup.supervisorBackups.some(b => b.hasService)) {
          try { runner('systemctl', ['--user', 'daemon-reload']) } catch { /* ignore */ }
        }
        for (const profile of previouslyRunning) {
          try { await controlServiceFn(platform, osHome, profile, 'start', runner, false, canonicalHome) } catch { /* ignore */ }
        }
        for (const timerName of stoppedSupervisorTimers) {
          try { runner('systemctl', ['--user', 'start', timerName]) } catch { /* ignore */ }
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
  lines.push(`=== dsh-ray upgrade (${report.action}) ===`)
  lines.push(`DSH_HOME：${report.dshHome}`)
  lines.push(`部署模式：${report.mode}${report.frozenSystemd.detected ? `（profiles: ${report.frozenSystemd.profiles.join(', ')}）` : ''}`)
  lines.push(`CLI 版本：${report.packages.cliPackageVersion}；已安装 @dsh-ray/*：${report.packages.installedEnhancedVersion ?? '未检测到'}${report.packages.targetEnhancedVersion ? ` -> 目标：${report.packages.targetEnhancedVersion}` : ''}`)
  if (semverIsNewer(report.packages.targetEnhancedVersion, report.packages.cliPackageVersion)) {
    lines.push(`提示：全局 dsh-ray CLI 当前为 ${report.packages.cliPackageVersion}，可运行 dsh-ray update 同步升级至 ${report.packages.targetEnhancedVersion}`)
  }
  lines.push(`私有 Host（.dsh-ray-host.json）：${report.packages.boundHost.status}${report.packages.boundHost.installedVersion ? ` ${report.packages.boundHost.installedVersion}` : ''}${report.packages.boundHost.targetVersion ? ` -> ${report.packages.boundHost.targetVersion}` : ''}`)
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
