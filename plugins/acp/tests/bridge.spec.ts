import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent as AcpAgent,
  type Client,
  type SessionNotification,
  type Stream,
} from '@agentclientprotocol/sdk'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MODEL_CONFIG_ID, REASONING_CONFIG_ID, modelValue, reasoningValue } from '../src/control.ts'
import * as AcpPlugin from '../src/index.ts'

class MockAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private responses = 0

  override providerInfo(provider: string) {
    return { id: provider, name: 'Mock Provider' }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([
      { provider, id: 'chat', name: 'Chat' },
      { provider, id: 'reasoner', name: 'Reasoner' },
    ])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 64_000 },
      ...(model === 'reasoner'
        ? {
            reasoning: {
              efforts: [
                { id: ReasoningEffortId('low'), name: 'Low' },
                { id: ReasoningEffortId('high'), name: 'High' },
              ],
            },
          }
        : {}),
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    this.responses++
    if (this.responses === 1) {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: 'thinking' }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } }
    }
    const text = `answer-${this.responses}`
    yield { type: 'block-start', index: 1, blockType: 'text' }
    yield { type: 'text-delta', index: 1, text }
    yield { type: 'block-end', index: 1, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface Harness {
  ctx: Context
  client: ClientSideConnection
  adapter: MockAdapter
  updates: SessionNotification['update'][]
  modeSelections: string[]
  dispose(): Promise<void>
}

async function makeHarness(): Promise<Harness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' } })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)

  const modeStates = new WeakMap<Agent, boolean>()
  const modeSelections: string[] = []
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'mock', model: 'chat' }),
  } as never)
  ctx.provide('planMode', {
    get: (agent: Agent) => ({ active: modeStates.get(agent) ?? false }),
    set: (agent: Agent, active: boolean) => {
      modeStates.set(agent, active)
      modeSelections.push(active ? 'plan' : 'default')
      agent.session.append('plan/mode', { active })
      return 'committed'
    },
  } as never)

  const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const clientWriter = clientToAgent.writable.getWriter()
  const clientOutput = new WritableStream<Uint8Array>({
    write: chunk => clientWriter.write(chunk),
  })
  const agentStream: Stream = ndJsonStream(agentToClient.writable, clientToAgent.readable)
  const clientStream: Stream = ndJsonStream(clientOutput, agentToClient.readable)
  const updates: SessionNotification['update'][] = []
  const makeClient = (_agent: AcpAgent): Client => ({
    sessionUpdate: (notification) => {
      updates.push(notification.update)
      return Promise.resolve()
    },
    requestPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
  })

  await ctx.plugin({
    name: 'dsh-enhanced-acp-test',
    inject: [...AcpPlugin.inject],
    apply: (inner: Context) => AcpPlugin.apply(inner, {
      stream: agentStream,
      includeRawEvents: false,
    }),
  })
  return {
    ctx,
    adapter,
    updates,
    modeSelections,
    client: new ClientSideConnection(makeClient, clientStream),
    dispose: () => ctx.fiber.dispose(),
  }
}

describe('native-first DSH ACP bridge', () => {
  let harness: Harness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('advertises native controls and exposes them on a fresh session', async () => {
    harness = await makeHarness()
    const initialized = await harness.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    })
    expect(initialized).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'dsh-enhanced-acp', version: '0.1.0' },
      agentCapabilities: {
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        _meta: { dsh: expect.objectContaining({ nativeSessionControls: true }) },
      },
    })

    const session = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(session.modes).toMatchObject({ currentModeId: 'default' })
    expect(session.configOptions?.find(option => option.id === MODEL_CONFIG_ID)).toMatchObject({
      currentValue: modelValue('mock', 'chat'),
    })
    expect(session.configOptions?.find(option => option.id === REASONING_CONFIG_ID)).toMatchObject({
      currentValue: reasoningValue(undefined),
    })
  })

  it('switches mode, model and reasoning in the current ACP conversation', async () => {
    harness = await makeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await harness.client.setSessionMode({ sessionId, modeId: 'plan' })
    await harness.client.setSessionConfigOption({
      sessionId,
      configId: MODEL_CONFIG_ID,
      value: modelValue('mock', 'reasoner'),
    })
    const selected = await harness.client.setSessionConfigOption({
      sessionId,
      configId: REASONING_CONFIG_ID,
      value: reasoningValue('high'),
    })
    expect(harness.modeSelections).toEqual(['plan'])
    expect(selected.configOptions.find(option => option.id === REASONING_CONFIG_ID)).toMatchObject({
      currentValue: reasoningValue('high'),
    })

    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'first' }] })
    expect(harness.adapter.requests[0]).toMatchObject({
      provider: 'mock',
      model: 'reasoner',
      reasoningEffort: ReasoningEffortId('high'),
    })
    expect(harness.updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' }),
      expect.objectContaining({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } }),
      expect.objectContaining({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer-1' } }),
      expect.objectContaining({ sessionUpdate: 'usage_update', size: 64_000, used: 15 }),
    ]))

    await harness.client.setSessionConfigOption({
      sessionId,
      configId: MODEL_CONFIG_ID,
      value: modelValue('mock', 'chat'),
    })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'second' }] })
    expect(harness.adapter.requests[1]).toMatchObject({ provider: 'mock', model: 'chat' })
    expect(harness.adapter.requests[1]?.reasoningEffort).toBeUndefined()
  })

  it('pushes refreshed ACP selectors when the native DSH model directory changes', async () => {
    harness = await makeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    harness.ctx.llm.registerAdapter(['second'], new MockAdapter())

    await vi.waitFor(() => {
      expect(harness?.updates.some(update => update.sessionUpdate === 'config_option_update')).toBe(true)
    })
  })
})
