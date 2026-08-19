import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import {
  CallId,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  discoverTraexAcpModels,
  runTraexAcpText,
  type CatalogObservation,
  type CatalogModel,
  type ProviderFailureContext,
  type PromptSubmissionState,
  type RunTraexAcpOptions,
  type TraexAcpInvocation,
  type TraexAcpCatalogInvocation,
  type TraexSuccessfulStopReason,
} from './acp-client.js'
import { verifyTraexAuth, type TraexAuthVerifier } from './auth.js'
import { CatalogObservationCache, type CatalogCacheKeyParts, type CachedCatalog } from './catalog-cache.js'
import type { TraexAcpProviderConfig } from './config.js'
import { buildPrompt, parseDelegatedToolCalls } from './prompt.js'

export const TRAEX_PROVIDER_ROUTE = 'traex-agent'

export type TraexAcpTextRunner = (
  invocation: TraexAcpInvocation,
  options?: RunTraexAcpOptions,
) => AsyncIterable<string>

export type TraexAcpCatalogDiscoverer = (
  invocation: TraexAcpCatalogInvocation,
  options?: RunTraexAcpOptions,
) => Promise<CatalogObservation>

/**
 * Full lifecycle facts the adapter can observe: the transport context plus the `auth`/`preflight`
 * phases (which precede the ACP handshake), a stable failure class, and whether text reached DSH.
 * Credential-free and internal; it is never attached to the thrown `LlmError`.
 */
export interface RouteFailureContext extends Partial<Omit<ProviderFailureContext, 'phase'>> {
  readonly phase: ProviderFailureContext['phase'] | 'auth' | 'preflight'
  readonly assistantTextForwarded: boolean
  /** Stable outcome class for diagnostics/health; `ok` on success. */
  readonly outcome: RouteOutcome
}

/** Stable, credential-free outcome classes distinct enough for future health/cooldown routing. */
export type RouteOutcome =
  | 'ok'
  | 'aborted'
  | 'timeout'
  | 'auth-required'
  | 'not-found'
  | 'entitlement'
  | 'model'
  | 'reasoning'
  | 'refusal'
  | 'protocol'
  | 'process'
  | 'output-limit'
  | 'preflight'
  | 'failed'

export interface AdapterDependencies {
  runText?: TraexAcpTextRunner
  discoverModels?: TraexAcpCatalogDiscoverer
  verifyAuth?: TraexAuthVerifier
  onDiagnostic?: (diagnostic: string) => void
  /** Receives credential-free lifecycle facts once per invocation (success or failure); never affects the stream. */
  onSettled?: (context: RouteFailureContext) => void
  /** Receives non-authoritative model catalog observations for diagnostics/display only. */
  onCatalogObserved?: (observation: CatalogObservation) => void
  /** How long a non-authoritative catalog observation may still be shown, in ms. */
  catalogCacheTtlMs?: number
  /** Injectable clock for the catalog cache; tests only. */
  catalogClock?: () => number
}

const noAutomaticRetry: ResolvedRetryPolicy = Object.freeze({
  mode: 'normal',
  maxRetries: 0,
  retryableCodes: Object.freeze([]),
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
})

function ensureProvider(provider: string): void {
  if (provider !== TRAEX_PROVIDER_ROUTE) {
    throw new LlmError(`unknown TraeX ACP provider: ${provider}`, 'INVALID_PROVIDER')
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('TraeX request aborted', { cause: 'abort' })
}

function connectorFailure(command: string, error: unknown): Error {
  if (error instanceof Error && error.cause === 'abort') return error
  const candidate = error as (NodeJS.ErrnoException & { systemCode?: string }) | undefined
  const code = candidate?.systemCode ?? candidate?.code
  if (code === 'ENOENT') {
    return new LlmError(`TraeX executable was not found: ${command}`, 'CLI_NOT_FOUND', { cause: error })
  }
  if (error instanceof Error && error.cause === 'auth') {
    return new LlmError('TraeX ACP requires a local login; authenticate with TraeX before using this provider', 'ACP_AUTH_REQUIRED', { cause: error })
  }
  if (error instanceof Error && error.cause === 'entitlement') {
    return new LlmError('TraeX ACP did not expose any model for the active Trae account', 'ACP_ENTITLEMENT_REQUIRED', { cause: error })
  }
  if (error instanceof Error && error.cause === 'model') {
    return new LlmError('TraeX ACP does not provide the requested model', 'ACP_MODEL_UNAVAILABLE', { cause: error })
  }
  if (error instanceof Error && error.cause === 'reasoning') {
    return new LlmError('TraeX ACP does not provide the requested reasoning effort', 'UNSUPPORTED_REASONING_EFFORT', { cause: error })
  }
  if (error instanceof Error && error.cause === 'refusal') {
    return new LlmError('TraeX ACP refused the request', 'ACP_REFUSAL', { cause: error })
  }
  if (error instanceof Error && error.cause === 'timeout') {
    return new LlmError('TraeX ACP prompt timed out', 'ACP_TIMEOUT', { cause: error })
  }
  if (error instanceof Error && error.cause === 'output-limit') {
    return new LlmError('TraeX ACP output exceeded the configured safety limit', 'ACP_OUTPUT_LIMIT', { cause: error })
  }
  if (error instanceof Error && error.cause === 'protocol') {
    return new LlmError('TraeX ACP returned an invalid or incomplete protocol exchange', 'ACP_PROTOCOL_ERROR', { cause: error })
  }
  return new LlmError('TraeX ACP process failed', 'ACP_PROCESS_FAILED', { cause: error })
}

/**
 * Classify a pre-handshake serialization failure. An oversized request is reported with the
 * canonical DSH context-overflow code so the loop can compact and retry instead of surfacing an
 * unclassified failure; the prompt provably never entered the ACP stream.
 */
function preflightFailure(error: unknown): Error {
  if (error instanceof Error && error.cause === 'prompt-limit') {
    return new LlmError(error.message, CONTEXT_WINDOW_EXCEEDED_CODE, { cause: error })
  }
  return error instanceof Error
    ? new LlmError(error.message, 'ACP_PROMPT_INVALID', { cause: error })
    : new LlmError('TraeX ACP could not serialize the DSH request', 'ACP_PROMPT_INVALID', { cause: error })
}

/** Classify the original transport error into a stable, credential-free outcome for diagnostics. */
function outcomeFor(error: unknown): RouteOutcome {
  const cause = error instanceof Error ? error.cause : undefined
  const code = (error as (NodeJS.ErrnoException & { systemCode?: string }) | undefined)
  if ((code?.systemCode ?? code?.code) === 'ENOENT') return 'not-found'
  if (cause === 'abort') return 'aborted'
  if (cause === 'timeout') return 'timeout'
  if (cause === 'auth') return 'auth-required'
  if (cause === 'entitlement') return 'entitlement'
  if (cause === 'model') return 'model'
  if (cause === 'reasoning') return 'reasoning'
  if (cause === 'refusal') return 'refusal'
  if (cause === 'output-limit') return 'output-limit'
  if (cause === 'protocol') return 'protocol'
  if (cause === 'process') return 'process'
  return 'failed'
}

function reasoningInfo(model: CatalogModel | undefined): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (model?.reasoning === undefined) return {}
  return {
    reasoning: {
      efforts: model.reasoning.efforts.map(effort => ({
        id: ReasoningEffortId(effort.id),
        name: effort.name,
        ...(effort.description === undefined ? {} : { description: effort.description }),
      })),
      ...(model.reasoning.defaultEffort === undefined
        ? {}
        : { defaultEffort: ReasoningEffortId(model.reasoning.defaultEffort) }),
    },
  }
}

/** DSH text/tool compatibility facade over a fresh, local TraeX ACP session. */
export class TraexAcpAdapter extends LlmAdapter {
  private readonly cwd: string
  private readonly runText: TraexAcpTextRunner
  private readonly discoverModels: TraexAcpCatalogDiscoverer
  private readonly verifyAuth: TraexAuthVerifier
  private readonly onDiagnostic: AdapterDependencies['onDiagnostic']
  private readonly onSettled: AdapterDependencies['onSettled']
  private readonly onCatalogObserved: AdapterDependencies['onCatalogObserved']
  private readonly catalogCache: CatalogObservationCache
  private readonly lifecycle = new AbortController()

  constructor(
    private readonly config: TraexAcpProviderConfig,
    dependencies: AdapterDependencies = {},
  ) {
    super()
    this.cwd = resolve(config.cwd)
    this.runText = dependencies.runText ?? runTraexAcpText
    this.discoverModels = dependencies.discoverModels ?? discoverTraexAcpModels
    this.verifyAuth = dependencies.verifyAuth ?? verifyTraexAuth
    this.onDiagnostic = dependencies.onDiagnostic
    this.onSettled = dependencies.onSettled
    this.onCatalogObserved = dependencies.onCatalogObserved
    this.catalogCache = new CatalogObservationCache({
      ...(dependencies.catalogCacheTtlMs !== undefined ? { ttlMs: dependencies.catalogCacheTtlMs } : {}),
      ...(dependencies.catalogClock !== undefined ? { now: dependencies.catalogClock } : {}),
    })
  }

  /**
   * Cache key parts built from NON-SENSITIVE identifiers only. The config revision is derived from
   * the deployer advisory model aliases, never from environment variable values (which are secret
   * and must not become a correlatable fingerprint).
   */
  private catalogKeyParts(): CatalogCacheKeyParts {
    return {
      route: TRAEX_PROVIDER_ROUTE,
      command: this.config.command,
      cwd: this.cwd,
      configRevision: this.config.models.join(','),
    }
  }

  /**
   * Read the last observed catalog for THIS adapter's route, if still within TTL. Metadata only:
   * the current prompt's `session/new` remains the sole execution authority.
   */
  peekObservedCatalog(): CachedCatalog | undefined {
    return this.catalogCache.peek(this.catalogKeyParts())
  }

  /** Record a non-authoritative catalog observation and forward it to any diagnostic sink. */
  private handleCatalogObserved(observation: CatalogObservation): void {
    this.catalogCache.record(this.catalogKeyParts(), observation)
    if (this.onCatalogObserved === undefined) return
    try {
      this.onCatalogObserved(observation)
    } catch {
      // A non-authoritative observation must never change model-call settlement.
    }
  }

  private reportSettled(context: RouteFailureContext): void {
    if (this.onSettled === undefined) return
    try {
      this.onSettled(context)
    } catch {
      // A diagnostic sink must never change model-call settlement.
    }
  }

  /** Compose the adapter-owned forwarded flag and outcome onto the transport's lifecycle context. */
  private routeFailureFrom(
    context: ProviderFailureContext | undefined,
    assistantTextForwarded: boolean,
    outcome: RouteOutcome,
  ): RouteFailureContext {
    return {
      phase: context?.phase ?? 'stream',
      promptSubmissionState: context?.promptSubmissionState ?? 'unknown',
      assistantTextObserved: context?.assistantTextObserved ?? assistantTextForwarded,
      assistantTextForwarded,
      outcome,
      ...(context?.teardownState !== undefined ? { teardownState: context.teardownState } : {}),
      ...(context?.terminalReason !== undefined ? { terminalReason: context.terminalReason } : {}),
      ...(context?.exitCode !== undefined ? { exitCode: context.exitCode } : {}),
      ...(context?.signal !== undefined ? { signal: context.signal } : {}),
      ...(context?.metrics !== undefined ? { metrics: context.metrics } : {}),
      ...(context?.usage !== undefined ? { usage: context.usage } : {}),
    }
  }

  override providerInfo(provider: string): LlmProviderInfo {
    ensureProvider(provider)
    return { id: provider, name: 'TraeX Agent (local ACP)' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return noAutomaticRetry
  }

  private async loadCatalog(signal: AbortSignal = this.lifecycle.signal): Promise<CatalogObservation> {
    const cached = this.peekObservedCatalog()?.observation
    if (cached?.completeReasoning === true) return cached
    if (signal.aborted) throw abortReason(signal)
    try {
      await this.verifyAuth({
        command: this.config.command,
        cwd: this.cwd,
        timeoutMs: this.config.authProbeTimeoutMs,
        maxOutputBytes: this.config.maxAuthProbeBytes,
        extraEnvNames: this.config.extraEnvNames,
        signal,
      })
      const catalog = await this.discoverModels({
        command: this.config.command,
        args: [
          '--sandbox',
          'read-only',
          '--ask-for-approval',
          'never',
          'acp',
          'serve',
        ],
        cwd: this.cwd,
      }, {
        timeoutMs: this.config.timeoutMs,
        killGraceMs: this.config.killGraceMs,
        maxMessageBytes: this.config.maxMessageBytes,
        maxProtocolBytes: this.config.maxProtocolBytes,
        maxProtocolMessages: this.config.maxProtocolMessages,
        maxOutputBytes: this.config.maxOutputBytes,
        maxStderrBytes: this.config.maxStderrBytes,
        extraEnvNames: this.config.extraEnvNames,
        onDiagnostic: diagnostic => this.onDiagnostic?.(diagnostic),
        signal,
      })
      this.handleCatalogObserved(catalog)
      return catalog
    } catch (error: unknown) {
      this.catalogCache.invalidate(this.catalogKeyParts())
      throw connectorFailure(this.config.command, error)
    }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    ensureProvider(provider)
    const catalog = await this.loadCatalog()
    const active = catalog.models.find(model => model.id === catalog.currentValue)
    const entries = new Map<string, LlmModelInfo>()
    for (const model of this.config.models) {
      entries.set(model, {
        provider,
        id: model,
        name: model === 'default'
          ? `TraeX active model${active === undefined ? '' : ` (${active.name})`}`
          : model,
        description: 'Experimental text compatibility route backed by a local TraeX ACP agent',
        inputModalities: ['text'],
      })
    }
    for (const model of catalog.models) {
      entries.set(model.id, {
        provider,
        id: model.id,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
        inputModalities: ['text'],
      })
    }
    return [...entries.values()]
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    ensureProvider(provider)
    const effectiveSignal = signal === undefined
      ? this.lifecycle.signal
      : AbortSignal.any([signal, this.lifecycle.signal])
    if (effectiveSignal.aborted) throw abortReason(effectiveSignal)
    const catalog = await this.loadCatalog(effectiveSignal)
    const catalogModel = model === 'default'
      ? catalog.models.find(entry => entry.id === catalog.currentValue)
      : catalog.models.find(entry => entry.id === model)
    return {
      provider,
      id: model,
      name: model === 'default'
        ? `TraeX active model${catalogModel === undefined ? '' : ` (${catalogModel.name})`}`
        : (catalogModel?.name ?? model),
      description: catalogModel?.description ?? 'Experimental local ACP coding-agent delegation',
      inputModalities: ['text'],
      ...reasoningInfo(catalogModel),
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    ensureProvider(options.provider)
    const signal = options.signal === undefined
      ? this.lifecycle.signal
      : AbortSignal.any([options.signal, this.lifecycle.signal])

    let assistantTextForwarded = false
    let transportContext: ProviderFailureContext | undefined
    // Track the best-known lifecycle facts so a single settled report fires on ANY exit,
    // including the earliest pre-auth abort and a consumer that returns early.
    let phase: RouteFailureContext['phase'] = 'auth'
    let promptSubmissionState: PromptSubmissionState = 'not-submitted'
    let authProbeDurationMs: number | undefined
    let outcome: RouteOutcome = 'aborted'
    let reported = false
    const settle = (): void => {
      if (reported) return
      reported = true
      this.reportSettled({
        ...this.routeFailureFrom(transportContext, assistantTextForwarded, outcome),
        ...(transportContext === undefined ? {
          phase,
          promptSubmissionState,
          teardownState: promptSubmissionState === 'not-submitted' ? 'not-started' : 'unknown',
          ...(authProbeDurationMs !== undefined ? { metrics: { authProbeDurationMs } } : {}),
        } : {}),
      })
    }

    try {
      if (signal.aborted) throw abortReason(signal)

      const authStartedAt = performance.now()
      try {
        await this.verifyAuth({
          command: this.config.command,
          cwd: this.cwd,
          timeoutMs: this.config.authProbeTimeoutMs,
          maxOutputBytes: this.config.maxAuthProbeBytes,
          extraEnvNames: this.config.extraEnvNames,
          signal,
        })
      } catch (error: unknown) {
        // Auth precedes the ACP handshake, so the prompt never entered the stream.
        // A stale catalog observation must not outlive an auth failure (the account or plan
        // may have changed), so drop it here regardless of the eventual outcome.
        this.catalogCache.invalidate(this.catalogKeyParts())
        outcome = outcomeFor(error)
        throw connectorFailure(this.config.command, error)
      } finally {
        authProbeDurationMs = performance.now() - authStartedAt
      }

      // Preflight prompt serialization runs before the handshake; a failure here is provably not-submitted.
      phase = 'preflight'
      let invocation: TraexAcpInvocation
      try {
        invocation = {
          command: this.config.command,
          args: [
            '--sandbox',
            'read-only',
            '--ask-for-approval',
            'never',
            'acp',
            'serve',
          ],
          cwd: this.cwd,
          prompt: buildPrompt(options, this.config.maxPromptBytes),
          ...(options.model === 'default' ? {} : { model: options.model }),
          ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: String(options.reasoningEffort) }),
        }
      } catch (error: unknown) {
        outcome = 'preflight'
        throw preflightFailure(error)
      }
      let terminal: TraexSuccessfulStopReason | undefined
      const runnerOptions: RunTraexAcpOptions = {
        timeoutMs: this.config.timeoutMs,
        killGraceMs: this.config.killGraceMs,
        maxMessageBytes: this.config.maxMessageBytes,
        maxProtocolBytes: this.config.maxProtocolBytes,
        maxProtocolMessages: this.config.maxProtocolMessages,
        maxOutputBytes: this.config.maxOutputBytes,
        maxStderrBytes: this.config.maxStderrBytes,
        extraEnvNames: this.config.extraEnvNames,
        onStopReason: reason => { terminal = reason },
        onDiagnostic: diagnostic => this.onDiagnostic?.(diagnostic),
        onSettled: context => { transportContext = context },
        ...(authProbeDurationMs !== undefined ? { authProbeDurationMs } : {}),
        onCatalogObserved: observation => this.handleCatalogObserved(observation),
        signal,
      }

      // block-start alone runs nothing: prompt stays provably not-submitted until execution
      // resumes toward the transport. Once iteration begins the transport owns the state and
      // reports it via onSettled; if it never reports (early return mid-stream) we say unknown.
      phase = 'stream'
      let text = ''
      const bufferForToolDelegation = (options.tools?.length ?? 0) > 0
      const textDeltas: string[] = []
      if (!bufferForToolDelegation) yield { type: 'block-start', index: 0, blockType: 'text' }
      try {
        // Calling an injected runner may synchronously start work or throw. From immediately
        // before that call, replay safety is unknown until the transport supplies exact facts.
        promptSubmissionState = 'unknown'
        const deltas = this.runText(invocation, runnerOptions)
        for await (const delta of deltas) {
          if (delta.length === 0) continue
          text += delta
          if (bufferForToolDelegation) {
            textDeltas.push(delta)
          } else {
            assistantTextForwarded = true
            yield { type: 'text-delta', index: 0, text: delta }
          }
        }
      } catch (error: unknown) {
        outcome = outcomeFor(error)
        throw connectorFailure(this.config.command, error)
      }
      if (terminal === undefined) {
        outcome = 'protocol'
        throw connectorFailure(this.config.command, new Error('TraeX ACP terminal metadata was missing', { cause: 'protocol' }))
      }
      outcome = 'ok'

      if (bufferForToolDelegation && terminal === 'end_turn') {
        let calls: ReturnType<typeof parseDelegatedToolCalls>
        try {
          calls = parseDelegatedToolCalls(text, options.tools ?? [])
        } catch (error: unknown) {
          outcome = 'protocol'
          throw connectorFailure(this.config.command, error)
        }
        if (calls !== undefined) {
          for (const [index, call] of calls.entries()) {
            const id = CallId(`traex-${randomUUID()}`)
            yield { type: 'block-start', index, blockType: 'tool-call' }
            yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: call.arguments }
            yield {
              type: 'block-end',
              index,
              block: { type: 'tool-call', id, name: call.name, arguments: call.arguments },
            }
          }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
      }

      if (bufferForToolDelegation) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        for (const delta of textDeltas) {
          assistantTextForwarded = true
          yield { type: 'text-delta', index: 0, text: delta }
        }
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield {
        type: 'finish',
        reason: terminal === 'end_turn' ? { kind: 'stop' } : { kind: 'max-tokens' },
      }
    } finally {
      settle()
    }
  }

  shutdown(): void {
    // A reload/unload drops every non-authoritative observation; a later run re-observes from a
    // fresh handshake, which is the only execution authority anyway.
    this.catalogCache.clear()
    if (!this.lifecycle.signal.aborted) {
      this.lifecycle.abort(new Error('TraeX ACP provider unloaded', { cause: 'abort' }))
    }
  }
}

export function redactDiagnostic(value: string): string {
  return value
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\b((?:proxy-)?authorization\s*[:=]\s*)(?:basic|bearer)\s+[^\s]+/gi, '$1[redacted]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1[redacted]@')
    .replace(/(bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|auth(?:orization)?|token)\s*[:=]\s*)[^\s]+/gi, '$1[redacted]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----/gi, '[redacted-private-key]')
    .replace(/\b(?:sk|xai)-[A-Za-z0-9_-]{8,}\b/g, '[redacted-key]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .slice(-2_000)
}
