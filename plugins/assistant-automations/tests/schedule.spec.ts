import { describe, expect, test } from 'vitest'
import {
  dueOccurrences,
  nextOccurrence,
  parseCronExpression,
  previousOccurrence,
  ScheduleError,
  validateSchedule,
} from '../src/schedule.ts'

const utc = (value: string) => Date.parse(value)

describe('automation schedules', () => {
  test('accepts only canonical future-independent at instants', () => {
    const schedule = validateSchedule({ kind: 'at', at: '2026-08-21T01:02:03.000Z' })
    if (schedule.kind !== 'at') throw new Error('expected at schedule')
    expect(nextOccurrence(schedule, utc('2026-08-21T01:02:02.999Z'))).toBe(utc(schedule.at))
    expect(nextOccurrence(schedule, utc(schedule.at))).toBeUndefined()
    for (const at of ['2026-08-21', '2026-08-21T01:02:03Z', 'not-a-date']) {
      expect(() => validateSchedule({ kind: 'at', at }))
        .toThrowError(expect.objectContaining<Partial<ScheduleError>>({ code: 'invalid-schedule' }))
    }
  })

  test('keeps fixed intervals anchored without completion-time drift', () => {
    const schedule = validateSchedule({
      kind: 'every',
      anchorAt: '2026-08-21T00:00:00.000Z',
      intervalMs: 15 * 60_000,
    })
    expect(nextOccurrence(schedule, utc('2026-08-21T00:07:00.000Z')))
      .toBe(utc('2026-08-21T00:15:00.000Z'))
    expect(dueOccurrences(schedule, utc('2026-08-21T00:00:00.000Z') - 1, utc('2026-08-21T01:00:00.000Z'), 10))
      .toEqual([
        utc('2026-08-21T00:00:00.000Z'),
        utc('2026-08-21T00:15:00.000Z'),
        utc('2026-08-21T00:30:00.000Z'),
        utc('2026-08-21T00:45:00.000Z'),
        utc('2026-08-21T01:00:00.000Z'),
      ])
  })

  test('parses strict five-field cron lists, ranges, steps, and Sunday aliases', () => {
    const cron = parseCronExpression('*/15 9-17/2 1,15 * 1-5')
    expect(cron.minute).toEqual([0, 15, 30, 45])
    expect(cron.hour).toEqual([9, 11, 13, 15, 17])
    expect(cron.dayOfMonth).toEqual([1, 15])
    expect(cron.dayOfWeek).toEqual([1, 2, 3, 4, 5])
    expect(parseCronExpression('0 0 * * 7').dayOfWeek).toEqual([0])

    for (const expression of ['* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '*/0 * * * *', '5-1 * * * *']) {
      expect(() => parseCronExpression(expression))
        .toThrowError(expect.objectContaining<Partial<ScheduleError>>({ code: 'invalid-cron' }))
    }
  })

  test('uses standard DOM/DOW OR semantics when both fields are restricted', () => {
    const schedule = validateSchedule({ kind: 'cron', expression: '0 9 15 * 1', timezone: 'UTC' })
    expect(nextOccurrence(schedule, utc('2026-06-14T09:00:00.000Z')))
      .toBe(utc('2026-06-15T09:00:00.000Z'))
    expect(nextOccurrence(schedule, utc('2026-06-15T09:00:00.000Z')))
      .toBe(utc('2026-06-22T09:00:00.000Z'))
  })

  test('skips nonexistent DST wall time and emits both repeated wall times', () => {
    const spring = validateSchedule({
      kind: 'cron', expression: '30 2 * * *', timezone: 'America/New_York',
    })
    expect(nextOccurrence(spring, utc('2026-03-07T07:30:00.000Z')))
      .toBe(utc('2026-03-09T06:30:00.000Z'))

    const fall = validateSchedule({
      kind: 'cron', expression: '30 1 * * *', timezone: 'America/New_York',
    })
    const first = nextOccurrence(fall, utc('2026-11-01T05:00:00.000Z'))
    const second = nextOccurrence(fall, first!)
    expect([first, second]).toEqual([
      utc('2026-11-01T05:30:00.000Z'),
      utc('2026-11-01T06:30:00.000Z'),
    ])
  })

  test('handles leap days and rejects invalid IANA zones with a bounded search', () => {
    const leap = validateSchedule({ kind: 'cron', expression: '0 0 29 2 *', timezone: 'UTC' })
    expect(nextOccurrence(leap, utc('2027-03-01T00:00:00.000Z')))
      .toBe(utc('2028-02-29T00:00:00.000Z'))
    // Scanning backwards across the same multi-year gap must land on the prior
    // leap day, exercising the day-skip in previousOccurrence too.
    expect(previousOccurrence(leap, utc('2027-03-01T00:00:00.000Z')))
      .toBe(utc('2024-02-29T00:00:00.000Z'))
    expect(() => validateSchedule({ kind: 'cron', expression: '* * * * *', timezone: 'Mars/Olympus' }))
      .toThrowError(expect.objectContaining<Partial<ScheduleError>>({ code: 'invalid-timezone' }))
  })

  test('day-skipping preserves DST wall times on a date-restricted cron', () => {
    // 2:30 on 2026-03-08 does not exist (spring forward), so a date-restricted
    // cron must skip that year and land on the next existing wall time — the
    // day-skip must not fabricate a match on the short day.
    const spring = validateSchedule({ kind: 'cron', expression: '30 2 8 3 *', timezone: 'America/New_York' })
    expect(nextOccurrence(spring, utc('2026-01-01T00:00:00.000Z')))
      .toBe(utc('2027-03-08T07:30:00.000Z'))

    // 1:30 on 2026-11-01 occurs twice (fall back); both must still be emitted
    // even though the surrounding days are skipped by the date filter.
    const fall = validateSchedule({ kind: 'cron', expression: '30 1 1 11 *', timezone: 'America/New_York' })
    const first = nextOccurrence(fall, utc('2026-10-01T00:00:00.000Z'))
    const second = nextOccurrence(fall, first!)
    expect([first, second]).toEqual([
      utc('2026-11-01T05:30:00.000Z'),
      utc('2026-11-01T06:30:00.000Z'),
    ])
  })
})
