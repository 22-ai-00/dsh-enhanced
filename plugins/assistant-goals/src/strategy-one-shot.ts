import { randomUUID } from 'node:crypto'
import { foldConsumedWork, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { appendDelegatedPolicyOverrides, applyChildComposition, assertSubagentMaxDepth, captureDelegatedPolicyOverrides, childSessionMeta, finalAssistantOutput, resolveChildAgentOptions, resolveChildDepth } from '@deepseek-ai/dsh-subagent'
import type { ResolvedSubagentStartRequest, SubagentRun, SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import { STRATEGY_PROVIDER } from './strategy-identity.js'

// Adapted from @deepseek-ai/dsh-subagent-in-process-driver 0.2.0-rc.2
// (MIT, Copyright (c) 2026 DeepSeek). AgentRegistry and AgentLoop still own
// creation and the single native turn.
export async function startStrategyOneShot(request: ResolvedSubagentStartRequest, onCreate: (child: Agent) => void): Promise<SubagentRun> {
  assertSubagentMaxDepth(request.maxDepth)
  if (request.signal.aborted) throw new Error('assistant-goals: strategy start was cancelled')
  if (request.label === undefined) throw new Error('assistant-goals: strategy label is required')
  const depth = resolveChildDepth(request.parent, request.maxDepth)
  const id = SessionId(randomUUID())
  // The durable one-shot descriptor label is also the external activation id;
  // it links that activation to this distinct native child session without
  // introducing an unregistered event type into the persisted log.
  const runId = SessionId(request.label)
  const inherited = captureDelegatedPolicyOverrides(request.parent)
  const descriptor = { version: 3, mode: 'one-shot' as const, provider: STRATEGY_PROVIDER,
    ...(request.label === undefined ? {} : { label: request.label }) }
  const handle = await request.parent.ctx.agents.create({
    sessionId: id,
    parentAgent: request.parent,
    meta: childSessionMeta(request.parent, depth, false),
    agentOptions: resolveChildAgentOptions(request.parent, request.agentOptions, depth),
    signal: request.signal,
    setup(childCtx, child) {
      onCreate(child)
      appendDelegatedPolicyOverrides(child.session, inherited)
      applyChildComposition(childCtx, request.parent, { persona: `${STRATEGY_PROVIDER}:${request.label}`, toolFilter: { allow: [] } })
      let appended = false
      childCtx.on('agent/pre-step', async ({ agent }, next) => {
        const decision = await next()
        if (!appended && decision.kind === 'enter') {
          appended = true
          agent.session.append('subagent/descriptor', descriptor)
        }
        return decision
      })
    },
  })
  const child = handle.agent
  let cancelled = false
  const abort = () => { cancelled = true; child.cancel({ kind: 'parent' }) }
  request.signal.addEventListener('abort', abort, { once: true })
  if (request.signal.aborted) abort()
  const result = (async () => {
    try {
      if (!cancelled) {
        child.followup(createUserMessage({ content: request.prompt, source: { kind: 'user' } }))
        await child.whenIdle()
      }
      const events = child.session.snapshotEvents(SessionLogOffset(0))
      const end = foldConsumedWork(events).end
      const output = finalAssistantOutput(events) ?? []
      let stopReason: SubagentStopReason
      switch (end?.data.reason.kind) {
        case 'completed': stopReason = 'completed'; break
        case 'max-tokens': stopReason = 'max-tokens'; break
        case 'aborted': stopReason = 'aborted'; break
        case 'blocked': stopReason = 'refusal'; break
        default: stopReason = 'error'
      }
      return { output, stopReason: cancelled && stopReason !== 'completed' ? 'aborted' as const : stopReason }
    } finally { request.signal.removeEventListener('abort', abort) }
  })()
  return {
    id: runId,
    result,
    async dispose() {
      request.signal.removeEventListener('abort', abort)
      cancelled = true
      const [released] = await Promise.allSettled([handle.dispose(), result])
      if (released.status === 'rejected') throw released.reason
    },
  }
}
