import { EventEmitter } from 'node:events'
import { PassThrough, Readable, Writable } from 'node:stream'
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type Agent,
  type AgentSideConnection as AgentConnection,
  type InitializeRequest,
  type NewSessionRequest,
  type PromptRequest,
  type SetSessionConfigOptionRequest,
  type StopReason,
} from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildTraexEnv,
  runTraexAcpText,
  type SpawnOptions,
  type SpawnProcess,
  type SpawnedProcess,
  type TraexAcpInvocation,
} from '../src/acp-client.ts'

const safeArgs = [
  '--sandbox',
  'read-only',
  '--ask-for-approval',
  'never',
  'acp',
  'serve',
] as const

const invocation: TraexAcpInvocation = {
  command: 'traex',
  args: safeArgs,
  cwd: process.cwd(),
  prompt: 'answer this',
}

interface FakeState {
  initialize: InitializeRequest[]
  sessions: NewSessionRequest[]
  prompts: PromptRequest[]
  modelSelections: SetSessionConfigOptionRequest[]
  closedSessions: string[]
  wireMethods: string[]
  wireMessages: Record<string, unknown>[]
  kills: NodeJS.Signals[]
  spawn?: { command: string; args: readonly string[]; options: SpawnOptions }
  connection?: AgentConnection
  child?: FakeProcess
}

interface Script {
  readonly agentName?: string
  readonly protocolVersion?: number
  readonly authRequired?: boolean
  readonly advertiseTraeSso?: boolean
  readonly advertiseClose?: boolean
  readonly models?: readonly string[]
  readonly stopReason?: StopReason
  readonly closeOnSigint?: boolean
  readonly initializeTitle?: string
  readonly malformedHandshake?: boolean
  readonly onPrompt?: (connection: AgentConnection, request: PromptRequest) => Promise<StopReason>
  readonly onCloseSession?: (sessionId: string) => Promise<Record<string, never>>
}

class FakeProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  private closed = false
  private wire = ''

  constructor(
    private readonly state: FakeState,
    private readonly closeOnSigint: boolean,
  ) {
    super()
    this.stdin.on('data', (chunk: Buffer) => {
      this.wire += chunk.toString('utf8')
      while (true) {
        const newline = this.wire.indexOf('\n')
        if (newline < 0) return
        const line = this.wire.slice(0, newline)
        this.wire = this.wire.slice(newline + 1)
        try {
          const message = JSON.parse(line) as Record<string, unknown>
          this.state.wireMessages.push(message)
          if (typeof message.method === 'string') this.state.wireMethods.push(message.method)
        } catch {
          // The production transport validates the opposite direction.
        }
      }
    })
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    const namedSignal = typeof signal === 'string' ? signal : 'SIGTERM'
    this.state.kills.push(namedSignal)
    if (namedSignal === 'SIGKILL' || this.closeOnSigint) this.close(null, namedSignal)
    return true
  }

  close(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return
    this.closed = true
    this.exitCode = code
    this.signalCode = signal
    this.stdout.end()
    this.stderr.end()
    this.stdin.end()
    queueMicrotask(() => this.emit('close', code, signal))
  }
}

function harness(script: Script = {}): { state: FakeState; spawn: SpawnProcess } {
  const state: FakeState = {
    initialize: [],
    sessions: [],
    prompts: [],
    modelSelections: [],
    closedSessions: [],
    wireMethods: [],
    wireMessages: [],
    kills: [],
  }
  const spawn: SpawnProcess = (command, args, options) => {
    state.spawn = { command, args: [...args], options }
    const child = new FakeProcess(state, script.closeOnSigint ?? true)
    state.child = child
    const stream = ndJsonStream(
      Writable.toWeb(child.stdout),
      Readable.toWeb(child.stdin),
    )
    state.connection = new AgentSideConnection(connection => {
      const models = script.models ?? ['default', 'fast']
      const agent: Agent = {
        initialize(request) {
          state.initialize.push(request)
          if (script.malformedHandshake) {
            return Promise.resolve({
              protocolVersion: PROTOCOL_VERSION,
              agentInfo: { name: 'traex-acp' },
              authMethods: [{ id: 'trae-sso' }],
            } as never)
          }
          return Promise.resolve({
            protocolVersion: script.protocolVersion ?? PROTOCOL_VERSION,
            agentInfo: {
              name: script.agentName ?? 'traex-acp',
              title: script.initializeTitle ?? 'TRAE CLI',
              version: '0.200.19',
            },
            agentCapabilities: script.advertiseClose === false
              ? {}
              : { sessionCapabilities: { close: {} } },
            authMethods: script.advertiseTraeSso === false
              ? [{ id: 'chatgpt', name: 'Login with ChatGPT' }]
              : [{ id: 'trae-sso', name: 'Login with Trae' }],
          })
        },
        authenticate() {
          return Promise.reject(new Error('interactive authentication must not be called'))
        },
        newSession(request) {
          state.sessions.push(request)
          if (script.authRequired) return Promise.reject(RequestError.authRequired())
          return Promise.resolve({
            sessionId: 'session-current',
            configOptions: [{
              id: 'model-choice',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: models[0] ?? '',
              options: models.map(value => ({ value, name: value })),
            }],
          })
        },
        setSessionConfigOption(request) {
          state.modelSelections.push(request)
          return Promise.resolve({
            configOptions: [{
              id: 'model-choice',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: request.value as string,
              options: models.map(value => ({ value, name: value })),
            }],
          })
        },
        async prompt(request) {
          state.prompts.push(request)
          if (script.onPrompt !== undefined) {
            return { stopReason: await script.onPrompt(connection, request) }
          }
          await connection.sessionUpdate({
            sessionId: request.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'answer' },
            },
          })
          return { stopReason: script.stopReason ?? 'end_turn' }
        },
        cancel() {
          return Promise.resolve()
        },
        closeSession(request) {
          state.closedSessions.push(request.sessionId)
          if (script.onCloseSession !== undefined) return script.onCloseSession(request.sessionId)
          return Promise.resolve({})
        },
      }
      return agent
    }, stream)
    return child
  }
  return { state, spawn }
}

async function collect(
  input: TraexAcpInvocation,
  options: Parameters<typeof runTraexAcpText>[1],
): Promise<string[]> {
  const output: string[] = []
  for await (const text of runTraexAcpText(input, options)) output.push(text)
  return output
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('TraeX ACP subprocess transport', () => {
  it('performs the v1 handshake, creates one session, selects a model, and emits only current-session agent text', async () => {
    const { state, spawn } = harness({
      onPrompt: async (connection, request) => {
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'secret thought' } },
        })
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'AA==', mimeType: 'image/png' } },
        })
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello ' } },
        })
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } },
        })
        return 'end_turn'
      },
    })

    const output = await collect({ ...invocation, model: 'fast' }, { spawn })

    expect(output).toEqual(['hello ', 'world'])
    expect(state.spawn).toMatchObject({
      command: 'traex',
      args: [...safeArgs],
      options: { cwd: process.cwd(), shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
    })
    expect(state.initialize).toEqual([{
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        auth: { terminal: false },
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: {
        name: 'dsh-enhanced-traex-acp-provider',
        title: 'DSH TraeX ACP Provider',
        version: '0.1.0',
      },
    }])
    expect(state.sessions).toEqual([{ cwd: process.cwd(), mcpServers: [] }])
    expect(state.modelSelections).toEqual([{
      sessionId: 'session-current',
      configId: 'model-choice',
      value: 'fast',
    }])
    expect(state.prompts).toEqual([{
      sessionId: 'session-current',
      prompt: [{ type: 'text', text: 'answer this' }],
    }])
    expect(state.closedSessions).toEqual(['session-current'])
    expect(state.wireMethods).toContain('session/close')
    expect(state.kills).toEqual(['SIGINT'])
  })

  it('advertises no client filesystem/terminal capabilities and always denies permissions', async () => {
    let permissionOutcome: unknown
    const { state, spawn } = harness({
      onPrompt: async (connection, request) => {
        permissionOutcome = await connection.requestPermission({
          sessionId: request.sessionId,
          toolCall: { toolCallId: 'tool-1', title: 'write', kind: 'edit' },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        })
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'denied safely' } },
        })
        return 'end_turn'
      },
    })

    await expect(collect(invocation, { spawn })).resolves.toEqual(['denied safely'])
    expect(state.initialize[0]?.clientCapabilities).toEqual({
      auth: { terminal: false },
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    })
    expect(permissionOutcome).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(state.wireMessages.some(message => (
      (message.result as { outcome?: { outcome?: string } } | undefined)?.outcome?.outcome === 'cancelled'
    ))).toBe(true)
  })

  it.each<StopReason>(['end_turn', 'max_tokens', 'max_turn_requests'])(
    'accepts the successful %s terminal reason',
    async stopReason => {
      const { spawn } = harness({ stopReason })
      let terminal: StopReason | undefined
      await expect(collect(invocation, {
        spawn,
        onStopReason: reason => { terminal = reason },
      })).resolves.toEqual(['answer'])
      expect(terminal).toBe(stopReason)
    },
  )

  it('preserves refusal and cancelled terminal failures', async () => {
    const refused = harness({ stopReason: 'refusal' })
    await expect(collect(invocation, { spawn: refused.spawn })).rejects.toMatchObject({ cause: 'refusal' })

    const cancelled = harness({ stopReason: 'cancelled' })
    await expect(collect(invocation, { spawn: cancelled.spawn })).rejects.toMatchObject({ cause: 'abort' })
  })

  it('maps authentication-required without invoking ACP authenticate', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { spawn } = harness({ authRequired: true })
    await expect(collect(invocation, { spawn })).rejects.toMatchObject({ cause: 'auth' })
  })

  it('requires Trae SSO advertisement and a non-empty entitled model catalog', async () => {
    const wrongAuth = harness({ advertiseTraeSso: false })
    await expect(collect(invocation, { spawn: wrongAuth.spawn })).rejects.toMatchObject({ cause: 'auth' })

    const emptyModels = harness({ models: [] })
    await expect(collect(invocation, { spawn: emptyModels.spawn })).rejects.toMatchObject({ cause: 'entitlement' })
    expect(emptyModels.state.prompts).toHaveLength(0)
  })

  it('rejects a requested model that the new session did not advertise', async () => {
    const { state, spawn } = harness({ models: ['default'] })
    await expect(collect({ ...invocation, model: 'unknown' }, { spawn }))
      .rejects.toMatchObject({ cause: 'model' })
    expect(state.modelSelections).toHaveLength(0)
    expect(state.prompts).toHaveLength(0)
  })

  it('fails closed on a session update for any session other than the one it created', async () => {
    const { spawn } = harness({
      onPrompt: async connection => {
        await connection.sessionUpdate({
          sessionId: 'different-session',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'wrong' } },
        })
        return 'end_turn'
      },
    })
    await expect(collect(invocation, { spawn })).rejects.toMatchObject({ cause: 'protocol' })
  })

  it.each([
    { agentName: 'impostor', protocolVersion: PROTOCOL_VERSION },
    { agentName: 'traex-acp', protocolVersion: PROTOCOL_VERSION + 1 },
  ])('rejects an incompatible handshake %#', async identity => {
    const { spawn } = harness(identity)
    await expect(collect(invocation, { spawn })).rejects.toMatchObject({ cause: 'protocol' })
  })

  it('rejects security-critical initialize fields that the SDK tolerant schema would skip', async () => {
    const { state, spawn } = harness({ malformedHandshake: true })
    await expect(collect(invocation, { spawn })).rejects.toMatchObject({ cause: 'protocol' })
    expect(state.sessions).toHaveLength(0)
    expect(state.prompts).toHaveLength(0)
  })

  it('sends ACP cancel before SIGINT, escalates to SIGKILL, and waits for close on abort', async () => {
    const started = Promise.withResolvers<void>()
    const cancelled = Promise.withResolvers<void>()
    const { state, spawn } = harness({
      closeOnSigint: false,
      onPrompt: async () => {
        started.resolve()
        await cancelled.promise
        return 'cancelled'
      },
    })
    const originalConnection = state.connection
    const controller = new AbortController()
    const pending = collect(invocation, { spawn, signal: controller.signal, killGraceMs: 5 })
    await started.promise
    controller.abort()
    await expect(pending).rejects.toMatchObject({ cause: 'abort' })

    expect(state.wireMethods).toContain('session/cancel')
    expect(state.wireMethods.indexOf('session/cancel')).toBeLessThan(state.wireMethods.length)
    expect(state.kills).toEqual(['SIGINT', 'SIGKILL'])
    expect(state.child?.signalCode).toBe('SIGKILL')
    void originalConnection
    cancelled.resolve()
  })

  it('times out a hung ACP turn with the stable timeout cause', async () => {
    const never = new Promise<StopReason>(() => undefined)
    const { state, spawn } = harness({
      closeOnSigint: false,
      onPrompt: () => never,
    })
    await expect(collect(invocation, {
      spawn,
      timeoutMs: 15,
      killGraceMs: 5,
    })).rejects.toMatchObject({ cause: 'timeout' })
    expect(state.kills).toEqual(['SIGINT', 'SIGKILL'])
  })

  it('reports a non-zero premature child close as a process failure', async () => {
    const { state, spawn } = harness()
    const closingSpawn: SpawnProcess = (...args) => {
      const child = spawn(...args)
      queueMicrotask(() => state.child?.close(9, null))
      return child
    }
    await expect(collect(invocation, { spawn: closingSpawn })).rejects.toMatchObject({ cause: 'process' })
  })

  it('reports clean EOF before a terminal response as a protocol failure', async () => {
    const { state, spawn } = harness()
    const closingSpawn: SpawnProcess = (...args) => {
      const child = spawn(...args)
      queueMicrotask(() => state.child?.close(0, null))
      return child
    }
    await expect(collect(invocation, { spawn: closingSpawn })).rejects.toMatchObject({ cause: 'protocol' })
  })

  it('fails closed on malformed ACP NDJSON', async () => {
    const base = harness()
    const malformedSpawn: SpawnProcess = (...args) => {
      const child = base.spawn(...args) as FakeProcess
      child.stdout.write('{not-json}\n')
      return child
    }
    await expect(collect(invocation, { spawn: malformedSpawn })).rejects.toMatchObject({ cause: 'protocol' })
  })

  it.each([
    { name: 'empty line', wire: '\n' },
    { name: 'wrong JSON-RPC version', wire: `${JSON.stringify({ jsonrpc: '1.0', method: 'session/update', params: {} })}\n` },
    { name: 'unknown notification', wire: `${JSON.stringify({ jsonrpc: '2.0', method: 'agent/debug', params: {} })}\n` },
    {
      name: 'session update before session creation',
      wire: `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'session-current',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'early' } },
        },
      })}\n`,
    },
    { name: 'unknown response id', wire: `${JSON.stringify({ jsonrpc: '2.0', id: 999_999, result: {} })}\n` },
    { name: 'filesystem request', wire: `${JSON.stringify({ jsonrpc: '2.0', id: 'fs-1', method: 'fs/read_text_file', params: { path: '/secret' } })}\n` },
    { name: 'terminal request', wire: `${JSON.stringify({ jsonrpc: '2.0', id: 'terminal-1', method: 'terminal/create', params: { command: 'env' } })}\n` },
  ])('rejects a strict JSON-RPC violation: $name', async ({ wire }) => {
    const base = harness()
    const invalidSpawn: SpawnProcess = (...args) => {
      const child = base.spawn(...args) as FakeProcess
      child.stdout.write(wire)
      return child
    }
    await expect(collect(invocation, { spawn: invalidSpawn })).rejects.toMatchObject({ cause: 'protocol' })
  })

  it('rejects a duplicate response id after its original response was consumed', async () => {
    let state: FakeState | undefined
    const fixture = harness({
      onPrompt: async (connection, request) => {
        const initialize = state?.wireMessages.find(message => message.method === 'initialize')
        state?.child?.stdout.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: initialize?.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            agentInfo: { name: 'traex-acp', version: '0.200.19' },
            authMethods: [{ id: 'trae-sso', name: 'Login with Trae' }],
          },
        })}\n`)
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'must-not-settle' } },
        })
        return 'end_turn'
      },
    })
    state = fixture.state
    await expect(collect(invocation, { spawn: fixture.spawn })).rejects.toMatchObject({ cause: 'protocol' })
  })

  it('schema-validates known notifications before the SDK can print untrusted content', async () => {
    const secretMarker = 'UNTRUSTED_WIRE_SECRET'
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let state: FakeState | undefined
    const fixture = harness({
      onPrompt: async () => {
        state?.child?.stdout.write(`${JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'session-current',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: { secretMarker } },
            },
          },
        })}\n`)
        return 'end_turn'
      },
    })
    state = fixture.state

    await expect(collect(invocation, { spawn: fixture.spawn })).rejects.toMatchObject({ cause: 'protocol' })
    expect(consoleError.mock.calls.some(call => JSON.stringify(call).includes(secretMarker))).toBe(false)
  })

  it('fails closed on non-UTF-8 ACP stdout', async () => {
    const base = harness()
    const invalidUtf8Spawn: SpawnProcess = (...args) => {
      const child = base.spawn(...args) as FakeProcess
      child.stdout.write(Buffer.from([0xff, 0x0a]))
      return child
    }
    await expect(collect(invocation, { spawn: invalidUtf8Spawn })).rejects.toMatchObject({ cause: 'protocol' })
  })

  it('preserves an ENOENT system code without exposing the process error text', async () => {
    const base = harness()
    const missingSpawn: SpawnProcess = (...args) => {
      const child = base.spawn(...args) as FakeProcess
      queueMicrotask(() => {
        const error = Object.assign(new Error('sensitive executable path'), { code: 'ENOENT' })
        child.emit('error', error)
        child.close(null, null)
      })
      return child
    }
    await expect(collect(invocation, { spawn: missingSpawn })).rejects.toMatchObject({
      cause: 'process',
      systemCode: 'ENOENT',
      message: 'TraeX ACP process failed',
    })
  })

  it('enforces cumulative assistant output and individual ACP message bounds', async () => {
    const outputHarness = harness({
      onPrompt: async (connection, request) => {
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '12345' } },
        })
        return 'end_turn'
      },
    })
    await expect(collect(invocation, {
      spawn: outputHarness.spawn,
      maxOutputBytes: 4,
    })).rejects.toMatchObject({ cause: 'output-limit' })

    const messageHarness = harness({ initializeTitle: 'x'.repeat(2_000) })
    await expect(collect(invocation, {
      spawn: messageHarness.spawn,
      maxMessageBytes: 256,
    })).rejects.toMatchObject({ cause: 'output-limit' })

    const byteHarness = harness()
    await expect(collect(invocation, {
      spawn: byteHarness.spawn,
      maxMessageBytes: 4_096,
      maxProtocolBytes: 64,
    })).rejects.toMatchObject({ cause: 'output-limit' })
  })

  it('bounds a flood of many small ACP messages before they can accumulate', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fixture = harness({
      onPrompt: async (connection, request) => {
        for (let index = 0; index < 100; index++) {
          await connection.sessionUpdate({
            sessionId: request.sessionId,
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: String(index) },
            },
          })
        }
        return 'end_turn'
      },
    })
    await expect(collect(invocation, {
      spawn: fixture.spawn,
      maxProtocolMessages: 8,
    })).rejects.toMatchObject({ cause: 'output-limit' })
    expect(fixture.state.kills.length).toBeGreaterThan(0)
  })

  it('cancels and reaps immediately when the consumer returns after prompt completion but session/close hangs', async () => {
    const closeStarted = Promise.withResolvers<void>()
    const fixture = harness({
      onPrompt: async (connection, request) => {
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first' } },
        })
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'second' } },
        })
        return 'end_turn'
      },
      onCloseSession: () => {
        closeStarted.resolve()
        return new Promise<Record<string, never>>(() => undefined)
      },
    })
    const iterator = runTraexAcpText(invocation, {
      spawn: fixture.spawn,
      killGraceMs: 5,
    })[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toEqual({ value: 'first', done: false })
    await closeStarted.promise
    await iterator.return?.()

    expect(fixture.state.wireMethods).toContain('session/cancel')
    expect(fixture.state.kills).toEqual(['SIGINT'])
    expect(fixture.state.child?.signalCode).toBe('SIGINT')
  })

  it('bounds stderr diagnostics and excludes API credentials from the child environment', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'must-not-leak')
    vi.stubEnv('OPENAI_BASE_URL', 'https://must-not-route.example')
    vi.stubEnv('TRAE_SAFE_TEST', 'forwarded')
    vi.stubEnv('TRAE_HOME', '/tmp/explicit-trae-home')
    let diagnostic = ''
    const { state, spawn } = harness({
      onPrompt: async (connection, request) => {
        state.child?.stderr.write('0123456789abcdef')
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
        })
        return 'end_turn'
      },
    })
    await collect(invocation, {
      spawn,
      maxStderrBytes: 8,
      extraEnvNames: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'TRAE_SAFE_TEST'],
      onDiagnostic: value => { diagnostic = value },
    })

    expect(diagnostic).toBe('89abcdef')
    expect(state.spawn?.options.env.OPENAI_API_KEY).toBeUndefined()
    expect(state.spawn?.options.env.OPENAI_BASE_URL).toBeUndefined()
    expect(state.spawn?.options.env).toHaveProperty('TRAE_SAFE_TEST', 'forwarded')
    expect(buildTraexEnv(['OPENAI_API_KEY']).OPENAI_API_KEY).toBeUndefined()
    expect(buildTraexEnv(['OPENAI_BASE_URL']).OPENAI_BASE_URL).toBeUndefined()
    expect(buildTraexEnv().TRAE_HOME).toBeUndefined()
    expect(buildTraexEnv(['TRAE_HOME']).TRAE_HOME).toBe('/tmp/explicit-trae-home')
  })

  it('rejects common secret environment names and strips proxy URL userinfo', () => {
    vi.stubEnv('AUTHORIZATION', 'Bearer must-not-leak')
    vi.stubEnv('SSH_PRIVATE_KEY', 'must-not-leak')
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'must-not-leak')
    vi.stubEnv('GITHUB_PAT', 'must-not-leak')
    vi.stubEnv('DATABASE_URL', 'postgres://user:pass@db.example/app')
    vi.stubEnv('HTTP_PROXY', 'http://alice:password@proxy.example:8080/path')
    vi.stubEnv('HTTPS_PROXY', 'alice:password@proxy.example:8443')

    const env = buildTraexEnv([
      'AUTHORIZATION',
      'SSH_PRIVATE_KEY',
      'AWS_ACCESS_KEY_ID',
      'GITHUB_PAT',
      'DATABASE_URL',
    ])
    expect(env.AUTHORIZATION).toBeUndefined()
    expect(env.SSH_PRIVATE_KEY).toBeUndefined()
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined()
    expect(env.GITHUB_PAT).toBeUndefined()
    expect(env.DATABASE_URL).toBeUndefined()
    expect(env.HTTP_PROXY).toBe('http://proxy.example:8080/path')
    expect(env.HTTPS_PROXY).toBeUndefined()
  })

  it('rejects altered argv before spawning, including yolo', async () => {
    const spawn = vi.fn<SpawnProcess>()
    await expect(collect({ ...invocation, args: ['acp', 'serve', '--yolo'] }, { spawn }))
      .rejects.toMatchObject({ cause: 'protocol' })
    expect(spawn).toHaveBeenCalledTimes(0)
  })

  it('skips session/close only when the agent does not advertise it', async () => {
    const { state, spawn } = harness({ advertiseClose: false })
    await expect(collect(invocation, { spawn })).resolves.toEqual(['answer'])
    expect(state.closedSessions).toEqual([])
    expect(state.wireMethods).not.toContain('session/close')
  })
})
