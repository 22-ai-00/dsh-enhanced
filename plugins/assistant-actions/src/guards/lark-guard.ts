import { createHash } from 'node:crypto'
import type {
  LarkGrantDestination,
  LarkReadPayload,
  LarkRequestDestination,
  LarkSendPayload,
} from '../broker-protocol-v2.js'
import type { BrokerJson } from '../broker-protocol.js'
import {
  isSafeUrlPathSegment,
  resolveAndPinHttpAddress,
  responseContainsSecret,
  validateStrictHttpUrl,
  type HttpDnsLookup,
  type HttpTransportFn,
} from './http-guard.js'

export interface LarkTransportInput {
  readonly operation: 'lark.send-message' | 'lark.reply-message' | 'lark.read-messages'
  readonly apiBaseUrl: string
  readonly pinnedAddress: string
  readonly pinnedFamily: 4 | 6
  readonly tenantKey: string
  readonly payload: LarkSendPayload | LarkReadPayload
  readonly token: string
  readonly timeoutMs: number
  readonly signal: AbortSignal
}

export interface LarkTransportResult {
  readonly messageId?: string
  readonly chatId?: string
  readonly observed?: BrokerJson
}

export type LarkTransportFn = (input: LarkTransportInput) => Promise<LarkTransportResult>

export interface LarkGuardDeps {
  readonly lookup?: HttpDnsLookup
  readonly requestImpl?: HttpTransportFn
  readonly transport?: LarkTransportFn
  readonly secrets?: readonly string[]
}

export class LarkGuardError extends Error {
  constructor(
    readonly code: 'request-invalid' | 'grant-invalid' | 'transport-failed' | 'response-secret-leak',
    readonly dispatched: boolean,
    message: string,
  ) {
    super(`assistant-actions lark guard: ${message}`)
    this.name = 'LarkGuardError'
  }
}

export function validateLarkAgainstGrant(
  operation: 'lark.send-message' | 'lark.reply-message' | 'lark.read-messages',
  grantDest: LarkGrantDestination,
  reqDest: LarkRequestDestination,
  payload: LarkSendPayload | LarkReadPayload,
): { apiUrl: URL } {
  if (reqDest.tenantKey !== grantDest.tenantKey) {
    throw new LarkGuardError('grant-invalid', false, 'Lark tenantKey mismatch')
  }
  if (!isSafeUrlPathSegment(reqDest.receiveId)) {
    throw new LarkGuardError('request-invalid', false, 'Lark receiveId contains forbidden path or URL characters')
  }
  const apiUrl = validateStrictHttpUrl(grantDest.apiBaseUrl)
  if (apiUrl.protocol !== 'https:' && grantDest.allowPrivateNetwork !== true) {
    throw new LarkGuardError('grant-invalid', false, 'Lark apiBaseUrl must use https unless allowPrivateNetwork is true')
  }

  if (operation === 'lark.send-message' || operation === 'lark.reply-message') {
    const send = payload as LarkSendPayload
    if (send.receiveIdType !== reqDest.receiveIdType || send.receiveId !== reqDest.receiveId) {
      throw new LarkGuardError('request-invalid', false, 'Lark destination does not match payload')
    }
    if (!isSafeUrlPathSegment(send.receiveId)) {
      throw new LarkGuardError('request-invalid', false, 'Lark receiveId contains forbidden path or URL characters')
    }
    if (send.receiveIdType === 'chat_id') {
      if (!grantDest.allowedChatIds.includes(send.receiveId)) {
        throw new LarkGuardError('grant-invalid', false, 'Lark chat_id is not permitted by grant')
      }
    } else if (!grantDest.allowedOpenIds?.includes(send.receiveId)) {
      throw new LarkGuardError('grant-invalid', false, 'Lark open_id is not permitted by grant')
    }
    if (!grantDest.allowedMsgTypes.includes(send.msgType)) {
      throw new LarkGuardError('grant-invalid', false, 'Lark msgType is not permitted by grant')
    }
    if (Buffer.byteLength(send.content, 'utf8') > grantDest.maxTextBytes) {
      throw new LarkGuardError('grant-invalid', false, 'Lark content exceeds maxTextBytes')
    }
    if (operation === 'lark.reply-message' && !send.replyToMessageId) {
      throw new LarkGuardError('request-invalid', false, 'Lark reply requires replyToMessageId')
    }
    if (send.replyToMessageId !== undefined && !isSafeUrlPathSegment(send.replyToMessageId)) {
      throw new LarkGuardError('request-invalid', false, 'Lark replyToMessageId contains forbidden path or URL characters')
    }
  } else {
    const read = payload as LarkReadPayload
    if (!isSafeUrlPathSegment(read.chatId)) {
      throw new LarkGuardError('request-invalid', false, 'Lark chatId contains forbidden path or URL characters')
    }
    if (read.threadId !== undefined && !isSafeUrlPathSegment(read.threadId)) {
      throw new LarkGuardError('request-invalid', false, 'Lark threadId contains forbidden path or URL characters')
    }
    if (reqDest.receiveIdType !== 'chat_id' || reqDest.receiveId !== read.chatId) {
      throw new LarkGuardError('request-invalid', false, 'Lark destination does not match read chatId')
    }
    if (!grantDest.allowedChatIds.includes(read.chatId)) {
      throw new LarkGuardError('grant-invalid', false, 'Lark chatId is not permitted for read')
    }
  }
  return { apiUrl }
}

export function deterministicLarkUuid(actionId: string, suppliedUuid: string): string {
  return createHash('sha256').update(`lark-uuid:${actionId}:${suppliedUuid}`).digest('hex').slice(0, 36)
}

export async function executeLarkGuardedAction(input: {
  readonly actionId: string
  readonly operation: 'lark.send-message' | 'lark.reply-message' | 'lark.read-messages'
  readonly grantDestination: LarkGrantDestination
  readonly requestDestination: LarkRequestDestination
  readonly payload: LarkSendPayload | LarkReadPayload
  readonly token: string
  readonly timeoutMs: number
  readonly signal: AbortSignal
  readonly deps?: LarkGuardDeps
}): Promise<{
  readonly domain: 'lark'
  readonly operation: 'lark.send-message' | 'lark.reply-message' | 'lark.read-messages'
  readonly messageId?: string
  readonly chatId?: string
  readonly observed?: BrokerJson
  readonly observedDigest?: string
  readonly untrusted: true
}> {
  const { apiUrl } = validateLarkAgainstGrant(input.operation, input.grantDestination, input.requestDestination, input.payload)
  const host = apiUrl.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  const pinned = await resolveAndPinHttpAddress(host, input.grantDestination.allowPrivateNetwork === true, input.deps?.lookup)

  const secrets = [...(input.deps?.secrets ?? []), ...(input.token ? [input.token] : [])]
  if (responseContainsSecret(JSON.stringify(input.payload), secrets)) {
    throw new LarkGuardError('request-invalid', false, 'Lark payload contains a protected secret or credential shape')
  }

  let transportResult: LarkTransportResult
  if (input.deps?.transport) {
    transportResult = await input.deps.transport({
      operation: input.operation,
      apiBaseUrl: input.grantDestination.apiBaseUrl,
      pinnedAddress: pinned.address,
      pinnedFamily: pinned.family,
      tenantKey: input.grantDestination.tenantKey,
      payload: input.payload,
      token: input.token,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    })
  } else {
    const requestImpl = input.deps?.requestImpl
    const basePath = apiUrl.pathname.replace(/\/+$/u, '')
    let endpointUrl: URL
    let method: 'GET' | 'POST'
    let body: string | undefined
    if (input.operation === 'lark.send-message') {
      const send = input.payload as LarkSendPayload
      endpointUrl = new URL(`${apiUrl.origin}${basePath}/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(send.receiveIdType)}`)
      method = 'POST'
      body = JSON.stringify({
        receive_id: send.receiveId,
        msg_type: send.msgType,
        content: send.content,
        uuid: deterministicLarkUuid(input.actionId, send.uuid),
      })
    } else if (input.operation === 'lark.reply-message') {
      const send = input.payload as LarkSendPayload
      endpointUrl = new URL(`${apiUrl.origin}${basePath}/open-apis/im/v1/messages/${encodeURIComponent(send.replyToMessageId!)}/reply`)
      method = 'POST'
      body = JSON.stringify({
        msg_type: send.msgType,
        content: send.content,
        uuid: deterministicLarkUuid(input.actionId, send.uuid),
      })
    } else {
      const read = input.payload as LarkReadPayload
      const params = new URLSearchParams({
        container_id_type: 'chat',
        container_id: read.chatId,
        page_size: String(read.pageSize),
      })
      if (read.pageToken) params.set('page_token', read.pageToken)
      endpointUrl = new URL(`${apiUrl.origin}${basePath}/open-apis/im/v1/messages?${params.toString()}`)
      method = 'GET'
    }
    const { executeHttpGuardedAction } = await import('./http-guard.js')
    const httpGrant = {
      classification: 'http-endpoint' as const,
      allowedSchemes: [apiUrl.protocol === 'https:' ? 'https' : 'http'] as readonly ('https' | 'http')[],
      allowedHosts: [host],
      ...(apiUrl.port ? { allowedPorts: [Number(apiUrl.port)] } : {}),
      allowedMethods: [method],
      allowedPathPrefixes: [
        input.operation === 'lark.reply-message'
          ? `${basePath}/open-apis/im/v1/messages/${encodeURIComponent((input.payload as LarkSendPayload).replyToMessageId!)}/reply`
          : `${basePath}/open-apis/im/v1/messages`,
      ],
      allowRedirects: false as const,
      allowPrivateNetwork: input.grantDestination.allowPrivateNetwork === true,
      maxResponseBytes: 1_048_576,
      authHeader: 'authorization',
      authScheme: 'Bearer',
    }
    const httpReqDest = {
      classification: 'http-endpoint' as const,
      scheme: (apiUrl.protocol === 'https:' ? 'https' : 'http') as 'https' | 'http',
      host,
      ...(apiUrl.port ? { port: Number(apiUrl.port) } : {}),
      path: endpointUrl.pathname,
    }
    const httpResult = await executeHttpGuardedAction({
      grantDestination: httpGrant,
      requestDestination: httpReqDest,
      payload: {
        method,
        url: endpointUrl.toString(),
        headers: { 'content-type': 'application/json; charset=utf-8' },
        ...(body === undefined ? {} : { body }),
      },
      token: input.token,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      deps: {
        ...(input.deps?.lookup === undefined ? {} : { lookup: input.deps.lookup }),
        ...(requestImpl === undefined ? {} : { requestImpl }),
        secrets,
      },
    })
    if (httpResult.statusCode < 200 || httpResult.statusCode >= 300) {
      throw new LarkGuardError('transport-failed', true, `Lark API returned HTTP ${httpResult.statusCode}`)
    }
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(httpResult.body) as Record<string, unknown>
    } catch {
      throw new LarkGuardError('transport-failed', true, 'Lark API returned non-JSON response')
    }
    const data = parsed.data as Record<string, unknown> | undefined
    transportResult = {
      ...(typeof data?.message_id === 'string' ? { messageId: data.message_id } : {}),
      ...(typeof data?.chat_id === 'string' ? { chatId: data.chat_id } : {}),
      observed: parsed as BrokerJson,
    }
  }

  const serializedObserved = transportResult.observed === undefined ? undefined : JSON.stringify(transportResult.observed)
  if (serializedObserved && responseContainsSecret(serializedObserved, secrets)) {
    throw new LarkGuardError('response-secret-leak', true, 'Lark response contained protected secret')
  }
  const observedDigest = serializedObserved === undefined ? undefined : createHash('sha256').update(serializedObserved).digest('hex')

  return Object.freeze({
    domain: 'lark',
    operation: input.operation,
    ...(transportResult.messageId === undefined ? {} : { messageId: transportResult.messageId }),
    ...(transportResult.chatId === undefined ? {} : { chatId: transportResult.chatId }),
    ...(transportResult.observed === undefined ? {} : { observed: transportResult.observed }),
    ...(observedDigest === undefined ? {} : { observedDigest }),
    untrusted: true,
  })
}
