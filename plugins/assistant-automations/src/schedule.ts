export type AutomationSchedule =
  | { kind: 'at'; at: string }
  | { kind: 'every'; anchorAt: string; intervalMs: number }
  | { kind: 'cron'; expression: string; timezone: string }

export interface CronFields {
  minute: number[]
  hour: number[]
  dayOfMonth: number[]
  month: number[]
  dayOfWeek: number[]
  dayOfMonthWildcard: boolean
  dayOfWeekWildcard: boolean
}

export type ScheduleErrorCode = 'invalid-cron' | 'invalid-schedule' | 'invalid-timezone' | 'scan-limit'

export class ScheduleError extends Error {
  constructor(readonly code: ScheduleErrorCode, message: string) {
    super(message)
    this.name = 'ScheduleError'
  }
}

const MAX_SCAN_MINUTES = 5 * 366 * 24 * 60
const formatters = new Map<string, Intl.DateTimeFormat>()

function canonicalInstant(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new ScheduleError('invalid-schedule', `${field} must be a canonical ISO instant`)
  }
  const parsed = new Date(value)
  if (parsed.toISOString() !== value) {
    throw new ScheduleError('invalid-schedule', `${field} must use canonical ISO milliseconds and Z`)
  }
  return value
}

function timezone(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ScheduleError('invalid-timezone', 'timezone must be a non-empty IANA zone')
  }
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value }).format(0)
  } catch {
    throw new ScheduleError('invalid-timezone', `invalid IANA timezone: ${value}`)
  }
  return value
}

export function validateSchedule(value: unknown): AutomationSchedule {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ScheduleError('invalid-schedule', 'schedule must be an object')
  }
  const input = value as Record<string, unknown>
  if (input['kind'] === 'at') {
    if (Object.keys(input).some(key => key !== 'at' && key !== 'kind')) {
      throw new ScheduleError('invalid-schedule', 'at schedule contains an unknown field')
    }
    return Object.freeze({ kind: 'at', at: canonicalInstant(input['at'], 'at') })
  }
  if (input['kind'] === 'every') {
    if (Object.keys(input).some(key => !['anchorAt', 'intervalMs', 'kind'].includes(key))) {
      throw new ScheduleError('invalid-schedule', 'every schedule contains an unknown field')
    }
    const intervalMs = input['intervalMs']
    if (!Number.isSafeInteger(intervalMs) || (intervalMs as number) < 60_000) {
      throw new ScheduleError('invalid-schedule', 'intervalMs must be a safe integer of at least 60000')
    }
    return Object.freeze({
      kind: 'every',
      anchorAt: canonicalInstant(input['anchorAt'], 'anchorAt'),
      intervalMs: intervalMs as number,
    })
  }
  if (input['kind'] === 'cron') {
    if (Object.keys(input).some(key => !['expression', 'kind', 'timezone'].includes(key))) {
      throw new ScheduleError('invalid-schedule', 'cron schedule contains an unknown field')
    }
    if (typeof input['expression'] !== 'string') {
      throw new ScheduleError('invalid-cron', 'cron expression must be a string')
    }
    parseCronExpression(input['expression'])
    return Object.freeze({
      kind: 'cron',
      expression: input['expression'],
      timezone: timezone(input['timezone']),
    })
  }
  throw new ScheduleError('invalid-schedule', 'schedule kind must be at, every, or cron')
}

function integer(value: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(value)) throw new ScheduleError('invalid-cron', `invalid cron integer: ${value}`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ScheduleError('invalid-cron', `cron integer is outside ${minimum}-${maximum}: ${value}`)
  }
  return parsed
}

function field(value: string, minimum: number, maximum: number, sundayAlias = false): number[] {
  if (value === '') throw new ScheduleError('invalid-cron', 'cron field must not be empty')
  const values = new Set<number>()
  for (const segment of value.split(',')) {
    if (segment === '') throw new ScheduleError('invalid-cron', 'cron list contains an empty item')
    const slash = segment.split('/')
    if (slash.length > 2) throw new ScheduleError('invalid-cron', `invalid cron step: ${segment}`)
    const base = slash[0]!
    const step = slash[1] === undefined ? 1 : integer(slash[1], 1, maximum - minimum + 1)
    let start: number
    let end: number
    if (base === '*') {
      start = minimum
      end = maximum
    } else if (base.includes('-')) {
      const range = base.split('-')
      if (range.length !== 2) throw new ScheduleError('invalid-cron', `invalid cron range: ${base}`)
      start = integer(range[0]!, minimum, maximum)
      end = integer(range[1]!, minimum, maximum)
      if (start > end) throw new ScheduleError('invalid-cron', `cron range is descending: ${base}`)
    } else {
      start = integer(base, minimum, maximum)
      end = start
    }
    for (let current = start; current <= end; current += step) {
      values.add(sundayAlias && current === 7 ? 0 : current)
    }
  }
  return [...values].sort((left, right) => left - right)
}

export function parseCronExpression(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) throw new ScheduleError('invalid-cron', 'cron expression must contain exactly five fields')
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [string, string, string, string, string]
  return Object.freeze({
    minute: Object.freeze(field(minute, 0, 59)) as unknown as number[],
    hour: Object.freeze(field(hour, 0, 23)) as unknown as number[],
    dayOfMonth: Object.freeze(field(dayOfMonth, 1, 31)) as unknown as number[],
    month: Object.freeze(field(month, 1, 12)) as unknown as number[],
    dayOfWeek: Object.freeze(field(dayOfWeek, 0, 7, true)) as unknown as number[],
    dayOfMonthWildcard: dayOfMonth === '*',
    dayOfWeekWildcard: dayOfWeek === '*',
  })
}

function formatter(zone: string): Intl.DateTimeFormat {
  let value = formatters.get(zone)
  if (value !== undefined) return value
  value = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  formatters.set(zone, value)
  return value
}

function localParts(instant: number, zone: string): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  dayOfWeek: number
} {
  const parts = new Map(formatter(zone).formatToParts(new Date(instant)).map(part => [part.type, part.value]))
  const year = Number(parts.get('year'))
  const month = Number(parts.get('month'))
  const day = Number(parts.get('day'))
  const hour = Number(parts.get('hour')) % 24
  const minute = Number(parts.get('minute'))
  return { year, month, day, hour, minute, dayOfWeek: new Date(Date.UTC(year, month - 1, day)).getUTCDay() }
}

function cronMatchesDate(fields: CronFields, local: ReturnType<typeof localParts>): boolean {
  if (!fields.month.includes(local.month)) return false
  const dayOfMonth = fields.dayOfMonth.includes(local.day)
  const dayOfWeek = fields.dayOfWeek.includes(local.dayOfWeek)
  if (fields.dayOfMonthWildcard) return dayOfWeek
  if (fields.dayOfWeekWildcard) return dayOfMonth
  return dayOfMonth || dayOfWeek
}

// A whole local day whose date fields cannot match has no matching minute, so
// the minute scan skips it in one jump instead of stepping 1440 times (a
// day-restricted expression such as a leap-day cron otherwise scans years of
// minutes). The jump keeps a one-hour margin below the wall-clock distance to
// the next/previous local midnight so a 23-hour spring-forward day can never
// leap over a real matching minute; landing early only costs a re-check. Days
// whose date matches still scan minute-by-minute, so DST wall-time handling is
// unchanged for the common every-day expressions.
const DAY_SKIP_MARGIN_MINUTES = 60

export function nextOccurrence(schedule: AutomationSchedule, after: number): number | undefined {
  if (!Number.isSafeInteger(after)) throw new ScheduleError('invalid-schedule', 'after must be a safe millisecond instant')
  switch (schedule.kind) {
    case 'at': {
      const instant = Date.parse(schedule.at)
      return instant > after ? instant : undefined
    }
    case 'every': {
      const anchor = Date.parse(schedule.anchorAt)
      if (after < anchor) return anchor
      const periods = Math.floor((after - anchor) / schedule.intervalMs) + 1
      const instant = anchor + periods * schedule.intervalMs
      if (!Number.isSafeInteger(instant)) throw new ScheduleError('scan-limit', 'fixed interval exceeds safe time range')
      return instant
    }
    case 'cron': {
      const fields = parseCronExpression(schedule.expression)
      let candidate = Math.floor(after / 60_000) * 60_000 + 60_000
      for (let scanned = 0; scanned < MAX_SCAN_MINUTES;) {
        const local = localParts(candidate, schedule.timezone)
        if (cronMatchesDate(fields, local)) {
          if (fields.minute.includes(local.minute) && fields.hour.includes(local.hour)) return candidate
          candidate += 60_000
          scanned += 1
          continue
        }
        const minutesToMidnight = 1_440 - (local.hour * 60 + local.minute)
        const jump = Math.max(1, minutesToMidnight - DAY_SKIP_MARGIN_MINUTES)
        candidate += jump * 60_000
        scanned += jump
      }
      throw new ScheduleError('scan-limit', 'no cron occurrence found within five years')
    }
  }
}

export function previousOccurrence(schedule: AutomationSchedule, atOrBefore: number): number | undefined {
  if (!Number.isSafeInteger(atOrBefore)) {
    throw new ScheduleError('invalid-schedule', 'atOrBefore must be a safe millisecond instant')
  }
  switch (schedule.kind) {
    case 'at': {
      const instant = Date.parse(schedule.at)
      return instant <= atOrBefore ? instant : undefined
    }
    case 'every': {
      const anchor = Date.parse(schedule.anchorAt)
      if (atOrBefore < anchor) return undefined
      return anchor + Math.floor((atOrBefore - anchor) / schedule.intervalMs) * schedule.intervalMs
    }
    case 'cron': {
      const fields = parseCronExpression(schedule.expression)
      let candidate = Math.floor(atOrBefore / 60_000) * 60_000
      for (let scanned = 0; scanned < MAX_SCAN_MINUTES;) {
        const local = localParts(candidate, schedule.timezone)
        if (cronMatchesDate(fields, local)) {
          if (fields.minute.includes(local.minute) && fields.hour.includes(local.hour)) return candidate
          candidate -= 60_000
          scanned += 1
          continue
        }
        const minutesSinceMidnight = local.hour * 60 + local.minute
        const jump = Math.max(1, minutesSinceMidnight + 1 - DAY_SKIP_MARGIN_MINUTES)
        candidate -= jump * 60_000
        scanned += jump
      }
      throw new ScheduleError('scan-limit', 'no prior cron occurrence found within five years')
    }
  }
}

export function dueOccurrences(
  schedule: AutomationSchedule,
  after: number,
  now: number,
  limit: number,
): number[] {
  if (!Number.isSafeInteger(now) || now < after) {
    throw new ScheduleError('invalid-schedule', 'now must be a safe instant at or after the cursor')
  }
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
    throw new ScheduleError('invalid-schedule', 'due occurrence limit must be between 1 and 10000')
  }
  const output: number[] = []
  let cursor = after
  while (output.length < limit) {
    const next = nextOccurrence(schedule, cursor)
    if (next === undefined || next > now) break
    output.push(next)
    cursor = next
  }
  return output
}
