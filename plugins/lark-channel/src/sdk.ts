import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import {
  AppType,
  Client,
  defaultHttpInstance,
  Domain,
  EventDispatcher,
  LoggerLevel,
  WSClient,
  normalize,
  normalizeCardAction,
  type BotIdentity,
  type HttpInstance,
  type HttpRequestOptions,
  type Logger,
  type NormalizedMessage,
  type RawMessageEvent,
  type RawCardActionEvent,
} from '@larksuiteoapi/node-sdk'
import {
  LarkTransportError,
  type LarkCommandCardTone,
  type LarkMessage,
  type LarkProgressEvent,
  type LarkProgressHandle,
  type LarkReadReceipt,
  type LarkSendInput,
  type LarkSendOptions,
  type LarkSendResult,
  type LarkTextFileUploadInput,
  type LarkTransport,
  type LarkTransportErrorCode,
  type LarkTransportHandlers,
  type LarkUserQuestionOption,
} from './types.js'
import { renderLarkAnswerElements } from './answer-card.js'
import { installLarkCardCallbackBridge } from './ws-card-callback.js'

const LARK_PROGRESS_API = '/open-apis/im/v1/message_cot'
const LARK_MESSAGE_RESOURCE_API = '/open-apis/im/v1/messages'
const LARK_MESSAGE_API = '/open-apis/im/v1/messages'
const LARK_FILE_API = '/open-apis/im/v1/files'
const LARK_ERROR_BODY_MAX_BYTES = 16 * 1_024
export const LARK_TEXT_FILE_MAX_BYTES = 1_048_576
const LARK_FILE_UPLOAD_RESPONSE_MAX_BYTES = 65_536
const LARK_FILE_UPLOAD_MULTIPART_OVERHEAD_BYTES = 4_096
const larkResourceIdentifier = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,255}$/u
const larkTextFileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const LARK_READ_RECEIPT_ID_LIMIT = 100
const LARK_READ_TIME = /^[0-9]{1,15}$/u

/**
 * Normalize the DM-only `im.message.message_read_v1` event.
 *
 * The SDK EventMap handler receives the event body directly; accept an
 * `event` wrapper too so a webhook-normalized shape cannot silently become a
 * read receipt for the wrong ids. Malformed/oversized events are ignored.
 */
export function normalizeReadReceipt(raw: unknown): LarkReadReceipt | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const outer = raw as Record<string, unknown>
  const nested = outer['event']
  const body = (nested !== null && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown> : outer)
  const ids = body['message_id_list']
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > LARK_READ_RECEIPT_ID_LIMIT) return null
  const messageIds = new Set<string>()
  for (const id of ids) {
    if (typeof id !== 'string' || !larkResourceIdentifier.test(id)) return null
    messageIds.add(id)
  }
  if (messageIds.size === 0) return null
  const reader = body['reader']
  if (reader === null || typeof reader !== 'object' || Array.isArray(reader)) return null
  const readTime = (reader as Record<string, unknown>)['read_time']
  if (typeof readTime !== 'string' || !LARK_READ_TIME.test(readTime)) return null
  const readAt = Number(readTime)
  if (!Number.isSafeInteger(readAt) || readAt < 0) return null
  const readerId = (reader as Record<string, unknown>)['reader_id']
  const openId = readerId !== null && typeof readerId === 'object' && !Array.isArray(readerId)
    ? (readerId as Record<string, unknown>)['open_id'] : undefined
  if (openId !== undefined && (typeof openId !== 'string' || !larkResourceIdentifier.test(openId))) return null
  return Object.freeze({ messageIds: Object.freeze([...messageIds]), readAt,
    ...(openId === undefined ? {} : { readerOpenId: openId }) })
}

export type LarkImageMediaType = 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp'

type LarkResponseHeaders = Readonly<Record<string, unknown>> | { get(name: string): unknown }

interface LarkImageResourceResponse {
  data: Readable
  headers: LarkResponseHeaders
}

class LarkImageResponseValidationError extends Error {}

function imageResponseValidationError(message: string): LarkImageResponseValidationError {
  return new LarkImageResponseValidationError(message)
}

function assertResourceIdentifier(value: string, field: string): string {
  if (!larkResourceIdentifier.test(value)) {
    throw new Error(`lark-channel: invalid ${field} identifier`)
  }
  return value
}

export function createLarkImageResourceRequest(
  messageId: string,
  fileKey: string,
  options: { signal: AbortSignal; timeoutMs: number; maxBytes: number },
) {
  const message = assertResourceIdentifier(messageId, 'message')
  const resource = assertResourceIdentifier(fileKey, 'image resource')
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1
    || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new Error('lark-channel: invalid image resource request limits')
  }
  return {
    method: 'GET' as const,
    url: `${LARK_MESSAGE_RESOURCE_API}/${encodeURIComponent(message)}/resources/${encodeURIComponent(resource)}`,
    params: { type: 'image' },
    responseType: 'stream' as const,
    timeout: options.timeoutMs,
    signal: options.signal,
    maxRedirects: 0,
    maxContentLength: options.maxBytes,
    maxBodyLength: options.maxBytes,
    $return_headers: true,
  }
}

function responseHeader(
  headers: LarkResponseHeaders,
  name: string,
): unknown {
  if ('get' in headers && typeof headers.get === 'function') return headers.get(name)
  const record = headers as Readonly<Record<string, unknown>>
  const expected = name.toLowerCase()
  for (const [header, value] of Object.entries(record)) {
    if (header.toLowerCase() === expected) return value
  }
  return undefined
}

function declaredContentLength(headers: LarkImageResourceResponse['headers']): number | undefined {
  const value = responseHeader(headers, 'content-length')
  if (value === undefined) return undefined
  const text = Array.isArray(value) ? value[0] : value
  if ((typeof text !== 'string' && typeof text !== 'number') || !/^\d+$/u.test(String(text))) {
    throw imageResponseValidationError('lark-channel: invalid image resource content length')
  }
  const length = Number(text)
  if (!Number.isSafeInteger(length)) {
    throw imageResponseValidationError('lark-channel: invalid image resource content length')
  }
  return length
}

function imageMediaType(data: Uint8Array): LarkImageMediaType | undefined {
  if (data.length >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 6) {
    const signature = Buffer.from(data.subarray(0, 6)).toString('ascii')
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif'
  }
  if (data.length >= 12
    && Buffer.from(data.subarray(0, 4)).toString('ascii') === 'RIFF'
    && Buffer.from(data.subarray(8, 12)).toString('ascii') === 'WEBP') return 'image/webp'
  return undefined
}

function declaredImageMediaType(headers: LarkImageResourceResponse['headers']): LarkImageMediaType | undefined {
  const value = responseHeader(headers, 'content-type')
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw imageResponseValidationError('lark-channel: invalid image resource content type')
  }
  const mediaType = value.split(';', 1)[0]!.trim().toLowerCase()
  if (mediaType === 'application/octet-stream') return undefined
  if (mediaType === 'image/gif' || mediaType === 'image/jpeg'
    || mediaType === 'image/png' || mediaType === 'image/webp') return mediaType
  throw imageResponseValidationError('lark-channel: unsupported image resource content type')
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('lark-channel: image resource request aborted')
}

type HttpRequestOptionsWithSignal<D> = HttpRequestOptions<D> & { signal?: AbortSignal }

function boundedHttpOptions<D>(
  options: HttpRequestOptions<D> | undefined,
  hardTimeoutMs: number,
  lifecycleSignal: AbortSignal,
): HttpRequestOptionsWithSignal<D> {
  const source = options as HttpRequestOptionsWithSignal<D> | undefined
  const requestedTimeout = source?.timeout
  const timeout = typeof requestedTimeout === 'number' && Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.min(requestedTimeout, hardTimeoutMs)
    : hardTimeoutMs
  const hardTimeoutSignal = AbortSignal.timeout(hardTimeoutMs)
  const signal = source?.signal === undefined
    ? AbortSignal.any([hardTimeoutSignal, lifecycleSignal])
    : AbortSignal.any([source.signal, hardTimeoutSignal, lifecycleSignal])
  return { ...source, timeout, signal }
}

function asSdkHttpResult<R>(request: Promise<unknown>): Promise<R> {
  // The SDK's HttpInstance contract describes its response-interceptor output
  // as R. Axios 1.19 leaves that conditional generic unresolved for arbitrary
  // R even though defaultHttpInstance installs exactly that interceptor.
  return request as Promise<R>
}

/**
 * The SDK's token manager calls `httpInstance.post()` before the resource
 * request exists, so request-local Axios limits cannot cover a cache miss.
 * Keep each SDK client's complete HTTP stack bounded instead.
 */
function boundedHttpInstance(hardTimeoutMs: number, lifecycleSignal: AbortSignal): HttpInstance {
  if (!Number.isSafeInteger(hardTimeoutMs) || hardTimeoutMs < 1) {
    throw new Error('lark-channel: invalid HTTP timeout')
  }
  return {
    request<T = unknown, R = T, D = unknown>(options: HttpRequestOptions<D>): Promise<R> {
      return asSdkHttpResult<R>(
        defaultHttpInstance.request<T, R, D>(boundedHttpOptions(options, hardTimeoutMs, lifecycleSignal)),
      )
    },
    get<T = unknown, R = T, D = unknown>(url: string, options?: HttpRequestOptions<D>): Promise<R> {
      return asSdkHttpResult<R>(
        defaultHttpInstance.get<T, R, D>(url, boundedHttpOptions(options, hardTimeoutMs, lifecycleSignal)),
      )
    },
    delete<T = unknown, R = T, D = unknown>(url: string, options?: HttpRequestOptions<D>): Promise<R> {
      return asSdkHttpResult<R>(
        defaultHttpInstance.delete<T, R, D>(url, boundedHttpOptions(options, hardTimeoutMs, lifecycleSignal)),
      )
    },
    head<T = unknown, R = T, D = unknown>(url: string, options?: HttpRequestOptions<D>): Promise<R> {
      return asSdkHttpResult<R>(
        defaultHttpInstance.head<T, R, D>(url, boundedHttpOptions(options, hardTimeoutMs, lifecycleSignal)),
      )
    },
    options<T = unknown, R = T, D = unknown>(url: string, options?: HttpRequestOptions<D>): Promise<R> {
      return asSdkHttpResult<R>(
        defaultHttpInstance.options<T, R, D>(url, boundedHttpOptions(options, hardTimeoutMs, lifecycleSignal)),
      )
    },
    post<T = unknown, R = T, D = unknown>(url: string, data?: D, options?: HttpRequestOptions<D>): Promise<R> {
      return asSdkHttpResult<R>(
        defaultHttpInstance.post<T, R, D>(url, data, boundedHttpOptions(options, hardTimeoutMs, lifecycleSignal)),
      )
    },
    put<T = unknown, R = T, D = unknown>(url: string, data?: D, options?: HttpRequestOptions<D>): Promise<R> {
      return asSdkHttpResult<R>(
        defaultHttpInstance.put<T, R, D>(url, data, boundedHttpOptions(options, hardTimeoutMs, lifecycleSignal)),
      )
    },
    patch<T = unknown, R = T, D = unknown>(url: string, data?: D, options?: HttpRequestOptions<D>): Promise<R> {
      return asSdkHttpResult<R>(
        defaultHttpInstance.patch<T, R, D>(url, data, boundedHttpOptions(options, hardTimeoutMs, lifecycleSignal)),
      )
    },
  }
}

/**
 * The official SDK accepts an AbortSignal only on its low-level request API.
 * Race every SDK operation locally as well: an SDK/token-manager promise that
 * ignores that signal must never retain a Delivery lease past this deadline.
 * A later transport rejection is deliberately observed and discarded.
 */
function awaitBoundedSdkRequest<T>(signal: AbortSignal, request: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (complete: () => void): boolean => {
      if (settled) return false
      settled = true
      signal.removeEventListener('abort', abort)
      complete()
      return true
    }
    const abort = () => { finish(() => reject(abortReason(signal))) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }
    let pending: Promise<T>
    try {
      pending = request()
    } catch (error) {
      finish(() => reject(error))
      return
    }
    void pending.then(
      value => { finish(() => resolve(value)) },
      error => { finish(() => reject(error)) },
    )
  })
}

function awaitImageResourceRequest(
  signal: AbortSignal,
  request: () => Promise<LarkImageResourceResponse>,
): Promise<LarkImageResourceResponse> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (complete: () => void): boolean => {
      if (settled) return false
      settled = true
      signal.removeEventListener('abort', abort)
      complete()
      return true
    }
    const abort = () => { finish(() => reject(abortReason(signal))) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }
    let pending: Promise<LarkImageResourceResponse>
    try {
      pending = request()
    } catch (error) {
      finish(() => reject(error))
      return
    }
    void pending.then(response => {
      if (!finish(() => resolve(response)) && response.data instanceof Readable) response.data.destroy()
    }, error => {
      // The outer abort is authoritative. This rejection handler intentionally
      // consumes a later Axios/token failure so credential-bearing request
      // metadata can never surface as an unhandled rejection.
      finish(() => reject(error))
    })
  })
}

export async function readLarkImageResourceResponse(
  response: LarkImageResourceResponse,
  options: { maxBytes: number; signal: AbortSignal },
): Promise<{ data: Uint8Array; mediaType: LarkImageMediaType }> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    response.data.destroy()
    throw imageResponseValidationError('lark-channel: invalid image resource byte limit')
  }
  if (options.signal.aborted) {
    response.data.destroy()
    throw abortReason(options.signal)
  }
  let declaredLength: number | undefined
  let declaredType: LarkImageMediaType | undefined
  try {
    declaredLength = declaredContentLength(response.headers)
    declaredType = declaredImageMediaType(response.headers)
  } catch (error) {
    response.data.destroy()
    throw error
  }
  if (declaredLength !== undefined && declaredLength > options.maxBytes) {
    response.data.destroy()
    throw imageResponseValidationError('lark-channel: image resource exceeds its byte limit')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  const abort = () => response.data.destroy(abortReason(options.signal))
  options.signal.addEventListener('abort', abort, { once: true })
  try {
    for await (const value of response.data) {
      if (options.signal.aborted) throw abortReason(options.signal)
      if (!(value instanceof Uint8Array)) {
        throw imageResponseValidationError('lark-channel: invalid image resource stream chunk')
      }
      bytes += value.byteLength
      if (bytes > options.maxBytes) {
        response.data.destroy()
        throw imageResponseValidationError('lark-channel: image resource exceeds its byte limit')
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
    }
  } catch (error) {
    if (options.signal.aborted) throw abortReason(options.signal)
    throw error
  } finally {
    options.signal.removeEventListener('abort', abort)
  }
  if (options.signal.aborted) throw abortReason(options.signal)
  if (declaredLength !== undefined && declaredLength !== bytes) {
    throw new Error('lark-channel: image resource length does not match its response header')
  }
  const data = new Uint8Array(Buffer.concat(chunks, bytes))
  const detectedType = imageMediaType(data)
  if (detectedType === undefined) {
    throw imageResponseValidationError('lark-channel: image resource has an unsupported byte signature')
  }
  if (declaredType !== undefined && declaredType !== detectedType) {
    throw imageResponseValidationError('lark-channel: image resource content type does not match its bytes')
  }
  if (options.signal.aborted) throw abortReason(options.signal)
  return { data, mediaType: detectedType }
}

/** Provider-safe UTF-8 budget for the complete serialized approval card. */
export const LARK_APPROVAL_CARD_MAX_BYTES = 28 * 1_024

export interface OfficialLarkTransportOptions {
  appId: string
  appSecret: string
  domain: 'feishu' | 'lark'
  handshakeTimeoutMs: number
  /** Defaults to 30 seconds for direct SDK consumers predating this option. */
  requestTimeoutMs?: number
  imageDownloadTimeoutMs: number
}

interface ErrorShape {
  code?: unknown
  response?: { status?: unknown; headers?: LarkResponseHeaders; data?: unknown }
}

function providerFailureCode(code: unknown): LarkTransportErrorCode | undefined {
  if (code === 99991400 || code === 230020) return 'rate_limited'
  if (code === 230027 || code === 234009 || code === 99991663
    || code === 99991672 || code === 99991676 || code === 99991679) return 'permission_denied'
  if (code === 200530 || code === 234001 || code === 234006
    || code === 234007 || code === 234008 || code === 234011) return 'format_error'
  return undefined
}

const silentLogger: Logger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
}

const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000

function retryAfter(headers: LarkResponseHeaders | undefined): number | undefined {
  const value = headers === undefined ? undefined : responseHeader(headers, 'retry-after')
  const delaySeconds = typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN
  const delayMs = delaySeconds * 1_000
  return Number.isSafeInteger(delayMs) && delayMs >= 0 && delayMs <= MAX_RETRY_AFTER_MS
    ? delayMs
    : undefined
}

export function classifyLarkSdkFailure(error: unknown): { code: LarkTransportErrorCode; retryAfterMs?: number } {
  const shape = error !== null && typeof error === 'object' ? error as ErrorShape : {}
  const status = typeof shape.response?.status === 'number' ? shape.response.status : undefined
  if (status === 429) {
    const delay = retryAfter(shape.response?.headers)
    return { code: 'rate_limited', ...(delay === undefined ? {} : { retryAfterMs: delay }) }
  }
  const responseData = shape.response?.data
  const responseCode = responseData !== null && typeof responseData === 'object' && !Array.isArray(responseData)
    ? (responseData as { code?: unknown }).code
    : undefined
  const providerCode = providerFailureCode(responseCode) ?? providerFailureCode(shape.code)
  if (providerCode !== undefined) {
    const delay = providerCode === 'rate_limited' ? retryAfter(shape.response?.headers) : undefined
    return { code: providerCode, ...(delay === undefined ? {} : { retryAfterMs: delay }) }
  }
  if (status === 401 || status === 403) return { code: 'permission_denied' }
  if (status !== undefined && status >= 400 && status < 500) return { code: 'format_error' }
  if (shape.code === 'ETIMEDOUT' || shape.code === 'ECONNABORTED') return { code: 'send_timeout' }
  return { code: 'unknown' }
}

async function streamedProviderFailureCode(stream: Readable, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) {
    stream.destroy()
    return undefined
  }
  const chunks: Buffer[] = []
  let bytes = 0
  let exceeded = false
  const abort = () => stream.destroy()
  signal.addEventListener('abort', abort, { once: true })
  try {
    for await (const value of stream) {
      if (!(value instanceof Uint8Array)) {
        stream.destroy()
        return undefined
      }
      bytes += value.byteLength
      if (bytes > LARK_ERROR_BODY_MAX_BYTES) {
        exceeded = true
        stream.destroy()
        break
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
    }
  } catch {
    return undefined
  } finally {
    signal.removeEventListener('abort', abort)
  }
  if (exceeded || signal.aborted) return undefined
  try {
    const value = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as { code?: unknown }).code
      : undefined
  } catch {
    return undefined
  }
}

export async function classifyLarkImageSdkFailure(
  error: unknown,
  signal: AbortSignal,
): Promise<{ code: LarkTransportErrorCode; retryAfterMs?: number }> {
  const shape = error !== null && typeof error === 'object' ? error as ErrorShape : {}
  const stream = shape.response?.data instanceof Readable ? shape.response.data : undefined
  if (stream === undefined) return classifyLarkSdkFailure(error)
  const status = typeof shape.response?.status === 'number' ? shape.response.status : undefined
  if (status !== 400) {
    stream.destroy()
    return classifyLarkSdkFailure(error)
  }
  const code = await streamedProviderFailureCode(stream, signal)
  const classified = providerFailureCode(code)
  if (classified === undefined) return classifyLarkSdkFailure(error)
  const delay = classified === 'rate_limited' ? retryAfter(shape.response?.headers) : undefined
  return { code: classified, ...(delay === undefined ? {} : { retryAfterMs: delay }) }
}

export function larkRequestUuid(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)
}

export function createLarkProgressRequest(
  chatId: string,
  options: { replyTo: string; hidden: boolean },
  signal?: AbortSignal,
) {
  return {
    method: 'POST' as const,
    url: `${LARK_PROGRESS_API}?receive_id_type=chat_id`,
    data: {
      receive_id: chatId,
      origin_message_id: options.replyTo,
      cot_hidden: options.hidden,
      enable_badge: false,
      update_feed_rank: false,
    },
    ...(signal === undefined ? {} : { signal }),
  }
}

export function writeLarkProgressRequest(
  handle: LarkProgressHandle,
  events: readonly LarkProgressEvent[],
  signal?: AbortSignal,
) {
  return {
    method: 'PUT' as const,
    url: LARK_PROGRESS_API,
    data: {
      cot_id: handle.cotId,
      message_id: handle.messageId,
      events: events.map(event => ({
        event_type: event.eventType,
        content: event.content,
        timestamp: event.timestamp,
      })),
    },
    ...(signal === undefined ? {} : { signal }),
  }
}

export function createLarkTextFileUploadRequest(
  input: Readonly<{
    name: string
    mediaType: 'text/plain' | 'text/markdown'
    text: string
    timeoutMs: number
    maxBytes?: number
    signal: AbortSignal
  }>,
) {
  const maxBytes = input.maxBytes ?? LARK_TEXT_FILE_MAX_BYTES
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > LARK_TEXT_FILE_MAX_BYTES) {
    throw new LarkTransportError('format_error', 'lark-channel: invalid text file upload limits')
  }
  if (typeof input.name !== 'string' || !larkTextFileName.test(input.name) || input.name.includes('..')) {
    throw new LarkTransportError('format_error', 'lark-channel: invalid text file attachment name')
  }
  if (input.mediaType !== 'text/plain' && input.mediaType !== 'text/markdown') {
    throw new LarkTransportError('format_error', 'lark-channel: unsupported text file attachment media type')
  }
  if (typeof input.text !== 'string' || input.text.length === 0) {
    throw new LarkTransportError('format_error', 'lark-channel: text file attachment must be non-empty')
  }
  const file = Buffer.from(input.text, 'utf8')
  if (file.byteLength === 0 || file.byteLength > maxBytes) {
    throw new LarkTransportError('format_error', 'lark-channel: text file attachment exceeds byte limit')
  }
  return {
    method: 'POST' as const,
    url: LARK_FILE_API,
    headers: { 'Content-Type': 'multipart/form-data' },
    data: {
      file_type: 'stream' as const,
      file_name: input.name,
      file,
    },
    timeout: input.timeoutMs,
    signal: input.signal,
    maxRedirects: 0,
    maxContentLength: LARK_FILE_UPLOAD_RESPONSE_MAX_BYTES,
    maxBodyLength: file.byteLength + LARK_FILE_UPLOAD_MULTIPART_OVERHEAD_BYTES,
  }
}

function createLarkMessageSendRequest(
  chatId: string,
  rendered: ReturnType<typeof renderLarkMessage>,
  uuid: string,
  options: LarkSendOptions,
  signal?: AbortSignal,
) {
  if (options.replyTo === undefined) {
    return {
      method: 'POST' as const,
      url: LARK_MESSAGE_API,
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: rendered.msgType, content: rendered.content, uuid },
      ...(signal === undefined ? {} : { signal }),
    }
  }
  const replyTo = assertResourceIdentifier(options.replyTo, 'reply message')
  return {
    method: 'POST' as const,
    url: `${LARK_MESSAGE_API}/${encodeURIComponent(replyTo)}/reply`,
    data: {
      msg_type: rendered.msgType,
      content: rendered.content,
      uuid,
      ...(options.replyInThread === undefined ? {} : { reply_in_thread: options.replyInThread }),
    },
    ...(signal === undefined ? {} : { signal }),
  }
}

export function createLarkFileMessageRequest(
  chatId: string,
  fileKey: string,
  options: LarkSendOptions = {},
  signal?: AbortSignal,
) {
  const rendered = renderLarkMessage({ fileKey })
  const uuid = larkRequestUuid(options.requestKey ?? `${chatId}:${rendered.content}`)
  return createLarkMessageSendRequest(chatId, rendered, uuid, options, signal ?? options.signal)
}

function createLarkReactionRequest(messageId: string, emojiType: string, signal: AbortSignal) {
  const message = assertResourceIdentifier(messageId, 'message')
  return {
    method: 'POST' as const,
    url: `${LARK_MESSAGE_API}/${encodeURIComponent(message)}/reactions`,
    data: { reaction_type: { emoji_type: emojiType } },
    signal,
  }
}

export function createLarkRawCardUpdateRequest(
  messageId: string,
  card: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
) {
  const message = assertResourceIdentifier(messageId, 'message')
  return {
    method: 'PATCH' as const,
    url: `${LARK_MESSAGE_API}/${encodeURIComponent(message)}`,
    data: { content: JSON.stringify(card) },
    signal,
  }
}

export const LARK_MODEL_PICKER_CONTROLS = Object.freeze({
  provider: 'model_provider',
  model: 'model_route',
  effort: 'model_effort',
  confirm: 'model_confirm',
})

export const LARK_PERMISSION_PICKER_CONTROLS = Object.freeze({
  ask: 'permission_ask',
  auto: 'permission_auto',
  full: 'permission_full',
})

function surfaceContainer(
  tone: LarkCommandCardTone | 'yellow',
  elements: readonly Record<string, unknown>[],
  padding = '12px 12px 12px 12px',
  verticalSpacing = '6px',
) {
  return {
    tag: 'interactive_container',
    behaviors: [] as const,
    width: 'fill',
    corner_radius: '8px',
    has_border: true,
    border_color: `${tone}-200`,
    background_style: `${tone}-50`,
    padding,
    direction: 'vertical',
    vertical_spacing: verticalSpacing,
    elements,
  }
}

function equalButtonColumnSet(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
) {
  return {
    tag: 'column_set',
    flex_mode: 'bisect',
    horizontal_spacing: '8px',
    columns: [
      { tag: 'column', width: 'weighted', weight: 1, elements: [left] },
      { tag: 'column', width: 'weighted', weight: 1, elements: [right] },
    ],
  }
}

export function renderLarkMessage(input: LarkSendInput): { msgType: 'file' | 'interactive' | 'text'; content: string } {
  if ('text' in input) return { msgType: 'text', content: JSON.stringify({ text: input.text }) }
  if ('fileKey' in input) {
    if (typeof input.fileKey !== 'string' || !larkResourceIdentifier.test(input.fileKey)) {
      throw new LarkTransportError('format_error', 'lark-channel: invalid file identifier')
    }
    return { msgType: 'file', content: JSON.stringify({ file_key: input.fileKey }) }
  }
  if ('commandCard' in input) {
    const card = input.commandCard
    const elements: Record<string, unknown>[] = []
    if (card.metrics !== undefined && card.metrics.length > 0) {
      elements.push({
        tag: 'column_set',
        flex_mode: 'bisect',
        horizontal_spacing: '8px',
        columns: card.metrics.map(metric => ({
          tag: 'column',
          width: 'weighted',
          weight: 1,
          background_style: 'grey-50',
          padding: '10px 12px 10px 12px',
          direction: 'vertical',
          vertical_spacing: '4px',
          elements: [
            { tag: 'div', text_size: 'notation', text: { tag: 'plain_text', content: metric.label, text_color: 'grey' } },
            { tag: 'div', text: { tag: 'plain_text', content: metric.value } },
          ],
        })),
      })
    }
    for (const section of card.sections) {
      const tone = section.tone ?? 'grey'
      const sectionElements: Record<string, unknown>[] = []
      if (section.heading !== undefined) {
        sectionElements.push({
          tag: 'markdown',
          content: tone === 'grey'
            ? `**${section.heading}**`
            : `**<font color='${tone}'>${section.heading}</font>**`,
          text_align: 'left',
        })
      }
      for (const item of section.items) {
        if (item.kind === 'markdown') {
          sectionElements.push({ tag: 'markdown', content: item.content, text_align: 'left' })
        } else {
          sectionElements.push({
            tag: 'div',
            ...(item.notation ? { text_size: 'notation' } : {}),
            text: {
              tag: 'plain_text',
              content: item.content,
              ...(item.notation ? { text_color: 'grey' } : {}),
            },
          })
        }
      }
      if (sectionElements.length > 0) {
        elements.push(surfaceContainer(tone, sectionElements))
      }
    }
    if (card.footer !== undefined) {
      elements.push({
        tag: 'div',
        text_size: 'notation',
        icon: { tag: 'standard_icon', token: 'info_outlined', color: 'grey' },
        text: { tag: 'plain_text', content: card.footer, text_color: 'grey' },
      })
    }
    return {
      msgType: 'interactive',
      content: JSON.stringify({
        schema: '2.0',
        config: {
          compact_width: false,
          width_mode: 'fill',
          summary: { content: card.summary },
        },
        header: {
          template: card.template,
          title: { tag: 'plain_text', content: card.title },
          ...(card.subtitle === undefined ? {} : { subtitle: { tag: 'plain_text', content: card.subtitle } }),
          icon: { tag: 'standard_icon', token: card.iconToken },
        },
        body: {
          padding: '12px 12px 16px 12px',
          direction: 'vertical',
          vertical_spacing: '8px',
          elements,
        },
      }),
    }
  }
  if ('userQuestion' in input) {
    const question = input.userQuestion
    const optionButton = (option: LarkUserQuestionOption, index: number) => {
      const markers = [
        ...(question.multiSelect && option.selected === true ? ['✓ 已选'] : []),
        ...(option.recommended === true ? ['推荐'] : []),
      ]
      const value = option.value
      return {
        tag: 'button',
        name: `user_question_option_${index + 1}`,
        type: option.recommended === true || (question.multiSelect && option.selected === true)
          ? 'primary'
          : 'default',
        width: 'fill',
        text: { tag: 'plain_text', content: markers.length === 0
          ? option.label
          : `${markers.join(' · ')}：${option.label}` },
        value,
        behaviors: [{ type: 'callback', value }],
      }
    }
    const submitButton = question.submitValue === undefined
      ? undefined
      : {
          tag: 'button',
          name: 'user_question_submit',
          type: 'primary',
          width: 'fill',
          icon: { tag: 'standard_icon', token: 'done_outlined' },
          text: { tag: 'plain_text', content: question.multiSelect ? '提交已选答案' : '提交答案' },
          value: question.submitValue,
          behaviors: [{ type: 'callback' as const, value: question.submitValue }],
        }
    const cancelButton = question.cancelValue === undefined
      ? undefined
      : {
          tag: 'button',
          name: 'user_question_cancel',
          type: 'default',
          width: 'fill',
          icon: { tag: 'standard_icon', token: 'close_outlined' },
          text: { tag: 'plain_text', content: '取消本次问题' },
          value: question.cancelValue,
          behaviors: [{ type: 'callback' as const, value: question.cancelValue }],
        }
    const questionSurface = surfaceContainer('blue', [
      { tag: 'div', text: { tag: 'plain_text', content: question.question } },
      ...(question.detail === undefined ? [] : [
        { tag: 'div', text_size: 'notation', text: { tag: 'plain_text', content: question.detail, text_color: 'grey' } },
      ]),
      ...(question.expectsText ? [{
        tag: 'div',
        text_size: 'notation',
        icon: { tag: 'standard_icon', token: 'edit_outlined', color: 'blue' },
        text: { tag: 'plain_text', content: '如需输入其他答案，请直接回复这张问题卡片。', text_color: 'blue' },
      }] : []),
    ])
    const answeredElements = question.answered === undefined || question.answered.length === 0
      ? []
      : [surfaceContainer('grey', question.answered.map(answered => ({
          tag: 'div',
          text_size: 'notation',
          text: { tag: 'plain_text', content: `已答摘要：${answered.title}：${answered.answer}`, text_color: 'grey' },
        })), '10px 12px 10px 12px', '4px')]
    const optionElements = question.options.map((option, index) => {
      const button = optionButton(option, index)
      if (option.description === undefined) return button
      return surfaceContainer('grey', [
        { tag: 'div', text_size: 'notation', text: { tag: 'plain_text', content: option.description, text_color: 'grey' } },
        button,
      ], '10px 12px 10px 12px', '6px')
    })
    const actionElements = submitButton !== undefined && cancelButton !== undefined
      ? [equalButtonColumnSet(submitButton, cancelButton)]
      : [
          ...(submitButton === undefined ? [] : [submitButton]),
          ...(cancelButton === undefined ? [] : [cancelButton]),
        ]
    return {
      msgType: 'interactive',
      content: JSON.stringify({
        schema: '2.0',
        config: {
          update_multi: true,
          enable_forward_interaction: false,
          summary: { content: '智能体正在等待您的选择或补充回答' },
        },
        header: {
          template: 'blue',
          title: { tag: 'plain_text', content: question.title },
          subtitle: { tag: 'plain_text', content: `问题 ${question.position} / ${question.total}` },
          icon: { tag: 'standard_icon', token: 'chat_outlined' },
        },
        body: {
          padding: '12px 12px 16px 12px',
          direction: 'vertical',
          vertical_spacing: '8px',
          elements: [
            questionSurface,
            ...answeredElements,
            ...optionElements,
            ...actionElements,
          ],
        },
      }),
    }
  }
  if ('userQuestionResult' in input) {
    const result = input.userQuestionResult
    const presentation = {
      answered: {
        template: 'green' as const,
        icon: 'done_outlined',
        title: '已收到您的回答',
        detail: '回答已交给智能体，正在继续处理。',
        summary: '智能体已收到您的回答并将继续处理',
      },
      cancelled: {
        template: 'grey' as const,
        icon: 'close_outlined',
        title: '本次问题已取消',
        detail: '该问题已取消，智能体不会继续等待此回答。',
        summary: '本次问题已取消，智能体不再等待回答',
      },
      resolved: {
        template: 'blue' as const,
        icon: 'info_outlined',
        title: '本次问题已处理',
        detail: '该问题已在其他已授权终端完成处理。',
        summary: '本次问题已由已授权终端处理完成',
      },
    }[result.status]
    return {
      msgType: 'interactive',
      content: JSON.stringify({
        schema: '2.0',
        config: {
          update_multi: true,
          enable_forward_interaction: false,
          summary: { content: presentation.summary },
        },
        header: {
          template: presentation.template,
          title: { tag: 'plain_text', content: presentation.title },
          subtitle: { tag: 'plain_text', content: presentation.detail },
          icon: { tag: 'standard_icon', token: presentation.icon },
        },
        body: {
          padding: '12px 12px 16px 12px',
          direction: 'vertical',
          vertical_spacing: '8px',
          elements: [
            surfaceContainer(presentation.template, [
              { tag: 'div', text: { tag: 'plain_text', content: result.summary } },
            ]),
          ],
        },
      }),
    }
  }
  if ('permissionPicker' in input) {
    const picker = input.permissionPicker
    const level = (
      key: import('./types.js').LarkPermissionLevel,
      label: string,
      description: string,
    ) => {
      const current = picker.current === key
      const value = picker.callbackValues[key]
      const full = key === 'full'
      const tone = full ? 'orange' : current ? 'blue' : 'grey'
      const titleMarkdown = full
        ? `**<font color='orange'>${current ? '✓ ' : ''}${label}</font>**`
        : current
          ? `**<font color='blue'>✓ ${label}</font>**`
          : `**${label}**`
      return surfaceContainer(tone, [
        { tag: 'markdown', content: titleMarkdown, text_align: 'left' },
        { tag: 'markdown', content: `<font color='grey'>${description}</font>`, text_size: 'notation', text_align: 'left' },
        {
          tag: 'button',
          name: LARK_PERMISSION_PICKER_CONTROLS[key],
          type: full ? 'danger' : current ? 'primary' : 'default',
          width: 'fill',
          icon: { tag: 'standard_icon', token: full ? 'warning_outlined' : current ? 'done_outlined' : 'safe_outlined' },
          text: { tag: 'plain_text', content: current ? '✓ 当前档位' : '选择此档位' },
          value,
          behaviors: [{ type: 'callback', value }],
          ...(full ? { confirm: {
            title: { tag: 'plain_text', content: '确认开启完全访问权限？' },
            text: { tag: 'plain_text', content: '开启后可访问互联网和电脑上的任何文件，并关闭逐次审批。' },
          } } : {}),
        },
      ])
    }
    return {
      msgType: 'interactive',
      content: JSON.stringify({
        schema: '2.0',
        config: {
          enable_forward_interaction: false,
          summary: { content: '请选择当前会话的运行权限模式' },
        },
        header: {
          template: 'blue',
          title: { tag: 'plain_text', content: picker.title },
          subtitle: { tag: 'plain_text', content: picker.body },
          icon: { tag: 'standard_icon', token: 'safe_outlined' },
        },
        body: {
          padding: '12px 12px 16px 12px',
          direction: 'vertical',
          vertical_spacing: '8px',
          elements: [
            level('ask', '请求批准（ask）', '编辑外部文件和使用互联网时始终询问'),
            level('auto', '帮我批准（auto）', '仅对检测到的风险操作请求批准'),
            level('full', '完全访问权限（full）', '不受限制地访问互联网和电脑上的任何文件，并关闭逐次审批'),
          ],
        },
      }),
    }
  }
  if ('modelSelectionResult' in input) {
    const result = input.modelSelectionResult
    const presentation = result.status === 'pending'
      ? {
          template: 'blue',
          color: 'blue',
          background: 'blue-50',
          title: '模型选择已提交',
          subtitle: '正在验证；验证成功后将从下一条消息生效，并保留当前上下文。',
          summary: '模型选择已提交，正在验证中',
        }
      : result.status === 'selected'
        ? {
            template: 'green',
            color: 'green',
            background: 'green-50',
            title: '模型切换成功',
            subtitle: '已完成验证；下一条消息起生效，并保留当前上下文。',
            summary: '模型切换已生效，下一条消息启用',
          }
        : {
            template: 'orange',
            color: 'orange',
            background: 'orange-50',
            title: '模型切换未生效',
            subtitle: result.explanation,
            summary: '模型切换未生效，请查看说明详情',
          }
    const field = (label: string, value: string) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      background_style: presentation.background,
      padding: '12px 12px 12px 12px',
      direction: 'vertical',
      vertical_spacing: '4px',
      elements: [
        { tag: 'markdown', content: `**<font color='${presentation.color}'>${label}</font>**`, text_align: 'left' },
        { tag: 'div', text: { tag: 'plain_text', content: value } },
      ],
    })
    return {
      msgType: 'interactive',
      content: JSON.stringify({
        schema: '2.0',
        config: {
          compact_width: false,
          update_multi: true,
          enable_forward_interaction: false,
          summary: { content: presentation.summary },
        },
        header: {
          template: presentation.template,
          title: { tag: 'plain_text', content: presentation.title },
          subtitle: { tag: 'plain_text', content: presentation.subtitle },
          icon: { tag: 'standard_icon', token: 'myai_colorful' },
        },
        body: {
          padding: '12px 12px 16px 12px',
          elements: [{
            tag: 'column_set',
            flex_mode: 'flow',
            horizontal_spacing: '8px',
            columns: [
              field('Provider', result.provider),
              field('模型', result.model),
              field('Effort', result.effort),
            ],
          }],
        },
      }),
    }
  }
  if ('modelPicker' in input) {
    const picker = input.modelPicker
    const callback = (action: import('./model-picker.js').LarkModelPickerCallbackAction) => picker.callbackValues[action]
    const select = (
      name: string,
      placeholder: string,
      options: readonly { value: string; label: string }[],
      initial: string | undefined,
      action: import('./model-picker.js').LarkModelPickerCallbackAction,
    ) => {
      const value = callback(action)
      // Lark resolves `initial_option` against the option's displayed text, not its
      // callback value, so a route-shaped or synthetic initial value never matches and
      // the client silently falls back to the first option. Address the selection by its
      // 1-based `initial_index`, and only add the textual form when that label identifies
      // exactly one option, because `initial_option` overrides `initial_index`. An initial
      // value absent from `options` preselects nothing.
      const selected = initial === undefined
        ? -1
        : options.findIndex(option => option.value === initial)
      const label = selected < 0 ? undefined : options[selected]!.label
      const unambiguous = label !== undefined
        && options.filter(option => option.label === label).length === 1
      return {
        tag: 'select_static',
        name,
        width: 'fill',
        placeholder: { tag: 'plain_text', content: placeholder },
        options: options.map(option => ({
          text: { tag: 'plain_text', content: option.label },
          value: option.value,
        })),
        value,
        behaviors: [{ type: 'callback', value }],
        ...(selected < 0 ? {} : { initial_index: selected + 1 }),
        ...(unambiguous ? { initial_option: label } : {}),
      }
    }
    const confirmValue = callback('confirm')
    // Layout follows the card style guide: header carries "what this is" (title + subtitle + icon),
    // each of the three selects sits in its own bordered surface so the groups read as blocks
    // instead of a flat run of markdown labels, and the single primary button is the only focus.
    const field = (label: string, hint: string, control: object, last = false) => ({
      tag: 'interactive_container',
      behaviors: [],
      width: 'fill',
      corner_radius: '8px',
      has_border: true,
      border_color: 'blue-100',
      background_style: 'blue-50',
      padding: '12px 12px 12px 12px',
      direction: 'vertical',
      vertical_spacing: '4px',
      // A trailing container keeps no bottom margin, so the card does not end on dead space.
      margin: last ? '0px 0px 12px 0px' : '0px 0px 8px 0px',
      elements: [
        { tag: 'markdown', content: `**<font color='blue'>${label}</font>**`, text_align: 'left' },
        { tag: 'markdown', content: `<font color='grey'>${hint}</font>`, text_size: 'notation', text_align: 'left' },
        control,
      ],
    })
    return {
      msgType: 'interactive',
      content: JSON.stringify({
        schema: '2.0',
        config: {
          update_multi: true,
          enable_forward_interaction: false,
          summary: { content: '请选择当前会话使用的模型路由与档位' },
        },
        header: {
          template: 'blue',
          title: { tag: 'plain_text', content: picker.title },
          subtitle: { tag: 'plain_text', content: picker.body },
          icon: { tag: 'standard_icon', token: 'myai_colorful' },
        },
        body: { padding: '12px 12px 20px 12px', elements: [
          field('分组 / Provider', '先选分组，模型与 effort 会随之更新', select(
            LARK_MODEL_PICKER_CONTROLS.provider, '请选择模型分组',
            picker.providerOptions, picker.initialProvider, 'provider')),
          field('模型', '该分组下当前可用的模型', select(
            LARK_MODEL_PICKER_CONTROLS.model, '请选择模型',
            picker.modelOptions, picker.initialModel, 'model')),
          field('Effort 程度', '仅对支持 effort 档位的模型生效', select(
            LARK_MODEL_PICKER_CONTROLS.effort, '请选择 effort',
            picker.effortOptions, picker.initialEffort, 'effort'), true),
          { tag: 'button', name: LARK_MODEL_PICKER_CONTROLS.confirm, type: 'primary', width: 'fill',
            icon: { tag: 'standard_icon', token: 'done_outlined' },
            text: { tag: 'plain_text', content: '确认选择' }, value: confirmValue,
            behaviors: [{ type: 'callback', value: confirmValue }] },
        ] },
      }),
    }
  }
  if ('approval' in input) {
    const fieldLabels: Readonly<Record<string, string>> = {
      op: '变更类型',
      ruleId: '规则 ID',
      scopeKey: '作用域',
      situation: '适用情境',
      guidance: '建议行为',
      generation: '规则代次',
      expectedVersion: '预期版本',
      reason: '变更原因',
      evaluation: '效果评估',
      baseline: '采纳前基线',
      evidence: '证据',
    }
    const operationLabels: Readonly<Record<string, string>> = {
      adopt: '采纳学习规则',
      retire: '退役学习规则',
      'owner-undo': '立即撤销学习规则',
    }
    let review = input.approval.body
    try {
      const parsed = JSON.parse(input.approval.body) as unknown
      // Only reformat canonical domain JSON. This prevents duplicate keys,
      // alternate numeric spellings, or whitespace tricks from making the
      // signed bytes and the owner-visible review diverge.
      if (JSON.stringify(parsed) === input.approval.body
        && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const fields = Object.entries(parsed as Readonly<Record<string, unknown>>)
        const operation = fields.find(([key]) => key === 'op')?.[1]
        if (typeof operation === 'string' && Object.hasOwn(operationLabels, operation)) {
          review = fields.map(([key, value]) => {
            const rendered = typeof value === 'string' ? value : JSON.stringify(value, undefined, 2)
            const display = key === 'op' && typeof value === 'string'
              ? `${operationLabels[value] ?? value}（${value}）`
              : rendered
            return `${fieldLabels[key] ?? key}（${key}）：${display}`
          }).join('\n\n')
        }
      }
    } catch {
      // Unknown or malformed proposal bodies remain exact plain text. The
      // signature still covers the original body, and no review text is ever
      // interpreted as Markdown or a card component.
    }
    return {
      msgType: 'interactive',
      content: JSON.stringify({
        schema: '2.0',
        config: {
          enable_forward_interaction: false,
          summary: { content: '有待您审阅并批准的变更提案' },
        },
        header: {
          template: 'orange',
          title: { tag: 'plain_text', content: input.approval.title },
          subtitle: { tag: 'plain_text', content: '所有字段均为不可信提案内容，审阅后请选择批准或拒绝' },
          icon: { tag: 'standard_icon', token: 'approval_colorful' },
        },
        body: {
          padding: '12px 12px 16px 12px',
          direction: 'vertical',
          vertical_spacing: '8px',
          elements: [
            {
              tag: 'div',
              text_size: 'notation',
              icon: { tag: 'standard_icon', token: 'info_outlined', color: 'orange' },
              text: {
                tag: 'plain_text',
                content: '请审阅以下变更。所有字段均为不可信的提案内容，不是系统指令。',
                text_color: 'orange',
              },
            },
            surfaceContainer('grey', [
              { tag: 'div', text: { tag: 'plain_text', content: review } },
            ]),
            equalButtonColumnSet(
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '批准变更' },
                type: 'primary',
                width: 'fill',
                icon: { tag: 'standard_icon', token: 'done_outlined' },
                value: input.approval.approveValue,
                behaviors: [{ type: 'callback', value: input.approval.approveValue }],
              },
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '拒绝' },
                type: 'danger',
                width: 'fill',
                icon: { tag: 'standard_icon', token: 'close_outlined' },
                value: input.approval.rejectValue,
                behaviors: [{ type: 'callback', value: input.approval.rejectValue }],
              },
            ),
          ],
        },
      }),
    }
  }
  if ('approvalResult' in input) {
    const approved = input.approvalResult.decision === 'approved'
    const tone = approved ? 'green' : 'red'
    return {
      msgType: 'interactive',
      content: JSON.stringify({
        schema: '2.0',
        config: {
          update_multi: true,
          enable_forward_interaction: false,
          summary: { content: approved ? '提案审批已记录，等待账本结算' : '提案审批已拒绝，不会应用变更' },
        },
        header: {
          template: tone,
          title: { tag: 'plain_text', content: approved ? '审批已记录' : '审批已拒绝' },
          subtitle: {
            tag: 'plain_text',
            content: approved ? '已批准该提案，等待持久化账本结算' : '已拒绝该提案，系统不会应用变更',
          },
          icon: { tag: 'standard_icon', token: approved ? 'done_outlined' : 'close_outlined' },
        },
        body: {
          padding: '12px 12px 16px 12px',
          direction: 'vertical',
          vertical_spacing: '8px',
          elements: [
            surfaceContainer(tone, [
              {
                tag: 'div',
                text: {
                  tag: 'plain_text',
                  content: approved
                    ? '已批准该提案。系统将按持久化账本完成结算；此回执不表示变更已经生效。'
                    : '已拒绝该提案，系统不会应用这项变更。',
                },
              },
              { tag: 'div', text: { tag: 'plain_text', content: `提案 ID：${input.approvalResult.proposalId}` } },
            ]),
          ],
        },
      }),
    }
  }
  if ('approvalApplication' in input) {
    const terminal = input.approvalApplication
    const presentation = {
      applied: {
        template: 'green',
        icon: 'done_outlined',
        title: '变更已实际生效',
        detail: '领域账本已完成原子结算。',
        summary: '变更已实际生效，领域账本已完成结算',
      },
      conflicted: {
        template: 'yellow',
        icon: 'warning_outlined',
        title: '变更未生效：证据或状态冲突',
        detail: '审批决定已记录，但领域账本拒绝应用过期或冲突的变更。',
        summary: '变更未生效：证据或状态存在冲突',
      },
      expired: {
        template: 'grey',
        icon: 'time_outlined',
        title: '变更未生效：审批已过期',
        detail: '该提案已经过期，领域账本没有应用变更。',
        summary: '变更未生效：该提案审批已过期',
      },
      rejected: {
        template: 'red',
        icon: 'close_outlined',
        title: '变更已拒绝',
        detail: 'owner 已拒绝该提案，领域账本没有应用变更。',
        summary: '变更已拒绝，领域账本未应用变更',
      },
    }[terminal.status]
    const operation = {
      adopt: '采纳学习规则',
      retire: '退役学习规则',
      'owner-undo': '撤销学习规则',
    }[terminal.operation]
    const exactRule = terminal.ruleId === undefined
      ? []
      : [
          { tag: 'div', text: { tag: 'plain_text', content: `规则 ID：${terminal.ruleId}` } },
          ...(terminal.resultingRuleVersion === undefined ? [] : [{
            tag: 'div',
            text: {
              tag: 'plain_text',
              content: `规则版本：${terminal.resultingRuleVersion}；状态：${terminal.ruleStatus ?? '未知'}`,
            },
          }]),
        ]
    const undo = terminal.status === 'applied' && terminal.operation === 'adopt'
      && terminal.ruleId !== undefined && terminal.resultingRuleVersion !== undefined
      ? [{
          tag: 'div',
          text_size: 'notation',
          icon: { tag: 'standard_icon', token: 'info_outlined', color: 'grey' },
          text: {
            tag: 'plain_text',
            content: `可撤销入口：在当前 owner 会话中要求“撤销规则 ${terminal.ruleId} 版本 ${terminal.resultingRuleVersion}”。系统只会创建一张独立的二次审批，不会直接退役规则。`,
            text_color: 'grey',
          },
        }]
      : []
    return {
      msgType: 'interactive',
      content: JSON.stringify({
        schema: '2.0',
        config: {
          update_multi: true,
          enable_forward_interaction: false,
          summary: { content: presentation.summary },
        },
        header: {
          template: presentation.template,
          title: { tag: 'plain_text', content: presentation.title },
          subtitle: { tag: 'plain_text', content: presentation.detail },
          icon: { tag: 'standard_icon', token: presentation.icon },
        },
        body: {
          padding: '12px 12px 16px 12px',
          direction: 'vertical',
          vertical_spacing: '8px',
          elements: [
            surfaceContainer('grey', [
              { tag: 'div', text: { tag: 'plain_text', content: `操作：${operation}（${terminal.operation}）` } },
              { tag: 'div', text: { tag: 'plain_text', content: `Policy 提案：${terminal.policyProposalId}` } },
              { tag: 'div', text: { tag: 'plain_text', content: `领域提案：${terminal.localProposalId}` } },
              ...exactRule,
            ]),
            ...undo,
          ],
        },
      }),
    }
  }
  if ('automationIncident' in input) {
    const incident = input.automationIncident
    const state = {
      open: {
        template: 'red',
        icon: 'warning_outlined',
        title: '自动化故障已打开',
        detail: '该自动化仍处于故障状态。',
        summary: '自动化故障已打开，仍处于故障状态',
      },
      recovering: {
        template: 'blue',
        icon: 'refresh_outlined',
        title: '自动化故障恢复中',
        detail: '已启动受控探针，尚未确认恢复。',
        summary: '自动化故障恢复中，受控探针运行中',
      },
      resolved: {
        template: 'green',
        icon: 'done_outlined',
        title: '自动化故障已恢复',
        detail: '同一故障代次已通过实际运行确认恢复。',
        summary: '自动化故障已恢复，运行验证已通过',
      },
    }[incident.state]
    return {
      msgType: 'interactive',
      content: JSON.stringify({
        schema: '2.0',
        config: {
          update_multi: true,
          enable_forward_interaction: false,
          summary: { content: state.summary },
        },
        header: {
          template: state.template,
          title: { tag: 'plain_text', content: state.title },
          subtitle: { tag: 'plain_text', content: state.detail },
          icon: { tag: 'standard_icon', token: state.icon },
        },
        body: {
          padding: '12px 12px 16px 12px',
          direction: 'vertical',
          vertical_spacing: '8px',
          elements: [
            surfaceContainer('grey', [
              { tag: 'div', text: { tag: 'plain_text', content: `自动化：${incident.automationId}` } },
              {
                tag: 'div',
                text: {
                  tag: 'plain_text',
                  content: `阶段：${incident.stage}；故障：${incident.failureCode}（${incident.failureClass}/${incident.failurePhase}）`,
                },
              },
              {
                tag: 'div',
                text: {
                  tag: 'plain_text',
                  content: `副作用：${incident.sideEffectState}；重试：${incident.retryability}`,
                },
              },
            ]),
            {
              tag: 'div',
              text_size: 'notation',
              icon: { tag: 'standard_icon', token: 'info_outlined', color: 'grey' },
              text: {
                tag: 'plain_text',
                content: `Incident ${incident.incidentId} · generation ${incident.lifecycleGeneration} · revision ${incident.incidentRevision}`,
                text_color: 'grey',
              },
            },
          ],
        },
      }),
    }
  }
  if ('toolApprovalResult' in input) {
    const result = input.toolApprovalResult
    const presentation = {
      'allowed-once': {
        template: 'green' as const,
        icon: 'done_outlined',
        title: '已允许本次操作，任务继续中',
        detail: '本次授权已生效。工具执行结果将在任务后续消息中提供。',
        summary: '已允许本次操作，任务继续中',
      },
      rejected: {
        template: 'red' as const,
        icon: 'close_outlined',
        title: '已拒绝本次操作',
        detail: '本次审批未授权工具执行。',
        summary: '已拒绝本次工具调用授权',
      },
      cancelled: {
        template: 'grey' as const,
        icon: 'info_outlined',
        title: '本次审批已取消',
        detail: '本次审批未授权工具执行，已停止等待确认。',
        summary: '本次工具审批已取消',
      },
      expired: {
        template: 'grey' as const,
        icon: 'time_outlined',
        title: '本次审批已超时',
        detail: '有效期已过，本次审批未授权工具执行。',
        summary: '本次工具审批已超时',
      },
      unavailable: {
        template: 'grey' as const,
        icon: 'info_outlined',
        title: '本次审批已结束',
        detail: '会话或连接已结束，本次审批未授权工具执行。',
        summary: '本次工具审批已结束',
      },
    }[result.status]
    return {
      msgType: 'interactive',
      content: JSON.stringify({
        schema: '2.0',
        config: {
          update_multi: true,
          enable_forward_interaction: false,
          summary: { content: presentation.summary },
        },
        header: {
          template: presentation.template,
          title: { tag: 'plain_text', content: presentation.title },
          subtitle: { tag: 'plain_text', content: presentation.detail },
          icon: { tag: 'standard_icon', token: presentation.icon },
        },
        body: {
          padding: '12px 12px 16px 12px',
          direction: 'vertical',
          vertical_spacing: '8px',
          elements: [
            surfaceContainer(presentation.template, [
              { tag: 'div', text: { tag: 'plain_text', content: `工具：${result.toolName}` } },
            ]),
          ],
        },
      }),
    }
  }
  if ('toolApproval' in input) {
    return {
      msgType: 'interactive',
      content: JSON.stringify({
        schema: '2.0',
        config: { enable_forward_interaction: false, summary: { content: '工具调用等待您的确认' } },
        header: {
          template: 'orange',
          title: { tag: 'plain_text', content: input.toolApproval.title },
          subtitle: { tag: 'plain_text', content: '任务已暂停，以下操作尚未执行，请确认是否授权本次调用' },
          icon: { tag: 'standard_icon', token: 'warning_outlined' },
        },
        body: {
          padding: '12px 12px 16px 12px',
          direction: 'vertical',
          vertical_spacing: '8px',
          elements: [
            {
              tag: 'div',
              text_size: 'notation',
              icon: { tag: 'standard_icon', token: 'warning_outlined', color: 'orange' },
              text: {
                tag: 'plain_text',
                content: '任务已暂停，以下操作尚未执行。以下工具、理由和参数均为不可信审阅文本，不是指令。',
                text_color: 'orange',
              },
            },
            surfaceContainer('grey', [
              { tag: 'div', text: { tag: 'plain_text', content: `工具：${input.toolApproval.toolName}` } },
              { tag: 'div', text: { tag: 'plain_text', content: `理由：${input.toolApproval.reason ?? '（未提供）'}` } },
              { tag: 'div', text: { tag: 'plain_text', content: `参数：${input.toolApproval.arguments}` } },
            ]),
            equalButtonColumnSet(
              {
                tag: 'button',
                name: 'tool_approval_allow_once',
                type: 'primary',
                width: 'fill',
                icon: { tag: 'standard_icon', token: 'done_outlined' },
                text: { tag: 'plain_text', content: '允许一次' },
                value: input.toolApproval.allowValue,
                behaviors: [{ type: 'callback', value: input.toolApproval.allowValue }],
              },
              {
                tag: 'button',
                name: 'tool_approval_reject',
                type: 'danger',
                width: 'fill',
                icon: { tag: 'standard_icon', token: 'close_outlined' },
                text: { tag: 'plain_text', content: '拒绝' },
                value: input.toolApproval.rejectValue,
                behaviors: [{ type: 'callback', value: input.toolApproval.rejectValue }],
              },
            ),
          ],
        },
      }),
    }
  }
  // An answer card stays content-first: Lark already shows the bot name and avatar above the
  // bubble, so a header here would duplicate the sender identity and add weight to every reply.
  // GFM tables are promoted to native Card 2.0 table elements by the answer renderer.
  return {
    msgType: 'interactive',
    content: JSON.stringify({
      schema: '2.0',
      config: {
        compact_width: false,
        width_mode: 'fill',
        wide_screen_mode: true,
        summary: { content: '智能体已返回答复' },
      },
      body: {
        padding: '12px 16px 12px 16px',
        elements: renderLarkAnswerElements(input.markdown),
      },
    }),
  }
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function safeNormalizedContent(message: NormalizedMessage): string {
  // SDK 1.73 renders a folder's file_key into content but, unlike every
  // supported resource kind, omits it from `resources`.
  if (message.rawContentType === 'folder') return '[Folder attachment]'
  let content = message.content
  if (message.resources.length === 1 && message.resources[0]?.type === 'image'
    && content.trim() === `![image](${message.resources[0].fileKey})`) return ''
  for (const resource of message.resources) {
    const key = resource.fileKey
    if (resource.type === 'image') {
      content = content.replaceAll(`![image](${key})`, '[Image attachment]')
    } else {
      const tag = resource.type
      content = content.replace(new RegExp(
        `<${tag}\\b[^>]*\\bkey="${escapedPattern(key)}"[^>]*/>`,
        'gu',
      ), `[${tag[0]!.toUpperCase()}${tag.slice(1)} attachment]`)
    }
    // Defense in depth for future SDK renderings: a provider capability key
    // is never user-facing text and must not cross into the model prompt.
    content = content.replaceAll(key, '[redacted-resource]')
  }
  return content.trim()
}

/** Feishu event payloads mark an application sender as `bot`; the message API may say `app`. */
export function rawSenderIsBot(raw: unknown): boolean {
  const senderType = (raw as { sender?: { sender_type?: unknown } } | null)?.sender?.sender_type
  return typeof senderType === 'string' && ['app', 'bot'].includes(senderType.toLowerCase())
}

export function toSafeLarkMessage(message: NormalizedMessage, senderIsBot = false): LarkMessage {  return {
    messageId: message.messageId,
    chatId: message.chatId,
    chatType: message.chatType,
    senderId: message.senderId,
    ...(senderIsBot ? { senderIsBot: true } : {}),
    content: safeNormalizedContent(message),
    rawContentType: message.rawContentType,
    resources: message.resources,
    mentionAll: message.mentionAll,
    mentionedBot: message.mentionedBot,
    createTime: message.createTime,
    ...(message.rootId === undefined ? {} : { rootId: message.rootId }),
    ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
    ...(message.replyToMessageId === undefined ? {} : { replyToMessageId: message.replyToMessageId }),
  }
}

function providerError(
  result: { code: number | undefined; msg: string | undefined },
  kind: 'message' | 'upload' = 'message',
): LarkTransportError {
  const classified = providerFailureCode(result.code)
  if (classified === 'permission_denied') {
    return new LarkTransportError('permission_denied', 'Lark rejected the application credential or permission')
  }
  if (classified === 'rate_limited' || /rate|frequency|too many/iu.test(result.msg ?? '')) {
    return new LarkTransportError(
      'rate_limited',
      kind === 'upload' ? 'Lark rate limited the file upload' : 'Lark rate limited the message',
    )
  }
  if (classified === 'format_error') {
    return new LarkTransportError(
      'format_error',
      kind === 'upload' ? 'Lark rejected the file upload format' : 'Lark rejected the message card format',
    )
  }
  if (kind === 'upload') {
    return new LarkTransportError('upload_failed', `Lark rejected the file upload with code ${String(result.code ?? 'missing')}`)
  }
  return new LarkTransportError('unknown', `Lark rejected the message with code ${String(result.code ?? 'missing')}`)
}

export class OfficialLarkTransport implements LarkTransport {
  private readonly client: Client
  private readonly imageClient: Client
  private readonly dispatcher: EventDispatcher
  private readonly ws: WSClient
  private readonly handshakeTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly imageDownloadTimeoutMs: number
  private readonly lifecycleController = new AbortController()
  private handlers: LarkTransportHandlers | undefined
  private identity: BotIdentity | undefined
  private pendingHandshake: { resolve(): void; reject(error: Error): void } | undefined

  constructor(options: OfficialLarkTransportOptions) {
    const domain = options.domain === 'lark' ? Domain.Lark : Domain.Feishu
    const shared = { appId: options.appId, appSecret: options.appSecret, domain,
      logger: silentLogger, loggerLevel: LoggerLevel.error, source: 'dsh-ray-lark-channel' }
    this.handshakeTimeoutMs = options.handshakeTimeoutMs
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    this.imageDownloadTimeoutMs = options.imageDownloadTimeoutMs
    this.client = new Client({
      ...shared,
      appType: AppType.SelfBuild,
      httpInstance: boundedHttpInstance(this.requestTimeoutMs, this.lifecycleController.signal),
    })
    this.imageClient = new Client({
      ...shared,
      appType: AppType.SelfBuild,
      httpInstance: boundedHttpInstance(options.imageDownloadTimeoutMs, this.lifecycleController.signal),
    })
    this.dispatcher = new EventDispatcher({ logger: silentLogger, loggerLevel: LoggerLevel.error })
    this.dispatcher.register({
      'im.message.receive_v1': async raw => {
        if (this.handlers === undefined || this.identity === undefined) return
        const message = await normalize(raw as unknown as RawMessageEvent, {
          botIdentity: this.identity,
          stripBotMentions: true,
        })
        await this.handlers.message(toSafeLarkMessage(message, rawSenderIsBot(raw)))
      },
      'im.message.message_read_v1': async (raw: unknown) => {
        if (this.handlers?.readReceipt === undefined) return
        const receipt = normalizeReadReceipt(raw)
        if (receipt === null) return
        try {
          this.handlers.readReceipt(receipt)
        } catch {
          // A read fact is best-effort; one malformed consumer must not stop the WS loop.
        }
      },
      'card.action.trigger': async (raw: unknown) => {
        if (this.handlers === undefined) return
        const action = normalizeCardAction(raw as unknown as RawCardActionEvent)
        if (action === null) return
        return await this.handlers.cardAction({
          messageId: action.messageId,
          chatId: action.chatId,
          operatorId: action.operator.openId,
          value: action.action.value,
          tag: action.action.tag,
          ...(action.action.name === undefined ? {} : { name: action.action.name }),
          ...(action.action.option === undefined ? {} : { option: action.action.option }),
        })
      },
    })
    this.ws = new WSClient({
      ...shared,
      autoReconnect: true,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
      onReady: () => this.pendingHandshake?.resolve(),
      onError: error => {
        const normalized = new LarkTransportError('not_connected', 'Lark WebSocket connection failed')
        if (this.pendingHandshake !== undefined) this.pendingHandshake.reject(normalized)
        else this.handlers?.error(normalized)
        void error
      },
      onReconnecting: () => this.handlers?.reconnecting(),
      onReconnected: () => this.handlers?.reconnected(),
    })
    installLarkCardCallbackBridge(this.ws)
  }

  subscribe(handlers: LarkTransportHandlers): () => void {
    if (this.handlers !== undefined) throw new Error('lark-channel: transport is already subscribed')
    this.handlers = handlers
    return () => { if (this.handlers === handlers) this.handlers = undefined }
  }

  async connect(): Promise<void> {
    this.identity = await this.fetchBotIdentity()
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.pendingHandshake = undefined
        this.ws.close({ force: true })
        reject(new LarkTransportError('not_connected', 'Lark WebSocket handshake timed out'))
      }, this.handshakeTimeoutMs + 1_000)
      timer.unref?.()
      this.pendingHandshake = {
        resolve: () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.pendingHandshake = undefined
          resolve()
        },
        reject: error => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.pendingHandshake = undefined
          reject(error)
        },
      }
      void this.ws.start({ eventDispatcher: this.dispatcher }).catch(error => {
        void error
        this.pendingHandshake?.reject(new LarkTransportError('not_connected', 'Lark WebSocket startup failed'))
      })
    })
  }

  async disconnect(): Promise<void> {
    this.lifecycleController.abort(new Error('lark-channel: transport stopped'))
    this.pendingHandshake?.reject(new LarkTransportError('not_connected', 'Lark transport stopped'))
    this.ws.close({ force: true })
  }

  private requestDeadline(callerSignal?: AbortSignal): {
    signal: AbortSignal
    timeoutSignal: AbortSignal
    dispose(): void
  } {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('lark-channel: OpenAPI request deadline exceeded')), this.requestTimeoutMs)
    timer.unref?.()
    const timeoutSignal = controller.signal
    const signals = callerSignal === undefined
      ? [timeoutSignal, this.lifecycleController.signal]
      : [callerSignal, timeoutSignal, this.lifecycleController.signal]
    return { signal: AbortSignal.any(signals), timeoutSignal, dispose: () => clearTimeout(timer) }
  }

  private async boundedSdkRequest<T>(
    request: (signal: AbortSignal) => Promise<T>,
    failureMessage: string,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const deadline = this.requestDeadline(callerSignal)
    let started = false
    try {
      return await awaitBoundedSdkRequest(deadline.signal, () => {
        started = true
        return request(deadline.signal)
      })
    } catch (error) {
      if (deadline.timeoutSignal.aborted) {
        // A timeout can happen after the provider has accepted the request.
        // The Delivery adapter deliberately maps send_timeout to unknown_after_send.
        throw new LarkTransportError('send_timeout', `${failureMessage} timed out`)
      }
      if (callerSignal?.aborted || this.lifecycleController.signal.aborted) {
        if (started) {
          throw new LarkTransportError('unknown', `${failureMessage} outcome is unknown after cancellation`)
        }
        throw new LarkTransportError('not_connected', `${failureMessage} was cancelled`)
      }
      if (error instanceof LarkTransportError) throw error
      const classified = classifyLarkSdkFailure(error)
      throw new LarkTransportError(classified.code, `${failureMessage} failed`, classified.retryAfterMs)
    } finally {
      deadline.dispose()
    }
  }

  async downloadMessageImage(
    messageId: string,
    fileKey: string,
    options: { maxBytes: number; signal: AbortSignal },
  ): Promise<{ data: Uint8Array; mediaType: LarkImageMediaType }> {
    const timeoutSignal = AbortSignal.timeout(this.imageDownloadTimeoutMs)
    const signal = AbortSignal.any([options.signal, timeoutSignal, this.lifecycleController.signal])
    let response: LarkImageResourceResponse
    try {
      response = await awaitImageResourceRequest(signal, async () => await this.imageClient.request<LarkImageResourceResponse>(
        createLarkImageResourceRequest(messageId, fileKey, {
          maxBytes: options.maxBytes, timeoutMs: this.imageDownloadTimeoutMs, signal,
        }),
      ))
    } catch (error) {
      if (options.signal.aborted) {
        throw new LarkTransportError('not_connected', 'Lark image resource request was cancelled')
      }
      if (this.lifecycleController.signal.aborted) {
        throw new LarkTransportError('not_connected', 'Lark image resource request was cancelled')
      }
      if (timeoutSignal.aborted) {
        throw new LarkTransportError('send_timeout', 'Lark image resource request timed out')
      }
      const classified = await classifyLarkImageSdkFailure(error, signal)
      if (options.signal.aborted || this.lifecycleController.signal.aborted) {
        throw new LarkTransportError('not_connected', 'Lark image resource request was cancelled')
      }
      if (timeoutSignal.aborted) {
        throw new LarkTransportError('send_timeout', 'Lark image resource request timed out')
      }
      throw new LarkTransportError(classified.code, 'Lark image resource request failed', classified.retryAfterMs)
    }
    try {
      const image = await readLarkImageResourceResponse(response, { maxBytes: options.maxBytes, signal })
      if (options.signal.aborted || this.lifecycleController.signal.aborted) {
        throw new LarkTransportError('not_connected', 'Lark image resource request was cancelled')
      }
      if (timeoutSignal.aborted) {
        throw new LarkTransportError('send_timeout', 'Lark image resource request timed out')
      }
      return image
    } catch (error) {
      if (options.signal.aborted) {
        throw new LarkTransportError('not_connected', 'Lark image resource request was cancelled')
      }
      if (this.lifecycleController.signal.aborted) {
        throw new LarkTransportError('not_connected', 'Lark image resource request was cancelled')
      }
      if (timeoutSignal.aborted) {
        throw new LarkTransportError('send_timeout', 'Lark image resource request timed out')
      }
      const classified = error instanceof LarkImageResponseValidationError
        ? { code: 'format_error' as const }
        : classifyLarkSdkFailure(error)
      const message = classified.code === 'format_error'
        ? 'Lark image resource response failed validation'
        : 'Lark image resource response could not be read'
      throw new LarkTransportError(classified.code, message, classified.retryAfterMs)
    }
  }

  async readCalendarEventPage(input: Readonly<{
    calendarId: string
    startTime: number
    endTime: number
    pageSize: number
    pageToken?: string
    signal: AbortSignal
  }>): Promise<unknown> {
    if (!/^[\s\S]{1,512}$/u.test(input.calendarId) || input.calendarId.trim() !== input.calendarId || /[\p{Cc}]/u.test(input.calendarId)
      || !Number.isSafeInteger(input.startTime) || !Number.isSafeInteger(input.endTime) || input.startTime < 0 || input.endTime <= input.startTime
      || !Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 1_000
      || (input.pageToken !== undefined && (input.pageToken.length === 0 || input.pageToken.length > 4_096 || /[\p{Cc}]/u.test(input.pageToken)))) {
      throw new LarkTransportError('format_error', 'Lark calendar request is invalid')
    }
    if (input.signal.aborted || this.lifecycleController.signal.aborted) {
      throw new LarkTransportError('not_connected', 'Lark calendar request was cancelled')
    }
    return await this.boundedSdkRequest(async deadlineSignal => {
      const params = new URLSearchParams({ page_size: String(input.pageSize), start_time: String(input.startTime), end_time: String(input.endTime) })
      if (input.pageToken !== undefined) params.set('page_token', input.pageToken)
      const response = await this.client.request<unknown>({
        url: `/open-apis/calendar/v4/calendars/${encodeURIComponent(input.calendarId)}/events?${params.toString()}`,
        method: 'GET', signal: deadlineSignal,
        maxContentLength: 1_048_576, maxBodyLength: 1_048_576,
      })
      if (response !== null && typeof response === 'object' && 'code' in response) {
        const code = (response as { code?: unknown }).code
        if (code !== undefined && code !== 0) throw providerError({ code: typeof code === 'number' ? code : undefined, msg: undefined })
      }
      const data = response !== null && typeof response === 'object' && 'data' in response
        ? (response as { data?: unknown }).data : undefined
      if (data === undefined) throw new LarkTransportError('unknown', 'Lark calendar response omitted data')
      return data
    }, 'Lark calendar request', input.signal)
  }

  async addReaction(messageId: string, emojiType: string): Promise<string> {
    return await this.boundedSdkRequest(async deadlineSignal => {
      const response = await this.client.request<{
        code?: number
        msg?: string
        data?: { reaction_id?: string }
      }>(createLarkReactionRequest(messageId, emojiType, deadlineSignal))
      if (response.code !== undefined && response.code !== 0) {
        throw providerError({ code: response.code, msg: response.msg })
      }
      const reactionId = response.data?.reaction_id
      if (reactionId === undefined || reactionId === '') {
        throw new LarkTransportError('unknown', 'Lark accepted reaction omitted reaction identity')
      }
      return reactionId
    }, 'Lark reaction request')
  }

  async createProgress(chatId: string, options: { replyTo: string; hidden: boolean }): Promise<LarkProgressHandle> {
    return await this.boundedSdkRequest(async deadlineSignal => {
      const response = await this.client.request<{
        code?: number
        msg?: string
        data?: { cot_id?: string; message_id?: string }
      }>(createLarkProgressRequest(chatId, options, deadlineSignal))
      if (response.code !== undefined && response.code !== 0) {
        throw providerError({ code: response.code, msg: response.msg })
      }
      const cotId = response.data?.cot_id
      const messageId = response.data?.message_id
      if (cotId === undefined || messageId === undefined) {
        throw new LarkTransportError('unknown', 'Lark accepted progress request omitted progress identity')
      }
      return { cotId, messageId }
    }, 'Lark progress request')
  }

  async writeProgress(handle: LarkProgressHandle, events: readonly LarkProgressEvent[]): Promise<void> {
    await this.boundedSdkRequest(async deadlineSignal => {
      const response = await this.client.request<{ code?: number; msg?: string }>(
        writeLarkProgressRequest(handle, events, deadlineSignal),
      )
      if (response.code !== undefined && response.code !== 0) {
        throw providerError({ code: response.code, msg: response.msg })
      }
    }, 'Lark progress update')
  }

  async updateRawCard(
    messageId: string,
    card: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted || this.lifecycleController.signal.aborted) {
      throw new LarkTransportError('not_connected', 'Lark card update was cancelled')
    }
    await this.boundedSdkRequest(async deadlineSignal => {
      const response = await this.client.request<{ code?: number; msg?: string }>(
        createLarkRawCardUpdateRequest(messageId, card, deadlineSignal),
      )
      if (response.code !== undefined && response.code !== 0) {
        throw providerError({ code: response.code, msg: response.msg })
      }
    }, 'Lark card update', signal)
  }

  async uploadTextFile(input: LarkTextFileUploadInput): Promise<string> {
    if (input.signal.aborted || this.lifecycleController.signal.aborted) {
      throw new LarkTransportError('not_connected', 'Lark file upload was cancelled')
    }
    const maxBytes = input.maxBytes ?? LARK_TEXT_FILE_MAX_BYTES
    // Validate input bounds and build the payload once before entering boundedSdkRequest / acquiring token.
    const baseRequest = createLarkTextFileUploadRequest({
      name: input.name,
      mediaType: input.mediaType,
      text: input.text,
      timeoutMs: this.requestTimeoutMs,
      maxBytes,
      signal: input.signal,
    })
    try {
      return await this.boundedSdkRequest(async deadlineSignal => {
        const response = await this.client.request<{
          code?: number
          msg?: string
          data?: { file_key?: string }
        }>({ ...baseRequest, signal: deadlineSignal })
        if (response === null || typeof response !== 'object') {
          throw new LarkTransportError('upload_failed', 'Lark file upload response was invalid')
        }
        if (response.code !== undefined && response.code !== 0) {
          throw providerError({ code: response.code, msg: response.msg }, 'upload')
        }
        const fileKey = response.data?.file_key
        if (typeof fileKey !== 'string' || !larkResourceIdentifier.test(fileKey)) {
          throw new LarkTransportError('upload_failed', 'Lark file upload response omitted valid file identity')
        }
        return fileKey
      }, 'Lark file upload', input.signal)
    } catch (error) {
      if (input.signal.aborted || this.lifecycleController.signal.aborted) {
        throw new LarkTransportError('not_connected', 'Lark file upload was cancelled')
      }
      if (error instanceof LarkTransportError) {
        if (error.code === 'unknown') {
          throw new LarkTransportError('upload_failed', 'Lark file upload failed')
        }
        throw error
      }
      throw new LarkTransportError('upload_failed', 'Lark file upload failed')
    }
  }

  async send(chatId: string, input: LarkSendInput, options: LarkSendOptions = {}): Promise<LarkSendResult> {
    if (options.signal?.aborted || this.lifecycleController.signal.aborted) {
      throw new LarkTransportError('not_connected', 'Lark SDK request was cancelled')
    }
    const rendered = renderLarkMessage(input)
    const uuid = larkRequestUuid(options.requestKey ?? `${chatId}:${rendered.content}`)
    return await this.boundedSdkRequest(async deadlineSignal => {
      const response = await this.client.request<{
        code?: number
        msg?: string
        data?: { message_id?: string }
      }>(createLarkMessageSendRequest(chatId, rendered, uuid, options, deadlineSignal))
      if (response.code !== 0) throw providerError({ code: response.code, msg: response.msg })
      const messageId = response.data?.message_id
      if (messageId === undefined) throw new LarkTransportError('unknown', 'Lark accepted response omitted message identity')
      return { messageId }
    }, 'Lark SDK request', options.signal)
  }

  private async fetchBotIdentity(): Promise<BotIdentity> {
    return await this.boundedSdkRequest(async deadlineSignal => {
      const response = await this.client.request<{ bot?: { open_id?: string; app_name?: string } }>({
        url: '/open-apis/bot/v3/info', method: 'GET', signal: deadlineSignal,
      })
      if (response.bot?.open_id === undefined) {
        throw new LarkTransportError('permission_denied', 'Lark bot identity is unavailable')
      }
      return { openId: response.bot.open_id, name: response.bot.app_name ?? 'bot' }
    }, 'Lark bot identity request')
  }
}

export function createOfficialLarkTransport(options: OfficialLarkTransportOptions): LarkTransport {
  return new OfficialLarkTransport(options)
}
