import { resolve } from 'node:path'
import {
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
import { verifySubscriptionAuth, type SubscriptionAuthVerifier } from './auth.js'
import {
  discoverCodexModels,
  type CodexCatalog,
  type CodexCatalogInvocation,
  type CodexCatalogModel,
  type DiscoverCodexModelsOptions,
} from './codex-catalog.js'
import { configForProvider, type CodingSubscriptionProviderConfig } from './config.js'
import { buildPrompt } from './prompt.js'
import { runCliText, type ProviderFailureContext, type PromptSubmissionState, type RunCliTextOptions } from './process.js'
import { buildInvocation, type CliInvocation, type ProviderId } from './providers.js'
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
  verifyAuth?: SubscriptionAuthVerifier
  onDiagnostic?: (route: SubscriptionProviderRoute, diagnostic: string) => void
  /** Receives credential-free lifecycle facts once per invocation (success or failure); never affects the stream. */
  onSettled?: (context: RouteFailureContext) => void
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

/** Classify the original transport error into a stable, credential-free outcome for diagnostics. */
function outcomeFor(error: unknown): RouteOutcome {
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

/** Experimental LLM-compatible facade over local, already-authenticated coding agents. */
export class CodingSubscriptionAdapter extends LlmAdapter {
  private readonly cwd: string
  private readonly runText: CliTextRunner
  private readonly discoverCodexModels: CodexCatalogDiscoverer
  private readonly discoverClaudeModels: SubscriptionCatalogDiscoverer
  private readonly discoverCursorModels: SubscriptionCatalogDiscoverer
  private readonly discoverGrokModels: SubscriptionCatalogDiscoverer
  private readonly verifyAuth: SubscriptionAuthVerifier
  private readonly onDiagnostic: AdapterDependencies['onDiagnostic']
  private readonly onSettled: AdapterDependencies['onSettled']
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
    this.verifyAuth = dependencies.verifyAuth ?? verifySubscriptionAuth
    this.onDiagnostic = dependencies.onDiagnostic
    this.onSettled = dependencies.onSettled
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
    return { id: provider, name: definition.name }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return noAutomaticRetry
  }

  private async loadCodexCatalog(signal: AbortSignal = this.lifecycle.signal): Promise<CodexCatalog> {
    if (signal.aborted) throw abortReason(signal)
    const cached = this.codexCatalogCache
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.catalog
    const definition = definitionFor('codex-subscription')
    const profile = this.config.codex
    try {
      await this.verifyAuth('codex', {
        command: profile.command,
        cwd: this.cwd,
        timeoutMs: this.config.authProbeTimeoutMs,
        maxOutputBytes: this.config.maxAuthProbeBytes,
        extraEnvNames: this.config.extraEnvNames,
        signal,
      })
      const catalog = await this.discoverCodexModels({ command: profile.command, cwd: this.cwd }, {
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
      throw cliFailure(definition, profile.command, error)
    }
  }

  private async loadSubscriptionCatalog(
    provider: NonCodexProvider,
    signal: AbortSignal = this.lifecycle.signal,
  ): Promise<SubscriptionCatalog> {
    if (signal.aborted) throw abortReason(signal)
    const cached = this.subscriptionCatalogCache.get(provider)
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.catalog
    const definition = routeDefinitions.find(candidate => candidate.cli === provider)!
    const profile = configForProvider(this.config, provider)
    const discoverer = provider === 'claude'
      ? this.discoverClaudeModels
      : provider === 'cursor'
        ? this.discoverCursorModels
        : this.discoverGrokModels
    try {
      await this.verifyAuth(provider, {
        command: profile.command,
        cwd: this.cwd,
        timeoutMs: this.config.authProbeTimeoutMs,
        maxOutputBytes: this.config.maxAuthProbeBytes,
        extraEnvNames: this.config.extraEnvNames,
        signal,
        ...(provider === 'grok'
          ? { userVerifiedSubscription: this.config.grok.userVerifiedSubscription }
          : {}),
      })
      const catalog = await discoverer({ command: profile.command, cwd: this.cwd }, {
        signal,
        timeoutMs: this.config.authProbeTimeoutMs,
        maxOutputBytes: this.config.maxAuthProbeBytes,
        extraEnvNames: this.config.extraEnvNames,
      })
      this.subscriptionCatalogCache.set(provider, { catalog, expiresAt: Date.now() + CATALOG_TTL_MS })
      return catalog
    } catch (error: unknown) {
      this.subscriptionCatalogCache.delete(provider)
      throw cliFailure(definition, profile.command, error)
    }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const definition = definitionFor(provider)
    const profile = configForProvider(this.config, definition.cli)
    const catalog = definition.cli === 'codex'
      ? await this.loadCodexCatalog()
      : await this.loadSubscriptionCatalog(definition.cli)
    const defaultModel = catalog.models.find(model => model.id === catalog.defaultModel)
    const entries = new Map<string, LlmModelInfo>()
    for (const model of profile.models) {
      entries.set(model, {
        provider,
        id: model,
        name: model === 'default'
          ? `${definition.name} default${defaultModel === undefined ? '' : ` (${defaultModel.name})`}`
          : model,
        description: `${definition.maturity} local coding-agent delegation; authentication and billing remain in the official CLI`,
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
    const effectiveSignal = signal === undefined
      ? this.lifecycle.signal
      : AbortSignal.any([signal, this.lifecycle.signal])
    if (effectiveSignal.aborted) throw abortReason(effectiveSignal)
    const definition = definitionFor(provider)
    const catalog = definition.cli === 'codex'
      ? await this.loadCodexCatalog(effectiveSignal)
      : await this.loadSubscriptionCatalog(definition.cli, effectiveSignal)
    const catalogModel = model === 'default'
      ? catalog.models.find(candidate => candidate.id === catalog.defaultModel)
      : catalog.models.find(candidate => candidate.id === model)
    return {
      provider,
      id: model,
      name: model === 'default'
        ? `${definition.name} default${catalogModel === undefined ? '' : ` (${catalogModel.name})`}`
        : (catalogModel?.name ?? model),
      description: catalogModel?.description ?? `${definition.maturity} local coding-agent delegation`,
      inputModalities: ['text'],
      ...reasoningInfo(catalogModel),
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
    let phase: RouteFailureContext['phase'] = 'auth'
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
      try {
        await this.verifyAuth(definition.cli, {
          command: profile.command,
          cwd: this.cwd,
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
      // Preflight prompt serialization runs before spawn; a failure here is provably not-submitted.
      phase = 'preflight'
      let invocation: CliInvocation
      try {
        invocation = buildInvocation(definition.cli, {
          cwd: this.cwd,
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
        throw error
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
