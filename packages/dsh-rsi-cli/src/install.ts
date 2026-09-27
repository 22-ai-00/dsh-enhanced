import { spawn } from 'node:child_process'
import { chmod, lstat, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { PurgeError } from './purge.ts'
import { prepareHostUpdatePlan, prepareInstallHostEnvironment } from './install-host.ts'
import { resolveDshHome, TRANSACTION_SUFFIX } from './paths.ts'

const INSTALL_BASE_URL = 'https://raw.githubusercontent.com/22-ai-00/dsh-enhanced'

/**
 * install 委托的外部副作用面：下载引导脚本与 stdio inherit 执行。
 * 测试注入假实现，做到不联网、不真实执行安装器。
 */
export interface InstallExecutor {
  /** Custom executors may supply their own Host; the production executor always
   * prepares or verifies the Home-bound runtime before invoking the installer. */
  prepareHost?: typeof prepareInstallHostEnvironment
  prepareHostUpdate?: typeof prepareHostUpdatePlan
  download: (url: string) => Promise<string>
  runInherited: (
    command: string,
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv },
  ) => Promise<number>
}

export const defaultExecutor: InstallExecutor = {
  prepareHost: prepareInstallHostEnvironment,
  prepareHostUpdate: prepareHostUpdatePlan,
  async download(url: string): Promise<string> {
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.text()
  },
  runInherited(command, args, options): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], { stdio: 'inherit', env: options.env })
      child.on('error', reject)
      child.on('close', code => resolve(code ?? 1))
    })
  },
}

export interface RunInstallOptions {
  /** npm 形态：下载该 release ref（vX.Y.Z）的 install-npm.sh；local 形态：执行 checkout 内 install-local.sh。 */
  mode: 'npm' | 'local'
  /** local 形态的 checkout 根目录（须含 scripts/install/install-local.sh）。 */
  localRepositoryRoot?: string
  /** npm 形态拉取引导脚本的 release ref；rsi-cli 默认传与自身版本一致的 vX.Y.Z。 */
  releaseRef: string
  /** 用户传入的安装器参数；默认 install 在委派副本末尾补 supervised 场景。 */
  passthrough: readonly string[]
  /** 安装器不识别 --dsh-home，统一经 DSH_HOME 环境变量传入。 */
  dshHome?: string
  executor?: InstallExecutor
  /** Recover a pending v4 Host transaction, then return for caller preflight. */
  recoveryOnly?: boolean
}

async function canonicalMissingAllowed(path: string): Promise<string> {
  let cursor = resolve(path)
  const suffix: string[] = []
  const visited = new Set<string>()
  for (;;) {
    if (visited.has(cursor)) throw new PurgeError('DSH_HOME 符号链接成环。')
    visited.add(cursor)
    try {
      const entry = await lstat(cursor)
      if (entry.isSymbolicLink()) {
        const target = await readlink(cursor)
        cursor = isAbsolute(target) ? resolve(target) : resolve(dirname(cursor), target)
        continue
      }
      return resolve(await realpath(cursor), ...suffix)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw error
      suffix.unshift(cursor.slice(parent.length + (parent === '/' ? 0 : 1)))
      cursor = parent
    }
  }
}

async function pendingHostRecovery(homePath: string): Promise<string | undefined> {
  const path = `${homePath}${TRANSACTION_SUFFIX}/manifest.json`
  const info = await lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (info === undefined) return undefined
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.()
    || (info.mode & 0o077) !== 0 || info.size > 2 * 1024 * 1024) {
    throw new PurgeError('已有 Host 事务 manifest 文件不安全，拒绝继续升级。')
  }
  let manifest: unknown
  try { manifest = JSON.parse(await readFile(path, 'utf8')) }
  catch { throw new PurgeError('已有 Host 事务 manifest 无法解析，拒绝继续升级。') }
  if (typeof manifest !== 'object' || manifest === null || !('version' in manifest) || manifest.version !== 4) return undefined
  if (!('profile' in manifest) || typeof manifest.profile !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(manifest.profile)) {
    throw new PurgeError('已有 Host 事务 profile 无效，拒绝继续升级。')
  }
  return manifest.profile
}

export async function hasPendingHostRecovery(dshHome: string): Promise<boolean> {
  return await pendingHostRecovery(await canonicalMissingAllowed(dshHome)) !== undefined
}

/**
 * 新 Home 先选择私有 Host，再委托现有安装器。
 * npm 形态只负责把与自身版本同 tag 的 install-npm.sh 拉到临时目录执行，
 * common.sh 的 SHA-256 自校验由脚本自身完成；local 形态直接执行 checkout 内脚本。
 * 安装器 stdio 与当前终端直连，交互提示/输出不经缓冲。
 * 返回安装器退出码。
 */
export async function runInstall(options: RunInstallOptions): Promise<number> {
  const executor = options.executor ?? defaultExecutor
  let env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of ['DSH_ENHANCED_HOST_UPDATE_PLAN', 'DSH_ENHANCED_HOST_UPDATE_BIN',
    'DSH_ENHANCED_HOST_SELECTOR_VALIDATED', 'DSH_ENHANCED_HOST_RECOVERY_ONLY',
    'DSH_ENHANCED_HOST_RECOVERY_PROFILE']) delete env[name]
  if (options.dshHome !== undefined) env.DSH_HOME = options.dshHome

  // Validate the invocation before preparing a runtime or touching the Home.
  if (options.mode === 'local' && !options.localRepositoryRoot) throw new PurgeError('local 安装形态需要 --local <checkout 目录>')
  if (options.mode === 'npm' && !/^v\d+\.\d+\.\d+$/u.test(options.releaseRef)) throw new PurgeError(`非法的 release ref：${options.releaseRef}（应为 vX.Y.Z）`)
  const value = (name: string): string | undefined => {
    const index = options.passthrough.indexOf(name)
    if (index < 0) return undefined
    const result = options.passthrough[index+1]
    if (!result || result.startsWith('-') || options.passthrough.lastIndexOf(name) !== index) {
      throw new PurgeError(`${name} 必须提供一个且仅一个值。`)
    }
    return result
  }
  const operation = value('--operation') ?? 'install'
  const selector = value('--dsh-version') ?? 'latest'
  const help = options.passthrough.includes('--help') || options.passthrough.includes('-h')
  const explicitlySet = (name: string): boolean => {
    let present = false
    for (let index = 0; index < options.passthrough.length; index++) {
      if (options.passthrough[index] !== name) continue
      const selected = options.passthrough[index + 1]
      if (!selected || selected.startsWith('-')) throw new PurgeError(`${name} 必须提供一个值。`)
      present = true
    }
    return present
  }
  const scenarioExplicit = !help && explicitlySet('--scenario')
  const modeExplicit = !help && explicitlySet('--mode')
  const passthrough = operation === 'install' && !help && !scenarioExplicit && !modeExplicit
    ? [...options.passthrough, '--scenario', 'supervised']
    : options.passthrough
  const inactive = options.passthrough.some(arg => ['--help', '-h', '--dry-run'].includes(arg))
  let installerStaging: string | undefined
  let planStaging: string | undefined
  try {
    let script: string
    if (options.mode === 'local') {
      script = join(options.localRepositoryRoot!, 'scripts', 'install', 'install-local.sh')
    } else {
      const url = `${INSTALL_BASE_URL}/${options.releaseRef}/scripts/install/install-npm.sh`
      let source: string
      try { source = await executor.download(url) }
      catch (error) {
        throw new PurgeError(`下载 install-npm.sh 失败（${url}）：${(error as Error).message}。请检查网络，或改用 local 形态。`)
      }
      installerStaging = await mkdtemp(join(tmpdir(), 'dsh-rsi-install-'))
      script = join(installerStaging, 'install-npm.sh')
      await writeFile(script, source, { mode: 0o700 })
      await chmod(script, 0o700)
    }
    if (operation === 'upgrade' && !inactive) {
      const canonicalHome = await canonicalMissingAllowed(resolveDshHome(env))
      const recoveryProfile = await pendingHostRecovery(canonicalHome)
      if (recoveryProfile !== undefined) {
        const recovered = await executor.runInherited('bash', [script, ...passthrough], {
          env: { ...env, DSH_HOME: canonicalHome, DSH_ENHANCED_HOST_RECOVERY_ONLY: '1',
            DSH_ENHANCED_HOST_RECOVERY_PROFILE: recoveryProfile },
        })
        if (recovered !== 0) return recovered
        if (options.recoveryOnly) return 0
      }
    }
    if (options.recoveryOnly) throw new PurgeError('没有待恢复的 v4 Host 事务。')
    if (executor.prepareHost && !inactive) {
      env = await executor.prepareHost({ dshHome: resolveDshHome(env),
        selector: operation === 'upgrade' ? 'latest' : selector, environment: env,
        prepareFresh: operation === 'install' })
    }
    if (operation === 'upgrade' && !inactive && executor.prepareHostUpdate) {
      const home = await canonicalMissingAllowed(resolveDshHome(env))
      const binding = await lstat(join(home, '.dsh-rsi-host.json')).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      })
      if (binding === undefined) {
        if (selector !== 'latest') throw new PurgeError('现有 Home 没有私有 Host 绑定；不能用 --dsh-version 修改全局 Host。')
        process.stdout.write('现有 Home 未绑定私有 Host；保留当前 Host，仅升级插件集合。\n')
      } else {
        const plan = await executor.prepareHostUpdate({ dshHome: home, selector })
        env = { ...env, DSH_ENHANCED_HOST_SELECTOR_VALIDATED: '1' }
        if (plan.status === 'update') {
          planStaging = await mkdtemp(join(tmpdir(), 'dsh-rsi-host-plan-'))
          const planPath = join(planStaging, 'plan.json')
          await writeFile(planPath, `${JSON.stringify(plan)}\n`, { mode: 0o600 })
          env = { ...env, DSH_ENHANCED_HOST_UPDATE_PLAN: planPath,
            DSH_ENHANCED_HOST_UPDATE_BIN: plan.candidateRuntime.binDirectory }
        } else process.stdout.write(`私有 Host 已是当前版本：${plan.originalRuntime.version}\n`)
      }
    }
    return await executor.runInherited('bash', [script, ...passthrough], { env })
  } finally {
    if (planStaging !== undefined) await rm(planStaging, { recursive: true, force: true })
    if (installerStaging !== undefined) await rm(installerStaging, { recursive: true, force: true })
  }
}
