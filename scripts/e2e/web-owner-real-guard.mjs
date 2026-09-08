import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const name = 'dsh-enhanced-web-owner-real-run-guard'
export const inject = ['llm', 'agents', 'goals', 'systemPrompt']
export const objective = 'Implement summarize.mjs: read a JSON array of orders from stdin, ignore cancelled orders, sum integer amountCents by currency, and print one JSON object with sorted currency keys followed by a newline.'

/** Keep experiment tools aligned with the actual native turn, not prompt claims. */
export function experimentToolNames(nativeGoalRound, goalExists = false) {
  return nativeGoalRound ? ['read', 'write', 'edit', 'get_goal'] : goalExists ? [] : ['goal_create']
}

function inNativeGoalRound(agent) {
  const events = agent.session.snapshotEvents()
  const start = events.findLast(event => event.type === 'turn/start')
  return start !== undefined && events.some(event => event.seq > start.seq && event.type === 'user/message'
    && event.data.source.kind === 'goal' && event.data.source.round > 0)
}

/** The experiment authorizes only its goal and one local source artifact. */
export function isExperimentToolAllowed(name, args, workspace) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false
  if (name === 'goal_create') return args.objective === objective && args.max_goal_rounds === 2 && args.start_native_rounds === true
    && Object.keys(args).every(key => ['objective', 'max_goal_rounds', 'start_native_rounds'].includes(key))
  if (name === 'get_goal') return Object.keys(args).length === 0
  const fields = {
    read: ['file_path', 'offset', 'limit'], write: ['file_path', 'content'],
    edit: ['file_path', 'old_string', 'new_string', 'replace_all'],
  }[name]
  return fields !== undefined && Object.keys(args).every(key => fields.includes(key))
    && typeof args.file_path === 'string' && resolve(workspace, args.file_path) === resolve(workspace, 'summarize.mjs')
}

// Experiment bounds, not the production Goal token/cost budget. A subscription
// request cannot currently enforce a server-side output token ceiling.
export function createRunGuard({ record, maxCalls = 10, durationMs = 300_000, provider = 'codex-subscription' }) {
  const lifecycle = new AbortController()
  const active = new Set()
  let calls = 0
  let timer
  const stop = () => {
    lifecycle.abort(new Error('Real-model experiment stopped or reached its deadline'))
    clearTimeout(timer)
    for (const agent of active) agent.cancel({ kind: 'hook', reason: 'web-real-experiment-stopped' })
  }
  return {
    stop,
    async *stream(options, agent, next) {
      if (agent === undefined || options.provider !== provider
        || lifecycle.signal.aborted || calls >= maxCalls) {
        agent?.cancel({ kind: 'hook', reason: 'web-real-experiment-call-rejected' })
        throw new Error('Real-model experiment route, lifetime or call limit rejected this request')
      }
      options.signal?.throwIfAborted()
      if (timer === undefined) {
        timer = setTimeout(stop, durationMs)
        timer.unref?.()
      }
      const call = ++calls
      // Persist intent before the real adapter can dispatch; never log prompts,
      // credentials, model output or arbitrary provider error messages here.
      record({ event: 'dispatch', call, provider: options.provider, model: options.model })
      active.add(agent)
      const signal = options.signal === undefined ? lifecycle.signal : AbortSignal.any([options.signal, lifecycle.signal])
      let iterator
      let observedUsage = null
      let finish = null
      let drained = false
      try {
        iterator = next()[Symbol.asyncIterator]()
        while (true) {
          const item = await abortable(iterator.next(), signal)
          if (item.done) { drained = true; break }
          const chunk = item.value
          if (chunk.type === 'usage') {
            const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens']
            observedUsage = Object.fromEntries(fields.filter(key => chunk.usage[key] !== undefined)
              .map(key => [key, Number.isSafeInteger(chunk.usage[key]) && chunk.usage[key] >= 0 ? chunk.usage[key] : null]))
          }
          if (chunk.type === 'finish') finish = chunk.reason.kind
          yield chunk
        }
      } finally {
        active.delete(agent)
        try { void iterator?.return?.().catch(() => {}) } catch {}
        record({ event: 'settled', call, drained, finish, usage: observedUsage })
      }
    },
  }
}

function abortable(operation, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => {
      signal.removeEventListener('abort', abort); reject(error)
    })
  })
}

export function apply(ctx) {
  const path = process.env.DSH_WEB_REAL_LOG
  const workspace = process.env.DSH_WEB_REAL_WORKSPACE
  if (typeof path !== 'string' || path.length === 0 || typeof workspace !== 'string' || !workspace.startsWith('/')) {
    throw new Error('DSH_WEB_REAL_LOG and DSH_WEB_REAL_WORKSPACE must name the temporary experiment')
  }
  const record = entry => {
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
  }
  const guard = createRunGuard({ provider: process.env.DSH_WEB_REAL_PROVIDER || 'codex-subscription', record })
  const claimed = new WeakMap()
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    if (message.source.kind === 'user' || message.source.kind === 'goal') {
      claimed.set(agent, { turn, native: message.source.kind === 'goal' && message.source.round > 0 })
    }
  })
  // Assembly precedes agent/request and the durable user/message append. Use
  // the loop's actual claimed input, then keep execution checks on logged turns.
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    const agent = context.agent
    if (!agent) return assembly
    const start = agent.session.snapshotEvents().findLast(event => event.type === 'turn/start')
    const input = claimed.get(agent)
    const native = input?.turn === start?.data.turn && input?.native === true
    const goalExists = ctx.goals.get(agent) !== undefined
    const names = new Set(experimentToolNames(native, goalExists))
    record({ event: 'assembly', nativeGoalRound: native, goalExists, toolNames: assembly.tools.filter(tool => names.has(tool.name)).map(tool => tool.name) })
    const phase = native ? 'This is the native goal round. Write summarize.mjs using the provided schema, then reply in plain text. The independent verifier runs the checks; do not request shell.'
      : goalExists ? 'This is still the foreground owner request turn. The goal was created but no native goal round has started. Reply briefly now without tools so the Host can start the native goal round.'
        : 'This is the foreground owner request turn. Create the requested goal once, then end the response. Artifact work belongs to the subsequent native goal round.'
    return { ...assembly, tools: assembly.tools.filter(tool => names.has(tool.name)),
      sections: [...assembly.sections, { name: 'real-experiment-phase', text: phase }] }
  })
  ctx.on('llm/stream', (options, next) => {
    record({ event: 'request-tools', toolNames: options.tools?.map(tool => tool.name) ?? [] })
    return guard.stream(options, ctx.agents.currentInitiator(), next)
  })
  ctx.on('tools/execute', async (execution, next) => {
    if (!isExperimentToolAllowed(execution.name, execution.arguments, workspace)) {
      throw new Error('Tool request is outside this single-artifact experiment; use the write tool and let the independent verifier run the checks')
    }
    if (['write', 'edit'].includes(execution.name) && (!execution.agent || !inNativeGoalRound(execution.agent))) {
      throw new Error('Artifact writes require the admitted native goal round')
    }
    return await next()
  })
  ctx.effect(() => guard.stop)
}
