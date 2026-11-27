import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { persistConfirmModulesPurgeDisabled } from './build-approvals.js'
import { defaultIsExecutable } from './probes.js'
import { hasControlChars, isSingleLineCommand } from './settings.js'
import { buildUpgradeProbeEnv, discoverToolRuntimeBinary } from './upgrade-probe.js'

const PNPM_RECONCILE_TIMEOUT_MS = 120_000
const DSH_APP_PNPM_BIN_REL = join('Resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin')
const DSH_APP_PNPM_SCRIPTS = ['pnpm.mjs', 'pnpm.cjs'] as const

export type PnpmStoreSpawnProcessLike = Pick<ChildProcess, 'kill'> & {
  once(event: 'error', listener: (error: unknown) => void): unknown
  once(event: 'close', listener: (code: number | null) => void): unknown
}

export type PnpmStoreSpawnFn = (
  command: string,
  args: readonly string[],
  options: Readonly<{
    env: NodeJS.ProcessEnv
    stdio: 'ignore'
    shell: boolean
    windowsHide: boolean
  }>,
) => PnpmStoreSpawnProcessLike

export interface ReconcileProfilePnpmStoreOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly osHome?: string
  readonly execPath?: string
  readonly spawnFn?: PnpmStoreSpawnFn
  readonly timeoutMs?: number
}

interface ResolvedPnpmInvocation {
  readonly command: string
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv
}

function isNodeExecutablePath(execPath: string): boolean {
  const base = basename(execPath).toLowerCase()
  return base === 'node' || base.startsWith('node.') || base.startsWith('node-')
}

function isReadableRegularFile(filePath: string): boolean {
  try {
    accessSync(filePath, constants.R_OK)
    return statSync(filePath).isFile()
  } catch {
    return false
  }
}

function resolveDarwinBundledPnpmScript(
  env: NodeJS.ProcessEnv,
  osHome: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== 'darwin') return undefined
  const contentsDirs: string[] = []
  const desktopExec = env['DSH_DESKTOP_NODE_EXECUTABLE']?.trim()
  if (desktopExec && !hasControlChars(desktopExec)) {
    const marker = `.app${sep}Contents${sep}`
    const markerIdx = desktopExec.indexOf(marker)
    if (markerIdx !== -1) {
      contentsDirs.push(desktopExec.slice(0, markerIdx + `.app${sep}Contents`.length))
    }
  }
  if (resolve(osHome) === resolve(homedir())) {
    contentsDirs.push('/Applications/DeepSeek Harness.app/Contents')
  }
  contentsDirs.push(join(osHome, 'Applications', 'DeepSeek Harness.app', 'Contents'))

  for (const contentsDir of contentsDirs) {
    for (const scriptName of DSH_APP_PNPM_SCRIPTS) {
      const candidate = join(contentsDir, DSH_APP_PNPM_BIN_REL, scriptName)
      if (isReadableRegularFile(candidate)) return candidate
    }
  }
  return undefined
}

function resolveNodeForBundledPnpm(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  execPath: string,
): Readonly<{ command: string; envOverrides: NodeJS.ProcessEnv; binDir?: string }> {
  const desktopExec = env['DSH_DESKTOP_NODE_EXECUTABLE']?.trim()
  if (desktopExec && isSingleLineCommand(desktopExec) && defaultIsExecutable(desktopExec, platform)) {
    const isNode = isNodeExecutablePath(desktopExec)
    return {
      command: desktopExec,
      envOverrides: isNode ? {} : { ELECTRON_RUN_AS_NODE: '1' },
      ...(isNode ? { binDir: dirname(desktopExec) } : {}),
    }
  }
  if (isNodeExecutablePath(execPath)) {
    return { command: execPath, envOverrides: {}, binDir: dirname(execPath) }
  }
  const discoveredNode = discoverToolRuntimeBinary('node', env, platform, [], execPath)
  if (discoveredNode !== undefined) {
    return { command: discoveredNode, envOverrides: {}, binDir: dirname(discoveredNode) }
  }
  return { command: execPath, envOverrides: { ELECTRON_RUN_AS_NODE: '1' } }
}

function resolvePnpmInvocation(
  manager: unknown,
  envSource: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  osHome: string,
  execPath: string,
): ResolvedPnpmInvocation | undefined {
  const mgr = (manager !== null && typeof manager === 'object' ? manager : undefined) as {
    profile?: {
      packageManager?: {
        command?: unknown
        args?: unknown
        env?: unknown
      }
    }
    pnpmCommand?: unknown
  } | undefined

  const pm = mgr?.profile?.packageManager
  const profileCmd = typeof pm?.command === 'string' ? pm.command.trim() : ''
  const managerCmd = typeof mgr?.pnpmCommand === 'string' ? mgr.pnpmCommand.trim() : ''
  const explicitCmd = profileCmd !== '' ? profileCmd : managerCmd

  const discoveredNode = discoverToolRuntimeBinary('node', envSource, platform, [], execPath)

  if (explicitCmd !== '') {
    if (!isSingleLineCommand(explicitCmd)) return undefined
    const rawArgs = profileCmd !== '' && Array.isArray(pm?.args) ? pm.args : []
    const prefixArgs = rawArgs.filter((arg): arg is string => typeof arg === 'string')
    if (prefixArgs.some(arg => hasControlChars(arg))) return undefined
    const pmEnv = profileCmd !== '' && pm?.env !== null && typeof pm?.env === 'object' && !Array.isArray(pm.env)
      ? pm.env as NodeJS.ProcessEnv
      : undefined
    const extraBinDirs: string[] = []
    if (isAbsolute(explicitCmd)) extraBinDirs.push(dirname(explicitCmd))
    if (discoveredNode !== undefined) extraBinDirs.push(dirname(discoveredNode))
    const baseEnv = buildUpgradeProbeEnv(envSource, platform, null, { extraBinDirs, execPath })
    return {
      command: explicitCmd,
      args: prefixArgs,
      env: { ...baseEnv, ...pmEnv, CI: 'true' },
    }
  }

  const bundledScript = resolveDarwinBundledPnpmScript(envSource, osHome, platform)
  if (bundledScript !== undefined) {
    const nodeRt = resolveNodeForBundledPnpm(envSource, platform, execPath)
    const extraBinDirs: string[] = []
    if (nodeRt.binDir !== undefined) extraBinDirs.push(nodeRt.binDir)
    if (discoveredNode !== undefined) extraBinDirs.push(dirname(discoveredNode))
    const baseEnv = buildUpgradeProbeEnv(envSource, platform, null, { extraBinDirs, execPath })
    return {
      command: nodeRt.command,
      args: [bundledScript],
      env: { ...baseEnv, ...nodeRt.envOverrides, CI: 'true' },
    }
  }

  const discoveredPnpm = discoverToolRuntimeBinary('pnpm', envSource, platform, [], execPath)
  const extraBinDirs: string[] = []
  if (discoveredNode !== undefined) extraBinDirs.push(dirname(discoveredNode))
  if (discoveredPnpm !== undefined) extraBinDirs.push(dirname(discoveredPnpm))
  const fallbackCommand = discoveredPnpm ?? 'pnpm'
  if (!isSingleLineCommand(fallbackCommand)) return undefined
  return {
    command: fallbackCommand,
    args: [],
    env: { ...buildUpgradeProbeEnv(envSource, platform, null, { extraBinDirs, execPath }), CI: 'true' },
  }
}

/**
 * Reconcile a profile's pnpm virtual store (`node_modules/.modules.yaml` / store v10 vs v11)
 * by running `pnpm install --no-frozen-lockfile --ignore-scripts --config.confirmModulesPurge=false`
 * with `shell: false` and `CI=true` after persisting `confirmModulesPurge: false`.
 */
export async function reconcileProfilePnpmStore(
  dir: string,
  manager: unknown,
  options: ReconcileProfilePnpmStoreOptions = {},
): Promise<boolean> {
  if (typeof dir !== 'string' || dir.trim() === '' || hasControlChars(dir)) return false
  await persistConfirmModulesPurgeDisabled(dir).catch(() => false)

  const envSource = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const osHome = options.osHome ?? (envSource['HOME']?.trim() || homedir())
  const execPath = options.execPath ?? process.execPath
  const spawnFn: PnpmStoreSpawnFn = options.spawnFn
    ?? ((command, spawnArgs, spawnOptions) => spawn(command, [...spawnArgs], spawnOptions))
  const timeoutMs = options.timeoutMs ?? PNPM_RECONCILE_TIMEOUT_MS

  const resolved = resolvePnpmInvocation(manager, envSource, platform, osHome, execPath)
  if (resolved === undefined) return false

  const args = [
    ...resolved.args,
    'install',
    '--dir',
    dir,
    '--no-frozen-lockfile',
    '--ignore-scripts',
    '--config.confirmModulesPurge=false',
  ]

  return await new Promise<boolean>((resolvePromise) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolvePromise(ok)
    }

    let child: PnpmStoreSpawnProcessLike
    try {
      child = spawnFn(resolved.command, args, {
        env: resolved.env,
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      })
    } catch {
      finish(false)
      return
    }

    timer = setTimeout(() => {
      try {
        if (typeof child.kill === 'function') child.kill('SIGTERM')
      } catch {
        // Best-effort termination on timeout.
      }
      finish(false)
    }, timeoutMs)
    timer.unref?.()

    child.once('error', () => finish(false))
    child.once('close', code => finish(code === 0))
  })
}
