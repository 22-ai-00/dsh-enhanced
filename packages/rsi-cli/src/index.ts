import { homedir } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { runPurge, PurgeError, type PurgeReport } from './purge.ts'
import { collectStatus, formatStatus, formatFindings, runDoctor } from './diagnose.ts'
import { resolveDshHome } from './paths.ts'
import { runInstall } from './install.ts'
import { version as VERSION } from './version.ts'

export { runPurge, PurgeError } from './purge.ts'
export { runInstall } from './install.ts'
export { collectStatus, runDoctor, formatStatus, formatFindings } from './diagnose.ts'
export { resolveDshHome } from './paths.ts'
export { version } from './version.ts'

const HELP = `dsh-rsi — DSH enhanced 插件集合的安装 / 控制 / 诊断 / 彻底卸载工具（v${VERSION}）

用法：
  dsh-rsi [全局选项] <命令> [命令参数]

命令：
  status      列出 DSH home、各 profile 与安装形态（npm/local）、host 版本、
              受管服务状态、外部凭据条目数、生命周期残留（只读）
  doctor      status 之外，扫描各 profile 的 host 错误日志，识别已知崩溃模式并给出建议（只读）
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

purge 选项：
  --no-backup         删除前不生成 ~/dsh-purge-backup-<UTC时间戳>.tar.gz 备份
  --keep-keychain     保留 macOS Keychain / Linux Secret Service 中的受管凭据
  --remove-host       同时卸载全局 @deepseek-ai/dsh（仅限全量 purge；默认保留）

示例：
  dsh-rsi status
  dsh-rsi doctor
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
  /** install/reinstall：原样透传给安装器的参数。 */
  passthrough: string[]
}

const KNOWN_COMMANDS = new Set(['status', 'doctor', 'install', 'reinstall', 'purge', 'version'])
const GLOBAL_FLAGS = new Set(['--dry-run', '--yes', '--help', '-h'])
const VALUE_OPTIONS = new Set(['--dsh-home', '--profile'])
const PURGE_FLAGS = new Set(['--no-backup', '--keep-keychain', '--remove-host'])
/** install/reinstall 中由 rsi 自身消费、不透传给安装器的带值选项。 */
const INSTALL_VALUE_OPTIONS = new Set(['--dsh-home', '--local'])

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
    passthrough: [],
  }
  let commandSeen = false
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (!commandSeen) {
      if (VALUE_OPTIONS.has(token)) {
        const value = argv[++i]
        if (value === undefined || value.startsWith('--')) throw new PurgeError(`${token} 需要一个值`)
        if (token === '--dsh-home') result.dshHome = value
        else result.profile = value
        continue
      }
      if (GLOBAL_FLAGS.has(token)) {
        if (token === '--dry-run') result.dryRun = true
        else if (token === '--yes') result.yes = true
        else result.help = true
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

    // 命令之后：install/reinstall 走「消费少数 rsi 选项 + 其余透传」。
    if (result.command === 'install' || result.command === 'reinstall') {
      i = consumeInstallToken(result, argv, i)
      continue
    }
    // 其它命令保持既有的严格解析。
    if (VALUE_OPTIONS.has(token)) {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) throw new PurgeError(`${token} 需要一个值`)
      if (token === '--dsh-home') result.dshHome = value
      else result.profile = value
      continue
    }
    if (GLOBAL_FLAGS.has(token)) {
      if (token === '--dry-run') result.dryRun = true
      else if (token === '--yes') result.yes = true
      else result.help = true
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

/** main 的依赖面，仅供测试注入（默认执行真实 purge/install）。 */
export interface MainDeps {
  purge?: typeof runPurge
  install?: typeof runInstall
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  deps: MainDeps = {},
): Promise<number> {
  const purge = deps.purge ?? runPurge
  const install = deps.install ?? runInstall
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
