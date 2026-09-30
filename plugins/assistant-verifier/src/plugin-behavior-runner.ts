import { createHash } from 'node:crypto'
import { IsolatedVerifierRunner, type IsolatedVerifierRunnerConfig } from '@dsh-enhanced/assistant-isolation'

const MAX_PACK_BYTES = 512 * 1024
const MAX_OPERATION_BYTES = 64 * 1024
const MAX_WORKER_OUTPUT_BYTES = 64 * 1024
const SHA256 = /^[a-f0-9]{64}$/u
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/u
const SAFE_TOOL = /^[a-z][a-z0-9_-]{0,95}$/u
const COMMAND = 'exec /usr/bin/env LD_PRELOAD=/opt/dsh-plugin-verifier/parent-protect.so /usr/local/bin/node --disable-sigusr1 /opt/dsh-plugin-verifier/worker.mjs'
const BOUNDARY = 'process-seccomp-v1'

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
  if (record.schemaVersion !== 2 || record.boundary !== BOUNDARY || record.status !== 'observed' || record.artifactSha256 !== sha256
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
        if (record.schemaVersion === 2 && record.boundary === BOUNDARY && record.status === 'unknown'
          && typeof record.reason === 'string' && record.reason.length > 0 && record.reason.length <= 128
          && Object.keys(record).length === 4) return unknown(record.reason, true, isolated.jobId)
      }
      if (!validObservation(value, input.operation, artifactSha256)) return unknown('plugin-worker-observation-invalid', true, isolated.jobId)
      const observation = value as PluginBehaviorObservation
      return { status: 'observed', quiescent: true, artifactSha256, jobId: isolated.jobId,
        environment: observation.environment!, schemaDigest: observation.schemaDigest!,
        ...(input.operation.kind === 'discover' ? { schemas: observation.schemas! } : { calls: observation.calls! }) }
    } catch { return unknown('plugin-worker-output-invalid', true, isolated.jobId) }
  }
  close(): Promise<void> { return this.#runner.close() }
}

/* DSH_PLUGIN_VERIFIER_WORKER_START
// Copied verbatim into the manifest-only image by build-plugin-verifier-image.mjs.
// This code executes inside the isolation worker, never in the Host process.
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

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
const unknown = reason => ({ schemaVersion: 2, boundary: 'process-seccomp-v1', status: 'unknown', reason })
const decoded = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes)
function validChild(value, operation) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.wireVersion !== 1) return false
  if (value.status === 'unknown') return Object.keys(value).length === 3
    && typeof value.reason === 'string' && value.reason.length > 0 && value.reason.length <= 128
  if (value.status !== 'result' || !Array.isArray(value.schemas) || value.schemas.length < 1
    || value.schemas.length > 64 || Object.keys(value).length !== (operation.kind === 'discover' ? 3 : 4)) return false
  const names = new Set()
  for (const schema of value.schemas) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)
      || !safeTool.test(schema.name) || names.has(schema.name)) return false
    names.add(schema.name)
  }
  if (operation.kind === 'discover') return value.calls === undefined
  if (!Array.isArray(value.calls) || value.calls.length !== operation.calls.length) return false
  for (let index = 0; index < value.calls.length; index += 1) {
    const call = value.calls[index], requested = operation.calls[index]
    if (!call || typeof call !== 'object' || Array.isArray(call) || Object.keys(call).length !== 3
      || call.id !== requested.id || call.toolName !== requested.toolName || !names.has(call.toolName)
      || !Object.hasOwn(call, 'result')) return false
  }
  return true
}
function observeChild(entry, operation) {
  return new Promise(resolvePromise => {
    let child
    try {
      child = spawn('/opt/dsh-plugin-verifier/candidate-launcher', [], {
        cwd: '/workspace/plugin/package',
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', NODE_ENV: 'production' },
        stdio: ['pipe', 'ignore', 'ignore', 'pipe'],
      })
    } catch { resolvePromise({ reason: 'candidate-launch-failed' }); return }
    let bytes = Buffer.alloc(0), overflow = false, error = false, timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 8000)
    child.stdio[3].on('data', chunk => {
      if (overflow) return
      if (bytes.length + chunk.length > 60 * 1024) {
        overflow = true
        child.kill('SIGKILL')
      } else bytes = Buffer.concat([bytes, chunk])
    })
    child.once('error', () => { error = true })
    child.stdin.on('error', () => { error = true })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (timedOut || overflow || error || code !== 0 || signal !== null) {
        resolvePromise({ reason: timedOut ? 'candidate-timeout' : 'candidate-process-unsettled' }); return
      }
      try {
        const text = decoded(bytes)
        if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) fail('candidate-result-invalid')
        const value = JSON.parse(text.slice(0, -1))
        resolvePromise(validChild(value, operation) ? { value } : { reason: 'candidate-result-invalid' })
      } catch { resolvePromise({ reason: 'candidate-result-invalid' }) }
    })
    child.stdin.end(JSON.stringify({ operation, entry }) + '\n')
  })
}
let result
try {
  const encoded = readFileSync('/workspace/artifact', 'utf8')
  const request = JSON.parse(readFileSync('/workspace/input', 'utf8'))
  // Remove both staged files before any candidate process exists. The candidate
  // gets only its operation and the extracted package through its stdin/path.
  unlinkSync('/workspace/artifact')
  unlinkSync('/workspace/input')
  if (!request || request.schemaVersion !== 1 || !shaPattern.test(request.sha256)
    || !Number.isSafeInteger(request.sizeBytes) || request.sizeBytes < 1 || request.sizeBytes > limit
    || !validOperation(request.operation) || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) fail('invalid-worker-input')
  const packed = Buffer.from(encoded, 'base64')
  if (packed.length !== request.sizeBytes || packed.toString('base64') !== encoded || digest(packed) !== request.sha256) fail('artifact-mismatch')
  const entry = extract(packed)
  const child = await observeChild(entry, request.operation)
  if (!child.value) fail(child.reason)
  if (child.value.status === 'unknown') fail(child.value.reason)
  const schemas = child.value.schemas
  const schemaDigest = digest(Buffer.from(JSON.stringify(schemas)))
  if (request.operation.kind === 'invoke' && schemaDigest !== request.operation.schemaDigest) fail('schema-digest-changed')
  const base = { schemaVersion: 2, boundary: 'process-seccomp-v1', status: 'observed',
    artifactSha256: request.sha256, quiescent: true,
    environment: { node: process.version, cordis: version('@deepseek-ai/cordis'),
      tools: version('@deepseek-ai/dsh-tools'), systemPrompt: version('@deepseek-ai/dsh-system-prompt') }, schemaDigest }
  result = request.operation.kind === 'discover' ? { ...base, schemas } : { ...base, calls: child.value.calls }
} catch (error) {
  result = unknown(error instanceof Error ? error.message.slice(0, 128) : 'worker-error')
}
const output = JSON.stringify(result)
if (Buffer.byteLength(output) > 60 * 1024) process.stdout.write(JSON.stringify(unknown('worker-output-too-large')) + '\n')
else process.stdout.write(output + '\n')
DSH_PLUGIN_VERIFIER_WORKER_END */

/* DSH_PLUGIN_VERIFIER_CANDIDATE_START
// Executes only after the fixed launcher installs seccomp and Node permissions.
import { createHash } from 'node:crypto'
import { writeSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

const safeTool = /^[a-z][a-z0-9_-]{0,95}$/
let fiber, ctx, result, disposed = true
try {
  const chunks = []
  let total = 0
  for await (const chunk of process.stdin) {
    total += chunk.length
    if (total > 64 * 1024) throw new Error('candidate-input-too-large')
    chunks.push(chunk)
  }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!request || typeof request.entry !== 'string'
    || !/^\/workspace\/plugin\/package\/lib\/[A-Za-z0-9._/-]+\.js$/.test(request.entry)
    || request.entry.split('/').includes('..')
    || !request.operation || !['discover', 'invoke'].includes(request.operation.kind)) throw new Error('candidate-input-invalid')
  ctx = new Context()
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  const mod = await import(pathToFileURL(request.entry).href)
  fiber = ctx.plugin(mod.default ?? mod)
  let activationTimer
  try {
    await Promise.race([fiber, new Promise((_, reject) => {
      activationTimer = setTimeout(() => reject(new Error('plugin-activation-timeout')), 5000)
    })])
  } finally { clearTimeout(activationTimer) }
  if (fiber.state !== 2) throw new Error('plugin-fiber-not-active')
  const schemas = (await ctx.systemPrompt.assemble({})).tools
  if (!Array.isArray(schemas) || schemas.length < 1 || schemas.length > 64) throw new Error('invalid-tool-schemas')
  const names = new Set()
  for (const schema of schemas) {
    if (!schema || !safeTool.test(schema.name) || names.has(schema.name)) throw new Error('invalid-tool-schemas')
    names.add(schema.name)
  }
  const schemaDigest = createHash('sha256').update(JSON.stringify(schemas)).digest('hex')
  if (request.operation.kind === 'invoke' && request.operation.schemaDigest !== schemaDigest)
    throw new Error('schema-digest-changed')
  if (request.operation.kind === 'discover') result = { wireVersion: 1, status: 'result', schemas }
  else {
    const calls = []
    for (const call of request.operation.calls) {
      if (!names.has(call.toolName)) throw new Error('unknown-invoked-tool')
      const observed = await ctx.tools.execute({ callId: call.id, name: call.toolName,
        arguments: call.arguments, signal: new AbortController().signal })
      calls.push({ id: call.id, toolName: call.toolName, result: observed })
    }
    result = { wireVersion: 1, status: 'result', schemas, calls }
  }
} catch (error) {
  result = { wireVersion: 1, status: 'unknown', reason: error instanceof Error ? error.message.slice(0, 128) : 'candidate-error' }
} finally {
  try { if (fiber) await fiber.dispose() } catch { disposed = false }
  try { if (ctx) await ctx.fiber.dispose() } catch { disposed = false }
}
if (!disposed) result = { wireVersion: 1, status: 'unknown', reason: 'plugin-disposal-unconfirmed' }
try {
  const output = JSON.stringify(result)
  if (Buffer.byteLength(output) > 60 * 1024) throw new Error('candidate-output-too-large')
  writeSync(3, output + '\n')
} catch { process.exitCode = 1 }
DSH_PLUGIN_VERIFIER_CANDIDATE_END */
