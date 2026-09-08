import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { objective } from './web-owner-real-helpers.mjs'

export const name = 'dsh-enhanced-web-owner-real-skill-guard'
export const inject = ['llm', 'agents', 'goals', 'systemPrompt']

function calls(agent, name) {
  return agent.session.snapshotEvents().filter(event => event.type === 'tool/call' && event.data?.name === name)
}

function nativeGoalRound(agent) {
  const start = agent.session.snapshotEvents().findLast(event => event.type === 'turn/start')
  return start !== undefined && agent.session.snapshotEvents().some(event => event.seq > start.seq
    && event.type === 'user/message' && event.data?.source?.kind === 'goal' && event.data.source.round > 0)
}

function isSummaryPath(args, workspace) {
  return args && typeof args === 'object' && !Array.isArray(args)
    && typeof args.file_path === 'string' && resolve(workspace, args.file_path) === resolve(workspace, 'summarize.mjs')
}

/** The real-model test accepts one source trace and one exact saved replay only. */
export function allowedSkillExperimentTool(name, args, workspace, phase) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false
  if (name === 'goal_create') return args.objective === objective && args.max_goal_rounds === 2 && args.start_native_rounds === true
    && Object.keys(args).every(key => ['objective', 'max_goal_rounds', 'start_native_rounds'].includes(key))
  if (name === 'skill_save') return typeof args.goal_id === 'string' && args.goal_id.length > 0
    && args.name === 'verified-summary' && args.description === 'Replay the independently verified order-summary artifact.'
    && args.bindings_json === '[]' && args.expected_version === 0
    && Object.keys(args).every(key => ['goal_id', 'name', 'description', 'bindings_json', 'expected_version'].includes(key))
  if (name === 'skill_run') return typeof args.goal_id === 'string' && args.goal_id.length > 0
    && args.name === 'verified-summary' && args.version === 1 && args.inputs_json === '{}' && args.invocation_id === 'reuse-1'
    && Object.keys(args).every(key => ['goal_id', 'name', 'version', 'inputs_json', 'invocation_id'].includes(key))
  if (name === 'skill') return args.name === 'verified-summary' && Object.keys(args).every(key => key === 'name')
  if (name === 'write') return phase === 'source' || phase === 'replay' ? isSummaryPath(args, workspace) && typeof args.content === 'string'
    && Object.keys(args).every(key => ['file_path', 'content'].includes(key)) : false
  return false
}

function phaseFor(agent, completedCurrentTurn = false, claimedNative = false) {
  const events = agent.session.snapshotEvents()
  const start = events.findLast(event => event.type === 'turn/start')
  if (completedCurrentTurn && start && events.some(event => event.seq > start.seq && event.type === 'tool/call')) return 'complete'
  const created = calls(agent, 'goal_create').length
  const saved = calls(agent, 'skill_save').length
  const loaded = calls(agent, 'skill').length
  if (claimedNative || nativeGoalRound(agent)) return saved === 0 ? 'source' : 'replay'
  if (created === 0) return 'source-create'
  if (saved === 0) return 'save'
  return loaded === 0 ? 'native-load' : 'replay-create'
}

function names(phase) {
  if (phase === 'source-create' || phase === 'replay-create') return ['goal_create']
  if (phase === 'save') return ['skill_save']
  if (phase === 'native-load') return ['skill']
  if (phase === 'source') return ['write']
  if (phase === 'replay') return ['skill_run']
  return []
}

function abortable(operation, signal) {
  return new Promise((resolvePromise, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    operation.then(value => { signal.removeEventListener('abort', abort); resolvePromise(value) }, error => {
      signal.removeEventListener('abort', abort); reject(error)
    })
  })
}

function createRunGuard({ record, provider, initialCalls = 0, maxCalls = 14, durationMs = 300_000 }) {
  const controller = new AbortController(); let calls = initialCalls; let timer
  const stop = () => { controller.abort(new Error('real skill experiment stopped')); clearTimeout(timer) }
  return {
    stop,
    async *stream(options, agent, next) {
      if (!agent || options.provider !== provider || controller.signal.aborted || calls >= maxCalls) {
        agent?.cancel({ kind: 'hook', reason: 'web-real-skill-call-rejected' })
        throw new Error('real skill experiment route, lifetime or call limit rejected this request')
      }
      if (!timer) { timer = setTimeout(stop, durationMs); timer.unref?.() }
      const call = ++calls; record({ event: 'dispatch', call, provider: options.provider, model: options.model })
      const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
      let iterator; let usage = null; let finish = null; let drained = false
      try {
        iterator = next()[Symbol.asyncIterator]()
        while (true) {
          const item = await abortable(iterator.next(), signal)
          if (item.done) { drained = true; break }
          if (item.value.type === 'usage') {
            usage = Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens'].filter(key => item.value.usage[key] !== undefined)
              .map(key => [key, Number.isSafeInteger(item.value.usage[key]) ? item.value.usage[key] : null]))
          }
          if (item.value.type === 'finish') finish = item.value.reason.kind
          yield item.value
        }
      } finally {
        try { void iterator?.return?.().catch(() => {}) } catch {}
        record({ event: 'settled', call, drained, finish, usage })
      }
    },
  }
}

export function apply(ctx) {
  const path = process.env.DSH_WEB_REAL_LOG
  const workspace = process.env.DSH_WEB_REAL_WORKSPACE
  if (typeof path !== 'string' || !path || typeof workspace !== 'string' || !workspace.startsWith('/')) throw new Error('real skill experiment requires temporary log and workspace')
  const record = value => appendFileSync(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
  const initialCalls = existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(row => row.event === 'dispatch').length : 0
  const guard = createRunGuard({ record, provider: process.env.DSH_WEB_REAL_PROVIDER || 'codex-subscription', initialCalls })
  const claimed = new WeakMap()
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    if (message.source.kind === 'user' || message.source.kind === 'goal') claimed.set(agent, { turn, native: message.source.kind === 'goal' && message.source.round > 0 })
  })
  ctx.on('agent/request', async (_input, next) => ({ ...(await next()), maxTokens: 2048 }))
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next(); const agent = context.agent
    if (!agent) return assembly
    const start = agent.session.snapshotEvents().findLast(event => event.type === 'turn/start')
    const input = claimed.get(agent)
    const phase = phaseFor(agent, true, input?.turn === start?.data.turn && input.native === true); const toolNames = names(phase)
    record({ event: 'assembly', phase, availableToolNames: assembly.tools.map(tool => tool.name), toolNames })
    const directions = phase === 'source-create' ? 'Create the exact requested goal and end this turn.'
      : phase === 'source' ? 'Call write exactly once with file_path set to summarize.mjs and content set to the complete program. Do not use path or file arguments. After that write succeeds, reply in plain text and end the round; do not test, inspect, or call another tool. The independent verifier completes the goal.'
        : phase === 'save' ? 'Save the exact independently verified completed goal with skill_save. Do not use any other tool.'
          : phase === 'replay-create' ? 'Create the exact requested new goal and end this turn.'
            : phase === 'native-load' ? 'Load the native skill named verified-summary with the skill tool. Do not run it or create a goal in this turn.'
            : phase === 'replay' ? 'Run the saved verified-summary skill with skill_run. Do not write the artifact yourself. The independent verifier completes this new goal.'
              : 'Reply briefly without tools.'
    return { ...assembly, tools: assembly.tools.filter(tool => toolNames.includes(tool.name)), sections: [...assembly.sections, { name: 'real-skill-experiment', text: directions }] }
  })
  ctx.on('llm/stream', (options, next) => {
    record({ event: 'request-tools', toolNames: options.tools?.map(tool => tool.name) ?? [] })
    return guard.stream(options, ctx.agents.currentInitiator(), next)
  })
  ctx.on('tools/execute', async (execution, next) => {
    const phase = execution.agent ? phaseFor(execution.agent) : 'complete'
    // Nested write dispatch occurs after skill_run is logged; it is only valid
    // in the replay native round and remains restricted to summarize.mjs.
    const nestedReplayWrite = execution.name === 'write' && phase === 'complete' && execution.agent && calls(execution.agent, 'skill_run').length === 1
    if (!nestedReplayWrite && !allowedSkillExperimentTool(execution.name, execution.arguments, workspace, phase)) throw new Error('tool request is outside the verified-skill experiment')
    if (nestedReplayWrite && !isSummaryPath(execution.arguments, workspace)) throw new Error('nested replay wrote outside summarize.mjs')
    record({ event: 'tool-execute', phase, name: execution.name, path: typeof execution.arguments?.file_path === 'string' ? execution.arguments.file_path : undefined })
    const concludes = execution.name === 'write' && phase === 'source' || execution.name === 'skill_run' && phase === 'replay'
    if (concludes) {
      if (typeof execution.concludeTurn !== 'function') throw new Error('DSH ToolRuntime dispatch hook lacks concludeTurn')
      execution.concludeTurn()
    }
    const result = await next()
    // The source trace is deliberately one successful effect. Concluding this
    // native round prevents the model from appending failed self-check calls,
    // which would make the verified trace unsafe to save.
    return result
  })
  ctx.effect(() => guard.stop)
}
