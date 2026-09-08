import { appendFileSync, existsSync, readFileSync } from 'node:fs'

export const name = 'dsh-enhanced-repo-autonomy-real-observer'
export const inject = ['agents']

function fail(message) { throw new Error(`repo autonomy observer: ${message}`) }

/**
 * Records and bounds a real-model experiment.  It neither changes prompts or
 * tools nor interprets a tool call: goal planning, investigation, isolation
 * execution and verification remain the installed product's decisions.
 */
export function apply(ctx) {
  const path = process.env.DSH_REPO_AUTONOMY_OBSERVER_LOG
  if (typeof path !== 'string' || path.length === 0) fail('temporary observer log is required')
  const limit = Number(process.env.DSH_REPO_AUTONOMY_MAX_CALLS ?? 8)
  const durationMs = Number(process.env.DSH_REPO_AUTONOMY_DURATION_MS ?? 300000)
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(durationMs) || durationMs < 1000) fail('invalid finite limits')
  let calls = existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line)).filter(entry => entry.event === 'dispatch').length : 0
  const startedAt = Date.now()
  const record = entry => appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
  ctx.inject(['sessionPersistence', 'workspaceRegistry'], async scope => {
    try {
      const headers = await scope.sessionPersistence.list()
      const workspaces = scope.workspaceRegistry.list()
      record({ event: 'startup-session-index', at: Date.now(),
        headers: headers?.map(header => ({ id: header.id, cwd: header.cwd, origin: header.origin })),
        workspaces: workspaces?.map(workspace => ({ id: workspace.id, path: workspace.path, sessionIds: workspace.sessionIds })) })
    } catch { record({ event: 'startup-session-index-unavailable' }) }
  })
  const active = new Set()
  const stop = () => {
    for (const agent of active) agent.cancel({ kind: 'hook', reason: 'repo-autonomy-real-observer-expired' })
  }
  const timer = setTimeout(stop, durationMs); timer.unref?.()
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const cause = event.data.reason?.reason
    const knownCauses = ['assistant-delivery-goal-continuation-timeout', 'assistant-delivery-goal-continuation-cancelled',
      'assistant-delivery-goal-continuation-authorization-revoked', 'assistant-goals-step-cancelled',
      'assistant-goals-step-admission-failed', 'assistant-goals-budget-expired', 'assistant-goals-budget-rejected', 'assistant-goals-tool-budget-rejected', 'assistant-goals-budget-unloaded', 'assistant-delivery-session-lease-lost', 'assistant-delivery-session-lease-required',
      'assistant-delivery-scheduled-goal-wake-revoked', 'assistant-delivery-scheduled-goal-wake-cancelled',
      'assistant-delivery-scheduled-goal-settlement-failed',
      'repo-autonomy-real-observer-expired', 'repo-autonomy-real-observer-limit']
    // Keep only framework settlement data.  In particular, do not retain the
    // model response, tool arguments, or an Error message here.
    record({ event: 'turn-end', sessionId: String(session.id), turn: event.data.turn,
      reason: typeof event.data.reason?.kind === 'string' ? event.data.reason.kind : 'unknown',
      causeKind: ['hook', 'user', 'parent', 'disposed', 'legacy'].includes(cause?.kind) ? cause.kind : null,
      cause: cause?.kind === 'hook' && knownCauses.includes(cause.reason) ? cause.reason : null,
      deliveryContinuationTimeoutMs: ctx.get('assistantDelivery', false)?.config?.agentGoalContinuationTimeoutMs ?? null })
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (process.env.DSH_REPO_AUTONOMY_NO_MODEL === '1') {
      record({ event: 'model-blocked' })
      throw new Error('model requests are forbidden during the setup-only probe')
    }
    const agent = ctx.agents.currentInitiator()
    if (Date.now() - startedAt >= durationMs || calls >= limit) {
      agent?.cancel({ kind: 'hook', reason: 'repo-autonomy-real-observer-limit' })
      throw new Error('repo autonomy observer reached its finite experiment limit')
    }
    const call = ++calls
    if (agent) active.add(agent)
    const serialized = JSON.stringify({ system: options.system, messages: options.messages })
    record({ event: 'capabilities', call, nativeGoals: !!ctx.get('goals', false), goals: ctx.get('assistantGoals', false)?.health(), toolNames: options.tools?.map(tool => tool.name), goalEntry: serialized.includes('Native goal workflow is configured'), isolationSection: serialized.includes('Environment capability constraint:') })
    if (options.tools?.some(tool => tool.name === 'isolation_grants') && !options.tools.some(tool => tool.name === 'goal_create')) throw new Error('installed profile does not expose native goal creation')
    record({ event: 'dispatch', call, provider: options.provider, model: options.model, maxTokens: options.maxTokens ?? null })
    let usage = null; let finish = null; let drained = false
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') usage = chunk.usage
        if (chunk.type === 'finish') finish = chunk.reason.kind
        yield chunk
      }
      drained = true
    } finally { active.delete(agent); record({ event: 'settled', call, drained, finish, usage }) }
  })
  ctx.on('tools/execute', async (execution, next) => {
    record({ event: 'tool-dispatch', name: execution.name })
    try { const result = await next(); record({ event: 'tool-settled', name: execution.name }); return result }
    catch (error) { record({ event: 'tool-failed', name: execution.name }); throw error }
  })
  ctx.effect(() => () => { clearTimeout(timer); stop() })
}
