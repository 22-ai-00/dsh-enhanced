import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { createUserMessage, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, test, vi } from 'vitest'
import { Config, DeepSeekGoalMeteredAdapter, DEEPSEEK_CHAT_COMPLETIONS_CONTRACT, DEEPSEEK_PROVIDER } from '../plugins/assistant-deepseek-budget/lib/index.js'

const servers: Server[] = []
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } })
const request = (): GenerateOptions => ({ provider: DEEPSEEK_PROVIDER, model: 'deepseek-v4-flash', maxTokens: 9,
  messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Original request' }] })] })
const config = () => Config({ enabled: true, defaultMaxTokens: 9, timeoutMs: 1000 })
const now = () => Date.parse(DEEPSEEK_CHAT_COMPLETIONS_CONTRACT.checkedAt) + 1000
const environment = { DEEPSEEK_API_KEY: 'test-only-not-a-credential' }
const response = () => new Response(JSON.stringify({ model: 'deepseek-v4-flash', choices: [{ index: 0, finish_reason: 'stop',
  message: { role: 'assistant', content: 'Verified response' } }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }))
async function collect(adapter: DeepSeekGoalMeteredAdapter, options = request()): Promise<StreamChunk[]> {
  const result: StreamChunk[] = []; for await (const chunk of adapter.stream(options)) result.push(chunk); return result
}
async function listen(server: Server): Promise<string> {
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('server missing TCP address')
  return `http://127.0.0.1:${address.port}`
}

test('native HTTP fetch refuses a redirect before its destination receives the credential or body', async () => {
  const paths: string[] = []
  const origin = await listen(createServer((req, res) => {
    paths.push(req.url ?? '')
    if (req.url === '/redirect') { res.writeHead(307, { location: '/destination' }); res.end() }
    else { res.writeHead(200); res.end('{}') }
  }))
  const adapter = new DeepSeekGoalMeteredAdapter(config(), { now, environment, fetch: (url, init) => {
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    return fetch(`${origin}/redirect`, init)
  } })
  await expect(collect(adapter)).rejects.toMatchObject({ code: 'DEEPSEEK_TRANSPORT' })
  expect(paths).toEqual(['/redirect'])
  adapter.shutdown()
})

test('native HTTP response-body timeout releases the wait while the server never ends its response', async () => {
  const origin = await listen(createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{') }))
  const adapter = new DeepSeekGoalMeteredAdapter(config(), { now, environment, fetch: (_url, init) => fetch(origin, init) })
  await expect(collect(adapter)).rejects.toMatchObject({ code: 'DEEPSEEK_ABORTED' })
  adapter.shutdown()
})

test.each(['credential', 'fetch', 'body'] as const)('unload ends a noncooperative %s wait without another dispatch or success', async phase => {
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const never = <T>(): Promise<T> => new Promise<T>(() => {})
  const transport = vi.fn(async () => {
    if (phase === 'fetch') { entered(); return await never<Response>() }
    return new Response(new ReadableStream({ start() { entered() }, pull: () => never<void>(), cancel: () => never<void>() }))
  })
  const adapter = new DeepSeekGoalMeteredAdapter(config(), { now, environment, fetch: transport,
    ...(phase === 'credential' ? { credentialResolver: () => ({ resolve: () => { entered(); return never<{ value: string }>() } }) } : {}),
  })
  const pending = collect(adapter)
  await started
  adapter.shutdown()
  await expect(pending).rejects.toMatchObject({ code: 'DEEPSEEK_ABORTED' })
  expect(transport).toHaveBeenCalledTimes(phase === 'credential' ? 0 : 1)
})

test('credential-service denial and secret-bearing errors never fall back to ambient credentials', async () => {
  const transport = vi.fn(async () => response())
  for (const resolve of [async () => undefined, async () => { throw new Error('secret-credential-value') }]) {
    const adapter = new DeepSeekGoalMeteredAdapter(config(), { now, environment, fetch: transport, credentialResolver: () => ({ resolve }) })
    await expect(collect(adapter)).rejects.not.toThrow('secret-credential-value')
    adapter.shutdown()
  }
  expect(transport).not.toHaveBeenCalled()
})

test('credential lookup cannot change the already snapshotted model, prompt, or reasoning effort', async () => {
  let release!: (value: { value: string }) => void
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const credential = { resolve: () => { entered(); return new Promise<{ value: string }>(resolve => { release = resolve }) } }
  const transport = vi.fn(async (_url: string, init: RequestInit) => {
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'deepseek-v4-flash', max_tokens: 9, thinking: { type: 'enabled' }, reasoning_effort: 'max', messages: [{ role: 'user', content: 'Original request' }] })
    return response()
  })
  const adapter = new DeepSeekGoalMeteredAdapter(config(), { now, environment, fetch: transport, credentialResolver: () => credential })
  const options = { ...request(), reasoningEffort: ReasoningEffortId('max') }
  const pending = collect(adapter, options)
  await started
  options.model = 'unreviewed-model'; options.maxTokens = 1000000; options.messages = []
  release({ value: 'test-key' })
  expect((await pending).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  expect(transport).toHaveBeenCalledTimes(1)
  adapter.shutdown()
})

test('removing an observed credential service cannot resume requests using an ambient key', async () => {
  let current: { resolve: () => Promise<{ value: string }> } | undefined = { resolve: async () => ({ value: 'service-test-key' }) }
  const transport = vi.fn(async () => response())
  const adapter = new DeepSeekGoalMeteredAdapter(config(), { now, environment, fetch: transport, credentialResolver: () => current })
  expect((await collect(adapter)).at(-1)).toMatchObject({ type: 'finish' })
  current = undefined
  await expect(collect(adapter)).rejects.toMatchObject({ code: 'DEEPSEEK_CREDENTIAL' })
  expect(transport).toHaveBeenCalledTimes(1)
  adapter.shutdown()
})

test.each(['replacement', 'expiry'] as const)('a late credential cannot dispatch after %s', async mode => {
  let clock = now()
  let release!: (value: { value: string }) => void
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let current = { resolve: () => { entered(); return new Promise<{ value: string }>(resolve => { release = resolve }) } }
  const transport = vi.fn(async () => response())
  const adapter = new DeepSeekGoalMeteredAdapter(config(), { now: () => clock, environment, fetch: transport, credentialResolver: () => current })
  const pending = collect(adapter)
  await started
  if (mode === 'replacement') current = { resolve: async () => ({ value: 'replacement-key' }) }
  else clock = Date.parse(DEEPSEEK_CHAT_COMPLETIONS_CONTRACT.expiresAt)
  release({ value: 'old-key' })
  await expect(pending).rejects.toThrow()
  expect(transport).not.toHaveBeenCalled()
  adapter.shutdown()
})

test('a consumer paused at usage cannot receive a successful finish after adapter unload', async () => {
  const adapter = new DeepSeekGoalMeteredAdapter(config(), { now, environment, fetch: async () => response() })
  const iterator = adapter.stream(request())[Symbol.asyncIterator]()
  for (;;) { const next = await iterator.next(); if (next.done) throw new Error('missing usage'); if (next.value.type === 'usage') break }
  adapter.shutdown()
  await expect(iterator.next()).rejects.toMatchObject({ code: 'DEEPSEEK_ABORTED' })
})
