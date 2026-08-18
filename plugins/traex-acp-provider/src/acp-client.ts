import { spawn as nodeSpawn } from 'node:child_process'
import { isUtf8 } from 'node:buffer'
import { isAbsolute } from 'node:path'
import { Readable, Transform, Writable } from 'node:stream'
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type Agent,
  type AnyMessage,
  type Client,
  type PromptResponse,
  type SessionConfigOption,
  type SessionNotification,
  type StopReason,
  type Stream,
} from '@agentclientprotocol/sdk'
import {
  zAuthMethodAgent,
  zCloseSessionResponse,
  zInitializeResponse,
  zNewSessionResponse,
  zPromptResponse,
  zRequestPermissionRequest,
  zRequestPermissionResponse,
  zSessionNotification,
  zSessionConfigOption,
  zSetSessionConfigOptionResponse,
} from '@agentclientprotocol/sdk/dist/schema/zod.gen.js'
import { version } from './version.js'

export interface TraexAcpInvocation {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly prompt: string
  readonly model?: string
  readonly reasoningEffort?: string
  /** Internal transport mode used by the prompt-free catalog discovery wrapper. */
  readonly operation?: 'prompt' | 'catalog'
}

export interface TraexAcpCatalogInvocation {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
}

export interface SpawnedProcess {
  readonly pid?: number
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  readonly exitCode?: number | null
  readonly signalCode?: NodeJS.Signals | null
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: 'spawn', listener: () => void): this
  once(event: 'error', listener: (error: Error) => void): this
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
}

export interface SpawnOptions {
  readonly cwd: string
  readonly shell: false
  readonly detached: boolean
  readonly stdio: readonly ['pipe', 'pipe', 'pipe']
  readonly env: NodeJS.ProcessEnv
}

export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnedProcess

export interface RunTraexAcpOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly killGraceMs?: number
  /** Maximum size of one raw ACP NDJSON message before parsing. */
  readonly maxMessageBytes?: number
  /** Maximum cumulative bytes accepted from ACP stdout. */
  readonly maxProtocolBytes?: number
  /** Maximum number of ACP stdout messages accepted per invocation. */
  readonly maxProtocolMessages?: number
  /** Maximum cumulative bytes emitted from agent_message_chunk text. */
  readonly maxOutputBytes?: number
  /** Maximum bytes retained and reported from child stderr. */
  readonly maxStderrBytes?: number
  /** Names only. Values are copied from process.env after secret-name filtering. */
  readonly extraEnvNames?: readonly string[]
  /** Receives the validated ACP terminal reason exactly once on success. */
  readonly onStopReason?: (reason: TraexSuccessfulStopReason) => void
  readonly onDiagnostic?: (diagnostic: string) => void
  /** Receives credential-free lifecycle facts exactly once at settlement (success or failure); never affects settlement. */
  readonly onSettled?: (context: ProviderFailureContext) => void
  /** Receives a non-authoritative model catalog observation from a normal handshake. */
  readonly onCatalogObserved?: (observation: CatalogObservation) => void
  /** Adapter-measured login-probe duration, forwarded so settled metrics stay in one place. */
  readonly authProbeDurationMs?: number
  readonly spawn?: SpawnProcess
}

/** Whether the prompt was handed to the ACP stream; the only safe basis for reasoning about replay. */
export type PromptSubmissionState = 'not-submitted' | 'submitted' | 'unknown'

/** Progress of the bounded teardown attempt; `failed` means child close was not proven. */
export type TeardownState = 'not-started' | 'in-progress' | 'completed' | 'failed' | 'unknown'

/** Lifecycle phase a failure was observed in, from handshake through teardown. */
export type TraexLifecyclePhase =
  | 'initialize'
  | 'new-session'
  | 'model-catalog'
  | 'set-model'
  | 'set-reasoning'
  | 'prompt'
  | 'stream'
  | 'terminal'
  | 'close-session'
  | 'child-close'

/**
 * Credential-free lifecycle facts for one ACP invocation. Diagnostic side-channel only:
 * it never carries prompt text, stderr, credentials, model ids or tool/plan content, and never
 * changes settlement. It may carry aggregate numeric usage counts from a validated ACP response.
 */
export interface ProviderFailureContext {
  readonly phase: TraexLifecyclePhase
  readonly promptSubmissionState: PromptSubmissionState
  readonly assistantTextObserved: boolean
  readonly teardownState: TeardownState
  readonly terminalReason?: string
  readonly exitCode?: number | null
  readonly signal?: NodeJS.Signals | null
  /** Explicit-clock-origin latency metrics; only measurable ones are present. */
  readonly metrics?: TraexLifecycleMetrics
  /** Raw ACP token counts kept for internal diagnostics; never mapped to DSH TokenUsage. */
  readonly usage?: AcpUsageSnapshot
}

/** Latency metrics with named clock origins so they stay comparable across providers. */
export interface TraexLifecycleMetrics {
  /** Local login-status probe duration. */
  readonly authProbeDurationMs?: number
  /** Child `spawn` event to the first accepted ACP protocol message. */
  readonly spawnToFirstProtocolMessageMs?: number
  /** Prompt submission to the first assistant text chunk. */
  readonly promptToFirstTextMs?: number
  /** Prompt submission to the validated terminal stop reason. */
  readonly promptToTerminalMs?: number
  /** Bounded teardown attempt start to completion or timeout settlement. */
  readonly teardownDurationMs?: number
}

/**
 * Internal snapshot of ACP's experimental `PromptResponse.usage`. Field names mirror the ACP
 * wire shape (cumulative "across all turns") and are NOT the DSH `TokenUsage` per-call,
 * uncached-input contract, so this is never emitted as a DSH usage chunk without semantic verification.
 */
export interface AcpUsageSnapshot {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cachedReadTokens?: number
  readonly cachedWriteTokens?: number
  readonly thoughtTokens?: number
}

/**
 * The explicit, unmet preconditions that must ALL be proven true before an `AcpUsageSnapshot` may be
 * mapped to a DSH `TokenUsage` and emitted as a usage chunk. This is a verification gate, not a
 * to-do list: until each item is confirmed against a real TraeX fixture or an official field
 * contract, the snapshot stays an internal diagnostic and no usage chunk is emitted.
 *
 * Grounding (DSH contract, `@deepseek-ai/dsh-llm` `types.d.ts`):
 *   - `inputTokens`/`outputTokens` are REQUIRED numbers and must be per-call, not cumulative.
 *   - `inputTokens` must be UNCACHED input only; cache is reported separately.
 *   - a real zero must be preserved; only genuinely-absent optionals stay undefined.
 */
export const ACP_USAGE_DSH_MAPPING_GATE: readonly string[] = Object.freeze([
  // ACP usage is documented as cumulative "across all turns"; DSH TokenUsage is per-call. A single
  // fresh session/one-turn invocation may make these coincide, but that must be proven, not assumed.
  'per-call-vs-cumulative: prove the snapshot reflects THIS call, not a running total across turns',
  // DSH inputTokens excludes cached input; ACP inputTokens may fold cache in. If it does, the cached
  // portion must be subtracted out, which requires knowing ACP's exact accounting.
  'uncached-input: prove ACP inputTokens excludes cache, or derive uncached input exactly',
  // The cache split must line up field-for-field with DSH cacheReadTokens/cacheWriteTokens.
  'cache-fields: prove cachedReadTokens/cachedWriteTokens match DSH cache-read/-write semantics',
  // reasoningTokens has no confirmed ACP source; thoughtTokens is not proven equivalent.
  'reasoning-mapping: prove (or decline) thoughtTokens -> DSH reasoningTokens equivalence',
])

/**
 * Non-authoritative snapshot of a model selector seen during a normal handshake. It exists
 * for diagnostics/display only: it never gates a request, never feeds `resolveModel()`, and
 * the catalog returned by the current `session/new` remains the sole execution authority.
 */
export interface CatalogObservation {
  readonly currentValue: string
  readonly modelValues: readonly string[]
  readonly models: readonly CatalogModel[]
  /** True only when discovery inspected each model's post-selection reasoning selector. */
  readonly completeReasoning: boolean
  readonly observedAt: number
}

export interface CatalogReasoningEffort {
  readonly id: string
  readonly name: string
  readonly description?: string
}

export interface CatalogModelReasoning {
  readonly efforts: readonly CatalogReasoningEffort[]
  readonly defaultEffort?: string
}

export interface CatalogModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly reasoning?: CatalogModelReasoning
}

export type TraexAcpFailure =
  | 'abort'
  | 'timeout'
  | 'protocol'
  | 'auth'
  | 'entitlement'
  | 'model'
  | 'reasoning'
  | 'refusal'
  | 'process'
  | 'output-limit'

export type TraexSuccessfulStopReason = Extract<StopReason, 'end_turn' | 'max_tokens' | 'max_turn_requests'>

/** Stable, credential-free failure surfaced by the TraeX ACP transport. */
export class TraexAcpError extends Error {
  readonly code = 'TRAEX_ACP_ERROR'

  constructor(
    readonly failure: TraexAcpFailure,
    message = failureMessage(failure),
    /** Original OS error code only; the untrusted process error text is never exposed. */
    readonly systemCode?: string,
  ) {
    super(message, { cause: failure })
    this.name = 'TraexAcpError'
  }
}

const SAFE_ARGS = [
  '--sandbox',
  'read-only',
  '--ask-for-approval',
  'never',
  'acp',
  'serve',
] as const

const defaults = {
  timeoutMs: 10 * 60_000,
  killGraceMs: 3_000,
  maxMessageBytes: 256 * 1024,
  maxProtocolBytes: 16 * 1024 * 1024,
  maxProtocolMessages: 10_000,
  maxOutputBytes: 512 * 1024,
  maxStderrBytes: 32 * 1024,
} as const

interface ValidatedLimits {
  readonly timeoutMs: number
  readonly killGraceMs: number
  readonly maxMessageBytes: number
  readonly maxProtocolBytes: number
  readonly maxProtocolMessages: number
  readonly maxOutputBytes: number
  readonly maxStderrBytes: number
}

const inheritedEnvNames = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'USERPROFILE',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'DBUS_SESSION_BUS_ADDRESS',
  'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE',
])

const secretEnvName = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH|AUTHORIZATION|BEARER|COOKIE|PRIVATE_KEY|ACCESS_KEY_ID|GITHUB_PAT|DATABASE_URL|DB_URL|CONNECTION_STRING|DSN)(?:_|$)/i
const providerEndpointEnvName = /^(?:OPENAI|CODEX|AZURE_OPENAI|ANTHROPIC|XAI)_(?:BASE_URL|API_BASE|API_BASE_URL|ENDPOINT)$/i
const proxyEnvName = /^(?:HTTP|HTTPS|ALL)_PROXY$/i
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/

const defaultSpawn: SpawnProcess = (command, args, options) => nodeSpawn(command, [...args], {
  ...options,
  stdio: [...options.stdio],
}) as SpawnedProcess

/**
 * Runs a single TraeX ACP prompt and yields only text explicitly reported as
 * `agent_message_chunk` for the newly-created session. The transport exposes no
 * filesystem or terminal capability, rejects every permission request, never
 * invokes a shell, and never performs an interactive authentication flow.
 */
export async function* runTraexAcpText(
  invocation: TraexAcpInvocation,
  options: RunTraexAcpOptions = {},
): AsyncIterable<string> {
  // Pre-spawn failures never handed the prompt to the ACP stream: report not-submitted and stop.
  const reportPreSpawn = (failedPhase: TraexLifecyclePhase): void => {
    if (options.onSettled === undefined) return
    try {
      options.onSettled({ phase: failedPhase, promptSubmissionState: 'not-submitted', assistantTextObserved: false, teardownState: 'not-started' })
    } catch {
      // A diagnostic sink must never change model-call settlement.
    }
  }
  let limits: ValidatedLimits
  try {
    limits = validate(invocation, options)
  } catch (error) {
    reportPreSpawn('initialize')
    throw error
  }
  if (options.signal?.aborted) {
    reportPreSpawn('initialize')
    throw new TraexAcpError('abort')
  }

  let child: SpawnedProcess
  try {
    child = (options.spawn ?? defaultSpawn)(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildTraexEnv(options.extraEnvNames),
    })
  } catch (error) {
    reportPreSpawn('initialize')
    throw processFailure(error)
  }

  const queue = new TextQueue()
  const rpcGuard = new AcpJsonRpcGuard()
  let client: ClientSideConnection | undefined
  let sessionId: string | undefined
  let outputBytes = 0
  let sawAssistantText = false
  let promptActive = false
  let turnFinished = false
  let operationFinished = false
  let terminating = false
  let fatal: TraexAcpError | undefined
  let closeResult: { code: number | null; signal: NodeJS.Signals | null } | undefined
  let resolveClosed: (() => void) | undefined
  let shutdownPromise: Promise<void> | undefined
  const childClosed = new Promise<void>(resolve => { resolveClosed = resolve })
  const stderr = new BoundedBytes(limits.maxStderrBytes)
  // Lifecycle facts reported through the optional diagnostic seam; never affect settlement.
  let phase: TraexLifecyclePhase = 'initialize'
  let promptSubmissionState: PromptSubmissionState = 'not-submitted'
  let teardownState: TeardownState = 'not-started'
  let terminalReason: string | undefined
  let reportedContext = false
  let usageSnapshot: AcpUsageSnapshot | undefined
  const failureRaised = Promise.withResolvers<TraexAcpError>()
  // Monotonic clock anchors (ms); each metric is only reported when both its ends are known.
  let childSpawnedAt: number | undefined
  let firstProtocolMessageAt: number | undefined
  let promptAt: number | undefined
  let firstTextAt: number | undefined
  let terminalAt: number | undefined
  let teardownStartedAt: number | undefined
  let teardownSettledAt: number | undefined

  const buildMetrics = (): TraexLifecycleMetrics | undefined => {
    const metrics: Record<string, number> = {}
    if (options.authProbeDurationMs !== undefined) metrics.authProbeDurationMs = options.authProbeDurationMs
    if (childSpawnedAt !== undefined && firstProtocolMessageAt !== undefined) {
      metrics.spawnToFirstProtocolMessageMs = firstProtocolMessageAt - childSpawnedAt
    }
    if (promptAt !== undefined && firstTextAt !== undefined) metrics.promptToFirstTextMs = firstTextAt - promptAt
    if (promptAt !== undefined && terminalAt !== undefined) metrics.promptToTerminalMs = terminalAt - promptAt
    if (teardownStartedAt !== undefined && teardownSettledAt !== undefined) {
      metrics.teardownDurationMs = teardownSettledAt - teardownStartedAt
    }
    return Object.keys(metrics).length > 0 ? metrics : undefined
  }

  const reportSettled = (): void => {
    if (options.onSettled === undefined || reportedContext) return
    reportedContext = true
    const metrics = buildMetrics()
    const context: ProviderFailureContext = {
      phase,
      promptSubmissionState,
      assistantTextObserved: sawAssistantText,
      teardownState,
      ...(terminalReason !== undefined ? { terminalReason } : {}),
      ...(closeResult !== undefined ? { exitCode: closeResult.code, signal: closeResult.signal } : {}),
      ...(metrics !== undefined ? { metrics } : {}),
      ...(usageSnapshot !== undefined ? { usage: usageSnapshot } : {}),
    }
    try {
      options.onSettled(context)
    } catch {
      // A diagnostic sink must never change model-call settlement.
    }
  }

  const observeCatalog = (observation: CatalogObservation): void => {
    if (options.onCatalogObserved === undefined) return
    try {
      options.onCatalogObserved(observation)
    } catch {
      // A non-authoritative observation must never change model-call settlement.
    }
  }

  const recordFailure = (error: TraexAcpError): void => {
    if (fatal !== undefined) return
    fatal = error
    failureRaised.resolve(error)
  }

  const awaitRpc = async <T>(rpc: Promise<T>): Promise<T> => {
    const result = await Promise.race([
      rpc.then(value => ({ kind: 'value' as const, value })),
      failureRaised.promise.then(error => ({ kind: 'failure' as const, error })),
    ])
    if (result.kind === 'failure') throw result.error
    return result.value
  }

  const signalChild = (signal: NodeJS.Signals): void => {
    if (closeResult !== undefined) return
    if (process.platform !== 'win32' && child.pid !== undefined && child.pid > 0) {
      try {
        process.kill(-child.pid, signal)
        return
      } catch {
        // The detached process group may already be gone; try the direct child.
      }
    }
    try {
      child.kill(signal)
    } catch {
      // Teardown is best-effort; settlement still waits for ChildProcess `close`.
    }
  }

  const waitForChildClose = (timeoutMs: number): Promise<boolean> => {
    if (closeResult !== undefined) return Promise.resolve(true)
    return new Promise(resolve => {
      let settled = false
      const finish = (closed: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(closed)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      timer.unref?.()
      void childClosed.then(() => finish(true))
    })
  }

  const shutdown = (cancelSession: boolean): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise
    terminating = true
    teardownState = 'in-progress'
    teardownStartedAt ??= performance.now()
    shutdownPromise = (async () => {
      if (cancelSession && sessionId !== undefined && client !== undefined && !client.signal.aborted) {
        let cancelTimer: ReturnType<typeof setTimeout> | undefined
        try {
          // Start the cooperative notification first, but never let a blocked
          // stdin pipe prevent the authoritative process signals.
          const sent = client.cancel({ sessionId }).catch(() => undefined)
          await Promise.race([
            sent,
            new Promise<void>(resolve => {
              cancelTimer = setTimeout(resolve, Math.min(100, limits.killGraceMs))
            }),
          ])
        } catch {
          // A closing connection cannot receive cancellation; process signals remain authoritative.
        } finally {
          if (cancelTimer !== undefined) clearTimeout(cancelTimer)
        }
      }
      if (closeResult === undefined) {
        signalChild('SIGINT')
        if (!await waitForChildClose(limits.killGraceMs)) {
          signalChild('SIGKILL')
          if (!await waitForChildClose(limits.killGraceMs)) {
            // The request must still settle even if a broken process implementation never emits
            // `close`. Keep the listeners/streams attached so a late close is drained and tracked,
            // but do not report a second settlement.
            teardownState = 'failed'
            teardownSettledAt ??= performance.now()
            recordFailure(new TraexAcpError('process'))
            return
          }
        }
      }
      teardownState = 'completed'
      teardownSettledAt ??= performance.now()
    })()
    return shutdownPromise
  }

  const stop = (error: TraexAcpError): void => {
    recordFailure(error)
    void shutdown(true)
  }

  child.once('error', error => stop(processFailure(error)))
  child.once('spawn', () => { childSpawnedAt ??= performance.now() })
  child.once('close', (code, signal) => {
    closeResult = { code, signal }
    resolveClosed?.()
    if (!terminating) {
      if (code !== 0 || signal !== null) recordFailure(new TraexAcpError('process'))
      else if (!turnFinished) recordFailure(new TraexAcpError('protocol'))
    }
  })

  child.stderr.on('data', (chunk: Buffer | string) => stderr.append(chunk))
  child.stderr.on('error', () => stop(new TraexAcpError('process')))
  child.stdin.on('error', () => stop(new TraexAcpError('process')))

  const guardedStdout = new BoundedNdjsonTransform(
    limits.maxMessageBytes,
    limits.maxProtocolBytes,
    limits.maxProtocolMessages,
    rpcGuard,
    () => { firstProtocolMessageAt ??= performance.now() },
  )
  guardedStdout.once('error', (error: Error) => {
    stop(error instanceof TraexAcpError ? error : new TraexAcpError('protocol'))
  })
  child.stdout.on('error', () => stop(new TraexAcpError('process')))
  child.stdout.pipe(guardedStdout)

  const rawStream = ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(guardedStdout),
  )
  const stream = guardOutgoingStream(rawStream, rpcGuard)
  const makeClient = (_agent: Agent): Client => ({
    sessionUpdate(notification: SessionNotification): Promise<void> {
      const update = notification.update
      if (fatal !== undefined) return Promise.resolve()
      if (sessionId === undefined) {
        stop(new TraexAcpError('protocol'))
        return Promise.resolve()
      }
      if (notification.sessionId !== sessionId) {
        stop(new TraexAcpError('protocol'))
        return Promise.resolve()
      }
      if (update.sessionUpdate !== 'agent_message_chunk' || update.content.type !== 'text') {
        return Promise.resolve()
      }
      if (!promptActive || turnFinished) {
        stop(new TraexAcpError('protocol'))
        return Promise.resolve()
      }
      const text = update.content.text
      if (text.length === 0) return Promise.resolve()
      const nextBytes = outputBytes + Buffer.byteLength(text, 'utf8')
      if (nextBytes > limits.maxOutputBytes) {
        stop(new TraexAcpError('output-limit'))
        return Promise.resolve()
      }
      outputBytes = nextBytes
      sawAssistantText = true
      firstTextAt ??= performance.now()
      if (phase === 'prompt') phase = 'stream'
      queue.push(text)
      return Promise.resolve()
    },
    requestPermission(): Promise<{ outcome: { outcome: 'cancelled' } }> {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    },
  })
  client = new ClientSideConnection(makeClient, stream)

  const onAbort = (): void => stop(new TraexAcpError('abort'))
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) onAbort()
  const timeout = setTimeout(() => stop(new TraexAcpError('timeout')), limits.timeoutMs)
  timeout.unref?.()

  const operation = (async (): Promise<void> => {
    try {
      phase = 'initialize'
      const initialized = await awaitRpc(client.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: {
          name: 'dsh-enhanced-traex-acp-provider',
          title: 'DSH TraeX ACP Provider',
          version,
        },
      }))
      throwIfFatal(fatal)
      if (initialized.protocolVersion !== PROTOCOL_VERSION || initialized.agentInfo?.name !== 'traex-acp') {
        throw new TraexAcpError('protocol')
      }
      if (!initialized.authMethods?.some(isTraeSsoAuthMethod)) {
        throw new TraexAcpError('auth')
      }

      phase = 'new-session'
      const session = await awaitRpc(client.newSession({ cwd: invocation.cwd, mcpServers: [] }))
      sessionId = session.sessionId
      if (sessionId.length === 0) throw new TraexAcpError('protocol')
      throwIfFatal(fatal)

      phase = 'model-catalog'
      const initialModelOption = validateModelCatalog(session.configOptions)
      let activeModelOption = initialModelOption
      let activeConfigOptions = session.configOptions
      const initialReasoning = validateReasoningCatalog(activeConfigOptions)
      observeCatalog(buildCatalogObservation(
        initialModelOption,
        initialReasoning === undefined
          ? new Map()
          : new Map([[initialModelOption.currentValue, catalogReasoning(initialReasoning)]]),
        false,
      ))

      if (invocation.operation === 'catalog') {
        const reasoningByModel = new Map<string, CatalogModelReasoning>()
        const initialCurrentValue = initialModelOption.currentValue
        for (const entry of selectEntries(initialModelOption)) {
          if (activeModelOption.currentValue !== entry.value) {
            const updated = await awaitRpc(client.setSessionConfigOption({
              sessionId,
              configId: initialModelOption.id,
              value: entry.value,
            }))
            activeModelOption = validateModelCatalog(updated.configOptions)
            activeConfigOptions = updated.configOptions
            if (activeModelOption.id !== initialModelOption.id || activeModelOption.currentValue !== entry.value) {
              throw new TraexAcpError('protocol')
            }
            throwIfFatal(fatal)
          }
          const reasoning = validateReasoningCatalog(activeConfigOptions)
          if (reasoning !== undefined) reasoningByModel.set(entry.value, catalogReasoning(reasoning))
        }
        observeCatalog(buildCatalogObservation(
          initialModelOption,
          reasoningByModel,
          true,
          initialCurrentValue,
        ))
        // Catalog discovery is a successful no-prompt operation. Mark the session complete so a
        // clean child close cannot be mistaken for premature EOF.
        turnFinished = true
        if (initialized.agentCapabilities?.sessionCapabilities?.close !== undefined
          && initialized.agentCapabilities.sessionCapabilities.close !== null) {
          phase = 'close-session'
          await awaitRpc(client.closeSession({ sessionId }))
          throwIfFatal(fatal)
        }
        phase = 'child-close'
        await shutdown(false)
        throwIfFatal(fatal)
        return
      }

      if (invocation.model !== undefined) {
        if (!selectValues(initialModelOption).includes(invocation.model)) throw new TraexAcpError('model')
        phase = 'set-model'
        const updated = await awaitRpc(client.setSessionConfigOption({
          sessionId,
          configId: initialModelOption.id,
          value: invocation.model,
        }))
        activeModelOption = validateModelCatalog(updated.configOptions)
        activeConfigOptions = updated.configOptions
        if (activeModelOption.id !== initialModelOption.id || activeModelOption.currentValue !== invocation.model) {
          throw new TraexAcpError('protocol')
        }
        throwIfFatal(fatal)
      }

      if (invocation.reasoningEffort !== undefined) {
        const reasoningOption = validateReasoningCatalog(activeConfigOptions)
        if (reasoningOption === undefined || !selectValues(reasoningOption).includes(invocation.reasoningEffort)) {
          throw new TraexAcpError('reasoning')
        }
        phase = 'set-reasoning'
        const updated = await awaitRpc(client.setSessionConfigOption({
          sessionId,
          configId: reasoningOption.id,
          value: invocation.reasoningEffort,
        }))
        activeModelOption = validateModelCatalog(updated.configOptions)
        activeConfigOptions = updated.configOptions
        const selectedReasoning = validateReasoningCatalog(activeConfigOptions)
        if (activeModelOption.currentValue !== (invocation.model ?? initialModelOption.currentValue)
          || selectedReasoning?.id !== reasoningOption.id
          || selectedReasoning.currentValue !== invocation.reasoningEffort) {
          throw new TraexAcpError('protocol')
        }
        throwIfFatal(fatal)
      }

      const activeReasoning = validateReasoningCatalog(activeConfigOptions)
      observeCatalog(buildCatalogObservation(
        activeModelOption,
        activeReasoning === undefined
          ? new Map()
          : new Map([[activeModelOption.currentValue, catalogReasoning(activeReasoning)]]),
        false,
      ))

      // The prompt is about to enter the ACP stream; from here replay is never safe.
      phase = 'prompt'
      promptSubmissionState = 'submitted'
      promptActive = true
      promptAt = performance.now()
      const result = await awaitRpc(client.prompt({
        sessionId,
        prompt: [{ type: 'text', text: invocation.prompt }],
      }))
      promptActive = false
      throwIfFatal(fatal)
      // The response itself is the terminal protocol event even when its reason represents a
      // failed turn, or when later semantic checks (such as required text) fail.
      phase = 'terminal'
      terminalAt = performance.now()
      terminalReason = result.stopReason
      usageSnapshot = snapshotUsage(result.usage)
      if (result.stopReason === 'refusal') throw new TraexAcpError('refusal')
      if (result.stopReason === 'cancelled') throw new TraexAcpError('abort')
      if (!['end_turn', 'max_tokens', 'max_turn_requests'].includes(result.stopReason)) {
        throw new TraexAcpError('protocol')
      }
      if (!sawAssistantText) throw new TraexAcpError('protocol')
      const stopReason = result.stopReason as TraexSuccessfulStopReason
      // Mark a validated completed turn before invoking an observer. A clean child close racing
      // between terminal handling / closeSession and shutdown is no longer a premature EOF.
      turnFinished = true
      try {
        options.onStopReason?.(stopReason)
      } catch {
        throw new TraexAcpError('protocol')
      }
      // Success still waits for bounded teardown; a close-session failure must not settle as success.
      if (initialized.agentCapabilities?.sessionCapabilities?.close !== undefined
        && initialized.agentCapabilities.sessionCapabilities.close !== null) {
        phase = 'close-session'
        await awaitRpc(client.closeSession({ sessionId }))
        throwIfFatal(fatal)
      }
      phase = 'child-close'
      await shutdown(false)
      throwIfFatal(fatal)
    } catch (error) {
      const normalized = fatal ?? normalizeFailure(error)
      recordFailure(normalized)
      // Teardown still runs to reap the child; `phase` records if close-session was where it failed.
      await shutdown(true)
      throw normalized
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', onAbort)
      const diagnostic = stderr.text()
      if (diagnostic.length > 0) {
        try {
          options.onDiagnostic?.(diagnostic)
        } catch {
          // Diagnostic consumers must not affect transport settlement.
        }
      }
      reportSettled()
      operationFinished = true
    }
  })()

  void operation.then(
    () => queue.close(),
    error => queue.close(normalizeFailure(error)),
  )

  try {
    for await (const text of queue) yield text
  } finally {
    if (!operationFinished && fatal === undefined) stop(new TraexAcpError('abort'))
    await operation.catch(() => undefined)
  }
}

/**
 * Perform a strict ACP initialize + session/new discovery without ever submitting a prompt.
 * Every advertised model is selected inside the disposable session so model-specific reasoning
 * efforts are captured exactly as TraeX exposes them.
 */
export async function discoverTraexAcpModels(
  invocation: TraexAcpCatalogInvocation,
  options: RunTraexAcpOptions = {},
): Promise<CatalogObservation> {
  let observation: CatalogObservation | undefined
  const callerObserver = options.onCatalogObserved
  for await (const text of runTraexAcpText({
    ...invocation,
    prompt: '',
    operation: 'catalog',
  }, {
    ...options,
    onCatalogObserved(value) {
      observation = value
      callerObserver?.(value)
    },
  })) {
    // A catalog-only operation must never produce assistant text.
    if (text.length > 0) throw new TraexAcpError('protocol')
  }
  if (observation === undefined || !observation.completeReasoning) throw new TraexAcpError('protocol')
  return observation
}

/** Environment allowlist for the local Trae tool-account executable. */
export function buildTraexEnv(extraEnvNames: readonly string[] = []): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const name of new Set([...inheritedEnvNames, ...extraEnvNames])) {
    if (!envName.test(name) || secretEnvName.test(name) || providerEndpointEnvName.test(name)) continue
    const value = process.env[name]
    if (value === undefined) continue
    const sanitized = sanitizeEnvValue(name, value)
    if (sanitized !== undefined) result[name] = sanitized
  }
  return result
}

function sanitizeEnvValue(name: string, value: string): string | undefined {
  if (!proxyEnvName.test(name)) return value
  if (!/^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(value)) return value.includes('@') ? undefined : value
  try {
    const proxy = new URL(value)
    if (proxy.username.length === 0 && proxy.password.length === 0) return value
    proxy.username = ''
    proxy.password = ''
    return proxy.toString()
  } catch {
    return value.includes('@') ? undefined : value
  }
}

function validate(
  invocation: TraexAcpInvocation,
  options: RunTraexAcpOptions,
): ValidatedLimits {
  if (invocation.command.trim().length === 0 || !isAbsolute(invocation.cwd)) {
    throw new TraexAcpError('protocol')
  }
  if (invocation.args.length !== SAFE_ARGS.length
    || invocation.args.some((value, index) => value !== SAFE_ARGS[index])) {
    throw new TraexAcpError('protocol')
  }
  if (invocation.operation === 'catalog'
    && (invocation.prompt.length !== 0 || invocation.model !== undefined || invocation.reasoningEffort !== undefined)) {
    throw new TraexAcpError('protocol')
  }
  if (invocation.model !== undefined && invocation.model.length === 0) {
    throw new TraexAcpError('protocol')
  }
  if (invocation.reasoningEffort !== undefined && invocation.reasoningEffort.length === 0) {
    throw new TraexAcpError('protocol')
  }
  return {
    timeoutMs: positiveInteger(options.timeoutMs, defaults.timeoutMs),
    killGraceMs: positiveInteger(options.killGraceMs, defaults.killGraceMs),
    maxMessageBytes: positiveInteger(options.maxMessageBytes, defaults.maxMessageBytes),
    maxProtocolBytes: positiveInteger(options.maxProtocolBytes, defaults.maxProtocolBytes),
    maxProtocolMessages: positiveInteger(options.maxProtocolMessages, defaults.maxProtocolMessages),
    maxOutputBytes: positiveInteger(options.maxOutputBytes, defaults.maxOutputBytes),
    maxStderrBytes: positiveInteger(options.maxStderrBytes, defaults.maxStderrBytes),
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) throw new TraexAcpError('protocol')
  return value
}

function validateModelCatalog(
  options: readonly SessionConfigOption[] | null | undefined,
): Extract<SessionConfigOption, { type: 'select' }> {
  const matches = (options ?? []).filter((option): option is Extract<SessionConfigOption, { type: 'select' }> => (
    option.type === 'select' && (option.category === 'model' || option.id === 'model')
  ))
  if (matches.length !== 1) throw new TraexAcpError('protocol')
  const option = matches[0]!
  const entries = selectEntries(option)
  const values = entries.map(entry => entry.value)
  if (option.currentValue.length === 0 || entries.length === 0) throw new TraexAcpError('entitlement')
  if (!values.includes(option.currentValue) || new Set(values).size !== values.length
    || entries.some(entry => entry.value.length === 0 || entry.name.length === 0)) {
    throw new TraexAcpError('protocol')
  }
  return option
}

function validateReasoningCatalog(
  options: readonly SessionConfigOption[] | null | undefined,
): Extract<SessionConfigOption, { type: 'select' }> | undefined {
  const matches = (options ?? []).filter((option): option is Extract<SessionConfigOption, { type: 'select' }> => (
    option.type === 'select' && (option.category === 'thought_level' || option.id === 'reasoning_effort')
  ))
  if (matches.length === 0) return undefined
  if (matches.length !== 1) throw new TraexAcpError('protocol')
  const option = matches[0]!
  const entries = selectEntries(option)
  const values = entries.map(entry => entry.value)
  if (option.currentValue.length === 0 || entries.length === 0
    || !values.includes(option.currentValue) || new Set(values).size !== values.length
    || entries.some(entry => entry.value.length === 0 || entry.name.length === 0)) {
    throw new TraexAcpError('protocol')
  }
  return option
}

function catalogReasoning(
  option: Extract<SessionConfigOption, { type: 'select' }>,
): CatalogModelReasoning {
  return {
    efforts: selectEntries(option).map(entry => ({
      id: entry.value,
      name: entry.name,
      ...(typeof entry.description === 'string' && entry.description.length > 0
        ? { description: entry.description }
        : {}),
    })),
    defaultEffort: option.currentValue,
  }
}

function buildCatalogObservation(
  modelOption: Extract<SessionConfigOption, { type: 'select' }>,
  reasoningByModel: ReadonlyMap<string, CatalogModelReasoning>,
  completeReasoning: boolean,
  currentValue = modelOption.currentValue,
): CatalogObservation {
  return {
    currentValue,
    modelValues: selectValues(modelOption),
    models: selectEntries(modelOption).map(entry => ({
      id: entry.value,
      name: entry.name,
      ...(typeof entry.description === 'string' && entry.description.length > 0
        ? { description: entry.description }
        : {}),
      ...(reasoningByModel.has(entry.value) ? { reasoning: reasoningByModel.get(entry.value)! } : {}),
    })),
    completeReasoning,
    observedAt: Date.now(),
  }
}

function selectValues(option: Extract<SessionConfigOption, { type: 'select' }>): string[] {
  return selectEntries(option).map(entry => entry.value)
}

/**
 * Extract only the explicit numeric fields of ACP's experimental usage into an internal snapshot.
 * `_meta` and any unknown keys are dropped; optional counts stay undefined when absent, and a real
 * zero is preserved. This is a diagnostic record, never a DSH `TokenUsage` mapping.
 */
function snapshotUsage(usage: PromptResponse['usage']): AcpUsageSnapshot | undefined {
  if (usage === undefined || usage === null) return undefined
  if (!validTokenCount(usage.inputTokens)
    || !validTokenCount(usage.outputTokens)
    || !validTokenCount(usage.totalTokens)
    || !validOptionalTokenCount(usage.cachedReadTokens)
    || !validOptionalTokenCount(usage.cachedWriteTokens)
    || !validOptionalTokenCount(usage.thoughtTokens)) {
    throw new TraexAcpError('protocol')
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(typeof usage.cachedReadTokens === 'number' ? { cachedReadTokens: usage.cachedReadTokens } : {}),
    ...(typeof usage.cachedWriteTokens === 'number' ? { cachedWriteTokens: usage.cachedWriteTokens } : {}),
    ...(typeof usage.thoughtTokens === 'number' ? { thoughtTokens: usage.thoughtTokens } : {}),
  }
}

function validTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validOptionalTokenCount(value: unknown): value is number | null | undefined {
  return value === undefined || value === null || validTokenCount(value)
}

function selectEntries(option: Extract<SessionConfigOption, { type: 'select' }>) {
  return option.options.flatMap(entry => 'group' in entry ? entry.options : [entry])
}

function throwIfFatal(error: TraexAcpError | undefined): void {
  if (error !== undefined) throw error
}

function normalizeFailure(error: unknown): TraexAcpError {
  if (error instanceof TraexAcpError) return error
  if (error instanceof RequestError && error.code === -32000) return new TraexAcpError('auth')
  return new TraexAcpError('protocol')
}

function processFailure(error: unknown): TraexAcpError {
  const systemCode = error !== null && typeof error === 'object' && 'code' in error
    && typeof error.code === 'string' ? error.code : undefined
  return new TraexAcpError('process', undefined, systemCode)
}

function failureMessage(failure: TraexAcpFailure): string {
  const messages: Record<TraexAcpFailure, string> = {
    abort: 'TraeX ACP execution was aborted',
    timeout: 'TraeX ACP execution timed out',
    protocol: 'TraeX ACP protocol validation failed',
    auth: 'TraeX ACP requires an existing non-interactive login',
    entitlement: 'TraeX ACP did not expose an entitled model',
    model: 'TraeX ACP did not expose the requested model',
    reasoning: 'TraeX ACP did not expose the requested reasoning effort',
    refusal: 'TraeX ACP refused the request',
    process: 'TraeX ACP process failed',
    'output-limit': 'TraeX ACP output exceeded its configured limit',
  }
  return messages[failure]
}

type JsonObject = Record<string, unknown>

const clientRequestMethods = new Set([
  'initialize',
  'session/new',
  'session/set_config_option',
  'session/prompt',
  'session/close',
])

class AcpJsonRpcGuard {
  private readonly pendingClientRequests = new Map<string, string>()
  private readonly pendingAgentRequests = new Map<string, string>()

  acceptIncoming(envelope: JsonObject): void {
    if (envelope.jsonrpc !== '2.0') throw new TraexAcpError('protocol')
    const hasMethod = own(envelope, 'method')
    const hasId = own(envelope, 'id')
    const hasResult = own(envelope, 'result')
    const hasError = own(envelope, 'error')

    if (hasMethod) {
      if (typeof envelope.method !== 'string' || envelope.method.length === 0 || hasResult || hasError) {
        throw new TraexAcpError('protocol')
      }
      if (hasId) this.acceptAgentRequest(envelope)
      else this.acceptAgentNotification(envelope)
      return
    }

    if (!hasId || hasResult === hasError || own(envelope, 'params')) throw new TraexAcpError('protocol')
    exactKeys(envelope, hasResult ? ['jsonrpc', 'id', 'result'] : ['jsonrpc', 'id', 'error'])
    const key = rpcIdKey(envelope.id)
    const method = this.pendingClientRequests.get(key)
    if (method === undefined) throw new TraexAcpError('protocol')
    if (hasResult) {
      if (!validClientResponse(method, envelope.result)) throw new TraexAcpError('protocol')
    } else if (!validJsonRpcError(envelope.error)) {
      throw new TraexAcpError('protocol')
    }
    this.pendingClientRequests.delete(key)
  }

  observeOutgoing(message: AnyMessage): void {
    const envelope = jsonObject(message)
    if (envelope === undefined || envelope.jsonrpc !== '2.0') throw new TraexAcpError('protocol')
    const hasMethod = own(envelope, 'method')
    const hasId = own(envelope, 'id')
    const hasResult = own(envelope, 'result')
    const hasError = own(envelope, 'error')

    if (hasMethod) {
      if (typeof envelope.method !== 'string' || hasResult || hasError) throw new TraexAcpError('protocol')
      if (hasId) {
        exactKeys(envelope, own(envelope, 'params')
          ? ['jsonrpc', 'id', 'method', 'params']
          : ['jsonrpc', 'id', 'method'])
        if (!clientRequestMethods.has(envelope.method)) throw new TraexAcpError('protocol')
        const key = rpcIdKey(envelope.id)
        if (this.pendingClientRequests.has(key)) throw new TraexAcpError('protocol')
        this.pendingClientRequests.set(key, envelope.method)
      } else {
        exactKeys(envelope, own(envelope, 'params')
          ? ['jsonrpc', 'method', 'params']
          : ['jsonrpc', 'method'])
        if (envelope.method !== 'session/cancel') throw new TraexAcpError('protocol')
      }
      return
    }

    if (!hasId || hasResult === hasError || own(envelope, 'params')) throw new TraexAcpError('protocol')
    exactKeys(envelope, hasResult ? ['jsonrpc', 'id', 'result'] : ['jsonrpc', 'id', 'error'])
    const key = rpcIdKey(envelope.id)
    const method = this.pendingAgentRequests.get(key)
    if (method !== 'session/request_permission' || hasError
      || !zRequestPermissionResponse.safeParse(envelope.result).success
      || !cancelledPermissionResponse(envelope.result)) {
      throw new TraexAcpError('protocol')
    }
    this.pendingAgentRequests.delete(key)
  }

  private acceptAgentNotification(envelope: JsonObject): void {
    exactKeys(envelope, own(envelope, 'params')
      ? ['jsonrpc', 'method', 'params']
      : ['jsonrpc', 'method'])
    if (envelope.method !== 'session/update'
      || !zSessionNotification.safeParse(envelope.params).success) {
      throw new TraexAcpError('protocol')
    }
  }

  private acceptAgentRequest(envelope: JsonObject): void {
    exactKeys(envelope, own(envelope, 'params')
      ? ['jsonrpc', 'id', 'method', 'params']
      : ['jsonrpc', 'id', 'method'])
    if (envelope.method !== 'session/request_permission'
      || !zRequestPermissionRequest.safeParse(envelope.params).success) {
      throw new TraexAcpError('protocol')
    }
    const key = rpcIdKey(envelope.id)
    if (this.pendingAgentRequests.has(key)) throw new TraexAcpError('protocol')
    this.pendingAgentRequests.set(key, envelope.method)
  }
}

function guardOutgoingStream(stream: Stream, guard: AcpJsonRpcGuard): Stream {
  return {
    readable: stream.readable,
    writable: new WritableStream<AnyMessage>({
      async write(message) {
        guard.observeOutgoing(message)
        const writer = stream.writable.getWriter()
        try {
          await writer.write(message)
        } finally {
          writer.releaseLock()
        }
      },
      async close() {
        const writer = stream.writable.getWriter()
        try {
          await writer.close()
        } finally {
          writer.releaseLock()
        }
      },
      async abort(reason) {
        const writer = stream.writable.getWriter()
        try {
          await writer.abort(reason)
        } finally {
          writer.releaseLock()
        }
      },
    }),
  }
}

function validClientResponse(method: string, result: unknown): boolean {
  if (method === 'initialize') return validInitializeResponse(result)
  if (method === 'session/new') {
    return zNewSessionResponse.safeParse(result).success && validRawConfigOptions(result)
  }
  if (method === 'session/set_config_option') {
    return zSetSessionConfigOptionResponse.safeParse(result).success && validRawConfigOptions(result)
  }
  if (method === 'session/prompt') return validPromptResponse(result)
  if (method === 'session/close') return zCloseSessionResponse.safeParse(result).success
  return false
}

function validPromptResponse(value: unknown): boolean {
  if (!zPromptResponse.safeParse(value).success) return false
  const response = jsonObject(value)
  if (response === undefined || !own(response, 'usage') || response.usage === null || response.usage === undefined) {
    return true
  }
  const usage = jsonObject(response.usage)
  return usage !== undefined
    && validTokenCount(usage.inputTokens)
    && validTokenCount(usage.outputTokens)
    && validTokenCount(usage.totalTokens)
    && validOptionalTokenCount(usage.cachedReadTokens)
    && validOptionalTokenCount(usage.cachedWriteTokens)
    && validOptionalTokenCount(usage.thoughtTokens)
}

/** The SDK's generated initialize schema deliberately skips malformed optional fields. */
function validInitializeResponse(value: unknown): boolean {
  if (!zInitializeResponse.safeParse(value).success) return false
  const response = jsonObject(value)
  if (response === undefined) return false

  if (own(response, 'agentInfo') && response.agentInfo !== null) {
    const info = jsonObject(response.agentInfo)
    if (info === undefined
      || typeof info.name !== 'string' || info.name.length === 0
      || typeof info.version !== 'string' || info.version.length === 0
      || (own(info, 'title') && info.title !== null && typeof info.title !== 'string')) {
      return false
    }
  }

  if (own(response, 'authMethods')) {
    if (!Array.isArray(response.authMethods)) return false
    const traeMethods = response.authMethods.filter(method => jsonObject(method)?.id === 'trae-sso')
    if (traeMethods.length > 1 || (traeMethods.length === 1 && !isTraeSsoAuthMethod(traeMethods[0]))) {
      return false
    }
  }
  return true
}

function isTraeSsoAuthMethod(value: unknown): boolean {
  const method = jsonObject(value)
  return method !== undefined
    && !own(method, 'type')
    && method.id === 'trae-sso'
    && typeof method.name === 'string'
    && method.name.length > 0
    && zAuthMethodAgent.safeParse(value).success
}

function validRawConfigOptions(value: unknown): boolean {
  const response = jsonObject(value)
  if (response === undefined || !own(response, 'configOptions')) return true
  if (response.configOptions === null) return true
  if (!Array.isArray(response.configOptions)) return false
  return response.configOptions.every(option => {
    const candidate = jsonObject(option)
    if (candidate?.id !== 'model' && candidate?.category !== 'model') return true
    return zSessionConfigOption.safeParse(option).success
  })
}

function cancelledPermissionResponse(value: unknown): boolean {
  const response = jsonObject(value)
  const outcome = jsonObject(response?.outcome)
  return outcome?.outcome === 'cancelled'
}

function validJsonRpcError(value: unknown): boolean {
  const error = jsonObject(value)
  if (error === undefined) return false
  const allowed = own(error, 'data') ? ['code', 'message', 'data'] : ['code', 'message']
  try {
    exactKeys(error, allowed)
  } catch {
    return false
  }
  return Number.isSafeInteger(error.code) && typeof error.message === 'string'
}

function parseJsonObject(line: Buffer): JsonObject {
  if (!isUtf8(line)) throw new TraexAcpError('protocol')
  const text = line.toString('utf8').trim()
  if (text.length === 0) throw new TraexAcpError('protocol')
  try {
    const value: unknown = JSON.parse(text)
    const result = jsonObject(value)
    if (result === undefined) throw new TraexAcpError('protocol')
    return result
  } catch (error) {
    if (error instanceof TraexAcpError) throw error
    throw new TraexAcpError('protocol')
  }
}

function jsonObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

function own(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function exactKeys(value: JsonObject, allowed: readonly string[]): void {
  if (Object.keys(value).length !== allowed.length
    || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new TraexAcpError('protocol')
  }
}

function rpcIdKey(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) return `s:${value}`
  if (typeof value === 'number' && Number.isSafeInteger(value)) return `n:${String(value)}`
  throw new TraexAcpError('protocol')
}

class BoundedNdjsonTransform extends Transform {
  private pending = Buffer.alloc(0)
  private protocolBytes = 0
  private protocolMessages = 0

  constructor(
    private readonly maxMessageBytes: number,
    private readonly maxProtocolBytes: number,
    private readonly maxProtocolMessages: number,
    private readonly guard: AcpJsonRpcGuard,
    private readonly onAcceptedMessage?: () => void,
  ) {
    super({ readableHighWaterMark: 64 * 1024, writableHighWaterMark: 64 * 1024 })
  }

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (bytes.byteLength > this.maxProtocolBytes - this.protocolBytes) {
        callback(new TraexAcpError('output-limit'))
        return
      }
      this.protocolBytes += bytes.byteLength
      let start = 0
      for (let index = 0; index < bytes.length; index++) {
        if (bytes[index] !== 0x0a) continue
        const part = bytes.subarray(start, index)
        this.consumeLine(part)
        start = index + 1
      }
      const tail = bytes.subarray(start)
      if (this.pending.byteLength + tail.byteLength > this.maxMessageBytes) {
        callback(new TraexAcpError('output-limit'))
        return
      }
      if (tail.byteLength > 0) this.pending = Buffer.concat([this.pending, tail])
      callback()
    } catch (error) {
      callback(error instanceof Error ? error : new TraexAcpError('protocol'))
    }
  }

  override _flush(callback: (error?: Error | null) => void): void {
    try {
      if (this.pending.byteLength > 0) {
        this.acceptMessage(this.pending)
        this.push(this.pending)
      }
      this.pending = Buffer.alloc(0)
      callback()
    } catch (error) {
      callback(error instanceof Error ? error : new TraexAcpError('protocol'))
    }
  }

  private consumeLine(part: Buffer): void {
    if (this.pending.byteLength + part.byteLength > this.maxMessageBytes) {
      throw new TraexAcpError('output-limit')
    }
    const line = this.pending.byteLength === 0 ? part : Buffer.concat([this.pending, part])
    this.pending = Buffer.alloc(0)
    this.acceptMessage(line)
    this.push(Buffer.concat([line, Buffer.from('\n')]))
  }

  private acceptMessage(line: Buffer): void {
    if (this.protocolMessages >= this.maxProtocolMessages) throw new TraexAcpError('output-limit')
    this.protocolMessages++
    this.guard.acceptIncoming(parseJsonObject(line))
    this.onAcceptedMessage?.()
  }
}

class BoundedBytes {
  private readonly chunks: Buffer[] = []
  private bytes = 0

  constructor(private readonly limit: number) {}

  append(value: Buffer | string): void {
    const next = Buffer.from(value)
    this.chunks.push(next)
    this.bytes += next.byteLength
    let excess = this.bytes - this.limit
    while (excess > 0 && this.chunks.length > 0) {
      const first = this.chunks[0]!
      if (first.byteLength <= excess) {
        this.chunks.shift()
        this.bytes -= first.byteLength
        excess -= first.byteLength
      } else {
        this.chunks[0] = first.subarray(excess)
        this.bytes -= excess
        excess = 0
      }
    }
  }

  text(): string {
    let value = Buffer.concat(this.chunks, this.bytes).toString('utf8')
    while (Buffer.byteLength(value, 'utf8') > this.limit) value = value.slice(0, -1)
    return value
  }
}

class TextQueue implements AsyncIterable<string> {
  private readonly values: string[] = []
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
      if (this.values.length > 0) yield this.values.shift()!
      else if (this.done) {
        if (this.error !== undefined) throw this.error
        return
      } else {
        await new Promise<void>(resolve => { this.waiter = resolve })
      }
    }
  }
}
