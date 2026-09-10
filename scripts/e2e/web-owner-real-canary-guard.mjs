import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { basename, resolve } from 'node:path'
import { templateRenderCanaryTask } from './real-canary-helpers.mjs'

export const name = 'dsh-enhanced-web-owner-real-canary-guard'
export const inject = ['llm', 'agents', 'goals', 'systemPrompt']

const phases = new Set([
  'baseline-create', 'baseline-edit', 'baseline-save',
  'failure-create', 'failure-run',
  'repair-create', 'repair-edit', 'candidate', 'discover', 'canary',
  'promotion-create', 'promotion-run', 'negative-create', 'negative-run', 'readback',
])
const nativePhases = new Set(['baseline-edit', 'failure-run', 'repair-edit', 'promotion-run', 'negative-run'])
const nativeAliases = Object.freeze({
  'baseline-create': 'baseline-edit',
  'failure-create': 'failure-run',
  'repair-create': 'repair-edit',
  'promotion-create': 'promotion-run',
  'negative-create': 'negative-run',
})
const alwaysRejected = new Set(['skill_activate', 'skill_activate_watched', 'write', 'glob', 'grep', 'todo', 'todo_write', 'bash'])
export function templateCanaryForbiddenTool(name) { return alwaysRejected.has(name) }
const toolsByPhase = Object.freeze({
  'baseline-create': ['goal_create'],
  'baseline-edit': ['read', 'edit'],
  'baseline-save': ['skill_save'],
  'failure-create': ['goal_create'],
  'failure-run': ['skill_run'],
  'repair-create': ['goal_create'],
  'repair-edit': ['skill_run', 'read', 'edit'],
  candidate: ['skill_failure_candidate'],
  discover: ['skill_comparison_status'],
  canary: ['skill_canary'],
  'promotion-create': ['goal_create'],
  'promotion-run': ['skill_run'],
  'negative-create': ['goal_create'],
  'negative-run': ['skill_run'],
  readback: ['skill_candidates', 'skill_comparison_status', 'skill_deployment_status', 'skill_watches'],
})

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function keysAre(args, allowed, required = []) {
  if (!object(args)) return false
  const keys = Object.keys(args)
  return keys.every(key => allowed.includes(key)) && required.every(key => keys.includes(key))
}

function boundedString(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\p{Cc}]/u.test(value)
}

function readControl(path) {
  let value
  try { value = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new Error('real canary control is unavailable or invalid') }
  if (!object(value) || !phases.has(value.phase)) throw new Error('real canary control has an invalid phase')
  const expectedCalls = value.expectedCalls ?? value.expected_calls ?? []
  if (!Array.isArray(expectedCalls) || expectedCalls.length > 16 || expectedCalls.some(call => !object(call)
    || typeof (call.toolName ?? call.name) !== 'string' || !object(call.arguments ?? call.args))) {
    throw new Error('real canary control has invalid expected calls')
  }
  const sessionId = value.sessionId ?? value.session_id
  if (sessionId !== undefined && !boundedString(sessionId)) throw new Error('real canary control has an invalid session id')
  return { phase: value.phase, sessionId, expectedCalls: expectedCalls.map(call => ({ name: call.toolName ?? call.name, arguments: call.arguments ?? call.args })) }
}

function expectedFor(control, name, args) {
  return control.expectedCalls.some(call => call.name === name && isDeepStrictEqual(call.arguments, args))
}

function expectedNames(control) {
  const configured = new Set(control.expectedCalls.map(call => call.name))
  const phaseNames = toolsByPhase[control.phase]
  if (control.expectedCalls.length === 0) return ['baseline-edit', 'repair-edit'].includes(control.phase) ? phaseNames : []
  return phaseNames.filter(name => configured.has(name))
}

function inNativeGoalRound(agent) {
  const events = agent.session.snapshotEvents()
  const start = events.findLast(event => event.type === 'turn/start')
  return start !== undefined && events.some(event => event.seq > start.seq && event.type === 'user/message'
    && event.data?.source?.kind === 'goal' && event.data.source.round > 0)
}

function artifactArguments(name, args, workspace, phase) {
  const fields = name === 'read' ? ['file_path', 'offset', 'limit'] : name === 'edit' ? ['file_path', 'old_string', 'new_string', 'replace_all'] : []
  if (fields.length === 0 || !keysAre(args, fields, ['file_path']) || typeof args.file_path !== 'string'
    || resolve(workspace, args.file_path) !== resolve(workspace, templateRenderCanaryTask.artifactPath)) return false
  if (name !== 'edit') return true
  if (phase === 'baseline-edit') return args.old_string === templateRenderCanaryTask.scaffoldSource && args.new_string === templateRenderCanaryTask.legacySource
  if (phase === 'repair-edit') return args.old_string === templateRenderCanaryTask.legacySource && args.new_string === templateRenderCanaryTask.repairedSource
  return true
}

function createArguments(args, phase) {
  const objective = phase === 'baseline-create' ? templateRenderCanaryTask.legacyObjective : templateRenderCanaryTask.strictObjective
  return keysAre(args, ['objective', 'max_goal_rounds', 'start_native_rounds'], ['objective', 'max_goal_rounds', 'start_native_rounds'])
    && args.objective === objective && args.max_goal_rounds === 1 && args.start_native_rounds === true
}

export function templateCanaryFixedToolAllowed(name, args, phase) {
  if (name === 'goal_create') return createArguments(args, phase)
  if (name === 'skill_save') return keysAre(args, ['goal_id', 'name', 'description', 'bindings_json', 'expected_version'], ['goal_id', 'name', 'description', 'bindings_json', 'expected_version'])
    && boundedString(args.goal_id) && args.name === templateRenderCanaryTask.skillName && boundedString(args.description)
    && args.bindings_json === '[]' && args.expected_version === 0
  if (name === 'skill_run') {
    if (!keysAre(args, ['goal_id', 'name', 'version', 'inputs_json', 'invocation_id'], ['goal_id', 'name', 'version', 'inputs_json', 'invocation_id'])
      || !boundedString(args.goal_id) || args.name !== templateRenderCanaryTask.skillName || !boundedString(args.invocation_id)) return false
    if (phase === 'failure-run') return args.version === 1 && args.inputs_json === '{}'
    if (phase === 'repair-edit') return args.version === 1 && args.inputs_json === '{}'
    if (phase === 'promotion-run') return args.version === 2 && args.inputs_json === '{}'
    if (phase !== 'negative-run' || args.version !== 2) return false
    try {
      const inputs = JSON.parse(args.inputs_json)
      return keysAre(inputs, ['implementation'], ['implementation']) && inputs.implementation === templateRenderCanaryTask.negativeInputs.implementation
    } catch { return false }
  }
  if (name === 'skill_failure_candidate') {
    if (!keysAre(args, ['owner_route_id', 'trigger_goal_id', 'trigger_session_id', 'repair_goal_id', 'repair_session_id', 'task_family_id', 'name', 'description', 'bindings_json', 'parent_version'],
      ['owner_route_id', 'trigger_goal_id', 'trigger_session_id', 'repair_goal_id', 'repair_session_id', 'task_family_id', 'name', 'description', 'bindings_json', 'parent_version'])) return false
    let bindings
    try { bindings = JSON.parse(args.bindings_json) } catch { return false }
    return ['owner_route_id', 'trigger_goal_id', 'trigger_session_id', 'repair_goal_id', 'repair_session_id'].every(key => boundedString(args[key]))
      && args.task_family_id === templateRenderCanaryTask.failureCandidate.task_family_id
      && args.name === templateRenderCanaryTask.skillName && args.description === templateRenderCanaryTask.failureCandidate.description
      && args.parent_version === templateRenderCanaryTask.failureCandidate.parent_version && Array.isArray(bindings) && bindings.length === 1
      && keysAre(bindings[0], ['name', 'path', 'stepId'], ['name', 'path', 'stepId'])
      && bindings[0].name === templateRenderCanaryTask.binding.name && bindings[0].path === templateRenderCanaryTask.binding.path && boundedString(bindings[0].stepId)
  }
  if (name === 'skill_comparison_status') return keysAre(args, ['comparison_id'])
    && (args.comparison_id === undefined || boundedString(args.comparison_id))
  if (name === 'skill_canary') return keysAre(args, ['candidate_id', 'profile_id', 'invocation_id', 'owner_route_id', 'expires_at', 'max_runs', 'canary_runs'],
    ['candidate_id', 'profile_id', 'invocation_id', 'owner_route_id', 'expires_at', 'max_runs', 'canary_runs'])
    && ['candidate_id', 'profile_id', 'invocation_id', 'owner_route_id'].every(key => boundedString(args[key]))
    && Number.isSafeInteger(args.expires_at) && args.expires_at > Date.now() && args.expires_at <= Date.now() + 600_000
    && args.max_runs === 2 && args.canary_runs === 1
  if (name === 'skill_candidates') return keysAre(args, ['candidate_id']) && (args.candidate_id === undefined || boundedString(args.candidate_id))
  if (name === 'skill_deployment_status') return keysAre(args, ['deployment_id']) && (args.deployment_id === undefined || boundedString(args.deployment_id))
  if (name === 'skill_watches') return keysAre(args, [])
  return false
}

function directions(phase) {
  if (phase.endsWith('-create')) return 'Create only the exact requested Goal with max_goal_rounds 1 and start_native_rounds true, then end this owner turn.'
  if (phase === 'baseline-edit') return 'This is the native Goal round. Use only read when needed and one edit of render.mjs. Do not inspect or change any other path. The independent verifier supplies acceptance.'
  if (phase === 'repair-edit') return 'This is the native repair Goal round. First call the exact requested template-render version 1 skill_run. After it succeeds, read render.mjs and make the one requested edit to repair it. Do not call any other tool. The independent verifier supplies acceptance.'
  if (phase.endsWith('-run')) return 'This is the native Goal round. Call only the exact pinned template-render skill_run. Do not reproduce its edit manually. The independent verifier supplies acceptance.'
  if (phase === 'baseline-save') return 'Save only the exact independently accepted baseline Goal as template-render version 1.'
  if (phase === 'candidate') return 'Create only the exact failure-derived repair candidate pinned by the owner control.'
  if (phase === 'discover') return 'Use only skill_comparison_status with the pinned arguments to discover or inspect the configured canary profile.'
  if (phase === 'canary') return 'Authorize only the exact finite canary pinned by the owner control.'
  if (phase === 'readback') return 'Perform only the exact read-only lifecycle status call requested by the owner control. Do not start or repeat work.'
  return 'Reply briefly without tools.'
}

function positiveInteger(value, fallback, maximum) {
  if (value === undefined) return fallback
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error('real canary limit must be a positive integer')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > maximum) throw new Error('real canary limit is outside the test bound')
  return parsed
}

function logState(path) {
  if (!existsSync(path)) return { initialCalls: 0, startedAt: undefined }
  const rows = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const dispatches = rows.filter(row => row.event === 'dispatch')
  const startedAt = dispatches.map(row => row.at).filter(value => Number.isSafeInteger(value) && value > 0).at(0)
  return { initialCalls: dispatches.length, startedAt }
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

export function createRunGuard({ record, provider, initialCalls = 0, startedAt, maxCalls = 48, durationMs = 600_000 }) {
  const controller = new AbortController()
  const active = new Set()
  let calls = initialCalls
  let timer
  const deadline = startedAt === undefined ? undefined : startedAt + durationMs
  const stop = () => {
    if (!controller.signal.aborted) controller.abort(new Error('real canary stopped or reached its deadline'))
    clearTimeout(timer)
    for (const agent of active) agent.cancel({ kind: 'hook', reason: 'web-real-canary-stopped' })
  }
  const arm = () => {
    if (timer !== undefined) return
    const remaining = (deadline ?? Date.now() + durationMs) - Date.now()
    if (remaining <= 0) { stop(); return }
    timer = setTimeout(stop, remaining); timer.unref?.()
  }
  return {
    stop,
    async *stream(options, agent, next) {
      arm()
      if (!agent || options.provider !== provider || controller.signal.aborted || calls >= maxCalls) {
        agent?.cancel({ kind: 'hook', reason: 'web-real-canary-call-rejected' })
        throw new Error('real canary route, lifetime or call limit rejected this request')
      }
      options.signal?.throwIfAborted()
      const call = ++calls
      record({ event: 'dispatch', at: Date.now(), call, provider: options.provider, model: options.model })
      active.add(agent)
      const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
      let iterator; let usage = null; let finish = null; let drained = false
      try {
        iterator = next()[Symbol.asyncIterator]()
        while (true) {
          const item = await abortable(iterator.next(), signal)
          if (item.done) { drained = true; break }
          if (item.value.type === 'usage') {
            usage = Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens'].filter(key => item.value.usage[key] !== undefined)
              .map(key => [key, Number.isSafeInteger(item.value.usage[key]) && item.value.usage[key] >= 0 ? item.value.usage[key] : null]))
          }
          if (item.value.type === 'finish') finish = item.value.reason.kind
          yield item.value
        }
      } finally {
        active.delete(agent)
        try { void iterator?.return?.().catch(() => {}) } catch {}
        record({ event: 'settled', call, drained, finish, usage })
      }
    },
  }
}

export function apply(ctx) {
  const logPath = process.env.DSH_WEB_REAL_LOG
  const workspace = process.env.DSH_WEB_REAL_WORKSPACE
  const provider = process.env.DSH_WEB_REAL_PROVIDER
  const controlPath = process.env.DSH_REAL_CANARY_CONTROL_PATH
  if (![logPath, workspace, provider, controlPath].every(value => typeof value === 'string' && value.length > 0) || !workspace.startsWith('/') || !controlPath.startsWith('/')) {
    throw new Error('real canary requires absolute workspace/control paths, log path and exact provider')
  }
  const maxCalls = positiveInteger(process.env.DSH_REAL_CANARY_MAX_CALLS ?? process.env.DSH_WEB_REAL_MAX_CALLS, 48, 48)
  const durationMs = positiveInteger(process.env.DSH_REAL_CANARY_DURATION_MS ?? process.env.DSH_WEB_REAL_DURATION_MS, 600_000, 600_000)
  const record = value => appendFileSync(logPath, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
  const state = logState(logPath)
  const guard = createRunGuard({ record, provider, maxCalls, durationMs, ...state })
  const activeSkillRoots = new Set()
  const claimed = new WeakMap()
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    if (message.source.kind === 'user' || message.source.kind === 'goal') claimed.set(agent, { turn, native: message.source.kind === 'goal' && message.source.round > 0 })
  })
  ctx.on('agent/request', async (_input, next) => ({ ...(await next()), maxTokens: 4096 }))
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    const agent = context.agent
    if (!agent) return assembly
    const control = readControl(controlPath)
    const start = agent.session.snapshotEvents().findLast(event => event.type === 'turn/start')
    const input = claimed.get(agent)
    const native = input?.turn === start?.data.turn ? input.native : inNativeGoalRound(agent)
    const sessionMatches = control.sessionId === undefined || control.sessionId === String(agent.session.id)
    const turnMatches = nativePhases.has(control.phase) === native
    const effective = native && nativeAliases[control.phase]
      ? { ...control, phase: nativeAliases[control.phase] }
      : control
    const names = sessionMatches && (turnMatches || effective !== control)
      ? new Set(nativePhases.has(effective.phase) ? toolsByPhase[effective.phase] : expectedNames(effective))
      : new Set()
    const selected = assembly.tools.filter(tool => names.has(tool.name))
    record({ event: 'assembly', phase: control.phase, native, sessionMatches, availableToolNames: assembly.tools.map(tool => tool.name), toolNames: selected.map(tool => tool.name) })
    return { ...assembly, tools: selected, sections: [...assembly.sections, { name: 'real-canary-phase', text: sessionMatches && (turnMatches || effective !== control) ? directions(effective.phase) : 'This session or turn is outside the current canary phase. Reply briefly without tools.' }] }
  })
  ctx.on('llm/stream', (options, next) => {
    record({ event: 'request-tools', toolNames: options.tools?.map(tool => tool.name) ?? [] })
    return guard.stream(options, ctx.agents.currentInitiator(), next)
  })
  ctx.on('tools/execute', async (execution, next) => {
    let control = readControl(controlPath)
    const agent = execution.agent
    const root = String(execution.rootCallId)
    const nestedArtifact = execution.parent !== undefined && activeSkillRoots.has(root) && ['read', 'edit'].includes(execution.name)
    if (nestedArtifact) {
      if (!artifactArguments(execution.name, execution.arguments, workspace, control.phase)) throw new Error('nested canary skill access escaped render.mjs')
    } else {
      if (templateCanaryForbiddenTool(execution.name)) throw new Error('manual tool is forbidden by the real canary guard')
      if (!agent || control.sessionId !== undefined && control.sessionId !== String(agent.session.id)) throw new Error('tool request does not match the controlled canary session')
      const native = inNativeGoalRound(agent)
      if (native && nativeAliases[control.phase]) control = { ...control, phase: nativeAliases[control.phase] }
      if (nativePhases.has(control.phase) !== native || !toolsByPhase[control.phase].includes(execution.name)) throw new Error('tool request does not match the current canary phase')
      if (['read', 'edit'].includes(execution.name)) {
        if (!artifactArguments(execution.name, execution.arguments, workspace, control.phase)) throw new Error('native canary access escaped render.mjs')
      } else if (!templateCanaryFixedToolAllowed(execution.name, execution.arguments, control.phase)
        || !native && !expectedFor(control, execution.name, execution.arguments)) {
        throw new Error('production tool arguments do not match the exact canary control')
      }
    }
    record({ event: 'tool-execute', phase: control.phase, name: execution.name, nested: nestedArtifact, artifact: ['read', 'edit'].includes(execution.name) ? basename(templateRenderCanaryTask.artifactPath) : undefined })
    const skillRoot = !nestedArtifact && execution.name === 'skill_run'
    if (skillRoot) activeSkillRoots.add(root)
    let result
    try { result = await next() } finally { if (skillRoot) activeSkillRoots.delete(root) }
    const concludes = control.phase === 'baseline-edit' && execution.name === 'read' && !nestedArtifact
      || control.phase === 'repair-edit' && execution.name === 'edit' && !nestedArtifact
      || ['failure-run', 'promotion-run', 'negative-run'].includes(control.phase) && execution.name === 'skill_run'
    if (!result?.isError && concludes) {
      if (typeof execution.concludeTurn !== 'function') throw new Error('DSH ToolRuntime dispatch hook lacks concludeTurn')
      execution.concludeTurn()
    }
    return result
  })
  ctx.effect(() => guard.stop)
}
