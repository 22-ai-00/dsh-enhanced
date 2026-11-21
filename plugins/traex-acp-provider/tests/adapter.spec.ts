import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, {
  createMessage,
  createSystemMessage,
  isAgentLoopRequest,
  LlmAdapter,
  markAgentLoopRequest,
  ReasoningEffortId,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { deepFreeze } from './deep-freeze.ts'
import { createAgentLoopRequestAttestor } from '@dsh-enhanced/llm-route-capabilities'
import { realpathSync } from 'node:fs'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  AGY_PROVIDER_ROUTE,
  probeAcpReadiness,
  probeTraexReadiness,
  redactDiagnostic,
  TraexAcpAdapter as RawTraexAcpAdapter,
  type AdapterDependencies,
  type TraexAcpTextRunner,
} from '../src/adapter.ts'
import { buildAgyArgs, type RunTraexAcpOptions, type TraexAcpInvocation } from '../src/acp-client.ts'
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

  it('enforces the public readiness deadline when auth ignores cancellation', async () => {
    let receivedSignal: AbortSignal | undefined
    const discoverModels = vi.fn()
    const pending = probeTraexReadiness(Config(), { timeoutMs: 20 }, {
      verifyAuth: options => {
        receivedSignal = options.signal
        return new Promise<void>(() => {})
      },
      discoverModels,
    })

    await expect(pending).rejects.toMatchObject({ code: 'ACP_TIMEOUT' })
    expect(receivedSignal?.aborted).toBe(true)
    expect(discoverModels).not.toHaveBeenCalled()
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
        const adapter = new RawTraexAcpAdapter(Config({ cwd: workspace, cwdMode: 'exact' } as never), {
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
        const adapter = new RawTraexAcpAdapter(Config({ cwd: workspace, cwdMode: 'exact' } as never), {
          verifyAuth,
          discoverModels,
          runText,
          liveSessions: {
            get: () => ({ id: TEST_SESSION_ID, header: { cwd: other } }),
          },
        } as never)

        // This mirrors the real loop order: resolveModel happens before the immutable,
        // loop-marked request reaches stream. Resolution must not borrow the provider's
        // static cwd for local process work; listModels has its own prompt-free boundary.
        const runtimeContext = new Context()
        await runtimeContext.plugin(LlmRuntime)
        runtimeContext.llm.registerAdapter(['traex-agent'], adapter)
        const prepared = await runtimeContext.llm.prepareCall({ provider: 'traex-agent', model: 'default' })
        const options = markAgentLoopRequest(deepFreeze({
          ...request(),
          sessionId: TEST_SESSION_ID,
        }))
        const first = prepared.stream(options)[Symbol.asyncIterator]().next()
        await expect(first).resolves.toMatchObject({
          value: { type: 'finish', reason: { kind: 'error', failure: { code: 'LOCAL_SESSION_CWD_REQUIRED' } } },
        })

        expect(verifyAuth).not.toHaveBeenCalled()
        expect(discoverModels).not.toHaveBeenCalled()
        expect(runText).not.toHaveBeenCalled()
        await runtimeContext.fiber.dispose()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('binds default cwdMode session to another live session workspace while rejecting invalid or missing session cwds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'traex-session-cwd-mode-'))
    try {
      const missingConfigured = join(root, 'assistant-workspace')
      const other = join(root, 'other-repo')
      const alias = join(root, 'other-alias')
      await mkdir(other)
      await symlink(other, alias)

      const capturedAuthCwds: string[] = []
      const capturedRunCwds: string[] = []
      const verifyAuth = vi.fn(async (input: { cwd: string }) => {
        capturedAuthCwds.push(input.cwd)
      })
      const runText = vi.fn((invocation: TraexAcpInvocation, options?: RunTraexAcpOptions) => {
        capturedRunCwds.push(invocation.cwd)
        return (async function* () {
          yield 'ok-from-session-cwd'
          options?.onStopReason?.('end_turn')
        })()
      })
      const adapter = new RawTraexAcpAdapter(Config({ cwd: missingConfigured } as never), {
        verifyAuth,
        runText,
        liveSessions: {
          get(sessionId) {
            if (sessionId === TEST_SESSION_ID) return { id: TEST_SESSION_ID, header: { cwd: alias } }
            if (sessionId === 'session-missing-dir') {
              return { id: 'session-missing-dir' as never, header: { cwd: join(root, 'absent-dir') } }
            }
            if (sessionId === 'session-forged') return { id: 'session-different' as never, header: { cwd: other } }
            return undefined
          },
        },
      })

      const chunks: StreamChunk[] = []
      for await (const chunk of adapter.stream(loopOwnedRequest(request()))) chunks.push(chunk)
      expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
      expect(capturedAuthCwds).toEqual([realpathSync.native(other)])
      expect(capturedRunCwds).toEqual([realpathSync.native(other)])

      const badCases = [
        deepFreeze({ ...request(), sessionId: TEST_SESSION_ID }),
        markAgentLoopRequest(deepFreeze({ ...request(), sessionId: 'session-stale' as never })),
        markAgentLoopRequest(deepFreeze({ ...request(), sessionId: 'session-forged' as never })),
        markAgentLoopRequest(deepFreeze({ ...request(), sessionId: 'session-missing-dir' as never })),
      ]
      for (const bad of badCases) {
        await expect(adapter.stream(bad)[Symbol.asyncIterator]().next())
          .rejects.toMatchObject({ failure: { code: 'LOCAL_SESSION_CWD_REQUIRED' } })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('falls back to tmpdir during probeReadiness and listModels when configured cwd does not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'traex-discovery-cwd-'))
    try {
      const missingConfigured = join(root, 'absent-assistant-workspace')
      const authCwds: string[] = []
      const discoveryCwds: string[] = []
      const verifyAuth = vi.fn(async (input: { cwd: string }) => { authCwds.push(input.cwd) })
      const discoverModels = vi.fn(async (invocation: { cwd: string }) => {
        discoveryCwds.push(invocation.cwd)
        return {
          currentValue: 'default',
          modelValues: ['default'],
          models: [{ id: 'default', name: 'TraeX default' }],
          completeReasoning: true,
          observedAt: 1,
        }
      })

      const config = Config({ cwd: missingConfigured, enabled: true, agyEnabled: true } as never)
      const adapter = new RawTraexAcpAdapter(config, { verifyAuth, discoverModels })
      await expect(adapter.probeReadiness()).resolves.toMatchObject({ currentValue: 'default' })
      await expect(adapter.listModels(AGY_PROVIDER_ROUTE)).resolves.toMatchObject([{ id: 'default' }])
      expect(authCwds).toEqual([tmpdir(), tmpdir()])
      expect(discoveryCwds).toEqual([tmpdir(), tmpdir()])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts an attested compaction turn on cwdMode session and emits normal text without tool calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'traex-compaction-cwd-'))
    try {
      const project = join(root, 'project')
      await mkdir(project)
      const verifyAuth = vi.fn(async () => {})
      let capturedInvocation: TraexAcpInvocation | undefined
      const adapter = new RawTraexAcpAdapter(Config({ cwd: join(root, 'absent-workspace') } as never), {
        verifyAuth,
        liveSessions: {
          get: sessionId => sessionId === TEST_SESSION_ID ? { id: TEST_SESSION_ID, header: { cwd: project } } : undefined,
        },
        requestAttestor: {
          claim: () => false,
          claimCompaction: () => true,
        },
        runText: (invocation, options) => {
          capturedInvocation = invocation
          return (async function* () {
            yield 'checkpoint summary'
            options?.onStopReason?.('end_turn')
          })()
        },
      })

      const compaction = deepFreeze({
        ...request(),
        sessionId: TEST_SESSION_ID,
        purpose: 'compaction' as never,
        tools: [{ name: 'read', description: 'Read a file.', parameters: { type: 'object' } }],
      } as GenerateOptions)

      const chunks: StreamChunk[] = []
      for await (const chunk of adapter.stream(compaction)) chunks.push(chunk)
      expect(capturedInvocation?.cwd).toBe(realpathSync.native(project))
      expect(capturedInvocation?.prompt).toContain('Produce only the requested compaction checkpoint')
      expect(chunks).toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'checkpoint summary' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'checkpoint summary' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

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

  it('accepts the real forAdapter clone across isolated marker modules only inside the exact Host driver', async () => {
    const root = await mkdtemp(join(tmpdir(), 'traex-adapter-attestor-'))
    try {
      const workspace = join(root, 'workspace')
      await mkdir(workspace)
      const isolatedLlm = await import(
        /* @vite-ignore */ `${import.meta.resolve('@deepseek-ai/dsh-llm')}?foreign-agent-loop-marker`,
      ) as typeof import('@deepseek-ai/dsh-llm')
      const ctx = new Context()
      ctx.provide('sessionProjections', {
        register: async () => ({ stateOf: () => ({}), readerFor: () => () => ({}), dispose: async () => {} }),
      } as never)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(LlmRuntime)

      const historical = createMessage({
        role: 'assistant',
        source: {
          kind: 'model',
          provider: 'historical-route',
          model: 'old-model',
          replayState: { response: { id: 'old-response' } },
        },
        content: [{ type: 'text', text: 'old answer' }],
      })
      const system = createSystemMessage('Be concise.')
      const user = createMessage({
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'continue' }],
      })
      const session = {
        id: TEST_SESSION_ID,
        header: { cwd: workspace },
        requestHeader: () => ({
          config: { provider: 'traex-agent', model: 'default' },
          tools: [],
        }),
        toolHistory: () => ({ tools: [], updates: [] }),
        deriveMessages: () => [system, historical, user],
      } as unknown as Agent['session']
      const agent = {
        id: TEST_SESSION_ID,
        session,
        status: 'running',
        model: { current: () => ({ provider: 'traex-agent', model: 'default' }), select: () => {} },
        ctx,
      } as unknown as Agent
      ctx.agents.register(agent)

      const hostAttestor = createAgentLoopRequestAttestor(ctx.agents, ['traex-agent'])
      const claims: Array<{ request: GenerateOptions; session: object; accepted: boolean }> = []
      const adapter = new RawTraexAcpAdapter(Config({ cwd: workspace } as never), {
        liveSessions: { get: id => id === TEST_SESSION_ID ? session : undefined },
        requestAttestor: {
          claim(observed, claimedSession) {
            const accepted = hostAttestor.claim(observed, claimedSession)
            claims.push({ request: observed, session: claimedSession, accepted })
            return accepted
          },
        },
        verifyAuth: vi.fn(async () => {}),
        runText: vi.fn((_invocation, options) => (async function* () {
          yield 'ok'
          options?.onStopReason?.('end_turn')
        })()),
      })
      class HistoricalAdapter extends LlmAdapter {
        override async *stream(): AsyncIterable<StreamChunk> {
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
      ctx.llm.registerAdapter(['historical-route'], new HistoricalAdapter())
      ctx.llm.registerAdapter(['traex-agent'], adapter)

      const original = isolatedLlm.markAgentLoopRequest(deepFreeze({
        provider: 'traex-agent',
        model: 'default',
        messages: [system, historical, user],
        tools: [],
        toolHistory: session.toolHistory(),
        sessionId: TEST_SESSION_ID,
        signal: new AbortController().signal,
      }))
      expect(isolatedLlm.isAgentLoopRequest(original)).toBe(true)
      expect(isAgentLoopRequest(original)).toBe(false)

      const chunks = await ctx.agents.withInitiator(agent, async () => {
        const result: StreamChunk[] = []
        for await (const chunk of ctx.llm.stream(original)) result.push(chunk)
        return result
      })

      expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
      expect(claims).toHaveLength(2)
      expect(claims.every(claim => claim.accepted)).toBe(true)
      expect(claims.every(claim => claim.session === session)).toBe(true)
      const cloned = claims[0]!.request
      expect(claims[1]!.request).toBe(cloned)
      expect(cloned).not.toBe(original)
      expect(Object.isFrozen(cloned)).toBe(true)
      expect(isAgentLoopRequest(cloned)).toBe(false)
      expect(isolatedLlm.isAgentLoopRequest(cloned)).toBe(false)
      expect(cloned.messages[1]!.source).toEqual({
        kind: 'model',
        provider: 'historical-route',
        model: 'old-model',
      })
      expect(hostAttestor.claim(cloned, session)).toBe(false)
      await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('discovers the complete ACP catalog on the first list and reuses it for resolution', async () => {
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
    const verifyAuth = vi.fn(async () => {})
    const discoverModels = vi.fn(() => Promise.resolve(catalog))
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth,
      discoverModels,
    } as never)

    await expect(adapter.listModels('traex-agent')).resolves.toEqual([
      expect.objectContaining({ provider: 'traex-agent', id: 'default' }),
      expect.objectContaining({ provider: 'traex-agent', id: 'trae-fast', name: 'Trae Fast' }),
      expect.objectContaining({ provider: 'traex-agent', id: 'trae-pro', name: 'Trae Pro' }),
    ])
    expect(verifyAuth).toHaveBeenCalledTimes(1)
    expect(discoverModels).toHaveBeenCalledWith({
      command: 'traex',
      args: ['--sandbox', 'read-only', '--ask-for-approval', 'never', 'acp', 'serve'],
      cwd: process.cwd(),
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }))

    await expect(adapter.resolveModel('traex-agent', 'trae-pro')).resolves.toMatchObject({
      id: 'trae-pro',
      context: { contextWindow: 200_000 },
      reasoning: {
        efforts: [{ id: 'low', name: 'Low' }, { id: 'ultra', name: 'Ultra' }],
        defaultEffort: 'low',
      },
    })
    expect(verifyAuth).toHaveBeenCalledTimes(1)
    expect(discoverModels).toHaveBeenCalledTimes(1)
  })

  it('bounds auth and catalog discovery with one short model-list deadline', async () => {
    const catalog = {
      currentValue: 'default',
      modelValues: ['default'],
      models: [{ id: 'default', name: 'TraeX default' }],
      completeReasoning: true,
      observedAt: 1,
    } as const
    const deferred = Promise.withResolvers<typeof catalog>()
    let authSignal: AbortSignal | undefined
    let discoverySignal: AbortSignal | undefined
    let discoveryTimeoutMs: number | undefined
    const verifyAuth = vi.fn(async options => { authSignal = options.signal })
    const discoverModels = vi.fn((_invocation, options) => {
      discoverySignal = options?.signal
      discoveryTimeoutMs = options?.timeoutMs
      // Deliberately ignore cancellation: the adapter boundary must still settle listModels.
      return deferred.promise
    })
    const config = { ...Config(), authProbeTimeoutMs: 100 }
    const adapter = new TraexAcpAdapter(config, { verifyAuth, discoverModels })

    await expect(adapter.listModels('traex-agent')).resolves.toEqual([
      expect.objectContaining({ id: 'default' }),
    ])

    expect(verifyAuth).toHaveBeenCalledTimes(1)
    expect(discoverModels).toHaveBeenCalledTimes(1)
    expect(discoverySignal).toBe(authSignal)
    expect(discoverySignal?.aborted).toBe(true)
    expect(discoveryTimeoutMs).toBe(config.authProbeTimeoutMs)
    expect(adapter.peekObservedCatalog()).toBeUndefined()

    // Let the ignored dependency finish; a late result must not repopulate the timed-out cache.
    deferred.resolve(catalog)
    await Promise.resolve()
    expect(adapter.peekObservedCatalog()).toBeUndefined()
  })

  it('single-flights concurrent cold model-list discovery', async () => {
    const catalog = {
      currentValue: 'trae-fast',
      modelValues: ['trae-fast', 'trae-pro'],
      models: [
        { id: 'trae-fast', name: 'Trae Fast' },
        { id: 'trae-pro', name: 'Trae Pro' },
      ],
      completeReasoning: true,
      observedAt: 1,
    } as const
    const deferred = Promise.withResolvers<typeof catalog>()
    const verifyAuth = vi.fn(async () => {})
    const discoverModels = vi.fn(() => deferred.promise)
    const adapter = new TraexAcpAdapter(Config(), { verifyAuth, discoverModels })

    const pending = [
      adapter.listModels('traex-agent'),
      adapter.listModels('traex-agent'),
      adapter.listModels('traex-agent'),
    ]
    await vi.waitFor(() => {
      expect(verifyAuth).toHaveBeenCalledTimes(1)
      expect(discoverModels).toHaveBeenCalledTimes(1)
    })
    deferred.resolve(catalog)

    const results = await Promise.all(pending)
    for (const models of results) {
      expect(models).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'trae-fast' }),
        expect.objectContaining({ id: 'trae-pro' }),
      ]))
    }
    expect(verifyAuth).toHaveBeenCalledTimes(1)
    expect(discoverModels).toHaveBeenCalledTimes(1)
  })

  it('reuses a complete catalog within TTL and refreshes it after expiry', async () => {
    let clock = 0
    let discovery = 0
    const catalogs = [
      {
        currentValue: 'trae-first',
        modelValues: ['trae-first'],
        models: [{ id: 'trae-first', name: 'Trae First' }],
        completeReasoning: true,
        observedAt: 1,
      },
      {
        currentValue: 'trae-second',
        modelValues: ['trae-second'],
        models: [{ id: 'trae-second', name: 'Trae Second' }],
        completeReasoning: true,
        observedAt: 2,
      },
    ] as const
    const verifyAuth = vi.fn(async () => {})
    const discoverModels = vi.fn(async () => catalogs[discovery++]!)
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth,
      discoverModels,
      catalogCacheTtlMs: 1_000,
      catalogClock: () => clock,
    })

    await expect(adapter.listModels('traex-agent')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'trae-first' }),
    ]))
    clock = 999
    await expect(adapter.listModels('traex-agent')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'trae-first' }),
    ]))
    expect(verifyAuth).toHaveBeenCalledTimes(1)
    expect(discoverModels).toHaveBeenCalledTimes(1)

    clock = 1_000
    const refreshed = await adapter.listModels('traex-agent')
    expect(refreshed).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'trae-second' }),
    ]))
    expect(refreshed).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'trae-first' }),
    ]))
    expect(verifyAuth).toHaveBeenCalledTimes(2)
    expect(discoverModels).toHaveBeenCalledTimes(2)
  })

  it('does not let a failed concurrent readiness probe erase a newer complete catalog', async () => {
    const catalog = {
      currentValue: 'trae-pro',
      modelValues: ['trae-pro'],
      models: [{ id: 'trae-pro', name: 'Trae Pro' }],
      completeReasoning: true,
      observedAt: 1,
    } as const
    const first = Promise.withResolvers<typeof catalog>()
    const second = Promise.withResolvers<typeof catalog>()
    const discoverModels = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth: async () => {},
      discoverModels,
    })

    const successful = adapter.probeReadiness()
    const failing = adapter.probeReadiness()
    await vi.waitFor(() => { expect(discoverModels).toHaveBeenCalledTimes(2) })
    first.resolve(catalog)
    await expect(successful).resolves.toBe(catalog)
    second.reject(new Error('late failure', { cause: 'process' }))
    await expect(failing).rejects.toMatchObject({ code: 'ACP_PROCESS_FAILED' })

    expect(adapter.peekObservedCatalog()?.observation).toBe(catalog)
  })

  it('never forwards secret-bearing model-discovery diagnostics', async () => {
    const verifyAuth = vi.fn(async () => {})
    const discoverModels = vi.fn(async (_invocation, options) => {
      options?.onDiagnostic?.('Authorization: Bearer top-secret token=other-secret someone@example.com')
      throw new Error('token=top-secret someone@example.com', { cause: 'process' })
    })
    const onDiagnostic = vi.fn()
    const config = Config({ ...Config(), models: ['default', 'configured-safe'] } as never)
    const adapter = new TraexAcpAdapter(config, { verifyAuth, discoverModels, onDiagnostic })

    await expect(adapter.listModels('traex-agent')).resolves.toEqual([
      expect.objectContaining({ id: 'default' }),
      expect.objectContaining({ id: 'configured-safe' }),
    ])
    expect(verifyAuth).toHaveBeenCalledTimes(1)
    expect(discoverModels).toHaveBeenCalledTimes(1)
    expect(onDiagnostic.mock.calls.map(call => call[0])).toEqual([
      'TraeX model catalog discovery wrote to stderr; content withheld',
      'TraeX model catalog refresh failed; using configured model aliases',
    ])
    expect(onDiagnostic.mock.calls.flat().join(' ')).not.toContain('top-secret')
    expect(onDiagnostic.mock.calls.flat().join(' ')).not.toContain('other-secret')
    expect(onDiagnostic.mock.calls.flat().join(' ')).not.toContain('someone@example.com')
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

  it('redacts secret-bearing stream diagnostics at the adapter boundary', async () => {
    const onDiagnostic = vi.fn()
    const runText: TraexAcpTextRunner = (_invocation, options) => (async function* () {
      options?.onDiagnostic?.(
        'Authorization: Bearer stream-secret token=another-secret user@example.com',
      )
      yield 'ok'
      options?.onStopReason?.('end_turn')
    })()
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth: async () => {},
      runText,
      onDiagnostic,
    })

    for await (const _chunk of adapter.stream(request())) { /* drain */ }

    expect(onDiagnostic).toHaveBeenCalledOnce()
    const diagnostic = String(onDiagnostic.mock.calls[0]?.[0])
    expect(diagnostic).toContain('[redacted]')
    expect(diagnostic).toContain('[redacted-email]')
    expect(diagnostic).not.toContain('stream-secret')
    expect(diagnostic).not.toContain('another-secret')
    expect(diagnostic).not.toContain('user@example.com')
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

  it('aborts and clears an in-flight model-list discovery on shutdown', async () => {
    let receivedSignal: AbortSignal | undefined
    const discoverModels = vi.fn((_invocation, options) => {
      receivedSignal = options?.signal
      // Ignore cancellation deliberately: the adapter-owned boundary must still settle callers.
      return new Promise<never>(() => {})
    })
    const onDiagnostic = vi.fn()
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth: async () => {},
      discoverModels,
      onDiagnostic,
    })

    const pending = adapter.listModels('traex-agent')
    await vi.waitFor(() => { expect(discoverModels).toHaveBeenCalledTimes(1) })
    adapter.shutdown()

    await expect(pending).resolves.toEqual([
      expect.objectContaining({ id: 'default' }),
    ])
    expect(receivedSignal?.aborted).toBe(true)
    expect(adapter.peekObservedCatalog()).toBeUndefined()
    expect(onDiagnostic).not.toHaveBeenCalled()
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

  it('preserves a complete list catalog and its TTL across a later partial stream observation', async () => {
    let clock = 0
    const completeCatalog = {
      currentValue: 'default',
      modelValues: ['default', 'trae-pro'],
      models: [
        { id: 'default', name: 'TraeX default' },
        {
          id: 'trae-pro',
          name: 'Trae Pro',
          reasoning: {
            efforts: [{ id: 'high', name: 'High' }],
            defaultEffort: 'high',
          },
        },
      ],
      completeReasoning: true,
      observedAt: 1,
    } as const
    const discoverModels = vi.fn(async () => completeCatalog)
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth: async () => {},
      discoverModels,
      runText: runnerEmittingCatalog(['default']),
      catalogCacheTtlMs: 1_000,
      catalogClock: () => clock,
    })

    await expect(adapter.listModels('traex-agent')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'trae-pro' }),
    ]))
    expect(discoverModels).toHaveBeenCalledTimes(1)

    clock = 900
    for await (const _chunk of adapter.stream(request())) { /* observe an incomplete live catalog */ }
    expect(adapter.peekObservedCatalog()).toMatchObject({
      recordedAt: 0,
      observation: {
        completeReasoning: true,
        modelValues: ['default', 'trae-pro'],
      },
    })
    await expect(adapter.resolveModel('traex-agent', 'trae-pro')).resolves.toMatchObject({
      reasoning: {
        efforts: [{ id: 'high', name: 'High' }],
        defaultEffort: 'high',
      },
    })
    await expect(adapter.listModels('traex-agent')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'trae-pro' }),
    ]))
    expect(discoverModels).toHaveBeenCalledTimes(1)

    // The partial stream did not renew the complete entry's age. Its original TTL still applies.
    clock = 1_000
    expect(adapter.peekObservedCatalog()).toBeUndefined()
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

  it('ignores a late stream catalog observation after shutdown', async () => {
    let observeCatalog: RunTraexAcpOptions['onCatalogObserved']
    const adapter = new TraexAcpAdapter(Config(), {
      verifyAuth: async () => {},
      runText(_invocation, options) {
        observeCatalog = options?.onCatalogObserved
        return (async function* () {
          yield 'ok'
          options?.onStopReason?.('end_turn')
        })()
      },
    })

    for await (const _chunk of adapter.stream(request())) { /* capture the observer */ }
    adapter.shutdown()
    observeCatalog?.({
      currentValue: 'late',
      modelValues: ['late'],
      models: [{ id: 'late', name: 'Late' }],
      completeReasoning: false,
      observedAt: 2,
    })

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

  it('supports Antigravity (agy-agent) discovery, single-process auth, isolated caches, and delegated tool prefixes', async () => {
    const traexCatalog = {
      currentValue: 'default',
      modelValues: ['default', 'trae-fast'],
      models: [{ id: 'default', name: 'TraeX default' }, { id: 'trae-fast', name: 'Trae Fast' }],
      completeReasoning: true,
      observedAt: 1,
    } as const
    const agyCatalog = {
      currentValue: 'gemini-4-carbon',
      modelValues: ['gemini-4-carbon', 'gemini-4-hydrogen'],
      models: [
        { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
        {
          id: 'gemini-4-hydrogen',
          name: 'Gemini 4 Hydrogen',
          reasoning: {
            efforts: [{ id: 'high', name: 'High' }, { id: 'xhigh', name: 'XHigh' }],
            defaultEffort: 'medium',
          },
        },
      ],
      completeReasoning: true,
      observedAt: 1,
    } as const

    const discoverModels = vi.fn(async (inv: { backend?: string }) => (
      inv.backend === 'agy' ? agyCatalog : traexCatalog
    ))
    let capturedAgyInvocation: TraexAcpInvocation | undefined
    const runText: TraexAcpTextRunner = (inv, opts) => {
      capturedAgyInvocation = inv
      return (async function* () {
        yield JSON.stringify({
          protocol: 'dsh-tool-calls/v1',
          calls: [{ name: 'read', arguments: { path: 'README.md' } }],
        })
        opts?.onStopReason?.('end_turn')
      })()
    }
    const config = Config({
      enabled: true,
      agyEnabled: true,
      agyCommand: '/usr/local/bin/agy',
      agyMode: 'plan',
    } as never)
    const adapter = new TraexAcpAdapter(config, {
      discoverModels,
      runText,
    })

    expect(adapter.providerInfo(AGY_PROVIDER_ROUTE)).toEqual({
      id: 'agy-agent',
      name: 'Antigravity Agent (local ACP)',
    })

    const agyModels = await adapter.listModels(AGY_PROVIDER_ROUTE)
    expect(agyModels).toEqual([
      expect.objectContaining({ provider: 'agy-agent', id: 'default', name: 'Antigravity active model (Gemini 4 Carbon)' }),
      expect.objectContaining({ provider: 'agy-agent', id: 'gemini-4-carbon', name: 'Gemini 4 Carbon' }),
      expect.objectContaining({ provider: 'agy-agent', id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' }),
    ])
    expect(discoverModels).toHaveBeenCalledWith({
      backend: 'agy',
      command: '/usr/local/bin/agy',
      args: buildAgyArgs({ includeDefaultCustomizations: false, disableTelemetry: true }),
      cwd: process.cwd(),
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }))

    expect(adapter.peekObservedCatalog('agy-agent')?.observation).toEqual(agyCatalog)
    expect(adapter.peekObservedCatalog('traex-agent')).toBeUndefined()
    await expect(adapter.resolveModel(AGY_PROVIDER_ROUTE, 'gemini-4-hydrogen')).resolves.toMatchObject({
      provider: 'agy-agent',
      id: 'gemini-4-hydrogen',
      context: { contextWindow: 112_000 },
      reasoning: {
        efforts: [{ id: 'high', name: 'High' }, { id: 'xhigh', name: 'XHigh' }],
        defaultEffort: 'medium',
      },
    })
    await expect(adapter.resolveModel('traex-agent', 'default')).resolves.toMatchObject({
      provider: 'traex-agent',
      context: { contextWindow: 200_000 },
    })

    const customContextAdapter = new TraexAcpAdapter(Config({ agyContextWindow: 96_000 } as never))
    await expect(customContextAdapter.resolveModel(AGY_PROVIDER_ROUTE, 'claude-sonnet-5-5')).resolves.toMatchObject({
      provider: 'agy-agent',
      id: 'claude-sonnet-5-5',
      context: { contextWindow: 96_000 },
    })

    const agyRequest: GenerateOptions = {
      provider: AGY_PROVIDER_ROUTE,
      model: 'gemini-4-hydrogen',
      reasoningEffort: ReasoningEffortId('xhigh'),
      system: 'Be concise.',
      messages: [createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'read readme' }] })],
      tools: [{ name: 'read', description: 'Read a file.', parameters: { type: 'object' } }],
    }
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(agyRequest)) chunks.push(chunk)
    expect(capturedAgyInvocation).toMatchObject({
      backend: 'agy',
      command: '/usr/local/bin/agy',
      model: 'gemini-4-hydrogen',
      reasoningEffort: 'xhigh',
      agyMode: 'plan',
    })
    expect(capturedAgyInvocation?.prompt).toContain('do not invoke Antigravity-native tools')
    expect(chunks.find(chunk => chunk.type === 'tool-call-delta')).toMatchObject({
      id: expect.stringMatching(/^agy-/u),
      name: 'read',
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })

    await expect(probeAcpReadiness(config, { provider: AGY_PROVIDER_ROUTE }, { discoverModels }))
      .resolves.toEqual(agyCatalog)
  })

  it('invalidates the Antigravity catalog observation and returns ACP_AUTH_REQUIRED when ACP reports auth failure', async () => {
    const adapter = new TraexAcpAdapter(Config({ agyEnabled: true } as never), {
      discoverModels: async () => ({
        currentValue: 'gemini-4-carbon',
        modelValues: ['gemini-4-carbon'],
        models: [{ id: 'gemini-4-carbon', name: 'Gemini 4 Carbon' }],
        completeReasoning: true,
        observedAt: 1,
      }),
      runText: () => failedTextStream('auth'),
    })

    await adapter.listModels(AGY_PROVIDER_ROUTE)
    expect(adapter.peekObservedCatalog(AGY_PROVIDER_ROUTE)).toBeDefined()

    const iterator = adapter.stream({
      ...request('gemini-4-carbon'),
      provider: AGY_PROVIDER_ROUTE,
    })[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'block-start' } })
    await expect(iterator.next()).rejects.toMatchObject({
      code: 'ACP_AUTH_REQUIRED',
      message: expect.stringContaining('Antigravity'),
    })
    expect(adapter.peekObservedCatalog(AGY_PROVIDER_ROUTE)).toBeUndefined()
  })

  it('rejects a 250 KB normal prompt in preflight for agy-agent while traex-agent accepts it', async () => {
    const contexts: Array<{ provider?: string; phase?: string; promptSubmissionState?: string; outcome?: string }> = []
    const runText = vi.fn((_invocation: TraexAcpInvocation, options?: RunTraexAcpOptions) => (
      async function* () {
        yield 'traex-ok'
        options?.onStopReason?.('end_turn')
      }
    )())
    const adapter = new TraexAcpAdapter(Config({ enabled: true, agyEnabled: true } as never), {
      verifyAuth: async () => {},
      runText,
      onSettled: context => { contexts.push(context) },
    })
    const bigRequest: GenerateOptions = {
      provider: AGY_PROVIDER_ROUTE,
      model: 'default',
      system: 'Be concise.',
      messages: [createMessage({
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'A'.repeat(250_000) }],
      })],
    }

    await expect((async () => {
      for await (const _chunk of adapter.stream(bigRequest)) { /* drain */ }
    })()).rejects.toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' })
    expect(runText).not.toHaveBeenCalled()
    expect(contexts.at(-1)).toMatchObject({
      provider: AGY_PROVIDER_ROUTE,
      phase: 'preflight',
      promptSubmissionState: 'not-submitted',
      outcome: 'preflight',
    })

    const traexChunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({ ...bigRequest, provider: 'traex-agent' })) {
      traexChunks.push(chunk)
    }
    expect(runText).toHaveBeenCalledTimes(1)
    expect(traexChunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('clamps agy-agent prompt budget to Math.min(maxPromptBytes, agyMaxPromptBytes)', async () => {
    const runText = vi.fn(() => (async function* () { yield 'unreachable' })())
    const adapter = new TraexAcpAdapter(Config({
      agyEnabled: true,
      maxPromptBytes: 4_096,
    } as never), {
      verifyAuth: async () => {},
      runText,
    })

    await expect((async () => {
      for await (const _chunk of adapter.stream({
        provider: AGY_PROVIDER_ROUTE,
        model: 'default',
        messages: [createMessage({
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'A'.repeat(10_000) }],
        })],
      })) { /* drain */ }
    })()).rejects.toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' })
    expect(runText).not.toHaveBeenCalled()
  })

  it('completes DSH 0.2 compaction end-to-end on agy-agent with defaultEffort materialization and 65536 maxTokens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'traex-agy-compaction-e2e-'))
    try {
      const workspace = join(root, 'workspace')
      await mkdir(workspace)
      const COMPACTION_INSTRUCTION = [
        'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
        '',
        'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
        '',
        '## Primary Request and Intent',
        '- [the user\'s original and evolving goals; quote verbatim where the exact wording matters]',
        '',
        '## Key Technical Concepts',
        '- [technologies, frameworks, patterns, and conventions in play]',
        '',
        '## Files and Code',
        '- [exact path: why it matters, key changes or snippets]',
        '',
        '## Errors and Fixes',
        '- [error: how it was resolved, plus any related user feedback]',
        '',
        '## Pending Jobs',
        '- [explicitly requested work not yet completed]',
        '',
        '## Current Work',
        '- [precisely what was in progress at this checkpoint]',
        '',
        '## Next Step',
        '- [the single next action, directly in line with the most recent request, or "(none)"]',
        '',
        '## Critical Context',
        '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
        '',
        'Rules:',
        '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
        '- Capture user feedback and explicit instructions faithfully, especially corrections.',
        '- Do NOT mention this summarization request or that the context was compacted.',
        '- Output only the checkpoint text: do not call any tool or take any other action.',
        '- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.',
      ].join('\n')
      const ctx = new Context()
      ctx.provide('sessionProjections', {
        register: async () => ({ stateOf: () => ({}), readerFor: () => () => ({}), dispose: async () => {} }),
      } as never)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(LlmRuntime)

      const system = createSystemMessage('Be concise.')
      const bigHistoryMessage = createMessage({
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'H'.repeat(220_000) }],
      })
      const latestUser = createMessage({
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'latest turn kept after checkpoint' }],
      })
      const tools = [{
        name: 'lookup',
        description: 'Lookup details.',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      }]
      const events = [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        {
          type: 'compaction/start',
          seq: 1,
          time: 2,
          data: { compactionId: '8e90cc20-8275-43c9-b34f-a3fbe3536d84', turn: 1 },
        },
      ]
      const session = {
        id: TEST_SESSION_ID,
        header: { cwd: workspace },
        snapshotEvents: () => events,
        requestHeader: () => ({
          config: { provider: AGY_PROVIDER_ROUTE, model: 'gemini-4-carbon' },
          tools,
        }),
        toolHistory: () => ({ tools, updates: [] }),
        deriveMessages: () => [system, bigHistoryMessage, latestUser],
      } as unknown as Agent['session']
      const agent = {
        id: TEST_SESSION_ID,
        session,
        status: 'running',
        model: { current: () => ({ provider: AGY_PROVIDER_ROUTE, model: 'gemini-4-carbon' }), select: () => {} },
        ctx,
      } as unknown as Agent
      ctx.agents.register(agent)

      const hostAttestor = createAgentLoopRequestAttestor(ctx.agents, ['traex-agent', 'agy-agent'])
      const compactionClaims: Array<{ wasFrozenBefore: boolean; accepted: boolean; isFrozenAfter: boolean; request: GenerateOptions }> = []
      let capturedInvocation: TraexAcpInvocation | undefined
      const adapter = new RawTraexAcpAdapter(Config({
        agyEnabled: true,
        cwd: workspace,
      } as never), {
        liveSessions: { get: id => id === TEST_SESSION_ID ? session : undefined },
        requestAttestor: {
          claim: (observed, claimedSession) => hostAttestor.claim(observed, claimedSession),
          claimCompaction(observed, claimedSession) {
            const wasFrozenBefore = Object.isFrozen(observed)
            const accepted = hostAttestor.claimCompaction?.(observed, claimedSession) ?? false
            const isFrozenAfter = Object.isFrozen(observed)
            compactionClaims.push({ wasFrozenBefore, accepted, isFrozenAfter, request: observed })
            return accepted
          },
        },
        discoverModels: async () => ({
          currentValue: 'gemini-4-carbon',
          modelValues: ['gemini-4-carbon'],
          models: [{
            id: 'gemini-4-carbon',
            name: 'Gemini 4 Carbon',
            reasoning: {
              efforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }],
              defaultEffort: 'medium',
            },
          }],
          completeReasoning: true,
          observedAt: 1,
        }),
        runText: (invocation, options) => {
          capturedInvocation = invocation
          return (async function* () {
            yield '## Primary Request and Intent\n- Compacted.\n'
            options?.onStopReason?.('end_turn')
          })()
        },
      })
      ctx.llm.registerAdapter([AGY_PROVIDER_ROUTE], adapter)

      await adapter.listModels(AGY_PROVIDER_ROUTE)

      const compactionRequest: GenerateOptions = {
        provider: AGY_PROVIDER_ROUTE,
        model: 'gemini-4-carbon',
        messages: [
          system,
          bigHistoryMessage,
          { role: 'user', content: [{ type: 'text', text: COMPACTION_INSTRUCTION }] },
        ],
        tools,
        toolHistory: session.toolHistory(),
        maxTokens: 65_536,
        sessionId: TEST_SESSION_ID,
        purpose: 'compaction' as never,
        signal: new AbortController().signal,
      }

      const chunks = await ctx.agents.withInitiator(agent, async () => {
        const result: StreamChunk[] = []
        for await (const chunk of ctx.llm.stream(compactionRequest)) result.push(chunk)
        return result
      })

      expect(compactionClaims.length).toBeGreaterThanOrEqual(1)
      expect(compactionClaims.every(entry => entry.accepted && entry.isFrozenAfter)).toBe(true)
      expect(compactionClaims[0]?.wasFrozenBefore).toBe(false)
      expect(compactionClaims[0]?.request.reasoningEffort).toBe('medium')
      expect(capturedInvocation).toBeDefined()
      expect(capturedInvocation?.reasoningEffort).toBe('medium')
      expect(Buffer.byteLength(capturedInvocation!.prompt, 'utf8')).toBeLessThanOrEqual(184_320)
      expect(capturedInvocation?.prompt).toContain('…[truncated for compaction]')
      expect(capturedInvocation?.prompt).toContain('You are now acting as a compaction engine')
      expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
      await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
