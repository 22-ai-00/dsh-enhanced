import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { access, lstat, readFile, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { userInfo } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import {
  collectStatus,
  extractCredentialKeyNames,
  formatFindings,
  formatStatus,
  runDoctor,
  type DoctorFinding,
  type StatusSnapshot,
} from './diagnose.ts'
import { inspectBoundHostRuntime, type BoundHostInspection } from './install-host.ts'
import { listProfilePlugins, profileLogPaths, profilesDirectory } from './paths.ts'
import { isNodeExecutablePath, resolveNodeRuntime } from './pm-env.ts'
import { defaultDetailedRunner, type DetailedCommandRunner } from './run.ts'
import { scanCredentialLocators } from './secrets.ts'
import { tailLogFile } from './services.ts'
import { extractWebUrlFromText } from './weburl.ts'

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip'

export interface DoctorCheck {
  id: string
  category: 'host' | 'auth' | 'profile' | 'credentials' | 'port' | 'autonomy' | 'platform' | 'logs'
  status: CheckStatus
  summary: string
  detail?: string
  advice?: string
}

export interface DumpConfigRow {
  id?: string
  name?: string
  disabled?: boolean
  config: Record<string, string | boolean | number | undefined>
}

export interface ProfileDoctorDiagnosis {
  profile: string
  pluginsCount: number
  serviceInstalled: boolean
  serviceActive: boolean
  configDumpOk: boolean
  configDumpError?: string
  defaultModelRoute?: { provider?: string; model?: string }
  providers: {
    traexConfigured: boolean
    traexEnabled: boolean
    traexCommand?: string
    agyConfigured: boolean
    agyEnabled: boolean
    agyCommand?: string
  }
  capabilities: {
    ownerConsoleInstalled: boolean
    ownerConsoleEnabled?: boolean
    proactiveInstalled: boolean
    proactiveEnabled?: boolean
    dreamingInstalled: boolean
    dreamingEnabled?: boolean
    dreamingMissingPrerequisites: string[]
    growthInstalled: boolean
    growthEnabled?: boolean
    memoryLearningInstalled: boolean
    memoryLearningEnabled?: boolean
  }
  autonomyReadiness?: {
    checked: boolean
    ok: boolean
    summary: string
  }
  webUrl: {
    configuredPort?: number
    redactedLogUrl?: string
    portListening?: boolean
  }
}

export interface LiveDoctorReport {
  schemaVersion: 1
  checkedAt: string
  ok: boolean
  platform: NodeJS.Platform
  dshHome: string
  summary: { ok: number; warn: number; fail: number; skip: number }
  status: StatusSnapshot
  boundHost: BoundHostInspection
  credentials: {
    filePath: string
    fileExists: boolean
    mode?: number
    insecurePermissions: boolean
    keyNames: string[]
    envVariablesPresent: string[]
    externalLocatorsCount: number
  }
  agentTools: {
    traex: { found: boolean; command?: string; loginReady?: boolean; detail: string }
    agy: { found: boolean; command?: string; loginReady?: boolean; detail: string }
  }
  prerequisites: DoctorCheck[]
  profiles: ProfileDoctorDiagnosis[]
  logFindings: DoctorFinding[]
  checks: DoctorCheck[]
}

export interface LiveDoctorOptions {
  dshHome: string
  home: string
  platform: NodeJS.Platform
  profile?: string
  env?: NodeJS.ProcessEnv
  runner?: DetailedCommandRunner
  readHostRuntime?: Parameters<typeof inspectBoundHostRuntime>[1] extends infer P
    ? P extends { read?: infer R } ? R : never
    : never
  probePort?: (port: number, host?: string) => Promise<boolean>
  findExecutable?: (names: readonly string[], env: NodeJS.ProcessEnv, explicit?: string) => string | undefined
  fileExists?: (path: string) => boolean
  linuxPaths?: {
    cgroupRoot?: string
    lingerFile?: string
    uid?: number
    procSelfCgroup?: string
  }
}

const KNOWN_CREDENTIAL_ENV_VARS = [
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'SILICONFLOW_API_KEY',
  'OPENROUTER_API_KEY',
  'DSH_RAY_MODEL_API_KEY',
  'DSH_WEB_TOKEN',
] as const

const DREAMING_REQUIRED_FIELDS = [
  'scope',
  'databasePath',
  'provider',
  'model',
  'budgetId',
  'budgetAmount',
] as const

/** Redact `?token=...` / `&token=...` from any Web URL before displaying or serializing diagnostics. */
export function redactUrlToken(url: string): string {
  return url.replace(/([?#&]token=)[^&\s]+/giu, '$1<redacted>')
}

function unquoteYamlScalar(raw: string): string | boolean | number | undefined {
  let trimmed = raw.trim()
  if (!trimmed || trimmed.startsWith('#')) return undefined
  if (trimmed.startsWith('!js ')) {
    trimmed = trimmed.slice(4).trim()
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)
    || (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1)
  }
  // Strip inline comment after unquoted scalar
  const comment = /\s+#.*$/u.exec(trimmed)
  if (comment) trimmed = trimmed.slice(0, comment.index).trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null' || trimmed === '~') return undefined
  if (/^-?\d+(?:\.\d+)?$/u.test(trimmed)) return Number(trimmed)
  return trimmed
}

/**
 * Parse a `dsh --dump-config` YAML sequence into flat patch rows (`id`, `name`, `disabled`, scalar `config` fields).
 */
export function parseDumpConfigRows(source: string): DumpConfigRow[] {
  const rows: DumpConfigRow[] = []
  interface StackEntry { indent: number; row: DumpConfigRow; inConfig: boolean; configIndent?: number | undefined }
  const stack: StackEntry[] = []

  for (const rawLine of source.split(/\r?\n/u)) {
    const withoutCr = rawLine.replace(/\r$/u, '')
    const trimmed = withoutCr.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed === '---' || trimmed === '...') continue
    const indent = withoutCr.length - withoutCr.trimStart().length

    while (stack.length > 0 && indent < stack[stack.length - 1]!.indent) {
      stack.pop()
    }

    if (/^-\s+/u.test(trimmed)) {
      const rest = trimmed.replace(/^-\s+/u, '')
      const row: DumpConfigRow = { config: {} }
      rows.push(row)
      stack.push({ indent: indent + 2, row, inConfig: false })
      const firstKv = /^([A-Za-z0-9_.-]+)\s*:(.*)$/u.exec(rest)
      if (firstKv) assignRowField(row, firstKv[1]!, firstKv[2] ?? '', stack[stack.length - 1]!)
      continue
    }

    const active = stack[stack.length - 1]
    if (!active) continue
    const kv = /^([A-Za-z0-9_.-]+)\s*:(.*)$/u.exec(trimmed)
    if (!kv) continue
    const key = kv[1]!
    const rest = (kv[2] ?? '').trim()

    if (active.inConfig) {
      if (active.configIndent === undefined) active.configIndent = indent
      if (indent === active.configIndent) {
        active.row.config[key] = rest.length > 0 ? unquoteYamlScalar(rest) : '[nested]'
      }
      continue
    }

    active.inConfig = false
    active.configIndent = undefined
    assignRowField(active.row, key, rest, active)
  }

  return rows
}

function assignRowField(
  row: DumpConfigRow,
  key: string,
  rawValue: string,
  frame: { inConfig: boolean; configIndent?: number | undefined },
): void {
  const value = unquoteYamlScalar(rawValue)
  if (key === 'id' && typeof value === 'string') {
    row.id = value
  } else if (key === 'name' && typeof value === 'string') {
    row.name = value
  } else if (key === 'disabled' && typeof value === 'boolean') {
    row.disabled = value
  } else if (key === 'config' && rawValue.trim() === '') {
    frame.inConfig = true
    frame.configIndent = undefined
  }
}

function parseSettingsDefaultModel(source: string): { provider?: string; model?: string } | undefined {
  let inSection = false
  let sectionIndent = 0
  let provider: string | undefined
  let model: string | undefined
  for (const rawLine of source.split(/\r?\n/u)) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = rawLine.length - rawLine.trimStart().length
    if (!inSection) {
      if (indent === 0 && /^agent-default-model\s*:/u.test(trimmed)) {
        inSection = true
        sectionIndent = indent
      }
      continue
    }
    if (indent <= sectionIndent) break
    const kv = /^([A-Za-z0-9_.-]+)\s*:(.*)$/u.exec(trimmed)
    if (!kv) continue
    const value = unquoteYamlScalar(kv[2] ?? '')
    if (kv[1] === 'provider' && typeof value === 'string') provider = value
    if (kv[1] === 'model' && typeof value === 'string') model = value
  }
  return provider || model
    ? {
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      }
    : undefined
}

function defaultFindExecutable(
  names: readonly string[],
  env: NodeJS.ProcessEnv,
  explicit?: string,
): string | undefined {
  const checkFile = (candidate: string): string | undefined => {
    try {
      accessSync(candidate, constants.X_OK)
      return statSync(candidate).isFile() ? candidate : undefined
    } catch {
      return undefined
    }
  }
  const searchNames = [...names]
  if (explicit && explicit.trim().length > 0) {
    const trimmed = explicit.trim()
    if (trimmed.includes('/') || isAbsolute(trimmed)) {
      const hit = checkFile(trimmed)
      if (hit) return hit
    } else if (!searchNames.includes(trimmed)) {
      searchNames.unshift(trimmed)
    }
  }
  const pathDirs = (env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const name of searchNames) {
    for (const dir of pathDirs) {
      const hit = checkFile(join(dir, name))
      if (hit) return hit
    }
  }
  return undefined
}

async function defaultProbePort(port: number, host = '127.0.0.1'): Promise<boolean> {
  return await new Promise<boolean>(resolvePromise => {
    const socket = createConnection({ port, host })
    const finish = (open: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolvePromise(open)
    }
    socket.setTimeout(400)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

function findSlugRow(rows: readonly DumpConfigRow[], slug: string): DumpConfigRow | undefined {
  const id = `dsh-ray-${slug}`
  const pkg = `@dsh-ray/${slug}`
  return rows.find(row => row.id === id || row.name === pkg)
}

function isRowEnabled(row: DumpConfigRow | undefined): boolean | undefined {
  if (!row) return undefined
  if (row.disabled === true) return false
  if (typeof row.config.enabled === 'boolean') return row.config.enabled
  return true
}

function extractPort(url: string | undefined, rows: readonly DumpConfigRow[]): number | undefined {
  if (url) {
    try {
      const parsed = new URL(url)
      if (parsed.port) {
        const value = Number(parsed.port)
        if (Number.isInteger(value) && value > 0) return value
      }
    } catch {
      // ignore invalid log URL
    }
  }
  for (const row of rows) {
    if (row.disabled === true) continue
    const idOrName = `${row.id ?? ''} ${row.name ?? ''}`.toLowerCase()
    if (!idOrName.includes('web') && !idOrName.includes('server')) continue
    const port = row.config.port
    if (typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65_535) {
      return port
    }
  }
  return undefined
}

async function resolveAutonomyDoctorPath(
  dshHome: string,
  profile: string,
  env: NodeJS.ProcessEnv,
  osHome: string,
  platform: NodeJS.Platform,
): Promise<{ command: string; prefixArgs: string[]; envOverrides: NodeJS.ProcessEnv } | undefined> {
  const profileDir = join(profilesDirectory(dshHome), profile)
  const binScript = join(profileDir, 'node_modules', '@dsh-ray', 'assistant-web-owner', 'bin', 'dsh-autonomy-doctor.js')
  try {
    await access(binScript, constants.R_OK)
    if (isNodeExecutablePath(process.execPath)) {
      return { command: process.execPath, prefixArgs: [binScript], envOverrides: {} }
    }
    const nodeRt = await resolveNodeRuntime(env, osHome, platform)
    return { command: nodeRt.command, prefixArgs: [binScript], envOverrides: nodeRt.envOverrides }
  } catch {
    const symlinkBin = join(profileDir, 'node_modules', '.bin', 'dsh-autonomy-doctor')
    try {
      await access(symlinkBin, constants.X_OK)
      return { command: symlinkBin, prefixArgs: [], envOverrides: {} }
    } catch {
      return undefined
    }
  }
}

function probePlatformPrerequisites(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  runner: DetailedCommandRunner,
  findExec: (names: readonly string[], env: NodeJS.ProcessEnv, explicit?: string) => string | undefined,
  fileExists: (path: string) => boolean,
  linuxPaths: NonNullable<LiveDoctorOptions['linuxPaths']>,
): DoctorCheck[] {
  const checks: DoctorCheck[] = []
  if (platform === 'darwin') {
    const uid = String(process.getuid?.() ?? env.UID ?? 501)
    const launchd = runner('launchctl', ['print', `gui/${uid}`], { timeoutMs: 5_000, env })
    checks.push({
      id: 'platform.launchd',
      category: 'platform',
      status: launchd.status === 0 ? 'ok' : 'warn',
      summary: launchd.status === 0
        ? `macOS launchd 用户域（gui/${uid}）可用`
        : `macOS launchd 用户域（gui/${uid}）探测失败`,
      ...(launchd.status !== 0 ? { detail: launchd.stderr.trim() || `launchctl 退出码 ${launchd.status}` } : {}),
    })
    const sandbox = fileExists('/usr/bin/sandbox-exec')
    checks.push({
      id: 'platform.sandbox',
      category: 'platform',
      status: sandbox ? 'ok' : 'warn',
      summary: sandbox ? 'macOS /usr/bin/sandbox-exec 可用' : '未检测到 /usr/bin/sandbox-exec',
    })
    return checks
  }

  if (platform === 'linux') {
    const user = env.USER || (() => {
      try { return userInfo().username } catch { return 'root' }
    })()
    const systemd = runner('systemctl', ['--user', 'show-environment'], { timeoutMs: 5_000, env })
    checks.push({
      id: 'platform.systemd',
      category: 'platform',
      status: systemd.status === 0 ? 'ok' : 'warn',
      summary: systemd.status === 0
        ? 'Linux systemd --user 会话可用'
        : 'Linux systemd --user 会话不可用',
      ...(systemd.status !== 0
        ? {
            detail: systemd.stderr.trim() || `systemctl 退出码 ${systemd.status}`,
            advice: '确保处于完整 systemd --user 会话（检查 XDG_RUNTIME_DIR 与 DBUS_SESSION_BUS_ADDRESS）。',
          }
        : {}),
    })

    const lingerCmd = runner('loginctl', ['show-user', user, '-p', 'Linger', '--value'], { timeoutMs: 5_000, env })
    const lingerFile = linuxPaths.lingerFile ?? `/var/lib/systemd/linger/${user}`
    const lingerEnabled = lingerCmd.status === 0
      ? lingerCmd.stdout.trim() === 'yes'
      : fileExists(lingerFile)
    checks.push({
      id: 'platform.linger',
      category: 'platform',
      status: lingerEnabled ? 'ok' : 'warn',
      summary: lingerEnabled
        ? `Linux loginctl linger 已为用户 ${user} 启用`
        : `Linux loginctl linger 未为用户 ${user} 启用`,
      ...(!lingerEnabled ? { advice: `常驻后台建议执行：sudo loginctl enable-linger ${user}` } : {}),
    })

    const bwrap = findExec(['bwrap'], env)
    checks.push({
      id: 'platform.bwrap',
      category: 'platform',
      status: bwrap ? 'ok' : 'warn',
      summary: bwrap ? `bubblewrap (bwrap) 可用：${bwrap}` : '未在 PATH 中找到 bubblewrap (bwrap)',
      ...(!bwrap ? { advice: 'autonomy 隔离运行需要安装 bubblewrap (bwrap)。' } : {}),
    })

    const cgroupRoot = linuxPaths.cgroupRoot ?? '/sys/fs/cgroup'
    const hasFreezer = fileExists(join(cgroupRoot, 'freezer'))
    const hasPids = fileExists(join(cgroupRoot, 'pids'))
    const isV2 = fileExists(join(cgroupRoot, 'cgroup.controllers'))
    if (hasFreezer && hasPids) {
      checks.push({
        id: 'platform.cgroup',
        category: 'platform',
        status: 'ok',
        summary: 'Linux cgroup v1（freezer + pids）控制器可用',
      })
    } else if (isV2) {
      const rawUid = linuxPaths.uid ?? process.getuid?.()
      const uid = typeof rawUid === 'number' && Number.isSafeInteger(rawUid) && rawUid > 0 ? rawUid : undefined
      const readText = (target: string): string | undefined => {
        if (!fileExists(target)) return undefined
        try { return readFileSync(target, 'utf8') } catch { return undefined }
      }
      const procSelfCgroup = linuxPaths.procSelfCgroup
        ?? (linuxPaths.cgroupRoot === undefined || linuxPaths.cgroupRoot === '/sys/fs/cgroup'
          ? readText('/proc/self/cgroup')
          : undefined)
      const unifiedCallerRel = procSelfCgroup
        ?.split('\n')
        .map(line => line.trim())
        .find(line => line.startsWith('0::'))
        ?.slice(3)
      const standalonePrefix = uid !== undefined ? `/dsh-native/uid-${uid}` : undefined
      const standaloneReachable = unifiedCallerRel === undefined
        || unifiedCallerRel === '/'
        || (standalonePrefix !== undefined
          && (unifiedCallerRel === standalonePrefix || unifiedCallerRel.startsWith(`${standalonePrefix}/`)))
      const systemdLeaf = uid !== undefined
        ? join(cgroupRoot, 'user.slice', `user-${uid}.slice`, `user@${uid}.service`, 'dsh-native', `uid-${uid}`)
        : undefined
      const standaloneLeaf = uid !== undefined ? join(cgroupRoot, 'dsh-native', `uid-${uid}`) : undefined
      const tokens = (text: string | undefined) => new Set((text ?? '').trim().split(/\s+/u).filter(Boolean))
      const requiredV2 = ['cpu', 'memory', 'pids'] as const
      const isLeafReady = (leaf: string | undefined): leaf is string => {
        if (!leaf) return false
        const leafControllers = tokens(readText(join(leaf, 'cgroup.controllers')))
        const leafSubtree = tokens(readText(join(leaf, 'cgroup.subtree_control')))
        const leafFreeze = readText(join(leaf, 'cgroup.freeze'))?.trim()
        return requiredV2.every(ctrl => leafControllers.has(ctrl) && leafSubtree.has(ctrl)) && leafFreeze === '0'
      }
      const delegatedLeaf = isLeafReady(systemdLeaf)
        ? systemdLeaf
        : standaloneReachable && isLeafReady(standaloneLeaf)
          ? standaloneLeaf
          : undefined
      if (delegatedLeaf !== undefined) {
        checks.push({
          id: 'platform.cgroup',
          category: 'platform',
          status: 'ok',
          summary: `Linux cgroup v2 委派子树（dsh-native/uid-${uid}：cpu + memory + pids + freeze）已就绪`,
          detail: `检测到已就绪的 cgroup v2 委派根 ${delegatedLeaf}，assistant-isolation 原生运行时进程迁入可用。`,
        })
      } else if (!standaloneReachable && isLeafReady(standaloneLeaf)) {
        checks.push({
          id: 'platform.cgroup',
          category: 'platform',
          status: 'warn',
          summary: `检测到根级 dsh-native/uid-${uid}，但当前会话（0::${unifiedCallerRel}）缺少 user@${uid}.service/dsh-native/uid-${uid} 委派`,
          advice: `非 root 进程无法从 0::${unifiedCallerRel} 直接迁入根级 /sys/fs/cgroup/dsh-native/uid-${uid}；请在 user@${uid}.service 激活后以 root 重新执行：node scripts/isolation/prepare-linux-cgroups.mjs --uid ${uid} --auto。`,
        })
      } else {
        checks.push({
          id: 'platform.cgroup',
          category: 'platform',
          status: 'warn',
          summary: '检测到纯 cgroup v2 宿主（缺少 cgroup v1 freezer + pids，且尚未完成 dsh-native cgroup v2 委派）',
          advice: `当前 cgroup v2 未检测到完整的 dsh-native/uid-${uid ?? '<uid>'}（cpu/memory/pids + cgroup.freeze=0）委派。常驻 web/lark 仍可用；如需启用原生隔离请以 root 执行：node scripts/isolation/prepare-linux-cgroups.mjs --uid ${uid ?? '<uid>'} --auto。`,
        })
      }
    } else {
      checks.push({
        id: 'platform.cgroup',
        category: 'platform',
        status: 'skip',
        summary: `未在 ${cgroupRoot} 检测到标准 cgroup 目录`,
      })
    }
    return checks
  }

  checks.push({
    id: 'platform.unsupported',
    category: 'platform',
    status: 'warn',
    summary: `平台 ${platform} 未验证受管服务与隔离运行前提`,
  })
  return checks
}

const ELECTRON_MANAGED_PROFILE_RE = /managed exclusively by the Electron application/iu
const CORDIS_PATCH_CUSTOM_TAGS = [{ tag: 'tag:yaml.org,2002:js', resolve: (v: string) => v }]

async function readRegularFileText(
  filePath: string,
  label: string,
): Promise<{ status: 'ok'; text: string } | { status: 'missing' } | { status: 'error'; error: string }> {
  let meta
  try {
    meta = await lstat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    return { status: 'error', error: `无法访问 ${label}（${filePath}）：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!meta.isFile() || meta.isSymbolicLink()) {
    return { status: 'error', error: `${label} 非普通文件：${filePath}` }
  }
  try {
    return { status: 'ok', text: await readFile(filePath, 'utf8') }
  } catch (error) {
    return { status: 'error', error: `读取 ${label} 失败（${filePath}）：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Direct read-only disk validation for an Electron-managed desktop profile (`package.json` + optional
 * `cordis.patch.yml`) when `dsh --dump-config` refuses access because the desktop app owns it.
 */
async function inspectElectronManagedProfileConfig(
  dshHome: string,
  profile: string,
): Promise<{ ok: true; rows: DumpConfigRow[] } | { ok: false; error: string }> {
  const profileDir = join(profilesDirectory(dshHome), profile)
  const pkgFile = await readRegularFileText(join(profileDir, 'package.json'), 'package.json')
  if (pkgFile.status === 'missing') {
    return { ok: false, error: `package.json 不存在：${join(profileDir, 'package.json')}` }
  }
  if (pkgFile.status === 'error') {
    return { ok: false, error: pkgFile.error }
  }
  let pkgParsed: unknown
  try {
    pkgParsed = JSON.parse(pkgFile.text)
  } catch (error) {
    return { ok: false, error: `package.json JSON 解析失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (pkgParsed === null || typeof pkgParsed !== 'object' || Array.isArray(pkgParsed)) {
    return { ok: false, error: 'package.json 根结构必须为 JSON 对象' }
  }

  const patchFile = await readRegularFileText(join(profileDir, 'cordis.patch.yml'), 'cordis.patch.yml')
  if (patchFile.status === 'missing') {
    return { ok: true, rows: [] }
  }
  if (patchFile.status === 'error') {
    return { ok: false, error: patchFile.error }
  }

  const doc = parseDocument(patchFile.text, { customTags: CORDIS_PATCH_CUSTOM_TAGS })
  if (doc.errors.length > 0) {
    return { ok: false, error: `cordis.patch.yml YAML 语法错误：${doc.errors[0]!.message}` }
  }
  let rootValue: unknown
  try {
    rootValue = doc.toJS()
  } catch (error) {
    return { ok: false, error: `cordis.patch.yml 解析失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (rootValue !== null && rootValue !== undefined && !Array.isArray(rootValue)) {
    return { ok: false, error: 'cordis.patch.yml 根结构必须为空或 YAML 序列' }
  }
  return { ok: true, rows: parseDumpConfigRows(patchFile.text) }
}

/**
 * Detect whether a macOS host has the bundled Electron desktop application (`DeepSeek Harness.app`)
 * or a `desktop` profile manifest, so read-only doctor checks can inspect `desktop` even when
 * neither `.dsh-ray-host.json` nor a global `dsh` CLI exists.
 */
async function hasElectronDesktopRuntime(
  dshHome: string,
  targetProfile: string | undefined,
  statusProfiles: readonly { readonly name: string }[],
  home: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean,
): Promise<boolean> {
  if (platform !== 'darwin') return false
  const desktopNodeExec = env.DSH_DESKTOP_NODE_EXECUTABLE?.trim()
  if (desktopNodeExec && desktopNodeExec.includes('.app/Contents/') && fileExists(desktopNodeExec)) {
    return true
  }
  const appCandidates = [
    '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
    '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs',
    join(home, 'Applications', 'DeepSeek Harness.app', 'Contents', 'MacOS', 'DeepSeek Harness'),
    join(home, 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
  ]
  if (appCandidates.some(candidate => fileExists(candidate))) return true
  const checksDesktop = targetProfile === 'desktop'
    || (targetProfile === undefined && statusProfiles.some(p => p.name === 'desktop'))
  if (!checksDesktop) return false
  const pkg = await readRegularFileText(join(profilesDirectory(dshHome), 'desktop', 'package.json'), 'package.json')
  if (pkg.status !== 'ok') return false
  try {
    const parsed = JSON.parse(pkg.text) as Record<string, unknown>
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.name === 'dsh-profile-desktop')
  } catch {
    return false
  }
}

/**
 * Run a comprehensive, strictly read-only live diagnostic pass over bound Host, credentials,
 * `traex`/`agy` CLI availability & auth, profile config dumps, autonomy readiness, ports,
 * OS prerequisites, and recent crash logs.
 */
export async function collectLiveDoctorReport(options: LiveDoctorOptions): Promise<LiveDoctorReport> {
  const env = options.env ?? process.env
  const runner = options.runner ?? defaultDetailedRunner
  const findExec = options.findExecutable ?? defaultFindExecutable
  const probePort = options.probePort ?? defaultProbePort
  const fileExists = options.fileExists ?? existsSync
  const dshHome = resolve(options.dshHome)
  const checks: DoctorCheck[] = []

  const status = await collectStatus(dshHome, options.home, options.platform, runner)
  const boundHost = await inspectBoundHostRuntime(
    dshHome,
    options.readHostRuntime ? { read: options.readHostRuntime } : {},
  )

  let dshExecutable = 'dsh'
  let dshEnv: NodeJS.ProcessEnv = { ...env, DSH_HOME: dshHome }
  const electronDesktopRuntime = boundHost.status === 'missing' && !status.hostVersion
    ? await hasElectronDesktopRuntime(dshHome, options.profile, status.profiles, options.home, options.platform, env, fileExists)
    : false
  if (boundHost.status === 'ready' && boundHost.dshPath) {
    dshExecutable = boundHost.dshPath
    dshEnv = {
      ...dshEnv,
      DSH_RAY_HOST_BIN: boundHost.binDirectory,
      PATH: [boundHost.binDirectory, env.PATH ?? ''].filter(Boolean).join(delimiter),
    }
    checks.push({
      id: 'host.bound',
      category: 'host',
      status: 'ok',
      summary: `私有 Host 已绑定 ${boundHost.version}：${boundHost.dshPath}`,
    })
  } else if (boundHost.status === 'missing') {
    const hostOk = Boolean(status.hostVersion) || electronDesktopRuntime
    checks.push({
      id: 'host.bound',
      category: 'host',
      status: hostOk ? 'ok' : 'fail',
      summary: status.hostVersion
        ? `未绑定私有 .dsh-ray-host.json；使用全局 dsh (${status.hostVersion})`
        : electronDesktopRuntime
          ? '未绑定私有 .dsh-ray-host.json；检测到桌面端 DeepSeek Harness Electron 运行时'
          : '未找到私有 .dsh-ray-host.json，且全局 PATH 中无 dsh 命令',
      ...(!hostOk ? { advice: '运行 dsh-ray install 或 install-npm.sh 准备受管 Host。' } : {}),
    })
  } else {
    checks.push({
      id: 'host.bound',
      category: 'host',
      status: 'fail',
      summary: `私有 Host 绑定异常（${boundHost.status}）：${boundHost.error || boundHost.issues.join('；')}`,
      advice: '运行 dsh-ray update --all 或 dsh-ray reinstall 修复私有 Host 绑定。',
    })
  }

  // Credentials (keys & presence ONLY — never read secret values!)
  const credPath = join(dshHome, '.credentials.yaml')
  let credSource = ''
  let credMode: number | undefined
  let insecurePermissions = false
  let fileExistsCred = false
  try {
    const meta = await stat(credPath)
    if (meta.isFile()) {
      fileExistsCred = true
      credMode = meta.mode & 0o777
      insecurePermissions = (meta.mode & 0o077) !== 0
      credSource = await readFile(credPath, 'utf8')
    }
  } catch {
    // missing .credentials.yaml is valid when using local coding agents or keychain
  }
  const keyNames = fileExistsCred ? extractCredentialKeyNames(credSource) : []
  const envKeySet = new Set([...KNOWN_CREDENTIAL_ENV_VARS, ...keyNames])
  const envVariablesPresent = [...envKeySet].filter(key => Boolean(env[key] && env[key]!.length > 0)).sort()
  const locators = await scanCredentialLocators(dshHome).catch(() => [])
  if (insecurePermissions && credMode !== undefined) {
    checks.push({
      id: 'credentials.permissions',
      category: 'credentials',
      status: 'warn',
      summary: `.credentials.yaml 权限过宽（${credMode.toString(8).padStart(4, '0')}）`,
      advice: `收紧权限：chmod 600 ${credPath}`,
    })
  }

  // Settings default model fallback
  let settingsDefault: { provider?: string; model?: string } | undefined
  try {
    const settingsSource = await readFile(join(dshHome, 'settings.yaml'), 'utf8')
    settingsDefault = parseSettingsDefaultModel(settingsSource)
  } catch {
    // ignore missing settings.yaml
  }

  // Inspect profiles via `--dump-config` + `dsh-autonomy-doctor --readiness` + port check
  const targetProfiles = options.profile
    ? status.profiles.filter(item => item.name === options.profile)
    : status.profiles
  if (options.profile && targetProfiles.length === 0) {
    checks.push({
      id: `profile.${options.profile}`,
      category: 'profile',
      status: 'fail',
      summary: `指定的 profile "${options.profile}" 不存在于 ${dshHome}`,
      advice: `可用 profile：${status.profiles.map(p => p.name).join('、') || '（无）'}`,
    })
  }

  const profileDiagnoses: ProfileDoctorDiagnosis[] = []
  let explicitTraexCmd: string | undefined
  let explicitAgyCmd: string | undefined

  for (const profileEntry of targetProfiles) {
    const profile = profileEntry.name
    const plugins = await listProfilePlugins(dshHome, profile)
    const hasPlugin = (slug: string): boolean => plugins.some(item => item.name === `@dsh-ray/${slug}`)

    const dump = runner(dshExecutable, ['--profile', profile, '--dump-config'], { timeoutMs: 20_000, env: dshEnv })
    let configDumpOk = dump.status === 0 && dump.stdout.trim().length > 0
    let configDumpError: string | undefined = !configDumpOk ? (dump.stderr.trim() || `退出码 ${dump.status}`) : undefined
    let rows: DumpConfigRow[] = configDumpOk ? parseDumpConfigRows(dump.stdout) : []
    const electronDesktopFallback = dump.status !== 0 && (
      ELECTRON_MANAGED_PROFILE_RE.test(`${dump.stderr}\n${dump.stdout}`)
      || (options.platform === 'darwin' && profile === 'desktop' && electronDesktopRuntime)
    )
    if (electronDesktopFallback) {
      const fallback = await inspectElectronManagedProfileConfig(dshHome, profile)
      if (fallback.ok) {
        configDumpOk = true
        configDumpError = undefined
        rows = fallback.rows
        checks.push({
          id: `profile.${profile}.dump`,
          category: 'profile',
          status: 'ok',
          summary: `profile ${profile} 由桌面端 Electron 独占托管；已直接校验 cordis.patch.yml 与 package.json`,
        })
      } else {
        configDumpOk = false
        configDumpError = fallback.error
        rows = []
        checks.push({
          id: `profile.${profile}.dump`,
          category: 'profile',
          status: 'fail',
          summary: `profile ${profile} --dump-config 执行失败`,
          detail: fallback.error,
        })
      }
    } else if (!configDumpOk) {
      checks.push({
        id: `profile.${profile}.dump`,
        category: 'profile',
        status: 'fail',
        summary: `profile ${profile} --dump-config 执行失败`,
        detail: configDumpError ?? `退出码 ${dump.status}`,
      })
    }

    const acpRow = findSlugRow(rows, 'traex-acp-provider')
    const traexEnabled = Boolean(acpRow && acpRow.disabled !== true && acpRow.config.enabled === true)
    const agyEnabled = Boolean(acpRow && acpRow.disabled !== true && acpRow.config.agyEnabled === true)
    const traexCmd = typeof acpRow?.config.command === 'string' ? acpRow.config.command : undefined
    const agyCmd = typeof acpRow?.config.agyCommand === 'string' ? acpRow.config.agyCommand : undefined
    if (traexCmd && !explicitTraexCmd) explicitTraexCmd = traexCmd
    if (agyCmd && !explicitAgyCmd) explicitAgyCmd = agyCmd

    const defaultRow = rows.find(row => row.id === 'agent-default-model')
    const defaultModelRoute = defaultRow && (typeof defaultRow.config.provider === 'string' || typeof defaultRow.config.model === 'string')
      ? {
          ...(typeof defaultRow.config.provider === 'string' ? { provider: defaultRow.config.provider } : {}),
          ...(typeof defaultRow.config.model === 'string' ? { model: defaultRow.config.model } : {}),
        }
      : settingsDefault

    const ownerConsoleRow = findSlugRow(rows, 'owner-console')
    const proactiveRow = findSlugRow(rows, 'assistant-proactive')
    const dreamingRow = findSlugRow(rows, 'assistant-dreaming')
    const growthRow = findSlugRow(rows, 'assistant-growth-driver')
    const memoryRow = findSlugRow(rows, 'assistant-memory-learning')

    const dreamingMissingPrerequisites = dreamingRow
      ? DREAMING_REQUIRED_FIELDS.filter(field => {
          const val = dreamingRow.config[field]
          if (field === 'budgetAmount') return typeof val !== 'number' || val <= 0
          return val === undefined || val === ''
        })
      : []

    const dreamingEnabled = dreamingRow && dreamingRow.disabled !== true ? dreamingRow.config.enabled === true : undefined
    if (dreamingEnabled === true && dreamingMissingPrerequisites.length > 0) {
      checks.push({
        id: `profile.${profile}.dreaming`,
        category: 'profile',
        status: 'fail',
        summary: `profile ${profile} 的 assistant-dreaming 已启用但缺少配置：${dreamingMissingPrerequisites.join(', ')}`,
        advice: 'Dreaming 需要完整配置 scope、databasePath、provider/model 与有限 budgetId/budgetAmount。',
      })
    }

    let autonomyReadiness: ProfileDoctorDiagnosis['autonomyReadiness']
    if (hasPlugin('assistant-web-owner') && (hasPlugin('assistant-isolation') || hasPlugin('assistant-policy'))) {
      const doctorBin = await resolveAutonomyDoctorPath(dshHome, profile, env, options.home, options.platform)
      if (doctorBin) {
        const autonomy = runner(
          doctorBin.command,
          [...doctorBin.prefixArgs, '--profile', profile, '--dsh-home', dshHome, '--readiness'],
          { timeoutMs: 20_000, env: { ...dshEnv, ...doctorBin.envOverrides } },
        )
        const lines = autonomy.stdout.trim().split(/\r?\n/u)
        const lastLine = lines[lines.length - 1] ?? ''
        let ok = autonomy.status === 0
        let summaryText = ok ? 'autonomy readiness 就绪' : `autonomy readiness 未就绪（退出码 ${autonomy.status}）`
        try {
          const parsed = JSON.parse(lastLine) as { ready?: boolean; checks?: { status?: string; id?: string }[] }
          if (typeof parsed.ready === 'boolean') {
            ok = parsed.ready
            const unreadyIds = (parsed.checks ?? []).filter(c => c.status === 'not-ready').map(c => c.id).filter(Boolean)
            summaryText = ok
              ? 'autonomy readiness 就绪'
              : `autonomy readiness 未就绪：${unreadyIds.join(', ') || '详见 readiness 输出'}`
          }
        } catch {
          if (autonomy.stderr.trim()) summaryText = `${summaryText}：${autonomy.stderr.trim()}`
        }
        autonomyReadiness = { checked: true, ok, summary: summaryText }
        checks.push({
          id: `autonomy.${profile}.readiness`,
          category: 'autonomy',
          status: ok ? 'ok' : 'warn',
          summary: `${profile}：${summaryText}`,
        })
      }
    }

    const [stdoutLog] = profileLogPaths(dshHome, profile)
    let rawUrl: string | undefined
    if (stdoutLog) {
      const tail = await tailLogFile(stdoutLog, 200)
      rawUrl = extractWebUrlFromText(tail.lines.join('\n'))
    }
    const configuredPort = extractPort(rawUrl, rows)
    let portListening: boolean | undefined
    if (configuredPort !== undefined) {
      portListening = await probePort(configuredPort)
      if (profileEntry.serviceActive && !portListening) {
        checks.push({
          id: `port.${profile}`,
          category: 'port',
          status: 'warn',
          summary: `${profile} 服务显示运行中，但端口 ${configuredPort} 未响应连接`,
          advice: `运行 dsh-ray logs --profile ${profile} 检查启动日志。`,
        })
      } else if (portListening) {
        checks.push({
          id: `port.${profile}`,
          category: 'port',
          status: profileEntry.serviceActive ? 'ok' : 'warn',
          summary: profileEntry.serviceActive
            ? `${profile} Web 端口 ${configuredPort} 正在监听`
            : `端口 ${configuredPort} 已有进程监听，但受管服务状态为未运行`,
        })
      }
    }

    const ownerConsoleEnabled = isRowEnabled(ownerConsoleRow)
    const proactiveEnabled = isRowEnabled(proactiveRow)
    const growthEnabled = isRowEnabled(growthRow)
    const memoryLearningEnabled = isRowEnabled(memoryRow)

    profileDiagnoses.push({
      profile,
      pluginsCount: plugins.length,
      serviceInstalled: profileEntry.serviceInstalled,
      serviceActive: profileEntry.serviceActive,
      configDumpOk,
      ...(!configDumpOk ? { configDumpError: configDumpError ?? (dump.stderr.trim() || `退出码 ${dump.status}`) } : {}),
      ...(defaultModelRoute ? { defaultModelRoute } : {}),
      providers: {
        traexConfigured: Boolean(acpRow),
        traexEnabled,
        ...(traexCmd ? { traexCommand: traexCmd } : {}),
        agyConfigured: Boolean(acpRow),
        agyEnabled,
        ...(agyCmd ? { agyCommand: agyCmd } : {}),
      },
      capabilities: {
        ownerConsoleInstalled: hasPlugin('owner-console'),
        ...(ownerConsoleEnabled !== undefined ? { ownerConsoleEnabled } : {}),
        proactiveInstalled: hasPlugin('assistant-proactive'),
        ...(proactiveEnabled !== undefined ? { proactiveEnabled } : {}),
        dreamingInstalled: hasPlugin('assistant-dreaming'),
        ...(dreamingEnabled !== undefined ? { dreamingEnabled } : {}),
        dreamingMissingPrerequisites: [...dreamingMissingPrerequisites],
        growthInstalled: hasPlugin('assistant-growth-driver'),
        ...(growthEnabled !== undefined ? { growthEnabled } : {}),
        memoryLearningInstalled: hasPlugin('assistant-memory-learning'),
        ...(memoryLearningEnabled !== undefined ? { memoryLearningEnabled } : {}),
      },
      ...(autonomyReadiness ? { autonomyReadiness } : {}),
      webUrl: {
        ...(configuredPort !== undefined ? { configuredPort } : {}),
        ...(rawUrl ? { redactedLogUrl: redactUrlToken(rawUrl) } : {}),
        ...(portListening !== undefined ? { portListening } : {}),
      },
    })
  }

  // Coding agent tools (`traex` and `agy`) — strictly read-only auth checks
  const traexBin = findExec(['traex', 'trae-cli'], env, explicitTraexCmd)
  let traexStatus: LiveDoctorReport['agentTools']['traex']
  if (!traexBin) {
    traexStatus = { found: false, detail: '未在 PATH 中检测到 traex / trae-cli' }
    checks.push({ id: 'auth.traex', category: 'auth', status: 'skip', summary: traexStatus.detail })
  } else {
    const login = runner(traexBin, ['login', 'status'], { timeoutMs: 15_000, env })
    const out = login.stdout.trim(), err = login.stderr.trim()
    const ready = login.status === 0 && ((out === 'Logged in using Trae' && err === '') || (err === 'Logged in using Trae' && out === ''))
    traexStatus = {
      found: true,
      command: traexBin,
      loginReady: ready,
      detail: ready ? `TraeX 已登录（${traexBin}）` : `TraeX 尚未完成登录（${err || out || `退出码 ${login.status}`}）`,
    }
    checks.push({
      id: 'auth.traex',
      category: 'auth',
      status: ready ? 'ok' : 'warn',
      summary: traexStatus.detail,
      ...(!ready ? { advice: '运行 traex login 完成本机登录后即可使用 traex-agent。' } : {}),
    })
  }

  const agyBin = findExec(['agy'], env, explicitAgyCmd)
  let agyStatus: LiveDoctorReport['agentTools']['agy']
  if (!agyBin) {
    agyStatus = { found: false, detail: '未在 PATH 中检测到 agy CLI' }
    checks.push({ id: 'auth.agy', category: 'auth', status: 'skip', summary: agyStatus.detail })
  } else {
    const models = runner(agyBin, ['models'], { timeoutMs: 20_000, env })
    const ready = models.status === 0
    agyStatus = {
      found: true,
      command: agyBin,
      loginReady: ready,
      detail: ready ? `Antigravity (agy) 模型探测就绪（${agyBin}）` : `Antigravity (agy) 未就绪（${models.stderr.trim() || `退出码 ${models.status}`}）`,
    }
    checks.push({
      id: 'auth.agy',
      category: 'auth',
      status: ready ? 'ok' : 'warn',
      summary: agyStatus.detail,
      ...(!ready ? { advice: '请在 Antigravity 中完成登录，再运行 `agy models` 验证。' } : {}),
    })
  }

  // Validate active profile default agent routes against ACP toggles & CLI login readiness
  for (const profileDiag of profileDiagnoses) {
    const route = profileDiag.defaultModelRoute?.provider
    if (route === 'traex-agent') {
      const okRoute = profileDiag.providers.traexEnabled && traexStatus.loginReady === true
      checks.push({
        id: `profile.${profileDiag.profile}.model-route`,
        category: 'profile',
        status: okRoute ? 'ok' : 'warn',
        summary: okRoute
          ? `${profileDiag.profile} 默认路由 traex-agent 已启用且登录就绪`
          : `${profileDiag.profile} 默认路由为 traex-agent，但插件或本机登录未完全就绪`,
        ...(!okRoute
          ? { advice: `检查 dsh-ray-traex-acp-provider enabled 状态并确认 traex login status（或运行 dsh-model-setup --dsh-home ${dshHome} --provider traex-agent --enable-in-profile ${profileDiag.profile}）。` }
          : {}),
      })
    } else if (route === 'agy-agent') {
      const okRoute = profileDiag.providers.agyEnabled && agyStatus.loginReady === true
      checks.push({
        id: `profile.${profileDiag.profile}.model-route`,
        category: 'profile',
        status: okRoute ? 'ok' : 'warn',
        summary: okRoute
          ? `${profileDiag.profile} 默认路由 agy-agent 已启用且 agy 登录就绪`
          : `${profileDiag.profile} 默认路由为 agy-agent，但 agyEnabled 或 agy 登录未完全就绪`,
        ...(!okRoute
          ? { advice: `检查 dsh-ray-traex-acp-provider agyEnabled 与 agy models（或运行 dsh-model-setup --dsh-home ${dshHome} --provider agy-agent --enable-in-profile ${profileDiag.profile}）。` }
          : {}),
      })
    }
  }

  const hasAnyModelAuth = traexStatus.loginReady === true || agyStatus.loginReady === true
    || keyNames.length > 0 || envVariablesPresent.length > 0 || locators.length > 0
  checks.push({
    id: 'credentials.summary',
    category: 'credentials',
    status: hasAnyModelAuth ? 'ok' : 'warn',
    summary: hasAnyModelAuth
      ? `模型认证可用（.credentials.yaml ${keyNames.length} 个键 / 环境 ${envVariablesPresent.length} 项 / 外部凭据 ${locators.length} 条${traexStatus.loginReady ? ' / traex' : ''}${agyStatus.loginReady ? ' / agy' : ''}）`
      : '未检测到可用的 API 凭据或已登录的 traex/agy 本机工具',
    ...(!hasAnyModelAuth ? { advice: '请设置模型 API Key，或登录 TraeX (`traex login`) / Antigravity (`agy`)。' } : {}),
  })

  const prerequisites = probePlatformPrerequisites(
    options.platform,
    env,
    runner,
    findExec,
    fileExists,
    options.linuxPaths ?? {},
  )
  checks.push(...prerequisites)

  const allLogFindings = await runDoctor(dshHome)
  const logFindings = options.profile
    ? allLogFindings.filter(finding => finding.profile === options.profile)
    : allLogFindings
  for (const finding of logFindings) {
    checks.push({
      id: `logs.${finding.profile}`,
      category: 'logs',
      status: 'warn',
      summary: `[${finding.profile}] ${finding.pattern}`,
      detail: finding.logPath,
      advice: finding.advice,
    })
  }

  const summary = { ok: 0, warn: 0, fail: 0, skip: 0 }
  for (const check of checks) summary[check.status] += 1

  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    ok: summary.fail === 0,
    platform: options.platform,
    dshHome,
    summary,
    status,
    boundHost,
    credentials: {
      filePath: credPath,
      fileExists: fileExistsCred,
      ...(credMode !== undefined ? { mode: credMode } : {}),
      insecurePermissions,
      keyNames,
      envVariablesPresent,
      externalLocatorsCount: locators.length,
    },
    agentTools: {
      traex: traexStatus,
      agy: agyStatus,
    },
    prerequisites,
    profiles: profileDiagnoses,
    logFindings,
    checks,
  }
}

function statusTag(status: CheckStatus): string {
  if (status === 'ok') return 'OK  '
  if (status === 'warn') return 'WARN'
  if (status === 'fail') return 'FAIL'
  return 'SKIP'
}

/** Format `LiveDoctorReport` for interactive terminal display with zero secret/token leakage. */
export function formatLiveDoctorReport(report: LiveDoctorReport): string {
  const lines: string[] = [formatStatus(report.status), '']
  lines.push('=== 实时运行环境与接入诊断（doctor） ===')
  if (report.boundHost.status === 'ready') {
    lines.push(`私有 Host（.dsh-ray-host.json）：就绪 ${report.boundHost.version} -> ${report.boundHost.dshPath}`)
  } else if (report.boundHost.status === 'missing') {
    lines.push(`私有 Host（.dsh-ray-host.json）：未绑定（路径 ${report.boundHost.bindingPath}）`)
  } else {
    lines.push(`私有 Host（.dsh-ray-host.json）：${report.boundHost.status}（${report.boundHost.error || report.boundHost.issues.join('；')}）`)
  }
  lines.push(
    `凭据文件（.credentials.yaml）：${report.credentials.fileExists ? `存在（键：${report.credentials.keyNames.join(', ') || '无'}）` : '不存在'}；环境变量：${report.credentials.envVariablesPresent.join(', ') || '无'}；外部条目：${report.credentials.externalLocatorsCount}`,
  )
  lines.push(`本机 TraeX：${report.agentTools.traex.detail}`)
  lines.push(`本机 Antigravity (agy)：${report.agentTools.agy.detail}`)

  if (report.profiles.length > 0) {
    lines.push('Profile 运行与能力详情：')
    for (const item of report.profiles) {
      const routeText = item.defaultModelRoute?.provider
        ? `${item.defaultModelRoute.provider}/${item.defaultModelRoute.model ?? 'default'}`
        : '未显式指定'
      const caps: string[] = []
      if (item.capabilities.ownerConsoleInstalled) caps.push(`owner-console:${item.capabilities.ownerConsoleEnabled ? 'on' : 'off'}`)
      if (item.capabilities.proactiveInstalled) caps.push(`proactive:${item.capabilities.proactiveEnabled ? 'on' : 'off'}`)
      if (item.capabilities.dreamingInstalled) caps.push(`dreaming:${item.capabilities.dreamingEnabled ? 'on' : 'dormant'}`)
      if (item.capabilities.growthInstalled) caps.push(`growth:${item.capabilities.growthEnabled ? 'on' : 'off'}`)
      if (item.capabilities.memoryLearningInstalled) caps.push(`memory:${item.capabilities.memoryLearningEnabled ? 'on' : 'off'}`)
      lines.push(`  - ${item.profile}（模型：${routeText}；traex-agent：${item.providers.traexEnabled ? '开' : '关'}；agy-agent：${item.providers.agyEnabled ? '开' : '关'}）`)
      if (caps.length > 0) lines.push(`      能力：${caps.join(' | ')}`)
      if (item.autonomyReadiness) lines.push(`      autonomy：${item.autonomyReadiness.summary}`)
      if (item.webUrl.redactedLogUrl || item.webUrl.configuredPort !== undefined) {
        lines.push(`      Web：${item.webUrl.redactedLogUrl ?? `端口 ${item.webUrl.configuredPort}`}（查看完整授权 URL 请运行 dsh-ray open --profile ${item.profile}）`)
      }
    }
  }

  lines.push(`诊断汇总：ok=${report.summary.ok} warn=${report.summary.warn} fail=${report.summary.fail} skip=${report.summary.skip}`)
  for (const check of report.checks) {
    lines.push(`  [${statusTag(check.status)}] ${check.id}: ${check.summary}`)
    if (check.advice) lines.push(`           建议：${check.advice}`)
  }

  lines.push('')
  lines.push(formatFindings(report.logFindings))
  return lines.join('\n')
}
