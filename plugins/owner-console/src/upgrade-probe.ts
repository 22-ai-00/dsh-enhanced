import { createRequire } from 'node:module'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync,
  readdirSync, readFileSync, readSync, realpathSync, statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  collectUserBinDirs, defaultExecProbe, defaultIsExecutable, redactProbeDetail, sanitizedProbeEnv,
  type ProbeExecFn, type ProbeExecResult,
} from './probes.js'
import { boundedConfig, hasControlChars, isSingleLineCommand, type SettingsService } from './settings.js'
import type { SelfUpgradePreview, SelfUpgradeRunState, SelfUpgradeStatus, OwnerConsoleWriteResult } from './typert.js'
import { version as PACKAGE_VERSION } from './version.js'

const CACHE_TTL_MS = 60_000
const CLI_CHECK_TIMEOUT_MS = 25_000
const CLI_DRY_RUN_TIMEOUT_MS = 30_000
const REGISTRY_TIMEOUT_MS = 6_000
const EARLY_SPAWN_SETTLE_MS = 60
const MAX_HOST_METADATA_BYTES = 16_384
const MAX_REGISTRY_BYTES = 32_768
const MAX_LOG_TAIL_READ_BYTES = 16_384
const MAX_LOG_TAIL_CHARS = 1_800
const UPGRADE_LOG_PATTERN = /^owner-console-upgrade-(\d+)\.log$/u
const CSI_ANSI_PATTERN = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, 'gu')
const ENHANCED_NPM_LATEST_URL = 'https://registry.npmjs.org/@dsh-ray%2Fowner-console/latest'
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u

export interface BoundHostMetadata {
  readonly status: 'ready' | 'missing' | 'corrupt' | 'unreadable'
  readonly version: string | null
  readonly cacheRoot?: string
  readonly receiptDigest?: string
  readonly error?: string
}

export interface UpgradeHostContext {
  get(name: string): unknown
}

export type SpawnDetachedProcessLike = Pick<ChildProcess, 'pid' | 'unref'> & {
  once?: (event: string, listener: (...args: unknown[]) => void) => unknown
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown
}

export type SpawnDetachedFn = (
  command: string,
  args: readonly string[],
  options: Readonly<{
    cwd?: string
    env: NodeJS.ProcessEnv
    detached: boolean
    stdio: 'ignore' | readonly ['ignore', number, number]
    shell: boolean
  }>,
) => SpawnDetachedProcessLike

export interface SelfUpgradeProberOptions {
  readonly execFn?: ProbeExecFn
  readonly spawnFn?: SpawnDetachedFn
  readonly fetchFn?: typeof fetch
  readonly now?: () => number
  readonly ttlMs?: number
  readonly currentVersion?: string
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly cliBin?: string
  readonly execPath?: string
  readonly isPidAlive?: (pid: number) => boolean
}

interface ResolvedUpgradeContext {
  readonly dshHome: string | null
  readonly profileName: string
  readonly profileDir: string | null
}

interface ParsedCliPayload {
  readonly mode: string | null
  readonly frozenSystemdProfile: boolean
  readonly currentEnhancedVersion: string
  readonly latestEnhancedVersion: string | null
  readonly enhancedUpdateAvailable: boolean
  readonly boundHostVersion: string | null
  readonly targetHostVersion: string | null
  readonly hostUpdateAvailable: boolean
  readonly offline: boolean
  readonly canExecute: boolean
  readonly steps: readonly string[]
  readonly blockedReasons: readonly string[]
  readonly backupRequired: boolean
}

function defaultSpawnDetached(
  command: string,
  args: readonly string[],
  options: Readonly<{
    cwd?: string
    env: NodeJS.ProcessEnv
    detached: boolean
    stdio: 'ignore' | readonly ['ignore', number, number]
    shell: boolean
  }>,
): SpawnDetachedProcessLike {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    detached: options.detached,
    stdio: options.stdio === 'ignore' ? 'ignore' : [...options.stdio],
    shell: options.shell,
    windowsHide: true,
  })
  // Prevent async spawn ENOENT/EACCES from raising an unhandled EventEmitter error inside GUI hosts.
  child.on('error', () => {})
  return child
}

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' && !hasControlChars(value.trim()) ? value.trim() : null
}

function resolveUpgradeContext(host: UpgradeHostContext, env: NodeJS.ProcessEnv): ResolvedUpgradeContext {
  const profileContext = host.get('profileContext') as Readonly<{ dir?: unknown; home?: unknown; name?: unknown }> | undefined
  const settings = host.get('settings') as (SettingsService & { documentPath?: unknown }) | undefined
  const docPath = typeof settings?.documentPath === 'string' && settings.documentPath.trim() !== ''
    ? settings.documentPath.trim() : null
  const profileDir = textOrNull(profileContext?.dir)
    ?? (docPath !== null ? dirname(docPath) : null)
  let dshHome = textOrNull(profileContext?.home)
  if (dshHome === null && profileDir !== null && dirname(profileDir).endsWith('profiles')) {
    dshHome = dirname(dirname(profileDir))
  }
  if (dshHome === null) dshHome = textOrNull(env['DSH_HOME'])
  const profileName = textOrNull(profileContext?.name)
    ?? (profileDir !== null ? profileDir.split(/[\\/]/u).filter(Boolean).at(-1) ?? 'default' : 'default')
  return { dshHome, profileName, profileDir }
}

/** Compare strict SemVer strings; returns 1 if `a > b`, -1 if `a < b`, 0 if equal/unparseable. */
export function compareSemver(a: string | null | undefined, b: string | null | undefined): -1 | 0 | 1 {
  const ma = typeof a === 'string' ? SEMVER_PATTERN.exec(a.trim()) : null
  const mb = typeof b === 'string' ? SEMVER_PATTERN.exec(b.trim()) : null
  if (ma === null || mb === null) return 0
  for (let idx = 1; idx <= 3; idx++) {
    const na = Number(ma[idx])
    const nb = Number(mb[idx])
    if (na > nb) return 1
    if (na < nb) return -1
  }
  const pa = ma[4]
  const pb = mb[4]
  if (pa === undefined && pb === undefined) return 0
  if (pa === undefined) return 1
  if (pb === undefined) return -1
  const partsA = pa.split('.')
  const partsB = pb.split('.')
  const len = Math.max(partsA.length, partsB.length)
  for (let i = 0; i < len; i++) {
    const ia = partsA[i]
    const ib = partsB[i]
    if (ia === undefined) return -1
    if (ib === undefined) return 1
    const numA = /^\d+$/u.test(ia)
    const numB = /^\d+$/u.test(ib)
    if (numA && numB) {
      const va = Number(ia); const vb = Number(ib)
      if (va !== vb) return va > vb ? 1 : -1
    } else if (numA !== numB) {
      return numA ? -1 : 1
    } else if (ia !== ib) {
      return ia > ib ? 1 : -1
    }
  }
  return 0
}

/** Read `$DSH_HOME/.dsh-ray-host.json` strictly without following symlinks or group/world-writable files. */
export function readBoundHostMetadata(dshHome: string | null): BoundHostMetadata {
  if (dshHome === null || dshHome.trim() === '') return { status: 'missing', version: null }
  let canonicalHome: string
  try {
    canonicalHome = realpathSync(resolve(dshHome))
  } catch {
    return { status: 'missing', version: null }
  }
  const filePath = join(canonicalHome, '.dsh-ray-host.json')
  let fd: number | undefined
  try {
    const flags = constants.O_RDONLY | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0)
    fd = openSync(filePath, flags)
    const st = fstatSync(fd)
    if (!st.isFile() || st.nlink !== 1) return { status: 'corrupt', version: null, error: 'host metadata must be a regular file' }
    if ((st.mode & 0o077) !== 0) return { status: 'corrupt', version: null, error: 'host metadata permissions must be private (0600)' }
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
      return { status: 'corrupt', version: null, error: 'host metadata owner uid mismatch' }
    }
    if (st.size <= 0 || st.size > MAX_HOST_METADATA_BYTES) {
      return { status: 'corrupt', version: null, error: 'host metadata file size is out of bounds' }
    }
    const raw = readFileSync(fd, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    const obj = boundedConfig(parsed)
    if (obj['schemaVersion'] !== 1) return { status: 'corrupt', version: null, error: 'unsupported .dsh-ray-host.json schemaVersion' }
    const version = textOrNull(obj['version'])
    const cacheRoot = textOrNull(obj['cacheRoot'])
    const receiptDigest = textOrNull(obj['receiptDigest'])
    if (version === null || cacheRoot === null || receiptDigest === null) {
      return { status: 'corrupt', version: null, error: 'missing required fields in .dsh-ray-host.json' }
    }
    return { status: 'ready', version, cacheRoot, receiptDigest }
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing', version: null }
    }
    if (error instanceof SyntaxError) {
      return { status: 'corrupt', version: null, error: 'corrupt .dsh-ray-host.json JSON' }
    }
    return {
      status: 'unreadable',
      version: null,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* noop */ }
    }
  }
}

/** Read installed `@deepseek-ai/dsh` version from runtime layout without adding package dependencies. */
export function readInstalledHostVersion(): string | null {
  try {
    const req = createRequire(import.meta.url)
    for (const candidate of ['@deepseek-ai/dsh/package.json', '@deepseek-ai/dsh-app-boot/package.json']) {
      try {
        const resolved = req.resolve(candidate)
        const parsed = JSON.parse(readFileSync(resolved, 'utf8')) as { name?: unknown; version?: unknown }
        if (parsed.name === '@deepseek-ai/dsh' && typeof parsed.version === 'string' && parsed.version.trim() !== '') {
          return parsed.version.trim()
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
          if (parsed.name === '@deepseek-ai/dsh' && typeof parsed.version === 'string' && parsed.version.trim() !== '') {
            return parsed.version.trim()
          }
        }
      } catch { /* continue */ }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return null
}

/** Detect frozen Linux systemd cohort installation requiring out-of-band CLI upgrade. */
export function detectFrozenSystemdProfile(
  dshHome: string | null,
  profileName: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): boolean {
  if (platform !== 'linux') return false
  if (dshHome !== null && dshHome.trim() !== '') {
    const cohortsRoot = join(dshHome, 'rsi-local-cohorts')
    if (existsSync(join(cohortsRoot, profileName, 'receipt.json')) || existsSync(join(cohortsRoot, 'receipt.json'))) {
      return true
    }
  }
  return typeof env['INVOCATION_ID'] === 'string' && env['INVOCATION_ID'].trim() !== ''
    && existsSync('/etc/systemd/system')
}

function buildCliUpgradeCommand(dshHome: string | null, profileName: string, frozen: boolean): string {
  if (frozen) {
    const base = 'sudo -u <owner> node scripts/install/upgrade-program.mjs'
    const homeFlag = dshHome === null ? '' : ` --dsh-home "${dshHome}"`
    return `先停止受控 systemd 服务后执行：dsh-ray upgrade --yes${homeFlag} --profile ${profileName}（或 ${base}）`
  }
  const args = ['dsh-ray', 'upgrade', '--yes']
  if (dshHome !== null) args.push('--dsh-home', JSON.stringify(dshHome))
  if (profileName !== '' && profileName !== 'default') args.push('--profile', profileName)
  return args.join(' ')
}

function candidateUpgradeBinDirs(
  envSource: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  execPath: string = process.execPath,
  extraBinDirs: readonly string[] = [],
  includePath = false,
): readonly string[] {
  const home = envSource['HOME']?.trim() || homedir()
  return collectUserBinDirs({
    env: envSource,
    homeDir: home,
    platform,
    execPath,
    extraBinDirs,
    includePath,
  })
}

function normalizePathKey(entry: string, platform: NodeJS.Platform): string {
  const trimmed = entry.trim().replace(/[\\/]+$/u, '') || entry.trim()
  return platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

export interface BuildUpgradeProbeEnvOptions {
  readonly extraBinDirs?: readonly string[]
  readonly execPath?: string
}

/** Build non-TTY safe (`CI=true`) upgrade child environment with `DSH_HOME` and resolved Node/pnpm/CLI `PATH`. */
export function buildUpgradeProbeEnv(
  envSource: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  dshHome: string | null = null,
  options: BuildUpgradeProbeEnvOptions = {},
): NodeJS.ProcessEnv {
  const env = sanitizedProbeEnv(envSource)
  env['CI'] = 'true'
  if (dshHome !== null && dshHome.trim() !== '') {
    env['DSH_HOME'] = dshHome
  }
  const pathDelimiter = platform === 'win32' ? ';' : ':'
  const pathEntries = (env['PATH'] ?? '')
    .split(pathDelimiter)
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
  const seen = new Set(pathEntries.map(entry => normalizePathKey(entry, platform)))
  for (const dir of candidateUpgradeBinDirs(envSource, platform, options.execPath ?? process.execPath, options.extraBinDirs)) {
    const key = normalizePathKey(dir, platform)
    if (seen.has(key) || !existsSync(dir)) continue
    seen.add(key)
    pathEntries.push(dir)
  }
  if (pathEntries.length > 0) {
    env['PATH'] = pathEntries.join(pathDelimiter)
  }
  return env
}

/** Discover `dsh-ray`, `node`, or `pnpm` across explicit PATH and GUI/version-manager bin directories. */
export function discoverToolRuntimeBinary(
  binary: 'dsh-ray' | 'node' | 'pnpm',
  envSource: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  extraBinDirs: readonly string[] = [],
  execPath: string = process.execPath,
): string | undefined {
  const names = platform === 'win32'
    ? [`${binary}.cmd`, `${binary}.exe`, binary]
    : [binary]
  for (const dir of candidateUpgradeBinDirs(envSource, platform, execPath, extraBinDirs, true)) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (defaultIsExecutable(candidate, platform)) return candidate
    }
  }
  return undefined
}

/** Discover `dsh-ray` CLI executable across PATH, npm-global, local bin, Homebrew, nvm, fnm, volta, and execPath dirs. */
export function discoverDshRayBinary(
  envSource: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  extraBinDirs: readonly string[] = [],
  execPath: string = process.execPath,
): string | undefined {
  return discoverToolRuntimeBinary('dsh-ray', envSource, platform, extraBinDirs, execPath)
}

function isMissingBinaryError(result: ProbeExecResult): boolean {
  return result.errorCode === 'ENOENT' || result.errorCode === 'ENOTDIR' || result.errorCode === 'EACCES'
}

function isPlainObject(input: unknown): input is Readonly<Record<string, unknown>> {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
}

function upgradeCacheKey(ctx: ResolvedUpgradeContext): string {
  return `${ctx.dshHome ?? ''}::${ctx.profileName}`
}

function parseDshRayUpgradeJson(stdout: string, fallbackCurrent: string): ParsedCliPayload | null {
  const trimmed = stdout.trim()
  if (trimmed === '') return null
  const jsonStart = trimmed.indexOf('{')
  if (jsonStart < 0) return null
  let parsed: Record<string, unknown>
  try {
    const raw = JSON.parse(trimmed.slice(jsonStart)) as unknown
    if (!isPlainObject(raw)) return null
    parsed = raw as Record<string, unknown>
  } catch {
    return null
  }
  if (parsed['command'] !== 'upgrade' && parsed['schemaVersion'] !== 1) return null
  if (parsed['command'] !== 'upgrade'
    && (!isPlainObject(parsed['packages']) || !isPlainObject(parsed['readiness']) || !isPlainObject(parsed['plan']))) {
    return null
  }

  const packages = isPlainObject(parsed['packages']) ? parsed['packages'] : {}
  const boundHost = isPlainObject(packages['boundHost']) ? packages['boundHost'] : {}
  const registry = isPlainObject(parsed['registry']) ? parsed['registry'] : {}
  const readiness = isPlainObject(parsed['readiness']) ? parsed['readiness'] : {}
  const plan = isPlainObject(parsed['plan']) ? parsed['plan'] : {}
  const frozenSystemd = isPlainObject(parsed['frozenSystemd']) ? parsed['frozenSystemd'] : {}
  const execution = isPlainObject(parsed['execution']) ? parsed['execution'] : {}

  const mode = textOrNull(parsed['mode'])
  const frozenDetected = mode === 'frozen-linux-systemd' || frozenSystemd['detected'] === true
  const currentEnhancedVersion = textOrNull(packages['installedEnhancedVersion']) ?? fallbackCurrent
  const latestEnhancedVersion = textOrNull(registry['latestEnhancedVersion'])
    ?? textOrNull(packages['targetEnhancedVersion'])
  const boundHostVersion = textOrNull(boundHost['installedVersion'])
  const targetHostVersion = textOrNull(boundHost['targetVersion'])
    ?? textOrNull(registry['latestDshHostVersion'])
    ?? textOrNull(frozenSystemd['targetDshVersion'])
  const offline = registry['status'] === 'unavailable'
  const enhancedUpdateAvailable = packages['upgradeAvailable'] === true
    || (latestEnhancedVersion !== null && compareSemver(latestEnhancedVersion, currentEnhancedVersion) > 0)
  const hostUpdateAvailable = boundHost['upgradeAvailable'] === true
    || (boundHostVersion !== null && targetHostVersion !== null && compareSemver(targetHostVersion, boundHostVersion) > 0)
  const blockedReasons = Array.isArray(readiness['blockedReasons'])
    ? readiness['blockedReasons'].filter((item): item is string => typeof item === 'string' && item.trim() !== '').slice(0, 16)
    : []
  const steps = Array.isArray(plan['steps'])
    ? plan['steps'].filter((item): item is string => typeof item === 'string' && item.trim() !== '').slice(0, 16)
    : []
  const backupFiles = Array.isArray(plan['backupFiles']) ? plan['backupFiles'] : []
  const rawExecutionError = typeof execution['error'] === 'string' ? redactProbeDetail(execution['error']) : ''
  const canExecute = plan['canExecute'] !== false && readiness['ok'] !== false && rawExecutionError === ''
  if (!canExecute && blockedReasons.length === 0) {
    if (rawExecutionError !== '') {
      blockedReasons.push(rawExecutionError)
    } else if (offline) {
      blockedReasons.push('当前无法连接 npm registry 解析目标版本，请检查网络后重试。')
    }
  }

  return {
    mode,
    frozenSystemdProfile: frozenDetected,
    currentEnhancedVersion,
    latestEnhancedVersion,
    enhancedUpdateAvailable,
    boundHostVersion,
    targetHostVersion,
    hostUpdateAvailable,
    offline,
    canExecute,
    steps,
    blockedReasons,
    backupRequired: backupFiles.length > 0 || !frozenDetected,
  }
}

function buildDshRayArgs(
  subcommandFlag: '--check' | '--dry-run' | '--yes',
  ctx: ResolvedUpgradeContext,
  confirmDshHomeStopped = false,
): string[] {
  const args = ['upgrade', subcommandFlag, '--json']
  if (ctx.dshHome !== null) args.push('--dsh-home', ctx.dshHome)
  if (ctx.profileName !== '') args.push('--profile', ctx.profileName)
  if (subcommandFlag === '--yes' && confirmDshHomeStopped) {
    args.push('--confirm-dsh-home-stopped')
  }
  return args
}

function resolveLogFile(dshHome: string | null, timestamp: number): Readonly<{ fd?: number; path?: string }> {
  if (dshHome === null || dshHome.trim() === '') return {}
  try {
    const logsDir = join(dshHome, 'logs')
    mkdirSync(logsDir, { recursive: true, mode: 0o700 })
    const logPath = join(logsDir, `owner-console-upgrade-${timestamp}.log`)
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND
      | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0)
    const fd = openSync(logPath, flags, 0o600)
    return { fd, path: logPath }
  } catch {
    return {}
  }
}

interface TrackedUpgradeRun {
  readonly pid?: number
  readonly startedAt: number
  readonly finishedAt?: number
  readonly logPath?: string
  readonly targetVersion?: string | null
  readonly exitCode?: number | null
  readonly spawnError?: string
}

function readUpgradeLogTail(logPath: string | undefined): string | undefined {
  if (logPath === undefined || logPath.trim() === '') return undefined
  let fd: number | undefined
  try {
    const lst = lstatSync(logPath)
    if (lst.isSymbolicLink() || !lst.isFile()) return undefined
    const flags = constants.O_RDONLY | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0)
    fd = openSync(logPath, flags)
    const st = fstatSync(fd)
    if (!st.isFile() || st.size <= 0) return undefined
    const readBytes = Math.min(st.size, MAX_LOG_TAIL_READ_BYTES)
    const offset = Math.max(0, st.size - readBytes)
    const buf = Buffer.allocUnsafe(readBytes)
    let totalRead = 0
    while (totalRead < readBytes) {
      const n = readSync(fd, buf, totalRead, readBytes - totalRead, offset + totalRead)
      if (n <= 0) break
      totalRead += n
    }
    const rawText = buf.subarray(0, totalRead).toString('utf8').replace(CSI_ANSI_PATTERN, '')
    const redactedLines = rawText
      .split(/\r?\n/u)
      .map(line => redactProbeDetail(line))
      .filter(line => line !== '')
    if (redactedLines.length === 0) return undefined
    const joined = redactedLines.join('\n')
    return joined.length > MAX_LOG_TAIL_CHARS ? joined.slice(-MAX_LOG_TAIL_CHARS) : joined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* noop */ }
    }
  }
}

function findLatestUpgradeLogPath(dshHome: string | null): Readonly<{ path: string; startedAt: number }> | undefined {
  if (dshHome === null || dshHome.trim() === '') return undefined
  const logsDir = join(dshHome, 'logs')
  try {
    const entries = readdirSync(logsDir, { withFileTypes: true })
    let best: { path: string; startedAt: number } | undefined
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const match = UPGRADE_LOG_PATTERN.exec(entry.name)
      if (match === null) continue
      const startedAt = Number(match[1])
      if (!Number.isSafeInteger(startedAt) || startedAt < 0) continue
      const candidatePath = join(logsDir, entry.name)
      try {
        const st = lstatSync(candidatePath)
        if (st.isSymbolicLink() || !st.isFile()) continue
      } catch {
        continue
      }
      if (best === undefined || startedAt > best.startedAt) {
        best = { path: candidatePath, startedAt }
      }
    }
    return best
  } catch {
    return undefined
  }
}

function parseUpgradeLogOutcome(logTail: string | undefined): Readonly<{
  jsonOk?: boolean
  error?: string
  lastLine?: string
}> {
  if (logTail === undefined || logTail.trim() === '') return {}
  const lines = logTail.split(/\r?\n/u).map(l => l.trim()).filter(l => l !== '')
  if (lines.length === 0) return {}
  let jsonOk: boolean | undefined
  let parsedError: string | undefined
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    const jsonStart = line.indexOf('{')
    if (jsonStart >= 0) {
      try {
        const raw = JSON.parse(line.slice(jsonStart)) as unknown
        if (isPlainObject(raw)) {
          if (typeof raw['ok'] === 'boolean') jsonOk = raw['ok']
          const execObj = isPlainObject(raw['execution']) ? raw['execution'] : undefined
          const errStr = textOrNull(raw['error']) ?? textOrNull(execObj?.['error'])
          if (errStr !== null) parsedError = redactProbeDetail(errStr)
          if (jsonOk !== undefined || parsedError !== undefined) break
        }
      } catch {
        // Non-JSON log line.
      }
    }
  }
  const errorLine = [...lines].reverse().find(line =>
    /ERR_PNPM_|ENOENT|EACCES|npm ERR!|ETIMEDOUT|\bError:\b|升级失败|失败：|退出码\s*[1-9]/u.test(line))
  return {
    ...(jsonOk === undefined ? {} : { jsonOk }),
    ...(parsedError !== undefined ? { error: parsedError } : errorLine !== undefined ? { error: errorLine } : {}),
    lastLine: lines[lines.length - 1]!,
  }
}

/** Bounded self-upgrade prober and safe detached upgrade launcher for owner-console. */
export class SelfUpgradeProber {
  private readonly execFn: ProbeExecFn
  private readonly spawnFn: SpawnDetachedFn
  private readonly fetchFn: typeof fetch
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly currentVersion: string
  private readonly platform: NodeJS.Platform
  private readonly envSource: NodeJS.ProcessEnv
  private readonly cliBin: string
  private readonly execPath: string
  private readonly isPidAlive: (pid: number) => boolean
  private resolvedCliBin: string | undefined
  private readonly cache = new Map<string, Readonly<{ expiresAt: number; status: SelfUpgradeStatus }>>()
  private readonly inflight = new Map<string, Promise<SelfUpgradeStatus>>()
  private readonly resolvedModes = new Map<string, string | null>()
  private readonly latestRuns = new Map<string, TrackedUpgradeRun>()

  constructor(options: SelfUpgradeProberOptions = {}) {
    this.execFn = options.execFn ?? defaultExecProbe
    this.spawnFn = options.spawnFn ?? defaultSpawnDetached
    this.fetchFn = options.fetchFn ?? fetch
    this.now = options.now ?? (() => Date.now())
    this.ttlMs = options.ttlMs ?? CACHE_TTL_MS
    this.currentVersion = options.currentVersion ?? PACKAGE_VERSION
    this.platform = options.platform ?? process.platform
    this.envSource = options.env ?? process.env
    this.cliBin = options.cliBin ?? 'dsh-ray'
    this.execPath = options.execPath ?? process.execPath
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive
  }

  invalidate(): void {
    this.cache.clear()
  }

  private buildSafeEnv(dshHome: string | null, cliCommand?: string): NodeJS.ProcessEnv {
    const extraBinDirs: string[] = []
    if (cliCommand !== undefined && isAbsolute(cliCommand)) {
      extraBinDirs.push(dirname(cliCommand))
    }
    const discoveredNode = discoverToolRuntimeBinary('node', this.envSource, this.platform, extraBinDirs, this.execPath)
    if (discoveredNode !== undefined) extraBinDirs.push(dirname(discoveredNode))
    const discoveredPnpm = discoverToolRuntimeBinary('pnpm', this.envSource, this.platform, extraBinDirs, this.execPath)
    if (discoveredPnpm !== undefined) extraBinDirs.push(dirname(discoveredPnpm))
    return buildUpgradeProbeEnv(this.envSource, this.platform, dshHome, {
      extraBinDirs,
      execPath: this.execPath,
    })
  }

  private inspectLatestRun(ctx: ResolvedUpgradeContext, currentEnhancedVersion: string): SelfUpgradeRunState | undefined {
    const cacheKey = upgradeCacheKey(ctx)
    const tracked = this.latestRuns.get(cacheKey)
    const diskLog = tracked?.logPath === undefined ? findLatestUpgradeLogPath(ctx.dshHome) : undefined
    if (tracked === undefined && diskLog === undefined) return undefined

    const logPath = tracked?.logPath ?? diskLog?.path
    const startedAt = tracked?.startedAt ?? diskLog?.startedAt ?? this.now()
    const logTail = readUpgradeLogTail(logPath)
    if (tracked === undefined && logTail === undefined) return undefined

    const outcome = parseUpgradeLogOutcome(logTail)
    if (tracked?.spawnError !== undefined) {
      const error = redactProbeDetail(tracked.spawnError).slice(0, 500)
      return Object.freeze({
        state: 'failed',
        ...(tracked.pid !== undefined && tracked.pid > 0 ? { pid: tracked.pid } : {}),
        startedAt,
        ...(tracked.finishedAt !== undefined ? { finishedAt: tracked.finishedAt } : {}),
        ...(logPath !== undefined ? { logPath } : {}),
        summary: `后台升级启动失败：${error}`.slice(0, 500),
        error,
        ...(logTail !== undefined ? { logTail } : {}),
      })
    }

    const stillRunning = tracked !== undefined
      && tracked.exitCode === undefined
      && tracked.finishedAt === undefined
      && tracked.pid !== undefined
      && tracked.pid > 0
      && this.isPidAlive(tracked.pid)

    if (stillRunning) {
      const progressLine = outcome.lastLine !== undefined ? `（最新输出：${outcome.lastLine}）` : ''
      return Object.freeze({
        state: 'running',
        pid: tracked.pid!,
        startedAt,
        ...(logPath !== undefined ? { logPath } : {}),
        summary: `后台升级进程运行中（PID ${tracked.pid}）${progressLine}`.slice(0, 500),
        ...(logTail !== undefined ? { logTail } : {}),
      })
    }

    const finishedAt = tracked?.finishedAt
    const versionMatched = tracked?.targetVersion !== undefined
      && tracked.targetVersion !== null
      && currentEnhancedVersion === tracked.targetVersion
    const failed = (tracked?.exitCode !== undefined && tracked.exitCode !== null && tracked.exitCode !== 0)
      || outcome.jsonOk === false
      || (outcome.error !== undefined && outcome.jsonOk !== true && !versionMatched)
      || (tracked !== undefined
        && tracked.targetVersion !== undefined
        && tracked.targetVersion !== null
        && !versionMatched
        && outcome.jsonOk !== true
        && tracked.exitCode !== 0)

    if (failed) {
      const detail = outcome.error
        ?? (tracked?.exitCode !== undefined && tracked.exitCode !== null ? `退出码 ${tracked.exitCode}` : '进程已退出且未完成版本升级')
      const summary = `后台升级失败：${detail}`.slice(0, 500)
      return Object.freeze({
        state: 'failed',
        ...(tracked?.pid !== undefined && tracked.pid > 0 ? { pid: tracked.pid } : {}),
        startedAt,
        ...(finishedAt !== undefined ? { finishedAt } : {}),
        ...(logPath !== undefined ? { logPath } : {}),
        summary,
        error: detail.slice(0, 500),
        ...(logTail !== undefined ? { logTail } : {}),
      })
    }

    const summary = (outcome.jsonOk === true || versionMatched
      ? '后台升级已完成，请重启 Host / 桌面应用以加载新版本。'
      : (outcome.lastLine !== undefined ? `后台升级进程已结束：${outcome.lastLine}` : '后台升级进程已结束。')).slice(0, 500)
    return Object.freeze({
      state: 'succeeded',
      ...(tracked?.pid !== undefined && tracked.pid > 0 ? { pid: tracked.pid } : {}),
      startedAt,
      ...(finishedAt !== undefined ? { finishedAt } : {}),
      ...(logPath !== undefined ? { logPath } : {}),
      summary,
      ...(logTail !== undefined ? { logTail } : {}),
    })
  }

  private async execUpgradeCli(
    args: readonly string[],
    timeoutMs: number,
    dshHome: string | null,
  ): Promise<ProbeExecResult> {
    const initialBin = this.resolvedCliBin ?? this.cliBin
    if (!isSingleLineCommand(initialBin)) {
      return { stdout: '', stderr: 'invalid dsh-ray binary', exitCode: 1, errorCode: 'EINVAL' }
    }
    const initialEnv = this.buildSafeEnv(dshHome, initialBin)
    const firstResult = await this.execFn(initialBin, args, { timeoutMs, env: initialEnv })
    if (!isMissingBinaryError(firstResult)) {
      return firstResult
    }
    if (this.resolvedCliBin !== undefined) {
      this.resolvedCliBin = undefined
    }
    if (this.cliBin !== 'dsh-ray') {
      return firstResult
    }
    const discovered = discoverDshRayBinary(this.envSource, this.platform, [], this.execPath)
    if (discovered === undefined || discovered === initialBin || !isSingleLineCommand(discovered)) {
      return firstResult
    }
    const retryEnv = this.buildSafeEnv(dshHome, discovered)
    const retryResult = await this.execFn(discovered, args, { timeoutMs, env: retryEnv })
    if (!isMissingBinaryError(retryResult)) {
      this.resolvedCliBin = discovered
    }
    return retryResult
  }

  private async fetchLatestFromNpm(): Promise<Readonly<{ latest: string | null; offline: boolean; error?: string }>> {
    try {
      const response = await this.fetchFn(ENHANCED_NPM_LATEST_URL, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      })
      if (!response.ok) {
        return { latest: null, offline: true, error: `npm registry HTTP ${response.status}` }
      }
      const rawText = await response.text()
      if (rawText.length > MAX_REGISTRY_BYTES) {
        return { latest: null, offline: true, error: 'npm registry payload exceeded size limit' }
      }
      const parsed = JSON.parse(rawText) as { version?: unknown }
      const candidate = textOrNull(parsed.version)
      if (candidate === null || !SEMVER_PATTERN.test(candidate)) {
        return { latest: null, offline: true, error: 'invalid npm version payload' }
      }
      return { latest: candidate, offline: false }
    } catch (error: unknown) {
      return {
        latest: null,
        offline: true,
        error: error instanceof Error ? error.message : 'offline',
      }
    }
  }

  async check(host: UpgradeHostContext, force = false): Promise<SelfUpgradeStatus> {
    const resolved = resolveUpgradeContext(host, this.envSource)
    const cacheKey = upgradeCacheKey(resolved)
    if (!force) {
      const hit = this.cache.get(cacheKey)
      if (hit !== undefined && this.now() < hit.expiresAt && hit.status.latestRun?.state !== 'running') {
        return Object.freeze({ ...hit.status, cached: true })
      }
      const pending = this.inflight.get(cacheKey)
      if (pending !== undefined) return pending
    }

    const work = this.runCheck(resolved).finally(() => {
      this.inflight.delete(cacheKey)
    })
    this.inflight.set(cacheKey, work)
    const result = await work
    this.cache.set(cacheKey, { expiresAt: this.now() + this.ttlMs, status: result })
    return result
  }

  private async runCheck(ctx: ResolvedUpgradeContext): Promise<SelfUpgradeStatus> {
    const checkedAt = this.now()
    const cacheKey = upgradeCacheKey(ctx)
    const hostMeta = readBoundHostMetadata(ctx.dshHome)
    const installedHostVersion = readInstalledHostVersion()
    const baseFrozen = detectFrozenSystemdProfile(ctx.dshHome, ctx.profileName, this.platform, this.envSource)

    const cliResult = await this.execUpgradeCli(buildDshRayArgs('--check', ctx), CLI_CHECK_TIMEOUT_MS, ctx.dshHome)
    const cliPayload = cliResult.errorCode !== 'ENOENT' ? parseDshRayUpgradeJson(cliResult.stdout, this.currentVersion) : null

    if (cliPayload !== null) {
      this.resolvedModes.set(cacheKey, cliPayload.mode)
      const frozen = baseFrozen || cliPayload.frozenSystemdProfile
      const boundHostVersion = cliPayload.boundHostVersion ?? hostMeta.version
      const upgradeCommand = buildCliUpgradeCommand(ctx.dshHome, ctx.profileName, frozen)
      const note = (frozen
        ? '检测到受控 Linux systemd profile；请停止服务后按终端引导执行升级。'
        : cliPayload.blockedReasons.length > 0
          ? `存在升级前置阻塞：${cliPayload.blockedReasons[0]}`
          : cliPayload.offline
            ? '离线回退：已完成本地绑定与账本检查，未能连接 npm 查询最新版本。'
            : !cliPayload.canExecute || cliResult.exitCode !== 0
              ? '升级前置检查未通过，请查看升级预演诊断或在终端执行下方命令。'
              : cliPayload.enhancedUpdateAvailable || cliPayload.hostUpdateAvailable
                ? `发现可升级版本（@dsh-ray ${cliPayload.latestEnhancedVersion ?? this.currentVersion}）`
                : '当前已是最新已检查版本').slice(0, 500)
      const latestRun = this.inspectLatestRun(ctx, cliPayload.currentEnhancedVersion)
      return Object.freeze({
        currentEnhancedVersion: cliPayload.currentEnhancedVersion,
        latestEnhancedVersion: cliPayload.latestEnhancedVersion,
        enhancedUpdateAvailable: cliPayload.enhancedUpdateAvailable,
        boundHostVersion,
        installedHostVersion: installedHostVersion ?? boundHostVersion,
        targetHostVersion: cliPayload.targetHostVersion,
        hostUpdateAvailable: cliPayload.hostUpdateAvailable,
        frozenSystemdProfile: frozen,
        profileName: ctx.profileName,
        dshHome: ctx.dshHome,
        canTriggerDetached: !frozen && cliPayload.canExecute && cliResult.exitCode === 0,
        upgradeCommand,
        checkedAt,
        cached: false,
        offline: cliPayload.offline,
        checkSource: 'dsh-ray',
        note,
        ...(latestRun === undefined ? {} : { latestRun }),
      })
    }

    this.resolvedModes.delete(cacheKey)
    const npmResult = await this.fetchLatestFromNpm()
    const latestEnhancedVersion = npmResult.latest
    const enhancedUpdateAvailable = latestEnhancedVersion !== null
      && compareSemver(latestEnhancedVersion, this.currentVersion) > 0
    const upgradeCommand = buildCliUpgradeCommand(ctx.dshHome, ctx.profileName, baseFrozen)
    const cliDetail = redactProbeDetail(cliResult.stderr) || redactProbeDetail(cliResult.stdout)
    const cliUnavailableNote = cliResult.errorCode === 'ENOENT'
      ? '未检测到可执行 dsh-ray CLI，请确认已全局安装 dsh-ray；'
      : cliResult.errorCode === 'ETIMEDOUT'
        ? '本地 dsh-ray CLI 执行超时（私有 Host 收据校验或网络较慢），请稍后重试或在终端执行下方升级命令；'
        : cliResult.exitCode !== 0 || cliResult.errorCode !== undefined
          ? (cliDetail !== ''
            ? `本地 dsh-ray CLI 异常（退出码 ${cliResult.exitCode}：${cliDetail}）；`
            : `本地 dsh-ray CLI 返回退出码 ${cliResult.exitCode}；`)
          : ''
    const note = (baseFrozen
      ? `${cliUnavailableNote}受控 Linux systemd profile 仅支持终端带外升级。`
      : npmResult.offline
        ? `${cliUnavailableNote}离线回退（${npmResult.error ?? '网络不可达'}），已展示本地当前版本与绑定宿主版本。`
        : enhancedUpdateAvailable
          ? `${cliUnavailableNote}检测到 npm 新版本 ${latestEnhancedVersion}（当前 ${this.currentVersion}）。`
          : `${cliUnavailableNote}当前版本 ${this.currentVersion} 已为 npm 最新版本。`).slice(0, 500)
    const latestRun = this.inspectLatestRun(ctx, this.currentVersion)

    return Object.freeze({
      currentEnhancedVersion: this.currentVersion,
      latestEnhancedVersion,
      enhancedUpdateAvailable,
      boundHostVersion: hostMeta.version,
      installedHostVersion: installedHostVersion ?? hostMeta.version,
      targetHostVersion: null,
      hostUpdateAvailable: false,
      frozenSystemdProfile: baseFrozen,
      profileName: ctx.profileName,
      dshHome: ctx.dshHome,
      canTriggerDetached: false,
      upgradeCommand,
      checkedAt,
      cached: false,
      offline: npmResult.offline,
      checkSource: npmResult.offline ? 'offline' : 'npm-registry',
      note,
      ...(latestRun === undefined ? {} : { latestRun }),
    })
  }

  async dryRun(host: UpgradeHostContext): Promise<SelfUpgradePreview> {
    const { preview } = await this.runDryRun(host)
    return preview
  }

  private async runDryRun(
    host: UpgradeHostContext,
  ): Promise<Readonly<{ preview: SelfUpgradePreview; mode: string | null }>> {
    const resolved = resolveUpgradeContext(host, this.envSource)
    const cacheKey = upgradeCacheKey(resolved)
    const status = await this.check(host, false)

    const cliResult = await this.execUpgradeCli(buildDshRayArgs('--dry-run', resolved), CLI_DRY_RUN_TIMEOUT_MS, resolved.dshHome)
    const cliPayload = cliResult.errorCode !== 'ENOENT' ? parseDshRayUpgradeJson(cliResult.stdout, this.currentVersion) : null

    if (cliPayload !== null) {
      if (cliPayload.mode !== null) {
        this.resolvedModes.set(cacheKey, cliPayload.mode)
      }
      const frozen = status.frozenSystemdProfile || cliPayload.frozenSystemdProfile
      const supported = !frozen && cliPayload.canExecute && cliResult.exitCode === 0
      if (supported && !status.canTriggerDetached) {
        this.invalidate()
      }
      const warnings = [
        ...cliPayload.blockedReasons,
        ...(frozen ? ['受控 Linux systemd profile 禁止在 Host 内直接启动升级，请在停止服务后使用终端 CLI 升级。'] : []),
        ...(!frozen && !supported && cliPayload.blockedReasons.length === 0 && cliResult.exitCode !== 0
          ? [`dsh-ray upgrade --dry-run 返回退出码 ${cliResult.exitCode}。`]
          : []),
      ].map(item => item.slice(0, 500)).slice(0, 32)
      const summary = (cliPayload.steps.length > 0
        ? cliPayload.steps.join(' -> ')
        : frozen
          ? '预览完成：受控 Linux systemd profile 需在终端停止服务后执行带外升级'
          : supported
            ? '升级预演通过：将先备份现有配置与绑定并在后台执行 dsh-ray upgrade --yes'
            : cliPayload.blockedReasons[0]
              ? `升级预演发现阻塞项：${cliPayload.blockedReasons[0]}`
              : '升级预演发现阻塞项，请先修复后再升级').slice(0, 1_000)
      return {
        mode: cliPayload.mode,
        preview: Object.freeze({
          supported,
          frozenSystemdProfile: frozen,
          requiresOutOfBandCli: frozen,
          command: buildCliUpgradeCommand(resolved.dshHome, resolved.profileName, frozen),
          currentEnhancedVersion: cliPayload.currentEnhancedVersion,
          targetEnhancedVersion: cliPayload.latestEnhancedVersion,
          boundHostVersion: cliPayload.boundHostVersion ?? status.boundHostVersion,
          targetHostVersion: cliPayload.targetHostVersion,
          backupRequired: cliPayload.backupRequired,
          warnings,
          summary,
        }),
      }
    }

    const warnings: string[] = []
    const cliDetail = redactProbeDetail(cliResult.stderr) || redactProbeDetail(cliResult.stdout)
    if (cliResult.errorCode === 'ENOENT') {
      warnings.push('未检测到可执行 dsh-ray CLI，请确认已全局安装 dsh-ray。')
    } else if (cliResult.errorCode === 'ETIMEDOUT') {
      warnings.push('本地 dsh-ray CLI 执行超时（私有 Host 收据校验或网络较慢），请稍后重试或在终端执行下方升级命令。')
    } else if (cliResult.exitCode !== 0 || cliResult.errorCode !== undefined) {
      warnings.push((cliDetail !== ''
        ? `dsh-ray upgrade --dry-run 返回退出码 ${cliResult.exitCode}：${cliDetail}`
        : `dsh-ray upgrade --dry-run 返回退出码 ${cliResult.exitCode}。`).slice(0, 500))
    } else {
      warnings.push((cliDetail !== ''
        ? `dsh-ray upgrade --dry-run 输出无法解析：${cliDetail}`
        : 'dsh-ray upgrade --dry-run 未返回有效升级报告 JSON。').slice(0, 500))
    }
    if (status.frozenSystemdProfile) {
      warnings.push('受控 Linux systemd profile 仅支持终端带外升级。')
    }
    const summary = (status.frozenSystemdProfile
      ? '当前为受控 Linux systemd profile，请先停止服务并在终端执行 CLI 升级。'
      : cliResult.errorCode === 'ENOENT'
        ? '未检测到可执行 dsh-ray CLI，请确认已全局安装 dsh-ray。'
        : cliResult.errorCode === 'ETIMEDOUT'
          ? '本地 dsh-ray CLI 执行超时（私有 Host 收据校验或网络较慢），请稍后重试或在终端执行下方升级命令。'
          : cliDetail !== ''
            ? `未能完成本地 dsh-ray CLI 预演（${cliDetail}）；请先在终端检查并运行 dsh-ray upgrade。`
            : '未能完成本地 dsh-ray CLI 预演；请先在终端检查并运行 dsh-ray upgrade。').slice(0, 1_000)

    return {
      mode: null,
      preview: Object.freeze({
        supported: false,
        frozenSystemdProfile: status.frozenSystemdProfile,
        requiresOutOfBandCli: status.frozenSystemdProfile,
        command: status.upgradeCommand,
        currentEnhancedVersion: status.currentEnhancedVersion,
        targetEnhancedVersion: status.latestEnhancedVersion,
        boundHostVersion: status.boundHostVersion,
        targetHostVersion: status.targetHostVersion,
        backupRequired: true,
        warnings,
        summary,
      }),
    }
  }

  async trigger(host: UpgradeHostContext, confirmed: boolean): Promise<OwnerConsoleWriteResult> {
    if (confirmed !== true) {
      return Object.freeze({
        applied: false,
        entry: 'dsh-ray-upgrade',
        note: '请先执行升级预演并明确确认后再触发自助升级',
      })
    }
    const status = await this.check(host, true)
    if (status.frozenSystemdProfile) {
      return Object.freeze({
        applied: false,
        entry: 'dsh-ray-upgrade',
        note: `当前为受控 Linux systemd profile，禁止在 Host 内直接升级；${status.upgradeCommand}`,
      })
    }
    const resolved = resolveUpgradeContext(host, this.envSource)
    const cacheKey = upgradeCacheKey(resolved)
    const checkMode = this.resolvedModes.get(cacheKey) ?? null
    const { preview, mode: dryRunMode } = await this.runDryRun(host)
    if (!preview.supported) {
      const reason = preview.warnings[0] ?? preview.summary
      return Object.freeze({
        applied: false,
        entry: 'dsh-ray-upgrade',
        note: `升级前置检查未通过：${reason}；可执行命令：${preview.command}`,
      })
    }
    const effectiveMode = dryRunMode ?? checkMode
    const confirmDshHomeStopped = effectiveMode === 'standard-local'
      && !status.frozenSystemdProfile
      && !preview.frozenSystemdProfile
    const cliCommand = this.resolvedCliBin ?? this.cliBin
    if (!isSingleLineCommand(cliCommand)) {
      return Object.freeze({
        applied: false,
        entry: 'dsh-ray-upgrade',
        note: '升级命令路径无效',
      })
    }

    const safeEnv = this.buildSafeEnv(resolved.dshHome, cliCommand)
    const args = buildDshRayArgs('--yes', resolved, confirmDshHomeStopped)
    const startedAt = this.now()
    const log = resolveLogFile(resolved.dshHome, startedAt)

    let pid: number | undefined
    try {
      const workDir = resolved.dshHome ?? resolved.profileDir
      const child = this.spawnFn(cliCommand, args, {
        ...(workDir !== null ? { cwd: workDir } : {}),
        env: safeEnv,
        detached: true,
        stdio: log.fd !== undefined ? ['ignore', log.fd, log.fd] : 'ignore',
        shell: false,
      })
      if (log.fd !== undefined) {
        try { closeSync(log.fd) } catch { /* noop */ }
      }
      pid = child.pid
      let settledError: string | undefined
      let settledExitCode: number | null | undefined
      let resolveEarly: (() => void) | undefined
      const hasEmitter = typeof child.once === 'function'
      const earlyPromise = hasEmitter ? new Promise<void>(resolveFn => { resolveEarly = resolveFn }) : undefined

      if (hasEmitter) {
        child.once!('error', (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err)
          settledError = msg
          const existing = this.latestRuns.get(cacheKey)
          if (existing !== undefined) {
            this.latestRuns.set(cacheKey, { ...existing, finishedAt: this.now(), spawnError: msg })
            this.invalidate()
          }
          resolveEarly?.()
        })
        child.once!('exit', (code: unknown) => {
          const numeric = typeof code === 'number' ? code : 1
          settledExitCode = numeric
          const existing = this.latestRuns.get(cacheKey)
          if (existing !== undefined) {
            this.latestRuns.set(cacheKey, { ...existing, finishedAt: this.now(), exitCode: numeric })
            this.invalidate()
          }
          resolveEarly?.()
        })
      }

      if (pid !== undefined && pid > 0) {
        this.latestRuns.set(cacheKey, {
          pid,
          startedAt,
          ...(log.path !== undefined ? { logPath: log.path } : {}),
          targetVersion: preview.targetEnhancedVersion,
        })
      }
      child.unref()

      if (earlyPromise !== undefined) {
        await new Promise<void>((resolveWait) => {
          const timer = setTimeout(resolveWait, EARLY_SPAWN_SETTLE_MS)
          timer.unref?.()
          void earlyPromise.then(() => {
            clearTimeout(timer)
            resolveWait()
          })
        })
      }

      const logHint = log.path !== undefined ? `；日志：${log.path}` : ''
      if (settledError !== undefined) {
        const redactedErr = redactProbeDetail(settledError)
        this.latestRuns.set(cacheKey, {
          ...(pid !== undefined && pid > 0 ? { pid } : {}),
          startedAt,
          finishedAt: this.now(),
          ...(log.path !== undefined ? { logPath: log.path } : {}),
          targetVersion: preview.targetEnhancedVersion,
          spawnError: redactedErr,
        })
        this.invalidate()
        return Object.freeze({
          applied: false,
          entry: 'dsh-ray-upgrade',
          note: `启动独立升级进程失败：${redactedErr}${logHint}。可改用终端执行：${preview.command}`,
        })
      }

      if (pid === undefined || pid <= 0) {
        const logTail = readUpgradeLogTail(log.path)
        const outcome = parseUpgradeLogOutcome(logTail)
        const reason = outcome.error ?? '未能创建独立升级进程'
        this.latestRuns.set(cacheKey, {
          startedAt,
          finishedAt: this.now(),
          ...(log.path !== undefined ? { logPath: log.path } : {}),
          targetVersion: preview.targetEnhancedVersion,
          spawnError: reason,
        })
        this.invalidate()
        return Object.freeze({
          applied: false,
          entry: 'dsh-ray-upgrade',
          note: `未能启动独立升级进程（${reason}）${logHint}；请在终端执行：${preview.command}`,
        })
      }

      if (settledExitCode !== undefined && settledExitCode !== null) {
        const logTail = readUpgradeLogTail(log.path)
        const outcome = parseUpgradeLogOutcome(logTail)
        if (settledExitCode !== 0 || outcome.jsonOk === false) {
          const detail = outcome.error ?? `退出码 ${settledExitCode}`
          this.latestRuns.set(cacheKey, {
            pid,
            startedAt,
            finishedAt: this.now(),
            ...(log.path !== undefined ? { logPath: log.path } : {}),
            targetVersion: preview.targetEnhancedVersion,
            exitCode: settledExitCode,
          })
          this.invalidate()
          return Object.freeze({
            applied: false,
            entry: 'dsh-ray-upgrade',
            note: `后台升级启动后立即失败（${detail}）${logHint}；可改用终端执行：${preview.command}`,
          })
        }
      }

      this.invalidate()
      return Object.freeze({
        applied: true,
        entry: 'dsh-ray-upgrade',
        note: `已启动独立后台升级（PID ${pid}）${logHint}。升级完成后请按日志提示重启 Host 以加载新代码`,
      })
    } catch (error: unknown) {
      if (log.fd !== undefined) {
        try { closeSync(log.fd) } catch { /* noop */ }
      }
      const message = redactProbeDetail(error instanceof Error ? error.message : String(error))
      this.latestRuns.set(cacheKey, {
        startedAt,
        finishedAt: this.now(),
        ...(log.path !== undefined ? { logPath: log.path } : {}),
        targetVersion: preview.targetEnhancedVersion,
        spawnError: message,
      })
      this.invalidate()
      return Object.freeze({
        applied: false,
        entry: 'dsh-ray-upgrade',
        note: `启动独立升级进程失败：${message}`,
      })
    }
  }
}

export function installedHostPackagePathForTest(): string | null {
  try {
    const entry = process.argv[1]
    if (!entry) return null
    const st = statSync(entry)
    return st.isFile() ? entry : null
  } catch {
    return null
  }
}
