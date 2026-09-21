import { homedir } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { runPurge, PurgeError } from './purge.ts'
import { collectStatus, formatStatus, formatFindings, runDoctor } from './diagnose.ts'
import { resolveDshHome } from './paths.ts'
import { version as VERSION } from './version.ts'

export { runPurge, PurgeError } from './purge.ts'
export { collectStatus, runDoctor, formatStatus, formatFindings } from './diagnose.ts'
export { resolveDshHome } from './paths.ts'
export { version } from './version.ts'

const HELP = `dsh-rsi — DSH enhanced 插件集合的控制 / 诊断 / 彻底卸载工具（v${VERSION}）

用法：
  dsh-rsi [全局选项] <命令>

命令：
  status    列出 DSH home、各 profile 与安装形态（npm/local）、host 版本、
            受管服务状态、外部凭据条目数、生命周期残留（只读）
  doctor    status 之外，扫描各 profile 的 host 错误日志，识别已知崩溃模式并给出建议（只读）
  purge     彻底卸载：停服 → 备份 → 删除 profile/DSH home → 清理外部凭据
  version   打印 dsh-rsi 版本

全局选项：
  --dsh-home <path>   指定 DSH home（默认取 $DSH_HOME，否则 ~/.dsh）
  --profile <name>    仅操作单个 profile（purge 默认全量）
  --dry-run           只打印将执行的动作，不做任何修改
  --yes               purge 时跳过交互确认（脚本/管道场景使用）

purge 选项：
  --no-backup         删除前不生成 ~/dsh-purge-backup-<UTC时间戳>.tar.gz 备份
  --keep-keychain     保留 macOS Keychain / Linux Secret Service 中的受管凭据
  --remove-host       同时卸载全局 @deepseek-ai/dsh（仅限全量 purge；默认保留）

示例：
  dsh-rsi status
  dsh-rsi doctor
  dsh-rsi purge --dry-run
  dsh-rsi purge --profile web
  dsh-rsi purge --yes
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
}

const KNOWN_COMMANDS = new Set(['status', 'doctor', 'purge', 'version'])
const GLOBAL_FLAGS = new Set(['--dry-run', '--yes', '--help', '-h'])
const VALUE_OPTIONS = new Set(['--dsh-home', '--profile'])
const PURGE_FLAGS = new Set(['--no-backup', '--keep-keychain', '--remove-host'])

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
  }
  let commandSeen = false
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
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
    if (!token.startsWith('-') && KNOWN_COMMANDS.has(token) && !commandSeen) {
      result.command = token
      commandSeen = true
      continue
    }
    throw new PurgeError(`无法识别的参数：${token}（用 -h 查看用法）`)
  }
  return result
}

async function confirmPurge(args: ParsedArgs): Promise<boolean> {
  const scope = args.profile === undefined ? '整个 DSH home（全部 profile）' : `profile ${args.profile}`
  const backup = args.backup ? '会先在 ~ 生成 tar.gz 备份' : '不会备份（--no-backup）'
  const host = args.removeHost ? '\n  - 同时卸载全局 @deepseek-ai/dsh' : ''
  process.stdout.write(`即将彻底删除 ${scope}：
  - DSH home 内的 profile 数据与受管日志
  - 生命周期事务/锁残留
  - 受管常驻服务（launchd / systemd --user）
  - ${backup}${args.keepKeychain ? '' : '\n  - macOS Keychain / Linux Secret Service 中的受管凭据'}${host}
local checkout 源码不会被删除。输入 purge 后回车继续：`)
  const reader = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await reader.question('')).trim()
    return answer === 'purge'
  } finally {
    reader.close()
  }
}

function formatPurgeReport(args: ParsedArgs, report: Awaited<ReturnType<typeof runPurge>>): string {
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
    lines.push('如需重装：重跑 install-npm.sh / install-local.sh，或 npm i -g @dsh-enhanced/rsi-cli 后再装插件集合。')
  }
  return lines.join('\n')
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
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
      case 'purge': {
        if (!args.dryRun && !args.yes) {
          const confirmed = await confirmPurge(args)
          if (!confirmed) {
            process.stdout.write('已取消（未输入 purge）。\n')
            return 1
          }
        }
        const report = await runPurge({
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
      process.stderr.write(`purge 失败：${error.message}\n`)
      return 1
    }
    process.stderr.write(`错误：${(error as Error).stack ?? (error as Error).message}\n`)
    return 1
  }
}
