import { createHash } from 'node:crypto'
import { NativeMacVerifierRunner, type NativeMacVerifierRunnerConfig } from '@dsh-enhanced/assistant-isolation'
import { behaviorNativeRuntimeDigest, NATIVE_BEHAVIOR_BOUNDARY, LINUX_BEHAVIOR_BOUNDARY, validatePluginBehaviorRunnerConfig,
  type PluginBehaviorRunnerConfig } from './plugin-behavior-config.js'
export { NATIVE_BEHAVIOR_BOUNDARY, LINUX_BEHAVIOR_BOUNDARY, validatePluginBehaviorRunnerConfig, validatePluginBehaviorDeploymentConfig } from './plugin-behavior-config.js'
export type { PluginBehaviorRunnerConfig, PluginBehaviorDeploymentConfig, LinuxPluginBehaviorRunnerConfig } from './plugin-behavior-config.js'
export { LINUX_BEHAVIOR_COMMAND, validateLinuxPluginBehaviorRuntime, verifyLinuxPluginBehaviorRuntime,
  linuxPluginBehaviorRuntimeDigest, prepareLinuxPluginBehaviorRuntime, readLinuxPluginBehaviorRuntime } from './linux-behavior-runtime.js'
export type { LinuxPluginBehaviorRuntime } from './linux-behavior-runtime.js'
import { linuxPluginBehaviorRuntimeDigest } from './linux-behavior-runtime.js'
import { LinuxBehaviorRunner } from './linux-behavior-runner.js'
import { nativeBehaviorFiles } from './native-behavior-artifact.js'
import { NATIVE_BEHAVIOR_SOURCE } from './native-behavior-worker.js'

const MAX_PACK_BYTES = 512 * 1024
const MAX_OPERATION_BYTES = 64 * 1024
const MAX_WORKER_OUTPUT_BYTES = 64 * 1024
const SHA256 = /^[a-f0-9]{64}$/u
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/u
const SAFE_TOOL = /^[a-z][a-z0-9_-]{0,95}$/u
const BOUNDARY = 'process-seccomp-v1'
export type PluginKind = 'tool' | 'service' | 'channel' | 'ui'
const PLUGIN_KINDS = new Set<PluginKind>(['tool', 'service', 'channel', 'ui'])
export const isPluginKind = (value: unknown): value is PluginKind =>
  typeof value === 'string' && PLUGIN_KINDS.has(value as PluginKind)

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
  readonly boundary?: typeof BOUNDARY | typeof NATIVE_BEHAVIOR_BOUNDARY | typeof LINUX_BEHAVIOR_BOUNDARY
  readonly runtimeDigest?: string
  readonly pluginKind?: PluginKind
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
  readonly pluginKind?: PluginKind
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

function validObservation(value: unknown, operation: PluginBehaviorOperation, sha256: string, requestedKind?: PluginKind): value is PluginBehaviorObservation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.hasOwn(record, 'pluginKind')) {
    if (!isPluginKind(record.pluginKind)) return false
    if (requestedKind !== undefined && record.pluginKind !== requestedKind) return false
  } else if (requestedKind !== undefined) {
    return false
  }
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

function validLinuxFrame(value: PluginBehaviorObservation, operation: PluginBehaviorOperation,
  expected: NonNullable<PluginBehaviorObservation['environment']>): boolean {
  const fields = ['schemaVersion', 'boundary', 'status', 'artifactSha256', 'quiescent', 'environment', 'schemaDigest',
    operation.kind === 'discover' ? 'schemas' : 'calls',
    ...(Object.hasOwn(value, 'pluginKind') ? ['pluginKind'] : [])]
  const environment = value.environment!
  return Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key))
    && Object.keys(environment).length === 4
    && Object.entries(expected).every(([key, version]) => environment[key as keyof typeof expected] === version)
    && (operation.kind === 'discover' || value.calls!.every(call => !Array.isArray(call) && Object.keys(call).length === 3))
}

/** Host-only behavior observation. The candidate and worker receive no oracle or promotion authority. */
export class PluginBehaviorRunner {
  readonly #runner: NativeMacVerifierRunner | LinuxBehaviorRunner
  readonly #native: boolean
  readonly #linux: boolean
  readonly #runtimeDigest?: string
  readonly #authorityDigest: string
  readonly #environment?: NonNullable<PluginBehaviorObservation['environment']>
  readonly #modulesPath?: string
  constructor(input: PluginBehaviorRunnerConfig) {
    const config = validatePluginBehaviorRunnerConfig(input)
    this.#authorityDigest = config.authorityDigest
    this.#native = 'backend' in config && config.backend === 'macos-seatbelt'
    this.#linux = 'backend' in config && config.backend === 'linux-native'
    if ('backend' in config && config.backend === 'linux-native') {
      const versions = config.runtime.runtime.versions
      this.#runtimeDigest = linuxPluginBehaviorRuntimeDigest(config.runtime)
      this.#environment = { node: versions.node, cordis: versions.cordis, tools: versions.tools, systemPrompt: versions.systemPrompt }
      this.#runner = new LinuxBehaviorRunner(config)
    } else if (this.#native) {
      const native = config as Omit<NativeMacVerifierRunnerConfig, 'source'>
      this.#runtimeDigest = behaviorNativeRuntimeDigest(native.runtime)
      this.#environment = { node: native.runtime.versions.node, cordis: native.runtime.versions.cordis,
        tools: native.runtime.versions.tools, systemPrompt: native.runtime.versions.systemPrompt }
      this.#modulesPath = native.runtime.modulesPath
      this.#runner = new NativeMacVerifierRunner({ ...native, source: NATIVE_BEHAVIOR_SOURCE })
    } else throw new Error('plugin behavior runner requires a native backend')
  }
  async run(input: PluginBehaviorRunnerInput): Promise<PluginBehaviorObservation> {
    const artifactSha256 = Buffer.isBuffer(input.artifact)
      ? createHash('sha256').update(input.artifact).digest('hex') : ''
    const unknown = (reason: string, quiescent = false, jobId?: string): PluginBehaviorObservation =>
      ({ status: 'unknown', quiescent, artifactSha256, reason, ...(jobId ? { jobId } : {}) })
    if (!Buffer.isBuffer(input.artifact) || input.artifact.length < 1 || input.artifact.length > MAX_PACK_BYTES)
      return unknown('plugin-artifact-out-of-bound', true)
    if (input.pluginKind !== undefined && !isPluginKind(input.pluginKind))
      return unknown('plugin-operation-invalid', true)
    let operation: PluginBehaviorOperation
    try {
      const serialized = canonicalJson(input.operation)
      const snapshot: unknown = serialized === undefined ? undefined : JSON.parse(serialized)
      if (!validOperation(snapshot)) return unknown('plugin-operation-invalid', true)
      operation = snapshot
    } catch { return unknown('plugin-operation-invalid', true) }
    let staged: ReturnType<typeof nativeBehaviorFiles> | undefined
    if (this.#native) {
      try { staged = nativeBehaviorFiles(input.artifact) }
      catch { return unknown('plugin-artifact-invalid', true) }
    }
    // Stable per frozen request: the durable runner must see identical bytes for a replay key.
    // This is only frame correlation. Single-process candidate output is untrusted.
    const kindField = input.pluginKind !== undefined ? { pluginKind: input.pluginKind } : {}
    const nonce = this.#native ? createHash('sha256').update(JSON.stringify({ authorityDigest: this.#authorityDigest,
      key: input.key, artifactSha256, operation, ...kindField })).digest('hex') : undefined
    const request = this.#native
      ? { schemaVersion: 1, nonce, artifactSha256, entry: staged!.entry,
        modulesPath: this.#modulesPath!, operation, ...kindField }
      : { schemaVersion: 1, sha256: artifactSha256, sizeBytes: input.artifact.length, operation, ...kindField }
    const stdin = canonicalJson(request)
    if (stdin === undefined || Buffer.byteLength(stdin) > MAX_OPERATION_BYTES) return unknown('plugin-operation-out-of-bound', true)
    let isolated
    try {
      isolated = this.#native
        ? await (this.#runner as NativeMacVerifierRunner).run(input.key, staged!.files, stdin, input.signal)
        : await (this.#runner as LinuxBehaviorRunner).run(input.key, input.artifact.toString('base64'), stdin, input.signal)
    }
    catch { return unknown('plugin-runner-unavailable') }
    if (isolated.status !== 'succeeded' || isolated.quiescent !== true || isolated.exitCode !== 0)
      return unknown(isolated.reason ?? 'plugin-runner-unsettled', isolated.quiescent, isolated.jobId)
    if (Buffer.byteLength(isolated.stdout) > MAX_WORKER_OUTPUT_BYTES || !isolated.stdout.endsWith('\n')
      || isolated.stdout.indexOf('\n') !== isolated.stdout.length - 1) return unknown('plugin-worker-output-invalid', true, isolated.jobId)
    try {
      const value: unknown = JSON.parse(isolated.stdout.slice(0, -1))
      if (this.#native) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return unknown('plugin-worker-output-invalid', true, isolated.jobId)
        const frame = value as Record<string, unknown>
        const header = frame.wireVersion === 1 && frame.nonce === nonce && frame.artifactSha256 === artifactSha256
          && frame.operationDigest === createHash('sha256').update(JSON.stringify(operation)).digest('hex')
        if (!header) return unknown('plugin-worker-output-invalid', true, isolated.jobId)
        if (frame.status === 'unknown' && typeof frame.reason === 'string' && frame.reason.length > 0
          && frame.reason.length <= 128 && Object.keys(frame).length === 6) return unknown(frame.reason, true, isolated.jobId)
        const hasPluginKind = Object.hasOwn(frame, 'pluginKind')
        if (hasPluginKind && (!isPluginKind(frame.pluginKind) || (input.pluginKind !== undefined && frame.pluginKind !== input.pluginKind)))
          return unknown('plugin-worker-observation-invalid', true, isolated.jobId)
        if (!hasPluginKind && input.pluginKind !== undefined)
          return unknown('plugin-worker-observation-invalid', true, isolated.jobId)
        if (frame.status !== 'result' || !SHA256.test(frame.schemaDigest as string)
          || Object.keys(frame).length !== (hasPluginKind ? 8 : 7)) return unknown('plugin-worker-observation-invalid', true, isolated.jobId)
        if (operation.kind === 'discover') {
          if (!Array.isArray(frame.schemas) || frame.schemas.length < 1 || frame.schemas.length > 64
            || frame.calls !== undefined || createHash('sha256').update(JSON.stringify(frame.schemas)).digest('hex') !== frame.schemaDigest)
            return unknown('plugin-worker-observation-invalid', true, isolated.jobId)
          const names = new Set<string>()
          for (const schema of frame.schemas) {
            const name = (schema as { name?: unknown } | null)?.name
            if (typeof name !== 'string' || !SAFE_TOOL.test(name) || names.has(name))
              return unknown('plugin-worker-observation-invalid', true, isolated.jobId)
            names.add(name)
          }
        } else {
          const calls = operation.calls
          if (frame.schemaDigest !== operation.schemaDigest || !Array.isArray(frame.calls)
            || frame.calls.length !== calls.length || frame.schemas !== undefined
            || frame.calls.some((call, index) => !call || typeof call !== 'object'
              || (call as { id?: string }).id !== calls[index]!.id
              || (call as { toolName?: string }).toolName !== calls[index]!.toolName
              || !Object.hasOwn(call, 'result'))) return unknown('plugin-worker-observation-invalid', true, isolated.jobId)
        }
        return { status: 'observed', quiescent: true, artifactSha256, jobId: isolated.jobId,
          boundary: NATIVE_BEHAVIOR_BOUNDARY, runtimeDigest: this.#runtimeDigest!, environment: this.#environment!,
          ...(isPluginKind(frame.pluginKind) ? { pluginKind: frame.pluginKind } : {}),
          schemaDigest: frame.schemaDigest as string,
          ...(operation.kind === 'discover' ? { schemas: frame.schemas as unknown[] }
            : { calls: frame.calls as { id: string; toolName: string; result: unknown }[] }) }
      }
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>
        if (record.schemaVersion === 2 && record.boundary === BOUNDARY && record.status === 'unknown'
          && typeof record.reason === 'string' && record.reason.length > 0 && record.reason.length <= 128
          && Object.keys(record).length === 4) return unknown(record.reason, true, isolated.jobId)
      }
      if (!validObservation(value, operation, artifactSha256, input.pluginKind)) return unknown('plugin-worker-observation-invalid', true, isolated.jobId)
      const observation = value as PluginBehaviorObservation
      if (this.#linux && !validLinuxFrame(observation, operation, this.#environment!))
        return unknown('plugin-worker-observation-invalid', true, isolated.jobId)
      return { status: 'observed', quiescent: true, artifactSha256, jobId: isolated.jobId,
        ...(this.#linux ? { boundary: LINUX_BEHAVIOR_BOUNDARY, runtimeDigest: this.#runtimeDigest! } : {}),
        ...(isPluginKind(observation.pluginKind) ? { pluginKind: observation.pluginKind } : {}),
        environment: observation.environment!, schemaDigest: observation.schemaDigest!,
        ...(operation.kind === 'discover' ? { schemas: observation.schemas! } : { calls: observation.calls! }) }
    } catch { return unknown('plugin-worker-output-invalid', true, isolated.jobId) }
  }
  close(): Promise<void> { return this.#runner.close() }
}

/* DSH_PLUGIN_VERIFIER_WORKER_START
// Inlined into the native behavior worker; this code executes inside the isolation
// worker, never in the Host process.
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

const limit = 512 * 1024
const safeId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/
const safeTool = /^[a-z][a-z0-9_-]{0,95}$/
const shaPattern = /^[a-f0-9]{64}$/
const kinds = new Set(['tool', 'service', 'channel', 'ui'])
const fail = reason => { throw new Error(reason) }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
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
  if (s === '{}') return Object.create(null)
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
  const config = Object.create(null)
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
            const child = Object.create(null)
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
function readPackageMeta(destination, seen, manifest) {
  const pkgDir = join(destination, 'package')
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
    hasClientExport,
    clientExportMissing,
  }
  let patch = { hasEntry: false, inject: [], config: Object.create(null), hasUiDecl: false, hasChannelDecl: false, hasServiceDecl: false }
  if (seen.has('package/cordis.patch.yml')) {
    const rawPatch = readFileSync(join(pkgDir, 'cordis.patch.yml'), 'utf8')
    if (Buffer.byteLength(rawPatch) <= 64 * 1024) patch = parsePatchMeta(rawPatch)
  }
  return { pkg, patch }
}
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
  const meta = readPackageMeta(destination, seen, manifest)
  symlinkSync('/opt/dsh-plugin-verifier/node_modules', join(destination, 'package/node_modules'))
  return { entry, meta }
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
function validChild(value, operation, requestedKind) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.wireVersion !== 1) return false
  if (value.status === 'unknown') return Object.keys(value).length === 3
    && typeof value.reason === 'string' && value.reason.length > 0 && value.reason.length <= 128
  const hasKind = Object.hasOwn(value, 'pluginKind')
  if (hasKind && (!kinds.has(value.pluginKind) || (requestedKind !== undefined && value.pluginKind !== requestedKind))) return false
  if (!hasKind && requestedKind !== undefined) return false
  if (value.status !== 'result' || !Array.isArray(value.schemas) || value.schemas.length < 1
    || value.schemas.length > 64 || Object.keys(value).length !== (operation.kind === 'discover' ? 3 : 4) + (hasKind ? 1 : 0)) return false
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
function observeChild(entry, operation, requestedKind, meta) {
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
        resolvePromise(validChild(value, operation, requestedKind) ? { value } : { reason: 'candidate-result-invalid' })
      } catch { resolvePromise({ reason: 'candidate-result-invalid' }) }
    })
    child.stdin.end(JSON.stringify({ operation, entry, ...(requestedKind !== undefined ? { pluginKind: requestedKind } : {}), meta }) + '\n')
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
    || (request.pluginKind !== undefined && !kinds.has(request.pluginKind))
    || !validOperation(request.operation) || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) fail('invalid-worker-input')
  const packed = Buffer.from(encoded, 'base64')
  if (packed.length !== request.sizeBytes || packed.toString('base64') !== encoded || digest(packed) !== request.sha256) fail('artifact-mismatch')
  const { entry, meta } = extract(packed)
  const child = await observeChild(entry, request.operation, request.pluginKind, meta)
  if (!child.value) fail(child.reason)
  if (child.value.status === 'unknown') fail(child.value.reason)
  const schemas = child.value.schemas
  const schemaDigest = digest(Buffer.from(JSON.stringify(schemas)))
  if (request.operation.kind === 'invoke' && schemaDigest !== request.operation.schemaDigest) fail('schema-digest-changed')
  const base = { schemaVersion: 2, boundary: 'process-seccomp-v1', status: 'observed',
    artifactSha256: request.sha256, quiescent: true,
    ...(child.value.pluginKind !== undefined ? { pluginKind: child.value.pluginKind } : {}),
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
import { Context, Service } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { projectToolSchema } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline, executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline'

const safeTool = /^[a-z][a-z0-9_-]{0,95}$/
const safeEnum = /^[A-Za-z0-9_.:-]{1,64}$/
const safeMethod = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const kinds = new Set(['tool', 'service', 'channel', 'ui'])
const skipMethods = new Set(['constructor', 'start', 'stop', 'dispose', 'init'])
const cordisOrig = Symbol.for('cordis.original')
const unwrap = v => (v && typeof v === 'object' ? v[cordisOrig] : undefined) ?? v
const badHealth = h => !h || typeof h !== 'object' || h.ready === false || h.ok === false || h.status === 'error' || h.status === 'unhealthy'
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
let fiber, ctx, result, disposed = true, providedNames = []
const channelAdapters = new Set()
const typertContributions = new Set()
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
    || (request.pluginKind !== undefined && !kinds.has(request.pluginKind))
    || !request.operation || !['discover', 'invoke'].includes(request.operation.kind)) throw new Error('candidate-input-invalid')
  const meta = request.meta ?? { pkg: {}, patch: { inject: [], config: {} } }
  const pkg = meta.pkg ?? {}, patch = meta.patch ?? { inject: [], config: {} }
  ctx = new Context()
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  const pipeline = new ToolExecutionPipeline(ctx)
  ctx.tools.setExecutor({
    describe: tools => ({ schemas: tools.map(definition => projectToolSchema(definition, false)) }),
    execute: input => executeToolBatch(input, pipeline, () => 1),
  })
  const mod = await import(pathToFileURL(request.entry).href)
  const target = mod.default ?? mod
  const declaredInject = [...new Set([
    ...(Array.isArray(target?.inject) ? target.inject : []),
    ...(Array.isArray(mod?.inject) ? mod.inject : []),
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
  const hasPatchCfg = patch.config && typeof patch.config === 'object' && Object.keys(patch.config).length > 0
  const pluginCfg = hasPatchCfg ? patch.config : (typeof target?.Config === 'function' || typeof mod?.Config === 'function' ? {} : undefined)
  fiber = pluginCfg !== undefined ? ctx.plugin(target, pluginCfg) : ctx.plugin(target)
  let activationTimer
  try {
    await Promise.race([fiber, new Promise((_, reject) => {
      activationTimer = setTimeout(() => reject(new Error('plugin-activation-timeout')), 5000)
    })])
  } finally { clearTimeout(activationTimer) }
  await new Promise(resolve => setImmediate(resolve))
  if (fiber.state !== 2) throw new Error('plugin-fiber-not-active')
  const toolSchemas = (await ctx.systemPrompt.assemble({})).tools ?? []
  const provisions = [...(fiber.provisions ?? [])]
  const uiExports = Boolean(validTypertObj(mod.TYPERT) || validTypertObj(mod.TYPERT_REMOTE)
    || hasNonEmpty(mod.routes) || hasNonEmpty(mod.sections) || hasNonEmpty(mod.settings) || validUiObj(mod.ui)
    || (target && typeof target === 'object' && (validTypertObj(target.TYPERT) || validTypertObj(target.TYPERT_REMOTE)
      || hasNonEmpty(target.routes) || hasNonEmpty(target.sections) || hasNonEmpty(target.settings) || validUiObj(target.ui))))
  const channelExports = Boolean(mod.adapter || mod.channel || (target && typeof target === 'object' && (target.adapter || target.channel)))
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
    var invokeNonTool = async call => {
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
        return { isError: false, value, content: [{ type: 'text', text: JSON.stringify(value) }] }
      }
      if (call.toolName === 'service_method_probe') {
        const s = call.arguments?.service, m = call.arguments?.method
        if (typeof s !== 'string' || typeof m !== 'string' || !svcMethods.get(s)?.has(m)) throw new Error('invalid-service-method')
        const res = await svcMap.get(s).value[m](call.arguments?.input)
        const value = { kind: 'service', service: s, method: m, result: res ?? null }
        return { isError: false, value, content: [{ type: 'text', text: JSON.stringify(value) }] }
      }
      return undefined
    }
  } else if (effectiveKind === 'channel') {
    const exported = [mod.adapter, mod.channel, target?.adapter, target?.channel].filter(Boolean)
    if (channelAdapters.size < 1 && channelProvisions.length < 1 && exported.length < 1) throw new Error('invalid-channel-plugin')
    for (const a of [...channelAdapters, ...channelProvisions.map(p => p.value), ...exported]) if (!checkAdapter(a)) throw new Error('invalid-channel-plugin')
    for (const p of provisions) if (typeof p.value?.health === 'function' && badHealth(await p.value.health())) throw new Error('channel-unhealthy')
    schemas.push({ name: 'channel_readiness_probe', parameters: { type: 'object', properties: {
      check: { type: 'string', enum: ['adapters', 'capabilities', 'health'] }, channel: { type: 'string' },
    }, additionalProperties: false } })
    for (const s of toolSchemas) if (schemas.length < 64 && !schemas.some(x => x.name === s.name)) schemas.push(s)
    var invokeNonTool = async call => {
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
      return { isError: false, value, content: [{ type: 'text', text: JSON.stringify(value) }] }
    }
  } else {
    if (pkg.clientExportMissing) throw new Error('invalid-ui-plugin')
    if (typertContributions.size < 1 && !uiExports && !pkg.hasClientExport) throw new Error('invalid-ui-plugin')
    schemas.push({ name: 'ui_declaration_probe', parameters: { type: 'object', properties: {
      check: { type: 'string', enum: ['contributions', 'routes', 'settings'] }, section: { type: 'string' },
    }, additionalProperties: false } })
    for (const s of toolSchemas) if (schemas.length < 64 && !schemas.some(x => x.name === s.name)) schemas.push(s)
    var invokeNonTool = async call => {
      if (call.toolName !== 'ui_declaration_probe') return undefined
      const contribs = [...typertContributions].map(c => ({ package: c.package, face: c.face ?? null, schemas: Object.keys(c.schemas ?? {}), invocations: Object.keys(c.invocations ?? {}).length }))
      const value = { kind: 'ui', ready: true, contributions: contribs, hasClientExport: Boolean(pkg.hasClientExport),
        routes: hasNonEmpty(mod.routes) ? mod.routes : hasNonEmpty(target?.routes) ? target.routes : [],
        sections: hasNonEmpty(mod.sections) ? mod.sections : hasNonEmpty(target?.sections) ? target.sections : [],
        settings: hasNonEmpty(mod.settings) ? mod.settings : hasNonEmpty(target?.settings) ? target.settings : [] }
      return { isError: false, value, content: [{ type: 'text', text: JSON.stringify(value) }] }
    }
  }
  const schemaDigest = createHash('sha256').update(JSON.stringify(schemas)).digest('hex')
  if (request.operation.kind === 'invoke' && request.operation.schemaDigest !== schemaDigest) throw new Error('schema-digest-changed')
  const emitKind = request.pluginKind !== undefined || effectiveKind !== 'tool'
  const kindOut = emitKind ? { pluginKind: effectiveKind } : {}
  if (request.operation.kind === 'discover') result = { wireVersion: 1, status: 'result', ...kindOut, schemas }
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
          calls: [{ type: 'tool-call', id: call.id, name: call.toolName, arguments: JSON.stringify(call.arguments) }],
          signal: new AbortController().signal,
        })
        if (!batch || !Array.isArray(batch.results) || batch.results.length !== 1 || !batch.results[0]?.result)
          throw new Error('tool-batch-invalid')
        calls.push({ id: call.id, toolName: call.toolName, result: batch.results[0].result })
      }
    }
    result = { wireVersion: 1, status: 'result', ...kindOut, schemas, calls }
  }
} catch (error) {
  result = { wireVersion: 1, status: 'unknown', reason: error instanceof Error ? error.message.slice(0, 128) : 'candidate-error' }
} finally {
  try { if (fiber) await fiber.dispose() } catch { disposed = false }
  if (disposed) {
    if (channelAdapters.size > 0 || typertContributions.size > 0) disposed = false
    for (const svcName of providedNames) if (ctx?.get(svcName) !== undefined) disposed = false
  }
  try { if (ctx) await ctx.fiber.dispose() } catch { disposed = false }
}
if (!disposed) result = { wireVersion: 1, status: 'unknown', reason: 'plugin-disposal-unconfirmed' }
try {
  const output = JSON.stringify(result)
  if (Buffer.byteLength(output) > 60 * 1024) throw new Error('candidate-output-too-large')
  writeSync(3, output + '\n')
} catch { process.exitCode = 1 }
DSH_PLUGIN_VERIFIER_CANDIDATE_END */
