import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const name = 'dsh-enhanced-web-owner-real-run-guard'
export const inject = ['llm', 'agents']
export const objective = 'Implement summarize.mjs: read a JSON array of orders from stdin, ignore cancelled orders, sum integer amountCents by currency, and print one JSON object with sorted currency keys followed by a newline.'

/** The experiment authorizes only its goal and one local source artifact. */
export function isExperimentToolAllowed(name, args, workspace) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false
  if (name === 'goal_create') return args.objective === objective && args.max_goal_rounds === 2
    && Object.keys(args).every(key => ['objective', 'max_goal_rounds'].includes(key))
  if (name === 'get_goal') return Object.keys(args).length === 0
  if (name === 'todo_write') return true
  const fields = {
    read: ['file_path', 'offset', 'limit'], write: ['file_path', 'content'],
    edit: ['file_path', 'old_string', 'new_string', 'replace_all'],
  }[name]
  return fields !== undefined && Object.keys(args).every(key => fields.includes(key))
    && typeof args.file_path === 'string' && resolve(workspace, args.file_path) === resolve(workspace, 'summarize.mjs')
}

// Experiment bounds, not the production Goal token/cost budget. A subscription
// request cannot currently enforce a server-side output token ceiling.
export function createRunGuard({ record, maxCalls = 10, durationMs = 300_000 }) {
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
      if (agent === undefined || options.provider !== 'codex-subscription'
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
  const guard = createRunGuard({ record: entry => {
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
  } })
  ctx.on('llm/stream', (options, next) => guard.stream(options, ctx.agents.currentInitiator(), next))
  ctx.on('tools/execute', async (execution, next) => {
    if (!isExperimentToolAllowed(execution.name, execution.arguments, workspace)) {
      throw new Error('Tool request is outside this single-artifact experiment; use the write tool and let the independent verifier run the checks')
    }
    return await next()
  })
  ctx.effect(() => guard.stop)
}
