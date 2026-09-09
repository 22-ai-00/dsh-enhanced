import { createHash } from 'node:crypto'
import type { SensorObservation } from './sensors.js'

/** Narrow read-only bridge implemented by lark-channel. It never exposes tokens. */
export interface LarkCalendarPageReader {
  readCalendarEventPage(input: Readonly<{
    calendarId: string
    startTime: number
    endTime: number
    pageSize: number
    pageToken?: string
    signal: AbortSignal
  }>): Promise<unknown>
}

export interface LarkCalendarObservationInput {
  calendarId: string
  startTime: number
  endTime: number
  pageSize: number
  maxPages: number
  maxEvents: number
  signal: AbortSignal
  beforeRequest?: () => void | Promise<void>
}

const unavailable = (): never => { throw new Error('event-triggers: Lark calendar observation is unavailable') }
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const text = (value: unknown, maximum = 1_024): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.trim() !== value || /[\p{Cc}]/u.test(value)) unavailable()
  return value as string
}
const optionalText = (value: unknown, maximum = 8_192): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > maximum || /[\p{Cc}]/u.test(value)) unavailable()
  return value as string
}
const optionalBoolean = (value: unknown): boolean | undefined => value === undefined ? undefined : typeof value === 'boolean' ? value : unavailable()

function event(value: unknown): Readonly<Record<string, unknown>> {
  const raw = plain(value) ? value : unavailable()
  const time = (input: unknown): Readonly<Record<string, string>> | undefined => {
    if (input === undefined) return undefined
    const source = plain(input) ? input : unavailable()
    const date = optionalText(source.date, 64), timestamp = optionalText(source.timestamp, 32), timezone = optionalText(source.timezone, 128)
    if (date === undefined && timestamp === undefined) unavailable()
    return Object.freeze({ ...(date === undefined ? {} : { date }), ...(timestamp === undefined ? {} : { timestamp }), ...(timezone === undefined ? {} : { timezone }) })
  }
  const status = optionalText(raw.status, 32)
  if (status !== undefined && !['tentative', 'confirmed', 'cancelled'].includes(status)) unavailable()
  return Object.freeze({
    eventId: text(raw.event_id),
    ...(time(raw.start_time) === undefined ? {} : { start: time(raw.start_time)! }),
    ...(time(raw.end_time) === undefined ? {} : { end: time(raw.end_time)! }),
    ...(status === undefined ? {} : { status }),
    ...(optionalText(raw.summary) === undefined ? {} : { summary: optionalText(raw.summary)! }),
    ...(optionalText(raw.recurrence) === undefined ? {} : { recurrence: optionalText(raw.recurrence)! }),
    ...(optionalBoolean(raw.is_exception) === undefined ? {} : { isException: optionalBoolean(raw.is_exception)! }),
    ...(optionalText(raw.recurring_event_id) === undefined ? {} : { recurringEventId: optionalText(raw.recurring_event_id)! }),
    ...(optionalText(raw.create_time, 32) === undefined ? {} : { createTime: optionalText(raw.create_time, 32)! }),
    ...(optionalText(raw.organizer_calendar_id) === undefined ? {} : { organizerCalendarId: optionalText(raw.organizer_calendar_id)! }),
  })
}

function page(value: unknown, maxEvents: number): Readonly<{ hasMore: boolean; pageToken?: string; items: readonly Readonly<Record<string, unknown>>[] }> {
  const raw = plain(value) ? value : unavailable()
  if (typeof raw.has_more !== 'boolean' || !Array.isArray(raw.items)) unavailable()
  const items = raw.items as unknown[]
  // Calendar v4 may include an empty terminal token. It is not a continuation.
  if (items.length > maxEvents) unavailable()
  const pageToken = raw.page_token === undefined || (raw.page_token === '' && !raw.has_more) ? undefined : text(raw.page_token, 4_096)
  if (raw.has_more && pageToken === undefined) unavailable()
  return Object.freeze({ hasMore: raw.has_more as boolean, ...(pageToken === undefined ? {} : { pageToken }), items: Object.freeze(items.map(event)) })
}

/**
 * Reads every page in a finite Calendar v4 window and retains only an opaque
 * hash of a stable, privacy-minimised projection.  A missing previous event
 * changes the collection hash just as an added or changed event does.
 */
export async function readLarkCalendarObservation(reader: LarkCalendarPageReader, input: LarkCalendarObservationInput): Promise<SensorObservation> {
  if (!Number.isSafeInteger(input.startTime) || !Number.isSafeInteger(input.endTime) || input.startTime < 0 || input.endTime <= input.startTime
    || !Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || !Number.isSafeInteger(input.maxPages) || input.maxPages < 1
    || !Number.isSafeInteger(input.maxEvents) || input.maxEvents < 1 || input.signal.aborted) unavailable()
  const tokens = new Set<string>(), eventIds = new Set<string>(), values: Readonly<Record<string, unknown>>[] = []
  let pageToken: string | undefined
  for (let pageNumber = 0; pageNumber < input.maxPages; pageNumber += 1) {
    await input.beforeRequest?.()
    if (input.signal.aborted) unavailable()
    const response = await reader.readCalendarEventPage({ calendarId: input.calendarId, startTime: input.startTime, endTime: input.endTime,
      pageSize: input.pageSize, ...(pageToken === undefined ? {} : { pageToken }), signal: input.signal })
    await input.beforeRequest?.()
    if (input.signal.aborted) unavailable()
    const current = page(response, input.maxEvents - values.length)
    for (const item of current.items) {
      const eventId = item.eventId as string
      if (eventIds.has(eventId)) unavailable()
      eventIds.add(eventId)
    }
    values.push(...current.items)
    if (values.length > input.maxEvents) unavailable()
    if (!current.hasMore) {
      const canonical = JSON.stringify(values.map(value => JSON.stringify(value)).sort((left, right) => left < right ? -1 : left > right ? 1 : 0))
      return Object.freeze({ fingerprint: `sha256:${createHash('sha256').update(canonical).digest('hex')}`, truthy: true })
    }
    pageToken = current.pageToken
    if (pageToken === undefined || tokens.has(pageToken)) unavailable()
    tokens.add(pageToken!)
  }
  return unavailable()
}
