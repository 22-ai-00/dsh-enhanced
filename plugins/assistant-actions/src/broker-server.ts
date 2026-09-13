import { createPublicKey, KeyObject, randomUUID } from 'node:crypto'
import { chmod, chown, lstat, realpath, rename, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname, isAbsolute, resolve } from 'node:path'
import {
  BrokerFrameDecoder, GITHUB_BROKER_DEFAULT_HELLO_TTL_MS, GITHUB_BROKER_REQUEST_MAX_BYTES, GITHUB_BROKER_RESPONSE_MAX_BYTES,
  createBrokerAdminResponse, createBrokerServerHello, createBrokerServerResponse, encodeBrokerFrame, verifyBrokerAdminRequest, verifyBrokerClientRequest, verifyBrokerServerHello,
  type BrokerAdminRequest, type BrokerAdminResponseUnsigned, type BrokerClientRequest, type BrokerServerHello, type BrokerServerResponseUnsigned,
} from './broker-protocol.js'

type KeyInput = KeyObject | string | Buffer
type ListenerKind = 'action' | 'admin'
type StopReason = 'sigterm' | 'sigint' | 'admin' | 'lifecycle'
type ActionResponse = Pick<BrokerServerResponseUnsigned, 'status' | 'dispatched' | 'result' | 'error' | 'completedAt'>
type AdminResponse = Pick<BrokerAdminResponseUnsigned, 'status' | 'state' | 'error' | 'completedAt'>

export interface BrokerPeerCredentials { uid: number; gid: number; pid?: number }
export type BrokerPeerCredentialInspector = (socket: Socket, signal: AbortSignal) => BrokerPeerCredentials | undefined | Promise<BrokerPeerCredentials | undefined>

export interface GitHubBrokerCorePort {
  snapshot(): { generation: number; policyEpoch: number; emergencyEpoch: number }
  execute(request: BrokerClientRequest, signal: AbortSignal): Promise<ActionResponse>
  admin(request: BrokerAdminRequest, signal: AbortSignal): Promise<AdminResponse>
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
}

export class GitHubBrokerServerError extends Error {
  readonly code: 'invalid-config' | 'unsafe-parent' | 'unsafe-socket' | 'already-running' | 'listen-failed' | 'shutdown-failed'
  constructor(code: GitHubBrokerServerError['code'], message: string, options?: ErrorOptions) {
    super(`assistant-actions broker server: ${message}`, options); this.name = 'GitHubBrokerServerError'; this.code = code
  }
}

interface FileIdentity { dev: bigint; ino: bigint; uid: bigint; gid: bigint; mode: number }
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
interface ListenerState { kind: ListenerKind; endpoint: Endpoint; server: Server; connections: Set<ConnectionState>; active: Set<Promise<void>>; owned?: FileIdentity }
interface NormalizedOptions extends GitHubBrokerServerOptions {
  action: Endpoint
  admin: Endpoint
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
const enoent = (error: unknown): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
function failure(code: GitHubBrokerServerError['code'], message: string, cause?: unknown): GitHubBrokerServerError { return new GitHubBrokerServerError(code, message, cause === undefined ? undefined : { cause }) }
function fileIdentity(stat: Awaited<ReturnType<typeof lstat>>): FileIdentity { return { dev: BigInt(stat.dev), ino: BigInt(stat.ino), uid: BigInt(stat.uid), gid: BigInt(stat.gid), mode: Number(stat.mode) & 0o7777 } }
function sameIdentity(left: FileIdentity, right: FileIdentity): boolean { return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.gid === right.gid && left.mode === right.mode }
function sameInode(left: FileIdentity, right: FileIdentity): boolean { return left.dev === right.dev && left.ino === right.ino }
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

function endpoint(path: string, uid: number, gid: number, parentMode: number, mode: number, maxConnections: number): Endpoint {
  if (!isAbsolute(path) || resolve(path) !== path || dirname(path) === path || Buffer.byteLength(path) > 100 || !integer(uid, 0, 0x7fffffff) || !integer(gid, 0, 0x7fffffff)
    || !integer(parentMode, 0, 0o777) || (parentMode & 0o022) !== 0 || !integer(mode, 0, 0o777) || (mode & 0o007) !== 0
    || !integer(maxConnections, 1, 1_024)) throw failure('invalid-config', 'socket endpoint is invalid')
  return { path, uid, gid, parentMode, mode, maxConnections }
}
function normalize(options: GitHubBrokerServerOptions): NormalizedOptions {
  const action = endpoint(options.actionSocketPath, options.expectedActionSocketUid, options.expectedActionSocketGid, options.expectedActionParentMode, options.expectedActionSocketMode, options.maxActionConnections ?? 32)
  const admin = endpoint(options.adminSocketPath, options.expectedAdminSocketUid, options.expectedAdminSocketGid, options.expectedAdminParentMode, options.expectedAdminSocketMode, options.maxAdminConnections ?? 4)
  const result: NormalizedOptions = { ...options, action, admin, maxConcurrentRequests: options.maxConcurrentRequests ?? 2, firstByteTimeoutMs: options.firstByteTimeoutMs ?? 2_000, frameTimeoutMs: options.frameTimeoutMs ?? 10_000, totalTimeoutMs: options.totalTimeoutMs ?? 30_000, helloTtlMs: options.helloTtlMs ?? GITHUB_BROKER_DEFAULT_HELLO_TTL_MS, staleProbeTimeoutMs: options.staleProbeTimeoutMs ?? 500, drainTimeoutMs: options.drainTimeoutMs ?? 10_000, now: options.now ?? Date.now }
  let signingKeysValid = false, sameSigningKey = true
  try {
    const server = publicKey(result.serverPrivateKey), client = publicKey(result.clientPublicKey), admin = publicKey(result.adminPublicKey)
    signingKeysValid = server.asymmetricKeyType === 'ed25519' && client.asymmetricKeyType === 'ed25519' && admin.asymmetricKeyType === 'ed25519'
    sameSigningKey = client.equals(admin) || server.equals(client) || server.equals(admin)
  } catch { /* rejected below without binding */ }
  if (action.path === admin.path || !result.instanceId || result.instanceId.length > 128 || !result.clientKeyId || result.clientKeyId.length > 128 || !result.adminKeyId || result.adminKeyId.length > 128
    || result.clientKeyId === result.adminKeyId || !signingKeysValid || sameSigningKey
    || !integer(result.generation, 1, Number.MAX_SAFE_INTEGER) || typeof result.inspectPeerCredentials !== 'function' || typeof result.core?.snapshot !== 'function' || typeof result.core?.execute !== 'function' || typeof result.core?.admin !== 'function' || typeof result.core?.beginDrain !== 'function' || typeof result.core?.drain !== 'function' || typeof result.core?.close !== 'function'
    || !integer(result.expectedClientPeerUid, 0, 0x7fffffff) || !integer(result.expectedClientPeerGid, 0, 0x7fffffff) || !integer(result.expectedAdminPeerUid, 0, 0x7fffffff) || !integer(result.expectedAdminPeerGid, 0, 0x7fffffff)
    || !integer(result.maxConcurrentRequests, 1, action.maxConnections) || !integer(result.firstByteTimeoutMs, 1, 60_000) || !integer(result.frameTimeoutMs, result.firstByteTimeoutMs, 300_000)
    || !integer(result.totalTimeoutMs, result.frameTimeoutMs, 300_000) || !integer(result.helloTtlMs, 1, 300_000) || !integer(result.staleProbeTimeoutMs, 1, 10_000) || !integer(result.drainTimeoutMs, 1, 300_000)) throw failure('invalid-config', 'server options are invalid')
  return result
}

async function inspectParent(endpoint: Endpoint): Promise<FileIdentity> {
  const parent = dirname(endpoint.path)
  let cursor = parent
  for (;;) {
    const [canonicalCursor, cursorStat] = await Promise.all([realpath(cursor), lstat(cursor)])
    const mode = cursorStat.mode & 0o7777, stickyRoot = cursorStat.uid === 0 && (mode & 0o1000) !== 0 && (mode & 0o022) !== 0
    if (canonicalCursor !== cursor || cursorStat.isSymbolicLink() || !cursorStat.isDirectory() || !stickyRoot && (mode & 0o022) !== 0) throw failure('unsafe-parent', 'socket ancestor is unsafe')
    const next = dirname(cursor); if (next === cursor) break; cursor = next
  }
  let canonical: string, stat: Awaited<ReturnType<typeof lstat>>
  try { [canonical, stat] = await Promise.all([realpath(parent), lstat(parent)]) } catch (error) { throw failure('unsafe-parent', 'socket parent cannot be inspected', error) }
  if (canonical !== parent || stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== endpoint.uid || stat.gid !== endpoint.gid || (stat.mode & 0o7777) !== endpoint.parentMode) throw failure('unsafe-parent', 'socket parent type, ownership, or mode is unsafe')
  return fileIdentity(stat)
}
async function inspectSocket(endpoint: Endpoint): Promise<FileIdentity | undefined> {
  let stat: Awaited<ReturnType<typeof lstat>>
  try { stat = await lstat(endpoint.path) } catch (error) { if (enoent(error)) return undefined; throw failure('unsafe-socket', 'socket path cannot be inspected', error) }
  if (stat.isSymbolicLink() || !stat.isSocket() || stat.uid !== endpoint.uid || stat.gid !== endpoint.gid || (stat.mode & 0o7777) !== endpoint.mode) throw failure('unsafe-socket', 'socket type, ownership, or mode is unsafe')
  return fileIdentity(stat)
}
type Probe = 'active' | 'refused' | 'untrusted'
async function probe(endpoint: Endpoint, options: NormalizedOptions): Promise<Probe> {
  const publicKey = createPublicKey(options.serverPrivateKey)
  return await new Promise<Probe>(resolveProbe => {
    const decoder = new BrokerFrameDecoder(GITHUB_BROKER_RESPONSE_MAX_BYTES, 1), socket = createConnection({ path: endpoint.path })
    let settled = false
    const settle = (result: Probe): void => { if (settled) return; settled = true; clearTimeout(timeout); socket.removeAllListeners(); socket.destroy(); resolveProbe(result) }
    const timeout = timer(() => settle('untrusted'), options.staleProbeTimeoutMs)
    socket.on('data', chunk => { try { const values = decoder.push(chunk); if (values.length === 1) { verifyBrokerServerHello(values[0], publicKey, { maxTtlMs: options.helloTtlMs, expectedInstanceId: options.instanceId, minimumGeneration: 1 }); settle('active') } } catch { settle('untrusted') } })
    socket.once('error', error => settle(error && typeof error === 'object' && 'code' in error && error.code === 'ECONNREFUSED' ? 'refused' : 'untrusted'))
    socket.once('end', () => settle('untrusted'))
  })
}
async function removeStale(endpoint: Endpoint, options: NormalizedOptions, before: FileIdentity): Promise<void> {
  const result = await probe(endpoint, options)
  if (result === 'active') throw failure('already-running', 'an authenticated broker is already listening')
  if (result !== 'refused') throw failure('unsafe-socket', 'existing socket cannot be authenticated or proven stale')
  const after = await inspectSocket(endpoint)
  if (!after || !sameIdentity(before, after)) throw failure('unsafe-socket', 'socket changed during stale inspection')
  await unlink(endpoint.path).catch(error => { throw failure('unsafe-socket', 'stale socket cannot be removed', error) })
}
async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => { const onError = (error: Error): void => { server.off('listening', onListen); rejectListen(error) }; const onListen = (): void => { server.off('error', onError); resolveListen() }; server.once('error', onError); server.once('listening', onListen); server.listen(path) })
}
async function closeServer(server: Server, deadlineAt: number, now: () => number): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolveClose, rejectClose) => {
    const timeout = timer(() => rejectClose(failure('shutdown-failed', 'listener close deadline exceeded')), Math.max(1, deadlineAt - now()))
    server.close(error => { clearTimeout(timeout); if (error) rejectClose(error); else resolveClose() })
  })
}
async function closeOwned(listener: ListenerState, deadlineAt: number, now: () => number): Promise<void> {
  if (!listener.owned) { await closeServer(listener.server, deadlineAt, now); return }
  const parked = `${listener.endpoint.path}.replacement-${randomUUID()}`
  let parkedIdentity: FileIdentity | undefined
  let parkedExists = false
  let problem: unknown
  try {
    try { await rename(listener.endpoint.path, parked); parkedExists = true } catch (error) { if (!enoent(error)) throw error }
    const stat = await lstat(parked).catch(error => enoent(error) ? undefined : Promise.reject(error))
    if (stat) {
      parkedIdentity = fileIdentity(stat)
      if (!sameInode(parkedIdentity, listener.owned) && (stat.isSymbolicLink() || !stat.isSocket() || stat.uid !== listener.endpoint.uid || stat.gid !== listener.endpoint.gid || (stat.mode & 0o7777) !== listener.endpoint.mode)) throw failure('shutdown-failed', 'parked socket is unsafe')
    }
  } catch (error) { problem = error }
  try { await closeServer(listener.server, deadlineAt, now) } catch (error) { problem ??= error }
  try {
    if (parkedIdentity && sameInode(parkedIdentity, listener.owned)) await unlink(parked)
    else if (parkedIdentity) {
      if (await lstat(listener.endpoint.path).then(() => true, error => enoent(error) ? false : Promise.reject(error)) || !sameIdentity(parkedIdentity, fileIdentity(await lstat(parked)))) throw failure('shutdown-failed', 'replacement socket cannot be restored')
      await rename(parked, listener.endpoint.path)
      if (!sameIdentity(parkedIdentity, fileIdentity(await lstat(listener.endpoint.path)))) throw failure('shutdown-failed', 'replacement socket changed')
    }
  } catch (error) { problem ??= error }
  if (problem !== undefined) {
    if (parkedExists && parkedIdentity && sameInode(parkedIdentity, listener.owned)) await unlink(parked).catch(() => undefined)
    else if (parkedExists) {
      const destinationMissing = await lstat(listener.endpoint.path).then(() => false, error => enoent(error))
      if (destinationMissing) await rename(parked, listener.endpoint.path).catch(() => undefined)
    }
    if (problem instanceof GitHubBrokerServerError) throw problem
    throw failure('shutdown-failed', 'socket preservation failed', problem)
  }
}
async function unlinkOwned(listener: ListenerState): Promise<void> {
  if (!listener.owned) return
  const current = await inspectSocket(listener.endpoint).catch(() => undefined)
  if (current && sameIdentity(current, listener.owned) && await inspectParent(listener.endpoint).catch(() => undefined)) await unlink(listener.endpoint.path).catch(() => undefined)
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
  #listener(kind: ListenerKind, endpoint: Endpoint): ListenerState {
    const listener = { kind, endpoint, server: undefined as unknown as Server, connections: new Set<ConnectionState>(), active: new Set<Promise<void>>() }
    listener.server = createServer(socket => this.#accept(listener, socket)); listener.server.maxConnections = endpoint.maxConnections
    return listener
  }
  static async start(raw: GitHubBrokerServerOptions): Promise<GitHubBrokerServer> {
    const options = normalize(raw), instance = new GitHubBrokerServer(options)
    try { await instance.#bind(instance.#action); await instance.#bind(instance.#admin); instance.#accepting = true; return instance }
    catch (error) { const deadlineAt = options.now() + options.drainTimeoutMs; await Promise.allSettled([closeOwned(instance.#action, deadlineAt, options.now), closeOwned(instance.#admin, deadlineAt, options.now)]); await Promise.allSettled([unlinkOwned(instance.#action), unlinkOwned(instance.#admin)]); if (error instanceof GitHubBrokerServerError) throw error; throw failure('listen-failed', 'Unix socket bind failed', error) }
  }
  async #bind(listener: ListenerState): Promise<void> {
    const before = await inspectParent(listener.endpoint), existing = await inspectSocket(listener.endpoint)
    if (existing) await removeStale(listener.endpoint, this.#options, existing)
    const after = await inspectParent(listener.endpoint); if (!sameIdentity(before, after)) throw failure('unsafe-parent', 'socket parent changed during startup')
    await listen(listener.server, listener.endpoint.path)
    const provisional = await lstat(listener.endpoint.path)
    if (provisional.isSymbolicLink() || !provisional.isSocket()) throw failure('unsafe-socket', 'newly bound path is not a socket')
    listener.owned = fileIdentity(provisional)
    await chown(listener.endpoint.path, listener.endpoint.uid, listener.endpoint.gid)
    await chmod(listener.endpoint.path, listener.endpoint.mode)
    const socket = await inspectSocket(listener.endpoint), finalParent = await inspectParent(listener.endpoint)
    if (!socket || !sameIdentity(after, finalParent)) throw failure('unsafe-socket', 'bound socket identity could not be verified')
    if (!sameInode(listener.owned, socket)) throw failure('unsafe-socket', 'bound socket inode changed during startup')
    listener.owned = socket
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
      if (!peer || !integer(peer.uid, 0, 0x7fffffff) || !integer(peer.gid, 0, 0x7fffffff) || peer.pid !== undefined && !integer(peer.pid, 1, 0x7fffffff)) return destroy(state, 'peer credentials rejected')
      const expectedUid = kind === 'action' ? this.#options.expectedClientPeerUid : this.#options.expectedAdminPeerUid
      const expectedGid = kind === 'action' ? this.#options.expectedClientPeerGid : this.#options.expectedAdminPeerGid
      if (peer.uid !== expectedUid || peer.gid !== expectedGid) return destroy(state, 'peer role rejected')
      const now = this.#options.now(), snapshot = this.#options.core.snapshot()
      if (!integer(snapshot.generation, 1, Number.MAX_SAFE_INTEGER) || snapshot.generation !== this.#options.generation || !integer(snapshot.policyEpoch, 0, Number.MAX_SAFE_INTEGER) || !integer(snapshot.emergencyEpoch, 0, Number.MAX_SAFE_INTEGER)) return destroy(state, 'core snapshot rejected')
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
  async #read<T>(state: ConnectionState, verify: (value: unknown) => T): Promise<T | undefined> {
    const decoder = new BrokerFrameDecoder(GITHUB_BROKER_REQUEST_MAX_BYTES, 1)
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
  async #end(state: ConnectionState, frame: Buffer): Promise<void> { await new Promise<void>((resolveWrite, rejectWrite) => { state.socket.once('error', rejectWrite); state.socket.end(frame, () => { state.socket.off('error', rejectWrite); resolveWrite() }) }); state.settled = true }
  stop(reason: StopReason = 'lifecycle', timeoutMs = this.#options.drainTimeoutMs): Promise<void> { if (this.#stopping) return this.#stopping; if (!integer(timeoutMs, 1, 300_000)) return Promise.reject(failure('invalid-config', 'shutdown timeout is invalid')); this.#stopping = this.#stop(reason, timeoutMs); return this.#stopping }
  async #stop(reason: StopReason, timeoutMs: number): Promise<void> {
    this.#accepting = false
    const deadlineAt = this.#options.now() + timeoutMs, listeners = [this.#action, this.#admin]
    let cause: unknown
    try { await beforeDeadline(Promise.resolve().then(() => this.#options.core.beginDrain(reason)), deadlineAt, this.#options.now, 'begin-drain deadline exceeded') } catch (error) { cause = error }
    const closing = Promise.allSettled(listeners.map(listener => closeOwned(listener, deadlineAt, this.#options.now))).then(results => { const rejected = results.find(result => result.status === 'rejected'); if (rejected?.status === 'rejected') cause ??= rejected.reason })
    for (const listener of listeners) for (const state of listener.connections) if (!state.verified) destroy(state, 'server draining')
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<'deadline'>(resolveDeadline => { deadlineTimer = timer(() => resolveDeadline('deadline'), Math.max(1, deadlineAt - this.#options.now())) })
    const activeSets = listeners.map(listener => Promise.allSettled(listener.active)); const settled = Promise.all(activeSets).then(() => 'settled' as const)
    if (await Promise.race([settled, deadline]) === 'deadline') { for (const listener of listeners) for (const state of listener.connections) destroy(state, 'drain deadline exceeded'); await Promise.all(listeners.map(listener => Promise.allSettled(listener.active))) }
    if (deadlineTimer) clearTimeout(deadlineTimer)
    for (const listener of listeners) for (const state of listener.connections) destroy(state, 'server shutdown')
    try { await beforeDeadline(Promise.resolve().then(() => this.#options.core.drain(deadlineAt)), deadlineAt, this.#options.now, 'core drain deadline exceeded') } catch (error) { cause ??= error }
    try { await beforeDeadline(closing, deadlineAt, this.#options.now, 'listener close deadline exceeded') } catch (error) { cause ??= error }
    try { await beforeDeadline(Promise.resolve().then(() => this.#options.core.close()), deadlineAt, this.#options.now, 'core close deadline exceeded') } catch (error) { cause ??= error }
    finally { await Promise.allSettled(listeners.map(unlinkOwned)) }
    if (cause !== undefined) throw failure('shutdown-failed', 'one or more shutdown barriers failed', cause)
  }
}

export async function startGitHubBrokerServer(options: GitHubBrokerServerOptions): Promise<GitHubBrokerServer> { return await GitHubBrokerServer.start(options) }
