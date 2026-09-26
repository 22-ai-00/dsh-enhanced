import type { CommandRunner } from './run.ts'
import { defaultRunner } from './run.ts'
import { inspectManagedService, tailLogFile } from './services.ts'
import { profileLogPaths, systemdUnitName, SYSTEMD_UNIT_PATTERN } from './paths.ts'

/**
 * Web URL：从运行中受管服务的 journal / host 日志中解析最新一次 `dsh web:` 行，
 * 返回带 token 的完整授权 URL。绝不关闭或绕过 Web 认证——这里只是把 DSH 已经打印
 * 在日志里的同一行 URL 取出来，免去用户翻 journal / 猜 token。
 */

/**
 * 从一段文本中提取最新一次 `dsh web: http://host:PORT/?token=...` 完整 URL。
 * DSH 每次启动都会打印这一行；取最后一个匹配是为了拿到最近一次重启后的 token
 * （token 随重启变化）。没有匹配时返回 undefined。
 *
 * 纯函数、不读文件、不执行命令，便于单元测试覆盖正常 / 缺 token / 多行场景。
 */
export function extractWebUrlFromText(text: string): string | undefined {
  const matches = text.match(/dsh web:\s*https?:\/\/[^\s]+/g)
  if (matches === null || matches.length === 0) return undefined
  const last = matches[matches.length - 1]!
  const captured = /dsh web:\s*(https?:\/\/[^\s]+)/u.exec(last)
  return captured?.[1]
}

export interface ProfileWebUrl {
  profile: string
  /** 解析到的最新完整授权 URL（含 token）；未找到时 undefined。 */
  url?: string
  /** 来源描述：journal / host log 路径。 */
  source?: string
  /** 服务未注册 / 未运行 / 日志中尚无 URL 等面向用户的提示（非错误）。 */
  notice?: string
  errors: string[]
}

/** 单次最多回看的日志行数，足够覆盖最近一次启动输出，又不会把整个 journal 读进来。 */
const WEB_URL_LOOKBACK_LINES = 400

/**
 * 解析一个 profile 受管服务当前有效的 Web 授权 URL。
 *
 * - Linux systemd --user：`journalctl --user -u dsh-profile-<profile>.service --output=cat -n N`
 * - macOS launchd：读 `$DSH_HOME/logs/<profile>-host.log` 尾部
 *
 * 服务未注册时给出与 start/stop 一致的指引；服务未运行时明确提示先 start。
 * 即使服务当前未运行，只要日志里还有历史 URL，也会返回并标注其可能已随重启失效。
 */
export async function resolveManagedWebUrl(
  platform: NodeJS.Platform,
  home: string,
  dshHome: string,
  profile: string,
  runner: CommandRunner = defaultRunner,
): Promise<ProfileWebUrl> {
  const result: ProfileWebUrl = { profile, errors: [] }
  const presence = await inspectManagedService(platform, home, profile)
  if (!presence.managed) {
    result.notice = presence.foreign
      ? `${profile}：${presence.definitionPath} 存在但不是 dsh-enhanced 受管服务，拒绝读取。`
      : `${profile}：尚未注册常驻服务（core/web 场景按需启动）。请运行 dsh --profile ${profile} 后使用其输出中带 token 的完整 URL；如需常驻服务，先安装 lark/supervised 场景。`
    return result
  }

  let text = ''
  if (platform === 'linux') {
    const unit = systemdUnitName(profile)
    if (!SYSTEMD_UNIT_PATTERN.test(unit)) {
      result.errors.push(`${profile}：非法 profile 名。`)
      return result
    }
    const active = runner('systemctl', ['--user', 'is-active', unit])
    const activeValue = active.stdout.trim()
    const journal = runner('journalctl', ['--user', '-u', unit, '--output=cat', '-n', String(WEB_URL_LOOKBACK_LINES)])
    if (journal.status !== 0) {
      result.errors.push(`${profile}：无法读取 journal：${journal.stderr.trim() || `journalctl 退出码 ${journal.status}`}`)
      return result
    }
    text = journal.stdout
    result.source = `journalctl --user -u ${unit}`
    if (activeValue !== 'active') {
      result.notice = `${profile}：受管服务当前状态为「${activeValue || 'unknown'}」，先运行 dsh-rsi start --profile ${profile}；下面是日志中最近一次的 URL，重启后会变化。`
    }
  } else if (platform === 'darwin') {
    const [stdoutLog] = profileLogPaths(dshHome, profile)
    if (stdoutLog === undefined) {
      result.errors.push(`${profile}：无法解析 host 日志路径。`)
      return result
    }
    const tail = await tailLogFile(stdoutLog, WEB_URL_LOOKBACK_LINES)
    text = tail.lines.join('\n')
    result.source = stdoutLog
    if (tail.empty) {
      result.notice = `${profile}：日志 ${stdoutLog} 为空；先运行 dsh-rsi start --profile ${profile} 或直接 dsh --profile ${profile}。`
      return result
    }
  } else {
    result.errors.push(`${profile}：当前平台 ${platform} 没有受管常驻服务。`)
    return result
  }

  const url = extractWebUrlFromText(text)
  if (url !== undefined) {
    result.url = url
  } else {
    result.notice = (result.notice ? `${result.notice} ` : '')
      + `${profile}：在最近 ${WEB_URL_LOOKBACK_LINES} 行日志中未找到 \`dsh web:\` 行；服务可能仍在启动，稍后重试或运行 dsh-rsi logs --profile ${profile}。`
  }
  return result
}

export function formatWebUrlResult(entries: readonly ProfileWebUrl[]): string {
  const lines: string[] = []
  for (const entry of entries) {
    if (entry.url !== undefined) {
      lines.push(`${entry.profile}：${entry.url}`)
      lines.push(`  来源：${entry.source}`)
    }
    if (entry.notice !== undefined) lines.push(`${entry.profile}：${entry.notice}`)
    for (const error of entry.errors) lines.push(`${entry.profile}：! ${error}`)
  }
  return lines.length > 0 ? lines.join('\n') : 'Web URL：未找到任何 profile。'
}
