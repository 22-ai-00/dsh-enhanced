import { readFileSync } from 'node:fs'
import { createMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { DeepSeekGoalMeteredAdapter } from '../src/adapter.ts'
import { Config } from '../src/config.ts'
import { DEEPSEEK_INPUT_TOKEN_UPPER_BOUND, DEEPSEEK_PROVIDER, name, version } from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}

describe('dsh-enhanced-assistant-deepseek-budget', () => {
  it('exposes stable plugin identity', () => {
    expect(name).toBe('dsh-enhanced-assistant-deepseek-budget')
    expect(version).toBe(manifest.version)
  })

  it('projects a bounded, credential-backed text and tool completion only after validating usage', async () => {
    const fetch = async (_url: string, init: RequestInit) => {
      expect(_url).toBe('https://api.deepseek.com/chat/completions')
      expect(init.redirect).toBe('error')
      expect(init.headers).toMatchObject({ authorization: 'Bearer test-key' })
      expect(JSON.parse(String(init.body))).toMatchObject({ model: 'deepseek-v4-flash', stream: false, max_tokens: 9 })
      return new Response(JSON.stringify({ model: 'deepseek-v4-flash', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: 'working', reasoning_content: 'because', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'inspect', arguments: '{"x":1}' } }] } }], usage: { prompt_tokens: 8, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 5, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 2 }, total_tokens: 15 } }), { status: 200 })
    }
    const adapter = new DeepSeekGoalMeteredAdapter(Config(), { fetch, environment: { DEEPSEEK_API_KEY: 'test-key' } })
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({ provider: DEEPSEEK_PROVIDER, model: 'deepseek-v4-flash', maxTokens: 9,
      messages: [createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })], tools: [{ name: 'inspect', description: 'inspect', parameters: { type: 'object' } }] })) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(chunks.find(chunk => chunk.type === 'usage')).toMatchObject({ usage: { inputTokens: 5, cacheReadTokens: 3, outputTokens: 7, reasoningTokens: 2, totalTokens: 15 } })
  })

  it('rejects cache totals that cannot produce disjoint DSH usage', async () => {
    const adapter = new DeepSeekGoalMeteredAdapter(Config(), { environment: { DEEPSEEK_API_KEY: 'test-key' }, fetch: async () => new Response(JSON.stringify({ model: 'deepseek-v4-pro', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 3, prompt_cache_hit_tokens: 2, completion_tokens: 1, total_tokens: 4 } })) })
    const iterator = adapter.stream({ provider: DEEPSEEK_PROVIDER, model: 'deepseek-v4-pro', maxTokens: 3, messages: [] })[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toMatchObject({ code: 'DEEPSEEK_PROTOCOL' })
  })

  it('keeps the documented conservative input bound', () => {
    expect(DEEPSEEK_INPUT_TOKEN_UPPER_BOUND).toBe(2_097_152)
  })
})
