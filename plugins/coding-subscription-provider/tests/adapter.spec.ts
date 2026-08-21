import { createMessage, ReasoningEffortId, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { CodingSubscriptionAdapter, redactDiagnostic } from '../src/adapter.ts'
import { SubscriptionAuthError } from '../src/auth.ts'
import { Config } from '../src/config.ts'
import { CliWorkingDirectoryError, type RunCliTextOptions } from '../src/process.ts'
import type { CliInvocation } from '../src/providers.ts'

function request(model = 'default', reasoningEffort?: string): GenerateOptions {
  return {
    provider: 'codex-subscription',
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }),
    system: 'Be concise.',
    messages: [createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })],
  }
}

function providerRequest(provider: string, model = 'default', reasoningEffort?: string): GenerateOptions {
  return {
    ...request(model, reasoningEffort),
    provider,
  }
}

describe('coding subscription LLM adapter', () => {
  it('discovers Codex models and exposes each model-specific reasoning effort', async () => {
    const discoverCodexModels = vi.fn(() => Promise.resolve({
      defaultModel: 'gpt-5.6-sol',
      models: [
        {
          id: 'gpt-5.6-sol',
          name: 'GPT-5.6-Sol',
          description: 'Latest frontier agentic coding model.',
          reasoning: {
            efforts: [{ id: 'low', name: 'Low' }, { id: 'ultra', name: 'Ultra' }],
            defaultEffort: 'low',
          },
          inputModalities: ['text', 'image'],
        },
        {
          id: 'gpt-5.6-luna',
          name: 'GPT-5.6-Luna',
          reasoning: {
            efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
            defaultEffort: 'high',
          },
          inputModalities: ['text', 'image'],
        },
      ],
      observedAt: 1,
    }))
    const adapter = new CodingSubscriptionAdapter(Config(), {
      verifyAuth: async () => {},
      discoverCodexModels,
    } as never)

    await expect(adapter.listModels('codex-subscription')).resolves.toEqual([
      expect.objectContaining({ provider: 'codex-subscription', id: 'default', inputModalities: ['text'] }),
      expect.objectContaining({ provider: 'codex-subscription', id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' }),
      expect.objectContaining({ provider: 'codex-subscription', id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna' }),
    ])
    await expect(adapter.resolveModel('codex-subscription', 'gpt-5.6-sol')).resolves.toMatchObject({
      id: 'gpt-5.6-sol',
      reasoning: {
        efforts: [{ id: 'low', name: 'Low' }, { id: 'ultra', name: 'Ultra' }],
        defaultEffort: 'low',
      },
    })
    expect(discoverCodexModels).toHaveBeenCalledTimes(1)
    expect(adapter.providerRetryPolicy('codex-subscription')).toMatchObject({ mode: 'normal', maxRetries: 0 })
  })

  it('passes the selected Codex reasoning effort to the CLI invocation', async () => {
    let invocation: CliInvocation | undefined
    const adapter = new CodingSubscriptionAdapter(Config(), {
      verifyAuth: async () => {},
      runText(received) {
        invocation = received
        return (async function* () { yield 'done' })()
      },
    })

    for await (const _chunk of adapter.stream(request('gpt-5.6-sol', 'ultra'))) { /* drain */ }
    expect(invocation?.args).toContain('model_reasoning_effort="ultra"')
  })

  it.each([
    ['claude-subscription', 'claude', '--effort'],
    ['grok-subscription', 'grok', '--reasoning-effort'],
  ] as const)('passes selected reasoning effort through the %s adapter route', async (route, cli, flag) => {
    let invocation: CliInvocation | undefined
    const adapter = new CodingSubscriptionAdapter(Config(), {
      verifyAuth: async () => {},
      runText(received) {
        invocation = received
        return (async function* () { yield 'done' })()
      },
    })

    for await (const _chunk of adapter.stream(providerRequest(route, 'model-a', 'high'))) { /* drain */ }
    expect(invocation).toMatchObject({ provider: cli })
    expect(invocation?.args).toEqual(expect.arrayContaining([flag, 'high']))
  })

  it.each([
    ['claude-subscription', 'discoverClaudeModels', 'claude-opus', ['low', 'high', 'max']],
    ['grok-subscription', 'discoverGrokModels', 'grok-4.6', ['low', 'medium', 'high', 'xhigh']],
    ['cursor-subscription', 'discoverCursorModels', 'composer-2', undefined],
  ] as const)('discovers %s models and exposes available effort metadata', async (route, dependency, model, efforts) => {
    const discover = vi.fn(() => Promise.resolve({
      defaultModel: model,
      models: [{
        id: model,
        name: model,
        ...(efforts === undefined ? {} : {
          reasoning: {
            efforts: efforts.map(id => ({ id, name: id })),
            defaultEffort: efforts[0],
          },
        }),
        inputModalities: ['text'],
      }],
      observedAt: 1,
    }))
    const adapter = new CodingSubscriptionAdapter(Config(), {
      verifyAuth: async () => {},
      [dependency]: discover,
    } as never)

    await expect(adapter.listModels(route)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'default' }),
      expect.objectContaining({ id: model }),
    ]))
    const resolved = await adapter.resolveModel(route, model)
    if (efforts === undefined) expect(resolved.reasoning).toBeUndefined()
    else expect(resolved.reasoning?.efforts.map(effort => effort.id)).toEqual(efforts)
    expect(discover).toHaveBeenCalledTimes(1)
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

  it('returns actionable guidance when Codex refuses the configured cwd', async () => {
    const config = Config({ cwd: '/workspace-parent' } as never)
    let context: unknown
    const runText = (invocation: CliInvocation, options?: RunCliTextOptions) => (async function* (): AsyncIterable<string> {
      expect(invocation.cwd).toBe('/workspace-parent')
      yield* []
      options?.onSettled?.({
        phase: 'child-close',
        promptSubmissionState: 'submitted',
        assistantTextObserved: false,
        teardownState: 'not-started',
        exitCode: 1,
        signal: null,
      })
      throw new CliWorkingDirectoryError()
    })()
    const adapter = new CodingSubscriptionAdapter(config, {
      runText,
      verifyAuth: async () => {},
      onSettled: value => { context = value },
    })

    await expect((async () => {
      for await (const _chunk of adapter.stream(request())) { /* drain */ }
    })()).rejects.toMatchObject({
      code: 'CLI_WORKING_DIRECTORY',
      message: expect.stringContaining('config.cwd to a Git repository'),
    })
    expect(context).toMatchObject({
      route: 'codex-subscription',
      phase: 'child-close',
      outcome: 'working-directory',
      promptSubmissionState: 'submitted',
      assistantTextObserved: false,
      assistantTextForwarded: false,
      teardownState: 'not-started',
      exitCode: 1,
      signal: null,
    })
  })

  it('reports an auth-phase, not-submitted context when the login probe fails', async () => {
    let context: unknown
    const adapter = new CodingSubscriptionAdapter(Config(), {
      runText: () => (async function* () { yield 'never' })(),
      verifyAuth: () => Promise.reject(new SubscriptionAuthError('codex', 'not ChatGPT')),
      onSettled: value => { context = value },
    })
    await expect(adapter.stream(request())[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: 'SUBSCRIPTION_AUTH_REQUIRED',
    })
    expect(context).toMatchObject({
      route: 'codex-subscription',
      phase: 'auth',
      promptSubmissionState: 'not-submitted',
      assistantTextForwarded: false,
    })
  })

  it('carries assistantTextForwarded and the transport phase when a turn fails after text', async () => {
    let context: { assistantTextForwarded?: boolean; phase?: string; promptSubmissionState?: string } | undefined
    const runText = () => (async function* (): AsyncIterable<string> {
      yield 'partial'
      throw new Error('closed', { cause: 'protocol' })
    })()
    const adapter = new CodingSubscriptionAdapter(Config(), {
      runText,
      verifyAuth: async () => {},
      onSettled: value => { context = value },
    })
    const chunks: unknown[] = []
    await expect((async () => {
      for await (const chunk of adapter.stream(request())) chunks.push(chunk)
    })()).rejects.toMatchObject({ code: 'CLI_PROTOCOL_ERROR' })
    expect(context?.assistantTextForwarded).toBe(true)
    expect(context?.phase).toBe('stream')
  })

  it('reports a preflight, not-submitted context when prompt serialization exceeds the byte limit', async () => {
    let context: { phase?: string; promptSubmissionState?: string; outcome?: string; teardownState?: string } | undefined
    const runText = vi.fn(() => (async function* () { yield 'never' })())
    const config = Config()
    config.maxPromptBytes = 1
    const adapter = new CodingSubscriptionAdapter(config, {
      runText,
      verifyAuth: async () => {},
      onSettled: value => { context = value },
    })
    await expect((async () => {
      for await (const _chunk of adapter.stream(request())) { /* drain */ }
    })()).rejects.toThrow('configured limit')
    expect(runText).not.toHaveBeenCalled()
    expect(context).toMatchObject({
      phase: 'preflight',
      promptSubmissionState: 'not-submitted',
      outcome: 'preflight',
      teardownState: 'not-started',
    })
  })

  it('reports an ok outcome once when the turn succeeds', async () => {
    const calls: { outcome?: string; assistantTextForwarded?: boolean }[] = []
    const adapter = new CodingSubscriptionAdapter(Config(), {
      runText: () => (async function* () { yield 'done' })(),
      verifyAuth: async () => {},
      onSettled: value => { calls.push(value) },
    })
    for await (const _chunk of adapter.stream(request())) { /* drain */ }
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ outcome: 'ok', assistantTextForwarded: true })
  })

  it('settles exactly once with aborted outcome when the consumer returns early after block-start', async () => {
    const calls: { outcome?: string; promptSubmissionState?: string }[] = []
    const runText = vi.fn(() => (async function* (): AsyncIterable<string> {
      await new Promise(resolve => setTimeout(resolve, 50))
      yield 'late'
    })())
    const adapter = new CodingSubscriptionAdapter(Config(), {
      runText,
      verifyAuth: async () => {},
      onSettled: value => { calls.push(value) },
    })
    const iterator = adapter.stream(request())[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'block-start' } })
    await iterator.return?.()
    expect(calls).toHaveLength(1)
    expect(runText).not.toHaveBeenCalled()
    // Nothing ran past block-start, so the prompt is provably not-submitted.
    expect(calls[0]).toMatchObject({
      outcome: 'aborted',
      promptSubmissionState: 'not-submitted',
      teardownState: 'not-started',
    })
  })

  it('stops claiming not-submitted before invoking a runner that throws synchronously', async () => {
    const calls: { outcome?: string; promptSubmissionState?: string }[] = []
    const runText = vi.fn(() => { throw new Error('runner failed synchronously') })
    const adapter = new CodingSubscriptionAdapter(Config(), {
      runText,
      verifyAuth: async () => {},
      onSettled: value => { calls.push(value) },
    })
    const iterator = adapter.stream(request())[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'block-start' } })
    await expect(iterator.next()).rejects.toMatchObject({ code: 'CLI_FAILED' })
    expect(runText).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ outcome: 'io', promptSubmissionState: 'unknown' })
  })

  it('prefers a settled transport state over the conservative adapter state', async () => {
    const calls: { phase?: string; outcome?: string; promptSubmissionState?: string }[] = []
    const runText = vi.fn((_invocation: CliInvocation, options?: RunCliTextOptions) => {
      options?.onSettled?.({
        phase: 'spawn',
        promptSubmissionState: 'not-submitted',
        assistantTextObserved: false,
        teardownState: 'not-started',
      })
      throw Object.assign(new Error('missing executable'), { code: 'ENOENT' })
    })
    const adapter = new CodingSubscriptionAdapter(Config(), {
      runText,
      verifyAuth: async () => {},
      onSettled: value => { calls.push(value) },
    })
    const iterator = adapter.stream(request())[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'block-start' } })
    await expect(iterator.next()).rejects.toMatchObject({ code: 'CLI_NOT_FOUND' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ phase: 'spawn', outcome: 'not-found', promptSubmissionState: 'not-submitted' })
  })
})
