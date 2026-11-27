import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectLiveDoctorReport, type LiveDoctorReport } from './doctor-live.ts'
import { inspectLaunchdDefinition, inspectLoadedLaunchd } from './launchd-service.ts'
import { profilesDirectory, systemdUnitName } from './paths.ts'
import { buildPackageManagerEnv, resolveFallbackBinary, resolveNodeRuntime } from './pm-env.ts'
import { detectFrozenOwner } from './program-update.ts'
import { defaultDetailedRunner, type CommandResult, type CommandRunner, type DetailedCommandRunner } from './run.ts'
import {
  controlManagedService,
  inspectManagedServiceForDshHome,
  resolveTargetProfiles,
} from './services.ts'
import { RSI_CLI_PACKAGE } from './update.ts'
import { compareSemver, runUpgrade, type UpgradeReport } from './upgrade.ts'
import { version as CLI_VERSION } from './version.ts'

export const AUTO_UPDATE_DIR_NAME = '.dsh-ray'
export const AUTO_UPDATE_NOTIFY_FILE = 'auto-update-notify.json'
export const AUTO_UPDATE_STATUS_FILE = 'auto-update-status.json'
export const AUTO_UPDATE_LOG_FILE = 'auto-update.log'

const DEFAULT_DELAY_MS = 2_500
const MAX_PRIVATE_JSON_BYTES = 64 * 1024
const STALE_PENDING_MS = 20 * 60 * 1_000
const COORDINATOR_MARKER_RE = /^\.rsi-coordinator-[a-f0-9]{16}\.json$/u
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const ANSI_ESCAPE = String.fromCodePoint(0x1b)
const ANSI_SEQUENCE = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, 'gu')

export interface AutoUpdateNotifyTarget {
  readonly channel: string
  readonly account: string
  readonly chatId?: string
  readonly conversation?: Readonly<{ kind?: string; chat: string }>
  readonly principal?: Readonly<Record<string, unknown>> | string
  readonly ownerPrincipal?: string
}

export interface AutoUpdateNotifyMarker {
  readonly schemaVersion: 1
  readonly runId: string
  readonly channel?: string
  readonly account?: string
  readonly chatId?: string
  readonly conversation?: Readonly<{ kind?: string; chat: string }>
  readonly principal?: Readonly<Record<string, unknown>> | string
  readonly ownerPrincipal?: string
  readonly profile?: string
  readonly fromVersion?: string
  readonly targetVersion?: string
  readonly requestedAt: string
}

export interface AutoUpdateStatusRecord {
  readonly schemaVersion: 1
  readonly runId: string
  readonly status: 'pending' | 'running' | 'succeeded' | 'failed'
  readonly profile?: string
  readonly fromVersion?: string
  readonly version?: string
  readonly targetVersion?: string
  readonly toNpm?: boolean
  readonly launcher?: 'systemd-run' | 'detached'
  readonly unitName?: string
  readonly pid?: number
  readonly error?: string
  readonly startedAt?: string
  readonly updatedAt: string
  readonly finishedAt?: string
}

export interface AutoUpdateSourceState {
  readonly needsToNpm: boolean
  readonly hasCohortDir: boolean
  readonly hasSourceBoundCoordinator: boolean
  readonly matchedCohorts: readonly string[]
  readonly coordinatorMarkers: readonly string[]
}

export interface AutoUpdatePrecheckResult {
  readonly ok: boolean
  readonly needsUpdate: boolean
  readonly upToDateAndHealthy: boolean
  readonly fromVersion?: string
  readonly targetVersion?: string
  readonly doctorHealthy: boolean
  readonly sourceFrozenOrBound: boolean
  readonly needsRecovery: boolean
  readonly message: string
  readonly error?: string
  readonly upgradeReport?: UpgradeReport
  readonly doctorReport?: LiveDoctorReport
}

export interface LaunchAutoUpdateOptions {
  readonly dshHome: string
  readonly profile?: string
  readonly registryUrl?: string
  readonly platform?: NodeJS.Platform
  readonly osHome?: string
  readonly env?: NodeJS.ProcessEnv
  readonly delayMs?: number
  readonly notify?: AutoUpdateNotifyTarget
}

export interface LaunchAutoUpdateResult {
  readonly ok: boolean
  readonly state: 'upgraded'
  readonly started: boolean
  readonly alreadyCurrent?: boolean
  readonly alreadyRunning?: boolean
  readonly background?: boolean
  readonly fromVersion?: string
  readonly targetVersion?: string
  readonly toNpm?: boolean
  readonly launcher?: 'systemd-run' | 'detached'
  readonly unitName?: string
  readonly pid?: number
  readonly runId?: string
  readonly message: string
  readonly error?: string
}

export interface LaunchAutoUpdateDeps {
  readonly now?: () => number
  readonly runner?: CommandRunner
  readonly detailedRunner?: DetailedCommandRunner
  readonly runUpgrade?: typeof runUpgrade
  readonly collectDoctor?: typeof collectLiveDoctorReport
  readonly detectSourceState?: typeof detectAutoUpdateSourceState
  readonly inspectService?: typeof inspectManagedServiceForDshHome
  readonly resolveTargets?: typeof resolveTargetProfiles
  readonly spawnDetached?: (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => number | undefined
  readonly runnerScriptPath?: string
  readonly nodeExecutable?: string
  readonly checkPathExists?: (path: string) => boolean
}

export interface AutoUpdateWorkerOptions {
  readonly dshHome: string
  readonly runId?: string
  readonly profile?: string
  readonly toNpm?: boolean
  readonly targetVersion?: string
  readonly delayMs?: number
  readonly platform?: NodeJS.Platform
  readonly osHome?: string
  readonly env?: NodeJS.ProcessEnv
}

export interface AutoUpdateWorkerDeps {
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly runner?: CommandRunner
  readonly detailedRunner?: DetailedCommandRunner
  readonly inspectService?: typeof inspectManagedServiceForDshHome
  readonly controlService?: typeof controlManagedService
  readonly resolveTargets?: typeof resolveTargetProfiles
  readonly collectDoctor?: typeof collectLiveDoctorReport
}

export interface ReconciledAutoUpdateNotification {
  readonly ready: boolean
  readonly status?: 'succeeded' | 'failed'
  readonly notify: AutoUpdateNotifyMarker
  readonly statusRecord?: AutoUpdateStatusRecord
  readonly message?: string
}

function stripLeadingV(version: string | undefined): string | undefined {
  if (typeof version !== 'string') return undefined
  const trimmed = version.trim().replace(/^v(?=\d)/iu, '')
  return trimmed.length > 0 ? trimmed : undefined
}

function isValidProfile(profile: string | undefined): boolean {
  return profile === undefined || PROFILE_NAME_RE.test(profile)
}

/** Redact secrets, tokens, bearer credentials, and private query params from diagnostic output. */
export function redactAutoUpdateText(raw: string, maxChars = 480): string {
  const cleaned = raw
    .replace(ANSI_SEQUENCE, '')
    .replace(/([?#&](?:token|secret|password|api[_-]?key|access[_-]?token)=)[^&\s]+/giu, '$1<redacted>')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, '$1<redacted>')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[ps]_[A-Za-z0-9]{12,}|cli_[A-Za-z0-9]{8,})\b/gu, '<redacted>')
    .replace(/((?:api[_-]?key|app[_-]?secret|encrypt[_-]?key|verification[_-]?token|password|token|secret)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/giu, '$1<redacted>')
    .replace(/\s+/gu, ' ')
    .trim()
  if (cleaned.length <= maxChars) return cleaned
  return `${cleaned.slice(0, maxChars - 1)}…`
}

export function autoUpdateStateDir(dshHome: string): string {
  return join(dshHome, AUTO_UPDATE_DIR_NAME)
}

export function autoUpdateNotifyPath(dshHome: string): string {
  return join(autoUpdateStateDir(dshHome), AUTO_UPDATE_NOTIFY_FILE)
}

export function autoUpdateStatusPath(dshHome: string): string {
  return join(autoUpdateStateDir(dshHome), AUTO_UPDATE_STATUS_FILE)
}

export function autoUpdateLogPath(dshHome: string): string {
  return join(autoUpdateStateDir(dshHome), AUTO_UPDATE_LOG_FILE)
}

async function resolveSafeHome(dshHome: string): Promise<string> {
  if (!dshHome || !isAbsolute(dshHome)) {
    throw new Error(`DSH_HOME 必须是绝对路径：${dshHome}`)
  }
  const meta = await lstat(dshHome).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') {
      throw new Error(`DSH_HOME 目录不存在：${dshHome}`)
    }
    throw error
  })
  if (!meta.isDirectory() || meta.isSymbolicLink()) {
    throw new Error(`DSH_HOME 必须是普通目录（禁止符号链接）：${dshHome}`)
  }
  return await realpath(dshHome)
}

async function ensurePrivateStateDir(canonicalHome: string): Promise<string> {
  const dir = autoUpdateStateDir(canonicalHome)
  const existing = await lstat(dir).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
    throw error
  })
  if (existing !== undefined) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error(`状态目录不是安全普通目录：${dir}`)
    }
    return dir
  }
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  return dir
}

async function assertRegularNonSymlinkIfPresent(filePath: string): Promise<boolean> {
  const meta = await lstat(filePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
    throw error
  })
  if (meta === undefined) return false
  if (!meta.isFile() || meta.isSymbolicLink()) {
    throw new Error(`拒绝访问非普通文件或符号链接：${filePath}`)
  }
  return true
}

async function writePrivateAtomic(filePath: string, content: string): Promise<void> {
  await assertRegularNonSymlinkIfPresent(filePath)
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0)
  let handle
  try {
    handle = await open(tmpPath, flags, 0o600)
    await handle.writeFile(content, 'utf8')
    await handle.chmod(0o600)
    await handle.close()
    handle = undefined
    await rename(tmpPath, filePath)
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined)
    await rm(tmpPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function appendPrivateLog(filePath: string, entry: string): Promise<void> {
  const exists = await assertRegularNonSymlinkIfPresent(filePath)
  const flags = exists
    ? constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0)
    : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0)
  const line = `${redactAutoUpdateText(entry, 4_000)}\n`
  let handle
  try {
    handle = await open(filePath, flags, 0o600)
    await handle.chmod(0o600)
    await handle.writeFile(line, 'utf8')
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined)
  }
}

async function readPrivateJson<T>(filePath: string): Promise<T | undefined> {
  const exists = await assertRegularNonSymlinkIfPresent(filePath)
  if (!exists) return undefined
  const st = await lstat(filePath)
  if (st.size > MAX_PRIVATE_JSON_BYTES) {
    throw new Error(`状态文件超过大小上限：${filePath}`)
  }
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  const handle = await open(filePath, flags)
  try {
    const raw = await handle.readFile('utf8')
    return JSON.parse(raw) as T
  } finally {
    await handle.close().catch(() => undefined)
  }
}

export async function readAutoUpdateNotifyMarker(dshHome: string): Promise<AutoUpdateNotifyMarker | undefined> {
  try {
    const canonicalHome = await resolveSafeHome(dshHome)
    const parsed = await readPrivateJson<AutoUpdateNotifyMarker>(autoUpdateNotifyPath(canonicalHome))
    if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 1 || typeof parsed.runId !== 'string') {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

export async function readAutoUpdateStatus(dshHome: string): Promise<AutoUpdateStatusRecord | undefined> {
  try {
    const canonicalHome = await resolveSafeHome(dshHome)
    const parsed = await readPrivateJson<AutoUpdateStatusRecord>(autoUpdateStatusPath(canonicalHome))
    if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 1 || typeof parsed.runId !== 'string') {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

export async function clearAutoUpdateNotifyMarker(dshHome: string, expectedRunId?: string): Promise<boolean> {
  try {
    const canonicalHome = await resolveSafeHome(dshHome)
    const markerPath = autoUpdateNotifyPath(canonicalHome)
    const existing = await readPrivateJson<AutoUpdateNotifyMarker>(markerPath).catch(() => undefined)
    if (expectedRunId !== undefined && existing !== undefined && existing.runId !== expectedRunId) {
      return false
    }
    await assertRegularNonSymlinkIfPresent(markerPath)
    await unlink(markerPath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
    return false
  }
}

/**
 * Inspect source-frozen / local-cohort residue in `dshHome`:
 * `rsi-local-cohorts/<profile>` OR non-null `sourceRepository` in `.rsi-coordinator-*.json`
 * OR legacy frozen source owner under `rsi-local-cohorts`.
 */
export async function detectAutoUpdateSourceState(
  dshHome: string,
  profile?: string,
): Promise<AutoUpdateSourceState> {
  const canonicalHome = await resolveSafeHome(dshHome)
  const matchedCohorts: string[] = []
  const cohortsRoot = join(canonicalHome, 'rsi-local-cohorts')
  const cohortsRootMeta = await lstat(cohortsRoot).catch(() => undefined)
  if (cohortsRootMeta?.isDirectory() && !cohortsRootMeta.isSymbolicLink()) {
    const entries = await readdir(cohortsRoot).catch(() => [] as string[])
    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      const entryMeta = await lstat(join(cohortsRoot, entry)).catch(() => undefined)
      if (!entryMeta?.isDirectory() || entryMeta.isSymbolicLink()) continue
      if (profile === undefined || entry === profile) {
        matchedCohorts.push(entry)
      }
    }
  }

  const coordinatorMarkers: string[] = []
  let hasSourceBoundCoordinator = false
  const homeEntries = await readdir(canonicalHome).catch(() => [] as string[])
  for (const entry of homeEntries) {
    if (!COORDINATOR_MARKER_RE.test(entry)) continue
    coordinatorMarkers.push(entry)
    const markerPath = join(canonicalHome, entry)
    const marker = await readPrivateJson<{
      targetProfile?: unknown
      coordinatorProfile?: unknown
      sourceRepository?: unknown
    }>(markerPath).catch(() => undefined)
    if (!marker || typeof marker !== 'object') continue
    const matchesProfile = profile === undefined
      || marker.targetProfile === profile
      || marker.coordinatorProfile === profile
      || !marker.targetProfile
    if (
      matchesProfile
      && typeof marker.sourceRepository === 'string'
      && marker.sourceRepository.trim().length > 0
    ) {
      hasSourceBoundCoordinator = true
    }
  }

  let frozenDetected = false
  if (matchedCohorts.length === 0 && !hasSourceBoundCoordinator) {
    const frozen = await detectFrozenOwner(canonicalHome).catch(() => undefined)
    if (frozen !== undefined) frozenDetected = true
  }

  const hasCohortDir = matchedCohorts.length > 0
  return {
    needsToNpm: hasCohortDir || hasSourceBoundCoordinator || frozenDetected,
    hasCohortDir,
    hasSourceBoundCoordinator,
    matchedCohorts,
    coordinatorMarkers,
  }
}

async function discoverExtraBinDirs(
  env: NodeJS.ProcessEnv,
  osHome: string,
  platform: NodeJS.Platform,
  runner: DetailedCommandRunner,
): Promise<string[]> {
  const dirs: string[] = []
  const addIfExists = (candidate: string | undefined) => {
    if (candidate && isAbsolute(candidate) && existsSync(candidate) && !dirs.includes(candidate)) {
      dirs.push(candidate)
    }
  }

  const npmBin = await resolveFallbackBinary('npm', env, osHome, platform)
  addIfExists(npmBin.binDir)
  const pnpmBin = await resolveFallbackBinary('pnpm', env, osHome, platform)
  addIfExists(pnpmBin.binDir)
  const dshBin = await resolveFallbackBinary('dsh', env, osHome, platform)
  addIfExists(dshBin.binDir)
  const dshRayBin = await resolveFallbackBinary('dsh-ray', env, osHome, platform)
  addIfExists(dshRayBin.binDir)

  addIfExists(join(osHome, '.npm-global', 'bin'))
  addIfExists(join(osHome, '.local', 'bin'))
  addIfExists(join(osHome, '.local', 'share', 'pnpm'))
  if (platform === 'darwin') addIfExists(join(osHome, 'Library', 'pnpm'))
  if (typeof env.PNPM_HOME === 'string') addIfExists(env.PNPM_HOME)
  if (typeof env.NPM_CONFIG_PREFIX === 'string') addIfExists(join(env.NPM_CONFIG_PREFIX, 'bin'))

  if (npmBin.command) {
    const prefixRes = runner(npmBin.command, ['prefix', '-g'], { env, timeoutMs: 5_000 })
    if (prefixRes.status === 0) {
      const globalPrefix = prefixRes.stdout.trim()
      if (globalPrefix && isAbsolute(globalPrefix)) addIfExists(join(globalPrefix, 'bin'))
    }
  }

  return dirs
}

function defaultWorkerRunnerScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const directJs = join(here, 'auto-update-runner.js')
  if (existsSync(directJs)) return directJs
  const siblingLibJs = resolve(here, '..', 'lib', 'auto-update-runner.js')
  if (existsSync(siblingLibJs)) return siblingLibJs
  return join(here, 'auto-update-runner.ts')
}

function defaultCliBinPath(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidate = resolve(here, '..', 'bin', 'dsh-ray.js')
  return existsSync(candidate) ? candidate : undefined
}

async function readInstalledProfileEnhancedVersion(
  canonicalHome: string,
  profile?: string,
): Promise<string | undefined> {
  const profiles = profile ? [profile] : await resolveTargetProfiles(canonicalHome).catch(() => [] as string[])
  const candidatePkgs = ['assistant-delivery', 'lark-channel', 'owner-console']
  for (const prof of profiles) {
    for (const slug of candidatePkgs) {
      const pkgPath = join(profilesDirectory(canonicalHome), prof, 'node_modules', '@dsh-ray', slug, 'package.json')
      try {
        const raw = await readFile(pkgPath, 'utf8')
        const parsed = JSON.parse(raw) as { version?: unknown }
        if (typeof parsed.version === 'string' && parsed.version.trim()) {
          return stripLeadingV(parsed.version)
        }
      } catch { /* try next package */ }
    }
  }
  return undefined
}

async function readGlobalCliVersionFromBin(dshRayBin: string): Promise<string | undefined> {
  try {
    const resolvedBin = await realpath(dshRayBin)
    const pkgPath = resolve(dirname(resolvedBin), '..', 'package.json')
    const raw = await readFile(pkgPath, 'utf8')
    const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown }
    if (parsed.name === RSI_CLI_PACKAGE && typeof parsed.version === 'string') {
      return stripLeadingV(parsed.version)
    }
  } catch { /* ignore */ }
  return undefined
}

function resolveDshRayFromEnvPath(env: NodeJS.ProcessEnv, osHome: string, platform: NodeJS.Platform): string | undefined {
  const dirs = [
    ...(env.PATH ?? '').split(delimiter).filter(Boolean),
    join(osHome, '.npm-global', 'bin'),
    join(osHome, '.local', 'bin'),
    join(osHome, '.local', 'share', 'pnpm'),
    ...(platform === 'darwin' ? [join(osHome, 'Library', 'pnpm'), '/opt/homebrew/bin'] : []),
    '/usr/local/bin',
  ]
  for (const dir of dirs) {
    const candidate = join(dir, 'dsh-ray')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function ensureLinuxUserSessionEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  pathExists: (path: string) => boolean = existsSync,
): NodeJS.ProcessEnv {
  if (platform !== 'linux') return env
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid === undefined) return env
  const nextEnv: NodeJS.ProcessEnv = { ...env }
  if (!nextEnv.XDG_RUNTIME_DIR) {
    const runtimeDir = `/run/user/${uid}`
    if (pathExists(runtimeDir)) nextEnv.XDG_RUNTIME_DIR = runtimeDir
  }
  if (!nextEnv.DBUS_SESSION_BUS_ADDRESS && nextEnv.XDG_RUNTIME_DIR) {
    const busPath = join(nextEnv.XDG_RUNTIME_DIR, 'bus')
    if (pathExists(busPath)) nextEnv.DBUS_SESSION_BUS_ADDRESS = `unix:path=${busPath}`
  }
  return nextEnv
}

/**
 * Fast non-mutating check determining whether the home is already at latest npm version,
 * free of source-frozen/local-cohort residue, and passing live `doctor`.
 */
export async function checkUnattendedAutoUpgrade(
  options: LaunchAutoUpdateOptions,
  deps: LaunchAutoUpdateDeps = {},
): Promise<AutoUpdatePrecheckResult> {
  if (!isValidProfile(options.profile)) {
    return {
      ok: false,
      needsUpdate: false,
      upToDateAndHealthy: false,
      doctorHealthy: false,
      sourceFrozenOrBound: false,
      needsRecovery: false,
      message: `非法 profile 名称：${options.profile}`,
      error: `非法 profile 名称：${options.profile}`,
    }
  }

  let canonicalHome: string
  try {
    canonicalHome = await resolveSafeHome(options.dshHome)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      needsUpdate: false,
      upToDateAndHealthy: false,
      doctorHealthy: false,
      sourceFrozenOrBound: false,
      needsRecovery: false,
      message: redactAutoUpdateText(msg),
      error: redactAutoUpdateText(msg),
    }
  }

  const platform = options.platform ?? process.platform
  const osHome = options.osHome ?? homedir()
  const env = options.env ?? process.env

  const sourceState = await (deps.detectSourceState ?? detectAutoUpdateSourceState)(canonicalHome, options.profile)
  const upgradeFn = deps.runUpgrade ?? runUpgrade
  const doctorFn = deps.collectDoctor ?? collectLiveDoctorReport

  const [{ report: upgradeReport }, doctorReport] = await Promise.all([
    upgradeFn({
      dshHome: canonicalHome,
      ...(options.profile !== undefined ? { profile: options.profile } : {}),
      action: 'check',
      toNpm: sourceState.needsToNpm,
      allowNonEmptyHistoryMigration: true,
      ...(options.registryUrl !== undefined ? { registryUrl: options.registryUrl } : {}),
      platform,
      osHome,
      env,
    }),
    doctorFn({
      dshHome: canonicalHome,
      ...(options.profile !== undefined ? { profile: options.profile } : {}),
      platform,
      home: osHome,
      env,
    }),
  ])

  const profileInstalledVersion = await readInstalledProfileEnhancedVersion(canonicalHome, options.profile)
  const fromVersion = stripLeadingV(
    upgradeReport.packages.installedEnhancedVersion ?? profileInstalledVersion ?? CLI_VERSION,
  )
  const targetVersion = stripLeadingV(
    upgradeReport.packages.targetEnhancedVersion
      ?? upgradeReport.registry.latestEnhancedVersion
      ?? fromVersion,
  )

  const relevantProfiles = options.profile !== undefined
    ? doctorReport.profiles.filter(item => item.profile === options.profile)
    : doctorReport.profiles
  const allManagedServicesActive = !relevantProfiles.some(item => item.serviceInstalled && !item.serviceActive)
  const doctorHealthy = doctorReport.ok && allManagedServicesActive

  const dshRayBin = resolveDshRayFromEnvPath(env, osHome, platform)
  const globalCliVer = dshRayBin ? await readGlobalCliVersionFromBin(dshRayBin) : undefined
  const cliBehindLatest = Boolean(
    upgradeReport.registry.latestEnhancedVersion
    && globalCliVer
    && (compareSemver(globalCliVer, upgradeReport.registry.latestEnhancedVersion) ?? 0) < 0,
  )

  const registryCheckedOk = upgradeReport.registry.status === 'ok'
  const alreadyLatest = registryCheckedOk
    && !upgradeReport.packages.upgradeAvailable
    && !upgradeReport.packages.boundHost.upgradeAvailable
    && !cliBehindLatest
    && (!fromVersion || !upgradeReport.registry.latestEnhancedVersion
      || (compareSemver(fromVersion, upgradeReport.registry.latestEnhancedVersion) ?? 0) >= 0)

  const needsRecovery = !doctorHealthy
  const upToDateAndHealthy = alreadyLatest && !sourceState.needsToNpm && doctorHealthy

  if (upToDateAndHealthy) {
    const versionDisplay = fromVersion ?? CLI_VERSION
    return {
      ok: true,
      needsUpdate: false,
      upToDateAndHealthy: true,
      fromVersion: versionDisplay,
      targetVersion: targetVersion ?? versionDisplay,
      doctorHealthy: true,
      sourceFrozenOrBound: false,
      needsRecovery: false,
      message: `当前已是最新版本 v${versionDisplay} 且服务运行正常，无需升级。`,
      upgradeReport,
      doctorReport,
    }
  }

  return {
    ok: true,
    needsUpdate: true,
    upToDateAndHealthy: false,
    ...(fromVersion !== undefined ? { fromVersion } : {}),
    ...(targetVersion !== undefined ? { targetVersion } : {}),
    doctorHealthy,
    sourceFrozenOrBound: sourceState.needsToNpm,
    needsRecovery,
    message: '需要执行升级与服务恢复。',
    upgradeReport,
    doctorReport,
  }
}

function isSystemdUnitActive(unitName: string, runner: CommandRunner): boolean {
  const result = runner('systemctl', ['--user', 'is-active', unitName])
  return result.status === 0 && result.stdout.trim() === 'active'
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/**
 * Shared out-of-cgroup / detached unattended auto-update launcher for Feishu and Web/Owner Console.
 */
export async function launchUnattendedAutoUpgrade(
  options: LaunchAutoUpdateOptions,
  deps: LaunchAutoUpdateDeps = {},
): Promise<LaunchAutoUpdateResult> {
  const precheck = await checkUnattendedAutoUpgrade(options, deps)
  if (!precheck.ok) {
    return {
      ok: false,
      state: 'upgraded',
      started: false,
      message: precheck.error ?? precheck.message,
      error: precheck.error ?? precheck.message,
    }
  }

  if (!precheck.needsUpdate && precheck.upToDateAndHealthy) {
    return {
      ok: true,
      state: 'upgraded',
      started: false,
      alreadyCurrent: true,
      ...(precheck.fromVersion !== undefined ? { fromVersion: precheck.fromVersion } : {}),
      ...(precheck.targetVersion !== undefined ? { targetVersion: precheck.targetVersion } : {}),
      toNpm: false,
      message: precheck.message,
    }
  }

  const canonicalHome = await resolveSafeHome(options.dshHome)
  const nowMs = (deps.now ?? Date.now)()
  const platform = options.platform ?? process.platform
  const osHome = options.osHome ?? homedir()
  const baseEnv = ensureLinuxUserSessionEnv(options.env ?? process.env, platform, deps.checkPathExists)
  const detailedRunner: DetailedCommandRunner = deps.detailedRunner ?? defaultDetailedRunner
  const runner: CommandRunner = deps.runner ?? ((cmd, args) => detailedRunner(cmd, args, { env: baseEnv }))

  // Deduplicate if an active background upgrade is already running for this DSH_HOME.
  const existingStatus = await readAutoUpdateStatus(canonicalHome)
  if (existingStatus && (existingStatus.status === 'pending' || existingStatus.status === 'running')) {
    const updatedMs = Date.parse(existingStatus.updatedAt)
    const fresh = Number.isFinite(updatedMs) && (nowMs - updatedMs) < STALE_PENDING_MS
    const activeByUnit = existingStatus.unitName
      ? isSystemdUnitActive(existingStatus.unitName, runner)
      : false
    const activeByPid = existingStatus.pid !== undefined ? isPidAlive(existingStatus.pid) : false
    if (fresh && (activeByUnit || activeByPid)) {
      return {
        ok: true,
        state: 'upgraded',
        started: false,
        alreadyRunning: true,
        background: true,
        ...(existingStatus.fromVersion !== undefined ? { fromVersion: existingStatus.fromVersion } : {}),
        ...(existingStatus.targetVersion !== undefined ? { targetVersion: existingStatus.targetVersion } : {}),
        runId: existingStatus.runId,
        ...(existingStatus.unitName !== undefined ? { unitName: existingStatus.unitName } : {}),
        message: '🔄 后台自动升级与服务恢复正在进行中，完成后将自动通知结果，无需重复触发。',
      }
    }
  }

  await ensurePrivateStateDir(canonicalHome)
  const runId = `auto-update-${nowMs}-${randomBytes(4).toString('hex')}`
  const unitName = `dsh-ray-auto-update-${nowMs}`

  const notifyMarker: AutoUpdateNotifyMarker = {
    schemaVersion: 1,
    runId,
    ...(options.notify?.channel !== undefined ? { channel: options.notify.channel } : {}),
    ...(options.notify?.account !== undefined ? { account: options.notify.account } : {}),
    ...(options.notify?.chatId !== undefined ? { chatId: options.notify.chatId } : {}),
    ...(options.notify?.conversation !== undefined ? { conversation: options.notify.conversation } : {}),
    ...(options.notify?.principal !== undefined ? { principal: options.notify.principal } : {}),
    ...(options.notify?.ownerPrincipal !== undefined ? { ownerPrincipal: options.notify.ownerPrincipal } : {}),
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
    ...(precheck.fromVersion !== undefined ? { fromVersion: precheck.fromVersion } : {}),
    ...(precheck.targetVersion !== undefined ? { targetVersion: precheck.targetVersion } : {}),
    requestedAt: new Date(nowMs).toISOString(),
  }

  const initialStatus: AutoUpdateStatusRecord = {
    schemaVersion: 1,
    runId,
    status: 'pending',
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
    ...(precheck.fromVersion !== undefined ? { fromVersion: precheck.fromVersion } : {}),
    ...(precheck.targetVersion !== undefined ? { targetVersion: precheck.targetVersion } : {}),
    toNpm: precheck.sourceFrozenOrBound,
    updatedAt: new Date(nowMs).toISOString(),
  }

  const shouldWriteNotifyMarker = options.notify !== undefined && (
    options.notify.channel !== 'web'
    || options.notify.chatId !== undefined
    || options.notify.conversation?.chat !== undefined
  )

  // Write the 0600 one-shot notification marker BEFORE spawning the background updater.
  if (shouldWriteNotifyMarker) {
    await writePrivateAtomic(autoUpdateNotifyPath(canonicalHome), `${JSON.stringify(notifyMarker, null, 2)}\n`)
  }
  await writePrivateAtomic(autoUpdateStatusPath(canonicalHome), `${JSON.stringify(initialStatus, null, 2)}\n`)

  const extraDirs = await discoverExtraBinDirs(baseEnv, osHome, platform, detailedRunner)
  const nodeRt = await resolveNodeRuntime(baseEnv, osHome, platform)
  const nodeBin = deps.nodeExecutable ?? nodeRt.command
  const workerEnv = await buildPackageManagerEnv(
    {
      ...baseEnv,
      ...nodeRt.envOverrides,
      CI: 'true',
      DSH_HOME: canonicalHome,
      HOME: osHome,
    },
    osHome,
    platform,
    extraDirs,
  )
  const runnerScript = deps.runnerScriptPath ?? defaultWorkerRunnerScriptPath()
  const workerArgs: string[] = [
    '--dsh-home',
    canonicalHome,
    '--run-id',
    runId,
    ...(options.profile !== undefined ? ['--profile', options.profile] : []),
    ...(precheck.sourceFrozenOrBound ? ['--to-npm'] : []),
    ...(precheck.targetVersion !== undefined ? ['--target-version', precheck.targetVersion] : []),
    ...(options.delayMs !== undefined ? ['--delay-ms', String(options.delayMs)] : []),
  ]

  let managesSystemdUnit = false
  if (platform === 'linux') {
    const inspectService = deps.inspectService ?? inspectManagedServiceForDshHome
    const targetProfiles = await (deps.resolveTargets ?? resolveTargetProfiles)(canonicalHome, options.profile)
    for (const prof of targetProfiles) {
      const presence = await inspectService(platform, osHome, prof, canonicalHome, runner)
      if (presence.managed) {
        managesSystemdUnit = true
        break
      }
    }
  }

  let launcher: 'systemd-run' | 'detached' = 'detached'
  let pid: number | undefined

  try {
    let usedSystemdRun = false
    if (managesSystemdUnit) {
      const systemdRunBin = (await resolveFallbackBinary('systemd-run', workerEnv, osHome, platform, ['/usr/bin', '/bin'])).command
      const setenvPairs: Array<[string, string]> = [
        ['CI', 'true'],
        ['DSH_HOME', canonicalHome],
        ['HOME', osHome],
        ['PATH', workerEnv.PATH ?? ''],
      ]
      if (workerEnv.ELECTRON_RUN_AS_NODE) setenvPairs.push(['ELECTRON_RUN_AS_NODE', workerEnv.ELECTRON_RUN_AS_NODE])
      if (workerEnv.npm_config_registry) setenvPairs.push(['npm_config_registry', workerEnv.npm_config_registry])
      if (workerEnv.NPM_CONFIG_REGISTRY) setenvPairs.push(['NPM_CONFIG_REGISTRY', workerEnv.NPM_CONFIG_REGISTRY])
      if (workerEnv.XDG_RUNTIME_DIR) setenvPairs.push(['XDG_RUNTIME_DIR', workerEnv.XDG_RUNTIME_DIR])
      if (workerEnv.DBUS_SESSION_BUS_ADDRESS) setenvPairs.push(['DBUS_SESSION_BUS_ADDRESS', workerEnv.DBUS_SESSION_BUS_ADDRESS])

      const systemdRunArgs = [
        '--user',
        '--collect',
        '--no-block',
        `--unit=${unitName}`,
        ...setenvPairs.map(([key, val]) => `--setenv=${key}=${val}`),
        nodeBin,
        runnerScript,
        ...workerArgs,
      ]
      const res = detailedRunner(systemdRunBin, systemdRunArgs, { env: workerEnv, timeoutMs: 15_000 })
      const binaryMissing = res.status === null && /ENOENT/iu.test(res.stderr)
      if (!binaryMissing) {
        if (res.status !== 0) {
          const msg = res.stderr.trim() || res.stdout.trim() || `systemd-run 退出码 ${String(res.status)}`
          throw new Error(`systemd-run 启动后台升级失败：${msg}`)
        }
        launcher = 'systemd-run'
        usedSystemdRun = true
      }
    }
    if (!usedSystemdRun) {
      const spawnFn = deps.spawnDetached ?? ((cmd, args, spawnEnv) => {
        const child = spawn(cmd, [...args], {
          detached: true,
          stdio: 'ignore',
          env: spawnEnv,
        })
        child.unref()
        return child.pid
      })
      pid = spawnFn(nodeBin, [runnerScript, ...workerArgs], workerEnv)
      launcher = 'detached'
    }

    const latestStatus = await readAutoUpdateStatus(canonicalHome)
    if (!latestStatus || (latestStatus.runId === runId && latestStatus.status === 'pending')) {
      await writePrivateAtomic(
        autoUpdateStatusPath(canonicalHome),
        `${JSON.stringify({
          ...initialStatus,
          launcher,
          ...(launcher === 'systemd-run' ? { unitName } : {}),
          ...(pid !== undefined ? { pid } : {}),
          updatedAt: new Date((deps.now ?? Date.now)()).toISOString(),
        }, null, 2)}\n`,
      )
    }
  } catch (error) {
    const errMsg = redactAutoUpdateText(error instanceof Error ? error.message : String(error))
    await clearAutoUpdateNotifyMarker(canonicalHome, runId)
    await writePrivateAtomic(
      autoUpdateStatusPath(canonicalHome),
      `${JSON.stringify({
        schemaVersion: 1,
        runId,
        status: 'failed',
        ...(options.profile !== undefined ? { profile: options.profile } : {}),
        ...(precheck.fromVersion !== undefined ? { fromVersion: precheck.fromVersion } : {}),
        ...(precheck.targetVersion !== undefined ? { targetVersion: precheck.targetVersion } : {}),
        error: errMsg,
        updatedAt: new Date((deps.now ?? Date.now)()).toISOString(),
        finishedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      }, null, 2)}\n`,
    ).catch(() => undefined)
    return {
      ok: false,
      state: 'upgraded',
      started: false,
      message: `升级整体助手未完成：${errMsg}`,
      error: errMsg,
    }
  }

  const fromLabel = precheck.fromVersion ? `v${precheck.fromVersion}` : '当前版本'
  const toLabel = precheck.targetVersion ? `v${precheck.targetVersion}` : '最新版本'
  return {
    ok: true,
    state: 'upgraded',
    started: true,
    background: true,
    ...(precheck.fromVersion !== undefined ? { fromVersion: precheck.fromVersion } : {}),
    ...(precheck.targetVersion !== undefined ? { targetVersion: precheck.targetVersion } : {}),
    toNpm: precheck.sourceFrozenOrBound,
    launcher,
    ...(launcher === 'systemd-run' ? { unitName } : {}),
    ...(pid !== undefined ? { pid } : {}),
    runId,
    message: `🔄 已启动后台自动升级与服务恢复（${fromLabel} -> ${toLabel}），完成后服务将自动重启恢复并通知结果，全程无需人工干预。`,
  }
}

export function parseAutoUpdateWorkerArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): AutoUpdateWorkerOptions {
  let dshHome = env.DSH_HOME ?? ''
  let runId: string | undefined
  let profile: string | undefined
  let toNpm = false
  let targetVersion: string | undefined
  let delayMs: number | undefined

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === '--dsh-home' && argv[i + 1] !== undefined) {
      dshHome = argv[++i]!
    } else if (token === '--run-id' && argv[i + 1] !== undefined) {
      runId = argv[++i]!
    } else if (token === '--profile' && argv[i + 1] !== undefined) {
      profile = argv[++i]!
    } else if (token === '--target-version' && argv[i + 1] !== undefined) {
      targetVersion = argv[++i]!
    } else if (token === '--delay-ms' && argv[i + 1] !== undefined) {
      const parsed = Number(argv[++i]!)
      if (Number.isFinite(parsed) && parsed >= 0) delayMs = parsed
    } else if (token === '--to-npm') {
      toNpm = true
    }
  }

  return {
    dshHome,
    ...(runId !== undefined ? { runId } : {}),
    ...(profile !== undefined ? { profile } : {}),
    toNpm,
    ...(targetVersion !== undefined ? { targetVersion } : {}),
    ...(delayMs !== undefined ? { delayMs } : {}),
    env,
  }
}

async function isManagedServiceCurrentlyActive(
  platform: NodeJS.Platform,
  osHome: string,
  canonicalHome: string,
  profile: string,
  runner: CommandRunner,
): Promise<boolean> {
  if (platform === 'linux') {
    return isSystemdUnitActive(systemdUnitName(profile), runner)
  }
  if (platform === 'darwin') {
    const def = await inspectLaunchdDefinition(osHome, canonicalHome, profile, runner)
    if (!def.definition) return false
    const loaded = inspectLoadedLaunchd(def.definition, canonicalHome, runner)
    return loaded.running
  }
  return false
}

/**
 * Detached / out-of-cgroup worker body executed after replying to `/update`.
 */
export async function runAutoUpdateWorker(
  options: AutoUpdateWorkerOptions,
  deps: AutoUpdateWorkerDeps = {},
): Promise<number> {
  const nowFn = deps.now ?? Date.now
  const sleepFn = deps.sleep ?? (ms => new Promise<void>(resolveSleep => {
    const timer = setTimeout(resolveSleep, ms)
    timer.unref?.()
  }))
  const platform = options.platform ?? process.platform
  const osHome = options.osHome ?? homedir()
  const baseEnv = ensureLinuxUserSessionEnv(options.env ?? process.env, platform)
  const detailedRunner = deps.detailedRunner ?? ((cmd, args, opts) => defaultDetailedRunner(cmd, args, opts))
  const runner = deps.runner ?? ((cmd, args) => detailedRunner(cmd, args, { env: baseEnv }))

  let canonicalHome: string
  try {
    canonicalHome = await resolveSafeHome(options.dshHome)
    await ensurePrivateStateDir(canonicalHome)
  } catch (error) {
    process.stderr.write(`auto-update worker invalid DSH_HOME: ${String(error)}\n`)
    return 1
  }

  const runId = options.runId ?? `auto-update-${nowFn()}`
  const logFile = autoUpdateLogPath(canonicalHome)
  const statusFile = autoUpdateStatusPath(canonicalHome)
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS

  await writePrivateAtomic(logFile, `[${new Date(nowFn()).toISOString()}] auto-update worker started (runId=${runId})\n`).catch(() => undefined)

  if (delayMs > 0) {
    await sleepFn(delayMs)
  }

  const existingStatus = await readAutoUpdateStatus(canonicalHome)
  const startedAt = new Date(nowFn()).toISOString()
  await writePrivateAtomic(
    statusFile,
    `${JSON.stringify({
      ...(existingStatus ?? { schemaVersion: 1, runId }),
      schemaVersion: 1,
      runId,
      status: 'running',
      ...(options.profile !== undefined ? { profile: options.profile } : {}),
      startedAt,
      updatedAt: startedAt,
    }, null, 2)}\n`,
  )

  const inspectService = deps.inspectService ?? inspectManagedServiceForDshHome
  const controlService = deps.controlService ?? controlManagedService
  const resolveTargets = deps.resolveTargets ?? resolveTargetProfiles

  let managedProfiles: string[] = []
  let activeProfilesBefore: string[] = []
  let effectiveToNpm = Boolean(options.toNpm)
  let workerEnv = baseEnv

  const ensureRecoveredServices = async (preferRestart: boolean): Promise<string[]> => {
    const refreshedProfiles = await resolveTargets(canonicalHome).catch(() => managedProfiles)
    const seen = new Set([...managedProfiles, ...refreshedProfiles, ...(options.profile ? [options.profile] : [])])
    const stillInactive: string[] = []
    for (const prof of seen) {
      const presence = await inspectService(platform, osHome, prof, canonicalHome, runner).catch(() => ({ managed: false, foreign: false, definitionPath: '' }))
      if (!presence.managed) continue
      const active = await isManagedServiceCurrentlyActive(platform, osHome, canonicalHome, prof, runner)
      if (!preferRestart && active) continue
      const action = active ? 'restart' : 'start'
      const outcome = await controlService(platform, osHome, prof, action, runner, false, canonicalHome)
      await appendPrivateLog(logFile, `service ${action} ${prof}: ${outcome.errors.length > 0 ? `errors=${outcome.errors.join('；')}` : 'ok'}`)
      if (outcome.errors.length > 0) {
        stillInactive.push(`${prof}: ${outcome.errors.join('；')}`)
      } else {
        const afterActive = await isManagedServiceCurrentlyActive(platform, osHome, canonicalHome, prof, runner)
        if (!afterActive) stillInactive.push(`${prof}: service did not become active`)
      }
    }
    return stillInactive
  }

  try {
    const extraDirs = await discoverExtraBinDirs(baseEnv, osHome, platform, detailedRunner)
    const nodeRt = await resolveNodeRuntime(baseEnv, osHome, platform)
    workerEnv = await buildPackageManagerEnv(
      {
        ...baseEnv,
        ...nodeRt.envOverrides,
        CI: 'true',
        DSH_HOME: canonicalHome,
        HOME: osHome,
      },
      osHome,
      platform,
      extraDirs,
    )

    const sourceState = await detectAutoUpdateSourceState(canonicalHome, options.profile)
    effectiveToNpm = effectiveToNpm || sourceState.needsToNpm
    await appendPrivateLog(logFile, `environment ready: toNpm=${String(effectiveToNpm)}, profile=${options.profile ?? 'all'}`)

    const allProfiles = await resolveTargets(canonicalHome)
    if (options.profile && !allProfiles.includes(options.profile)) {
      allProfiles.push(options.profile)
    }
    for (const prof of allProfiles) {
      const presence = await inspectService(platform, osHome, prof, canonicalHome, runner)
      if (presence.managed) {
        managedProfiles.push(prof)
        if (await isManagedServiceCurrentlyActive(platform, osHome, canonicalHome, prof, runner)) {
          activeProfilesBefore.push(prof)
        }
      }
    }

    // Resolve or install/upgrade global @dsh-ray/cli via npm if absent or older than expected target.
    let dshRayBin = resolveDshRayFromEnvPath(workerEnv, osHome, platform)
    let installedCliVer = dshRayBin ? await readGlobalCliVersionFromBin(dshRayBin) : undefined
    if (!installedCliVer && dshRayBin) {
      const verRes = detailedRunner(dshRayBin, ['--version'], { env: workerEnv, timeoutMs: 10_000 })
      if (verRes.status === 0) installedCliVer = stripLeadingV(verRes.stdout.trim().split(/\s+/u).at(-1))
    }

    const desiredCliSelector = options.targetVersion && SEMVER_RE.test(options.targetVersion)
      ? options.targetVersion
      : 'latest'
    const needsGlobalNpmInstall = !dshRayBin
      || installedCliVer === undefined
      || (compareSemver(installedCliVer, CLI_VERSION) ?? 0) < 0
      || (options.targetVersion !== undefined && SEMVER_RE.test(options.targetVersion)
        && (compareSemver(installedCliVer, options.targetVersion) ?? 0) < 0)

    if (needsGlobalNpmInstall) {
      const npmBin = await resolveFallbackBinary('npm', workerEnv, osHome, platform)
      const installArgs = ['install', '-g', `${RSI_CLI_PACKAGE}@${desiredCliSelector}`]
      await appendPrivateLog(logFile, `running ${npmBin.command} ${installArgs.join(' ')}`)
      const installRes: CommandResult = detailedRunner(npmBin.command, installArgs, { env: workerEnv, timeoutMs: 300_000 })
      if (installRes.stdout.trim()) await appendPrivateLog(logFile, installRes.stdout)
      if (installRes.stderr.trim()) await appendPrivateLog(logFile, installRes.stderr)
      if (installRes.status !== 0) {
        if (!dshRayBin) {
          const fallbackBin = defaultCliBinPath()
          if (!fallbackBin) {
            throw new Error(`npm install -g @dsh-ray/cli 失败：${installRes.stderr.trim() || `exit ${installRes.status}`}`)
          }
          await appendPrivateLog(logFile, `npm install -g failed, falling back to local CLI binary ${fallbackBin}`)
        } else {
          await appendPrivateLog(logFile, `npm install -g returned exit ${String(installRes.status)}; continuing with ${dshRayBin}`)
        }
      } else {
        const refreshedExtra = await discoverExtraBinDirs(workerEnv, osHome, platform, detailedRunner)
        workerEnv = await buildPackageManagerEnv(workerEnv, osHome, platform, refreshedExtra)
        dshRayBin = resolveDshRayFromEnvPath(workerEnv, osHome, platform) ?? dshRayBin
      }
    }

    // macOS requires launchd services to be quiesced before `update --all --confirm-dsh-home-stopped`.
    if (platform === 'darwin' && activeProfilesBefore.length > 0) {
      for (const prof of activeProfilesBefore) {
        const stopOutcome = await controlService(platform, osHome, prof, 'stop', runner, false, canonicalHome)
        if (stopOutcome.errors.length > 0) {
          throw new Error(`停止 macOS 服务 ${prof} 失败：${stopOutcome.errors.join('；')}`)
        }
      }
    }

    const cliCmd = dshRayBin ?? nodeRt.command
    const cliPrefix = dshRayBin ? [] : (() => {
      const fallback = defaultCliBinPath()
      if (!fallback) throw new Error('无法定位 dsh-ray 可执行文件')
      return [fallback]
    })()

    const shouldPassHistoryMigrationFlag = effectiveToNpm
      || sourceState.coordinatorMarkers.length > 0
      || sourceState.hasCohortDir
    const updateArgs = [
      ...cliPrefix,
      'update',
      '--all',
      '--yes',
      '--dsh-home',
      canonicalHome,
      ...(effectiveToNpm ? ['--to-npm'] : []),
      ...(shouldPassHistoryMigrationFlag ? ['--allow-non-empty-history-migration'] : []),
      ...(platform === 'darwin' ? ['--confirm-dsh-home-stopped'] : []),
    ]
    await appendPrivateLog(logFile, `running ${cliCmd} ${updateArgs.join(' ')}`)
    const updateRes = detailedRunner(cliCmd, updateArgs, { env: workerEnv, timeoutMs: 900_000 })
    if (updateRes.stdout.trim()) await appendPrivateLog(logFile, updateRes.stdout)
    if (updateRes.stderr.trim()) await appendPrivateLog(logFile, updateRes.stderr)
    if (updateRes.status !== 0) {
      const detail = updateRes.stderr.trim() || updateRes.stdout.trim() || `exit ${String(updateRes.status)}`
      throw new Error(`dsh-ray update 失败：${redactAutoUpdateText(detail, 260)}`)
    }

    // Ensure managed systemd/launchd services are restarted and confirmed active.
    const restartErrors = await ensureRecoveredServices(true)
    if (restartErrors.length > 0) {
      throw new Error(`升级后服务恢复未完全激活：${restartErrors.join('；')}`)
    }

    // Verify `dsh-ray doctor --profile <profile>` against live restarted state.
    const doctorArgs = [
      ...cliPrefix,
      'doctor',
      '--dsh-home',
      canonicalHome,
      ...(options.profile !== undefined ? ['--profile', options.profile] : []),
      '--json',
    ]
    await appendPrivateLog(logFile, `running ${cliCmd} ${doctorArgs.join(' ')}`)
    const docRes = detailedRunner(cliCmd, doctorArgs, { env: workerEnv, timeoutMs: 60_000 })
    if (docRes.stderr.trim()) await appendPrivateLog(logFile, docRes.stderr)
    let doctorOk = false
    let doctorFailureDetail: string | undefined
    if (docRes.status === 0 && docRes.stdout.trim()) {
      try {
        const parsed = JSON.parse(docRes.stdout) as { ok?: unknown; checks?: Array<{ status?: unknown; summary?: unknown }> }
        doctorOk = parsed.ok === true
        if (!doctorOk && Array.isArray(parsed.checks)) {
          doctorFailureDetail = parsed.checks.find(c => c.status === 'fail')?.summary as string | undefined
        }
      } catch {
        const report = await (deps.collectDoctor ?? collectLiveDoctorReport)({
          dshHome: canonicalHome,
          ...(options.profile !== undefined ? { profile: options.profile } : {}),
          platform,
          home: osHome,
          env: workerEnv,
        })
        doctorOk = report.ok
        doctorFailureDetail = report.checks.find(c => c.status === 'fail')?.summary
      }
    } else {
      const report = await (deps.collectDoctor ?? collectLiveDoctorReport)({
        dshHome: canonicalHome,
        ...(options.profile !== undefined ? { profile: options.profile } : {}),
        platform,
        home: osHome,
        env: workerEnv,
      })
      doctorOk = report.ok
      doctorFailureDetail = report.checks.find(c => c.status === 'fail')?.summary
    }
    if (!doctorOk) {
      throw new Error(`升级后 doctor 健康校验未通过：${doctorFailureDetail ?? '存在失败检查项'}`)
    }

    const updatedVersion = stripLeadingV(
      (await readInstalledProfileEnhancedVersion(canonicalHome, options.profile))
      ?? (dshRayBin ? await readGlobalCliVersionFromBin(dshRayBin) : undefined)
      ?? options.targetVersion
      ?? existingStatus?.targetVersion
      ?? CLI_VERSION,
    ) ?? CLI_VERSION
    const finishedAt = new Date(nowFn()).toISOString()

    await writePrivateAtomic(
      statusFile,
      `${JSON.stringify({
        schemaVersion: 1,
        runId,
        status: 'succeeded',
        version: updatedVersion,
        ...(options.profile !== undefined ? { profile: options.profile } : {}),
        ...(existingStatus?.fromVersion !== undefined ? { fromVersion: existingStatus.fromVersion } : {}),
        ...(options.targetVersion !== undefined ? { targetVersion: options.targetVersion } : {}),
        toNpm: effectiveToNpm,
        startedAt,
        updatedAt: finishedAt,
        finishedAt,
      } satisfies AutoUpdateStatusRecord, null, 2)}\n`,
    )
    await appendPrivateLog(logFile, `auto-update succeeded: version=v${updatedVersion}`)
    return 0
  } catch (error) {
    const rawMsg = error instanceof Error ? error.message : String(error)
    const redactedErr = redactAutoUpdateText(rawMsg, 320)
    await appendPrivateLog(logFile, `auto-update failed: ${redactedErr}`).catch(() => undefined)
    // Always restore managed services so rollback/failure leaves the assistant reachable.
    await ensureRecoveredServices(false).catch(() => undefined)
    const finishedAt = new Date(nowFn()).toISOString()
    await writePrivateAtomic(
      statusFile,
      `${JSON.stringify({
        schemaVersion: 1,
        runId,
        status: 'failed',
        error: redactedErr,
        ...(options.profile !== undefined ? { profile: options.profile } : {}),
        ...(existingStatus?.fromVersion !== undefined ? { fromVersion: existingStatus.fromVersion } : {}),
        ...(options.targetVersion !== undefined ? { targetVersion: options.targetVersion } : {}),
        toNpm: effectiveToNpm,
        startedAt,
        updatedAt: finishedAt,
        finishedAt,
      } satisfies AutoUpdateStatusRecord, null, 2)}\n`,
    ).catch(() => undefined)
    return 1
  }
}

/**
 * Reconcile one-shot `auto-update-notify.json` + `auto-update-status.json` for Feishu/channel delivery.
 */
export async function inspectPendingAutoUpdateNotification(
  dshHome: string,
  deps: Readonly<{ now?: () => number; runner?: CommandRunner }> = {},
): Promise<ReconciledAutoUpdateNotification | undefined> {
  const notify = await readAutoUpdateNotifyMarker(dshHome)
  if (notify === undefined) return undefined

  const statusRecord = await readAutoUpdateStatus(dshHome)
  const nowMs = (deps.now ?? Date.now)()

  if (statusRecord && statusRecord.runId === notify.runId) {
    if (statusRecord.status === 'succeeded') {
      const bareVer = stripLeadingV(statusRecord.version ?? notify.targetVersion ?? notify.fromVersion) ?? CLI_VERSION
      return {
        ready: true,
        status: 'succeeded',
        notify,
        statusRecord,
        message: `✅ 自动升级完成：当前版本 v${bareVer}，服务已恢复运行。`,
      }
    }
    if (statusRecord.status === 'failed') {
      const reason = redactAutoUpdateText(statusRecord.error ?? '请查看 auto-update.log 了解详情', 260)
      return {
        ready: true,
        status: 'failed',
        notify,
        statusRecord,
        message: `⚠️ 自动升级失败并已回滚保护：${reason}`,
      }
    }

    // If a pending/running transient systemd unit vanished or marker became stale, surface safe unknown failure.
    const requestedMs = Date.parse(notify.requestedAt)
    const stale = Number.isFinite(requestedMs) && (nowMs - requestedMs) > STALE_PENDING_MS
    let workerVanished = false
    if (statusRecord.launcher === 'systemd-run' && statusRecord.unitName && statusRecord.status === 'running') {
      const unitRunner: CommandRunner = deps.runner ?? ((cmd, args) =>
        defaultDetailedRunner(cmd, args, { env: ensureLinuxUserSessionEnv(process.env, process.platform) }))
      const active = isSystemdUnitActive(statusRecord.unitName, unitRunner)
      const ageMs = Number.isFinite(requestedMs) ? nowMs - requestedMs : 0
      if (!active && ageMs > 10_000) workerVanished = true
    } else if (statusRecord.launcher === 'detached' && statusRecord.pid !== undefined && statusRecord.status === 'running') {
      const ageMs = Number.isFinite(requestedMs) ? nowMs - requestedMs : 0
      if (!isPidAlive(statusRecord.pid) && ageMs > 10_000) workerVanished = true
    }
    if (stale || workerVanished) {
      return {
        ready: true,
        status: 'failed',
        notify,
        statusRecord,
        message: '⚠️ 自动升级失败并已回滚保护：后台升级任务未正常结束，请运行 dsh-ray doctor 检查状态。',
      }
    }
    return { ready: false, notify, statusRecord }
  }

  // Status file missing or belongs to another run; only surface if marker itself went stale.
  const requestedMs = Date.parse(notify.requestedAt)
  if (Number.isFinite(requestedMs) && (nowMs - requestedMs) > STALE_PENDING_MS) {
    return {
      ready: true,
      status: 'failed',
      notify,
      ...(statusRecord ? { statusRecord } : {}),
      message: '⚠️ 自动升级失败并已回滚保护：后台升级状态未确认，请运行 dsh-ray doctor 检查状态。',
    }
  }
  return { ready: false, notify, ...(statusRecord ? { statusRecord } : {}) }
}
