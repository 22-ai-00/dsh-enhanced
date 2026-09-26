import { homedir } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { runPurge, PurgeError, type PurgeReport } from './purge.ts'
import { collectStatus, formatStatus, formatFindings, runDoctor } from './diagnose.ts'
import { resolveDshHome } from './paths.ts'
import { runInstall } from './install.ts'
import { findRunningProfiles } from './run.ts'
import { formatSelfUpdateReport, runSelfUpdate } from './update.ts'
import { formatWebUrlResult, resolveManagedWebUrl } from './weburl.ts'
import {
  collectLogs,
  controlManagedService,
  formatLogs,
  formatServiceOutcomes,
  managedServiceProcessIds,
  resolveTargetProfiles,
  type ServiceAction,
  type ServiceActionOutcome,
} from './services.ts'
import { version as VERSION } from './version.ts'

export { runPurge, PurgeError } from './purge.ts'
export { runInstall } from './install.ts'
export { collectStatus, runDoctor, formatStatus, formatFindings } from './diagnose.ts'
export { formatSelfUpdateReport, runSelfUpdate, RSI_CLI_PACKAGE } from './update.ts'
export {
  collectLogs,
  controlManagedService,
  formatLogs,
  formatServiceOutcomes,
  inspectManagedService,
  managedServiceProcessIds,
  resolveTargetProfiles,
  tailLogFile,
} from './services.ts'
export { extractWebUrlFromText, formatWebUrlResult, resolveManagedWebUrl } from './weburl.ts'
export { resolveDshHome } from './paths.ts'
export { version } from './version.ts'

const HELP = `dsh-rsi — DSH enhanced 插件集合的安装 / 控制 / 诊断 / 彻底卸载工具（v${VERSION}）

用法：
  dsh-rsi [全局选项] <命令> [命令参数]

命令：
  status      列出 DSH home、各 profile 与安装形态（npm/local）、host 版本、
              受管服务状态、外部凭据条目数、生命周期残留（只读）
  doctor      status 之外，扫描各 profile 的 host 错误日志，识别已知崩溃模式并给出建议（只读）
  start       启动已注册的受管常驻服务（不改动服务定义，未注册时报错并给出指引）
  stop        停止受管常驻服务（保留服务定义与 profile 数据，可再次 start）
  restart     重启受管常驻服务（配置/插件变更后生效的常用方式）
  logs        查看各 profile 的受管 stdout/stderr 日志尾部
  web-url     解析受管服务当前有效的带 token Web 授权 URL（从 journal / host 日志取最新 dsh web 行）
  update      升级全局 dsh-rsi 自身；加 --all 再升级整套插件集合（原地升级，保留数据）
  install     安装/修复插件集合（薄委托到官方安装器，参数原样透传）
  reinstall   purge（默认先备份）后立即重新安装
  purge       彻底卸载：停服 → 备份 → 删除 profile/DSH home → 清理外部凭据
  version     打印 dsh-rsi 版本

全局选项：
  --dsh-home <path>   指定 DSH home（默认取 $DSH_HOME，否则 ~/.dsh；安装器经 DSH_HOME 环境变量接收）
  --profile <name>    仅操作单个 profile（purge/reinstall 的 purge 阶段默认全量）
  --dry-run           只打印将执行的动作，不做任何修改
  --yes               purge/reinstall 跳过交互确认（reinstall 时同时透传给安装器）

install / reinstall：
  npm 形态（默认）    下载与本 dsh-rsi 同版本（v${VERSION}）的 install-npm.sh 到临时目录执行，
                      脚本内部自校验 common.sh 等资产的 SHA-256
  --local <dir>       local 形态：直接执行 <dir>/scripts/install/install-local.sh（checkout 安装）
  其它参数            原样透传给安装器，例如 --scenario core、--workspace、--model-route、--yes 等；
                      install --help 会展示安装器完整参数清单（也见 scripts/install/README.md）

update：
  不带参数            只升级全局 dsh-rsi 自身（npm install --global @dsh-enhanced/dsh-rsi-cli@latest）；
                      若当前仍由旧包 @dsh-enhanced/rsi-cli 安装，会在新包可用后自动卸载旧包。
  --all               自身升级成功后，再把插件集合交给官方安装器 --operation upgrade 原地升级
                      （保留 patch、凭据、Session、Goal 等状态；不同于 reinstall 的先 purge 再装）
  --version <v|tag>   指定 dsh-rsi 目标版本或 dist-tag（默认 latest）
  --local <dir>       --all 时走 local 形态，用该 checkout 的安装器升级
  其它参数            --all 时原样透传给安装器；通常无需再写 --scenario 或内部确认参数
  安全                已注册的 Linux 受管服务由升级事务自行停服/恢复；额外手工或测试 Host 会阻止升级。

start / stop / restart：
  不带 --profile 时作用于 DSH home 下的全部 profile；配合 --dry-run 可先看将执行的命令。
  只切换运行状态：不新建、不改写、不删除 launchd plist 或 systemd unit。
  服务尚未注册时不会隐式注册（那会绕过安装器的归属与路径校验），而是提示先执行
  dsh-rsi install 或 dsh-rsi-setup。停止/注销服务并删除定义请用 purge。

logs 选项：
  --lines <n>         每个日志文件显示的尾部行数（默认 200，上限 10000）
  --errors-only       只显示 *-host.error.log

purge 选项：
  --no-backup         删除前不生成 ~/dsh-purge-backup-<UTC时间戳>.tar.gz 备份
  --keep-keychain     保留 macOS Keychain / Linux Secret Service 中的受管凭据
  --remove-host       同时卸载全局 @deepseek-ai/dsh（仅限全量 purge；默认保留）

示例：
  dsh-rsi status
  dsh-rsi doctor
  dsh-rsi restart --profile web
  dsh-rsi stop
  dsh-rsi start --dry-run
  dsh-rsi logs --profile web --lines 100
  dsh-rsi logs --errors-only
  dsh-rsi update
  dsh-rsi update --dry-run
  dsh-rsi update --version 0.1.38
  dsh-rsi update --all --yes
  dsh-rsi install --scenario core --yes
  dsh-rsi install --local ~/work/github/dsh-enhanced --scenario web
  dsh-rsi reinstall --yes
  dsh-rsi purge --dry-run
  dsh-rsi purge --profile web
  dsh-rsi purge --yes --remove-host
`

interface ParsedArgs {
  command: string
  dshHome: string
  profile?: string
  dryRun: boolean
  yes: boolean
  backup: boolean
  keepKeychain: boolean
  removeHost: boolean
  help: boolean
  local?: string
  /** logs：每个文件显示的尾部行数。 */
  lines: number
  /** logs：只显示 *-host.error.log。 */
  errorsOnly: boolean
  /** update：同时升级插件集合（自动检查静止状态并继承现有场景）。 */
  all: boolean
  /** update：dsh-rsi 自身的目标版本或 dist-tag。 */
  targetVersion?: string
  /** install/reinstall：原样透传给安装器的参数。 */
  passthrough: string[]
}

const KNOWN_COMMANDS = new Set([
  'status', 'doctor', 'start', 'stop', 'restart', 'logs', 'web-url', 'update',
  'install', 'reinstall', 'purge', 'version',
])
const GLOBAL_FLAGS = new Set(['--dry-run', '--yes', '--help', '-h'])
const VALUE_OPTIONS = new Set(['--dsh-home', '--profile', '--lines', '--version'])
const LOGS_FLAGS = new Set(['--errors-only'])
const UPDATE_FLAGS = new Set(['--all'])
/** logs --lines 上限，避免一次把超大日志全量打到终端。 */
const MAX_LOG_LINES = 10_000
const DEFAULT_LOG_LINES = 200
const PURGE_FLAGS = new Set(['--no-backup', '--keep-keychain', '--remove-host'])
/** install/reinstall 中由 rsi 自身消费、不透传给安装器的带值选项。 */
const INSTALL_VALUE_OPTIONS = new Set(['--dsh-home', '--local'])

/** 写入一个带值选项；--lines 需要范围校验，错误值必须报错而不是静默取默认。 */
function assignValueOption(result: ParsedArgs, token: string, value: string): void {
  if (token === '--dsh-home') { result.dshHome = value; return }
  if (token === '--profile') { result.profile = value; return }
  if (token === '--version') { result.targetVersion = value; return }
  // --lines
  if (!/^[0-9]+$/u.test(value)) throw new PurgeError(`--lines 需要一个正整数，收到：${value}`)
  const parsed = Number(value)
  if (parsed < 1 || parsed > MAX_LOG_LINES) {
    throw new PurgeError(`--lines 需在 1..${MAX_LOG_LINES} 之间，收到：${value}`)
  }
  result.lines = parsed
}

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ParsedArgs {
  const result: ParsedArgs = {
    command: 'status',
    dshHome: resolveDshHome(env),
    dryRun: false,
    yes: false,
    backup: true,
    keepKeychain: false,
    removeHost: false,
    help: false,
    lines: DEFAULT_LOG_LINES,
    errorsOnly: false,
    all: false,
    passthrough: [],
  }
  let commandSeen = false
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (!commandSeen) {
      if (VALUE_OPTIONS.has(token)) {
        const value = argv[++i]
        if (value === undefined || value.startsWith('--')) throw new PurgeError(`${token} 需要一个值`)
        assignValueOption(result, token, value)
        continue
      }
      if (GLOBAL_FLAGS.has(token)) {
        if (token === '--dry-run') result.dryRun = true
        else if (token === '--yes') result.yes = true
        else result.help = true
        continue
      }
      if (LOGS_FLAGS.has(token)) {
        result.errorsOnly = true
        continue
      }
      if (UPDATE_FLAGS.has(token)) {
        result.all = true
        continue
      }
      if (PURGE_FLAGS.has(token)) {
        if (token === '--no-backup') result.backup = false
        else if (token === '--keep-keychain') result.keepKeychain = true
        else result.removeHost = true
        continue
      }
      if (!token.startsWith('-') && KNOWN_COMMANDS.has(token)) {
        result.command = token
        commandSeen = true
        continue
      }
      throw new PurgeError(`无法识别的参数：${token}（用 -h 查看用法）`)
    }

    // 命令之后：install/reinstall/update --all 走「消费少数 rsi 选项 + 其余透传」。
    if (result.command === 'install' || result.command === 'reinstall' || result.command === 'update') {
      i = consumeInstallToken(result, argv, i)
      continue
    }
    // 其它命令保持既有的严格解析。
    if (VALUE_OPTIONS.has(token)) {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) throw new PurgeError(`${token} 需要一个值`)
      assignValueOption(result, token, value)
      continue
    }
    if (GLOBAL_FLAGS.has(token)) {
      if (token === '--dry-run') result.dryRun = true
      else if (token === '--yes') result.yes = true
      else result.help = true
      continue
    }
    if (LOGS_FLAGS.has(token)) {
      result.errorsOnly = true
      continue
    }
    if (UPDATE_FLAGS.has(token)) {
      result.all = true
      continue
    }
    if (PURGE_FLAGS.has(token)) {
      if (token === '--no-backup') result.backup = false
      else if (token === '--keep-keychain') result.keepKeychain = true
      else result.removeHost = true
      continue
    }
    throw new PurgeError(`无法识别的参数：${token}（用 -h 查看用法）`)
  }
  return result
}

/**
 * 处理 install/reinstall 命令后的一个 token，返回新的下标。
 * rsi 只消费 --dsh-home/--local（及 reinstall 的 purge 选项）；
 * --yes/--dry-run 在 reinstall 下「rsi 生效且同时透传」，install 下纯透传；
 * 其它安装器参数（含其带值）原样进 passthrough。
 */
function consumeInstallToken(result: ParsedArgs, argv: readonly string[], index: number): number {
  const token = argv[index]!
  const isReinstall = result.command === 'reinstall'
  const isUpdate = result.command === 'update'

  // update 自身的选项由 rsi 消费，不透传给安装器。
  if (isUpdate) {
    if (token === '--all') { result.all = true; return index }
    if (token === '--version') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new PurgeError(`${token} 需要一个值`)
      result.targetVersion = value
      return index + 1
    }
    if (token === '--help' || token === '-h') { result.help = true; return index }
    if (token === '--dry-run') { result.dryRun = true; result.passthrough.push(token); return index }
  }

  if (INSTALL_VALUE_OPTIONS.has(token)) {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new PurgeError(`${token} 需要一个值`)
    if (token === '--dsh-home') result.dshHome = value
    else result.local = value
    return index + 1
  }
  // install --help/-h 透传给安装器（薄委托展示安装器自身帮助）；
  // reinstall 无安装器单独可展示的语义，-h/--help 显示 rsi 帮助。
  if (isReinstall && (token === '--help' || token === '-h')) {
    result.help = true
    return index
  }
  if (isReinstall && token === '--profile') {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new PurgeError(`${token} 需要一个值`)
    result.profile = value
    return index + 1
  }
  if (isReinstall && PURGE_FLAGS.has(token)) {
    if (token === '--no-backup') result.backup = false
    else if (token === '--keep-keychain') result.keepKeychain = true
    else result.removeHost = true
    return index
  }
  if (isReinstall && (token === '--yes' || token === '--dry-run')) {
    if (token === '--yes') result.yes = true
    else result.dryRun = true
    result.passthrough.push(token)
    return index
  }

  // 其余一律透传；若下一个 token 是不带 - 的值（如 --scenario 的 core），一并透传。
  result.passthrough.push(token)
  const next = argv[index + 1]
  if (token.startsWith('--') && next !== undefined && !next.startsWith('-')) {
    result.passthrough.push(next)
    return index + 1
  }
  return index
}

async function confirmPurge(args: ParsedArgs, reinstall: boolean): Promise<boolean> {
  const scope = args.profile === undefined ? '整个 DSH home（全部 profile）' : `profile ${args.profile}`
  const backup = args.backup ? '会先在 ~ 生成 tar.gz 备份' : '不会备份（--no-backup）'
  const host = args.removeHost ? '\n  - 同时卸载全局 @deepseek-ai/dsh' : ''
  const tail = reinstall
    ? '\npurge 完成后将立即重新安装插件集合。'
    : ''
  process.stdout.write(`即将彻底删除 ${scope}：
  - DSH home 内的 profile 数据与受管日志
  - 生命周期事务/锁残留
  - 受管常驻服务（launchd / systemd --user）
  - ${backup}${args.keepKeychain ? '' : '\n  - macOS Keychain / Linux Secret Service 中的受管凭据'}${host}${tail}
local checkout 源码不会被删除。输入 purge 后回车继续：`)
  const reader = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await reader.question('')).trim()
    return answer === 'purge'
  } finally {
    reader.close()
  }
}

function formatPurgeReport(args: ParsedArgs, report: PurgeReport): string {
  const lines: string[] = []
  lines.push(args.dryRun ? '【dry-run】以下是将执行的 purge 计划，未做任何修改：' : 'purge 完成。')
  if (report.backup) {
    lines.push(args.dryRun
      ? `备份：将生成 ${report.backup.archivePath}（tar.gz，0600）`
      : `备份：${report.backup.archivePath}（${report.backup.bytes} 字节）`)
  } else {
    lines.push('备份：已跳过（--no-backup）')
  }
  for (const profile of report.serviceProfiles) lines.push(`服务：已停用并注销 ${profile} 的受管常驻服务`)
  for (const path of report.skippedServiceFiles) lines.push(`服务文件保留：${path}`)
  if (report.terminatedPids.length > 0) {
    lines.push(`残留进程：已终止 ${report.terminatedPids.length} 个（PID ${report.terminatedPids.join(", ")}）`)
  }
  lines.push(`删除路径（${report.removedPaths.length}）：`)
  for (const path of report.removedPaths) lines.push(`  - ${path}`)
  if (report.removedCredentials.length > 0) {
    lines.push(`外部凭据条目（${report.removedCredentials.length}）：`)
    for (const credential of report.removedCredentials) lines.push(`  - ${credential}`)
  } else if (!args.keepKeychain) {
    lines.push('外部凭据条目：无')
  }
  if (args.keepKeychain) lines.push('外部凭据：已按 --keep-keychain 保留')
  if (report.keptCheckouts.length > 0) {
    lines.push('local checkout 源码（未删除，确认无用后可手工 rm -rf）：')
    for (const checkout of report.keptCheckouts) lines.push(`  + ${checkout}`)
  }
  if (report.hostRemoved) {
    lines.push(args.dryRun
      ? `全局 host：将执行 npm uninstall -g @deepseek-ai/dsh（前缀 ${report.hostPrefix ?? '未知'}）`
      : `全局 host：已卸载 @deepseek-ai/dsh（前缀 ${report.hostPrefix ?? '未知'}）`)
  } else {
    lines.push('全局 host：已保留（需要一并卸载请加 --remove-host）')
  }
  if (!args.dryRun) {
    lines.push('')
    lines.push('如需重装：dsh-rsi install（npm 形态）或 dsh-rsi install --local <checkout>（local 形态）；也可重跑 install-npm.sh / install-local.sh。')
  }
  return lines.join('\n')
}

/** 组装 install 参数；命令位置之前的全局 --yes/--dry-run/--profile 在 install 下也补透传给安装器。 */
function buildInstallOptions(args: ParsedArgs): Parameters<typeof runInstall>[0] {
  const passthrough = [...args.passthrough]
  if (args.yes && !passthrough.includes('--yes')) passthrough.push('--yes')
  if (args.dryRun && !passthrough.includes('--dry-run')) passthrough.push('--dry-run')
  // --profile 既用于 reinstall 的 purge 范围，也原样透传给安装器（安装器本身接受 --profile）。
  if (args.profile !== undefined && !passthrough.includes('--profile')) {
    passthrough.push('--profile', args.profile)
  }
  return {
    mode: args.local === undefined ? 'npm' : 'local',
    ...(args.local === undefined ? {} : { localRepositoryRoot: args.local }),
    releaseRef: `v${VERSION}`,
    passthrough,
    dshHome: args.dshHome,
  }
}

/** main 的依赖面，仅供测试注入（默认执行真实 purge/install/self-update）。 */
export interface MainDeps {
  purge?: typeof runPurge
  install?: typeof runInstall
  selfUpdate?: typeof runSelfUpdate
  findRunning?: typeof findRunningProfiles
  managedServicePids?: typeof managedServiceProcessIds
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  deps: MainDeps = {},
): Promise<number> {
  const purge = deps.purge ?? runPurge
  const install = deps.install ?? runInstall
  const selfUpdate = deps.selfUpdate ?? runSelfUpdate
  const findRunning = deps.findRunning ?? findRunningProfiles
  const managedPids = deps.managedServicePids ?? managedServiceProcessIds
  let args: ParsedArgs
  try {
    args = parseArgs(argv, env)
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    return 2
  }
  if (args.help) {
    process.stdout.write(HELP)
    return 0
  }
  try {
    switch (args.command) {
      case 'version':
        process.stdout.write(`${VERSION}\n`)
        return 0
      case 'status': {
        const snapshot = await collectStatus(args.dshHome, homedir(), process.platform)
        process.stdout.write(`${formatStatus(snapshot)}\n`)
        return 0
      }
      case 'doctor': {
        const snapshot = await collectStatus(args.dshHome, homedir(), process.platform)
        const findings = await runDoctor(args.dshHome)
        process.stdout.write(`${formatStatus(snapshot)}\n\n${formatFindings(findings)}\n`)
        return 0
      }
      case 'start':
      case 'stop':
      case 'restart': {
        const action = args.command as ServiceAction
        const profiles = await resolveTargetProfiles(args.dshHome, args.profile)
        if (profiles.length === 0) {
          process.stderr.write(`${action}：${args.dshHome} 下没有任何 profile（先执行 dsh-rsi install）\n`)
          return 1
        }
        const outcomes: ServiceActionOutcome[] = []
        for (const profile of profiles) {
          outcomes.push(await controlManagedService(
            process.platform, homedir(), profile, action, undefined, args.dryRun,
          ))
        }
        process.stdout.write(`${formatServiceOutcomes(outcomes, action, args.dryRun)}\n`)
        // 任一 profile 失败即非零退出，便于脚本判定。
        return outcomes.some(outcome => outcome.errors.length > 0) ? 1 : 0
      }
      case 'logs': {
        const profiles = await resolveTargetProfiles(args.dshHome, args.profile)
        if (profiles.length === 0) {
          process.stderr.write(`logs：${args.dshHome} 下没有任何 profile\n`)
          return 1
        }
        const collected = await collectLogs(args.dshHome, profiles, args.lines, args.errorsOnly)
        process.stdout.write(`${formatLogs(collected, args.lines)}\n`)
        return 0
      }
      case 'web-url': {
        const profiles = await resolveTargetProfiles(args.dshHome, args.profile)
        if (profiles.length === 0) {
          process.stderr.write(`web-url：${args.dshHome} 下没有任何 profile\n`)
          return 1
        }
        const entries = []
        for (const profile of profiles) {
          entries.push(await resolveManagedWebUrl(process.platform, homedir(), args.dshHome, profile))
        }
        process.stdout.write(`${formatWebUrlResult(entries)}\n`)
        // 任一 profile 解析出错时退出 1，但仍尽量打印成功的 URL。
        return entries.some(entry => entry.errors.length > 0) ? 1 : 0
      }
      case 'update': {
        // 先升级自身：--all 下若自身升级失败就不继续动插件集合，避免用旧版 rsi
        // 的判断去驱动新一轮 cohort 升级。
        const report = await selfUpdate({
          ...(args.targetVersion === undefined ? {} : { selector: args.targetVersion }),
          dryRun: args.dryRun,
        })
        process.stdout.write(`${formatSelfUpdateReport(report, args.dryRun)}\n`)
        if (!args.all) return 0
        const profiles = args.profile === undefined
          ? await resolveTargetProfiles(args.dshHome)
          : [args.profile]
        const running = findRunning(profiles)
        if (running.error !== undefined) {
          throw new PurgeError(`无法确认 DSH_HOME 已静止：${running.error}`)
        }
        const managed = await managedPids(process.platform, homedir(), profiles)
        if (managed.errors.length > 0) {
          throw new PurgeError(`无法确认受管服务进程：${managed.errors.join('；')}`)
        }
        const managedSet = new Set(managed.pids)
        const external = running.active.filter(item => !managedSet.has(item.pid))
        if (external.length > 0) {
          const details = external.map(item => `PID ${item.pid}`).join('、')
          throw new PurgeError(
            `检测到目标 profile 存在非受管 Host（${details}）。请停止对应手工/测试 dsh 进程后重试；`
            + '已注册的受管服务无需手动停止，将由生命周期事务接管。',
          )
        }
        process.stdout.write(managed.pids.length > 0
          ? '\n插件集合升级：已确认除受管服务外没有其它 Host；生命周期事务将安全停服、升级并恢复。\n'
          : '\n插件集合升级：已确认目标 profile 无运行中 Host，正在继承现有部署场景并原地升级。\n')
        const passthrough = [...args.passthrough]
        if (!passthrough.includes('--operation')) passthrough.push('--operation', 'upgrade')
        if (!passthrough.includes('--confirm-dsh-home-stopped')) {
          passthrough.push('--confirm-dsh-home-stopped')
        }
        const releaseVersion = report.installedVersion
          ?? report.resolvedVersion
          ?? (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(report.selector) ? report.selector : undefined)
        if (releaseVersion === undefined) {
          throw new PurgeError(
            '无法把 dsh-rsi 目标 selector 解析为精确发布版本；为避免 CLI 与安装器版本错配，未开始插件升级。',
          )
        }
        return await install({
          ...buildInstallOptions(args),
          releaseRef: `v${releaseVersion}`,
          passthrough,
        })
      }
      case 'install': {
        return await install(buildInstallOptions(args))
      }
      case 'reinstall': {
        if (!args.dryRun && !args.yes) {
          const confirmed = await confirmPurge(args, true)
          if (!confirmed) {
            process.stdout.write('已取消（未输入 purge）。\n')
            return 1
          }
        }
        const report = await purge({
          dshHome: args.dshHome,
          home: homedir(),
          ...(args.profile === undefined ? {} : { profile: args.profile }),
          backup: args.backup,
          keepKeychain: args.keepKeychain,
          removeHost: args.removeHost,
          dryRun: args.dryRun,
          assumeYes: args.yes,
        })
        process.stdout.write(`${formatPurgeReport(args, report)}\n\n`)
        return await install(buildInstallOptions(args))
      }
      case 'purge': {
        if (!args.dryRun && !args.yes) {
          const confirmed = await confirmPurge(args, false)
          if (!confirmed) {
            process.stdout.write('已取消（未输入 purge）。\n')
            return 1
          }
        }
        const report = await purge({
          dshHome: args.dshHome,
          home: homedir(),
          ...(args.profile === undefined ? {} : { profile: args.profile }),
          backup: args.backup,
          keepKeychain: args.keepKeychain,
          removeHost: args.removeHost,
          dryRun: args.dryRun,
          assumeYes: args.yes,
        })
        process.stdout.write(`${formatPurgeReport(args, report)}\n`)
        return 0
      }
      default:
        process.stderr.write(`未知命令：${args.command}\n`)
        return 2
    }
  } catch (error) {
    if (error instanceof PurgeError) {
      process.stderr.write(`${args.command} 失败：${error.message}\n`)
      return 1
    }
    process.stderr.write(`错误：${(error as Error).stack ?? (error as Error).message}\n`)
    return 1
  }
}
