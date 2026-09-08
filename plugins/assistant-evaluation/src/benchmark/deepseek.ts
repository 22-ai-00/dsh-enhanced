/**
 * Trusted Host binding for the fixed DeepSeek goal-metered route.
 *
 * This is deliberately an adapter module for `dsh-benchmark --adapter`; it does
 * not activate the DeepSeek bundle or register a Goal meter in the benchmark
 * Context.
 */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { NativeAdapterBinding, NativeModelConfig } from './native.js'

type DeepSeekCredentialResolver = { resolve(reference: unknown): Promise<{ value: string } | undefined> }
type ProductionAdapter = LlmAdapter & { shutdown(): void }
interface DeepSeekRuntime {
  DeepSeekGoalMeteredAdapter: new (config: { defaultMaxTokens: number }, dependencies: { credentialResolver(): DeepSeekCredentialResolver | undefined }) => ProductionAdapter
  DEEPSEEK_CHAT_COMPLETIONS_CONTRACT: { expiresAt: string }
  DEEPSEEK_INPUT_TOKEN_UPPER_BOUND: number
  DEEPSEEK_MODELS: readonly string[]
  DEEPSEEK_PROVIDER: string
}

const packageName = '@dsh-enhanced/assistant-deepseek-budget'
const provider = 'deepseek-goal-metered'
const models = Object.freeze(['deepseek-v4-flash', 'deepseek-v4-pro'])

function assertCurrentContract(expiresAt: string, now = Date.now()): void {
  const contractExpiry = Date.parse(expiresAt)
  if (!Number.isFinite(now) || !Number.isFinite(contractExpiry) || now >= contractExpiry) {
    throw new Error('assistant-evaluation: DeepSeek protocol contract has expired')
  }
}

function runtime(value: unknown): DeepSeekRuntime {
  if (value === null || typeof value !== 'object') throw new Error('assistant-evaluation: DeepSeek adapter runtime is unavailable')
  const candidate = value as Partial<DeepSeekRuntime>
  if (typeof candidate.DeepSeekGoalMeteredAdapter !== 'function' || candidate.DEEPSEEK_PROVIDER !== provider
    || !Array.isArray(candidate.DEEPSEEK_MODELS) || candidate.DEEPSEEK_MODELS.length !== models.length
    || !candidate.DEEPSEEK_MODELS.every((item, index) => item === models[index])
    || typeof candidate.DEEPSEEK_INPUT_TOKEN_UPPER_BOUND !== 'number' || !Number.isSafeInteger(candidate.DEEPSEEK_INPUT_TOKEN_UPPER_BOUND)
    || candidate.DEEPSEEK_INPUT_TOKEN_UPPER_BOUND !== 2_097_152 || candidate.DEEPSEEK_CHAT_COMPLETIONS_CONTRACT === null
    || typeof candidate.DEEPSEEK_CHAT_COMPLETIONS_CONTRACT !== 'object' || typeof candidate.DEEPSEEK_CHAT_COMPLETIONS_CONTRACT.expiresAt !== 'string') {
    throw new Error('assistant-evaluation: DeepSeek adapter runtime is incompatible')
  }
  return candidate as DeepSeekRuntime
}

function validateModel(model: Readonly<NativeModelConfig>, deepseek: DeepSeekRuntime): void {
  if (model.provider !== deepseek.DEEPSEEK_PROVIDER) throw new Error('assistant-evaluation: invalid DeepSeek provider')
  if (!deepseek.DEEPSEEK_MODELS.includes(model.model)) throw new Error('assistant-evaluation: invalid DeepSeek model')
  if ((model.inputLimitMode ?? 'upper-bound') !== 'upper-bound' || (model.outputLimitMode ?? 'provider') !== 'provider') {
    throw new Error('assistant-evaluation: DeepSeek benchmark requires upper-bound input and provider output limits')
  }
  if (model.temperature !== null && (!Number.isFinite(model.temperature) || model.temperature < 0 || model.temperature > 2)) {
    throw new Error('assistant-evaluation: invalid DeepSeek temperature')
  }
  if (!Number.isSafeInteger(model.maxOutputTokens) || model.maxOutputTokens < 1 || model.maxOutputTokens > 32_768) {
    throw new Error('assistant-evaluation: invalid DeepSeek max output tokens')
  }
  for (const field of ['inputUsdMicrosPerMillionTokens', 'outputUsdMicrosPerMillionTokens', 'cacheReadUsdMicrosPerMillionTokens', 'cacheWriteUsdMicrosPerMillionTokens'] as const) {
    const value = model[field]
    if (value !== null && value !== undefined) throw new Error('assistant-evaluation: DeepSeek tariff is unverified')
  }
}

function validateRequest(model: Readonly<NativeModelConfig>, expiresAt: string, options: GenerateOptions, disposed: boolean): void {
  if (disposed) throw new Error('assistant-evaluation: DeepSeek benchmark adapter is disposed')
  assertCurrentContract(expiresAt)
  if (options.provider !== model.provider || options.model !== model.model || options.maxTokens !== model.maxOutputTokens
    || options.temperature !== (model.temperature ?? undefined)) throw new Error('assistant-evaluation: DeepSeek benchmark request drift')
}

function validateProvider(model: Readonly<NativeModelConfig>, expiresAt: string, provider: string, disposed: boolean): void {
  if (disposed) throw new Error('assistant-evaluation: DeepSeek benchmark adapter is disposed')
  assertCurrentContract(expiresAt)
  if (provider !== model.provider) throw new Error('assistant-evaluation: DeepSeek benchmark request drift')
}

function validateRoute(model: Readonly<NativeModelConfig>, expiresAt: string, provider: string, requestedModel: string, disposed: boolean): void {
  validateProvider(model, expiresAt, provider, disposed)
  if (requestedModel !== model.model) throw new Error('assistant-evaluation: DeepSeek benchmark request drift')
}

class FrozenDeepSeekAdapter extends LlmAdapter {
  #disposed = false

  constructor(private readonly model: Readonly<NativeModelConfig>, private readonly expiresAt: string, private readonly production: ProductionAdapter) { super() }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    validateRequest(this.model, this.expiresAt, options, this.#disposed)
    for await (const chunk of this.production.stream(options)) yield chunk
  }

  override providerInfo(provider: string) {
    validateProvider(this.model, this.expiresAt, provider, this.#disposed)
    return this.production.providerInfo(provider)
  }

  override providerRetryPolicy(provider: string) {
    validateProvider(this.model, this.expiresAt, provider, this.#disposed)
    return this.production.providerRetryPolicy(provider)
  }

  override async listModels(provider: string) {
    validateProvider(this.model, this.expiresAt, provider, this.#disposed)
    const models = await this.production.listModels(provider)
    return models.filter(candidate => candidate.id === this.model.model)
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal) {
    validateRoute(this.model, this.expiresAt, provider, model, this.#disposed)
    return this.production.resolveModel(provider, model, signal)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.production.shutdown()
  }
}

/** Create the trusted native benchmark binding for a fixed DeepSeek model. */
export async function createNativeAdapter(model: Readonly<NativeModelConfig>, environment: Readonly<{ ctx: Context; workspace: string }>): Promise<NativeAdapterBinding> {
  // The variable import avoids an Evaluation-to-DeepSeek declaration-build cycle.
  const deepseek = runtime(await import(packageName))
  validateModel(model, deepseek)
  assertCurrentContract(deepseek.DEEPSEEK_CHAT_COMPLETIONS_CONTRACT.expiresAt)
  const frozenModel = Object.freeze({ ...model })
  // Production defaults remain in force: 60 seconds and 4 MiB. No fetch,
  // environment, endpoint, or credential-value override is exposed here.
  const production = new deepseek.DeepSeekGoalMeteredAdapter({ defaultMaxTokens: frozenModel.maxOutputTokens }, {
    credentialResolver: () => environment.ctx.get('credentials' as never) as DeepSeekCredentialResolver | undefined,
  })
  if (!(production instanceof LlmAdapter) || typeof production.shutdown !== 'function') throw new Error('assistant-evaluation: DeepSeek adapter runtime is incompatible')
  const adapter = new FrozenDeepSeekAdapter(frozenModel, deepseek.DEEPSEEK_CHAT_COMPLETIONS_CONTRACT.expiresAt, production)
  let disposed = false
  return Object.freeze({
    adapter,
    inputTokenUpperBound(options: GenerateOptions): number {
      validateRequest(frozenModel, deepseek.DEEPSEEK_CHAT_COMPLETIONS_CONTRACT.expiresAt, options, disposed)
      return deepseek.DEEPSEEK_INPUT_TOKEN_UPPER_BOUND
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      adapter.dispose()
    },
  })
}
