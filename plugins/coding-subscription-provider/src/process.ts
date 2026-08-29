import { spawn as nodeSpawn } from 'node:child_process'
import { chmod, mkdtemp, open, rmdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CliInvocation } from './providers.js'

export interface SpawnedProcess {
  readonly pid?: number
  readonly stdin?: NodeJS.WritableStream | null
  readonly stdout?: NodeJS.ReadableStream | null
  readonly stderr?: NodeJS.ReadableStream | null
  readonly exitCode?: number | null
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: 'error' | 'close' | 'spawn', listener: (...args: any[]) => void): this
  removeListener?(event: 'error' | 'close' | 'spawn', listener: (...args: any[]) => void): this
  unref?(): void
}

/** Whether prompt input reached the child; the only safe basis for reasoning about replay. */
export type PromptSubmissionState = 'not-submitted' | 'submitted' | 'unknown'

/** Coarse lifecycle phase a failure was observed in, transport-scoped (auth lives in the adapter). */
export type CliLifecyclePhase = 'spawn' | 'initialize' | 'prompt' | 'stream' | 'terminal' | 'child-close'

/** Progress of the bounded child teardown attempt; `timed-out` means close was not proven. */
export type TeardownState = 'not-started' | 'in-progress' | 'completed' | 'timed-out'

/** Latency metrics with named clock origins so they stay comparable across providers. */
export interface CliLifecycleMetrics {
  /** Spawn to the first accepted (recognized) protocol event. */
  readonly spawnToFirstEventMs?: number
  /** First recognized event to the first assistant text chunk. */
  readonly eventToFirstTextMs?: number
  /** Spawn to the successful terminal event. */
  readonly spawnToTerminalMs?: number
  /** Stop request to child-close teardown completion. */
  readonly teardownDurationMs?: number
}

/**
 * Credential-free lifecycle facts for one CLI invocation. Diagnostic side-channel only:
 * it never carries prompt text, stderr, tokens or argv, and never changes settlement.
 */
export interface ProviderFailureContext {
  readonly phase: CliLifecyclePhase
  readonly promptSubmissionState: PromptSubmissionState
  readonly assistantTextObserved: boolean
  readonly teardownState: TeardownState
  readonly terminalReason?: string
  readonly exitCode?: number | null
  readonly signal?: NodeJS.Signals | null
  /** Explicit-clock-origin latency metrics; only measurable ones are present. */
  readonly metrics?: CliLifecycleMetrics
}

export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: { cwd: string; shell: false; detached: boolean; stdio: readonly ['pipe', 'pipe', 'pipe']; env: NodeJS.ProcessEnv },
) => SpawnedProcess

export interface RunCliTextOptions {
  readonly spawn?: SpawnProcess
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly killGraceMs?: number
  readonly maxLineBytes?: number
  readonly maxOutputBytes?: number
  readonly maxStderrBytes?: number
  /** Names only. Values are copied from process.env; callers cannot pass secret values. */
  readonly extraEnvNames?: readonly string[]
  readonly onDiagnostic?: (diagnostic: string) => void
  /** Receives credential-free lifecycle facts exactly once at settlement (success or failure); never affects the stream. */
  readonly onSettled?: (context: ProviderFailureContext) => void
}

export type CliProtocolFailureReason =
  | 'MALFORMED_JSON'
  | 'NO_JSON_EVENTS'
  | 'UNKNOWN_EVENT'
  | 'EVENT_AFTER_TERMINAL'
  | 'NO_ASSISTANT_TEXT'
  | 'MISSING_SUCCESS_TERMINAL'
  | 'INVALID_TERMINAL'
  | 'NATIVE_TOOL_EVENT'
  | 'REPORTED_FAILURE'

/** A stable, credential-free protocol failure that the adapter can map. */
export class CliProtocolError extends Error {
  readonly code = 'CLI_PROTOCOL_ERROR'

  constructor(
    readonly provider: CliInvocation['provider'],
    readonly reason: CliProtocolFailureReason,
  ) {
    super(protocolErrorMessage(provider, reason), { cause: 'protocol' })
    this.name = 'CliProtocolError'
  }
}

export type CliSubscriptionAuthFailureReason = 'MISSING_AUTH_EVENT' | 'UNEXPECTED_AUTH_SOURCE'

/** Cursor reported, or failed to report, the subscription login required by this route. */
export class CliSubscriptionAuthError extends Error {
  readonly code = 'CLI_SUBSCRIPTION_AUTH_ERROR'

  constructor(
    readonly provider: 'cursor',
    readonly reason: CliSubscriptionAuthFailureReason,
  ) {
    super(
      reason === 'MISSING_AUTH_EVENT'
        ? 'cursor CLI did not report its authentication source'
        : 'cursor CLI is not authenticated with the subscription login',
      { cause: 'subscription-auth' },
    )
    this.name = 'CliSubscriptionAuthError'
  }
}

/** The child really closed, but not with an unambiguous zero-code, no-signal exit. */
export class CliProcessExitError extends Error {
  readonly code = 'CLI_PROCESS_EXIT_ERROR'

  constructor(
    readonly provider: CliInvocation['provider'],
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
  ) {
    super(`${provider} CLI exited unsuccessfully (${exitDescription(exitCode, signal)})`, { cause: 'process-exit' })
    this.name = 'CliProcessExitError'
  }
}

/** Codex refused to run because its configured cwd is not an accepted repository. */
export class CliWorkingDirectoryError extends Error {
  readonly code = 'CLI_WORKING_DIRECTORY_ERROR'
  readonly provider = 'codex'

  constructor() {
    super('codex CLI refused its configured working directory', { cause: 'working-directory' })
    this.name = 'CliWorkingDirectoryError'
  }
}

/** SIGKILL was requested, but ChildProcess never proved process/stdio closure. */
export class CliTeardownTimeoutError extends Error {
  readonly code = 'CLI_TEARDOWN_TIMEOUT'

  constructor(
    readonly provider: CliInvocation['provider'],
    readonly timeoutMs: number,
  ) {
    super(`${provider} CLI did not close within ${timeoutMs}ms after SIGKILL`, { cause: 'process-exit' })
    this.name = 'CliTeardownTimeoutError'
  }
}

export type CliPromptInputFailureReason = 'MISSING_STDIN' | 'WRITE_FAILED' | 'CLOSED_EARLY' | 'FILE_PREPARE_FAILED' | 'FILE_CLEANUP_FAILED'

/** Prompt transport failed without embedding any request content in the error. */
export class CliPromptInputError extends Error {
  readonly code = 'CLI_PROMPT_INPUT_ERROR'

  constructor(
    readonly provider: CliInvocation['provider'],
    readonly reason: CliPromptInputFailureReason,
  ) {
    super(promptInputErrorMessage(provider, reason), { cause: 'prompt-input' })
    this.name = 'CliPromptInputError'
  }
}

const defaults = {
  timeoutMs: 10 * 60_000,
  killGraceMs: 3_000,
  maxLineBytes: 64 * 1024,
  maxOutputBytes: 512 * 1024,
  maxStderrBytes: 32 * 1024,
} as const

const defaultSpawn: SpawnProcess = (command, args, options) => nodeSpawn(command, [...args], { ...options, stdio: [...options.stdio] }) as SpawnedProcess

const inheritedEnvNames = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'USERPROFILE',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'DBUS_SESSION_BUS_ADDRESS',
  'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CURSOR_CONFIG_DIR',
  'GROK_HOME', 'GROK_CONFIG_DIR', 'XAI_CONFIG_DIR',
])

const excludedEnvNames = new Set([
  'CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CURSOR_API_KEY', 'XAI_API_KEY',
  'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'XAI_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_PROFILE',
])

/** Build an inherited environment that favours the local CLI's subscription login over API-key billing. */
export function buildSubscriptionEnv(extraEnvNames: readonly string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of new Set([...inheritedEnvNames, ...extraEnvNames])) {
    if (excludedEnvNames.has(name.toUpperCase())) continue
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

interface PreparedPromptTransport {
  readonly args: readonly string[]
  readonly cleanup: () => Promise<void>
}

async function preparePromptTransport(invocation: CliInvocation): Promise<PreparedPromptTransport> {
  if (invocation.promptTransport === 'stdin') {
    return { args: invocation.args, cleanup: async () => {} }
  }

  let directory: string | undefined
  let promptPath: string | undefined
  try {
    directory = await mkdtemp(join(tmpdir(), 'dsh-coding-prompt-'))
    // mkdtemp is private on supported platforms; chmod makes the contract explicit
    // for unusual umasks and for tests that exercise the Windows transport on POSIX.
    await chmod(directory, 0o700)
    promptPath = join(directory, 'prompt.txt')
    const handle = await open(promptPath, 'wx', 0o600)
    try {
      await handle.writeFile(invocation.prompt, { encoding: 'utf8' })
    } finally {
      await handle.close()
    }
  } catch {
    if (promptPath !== undefined) await unlink(promptPath).catch(() => {})
    if (directory !== undefined) await rmdir(directory).catch(() => {})
    throw new CliPromptInputError(invocation.provider, 'FILE_PREPARE_FAILED')
  }

  let fileCleaned = false
  let directoryCleaned = false
  const cleanup = async (): Promise<void> => {
    if (!fileCleaned) {
      try {
        await unlink(promptPath)
        fileCleaned = true
      } catch (error) {
        if (isNotFoundError(error)) fileCleaned = true
        else throw new CliPromptInputError(invocation.provider, 'FILE_CLEANUP_FAILED')
      }
    }
    if (!directoryCleaned) {
      try {
        await rmdir(directory)
        directoryCleaned = true
      } catch (error) {
        if (isNotFoundError(error)) directoryCleaned = true
        else throw new CliPromptInputError(invocation.provider, 'FILE_CLEANUP_FAILED')
      }
    }
  }
  return {
    args: ['--prompt-file', promptPath, ...invocation.args],
    cleanup,
  }
}

/**
 * Starts one local, already-authenticated coding CLI and yields only assistant text.
 * It never reads credential files or accepts credential values in config. An explicitly
 * allowlisted environment name may still be forwarded unchanged to the official CLI.
 * No shell is invoked.
 */
export async function* runCliText(invocation: CliInvocation, options: RunCliTextOptions = {}): AsyncIterable<string> {
  const limits = { ...defaults, ...options }
  // Pre-spawn failures never handed prompt input to the child: report not-submitted and stop.
  const reportPreSpawn = (): void => {
    if (options.onSettled === undefined) return
    try {
      options.onSettled({ phase: 'spawn', promptSubmissionState: 'not-submitted', assistantTextObserved: false, teardownState: 'not-started' })
    } catch {
      // A diagnostic sink must never change model-call settlement.
    }
  }
  if (options.signal?.aborted) {
    reportPreSpawn()
    throw abortError('aborted before CLI spawn')
  }
  let prepared: PreparedPromptTransport
  try {
    prepared = await preparePromptTransport(invocation)
  } catch (error) {
    reportPreSpawn()
    throw error
  }
  // Creating a private Grok prompt file is asynchronous. Close the abort race
  // before spawning and remove the file before returning control to the caller.
  if (options.signal?.aborted) {
    let cleanupError: Error | undefined
    try {
      await prepared.cleanup()
    } catch (error) {
      cleanupError = error as Error
    }
    reportPreSpawn()
    throw cleanupError ?? abortError('aborted before CLI spawn')
  }
  let child: SpawnedProcess
  try {
    child = (options.spawn ?? defaultSpawn)(invocation.command, prepared.args, {
      cwd: invocation.cwd,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildSubscriptionEnv(options.extraEnvNames),
    })
  } catch (error) {
    let cleanupError: Error | undefined
    try {
      await prepared.cleanup()
    } catch (cleanupFailure) {
      cleanupError = cleanupFailure as Error
    }
    reportPreSpawn()
    throw cleanupError ?? error
  }
  const queue = new TextQueue()
  let totalOutputBytes = 0
  let stderr = ''
  let finished = false
  let stopping = false
  let terminationError: Error | undefined
  let sawIncrementalText = false
  let sawAggregateText = false
  let sawValidJson = false
  let sawAssistantText = false
  let sawSuccessTerminal = false
  let terminalReason: 'success' | 'reported-failure' | 'invalid-terminal' | 'native-tool-event' | undefined
  let sawCursorAuthInit = false
  let sawChildOutput = false
  let sawStdoutOutput = false
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let postKillTimer: ReturnType<typeof setTimeout> | undefined
  let resolveClosed: (() => void) | undefined
  const closed = new Promise<void>(resolve => { resolveClosed = resolve })
  let disposeStdin = (): void => {}
  let disposeStdout = (): void => {}
  let disposeStderr = (): void => {}
  // Prompt input is not submitted until either the whole stdin stream flushes or
  // the OS accepts Grok's private prompt-file path. Partial stdin writes are unknown.
  // A temporary-file path already entered spawn argv when spawn() returned, so
  // its state is unknown until a spawn/error event. stdin carries no prompt argv
  // and remains provably not-submitted until the first write attempt.
  let promptSubmissionState: PromptSubmissionState = invocation.promptTransport === 'secure-temporary-file'
    ? 'unknown'
    : 'not-submitted'
  let promptInputStarted = false
  let sawSpawn = false
  let phase: CliLifecyclePhase = 'spawn'
  // Teardown begins the moment `stop` fires and completes when ChildProcess `close` is settled.
  let teardownState: TeardownState = 'not-started'
  // Monotonic clock anchors (ms); each metric is reported only when both its ends are known.
  // `spawn()` returning a ChildProcess does not prove the OS accepted it, so the spawn
  // anchor is captured only from the corresponding child event below.
  let spawnedAt: number | undefined
  let firstEventAt: number | undefined
  let firstTextAt: number | undefined
  let terminalAt: number | undefined
  let stopAt: number | undefined
  let closeAt: number | undefined
  let observedExitCode: number | null | undefined
  let observedSignal: NodeJS.Signals | null | undefined

  const buildMetrics = (): CliLifecycleMetrics | undefined => {
    const metrics: Record<string, number> = {}
    if (spawnedAt !== undefined && firstEventAt !== undefined && firstEventAt >= spawnedAt) {
      metrics.spawnToFirstEventMs = firstEventAt - spawnedAt
    }
    if (firstEventAt !== undefined && firstTextAt !== undefined) metrics.eventToFirstTextMs = firstTextAt - firstEventAt
    if (spawnedAt !== undefined && terminalAt !== undefined && terminalAt >= spawnedAt) {
      metrics.spawnToTerminalMs = terminalAt - spawnedAt
    }
    if (stopAt !== undefined && closeAt !== undefined) metrics.teardownDurationMs = closeAt - stopAt
    return Object.keys(metrics).length > 0 ? metrics : undefined
  }

  const reportSettled = (error: Error | undefined): void => {
    if (options.onSettled === undefined) return
    const metrics = buildMetrics()
    const context: ProviderFailureContext = {
      phase: error === undefined ? 'terminal' : phase,
      promptSubmissionState,
      assistantTextObserved: sawAssistantText,
      teardownState,
      ...(terminalReason !== undefined ? { terminalReason } : {}),
      ...(observedExitCode !== undefined ? { exitCode: observedExitCode } : {}),
      ...(observedSignal !== undefined ? { signal: observedSignal } : {}),
      ...(metrics !== undefined ? { metrics } : {}),
    }
    try {
      options.onSettled(context)
    } catch {
      // A diagnostic sink must never change model-call settlement.
    }
  }

  const stop = (error: Error) => {
    if (stopping || finished) return
    stopping = true
    terminationError = error
    if (teardownState === 'not-started') teardownState = 'in-progress'
    stopAt ??= performance.now()
    destroyWritable(child.stdin)
    terminateProcessTree(child, 'SIGINT')
    // An injected/embedded ChildProcess may emit close synchronously from kill().
    // Do not arm escalation after that close already settled the request.
    if (finished) return
    killTimer = setTimeout(() => {
      terminateProcessTree(child, 'SIGKILL')
      // Apply the same guard when SIGKILL synchronously proves closure.
      if (finished) return
      // SIGKILL being sent does not prove that the process (or its stdio) has
      // closed. Give `close` one more bounded grace interval, then settle with
      // an explicit live-process-risk state instead of hanging forever.
      postKillTimer = setTimeout(() => {
        phase = 'child-close'
        teardownState = 'timed-out'
        // Preserve the initiating model-call error (abort/timeout/protocol/limit)
        // for routing and health classification. The distinct teardown risk lives
        // in context; the fallback is only for defensive completeness.
        close(terminationError ?? new CliTeardownTimeoutError(invocation.provider, limits.killGraceMs), false)
      }, limits.killGraceMs)
    }, limits.killGraceMs)
  }
  const onAbort = () => stop(abortError('CLI execution aborted'))
  const timeout = setTimeout(() => stop(timeoutError(limits.timeoutMs)), limits.timeoutMs)

  const cleanupChildTracking = (): void => {
    child.removeListener?.('spawn', onSpawn)
    child.removeListener?.('error', onError)
    child.removeListener?.('close', onClose)
    disposeStdin()
    disposeStdout()
    disposeStderr()
  }

  const close = (error?: Error, observedClose = true) => {
    if (finished) {
      // A post-deadline close only releases background tracking. The request and
      // its diagnostic callback were already settled exactly once as timed-out.
      if (observedClose && teardownState === 'timed-out') {
        cleanupChildTracking()
        // A Windows child may have kept the prompt file open past the teardown
        // deadline. Retry deletion once actual process/stdio closure is observed.
        void prepared.cleanup().catch(() => {})
      }
      return
    }
    finished = true
    clearTimeout(timeout)
    if (killTimer) clearTimeout(killTimer)
    if (postKillTimer) clearTimeout(postKillTimer)
    options.signal?.removeEventListener('abort', onAbort)
    if (observedClose) {
      // The child's stdio has now closed; any teardown started by `stop` has completed.
      closeAt ??= performance.now()
      if (teardownState === 'in-progress') teardownState = 'completed'
      cleanupChildTracking()
    } else {
      // The request is bounded, while minimal background listeners keep draining
      // pipes and observe a late close without ever reporting a second settlement.
      child.unref?.()
    }
    if (stderr) {
      try {
        options.onDiagnostic?.(stderr)
      } catch {
        // Diagnostics must never change model-call settlement.
      }
    }
    const settleAfterPromptCleanup = async (): Promise<void> => {
      let settledError = error
      try {
        await prepared.cleanup()
      } catch (cleanupError) {
        if (settledError === undefined) {
          phase = 'child-close'
          settledError = cleanupError as Error
        }
      }
      reportSettled(settledError)
      queue.close(settledError)
      resolveClosed?.()
    }
    void settleAfterPromptCleanup()
  }
  const onError = (error: Error) => {
    // Node guarantees `close` after a spawn `error`. Waiting for it also avoids
    // treating a kill-related error as proof that a live process has exited.
    // Any spawn error before both a `spawn` event and any child output (ENOENT,
    // EACCES, and every other pre-run failure alike) proves prompt input was never
    // attempted, so replay stays safe. Once the child has spawned or produced
    // output, submission is no longer disprovable.
    if (!stopping && !sawSpawn && !sawChildOutput) promptSubmissionState = 'not-submitted'
    if (!terminationError) terminationError = error
    stopping = true
  }
  const settleChildClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (terminationError) close(terminationError)
    else if (code !== 0 || signal !== null) {
      phase = 'child-close'
      close(invocation.provider === 'codex' && code === 1 && signal === null && !sawStdoutOutput
        && isCodexWorkingDirectoryRejection(stderr)
        ? new CliWorkingDirectoryError()
        : new CliProcessExitError(invocation.provider, code, signal))
    } else close(validateProtocolSettlement(invocation.provider, {
      sawValidJson,
      sawAssistantText,
      sawSuccessTerminal,
      sawCursorAuthInit,
    }))
  }
  const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
    observedExitCode = code
    observedSignal = signal
    if (finished) {
      settleChildClose(code, signal)
      return
    }
    // Writable `finish` is queued on nextTick for Node streams. Give it that one
    // bounded turn, then fail closed if a reduced process shim closed without ever
    // completing or explicitly failing its stdin lifecycle.
    process.nextTick(() => {
      if (!terminationError && invocation.promptTransport === 'stdin'
        && promptInputStarted && promptSubmissionState !== 'submitted') {
        phase = 'prompt'
        close(new CliPromptInputError(invocation.provider, 'CLOSED_EARLY'))
        return
      }
      settleChildClose(code, signal)
    })
  }

  const startPromptSubmission = (): void => {
    if (promptInputStarted || stopping || finished) return
    promptInputStarted = true
    phase = 'prompt'
    if (invocation.promptTransport === 'secure-temporary-file') {
      // The spawn event proves the private path was handed to the child. Keep the
      // file until child-close so Windows cannot race path opening against cleanup.
      promptSubmissionState = 'submitted'
      disposeStdin = closeUnusedWritable(child.stdin)
      return
    }

    const input = child.stdin
    if (!input) {
      stop(new CliPromptInputError(invocation.provider, 'MISSING_STDIN'))
      return
    }
    promptSubmissionState = 'unknown'
    let inputSettled = false
    const onInputFinish = (): void => {
      if (inputSettled) return
      inputSettled = true
      promptSubmissionState = 'submitted'
    }
    const onInputError = (): void => {
      if (inputSettled) return
      inputSettled = true
      if (stopping || finished) return
      stop(new CliPromptInputError(invocation.provider, 'WRITE_FAILED'))
    }
    const onInputClose = (): void => {
      if (inputSettled) return
      inputSettled = true
      if (stopping || finished) return
      stop(new CliPromptInputError(invocation.provider, 'CLOSED_EARLY'))
    }
    input.once('finish', onInputFinish)
    // Keep absorbing any follow-up stream errors until child-close cleanup.
    input.on('error', onInputError)
    input.once('close', onInputClose)
    disposeStdin = () => {
      input.removeListener('finish', onInputFinish)
      input.removeListener('error', onInputError)
      input.removeListener('close', onInputClose)
    }
    try {
      input.end(invocation.prompt)
    } catch {
      onInputError()
    }
  }

  // A delivered `spawn` is the first point at which prompt transport may begin.
  const onSpawn = () => {
    sawSpawn = true
    spawnedAt ??= performance.now()
    if (phase === 'spawn') phase = 'initialize'
    startPromptSubmission()
  }
  child.once('spawn', onSpawn)
  child.once('error', onError)
  // Unlike `exit`, `close` fires after stdio is closed, so the final JSONL event
  // cannot be dropped while buffered stdout is still draining.
  child.once('close', onClose)

  disposeStdout = consumeLines(child.stdout, limits.maxLineBytes, line => {
    if (stopping || finished) return
    // Real ChildProcess always emits `spawn` before output. Starting here as a
    // defensive fallback also supports embedders that provide a reduced process shim.
    startPromptSubmission()
    // Child output proves the process ran. Without a full stdin finish or accepted
    // prompt-file path, replay safety is unknown.
    sawChildOutput = true
    if (promptSubmissionState === 'not-submitted') promptSubmissionState = 'unknown'
    const decoded = decodeJsonLine(line)
    if (decoded.kind === 'empty') return
    if (sawSuccessTerminal) {
      stop(new CliProtocolError(invocation.provider, 'EVENT_AFTER_TERMINAL'))
      return
    }
    sawStdoutOutput = true
    if (decoded.kind === 'malformed') {
      stop(new CliProtocolError(invocation.provider, 'MALFORMED_JSON'))
      return
    }
    sawValidJson = true
    if (!decoded.event) {
      stop(new CliProtocolError(invocation.provider, 'UNKNOWN_EVENT'))
      return
    }
    const parsed = parseProviderEvent(invocation.provider, decoded.event)
    if (!parsed) {
      stop(new CliProtocolError(invocation.provider, 'UNKNOWN_EVENT'))
      return
    }
    firstEventAt ??= performance.now()
    if (phase === 'spawn' || phase === 'initialize') phase = 'prompt'
    if (parsed.auth === 'subscription') sawCursorAuthInit = true
    else if (parsed.auth === 'other') {
      stop(new CliSubscriptionAuthError('cursor', 'UNEXPECTED_AUTH_SOURCE'))
      return
    }
    if (parsed.nativeTool) {
      terminalReason = 'native-tool-event'
      phase = 'terminal'
      stop(new CliProtocolError(invocation.provider, 'NATIVE_TOOL_EVENT'))
      return
    }
    if (parsed.outcome === 'failure') {
      terminalReason = 'reported-failure'
      phase = 'terminal'
      stop(new CliProtocolError(invocation.provider, 'REPORTED_FAILURE'))
      return
    }
    if (parsed.outcome === 'invalid') {
      terminalReason = 'invalid-terminal'
      phase = 'terminal'
      stop(new CliProtocolError(invocation.provider, 'INVALID_TERMINAL'))
      return
    }
    if (parsed.outcome === 'success') {
      sawSuccessTerminal = true
      terminalReason = 'success'
      terminalAt ??= performance.now()
      phase = 'terminal'
    }
    if (!parsed.text) return
    sawAssistantText = true
    firstTextAt ??= performance.now()
    if (phase === 'prompt') phase = 'stream'
    if (parsed.terminal && (sawIncrementalText || sawAggregateText)) return
    if (parsed.terminal) sawAggregateText = true
    else sawIncrementalText = true
    totalOutputBytes += byteLength(parsed.text)
    if (totalOutputBytes > limits.maxOutputBytes) {
      stop(outputLimitError(limits.maxOutputBytes))
      return
    }
    queue.push(parsed.text)
  }, error => stop(error))
  disposeStderr = consumeLines(child.stderr, limits.maxLineBytes, line => {
    if (stopping || finished) return
    startPromptSubmission()
    sawChildOutput = true
    if (promptSubmissionState === 'not-submitted') promptSubmissionState = 'unknown'
    // Stderr is diagnostic only; never expose it as model output or retain it unbounded.
    stderr = appendBounded(stderr, line, limits.maxStderrBytes)
  }, error => stop(error))
  options.signal?.addEventListener('abort', onAbort, { once: true })
  // Close the race where the signal aborted after the pre-spawn check but before
  // listener registration. Child and pipe lifecycle handlers are installed first,
  // including for injected process implementations whose kill() settles synchronously.
  if (options.signal?.aborted) onAbort()

  try {
    for await (const text of queue) yield text
  } finally {
    // A consumer that breaks early must still give SIGINT the grace interval.
    if (!finished) stop(abortError('CLI output consumer closed early'))
    await closed
  }
}

export interface ParsedEvent {
  readonly text?: string
  /** True when text is a full aggregate that must not repeat prior deltas. */
  readonly terminal: boolean
  readonly outcome?: 'success' | 'failure' | 'invalid'
  readonly auth?: 'subscription' | 'other'
  /** The provider tried to use its own executor instead of the DSH tool bridge. */
  readonly nativeTool?: true
}

export function parseAssistantEvent(provider: CliInvocation['provider'], line: string): ParsedEvent | undefined {
  const decoded = decodeJsonLine(line)
  return decoded.kind === 'json' && decoded.event ? parseProviderEvent(provider, decoded.event) : undefined
}

/**
 * Recognizes one already-decoded JSON event into the normalized {@link ParsedEvent}.
 * The layering is: `decodeJsonLine` (syntax) -> a per-provider decoder (shape) ->
 * this dispatcher (routing) -> the stdout reducer in `runCliText` (text/terminal/auth).
 * An unrecognized event returns `undefined` so the caller can fail closed on it.
 */
function parseProviderEvent(provider: CliInvocation['provider'], event: Record<string, unknown>): ParsedEvent | undefined {
  return providerDecoders[provider](event)
}

type ProviderEventDecoder = (event: Record<string, unknown>) => ParsedEvent | undefined

const providerDecoders: Record<CliInvocation['provider'], ProviderEventDecoder> = {
  codex: decodeCodexEvent,
  claude: decodeClaudeEvent,
  cursor: decodeCursorEvent,
  grok: decodeGrokEvent,
}

function decodeCodexEvent(event: Record<string, unknown>): ParsedEvent | undefined {
  const item = object(event.item)
  if (isCodexItemEvent(event.type) && isCodexNativeToolItem(item)) return nativeTool()
  if (event.type === 'item.completed' && item?.type === 'agent_message') return parsed(textOf(item.content) ?? textOf(item.text), false)
  if (event.type === 'agent_message') return parsed(textOf(event.content) ?? textOf(event.text), false)
  if (event.type === 'turn.completed') return known({ outcome: 'success' })
  if (event.type === 'turn.failed' || event.type === 'error') return known({ outcome: 'failure' })
  if (event.type === 'thread.started' || event.type === 'turn.started' || event.type === 'item.started'
    || event.type === 'item.updated' || event.type === 'item.completed') return known()
  return undefined
}

function decodeClaudeEvent(event: Record<string, unknown>): ParsedEvent | undefined {
  const inner = object(event.event)
  if (isClaudeNativeToolEvent(event, inner)) return nativeTool()
  if (event.type === 'stream_event') return decodeAnthropicStreamEvent(inner)
  if (event.type === 'assistant') return parsed(textOf(event.message) ?? textOf(event.content), true)
  if (event.type === 'result') return parsed(textOf(event.result), true, resultOutcome(event))
  if (knownType(event, ['system', 'user', 'auth_status', 'rate_limit_event'])) return known()
  return undefined
}

function decodeCursorEvent(event: Record<string, unknown>): ParsedEvent | undefined {
  if (isToolLifecycle(event.type) || containsNativeToolBlock(event.message) || containsNativeToolBlock(event.content)) {
    return nativeTool()
  }
  if (event.type === 'system' && event.subtype === 'init') {
    return known({ auth: event.apiKeySource === 'login' ? 'subscription' : 'other' })
  }
  if (event.type === 'system') return known()
  if (event.type === 'assistant') return parsed(textOf(event.message) ?? textOf(event.content) ?? textOf(event.text), false)
  if (event.type === 'result') return parsed(textOf(event.result) ?? textOf(event.message), true, resultOutcome(event))
  if (event.type === 'user') return known()
  return undefined
}

function decodeGrokEvent(event: Record<string, unknown>): ParsedEvent | undefined {
  const update = object(event.update)
  const paramsUpdate = object(object(event.params)?.update)
  const anthropic = object(event.event)
  if (isGrokNativeToolEvent(event, update, paramsUpdate, anthropic)) return nativeTool()
  if (event.type === 'text') {
    return typeof event.data === 'string' ? parsed(event.data, false) : undefined
  }
  if (event.type === 'error') return known({ outcome: 'failure' })
  if (event.type === 'end') {
    if (event.stopReason === 'end_turn') return known({ outcome: 'success' })
    if (event.stopReason === 'tool_use') return nativeTool()
    if (isKnownGrokFailureStopReason(event.stopReason)) return known({ outcome: 'failure' })
    return known({ outcome: 'invalid' })
  }
  if (event.type === 'available_commands') {
    if (!Array.isArray(event.tools) || (event.commands !== undefined && !Array.isArray(event.commands))) return undefined
    return event.tools.length === 0 ? known() : nativeTool()
  }
  if (event.type === 'usage') {
    if (event.stopReason === undefined || event.stopReason === 'end_turn') return known()
    if (event.stopReason === 'tool_use') return nativeTool()
    if (isKnownGrokFailureStopReason(event.stopReason)) return known({ outcome: 'failure' })
    return known({ outcome: 'invalid' })
  }
  if (event.type === 'streaming-messages-json' || event.type === 'message' || event.type === 'update') {
    const text = textOf(event.text) ?? textOf(event.content) ?? textOf(object(event.delta)?.text) ?? textOf(event.message)
    return text === undefined ? undefined : parsed(text, false)
  }
  if (event.type === 'stream_event') return decodeAnthropicStreamEvent(anthropic)
  if (event.type === 'content_block_delta') return decodeAnthropicContentBlockDelta(object(event.delta))
  if (typeof event.sessionUpdate === 'string') {
    return decodeGrokSessionUpdate(event.sessionUpdate, event.content ?? update?.content)
  }
  if (typeof update?.sessionUpdate === 'string') return decodeGrokSessionUpdate(update.sessionUpdate, update.content)
  if (event.method === 'session/update' && typeof paramsUpdate?.sessionUpdate === 'string') {
    return decodeGrokSessionUpdate(paramsUpdate.sessionUpdate, paramsUpdate.content)
  }
  if (event.type === 'result') {
    const outcome = resultOutcome(event)
    return parsed(textOf(event.result) ?? textOf(event.text), true, outcome === 'success' ? undefined : outcome)
  }
  if (event.type === 'assistant') return parsed(textOf(event.message) ?? textOf(event.content) ?? textOf(event.text), false)
  if (knownType(event, ['system', 'user'])) return known()
  return undefined
}

function isCodexItemEvent(type: unknown): boolean {
  return type === 'item.started' || type === 'item.updated' || type === 'item.completed'
}

function decodeAnthropicStreamEvent(inner: Record<string, unknown> | undefined): ParsedEvent | undefined {
  if (inner?.type === 'content_block_delta') return decodeAnthropicContentBlockDelta(object(inner.delta))
  if (inner?.type === 'content_block_start') {
    const block = object(inner.content_block)
    if (!knownValue(block?.type, ['text', 'thinking', 'redacted_thinking'])) return undefined
    return parsed(textOf(block?.text), false)
  }
  if (inner?.type === 'error') return known({ outcome: 'failure' })
  if (knownValue(inner?.type, ['message_start', 'content_block_stop', 'message_delta', 'message_stop', 'ping'])) return known()
  return undefined
}

function decodeAnthropicContentBlockDelta(delta: Record<string, unknown> | undefined): ParsedEvent | undefined {
  if (delta?.type === undefined && typeof delta?.text === 'string') return parsed(delta.text, false)
  if (delta?.type === 'text_delta' && typeof delta.text === 'string') return parsed(delta.text, false)
  if (knownValue(delta?.type, ['thinking_delta', 'signature_delta', 'citations_delta'])) return known()
  return undefined
}

const passiveGrokSessionUpdates = [
  'user_message_chunk',
  'agent_thought_chunk',
  'plan',
  'plan_update',
  'plan_removed',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  'usage_update',
] as const

function decodeGrokSessionUpdate(type: string, content: unknown): ParsedEvent | undefined {
  if (type === 'agent_message_chunk') {
    const text = textOf(content)
    return text === undefined ? undefined : parsed(text, false)
  }
  return knownValue(type, passiveGrokSessionUpdates) ? known() : undefined
}

/** Codex exec JSONL currently has only three passive item kinds; every other
 * item kind represents a built-in/dynamic tool or another active capability.
 * Keeping this as a passive allowlist makes new native executors fail closed. */
function isCodexNativeToolItem(item: Record<string, unknown> | undefined): boolean {
  if (typeof item?.type !== 'string') return true
  return item.type !== 'agent_message' && item.type !== 'reasoning' && item.type !== 'error'
}

function isClaudeNativeToolEvent(
  event: Record<string, unknown>,
  inner: Record<string, unknown> | undefined,
): boolean {
  if (isToolLifecycle(event.type) || event.type === 'tool_progress') return true
  if (event.stop_reason === 'tool_use' || object(event.message)?.stop_reason === 'tool_use') return true
  if (object(inner?.delta)?.stop_reason === 'tool_use') return true
  if (event.type === 'system' && Array.isArray(event.tools) && event.tools.length > 0) return true
  if (containsNativeToolBlock(event.message) || containsNativeToolBlock(event.content)
    || containsNativeToolBlock(event.delta)) return true
  return event.type === 'stream_event'
    && (containsNativeToolBlock(inner?.message) || containsNativeToolBlock(inner?.content_block)
      || containsNativeToolBlock(inner?.delta))
}

function isGrokNativeToolEvent(
  event: Record<string, unknown>,
  update: Record<string, unknown> | undefined,
  paramsUpdate: Record<string, unknown> | undefined,
  anthropic: Record<string, unknown> | undefined,
): boolean {
  if (isToolLifecycle(event.type) || isToolLifecycle(event.sessionUpdate)
    || isToolLifecycle(update?.sessionUpdate) || isToolLifecycle(paramsUpdate?.sessionUpdate)) return true
  if (event.type === 'available_commands' && Array.isArray(event.tools) && event.tools.length > 0) return true
  if (event.method === 'session/request_permission' || event.method === 'session/requestPermission') return true
  if (containsNativeToolBlock(event.message) || containsNativeToolBlock(event.content)
    || containsNativeToolBlock(event.delta)) return true
  return event.type === 'stream_event'
    && (containsNativeToolBlock(anthropic?.message) || containsNativeToolBlock(anthropic?.content_block)
      || containsNativeToolBlock(anthropic?.delta))
}

function isToolLifecycle(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return value === 'tool_call' || value === 'tool_result' || value === 'tool_use'
    || value.startsWith('tool_call_') || value.startsWith('tool_use_')
    || value === 'hook_execution' || value === 'pending_interaction' || value === 'interaction_resolved'
}

function containsNativeToolBlock(value: unknown, depth = 0): boolean {
  if (depth > 8) return false
  if (Array.isArray(value)) return value.some(item => containsNativeToolBlock(item, depth + 1))
  const record = object(value)
  if (record === undefined) return false
  const type = record.type
  if (isToolLifecycle(type) || type === 'server_tool_use' || type === 'input_json_delta'
    || (typeof type === 'string' && type.endsWith('_tool_result'))) return true
  return containsNativeToolBlock(record.content, depth + 1)
    || containsNativeToolBlock(record.message, depth + 1)
    || containsNativeToolBlock(record.content_block, depth + 1)
    || containsNativeToolBlock(record.delta, depth + 1)
}

function nativeTool(): ParsedEvent {
  return { terminal: false, nativeTool: true }
}

export function parseAssistantText(provider: CliInvocation['provider'], line: string): string | undefined {
  return parseAssistantEvent(provider, line)?.text
}

function parsed(text: string | undefined, terminal: boolean, outcome?: 'success' | 'failure' | 'invalid'): ParsedEvent {
  return { ...(text ? { text } : {}), terminal, ...(outcome ? { outcome } : {}) }
}

function known(fields: Omit<ParsedEvent, 'terminal'> = {}): ParsedEvent {
  return { terminal: false, ...fields }
}

function knownType(event: Record<string, unknown>, types: readonly string[]): boolean {
  return typeof event.type === 'string' && types.includes(event.type)
}

function knownValue(value: unknown, values: readonly string[]): value is string {
  return typeof value === 'string' && values.includes(value)
}

function isKnownGrokFailureStopReason(value: unknown): boolean {
  return knownValue(value, ['cancelled', 'canceled', 'max_tokens', 'max_turn_requests'])
}

function resultOutcome(event: Record<string, unknown>): 'success' | 'failure' | 'invalid' {
  const subtype = typeof event.subtype === 'string' ? event.subtype.toLowerCase() : ''
  if (subtype === 'success' && event.is_error === false) return 'success'
  if (event.is_error === true || event.success === false
    || (event.error !== undefined && event.error !== null && event.error !== false)
    || subtype.includes('error') || subtype.includes('fail')
    || subtype.includes('cancel') || subtype.includes('interrupt')) return 'failure'
  return 'invalid'
}

type DecodedJsonLine =
  | { readonly kind: 'empty' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'json'; readonly event?: Record<string, unknown> }

function decodeJsonLine(line: string): DecodedJsonLine {
  const trimmed = line.trim()
  if (!trimmed) return { kind: 'empty' }
  try {
    const value: unknown = JSON.parse(trimmed)
    const event = object(value)
    return event ? { kind: 'json', event } : { kind: 'json' }
  } catch {
    return { kind: 'malformed' }
  }
}

interface ProtocolSettlement {
  readonly sawValidJson: boolean
  readonly sawAssistantText: boolean
  readonly sawSuccessTerminal: boolean
  readonly sawCursorAuthInit: boolean
}

function validateProtocolSettlement(provider: CliInvocation['provider'], state: ProtocolSettlement): Error | undefined {
  if (provider === 'cursor' && !state.sawCursorAuthInit) {
    return new CliSubscriptionAuthError('cursor', 'MISSING_AUTH_EVENT')
  }
  if (!state.sawValidJson) return new CliProtocolError(provider, 'NO_JSON_EVENTS')
  if (!state.sawAssistantText) return new CliProtocolError(provider, 'NO_ASSISTANT_TEXT')
  if ((provider === 'codex' || provider === 'claude' || provider === 'cursor' || provider === 'grok') && !state.sawSuccessTerminal) {
    return new CliProtocolError(provider, 'MISSING_SUCCESS_TERMINAL')
  }
  return undefined
}

function protocolErrorMessage(provider: CliInvocation['provider'], reason: CliProtocolFailureReason): string {
  const descriptions: Record<CliProtocolFailureReason, string> = {
    MALFORMED_JSON: 'emitted malformed NDJSON',
    NO_JSON_EVENTS: 'closed without any JSON events',
    UNKNOWN_EVENT: 'emitted an event outside the supported protocol allowlist',
    EVENT_AFTER_TERMINAL: 'emitted an event after its successful terminal event',
    NO_ASSISTANT_TEXT: 'closed without assistant text',
    MISSING_SUCCESS_TERMINAL: 'closed without a successful terminal event',
    INVALID_TERMINAL: 'emitted an unrecognized terminal result',
    NATIVE_TOOL_EVENT: 'emitted a forbidden native tool event',
    REPORTED_FAILURE: 'reported a failed model turn',
  }
  return `${provider} CLI ${descriptions[reason]}`
}

function promptInputErrorMessage(provider: CliInvocation['provider'], reason: CliPromptInputFailureReason): string {
  const descriptions: Record<CliPromptInputFailureReason, string> = {
    MISSING_STDIN: 'did not expose a writable stdin pipe',
    WRITE_FAILED: 'failed while receiving prompt input',
    CLOSED_EARLY: 'closed before prompt input completed',
    FILE_PREPARE_FAILED: 'could not prepare its private prompt file',
    FILE_CLEANUP_FAILED: 'could not remove its private prompt file',
  }
  return `${provider} CLI ${descriptions[reason]}`
}

function exitDescription(code: number | null, signal: NodeJS.Signals | null): string {
  const parts = [`code=${code === null ? 'null' : String(code)}`]
  if (signal !== null) parts.push(`signal=${signal}`)
  return parts.join(', ')
}

function isCodexWorkingDirectoryRejection(diagnostic: string): boolean {
  const expected = 'Not inside a trusted directory and --skip-git-repo-check was not specified.'
  const allowed = new Set([expected, 'Reading additional input from stdin...'])
  const lines = diagnostic.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  return lines.includes(expected) && lines.every(line => allowed.has(line))
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return textOf(object(value)?.text) ?? textOf(object(value)?.content)
  if (Array.isArray(value)) return value.map(part => textOf(part) ?? '').join('') || undefined
  return undefined
}

function appendBounded(value: string, addition: string, limit: number): string {
  const next = `${value}${value ? '\n' : ''}${addition}`
  const bytes = Buffer.from(next)
  return bytes.byteLength <= limit ? next : bytes.subarray(bytes.byteLength - limit).toString('utf8')
}

function byteLength(value: string): number { return Buffer.byteLength(value, 'utf8') }

function isNotFoundError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

function closeUnusedWritable(stream: NodeJS.WritableStream | null | undefined): () => void {
  if (!stream) return () => {}
  const onError = (): void => {}
  stream.on('error', onError)
  try {
    stream.end()
  } catch {
    // The prompt lives in the private file; failure to close an unused stdin pipe
    // neither loses nor exposes it. Keep absorbing a later stream error.
  }
  return () => { stream.removeListener('error', onError) }
}

function destroyWritable(stream: NodeJS.WritableStream | null | undefined): void {
  try {
    const destroyable = stream as (NodeJS.WritableStream & { destroy?: () => void }) | null | undefined
    destroyable?.destroy?.()
  } catch {
    // Process-tree termination remains the authoritative teardown path.
  }
}

function consumeLines(
  stream: NodeJS.ReadableStream | null | undefined,
  maxLineBytes: number,
  onLine: (line: string) => void,
  onError: (error: Error) => void,
): () => void {
  if (!stream) return () => {}
  let pending = ''
  stream.setEncoding('utf8')
  const onData = (chunk: string) => {
    pending += chunk
    while (true) {
      const newline = pending.indexOf('\n')
      if (newline === -1) {
        if (byteLength(pending) > maxLineBytes) {
          onError(lineLimitError(maxLineBytes))
          pending = ''
        }
        return
      }
      let line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (byteLength(line) > maxLineBytes) onError(lineLimitError(maxLineBytes))
      else onLine(line)
    }
  }
  const onEnd = () => {
    if (!pending) return
    if (byteLength(pending) > maxLineBytes) onError(lineLimitError(maxLineBytes))
    else onLine(pending)
  }
  stream.on('data', onData)
  stream.on('error', onError)
  stream.on('end', onEnd)
  return () => {
    stream.removeListener('data', onData)
    stream.removeListener('error', onError)
    stream.removeListener('end', onEnd)
  }
}

function abortError(message: string): Error { return new Error(message, { cause: 'abort' }) }
function timeoutError(timeoutMs: number): Error { return new Error(`CLI execution timed out after ${timeoutMs}ms`, { cause: 'timeout' }) }
function outputLimitError(maxOutputBytes: number): Error { return new Error(`CLI output exceeded ${maxOutputBytes} bytes`, { cause: 'output-limit' }) }
function lineLimitError(maxLineBytes: number): Error { return new Error(`CLI line exceeded ${maxLineBytes} bytes`, { cause: 'line-limit' }) }

function terminateProcessTree(child: SpawnedProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid !== undefined && child.pid > 0) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // The group may already have exited; fall back to the direct child handle.
    }
  }
  try {
    child.kill(signal)
  } catch {
    // Teardown is best-effort after the process has already disappeared.
  }
}

class TextQueue implements AsyncIterable<string> {
  private values: string[] = []
  private waiter: (() => void) | undefined
  private error: Error | undefined
  private done = false

  push(value: string): void {
    if (this.done) return
    this.values.push(value)
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }

  close(error?: Error): void {
    if (this.done) return
    this.done = true
    this.error = error
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    while (true) {
      if (this.values.length) yield this.values.shift()!
      else if (this.done) {
        if (this.error) throw this.error
        return
      } else {
        await new Promise<void>(resolve => { this.waiter = resolve })
      }
    }
  }
}
