import type { KeyObject } from 'node:crypto'
import type { Socket } from 'node:net'
import {
  BrokerFrameDecoder, BrokerProtocolError, GITHUB_BROKER_DEFAULT_HELLO_TTL_MS, GITHUB_BROKER_REQUEST_MAX_BYTES, GITHUB_BROKER_RESPONSE_MAX_BYTES,
  createBrokerAdminRequest, createBrokerClientRequest, encodeBrokerFrame, verifyBrokerAdminResponse, verifyBrokerServerHello, verifyBrokerServerResponse,
  type BrokerAdminEndpoint, type BrokerAdminIntent, type BrokerAdminResponse, type BrokerClientRequest, type BrokerEndpoint, type BrokerRequestIntent, type BrokerServerHello, type BrokerServerResponse,
} from './broker-protocol.js'
import {
  ACTION_BROKER_REQUEST_MAX_BYTES,
  ACTION_BROKER_RESPONSE_MAX_BYTES,
  createActionBrokerAdminRequest,
  createActionBrokerClientRequest,
  verifyActionBrokerAdminResponse,
  verifyActionBrokerServerHello,
  verifyActionBrokerServerResponse,
  type ActionBrokerAdminEndpoint,
  type ActionBrokerAdminIntent,
  type ActionBrokerAdminResponse,
  type ActionBrokerClientRequest,
  type ActionBrokerEndpoint,
  type ActionBrokerRequestIntent,
  type ActionBrokerServerHello,
  type ActionBrokerServerResponse,
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
  inspectPeerCredentials?: (socket: Socket, signal: AbortSignal) => { uid: number; gid: number; pid?: number; sid?: string } | undefined | Promise<{ uid: number; gid: number; pid?: number; sid?: string } | undefined>
  expectedBrokerPeerUid: number
  expectedBrokerPeerGid: number
  expectedBrokerPeerSid?: string
  expectedServerInstanceId?: string
  minimumServerGeneration?: number
  platform?: BrokerPlatform
  transport?: BrokerTransportAdapter
}
export interface GitHubBrokerClientOptions extends GitHubBrokerConnectionOptions {
  clientPrivateKey: KeyInput
  clientKeyId: string
  source: Extract<BrokerEndpoint, { kind: 'assistant-actions-host' }>
  beforeWrite?: (hello: BrokerServerHello, request: BrokerClientRequest, signal: AbortSignal) => void | Promise<void>
}

export interface ActionBrokerClientOptions extends GitHubBrokerConnectionOptions {
  clientPrivateKey: KeyInput
  clientKeyId: string
  source: Extract<ActionBrokerEndpoint, { kind: 'assistant-actions-host' }>
  beforeWrite?: (hello: ActionBrokerServerHello, request: ActionBrokerClientRequest, signal: AbortSignal) => void | Promise<void>
}

function fail(code: BrokerClientErrorCode, dispatched: boolean, message: string, cause?: unknown): BrokerClientError {
  const options = cause === undefined ? undefined : { cause }
  return dispatched ? new BrokerPostDispatchUnknownError(code, message, options) : new BrokerClientError(code, 'not-dispatched', message, options)
}
function integer(value: unknown, minimum: number, maximum: number): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum }

function resolveAdapter(options: GitHubBrokerConnectionOptions): BrokerTransportAdapter {
  if (options.transport) return options.transport
  if (options.platform !== undefined) {
    return createBrokerTransportAdapter({ platform: options.platform, role: 'server', ...(options.inspectPeerCredentials === undefined ? {} : { inspectPeer: options.inspectPeerCredentials }) })
  }
  return createPosixUdsTransportAdapter(process.platform === 'darwin' ? 'darwin' : 'linux', options.inspectPeerCredentials)
}

function mapTransportFailure(error: unknown, dispatched: boolean): BrokerClientError {
  if (error instanceof BrokerClientError) return error
  if (error instanceof BrokerTransportError) {
    const code: BrokerClientErrorCode = error.code === 'invalid-config' ? 'invalid-config' : error.code === 'socket-changed' ? 'socket-changed' : 'socket-invalid'
    return fail(code, dispatched, error.message, error)
  }
  return fail('socket-invalid', dispatched, 'socket cannot be inspected', error)
}

function validateConnectionOptions(options: GitHubBrokerConnectionOptions, adapter: BrokerTransportAdapter): void {
  try {
    adapter.validateEndpointPath(options.socketPath)
  } catch (error) {
    throw mapTransportFailure(error, false)
  }
  if (!integer(options.timeoutMs ?? 30_000, 1, 300_000) || !integer(options.maxHelloTtlMs ?? GITHUB_BROKER_DEFAULT_HELLO_TTL_MS, 1, 300_000)
    || (options.expectedSocketUid !== undefined && !integer(options.expectedSocketUid, 0, 0x7fffffff))
    || (options.expectedSocketGid !== undefined && !integer(options.expectedSocketGid, 0, 0x7fffffff))
    || (options.expectedSocketMode !== undefined && (!integer(options.expectedSocketMode, 0, 0o777) || (options.expectedSocketMode & 0o007) !== 0))
    || (options.expectedSocketParentUid !== undefined && !integer(options.expectedSocketParentUid, 0, 0x7fffffff))
    || (options.expectedSocketParentGid !== undefined && !integer(options.expectedSocketParentGid, 0, 0x7fffffff))
    || (options.expectedSocketParentMode !== undefined && (!integer(options.expectedSocketParentMode, 0, 0o777) || (options.expectedSocketParentMode & 0o022) !== 0))
    || (options.inspectPeerCredentials !== undefined && typeof options.inspectPeerCredentials !== 'function')
    || !integer(options.expectedBrokerPeerUid, 0, 0x7fffffff) || !integer(options.expectedBrokerPeerGid, 0, 0x7fffffff)
    || (options.expectedServerInstanceId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.expectedServerInstanceId))
    || (options.minimumServerGeneration !== undefined && !integer(options.minimumServerGeneration, 1, Number.MAX_SAFE_INTEGER))) {
    throw fail('invalid-config', false, 'client options are invalid')
  }
}

async function requestBroker<Hello extends { expiresAt: number }, Request, Response>(
  options: GitHubBrokerConnectionOptions,
  deadline: number,
  verifyHello: (value: unknown) => Hello,
  makeRequest: (hello: Hello) => Request,
  verifyResponse: (value: unknown, request: Request, hello: Hello) => Response,
  beforeWrite: ((hello: Hello, request: Request, signal: AbortSignal) => void | Promise<void>) | undefined,
  limits: { requestMaxBytes: number; responseMaxBytes: number },
  signal?: AbortSignal,
): Promise<Response> {
  const adapter = resolveAdapter(options)
  validateConnectionOptions(options, adapter)
  if (signal?.aborted) throw fail('aborted', false, 'request was aborted before connect', signal.reason)
  let before: unknown
  try {
    before = await adapter.inspectClientEndpoint(options)
  } catch (error) {
    throw mapTransportFailure(error, false)
  }
  if (signal?.aborted) throw fail('aborted', false, 'request was aborted before connect', signal.reason)
  const decoder = new BrokerFrameDecoder(limits.responseMaxBytes, 2)

  return await new Promise<Response>((resolvePromise, rejectPromise) => {
    let socket: Socket | undefined
    let settled = false, connected = false, requestStarted = false, ended = false
    let hello: Hello | undefined, request: Request | undefined, response: Response | undefined
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
        const verifiedHello = verifyHello(value)
        if (Date.now() >= deadline) throw new BrokerProtocolError('expired-request', 'request deadline expired')
        const verifiedRequest = makeRequest(verifiedHello)
        hello = verifiedHello; request = verifiedRequest
        socket!.pause()
        void runBeforeWrite(beforeWrite, verifiedHello, verifiedRequest, operationController.signal).then(() => {
          if (settled) return
          if (signal?.aborted) { stop('aborted', 'broker request was aborted before dispatch', signal.reason); return }
          if (Date.now() >= deadline || Date.now() >= verifiedHello.expiresAt) { stop('timeout', 'broker request or hello expired before dispatch'); return }
          let frame: Buffer
          try { frame = encodeBrokerFrame(verifiedRequest, limits.requestMaxBytes) } catch (error) { stop('protocol-error', 'broker request encoding failed', error); return }
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
      socket = adapter.connect(options.socketPath)
      socket.pause()
      socket.on('data', onData)
      socket.once('error', error => stop(connected ? 'disconnected' : 'connect-failed', connected ? 'broker connection failed' : 'broker connect failed', error))
      socket.once('end', onEnd)
      socket.once('close', hadError => { if (!settled && !ended) stop('disconnected', hadError ? 'broker connection closed with an error' : 'broker connection closed without a complete response') })
      socket.once('connect', () => {
        connected = true
        const inspectPeer = options.inspectPeerCredentials ?? adapter.inspectPeer
        void Promise.all([
          adapter.assertClientEndpointUnchanged(options, before),
          Promise.resolve(inspectPeer(socket!, operationController.signal)),
        ]).then(([, peer]) => {
          if (!matchesPeerIdentity(peer, {
            uid: options.expectedBrokerPeerUid,
            gid: options.expectedBrokerPeerGid,
            ...(options.expectedBrokerPeerSid === undefined ? {} : { sid: options.expectedBrokerPeerSid }),
          }, adapter.kind)) {
            stop('socket-changed', 'connected broker peer identity does not match')
            return
          }
          if (!settled) socket?.resume()
        }, error => stop('socket-changed', 'socket or broker peer identity changed while connecting', error))
      })
    } catch (error) { stop('connect-failed', 'broker connect failed', error) }
  })
}

async function runBeforeWrite<Hello, Request>(hook: ((hello: Hello, request: Request, signal: AbortSignal) => void | Promise<void>) | undefined, hello: Hello, request: Request, signal: AbortSignal): Promise<void> {
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
  return await requestBroker(
    options,
    intent.deadline,
    value => verifyBrokerServerHello(value, options.serverPublicKey, {
      ...(options.maxHelloTtlMs === undefined ? {} : { maxTtlMs: options.maxHelloTtlMs }),
      ...(options.expectedServerInstanceId === undefined ? {} : { expectedInstanceId: options.expectedServerInstanceId }),
      ...(options.minimumServerGeneration === undefined ? {} : { minimumGeneration: options.minimumServerGeneration }),
    }),
    hello => createBrokerClientRequest(intent, hello, options.source, options.clientKeyId, options.clientPrivateKey),
    (value, request, hello) => verifyBrokerServerResponse(value, request, hello, options.serverPublicKey),
    options.beforeWrite,
    { requestMaxBytes: GITHUB_BROKER_REQUEST_MAX_BYTES, responseMaxBytes: GITHUB_BROKER_RESPONSE_MAX_BYTES },
    signal,
  )
}

/** Signed operator control request over the same one-request UDS / pipe transport. */
export async function requestGitHubBrokerAdmin(
  options: GitHubBrokerConnectionOptions,
  intent: BrokerAdminIntent,
  source: BrokerAdminEndpoint,
  adminKeyId: string,
  adminPrivateKey: KeyInput,
  signal?: AbortSignal,
): Promise<BrokerAdminResponse> {
  if (source.kind !== 'assistant-actions-admin' || !integer(source.generation, 1, Number.MAX_SAFE_INTEGER)) throw fail('invalid-config', false, 'admin identity is invalid')
  return await requestBroker(
    options,
    intent.deadline,
    value => verifyBrokerServerHello(value, options.serverPublicKey, {
      ...(options.maxHelloTtlMs === undefined ? {} : { maxTtlMs: options.maxHelloTtlMs }),
      ...(options.expectedServerInstanceId === undefined ? {} : { expectedInstanceId: options.expectedServerInstanceId }),
      ...(options.minimumServerGeneration === undefined ? {} : { minimumGeneration: options.minimumServerGeneration }),
    }),
    hello => createBrokerAdminRequest(intent, hello, source, adminKeyId, adminPrivateKey),
    (value, request, hello) => verifyBrokerAdminResponse(value, request, hello, options.serverPublicKey),
    undefined,
    { requestMaxBytes: GITHUB_BROKER_REQUEST_MAX_BYTES, responseMaxBytes: GITHUB_BROKER_RESPONSE_MAX_BYTES },
    signal,
  )
}

export async function requestActionBroker(options: ActionBrokerClientOptions, intent: ActionBrokerRequestIntent, signal?: AbortSignal): Promise<ActionBrokerServerResponse> {
  if (options.source.kind !== 'assistant-actions-host' || !integer(options.source.generation, 1, Number.MAX_SAFE_INTEGER)) throw fail('invalid-config', false, 'client identity is invalid')
  return await requestBroker(
    options,
    intent.deadline,
    value => verifyActionBrokerServerHello(value, options.serverPublicKey, {
      ...(options.maxHelloTtlMs === undefined ? {} : { maxTtlMs: options.maxHelloTtlMs }),
      ...(options.expectedServerInstanceId === undefined ? {} : { expectedInstanceId: options.expectedServerInstanceId }),
      ...(options.minimumServerGeneration === undefined ? {} : { minimumGeneration: options.minimumServerGeneration }),
    }),
    hello => createActionBrokerClientRequest(intent, hello, options.source, options.clientKeyId, options.clientPrivateKey),
    (value, request, hello) => verifyActionBrokerServerResponse(value, request, hello, options.serverPublicKey),
    options.beforeWrite,
    { requestMaxBytes: ACTION_BROKER_REQUEST_MAX_BYTES, responseMaxBytes: ACTION_BROKER_RESPONSE_MAX_BYTES },
    signal,
  )
}

export async function requestActionBrokerAdmin(
  options: GitHubBrokerConnectionOptions,
  intent: ActionBrokerAdminIntent,
  source: ActionBrokerAdminEndpoint,
  adminKeyId: string,
  adminPrivateKey: KeyInput,
  signal?: AbortSignal,
): Promise<ActionBrokerAdminResponse> {
  if (source.kind !== 'assistant-actions-admin' || !integer(source.generation, 1, Number.MAX_SAFE_INTEGER)) throw fail('invalid-config', false, 'admin identity is invalid')
  return await requestBroker(
    options,
    intent.deadline,
    value => verifyActionBrokerServerHello(value, options.serverPublicKey, {
      ...(options.maxHelloTtlMs === undefined ? {} : { maxTtlMs: options.maxHelloTtlMs }),
      ...(options.expectedServerInstanceId === undefined ? {} : { expectedInstanceId: options.expectedServerInstanceId }),
      ...(options.minimumServerGeneration === undefined ? {} : { minimumGeneration: options.minimumServerGeneration }),
    }),
    hello => createActionBrokerAdminRequest(intent, hello, source, adminKeyId, adminPrivateKey),
    (value, request, hello) => verifyActionBrokerAdminResponse(value, request, hello, options.serverPublicKey),
    undefined,
    { requestMaxBytes: ACTION_BROKER_REQUEST_MAX_BYTES, responseMaxBytes: ACTION_BROKER_RESPONSE_MAX_BYTES },
    signal,
  )
}
