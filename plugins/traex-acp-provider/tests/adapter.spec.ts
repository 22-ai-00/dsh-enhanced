import { createMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { redactDiagnostic, TraexAcpAdapter } from '../src/adapter.ts'
import type { RunTraexAcpOptions, TraexAcpInvocation } from '../src/acp-client.ts'
import { Config } from '../src/config.ts'

function request(model = 'default'): GenerateOptions {
  return {
    provider: 'traex-agent',
    model,
    system: 'Be concise.',
    messages: [createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })],
  }
}

function failedTextStream(cause: string): AsyncIterable<string> {
  const iterator: AsyncIterator<string> & AsyncIterable<string> = {
    [Symbol.asyncIterator]() { return iterator },
    next(): Promise<IteratorResult<string>> {
      return Promise.reject(new Error('transport failed', { cause }))
    },
  }
  return iterator
}

describe('TraeX ACP LLM adapter', () => {
  it('advertises configured text models and disables automatic retries', async () => {
    const adapter = new TraexAcpAdapter(Config())
    await expect(adapter.listModels('traex-agent')).resolves.toEqual([
      expect.objectContaining({ provider: 'traex-agent', id: 'default', inputModalities: ['text'] }),
    ])
    expect(adapter.providerRetryPolicy('traex-agent')).toMatchObject({ mode: 'normal', maxRetries: 0 })
  })

  it('maps ACP text into a valid DSH stream with fixed safe server arguments', async () => {
    let invocation: TraexAcpInvocation | undefined
    const runText = vi.fn((received: TraexAcpInvocation, options?: RunTraexAcpOptions) => {
      invocation = received
      return (async function* () {
        yield 'one'
        yield ' two'
        options?.onStopReason?.('end_turn')
      })()
    })
    const adapter = new TraexAcpAdapter(Config(), { runText, verifyAuth: async () => {} })
    const chunks = []
    for await (const chunk of adapter.stream(request())) chunks.push(chunk)
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'one' },
      { type: 'text-delta', index: 0, text: ' two' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'one two' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect(invocation).toMatchObject({ command: 'traex', cwd: process.cwd() })
    expect(invocation).not.toHaveProperty('model')
    expect(invocation?.args).toEqual([
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'never',
      'acp',
      'serve',
    ])
    expect(invocation?.args).not.toContain('--yolo')
    expect(invocation?.prompt).toContain('dsh-traex-acp-provider/v1')
  })

  it('passes an explicit configured model through ACP rather than argv', async () => {
    const config = Config()
    config.models = ['default', 'model-x']
    let invocation: TraexAcpInvocation | undefined
    const adapter = new TraexAcpAdapter(config, {
      verifyAuth: async () => {},
      runText(received, options) {
        invocation = received
        return (async function* () {
          yield 'ok'
          options?.onStopReason?.('end_turn')
        })()
      },
    })
    for await (const _chunk of adapter.stream(request('model-x'))) {
      // Drain the complete stream.
    }
    expect(invocation?.model).toBe('model-x')
    expect(invocation?.args).not.toContain('model-x')
  })

  it.each([
    { cause: 'auth', code: 'ACP_AUTH_REQUIRED' },
    { cause: 'entitlement', code: 'ACP_ENTITLEMENT_REQUIRED' },
    { cause: 'model', code: 'ACP_MODEL_UNAVAILABLE' },
    { cause: 'refusal', code: 'ACP_REFUSAL' },
  ])('maps $cause transport failures to $code', async ({ cause, code }) => {
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth: async () => {},
      runText: () => failedTextStream(cause),
    })
    const iterator = adapter.stream(request())[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'block-start' } })
    await expect(iterator.next()).rejects.toMatchObject({ code })
  })

  it.each(['max_tokens', 'max_turn_requests'] as const)('preserves the truncated %s terminal', async reason => {
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth: async () => {},
      runText(_invocation, options) {
        return (async function* () {
          yield 'partial'
          options?.onStopReason?.(reason)
        })()
      },
    })
    const chunks = []
    for await (const chunk of adapter.stream(request())) chunks.push(chunk)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('fails closed when an injected transport omits terminal metadata', async () => {
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth: async () => {},
      runText: () => (async function* () { yield 'partial' })(),
    })
    const iterator = adapter.stream(request())[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.next()
    await expect(iterator.next()).rejects.toMatchObject({ code: 'ACP_PROTOCOL_ERROR' })
  })

  it('propagates shutdown into active ACP transports', async () => {
    let receivedSignal: AbortSignal | undefined
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth: async () => {},
      runText(_invocation, options) {
        receivedSignal = options?.signal
        return (async function* () {
          await new Promise<void>((_resolve, reject) => {
            receivedSignal?.addEventListener('abort', () => reject(new Error('stopped', { cause: 'abort' })), { once: true })
          })
          yield ''
        })()
      },
    })
    const iterator = adapter.stream(request())[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'block-start' } })
    const pending = iterator.next()
    adapter.shutdown()
    await expect(pending).rejects.toThrow('stopped')
    expect(receivedSignal?.aborted).toBe(true)
  })

  it('redacts credential and identity shapes from diagnostics', () => {
    const redacted = redactDiagnostic('Authorization: Bearer abc123 token=secret someone@example.com')
    expect(redacted).not.toContain('abc123')
    expect(redacted).not.toContain('secret')
    expect(redacted).not.toContain('someone@example.com')
  })

  it('redacts Basic credentials, URL userinfo and control characters from diagnostics', () => {
    const redacted = redactDiagnostic('Authorization=Basic dXNlcjpwYXNz\nhttps://user:pass@example.test/\u001b[31mforged')
    expect(redacted).not.toContain('dXNlcjpwYXNz')
    expect(redacted).not.toContain('user:pass')
    expect([...redacted].some(character => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)
    })).toBe(false)
  })

  it('fails authentication before starting an ACP model process', async () => {
    const runText = vi.fn(() => (async function* () { yield 'never' })())
    const adapter = new TraexAcpAdapter(Config(), {
      runText,
      verifyAuth: () => Promise.reject(new Error('wrong source', { cause: 'auth' })),
    })
    await expect(adapter.stream(request())[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: 'ACP_AUTH_REQUIRED',
    })
    expect(runText).not.toHaveBeenCalled()
  })
})
