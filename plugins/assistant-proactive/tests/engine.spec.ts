import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  computeDynamicUtility,
  MAX_ACCEPTANCE_BONUS,
  MAX_ACCEPTANCE_PENALTY,
  MAX_ACTIVITY_PENALTY,
  MAX_FREQUENCY_PENALTY,
  MAX_IDLE_DISCOUNT,
  MAX_URGENCY_BONUS,
  OpportunityEngine,
  RECENT_NOTIFICATION_WINDOW_MS,
  URGENCY_WINDOW_MS,
  validateProfile,
} from '../src/engine.ts'
import { attentionOverlay } from '../src/attention-tuning.ts'
import type { OpportunityInput, OpportunityProfile } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const profile = (more: Partial<OpportunityProfile> = {}): OpportunityProfile => ({ id: 'proactive-default', mode: 'execute', expectedBenefit: 100, successPpm: 1_000_000, executionCost: 10, interruptionCost: 5, possibleLoss: 5, minimumUtility: 1, mergeWindowMs: 0, cooldownMs: 0, rejectionCooldownMs: 60_000, maxDecisionsPerGoal: 3, maxExecutionsPerGoal: 2, maxRemindersPerGoal: 1, ...more })
const scope = { principalId: 'lark/a/t/u', principalRecordId: 'owner-row', principalVersion: 1, workspace: '/workspace', preset: 'default' }
const input = (sequence = 1, digest = `digest-${sequence}`, more: Partial<OpportunityInput> = {}): OpportunityInput => ({ waitId: 'wait-a', profileId: 'proactive-default', scope, goalId: 'goal-a', sessionId: 'session-a', definitionDigest: 'definition-a', objective: 'Prepare the report when source changes.', nativeGoalId: 'native-a', nativeRevision: 1, ownerRouteId: 'route-a', sourceDigest: 'source-a', sourceId: 'trigger-a', event: { id: `event-${sequence}`, sequence, digest, occurredAt: 1_000 }, expiresAt: Number.MAX_SAFE_INTEGER, ...more })

describe('OpportunityEngine', () => {
  it('persists an exact event decision across reopening without duplicate budget consumption', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proactive-engine-')); roots.push(root); const path = join(root, 'engine.sqlite')
    let now = 2_000
    const first = new OpportunityEngine(path, [profile()], { now: () => now })
    const initial = first.evaluate(input()); expect(initial.disposition).toBe('execute'); first.close()
    const second = new OpportunityEngine(path, [profile({ maxExecutionsPerGoal: 99 })], { now: () => now })
    const replay = second.evaluate(input()); expect(replay).toEqual(initial)
    expect(second.evaluate(input(2)).disposition).toBe('execute')
    expect(second.list(scope, 'goal-a').filter(value => value.reason === 'execution')).toHaveLength(2)
    second.close()
  })

  it('keeps a merge deadline fixed, ignores stale conflicts, and does not let later profile changes relax a goal', () => {
    let now = 10_000
    const engine = new OpportunityEngine(':memory:', [profile({ mergeWindowMs: 1_000, maxDecisionsPerGoal: 1 })], { now: () => now })
    const first = engine.evaluate(input(4)); expect(first).toMatchObject({ disposition: 'defer', decision: { reason: 'coalescing', eligibleAt: 11_000, observations: 1 } })
    now = 10_500
    const merged = engine.evaluate(input(5)); expect(merged).toMatchObject({ disposition: 'defer', decision: { eligibleAt: 11_000, observations: 2, eventSequence: 5 } })
    expect(engine.evaluate(input(3, 'conflict')).decision.id).toBe(merged.decision.id)
    now = 11_001
    const later = engine.evaluate(input(6)); expect(later.disposition).toBe('execute')
    expect(engine.evaluate(input(7))).toMatchObject({ disposition: 'consume', decision: { reason: 'budget' } })
    engine.close()
  })

  it('enforces rejection cooldown and quiet hours over a cross-midnight boundary', () => {
    let now = Date.UTC(2026, 0, 1, 23, 30)
    const engine = new OpportunityEngine(':memory:', [profile({ quietHours: { timezone: 'UTC', startMinute: 23 * 60, endMinute: 60 }, mergeWindowMs: 0 })], { now: () => now })
    const quiet = engine.evaluate(input()); expect(quiet).toMatchObject({ disposition: 'defer', decision: { reason: 'quiet-hours' } })
    now = Date.UTC(2026, 0, 2, 1, 1)
    const execution = engine.evaluate(input(2)); expect(execution.disposition).toBe('execute')
    engine.feedback(execution.decision.id, scope, 'rejected')
    expect(engine.evaluate(input(3))).toMatchObject({ disposition: 'consume', decision: { reason: 'rejected-cooldown' } })
    now += 60_001
    expect(engine.evaluate(input(4)).disposition).toBe('execute')
    engine.close()
  })

  it('counts prepare/remind decisions separately and validates estimates without presenting them as measured values', () => {
    const prepare = new OpportunityEngine(':memory:', [profile({ mode: 'prepare', maxDecisionsPerGoal: 1 })], { now: () => 2_000 })
    expect(prepare.evaluate(input())).toMatchObject({ disposition: 'consume', decision: { mode: 'prepare', reason: 'prepared', utility: 80 } })
    expect(prepare.evaluate(input(2))).toMatchObject({ decision: { reason: 'budget' } }); prepare.close()
    expect(() => validateProfile(profile({ successPpm: 1_000_001 }))).toThrow('invalid profile')
    expect(() => validateProfile(profile({ successPpm: Number.MAX_SAFE_INTEGER }))).toThrow('invalid profile')
  })

  it('matures a silent single event, then never executes it after expiry', () => {
    let now = 1_000; const engine = new OpportunityEngine(':memory:', [profile({ mergeWindowMs: 100 })], { now: () => now })
    const expiring = input(1, 'digest-1', { expiresAt: 2_000 }); const pending = engine.evaluate(expiring); expect(pending.disposition).toBe('defer')
    now = 1_101; expect(engine.evaluate(expiring)).toMatchObject({ disposition: 'execute', decision: { id: pending.decision.id } })
    now = 2_001; expect(engine.evaluate(expiring)).toMatchObject({ disposition: 'consume', decision: { id: pending.decision.id, reason: 'expired' } })
    engine.close()
  })

  it('delays a merged candidate entering quiet hours and suppresses it when utility is below threshold', () => {
    let now = Date.UTC(2026, 0, 1, 22, 59); const engine = new OpportunityEngine(':memory:', [profile({ mergeWindowMs: 60_000, quietHours: { timezone: 'UTC', startMinute: 23 * 60, endMinute: 60 } })], { now: () => now })
    engine.evaluate(input()); now = Date.UTC(2026, 0, 1, 23, 1)
    expect(engine.evaluate(input())).toMatchObject({ disposition: 'defer', decision: { reason: 'quiet-hours' } })
    now = Date.UTC(2026, 0, 2, 1, 1); expect(engine.evaluate(input())).toMatchObject({ disposition: 'execute', decision: { reason: 'execution' } }); engine.close()
  })

  it('isolates source sequences and rejects cross-wait replay authority', () => {
    const engine = new OpportunityEngine(':memory:', [profile()], { now: () => 1_000 })
    engine.evaluate(input(9)); expect(engine.evaluate(input(1, 'other-source', { sourceId: 'trigger-b' })).disposition).toBe('execute')
    expect(() => engine.evaluate(input(9, 'digest-9', { waitId: 'other-wait' }))).toThrow('identity conflict'); engine.close()
  })
})

it('does not refund historical executions when an expired event is replayed, or bypass the goal cap with another profile', () => {
  let now = 2_000
  const engine = new OpportunityEngine(':memory:', [profile({ maxExecutionsPerGoal: 1 }), profile({ id: 'higher', maxExecutionsPerGoal: 100 })], { now: () => now })
  const first = { ...input(), expiresAt: 3_000 }; engine.evaluate(first)
  now = 3_001
  expect(engine.evaluate(first)).toMatchObject({ disposition: 'consume', decision: { reason: 'expired' } })
  expect(engine.list(scope)[0]).toMatchObject({ mode: 'execute', reason: 'execution' })
  expect(engine.evaluate({ ...input(2), profileId: 'higher' })).toMatchObject({ disposition: 'consume', decision: { reason: 'budget' } })
  engine.close()
})

it('persists owner rejection across restart and bounds rejected event noise', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proactive-feedback-')); roots.push(root)
  const path = join(root, 'engine.sqlite'); const profiles = [profile({ maxDecisionsPerGoal: 2 })]
  const first = new OpportunityEngine(path, profiles, { now: () => 2_000 })
  const decision = first.evaluate(input()).decision
  expect(() => first.feedback(decision.id, { ...scope, principalVersion: 2 }, 'rejected')).toThrow('unavailable')
  first.feedback(decision.id, scope, 'rejected'); first.close()
  const second = new OpportunityEngine(path, profiles, { now: () => 3_000 })
  expect(second.evaluate(input(2))).toMatchObject({ disposition: 'consume', decision: { reason: 'rejected-cooldown' } })
  for (let sequence = 3; sequence < 50; sequence++) expect(second.evaluate(input(sequence)).disposition).toBe('consume')
  expect(second.list(scope)).toHaveLength(2)
  second.close()
})

it('rechecks low utility after quiet hours and rejection while another event is pending', () => {
  let now = Date.UTC(2026, 0, 1, 23, 30)
  const low = new OpportunityEngine(':memory:', [profile({ expectedBenefit: 0, quietHours: { timezone: 'UTC', startMinute: 1380, endMinute: 60 } })], { now: () => now })
  low.evaluate(input()); now = Date.UTC(2026, 0, 2, 1, 1)
  expect(low.evaluate(input())).toMatchObject({ disposition: 'consume', decision: { reason: 'below-threshold' } }); low.close()
  const engine = new OpportunityEngine(':memory:', [profile({ mergeWindowMs: 1000 })], { now: () => now })
  engine.evaluate(input()); now += 1000
  const first = engine.evaluate(input()).decision
  engine.evaluate(input(2)); engine.feedback(first.id, scope, 'rejected'); now += 1000
  expect(engine.evaluate(input(2))).toMatchObject({ disposition: 'consume', decision: { reason: 'rejected-cooldown' } })
  engine.close()
})

describe('WP12 dynamic context-aware utility & interruption cost', () => {
  it('computes all 4 bounded dimensions deterministically while staying neutral at cold start', () => {
    const base = profile({ interruptionCost: 12 }) // base utility = 100 - 10 - 12 - 5 = 73
    expect(computeDynamicUtility(base)).toEqual({
      baseUtility: 73,
      baseInterruptionCost: 12,
      effectiveInterruptionCost: 12,
      activityAdjustment: 0,
      frequencyPenalty: 0,
      urgencyBonus: 0,
      acceptanceAdjustment: 0,
      effectiveUtility: 73,
    })

    // 1. User activity penalty vs extended idle discount (bounded & floored at 0; never cuts overlay delta)
    expect(computeDynamicUtility(base, { userActive: true })).toMatchObject({
      activityAdjustment: MAX_ACTIVITY_PENALTY,
      effectiveInterruptionCost: 12 + MAX_ACTIVITY_PENALTY,
      effectiveUtility: 73 - MAX_ACTIVITY_PENALTY,
    })
    expect(computeDynamicUtility(base, { idleDurationMs: 30_000 })).toMatchObject({
      activityAdjustment: MAX_ACTIVITY_PENALTY,
      effectiveInterruptionCost: 27,
    })
    expect(computeDynamicUtility(base, { idleDurationMs: 120_000 })).toMatchObject({
      activityAdjustment: 0,
      effectiveInterruptionCost: 12,
    })
    expect(computeDynamicUtility(base, { idleDurationMs: 3_600_000 })).toMatchObject({
      activityAdjustment: -MAX_IDLE_DISCOUNT,
      effectiveInterruptionCost: 2,
      effectiveUtility: 83,
    })
    expect(computeDynamicUtility(base, { userActive: true, idleDurationMs: 3_600_000 })).toMatchObject({
      activityAdjustment: MAX_ACTIVITY_PENALTY,
      effectiveInterruptionCost: 27,
    })
    // Floored at 0 when base interruptionCost < MAX_IDLE_DISCOUNT
    expect(computeDynamicUtility(profile({ interruptionCost: 3 }), { idleDurationMs: 3_600_000 })).toMatchObject({
      activityAdjustment: -3,
      effectiveInterruptionCost: 0,
    })
    // Overlay delta is never reduced by idle discount
    expect(computeDynamicUtility(profile({ mode: 'remind', interruptionCost: 45 }), {
      idleDurationMs: 3_600_000,
      overlayInterruptionCostDelta: 40,
    })).toMatchObject({
      baseInterruptionCost: 5,
      activityAdjustment: -5,
      effectiveInterruptionCost: 40,
    })

    // 2. Notification frequency penalty (escalating, capped)
    expect(computeDynamicUtility(base, { recentNotificationCount: 0 }).frequencyPenalty).toBe(0)
    expect(computeDynamicUtility(base, { recentNotificationCount: 3 })).toMatchObject({
      frequencyPenalty: 15,
      effectiveInterruptionCost: 27,
      effectiveUtility: 58,
    })
    expect(computeDynamicUtility(base, { recentNotificationCount: 50 })).toMatchObject({
      frequencyPenalty: MAX_FREQUENCY_PENALTY,
      effectiveInterruptionCost: 52,
      effectiveUtility: 33,
    })

    // 3. Urgency / TTL remaining (finite window, unbounded/long = 0, explicit urgencyPpm)
    expect(computeDynamicUtility(base, { remainingTtlMs: URGENCY_WINDOW_MS }).urgencyBonus).toBe(0)
    expect(computeDynamicUtility(base, { remainingTtlMs: -1 }).urgencyBonus).toBe(0)
    expect(computeDynamicUtility(base, { remainingTtlMs: URGENCY_WINDOW_MS / 2 }).urgencyBonus).toBe(MAX_URGENCY_BONUS / 2)
    expect(computeDynamicUtility(base, { urgencyPpm: 1_000_000 }).urgencyBonus).toBe(MAX_URGENCY_BONUS)

    // 4. Historical acceptance rate (Laplace-smoothed, cold-start neutral, bounded)
    expect(computeDynamicUtility(base, { acceptedCount: 0, rejectedCount: 0 }).acceptanceAdjustment).toBe(0)
    expect(computeDynamicUtility(base, { acceptedCount: 3, rejectedCount: 3 }).acceptanceAdjustment).toBe(0)
    expect(computeDynamicUtility(base, { acceptedCount: 20, rejectedCount: 0 }).acceptanceAdjustment).toBe(MAX_ACCEPTANCE_BONUS)
    expect(computeDynamicUtility(base, { acceptedCount: 0, rejectedCount: 20 }).acceptanceAdjustment).toBe(-MAX_ACCEPTANCE_PENALTY)
    expect(computeDynamicUtility(base, { acceptanceRatePpm: 1_000_000, acceptanceSamples: 20 }).acceptanceAdjustment).toBe(MAX_ACCEPTANCE_BONUS)
  })

  it('rejects malformed or out-of-range ProactiveRuntimeContext inputs fail-closed', () => {
    const engine = new OpportunityEngine(':memory:', [profile()], { now: () => 2_000 })
    const badContexts: unknown[] = [
      null,
      [],
      new Date(),
      { unknownKey: 1 },
      { userActive: 'yes' },
      { idleDurationMs: -1 },
      { idleDurationMs: Number.NaN },
      { idleDurationMs: Number.POSITIVE_INFINITY },
      { idleDurationMs: 1.5 },
      { recentNotificationCount: -2 },
      { urgencyPpm: -1 },
      { urgencyPpm: 1_000_001 },
      { acceptanceRatePpm: 1_000_001 },
      { acceptanceSamples: -1 },
    ]
    for (const bad of badContexts) {
      expect(() => computeDynamicUtility(profile(), bad as never)).toThrow(/invalid/)
      expect(() => engine.evaluate(input(), undefined, bad as never)).toThrow(/invalid runtime context/)
    }
    engine.close()
  })

  it('persists rolling notification frequency & acceptance feedback across SQLite reopen and suppresses bursts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proactive-dynamic-'))
    roots.push(root)
    const path = join(root, 'engine.sqlite')
    let now = 10_000_000
    const burstProfile = profile({
      expectedBenefit: 35,
      executionCost: 5,
      interruptionCost: 5,
      possibleLoss: 5,
      minimumUtility: 15,
      maxDecisionsPerGoal: 20,
      maxExecutionsPerGoal: 20,
      rejectionCooldownMs: 1_000,
    }) // base utility = 20

    const first = new OpportunityEngine(path, [burstProfile], { now: () => now })
    const d1 = first.evaluate(input(1))
    expect(d1.disposition).toBe('execute')
    expect(d1.decision.utility).toBe(20) // 0 prior notifications

    const d2 = first.evaluate(input(2))
    expect(d2.disposition).toBe('execute')
    expect(d2.decision.utility).toBe(15) // 1 prior notification -> -5

    // 2 prior notifications -> -10 => utility = 10 < minimumUtility(15) => suppressed
    const d3 = first.evaluate(input(3))
    expect(d3).toMatchObject({ disposition: 'consume', decision: { mode: 'suppress', reason: 'below-threshold', utility: 10 } })
    first.close()

    // Reopen across process restart: rolling window still remembers 2 emitted notifications (not the suppressed one)
    const second = new OpportunityEngine(path, [burstProfile], { now: () => now })
    const d4 = second.evaluate(input(4))
    expect(d4).toMatchObject({ disposition: 'consume', decision: { mode: 'suppress', reason: 'below-threshold', utility: 10 } })

    // Another scope stays isolated
    const otherScope = { ...scope, workspace: '/workspace-other' }
    expect(second.evaluate(input(1, 'other-ws-1', { scope: otherScope })).decision.utility).toBe(20)

    // Advance past rolling 1h window: old burst ages out, and accepted feedback boosts utility cleanly
    second.feedback(d1.decision.id, scope, 'accepted')
    second.feedback(d2.decision.id, scope, 'accepted')
    now += RECENT_NOTIFICATION_WINDOW_MS + 10_000
    const afterWindow = second.evaluate(input(5))
    expect(afterWindow.disposition).toBe('execute')
    expect(afterWindow.decision.utility).toBeGreaterThan(20)

    // Subsequent rejections reduce utility after cooldown expires
    second.feedback(afterWindow.decision.id, scope, 'rejected')
    now += 2_000
    const nextGoal = second.evaluate(input(6, 'd-6', { goalId: 'goal-b' }))
    expect(nextGoal.decision.utility).toBeLessThan(afterWindow.decision.utility)
    second.close()
  })

  it('never lets high urgency or acceptance bypass expired, quiet-hours, cooldown, rejected-cooldown, muted, or budget gates', () => {
    let now = Date.UTC(2026, 0, 1, 23, 30)
    const gatedProfile = profile({
      mode: 'remind',
      expectedBenefit: 50,
      executionCost: 5,
      interruptionCost: 5,
      possibleLoss: 5,
      minimumUtility: 1,
      cooldownMs: 30_000,
      rejectionCooldownMs: 60_000,
      maxDecisionsPerGoal: 10,
      maxExecutionsPerGoal: 0,
      maxRemindersPerGoal: 2,
      quietHours: { timezone: 'UTC', startMinute: 23 * 60, endMinute: 60 },
    })
    const engine = new OpportunityEngine(':memory:', [gatedProfile], { now: () => now })

    // Expired at TTL=0 even with maximum urgencyPpm & acceptanceRatePpm
    expect(engine.evaluate(input(1, 'exp', { expiresAt: now }), undefined, {
      urgencyPpm: 1_000_000,
      acceptanceRatePpm: 1_000_000,
      acceptanceSamples: 50,
    })).toMatchObject({ disposition: 'consume', decision: { mode: 'suppress', reason: 'expired' } })

    // Quiet hours still defers despite imminent TTL and 100% acceptance
    expect(engine.evaluate(input(2, 'qh', { expiresAt: now + 60_000 }), undefined, {
      urgencyPpm: 1_000_000,
      acceptanceRatePpm: 1_000_000,
      acceptanceSamples: 50,
    })).toMatchObject({ disposition: 'defer', decision: { reason: 'quiet-hours' } })

    // Attention-muted still suppresses despite maximum urgency
    now = Date.UTC(2026, 0, 2, 2, 0)
    const muted = attentionOverlay({ version: 1, digest: 'a'.repeat(64), parameters: { interruptionCostDelta: 0, minimumUtilityDelta: 0, quietExtensionMinutes: 0, muted: true } })
    expect(engine.evaluate(input(3, 'muted', { expiresAt: now + 60_000 }), muted, {
      urgencyPpm: 1_000_000,
      acceptanceRatePpm: 1_000_000,
      acceptanceSamples: 50,
    })).toMatchObject({ disposition: 'consume', decision: { mode: 'suppress', reason: 'attention-muted' } })

    // Overlay interruptionCostDelta stays tighten-only even with extended idle
    now += 31_000
    const strictOverlay = attentionOverlay({ version: 2, digest: 'b'.repeat(64), parameters: { interruptionCostDelta: 30, minimumUtilityDelta: 0, quietExtensionMinutes: 0, muted: false } })
    const overlaid = engine.evaluate(input(4, 'ov', { expiresAt: Number.MAX_SAFE_INTEGER }), strictOverlay, { idleDurationMs: 3_600_000 })
    // Base utility = 35; overlay(+30) -> 5; idle discount only removes base interruptionCost(5) -> 10
    expect(overlaid.decision).toMatchObject({ mode: 'remind', reason: 'reminder', utility: 10 })

    // Cooldown cannot be bypassed by urgency
    expect(engine.evaluate(input(5, 'cd', { expiresAt: now + 10_000 }), undefined, {
      urgencyPpm: 1_000_000,
    })).toMatchObject({ disposition: 'consume', decision: { mode: 'suppress', reason: 'cooldown' } })

    // Second reminder succeeds once cooldown passes, then budget cannot be bypassed by urgency
    now += 31_000
    expect(engine.evaluate(input(6, 'r2', { expiresAt: now + 10_000 }))).toMatchObject({ disposition: 'consume', decision: { mode: 'remind', reason: 'reminder' } })
    now += 31_000
    expect(engine.evaluate(input(7, 'bd', { expiresAt: now + 10_000 }), undefined, {
      urgencyPpm: 1_000_000,
    })).toMatchObject({ disposition: 'consume', decision: { mode: 'suppress', reason: 'budget' } })

    // Rejected-cooldown cannot be bypassed on a fresh goal wait
    engine.feedback(overlaid.decision.id, scope, 'rejected')
    expect(engine.evaluate(input(8, 'rej', { expiresAt: now + 10_000 }), undefined, {
      urgencyPpm: 1_000_000,
    })).toMatchObject({ disposition: 'consume', decision: { mode: 'suppress', reason: 'rejected-cooldown' } })

    engine.close()
  })
})
