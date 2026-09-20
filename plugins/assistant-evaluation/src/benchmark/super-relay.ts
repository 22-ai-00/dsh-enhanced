/**
 * Super Relay（OpenAI Responses 协议）真实模型评测的可信 Host binding。
 *
 * 这是 `dsh-benchmark --adapter` 的 adapter 模块：它不激活 super-relay bundle，
 * 也不在 benchmark Context 里注册 Goal meter；只把生产 adapter 包一层做逐请求
 * 契约冻结（provider/model/maxTokens/temperature 漂移一律拒绝）。
 *
 * 计量语义：super-relay Responses 路由真实回传 usage（input/output/total token），
 * 因此走 native.ts 默认的 token 计量模式（enforced-upper-bound-provider-output）。
 * 网关没有公开定价，故四档费率与 budget.costUsdMicros 恒为 null——token 如实计量，
 * 金钱成本绝不估算、绝不伪造。input 上界 200000 是保守 fail-closed 上限，不是对
 * 任一请求实际消耗的估算。
 */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { NativeAdapterBinding, NativeAdapterFactory, NativeModelConfig } from './native.js'

type SuperRelayCredentialResolver = { resolve(reference: unknown): Promise<{ value: string } | undefined> }
type ProductionAdapter = LlmAdapter & { shutdown(): void }
interface SuperRelayRuntime {
  SuperRelayGoalMeteredAdapter: new (
    config: { defaultMaxTokens: number; timeoutMs: number },
    dependencies: { credentialResolver(): SuperRelayCredentialResolver | undefined },
  ) => ProductionAdapter
  SUPER_RELAY_RESPONSES_CONTRACT: { expiresAt: string }
  SUPER_RELAY_INPUT_TOKEN_UPPER_BOUND: number
  SUPER_RELAY_MODELS: readonly string[]
  SUPER_RELAY_PROVIDER: string
}

const packageName = '@dsh-enhanced/assistant-super-relay-budget'
const provider = 'super-relay'
const models = Object.freeze(['auto_model/alwaysday1'])
// 与生产包 contract.ts 中的保守 fail-closed 上界保持字面一致；runtime() 会交叉断言。
const inputTokenUpperBound = 200_000

function assertCurrentContract(expiresAt: string, now = Date.now()): void {
  const contractExpiry = Date.parse(expiresAt)
  if (!Number.isFinite(now) || !Number.isFinite(contractExpiry) || now >= contractExpiry) {
    throw new Error('assistant-evaluation: Super Relay protocol contract has expired')
  }
}

function runtime(value: unknown): SuperRelayRuntime {
  if (value === null || typeof value !== 'object') throw new Error('assistant-evaluation: Super Relay adapter runtime is unavailable')
  const candidate = value as Partial<SuperRelayRuntime>
  if (typeof candidate.SuperRelayGoalMeteredAdapter !== 'function' || candidate.SUPER_RELAY_PROVIDER !== provider
    || !Array.isArray(candidate.SUPER_RELAY_MODELS) || candidate.SUPER_RELAY_MODELS.length !== models.length
    || !candidate.SUPER_RELAY_MODELS.every((item, index) => item === models[index])
    || typeof candidate.SUPER_RELAY_INPUT_TOKEN_UPPER_BOUND !== 'number' || !Number.isSafeInteger(candidate.SUPER_RELAY_INPUT_TOKEN_UPPER_BOUND)
    || candidate.SUPER_RELAY_INPUT_TOKEN_UPPER_BOUND !== inputTokenUpperBound || candidate.SUPER_RELAY_RESPONSES_CONTRACT === null
    || typeof candidate.SUPER_RELAY_RESPONSES_CONTRACT !== 'object' || typeof candidate.SUPER_RELAY_RESPONSES_CONTRACT.expiresAt !== 'string') {
    throw new Error('assistant-evaluation: Super Relay adapter runtime is incompatible')
  }
  return candidate as SuperRelayRuntime
}

function validateModel(model: Readonly<NativeModelConfig>): void {
  if (model.provider !== provider) throw new Error('assistant-evaluation: invalid Super Relay provider')
  if (!models.includes(model.model)) throw new Error('assistant-evaluation: invalid Super Relay model')
  if ((model.inputLimitMode ?? 'upper-bound') !== 'upper-bound' || (model.outputLimitMode ?? 'provider') !== 'provider') {
    throw new Error('assistant-evaluation: Super Relay benchmark requires upper-bound input and provider output limits')
  }
  if (model.temperature !== null && (!Number.isFinite(model.temperature) || model.temperature < 0 || model.temperature > 2)) {
    throw new Error('assistant-evaluation: invalid Super Relay temperature')
  }
  if (!Number.isSafeInteger(model.maxOutputTokens) || model.maxOutputTokens < 1 || model.maxOutputTokens > 32_768) {
    throw new Error('assistant-evaluation: invalid Super Relay max output tokens')
  }
  // 网关无公开定价：任何非空费率都视为未核验，拒绝而不是默默套用。
  for (const field of ['inputUsdMicrosPerMillionTokens', 'outputUsdMicrosPerMillionTokens', 'cacheReadUsdMicrosPerMillionTokens', 'cacheWriteUsdMicrosPerMillionTokens'] as const) {
    const value = model[field]
    if (value !== null && value !== undefined) throw new Error('assistant-evaluation: Super Relay tariff is unverified')
  }
}

function validateRequest(model: Readonly<NativeModelConfig>, expiresAt: string, options: GenerateOptions, disposed: boolean): void {
  if (disposed) throw new Error('assistant-evaluation: Super Relay benchmark adapter is disposed')
  assertCurrentContract(expiresAt)
  if (options.provider !== model.provider || options.model !== model.model || options.maxTokens !== model.maxOutputTokens
    || options.temperature !== (model.temperature ?? undefined)) throw new Error('assistant-evaluation: Super Relay benchmark request drift')
}

function validateProvider(model: Readonly<NativeModelConfig>, expiresAt: string, requestedProvider: string, disposed: boolean): void {
  if (disposed) throw new Error('assistant-evaluation: Super Relay benchmark adapter is disposed')
  assertCurrentContract(expiresAt)
  if (requestedProvider !== model.provider) throw new Error('assistant-evaluation: Super Relay benchmark request drift')
}

function validateRoute(model: Readonly<NativeModelConfig>, expiresAt: string, requestedProvider: string, requestedModel: string, disposed: boolean): void {
  validateProvider(model, expiresAt, requestedProvider, disposed)
  if (requestedModel !== model.model) throw new Error('assistant-evaluation: Super Relay benchmark request drift')
}

class FrozenSuperRelayAdapter extends LlmAdapter {
  #disposed = false

  constructor(private readonly model: Readonly<NativeModelConfig>, private readonly expiresAt: string, private readonly production: ProductionAdapter) { super() }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    validateRequest(this.model, this.expiresAt, options, this.#disposed)
    for await (const chunk of this.production.stream(options)) yield chunk
  }

  override providerInfo(requestedProvider: string) {
    validateProvider(this.model, this.expiresAt, requestedProvider, this.#disposed)
    return this.production.providerInfo(requestedProvider)
  }

  override providerRetryPolicy(requestedProvider: string) {
    validateProvider(this.model, this.expiresAt, requestedProvider, this.#disposed)
    return this.production.providerRetryPolicy(requestedProvider)
  }

  override async listModels(requestedProvider: string) {
    validateProvider(this.model, this.expiresAt, requestedProvider, this.#disposed)
    const available = await this.production.listModels(requestedProvider)
    return available.filter(candidate => candidate.id === this.model.model)
  }

  override async resolveModel(requestedProvider: string, requestedModel: string, signal?: AbortSignal) {
    validateRoute(this.model, this.expiresAt, requestedProvider, requestedModel, this.#disposed)
    return this.production.resolveModel(requestedProvider, requestedModel, signal)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.production.shutdown()
  }
}

export interface SuperRelayNativeAdapterOptions { timeoutMs?: number }

/** Freeze the transport deadline before creating any source or comparison cell. */
export function createSuperRelayNativeAdapterFactory(options: Readonly<SuperRelayNativeAdapterOptions> = {}): NativeAdapterFactory {
  if (options === null || typeof options !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    throw new Error('assistant-evaluation: invalid Super Relay adapter options')
  }
  for (const key of Reflect.ownKeys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key)!
    if (key !== 'timeoutMs' || !('value' in descriptor)) throw new Error('assistant-evaluation: invalid Super Relay adapter options')
  }
  const configuredTimeout = Object.getOwnPropertyDescriptor(options, 'timeoutMs')?.value
  const timeoutMs = configuredTimeout === undefined ? 60_000 : configuredTimeout
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new Error('assistant-evaluation: invalid Super Relay request timeout')
  }
  return (model, environment) => createConfiguredAdapter(model, environment, timeoutMs)
}

/** Default CLI binding retains the production 60-second request deadline. */
export async function createNativeAdapter(model: Readonly<NativeModelConfig>, environment: Readonly<{ ctx: Context; workspace: string }>): Promise<NativeAdapterBinding> {
  return createConfiguredAdapter(model, environment, 60_000)
}

async function createConfiguredAdapter(model: Readonly<NativeModelConfig>, environment: Readonly<{ ctx: Context; workspace: string }>, timeoutMs: number): Promise<NativeAdapterBinding> {
  // 变量 import 避免 evaluation→super-relay-budget 的声明期构建环；真实包由操作者
  // 在跑 run 前安装并经 `dsh-benchmark doctor` 探测，工程层/类型层不依赖其已链接。
  // moduleId 显式宽化为 string，使 tsc 不做字面量模块解析（包尚未链接时不报 TS2307），
  // 运行时形态由上面的 runtime() 结构校验严格把关。
  const moduleId: string = packageName
  const relay = runtime(await import(moduleId))
  validateModel(model)
  assertCurrentContract(relay.SUPER_RELAY_RESPONSES_CONTRACT.expiresAt)
  const frozenModel = Object.freeze({ ...model })
  // 请求时限由可信 Host 在工厂创建前固定；4MiB 响应上限仍取生产默认值。
  // 此处不暴露任何 fetch/now/endpoint/
  // 环境覆写，也绝不接受明文 key，凭证只经 dsh-credentials 按 SUPER_RELAY_API_KEY 引用解析。
  // 其余配置项由生产 normalizeConfig 补默认，enabled 仅在 cordis
  // apply 入口门控、adapter 本身不读取。
  const production = new relay.SuperRelayGoalMeteredAdapter({ defaultMaxTokens: frozenModel.maxOutputTokens, timeoutMs }, {
    credentialResolver: () => environment.ctx.get('credentials' as never) as SuperRelayCredentialResolver | undefined,
  })
  if (!(production instanceof LlmAdapter) || typeof production.shutdown !== 'function') throw new Error('assistant-evaluation: Super Relay adapter runtime is incompatible')
  const adapter = new FrozenSuperRelayAdapter(frozenModel, relay.SUPER_RELAY_RESPONSES_CONTRACT.expiresAt, production)
  let disposed = false
  return Object.freeze({
    adapter,
    inputTokenUpperBound(options: GenerateOptions): number {
      validateRequest(frozenModel, relay.SUPER_RELAY_RESPONSES_CONTRACT.expiresAt, options, disposed)
      return relay.SUPER_RELAY_INPUT_TOKEN_UPPER_BOUND
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      adapter.dispose()
    },
  })
}
