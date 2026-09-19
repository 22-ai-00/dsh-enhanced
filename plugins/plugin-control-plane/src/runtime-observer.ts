import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { chmod, lstat, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { dirname, isAbsolute, resolve } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { Loader } from '@deepseek-ai/cordis-plugin-loader'

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
const MAX_BYTES = 65_536
const TIMEOUT = 2_000
// Cordis 4.0.2 exports this as an ambient const enum, unavailable at runtime.
const ACTIVE = 2
function fail(): never { throw new Error('runtime observer: invalid configuration, authentication or runtime observation') }
function exact(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...fields].sort().join('\0')) fail()
}
function text(value: unknown, pattern = ID): asserts value is string {
  if (typeof value !== 'string' || !pattern.test(value)) fail()
}

/** Bounded JSON digest; never invokes a config object's toJSON/getter. */
export function runtimeConfigDigest(value: unknown): string {
  let remaining = MAX_BYTES
  const seen = new Set<object>()
  const encode = (item: unknown, depth: number): string => {
    if (depth > 32 || --remaining < 0) fail()
    if (item === null || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail(); return JSON.stringify(item) }
    if (typeof item === 'string') { remaining -= item.length; if (remaining < 0) fail(); return JSON.stringify(item) }
    if (typeof item !== 'object' || item === undefined || seen.has(item)) fail()
    seen.add(item)
    try {
      if (Object.getOwnPropertySymbols(item).length) fail()
      if (Array.isArray(item)) {
        if (item.length > remaining) fail()
        const fields = Object.getOwnPropertyDescriptors(item)
        if (Object.keys(fields).length !== item.length + 1) fail()
        return `[${Array.from({ length: item.length }, (_, index) => {
          const field = fields[String(index)]
          if (!field || !('value' in field)) fail()
          return encode(field.value, depth + 1)
        }).join(',')}]`
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail()
      const fields = Object.getOwnPropertyDescriptors(item)
      return `{${Object.keys(fields).sort().map(key => {
        const field = fields[key]!
        if (!('value' in field) || !field.enumerable) fail()
        return `${encode(key, depth + 1)}:${encode(field.value, depth + 1)}`
      }).join(',')}}`
    } finally { seen.delete(item) }
  }
  const bytes = encode(value, 0)
  if (Buffer.byteLength(bytes) > MAX_BYTES) fail()
  return createHash('sha256').update(bytes).digest('hex')
}

function privateDirectory(path: string): void {
  const stat = lstatSync(path)
  if (realpathSync(path) !== path || !stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) fail()
}

function privateKey(path: string): Buffer {
  privateDirectory(dirname(path))
  if (realpathSync(path) !== path) fail()
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd, { bigint: true })
    if (!before.isFile() || before.uid !== BigInt(process.getuid!()) || before.nlink !== 1n
      || (before.mode & 0o077n) !== 0n || before.size !== 32n) fail()
    const bytes = readFileSync(fd)
    const after = fstatSync(fd, { bigint: true }); const named = lstatSync(path, { bigint: true })
    if (bytes.length !== 32 || before.ino !== named.ino || before.dev !== named.dev
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail()
    return bytes
  } finally { closeSync(fd) }
}

export function validateRuntimeObserverConfig(value: unknown): asserts value is RuntimeObserverConfig {
  exact(value, ['socketPath', 'keyPath', 'profilePath', 'targets'])
  if (process.platform !== 'linux') fail()
  for (const key of ['socketPath', 'keyPath', 'profilePath'] as const) {
    if (typeof value[key] !== 'string' || !isAbsolute(value[key]) || resolve(value[key]) !== value[key]
      || ['\0', '\r', '\n'].some(char => (value[key] as string).includes(char))) fail()
  }
  const { socketPath, keyPath, profilePath } = value as unknown as RuntimeObserverConfig
  if (Buffer.byteLength(socketPath) > 100 || socketPath === keyPath || realpathSync(profilePath) !== profilePath
    || !lstatSync(profilePath).isDirectory()) fail()
  for (const path of [socketPath, keyPath]) {
    if (path === profilePath || path.startsWith(`${profilePath}/`)) fail()
    privateDirectory(dirname(path))
  }
  privateKey(keyPath).fill(0)
  if (!Array.isArray(value.targets) || value.targets.length < 1 || value.targets.length > 32) fail()
  const ids = new Set<string>()
  for (const target of value.targets) {
    exact(target, ['entryId', 'module', 'configDigest', 'services'])
    text(target.entryId); text(target.configDigest, HEX)
    if (typeof target.module !== 'string' || target.module.length < 1 || target.module.length > 512
      || ['\0', '\r', '\n'].some(char => (target.module as string).includes(char))) fail()
    if (ids.has(target.entryId)) fail()
    ids.add(target.entryId)
    if (!Array.isArray(target.services) || target.services.length > 16 || new Set(target.services).size !== target.services.length) fail()
    for (const service of target.services) text(service, /^[A-Za-z][A-Za-z0-9._-]{0,99}$/u)
  }
}

type Instance = { uid: number; epoch: number }
export interface RuntimeEntryObservation {
  entryId: string
  module: string | null
  configDigest: string | null
  active: boolean
  instance: Instance | null
  dependencies: Array<{ name: string; instance: Instance | null }>
  services: Array<{ name: string; instance: Instance | null }>
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

function mac(key: Buffer, domain: string, value: unknown): string {
  return createHmac('sha256', key).update(`${domain}\n${JSON.stringify(value)}`).digest('hex')
}
function equalMac(actual: unknown, expected: string): boolean {
  return typeof actual === 'string' && HEX.test(actual) && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
}

function assertObservation(value: unknown): asserts value is RuntimeObservation {
  exact(value, ['schemaVersion', 'kind', 'observerId', 'observerConfigDigest', 'challenge', 'processId', 'invocationId', 'profilePath', 'observedAt', 'entries'])
  if (value.schemaVersion !== 1 || value.kind !== 'dsh-runtime-observation') fail()
  text(value.observerId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u)
  text(value.observerConfigDigest, HEX); text(value.challenge, HEX)
  for (const name of ['processId', 'observedAt']) if (!Number.isSafeInteger(value[name]) || (value[name] as number) < 1) fail()
  if (value.invocationId !== null) text(value.invocationId, /^[a-f0-9]{32}$/u)
  if (typeof value.profilePath !== 'string' || value.profilePath.length > 4096 || !isAbsolute(value.profilePath)) fail()
  if (!Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > 32) fail()
  const instance = (item: unknown): void => {
    if (item === null) return
    exact(item, ['uid', 'epoch'])
    if (!Number.isSafeInteger(item.uid) || (item.uid as number) < 0 || !Number.isSafeInteger(item.epoch) || (item.epoch as number) < 1) fail()
  }
  const ids = new Set<string>()
  for (const entry of value.entries) {
    exact(entry, ['entryId', 'module', 'configDigest', 'active', 'instance', 'dependencies', 'services'])
    text(entry.entryId)
    if (ids.has(entry.entryId)) fail()
    ids.add(entry.entryId)
    if (entry.module !== null && (typeof entry.module !== 'string' || entry.module.length > 512)) fail()
    if (entry.configDigest !== null) text(entry.configDigest, HEX)
    if (typeof entry.active !== 'boolean' || (entry.active && (entry.instance === null || entry.module === null || entry.configDigest === null))) fail()
    instance(entry.instance)
    if (entry.active && (entry.instance as Instance).uid === 0) fail()
    for (const name of ['dependencies', 'services']) {
      const services = entry[name]
      if (!Array.isArray(services) || services.length > 128) fail()
      const names = new Set<string>()
      for (const service of services) {
        exact(service, ['name', 'instance']); text(service.name)
        if (names.has(service.name) || (entry.active && service.instance === null)) fail()
        names.add(service.name); instance(service.instance)
      }
    }
  }
}

/** Reads Loader/Fiber state without importing candidates or invoking service methods. */
export function createRuntimeSampler(ctx: Context, config: RuntimeObserverConfig): (challenge: string) => RuntimeObservation {
  const observerId = randomUUID()
  const observerConfigDigest = runtimeConfigDigest(config)
  const epochs = new WeakMap<object, number>(); let nextEpoch = 0
  const instance = (fiber: Fiber | undefined): Instance | null => {
    if (!fiber || fiber.uid === null || fiber.state !== ACTIVE || fiber.inertia || !fiber.store) return null
    let epoch = epochs.get(fiber.store)
    if (epoch === undefined) { epoch = ++nextEpoch; epochs.set(fiber.store, epoch) }
    return { uid: fiber.uid, epoch }
  }
  const ownedBy = (fiber: Fiber, owner: Fiber): boolean => {
    for (let depth = 0; depth < 128; depth++) {
      if (fiber.uid !== null && fiber.uid === owner.uid) return true
      if (fiber === fiber.parent.fiber) return false
      fiber = fiber.parent.fiber
    }
    return false
  }
  return challenge => {
    text(challenge, HEX)
    if (ctx.fiber.uid === null || ctx.fiber.state !== ACTIVE) fail()
    // Resolve the current injected provider on every sample, never cache a proxy.
    const loader: Loader = ctx.loader
    const entries = config.targets.map(target => {
      let entry: ReturnType<Loader['resolve']>
      try { entry = loader.resolve(target.entryId) } catch {
        return { entryId: target.entryId, module: null, configDigest: null, active: false, instance: null, dependencies: [], services: [] }
      }
      const fiber = entry.fiber
      const current = instance(fiber)
      const options = Object.getOwnPropertyDescriptors(entry.options)
      if (!options.name || !('value' in options.name) || typeof options.name.value !== 'string'
        || (options.config && !('value' in options.config)) || (options.disabled && !('value' in options.disabled))) fail()
      const module = options.name.value as string
      const configDigest = runtimeConfigDigest(options.config?.value ?? null)
      const dependencies = Object.keys(fiber?.inject ?? {}).sort().map(name => ({ name, instance: instance(fiber?.store?.[name]?.fiber) }))
      const services = target.services.map(name => {
        const realm = fiber?.ctx[Context.isolate][name]
        const impl = realm ? fiber?.ctx.reflect.store[realm] : undefined
        return { name, instance: impl && fiber && ownedBy(impl.fiber, fiber) && fiber.ctx.get(name) !== undefined ? instance(impl.fiber) : null }
      })
      return { entryId: entry.id, module, configDigest,
        active: !entry.disabled && module === target.module && configDigest === target.configDigest
          && current !== null && current.uid > 0 && dependencies.every(item => item.instance !== null) && services.every(item => item.instance !== null),
        instance: current, dependencies, services }
    })
    const observation: RuntimeObservation = { schemaVersion: 1, kind: 'dsh-runtime-observation', observerId, observerConfigDigest, challenge,
      processId: process.pid, invocationId: /^[a-f0-9]{32}$/u.test(process.env.INVOCATION_ID ?? '') ? process.env.INVOCATION_ID! : null,
      profilePath: config.profilePath, observedAt: Date.now(), entries }
    assertObservation(observation)
    return observation
  }
}

/** One bounded request/response per connection; resources belong to this Fiber. */
export function installRuntimeObserver(ctx: Context, input: RuntimeObserverConfig): void {
  validateRuntimeObserverConfig(input)
  const config = structuredClone(input)
  ctx.inject(['loader'], observerCtx => {
    observerCtx.effect(async () => {
      const key = privateKey(config.keyPath)
      const sample = createRuntimeSampler(observerCtx, config)
      const sockets = new Set<Socket>()
      let closing = false
      let identity: Awaited<ReturnType<typeof lstat>> | undefined
      const server = createServer({ allowHalfOpen: true }, socket => {
        if (closing || sockets.size >= 8) { socket.destroy(); return }
        sockets.add(socket)
        const deadline = setTimeout(() => socket.destroy(), TIMEOUT)
        socket.setTimeout(TIMEOUT, () => socket.destroy())
        socket.on('error', () => socket.destroy())
        socket.once('close', () => { clearTimeout(deadline); sockets.delete(socket) })
        let bytes = Buffer.alloc(0); let received = false
        socket.on('data', chunk => {
          if (received || bytes.length + chunk.length > 1024) { socket.destroy(); return }
          bytes = Buffer.concat([bytes, chunk])
          if (!bytes.includes(10)) return
          received = true
          try {
            if (bytes.at(-1) !== 10 || bytes.subarray(0, -1).includes(10)) fail()
            const request: unknown = JSON.parse(bytes.toString('utf8'))
            exact(request, ['schemaVersion', 'challenge', 'mac'])
            if (request.schemaVersion !== 1) fail()
            text(request.challenge, HEX)
            if (!equalMac(request.mac, mac(key, 'dsh-runtime-request/v1', request.challenge))) fail()
            const observation = sample(request.challenge)
            const response = JSON.stringify({ observation, mac: mac(key, 'dsh-runtime-response/v1', observation) }) + '\n'
            if (Buffer.byteLength(response) > MAX_BYTES) fail()
            socket.end(response)
          } catch { socket.destroy() }
        })
      })
      server.maxConnections = 8
      let closeTask: Promise<void> | undefined
      const close = (): Promise<void> => closeTask ??= (async () => {
        closing = true
        for (const socket of sockets) socket.destroy()
        try {
          if (server.listening) await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
          if (identity) {
            try {
              const current = await lstat(config.socketPath)
              if (current.ino === identity.ino && current.dev === identity.dev && current.isSocket()) await unlink(config.socketPath)
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          }
        } finally { key.fill(0) }
      })()
      try {
        // Never remove an existing socket, including an unknown stale one.
        await new Promise<void>((resolveListen, reject) => {
          server.once('error', reject)
          server.listen(config.socketPath, () => { server.off('error', reject); resolveListen() })
        })
        identity = await lstat(config.socketPath)
        await chmod(config.socketPath, 0o600)
        server.on('error', () => { void close().catch(() => observerCtx.logger.error('runtime observer teardown failed')) })
        return close
      } catch (error) { await close(); throw error }
    }, 'plugin-control-plane.runtime-observer')
  })
}

/** Owner caller supplies no claimed state; fresh challenge authenticates the observed response. */
export async function queryRuntimeObserver(input: { socketPath: string; keyPath: string; signal?: AbortSignal }): Promise<RuntimeObservation> {
  if (process.platform !== 'linux') fail()
  privateDirectory(dirname(input.socketPath))
  const before = lstatSync(input.socketPath)
  if (!before.isSocket() || before.uid !== process.getuid!() || (before.mode & 0o077) !== 0 || realpathSync(input.socketPath) !== input.socketPath) fail()
  const key = privateKey(input.keyPath)
  const challenge = randomBytes(32).toString('hex')
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(TIMEOUT)]) : AbortSignal.timeout(TIMEOUT)
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
        socket.end(JSON.stringify({ schemaVersion: 1, challenge, mac: mac(key, 'dsh-runtime-request/v1', challenge) }) + '\n')
      })
      socket.on('data', chunk => {
        size += chunk.length
        if (size > MAX_BYTES) { finish(new Error('runtime observer response exceeds limit')); return }
        chunks.push(chunk)
      })
      socket.once('end', () => {
        try {
          const bytes = Buffer.concat(chunks)
          if (bytes.at(-1) !== 10 || bytes.subarray(0, -1).includes(10)) fail()
          const response: unknown = JSON.parse(bytes.toString('utf8'))
          exact(response, ['observation', 'mac'])
          if (!equalMac(response.mac, mac(key, 'dsh-runtime-response/v1', response.observation))) fail()
          const observation = response.observation
          assertObservation(observation)
          if (observation.challenge !== challenge) fail()
          const after = lstatSync(input.socketPath)
          if (before.ino !== after.ino || before.dev !== after.dev || !after.isSocket() || after.uid !== before.uid || (after.mode & 0o077) !== 0) fail()
          finish(undefined, observation)
        } catch { finish(new Error('runtime observer response rejected')) }
      })
      socket.once('close', () => { if (!settled) finish(new Error('runtime observer connection closed before response')) })
    })
  } finally { key.fill(0) }
}
