import { appendFileSync, chmodSync, existsSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

export const name = 'dsh-enhanced-web-owner-real-repair-guard'
export const inject = ['llm', 'agents', 'goals', 'systemPrompt']

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-enhanced-real-repair-guard',
    validate(value) {
      const keys = ['controlPath', 'logPath', 'workspace', 'provider', 'model']
      if (!exactKeys(value, keys) || keys.some(key => !nonempty(value[key]))) {
        return { issues: [{ message: 'controlPath, logPath, workspace, provider and model are required non-empty strings' }] }
      }
      return { value }
    },
  },
}

const bootstrapFileTools = new Set(['read', 'write', 'edit'])
const repairOwnerReadOnlyTools = new Set(['skill_repair_status', 'goal_context', 'get_goal'])
const repairTools = new Set(['read', 'write', 'edit'])
const maxModelCalls = 32
const maxToolCalls = 64

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function nonempty(value) { return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\p{Cc}]/u.test(value) }
function absolutePath(value) { return nonempty(value) && value.startsWith('/') }
function positive(value, fallback, maximum) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('real repair control has an invalid bounded budget')
  return value
}
function exactKeys(value, keys, required = keys) {
  return object(value) && Object.keys(value).every(key => keys.includes(key)) && required.every(key => Object.hasOwn(value, key))
}
function repairSessionIds(value) {
  const ids = value.repairSessionIds ?? (value.repairSessionId === undefined ? [] : [value.repairSessionId])
  if (!Array.isArray(ids) || ids.length > 4 || ids.some(id => !nonempty(id) || id === value.ownerSessionId) || new Set(ids).size !== ids.length) throw new Error('real repair control has invalid repair sessions')
  return ids
}
function contained(workspace, path) {
  const root = resolve(workspace)
  const target = resolve(workspace, path)
  return target === root || target.startsWith(`${root}${sep}`) ? target : undefined
}
function privateControlPath(path) {
  if (!absolutePath(path)) throw new Error('real repair control path must be absolute')
  let parent; let control
  try { parent = statSync(dirname(path)); control = statSync(path) } catch { throw new Error('real repair control is unavailable') }
  if (!parent.isDirectory() || (parent.mode & 0o777) !== 0o700 || !control.isFile() || (control.mode & 0o777) !== 0o600 || parent.uid !== process.getuid?.() || control.uid !== process.getuid?.()) {
    throw new Error('real repair control must be owner-written in a 0700 parent with mode 0600')
  }
}

/** Read the host-written, private control file without accepting a looser phase. */
export function readControl(path, workspace) {
  privateControlPath(path)
  let value
  try { value = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new Error('real repair control is invalid JSON') }
  if (!object(value) || !['bootstrap', 'repair'].includes(value.phase) || !nonempty(value.ownerSessionId)) throw new Error('real repair control has an invalid phase or owner session')
  if (!nonempty(value.artifactPath) || value.artifactPath.startsWith('/') || !contained(workspace, value.artifactPath)) throw new Error('real repair control has an invalid artifact path')
  const modelCalls = positive(value.maxModelCalls, 8, maxModelCalls)
  const toolCalls = positive(value.maxToolCalls, 32, maxToolCalls)
  if (value.phase === 'bootstrap') {
    if (!exactKeys(value, ['phase', 'ownerSessionId', 'repairSessionIds', 'allowedOwnerTools', 'artifactPath', 'maxModelCalls', 'maxToolCalls'], ['phase', 'ownerSessionId', 'allowedOwnerTools', 'artifactPath'])) throw new Error('real repair bootstrap control has unknown or missing fields')
    if (!Array.isArray(value.allowedOwnerTools) || value.allowedOwnerTools.length > 32 || value.allowedOwnerTools.some(tool => !nonempty(tool)) || new Set(value.allowedOwnerTools).size !== value.allowedOwnerTools.length) throw new Error('real repair bootstrap control has invalid owner tools')
    return { phase: value.phase, ownerSessionId: value.ownerSessionId, repairSessionIds: repairSessionIds(value), allowedOwnerTools: value.allowedOwnerTools, artifactPath: value.artifactPath, maxModelCalls: modelCalls, maxToolCalls: toolCalls }
  }
  if (!exactKeys(value, ['phase', 'ownerSessionId', 'repairSessionId', 'repairSessionIds', 'ownerArm', 'artifactPath', 'maxModelCalls', 'maxToolCalls'], ['phase', 'ownerSessionId', 'ownerArm', 'artifactPath'])) throw new Error('real repair control has unknown or missing fields')
  const ids = repairSessionIds(value)
  if (ids.length === 0 || !exactKeys(value.ownerArm, ['name', 'arguments']) || value.ownerArm.name !== 'skill_repair_arm' || !object(value.ownerArm.arguments)) throw new Error('real repair control has an invalid repair authority')
  return { phase: value.phase, ownerSessionId: value.ownerSessionId, repairSessionIds: ids, ownerArm: value.ownerArm, artifactPath: value.artifactPath, maxModelCalls: modelCalls, maxToolCalls: toolCalls }
}

function fileArgumentsAllowed(name, args, workspace, artifactPath, allowWorkspaceRoot) {
  const fields = name === 'read' ? ['file_path', 'offset', 'limit'] : name === 'write' ? ['file_path', 'content'] : name === 'edit' ? ['file_path', 'old_string', 'new_string', 'replace_all'] : undefined
  if (!fields || !exactKeys(args, fields, ['file_path']) || typeof args.file_path !== 'string') return false
  const target = contained(workspace, args.file_path)
  const artifact = resolve(workspace, artifactPath)
  return target === artifact || allowWorkspaceRoot && target === resolve(workspace)
}

export function toolAllowed(control, sessionId, name, args, workspace, priorOwnerArms = 0, priorBootstrapSaves = 0) {
  if (control.phase === 'bootstrap') return control.repairSessionIds.includes(sessionId) && repairTools.has(name) && fileArgumentsAllowed(name, args, workspace, control.artifactPath, false) || sessionId === control.ownerSessionId && control.allowedOwnerTools.includes(name)
    && (name !== 'skill_save' || priorBootstrapSaves === 0)
    && (!bootstrapFileTools.has(name) || fileArgumentsAllowed(name, args, workspace, control.artifactPath, name === 'read'))
  if (sessionId === control.ownerSessionId) {
    if (name === 'skill_repair_arm') return priorOwnerArms === 0 && isDeepStrictEqual(args, control.ownerArm.arguments)
    return repairOwnerReadOnlyTools.has(name) || name === 'read' && fileArgumentsAllowed(name, args, workspace, control.artifactPath, false)
  }
  return control.repairSessionIds.includes(sessionId) && repairTools.has(name) && fileArgumentsAllowed(name, args, workspace, control.artifactPath, false)
}

export function logState(path) {
  if (!existsSync(path)) return { modelCalls: new Map(), toolCalls: new Map(), ownerArms: new Map(), bootstrapSaves: new Map() }
  const stat = lstatSync(path)
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error('real repair log must be an owner-only regular file')
  const modelCalls = new Map(); const toolCalls = new Map(); const ownerArms = new Map(); const bootstrapSaves = new Map()
  for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
    let row; try { row = JSON.parse(line) } catch { throw new Error('real repair log is invalid JSONL') }
    if (!object(row) || !nonempty(row.sessionId)) continue
    if (row.event === 'dispatch') modelCalls.set(row.sessionId, (modelCalls.get(row.sessionId) ?? 0) + 1)
    if (row.event === 'tool-execute') {
      toolCalls.set(row.sessionId, (toolCalls.get(row.sessionId) ?? 0) + 1)
      if (row.name === 'skill_repair_arm') ownerArms.set(row.sessionId, (ownerArms.get(row.sessionId) ?? 0) + 1)
      if (row.name === 'skill_save') bootstrapSaves.set(row.sessionId, (bootstrapSaves.get(row.sessionId) ?? 0) + 1)
    }
  }
  return { modelCalls, toolCalls, ownerArms, bootstrapSaves }
}

function privateLog(path) {
  if (existsSync(path)) {
    const stat = lstatSync(path)
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error('real repair log must be an owner-only regular file')
  }
}

function abortable(operation, signal) {
  return new Promise((resolvePromise, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    operation.then(value => { signal.removeEventListener('abort', abort); resolvePromise(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

export function createRunGuard({ record, control, state, provider, model, sessionForAgent }) {
  const controller = new AbortController(); const active = new Set()
  const reject = (agent, reason) => { agent?.cancel?.({ kind: 'hook', reason }); throw new Error(`real repair ${reason}`) }
  return {
    stop() { if (!controller.signal.aborted) controller.abort(new Error('real repair stopped')); for (const agent of active) agent.cancel?.({ kind: 'hook', reason: 'web-real-repair-stopped' }) },
    async *stream(options, agent, next) {
      const sessionId = sessionForAgent(agent)
      const current = control()
      const known = sessionId !== 'bootstrap-pending' && (sessionId === current.ownerSessionId || (current.repairSessionIds ?? []).includes(sessionId))
      if (!known || options.provider !== provider || options.model !== model || controller.signal.aborted || (state.modelCalls.get(sessionId) ?? 0) >= current.maxModelCalls) reject(agent, 'model request rejected')
      options.signal?.throwIfAborted()
      const call = (state.modelCalls.get(sessionId) ?? 0) + 1; state.modelCalls.set(sessionId, call)
      record({ event: 'dispatch', sessionId, call, provider: options.provider, model: options.model })
      active.add(agent)
      const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
      let iterator; let usage = null; let finish = null; let drained = false
      try {
        iterator = next()[Symbol.asyncIterator]()
        while (true) {
          const item = await abortable(iterator.next(), signal)
          if (item.done) { drained = true; break }
          if (item.value.type === 'usage') usage = Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens'].filter(key => item.value.usage[key] !== undefined).map(key => [key, Number.isSafeInteger(item.value.usage[key]) && item.value.usage[key] >= 0 ? item.value.usage[key] : null]))
          if (item.value.type === 'finish') finish = item.value.reason.kind
          yield item.value
        }
      } finally { active.delete(agent); try { void iterator?.return?.().catch(() => {}) } catch {}; record({ event: 'settled', sessionId, call, drained, finish, usage }) }
    },
  }
}

export function apply(ctx, config) {
  if (![config.controlPath, config.logPath, config.workspace].every(absolutePath) || !nonempty(config.provider) || !nonempty(config.model)) throw new Error('real repair guard requires absolute paths and exact provider/model')
  const workspace = resolve(config.workspace)
  if (workspace !== config.workspace) throw new Error('real repair guard workspace must be canonical')
  const control = () => readControl(config.controlPath, workspace)
  control(); privateLog(config.logPath)
  const state = logState(config.logPath)
  const record = value => { privateLog(config.logPath); appendFileSync(config.logPath, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 }); chmodSync(config.logPath, 0o600) }
  const sessionForAgent = agent => agent ? String(agent.session.id) : undefined
  const guard = createRunGuard({ record, control, state, provider: config.provider, model: config.model, sessionForAgent })
  const activeSkillRuns = new Map()
  ctx.on('agent/request', async (_input, next) => {
    const request = await next()
    return { ...request, maxTokens: Math.min(request.maxTokens ?? 4096, 4096) }
  })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next(); const sessionId = sessionForAgent(context.agent); const current = control()
    const allowed = current.phase === 'bootstrap' && sessionId === current.ownerSessionId ? new Set(current.allowedOwnerTools.filter(name => name !== 'skill_save' || (state.bootstrapSaves.get(sessionId) ?? 0) === 0))
      : current.phase === 'repair' && sessionId === current.ownerSessionId ? new Set((state.ownerArms.get(sessionId) ?? 0) === 0 ? ['skill_repair_arm'] : ['read', ...repairOwnerReadOnlyTools])
        : current.repairSessionIds.includes(sessionId) ? repairTools : new Set()
    const tools = assembly.tools.filter(tool => allowed.has(tool.name))
    record({ event: 'assembly', phase: current.phase, sessionId, availableToolNames: assembly.tools.map(tool => tool.name), toolNames: tools.map(tool => tool.name) })
    return { ...assembly, tools, sections: [...assembly.sections, { name: 'real-repair-guard', text: 'Use only the tools presented for this owner-controlled repair. Do not infer a repair implementation, content, or tool order from this guard.' }] }
  })
  ctx.on('llm/stream', (options, next) => { const agent = ctx.agents.currentInitiator(); record({ event: 'request-tools', sessionId: sessionForAgent(agent), toolNames: options.tools?.map(tool => tool.name) ?? [] }); return guard.stream(options, agent, next) })
  ctx.on('tools/execute', async (execution, next) => {
    if (!execution.agent) return await next()
    const current = control(); const sessionId = sessionForAgent(execution.agent)
    if ((state.toolCalls.get(sessionId) ?? 0) >= current.maxToolCalls) throw new Error('real repair tool budget rejected this request')
    const root = String(execution.rootCallId)
    const parent = activeSkillRuns.get(root)
    const nestedSkillArtifact = parent !== undefined && parent.agent === execution.agent && parent.token === execution.parent
      && ['read', 'write', 'edit'].includes(execution.name)
      && (String(execution.callId).startsWith(`${parent.callId}:skill:`) || String(execution.callId).startsWith(`${parent.callId}:skill-observation:`))
      && current.phase === 'bootstrap' && sessionId === current.ownerSessionId && current.allowedOwnerTools.includes('skill_run')
      && fileArgumentsAllowed(execution.name, execution.arguments, workspace, current.artifactPath, false)
    if (!nestedSkillArtifact && !toolAllowed(current, sessionId, execution.name, execution.arguments, workspace, state.ownerArms.get(sessionId) ?? 0, state.bootstrapSaves.get(sessionId) ?? 0)) throw new Error('real repair tool request is outside the controlled session authority')
    state.toolCalls.set(sessionId, (state.toolCalls.get(sessionId) ?? 0) + 1)
    if (execution.name === 'skill_repair_arm') state.ownerArms.set(sessionId, (state.ownerArms.get(sessionId) ?? 0) + 1)
    const rootSkillRun = !nestedSkillArtifact && execution.name === 'skill_run'
    if (rootSkillRun) activeSkillRuns.set(root, { agent: execution.agent, token: execution.token, callId: String(execution.callId) })
    try {
      const result = await next()
      const concludesSetup = result?.isError === false && ((current.phase === 'bootstrap' && sessionId === current.ownerSessionId && execution.name === 'skill_save')
        || (current.phase === 'repair' && sessionId === current.ownerSessionId && execution.name === 'skill_repair_arm'))
      if (concludesSetup) {
        if (typeof execution.concludeTurn !== 'function') throw new Error('real repair setup turn conclusion is unavailable')
        await execution.concludeTurn()
      }
      if (current.phase === 'bootstrap' && sessionId === current.ownerSessionId && execution.name === 'skill_save') state.bootstrapSaves.set(sessionId, (state.bootstrapSaves.get(sessionId) ?? 0) + 1)
      record({ event: 'tool-execute', phase: current.phase, sessionId, name: execution.name, nested: nestedSkillArtifact, path: typeof execution.arguments?.file_path === 'string' ? execution.arguments.file_path : undefined })
      return concludesSetup ? { ...result } : result
    } finally { if (rootSkillRun) activeSkillRuns.delete(root) }
  })
  ctx.effect(() => () => guard.stop())
}

export default { name, Config, inject, apply }
