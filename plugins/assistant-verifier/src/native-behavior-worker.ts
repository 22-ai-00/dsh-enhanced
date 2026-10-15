/** Fixed source passed to the native Seatbelt runner. Candidate files are staged read-only by the trusted runner. */
export const NATIVE_BEHAVIOR_SOURCE = String.raw`
import { createHash } from 'node:crypto'
import { createRequire, registerHooks } from 'node:module'
import { readdirSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const stringify = JSON.stringify.bind(JSON)
const createNull = Object.create.bind(Object)
const assign = Object.assign.bind(Object)
const digest = value => createHash('sha256').update(value).digest('hex')
const safeTool = /^[a-z][a-z0-9_-]{0,95}$/
let frame
let nonce
let artifactSha256
let operationDigest
let fiber
let ctx
let disposed = true
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
    || !request.modulesPath.startsWith('/') || !request.operation || !['discover', 'invoke'].includes(request.operation.kind))
    throw new Error('candidate-input-invalid')
  nonce = request.nonce
  artifactSha256 = request.artifactSha256
  operationDigest = digest(stringify(request.operation))
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
  const candidateRoot = pathToFileURL(join(process.cwd(), 'package') + '/').href
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
  const { Context } = await import(pathToFileURL(approved.get('@deepseek-ai/cordis')).href)
  const { default: SystemPrompt } = await import(pathToFileURL(approved.get('@deepseek-ai/dsh-system-prompt')).href)
  const { default: ToolRuntime } = await import(pathToFileURL(approved.get('@deepseek-ai/dsh-tools')).href)
  ctx = new Context()
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  const module = await import(pathToFileURL(join(process.cwd(), request.entry)).href)
  fiber = ctx.plugin(module.default ?? module)
  let timer
  try {
    await Promise.race([fiber, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('plugin-activation-timeout')), 5000)
    })])
  } finally { clearTimeout(timer) }
  if (fiber.state !== 2) throw new Error('plugin-fiber-not-active')
  const schemas = (await ctx.systemPrompt.assemble({})).tools
  if (!Array.isArray(schemas) || schemas.length < 1 || schemas.length > 64) throw new Error('invalid-tool-schemas')
  const names = new Set()
  for (const schema of schemas) {
    if (!schema || !safeTool.test(schema.name) || names.has(schema.name)) throw new Error('invalid-tool-schemas')
    names.add(schema.name)
  }
  const schemaDigest = digest(stringify(schemas))
  if (request.operation.kind === 'invoke' && request.operation.schemaDigest !== schemaDigest)
    throw new Error('schema-digest-changed')
  if (request.operation.kind === 'discover') frame = { status: 'result', schemaDigest, schemas }
  else {
    const calls = []
    for (const call of request.operation.calls) {
      if (!names.has(call.toolName)) throw new Error('unknown-invoked-tool')
      const result = await ctx.tools.execute({ callId: call.id, name: call.toolName,
        arguments: call.arguments, signal: new AbortController().signal })
      calls.push({ id: call.id, toolName: call.toolName, result })
    }
    frame = { status: 'result', schemaDigest, calls }
  }
} catch (error) {
  frame = { status: 'unknown', reason: error instanceof Error ? error.message.slice(0, 128) : 'candidate-error' }
} finally {
  try { if (fiber) await fiber.dispose() } catch { disposed = false }
  try { if (ctx) await ctx.fiber.dispose() } catch { disposed = false }
}
if (!disposed) frame = { status: 'unknown', reason: 'plugin-disposal-unconfirmed' }
try {
  const output = stringify(assign(createNull(null), { wireVersion: 1, nonce, artifactSha256, operationDigest }, frame))
  if (Buffer.byteLength(output) > 60000) throw new Error('candidate-output-too-large')
  writeSync(1, output + '\n')
} catch { process.exitCode = 1 }
`
