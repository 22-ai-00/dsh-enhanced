import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, posix, win32 } from 'node:path'
import { canonicalAbsolutePath, isPathWithinOrEqual, isPrivateDirectoryStats, safeWorkspaceTree } from './fs-ownership.js'
import {
  buildMacosSeatbeltCommandProfile,
  buildScrubbedMacosEnv,
  DEFAULT_MACOS_SANDBOX_EXEC,
  runMacosSeatbeltCommand,
  type MacosSeatbeltAdapter,
} from './macos-command.js'
import { resolveIsolationBackend, type IsolationBackend, type IsolationBackendConfig } from './platform.js'
import {
  buildScrubbedWindowsEnv,
  buildWindowsJobRunnerInvocation,
  buildWindowsJobSpec,
  DEFAULT_WINDOWS_POWERSHELL,
  runWindowsJobProcess,
  type WindowsJobAdapter,
  type WindowsJobObjectLimits,
} from './windows-job.js'

export type IsolatedSubprocessNetworkMode = 'none' | 'outbound-https'

export interface IsolatedSubprocessLimits {
  readonly memoryMiB?: number
  readonly pidsLimit?: number
  readonly cpus?: number
}

export interface IsolatedSubprocessRequest {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly stdin?: string
  readonly maxStdinBytes?: number
  readonly maxStdoutBytes?: number
  readonly maxStderrBytes?: number
  readonly timeoutMs: number
  readonly killGraceMs?: number
  readonly network?: IsolatedSubprocessNetworkMode
  readonly readOnlyPaths?: readonly string[]
  readonly writablePaths?: readonly string[]
  readonly limits?: IsolatedSubprocessLimits
  readonly signal?: AbortSignal
}

export interface IsolatedSubprocessResult {
  readonly backend: IsolationBackend
  readonly sandboxed: boolean
  readonly status: 'succeeded' | 'failed' | 'timed-out' | 'cancelled' | 'output-limit'
  readonly exitCode: number | null
  readonly processSignal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly reason?: string
}

export interface IsolatedSubprocessLimitsEnforced {
  readonly memoryMiB: boolean
  readonly pidsLimit: boolean
  readonly cpus: boolean
}

export interface IsolatedSubprocessPlan {
  readonly backend: IsolationBackend
  readonly platform: NodeJS.Platform
  readonly network: IsolatedSubprocessNetworkMode
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly readOnlyPaths: readonly string[]
  readonly writablePaths: readonly string[]
  readonly seatbeltProfile?: string
  readonly windowsJobLimits?: WindowsJobObjectLimits
  readonly limitsEnforced?: IsolatedSubprocessLimitsEnforced
}

export interface IsolatedSubprocessAdapter {
  readonly platform?: NodeJS.Platform
  readonly uid?: number
  readonly spawn?: typeof spawn
  readonly bwrapPath?: string
  readonly sandboxExecPath?: string
  readonly powershellPath?: string
  readonly verifyExecutable?: (path: string) => boolean
  readonly killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void
  readonly macos?: MacosSeatbeltAdapter
  readonly windows?: WindowsJobAdapter
}

export interface IsolatedSubprocessPlanOptions {
  readonly backend?: IsolationBackendConfig
  readonly platform?: NodeJS.Platform
  readonly bwrapPath?: string
  readonly sandboxExecPath?: string
  readonly powershellPath?: string
}

export const DEFAULT_BWRAP_PATH = '/usr/bin/bwrap'
const DEFAULT_MAX_STDIN_BYTES = 512 * 1024
const DEFAULT_MAX_STDOUT_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024
const DEFAULT_KILL_GRACE_MS = 2_000
const LINUX_BASE_RO_BINDS = ['/usr', '/bin', '/lib', '/lib64']
const LINUX_NETWORK_RO_BINDS = ['/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/ssl', '/etc/ca-certificates']

function decodeUtf8Strict(bytes: Buffer): string | undefined {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return undefined }
}

function defaultVerifyExecutable(path: string, platform: NodeJS.Platform): boolean {
  try {
    accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

function validateSubprocessRequest(request: IsolatedSubprocessRequest, targetPlatform: NodeJS.Platform, allowHostPaths: boolean): void {
  if (!request || typeof request !== 'object') throw new Error('assistant-isolation: invalid subprocess request')
  if (typeof request.command !== 'string' || request.command.length === 0 || request.command.includes('\0')) {
    throw new Error('assistant-isolation: subprocess command required')
  }
  if (!Array.isArray(request.args) || request.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('assistant-isolation: invalid subprocess args')
  }
  const pathPlatform = allowHostPaths ? process.platform : targetPlatform
  if (!canonicalAbsolutePath(request.cwd, pathPlatform)) {
    throw new Error('assistant-isolation: canonical absolute subprocess cwd required')
  }
  if (!request.env || typeof request.env !== 'object' || Array.isArray(request.env)) {
    throw new Error('assistant-isolation: subprocess env object required')
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 600_000) {
    throw new Error('assistant-isolation: invalid subprocess timeoutMs')
  }
  if (request.killGraceMs !== undefined && (!Number.isSafeInteger(request.killGraceMs) || request.killGraceMs < 1 || request.killGraceMs > 60_000)) {
    throw new Error('assistant-isolation: invalid subprocess killGraceMs')
  }
  const network = request.network ?? 'none'
  if (network !== 'none' && network !== 'outbound-https') {
    throw new Error('assistant-isolation: invalid subprocess network mode')
  }
  const maxStdinBytes = request.maxStdinBytes ?? DEFAULT_MAX_STDIN_BYTES
  if (request.stdin !== undefined && (typeof request.stdin !== 'string' || Buffer.byteLength(request.stdin, 'utf8') > maxStdinBytes)) {
    throw new Error('assistant-isolation: subprocess stdin exceeds limit')
  }
  if (request.limits !== undefined) {
    if (!request.limits || typeof request.limits !== 'object' || Array.isArray(request.limits)) {
      throw new Error('assistant-isolation: invalid subprocess limits')
    }
    if (request.limits.memoryMiB !== undefined && (typeof request.limits.memoryMiB !== 'number' || !Number.isFinite(request.limits.memoryMiB) || request.limits.memoryMiB < 0 || request.limits.memoryMiB > 65_536)) {
      throw new Error('assistant-isolation: invalid subprocess memoryMiB limit')
    }
    if (request.limits.pidsLimit !== undefined && (!Number.isSafeInteger(request.limits.pidsLimit) || request.limits.pidsLimit < 1 || request.limits.pidsLimit > 4096)) {
      throw new Error('assistant-isolation: invalid subprocess pidsLimit')
    }
    if (request.limits.cpus !== undefined && (typeof request.limits.cpus !== 'number' || !Number.isFinite(request.limits.cpus) || request.limits.cpus <= 0 || request.limits.cpus > 256)) {
      throw new Error('assistant-isolation: invalid subprocess cpus limit')
    }
  }
}

function sanitizeSubprocessEnv(
  env: Readonly<Record<string, string>>,
  cwd: string,
  network: IsolatedSubprocessNetworkMode,
  platform: NodeJS.Platform,
  readOnlyRoots?: readonly string[],
): Record<string, string> {
  if (platform === 'win32') {
    return buildScrubbedWindowsEnv({ workspacePath: cwd, tmpPath: cwd, networkMode: network, env })
  }
  if (platform === 'darwin') {
    return buildScrubbedMacosEnv({
      workspacePath: cwd,
      tmpPath: cwd,
      allowNetwork: network === 'outbound-https',
      env,
      ...(readOnlyRoots !== undefined ? { readOnlyRoots } : {}),
    })
  }
  const clean: Record<string, string> = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    HOME: cwd,
    TMPDIR: cwd,
  }
  for (const [key, value] of Object.entries(env)) {
    if (key.length === 0 || key.includes('=') || key.includes('\0')) continue
    if (typeof value !== 'string' || value.includes('\0')) continue
    const upper = key.toUpperCase()
    if (
      upper === 'PATH'
      || upper === 'HOME'
      || upper === 'TMPDIR'
      || upper === 'NODE_OPTIONS'
      || upper.startsWith('LD_')
      || upper.startsWith('DYLD_')
    ) {
      continue
    }
    if (network === 'none' && ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'FTP_PROXY'].includes(upper)) continue
    clean[key] = value
  }
  return clean
}

async function linuxPrivateDirOk(path: string, uid: number | undefined): Promise<boolean> {
  if (!canonicalAbsolutePath(path, 'linux')) return false
  try {
    if (await realpath(path) !== path) return false
    const info = await lstat(path)
    return isPrivateDirectoryStats(info, 'linux', uid, 0o700)
  } catch {
    return false
  }
}

function normalizeExtraPaths(
  paths: readonly string[] | undefined,
  platform: NodeJS.Platform,
  label: string,
): string[] {
  if (!paths) return []
  const deduped = new Set<string>()
  for (const entry of paths) {
    if (!canonicalAbsolutePath(entry, platform)) {
      throw new Error(`assistant-isolation: canonical absolute ${label} path required`)
    }
    deduped.add(entry)
  }
  return [...deduped].sort((a, b) => a.length - b.length || a.localeCompare(b))
}

export function buildIsolatedSubprocessPlan(
  request: IsolatedSubprocessRequest,
  options: IsolatedSubprocessPlanOptions = {},
): IsolatedSubprocessPlan {
  const platform = options.platform ?? process.platform
  const backend = resolveIsolationBackend(options.backend ?? 'auto', platform)
  const expectedPlatform: NodeJS.Platform = backend === 'linux-native' ? 'linux' : backend === 'macos-seatbelt' ? 'darwin' : 'win32'
  if (platform !== expectedPlatform) {
    throw new Error(`assistant-isolation: backend ${backend} is incompatible with platform ${platform}`)
  }

  validateSubprocessRequest(request, expectedPlatform, false)
  const network: IsolatedSubprocessNetworkMode = request.network ?? 'none'
  const pathApi = expectedPlatform === 'win32' ? win32 : posix
  const commandDir = pathApi.dirname(request.command)
  const readOnlyPaths = normalizeExtraPaths(
    [commandDir, ...(request.readOnlyPaths ?? [])],
    expectedPlatform,
    'readOnly',
  )
  const writablePaths = normalizeExtraPaths(
    request.writablePaths && request.writablePaths.length > 0 ? request.writablePaths : [request.cwd],
    expectedPlatform,
    'writable',
  )

  if (backend === 'linux-native') {
    const env = sanitizeSubprocessEnv(request.env, request.cwd, network, expectedPlatform)
    const bwrap = options.bwrapPath ?? DEFAULT_BWRAP_PATH
    const checkLocalFs = process.platform === 'linux'
    const baseBinds = LINUX_BASE_RO_BINDS.filter(dir => !checkLocalFs || existsSync(dir))
    const netBinds = network === 'outbound-https'
      ? LINUX_NETWORK_RO_BINDS.filter(file => !checkLocalFs || existsSync(file))
      : []
    const extraRoBinds = readOnlyPaths.filter(entry =>
      !baseBinds.some(base => isPathWithinOrEqual(entry, base, 'linux'))
      && !writablePaths.some(writable => isPathWithinOrEqual(entry, writable, 'linux')))
    const args: string[] = [
      '--unshare-user-try',
      '--unshare-ipc',
      '--unshare-pid',
      ...(network === 'none' ? ['--unshare-net'] : []),
      '--unshare-uts',
      '--unshare-cgroup-try',
      '--die-with-parent',
      '--new-session',
      '--clearenv',
    ]
    for (const dir of baseBinds) args.push('--ro-bind', dir, dir)
    if (checkLocalFs && existsSync('/etc/ld.so.cache')) args.push('--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache')
    for (const entry of netBinds) args.push('--ro-bind', entry, entry)
    for (const entry of extraRoBinds) args.push('--ro-bind', entry, entry)
    args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp')
    for (const entry of writablePaths) {
      args.push('--dir', entry, '--bind', entry, entry)
    }
    args.push('--chdir', request.cwd)
    for (const [key, value] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) {
      args.push('--setenv', key, value)
    }
    const usePrlimitCpu = request.limits?.cpus !== undefined && (!checkLocalFs || existsSync('/usr/bin/prlimit'))
    if (usePrlimitCpu) {
      const cpuLimitSeconds = Math.max(1, Math.ceil((request.timeoutMs / 1000) * Math.max(0.1, request.limits!.cpus!)))
      args.push('--', '/usr/bin/prlimit', `--cpu=${cpuLimitSeconds}`, '--', request.command, ...request.args)
    } else {
      args.push('--', request.command, ...request.args)
    }

    return {
      backend,
      platform: expectedPlatform,
      network,
      executable: bwrap,
      args,
      cwd: request.cwd,
      env,
      readOnlyPaths: [...baseBinds, ...netBinds, ...extraRoBinds],
      writablePaths,
      limitsEnforced: {
        memoryMiB: false,
        pidsLimit: false,
        cpus: usePrlimitCpu,
      },
    }
  }

  if (backend === 'macos-seatbelt') {
    const sandboxExec = options.sandboxExecPath ?? DEFAULT_MACOS_SANDBOX_EXEC
    const filteredRo = readOnlyPaths.filter(entry =>
      entry !== '/' && entry !== '/Users' && entry !== '/private' && entry !== '/System' && entry !== '/usr'
      && !writablePaths.some(w => isPathWithinOrEqual(entry, w, 'darwin')))
    const env = sanitizeSubprocessEnv(request.env, request.cwd, network, expectedPlatform, filteredRo)
    const seatbeltProfile = buildMacosSeatbeltCommandProfile({
      workspacePath: request.cwd,
      tmpPath: request.cwd,
      readOnlyRoots: filteredRo,
      writablePaths,
      executablePaths: [request.command],
      workspaceWritable: true,
      allowNetwork: network === 'outbound-https',
    })
    return {
      backend,
      platform: expectedPlatform,
      network,
      executable: sandboxExec,
      args: ['-p', seatbeltProfile, request.command, ...request.args],
      cwd: request.cwd,
      env,
      readOnlyPaths: filteredRo,
      writablePaths,
      seatbeltProfile,
      limitsEnforced: {
        memoryMiB: false,
        pidsLimit: false,
        cpus: false,
      },
    }
  }

  const env = sanitizeSubprocessEnv(request.env, request.cwd, network, expectedPlatform)
  const powershellPath = options.powershellPath ?? DEFAULT_WINDOWS_POWERSHELL
  const spec = buildWindowsJobSpec({
    workspacePath: request.cwd,
    tmpPath: request.cwd,
    argv: [request.command, ...request.args],
    powershellPath,
    networkMode: network,
    env,
    ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
    deadline: Date.now() + request.timeoutMs,
    timeoutMs: request.timeoutMs,
    maxOutputBytes: (request.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES) + (request.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES),
    ...(request.limits !== undefined ? { limits: request.limits } : {}),
  })
  const invocation = buildWindowsJobRunnerInvocation('<specPath>', powershellPath)
  return {
    backend,
    platform: expectedPlatform,
    network,
    executable: invocation.command,
    args: invocation.args,
    cwd: request.cwd,
    env: spec.env,
    readOnlyPaths,
    writablePaths,
    windowsJobLimits: spec.limits,
    limitsEnforced: {
      memoryMiB: spec.limits.memoryLimitBytes > 0,
      pidsLimit: spec.limits.activeProcessLimit > 0,
      cpus: true,
    },
  }
}

export async function runIsolatedSubprocess(
  request: IsolatedSubprocessRequest,
  options: { backend?: IsolationBackendConfig; adapter?: IsolatedSubprocessAdapter } = {},
): Promise<IsolatedSubprocessResult> {
  const adapter = options.adapter
  const platform = adapter?.platform ?? process.platform
  const backend = resolveIsolationBackend(options.backend ?? 'auto', platform)
  const expectedPlatform: NodeJS.Platform = backend === 'linux-native' ? 'linux' : backend === 'macos-seatbelt' ? 'darwin' : 'win32'
  if (platform !== expectedPlatform) {
    return {
      backend,
      sandboxed: false,
      status: 'failed',
      exitCode: null,
      processSignal: null,
      stdout: '',
      stderr: '',
      reason: `platform-backend-mismatch:${platform}:${backend}`,
    }
  }

  const allowHostPaths = adapter !== undefined && process.platform !== expectedPlatform
  validateSubprocessRequest(request, expectedPlatform, allowHostPaths)

  const network: IsolatedSubprocessNetworkMode = request.network ?? 'none'
  const maxStdoutBytes = request.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES
  const maxStderrBytes = request.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES
  const killGraceMs = request.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  const signal = request.signal ?? new AbortController().signal

  if (signal.aborted) {
    return {
      backend,
      sandboxed: false,
      status: 'cancelled',
      exitCode: null,
      processSignal: null,
      stdout: '',
      stderr: '',
      reason: 'aborted-before-spawn',
    }
  }

  if (backend === 'macos-seatbelt') {
    const pathPlatform = allowHostPaths ? process.platform : 'darwin'
    const writablePaths = normalizeExtraPaths(
      request.writablePaths && request.writablePaths.length > 0 ? request.writablePaths : [request.cwd],
      pathPlatform,
      'writable',
    )
    const readOnlyRoots = normalizeExtraPaths(
      [dirname(request.command), ...(request.readOnlyPaths ?? [])],
      pathPlatform,
      'readOnly',
    ).filter(entry =>
      entry !== '/' && entry !== '/Users' && entry !== '/private' && entry !== '/System' && entry !== '/usr'
      && !writablePaths.some(w => isPathWithinOrEqual(entry, w, pathPlatform)))

    const macSandboxExecPath = adapter?.macos?.sandboxExecPath ?? adapter?.sandboxExecPath
    const macUid = adapter?.macos?.uid ?? adapter?.uid ?? process.getuid?.()
    const macSpawn = adapter?.macos?.spawn ?? adapter?.spawn
    const macKillGroup = adapter?.macos?.killProcessGroup ?? adapter?.killProcessGroup
    const macAdapter: MacosSeatbeltAdapter = {
      ...adapter?.macos,
      platform: adapter?.macos?.platform ?? platform,
      ...(macUid !== undefined ? { uid: macUid } : {}),
      ...(macSandboxExecPath !== undefined ? { sandboxExecPath: macSandboxExecPath } : {}),
      ...(macSpawn !== undefined ? { spawn: macSpawn } : {}),
      ...(macKillGroup !== undefined ? { killProcessGroup: macKillGroup } : {}),
    }
    const macResult = await runMacosSeatbeltCommand({
      workspacePath: request.cwd,
      tmpPath: request.cwd,
      argv: [request.command, ...request.args],
      readOnlyRoots,
      writablePaths,
      executablePaths: [request.command],
      workspaceWritable: true,
      allowNetwork: network === 'outbound-https',
      env: request.env,
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      ...(request.maxStdinBytes !== undefined ? { maxStdinBytes: request.maxStdinBytes } : {}),
      deadline: Date.now() + request.timeoutMs,
      maxOutputBytes: maxStdoutBytes + maxStderrBytes,
      ...(macSandboxExecPath !== undefined ? { sandboxExecPath: macSandboxExecPath } : {}),
      signal,
    }, macAdapter)

    const macPreSpawnReasons = new Set([
      'non-root-macos-required',
      'invalid-input-or-signal',
      'invalid-command',
      'invalid-workspace-writable',
      'invalid-network-flag',
      'sandbox-exec-unavailable',
      'invalid-private-workspace',
      'invalid-private-tmp',
      'invalid-read-only-roots',
      'overbroad-read-only-root',
      'invalid-writable-paths',
      'overbroad-writable-path',
      'invalid-executable-paths',
      'invalid-stdin',
      'invalid-deadline',
      'invalid-output-limit',
      'aborted-before-spawn',
      'deadline-expired-before-spawn',
      'sandbox-spawn-failed',
    ])
    const sandboxFailedBeforeSpawn = macResult.reason !== undefined && macPreSpawnReasons.has(macResult.reason)
    return {
      backend,
      sandboxed: !sandboxFailedBeforeSpawn,
      status: macResult.status === 'unknown' ? 'failed' : macResult.status,
      exitCode: macResult.exitCode ?? null,
      processSignal: null,
      stdout: macResult.stdout,
      stderr: macResult.stderr,
      ...(macResult.reason ? { reason: macResult.reason } : {}),
    }
  }

  if (backend === 'windows-job') {
    const winPowershellPath = adapter?.windows?.powershellPath ?? adapter?.powershellPath
    const winSpawn = adapter?.windows?.spawn ?? adapter?.spawn
    const winAdapter: WindowsJobAdapter = {
      ...adapter?.windows,
      platform: adapter?.windows?.platform ?? platform,
      ...(winPowershellPath !== undefined ? { powershellPath: winPowershellPath } : {}),
      ...(winSpawn !== undefined ? { spawn: winSpawn } : {}),
    }
    const winResult = await runWindowsJobProcess({
      workspacePath: request.cwd,
      tmpPath: request.cwd,
      argv: [request.command, ...request.args],
      ...(winPowershellPath !== undefined ? { powershellPath: winPowershellPath } : {}),
      networkMode: network,
      env: request.env,
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      ...(request.maxStdinBytes !== undefined ? { maxStdinBytes: request.maxStdinBytes } : {}),
      deadline: Date.now() + request.timeoutMs,
      maxOutputBytes: maxStdoutBytes + maxStderrBytes,
      ...(request.limits !== undefined ? { limits: request.limits } : {}),
      signal,
    }, winAdapter)

    const winPreSpawnReasons = new Set([
      'windows-required',
      'invalid-input-or-signal',
      'invalid-command',
      'invalid-private-workspace',
      'invalid-private-tmp',
      'invalid-stdin',
      'invalid-deadline',
      'invalid-output-limit',
      'aborted-before-spawn',
      'deadline-expired-before-spawn',
      'windows-job-runner-unavailable',
      'windows-job-spawn-failed',
    ])
    const sandboxFailedBeforeSpawn = winResult.reason !== undefined && winPreSpawnReasons.has(winResult.reason)
    return {
      backend,
      sandboxed: !sandboxFailedBeforeSpawn,
      status: winResult.status === 'unknown' ? 'failed' : winResult.status,
      exitCode: winResult.exitCode ?? null,
      processSignal: null,
      stdout: winResult.stdout,
      stderr: winResult.stderr,
      ...(winResult.reason ? { reason: winResult.reason } : {}),
    }
  }

  // linux-native via bubblewrap (no pre-built LinuxRuntime tarball or SQLite ledger required)
  const bwrap = adapter?.bwrapPath ?? DEFAULT_BWRAP_PATH
  const verifyExec = adapter?.verifyExecutable ?? (p => defaultVerifyExecutable(p, 'linux'))
  if (!canonicalAbsolutePath(bwrap, 'linux') || !verifyExec(bwrap)) {
    return {
      backend,
      sandboxed: false,
      status: 'failed',
      exitCode: null,
      processSignal: null,
      stdout: '',
      stderr: '',
      reason: 'sandbox-unavailable:bwrap',
    }
  }

  const linuxUid = adapter?.uid ?? process.getuid?.()
  if (!await linuxPrivateDirOk(request.cwd, linuxUid) || !await safeWorkspaceTree(request.cwd)) {
    return {
      backend,
      sandboxed: false,
      status: 'failed',
      exitCode: null,
      processSignal: null,
      stdout: '',
      stderr: '',
      reason: 'invalid-private-workspace',
    }
  }

  const plan = buildIsolatedSubprocessPlan(request, {
    backend: 'linux-native',
    platform: 'linux',
    bwrapPath: bwrap,
  })
  const spawnImpl = adapter?.spawn ?? spawn
  const killGroup = adapter?.killProcessGroup ?? ((pid: number, sig: NodeJS.Signals) => {
    try { process.kill(-pid, sig) } catch { try { process.kill(pid, sig) } catch {} }
  })

  return await new Promise<IsolatedSubprocessResult>(resolveResult => {
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let stopStatus: IsolatedSubprocessResult['status'] | undefined
    let stopReason: string | undefined
    let settled = false
    let graceTimer: NodeJS.Timeout | undefined

    let child: ReturnType<typeof spawn>
    try {
      child = spawnImpl(plan.executable, [...plan.args], {
        cwd: plan.cwd,
        env: plan.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        windowsHide: true,
      })
    } catch (error) {
      resolveResult({
        backend,
        sandboxed: false,
        status: 'failed',
        exitCode: null,
        processSignal: null,
        stdout: '',
        stderr: '',
        reason: `sandbox-spawn-failed:${error instanceof Error ? error.message : 'unknown'}`,
      })
      return
    }

    const settle = (result: IsolatedSubprocessResult): void => {
      if (settled) return
      settled = true
      clearTimeout(deadlineTimer)
      if (graceTimer) clearTimeout(graceTimer)
      signal.removeEventListener('abort', onAbort)
      resolveResult(result)
    }

    const stop = (status: IsolatedSubprocessResult['status'], reason: string): void => {
      if (stopStatus || settled) return
      stopStatus = status
      stopReason = reason
      if (child.pid !== undefined) killGroup(child.pid, 'SIGTERM')
      else child.kill('SIGTERM')
      graceTimer = setTimeout(() => {
        if (child.pid !== undefined) killGroup(child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      }, killGraceMs)
    }

    const deadlineTimer = setTimeout(() => stop('timed-out', 'timeout'), request.timeoutMs)
    const onAbort = (): void => stop('cancelled', 'aborted')
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()

    child.stdout?.on('data', (chunk: Buffer) => {
      const remaining = Math.max(0, maxStdoutBytes - stdout.length)
      stdout = Buffer.concat([stdout, chunk.subarray(0, remaining)])
      if (chunk.length > remaining) stop('output-limit', 'stdout-limit')
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      const remaining = Math.max(0, maxStderrBytes - stderr.length)
      stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)])
      if (chunk.length > remaining) stop('output-limit', 'stderr-limit')
    })

    child.on('error', error => {
      settle({
        backend,
        sandboxed: false,
        status: 'failed',
        exitCode: null,
        processSignal: null,
        stdout: decodeUtf8Strict(stdout) ?? '',
        stderr: decodeUtf8Strict(stderr) ?? '',
        reason: `sandbox-error:${error.message}`,
      })
    })

    child.on('close', (code, procSignal) => {
      const outText = decodeUtf8Strict(stdout)
      const errText = decodeUtf8Strict(stderr)
      const invalidUtf8 = outText === undefined || errText === undefined
      const status: IsolatedSubprocessResult['status'] = stopStatus
        ?? (invalidUtf8 || code !== 0 ? 'failed' : 'succeeded')
      settle({
        backend,
        sandboxed: true,
        status,
        exitCode: code,
        processSignal: procSignal,
        stdout: outText ?? '',
        stderr: errText ?? '',
        ...(stopReason ? { reason: stopReason } : invalidUtf8 ? { reason: 'invalid-utf8-output' } : {}),
      })
    })

    child.stdin?.on('error', () => {})
    child.stdin?.end(request.stdin ?? '')
  })
}

export function createIsolatedSubprocessRunner(
  defaults: { backend?: IsolationBackendConfig; adapter?: IsolatedSubprocessAdapter } = {},
): { run(request: IsolatedSubprocessRequest): Promise<IsolatedSubprocessResult> } {
  return {
    run: (request: IsolatedSubprocessRequest) => runIsolatedSubprocess(request, defaults),
  }
}
