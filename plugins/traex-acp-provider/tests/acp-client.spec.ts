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
  type PromptResponse,
  type SetSessionConfigOptionRequest,
  type SessionConfigOption,
  type StopReason,
} from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ACP_USAGE_DSH_MAPPING_GATE,
  buildTraexEnv,
  runTraexAcpText,
  type CatalogObservation,
  type ProviderFailureContext,
  type SpawnOptions,
  type SpawnProcess,
  type SpawnedProcess,
  type TraexAcpInvocation,
} from '../src/acp-client.ts'
import * as acpClientModule from '../src/acp-client.ts'
import { version } from '../src/version.ts'

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
  readonly reasoningByModel?: Readonly<Record<string, readonly string[]>>
  readonly defaultReasoningByModel?: Readonly<Record<string, string>>
  readonly malformedReasoning?: boolean
  readonly stopReason?: StopReason
  readonly usage?: PromptResponse['usage']
  readonly closeOnSigint?: boolean
  readonly closeOnSigkill?: boolean
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
    private readonly closeOnSigkill: boolean,
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
    if ((namedSignal === 'SIGKILL' && this.closeOnSigkill) || this.closeOnSigint) {
      this.close(null, namedSignal)
    }
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
    const child = new FakeProcess(state, script.closeOnSigint ?? true, script.closeOnSigkill ?? true)
    state.child = child
    queueMicrotask(() => child.emit('spawn'))
    const stream = ndJsonStream(
      Writable.toWeb(child.stdout),
      Readable.toWeb(child.stdin),
    )
    state.connection = new AgentSideConnection(connection => {
      const models = script.models ?? ['default', 'fast']
      let selectedModel = models[0] ?? ''
      const selectedReasoning = new Map<string, string>()
      const configOptions = (): SessionConfigOption[] => {
        const options: SessionConfigOption[] = [{
          id: 'model-choice',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: selectedModel,
          options: models.map(value => ({ value, name: value })),
        }]
        const efforts = script.reasoningByModel?.[selectedModel]
        if (efforts !== undefined && efforts.length > 0) {
          options.push({
            id: 'reasoning_effort',
            name: 'Reasoning Effort',
            category: 'thought_level',
            type: 'select',
            currentValue: selectedReasoning.get(selectedModel)
              ?? script.defaultReasoningByModel?.[selectedModel]
              ?? efforts[0]!,
            options: efforts.map(value => ({ value, name: value.charAt(0).toUpperCase() + value.slice(1) })),
          })
        }
        if (script.malformedReasoning) {
          options.push({
            id: 'reasoning_effort',
            name: 'Reasoning Effort',
            category: 'thought_level',
            type: 'select',
            currentValue: 'low',
            options: 'not-an-option-array',
          } as never)
        }
        return options
      }
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
              version: '0.201.1',
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
            configOptions: configOptions(),
          })
        },
        setSessionConfigOption(request) {
          state.modelSelections.push(request)
          if (request.configId === 'model-choice') selectedModel = request.value as string
          if (request.configId === 'reasoning_effort') {
            selectedReasoning.set(selectedModel, request.value as string)
          }
          return Promise.resolve({
            configOptions: configOptions(),
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
          return { stopReason: script.stopReason ?? 'end_turn', ...(script.usage !== undefined ? { usage: script.usage } : {}) }
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
  it('discovers every ACP model without submitting a prompt', async () => {
    const discover = Reflect.get(acpClientModule, 'discoverTraexAcpModels') as (
      invocation: Omit<TraexAcpInvocation, 'prompt' | 'model'>,
      options: { spawn: SpawnProcess },
    ) => Promise<CatalogObservation>
    expect(discover).toBeTypeOf('function')
    const { state, spawn } = harness({
      models: ['trae-fast', 'trae-pro'],
      reasoningByModel: {
        'trae-fast': ['low', 'high'],
        'trae-pro': ['low', 'medium', 'high', 'ultra'],
      },
      defaultReasoningByModel: { 'trae-fast': 'high', 'trae-pro': 'medium' },
    })

    await expect(discover({ command: 'traex', args: safeArgs, cwd: process.cwd() }, { spawn }))
      .resolves.toMatchObject({
        currentValue: 'trae-fast',
        modelValues: ['trae-fast', 'trae-pro'],
        models: [
          {
            id: 'trae-fast',
            name: 'trae-fast',
            reasoning: {
              efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
              defaultEffort: 'high',
            },
          },
          {
            id: 'trae-pro',
            name: 'trae-pro',
            reasoning: {
              efforts: [
                { id: 'low', name: 'Low' },
                { id: 'medium', name: 'Medium' },
                { id: 'high', name: 'High' },
                { id: 'ultra', name: 'Ultra' },
              ],
              defaultEffort: 'medium',
            },
          },
        ],
      })
    expect(state.prompts).toHaveLength(0)
    expect(state.closedSessions).toEqual(['session-current'])
    expect(state.kills).toEqual(['SIGINT'])
  })

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
        version,
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

  it('selects a requested reasoning effort through ACP before submitting the prompt', async () => {
    const { state, spawn } = harness({
      models: ['default', 'fast'],
      reasoningByModel: { fast: ['low', 'high'] },
      defaultReasoningByModel: { fast: 'low' },
    })

    await expect(collect({ ...invocation, model: 'fast', reasoningEffort: 'high' }, { spawn }))
      .resolves.toEqual(['answer'])
    expect(state.modelSelections).toEqual([
      { sessionId: 'session-current', configId: 'model-choice', value: 'fast' },
      { sessionId: 'session-current', configId: 'reasoning_effort', value: 'high' },
    ])
    expect(state.prompts).toHaveLength(1)
  })

  it('rejects an unavailable reasoning effort before submitting the prompt', async () => {
    const { state, spawn } = harness({
      models: ['fast'],
      reasoningByModel: { fast: ['low', 'high'] },
    })

    await expect(collect({ ...invocation, model: 'fast', reasoningEffort: 'ultra' }, { spawn }))
      .rejects.toMatchObject({ cause: 'reasoning' })
    expect(state.prompts).toHaveLength(0)
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

  it('rejects a malformed security-critical reasoning selector before prompting', async () => {
    const { state, spawn } = harness({ malformedReasoning: true })
    await expect(collect(invocation, { spawn })).rejects.toMatchObject({ cause: 'protocol' })
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
            agentInfo: { name: 'traex-acp', version: '0.201.1' },
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

  it('reports a submitted prompt state, a terminal reason, and a completed teardown on success', async () => {
    const { spawn } = harness({ models: ['default', 'fast'] })
    let context: ProviderFailureContext | undefined
    await expect(collect({ ...invocation, model: 'fast' }, {
      spawn,
      onSettled: value => { context = value },
    })).resolves.toEqual(['answer'])
    expect(context).toMatchObject({
      promptSubmissionState: 'submitted',
      assistantTextObserved: true,
      teardownState: 'completed',
      terminalReason: 'end_turn',
    })
  })

  it('keeps promptSubmissionState not-submitted when the model is rejected before prompt', async () => {
    const { state, spawn } = harness({ models: ['default'] })
    let context: ProviderFailureContext | undefined
    await expect(collect({ ...invocation, model: 'unknown' }, {
      spawn,
      onSettled: value => { context = value },
    })).rejects.toMatchObject({ cause: 'model' })
    expect(state.prompts).toHaveLength(0)
    expect(context).toMatchObject({ phase: 'model-catalog', promptSubmissionState: 'not-submitted' })
  })

  it('observes the session model catalog without gating the request', async () => {
    const { spawn } = harness({ models: ['default', 'fast'] })
    const observations: CatalogObservation[] = []
    await expect(collect({ ...invocation, model: 'fast' }, {
      spawn,
      onCatalogObserved: value => { observations.push(value) },
    })).resolves.toEqual(['answer'])
    expect(observations[0]).toMatchObject({ currentValue: 'default', modelValues: ['default', 'fast'] })
    expect(observations.at(-1)).toMatchObject({ currentValue: 'fast' })
  })

  it('still settles as an error when session/close fails after a successful turn', async () => {
    const { state, spawn } = harness({
      onCloseSession: () => Promise.reject(RequestError.internalError()),
    })
    let context: ProviderFailureContext | undefined
    await expect(collect(invocation, { spawn, onSettled: value => { context = value } }))
      .rejects.toMatchObject({ cause: 'protocol' })
    // The successful turn is not downgraded silently: teardown ran, the child was reaped,
    // the model turn is recorded as end_turn, yet the invocation still fails on cleanup.
    expect(state.closedSessions).toContain('session-current')
    expect(context).toMatchObject({
      phase: 'close-session',
      terminalReason: 'end_turn',
      teardownState: 'completed',
    })
    expect(context?.metrics?.teardownDurationMs).toBeTypeOf('number')
  })

  it.each([
    { stopReason: 'refusal' as const, cause: 'refusal' },
    { stopReason: 'cancelled' as const, cause: 'abort' },
  ])('records terminal metadata before a $stopReason failure settles', async ({ stopReason, cause }) => {
    const { spawn } = harness({ stopReason })
    let context: ProviderFailureContext | undefined
    await expect(collect(invocation, { spawn, onSettled: value => { context = value } }))
      .rejects.toMatchObject({ cause })
    expect(context).toMatchObject({ phase: 'terminal', terminalReason: stopReason })
    expect(context?.metrics?.promptToTerminalMs).toBeTypeOf('number')
  })

  it('records the validated terminal reason when missing assistant text makes the turn fail', async () => {
    const { spawn } = harness({ onPrompt: async () => 'end_turn' })
    let context: ProviderFailureContext | undefined
    await expect(collect(invocation, { spawn, onSettled: value => { context = value } }))
      .rejects.toMatchObject({ cause: 'protocol' })
    expect(context).toMatchObject({
      phase: 'terminal',
      terminalReason: 'end_turn',
      assistantTextObserved: false,
    })
  })

  it('reports a not-submitted context and never spawns when the signal is already aborted', async () => {
    const { state, spawn } = harness()
    const controller = new AbortController()
    controller.abort()
    let context: ProviderFailureContext | undefined
    await expect(collect(invocation, { spawn, signal: controller.signal, onSettled: value => { context = value } }))
      .rejects.toMatchObject({ cause: 'abort' })
    expect(state.spawn).toBeUndefined()
    expect(context).toMatchObject({ phase: 'initialize', promptSubmissionState: 'not-submitted' })
  })

  it('reports a not-submitted context when argument validation fails before spawn', async () => {
    const spawn = vi.fn<SpawnProcess>()
    let context: ProviderFailureContext | undefined
    await expect(collect({ ...invocation, args: ['acp', 'serve', '--yolo'] }, {
      spawn,
      onSettled: value => { context = value },
    })).rejects.toMatchObject({ cause: 'protocol' })
    expect(spawn).toHaveBeenCalledTimes(0)
    expect(context).toMatchObject({ phase: 'initialize', promptSubmissionState: 'not-submitted' })
  })

  it('reports settled context exactly once even when the diagnostic sink throws', async () => {
    const { spawn } = harness()
    const calls: ProviderFailureContext[] = []
    await expect(collect(invocation, {
      spawn,
      onSettled: value => { calls.push(value); throw new Error('sink boom') },
    })).resolves.toEqual(['answer'])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ promptSubmissionState: 'submitted', terminalReason: 'end_turn' })
  })

  it('reports latency metrics with named clock origins on a successful turn', async () => {
    const { spawn } = harness()
    let context: ProviderFailureContext | undefined
    await expect(collect(invocation, { spawn, onSettled: value => { context = value } })).resolves.toEqual(['answer'])
    expect(context?.metrics?.spawnToFirstProtocolMessageMs).toBeTypeOf('number')
    expect(context?.metrics?.spawnToFirstProtocolMessageMs).toBeGreaterThanOrEqual(0)
    expect(context?.metrics?.promptToFirstTextMs).toBeTypeOf('number')
    expect(context?.metrics?.promptToTerminalMs).toBeTypeOf('number')
    expect(context?.metrics?.teardownDurationMs).toBeTypeOf('number')
  })

  it('keeps a raw ACP usage snapshot without mapping it to DSH TokenUsage', async () => {
    const { spawn } = harness({
      usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46, cachedReadTokens: 5, thoughtTokens: 0 },
    })
    let context: ProviderFailureContext | undefined
    await expect(collect(invocation, { spawn, onSettled: value => { context = value } })).resolves.toEqual(['answer'])
    // Field names mirror the ACP wire shape; a real zero is preserved, absent optionals stay undefined.
    expect(context?.usage).toEqual({ inputTokens: 12, outputTokens: 34, totalTokens: 46, cachedReadTokens: 5, thoughtTokens: 0 })
    expect(context?.usage).not.toHaveProperty('cachedWriteTokens')
  })

  it('documents an explicit, non-empty gate that blocks any DSH usage mapping', () => {
    // The snapshot must never be emitted as a DSH usage chunk until every gate item is proven.
    // This test pins the gate so it cannot be silently emptied or bypassed.
    expect(ACP_USAGE_DSH_MAPPING_GATE.length).toBeGreaterThanOrEqual(4)
    expect(ACP_USAGE_DSH_MAPPING_GATE.every(item => typeof item === 'string' && item.length > 0)).toBe(true)
    expect(ACP_USAGE_DSH_MAPPING_GATE.join(' ')).toMatch(/uncached-input/)
    expect(ACP_USAGE_DSH_MAPPING_GATE.join(' ')).toMatch(/per-call-vs-cumulative/)
    // It is frozen so a caller cannot mutate the gate away at runtime.
    expect(Object.isFrozen(ACP_USAGE_DSH_MAPPING_GATE)).toBe(true)
  })

  it.each([-1, 1.5, Number.NaN])('rejects an invalid ACP usage count: %s', async inputTokens => {
    const { spawn } = harness({
      usage: { inputTokens, outputTokens: 1, totalTokens: 1 },
    })
    let context: ProviderFailureContext | undefined
    await expect(collect(invocation, { spawn, onSettled: value => { context = value } }))
      .rejects.toMatchObject({ cause: 'protocol' })
    expect(context?.usage).toBeUndefined()
  })

  it('accepts a clean child close racing after terminal validation and before shutdown', async () => {
    const { state, spawn } = harness({ advertiseClose: false })
    await expect(collect(invocation, {
      spawn,
      onStopReason() {
        // Model the exact close-event race synchronously, before shutdown() can set terminating.
        state.child?.emit('close', 0, null)
      },
    })).resolves.toEqual(['answer'])
  })

  it('settles a never-closing child after bounded SIGKILL wait and ignores a late close', async () => {
    const { state, spawn } = harness({ closeOnSigint: false, closeOnSigkill: false })
    const contexts: ProviderFailureContext[] = []
    await expect(collect(invocation, {
      spawn,
      killGraceMs: 5,
      onSettled: value => { contexts.push(value) },
    })).rejects.toMatchObject({ cause: 'process' })
    expect(state.kills).toEqual(['SIGINT', 'SIGKILL'])
    expect(contexts).toHaveLength(1)
    expect(contexts[0]).toMatchObject({ teardownState: 'failed', terminalReason: 'end_turn' })
    expect(contexts[0]?.metrics?.teardownDurationMs).toBeTypeOf('number')

    state.child?.close(0, null)
    await new Promise(resolve => setImmediate(resolve))
    expect(contexts).toHaveLength(1)
  })

  it('preserves the primary abort when bounded teardown also times out', async () => {
    const started = Promise.withResolvers<void>()
    const { state, spawn } = harness({
      closeOnSigint: false,
      closeOnSigkill: false,
      onPrompt: async () => {
        started.resolve()
        return await new Promise<StopReason>(() => undefined)
      },
    })
    const controller = new AbortController()
    const contexts: ProviderFailureContext[] = []
    const pending = collect(invocation, {
      spawn,
      signal: controller.signal,
      killGraceMs: 5,
      onSettled: value => { contexts.push(value) },
    })
    await started.promise
    controller.abort()
    await expect(pending).rejects.toMatchObject({ cause: 'abort' })
    expect(contexts).toHaveLength(1)
    expect(contexts[0]).toMatchObject({ promptSubmissionState: 'submitted', teardownState: 'failed' })
    state.child?.close(0, null)
  })
})
