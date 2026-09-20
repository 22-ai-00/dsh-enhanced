import { randomUUID } from 'node:crypto'
import { chmod, lstat, unlink } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { Loader } from '@deepseek-ai/cordis-plugin-loader'
import {
  RUNTIME_OBSERVER_MAX_BYTES,
  RUNTIME_OBSERVER_TIMEOUT,
  assertRuntimeObservation,
  assertRuntimeObserverExact,
  assertRuntimeObserverText,
  equalRuntimeObserverMac,
  readPrivateRuntimeObserverKey,
  runtimeConfigDigest,
  runtimeObserverFail,
  runtimeObserverMac,
  validateRuntimeObserverConfig,
  type RuntimeObservation,
  type RuntimeObserverConfig,
  type RuntimeObserverInstance,
} from './runtime-observer-protocol.js'
export {
  queryRuntimeObserver,
  runtimeConfigDigest,
  validateRuntimeObserverConfig,
  type RuntimeEntryObservation,
  type RuntimeObservation,
  type RuntimeObserverConfig,
  type RuntimeObserverTarget,
} from './runtime-observer-protocol.js'

// Cordis 4.0.2 exports this as an ambient const enum, unavailable at runtime.
const ACTIVE = 2

/** Reads Loader/Fiber state without importing candidates or invoking service methods. */
export function createRuntimeSampler(ctx: Context, config: RuntimeObserverConfig): (challenge: string) => RuntimeObservation {
  const observerId = randomUUID()
  const observerConfigDigest = runtimeConfigDigest(config)
  const epochs = new WeakMap<object, number>(); let nextEpoch = 0
  const instance = (fiber: Fiber | undefined): RuntimeObserverInstance | null => {
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
    assertRuntimeObserverText(challenge, /^[a-f0-9]{64}$/u)
    if (ctx.fiber.uid === null || ctx.fiber.state !== ACTIVE) runtimeObserverFail()
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
        || (options.config && !('value' in options.config)) || (options.disabled && !('value' in options.disabled))) runtimeObserverFail()
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
    assertRuntimeObservation(observation)
    return observation
  }
}

/** One bounded request/response per connection; resources belong to this Fiber. */
export function installRuntimeObserver(ctx: Context, input: RuntimeObserverConfig): void {
  validateRuntimeObserverConfig(input)
  const config = structuredClone(input)
  ctx.inject(['loader'], observerCtx => {
    observerCtx.effect(async () => {
      const key = readPrivateRuntimeObserverKey(config.keyPath)
      const sample = createRuntimeSampler(observerCtx, config)
      const sockets = new Set<Socket>()
      let closing = false
      let identity: Awaited<ReturnType<typeof lstat>> | undefined
      const server = createServer({ allowHalfOpen: true }, socket => {
        if (closing || sockets.size >= 8) { socket.destroy(); return }
        sockets.add(socket)
        const deadline = setTimeout(() => socket.destroy(), RUNTIME_OBSERVER_TIMEOUT)
        socket.setTimeout(RUNTIME_OBSERVER_TIMEOUT, () => socket.destroy())
        socket.on('error', () => socket.destroy())
        socket.once('close', () => { clearTimeout(deadline); sockets.delete(socket) })
        let bytes = Buffer.alloc(0); let received = false
        socket.on('data', chunk => {
          if (received || bytes.length + chunk.length > 1024) { socket.destroy(); return }
          bytes = Buffer.concat([bytes, chunk])
          if (!bytes.includes(10)) return
          received = true
          try {
            if (bytes.at(-1) !== 10 || bytes.subarray(0, -1).includes(10)) runtimeObserverFail()
            const request: unknown = JSON.parse(bytes.toString('utf8'))
            assertRuntimeObserverExact(request, ['schemaVersion', 'challenge', 'mac'])
            if (request.schemaVersion !== 1) runtimeObserverFail()
            assertRuntimeObserverText(request.challenge, /^[a-f0-9]{64}$/u)
            if (!equalRuntimeObserverMac(request.mac, runtimeObserverMac(key, 'dsh-runtime-request/v1', request.challenge))) runtimeObserverFail()
            const observation = sample(request.challenge)
            const response = JSON.stringify({ observation, mac: runtimeObserverMac(key, 'dsh-runtime-response/v1', observation) }) + '\n'
            if (Buffer.byteLength(response) > RUNTIME_OBSERVER_MAX_BYTES) runtimeObserverFail()
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
