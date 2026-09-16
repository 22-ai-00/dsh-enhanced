import { Service } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, Message, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { normalizeConfig, type SuperRelayGoalMeteredConfig } from './config.js'
import { assertCurrentContract, isSuperRelayModel, SUPER_RELAY_MODELS, SUPER_RELAY_PROVIDER } from './contract.js'

const ENDPOINT = 'https://super-relay.byted.org/v1/responses'
const MAX_TEXT_BYTES = 8 * 1024 * 1024
const MAX_REQUEST_BYTES = 8 * 1024 * 1024
const integer = (value: unknown, maximum = 2_097_152): value is number => Number.isSafeInteger(value) && typeof value === 'number' && value >= 0 && value <= maximum
const object = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`assistant-super-relay-budget: invalid ${label}`)
  return value as Record<string, unknown>
}
const text = (value: unknown, label: string, allowEmpty = true): string => {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) throw new Error(`assistant-super-relay-budget: invalid ${label}`)
  return value
}

export interface SuperRelayFetch {
  (url: string, init: RequestInit): Promise<Response>
}
export interface SuperRelayCredentialResolver { resolve(ref: ReturnType<typeof credentialRef>): Promise<{ value: string } | undefined> }
export interface SuperRelayAdapterDependencies {
  /** Test seam only; production uses the process fetch without patching it. */
  fetch?: SuperRelayFetch
  now?: () => number
  environment?: Readonly<Record<string, string | undefined>>
  /** Look up the current service per request; do not retain replaced credentials. */
  credentialResolver?: () => SuperRelayCredentialResolver | undefined
}

function fail(message: string, code = 'SUPER_RELAY_PROTOCOL'): never { throw new LlmError(`Super Relay response rejected: ${message}`, code) }
function requestError(code: string): never { throw new LlmError('Super Relay request failed', code) }

/** Race every untrusted async boundary so cancellation does not depend on a service or stream cooperating. */
function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new LlmError('Super Relay request failed', 'SUPER_RELAY_ABORTED')) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void operation.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

function textOnly(blocks: readonly ContentBlock[], role: string): string {
  let value = ''
  for (const block of blocks) {
    if (block.type !== 'text') throw new Error(`assistant-super-relay-budget: ${role} content must be text-only`)
    value += block.text
  }
  return value
}

/**
 * Project one DSH Message to OpenAI Responses `input` items. System text is
 * carried by the top-level `instructions` field, so a system-role Message here
 * is rejected rather than silently moved.
 */
function projectMessage(message: Message): unknown[] {
  if (message.role === 'system') throw new Error('assistant-super-relay-budget: system prompt must be supplied as instructions')
  if (message.role === 'user') {
    if (message.source.kind === 'tool') {
      if (message.content.length !== 1 || message.content[0]?.type !== 'tool-result' || message.content[0].toolCallId !== message.source.callId) {
        throw new Error('assistant-super-relay-budget: invalid tool result message')
      }
      return [{ type: 'function_call_output', call_id: message.source.callId, output: textOnly(message.content[0].content, 'tool result') }]
    }
    return [{ role: 'user', content: [{ type: 'input_text', text: textOnly(message.content, 'user') }] }]
  }
  // Assistant turn: visible text becomes one message item; each replayed tool
  // call becomes its own function_call item. Reasoning blocks are not replayed:
  // the gateway owns reasoning and the input contract was verified without it.
  const items: unknown[] = []
  let visible = ''
  for (const block of message.content) {
    if (block.type === 'text') visible += block.text
    else if (block.type === 'reasoning') continue
    else if (block.type === 'tool-call') {
      if (!/^[\x20-\x7e]{1,256}$/u.test(block.id) || !/^[A-Za-z0-9_-]{1,64}$/u.test(block.name)) throw new Error('assistant-super-relay-budget: invalid replayed tool call')
      JSON.parse(block.arguments)
      items.push({ type: 'function_call', call_id: String(block.id), name: block.name, arguments: block.arguments })
    } else throw new Error('assistant-super-relay-budget: unsupported assistant content')
  }
  if (visible !== '') items.unshift({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: visible }] })
  return items
}

function project(options: GenerateOptions, maxTokens: number): Record<string, unknown> {
  if (options.system !== undefined) text(options.system, 'instructions')
  if (options.temperature !== undefined && (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2)) throw new Error('assistant-super-relay-budget: invalid temperature')
  // The Responses route has no stop-sequence parameter and was verified without
  // a reasoning-effort override; reject both rather than change generation silently.
  if (options.stop !== undefined) throw new Error('assistant-super-relay-budget: stop sequences are unsupported')
  if (options.reasoningEffort !== undefined) throw new Error('assistant-super-relay-budget: reasoning effort override is unsupported')
  if (options.tools !== undefined && options.tools.length > 128) throw new Error('assistant-super-relay-budget: too many tools')
  const tools = options.tools === undefined ? undefined : options.tools.map(tool => {
    if (tool === null || typeof tool !== 'object' || !/^[A-Za-z0-9_-]{1,64}$/u.test(tool.name) || typeof tool.description !== 'string' || tool.parameters === null || typeof tool.parameters !== 'object' || Array.isArray(tool.parameters)) throw new Error('assistant-super-relay-budget: invalid tool schema')
    return { type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters }
  })
  return {
    model: options.model, stream: false, max_output_tokens: maxTokens,
    ...(options.system === undefined ? {} : { instructions: options.system }),
    input: options.messages.flatMap(projectMessage),
    ...(tools === undefined ? {} : { tools }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
  }
}

async function boundedJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  if (response.body === null) requestError('SUPER_RELAY_EMPTY_RESPONSE')
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0
  try {
    while (true) {
      if (signal.aborted) requestError('SUPER_RELAY_ABORTED')
      const next = await bounded(reader.read(), signal); if (next.done) break
      bytes += next.value.byteLength
      if (bytes > maxBytes) requestError('SUPER_RELAY_RESPONSE_TOO_LARGE')
      chunks.push(next.value)
    }
  } finally { try { await bounded(reader.cancel(), signal) } catch {} }
  let raw: string
  try { raw = new TextDecoder().decode(Buffer.concat(chunks)) } catch { requestError('SUPER_RELAY_INVALID_RESPONSE') }
  try { return JSON.parse(raw) } catch { requestError('SUPER_RELAY_INVALID_RESPONSE') }
}

function usage(value: unknown, maxTokens: number): TokenUsage {
  const record = object(value, 'usage')
  const input = record.input_tokens; const output = record.output_tokens; const total = record.total_tokens
  if (!integer(input) || !integer(output, maxTokens) || !integer(total) || total !== input + output) fail('usage')
  let cached = 0
  if (record.input_tokens_details !== undefined) {
    const details = object(record.input_tokens_details, 'input usage details')
    if (details.cached_tokens !== undefined) { if (!integer(details.cached_tokens, input)) fail('cached usage'); cached = details.cached_tokens }
  }
  let reasoning = 0
  if (record.output_tokens_details !== undefined) {
    const details = object(record.output_tokens_details, 'output usage details')
    if (details.reasoning_tokens !== undefined) { if (!integer(details.reasoning_tokens, output)) fail('reasoning usage'); reasoning = details.reasoning_tokens }
  }
  // Responses input_tokens already includes the cached portion; DSH reports the
  // disjoint uncached component plus a separate cache-read count.
  return { inputTokens: input - cached, ...(cached === 0 ? {} : { cacheReadTokens: cached }),
    outputTokens: output, totalTokens: total, ...(reasoning === 0 ? {} : { reasoningTokens: reasoning }) }
}

function response(value: unknown, maxTokens: number, requestedModel: string): { blocks: ContentBlock[]; usage: TokenUsage; finish: 'stop' | 'tool-calls' | 'max-tokens'; replay: unknown } {
  const result = object(value, 'response')
  if (result.model !== requestedModel) fail('response model')
  const status = result.status
  if (status !== 'completed' && status !== 'incomplete') fail('status')
  let truncated = false
  if (status === 'incomplete') {
    const details = result.incomplete_details
    if (details === null || typeof details !== 'object' || (details as Record<string, unknown>).reason !== 'max_output_tokens') fail('incomplete reason')
    truncated = true
  } else if (result.incomplete_details !== null && result.incomplete_details !== undefined) {
    fail('incomplete details')
  }
  if (!Array.isArray(result.output)) fail('output items')
  if (result.output.length > 128) fail('output items')
  const blocks: ContentBlock[] = []
  let hasCalls = false
  for (const candidate of result.output) {
    const item = object(candidate, 'output item')
    const kind = item.type
    if (kind === 'reasoning') {
      const parts = item.content
      if (!Array.isArray(parts)) fail('reasoning content')
      let value = ''
      for (const part of parts) { const p = object(part, 'reasoning part'); if (p.type !== 'reasoning_text') fail('reasoning part type'); value += text(p.text, 'reasoning text') }
      if (value !== '') blocks.push({ type: 'reasoning', text: value })
    } else if (kind === 'message') {
      if (item.role !== 'assistant') fail('message role')
      const parts = item.content
      if (!Array.isArray(parts)) fail('message content')
      for (const part of parts) { const p = object(part, 'message part'); if (p.type !== 'output_text') fail('message part type'); const value = text(p.text, 'output text'); if (value !== '') blocks.push({ type: 'text', text: value }) }
    } else if (kind === 'function_call') {
      hasCalls = true
      const id = text(item.call_id, 'tool id', false); const name = text(item.name, 'tool name', false); const argumentsValue = text(item.arguments, 'tool arguments')
      if (!/^[\x20-\x7e]{1,256}$/u.test(id) || !/^[A-Za-z0-9_-]{1,64}$/u.test(name)) fail('tool call identifiers')
      if (!truncated) try { JSON.parse(argumentsValue) } catch { fail('tool arguments') }
      blocks.push({ type: 'tool-call', id: ToolCallId(id), name, arguments: argumentsValue })
    } else {
      fail('output item type')
    }
  }
  const ids = blocks.filter((block): block is Extract<ContentBlock, { type: 'tool-call' }> => block.type === 'tool-call').map(block => String(block.id))
  if (new Set(ids).size !== ids.length) fail('duplicate tool call ids')
  const finish: 'stop' | 'tool-calls' | 'max-tokens' = truncated ? 'max-tokens' : hasCalls ? 'tool-calls' : 'stop'
  if (finish === 'stop' && hasCalls) fail('inconsistent completion')
  if (blocks.length === 0) fail('empty completion', EMPTY_RESPONSE_CODE)
  return { blocks, usage: usage(result.usage, maxTokens), finish, replay: Object.freeze({ kind: 'super-relay-responses/v1' }) }
}

/** Fixed Super Relay Responses adapter. It buffers one bounded JSON response before emitting any block. */
export class SuperRelayGoalMeteredAdapter extends LlmAdapter {
  readonly #lifecycle = new AbortController()
  readonly #fetch: SuperRelayFetch
  readonly #now: () => number
  readonly #environment: Readonly<Record<string, string | undefined>>
  readonly #resolver: (() => SuperRelayCredentialResolver | undefined) | undefined
  #credentialServiceSeen = false
  #active = true
  constructor(input: SuperRelayGoalMeteredConfig, dependencies: SuperRelayAdapterDependencies = {}) {
    super(); this.config = normalizeConfig(input); this.#fetch = dependencies.fetch ?? fetch; this.#now = dependencies.now ?? Date.now; this.#environment = dependencies.environment ?? process.env; this.#resolver = dependencies.credentialResolver
  }
  readonly config: Readonly<Required<SuperRelayGoalMeteredConfig>>
  shutdown(): void { if (this.#active) { this.#active = false; this.#lifecycle.abort(new Error('assistant-super-relay-budget unloaded')) } }
  override providerInfo(provider: string) { if (provider !== SUPER_RELAY_PROVIDER) fail('provider', 'INVALID_PROVIDER'); return { id: SUPER_RELAY_PROVIDER, name: 'Super Relay (goal-metered)' } }
  override providerRetryPolicy(_provider: string) { return { mode: 'normal' as const, maxRetries: 0, retryableCodes: [], initialDelayMs: 500, maxDelayMs: 500, jitterRatio: 0 } }
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> { this.providerInfo(provider); return SUPER_RELAY_MODELS.map(id => ({ provider: SUPER_RELAY_PROVIDER, id, name: id, inputModalities: ['text'] })) }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    this.providerInfo(provider); if (!isSuperRelayModel(model) || signal?.aborted || !this.#active) fail('model', 'INVALID_MODEL'); assertCurrentContract(this.#now())
    // No reasoning-effort menu is advertised: the gateway model reasons by default and the
    // adapter rejects an effort override, keeping the wire identical to the verified probes.
    return { provider: SUPER_RELAY_PROVIDER, id: model, name: model, inputModalities: ['text'], defaultMaxTokens: this.config.defaultMaxTokens }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const model = options.model
    if (!this.#active || options.provider !== SUPER_RELAY_PROVIDER || !isSuperRelayModel(model)) fail('route', 'INVALID_PROVIDER')
    assertCurrentContract(this.#now())
    const maxTokens = options.maxTokens ?? this.config.defaultMaxTokens
    if (!integer(maxTokens, 32_768) || maxTokens < 1) fail('max tokens', 'INVALID_MAX_TOKENS')
    const signal = options.signal === undefined ? this.#lifecycle.signal : AbortSignal.any([options.signal, this.#lifecycle.signal])
    if (signal.aborted) requestError('SUPER_RELAY_ABORTED')
    const timer = AbortSignal.timeout(this.config.timeoutMs); const requestSignal = AbortSignal.any([signal, timer])
    const body = JSON.stringify(project(options, maxTokens))
    if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) requestError('SUPER_RELAY_REQUEST_TOO_LARGE')
    let resolver: SuperRelayCredentialResolver | undefined
    let resolved: { value: string } | undefined
    try {
      resolver = this.#resolver?.()
      if (resolver === undefined && this.#credentialServiceSeen) requestError('SUPER_RELAY_CREDENTIAL_CHANGED')
      if (resolver !== undefined) this.#credentialServiceSeen = true
      resolved = resolver === undefined ? undefined : await bounded(resolver.resolve(credentialRef(this.config.apiKeyEnv)), requestSignal)
    } catch {
      requestError(requestSignal.aborted ? 'SUPER_RELAY_ABORTED' : 'SUPER_RELAY_CREDENTIAL')
    }
    if (requestSignal.aborted || !this.#active) requestError('SUPER_RELAY_ABORTED')
    assertCurrentContract(this.#now())
    const resolverIdentity = (value: SuperRelayCredentialResolver | undefined): unknown => value === undefined ? undefined : Reflect.get(value, Service.tracker) ?? value
    let sameResolver: boolean
    try { sameResolver = resolverIdentity(this.#resolver?.()) === resolverIdentity(resolver) } catch { requestError('SUPER_RELAY_CREDENTIAL') }
    if (!sameResolver) requestError('SUPER_RELAY_CREDENTIAL_CHANGED')
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
      if (!received.ok) { try { await bounded(received.body?.cancel() ?? Promise.resolve(), requestSignal) } catch {}; requestError(`SUPER_RELAY_HTTP_${received.status}`) }
      wire = await boundedJson(received, this.config.maxResponseBytes, requestSignal)
    } catch (error) { if (error instanceof LlmError) throw error; requestError(requestSignal.aborted ? 'SUPER_RELAY_ABORTED' : 'SUPER_RELAY_TRANSPORT') }
    if (signal.aborted || !this.#active) requestError('SUPER_RELAY_ABORTED'); assertCurrentContract(this.#now())
    const parsed = response(wire, maxTokens, model)
    const assertLive = (): void => {
      if (requestSignal.aborted || !this.#active) requestError('SUPER_RELAY_ABORTED')
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
