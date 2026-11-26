import { spawn, spawnSync } from 'node:child_process'
import { delimiter } from 'node:path'
import { listProfilePlugins, listProfiles } from './paths.ts'
import { defaultRunner, findRunningProfiles, type CommandRunner } from './run.ts'
import { inspectManagedService } from './services.ts'
import { inspectBoundHostRuntime, type BoundHostInspection } from './install-host.ts'
import { extractWebUrlFromText, waitForManagedWebUrl, type ProfileWebUrl } from './weburl.ts'

export interface OpenWebOptions {
  dshHome: string
  home: string
  platform: NodeJS.Platform
  profile?: string
  waitSeconds?: number
  noBrowser?: boolean
  dryRun?: boolean
  env?: NodeJS.ProcessEnv
  runner?: CommandRunner
  readHostRuntime?: Parameters<typeof inspectBoundHostRuntime>[1] extends infer P
    ? P extends { read?: infer R } ? R : never
    : never
  resolveWebUrl?: typeof import('./weburl.ts').resolveManagedWebUrl
  sleep?: (ms: number) => Promise<void>
  openBrowser?: (url: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv) => BrowserOpenResult
  launchForegroundHost?: (input: {
    executable: string
    args: readonly string[]
    env: NodeJS.ProcessEnv
    onUrl: (url: string) => void
  }) => Promise<number>
  stdout?: { write: (chunk: string) => void }
  stderr?: { write: (chunk: string) => void }
}

export interface BrowserOpenResult {
  opened: boolean
  skippedReason?: string
  error?: string
}

export interface OpenWebOutcome {
  exitCode: number
  profile?: string
  url?: string
  mode?: 'managed' | 'foreground' | 'dry-run'
  ownerConsoleInstalled?: boolean
  browser?: BrowserOpenResult
}

/** Determine whether the current environment has a desktop session able to open a browser. */
export function canOpenBrowser(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): { ok: boolean; reason?: string } {
  if (platform === 'darwin') return { ok: true }
  if (platform === 'linux') {
    if (env.DISPLAY || env.WAYLAND_DISPLAY) return { ok: true }
    return { ok: false, reason: '当前会话未检测到 DISPLAY / WAYLAND_DISPLAY（无图形桌面）' }
  }
  return { ok: false, reason: `当前平台 ${platform} 未配置自动打开浏览器` }
}

/** Open `url` in the system browser without invoking a shell. */
export function defaultOpenBrowser(
  url: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): BrowserOpenResult {
  const desktop = canOpenBrowser(platform, env)
  if (!desktop.ok) return { opened: false, ...(desktop.reason ? { skippedReason: desktop.reason } : {}) }
  const command = platform === 'darwin' ? 'open' : 'xdg-open'
  const result = spawnSync(command, [url], {
    stdio: 'ignore',
    timeout: 5_000,
    env,
  })
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || `退出码 ${result.status}`
    return { opened: false, error: `${command} 启动失败：${detail}` }
  }
  return { opened: true }
}

function ownerConsoleHint(profile: string, ownerConsoleInstalled: boolean): string {
  if (ownerConsoleInstalled) {
    return 'Owner Console（文鳐 / Ray）：已随当前 profile 安装；打开上方 Web URL 后在侧边栏或设置中进入「文鳐」控制台。'
  }
  return `提示：当前 profile 尚未启用 owner-console，可运行 dsh-ray install --profile ${profile} --with console 启用。`
}

async function selectOpenProfile(dshHome: string, requested?: string): Promise<{ profile?: string; error?: string }> {
  const available = await listProfiles(dshHome)
  if (requested !== undefined) {
    if (!available.includes(requested)) {
      const hint = available.length > 0 ? `可用 profile：${available.join('、')}` : '当前没有任何已安装 profile'
      return { error: `open：profile "${requested}" 不存在（${dshHome}；${hint}）。请先运行 dsh-ray install --profile ${requested}。` }
    }
    return { profile: requested }
  }
  if (available.length === 0) {
    return { error: `open：${dshHome} 下没有任何 profile，请先运行 dsh-ray install。` }
  }
  if (available.length === 1 && available[0] !== undefined) return { profile: available[0] }
  if (available.includes('web')) return { profile: 'web' }
  return {
    error: `open：检测到多个 profile（${available.join('、')}），请使用 --profile <名称> 指定要打开的 profile。`,
  }
}

function resolveExecutable(bound: BoundHostInspection): { executable?: string; error?: string } {
  if (bound.status === 'ready' && bound.dshPath) {
    return { executable: bound.dshPath }
  }
  if (bound.status === 'missing') {
    return { executable: 'dsh' }
  }
  const detail = bound.error || bound.issues.join('；') || '未知绑定状态'
  return {
    error: `open：私有 Host 绑定异常（${bound.bindingPath}：${detail}）。请运行 dsh-ray doctor 检查，或用 dsh-ray update --all / reinstall 修复。`,
  }
}

async function spawnForegroundDsh(input: {
  executable: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  onUrl: (url: string) => void
}): Promise<number> {
  return await new Promise<number>(resolve => {
    const child = spawn(input.executable, [...input.args], {
      env: input.env,
      stdio: ['inherit', 'pipe', 'pipe'],
    })
    let urlFound = false
    let urlBuffer = ''
    const inspectChunk = (chunk: Buffer, target: NodeJS.WriteStream): void => {
      const text = chunk.toString('utf8')
      target.write(text)
      if (!urlFound) {
        urlBuffer = (urlBuffer + text).slice(-4096)
        const newline = urlBuffer.lastIndexOf('\n')
        const complete = newline >= 0 ? urlBuffer.slice(0, newline) : ''
        const extracted = extractWebUrlFromText(complete)
        if (extracted !== undefined) {
          urlFound = true
          input.onUrl(extracted)
        }
      }
    }
    child.stdout?.on('data', chunk => inspectChunk(chunk as Buffer, process.stdout))
    child.stderr?.on('data', chunk => inspectChunk(chunk as Buffer, process.stderr))
    const forward = (signal: NodeJS.Signals): void => {
      if (!child.killed) child.kill(signal)
    }
    const onSigInt = (): void => forward('SIGINT')
    const onSigTerm = (): void => forward('SIGTERM')
    process.once('SIGINT', onSigInt)
    process.once('SIGTERM', onSigTerm)
    child.once('error', error => {
      process.off('SIGINT', onSigInt)
      process.off('SIGTERM', onSigTerm)
      process.stderr.write(`open：无法启动 ${input.executable}：${error.message}\n`)
      resolve(1)
    })
    child.once('exit', (code, signal) => {
      process.off('SIGINT', onSigInt)
      process.off('SIGTERM', onSigTerm)
      if (code !== null) resolve(code)
      else resolve(signal ? 1 : 0)
    })
  })
}

function presentUrl(
  stdout: { write: (chunk: string) => void },
  stderr: { write: (chunk: string) => void },
  profile: string,
  url: string,
  source: string | undefined,
  ownerConsoleInstalled: boolean,
  options: OpenWebOptions,
): BrowserOpenResult | undefined {
  stdout.write(`Web URL（${profile}）：${url}\n`)
  if (source) stdout.write(`来源：${source}\n`)
  stdout.write(`${ownerConsoleHint(profile, ownerConsoleInstalled)}\n`)
  if (options.noBrowser) {
    stdout.write('已指定 --no-browser，仅输出授权 URL。\n')
    return { opened: false, skippedReason: '--no-browser' }
  }
  const opener = options.openBrowser ?? defaultOpenBrowser
  const browser = opener(url, options.platform, options.env ?? process.env)
  if (!browser.opened) {
    if (browser.skippedReason) {
      stdout.write(`未自动拉起浏览器（${browser.skippedReason}）；请直接打开上方带 token 的 URL。\n`)
    } else if (browser.error) {
      stderr.write(`警告：${browser.error}；请手动复制上方 URL 打开。\n`)
    }
  }
  return browser
}

/**
 * Resolve or launch a DSH profile's Web UI, print the authorized URL + Owner Console hint,
 * and open it in the browser when a graphical desktop is available.
 */
export async function openWebProfile(options: OpenWebOptions): Promise<OpenWebOutcome> {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const runner = options.runner ?? defaultRunner
  const env = options.env ?? process.env
  const waitMs = Math.max(0, Math.round((options.waitSeconds ?? 8) * 1000))

  const chosen = await selectOpenProfile(options.dshHome, options.profile)
  if (!chosen.profile) {
    stderr.write(`${chosen.error}\n`)
    return { exitCode: 1 }
  }
  const profile = chosen.profile

  const bound = await inspectBoundHostRuntime(
    options.dshHome,
    options.readHostRuntime ? { read: options.readHostRuntime } : {},
  )
  const resolved = resolveExecutable(bound)
  if (!resolved.executable) {
    stderr.write(`${resolved.error}\n`)
    return { exitCode: 1, profile }
  }

  const plugins = await listProfilePlugins(options.dshHome, profile)
  const ownerConsoleInstalled = plugins.some(plugin => plugin.name === '@dsh-ray/owner-console')
  const presence = await inspectManagedService(options.platform, options.home, profile, options.dshHome, runner)

  if (presence.managed) {
    if (options.dryRun) {
      stdout.write(`【dry-run】将从受管服务 ${profile} 等待并解析 Web URL（最长 ${Math.round(waitMs / 1000)}s），然后打开 Web UI${options.noBrowser ? '（--no-browser：不拉起浏览器）' : ''}。\n`)
      stdout.write(`${ownerConsoleHint(profile, ownerConsoleInstalled)}\n`)
      return { exitCode: 0, profile, mode: 'dry-run', ownerConsoleInstalled }
    }
    const entry: ProfileWebUrl = await waitForManagedWebUrl(options.platform, options.home, options.dshHome, profile, {
      waitMs,
      runner,
      ...(options.resolveWebUrl ? { resolve: options.resolveWebUrl } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    })
    if (entry.url !== undefined) {
      const browser = presentUrl(stdout, stderr, profile, entry.url, entry.source, ownerConsoleInstalled, options)
      return {
        exitCode: 0,
        profile,
        url: entry.url,
        mode: 'managed',
        ownerConsoleInstalled,
        ...(browser ? { browser } : {}),
      }
    }
    if (entry.errors.length > 0) {
      for (const error of entry.errors) stderr.write(`open：${error}\n`)
    } else if (entry.notice) {
      stderr.write(`open：${entry.notice}\n`)
    } else {
      stderr.write(`open：未能从受管服务 ${profile} 获取 Web URL；请运行 dsh-ray logs --profile ${profile} 检查。\n`)
    }
    return { exitCode: 1, profile, mode: 'managed', ownerConsoleInstalled }
  }

  if (presence.foreign) {
    stderr.write(`open：${presence.definitionPath} 存在但不是 dsh-ray 受管服务；已拒绝代管服务。\n`)
    return { exitCode: 1, profile }
  }

  const running = findRunningProfiles([profile], runner)
  if (running.error) {
    stderr.write(`open：检查运行中进程失败：${running.error}\n`)
    return { exitCode: 1, profile }
  }
  if (running.active.length > 0) {
    stderr.write(`open：profile "${profile}" 已有运行中的 DSH 进程（PID ${running.active.map(item => item.pid).join(', ')}）。请切换回启动该进程的终端查看 \`dsh web:\` URL，或改用受管服务（dsh-ray install --profile ${profile} --scenario web/supervised）。\n`)
    return { exitCode: 1, profile }
  }

  const args = ['--profile', profile, '--no-open']
  if (options.dryRun) {
    stdout.write(`【dry-run】将运行：DSH_HOME=${options.dshHome} ${resolved.executable} ${args.join(' ')}，等待输出 dsh web URL 后打开浏览器。\n`)
    stdout.write(`${ownerConsoleHint(profile, ownerConsoleInstalled)}\n`)
    return { exitCode: 0, profile, mode: 'dry-run', ownerConsoleInstalled }
  }

  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    DSH_HOME: options.dshHome,
    ...(bound.binDirectory
      ? {
          DSH_RAY_HOST_BIN: bound.binDirectory,
          PATH: [bound.binDirectory, env.PATH ?? ''].filter(Boolean).join(delimiter),
        }
      : {}),
  }
  let capturedUrl: string | undefined
  let capturedBrowser: BrowserOpenResult | undefined
  const launcher = options.launchForegroundHost ?? spawnForegroundDsh
  const exitCode = await launcher({
    executable: resolved.executable,
    args,
    env: childEnv,
    onUrl: url => {
      capturedUrl = url
      capturedBrowser = presentUrl(stdout, stderr, profile, url, undefined, ownerConsoleInstalled, options)
    },
  })
  return {
    exitCode,
    profile,
    ...(capturedUrl ? { url: capturedUrl } : {}),
    mode: 'foreground',
    ownerConsoleInstalled,
    ...(capturedBrowser ? { browser: capturedBrowser } : {}),
  }
}
