import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PurgeError } from './purge.ts'

const INSTALL_BASE_URL = 'https://raw.githubusercontent.com/22-ai-00/dsh-enhanced'

/**
 * install 委托的外部副作用面：下载引导脚本与 stdio inherit 执行。
 * 测试注入假实现，做到不联网、不真实执行安装器。
 */
export interface InstallExecutor {
  download: (url: string) => Promise<string>
  runInherited: (
    command: string,
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv },
  ) => Promise<number>
}

export const defaultExecutor: InstallExecutor = {
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
  /** 原样透传给安装器的参数。 */
  passthrough: readonly string[]
  /** 安装器不识别 --dsh-home，统一经 DSH_HOME 环境变量传入。 */
  dshHome?: string
  executor?: InstallExecutor
}

/**
 * 薄委托：dsh-rsi 不复制任何安装逻辑。
 * npm 形态只负责把与自身版本同 tag 的 install-npm.sh 拉到临时目录执行，
 * common.sh 的 SHA-256 自校验由脚本自身完成；local 形态直接执行 checkout 内脚本。
 * 安装器 stdio 与当前终端直连，交互提示/输出不经缓冲。
 * 返回安装器退出码。
 */
export async function runInstall(options: RunInstallOptions): Promise<number> {
  const executor = options.executor ?? defaultExecutor
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (options.dshHome !== undefined) env.DSH_HOME = options.dshHome

  if (options.mode === 'local') {
    const root = options.localRepositoryRoot
    if (root === undefined || root.length === 0) {
      throw new PurgeError('local 安装形态需要 --local <checkout 目录>')
    }
    const script = join(root, 'scripts', 'install', 'install-local.sh')
    return await executor.runInherited('bash', [script, ...options.passthrough], { env })
  }

  if (!/^v\d+\.\d+\.\d+$/u.test(options.releaseRef)) {
    throw new PurgeError(`非法的 release ref：${options.releaseRef}（应为 vX.Y.Z）`)
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
    return await executor.runInherited('bash', [scriptPath, ...options.passthrough], { env })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
