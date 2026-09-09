import { describe, expect, it, vi } from 'vitest'
import { readLarkCalendarObservation } from '../src/lark-calendar-sensor.ts'

const first = { event_id: 'event-one', summary: 'Planning', start_time: { timestamp: '100' }, end_time: { timestamp: '200' }, status: 'confirmed' }
const second = { event_id: 'event-two', summary: 'Review', start_time: { timestamp: '300' }, end_time: { timestamp: '400' }, status: 'tentative' }

function reader(pages: readonly unknown[]) {
  const readCalendarEventPage = vi.fn(async input => pages[input.pageToken === undefined ? 0 : 1])
  return { readCalendarEventPage }
}

function read(pages: readonly unknown[]) {
  const source = reader(pages)
  return { source, operation: readLarkCalendarObservation(source, { calendarId: 'cal_owner', startTime: 1, endTime: 1_000, pageSize: 100, maxPages: 3, maxEvents: 10, signal: new AbortController().signal }) }
}

describe('Lark Calendar v4 observation', () => {
  it('reads every page under exact window bounds and produces one stable opaque collection fingerprint', async () => {
    const value = read([{ has_more: true, page_token: 'next', items: [second] }, { has_more: false, items: [first] }])
    await expect(value.operation).resolves.toMatchObject({ truthy: true, fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) })
    expect(value.source.readCalendarEventPage).toHaveBeenNthCalledWith(1, expect.objectContaining({ calendarId: 'cal_owner', startTime: 1, endTime: 1_000, pageSize: 100 }))
    expect(value.source.readCalendarEventPage).toHaveBeenNthCalledWith(2, expect.objectContaining({ pageToken: 'next' }))

    const reversed = read([{ has_more: false, items: [first, second] }])
    await expect(reversed.operation).resolves.toEqual(await read([{ has_more: false, items: [second, first] }]).operation)
  })

  it('changes the snapshot when an event is deleted, without retaining event contents', async () => {
    const before = await read([{ has_more: false, items: [first, second] }]).operation
    const after = await read([{ has_more: false, items: [first] }]).operation
    expect(after.fingerprint).not.toBe(before.fingerprint)
    expect(JSON.stringify([before, after])).not.toContain('Planning')
  })

  it('accepts documented terminal page tokens and normal empty or cancelled event shapes', async () => {
    await expect(read([{ has_more: false, page_token: 'unused-terminal-token', items: [
      { event_id: 'cancelled', summary: '', status: 'cancelled' },
    ] }]).operation).resolves.toMatchObject({ truthy: true })
    await expect(read([{ has_more: false, page_token: '', items: [] }]).operation).resolves.toMatchObject({ truthy: true })
  })

  it('rejects an oversized response page before projecting its event objects', async () => {
    const source = { readCalendarEventPage: vi.fn(async () => ({ has_more: false, items: Array.from({ length: 11 }, () => ({ event_id: 'not-mapped' })) })) }
    await expect(readLarkCalendarObservation(source, { calendarId: 'cal_owner', startTime: 1, endTime: 1_000, pageSize: 100, maxPages: 1, maxEvents: 10, signal: new AbortController().signal })).rejects.toThrow('unavailable')
    expect(source.readCalendarEventPage).toHaveBeenCalledOnce()
  })

  it.each([
    ['cyclic page token', [{ has_more: true, page_token: 'next', items: [] }, { has_more: true, page_token: 'next', items: [] }]],
    ['truncated pages', [{ has_more: true, page_token: 'one', items: [] }, { has_more: true, page_token: 'two', items: [] }, { has_more: true, page_token: 'three', items: [] }]],
    ['has_more without token', [{ has_more: true, items: [] }]],
    ['has_more with empty token', [{ has_more: true, page_token: '', items: [] }]],
    ['malformed item', [{ has_more: false, items: [{ event_id: 'bad', status: 'not-a-status' }] }]],
    ['duplicate event identity', [{ has_more: false, items: [first, { ...first, summary: 'changed' }] }]],
  ])('rejects %s without producing a snapshot', async (_name, pages) => {
    await expect(read(pages).operation).rejects.toThrow('unavailable')
  })
})
