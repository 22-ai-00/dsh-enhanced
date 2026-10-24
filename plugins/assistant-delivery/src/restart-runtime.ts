import { createHash, randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ConversationBinding, InboundEnvelope } from './types.js'
import type { RestartRecord, RestartStore } from './restart-store.js'
import { createRestartContinuation } from './restart-native.js'

export interface RestartConfig {
  databasePath: string
  ownerRouteId: string
  maxModelRequests: number
  maxToolCalls: number
  taskTimeoutMs: number
  /** Restart-safe read-only tools; ordinary owner tool availability is unchanged. */
  allowedTools: readonly string[]
}

export const restartContinuationText = 'The serving process completed a planned maintenance restart. Continue the same owner task from the persisted conversation. The restart tool already succeeded; do not restart again or repeat completed operations. Inspect any uncertain external result before further writes. This is a Host continuation, not a new human request.'
export const restartDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export interface RestartRun {
  readonly agent: Agent
  readonly inboxId: string
  readonly continuation?: RestartRecord
  canRequest(): boolean
  request(reason: string): RestartRecord
  requested(): RestartRecord | undefined
  checkpoint(): Promise<RestartRecord | undefined>
  dispose(): void
}

/** Host-owned barriers around the existing native loop; this class never schedules work. */
export function attachRestartRun(input: {
  agent: Agent
  inboxId: string
  binding: Readonly<ConversationBinding>
  envelope: Readonly<InboundEnvelope>
  continuation?: RestartRecord
  store: RestartStore
  config: RestartConfig
  isRestartSafeTool(agent: Agent, name: string): boolean
  authorize(): boolean
  authorizeRestart(): boolean
}): RestartRun {
  const { agent, store, inboxId } = input
  const task = store.getTask(inboxId)
  if (task === undefined) throw new Error('assistant-delivery: restart task budget is missing')
  const original = input.continuation === undefined
  const taskEventOffset = agent.session.snapshotEvents().length
  let live = true
  let eligible = true
  let open = 0
  let ownRequestId = input.continuation?.id
  let timer: ReturnType<typeof setTimeout> | undefined
  let observationWarned = false
  const safeTool = (name: string): boolean => {
    if (!input.config.allowedTools.includes(name)) return false
    try { return input.isRestartSafeTool(agent, name) }
    catch { return false }
  }
  const markIneligible = (reason: string): void => {
    eligible = false
    if (!original || ownRequestId !== undefined) return
    // An unavailable journal removes restart eligibility, but never denies
    // the owner's unrelated model or tool operation.
    try { store.markIneligible(inboxId, reason) } catch { /* fail closed for restart only */ }
  }
  const observationFailed = (): void => {
    markIneligible('observation-unavailable')
    if (observationWarned) return
    observationWarned = true
    try { agent.ctx.logger.warn('assistant-delivery: restart observation unavailable; ordinary task continues') }
    catch { /* logging cannot change the ordinary task outcome */ }
  }
  const observedTask = () => {
    try { return store.getTask(inboxId) }
    catch { observationFailed(); return undefined }
  }
  const observe = (kind: 'model' | 'tool'): void => {
    try { store.observe(inboxId, kind, randomUUID()) }
    catch { observationFailed() }
  }
  const startTimer = (): void => {
    if (timer !== undefined) return
    timer = setTimeout(() => agent.cancel({ kind: 'hook', reason: 'assistant-delivery-restart-budget-expired' }),
      Math.max(1, task.deadline - Date.now()))
    timer.unref?.()
  }
  const assertRecovery = (): void => {
    if (!live || Date.now() >= task.deadline || !input.authorize()) {
      throw new Error('assistant-delivery: restart task authority or deadline changed')
    }
    const current = store.activeRequestForBinding(input.binding.id)
    if (ownRequestId !== undefined && (current?.id !== ownRequestId
      || (input.continuation !== undefined && current.status !== 'resuming'))) {
      throw new Error('assistant-delivery: restart operation was cancelled or replaced')
    }
    if (current !== undefined && (current.inboxId !== inboxId
      || (input.continuation !== undefined && current.status !== 'resuming'))) {
      throw new Error('assistant-delivery: restart continuation no longer owns this task')
    }
  }
  const requested = (): RestartRecord | undefined => {
    if (original && ownRequestId === undefined) return undefined
    const record = store.activeRequestForBinding(input.binding.id)
    return record?.inboxId === inboxId && record.status === 'requested' ? record : undefined
  }
  const noNewWork = (): void => {
    assertRecovery()
    if (original && store.activeRequestForBinding(input.binding.id) !== undefined) {
      throw new Error('assistant-delivery: restart checkpoint is pending')
    }
  }
  const flush = async (): Promise<void> => {
    if (!await agent.ctx.sessions.flush(agent.session)) throw new Error('assistant-delivery: restart session flush failed')
    assertRecovery()
  }
  const taskEvents = () => agent.session.snapshotEvents().slice(taskEventOffset)
  const toolEvidence = (pendingRestartCallId?: string): boolean => {
    const calls = new Map<string, string>()
    const results = new Set<string>()
    for (const event of taskEvents()) {
      if (event.type === 'tool/call') {
        const id = String(event.data.callId)
        if (calls.has(id)) return false
        calls.set(id, event.data.name)
        if (id !== pendingRestartCallId && !safeTool(event.data.name)
          && !(event.data.name === 'delivery_request_restart' && ownRequestId !== undefined)) return false
      } else if (event.type === 'tool/result') {
        const id = String(event.data.message.toolCallId)
        if (!calls.has(id) || results.has(id) || event.data.message.isError === true) return false
        results.add(id)
      }
    }
    return [...calls].every(([id, name]) =>
      (id === pendingRestartCallId && name === 'delivery_request_restart') || results.has(id))
  }
  const removers: (() => void)[] = []
  removers.push(agent.ctx.on('session/event', (session, event) => {
    if (session !== agent.session || !original) return
    if (event.type === 'tool/call' && event.data.name !== 'delivery_request_restart' && !safeTool(event.data.name)) {
      markIneligible('unsafe-tool-call')
    } else if (event.type === 'tool/result' && event.data.message.isError === true) {
      markIneligible('tool-result-error')
    } else if (event.type === 'turn/end' && event.data.reason.kind !== 'completed') {
      markIneligible('turn-incomplete')
    }
  }))
  removers.push(agent.ctx.on('llm/stream', async function* (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) {
    const initiator = agent.ctx.agents.currentInitiator()
    const ownSession = options.sessionId === agent.session.id
    // llm/stream is a process-wide hook. A different initiating Agent with a
    // different Session is unrelated work; a call causally owned by this Agent
    // but routed to another Session is delegation and remains in this budget.
    if (!ownSession && initiator !== agent) { yield* next(); return }
    if (original && ownRequestId === undefined) {
      try {
        store.observeModel(inboxId, { provider: options.provider, model: options.model,
          ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }) })
      } catch { observationFailed() }
      observe('model')
      if (initiator !== agent || !ownSession) markIneligible('delegated-model')
      if (options.maxTokens === undefined || options.maxTokens > task.maxOutputTokens) markIneligible('model-output-budget')
      const current = observedTask()
      const frozen = current?.model
      if (frozen?.provider !== options.provider || frozen.model !== options.model
        || frozen.reasoningEffort !== options.reasoningEffort) markIneligible('model-drift')
      if (current !== undefined && current.modelRequests > task.maxModelRequests) markIneligible('model-count-budget')
      try { yield* next() } catch (error) { markIneligible('model-result-unknown'); throw error }
      return
    }
    if (initiator !== agent || !ownSession) throw new Error('assistant-delivery: restart task cannot delegate a model call')
    noNewWork()
    const model = store.getTask(inboxId)?.model
    if (model === undefined || options.provider !== model.provider || options.model !== model.model
      || options.reasoningEffort !== model.reasoningEffort
      || options.maxTokens === undefined || options.maxTokens > task.maxOutputTokens) {
      throw new Error('assistant-delivery: restart frozen model or output budget changed')
    }
    store.reserve(inboxId, 'model', randomUUID())
    await flush()
    noNewWork()
    open += 1
    try { for await (const chunk of next()) { assertRecovery(); yield chunk } }
    finally { open -= 1 }
  }, { prepend: true }))
  removers.push(agent.ctx.on('tools/execute', async (execution, next) => {
    // Tool dispatches carry the exact target Agent. Preserve unrelated peers;
    // a different target still belongs here when this Agent initiated it.
    const initiator = agent.ctx.agents.currentInitiator()
    if (execution.agent !== agent && initiator !== agent) return await next()
    if (original && ownRequestId === undefined) {
      observe('tool')
      if (execution.agent !== agent || initiator !== agent) markIneligible('delegated-tool')
      if (execution.name !== 'delivery_request_restart' && !safeTool(execution.name)) markIneligible('unsafe-tool')
      const current = observedTask()
      if (current !== undefined && current.toolCalls > task.maxToolCalls) markIneligible('tool-count-budget')
      open += 1
      try {
        const result = await next()
        if (result.isError) markIneligible('tool-result-error')
        return result
      } catch (error) { markIneligible('tool-result-unknown'); throw error }
      finally { open -= 1 }
    }
    if (execution.agent !== agent || initiator !== agent) throw new Error('assistant-delivery: restart task cannot delegate tools')
    noNewWork()
    if (execution.name === 'delivery_request_restart' || !safeTool(execution.name)) {
      throw new Error('assistant-delivery: tool is outside the restart-safe capability contract')
    }
    store.reserve(inboxId, 'tool', randomUUID())
    await flush()
    noNewWork()
    open += 1
    try { return await next() } finally { open -= 1 }
  }, { prepend: true }))
  removers.push(agent.ctx.on('agent/pre-step', async (payload, next) => {
    if (payload.agent !== agent) return await next()
    if (original && ownRequestId === undefined) return await next()
    if (original && store.activeRequestForBinding(input.binding.id) !== undefined) return { kind: 'reject' as const }
    assertRecovery()
    return await next()
  }, { prepend: true }))
  if (!original) startTimer()
  const dispose = (): void => {
    if (!live) return
    live = false
    if (timer !== undefined) clearTimeout(timer)
    for (const remove of removers) remove()
  }
  agent.ctx.effect(() => dispose, 'assistant-delivery.restart-task')
  return {
    agent, inboxId, ...(input.continuation === undefined ? {} : { continuation: input.continuation }), requested, dispose,
    canRequest() {
      try {
        const current = store.getTask(inboxId)
        return live && original && ownRequestId === undefined && eligible && current !== undefined
          && current.toolCalls < task.maxToolCalls && store.isEligible(inboxId)
          && store.activeRequestForBinding(input.binding.id) === undefined
          && input.authorizeRestart()
      } catch { return false }
    },
    request(reason) {
      assertRecovery()
      if (!original || !eligible || !store.isEligible(inboxId) || !input.authorizeRestart()) {
        throw new Error('assistant-delivery: restart is not authorized for this task')
      }
      const response = agent.session.snapshotEvents().findLast(event => event.type === 'assistant/message')
      const calls = response?.type === 'assistant/message'
        ? response.data.message.content.filter(block => block.type === 'tool-call') : []
      if (calls.length !== 1 || calls[0]?.type !== 'tool-call' || calls[0].name !== 'delivery_request_restart') {
        markIneligible('restart-not-exclusive')
        throw new Error('assistant-delivery: restart must be the only tool in its model response')
      }
      if (open !== 1 || !toolEvidence(String(calls[0].id))) {
        markIneligible('tool-evidence-unknown')
        throw new Error('assistant-delivery: prior effects are not proven restart-safe')
      }
      const current = store.getTask(inboxId)
      if (current === undefined || current.modelRequests >= task.maxModelRequests
        || current.toolCalls > task.maxToolCalls || Date.now() >= task.deadline) {
        markIneligible('restart-budget-exhausted')
        throw new Error('assistant-delivery: restart has no remaining budget or deadline')
      }
      const result = store.request(inboxId, { reason, requestKey: `restart:${inboxId}` })
      ownRequestId = result.id
      startTimer()
      return result
    },
    async checkpoint() {
      const record = requested()
      if (record === undefined) return undefined
      assertRecovery()
      if (!eligible || open !== 0 || agent.status !== 'idle'
        || agent.inbox.nextTurn.length !== 0 || agent.inbox.nextStep.length !== 0) {
        throw new Error('assistant-delivery: restart checkpoint is not quiescent')
      }
      await flush()
      if (!toolEvidence()) throw new Error('assistant-delivery: restart tool effects are not all settled')
      const events = agent.session.snapshotEvents()
      return store.checkpoint(record.id, {
        sessionEventCount: events.length,
        sessionDigest: restartDigest(events),
        continuationMessageId: createRestartContinuation({ continuationId: record.id, text: restartContinuationText }).id,
        continuationTextDigest: restartDigest(restartContinuationText),
      })
    },
  }
}
