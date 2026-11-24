import { spawn } from 'node:child_process'
import { constants, writeFileSync } from 'node:fs'
import { access, chmod, lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { cpus as osCpus, tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  canonicalAbsolutePath,
  collectSafeArtifacts,
  isPosixOwnershipEnforced,
  isPrivateDirectoryStats,
  noFollowFlag,
  safeWorkspaceTree,
} from './fs-ownership.js'
import type { IsolationFile } from './types.js'

export const DEFAULT_WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
export const DEFAULT_WINDOWS_CMD = 'C:\\Windows\\System32\\cmd.exe'
export const WINDOWS_JOB_RUNNER_SCRIPT = fileURLToPath(new URL('../runtime/windows-job-runner.ps1', import.meta.url))

export const WINDOWS_JOB_LIMIT_FLAGS = {
  JOB_TIME: 0x00000004,
  ACTIVE_PROCESS: 0x00000008,
  PROCESS_MEMORY: 0x00000100,
  JOB_MEMORY: 0x00000200,
  DIE_ON_UNHANDLED_EXCEPTION: 0x00000400,
  KILL_ON_JOB_CLOSE: 0x00002000,
} as const

export const WINDOWS_JOB_UI_RESTRICTIONS_FLAGS =
  0x00000001 | // HANDLES
  0x00000002 | // READCLIPBOARD
  0x00000004 | // WRITECLIPBOARD
  0x00000008 | // SYSTEMPARAMETERS
  0x00000010 | // DISPLAYSETTINGS
  0x00000020 | // GLOBALATOMS
  0x00000040 | // DESKTOP
  0x00000080   // EXITWINDOWS

const MAX_STDIN = 1_048_576
const MAX_OUTPUT = 4 * 1024 * 1024
const MAX_DURATION = 300_000
const CLOSE_GRACE_MS = 3_000

const FORBIDDEN_ENV_KEYS = new Set([
  'NODE_OPTIONS',
  'PSMODULEPATH',
  'COMSPEC',
  'SYSTEMROOT',
  'WINDIR',
  'PATH',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOME',
])

const PROXY_ENV_KEYS = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'FTP_PROXY',
])

export interface WindowsJobObjectLimits {
  readonly killOnJobClose: true
  readonly dieOnUnhandledException: true
  readonly breakawayAllowed: false
  readonly limitFlags: number
  readonly memoryLimitBytes: number
  readonly activeProcessLimit: number
  readonly perJobUserTimeLimit100Ns: number
  readonly cpuRate: number
  readonly uiRestrictionsFlags: number
}

export interface WindowsJobSpec {
  readonly schemaVersion: 1
  readonly applicationName: string | null
  readonly commandLine: string
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly stdinBase64: string
  readonly timeoutMs: number
  readonly closeGraceMs: number
  readonly maxOutputBytes: number
  readonly networkMode: 'none' | 'outbound-https'
  readonly controlOnStdin: boolean
  readonly cancelFilePath?: string
  readonly limits: WindowsJobObjectLimits
}

export interface WindowsJobProcessInput {
  workspacePath: string
  tmpPath: string
  command?: string
  argv?: readonly string[]
  shell?: 'cmd' | 'powershell'
  shellPath?: string
  powershellPath?: string
  networkMode?: 'none' | 'outbound-https'
  env?: Readonly<Record<string, string>>
  stdin?: string
  maxStdinBytes?: number
  deadline: number
  maxOutputBytes: number
  maxArtifactBytes?: number
  artifacts?: readonly string[]
  limits?: {
    memoryMiB?: number
    pidsLimit?: number
    cpus?: number
  }
  signal: AbortSignal
}

export interface WindowsJobProcessResult {
  status: 'succeeded' | 'failed' | 'cancelled' | 'timed-out' | 'output-limit' | 'unknown'
  quiescent: boolean
  stdout: string
  stderr: string
  artifacts: IsolationFile[]
  exitCode?: number
  reason?: string
  pid?: number
}

export interface WindowsJobAdapter {
  readonly platform?: NodeJS.Platform
  readonly powershellPath?: string
  readonly spawn?: typeof spawn
  readonly verifyRunner?: (powershellPath: string, runnerScriptPath: string) => Promise<boolean>
  readonly cpuCount?: number
  readonly runJob?: (spec: WindowsJobSpec, signal: AbortSignal) => Promise<WindowsJobProcessResult>
}

interface RunnerOutputPayload {
  schemaVersion: number
  status: WindowsJobProcessResult['status']
  quiescent: boolean
  exitCode: number | null
  stdoutBase64: string
  stderrBase64: string
  pid?: number
  activeProcessesRemaining?: number
  reason?: string
}

function failure(reason: string): WindowsJobProcessResult {
  return { status: 'failed', quiescent: true, stdout: '', stderr: '', artifacts: [], reason }
}

function decodeUtf8Strict(bytes: Buffer): string | undefined {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return undefined }
}

export function quoteWindowsArg(arg: string): string {
  if (arg.length === 0) return '""'
  if (!/[\s\t"]/u.test(arg)) return arg
  let out = '"'
  let backslashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes += 1
    } else if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
    } else {
      if (backslashes > 0) {
        out += '\\'.repeat(backslashes)
        backslashes = 0
      }
      out += ch
    }
  }
  if (backslashes > 0) out += '\\'.repeat(backslashes * 2)
  out += '"'
  return out
}

export function buildWindowsCommandLine(argv: readonly string[]): string {
  return argv.map(quoteWindowsArg).join(' ')
}

export function buildScrubbedWindowsEnv(input: {
  workspacePath: string
  tmpPath: string
  networkMode: 'none' | 'outbound-https'
  env?: Readonly<Record<string, string>>
  systemRoot?: string
}): Record<string, string> {
  const systemRoot = input.systemRoot ?? 'C:\\Windows'
  const result: Record<string, string> = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    COMSPEC: win32.join(systemRoot, 'System32', 'cmd.exe'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PATH: `${win32.join(systemRoot, 'System32')};${systemRoot};${win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')}`,
    TEMP: input.tmpPath,
    TMP: input.tmpPath,
    USERPROFILE: input.workspacePath,
    HOME: input.workspacePath,
    LANG: 'C',
    LC_ALL: 'C',
  }
  const seenKeys = new Map<string, string>()
  for (const existingKey of Object.keys(result)) {
    seenKeys.set(existingKey.toUpperCase(), existingKey)
  }
  if (input.env) {
    for (const [key, value] of Object.entries(input.env)) {
      if (key.length === 0 || key.includes('=') || key.includes('\0')) continue
      if (typeof value !== 'string' || value.includes('\0')) continue
      const upper = key.toUpperCase()
      if (FORBIDDEN_ENV_KEYS.has(upper)) continue
      if (input.networkMode === 'none' && PROXY_ENV_KEYS.has(upper)) continue
      const previousKey = seenKeys.get(upper)
      if (previousKey !== undefined && previousKey !== key) {
        delete result[previousKey]
      }
      result[key] = value
      seenKeys.set(upper, key)
    }
  }
  return result
}

export function computeWindowsJobLimits(input: {
  timeoutMs: number
  memoryMiB?: number
  pidsLimit?: number
  cpus?: number
  cpuCount?: number
}): WindowsJobObjectLimits {
  const activeProcessLimit = Math.max(1, Math.min(512, Math.floor(input.pidsLimit ?? 64)))
  const memoryMiB = Math.max(0, Math.min(4096, Math.floor(input.memoryMiB ?? 256)))
  const memoryLimitBytes = memoryMiB * 1024 * 1024
  const perJobUserTimeLimit100Ns = Math.max(1, Math.floor(input.timeoutMs)) * 10_000
  const cpuCount = Math.max(1, Math.floor(input.cpuCount ?? osCpus().length ?? 1))
  const cpus = input.cpus ?? 1
  const rawCpuRate = cpus >= cpuCount ? 0 : Math.max(100, Math.min(10_000, Math.round((cpus * 10_000) / cpuCount)))

  let limitFlags =
    WINDOWS_JOB_LIMIT_FLAGS.KILL_ON_JOB_CLOSE |
    WINDOWS_JOB_LIMIT_FLAGS.DIE_ON_UNHANDLED_EXCEPTION |
    WINDOWS_JOB_LIMIT_FLAGS.ACTIVE_PROCESS |
    WINDOWS_JOB_LIMIT_FLAGS.JOB_TIME
  if (memoryLimitBytes > 0) {
    limitFlags |= WINDOWS_JOB_LIMIT_FLAGS.PROCESS_MEMORY | WINDOWS_JOB_LIMIT_FLAGS.JOB_MEMORY
  }

  return {
    killOnJobClose: true,
    dieOnUnhandledException: true,
    breakawayAllowed: false,
    limitFlags,
    memoryLimitBytes,
    activeProcessLimit,
    perJobUserTimeLimit100Ns,
    cpuRate: rawCpuRate,
    uiRestrictionsFlags: WINDOWS_JOB_UI_RESTRICTIONS_FLAGS,
  }
}

export function buildWindowsJobSpec(
  input: Omit<WindowsJobProcessInput, 'signal'> & { timeoutMs?: number; cpuCount?: number },
): WindowsJobSpec {
  const timeoutMs = input.timeoutMs ?? Math.max(1, input.deadline - Date.now())
  const networkMode = input.networkMode ?? 'none'
  const shell = input.shell ?? 'cmd'
  const powershellPath = input.powershellPath ?? DEFAULT_WINDOWS_POWERSHELL
  const shellPath = input.shellPath ?? (shell === 'powershell' ? powershellPath : DEFAULT_WINDOWS_CMD)

  let applicationName: string | null
  let commandLine: string
  if (input.argv && input.argv.length > 0) {
    applicationName = input.argv[0]!
    commandLine = buildWindowsCommandLine(input.argv)
  } else {
    const command = input.command ?? ''
    if (shell === 'powershell') {
      applicationName = shellPath
      commandLine = buildWindowsCommandLine([shellPath, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command])
    } else {
      applicationName = shellPath
      commandLine = `${quoteWindowsArg(shellPath)} /d /s /c "${command}"`
    }
  }

  return {
    schemaVersion: 1,
    applicationName,
    commandLine,
    cwd: input.workspacePath,
    env: buildScrubbedWindowsEnv({
      workspacePath: input.workspacePath,
      tmpPath: input.tmpPath,
      networkMode,
      ...(input.env !== undefined ? { env: input.env } : {}),
    }),
    stdinBase64: Buffer.from(input.stdin ?? '', 'utf8').toString('base64'),
    timeoutMs,
    closeGraceMs: CLOSE_GRACE_MS,
    maxOutputBytes: input.maxOutputBytes,
    networkMode,
    controlOnStdin: true,
    limits: computeWindowsJobLimits({
      timeoutMs,
      ...(input.limits?.memoryMiB !== undefined ? { memoryMiB: input.limits.memoryMiB } : {}),
      ...(input.limits?.pidsLimit !== undefined ? { pidsLimit: input.limits.pidsLimit } : {}),
      ...(input.limits?.cpus !== undefined ? { cpus: input.limits.cpus } : {}),
      ...(input.cpuCount !== undefined ? { cpuCount: input.cpuCount } : {}),
    }),
  }
}

export function buildWindowsJobRunnerInvocation(
  specPath: string,
  powershellPath = DEFAULT_WINDOWS_POWERSHELL,
  runnerScriptPath = WINDOWS_JOB_RUNNER_SCRIPT,
): { command: string; args: readonly string[] } {
  return {
    command: powershellPath,
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      runnerScriptPath,
      '-SpecPath',
      specPath,
    ],
  }
}

export async function verifyWindowsJobRunner(
  powershellPath = DEFAULT_WINDOWS_POWERSHELL,
  adapter?: WindowsJobAdapter,
): Promise<boolean> {
  if (!canonicalAbsolutePath(powershellPath, 'win32')) return false
  if (adapter?.verifyRunner) return await adapter.verifyRunner(powershellPath, WINDOWS_JOB_RUNNER_SCRIPT)
  try {
    const scriptInfo = await lstat(WINDOWS_JOB_RUNNER_SCRIPT)
    if (!scriptInfo.isFile() || scriptInfo.isSymbolicLink()) return false
    await access(powershellPath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function localPrivateDirOk(path: string): Promise<boolean> {
  if (!canonicalAbsolutePath(path, process.platform)) return false
  try {
    if (await realpath(path) !== path) return false
    const info = await lstat(path)
    return isPrivateDirectoryStats(info, process.platform, process.getuid?.(), 0o700)
  } catch {
    return false
  }
}

export async function runWindowsJobProcess(
  input: WindowsJobProcessInput,
  adapter?: WindowsJobAdapter,
): Promise<WindowsJobProcessResult> {
  const platform = adapter?.platform ?? process.platform
  if (platform !== 'win32') return failure('windows-required')
  if (!input || typeof input.signal?.aborted !== 'boolean' || typeof input.signal.addEventListener !== 'function') {
    return failure('invalid-input-or-signal')
  }
  const hasCommand = typeof input.command === 'string' && input.command.length > 0 && !input.command.includes('\0')
  const hasArgv = Array.isArray(input.argv) && input.argv.length > 0 && input.argv.every(arg => typeof arg === 'string' && !arg.includes('\0'))
  if (!hasCommand && !hasArgv) return failure('invalid-command')

  if (!await localPrivateDirOk(input.workspacePath) || !await safeWorkspaceTree(input.workspacePath)) {
    return failure('invalid-private-workspace')
  }
  if (!await localPrivateDirOk(input.tmpPath) || !await safeWorkspaceTree(input.tmpPath)) {
    return failure('invalid-private-tmp')
  }

  const maxStdin = input.maxStdinBytes ?? MAX_STDIN
  if (input.stdin !== undefined && (typeof input.stdin !== 'string' || Buffer.byteLength(input.stdin) > maxStdin)) {
    return failure('invalid-stdin')
  }
  if (!Number.isSafeInteger(input.deadline) || input.deadline <= Date.now() || input.deadline - Date.now() > MAX_DURATION) {
    return failure('invalid-deadline')
  }
  if (!Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1 || input.maxOutputBytes > MAX_OUTPUT) {
    return failure('invalid-output-limit')
  }
  if (input.signal.aborted) {
    return { status: 'cancelled', quiescent: true, stdout: '', stderr: '', artifacts: [], reason: 'aborted-before-spawn' }
  }
  const timeoutMs = input.deadline - Date.now()
  if (timeoutMs <= 0) return failure('deadline-expired-before-spawn')

  const powershellPath = adapter?.powershellPath ?? input.powershellPath ?? DEFAULT_WINDOWS_POWERSHELL
  if (!await verifyWindowsJobRunner(powershellPath, adapter)) {
    return failure('windows-job-runner-unavailable')
  }

  const spec = buildWindowsJobSpec({
    ...input,
    powershellPath,
    timeoutMs,
    ...(adapter?.cpuCount !== undefined ? { cpuCount: adapter.cpuCount } : {}),
  })

  let rawResult: WindowsJobProcessResult
  if (adapter?.runJob) {
    rawResult = await adapter.runJob(spec, input.signal)
  } else {
    const specDir = await mkdtemp(join(tmpdir(), 'dsh-winjob-'))
    try {
      if (isPosixOwnershipEnforced(process.platform)) {
        await chmod(specDir, 0o700)
      }
      const specPath = join(specDir, `winjob-spec-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
      const cancelFilePath = `${specPath}.cancel`
      const runnerSpec: WindowsJobSpec = {
        ...spec,
        controlOnStdin: false,
        cancelFilePath,
      }
      const handle = await open(specPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(process.platform), 0o600)
      try {
        await handle.writeFile(JSON.stringify(runnerSpec), 'utf8')
      } finally {
        await handle.close()
      }

      const spawnImpl = adapter?.spawn ?? spawn
      const invocation = buildWindowsJobRunnerInvocation(specPath, powershellPath)

      rawResult = await new Promise<WindowsJobProcessResult>(resolveResult => {
        let stdout = Buffer.alloc(0)
        let stderr = Buffer.alloc(0)
        let settled = false
        let abortRequested = false
        let grace: NodeJS.Timeout | undefined

        const systemDrive = win32.parse(spec.env.SystemRoot ?? 'C:\\Windows').root.replace(/\\$/u, '') || 'C:'
        let child: ReturnType<typeof spawn>
        try {
          child = spawnImpl(invocation.command, [...invocation.args], {
            cwd: input.workspacePath,
            env: {
              SystemRoot: spec.env.SystemRoot,
              WINDIR: spec.env.WINDIR,
              SystemDrive: systemDrive,
              COMSPEC: spec.env.COMSPEC,
              PATHEXT: spec.env.PATHEXT,
              PATH: spec.env.PATH,
              TEMP: input.tmpPath,
              TMP: input.tmpPath,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
            windowsHide: true,
          })
        } catch {
          resolveResult(failure('windows-job-spawn-failed'))
          return
        }

        const settle = (result: WindowsJobProcessResult): void => {
          if (settled) return
          settled = true
          clearTimeout(hostDeadline)
          if (grace) clearTimeout(grace)
          input.signal.removeEventListener('abort', onAbort)
          try { child.stdin?.end() } catch {}
          resolveResult(result)
        }

        const requestCancel = (): void => {
          if (abortRequested || settled) return
          abortRequested = true
          try { writeFileSync(cancelFilePath, 'cancel\n', { flag: 'wx' }) } catch {}
          grace = setTimeout(() => {
            try { child.kill('SIGKILL') } catch {}
            settle({
              status: 'unknown',
              quiescent: false,
              stdout: '',
              stderr: stderr.toString('utf8').slice(0, 4096),
              artifacts: [],
              reason: 'cancelled-close-unconfirmed',
            })
          }, CLOSE_GRACE_MS + 2_000)
        }

        const hostDeadline = setTimeout(() => requestCancel(), timeoutMs + CLOSE_GRACE_MS + 3_000)
        const onAbort = (): void => requestCancel()
        input.signal.addEventListener('abort', onAbort, { once: true })
        if (input.signal.aborted) requestCancel()

        child.stdout?.on('data', (chunk: Buffer) => {
          if (stdout.length + chunk.length <= MAX_OUTPUT * 2 + 65_536) {
            stdout = Buffer.concat([stdout, chunk])
          }
        })
        child.stderr?.on('data', (chunk: Buffer) => {
          if (stderr.length + chunk.length <= 65_536) {
            stderr = Buffer.concat([stderr, chunk])
          }
        })
        child.on('error', error => {
          settle(failure(`windows-job-runner-error: ${error.message}`))
        })
        child.on('close', () => {
          const line = stdout.toString('utf8').trim().split(/\r?\n/u).filter(Boolean).at(-1)
          if (!line) {
            settle({
              status: 'unknown',
              quiescent: false,
              stdout: '',
              stderr: stderr.toString('utf8').slice(0, 4096),
              artifacts: [],
              reason: 'windows-job-no-result-envelope',
            })
            return
          }
          try {
            const parsed = JSON.parse(line) as RunnerOutputPayload
            if (parsed.schemaVersion !== 1 || typeof parsed.quiescent !== 'boolean') {
              throw new Error('invalid runner payload')
            }
            const outBytes = Buffer.from(parsed.stdoutBase64 ?? '', 'base64')
            const errBytes = Buffer.from(parsed.stderrBase64 ?? '', 'base64')
            if (outBytes.length + errBytes.length > input.maxOutputBytes) {
              settle({
                status: 'output-limit',
                quiescent: parsed.quiescent,
                stdout: '',
                stderr: '',
                artifacts: [],
                ...(typeof parsed.pid === 'number' && parsed.pid > 0 ? { pid: parsed.pid } : {}),
                reason: 'output-limit',
              })
              return
            }
            const outText = decodeUtf8Strict(outBytes)
            const errText = decodeUtf8Strict(errBytes)
            if (outText === undefined || errText === undefined) {
              settle({
                status: parsed.quiescent ? 'failed' : 'unknown',
                quiescent: parsed.quiescent,
                stdout: '',
                stderr: '',
                artifacts: [],
                ...(typeof parsed.pid === 'number' && parsed.pid > 0 ? { pid: parsed.pid } : {}),
                reason: 'invalid-utf8-output',
              })
              return
            }
            settle({
              status: parsed.status,
              quiescent: parsed.quiescent,
              stdout: outText,
              stderr: errText,
              artifacts: [],
              ...(typeof parsed.exitCode === 'number' ? { exitCode: parsed.exitCode } : {}),
              ...(typeof parsed.pid === 'number' && parsed.pid > 0 ? { pid: parsed.pid } : {}),
              ...(parsed.reason ? { reason: parsed.reason } : {}),
            })
          } catch {
            settle({
              status: 'unknown',
              quiescent: false,
              stdout: '',
              stderr: stderr.toString('utf8').slice(0, 4096),
              artifacts: [],
              reason: 'windows-job-invalid-envelope',
            })
          }
        })
        child.stdin?.on('error', () => {})
      })
    } finally {
      await rm(specDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  if (rawResult.status === 'succeeded' && rawResult.quiescent && input.artifacts && input.artifacts.length > 0 && rawResult.artifacts.length === 0) {
    try {
      const artifacts = await collectSafeArtifacts(input.workspacePath, input.artifacts, input.maxArtifactBytes ?? 1_048_576, process.platform)
      return { ...rawResult, artifacts }
    } catch (error) {
      return {
        status: 'failed',
        quiescent: true,
        stdout: rawResult.stdout,
        stderr: rawResult.stderr,
        artifacts: [],
        ...(rawResult.exitCode !== undefined ? { exitCode: rawResult.exitCode } : {}),
        reason: error instanceof Error ? error.message : 'artifact-export-failed',
      }
    }
  }
  return rawResult
}
