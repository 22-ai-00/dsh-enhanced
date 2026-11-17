import { createRequire } from 'node:module'
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { defaultExecProbe, sanitizedProbeEnv, type ProbeExecFn } from './probes.js'
import { boundedConfig, hasControlChars, isSingleLineCommand, type SettingsService } from './settings.js'
import type { SelfUpgradePreview, SelfUpgradeStatus, OwnerConsoleWriteResult } from './typert.js'
import { version as PACKAGE_VERSION } from './version.js'

const CACHE_TTL_MS = 60_000
const CLI_CHECK_TIMEOUT_MS = 8_000
const CLI_DRY_RUN_TIMEOUT_MS = 10_000
const REGISTRY_TIMEOUT_MS = 6_000
const MAX_HOST_METADATA_BYTES = 16_384
const MAX_REGISTRY_BYTES = 32_768
const ENHANCED_NPM_LATEST_URL = 'https://registry.npmjs.org/@dsh-enhanced%2Fowner-console/latest'
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
) => Pick<ChildProcess, 'pid' | 'unref'>

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
}

interface ResolvedUpgradeContext {
  readonly dshHome: string | null
  readonly profileName: string
  readonly profileDir: string | null
}

interface ParsedCliPayload {
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
): Pick<ChildProcess, 'pid' | 'unref'> {
  return spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    detached: options.detached,
    stdio: options.stdio === 'ignore' ? 'ignore' : [...options.stdio],
    shell: options.shell,
    windowsHide: true,
  })
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

/** Read `$DSH_HOME/.dsh-rsi-host.json` strictly without following symlinks or group/world-writable files. */
export function readBoundHostMetadata(dshHome: string | null): BoundHostMetadata {
  if (dshHome === null || dshHome.trim() === '') return { status: 'missing', version: null }
  let canonicalHome: string
  try {
    canonicalHome = realpathSync(resolve(dshHome))
  } catch {
    return { status: 'missing', version: null }
  }
  const filePath = join(canonicalHome, '.dsh-rsi-host.json')
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
    if (obj['schemaVersion'] !== 1) return { status: 'corrupt', version: null, error: 'unsupported .dsh-rsi-host.json schemaVersion' }
    const version = textOrNull(obj['version'])
    const cacheRoot = textOrNull(obj['cacheRoot'])
    const receiptDigest = textOrNull(obj['receiptDigest'])
    if (version === null || cacheRoot === null || receiptDigest === null) {
      return { status: 'corrupt', version: null, error: 'missing required fields in .dsh-rsi-host.json' }
    }
    return { status: 'ready', version, cacheRoot, receiptDigest }
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing', version: null }
    }
    if (error instanceof SyntaxError) {
      return { status: 'corrupt', version: null, error: 'corrupt .dsh-rsi-host.json JSON' }
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
    return `先停止受控 systemd 服务后执行：dsh-rsi upgrade --yes${homeFlag} --profile ${profileName}（或 ${base}）`
  }
  const args = ['dsh-rsi', 'upgrade', '--yes']
  if (dshHome !== null) args.push('--dsh-home', JSON.stringify(dshHome))
  if (profileName !== '' && profileName !== 'default') args.push('--profile', profileName)
  return args.join(' ')
}

function parseDshRsiUpgradeJson(stdout: string, fallbackCurrent: string): ParsedCliPayload | null {
  const trimmed = stdout.trim()
  if (trimmed === '') return null
  const jsonStart = trimmed.indexOf('{')
  if (jsonStart < 0) return null
  let parsed: Record<string, unknown>
  try {
    const raw = JSON.parse(trimmed.slice(jsonStart)) as unknown
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    parsed = raw as Record<string, unknown>
  } catch {
    return null
  }
  if (parsed['command'] !== 'upgrade' && parsed['schemaVersion'] !== 1) return null

  const packages = boundedConfig(parsed['packages'])
  const boundHost = boundedConfig(packages['boundHost'])
  const registry = boundedConfig(parsed['registry'])
  const readiness = boundedConfig(parsed['readiness'])
  const plan = boundedConfig(parsed['plan'])
  const frozenSystemd = boundedConfig(parsed['frozenSystemd'])

  const frozenDetected = parsed['mode'] === 'frozen-linux-systemd' || frozenSystemd['detected'] === true
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
  const canExecute = plan['canExecute'] !== false && readiness['ok'] !== false

  return {
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

function buildDshRsiArgs(
  subcommandFlag: '--check' | '--dry-run' | '--yes',
  ctx: ResolvedUpgradeContext,
): string[] {
  const args = ['upgrade', subcommandFlag, '--json']
  if (ctx.dshHome !== null) args.push('--dsh-home', ctx.dshHome)
  if (ctx.profileName !== '') args.push('--profile', ctx.profileName)
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
  private readonly cache = new Map<string, Readonly<{ expiresAt: number; status: SelfUpgradeStatus }>>()
  private readonly inflight = new Map<string, Promise<SelfUpgradeStatus>>()

  constructor(options: SelfUpgradeProberOptions = {}) {
    this.execFn = options.execFn ?? defaultExecProbe
    this.spawnFn = options.spawnFn ?? defaultSpawnDetached
    this.fetchFn = options.fetchFn ?? fetch
    this.now = options.now ?? (() => Date.now())
    this.ttlMs = options.ttlMs ?? CACHE_TTL_MS
    this.currentVersion = options.currentVersion ?? PACKAGE_VERSION
    this.platform = options.platform ?? process.platform
    this.envSource = options.env ?? process.env
    this.cliBin = options.cliBin ?? 'dsh-rsi'
  }

  invalidate(): void {
    this.cache.clear()
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
    const cacheKey = `${resolved.dshHome ?? ''}::${resolved.profileName}`
    if (!force) {
      const hit = this.cache.get(cacheKey)
      if (hit !== undefined && this.now() < hit.expiresAt) {
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
    const hostMeta = readBoundHostMetadata(ctx.dshHome)
    const installedHostVersion = readInstalledHostVersion()
    const baseFrozen = detectFrozenSystemdProfile(ctx.dshHome, ctx.profileName, this.platform, this.envSource)
    const safeEnv = sanitizedProbeEnv(this.envSource)
    if (ctx.dshHome !== null) safeEnv['DSH_HOME'] = ctx.dshHome

    const cliResult = isSingleLineCommand(this.cliBin)
      ? await this.execFn(this.cliBin, buildDshRsiArgs('--check', ctx), { timeoutMs: CLI_CHECK_TIMEOUT_MS, env: safeEnv })
      : { stdout: '', stderr: 'invalid dsh-rsi binary', exitCode: 1, errorCode: 'EINVAL' }
    const cliPayload = cliResult.errorCode === undefined ? parseDshRsiUpgradeJson(cliResult.stdout, this.currentVersion) : null

    if (cliPayload !== null) {
      const frozen = baseFrozen || cliPayload.frozenSystemdProfile
      const boundHostVersion = cliPayload.boundHostVersion ?? hostMeta.version
      const upgradeCommand = buildCliUpgradeCommand(ctx.dshHome, ctx.profileName, frozen)
      const note = frozen
        ? '检测到受控 Linux systemd profile；请停止服务后按终端引导执行升级。'
        : cliPayload.blockedReasons.length > 0
          ? `存在升级前置阻塞：${cliPayload.blockedReasons[0]}`
          : cliPayload.offline
            ? '离线回退：已完成本地绑定与账本检查，未能连接 npm 查询最新版本。'
            : cliPayload.enhancedUpdateAvailable || cliPayload.hostUpdateAvailable
              ? `发现可升级版本（@dsh-enhanced ${cliPayload.latestEnhancedVersion ?? this.currentVersion}）`
              : '当前已是最新已检查版本'
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
        checkSource: 'dsh-rsi',
        note,
      })
    }

    const npmResult = await this.fetchLatestFromNpm()
    const latestEnhancedVersion = npmResult.latest
    const enhancedUpdateAvailable = latestEnhancedVersion !== null
      && compareSemver(latestEnhancedVersion, this.currentVersion) > 0
    const upgradeCommand = buildCliUpgradeCommand(ctx.dshHome, ctx.profileName, baseFrozen)
    const cliUnavailableNote = cliResult.errorCode === 'ENOENT'
      ? '未在 PATH 中检测到 dsh-rsi CLI；'
      : ''
    const note = baseFrozen
      ? `${cliUnavailableNote}受控 Linux systemd profile 仅支持终端带外升级。`
      : npmResult.offline
        ? `${cliUnavailableNote}离线回退（${npmResult.error ?? '网络不可达'}），已展示本地当前版本与绑定宿主版本。`
        : enhancedUpdateAvailable
          ? `${cliUnavailableNote}检测到 npm 新版本 ${latestEnhancedVersion}（当前 ${this.currentVersion}）。`
          : `${cliUnavailableNote}当前版本 ${this.currentVersion} 已为 npm 最新版本。`

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
    })
  }

  async dryRun(host: UpgradeHostContext): Promise<SelfUpgradePreview> {
    const resolved = resolveUpgradeContext(host, this.envSource)
    const status = await this.check(host, false)
    const safeEnv = sanitizedProbeEnv(this.envSource)
    if (resolved.dshHome !== null) safeEnv['DSH_HOME'] = resolved.dshHome

    const cliResult = isSingleLineCommand(this.cliBin)
      ? await this.execFn(this.cliBin, buildDshRsiArgs('--dry-run', resolved), { timeoutMs: CLI_DRY_RUN_TIMEOUT_MS, env: safeEnv })
      : { stdout: '', stderr: 'invalid dsh-rsi binary', exitCode: 1, errorCode: 'EINVAL' }
    const cliPayload = cliResult.errorCode === undefined ? parseDshRsiUpgradeJson(cliResult.stdout, this.currentVersion) : null

    if (cliPayload !== null) {
      const frozen = status.frozenSystemdProfile || cliPayload.frozenSystemdProfile
      const supported = !frozen && cliPayload.canExecute && cliResult.exitCode === 0
      const warnings = [
        ...cliPayload.blockedReasons,
        ...(frozen ? ['受控 Linux systemd profile 禁止在 Host 内直接启动升级，请在停止服务后使用终端 CLI 升级。'] : []),
      ].slice(0, 32)
      const summary = cliPayload.steps.length > 0
        ? cliPayload.steps.join(' -> ')
        : frozen
          ? '预览完成：受控 Linux systemd profile 需在终端停止服务后执行带外升级'
          : supported
            ? '升级预演通过：将先备份现有配置与绑定并在后台执行 dsh-rsi upgrade --yes'
            : '升级预演发现阻塞项，请先修复后再升级'
      return Object.freeze({
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
      })
    }

    const warnings: string[] = []
    if (cliResult.errorCode === 'ENOENT') {
      warnings.push('未检测到可执行 dsh-rsi CLI（请确认 @dsh-enhanced/dsh-rsi-cli 已安装并在 PATH 中）。')
    } else if (cliResult.exitCode !== 0) {
      warnings.push(`dsh-rsi upgrade --dry-run 返回退出码 ${cliResult.exitCode}。`)
    }
    if (status.frozenSystemdProfile) {
      warnings.push('受控 Linux systemd profile 仅支持终端带外升级。')
    }
    return Object.freeze({
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
      summary: status.frozenSystemdProfile
        ? '当前为受控 Linux systemd profile，请先停止服务并在终端执行 CLI 升级。'
        : '未能完成本地 dsh-rsi CLI 预演；请先在终端检查并运行 dsh-rsi upgrade。',
    })
  }

  async trigger(host: UpgradeHostContext, confirmed: boolean): Promise<OwnerConsoleWriteResult> {
    if (confirmed !== true) {
      return Object.freeze({
        applied: false,
        entry: 'dsh-rsi-upgrade',
        note: '请先执行升级预演并明确确认后再触发自助升级',
      })
    }
    const status = await this.check(host, true)
    if (status.frozenSystemdProfile) {
      return Object.freeze({
        applied: false,
        entry: 'dsh-rsi-upgrade',
        note: `当前为受控 Linux systemd profile，禁止在 Host 内直接升级；${status.upgradeCommand}`,
      })
    }
    const preview = await this.dryRun(host)
    if (!preview.supported) {
      const reason = preview.warnings[0] ?? preview.summary
      return Object.freeze({
        applied: false,
        entry: 'dsh-rsi-upgrade',
        note: `升级前置检查未通过：${reason}；可执行命令：${preview.command}`,
      })
    }
    if (!isSingleLineCommand(this.cliBin)) {
      return Object.freeze({
        applied: false,
        entry: 'dsh-rsi-upgrade',
        note: '升级命令路径无效',
      })
    }

    const resolved = resolveUpgradeContext(host, this.envSource)
    const safeEnv = sanitizedProbeEnv(this.envSource)
    if (resolved.dshHome !== null) safeEnv['DSH_HOME'] = resolved.dshHome
    const args = buildDshRsiArgs('--yes', resolved)
    const log = resolveLogFile(resolved.dshHome, this.now())

    let pid: number | undefined
    try {
      const workDir = resolved.dshHome ?? resolved.profileDir
      const child = this.spawnFn(this.cliBin, args, {
        ...(workDir !== null ? { cwd: workDir } : {}),
        env: safeEnv,
        detached: true,
        stdio: log.fd !== undefined ? ['ignore', log.fd, log.fd] : 'ignore',
        shell: false,
      })
      pid = child.pid
      child.unref()
      if (pid === undefined || pid <= 0) {
        return Object.freeze({
          applied: false,
          entry: 'dsh-rsi-upgrade',
          note: `未能启动独立升级进程；请在终端执行：${preview.command}`,
        })
      }
      this.invalidate()
      const logHint = log.path !== undefined ? `；日志：${log.path}` : ''
      return Object.freeze({
        applied: true,
        entry: 'dsh-rsi-upgrade',
        note: `已启动独立后台升级（PID ${pid}）${logHint}。升级完成后请按日志提示重启 Host 以加载新代码`,
      })
    } catch (error: unknown) {
      return Object.freeze({
        applied: false,
        entry: 'dsh-rsi-upgrade',
        note: `启动独立升级进程失败：${error instanceof Error ? error.message : String(error)}`,
      })
    } finally {
      if (log.fd !== undefined) {
        try { closeSync(log.fd) } catch { /* noop */ }
      }
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
