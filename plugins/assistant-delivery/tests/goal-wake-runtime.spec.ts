import { describe, expect, test } from 'vitest'
import { isDeliveryGoalWakeDeadline } from '../src/goal-wake-types.ts'

describe('scheduled Goal wake boundary', () => {
  test('accepts only a future bounded deadline', () => {
    const now = 1_000_000
    expect(isDeliveryGoalWakeDeadline(now + 1, now)).toBe(true)
    expect(isDeliveryGoalWakeDeadline(now + 300_000, now)).toBe(true)
    expect(isDeliveryGoalWakeDeadline(now, now)).toBe(false)
    expect(isDeliveryGoalWakeDeadline(now - 1, now)).toBe(false)
    expect(isDeliveryGoalWakeDeadline(now + 300_001, now)).toBe(false)
    expect(isDeliveryGoalWakeDeadline(Number.NaN, now)).toBe(false)
  })
})
