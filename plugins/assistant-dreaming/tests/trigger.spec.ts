import { describe, expect, test } from 'vitest'
import { assignTicket, decideTrigger, evaluateDraw, isIdle, isWithinActiveHours, localDayKey,
  matchTickets, rollLottery, slotOccurrence, TICKET_MODULUS } from '../src/trigger.ts'

const seed = 'a'.repeat(64)
const activeHours = { timezone: 'UTC', startMinute: 8 * 60, endMinute: 22 * 60 }
const base = {
  seedDigest: seed, probabilityPpm: 250_000, activeHours, idleMinMs: 1_800_000,
  maxDreamsPerDay: 3, lane: 'lane',
}

describe('dream trigger draw', () => {
  test('is deterministic for the same seed, lane and occurrence', () => {
    const first = evaluateDraw({ seedDigest: seed, lane: 'lane', occurrence: 7, probabilityPpm: 250_000 })
    const second = evaluateDraw({ seedDigest: seed, lane: 'lane', occurrence: 7, probabilityPpm: 250_000 })
    expect(second).toEqual(first)
    expect(first.value).toBeGreaterThanOrEqual(0)
    expect(first.value).toBeLessThan(1_000_000)
  })

  test('never selects at probability zero and always selects at one million', () => {
    expect(evaluateDraw({ seedDigest: seed, lane: 'lane', occurrence: 1, probabilityPpm: 0 }).selected).toBe(false)
    for (let occurrence = 0; occurrence < 8; occurrence += 1) {
      expect(evaluateDraw({ seedDigest: seed, lane: 'lane', occurrence, probabilityPpm: 1_000_000 }).selected).toBe(true)
    }
  })

  test('rejects invalid occurrence or probability inputs', () => {
    expect(() => evaluateDraw({ seedDigest: seed, lane: 'lane', occurrence: -1, probabilityPpm: 1 })).toThrow()
    expect(() => evaluateDraw({ seedDigest: seed, lane: 'lane', occurrence: 0, probabilityPpm: 1_000_001 })).toThrow()
  })
})

describe('dream gate decision', () => {
  const now = Date.parse('2026-11-08T12:00:00.000Z')
  const common = {
    ...base, now, occurrence: 12, latestActivityAt: now - 3_600_000, dreamsToday: 0,
  }

  test('fires only after active hours, idle, cap and draw all pass', () => {
    const selected = decideTrigger({ ...common, occurrence: 12 })
    if (selected.fire) {
      expect(selected.drawDigest).toMatch(/^[a-f0-9]{64}$/u)
      expect(selected.dayKey).toBe('2026-11-08')
    }
    expect(decideTrigger({ ...common, activeHours: { ...activeHours, endMinute: 11 * 60 } }))
      .toMatchObject({ fire: false, reason: 'outside-active-hours' })
    expect(decideTrigger({ ...common, latestActivityAt: now - 60_000 }))
      .toMatchObject({ fire: false, reason: 'not-idle' })
    expect(decideTrigger({ ...common, latestActivityAt: null }))
      .toMatchObject({ fire: false, reason: 'not-idle' })
    expect(decideTrigger({ ...common, dreamsToday: 3 }))
      .toMatchObject({ fire: false, reason: 'daily-cap' })
    expect(decideTrigger({ ...common, probabilityPpm: 0 }))
      .toMatchObject({ fire: false, reason: 'draw-not-selected' })
  })

  test('idle and active-hour helpers are fail-closed', () => {
    expect(isIdle(now, now - 2_000_000, 1_800_000)).toBe(true)
    expect(isIdle(now, null, 1_800_000)).toBe(false)
    expect(isWithinActiveHours(now, null)).toBe(true)
    expect(isWithinActiveHours(Date.parse('2026-11-08T07:59:00.000Z'), activeHours)).toBe(false)
    expect(isWithinActiveHours(Date.parse('2026-11-08T21:59:00.000Z'), activeHours)).toBe(true)
    expect(localDayKey(now, 'UTC')).toBe('2026-11-08')
    expect(slotOccurrence(now, 3_600_000)).toBe(Math.floor(now / 3_600_000))
  })
})

describe('dream lottery tickets', () => {
  const lane = 'lane'
  const subject = (key: string) => ({ kind: 'task-projection' as const, key })

  test('a ticket is stable for the same seed, lane and subject', () => {
    const first = assignTicket({ seedDigest: seed, lane, subject: subject('task-1') })
    const second = assignTicket({ seedDigest: seed, lane, subject: subject('task-1') })
    expect(second).toEqual(first)
    expect(first.value).toBeGreaterThanOrEqual(0)
    expect(first.value).toBeLessThan(TICKET_MODULUS)
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/u)
  })

  test('distinct subjects and distinct lanes get independent tickets', () => {
    const a = assignTicket({ seedDigest: seed, lane, subject: subject('task-1') })
    const b = assignTicket({ seedDigest: seed, lane, subject: subject('task-2') })
    const otherLane = assignTicket({ seedDigest: seed, lane: 'other-lane', subject: subject('task-1') })
    expect(a.value).not.toBe(b.value)
    expect(a.value).not.toBe(otherLane.value)
  })

  test('the roll is deterministic, bounded and occurrence-specific', () => {
    const first = rollLottery({ seedDigest: seed, lane, occurrence: 3 })
    const second = rollLottery({ seedDigest: seed, lane, occurrence: 3 })
    expect(second).toEqual(first)
    expect(rollLottery({ seedDigest: seed, lane, occurrence: 4 }).value).not.toBe(first.value)
    expect(first.value).toBeGreaterThanOrEqual(0)
    expect(first.value).toBeLessThan(TICKET_MODULUS)
    expect(() => rollLottery({ seedDigest: seed, lane, occurrence: -1 })).toThrow()
  })

  test('matches tickets inside the window and sorts by circular distance', () => {
    const draw = { drawDigest: 'f'.repeat(64), value: 100 }
    const tickets = [
      { subject: subject('far'), value: 50_000, digest: 'a'.repeat(64) },
      { subject: subject('near-high'), value: 130, digest: 'b'.repeat(64) },
      { subject: subject('nearest'), value: 90, digest: 'c'.repeat(64) },
    ]
    const hits = matchTickets({ draw, tickets, window: 50 })
    expect(hits.map(hit => hit.subject.key)).toEqual(['nearest', 'near-high'])
    expect(hits[0]!.distance).toBe(10)
    expect(hits[1]!).toMatchObject({ ticketValue: 130, distance: 30 })
  })

  test('treats the modulus as circular around zero', () => {
    const draw = { drawDigest: 'f'.repeat(64), value: 10 }
    const tickets = [
      { subject: subject('wrap-low'), value: TICKET_MODULUS - 20, digest: 'a'.repeat(64) },
      { subject: subject('wrap-exact'), value: 0, digest: 'b'.repeat(64) },
    ]
    const hits = matchTickets({ draw, tickets, window: 30 })
    expect(hits.map(hit => hit.subject.key)).toEqual(['wrap-exact', 'wrap-low'])
    expect(hits[0]!.distance).toBe(10)
    expect(hits[1]!.distance).toBe(30)
  })

  test('an empty ticket pool and a wide miss produce no hits', () => {
    const draw = { drawDigest: 'f'.repeat(64), value: 500_000 }
    expect(matchTickets({ draw, tickets: [], window: 5_000 })).toEqual([])
    const ticket = { subject: subject('lonely'), value: 1, digest: 'a'.repeat(64) }
    expect(matchTickets({ draw, tickets: [ticket], window: 5_000 })).toEqual([])
    expect(() => matchTickets({ draw, tickets: [ticket], window: -1 })).toThrow()
  })
})
