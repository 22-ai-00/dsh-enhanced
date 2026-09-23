import { PurgeError } from './purge.ts'
import { defaultRunner, type CommandRunner } from './run.ts'
import { version as VERSION } from './version.ts'

/** 全局 dsh-rsi 自身的 npm 包名。 */
export const RSI_CLI_PACKAGE = '@dsh-enhanced/rsi-cli'
/** 精确版本或 dist-tag：只接受 x.y.z、带预发布后缀的 x.y.z-tag.n，或纯字母 dist-tag。 */
const SELECTOR_PATTERN = /^(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|[A-Za-z][A-Za-z0-9-]{0,63})$/u

export interface SelfUpdateReport {
  /** 升级前当前进程所属的 dsh-rsi 版本。 */
  fromVersion: string
  /** 请求的 selector（精确版本或 dist-tag），默认 latest。 */
  selector: string
  /** npm 全局前缀，便于用户确认装到了哪里。 */
  globalPrefix?: string
  /** registry 上 selector 解析出的精确版本；无法解析时为 undefined。 */
  resolvedVersion?: string
  /** 已是目标版本、未执行安装。 */
  alreadyCurrent: boolean
  /** 计划执行/已执行的命令描述。 */
  actions: string[]
}

/**
 * 升级全局 dsh-rsi 自身。
 *
 * 只做一件事：`npm install --global @dsh-enhanced/rsi-cli@<selector>`。
 * 刻意不在同一次调用里「装完新版再用新代码继续干活」——当前进程已把旧版代码
 * 载入内存，替换包不会改变它，混用两个版本的行为只会带来难以复现的问题。
 * 因此本函数执行完就返回，由用户在下一次调用中使用新版本。
 *
 * 升级插件集合（cohort）不走这里：那属于安装器的 `--operation upgrade`，
 * 由 `update --all` 薄委托过去，本模块不复制任何 cohort 升级逻辑。
 */
export async function runSelfUpdate(options: {
  selector?: string
  dryRun?: boolean
  runner?: CommandRunner
}): Promise<SelfUpdateReport> {
  const runner = options.runner ?? defaultRunner
  const selector = options.selector ?? 'latest'
  if (!SELECTOR_PATTERN.test(selector)) {
    throw new PurgeError(`非法的版本 selector：${selector}（应为精确版本 x.y.z 或 dist-tag）`)
  }
  const report: SelfUpdateReport = {
    fromVersion: VERSION,
    selector,
    alreadyCurrent: false,
    actions: [],
  }

  const prefix = runner('npm', ['prefix', '-g'])
  const prefixValue = prefix.stdout.trim()
  if (prefixValue.length > 0) report.globalPrefix = prefixValue

  // 先把 selector 解析成精确版本，这样「已是最新」可以直接跳过安装，
  // 而且用户能在 dry-run 下看到将要装的确切版本而不只是一个 tag。
  const view = runner('npm', ['view', `${RSI_CLI_PACKAGE}@${selector}`, 'version', '--location=global'])
  if (view.status === 0) {
    // npm view 对 dist-tag 返回单行版本；对范围可能返回多行，取最后一行（最高版本）。
    const lines = view.stdout.trim().split('\n').map(line => line.trim()).filter(line => line.length > 0)
    const last = lines.at(-1)
    if (last !== undefined) {
      // 多版本行形如 `@dsh-enhanced/rsi-cli@0.1.38 '0.1.38'`，取末尾引号内的值。
      const matched = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)'?$/u.exec(last)
      const captured = matched?.[1]
      if (captured !== undefined) report.resolvedVersion = captured
    }
  }

  if (report.resolvedVersion !== undefined && report.resolvedVersion === VERSION) {
    report.alreadyCurrent = true
    return report
  }

  const target = `${RSI_CLI_PACKAGE}@${selector}`
  report.actions.push(`npm install --global ${target}`)
  if (options.dryRun === true) return report

  const install = runner('npm', ['install', '--global', target, '--location=global'])
  if (install.status !== 0) {
    const detail = install.stderr.trim() || install.stdout.trim() || `npm 退出码 ${install.status}`
    throw new PurgeError(
      `升级 dsh-rsi 失败（前缀 ${report.globalPrefix ?? '未知'}）：${detail}\n`
      + `可手工执行：npm install --global ${target}`,
    )
  }
  return report
}

export function formatSelfUpdateReport(report: SelfUpdateReport, dryRun: boolean): string {
  const lines: string[] = []
  const resolved = report.resolvedVersion ?? '（无法从 registry 解析，仍按 selector 安装）'
  if (report.alreadyCurrent) {
    lines.push(`dsh-rsi 已是 ${report.fromVersion}，与 ${report.selector} 解析结果一致，无需升级。`)
    if (report.globalPrefix !== undefined) lines.push(`全局前缀：${report.globalPrefix}`)
    return lines.join('\n')
  }
  lines.push(dryRun
    ? `【dry-run】将升级 dsh-rsi：${report.fromVersion} → ${resolved}（selector ${report.selector}）`
    : `dsh-rsi 已升级：${report.fromVersion} → ${resolved}（selector ${report.selector}）`)
  if (report.globalPrefix !== undefined) lines.push(`全局前缀：${report.globalPrefix}`)
  for (const action of report.actions) lines.push(`  ${dryRun ? '将执行' : '已执行'}：${action}`)
  if (!dryRun) {
    // 当前进程仍在运行旧版代码，必须明确告知，避免用户以为本次输出已来自新版。
    lines.push('新版本在下一次执行 dsh-rsi 时生效（当前进程仍运行升级前的代码）。')
  }
  return lines.join('\n')
}
