import { createMessage, ReasoningEffortId, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { redactDiagnostic, TraexAcpAdapter, type TraexAcpTextRunner } from '../src/adapter.ts'
import type { RunTraexAcpOptions, TraexAcpInvocation } from '../src/acp-client.ts'
import { Config } from '../src/config.ts'

function request(model = 'default', reasoningEffort?: string): GenerateOptions {
  return {
    provider: 'traex-agent',
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }),
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
  it('discovers the live ACP catalog and makes every returned model selectable', async () => {
    const discoverModels = vi.fn(() => Promise.resolve({
      currentValue: 'trae-fast',
      modelValues: ['trae-fast', 'trae-pro'],
      models: [
        {
          id: 'trae-fast',
          name: 'Trae Fast',
          reasoning: {
            efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
            defaultEffort: 'high',
          },
        },
        {
          id: 'trae-pro',
          name: 'Trae Pro',
          reasoning: {
            efforts: [{ id: 'low', name: 'Low' }, { id: 'ultra', name: 'Ultra' }],
            defaultEffort: 'low',
          },
        },
      ],
      completeReasoning: true,
      observedAt: 1,
    }))
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth: async () => {},
      discoverModels,
    } as never)

    await expect(adapter.listModels('traex-agent')).resolves.toEqual([
      expect.objectContaining({ provider: 'traex-agent', id: 'default' }),
      expect.objectContaining({ provider: 'traex-agent', id: 'trae-fast', name: 'Trae Fast' }),
      expect.objectContaining({ provider: 'traex-agent', id: 'trae-pro', name: 'Trae Pro' }),
    ])
    await expect(adapter.resolveModel('traex-agent', 'trae-pro')).resolves.toMatchObject({
      id: 'trae-pro',
      reasoning: {
        efforts: [{ id: 'low', name: 'Low' }, { id: 'ultra', name: 'Ultra' }],
        defaultEffort: 'low',
      },
    })
    expect(discoverModels).toHaveBeenCalledTimes(1)
  })

  it('advertises configured text models and disables automatic retries', async () => {
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth: async () => {},
      discoverModels: async () => ({
        currentValue: 'default',
        modelValues: ['default'],
        models: [{ id: 'default', name: 'TraeX default' }],
        completeReasoning: true,
        observedAt: 1,
      }),
    })
    await expect(adapter.listModels('traex-agent')).resolves.toEqual([
      expect.objectContaining({ provider: 'traex-agent', id: 'default', inputModalities: ['text'] }),
    ])
    expect(adapter.providerRetryPolicy('traex-agent')).toMatchObject({ mode: 'normal', maxRetries: 0 })
  })

  it('maps ACP text into a valid DSH stream with fixed safe server arguments', async () => {
    let invocation: TraexAcpInvocation | undefined
    let runnerOptions: RunTraexAcpOptions | undefined
    const runText = vi.fn((received: TraexAcpInvocation, options?: RunTraexAcpOptions) => {
      invocation = received
      runnerOptions = options
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
    expect(runnerOptions?.authProbeDurationMs).toBeTypeOf('number')
  })

  it('maps a delegated ACP tool-call envelope into a continuing DSH tool step', async () => {
    const options = request()
    options.tools = [{
      name: 'read',
      description: 'Read a workspace file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    }]
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth: async () => {},
      runText(_invocation, runnerOptions) {
        return (async function* () {
          yield '{"protocol":"dsh-tool-calls/v1","calls":['
          yield '{"name":"read","arguments":{"path":"README.md"}}]}'
          runnerOptions?.onStopReason?.('end_turn')
        })()
      },
    })

    const chunks = []
    for await (const chunk of adapter.stream(options)) chunks.push(chunk)

    const callDelta = chunks.find(chunk => chunk.type === 'tool-call-delta')
    expect(callDelta).toMatchObject({
      type: 'tool-call-delta',
      index: 0,
      name: 'read',
      argumentsDelta: '{"path":"README.md"}',
    })
    if (callDelta?.type !== 'tool-call-delta') throw new Error('missing tool-call delta')
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      callDelta,
      {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: callDelta.id,
          name: 'read',
          arguments: '{"path":"README.md"}',
        },
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('keeps an ordinary final response as text when DSH tools are available', async () => {
    const options = request()
    options.tools = [{ name: 'read', description: 'Read a file.', parameters: { type: 'object' } }]
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth: async () => {},
      runText(_invocation, runnerOptions) {
        return (async function* () {
          yield 'task complete'
          runnerOptions?.onStopReason?.('end_turn')
        })()
      },
    })

    const chunks = []
    for await (const chunk of adapter.stream(options)) chunks.push(chunk)

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'task complete' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'task complete' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('records buffered final text as forwarded before yielding its first delta', async () => {
    const options = request()
    options.tools = [{ name: 'read', description: 'Read a file.', parameters: { type: 'object' } }]
    const settled: { assistantTextForwarded?: boolean }[] = []
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth: async () => {},
      onSettled: context => { settled.push(context) },
      runText(_invocation, runnerOptions) {
        return (async function* () {
          yield 'task complete'
          runnerOptions?.onStopReason?.('end_turn')
        })()
      },
    })

    const iterator = adapter.stream(options)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'block-start', blockType: 'text' } })
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'text-delta', text: 'task complete' } })
    await iterator.return?.()

    expect(settled).toEqual([expect.objectContaining({ assistantTextForwarded: true })])
  })

  it('fails closed when an ACP tool envelope names an unavailable DSH tool', async () => {
    const options = request()
    options.tools = [{ name: 'read', description: 'Read a file.', parameters: { type: 'object' } }]
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth: async () => {},
      runText(_invocation, runnerOptions) {
        return (async function* () {
          yield '{"protocol":"dsh-tool-calls/v1","calls":[{"name":"bash","arguments":{"command":"pwd"}}]}'
          runnerOptions?.onStopReason?.('end_turn')
        })()
      },
    })

    await expect((async () => {
      for await (const _chunk of adapter.stream(options)) { /* drain */ }
    })()).rejects.toMatchObject({ code: 'ACP_PROTOCOL_ERROR' })
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

  it('passes the selected reasoning effort through the ACP invocation rather than argv', async () => {
    let invocation: TraexAcpInvocation | undefined
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth: async () => {},
      runText(received, options) {
        invocation = received
        return (async function* () {
          yield 'ok'
          options?.onStopReason?.('end_turn')
        })()
      },
    })
    for await (const _chunk of adapter.stream(request('gpt-5.6-sol', 'xhigh'))) {
      // Drain the complete stream.
    }
    expect(invocation).toMatchObject({ model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' })
    expect(invocation?.args).not.toContain('xhigh')
  })

  it.each([
    { cause: 'auth', code: 'ACP_AUTH_REQUIRED' },
    { cause: 'entitlement', code: 'ACP_ENTITLEMENT_REQUIRED' },
    { cause: 'model', code: 'ACP_MODEL_UNAVAILABLE' },
    { cause: 'reasoning', code: 'UNSUPPORTED_REASONING_EFFORT' },
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

  it('reports an auth-phase, not-submitted context when the login probe fails', async () => {
    let context: {
      phase?: string
      promptSubmissionState?: string
      assistantTextForwarded?: boolean
      teardownState?: string
      metrics?: { authProbeDurationMs?: number }
    } | undefined
    const adapter = new TraexAcpAdapter(Config(), {
      runText: () => (async function* () { yield 'never' })(),
      verifyAuth: () => Promise.reject(new Error('wrong source', { cause: 'auth' })),
      onSettled: value => { context = value },
    })
    await expect(adapter.stream(request())[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: 'ACP_AUTH_REQUIRED',
    })
    expect(context).toMatchObject({
      phase: 'auth',
      promptSubmissionState: 'not-submitted',
      assistantTextForwarded: false,
      teardownState: 'not-started',
    })
    expect(context?.metrics?.authProbeDurationMs).toBeTypeOf('number')
  })

  it('carries assistantTextForwarded when a turn fails after text reached DSH', async () => {
    let context: { assistantTextForwarded?: boolean; outcome?: string } | undefined
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth: async () => {},
      runText: () => (async function* (): AsyncIterable<string> {
        yield 'partial'
        throw new Error('transport failed', { cause: 'protocol' })
      })(),
      onSettled: value => { context = value },
    })
    const chunks: unknown[] = []
    await expect((async () => {
      for await (const chunk of adapter.stream(request())) chunks.push(chunk)
    })()).rejects.toMatchObject({ code: 'ACP_PROTOCOL_ERROR' })
    expect(context?.assistantTextForwarded).toBe(true)
    expect(context?.outcome).toBe('protocol')
  })

  it('reports a preflight, not-submitted context when prompt serialization exceeds the byte limit', async () => {
    let context: { phase?: string; promptSubmissionState?: string; outcome?: string; teardownState?: string } | undefined
    const runText = vi.fn(() => (async function* () { yield 'never' })())
    const config = Config()
    config.maxPromptBytes = 1
    const adapter = new TraexAcpAdapter(config, {
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
      teardownState: 'not-started',
      outcome: 'preflight',
    })
  })

  it('reports an ok outcome once when the turn succeeds', async () => {
    const calls: { outcome?: string; assistantTextForwarded?: boolean }[] = []
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth: async () => {},
      runText(_invocation, options) {
        return (async function* () {
          yield 'done'
          options?.onStopReason?.('end_turn')
        })()
      },
      onSettled: value => { calls.push(value) },
    })
    for await (const _chunk of adapter.stream(request())) { /* drain */ }
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ outcome: 'ok', assistantTextForwarded: true })
  })

  it('reports settled with a not-submitted aborted context when the signal is already aborted', async () => {
    const calls: { phase?: string; promptSubmissionState?: string; outcome?: string }[] = []
    const runText = vi.fn(() => (async function* () { yield 'never' })())
    const controller = new AbortController()
    controller.abort()
    const adapter = new TraexAcpAdapter(Config(), {
      runText,
      verifyAuth: async () => {},
      onSettled: value => { calls.push(value) },
    })
    await expect(adapter.stream({ ...request(), signal: controller.signal })[Symbol.asyncIterator]().next())
      .rejects.toThrow()
    expect(runText).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ phase: 'auth', promptSubmissionState: 'not-submitted', outcome: 'aborted' })
  })

  it('settles exactly once with aborted outcome when the consumer returns early after block-start', async () => {
    const calls: { outcome?: string; promptSubmissionState?: string; teardownState?: string }[] = []
    const runText = vi.fn(() => (async function* (): AsyncIterable<string> {
      await new Promise(resolve => setTimeout(resolve, 50))
      yield 'late'
    })())
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth: async () => {},
      runText,
      onSettled: value => { calls.push(value) },
    })
    const iterator = adapter.stream(request())[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'block-start' } })
    await iterator.return?.()
    expect(runText).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
    // Nothing ran past block-start, so the prompt is provably not-submitted.
    expect(calls[0]).toMatchObject({
      outcome: 'aborted',
      promptSubmissionState: 'not-submitted',
      teardownState: 'not-started',
    })
  })

  it('uses unknown submission and teardown states when a runner throws synchronously', async () => {
    const calls: { outcome?: string; promptSubmissionState?: string; teardownState?: string }[] = []
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth: async () => {},
      runText: () => { throw new Error('runner setup failed', { cause: 'protocol' }) },
      onSettled: value => { calls.push(value) },
    })
    const iterator = adapter.stream(request())[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'block-start' } })
    await expect(iterator.next()).rejects.toMatchObject({ code: 'ACP_PROTOCOL_ERROR' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      outcome: 'protocol',
      promptSubmissionState: 'unknown',
      teardownState: 'unknown',
    })
  })

  function runnerEmittingCatalog(models: string[]): TraexAcpTextRunner {
    return (_invocation, options) => (async function* () {
      options?.onCatalogObserved?.({
        currentValue: 'default',
        modelValues: models,
        models: models.map(id => ({ id, name: id })),
        completeReasoning: false,
        observedAt: 1,
      })
      yield 'hi'
      options?.onStopReason?.('end_turn')
    })()
  }

  it('records a non-authoritative catalog observation that peekObservedCatalog can read', async () => {
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth: async () => {},
      runText: runnerEmittingCatalog(['default', 'trae-fast']),
    })
    expect(adapter.peekObservedCatalog()).toBeUndefined()
    for await (const _chunk of adapter.stream(request())) { /* drain */ }
    expect(adapter.peekObservedCatalog()?.observation.modelValues).toEqual(['default', 'trae-fast'])
  })

  it('never lets the observed catalog gate a request: an unobserved model still runs', async () => {
    // The observation lists only 'default', but the deployer adds a 'trae-fast' advisory alias.
    // The cache remains non-authoritative for execution, so stream must NOT reject on it.
    const config = Config({ ...Config(), models: ['default', 'trae-fast'] } as never)
    const runText = vi.fn(runnerEmittingCatalog(['default']))
    const adapter = new TraexAcpAdapter(config, {
      verifyAuth: async () => {},
      runText,
      discoverModels: async () => ({
        currentValue: 'default',
        modelValues: ['default'],
        models: [{ id: 'default', name: 'default' }],
        completeReasoning: true,
        observedAt: 1,
      }),
    })
    // Prime the cache with an observation that omits 'trae-fast'.
    for await (const _chunk of adapter.stream(request('default'))) { /* drain */ }
    expect(adapter.peekObservedCatalog()?.observation.modelValues).toEqual(['default'])
    // resolveModel still resolves the configured-but-unobserved advisory alias.
    await expect(adapter.resolveModel('traex-agent', 'trae-fast')).resolves.toMatchObject({ id: 'trae-fast' })
    // And a full stream for it runs to completion — the cache never blocked it.
    const chunks = []
    for await (const chunk of adapter.stream(request('trae-fast'))) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
    expect(runText).toHaveBeenCalledTimes(2)
  })

  it('clears the observed catalog on shutdown', async () => {
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth: async () => {},
      runText: runnerEmittingCatalog(['default']),
    })
    for await (const _chunk of adapter.stream(request())) { /* drain */ }
    expect(adapter.peekObservedCatalog()).toBeDefined()
    adapter.shutdown()
    expect(adapter.peekObservedCatalog()).toBeUndefined()
  })

  it('invalidates a stale observation when a later auth probe fails', async () => {
    let authOk = true
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth: () => authOk ? Promise.resolve() : Promise.reject(new Error('logged out', { cause: 'auth' })),
      runText: runnerEmittingCatalog(['default']),
    })
    for await (const _chunk of adapter.stream(request())) { /* drain */ }
    expect(adapter.peekObservedCatalog()).toBeDefined()
    // The account logs out; the next probe fails and must drop the stale observation.
    authOk = false
    await expect(adapter.stream(request())[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'ACP_AUTH_REQUIRED' })
    expect(adapter.peekObservedCatalog()).toBeUndefined()
  })

  it('evicts an observation once its TTL elapses', async () => {
    let clock = 0
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth: async () => {},
      runText: runnerEmittingCatalog(['default']),
      catalogCacheTtlMs: 1_000,
      catalogClock: () => clock,
    })
    for await (const _chunk of adapter.stream(request())) { /* drain */ }
    expect(adapter.peekObservedCatalog()).toBeDefined()
    clock = 1_000
    expect(adapter.peekObservedCatalog()).toBeUndefined()
  })
})
