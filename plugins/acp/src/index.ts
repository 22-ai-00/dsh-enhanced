/**
 * Native-first Agent Client Protocol bridge for DeepSeek Harness.
 *
 * The connection and prompt lifecycle follows DSH's upstream ACP bridge while
 * session controls and presentation remain wired to native DSH services and
 * durable session events.
 *
 * @module @dsh-enhanced/acp
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { Readable, Writable } from 'node:stream'
import Schema from '@deepseek-ai/schemastery'
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent as AcpAgent,
  type AuthenticateRequest,
  type CancelNotification,
  type CloseSessionRequest,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type StopReason,
  type Stream,
} from '@agentclientprotocol/sdk'
import {
  installModelSelection,
  type Agent,
  type ModelSelection,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import { createUserMessage, errorChain, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-user-approval'
import { createSessionEventMapper, type SessionEventMapper } from './codec.ts'
import {
  buildSessionConfigOptions,
  modeState,
  setNativeMode,
  setSessionConfigOption,
} from './control.ts'

export const name = 'dsh-enhanced-acp'
export const inject = ['agentDefaultModel', 'agentPresets', 'agents', 'llm']

export interface AcpConfig {
  /** Optional fixed provider route; must be paired with `model`. */
  provider?: string
  /** Optional fixed initial model; must be paired with `provider`. */
  model?: string
  /** Optional initial exact-model reasoning effort. */
  reasoningEffort?: string
  /** Carry every otherwise-unmapped durable DSH event through ACP `_meta`. */
  includeRawEvents?: boolean
  /** Runtime-only transport override used by tests and embedded hosts. */
  stream?: Stream
}

export const Config: Schema<AcpConfig> = Schema.object({
  provider: Schema.string(),
  model: Schema.string(),
  reasoningEffort: Schema.string(),
  includeRawEvents: Schema.boolean().default(true),
})

interface SessionRecord {
  agent: Agent
  dispose: () => Promise<void>
  selection: ModelSelectionRef
  mapper: SessionEventMapper
  inflight: {
    resolve: (reason: StopReason) => void
    reject: (error: Error) => void
    messageId: string
    turn: number | undefined
    endReason: TurnEndReason | undefined
  } | undefined
  modeSwitch: Promise<void>
}

interface ContinuableDrain {
  drainContinuableDescendants(parents: readonly Agent[]): Promise<void>
}

function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

function turnEndToStopReason(reason: TurnEndReason): StopReason {
  switch (reason.kind) {
    case 'completed':
      return 'end_turn'
    case 'max-tokens':
      return 'max_tokens'
    case 'interrupted':
      return 'cancelled'
    case 'aborted':
    case 'blocked':
    case 'error':
    default:
      return 'end_turn'
  }
}

function promptToText(prompt: PromptRequest['prompt']): string {
  return prompt.flatMap((block): string[] => {
    if (block.type === 'text') return [block.text]
    if (block.type === 'resource_link') {
      return [`\n[resource_link name=${JSON.stringify(block.name)} uri=${JSON.stringify(block.uri)}]\n`]
    }
    return []
  }).join('')
}

function promptHasUnsupportedContent(prompt: PromptRequest['prompt']): boolean {
  return prompt.some(block => block.type !== 'text' && block.type !== 'resource_link')
}

function validateSessionParams(params: NewSessionRequest): void {
  if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  if (params.additionalDirectories !== undefined && params.additionalDirectories.length > 0) {
    throw invalidParams('additionalDirectories is not supported')
  }
  if ((params.mcpServers ?? []).length > 0) {
    throw invalidParams('per-session mcpServers are not supported; configure MCP through DSH')
  }
}

function copySelection(selection: ModelSelection): ModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
  }
}

/** Mount one ACP server over the host's native DSH agent composition. */
export function apply(ctx: Context, config: AcpConfig = {}): void {
  if ((config.provider === undefined) !== (config.model === undefined)) {
    throw new Error('dsh-enhanced-acp: provider and model must be configured together')
  }

  const agents = ctx.agents
  const defaultModel = ctx.agentDefaultModel
  const llm = ctx.llm
  const agentPresets = ctx.agentPresets
  const logger = ctx.logger
  const includeRawEvents = config.includeRawEvents ?? true
  const sessions = new Map<SessionId, SessionRecord>()
  let closed = false
  let conn: AgentSideConnection

  const assertOpen = (): void => {
    if (closed) throw internalError('the ACP bridge has been disposed')
  }

  const requireSession = (sessionId: SessionId): SessionRecord => {
    const record = sessions.get(sessionId)
    if (record === undefined) throw invalidParams(`unknown session: ${sessionId}`)
    return record
  }

  const ownedRecord = (agent: Agent): SessionRecord | undefined => {
    const record = sessions.get(agent.session.id)
    return record?.agent === agent ? record : undefined
  }

  const notify = (notification: SessionNotification): void => {
    void conn.sessionUpdate(notification).catch((error: unknown) => {
      logger.warn(`dsh-enhanced-acp: session/update failed: ${String(error)}`)
    })
  }

  const settlePrompt = (record: SessionRecord, reason: StopReason): void => {
    const inflight = record.inflight
    if (inflight === undefined) return
    record.inflight = undefined
    inflight.resolve(reason)
  }

  const initialSelection = async (): Promise<ModelSelection> => {
    const base = config.provider === undefined
      ? defaultModel.currentSelection()
      : { provider: config.provider, model: config.model as string }
    const resolved = await llm.resolveCallConfig({
      provider: base.provider,
      model: base.model,
      ...(config.reasoningEffort !== undefined
        ? { reasoningEffort: ReasoningEffortId(config.reasoningEffort) }
        : base.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: base.reasoningEffort }),
    })
    return {
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
    }
  }

  const drainAndDispose = async (records: readonly SessionRecord[]): Promise<void> => {
    const subagents = ctx.get('subagents') as ContinuableDrain | undefined
    if (subagents !== undefined) {
      try {
        await subagents.drainContinuableDescendants(records.map(record => record.agent))
      } catch (error: unknown) {
        logger.warn(`dsh-enhanced-acp: continuable subagent teardown failed: ${String(error)}`)
      }
    }
    const outcomes = await Promise.allSettled(records.map(record => record.dispose()))
    const failures = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason as unknown] : [])
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `ACP agent teardown failed for ${failures.length} session(s): ${failures.map(errorChain).join('; ')}`,
      )
    }
  }

  ctx.on('session/event', (session, event: SessionEvent) => {
    const record = sessions.get(session.header.id)
    if (record === undefined || record.agent.session !== session) return
    try {
      for (const update of record.mapper.map(event)) {
        notify({ sessionId: record.agent.session.id, update })
      }
    } finally {
      const inflight = record.inflight
      if (inflight !== undefined && event.type === 'turn/end' && inflight.turn === event.data.turn) {
        if (event.data.reason.kind === 'error') {
          record.inflight = undefined
          inflight.reject(internalError(`turn failed: ${event.data.reason.error.message}`))
        } else {
          inflight.endReason = event.data.reason
        }
      }
    }
  })

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const inflight = ownedRecord(agent)?.inflight
    if (inflight !== undefined && inflight.messageId === message.id) inflight.turn = turn
  })

  ctx.on('agent/error', ({ agent, turn, error }) => {
    const record = ownedRecord(agent)
    const inflight = record?.inflight
    if (record === undefined || inflight === undefined || inflight.turn === turn) return
    record.inflight = undefined
    inflight.reject(internalError(`turn failed: ${errorChain(error)}`))
  })

  ctx.on('approval/request', (request, next) => {
    const record = ownedRecord(request.agent)
    if (record === undefined || request.callId === undefined) return next()
    return conn.requestPermission({
      sessionId: record.agent.session.id,
      toolCall: { toolCallId: request.callId },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    }).then(({ outcome }) => {
      if (outcome.outcome === 'cancelled') return 'cancelled'
      return outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected'
    })
  })

  ctx.on('llm/adapters-updated', () => {
    for (const [sessionId, record] of sessions) {
      void buildSessionConfigOptions(llm, record.selection).then((configOptions) => {
        if (sessions.get(sessionId) !== record) return
        notify({ sessionId, update: { sessionUpdate: 'config_option_update', configOptions } })
      }).catch((error: unknown) => {
        logger.warn(`dsh-enhanced-acp: failed to refresh model catalog for ${sessionId}: ${String(error)}`)
      })
    }
  })

  const makeAgent = (connection: AgentSideConnection): AcpAgent => {
    conn = connection
    return {
      initialize(_params: InitializeRequest): Promise<InitializeResponse> {
        return Promise.resolve({
          protocolVersion: PROTOCOL_VERSION,
          agentInfo: { name: 'dsh-enhanced-acp', version: '0.1.0' },
          agentCapabilities: {
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
            sessionCapabilities: { close: {} },
            _meta: {
              dsh: {
                nativeSessionControls: true,
                dynamicModelSwitching: 'next-safely-assembled-step',
                rawSessionEvents: includeRawEvents,
              },
            },
          },
          authMethods: [],
        })
      },

      authenticate(_params: AuthenticateRequest): Promise<void> {
        return Promise.resolve()
      },

      async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
        assertOpen()
        validateSessionParams(params)
        const [current, initialPreset] = await Promise.all([
          initialSelection(),
          agentPresets.resolve(),
        ])
        const selection: ModelSelectionRef = { current, assembled: undefined }
        const sessionId = SessionId(randomUUID())
        const handle = await agents.create({
          sessionId,
          meta: { cwd: params.cwd, agentPreset: initialPreset.id },
          agentOptions: { provider: current.provider, model: current.model },
          setup: async (agentCtx) => {
            installModelSelection(agentCtx, selection)
            await agentPresets.mount(agentCtx, initialPreset.id)
          },
        })
        if (closed) {
          await handle.dispose()
          throw internalError('connection closed during session/new')
        }
        const record: SessionRecord = {
          agent: handle.agent,
          dispose: () => handle.dispose(),
          selection,
          mapper: createSessionEventMapper({ includeRawEvents }),
          inflight: undefined,
          modeSwitch: Promise.resolve(),
        }
        sessions.set(sessionId, record)
        try {
          return {
            sessionId,
            modes: await modeState(agentPresets, handle.agent),
            configOptions: await buildSessionConfigOptions(llm, selection),
            _meta: {
              dsh: {
                sessionHeader: handle.agent.session.header,
                selection: copySelection(current),
              },
            },
          }
        } catch (error: unknown) {
          sessions.delete(sessionId)
          await handle.dispose()
          throw error
        }
      },

      async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
        assertOpen()
        const record = requireSession(SessionId(params.sessionId))
        try {
          const selected = record.modeSwitch.then(() => setNativeMode(agentPresets, record.agent, params.modeId))
          record.modeSwitch = selected.then(() => undefined, () => undefined)
          const outcome = await selected
          return { _meta: { dsh: { outcome } } }
        } catch (error: unknown) {
          throw invalidParams(error instanceof Error ? error.message : String(error))
        }
      },

      async setSessionConfigOption(
        params: SetSessionConfigOptionRequest,
      ): Promise<SetSessionConfigOptionResponse> {
        assertOpen()
        const record = requireSession(SessionId(params.sessionId))
        try {
          const configOptions = await setSessionConfigOption(
            llm,
            record.selection,
            params.configId,
            params.value,
          )
          return {
            configOptions,
            _meta: { dsh: { selection: copySelection(record.selection.current as ModelSelection) } },
          }
        } catch (error: unknown) {
          throw invalidParams(error instanceof Error ? error.message : String(error))
        }
      },

      async prompt(params: PromptRequest): Promise<PromptResponse> {
        assertOpen()
        const record = requireSession(SessionId(params.sessionId))
        await record.modeSwitch
        if (record.inflight !== undefined) throw invalidParams('a prompt is already in flight for this session')
        if (promptHasUnsupportedContent(params.prompt)) {
          throw invalidParams('only text and resource_link prompt content is supported')
        }
        const text = promptToText(params.prompt)
        if (text.trim().length === 0) throw invalidParams('empty prompt')
        if (ctx.agents.get(record.agent.id) !== record.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }

        const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
        const stopReason = await new Promise<StopReason>((resolve, reject) => {
          const inflight: NonNullable<SessionRecord['inflight']> = {
            resolve,
            reject,
            messageId: message.id,
            turn: undefined,
            endReason: undefined,
          }
          record.inflight = inflight
          try {
            record.agent.followup(message)
          } catch (error: unknown) {
            record.inflight = undefined
            throw internalError(`prompt was not queued: ${error instanceof Error ? error.message : String(error)}`)
          }
          void record.agent.whenIdle().then(() => {
            if (record.inflight !== inflight) return
            record.inflight = undefined
            const end = inflight.endReason
            inflight.resolve(end === undefined
              ? 'cancelled'
              : end.kind === 'max-tokens'
                ? 'end_turn'
                : turnEndToStopReason(end))
          })
        })
        return { stopReason }
      },

      cancel(params: CancelNotification): Promise<void> {
        const record = sessions.get(SessionId(params.sessionId))
        if (record === undefined) return Promise.resolve()
        record.agent.cancel({ kind: 'user' })
        settlePrompt(record, 'cancelled')
        return Promise.resolve()
      },

      async closeSession(params: CloseSessionRequest): Promise<void> {
        const sessionId = SessionId(params.sessionId)
        const record = requireSession(sessionId)
        sessions.delete(sessionId)
        await record.modeSwitch
        record.agent.cancel({ kind: 'user' })
        settlePrompt(record, 'cancelled')
        await drainAndDispose([record])
      },
    }
  }

  const stream: Stream = config.stream ?? ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  )
  conn = new AgentSideConnection(makeAgent, stream)

  let quiescing: Promise<void> | undefined
  const quiesce = (): Promise<void> => {
    if (quiescing !== undefined) return quiescing
    closed = true
    const records = [...sessions.values()]
    sessions.clear()
    for (const record of records) {
      record.agent.cancel({ kind: 'user' })
      settlePrompt(record, 'cancelled')
    }
    quiescing = drainAndDispose(records)
    return quiescing
  }

  void conn.closed
    .catch((error: unknown) => {
      logger.warn(`dsh-enhanced-acp: connection closed with an error: ${String(error)}`)
    })
    .then(quiesce)
    .catch((error: unknown) => {
      logger.warn(`dsh-enhanced-acp: connection-close teardown failed: ${String(error)}`)
    })

  ctx.effect(() => quiesce, 'dsh-enhanced-acp.connection')
}
