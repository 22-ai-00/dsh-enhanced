import { describe, expect, it } from 'vitest'
import { matchRevisionTarget, type RevisionTargetCandidate } from '../src/revision-target-matcher.ts'

const target = (name: string, planId = `plan-${name}`): RevisionTargetCandidate => ({ parentPlanId: planId, name, parentSourceDigest: 'a'.repeat(64) })

describe('deterministic work-item revision target matcher', () => {
  it('matches exactly one word-boundary capability name', () => {
    expect(matchRevisionTarget('the weather-helper failed to answer', [target('weather-helper')]))
      .toEqual({ parentPlanId: 'plan-weather-helper', name: 'weather-helper' })
    expect(matchRevisionTarget('使用 weather-helper 查询时超时', [target('weather-helper')]))
      .toEqual({ parentPlanId: 'plan-weather-helper', name: 'weather-helper' })
    // Spaces are not part of the name; only the exact hyphenated token matches.
    expect(matchRevisionTarget('the weather helper failed to answer', [target('weather-helper')])).toBeUndefined()
  })

  it('fails closed on zero, multiple, or duplicated-name matches', () => {
    expect(matchRevisionTarget('nothing relevant here', [target('weather-helper')])).toBeUndefined()
    expect(matchRevisionTarget('weather-helper and calendar-sync both broke', [target('weather-helper'), target('calendar-sync')])).toBeUndefined()
    expect(matchRevisionTarget('weather-helper twice: weather-helper', [target('weather-helper')]))
      .toEqual({ parentPlanId: 'plan-weather-helper', name: 'weather-helper' })
    expect(matchRevisionTarget('a weather-helper b', [target('weather-helper', 'p1'), target('weather-helper', 'p2')])).toBeUndefined()
    // A duplicated target name with only one surviving entry still resolves to that capability.
    expect(matchRevisionTarget('a weather-helper b', [target('weather-helper', 'p1')]))
      .toEqual({ parentPlanId: 'p1', name: 'weather-helper' })
  })

  it('never matches a substring or a different name that merely extends it', () => {
    expect(matchRevisionTarget('the weatherhelper plugin stalled', [target('weather-helper')])).toBeUndefined()
    expect(matchRevisionTarget('the weather-helper-pro plugin stalled', [target('weather-helper')])).toBeUndefined()
  })

  it('rejects malformed objectives and malformed candidate lists', () => {
    expect(matchRevisionTarget('', [target('a')])).toBeUndefined()
    expect(matchRevisionTarget('x'.repeat(20_000), [target('a')])).toBeUndefined()
    expect(matchRevisionTarget('the a tool failed', [])).toBeUndefined()
    expect(matchRevisionTarget('the a tool failed', Array.from({ length: 65 }, (_, i) => target(`n${i}`)))).toBeUndefined()
    expect(matchRevisionTarget('the a tool failed', [{ parentPlanId: 'p', name: 'Bad Name', parentSourceDigest: 'a'.repeat(64) }])).toBeUndefined()
    expect(matchRevisionTarget('the a tool failed', [{ parentPlanId: '', name: 'a', parentSourceDigest: 'a'.repeat(64) }])).toBeUndefined()
  })
})
