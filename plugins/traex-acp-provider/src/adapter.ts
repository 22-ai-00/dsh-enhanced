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
import {
  runTraexAcpText,
  type RunTraexAcpOptions,
  type TraexAcpInvocation,
  type TraexSuccessfulStopReason,
} from './acp-client.js'
import { verifyTraexAuth, type TraexAuthVerifier } from './auth.js'
import type { TraexAcpProviderConfig } from './config.js'
import { buildPrompt } from './prompt.js'

export const TRAEX_PROVIDER_ROUTE = 'traex-agent'

export type TraexAcpTextRunner = (
  invocation: TraexAcpInvocation,
  options?: RunTraexAcpOptions,
) => AsyncIterable<string>

export interface AdapterDependencies {
  runText?: TraexAcpTextRunner
  verifyAuth?: TraexAuthVerifier
  onDiagnostic?: (diagnostic: string) => void
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

/** Text-only DSH compatibility facade over a fresh, local TraeX ACP session. */
export class TraexAcpAdapter extends LlmAdapter {
  private readonly cwd: string
  private readonly runText: TraexAcpTextRunner
  private readonly verifyAuth: TraexAuthVerifier
  private readonly onDiagnostic: AdapterDependencies['onDiagnostic']
  private readonly lifecycle = new AbortController()

  constructor(
    private readonly config: TraexAcpProviderConfig,
    dependencies: AdapterDependencies = {},
  ) {
    super()
    this.cwd = resolve(config.cwd)
    this.runText = dependencies.runText ?? runTraexAcpText
    this.verifyAuth = dependencies.verifyAuth ?? verifyTraexAuth
    this.onDiagnostic = dependencies.onDiagnostic
  }

  override providerInfo(provider: string): LlmProviderInfo {
    ensureProvider(provider)
    return { id: provider, name: 'TraeX Agent (local ACP)' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return noAutomaticRetry
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    ensureProvider(provider)
    return Promise.resolve(this.config.models.map(model => ({
      provider,
      id: model,
      name: model === 'default' ? 'TraeX active model' : model,
      description: 'Experimental text compatibility route backed by a local TraeX ACP agent',
      inputModalities: ['text'] as const,
    })))
  }

  override resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    ensureProvider(provider)
    if (signal?.aborted) return Promise.reject(abortReason(signal))
    if (!this.config.models.includes(model)) {
      return Promise.reject(new LlmError(`TraeX model is not configured: ${model}`, 'MODEL_NOT_FOUND'))
    }
    return Promise.resolve({
      provider,
      id: model,
      name: model === 'default' ? 'TraeX active model' : model,
      description: 'Experimental local ACP coding-agent delegation',
      inputModalities: ['text'],
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    ensureProvider(options.provider)
    const signal = options.signal === undefined
      ? this.lifecycle.signal
      : AbortSignal.any([options.signal, this.lifecycle.signal])
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
    } catch (error: unknown) {
      throw connectorFailure(this.config.command, error)
    }

    const prompt = buildPrompt(options, this.config.maxPromptBytes)
    const invocation: TraexAcpInvocation = {
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
      prompt,
      ...(options.model === 'default' ? {} : { model: options.model }),
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
      throw connectorFailure(this.config.command, error)
    }
    if (terminal === undefined) {
      throw connectorFailure(this.config.command, new Error('TraeX ACP terminal metadata was missing', { cause: 'protocol' }))
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield {
      type: 'finish',
      reason: terminal === 'end_turn' ? { kind: 'stop' } : { kind: 'max-tokens' },
    }
  }

  shutdown(): void {
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
