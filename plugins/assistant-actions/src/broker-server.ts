import { createPublicKey, KeyObject } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import {
  BrokerFrameDecoder, GITHUB_BROKER_DEFAULT_HELLO_TTL_MS, GITHUB_BROKER_REQUEST_MAX_BYTES, GITHUB_BROKER_RESPONSE_MAX_BYTES,
  createBrokerAdminResponse, createBrokerServerHello, createBrokerServerResponse, encodeBrokerFrame, verifyBrokerAdminRequest, verifyBrokerClientRequest, verifyBrokerServerHello,
  type BrokerAdminRequest, type BrokerAdminResponseUnsigned, type BrokerClientRequest, type BrokerServerHello, type BrokerServerResponseUnsigned,
} from './broker-protocol.js'
import {
  ACTION_BROKER_REQUEST_MAX_BYTES,
  ACTION_BROKER_RESPONSE_MAX_BYTES,
  createActionBrokerAdminResponse,
  createActionBrokerServerHello,
  createActionBrokerServerResponse,
  verifyActionBrokerAdminRequest,
  verifyActionBrokerClientRequest,
  verifyActionBrokerServerHello,
  type ActionBrokerAdminRequest,
  type ActionBrokerClientRequest,
  type ActionBrokerServerHello,
  type ActionBrokerServerResponseUnsigned,
} from './broker-protocol-v2.js'
import {
  BrokerTransportError,
  createBrokerTransportAdapter,
  createPosixUdsTransportAdapter,
  matchesPeerIdentity,
  type BrokerPlatform,
  type BrokerTransportAdapter,
} from './broker-transport.js'

type KeyInput = KeyObject | string | Buffer
type ListenerKind = 'action' | 'admin'
type StopReason = 'sigterm' | 'sigint' | 'admin' | 'lifecycle'
type ActionResponse = Pick<BrokerServerResponseUnsigned, 'status' | 'dispatched' | 'result' | 'error' | 'completedAt'>
type ActionV2Response = Pick<ActionBrokerServerResponseUnsigned, 'status' | 'dispatched' | 'result' | 'error' | 'completedAt'>
type AdminResponse = Pick<BrokerAdminResponseUnsigned, 'status' | 'state' | 'error' | 'completedAt'>

export interface BrokerPeerCredentials { uid: number; gid: number; pid?: number; sid?: string }
export type BrokerPeerCredentialInspector = (socket: Socket, signal: AbortSignal) => BrokerPeerCredentials | undefined | Promise<BrokerPeerCredentials | undefined>

export interface GitHubBrokerCorePort {
  snapshot(): { generation: number; policyEpoch: number; emergencyEpoch: number }
  execute(request: BrokerClientRequest, signal: AbortSignal): Promise<ActionResponse>
  executeAction?(request: BrokerClientRequest | ActionBrokerClientRequest, signal: AbortSignal): Promise<ActionV2Response>
  admin(request: BrokerAdminRequest | ActionBrokerAdminRequest, signal: AbortSignal): Promise<AdminResponse>
  beginDrain(reason: StopReason): void | Promise<void>
  drain(deadlineAt: number): Promise<void>
  close(): void | Promise<void>
}

export interface GitHubBrokerServerOptions {
  actionSocketPath: string
  adminSocketPath: string
  instanceId: string
  generation: number
  serverPrivateKey: KeyInput
  clientPublicKey: KeyInput
  clientKeyId: string
  adminPublicKey: KeyInput
  adminKeyId: string
  core: GitHubBrokerCorePort
  inspectPeerCredentials: BrokerPeerCredentialInspector
  expectedClientPeerUid: number
  expectedClientPeerGid: number
  expectedAdminPeerUid: number
  expectedAdminPeerGid: number
  expectedClientPeerSid?: string
  expectedAdminPeerSid?: string
  expectedActionSocketUid: number
  expectedActionSocketGid: number
  expectedActionParentMode: number
  expectedActionSocketMode: number
  expectedAdminSocketUid: number
  expectedAdminSocketGid: number
  expectedAdminParentMode: number
  expectedAdminSocketMode: number
  maxActionConnections?: number
  maxAdminConnections?: number
  maxConcurrentRequests?: number
  firstByteTimeoutMs?: number
  frameTimeoutMs?: number
  totalTimeoutMs?: number
  helloTtlMs?: number
  staleProbeTimeoutMs?: number
  drainTimeoutMs?: number
  now?: () => number
  platform?: BrokerPlatform
  transport?: BrokerTransportAdapter
  protocolMode?: 'github-v1' | 'action-v2'
}

export class GitHubBrokerServerError extends Error {
  readonly code: 'invalid-config' | 'unsafe-parent' | 'unsafe-socket' | 'already-running' | 'listen-failed' | 'shutdown-failed'
  constructor(code: GitHubBrokerServerError['code'], message: string, options?: ErrorOptions) {
    super(`assistant-actions broker server: ${message}`, options); this.name = 'GitHubBrokerServerError'; this.code = code
  }
}

interface Endpoint { path: string; uid: number; gid: number; parentMode: number; mode: number; maxConnections: number }
interface ConnectionState {
  socket: Socket
  controller: AbortController
  verified: boolean
  settled: boolean
  firstByteTimer?: ReturnType<typeof setTimeout>
  frameTimer?: ReturnType<typeof setTimeout>
  totalTimer: ReturnType<typeof setTimeout>
}
interface ListenerState { kind: ListenerKind; endpoint: Endpoint; server: Server; connections: Set<ConnectionState>; active: Set<Promise<void>>; owned?: unknown }
interface NormalizedOptions extends GitHubBrokerServerOptions {
  action: Endpoint
  admin: Endpoint
  transportAdapter: BrokerTransportAdapter
  protocolMode: 'github-v1' | 'action-v2'
  maxConcurrentRequests: number
  firstByteTimeoutMs: number
  frameTimeoutMs: number
  totalTimeoutMs: number
  helloTtlMs: number
  staleProbeTimeoutMs: number
  drainTimeoutMs: number
  now: () => number
}

const SAFE_CORE_CODES = new Set(['aborted', 'broker-busy', 'broker-draining', 'credential-unavailable', 'deadline-exceeded', 'grant-expired', 'grant-invalid', 'grant-revoked', 'identity-mismatch', 'internal-error', 'policy-changed', 'request-conflict', 'request-invalid', 'target-mismatch', 'transport-failed', 'unsupported-operation'])
const integer = (value: unknown, minimum: number, maximum: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
function failure(code: GitHubBrokerServerError['code'], message: string, cause?: unknown): GitHubBrokerServerError { return new GitHubBrokerServerError(code, message, cause === undefined ? undefined : { cause }) }
function mapTransportError(error: unknown): never {
  if (error instanceof GitHubBrokerServerError) throw error
  if (error instanceof BrokerTransportError) {
    const code = error.code === 'socket-invalid' || error.code === 'socket-changed' ? 'unsafe-socket' : error.code
    throw failure(code, error.message, error)
  }
  throw error
}
function timer(callback: () => void, timeoutMs: number): ReturnType<typeof setTimeout> { const value = setTimeout(callback, timeoutMs); value.unref(); return value }
function clearTimers(state: ConnectionState): void { clearTimeout(state.totalTimer); if (state.firstByteTimer) clearTimeout(state.firstByteTimer); if (state.frameTimer) clearTimeout(state.frameTimer) }
function destroy(state: ConnectionState, reason: string): void { if (!state.controller.signal.aborted) state.controller.abort(new Error(reason)); clearTimers(state); if (!state.socket.destroyed) state.socket.destroy() }
function safeCoreError(error: unknown): { code: string; dispatched: boolean } {
  if (!error || typeof error !== 'object') return { code: 'internal-error', dispatched: false }
  return { code: 'code' in error && typeof error.code === 'string' && SAFE_CORE_CODES.has(error.code) ? error.code : 'internal-error', dispatched: 'dispatched' in error && error.dispatched === true }
}
function abortable<T>(operation: Promise<T> | T, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolveOperation, rejectOperation) => {
    const onAbort = (): void => { signal.removeEventListener('abort', onAbort); rejectOperation(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(operation).then(value => { signal.removeEventListener('abort', onAbort); resolveOperation(value) }, error => { signal.removeEventListener('abort', onAbort); rejectOperation(error) })
  })
}
async function beforeDeadline<T>(operation: Promise<T>, deadlineAt: number, now: () => number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timeout = timer(() => reject(failure('shutdown-failed', message)), Math.max(1, deadlineAt - now())) })])
  } finally { if (timeout) clearTimeout(timeout) }
}
function publicKey(value: KeyInput): KeyObject {
  if (value instanceof KeyObject && value.type === 'public') return value
  return createPublicKey(value)
}

function endpoint(
  path: string,
  uid: number,
  gid: number,
  parentMode: number,
  mode: number,
  maxConnections: number,
  adapter: BrokerTransportAdapter,
): Endpoint {
  try {
    adapter.validateEndpointPath(path)
  } catch (error) {
    mapTransportError(error)
  }
  if (!integer(uid, 0, 0x7fffffff) || !integer(gid, 0, 0x7fffffff)
    || !integer(parentMode, 0, 0o777) || (parentMode & 0o022) !== 0 || !integer(mode, 0, 0o777) || (mode & 0o007) !== 0
    || !integer(maxConnections, 1, 1_024)) throw failure('invalid-config', 'socket endpoint is invalid')
  return { path, uid, gid, parentMode, mode, maxConnections }
}

function normalize(options: GitHubBrokerServerOptions): NormalizedOptions {
  if (typeof options.inspectPeerCredentials !== 'function') throw failure('invalid-config', 'inspectPeerCredentials is required')
  let transportAdapter: BrokerTransportAdapter
  try {
    transportAdapter = options.transport ?? (options.platform !== undefined
      ? createBrokerTransportAdapter({ platform: options.platform, role: 'client', inspectPeer: options.inspectPeerCredentials })
      : createPosixUdsTransportAdapter(process.platform === 'darwin' ? 'darwin' : 'linux', options.inspectPeerCredentials))
  } catch (error) {
    throw mapTransportError(error)
  }
  const action = endpoint(options.actionSocketPath, options.expectedActionSocketUid, options.expectedActionSocketGid, options.expectedActionParentMode, options.expectedActionSocketMode, options.maxActionConnections ?? 32, transportAdapter)
  const admin = endpoint(options.adminSocketPath, options.expectedAdminSocketUid, options.expectedAdminSocketGid, options.expectedAdminParentMode, options.expectedAdminSocketMode, options.maxAdminConnections ?? 4, transportAdapter)
  const protocolMode = options.protocolMode ?? 'github-v1'
  const result: NormalizedOptions = {
    ...options,
    action,
    admin,
    transportAdapter,
    protocolMode,
    maxConcurrentRequests: options.maxConcurrentRequests ?? 2,
    firstByteTimeoutMs: options.firstByteTimeoutMs ?? 2_000,
    frameTimeoutMs: options.frameTimeoutMs ?? 10_000,
    totalTimeoutMs: options.totalTimeoutMs ?? 30_000,
    helloTtlMs: options.helloTtlMs ?? GITHUB_BROKER_DEFAULT_HELLO_TTL_MS,
    staleProbeTimeoutMs: options.staleProbeTimeoutMs ?? 500,
    drainTimeoutMs: options.drainTimeoutMs ?? 10_000,
    now: options.now ?? Date.now,
  }
  let signingKeysValid = false, sameSigningKey = true
  try {
    const server = publicKey(result.serverPrivateKey), client = publicKey(result.clientPublicKey), adminKey = publicKey(result.adminPublicKey)
    signingKeysValid = server.asymmetricKeyType === 'ed25519' && client.asymmetricKeyType === 'ed25519' && adminKey.asymmetricKeyType === 'ed25519'
    sameSigningKey = client.equals(adminKey) || server.equals(client) || server.equals(adminKey)
  } catch { /* rejected below without binding */ }
  if (action.path === admin.path || !result.instanceId || result.instanceId.length > 128 || !result.clientKeyId || result.clientKeyId.length > 128 || !result.adminKeyId || result.adminKeyId.length > 128
    || result.clientKeyId === result.adminKeyId || !signingKeysValid || sameSigningKey
    || !integer(result.generation, 1, Number.MAX_SAFE_INTEGER) || typeof result.core?.snapshot !== 'function' || typeof result.core?.execute !== 'function' || typeof result.core?.admin !== 'function' || typeof result.core?.beginDrain !== 'function' || typeof result.core?.drain !== 'function' || typeof result.core?.close !== 'function'
    || !integer(result.expectedClientPeerUid, 0, 0x7fffffff) || !integer(result.expectedClientPeerGid, 0, 0x7fffffff) || !integer(result.expectedAdminPeerUid, 0, 0x7fffffff) || !integer(result.expectedAdminPeerGid, 0, 0x7fffffff)
    || !integer(result.maxConcurrentRequests, 1, action.maxConnections) || !integer(result.firstByteTimeoutMs, 1, 60_000) || !integer(result.frameTimeoutMs, result.firstByteTimeoutMs, 300_000)
    || !integer(result.totalTimeoutMs, result.frameTimeoutMs, 300_000) || !integer(result.helloTtlMs, 1, 300_000) || !integer(result.staleProbeTimeoutMs, 1, 10_000) || !integer(result.drainTimeoutMs, 1, 300_000)) throw failure('invalid-config', 'server options are invalid')
  return result
}

type Probe = 'active' | 'refused' | 'untrusted'
async function probe(endpointSpec: Endpoint, options: NormalizedOptions): Promise<Probe> {
  const pubKey = createPublicKey(options.serverPrivateKey)
  return await new Promise<Probe>(resolveProbe => {
    const decoder = new BrokerFrameDecoder(GITHUB_BROKER_RESPONSE_MAX_BYTES, 1)
    const socket = options.transportAdapter.connect(endpointSpec.path)
    let settled = false
    const settle = (result: Probe): void => { if (settled) return; settled = true; clearTimeout(timeout); socket.removeAllListeners(); socket.destroy(); resolveProbe(result) }
    const timeout = timer(() => settle('untrusted'), options.staleProbeTimeoutMs)
    socket.on('data', chunk => {
      try {
        const values = decoder.push(chunk)
        if (values.length === 1) {
          if (options.protocolMode === 'action-v2') {
            verifyActionBrokerServerHello(values[0], pubKey, { maxTtlMs: options.helloTtlMs, expectedInstanceId: options.instanceId, minimumGeneration: 1 })
          } else {
            verifyBrokerServerHello(values[0], pubKey, { maxTtlMs: options.helloTtlMs, expectedInstanceId: options.instanceId, minimumGeneration: 1 })
          }
          settle('active')
        }
      } catch { settle('untrusted') }
    })
    socket.once('error', error => settle(error && typeof error === 'object' && 'code' in error && error.code === 'ECONNREFUSED' ? 'refused' : 'untrusted'))
    socket.once('end', () => settle('untrusted'))
  })
}

export class GitHubBrokerServer {
  readonly #options: NormalizedOptions
  readonly #action: ListenerState
  readonly #admin: ListenerState
  #accepting = false
  #concurrent = 0
  #stopping?: Promise<void>

  private constructor(options: NormalizedOptions) {
    this.#options = options
    this.#action = this.#listener('action', options.action)
    this.#admin = this.#listener('admin', options.admin)
  }
  #listener(kind: ListenerKind, ep: Endpoint): ListenerState {
    const listener: ListenerState = { kind, endpoint: ep, server: undefined as unknown as Server, connections: new Set<ConnectionState>(), active: new Set<Promise<void>>() }
    listener.server = createServer(socket => this.#accept(listener, socket)); listener.server.maxConnections = ep.maxConnections
    return listener
  }
  static async start(raw: GitHubBrokerServerOptions): Promise<GitHubBrokerServer> {
    const options = normalize(raw), instance = new GitHubBrokerServer(options)
    const adapter = options.transportAdapter
    try { await instance.#bind(instance.#action); await instance.#bind(instance.#admin); instance.#accepting = true; return instance }
    catch (error) {
      const deadlineAt = options.now() + options.drainTimeoutMs
      await Promise.allSettled([
        adapter.closeOwned(instance.#action.endpoint, instance.#action.server, instance.#action.owned, deadlineAt, options.now),
        adapter.closeOwned(instance.#admin.endpoint, instance.#admin.server, instance.#admin.owned, deadlineAt, options.now),
      ])
      await Promise.allSettled([
        adapter.unlinkOwned(instance.#action.endpoint, instance.#action.owned),
        adapter.unlinkOwned(instance.#admin.endpoint, instance.#admin.owned),
      ])
      if (error instanceof GitHubBrokerServerError) throw error
      if (error instanceof BrokerTransportError) mapTransportError(error)
      throw failure('listen-failed', 'Unix socket bind failed', error)
    }
  }
  async #bind(listener: ListenerState): Promise<void> {
    const adapter = this.#options.transportAdapter
    try {
      const before = await adapter.inspectParent(listener.endpoint)
      const existing = await adapter.inspectSocket(listener.endpoint)
      if (existing !== undefined) await adapter.removeStale(listener.endpoint, existing, () => probe(listener.endpoint, this.#options))
      const after = await adapter.inspectParent(listener.endpoint)
      if (!adapter.sameIdentity(before, after)) throw failure('unsafe-parent', 'socket parent changed during startup')
      await adapter.listen(listener.server, listener.endpoint.path)
      listener.owned = await adapter.finalizeSocket(listener.endpoint, after)
    } catch (error) {
      mapTransportError(error)
    }
  }
  get actionSocketPath(): string { return this.#action.endpoint.path }
  get adminSocketPath(): string { return this.#admin.endpoint.path }
  get accepting(): boolean { return this.#accepting }
  get activeRequests(): number { return this.#concurrent }
  #accept(listener: ListenerState, socket: Socket): void {
    if (!this.#accepting || listener.connections.size >= listener.endpoint.maxConnections) { socket.destroy(); return }
    const controller = new AbortController()
    const state: ConnectionState = { socket, controller, verified: false, settled: false, totalTimer: timer(() => destroy(state, 'total deadline exceeded'), this.#options.totalTimeoutMs) }
    listener.connections.add(state)
    const onError = (): void => { destroy(state, 'peer socket error') }
    socket.on('error', onError)
    socket.once('close', () => {
      clearTimers(state); listener.connections.delete(state); socket.off('error', onError)
      if (!state.settled && !controller.signal.aborted) controller.abort(new Error('client disconnected'))
    })
    const task = this.#serve(listener.kind, state).finally(() => listener.active.delete(task)); listener.active.add(task)
  }
  async #serve(kind: ListenerKind, state: ConnectionState): Promise<void> {
    try {
      const peer = await abortable(this.#options.inspectPeerCredentials(state.socket, state.controller.signal), state.controller.signal)
      const expectedUid = kind === 'action' ? this.#options.expectedClientPeerUid : this.#options.expectedAdminPeerUid
      const expectedGid = kind === 'action' ? this.#options.expectedClientPeerGid : this.#options.expectedAdminPeerGid
      const expectedSid = kind === 'action' ? this.#options.expectedClientPeerSid : this.#options.expectedAdminPeerSid
      if (!matchesPeerIdentity(peer, { uid: expectedUid, gid: expectedGid, ...(expectedSid === undefined ? {} : { sid: expectedSid }) }, this.#options.transportAdapter.kind)) {
        return destroy(state, 'peer credentials rejected')
      }
      const now = this.#options.now(), snapshot = this.#options.core.snapshot()
      if (!integer(snapshot.generation, 1, Number.MAX_SAFE_INTEGER) || snapshot.generation !== this.#options.generation || !integer(snapshot.policyEpoch, 0, Number.MAX_SAFE_INTEGER) || !integer(snapshot.emergencyEpoch, 0, Number.MAX_SAFE_INTEGER)) return destroy(state, 'core snapshot rejected')
      if (this.#options.protocolMode === 'action-v2') {
        const hello = createActionBrokerServerHello({ instanceId: this.#options.instanceId, generation: snapshot.generation, policyEpoch: snapshot.policyEpoch, emergencyEpoch: snapshot.emergencyEpoch, expiresAt: now + this.#options.helloTtlMs }, this.#options.serverPrivateKey)
        state.socket.write(encodeBrokerFrame(hello, ACTION_BROKER_RESPONSE_MAX_BYTES))
        if (kind === 'admin') return await this.#serveAdminV2(state, hello)
        return await this.#serveActionV2(state, hello)
      }
      const hello = createBrokerServerHello({ instanceId: this.#options.instanceId, generation: snapshot.generation, policyEpoch: snapshot.policyEpoch, emergencyEpoch: snapshot.emergencyEpoch, expiresAt: now + this.#options.helloTtlMs }, this.#options.serverPrivateKey)
      state.socket.write(encodeBrokerFrame(hello, GITHUB_BROKER_RESPONSE_MAX_BYTES))
      if (kind === 'admin') return await this.#serveAdmin(state, hello)
      await this.#serveAction(state, hello)
    } catch { destroy(state, 'request rejected') }
  }
  async #serveAction(state: ConnectionState, hello: BrokerServerHello): Promise<void> {
    const request = await this.#read(state, raw => verifyBrokerClientRequest(raw, hello, this.#options.clientPublicKey, { now: this.#options.now(), expectedClientKeyId: this.#options.clientKeyId }))
    if (!request) return; state.verified = true
    if (!this.#accepting || this.#concurrent >= this.#options.maxConcurrentRequests) return await this.#replyAction(state, request, { status: 'failed', dispatched: false, result: null, error: { code: this.#accepting ? 'broker-busy' : 'broker-draining' }, completedAt: this.#options.now() }, hello)
    this.#concurrent++
    try { await this.#replyAction(state, request, await abortable(this.#options.core.execute(request, state.controller.signal), state.controller.signal), hello) }
    catch (error) { const safe = safeCoreError(error); await this.#replyAction(state, request, { status: safe.dispatched ? 'unknown' : 'failed', dispatched: safe.dispatched, result: null, error: { code: safe.code }, completedAt: this.#options.now() }, hello) }
    finally { this.#concurrent-- }
  }
  async #serveAdmin(state: ConnectionState, hello: BrokerServerHello): Promise<void> {
    const request = await this.#read(state, raw => verifyBrokerAdminRequest(raw, hello, this.#options.adminPublicKey, { now: this.#options.now(), expectedAdminKeyId: this.#options.adminKeyId }))
    if (!request) return; state.verified = true
    try { await this.#replyAdmin(state, request, await abortable(this.#options.core.admin(request, state.controller.signal), state.controller.signal), hello) } catch { destroy(state, 'admin request rejected') }
  }
  async #serveActionV2(state: ConnectionState, hello: ActionBrokerServerHello): Promise<void> {
    const request = await this.#read(state, raw => verifyActionBrokerClientRequest(raw, hello, this.#options.clientPublicKey, { now: this.#options.now(), expectedClientKeyId: this.#options.clientKeyId }), ACTION_BROKER_REQUEST_MAX_BYTES)
    if (!request) return; state.verified = true
    if (!this.#accepting || this.#concurrent >= this.#options.maxConcurrentRequests) return await this.#replyActionV2(state, request, { status: 'failed', dispatched: false, result: null, error: { code: this.#accepting ? 'broker-busy' : 'broker-draining' }, completedAt: this.#options.now() }, hello)
    this.#concurrent++
    try {
      const exec = this.#options.core.executeAction
        ? this.#options.core.executeAction(request, state.controller.signal)
        : this.#options.core.execute(request as unknown as BrokerClientRequest, state.controller.signal) as Promise<ActionV2Response>
      await this.#replyActionV2(state, request, await abortable(exec, state.controller.signal), hello)
    } catch (error) {
      const safe = safeCoreError(error)
      await this.#replyActionV2(state, request, { status: safe.dispatched ? 'unknown' : 'failed', dispatched: safe.dispatched, result: null, error: { code: safe.code }, completedAt: this.#options.now() }, hello)
    } finally { this.#concurrent-- }
  }
  async #serveAdminV2(state: ConnectionState, hello: ActionBrokerServerHello): Promise<void> {
    const request = await this.#read(state, raw => verifyActionBrokerAdminRequest(raw, hello, this.#options.adminPublicKey, { now: this.#options.now(), expectedAdminKeyId: this.#options.adminKeyId }), ACTION_BROKER_REQUEST_MAX_BYTES)
    if (!request) return; state.verified = true
    try { await this.#replyAdminV2(state, request, await abortable(this.#options.core.admin(request, state.controller.signal), state.controller.signal), hello) } catch { destroy(state, 'admin request rejected') }
  }
  async #read<T>(state: ConnectionState, verify: (value: unknown) => T, maxBytes = GITHUB_BROKER_REQUEST_MAX_BYTES): Promise<T | undefined> {
    const decoder = new BrokerFrameDecoder(maxBytes, 1)
    return await new Promise<T | undefined>(resolveRequest => {
      let settled = false, sawByte = false
      const settle = (value?: T): void => { if (settled) return; settled = true; if (state.firstByteTimer) clearTimeout(state.firstByteTimer); if (state.frameTimer) clearTimeout(state.frameTimer); state.socket.off('data', onData); state.socket.off('end', onEnd); state.controller.signal.removeEventListener('abort', onAbort); resolveRequest(value) }
      const reject = (): void => { settle(); destroy(state, 'invalid request frame') }
      const onAbort = (): void => settle()
      const onEnd = (): void => { try { decoder.finish() } catch { /* rejected below */ } reject() }
      const onData = (chunk: Buffer): void => {
        if (!sawByte && chunk.length) { sawByte = true; if (state.firstByteTimer) clearTimeout(state.firstByteTimer); state.frameTimer = timer(reject, this.#options.frameTimeoutMs) }
        try { const values = decoder.push(chunk); if (values.length === 1) { const request = verify(values[0]); state.socket.on('data', reject); settle(request) } } catch { reject() }
      }
      state.firstByteTimer = timer(reject, this.#options.firstByteTimeoutMs); state.socket.on('data', onData); state.socket.once('end', onEnd); state.controller.signal.addEventListener('abort', onAbort, { once: true })
    })
  }
  async #replyAction(state: ConnectionState, request: BrokerClientRequest, input: ActionResponse, hello: BrokerServerHello): Promise<void> { if (!state.controller.signal.aborted && !state.socket.destroyed) await this.#end(state, encodeBrokerFrame(createBrokerServerResponse(input, request, hello, this.#options.serverPrivateKey), GITHUB_BROKER_RESPONSE_MAX_BYTES)) }
  async #replyAdmin(state: ConnectionState, request: BrokerAdminRequest, input: AdminResponse, hello: BrokerServerHello): Promise<void> { if (!state.controller.signal.aborted && !state.socket.destroyed) await this.#end(state, encodeBrokerFrame(createBrokerAdminResponse(input, request, hello, this.#options.serverPrivateKey), GITHUB_BROKER_RESPONSE_MAX_BYTES)) }
  async #replyActionV2(state: ConnectionState, request: ActionBrokerClientRequest, input: ActionV2Response, hello: ActionBrokerServerHello): Promise<void> { if (!state.controller.signal.aborted && !state.socket.destroyed) await this.#end(state, encodeBrokerFrame(createActionBrokerServerResponse(input, request, hello, this.#options.serverPrivateKey), ACTION_BROKER_RESPONSE_MAX_BYTES)) }
  async #replyAdminV2(state: ConnectionState, request: ActionBrokerAdminRequest, input: AdminResponse, hello: ActionBrokerServerHello): Promise<void> { if (!state.controller.signal.aborted && !state.socket.destroyed) await this.#end(state, encodeBrokerFrame(createActionBrokerAdminResponse(input, request, hello, this.#options.serverPrivateKey), ACTION_BROKER_RESPONSE_MAX_BYTES)) }
  async #end(state: ConnectionState, frame: Buffer): Promise<void> { await new Promise<void>((resolveWrite, rejectWrite) => { state.socket.once('error', rejectWrite); state.socket.end(frame, () => { state.socket.off('error', rejectWrite); resolveWrite() }) }); state.settled = true }
  stop(reason: StopReason = 'lifecycle', timeoutMs = this.#options.drainTimeoutMs): Promise<void> { if (this.#stopping) return this.#stopping; if (!integer(timeoutMs, 1, 300_000)) return Promise.reject(failure('invalid-config', 'shutdown timeout is invalid')); this.#stopping = this.#stop(reason, timeoutMs); return this.#stopping }
  async #stop(reason: StopReason, timeoutMs: number): Promise<void> {
    this.#accepting = false
    const deadlineAt = this.#options.now() + timeoutMs, listeners = [this.#action, this.#admin], adapter = this.#options.transportAdapter
    let cause: unknown
    try { await beforeDeadline(Promise.resolve().then(() => this.#options.core.beginDrain(reason)), deadlineAt, this.#options.now, 'begin-drain deadline exceeded') } catch (error) { cause = error }
    const closing = Promise.allSettled(listeners.map(listener => adapter.closeOwned(listener.endpoint, listener.server, listener.owned, deadlineAt, this.#options.now)))
      .then(results => { const rejected = results.find(result => result.status === 'rejected'); if (rejected?.status === 'rejected') cause ??= rejected.reason })
    for (const listener of listeners) for (const state of listener.connections) if (!state.verified) destroy(state, 'server draining')
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<'deadline'>(resolveDeadline => { deadlineTimer = timer(() => resolveDeadline('deadline'), Math.max(1, deadlineAt - this.#options.now())) })
    const activeSets = listeners.map(listener => Promise.allSettled(listener.active)); const settled = Promise.all(activeSets).then(() => 'settled' as const)
    if (await Promise.race([settled, deadline]) === 'deadline') { for (const listener of listeners) for (const state of listener.connections) destroy(state, 'drain deadline exceeded'); await Promise.all(listeners.map(listener => Promise.allSettled(listener.active))) }
    if (deadlineTimer) clearTimeout(deadlineTimer)
    for (const listener of listeners) for (const state of listener.connections) destroy(state, 'server shutdown')
    try { await beforeDeadline(Promise.resolve().then(() => this.#options.core.drain(deadlineAt)), deadlineAt, this.#options.now, 'core drain deadline exceeded') } catch (error) { cause ??= error }
    await closing
    try { await beforeDeadline(Promise.resolve().then(() => this.#options.core.close()), deadlineAt, this.#options.now, 'core close deadline exceeded') } catch (error) { cause ??= error }
    finally { await Promise.allSettled(listeners.map(listener => adapter.unlinkOwned(listener.endpoint, listener.owned))) }
    if (cause !== undefined) {
      if (cause instanceof BrokerTransportError) mapTransportError(cause)
      if (cause instanceof GitHubBrokerServerError) throw cause
      throw failure('shutdown-failed', 'one or more shutdown barriers failed', cause)
    }
  }
}

export async function startGitHubBrokerServer(options: GitHubBrokerServerOptions): Promise<GitHubBrokerServer> { return await GitHubBrokerServer.start(options) }
export { GitHubBrokerServer as BrokerServer, startGitHubBrokerServer as startBrokerServer }
