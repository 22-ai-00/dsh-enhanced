import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PurgeError } from './purge.ts'
import { defaultRunner, type CommandRunner } from './run.ts'
import { version as VERSION } from './version.ts'
import { compareExactVersions } from './program-update.ts'

/** 全局 dsh-rsi 自身的 npm 包名（新名）。 */
export const RSI_CLI_PACKAGE = '@dsh-enhanced/dsh-rsi-cli'
/**
 * 历史包名。0.1.47 及更早版本以 `@dsh-enhanced/rsi-cli` 发布；该包已发布版本不可删除，
 * 自升级时负责把旧全局安装迁移到新名，避免两个包同时提供 `dsh-rsi` bin 造成冲突。
 */
export const LEGACY_RSI_CLI_PACKAGE = '@dsh-enhanced/rsi-cli'
/** 精确版本或 dist-tag：只接受 x.y.z、带预发布后缀的 x.y.z-tag.n，或纯字母 dist-tag。 */
const SELECTOR_PATTERN = /^(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|[A-Za-z][A-Za-z0-9-]{0,63})$/u
const runtimePackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 全局包在两种历史/现行布局下的路径后缀：
 *   <prefix>/lib/node_modules/@dsh-enhanced/dsh-rsi-cli   （新）
 *   <prefix>/lib/node_modules/@dsh-enhanced/rsi-cli       （旧，迁移期识别）
 */
const GLOBAL_PACKAGE_SUFFIXES = [
  `${sep}lib${sep}node_modules${sep}@dsh-enhanced${sep}dsh-rsi-cli`,
  `${sep}lib${sep}node_modules${sep}@dsh-enhanced${sep}rsi-cli`,
] as const

/** 从真实 npm 全局包路径反推 prefix；两种包名后缀都识别，源码 checkout/测试环境回退 npm prefix -g。 */
export function prefixFromPackageRoot(packageRoot: string): string | undefined {
  const normalized = resolve(packageRoot)
  for (const suffix of GLOBAL_PACKAGE_SUFFIXES) {
    if (normalized.endsWith(suffix)) return normalized.slice(0, -suffix.length)
  }
  return undefined
}

/**
 * 判断当前进程实际由哪一个全局包加载。
 * - `new`：新包 `@dsh-enhanced/dsh-rsi-cli`
 * - `legacy`：旧包 `@dsh-enhanced/rsi-cli`（需要在本次 update 中迁移）
 * - `unknown`：checkout / 临时目录运行（非全局安装），不做包名迁移。
 */
export function runtimePackageKind(packageRoot: string): 'new' | 'legacy' | 'unknown' {
  const normalized = resolve(packageRoot)
  if (normalized.endsWith(GLOBAL_PACKAGE_SUFFIXES[0])) return 'new'
  if (normalized.endsWith(GLOBAL_PACKAGE_SUFFIXES[1])) return 'legacy'
  return 'unknown'
}

export interface SelfUpdateReport {
  /** 升级前当前进程所属的 dsh-rsi 版本。 */
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
  /**
   * 本次是否发生了「旧包名 → 新包名」的全局迁移。
   * 旧包 `@dsh-enhanced/rsi-cli` 提供 `dsh-rsi` bin；新包安装成功后才卸载旧包。
   */
  migratedFrom: boolean
  /** 计划执行/已执行的命令描述。 */
  actions: string[]
}

/**
 * 升级全局 dsh-rsi 自身。
 *
 * 只做一件事：把 `@dsh-enhanced/dsh-rsi-cli@<selector>` 安装到全局；
 * 若当前进程仍由旧包 `@dsh-enhanced/rsi-cli` 加载，则在新包安装成功后卸载旧包，
 * 避免两个包同时提供 `dsh-rsi` bin。调用方决定是否从安装后的精确新 bin 复执行；
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
  const runner = options.runner ?? defaultRunner
  const selector = options.selector ?? 'latest'
  if (!SELECTOR_PATTERN.test(selector)) {
    throw new PurgeError(`非法的版本 selector：${selector}（应为精确版本 x.y.z 或 dist-tag）`)
  }
  const packageRoot = options.packageRoot ?? runtimePackageRoot
  const report: SelfUpdateReport = {
    fromVersion: VERSION,
    selector,
    alreadyCurrent: false,
    migratedFrom: false,
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
  // 永远查询新包名：旧包 registry 上已停更，迁移必须落到新包。
  const view = runner('npm', ['view', `${RSI_CLI_PACKAGE}@${selector}`, 'version', '--location=global'])
  if (view.status === 0) {
    // npm view 对 dist-tag 返回单行版本；对范围可能返回多行，取最后一行（最高版本）。
    const lines = view.stdout.trim().split('\n').map(line => line.trim()).filter(line => line.length > 0)
    const last = lines.at(-1)
    if (last !== undefined) {
      // 多版本行形如 `@dsh-enhanced/dsh-rsi-cli@0.1.47 '0.1.47'`，取末尾引号内的值。
      const matched = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)'?$/u.exec(last)
      const captured = matched?.[1]
      if (captured !== undefined) report.resolvedVersion = captured
    }
  }

  const kind = runtimePackageKind(packageRoot)
  report.migratedFrom = kind === 'legacy'

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

  // 「已是最新」只在当前已是新包时成立；旧包即使版本号相同也必须迁移一次。
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
  if (report.migratedFrom) {
    report.actions.push(
      `npm uninstall --global${report.globalPrefix === undefined ? '' : ` --prefix ${report.globalPrefix}`} ${LEGACY_RSI_CLI_PACKAGE}`,
    )
  }
  if (options.dryRun === true) return report

  const install = runner('npm', ['install', '--global', ...prefixArgs, target, '--location=global'])
  if (install.status !== 0) {
    const detail = install.stderr.trim() || install.stdout.trim() || `npm 退出码 ${install.status}`
    throw new PurgeError(
      `升级 dsh-rsi 失败（前缀 ${report.globalPrefix ?? '未知'}）：${detail}\n`
      + `可手工执行：npm install --global ${target}`,
    )
  }
  if (report.resolvedVersion !== undefined) report.installedVersion = report.resolvedVersion

  // 新包安装成功后才卸载旧包；新包失败时上面已经抛出，旧包保持原样，bin 不冲突。
  if (report.migratedFrom) {
    const uninstall = runner('npm', ['uninstall', '--global', ...prefixArgs, LEGACY_RSI_CLI_PACKAGE, '--location=global'])
    if (uninstall.status !== 0) {
      const detail = uninstall.stderr.trim() || uninstall.stdout.trim() || `npm 退出码 ${uninstall.status}`
      throw new PurgeError(
        `dsh-rsi 已升级到新包名 ${RSI_CLI_PACKAGE}，但卸载旧包 ${LEGACY_RSI_CLI_PACKAGE} 失败：${detail}\n`
        + `新包已可用；可手工执行：npm uninstall --global ${LEGACY_RSI_CLI_PACKAGE}`,
      )
    }
  }
  return report
}

export function formatSelfUpdateReport(report: SelfUpdateReport, dryRun: boolean): string {
  const lines: string[] = []
  const resolved = report.resolvedVersion ?? '（无法从 registry 解析，仍按 selector 安装）'
  if (report.alreadyCurrent) {
    lines.push(report.retainedNewer
      ? `dsh-rsi 当前版本 ${report.fromVersion} 新于 npm ${report.selector} 的 ${report.resolvedVersion}，保留本机版本，未安装旧版。`
      : `dsh-rsi 已是 ${report.fromVersion}，与 ${report.selector} 解析结果一致，无需升级。`)
    if (report.globalPrefix !== undefined) lines.push(`全局前缀：${report.globalPrefix}`)
    return lines.join('\n')
  }
  lines.push(dryRun
    ? `【dry-run】将升级 dsh-rsi：${report.fromVersion} → ${resolved}（selector ${report.selector}）`
    : `dsh-rsi 已升级：${report.fromVersion} → ${resolved}（selector ${report.selector}）`)
  if (report.globalPrefix !== undefined) lines.push(`全局前缀：${report.globalPrefix}`)
  if (report.migratedFrom) {
    lines.push(`包名迁移：${LEGACY_RSI_CLI_PACKAGE} → ${RSI_CLI_PACKAGE}（bin 仍为 dsh-rsi；新包安装成功后才卸载旧包）`)
  }
  for (const action of report.actions) lines.push(`  ${dryRun ? '将执行' : '已执行'}：${action}`)
  if (!dryRun) {
    // 当前进程仍在运行旧版代码，必须明确告知，避免用户以为本次输出已来自新版。
    lines.push('新版本在下一次执行 dsh-rsi 时生效（当前进程仍运行升级前的代码）。')
  }
  return lines.join('\n')
}
