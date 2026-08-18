import { createMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { CodingSubscriptionAdapter, redactDiagnostic } from '../src/adapter.ts'
import { SubscriptionAuthError } from '../src/auth.ts'
import { Config } from '../src/config.ts'
import type { CliInvocation } from '../src/providers.ts'

function request(): GenerateOptions {
  return {
    provider: 'codex-subscription',
    model: 'default',
    system: 'Be concise.',
    messages: [createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })],
  }
}

describe('coding subscription LLM adapter', () => {
  it('advertises configured text models and disables automatic retries', async () => {
    const adapter = new CodingSubscriptionAdapter(Config())
    await expect(adapter.listModels('codex-subscription')).resolves.toEqual([
      expect.objectContaining({ provider: 'codex-subscription', id: 'default', inputModalities: ['text'] }),
    ])
    expect(adapter.providerRetryPolicy('codex-subscription')).toMatchObject({ mode: 'normal', maxRetries: 0 })
  })

  it('maps CLI text into a valid DSH text stream', async () => {
    let invocation: CliInvocation | undefined
    const runText = vi.fn((received: CliInvocation) => {
      invocation = received
      return (async function* () { yield 'one'; yield ' two' })()
    })
    const adapter = new CodingSubscriptionAdapter(Config(), { runText, verifyAuth: async () => {} })
    const chunks = []
    for await (const chunk of adapter.stream(request())) chunks.push(chunk)
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'one' },
      { type: 'text-delta', index: 0, text: ' two' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'one two' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect(invocation).toMatchObject({ provider: 'codex', command: 'codex', cwd: process.cwd() })
    expect(invocation?.args.join(' ')).toContain('dsh-coding-subscription-provider/v1')
    expect(invocation?.args).not.toContain('--max-turns')
  })

  it('redacts common secrets before diagnostics are logged', () => {
    const redacted = redactDiagnostic('Authorization: Bearer abc123 token=xai-secret someone@example.com')
    expect(redacted).not.toContain('abc123')
    expect(redacted).not.toContain('xai-secret')
    expect(redacted).not.toContain('someone@example.com')
  })

  it('propagates adapter shutdown into every active runner', async () => {
    let receivedSignal: AbortSignal | undefined
    const runText = (_invocation: CliInvocation, options?: { signal?: AbortSignal }) => {
      receivedSignal = options?.signal
      return (async function* () {
        await new Promise<void>((_resolve, reject) => {
          receivedSignal?.addEventListener('abort', () => reject(new Error('stopped', { cause: 'abort' })), { once: true })
        })
        yield ''
      })()
    }
    const adapter = new CodingSubscriptionAdapter(Config(), { runText, verifyAuth: async () => {} })
    const iterator = adapter.stream(request())[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'block-start' } })
    const pending = iterator.next()
    adapter.shutdown()
    await expect(pending).rejects.toThrow('stopped')
    expect(receivedSignal?.aborted).toBe(true)
  })

  it('fails before spawning a model process when subscription auth is not verified', async () => {
    const runText = vi.fn(() => (async function* () { yield 'never' })())
    const adapter = new CodingSubscriptionAdapter(Config(), {
      runText,
      verifyAuth: () => Promise.reject(new SubscriptionAuthError('codex', 'not ChatGPT')),
    })
    await expect(adapter.stream(request())[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: 'SUBSCRIPTION_AUTH_REQUIRED',
    })
    expect(runText).not.toHaveBeenCalled()
  })
})
