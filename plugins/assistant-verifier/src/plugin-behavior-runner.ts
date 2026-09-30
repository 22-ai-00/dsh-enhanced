import { createHash } from 'node:crypto'
import { IsolatedVerifierRunner, type IsolatedVerifierRunnerConfig } from '@dsh-enhanced/assistant-isolation'

const MAX_PACK_BYTES = 512 * 1024
const MAX_OPERATION_BYTES = 64 * 1024
const MAX_WORKER_OUTPUT_BYTES = 64 * 1024
const SHA256 = /^[a-f0-9]{64}$/u
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/u
const SAFE_TOOL = /^[a-z][a-z0-9_-]{0,95}$/u
const COMMAND = 'exec /usr/local/bin/node /opt/dsh-plugin-verifier/worker.mjs'

export type PluginBehaviorOperation =
  | { readonly kind: 'discover' }
  | { readonly kind: 'invoke'; readonly schemaDigest: string; readonly calls: readonly {
    readonly id: string; readonly toolName: string; readonly arguments: unknown
  }[] }

export interface PluginBehaviorObservation {
  readonly status: 'observed' | 'unknown'
  readonly quiescent: boolean
  readonly jobId?: string
  readonly artifactSha256: string
  readonly reason?: string
  readonly environment?: Readonly<{ node: string; cordis: string; tools: string; systemPrompt: string }>
  readonly schemaDigest?: string
  readonly schemas?: readonly unknown[]
  readonly calls?: readonly { readonly id: string; readonly toolName: string; readonly result: unknown }[]
}

export interface PluginBehaviorRunnerInput {
  readonly key: string
  readonly artifact: Buffer
  readonly operation: PluginBehaviorOperation
  readonly signal: AbortSignal
}

function canonicalJson(value: unknown): string | undefined {
  try {
    if (!deepJson(value)) return undefined
    const serialized = JSON.stringify(value)
    return serialized === undefined ? undefined : serialized
  } catch { return undefined }
}

function deepJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) {
    const valid = value.every(item => deepJson(item, seen))
    seen.delete(value)
    return valid
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return false
  const valid = Object.keys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value') && deepJson(descriptor.value, seen)
  })
  seen.delete(value)
  return valid
}

function validOperation(value: unknown): value is PluginBehaviorOperation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const operation = value as Record<string, unknown>
  if (operation.kind === 'discover') return Object.keys(operation).length === 1
  if (operation.kind !== 'invoke' || typeof operation.schemaDigest !== 'string' || !SHA256.test(operation.schemaDigest)
    || !Array.isArray(operation.calls) || operation.calls.length < 1 || operation.calls.length > 8
    || Object.keys(operation).length !== 3) return false
  const ids = new Set<string>()
  for (const call of operation.calls) {
    if (!call || typeof call !== 'object' || Object.keys(call).length !== 3
      || !SAFE_ID.test(call.id) || !SAFE_TOOL.test(call.toolName) || ids.has(call.id) || !deepJson(call.arguments)) return false
    ids.add(call.id)
  }
  return true
}

function validObservation(value: unknown, operation: PluginBehaviorOperation, sha256: string): value is PluginBehaviorObservation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1 || record.status !== 'observed' || record.artifactSha256 !== sha256
    || record.quiescent !== true || !SHA256.test(record.schemaDigest as string)
    || !record.environment || typeof record.environment !== 'object') return false
  const environment = record.environment as Record<string, unknown>
  if (['node', 'cordis', 'tools', 'systemPrompt'].some(key => typeof environment[key] !== 'string'
    || (environment[key] as string).length > 80)) return false
  if (operation.kind === 'discover') {
    if (!Array.isArray(record.schemas) || record.schemas.length < 1 || record.schemas.length > 64 || record.calls !== undefined) return false
    if (createHash('sha256').update(JSON.stringify(record.schemas)).digest('hex') !== record.schemaDigest) return false
    const names = new Set<string>()
    for (const schema of record.schemas) {
      if (!schema || typeof schema !== 'object' || !SAFE_TOOL.test((schema as { name?: string }).name ?? '')
        || names.has((schema as { name: string }).name)) return false
      names.add((schema as { name: string }).name)
    }
  } else if (!Array.isArray(record.calls) || record.calls.length !== operation.calls.length
    || record.schemaDigest !== operation.schemaDigest || record.schemas !== undefined
    || record.calls.some((call, index) => !call || typeof call !== 'object'
      || (call as { id?: string }).id !== operation.calls[index]!.id
      || (call as { toolName?: string }).toolName !== operation.calls[index]!.toolName
      || !Object.hasOwn(call, 'result'))) return false
  return true
}

/** Host-only behavior observation. The candidate and worker receive no oracle or promotion authority. */
export class PluginBehaviorRunner {
  readonly #runner: IsolatedVerifierRunner
  constructor(input: Omit<IsolatedVerifierRunnerConfig, 'command'>) {
    if (input.maxOutputBytes < MAX_WORKER_OUTPUT_BYTES) throw new Error('plugin behavior output budget must be at least 64 KiB')
    this.#runner = new IsolatedVerifierRunner({ ...input, command: COMMAND })
  }
  async run(input: PluginBehaviorRunnerInput): Promise<PluginBehaviorObservation> {
    const artifactSha256 = Buffer.isBuffer(input.artifact)
      ? createHash('sha256').update(input.artifact).digest('hex') : ''
    const unknown = (reason: string, quiescent = false, jobId?: string): PluginBehaviorObservation =>
      ({ status: 'unknown', quiescent, artifactSha256, reason, ...(jobId ? { jobId } : {}) })
    if (!Buffer.isBuffer(input.artifact) || input.artifact.length < 1 || input.artifact.length > MAX_PACK_BYTES)
      return unknown('plugin-artifact-out-of-bound', true)
    try { if (!validOperation(input.operation)) return unknown('plugin-operation-invalid', true) }
    catch { return unknown('plugin-operation-invalid', true) }
    const request = { schemaVersion: 1, sha256: artifactSha256, sizeBytes: input.artifact.length, operation: input.operation }
    const stdin = canonicalJson(request)
    if (stdin === undefined || Buffer.byteLength(stdin) > MAX_OPERATION_BYTES) return unknown('plugin-operation-out-of-bound', true)
    let isolated
    try { isolated = await this.#runner.run(input.key, input.artifact.toString('base64'), stdin, input.signal) }
    catch { return unknown('plugin-runner-unavailable') }
    if (isolated.status !== 'succeeded' || isolated.quiescent !== true || isolated.exitCode !== 0)
      return unknown(isolated.reason ?? 'plugin-runner-unsettled', isolated.quiescent, isolated.jobId)
    if (Buffer.byteLength(isolated.stdout) > MAX_WORKER_OUTPUT_BYTES || !isolated.stdout.endsWith('\n')
      || isolated.stdout.indexOf('\n') !== isolated.stdout.length - 1) return unknown('plugin-worker-output-invalid', true, isolated.jobId)
    try {
      const value: unknown = JSON.parse(isolated.stdout.slice(0, -1))
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>
        if (record.schemaVersion === 1 && record.status === 'unknown'
          && typeof record.reason === 'string' && record.reason.length > 0 && record.reason.length <= 128
          && Object.keys(record).length === 3) return unknown(record.reason, true, isolated.jobId)
      }
      if (!validObservation(value, input.operation, artifactSha256)) return unknown('plugin-worker-observation-invalid', true, isolated.jobId)
      const observation = value as PluginBehaviorObservation
      return { ...observation, jobId: isolated.jobId }
    } catch { return unknown('plugin-worker-output-invalid', true, isolated.jobId) }
  }
  close(): Promise<void> { return this.#runner.close() }
}

/* DSH_PLUGIN_VERIFIER_WORKER_START
// Copied verbatim into the manifest-only image by build-plugin-verifier-image.mjs.
// This code executes inside the isolation worker, never in the Host process.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

const limit = 512 * 1024
const safeId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/
const safeTool = /^[a-z][a-z0-9_-]{0,95}$/
const shaPattern = /^[a-f0-9]{64}$/
const fail = reason => { throw new Error(reason) }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const text = bytes => {
  const end = bytes.indexOf(0)
  const sliced = end < 0 ? bytes : bytes.subarray(0, end)
  const value = sliced.toString('utf8')
  if (!Buffer.from(value, 'utf8').equals(sliced)) fail('invalid-utf8-tar')
  return value
}
const octal = bytes => {
  const raw = text(bytes).trim()
  if (!/^[0-7]+$/.test(raw)) fail('invalid-tar-number')
  const value = Number.parseInt(raw, 8)
  if (!Number.isSafeInteger(value)) fail('invalid-tar-number')
  return value
}
const parsePax = bytes => {
  const values = {}
  for (let at = 0; at < bytes.length;) {
    const space = bytes.indexOf(32, at)
    if (space < 0) fail('invalid-pax')
    const size = Number(bytes.subarray(at, space).toString('ascii'))
    if (!Number.isSafeInteger(size) || size <= space - at + 2 || at + size > bytes.length || bytes[at + size - 1] !== 10) fail('invalid-pax')
    const line = bytes.subarray(space + 1, at + size - 1).toString('utf8')
    const equal = line.indexOf('=')
    if (equal < 1 || Object.hasOwn(values, line.slice(0, equal))) fail('invalid-pax')
    values[line.slice(0, equal)] = line.slice(equal + 1)
    at += size
  }
  return values
}
function extract(bytes) {
  let tar
  try { tar = gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 }) }
  catch { fail('invalid-or-oversized-tgz') }
  const destination = '/workspace/plugin'
  mkdirSync(destination, { mode: 0o700 })
  let at = 0, extension = {}, global = {}, count = 0
  const seen = new Set()
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512)
    if (header.every(byte => byte === 0)) break
    const expectedChecksum = octal(header.subarray(148, 156))
    let checksum = 0
    for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 32 : header[index]
    if (expectedChecksum !== checksum) fail('invalid-tar-checksum')
    const size = octal(header.subarray(124, 136))
    const end = at + 512 + size
    if (!Number.isSafeInteger(end) || end > tar.length || ++count > 256) fail('invalid-tar-member')
    const kind = String.fromCharCode(header[156] || 48)
    if (kind === 'g' || kind === 'x') {
      if (size > 1_048_576) fail('oversized-tar-extension')
      const parsed = parsePax(tar.subarray(at + 512, end))
      if (kind === 'g') global = { ...global, ...parsed }
      else extension = parsed
    } else {
      const attributes = { ...global, ...extension }
      if (Object.keys(attributes).some(key => !['path', 'mtime', 'atime', 'ctime', 'comment', 'uid', 'gid', 'uname', 'gname', 'mode'].includes(key))) fail('unsupported-tar-extension')
      const prefix = text(header.subarray(345, 500))
      const rawName = prefix ? prefix + '/' + text(header.subarray(0, 100)) : text(header.subarray(0, 100))
      const raw = attributes.path ?? rawName
      const name = typeof raw === 'string' && raw.endsWith('/') ? raw.slice(0, -1) : raw
      if (typeof name !== 'string' || name.length > 256
        || name !== 'package' && (!name.startsWith('package/')
          || name.slice(8).split('/').some(part => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._-]+$/.test(part)))) fail('unsafe-tar-path')
      if (seen.has(name) || (kind !== '0' && kind !== '5' && kind !== '7')
        || name === 'package' && kind !== '5') fail('duplicate-or-unsafe-tar-entry')
      seen.add(name)
      const target = join(destination, name)
      if (resolve(target) !== target || target !== join(destination, 'package') && !target.startsWith(destination + '/')) fail('unsafe-tar-path')
      if (kind === '5') mkdirSync(target, { recursive: true, mode: 0o700 })
      else {
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
        writeFileSync(target, tar.subarray(at + 512, end), { flag: 'wx', mode: 0o600 })
      }
      extension = {}
    }
    at = end + (512 - size % 512) % 512
  }
  if (at + 1024 > tar.length || !tar.subarray(at).every(byte => byte === 0)) fail('invalid-tar-trailer')
  if (!seen.has('package/package.json')) fail('missing-package-manifest')
  const manifest = JSON.parse(readFileSync(join(destination, 'package/package.json'), 'utf8'))
  if (!manifest || typeof manifest !== 'object' || typeof manifest.main !== 'string'
    || !/^\.\/lib\/[A-Za-z0-9._/-]+\.js$/.test(manifest.main)
    || manifest.main.split('/').includes('..')) fail('invalid-package-entry')
  const entry = join(destination, 'package', manifest.main)
  if (!existsSync(entry)) fail('missing-package-entry')
  symlinkSync('/opt/dsh-plugin-verifier/node_modules', join(destination, 'package/node_modules'))
  return entry
}
function validOperation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (value.kind === 'discover') return Object.keys(value).length === 1
  if (value.kind !== 'invoke' || Object.keys(value).length !== 3 || !shaPattern.test(value.schemaDigest)
    || !Array.isArray(value.calls) || value.calls.length < 1 || value.calls.length > 8) return false
  const ids = new Set()
  for (const call of value.calls) {
    if (!call || typeof call !== 'object' || Object.keys(call).length !== 3
      || !safeId.test(call.id) || !safeTool.test(call.toolName) || ids.has(call.id)) return false
    ids.add(call.id)
  }
  return true
}
function version(name) {
  return JSON.parse(readFileSync('/opt/dsh-plugin-verifier/node_modules/' + name + '/package.json', 'utf8')).version
}
let result
let fiber
let ctx
let quiescent = true
try {
  const encoded = readFileSync('/workspace/artifact', 'utf8')
  const request = JSON.parse(readFileSync('/workspace/input', 'utf8'))
  if (!request || request.schemaVersion !== 1 || !shaPattern.test(request.sha256)
    || !Number.isSafeInteger(request.sizeBytes) || request.sizeBytes < 1 || request.sizeBytes > limit
    || !validOperation(request.operation) || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) fail('invalid-worker-input')
  const packed = Buffer.from(encoded, 'base64')
  if (packed.length !== request.sizeBytes || packed.toString('base64') !== encoded || digest(packed) !== request.sha256) fail('artifact-mismatch')
  const entry = extract(packed)
  ctx = new Context()
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  const mod = await import(pathToFileURL(entry).href)
  fiber = ctx.plugin(mod.default ?? mod)
  let activationTimer
  try {
    await Promise.race([fiber, new Promise((_, reject) => {
      activationTimer = setTimeout(() => reject(new Error('plugin-activation-timeout')), 5000)
    })])
  } finally { clearTimeout(activationTimer) }
  if (fiber.state !== 2) fail('plugin-fiber-not-active')
  const assembly = await ctx.systemPrompt.assemble({})
  const schemas = assembly.tools
  if (!Array.isArray(schemas) || schemas.length < 1 || schemas.length > 64) fail('invalid-tool-schemas')
  const names = new Set()
  for (const schema of schemas) {
    if (!schema || !safeTool.test(schema.name) || names.has(schema.name)) fail('invalid-tool-schemas')
    names.add(schema.name)
  }
  const schemaDigest = digest(Buffer.from(JSON.stringify(schemas)))
  const base = { schemaVersion: 1, status: 'observed', artifactSha256: request.sha256,
    quiescent: true, environment: { node: process.version, cordis: version('@deepseek-ai/cordis'),
      tools: version('@deepseek-ai/dsh-tools'), systemPrompt: version('@deepseek-ai/dsh-system-prompt') }, schemaDigest }
  if (request.operation.kind === 'discover') result = { ...base, schemas }
  else {
    if (request.operation.schemaDigest !== schemaDigest) fail('schema-digest-changed')
    const calls = []
    for (const call of request.operation.calls) {
      if (!names.has(call.toolName)) fail('unknown-invoked-tool')
      const observed = await ctx.tools.execute({ callId: call.id, name: call.toolName, arguments: call.arguments, signal: new AbortController().signal })
      calls.push({ id: call.id, toolName: call.toolName, result: observed })
    }
    result = { ...base, calls }
  }
} catch (error) {
  result = { schemaVersion: 1, status: 'unknown', reason: error instanceof Error ? error.message.slice(0, 128) : 'worker-error' }
} finally {
  try { if (fiber) await fiber.dispose() } catch { quiescent = false }
  try { if (ctx) await ctx.fiber.dispose() } catch { quiescent = false }
}
if (!quiescent) result = { schemaVersion: 1, status: 'unknown', reason: 'plugin-disposal-unconfirmed' }
const output = JSON.stringify(result)
if (Buffer.byteLength(output) > 60 * 1024) process.stdout.write('{"schemaVersion":1,"status":"unknown","reason":"worker-output-too-large"}\n')
else process.stdout.write(output + '\n')
DSH_PLUGIN_VERIFIER_WORKER_END */
