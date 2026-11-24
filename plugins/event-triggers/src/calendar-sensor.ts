import { createHash } from 'node:crypto'
import type { CalendarFormat, CalendarWindowConfig, CalendarWindowParamsConfig } from './config.js'
import {
  readHttpJsonWithMeta,
  readHttpTextValue,
  selectJsonPointer,
  type Fetcher,
  type Lookup,
  type OperationTracker,
  type SensorObservation,
} from './sensors.js'
import type { TriggerCursor } from './store.js'

export interface CalendarObservationInput {
  url: string
  format: CalendarFormat
  itemsPointer?: string
  window?: Readonly<CalendarWindowConfig>
  windowParams?: Readonly<Required<CalendarWindowParamsConfig>>
  maxEvents: number
  token?: string
  cursor?: Readonly<TriggerCursor>
  hasBaseline?: boolean
  now?: () => number
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

export interface CalendarObservation extends SensorObservation {
  readonly notModified?: boolean
  readonly nextCursor?: TriggerCursor
}

interface ProjectedCalendarEvent {
  readonly uid: string
  readonly recurrenceId?: string
  readonly sequence: number
  readonly status?: string
  readonly startMs?: number
  readonly endMs?: number
  readonly rrule?: string
  readonly lastModified?: string
  readonly etag?: string
  readonly summaryDigest?: string
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function boundedText(value: unknown, field: string, max = 512): string {
  if (typeof value !== 'string') {
    throw new Error(`event-triggers: calendar ${field} must be a string`)
  }
  const normalized = value.normalize('NFC').trim()
  if (normalized.length === 0 || normalized.length > max || /[\p{Cc}]/u.test(normalized)) {
    throw new Error(`event-triggers: calendar ${field} is invalid`)
  }
  return normalized
}

function optionalBoundedText(value: unknown, max = 512): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('event-triggers: calendar field must be a string')
  const normalized = value.normalize('NFC').trim()
  if (normalized.length === 0) return undefined
  if (normalized.length > max || /[\p{Cc}]/u.test(normalized)) {
    throw new Error('event-triggers: calendar field is invalid')
  }
  return normalized
}

function normalizeStatus(value: unknown): string | undefined {
  const text = optionalBoundedText(value, 32)
  if (text === undefined) return undefined
  const lower = text.toLowerCase()
  if (lower !== 'tentative' && lower !== 'confirmed' && lower !== 'cancelled') {
    throw new Error(`event-triggers: unsupported calendar event status ${text}`)
  }
  return lower
}

function parseIcsDateTime(raw: string): number {
  const value = raw.trim()
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/u.exec(value)
  if (dateOnly) {
    const ms = Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    if (!Number.isFinite(ms)) throw new Error('event-triggers: invalid ICS date')
    return ms
  }
  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/u.exec(value)
  if (dateTime) {
    const ms = Date.UTC(
      Number(dateTime[1]), Number(dateTime[2]) - 1, Number(dateTime[3]),
      Number(dateTime[4]), Number(dateTime[5]), Number(dateTime[6]),
    )
    if (!Number.isFinite(ms)) throw new Error('event-triggers: invalid ICS datetime')
    return ms
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error('event-triggers: invalid ICS timestamp')
  return parsed
}

function parseIsoDurationMs(raw: string): number {
  const trimmed = raw.trim()
  const match = /^P(?:(\d+)W|(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?)$/u.exec(trimmed)
  if (!match) throw new Error('event-triggers: invalid ICS DURATION')
  const hasAnyComponent = match[1] !== undefined
    || match[2] !== undefined
    || match[3] !== undefined
    || match[4] !== undefined
    || match[5] !== undefined
  const hasTimeComponent = match[3] !== undefined || match[4] !== undefined || match[5] !== undefined
  if (!hasAnyComponent || (trimmed.includes('T') && !hasTimeComponent)) {
    throw new Error('event-triggers: invalid ICS DURATION')
  }
  const weeks = Number(match[1] ?? 0)
  const days = Number(match[2] ?? 0)
  const hours = Number(match[3] ?? 0)
  const minutes = Number(match[4] ?? 0)
  const seconds = Number(match[5] ?? 0)
  return (((weeks * 7 + days) * 24 + hours) * 60 + minutes) * 60_000 + seconds * 1_000
}

function unescapeIcsText(value: string): string {
  return value
    .replace(/\\n/giu, '\n')
    .replace(/\\,/gu, ',')
    .replace(/\\;/gu, ';')
    .replace(/\\\\/gu, '\\')
}

function matchesWindow(
  event: { startMs?: number; endMs?: number; rrule?: string },
  windowBounds: { startMs: number; endMs: number } | undefined,
): boolean {
  if (windowBounds === undefined) return true
  if (event.rrule !== undefined) {
    return event.startMs === undefined || event.startMs <= windowBounds.endMs
  }
  if (event.startMs === undefined) return false
  if (event.endMs !== undefined && event.endMs > event.startMs) {
    return event.endMs > windowBounds.startMs && event.startMs <= windowBounds.endMs
  }
  return event.startMs >= windowBounds.startMs && event.startMs <= windowBounds.endMs
}

function parseIcsEvents(
  rawText: string,
  maxEvents: number,
  windowBounds: { startMs: number; endMs: number } | undefined,
): ProjectedCalendarEvent[] {
  const unfolded = rawText.replace(/\r?\n[ \t]/gu, '')
  const lines = unfolded.split(/\r?\n/u)
  let inEvent = false
  const subcomponentStack: string[] = []
  let currentProps: Record<string, string> = {}
  let totalEvents = 0
  const events: ProjectedCalendarEvent[] = []

  for (const rawLine of lines) {
    if (rawLine.length === 0) continue
    const upper = rawLine.trim().toUpperCase()
    if (!inEvent) {
      if (upper === 'BEGIN:VEVENT') {
        inEvent = true
        subcomponentStack.length = 0
        currentProps = {}
        totalEvents += 1
        if (totalEvents > maxEvents) {
          throw new Error('event-triggers: calendar ICS exceeds maxEvents')
        }
        continue
      }
      if (upper === 'END:VEVENT') {
        throw new Error('event-triggers: unexpected END:VEVENT')
      }
      continue
    }

    if (upper.startsWith('BEGIN:')) {
      const component = upper.slice('BEGIN:'.length).trim()
      if (component === 'VEVENT') {
        throw new Error('event-triggers: nested VEVENT is not allowed')
      }
      if (component.length === 0) {
        throw new Error('event-triggers: invalid nested ICS component')
      }
      subcomponentStack.push(component)
      continue
    }

    if (upper.startsWith('END:')) {
      const component = upper.slice('END:'.length).trim()
      if (subcomponentStack.length > 0) {
        if (component === 'VEVENT') {
          throw new Error('event-triggers: unclosed nested ICS component inside VEVENT')
        }
        const expected = subcomponentStack.pop()
        if (expected !== component) {
          throw new Error(`event-triggers: mismatched END:${component} for BEGIN:${expected}`)
        }
        continue
      }
      if (component !== 'VEVENT') {
        throw new Error(`event-triggers: unexpected END:${component} inside VEVENT`)
      }
      inEvent = false
      const uid = boundedText(currentProps['UID'], 'UID', 512)
      const recurrenceId = optionalBoundedText(currentProps['RECURRENCE-ID'], 128)
      const seqRaw = currentProps['SEQUENCE']
      const sequence = seqRaw === undefined ? 0 : Number(seqRaw.trim())
      if (!Number.isSafeInteger(sequence) || sequence < 0) {
        throw new Error('event-triggers: invalid VEVENT SEQUENCE')
      }
      const status = normalizeStatus(currentProps['STATUS'])
      const startMs = currentProps['DTSTART'] !== undefined ? parseIcsDateTime(currentProps['DTSTART']) : undefined
      let endMs = currentProps['DTEND'] !== undefined ? parseIcsDateTime(currentProps['DTEND']) : undefined
      if (endMs === undefined && startMs !== undefined && currentProps['DURATION'] !== undefined) {
        endMs = startMs + parseIsoDurationMs(currentProps['DURATION'])
      }
      const rrule = optionalBoundedText(currentProps['RRULE'], 512)
      const lastModified = optionalBoundedText(currentProps['LAST-MODIFIED'], 64)
      const rawSummary = currentProps['SUMMARY']
      const summaryDigest = rawSummary !== undefined && rawSummary.length > 0
        ? sha256(unescapeIcsText(rawSummary))
        : undefined
      const item: ProjectedCalendarEvent = Object.freeze({
        uid,
        ...(recurrenceId === undefined ? {} : { recurrenceId }),
        sequence,
        ...(status === undefined ? {} : { status }),
        ...(startMs === undefined ? {} : { startMs }),
        ...(endMs === undefined ? {} : { endMs }),
        ...(rrule === undefined ? {} : { rrule }),
        ...(lastModified === undefined ? {} : { lastModified }),
        ...(summaryDigest === undefined ? {} : { summaryDigest }),
      })
      if (matchesWindow(item, windowBounds)) events.push(item)
      continue
    }

    if (subcomponentStack.length > 0) continue
    const colon = rawLine.indexOf(':')
    if (colon <= 0) continue
    const left = rawLine.slice(0, colon)
    const value = rawLine.slice(colon + 1)
    const propName = left.split(';')[0]!.trim().toUpperCase()
    if (propName.length > 0) {
      currentProps[propName] = value
    }
  }
  if (inEvent || subcomponentStack.length > 0) throw new Error('event-triggers: unclosed BEGIN:VEVENT in ICS feed')
  return events
}

function parseJsonEventTime(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('event-triggers: invalid JSON calendar timestamp')
    return value
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    if (!Number.isFinite(ms)) throw new Error('event-triggers: invalid JSON calendar timestamp')
    return ms
  }
  if (isPlainObject(value)) {
    const raw = value['dateTime'] ?? value['date'] ?? value['timestamp']
    if (typeof raw === 'number') return parseJsonEventTime(raw)
    if (typeof raw === 'string') {
      if (/^[0-9]+$/u.test(raw.trim())) {
        const seconds = Number(raw.trim())
        if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error('event-triggers: invalid JSON calendar timestamp')
        return seconds * 1_000
      }
      const ms = Date.parse(raw)
      if (!Number.isFinite(ms)) throw new Error('event-triggers: invalid JSON calendar timestamp')
      return ms
    }
  }
  throw new Error('event-triggers: unsupported JSON calendar time object')
}

function parseJsonEvents(
  items: unknown[],
  maxEvents: number,
  windowBounds: { startMs: number; endMs: number } | undefined,
): ProjectedCalendarEvent[] {
  if (items.length > maxEvents) {
    throw new Error('event-triggers: calendar JSON exceeds maxEvents')
  }
  const events: ProjectedCalendarEvent[] = []
  for (const raw of items) {
    if (!isPlainObject(raw)) {
      throw new Error('event-triggers: calendar event item must be a plain object')
    }
    const uid = boundedText(raw['uid'] ?? raw['id'], 'uid', 512)
    let recurrenceId = optionalBoundedText(raw['recurrenceId'], 128)
    if (recurrenceId === undefined && raw['recurringEventId'] !== undefined) {
      const parent = boundedText(raw['recurringEventId'], 'recurringEventId', 256)
      const origStart = isPlainObject(raw['originalStartTime'])
        ? optionalBoundedText(raw['originalStartTime']['dateTime'] ?? raw['originalStartTime']['date'], 64)
        : optionalBoundedText(raw['originalStartTime'], 64)
      recurrenceId = origStart !== undefined ? `${parent}#${origStart}` : parent
    }
    const sequence = raw['sequence'] === undefined ? 0 : Number(raw['sequence'])
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error('event-triggers: invalid JSON calendar event sequence')
    }
    const status = normalizeStatus(raw['status'])
    const startMs = parseJsonEventTime(raw['start'] ?? raw['startTime'])
    const endMs = parseJsonEventTime(raw['end'] ?? raw['endTime'])
    const rrule = typeof raw['rrule'] === 'string'
      ? optionalBoundedText(raw['rrule'], 512)
      : Array.isArray(raw['recurrence'])
        ? optionalBoundedText(raw['recurrence'].filter((entry): entry is string => typeof entry === 'string').join(';'), 512)
        : undefined
    const lastModified = optionalBoundedText(raw['updated'] ?? raw['lastModified'], 64)
    const etag = optionalBoundedText(raw['etag'], 256)
    const rawSummary = raw['summary']
    if (rawSummary !== undefined && rawSummary !== null && typeof rawSummary !== 'string') {
      throw new Error('event-triggers: calendar event summary must be a string')
    }
    const summaryDigest = typeof rawSummary === 'string' && rawSummary.length > 0 ? sha256(rawSummary) : undefined
    const item: ProjectedCalendarEvent = Object.freeze({
      uid,
      ...(recurrenceId === undefined ? {} : { recurrenceId }),
      sequence,
      ...(status === undefined ? {} : { status }),
      ...(startMs === undefined ? {} : { startMs }),
      ...(endMs === undefined ? {} : { endMs }),
      ...(rrule === undefined ? {} : { rrule }),
      ...(lastModified === undefined ? {} : { lastModified }),
      ...(etag === undefined ? {} : { etag }),
      ...(summaryDigest === undefined ? {} : { summaryDigest }),
    })
    if (matchesWindow(item, windowBounds)) events.push(item)
  }
  return events
}

function resolveWindowBounds(
  window: Readonly<CalendarWindowConfig> | undefined,
  nowMs: number,
): { startMs: number; endMs: number } | undefined {
  if (window === undefined) return undefined
  if (window.mode === 'static') {
    return { startMs: window.startTime! * 1_000, endMs: window.endTime! * 1_000 }
  }
  const nowSec = Math.floor(nowMs / 1_000)
  const startSec = Math.max(0, nowSec - (window.lookbackSeconds ?? 0))
  const endSec = nowSec + (window.lookaheadSeconds ?? 0)
  return { startMs: startSec * 1_000, endMs: endSec * 1_000 }
}

function formatWindowParam(ms: number, format: 'iso' | 'unix-seconds'): string {
  return format === 'unix-seconds' ? String(Math.floor(ms / 1_000)) : new Date(ms).toISOString()
}

export async function readCalendarObservation(input: CalendarObservationInput): Promise<CalendarObservation> {
  if (!Number.isSafeInteger(input.maxEvents) || input.maxEvents < 1 || input.maxEvents > 5_000) {
    throw new Error('event-triggers: calendar maxEvents is invalid')
  }
  if (input.signal?.aborted) {
    throw (input.signal.reason instanceof Error ? input.signal.reason : new Error('event-triggers: calendar sensor aborted'))
  }

  const nowMs = (input.now ?? Date.now)()
  const windowBounds = resolveWindowBounds(input.window, nowMs)
  const url = new URL(input.url)
  if (input.windowParams !== undefined && windowBounds !== undefined) {
    url.searchParams.set(input.windowParams.startParam, formatWindowParam(windowBounds.startMs, input.windowParams.format))
    url.searchParams.set(input.windowParams.endParam, formatWindowParam(windowBounds.endMs, input.windowParams.format))
  }
  if (input.cursor?.syncToken !== undefined && !url.searchParams.has('syncToken')) {
    url.searchParams.set('syncToken', input.cursor.syncToken)
  }

  const headers: Record<string, string> = {
    accept: input.format === 'ics' ? 'text/calendar, text/plain;q=0.9, */*;q=0.1' : 'application/json',
  }
  if (input.token !== undefined && input.token.length > 0) {
    headers['authorization'] = `Bearer ${input.token}`
  }

  const transportBase = {
    url: url.toString(),
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
  }

  let events: ProjectedCalendarEvent[]
  let etag: string | undefined
  let nextSyncToken: string | undefined

  if (input.format === 'ics') {
    await input.beforeRequest?.()
    const result = await readHttpTextValue(transportBase)
    await input.beforeRequest?.()
    if (result.notModified) {
      const nextCursor: TriggerCursor = {
        ...input.cursor,
        ...(result.etag === undefined ? {} : { etag: result.etag }),
      }
      return Object.freeze({
        fingerprint: '',
        truthy: true,
        notModified: true,
        ...(Object.keys(nextCursor).length === 0 ? {} : { nextCursor: Object.freeze(nextCursor) }),
      })
    }
    etag = result.etag
    events = parseIcsEvents(result.text, input.maxEvents, windowBounds)
  } else {
    await input.beforeRequest?.()
    const result = await readHttpJsonWithMeta(transportBase)
    await input.beforeRequest?.()
    if (result.notModified) {
      const nextCursor: TriggerCursor = {
        ...input.cursor,
        ...(result.etag === undefined ? {} : { etag: result.etag }),
      }
      return Object.freeze({
        fingerprint: '',
        truthy: true,
        notModified: true,
        ...(Object.keys(nextCursor).length === 0 ? {} : { nextCursor: Object.freeze(nextCursor) }),
      })
    }
    etag = result.etag
    if (isPlainObject(result.value)) {
      nextSyncToken = optionalBoundedText(result.value['nextSyncToken'] ?? result.value['syncToken'], 1_024)
    }
    const selected = selectJsonPointer(result.value, input.itemsPointer ?? '/items')
    if (!Array.isArray(selected)) {
      throw new Error('event-triggers: calendar itemsPointer must select an array')
    }
    if (input.hasBaseline && input.cursor?.syncToken !== undefined && nextSyncToken === input.cursor.syncToken && selected.length === 0) {
      const nextCursor: TriggerCursor = {
        ...input.cursor,
        ...(etag === undefined ? {} : { etag }),
        syncToken: nextSyncToken,
      }
      return Object.freeze({
        fingerprint: '',
        truthy: true,
        notModified: true,
        nextCursor: Object.freeze(nextCursor),
      })
    }
    events = parseJsonEvents(selected, input.maxEvents, windowBounds)
  }

  const seenKeys = new Set<string>()
  for (const item of events) {
    const key = `${item.uid}\0${item.recurrenceId ?? ''}`
    if (seenKeys.has(key)) {
      throw new Error('event-triggers: calendar response contains duplicate event key')
    }
    seenKeys.add(key)
  }

  events.sort((left, right) => {
    if (left.uid !== right.uid) return left.uid < right.uid ? -1 : 1
    const leftRec = left.recurrenceId ?? ''
    const rightRec = right.recurrenceId ?? ''
    return leftRec < rightRec ? -1 : leftRec > rightRec ? 1 : 0
  })

  const fingerprint = `sha256:${sha256(JSON.stringify(events))}`
  const truthy = events.some(event => event.status !== 'cancelled')
  const nextCursor: TriggerCursor = {
    ...(etag === undefined ? {} : { etag }),
    ...(nextSyncToken === undefined ? {} : { syncToken: nextSyncToken }),
  }

  return Object.freeze({
    fingerprint,
    truthy,
    ...(Object.keys(nextCursor).length === 0 ? {} : { nextCursor: Object.freeze(nextCursor) }),
  })
}
