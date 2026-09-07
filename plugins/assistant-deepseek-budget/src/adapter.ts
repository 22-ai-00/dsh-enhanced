import { Service } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, Message, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { normalizeConfig, type DeepSeekGoalMeteredConfig } from './config.js'
import { assertCurrentContract, DEEPSEEK_MODELS, DEEPSEEK_PROVIDER, isDeepSeekModel } from './contract.js'

const ENDPOINT = 'https://api.deepseek.com/chat/completions'
const MAX_TEXT_BYTES = 8 * 1024 * 1024
const MAX_REQUEST_BYTES = 8 * 1024 * 1024
const integer = (value: unknown, maximum = 2_097_152): value is number => Number.isSafeInteger(value) && typeof value === 'number' && value >= 0 && value <= maximum
const object = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`assistant-deepseek-budget: invalid ${label}`)
  return value as Record<string, unknown>
}
const text = (value: unknown, label: string, allowEmpty = true): string => {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) throw new Error(`assistant-deepseek-budget: invalid ${label}`)
  return value
}

export interface DeepSeekFetch {
  (url: string, init: RequestInit): Promise<Response>
}
export interface DeepSeekCredentialResolver { resolve(ref: ReturnType<typeof credentialRef>): Promise<{ value: string } | undefined> }
export interface DeepSeekAdapterDependencies {
  /** Test seam only; production uses the process fetch without patching it. */
  fetch?: DeepSeekFetch
  now?: () => number
  environment?: Readonly<Record<string, string | undefined>>
  /** Look up the current service per request; do not retain replaced credentials. */
  credentialResolver?: () => DeepSeekCredentialResolver | undefined
}

function fail(message: string, code = 'DEEPSEEK_PROTOCOL'): never { throw new LlmError(`DeepSeek response rejected: ${message}`, code) }
function requestError(code: string): never { throw new LlmError('DeepSeek request failed', code) }

/** Race every untrusted async boundary so cancellation does not depend on a service or stream cooperating. */
function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new LlmError('DeepSeek request failed', 'DEEPSEEK_ABORTED')) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void operation.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

function content(blocks: readonly ContentBlock[], role: Message['role']): string {
  let value = ''
  for (const block of blocks) {
    if (block.type !== 'text') throw new Error(`assistant-deepseek-budget: ${role} content must be text-only`)
    value += block.text
  }
  return value
}

function projectMessage(message: Message): Record<string, unknown> {
  if (message.role === 'system') return { role: 'system', content: content(message.content, 'system') }
  if (message.role === 'user') {
    if (message.source.kind === 'tool') {
      if (message.content.length !== 1 || message.content[0]?.type !== 'tool-result' || message.content[0].toolCallId !== message.source.callId) {
        throw new Error('assistant-deepseek-budget: invalid tool result message')
      }
      return { role: 'tool', tool_call_id: message.source.callId, content: content(message.content[0].content, 'user') }
    }
    return { role: 'user', content: content(message.content, 'user') }
  }
  let visible = ''
  let reasoning: string | undefined
  const calls: unknown[] = []
  for (const block of message.content) {
    if (block.type === 'text') visible += block.text
    else if (block.type === 'reasoning') {
      reasoning = (reasoning ?? '') + block.text
    } else if (block.type === 'tool-call') {
      if (!/^[\x20-\x7e]{1,256}$/u.test(block.id) || !/^[A-Za-z0-9_-]{1,64}$/u.test(block.name)) throw new Error('assistant-deepseek-budget: invalid replayed tool call')
      JSON.parse(block.arguments)
      calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } })
    } else throw new Error('assistant-deepseek-budget: unsupported assistant content')
  }
  return { role: 'assistant', content: visible === '' ? null : visible, ...(reasoning === undefined ? {} : { reasoning_content: reasoning }), ...(calls.length === 0 ? {} : { tool_calls: calls }) }
}

function project(options: GenerateOptions, maxTokens: number, reasoningEffort: 'low' | 'high' | 'max'): Record<string, unknown> {
  if (options.system !== undefined) text(options.system, 'system')
  if (options.temperature !== undefined && (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2)) throw new Error('assistant-deepseek-budget: invalid temperature')
  if (options.stop !== undefined && (!Array.isArray(options.stop) || options.stop.length > 16 || options.stop.some(value => typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 1024))) throw new Error('assistant-deepseek-budget: invalid stop')
  if (options.tools !== undefined && options.tools.length > 128) throw new Error('assistant-deepseek-budget: too many tools')
  const tools = options.tools === undefined ? undefined : options.tools.map(tool => {
    if (tool === null || typeof tool !== 'object' || !/^[A-Za-z0-9_-]{1,64}$/u.test(tool.name) || typeof tool.description !== 'string' || tool.parameters === null || typeof tool.parameters !== 'object' || Array.isArray(tool.parameters)) throw new Error('assistant-deepseek-budget: invalid tool schema')
    return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }
  })
  return {
    model: options.model, stream: false, max_tokens: maxTokens, reasoning_effort: reasoningEffort, thinking: { type: 'enabled' },
    messages: [...(options.system === undefined ? [] : [{ role: 'system', content: options.system }]), ...options.messages.map(projectMessage)],
    ...(tools === undefined ? {} : { tools }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.stop === undefined ? {} : { stop: options.stop }),
  }
}

async function boundedJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  if (response.body === null) requestError('DEEPSEEK_EMPTY_RESPONSE')
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0
  try {
    while (true) {
      if (signal.aborted) requestError('DEEPSEEK_ABORTED')
      const next = await bounded(reader.read(), signal); if (next.done) break
      bytes += next.value.byteLength
      if (bytes > maxBytes) requestError('DEEPSEEK_RESPONSE_TOO_LARGE')
      chunks.push(next.value)
    }
  } finally { try { await bounded(reader.cancel(), signal) } catch {} }
  let raw: string
  try { raw = new TextDecoder().decode(Buffer.concat(chunks)) } catch { requestError('DEEPSEEK_INVALID_RESPONSE') }
  try { return JSON.parse(raw) } catch { requestError('DEEPSEEK_INVALID_RESPONSE') }
}

function usage(value: unknown, maxTokens: number): TokenUsage {
  const record = object(value, 'usage'); const prompt = record.prompt_tokens; const completion = record.completion_tokens; const total = record.total_tokens
  if (!integer(prompt) || !integer(completion, maxTokens) || !integer(total) || total !== prompt + completion) fail('usage')
  const hasHit = record.prompt_cache_hit_tokens !== undefined; const hasMiss = record.prompt_cache_miss_tokens !== undefined
  if (hasHit !== hasMiss) fail('incomplete cache usage')
  const hit = record.prompt_cache_hit_tokens === undefined ? 0 : record.prompt_cache_hit_tokens
  const miss = record.prompt_cache_miss_tokens === undefined ? prompt : record.prompt_cache_miss_tokens
  if (!integer(hit, prompt) || !integer(miss, prompt) || hit + miss !== prompt) fail('cache usage')
  const details = record.completion_tokens_details
  let reasoning = 0
  if (details !== undefined) { const d = object(details, 'completion usage details'); const count = d.reasoning_tokens ?? 0; if (!integer(count, completion)) fail('reasoning usage'); reasoning = count }
  return { inputTokens: miss, ...(hit === 0 ? {} : { cacheReadTokens: hit }), outputTokens: completion, totalTokens: total, ...(reasoning === 0 ? {} : { reasoningTokens: reasoning }) }
}

function response(value: unknown, maxTokens: number, requestedModel: string): { blocks: ContentBlock[]; usage: TokenUsage; finish: 'stop' | 'tool-calls' | 'max-tokens'; replay: unknown } {
  const result = object(value, 'response'); const choices = result.choices
  if (result.model !== requestedModel) fail('response model')
  if (!Array.isArray(choices) || choices.length !== 1) fail('choice count')
  const choice = object(choices[0], 'choice'); if (choice.index !== 0) fail('choice index')
  const message = object(choice.message, 'choice message'); const finishReason = choice.finish_reason
  if (message.role !== 'assistant') fail('choice role')
  if (!['stop', 'tool_calls', 'length'].includes(String(finishReason))) fail('finish reason')
  const blocks: ContentBlock[] = []
  if (message.reasoning_content !== undefined && message.reasoning_content !== null) { const value = text(message.reasoning_content, 'reasoning'); if (value !== '') blocks.push({ type: 'reasoning', text: value }) }
  if (message.content !== null && message.content !== undefined) { const value = text(message.content, 'content'); if (value !== '') blocks.push({ type: 'text', text: value }) }
  const calls = message.tool_calls == null ? [] : message.tool_calls
  const incomplete = finishReason === 'length'
  if (!Array.isArray(calls)) fail('tool calls')
  if (calls.length > 0) {
    if (calls.length > 64) fail('tool calls')
    for (const candidate of calls) {
      const call = object(candidate, 'tool call'); const functionValue = object(call.function, 'tool function')
      if (call.type !== 'function') fail('tool call type')
      const id = text(call.id, 'tool id', false); const name = text(functionValue.name, 'tool name', false); const argumentsValue = text(functionValue.arguments, 'tool arguments')
      if (!/^[\x20-\x7e]{1,256}$/u.test(id) || !/^[A-Za-z0-9_-]{1,64}$/u.test(name)) fail('tool call identifiers')
      if (!incomplete) try { JSON.parse(argumentsValue) } catch { fail('tool arguments') }
      blocks.push({ type: 'tool-call', id: ToolCallId(id), name, arguments: argumentsValue })
    }
  }
  const hasCalls = calls.length > 0
  const ids = blocks.filter((block): block is Extract<ContentBlock, { type: 'tool-call' }> => block.type === 'tool-call').map(block => String(block.id))
  if (new Set(ids).size !== ids.length || (finishReason === 'tool_calls' && !hasCalls) || (finishReason === 'stop' && hasCalls)) fail('inconsistent completion')
  if (blocks.length === 0) fail('empty completion', EMPTY_RESPONSE_CODE)
  return { blocks, usage: usage(result.usage, maxTokens), finish: finishReason === 'tool_calls' ? 'tool-calls' : finishReason === 'length' ? 'max-tokens' : 'stop', replay: Object.freeze({ kind: 'deepseek-chat-completions/v1' }) }
}

/** Fixed DeepSeek HTTP adapter. It buffers one bounded JSON completion before emitting any block. */
export class DeepSeekGoalMeteredAdapter extends LlmAdapter {
  readonly #lifecycle = new AbortController()
  readonly #fetch: DeepSeekFetch
  readonly #now: () => number
  readonly #environment: Readonly<Record<string, string | undefined>>
  readonly #resolver: (() => DeepSeekCredentialResolver | undefined) | undefined
  #credentialServiceSeen = false
  #active = true
  constructor(input: DeepSeekGoalMeteredConfig, dependencies: DeepSeekAdapterDependencies = {}) {
    super(); this.config = normalizeConfig(input); this.#fetch = dependencies.fetch ?? fetch; this.#now = dependencies.now ?? Date.now; this.#environment = dependencies.environment ?? process.env; this.#resolver = dependencies.credentialResolver
  }
  readonly config: Readonly<Required<DeepSeekGoalMeteredConfig>>
  shutdown(): void { if (this.#active) { this.#active = false; this.#lifecycle.abort(new Error('assistant-deepseek-budget unloaded')) } }
  override providerInfo(provider: string) { if (provider !== DEEPSEEK_PROVIDER) fail('provider', 'INVALID_PROVIDER'); return { id: DEEPSEEK_PROVIDER, name: 'DeepSeek (goal-metered)' } }
  override providerRetryPolicy(_provider: string) { return { mode: 'normal' as const, maxRetries: 0, retryableCodes: [], initialDelayMs: 500, maxDelayMs: 500, jitterRatio: 0 } }
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> { this.providerInfo(provider); return DEEPSEEK_MODELS.map(id => ({ provider: DEEPSEEK_PROVIDER, id, name: id, inputModalities: ['text'] })) }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    this.providerInfo(provider); if (!isDeepSeekModel(model) || signal?.aborted || !this.#active) fail('model', 'INVALID_MODEL'); assertCurrentContract(this.#now())
    return { provider: DEEPSEEK_PROVIDER, id: model, name: model, inputModalities: ['text'], defaultMaxTokens: this.config.defaultMaxTokens,
      reasoning: { efforts: ['low', 'high', 'max'].map(id => ({ id: ReasoningEffortId(id), name: id })), defaultEffort: ReasoningEffortId('high') } }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const model = options.model
    if (!this.#active || options.provider !== DEEPSEEK_PROVIDER || !isDeepSeekModel(model)) fail('route', 'INVALID_PROVIDER')
    assertCurrentContract(this.#now())
    const maxTokens = options.maxTokens ?? this.config.defaultMaxTokens
    if (!integer(maxTokens, 32_768) || maxTokens < 1) fail('max tokens', 'INVALID_MAX_TOKENS')
    const effort = (options.reasoningEffort === undefined ? 'high' : String(options.reasoningEffort))
    if (!['low', 'high', 'max'].includes(effort)) fail('reasoning effort', 'INVALID_REASONING_EFFORT')
    const signal = options.signal === undefined ? this.#lifecycle.signal : AbortSignal.any([options.signal, this.#lifecycle.signal])
    if (signal.aborted) requestError('DEEPSEEK_ABORTED')
    const timer = AbortSignal.timeout(this.config.timeoutMs); const requestSignal = AbortSignal.any([signal, timer])
    const body = JSON.stringify(project(options, maxTokens, effort as 'low' | 'high' | 'max'))
    if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) requestError('DEEPSEEK_REQUEST_TOO_LARGE')
    let resolver: DeepSeekCredentialResolver | undefined
    let resolved: { value: string } | undefined
    try {
      resolver = this.#resolver?.()
      if (resolver === undefined && this.#credentialServiceSeen) requestError('DEEPSEEK_CREDENTIAL_CHANGED')
      if (resolver !== undefined) this.#credentialServiceSeen = true
      resolved = resolver === undefined ? undefined : await bounded(resolver.resolve(credentialRef(this.config.apiKeyEnv)), requestSignal)
    } catch {
      requestError(requestSignal.aborted ? 'DEEPSEEK_ABORTED' : 'DEEPSEEK_CREDENTIAL')
    }
    if (requestSignal.aborted || !this.#active) requestError('DEEPSEEK_ABORTED')
    assertCurrentContract(this.#now())
    const resolverIdentity = (value: DeepSeekCredentialResolver | undefined): unknown => value === undefined ? undefined : Reflect.get(value, Service.tracker) ?? value
    let sameResolver: boolean
    try { sameResolver = resolverIdentity(this.#resolver?.()) === resolverIdentity(resolver) } catch { requestError('DEEPSEEK_CREDENTIAL') }
    if (!sameResolver) requestError('DEEPSEEK_CREDENTIAL_CHANGED')
    const key = resolver === undefined ? this.#environment[this.config.apiKeyEnv] : resolved?.value
    if (typeof key !== 'string' || key.length === 0) requestError('MISSING_CREDENTIAL')
    let wire: unknown
    try {
      assertCurrentContract(this.#now())
      const init: RequestInit = {
        method: 'POST', redirect: 'error', credentials: 'omit', signal: requestSignal,
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
        body,
      }
      const received = await bounded(this.#fetch(ENDPOINT, init), requestSignal)
      if (!received.ok) { try { await bounded(received.body?.cancel() ?? Promise.resolve(), requestSignal) } catch {}; requestError(`DEEPSEEK_HTTP_${received.status}`) }
      wire = await boundedJson(received, this.config.maxResponseBytes, requestSignal)
    } catch (error) { if (error instanceof LlmError) throw error; requestError(requestSignal.aborted ? 'DEEPSEEK_ABORTED' : 'DEEPSEEK_TRANSPORT') }
    if (signal.aborted || !this.#active) requestError('DEEPSEEK_ABORTED'); assertCurrentContract(this.#now())
    const parsed = response(wire, maxTokens, model)
    const assertLive = (): void => {
      if (requestSignal.aborted || !this.#active) requestError('DEEPSEEK_ABORTED')
      assertCurrentContract(this.#now())
    }
    for (const [index, block] of parsed.blocks.entries()) {
      assertLive(); yield { type: 'block-start', index, blockType: block.type }
      if (block.type === 'text') { assertLive(); yield { type: 'text-delta', index, text: block.text } }
      else if (block.type === 'reasoning') { assertLive(); yield { type: 'reasoning-delta', index, text: block.text } }
      else if (block.type === 'tool-call') { assertLive(); yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments } }
      assertLive(); yield { type: 'block-end', index, block }
    }
    assertLive(); yield { type: 'usage', usage: parsed.usage }
    assertLive(); yield { type: 'finish', reason: { kind: parsed.finish }, replayState: { response: parsed.replay } }
  }
}
