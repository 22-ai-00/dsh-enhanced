import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createMessage, deepFreeze, markAgentLoopRequest, ReasoningEffortId, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { realpathSync } from 'node:fs'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  probeTraexReadiness,
  redactDiagnostic,
  TraexAcpAdapter as RawTraexAcpAdapter,
  type AdapterDependencies,
  type TraexAcpTextRunner,
} from '../src/adapter.ts'
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

const TEST_SESSION_ID = 'session-live' as NonNullable<GenerateOptions['sessionId']>

function loopOwnedRequest(options: GenerateOptions): GenerateOptions {
  return markAgentLoopRequest(deepFreeze({ ...options, sessionId: TEST_SESSION_ID }))
}

/** See the coding provider suite for why normal tests use this loop-owned fixture. */
class TraexAcpAdapter extends RawTraexAcpAdapter {
  constructor(
    config: ConstructorParameters<typeof RawTraexAcpAdapter>[0],
    dependencies: AdapterDependencies = {},
  ) {
    super(config, {
      ...dependencies,
      liveSessions: dependencies.liveSessions ?? {
        get(sessionId) {
          return sessionId === TEST_SESSION_ID
            ? { id: TEST_SESSION_ID, header: { cwd: resolve(config.cwd) } }
            : undefined
        },
      },
    })
  }

  override stream(options: GenerateOptions) {
    return super.stream(loopOwnedRequest(options))
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
  it('keeps the static-cwd catalog subprocess behind an explicit activation readiness boundary', async () => {
    const catalog = {
      currentValue: 'default',
      modelValues: ['default'],
      models: [{ id: 'default', name: 'TraeX default' }],
      completeReasoning: true,
      observedAt: 1,
    } as const
    const verifyAuth = vi.fn(async () => {})
    const discoverModels = vi.fn(async () => catalog)
    const runText = vi.fn(() => (async function* () { yield 'never' })())

    await expect(probeTraexReadiness(Config(), {}, { verifyAuth, discoverModels, runText }))
      .resolves.toEqual(catalog)

    expect(verifyAuth).toHaveBeenCalledTimes(1)
    expect(discoverModels).toHaveBeenCalledTimes(1)
    expect(runText).not.toHaveBeenCalled()
  })

  it('rejects an unmarked request before auth or ACP spawn even when its session id names a live session', async () => {
    const verifyAuth = vi.fn(async () => {})
    const runText = vi.fn(() => (async function* () { yield 'never' })())
    const adapter = new RawTraexAcpAdapter(Config(), {
      verifyAuth,
      runText,
      liveSessions: {
        get: () => ({ id: 'session-live', header: { cwd: process.cwd() } }),
      },
    } as never)
    const unmarked = deepFreeze({ ...request(), sessionId: 'session-live' as NonNullable<GenerateOptions['sessionId']> })

    await expect(adapter.stream(unmarked)[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      failure: { code: 'LOCAL_SESSION_CWD_REQUIRED' },
    })
    expect(verifyAuth).not.toHaveBeenCalled()
    expect(runText).not.toHaveBeenCalled()
  })

  it('rechecks the live session cwd after auth and before handing authority to the ACP runner', async () => {
    const verifyAuth = vi.fn(async () => {})
    const runText = vi.fn(() => (async function* () { yield 'never' })())
    let lookupCount = 0
    const adapter = new RawTraexAcpAdapter(Config(), {
      verifyAuth,
      runText,
      liveSessions: {
        get: () => {
          lookupCount += 1
          return lookupCount === 1
            ? { id: 'session-live', header: { cwd: process.cwd() } }
            : undefined
        },
      },
    } as never)
    const loopOwned = markAgentLoopRequest(deepFreeze({
      ...request(), sessionId: 'session-live' as NonNullable<GenerateOptions['sessionId']>,
    }))

    const iterator = adapter.stream(loopOwned)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ value: { type: 'block-start', index: 0, blockType: 'text' }, done: false })
    await expect(iterator.next()).rejects.toMatchObject({ failure: { code: 'LOCAL_SESSION_CWD_REQUIRED' } })
    expect(verifyAuth).toHaveBeenCalledTimes(1)
    expect(runText).not.toHaveBeenCalled()
  })

  it('rejects every invalid live-session shape before auth or ACP spawn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'traex-adapter-cwd-'))
    try {
      const workspace = join(root, 'workspace')
      const other = join(root, 'other')
      const escape = join(workspace, 'escape')
      await Promise.all([mkdir(workspace), mkdir(other)])
      await symlink(other, escape)
      const loopOwned = (sessionId: string) => markAgentLoopRequest(deepFreeze({
        ...request(), sessionId: sessionId as NonNullable<GenerateOptions['sessionId']>,
      }))
      const invalidCases = [
        { name: 'missing identity', options: markAgentLoopRequest(deepFreeze(request())), get: () => undefined },
        { name: 'stale session', options: loopOwned('session-stale'), get: () => undefined },
        {
          name: 'forged session result',
          options: loopOwned('session-claimed'),
          get: () => ({ id: 'session-other', header: { cwd: workspace } }),
        },
        {
          name: 'unmarked request',
          options: deepFreeze({ ...request(), sessionId: 'session-live' as NonNullable<GenerateOptions['sessionId']> }),
          get: () => ({ id: 'session-live', header: { cwd: workspace } }),
        },
        {
          name: 'mismatched cwd',
          options: loopOwned('session-live'),
          get: () => ({ id: 'session-live', header: { cwd: other } }),
        },
        {
          name: 'symlink escape',
          options: loopOwned('session-live'),
          get: () => ({ id: 'session-live', header: { cwd: escape } }),
        },
      ]

      for (const invalid of invalidCases) {
        const verifyAuth = vi.fn(async () => {})
        const runText = vi.fn(() => (async function* () { yield 'never' })())
        const adapter = new RawTraexAcpAdapter(Config({ cwd: workspace } as never), {
          verifyAuth,
          runText,
          liveSessions: { get: invalid.get } as never,
        })
        await expect(adapter.stream(invalid.options)[Symbol.asyncIterator]().next(), invalid.name)
          .rejects.toMatchObject({ failure: { code: 'LOCAL_SESSION_CWD_REQUIRED' } })
        expect(verifyAuth, invalid.name).not.toHaveBeenCalled()
        expect(runText, invalid.name).not.toHaveBeenCalled()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['resolveModel', 'listModels'] as const)(
    'keeps the prepareCall %s path process-free before a mismatched workspace is rejected',
    async operation => {
      const root = await mkdtemp(join(tmpdir(), 'traex-prepare-cwd-'))
      try {
        const workspace = join(root, 'workspace')
        const other = join(root, 'other')
        await Promise.all([mkdir(workspace), mkdir(other)])
        const verifyAuth = vi.fn(async () => {})
        const discoverModels = vi.fn(async () => ({
          currentValue: 'default',
          modelValues: ['default'],
          models: [{ id: 'default', name: 'TraeX default' }],
          completeReasoning: true,
          observedAt: 1,
        }))
        const runText = vi.fn(() => (async function* () { yield 'never' })())
        const adapter = new RawTraexAcpAdapter(Config({ cwd: workspace } as never), {
          verifyAuth,
          discoverModels,
          runText,
          liveSessions: {
            get: () => ({ id: TEST_SESSION_ID, header: { cwd: other } }),
          },
        } as never)

        // This mirrors the real loop order: resolveModel happens before the
        // immutable, loop-marked request reaches stream.  Neither that lookup nor
        // listModels may borrow the provider's static cwd for local process work.
        let preparedStream: ((options: GenerateOptions) => AsyncIterable<unknown>) | undefined
        let runtimeContext: Context | undefined
        if (operation === 'resolveModel') {
          runtimeContext = new Context()
          await runtimeContext.plugin(LlmRuntime)
          runtimeContext.llm.registerAdapter(['traex-agent'], adapter)
          const prepared = await runtimeContext.llm.prepareCall({ provider: 'traex-agent', model: 'default' })
          preparedStream = prepared.stream
        } else {
          await adapter.listModels('traex-agent')
        }
        const options = markAgentLoopRequest(deepFreeze({
          ...request(),
          sessionId: TEST_SESSION_ID,
        }))
        const stream = preparedStream === undefined ? adapter.stream(options) : preparedStream(options)
        const first = stream[Symbol.asyncIterator]().next()
        if (preparedStream === undefined) {
          await expect(first).rejects.toMatchObject({ failure: { code: 'LOCAL_SESSION_CWD_REQUIRED' } })
        } else {
          await expect(first).resolves.toMatchObject({
            value: { type: 'finish', reason: { kind: 'error', failure: { code: 'LOCAL_SESSION_CWD_REQUIRED' } } },
          })
        }

        expect(verifyAuth).not.toHaveBeenCalled()
        expect(discoverModels).not.toHaveBeenCalled()
        expect(runText).not.toHaveBeenCalled()
        await runtimeContext?.fiber.dispose()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('passes the canonical live-session cwd to both auth and the ACP runner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'traex-adapter-cwd-'))
    try {
      const workspace = join(root, 'workspace')
      const alias = join(root, 'workspace-alias')
      await mkdir(workspace)
      await symlink(workspace, alias)
      const verifyAuth = vi.fn(async () => {})
      let invocation: TraexAcpInvocation | undefined
      const adapter = new RawTraexAcpAdapter(Config({ cwd: alias } as never), {
        verifyAuth,
        runText(received, options) {
          invocation = received
          return (async function* () {
            yield 'ok'
            options?.onStopReason?.('end_turn')
          })()
        },
        liveSessions: {
          get: () => ({ id: 'session-live', header: { cwd: workspace } }),
        } as never,
      })
      const loopOwned = markAgentLoopRequest(deepFreeze({
        ...request(), sessionId: 'session-live' as NonNullable<GenerateOptions['sessionId']>,
      }))

      for await (const _chunk of adapter.stream(loopOwned)) { /* drain */ }

      const canonical = realpathSync.native(workspace)
      expect(verifyAuth).toHaveBeenCalledWith(expect.objectContaining({ cwd: canonical }))
      expect(invocation).toMatchObject({ cwd: canonical })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('discovers the live ACP catalog and makes every returned model selectable', async () => {
    const catalog = {
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
    }
    const discoverModels = vi.fn(() => Promise.resolve(catalog))
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth: async () => {},
      discoverModels,
      runText: (_invocation: TraexAcpInvocation, options?: RunTraexAcpOptions) => (async function* () {
        options?.onCatalogObserved?.(catalog)
        yield 'observed'
        options?.onStopReason?.('end_turn')
      })(),
    } as never)

    await expect(adapter.listModels('traex-agent')).resolves.toEqual([
      expect.objectContaining({ provider: 'traex-agent', id: 'default' }),
    ])
    expect(discoverModels).not.toHaveBeenCalled()
    for await (const _chunk of adapter.stream(request())) { /* observe the live ACP catalog */ }
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
    expect(discoverModels).not.toHaveBeenCalled()
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

  it('maps an envelope with a model progress preamble instead of leaking JSON as assistant text', async () => {
    const options = request()
    options.tools = [{
      name: 'read',
      description: 'Read a workspace file.',
      parameters: { type: 'object' },
    }]
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth: async () => {},
      runText(_invocation, runnerOptions) {
        return (async function* () {
          yield '我先读取关键文件，然后继续。\n\n'
          yield '{"protocol":"dsh-tool-calls/v1","calls":['
          yield '{"name":"read","arguments":{"path":"README.md"}}]}'
          runnerOptions?.onStopReason?.('end_turn')
        })()
      },
    })

    const chunks = []
    for await (const chunk of adapter.stream(options)) chunks.push(chunk)

    expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(false)
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      expect.objectContaining({
        type: 'tool-call-delta',
        index: 0,
        name: 'read',
        argumentsDelta: '{"path":"README.md"}',
      }),
      expect.objectContaining({
        type: 'block-end',
        index: 0,
        block: expect.objectContaining({ type: 'tool-call', name: 'read', arguments: '{"path":"README.md"}' }),
      }),
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

  it('surfaces an oversized prompt as a routable context-overflow code, never unclassified', async () => {
    // Regression: preflight used to rethrow the bare serialization Error, so DSH displayed an
    // UNKNOWN failure and the loop had no code to route on.
    const runText = vi.fn(() => (async function* () { yield 'never' })())
    const config = Config()
    config.maxPromptBytes = 1
    const adapter = new TraexAcpAdapter(config, { runText, verifyAuth: async () => {} })
    await expect((async () => {
      for await (const _chunk of adapter.stream(request())) { /* drain */ }
    })()).rejects.toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' })
    expect(runText).not.toHaveBeenCalled()
  })

  it('defaults maxPromptBytes well above a single argv-sized request', () => {
    // The ACP transport sends the prompt over stdin, so the old 128 KiB argv-derived default
    // rejected ordinary long conversations before the handshake even started.
    expect(Config().maxPromptBytes).toBeGreaterThanOrEqual(1024 * 1024)
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
