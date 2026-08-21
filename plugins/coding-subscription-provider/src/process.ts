import { spawn as nodeSpawn } from 'node:child_process'
import type { CliInvocation } from './providers.js'

export interface SpawnedProcess {
  readonly pid?: number
  readonly stdout?: NodeJS.ReadableStream | null
  readonly stderr?: NodeJS.ReadableStream | null
  readonly exitCode?: number | null
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: 'error' | 'close' | 'spawn', listener: (...args: any[]) => void): this
  removeListener?(event: 'error' | 'close' | 'spawn', listener: (...args: any[]) => void): this
  unref?(): void
}

/** Whether the prompt argv was handed to the OS; the only safe basis for reasoning about replay. */
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
  options: { cwd: string; shell: false; detached: boolean; stdio: readonly ['ignore', 'pipe', 'pipe']; env: NodeJS.ProcessEnv },
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
  | 'UNRECOGNIZED_EVENTS'
  | 'NO_ASSISTANT_TEXT'
  | 'MISSING_SUCCESS_TERMINAL'
  | 'INVALID_TERMINAL'
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

/**
 * Starts one local, already-authenticated coding CLI and yields only assistant text.
 * It never reads credential files or accepts credential values in config. An explicitly
 * allowlisted environment name may still be forwarded unchanged to the official CLI.
 * No shell is invoked.
 */
export async function* runCliText(invocation: CliInvocation, options: RunCliTextOptions = {}): AsyncIterable<string> {
  const limits = { ...defaults, ...options }
  // Pre-spawn failures never handed the prompt argv to the OS: report not-submitted and stop.
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
  let child: SpawnedProcess
  try {
    child = (options.spawn ?? defaultSpawn)(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildSubscriptionEnv(options.extraEnvNames),
    })
  } catch (error) {
    reportPreSpawn()
    throw error
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
  let sawRecognizedEvent = false
  let sawAssistantText = false
  let sawSuccessTerminal = false
  let terminalReason: 'success' | 'reported-failure' | 'invalid-terminal' | undefined
  let sawCursorAuthInit = false
  let sawChildOutput = false
  let sawStdoutOutput = false
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let postKillTimer: ReturnType<typeof setTimeout> | undefined
  let resolveClosed: (() => void) | undefined
  const closed = new Promise<void>(resolve => { resolveClosed = resolve })
  let disposeStdout = (): void => {}
  let disposeStderr = (): void => {}
  // spawn() returned after receiving prompt argv, but only a later spawn/error event
  // can prove whether the OS accepted or rejected it.
  let promptSubmissionState: PromptSubmissionState = 'unknown'
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
    disposeStdout()
    disposeStderr()
  }

  const close = (error?: Error, observedClose = true) => {
    if (finished) {
      // A post-deadline close only releases background tracking. The request and
      // its diagnostic callback were already settled exactly once as timed-out.
      if (observedClose && teardownState === 'timed-out') cleanupChildTracking()
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
    reportSettled(error)
    queue.close(error)
    resolveClosed?.()
  }
  const onError = (error: Error) => {
    // Node guarantees `close` after a spawn `error`. Waiting for it also avoids
    // treating a kill-related error as proof that a live process has exited.
    // Any spawn error before both a `spawn` event and any child output (ENOENT,
    // EACCES, and every other pre-run failure alike) proves the OS never accepted
    // the prompt argv, so replay stays safe: mark `not-submitted`. Once the child
    // has spawned or produced output, submission is no longer disprovable and the
    // state is left as-is (`submitted` or the default `unknown`).
    if (!stopping && !sawSpawn && !sawChildOutput) promptSubmissionState = 'not-submitted'
    if (!terminationError) terminationError = error
    stopping = true
  }
  const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
    observedExitCode = code
    observedSignal = signal
    if (terminationError) close(terminationError)
    else if (code !== 0 || signal !== null) {
      phase = 'child-close'
      close(invocation.provider === 'codex' && code === 1 && signal === null && !sawStdoutOutput
        && isCodexWorkingDirectoryRejection(stderr)
        ? new CliWorkingDirectoryError()
        : new CliProcessExitError(invocation.provider, code, signal))
    } else close(validateProtocolSettlement(invocation.provider, {
      sawValidJson,
      sawRecognizedEvent,
      sawAssistantText,
      sawSuccessTerminal,
      sawCursorAuthInit,
    }))
  }
  // A delivered `spawn` proves the OS accepted the prompt argv; before it, replay is still safe.
  const onSpawn = () => {
    sawSpawn = true
    spawnedAt ??= performance.now()
    promptSubmissionState = 'submitted'
    if (phase === 'spawn') phase = 'initialize'
  }
  child.once('spawn', onSpawn)
  child.once('error', onError)
  // Unlike `exit`, `close` fires after stdio is closed, so the final JSONL event
  // cannot be dropped while buffered stdout is still draining.
  child.once('close', onClose)

  disposeStdout = consumeLines(child.stdout, limits.maxLineBytes, line => {
    if (stopping || finished) return
    // Child output proves the process ran. On its own it never proves the prompt was
    // submitted, so the state stays at its default `unknown` (never demoted to
    // `not-submitted`): `onError` only sets `not-submitted` while `!sawChildOutput`, so
    // any spawn error after this point leaves submission `unknown`, not `not-submitted`.
    sawChildOutput = true
    const decoded = decodeJsonLine(line)
    if (decoded.kind === 'empty') return
    sawStdoutOutput = true
    if (decoded.kind === 'malformed') {
      stop(new CliProtocolError(invocation.provider, 'MALFORMED_JSON'))
      return
    }
    sawValidJson = true
    if (!decoded.event) return
    const parsed = parseProviderEvent(invocation.provider, decoded.event)
    if (!parsed) return
    sawRecognizedEvent = true
    firstEventAt ??= performance.now()
    if (phase === 'spawn' || phase === 'initialize') phase = 'prompt'
    if (parsed.auth === 'subscription') sawCursorAuthInit = true
    else if (parsed.auth === 'other') {
      stop(new CliSubscriptionAuthError('cursor', 'UNEXPECTED_AUTH_SOURCE'))
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
    sawChildOutput = true
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
  if (event.type === 'stream_event' && inner?.type === 'content_block_delta') return parsed(textOf(object(inner.delta)?.text), false)
  if (event.type === 'stream_event') return known()
  if (event.type === 'assistant') return parsed(textOf(event.message) ?? textOf(event.content), true)
  if (event.type === 'result') return parsed(textOf(event.result), true, resultOutcome(event))
  if (knownType(event, ['system', 'user', 'tool_progress', 'tool_use_summary', 'auth_status', 'rate_limit_event'])) return known()
  return undefined
}

function decodeCursorEvent(event: Record<string, unknown>): ParsedEvent | undefined {
  if (event.type === 'system' && event.subtype === 'init') {
    return known({ auth: event.apiKeySource === 'login' ? 'subscription' : 'other' })
  }
  if (event.type === 'system') return known()
  if (event.type === 'assistant') return parsed(textOf(event.message) ?? textOf(event.content) ?? textOf(event.text), false)
  if (event.type === 'result') return parsed(textOf(event.result) ?? textOf(event.message), true, resultOutcome(event))
  if (knownType(event, ['user', 'tool_call', 'tool_result'])) return known()
  return undefined
}

function decodeGrokEvent(event: Record<string, unknown>): ParsedEvent | undefined {
  if (event.type === 'text') {
    return typeof event.data === 'string' ? parsed(event.data, false) : undefined
  }
  if (event.type === 'error') return known({ outcome: 'failure' })
  if (event.type === 'end') {
    return typeof event.stopReason === 'string' && event.stopReason.length > 0
      ? known({ outcome: 'success' })
      : known({ outcome: 'invalid' })
  }
  if (event.type === 'streaming-messages-json' || event.type === 'message' || event.type === 'update') {
    return parsed(textOf(event.text) ?? textOf(event.content) ?? textOf(object(event.delta)?.text) ?? textOf(event.message), false)
  }
  const anthropic = object(event.event)
  if (event.type === 'stream_event' && anthropic?.type === 'content_block_delta') return parsed(textOf(object(anthropic.delta)?.text), false)
  if (event.type === 'stream_event') return known()
  if (event.type === 'content_block_delta') return parsed(textOf(object(event.delta)?.text), false)
  const update = object(event.update)
  if (event.sessionUpdate === 'agent_message_chunk') return parsed(textOf(event.content) ?? textOf(update?.text) ?? textOf(update?.content), false)
  if (typeof event.sessionUpdate === 'string') return known()
  if (update?.sessionUpdate === 'agent_message_chunk') return parsed(textOf(update.content), false)
  if (typeof update?.sessionUpdate === 'string') return known()
  const paramsUpdate = object(object(event.params)?.update)
  if (event.method === 'session/update' && paramsUpdate?.sessionUpdate === 'agent_message_chunk') {
    return parsed(textOf(paramsUpdate.content), false)
  }
  if (event.method === 'session/update') return known()
  if (event.type === 'result') {
    const outcome = resultOutcome(event)
    return parsed(textOf(event.result) ?? textOf(event.text), true, outcome === 'success' ? undefined : outcome)
  }
  if (event.type === 'assistant') return parsed(textOf(event.message) ?? textOf(event.content) ?? textOf(event.text), false)
  if (knownType(event, ['system', 'user', 'tool_call', 'tool_result'])) return known()
  return undefined
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
  readonly sawRecognizedEvent: boolean
  readonly sawAssistantText: boolean
  readonly sawSuccessTerminal: boolean
  readonly sawCursorAuthInit: boolean
}

function validateProtocolSettlement(provider: CliInvocation['provider'], state: ProtocolSettlement): Error | undefined {
  if (provider === 'cursor' && !state.sawCursorAuthInit) {
    return new CliSubscriptionAuthError('cursor', 'MISSING_AUTH_EVENT')
  }
  if (!state.sawValidJson) return new CliProtocolError(provider, 'NO_JSON_EVENTS')
  if (!state.sawRecognizedEvent) return new CliProtocolError(provider, 'UNRECOGNIZED_EVENTS')
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
    UNRECOGNIZED_EVENTS: 'emitted no recognized protocol events',
    NO_ASSISTANT_TEXT: 'closed without assistant text',
    MISSING_SUCCESS_TERMINAL: 'closed without a successful terminal event',
    INVALID_TERMINAL: 'emitted an unrecognized terminal result',
    REPORTED_FAILURE: 'reported a failed model turn',
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
