import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PurgeError } from './purge.ts'
import { prepareInstallHostEnvironment } from './install-host.ts'
import { resolveDshHome } from './paths.ts'

const INSTALL_BASE_URL = 'https://raw.githubusercontent.com/22-ai-00/dsh-enhanced'

/**
 * install 委托的外部副作用面：下载引导脚本与 stdio inherit 执行。
 * 测试注入假实现，做到不联网、不真实执行安装器。
 */
export interface InstallExecutor {
  /** Custom executors may supply their own Host; the production executor always
   * prepares or verifies the Home-bound runtime before invoking the installer. */
  prepareHost?: typeof prepareInstallHostEnvironment
  download: (url: string) => Promise<string>
  runInherited: (
    command: string,
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv },
  ) => Promise<number>
}

export const defaultExecutor: InstallExecutor = {
  prepareHost: prepareInstallHostEnvironment,
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
  if (executor.prepareHost
    && !options.passthrough.some(arg => ['--help','-h','--dry-run'].includes(arg))) {
    env = await executor.prepareHost({dshHome:resolveDshHome(env),selector,environment:env,prepareFresh:operation === 'install'})
  }

  if (options.mode === 'local') {
    const root = options.localRepositoryRoot
    if (root === undefined || root.length === 0) {
      throw new PurgeError('local 安装形态需要 --local <checkout 目录>')
    }
    const script = join(root, 'scripts', 'install', 'install-local.sh')
    return await executor.runInherited('bash', [script, ...passthrough], { env })
  }

  const url = `${INSTALL_BASE_URL}/${options.releaseRef}/scripts/install/install-npm.sh`
  let scriptBody: string
  try {
    scriptBody = await executor.download(url)
  } catch (error) {
    throw new PurgeError(
      `下载 install-npm.sh 失败（${url}）：${(error as Error).message}。请检查网络，或改用 local 形态。`,
    )
  }

  const staging = await mkdtemp(join(tmpdir(), 'dsh-rsi-install-'))
  const scriptPath = join(staging, 'install-npm.sh')
  try {
    await writeFile(scriptPath, scriptBody, { mode: 0o700 })
    await chmod(scriptPath, 0o700)
    return await executor.runInherited('bash', [scriptPath, ...passthrough], { env })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
