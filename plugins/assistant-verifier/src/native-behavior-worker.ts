/** Fixed source passed to the native Seatbelt runner. Candidate files are staged read-only by the trusted runner. */
export const NATIVE_BEHAVIOR_SOURCE = String.raw`
import { createHash } from 'node:crypto'
import { createRequire, registerHooks } from 'node:module'
import { existsSync, readdirSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const stringify = JSON.stringify.bind(JSON)
const createNull = Object.create.bind(Object)
const assign = Object.assign.bind(Object)
const digest = value => createHash('sha256').update(value).digest('hex')
const safeTool = /^[a-z][a-z0-9_-]{0,95}$/
const safeEnum = /^[A-Za-z0-9_.:-]{1,64}$/
const safeMethod = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const kinds = new Set(['tool', 'service', 'channel', 'ui'])
const skipMethods = new Set(['constructor', 'start', 'stop', 'dispose', 'init'])
const cordisOrig = Symbol.for('cordis.original')
const unwrap = v => (v && typeof v === 'object' ? v[cordisOrig] : undefined) ?? v
const badHealth = h => !h || typeof h !== 'object' || h.ready === false || h.ok === false || h.status === 'error' || h.status === 'unhealthy'
const stripComment = line => {
  let q = ''
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]
    if (q) { if (c === q && line[i - 1] !== '\\') q = '' }
    else if (c === "'" || c === '"') q = c
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}
const parseScalar = raw => {
  const s = stripComment(raw).trim()
  if (!s || s.startsWith('!!js') || s.startsWith('#')) return undefined
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null' || s === '~') return null
  if (s === '[]') return []
  if (s === '{}') return createNull(null)
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s)
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) return s.slice(1, -1)
  return s
}
const isNonEmptyDecl = raw => {
  const val = parseScalar(raw)
  if (val === undefined || val === false || val === null || val === '') return false
  if (Array.isArray(val)) return val.length > 0
  if (typeof val === 'object') return Object.keys(val).length > 0
  return true
}
function parsePatchMeta(rawYaml) {
  const inject = []
  const config = createNull(null)
  let inInject = false, injectIndent = -1, inConfig = false, configIndent = -1, configStack = []
  let hasEntry = false, hasUiDecl = false, hasChannelDecl = false, hasServiceDecl = false, pendingDecl = null
  for (const rawLine of rawYaml.split(/\r?\n/)) {
    const line = stripComment(rawLine)
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length
    const trimmed = line.trim()
    if (pendingDecl) {
      if (indent > pendingDecl.indent) {
        const kv = /^(?:-\s+)?[A-Za-z0-9_-]+\s*:\s*(.*)$/.exec(trimmed)
        if (!kv || !kv[1].trim() || isNonEmptyDecl(kv[1])) {
          if (pendingDecl.kind === 'ui') hasUiDecl = true
          else if (pendingDecl.kind === 'channel') hasChannelDecl = true
          else hasServiceDecl = true
          pendingDecl = null
        }
      } else pendingDecl = null
    }
    if (/^-+\s*insert\s*:/.test(trimmed) || /^name\s*:/.test(trimmed)) hasEntry = true
    if (inInject) {
      if (indent > injectIndent && trimmed.startsWith('- ')) {
        const val = parseScalar(trimmed.slice(2))
        if (typeof val === 'string' && val) inject.push(val)
        continue
      }
      if (indent <= injectIndent && !trimmed.startsWith('- ')) inInject = false
    }
    if (inConfig) {
      if (indent <= configIndent) { inConfig = false; configStack = [] }
      else {
        while (configStack.length > 1 && indent <= configStack[configStack.length - 1].indent) configStack.pop()
        const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(trimmed)
        if (match && match[1] !== '__proto__' && match[1] !== 'constructor' && match[1] !== 'prototype') {
          const rest = match[2].trim(), targetObj = configStack[configStack.length - 1].obj
          if (!rest) {
            const child = createNull(null)
            targetObj[match[1]] = child
            configStack.push({ obj: child, indent })
          } else {
            const val = parseScalar(rest)
            if (val !== undefined) targetObj[match[1]] = val
          }
        }
        continue
      }
    }
    const injectMatch = /^(?:-\s+)?inject\s*:\s*(.*)$/.exec(trimmed)
    if (injectMatch) {
      const rest = injectMatch[1].trim()
      if (rest.startsWith('[') && rest.endsWith(']')) {
        for (const item of rest.slice(1, -1).split(',')) {
          const val = parseScalar(item)
          if (typeof val === 'string' && val) inject.push(val)
        }
      } else if (!rest) { inInject = true; injectIndent = indent }
      continue
    }
    const configMatch = /^(?:-\s+)?config\s*:\s*(.*)$/.exec(trimmed)
    if (configMatch) {
      if (!configMatch[1].trim()) { inConfig = true; configIndent = indent; configStack = [{ obj: config, indent }] }
      continue
    }
    const declMatch = /^(?:-\s+)?(ui|routes|sections|settings|channel|services|provides)\s*:\s*(.*)$/.exec(trimmed)
    if (declMatch) {
      const key = declMatch[1], rest = declMatch[2].trim()
      const kind = key === 'channel' ? 'channel' : (key === 'services' || key === 'provides') ? 'service' : 'ui'
      if (rest) {
        if (isNonEmptyDecl(rest)) {
          if (kind === 'ui') hasUiDecl = true
          else if (kind === 'channel') hasChannelDecl = true
          else hasServiceDecl = true
        }
      } else pendingDecl = { kind, indent }
    }
  }
  return { hasEntry, inject, config, hasUiDecl, hasChannelDecl, hasServiceDecl }
}
const hasNonEmptyObj = v => Boolean(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0)
function readPackageMeta(pkgDir) {
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const dsh = manifest.dsh && typeof manifest.dsh === 'object' ? manifest.dsh : {}
  const clientExp = manifest.exports && typeof manifest.exports === 'object' ? manifest.exports['./client'] : undefined
  const clientPath = typeof clientExp === 'string' ? clientExp
    : clientExp && typeof clientExp === 'object' ? (clientExp.default ?? clientExp.import) : undefined
  let hasClientExport = false, clientExportMissing = false
  if (typeof clientPath === 'string') {
    if (/^\.\/lib\/[A-Za-z0-9._/-]+\.js$/.test(clientPath) && !clientPath.split('/').includes('..')
      && existsSync(join(pkgDir, clientPath))) hasClientExport = true
    else clientExportMissing = true
  }
  const pkg = {
    dshKind: kinds.has(dsh.kind) ? dsh.kind : undefined,
    dshClient: hasNonEmptyObj(dsh.client),
    dshUi: hasNonEmptyObj(dsh.ui),
    dshChannel: hasNonEmptyObj(dsh.channel),
    hasClientExport, clientExportMissing,
  }
  let patch = { hasEntry: false, inject: [], config: createNull(null), hasUiDecl: false, hasChannelDecl: false, hasServiceDecl: false }
  const patchPath = join(pkgDir, 'cordis.patch.yml')
  if (existsSync(patchPath)) {
    const rawPatch = readFileSync(patchPath, 'utf8')
    if (Buffer.byteLength(rawPatch) <= 65536) patch = parsePatchMeta(rawPatch)
  }
  return { pkg, patch }
}
const listMethods = val => {
  if (!val || typeof val !== 'object') return []
  const seen = new Set()
  for (let obj = val; obj && obj !== Object.prototype; obj = Object.getPrototypeOf(obj)) {
    for (const k of Object.getOwnPropertyNames(obj)) {
      if (!skipMethods.has(k) && !k.startsWith('_') && safeMethod.test(k) && safeEnum.test(k) && typeof val[k] === 'function') seen.add(k)
    }
  }
  return [...seen].slice(0, 16)
}
const checkAdapter = a => Boolean(a && typeof a === 'object' && typeof a.channel === 'string' && a.channel
  && typeof a.account === 'string' && a.account && a.capabilities && typeof a.capabilities === 'object'
  && typeof a.start === 'function' && typeof a.send === 'function')
const hasNonEmpty = (v, seen = new Set()) => {
  if (typeof v === 'function') return true
  if (!v || typeof v !== 'object' || seen.has(v)) return false
  seen.add(v)
  const ok = Array.isArray(v)
    ? v.some(x => typeof x === 'function' || (x !== undefined && x !== null && x !== false && x !== '' && (typeof x !== 'object' || hasNonEmpty(x, seen))))
    : Object.values(v).some(x => typeof x === 'function' || (x !== undefined && x !== null && x !== false && x !== '' && (typeof x !== 'object' || hasNonEmpty(x, seen))))
  seen.delete(v)
  return ok
}
const validTypertObj = v => Boolean(v && typeof v === 'object' && !Array.isArray(v)
  && typeof v.package === 'string' && v.package.trim().length > 0
  && (hasNonEmpty(v.schemas) || hasNonEmpty(v.invocations) || hasNonEmpty(v.descriptors)
    || hasNonEmpty(v.routes) || hasNonEmpty(v.sections) || hasNonEmpty(v.settings) || hasNonEmpty(v.model)))
const validUiObj = v => typeof v === 'function' || Boolean(v && typeof v === 'object' && !Array.isArray(v)
  && (hasNonEmpty(v.routes) || hasNonEmpty(v.sections) || hasNonEmpty(v.settings)
    || validTypertObj(v) || validTypertObj(v.TYPERT)
    || typeof v.render === 'function' || typeof v.mount === 'function' || typeof v.component === 'function'))
let frame
let nonce
let artifactSha256
let operationDigest
let fiber
let ctx
let disposed = true
let providedNames = []
const channelAdapters = new Set()
const typertContributions = new Set()
try {
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > 65536) throw new Error('candidate-input-too-large')
    chunks.push(chunk)
  }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!request || request.schemaVersion !== 1 || typeof request.nonce !== 'string'
    || !/^[a-f0-9]{64}$/.test(request.nonce) || typeof request.artifactSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(request.artifactSha256) || typeof request.entry !== 'string'
    || !/^package\/lib\/[A-Za-z0-9._/-]+\.js$/.test(request.entry)
    || request.entry.split('/').includes('..') || typeof request.modulesPath !== 'string'
    || !request.modulesPath.startsWith('/')
    || (request.pluginKind !== undefined && !kinds.has(request.pluginKind))
    || !request.operation || !['discover', 'invoke'].includes(request.operation.kind))
    throw new Error('candidate-input-invalid')
  nonce = request.nonce
  artifactSha256 = request.artifactSha256
  operationDigest = digest(stringify(request.operation))
  const pkgDir = join(process.cwd(), 'package')
  const { pkg, patch } = readPackageMeta(pkgDir)
  const resolver = createRequire(pathToFileURL(join(request.modulesPath, '__native_resolver__.cjs')))
  const approved = new Map()
  for (const entry of readdirSync(request.modulesPath)) {
    if (entry.startsWith('.')) continue
    const names = entry.startsWith('@')
      ? readdirSync(join(request.modulesPath, entry)).map(name => entry + '/' + name) : [entry]
    for (const name of names) {
      try { approved.set(name, resolver.resolve(name)) } catch { /* package has no runtime entry */ }
    }
  }
  const candidateRoot = pathToFileURL(pkgDir + '/').href
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(candidateRoot)
      && !specifier.startsWith('node:') && !specifier.startsWith('.')
      && !specifier.startsWith('/') && !specifier.startsWith('file:')) {
      const target = approved.get(specifier)
      if (!target) throw new Error('candidate-bare-import-not-approved')
      return nextResolve(pathToFileURL(target).href, context)
    }
    return nextResolve(specifier, context)
  } })
  const { Context, Service } = await import(pathToFileURL(approved.get('@deepseek-ai/cordis')).href)
  class TypertSeam extends Service {
    constructor(c) { super(c, 'typert') }
    register(contribution) {
      if (!validTypertObj(contribution)) throw new Error('invalid-ui-contribution')
      return this.ctx.effect(() => {
        typertContributions.add(contribution)
        return () => { typertContributions.delete(contribution) }
      }, 'typert.register()')
    }
  }
  const { default: SystemPrompt } = await import(pathToFileURL(approved.get('@deepseek-ai/dsh-system-prompt')).href)
  const { default: ToolRuntime, projectToolSchema } = await import(pathToFileURL(approved.get('@deepseek-ai/dsh-tools')).href)
  const { ToolExecutionPipeline, executeToolBatch } = await import(pathToFileURL(resolver.resolve('@deepseek-ai/dsh-tools/pipeline')).href)
  ctx = new Context()
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  const pipeline = new ToolExecutionPipeline(ctx)
  ctx.tools.setExecutor({
    describe: tools => ({ schemas: tools.map(definition => projectToolSchema(definition, false)) }),
    execute: input => executeToolBatch(input, pipeline, () => 1),
  })
  const module = await import(pathToFileURL(join(process.cwd(), request.entry)).href)
  const target = module.default ?? module
  const declaredInject = [...new Set([
    ...(Array.isArray(target?.inject) ? target.inject : []),
    ...(Array.isArray(module?.inject) ? module.inject : []),
    ...(Array.isArray(patch.inject) ? patch.inject : []),
  ].filter(v => typeof v === 'string'))]
  if (request.pluginKind === 'channel' || declaredInject.includes('assistantDelivery') || pkg.dshChannel || patch.hasChannelDecl) {
    ctx.provide('assistantDelivery', {
      registerAdapter(adapter) {
        if (!checkAdapter(adapter)) throw new Error('invalid-channel-adapter')
        channelAdapters.add(adapter)
        return async () => { channelAdapters.delete(adapter) }
      },
      health: () => ({ ready: true }),
    })
  }
  if (request.pluginKind === 'ui' || declaredInject.includes('typert') || pkg.dshClient || pkg.dshUi || patch.hasUiDecl) {
    new TypertSeam(ctx)
  }
  const hasPatchCfg = patch.config && Object.keys(patch.config).length > 0
  const pluginCfg = hasPatchCfg ? patch.config : (typeof target?.Config === 'function' || typeof module?.Config === 'function' ? {} : undefined)
  fiber = pluginCfg !== undefined ? ctx.plugin(target, pluginCfg) : ctx.plugin(target)
  let timer
  try {
    await Promise.race([fiber, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('plugin-activation-timeout')), 5000)
    })])
  } finally { clearTimeout(timer) }
  await new Promise(resolve => setImmediate(resolve))
  if (fiber.state !== 2) throw new Error('plugin-fiber-not-active')
  const toolSchemas = (await ctx.systemPrompt.assemble({})).tools ?? []
  const provisions = [...(fiber.provisions ?? [])]
  const uiExports = Boolean(validTypertObj(module.TYPERT) || validTypertObj(module.TYPERT_REMOTE)
    || hasNonEmpty(module.routes) || hasNonEmpty(module.sections) || hasNonEmpty(module.settings) || validUiObj(module.ui)
    || (target && typeof target === 'object' && (validTypertObj(target.TYPERT) || validTypertObj(target.TYPERT_REMOTE)
      || hasNonEmpty(target.routes) || hasNonEmpty(target.sections) || hasNonEmpty(target.settings) || validUiObj(target.ui))))
  const channelExports = Boolean(module.adapter || module.channel || (target && typeof target === 'object' && (target.adapter || target.channel)))
  const channelProvisions = provisions.filter(p => checkAdapter(p.value))
  const isChannelProvision = channelProvisions.length > 0
  let effectiveKind = request.pluginKind
  if (!effectiveKind) {
    if (Array.isArray(toolSchemas) && toolSchemas.length >= 1) effectiveKind = 'tool'
    else if (typertContributions.size > 0 || pkg.hasClientExport || pkg.clientExportMissing || uiExports) effectiveKind = 'ui'
    else if (channelAdapters.size > 0 || pkg.dshChannel || patch.hasChannelDecl || declaredInject.includes('assistantDelivery') || channelExports || isChannelProvision) effectiveKind = 'channel'
    else if (provisions.length > 0 || pkg.dshKind === 'service' || patch.hasServiceDecl || (typeof (target?.apply ?? target) === 'function' && ((fiber._disposables?.length ?? 0) > 0 || patch.hasEntry))) effectiveKind = 'service'
    else throw new Error('invalid-tool-schemas')
  }
  providedNames = provisions.map(p => p.name)
  let schemas = []
  const toolNames = new Set()
  for (const s of Array.isArray(toolSchemas) ? toolSchemas : []) {
    if (!s || !safeTool.test(s.name) || toolNames.has(s.name)) throw new Error('invalid-tool-schemas')
    toolNames.add(s.name)
  }
  let invokeNonTool
  if (effectiveKind === 'tool') {
    if (!Array.isArray(toolSchemas) || toolSchemas.length < 1 || toolSchemas.length > 64) throw new Error('invalid-tool-schemas')
    schemas = toolSchemas
  } else if (effectiveKind === 'service') {
    if (provisions.length < 1 && !((fiber._disposables?.length ?? 0) >= 1 && typeof (target?.apply ?? target) === 'function')) throw new Error('invalid-service-plugin')
    const svcMap = new Map(), svcMethods = new Map(), allMethods = new Set()
    for (const p of provisions) {
      if (unwrap(ctx.get(p.name)) !== p.value || (typeof p.check === 'function' && p.check() === false)) throw new Error('service-provision-invalid')
      if (typeof p.value?.health === 'function' && badHealth(await p.value.health())) throw new Error('service-health-failed')
      svcMap.set(p.name, p)
      if (safeEnum.test(p.name)) {
        const ms = listMethods(p.value)
        if (ms.length > 0) { svcMethods.set(p.name, new Set(ms)); for (const m of ms) allMethods.add(m) }
      }
    }
    schemas.push({ name: 'service_lifecycle_probe', parameters: { type: 'object', properties: {
      check: { type: 'string', enum: ['status', 'health', 'provisions'] }, service: { type: 'string' },
    }, additionalProperties: false } })
    const svcNames = [...svcMethods.keys()].slice(0, 16), mNames = [...allMethods].slice(0, 16)
    if (svcNames.length > 0 && mNames.length > 0) {
      schemas.push({ name: 'service_method_probe', parameters: { type: 'object', properties: {
        service: { type: 'string', enum: svcNames }, method: { type: 'string', enum: mNames }, input: { type: 'object', additionalProperties: true },
      }, required: ['service', 'method'], additionalProperties: false } })
    }
    for (const s of toolSchemas) if (schemas.length < 64 && !schemas.some(x => x.name === s.name)) schemas.push(s)
    invokeNonTool = async call => {
      if (call.toolName === 'service_lifecycle_probe') {
        const filter = typeof call.arguments?.service === 'string' ? call.arguments.service : undefined
        if (filter && !svcMap.has(filter)) throw new Error('unknown-service')
        const health = []
        for (const [n, p] of svcMap) {
          if (filter && n !== filter) continue
          if (unwrap(ctx.get(n)) !== p.value || (typeof p.check === 'function' && p.check() === false)) throw new Error('service-provision-invalid')
          const h = typeof p.value?.health === 'function' ? await p.value.health() : { ready: true }
          if (badHealth(h)) throw new Error('service-health-failed')
          health.push({ service: n, health: h })
        }
        const value = { kind: 'service', active: fiber.state === 2, provisions: providedNames, disposables: fiber._disposables?.length ?? 0, health }
        return { isError: false, value, content: [{ type: 'text', text: stringify(value) }] }
      }
      if (call.toolName === 'service_method_probe') {
        const s = call.arguments?.service, m = call.arguments?.method
        if (typeof s !== 'string' || typeof m !== 'string' || !svcMethods.get(s)?.has(m)) throw new Error('invalid-service-method')
        const res = await svcMap.get(s).value[m](call.arguments?.input)
        const value = { kind: 'service', service: s, method: m, result: res ?? null }
        return { isError: false, value, content: [{ type: 'text', text: stringify(value) }] }
      }
      return undefined
    }
  } else if (effectiveKind === 'channel') {
    const exported = [module.adapter, module.channel, target?.adapter, target?.channel].filter(Boolean)
    if (channelAdapters.size < 1 && channelProvisions.length < 1 && exported.length < 1) throw new Error('invalid-channel-plugin')
    for (const a of [...channelAdapters, ...channelProvisions.map(p => p.value), ...exported]) if (!checkAdapter(a)) throw new Error('invalid-channel-plugin')
    for (const p of provisions) if (typeof p.value?.health === 'function' && badHealth(await p.value.health())) throw new Error('channel-unhealthy')
    schemas.push({ name: 'channel_readiness_probe', parameters: { type: 'object', properties: {
      check: { type: 'string', enum: ['adapters', 'capabilities', 'health'] }, channel: { type: 'string' },
    }, additionalProperties: false } })
    for (const s of toolSchemas) if (schemas.length < 64 && !schemas.some(x => x.name === s.name)) schemas.push(s)
    invokeNonTool = async call => {
      if (call.toolName !== 'channel_readiness_probe') return undefined
      const ch = typeof call.arguments?.channel === 'string' ? call.arguments.channel : undefined
      const adapters = [...channelAdapters, ...channelProvisions.map(p => p.value), ...exported].filter(a => !ch || a.channel === ch).map(a => ({ channel: a.channel, account: a.account, capabilities: a.capabilities }))
      if (ch && adapters.length === 0) throw new Error('unknown-channel')
      const services = []
      for (const p of provisions) if (typeof p.value?.health === 'function') {
        const h = await p.value.health()
        if (badHealth(h)) throw new Error('channel-unhealthy')
        services.push({ service: p.name, health: h })
      }
      const value = { kind: 'channel', ready: true, adapters, services }
      return { isError: false, value, content: [{ type: 'text', text: stringify(value) }] }
    }
  } else {
    if (pkg.clientExportMissing) throw new Error('invalid-ui-plugin')
    if (typertContributions.size < 1 && !uiExports && !pkg.hasClientExport) throw new Error('invalid-ui-plugin')
    schemas.push({ name: 'ui_declaration_probe', parameters: { type: 'object', properties: {
      check: { type: 'string', enum: ['contributions', 'routes', 'settings'] }, section: { type: 'string' },
    }, additionalProperties: false } })
    for (const s of toolSchemas) if (schemas.length < 64 && !schemas.some(x => x.name === s.name)) schemas.push(s)
    invokeNonTool = async call => {
      if (call.toolName !== 'ui_declaration_probe') return undefined
      const contribs = [...typertContributions].map(c => ({ package: c.package, face: c.face ?? null, schemas: Object.keys(c.schemas ?? {}), invocations: Object.keys(c.invocations ?? {}).length }))
      const value = { kind: 'ui', ready: true, contributions: contribs, hasClientExport: Boolean(pkg.hasClientExport),
        routes: hasNonEmpty(module.routes) ? module.routes : hasNonEmpty(target?.routes) ? target.routes : [],
        sections: hasNonEmpty(module.sections) ? module.sections : hasNonEmpty(target?.sections) ? target.sections : [],
        settings: hasNonEmpty(module.settings) ? module.settings : hasNonEmpty(target?.settings) ? target.settings : [] }
      return { isError: false, value, content: [{ type: 'text', text: stringify(value) }] }
    }
  }
  const schemaDigest = digest(stringify(schemas))
  if (request.operation.kind === 'invoke' && request.operation.schemaDigest !== schemaDigest)
    throw new Error('schema-digest-changed')
  const emitKind = request.pluginKind !== undefined || effectiveKind !== 'tool'
  const kindOut = emitKind ? { pluginKind: effectiveKind } : {}
  if (request.operation.kind === 'discover') frame = { status: 'result', schemaDigest, ...kindOut, schemas }
  else {
    const calls = []
    const probeNames = new Set(schemas.map(s => s.name))
    for (const call of request.operation.calls) {
      if (!probeNames.has(call.toolName)) throw new Error('unknown-invoked-tool')
      if (effectiveKind !== 'tool' && !toolNames.has(call.toolName)) {
        const res = await invokeNonTool(call)
        calls.push({ id: call.id, toolName: call.toolName, result: res })
      } else {
        const batch = await ctx.tools.execute({
          calls: [{ type: 'tool-call', id: call.id, name: call.toolName, arguments: stringify(call.arguments) }],
          signal: new AbortController().signal,
        })
        if (!batch || !Array.isArray(batch.results) || batch.results.length !== 1 || !batch.results[0]?.result)
          throw new Error('tool-batch-invalid')
        calls.push({ id: call.id, toolName: call.toolName, result: batch.results[0].result })
      }
    }
    frame = { status: 'result', schemaDigest, ...kindOut, calls }
  }
} catch (error) {
  frame = { status: 'unknown', reason: error instanceof Error ? error.message.slice(0, 128) : 'candidate-error' }
} finally {
  try { if (fiber) await fiber.dispose() } catch { disposed = false }
  if (disposed) {
    if (channelAdapters.size > 0 || typertContributions.size > 0) disposed = false
    for (const svcName of providedNames) if (ctx?.get(svcName) !== undefined) disposed = false
  }
  try { if (ctx) await ctx.fiber.dispose() } catch { disposed = false }
}
if (!disposed) frame = { status: 'unknown', reason: 'plugin-disposal-unconfirmed' }
try {
  const output = stringify(assign(createNull(null), { wireVersion: 1, nonce, artifactSha256, operationDigest }, frame))
  if (Buffer.byteLength(output) > 60000) throw new Error('candidate-output-too-large')
  writeSync(1, output + '\n')
} catch { process.exitCode = 1 }
`
