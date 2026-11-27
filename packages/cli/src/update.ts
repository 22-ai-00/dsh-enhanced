import { homedir } from 'node:os'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPackageManagerEnv, resolveFallbackBinary } from './pm-env.ts'
import { PurgeError } from './purge.ts'
import { defaultDetailedRunner, defaultRunner, type CommandRunner } from './run.ts'
import { version as VERSION } from './version.ts'
import { compareExactVersions } from './program-update.ts'

/** 全局 dsh-ray 自身的 npm 包名（`@dsh-ray/cli`）。 */
export const RSI_CLI_PACKAGE = '@dsh-ray/cli'
/** 精确版本或 dist-tag：只接受 x.y.z、带预发布后缀的 x.y.z-tag.n，或纯字母 dist-tag。 */
const SELECTOR_PATTERN = /^(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|[A-Za-z][A-Za-z0-9-]{0,63})$/u
const runtimePackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 全局包在现行布局下的路径后缀：
 *   <prefix>/lib/node_modules/@dsh-ray/cli
 */
const GLOBAL_PACKAGE_SUFFIX = `${sep}lib${sep}node_modules${sep}@dsh-ray${sep}cli`

/** 从真实 npm 全局包路径反推 prefix；源码 checkout/测试环境回退 npm prefix -g。 */
export function prefixFromPackageRoot(packageRoot: string): string | undefined {
  const normalized = resolve(packageRoot)
  if (normalized.endsWith(GLOBAL_PACKAGE_SUFFIX)) {
    return normalized.slice(0, -GLOBAL_PACKAGE_SUFFIX.length)
  }
  return undefined
}

/**
 * 判断当前进程实际是否由官方全局包加载。
 * - `new`：官方全局包 `@dsh-ray/cli`
 * - `unknown`：checkout / 临时目录运行（非官方全局安装）。
 */
export function runtimePackageKind(packageRoot: string): 'new' | 'unknown' {
  const normalized = resolve(packageRoot)
  if (normalized.endsWith(GLOBAL_PACKAGE_SUFFIX)) return 'new'
  return 'unknown'
}

export interface SelfUpdateReport {
  /** 升级前当前进程所属的 dsh-ray 版本。 */
  fromVersion: string
  /** 请求的 selector（精确版本或 dist-tag），默认 latest。 */
  selector: string
  /** npm 全局前缀，便于用户确认装到了哪里。 */
  globalPrefix?: string
  /** registry 上 selector 解析出的精确版本；无法解析时为 undefined。 */
  resolvedVersion?: string
  /** 实际安装成功的精确版本；供 update --all 选择同版本安装器 tag。 */
  installedVersion?: string
  /** 已是目标版本、未执行安装。 */
  alreadyCurrent: boolean
  /** 当前官方全局 CLI 新于 registry 的 latest，故保留当前版本。 */
  retainedNewer?: boolean
  /** 计划执行/已执行的命令描述。 */
  actions: string[]
}

/**
 * 升级全局 dsh-ray 自身。
 *
 * 只做一件事：把 `@dsh-ray/cli@<selector>` 安装到全局。
 * 调用方决定是否从安装后的精确新 bin 复执行；
 * 本函数只负责自身升级与返回安装结果，不继续执行 Home 更新。
 *
 * 升级插件集合（cohort）不走这里：那属于安装器的 `--operation upgrade`，
 * 由 `update --all` 薄委托过去，本模块不复制任何 cohort 升级逻辑。
 */
export async function runSelfUpdate(options: {
  selector?: string
  dryRun?: boolean
  runner?: CommandRunner
  /** 测试注入；生产默认使用当前已加载 npm 包根目录。 */
  packageRoot?: string
}): Promise<SelfUpdateReport> {
  const hasCustomRunner = options.runner !== undefined && options.runner !== defaultRunner
  const pmOsHome = process.env.HOME ?? homedir()
  const npmResolution = hasCustomRunner
    ? { command: 'npm' as string }
    : await resolveFallbackBinary('npm', process.env, pmOsHome, process.platform)
  const pmEnv = hasCustomRunner
    ? undefined
    : await buildPackageManagerEnv(process.env, pmOsHome, process.platform, npmResolution.binDir ? [npmResolution.binDir] : [])
  const runner: CommandRunner = hasCustomRunner
    ? options.runner!
    : (command, args) => defaultDetailedRunner(command === 'npm' ? npmResolution.command : command, args, pmEnv ? { env: pmEnv } : {})
  const selector = options.selector ?? 'latest'
  if (!SELECTOR_PATTERN.test(selector)) {
    throw new PurgeError(`非法的版本 selector：${selector}（应为精确版本 x.y.z 或 dist-tag）`)
  }
  const packageRoot = options.packageRoot ?? runtimePackageRoot
  const report: SelfUpdateReport = {
    fromVersion: VERSION,
    selector,
    alreadyCurrent: false,
    actions: [],
  }

  const ownedPrefix = prefixFromPackageRoot(packageRoot)
  if (ownedPrefix !== undefined) {
    report.globalPrefix = ownedPrefix
  } else {
    const prefix = runner('npm', ['prefix', '-g'])
    const prefixValue = prefix.stdout.trim()
    if (prefixValue.length > 0) report.globalPrefix = prefixValue
  }

  // 先把 selector 解析成精确版本，这样「已是最新」可以直接跳过安装，
  // 而且用户能在 dry-run 下看到将要装的确切版本而不只是一个 tag。
  const view = runner('npm', ['view', `${RSI_CLI_PACKAGE}@${selector}`, 'version', '--location=global'])
  if (view.status === 0) {
    // npm view 对 dist-tag 返回单行版本；对范围可能返回多行，取最后一行（最高版本）。
    const lines = view.stdout.trim().split('\n').map(line => line.trim()).filter(line => line.length > 0)
    const last = lines.at(-1)
    if (last !== undefined) {
      // 多版本行形如 `@dsh-ray/cli@0.1.47 '0.1.47'`，取末尾引号内的值。
      const matched = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)'?$/u.exec(last)
      const captured = matched?.[1]
      if (captured !== undefined) report.resolvedVersion = captured
    }
  }

  const kind = runtimePackageKind(packageRoot)

  // latest 是自动选择；registry 落后或无法解析时，绝不能把较新的本机 CLI 覆盖成旧版。
  // 仅当前进程确实来自官方新全局包时，才能将其视为可保留的已安装版本。
  if (selector === 'latest') {
    const order = report.resolvedVersion === undefined ? undefined : compareExactVersions(report.resolvedVersion, VERSION)
    if (order === undefined) throw new PurgeError('无法确认 npm latest 的精确版本；未更改全局 CLI。')
    if (order < 0) {
      if (kind !== 'new') throw new PurgeError('npm latest 早于当前 CLI，且当前进程不是官方新全局包；未更改全局 CLI。')
      report.alreadyCurrent = true
      report.retainedNewer = true
      report.installedVersion = VERSION
      return report
    }
  }

  // 「已是最新」只在当前已是官方全局包时成立；非官方全局路径即使版本号相同也执行一次全局安装。
  if (report.resolvedVersion !== undefined && report.resolvedVersion === VERSION && kind === 'new') {
    report.alreadyCurrent = true
    report.installedVersion = report.resolvedVersion
    return report
  }

  // latest 查询后固定精确版本，避免 tag 在查询与安装之间移动而绕过版本比较。
  const target = `${RSI_CLI_PACKAGE}@${selector === 'latest' ? report.resolvedVersion : selector}`
  const prefixArgs = report.globalPrefix === undefined ? [] : ['--prefix', report.globalPrefix]
  report.actions.push(
    `npm install --global${report.globalPrefix === undefined ? '' : ` --prefix ${report.globalPrefix}`} ${target}`,
  )
  if (options.dryRun === true) return report

  const install = runner('npm', ['install', '--global', ...prefixArgs, target, '--location=global'])
  if (install.status !== 0) {
    const detail = install.stderr.trim() || install.stdout.trim() || `npm 退出码 ${install.status}`
    throw new PurgeError(
      `升级 dsh-ray 失败（前缀 ${report.globalPrefix ?? '未知'}）：${detail}\n`
      + `可手工执行：npm install --global ${target}`,
    )
  }
  if (report.resolvedVersion !== undefined) report.installedVersion = report.resolvedVersion
  return report
}

export function formatSelfUpdateReport(report: SelfUpdateReport, dryRun: boolean): string {
  const lines: string[] = []
  const resolved = report.resolvedVersion ?? '（无法从 registry 解析，仍按 selector 安装）'
  if (report.alreadyCurrent) {
    lines.push(report.retainedNewer
      ? `dsh-ray 当前版本 ${report.fromVersion} 新于 npm ${report.selector} 的 ${report.resolvedVersion}，保留本机版本，未安装旧版。`
      : `dsh-ray 已是 ${report.fromVersion}，与 ${report.selector} 解析结果一致，无需升级。`)
    if (report.globalPrefix !== undefined) lines.push(`全局前缀：${report.globalPrefix}`)
    return lines.join('\n')
  }
  lines.push(dryRun
    ? `【dry-run】将升级 dsh-ray：${report.fromVersion} → ${resolved}（selector ${report.selector}）`
    : `dsh-ray 已升级：${report.fromVersion} → ${resolved}（selector ${report.selector}）`)
  if (report.globalPrefix !== undefined) lines.push(`全局前缀：${report.globalPrefix}`)
  for (const action of report.actions) lines.push(`  ${dryRun ? '将执行' : '已执行'}：${action}`)
  if (!dryRun) {
    // 当前进程仍在运行旧版代码，必须明确告知，避免用户以为本次输出已来自新版。
    lines.push('新版本在下一次执行 dsh-ray 时生效（当前进程仍运行升级前的代码）。')
  }
  return lines.join('\n')
}
