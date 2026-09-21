import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { CommandRunner } from './run.ts'
import { launchAgentTargets, systemdUnitName, systemdUserDirectory, SYSTEMD_UNIT_PATTERN } from './paths.ts'

/** 判定一个 systemd unit 文件确为 dsh-enhanced 安装器渲染的受管 unit（lifecycle-profile.mjs rendererUnitPattern）。 */
async function isManagedUnitFile(path: string, profile: string): Promise<boolean> {
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch {
    return false
  }
  return source.includes('DeepSeek Harness profile')
    && source.includes(`--profile ${profile} `)
    && source.includes('--no-open')
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
        managed = source.includes('DeepSeek Harness profile')
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
