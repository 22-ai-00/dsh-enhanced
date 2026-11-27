import { existsSync } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { inspectBoundHostRuntime, type BoundHostInspection } from './install-host.ts'
import { inspectLaunchdDefinition, inspectLoadedLaunchd } from './launchd-service.ts'
import {
  listLifecycleResiduals,
  listProfiles,
  listProfilePlugins,
  logsDirectory,
  systemdUnitName,
  systemdUserDirectory,
} from './paths.ts'
import { scanCredentialLocators } from './secrets.ts'
import { defaultRunner, type CommandRunner } from './run.ts'

export interface InstallIntentSummary {
  schemaVersion: number
  scenario: string
  learning?: string
  pluginPreset?: string
  proactive?: string
  dreaming?: string
  growth?: string
  at?: string
}

/** Extract top-level YAML mapping key names without reading or exposing values. */
export function extractYamlTopLevelKeys(source: string): string[] {
  const keys = new Set<string>()
  for (const rawLine of source.split(/\r?\n/u)) {
    if (!rawLine || /^\s/u.test(rawLine)) continue
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed === '---' || trimmed === '...') continue
    const match = /^(['"]?)([A-Za-z_][A-Za-z0-9_.-]*)\1\s*:/u.exec(trimmed)
    if (match?.[2]) keys.add(match[2])
  }
  return [...keys].sort()
}

/**
 * Extract stored credential reference names from `.credentials.yaml` without exposing secret values.
 * Supports both DSH v1 (`version: 1` + `refs:` mapping) and legacy flat (`KEY: secret`) layouts.
 */
export function extractCredentialKeyNames(source: string): string[] {
  try {
    const doc = parseDocument(source)
    if (doc.errors.length === 0) {
      const parsed: unknown = doc.toJS()
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>
        if (
          record.version === 1
          || (record.refs !== undefined && typeof record.refs === 'object' && record.refs !== null && !Array.isArray(record.refs))
        ) {
          const refs = record.refs
          if (refs && typeof refs === 'object' && !Array.isArray(refs)) {
            return Object.keys(refs as Record<string, unknown>)
              .filter(key => key.trim().length > 0)
              .sort()
          }
          return []
        }
      }
    }
  } catch {
    // Fall back to line-based top-level key extraction below.
  }
  return extractYamlTopLevelKeys(source)
}

export interface ProfileStatus {
  name: string
  npmPlugins: string[]
  localPlugins: { name: string; target: string }[]
  serviceInstalled: boolean
  serviceActive: boolean
}

export interface StatusSnapshot {
  dshHome: string
  homeExists: boolean
  hostVersion?: string
  hostError?: string
  boundHost?: BoundHostInspection
  installIntent?: InstallIntentSummary
  profiles: ProfileStatus[]
  credentialCount: number
  credentialKeys?: string[]
  residuals: string[]
}

async function serviceState(
  platform: NodeJS.Platform,
  home: string,
  dshHome: string,
  profile: string,
  runner: CommandRunner,
): Promise<{ installed: boolean; active: boolean }> {
  if (platform === 'darwin') {
    const checked = await inspectLaunchdDefinition(home, dshHome, profile, runner)
    const loaded = checked.definition ? inspectLoadedLaunchd(checked.definition, dshHome, runner) : undefined
    return { installed: !!checked.definition, active: !!loaded && !loaded.error && loaded.registered && loaded.running }
  }
  const unit = systemdUnitName(profile)
  const installed = existsSync(join(systemdUserDirectory(home), unit))
  const shown = runner('systemctl', ['--user', 'is-active', unit])
  // is-active 对 inactive 输出 inactive 并退出码 3。
  return { installed, active: shown.stdout.trim() === 'active' }
}

/** 只读状态：安装形态、host 版本、服务注册、凭据条目数、生命周期残留。 */
export async function collectStatus(
  dshHome: string,
  home: string,
  platform: NodeJS.Platform,
  runner: CommandRunner = defaultRunner,
): Promise<StatusSnapshot> {
  const homeExists = existsSync(dshHome)
  const profiles = await listProfiles(dshHome)
  const profileStatus: ProfileStatus[] = []
  for (const name of profiles) {
    const plugins = await listProfilePlugins(dshHome, name)
    const service = await serviceState(platform, home, dshHome, name, runner)
    profileStatus.push({
      name,
      npmPlugins: plugins.filter(plugin => plugin.kind === 'npm').map(plugin => plugin.name),
      localPlugins: plugins
        .filter(plugin => plugin.kind === 'local')
        .map(plugin => ({ name: plugin.name, target: plugin.linkTarget ?? '' })),
      serviceInstalled: service.installed,
      serviceActive: service.active,
    })
  }
  const host = runner('dsh', ['--version'])
  const credentials = await scanCredentialLocators(dshHome).catch(() => [])
  const parent = dshHome.slice(0, dshHome.lastIndexOf('/')) || '/'
  const [parentEntries, tmpEntries] = await Promise.all([
    readdir(parent).catch(() => [] as string[]),
    readdir('/tmp').catch(() => [] as string[]),
  ])
  const residuals = homeExists
    ? await listLifecycleResiduals(dshHome, parentEntries, tmpEntries)
    : []
  const boundHost = homeExists
    ? await inspectBoundHostRuntime(dshHome).catch(() => undefined)
    : undefined
  const installIntent = homeExists
    ? await readFile(join(dshHome, '.dsh-ray', 'install-intent.json'), 'utf8')
        .then(raw => {
          const parsed = JSON.parse(raw) as Partial<InstallIntentSummary>
          if (typeof parsed.schemaVersion === 'number' && typeof parsed.scenario === 'string') {
            return parsed as InstallIntentSummary
          }
          return undefined
        })
        .catch(() => undefined)
    : undefined
  const credentialKeys = homeExists
    ? await readFile(join(dshHome, '.credentials.yaml'), 'utf8')
        .then(extractCredentialKeyNames)
        .catch(() => [] as string[])
    : []
  return {
    dshHome,
    homeExists,
    ...(host.status === 0
      ? { hostVersion: host.stdout.trim() }
      : { hostError: host.stderr.trim() || host.stdout.trim() || '未找到全局 dsh 命令' }),
    ...(boundHost && boundHost.status !== 'missing' ? { boundHost } : {}),
    ...(installIntent ? { installIntent } : {}),
    profiles: profileStatus,
    credentialCount: credentials.length,
    ...(credentialKeys.length > 0 ? { credentialKeys } : {}),
    residuals,
  }
}

export function formatStatus(snapshot: StatusSnapshot): string {
  const lines: string[] = []
  lines.push(`DSH home：${snapshot.dshHome}（${snapshot.homeExists ? '存在' : '不存在'}）`)
  lines.push(`全局 host：${snapshot.hostVersion ? `dsh ${snapshot.hostVersion}` : snapshot.hostError ?? '未知'}`)
  if (snapshot.boundHost) {
    const detail = snapshot.boundHost.status === 'ready'
      ? `${snapshot.boundHost.version}（${snapshot.boundHost.dshPath}）`
      : snapshot.boundHost.error || snapshot.boundHost.issues.join('；') || snapshot.boundHost.status
    lines.push(`私有 host（.dsh-ray-host.json）：${detail}`)
  }
  if (snapshot.installIntent) {
    const intent = snapshot.installIntent
    const extras = [
      intent.proactive ? `proactive=${intent.proactive}` : undefined,
      intent.dreaming ? `dreaming=${intent.dreaming}` : undefined,
      intent.growth ? `growth=${intent.growth}` : undefined,
    ].filter(Boolean).join(', ')
    lines.push(`安装意图：scenario=${intent.scenario}${intent.pluginPreset ? `, preset=${intent.pluginPreset}` : ''}${extras ? `, ${extras}` : ''}`)
  }
  lines.push(`外部凭据条目：${snapshot.credentialCount}`)
  if (snapshot.credentialKeys && snapshot.credentialKeys.length > 0) {
    lines.push(`凭据文件键名：${snapshot.credentialKeys.join(', ')}`)
  }
  if (snapshot.profiles.length === 0) {
    lines.push('profiles：（无）')
  } else {
    lines.push('profiles：')
    for (const profile of snapshot.profiles) {
      const service = profile.serviceActive ? '运行中' : profile.serviceInstalled ? '已安装/未运行' : '无受管服务'
      lines.push(`  - ${profile.name}（服务：${service}）`)
      for (const plugin of profile.npmPlugins) lines.push(`      npm   ${plugin}`)
      for (const plugin of profile.localPlugins) lines.push(`      local ${plugin.name} -> ${plugin.target}`)
    }
  }
  if (snapshot.residuals.length > 0) {
    lines.push('生命周期残留：')
    for (const residual of snapshot.residuals) lines.push(`  ! ${residual}`)
  }
  return lines.join('\n')
}

export interface DoctorFinding {
  profile: string
  logPath: string
  pattern: string
  advice: string
}

/**
 * 已知崩溃模式与处置建议。
 * 旧版 assistant-policy（≤0.1.31）在 JSONL 持久化后端上 fail-closed 拒绝注册。
 */
const KNOWN_LOG_PATTERNS: { pattern: RegExp; label: string; advice: string }[] = [
  {
    pattern: /event-support oracle|refusing unproven registration|does not expose the supported PersistenceCoordinator/iu,
    label: '旧版 assistant-policy event-support oracle 不兼容（≤0.1.31 与全局 JSONL host 契约错配）',
    advice: '升级插件集合到 ≥0.1.32（npm：重跑 install-npm.sh --operation upgrade；local：checkout 切到最新 release tag 后 pnpm install --frozen-lockfile && pnpm build），再重启 profile。',
  },
]

/** 扫描各 profile 最近的 *-host.error.log 尾部，匹配已知崩溃模式。 */
export async function runDoctor(dshHome: string): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = []
  const logDirectory = logsDirectory(dshHome)
  let entries: string[]
  try {
    entries = await readdir(logDirectory)
  } catch {
    return findings
  }
  for (const entry of entries) {
    if (!entry.endsWith('-host.error.log')) continue
    const profile = entry.slice(0, -'-host.error.log'.length)
    const path = join(logDirectory, entry)
    let metadata
    try {
      metadata = await stat(path)
    } catch {
      continue
    }
    if (!metadata.isFile() || metadata.size === 0) continue
    // 只读尾部 256 KiB，覆盖最近一次启动的崩溃栈。
    const length = Math.min(metadata.size, 256 * 1024)
    const buffer = Buffer.alloc(length)
    const file = await open(path, 'r')
    try {
      await file.read(buffer, 0, length, metadata.size - length)
    } finally {
      await file.close()
    }
    const tail = buffer.toString('utf8')
    for (const known of KNOWN_LOG_PATTERNS) {
      if (known.pattern.test(tail)) {
        findings.push({ profile, logPath: path, pattern: known.label, advice: known.advice })
      }
    }
  }
  return findings
}

export function formatFindings(findings: readonly DoctorFinding[]): string {
  if (findings.length === 0) return 'doctor：未发现已知崩溃模式。'
  return findings.map(finding =>
    `doctor：[${finding.profile}] ${finding.pattern}\n  日志：${finding.logPath}\n  建议：${finding.advice}`).join('\n')
}
