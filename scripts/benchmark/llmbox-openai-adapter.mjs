// Operator-selected adapter for public development benchmarks; never loaded by a candidate.
// One fixed route (llmgw-default / deepseek-v4.1-flash) over an OpenAI-compatible
// streaming chat/completions endpoint. Endpoint and key come only from the environment:
//   DSH_BENCH_LLMBOX_BASE_URL   base URL ending before /chat/completions (http/https)
//   LLMGW_API_KEY               bearer key, never logged or traced
//   DSH_BENCH_LLMBOX_CALL_LEDGER  file appended once per outbound request (required)
//   DSH_BENCH_LLMBOX_MAX_CALLS    hard cap on ledger lines across processes (required, 1..1000)
//   DSH_BENCHMARK_TRACE         optional NDJSON trace of public inputs/outputs (no credentials)
// adapterDigest and tokenCounterDigest in the benchmark config are both the SHA-256 of this file.
import { appendFileSync, closeSync, openSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { LlmAdapter, LlmError, assertUsableApiKey, attributionHeaders, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'

export const LLMBOX_PROVIDER = 'llmgw-default'
export const LLMBOX_MODEL = 'deepseek-v4.1-flash'
const PACKAGE = 'llmbox-openai-adapter'
const TIMEOUT_MS = 110_000

function endpoint(env) {
  const raw = env.DSH_BENCH_LLMBOX_BASE_URL
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error('DSH_BENCH_LLMBOX_BASE_URL is required')
  let url
  try { url = new URL(raw.trim()) } catch { throw new Error('DSH_BENCH_LLMBOX_BASE_URL is not a valid URL') }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) throw new Error('DSH_BENCH_LLMBOX_BASE_URL must be a plain http(s) base URL')
  return `${url.href.replace(/\/+$/u, '')}/chat/completions`
}

function callGuard(env) {
  const ledger = env.DSH_BENCH_LLMBOX_CALL_LEDGER
  const max = Number(env.DSH_BENCH_LLMBOX_MAX_CALLS)
  if (typeof ledger !== 'string' || !ledger.startsWith('/')) throw new Error('DSH_BENCH_LLMBOX_CALL_LEDGER must be an absolute path')
  if (!Number.isSafeInteger(max) || max < 1 || max > 1000) throw new Error('DSH_BENCH_LLMBOX_MAX_CALLS must be an integer in 1..1000')
  return () => {
    // Count before sending: a refused call is never sent; a sent call is always counted.
    closeSync(openSync(ledger, 'a', 0o600))
    const used = readFileSync(ledger, 'utf8').split('\n').filter(line => line !== '').length
    if (used >= max) throw new LlmError(`LLMBox call cap reached (${used}/${max})`, 'CALL_CAP')
    appendFileSync(ledger, `${JSON.stringify({ n: used + 1, at: new Date().toISOString() })}\n`, { mode: 0o600 })
    return used + 1
  }
}

function text(content, role) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) throw new LlmError(`unsupported ${role} content`, 'UNSUPPORTED_CONTENT')
  return content.map(block => {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text
    if (block?.type === 'reasoning') return ''
    throw new LlmError(`unsupported ${role} content block ${String(block?.type)}`, 'UNSUPPORTED_CONTENT')
  }).join('')
}

/** Text-only projection; tools, images and tool results fail closed. */
export function openAiMessages(options) {
  const out = []
  if (options.system !== undefined) out.push({ role: 'system', content: options.system })
  for (const message of options.messages) {
    if (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant') throw new LlmError(`unsupported message role ${String(message.role)}`, 'UNSUPPORTED_CONTENT')
    out.push({ role: message.role, content: text(message.content, message.role) })
  }
  return out
}

function code(status) {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'SERVER'
  return 'HTTP'
}

/** OpenAI usage → DSH disjoint usage (cached prompt tokens split out). */
export function dshUsage(usage) {
  const prompt = usage?.prompt_tokens; const completion = usage?.completion_tokens
  if (!Number.isSafeInteger(prompt) || !Number.isSafeInteger(completion) || prompt < 0 || completion < 0) return undefined
  const cachedRaw = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0
  const cached = Number.isSafeInteger(cachedRaw) && cachedRaw >= 0 && cachedRaw <= prompt ? cachedRaw : 0
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  const result = { inputTokens: prompt - cached, outputTokens: completion }
  if (cached > 0) result.cacheReadTokens = cached
  if (Number.isSafeInteger(reasoning) && reasoning > 0 && reasoning <= completion) result.reasoningTokens = reasoning
  if (usage.total_tokens === prompt + completion) result.totalTokens = prompt + completion
  return result
}

async function* sseData(body, signal) {
  const decoder = new TextDecoder(); let buffer = ''
  for await (const bytes of body) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    buffer += decoder.decode(bytes, { stream: true })
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/u, ''); buffer = buffer.slice(newline + 1)
      if (line.startsWith('data:')) yield line.slice(5).trim()
    }
  }
  const tail = buffer.trim()
  if (tail.startsWith('data:')) yield tail.slice(5).trim()
}

export class LlmboxOpenAiAdapter extends LlmAdapter {
  #url; #key; #guard; #fetch; #env
  constructor({ env = process.env, fetch: fetchImpl = globalThis.fetch } = {}) {
    super()
    this.#env = env
    this.#url = endpoint(env)
    this.#key = assertUsableApiKey(env.LLMGW_API_KEY ?? '', PACKAGE, 'env:LLMGW_API_KEY')
    this.#guard = callGuard(env)
    this.#fetch = fetchImpl
  }
  providerInfo(provider) {
    if (provider !== LLMBOX_PROVIDER) throw new LlmError(`unknown provider ${provider}`, 'NO_ADAPTER')
    return { id: LLMBOX_PROVIDER, name: 'LLMBox gateway (OpenAI-compatible)' }
  }
  // The benchmark counts every outbound request; provider-side retries are disabled.
  providerRetryPolicy() { return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, PACKAGE) }
  async listModels(provider) {
    this.providerInfo(provider)
    return [{ provider: LLMBOX_PROVIDER, id: LLMBOX_MODEL, name: LLMBOX_MODEL, inputModalities: ['text'] }]
  }
  async resolveModel(provider, model) {
    this.providerInfo(provider)
    if (model !== LLMBOX_MODEL) throw new LlmError(`unknown model ${model}`, 'NO_MODEL')
    return { provider: LLMBOX_PROVIDER, id: LLMBOX_MODEL, name: LLMBOX_MODEL, inputModalities: ['text'] }
  }
  async *stream(options) {
    if (options.provider !== LLMBOX_PROVIDER || options.model !== LLMBOX_MODEL) throw new LlmError('LLMBox adapter serves only llmgw-default/deepseek-v4.1-flash', 'NO_MODEL')
    if ((options.tools?.length ?? 0) !== 0) throw new LlmError('LLMBox benchmark adapter does not send tools', 'UNSUPPORTED_CONTENT')
    const messages = openAiMessages(options)
    const body = { model: LLMBOX_MODEL, messages, stream: true, stream_options: { include_usage: true } }
    if (options.temperature !== undefined) body.temperature = options.temperature
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
    if (options.stop?.length) body.stop = options.stop
    const callNumber = this.#guard()
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS)
    let output = ''; let reasoningText = ''; let usage; let finish; let status
    try {
      const response = await this.#fetch(this.#url, {
        method: 'POST', signal, body: JSON.stringify(body),
        headers: { ...attributionHeaders(), 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${this.#key}` },
      })
      status = response.status
      if (!response.ok || !response.body) {
        await response.body?.cancel?.().catch(() => {})
        throw new LlmError(`LLMBox request failed with HTTP ${response.status}`, code(response.status), { status: response.status })
      }
      let reasoningOpen = false; let textOpen = false; let index = -1; let textIndex = -1; let reasoningIndex = -1; let native
      for await (const data of sseData(response.body, signal)) {
        if (data === '') continue
        if (data === '[DONE]') break
        let event
        try { event = JSON.parse(data) } catch { throw new LlmError('LLMBox stream returned invalid JSON', 'PROTOCOL') }
        if (event.error) throw new LlmError('LLMBox stream reported an error', 'PROVIDER')
        if (event.usage) usage = dshUsage(event.usage) ?? usage
        const choice = event.choices?.[0]
        if (!choice) continue
        const delta = choice.delta ?? {}
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) throw new LlmError('LLMBox returned an unexpected tool call', 'PROTOCOL')
        const thought = delta.reasoning_content ?? delta.reasoning
        if (typeof thought === 'string' && thought !== '') {
          if (textOpen) throw new LlmError('LLMBox interleaved reasoning after text', 'PROTOCOL')
          if (!reasoningOpen) { reasoningOpen = true; reasoningIndex = ++index; yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' } }
          reasoningText += thought
          yield { type: 'reasoning-delta', index: reasoningIndex, text: thought }
        }
        if (typeof delta.content === 'string' && delta.content !== '') {
          if (reasoningOpen) { reasoningOpen = false; yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningText } } }
          if (!textOpen) { textOpen = true; textIndex = ++index; yield { type: 'block-start', index: textIndex, blockType: 'text' } }
          output += delta.content
          yield { type: 'text-delta', index: textIndex, text: delta.content }
        }
        if (typeof choice.finish_reason === 'string') native = choice.finish_reason
      }
      if (reasoningOpen) yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningText } }
      if (textOpen) yield { type: 'block-end', index: textIndex, block: { type: 'text', text: output } }
      if (native === undefined) throw new LlmError('LLMBox stream ended without finish_reason', 'PROTOCOL')
      if (native !== 'stop' && native !== 'length') throw new LlmError(`LLMBox finish_reason ${native} is not supported`, 'PROTOCOL')
      if (usage === undefined) throw new LlmError('LLMBox stream ended without usage', 'PROTOCOL')
      yield { type: 'usage', usage }
      finish = native === 'length' ? 'max-tokens' : 'stop'
      yield { type: 'finish', reason: { kind: finish } }
    } finally {
      const tracePath = this.#env.DSH_BENCHMARK_TRACE
      // Opt-in operator trace: public benchmark inputs/output only, never the URL or key.
      if (tracePath) appendFileSync(tracePath, `${JSON.stringify({
        call: callNumber, sessionId: options.sessionId, model: options.model, status,
        inputSha256: createHash('sha256').update(JSON.stringify(messages)).digest('hex'),
        input: messages, output, reasoningChars: reasoningText.length, usage, finish: finish ?? 'error',
      })}\n`, { mode: 0o600 })
    }
  }
}

export function createNativeAdapter(model, { ctx: _ctx, workspace: _workspace } = {}, overrides = {}) {
  if (model.provider !== LLMBOX_PROVIDER || model.model !== LLMBOX_MODEL) throw new Error('LLMBox benchmark adapter accepts only llmgw-default/deepseek-v4.1-flash')
  if (model.inputLimitMode !== 'estimate' || model.inputUsdMicrosPerMillionTokens !== null || model.outputUsdMicrosPerMillionTokens !== null
    || (model.cacheReadUsdMicrosPerMillionTokens ?? null) !== null || (model.cacheWriteUsdMicrosPerMillionTokens ?? null) !== null) {
    throw new Error('LLMBox benchmark requires inputLimitMode "estimate" and null tariffs')
  }
  const adapter = new LlmboxOpenAiAdapter(overrides)
  return {
    adapter,
    // Deliberately an estimate. This is neither a tokenizer nor a guaranteed upper bound.
    inputTokenEstimate: options => Math.ceil(Buffer.byteLength(JSON.stringify({
      system: options.system, messages: options.messages, tools: options.tools,
    }), 'utf8') / 2) + 2_048,
    dispose: () => {},
  }
}
