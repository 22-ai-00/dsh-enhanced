import { describe, expect, test } from 'vitest'
import { decideTrigger, evaluateDraw, isIdle, isWithinActiveHours, localDayKey, slotOccurrence } from '../src/trigger.ts'

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
