import { resolve } from 'node:path'
import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { verifySubscriptionAuth, type SubscriptionAuthVerifier } from './auth.js'
import { configForProvider, type CodingSubscriptionProviderConfig } from './config.js'
import { buildPrompt } from './prompt.js'
import { runCliText, type RunCliTextOptions } from './process.js'
import { buildInvocation, type CliInvocation, type ProviderId } from './providers.js'

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

export interface AdapterDependencies {
  runText?: CliTextRunner
  verifyAuth?: SubscriptionAuthVerifier
  onDiagnostic?: (route: SubscriptionProviderRoute, diagnostic: string) => void
}

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

/** Experimental LLM-compatible facade over local, already-authenticated coding agents. */
export class CodingSubscriptionAdapter extends LlmAdapter {
  private readonly cwd: string
  private readonly runText: CliTextRunner
  private readonly verifyAuth: SubscriptionAuthVerifier
  private readonly onDiagnostic: AdapterDependencies['onDiagnostic']
  private readonly lifecycle = new AbortController()

  constructor(
    private readonly config: CodingSubscriptionProviderConfig,
    dependencies: AdapterDependencies = {},
  ) {
    super()
    this.cwd = resolve(config.cwd)
    this.runText = dependencies.runText ?? runCliText
    this.verifyAuth = dependencies.verifyAuth ?? verifySubscriptionAuth
    this.onDiagnostic = dependencies.onDiagnostic
  }

  override providerInfo(provider: string): LlmProviderInfo {
    const definition = definitionFor(provider)
    return { id: provider, name: definition.name }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return noAutomaticRetry
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const definition = definitionFor(provider)
    const profile = configForProvider(this.config, definition.cli)
    return Promise.resolve(profile.models.map(model => ({
      provider,
      id: model,
      name: model === 'default' ? `${definition.name} default` : model,
      description: `${definition.maturity} local coding-agent delegation; authentication and billing remain in the official CLI`,
      inputModalities: ['text'] as const,
    })))
  }

  override resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted) return Promise.reject(abortReason(signal))
    const definition = definitionFor(provider)
    return Promise.resolve({
      provider,
      id: model,
      name: model === 'default' ? `${definition.name} default` : model,
      description: `${definition.maturity} local coding-agent delegation`,
      inputModalities: ['text'],
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const definition = definitionFor(options.provider)
    const profile = configForProvider(this.config, definition.cli)
    const signal = options.signal === undefined
      ? this.lifecycle.signal
      : AbortSignal.any([options.signal, this.lifecycle.signal])
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
      throw cliFailure(definition, profile.command, error)
    }
    const prompt = buildPrompt(options, this.config.maxPromptBytes)
    const invocation = buildInvocation(definition.cli, {
      cwd: this.cwd,
      prompt,
      model: options.model,
      maxTurns: profile.maxTurns,
      command: profile.command,
    })
    const runnerOptions: RunCliTextOptions = {
      timeoutMs: this.config.timeoutMs,
      killGraceMs: this.config.killGraceMs,
      maxLineBytes: this.config.maxLineBytes,
      maxOutputBytes: this.config.maxOutputBytes,
      maxStderrBytes: this.config.maxStderrBytes,
      extraEnvNames: this.config.extraEnvNames,
      onDiagnostic: diagnostic => this.onDiagnostic?.(definition.route, diagnostic),
      signal,
    }

    let text = ''
    yield { type: 'block-start', index: 0, blockType: 'text' }
    try {
      for await (const delta of this.runText(invocation, runnerOptions)) {
        if (delta.length === 0) continue
        text += delta
        yield { type: 'text-delta', index: 0, text: delta }
      }
    } catch (error: unknown) {
      throw cliFailure(definition, profile.command, error)
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  /** Abort every active/future subprocess when the owning Cordis fiber unloads. */
  shutdown(): void {
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
