import { resolve } from 'node:path'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { verifySubscriptionAuth, type SubscriptionAuthVerifier } from './auth.js'
import {
  discoverCodexModels,
  type CodexCatalog,
  type CodexCatalogInvocation,
  type CodexCatalogModel,
  type DiscoverCodexModelsOptions,
} from './codex-catalog.js'
import { CodexCredentialStore } from './codex-direct-auth.js'
import {
  runCodexDirectResponses,
  type CodexDirectResponsesDependencies,
} from './codex-direct-responses.js'
import {
  configForProvider,
  type CodexProviderConfig,
  type CodingSubscriptionProviderConfig,
} from './config.js'
import { buildPrompt } from './prompt.js'
import { runCliText, type ProviderFailureContext, type PromptSubmissionState, type RunCliTextOptions } from './process.js'
import { buildInvocation, type CliInvocation, type ProviderId } from './providers.js'
import { resolveTrustedSessionCwd, TrustedSessionCwdError, type LiveSessionLookup } from './session-cwd.js'
import {
  discoverClaudeModels,
  discoverCursorModels,
  discoverGrokModels,
  type DiscoverSubscriptionCatalogOptions,
  type SubscriptionCatalog,
  type SubscriptionCatalogInvocation,
  type SubscriptionCatalogModel,
} from './subscription-catalog.js'

export type SubscriptionProviderRoute =
  | 'codex-subscription'
  | 'claude-subscription'
  | 'cursor-subscription'
  | 'grok-subscription'

interface RouteDefinition {
  route: SubscriptionProviderRoute
  cli: ProviderId
  name: string
  maturity: 'stable' | 'beta' | 'experimental'
}

export const routeDefinitions: readonly RouteDefinition[] = [
  { route: 'codex-subscription', cli: 'codex', name: 'Codex Subscription (local CLI)', maturity: 'stable' },
  { route: 'claude-subscription', cli: 'claude', name: 'Claude Subscription (local Claude Code)', maturity: 'experimental' },
  { route: 'cursor-subscription', cli: 'cursor', name: 'Cursor Subscription (local Agent CLI)', maturity: 'beta' },
  { route: 'grok-subscription', cli: 'grok', name: 'Grok Subscription (local Grok Build)', maturity: 'beta' },
]

export type CliTextRunner = (invocation: CliInvocation, options?: RunCliTextOptions) => AsyncIterable<string>
export type CodexCatalogDiscoverer = (
  invocation: CodexCatalogInvocation,
  options?: DiscoverCodexModelsOptions,
) => Promise<CodexCatalog>
export type SubscriptionCatalogDiscoverer = (
  invocation: SubscriptionCatalogInvocation,
  options?: DiscoverSubscriptionCatalogOptions,
) => Promise<SubscriptionCatalog>
export type CodexDirectRunner = typeof runCodexDirectResponses

/**
 * Full lifecycle facts the adapter can observe for one route: the transport context
 * plus the `auth`/`preflight` phases (which precede spawn), a stable failure class, and
 * whether text actually reached DSH. Credential-free and internal; never attached to `LlmError`.
 */
export interface RouteFailureContext extends Partial<Omit<ProviderFailureContext, 'phase'>> {
  readonly route: SubscriptionProviderRoute
  readonly phase: ProviderFailureContext['phase'] | 'auth' | 'preflight'
  readonly assistantTextForwarded: boolean
  readonly teardownState: ProviderFailureContext['teardownState']
  /** Stable outcome class for diagnostics/health; `ok` on success. */
  readonly outcome: RouteOutcome
}

/** Stable, credential-free outcome classes distinct enough for future health/cooldown routing. */
export type RouteOutcome =
  | 'ok'
  | 'aborted'
  | 'timeout'
  | 'auth-required'
  | 'working-directory'
  | 'not-found'
  | 'protocol'
  | 'process'
  | 'output-limit'
  | 'line-limit'
  | 'io'
  | 'preflight'
  | 'failed'

export interface AdapterDependencies {
  runText?: CliTextRunner
  discoverCodexModels?: CodexCatalogDiscoverer
  discoverClaudeModels?: SubscriptionCatalogDiscoverer
  discoverCursorModels?: SubscriptionCatalogDiscoverer
  discoverGrokModels?: SubscriptionCatalogDiscoverer
  runCodexDirect?: CodexDirectRunner
  codexCredentials?: Pick<CodexCredentialStore, 'requestResponses'>
  attachments?: CodexDirectResponsesDependencies['attachments']
  /** Resolve the optional host attachment service at operation time. */
  getAttachments?: () => CodexDirectResponsesDependencies['attachments']
  verifyAuth?: SubscriptionAuthVerifier
  onDiagnostic?: (route: SubscriptionProviderRoute, diagnostic: string) => void
  /** Receives credential-free lifecycle facts once per invocation (success or failure); never affects the stream. */
  onSettled?: (context: RouteFailureContext) => void
  /** Host-owned live session lookup used to bind local process cwd to a loop request. */
  liveSessions?: LiveSessionLookup
}

const CATALOG_TTL_MS = 5 * 60_000
type NonCodexProvider = Exclude<ProviderId, 'codex'>

const noAutomaticRetry: ResolvedRetryPolicy = Object.freeze({
  mode: 'normal',
  maxRetries: 0,
  retryableCodes: Object.freeze([]),
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
})

function definitionFor(route: string): RouteDefinition {
  const definition = routeDefinitions.find(candidate => candidate.route === route)
  if (definition === undefined) throw new LlmError(`unknown coding subscription provider: ${route}`, 'INVALID_PROVIDER')
  return definition
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('model resolution aborted')
}

function cliFailure(definition: RouteDefinition, command: string, error: unknown): Error {
  if (error instanceof Error && error.cause === 'abort') return error
  if (error instanceof TrustedSessionCwdError) {
    return new LlmError(
      `${definition.name} requires a live loop-owned session whose canonical cwd matches the configured local workspace`,
      'LOCAL_SESSION_CWD_REQUIRED',
      { cause: error },
    )
  }
  if (error instanceof Error && error.cause === 'subscription-auth') {
    return new LlmError(
      `${definition.name} refused the request because a subscription-compatible login could not be verified`,
      'SUBSCRIPTION_AUTH_REQUIRED',
      { cause: error },
    )
  }
  if (error instanceof Error && error.cause === 'working-directory') {
    return new LlmError(
      `${definition.name} refused the configured working directory; set config.cwd to a Git repository (relative paths resolve from the DSH process directory) and restart DSH`,
      'CLI_WORKING_DIRECTORY',
      { cause: error },
    )
  }
  if (error instanceof Error && error.cause === 'protocol') {
    return new LlmError(`${definition.name} returned an unrecognized or incomplete event stream`, 'CLI_PROTOCOL_ERROR', { cause: error })
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') {
    return new LlmError(`${definition.name} executable was not found: ${command}`, 'CLI_NOT_FOUND', { cause: error })
  }
  if (error instanceof Error && error.cause === 'timeout') {
    return new LlmError(`${definition.name} timed out`, 'CLI_TIMEOUT', { cause: error })
  }
  return new LlmError(
    `${definition.name} failed; verify that the official CLI is installed and logged in with the intended subscription`,
    'CLI_FAILED',
    { cause: error },
  )
}

export const CODEX_DIRECT_PROVIDER_HTTP_CODE = 'CODEX_DIRECT_PROVIDER_HTTP'
export const CODEX_DIRECT_PROVIDER_FAILURE_CODE = 'CODEX_DIRECT_PROVIDER_FAILURE'
export const CODEX_DIRECT_CONTENT_FILTER_CODE = 'CODEX_DIRECT_CONTENT_FILTER'
export const CODEX_DIRECT_TRANSPORT_ERROR_CODE = 'CODEX_DIRECT_TRANSPORT_ERROR'

function directFailure(definition: RouteDefinition, error: unknown): Error {
  if (error instanceof LlmError) return error
  if (error instanceof Error && error.cause === 'abort') return error
  if (error instanceof TrustedSessionCwdError) {
    return new LlmError(
      `${definition.name} requires a live loop-owned session whose canonical cwd matches the configured local workspace`,
      'LOCAL_SESSION_CWD_REQUIRED',
      { cause: error },
    )
  }
  const cause = error instanceof Error ? error.cause : undefined
  const status = validHttpStatus(error)
  if (cause === 'subscription-auth') {
    return new LlmError(
      'Codex private Responses could not use the local ChatGPT session',
      'SUBSCRIPTION_AUTH_REQUIRED',
      status === undefined ? undefined : { status },
    )
  }
  if (cause === 'timeout') {
    return new LlmError('Codex private Responses request timed out', 'CLI_TIMEOUT')
  }
  if (cause === 'protocol') {
    return new LlmError(
      'Codex private Responses returned an unrecognized or incomplete stream',
      'CLI_PROTOCOL_ERROR',
    )
  }
  if (cause === 'provider-http') {
    return new LlmError(
      'Codex private Responses provider request failed',
      CODEX_DIRECT_PROVIDER_HTTP_CODE,
      status === undefined ? undefined : { status },
    )
  }
  if (cause === 'context-window') {
    return new LlmError(
      'Codex private Responses exceeded the model context window',
      CONTEXT_WINDOW_EXCEEDED_CODE,
    )
  }
  if (cause === 'quota') {
    return new LlmError('Codex private Responses account quota was exhausted', QUOTA_EXCEEDED_CODE)
  }
  if (cause === 'provider-failure') {
    return new LlmError(
      'Codex private Responses reported a provider failure',
      CODEX_DIRECT_PROVIDER_FAILURE_CODE,
    )
  }
  if (cause === 'content-filter') {
    return new LlmError('Codex private Responses output was filtered', CODEX_DIRECT_CONTENT_FILTER_CODE)
  }
  if (cause === 'empty-response') {
    return new LlmError('Codex private Responses returned no visible output', EMPTY_RESPONSE_CODE)
  }
  if (cause === 'transport') {
    return new LlmError('Codex private Responses transport failed', CODEX_DIRECT_TRANSPORT_ERROR_CODE)
  }
  return new LlmError(
    'Codex private Responses request failed',
    'CODEX_DIRECT_RESPONSES_FAILED',
    { cause: error },
  )
}

function validHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const status = (error as { readonly status?: unknown }).status
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined
}

/** Stable code for a request that needs tool calls this text-only route cannot make. */
export const TOOL_CALLS_UNSUPPORTED_CODE = 'tool_calls_unsupported'

/**
 * Refuse a request that supplies tool schemas.
 *
 * These routes drive local coding CLIs that only return assistant text; they
 * cannot emit a `tool-call` block. Silently dropping `options.tools` would let an
 * unattended automation appear to run while never invoking its allowlisted tools,
 * so the request fails loudly and names the working alternative instead.
 */
function toolCallsUnsupported(definition: RouteDefinition): LlmError {
  return new LlmError(
    `${definition.name} is a text-only route and cannot perform tool calls. `
    + 'Use a provider that emits tool calls (for example @dsh-enhanced/traex-acp-provider) '
    + 'for agent or automation work that requires tools.',
    TOOL_CALLS_UNSUPPORTED_CODE,
  )
}

/** Report a local prompt bound through DSH's canonical overflow path so compaction can retry it. */
function preflightFailure(error: unknown): Error {
  if (error instanceof Error && error.cause === 'prompt-limit') {
    return new LlmError(error.message, CONTEXT_WINDOW_EXCEEDED_CODE, { cause: error })
  }
  return error instanceof Error ? error : new Error('coding subscription provider could not serialize the DSH request')
}

/** Classify the original transport error into a stable, credential-free outcome for diagnostics. */
function outcomeFor(error: unknown): RouteOutcome {
  if (error instanceof TrustedSessionCwdError) return 'working-directory'
  const cause = error instanceof Error ? error.cause : undefined
  if (cause === 'abort') return 'aborted'
  if (cause === 'timeout') return 'timeout'
  if (cause === 'subscription-auth') return 'auth-required'
  if (cause === 'working-directory') return 'working-directory'
  if (cause === 'protocol') return 'protocol'
  if (cause === 'process-exit') return 'process'
  if (cause === 'output-limit') return 'output-limit'
  if (cause === 'line-limit') return 'line-limit'
  if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return 'not-found'
  // A bare stream error carries no recognized cause but is a local I/O fault, not a model failure.
  if (error instanceof Error && cause === undefined && !(error instanceof LlmError)) return 'io'
  return 'failed'
}

function reasoningInfo(
  model: CodexCatalogModel | SubscriptionCatalogModel | undefined,
): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
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

function directReasoningInfo(
  profile: CodexProviderConfig,
): Pick<LlmResolvedModelInfo, 'reasoning'> {
  return {
    reasoning: {
      efforts: profile.directReasoningEfforts.map(effort => ({
        id: ReasoningEffortId(effort),
        name: effort,
      })),
      defaultEffort: ReasoningEffortId(profile.directDefaultReasoningEffort),
    },
  }
}

/** Experimental LLM-compatible facade over local, already-authenticated coding agents. */
export class CodingSubscriptionAdapter extends LlmAdapter {
  private readonly cwd: string
  private readonly runText: CliTextRunner
  private readonly discoverCodexModels: CodexCatalogDiscoverer
  private readonly discoverClaudeModels: SubscriptionCatalogDiscoverer
  private readonly discoverCursorModels: SubscriptionCatalogDiscoverer
  private readonly discoverGrokModels: SubscriptionCatalogDiscoverer
  private readonly runCodexDirect: CodexDirectRunner
  private readonly codexCredentials: Pick<CodexCredentialStore, 'requestResponses'>
  private readonly getAttachments: () => CodexDirectResponsesDependencies['attachments']
  private readonly verifyAuth: SubscriptionAuthVerifier
  private readonly onDiagnostic: AdapterDependencies['onDiagnostic']
  private readonly onSettled: AdapterDependencies['onSettled']
  private readonly liveSessions: LiveSessionLookup | undefined
  private readonly lifecycle = new AbortController()
  private codexCatalogCache: { readonly catalog: CodexCatalog; readonly expiresAt: number } | undefined
  private readonly subscriptionCatalogCache = new Map<NonCodexProvider, {
    readonly catalog: SubscriptionCatalog
    readonly expiresAt: number
  }>()

  constructor(
    private readonly config: CodingSubscriptionProviderConfig,
    dependencies: AdapterDependencies = {},
  ) {
    super()
    this.cwd = resolve(config.cwd)
    this.runText = dependencies.runText ?? runCliText
    this.discoverCodexModels = dependencies.discoverCodexModels ?? discoverCodexModels
    this.discoverClaudeModels = dependencies.discoverClaudeModels ?? discoverClaudeModels
    this.discoverCursorModels = dependencies.discoverCursorModels ?? discoverCursorModels
    this.discoverGrokModels = dependencies.discoverGrokModels ?? discoverGrokModels
    this.runCodexDirect = dependencies.runCodexDirect ?? runCodexDirectResponses
    this.codexCredentials = dependencies.codexCredentials ?? new CodexCredentialStore()
    this.getAttachments = dependencies.getAttachments ?? (() => dependencies.attachments)
    this.verifyAuth = dependencies.verifyAuth ?? verifySubscriptionAuth
    this.onDiagnostic = dependencies.onDiagnostic
    this.onSettled = dependencies.onSettled
    this.liveSessions = dependencies.liveSessions
  }

  private trustedCwd(request: GenerateOptions): string {
    return resolveTrustedSessionCwd({ request, configuredCwd: this.cwd, sessions: this.liveSessions })
  }

  private reportSettled(context: RouteFailureContext): void {
    if (this.onSettled === undefined) return
    try {
      this.onSettled(context)
    } catch {
      // A diagnostic sink must never change model-call settlement.
    }
  }

  override providerInfo(provider: string): LlmProviderInfo {
    const definition = definitionFor(provider)
    return {
      id: provider,
      name: definition.cli === 'codex' && this.config.codex.transport === 'direct-responses'
        ? 'Codex Subscription (private Responses, experimental)'
        : definition.name,
    }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return noAutomaticRetry
  }

  private peekCodexCatalog(): CodexCatalog | undefined {
    const cached = this.codexCatalogCache
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.catalog
    this.codexCatalogCache = undefined
    return undefined
  }

  private peekSubscriptionCatalog(provider: NonCodexProvider): SubscriptionCatalog | undefined {
    const cached = this.subscriptionCatalogCache.get(provider)
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.catalog
    this.subscriptionCatalogCache.delete(provider)
    return undefined
  }

  /**
   * Observe the advisory CLI catalog only after stream has bound this operation to a
   * canonical live-session cwd.  The caller owns the auth probe and must revalidate
   * the session immediately before crossing this subprocess boundary.
   */
  private async observeCodexCatalog(cwd: string, signal: AbortSignal): Promise<CodexCatalog> {
    if (signal.aborted) throw abortReason(signal)
    const cached = this.peekCodexCatalog()
    if (cached !== undefined) return cached
    const definition = definitionFor('codex-subscription')
    const profile = this.config.codex
    try {
      const catalog = await this.discoverCodexModels({ command: profile.command, cwd }, {
        signal,
        timeoutMs: this.config.authProbeTimeoutMs,
        killGraceMs: this.config.killGraceMs,
        maxLineBytes: this.config.maxLineBytes,
        maxOutputBytes: this.config.maxOutputBytes,
        maxStderrBytes: this.config.maxStderrBytes,
        extraEnvNames: this.config.extraEnvNames,
        onDiagnostic: diagnostic => this.onDiagnostic?.(definition.route, diagnostic),
      })
      this.codexCatalogCache = { catalog, expiresAt: Date.now() + CATALOG_TTL_MS }
      return catalog
    } catch (error: unknown) {
      this.codexCatalogCache = undefined
      throw error
    }
  }

  private async observeSubscriptionCatalog(
    provider: NonCodexProvider,
    cwd: string,
    signal: AbortSignal,
  ): Promise<SubscriptionCatalog> {
    if (signal.aborted) throw abortReason(signal)
    const cached = this.peekSubscriptionCatalog(provider)
    if (cached !== undefined) return cached
    const profile = configForProvider(this.config, provider)
    const discoverer = provider === 'claude'
      ? this.discoverClaudeModels
      : provider === 'cursor'
        ? this.discoverCursorModels
        : this.discoverGrokModels
    try {
      const catalog = await discoverer({ command: profile.command, cwd }, {
        signal,
        timeoutMs: this.config.authProbeTimeoutMs,
        maxOutputBytes: this.config.maxAuthProbeBytes,
        extraEnvNames: this.config.extraEnvNames,
      })
      this.subscriptionCatalogCache.set(provider, { catalog, expiresAt: Date.now() + CATALOG_TTL_MS })
      return catalog
    } catch (error: unknown) {
      this.subscriptionCatalogCache.delete(provider)
      throw error
    }
  }

  private observedCatalog(provider: ProviderId): CodexCatalog | SubscriptionCatalog | undefined {
    return provider === 'codex'
      ? this.peekCodexCatalog()
      : this.peekSubscriptionCatalog(provider)
  }

  private observeCatalog(provider: ProviderId, cwd: string, signal: AbortSignal): Promise<CodexCatalog | SubscriptionCatalog> {
    return provider === 'codex'
      ? this.observeCodexCatalog(cwd, signal)
      : this.observeSubscriptionCatalog(provider, cwd, signal)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const definition = definitionFor(provider)
    const profile = configForProvider(this.config, definition.cli)
    const directCodex = definition.cli === 'codex' && this.config.codex.transport === 'direct-responses'
    const catalog = directCodex ? undefined : this.observedCatalog(definition.cli)
    const attachments = directCodex ? this.getAttachments() : undefined
    const inputModalities: LlmModelInfo['inputModalities'] = directCodex && attachments !== undefined
      ? ['text', 'image']
      : ['text']
    const defaultModel = catalog?.models.find(model => model.id === catalog.defaultModel)
    const entries = new Map<string, LlmModelInfo>()
    for (const model of profile.models) {
      entries.set(model, {
        provider,
        id: model,
        name: directCodex && model === 'default'
          ? `Codex Subscription (private Responses) default (${this.config.codex.directModel})`
          : model === 'default'
          ? `${definition.name} default${defaultModel === undefined ? '' : ` (${defaultModel.name})`}`
          : model,
        description: directCodex
          ? 'experimental direct private Codex Responses transport using the local ChatGPT session'
          : `${definition.maturity} local coding-agent delegation; authentication and billing remain in the official CLI`,
        inputModalities,
      })
    }
    for (const model of catalog?.models ?? []) {
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
    const effectiveSignal = signal === undefined
      ? this.lifecycle.signal
      : AbortSignal.any([signal, this.lifecycle.signal])
    if (effectiveSignal.aborted) throw abortReason(effectiveSignal)
    const definition = definitionFor(provider)
    const directCodex = definition.cli === 'codex' && this.config.codex.transport === 'direct-responses'
    const catalog = directCodex ? undefined : this.observedCatalog(definition.cli)
    const catalogModel = model === 'default'
      ? catalog?.models.find(candidate => candidate.id === catalog.defaultModel)
      : catalog?.models.find(candidate => candidate.id === model)
    const attachments = directCodex ? this.getAttachments() : undefined
    return {
      provider,
      id: model,
      name: directCodex && model === 'default'
        ? `Codex Subscription (private Responses) default (${this.config.codex.directModel})`
        : model === 'default'
        ? `${definition.name} default${catalogModel === undefined ? '' : ` (${catalogModel.name})`}`
        : (catalogModel?.name ?? model),
      description: catalogModel?.description ?? (directCodex
        ? 'experimental direct private Codex Responses transport using the local ChatGPT session'
        : `${definition.maturity} local coding-agent delegation`),
      inputModalities: directCodex && attachments !== undefined ? ['text', 'image'] : ['text'],
      ...(directCodex ? directReasoningInfo(this.config.codex) : reasoningInfo(catalogModel)),
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const definition = definitionFor(options.provider)
    const profile = configForProvider(this.config, definition.cli)
    const signal = options.signal === undefined
      ? this.lifecycle.signal
      : AbortSignal.any([options.signal, this.lifecycle.signal])
    let assistantTextForwarded = false
    let transportContext: ProviderFailureContext | undefined
    // Track the best-known lifecycle facts so a single settled report fires on ANY exit,
    // including a consumer that returns early after block-start or a text delta.
    let phase: RouteFailureContext['phase'] = 'preflight'
    let promptSubmissionState: PromptSubmissionState = 'not-submitted'
    let outcome: RouteOutcome = 'aborted'
    let reported = false
    const settle = (): void => {
      if (reported) return
      reported = true
      this.reportSettled({
        route: definition.route,
        phase: transportContext?.phase ?? phase,
        promptSubmissionState: transportContext?.promptSubmissionState ?? promptSubmissionState,
        assistantTextObserved: transportContext?.assistantTextObserved ?? assistantTextForwarded,
        assistantTextForwarded,
        outcome,
        teardownState: transportContext?.teardownState ?? 'not-started',
        ...(transportContext?.terminalReason !== undefined ? { terminalReason: transportContext.terminalReason } : {}),
        ...(transportContext?.exitCode !== undefined ? { exitCode: transportContext.exitCode } : {}),
        ...(transportContext?.signal !== undefined ? { signal: transportContext.signal } : {}),
        ...(transportContext?.metrics !== undefined ? { metrics: transportContext.metrics } : {}),
      })
    }

    try {
      if (signal.aborted) throw abortReason(signal)
      const directCodex = definition.cli === 'codex' && this.config.codex.transport === 'direct-responses'
      // Refuse tool work before any subprocess starts: this route cannot emit a
      // tool call, and a silent drop would look like a successful empty run.
      if (!directCodex && options.tools !== undefined && options.tools.length > 0) {
        outcome = 'preflight'
        throw toolCallsUnsupported(definition)
      }
      let cwd: string
      try {
        cwd = this.trustedCwd(options)
      } catch (error: unknown) {
        outcome = outcomeFor(error)
        throw cliFailure(definition, profile.command, error)
      }
      if (directCodex) {
        const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs)
        const directSignal = AbortSignal.any([signal, timeoutSignal])
        phase = 'stream'
        try {
          // Revalidate immediately before the first credential/file/network seam.
          this.trustedCwd(options)
          promptSubmissionState = 'unknown'
          // `maxTokens` is a host-local Agent Loop budget. The private Codex
          // request has no max_output_tokens field, so do not hand this hint to
          // the direct runner (which deliberately rejects unsupported controls).
          const { maxTokens: hostMaxTokens, ...directInput } = options
          void hostMaxTokens
          const directOptions: GenerateOptions = {
            ...directInput,
            model: options.model === 'default' ? this.config.codex.directModel : options.model,
            signal: directSignal,
          }
          const attachments = this.getAttachments()
          const chunks = this.runCodexDirect(directOptions, {
            request: (body, requestSignal) => this.codexCredentials.requestResponses(body, requestSignal),
            maxRequestBytes: this.config.codex.maxRequestBytes,
            maxRequestImageBytes: this.config.codex.maxRequestImageBytes,
            ...(attachments === undefined ? {} : { attachments }),
          })
          for await (const chunk of chunks) {
            if (chunk.type === 'text-delta' && chunk.text.length > 0) assistantTextForwarded = true
            yield chunk
          }
          outcome = 'ok'
          return
        } catch (error: unknown) {
          if (signal.aborted) {
            outcome = 'aborted'
            throw abortReason(signal)
          }
          if (error instanceof Error && error.cause === 'prompt-limit') {
            phase = 'preflight'
            promptSubmissionState = 'not-submitted'
            outcome = 'preflight'
            throw preflightFailure(error)
          }
          const failure = timeoutSignal.aborted && !signal.aborted
            ? new Error('Codex direct Responses request timed out', { cause: 'timeout' })
            : error
          outcome = outcomeFor(failure)
          throw directFailure(definition, failure)
        }
      }
      // Build and bound the argv locally before any auth probe or generation subprocess starts.
      let invocation: CliInvocation
      try {
        invocation = buildInvocation(definition.cli, {
          cwd,
          prompt: buildPrompt(options, this.config.maxPromptBytes),
          model: options.model,
          ...(definition.cli !== 'cursor' && options.reasoningEffort !== undefined
            ? { reasoningEffort: String(options.reasoningEffort) }
            : {}),
          maxTurns: profile.maxTurns,
          command: profile.command,
        })
      } catch (error: unknown) {
        outcome = 'preflight'
        throw preflightFailure(error)
      }
      phase = 'auth'
      try {
        await this.verifyAuth(definition.cli, {
          command: profile.command,
          cwd,
          timeoutMs: this.config.authProbeTimeoutMs,
          maxOutputBytes: this.config.maxAuthProbeBytes,
          extraEnvNames: this.config.extraEnvNames,
          signal,
          ...(definition.cli === 'grok'
            ? { userVerifiedSubscription: this.config.grok.userVerifiedSubscription }
            : {}),
        })
      } catch (error: unknown) {
        // Auth precedes spawn, so the prompt argv was never handed to the OS.
        if (definition.cli === 'codex') this.codexCatalogCache = undefined
        else this.subscriptionCatalogCache.delete(definition.cli)
        outcome = outcomeFor(error)
        throw cliFailure(definition, profile.command, error)
      }

      // Dynamic model metadata remains advisory, but discovering it is still local
      // process authority.  Bind the discovery to the live canonical session cwd and
      // recheck after auth so a stale/replaced session cannot reach the catalog process.
      phase = 'preflight'
      try {
        cwd = this.trustedCwd(options)
        await this.observeCatalog(definition.cli, cwd, signal)
      } catch (error: unknown) {
        outcome = outcomeFor(error)
        throw cliFailure(definition, profile.command, error)
      }
      const runnerOptions: RunCliTextOptions = {
        timeoutMs: this.config.timeoutMs,
        killGraceMs: this.config.killGraceMs,
        maxLineBytes: this.config.maxLineBytes,
        maxOutputBytes: this.config.maxOutputBytes,
        maxStderrBytes: this.config.maxStderrBytes,
        extraEnvNames: this.config.extraEnvNames,
        onDiagnostic: diagnostic => this.onDiagnostic?.(definition.route, diagnostic),
        onSettled: context => { transportContext = context },
        signal,
      }

      // block-start alone runs nothing: prompt stays provably not-submitted until execution
      // resumes toward the transport. Once iteration begins the transport owns the state and
      // reports it via onSettled; if it never reports (early return mid-stream) we say unknown.
      phase = 'stream'
      let text = ''
      yield { type: 'block-start', index: 0, blockType: 'text' }
      try {
        // Calling an injected runner may itself perform work or throw synchronously, so
        // stop claiming not-submitted immediately before control crosses that boundary.
        promptSubmissionState = 'unknown'
        invocation = { ...invocation, cwd: this.trustedCwd(options) }
        const deltas = this.runText(invocation, runnerOptions)
        for await (const delta of deltas) {
          if (delta.length === 0) continue
          text += delta
          assistantTextForwarded = true
          yield { type: 'text-delta', index: 0, text: delta }
        }
      } catch (error: unknown) {
        outcome = outcomeFor(error)
        throw cliFailure(definition, profile.command, error)
      }
      outcome = 'ok'
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      settle()
    }
  }

  /** Abort every active/future subprocess when the owning Cordis fiber unloads. */
  shutdown(): void {
    this.codexCatalogCache = undefined
    this.subscriptionCatalogCache.clear()
    if (!this.lifecycle.signal.aborted) {
      this.lifecycle.abort(new Error('coding subscription provider unloaded', { cause: 'abort' }))
    }
  }
}

export function enabledRoutes(config: CodingSubscriptionProviderConfig): SubscriptionProviderRoute[] {
  return routeDefinitions
    .filter(definition => configForProvider(config, definition.cli).enabled)
    .map(definition => definition.route)
}

/** Redact common credential/email shapes before a bounded CLI diagnostic reaches host logs. */
export function redactDiagnostic(value: string): string {
  return value
    .replace(/(bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|auth(?:orization)?|token)\s*[:=]\s*)[^\s]+/gi, '$1[redacted]')
    .replace(/\b(?:sk|xai)-[A-Za-z0-9_-]{8,}\b/g, '[redacted-key]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .slice(-2_000)
}
