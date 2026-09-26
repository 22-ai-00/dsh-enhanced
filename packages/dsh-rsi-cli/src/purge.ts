import { readdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createHomeBackup, verifyBackup } from './backup.ts'
import {
  backupArchivePath,
  collectLocalCheckouts,
  listLifecycleResiduals,
  listProfiles,
  listProfilePlugins,
  profileLogPaths,
  HOME_LOCK_SUFFIX,
  TRANSACTION_SUFFIX,
} from './paths.ts'
import { deleteCredentialLocator, scanCredentialLocators } from './secrets.ts'
import { findRunningProfiles, defaultRunner, type CommandRunner } from './run.ts'
import { stopManagedService } from './services.ts'
import { scanRunningProfiles, terminatePids } from './process-guard.ts'

export class PurgeError extends Error {}

export interface PurgeOptions {
  dshHome: string
  /** 用户 HOME：LaunchAgent/systemd unit、备份归档的落点基准。 */
  home: string
  platform?: NodeJS.Platform
  /** 指定单 profile；省略表示全量清除整个 DSH home。 */
  profile?: string
  backup: boolean
  keepKeychain: boolean
  removeHost: boolean
  dryRun: boolean
  /** UTC 时间戳生成器（测试可注入）。 */
  stamp?: () => string
  runner?: CommandRunner
  /** --yes：自动终止已证明归属本 DSH home 的残留进程；否则仅报告并要求显式确认。 */
  assumeYes?: boolean
}

export interface PurgeReport {
  scope: 'full' | 'profile'
  profiles: string[]
  serviceProfiles: string[]
  backup?: { archivePath: string; bytes: number }
  removedPaths: string[]
  removedCredentials: string[]
  credentialErrors: string[]
  skippedServiceFiles: string[]
  serviceErrors: string[]
  keptCheckouts: string[]
  hostRemoved: boolean
  hostPrefix?: string
  dryRun: boolean
  /** 停服后残留进程的处理结果（proven 终止 / foreign 拒绝）。 */
  terminatedPids: number[]
  failedPids: number[]
  foreignProcesses: string[]
}

function utcStamp(): string {
  return new Date().toISOString().replaceAll(/[-:.]/gu, '').replace(/\.\d{3}Z$/u, 'Z')
}

async function listDirectoryOrEmpty(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/**
 * 彻底卸载（purge）编排：
 *  1. 进程静止检查（活动 host 拒绝执行，不代用户 kill）
 *  2. 停用并注销受管常驻服务（fail-closed：停服失败则不进入删除阶段）
 *  3. tar.gz 备份整个 DSH home（默认开启）
 *  4. 删除 profile/整个 home 及生命周期残留
 *  5. 清理外部凭据库条目（--keep-keychain 保留）
 *  6. 可选卸载全局 @deepseek-ai/dsh host（仅全量模式允许）
 *
 * local checkout 形态：只随 profile 目录移除其中的符号链接，checkout 源码绝不动。
 */
export async function runPurge(options: PurgeOptions): Promise<PurgeReport> {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new PurgeError(`dsh-rsi purge 仅支持 macOS 与 Linux，当前平台：${platform}`)
  }
  if (options.profile !== undefined && options.removeHost) {
    throw new PurgeError('--remove-host 只能在全量 purge（不指定 --profile）时使用，避免影响其它 profile 的全局 host')
  }
  const runner = options.runner ?? defaultRunner

  const allProfiles = await listProfiles(options.dshHome)
  const scope = options.profile === undefined ? 'full' : 'profile'
  if (scope === 'profile' && !allProfiles.includes(options.profile!)) {
    throw new PurgeError(`profile 不存在：${options.profile}（DSH home：${options.dshHome}）`)
  }
  const targetProfiles = scope === 'full' ? allProfiles : [options.profile!]

  // 1. 先停用并注销受管常驻服务（fail-closed：停服失败则不进入删除阶段）。
  //    受管 host 是「本应自动停掉」的进程，旧逻辑把它和临时进程一起当成阻塞，
  //    导致用户明明可以自动停服却被卡在入口。
  const skippedServiceFiles: string[] = []
  const serviceErrors: string[] = []
  for (const profile of targetProfiles) {
    const outcome = await stopManagedService(platform, options.home, profile, runner, options.dryRun)
    skippedServiceFiles.push(...outcome.skipped)
    for (const message of outcome.errors) serviceErrors.push(`[${profile}] ${message}`)
  }
  if (serviceErrors.length > 0) throw new PurgeError(`受管服务停用失败，已中止（未删除任何数据）：\n${serviceErrors.join('\n')}`)

  // 2. 停服后复检残留进程。受管 host 此时应已消失；剩下的要么是可证明归属本 home
  //    的临时 dsh/plugin 命令（proven，可终止），要么是无法证明归属的进程（foreign，
  //    fail-closed，绝不自动杀）。
  const guard = await scanRunningProfiles(options.dshHome, targetProfiles, runner)
  if (guard.error !== undefined) {
    throw new PurgeError(`无法检查运行中的 profile 进程：${guard.error}`)
  }
  const foreign = guard.processes.filter(p => p.owner === 'foreign')
  const proven = guard.processes.filter(p => p.owner === 'proven')
  const foreignListing = foreign.map(p => `  PID ${p.pid}: ${p.commandLine}\n    ${p.evidence.join('\n    ')}`).join('\n')
  if (foreign.length > 0) {
    throw new PurgeError(`发现无法证明归属本 DSH home 的进程，为避免误杀已中止（请手工确认后再 purge）：\n${foreignListing}`)
  }

  const terminatedPids: number[] = []
  const failedPids: number[] = []
  if (proven.length > 0) {
    const listing = proven.map(p => `  PID ${p.pid}: ${p.commandLine}\n    ${p.evidence.join('\n    ')}`).join('\n')
    if (options.dryRun) {
      // dry-run 只列出，不终止。
    } else if (options.assumeYes) {
      const outcome = await terminatePids(proven.map(p => p.pid), runner)
      if (outcome.failed.length > 0) {
        throw new PurgeError(`以下残留进程未能安全终止（身份已变化或 KILL 后仍在），已中止：${outcome.failed.join(', ')}\n${listing}`)
      }
      terminatedPids.push(...proven.map(p => p.pid))
    } else {
      throw new PurgeError(
        `发现以下指向本 DSH home 的残留进程（可能是正在执行的 dsh plugin 操作）。` +
        `purge 将删除它们正在使用的目录，请先确认其已结束，或加 --yes 自动终止：\n${listing}`,
      )
    }
  }

  // 兼容旧的整体静止检查：在进程守卫之外再做一次 pgrep 汇总（无 proven/foreign 区分时用）。
  const { active, error } = findRunningProfiles(targetProfiles, runner)
  if (error !== undefined) throw new PurgeError(`无法检查运行中的 profile 进程：${error}`)
  if (active.length > 0 && proven.length === 0 && foreign.length === 0) {
    const listing = active.map(process_ => `  PID ${process_.pid}: ${process_.commandLine}`).join('\n')
    throw new PurgeError(`以下 profile host 仍在运行，请先停用服务后再 purge（不代你结束进程）：\n${listing}`)
  }

  const report: PurgeReport = {
    scope,
    profiles: targetProfiles,
    serviceProfiles: targetProfiles,
    removedPaths: [],
    removedCredentials: [],
    credentialErrors: [],
    skippedServiceFiles,
    serviceErrors,
    keptCheckouts: [],
    hostRemoved: false,
    dryRun: options.dryRun,
    terminatedPids,
    failedPids,
    foreignProcesses: foreign.map(p => p.commandLine),
  }

  // 3. 备份（单 profile 也备份整个 home：其中包含该 profile 全部数据与凭据落盘）
  if (options.backup) {
    const stamp = options.stamp?.() ?? utcStamp()
    const archivePath = backupArchivePath(options.home, stamp)
    if (!options.dryRun) {
      createHomeBackup(options.dshHome, archivePath, runner)
      const bytes = await verifyBackup(archivePath)
      report.backup = { archivePath, bytes }
    } else {
      report.backup = { archivePath, bytes: 0 }
    }
  }

  // 4. 外部凭据库条目必须在删除文件前扫描（journal 位于 DSH home 内）。
  const locators = options.keepKeychain
    ? []
    : await scanCredentialLocators(options.dshHome, scope === 'full' ? undefined : [options.profile!])

  // 5. 删除文件
  if (scope === 'full') {
    // 收集 local checkout（删除前读取符号链接，仅用于报告）
    for (const profile of allProfiles) {
      const plugins = await listProfilePlugins(options.dshHome, profile)
      report.keptCheckouts.push(...collectLocalCheckouts(plugins))
    }
    report.keptCheckouts = [...new Set(report.keptCheckouts)].sort()

    const parentEntries = await listDirectoryOrEmpty(dirname(options.dshHome))
    const tmpEntries = await listDirectoryOrEmpty('/tmp').catch(() => [])
    const residuals = await listLifecycleResiduals(options.dshHome, parentEntries, tmpEntries)
    const targets = [options.dshHome, ...residuals]
    report.removedPaths.push(...targets)
    if (!options.dryRun) {
      for (const target of targets) await rm(target, { recursive: true, force: true })
    }
  } else {
    const profilePath = join(options.dshHome, 'profiles', options.profile!)
    const plugins = await listProfilePlugins(options.dshHome, options.profile!)
    report.keptCheckouts = collectLocalCheckouts(plugins)
    const targets = [profilePath, ...profileLogPaths(options.dshHome, options.profile!)]
    // 单 profile 只清理归属它的失败诊断目录；事务目录可能涉及多 profile，不动。
    const parentEntries = await listDirectoryOrEmpty(dirname(options.dshHome))
    const failedPrefix = `${basename(options.dshHome)}${TRANSACTION_SUFFIX}.failed-${options.profile!}-`
    for (const entry of parentEntries) {
      if (entry.startsWith(failedPrefix)) targets.push(join(dirname(options.dshHome), entry))
    }
    report.removedPaths.push(...targets)
    if (!options.dryRun) {
      for (const target of targets) await rm(target, { recursive: true, force: true })
    }
  }

  // 删除后再执行外部凭据库清理（journal 已随备份保存；条目以预先扫描的 locators 为准）。
  for (const locator of locators) {
    const label = `${locator.provider}:${locator.service} (account=${locator.account})`
    if (options.dryRun) {
      report.removedCredentials.push(label)
      continue
    }
    const result = deleteCredentialLocator(locator, runner)
    if (result.ok) report.removedCredentials.push(label)
    else report.credentialErrors.push(`${label}: ${result.detail ?? '删除失败'}`)
  }

  if (report.credentialErrors.length > 0) {
    throw new PurgeError(`文件已删除，但以下凭据条目清理失败，请手工删除：\n${report.credentialErrors.join('\n')}`)
  }

  // 6. 全局 host
  if (options.removeHost) {
    const prefixResult = runner('npm', ['prefix', '-g'])
    report.hostPrefix = prefixResult.stdout.trim() || prefixResult.stderr.trim()
    report.hostRemoved = true
    if (!options.dryRun) {
      const uninstall = runner('npm', ['uninstall', '-g', '@deepseek-ai/dsh'])
      if (uninstall.status !== 0) {
        throw new PurgeError(`卸载全局 @deepseek-ai/dsh 失败（前缀 ${report.hostPrefix}）：${uninstall.stderr.trim()}`)
      }
    }
  }

  return report
}

/** 仅用于外部模块需要时引用（保持路径常量单一来源）。 */
export { HOME_LOCK_SUFFIX, TRANSACTION_SUFFIX }
