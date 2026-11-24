import { createHash } from 'node:crypto'
import type {
  ActionBrokerOperation,
  CalendarActionPayload,
  CalendarGrantDestination,
  CalendarRequestDestination,
} from '../broker-protocol-v2.js'
import type { BrokerJson } from '../broker-protocol.js'
import {
  executeHttpGuardedAction,
  isSafeUrlPathSegment,
  resolveAndPinHttpAddress,
  responseContainsSecret,
  validateStrictHttpUrl,
  type HttpDnsLookup,
  type HttpTransportFn,
} from './http-guard.js'

export interface CalendarTransportInput {
  readonly operation: 'calendar.list-events' | 'calendar.get-event' | 'calendar.create-event' | 'calendar.update-event' | 'calendar.delete-event'
  readonly provider: CalendarGrantDestination['provider']
  readonly apiBaseUrl: string
  readonly pinnedAddress: string
  readonly pinnedFamily: 4 | 6
  readonly calendarId: string
  readonly payload: CalendarActionPayload
  readonly token: string
  readonly timeoutMs: number
  readonly signal: AbortSignal
}

export interface CalendarTransportResult {
  readonly eventId?: string
  readonly revision?: string
  readonly observed?: BrokerJson
}

export type CalendarTransportFn = (input: CalendarTransportInput) => Promise<CalendarTransportResult>

export interface CalendarGuardDeps {
  readonly lookup?: HttpDnsLookup
  readonly requestImpl?: HttpTransportFn
  readonly transport?: CalendarTransportFn
  readonly secrets?: readonly string[]
  readonly now?: () => number
}

export class CalendarGuardError extends Error {
  constructor(
    readonly code: 'request-invalid' | 'grant-invalid' | 'transport-failed' | 'response-secret-leak',
    readonly dispatched: boolean,
    message: string,
  ) {
    super(`assistant-actions calendar guard: ${message}`)
    this.name = 'CalendarGuardError'
  }
}

const MUTATING_CALENDAR_OPS = new Set<ActionBrokerOperation>([
  'calendar.create-event',
  'calendar.update-event',
  'calendar.delete-event',
])

const EMAIL_RE = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/u

export function validateCalendarAgainstGrant(
  operation: 'calendar.list-events' | 'calendar.get-event' | 'calendar.create-event' | 'calendar.update-event' | 'calendar.delete-event',
  grantDest: CalendarGrantDestination,
  reqDest: CalendarRequestDestination,
  payload: CalendarActionPayload,
  now = Date.now(),
): { apiUrl: URL } {
  if (reqDest.provider !== grantDest.provider) {
    throw new CalendarGuardError('grant-invalid', false, 'calendar provider mismatch')
  }
  if (reqDest.calendarId !== payload.calendarId) {
    throw new CalendarGuardError('request-invalid', false, 'calendarId mismatch between destination and payload')
  }
  if (!isSafeUrlPathSegment(payload.calendarId)) {
    throw new CalendarGuardError('request-invalid', false, 'calendarId contains forbidden path or URL characters')
  }
  if (!grantDest.allowedCalendarIds.includes(reqDest.calendarId)) {
    throw new CalendarGuardError('grant-invalid', false, 'calendarId is not permitted by grant')
  }
  if (MUTATING_CALENDAR_OPS.has(operation) && grantDest.allowMutations !== true) {
    throw new CalendarGuardError('grant-invalid', false, 'calendar mutations are disabled by grant')
  }
  if ((operation === 'calendar.get-event' || operation === 'calendar.update-event' || operation === 'calendar.delete-event') && !payload.eventId) {
    throw new CalendarGuardError('request-invalid', false, `${operation} requires eventId`)
  }
  if (payload.eventId !== undefined && !isSafeUrlPathSegment(payload.eventId)) {
    throw new CalendarGuardError('request-invalid', false, 'eventId contains forbidden path or URL characters')
  }
  const apiUrl = validateStrictHttpUrl(grantDest.apiBaseUrl)
  if (apiUrl.protocol !== 'https:' && grantDest.allowPrivateNetwork !== true) {
    throw new CalendarGuardError('grant-invalid', false, 'calendar apiBaseUrl must use https unless allowPrivateNetwork is true')
  }

  const requiresWindow = operation === 'calendar.list-events' || operation === 'calendar.create-event'
  if (requiresWindow && (payload.startTimeMs === undefined || payload.endTimeMs === undefined)) {
    throw new CalendarGuardError('request-invalid', false, `${operation} requires startTimeMs and endTimeMs`)
  }
  if ((payload.startTimeMs !== undefined) !== (payload.endTimeMs !== undefined)) {
    throw new CalendarGuardError('request-invalid', false, 'startTimeMs and endTimeMs must be provided together')
  }
  if (payload.startTimeMs !== undefined && payload.endTimeMs !== undefined) {
    if (payload.startTimeMs >= payload.endTimeMs) {
      throw new CalendarGuardError('request-invalid', false, 'calendar time window startTimeMs must precede endTimeMs')
    }
    if (payload.endTimeMs - payload.startTimeMs > grantDest.maxWindowSpanMs) {
      throw new CalendarGuardError('grant-invalid', false, 'calendar time window exceeds maxWindowSpanMs')
    }
    if (grantDest.windowStartMs !== undefined && payload.startTimeMs < grantDest.windowStartMs) {
      throw new CalendarGuardError('grant-invalid', false, 'calendar startTimeMs precedes grant windowStartMs')
    }
    if (grantDest.windowEndMs !== undefined && payload.endTimeMs > grantDest.windowEndMs) {
      throw new CalendarGuardError('grant-invalid', false, 'calendar endTimeMs exceeds grant windowEndMs')
    }
    if (grantDest.rollingWindowMs !== undefined) {
      const lookback = grantDest.rollingLookbackMs ?? 0
      if (payload.startTimeMs < now - lookback || payload.endTimeMs > now + grantDest.rollingWindowMs) {
        throw new CalendarGuardError('grant-invalid', false, 'calendar time window is outside rolling window bounds')
      }
    }
  }

  if (payload.attendees && payload.attendees.length > 0) {
    const allowedDomains = grantDest.allowedAttendeeDomains ?? []
    for (const attendee of payload.attendees) {
      const match = EMAIL_RE.exec(attendee)
      if (!match) {
        throw new CalendarGuardError('request-invalid', false, 'invalid attendee email format')
      }
      const domain = match[1]!.toLowerCase()
      if (!grantDest.allowExternalAttendees) {
        if (allowedDomains.length === 0 || !allowedDomains.includes(domain)) {
          throw new CalendarGuardError('grant-invalid', false, `external attendee domain blocked: ${domain}`)
        }
      } else if (allowedDomains.length > 0 && !allowedDomains.includes(domain)) {
        throw new CalendarGuardError('grant-invalid', false, `attendee domain not in allowedAttendeeDomains: ${domain}`)
      }
    }
  }

  return { apiUrl }
}

export async function executeCalendarGuardedAction(input: {
  readonly operation: 'calendar.list-events' | 'calendar.get-event' | 'calendar.create-event' | 'calendar.update-event' | 'calendar.delete-event'
  readonly grantDestination: CalendarGrantDestination
  readonly requestDestination: CalendarRequestDestination
  readonly payload: CalendarActionPayload
  readonly token: string
  readonly timeoutMs: number
  readonly signal: AbortSignal
  readonly deps?: CalendarGuardDeps
}): Promise<{
  readonly domain: 'calendar'
  readonly operation: 'calendar.list-events' | 'calendar.get-event' | 'calendar.create-event' | 'calendar.update-event' | 'calendar.delete-event'
  readonly calendarId: string
  readonly eventId?: string
  readonly revision?: string
  readonly observed?: BrokerJson
  readonly observedDigest?: string
  readonly untrusted: true
}> {
  const now = (input.deps?.now ?? Date.now)()
  const { apiUrl } = validateCalendarAgainstGrant(
    input.operation,
    input.grantDestination,
    input.requestDestination,
    input.payload,
    now,
  )
  const host = apiUrl.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  const pinned = await resolveAndPinHttpAddress(host, input.grantDestination.allowPrivateNetwork === true, input.deps?.lookup)

  const secrets = [...(input.deps?.secrets ?? []), ...(input.token ? [input.token] : [])]
  if (responseContainsSecret(JSON.stringify(input.payload), secrets)) {
    throw new CalendarGuardError('request-invalid', false, 'calendar payload contains a protected secret or credential shape')
  }

  let transportResult: CalendarTransportResult
  if (input.deps?.transport) {
    transportResult = await input.deps.transport({
      operation: input.operation,
      provider: input.grantDestination.provider,
      apiBaseUrl: input.grantDestination.apiBaseUrl,
      pinnedAddress: pinned.address,
      pinnedFamily: pinned.family,
      calendarId: input.requestDestination.calendarId,
      payload: input.payload,
      token: input.token,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    })
  } else {
    const basePath = apiUrl.pathname.replace(/\/+$/u, '')
    const calIdEnc = encodeURIComponent(input.requestDestination.calendarId)
    const eventEnc = input.payload.eventId ? encodeURIComponent(input.payload.eventId) : ''
    let method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET'
    let endpointPath = `${basePath}/open-apis/calendar/v4/calendars/${calIdEnc}/events`
    let query = ''
    let body: string | undefined

    if (input.operation === 'calendar.list-events') {
      method = 'GET'
      const params = new URLSearchParams({
        start_time: String(Math.floor(input.payload.startTimeMs! / 1_000)),
        end_time: String(Math.ceil(input.payload.endTimeMs! / 1_000)),
      })
      if (input.payload.pageSize !== undefined) params.set('page_size', String(input.payload.pageSize))
      if (input.payload.pageToken !== undefined) params.set('page_token', input.payload.pageToken)
      query = `?${params.toString()}`
    } else if (input.operation === 'calendar.get-event') {
      method = 'GET'
      endpointPath = `${endpointPath}/${eventEnc}`
    } else if (input.operation === 'calendar.create-event') {
      method = 'POST'
      body = JSON.stringify({
        summary: input.payload.summary ?? '',
        description: input.payload.description ?? '',
        start_time: { timestamp: String(Math.floor(input.payload.startTimeMs! / 1_000)) },
        end_time: { timestamp: String(Math.ceil(input.payload.endTimeMs! / 1_000)) },
        ...(input.payload.attendees ? { attendees: input.payload.attendees.map(email => ({ type: 'third_party', third_party_email: email })) } : {}),
      })
    } else if (input.operation === 'calendar.update-event') {
      method = 'PATCH'
      endpointPath = `${endpointPath}/${eventEnc}`
      body = JSON.stringify({
        ...(input.payload.summary === undefined ? {} : { summary: input.payload.summary }),
        ...(input.payload.description === undefined ? {} : { description: input.payload.description }),
        ...(input.payload.startTimeMs === undefined ? {} : { start_time: { timestamp: String(Math.floor(input.payload.startTimeMs / 1_000)) } }),
        ...(input.payload.endTimeMs === undefined ? {} : { end_time: { timestamp: String(Math.ceil(input.payload.endTimeMs / 1_000)) } }),
      })
    } else {
      method = 'DELETE'
      endpointPath = `${endpointPath}/${eventEnc}`
    }

    const endpointUrl = new URL(`${apiUrl.origin}${endpointPath}${query}`)
    const scheme = apiUrl.protocol === 'https:' ? 'https' : 'http'
    const httpResult = await executeHttpGuardedAction({
      grantDestination: {
        classification: 'http-endpoint',
        allowedSchemes: [scheme],
        allowedHosts: [host],
        ...(apiUrl.port ? { allowedPorts: [Number(apiUrl.port)] } : {}),
        allowedMethods: [method],
        allowedPathPrefixes: [`${basePath}/open-apis/calendar/v4/calendars/${calIdEnc}/events`],
        allowRedirects: false,
        allowPrivateNetwork: input.grantDestination.allowPrivateNetwork === true,
        maxResponseBytes: 1_048_576,
        authHeader: 'authorization',
        authScheme: 'Bearer',
      },
      requestDestination: {
        classification: 'http-endpoint',
        scheme,
        host,
        ...(apiUrl.port ? { port: Number(apiUrl.port) } : {}),
        path: endpointUrl.pathname,
      },
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
        ...(input.deps?.requestImpl === undefined ? {} : { requestImpl: input.deps.requestImpl }),
        secrets,
      },
    })
    if (httpResult.statusCode < 200 || httpResult.statusCode >= 300) {
      throw new CalendarGuardError('transport-failed', true, `Calendar API returned HTTP ${httpResult.statusCode}`)
    }
    let parsed: Record<string, unknown>
    try {
      parsed = httpResult.body ? JSON.parse(httpResult.body) as Record<string, unknown> : {}
    } catch {
      throw new CalendarGuardError('transport-failed', true, 'Calendar API returned non-JSON response')
    }
    const data = parsed.data as Record<string, unknown> | undefined
    const event = (data?.event as Record<string, unknown> | undefined) ?? data
    transportResult = {
      ...(typeof event?.event_id === 'string' ? { eventId: event.event_id } : input.payload.eventId ? { eventId: input.payload.eventId } : {}),
      ...(typeof event?.revision === 'string' ? { revision: event.revision } : {}),
      observed: parsed as BrokerJson,
    }
  }

  const serializedObserved = transportResult.observed === undefined ? undefined : JSON.stringify(transportResult.observed)
  if (serializedObserved && responseContainsSecret(serializedObserved, secrets)) {
    throw new CalendarGuardError('response-secret-leak', true, 'Calendar response contained protected secret')
  }
  const observedDigest = serializedObserved === undefined ? undefined : createHash('sha256').update(serializedObserved).digest('hex')

  return Object.freeze({
    domain: 'calendar',
    operation: input.operation,
    calendarId: input.requestDestination.calendarId,
    ...(transportResult.eventId === undefined ? {} : { eventId: transportResult.eventId }),
    ...(transportResult.revision === undefined ? {} : { revision: transportResult.revision }),
    ...(transportResult.observed === undefined ? {} : { observed: transportResult.observed }),
    ...(observedDigest === undefined ? {} : { observedDigest }),
    untrusted: true,
  })
}
