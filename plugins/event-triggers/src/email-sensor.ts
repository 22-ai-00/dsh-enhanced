import { createHash } from 'node:crypto'
import type { EmailProtocol } from './config.js'
import {
  readHttpJsonWithMeta,
  selectJsonPointer,
  type Fetcher,
  type Lookup,
  type OperationTracker,
  type SensorObservation,
} from './sensors.js'
import type { TriggerCursor } from './store.js'

export interface EmailObservationInput {
  url: string
  protocol: EmailProtocol
  accountId?: string
  mailboxId?: string
  messagesPointer?: string
  fromFilter?: readonly string[]
  subjectContains?: string
  unreadOnly: boolean
  maxMessages: number
  token?: string
  cursor?: Readonly<TriggerCursor>
  hasBaseline?: boolean
  maxBodyBytes: number
  timeoutMs: number
  allowedHosts?: ReadonlySet<string>
  allowedOrigins?: ReadonlySet<string>
  allowIpv6?: boolean
  fetcher?: Fetcher
  lookup?: Lookup
  trackOperation?: OperationTracker
  signal?: AbortSignal
  beforeRequest?: () => void | Promise<void>
}

export interface EmailObservation extends SensorObservation {
  readonly notModified?: boolean
  readonly nextCursor?: TriggerCursor
}

interface ProjectedEmail {
  readonly uid: string
  readonly threadId?: string
  readonly receivedAtMs?: number
  readonly flagsDigest: string
  readonly fromDomain?: string
  readonly fromDigest?: string
  readonly subjectDigest?: string
  readonly snippetDigest?: string
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function boundedText(value: unknown, field: string, max = 512): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  if (typeof value !== 'string') throw new Error(`event-triggers: email ${field} must be a string`)
  const normalized = value.normalize('NFC').trim()
  if (normalized.length === 0 || normalized.length > max || /[\p{Cc}]/u.test(normalized)) {
    throw new Error(`event-triggers: email ${field} is invalid`)
  }
  return normalized
}

function optionalBoundedText(value: unknown, max = 512): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  if (typeof value !== 'string') throw new Error('event-triggers: email field must be a string')
  const normalized = value.normalize('NFC').trim()
  if (normalized.length === 0) return undefined
  if (normalized.length > max || /[\p{Cc}]/u.test(normalized)) {
    throw new Error('event-triggers: email field is invalid')
  }
  return normalized
}

function parseReceivedAtMs(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('event-triggers: email receivedAt is invalid')
    return value
  }
  if (typeof value === 'string') {
    if (/^[0-9]+$/u.test(value.trim())) {
      const numeric = Number(value.trim())
      if (!Number.isSafeInteger(numeric) || numeric < 0) throw new Error('event-triggers: email receivedAt is invalid')
      return numeric
    }
    const ms = Date.parse(value)
    if (!Number.isFinite(ms) || ms < 0) throw new Error('event-triggers: email receivedAt is invalid')
    return ms
  }
  throw new Error('event-triggers: email receivedAt is invalid')
}

function extractSenderAddress(rawFrom: unknown): string | undefined {
  if (rawFrom === undefined || rawFrom === null) return undefined
  if (typeof rawFrom === 'string') {
    const trimmed = rawFrom.trim()
    if (trimmed.length === 0) return undefined
    const angleMatch = /<([^<>@\s]+@[^<>@\s]+)>/u.exec(trimmed)
    const candidate = (angleMatch ? angleMatch[1]! : trimmed).toLowerCase()
    return candidate.includes('@') ? candidate : undefined
  }
  if (Array.isArray(rawFrom)) {
    for (const entry of rawFrom) {
      const found = extractSenderAddress(entry)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (isPlainObject(rawFrom)) {
    const email = rawFrom['email'] ?? rawFrom['address']
    if (typeof email === 'string' && email.trim().length > 0) {
      return email.trim().toLowerCase()
    }
  }
  return undefined
}

function extractFlags(raw: Record<string, unknown>): { flags: string[]; unread: boolean } {
  if (isPlainObject(raw['keywords'])) {
    const entries = Object.entries(raw['keywords'])
      .filter(([, enabled]) => enabled === true)
      .map(([keyword]) => keyword.trim().toLowerCase())
      .filter(keyword => keyword.length > 0)
      .sort()
    const unread = !entries.includes('$seen') && raw['unread'] !== false
    return { flags: entries, unread }
  }
  const rawList = Array.isArray(raw['flags'])
    ? raw['flags']
    : Array.isArray(raw['labels'])
      ? raw['labels']
      : Array.isArray(raw['keywords'])
        ? raw['keywords']
        : undefined
  const flags = rawList !== undefined
    ? rawList
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim().toLowerCase())
      .filter(item => item.length > 0)
      .sort()
    : []
  let unread: boolean
  if (typeof raw['unread'] === 'boolean') {
    unread = raw['unread']
  } else if (typeof raw['isRead'] === 'boolean') {
    unread = !raw['isRead']
  } else {
    unread = !flags.includes('\\seen') && !flags.includes('$seen') && !flags.includes('seen') && !flags.includes('read')
  }
  return { flags, unread }
}

function matchesFromFilter(address: string | undefined, filters: readonly string[]): boolean {
  if (address === undefined) return false
  return filters.some(rule => (rule.startsWith('@') ? address.endsWith(rule) : address === rule))
}

function extractJmapResponses(payload: unknown): { list: unknown[]; queryState?: string; getState?: string } {
  if (!isPlainObject(payload) || !Array.isArray(payload['methodResponses'])) {
    throw new Error('event-triggers: JMAP response must contain methodResponses')
  }
  let queryResult: Record<string, unknown> | undefined
  let getResult: Record<string, unknown> | undefined
  for (const item of payload['methodResponses']) {
    if (!Array.isArray(item) || item.length < 3) {
      throw new Error('event-triggers: JMAP methodResponse entry is malformed')
    }
    const [methodName, body, callId] = item as [unknown, unknown, unknown]
    if (methodName === 'error') {
      throw new Error('event-triggers: JMAP server returned method error')
    }
    if (methodName === 'Email/query' && callId === 'q0' && isPlainObject(body)) {
      queryResult = body
    } else if (methodName === 'Email/get' && callId === 'g0' && isPlainObject(body)) {
      getResult = body
    }
  }
  if (queryResult === undefined || getResult === undefined || !Array.isArray(getResult['list'])) {
    throw new Error('event-triggers: JMAP response missing Email/query or Email/get list')
  }
  const queryState = optionalBoundedText(queryResult['queryState'], 1_024)
  const getState = optionalBoundedText(getResult['state'], 1_024)
  return {
    list: getResult['list'],
    ...(queryState === undefined ? {} : { queryState }),
    ...(getState === undefined ? {} : { getState }),
  }
}

export async function readEmailObservation(input: EmailObservationInput): Promise<EmailObservation> {
  if (!Number.isSafeInteger(input.maxMessages) || input.maxMessages < 1 || input.maxMessages > 500) {
    throw new Error('event-triggers: email maxMessages is invalid')
  }
  if (input.protocol === 'jmap' && (input.accountId === undefined || input.accountId.length === 0)) {
    throw new Error('event-triggers: JMAP email observation requires accountId')
  }
  if (input.signal?.aborted) {
    throw (input.signal.reason instanceof Error ? input.signal.reason : new Error('event-triggers: email sensor aborted'))
  }

  const headers: Record<string, string> = { accept: 'application/json' }
  if (input.token !== undefined && input.token.length > 0) {
    headers['authorization'] = `Bearer ${input.token}`
  }

  let rawMessages: unknown[]
  let etag: string | undefined
  let historyId: string | undefined
  let uidValidity: string | undefined
  let jmapState: string | undefined

  if (input.protocol === 'jmap') {
    const filter: Record<string, unknown> = {}
    if (input.mailboxId !== undefined) filter['inMailbox'] = input.mailboxId
    if (input.unreadOnly) filter['notKeyword'] = '$seen'
    const requestBody = JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/query', {
          accountId: input.accountId,
          filter,
          sort: [{ property: 'receivedAt', isAscending: false }],
          limit: input.maxMessages,
        }, 'q0'],
        ['Email/get', {
          accountId: input.accountId,
          '#ids': { resultOf: 'q0', name: 'Email/query', path: '/ids' },
          properties: ['id', 'threadId', 'receivedAt', 'keywords', 'from', 'subject', 'preview'],
        }, 'g0'],
      ],
    })
    headers['content-type'] = 'application/json'
    await input.beforeRequest?.()
    const response = await readHttpJsonWithMeta({
      url: input.url,
      method: 'POST',
      body: requestBody,
      maxBodyBytes: input.maxBodyBytes,
      timeoutMs: input.timeoutMs,
      ...(input.allowedHosts === undefined ? {} : { allowedHosts: input.allowedHosts }),
      ...(input.allowedOrigins === undefined ? {} : { allowedOrigins: input.allowedOrigins }),
      ...(input.allowIpv6 === undefined ? {} : { allowIpv6: input.allowIpv6 }),
      ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
      ...(input.lookup === undefined ? {} : { lookup: input.lookup }),
      ...(input.trackOperation === undefined ? {} : { trackOperation: input.trackOperation }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      headers,
      rejectPagination: true,
    })
    await input.beforeRequest?.()
    const jmap = extractJmapResponses(response.value)
    rawMessages = jmap.list
    jmapState = jmap.queryState ?? jmap.getState
    etag = response.etag
  } else {
    await input.beforeRequest?.()
    const response = await readHttpJsonWithMeta({
      url: input.url,
      method: 'GET',
      maxBodyBytes: input.maxBodyBytes,
      timeoutMs: input.timeoutMs,
      ...(input.allowedHosts === undefined ? {} : { allowedHosts: input.allowedHosts }),
      ...(input.allowedOrigins === undefined ? {} : { allowedOrigins: input.allowedOrigins }),
      ...(input.allowIpv6 === undefined ? {} : { allowIpv6: input.allowIpv6 }),
      ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
      ...(input.lookup === undefined ? {} : { lookup: input.lookup }),
      ...(input.trackOperation === undefined ? {} : { trackOperation: input.trackOperation }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      headers,
      rejectPagination: true,
      allowNotModified: Boolean(input.hasBaseline),
      ...(input.hasBaseline && input.cursor?.etag !== undefined ? { ifNoneMatch: input.cursor.etag } : {}),
    })
    await input.beforeRequest?.()

    if (response.notModified) {
      const nextCursor: TriggerCursor = {
        ...input.cursor,
        ...(response.etag === undefined ? {} : { etag: response.etag }),
      }
      return Object.freeze({
        fingerprint: '',
        truthy: true,
        notModified: true,
        ...(Object.keys(nextCursor).length === 0 ? {} : { nextCursor: Object.freeze(nextCursor) }),
      })
    }
    etag = response.etag
    if (isPlainObject(response.value)) {
      historyId = optionalBoundedText(response.value['historyId'], 1_024)
      uidValidity = optionalBoundedText(response.value['uidValidity'], 128)
    }
    const selected = selectJsonPointer(response.value, input.messagesPointer ?? '/messages')
    if (!Array.isArray(selected)) {
      throw new Error('event-triggers: email messagesPointer must select an array')
    }
    if (input.hasBaseline && input.cursor?.historyId !== undefined && historyId === input.cursor.historyId && selected.length === 0) {
      const nextCursor: TriggerCursor = {
        ...input.cursor,
        ...(etag === undefined ? {} : { etag }),
        historyId,
      }
      return Object.freeze({
        fingerprint: '',
        truthy: true,
        notModified: true,
        nextCursor: Object.freeze(nextCursor),
      })
    }
    rawMessages = selected
  }

  if (rawMessages.length > input.maxMessages) {
    throw new Error('event-triggers: email response exceeds maxMessages')
  }

  const seenUids = new Set<string>()
  const projected: ProjectedEmail[] = []
  const subjectNeedle = input.subjectContains?.normalize('NFC').toLowerCase()

  for (const raw of rawMessages) {
    if (!isPlainObject(raw)) {
      throw new Error('event-triggers: email message entry must be a plain object')
    }
    const uid = boundedText(raw['uid'] ?? raw['id'] ?? raw['messageId'], 'uid', 512)
    if (seenUids.has(uid)) {
      throw new Error('event-triggers: email response contains duplicate message uid')
    }
    seenUids.add(uid)

    const threadId = optionalBoundedText(raw['threadId'], 256)
    const receivedAtMs = parseReceivedAtMs(raw['receivedAt'] ?? raw['date'] ?? raw['internalDate'])
    const { flags, unread } = extractFlags(raw)
    const senderAddr = extractSenderAddress(raw['from'])
    const rawSubject = raw['subject']
    if (rawSubject !== undefined && rawSubject !== null && typeof rawSubject !== 'string') {
      throw new Error('event-triggers: email subject must be a string')
    }
    const rawSnippet = raw['preview'] ?? raw['snippet']
    if (rawSnippet !== undefined && rawSnippet !== null && typeof rawSnippet !== 'string') {
      throw new Error('event-triggers: email preview/snippet must be a string')
    }

    if (input.unreadOnly && !unread) continue
    if (input.fromFilter !== undefined && !matchesFromFilter(senderAddr, input.fromFilter)) continue
    if (subjectNeedle !== undefined && !(typeof rawSubject === 'string' && rawSubject.normalize('NFC').toLowerCase().includes(subjectNeedle))) {
      continue
    }

    const fromDomain = senderAddr !== undefined ? senderAddr.slice(senderAddr.indexOf('@') + 1) : undefined
    const fromDigest = senderAddr !== undefined ? sha256(senderAddr) : undefined
    const subjectDigest = typeof rawSubject === 'string' && rawSubject.length > 0 ? sha256(rawSubject) : undefined
    const snippetDigest = typeof rawSnippet === 'string' && rawSnippet.length > 0 ? sha256(rawSnippet) : undefined
    const flagsDigest = sha256(JSON.stringify({ unread, flags }))

    projected.push(Object.freeze({
      uid,
      ...(threadId === undefined ? {} : { threadId }),
      ...(receivedAtMs === undefined ? {} : { receivedAtMs }),
      flagsDigest,
      ...(fromDomain === undefined ? {} : { fromDomain }),
      ...(fromDigest === undefined ? {} : { fromDigest }),
      ...(subjectDigest === undefined ? {} : { subjectDigest }),
      ...(snippetDigest === undefined ? {} : { snippetDigest }),
    }))
  }

  projected.sort((left, right) => (left.uid < right.uid ? -1 : left.uid > right.uid ? 1 : 0))
  const fingerprint = `sha256:${sha256(JSON.stringify({
    ...(uidValidity === undefined ? {} : { uidValidity }),
    items: projected,
  }))}`

  const nextCursor: TriggerCursor = {
    ...(etag === undefined ? {} : { etag }),
    ...(historyId === undefined ? {} : { historyId }),
    ...(jmapState === undefined ? {} : { jmapState }),
  }

  return Object.freeze({
    fingerprint,
    truthy: projected.length > 0,
    ...(Object.keys(nextCursor).length === 0 ? {} : { nextCursor: Object.freeze(nextCursor) }),
  })
}
