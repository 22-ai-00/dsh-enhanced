import { readFile, rm, stat } from 'node:fs/promises'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { CommandRunner } from './run.ts'
import { defaultRunner } from './run.ts'
import {
  launchAgentTargets,
  listProfiles,
  profileLogPaths,
  systemdUnitName,
  systemdUserDirectory,
  SYSTEMD_UNIT_PATTERN,
} from './paths.ts'

/** 受管 unit / plist 的内容指纹（lifecycle-profile.mjs rendererUnitPattern 与 launchd.ts createLaunchAgent）。 */
const MANAGED_UNIT_MARKER = 'DeepSeek Harness profile'

/** 判定一个 systemd unit 文件确为 dsh-enhanced 安装器渲染的受管 unit（lifecycle-profile.mjs rendererUnitPattern）。 */
async function isManagedUnitFile(path: string, profile: string): Promise<boolean> {
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch {
    return false
  }
  return source.includes(MANAGED_UNIT_MARKER)
    && source.includes(`--profile ${profile} `)
    && source.includes('--no-open')
}

/**
 * 判定 macOS plist 确为受管 LaunchAgent。
 *
 * launchd.ts 的 createLaunchAgent 不写入任何注释标记，所以判定依据是它实际渲染
 * 的结构：Label 必须是受管前缀加该 profile，且 ProgramArguments 含
 * `--profile <profile>` 与 `--no-open` 两项。这与 stopManagedService 对 systemd
 * unit 的判定同样严格，避免把同名的用户自建 LaunchAgent 当成受管服务操作。
 */
async function isManagedPlistFile(path: string, profile: string): Promise<boolean> {
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch {
    return false
  }
  const { label } = launchAgentTargets('', profile)
  return source.includes(`<string>${label}</string>`)
    && source.includes('<string>--profile</string>')
    && source.includes(`<string>${profile}</string>`)
    && source.includes('<string>--no-open</string>')
}

export interface ServiceStopOutcome {
  profile: string
  /** 已执行/计划执行的动作（dry-run 下同样填充，供报告展示）。 */
  actions: string[]
  /** 归属不明而跳过、需要人工确认的文件（fail-closed）。 */
  skipped: string[]
  errors: string[]
}

/**
 * 停用并注销一个 profile 的受管常驻服务。
 * macOS：launchctl bootout + 删 ~/Library/LaunchAgents/<label>.plist。
 * Linux：systemctl --user disable --now + reset-failed + 删受管 unit（及同名 .d）+ daemon-reload。
 * 服务未注册/已停止不报错；任何非预期文件归属问题 fail-closed 只报告不删除。
 */
export async function stopManagedService(
  platform: NodeJS.Platform,
  home: string,
  profile: string,
  runner: CommandRunner,
  dryRun: boolean,
): Promise<ServiceStopOutcome> {
  const outcome: ServiceStopOutcome = { profile, actions: [], skipped: [], errors: [] }
  if (platform === 'darwin') {
    const { label, plistPath } = launchAgentTargets(home, profile)
    const target = `gui/${process.getuid?.() ?? process.env.UID}/${label}`
    outcome.actions.push(`launchctl bootout ${target}（未注册时忽略错误）`)
    outcome.actions.push(`删除 ${plistPath}`)
    if (dryRun) return outcome
    // bootout 对未加载 label 返回非零（No such process），属预期。
    runner('launchctl', ['bootout', target])
    await rm(plistPath, { force: true })
    return outcome
  }

  const unit = systemdUnitName(profile)
  if (!SYSTEMD_UNIT_PATTERN.test(unit)) {
    outcome.errors.push(`非法 profile 名，跳过服务注销：${profile}`)
    return outcome
  }
  const unitDirectory = systemdUserDirectory(home)
  const fragmentPath = join(unitDirectory, unit)
  const dropInPath = join(unitDirectory, `${unit}.d`)

  let managed = false
  try {
    await readFile(fragmentPath, 'utf8').then(
      source => {
        managed = source.includes(MANAGED_UNIT_MARKER)
          && source.includes(`--profile ${profile} `)
          && source.includes('--no-open')
      },
      () => { managed = false },
    )
  } catch {
    managed = false
  }

  outcome.actions.push(`systemctl --user disable --now ${unit}（未注册时忽略错误）`)
  outcome.actions.push(`systemctl --user reset-failed ${unit}`)

  if (!managed) {
    // 文件名虽匹配，但内容不是受管 unit（可能不存在或被人手工改写）：不删文件。
    const checked = await isManagedUnitFile(fragmentPath, profile)
    if (!checked) outcome.skipped.push(`${fragmentPath}（内容非受管 unit 或不存在，保留）`)
  } else {
    outcome.actions.push(`删除受管 unit 文件 ${fragmentPath}`)
  }

  if (!dryRun) {
    runner('systemctl', ['--user', 'disable', '--now', unit])
    runner('systemctl', ['--user', 'reset-failed', unit])
    if (managed) {
      await rm(fragmentPath, { force: true })
      await rm(dropInPath, { recursive: true, force: true })
    }
    runner('systemctl', ['--user', 'daemon-reload'])
  }
  outcome.actions.push('systemctl --user daemon-reload')
  return outcome
}

// ---------------------------------------------------------------------------
// 日常运维：start / stop / restart
//
// 与 stopManagedService 的分工是刻意的：那一个属于 purge，会注销并删除 unit /
// plist；下面这些只改变「运行状态」，绝不新建、改写或删除任何服务定义文件。
// 因此它们都要求服务已由安装器注册过，未注册时给出明确指引而不是顺手装一个。
// ---------------------------------------------------------------------------

/** 一次运维动作的结果。exit 供 CLI 决定退出码。 */
export interface ServiceActionOutcome {
  profile: string
  /** 实际执行（或 dry-run 下计划执行）的命令描述。 */
  actions: string[]
  /** 面向用户的结论行。 */
  messages: string[]
  errors: string[]
}

export type ServiceAction = 'start' | 'stop' | 'restart'

const ACTION_LABEL: Record<ServiceAction, string> = {
  start: '启动',
  stop: '停止',
  restart: '重启',
}

/**
 * 结论措辞：dry-run 只是计划，必须说「将…」，只有真正执行过才说「已…」。
 * 全部结论行都经由此函数，避免某个分支把计划报告成既成事实。
 */
function actionResult(profile: string, action: ServiceAction, dryRun: boolean, suffix = ''): string {
  return `${profile}：${dryRun ? '将' : '已'}${ACTION_LABEL[action]}${suffix}`
}

/** 受管服务的注册与运行状态，以及未注册时的成因判定。 */
export interface ManagedServiceProcessIds {
  pids: number[]
  errors: string[]
}

/**
 * Return only the exact MainPID owned by an installer-managed Linux user unit.
 * Other processes with the same --profile remain external and must block lifecycle work.
 */
export async function managedServiceProcessIds(
  platform: NodeJS.Platform,
  home: string,
  profiles: readonly string[],
  runner: CommandRunner = defaultRunner,
): Promise<ManagedServiceProcessIds> {
  const pids: number[] = []
  const errors: string[] = []
  if (platform !== 'linux') return { pids, errors }
  for (const profile of profiles) {
    const presence = await inspectManagedService(platform, home, profile)
    if (!presence.managed) continue
    const unit = systemdUnitName(profile)
    const result = runner('systemctl', ['--user', 'show', unit, '--property', 'MainPID', '--value'])
    if (result.status !== 0) {
      errors.push(`${profile}：无法读取受管服务 MainPID：${result.stderr.trim() || `systemctl 退出码 ${result.status}`}`)
      continue
    }
    const pid = Number(result.stdout.trim())
    if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid)
  }
  return { pids: [...new Set(pids)], errors }
}

export interface ManagedServicePresence {
  /** 服务定义文件存在且内容确属受管。 */
  managed: boolean
  /** 定义文件路径（无论是否受管）。 */
  definitionPath: string
  /** 文件存在但内容不属受管（人工改写或同名占用）。 */
  foreign: boolean
}

/**
 * 检查一个 profile 的受管服务定义是否就绪。
 * 只读文件系统，不执行 systemctl / launchctl。
 */
export async function inspectManagedService(
  platform: NodeJS.Platform,
  home: string,
  profile: string,
): Promise<ManagedServicePresence> {
  if (platform === 'darwin') {
    const { plistPath } = launchAgentTargets(home, profile)
    const managed = await isManagedPlistFile(plistPath, profile)
    let exists = true
    try {
      await stat(plistPath)
    } catch {
      exists = false
    }
    return { managed, definitionPath: plistPath, foreign: exists && !managed }
  }
  const unit = systemdUnitName(profile)
  const definitionPath = join(systemdUserDirectory(home), unit)
  const managed = await isManagedUnitFile(definitionPath, profile)
  let exists = true
  try {
    await stat(definitionPath)
  } catch {
    exists = false
  }
  return { managed, definitionPath, foreign: exists && !managed }
}

/**
 * 对一个已注册的受管服务执行 start / stop / restart。
 *
 * 前置条件是服务定义文件已存在且确属受管：这个命令只切换运行状态，不承担安装
 * 职责，未注册时返回可复制的 dsh-rsi install 指引而不是隐式注册一个
 * 服务——隐式注册会绕过安装器的归属、路径与凭据校验。
 *
 * macOS 用 `launchctl kickstart -k`（重启）/ `kickstart`（启动）/ `bootout`（停止）；
 * 停止后 plist 仍在，所以随后可以再 start，这与 purge 的 bootout+删文件不同。
 * Linux 直接用 `systemctl --user start|stop|restart`。
 */
export async function controlManagedService(
  platform: NodeJS.Platform,
  home: string,
  profile: string,
  action: ServiceAction,
  runner: CommandRunner = defaultRunner,
  dryRun = false,
): Promise<ServiceActionOutcome> {
  const outcome: ServiceActionOutcome = { profile, actions: [], messages: [], errors: [] }
  const label = ACTION_LABEL[action]

  if (platform !== 'darwin' && platform !== 'linux') {
    outcome.errors.push(`${profile}：当前平台 ${platform} 没有受管常驻服务（仅 macOS launchd 与 Linux systemd --user）`)
    return outcome
  }

  const presence = await inspectManagedService(platform, home, profile)
  if (!presence.managed) {
    outcome.errors.push(presence.foreign
      ? `${profile}：${presence.definitionPath} 存在但不是 dsh-enhanced 受管服务，已拒绝操作（请人工确认该文件归属）`
      : `${profile}：尚未安装常驻服务（${presence.definitionPath} 不存在）。core/web 场景默认只提供按需启动的 Web/direct 能力，这是正常状态；如需 start/restart，请安装常驻场景：\n`
        + `  dsh-rsi install --profile ${profile} --scenario lark\n`
        + `或安装分级自治成长：\n`
        + `  dsh-rsi install --profile ${profile} --scenario supervised\n`
        + '安装完成前无需反复执行 start/restart。')
    return outcome
  }

  if (platform === 'darwin') {
    const { label: agentLabel, plistPath } = launchAgentTargets(home, profile)
    const domain = `gui/${process.getuid?.() ?? process.env.UID}`
    const target = `${domain}/${agentLabel}`
    if (action === 'stop') {
      outcome.actions.push(`launchctl bootout ${target}`)
      if (!dryRun) {
        const result = runner('launchctl', ['bootout', target])
        // 未加载时 bootout 返回非零（No such process），对 stop 语义等价于已停止。
        if (result.status !== 0 && !/No such process|not find/iu.test(`${result.stderr}${result.stdout}`)) {
          outcome.errors.push(`${profile}：${label}失败：${result.stderr.trim() || `launchctl 退出码 ${result.status}`}`)
          return outcome
        }
      }
      outcome.messages.push(actionResult(profile, action, dryRun, `（plist 保留在 ${plistPath}，可再次 start）`))
      return outcome
    }
    // start / restart：plist 可能尚未 bootstrap（曾被 stop），先确保已载入再 kickstart。
    outcome.actions.push(`launchctl bootstrap ${domain} ${plistPath}（已载入时忽略错误）`)
    outcome.actions.push(`launchctl kickstart ${action === 'restart' ? '-k ' : ''}${target}`)
    if (!dryRun) {
      runner('launchctl', ['bootstrap', domain, plistPath])
      const kickstartArgs = action === 'restart' ? ['kickstart', '-k', target] : ['kickstart', target]
      const result = runner('launchctl', kickstartArgs)
      if (result.status !== 0) {
        outcome.errors.push(`${profile}：${label}失败：${result.stderr.trim() || `launchctl 退出码 ${result.status}`}`)
        return outcome
      }
    }
    outcome.messages.push(actionResult(profile, action, dryRun))
    return outcome
  }

  const unit = systemdUnitName(profile)
  if (!SYSTEMD_UNIT_PATTERN.test(unit)) {
    outcome.errors.push(`非法 profile 名，拒绝操作：${profile}`)
    return outcome
  }
  outcome.actions.push(`systemctl --user ${action} ${unit}`)
  if (!dryRun) {
    const result = runner('systemctl', ['--user', action, unit])
    if (result.status !== 0) {
      outcome.errors.push(`${profile}：${label}失败：${result.stderr.trim() || `systemctl 退出码 ${result.status}`}`)
      return outcome
    }
  }
  outcome.messages.push(actionResult(profile, action, dryRun))
  return outcome
}

/**
 * 解析运维命令的目标 profile 集合。
 * 显式 --profile 优先；否则取 DSH home 下全部 profile。
 */
export async function resolveTargetProfiles(dshHome: string, profile?: string): Promise<string[]> {
  if (profile !== undefined) return [profile]
  return await listProfiles(dshHome)
}

// ---------------------------------------------------------------------------
// 日志查看
// ---------------------------------------------------------------------------

/** 单个日志文件的尾部读取结果。 */
export interface LogTail {
  path: string
  /** 文件不存在或为空时为 true，lines 为空。 */
  empty: boolean
  lines: string[]
  /** 文件总字节数，供用户判断是否被截断。 */
  bytes: number
}

/** 读取单个日志文件的末尾 N 行，只读末尾有界字节，避免把大日志整体载入内存。 */
export async function tailLogFile(path: string, lines: number, maxBytes = 1024 * 1024): Promise<LogTail> {
  let metadata
  try {
    metadata = await stat(path)
  } catch {
    return { path, empty: true, lines: [], bytes: 0 }
  }
  if (!metadata.isFile() || metadata.size === 0) {
    return { path, empty: true, lines: [], bytes: metadata.size }
  }
  const length = Math.min(metadata.size, maxBytes)
  const buffer = Buffer.alloc(length)
  const file = await open(path, 'r')
  try {
    await file.read(buffer, 0, length, metadata.size - length)
  } finally {
    await file.close()
  }
  const text = buffer.toString('utf8')
  // 从中间截断时首行可能是残行，丢弃它以免呈现半行内容。
  const all = text.split('\n')
  if (length < metadata.size && all.length > 1) all.shift()
  const trimmed = all[all.length - 1] === '' ? all.slice(0, -1) : all
  return {
    path,
    empty: trimmed.length === 0,
    lines: trimmed.slice(-lines),
    bytes: metadata.size,
  }
}

export interface ProfileLogs {
  profile: string
  tails: LogTail[]
}

/**
 * 读取若干 profile 的受管 stdout/stderr 日志尾部。
 * `errorOnly` 只取 *-host.error.log。
 */
export async function collectLogs(
  dshHome: string,
  profiles: readonly string[],
  lines: number,
  errorOnly: boolean,
): Promise<ProfileLogs[]> {
  const collected: ProfileLogs[] = []
  for (const profile of profiles) {
    const paths = profileLogPaths(dshHome, profile)
    const selected = errorOnly ? paths.filter(path => path.endsWith('.error.log')) : paths
    const tails: LogTail[] = []
    for (const path of selected) tails.push(await tailLogFile(path, lines))
    collected.push({ profile, tails })
  }
  return collected
}

export function formatLogs(collected: readonly ProfileLogs[], lines: number): string {
  if (collected.length === 0) return '日志：未找到任何 profile。'
  const out: string[] = []
  for (const entry of collected) {
    for (const tail of entry.tails) {
      out.push(`==> ${tail.path}${tail.empty ? '（无内容）' : `（末 ${tail.lines.length} 行 / 共 ${tail.bytes} 字节）`}`)
      for (const line of tail.lines) out.push(line)
      out.push('')
    }
  }
  const body = out.join('\n').trimEnd()
  return body.length > 0 ? body : `日志：无内容（已按末 ${lines} 行读取）。`
}

export function formatServiceOutcomes(
  outcomes: readonly ServiceActionOutcome[],
  action: ServiceAction,
  dryRun: boolean,
): string {
  const lines: string[] = []
  if (dryRun) lines.push(`【dry-run】以下是 ${ACTION_LABEL[action]} 将执行的动作，未做任何修改：`)
  for (const outcome of outcomes) {
    if (dryRun) for (const item of outcome.actions) lines.push(`  ${outcome.profile}: ${item}`)
    for (const message of outcome.messages) lines.push(message)
    for (const error of outcome.errors) lines.push(`! ${error}`)
  }
  if (lines.length === 0) lines.push(`${ACTION_LABEL[action]}：没有匹配的 profile。`)
  return lines.join('\n')
}
