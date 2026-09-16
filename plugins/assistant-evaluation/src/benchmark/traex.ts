/**
 * Trusted Host binding for the fixed TraeX ACP route (observed-call-count mode).
 *
 * This is deliberately an adapter module for `dsh-benchmark --adapter`; it does
 * not activate the TraeX provider bundle. Unlike the DeepSeek binding there is no
 * protocol expiry, no credential resolver and no input-token upper bound: the
 * local TraeX login state authenticates the ACP subprocess and the strategy
 * meter counts settled model calls while rejecting any provider-emitted usage.
 */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { NativeAdapterBinding, NativeModelConfig } from './native.js'

type ProductionAdapter = LlmAdapter & { shutdown(): void }
interface TraexLiveSession { readonly id: string; readonly header: { readonly cwd?: string } }
interface TraexLiveSessions { get(id: string): TraexLiveSession | undefined }
interface TraexRequestAttestor { claim(request: GenerateOptions, session: object): boolean }
interface TraexAdapterDependencies {
  readonly liveSessions?: TraexLiveSessions
  readonly requestAttestor?: TraexRequestAttestor
}
interface TraexNormalizedConfig {
  readonly enabled: boolean
  readonly command: string
  readonly cwd: string
  readonly models: readonly string[]
}
interface TraexRuntime {
  TraexAcpAdapter: new (config: TraexNormalizedConfig, dependencies?: TraexAdapterDependencies) => ProductionAdapter
  TRAEX_PROVIDER_ROUTE: string
  normalizeConfig: (input?: unknown) => TraexNormalizedConfig
}

const packageName = '@dsh-enhanced/traex-acp-provider'
const routeCapabilitiesPackage = '@dsh-enhanced/llm-route-capabilities'
const provider = 'traex-agent'
// The one route/model pair already proven against the real local TraeX login state (WP14).
const models = Object.freeze(['gpt-5.6-terra'])
const command = 'traex'

function runtime(value: unknown): TraexRuntime {
  if (value === null || typeof value !== 'object') throw new Error('assistant-evaluation: TraeX adapter runtime is unavailable')
  const candidate = value as Partial<TraexRuntime>
  if (typeof candidate.TraexAcpAdapter !== 'function' || candidate.TRAEX_PROVIDER_ROUTE !== provider
    || typeof candidate.normalizeConfig !== 'function') {
    throw new Error('assistant-evaluation: TraeX adapter runtime is incompatible')
  }
  return candidate as TraexRuntime
}

function validateModel(model: Readonly<NativeModelConfig>): void {
  if (model.observationMode !== 'observed-call-count') {
    throw new Error('assistant-evaluation: TraeX benchmark requires observed-call-count observation mode')
  }
  if (model.provider !== provider) throw new Error('assistant-evaluation: invalid TraeX provider')
  if (!models.includes(model.model)) throw new Error('assistant-evaluation: invalid TraeX model')
  if (model.temperature !== null && (!Number.isFinite(model.temperature) || model.temperature < 0 || model.temperature > 2)) {
    throw new Error('assistant-evaluation: invalid TraeX temperature')
  }
  if (!Number.isSafeInteger(model.maxOutputTokens) || model.maxOutputTokens < 1) {
    throw new Error('assistant-evaluation: invalid TraeX max output tokens')
  }
  // No token contract exists on this route: every tariff must stay null so a
  // conclusion can never cite a token count or a monetary cost that was never measured.
  for (const field of ['inputUsdMicrosPerMillionTokens', 'outputUsdMicrosPerMillionTokens', 'cacheReadUsdMicrosPerMillionTokens', 'cacheWriteUsdMicrosPerMillionTokens'] as const) {
    const value = model[field]
    if (value !== null && value !== undefined) throw new Error('assistant-evaluation: TraeX route must not declare token tariffs')
  }
}

function validateRequest(model: Readonly<NativeModelConfig>, options: GenerateOptions, disposed: boolean): void {
  if (disposed) throw new Error('assistant-evaluation: TraeX benchmark adapter is disposed')
  if (options.provider !== model.provider || options.model !== model.model || options.maxTokens !== model.maxOutputTokens
    || options.temperature !== (model.temperature ?? undefined)) throw new Error('assistant-evaluation: TraeX benchmark request drift')
}

function validateProvider(model: Readonly<NativeModelConfig>, providerName: string, disposed: boolean): void {
  if (disposed) throw new Error('assistant-evaluation: TraeX benchmark adapter is disposed')
  if (providerName !== model.provider) throw new Error('assistant-evaluation: TraeX benchmark request drift')
}

class FrozenTraexAdapter extends LlmAdapter {
  #disposed = false

  constructor(private readonly model: Readonly<NativeModelConfig>, private readonly production: ProductionAdapter) { super() }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    validateRequest(this.model, options, this.#disposed)
    for await (const chunk of this.production.stream(options)) yield chunk
  }

  override providerInfo(providerName: string) {
    validateProvider(this.model, providerName, this.#disposed)
    return this.production.providerInfo(providerName)
  }

  override providerRetryPolicy(providerName: string) {
    validateProvider(this.model, providerName, this.#disposed)
    return this.production.providerRetryPolicy(providerName)
  }

  override async listModels(providerName: string) {
    validateProvider(this.model, providerName, this.#disposed)
    const listed = await this.production.listModels(providerName)
    return listed.filter(candidate => candidate.id === this.model.model)
  }

  override async resolveModel(providerName: string, requestedModel: string, signal?: AbortSignal) {
    validateProvider(this.model, providerName, this.#disposed)
    if (requestedModel !== this.model.model) throw new Error('assistant-evaluation: TraeX benchmark request drift')
    return this.production.resolveModel(providerName, requestedModel, signal)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.production.shutdown()
  }
}

/** Create the trusted native benchmark binding for a fixed TraeX model. */
export async function createNativeAdapter(model: Readonly<NativeModelConfig>, environment: Readonly<{ ctx: Context; workspace: string }>): Promise<NativeAdapterBinding> {
  // Variable imports avoid an Evaluation-to-TraeX declaration-build cycle and keep
  // the optional peer packages out of module load for suites that never use this route.
  const [traexModule, routeCapabilities] = await Promise.all([import(packageName), import(routeCapabilitiesPackage)])
  const traex = runtime(traexModule)
  validateModel(model)
  const frozenModel = Object.freeze({ ...model })
  const config = traex.normalizeConfig({ enabled: true, command, cwd: environment.workspace, models: [frozenModel.model] })
  const liveSessions = environment.ctx.get('sessions' as never) as unknown as TraexLiveSessions | undefined
  const agents = environment.ctx.get('agents' as never) as unknown as Parameters<typeof routeCapabilities.createAgentLoopRequestAttestor>[0] | undefined
  // Fail closed: the trusted ACP subprocess cannot be constructed without a live
  // session lookup and the loop request attestor.
  if (liveSessions === undefined || agents === undefined) {
    throw new Error('assistant-evaluation: TraeX benchmark requires live loop sessions and agents services')
  }
  const dependencies: TraexAdapterDependencies = {
    // A local ACP subprocess must be bound to a live loop session, never a static workspace.
    liveSessions,
    requestAttestor: routeCapabilities.createAgentLoopRequestAttestor(agents, [provider]),
  }
  const production = new traex.TraexAcpAdapter(config, dependencies)
  if (!(production instanceof LlmAdapter) || typeof production.shutdown !== 'function') throw new Error('assistant-evaluation: TraeX adapter runtime is incompatible')
  const adapter = new FrozenTraexAdapter(frozenModel, production)
  let disposed = false
  // Intentionally no inputTokenUpperBound: the binding only carries the adapter,
  // and the calls-mode meter enforces request contract, call/tool budgets and finish shape.
  return Object.freeze({
    adapter,
    dispose(): void {
      if (disposed) return
      disposed = true
      adapter.dispose()
    },
  })
}
