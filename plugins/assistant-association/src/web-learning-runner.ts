import { realpathSync } from 'node:fs'
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildIsolatedSubprocessPlan,
  createIsolatedSubprocessRunner,
  resolveIsolationBackend,
  type IsolatedSubprocessAdapter,
  type IsolatedSubprocessLimits,
  type IsolatedSubprocessNetworkMode,
  type IsolatedSubprocessPlan,
  type IsolatedSubprocessPlanOptions,
  type IsolatedSubprocessRequest,
  type IsolatedSubprocessResult,
  type IsolationBackendConfig,
} from '@dsh-ray/assistant-isolation'
import { assertReadOnlyWebToolSurface, sanitizeWebLearningEnv } from './web-fetch.ts'
import {
  executeWebLearningPlan,
  type WebLearningWorkerDeps,
  type WebLearningWorkerInput,
  type WebLearningWorkerOutput,
} from './web-learning-worker.ts'

const DEFAULT_MAX_STDIN_BYTES = 512 * 1024
const DEFAULT_MAX_STDOUT_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024
const MAX_CROSS_PLATFORM_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_CROSS_PLATFORM_DURATION_MS = 300_000
const DEFAULT_KILL_GRACE_MS = 2_000
const DEFAULT_TIMEOUT_BUFFER_MS = 250
const MAX_ISOLATED_READ_ONLY_PATHS = 32
const DEFAULT_WEB_LEARNING_LIMITS: IsolatedSubprocessLimits = Object.freeze({
  memoryMiB: 256,
  pidsLimit: 32,
  cpus: 1,
})
const MACOS_OVERBROAD_ROOTS = new Set(['/', '/Users', '/private', '/System', '/usr'])

export interface WebLearningRunner {
  run(input: WebLearningWorkerInput, signal?: AbortSignal): Promise<WebLearningWorkerOutput>
}

export interface SubprocessWebLearningRunnerOptions {
  readonly workerEntryPath?: string
  readonly tempBaseDir?: string
  readonly maxStdinBytes?: number
  readonly maxStdoutBytes?: number
  readonly killGraceMs?: number
  readonly runnerTimeoutBufferMs?: number
  readonly sourceEnv?: NodeJS.ProcessEnv
  readonly nodeOptions?: readonly string[]
  readonly backend?: IsolationBackendConfig
  readonly isolationAdapter?: IsolatedSubprocessAdapter
  readonly isolatedRunner?: (request: IsolatedSubprocessRequest) => Promise<IsolatedSubprocessResult>
  readonly network?: IsolatedSubprocessNetworkMode
  readonly limits?: IsolatedSubprocessLimits
  readonly readOnlyPaths?: readonly string[]
}

export interface BuildWebLearningSubprocessRequestOptions
  extends SubprocessWebLearningRunnerOptions {
  readonly cwd: string
  readonly command?: string
  readonly resolvedCommandPath?: string
  readonly resolvedWorkerEntryPath?: string
  readonly selfPath?: string
  readonly resolvedSelfPath?: string
  readonly platform?: NodeJS.Platform
  readonly homeDir?: string
  readonly resolvedHomeDir?: string
  readonly serializedInput?: string
}

export interface BuildWebLearningSubprocessPlanOptions
  extends BuildWebLearningSubprocessRequestOptions {
  readonly planOptions?: IsolatedSubprocessPlanOptions
}

function tryRealpathSync(targetPath: string): string {
  try {
    return realpathSync(targetPath)
  } catch {
    return targetPath
  }
}

async function tryRealpath(targetPath: string): Promise<string> {
  try {
    return await realpath(targetPath)
  } catch {
    return targetPath
  }
}

function resolvePathPlatform(
  options: Pick<BuildWebLearningSubprocessRequestOptions, 'backend' | 'isolationAdapter' | 'platform'>,
): NodeJS.Platform {
  if (options.platform !== undefined) {
    return options.platform
  }
  const adapterPlatform = options.isolationAdapter?.platform
  const backend = resolveIsolationBackend(
    options.backend ?? 'auto',
    adapterPlatform ?? process.platform,
  )
  const expectedPlatform: NodeJS.Platform =
    backend === 'linux-native'
      ? 'linux'
      : backend === 'macos-seatbelt'
        ? 'darwin'
        : 'win32'
  const allowHostPaths =
    options.isolationAdapter !== undefined && process.platform !== expectedPlatform
  return allowHostPaths ? process.platform : expectedPlatform
}

function isCanonicalAbsoluteForPlatform(value: string, pathPlatform: NodeJS.Platform): boolean {
  if (value.length === 0 || /[\p{Cc}]/u.test(value)) return false
  if (pathPlatform === 'win32') {
    if (!win32.isAbsolute(value) || win32.resolve(value) !== value) return false
    return win32.parse(value).root !== value
  }
  if (value.includes('\\')) return false
  return posix.isAbsolute(value) && posix.resolve(value) === value && value !== '/'
}

function isPathWithinOrEqualForPlatform(
  candidate: string,
  root: string,
  pathPlatform: NodeJS.Platform,
): boolean {
  const api = pathPlatform === 'win32' ? win32 : posix
  const rel = api.relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !api.isAbsolute(rel))
}

function resolveEffectiveMaxStdoutBytes(requested?: number): number {
  if (requested === undefined) {
    return DEFAULT_MAX_STDOUT_BYTES
  }
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new Error('web-learning-runner: maxStdoutBytes must be a positive safe integer')
  }
  return Math.min(requested, MAX_CROSS_PLATFORM_OUTPUT_BYTES - DEFAULT_MAX_STDERR_BYTES)
}

function resolveEffectiveReadOnlyPaths(input: {
  readonly command: string
  readonly resolvedCommandPath?: string
  readonly workerEntryPath: string
  readonly resolvedWorkerEntryPath?: string
  readonly selfPath: string
  readonly resolvedSelfPath?: string
  readonly scratchDir: string
  readonly extraReadOnlyPaths?: readonly string[]
  readonly pathPlatform: NodeJS.Platform
  readonly homeDir?: string
  readonly resolvedHomeDir?: string
}): readonly string[] {
  const api = input.pathPlatform === 'win32' ? win32 : posix
  const canUseHostFs = input.pathPlatform === process.platform

  const resolvedCommand =
    input.resolvedCommandPath ?? (canUseHostFs ? tryRealpathSync(input.command) : input.command)
  const resolvedWorker =
    input.resolvedWorkerEntryPath ??
    (canUseHostFs ? tryRealpathSync(input.workerEntryPath) : input.workerEntryPath)
  const resolvedSelf =
    input.resolvedSelfPath ?? (canUseHostFs ? tryRealpathSync(input.selfPath) : input.selfPath)

  const homeCandidates: string[] = []
  const rawHome = input.homeDir ?? (canUseHostFs ? homedir() : undefined)
  if (rawHome !== undefined && rawHome.length > 0) {
    homeCandidates.push(rawHome)
    const realHome = input.resolvedHomeDir ?? (canUseHostFs ? tryRealpathSync(rawHome) : rawHome)
    if (realHome.length > 0 && realHome !== rawHome) {
      homeCandidates.push(realHome)
    }
  }

  const commandDir = api.dirname(input.command)
  const realCommandDir = api.dirname(resolvedCommand)
  const workerDir = api.dirname(input.workerEntryPath)
  const realWorkerDir = api.dirname(resolvedWorker)
  const selfDir = api.dirname(input.selfPath)
  const realSelfDir = api.dirname(resolvedSelf)

  const rawCandidates: string[] = [
    commandDir,
    realCommandDir,
    workerDir,
    realWorkerDir,
  ]
  const workerDirName = api.basename(workerDir)
  if (workerDirName === 'src' || workerDirName === 'lib') {
    rawCandidates.push(api.dirname(workerDir))
  }
  const realWorkerDirName = api.basename(realWorkerDir)
  if (realWorkerDirName === 'src' || realWorkerDirName === 'lib') {
    rawCandidates.push(api.dirname(realWorkerDir))
  }
  rawCandidates.push(selfDir, realSelfDir, ...(input.extraReadOnlyPaths ?? []))

  const deduped = new Set<string>()
  for (const candidate of rawCandidates) {
    if (typeof candidate !== 'string') continue
    if (!isCanonicalAbsoluteForPlatform(candidate, input.pathPlatform)) continue
    if (MACOS_OVERBROAD_ROOTS.has(candidate)) continue
    if (
      homeCandidates.some(
        (home) =>
          isCanonicalAbsoluteForPlatform(home, input.pathPlatform) &&
          isPathWithinOrEqualForPlatform(home, candidate, input.pathPlatform),
      )
    ) {
      continue
    }
    if (
      isPathWithinOrEqualForPlatform(input.scratchDir, candidate, input.pathPlatform) ||
      isPathWithinOrEqualForPlatform(candidate, input.scratchDir, input.pathPlatform)
    ) {
      continue
    }
    deduped.add(candidate)
  }

  const result = [...deduped]
  const maxEntries = result.includes(commandDir)
    ? MAX_ISOLATED_READ_ONLY_PATHS
    : MAX_ISOLATED_READ_ONLY_PATHS - 1
  return result.slice(0, maxEntries)
}

export function resolveWebLearningWorkerEntryPath(explicitPath?: string): string {
  if (explicitPath !== undefined && explicitPath.trim() !== '') {
    return explicitPath
  }
  const selfPath = fileURLToPath(import.meta.url)
  if (selfPath.endsWith('.ts')) {
    return fileURLToPath(new URL('./web-learning-worker.ts', import.meta.url))
  }
  return fileURLToPath(new URL('./web-learning-worker.js', import.meta.url))
}

export function buildWebLearningSubprocessRequest(
  input: WebLearningWorkerInput,
  options: BuildWebLearningSubprocessRequestOptions,
  signal?: AbortSignal,
): IsolatedSubprocessRequest {
  const pathPlatform = resolvePathPlatform(options)
  if (!isCanonicalAbsoluteForPlatform(options.cwd, pathPlatform)) {
    throw new Error('web-learning-runner: canonical absolute scratch cwd required')
  }

  const maxStdinBytes = options.maxStdinBytes ?? DEFAULT_MAX_STDIN_BYTES
  const stdin = options.serializedInput ?? JSON.stringify(input)
  if (Buffer.byteLength(stdin, 'utf8') > maxStdinBytes) {
    throw new Error(`web-learning-runner: worker input exceeds ${maxStdinBytes} bytes`)
  }

  const maxStdoutBytes = resolveEffectiveMaxStdoutBytes(options.maxStdoutBytes)
  const requestedKillGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  const killGraceMs = Math.min(
    60_000,
    Math.max(
      1,
      Number.isFinite(requestedKillGraceMs)
        ? Math.floor(requestedKillGraceMs)
        : DEFAULT_KILL_GRACE_MS,
    ),
  )
  const timeoutBufferMs = options.runnerTimeoutBufferMs ?? DEFAULT_TIMEOUT_BUFFER_MS
  const rawTimeoutMs = input.budget.maxDurationMs + timeoutBufferMs
  const timeoutMs = Math.min(
    MAX_CROSS_PLATFORM_DURATION_MS,
    Math.max(1, Number.isFinite(rawTimeoutMs) ? Math.floor(rawTimeoutMs) : 1),
  )

  const command = options.command ?? process.execPath
  const workerEntryPath = resolveWebLearningWorkerEntryPath(options.workerEntryPath)
  const selfPath = options.selfPath ?? fileURLToPath(import.meta.url)
  const args = [...(options.nodeOptions ?? []), workerEntryPath]
  const sanitizedEnv = sanitizeWebLearningEnv(options.sourceEnv)
  const network: IsolatedSubprocessNetworkMode = options.network ?? 'outbound-https'
  const limits: IsolatedSubprocessLimits = options.limits ?? DEFAULT_WEB_LEARNING_LIMITS

  const readOnlyPaths = resolveEffectiveReadOnlyPaths({
    command,
    ...(options.resolvedCommandPath !== undefined
      ? { resolvedCommandPath: options.resolvedCommandPath }
      : {}),
    workerEntryPath,
    ...(options.resolvedWorkerEntryPath !== undefined
      ? { resolvedWorkerEntryPath: options.resolvedWorkerEntryPath }
      : {}),
    selfPath,
    ...(options.resolvedSelfPath !== undefined
      ? { resolvedSelfPath: options.resolvedSelfPath }
      : {}),
    scratchDir: options.cwd,
    ...(options.readOnlyPaths !== undefined ? { extraReadOnlyPaths: options.readOnlyPaths } : {}),
    pathPlatform,
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.resolvedHomeDir !== undefined ? { resolvedHomeDir: options.resolvedHomeDir } : {}),
  })

  return {
    command,
    args,
    cwd: options.cwd,
    env: sanitizedEnv,
    stdin,
    maxStdinBytes,
    maxStdoutBytes,
    maxStderrBytes: DEFAULT_MAX_STDERR_BYTES,
    timeoutMs,
    killGraceMs,
    network,
    readOnlyPaths,
    writablePaths: [options.cwd],
    limits,
    ...(signal !== undefined ? { signal } : {}),
  }
}

export function buildWebLearningSubprocessPlan(
  input: WebLearningWorkerInput,
  options: BuildWebLearningSubprocessPlanOptions,
  signal?: AbortSignal,
): IsolatedSubprocessPlan {
  const request = buildWebLearningSubprocessRequest(input, options, signal)
  return buildIsolatedSubprocessPlan(request, {
    ...(options.backend !== undefined ? { backend: options.backend } : {}),
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...options.planOptions,
  })
}

export function createInProcessWebLearningRunner(
  deps?: WebLearningWorkerDeps,
): WebLearningRunner {
  return {
    run(input: WebLearningWorkerInput, signal?: AbortSignal): Promise<WebLearningWorkerOutput> {
      const mergedDeps: WebLearningWorkerDeps = {
        ...deps,
        ...(signal === undefined ? {} : { signal }),
      }
      return executeWebLearningPlan(input, mergedDeps)
    },
  }
}

export function createSubprocessWebLearningRunner(
  options?: SubprocessWebLearningRunnerOptions,
): WebLearningRunner {
  const maxStdinBytes = options?.maxStdinBytes ?? DEFAULT_MAX_STDIN_BYTES
  const maxStdoutBytes = resolveEffectiveMaxStdoutBytes(options?.maxStdoutBytes)
  const workerEntryPath = resolveWebLearningWorkerEntryPath(options?.workerEntryPath)
  const selfPath = fileURLToPath(import.meta.url)
  const isoRunner = createIsolatedSubprocessRunner({
    ...(options?.backend !== undefined ? { backend: options.backend } : {}),
    ...(options?.isolationAdapter !== undefined ? { adapter: options.isolationAdapter } : {}),
  })

  return {
    async run(input: WebLearningWorkerInput, signal?: AbortSignal): Promise<WebLearningWorkerOutput> {
      assertReadOnlyWebToolSurface(input.toolSurface ?? [])

      if (signal?.aborted) {
        throw new Error('web-learning-runner: aborted before starting worker subprocess')
      }

      const serializedInput = JSON.stringify(input)
      if (Buffer.byteLength(serializedInput, 'utf8') > maxStdinBytes) {
        throw new Error(`web-learning-runner: worker input exceeds ${maxStdinBytes} bytes`)
      }

      const rawScratchDir = await mkdtemp(join(options?.tempBaseDir ?? tmpdir(), 'dsh-web-learn-'))
      let scratchDir = rawScratchDir
      try {
        await chmod(rawScratchDir, 0o700)
        scratchDir = await realpath(rawScratchDir)
        await chmod(scratchDir, 0o700)

        if (signal?.aborted) {
          throw new Error('web-learning-runner: aborted before spawning worker subprocess')
        }

        const [resolvedCommandPath, resolvedWorkerEntryPath, resolvedSelfPath, resolvedHomeDir] =
          await Promise.all([
            tryRealpath(process.execPath),
            tryRealpath(workerEntryPath),
            tryRealpath(selfPath),
            tryRealpath(homedir()),
          ])

        const request = buildWebLearningSubprocessRequest(
          input,
          {
            ...options,
            cwd: scratchDir,
            command: process.execPath,
            resolvedCommandPath,
            workerEntryPath,
            resolvedWorkerEntryPath,
            selfPath,
            resolvedSelfPath,
            homeDir: homedir(),
            resolvedHomeDir,
            serializedInput,
          },
          signal,
        )

        const result =
          options?.isolatedRunner !== undefined
            ? await options.isolatedRunner(request)
            : await isoRunner.run(request)

        if (result.status === 'cancelled') {
          throw new Error('web-learning-runner: worker subprocess aborted')
        }
        if (!result.sandboxed) {
          throw new Error(
            `web-learning-runner: OS sandbox unavailable (${result.reason ?? 'unknown'})`,
          )
        }
        if (result.status === 'timed-out') {
          const sigSuffix = result.processSignal ? ` (${result.processSignal})` : ''
          throw new Error(
            `web-learning-runner: worker subprocess timed out after ${input.budget.maxDurationMs}ms${sigSuffix}`,
          )
        }
        if (result.status === 'output-limit') {
          if (result.reason === 'stderr-limit') {
            throw new Error(
              `web-learning-runner: worker stderr exceeded ${DEFAULT_MAX_STDERR_BYTES} bytes`,
            )
          }
          throw new Error(`web-learning-runner: worker stdout exceeded ${maxStdoutBytes} bytes`)
        }
        if (
          result.status !== 'succeeded' ||
          result.exitCode !== 0 ||
          result.processSignal !== null
        ) {
          const detail = result.stderr.trim() || result.reason || ''
          throw new Error(
            `web-learning-runner: worker exited abnormally (code=${String(result.exitCode)}, signal=${String(result.processSignal)})${detail ? `: ${detail}` : ''}`,
          )
        }

        try {
          return JSON.parse(result.stdout) as WebLearningWorkerOutput
        } catch (error) {
          throw new Error(
            `web-learning-runner: worker produced invalid JSON stdout: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      } finally {
        await rm(scratchDir, { recursive: true, force: true }).catch(() => {})
        if (scratchDir !== rawScratchDir) {
          await rm(rawScratchDir, { recursive: true, force: true }).catch(() => {})
        }
      }
    },
  }
}

export function createSandboxedWebLearningRunner(
  options?: SubprocessWebLearningRunnerOptions,
): WebLearningRunner {
  return createSubprocessWebLearningRunner(options)
}
