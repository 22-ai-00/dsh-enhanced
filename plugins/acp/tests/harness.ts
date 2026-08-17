/** In-memory ACP transport over the real DSH agent factory and loop. */

import {
  ClientSideConnection,
  ndJsonStream,
  type Agent as AcpAgent,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type Stream,
} from '@agentclientprotocol/sdk'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  LlmAdapter,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import * as AcpPlugin from '../src/index.ts'
import type { AcpConfig } from '../src/index.ts'

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: (StreamChunk[] | 'hang')[]) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Mock Provider' }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: 'mock', name: 'Mock' }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 64_000 } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptedAdapter: script exhausted')
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    for (const chunk of entry) yield chunk
  }
}

export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

export type CapturedUpdate = SessionNotification['update']

export interface BridgeHarness {
  ctx: Context
  client: ClientSideConnection
  adapter: ScriptedAdapter
  updates: { sessionId: string; update: CapturedUpdate }[]
  permissionRequests: RequestPermissionRequest[]
  onPermission: (request: RequestPermissionRequest) => RequestPermissionResponse
  closeClientTransport(): Promise<void>
  acpFiber: Awaited<ReturnType<Context['plugin']>>
  dispose(): Promise<void>
}

type AcpConfigOverrides = { [K in keyof AcpConfig]?: AcpConfig[K] | undefined }

export async function makeBridgeHarness(options: {
  script?: (StreamChunk[] | 'hang')[]
  config?: AcpConfigOverrides
} = {}): Promise<BridgeHarness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' } })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new ScriptedAdapter(options.script ?? [])
  ctx.llm.registerAdapter(['mock'], adapter)

  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'mock', model: 'mock' }),
  } as never)
  const presetStates = new WeakMap<Agent['ctx'], string>()
  ctx.provide('agentPresets', {
    defaultId: 'standard',
    list: () => Promise.resolve([
      { id: 'standard', name: 'Standard' },
      { id: 'code', name: 'PTC' },
      { id: 'minimal', name: 'Minimal' },
      { id: 'cordis', name: 'Creator' },
    ]),
    resolve: (id?: string) => Promise.resolve({ id: id ?? 'standard' }),
    mount: (agentCtx: Agent['ctx'], id?: string) => {
      presetStates.set(agentCtx, id ?? 'standard')
      return Promise.resolve({ id: id ?? 'standard' })
    },
    recompose: (agentCtx: Agent['ctx'], id: string) => {
      presetStates.set(agentCtx, id)
      return Promise.resolve({ id })
    },
    composedPreset: (agentCtx: Agent['ctx']) => presetStates.get(agentCtx),
  } as never)

  const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const clientWriter = clientToAgent.writable.getWriter()
  const agentStream: Stream = ndJsonStream(agentToClient.writable, clientToAgent.readable)
  const clientStream: Stream = ndJsonStream(new WritableStream<Uint8Array>({
    write: chunk => clientWriter.write(chunk),
  }), agentToClient.readable)

  const updates: BridgeHarness['updates'] = []
  const permissionRequests: RequestPermissionRequest[] = []
  const harness: BridgeHarness = {
    ctx,
    adapter,
    updates,
    permissionRequests,
    onPermission: () => ({ outcome: { outcome: 'cancelled' } }),
    client: undefined as unknown as ClientSideConnection,
    acpFiber: undefined as unknown as BridgeHarness['acpFiber'],
    closeClientTransport: () => clientWriter.close(),
    dispose: () => ctx.fiber.dispose(),
  }
  const makeClient = (_agent: AcpAgent): Client => ({
    sessionUpdate(notification) {
      updates.push({ sessionId: notification.sessionId, update: notification.update })
      return Promise.resolve()
    },
    requestPermission(request) {
      permissionRequests.push(request)
      return Promise.resolve(harness.onPermission(request))
    },
  })

  const config = { includeRawEvents: false, stream: agentStream, ...options.config } as AcpConfig
  harness.acpFiber = await ctx.plugin({
    name: 'dsh-enhanced-acp-lifecycle-test',
    inject: [...AcpPlugin.inject],
    apply: (inner: Context) => { AcpPlugin.apply(inner, config) },
  })
  harness.client = new ClientSideConnection(makeClient, clientStream)
  return harness
}
