import { execFile as nodeExecFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { isSingleLineCommand } from './settings.js'

const execFileAsync = promisify(nodeExecFile)

export type CodingToolId = 'traex' | 'agy'

export type CodingToolProbeState =
  | 'ready'
  | 'missing-binary'
  | 'auth-required'
  | 'disabled'
  | 'not-installed'
  | 'invalid-command'
  | 'error'

export interface CodingToolProbeResult {
  readonly tool: CodingToolId
  readonly command: string
  readonly installed: boolean
  readonly binaryFound: boolean
  readonly loggedIn: boolean
  readonly enabled: boolean
  readonly routeRegistered: boolean
  readonly ready: boolean
  readonly state: CodingToolProbeState
  readonly summary: string
  readonly remediation?: string
  readonly discoveredPath?: string
  readonly needsPathPin?: boolean
  readonly loginCommand?: string
  readonly modelCount?: number
  readonly checkedAt: number
  readonly cached: boolean
}

export interface CodingToolProbeHostContext {
  readonly command: string
  readonly installed: boolean
  readonly enabled: boolean
  readonly routeRegistered: boolean
  readonly dshHome?: string | null
}

export type DiscoverCodingToolFn = (tool: CodingToolId, dshHome?: string | null) => string | undefined

export type ProbeExecResult = Readonly<{ stdout: string; stderr: string; exitCode: number; errorCode?: string }>

export type ProbeExecFn = (
  command: string,
  args: readonly string[],
  options: Readonly<{ timeoutMs: number; env: NodeJS.ProcessEnv }>,
) => Promise<ProbeExecResult>

const CACHE_TTL_MS = 15_000
const TRAEX_TIMEOUT_MS = 8_000
const AGY_VERSION_TIMEOUT_MS = 3_000
const AGY_MODELS_TIMEOUT_MS = 18_000
const MAX_PROBE_BUFFER_BYTES = 64 * 1024

const SAFE_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'TMP', 'TEMP',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'SystemRoot', 'ComSpec', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE',
])

export function sanitizedProbeEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (SAFE_ENV_KEYS.has(key) || key.startsWith('LC_') || key.startsWith('XDG_')) {
      env[key] = value
    }
  }
  return env
}

export function defaultExecProbe(
  command: string,
  args: readonly string[],
  options: Readonly<{ timeoutMs: number; env: NodeJS.ProcessEnv }>,
): Promise<ProbeExecResult> {
  return execFileAsync(command, [...args], {
    timeout: options.timeoutMs,
    maxBuffer: MAX_PROBE_BUFFER_BYTES,
    env: options.env,
    encoding: 'utf8',
    windowsHide: true,
  }).then(
    result => ({ stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: 0 }),
    (error: unknown) => {
      const failure = error as { stdout?: unknown; stderr?: unknown; code?: unknown; status?: unknown; killed?: unknown; message?: unknown }
      const errorCode = typeof failure.code === 'string' ? failure.code : (failure.killed ? 'ETIMEDOUT' : undefined)
      const exitCode = typeof failure.code === 'number'
        ? failure.code
        : typeof failure.status === 'number' ? failure.status : 1
      const stdout = typeof failure.stdout === 'string' ? failure.stdout : ''
      const stderr = typeof failure.stderr === 'string'
        ? failure.stderr
        : typeof failure.message === 'string' ? failure.message : String(error)
      return { stdout, stderr, exitCode, ...(errorCode === undefined ? {} : { errorCode }) }
    },
  )
}

interface CliProbeOutcome {
  readonly binaryFound: boolean
  readonly loggedIn: boolean
  readonly modelCount?: number
  readonly errorDetail?: string
  readonly discoveredPath?: string
  readonly checkedAt: number
}

export interface DiscoverBinaryOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly homeDir?: string
  readonly dshHome?: string | null
  readonly platform?: NodeJS.Platform
  readonly isExecutable?: (candidatePath: string) => boolean
}

function defaultIsExecutable(candidatePath: string, platform: NodeJS.Platform): boolean {
  try {
    const st = statSync(candidatePath)
    if (!st.isFile()) return false
    return platform === 'win32' || (st.mode & 0o111) !== 0
  } catch {
    return false
  }
}

/** Auto-discover `traex` / `agy` on standard PATH and user bin locations (for GUI apps lacking shell PATH). */
export function discoverCodingToolBinary(
  tool: CodingToolId,
  options: DiscoverBinaryOptions = {},
): string | undefined {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const home = options.homeDir ?? (env['HOME']?.trim() || homedir())
  const names = tool === 'traex'
    ? (platform === 'win32' ? ['traex.cmd', 'traex.exe', 'traex', 'trae-cli.cmd', 'trae-cli.exe', 'trae-cli'] : ['traex', 'trae-cli'])
    : (platform === 'win32' ? ['agy.cmd', 'agy.exe', 'agy'] : ['agy'])

  const dirs: string[] = []
  const pushDir = (dir: string | undefined) => {
    if (typeof dir !== 'string' || dir.trim() === '' || !isAbsolute(dir.trim())) return
    const normalized = resolve(dir.trim())
    if (!dirs.includes(normalized)) dirs.push(normalized)
  }

  for (const entry of (env['PATH'] ?? '').split(delimiter)) pushDir(entry)
  if (typeof options.dshHome === 'string' && options.dshHome.trim() !== '' && isAbsolute(options.dshHome.trim())) {
    pushDir(join(dirname(resolve(options.dshHome.trim())), '.local', 'bin'))
  }
  if (platform === 'win32') {
    if (env['APPDATA']) pushDir(join(env['APPDATA'], 'npm'))
    if (env['LOCALAPPDATA']) {
      pushDir(join(env['LOCALAPPDATA'], 'Programs', 'Antigravity', 'bin'))
      pushDir(join(env['LOCALAPPDATA'], 'Programs', 'Trae', 'bin'))
    }
  } else {
    pushDir(join(home, '.local', 'bin'))
    if (tool === 'agy') pushDir(join(home, '.antigravity', 'antigravity', 'bin'))
    pushDir(join(home, '.npm-global', 'bin'))
    pushDir('/opt/homebrew/bin')
    pushDir('/usr/local/bin')
    pushDir('/usr/bin')
  }

  const check = options.isExecutable ?? (candidate => defaultIsExecutable(candidate, platform))
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (check(candidate)) return candidate
    }
  }
  return undefined
}

const TOKEN_TEXT = /[\p{Cc}]/gu
function redactProbeDetail(raw: string): string {
  return raw
    .replace(TOKEN_TEXT, ' ')
    .replace(/\b((?:bearer|token|key|secret|password)\s*[:=]?\s*)[^\s]+/giu, '$1[redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[redacted-email]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 240)
}

function countAgyModels(stdout: string): number {
  let count = 0
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('Available') || trimmed.startsWith('Model') || trimmed.startsWith('---')) continue
    if (/^[A-Za-z0-9][A-Za-z0-9._:/@-]{1,127}(\s|$)/u.test(trimmed)) count += 1
  }
  return count
}

function isMissingBinary(result: ProbeExecResult): boolean {
  return result.errorCode === 'ENOENT' || result.errorCode === 'ENOTDIR' || result.errorCode === 'EACCES'
}

export class CodingToolProber {
  private readonly cache = new Map<string, CliProbeOutcome>()
  private readonly inflight = new Map<string, Promise<CliProbeOutcome>>()

  constructor(
    private readonly execFn: ProbeExecFn = defaultExecProbe,
    private readonly now: () => number = () => Date.now(),
    private readonly discoverFn: DiscoverCodingToolFn = (tool, dshHome) => discoverCodingToolBinary(tool, dshHome === undefined ? {} : { dshHome }),
  ) {}

  clear(): void {
    this.cache.clear()
    this.inflight.clear()
  }

  async probe(tool: CodingToolId, host: CodingToolProbeHostContext, force = false): Promise<CodingToolProbeResult> {
    const configured = host.command.trim()
    const command = configured === '' ? tool : configured
    if (!isSingleLineCommand(command)) {
      return Object.freeze({
        tool,
        command,
        installed: host.installed,
        binaryFound: false,
        loggedIn: false,
        enabled: host.enabled,
        routeRegistered: host.routeRegistered,
        ready: false,
        state: 'invalid-command',
        summary: '命令路径包含非法空白或控制字符；请填写单一可执行文件名或绝对路径',
        remediation: `请填写有效路径（例如 ${tool}）后重试`,
        checkedAt: this.now(),
        cached: false,
      })
    }

    const allowDiscover = configured === '' || configured === tool
    const cacheKey = `${tool}\0${command}\0${allowDiscover ? (host.dshHome ?? '') : '-'}`
    const now = this.now()
    const hit = !force ? this.cache.get(cacheKey) : undefined
    let outcome: CliProbeOutcome
    let cached = false
    if (hit !== undefined && now - hit.checkedAt < CACHE_TTL_MS) {
      outcome = hit
      cached = true
    } else {
      let pending = !force ? this.inflight.get(cacheKey) : undefined
      if (pending === undefined) {
        pending = this.runCliProbe(tool, command, allowDiscover, host.dshHome).finally(() => {
          if (this.inflight.get(cacheKey) === pending) this.inflight.delete(cacheKey)
        })
        this.inflight.set(cacheKey, pending)
      }
      outcome = await pending
      this.cache.set(cacheKey, outcome)
    }

    return this.combineWithHostState(tool, configured, command, host, outcome, cached)
  }

  private async runCliProbe(
    tool: CodingToolId,
    command: string,
    allowDiscover: boolean,
    dshHome?: string | null,
    discoveredPath?: string,
  ): Promise<CliProbeOutcome> {
    const env = sanitizedProbeEnv()
    const tryDiscoverFallback = async (): Promise<CliProbeOutcome | undefined> => {
      if (!allowDiscover || discoveredPath !== undefined) return undefined
      const fallback = this.discoverFn(tool, dshHome)
      if (fallback === undefined || fallback === command) return undefined
      return this.runCliProbe(tool, fallback, false, dshHome, fallback)
    }

    if (tool === 'traex') {
      const result = await this.execFn(command, ['login', 'status'], { timeoutMs: TRAEX_TIMEOUT_MS, env })
      if (isMissingBinary(result)) {
        const recovered = await tryDiscoverFallback()
        if (recovered !== undefined) return recovered
        return {
          binaryFound: false,
          loggedIn: false,
          checkedAt: this.now(),
          errorDetail: result.errorCode === 'EACCES' ? '没有可执行权限' : '命令不存在',
        }
      }
      const combined = `${result.stdout}\n${result.stderr}`
      if (/Logged in using Trae/u.test(combined)) {
        return {
          binaryFound: true,
          loggedIn: true,
          checkedAt: this.now(),
          ...(discoveredPath === undefined ? {} : { discoveredPath }),
        }
      }
      const detail = redactProbeDetail(combined)
      return {
        binaryFound: true,
        loggedIn: false,
        checkedAt: this.now(),
        ...(discoveredPath === undefined ? {} : { discoveredPath }),
        ...(detail === '' ? {} : { errorDetail: detail }),
      }
    }

    // Antigravity (`agy`): fast missing-binary check before invoking `agy models` (prompt-free).
    const version = await this.execFn(command, ['--version'], { timeoutMs: AGY_VERSION_TIMEOUT_MS, env })
    if (isMissingBinary(version)) {
      const recovered = await tryDiscoverFallback()
      if (recovered !== undefined) return recovered
      return {
        binaryFound: false,
        loggedIn: false,
        checkedAt: this.now(),
        errorDetail: version.errorCode === 'EACCES' ? '没有可执行权限' : '命令不存在',
      }
    }
    const models = await this.execFn(command, ['models'], { timeoutMs: AGY_MODELS_TIMEOUT_MS, env })
    if (isMissingBinary(models)) {
      const recovered = await tryDiscoverFallback()
      if (recovered !== undefined) return recovered
      return { binaryFound: false, loggedIn: false, checkedAt: this.now() }
    }
    if (models.exitCode === 0) {
      const modelCount = countAgyModels(models.stdout)
      return {
        binaryFound: true,
        loggedIn: true,
        checkedAt: this.now(),
        ...(discoveredPath === undefined ? {} : { discoveredPath }),
        ...(modelCount > 0 ? { modelCount } : {}),
      }
    }
    const detail = redactProbeDetail(`${models.stderr}\n${models.stdout}`)
    const authHint = /sign in|authentication required|login|oauth/iu.test(detail)
    return {
      binaryFound: true,
      loggedIn: false,
      checkedAt: this.now(),
      ...(discoveredPath === undefined ? {} : { discoveredPath }),
      ...(detail === '' ? {} : { errorDetail: authHint ? '尚未完成登录认证' : detail }),
    }
  }

  private combineWithHostState(
    tool: CodingToolId,
    configured: string,
    command: string,
    host: CodingToolProbeHostContext,
    cli: CliProbeOutcome,
    cached: boolean,
  ): CodingToolProbeResult {
    const label = tool === 'traex' ? 'TraeX' : 'Antigravity (agy)'
    const effectiveCommand = cli.discoveredPath ?? command
    const discoveredPath = cli.discoveredPath
      ?? (cli.binaryFound && (configured === '' || !isAbsolute(configured)) ? this.discoverFn(tool, host.dshHome) : undefined)
    const needsPathPin = discoveredPath !== undefined && configured !== discoveredPath
    const pinFields = {
      ...(discoveredPath === undefined ? {} : { discoveredPath }),
      ...(needsPathPin ? { needsPathPin: true } : {}),
    }

    if (!cli.binaryFound) {
      return Object.freeze({
        tool, command: effectiveCommand, installed: host.installed, binaryFound: false, loggedIn: false,
        enabled: host.enabled, routeRegistered: host.routeRegistered, ready: false,
        state: 'missing-binary',
        summary: `未找到本机 ${label} 可执行文件（${effectiveCommand}）${cli.errorDetail ? `：${cli.errorDetail}` : ''}`,
        remediation: `请先安装 ${label} CLI 或在路径框填写绝对路径后重新探测`,
        ...pinFields,
        checkedAt: cli.checkedAt, cached,
      })
    }
    if (!cli.loggedIn) {
      const timedOut = cli.errorDetail !== undefined && /ETIMEDOUT|timed out/iu.test(cli.errorDetail)
      const loginCommand = tool === 'traex' ? `${effectiveCommand} login` : `${effectiveCommand} acp --login`
      return Object.freeze({
        tool, command: effectiveCommand, installed: host.installed, binaryFound: true, loggedIn: false,
        enabled: host.enabled, routeRegistered: host.routeRegistered, ready: false,
        state: timedOut ? 'error' : 'auth-required',
        summary: timedOut
          ? `${label} 探测超时：${cli.errorDetail}`
          : `${label} CLI 已安装但未登录${cli.errorDetail ? `（${cli.errorDetail}）` : ''}`,
        remediation: tool === 'traex'
          ? `请在本机终端运行 \`${effectiveCommand} login\` 完成登录后重新探测`
          : `请在本机终端运行 \`${effectiveCommand}\` 或 \`${effectiveCommand} acp --login\` 完成登录后重新探测`,
        ...pinFields,
        ...(timedOut ? {} : { loginCommand }),
        checkedAt: cli.checkedAt, cached,
      })
    }
    if (!host.installed) {
      return Object.freeze({
        tool, command: effectiveCommand, installed: false, binaryFound: true, loggedIn: true,
        enabled: host.enabled, routeRegistered: host.routeRegistered, ready: false,
        state: 'not-installed',
        summary: `${label} CLI 已登录可用${cli.modelCount ? `（发现 ${cli.modelCount} 个模型）` : ''}，但 Host 尚未安装接入插件`,
        remediation: '请先安装并启用 @dsh-enhanced/traex-acp-provider',
        ...pinFields,
        ...(cli.modelCount === undefined ? {} : { modelCount: cli.modelCount }),
        checkedAt: cli.checkedAt, cached,
      })
    }
    if (!host.enabled) {
      return Object.freeze({
        tool, command: effectiveCommand, installed: true, binaryFound: true, loggedIn: true,
        enabled: false, routeRegistered: host.routeRegistered, ready: false,
        state: 'disabled',
        summary: `${label} CLI 已登录可用${cli.modelCount ? `（${cli.modelCount} 个模型）` : ''}，当前路由处于停用状态${needsPathPin ? `（检测到可执行路径 ${discoveredPath}，启用时将自动固定路径）` : ''}`,
        remediation: '点击“启用”即可开启该编程工具路由',
        ...pinFields,
        ...(cli.modelCount === undefined ? {} : { modelCount: cli.modelCount }),
        checkedAt: cli.checkedAt, cached,
      })
    }
    return Object.freeze({
      tool, command: effectiveCommand, installed: true, binaryFound: true, loggedIn: true,
      enabled: true, routeRegistered: host.routeRegistered,
      ready: host.routeRegistered,
      state: host.routeRegistered ? 'ready' : 'error',
      summary: host.routeRegistered
        ? `${label} 已就绪且路由已注册${cli.modelCount ? `（${cli.modelCount} 个模型）` : ''}${needsPathPin ? `（建议固定绝对路径 ${discoveredPath}，避免桌面端启动找不到命令）` : ''}`
        : `${label} 配置已启用，但模型路由尚未注册到 Host（请重载条目或重启 profile）`,
      ...(!host.routeRegistered
        ? { remediation: '请点击“保存/启用”重载插件条目或重启 profile' }
        : needsPathPin ? { remediation: `点击“一键修复 / 保存并固定路径”写入 ${discoveredPath}` } : {}),
      ...pinFields,
      ...(cli.modelCount === undefined ? {} : { modelCount: cli.modelCount }),
      checkedAt: cli.checkedAt, cached,
    })
  }
}
