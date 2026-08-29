import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  QUOTA_EXCEEDED_CODE,
  CallId,
  createMessage,
  deepFreeze,
  errorChain,
  markAgentLoopRequest,
  ReasoningEffortId,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { realpathSync } from 'node:fs'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  CodingSubscriptionAdapter as RawCodingSubscriptionAdapter,
  redactDiagnostic,
  type AdapterDependencies,
} from '../src/adapter.ts'
import { SubscriptionAuthError } from '../src/auth.ts'
import { CodexDirectAuthError } from '../src/codex-direct-auth.ts'
import {
  CodexDirectResponsesError,
  type CodexDirectResponsesDependencies,
} from '../src/codex-direct-responses.ts'
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

const TEST_SESSION_ID = 'session-live' as NonNullable<GenerateOptions['sessionId']>

function loopOwnedRequest(options: GenerateOptions): GenerateOptions {
  return markAgentLoopRequest(deepFreeze({ ...options, sessionId: TEST_SESSION_ID }))
}

/**
 * Normal adapter behavior tests exercise the same immutable loop envelope that
 * the host dispatches.  Security-negative cases intentionally use the raw
 * adapter below so they cannot be accidentally normalized by the test fixture.
 */
class CodingSubscriptionAdapter extends RawCodingSubscriptionAdapter {
  constructor(
    config: ConstructorParameters<typeof RawCodingSubscriptionAdapter>[0],
    dependencies: AdapterDependencies = {},
  ) {
    super(config, {
      // Normal stream tests must never fall through to a real local catalog
      // subprocess.  Individual catalog tests override the matching discoverer.
      discoverCodexModels: async () => configuredCatalog(config.codex.models),
      discoverClaudeModels: async () => configuredCatalog(config.claude.models),
      discoverCursorModels: async () => configuredCatalog(config.cursor.models),
      discoverGrokModels: async () => configuredCatalog(config.grok.models),
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

function configuredCatalog(models: readonly string[]) {
  return {
    ...(models[0] === undefined ? {} : { defaultModel: models[0] }),
    models: models.map(id => ({ id, name: id, inputModalities: ['text'] as const })),
    observedAt: 1,
  }
}

function rejectedDirectStream(error: unknown): AsyncIterable<never> {
  return (async function* () {
    yield* []
    throw error
  })()
}

describe('coding subscription LLM adapter', () => {
  it('rejects an unmarked request before auth or CLI spawn even when its session id names a live session', async () => {
    const verifyAuth = vi.fn(async () => {})
    const runText = vi.fn(() => (async function* () { yield 'never' })())
    const adapter = new RawCodingSubscriptionAdapter(Config(), {
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

  it('settles a bare TrustedSessionCwdError as working-directory without relying on Error.cause', async () => {
    const settled: Array<{ outcome?: string; phase?: string }> = []
    const adapter = new RawCodingSubscriptionAdapter(Config(), {
      liveSessions: {
        get: () => ({ id: TEST_SESSION_ID, header: { cwd: process.cwd() } }),
      },
      onSettled: (context: { outcome?: string; phase?: string }) => { settled.push(context) },
    } as never)
    const unmarked = deepFreeze({ ...request(), sessionId: TEST_SESSION_ID })

    await expect(adapter.stream(unmarked)[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      failure: { code: 'LOCAL_SESSION_CWD_REQUIRED' },
    })
    expect(settled).toEqual([
      expect.objectContaining({ outcome: 'working-directory', phase: 'preflight' }),
    ])
  })

  it('rechecks the live session cwd after auth and before handing authority to the CLI runner', async () => {
    const verifyAuth = vi.fn(async () => {})
    const discoverCodexModels = vi.fn(async () => configuredCatalog(['default']))
    const runText = vi.fn(() => (async function* () { yield 'never' })())
    let lookupCount = 0
    const adapter = new RawCodingSubscriptionAdapter(Config(), {
      verifyAuth,
      discoverCodexModels,
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
    await expect(iterator.next()).rejects.toMatchObject({ failure: { code: 'LOCAL_SESSION_CWD_REQUIRED' } })
    expect(verifyAuth).toHaveBeenCalledTimes(1)
    expect(discoverCodexModels).not.toHaveBeenCalled()
    expect(runText).not.toHaveBeenCalled()
  })

  it('rejects every invalid live-session shape before auth or CLI spawn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coding-subscription-adapter-cwd-'))
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
        const adapter = new RawCodingSubscriptionAdapter(Config({ cwd: workspace } as never), {
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

  it(
    'keeps the prepareCall resolveModel path process-free before a mismatched workspace is rejected',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'coding-subscription-prepare-cwd-'))
      try {
        const workspace = join(root, 'workspace')
        const other = join(root, 'other')
        await Promise.all([mkdir(workspace), mkdir(other)])
        const verifyAuth = vi.fn(async () => {})
        const discoverCodexModels = vi.fn(async () => ({
          defaultModel: 'default',
          models: [{ id: 'default', name: 'Codex default', inputModalities: ['text'] as const }],
          observedAt: 1,
        }))
        const runText = vi.fn(() => (async function* () { yield 'never' })())
        const adapter = new RawCodingSubscriptionAdapter(Config({ cwd: workspace } as never), {
          verifyAuth,
          discoverCodexModels,
          runText,
          liveSessions: {
            get: () => ({ id: TEST_SESSION_ID, header: { cwd: other } }),
          },
        } as never)

        // dsh-agent-loop calls resolveModel from prepareCall before it creates the
        // loop-owned GenerateOptions passed to stream. It must remain process-free.
        const runtimeContext = new Context()
        await runtimeContext.plugin(LlmRuntime)
        runtimeContext.llm.registerAdapter(['codex-subscription'], adapter)
        const prepared = await runtimeContext.llm.prepareCall({
          provider: 'codex-subscription',
          model: 'default',
        })
        const options = markAgentLoopRequest(deepFreeze({
          ...request(),
          sessionId: TEST_SESSION_ID,
        }))
        const first = prepared.stream(options)[Symbol.asyncIterator]().next()
        await expect(first).resolves.toMatchObject({
          value: { type: 'finish', reason: { kind: 'error', failure: { code: 'LOCAL_SESSION_CWD_REQUIRED' } } },
        })

        expect(verifyAuth).not.toHaveBeenCalled()
        expect(discoverCodexModels).not.toHaveBeenCalled()
        expect(runText).not.toHaveBeenCalled()
        await runtimeContext.fiber.dispose()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it.each([
    'codex-subscription',
    'claude-subscription',
    'cursor-subscription',
    'grok-subscription',
  ] as const)('refreshes the cold %s catalog while keeping resolveModel process-free', async provider => {
    const verifyAuth = vi.fn(async () => {})
    const discoverCodexModels = vi.fn(async () => configuredCatalog(['codex-live']))
    const discoverClaudeModels = vi.fn(async () => configuredCatalog(['claude-live']))
    const discoverCursorModels = vi.fn(async () => configuredCatalog(['cursor-live']))
    const discoverGrokModels = vi.fn(async () => configuredCatalog(['grok-live']))
    const adapter = new RawCodingSubscriptionAdapter(Config(), {
      verifyAuth,
      discoverCodexModels,
      discoverClaudeModels,
      discoverCursorModels,
      discoverGrokModels,
    })

    const listed = await adapter.listModels(provider)
    const callsAfterList = [
      discoverCodexModels.mock.calls.length,
      discoverClaudeModels.mock.calls.length,
      discoverCursorModels.mock.calls.length,
      discoverGrokModels.mock.calls.length,
    ]
    await adapter.resolveModel(provider, 'default')

    expect(listed.map(model => model.id)).toContain(provider.replace('-subscription', '-live'))
    expect(verifyAuth).toHaveBeenCalledTimes(1)
    expect(callsAfterList.reduce((sum, count) => sum + count, 0)).toBe(1)
    expect([
      discoverCodexModels.mock.calls.length,
      discoverClaudeModels.mock.calls.length,
      discoverCursorModels.mock.calls.length,
      discoverGrokModels.mock.calls.length,
    ]).toEqual(callsAfterList)
  })

  it('passes the canonical live-session cwd to both auth and the CLI runner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coding-subscription-adapter-cwd-'))
    try {
      const workspace = join(root, 'workspace')
      const alias = join(root, 'workspace-alias')
      await mkdir(workspace)
      await symlink(workspace, alias)
      const verifyAuth = vi.fn(async () => {})
      let invocation: CliInvocation | undefined
      const adapter = new RawCodingSubscriptionAdapter(Config({ cwd: alias } as never), {
        verifyAuth,
        discoverCodexModels: async () => configuredCatalog(['default']),
        runText(received) {
          invocation = received
          return (async function* () { yield 'ok' })()
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
      expect(verifyAuth).toHaveBeenCalledWith('codex', expect.objectContaining({ cwd: canonical }))
      expect(invocation).toMatchObject({ cwd: canonical })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

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
    const verifyAuth = vi.fn(async () => {})
    const order: string[] = []
    verifyAuth.mockImplementation(async () => { order.push('auth') })
    discoverCodexModels.mockImplementation(async () => {
      order.push('discover')
      return {
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
      }
    })
    const adapter = new CodingSubscriptionAdapter(Config(), {
      verifyAuth,
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
    expect(verifyAuth).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['auth', 'discover'])
    expect(adapter.providerRetryPolicy('codex-subscription')).toMatchObject({ mode: 'normal', maxRetries: 0 })
  })

  it('deduplicates concurrent cold listModels refreshes', async () => {
    let resolveCatalog!: (catalog: ReturnType<typeof configuredCatalog>) => void
    const pendingCatalog = new Promise<ReturnType<typeof configuredCatalog>>(resolve => {
      resolveCatalog = resolve
    })
    const verifyAuth = vi.fn(async () => {})
    const discoverCodexModels = vi.fn(async () => pendingCatalog)
    const adapter = new CodingSubscriptionAdapter(Config(), { verifyAuth, discoverCodexModels })

    const first = adapter.listModels('codex-subscription')
    const second = adapter.listModels('codex-subscription')
    await vi.waitFor(() => expect(discoverCodexModels).toHaveBeenCalledTimes(1))
    expect(verifyAuth).toHaveBeenCalledTimes(1)
    resolveCatalog(configuredCatalog(['codex-live']))

    const [firstModels, secondModels] = await Promise.all([first, second])
    expect(firstModels.map(model => model.id)).toContain('codex-live')
    expect(secondModels.map(model => model.id)).toContain('codex-live')
    expect(discoverCodexModels).toHaveBeenCalledTimes(1)
  })

  it('does not make a stream wait for an in-flight listModels refresh', async () => {
    let resolveCatalog!: (catalog: ReturnType<typeof configuredCatalog>) => void
    const pendingCatalog = new Promise<ReturnType<typeof configuredCatalog>>(resolve => {
      resolveCatalog = resolve
    })
    const discoverCodexModels = vi.fn(async () => pendingCatalog)
    const verifyAuth = vi.fn(async () => {})
    const runText = vi.fn(() => (async function* () { yield 'generated without catalog' })())
    const adapter = new CodingSubscriptionAdapter(Config(), {
      verifyAuth,
      discoverCodexModels,
      runText,
    })
    const listed = adapter.listModels('codex-subscription')
    await vi.waitFor(() => expect(discoverCodexModels).toHaveBeenCalledOnce())
    const chunks = []
    for await (const chunk of adapter.stream(request())) chunks.push(chunk)

    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(runText).toHaveBeenCalledOnce()
    expect(discoverCodexModels).toHaveBeenCalledOnce()
    resolveCatalog(configuredCatalog(['codex-live']))
    await expect(listed).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'codex-live' }),
    ]))
    expect(verifyAuth).toHaveBeenCalledTimes(2)
  })

  it('never starts catalog discovery for concurrent cold streams with different signals', async () => {
    const discoverCodexModels = vi.fn(async () => new Promise<never>(() => {}))
    const verifyAuth = vi.fn(async () => {})
    const runText = vi.fn(() => (async function* () { yield 'generated' })())
    const adapter = new CodingSubscriptionAdapter(Config(), {
      verifyAuth,
      discoverCodexModels,
      runText,
    })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const drain = async (signal: AbortSignal): Promise<void> => {
      for await (const _chunk of adapter.stream({ ...request(), signal })) { /* drain */ }
    }

    await Promise.all([drain(firstController.signal), drain(secondController.signal)])

    expect(discoverCodexModels).not.toHaveBeenCalled()
    expect(verifyAuth).toHaveBeenCalledTimes(2)
    expect(runText).toHaveBeenCalledTimes(2)
  })

  it('refreshes an expired catalog and reuses it before the five-minute TTL', async () => {
    let now = 1_000
    const verifyAuth = vi.fn(async () => {})
    const discoverCodexModels = vi.fn()
      .mockResolvedValueOnce(configuredCatalog(['codex-v1']))
      .mockResolvedValueOnce(configuredCatalog(['codex-v2']))
    const adapter = new CodingSubscriptionAdapter(Config(), {
      verifyAuth,
      discoverCodexModels,
      now: () => now,
    })

    await expect(adapter.listModels('codex-subscription'))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'codex-v1' })]))
    now += 5 * 60_000 - 1
    await expect(adapter.listModels('codex-subscription'))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'codex-v1' })]))
    now += 1
    const refreshed = await adapter.listModels('codex-subscription')

    expect(refreshed.map(model => model.id)).toContain('codex-v2')
    expect(refreshed.map(model => model.id)).not.toContain('codex-v1')
    expect(verifyAuth).toHaveBeenCalledTimes(2)
    expect(discoverCodexModels).toHaveBeenCalledTimes(2)
  })

  it('falls back to configured models and emits a credential-free diagnostic when refresh fails', async () => {
    const secret = 'sk-super-secret-catalog-value'
    const diagnostics: string[] = []
    const config = Config({ codex: { models: ['default', 'configured-model'] } } as never)
    const adapter = new CodingSubscriptionAdapter(config, {
      verifyAuth: async () => {},
      discoverCodexModels: async () => {
        throw new Error(`failed with ${secret}`)
      },
      onDiagnostic: (_route, diagnostic) => { diagnostics.push(diagnostic) },
    })

    await expect(adapter.listModels('codex-subscription')).resolves.toEqual([
      expect.objectContaining({ id: 'default' }),
      expect.objectContaining({ id: 'configured-model' }),
    ])
    expect(diagnostics).toEqual(['model catalog refresh failed; outcome=io; using configured models'])
    expect(diagnostics.join(' ')).not.toContain(secret)
  })

  it('never forwards raw catalog stderr to the diagnostic sink', async () => {
    const secret = 'arbitrary-business-secret-that-is-not-pattern-redactable'
    const diagnostics: string[] = []
    const discoverCodexModels = vi.fn(async (_invocation, options) => {
      options?.onDiagnostic?.(`catalog stderr contained ${secret}`)
      return configuredCatalog(['codex-live'])
    })
    const adapter = new CodingSubscriptionAdapter(Config(), {
      verifyAuth: async () => {},
      discoverCodexModels,
      onDiagnostic: (_route, diagnostic) => { diagnostics.push(diagnostic) },
    })

    await expect(adapter.listModels('codex-subscription')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'codex-live' }),
    ]))
    expect(diagnostics).toEqual(['model catalog probe wrote to stderr; content withheld'])
    expect(diagnostics.join(' ')).not.toContain(secret)
  })

  it('does not invoke advisory catalog discovery from a cold generation path', async () => {
    const diagnostics: string[] = []
    const discoverCodexModels = vi.fn(async () => { throw new Error('must not run') })
    const runText = vi.fn(() => (async function* () { yield 'generated without catalog' })())
    const adapter = new CodingSubscriptionAdapter(Config(), {
      verifyAuth: async () => {},
      discoverCodexModels,
      runText,
      onDiagnostic: (_route, diagnostic) => { diagnostics.push(diagnostic) },
    })
    const chunks = []

    for await (const chunk of adapter.stream(request())) chunks.push(chunk)

    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(runText).toHaveBeenCalledOnce()
    expect(discoverCodexModels).not.toHaveBeenCalled()
    expect(diagnostics).toEqual([])
  })

  it('exposes configured direct reasoning on a cold prepareCall and materializes its default without I/O', async () => {
    const config = Config({
      codex: {
        transport: 'direct-responses',
        directModel: 'gpt-direct-cold',
        directReasoningEfforts: ['low', 'high', 'ultra'],
        directDefaultReasoningEffort: 'low',
      },
    } as never)
    const runText = vi.fn(() => (async function* () { yield 'never' })())
    const verifyAuth = vi.fn(async () => {})
    const discoverCodexModels = vi.fn(async () => configuredCatalog(['never']))
    const requestResponses = vi.fn(async () => new Response('never'))
    const received: GenerateOptions[] = []
    const runCodexDirect = vi.fn((options: GenerateOptions) => (async function* () {
      received.push(options)
      yield { type: 'finish', reason: { kind: 'stop' } } as const
    })())
    const adapter = new RawCodingSubscriptionAdapter(config, {
      runText,
      verifyAuth,
      discoverCodexModels,
      codexCredentials: { requestResponses },
      runCodexDirect,
      liveSessions: {
        get: () => ({ id: TEST_SESSION_ID, header: { cwd: process.cwd() } }),
      },
    } as never)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['codex-subscription'], adapter)

    const explicit = await ctx.llm.prepareCall({
      provider: 'codex-subscription',
      model: 'default',
      reasoningEffort: ReasoningEffortId('ultra'),
    })
    expect(explicit.config.reasoningEffort).toBe('ultra')

    const prepared = await ctx.llm.prepareCall({ provider: 'codex-subscription', model: 'default' })
    expect(prepared.config.reasoningEffort).toBe('low')
    const defaultReasoningEffort = prepared.config.reasoningEffort
    if (defaultReasoningEffort === undefined) throw new Error('expected a configured direct reasoning default')
    expect(prepared.adapterDefaults).toEqual({ reasoningEffort: true })
    expect(runCodexDirect).not.toHaveBeenCalled()
    expect(requestResponses).not.toHaveBeenCalled()
    expect(verifyAuth).not.toHaveBeenCalled()
    expect(discoverCodexModels).not.toHaveBeenCalled()
    expect(runText).not.toHaveBeenCalled()

    const dispatched = markAgentLoopRequest(deepFreeze({
      ...request(),
      reasoningEffort: defaultReasoningEffort,
      sessionId: TEST_SESSION_ID,
    }))
    const chunks = []
    for await (const chunk of prepared.stream(dispatched)) chunks.push(chunk)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ model: 'gpt-direct-cold', reasoningEffort: 'low' })
    expect(verifyAuth).not.toHaveBeenCalled()
    expect(discoverCodexModels).not.toHaveBeenCalled()
    expect(runText).not.toHaveBeenCalled()

    await ctx.fiber.dispose()
  })

  it('uses private Responses display metadata and resolves the default alias to the concrete direct model name', async () => {
    const config = Config({
      codex: { transport: 'direct-responses', directModel: 'gpt-private-display' },
    } as never)
    const adapter = new CodingSubscriptionAdapter(config)

    expect(adapter.providerInfo('codex-subscription').name).toContain('private Responses')
    expect(adapter.providerInfo('codex-subscription').name).not.toContain('local CLI')
    await expect(adapter.listModels('codex-subscription')).resolves.toEqual([
      expect.objectContaining({
        id: 'default',
        name: expect.stringContaining('gpt-private-display'),
      }),
    ])
    await expect(adapter.resolveModel('codex-subscription', 'default')).resolves.toMatchObject({
      name: expect.stringContaining('gpt-private-display'),
      reasoning: {
        efforts: [
          { id: 'low', name: 'low' },
          { id: 'medium', name: 'medium' },
          { id: 'high', name: 'high' },
          { id: 'xhigh', name: 'xhigh' },
          { id: 'max', name: 'max' },
          { id: 'ultra', name: 'ultra' },
        ],
        defaultEffort: 'low',
      },
    })
  })

  it('keeps CLI display and reasoning metadata independent from direct-only configuration', async () => {
    const config = Config({
      codex: {
        transport: 'cli',
        directModel: 'must-not-appear',
        directReasoningEfforts: ['low', 'ultra'],
        directDefaultReasoningEffort: 'ultra',
      },
    } as never)
    const adapter = new CodingSubscriptionAdapter(config)

    expect(adapter.providerInfo('codex-subscription').name).toContain('local CLI')
    const resolved = await adapter.resolveModel('codex-subscription', 'default')
    expect(resolved.name).not.toContain('must-not-appear')
    expect(resolved.reasoning).toBeUndefined()
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
      runText: () => (async function* () { yield 'observed' })(),
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

  it('keeps the default CLI route isolated from every direct Responses seam', async () => {
    const requestResponses = vi.fn(async () => new Response('never'))
    const runCodexDirect = vi.fn(() => (async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } } as const
    })())
    const runText = vi.fn(() => (async function* () { yield 'cli only' })())
    const adapter = new CodingSubscriptionAdapter(Config(), {
      codexCredentials: { requestResponses },
      runCodexDirect,
      runText,
      verifyAuth: async () => {},
    })

    const chunks = []
    for await (const chunk of adapter.stream(request())) chunks.push(chunk)

    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(runText).toHaveBeenCalledOnce()
    expect(runCodexDirect).not.toHaveBeenCalled()
    expect(requestResponses).not.toHaveBeenCalled()
  })

  it.each([
    ['codex-subscription', 'codex'],
    ['claude-subscription', 'claude'],
    ['cursor-subscription', 'cursor'],
    ['grok-subscription', 'grok'],
  ] as const)('bridges one exact DSH tool call through the %s CLI route', async (provider, idPrefix) => {
    const runText = vi.fn((_invocation: CliInvocation) => (async function* () {
      yield '{"protocol":"dsh-tool-calls/v1","calls":['
      yield '{"name":"allowed_tool","arguments":{"value":"from-cli"}}]}'
    })())
    const verifyAuth = vi.fn(async () => {})
    const adapter = new CodingSubscriptionAdapter(Config(), { runText, verifyAuth })
    const withTools: GenerateOptions = {
      ...providerRequest(provider),
      tools: [{
        name: 'allowed_tool',
        description: 'A tool the caller expects to be callable.',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
      }],
    }

    const chunks = []
    for await (const chunk of adapter.stream(withTools)) chunks.push(chunk)

    const callDelta = chunks.find(chunk => chunk.type === 'tool-call-delta')
    expect(callDelta).toMatchObject({
      type: 'tool-call-delta',
      index: 0,
      name: 'allowed_tool',
      argumentsDelta: '{"value":"from-cli"}',
    })
    if (callDelta?.type !== 'tool-call-delta') throw new Error('missing bridged tool call')
    expect(String(callDelta.id)).toMatch(new RegExp(`^${idPrefix}-[0-9a-f-]{36}$`, 'u'))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      callDelta,
      {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: callDelta.id,
          name: 'allowed_tool',
          arguments: '{"value":"from-cli"}',
        },
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
    expect(verifyAuth).toHaveBeenCalledOnce()
    expect(runText).toHaveBeenCalledOnce()
    expect(runText.mock.calls[0]?.[0].args.join(' ')).toContain('dsh-tool-calls/v1')
  })

  it('buffers an ordinary final response when tools are present so bridge JSON never leaks', async () => {
    const runText = vi.fn(() => (async function* () {
      yield 'task '
      yield 'complete'
    })())
    const adapter = new CodingSubscriptionAdapter(Config(), { runText, verifyAuth: async () => {} })
    const withTools: GenerateOptions = {
      ...request(),
      tools: [{ name: 'allowed_tool', description: 'Allowed.', parameters: { type: 'object' } }],
    }

    const chunks = []
    for await (const chunk of adapter.stream(withTools)) chunks.push(chunk)

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'task complete' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'task complete' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('does not project a buffered tool call when cancellation wins as the CLI settles', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled before bridge projection', { cause: 'abort' })
    const settled: Array<{ outcome?: string; assistantTextForwarded?: boolean }> = []
    const runText = vi.fn(() => (async function* () {
      yield '{"protocol":"dsh-tool-calls/v1","calls":[{"name":"allowed_tool","arguments":{}}]}'
      controller.abort(reason)
    })())
    const adapter = new CodingSubscriptionAdapter(Config(), {
      runText,
      verifyAuth: async () => {},
      onSettled: context => { settled.push(context) },
    })
    const withTools: GenerateOptions = {
      ...request(),
      signal: controller.signal,
      tools: [{ name: 'allowed_tool', description: 'Allowed.', parameters: { type: 'object' } }],
    }
    const chunks: StreamChunk[] = []

    await expect((async () => {
      for await (const chunk of adapter.stream(withTools)) chunks.push(chunk)
    })()).rejects.toBe(reason)

    expect(chunks).toEqual([])
    expect(settled).toEqual([
      expect.objectContaining({ outcome: 'aborted', assistantTextForwarded: false }),
    ])
  })

  it('stops bridge projection at the next chunk boundary after cancellation', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled during bridge projection', { cause: 'abort' })
    const settled: Array<{ outcome?: string; assistantTextForwarded?: boolean }> = []
    const adapter = new CodingSubscriptionAdapter(Config(), {
      runText: () => (async function* () {
        yield '{"protocol":"dsh-tool-calls/v1","calls":[{"name":"allowed_tool","arguments":{}}]}'
      })(),
      verifyAuth: async () => {},
      onSettled: context => { settled.push(context) },
    })
    const iterator = adapter.stream({
      ...request(),
      signal: controller.signal,
      tools: [{ name: 'allowed_tool', description: 'Allowed.', parameters: { type: 'object' } }],
    })[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'block-start', index: 0, blockType: 'tool-call' },
    })
    controller.abort(reason)
    await expect(iterator.next()).rejects.toBe(reason)

    expect(settled).toEqual([
      expect.objectContaining({ outcome: 'aborted', assistantTextForwarded: false }),
    ])
  })

  it('does not report a buffered tool response as successful when the consumer stops mid-projection', async () => {
    const settled: Array<{ outcome?: string; assistantTextForwarded?: boolean }> = []
    const adapter = new CodingSubscriptionAdapter(Config(), {
      runText: () => (async function* () {
        yield '{"protocol":"dsh-tool-calls/v1","calls":[{"name":"allowed_tool","arguments":{}}]}'
      })(),
      verifyAuth: async () => {},
      onSettled: context => { settled.push(context) },
    })
    const iterator = adapter.stream({
      ...request(),
      tools: [{ name: 'allowed_tool', description: 'Allowed.', parameters: { type: 'object' } }],
    })[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'block-start', index: 0, blockType: 'tool-call' },
    })
    await iterator.return?.()

    expect(settled).toEqual([
      expect.objectContaining({ outcome: 'aborted', assistantTextForwarded: false }),
    ])
  })

  it('fails a malformed or unauthorized DSH envelope without forwarding its text', async () => {
    const settled: Array<{ outcome?: string; assistantTextForwarded?: boolean }> = []
    const runText = vi.fn(() => (async function* () {
      yield 'progress\n{"protocol":"dsh-tool-calls/v1","calls":['
      yield '{"name":"forbidden_tool","arguments":{}}]}'
    })())
    const adapter = new CodingSubscriptionAdapter(Config(), {
      runText,
      verifyAuth: async () => {},
      onSettled: context => { settled.push(context) },
    })
    const withTools: GenerateOptions = {
      ...request(),
      tools: [{ name: 'allowed_tool', description: 'Allowed.', parameters: { type: 'object' } }],
    }

    await expect((async () => {
      for await (const _chunk of adapter.stream(withTools)) { /* drain */ }
    })()).rejects.toMatchObject({ failure: { code: 'CLI_PROTOCOL_ERROR' } })
    expect(settled).toEqual([
      expect.objectContaining({ outcome: 'protocol', assistantTextForwarded: false }),
    ])
  })

  it('uses the opt-in Codex direct transport for image/tool capable requests without invoking CLI seams', async () => {
    const config = Config()
    config.codex.transport = 'direct-responses'
    config.codex.directModel = 'gpt-direct-test'
    const verifyAuth = vi.fn(async () => {})
    const discoverCodexModels = vi.fn(async () => configuredCatalog(['default']))
    const runText = vi.fn(() => (async function* () { yield 'never' })())
    const runCodexDirect = vi.fn((_received: GenerateOptions) => (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' } as const
      yield {
        type: 'tool-call-delta', index: 0, id: CallId('call-direct'), name: 'allowed_tool', argumentsDelta: '{}',
      } as const
      yield {
        type: 'block-end', index: 0,
        block: { type: 'tool-call', id: CallId('call-direct'), name: 'allowed_tool', arguments: '{}' },
      } as const
      yield { type: 'finish', reason: { kind: 'tool-calls' } } as const
    })())
    const adapter = new CodingSubscriptionAdapter(config, {
      verifyAuth,
      discoverCodexModels,
      runText,
      runCodexDirect,
      attachments: {
        readImage: async ref => ({ ref, data: new Uint8Array([1, 2, 3]) }),
      },
    })
    const withTools: GenerateOptions = {
      ...request(),
      tools: [{
        name: 'allowed_tool',
        description: 'Allowed by the DSH policy layer.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      }],
    }

    await expect(adapter.listModels('codex-subscription')).resolves.toEqual([
      expect.objectContaining({ id: 'default', inputModalities: ['text', 'image'] }),
    ])
    await expect(adapter.resolveModel('codex-subscription', 'default')).resolves.toMatchObject({
      id: 'default',
      inputModalities: ['text', 'image'],
    })
    const chunks = []
    for await (const chunk of adapter.stream(withTools)) chunks.push(chunk)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(runCodexDirect).toHaveBeenCalledTimes(1)
    expect(runCodexDirect.mock.calls[0]?.[0]).toMatchObject({ model: 'gpt-direct-test', tools: withTools.tools })
    expect(verifyAuth).not.toHaveBeenCalled()
    expect(discoverCodexModels).not.toHaveBeenCalled()
    expect(runText).not.toHaveBeenCalled()
  })

  it('looks up the optional attachment store once per operation instead of retaining a stale snapshot', async () => {
    const config = Config({ codex: { transport: 'direct-responses' } } as never)
    const firstStore = {
      readImage: async (ref: never, _signal?: AbortSignal) => ({ ref, data: new Uint8Array([1]) }),
    }
    const secondStore = {
      readImage: async (ref: never, _signal?: AbortSignal) => ({ ref, data: new Uint8Array([2]) }),
    }
    let current: CodexDirectResponsesDependencies['attachments']
    const getAttachments = vi.fn(() => current)
    const receivedAttachments: Array<CodexDirectResponsesDependencies['attachments']> = []
    const runCodexDirect = vi.fn((_options: GenerateOptions, dependencies: CodexDirectResponsesDependencies) => {
      receivedAttachments.push(dependencies.attachments)
      current = secondStore as never
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } } as const
      })()
    })
    const adapter = new CodingSubscriptionAdapter(config, { getAttachments, runCodexDirect } as never)

    await expect(adapter.listModels('codex-subscription')).resolves.toEqual([
      expect.objectContaining({ inputModalities: ['text'] }),
    ])
    expect(getAttachments).toHaveBeenCalledOnce()

    current = firstStore as never
    getAttachments.mockClear()
    await expect(adapter.resolveModel('codex-subscription', 'default')).resolves.toMatchObject({
      inputModalities: ['text', 'image'],
    })
    expect(getAttachments).toHaveBeenCalledOnce()

    current = firstStore as never
    getAttachments.mockClear()
    for await (const _chunk of adapter.stream(request())) { /* drain */ }
    expect(getAttachments).toHaveBeenCalledOnce()
    expect(receivedAttachments).toEqual([firstStore])

    current = undefined
    getAttachments.mockClear()
    await expect(adapter.listModels('codex-subscription')).resolves.toEqual([
      expect.objectContaining({ inputModalities: ['text'] }),
    ])
    expect(getAttachments).toHaveBeenCalledOnce()
  })

  it('treats Agent Loop maxTokens as a host-local budget and omits it from the private request', async () => {
    const config = Config({
      codex: { transport: 'direct-responses', directModel: 'gpt-direct-budget' },
    } as never)
    let serialized = ''
    const requestResponses = vi.fn(async (body: string) => {
      serialized = body
      const events = [
        {
          type: 'response.output_item.done',
          item: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'budgeted' }],
          },
        },
        { type: 'response.completed', response: { id: 'resp-budget' } },
      ]
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const verifyAuth = vi.fn(async () => {})
    const discoverCodexModels = vi.fn(async () => configuredCatalog(['never']))
    const runText = vi.fn(() => (async function* () { yield 'never' })())
    const adapter = new CodingSubscriptionAdapter(config, {
      codexCredentials: { requestResponses },
      verifyAuth,
      discoverCodexModels,
      runText,
    })

    const chunks = []
    for await (const chunk of adapter.stream({ ...request(), maxTokens: 321 })) chunks.push(chunk)

    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(requestResponses).toHaveBeenCalledOnce()
    const body = JSON.parse(serialized) as Record<string, unknown>
    expect(body).not.toHaveProperty('max_output_tokens')
    expect(body).not.toHaveProperty('maxTokens')
    expect(verifyAuth).not.toHaveBeenCalled()
    expect(discoverCodexModels).not.toHaveBeenCalled()
    expect(runText).not.toHaveBeenCalled()
  })

  it('continues to reject an explicit direct temperature before the request seam', async () => {
    const config = Config({ codex: { transport: 'direct-responses' } } as never)
    const requestResponses = vi.fn(async () => new Response('never'))
    let context: { phase?: string; promptSubmissionState?: string; teardownState?: string } | undefined
    const adapter = new CodingSubscriptionAdapter(config, {
      codexCredentials: { requestResponses },
      onSettled: value => { context = value },
    })

    await expect(adapter.stream({ ...request(), temperature: 0 })[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ failure: { code: 'CLI_PROTOCOL_ERROR' } })
    expect(requestResponses).not.toHaveBeenCalled()
    expect(context).toMatchObject({
      phase: 'preflight',
      promptSubmissionState: 'not-submitted',
      teardownState: 'not-started',
    })
  })

  it('advances direct lifecycle state when the credential request seam starts', async () => {
    const config = Config({ codex: { transport: 'direct-responses' } } as never)
    let context: { phase?: string; promptSubmissionState?: string; assistantTextForwarded?: boolean } | undefined
    const requestResponses = vi.fn(async () => {
      throw new CodexDirectAuthError('request seam failed', 'transport')
    })
    const adapter = new CodingSubscriptionAdapter(config, {
      codexCredentials: { requestResponses },
      onSettled: value => { context = value },
    })

    await expect(adapter.stream(request())[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ failure: { code: 'CODEX_DIRECT_TRANSPORT_ERROR' } })
    expect(requestResponses).toHaveBeenCalledOnce()
    expect(context).toMatchObject({
      phase: 'stream',
      promptSubmissionState: 'unknown',
      assistantTextForwarded: false,
    })
  })

  it.each([
    ['empty-response', EMPTY_RESPONSE_CODE, 'Codex private Responses returned no visible output'],
    ['context-window', CONTEXT_WINDOW_EXCEEDED_CODE, 'Codex private Responses exceeded the model context window'],
    ['quota', QUOTA_EXCEEDED_CODE, 'Codex private Responses account quota was exhausted'],
    ['provider-failure', 'CODEX_DIRECT_PROVIDER_FAILURE', 'Codex private Responses reported a provider failure'],
    ['content-filter', 'CODEX_DIRECT_CONTENT_FILTER', 'Codex private Responses output was filtered'],
  ] as const)('maps direct %s to a stable redacted DSH failure', async (cause, code, message) => {
    const config = Config({ codex: { transport: 'direct-responses' } } as never)
    const providerSecret = `provider-secret-${cause}`
    const runCodexDirect = () => rejectedDirectStream(new CodexDirectResponsesError(providerSecret, cause))
    const adapter = new CodingSubscriptionAdapter(config, { runCodexDirect })
    let caught: unknown

    try {
      for await (const _chunk of adapter.stream(request())) { /* drain */ }
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toMatchObject({ failure: { code, message } })
    expect(errorChain(caught)).not.toContain(providerSecret)
  })

  it.each([
    [new CodexDirectResponsesError('provider-secret-http', 'provider-http', 503), 503],
    [new CodexDirectAuthError('auth-secret-http', 'provider-http', 429), 429],
  ] as const)('preserves a valid typed direct HTTP status without exposing its source message', async (error, status) => {
    const config = Config({ codex: { transport: 'direct-responses' } } as never)
    const runCodexDirect = () => rejectedDirectStream(error)
    const adapter = new CodingSubscriptionAdapter(config, { runCodexDirect })
    let caught: unknown

    try {
      for await (const _chunk of adapter.stream(request())) { /* drain */ }
    } catch (failure: unknown) {
      caught = failure
    }

    expect(caught).toMatchObject({
      failure: {
        code: 'CODEX_DIRECT_PROVIDER_HTTP',
        message: 'Codex private Responses provider request failed',
        status,
      },
    })
    expect(errorChain(caught)).not.toContain(error.message)
  })

  it('retains subscription-auth status while keeping its established DSH code', async () => {
    const config = Config({ codex: { transport: 'direct-responses' } } as never)
    const error = new CodexDirectResponsesError('provider-secret-auth', 'subscription-auth', 401)
    const adapter = new CodingSubscriptionAdapter(config, {
      runCodexDirect: () => rejectedDirectStream(error),
    })
    let caught: unknown

    try {
      for await (const _chunk of adapter.stream(request())) { /* drain */ }
    } catch (failure: unknown) {
      caught = failure
    }

    expect(caught).toMatchObject({ failure: { code: 'SUBSCRIPTION_AUTH_REQUIRED', status: 401 } })
    expect(errorChain(caught)).not.toContain(error.message)
  })

  it.each([
    ['timeout', 'CLI_TIMEOUT', 'Codex private Responses request timed out'],
    ['protocol', 'CLI_PROTOCOL_ERROR', 'Codex private Responses returned an unrecognized or incomplete stream'],
    ['transport', 'CODEX_DIRECT_TRANSPORT_ERROR', 'Codex private Responses transport failed'],
  ] as const)('retains the direct %s failure class', async (cause, code, message) => {
    const config = Config({ codex: { transport: 'direct-responses' } } as never)
    const error = new CodexDirectAuthError(`redacted ${cause}`, cause)
    const adapter = new CodingSubscriptionAdapter(config, {
      runCodexDirect: () => rejectedDirectStream(error),
    })

    await expect((async () => {
      for await (const _chunk of adapter.stream(request())) { /* drain */ }
    })()).rejects.toMatchObject({ failure: { code, message } })
  })

  it('preserves an auth refresh 429 through the public LlmRuntime finish failure', async () => {
    const config = Config({ codex: { transport: 'direct-responses' } } as never)
    const requestResponses = vi.fn(async () => {
      throw new CodexDirectAuthError('Codex OAuth token refresh failed', 'provider-http', 429)
    })
    const adapter = new RawCodingSubscriptionAdapter(config, {
      codexCredentials: { requestResponses },
      liveSessions: {
        get: () => ({ id: TEST_SESSION_ID, header: { cwd: process.cwd() } }),
      },
    } as never)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['codex-subscription'], adapter)
    const prepared = await ctx.llm.prepareCall({ provider: 'codex-subscription', model: 'default' })
    const reasoningEffort = prepared.config.reasoningEffort
    if (reasoningEffort === undefined) throw new Error('expected a configured direct reasoning default')
    const chunks = []

    for await (const chunk of prepared.stream(loopOwnedRequest({ ...request(), reasoningEffort }))) chunks.push(chunk)

    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          code: 'CODEX_DIRECT_PROVIDER_HTTP',
          message: 'Codex private Responses provider request failed',
          status: 429,
        },
      },
    })
    expect(requestResponses).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('drops an invalid typed HTTP status instead of constructing an invalid LlmError', async () => {
    const config = Config({ codex: { transport: 'direct-responses' } } as never)
    const error = new CodexDirectAuthError('redacted invalid status', 'provider-http', 700)
    const adapter = new CodingSubscriptionAdapter(config, {
      runCodexDirect: () => rejectedDirectStream(error),
    })
    let caught: unknown

    try {
      for await (const _chunk of adapter.stream(request())) { /* drain */ }
    } catch (failure: unknown) {
      caught = failure
    }

    expect(caught).toMatchObject({ failure: { code: 'CODEX_DIRECT_PROVIDER_HTTP' } })
    expect(caught).not.toMatchObject({ failure: { status: expect.anything() } })
  })

  it('still serves a request that supplies an empty tool list', async () => {
    const runText = vi.fn(() => (async function* () { yield 'text only' })())
    const adapter = new CodingSubscriptionAdapter(Config(), { runText, verifyAuth: async () => {} })
    const chunks = []
    for await (const chunk of adapter.stream({ ...request(), tools: [] })) chunks.push(chunk)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(runText).toHaveBeenCalledTimes(1)
  })

  it('redacts common secrets before diagnostics are logged', () => {
    const redacted = redactDiagnostic('Authorization: Bearer abc123 token=xai-secret someone@example.com')
    expect(redacted).not.toContain('abc123')
    expect(redacted).not.toContain('xai-secret')
    expect(redacted).not.toContain('someone@example.com')
  })

  it('redacts normal CLI diagnostics at the adapter sink boundary', async () => {
    const raw = 'Authorization: Bearer abc123 token=xai-secret sk-adaptersecret someone@example.com'
    const diagnostics: string[] = []
    const runText = vi.fn((_invocation: CliInvocation, options?: RunCliTextOptions) => (async function* () {
      options?.onDiagnostic?.(raw)
      yield 'ok'
    })())
    const adapter = new CodingSubscriptionAdapter(Config(), {
      runText,
      verifyAuth: async () => {},
      onDiagnostic: (_route, diagnostic) => { diagnostics.push(diagnostic) },
    })

    for await (const _chunk of adapter.stream(request())) { /* drain */ }

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).not.toContain('abc123')
    expect(diagnostics[0]).not.toContain('xai-secret')
    expect(diagnostics[0]).not.toContain('sk-adaptersecret')
    expect(diagnostics[0]).not.toContain('someone@example.com')
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

  it('aborts and clears an in-flight catalog refresh on shutdown', async () => {
    let receivedSignal: AbortSignal | undefined
    const discoverCodexModels = vi.fn((_invocation, options) => {
      receivedSignal = options?.signal
      return new Promise<never>((_resolve, reject) => {
        receivedSignal?.addEventListener(
          'abort',
          () => reject(new Error('catalog stopped', { cause: 'abort' })),
          { once: true },
        )
      })
    })
    const adapter = new CodingSubscriptionAdapter(Config(), {
      verifyAuth: async () => {},
      discoverCodexModels,
    })
    const pending = adapter.listModels('codex-subscription')
    await vi.waitFor(() => expect(discoverCodexModels).toHaveBeenCalledOnce())

    adapter.shutdown()

    await expect(pending).resolves.toEqual([expect.objectContaining({ id: 'default' })])
    expect(receivedSignal?.aborted).toBe(true)
    await expect(adapter.listModels('codex-subscription'))
      .resolves.toEqual([expect.objectContaining({ id: 'default' })])
    expect(discoverCodexModels).toHaveBeenCalledOnce()
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
    const config = Config()
    let context: unknown
    const runText = (invocation: CliInvocation, options?: RunCliTextOptions) => (async function* (): AsyncIterable<string> {
      expect(invocation.cwd).toBe(process.cwd())
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
    const verifyAuth = vi.fn(async () => {})
    const config = Config()
    config.maxPromptBytes = 1
    const adapter = new CodingSubscriptionAdapter(config, {
      runText,
      verifyAuth,
      onSettled: value => { context = value },
    })
    await expect((async () => {
      for await (const _chunk of adapter.stream(request())) { /* drain */ }
    })()).rejects.toMatchObject({
      code: CONTEXT_WINDOW_EXCEEDED_CODE,
      message: expect.stringContaining('configured limit'),
    })
    expect(verifyAuth).not.toHaveBeenCalled()
    expect(runText).not.toHaveBeenCalled()
    expect(context).toMatchObject({
      phase: 'preflight',
      promptSubmissionState: 'not-submitted',
      outcome: 'preflight',
      teardownState: 'not-started',
    })
  })

  it('maps a direct Responses request-size refusal to the compaction-aware preflight failure', async () => {
    let context: { phase?: string; promptSubmissionState?: string; outcome?: string } | undefined
    const config = Config()
    config.codex.transport = 'direct-responses'
    const requestResponses = vi.fn(async () => new Response('never'))
    const runCodexDirect = vi.fn(() => rejectedDirectStream(
      new Error('Codex private Responses request exceeds the configured request limit', {
        cause: 'prompt-limit',
      }),
    ))
    const adapter = new CodingSubscriptionAdapter(config, {
      runCodexDirect,
      codexCredentials: { requestResponses },
      onSettled: value => { context = value },
    })

    await expect((async () => {
      for await (const _chunk of adapter.stream(request())) { /* drain */ }
    })()).rejects.toMatchObject({ code: CONTEXT_WINDOW_EXCEEDED_CODE })
    expect(requestResponses).not.toHaveBeenCalled()
    expect(context).toMatchObject({
      phase: 'preflight',
      promptSubmissionState: 'not-submitted',
      outcome: 'preflight',
    })
  })

  it('honors an already-aborted request before prompt serialization or any subprocess boundary', async () => {
    let context: { phase?: string; promptSubmissionState?: string; outcome?: string } | undefined
    const verifyAuth = vi.fn(async () => {})
    const runText = vi.fn(() => (async function* () { yield 'never' })())
    const controller = new AbortController()
    const reason = new Error('cancelled before preflight', { cause: 'abort' })
    controller.abort(reason)
    const config = Config()
    config.maxPromptBytes = 1
    const adapter = new CodingSubscriptionAdapter(config, {
      verifyAuth,
      runText,
      onSettled: value => { context = value },
    })

    await expect(adapter.stream({ ...request(), signal: controller.signal })[Symbol.asyncIterator]().next())
      .rejects.toBe(reason)
    expect(verifyAuth).not.toHaveBeenCalled()
    expect(runText).not.toHaveBeenCalled()
    expect(context).toMatchObject({
      phase: 'preflight',
      promptSubmissionState: 'not-submitted',
      outcome: 'aborted',
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
