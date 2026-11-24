import { describe, expect, test, vi } from 'vitest'
import { readCalendarObservation } from '../src/calendar-sensor.ts'

const lookup = async () => [{ address: '93.184.216.34', family: 4 }]
const allowedOrigins = new Set(['https://cal.example.com'])

describe('calendar sensor (ICS & JSON events)', () => {
  test('parses RFC 5545 folded ICS lines, VEVENT fields, recurrence, and rolling windowParams without leaking summary', async () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:evt-1',
      'SEQUENCE:2',
      'STATUS:CONFIRMED',
      'DTSTART:20260301T100000Z',
      'DURATION:PT1H',
      'SUMMARY:Confidential Board',
      ' Meeting',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:evt-1',
      'RECURRENCE-ID:20260308T100000Z',
      'SEQUENCE:3',
      'STATUS:CANCELLED',
      'DTSTART:20260308T100000Z',
      'DTEND:20260308T110000Z',
      'SUMMARY:Cancelled Occurrence',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:evt-outside',
      'DTSTART:20260101T000000Z',
      'DTEND:20260101T010000Z',
      'SUMMARY:Old Event',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')

    const fetcher = vi.fn(async (url: string) => {
      const parsed = new URL(url)
      expect(parsed.searchParams.get('timeMin')).toBe('2026-03-01T00:00:00.000Z')
      expect(parsed.searchParams.get('timeMax')).toBe('2026-03-10T00:00:00.000Z')
      return new Response(ics, { status: 200, headers: { 'content-type': 'text/calendar', etag: '"ics-etag-1"' } })
    })

    const obs = await readCalendarObservation({
      url: 'https://cal.example.com/feed.ics',
      format: 'ics',
      window: { mode: 'rolling', lookbackSeconds: 0, lookaheadSeconds: 9 * 86_400 },
      windowParams: { startParam: 'timeMin', endParam: 'timeMax', format: 'iso' },
      maxEvents: 100,
      now: () => Date.parse('2026-03-01T00:00:00Z'),
      maxBodyBytes: 65_536,
      timeoutMs: 2_000,
      allowedOrigins,
      lookup,
      fetcher,
    })

    expect(obs.truthy).toBe(true)
    expect(obs.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u)
    expect(obs.nextCursor).toEqual({ etag: '"ics-etag-1"' })
    expect(JSON.stringify(obs)).not.toContain('Confidential Board')
  })

  test('parses Google-style json-events and tracks nextSyncToken cursor', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      nextSyncToken: 'gcal-sync-9',
      items: [
        {
          id: 'g-1',
          status: 'confirmed',
          sequence: 1,
          updated: '2026-03-01T09:00:00Z',
          start: { dateTime: '2026-03-01T10:00:00Z' },
          end: { dateTime: '2026-03-01T11:00:00Z' },
          summary: 'Private 1:1',
        },
      ],
    }), { status: 200 }))

    const obs = await readCalendarObservation({
      url: 'https://cal.example.com/calendars/primary/events',
      format: 'json-events',
      itemsPointer: '/items',
      window: {
        mode: 'static',
        startTime: Math.floor(Date.parse('2026-03-01T00:00:00Z') / 1_000),
        endTime: Math.floor(Date.parse('2026-03-02T00:00:00Z') / 1_000),
      },
      maxEvents: 50,
      maxBodyBytes: 65_536,
      timeoutMs: 2_000,
      allowedOrigins,
      lookup,
      fetcher,
    })

    expect(obs.truthy).toBe(true)
    expect(obs.nextCursor).toEqual({ syncToken: 'gcal-sync-9' })
    expect(JSON.stringify(obs)).not.toContain('Private 1:1')
  })

  test('rejects malformed ICS, duplicate event keys, and exceeding maxEvents', async () => {
    await expect(readCalendarObservation({
      url: 'https://cal.example.com/feed.ics',
      format: 'ics',
      maxEvents: 10,
      maxBodyBytes: 65_536,
      timeoutMs: 2_000,
      allowedOrigins,
      lookup,
      fetcher: async () => new Response('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\n'),
    })).rejects.toThrow(/unclosed/i)

    const dupIcs = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT', 'UID:dup', 'DTSTART:20260301T100000Z', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:dup', 'DTSTART:20260301T100000Z', 'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
    await expect(readCalendarObservation({
      url: 'https://cal.example.com/feed.ics',
      format: 'ics',
      maxEvents: 10,
      maxBodyBytes: 65_536,
      timeoutMs: 2_000,
      allowedOrigins,
      lookup,
      fetcher: async () => new Response(dupIcs),
    })).rejects.toThrow(/duplicate/i)

    await expect(readCalendarObservation({
      url: 'https://cal.example.com/events.json',
      format: 'json-events',
      itemsPointer: '/items',
      maxEvents: 1,
      maxBodyBytes: 65_536,
      timeoutMs: 2_000,
      allowedOrigins,
      lookup,
      fetcher: async () => new Response(JSON.stringify({ items: [{ id: '1' }, { id: '2' }] })),
    })).rejects.toThrow(/maxEvents/i)
  })

  test('ignores nested VALARM subcomponents inside VEVENT and rejects empty or unclosed durations/subcomponents', async () => {
    const baseIcs = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:alarm-test-1',
      'DTSTART:20260501T090000Z',
      'DURATION:PT1H',
      'SUMMARY:Board Review',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
    const withValarmIcs = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:alarm-test-1',
      'DTSTART:20260501T090000Z',
      'DURATION:PT1H',
      'SUMMARY:Board Review',
      'BEGIN:VALARM',
      'UID:alarm-sub-uid-99',
      'ACTION:DISPLAY',
      'TRIGGER:-PT15M',
      'DURATION:PT15M',
      'REPEAT:2',
      'SUMMARY:Alarm Notification',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')

    const baseObs = await readCalendarObservation({
      url: 'https://cal.example.com/base.ics',
      format: 'ics',
      maxEvents: 10,
      maxBodyBytes: 65_536,
      timeoutMs: 2_000,
      allowedOrigins,
      lookup,
      fetcher: async () => new Response(baseIcs),
    })
    const valarmObs = await readCalendarObservation({
      url: 'https://cal.example.com/alarm.ics',
      format: 'ics',
      maxEvents: 10,
      maxBodyBytes: 65_536,
      timeoutMs: 2_000,
      allowedOrigins,
      lookup,
      fetcher: async () => new Response(withValarmIcs),
    })
    expect(valarmObs.fingerprint).toBe(baseObs.fingerprint)

    for (const badDuration of ['DURATION:P', 'DURATION:PT', 'DURATION:P1DT']) {
      const badIcs = [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:dur-bad',
        'DTSTART:20260501T090000Z',
        badDuration,
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n')
      await expect(readCalendarObservation({
        url: 'https://cal.example.com/bad-dur.ics',
        format: 'ics',
        maxEvents: 10,
        maxBodyBytes: 65_536,
        timeoutMs: 2_000,
        allowedOrigins,
        lookup,
        fetcher: async () => new Response(badIcs),
      })).rejects.toThrow(/DURATION/i)
    }

    for (const badNesting of [
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u1\r\nBEGIN:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR',
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u1\r\nBEGIN:VALARM\r\nEND:VTODO\r\nEND:VEVENT\r\nEND:VCALENDAR',
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u1\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR',
    ]) {
      await expect(readCalendarObservation({
        url: 'https://cal.example.com/bad-nest.ics',
        format: 'ics',
        maxEvents: 10,
        maxBodyBytes: 65_536,
        timeoutMs: 2_000,
        allowedOrigins,
        lookup,
        fetcher: async () => new Response(badNesting),
      })).rejects.toThrow(/ICS|VEVENT|VALARM|BEGIN|END/i)
    }
  })
})
