import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, isAbsolute, resolve } from 'node:path'

export interface RuntimeObserverTarget {
  entryId: string
  module: string
  configDigest: string
  services: string[]
}

export interface RuntimeObserverConfig {
  socketPath: string
  keyPath: string
  profilePath: string
  targets: RuntimeObserverTarget[]
}

const HEX = /^[a-f0-9]{64}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
export const RUNTIME_OBSERVER_MAX_BYTES = 65_536
export const RUNTIME_OBSERVER_TIMEOUT = 2_000

export function runtimeObserverFail(): never { throw new Error('runtime observer: invalid configuration, authentication or runtime observation') }

/**
 * Runtime-only platform gate. The observer binds an owner-private AF_UNIX socket
 * and reads Loader/Fiber state through /proc-backed ownership checks, which are
 * only available on Linux. Callers that merely validate or clone configuration
 * must not use this.
 */
export function assertRuntimeObserverPlatform(): void {
  if (process.platform !== 'linux') runtimeObserverFail()
}
export function assertRuntimeObserverExact(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...fields].sort().join('\0')) runtimeObserverFail()
}
export function assertRuntimeObserverText(value: unknown, pattern = ID): asserts value is string {
  if (typeof value !== 'string' || !pattern.test(value)) runtimeObserverFail()
}

/** Bounded JSON digest; never invokes a config object's toJSON/getter. */
export function runtimeConfigDigest(value: unknown): string {
  let remaining = RUNTIME_OBSERVER_MAX_BYTES
  const seen = new Set<object>()
  const encode = (item: unknown, depth: number): string => {
    if (depth > 32 || --remaining < 0) runtimeObserverFail()
    if (item === null || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number') { if (!Number.isFinite(item)) runtimeObserverFail(); return JSON.stringify(item) }
    if (typeof item === 'string') { remaining -= item.length; if (remaining < 0) runtimeObserverFail(); return JSON.stringify(item) }
    if (typeof item !== 'object' || item === undefined || seen.has(item)) runtimeObserverFail()
    seen.add(item)
    try {
      if (Object.getOwnPropertySymbols(item).length) runtimeObserverFail()
      if (Array.isArray(item)) {
        if (item.length > remaining) runtimeObserverFail()
        const fields = Object.getOwnPropertyDescriptors(item)
        if (Object.keys(fields).length !== item.length + 1) runtimeObserverFail()
        return `[${Array.from({ length: item.length }, (_, index) => {
          const field = fields[String(index)]
          if (!field || !('value' in field)) runtimeObserverFail()
          return encode(field.value, depth + 1)
        }).join(',')}]`
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) runtimeObserverFail()
      const fields = Object.getOwnPropertyDescriptors(item)
      return `{${Object.keys(fields).sort().map(key => {
        const field = fields[key]!
        if (!('value' in field) || !field.enumerable) runtimeObserverFail()
        return `${encode(key, depth + 1)}:${encode(field.value, depth + 1)}`
      }).join(',')}}`
    } finally { seen.delete(item) }
  }
  const bytes = encode(value, 0)
  if (Buffer.byteLength(bytes) > RUNTIME_OBSERVER_MAX_BYTES) runtimeObserverFail()
  return createHash('sha256').update(bytes).digest('hex')
}

export function privateRuntimeObserverDirectory(path: string): void {
  const stat = lstatSync(path)
  if (realpathSync(path) !== path || !stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) runtimeObserverFail()
}

export function readPrivateRuntimeObserverKey(path: string): Buffer {
  privateRuntimeObserverDirectory(dirname(path))
  if (realpathSync(path) !== path) runtimeObserverFail()
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd, { bigint: true })
    if (!before.isFile() || before.uid !== BigInt(process.getuid!()) || before.nlink !== 1n
      || (before.mode & 0o077n) !== 0n || before.size !== 32n) runtimeObserverFail()
    const bytes = readFileSync(fd)
    const after = fstatSync(fd, { bigint: true }); const named = lstatSync(path, { bigint: true })
    if (bytes.length !== 32 || before.ino !== named.ino || before.dev !== named.dev
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) runtimeObserverFail()
    return bytes
  } finally { closeSync(fd) }
}

/**
 * Pure configuration validation: shape, canonical paths, private key material and
 * bounded targets. It is reached by the read-only deployment preflight
 * (`normalizeControlPlaneConfig`), so it must not depend on the running platform.
 * The Linux requirement belongs to the runtime shells that bind the AF_UNIX
 * observer socket; see `assertRuntimeObserverPlatform`.
 */
export function validateRuntimeObserverConfig(value: unknown): asserts value is RuntimeObserverConfig {
  assertRuntimeObserverExact(value, ['socketPath', 'keyPath', 'profilePath', 'targets'])
  for (const key of ['socketPath', 'keyPath', 'profilePath'] as const) {
    if (typeof value[key] !== 'string' || !isAbsolute(value[key]) || resolve(value[key]) !== value[key]
      || ['\0', '\r', '\n'].some(char => (value[key] as string).includes(char))) runtimeObserverFail()
  }
  const { socketPath, keyPath, profilePath } = value as unknown as RuntimeObserverConfig
  if (Buffer.byteLength(socketPath) > 100 || socketPath === keyPath || realpathSync(profilePath) !== profilePath
    || !lstatSync(profilePath).isDirectory()) runtimeObserverFail()
  for (const path of [socketPath, keyPath]) {
    if (path === profilePath || path.startsWith(`${profilePath}/`)) runtimeObserverFail()
    privateRuntimeObserverDirectory(dirname(path))
  }
  readPrivateRuntimeObserverKey(keyPath).fill(0)
  if (!Array.isArray(value.targets) || value.targets.length < 1 || value.targets.length > 32) runtimeObserverFail()
  const ids = new Set<string>()
  for (const target of value.targets) {
    assertRuntimeObserverExact(target, ['entryId', 'module', 'configDigest', 'services'])
    assertRuntimeObserverText(target.entryId); assertRuntimeObserverText(target.configDigest, HEX)
    if (typeof target.module !== 'string' || target.module.length < 1 || target.module.length > 512
      || ['\0', '\r', '\n'].some(char => (target.module as string).includes(char))) runtimeObserverFail()
    if (ids.has(target.entryId)) runtimeObserverFail()
    ids.add(target.entryId)
    if (!Array.isArray(target.services) || target.services.length > 16 || new Set(target.services).size !== target.services.length) runtimeObserverFail()
    for (const service of target.services) assertRuntimeObserverText(service, /^[A-Za-z][A-Za-z0-9._-]{0,99}$/u)
  }
}

export type RuntimeObserverInstance = { uid: number; epoch: number }
export interface RuntimeEntryObservation {
  entryId: string
  module: string | null
  configDigest: string | null
  active: boolean
  instance: RuntimeObserverInstance | null
  dependencies: Array<{ name: string; instance: RuntimeObserverInstance | null }>
  services: Array<{ name: string; instance: RuntimeObserverInstance | null }>
}
export interface RuntimeObservation {
  schemaVersion: 1
  kind: 'dsh-runtime-observation'
  observerId: string
  observerConfigDigest: string
  challenge: string
  processId: number
  invocationId: string | null
  profilePath: string
  observedAt: number
  entries: RuntimeEntryObservation[]
}

export function runtimeObserverMac(key: Buffer, domain: string, value: unknown): string {
  return createHmac('sha256', key).update(`${domain}\n${JSON.stringify(value)}`).digest('hex')
}
export function equalRuntimeObserverMac(actual: unknown, expected: string): boolean {
  return typeof actual === 'string' && HEX.test(actual) && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
}

export function assertRuntimeObservation(value: unknown): asserts value is RuntimeObservation {
  assertRuntimeObserverExact(value, ['schemaVersion', 'kind', 'observerId', 'observerConfigDigest', 'challenge', 'processId', 'invocationId', 'profilePath', 'observedAt', 'entries'])
  if (value.schemaVersion !== 1 || value.kind !== 'dsh-runtime-observation') runtimeObserverFail()
  assertRuntimeObserverText(value.observerId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u)
  assertRuntimeObserverText(value.observerConfigDigest, HEX); assertRuntimeObserverText(value.challenge, HEX)
  for (const name of ['processId', 'observedAt']) if (!Number.isSafeInteger(value[name]) || (value[name] as number) < 1) runtimeObserverFail()
  if (value.invocationId !== null) assertRuntimeObserverText(value.invocationId, /^[a-f0-9]{32}$/u)
  if (typeof value.profilePath !== 'string' || value.profilePath.length > 4096 || !isAbsolute(value.profilePath)) runtimeObserverFail()
  if (!Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > 32) runtimeObserverFail()
  const instance = (item: unknown): void => {
    if (item === null) return
    assertRuntimeObserverExact(item, ['uid', 'epoch'])
    if (!Number.isSafeInteger(item.uid) || (item.uid as number) < 0 || !Number.isSafeInteger(item.epoch) || (item.epoch as number) < 1) runtimeObserverFail()
  }
  const ids = new Set<string>()
  for (const entry of value.entries) {
    assertRuntimeObserverExact(entry, ['entryId', 'module', 'configDigest', 'active', 'instance', 'dependencies', 'services'])
    assertRuntimeObserverText(entry.entryId)
    if (ids.has(entry.entryId)) runtimeObserverFail()
    ids.add(entry.entryId)
    if (entry.module !== null && (typeof entry.module !== 'string' || entry.module.length > 512)) runtimeObserverFail()
    if (entry.configDigest !== null) assertRuntimeObserverText(entry.configDigest, HEX)
    if (typeof entry.active !== 'boolean' || (entry.active && (entry.instance === null || entry.module === null || entry.configDigest === null))) runtimeObserverFail()
    instance(entry.instance)
    if (entry.active && (entry.instance as RuntimeObserverInstance).uid === 0) runtimeObserverFail()
    for (const name of ['dependencies', 'services']) {
      const services = entry[name]
      if (!Array.isArray(services) || services.length > 128) runtimeObserverFail()
      const names = new Set<string>()
      for (const service of services) {
        assertRuntimeObserverExact(service, ['name', 'instance']); assertRuntimeObserverText(service.name)
        if (names.has(service.name) || (entry.active && service.instance === null)) runtimeObserverFail()
        names.add(service.name); instance(service.instance)
      }
    }
  }
}

/** Owner caller supplies no claimed state; fresh challenge authenticates the observed response. */
export async function queryRuntimeObserver(input: { socketPath: string; keyPath: string; signal?: AbortSignal }): Promise<RuntimeObservation> {
  if (process.platform !== 'linux') runtimeObserverFail()
  privateRuntimeObserverDirectory(dirname(input.socketPath))
  const before = lstatSync(input.socketPath)
  if (!before.isSocket() || before.uid !== process.getuid!() || (before.mode & 0o077) !== 0 || realpathSync(input.socketPath) !== input.socketPath) runtimeObserverFail()
  const key = readPrivateRuntimeObserverKey(input.keyPath)
  const challenge = randomBytes(32).toString('hex')
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(RUNTIME_OBSERVER_TIMEOUT)]) : AbortSignal.timeout(RUNTIME_OBSERVER_TIMEOUT)
  try {
    signal.throwIfAborted()
    return await new Promise<RuntimeObservation>((resolveResult, reject) => {
      const socket = createConnection(input.socketPath)
      const chunks: Buffer[] = []; let size = 0; let settled = false
      const finish = (error?: Error, value?: RuntimeObservation): void => {
        if (settled) return
        settled = true; signal.removeEventListener('abort', abort); socket.destroy()
        if (error) reject(error); else resolveResult(value!)
      }
      const abort = (): void => finish(new Error('runtime observer query cancelled or timed out'))
      signal.addEventListener('abort', abort, { once: true })
      socket.once('error', () => finish(new Error('runtime observer connection failed')))
      socket.once('connect', () => {
        if (signal.aborted) { abort(); return }
        socket.end(JSON.stringify({ schemaVersion: 1, challenge, mac: runtimeObserverMac(key, 'dsh-runtime-request/v1', challenge) }) + '\n')
      })
      socket.on('data', chunk => {
        size += chunk.length
        if (size > RUNTIME_OBSERVER_MAX_BYTES) { finish(new Error('runtime observer response exceeds limit')); return }
        chunks.push(chunk)
      })
      socket.once('end', () => {
        try {
          const bytes = Buffer.concat(chunks)
          if (bytes.at(-1) !== 10 || bytes.subarray(0, -1).includes(10)) runtimeObserverFail()
          const response: unknown = JSON.parse(bytes.toString('utf8'))
          assertRuntimeObserverExact(response, ['observation', 'mac'])
          if (!equalRuntimeObserverMac(response.mac, runtimeObserverMac(key, 'dsh-runtime-response/v1', response.observation))) runtimeObserverFail()
          const observation = response.observation
          assertRuntimeObservation(observation)
          if (observation.challenge !== challenge) runtimeObserverFail()
          const after = lstatSync(input.socketPath)
          if (before.ino !== after.ino || before.dev !== after.dev || !after.isSocket() || after.uid !== before.uid || (after.mode & 0o077) !== 0) runtimeObserverFail()
          finish(undefined, observation)
        } catch { finish(new Error('runtime observer response rejected')) }
      })
      socket.once('close', () => { if (!settled) finish(new Error('runtime observer connection closed before response')) })
    })
  } finally { key.fill(0) }
}
