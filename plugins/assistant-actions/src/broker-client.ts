import { lstat, realpath } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { KeyObject } from 'node:crypto'
import { inspectLinuxPeerCredentials } from './broker-peer-linux.js'
import {
  BrokerFrameDecoder, BrokerProtocolError, GITHUB_BROKER_DEFAULT_HELLO_TTL_MS, GITHUB_BROKER_REQUEST_MAX_BYTES, GITHUB_BROKER_RESPONSE_MAX_BYTES,
  createBrokerAdminRequest, createBrokerClientRequest, encodeBrokerFrame, verifyBrokerAdminResponse, verifyBrokerServerHello, verifyBrokerServerResponse,
  type BrokerAdminEndpoint, type BrokerAdminIntent, type BrokerAdminResponse, type BrokerClientRequest, type BrokerEndpoint, type BrokerRequestIntent, type BrokerServerHello, type BrokerServerResponse,
} from './broker-protocol.js'

type KeyInput = KeyObject | string | Buffer
export type BrokerDispatchState = 'not-dispatched' | 'post-dispatch-unknown'
export type BrokerClientErrorCode = 'invalid-config' | 'socket-invalid' | 'socket-changed' | 'connect-failed' | 'timeout' | 'aborted' | 'authorization-rejected' | 'disconnected' | 'protocol-error'

export class BrokerClientError extends Error {
  readonly code: BrokerClientErrorCode
  readonly dispatchState: BrokerDispatchState
  readonly retryable = false
  constructor(code: BrokerClientErrorCode, dispatchState: BrokerDispatchState, message: string, options?: ErrorOptions) {
    super(`assistant-actions broker client: ${message}`, options)
    this.name = dispatchState === 'post-dispatch-unknown' ? 'BrokerPostDispatchUnknownError' : 'BrokerClientError'
    this.code = code
    this.dispatchState = dispatchState
  }
  get postDispatchUnknown(): boolean { return this.dispatchState === 'post-dispatch-unknown' }
}

export class BrokerPostDispatchUnknownError extends BrokerClientError {
  constructor(code: BrokerClientErrorCode, message: string, options?: ErrorOptions) { super(code, 'post-dispatch-unknown', message, options) }
}

export interface GitHubBrokerConnectionOptions {
  socketPath: string
  serverPublicKey: KeyInput
  timeoutMs?: number
  maxHelloTtlMs?: number
  expectedSocketUid?: number
  expectedSocketGid?: number
  expectedSocketMode?: number
  expectedSocketParentUid?: number
  expectedSocketParentGid?: number
  expectedSocketParentMode?: number
  inspectPeerCredentials?: (socket: Socket, signal: AbortSignal) => { uid: number; gid: number; pid?: number } | undefined | Promise<{ uid: number; gid: number; pid?: number } | undefined>
  expectedBrokerPeerUid: number
  expectedBrokerPeerGid: number
  expectedServerInstanceId?: string
  minimumServerGeneration?: number
}
export interface GitHubBrokerClientOptions extends GitHubBrokerConnectionOptions {
  clientPrivateKey: KeyInput
  clientKeyId: string
  source: Extract<BrokerEndpoint, { kind: 'assistant-actions-host' }>
  beforeWrite?: (hello: BrokerServerHello, request: BrokerClientRequest, signal: AbortSignal) => void | Promise<void>
}

interface SocketIdentity { dev: bigint; ino: bigint; uid: bigint; gid: bigint; mode: number; parentDev: bigint; parentIno: bigint; parentUid: bigint; parentGid: bigint; parentMode: number }

function fail(code: BrokerClientErrorCode, dispatched: boolean, message: string, cause?: unknown): BrokerClientError {
  const options = cause === undefined ? undefined : { cause }
  return dispatched ? new BrokerPostDispatchUnknownError(code, message, options) : new BrokerClientError(code, 'not-dispatched', message, options)
}
function integer(value: unknown, minimum: number, maximum: number): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum }

async function inspectSocket(options: GitHubBrokerConnectionOptions): Promise<SocketIdentity> {
  const path = options.socketPath
  if (!isAbsolute(path) || resolve(path) !== path || path === '/') throw fail('invalid-config', false, 'canonical absolute socket path required')
  const parentPath = dirname(path)
  let canonical: string, canonicalParent: string, stat: Awaited<ReturnType<typeof lstat>>, after: Awaited<ReturnType<typeof lstat>>, parent: Awaited<ReturnType<typeof lstat>>, parentAfter: Awaited<ReturnType<typeof lstat>>
  try {
    stat = await lstat(path, { bigint: true }); parent = await lstat(parentPath, { bigint: true }); canonical = await realpath(path); canonicalParent = await realpath(parentPath); after = await lstat(path, { bigint: true }); parentAfter = await lstat(parentPath, { bigint: true })
  } catch (error) { throw fail('socket-invalid', false, 'socket cannot be inspected', error) }
  if (canonical !== path || stat.isSymbolicLink() || !stat.isSocket() || after.isSymbolicLink() || !after.isSocket()
    || stat.dev !== after.dev || stat.ino !== after.ino || stat.uid !== after.uid || stat.gid !== after.gid || stat.mode !== after.mode) throw fail('socket-invalid', false, 'socket path must name one stable canonical Unix socket directly')
  const uid = BigInt(options.expectedSocketUid ?? process.getuid?.() ?? -1)
  const gid = BigInt(options.expectedSocketGid ?? process.getgid?.() ?? -1)
  const mode = options.expectedSocketMode ?? 0o600
  const parentUid = BigInt(options.expectedSocketParentUid ?? options.expectedSocketUid ?? process.getuid?.() ?? -1)
  const parentGid = BigInt(options.expectedSocketParentGid ?? options.expectedSocketGid ?? process.getgid?.() ?? -1)
  const parentMode = options.expectedSocketParentMode ?? 0o700
  if (!integer(mode, 0, 0o777) || (mode & 0o007) !== 0 || !integer(parentMode, 0, 0o777) || (parentMode & 0o022) !== 0 || stat.uid !== uid || stat.gid !== gid || Number(stat.mode & 0o7777n) !== mode
    || canonicalParent !== parentPath || !parent.isDirectory() || parent.isSymbolicLink() || !parentAfter.isDirectory() || parentAfter.isSymbolicLink()
    || parent.dev !== parentAfter.dev || parent.ino !== parentAfter.ino || parent.uid !== parentAfter.uid || parent.gid !== parentAfter.gid || parent.mode !== parentAfter.mode
    || parent.uid !== parentUid || parent.gid !== parentGid || Number(parent.mode & 0o7777n) !== parentMode) throw fail('socket-invalid', false, 'socket or parent ownership and mode do not match the pinned identity')
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: Number(stat.mode & 0o7777n), parentDev: parent.dev, parentIno: parent.ino, parentUid: parent.uid, parentGid: parent.gid, parentMode: Number(parent.mode & 0o7777n) }
}

async function assertSameSocket(options: GitHubBrokerConnectionOptions, before: SocketIdentity): Promise<void> {
  let after: SocketIdentity
  try { after = await inspectSocket(options) } catch (error) { throw fail('socket-changed', false, 'socket changed while connecting', error) }
  if (after.dev !== before.dev || after.ino !== before.ino || after.uid !== before.uid || after.gid !== before.gid || after.mode !== before.mode
    || after.parentDev !== before.parentDev || after.parentIno !== before.parentIno || after.parentUid !== before.parentUid || after.parentGid !== before.parentGid || after.parentMode !== before.parentMode) throw fail('socket-changed', false, 'socket identity changed while connecting')
}

function validateConnectionOptions(options: GitHubBrokerConnectionOptions): void {
  if (!isAbsolute(options.socketPath) || resolve(options.socketPath) !== options.socketPath || options.socketPath === '/' || options.socketPath.includes('\0') || Buffer.byteLength(options.socketPath) > 100
    || !integer(options.timeoutMs ?? 30_000, 1, 300_000) || !integer(options.maxHelloTtlMs ?? GITHUB_BROKER_DEFAULT_HELLO_TTL_MS, 1, 300_000)
    || options.expectedSocketUid !== undefined && !integer(options.expectedSocketUid, 0, 0x7fffffff)
    || options.expectedSocketGid !== undefined && !integer(options.expectedSocketGid, 0, 0x7fffffff)
    || options.expectedSocketMode !== undefined && (!integer(options.expectedSocketMode, 0, 0o777) || (options.expectedSocketMode & 0o007) !== 0)
    || options.expectedSocketParentUid !== undefined && !integer(options.expectedSocketParentUid, 0, 0x7fffffff)
    || options.expectedSocketParentGid !== undefined && !integer(options.expectedSocketParentGid, 0, 0x7fffffff)
    || options.expectedSocketParentMode !== undefined && (!integer(options.expectedSocketParentMode, 0, 0o777) || (options.expectedSocketParentMode & 0o022) !== 0)
    || options.inspectPeerCredentials !== undefined && typeof options.inspectPeerCredentials !== 'function' || !integer(options.expectedBrokerPeerUid, 0, 0x7fffffff) || !integer(options.expectedBrokerPeerGid, 0, 0x7fffffff)
    || options.expectedServerInstanceId !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.expectedServerInstanceId))
    || options.minimumServerGeneration !== undefined && !integer(options.minimumServerGeneration, 1, Number.MAX_SAFE_INTEGER)) throw fail('invalid-config', false, 'client options are invalid')
}

/**
 * Perform exactly one authenticated request on a fresh Unix-domain connection.
 * No error is retried. Once the request frame starts writing, every local
 * failure is conservatively reported as a post-dispatch unknown outcome.
 */
async function requestBroker<Request, Response>(
  options: GitHubBrokerConnectionOptions,
  deadline: number,
  makeRequest: (hello: BrokerServerHello) => Request,
  verifyResponse: (value: unknown, request: Request, hello: BrokerServerHello) => Response,
  beforeWrite: ((hello: BrokerServerHello, request: Request, signal: AbortSignal) => void | Promise<void>) | undefined,
  signal?: AbortSignal,
): Promise<Response> {
  validateConnectionOptions(options)
  if (signal?.aborted) throw fail('aborted', false, 'request was aborted before connect', signal.reason)
  const before = await inspectSocket(options)
  if (signal?.aborted) throw fail('aborted', false, 'request was aborted before connect', signal.reason)
  const decoder = new BrokerFrameDecoder(GITHUB_BROKER_RESPONSE_MAX_BYTES, 2)

  return await new Promise<Response>((resolvePromise, rejectPromise) => {
    let socket: Socket | undefined
    let settled = false, connected = false, requestStarted = false, ended = false
    let hello: BrokerServerHello | undefined, request: Request | undefined, response: Response | undefined
    const operationController = new AbortController()
    const timer = setTimeout(() => stop('timeout', 'broker request timed out'), options.timeoutMs ?? 30_000)
    timer.unref()
    const cleanup = (): void => {
      clearTimeout(timer)
      operationController.abort(new Error('broker request settled'))
      signal?.removeEventListener('abort', onAbort)
      socket?.removeAllListeners()
      if (!socket?.destroyed) socket?.destroy()
    }
    const finish = (value: Response): void => { if (!settled) { settled = true; cleanup(); resolvePromise(value) } }
    const stop = (code: BrokerClientErrorCode, message: string, cause?: unknown): void => {
      if (settled) return
      settled = true; cleanup(); rejectPromise(fail(code, requestStarted, message, cause))
    }
    const onAbort = (): void => stop('aborted', 'broker request was aborted', signal?.reason)
    const acceptHello = (value: unknown): void => {
      try {
        const verifiedHello = verifyBrokerServerHello(value, options.serverPublicKey, {
          ...(options.maxHelloTtlMs === undefined ? {} : { maxTtlMs: options.maxHelloTtlMs }),
          ...(options.expectedServerInstanceId === undefined ? {} : { expectedInstanceId: options.expectedServerInstanceId }),
          ...(options.minimumServerGeneration === undefined ? {} : { minimumGeneration: options.minimumServerGeneration }),
        })
        if (Date.now() >= deadline) throw new BrokerProtocolError('expired-request', 'request deadline expired')
          const verifiedRequest = makeRequest(verifiedHello)
        hello = verifiedHello; request = verifiedRequest
        socket!.pause()
        void runBeforeWrite(beforeWrite, verifiedHello, verifiedRequest, operationController.signal).then(() => {
          if (settled) return
          if (signal?.aborted) { stop('aborted', 'broker request was aborted before dispatch', signal.reason); return }
          if (Date.now() >= deadline || Date.now() >= verifiedHello.expiresAt) { stop('timeout', 'broker request or hello expired before dispatch'); return }
          let frame: Buffer
          try { frame = encodeBrokerFrame(verifiedRequest, GITHUB_BROKER_REQUEST_MAX_BYTES) } catch (error) { stop('protocol-error', 'broker request encoding failed', error); return }
          requestStarted = true
          try { socket!.write(frame, error => { if (error) stop('disconnected', 'request frame write failed', error) }) } catch (error) { stop('disconnected', 'request frame write failed', error); return }
          socket!.resume()
        }, error => { if (!settled) stop('authorization-rejected', 'pre-dispatch authorization changed', error) })
      } catch (error) { stop('protocol-error', 'broker message validation failed', error) }
    }
    const onData = (chunk: Buffer): void => {
      try {
        const values = decoder.push(chunk)
        if (!hello) {
          if (values.length === 0) return
          if (values.length !== 1) throw new BrokerProtocolError('trailing-data', 'broker sent data before receiving a request')
          acceptHello(values[0]); return
        }
        for (const value of values) {
          if (response || !request) throw new BrokerProtocolError('trailing-data', 'unexpected extra broker frame')
          response = verifyResponse(value, request, hello)
        }
      } catch (error) { stop('protocol-error', 'broker frame validation failed', error) }
    }
    const onEnd = (): void => {
      ended = true
      try { decoder.finish() } catch (error) { stop('protocol-error', 'broker connection ended with an invalid frame', error); return }
      if (decoder.frameCount !== 2 || !response) { stop('disconnected', 'broker disconnected before a complete signed response'); return }
      finish(response)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      socket = createConnection({ path: options.socketPath })
      // The peer may send immediately after accept. Buffer it until the second
      // pathname identity check succeeds; no authenticated request is written
      // while a replacement race is unresolved.
      socket.pause()
      socket.on('data', onData)
      socket.once('error', error => stop(connected ? 'disconnected' : 'connect-failed', connected ? 'broker connection failed' : 'broker connect failed', error))
      socket.once('end', onEnd)
      socket.once('close', hadError => { if (!settled && !ended) stop('disconnected', hadError ? 'broker connection closed with an error' : 'broker connection closed without a complete response') })
      socket.once('connect', () => {
        connected = true
        const inspectPeer = options.inspectPeerCredentials ?? inspectLinuxPeerCredentials
        void Promise.all([assertSameSocket(options, before), Promise.resolve(inspectPeer(socket!, operationController.signal))]).then(([, peer]) => {
          if (!peer || !integer(peer.uid, 0, 0x7fffffff) || !integer(peer.gid, 0, 0x7fffffff) || peer.pid !== undefined && !integer(peer.pid, 1, 0x7fffffff)
            || peer.uid !== options.expectedBrokerPeerUid || peer.gid !== options.expectedBrokerPeerGid) { stop('socket-changed', 'connected broker peer identity does not match'); return }
          if (!settled) socket?.resume()
        }, error => stop('socket-changed', 'socket or broker peer identity changed while connecting', error))
      })
    } catch (error) { stop('connect-failed', 'broker connect failed', error) }
  })
}

async function runBeforeWrite<Request>(hook: ((hello: BrokerServerHello, request: Request, signal: AbortSignal) => void | Promise<void>) | undefined, hello: BrokerServerHello, request: Request, signal: AbortSignal): Promise<void> {
  if (!hook) return
  if (signal.aborted) throw signal.reason
  const operation = Promise.resolve().then(() => hook(hello, request, signal))
  operation.catch(() => {})
  await new Promise<void>((resolveGate, rejectGate) => {
    const onAbort = (): void => { signal.removeEventListener('abort', onAbort); rejectGate(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(() => { signal.removeEventListener('abort', onAbort); resolveGate() }, error => { signal.removeEventListener('abort', onAbort); rejectGate(error) })
  })
}

export async function requestGitHubBroker(options: GitHubBrokerClientOptions, intent: BrokerRequestIntent, signal?: AbortSignal): Promise<BrokerServerResponse> {
  if (options.source.kind !== 'assistant-actions-host' || !integer(options.source.generation, 1, Number.MAX_SAFE_INTEGER)) throw fail('invalid-config', false, 'client identity is invalid')
  return await requestBroker(options, intent.deadline,
    hello => createBrokerClientRequest(intent, hello, options.source, options.clientKeyId, options.clientPrivateKey),
    (value, request, hello) => verifyBrokerServerResponse(value, request, hello, options.serverPublicKey), options.beforeWrite, signal)
}

/** Signed operator control request over the same one-request UDS transport. */
export async function requestGitHubBrokerAdmin(
  options: GitHubBrokerConnectionOptions,
  intent: BrokerAdminIntent,
  source: BrokerAdminEndpoint,
  adminKeyId: string,
  adminPrivateKey: KeyInput,
  signal?: AbortSignal,
): Promise<BrokerAdminResponse> {
  if (source.kind !== 'assistant-actions-admin' || !integer(source.generation, 1, Number.MAX_SAFE_INTEGER)) throw fail('invalid-config', false, 'admin identity is invalid')
  return await requestBroker(options, intent.deadline,
    hello => createBrokerAdminRequest(intent, hello, source, adminKeyId, adminPrivateKey),
    (value, request, hello) => verifyBrokerAdminResponse(value, request, hello, options.serverPublicKey), undefined, signal)
}
