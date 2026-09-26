import { createHash } from 'node:crypto'
import { readdir, readlink, lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'

/**
 * dsh 受管 profile 在 macOS LaunchAgent 中使用的 label 前缀。
 * 与 plugins/lark-channel/src/launchd.ts 的 launchAgentPaths 保持一致。
 */
export const LAUNCHD_LABEL_PREFIX = 'ai.deepseek.dsh.profile.'
/** Linux systemd --user 受管 unit 命名（lifecycle-profile.mjs SYSTEMD_UNIT）。 */
export const SYSTEMD_UNIT_PATTERN = /^dsh-profile-([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.service$/u
/** 生命周期事务目录后缀（lifecycle-profile.mjs:17）。 */
export const TRANSACTION_SUFFIX = '.dsh-enhanced-transaction'
/** 生命周期 home 级锁后缀（lifecycle-profile.mjs:504）。 */
export const HOME_LOCK_SUFFIX = '.dsh-enhanced-lifecycle.lock'
/** Keychain / Secret Service 中受管凭据的 service 前缀。 */
export const CREDENTIAL_SERVICE_PREFIX = 'dsh/'

export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.DSH_HOME
  return explicit && explicit.length > 0 ? explicit : join(homedir(), '.dsh')
}

export function profilesDirectory(dshHome: string): string {
  return join(dshHome, 'profiles')
}

export function logsDirectory(dshHome: string): string {
  return join(dshHome, 'logs')
}

/**
 * 列出 DSH home 下的全部 profile 名。
 * profiles/ 不存在时返回空数组（机器上尚未安装任何 profile）。
 */
export async function listProfiles(dshHome: string): Promise<string[]> {
  const directory = profilesDirectory(dshHome)
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const profiles: string[] = []
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const profilePath = join(directory, entry)
    const metadata = await lstat(profilePath)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue
    // profiles/node_modules is DSH's shared Host peer fallback, not a profile.
    // A real DSH profile is anchored by its package.json; requiring the marker
    // also avoids treating arbitrary/cache directories as service targets.
    let manifest
    try { manifest = await lstat(join(profilePath, 'package.json')) } catch { continue }
    if (manifest.isFile() && !manifest.isSymbolicLink()) profiles.push(entry)
  }
  return profiles.sort()
}

export interface ProfilePlugin {
  /** node_modules/@dsh-enhanced 下的包名，含 scope。 */
  name: string
  /** local = 指向 checkout 的符号链接；npm = 实体副本。 */
  kind: 'npm' | 'local'
  /** local 形态下符号链接指向的绝对路径（checkout 内的包目录）。 */
  linkTarget?: string
}

/**
 * 枚举一个 profile 中安装的 @dsh-enhanced 插件及其安装形态。
 * 符号链接（pnpm link / dsh plugin add <checkout>）判定为 local；
 * 实体目录判定为 npm cohort 副本。
 */
export async function listProfilePlugins(dshHome: string, profile: string): Promise<ProfilePlugin[]> {
  const scopeDirectory = join(profilesDirectory(dshHome), profile, 'node_modules', '@dsh-enhanced')
  let entries: string[]
  try {
    entries = await readdir(scopeDirectory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const plugins: ProfilePlugin[] = []
  for (const entry of entries) {
    if (entry.startsWith('.') || entry.startsWith('@')) continue
    const pluginPath = join(scopeDirectory, entry)
    const metadata = await lstat(pluginPath)
    const name = `@dsh-enhanced/${entry}`
    if (metadata.isSymbolicLink()) {
      const target = await readlink(pluginPath)
      plugins.push({
        name,
        kind: 'local',
        linkTarget: target.startsWith('/') ? target : join(scopeDirectory, target),
      })
    } else if (metadata.isDirectory()) {
      plugins.push({ name, kind: 'npm' })
    }
  }
  return plugins.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 汇总一批 profile 中 local 形态解析出的 checkout 包路径。
 * purge 绝不删除这些路径，只在报告中提示用户自行处理 checkout 源码。
 */
export function collectLocalCheckouts(plugins: readonly ProfilePlugin[]): string[] {
  const targets = new Set<string>()
  for (const plugin of plugins) {
    if (plugin.kind === 'local' && plugin.linkTarget !== undefined) targets.add(plugin.linkTarget)
  }
  return [...targets].sort()
}

/**
 * home 之外/同级的生命周期残留：
 *  - `${home}.dsh-enhanced-transaction` 及 `.failed-<profile>-*` 失败诊断目录
 *  - `${home}.dsh-enhanced-lifecycle.lock`
 *  - `/tmp/.dsh-enhanced-lifecycle-<uid>-<sha256(home)>.lock` rendezvous 锁
 * 后两者按精确名直接判断；事务/诊断目录在父目录中按前缀枚举。
 */
export async function listLifecycleResiduals(
  dshHome: string,
  parentEntries: readonly string[],
  tmpEntries: readonly string[] = [],
  uid: number = process.getuid?.() ?? Number.NaN,
): Promise<string[]> {
  const residuals = new Set<string>()
  const homeBase = basename(dshHome)
  const transactionPrefix = `${homeBase}${TRANSACTION_SUFFIX}`
  for (const entry of parentEntries) {
    if (entry === transactionPrefix || entry.startsWith(`${transactionPrefix}.failed-`)) {
      residuals.add(join(parentOf(dshHome), entry))
    }
    if (entry === `${homeBase}${HOME_LOCK_SUFFIX}`) {
      residuals.add(join(parentOf(dshHome), entry))
    }
  }
  if (Number.isFinite(uid)) {
    const rendezvous = `.dsh-enhanced-lifecycle-${uid}-${createHash('sha256').update(dshHome).digest('hex')}.lock`
    if (tmpEntries.includes(rendezvous)) residuals.add(join('/tmp', rendezvous))
  }
  return [...residuals].sort()
}

function parentOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

/** 一个 profile 对应的受管日志文件（stdout/stderr）。 */
export function profileLogPaths(dshHome: string, profile: string): string[] {
  return [
    join(logsDirectory(dshHome), `${profile}-host.log`),
    join(logsDirectory(dshHome), `${profile}-host.error.log`),
  ]
}

/** macOS LaunchAgent label / plist 路径（与 launchd.ts launchAgentPaths 对齐）。 */
export function launchAgentTargets(home: string, profile: string): { label: string; plistPath: string } {
  const label = `${LAUNCHD_LABEL_PREFIX}${profile}`
  return { label, plistPath: join(home, 'Library', 'LaunchAgents', `${label}.plist`) }
}

/** Linux systemd --user unit 名。 */
export function systemdUnitName(profile: string): string {
  return `dsh-profile-${profile}.service`
}

export function systemdUserDirectory(home: string): string {
  return join(home, '.config', 'systemd', 'user')
}

/** 备份包默认落点：~（HOME）下 dsh-purge-backup-<UTC 时间戳>.tar.gz。 */
export function backupArchivePath(home: string, stamp: string): string {
  return join(home, `dsh-purge-backup-${stamp}.tar.gz`)
}
