import { randomUUID } from 'node:crypto'
import { chmod, lstat, unlink } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { EffectBlockedReplayRuntime, validateReplayCases, type EffectBlockedReplayInput } from './effect-blocked-replay.js'
import { verifyReplayGrant } from './replay-grant.js'
import { ReplayJournal } from './replay-journal.js'
import { assertReplayEndpointRequest, assertReplayEndpointResponse, REPLAY_MAX_BYTES, REPLAY_REQUEST_MAX_BYTES, REPLAY_REQUEST_DOMAIN,
  REPLAY_RESPONSE_DOMAIN, replayEndpointFail, isReplaySignedAuthority, validateReplayEndpointConfig,
  type ReplayEndpointConfig, type ReplayEndpointRequest, type ReplayEndpointResponse } from './replay-endpoint-protocol.js'
import { assertRuntimeObserverExact, equalRuntimeObserverMac, readPrivateRuntimeObserverKey,
  runtimeConfigDigest, runtimeObserverMac } from './runtime-observer-protocol.js'

export { queryReplayEndpoint, validateReplayEndpointConfig, type ReplayEndpointConfig, type ReplayFixedAuthority, type ReplayEndpointResponse } from './replay-endpoint-protocol.js'
export * from './replay-grant.js'

/** Opt-in mutation endpoint: a single immutable owner operation, never a model tool. */
export function installReplayEndpoint(ctx: Context, input: ReplayEndpointConfig): void {
  validateReplayEndpointConfig(input)
  const config = structuredClone(input)
  const bindingDigest = runtimeConfigDigest(config)
  const { caseDigest } = validateReplayCases(config.authority.cases)
  ctx.inject(['tools', 'loader', 'assistantDelivery', 'agents'], endpointCtx => {
    endpointCtx.effect(async () => {
      const key = readPrivateRuntimeObserverKey(config.runtime.keyPath)
      let journal: ReplayJournal | undefined
      let runtime: EffectBlockedReplayRuntime | undefined
      let runtimeFiber: ReturnType<Context['plugin']> | undefined
      const lifetime = new AbortController()
      const flights = new Set<Promise<unknown>>()
      const sockets = new Set<Socket>()
      let closing = false
      let identity: Awaited<ReturnType<typeof lstat>> | undefined
      const respond = (request: ReplayEndpointRequest, authorization?: { scopeDigest: string; grantDigest: string }): ReplayEndpointResponse => {
        const row = journal!.get(request.operationId, bindingDigest, authorization)
        const result = row?.result ?? null
        const current = result !== null && runtime!.isCurrent(result)
        const response: ReplayEndpointResponse = { schemaVersion: 1, challenge: request.challenge,
          operationId: request.operationId, requestDigest: request.requestDigest,
          status: !row ? 'not-started' : !result ? 'unknown' : current ? 'completed' : 'stale',
          result: current ? result : null, observedAt: Date.now() }
        assertReplayEndpointResponse(response)
        return response
      }
      const dispatch = async (request: ReplayEndpointRequest, signal: AbortSignal): Promise<ReplayEndpointResponse> => {
        if (closing) replayEndpointFail()
        let authorization: { scopeDigest: string; grantDigest: string } | undefined
        let authorityExpiresAt = config.authority.expiresAt
        if (isReplaySignedAuthority(config.authority)) {
          if (request.schemaVersion !== 2) replayEndpointFail()
          const verified = verifyReplayGrant(request.grant, config.authority, {
            endpointDigest: bindingDigest, caseDigest, profilePath: config.runtime.profilePath,
            operationId: request.operationId, requestDigest: request.requestDigest,
          }, Date.now())
          authorization = { scopeDigest: verified.scopeDigest, grantDigest: verified.grantDigest }
          authorityExpiresAt = verified.expiresAt
          if (request.action === 'execute' && (request.grant.processId !== process.pid
            || request.grant.invocationId !== (/^[a-f0-9]{32}$/u.test(process.env.INVOCATION_ID ?? '') ? process.env.INVOCATION_ID! : null))) replayEndpointFail()
        } else if (request.schemaVersion !== 1 || request.operationId !== config.authority.operationId
          || request.requestDigest !== config.authority.requestDigest || Date.now() < config.authority.notBefore
          || Date.now() >= config.authority.expiresAt) replayEndpointFail()
        if (request.action === 'query') return respond(request, authorization)
        signal.throwIfAborted()
        if (!journal!.reserve(request.operationId, bindingDigest, request.requestDigest, caseDigest, authorization)) return respond(request, authorization)
        // No failure after this durable admission may regain create/dispatch authority.
        let handle: EffectBlockedReplayInput['handle'] | undefined
        const expiresAt = Math.min(authorityExpiresAt, Date.now() + config.timeoutMs)
        // Durable admission may wait for SQLite locks/fsync past the authority window.
        // Keep its reservation unknown without running any Agent startup hook.
        if (Date.now() >= expiresAt) return respond(request, authorization)
        const executionSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, expiresAt - Date.now()))])
        try {
          handle = await endpointCtx.agents.create({
            sessionId: `effect-replay-${randomUUID()}` as Parameters<Context['agents']['create']>[0]['sessionId'],
            meta: { cwd: config.agent.cwd, agentPreset: config.agent.preset },
            agentOptions: { provider: config.agent.provider, model: config.agent.model }, signal: executionSignal,
          })
          executionSignal.throwIfAborted()
          const result = await runtime!.run({ handle, operationId: request.operationId, requestDigest: request.requestDigest,
            cases: config.authority.cases, expiresAt, signal: executionSignal })
          if (result.caseDigest !== caseDigest || !runtime!.isCurrent(result)) replayEndpointFail()
          journal!.complete(request.operationId, bindingDigest, result)
        } catch {
          // Interrupted, cancelled and failed runs remain unresolved, never a passing receipt.
        } finally {
          // Native handles memoize disposal. Also reclaim if validation rejected before handoff.
          if (handle) await handle.dispose()
        }
        return respond(request, authorization)
      }
      const server = createServer({ allowHalfOpen: true }, socket => {
        if (closing || sockets.size >= 8) { socket.destroy(); return }
        sockets.add(socket)
        const disconnected = new AbortController()
        const deadline = setTimeout(() => socket.destroy(), config.timeoutMs + 1000)
        socket.on('error', () => socket.destroy())
        socket.once('close', () => { clearTimeout(deadline); disconnected.abort(); sockets.delete(socket) })
        let bytes = Buffer.alloc(0), received = false
        socket.on('data', chunk => {
          if (received || bytes.length + chunk.length > REPLAY_REQUEST_MAX_BYTES) { socket.destroy(); return }
          bytes = Buffer.concat([bytes, chunk])
          if (!bytes.includes(10)) return
          received = true
          try {
            if (bytes.at(-1) !== 10 || bytes.subarray(0, -1).includes(10)) replayEndpointFail()
            const envelope: unknown = JSON.parse(bytes.toString('utf8'))
            assertRuntimeObserverExact(envelope, ['request', 'mac'])
            assertReplayEndpointRequest(envelope.request)
            if (!equalRuntimeObserverMac(envelope.mac, runtimeObserverMac(key, REPLAY_REQUEST_DOMAIN, envelope.request))) replayEndpointFail()
            const flight = dispatch(envelope.request, AbortSignal.any([lifetime.signal, disconnected.signal])).then(response => {
              const payload = JSON.stringify({ response, mac: runtimeObserverMac(key, REPLAY_RESPONSE_DOMAIN, response) }) + '\n'
              if (Buffer.byteLength(payload) > REPLAY_MAX_BYTES) replayEndpointFail()
              if (!closing && !socket.destroyed) socket.end(payload)
            }).catch(() => socket.destroy())
            flights.add(flight)
            void flight.finally(() => flights.delete(flight)).catch(() => {})
          } catch { socket.destroy() }
        })
      })
      server.maxConnections = 8
      let closeTask: Promise<void> | undefined
      const close = (): Promise<void> => closeTask ??= (async () => {
        closing = true; lifetime.abort()
        for (const socket of sockets) socket.destroy()
        const stopped = server.listening
          ? new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
          : Promise.resolve()
        try {
          await Promise.allSettled(flights)
          await runtimeFiber?.dispose()
          await stopped
          if (identity) {
            try {
              const current = await lstat(config.runtime.socketPath)
              if (current.dev === identity.dev && current.ino === identity.ino && current.isSocket()) await unlink(config.runtime.socketPath)
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          }
        } finally { journal?.close(); key.fill(0) }
      })()
      try {
        journal = new ReplayJournal(config.journalPath)
        runtimeFiber = endpointCtx.plugin({ name: 'effect-replay-endpoint-runtime', apply(owner) { runtime = new EffectBlockedReplayRuntime(owner, config.runtime) } })
        await runtimeFiber
        if (!runtime) replayEndpointFail()
        await new Promise<void>((resolveListen, reject) => {
          server.once('error', reject)
          server.listen(config.runtime.socketPath, () => { server.off('error', reject); resolveListen() })
        })
        identity = await lstat(config.runtime.socketPath)
        await chmod(config.runtime.socketPath, 0o600)
        server.on('error', () => { void close().catch(() => endpointCtx.logger.error('replay endpoint teardown failed')) })
        return close
      } catch (error) { await close(); throw error }
    }, 'plugin-control-plane.replay-endpoint')
  })
}
