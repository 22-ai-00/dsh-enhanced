/**
 * 工程层测试（非真实外部证据）：
 * super-relay-budget 包尚未在本评测安装目录链接，这里用 vitest virtual mock 拦截
 * `@dsh-enhanced/assistant-super-relay-budget` 动态 import，注入一个最小生产 adapter
 * 替身（不触网）。它只验证 evaluation host binding 的接线：runtime 结构校验、模型/
 * 路由冻结、契约过期、dispose、凭证逐请求解析。真实 Responses 协议与 usage 解析由
 * assistant-super-relay-budget 自身的测试覆盖，真实供应商结论只认 Docker + 真 endpoint。
 */
import { Context } from '@deepseek-ai/cordis'
import { createMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'

// mock factory 被提升到 import 之前，凡其引用的外部绑定都必须放进 vi.hoisted，
// 否则在提升期触发 TDZ。这里同时承载跨作用域的凭证 resolver 观察点。
const hoisted = vi.hoisted(() => ({
  provider: 'super-relay',
  model: 'auto_model/alwaysday1',
  expires: '2026-10-14T00:00:00.000Z',
  lastCredentialResolver: undefined as ((() => unknown) | undefined),
}))
const PROVIDER = hoisted.provider
const MODEL = hoisted.model
const EXPIRES = hoisted.expires
const digest = 'a'.repeat(64)

vi.mock('@dsh-enhanced/assistant-super-relay-budget', async () => {
  // factory 在本文件 import 绑定初始化前执行，dsh-llm 必须在 factory 内动态取，
  // 否则会在提升期撞到未初始化的 import 绑定。
  const { LlmAdapter } = await import('@deepseek-ai/dsh-llm')
  // 生产 adapter 必须是 LlmAdapter 实例（createNativeAdapter 有 instanceof 断言）。
  class FakeProduction extends LlmAdapter {
    constructor(_config: unknown, deps: { credentialResolver(): unknown }) {
      super()
      hoisted.lastCredentialResolver = deps.credentialResolver
    }
    override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
      yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } }
      yield { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { kind: 'super-relay-responses/v1' } } }
    }
    override providerInfo() { return { id: hoisted.provider, name: 'Super Relay (goal-metered)' } }
    override providerRetryPolicy() {
      return { mode: 'normal' as const, maxRetries: 0, retryableCodes: [], initialDelayMs: 500, maxDelayMs: 500, jitterRatio: 0 }
    }
    override async listModels() {
      return [{ provider: hoisted.provider, id: hoisted.model, name: hoisted.model, inputModalities: ['text'] as const }]
    }
    override async resolveModel(_p: string, m: string) {
      return { provider: hoisted.provider, id: m, name: m, inputModalities: ['text'] as const }
    }
    shutdown(): void { /* fake：无连接需关闭 */ }
  }
  return {
    SuperRelayGoalMeteredAdapter: FakeProduction,
    SUPER_RELAY_PROVIDER: hoisted.provider,
    SUPER_RELAY_MODELS: [hoisted.model],
    SUPER_RELAY_INPUT_TOKEN_UPPER_BOUND: 200_000,
    SUPER_RELAY_RESPONSES_CONTRACT: { id: 'super-relay-responses-2026-09-14', expiresAt: hoisted.expires },
  }
})

import { createNativeAdapter } from '../../src/benchmark/super-relay.js'
import type { NativeModelConfig } from '../../src/benchmark/native.js'

const model = (): NativeModelConfig => ({
  provider: PROVIDER,
  model: MODEL,
  temperature: null,
  inputLimitMode: 'upper-bound',
  outputLimitMode: 'provider',
  maxOutputTokens: 4096,
  inputUsdMicrosPerMillionTokens: null,
  outputUsdMicrosPerMillionTokens: null,
  adapterDigest: digest,
  tokenCounterDigest: digest,
})

const request = (input = model()): GenerateOptions => ({
  provider: input.provider,
  model: input.model,
  maxTokens: input.maxOutputTokens,
  messages: [createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })],
})

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

afterEach(() => { vi.restoreAllMocks() })

describe('Super Relay native benchmark adapter（工程层替身，非真实供应商证据）', () => {
  it('冻结固定路由并把真实 usage 透传、输入上界为 200000', async () => {
    const binding = await createNativeAdapter(model(), { ctx: new Context(), workspace: '/unused' })
    const chunks = await collect(binding.adapter.stream(request()))
    expect(chunks.find(c => c.type === 'usage')).toMatchObject({ usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } })
    expect(binding.inputTokenUpperBound?.(request())).toBe(200_000)
    expect(binding.adapter.providerRetryPolicy(PROVIDER)).toMatchObject({ maxRetries: 0 })
    await expect(binding.adapter.listModels(PROVIDER)).resolves.toMatchObject([{ id: MODEL }])
    await expect(binding.adapter.resolveModel(PROVIDER, MODEL)).resolves.toMatchObject({ id: MODEL })
    binding.dispose()
  })

  it('生产 adapter 收到的 credentialResolver 在调用时回连当前 ctx 的 credentials 服务', async () => {
    const ctx = new Context()
    const credentials = { async resolve() { return { value: 'test-only-key' } } }
    ctx.provide('credentials' as never, credentials as never)
    await createNativeAdapter(model(), { ctx, workspace: '/unused' })
    expect(typeof hoisted.lastCredentialResolver).toBe('function')
    // binding 注入的 resolver 不提前快照凭证，每次调用都从当前 ctx 取服务。
    expect(hoisted.lastCredentialResolver!()).toBe(credentials)
  })

  it.each([
    (input: NativeModelConfig) => { input.provider = 'other' },
    (input: NativeModelConfig) => { input.model = 'unknown-model' },
    (input: NativeModelConfig) => { input.inputLimitMode = 'estimate' },
    (input: NativeModelConfig) => { input.outputLimitMode = 'observed' },
    (input: NativeModelConfig) => { input.temperature = 3 },
    (input: NativeModelConfig) => { input.maxOutputTokens = 32_769 },
    (input: NativeModelConfig) => { input.inputUsdMicrosPerMillionTokens = 1 },
    (input: NativeModelConfig) => { input.outputUsdMicrosPerMillionTokens = 1 },
    (input: NativeModelConfig) => { input.cacheReadUsdMicrosPerMillionTokens = 1 },
    (input: NativeModelConfig) => { input.cacheWriteUsdMicrosPerMillionTokens = 1 },
  ])('拒绝固定无价路由之外的模型配置', async mutate => {
    const input = model(); mutate(input)
    await expect(createNativeAdapter(input, { ctx: new Context(), workspace: '/unused' })).rejects.toThrow()
  })

  it('派发前拒绝 provider/model/maxTokens/temperature 漂移', async () => {
    const input = model(); input.temperature = 0
    const binding = await createNativeAdapter(input, { ctx: new Context(), workspace: '/unused' })
    for (const mutate of [
      (o: GenerateOptions) => { o.provider = 'other' },
      (o: GenerateOptions) => { o.model = 'other-model' },
      (o: GenerateOptions) => { o.maxTokens = 4095 },
      (o: GenerateOptions) => { o.temperature = 1 },
    ]) {
      const options = { ...request(input), temperature: 0 }
      mutate(options)
      await expect(collect(binding.adapter.stream(options))).rejects.toThrow('request drift')
      expect(() => binding.inputTokenUpperBound?.(options)).toThrow('request drift')
    }
    binding.dispose()
  })

  it('契约过期拒绝创建；dispose 幂等且拒绝后续请求', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(EXPIRES))
    await expect(createNativeAdapter(model(), { ctx: new Context(), workspace: '/unused' })).rejects.toThrow('contract has expired')
    vi.restoreAllMocks()
    const binding = await createNativeAdapter(model(), { ctx: new Context(), workspace: '/unused' })
    binding.dispose(); binding.dispose()
    await expect(collect(binding.adapter.stream(request()))).rejects.toThrow('disposed')
    expect(() => binding.inputTokenUpperBound?.(request())).toThrow('disposed')
  })
})
